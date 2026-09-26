/**
 * @role-orchestrator/memory-search — public entry point (M3-03).
 *
 * Retrieval, source-sha staleness and cross-project isolation over the
 * M3-02 shared memory (docs/MEMORY_AND_CONTEXT.md sections 5/6):
 *  - `openMemoryAccess` binds ONE authorized project; every retrieval, read
 *    and write entry point enforces it at the QUERY layer (WHERE
 *    project_id = authorized — never result filtering), and a foreign id
 *    is refused with a typed `CrossProjectAccessError` that discloses
 *    neither the foreign project nor its content (A15);
 *  - text retrieval: AND-tokenized SQL LIKE over the AUTHORITATIVE
 *    memories table (no shadow index — a drifted one would silently miss
 *    hits), statuses defaulting to verified+active; stale hits carry their
 *    explicit stale marks;
 *  - source-sha freshness: memories carry `sourceSha`; `checkSources` runs
 *    the resolver port (git adapter included) OUTSIDE the write
 *    transaction and persists explicit stale marks (`missing` /
 *    `superseded`) with an append-only `memory_source_checks` audit;
 *  - bundle integration: `assembleContextBundleWithMemory` injects
 *    retrieval hits into the M3-01 assembler as the `memory` layer —
 *    excluded by default when stale, loudly labeled when explicitly
 *    admitted, truncation-dropped FIRST, project rules never dropped, and
 *    every fragment traceable via memoryId + version + contentHash;
 *  - migrations 009 (source/staleness columns + checks table) and 010
 *    (forward-only bundle_fragments rebuild admitting the memory layer),
 *    composed as `MEMORY_SEARCH_MIGRATIONS = MEMORY_MIGRATIONS + 009 + 010`;
 *  - the A16 line held end-to-end: memory content is pure DATA. Nothing
 *    exported here turns content into permissions, role bindings, profile
 *    selection or capability decisions, and injection cannot weaken
 *    isolation — the authorization layer runs BEFORE any content moves.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./tokenize.js";
export * from "./rows.js";
export * from "./migration.js";
export * from "./access.js";
export * from "./resolver.js";
export * from "./inject.js";
