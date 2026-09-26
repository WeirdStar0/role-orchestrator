/**
 * Pregenerated fixtures must stay in sync with the engine: every registered
 * spec renders byte-for-byte to its committed file, and manifest.json mirrors
 * the registry. This keeps fixtures and runtime output from drifting apart.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildScenarioFrames, framesToFixtureText, listFixtureSpecs } from "../src/scenarios.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(packageDir, "fixtures");

describe("pregenerated fixtures", () => {
  test("fixture files exist and match the engine output byte-for-byte", () => {
    for (const spec of listFixtureSpecs()) {
      const file = path.join(fixturesDir, spec.file);
      expect(existsSync(file), `missing fixture: ${spec.file}`).toBe(true);
      const expected = framesToFixtureText(
        buildScenarioFrames({
          dialect: spec.dialect,
          scenario: spec.scenario,
          variant: spec.variant === null ? undefined : spec.variant,
          delayMs: 0
        })
      );
      expect(readFileSync(file, "utf8"), `content drift in ${spec.file}`).toBe(expected);
    }
  });

  test("manifest.json mirrors the fixture registry", () => {
    const manifest = JSON.parse(readFileSync(path.join(fixturesDir, "manifest.json"), "utf8")) as {
      synthetic: unknown;
      fixtures: unknown;
    };
    expect(manifest.synthetic).toBe(true);
    expect(manifest.fixtures).toEqual(listFixtureSpecs());
  });

  test("every .jsonl sample carries the .synthetic.jsonl suffix", () => {
    const files = readdirSync(fixturesDir).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(name.endsWith(".synthetic.jsonl"), `bad sample name: ${name}`).toBe(true);
    }
  });

  test("every fixture line is valid JSON carrying the synthetic marker", () => {
    for (const spec of listFixtureSpecs()) {
      const text = readFileSync(path.join(fixturesDir, spec.file), "utf8");
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      // The truncated fixture's final line is deliberately invalid JSON.
      const parseable = spec.scenario === "truncated" ? lines.slice(0, -1) : lines;
      expect(parseable.length, spec.file).toBeGreaterThan(0);
      for (const line of parseable) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed["synthetic"], spec.file).toBe(true);
      }
    }
  });
});
