/**
 * The A21/A22 classification matrix (M4-04): every reason of the CLOSED
 * vocabulary maps to exactly the pinned policy, the aggregate is the
 * strictest policy in the mix, and the eligibility decision enforces the
 * three-total-attempt cap and the single once-then-manual retry. The
 * engine/cli-events type alignment is pinned at COMPILE time: if a future
 * engine outcome reason is added without a classification row, the
 * exhaustive assignment below stops compiling.
 */
import { describe, expect, it } from "vitest";
import type { EngineOutcomeReason } from "@role-orchestrator/engine";
import type { OutcomeFailureReason } from "@role-orchestrator/cli-events";
import {
  MAX_CONDITIONAL_RETRIES,
  MAX_NODE_ATTEMPTS,
  RETRY_POLICY_BY_REASON,
  RETRY_POLICY_SPECS,
  RETRY_REASONS,
  RetryReasonSchema,
  aggregateRetryPolicy,
  classifyFailureReason,
  evaluateRetryEligibility,
  type RetryReason
} from "../src/index.js";

// Compile-time exhaustiveness: every engine outcome reason (+ the
// launch-failure reason the engine records) MUST be a member of the closed
// budget vocabulary. `Exclude<...>` collapses to `never` exactly when the
// vocabularies cover each other; the `never`-typed constant rejects anything
// else at compile time.
const _engineReasonsExhaustive: Exclude<EngineOutcomeReason | "launch-failed", RetryReason> = undefined as never;
const _cliReasonsExhaustive: Exclude<OutcomeFailureReason, RetryReason> = undefined as never;
void _engineReasonsExhaustive;
void _cliReasonsExhaustive;

describe("A21/A22 retry classification matrix", () => {
  it("maps every reason of the closed vocabulary to its pinned policy", () => {
    expect(MAX_NODE_ATTEMPTS).toBe(3);
    expect(MAX_CONDITIONAL_RETRIES).toBe(1);
    expect(RETRY_REASONS).toHaveLength(14);
    expect(RETRY_POLICY_BY_REASON).toEqual({
      // auto — determinate failures, no side-effect ambiguity
      timeout: "auto",
      "nonzero-exit": "auto",
      "missing-final-result": "auto",
      "launch-failed": "auto",
      "missing-evidence": "auto",
      "final-result-error": "auto",
      // once-then-manual — one clean retry, then a human
      "protocol-error": "once-then-manual",
      "business-schema-invalid": "once-then-manual",
      // manual — a human decides before anything runs again
      cancelled: "manual",
      "approval-denied": "manual",
      "credential-locked": "manual",
      "process-interrupted-determinate": "manual",
      // recovery — A22: outcome unknown, never auto re-run
      "outcome-unknown-recovery-required": "recovery",
      "process-observed-running": "recovery"
    });
  });

  it("classifies each reason with its policy spec", () => {
    expect(classifyFailureReason("timeout")).toEqual({
      reason: "timeout",
      policy: "auto",
      spec: RETRY_POLICY_SPECS.auto
    });
    expect(classifyFailureReason("business-schema-invalid").policy).toBe("once-then-manual");
    expect(classifyFailureReason("credential-locked").policy).toBe("manual");
    expect(classifyFailureReason("outcome-unknown-recovery-required").policy).toBe("recovery");
    // Auto-retrying policies count toward the A21 cap; manual/recovery never
    // mint automatic attempts at all.
    expect(RETRY_POLICY_SPECS.auto.countsTowardAttemptCap).toBe(true);
    expect(RETRY_POLICY_SPECS["once-then-manual"].countsTowardAttemptCap).toBe(true);
    expect(RETRY_POLICY_SPECS["once-then-manual"].maxPolicyRetries).toBe(1);
    expect(RETRY_POLICY_SPECS.manual.countsTowardAttemptCap).toBe(false);
    expect(RETRY_POLICY_SPECS.recovery.countsTowardAttemptCap).toBe(false);
    expect(RETRY_POLICY_SPECS.manual.maxPolicyRetries).toBe(0);
    expect(RETRY_POLICY_SPECS.recovery.maxPolicyRetries).toBe(0);
  });

  it("rejects unknown reasons instead of guessing a default", () => {
    expect(() => RetryReasonSchema.parse("auth-failure")).toThrow();
    expect(() => RetryReasonSchema.parse("nonzero-exit ")).toThrow();
    expect(() => RetryReasonSchema.parse("")).toThrow();
    expect(() => classifyFailureReason("rate-limited" as never)).toThrow();
  });

  it("aggregates multi-reason failures to the STRICTEST policy", () => {
    expect(aggregateRetryPolicy(["nonzero-exit"])).toBe("auto");
    expect(aggregateRetryPolicy(["nonzero-exit", "protocol-error"])).toBe("once-then-manual");
    expect(aggregateRetryPolicy(["timeout", "cancelled"])).toBe("manual");
    expect(aggregateRetryPolicy(["cancelled", "outcome-unknown-recovery-required"])).toBe("recovery");
    // One unknown outcome poisons the whole attempt — A22 is not diluted by
    // a benign reason in the same list.
    expect(aggregateRetryPolicy(["nonzero-exit", "process-observed-running"])).toBe("recovery");
    expect(() => aggregateRetryPolicy([])).toThrow();
  });

  it("grants auto retries inside the A21 cap and refuses the fourth attempt", () => {
    const reasons = ["timeout", "nonzero-exit"] as const;
    expect(evaluateRetryEligibility({ reasons: [...reasons], totalAttempts: 1, conditionalRetriesUsed: 0 })).toEqual({
      eligible: true,
      policy: "auto",
      blockedBy: null
    });
    expect(evaluateRetryEligibility({ reasons: [...reasons], totalAttempts: 2, conditionalRetriesUsed: 0 }).eligible).toBe(true);
    // Three total attempts consumed (first + two retries): the next request
    // is the FOURTH attempt — refused.
    expect(evaluateRetryEligibility({ reasons: [...reasons], totalAttempts: 3, conditionalRetriesUsed: 0 })).toEqual({
      eligible: false,
      policy: "auto",
      blockedBy: "attempt-cap"
    });
  });

  it("grants once-then-manual exactly one retry, then blocks", () => {
    const reasons = ["protocol-error"] as const;
    expect(evaluateRetryEligibility({ reasons, totalAttempts: 1, conditionalRetriesUsed: 0 })).toEqual({
      eligible: true,
      policy: "once-then-manual",
      blockedBy: null
    });
    // The single conditional retry was consumed; the second occurrence is
    // the human's call even though the A21 cap has room left.
    expect(evaluateRetryEligibility({ reasons, totalAttempts: 2, conditionalRetriesUsed: 1 })).toEqual({
      eligible: false,
      policy: "once-then-manual",
      blockedBy: "conditional-exhausted"
    });
    // schema failures share the same conditional budget semantics.
    expect(
      evaluateRetryEligibility({ reasons: ["business-schema-invalid"], totalAttempts: 2, conditionalRetriesUsed: 1 }).blockedBy
    ).toBe("conditional-exhausted");
  });

  it("never auto-retries manual or recovery classifications (A22)", () => {
    for (const reasons of [
      ["outcome-unknown-recovery-required"],
      ["process-observed-running"],
      ["cancelled"],
      ["approval-denied"],
      ["credential-locked"],
      ["process-interrupted-determinate"],
      // RECOVERY_REQUIRED is not diluted by retryable companions.
      ["timeout", "outcome-unknown-recovery-required"]
    ] as const) {
      const decision = evaluateRetryEligibility({ reasons, totalAttempts: 1, conditionalRetriesUsed: 0 });
      expect(decision.eligible).toBe(false);
      expect(decision.blockedBy).toBe("policy");
      expect(["manual", "recovery"]).toContain(decision.policy);
    }
  });

  it("rejects out-of-domain eligibility inputs (strict schema)", () => {
    // totalAttempts beyond the A21 cap is not even a valid question.
    expect(() => evaluateRetryEligibility({ reasons: ["timeout"], totalAttempts: 4, conditionalRetriesUsed: 0 })).toThrow();
    expect(() => evaluateRetryEligibility({ reasons: ["timeout"], totalAttempts: 0, conditionalRetriesUsed: 0 })).toThrow();
    expect(() =>
      evaluateRetryEligibility({ reasons: ["timeout"], totalAttempts: 1, conditionalRetriesUsed: 2 })
    ).toThrow();
    expect(() => evaluateRetryEligibility({ reasons: [], totalAttempts: 1, conditionalRetriesUsed: 0 })).toThrow();
  });
});
