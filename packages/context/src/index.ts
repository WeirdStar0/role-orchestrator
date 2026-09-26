/**
 * @role-orchestrator/context — public entry point (M3-01).
 *
 * Context bundles + manifests (docs/MEMORY_AND_CONTEXT.md):
 *  - layered assembly (project_rule / role / task / dependency) from the
 *    store and trusted configuration, every fragment carrying full
 *    provenance (source kind, id, revision / profile revision / commit SHA /
 *    artifact id);
 *  - an ordered, sha256-anchored manifest: bundle content hash, per-fragment
 *    content hashes, reverse traceability (traceFragment) and source lookup
 *    (findFragmentsBySource), verified by recomputation (verifyContextBundle);
 *  - byte-budget truncation that drops dependency -> task -> role fragments
 *    first and NEVER drops project rules — the excess is recorded, not
 *    hidden (manifest.budgetExceeded / manifest.omitted);
 *  - migration 007 (`context_bundles` + `bundle_fragments`) composed as
 *    `CONTEXT_MIGRATIONS = REVIEW_MIGRATIONS + 007`;
 *  - the A16 data-plane baseline: bundles are deeply frozen read-only data,
 *    and this package deliberately exposes NO function that turns bundle
 *    content into permissions, role bindings, profile selection or
 *    capability decisions — those always come from policy, bindings and the
 *    capability registry, never from context text.
 */
export * from "./errors.js";
export * from "./fragments.js";
export * from "./manifest.js";
export * from "./assemble.js";
export * from "./persist.js";
