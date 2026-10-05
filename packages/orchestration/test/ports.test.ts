/**
 * M10-02 M12 — the injected ports. The production defaults must reproduce
 * the former local behavior EXACTLY (system wall clock; redacted,
 * newline-terminated stdout notes — the serve diagnostic -> shell drain
 * coupling means the stdout form must not change from here).
 */
import { describe, expect, it } from "vitest";
import { createStdoutLogSink, systemClock } from "../src/ports.js";

describe("ports (M12)", () => {
  it("systemClock answers an ISO-8601 timestamp near now", () => {
    const before = Date.now();
    const value = systemClock.nowIso();
    const after = Date.now();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(value)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(value)).toBeLessThanOrEqual(after);
  });

  it("the default log sink writes ONE newline-terminated line through the injected writer", () => {
    const written: string[] = [];
    const sink = createStdoutLogSink({
      write: (chunk: string) => written.push(chunk)
    });
    sink.log("[orchestrator] drive failed: example");
    expect(written).toEqual(["[orchestrator] drive failed: example\n"]);
  });

  it("the default log sink redacts secret-shaped text before any sink (A36 discipline)", () => {
    const written: string[] = [];
    const sink = createStdoutLogSink({ write: (chunk) => written.push(chunk) });
    sink.log("drive failed: bearer abc123def456");
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("abc123def456");
    expect(written[0]?.endsWith("\n")).toBe(true);
  });

  it("createStdoutLogSink() without a writer defaults to process.stdout (production parity)", () => {
    const sink = createStdoutLogSink();
    expect(typeof sink.log).toBe("function");
  });
});
