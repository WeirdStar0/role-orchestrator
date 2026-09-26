/**
 * Vocabulary for memory retrieval and source-sha freshness (M3-03).
 *
 * DECISION-FREE data throughout (A16): the staleness reasons, search
 * defaults and limits below are frozen constants — nothing derived from
 * memory CONTENT can widen or re-interpret them. The authorization story
 * lives in `access.ts` (one bound projectId per session) and never consults
 * content.
 */
import { z } from "zod";
import { CommitShaSchema } from "@role-orchestrator/integration";
import {
  MemoryStatusSchema,
  MemoryTypeSchema,
  type MemoryRecord
} from "@role-orchestrator/memory";

export { CommitShaSchema };

/** Why a memory was flagged stale (its sourceSha reference check failed). */
export const STALE_REASONS = ["missing", "superseded"] as const;
export type StaleReason = (typeof STALE_REASONS)[number];
export const StaleReasonSchema = z.enum(STALE_REASONS);

/**
 * Statuses retrieval covers BY DEFAULT: docs/MEMORY_AND_CONTEXT.md section 5
 * scopes retrieval to verified facts/decisions and the active rules. An
 * explicit override may widen it (diagnostics), but the default is narrow.
 */
export const DEFAULT_SEARCH_STATUSES: readonly z.output<typeof MemoryStatusSchema>[] = [
  "verified",
  "active"
];

/** Search query limits (conservative, deterministic). */
export const MAX_QUERY_LENGTH = 512;
export const MAX_QUERY_TOKENS = 16;
export const MAX_TOKEN_LENGTH = 64;

/**
 * What a source-sha resolver observed for ONE cited sha, against the
 * CURRENT repository/baseline:
 * - `exists: false`                       — the sha is gone (missing).
 * - `exists: true, currentSha: null`      — exists; resolver asserts
 *   existence only (no baseline comparison).
 * - `exists: true, currentSha: "<sha>"`   — exists; baseline moved past the
 *   cited sha when currentSha differs (superseded).
 */
export const SourceShaObservationSchema = z.strictObject({
  exists: z.boolean(),
  currentSha: CommitShaSchema.nullable()
});
export type SourceShaObservation = z.output<typeof SourceShaObservationSchema>;

/** The port a caller implements to check cited SHAs against a repository. */
export type SourceShaResolver = (sourceSha: string) => SourceShaObservation;

/** One retrieval hit: the full memory record plus source/staleness marks. */
export interface MemorySearchHit extends MemoryRecord {
  /** The cited source artifact/commit SHA, when the memory carries one. */
  readonly sourceSha: string | null;
  /** True when the persisted stale mark is set (source check failed). */
  readonly stale: boolean;
  readonly staleSince: string | null;
  readonly staleReason: StaleReason | null;
}

/** One row of a `checkSources` run (already persisted + audited). */
export interface MemorySourceCheckResult {
  readonly memoryId: string;
  readonly sourceSha: string;
  readonly outcome: "current" | "missing" | "superseded";
  readonly stale: boolean;
  readonly staleSince: string | null;
  readonly staleReason: StaleReason | null;
}

export interface MemorySourceCheckRun {
  readonly projectId: string;
  readonly checkedAt: string;
  readonly checkedCount: number;
  readonly results: readonly MemorySourceCheckResult[];
}

/** The last persisted check outcome for one memory, plus its stale marks. */
export interface MemorySourceStatus {
  readonly memoryId: string;
  readonly sourceSha: string | null;
  readonly stale: boolean;
  readonly staleSince: string | null;
  readonly staleReason: StaleReason | null;
  readonly lastCheck: {
    readonly outcome: "current" | "missing" | "superseded";
    readonly observedSha: string | null;
    readonly checkedAt: string;
  } | null;
}

export { MemoryStatusSchema, MemoryTypeSchema };
