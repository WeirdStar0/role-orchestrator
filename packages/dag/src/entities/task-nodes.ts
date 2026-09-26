import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import {
  NoRowUpdatedError,
  getTaskRun,
  isUniqueViolation,
  withTransaction,
  type Row
} from "@role-orchestrator/store";
import { reqStr, TimestampSchema } from "@role-orchestrator/store";
import type { ReconcileOutcome } from "@role-orchestrator/reconcile";
import {
  DuplicateRunNodeError,
  IllegalNodeTransitionError,
  NodeSnapshotIntegrityError,
  UnknownNodeError,
  UnknownRunError
} from "../errors.js";
import { validateWorkflowPlan } from "../graph.js";
import type { ValidatedPlan } from "../graph.js";
import { resolvePlanRolesFromRunSnapshot } from "../roles.js";
import type { PlanRoleResolution } from "../roles.js";
import { nodeActionForReconcileOutcome } from "../reconcile-bridge.js";
import { assertNodeTransition, computeReadinessTransitions } from "../states.js";
import type { NodeState, NodeStateTransition, NodeStateView } from "../states.js";
import { NodeStateSchema } from "../states.js";

/**
 * `task_nodes` — node-level state persistence (migration 003, M2-01).
 *
 * Convention note: like every store-era entity function in this repo, these
 * helpers JOIN an open transaction when called inside `withTransaction` and
 * otherwise autocommit. Service-level atomicity is composed by the caller
 * (`createRunGraph` wraps its inserts + first propagation in ONE
 * transaction); `propagateNodeStates` recomputes from current states, so a
 * crashed non-transactional pass simply converges on the next run.
 */

export interface TaskNodeRow {
  readonly runId: string;
  readonly nodeId: string;
  readonly definitionRevision: string;
  readonly roleId: RoleId;
  /** Frozen dependency snapshot (parsed from the stored JSON array). */
  readonly dependencies: readonly string[];
  readonly state: NodeState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const DependenciesJsonSchema = z.array(IdSchema).max(63);

function parseDependenciesJson(raw: string, runId: string, nodeId: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new NodeSnapshotIntegrityError(
      runId,
      nodeId,
      `dependency snapshot of node "${nodeId}" in run "${runId}" is not valid JSON`,
      { cause: error }
    );
  }
  const result = DependenciesJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new NodeSnapshotIntegrityError(
      runId,
      nodeId,
      `dependency snapshot of node "${nodeId}" in run "${runId}" does not match the stored schema (expected a JSON array of node ids)`,
      { cause: result.error }
    );
  }
  return result.data;
}

function mapTaskNodeRow(row: Row): TaskNodeRow {
  const runId = reqStr(row, "run_id");
  const nodeId = reqStr(row, "node_id");
  return {
    runId,
    nodeId,
    definitionRevision: reqStr(row, "definition_revision"),
    roleId: RoleIdSchema.parse(reqStr(row, "role_id")),
    dependencies: parseDependenciesJson(reqStr(row, "dependencies"), runId, nodeId),
    state: NodeStateSchema.parse(reqStr(row, "state")),
    createdAt: reqStr(row, "created_at"),
    updatedAt: reqStr(row, "updated_at")
  };
}

const CreateRunGraphInputSchema = z.strictObject({
  runId: IdSchema,
  /** RAW workflow input; validated (A03/A08) BEFORE anything is written. */
  workflow: z.unknown(),
  definitionRevision: z.string().min(1).max(128).default("1"),
  now: TimestampSchema
});

export type CreateRunGraphInput = z.input<typeof CreateRunGraphInputSchema>;

export interface RunGraph {
  readonly runId: string;
  readonly definitionRevision: string;
  readonly plan: ValidatedPlan;
  /** Role -> pinned ProfileRevision for every role the plan uses. */
  readonly resolvedRoles: readonly PlanRoleResolution[];
  /** Persisted node rows, topological order; the first propagation applied. */
  readonly nodes: readonly TaskNodeRow[];
  /** Transitions the initial propagation applied (entry nodes -> READY). */
  readonly initialTransitions: readonly NodeStateTransition[];
}

/**
 * Create a run's node graph: THE pre-start gate. Order of operations is the
 * safety property:
 *
 * 1. `validateWorkflowPlan` (pure) — A08 graph legality + A03 roles; any
 *    rejection happens BEFORE any database write and therefore before any
 *    spawn-capable state exists;
 * 2. the run must exist and every role used by the plan must resolve from
 *    its FROZEN profile snapshots (A34) — typed failures, still no writes;
 * 3. all task_nodes rows (initial state PENDING, dependency snapshots frozen)
 *    plus the first blocked/ready propagation commit in ONE transaction.
 *
 * There is deliberately no partial graph: a rejected or failing creation
 * leaves zero rows behind.
 */
export function createRunGraph(db: DatabaseSync, input: CreateRunGraphInput): RunGraph {
  const value = CreateRunGraphInputSchema.parse(input);
  const plan = validateWorkflowPlan(value.workflow);
  if (getTaskRun(db, value.runId) === null) {
    throw new UnknownRunError(value.runId);
  }
  const resolvedRoles = resolvePlanRolesFromRunSnapshot(db, { runId: value.runId, plan });

  return withTransaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)"
    );
    for (const node of plan.nodes) {
      try {
        insert.run(
          value.runId,
          node.id,
          value.definitionRevision,
          node.role,
          JSON.stringify(node.dependencies),
          value.now,
          value.now
        );
      } catch (error) {
        if (isUniqueViolation(error, "task_nodes.run_id, task_nodes.node_id")) {
          throw new DuplicateRunNodeError(value.runId, node.id, { cause: error });
        }
        throw error;
      }
    }
    const initialTransitions = propagateNodeStates(db, { runId: value.runId, now: value.now });
    return {
      runId: value.runId,
      definitionRevision: value.definitionRevision,
      plan,
      resolvedRoles,
      nodes: listRunNodes(db, value.runId),
      initialTransitions
    };
  });
}

export function getNodeState(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): TaskNodeRow | null {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const row = db
    .prepare("SELECT * FROM task_nodes WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId);
  return row === undefined ? null : mapTaskNodeRow(row);
}

/** Read a node or fail with the typed "unknown node reference" error. */
export function requireNodeState(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): TaskNodeRow {
  const node = getNodeState(db, input);
  if (node === null) {
    throw new UnknownNodeError(input.runId, input.nodeId);
  }
  return node;
}

/** All node rows of a run in topological creation order (insert order, stable by node id). */
export function listRunNodes(db: DatabaseSync, runId: string): readonly TaskNodeRow[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare("SELECT * FROM task_nodes WHERE run_id = ? ORDER BY created_at ASC, node_id ASC")
    .all(parsedRunId);
  return rows.map(mapTaskNodeRow);
}

const TransitionInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  to: NodeStateSchema,
  /**
   * Optimistic guard: the states the row must currently be in for the UPDATE
   * to land. Defaults to the legal FSM predecessors of `to`, so a caller that
   * omits it can still never drive an illegal transition.
   */
  whereStateIn: z.array(NodeStateSchema).max(11).optional(),
  now: TimestampSchema
});

export type TransitionNodeStateInput = z.input<typeof TransitionInputSchema>;

/**
 * Apply ONE node-state transition with an optimistic `whereStateIn` guard:
 * `UPDATE ... WHERE run_id = ? AND node_id = ? AND state IN (...)`. A stale
 * writer (the row moved on concurrently) affects ZERO rows and is rejected —
 * never overwritten.
 *
 * Zero affected rows are classified by re-reading the row: unknown node ->
 * `NoRowUpdatedError`; row present but outside the guard set ->
 * `IllegalNodeTransitionError` carrying the current state. (The UPDATE guard
 * stays authoritative for the success path; the re-read only makes the
 * failure precise.)
 */
export function transitionNodeState(db: DatabaseSync, input: TransitionNodeStateInput): TaskNodeRow {
  const parsed = TransitionInputSchema.parse(input);
  const guard = parsed.whereStateIn ?? legalPredecessorDefaults(parsed.to);
  for (const from of guard) {
    assertNodeTransition(from, parsed.to);
  }
  const stateList = guard.map((state) => `'${state}'`).join(", ");
  const result = db
    .prepare(
      `UPDATE task_nodes SET state = ?, updated_at = ? ` +
        `WHERE run_id = ? AND node_id = ? AND state IN (${stateList})`
    )
    .run(parsed.to, parsed.now, parsed.runId, parsed.nodeId);
  if (Number(result.changes) !== 1) {
    const current = getNodeState(db, { runId: parsed.runId, nodeId: parsed.nodeId });
    if (current === null) {
      throw new NoRowUpdatedError(
        `node "${parsed.nodeId}" does not exist in run "${parsed.runId}"`
      );
    }
    throw new IllegalNodeTransitionError(current.state, parsed.to);
  }
  return requireNodeState(db, { runId: parsed.runId, nodeId: parsed.nodeId });
}

function legalPredecessorDefaults(to: NodeState): readonly NodeState[] {
  const predecessors: NodeState[] = [];
  for (const state of NODE_STATE_POOL) {
    try {
      assertNodeTransition(state, to);
      predecessors.push(state);
    } catch {
      // not a legal predecessor — skip
    }
  }
  return predecessors;
}

// The full state vocabulary (avoids importing NODE_STATES here only to keep
// the list single-sourced in states.ts — NodeStateSchema derives from it).
const NODE_STATE_POOL: readonly NodeState[] = NodeStateSchema.options;

const PropagateInputSchema = z.strictObject({
  runId: IdSchema,
  now: TimestampSchema
});

export type PropagateNodeStatesInput = z.input<typeof PropagateInputSchema>;

/**
 * Recompute blocked/ready propagation for a run and apply the resulting
 * transitions with per-node `whereStateIn: [from]` guards. The stored views
 * are re-sorted into dependency (topological) order first — the pure
 * computation needs one topological pass so blocked propagates transitively.
 * Runs inside the caller's transaction when one is open (see module note).
 */
export function propagateNodeStates(
  db: DatabaseSync,
  input: PropagateNodeStatesInput
): readonly NodeStateTransition[] {
  const parsed = PropagateInputSchema.parse(input);
  if (getTaskRun(db, parsed.runId) === null) {
    throw new UnknownRunError(parsed.runId);
  }
  const rows = listRunNodes(db, parsed.runId);
  const views = topologicalViews(
    rows.map((row) => ({
      nodeId: row.nodeId,
      state: row.state,
      dependencies: row.dependencies
    }))
  );
  const transitions = computeReadinessTransitions({ nodes: views });
  for (const transition of transitions) {
    transitionNodeState(db, {
      runId: parsed.runId,
      nodeId: transition.nodeId,
      to: transition.to,
      whereStateIn: [transition.from],
      now: parsed.now
    });
  }
  return transitions;
}

/**
 * Stable Kahn ordering of stored node views (node id ascending breaks ties).
 * Unreachable leftovers of a tampered dependency snapshot (a cycle in stored
 * data) are appended unchanged so no view is silently dropped; the readiness
 * computation treats an unknown dependency as "not succeeded" and stays
 * fail-closed.
 */
function topologicalViews(views: readonly NodeStateView[]): readonly NodeStateView[] {
  const byId = new Map<string, NodeStateView>(views.map((view) => [view.nodeId, view]));
  const remaining = new Map<string, number>(
    views.map((view) => [
      view.nodeId,
      new Set(view.dependencies.filter((dep) => byId.has(dep))).size
    ])
  );
  const ready = views
    .filter((view) => remaining.get(view.nodeId) === 0)
    .map((view) => view.nodeId)
    .sort();
  const ordered: NodeStateView[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    const view = byId.get(id);
    if (view === undefined) {
      continue;
    }
    ordered.push(view);
    emitted.add(id);
    for (const other of views) {
      if (!emitted.has(other.nodeId) && other.dependencies.includes(id)) {
        const left = remaining.get(other.nodeId) ?? 1;
        remaining.set(other.nodeId, left - 1);
        if (left - 1 === 0) {
          ready.push(other.nodeId);
          ready.sort();
        }
      }
    }
  }
  for (const view of views) {
    if (!emitted.has(view.nodeId)) {
      ordered.push(view);
    }
  }
  return ordered;
}

const ReconcileApplyInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  outcome: z.string().min(1).max(64),
  now: TimestampSchema
});

export type ApplyReconcileOutcomeInput = z.input<typeof ReconcileApplyInputSchema>;

/**
 * Apply a reconcile decision (see `reconcile-bridge.ts`) to a node:
 * interrupted -> RUNNING->INTERRUPTED, recovery-required ->
 * INTERRUPTED->RECOVERY_REQUIRED, observed-running -> no change (the row is
 * returned untouched). The reconcile DECISION itself (probe/evidence) is and
 * stays `@role-orchestrator/reconcile`'s job.
 */
export function applyReconcileOutcomeToNode(
  db: DatabaseSync,
  input: ApplyReconcileOutcomeInput
): TaskNodeRow {
  const parsed = ReconcileApplyInputSchema.parse(input);
  const action = nodeActionForReconcileOutcome(parsed.outcome as ReconcileOutcome);
  if (action.nodeTo === null) {
    return requireNodeState(db, { runId: parsed.runId, nodeId: parsed.nodeId });
  }
  return transitionNodeState(db, {
    runId: parsed.runId,
    nodeId: parsed.nodeId,
    to: action.nodeTo,
    whereStateIn: [...action.fromStates],
    now: parsed.now
  });
}
