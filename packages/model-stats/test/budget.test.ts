import { describe, expect, it } from "vitest";
import {
  BUDGET_REFINEMENT_STATUS,
  BudgetRefinementInputSchema,
  ModelPerformanceSummarySchema,
  refineBudgetThresholds
} from "../src/index.js";
import type { ModelPerformanceSummary } from "../src/index.js";

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

describe("BudgetRefinement hook (reserved stub, M8 ask)", () => {
  it("the stub status constant is exported and pinned", () => {
    expect(BUDGET_REFINEMENT_STATUS).toBe("stub");
  });

  it("always returns the stub outcome — for empty AND heavy-usage inputs alike", () => {
    const empty = refineBudgetThresholds({ summaries: [] });
    const heavy = refineBudgetThresholds({
      summaries: [
        summary({ modelId: "expensive", totalTokens: 999_999_999, eventCount: 10_000 }),
        summary({ modelId: "cheap" })
      ]
    });
    for (const outcome of [empty, heavy]) {
      expect(outcome.status).toBe("stub");
      expect(outcome.detail).toContain("no threshold refinement is implemented");
    }
    // The stub decision is identical regardless of the data: no hidden policy.
    expect(empty).toEqual(heavy);
  });

  it("does not mutate its input and produces no threshold values", () => {
    const input = Object.freeze({ summaries: Object.freeze([summary()]) });
    const before = JSON.stringify(input);
    const outcome = refineBudgetThresholds(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(outcome)).not.toMatch(/"(maxTokens|maxCalls|limit|threshold|budget)"/);
  });

  it("validates its input strictly: unknown fields and non-unknown cost rejected", () => {
    expect(() =>
      refineBudgetThresholds({ summaries: [], smuggledPolicy: "raise-limits" } as unknown as Parameters<
        typeof refineBudgetThresholds
      >[0])
    ).toThrow();
    expect(
      ModelPerformanceSummarySchema.safeParse({ ...summary(), costUsd: 5 }).success
    ).toBe(false);
    expect(() => BudgetRefinementInputSchema.parse({ summaries: "all" })).toThrow();
  });
});
