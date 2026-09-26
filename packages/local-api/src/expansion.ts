/**
 * M5-02 — the controlled-expansion surface (read view + guarded write).
 *
 * Three boundaries live here, mirroring graph.ts:
 * - EXPANSION-VIEW boundary (read): `getRunExpansionView` projects the
 *   expansion rows, the unresolved user hold (A20), the pending PROPOSALS
 *   (reviewer fail verdicts not yet expanded — with findings, the deterministic
 *   ids an accepted request would mint and the round-budget state) and the
 *   node/depth budget headroom (ORCHESTRATION.md section 5: 64 nodes / depth
 *   16) down to explicitly allowlisted fields. NO profile material, NO
 *   execution identity.
 * - A02 OVERRIDE-KEY boundary (write): every expansion body is scanned with
 *   the same `findOverrideFieldKey` carrier scan as the edit body BEFORE
 *   schema parsing — an expansion mints roles from the run's frozen bindings
 *   and has no model/Profile surface anywhere.
 * - WRITE-MAPPING boundary: `applyRunExpansion` delegates to expand's
 *   `requestControlledExpansion` (A04 permission gate + durable denial audit,
 *   A38 optimistic revision gate, then the untouched M4-03 protocol: grounded
 *   fail verdict, idempotent replay, user hold, three-round cap, composed-graph
 *   re-validation) and maps typed failures onto explicit HTTP semantics:
 *   403 EXPANSION_PERMISSION_DENIED, 409 GRAPH_REVISION_CONFLICT, 409
 *   REVIEW_ROUNDS_EXHAUSTED / RUN_HELD_FOR_USER / NO_FAIL_VERDICT /
 *   NOT_REVIEW_NODE / EXPANSION_CONFLICT, 400 for the A08 vocabulary and the
 *   budget rejections (with limit and actual in the message), 404 unknown
 *   run/node. A successful expansion NEVER starts an execution.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { RoleId } from "@role-orchestrator/contracts";
import {
  DEFAULT_GRAPH_BUDGETS,
  DependencyCycleError,
  DuplicateNodeIdError,
  GraphBudgetExceededError,
  GraphRevisionConflictError,
  SelfDependencyError,
  UnknownDependencyError,
  UnknownNodeError,
  UnknownRunError,
  WorkflowSchemaError,
  listRunNodes,
  parseWorkflowDefinition,
  validateWorkflowGraph
} from "@role-orchestrator/dag";
import { getTaskRun } from "@role-orchestrator/store";
import {
  AmbiguousRepairTargetError,
  ExpansionConflictError,
  ExpansionPermissionDeniedError,
  MAX_REVIEW_ROUNDS,
  NoFailVerdictError,
  NotReviewNodeError,
  RepairTargetNotReviewedError,
  ReviewRoundsExhaustedError,
  RunHeldForUserError,
  getRunUserHold,
  listRunExpansionProposals,
  listRunExpansionRequestAudit,
  listRunExpansions,
  requestControlledExpansion,
  type ExpansionProposalView
} from "@role-orchestrator/expand";
import { GraphEditRejectionError, LocalApiStateError } from "./errors.js";

/** One executed expansion of the run — allowlisted fields only. */
export interface RunExpansionItemView {
  readonly expansionId: string;
  readonly triggerReviewNodeId: string;
  readonly triggerCandidateSha: string;
  readonly triggerGeneration: number;
  readonly generation: number;
  readonly repairedNodeId: string;
  readonly fixNode: {
    readonly nodeId: string;
    readonly role: string;
    readonly dependencies: readonly string[];
    readonly state: string;
  };
  readonly reviewNode: {
    readonly nodeId: string;
    readonly role: string;
    readonly dependencies: readonly string[];
    readonly state: string;
  };
  readonly findings: readonly string[];
  /** The requesting role, from the granted audit row; null when unaudited. */
  readonly requestedBy: string | null;
  readonly createdAt: string;
}

/** The run's unresolved A20 hold (fourth round refused, waiting for the user). */
export interface RunUnresolvedHoldView {
  readonly holdId: string;
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  readonly attemptedGeneration: number;
  readonly reason: string;
  readonly createdAt: string;
}

/** Node/depth budget headroom against the section-5 defaults (64 / 16). */
export interface RunBudgetView {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly nodeCount: number;
  readonly nodeDepth: number;
  readonly headroomNodes: number;
  readonly headroomDepth: number;
}

export interface RunExpansionView {
  readonly runId: string;
  readonly graphRevision: number;
  readonly runStatus: string;
  readonly maxReviewRounds: number;
  readonly budget: RunBudgetView;
  readonly expansions: readonly RunExpansionItemView[];
  readonly unresolvedHold: RunUnresolvedHoldView | null;
  readonly pendingTriggers: readonly ExpansionProposalView[];
}

/**
 * The run-expansion view, or `null` when the run id is unknown (served 404).
 */
export function getRunExpansionView(db: DatabaseSync, runId: string): RunExpansionView | null {
  const run = getTaskRun(db, runId);
  if (run === null) return null;
  const parsedRunId = run.id;

  // Requester provenance: the granted audit rows, keyed by trigger triple.
  const requesterByTrigger = new Map<string, RoleId>();
  for (const row of listRunExpansionRequestAudit(db, parsedRunId)) {
    if (row.outcome === "granted") {
      requesterByTrigger.set(`${row.reviewNodeId}\u0000${row.candidateSha}`, row.requesterRole);
    }
  }
  const expansions = listRunExpansions(db, parsedRunId).map((row): RunExpansionItemView => {
    const trigger = `${row.triggerReviewNodeId}\u0000${row.triggerCandidateSha}`;
    return {
      expansionId: row.id,
      triggerReviewNodeId: row.triggerReviewNodeId,
      triggerCandidateSha: row.triggerCandidateSha,
      triggerGeneration: row.triggerGeneration,
      generation: row.generation,
      repairedNodeId: row.repairedNodeId,
      fixNode: {
        nodeId: row.mintedDefinitions.fix.id,
        role: row.mintedDefinitions.fix.role,
        dependencies: [...row.mintedDefinitions.fix.dependencies],
        state: nodeStateOf(db, parsedRunId, row.mintedDefinitions.fix.id)
      },
      reviewNode: {
        nodeId: row.mintedDefinitions.review.id,
        role: row.mintedDefinitions.review.role,
        dependencies: [...row.mintedDefinitions.review.dependencies],
        state: nodeStateOf(db, parsedRunId, row.mintedDefinitions.review.id)
      },
      findings: row.findings,
      requestedBy: requesterByTrigger.get(trigger) ?? null,
      createdAt: row.createdAt
    };
  });
  const hold = getRunUserHold(db, parsedRunId);

  return {
    runId: parsedRunId,
    graphRevision: run.graphRevision,
    runStatus: run.status,
    maxReviewRounds: MAX_REVIEW_ROUNDS,
    budget: getRunBudgetView(db, parsedRunId),
    expansions,
    unresolvedHold:
      hold === null
        ? null
        : {
            holdId: hold.id,
            reviewNodeId: hold.reviewNodeId,
            candidateSha: hold.candidateSha,
            attemptedGeneration: hold.attemptedGeneration,
            reason: hold.reason,
            createdAt: hold.createdAt
          },
    pendingTriggers: listRunExpansionProposals(db, parsedRunId)
  };
}

function nodeStateOf(db: DatabaseSync, runId: string, nodeId: string): string {
  const row = listRunNodes(db, runId).find((candidate) => candidate.nodeId === nodeId);
  if (row === undefined) {
    throw new LocalApiStateError(`expansion node "${nodeId}" of run "${runId}" has no task_nodes row`);
  }
  return row.state;
}

/**
 * The node/depth budget accounting of the run's CURRENT node set, computed
 * with the same structural-placeholder composition the expander uses for its
 * re-validation (only id/role/dependency structure is checked — definitional
 * fields live in the plan revision).
 */
export function getRunBudgetView(db: DatabaseSync, runId: string): RunBudgetView {
  const rows = listRunNodes(db, runId);
  if (rows.length === 0) {
    return {
      maxNodes: DEFAULT_GRAPH_BUDGETS.maxNodes,
      maxDepth: DEFAULT_GRAPH_BUDGETS.maxDepth,
      nodeCount: 0,
      nodeDepth: 0,
      headroomNodes: DEFAULT_GRAPH_BUDGETS.maxNodes,
      headroomDepth: DEFAULT_GRAPH_BUDGETS.maxDepth
    };
  }
  const plan = validateWorkflowGraph(
    parseWorkflowDefinition({
      id: `budget-${runId}`,
      name: `budget-${runId}`,
      nodes: rows.map((row) => ({
        id: row.nodeId,
        role: row.roleId,
        title: `stored node ${row.nodeId}`,
        objective: "Structural placeholder for expansion budget accounting; only id/role/dependency structure is checked.",
        dependencies: [...row.dependencies],
        capabilityTags: [],
        acceptanceCriteria: ["structural placeholder for expansion budget accounting"]
      }))
    }),
    { budgets: { maxNodes: DEFAULT_GRAPH_BUDGETS.maxNodes, maxDepth: DEFAULT_GRAPH_BUDGETS.maxDepth } }
  );
  let depth = 0;
  for (const value of plan.depth.values()) {
    if (value > depth) depth = value;
  }
  return {
    maxNodes: DEFAULT_GRAPH_BUDGETS.maxNodes,
    maxDepth: DEFAULT_GRAPH_BUDGETS.maxDepth,
    nodeCount: rows.length,
    nodeDepth: depth,
    headroomNodes: DEFAULT_GRAPH_BUDGETS.maxNodes - rows.length,
    headroomDepth: DEFAULT_GRAPH_BUDGETS.maxDepth - depth
  };
}

// ---------------------------------------------------------------------------
// The guarded write
// ---------------------------------------------------------------------------

/** The parsed-and-validated expansion body (the server owns the zod schema). */
export interface RunExpansionRequest {
  readonly expectedGraphRevision: number;
  readonly reviewNodeId: string;
  /** Full lowercase 40-hex commit SHA (expand re-validates authoritatively). */
  readonly candidateSha: string;
  readonly requesterRoleId: RoleId;
  readonly repairedNodeId?: string | undefined;
}

/** One accepted (or idempotently replayed) controlled expansion. */
export interface RunExpansionResult {
  readonly created: boolean;
  readonly expansionId: string;
  readonly runId: string;
  readonly requesterRoleId: RoleId;
  readonly triggerReviewNodeId: string;
  readonly triggerCandidateSha: string;
  readonly triggerGeneration: number;
  readonly generation: number;
  readonly repairedNodeId: string;
  readonly fixNode: {
    readonly nodeId: string;
    readonly role: string;
    readonly dependencies: readonly string[];
    readonly state: string;
  };
  readonly reviewNode: {
    readonly nodeId: string;
    readonly role: string;
    readonly dependencies: readonly string[];
    readonly state: string;
  };
  /** The run's graphRevision AFTER the request (bumped when created). */
  readonly revision: number;
}

/**
 * Apply one controlled expansion through expand's guarded primitive; typed
 * failures are mapped to HTTP semantics by `mapExpansionError`. Never creates
 * an execution; never rewrites history (the definition change lands as a NEW
 * append-only revision row; the bump is guarded on the revision the client
 * saw).
 */
export function applyRunExpansion(db: DatabaseSync, runId: string, request: RunExpansionRequest): RunExpansionResult {
  const outcome = requestControlledExpansion(db, {
    runId,
    reviewNodeId: request.reviewNodeId,
    candidateSha: request.candidateSha,
    requesterRoleId: request.requesterRoleId,
    expectedGraphRevision: request.expectedGraphRevision,
    ...(request.repairedNodeId !== undefined ? { repairedNodeId: request.repairedNodeId } : {}),
    now: new Date().toISOString()
  });
  return {
    created: outcome.created,
    expansionId: outcome.expansionId,
    runId: outcome.runId,
    requesterRoleId: outcome.requesterRoleId,
    triggerReviewNodeId: outcome.triggerReviewNodeId,
    triggerCandidateSha: outcome.triggerCandidateSha,
    triggerGeneration: outcome.triggerGeneration,
    generation: outcome.generation,
    repairedNodeId: outcome.repairedNodeId,
    fixNode: {
      nodeId: outcome.fixNode.nodeId,
      role: outcome.fixNode.roleId,
      dependencies: [...outcome.fixNode.dependencies],
      state: outcome.fixNode.state
    },
    reviewNode: {
      nodeId: outcome.reviewNode.nodeId,
      role: outcome.reviewNode.roleId,
      dependencies: [...outcome.reviewNode.dependencies],
      state: outcome.reviewNode.state
    },
    revision: outcome.revision
  };
}

/**
 * Typed failure -> HTTP semantics. Status/code decided by the DOMAIN mapping;
 * the original typed error rides along as `cause`.
 */
export function mapExpansionError(runId: string, error: unknown): GraphEditRejectionError | LocalApiStateError {
  if (error instanceof ExpansionPermissionDeniedError) {
    return new GraphEditRejectionError(403, "EXPANSION_PERMISSION_DENIED", error.message, {
      cause: error,
      details: { denialReason: error.reason, requesterRoleId: error.requesterRoleId }
    });
  }
  if (error instanceof GraphRevisionConflictError) {
    return new GraphEditRejectionError(
      409,
      "GRAPH_REVISION_CONFLICT",
      `graph revision conflict: the request saw revision ${String(error.expected)} but the current revision of run "${runId}" is ${String(error.current)}; reload the graph and retry (A38)`,
      { cause: error, details: { currentGraphRevision: error.current } }
    );
  }
  if (error instanceof ReviewRoundsExhaustedError) {
    return new GraphEditRejectionError(
      409,
      "REVIEW_ROUNDS_EXHAUSTED",
      error.message,
      { cause: error }
    );
  }
  if (error instanceof RunHeldForUserError) {
    return new GraphEditRejectionError(409, "RUN_HELD_FOR_USER", error.message, { cause: error });
  }
  if (error instanceof ExpansionConflictError) {
    return new GraphEditRejectionError(409, "EXPANSION_CONFLICT", error.message, { cause: error });
  }
  if (error instanceof NoFailVerdictError) {
    return new GraphEditRejectionError(409, "NO_FAIL_VERDICT", error.message, { cause: error });
  }
  if (error instanceof NotReviewNodeError) {
    return new GraphEditRejectionError(409, "NOT_REVIEW_NODE", error.message, { cause: error });
  }
  if (error instanceof UnknownRunError || error instanceof UnknownNodeError) {
    return new GraphEditRejectionError(404, "NOT_FOUND", error.message, { cause: error });
  }
  if (error instanceof AmbiguousRepairTargetError) {
    return new GraphEditRejectionError(400, "AMBIGUOUS_REPAIR_TARGET", error.message, { cause: error });
  }
  if (error instanceof RepairTargetNotReviewedError) {
    return new GraphEditRejectionError(400, "REPAIR_TARGET_NOT_REVIEWED", error.message, { cause: error });
  }
  if (error instanceof GraphBudgetExceededError) {
    return new GraphEditRejectionError(400, "GRAPH_BUDGET_EXCEEDED", error.message, { cause: error });
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
  if (error instanceof WorkflowSchemaError) {
    return new GraphEditRejectionError(400, "WORKFLOW_SCHEMA_REJECTED", error.message, { cause: error });
  }
  if (error instanceof z.ZodError) {
    return new GraphEditRejectionError(
      400,
      "EXPANSION_INPUT_REJECTED",
      `the expansion request does not match the strict schema: ${String(error.issues[0]?.message ?? "unknown issue")}`,
      { cause: error }
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LocalApiStateError(`expansion failed unexpectedly: ${message}`, { cause: error });
}
