/**
 * Contract tests over the REAL M8-01 controlled-window captures (read-only
 * cross-package reference into packages/cli-events/fixtures-real;
 * sanitized verbatim CLI output). These pin the extractor behavior against
 * the actual claude stream-json / codex exec --json shapes the window
 * recorded — no live CLI is ever spawned here (hermetic, M8 ask).
 */
import { describe, expect, it } from "vitest";
import { parseClaudeUsageEvents, parseCodexUsageEvents, PerformanceStore } from "../src/index.js";
import { readRealFixture } from "./helpers.js";

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
