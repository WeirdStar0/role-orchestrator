/**
 * BudgetRefinement hook — RESERVED interface, stub implementation (M8 ask).
 *
 * The M8-01 controlled window collected the first real usage captures; the
 * budget thresholds (LimitsPolicy vocabulary, enforced by @role-orchestrator/
 * budget + scheduler) may eventually be REFINED from observed usage
 * distributions. That refinement is a policy change with human approval and
 * its own batch; until then this hook exists so the integration point is
 * named and typed, and returns a closed stub outcome for every input.
 *
 * Hard guarantees while stubbed (pinned by tests):
 * - the outcome status is always "stub" — no threshold value is produced;
 * - the input is not consulted for any decision and nothing is mutated;
 * - no exception path, no ambient reads: call is pure and total.
 */
import { z } from "zod";
import { COST_UNKNOWN } from "./schema.js";
import type { ModelPerformanceSummary } from "./store.js";

export const BUDGET_REFINEMENT_STATUS = "stub" as const;

export const ModelPerformanceSummarySchema = z.strictObject({
  modelId: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCacheReadTokens: z.number().int().nonnegative(),
  totalCacheCreationTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  averageDurationMs: z.nullable(z.number().nonnegative()),
  durationSampleCount: z.number().int().nonnegative(),
  costUsd: z.literal(COST_UNKNOWN)
});

export const BudgetRefinementInputSchema = z.strictObject({
  summaries: z.array(ModelPerformanceSummarySchema)
});

/**
 * Hand-written input interface (readonly arrays accepted — callers pass
 * frozen store output); the strict schema above remains the runtime gate
 * (unknown fields rejected at the parse inside refineBudgetThresholds).
 */
export interface BudgetRefinementInput {
  readonly summaries: readonly ModelPerformanceSummary[];
}

export type BudgetRefinementOutcome = {
  readonly status: typeof BUDGET_REFINEMENT_STATUS;
  readonly detail: string;
};

const STUB_DETAIL =
  "BudgetRefinement is a reserved stub: M8-01 window usage has been captured but no " +
  "threshold refinement is implemented or approved. No budget, hold or dispatch " +
  "behavior changes through this call.";

/**
 * The refinement hook. Always returns the stub outcome; validates its input
 * (strict schema, unknown fields rejected) and otherwise does nothing.
 */
export function refineBudgetThresholds(input: BudgetRefinementInput): BudgetRefinementOutcome {
  BudgetRefinementInputSchema.parse(input);
  return { status: BUDGET_REFINEMENT_STATUS, detail: STUB_DETAIL };
}
