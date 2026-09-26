/**
 * Retry classification (M4-04, ACCEPTANCE A21/A22) — the CLOSED mapping from
 * execution failure vocabulary to retry policy, fixed as a strict schema and
 * pinned by tests.
 *
 * Sources of the vocabulary (docs/ORCHESTRATION.md sections 3/6):
 *
 * - the engine's terminal outcome reasons (`@role-orchestrator/engine`
 *   `EngineOutcomeReason` = `@role-orchestrator/cli-events`
 *   `OutcomeFailureReason` + "missing-evidence" / "timeout" / "cancelled")
 *   plus "launch-failed" from the launch-failure path;
 * - process-level dispositions OUTSIDE the engine's protocol verdict:
 *   the reconcile outcomes (A22/A23 — interrupted / recovery-required /
 *   observed-running), approval denial and a locked credential group.
 *
 * Policies (docs/ORCHESTRATION.md section 6: 可考虑自动重试 vs 不能直接自动重试):
 *
 * - `auto`              explicit, determinate failures with no side-effect
 *                       ambiguity (timeout, nonzero-exit,
 *                       missing-final-result, launch-failed,
 *                       missing-evidence, final-result-error). Retryable
 *                       automatically, counted against the node attempt cap
 *                       (A21: MAX_NODE_ATTEMPTS = 3 total attempts).
 * - `once-then-manual`  protocol-error / business-schema-invalid: retryable
 *                       EXACTLY ONCE (a flaky encoder/parser is worth one
 *                       clean retry), then a human decides — ORCHESTRATION
 *                       section 6 lists 协议无法解析 and schema 不合格反复
 *                       发生 on the never-auto side, so the second occurrence
 *                       is never automatic.
 * - `manual`            a human decision is required before anything runs
 *                       again: user cancellation, approval denial,
 *                       credential lock, a determinately interrupted process
 *                       (the node FSM only reaches READY via
 *                       RECOVERY_REQUIRED, never automatically).
 * - `recovery`          A22 hard stop: the outcome is UNKNOWN
 *                       (recovery-required / observed-running). The attempt
 *                       row stays in its active phase, the A23 slot
 *                       constraint keeps blocking new attempts, and NOTHING
 *                       may auto re-run.
 *
 * Every attempt under an auto-retrying policy counts toward the A21 cap —
 * the cap is over TOTAL attempts (first + retries), never over retries
 * alone. There is deliberately no per-reason backoff, jitter or model
 * fallback here: waiting/退避 never modifies model configuration, and a
 * retried attempt reuses the run's frozen Profile snapshot (A34).
 */
import { z } from "zod";

/**
 * A21: maximum TOTAL process attempts per node — the first attempt plus at
 * most two retries ("每节点最多三次总尝试"). This is a governance constant,
 * not a knob; the scheduler's dispatch claim refuses a fourth attempt for
 * any reason, and migration 014 pins `total_attempts <= 3` at the
 * constraint level.
 */
export const MAX_NODE_ATTEMPTS = 3;

/**
 * `once-then-manual` policies may mint at most ONE automatic retry before a
 * human decides.
 */
export const MAX_CONDITIONAL_RETRIES = 1;

export const RETRY_POLICIES = ["auto", "once-then-manual", "manual", "recovery"] as const;
export type RetryPolicy = (typeof RETRY_POLICIES)[number];
export const RetryPolicySchema = z.enum(RETRY_POLICIES);

/**
 * The CLOSED failure-reason vocabulary. Adding a member here requires a
 * policy decision and a matrix-test update — an unknown reason is a schema
 * rejection, never a guessed default (unknown fields/reasons are refused,
 * not silently classified as retryable).
 */
export const RETRY_REASONS = [
  // Engine outcome vocabulary (docs/CLI_ADAPTERS.md verdict + lifecycle extras).
  "nonzero-exit",
  "protocol-error",
  "missing-final-result",
  "final-result-error",
  "business-schema-invalid",
  "missing-evidence",
  "timeout",
  "cancelled",
  "launch-failed",
  // Process-level dispositions outside the protocol verdict.
  "process-interrupted-determinate",
  "process-observed-running",
  "outcome-unknown-recovery-required",
  "approval-denied",
  "credential-locked"
] as const;
export type RetryReason = (typeof RETRY_REASONS)[number];
export const RetryReasonSchema = z.enum(RETRY_REASONS);

/** Policy semantics, one row per policy (see the module contract above). */
export interface RetryPolicySpec {
  readonly policy: RetryPolicy;
  /**
   * Automatic retries this policy may still mint. `null` = unbounded by
   * policy (still bounded by MAX_NODE_ATTEMPTS); `0` = never retries.
   */
  readonly maxPolicyRetries: number | null;
  /** Whether attempts under this policy consume the A21 attempt cap. */
  readonly countsTowardAttemptCap: boolean;
}

export const RETRY_POLICY_SPECS: Readonly<Record<RetryPolicy, RetryPolicySpec>> = {
  auto: { policy: "auto", maxPolicyRetries: null, countsTowardAttemptCap: true },
  "once-then-manual": {
    policy: "once-then-manual",
    maxPolicyRetries: MAX_CONDITIONAL_RETRIES,
    countsTowardAttemptCap: true
  },
  manual: { policy: "manual", maxPolicyRetries: 0, countsTowardAttemptCap: false },
  recovery: { policy: "recovery", maxPolicyRetries: 0, countsTowardAttemptCap: false }
};

/**
 * THE classification table. One total function over the closed reason
 * vocabulary; the matrix test pins every row, so a vocabulary or policy
 * change cannot silently move a failure class across the A22 line.
 */
export const RETRY_POLICY_BY_REASON: Readonly<Record<RetryReason, RetryPolicy>> = {
  // ---- auto: determinate failures with no side-effect ambiguity ----------
  // Kill-budget expiry: the tree kill is evidenced, the attempt is over.
  timeout: "auto",
  // Process ran to completion and failed definitively (exit code).
  "nonzero-exit": "auto",
  // Process ran but never delivered a final result event.
  "missing-final-result": "auto",
  // Spawn itself failed — the ORCHESTRATION section-6 "明确未产生副作用的
  // 启动失败" case.
  "launch-failed": "auto",
  // Success claimed but the evidence policy was not satisfied; determinate,
  // no protocol ambiguity.
  "missing-evidence": "auto",
  // The CLI delivered an explicit error result: a definitive known outcome
  // in the same family as nonzero-exit (bounded by the same A21 cap).
  "final-result-error": "auto",
  // ---- once-then-manual: one clean retry, then a human --------------------
  "protocol-error": "once-then-manual",
  "business-schema-invalid": "once-then-manual",
  // ---- manual: a human decides before anything runs again -----------------
  // A deliberate cancel must never be undone by an automatic retry.
  cancelled: "manual",
  "approval-denied": "manual",
  "credential-locked": "manual",
  // Provably-gone process (reconcile "interrupted"): determinate over, but
  // the node FSM only reopens via RECOVERY_REQUIRED -> READY, an explicit
  // disposition — never automatic.
  "process-interrupted-determinate": "manual",
  // ---- recovery: A22 — outcome unknown, never auto re-run -----------------
  "outcome-unknown-recovery-required": "recovery",
  "process-observed-running": "recovery"
};

export interface RetryClassification {
  readonly reason: RetryReason;
  readonly policy: RetryPolicy;
  readonly spec: RetryPolicySpec;
}

/** Classify ONE failure reason (total over the closed vocabulary). */
export function classifyFailureReason(reason: RetryReason): RetryClassification {
  const parsed = RetryReasonSchema.parse(reason);
  const policy = RETRY_POLICY_BY_REASON[parsed];
  return { reason: parsed, policy, spec: RETRY_POLICY_SPECS[policy] };
}

const POLICY_SEVERITY: Readonly<Record<RetryPolicy, number>> = {
  auto: 0,
  "once-then-manual": 1,
  manual: 2,
  recovery: 3
};

/**
 * Aggregate a multi-reason failure: the STRICTEST policy wins (one unknown
 * outcome in the mix means the whole attempt is treated as unknown).
 */
export function aggregateRetryPolicy(reasons: readonly RetryReason[]): RetryPolicy {
  const parsed = z.array(RetryReasonSchema).min(1).max(16).parse(reasons);
  let worst: RetryPolicy = "auto";
  for (const reason of parsed) {
    const policy = RETRY_POLICY_BY_REASON[reason];
    if (POLICY_SEVERITY[policy] > POLICY_SEVERITY[worst]) {
      worst = policy;
    }
  }
  return worst;
}

export type RetryBlockKind = "policy" | "attempt-cap" | "conditional-exhausted";

export interface RetryEligibilityInput {
  /** Failure reasons of the attempt that just terminated. */
  readonly reasons: readonly RetryReason[];
  /** TOTAL attempts already consumed by the node, including the failed one. */
  readonly totalAttempts: number;
  /** Conditional (once-then-manual) retries already granted to the node. */
  readonly conditionalRetriesUsed: number;
}

export interface RetryEligibility {
  readonly eligible: boolean;
  readonly policy: RetryPolicy;
  readonly blockedBy: RetryBlockKind | null;
}

const EligibilityInputSchema = z.strictObject({
  reasons: z.array(RetryReasonSchema).min(1).max(16),
  totalAttempts: z.number().int().min(1).max(MAX_NODE_ATTEMPTS),
  conditionalRetriesUsed: z.number().int().min(0).max(MAX_CONDITIONAL_RETRIES)
});

/**
 * The pure retry decision the scheduler's controlled requeue consumes:
 * policy from the classification table, then the two hard bounds — the A21
 * total-attempt cap and the once-then-manual single-retry budget. All three
 * failure modes are explicit; nothing here ever guesses.
 */
export function evaluateRetryEligibility(input: RetryEligibilityInput): RetryEligibility {
  const value = EligibilityInputSchema.parse(input);
  const policy = aggregateRetryPolicy(value.reasons);
  const blockedBy: RetryBlockKind | null =
    policy === "manual" || policy === "recovery"
      ? "policy"
      : value.totalAttempts >= MAX_NODE_ATTEMPTS
        ? "attempt-cap"
        : policy === "once-then-manual" && value.conditionalRetriesUsed >= MAX_CONDITIONAL_RETRIES
          ? "conditional-exhausted"
          : null;
  return { eligible: blockedBy === null, policy, blockedBy };
}
