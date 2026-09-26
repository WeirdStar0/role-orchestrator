/**
 * Typed error taxonomy for @role-orchestrator/dag.
 *
 * Every A08/A03 rejection is its own error class so callers (and tests) can
 * distinguish the defect precisely; nothing here is ever reported as a
 * generic failure. All classes extend `DagError`; wrapping constructors keep
 * the original error as `cause`.
 *
 * A08 shapes, one class each:
 * - `DependencyCycleError`  — a positive-length cycle (path reported)
 * - `SelfDependencyError`   — the degenerate one-node cycle
 * - `UnknownDependencyError`— a dependency id that matches no node in the
 *                             graph ("缺失依赖")
 * - `DuplicateNodeIdError`  — the same node id declared twice
 * - `UnknownNodeRoleError`  — a role outside the four built-ins (A03)
 *
 * `UnknownNodeError` covers the OTHER reference direction ("未知节点引用"):
 * a node id referenced at the persistence boundary (read/transition/
 * propagate) that does not exist for the run.
 */
import type { RoleBindingResolutionKind } from "@role-orchestrator/runtime-profile";
import type { NodeState } from "./states.js";

export class DagError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DagError";
  }
}

/** One Zod issue, pre-formatted for stable reporting. */
export interface SchemaIssueSummary {
  readonly code: string;
  /** Dot-joined path, e.g. "nodes.0.role". */
  readonly path: string;
  readonly message: string;
}

/**
 * The input does not satisfy the frozen contracts `WorkflowDefinitionSchema`
 * (unknown fields, bad ids, duplicate dependencies inside one node, empty
 * node list, ...). Node-level profile/model overrides are rejected here as
 * well — the schema is strict (A02), and this wrapper is their typed face.
 */
export class WorkflowSchemaError extends DagError {
  readonly issues: readonly SchemaIssueSummary[];

  constructor(issues: readonly SchemaIssueSummary[], options?: { cause?: unknown }) {
    super(
      `workflow definition rejected by the frozen contracts schema ` +
        `(${String(issues.length)} issue(s), first: ${issues[0]?.path ?? "?"}: ${issues[0]?.message ?? "?"}); ` +
        "unknown fields are refused, never silently accepted or downgraded",
      options
    );
    this.name = "WorkflowSchemaError";
    this.issues = issues;
  }
}

/** An empty node list reached the graph validator (defensive duplicate of the schema's min(1)). */
export class EmptyGraphError extends DagError {
  constructor() {
    super("workflow graph has no nodes; an executable plan requires at least one node");
    this.name = "EmptyGraphError";
  }
}

/** The same node id was declared more than once. */
export class DuplicateNodeIdError extends DagError {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`node id "${nodeId}" is declared more than once; node ids must be unique`);
    this.name = "DuplicateNodeIdError";
    this.nodeId = nodeId;
  }
}

/** A node depends on itself (the degenerate cycle; A08 names it explicitly). */
export class SelfDependencyError extends DagError {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`node "${nodeId}" depends on itself; self-dependencies are rejected`);
    this.name = "SelfDependencyError";
    this.nodeId = nodeId;
  }
}

/**
 * A dependency id that matches no node in the same graph — the A08 "缺失依赖"
 * shape. Rejected before any plan is returned, so a missing dependency can
 * never silently degrade into "no dependency".
 */
export class UnknownDependencyError extends DagError {
  readonly nodeId: string;
  readonly dependencyId: string;

  constructor(nodeId: string, dependencyId: string) {
    super(
      `node "${nodeId}" depends on "${dependencyId}" which is not declared in this graph; ` +
        "missing dependencies are rejected instead of being dropped"
    );
    this.name = "UnknownDependencyError";
    this.nodeId = nodeId;
    this.dependencyId = dependencyId;
  }
}

/** A positive-length dependency cycle; `cycle` is the id path including the repeated entry node. */
export class DependencyCycleError extends DagError {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`dependency cycle detected: ${cycle.join(" -> ")}; graphs must stay acyclic`);
    this.name = "DependencyCycleError";
    this.cycle = cycle;
  }
}

/**
 * A03: a node declares a role outside the four built-in roles. Reported with
 * the raw role string and (when recoverable from the raw input) the node id.
 */
export class UnknownNodeRoleError extends DagError {
  readonly offenders: readonly {
    readonly nodeId: string | null;
    readonly roleId: string;
  }[];

  constructor(
    offenders: readonly { readonly nodeId: string | null; readonly roleId: string }[],
    options?: { cause?: unknown }
  ) {
    super(
      `unknown role(s) in workflow nodes (A03): ` +
        offenders
          .map((o) => `"${o.roleId}"${o.nodeId === null ? "" : ` (node "${o.nodeId}")`}`)
          .join(", ") +
        "; only the four built-in roles (coordinator, architect, developer, reviewer) are accepted",
      options
    );
    this.name = "UnknownNodeRoleError";
    this.offenders = offenders;
  }
}

export type GraphBudgetKind = "max-nodes" | "max-depth";

/**
 * ORCHESTRATION.md section 5: node count and dependency depth budgets cap
 * "扩图 × 重试 × 返工". Defaults (64 nodes / depth 16) are the documented
 * engineering values and are caller-adjustable.
 */
export class GraphBudgetExceededError extends DagError {
  readonly kind: GraphBudgetKind;
  readonly limit: number;
  readonly actual: number;
  readonly nodeId: string | null;

  constructor(
    kind: GraphBudgetKind,
    limit: number,
    actual: number,
    nodeId: string | null = null
  ) {
    super(
      `graph budget exceeded (${kind}): limit ${String(limit)}, actual ${String(actual)}` +
        (nodeId === null ? "" : ` at node "${nodeId}"`) +
        "; adjust the caller-provided budget if this graph is genuinely intended"
    );
    this.name = "GraphBudgetExceededError";
    this.kind = kind;
    this.limit = limit;
    this.actual = actual;
    this.nodeId = nodeId;
  }
}

/**
 * "未知节点引用" at the persistence boundary: a node id was referenced for a
 * run (read/transition/propagate) but no task_nodes row exists for it.
 */
export class UnknownNodeError extends DagError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(runId: string, nodeId: string) {
    super(`node "${nodeId}" does not exist in run "${runId}"`);
    this.name = "UnknownNodeError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/** The referenced run has no task_runs row. */
export class UnknownRunError extends DagError {
  readonly runId: string;

  constructor(runId: string) {
    super(`task run "${runId}" does not exist`);
    this.name = "UnknownRunError";
    this.runId = runId;
  }
}

/**
 * A stored dependency snapshot (or state value) no longer matches the schema
 * it was written with — tampering or corruption signal, never silently
 * coerced.
 */
export class NodeSnapshotIntegrityError extends DagError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(runId: string, nodeId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NodeSnapshotIntegrityError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/**
 * A transition outside the ORCHESTRATION.md state machine was attempted —
 * either by a direct `assertNodeTransition` call or because a guarded UPDATE
 * found the row in a state the machine never allows to reach `to`.
 */
export class IllegalNodeTransitionError extends DagError {
  readonly from: NodeState;
  readonly to: NodeState;

  constructor(from: NodeState, to: NodeState, options?: { cause?: unknown }) {
    super(
      `illegal node state transition ${from} -> ${to}; only the edges of the ` +
        "ORCHESTRATION.md section-3 state diagram are accepted (BLOCKED and SUCCEEDED have no outgoing edges)",
      options
    );
    this.name = "IllegalNodeTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** The same (run, node) slot was persisted twice — re-running graph creation for an existing run. */
export class DuplicateRunNodeError extends DagError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(runId: string, nodeId: string, options?: { cause?: unknown }) {
    super(
      `node "${nodeId}" already exists in run "${runId}"; ` +
        "a run's graph is created exactly once (UNIQUE(run_id, node_id))",
      options
    );
    this.name = "DuplicateRunNodeError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/**
 * Plan-time role resolution failure. The `kind` vocabulary is REUSED from
 * runtime-profile's five A01 rejection kinds (missing / unbound / multiple /
 * unknown-profile / unknown-revision); the original typed error rides along
 * as `cause`.
 */
export class PlanRoleResolutionError extends DagError {
  readonly kind: RoleBindingResolutionKind;
  readonly projectId: string;
  readonly roleId: string;

  constructor(
    kind: RoleBindingResolutionKind,
    projectId: string,
    roleId: string,
    options?: { cause?: unknown }
  ) {
    super(
      `role "${roleId}" of project "${projectId}" could not be resolved (${kind}); ` +
        "a plan whose roles cannot each be resolved to one profile revision is rejected before startup",
      options
    );
    this.name = "PlanRoleResolutionError";
    this.kind = kind;
    this.projectId = projectId;
    this.roleId = roleId;
  }
}

/** A reconcile outcome value outside the vocabulary of `@role-orchestrator/reconcile`. */
export class UnknownReconcileOutcomeError extends DagError {
  readonly outcome: string;

  constructor(outcome: string) {
    super(
      `unknown reconcile outcome "${outcome}"; expected interrupted | recovery-required | observed-running`
    );
    this.name = "UnknownReconcileOutcomeError";
    this.outcome = outcome;
  }
}

// ---------------------------------------------------------------------------
// M5-01 — graph revisions (A38): optimistic graphRevision locking, append-only
// revision history, and the structural-edit gate for running/finished nodes.
// ---------------------------------------------------------------------------

/**
 * A38 (optimistic lock): the caller presented a `expectedGraphRevision` that
 * is not the run's current `task_runs.graph_revision` — someone else changed
 * the graph first. The edit is refused (never merged, never overwritten); the
 * caller must re-read the graph and re-apply its change on top of the current
 * revision.
 */
export class GraphRevisionConflictError extends DagError {
  readonly runId: string;
  readonly expected: number;
  readonly current: number;

  constructor(runId: string, expected: number, current: number) {
    super(
      `graph revision conflict on run "${runId}": the caller saw revision ${String(expected)} ` +
        `but the current revision is ${String(current)}; re-read the graph and retry against the current revision`
    );
    this.name = "GraphRevisionConflictError";
    this.runId = runId;
    this.expected = expected;
    this.current = current;
  }
}

/**
 * A38 (前半): the target node is NOT in one of the structurally editable
 * states (PENDING / READY / BLOCKED) — it is running, waiting, finished or in
 * recovery. Its definition must not be modified in place; the edit is refused
 * with the current state as evidence. History stays untouched.
 */
export class NodeNotEditableError extends DagError {
  readonly runId: string;
  readonly nodeId: string;
  readonly state: NodeState;

  constructor(runId: string, nodeId: string, state: NodeState) {
    super(
      `node "${nodeId}" in run "${runId}" is ${state}; only PENDING, READY and BLOCKED nodes accept ` +
        "structural edits — running or finished nodes are never modified in place (A38)"
    );
    this.name = "NodeNotEditableError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.state = state;
  }
}

/**
 * The run has NO recorded graph-revision baseline, so its full node
 * definitions (objective/title/acceptanceCriteria — fields the `task_nodes`
 * table deliberately does not mirror) are unknown and no edit can be
 * validated. Composition roots enable editing by calling
 * `recordInitialGraphRevision` once, at run creation.
 */
export class GraphRevisionBaselineMissingError extends DagError {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `run "${runId}" has no graph-revision baseline; call recordInitialGraphRevision at run ` +
        "creation to enable graph edits — edits must re-validate the FULL workflow definition, " +
        "which cannot be reconstructed from the task_nodes mirror alone"
    );
    this.name = "GraphRevisionBaselineMissingError";
    this.runId = runId;
  }
}

/** A baseline row already exists for the run; recording a second one is refused (append-only history, no rewrite). */
export class GraphRevisionBaselineExistsError extends DagError {
  readonly runId: string;
  readonly revision: number;

  constructor(runId: string, revision: number) {
    super(
      `run "${runId}" already has a graph-revision baseline at revision ${String(revision)}; ` +
        "the baseline is recorded exactly once"
    );
    this.name = "GraphRevisionBaselineExistsError";
    this.runId = runId;
    this.revision = revision;
  }
}

/**
 * The recorded baseline does NOT match the run's live `task_nodes` rows (node
 * set, roles or dependency snapshots drifted). Refused instead of sealing a
 * baseline that would silently diverge from the executable state.
 */
export class GraphRevisionBaselineMismatchError extends DagError {
  readonly runId: string;

  constructor(runId: string, reason: string) {
    super(
      `graph-revision baseline for run "${runId}" does not match the live task_nodes rows: ${reason}; ` +
        "a baseline must describe the graph exactly as it was created"
    );
    this.name = "GraphRevisionBaselineMismatchError";
    this.runId = runId;
  }
}

/** A stored graph-revision row is not the JSON the writer schema produced — tampering/corruption signal. */
export class GraphRevisionIntegrityError extends DagError {
  readonly runId: string;
  readonly revision: number;

  constructor(runId: string, revision: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GraphRevisionIntegrityError";
    this.runId = runId;
    this.revision = revision;
  }
}
