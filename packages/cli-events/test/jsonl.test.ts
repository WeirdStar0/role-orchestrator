/**
 * Parser-level tests: chunk reassembly, multi-byte UTF-8 across chunks,
 * empty lines, CRLF, truncation, size limits, BOM, and the stderr side
 * channel.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_STREAM_LIMITS,
  EventStreamPipeline,
  evaluateOutcome,
  JsonlByteLineSplitter
} from "../src/index.js";
import { fakeCliFixturesDir, splitBuffer } from "./helpers.js";

const FIXED_NOW = (): string => "2026-09-21T00:00:00.000Z";

function newPipeline(
  executionId: string,
  limits?: { maxLineBytes?: number; maxTotalBytes?: number }
): EventStreamPipeline {
  return new EventStreamPipeline({
    dialect: "claude",
    executionId,
    now: FIXED_NOW,
    limits
  });
}

function pipeAll(lines: string[], limits?: { maxLineBytes?: number; maxTotalBytes?: number }): EventStreamPipeline {
  const pipeline = newPipeline("exec_parser_test", limits);
  pipeline.feedStdout(lines.map((line) => `${line}\n`).join(""));
  pipeline.finalize();
  return pipeline;
}

function claudeLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, synthetic: true, ...extra });
}

describe("JsonlByteLineSplitter / EventStreamPipeline parsing", () => {
  test("reassembles lines split across deterministic random chunk boundaries (A05)", () => {
    const fixture = readFileSync(path.join(fakeCliFixturesDir, "claude-success.synthetic.jsonl"));
    const whole = newPipeline("exec_a");
    whole.feedStdout(fixture);
    const wholeResult = whole.finalize();

    for (const seed of [1, 7, 42, 12345, 987654321]) {
      const chunked = newPipeline("exec_a");
      for (const chunk of splitBuffer(fixture, seed)) {
        chunked.feedStdout(chunk);
      }
      const chunkedResult = chunked.finalize();
      expect(chunkedResult.events, `seed ${seed}`).toEqual(wholeResult.events);
      expect(chunkedResult.protocolErrors, `seed ${seed}`).toEqual([]);
    }
  });

  test("decodes multi-byte UTF-8 split mid-codepoint across chunks", () => {
    const text = "分析完成 🎉 日本語テキスト";
    const line = JSON.stringify({
      type: "assistant",
      synthetic: true,
      message: { role: "assistant", content: [{ type: "text", text }] }
    });
    const bytes = Buffer.from(`${line}\n`, "utf8");

    // Find the emoji and split inside its 4-byte UTF-8 sequence.
    const emojiOffset = bytes.indexOf("🎉", "utf8");
    expect(emojiOffset).toBeGreaterThan(0);

    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_utf8" });
    pipeline.feedStdout(bytes.subarray(0, emojiOffset + 2));
    pipeline.feedStdout(bytes.subarray(emojiOffset + 2));
    const result = pipeline.finalize();

    expect(result.protocolErrors).toEqual([]);
    const delta = result.events.find((event) => event.type === "message_delta");
    expect(delta).toBeDefined();
    expect(delta?.payload["text"]).toBe(text);
  });

  test("skips empty and whitespace-only lines", () => {
    const pipeline = pipeAll(["", "   ", "\t", claudeLine("system", { subtype: "init" }), ""]);
    expect(pipeline.finalize().events).toHaveLength(1);
    expect(pipeline.finalize().stats.emptyLinesSkipped).toBe(4);
  });

  test("tolerates CRLF line endings", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_crlf" });
    pipeline.feedStdout(`${claudeLine("system", { subtype: "init" })}\r\n${claudeLine("error", { message: "x" })}\r\n`);
    const result = pipeline.finalize();
    expect(result.protocolErrors).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual(["started", "error"]);
  });

  test("ignores a UTF-8 BOM at stream start", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_bom" });
    pipeline.feedStdout(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${claudeLine("error", { message: "x" })}\n`, "utf8")]));
    const result = pipeline.finalize();
    expect(result.protocolErrors).toEqual([]);
    expect(result.events).toHaveLength(1);
  });

  test("a trailing complete JSON object without newline is accepted", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_tail" });
    pipeline.feedStdout(claudeLine("error", { message: "x" }));
    const result = pipeline.finalize();
    expect(result.protocolErrors).toEqual([]);
    expect(result.events).toHaveLength(1);
  });

  test("a trailing broken JSON line is an explicit truncation protocol error", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_trunc" });
    pipeline.feedStdout(`${claudeLine("error", { message: "x" })}\n{"type":"res`);
    const result = pipeline.finalize();
    expect(result.protocolErrors).toHaveLength(1);
    expect(result.protocolErrors[0]?.kind).toBe("unterminated-json");
  });

  test("mid-stream broken JSON is recorded and parsing continues", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_mid" });
    pipeline.feedStdout(`not json at all\n${claudeLine("error", { message: "x" })}\n`);
    const result = pipeline.finalize();
    expect(result.protocolErrors).toHaveLength(1);
    expect(result.protocolErrors[0]?.kind).toBe("unparseable-json");
    expect(result.events).toHaveLength(1);
  });

  test("over-long lines fail the stream closed (defined rejection policy)", () => {
    const pipeline = new EventStreamPipeline({
      dialect: "claude",
      executionId: "exec_limit",
      limits: { maxLineBytes: 32, maxTotalBytes: DEFAULT_STREAM_LIMITS.maxTotalBytes }
    });
    pipeline.feedStdout(`${"x".repeat(64)}\n${claudeLine("error", { message: "after" })}\n`);
    const result = pipeline.finalize();
    expect(result.protocolErrors).toHaveLength(1);
    expect(result.protocolErrors[0]?.kind).toBe("line-limit-exceeded");
    expect(result.events).toHaveLength(0);

    // Fail-closed: the outcome can never be success even with exit 0.
    const verdict = evaluateOutcome(result, { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toContain("protocol-error");
  });

  test("total stream size limit is enforced", () => {
    const pipeline = newPipeline("exec_total", {
      maxLineBytes: DEFAULT_STREAM_LIMITS.maxLineBytes,
      maxTotalBytes: 64
    });
    for (let i = 0; i < 10; i++) {
      const filler = JSON.stringify({ type: "error", message: `filler line ${i}`, synthetic: true });
      pipeline.feedStdout(`${filler}\n`);
    }
    const result = pipeline.finalize();
    expect(result.protocolErrors).toHaveLength(1);
    expect(result.protocolErrors[0]?.kind).toBe("total-limit-exceeded");
  });

  test("mixed stderr is captured but never parsed as protocol events", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_stderr" });
    pipeline.feedStdout(claudeLine("error", { message: "x" }) + "\n");
    pipeline.feedStderr('{"type":"result","subtype":"success","is_error":false}\n');
    pipeline.feedStderr("SYNTHETIC EVENT STREAM noise\n");
    const result = pipeline.finalize();

    // The fake "result" line on stderr produced no protocol event at all.
    expect(result.events.map((event) => event.type)).toEqual(["error"]);
    expect(result.stderrText).toContain("SYNTHETIC EVENT STREAM noise");
    expect(result.stderrText).toContain('"type":"result"');
    expect(result.stats.stderrBytes).toBeGreaterThan(0);

    // And it cannot fake a success either.
    const verdict = evaluateOutcome(result, { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["missing-final-result"]);
  });

  test("splitter ignores input after a limit failure (fail-closed)", () => {
    const seen: string[] = [];
    const splitter = new JsonlByteLineSplitter({ maxLineBytes: 8, maxTotalBytes: 1000 }, (line) => {
      seen.push(line);
    }, () => {});
    splitter.feed("short\n");
    splitter.feed("this line is far too long for the limit\n");
    splitter.feed("short again\n");
    expect(splitter.failed).toBe(true);
    expect(seen).toEqual(["short"]);
  });
});
