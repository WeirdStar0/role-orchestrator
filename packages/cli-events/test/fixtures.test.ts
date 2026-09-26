/**
 * Fixture-driven contract tests over the pregenerated .synthetic.jsonl
 * samples: A05 (chunked/UTF-8/truncated streams parse or fail explicitly,
 * never misreport success) and A06 (exit 0 with an error or missing final
 * result is not a business success).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { EventStreamPipeline, evaluateOutcome } from "../src/index.js";
import { fakeCliFixturesDir, splitBuffer } from "./helpers.js";

interface FixtureEntry {
  readonly file: string;
  readonly dialect: "claude" | "codex";
  readonly scenario: string;
  readonly variant: string | null;
  readonly exitCode: number;
  readonly expected: { readonly success: boolean; readonly failureReasons: readonly string[] };
}

interface FixtureManifest {
  readonly synthetic: boolean;
  readonly fixtures: readonly FixtureEntry[];
}

const manifest = JSON.parse(
  readFileSync(path.join(fakeCliFixturesDir, "manifest.json"), "utf8")
) as FixtureManifest;

function parseFixture(entry: FixtureEntry, source: Buffer): ReturnType<EventStreamPipeline["finalize"]> {
  const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_fixture" });
  pipeline.feedStdout(source);
  return pipeline.finalize();
}

describe("pregenerated synthetic fixtures", () => {
  test("manifest is marked synthetic and covers both dialects", () => {
    expect(manifest.synthetic).toBe(true);
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(12);
    for (const dialect of ["claude", "codex"] as const) {
      expect(manifest.fixtures.some((entry) => entry.dialect === dialect)).toBe(true);
    }
  });

  for (const entry of manifest.fixtures) {
    test(`${entry.file}: verdict matches the manifest (${entry.scenario}${entry.variant === null ? "" : `/${entry.variant}`})`, () => {
      const source = readFileSync(path.join(fakeCliFixturesDir, entry.file));
      const result = parseFixture(entry, source);
      const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
      expect(verdict.success).toBe(entry.expected.success);
      expect([...verdict.reasons]).toEqual([...entry.expected.failureReasons]);
    });

    for (const seed of [3, 77, 20260921]) {
      test(`${entry.file}: identical verdict under random byte chunking (seed ${seed}) (A05)`, () => {
        const source = readFileSync(path.join(fakeCliFixturesDir, entry.file));
        const pipeline = new EventStreamPipeline({ dialect: entry.dialect, executionId: "exec_fixture" });
        for (const chunk of splitBuffer(source, seed)) {
          pipeline.feedStdout(chunk);
        }
        const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: entry.exitCode });
        expect(verdict.success).toBe(entry.expected.success);
        expect([...verdict.reasons]).toEqual([...entry.expected.failureReasons]);
      });
    }
  }

  test("A05: the truncated fixtures explicitly fail and never report success", () => {
    for (const dialect of ["claude", "codex"] as const) {
      const entry = manifest.fixtures.find(
        (candidate) => candidate.dialect === dialect && candidate.scenario === "truncated"
      );
      expect(entry, `truncated fixture for ${dialect}`).toBeDefined();
      if (entry === undefined) continue;
      const result = parseFixture(entry, readFileSync(path.join(fakeCliFixturesDir, entry.file)));
      expect(result.protocolErrors.map((error) => error.kind)).toContain("unterminated-json");
      const verdict = evaluateOutcome(result, { exitCode: entry.exitCode });
      expect(verdict.success).toBe(false);
      expect(verdict.reasons).toContain("protocol-error");
    }
  });

  test("A06: fake-success fixtures keep exit 0 but never judge business success", () => {
    const fakeSuccess = manifest.fixtures.filter((entry) => entry.scenario === "fake-success");
    expect(fakeSuccess.length).toBeGreaterThanOrEqual(6);
    for (const entry of fakeSuccess) {
      expect(entry.exitCode, entry.file).toBe(0);
      const result = parseFixture(entry, readFileSync(path.join(fakeCliFixturesDir, entry.file)));
      const verdict = evaluateOutcome(result, { exitCode: 0 });
      expect(verdict.success, entry.file).toBe(false);
      expect(verdict.reasons.length, entry.file).toBeGreaterThan(0);
    }
  });

  test("every fixture line carries the synthetic marker (truncated tail excepted)", () => {
    const files = readdirSync(fakeCliFixturesDir).filter((name) => name.endsWith(".synthetic.jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const name of files) {
      const lines = readFileSync(path.join(fakeCliFixturesDir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      const parseable = name.includes("-truncated.") ? lines.slice(0, -1) : lines;
      for (const line of parseable) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed["synthetic"], `${name}: ${line.slice(0, 60)}`).toBe(true);
      }
    }
  });

  test("cross-dialect parsing fails closed instead of hallucinating success", () => {
    const codexSuccess = manifest.fixtures.find(
      (entry) => entry.dialect === "codex" && entry.scenario === "success"
    );
    expect(codexSuccess).toBeDefined();
    if (codexSuccess === undefined) return;
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_cross" });
    pipeline.feedStdout(readFileSync(path.join(fakeCliFixturesDir, codexSuccess.file)));
    const result = pipeline.finalize();
    // Every codex line is foreign to the claude mapping -> diagnostics only.
    expect(result.events.every((event) => event.type === "diagnostic")).toBe(true);
    const verdict = evaluateOutcome(result, { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toContain("missing-final-result");
  });
});
