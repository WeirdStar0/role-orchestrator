/**
 * Hermetic usage extractors for the two CLI JSONL dialects captured for real
 * in packages/cli-events/fixtures-real/ (M8-01 controlled window).
 *
 * Dialect facts pinned by the real captures:
 * - claude stream-json: an `assistant` line carries a per-message `model` +
 *   `usage` (message-level); a `result` line carries the TURN totals in
 *   `usage`, a `modelUsage` map keyed by model id, and `duration_ms`. The
 *   assistant-line and result-line numbers genuinely differ (the M8-01 c1
 *   capture: assistant output_tokens=8 vs result output_tokens=12, and the
 *   assistant model string may differ from the result modelUsage key), so
 *   appending BOTH would double-count one turn. Default policy: result lines
 *   are the authoritative turn summary and are the only extracted events;
 *   assistant-level extraction is opt-in for diagnostics.
 * - codex `exec --json`: usage rides exactly on `turn.completed`
 *   (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
 *   `output_tokens`, `reasoning_output_tokens`). No model id, no duration —
 *   both stay explicit (caller-supplied model / null), never guessed.
 *
 * Source-boundary tolerance is deliberate and narrow: the raw event objects
 * are parsed with non-strict zod objects so ADDITIVE third-party fields
 * (service_tier, inference_geo, iterations, ...) are ignored, while every
 * field we actually read is type/shape validated. Malformed JSON lines and
 * usage lines failing validation are RECORDED, not swallowed — a silent skip
 * would silently understate usage. Cost fields in the source
 * (total_cost_usd / costUSD) are dropped by construction: see schema.ts.
 */
import { z } from "zod";
import { COST_UNKNOWN, UNKNOWN_MODEL_ID, UsageEventSchema, type UsageEvent } from "./schema.js";

export type CliDialect = "claude" | "codex";

export interface UsageLineError {
  readonly line: number;
  readonly reason: string;
}

export interface UsageParseResult {
  readonly events: readonly UsageEvent[];
  /** Non-empty lines inspected. */
  readonly linesTotal: number;
  /** Valid JSON lines that carry no usage (or were excluded by options). */
  readonly linesSkipped: number;
  /** Lines that could not be parsed or failed field validation. */
  readonly errors: readonly UsageLineError[];
}

export interface ClaudeParseOptions {
  /**
   * Default false: only `result` lines (turn totals with duration_ms)
   * produce events. When true, `assistant` lines with usage ALSO produce
   * message-level events (diagnostics; they overlap the result totals).
   */
  readonly includeAssistantEvents?: boolean;
}

export interface CodexParseOptions {
  /**
   * codex JSONL names no model. The caller (the layer that spawned the CLI)
   * knows which model was invoked and SHOULD pass it here; without it events
   * aggregate under the explicit "unknown" sentinel.
   */
  readonly modelId?: string;
}

const TokenField = z.number().int().nonnegative();

// Non-strict on purpose for the SOURCE boundary (dialects evolve additively);
// every consumed field is individually validated. See module comment.
const ClaudeUsageShape = z.object({
  input_tokens: TokenField,
  output_tokens: TokenField,
  cache_read_input_tokens: TokenField,
  cache_creation_input_tokens: TokenField
});

const CodexUsageShape = z.object({
  input_tokens: TokenField,
  output_tokens: TokenField,
  cached_input_tokens: TokenField,
  cache_write_input_tokens: TokenField
  // reasoning_output_tokens exists on the wire but is deliberately NOT read:
  // the captures do not let us verify whether it is included in
  // output_tokens, and guessing would double-count reasoning.
});

function emptyResult(): { events: UsageEvent[]; errors: UsageLineError[] } {
  return { events: [], errors: [] };
}

function fail(
  errors: UsageLineError[],
  line: number,
  reason: string
): void {
  errors.push({ line, reason });
}

/**
 * Extract UsageEvents from a claude stream-json buffer (whole JSONL text;
 * callers may also feed line-by-line). Never spawns a CLI.
 */
export function parseClaudeUsageEvents(text: string, options: ClaudeParseOptions = {}): UsageParseResult {
  const { events, errors } = emptyResult();
  let skipped = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      fail(errors, lineNumber, "unparseable-json");
      continue;
    }
    if (typeof raw !== "object" || raw === null) {
      fail(errors, lineNumber, "line-is-not-an-object");
      continue;
    }
    const record = raw as { readonly [key: string]: unknown };
    const type = record["type"];
    if (type === "result") {
      const usageRaw = record["usage"];
      if (typeof usageRaw !== "object" || usageRaw === null) {
        skipped++;
        continue;
      }
      const usage = ClaudeUsageShape.safeParse(usageRaw);
      if (!usage.success) {
        fail(errors, lineNumber, "claude-result-usage-shape-invalid");
        continue;
      }
      events.push(
        UsageEventSchema.parse({
          inputTokens: usage.data.input_tokens,
          outputTokens: usage.data.output_tokens,
          cacheReadTokens: usage.data.cache_read_input_tokens,
          cacheCreationTokens: usage.data.cache_creation_input_tokens,
          // modelUsage is a map keyed by model id; with exactly one entry the
          // key IS the model. Otherwise fall back to the line's `model`, then
          // the explicit sentinel — recorded, never inferred from text.
          modelId: claudeResultModelId(record),
          durationMs: positiveIntOr(record["duration_ms"], null),
          costUsd: COST_UNKNOWN
        })
      );
      continue;
    }
    if (type === "assistant" && options.includeAssistantEvents === true) {
      // Real claude stream-json nests the API message: {"type":"assistant",
      // "message":{"model":...,"usage":{...}}} (verified against the M8-01
      // captures). Tolerate a flattened line too, but never guess across the
      // two.
      const message = record["message"];
      const source =
        typeof message === "object" && message !== null
          ? (message as { readonly [key: string]: unknown })
          : record;
      const usageRaw = source["usage"];
      if (typeof usageRaw !== "object" || usageRaw === null) {
        skipped++;
        continue;
      }
      const usage = ClaudeUsageShape.safeParse(usageRaw);
      if (!usage.success) {
        fail(errors, lineNumber, "claude-assistant-usage-shape-invalid");
        continue;
      }
      const model = source["model"];
      events.push(
        UsageEventSchema.parse({
          inputTokens: usage.data.input_tokens,
          outputTokens: usage.data.output_tokens,
          cacheReadTokens: usage.data.cache_read_input_tokens,
          cacheCreationTokens: usage.data.cache_creation_input_tokens,
          modelId: typeof model === "string" && model.length > 0 ? model : UNKNOWN_MODEL_ID,
          // Assistant lines carry no turn duration; absence stays null.
          durationMs: null,
          costUsd: COST_UNKNOWN
        })
      );
      continue;
    }
    skipped++;
  }
  return { events, linesTotal: lines.filter((l) => l.trim().length > 0).length, linesSkipped: skipped, errors };
}

function claudeResultModelId(record: { readonly [key: string]: unknown }): string {
  const modelUsage = record["modelUsage"];
  if (typeof modelUsage === "object" && modelUsage !== null) {
    const keys = Object.keys(modelUsage);
    if (keys.length === 1) {
      const key = keys[0];
      if (key !== undefined && key.length > 0) return key;
    }
  }
  const model = record["model"];
  if (typeof model === "string" && model.length > 0) return model;
  return UNKNOWN_MODEL_ID;
}

function positiveIntOr(value: unknown, fallback: null): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

/**
 * Extract UsageEvents from a codex `exec --json` buffer. Only
 * `turn.completed` lines carry usage; everything else is skipped.
 */
export function parseCodexUsageEvents(text: string, options: CodexParseOptions = {}): UsageParseResult {
  const { events, errors } = emptyResult();
  let skipped = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      fail(errors, lineNumber, "unparseable-json");
      continue;
    }
    if (typeof raw !== "object" || raw === null) {
      fail(errors, lineNumber, "line-is-not-an-object");
      continue;
    }
    const record = raw as { readonly [key: string]: unknown };
    if (record["type"] !== "turn.completed") {
      skipped++;
      continue;
    }
    const usageRaw = record["usage"];
    if (typeof usageRaw !== "object" || usageRaw === null) {
      skipped++;
      continue;
    }
    const usage = CodexUsageShape.safeParse(usageRaw);
    if (!usage.success) {
      fail(errors, lineNumber, "codex-usage-shape-invalid");
      continue;
    }
    events.push(
      UsageEventSchema.parse({
        inputTokens: usage.data.input_tokens,
        outputTokens: usage.data.output_tokens,
        cacheReadTokens: usage.data.cached_input_tokens,
        cacheCreationTokens: usage.data.cache_write_input_tokens,
        modelId: options.modelId ?? UNKNOWN_MODEL_ID,
        // The codex dialect names no turn duration; absence stays null.
        durationMs: null,
        costUsd: COST_UNKNOWN
      })
    );
  }
  return { events, linesTotal: lines.filter((l) => l.trim().length > 0).length, linesSkipped: skipped, errors };
}
