import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { TimestampSchema, isUniqueViolation } from "@role-orchestrator/store";
import { BudgetRowIntegrityError, UnknownExecutionError, UsageAlreadyRecordedError } from "../errors.js";
import { budgetTablesPresent } from "../tables.js";

/**
 * `execution_usage` (migration 014) — A37 usage records.
 *
 * The invariant the acceptance test names: "usage 缺失 → 显示 unavailable，
 * 不记录为 0 美元". A missing usage report is recorded EXPLICITLY as
 * `usage_status='unavailable'` with all numerics NULL — the migration's
 * pairing CHECKs make a 0-filled row a constraint violation, so "unknown"
 * can never masquerade as "free" at the storage layer. Reads return a typed
 * union whose `unavailable` member carries NO numbers at all, so a caller
 * cannot accidentally read a 0 out of it.
 *
 * Cost follows the UsagePolicy vocabulary: `price_status='unknown'` records
 * usage whose price is not determinable (missingPrice) — tokens known, cost
 * absent, never an invented 0.
 *
 * A35 boundary: usage exists only for DAG-visible executions. Activity a CLI
 * undertakes internally (its own sub-agents/MCP calls) is invisible to this
 * layer and is therefore NEVER counted, and never guessed as 0 either — the
 * quota control point for such activity is the capability gate and the
 * scheduler, not the usage ledger.
 */

export type ExecutionUsageRecord =
  | {
      readonly status: "recorded";
      readonly priceStatus: "known" | "unknown";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly usdCostMicros: number | null;
      readonly recordedAt: string;
    }
  // No numeric fields on an unavailable record — there IS no number to show.
  | {
      readonly status: "unavailable";
      readonly recordedAt: string;
    };

interface RawRowShape {
  [key: string]: unknown;
}

function reqString(row: RawRowShape, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`usage row is missing required string column "${column}"`);
  }
  return value;
}

function reqNumber(row: RawRowShape, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`usage row is missing required integer column "${column}"`);
  }
  return value;
}

function mapUsageRow(row: RawRowShape): ExecutionUsageRecord {
  const executionId = reqString(row, "execution_id");
  const status = reqString(row, "usage_status");
  const recordedAt = reqString(row, "recorded_at");
  if (status === "unavailable") {
    // The CHECKs make NULL numerics mandatory for unavailable rows; a row
    // that somehow carries numbers is corruption and fails closed.
    const leaked = ["input_tokens", "output_tokens", "usd_cost_micros"].some(
      (column) => row[column] !== null && row[column] !== undefined
    );
    if (leaked) {
      throw new BudgetRowIntegrityError(
        "execution_usage",
        executionId,
        "unavailable usage record carries numeric values (A37 violation)"
      );
    }
    return { status: "unavailable", recordedAt };
  }
  if (status !== "recorded") {
    throw new BudgetRowIntegrityError(
      "execution_usage",
      executionId,
      `impossible usage_status "${status}"`
    );
  }
  const priceStatus = reqString(row, "price_status");
  if (priceStatus !== "known" && priceStatus !== "unknown") {
    throw new BudgetRowIntegrityError(
      "execution_usage",
      executionId,
      `impossible price_status "${priceStatus}"`
    );
  }
  const usdCostMicros = row["usd_cost_micros"];
  return {
    status: "recorded",
    priceStatus,
    inputTokens: reqNumber(row, "input_tokens"),
    outputTokens: reqNumber(row, "output_tokens"),
    usdCostMicros: typeof usdCostMicros === "number" ? usdCostMicros : null,
    recordedAt
  };
}

function requireExecutionRunId(db: DatabaseSync, executionId: string): string {
  const row = db.prepare("SELECT run_id FROM executions WHERE id = ?").get(executionId) as
    | { run_id: unknown }
    | undefined;
  if (row === undefined || typeof row.run_id !== "string") {
    throw new UnknownExecutionError(executionId);
  }
  return row.run_id;
}

const RecordUsageInputSchema = z
  .strictObject({
    executionId: IdSchema,
    priceStatus: z.enum(["known", "unknown"]),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    /** Micro-US dollars (integer micros); REQUIRED for known prices, forbidden otherwise. */
    usdCostMicros: z.number().int().min(0).nullable().optional(),
    now: TimestampSchema
  })
  .superRefine((value, ctx) => {
    if (value.priceStatus === "known" && (value.usdCostMicros === null || value.usdCostMicros === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "priceStatus 'known' requires usdCostMicros"
      });
    }
    if (value.priceStatus === "unknown" && value.usdCostMicros !== null && value.usdCostMicros !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "priceStatus 'unknown' forbids usdCostMicros (missingPrice is never an invented number)"
      });
    }
  });

export type RecordExecutionUsageInput = z.input<typeof RecordUsageInputSchema>;

/** Record a fully reported usage for one execution (exactly once). */
export function recordExecutionUsage(db: DatabaseSync, input: RecordExecutionUsageInput): void {
  const value = RecordUsageInputSchema.parse(input);
  if (!budgetTablesPresent(db)) {
    throw new BudgetRowIntegrityError(
      "execution_usage",
      value.executionId,
      "usage requires migration 014; refusing to drop a usage report silently"
    );
  }
  const runId = requireExecutionRunId(db, value.executionId);
  const usdCostMicros = value.usdCostMicros ?? null;
  if (value.priceStatus === "known" && usdCostMicros === null) {
    // Unreachable by the superRefine above; keeps the SQL binding honest.
    throw new BudgetRowIntegrityError(
      "execution_usage",
      value.executionId,
      "recorded usage with a known price requires usdCostMicros"
    );
  }
  try {
    db.prepare(
      "INSERT INTO execution_usage(execution_id, run_id, usage_status, price_status, " +
        "input_tokens, output_tokens, usd_cost_micros, recorded_at) " +
        "VALUES (?, ?, 'recorded', ?, ?, ?, ?, ?)"
    ).run(value.executionId, runId, value.priceStatus, value.inputTokens, value.outputTokens, usdCostMicros, value.now);
  } catch (error) {
    if (isUniqueViolation(error, "execution_usage.execution_id")) {
      throw new UsageAlreadyRecordedError(value.executionId, { cause: error });
    }
    throw error;
  }
}

const UnavailableInputSchema = z.strictObject({
  executionId: IdSchema,
  now: TimestampSchema
});

export type RecordUsageUnavailableInput = z.input<typeof UnavailableInputSchema>;

/**
 * Record that this execution's usage could NOT be determined (A37). The
 * numerics are NULL — never zeros — by construction and by CHECK constraint.
 */
export function recordUsageUnavailable(db: DatabaseSync, input: RecordUsageUnavailableInput): void {
  const value = UnavailableInputSchema.parse(input);
  if (!budgetTablesPresent(db)) {
    throw new BudgetRowIntegrityError(
      "execution_usage",
      value.executionId,
      "usage requires migration 014; refusing to drop an unavailability report silently"
    );
  }
  const runId = requireExecutionRunId(db, value.executionId);
  try {
    db.prepare(
      "INSERT INTO execution_usage(execution_id, run_id, usage_status, price_status, " +
        "input_tokens, output_tokens, usd_cost_micros, recorded_at) " +
        "VALUES (?, ?, 'unavailable', 'unknown', NULL, NULL, NULL, ?)"
    ).run(value.executionId, runId, value.now);
  } catch (error) {
    if (isUniqueViolation(error, "execution_usage.execution_id")) {
      throw new UsageAlreadyRecordedError(value.executionId, { cause: error });
    }
    throw error;
  }
}

/** The execution's usage record, or null when none was written yet. */
export function getExecutionUsage(
  db: DatabaseSync,
  executionId: string
): ExecutionUsageRecord | null {
  const parsedId = IdSchema.parse(executionId);
  if (!budgetTablesPresent(db)) {
    return null;
  }
  const row = db.prepare("SELECT * FROM execution_usage WHERE execution_id = ?").get(parsedId) as
    | RawRowShape
    | undefined;
  return row === undefined ? null : mapUsageRow(row);
}
