/**
 * Usage tee sink adapter (M8-04) — the model-stats side of the engine
 * persistence tee. The engine (persistence.ts persistDrainedEvents) tees the
 * usage payloads it just persisted as extractor-ready lines; this adapter
 * routes them through the EXISTING dialect extractors into an append-only
 * PerformanceStore owned by the caller.
 *
 * Shape of the teed lines: the engine's normalized `usage_reported` payload
 * carries the raw usage object verbatim but NOT the enclosing CLI line (no
 * modelUsage key, no duration, no per-turn model), so the engine re-emits it
 * under the preserved raw source type — claude `result`, codex
 * `turn.completed`. The extractors consume these synthetic lines unmodified;
 * what they cannot find stays honest: durationMs is null and the model lands
 * on the explicit "unknown" sentinel UNLESS the caller attributes it via
 * `claudeModelId` / `codexModelId` (the spawn side knows which model it
 * invoked — same no-guessing contract as CodexParseOptions.modelId).
 *
 * Failure posture is DELIBERATELY split:
 * - the adapter is honest and may throw (store write failure propagates);
 * - fail-open is the ENGINE side's guarantee (persistDrainedEvents wraps the
 *   sink call: any exception becomes one stderr diagnostic, execution flow
 *   untouched). A direct user of this adapter who needs fail-open wraps it.
 *
 * Parse-level problems (malformed line, usage shape invalid) are neither
 * thrown nor swallowed silently by the extractors' own contract — they are
 * recorded on the parse result and yield NO event; the tee drops them (the
 * engine row remains the only record of what the CLI actually said).
 */
import { isUnknownModelId } from "./schema.js";
import {
  parseClaudeUsageEvents,
  parseCodexUsageEvents,
  type CliDialect
} from "./parse.js";
import type { PerformanceStore } from "./store.js";

/** Same union as the engine's Dialect (structural, no cross-dependency). */
export type UsageSinkDialect = CliDialect;

export interface UsageSinkOptions {
  /**
   * Explicit model attribution for claude usage lines. The persisted
   * usage payload carries no modelUsage key, so line-derived attribution is
   * unavailable; without this, claude events land on "unknown".
   * Only replaces the sentinel — a model the line itself named is kept.
   */
  readonly claudeModelId?: string | undefined;
  /** Explicit model attribution for codex lines (which name no model). */
  readonly codexModelId?: string | undefined;
}

/** Structural twin of the engine's UsageTeeSink (no cross-package import). */
export type UsageSink = (rawLines: readonly string[], dialect: UsageSinkDialect) => void;

/**
 * Build the sink to pass to engine `persistDrainedEvents({ usageSink })`.
 * Pure append path: extract → optionally attribute → appendMany. No file
 * path, no directory creation, no flush here — the store's persistence
 * (flushToFile) stays under the caller's explicit control, exactly as the
 * store contract requires.
 */
export function createUsageSink(store: PerformanceStore, options: UsageSinkOptions = {}): UsageSink {
  return (rawLines, dialect) => {
    if (rawLines.length === 0) return;
    const text = rawLines.join("\n");
    const parsed =
      dialect === "claude"
        ? parseClaudeUsageEvents(text)
        : parseCodexUsageEvents(
            text,
            options.codexModelId === undefined ? {} : { modelId: options.codexModelId }
          );
    let events = parsed.events;
    const attribution = dialect === "claude" ? options.claudeModelId : options.codexModelId;
    if (attribution !== undefined) {
      events = events.map((event) =>
        isUnknownModelId(event.modelId) ? { ...event, modelId: attribution } : event
      );
    }
    if (events.length > 0) store.appendMany(events);
  };
}
