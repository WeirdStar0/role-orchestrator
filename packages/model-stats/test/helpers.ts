import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageEvent } from "../src/index.js";

/** Synthetic UsageEvent factory — every field explicit, cost always unknown. */
export function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelId: "test-model",
    durationMs: null,
    costUsd: "unknown",
    ...overrides
  };
}

/**
 * Real M8-01 controlled-window captures, referenced READ-ONLY from
 * packages/cli-events (sanitized verbatim CLI output; see PROPOSALS.md
 * 2026-09-28 disclosure). Missing files fail loudly — never skip.
 */
const realFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "cli-events",
  "fixtures-real",
  "m8-01-2026-09-28"
);

export function realFixturePath(fileName: string): string {
  const full = path.join(realFixturesDir, fileName);
  if (!existsSync(full)) {
    throw new Error(`real M8-01 fixture missing (read-only cross-package reference): ${full}`);
  }
  return full;
}

export function readRealFixture(fileName: string): Promise<string> {
  return readFile(realFixturePath(fileName), "utf8");
}

/**
 * Real M8-01 SUPPLEMENTARY window captures (M8-01 补窗口; sanitized verbatim
 * CLI output, stored in this package's fixtures-real/). These are the seven
 * files the M8-04 BudgetRefinement full-chain contract test runs on.
 * Missing files fail loudly — never skip.
 */
export const SUPPLEMENT_FIXTURE_FILES = [
  "s1-claude-tool.jsonl",
  "s2-codex-tool.jsonl",
  "s3-claude-turn1.jsonl",
  "s3-claude-turn2.jsonl",
  "u1-claude-stream.jsonl",
  "u2-codex-stream.jsonl",
  "u3-claude-stream.jsonl"
] as const;

const supplementFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures-real"
);

export function supplementFixturePath(fileName: string): string {
  const full = path.join(supplementFixturesDir, fileName);
  if (!existsSync(full)) {
    throw new Error(`real M8-01 supplementary fixture missing: ${full}`);
  }
  return full;
}

export function readSupplementFixture(fileName: string): Promise<string> {
  return readFile(supplementFixturePath(fileName), "utf8");
}
