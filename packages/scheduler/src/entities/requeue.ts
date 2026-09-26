import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { requireNodeState, transitionNodeState } from "@role-orchestrator/dag";
import {
  MAX_NODE_ATTEMPTS,
  RetryReasonSchema,
  RetryPolicySchema,
  evaluateRetryEligibility,
  getRetryState,
  recordAttemptFailure,
  recordBudgetRunHold,
  InvalidRetryStateError
} from "@role-orchestrator/budget";
import { getExecution, getTaskRun, listAttemptsForSlot, TimestampSchema, withTransaction } from "@role-orchestrator/store";
import {
  AttemptsExhaustedError,
  ConditionalRetryExhaustedError,
  InvalidQueueEntryStateError,
  NonRetryableFailureError,
  RequeueNotAllowedError,
  RunHeldError,
  UnknownRunError
} from "../errors.js";
import { derivedId } from "../ids.js";
import { getQueueEntry } from "./queue.js";
import { listRunSchedulingHolds } from "./holds.js";

/**
 * The controlled COMPLETED/DISPATCHED -> WAITING requeue (M4-04), the boundary
 * M4-03 documented ("the scheduler has no requeue-to-WAITING API yet").
 *
 * This is the ONLY automatic path from a failed attempt back to the READY
 * queue, and every gate is fail-closed:
 *
 *   run -> node state (FAILED only) -> run holds -> retry classification
 *   (budget's closed reason table; A22 non-retryable reasons refuse here) ->
 *   A21 attempt cap (counted from the executions slot rows) ->
 *   once-then-manual conditional budget -> entry/execution guards ->
 *   ONE transaction: failure mirror + COMPLETED/DISPATCHED -> WAITING queue
 *   update + FAILED -> RETRY_PENDING -> READY transitions.
 *
 * Guards, precisely:
 * - the node must be FAILED (any other state is a caller bug — typed
 *   refusal, nothing written);
 * - the entry, when it exists, must be COMPLETED or DISPATCHED with a
 *   terminal FAILED execution — a WAITING entry or a live attempt refuses;
 * - a run held for the user (expansion hold / usage-undetermined) requeues
 *   nothing;
 * - `manual`/`recovery` classifications NEVER requeue (A22);
 * - three total attempts (A21) leave the node FAILED forever — the run gets
 *   an `attempts-exhausted` hold and the fourth attempt never happens;
 * - the once-then-manual budget is one retry, then a human.
 *
 * A34: the requeue performs NO profile resolution. The queue row keeps its
 * frozen profile/credential columns and dispatch continues to read the
 * run's frozen snapshot — a retried attempt uses the original Profile,
 * never a re-resolved one.
 *
 * A node with NO queue row (the engine-owned attempt path) is supported: the
 * guard sequence runs identically and only the node transitions apply; the
 * next `enqueueReadyNodes` queues the READY node.
 */

const RequeueInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  /** The closed-vocabulary failure reasons of the attempt that just failed. */
  failureReasons: z.array(RetryReasonSchema).min(1).max(8),
  now: TimestampSchema
});

export type RequeueForRetryInput = z.input<typeof RequeueInputSchema>;

export interface RequeueForRetryResult {
  /** True when a queue row went COMPLETED/DISPATCHED -> WAITING in this call. */
  readonly requeued: boolean;
  /** The queue entry id, when the run's queue row exists. */
  readonly entryId: string | null;
  readonly runId: string;
  readonly nodeId: string;
  /** Aggregate retry policy of the recorded failure. */
  readonly policy: z.infer<typeof RetryPolicySchema>;
  /** Total attempts the node has now consumed (including the failed one). */
  readonly totalAttempts: number;
}

export function requeueForRetry(db: DatabaseSync, input: RequeueForRetryInput): RequeueForRetryResult {
  const value = RequeueInputSchema.parse(input);
  const { runId, nodeId, now } = value;

  if (getTaskRun(db, runId) === null) {
    throw new UnknownRunError(runId);
  }
  const node = requireNodeState(db, { runId, nodeId });
  if (node.state !== "FAILED") {
    throw new RequeueNotAllowedError(runId, nodeId, node.state);
  }

  const holds = listRunSchedulingHolds(db, runId);
  if (holds.length > 0) {
    throw new RunHeldError(runId, holds);
  }

  // Source of truth: the executions slot rows (one per process attempt).
  // The eligibility decision runs BEFORE the claim transaction because a
  // refused requeue must record its user hold OUTSIDE any transaction it
  // would otherwise roll back. The writes below re-guard everything they
  // depend on (guarded transitions, guarded queue UPDATE, mirror bounds),
  // so a concurrent state change between the read and the transaction is
  // still a typed refusal, never a corruption.
  const totalAttempts = listAttemptsForSlot(db, { runId, nodeId }).length;
  if (totalAttempts < 1) {
    throw new InvalidRetryStateError(
      runId,
      nodeId,
      "node is FAILED but no attempt row exists (state corruption)"
    );
  }
  const mirror = getRetryState(db, { runId, nodeId });
  const eligibility = evaluateRetryEligibility({
    reasons: value.failureReasons,
    totalAttempts,
    conditionalRetriesUsed: mirror?.conditionalRetriesUsed ?? 0
  });

  if (!eligibility.eligible) {
    if (eligibility.blockedBy === "attempt-cap") {
      // Autocommit: this hold must survive the typed refusal below.
      const hold = recordBudgetRunHold(db, {
        runId,
        reason: "attempts-exhausted",
        detail: {
          nodeId,
          attempts: totalAttempts,
          reasons: value.failureReasons.join(",")
        },
        now
      });
      throw new AttemptsExhaustedError(runId, nodeId, totalAttempts, hold.id);
    }
    if (eligibility.blockedBy === "conditional-exhausted") {
      throw new ConditionalRetryExhaustedError(runId, nodeId, eligibility.policy);
    }
    throw new NonRetryableFailureError(runId, nodeId, eligibility.policy, value.failureReasons);
  }

  // Queue row guards BEFORE any state change: the entry (when present)
  // must be COMPLETED or DISPATCHED, and a DISPATCHED entry's execution
  // must be terminal FAILED — never a live attempt.
  const entryId = derivedId("q", runId, nodeId);
  const entry = getQueueEntry(db, entryId);
  if (entry !== null) {
    if (entry.executionId !== null) {
      const execution = getExecution(db, entry.executionId);
      if (execution === null || execution.phase !== "FAILED") {
        throw new InvalidQueueEntryStateError(entryId, ["COMPLETED", "DISPATCHED"], entry.state);
      }
    }
    if (entry.state !== "COMPLETED" && entry.state !== "DISPATCHED") {
      throw new InvalidQueueEntryStateError(entryId, ["COMPLETED", "DISPATCHED"], entry.state);
    }
  }

  return withTransaction(db, () => {
    // The failure mirror (A21 / conditional-retry bookkeeping).
    recordAttemptFailure(db, {
      runId,
      nodeId,
      attempt: totalAttempts,
      reasons: value.failureReasons,
      consumedConditionalRetry: eligibility.policy === "once-then-manual",
      now
    });

    // The controlled COMPLETED/DISPATCHED -> WAITING rearrangement.
    let requeued = false;
    if (entry !== null) {
      const updated = db
        .prepare(
          "UPDATE scheduler_queue SET state = 'WAITING', not_before = ?, last_reason = NULL, updated_at = ? " +
            "WHERE id = ? AND state IN ('COMPLETED', 'DISPATCHED')"
        )
        .run(now, now, entryId);
      if (Number(updated.changes) !== 1) {
        throw new InvalidQueueEntryStateError(entryId, ["COMPLETED", "DISPATCHED"], entry.state);
      }
      requeued = true;
    }

    // FAILED -> RETRY_PENDING -> READY, the dag state machine's retry path,
    // applied with explicit guarded transitions.
    transitionNodeState(db, { runId, nodeId, to: "RETRY_PENDING", whereStateIn: ["FAILED"], now });
    transitionNodeState(db, { runId, nodeId, to: "READY", whereStateIn: ["RETRY_PENDING"], now });

    return {
      requeued,
      entryId: entry === null ? null : entryId,
      runId,
      nodeId,
      policy: eligibility.policy,
      totalAttempts
    };
  });
}

/**
 * The A21 cap the dispatch claim enforces (re-exported so callers can
 * pre-check without depending on budget directly): a node's TOTAL attempts
 * (first + retries) never exceed this.
 */
export const SCHEDULER_MAX_NODE_ATTEMPTS: typeof MAX_NODE_ATTEMPTS = MAX_NODE_ATTEMPTS;
