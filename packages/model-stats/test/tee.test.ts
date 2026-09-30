/**
 * Usage tee sink adapter (M8-04): the model-stats side of the engine
 * persistence tee. Hermetic — the seven real M8-01 supplementary-window
 * captures are fed through the adapter as raw lines (exactly what the
 * engine's sink contract delivers), never through a live CLI.
 */
import { describe, expect, it } from "vitest";
import { createUsageSink, PerformanceStore } from "../src/index.js";
import { SUPPLEMENT_FIXTURE_FILES, readSupplementFixture } from "./helpers.js";

/** Engine-side synthetic usage line shape: raw type + verbatim usage object. */
function syntheticClaudeUsageLine(usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", usage });
}

describe("createUsageSink (engine tee → dialect extractors → PerformanceStore)", () => {
  it("seven real captures fed as raw lines: all append, report() reflects them, cost unknown throughout", async () => {
    const store = new PerformanceStore();
    const sink = createUsageSink(store, { codexModelId: "gpt-6-sol" });
    for (const file of SUPPLEMENT_FIXTURE_FILES) {
      const text = await readSupplementFixture(file);
      // Whole-file feed: the extractors skip non-usage lines themselves.
      sink(text.split(/\r?\n/).filter((line) => line.trim().length > 0), file.includes("codex") ? "codex" : "claude");
    }
    expect(store.size).toBe(7); // 5 claude result lines + 2 codex turn.completed lines
    const summaries = store.summaryByModel();
    // claude lines carry the modelUsage key, so line-derived attribution stands
    // (no claudeModelId needed); codex needed the caller-supplied model.
    expect(summaries.map((s) => s.modelId)).toEqual(["claude-opus-5[1m]", "gpt-6-sol"]);
    expect(summaries.map((s) => s.costUsd)).toEqual(["unknown", "unknown"]);
    expect(summaries[0]).toMatchObject({
      eventCount: 5,
      totalOutputTokens: 394 + 137 + 3 + 3 + 911,
      totalInputTokens: 6 + 2 + 4 + 2 + 2
    });
    expect(summaries[1]).toMatchObject({ eventCount: 2, totalInputTokens: 285404 + 56622 });

    const report = store.report();
    expect(report).toContain("claude-opus-5[1m]");
    expect(report).toContain("gpt-6-sol");
    expect(report).toContain("cost: unknown");
  });

  it("engine synthetic usage lines (no model inside) land on the caller's attribution, never a guess", () => {
    const store = new PerformanceStore();
    const sink = createUsageSink(store, {
      claudeModelId: "claude-opus-5[1m]",
      codexModelId: "gpt-6-sol"
    });
    // Exactly what the engine tees for a persisted claude usage payload.
    sink(
      [
        syntheticClaudeUsageLine({ input_tokens: 2, output_tokens: 12, cache_read_input_tokens: 36352, cache_creation_input_tokens: 14908 }),
        syntheticClaudeUsageLine({ input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 55001 })
      ],
      "claude"
    );
    sink([JSON.stringify({ type: "turn.completed", usage: { input_tokens: 56622, cached_input_tokens: 4096, cache_write_input_tokens: 0, output_tokens: 5 } })], "codex");
    expect(store.size).toBe(3);
    expect(store.summaryByModel().map((s) => s.modelId)).toEqual(["claude-opus-5[1m]", "gpt-6-sol"]);
    expect(store.events().every((e) => e.durationMs === null && e.costUsd === "unknown")).toBe(true);
  });

  it("without attribution the sentinel bucket is used — visible, never mis-attributed", () => {
    const store = new PerformanceStore();
    const sink = createUsageSink(store);
    sink([syntheticClaudeUsageLine({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })], "claude");
    expect(store.summaryByModel().map((s) => s.modelId)).toEqual(["unknown"]);
  });

  it("empty-string attribution is rejected at the adapter entry — nothing parsed, nothing appended", () => {
    const store = new PerformanceStore();
    expect(() => createUsageSink(store, { claudeModelId: "" })).toThrow();
    expect(() => createUsageSink(store, { codexModelId: "" })).toThrow();
    // The throw happened in createUsageSink, before any sink call — the
    // store never saw an event (no partial batch, no sentinel replacement).
    expect(store.size).toBe(0);
    // Unknown option fields are rejected by the same strict entry gate.
    expect(() =>
      createUsageSink(store, { codexModelId: "gpt-6-sol", extra: true } as never)
    ).toThrow();
    expect(store.size).toBe(0);
  });

  it("lines that yield no event are skipped silently — the adapter neither throws nor fabricates", () => {
    const store = new PerformanceStore();
    const sink = createUsageSink(store);
    expect(() => sink(["not-json-at-all", "{\"type\":\"system\"}"], "claude")).not.toThrow();
    expect(store.size).toBe(0);
    sink([], "claude"); // empty tee: no-op
    expect(store.size).toBe(0);
  });

  it("the adapter is honest: a failing store propagates — fail-open is the engine side's guarantee", () => {
    class ExplodingStore extends PerformanceStore {
      override append(): never {
        throw new Error("store down");
      }
    }
    const sink = createUsageSink(new ExplodingStore());
    expect(() =>
      sink([syntheticClaudeUsageLine({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })], "claude")
    ).toThrow("store down");
  });
});
