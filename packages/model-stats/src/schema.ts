/**
 * M8-02 UsageEvent — the strict output contract for model performance
 * statistics.
 *
 * Scope boundary (M8 ask): statistics are READ-ONLY infrastructure. Nothing
 * in this package may influence which model a run uses; the scheduler and
 * capability gate own every dispatch decision. This schema is the normalized
 * shape every extractor emits and every store/report consumes.
 *
 * Cost is CONTRACT-LEVEL "unknown" (z.literal): the repository has no
 * approved rate source, and a price the CLI self-reports (e.g. claude result
 * lines carry total_cost_usd) is not a price oracle — extractors deliberately
 * drop such fields, so a stored/reportable cost can never masquerade as a
 * computed dollar figure. If a rate source is ever approved, this is a
 * contract change requiring its own batch, not a local tweak.
 *
 * Strictness (repo rule: all inputs schema-validated, unknown fields rejected
 * by default) applies to the OUTPUT contract: UsageEventSchema is a
 * strictObject, so persisting/re-loading an event with extra fields fails
 * closed rather than carrying unvalidated data.
 */
import { z } from "zod";

/** The only representable cost state. Never a number, never "free". */
export const COST_UNKNOWN = "unknown" as const;

const TokenCountSchema = z.number().int().nonnegative();

export const UsageEventSchema = z.strictObject({
  /** Prompt tokens billed as fresh input (excludes cache reads). */
  inputTokens: TokenCountSchema,
  /** Completion tokens as reported by the CLI turn summary. */
  outputTokens: TokenCountSchema,
  /** Prompt tokens served from the prompt cache. */
  cacheReadTokens: TokenCountSchema,
  /** Tokens written to the prompt cache by this call. */
  cacheCreationTokens: TokenCountSchema,
  /**
   * Model identifier as the source stream names it. Extractors never guess:
   * claude lines carry the model (assistant line) or a modelUsage key
   * (result line); codex JSONL carries NO model field, so the caller supplies
   * the invoked model, else the explicit sentinel "unknown" is used.
   */
  modelId: z.string().min(1),
  /**
   * Wall-clock duration of the turn in ms when the source line carries one
   * (claude result lines do; assistant lines and codex turn.completed do
   * not). Absence is explicit null — never a synthesized 0.
   */
  durationMs: z.nullable(TokenCountSchema),
  /** Contract-level unknown; see module comment. */
  costUsd: z.literal(COST_UNKNOWN)
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;

/** All tokens the call touched, cache reads/creations included. */
export function totalTokens(event: UsageEvent): number {
  return event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheCreationTokens;
}

/**
 * Explicit sentinel used ONLY when a dialect genuinely names no model
 * (codex JSONL without a caller-supplied modelId). It aggregates into its
 * own bucket in reports instead of polluting a real model's numbers.
 */
export const UNKNOWN_MODEL_ID = "unknown";

/** Raw model id inside codex JSONL is absent by design; reserved for future dialects. */
export function isUnknownModelId(modelId: string): boolean {
  return modelId === UNKNOWN_MODEL_ID;
}
