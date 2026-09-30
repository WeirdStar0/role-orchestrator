/**
 * Contract tests over the REAL M8-01 controlled-window captures (read-only
 * cross-package reference into packages/cli-events/fixtures-real;
 * sanitized verbatim CLI output). These pin the extractor behavior against
 * the actual claude stream-json / codex exec --json shapes the window
 * recorded — no live CLI is ever spawned here (hermetic, M8 ask).
 */
import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLES_PER_MODEL,
  BudgetRefinementOutcomeSchema,
  parseClaudeUsageEvents,
  parseCodexUsageEvents,
  PerformanceStore,
  refineBudgetThresholds
} from "../src/index.js";
import { SUPPLEMENT_FIXTURE_FILES, readRealFixture, readSupplementFixture } from "./helpers.js";

describe("real M8-01 fixtures (read-only)", () => {
  it("claude-c1-stream.jsonl: result line yields the authoritative turn event with exact captured numbers", async () => {
    const text = await readRealFixture("claude-c1-stream.jsonl");
    const result = parseClaudeUsageEvents(text);
    expect(result.errors).toEqual([]);
    expect(result.linesTotal).toBe(4); // system init, system commands_changed, assistant, result
    expect(result.events).toHaveLength(1); // default: assistant line NOT extracted (no double counting)
    expect(result.events[0]).toEqual({
      inputTokens: 2,
      outputTokens: 12,
      cacheReadTokens: 36352,
      cacheCreationTokens: 14908,
      modelId: "claude-opus-5[1m]",
      durationMs: 3533,
      costUsd: "unknown"
    });
  });

  it("claude-c1-stream.jsonl: opt-in assistant extraction surfaces the message-level numbers it really carried", async () => {
    const text = await readRealFixture("claude-c1-stream.jsonl");
    const result = parseClaudeUsageEvents(text, { includeAssistantEvents: true });
    expect(result.events).toHaveLength(2);
    // The real stream's assistant line genuinely differs from the result
    // totals (model string AND token counts) — documenting both is exactly
    // why the default extracts only the turn summary.
    expect(result.events[0]).toMatchObject({
      modelId: "claude-opus-5-5",
      inputTokens: 2,
      outputTokens: 8,
      cacheReadTokens: 36352,
      cacheCreationTokens: 14908,
      durationMs: null
    });
  });

  it("codex-x1-baseline.jsonl: turn.completed yields the captured usage with explicit model/duration", async () => {
    const text = await readRealFixture("codex-x1-baseline.jsonl");
    const withModel = parseCodexUsageEvents(text, { modelId: "gpt-6-sol" });
    expect(withModel.errors).toEqual([]);
    expect(withModel.linesTotal).toBe(6);
    expect(withModel.events).toHaveLength(1);
    expect(withModel.events[0]).toEqual({
      inputTokens: 56522,
      outputTokens: 12,
      cacheReadTokens: 4096,
      cacheCreationTokens: 0,
      modelId: "gpt-6-sol",
      durationMs: null,
      costUsd: "unknown"
    });
    // Without a caller-supplied model the event lands in the explicit
    // sentinel bucket — visible, not attributed to a wrong model.
    const sentinel = parseCodexUsageEvents(text);
    expect(sentinel.events[0]?.modelId).toBe("unknown");
  });

  it("both real captures aggregate side by side in one store, cost unknown throughout", async () => {
    const [claudeText, codexText] = await Promise.all([
      readRealFixture("claude-c1-stream.jsonl"),
      readRealFixture("codex-x1-baseline.jsonl")
    ]);
    const store = new PerformanceStore();
    store.appendMany(parseClaudeUsageEvents(claudeText).events);
    store.appendMany(parseCodexUsageEvents(codexText, { modelId: "gpt-6-sol" }).events);

    const summaries = store.summaryByModel();
    expect(summaries.map((s) => s.modelId)).toEqual(["claude-opus-5[1m]", "gpt-6-sol"]);
    expect(summaries.map((s) => s.costUsd)).toEqual(["unknown", "unknown"]);
    expect(summaries[0]).toMatchObject({ eventCount: 1, totalTokens: 2 + 12 + 36352 + 14908 });
    expect(summaries[1]).toMatchObject({ eventCount: 1, totalTokens: 56522 + 12 + 4096 + 0 });

    const report = store.report();
    expect(report).toContain("claude-opus-5[1m]");
    expect(report).toContain("gpt-6-sol");
    expect(report).toContain("cost: unknown");
  });
});

/**
 * M8-04 full-chain contract over the REAL supplementary window: every
 * fixtures-real jsonl goes parse → PerformanceStore → refineBudgetThresholds.
 * The codex files name their invoked model in-stream (`gpt-6-sol`); the
 * caller-supplied modelId follows that, per the extractor contract.
 */
describe("BudgetRefinement over the real M8-01 supplementary window (parse → store → refine)", () => {
  async function chainStore(): Promise<PerformanceStore> {
    const texts = await Promise.all(SUPPLEMENT_FIXTURE_FILES.map((file) => readSupplementFixture(file)));
    const store = new PerformanceStore();
    let claudeTurns = 0;
    let codexTurns = 0;
    SUPPLEMENT_FIXTURE_FILES.forEach((file, i) => {
      const text = texts[i] ?? "";
      if (file.includes("codex")) {
        const parsed = parseCodexUsageEvents(text, { modelId: "gpt-6-sol" });
        // The real s2 capture contains one genuinely malformed line (8);
        // the extractor RECORDED it instead of swallowing it — pinned here.
        expect(parsed.errors).toEqual(
          file === "s2-codex-tool.jsonl" ? [{ line: 8, reason: "unparseable-json" }] : []
        );
        store.appendMany(parsed.events);
        codexTurns += parsed.events.length;
      } else {
        const parsed = parseClaudeUsageEvents(text);
        expect(parsed.errors).toEqual([]);
        store.appendMany(parsed.events);
        claudeTurns += parsed.events.length;
      }
    });
    expect(claudeTurns).toBe(5); // one authoritative result event per claude capture
    expect(codexTurns).toBe(2); // one turn.completed event per codex capture
    expect(store.size).toBe(7);
    return store;
  }

  it("seven real captures: the 5-turn claude bucket is ready with audited P95/P50 advice; the 2-turn codex bucket is an explicit gap", async () => {
    const store = await chainStore();
    const outcome = refineBudgetThresholds({
      summaries: store.summaryByModel(),
      events: store.events()
    });
    // The outcome satisfies its own strict schema (zod strict, no unknown fields).
    expect(BudgetRefinementOutcomeSchema.parse(outcome)).toEqual(outcome);

    expect(outcome.status).toBe("ready"); // claude bucket carries exactly MIN_SAMPLES_PER_MODEL turns
    const claude = outcome.suggestions.find((s) => s.modelId === "claude-opus-5[1m]");
    expect(claude).toBeDefined();
    // Observed per-turn outputs: 394, 137, 3, 3, 911 → sorted [3, 3, 137, 394, 911];
    // nearest-rank P95 at n=5 → rank 5 → 911 → rounded up to a multiple of 1000 → 1000.
    expect(claude?.suggestedPerTurnOutputTokenCap).toBe(1000);
    expect(claude?.suggestedPerTurnOutputTokenCapBasis).toEqual({
      method: "nearest-rank P95 of per-turn outputTokens, rounded up to a multiple of 1000",
      sampleCount: 5
    });
    // Observed per-turn fresh inputs: 6, 2, 4, 2, 2 → sorted [2, 2, 2, 4, 6];
    // nearest-rank P50 at n=5 → rank 3 → 2 (raw; the reference is not bucket-rounded).
    expect(claude?.suggestedInputBudgetReference).toBe(2);
    expect(claude?.suggestedInputBudgetReferenceBasis).toEqual({
      method: "nearest-rank P50 of per-turn inputTokens (fresh input; cache reads/creations excluded)",
      sampleCount: 5
    });
    // The codex window only has 2 turns: no advice, an honest gap instead.
    expect(outcome.gaps).toEqual([
      {
        modelId: "gpt-6-sol",
        reason: "insufficient-samples",
        observedSampleCount: 2,
        requiredSampleCount: MIN_SAMPLES_PER_MODEL
      }
    ]);
    expect(outcome.detail).toContain("NOT policy");
    expect(outcome.detail).toContain("maintainer approval");
  });

  it("cost stays contract-unknown through the whole chain; no fee figure appears in the advice", async () => {
    const store = await chainStore();
    const summaries = store.summaryByModel();
    expect(summaries.map((s) => s.costUsd)).toEqual(["unknown", "unknown"]);
    const outcome = refineBudgetThresholds({ summaries, events: store.events() });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toMatch(/usd/i);
    expect(serialized).not.toMatch(/\$\s*\d/);
    expect(serialized).not.toMatch(/\d+(\.\d+)?\s*(usd|USD)/);
  });

  it("the refinement is a pure read: store size and events unchanged, outcome deterministic", async () => {
    const store = await chainStore();
    const eventsBefore = store.events();
    const summariesBefore = store.summaryByModel();
    const first = refineBudgetThresholds({ summaries: summariesBefore, events: eventsBefore });
    const second = refineBudgetThresholds({ summaries: store.summaryByModel(), events: store.events() });
    expect(first).toEqual(second);
    expect(store.size).toBe(7);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.summaryByModel()).toEqual(summariesBefore);
  });

  it("empty real chain (nothing recorded): insufficient-data, no suggestions, no gaps", async () => {
    const store = new PerformanceStore();
    const outcome = refineBudgetThresholds({
      summaries: store.summaryByModel(),
      events: store.events()
    });
    expect(outcome.status).toBe("insufficient-data");
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.gaps).toEqual([]);
    expect(outcome.detail).toContain("NOT policy");
  });
});
