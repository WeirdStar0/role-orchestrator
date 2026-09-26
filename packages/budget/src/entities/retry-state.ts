import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { TimestampSchema } from "@role-orchestrator/store";
import {
  AttemptBeyondCapError,
  BudgetRowIntegrityError,
  InvalidRetryStateError
} from "../errors.js";
import {
  MAX_CONDITIONAL_RETRIES,
  MAX_NODE_ATTEMPTS,
  RetryPolicySchema,
  RetryReasonSchema,
  aggregateRetryPolicy,
  type RetryPolicy,
  type RetryReason
} from "../retry.js";
import { budgetTablesPresent } from "../tables.js";

/**
 * `node_retry_state` (migration 014) — the per-node retry mirror.
 *
 * Attempt counting is grounded in the `executions` table (one row per
 * process attempt, the A23 slot rows); this mirror adds the classification
 * context the controlled requeue needs: which policy the latest failure
 * mapped to, how many conditional (once-then-manual) retries the node
 * already consumed, and whether the node's attempt budget is exhausted.
 * Constraint backstops pin the A21/once-then-manual bounds at the STORAGE
 * level — a writer that bypassed every typed check still cannot persist a
 * fourth attempt.
 */

export interface NodeRetryStateRow {
  readonly runId: string;
  readonly nodeId: string;
  readonly totalAttempts: number;
  readonly conditionalRetriesUsed: number;
  readonly lastFailureReasons: readonly RetryReason[] | null;
  readonly lastRetryPolicy: RetryPolicy | null;
  readonly exhaustedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawRowShape {
  [key: string]: unknown;
}

function reqString(row: RawRowShape, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`retry-state row is missing required string column "${column}"`);
  }
  return value;
}

function reqNumber(row: RawRowShape, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`retry-state row is missing required integer column "${column}"`);
  }
  return value;
}

function mapRetryStateRow(row: RawRowShape): NodeRetryStateRow {
  const runId = reqString(row, "run_id");
  const nodeId = reqString(row, "node_id");
  const lastReasonsRaw = row["last_failure_reasons"];
  let lastFailureReasons: readonly RetryReason[] | null = null;
  if (typeof lastReasonsRaw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastReasonsRaw) as unknown;
    } catch (error) {
      throw new BudgetRowIntegrityError(
        "node_retry_state",
        nodeId,
        "last_failure_reasons is not valid JSON",
        { cause: error }
      );
    }
    const result = z.array(RetryReasonSchema).min(1).max(16).safeParse(parsed);
    if (!result.success) {
      throw new BudgetRowIntegrityError(
        "node_retry_state",
        nodeId,
        "last_failure_reasons does not match the closed retry-reason vocabulary",
        { cause: result.error }
      );
    }
    lastFailureReasons = result.data;
  }
  const lastPolicyRaw = row["last_retry_policy"];
  let lastRetryPolicy: RetryPolicy | null = null;
  if (lastPolicyRaw !== null && lastPolicyRaw !== undefined) {
    lastRetryPolicy = RetryPolicySchema.parse(lastPolicyRaw);
  }
  const exhaustedAt = row["exhausted_at"];
  return {
    runId: IdSchema.parse(runId),
    nodeId: IdSchema.parse(nodeId),
    totalAttempts: reqNumber(row, "total_attempts"),
    conditionalRetriesUsed: reqNumber(row, "conditional_retries_used"),
    lastFailureReasons,
    lastRetryPolicy,
    exhaustedAt: typeof exhaustedAt === "string" ? exhaustedAt : null,
    createdAt: reqString(row, "created_at"),
    updatedAt: reqString(row, "updated_at")
  };
}

const RecordInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  /**
   * The attempt number of the failure being recorded (1-based). The A21 cap
   * itself is a TYPED failure (`AttemptBeyondCapError`), not a silent schema
   * bound, so a caller that reaches past three attempts learns exactly which
   * invariant it violated.
   */
  attempt: z.number().int().min(1).max(1024),
  reasons: z.array(RetryReasonSchema).min(1).max(16),
  /** True when this failure consumed the once-then-manual retry budget. */
  consumedConditionalRetry: z.boolean().default(false),
  now: TimestampSchema
});

export type RecordAttemptFailureInput = z.input<typeof RecordInputSchema>;

/**
 * Record one FAILED attempt in the mirror. Called by the scheduler's
 * controlled requeue inside its transaction. `total_attempts` mirrors the
 * caller's attempt count (the executions table stays the source of truth);
 * `consumedConditionalRetry` must be true exactly when the recorded failure
 * was the once-then-manual retry the node was granted.
 *
 * Presence-tolerant: on a database without migration 014 this is a no-op
 * (the attempt cap itself is enforced from `executions` and needs no
 * mirror).
 */
export function recordAttemptFailure(db: DatabaseSync, input: RecordAttemptFailureInput): void {
  if (!budgetTablesPresent(db)) {
    return;
  }
  const value = RecordInputSchema.parse(input);
  if (value.attempt > MAX_NODE_ATTEMPTS) {
    throw new AttemptBeyondCapError(value.runId, value.nodeId, value.attempt);
  }
  const policy: RetryPolicy = aggregateRetryPolicy(value.reasons);
  const existing = db
    .prepare("SELECT * FROM node_retry_state WHERE run_id = ? AND node_id = ?")
    .get(value.runId, value.nodeId) as RawRowShape | undefined;
  if (existing === undefined) {
    // First recorded failure. A conditional consumption here is legitimate:
    // the FIRST once-then-manual failure grants (and thereby consumes) the
    // node's single conditional retry.
    db.prepare(
      "INSERT INTO node_retry_state(run_id, node_id, total_attempts, conditional_retries_used, " +
        "last_failure_reasons, last_retry_policy, exhausted_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      value.runId,
      value.nodeId,
      value.attempt,
      value.consumedConditionalRetry ? 1 : 0,
      JSON.stringify(value.reasons),
      policy,
      value.attempt >= MAX_NODE_ATTEMPTS ? value.now : null,
      value.now,
      value.now
    );
    return;
  }
  const previous = mapRetryStateRow(existing);
  if (previous.totalAttempts >= value.attempt) {
    throw new InvalidRetryStateError(
      value.runId,
      value.nodeId,
      `mirror already records ${String(previous.totalAttempts)} attempts; refusing to rewind to ${String(value.attempt)}`
    );
  }
  if (value.consumedConditionalRetry && previous.conditionalRetriesUsed >= MAX_CONDITIONAL_RETRIES) {
    throw new InvalidRetryStateError(
      value.runId,
      value.nodeId,
      `conditional retry budget already consumed (${String(previous.conditionalRetriesUsed)} of ${String(MAX_CONDITIONAL_RETRIES)})`
    );
  }
  db.prepare(
    "UPDATE node_retry_state SET total_attempts = ?, conditional_retries_used = conditional_retries_used + ?, " +
      "last_failure_reasons = ?, last_retry_policy = ?, exhausted_at = ?, updated_at = ? " +
      "WHERE run_id = ? AND node_id = ?"
  ).run(
    value.attempt,
    value.consumedConditionalRetry ? 1 : 0,
    JSON.stringify(value.reasons),
    policy,
    value.attempt >= MAX_NODE_ATTEMPTS ? value.now : previous.exhaustedAt,
    value.now,
    value.runId,
    value.nodeId
  );
}

/** The node's retry mirror, or null when the node has no recorded failure. */
export function getRetryState(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): NodeRetryStateRow | null {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  if (!budgetTablesPresent(db)) {
    return null;
  }
  const row = db
    .prepare("SELECT * FROM node_retry_state WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId) as RawRowShape | undefined;
  return row === undefined ? null : mapRetryStateRow(row);
}
