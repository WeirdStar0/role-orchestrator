/**
 * @role-orchestrator/integration — public entry point (M2-04).
 *
 * Multi-parent baseline assembly and the single writer of a run's
 * `task/<run-id>` branch (docs/GIT_AND_WORKSPACES.md):
 *  - `integrateParents` — topologically ordered merge chain of the accepted
 *    parent outputs onto the integration branch (A09: the successor's
 *    structured inputSha set + candidateSha contain ALL parent outputs);
 *  - A10 conflict semantics — a conflicting merge persists PAUSED_CONFLICT
 *    (typed `IntegrationConflictError` + queryable record with the conflict
 *    file list) and preserves every branch and the conflict scene; no side is
 *    ever chosen, recovery is a later milestone;
 *  - A25 crash convergence — `reconcileIntegration` compares the persisted
 *    manifest (repo, branch, 预期 candidateSha, parent set) against real git
 *    state and backfills the DB or reports safe-to-retry WITHOUT ever
 *    duplicating a commit (deterministic merge-commit identity);
 *  - migration 005 (`integration_records`) via `applyIntegrationMigrations` /
 *    `INTEGRATION_MIGRATIONS` (store persistence selection, structured
 *    inputSha set + manifest columns);
 *  - the dag bridge — `applyIntegrationOutcomeToNode` /
 *    `assertNodeNotIntegrationPaused`: a paused integration blocks the
 *    successor and must never let the node be judged SUCCEEDED.
 *
 * See README.md for the protocol, the manifest structure and the known
 * boundaries.
 */
export * from "./errors.js";
export * from "./manifest.js";
export * from "./probe.js";
export * from "./record.js";
export * from "./integrate.js";
export * from "./reconcile.js";
export * from "./bridge.js";
