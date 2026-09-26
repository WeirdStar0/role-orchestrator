/**
 * @role-orchestrator/expand — public entry point (M4-03).
 *
 * Bounded repair + re-review graph expansion (docs/ACCEPTANCE.md A20,
 * docs/ORCHESTRATION.md section 5 返工不是有环图):
 *  - `requestReviewExpansion` — grounded on the M2-05 A12 query (a COMPLETED
 *    fail verdict for the EXACT candidateSha), appends a fix node + re-review
 *    node to the run's node set, re-validates the FULL composed graph with
 *    dag's validator BEFORE any write (acyclicity, duplicates, budgets), and
 *    commits the pair + expansion row + readiness propagation in ONE
 *    transaction. Idempotent per (run, failed review node, candidateSha).
 *  - `MAX_REVIEW_ROUNDS` (= 3, counting the first review) with the typed
 *    `ReviewRoundsExhaustedError` for the refused fourth round, after which
 *    the run is durably HELD for user disposition (`getRunUserHold`,
 *    `resolveRunHold`) — never auto-continued.
 *  - migration 013 (`review_expansions` + `expansion_user_holds`) via
 *    `applyExpandMigrations` / `EXPAND_MIGRATIONS` (composes 001..012).
 *
 * M5-02 adds the CONTROLLED surface used by UI/API callers (A04/A38):
 *  - `requestControlledExpansion` — the A04 permission gate (requester role
 *    must hold `canCreateSubtasks`, denials durably audited with the reason
 *    in `expansion_request_audit`, migration 017) and the A38 optimistic
 *    `expectedGraphRevision` gate, THEN delegation to
 *    `requestReviewExpansion` (all M4-03 guards preserved), a `granted`
 *    provenance audit row, and the append-only definition-history row
 *    (`task_graph_revisions`, source `'expansion'`, migrations 015+016) that
 *    keeps later edits coherent and invalidates stale clients;
 *  - `CONTROLLED_EXPANSION_MIGRATIONS` / `applyControlledExpansionMigrations`
 *    (001..013 + 015 + 016 + 017) for expansion-enabled composition roots.
 *
 * Minted nodes are ordinary task_nodes rows, so the existing scheduler dispatch
 * chain and the dag state machine (FAILED -> RETRY_PENDING -> READY) apply
 * unchanged, and the re-review node consumes the NEW candidateSha through the
 * M2-05 review protocol, to which the old fail never applies (A12).
 *
 * See README.md for the expansion protocol, the round accounting, the
 * acyclicity guarantee and the known boundaries.
 */
export * from "./errors.js";
export * from "./lineage.js";
export * from "./migration.js";
export * from "./expander.js";
export * from "./audit.js";
export * from "./controlled.js";
