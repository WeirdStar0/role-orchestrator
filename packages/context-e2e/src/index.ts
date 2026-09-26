/**
 * @role-orchestrator/context-e2e — public entry point (M3-04).
 *
 * Cross-CLI context collaboration END-TO-END VERIFICATION: a pure test/
 * dogfood package (no product logic) that drives the M3-04 example
 *
 *   design (architect, fake-claude) -> consume (developer, fake-codex)
 *
 * through the REAL chain — dag validation -> scheduler dispatch claims ->
 * engine executions (fake-cli dist bin subprocesses) -> worktree isolation ->
 * authorized memory retrieval -> context bundle assembly + persistence ->
 * bundle-rendered prompt — and pins the M3-04 acceptance surface:
 *
 *  - the producer's structured artifact reaches the consumer ONLY as
 *    versioned, hash-anchored bundle fragments (manifest-traceable to
 *    artifact id + commit SHA + memoryId/version/contentHash);
 *  - NOTHING crosses the dialect boundary as session state: no session id,
 *    no credential-shaped string, no transcript text (negative assertions
 *    over the whole persisted surface of both executions);
 *  - the A36 diagnostic export (graph + events + bundles + memory
 *    references) passes the redact pipeline before the file sink and is
 *    verified secret-free;
 *  - the A15/A16 isolation semantics hold end-to-end: cross-project access
 *    is refused at the authorization layer without disclosure, and injected
 *    memory content stays DATA — it never moves bindings, profiles, rules
 *    or permissions.
 *
 * The world/driver reuse the e2e-baseline (M2-06) primitives: fixture repo,
 * fake-cli dist bin paths, sequence clock and the writer-commit stand-in.
 */
export * from "./errors.js";
export * from "./scenario.js";
export * from "./world.js";
export * from "./bundle-prompt.js";
export * from "./driver.js";
export * from "./diagnostic.js";
