/**
 * The baseline scenario: the M2-06 example workflow
 *
 *   plan -> (frontend || backend) -> integrate -> review -> followup ->
 *   integrate-followup
 *
 * expressed as ONE source of truth: node specs (role/kind/deps/files) from
 * which both the raw workflow input (validated by `createRunGraph` against
 * the frozen contracts schema) and the driver's per-node behavior are derived.
 *
 * The first five nodes are the BACKLOG M2-06 example ("plan/design/frontend/
 * backend/review"); `followup` + `integrate-followup` extend the SAME run with
 * a forward-only candidate change after the review pass — the honest A12
 * setup ("Reviewer 后 candidateSha 改变"): the candidate really moves (new
 * parent output really merged, new candidateSha really recorded) instead of a
 * fabricated SHA being queried.
 *
 * Role -> profile mapping comes from the project bindings (A01: one profile
 * per role, no node-level override): coordinator/architect bind the claude
 * profile, developer/reviewer the codex profile, so BOTH bundled dialects
 * cooperate through the structured DAG. frontend/backend are capabilityTags
 * on developer nodes (never extra roles).
 */
import { CAPABILITY_TAGS, type RoleId } from "@role-orchestrator/contracts";

/** The frozen capability-tag vocabulary (annotations, never extra roles). */
type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

/** How a node's execution phase behaves in the driver. */
export type BaselineNodeKind = "plain" | "writer" | "integration" | "review";

export interface BaselineNodeSpec {
  readonly id: string;
  readonly role: RoleId;
  readonly kind: BaselineNodeKind;
  readonly dependencies: readonly string[];
  readonly capabilityTags: readonly CapabilityTag[];
  readonly acceptanceCriteria: readonly string[];
  readonly title: string;
  readonly objective: string;
  /** fake-cli scenario passed as the engine's invocation args. */
  readonly scenario: string;
  /** Inter-line delay (ms) — widens the wall-clock window of the parallel pair. */
  readonly delayMs?: number;
  /** Writer only: files this node's output commit contains (A09 content). */
  readonly files?: Readonly<Record<string, string>>;
  /** Review only: the node whose candidateSha this reviewer consumes. */
  readonly reviewsNode?: string;
}

export const BASELINE_WORKFLOW_ID = "wf-e2e-baseline";
export const BASELINE_DEFINITION_REVISION = "rev-e2e-1";

export const FRONTEND_FILE_REL = "src/frontend/app.css";
export const FRONTEND_FILE_CONTENT = ":root {\n  color-scheme: light;\n}\n/* e2e baseline frontend output */\n";
export const BACKEND_FILE_REL = "src/backend/api.ts";
export const BACKEND_FILE_CONTENT = "export const api = { baseline: 'e2e-parallel' };\n";
export const FOLLOWUP_FILE_REL = "docs/changelog.md";
export const FOLLOWUP_FILE_CONTENT = "# changelog\n\n- e2e baseline followup output\n";

export const PLAN_NODE: BaselineNodeSpec = {
  id: "plan",
  role: "coordinator",
  kind: "plain",
  dependencies: [],
  capabilityTags: ["planning"],
  acceptanceCriteria: ["计划以结构化产物落盘，不改动代码基线"],
  title: "制定并行开发计划",
  objective: "拆解前端/后端并行分支并给出验收标准（synthetic fake-claude 执行）",
  scenario: "success"
};

export const FRONTEND_NODE: BaselineNodeSpec = {
  id: "frontend",
  role: "developer",
  kind: "writer",
  dependencies: [PLAN_NODE.id],
  capabilityTags: ["frontend"],
  acceptanceCriteria: ["仅修改 src/frontend/ 下的文件"],
  title: "实现前端样式",
  objective: "在独立 worktree 中修改前端文件（synthetic fake-codex 执行）",
  scenario: "success",
  delayMs: 30,
  files: { [FRONTEND_FILE_REL]: FRONTEND_FILE_CONTENT }
};

export const BACKEND_NODE: BaselineNodeSpec = {
  id: "backend",
  role: "developer",
  kind: "writer",
  dependencies: [PLAN_NODE.id],
  capabilityTags: ["backend"],
  acceptanceCriteria: ["仅修改 src/backend/ 下的文件"],
  title: "实现后端接口",
  objective: "在独立 worktree 中修改后端文件（synthetic fake-codex 执行）",
  scenario: "success",
  delayMs: 30,
  files: { [BACKEND_FILE_REL]: BACKEND_FILE_CONTENT }
};

export const INTEGRATE_NODE: BaselineNodeSpec = {
  id: "integrate",
  role: "architect",
  kind: "integration",
  dependencies: [FRONTEND_NODE.id, BACKEND_NODE.id],
  capabilityTags: ["architecture", "fullstack"],
  acceptanceCriteria: ["集成产物包含全部父输出（A09）", "冲突时不丢弃任何分支"],
  title: "集成并行输出",
  objective: "按拓扑序合并前端/后端输出为 candidateSha（IntegrationService）",
  scenario: "success"
};

export const REVIEW_NODE: BaselineNodeSpec = {
  id: "review",
  role: "reviewer",
  kind: "review",
  dependencies: [INTEGRATE_NODE.id],
  capabilityTags: ["testing"],
  acceptanceCriteria: ["verdict 绑定 candidateSha（A12）", "验证命令只能写一次性目录"],
  title: "审查集成候选",
  objective: "在固定 SHA 验证目录中验证候选内容并落 verdict",
  scenario: "success",
  reviewsNode: INTEGRATE_NODE.id
};

export const FOLLOWUP_NODE: BaselineNodeSpec = {
  id: "followup",
  role: "developer",
  kind: "writer",
  dependencies: [REVIEW_NODE.id],
  capabilityTags: ["fullstack"],
  acceptanceCriteria: ["仅修改 docs/ 下的文件"],
  title: "追加变更说明",
  objective: "审查通过后追加文档输出，使集成分支产生新的候选",
  scenario: "success",
  files: { [FOLLOWUP_FILE_REL]: FOLLOWUP_FILE_CONTENT }
};

export const INTEGRATE_FOLLOWUP_NODE: BaselineNodeSpec = {
  id: "integrate-followup",
  role: "architect",
  kind: "integration",
  dependencies: [FOLLOWUP_NODE.id],
  capabilityTags: ["architecture"],
  acceptanceCriteria: ["新候选仍包含旧候选全部内容（前向叠加）"],
  title: "集成后续变更",
  objective: "把 followup 输出合并进 task 分支，产生变更后的 candidateSha（A12 前提）",
  scenario: "success"
};

/** The full baseline node list in topological order. */
export const BASELINE_NODE_SPECS: readonly BaselineNodeSpec[] = [
  PLAN_NODE,
  FRONTEND_NODE,
  BACKEND_NODE,
  INTEGRATE_NODE,
  REVIEW_NODE,
  FOLLOWUP_NODE,
  INTEGRATE_FOLLOWUP_NODE
];

/**
 * The RAW workflow input for `createRunGraph` — intentionally `unknown`-shaped
 * so the frozen contracts schema (strict, A02/A03) is the authority, not this
 * package. Field order/shape mirrors `WorkflowDefinitionSchema`.
 */
export function baselineWorkflowRaw(
  specs: readonly BaselineNodeSpec[] = BASELINE_NODE_SPECS
): unknown {
  return {
    id: BASELINE_WORKFLOW_ID,
    name: "M2-06 并行开发端到端基准",
    nodes: specs.map((spec) => ({
      id: spec.id,
      role: spec.role,
      title: spec.title,
      objective: spec.objective,
      dependencies: [...spec.dependencies],
      capabilityTags: [...spec.capabilityTags],
      acceptanceCriteria: [...spec.acceptanceCriteria]
    }))
  };
}
