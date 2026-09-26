import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowDefinition } from "@role-orchestrator/contracts";
import { IdSchema, RoleIdSchema, WorkflowDefinitionSchema } from "@role-orchestrator/contracts";

import { getTaskRun, TimestampSchema, withTransaction } from "@role-orchestrator/store";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { DAG_MIGRATIONS } from "../migration.js";
import {
  GraphRevisionBaselineExistsError,
  GraphRevisionBaselineMismatchError,
  GraphRevisionBaselineMissingError,
  GraphRevisionConflictError,
  GraphRevisionIntegrityError,
  NodeNotEditableError,
  PlanRoleResolutionError,
  UnknownNodeError,
  UnknownRunError
} from "../errors.js";
import { parseWorkflowDefinition, validateWorkflowGraph, validateWorkflowPlan } from "../graph.js";
import type { ValidatedPlan } from "../graph.js";
import { resolvePlanRolesFromRunSnapshot } from "../roles.js";
import type { NodeState, NodeStateTransition } from "../states.js";
import { UnknownRunSnapshotError } from "@role-orchestrator/runtime-profile";
import {
  getNodeState,
  listRunNodes,
  propagateNodeStates,
  requireNodeState
} from "./task-nodes.js";
import type { TaskNodeRow } from "./task-nodes.js";

/**
 * M5-01 — task graph revisions (A38): append-only graph history plus the
 * guarded structural-edit primitive.
 *
 * Semantics pinned here (docs/ORCHESTRATION.md section 2, docs/PRD.md
 * "界面范围", docs/ACCEPTANCE.md A38):
 * - `task_runs.graph_revision` is the CURRENT revision; every graph change
 *   goes through an optimistic lock — the caller states the revision it saw
 *   (`expectedGraphRevision`) and the bump `UPDATE ... WHERE graph_revision =
 *   ?` lands only on that exact value. A stale writer changes ZERO rows and
 *   gets `GraphRevisionConflictError` — the same optimistic-guard pattern as
 *   `transitionNodeState`'s `whereStateIn`.
 * - History is APPEND-ONLY: each change inserts a NEW `task_graph_revisions`
 *   row carrying the full post-change `WorkflowDefinition` JSON. Existing
 *   rows are never updated or deleted, so any revision can be reconstructed
 *   and old execution evidence stays interpretable ("历史不被改写").
 * - Structural edits are accepted ONLY for nodes in EDITABLE_NODE_STATES
 *   (PENDING / READY / BLOCKED — the ask's "运行中（非 PENDING/READY/BLOCKED）
 *   节点拒绝结构编辑"). Everything else → `NodeNotEditableError` (A38 前半,
 *   surfaced as a typed 409 by the API layer).
 * - The edited graph is re-validated with `validateWorkflowPlan` (A08 cycle /
 *   self-dependency / missing dependency, A03 roles, A02 strict schema) and
 *   its roles re-resolved against the run's FROZEN profile snapshots (A34) —
 *   all BEFORE any row is written. Edits never start executions: the only
 *   state effects are the revision bump, the guarded task_nodes update and
 *   the blocked/ready re-propagation (which itself only ever touches
 *   PENDING/READY rows).
 * - The live `task_nodes` row of the edited node is updated under an
 *   `state IN (editable)` guard, so a node that began running between the
 *   checks and the write cannot be mutated (the transaction rolls back).
 * - `definition_revision` of the edited node moves to the new revision string,
 *   keeping the `executions UNIQUE(run_id, node_id, definition_revision,
 *   attempt)` evidence chain intact across edits.
 *
 * MIGRATION NOTE: revision rows need the `task_graph_revisions` table
 * (migration 015). The shipped `DAG_MIGRATIONS` list is deliberately left
 * UNCHANGED (every existing consumer chain pins its exact applied-version
 * postcondition); editing-enabled composition roots apply
 * `GRAPH_EDIT_MIGRATIONS` (= DAG_MIGRATIONS + 015) instead and call
 * `recordInitialGraphRevision` once at run creation. Without the baseline,
 * edits are refused with `GraphRevisionBaselineMissingError` — the full
 * workflow definition (objective/title/acceptanceCriteria) is required to
 * re-validate an edit and is NOT reconstructible from the task_nodes mirror.
 */

/**
 * Migration 015 — `task_graph_revisions` (M5-01, A38): one IMMUTABLE row per
 * graph revision. `revision` is UNIQUE per run; `source` distinguishes the
 * creation-time baseline from UI-driven node edits; `workflow` is the full
 * frozen contracts `WorkflowDefinition` JSON (`json_type = 'object'` CHECK
 * rejects non-objects and invalid JSON at the constraint level).
 *
 * FK NOTE: assumes migrations 001 (task_runs) and 003 (task_nodes) are
 * applied — apply via `GRAPH_EDIT_MIGRATIONS` / `applyGraphEditMigrations`.
 * No PRAGMA statements live in migrations (connection concerns are
 * `openDatabase`'s).
 */
const GRAPH_REVISIONS_SQL = `
CREATE TABLE task_graph_revisions (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source TEXT NOT NULL CHECK (source IN ('initial', 'ui-node-edit')),
  workflow TEXT NOT NULL CHECK (json_type(workflow) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, revision)
) STRICT;
`.trim();

export const GRAPH_REVISIONS_MIGRATION: MigrationDefinition = {
  version: 15,
  name: "015-task-graph-revisions",
  upSql: GRAPH_REVISIONS_SQL
};

/**
 * The migration list for EDITING-ENABLED consumers: everything `DAG_MIGRATIONS`
 * ships plus the revision table (015). `DAG_MIGRATIONS` itself stays exactly
 * as shipped so existing chains keep their pinned applied-version sets.
 */
export const GRAPH_EDIT_MIGRATIONS: readonly MigrationDefinition[] = [
  ...DAG_MIGRATIONS,
  GRAPH_REVISIONS_MIGRATION
];

export interface ApplyGraphEditMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `GRAPH_EDIT_MIGRATIONS` as the default list. */
export async function applyGraphEditMigrations(
  db: DatabaseSync,
  options: ApplyGraphEditMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? GRAPH_EDIT_MIGRATIONS
  });
}

// ---------------------------------------------------------------------------
// Editable states — the exact vocabulary the ask pins for M5-01.
// ---------------------------------------------------------------------------

/**
 * The node states whose definition may still be structurally edited: nothing
 * has started (PENDING/READY) or the branch is parked (BLOCKED — no attempt
 * exists to preserve evidence for). Every other state — RUNNING,
 * WAITING_APPROVAL, RETRY_PENDING, RECOVERY_REQUIRED, and the terminal
 * SUCCEEDED/FAILED/INTERRUPTED/CANCELLED — is refused (A38).
 */
export const EDITABLE_NODE_STATES = ["PENDING", "READY", "BLOCKED"] as const satisfies readonly NodeState[];

export function isNodeStructurallyEditable(state: NodeState): boolean {
  return (EDITABLE_NODE_STATES as readonly NodeState[]).includes(state);
}

// ---------------------------------------------------------------------------
// Revision rows
// ---------------------------------------------------------------------------

export type GraphRevisionSource = "initial" | "ui-node-edit" | "expansion";

export interface TaskGraphRevisionRow {
  readonly runId: string;
  readonly revision: number;
  readonly source: GraphRevisionSource;
  /** The full frozen contracts workflow definition recorded at this revision. */
  readonly workflow: WorkflowDefinition;
  readonly createdAt: string;
}

const GraphRevisionSourceSchema = z.enum(["initial", "ui-node-edit", "expansion"]);

function mapGraphRevisionRow(row: Record<string, unknown>): TaskGraphRevisionRow {
  const runId = z.string().min(1).parse(row["run_id"]);
  const revision = z.number().int().min(0).parse(row["revision"]);
  const source = GraphRevisionSourceSchema.parse(row["source"]);
  const createdAt = z.string().min(1).parse(row["created_at"]);
  let parsedWorkflow: unknown;
  try {
    parsedWorkflow = JSON.parse(z.string().min(1).parse(row["workflow"])) as unknown;
  } catch (error) {
    throw new GraphRevisionIntegrityError(
      runId,
      revision,
      `graph revision ${String(revision)} of run "${runId}" is not valid JSON`,
      { cause: error }
    );
  }
  const workflow = WorkflowDefinitionSchema.safeParse(parsedWorkflow);
  if (!workflow.success) {
    throw new GraphRevisionIntegrityError(
      runId,
      revision,
      `graph revision ${String(revision)} of run "${runId}" does not match the frozen workflow schema`,
      { cause: workflow.error }
    );
  }
  return { runId, revision, source, workflow: workflow.data, createdAt };
}

/** The latest revision row of a run, or `null` when no baseline was recorded. */
export function getLatestGraphRevision(
  db: DatabaseSync,
  runId: string
): TaskGraphRevisionRow | null {
  const parsedRunId = IdSchema.parse(runId);
  const row = db
    .prepare(
      "SELECT run_id, revision, source, workflow, created_at FROM task_graph_revisions " +
        "WHERE run_id = ? ORDER BY revision DESC LIMIT 1"
    )
    .get(parsedRunId);
  return row === undefined ? null : mapGraphRevisionRow(row as Record<string, unknown>);
}

/** All revision rows of a run, oldest (baseline) first — the append-only history. */
export function listGraphRevisions(db: DatabaseSync, runId: string): readonly TaskGraphRevisionRow[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare(
      "SELECT run_id, revision, source, workflow, created_at FROM task_graph_revisions " +
        "WHERE run_id = ? ORDER BY revision ASC"
    )
    .all(parsedRunId);
  return (rows as Record<string, unknown>[]).map(mapGraphRevisionRow);
}

function insertGraphRevisionRow(
  db: DatabaseSync,
  input: {
    readonly runId: string;
    readonly revision: number;
    readonly source: GraphRevisionSource;
    readonly workflow: WorkflowDefinition;
    readonly now: string;
  }
): void {
  db.prepare(
    "INSERT INTO task_graph_revisions(run_id, revision, source, workflow, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(
    input.runId,
    input.revision,
    input.source,
    JSON.stringify(input.workflow),
    input.now
  );
}

// ---------------------------------------------------------------------------
// Baseline — the one-time seal of the run's initial graph definition.
// ---------------------------------------------------------------------------

const RecordBaselineInputSchema = z.strictObject({
  runId: IdSchema,
  /** RAW workflow input; validated (A03/A08/A02) BEFORE anything is written. */
  workflow: z.unknown(),
  now: TimestampSchema
});

export type RecordInitialGraphRevisionInput = z.input<typeof RecordBaselineInputSchema>;

/**
 * Record the run's INITIAL graph definition as its baseline revision row
 * (source "initial") at the run's current `graph_revision`. Composition roots
 * call this ONCE, right after `createRunGraph`, to enable UI editing; without
 * a baseline every edit is refused (`GraphRevisionBaselineMissingError`),
 * because re-validating an edit needs the full definition, not just the
 * role/dependency mirror in `task_nodes`.
 *
 * Refuses (before any write): unknown runs; an existing baseline
 * (exactly-once); invalid graphs; a workflow that does not EXACTLY match the
 * live task_nodes rows (same node set, same roles, same dependency snapshots)
 * — a baseline that diverged from the executable state would silently
 * legitimize wrong edits.
 */
export function recordInitialGraphRevision(
  db: DatabaseSync,
  input: RecordInitialGraphRevisionInput
): TaskGraphRevisionRow {
  const parsed = RecordBaselineInputSchema.parse(input);
  const run = getTaskRun(db, parsed.runId);
  if (run === null) {
    throw new UnknownRunError(parsed.runId);
  }
  return withTransaction(db, () => {
    const existing = getLatestGraphRevision(db, parsed.runId);
    if (existing !== null) {
      throw new GraphRevisionBaselineExistsError(parsed.runId, existing.revision);
    }
    // Parse first (frozen schema — typed A03/A02 rejections), then derive the
    // plan (typed A08 rejections). The PARSED definition — not the widened
    // plan view — is what gets recorded, so the baseline round-trips through
    // the exact schema every later edit re-validates against.
    const parsedDefinition = parseWorkflowDefinition(parsed.workflow);
    const plan = validateWorkflowGraph(parsedDefinition);
    assertPlanMatchesLiveRows(db, parsed.runId, plan);
    insertGraphRevisionRow(db, {
      runId: parsed.runId,
      revision: run.graphRevision,
      source: "initial",
      workflow: parsedDefinition,
      now: parsed.now
    });
    const recorded = getLatestGraphRevision(db, parsed.runId);
    if (recorded === null) {
      throw new GraphRevisionIntegrityError(
        parsed.runId,
        run.graphRevision,
        `baseline insert for run "${parsed.runId}" did not persist`
      );
    }
    return recorded;
  });
}

/** The baseline must describe the live rows EXACTLY (node set, roles, dependency snapshots). */
function assertPlanMatchesLiveRows(db: DatabaseSync, runId: string, plan: ValidatedPlan): void {
  const rows = listRunNodes(db, runId);
  if (rows.length !== plan.nodes.length) {
    throw new GraphRevisionBaselineMismatchError(
      runId,
      `the workflow declares ${String(plan.nodes.length)} node(s) but the run has ${String(rows.length)} task_nodes row(s)`
    );
  }
  const byNodeId = new Map(rows.map((row) => [row.nodeId, row]));
  for (const node of plan.nodes) {
    const row = byNodeId.get(node.id);
    if (row === undefined) {
      throw new GraphRevisionBaselineMismatchError(runId, `node "${node.id}" has no task_nodes row`);
    }
    if (row.roleId !== node.role) {
      throw new GraphRevisionBaselineMismatchError(
        runId,
        `node "${node.id}" is ${row.roleId} in task_nodes but ${node.role} in the workflow`
      );
    }
    const rowDeps = [...row.dependencies].sort();
    const planDeps = [...node.dependencies].sort();
    if (rowDeps.length !== planDeps.length || rowDeps.some((dep, index) => dep !== planDeps[index])) {
      throw new GraphRevisionBaselineMismatchError(
        runId,
        `dependency snapshot of node "${node.id}" differs between task_nodes and the workflow`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The guarded structural-edit primitive (A38 + A08-before-write).
// ---------------------------------------------------------------------------

const NodeEditPatchSchema = z
  .strictObject({
    role: RoleIdSchema.optional(),
    objective: z.string().min(1).max(10000).optional(),
    dependencies: z.array(IdSchema).max(63).optional()
  })
  .refine(
    (patch) =>
      patch.role !== undefined || patch.objective !== undefined || patch.dependencies !== undefined,
    { message: "a node edit must change at least one of role/objective/dependencies" }
  );

const GraphNodeEditInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  /** Optimistic lock (A38): the revision the caller saw; must be the current one. */
  expectedGraphRevision: z.number().int().min(0),
  patch: NodeEditPatchSchema,
  now: TimestampSchema
});

export type GraphNodeEditInput = z.input<typeof GraphNodeEditInputSchema>;

export interface RunGraphEditResult {
  readonly runId: string;
  /** The new CURRENT revision (expected + 1). */
  readonly revision: number;
  /** The edited node's live row (updated definition_revision/role/dependencies). */
  readonly node: TaskNodeRow;
  /** The full post-edit workflow recorded in the new revision row. */
  readonly workflow: WorkflowDefinition;
  /** Blocked/ready transitions the re-propagation applied after the edit. */
  readonly transitions: readonly NodeStateTransition[];
}

/**
 * Apply ONE structural node edit under the A38 optimistic lock.
 *
 * Order of operations (everything before step 6 is read-only, so a rejection
 * leaves zero rows behind — "落库前拒绝"):
 *   1. strict input parsing (unknown patch fields refused — the dag layer of
 *      the A02 three-layer rejection);
 *   2. run must exist; a recorded revision baseline must exist;
 *   3. `expectedGraphRevision` must equal the current `graph_revision`
 *      (`GraphRevisionConflictError` otherwise — stale writers never merge);
 *   4. the node must exist and be in an editable state
 *      (`NodeNotEditableError` otherwise — A38 前半);
 *   5. the FULL post-edit workflow is rebuilt and re-validated
 *      (`validateWorkflowPlan`: A08 cycle/self-dependency/missing-dependency,
 *      A03 roles, A02 strict schema) and its roles re-resolved against the
 *      run's FROZEN profile snapshots (A34 — a role the run never pinned is
 *      refused instead of silently re-binding);
 *   6. ONE transaction: optimistic `graph_revision` bump guarded on the
 *      expected value, the node's live row updated under an editable-state
 *      guard, the new revision row appended, blocked/ready re-propagated.
 *
 * This function NEVER creates an execution or touches the scheduler queue —
 * starting work remains the existing scheduling chain's decision.
 */
export function applyGraphNodeEdit(db: DatabaseSync, input: GraphNodeEditInput): RunGraphEditResult {
  const parsed = GraphNodeEditInputSchema.parse(input);
  if (getTaskRun(db, parsed.runId) === null) {
    throw new UnknownRunError(parsed.runId);
  }
  return withTransaction(db, () => {
    const baseline = getLatestGraphRevision(db, parsed.runId);
    if (baseline === null) {
      throw new GraphRevisionBaselineMissingError(parsed.runId);
    }
    const run = getTaskRun(db, parsed.runId);
    if (run === null) {
      throw new UnknownRunError(parsed.runId);
    }
    if (run.graphRevision !== parsed.expectedGraphRevision) {
      throw new GraphRevisionConflictError(parsed.runId, parsed.expectedGraphRevision, run.graphRevision);
    }
    const node = getNodeState(db, { runId: parsed.runId, nodeId: parsed.nodeId });
    if (node === null) {
      throw new UnknownNodeError(parsed.runId, parsed.nodeId);
    }
    if (!isNodeStructurallyEditable(node.state)) {
      throw new NodeNotEditableError(parsed.runId, parsed.nodeId, node.state);
    }

    const patch = parsed.patch;
    const newDefinitions = baseline.workflow.nodes.map(
      (definition): WorkflowDefinition["nodes"][number] => {
        if (definition.id !== parsed.nodeId) return definition;
        return {
          ...definition,
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
          ...(patch.dependencies !== undefined ? { dependencies: [...patch.dependencies] } : {})
        };
      }
    );
    const newWorkflow: WorkflowDefinition = {
      id: baseline.workflow.id,
      name: baseline.workflow.name,
      nodes: newDefinitions
    };

    // A08/A03/A02 — the full post-edit graph is rejected BEFORE any write.
    const plan = validateWorkflowPlan(newWorkflow);
    resolveRolesForEdit(db, parsed.runId, plan);

    const newRevision = parsed.expectedGraphRevision + 1;

    // The authoritative optimistic gate: the bump lands only on the exact
    // revision the caller saw.
    const bump = db
      .prepare(
        "UPDATE task_runs SET graph_revision = graph_revision + 1 WHERE id = ? AND graph_revision = ?"
      )
      .run(parsed.runId, parsed.expectedGraphRevision);
    if (Number(bump.changes) !== 1) {
      const current = getTaskRun(db, parsed.runId);
      throw new GraphRevisionConflictError(
        parsed.runId,
        parsed.expectedGraphRevision,
        current?.graphRevision ?? -1
      );
    }

    // The live row update carries its own editable-state guard: if the node
    // began running between the check and this write, ZERO rows change and
    // the whole transaction rolls back.
    const editableList = EDITABLE_NODE_STATES.map((state) => `'${state}'`).join(", ");
    const edited = newDefinitions.find((definition) => definition.id === parsed.nodeId);
    if (edited === undefined) {
      throw new UnknownNodeError(parsed.runId, parsed.nodeId);
    }
    const updated = db
      .prepare(
        `UPDATE task_nodes SET definition_revision = ?, role_id = ?, dependencies = ?, updated_at = ? ` +
          `WHERE run_id = ? AND node_id = ? AND state IN (${editableList})`
      )
      .run(
        String(newRevision),
        edited.role,
        JSON.stringify(edited.dependencies),
        parsed.now,
        parsed.runId,
        parsed.nodeId
      );
    if (Number(updated.changes) !== 1) {
      const current = getNodeState(db, { runId: parsed.runId, nodeId: parsed.nodeId });
      throw new NodeNotEditableError(
        parsed.runId,
        parsed.nodeId,
        current?.state ?? node.state
      );
    }

    insertGraphRevisionRow(db, {
      runId: parsed.runId,
      revision: newRevision,
      source: "ui-node-edit",
      workflow: newWorkflow,
      now: parsed.now
    });

    // Keep blocked/ready consistent with the NEW dependency snapshot. The
    // propagation only ever touches PENDING/READY rows (never RUNNING/...),
    // so it cannot turn the just-refused states into edits.
    const transitions = propagateNodeStates(db, { runId: parsed.runId, now: parsed.now });

    return {
      runId: parsed.runId,
      revision: newRevision,
      node: requireNodeState(db, { runId: parsed.runId, nodeId: parsed.nodeId }),
      workflow: newWorkflow,
      transitions
    };
  });
}

/**
 * Snapshot-mode role resolution for edits (A34): every role of the post-edit
 * plan must resolve from the run's FROZEN profile snapshots. A role the run
 * never pinned is a typed rejection (mapped to "missing"), NOT a silent
 * re-binding against current project bindings.
 */
function resolveRolesForEdit(db: DatabaseSync, runId: string, plan: ValidatedPlan): void {
  try {
    resolvePlanRolesFromRunSnapshot(db, { runId, plan });
  } catch (error) {
    if (error instanceof UnknownRunSnapshotError) {
      const run = getTaskRun(db, runId);
      throw new PlanRoleResolutionError(
        "missing",
        run?.projectId ?? runId,
        error.roleId ?? "unknown",
        { cause: error }
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// M5-02 — expansion revisions: migration 016 + the guarded append primitive.
//
// A controlled graph expansion (docs/ACCEPTANCE.md A04/A38, M5-02) appends
// healing nodes as ordinary `task_nodes` rows through @role-orchestrator/expand.
// To keep the definition history coherent — a LATER ui-node-edit rebuilds the
// post-edit workflow from the LATEST revision row — the expansion must also
// land as an append-only revision row. That requires a third `source`
// vocabulary value, and CHECK constraints cannot be widened in place:
// migration 016 rebuilds the table exactly like migration 010 did for
// `bundle_fragments` (create widened copy -> INSERT SELECT -> drop -> rename).
// ---------------------------------------------------------------------------

/**
 * Migration 016 — widen `task_graph_revisions.source` with `'expansion'`
 * (M5-02). Column set, types, STRICT-ness and UNIQUE(run_id, revision) are
 * IDENTICAL to migration 015; only the CHECK vocabulary grows. Every existing
 * row is preserved verbatim by the INSERT..SELECT, so a database upgraded by
 * this migration keeps its full revision history.
 *
 * FK NOTE: assumes migration 015 is applied (`task_graph_revisions` exists).
 * Shipped SEPARATELY from `GRAPH_EDIT_MIGRATIONS` — whose applied-version
 * postcondition existing consumers pin — via `GRAPH_EXPANSION_MIGRATIONS` /
 * `applyGraphExpansionMigrations`. No PRAGMA statements live in migrations.
 */
const GRAPH_REVISIONS_EXPANSION_SOURCE_SQL = `
CREATE TABLE task_graph_revisions_widened (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source TEXT NOT NULL CHECK (source IN ('initial', 'ui-node-edit', 'expansion')),
  workflow TEXT NOT NULL CHECK (json_type(workflow) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, revision)
) STRICT;

INSERT INTO task_graph_revisions_widened (run_id, revision, source, workflow, created_at)
SELECT run_id, revision, source, workflow, created_at FROM task_graph_revisions;

DROP TABLE task_graph_revisions;

ALTER TABLE task_graph_revisions_widened RENAME TO task_graph_revisions;
`.trim();

export const GRAPH_REVISIONS_EXPANSION_SOURCE_MIGRATION: MigrationDefinition = {
  version: 16,
  name: "016-graph-revision-expansion-source",
  upSql: GRAPH_REVISIONS_EXPANSION_SOURCE_SQL
};

/**
 * The migration list for EXPANSION-ENABLED consumers: everything
 * `GRAPH_EDIT_MIGRATIONS` ships plus the widened revision source (016).
 * `GRAPH_EDIT_MIGRATIONS` itself stays exactly as shipped so existing chains
 * keep their pinned applied-version sets.
 */
export const GRAPH_EXPANSION_MIGRATIONS: readonly MigrationDefinition[] = [
  ...GRAPH_EDIT_MIGRATIONS,
  GRAPH_REVISIONS_EXPANSION_SOURCE_MIGRATION
];

export interface ApplyGraphExpansionMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `GRAPH_EXPANSION_MIGRATIONS` as the default list. */
export async function applyGraphExpansionMigrations(
  db: DatabaseSync,
  options: ApplyGraphExpansionMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? GRAPH_EXPANSION_MIGRATIONS
  });
}

const ExpansionRevisionInputSchema = z.strictObject({
  runId: IdSchema,
  /** RAW post-expansion workflow; validated (A08/A02/A03) BEFORE any write. */
  workflow: z.unknown(),
  /** Optimistic lock (A38): the revision the caller read as current. */
  expectedGraphRevision: z.number().int().min(0),
  now: TimestampSchema
});

export type RecordExpansionGraphRevisionInput = z.input<typeof ExpansionRevisionInputSchema>;

/**
 * Append ONE graph revision row for a controlled expansion (M5-02, A38) and
 * bump `task_runs.graph_revision` under the same optimistic lock the node
 * edit uses: the bump lands only on the exact `expectedGraphRevision`, so a
 * stale expansion recording changes ZERO rows and gets
 * `GraphRevisionConflictError` (the caller re-reads the current revision,
 * recomposes the append-only workflow and retries — expansions are pure
 * appends, so recomposition on top of any newer revision is lossless).
 *
 * Order of operations (read-only until step 3):
 *   1. strict input parsing; run must exist; a revision baseline must exist
 *      (an expansion without a baseline cannot be appended to history);
 *   2. the RAW workflow is parsed and graph-checked (A08 cycle / self- /
 *      missing dependency, A03 roles, A02 strict schema, node+depth budgets);
 *   3. ONE transaction: guarded `graph_revision` bump, then the append-only
 *      revision row (source `'expansion'`).
 *
 * Roles are deliberately NOT re-resolved against profile snapshots here
 * (unlike `applyGraphNodeEdit`): an expansion can never introduce a new role —
 * the minted fix reuses the repaired node's pinned role and the re-review node
 * is a reviewer, both already present in the run's frozen snapshots.
 *
 * This function NEVER creates an execution or touches the scheduler queue.
 */
export function recordExpansionGraphRevision(
  db: DatabaseSync,
  input: RecordExpansionGraphRevisionInput
): TaskGraphRevisionRow {
  const parsed = ExpansionRevisionInputSchema.parse(input);
  if (getTaskRun(db, parsed.runId) === null) {
    throw new UnknownRunError(parsed.runId);
  }
  if (getLatestGraphRevision(db, parsed.runId) === null) {
    throw new GraphRevisionBaselineMissingError(parsed.runId);
  }
  const parsedDefinition = parseWorkflowDefinition(parsed.workflow);
  validateWorkflowGraph(parsedDefinition);
  return withTransaction(db, () => {
    const run = getTaskRun(db, parsed.runId);
    if (run === null) {
      throw new UnknownRunError(parsed.runId);
    }
    if (run.graphRevision !== parsed.expectedGraphRevision) {
      throw new GraphRevisionConflictError(
        parsed.runId,
        parsed.expectedGraphRevision,
        run.graphRevision
      );
    }
    const newRevision = parsed.expectedGraphRevision + 1;
    const bump = db
      .prepare(
        "UPDATE task_runs SET graph_revision = graph_revision + 1 WHERE id = ? AND graph_revision = ?"
      )
      .run(parsed.runId, parsed.expectedGraphRevision);
    if (Number(bump.changes) !== 1) {
      const current = getTaskRun(db, parsed.runId);
      throw new GraphRevisionConflictError(
        parsed.runId,
        parsed.expectedGraphRevision,
        current?.graphRevision ?? -1
      );
    }
    insertGraphRevisionRow(db, {
      runId: parsed.runId,
      revision: newRevision,
      source: "expansion",
      workflow: parsedDefinition,
      now: parsed.now
    });
    const recorded = getLatestGraphRevision(db, parsed.runId);
    if (recorded === null) {
      throw new GraphRevisionIntegrityError(
        parsed.runId,
        newRevision,
        `expansion revision insert for run "${parsed.runId}" did not persist`
      );
    }
    return recorded;
  });
}
