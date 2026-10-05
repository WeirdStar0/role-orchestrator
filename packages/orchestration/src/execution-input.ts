/**
 * M10-02 M6 (execution-input) — the pure node -> execution-input mapping.
 *
 * Everything the engine launcher needs that is DERIVED (not stored): the
 * prompt a node runs under, the profile's timeout/invocation-arg settings,
 * the durable objective/repo-root reads, and the persisted-event views the
 * approval miner consumes.
 *
 * M10-03 (the seam this module reserved): role-context injection for
 * MULTI-node runs. `buildNodePrompt` assembles the child's stdin prompt as
 * the role responsibility header + the node's own objective + the accepted
 * artifact references of the node's dependencies (node id + accepted
 * headSha). Memory/Context injection is the M10-04 seam and is deliberately
 * NOT implemented here — the header comment on buildNodePrompt marks it.
 * The v0.2.1 single-node prompt (the bare objective) is untouched.
 */
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, RoleId } from "@role-orchestrator/contracts";
import type { ProtocolEventView } from "@role-orchestrator/checkpoint";
import { listEventsForExecution, getTaskRun } from "@role-orchestrator/store";
import { listGraphRevisions } from "@role-orchestrator/dag";
import { isStructuralPlaceholderObjective } from "@role-orchestrator/expand";
import type { ProfileDefinition } from "./driver-contract.js";
import type { MultiNodeRunBook } from "./context.js";
import { EXECUTE_NODE_ID } from "./constants.js";

/**
 * The launch-facing description of ONE execution — what node-driver hands to
 * the engine (via launchExecution) and what the approval continuation mints.
 */
export interface ExecutionLaunchInput {
  readonly executionId: string;
  readonly runId: string;
  readonly roleId: RoleId;
  readonly nodeId: string;
  readonly definitionRevision: string;
  readonly attempt: number;
  readonly dispatchToken: string;
  readonly cwd: string;
  readonly profileId: string;
  readonly objective: string | null;
}

/**
 * The profile's launch settings: the frozen timeout, plus the
 * composition-root invocationArgs extension (never persisted in the profile
 * FILE; defaults match the M9-01 driver: 600 s, no extra args).
 */
export function resolveExecutionSettings(
  profilesById: ReadonlyMap<string, ProfileDefinition>,
  profileId: string
): { readonly timeoutSeconds: number; readonly invocationArgs: readonly string[] } {
  const definition = profilesById.get(profileId);
  return {
    timeoutSeconds: definition?.timeoutSeconds ?? 600,
    invocationArgs: definition?.invocationArgs ?? []
  };
}

/** The child's stdin prompt: the objective, or the honest synthetic fallback. */
export function executionPrompt(input: Pick<ExecutionLaunchInput, "objective" | "runId" | "nodeId">): string {
  return input.objective ?? `run ${input.runId} node ${input.nodeId}`;
}

/**
 * The run objective comes from the frozen graph revision (durable). The
 * v0.2.1 single-node graph's one node is "execute".
 */
export function objectiveOfRun(db: DatabaseSync, runId: string): string | null {
  return objectiveOfNode(db, runId, EXECUTE_NODE_ID);
}

/**
 * M10-03: one node's objective, read from the durable graph revisions.
 * Newest declaration first, skipping the structural placeholders an expansion
 * revision records for already-stored nodes (their real objectives live in
 * earlier revisions; the minted pair's real objectives live in the expansion
 * revision itself). Falls back to the latest revision's declaration when
 * every declaration is a placeholder.
 */
export function objectiveOfNode(db: DatabaseSync, runId: string, nodeId: string): string | null {
  const revisions = listGraphRevisions(db, runId);
  let latestDeclaration: string | null = null;
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    const node = revision?.workflow.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) continue;
    latestDeclaration = node.objective;
    if (!isStructuralPlaceholderObjective(node.objective)) return node.objective;
  }
  return latestDeclaration;
}

/** The fixed one-line responsibility header per built-in role (AGENTS.md roles). */
const ROLE_RESPONSIBILITY_HEADERS: Readonly<Record<RoleId, string>> = Object.freeze({
  coordinator: "Coordinator：澄清任务、提出 DAG、按权限创建子任务、记录业务决定。",
  architect: "Architect：给出方案与接口，默认只读代码，通过 Artifact 提交建议。",
  developer: "Developer：在授权的 Execution worktree 中实现与测试。",
  reviewer: "Reviewer：检查候选 SHA、diff、测试和验收，verdict 绑定 candidateSha。"
});

/** One dependency artifact reference in the role-context prompt. */
export interface DependencyArtifactReference {
  readonly nodeId: string;
  /** The dependency's accepted output commit (or the run base it fell back to). */
  readonly headSha: string;
}

/**
 * M10-03: the multi-node child's stdin prompt — the role responsibility
 * header, the node's own objective, and the accepted artifact references of
 * the node's dependencies. Deterministic (newline-joined; dependency list in
 * declared order). Review nodes additionally carry the reviewed candidate as
 * their (single) dependency reference — the fixed SHA they must judge.
 *
 * M10-04 SEAM (deliberately NOT implemented in this batch): Memory and
 * project-context injection would extend this mapping (docs/
 * MEMORY_AND_CONTEXT.md) — the prompt today carries ONLY the role header,
 * the objective and the dependency artifact references.
 */
export function buildNodePrompt(input: {
  readonly role: RoleId;
  readonly nodeId: string;
  readonly objective: string;
  readonly dependencies: readonly DependencyArtifactReference[];
}): string {
  const lines: string[] = [];
  lines.push(`[role: ${input.role}] ${ROLE_RESPONSIBILITY_HEADERS[input.role]}`);
  lines.push(`任务目标：${input.objective}`);
  if (input.dependencies.length > 0) {
    lines.push("依赖产物：");
    for (const dependency of input.dependencies) {
      lines.push(`- 节点 ${dependency.nodeId}：accepted 输出 ${dependency.headSha}`);
    }
  } else {
    lines.push("依赖产物：无（基于 run 基线提交）。");
  }
  lines.push("（多节点工作流；Memory/Context 注入为后续批次接缝，本提示未携带。）");
  return lines.join("\n");
}

/**
 * The LAUNCH objective of one node: the v0.2.1 single-node prompt (the bare
 * run objective, nullable exactly as before) for runs without a multi-node
 * book; the M6 role-context prompt objective for multi-node runs. Shared by
 * the M4 dispatch path and the M9 approval-continuation launch.
 */
export function nodePromptObjective(
  db: DatabaseSync,
  multiNodeRuns: ReadonlyMap<string, MultiNodeRunBook>,
  runId: string,
  nodeId: string,
  roleId: RoleId,
  dependencies: readonly string[]
): string | null {
  const book = multiNodeRuns.get(runId);
  if (book === undefined) {
    return objectiveOfRun(db, runId);
  }
  const run = getTaskRun(db, runId);
  const dependencyReferences = dependencies.map((dependency) => ({
    nodeId: dependency,
    headSha: book.acceptedOutputs.get(dependency)?.headSha ?? run?.baseSha ?? ""
  }));
  const objective = objectiveOfNode(db, runId, nodeId);
  return buildNodePrompt({
    role: roleId,
    nodeId,
    objective: objective ?? `run ${runId} node ${nodeId}`,
    dependencies: dependencyReferences
  });
}

/** The project row always exists for a run created here; read its repoRoot. */
export function repoRootOf(db: DatabaseSync, projectId: string): string {
  const row = db.prepare("SELECT repo_root FROM projects WHERE id = ?").get(projectId) as
    | { repo_root: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`project "${projectId}" vanished while driving its run`);
  }
  return row.repo_root;
}

/**
 * The persisted (already engine-redacted) event stream as the checkpoint
 * miner's ProtocolEventViews — the exact mapping the former local-api
 * orchestrator and the dogfood driver both carried (two verbatim copies; the
 * convergence of the dogfood copy is step 2).
 */
export function storedEventViews(db: DatabaseSync, executionId: string): readonly ProtocolEventView[] {
  return listEventsForExecution(db, executionId).map((row) => ({
    type: row.type,
    sourceType: null,
    seq: row.seq,
    payload: JSON.parse(row.payload) as Record<string, JsonValue>
  }));
}
