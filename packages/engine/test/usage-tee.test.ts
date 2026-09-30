/**
 * M8-04 usage tee — the statistics sidecar on persistDrainedEvents, pinned
 * hermetically (no CLI is ever spawned):
 *
 * 1. The tee consumes ONLY the just-stored, already-redacted payloads and
 *    re-emits them as extractor-ready lines under the preserved source type;
 *    with the real model-stats sink attached, the seven real M8-01
 *    supplementary-window captures flow engine → sink → PerformanceStore →
 *    report() with the exact captured token numbers.
 * 2. Fail-open: a sink whose store throws changes NOTHING about the persist
 *    semantics (return batch, stored rows, checksums) and costs exactly one
 *    stderr diagnostic line.
 * 3. Default arguments (no sink) are byte-for-byte the pre-tee behavior —
 *    pinned here field-by-field against a sink-less run on an identical DB,
 *    and by the untouched pre-existing engine suite passing unchanged.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, NormalizedEvent } from "@role-orchestrator/contracts";
import {
  createActiveAttempt,
  getEvent,
  listEventsForExecution,
  verifyEventChecksums
} from "@role-orchestrator/store";
import { createUsageSink, PerformanceStore } from "@role-orchestrator/model-stats";
import { createSeededDb, seedFakeRun } from "./helpers.js";
import { persistDrainedEvents, type UsageTeeSink } from "../src/index.js";

const T0 = "2026-09-22T00:00:00.000Z";

/** Real M8-01 supplementary-window captures (read-only cross-package reference). */
const SUPPLEMENT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "model-stats",
  "fixtures-real"
);

const CLAUDE_FIXTURES = [
  "s1-claude-tool.jsonl",
  "s3-claude-turn1.jsonl",
  "s3-claude-turn2.jsonl",
  "u1-claude-stream.jsonl",
  "u3-claude-stream.jsonl"
] as const;
const CODEX_FIXTURES = ["s2-codex-tool.jsonl", "u2-codex-stream.jsonl"] as const;

async function readFixture(fileName: string): Promise<string> {
  return readFile(path.join(SUPPLEMENT_DIR, fileName), "utf8");
}

/** The raw usage object the real capture's usage-bearing line carried. */
async function realUsage(
  fileName: string
): Promise<{ sourceType: string; usage: Record<string, JsonValue> }> {
  const text = await readFixture(fileName);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    // Same tolerance as the extractors: the real s2 capture contains one
    // genuinely malformed line (8) — skipped, never fatal here.
    let raw: { type?: string; usage?: unknown };
    try {
      raw = JSON.parse(line) as { type?: string; usage?: unknown };
    } catch {
      continue;
    }
    if (raw.type === "result" || raw.type === "turn.completed") {
      if (typeof raw.usage === "object" && raw.usage !== null && !Array.isArray(raw.usage)) {
        return { sourceType: raw.type, usage: raw.usage as Record<string, JsonValue> };
      }
    }
  }
  throw new Error(`fixture ${fileName} carries no usage line`);
}

/** Mimics the real pipeline's usage_reported shape: verbatim usage payload. */
function usageReportedEvent(
  executionId: string,
  seq: number,
  sourceType: string,
  usage: Record<string, JsonValue>
): NormalizedEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${executionId}-${String(seq).padStart(3, "0")}`,
    executionId,
    seq,
    type: "usage_reported",
    sourceType,
    occurredAt: T0,
    payload: { usage }
  };
}

async function seedExecutionRow(db: DatabaseSync, executionId: string): Promise<void> {
  await seedFakeRun(db, {});
  createActiveAttempt(db, {
    id: executionId,
    runId: "run-1",
    nodeId: "node-1",
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: `dt-${executionId}`,
    phase: "RUNNING",
    sessionId: null,
    now: T0
  });
}

describe("M8-04 usage tee: engine → sink → PerformanceStore (real fixtures, hermetic)", () => {
  test("seven real captures tee into the store with exact numbers; rows and checksums untouched", async () => {
    const { db, close } = createSeededDb("tee-chain");
    const store = new PerformanceStore();
    const usageSink = createUsageSink(store, {
      claudeModelId: "claude-opus-5[1m]",
      codexModelId: "gpt-6-sol"
    });
    try {
      // One execution, two drained batches (one per dialect, as in production
      // where a batch is always single-dialect); seq stays execution-unique.
      await seedExecutionRow(db, "exec-tee-chain");

      const claudeUsages = await Promise.all(CLAUDE_FIXTURES.map((f) => realUsage(f)));
      const codexUsages = await Promise.all(CODEX_FIXTURES.map((f) => realUsage(f)));
      expect(claudeUsages.map((u) => u.sourceType)).toEqual(["result", "result", "result", "result", "result"]);
      expect(codexUsages.map((u) => u.sourceType)).toEqual(["turn.completed", "turn.completed"]);

      const claudeEvents = claudeUsages.map((u, i) =>
        usageReportedEvent("exec-tee-chain", i + 1, u.sourceType, u.usage)
      );
      const codexEvents = codexUsages.map((u, i) =>
        usageReportedEvent("exec-tee-chain", i + 6, u.sourceType, u.usage)
      );

      const claudeBatch = persistDrainedEvents(db, "claude", "exec-tee-chain", claudeEvents, { usageSink });
      const codexBatch = persistDrainedEvents(db, "codex", "exec-tee-chain", codexEvents, { usageSink });
      expect(claudeBatch).toEqual({ stored: 5, duplicated: 0, sessionId: null });
      expect(codexBatch).toEqual({ stored: 2, duplicated: 0, sessionId: null });

      // The sidecar received every turn, attributed as the caller specified.
      expect(store.size).toBe(7);
      const summaries = store.summaryByModel();
      expect(summaries.map((s) => s.modelId)).toEqual(["claude-opus-5[1m]", "gpt-6-sol"]);
      // Observed totals recomputed from the real captured usage objects.
      expect(summaries[0]).toMatchObject({
        eventCount: 5,
        totalInputTokens: 6 + 2 + 4 + 2 + 2, // 16
        totalOutputTokens: 394 + 137 + 3 + 3 + 911, // 1448
        totalCacheReadTokens: 36352 * 2,
        totalCacheCreationTokens: 191205 + 14673 + 55001 + 50998 + 14657,
        costUsd: "unknown"
      });
      expect(summaries[1]).toMatchObject({
        eventCount: 2,
        totalInputTokens: 285404 + 56622,
        totalOutputTokens: 485 + 5,
        totalCacheReadTokens: 229632 + 4096,
        totalCacheCreationTokens: 0,
        costUsd: "unknown"
      });
      for (const event of store.events()) {
        // The persisted usage payload carries no duration — stays explicit null.
        expect(event.durationMs).toBeNull();
      }

      // The report reflects the teed usage; cost stays contract-unknown.
      const report = store.report();
      expect(report).toContain("claude-opus-5[1m]");
      expect(report).toContain("gpt-6-sol");
      expect(report).toContain("cost: unknown");

      // The execution side is untouched by the tee: rows persisted exactly
      // once, integrity green.
      expect(listEventsForExecution(db, "exec-tee-chain")).toHaveLength(7);
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("the sink receives exactly the persisted payload re-serialized under the preserved source type", async () => {
    const { db, close } = createSeededDb("tee-lines");
    try {
      await seedExecutionRow(db, "exec-tee-lines");
      const usage = { input_tokens: 6, output_tokens: 394, cache_read_input_tokens: 0, cache_creation_input_tokens: 191205 };
      const captured: { lines: readonly string[]; dialect: string }[] = [];
      const captureSink: UsageTeeSink = (lines, dialect) => captured.push({ lines, dialect });

      persistDrainedEvents(db, "claude", "exec-tee-lines", [
        usageReportedEvent("exec-tee-lines", 1, "result", usage),
        // Non-usage payloads carry no tee line: silently skipped.
        {
          schemaVersion: 1,
          eventId: "evt-tee-lines-diag",
          executionId: "exec-tee-lines",
          seq: 2,
          type: "diagnostic",
          sourceType: "synthetic.diagnostic",
          occurredAt: T0,
          payload: { summary: "not a usage event" }
        }
      ], { usageSink: captureSink });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.dialect).toBe("claude");
      expect(captured[0]?.lines).toEqual([JSON.stringify({ type: "result", usage })]);
    } finally {
      close();
    }
  });

  test("replayed duplicates do not re-tee: only events actually stored in this batch feed the sidecar", async () => {
    const { db, close } = createSeededDb("tee-dedup");
    try {
      await seedExecutionRow(db, "exec-tee-dedup");
      const usage = { input_tokens: 2, output_tokens: 12, cache_read_input_tokens: 36352, cache_creation_input_tokens: 14908 };
      const events = [usageReportedEvent("exec-tee-dedup", 1, "result", usage)];
      const store = new PerformanceStore();
      const usageSink = createUsageSink(store, { claudeModelId: "claude-opus-5[1m]" });

      const first = persistDrainedEvents(db, "claude", "exec-tee-dedup", events, { usageSink });
      expect(first).toEqual({ stored: 1, duplicated: 0, sessionId: null });
      expect(store.size).toBe(1);

      // Same batch again (replay): every event is a duplicated row — and the
      // sidecar is NOT called again, so the statistics never double-count.
      const second = persistDrainedEvents(db, "claude", "exec-tee-dedup", events, { usageSink });
      expect(second).toEqual({ stored: 0, duplicated: 1, sessionId: null });
      expect(store.size).toBe(1);
    } finally {
      close();
    }
  });
});

describe("M8-04 usage tee: fail-open (execution main flow unaffected)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a sink whose store throws: persist result and stored rows field-by-field identical to the sink-less run; one stderr diagnostic", async () => {
    const usage = { input_tokens: 2, output_tokens: 12, cache_read_input_tokens: 36352, cache_creation_input_tokens: 14908 };
    const buildEvents = (executionId: string): NormalizedEvent[] => [
      usageReportedEvent(executionId, 1, "result", usage),
      {
        schemaVersion: 1,
        eventId: `evt-${executionId}-diag`,
        executionId,
        seq: 2,
        type: "diagnostic",
        sourceType: "synthetic.diagnostic",
        occurredAt: T0,
        payload: { summary: "plain diagnostic" }
      }
    ];

    const baseline = createSeededDb("tee-baseline");
    const faulty = createSeededDb("tee-faulty");
    try {
      await seedExecutionRow(baseline.db, "exec-tee-base");
      await seedExecutionRow(faulty.db, "exec-tee-fault");

      // Injected fault: the sidecar store explodes on every append.
      class ExplodingStore extends PerformanceStore {
        override append(): never {
          throw new Error("injected sidecar store failure");
        }
      }
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const withSink = persistDrainedEvents(
        faulty.db,
        "claude",
        "exec-tee-fault",
        buildEvents("exec-tee-fault"),
        { usageSink: createUsageSink(new ExplodingStore()) }
      );
      const withoutSink = persistDrainedEvents(
        baseline.db,
        "claude",
        "exec-tee-base",
        buildEvents("exec-tee-base")
      );

      // Same shape (event kinds), so the batch results must match field by field.
      expect(withSink).toEqual(withoutSink);
      expect(withSink).toEqual({ stored: 2, duplicated: 0, sessionId: null });

      // Stored rows identical: payload text, type and seq per event.
      const baseRows = listEventsForExecution(baseline.db, "exec-tee-base").map((r) => ({
        seq: r.seq,
        type: r.type,
        payload: r.payload
      }));
      const faultRows = listEventsForExecution(faulty.db, "exec-tee-fault").map((r) => ({
        seq: r.seq,
        type: r.type,
        payload: r.payload
      }));
      expect(faultRows).toEqual(baseRows);
      expect(verifyEventChecksums(baseline.db)).toEqual([]);
      expect(verifyEventChecksums(faulty.db)).toEqual([]);
      expect(getEvent(faulty.db, "evt-exec-tee-fault-001")).not.toBeNull();

      // The failure cost exactly one flattened stderr line — nothing rethrown.
      expect(stderr).toHaveBeenCalledTimes(1);
      const line = String(stderr.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[model-stats usage tee] fail-open:");
      expect(line).toContain("injected sidecar store failure");
      expect(line.endsWith("\n")).toBe(true);
      expect(line.split("\n")).toHaveLength(2); // one line + trailing newline
    } finally {
      baseline.close();
      faulty.close();
    }
  });
});
