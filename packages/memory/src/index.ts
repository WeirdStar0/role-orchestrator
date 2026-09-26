/**
 * @role-orchestrator/memory — public entry point (M3-02).
 *
 * Shared memory per `docs/MEMORY_AND_CONTEXT.md`:
 *  - the five canonical types (temporary/fact/discovery/decision/project_rule)
 *    with the frozen per-type 可提交者 write matrix of section 2;
 *  - the lifecycle proposed -> verified -> active with dispute/expire guards,
 *    every transition guarded, version-bumped and audited;
 *  - USER-only project_rule promotion through the explicit audited entry
 *    point `promoteProjectRule` (promoted_by/promoted_via/promoted_at) —
 *    a role actor, or directive text inside memory content, can never reach it;
 *  - A14 CAS: every update/verify/promote/dispute is a
 *    (memoryId, expectedVersion) compare-and-swap; a mismatch throws
 *    `MemoryCasConflictError` carrying the current version and content
 *    digest — never a silent overwrite — and the refusal is audited;
 *  - migration 008 (`memories` + `memory_revisions` + `memory_events`)
 *    composed as `MEMORY_MIGRATIONS = CONTEXT_MIGRATIONS + 008`;
 *  - the A16 line held end-to-end: memory content is pure DATA. This package
 *    exposes NO function that turns content into permissions, role bindings,
 *    profile selection or capability decisions; authorization comes only
 *    from the actor identity of the call plus the frozen permission matrix.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./hashing.js";
export * from "./migration.js";
export * from "./memories.js";
export * from "./queries.js";
