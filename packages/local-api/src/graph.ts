/**
 * M5-01 — the run-graph view and the guarded node-edit endpoint domain.
 *
 * Three boundaries live here:
 * - GRAPH-VIEW boundary (read): the view projects `task_nodes` rows plus the
 *   latest `task_graph_revisions` row down to explicitly allowlisted fields.
 *   It carries NO profile material and NO execution identity — role/state/
 *   dependencies/objective/editable only. Nodes the UI may edit are flagged
 *   with `editable` via dag's `isNodeStructurallyEditable` (A38: only
 *   PENDING/READY/BLOCKED).
 * - A02 OVERRIDE-KEY boundary: every edit body is scanned for the frozen
 *   override vocabulary (model / modelId / profile / profileId / profiles /
 *   fallbackProfileId(s)) at ANY nesting level BEFORE schema parsing; a
 *   carrier is refused with 403 PROFILE_OVERRIDE_REJECTED and never reaches
 *   the dag layer (which re-refuses it at its own strict schemas — the third
 *   layer lives in the frozen contracts schema).
 * - EDIT-MAPPING boundary (write): `applyRunNodeEdit` is the ONLY place this
 *   package mutates durable state. It delegates to dag's `applyGraphNodeEdit`
 *   (optimistic graphRevision lock, editable-state gate, full A08/A03/A02
 *   re-validation before any write) and maps the typed dag failures onto
 *   explicit HTTP semantics: stale revision → 409 GRAPH_REVISION_CONFLICT;
 *   running/finished node → 409 NODE_NOT_EDITABLE; invalid post-edit graph →
 *   400 with the typed A08 code; unknown run/node → 404. Edits NEVER start
 *   executions — scheduling stays with the existing scheduler chain.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import {
  DependencyCycleError,
  DuplicateNodeIdError,
  EDITABLE_NODE_STATES,
  GraphBudgetExceededError,
  GraphRevisionBaselineExistsError,
  GraphRevisionBaselineMismatchError,
  GraphRevisionBaselineMissingError,
  GraphRevisionConflictError,
  NodeNotEditableError,
  PlanRoleResolutionError,
  SelfDependencyError,
  UnknownDependencyError,
  UnknownNodeError,
  UnknownNodeRoleError,
  UnknownRunError,
  WorkflowSchemaError,
  applyGraphNodeEdit,
  getLatestGraphRevision,
  isNodeStructurallyEditable,
  listRunNodes,
  type RunGraphEditResult
} from "@role-orchestrator/dag";
import { getTaskRun } from "@role-orchestrator/store";
import { GraphEditRejectionError, LocalApiStateError } from "./errors.js";

/** One node of the run-graph view — allowlisted fields only. */
export interface RunGraphNodeView {
  readonly nodeId: string;
  readonly role: string;
  /** Absent (empty string) only for runs whose baseline was never recorded. */
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly state: string;
  readonly definitionRevision: string;
  /** A38: true only for PENDING/READY/BLOCKED nodes. */
  readonly editable: boolean;
}

export interface RunGraphView {
  readonly runId: string;
  readonly graphRevision: number;
  readonly runStatus: string;
  /** The state vocabulary the UI gate mirrors (dag's EDITABLE_NODE_STATES). */
  readonly editableNodeStates: readonly string[];
  readonly nodes: readonly RunGraphNodeView[];
}

/**
 * The run-graph view, or `null` when the run id is unknown (served as 404).
 * Objectives come from the latest revision row's recorded definitions; runs
 * without a recorded baseline render with empty objectives and REFUSE edits
 * (dag raises GraphRevisionBaselineMissingError → 409 GRAPH_BASELINE_MISSING).
 */
export function getRunGraphView(db: DatabaseSync, runId: string): RunGraphView | null {
  const run = getTaskRun(db, runId);
  if (run === null) return null;
  const latest = getLatestGraphRevision(db, runId);
  const definitions = new Map(latest === null ? [] : latest.workflow.nodes.map((node) => [node.id, node]));
  const nodes = listRunNodes(db, runId).map((row): RunGraphNodeView => {
    const objective = definitions.get(row.nodeId)?.objective;
    return {
      nodeId: row.nodeId,
      role: row.roleId,
      objective: objective ?? "",
      dependencies: row.dependencies,
      state: row.state,
      definitionRevision: row.definitionRevision,
      editable: isNodeStructurallyEditable(row.state)
    };
  });
  return {
    runId: run.id,
    graphRevision: run.graphRevision,
    runStatus: run.status,
    editableNodeStates: [...EDITABLE_NODE_STATES],
    nodes
  };
}

/**
 * The A02 override vocabulary — the frozen `OverrideFieldName` set from the
 * contracts package, mirrored here as the API-layer carrier scan. Matching is
 * case-insensitive and nesting-aware (objects AND arrays, depth-capped) so
 * `{"patch":{"dependencies":[],"model":"..."}}` is caught before parsing.
 */
const OVERRIDE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "model",
  "modelid",
  "profile",
  "profileid",
  "profiles",
  "fallbackprofileid",
  "fallbackprofileids"
]);

const OVERRIDE_SCAN_MAX_DEPTH = 4;

/** The first override-vocabulary key found in the value, or `null`. */
export function findOverrideFieldKey(value: unknown, depth = 0): string | null {
  if (depth > OVERRIDE_SCAN_MAX_DEPTH || value === null || typeof value !== "object") {
    return null;
  }
  const entries: readonly [string, unknown][] = Array.isArray(value)
    ? value.map((item: unknown, index: number): [string, unknown] => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries) {
    if (OVERRIDE_FIELD_NAMES.has(key.toLowerCase())) {
      return key;
    }
    const nested = findOverrideFieldKey(child, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

/** The parsed-and-validated edit body (the server owns the zod schema). */
export interface RunNodeEditRequest {
  readonly expectedGraphRevision: number;
  readonly nodeId: string;
  readonly patch: {
    readonly role?: RoleId | undefined;
    readonly objective?: string | undefined;
    readonly dependencies?: readonly string[] | undefined;
  };
}

export interface RunNodeEditResult {
  readonly runId: string;
  readonly revision: number;
  readonly node: RunGraphNodeView;
}

/**
 * Apply one node edit through dag's guarded primitive and map typed failures
 * to HTTP semantics. Never creates an execution; never rewrites history (the
 * change lands as a NEW revision row; the bump is guarded on the exact
 * revision the client saw).
 */
export function applyRunNodeEdit(db: DatabaseSync, runId: string, request: RunNodeEditRequest): RunNodeEditResult {
  let result: RunGraphEditResult;
  try {
    result = applyGraphNodeEdit(db, {
      runId,
      nodeId: request.nodeId,
      expectedGraphRevision: request.expectedGraphRevision,
      patch: {
        role: request.patch.role,
        objective: request.patch.objective,
        // Copy at the trust boundary: the request type is readonly, the dag
        // input schema expects a plain mutable array it re-validates anyway.
        dependencies:
          request.patch.dependencies === undefined ? undefined : [...request.patch.dependencies]
      },
      now: new Date().toISOString()
    });
  } catch (error) {
    throw mapGraphEditError(runId, error);
  }
  // The objective is reported from the RECORDED new revision (not from the
  // request), so the response reflects exactly what persistence now holds.
  const recorded = getLatestGraphRevision(db, runId);
  const objective = recorded?.workflow.nodes.find((node) => node.id === result.node.nodeId)?.objective;
  return {
    runId: result.runId,
    revision: result.revision,
    node: {
      nodeId: result.node.nodeId,
      role: result.node.roleId,
      objective: objective ?? "",
      dependencies: result.node.dependencies,
      state: result.node.state,
      definitionRevision: result.node.definitionRevision,
      editable: isNodeStructurallyEditable(result.node.state)
    }
  };
}

function mapGraphEditError(runId: string, error: unknown): GraphEditRejectionError | LocalApiStateError {
  if (error instanceof GraphRevisionConflictError) {
    return new GraphEditRejectionError(
      409,
      "GRAPH_REVISION_CONFLICT",
      `graph revision conflict: the request saw revision ${String(error.expected)} but the current revision of run "${runId}" is ${String(error.current)}; reload the graph and retry (A38)`,
      { cause: error, details: { currentGraphRevision: error.current } }
    );
  }
  if (error instanceof NodeNotEditableError) {
    return new GraphEditRejectionError(
      409,
      "NODE_NOT_EDITABLE",
      `node "${error.nodeId}" is ${error.state}; only PENDING, READY and BLOCKED nodes accept structural edits — running or finished nodes are never modified in place (A38)`,
      { cause: error }
    );
  }
  if (error instanceof GraphRevisionBaselineMissingError) {
    return new GraphEditRejectionError(
      409,
      "GRAPH_BASELINE_MISSING",
      `run "${runId}" has no recorded graph-revision baseline; edits are disabled for this run`,
      { cause: error }
    );
  }
  if (error instanceof UnknownRunError || error instanceof UnknownNodeError) {
    return new GraphEditRejectionError(404, "NOT_FOUND", error.message, { cause: error });
  }
  if (error instanceof DependencyCycleError) {
    return new GraphEditRejectionError(400, "DEPENDENCY_CYCLE", error.message, { cause: error });
  }
  if (error instanceof SelfDependencyError) {
    return new GraphEditRejectionError(400, "SELF_DEPENDENCY", error.message, { cause: error });
  }
  if (error instanceof UnknownDependencyError) {
    return new GraphEditRejectionError(400, "UNKNOWN_DEPENDENCY", error.message, { cause: error });
  }
  if (error instanceof DuplicateNodeIdError) {
    return new GraphEditRejectionError(400, "DUPLICATE_NODE_ID", error.message, { cause: error });
  }
  if (error instanceof UnknownNodeRoleError) {
    return new GraphEditRejectionError(400, "UNKNOWN_NODE_ROLE", error.message, { cause: error });
  }
  if (error instanceof GraphBudgetExceededError) {
    return new GraphEditRejectionError(400, "GRAPH_BUDGET_EXCEEDED", error.message, { cause: error });
  }
  if (error instanceof WorkflowSchemaError) {
    return new GraphEditRejectionError(400, "WORKFLOW_SCHEMA_REJECTED", error.message, { cause: error });
  }
  if (error instanceof PlanRoleResolutionError) {
    return new GraphEditRejectionError(
      409,
      "ROLE_NOT_RESOLVABLE",
      `role "${error.roleId}" cannot be resolved from run "${runId}"'s frozen profile snapshots; editing cannot re-bind roles (A34)`,
      { cause: error }
    );
  }
  if (
    error instanceof GraphRevisionBaselineExistsError ||
    error instanceof GraphRevisionBaselineMismatchError
  ) {
    // Composition-root faults, not client faults: the run's revision history
    // is in a state no request should have been able to produce.
    return new LocalApiStateError(error.message, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LocalApiStateError(`graph edit failed unexpectedly: ${message}`, { cause: error });
}
