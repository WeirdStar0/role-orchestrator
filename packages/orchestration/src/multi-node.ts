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
 *  - AT MOST ONE integration node per workflow (v1 restriction, declared at
 *    the only layer that can see the kinds): the M7 integration service is a
 *    PER-RUN single writer — one task branch, one integration worktree. A
 *    second integration node is unsupported in every arrangement: chained
 *    (integration -> integration) deterministically deadlocks because the
 *    accepted output of the upstream integration is the CANDIDATE sha on the
 *    task branch while the branch tip stays at the baseline, so the
 *    downstream buildParents/integrateParents tip check raises
 *    ParentOutputMovedError; parallel (two integrations off the same parents)
 *    reuses the same task branch/worktree singletons, so the second candidate
 *    accumulates the first integration's output even with no declared edge
 *    and the review verdict attribution is polluted. 0 and 1 integration
 *    nodes stay legal (agent-only graphs and the single-integration
 *    convergence shape — the BACKLOG M10-03 acceptance shape);
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
 * The readable v1-restriction reason surfaced verbatim to the caller when a
 * declaration carries more than one integration node.
 */
const INTEGRATION_NODE_LIMIT_REASON =
  "当前版本每任务支持一个集成节点;链式/并行集成将在后续版本支持";

/**
 * The AT-MOST-ONE-integration gate itself (v1 restriction — see the module
 * header for why every >1 arrangement is unsupported by the per-run single
 * integration service). Answering the offending ids so the refusal is
 * actionable; the same check guards toFrozenWorkflow so the graph TEMPLATE
 * generator cannot mint a non-compliant graph even if a future caller hands
 * it unvalidated specs.
 */
function assertAtMostOneIntegrationNode(nodes: readonly WorkflowNodeSpec[]): void {
  const integrationIds = nodes.filter((node) => node.kind === "integration").map((node) => node.id);
  if (integrationIds.length > 1) {
    throw new OrchestrationRejectionError(
      400,
      "WORKFLOW_INTEGRATION_NODE_COUNT",
      `workflow declares ${String(integrationIds.length)} integration nodes (` +
        integrationIds.join(", ") +
        `); ${INTEGRATION_NODE_LIMIT_REASON} ` +
        "(v1: the single-integration convergence shape — many developer nodes merged by ONE " +
        "integration node — is the supported form; the M7 integration service is a per-run " +
        "single writer)",
      { details: { nodeIds: integrationIds } }
    );
  }
}

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
  // The graph-level v1 restriction: at most one integration node (the
  // per-run single integration service supports no chained/parallel form).
  assertAtMostOneIntegrationNode(nodes);
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
 *
 * The graph TEMPLATE generator carries the at-most-one-integration guarantee
 * INDEPENDENTLY of validateWorkflowSpecs (defense in depth, same typed
 * carrier): whatever reaches the frozen graph — and from there the durable
 * revision rows — is a compliant v1 shape.
 */
export function toFrozenWorkflow(
  runId: string,
  nodes: readonly WorkflowNodeSpec[]
): WorkflowDefinition {
  assertAtMostOneIntegrationNode(nodes);
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
