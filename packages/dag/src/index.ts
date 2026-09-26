/**
 * @role-orchestrator/dag — public entry point (M2-01).
 *
 * DAG validation and the node state machine (A03/A08):
 *  - `validateWorkflowPlan` / `parseWorkflowDefinition` / `validateWorkflowGraph`:
 *    graph legality (cycles, self dependencies, missing dependencies,
 *    duplicate node ids, unknown roles — each a distinct typed error) and the
 *    derived executable plan (topological order + depth). Rejection happens
 *    BEFORE any plan is returned and therefore before any CLI can start;
 *  - `resolvePlanRolesFromBindings` / `resolvePlanRolesFromRunSnapshot`:
 *    every role used by a plan pinned to one ProfileRevision, reusing
 *    runtime-profile's typed A01 rejection semantics (A03/A34);
 *  - the node state machine of `docs/ORCHESTRATION.md` section 3: state
 *    vocabulary, edge set, guarded `transitionNodeState` (optimistic
 *    `whereStateIn`), and blocked/ready propagation over frozen dependency
 *    snapshots (`computeReadinessTransitions` + `propagateNodeStates`);
 *  - RECOVERY_REQUIRED as a node state (A22) with the bridge from
 *    @role-orchestrator/reconcile outcomes (`nodeActionForReconcileOutcome`,
 *    `applyReconcileOutcomeToNode`) — decision logic stays in reconcile;
 *  - migration 003 (`task_nodes`: UNIQUE(run_id, node_id), state CHECK,
 *    dependency snapshot) via `applyDagMigrations` / `DAG_MIGRATIONS`;
 *  - M5-01 graph revisions (A38): the append-only `task_graph_revisions`
 *    history (migration 015, applied via `GRAPH_EDIT_MIGRATIONS` /
 *    `applyGraphEditMigrations`), the one-time baseline
 *    (`recordInitialGraphRevision`), and the guarded structural-edit
 *    primitive `applyGraphNodeEdit` — optimistic `expectedGraphRevision`
 *    lock (stale writers get `GraphRevisionConflictError`), edits only for
 *    PENDING/READY/BLOCKED nodes (`NodeNotEditableError` otherwise), and the
 *    full A08/A03/A02 re-validation BEFORE any row is written. Edits never
 *    start executions.
 *  - M5-02 expansion revisions (A38 失效传播): migration 016 widens the
 *    revision-row `source` vocabulary with `'expansion'` (applied via
 *    `GRAPH_EXPANSION_MIGRATIONS` / `applyGraphExpansionMigrations`) and
 *    `recordExpansionGraphRevision` appends a controlled expansion to the
 *    definition history under the same optimistic lock, so a later edit
 *    rebuilds from a workflow that still contains the minted nodes.
 *
 * See README.md for the transition table and the propagation rules.
 */
export * from "./errors.js";
export * from "./states.js";
export * from "./graph.js";
export * from "./roles.js";
export * from "./reconcile-bridge.js";
export * from "./migration.js";
export * from "./entities/task-nodes.js";
export * from "./entities/graph-revisions.js";
export {
  appliedMigrationRecords,
  applyMigrations,
  verifyMigrations,
  migrationChecksum,
  type MigrationDefinition,
  type ApplyMigrationsResult,
  type AppliedMigrationRecord,
  type VerifyMigrationsResult
} from "@role-orchestrator/store";
