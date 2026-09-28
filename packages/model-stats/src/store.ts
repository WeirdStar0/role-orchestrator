/**
 * PerformanceStore — append-only in-memory log of UsageEvents with optional
 * file persistence.
 *
 * Append-only is the audit property: history is never rewritten, so a
 * reported aggregate can always be recomputed from the event log. There is
 * deliberately NO update, delete, reset or reclassify API — the class surface
 * is pinned by a test. File persistence follows the same rule: flushes APPEND
 * JSONL lines (watermark-tracked, `fs.appendFile`), never truncate or rewrite
 * an existing file, and loading re-validates every line against the strict
 * UsageEventSchema (a tampered/garbage file fails closed).
 *
 * Aggregation is by modelId with plain sums and a mean over duration-bearing
 * events only (null durations are excluded from the mean, never read as 0).
 * Cost is constant "unknown" — see schema.ts.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { COST_UNKNOWN, UsageEventSchema, type UsageEvent } from "./schema.js";
import { renderPerformanceReport } from "./report.js";

export interface ModelPerformanceSummary {
  readonly modelId: string;
  /** Appended events for this model (claude result lines / codex turns). */
  readonly eventCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalTokens: number;
  /** Mean over events WITH a duration; null when none did. */
  readonly averageDurationMs: number | null;
  /** How many duration-bearing events back the mean (0 => average is null). */
  readonly durationSampleCount: number;
  /** Always "unknown": no approved rate source exists. */
  readonly costUsd: typeof COST_UNKNOWN;
}

interface ModelBucket {
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durations: number[];
}

export class PerformanceStore {
  private readonly log: UsageEvent[] = [];
  /** Lines already flushed to the persistence file (append watermark). */
  private persistedCount = 0;

  /** Append one validated event. Re-validation keeps every entry point strict. */
  append(event: UsageEvent): void {
    this.log.push(UsageEventSchema.parse(event));
  }

  appendMany(events: readonly UsageEvent[]): void {
    for (const event of events) this.append(event);
  }

  /** Number of appended events. */
  get size(): number {
    return this.log.length;
  }

  /** Defensive copy of the full event log, in append order. */
  events(): readonly UsageEvent[] {
    return this.log.map((event) => ({ ...event }));
  }

  /** Per-model aggregates, sorted by modelId for deterministic output. */
  summaryByModel(): readonly ModelPerformanceSummary[] {
    const byModel = new Map<string, ModelBucket>();
    for (const event of this.log) {
      let bucket = byModel.get(event.modelId);
      if (bucket === undefined) {
        bucket = { eventCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durations: [] };
        byModel.set(event.modelId, bucket);
      }
      bucket.eventCount += 1;
      bucket.inputTokens += event.inputTokens;
      bucket.outputTokens += event.outputTokens;
      bucket.cacheReadTokens += event.cacheReadTokens;
      bucket.cacheCreationTokens += event.cacheCreationTokens;
      if (event.durationMs !== null) bucket.durations.push(event.durationMs);
    }
    return [...byModel.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([modelId, bucket]) => {
        const total =
          bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheCreationTokens;
        return {
          modelId,
          eventCount: bucket.eventCount,
          totalInputTokens: bucket.inputTokens,
          totalOutputTokens: bucket.outputTokens,
          totalCacheReadTokens: bucket.cacheReadTokens,
          totalCacheCreationTokens: bucket.cacheCreationTokens,
          totalTokens: total,
          averageDurationMs:
            bucket.durations.length === 0
              ? null
              : bucket.durations.reduce((sum, d) => sum + d, 0) / bucket.durations.length,
          durationSampleCount: bucket.durations.length,
          costUsd: COST_UNKNOWN
        } satisfies ModelPerformanceSummary;
      });
  }

  /**
   * The read-only report interface (M8 ask): renders the current aggregates
   * as a deterministic human-readable string. Pure read — no mutation, no
   * decision output. See report.ts for the vocabulary constraints.
   */
  report(): string {
    return renderPerformanceReport(this.summaryByModel());
  }

  /**
   * Append (never rewrite) the not-yet-persisted events as JSONL lines to
   * `filePath`. Returns how many lines this call appended.
   */
  async flushToFile(filePath: string): Promise<number> {
    const pending = this.log.slice(this.persistedCount);
    if (pending.length === 0) return 0;
    await mkdir(path.dirname(filePath), { recursive: true });
    const payload = pending.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await appendFile(filePath, payload, "utf8");
    this.persistedCount += pending.length;
    return pending.length;
  }

  /**
   * Load events from a JSONL file produced by flushToFile. Every line is
   * re-validated against the strict schema; any deviation throws (fail
   * closed) instead of loading partial data. Loaded lines mark the append
   * watermark so a subsequent flushToFile does not duplicate them.
   */
  static async loadFromFile(filePath: string): Promise<PerformanceStore> {
    const text = await readFile(filePath, "utf8");
    const store = new PerformanceStore();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim().length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`model-stats persistence file line ${i + 1} is not valid JSON`);
      }
      const parsed = UsageEventSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`model-stats persistence file line ${i + 1} failed UsageEvent validation`);
      }
      store.log.push(parsed.data);
    }
    store.persistedCount = store.log.length;
    return store;
  }
}
