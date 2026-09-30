import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLES_PER_MODEL,
  BudgetRefinementInputSchema,
  BudgetRefinementOutcomeSchema,
  ModelPerformanceSummarySchema,
  refineBudgetThresholds,
  type BudgetRefinementOutcome
} from "../src/index.js";
import type { ModelPerformanceSummary, UsageEvent } from "../src/index.js";
import { makeEvent } from "./helpers.js";

function summary(overrides: Partial<ModelPerformanceSummary> = {}): ModelPerformanceSummary {
  return {
    modelId: "m",
    eventCount: 1,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalTokens: 15,
    averageDurationMs: null,
    durationSampleCount: 0,
    costUsd: "unknown",
    ...overrides
  };
}

/** Per-turn sample set: inputs and outputs given pairwise, order preserved. */
function sampleEvents(modelId: string, turns: readonly { input: number; output: number }[]): UsageEvent[] {
  return turns.map(({ input, output }) =>
    makeEvent({ modelId, inputTokens: input, outputTokens: output })
  );
}

/** Build input where the summary's totals are CONSISTENT with the passed samples. */
function consistentInput(
  modelId: string,
  turns: readonly { input: number; output: number }[]
): { summaries: readonly ModelPerformanceSummary[]; events: readonly UsageEvent[] } {
  const events = sampleEvents(modelId, turns);
  const sum = (pick: (e: UsageEvent) => number) => events.reduce((acc, e) => acc + pick(e), 0);
  return {
    summaries: [
      summary({
        modelId,
        eventCount: events.length,
        totalInputTokens: sum((e) => e.inputTokens),
        totalOutputTokens: sum((e) => e.outputTokens),
        totalTokens: sum((e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens)
      })
    ],
    events
  };
}

function expectHonestBoundary(outcome: BudgetRefinementOutcome): void {
  expect(outcome.detail).toContain("NOT policy");
  expect(outcome.detail).toContain("maintainer approval");
  expect(outcome.detail).toContain("its own batch");
}

describe("BudgetRefinement two-state machine (M8-04)", () => {
  it("empty input: insufficient-data with no suggestions and no gaps — total, never throws", () => {
    const outcome = refineBudgetThresholds({ summaries: [] });
    expect(outcome.status).toBe("insufficient-data");
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.gaps).toEqual([]);
    expectHonestBoundary(outcome);
  });

  it("stub-era input shape { summaries } still validates: explicit no-per-event-samples gap, never a throw", () => {
    const outcome = refineBudgetThresholds({ summaries: [summary({ modelId: "m", eventCount: 5 })] });
    expect(outcome.status).toBe("insufficient-data");
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.gaps).toEqual([
      { modelId: "m", reason: "no-per-event-samples", observedSampleCount: 0, requiredSampleCount: 5 }
    ]);
    expectHonestBoundary(outcome);
  });

  it("below MIN_SAMPLES_PER_MODEL (n=4): insufficient-samples gap naming observed vs required", () => {
    const input = consistentInput("m", [
      { input: 10, output: 100 },
      { input: 20, output: 200 },
      { input: 30, output: 300 },
      { input: 40, output: 9_999_999 }
    ]);
    expect(input.events).toHaveLength(4);
    expect(MIN_SAMPLES_PER_MODEL).toBe(5);
    const outcome = refineBudgetThresholds(input);
    expect(outcome.status).toBe("insufficient-data");
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.gaps).toEqual([
      { modelId: "m", reason: "insufficient-samples", observedSampleCount: 4, requiredSampleCount: 5 }
    ]);
  });

  it("at n=5 the bucket is ready: cap = nearest-rank P95 rounded up to a multiple of 1000, reference = nearest-rank P50, both with method+n basis", () => {
    // Deliberately unsorted: the advice must derive the order itself.
    const input = consistentInput("m", [
      { input: 30, output: 3000 },
      { input: 50, output: 5500 },
      { input: 10, output: 1000 },
      { input: 40, output: 4000 },
      { input: 20, output: 2000 }
    ]);
    const outcome = refineBudgetThresholds(input);
    expect(outcome.status).toBe("ready");
    expect(outcome.gaps).toEqual([]);
    expect(outcome.suggestions).toHaveLength(1);
    const advice = outcome.suggestions[0];
    expect(advice?.modelId).toBe("m");
    // outputs sorted [1000,2000,3000,4000,5500]: rank ceil(0.95·5)=5 → 5500 → rounded up to a multiple of 1000 → 6000
    expect(advice?.suggestedPerTurnOutputTokenCap).toBe(6000);
    expect(advice?.suggestedPerTurnOutputTokenCapBasis).toEqual({
      method: "nearest-rank P95 of per-turn outputTokens, rounded up to a multiple of 1000",
      sampleCount: 5
    });
    // inputs sorted [10,20,30,40,50]: rank ceil(0.5·5)=3 → 30 (raw P50, no bucket rounding)
    expect(advice?.suggestedInputBudgetReference).toBe(30);
    expect(advice?.suggestedInputBudgetReferenceBasis).toEqual({
      method: "nearest-rank P50 of per-turn inputTokens (fresh input; cache reads/creations excluded)",
      sampleCount: 5
    });
    expectHonestBoundary(outcome);
  });

  it("sample count must equal the summary's eventCount: advising over a subset of the declared aggregate is refused", () => {
    const input = consistentInput("m", [
      { input: 10, output: 100 },
      { input: 20, output: 200 },
      { input: 30, output: 300 },
      { input: 40, output: 400 },
      { input: 50, output: 500 }
    ]);
    const padded = {
      summaries: [summary({ ...input.summaries[0]!, eventCount: 6, totalTokens: input.summaries[0]!.totalTokens + 7 })],
      events: input.events
    };
    const outcome = refineBudgetThresholds(padded);
    expect(outcome.status).toBe("insufficient-data");
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.gaps).toEqual([
      { modelId: "m", reason: "sample-count-mismatch", observedSampleCount: 5, requiredSampleCount: 6 }
    ]);
  });

  it("mixed window: the ready model is advised, the starved model is an explicit gap — one outcome, both truths", () => {
    const rich = consistentInput("rich-model", [
      { input: 10, output: 1000 },
      { input: 20, output: 2000 },
      { input: 30, output: 3000 },
      { input: 40, output: 4000 },
      { input: 50, output: 5000 }
    ]);
    const poorTurns = [
      { input: 5, output: 50 },
      { input: 6, output: 60 }
    ];
    const poorEvents = sampleEvents("poor-model", poorTurns);
    const outcome = refineBudgetThresholds({
      summaries: [
        summary({
          modelId: "poor-model",
          eventCount: 2,
          totalInputTokens: 11,
          totalOutputTokens: 110,
          totalTokens: 121
        }),
        ...rich.summaries
      ],
      events: [...poorEvents, ...rich.events]
    });
    expect(outcome.status).toBe("ready");
    expect(outcome.suggestions.map((s) => s.modelId)).toEqual(["rich-model"]);
    expect(outcome.gaps).toEqual([
      { modelId: "poor-model", reason: "insufficient-samples", observedSampleCount: 2, requiredSampleCount: 5 }
    ]);
  });

  it("an exact multiple of 1000 is NOT bumped: P95 4000 stays 4000 (rounding targets a multiple, not 'the next')", () => {
    const input = consistentInput("m", [
      { input: 10, output: 1000 },
      { input: 20, output: 2000 },
      { input: 30, output: 3000 },
      { input: 40, output: 4000 },
      { input: 50, output: 4000 }
    ]);
    const outcome = refineBudgetThresholds(input);
    expect(outcome.status).toBe("ready");
    const advice = outcome.suggestions[0];
    // sorted outputs [1000,2000,3000,4000,4000]: rank ceil(0.95·5)=5 → 4000 → already a multiple of 1000 → stays 4000
    expect(advice?.suggestedPerTurnOutputTokenCap).toBe(4000);
    expect(advice?.suggestedPerTurnOutputTokenCapBasis.method).toBe(
      "nearest-rank P95 of per-turn outputTokens, rounded up to a multiple of 1000"
    );
  });

  it("rounding direction is UP, not nearest: P95 4200 → 5000 (nearest-multiple rounding would give 4000)", () => {
    // POLISH-4 D-family pin: 4200 sits closer to 4000 (distance 200) than to
    // 5000 (distance 800), so a "round to nearest multiple" would keep 4000.
    // Pinning 5000 nails the direction as ceil-to-multiple. Together with the
    // existing pins (5500→6000 here, 4000→4000 above, 911→1000 in
    // fixtures-real) this covers the rounding matrix.
    const input = consistentInput("m", [
      { input: 10, output: 1000 },
      { input: 20, output: 2000 },
      { input: 30, output: 3000 },
      { input: 40, output: 4000 },
      { input: 50, output: 4200 }
    ]);
    const outcome = refineBudgetThresholds(input);
    expect(outcome.status).toBe("ready");
    const advice = outcome.suggestions[0];
    // sorted outputs [1000,2000,3000,4000,4200]: rank ceil(0.95·5)=5 → 4200 → ceil to a multiple of 1000 → 5000
    expect(advice?.suggestedPerTurnOutputTokenCap).toBe(5000);
    expect(advice?.suggestedPerTurnOutputTokenCapBasis.method).toBe(
      "nearest-rank P95 of per-turn outputTokens, rounded up to a multiple of 1000"
    );
  });

  it("two ready models + two gaps in unordered input: canonical modelId order, deep-equal under input reversal", () => {
    const zeta = consistentInput("zeta", [
      { input: 11, output: 1100 },
      { input: 22, output: 2200 },
      { input: 33, output: 3300 },
      { input: 44, output: 4400 },
      { input: 55, output: 5500 }
    ]);
    const alpha = consistentInput("alpha", [
      { input: 9, output: 900 },
      { input: 8, output: 800 },
      { input: 7, output: 700 },
      { input: 6, output: 600 },
      { input: 5, output: 500 }
    ]);
    const poor = consistentInput("poor-model", [
      { input: 5, output: 50 },
      { input: 6, output: 60 }
    ]);
    const ghostEvents = sampleEvents("ghost-model", [
      { input: 1, output: 1 },
      { input: 2, output: 2 },
      { input: 3, output: 3 },
      { input: 4, output: 4 },
      { input: 5, output: 5 }
    ]);
    // Deliberately non-canonical input order on BOTH arrays.
    const summaries = [...zeta.summaries, ...poor.summaries, ...alpha.summaries];
    const events = [...ghostEvents, ...poor.events, ...alpha.events, ...zeta.events];
    const outcome = refineBudgetThresholds({ summaries, events });

    expect(outcome.status).toBe("ready");
    // Suggestions sorted by modelId — never the order the input happened to be in.
    expect(outcome.suggestions.map((s) => s.modelId)).toEqual(["alpha", "zeta"]);
    // Same for gaps: sorted modelId across gap reasons.
    expect(outcome.gaps.map((g) => g.modelId)).toEqual(["ghost-model", "poor-model"]);
    expect(outcome.gaps.map((g) => g.reason)).toEqual(["events-without-summary", "insufficient-samples"]);

    // Input-order independence: reversing both arrays yields a deep-equal outcome.
    const reversed = refineBudgetThresholds({
      summaries: [...summaries].reverse(),
      events: [...events].reverse()
    });
    expect(reversed).toEqual(outcome);
  });

  it("events naming a model with no summary are flagged, never silently advised on", () => {
    const events = sampleEvents("ghost-model", [
      { input: 1, output: 1 },
      { input: 2, output: 2 },
      { input: 3, output: 3 },
      { input: 4, output: 4 },
      { input: 5, output: 5 }
    ]);
    const outcome = refineBudgetThresholds({ summaries: [], events });
    expect(outcome.status).toBe("insufficient-data");
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.gaps).toEqual([
      { modelId: "ghost-model", reason: "events-without-summary", observedSampleCount: 5, requiredSampleCount: 5 }
    ]);
  });
});

describe("BudgetRefinement purity (read-only, deterministic, no side effects)", () => {
  it("same input twice: identical outcome — no clock, no randomness, no counters", () => {
    const input = consistentInput("m", [
      { input: 30, output: 3000 },
      { input: 50, output: 5500 },
      { input: 10, output: 1000 },
      { input: 40, output: 4000 },
      { input: 20, output: 2000 }
    ]);
    const first = refineBudgetThresholds(input);
    const second = refineBudgetThresholds(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second); // a fresh frozen object per call, same content
  });

  it("does not mutate its input — even frozen arrays (an in-place sort would throw on them)", () => {
    const events = Object.freeze(
      sampleEvents("m", [
        { input: 30, output: 3000 },
        { input: 50, output: 5500 },
        { input: 10, output: 1000 },
        { input: 40, output: 4000 },
        { input: 20, output: 2000 }
      ]).map((event) => Object.freeze(event))
    );
    const input = Object.freeze({
      summaries: Object.freeze([Object.freeze(summary({ eventCount: 5 }))]),
      events: Object.freeze(events)
    });
    const before = JSON.stringify(input);
    const outcome = refineBudgetThresholds(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(outcome.status).toBe("ready"); // the advice was still computed
  });

  it("the outcome is deep-frozen: fields are readonly at runtime, not just in types", () => {
    const input = consistentInput("m", [
      { input: 1, output: 1 },
      { input: 2, output: 2 },
      { input: 3, output: 3 },
      { input: 4, output: 4 },
      { input: 5, output: 5 }
    ]);
    const outcome = refineBudgetThresholds(input);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.suggestions)).toBe(true);
    expect(Object.isFrozen(outcome.gaps)).toBe(true);
    for (const suggestion of outcome.suggestions) {
      expect(Object.isFrozen(suggestion)).toBe(true);
      expect(Object.isFrozen(suggestion.suggestedPerTurnOutputTokenCapBasis)).toBe(true);
      expect(Object.isFrozen(suggestion.suggestedInputBudgetReferenceBasis)).toBe(true);
    }
    for (const gap of outcome.gaps) expect(Object.isFrozen(gap)).toBe(true);
  });
});

describe("BudgetRefinement input validation (strict; failures are input errors, thrown)", () => {
  it("unknown fields are rejected at every level", () => {
    expect(() =>
      refineBudgetThresholds({ summaries: [], smuggledPolicy: "raise-limits" } as unknown as Parameters<
        typeof refineBudgetThresholds
      >[0])
    ).toThrow();
    expect(() =>
      refineBudgetThresholds({
        summaries: [summary()],
        events: [{ ...makeEvent(), stealth: true }] as unknown as UsageEvent[]
      })
    ).toThrow();
    expect(() => BudgetRefinementInputSchema.parse({ summaries: "all" })).toThrow();
    expect(ModelPerformanceSummarySchema.safeParse({ ...summary(), costUsd: 5 }).success).toBe(false);
  });

  it("duplicate model summaries make the aggregate ambiguous: input error", () => {
    expect(() => refineBudgetThresholds({ summaries: [summary(), summary()] })).toThrow(/duplicate summary/);
  });
});

describe("BudgetRefinement cost-agnostic semantics (red line: no fee figures)", () => {
  it("every suggestion is an integer token count; the outcome schema has no cost field; no currency figure anywhere", () => {
    const input = consistentInput("m", [
      { input: 30, output: 3000 },
      { input: 50, output: 5500 },
      { input: 10, output: 1000 },
      { input: 40, output: 4000 },
      { input: 20, output: 2000 }
    ]);
    const outcome = refineBudgetThresholds(input);
    for (const suggestion of outcome.suggestions) {
      expect(Number.isInteger(suggestion.suggestedPerTurnOutputTokenCap)).toBe(true);
      expect(Number.isInteger(suggestion.suggestedInputBudgetReference)).toBe(true);
      expect("costUsd" in suggestion).toBe(false);
      expect("costUsd" in outcome).toBe(false);
    }
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toMatch(/\$\s*\d/);
    expect(serialized).not.toMatch(/\d+(\.\d+)?\s*(usd|USD)/);
  });

  it("the outcome validates against its own strict schema; unknown fields on it are rejected", () => {
    const input = consistentInput("m", [
      { input: 1, output: 1 },
      { input: 2, output: 2 },
      { input: 3, output: 3 },
      { input: 4, output: 4 },
      { input: 5, output: 5 }
    ]);
    const outcome = refineBudgetThresholds(input);
    expect(BudgetRefinementOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(() =>
      BudgetRefinementOutcomeSchema.parse({ ...outcome, adopted: true })
    ).toThrow();
    const empty = refineBudgetThresholds({ summaries: [] });
    expect(BudgetRefinementOutcomeSchema.parse(empty)).toEqual(empty);
  });
});

describe("BudgetRefinement decision-vocabulary boundary (stub-era N7 assertion, restored M8-06)", () => {
  it("no decision-vocabulary key (maxTokens/maxCalls/limit/threshold/budget) appears anywhere in the outcome JSON", () => {
    // Pre-checked against the built dist before restoring (M8-06): the
    // current outcome shape passes — this pins the boundary, it changes
    // nothing. The advice fields describe what IS (observed percentile
    // derivations), never the execution vocabulary of limits/thresholds.
    const input = consistentInput("m", [
      { input: 30, output: 3000 },
      { input: 50, output: 5500 },
      { input: 10, output: 1000 },
      { input: 40, output: 4000 },
      { input: 20, output: 2000 }
    ]);
    const outcome = refineBudgetThresholds(input);
    expect(JSON.stringify(outcome)).not.toMatch(/"(maxTokens|maxCalls|limit|threshold|budget)"/);
  });

  it("vocabulary boundary over a dual-ready + dual-gap outcome (M5 input shape): gap objects' literal keys are covered too", () => {
    // POLISH-4 C-family N7 variant: the original assertion runs on a
    // single-ready outcome, so only suggestion-object keys were serialized.
    // Rebuilding the M5 test's dual-ready (alpha/zeta) + dual-gap
    // (poor/ghost) shape puts both object kinds into the JSON, so the regex
    // also runs over the gap keys (reason/observedSampleCount/
    // requiredSampleCount), not just the suggestion keys.
    const zeta = consistentInput("zeta", [
      { input: 11, output: 1100 },
      { input: 22, output: 2200 },
      { input: 33, output: 3300 },
      { input: 44, output: 4400 },
      { input: 55, output: 5500 }
    ]);
    const alpha = consistentInput("alpha", [
      { input: 9, output: 900 },
      { input: 8, output: 800 },
      { input: 7, output: 700 },
      { input: 6, output: 600 },
      { input: 5, output: 500 }
    ]);
    const poor = consistentInput("poor-model", [
      { input: 5, output: 50 },
      { input: 6, output: 60 }
    ]);
    const ghostEvents = sampleEvents("ghost-model", [
      { input: 1, output: 1 },
      { input: 2, output: 2 },
      { input: 3, output: 3 },
      { input: 4, output: 4 },
      { input: 5, output: 5 }
    ]);
    const outcome = refineBudgetThresholds({
      summaries: [...zeta.summaries, ...poor.summaries, ...alpha.summaries],
      events: [...ghostEvents, ...poor.events, ...alpha.events, ...zeta.events]
    });
    // Preconditions mirroring the M5 ordering test: both kinds present.
    expect(outcome.status).toBe("ready");
    expect(outcome.suggestions).toHaveLength(2);
    expect(outcome.gaps).toHaveLength(2);
    expect(JSON.stringify(outcome)).not.toMatch(/"(maxTokens|maxCalls|limit|threshold|budget)"/);
  });
});
