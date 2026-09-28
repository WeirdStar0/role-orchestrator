import { describe, expect, it } from "vitest";
import { parseClaudeUsageEvents } from "../src/index.js";

const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  duration_ms: 1234,
  // Real-shape extras the dialect carries; extractor must ignore them.
  total_cost_usd: 9.99,
  modelUsage: {
    "model-a[1m]": { inputTokens: 1, outputTokens: 2, costUSD: 3.5, contextWindow: 1000000 }
  },
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3,
    service_tier: "standard",
    inference_geo: "not_available",
    output_tokens_details: { thinking_tokens: 0 }
  }
});

// Real claude stream-json shape: the API message is nested (verified against
// the M8-01 captures).
const assistantLine = JSON.stringify({
  type: "assistant",
  session_id: "s",
  message: {
    model: "model-a-5-5",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 }
    }
  }
});

describe("parseClaudeUsageEvents (synthetic dialect shapes)", () => {
  it("extracts the result line as the turn summary: modelUsage key, duration, contract-unknown cost", () => {
    const result = parseClaudeUsageEvents(resultLine);
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
      modelId: "model-a[1m]",
      durationMs: 1234,
      costUsd: "unknown"
    });
  });

  it("drops self-reported source cost fields by construction (not a price oracle)", () => {
    const result = parseClaudeUsageEvents(resultLine);
    expect(JSON.stringify(result.events)).not.toContain("9.99");
    expect(JSON.stringify(result.events)).not.toContain("costUSD");
  });

  it("default: assistant lines are NOT extracted (result totals already cover the turn)", () => {
    const result = parseClaudeUsageEvents(`${assistantLine}\n${resultLine}`);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.modelId).toBe("model-a[1m]");
    expect(result.linesSkipped).toBe(1);
  });

  it("includeAssistantEvents: assistant usage extracted with the LINE model and null duration", () => {
    const result = parseClaudeUsageEvents(assistantLine, { includeAssistantEvents: true });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
      modelId: "model-a-5-5",
      durationMs: null,
      costUsd: "unknown"
    });
  });

  it("model resolution falls back line.model, then the explicit unknown sentinel (never guessed)", () => {
    const noModelUsage = JSON.stringify({
      type: "result",
      duration_ms: 5,
      model: "fallback-model",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    });
    expect(parseClaudeUsageEvents(noModelUsage).events[0]?.modelId).toBe("fallback-model");

    const noModelAtAll = JSON.stringify({
      type: "result",
      duration_ms: 5,
      modelUsage: {},
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    });
    expect(parseClaudeUsageEvents(noModelAtAll).events[0]?.modelId).toBe("unknown");

    const multiKeyModelUsage = JSON.stringify({
      type: "result",
      modelUsage: { "m1": {}, "m2": {} },
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    });
    expect(parseClaudeUsageEvents(multiKeyModelUsage).events[0]?.modelId).toBe("unknown");
  });

  it("non-usage lines (system/streams) are skipped, not errors", () => {
    const systemInit = JSON.stringify({ type: "system", subtype: "init", cwd: "H:\\x" });
    const result = parseClaudeUsageEvents(`${systemInit}\n${assistantLine}`);
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.linesTotal).toBe(2);
    expect(result.linesSkipped).toBe(2);
  });

  it("malformed lines are RECORDED with their line number, never silently swallowed", () => {
    const result = parseClaudeUsageEvents("not-json\n{\"usage\": broken\n");
    expect(result.events).toEqual([]);
    expect(result.errors.map((e) => e.reason)).toEqual(["unparseable-json", "unparseable-json"]);
    expect(result.errors.map((e) => e.line)).toEqual([1, 2]);
  });

  it("a usage object with an invalid consumed field fails THAT line and keeps parsing", () => {
    const badUsage = JSON.stringify({
      type: "result",
      duration_ms: 5,
      modelUsage: { "m": {} },
      usage: { input_tokens: "many", output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    });
    const good = resultLine;
    const result = parseClaudeUsageEvents(`${badUsage}\n${good}`);
    expect(result.errors).toEqual([{ line: 1, reason: "claude-result-usage-shape-invalid" }]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.modelId).toBe("model-a[1m]");
  });

  it("a result line without usage is skipped (e.g. error results), not an error", () => {
    const errorResult = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true });
    const result = parseClaudeUsageEvents(errorResult);
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.linesSkipped).toBe(1);
  });

  it("blank lines do not count as lines and never error", () => {
    const result = parseClaudeUsageEvents(`\n${resultLine}\n\n`);
    expect(result.events).toHaveLength(1);
    expect(result.linesTotal).toBe(1);
  });
});
