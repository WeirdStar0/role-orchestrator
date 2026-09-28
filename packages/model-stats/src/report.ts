/**
 * report() — the ONLY read-out of PerformanceStore: a deterministic,
 * human-readable performance report.
 *
 * Read-only by construction: rendering consumes summaries (pure data) and
 * returns a string; it holds no references it could act through and exposes
 * no callback surface. The vocabulary is pinned by a test — no
 * recommendation/switch/reroute language may appear, because this package
 * must not influence scheduling decisions. Output is a pure function of the
 * summaries (no clock, no randomness) so snapshots stay stable.
 */
import type { ModelPerformanceSummary } from "./store.js";
import { COST_UNKNOWN } from "./schema.js";

const COST_UNKNOWN_NOTE = "no approved rate source; self-reported CLI prices are not a price oracle";

export function renderPerformanceReport(summaries: readonly ModelPerformanceSummary[]): string {
  const lines: string[] = [];
  lines.push("Model performance report (read-only statistics; no scheduling effect)");
  lines.push("=".repeat(74));
  if (summaries.length === 0) {
    lines.push("(no usage events recorded)");
    lines.push(`cost: ${COST_UNKNOWN} (${COST_UNKNOWN_NOTE})`);
    return lines.join("\n");
  }
  for (const summary of summaries) {
    lines.push(`model: ${summary.modelId}`);
    lines.push(`  events (turn summaries): ${summary.eventCount}`);
    lines.push(`  tokens: input=${summary.totalInputTokens} output=${summary.totalOutputTokens} ` +
      `cache_read=${summary.totalCacheReadTokens} cache_creation=${summary.totalCacheCreationTokens} ` +
      `total=${summary.totalTokens}`);
    lines.push(
      summary.averageDurationMs === null
        ? `  duration: no duration-bearing events (mean n/a)`
        : `  duration: mean=${formatMs(summary.averageDurationMs)} over ${summary.durationSampleCount} event(s)`
    );
    lines.push(`  cost: ${summary.costUsd} (${COST_UNKNOWN_NOTE})`);
  }
  lines.push("=".repeat(74));
  lines.push("This report is descriptive only. It must not be used to select, switch or reroute models.");
  return lines.join("\n");
}

function formatMs(ms: number): string {
  return Number.isInteger(ms) ? String(ms) : ms.toFixed(1);
}
