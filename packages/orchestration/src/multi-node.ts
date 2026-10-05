/**
 * M10-03 — the multi-node DECLARATION layer: validation of a workflow node
 * spec set, its mapping onto the frozen contracts graph (the durable node
 * schema is strict and carries NO kind field — the kinds ride the driving
 * process's run book), and the dispatch-kind resolution the pump performs per
 * claimed node.
 *
 * Guards pinned here:
 *  - cross-field rules BEFORE any store write (typed 400 carriers): node
 *    budget (the dag default 64), unique ids, declared dependencies, no self
 *    dependency, integration nodes need >=1 parent, review nodes need EXACTLY
 *    one dependency and the reviewer role (the expansion service's own
 *    NotReviewNodeError rule — a review node that could never ground a rework
 *    must not be creatable);
 *  - the durable graph written through createRunGraph is the FROZEN shape
 *    (id/role/title/objective/dependencies/capabilityTags/acceptanceCriteria)
 *    — the kind never enters the store, the frozen schema, or the graph
 *    revision rows;
 *  - dispatch resolution fails CLOSED: a registered multi-node run whose node
 *    has no registered kind (a re-drive after a serve restart) and any
 *    unregistered multi-node-shaped run refuse the dispatch instead of
 *    mis-executing an integration/review node as a CLI agent. Only the
 *    v0.2.1 single-node shape (exactly one node, id "execute") dispatches
 *    unregistered — backward compatibility is the literal rule.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RoleId, WorkflowDefinition } from "@role-orchestrator/contracts";
import type { NodeDispatchKind, WorkflowNodeSpec } from "./driver-contract.js";
import type { MultiNodeRunBook } from "./context.js";
import { listRunNodes } from "@role-orchestrator/dag";
import { OrchestrationRejectionError, OrchestrationDriverError } from "./errors.js";
import { EXECUTE_NODE_ID } from "./constants.js";

/** Node budget aligned with the dag DEFAULT_GRAPH_BUDGETS.maxNodes default. */
const MAX_WORKFLOW_NODES = 64;

export const MULTI_NODE_WORKFLOW_NAME = "M10-03 多节点工作流";

/**
 * Validate the declared node set (cross-field; per-field shape/bounds are the
 * serving schema's job) and answer the internal spec list. Throws the typed
 * 400 carriers before anything is written.
 */
export function validateWorkflowSpecs(nodes: readonly WorkflowNodeSpec[]): readonly WorkflowNodeSpec[] {
  if (nodes.length < 1 || nodes.length > MAX_WORKFLOW_NODES) {
    throw new OrchestrationRejectionError(
      400,
      "WORKFLOW_NODES_OUT_OF_BUDGET",
      `workflow.nodes must carry 1..${String(MAX_WORKFLOW_NODES)} nodes, got ${String(nodes.length)}`
    );
  }
  const byId = new Map<string, WorkflowNodeSpec>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new OrchestrationRejectionError(
        400,
        "WORKFLOW_DUPLICATE_NODE_ID",
        `workflow.nodes carries the node id "${node.id}" more than once`,
        { details: { nodeId: node.id } }
      );
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (dependency === node.id) {
        throw new OrchestrationRejectionError(
          400,
          "WORKFLOW_SELF_DEPENDENCY",
          `workflow node "${node.id}" depends on itself`,
          { details: { nodeId: node.id } }
        );
      }
      if (!byId.has(dependency)) {
        throw new OrchestrationRejectionError(
          400,
          "WORKFLOW_UNKNOWN_DEPENDENCY",
          `workflow node "${node.id}" depends on "${dependency}", which is not a declared node id`,
          { details: { nodeId: node.id, dependency } }
        );
      }
    }
    if (node.kind === "integration" && node.dependencies.length < 1) {
      throw new OrchestrationRejectionError(
        400,
        "WORKFLOW_INTEGRATION_WITHOUT_PARENTS",
        `integration node "${node.id}" must declare at least one dependency (the parents it merges)`,
        { details: { nodeId: node.id } }
      );
    }
    if (node.kind === "review") {
      if (node.dependencies.length !== 1) {
        throw new OrchestrationRejectionError(
          400,
          "WORKFLOW_REVIEW_DEPENDENCY_COUNT",
          `review node "${node.id}" must declare EXACTLY one dependency (the node whose accepted ` +
            `output it reviews), got ${String(node.dependencies.length)}`,
          { details: { nodeId: node.id } }
        );
      }
      if (node.role !== "reviewer") {
        throw new OrchestrationRejectionError(
          400,
          "WORKFLOW_REVIEW_ROLE",
          `review node "${node.id}" must carry the reviewer role (the rework expansion's own ` +
            "NotReviewNodeError rule), got \"" + node.role + "\"",
          { details: { nodeId: node.id, role: node.role } }
        );
      }
    }
  }
  return nodes;
}

/** The frozen node title: the objective, truncated to the schema bound. */
export function workflowTitleFor(objective: string): string {
  return objective.length <= 200 ? objective : `${objective.slice(0, 197)}...`;
}

/**
 * Map the validated specs onto the FROZEN workflow definition shape that
 * createRunGraph/recordInitialGraphRevision persist (capabilityTags and
 * acceptanceCriteria are the same derivations the v0.2.1 single-node graph
 * uses; the kind is deliberately absent).
 */
export function toFrozenWorkflow(
  runId: string,
  nodes: readonly WorkflowNodeSpec[]
): WorkflowDefinition {
  return {
    id: `wf-${runId}`,
    name: MULTI_NODE_WORKFLOW_NAME,
    nodes: nodes.map((node) => ({
      id: node.id,
      role: node.role,
      title: workflowTitleFor(node.objective),
      objective: node.objective,
      dependencies: [...node.dependencies],
      capabilityTags: [],
      acceptanceCriteria: [node.objective]
    }))
  };
}

/** Build the empty per-run book a multi-node run starts with. */
export function createRunBook(kinds: Iterable<readonly [string, NodeDispatchKind]>): MultiNodeRunBook {
  return {
    kinds: new Map(kinds),
    acceptedOutputs: new Map(),
    candidates: new Map()
  };
}

/**
 * Resolve the dispatch kind of ONE claimed node. See the module header for
 * the fail-closed matrix. The re-drive refusal (registered run, unknown node;
 * unregistered multi-node shape) leaves the durable claim for the explicit
 * recovery flow — it never silently executes the wrong kind.
 */
export function resolveNodeKind(
  db: DatabaseSync,
  multiNodeRuns: ReadonlyMap<string, MultiNodeRunBook>,
  runId: string,
  nodeId: string,
  roleId: RoleId
): NodeDispatchKind {
  const book = multiNodeRuns.get(runId);
  if (book !== undefined) {
    const kind = book.kinds.get(nodeId);
    if (kind === undefined) {
      throw new OrchestrationDriverError(
        `multi-node run "${runId}" has no registered dispatch kind for node "${nodeId}" ` +
          "(the driving process declared kinds only for the nodes it created; refusing the " +
          "dispatch fail-closed — the durable claim is left for the explicit recovery flow)"
      );
    }
    if (kind === "review" && roleId !== "reviewer") {
      throw new OrchestrationDriverError(
        `review node "${nodeId}" of run "${runId}" no longer carries the reviewer role ` +
          "(a graph edit changed it after creation); refusing the review dispatch fail-closed"
      );
    }
    return kind;
  }
  const nodes = listRunNodes(db, runId);
  if (nodes.length === 1 && nodes[0]?.nodeId === EXECUTE_NODE_ID) {
    // The v0.2.1 single-node graph: dispatch exactly as always.
    return "agent";
  }
  throw new OrchestrationDriverError(
    `run "${runId}" is not a single-node graph of this process and carries no multi-node book ` +
      `(a re-drive after a serve restart, most likely); refusing the dispatch of node "${nodeId}" ` +
      "fail-closed — restart re-drives of multi-node runs are not supported and the durable " +
      "claim is left for the explicit recovery flow"
  );
}
