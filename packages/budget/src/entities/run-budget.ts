import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { TimestampSchema, isUniqueViolation } from "@role-orchestrator/store";
import { BudgetAlreadyEnrolledError, BudgetRowIntegrityError } from "../errors.js";
import { BudgetExceededSignal } from "../signals.js";
import { budgetTablesPresent } from "../tables.js";

/**
 * `run_budgets` (migration 014) — per-run resource budget in the LimitsPolicy
 * vocabulary (nodes, executions) plus a wall-clock duration ceiling, and the
 * dispatch gate over it.
 *
 * Enrollment (`ensureRunBudget`) happens ONCE per run; limits are frozen at
 * enrollment the same way the run's Profile snapshot is frozen (the same
 * A34 spirit: a budget that could be re-scoped mid-run would let a run
 * outrun its approved bounds). Consumption is written INSIDE the scheduler's
 * dispatch claim transaction — `recordDispatchConsumption` raises
 * `BudgetExceededSignal` on a full budget, which rolls the whole claim back,
 * exactly the `QuotaFullSignal` shape the quota grants use.
 *
 * The gate (`evaluateDispatchBudgetGate`) is read-only and
 * presence-tolerant: databases without migration 014 report `managed:
 * false`; enrolled runs get the full limit checks; an unenrolled run on a
 * 014 database is governed by the universal A21 attempt cap only. Usage
 * follows A37: a run whose undetermined-usage count reached its threshold is
 * blocked with `usage-undetermined` UNLESS a human explicitly resolved the
 * matching hold (the one exit — acceptance of unknown cost, never a
 * re-pricing to 0).
 */

export interface RunBudgetRow {
  readonly runId: string;
  readonly maxNodes: number;
  readonly maxExecutions: number;
  readonly maxDurationMs: number;
  readonly undeterminedUsageLimit: number;
  readonly nodesUsed: number;
  readonly executionsUsed: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export const BUDGET_BLOCK_REASONS = [
  "node-budget-exhausted",
  "execution-budget-exhausted",
  "duration-budget-exhausted",
  "usage-undetermined"
] as const;
export type BudgetBlockReason = (typeof BUDGET_BLOCK_REASONS)[number];
export const BudgetBlockReasonSchema = z.enum(BUDGET_BLOCK_REASONS);

interface RawRowShape {
  [key: string]: unknown;
}

function reqString(row: RawRowShape, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`run-budget row is missing required string column "${column}"`);
  }
  return value;
}

function reqNumber(row: RawRowShape, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`run-budget row is missing required integer column "${column}"`);
  }
  return value;
}

function mapRunBudgetRow(row: RawRowShape): RunBudgetRow {
  return {
    runId: IdSchema.parse(reqString(row, "run_id")),
    maxNodes: reqNumber(row, "max_nodes"),
    maxExecutions: reqNumber(row, "max_executions"),
    maxDurationMs: reqNumber(row, "max_duration_ms"),
    undeterminedUsageLimit: reqNumber(row, "undetermined_usage_limit"),
    nodesUsed: reqNumber(row, "nodes_used"),
    executionsUsed: reqNumber(row, "executions_used"),
    startedAt: reqString(row, "started_at"),
    updatedAt: reqString(row, "updated_at")
  };
}

const EnsureInputSchema = z.strictObject({
  runId: IdSchema,
  limits: z.strictObject({
    maxNodes: z.number().int().min(1).max(256),
    maxExecutions: z.number().int().min(1).max(1024),
    maxDurationMs: z.number().int().min(1).max(2_147_483_647),
    /**
     * How many executions may run with UNDETERMINABLE usage before the run
     * pauses behind a hold (A37: never silently priced as 0). Default 3.
     */
    undeterminedUsageLimit: z.number().int().min(1).max(1024).default(3)
  }),
  now: TimestampSchema
});

export type EnsureRunBudgetInput = z.input<typeof EnsureInputSchema>;

/** Enroll the run's budget (once per run; limits frozen at enrollment). */
export function ensureRunBudget(db: DatabaseSync, input: EnsureRunBudgetInput): RunBudgetRow {
  const value = EnsureInputSchema.parse(input);
  try {
    db.prepare(
      "INSERT INTO run_budgets(run_id, max_nodes, max_executions, max_duration_ms, " +
        "undetermined_usage_limit, nodes_used, executions_used, started_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)"
    ).run(
      value.runId,
      value.limits.maxNodes,
      value.limits.maxExecutions,
      value.limits.maxDurationMs,
      value.limits.undeterminedUsageLimit,
      value.now,
      value.now
    );
  } catch (error) {
    if (isUniqueViolation(error, "run_budgets.run_id")) {
      throw new BudgetAlreadyEnrolledError(value.runId, { cause: error });
    }
    throw error;
  }
  const row = db.prepare("SELECT * FROM run_budgets WHERE run_id = ?").get(value.runId) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    throw new BudgetRowIntegrityError("run_budgets", value.runId, "row vanished immediately after insert");
  }
  return mapRunBudgetRow(row);
}

/** The run's enrolled budget, or null when the run is unenrolled. */
export function getRunBudget(db: DatabaseSync, runId: string): RunBudgetRow | null {
  const parsedRunId = IdSchema.parse(runId);
  if (!budgetTablesPresent(db)) {
    return null;
  }
  const row = db.prepare("SELECT * FROM run_budgets WHERE run_id = ?").get(parsedRunId) as
    | RawRowShape
    | undefined;
  return row === undefined ? null : mapRunBudgetRow(row);
}

export type DispatchBudgetGate =
  | { readonly managed: false }
  | { readonly managed: true; readonly allowed: true }
  | {
      readonly managed: true;
      readonly allowed: false;
      readonly reason: BudgetBlockReason;
      readonly detail: string;
    };

const GateInputSchema = z.strictObject({
  runId: IdSchema,
  /** The attempt number the dispatch would create (1 = first attempt of a node). */
  attempt: z.number().int().min(1).max(10),
  now: TimestampSchema
});

export type EvaluateDispatchBudgetGateInput = z.input<typeof GateInputSchema>;

/**
 * Read-only budget gate for one would-be dispatch. Pure decision over the
 * stored row; the caller (scheduler) runs it before the claim transaction
 * and re-relies on `recordDispatchConsumption` inside the transaction for
 * the atomic consumption.
 */
export function evaluateDispatchBudgetGate(
  db: DatabaseSync,
  input: EvaluateDispatchBudgetGateInput
): DispatchBudgetGate {
  const value = GateInputSchema.parse(input);
  if (!budgetTablesPresent(db)) {
    return { managed: false };
  }
  const budget = getRunBudget(db, value.runId);
  if (budget === null) {
    return { managed: true, allowed: true };
  }
  if (value.attempt === 1 && budget.nodesUsed + 1 > budget.maxNodes) {
    return {
      managed: true,
      allowed: false,
      reason: "node-budget-exhausted",
      detail: `node budget ${String(budget.nodesUsed)}/${String(budget.maxNodes)} used; a new node cannot start`
    };
  }
  if (budget.executionsUsed + 1 > budget.maxExecutions) {
    return {
      managed: true,
      allowed: false,
      reason: "execution-budget-exhausted",
      detail: `execution budget ${String(budget.executionsUsed)}/${String(budget.maxExecutions)} used`
    };
  }
  const elapsed = Date.parse(value.now) - Date.parse(budget.startedAt);
  if (elapsed > budget.maxDurationMs) {
    return {
      managed: true,
      allowed: false,
      reason: "duration-budget-exhausted",
      detail: `run age ${String(elapsed)}ms exceeds the ${String(budget.maxDurationMs)}ms ceiling`
    };
  }
  const undetermined = countUndeterminedUsage(db, value.runId);
  if (undetermined >= budget.undeterminedUsageLimit && !usageUndeterminedAccepted(db, value.runId)) {
    return {
      managed: true,
      allowed: false,
      reason: "usage-undetermined",
      detail:
        `${String(undetermined)} executions have undeterminable usage (limit ${String(budget.undeterminedUsageLimit)}); ` +
        "the run pauses until a human resolves the usage-undetermined hold (A37: unknown usage is never priced as 0)"
    };
  }
  return { managed: true, allowed: true };
}

const ConsumeInputSchema = z.strictObject({
  runId: IdSchema,
  attempt: z.number().int().min(1).max(10),
  now: TimestampSchema
});

export type RecordDispatchConsumptionInput = z.input<typeof ConsumeInputSchema>;

/**
 * Record one dispatch's consumption INSIDE the caller's claim transaction.
 * Raises `BudgetExceededSignal` when the budget is full — the throw rolls
 * back the entire claim (attempt row, grants, transitions, outbox), so a
 * budget-limited run is never half-claimed. Presence-tolerant: unmanaged
 * databases and unenrolled runs consume nothing.
 */
export function recordDispatchConsumption(
  db: DatabaseSync,
  input: RecordDispatchConsumptionInput
): void {
  const value = ConsumeInputSchema.parse(input);
  if (!budgetTablesPresent(db)) {
    return;
  }
  const budget = getRunBudget(db, value.runId);
  if (budget === null) {
    return;
  }
  const nodeIncrement = value.attempt === 1 ? 1 : 0;
  const updated = db
    .prepare(
      "UPDATE run_budgets SET executions_used = executions_used + 1, nodes_used = nodes_used + ?, " +
        "updated_at = ? WHERE run_id = ? AND executions_used < max_executions " +
        "AND nodes_used + ? <= max_nodes"
    )
    .run(nodeIncrement, value.now, value.runId, nodeIncrement);
  if (Number(updated.changes) !== 1) {
    const gate = evaluateDispatchBudgetGate(db, {
      runId: value.runId,
      attempt: value.attempt,
      now: value.now
    });
    const reason = gate.managed && !gate.allowed ? gate.reason : "execution-budget-exhausted";
    const detail = gate.managed && !gate.allowed ? gate.detail : "budget row refused the consumption update";
    throw new BudgetExceededSignal(reason, detail);
  }
}

// ---------------------------------------------------------------------------
// Undetermined-usage counting (A37)
// ---------------------------------------------------------------------------

/** Executions of the run whose usage could not be determined. */
export function countUndeterminedUsage(db: DatabaseSync, runId: string): number {
  const parsedRunId = IdSchema.parse(runId);
  if (!budgetTablesPresent(db)) {
    return 0;
  }
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM execution_usage WHERE run_id = ? AND usage_status = 'unavailable'"
    )
    .get(parsedRunId) as { n: number | bigint };
  return Number(row.n);
}

/** The run's resolved usage-undetermined hold — the explicit human acceptance. */
function usageUndeterminedAccepted(db: DatabaseSync, runId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS resolved FROM budget_run_holds " +
        "WHERE run_id = ? AND reason = 'usage-undetermined' AND resolved_at IS NOT NULL LIMIT 1"
    )
    .get(IdSchema.parse(runId));
  return row?.resolved === 1;
}
