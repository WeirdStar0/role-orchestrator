import { describe, expect, it } from "vitest";
import { parseCodexUsageEvents } from "../src/index.js";

function turnCompleted(usageOverrides: Record<string, number> = {}): string {
  return JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 7,
      output_tokens: 12,
      reasoning_output_tokens: 3,
      ...usageOverrides
    }
  });
}

describe("parseCodexUsageEvents (synthetic dialect shapes)", () => {
  it("maps turn.completed fields onto the UsageEvent contract", () => {
    const result = parseCodexUsageEvents(turnCompleted());
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 40,
      cacheCreationTokens: 7,
      durationMs: null,
      costUsd: "unknown"
    });
  });

  it("modelId: explicit option wins; otherwise the explicit unknown sentinel (dialect names no model)", () => {
    expect(parseCodexUsageEvents(turnCompleted(), { modelId: "gpt-x" }).events[0]?.modelId).toBe("gpt-x");
    expect(parseCodexUsageEvents(turnCompleted()).events[0]?.modelId).toBe("unknown");
  });

  it("duration is never synthesized: codex carries no turn duration, event stays null", () => {
    const result = parseCodexUsageEvents(turnCompleted(), { modelId: "gpt-x" });
    expect(result.events[0]?.durationMs).toBeNull();
  });

  it("reasoning_output_tokens is ignored, not merged into outputTokens (no double counting)", () => {
    const withReasoning = parseCodexUsageEvents(turnCompleted()).events[0];
    const withoutReasoning = parseCodexUsageEvents(
      turnCompleted({ reasoning_output_tokens: 0 })
    ).events[0];
    expect(withReasoning?.outputTokens).toBe(12);
    expect(withoutReasoning?.outputTokens).toBe(12);
  });

  it("non-usage lines (thread.started, item.completed, turn.started) are skipped", () => {
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "01a0e716" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "hi" } }),
      turnCompleted()
    ].join("\n");
    const result = parseCodexUsageEvents(stream);
    expect(result.events).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.linesTotal).toBe(4);
    expect(result.linesSkipped).toBe(3);
  });

  it("malformed JSON and invalid usage shapes are recorded, never swallowed", () => {
    const brokenUsage = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: -5, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 }
    });
    const result = parseCodexUsageEvents(`garbage\n${brokenUsage}`);
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([
      { line: 1, reason: "unparseable-json" },
      { line: 2, reason: "codex-usage-shape-invalid" }
    ]);
  });

  it("turn.completed without a usage object is skipped", () => {
    const result = parseCodexUsageEvents(JSON.stringify({ type: "turn.completed" }));
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.linesSkipped).toBe(1);
  });
});
