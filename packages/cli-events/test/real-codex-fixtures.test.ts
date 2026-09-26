/**
 * Contract tests over REAL codex CLI captures (fixtures-real/codex, manifest
 * marked real / synthetic:false).
 *
 * These fixtures are sanitized verbatim captures of codex-cli 0.154.0
 * `codex exec --json` output recorded for M0-04 (see
 * reports/M0-04-codex-capability.md for the full call ledger). They pin the
 * real protocol shapes the normalizer must handle additively on top of the
 * synthetic dialect:
 * - real success path: thread.started / turn.started / item.completed
 *   (agent_message) / turn.completed with usage ONLY (no business payload),
 *   so a real trivial run is fail-closed as business-schema-invalid;
 * - default-mode permission behavior: command_execution items execute real
 *   workspace writes with NO approval events;
 * - resume: `codex exec resume <id>` repeats the SAME thread_id;
 * - model mismatch: item lines typed "error" plus top-level error plus
 *   turn.failed, exit 1.
 *
 * The sanitization guard re-checks on every test run that no Windows
 * username or runtime thread id ever enters the repository.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EventStreamPipeline, evaluateOutcome, type StreamResult } from "../src/index.js";
import { splitBuffer } from "./helpers.js";

const realFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures-real",
  "codex"
);

interface RealCodexFixtureEntry {
  readonly file: string;
  readonly dialect: "codex";
  readonly scenario: string;
  readonly capturedAt: string;
  readonly argv: readonly string[];
  readonly promptViaStdin: string;
  readonly modelRequested: string | null;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stderr: string;
  readonly behaviorNote?: string;
  readonly expected: {
    readonly protocolErrorKinds: readonly string[];
    readonly eventTypes: readonly string[];
    readonly outcome: { readonly success: boolean; readonly failureReasons: readonly string[] };
    readonly finalResult: {
      readonly sourceType: string;
      readonly subtype: string;
      readonly isError: boolean;
    };
  };
}

interface RealCodexManifest {
  readonly real: boolean;
  readonly synthetic: boolean;
  readonly cli: { readonly name: string; readonly version: string; readonly versionOutput: string };
  readonly environmentGate: { readonly observation: string; readonly exitCode: number };
  readonly sanitization: readonly string[];
  readonly fixtures: readonly RealCodexFixtureEntry[];
}

const manifest = JSON.parse(
  readFileSync(path.join(realFixturesDir, "manifest.json"), "utf8")
) as RealCodexManifest;

function parseFixture(entry: RealCodexFixtureEntry, source: Buffer): StreamResult {
  const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_real_codex_fixture" });
  pipeline.feedStdout(source);
  return pipeline.finalize();
}

function readFixture(name: string): Buffer {
  const entry = manifest.fixtures.find((candidate) => candidate.file === name);
  expect(entry, `fixture ${name} listed in manifest`).toBeDefined();
  return readFileSync(path.join(realFixturesDir, name));
}

describe("real codex fixtures (M0-04 captures)", () => {
  test("manifest is marked real, not synthetic, and records codex-cli 0.154.0", () => {
    expect(manifest.real).toBe(true);
    expect(manifest.synthetic).toBe(false);
    expect(manifest.cli.name).toBe("codex");
    expect(manifest.cli.version).toBe("0.154.0");
    expect(manifest.cli.versionOutput).toContain("0.154.0");
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(5);
    expect(manifest.environmentGate.exitCode).toBe(1);
    expect(manifest.sanitization.length).toBeGreaterThanOrEqual(3);
  });

  test("sanitization guard: no username, thread id or uuid shape in any fixture", () => {
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
      const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_real_codex_chunked" });
      for (const chunk of splitBuffer(source, 91)) {
        pipeline.feedStdout(chunk);
      }
      const result = pipeline.finalize();
      expect(result.protocolErrors.map((error) => error.kind)).toEqual([...entry.expected.protocolErrorKinds]);
      expect(result.events.map((event) => event.type)).toEqual([...entry.expected.eventTypes]);
      const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
      expect([...verdict.reasons]).toEqual([...entry.expected.outcome.failureReasons]);
    });
  }

  test("trivial-success: real CLI exit 0 is still fail-closed as business-schema-invalid", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "trivial-success");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const result = parseFixture(entry, readFixture(entry.file));

    const started = result.events.find((event) => event.type === "started");
    expect(started?.sourceType).toBe("thread.started");
    expect(String(started?.payload["threadId"])).toMatch(/^<redacted-\d+>$/);

    // Real usage shape is preserved verbatim on usage_reported (differs from
    // the synthetic approximation by cache_write_input_tokens and
    // reasoning_output_tokens).
    const usage = result.events.find((event) => event.type === "usage_reported");
    const usagePayload = usage?.payload["usage"] as Record<string, unknown>;
    expect(usagePayload["input_tokens"]).toBe(24895);
    expect(usagePayload["cache_write_input_tokens"]).toBe(0);
    expect(usagePayload["reasoning_output_tokens"]).toBe(0);

    // The trap pinned for the adapter: turn.completed is a non-error final
    // result WITHOUT any business payload -> fail-closed business verdict
    // even though the real CLI exited 0.
    const finalResult = result.events.find((event) => event.type === "result_reported");
    expect(finalResult?.payload["isError"]).toBe(false);
    expect(finalResult?.payload["businessResult"]).toBeUndefined();
    const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["business-schema-invalid"]);
  });

  test("permission-probe: default mode executes the workspace write with NO approval events (A19 direction)", () => {
    const entry = manifest.fixtures.find(
      (candidate) => candidate.scenario === "permission-probe-write-executed"
    );
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_real_codex_fixture" });
    // The real run wrote an internal CLI ERROR line to stderr while stdout
    // carried the protocol stream; replay both through their real ports.
    pipeline.feedStdout(readFixture(entry.file));
    pipeline.feedStderr(entry.stderr);
    const result = pipeline.finalize();

    // No interactive approval channel ever appeared in the exec stream.
    expect(result.events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(result.events.some((event) => event.type === "permission_denied")).toBe(false);

    const toolStarted = result.events.find((event) => event.type === "tool_started");
    expect(toolStarted?.sourceType).toBe("item.started");
    expect(toolStarted?.payload["tool"]).toBe("command_execution");

    const toolCompleted = result.events.find((event) => event.type === "tool_completed");
    expect(toolCompleted?.sourceType).toBe("item.completed");
    expect(toolCompleted?.payload["exitCode"]).toBe(0);
    expect(toolCompleted?.payload["isError"]).toBe(false);
    // behaviorNote records the live disk check: the file was really created.
    expect(entry.behaviorNote ?? "").toContain("WAS CREATED");
    // The stderr line is captured on the diagnostic side-channel and never
    // leaks into the normalized protocol stream.
    expect(result.stderrText).toContain("codex_memories_write::phase2");
    expect(
      result.events.some((event) => JSON.stringify(event.payload).includes("codex_memories_write"))
    ).toBe(false);
  });

  test("resume-session: same thread id placeholder as the base session fixture (equality preserved by sanitization)", () => {
    const resumeEntry = manifest.fixtures.find((candidate) => candidate.scenario === "resume-session");
    const baseEntry = manifest.fixtures.find((candidate) => candidate.scenario === "trivial-success");
    expect(resumeEntry).toBeDefined();
    expect(baseEntry).toBeDefined();
    if (resumeEntry === undefined || baseEntry === undefined) return;

    // argv shape: codex exec resume <SESSION_ID> --json -
    expect(resumeEntry.argv.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(resumeEntry.argv[3]).toMatch(/^<redacted-\d+>$/);

    const resumeResult = parseFixture(resumeEntry, readFixture(resumeEntry.file));
    const baseResult = parseFixture(baseEntry, readFixture(baseEntry.file));
    const resumeThreadId = resumeResult.events.find((event) => event.type === "started")?.payload["threadId"];
    const baseThreadId = baseResult.events.find((event) => event.type === "started")?.payload["threadId"];
    // Real behavior: the resumed run reports the SAME thread id (verified
    // live before redaction; the shared placeholder keeps that evidence).
    expect(resumeThreadId).toBe(baseThreadId);
    expect(String(resumeThreadId)).toMatch(/^<redacted-\d+>$/);

    // Objective continuity evidence recorded in the manifest: resumed-turn
    // input tokens ~= twice the fresh trivial baseline (history replay).
    const usage = resumeResult.events.find((event) => event.type === "usage_reported");
    const usagePayload = usage?.payload["usage"] as Record<string, unknown>;
    expect(usagePayload["input_tokens"]).toBe(49807);
  });

  test("invalid-model: item-level error lines surface as error events, turn.failed fails the verdict", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "invalid-model-turn-failed");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.argv).toContain("definitely-not-a-real-model-xyz");
    const result = parseFixture(entry, readFixture(entry.file));

    // Real shape: TWO item-level error lines + ONE top-level error line.
    const itemErrors = result.events.filter(
      (event) => event.type === "error" && event.sourceType === "item.completed"
    );
    expect(itemErrors.length).toBe(2);
    expect(String(itemErrors[0]?.payload["message"])).toContain(
      "Model metadata for `definitely-not-a-real-model-xyz` not found"
    );
    expect(itemErrors[0]?.payload["itemId"]).toBe("item_0");
    expect(String(itemErrors[1]?.payload["message"])).toContain("Skill descriptions were shortened");

    const topError = result.events.find(
      (event) => event.type === "error" && event.sourceType === "error"
    );
    expect(String(topError?.payload["message"])).toContain(
      "not supported when using Codex with a ChatGPT account"
    );

    // Order pin: turn.started (diagnostic) arrives AFTER the first item
    // error line in the real stream — the parser must not assume order.
    expect(result.events[2]?.type).toBe("diagnostic");

    const finalResult = result.events.find((event) => event.type === "result_reported");
    expect(finalResult?.sourceType).toBe("turn.failed");
    expect(finalResult?.payload["subtype"]).toBe("failed");
    expect(finalResult?.payload["isError"]).toBe(true);
    // No usage event is emitted on the failed turn.
    expect(result.events.some((event) => event.type === "usage_reported")).toBe(false);

    const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["nonzero-exit", "final-result-error"]);
  });

  test("valid-model: -m gpt-6-astra accepted, turn shape identical to the default-model baseline", () => {
    const entry = manifest.fixtures.find((candidate) => candidate.scenario === "valid-model-success");
    const baseEntry = manifest.fixtures.find((candidate) => candidate.scenario === "trivial-success");
    expect(entry).toBeDefined();
    expect(baseEntry).toBeDefined();
    if (entry === undefined || baseEntry === undefined) return;
    expect(entry.argv).toContain("gpt-6-astra");
    expect(entry.modelRequested).toBe("gpt-6-astra");

    const result = parseFixture(entry, readFixture(entry.file));
    const baseResult = parseFixture(baseEntry, readFixture(baseEntry.file));
    expect(result.events.map((event) => event.type)).toEqual(baseResult.events.map((event) => event.type));

    const delta = result.events.find((event) => event.type === "message_delta");
    expect(delta?.payload["text"]).toBe("OK");
    const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["business-schema-invalid"]);
  });
});
