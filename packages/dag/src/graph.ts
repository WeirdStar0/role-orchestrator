import { z } from "zod";
import type { TaskNodeDefinition, WorkflowDefinition } from "@role-orchestrator/contracts";
import { RoleIdSchema, WorkflowDefinitionSchema } from "@role-orchestrator/contracts";
import {
  DependencyCycleError,
  DuplicateNodeIdError,
  EmptyGraphError,
  GraphBudgetExceededError,
  SelfDependencyError,
  UnknownDependencyError,
  UnknownNodeRoleError,
  WorkflowSchemaError
} from "./errors.js";
import type { SchemaIssueSummary } from "./errors.js";

/**
 * Graph legality (A08) — the gate that runs BEFORE any executable plan is
 * returned and therefore before ANY CLI process can be started:
 *
 *   empty graph -> roles -> duplicate node ids -> self dependency ->
 *   missing dependency -> cycle -> node/depth budgets
 *
 * The plan-import checks follow `docs/ORCHESTRATION.md` section 2 ("ID 唯一、
 * 所有依赖存在、无自依赖、拓扑排序成功、四角色绑定完备...") with the budget
 * defaults from section 5 (64 nodes / dependency depth 16, user-adjustable).
 * The frozen `WorkflowDefinitionSchema` is strict, so model/profile override
 * fields and unknown keys are rejected at parse time (A02), not silently
 * dropped.
 */

export interface GraphBudgets {
  readonly maxNodes: number;
  /** Dependency depth = longest edge-count from a root node. */
  readonly maxDepth: number;
}

/** ORCHESTRATION.md section 5 engineering defaults ("每 run 最多 64 节点、依赖深度 16"). */
export const DEFAULT_GRAPH_BUDGETS: GraphBudgets = { maxNodes: 64, maxDepth: 16 };

const ValidateOptionsSchema = z.strictObject({
  budgets: z
    .strictObject({
      maxNodes: z.number().int().min(1).max(256),
      maxDepth: z.number().int().min(1).max(1024)
    })
    .partial()
    .optional()
});

export interface ValidateWorkflowOptions {
  readonly budgets?: {
    readonly maxNodes?: number;
    readonly maxDepth?: number;
  };
}

/** A validated, executable plan: the typed workflow plus its derived schedule. */
export interface ValidatedPlan {
  readonly workflowId: string;
  readonly name: string;
  /** Nodes in topological order (stable: input order breaks ties). */
  readonly nodes: readonly TaskNodeDefinition[];
  /** node id -> position in the topological `nodes` array. */
  readonly order: ReadonlyMap<string, number>;
  /** node id -> dependency depth (longest edge-count from a root). */
  readonly depth: ReadonlyMap<string, number>;
}

function summarizeIssues(error: z.ZodError): readonly SchemaIssueSummary[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path
      .map((part) => (typeof part === "number" ? String(part) : String(part)))
      .join("."),
    message: issue.message
  }));
}

function isRoleIssue(issue: z.ZodIssue): boolean {
  return (
    issue.code === "invalid_value" &&
    issue.path.length >= 3 &&
    issue.path[issue.path.length - 1] === "role" &&
    issue.path[0] === "nodes"
  );
}

/** Best-effort (nodeId, roleId) recovery from the RAW input for role issues. */
function roleOffendersFromRaw(
  error: z.ZodError,
  input: unknown
): { nodeId: string | null; roleId: string }[] {
  const offenders: { nodeId: string | null; roleId: string }[] = [];
  for (const issue of error.issues) {
    if (!isRoleIssue(issue)) {
      continue;
    }
    const nodeIndex = issue.path[1];
    let raw: unknown = input;
    for (const part of issue.path.slice(0, -1)) {
      if (raw === null || typeof raw !== "object") {
        raw = undefined;
        break;
      }
      raw = (raw as Record<string, unknown>)[String(part)];
    }
    const node = (raw ?? undefined) as { id?: unknown; role?: unknown } | undefined;
    offenders.push({
      nodeId: typeof node?.id === "string" ? node.id : typeof nodeIndex === "number" ? `<nodes.${String(nodeIndex)}>` : null,
      roleId: typeof node?.role === "string" ? node.role : "<non-string>"
    });
  }
  return offenders;
}

/**
 * Parse RAW input with the frozen contracts schema, lifting the A03 unknown-
 * role failure into its own typed error (`UnknownNodeRoleError`) instead of a
 * generic schema error. Every other schema failure becomes
 * `WorkflowSchemaError` (strict refusal; includes A02 override fields).
 */
export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  const result = WorkflowDefinitionSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const roleIssues = result.error.issues.filter(isRoleIssue);
  if (roleIssues.length > 0) {
    throw new UnknownNodeRoleError(roleOffendersFromRaw(result.error, input), { cause: result.error });
  }
  throw new WorkflowSchemaError(summarizeIssues(result.error), { cause: result.error });
}

/**
 * Validate an ALREADY-PARSED `WorkflowDefinition` (roles statically typed as
 * `RoleId`) and derive the executable plan. The role re-check with
 * `RoleIdSchema` is defense-in-depth for programmatically-constructed inputs
 * that bypassed the schema: an invalid role still lands on the same typed
 * A03 error.
 */
export function validateWorkflowGraph(
  workflow: WorkflowDefinition,
  options: ValidateWorkflowOptions = {}
): ValidatedPlan {
  const parsed = ValidateOptionsSchema.parse(options);
  const budgets: GraphBudgets = {
    maxNodes: parsed.budgets?.maxNodes ?? DEFAULT_GRAPH_BUDGETS.maxNodes,
    maxDepth: parsed.budgets?.maxDepth ?? DEFAULT_GRAPH_BUDGETS.maxDepth
  };

  const nodes = workflow.nodes;
  if (nodes.length === 0) {
    throw new EmptyGraphError();
  }

  // A03 — roles must be exactly the four built-ins (defense-in-depth).
  const roleOffenders: { nodeId: string | null; roleId: string }[] = [];
  for (const node of nodes) {
    const role = RoleIdSchema.safeParse(node.role);
    if (!role.success) {
      roleOffenders.push({ nodeId: node.id, roleId: String(node.role) });
    }
  }
  if (roleOffenders.length > 0) {
    throw new UnknownNodeRoleError(roleOffenders);
  }

  // Duplicate node ids.
  const byId = new Map<string, TaskNodeDefinition>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new DuplicateNodeIdError(node.id);
    }
    byId.set(node.id, node);
  }

  // Self dependency + missing (unknown-target) dependency.
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (dep === node.id) {
        throw new SelfDependencyError(node.id);
      }
      if (!byId.has(dep)) {
        throw new UnknownDependencyError(node.id, dep);
      }
    }
  }

  // Cycle detection (DFS three-color with path reconstruction).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((node) => [node.id, WHITE]));
  const stack: string[] = [];
  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      const state = color.get(dep);
      if (state === GRAY) {
        const start = stack.indexOf(dep);
        const cycle = [...stack.slice(start), dep];
        throw new DependencyCycleError(cycle);
      }
      if (state === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const node of nodes) {
    if (color.get(node.id) === WHITE) {
      visit(node.id);
    }
  }

  // Topological order (Kahn with a stable ready queue: input order breaks ties).
  const remainingDeps = new Map<string, number>(
    nodes.map((node) => [node.id, new Set(node.dependencies).size])
  );
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of new Set(node.dependencies)) {
      const list = dependents.get(dep);
      if (list === undefined) {
        dependents.set(dep, [node.id]);
      } else {
        list.push(node.id);
      }
    }
  }
  const ready: string[] = nodes
    .filter((node) => remainingDeps.get(node.id) === 0)
    .map((node) => node.id);
  const ordered: TaskNodeDefinition[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    const node = byId.get(id);
    if (node === undefined) {
      break;
    }
    ordered.push(node);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (remainingDeps.get(dependent) ?? 1) - 1;
      remainingDeps.set(dependent, left);
      if (left === 0) {
        ready.push(dependent);
      }
    }
  }

  // Depth = longest edge-count from a root; computed in topological order.
  const depth = new Map<string, number>();
  for (const node of ordered) {
    let nodeDepth = 0;
    for (const dep of node.dependencies) {
      const depDepth = depth.get(dep) ?? -1;
      nodeDepth = Math.max(nodeDepth, depDepth + 1);
    }
    depth.set(node.id, nodeDepth);
  }
  const deepest = [...depth.entries()].reduce(
    (max, entry) => (entry[1] > max[1] ? entry : max),
    ["", -1] as readonly [string, number]
  );
  if (deepest[1] > budgets.maxDepth) {
    throw new GraphBudgetExceededError("max-depth", budgets.maxDepth, deepest[1], deepest[0]);
  }
  if (nodes.length > budgets.maxNodes) {
    throw new GraphBudgetExceededError("max-nodes", budgets.maxNodes, nodes.length);
  }

  return {
    workflowId: workflow.id,
    name: workflow.name,
    nodes: ordered,
    order: new Map(ordered.map((node, index) => [node.id, index])),
    depth
  };
}

/**
 * Full validation entry: parse RAW input with the frozen schema (typed A03/A02
 * rejections) THEN derive the executable plan (typed A08 rejections). This is
 * the function every consumer must run before any spawn-capable step.
 */
export function validateWorkflowPlan(
  input: unknown,
  options: ValidateWorkflowOptions = {}
): ValidatedPlan {
  return validateWorkflowGraph(parseWorkflowDefinition(input), options);
}
