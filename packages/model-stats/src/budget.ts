/**
 * BudgetRefinement — READ-ONLY threshold suggestions derived from observed
 * usage (M8-04). Evolved from the M8-02 closed stub: the hook now runs a
 * two-state machine instead of a constant "stub" outcome, while keeping the
 * stub's hard guarantees intact.
 *
 * Interface evolution (backward compatible): the input keeps its original
 * shape `{ summaries }` and gains an OPTIONAL `events` field carrying the
 * per-turn samples. Per-model summaries are SUMS — no percentile of a
 * per-turn distribution can be computed from them — so advice is derived
 * from the per-event samples only. Stub-era calls that pass summaries
 * without events still validate and get an explicit "no-per-event-samples"
 * gap; they never throw for that reason alone.
 *
 * Hard guarantees (pinned by tests):
 * - Two states only: "ready" (at least one model had enough samples) or
 *   "insufficient-data" (none did). Both are total over schema-valid input:
 *   no exception path after input validation, no ambient reads, no side
 *   effects; the input is never mutated and the outcome is deep-frozen.
 * - Advice is token counts only. The cost dimension does not exist here
 *   (see schema.ts): no fee figure can appear in any suggestion.
 * - Every suggested value carries its derivation basis (method name + sample
 *   size n) so a maintainer can audit where the number came from. Readiness
 *   additionally requires the per-model sample count to EQUAL the summary's
 *   eventCount — advice computed over a subset of the declared aggregate
 *   would be quietly dishonest.
 * - Read-only by construction: this file imports nothing from
 *   @role-orchestrator/budget or the scheduler and exposes no execution
 *   surface. Suggestions are NOT policy: adopting any value is a maintainer
 *   policy decision requiring its own approved batch.
 */
import { z } from "zod";
import { COST_UNKNOWN, UsageEventSchema, type UsageEvent } from "./schema.js";
import type { ModelPerformanceSummary } from "./store.js";

/**
 * Minimum per-model per-turn samples before a percentile is trusted.
 * The exact arithmetic (verified by enumeration): nearest-rank P95 has rank
 * ceil(0.95·n), which EQUALS n for every n ≤ 19 — the "P95" is the maximum
 * in disguise across that whole range — and from n = 20 the rank is 19, the
 * second-largest observation. 5 is therefore NOT a threshold where P95
 * becomes meaningful (the earlier "smallest n where P95 and P50 differ"
 * reading was wrong arithmetic: P95 and P50 already point at different
 * observations from n = 2 on); it is kept as the floor because a
 * distribution description over fewer turns claims more structure than any
 * such window carries. This is a floor for honesty, not a quality claim:
 * even at n = 5 the outcome says the window is small.
 */
export const MIN_SAMPLES_PER_MODEL = 5;

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

export const BudgetRefinementInputSchema = z
  .strictObject({
    summaries: z.array(ModelPerformanceSummarySchema),
    /** Optional per-turn samples (stub-era inputs omit it and stay valid). */
    events: z.array(UsageEventSchema).optional()
  })
  // Duplicate summaries would make "the aggregate" ambiguous; that is an
  // input error (throw), not a data gap.
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const summary of input.summaries) {
      if (seen.has(summary.modelId)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate summary for model ${summary.modelId}`
        });
      }
      seen.add(summary.modelId);
    }
  });

/**
 * Hand-written input interface (readonly arrays accepted — callers pass
 * frozen store output); the strict schema above remains the runtime gate
 * (unknown fields rejected at the parse inside refineBudgetThresholds).
 */
export interface BudgetRefinementInput {
  readonly summaries: readonly ModelPerformanceSummary[];
  /** Per-turn samples the advice is derived from (store.events()). */
  readonly events?: readonly UsageEvent[];
}

/** Provenance of one suggested value: method + sample size, for audit. */
export interface SuggestionBasis {
  readonly method: string;
  readonly sampleCount: number;
}

export interface ModelBudgetSuggestion {
  readonly modelId: string;
  /**
   * Suggested per-turn OUTPUT token cap: nearest-rank P95 of the observed
   * per-turn output tokens, rounded up to a multiple of 1000 (exact
   * multiples stay unchanged — P95 4000 suggests 4000, not 5000).
   */
  readonly suggestedPerTurnOutputTokenCap: number;
  readonly suggestedPerTurnOutputTokenCapBasis: SuggestionBasis;
  /**
   * Suggested INPUT budget reference: nearest-rank P50 of the observed
   * per-turn fresh input tokens (UsageEvent.inputTokens — cache reads and
   * cache creations excluded; that exact reading is stated in the basis).
   */
  readonly suggestedInputBudgetReference: number;
  readonly suggestedInputBudgetReferenceBasis: SuggestionBasis;
}

/** Why a model got no suggestion (insufficient-data, or skipped in a mixed ready outcome). */
export interface ModelDataGap {
  readonly modelId: string;
  readonly reason:
    | "no-per-event-samples"
    | "insufficient-samples"
    | "sample-count-mismatch"
    | "events-without-summary";
  /** Samples actually observed for this model (0 when none were passed). */
  readonly observedSampleCount: number;
  /**
   * The sample count this gap was decided against: the MIN_SAMPLES_PER_MODEL
   * floor for the floor-based reasons, or the summary's DECLARED eventCount
   * for "sample-count-mismatch" (there readiness requires observed ===
   * declared, so the declared count is the requirement that failed).
   */
  readonly requiredSampleCount: number;
}

export interface BudgetRefinementOutcome {
  readonly status: "ready" | "insufficient-data";
  readonly detail: string;
  /** Non-empty exactly when status is "ready". */
  readonly suggestions: readonly ModelBudgetSuggestion[];
  /** Every model that could not be advised, with the reason. */
  readonly gaps: readonly ModelDataGap[];
}

export const SuggestionBasisSchema = z.strictObject({
  method: z.string().min(1),
  sampleCount: z.number().int().nonnegative()
});

export const ModelBudgetSuggestionSchema = z.strictObject({
  modelId: z.string().min(1),
  suggestedPerTurnOutputTokenCap: z.number().int().nonnegative(),
  suggestedPerTurnOutputTokenCapBasis: SuggestionBasisSchema,
  suggestedInputBudgetReference: z.number().int().nonnegative(),
  suggestedInputBudgetReferenceBasis: SuggestionBasisSchema
});

export const ModelDataGapSchema = z.strictObject({
  modelId: z.string().min(1),
  reason: z.enum([
    "no-per-event-samples",
    "insufficient-samples",
    "sample-count-mismatch",
    "events-without-summary"
  ]),
  observedSampleCount: z.number().int().nonnegative(),
  requiredSampleCount: z.number().int().nonnegative()
});

export const BudgetRefinementOutcomeSchema = z.strictObject({
  status: z.enum(["ready", "insufficient-data"]),
  detail: z.string().min(1),
  suggestions: z.array(ModelBudgetSuggestionSchema),
  gaps: z.array(ModelDataGapSchema)
});

/**
 * The honesty boundary, present in the detail of BOTH states: suggestions
 * are descriptive, adoption is a human policy decision in its own batch,
 * and nothing here reaches the budget/scheduler execution surfaces.
 */
const HONESTY_BOUNDARY =
  "These values are descriptive suggestions, NOT policy: nothing in this call " +
  "changes @role-orchestrator/budget, the scheduler, or any dispatch decision. " +
  "Adopting a value requires explicit maintainer approval in its own batch.";

const READY_DETAIL =
  "Read-only per-turn token advice derived from the observed usage distribution " +
  "(small sample window; see each basis for method and n). " + HONESTY_BOUNDARY;

const INSUFFICIENT_DETAIL =
  "No model carried enough per-turn samples to advise; no suggestion is made. " + HONESTY_BOUNDARY;

/** Nearest-rank percentile on an ascending-sorted copy: rank = ceil(p·n), 1-based. */
function percentileNearestRank(sortedAsc: readonly number[], percentile: number): number {
  const n = sortedAsc.length;
  const rank = Math.min(Math.max(Math.ceil(percentile * n), 1), n);
  const value = sortedAsc[rank - 1];
  // Unreachable for n >= 1 (rank clamped into [1, n]); kept total instead of `!`.
  return value ?? sortedAsc[n - 1] ?? 0;
}

function roundUpToTokenBucket(value: number, bucket: number): number {
  return Math.ceil(value / bucket) * bucket;
}

function deepFreezeOutcome(outcome: BudgetRefinementOutcome): BudgetRefinementOutcome {
  for (const suggestion of outcome.suggestions) {
    Object.freeze(suggestion);
    Object.freeze(suggestion.suggestedPerTurnOutputTokenCapBasis);
    Object.freeze(suggestion.suggestedInputBudgetReferenceBasis);
  }
  for (const gap of outcome.gaps) Object.freeze(gap);
  Object.freeze(outcome.suggestions);
  Object.freeze(outcome.gaps);
  return Object.freeze(outcome);
}

/**
 * The refinement hook. Validates its input (strict schema, unknown fields
 * rejected — a malformed input throws as an input error), then derives
 * read-only per-model suggestions or explicit gaps. Given schema-valid
 * input it never throws and never mutates anything.
 */
export function refineBudgetThresholds(input: BudgetRefinementInput): BudgetRefinementOutcome {
  const parsed = BudgetRefinementInputSchema.parse(input);
  const events = parsed.events ?? [];

  const samplesByModel = new Map<string, { output: number[]; freshInput: number[] }>();
  for (const event of events) {
    let samples = samplesByModel.get(event.modelId);
    if (samples === undefined) {
      samples = { output: [], freshInput: [] };
      samplesByModel.set(event.modelId, samples);
    }
    samples.output.push(event.outputTokens);
    samples.freshInput.push(event.inputTokens);
  }
  const summarizedModels = new Set(parsed.summaries.map((s) => s.modelId));

  const suggestions: ModelBudgetSuggestion[] = [];
  const gaps: ModelDataGap[] = [];
  for (const summary of parsed.summaries) {
    const samples = samplesByModel.get(summary.modelId);
    const observed = samples === undefined ? 0 : samples.output.length;
    if (samples === undefined || observed === 0) {
      gaps.push({
        modelId: summary.modelId,
        reason: "no-per-event-samples",
        observedSampleCount: 0,
        requiredSampleCount: MIN_SAMPLES_PER_MODEL
      });
      continue;
    }
    if (observed < MIN_SAMPLES_PER_MODEL) {
      gaps.push({
        modelId: summary.modelId,
        reason: "insufficient-samples",
        observedSampleCount: observed,
        requiredSampleCount: MIN_SAMPLES_PER_MODEL
      });
      continue;
    }
    if (observed !== summary.eventCount) {
      // The aggregate claims more (or fewer) turns than the sample set
      // carries: advising over a subset of the declared aggregate would be
      // quietly dishonest, so this model gets an explicit gap instead.
      gaps.push({
        modelId: summary.modelId,
        reason: "sample-count-mismatch",
        observedSampleCount: observed,
        requiredSampleCount: summary.eventCount
      });
      continue;
    }
    // Sorted COPIES — the caller's arrays are never reordered in place.
    const outputAsc = [...samples.output].sort((a, b) => a - b);
    const freshInputAsc = [...samples.freshInput].sort((a, b) => a - b);
    suggestions.push({
      modelId: summary.modelId,
      suggestedPerTurnOutputTokenCap: roundUpToTokenBucket(
        percentileNearestRank(outputAsc, 0.95),
        1000
      ),
      suggestedPerTurnOutputTokenCapBasis: {
        method: "nearest-rank P95 of per-turn outputTokens, rounded up to a multiple of 1000",
        sampleCount: observed
      },
      suggestedInputBudgetReference: percentileNearestRank(freshInputAsc, 0.5),
      suggestedInputBudgetReferenceBasis: {
        method:
          "nearest-rank P50 of per-turn inputTokens (fresh input; cache reads/creations excluded)",
        sampleCount: observed
      }
    });
  }
  for (const [modelId, samples] of samplesByModel) {
    if (!summarizedModels.has(modelId)) {
      gaps.push({
        modelId,
        reason: "events-without-summary",
        observedSampleCount: samples.output.length,
        requiredSampleCount: MIN_SAMPLES_PER_MODEL
      });
    }
  }

  // Canonical order independent of input order: deterministic output for
  // equal inputs is part of the purity contract.
  suggestions.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
  gaps.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));

  return deepFreezeOutcome({
    status: suggestions.length > 0 ? "ready" : "insufficient-data",
    detail: suggestions.length > 0 ? READY_DETAIL : INSUFFICIENT_DETAIL,
    suggestions,
    gaps
  });
}
