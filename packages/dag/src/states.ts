import { z } from "zod";
// Runtime import of the error class; errors.ts only imports TYPES from this
// file (type-only imports are erased), so there is no runtime cycle.
import { IllegalNodeTransitionError } from "./errors.js";

/**
 * Node-level states — the authoritative list is `docs/ORCHESTRATION.md`
 * section 3 ("节点、进程与任务状态分离"). These are NODE states, deliberately
 * distinct from the eight Execution PHASES in `@role-orchestrator/store`
 * (PREPARING/STARTING/RUNNING/...) and from the TaskRun aggregate statuses:
 * one node spans many process attempts, so the two lifecycles must not share
 * a vocabulary.
 *
 * RECOVERY_REQUIRED is a genuine NODE state here (A22 landing spot): an
 * INTERRUPTED node whose outcome is indeterminate holds the branch open until
 * a human/`@role-orchestrator/reconcile` disposition resolves it. At the
 * EXECUTION level reconcile deliberately keeps the attempt row in its active
 * phase — the two layers meet in `reconcile-bridge.ts`, which maps reconcile
 * outcomes onto node transitions.
 */
export const NODE_STATES = [
  "PENDING",
  "READY",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "WAITING_APPROVAL",
  "INTERRUPTED",
  "CANCELLED",
  "RETRY_PENDING",
  "BLOCKED",
  "RECOVERY_REQUIRED"
] as const;

export type NodeState = (typeof NODE_STATES)[number];

export const NodeStateSchema = z.enum(NODE_STATES);

/**
 * The complete legal edge set, transcribed one-to-one from the state diagram
 * in `docs/ORCHESTRATION.md` section 3:
 *
 *   PENDING -> READY -> RUNNING -> SUCCEEDED
 *   RUNNING -> FAILED | WAITING_APPROVAL | INTERRUPTED | CANCELLED
 *   FAILED -> RETRY_PENDING -> READY
 *   WAITING_APPROVAL -> READY | CANCELLED
 *   INTERRUPTED -> RECOVERY_REQUIRED -> READY | CANCELLED
 *   PENDING/READY -> BLOCKED | CANCELLED
 *
 * BLOCKED deliberately has NO outgoing edges: a blocked branch is kept blocked
 * or cancelled (ORCHESTRATION.md: "审批拒绝令相关分支取消或保持 blocked"); a
 * recovered branch resumes via a NEW TaskRun, never by silently reviving
 * blocked rows. SUCCEEDED and CANCELLED are terminal.
 */
export const NODE_TRANSITIONS: readonly {
  readonly from: NodeState;
  readonly to: NodeState;
}[] = [
  { from: "PENDING", to: "READY" },
  { from: "READY", to: "RUNNING" },
  { from: "RUNNING", to: "SUCCEEDED" },
  { from: "RUNNING", to: "FAILED" },
  { from: "RUNNING", to: "WAITING_APPROVAL" },
  { from: "RUNNING", to: "INTERRUPTED" },
  { from: "RUNNING", to: "CANCELLED" },
  { from: "FAILED", to: "RETRY_PENDING" },
  { from: "RETRY_PENDING", to: "READY" },
  { from: "WAITING_APPROVAL", to: "READY" },
  { from: "WAITING_APPROVAL", to: "CANCELLED" },
  { from: "INTERRUPTED", to: "RECOVERY_REQUIRED" },
  { from: "RECOVERY_REQUIRED", to: "READY" },
  { from: "RECOVERY_REQUIRED", to: "CANCELLED" },
  { from: "PENDING", to: "BLOCKED" },
  { from: "READY", to: "BLOCKED" },
  { from: "PENDING", to: "CANCELLED" },
  { from: "READY", to: "CANCELLED" }
];

function buildIndex(key: "from" | "to"): ReadonlyMap<NodeState, readonly NodeState[]> {
  const map = new Map<NodeState, NodeState[]>();
  for (const state of NODE_STATES) {
    map.set(state, []);
  }
  for (const edge of NODE_TRANSITIONS) {
    map.get(edge[key])?.push(key === "from" ? edge.to : edge.from);
  }
  return map;
}

const SUCCESSORS: ReadonlyMap<NodeState, readonly NodeState[]> = buildIndex("from");
const PREDECESSORS: ReadonlyMap<NodeState, readonly NodeState[]> = buildIndex("to");

export function legalNodeSuccessors(from: NodeState): readonly NodeState[] {
  return SUCCESSORS.get(from) ?? [];
}

/**
 * The states from which `to` is reachable — used as the DEFAULT optimistic
 * guard (`whereStateIn`) when a transition is applied, so an update can only
 * ever land from a state the state machine allows.
 */
export function legalNodePredecessors(to: NodeState): readonly NodeState[] {
  return PREDECESSORS.get(to) ?? [];
}

export function isLegalNodeTransition(from: NodeState, to: NodeState): boolean {
  return legalNodeSuccessors(from).includes(to);
}

/**
 * Throws `IllegalNodeTransitionError` when `from -> to` is not an edge of the
 * ORCHESTRATION.md state machine. Pure check for callers that want to reject
 * a transition BEFORE touching the database; the guarded UPDATE in
 * `transitionNodeState` remains the concurrency-safe backstop.
 */
export function assertNodeTransition(from: NodeState, to: NodeState): void {
  if (!isLegalNodeTransition(from, to)) {
    throw new IllegalNodeTransitionError(from, to);
  }
}

/**
 * Dependency states that propagate BLOCKED downstream. The ask pins the three
 * hard failures ("任一依赖 FAILED/INTERRUPTED/CANCELLED 则 blocked/终止传播");
 * BLOCKED is included so the propagation is TRANSITIVE (a blocked node's own
 * dependents are kept from starting too). RECOVERY_REQUIRED and
 * WAITING_APPROVAL deliberately do NOT block: their branches may still
 * recover/succeed, so dependents merely stay PENDING (never READY, never
 * started) instead of being permanently blocked.
 */
export const BLOCKING_DEP_STATES = [
  "FAILED",
  "INTERRUPTED",
  "CANCELLED",
  "BLOCKED"
] as const satisfies readonly NodeState[];

/** Minimal state view the pure readiness computation operates on. */
export interface NodeStateView {
  readonly nodeId: string;
  readonly state: NodeState;
  /** Frozen dependency snapshot of the node (ids into the same graph). */
  readonly dependencies: readonly string[];
}

export interface NodeStateTransition {
  readonly nodeId: string;
  readonly from: NodeState;
  readonly to: NodeState;
}

const ReadinessInputSchema = z.strictObject({
  nodes: z
    .array(
      z.strictObject({
        nodeId: z.string().min(1),
        state: NodeStateSchema,
        dependencies: z.array(z.string().min(1))
      })
    )
    .max(1024)
});

/**
 * Pure dependency-completion computation ("依赖全部 SUCCEEDED 才 ready；任一
 * 依赖 FAILED/INTERRUPTED/CANCELLED 则 blocked"):
 *
 * - a PENDING node whose dependencies ALL read SUCCEEDED (vacuously true for
 *   zero dependencies) transitions to READY;
 * - a PENDING or READY node with ANY dependency in BLOCKING_DEP_STATES
 *   transitions to BLOCKED;
 * - every other state is untouched: RUNNING/terminal states are never
 *   rewritten by propagation, and `FAILED -> RETRY_PENDING -> READY`,
 *   `READY -> RUNNING` etc. remain EXPLICIT scheduler decisions, not automatic
 *   ones.
 *
 * `nodes` MUST be given in topological order (the validated plan's order), so
 * one pass propagates blocked transitively. A dependency id without a view in
 * the input is treated as NOT succeeded and NOT blocking (fail-closed: the
 * node simply stays where it is); graph validation guarantees dependency ids
 * resolve at plan time, so this is a defensive branch only.
 */
export function computeReadinessTransitions(input: {
  readonly nodes: readonly NodeStateView[];
}): readonly NodeStateTransition[] {
  const value = ReadinessInputSchema.parse(input);
  const stateByNode = new Map<string, NodeState>();
  for (const node of value.nodes) {
    stateByNode.set(node.nodeId, node.state);
  }
  const transitions: NodeStateTransition[] = [];
  for (const node of value.nodes) {
    if (node.state !== "PENDING" && node.state !== "READY") {
      continue;
    }
    const depStates = node.dependencies.map((depId) => stateByNode.get(depId));
    const anyBlocked = depStates.some(
      (dep) => dep !== undefined && (BLOCKING_DEP_STATES as readonly NodeState[]).includes(dep)
    );
    if (anyBlocked) {
      transitions.push({ nodeId: node.nodeId, from: node.state, to: "BLOCKED" });
      // Make the decision visible to later (downstream) nodes in the same pass.
      stateByNode.set(node.nodeId, "BLOCKED");
      continue;
    }
    const allSucceeded = depStates.every((dep) => dep === "SUCCEEDED");
    if (node.state === "PENDING" && allSucceeded) {
      transitions.push({ nodeId: node.nodeId, from: "PENDING", to: "READY" });
      stateByNode.set(node.nodeId, "READY");
    }
  }
  return transitions;
}
