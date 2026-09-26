/**
 * Memory -> context bundle injection (M3-03).
 *
 * `assembleContextBundleWithMemory` is the downstream half of retrieval:
 * it searches through an AUTHORIZED `MemoryAccess` session and hands the
 * hits to the M3-01 assembler as `memory` layer fragments. Properties that
 * are structural, not conventional:
 *
 * 1. ISOLATION — the access session must belong to the bundle's project;
 *    a mismatch is a `CrossProjectAccessError`. Since retrieval itself is
 *    WHERE-scoped to the authorized project, foreign memory can never
 *    enter the bundle by construction (A15, and A16 continuity: injected
 *    content changes nothing about it).
 * 2. STALENESS — stale hits are EXCLUDED by default (选型: 排除 over 标注).
 *    `includeStaleMemories: true` admits them, and the assembler then
 *    prefixes each with a loud `[STALE MEMORY …]` marker line, so old
 *    evidence is never reused silently either way.
 * 3. TRACEABILITY — every fragment cites memoryId (source.id) + version
 *    (source.revision) + the fragment contentHash (manifest), optionally
 *    plus the memory's sourceSha (source.commitSha); persisted bundles
 *    carry the same provenance per row (migration 010) and reverse lookups
 *    (`findFragmentsBySource`, `traceFragment`) keep working.
 * 4. TRUNCATION — injected fragments join the shared byte budget at the
 *    LOWEST priority (dropped first), project rules are never dropped,
 *    and omissions are recorded in the manifest (M3-01 semantics).
 */
import { z } from "zod";
import {
  AssembleContextBundleInputSchema,
  assembleContextBundle,
  type AssembleContextBundleInput,
  type ContextBundle
} from "@role-orchestrator/context";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { CrossProjectAccessError } from "./errors.js";
import type { MemoryAccess } from "./access.js";
import { MAX_QUERY_LENGTH, MemoryStatusSchema, MemoryTypeSchema } from "./types.js";

const AssembleWithMemoryInputSchema = z.strictObject({
  /** The bundle's project; must equal the access session's project. */
  projectId: IdSchema,
  /** Everything the M3-01 assembler takes EXCEPT project/memory fields
   * (the top-level projectId is the single authoritative project). */
  bundle: AssembleContextBundleInputSchema.omit({
    projectId: true,
    memoryEntries: true,
    includeStaleMemories: true
  }),
  /** Retrieval options; statuses default to verified+active. */
  memory: z.strictObject({
    query: z.string().min(1).max(MAX_QUERY_LENGTH),
    types: z.array(MemoryTypeSchema).min(1).max(5).optional(),
    statuses: z.array(MemoryStatusSchema).min(1).max(6).optional(),
    /** Cap on injected hits (after the stale filter). */
    maxHits: z.number().int().min(1).max(63).default(32)
  }),
  /** Explicit opt-in to inject stale-flagged memories (labeled loudly). */
  includeStaleMemories: z.boolean().default(false)
});

export type AssembleContextBundleWithMemoryInput = z.input<typeof AssembleWithMemoryInputSchema>;

/**
 * Search (authorized) and assemble in one call. The `db` handle is taken
 * only for the underlying assembler; ALL memory reads flow through
 * `access`, so the injected set cannot exceed the session's scope.
 */
export function assembleContextBundleWithMemory(
  db: DatabaseSync,
  access: MemoryAccess,
  input: AssembleContextBundleWithMemoryInput
): ContextBundle {
  const value = AssembleWithMemoryInputSchema.parse(input);

  if (access.projectId !== value.projectId) {
    // The assembler would also refuse a foreign run; the authorization
    // layer refuses FIRST, before any content is read or assembled.
    throw new CrossProjectAccessError({ projectId: value.projectId });
  }

  const hits = access.search({
    query: value.memory.query,
    ...(value.memory.types === undefined ? {} : { types: [...value.memory.types] }),
    ...(value.memory.statuses === undefined
      ? {}
      : { statuses: [...value.memory.statuses] })
  });

  const admissible = (
    value.includeStaleMemories ? hits : hits.filter((hit) => !hit.stale)
  ).slice(0, value.memory.maxHits);

  const memoryEntries = admissible.map((hit) => ({
    memoryId: hit.id,
    version: hit.version,
    content: hit.content,
    sourceSha: hit.sourceSha,
    stale: hit.stale,
    staleReason: hit.staleReason
  }));

  const bundleInput: AssembleContextBundleInput = {
    ...value.bundle,
    projectId: value.projectId,
    memoryEntries,
    includeStaleMemories: value.includeStaleMemories
  };
  return assembleContextBundle(db, bundleInput);
}
