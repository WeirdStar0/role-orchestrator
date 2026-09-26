/**
 * Search tokenization (M3-03) — 选型说明 for the retrieval engine.
 *
 * CHOSEN: SQL LIKE substring matching over the AUTHORITATIVE `memories`
 * table, with AND-tokenized queries. NOT SQLite FTS, NOT a shadow index.
 * Reasons:
 *  1. Integrity over cleverness: LIKE reads the row of record. A shadow
 *     text index (FTS) that drifts from the table silently MISSES hits —
 *     a false negative inside a security-scoped retrieval path is worse
 *     than a slower scan. There is no drift mode without an index.
 *  2. `node:sqlite` FTS availability depends on the Node build; the
 *     planner docs (docs/MEMORY_AND_CONTEXT.md section 5) already frame
 *     richer text indexes / vectors as a LATER optimization.
 *  3. Content is capped at 10000 chars and retrieval is project-scoped;
 *     volumes at this milestone make a full scan per query a non-issue.
 *
 * Token semantics: the query is split on non-letter/non-number runs
 * (Unicode-aware, so CJK phrases without spaces survive as one token and
 * still match by substring). EVERY token must occur (AND) — a missing token
 * is a miss. Case-folding is ASCII-only (SQLite LIKE engine limit,
 * documented honestly); everything else is exact substring.
 *
 * LIKE wildcards in tokens (%, _, \) are escaped, so user text matches as
 * text, never as a pattern.
 */
import { z } from "zod";
import { MemorySearchQueryInvalidError } from "./errors.js";
import {
  MAX_QUERY_LENGTH,
  MAX_QUERY_TOKENS,
  MAX_TOKEN_LENGTH
} from "./types.js";

export const SearchQuerySchema = z.string().max(MAX_QUERY_LENGTH);

/**
 * Split a raw query into match tokens. Throws `MemorySearchQueryInvalidError`
 * on an empty (or whitespace/punctuation-only) query, too many tokens, or an
 * over-long token.
 */
export function tokenizeSearchQuery(rawQuery: string): readonly string[] {
  const query = SearchQuerySchema.parse(rawQuery);
  const tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new MemorySearchQueryInvalidError("query contains no searchable token");
  }
  if (tokens.length > MAX_QUERY_TOKENS) {
    throw new MemorySearchQueryInvalidError(
      `query has ${String(tokens.length)} tokens; at most ${String(MAX_QUERY_TOKENS)} are allowed`
    );
  }
  for (const token of tokens) {
    if (token.length > MAX_TOKEN_LENGTH) {
      throw new MemorySearchQueryInvalidError(
        `token exceeds ${String(MAX_TOKEN_LENGTH)} characters: "${token.slice(0, 16)}…"`
      );
    }
  }
  return tokens;
}

/** Escape SQLite LIKE wildcards so a token matches as literal text. */
export function likeLiteral(token: string): string {
  return token.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** The full LIKE operand for one token (bounded substring match). */
export function likePattern(token: string): string {
  return `%${likeLiteral(token)}%`;
}
