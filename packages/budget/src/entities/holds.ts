import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { TimestampSchema, isUniqueViolation } from "@role-orchestrator/store";
import { BudgetRowIntegrityError, UnknownBudgetHoldError } from "../errors.js";
import { derivedBudgetId } from "../ids.js";
import { budgetTablesPresent } from "../tables.js";

/**
 * `budget_run_holds` (migration 014) — the durable "wait for the user" state
 * of a paused run (the A20 hold pattern, applied to the budget domain).
 *
 * Holds are created by the scheduler when a dispatch/requeue is refused for
 * a budget reason (attempts exhausted, a ceiling reached, usage
 * undeterminable). One row per (run, reason): a repeated pause ABSORBS into
 * the same row. Only `resolveBudgetRunHold` — the human's explicit
 * disposition — writes `resolved_at`/`resolution_note`; nothing in this
 * package resolves a hold on its own, and resolving a budget-ceiling hold
 * re-enables nothing by itself (the frozen limits still gate every
 * dispatch). The ONE resolution with a real scheduling effect is
 * `usage-undetermined`: it is the human's explicit acceptance of unknown
 * cost (A37's "display unavailable" never changes — the acceptance just
 * unblocks the pause).
 */

export const BUDGET_HOLD_REASONS = [
  "attempts-exhausted",
  "node-budget-exhausted",
  "execution-budget-exhausted",
  "duration-budget-exhausted",
  "usage-undetermined"
] as const;
export type BudgetHoldReason = (typeof BUDGET_HOLD_REASONS)[number];

export const SCHEDULING_BLOCKING_HOLD_REASONS: readonly BudgetHoldReason[] = ["usage-undetermined"];

export interface BudgetHoldRow {
  readonly id: string;
  readonly runId: string;
  readonly reason: BudgetHoldReason;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  /** True when an unresolved hold of this reason must stop run scheduling. */
  readonly blocksScheduling: boolean;
}

interface RawRowShape {
  [key: string]: unknown;
}

function reqString(row: RawRowShape, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`budget hold row is missing required string column "${column}"`);
  }
  return value;
}

const HoldDetailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

function mapHoldRow(row: RawRowShape): BudgetHoldRow {
  const id = reqString(row, "id");
  const reasonRaw = reqString(row, "reason");
  const reason = (BUDGET_HOLD_REASONS as readonly string[]).includes(reasonRaw)
    ? (reasonRaw as BudgetHoldReason)
    : null;
  if (reason === null) {
    throw new BudgetRowIntegrityError("budget_run_holds", id, `impossible reason "${reasonRaw}"`);
  }
  let detail: Record<string, string | number | boolean | null>;
  try {
    detail = HoldDetailSchema.parse(JSON.parse(reqString(row, "detail")) as unknown);
  } catch (error) {
    throw new BudgetRowIntegrityError("budget_run_holds", id, "detail is not a valid hold detail object", {
      cause: error
    });
  }
  const resolvedAt = row["resolved_at"];
  const resolutionNote = row["resolution_note"];
  return {
    id,
    runId: IdSchema.parse(reqString(row, "run_id")),
    reason,
    detail,
    createdAt: reqString(row, "created_at"),
    resolvedAt: typeof resolvedAt === "string" ? resolvedAt : null,
    resolutionNote: typeof resolutionNote === "string" ? resolutionNote : null,
    blocksScheduling: resolvedAt === null && reason === "usage-undetermined"
  };
}

const HoldInputSchema = z.strictObject({
  runId: IdSchema,
  reason: z.enum(BUDGET_HOLD_REASONS),
  detail: HoldDetailSchema,
  now: TimestampSchema
});

export type RecordBudgetRunHoldInput = z.input<typeof HoldInputSchema>;

/**
 * Durably record (or absorb into the existing) hold. Idempotent per
 * (run, reason): the first pause wins, later repeats return the SAME row.
 */
export function recordBudgetRunHold(db: DatabaseSync, input: RecordBudgetRunHoldInput): BudgetHoldRow {
  const value = HoldInputSchema.parse(input);
  const id = derivedBudgetId("bhold", value.runId, value.reason);
  try {
    db.prepare(
      "INSERT INTO budget_run_holds(id, run_id, reason, detail, created_at, resolved_at, resolution_note) " +
        "VALUES (?, ?, ?, ?, ?, NULL, NULL)"
    ).run(id, value.runId, value.reason, JSON.stringify(value.detail), value.now);
  } catch (error) {
    // Absorb BOTH uniqueness anchors of the same (run, reason) hold: the
    // deterministic id and the UNIQUE(run_id, reason) index.
    if (
      !isUniqueViolation(error, "budget_run_holds.id") &&
      !isUniqueViolation(error, "budget_run_holds.run_id, budget_run_holds.reason")
    ) {
      throw error;
    }
  }
  const row = db.prepare("SELECT * FROM budget_run_holds WHERE id = ?").get(id) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    throw new BudgetRowIntegrityError("budget_run_holds", id, "row vanished immediately after insert");
  }
  return mapHoldRow(row);
}

/** The run's unresolved holds, oldest first. */
export function listUnresolvedBudgetHolds(db: DatabaseSync, runId: string): readonly BudgetHoldRow[] {
  const parsedRunId = IdSchema.parse(runId);
  if (!budgetTablesPresent(db)) {
    return [];
  }
  const rows = db
    .prepare(
      "SELECT * FROM budget_run_holds WHERE run_id = ? AND resolved_at IS NULL ORDER BY created_at ASC, id ASC"
    )
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapHoldRow);
}

/** True when the run has an unresolved hold that must stop run scheduling. */
export function isRunSchedulingBlocked(db: DatabaseSync, runId: string): boolean {
  return listUnresolvedBudgetHolds(db, runId).some((hold) => hold.blocksScheduling);
}

const ResolveInputSchema = z.strictObject({
  runId: IdSchema,
  reason: z.enum(BUDGET_HOLD_REASONS),
  note: z.string().min(1).max(2000),
  now: TimestampSchema
});

export type ResolveBudgetRunHoldInput = z.input<typeof ResolveInputSchema>;

/**
 * Explicit human disposition of one hold (guarded CAS on the unresolved
 * row). The ONLY exit from a budget pause — and for every reason except
 * `usage-undetermined` it re-enables nothing by itself: the frozen limits
 * and the A21 cap keep gating every dispatch.
 */
export function resolveBudgetRunHold(db: DatabaseSync, input: ResolveBudgetRunHoldInput): BudgetHoldRow {
  const value = ResolveInputSchema.parse(input);
  const result = db
    .prepare(
      "UPDATE budget_run_holds SET resolved_at = ?, resolution_note = ? " +
        "WHERE run_id = ? AND reason = ? AND resolved_at IS NULL"
    )
    .run(value.now, value.note, value.runId, value.reason);
  if (Number(result.changes) !== 1) {
    throw new UnknownBudgetHoldError(value.runId, value.reason);
  }
  const row = db
    .prepare(
      "SELECT * FROM budget_run_holds WHERE run_id = ? AND reason = ? ORDER BY resolved_at DESC, id ASC LIMIT 1"
    )
    .get(value.runId, value.reason) as RawRowShape | undefined;
  if (row === undefined) {
    throw new UnknownBudgetHoldError(value.runId, value.reason);
  }
  return mapHoldRow(row);
}
