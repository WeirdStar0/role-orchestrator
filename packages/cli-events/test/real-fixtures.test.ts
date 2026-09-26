/**
 * Contract tests over REAL claude CLI captures (fixtures-real/claude,
 * manifest marked real/synthetic:false).
 *
 * These fixtures are sanitized verbatim captures of claude 2.1.278
 * stream-json output recorded for M0-03 (see reports/M0-03-claude-capability
 * for the run log). They pin the real protocol shapes the normalizer must
 * handle additively on top of the synthetic dialect:
 * - system subtypes hook_started / hook_response / api_retry -> diagnostics;
 * - init enrichment (claudeCodeVersion, permissionMode, apiKeySource, counts);
 * - assistant API-error placeholder messages (`is_api_error_message`);
 * - result lines with subtype "success" BUT is_error true on API failure.
 *
 * The sanitization guard re-checks on every test run that no Windows
 * username, session id or uuid shape ever enters the repository.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EventStreamPipeline, evaluateOutcome } from "../src/index.js";
import { splitBuffer } from "./helpers.js";

const realFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures-real",
  "claude"
);

interface RealFixtureEntry {
  readonly file: string;
  readonly dialect: "claude" | "codex";
  readonly scenario: string;
  readonly argv: readonly string[];
  readonly stderr?: string;
  readonly behaviorNote?: string;
  readonly exitCode: number;
  readonly expected: {
    readonly protocolErrorKinds: readonly string[];
    readonly eventTypes: readonly string[];
    readonly outcome: { readonly success: boolean; readonly failureReasons: readonly string[] };
    readonly finalResult: {
      readonly sourceType: string;
      readonly subtype: string;
      readonly isError: boolean;
      readonly terminalReason: string;
      readonly apiErrorStatus: number;
    };
  };
}

interface RealManifest {
  readonly real: boolean;
  readonly synthetic: boolean;
  readonly cli: { readonly name: string; readonly version: string; readonly versionOutput: string };
  readonly sanitization: readonly string[];
  readonly fixtures: readonly RealFixtureEntry[];
}

const manifest = JSON.parse(
  readFileSync(path.join(realFixturesDir, "manifest.json"), "utf8")
) as RealManifest;

function parseFixture(entry: RealFixtureEntry, source: Buffer) {
  const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_real_fixture" });
  pipeline.feedStdout(source);
  return pipeline.finalize();
}

describe("real claude fixtures (M0-03 captures)", () => {
  test("manifest is marked real, not synthetic, and records CLI 2.1.278", () => {
    expect(manifest.real).toBe(true);
    expect(manifest.synthetic).toBe(false);
    expect(manifest.cli.name).toBe("claude");
    expect(manifest.cli.version).toBe("2.1.278");
    expect(manifest.cli.versionOutput).toContain("2.1.278");
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(2);
    expect(manifest.sanitization.length).toBeGreaterThanOrEqual(3);
  });

  test("sanitization guard: no username, session id or uuid shape in any fixture", () => {
    for (const entry of manifest.fixtures) {
      const text = readFileSync(path.join(realFixturesDir, entry.file), "utf8");
      expect(text.match(/[Uu]sers[\\/]+star/), `${entry.file}: path username`).toBeNull();
      expect(text.match(/[Uu]sers-star/), `${entry.file}: slug username`).toBeNull();
      expect(
        text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/),
        `${entry.file}: uuid-shaped identifier`
      ).toBeNull();
      expect(
        text.match(/<redacted(-\d+)?>/),
        `${entry.file}: redaction marker present`
      ).not.toBeNull();
    }
  });

  for (const entry of manifest.fixtures) {
    test(`${entry.file}: event sequence and outcome match the manifest`, () => {
      const result = parseFixture(entry, readFileSync(path.join(realFixturesDir, entry.file)));
      expect(result.protocolErrors.map((error) => error.kind)).toEqual([...entry.expected.protocolErrorKinds]);
      expect(result.events.map((event) => event.type)).toEqual([...entry.expected.eventTypes]);
      const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
      expect(verdict.success).toBe(entry.expected.outcome.success);
      expect([...verdict.reasons]).toEqual([...entry.expected.outcome.failureReasons]);
    });

    test(`${entry.file}: identical verdict and sequence under random byte chunking (A05)`, () => {
      const source = readFileSync(path.join(realFixturesDir, entry.file));
      const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_real_chunked" });
      for (const chunk of splitBuffer(source, 77)) {
        pipeline.feedStdout(chunk);
      }
      const result = pipeline.finalize();
      expect(result.protocolErrors.map((error) => error.kind)).toEqual([...entry.expected.protocolErrorKinds]);
      expect(result.events.map((event) => event.type)).toEqual([...entry.expected.eventTypes]);
      const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
      expect([...verdict.reasons]).toEqual([...entry.expected.outcome.failureReasons]);
    });
  }

  test("api-error-429: retries surface as diagnostics, verdict keys on is_error not subtype (A06 direction)", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "api-error-429");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const result = parseFixture(entry, readFileSync(path.join(realFixturesDir, entry.file)));

    const started = result.events.find((event) => event.type === "started");
    expect(started?.sourceType).toBe("system");
    expect(String(started?.payload["sessionId"])).toMatch(/^<redacted(-\d+)?>$/);
    expect(started?.payload["claudeCodeVersion"]).toBe("2.1.278");
    expect(started?.payload["permissionMode"]).toBe("default");

    const retries = result.events.filter(
      (event) => event.type === "diagnostic" && event.payload["reason"] === "api-retry"
    );
    expect(retries.length).toBe(10);
    expect(retries[0]?.payload["errorStatus"]).toBe(429);
    expect(retries[0]?.payload["maxRetries"]).toBe(10);

    const hookDiagnostics = result.events.filter(
      (event) =>
        event.type === "diagnostic" &&
        (event.payload["reason"] === "hook-started" || event.payload["reason"] === "hook-response")
    );
    expect(hookDiagnostics.length).toBe(4);

    const delta = result.events.find((event) => event.type === "message_delta");
    expect(delta?.payload["apiError"]).toBe(true);
    expect(String(delta?.payload["text"])).toContain("API Error");

    const finalResult = result.events.find((event) => event.type === "result_reported");
    expect(finalResult?.payload["subtype"]).toBe("success"); // real CLI trap
    expect(finalResult?.payload["isError"]).toBe(true);
    expect(finalResult?.payload["terminalReason"]).toBe("api_error");
    expect(finalResult?.payload["apiErrorStatus"]).toBe(429);
    expect(String(finalResult?.payload["resultText"])).toContain("API Error");

    const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toContain("final-result-error");
  });

  test("invalid-model-400: -m is echoed verbatim, unrecognized warning does not stop init", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "invalid-model-400");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const result = parseFixture(entry, readFileSync(path.join(realFixturesDir, entry.file)));

    const started = result.events.find((event) => event.type === "started");
    expect(started?.payload["model"]).toBe("definitely-not-a-real-model-xyz");
    expect(started?.payload["apiKeySource"]).toBe("none");
    expect(typeof started?.payload["toolCount"]).toBe("number");
    expect(typeof started?.payload["mcpServerCount"]).toBe("number");
    // The fixture truncates init.tools to 3 entries + a marker, so the
    // normalized count reflects the sanitized stream (4), while the real
    // inventory size (44) is recorded as manifest metadata only.
    expect(started?.payload["toolCount"]).toBe(4);

    // No api_retry lines on an immediate 400: the CLI does not retry 4xx.
    expect(
      result.events.some((event) => event.payload["reason"] === "api-retry")
    ).toBe(false);

    const finalResult = result.events.find((event) => event.type === "result_reported");
    expect(finalResult?.payload["apiErrorStatus"]).toBe(400);
    expect(finalResult?.payload["isError"]).toBe(true);
    const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
    expect([...verdict.reasons]).toEqual(["nonzero-exit", "final-result-error"]);
  });

  test("resume-session-429: --resume accepted, init carries the resumed session's id placeholder", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "resume-session-429");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.argv).toContain("--resume");
    expect(entry.behaviorNote).toContain("equals the resumed session's id");
    const result = parseFixture(entry, readFileSync(path.join(realFixturesDir, entry.file)));
    const started = result.events.find((event) => event.type === "started");
    expect(String(started?.payload["sessionId"])).toMatch(/^<redacted-\d+>$/);
    const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
    expect(verdict.success).toBe(false);
  });

  test("valid-model-echo-429: requested model echoed in init, no unrecognized-model warning", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "valid-model-echo-429");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.stderr).toBe("");
    const result = parseFixture(entry, readFileSync(path.join(realFixturesDir, entry.file)));
    const started = result.events.find((event) => event.type === "started");
    expect(started?.payload["model"]).toBe("claude-opus-5[1m]");
  });

  test("permission-probe-429: no tool call, no denials recorded, default permissionMode (behavior unobserved)", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "permission-probe-429");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const result = parseFixture(entry, readFileSync(path.join(realFixturesDir, entry.file)));
    // The model never got a turn under the rate limit: no tool activity at all.
    expect(result.events.some((event) => event.type === "tool_started")).toBe(false);
    expect(result.events.some((event) => event.type === "tool_completed")).toBe(false);
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(false);
    const started = result.events.find((event) => event.type === "started");
    expect(started?.payload["permissionMode"]).toBe("default");
    const finalResult = result.events.find((event) => event.type === "result_reported");
    expect(finalResult?.payload["permissionDenials"]).toEqual([]);
  });
});
