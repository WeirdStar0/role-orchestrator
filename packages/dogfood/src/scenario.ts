/**
 * The dogfood scenario (M6-04): ONE small feature — "add a fixable feature
 * file to the fixture repo" — expressed as ONE source of truth from which
 * both the raw workflow input (validated by `createRunGraph` against the
 * frozen contracts schema) and the driver's per-node behavior are derived.
 *
 * Initial graph (the 建图 phase):
 *
 *   plan (coordinator) -> impl (developer, writer) -> integrate (architect,
 *   integration) -> review (reviewer, reviews integrate)
 *
 * The review's round-1 validation REQUIRES the repair file that the round-1
 * candidate genuinely does not contain — a content-grounded FAIL (injection
 * point 1) that grounds the controlled expansion. The expansion mints
 * `integrate-fix-2` (the repair; its first execution proposes an unscoped
 * write — injection point 2, the approval checkpoint subject) and
 * `integrate-review-2` (the re-review; its FIRST launch is interrupted in
 * the A24 window — injection point 3 — and its retry succeeds).
 *
 * Node specs are DATA; all quota, state-machine, integration, review,
 * expansion, approval and reconcile semantics come from the product
 * packages. The driver — not the product — applies the declared writer files
 * and commits them, standing in for the controlled Git Service commit step
 * (same discipline as the M2-06 baseline and the M5-05 flows).
 */
import type { RoleId } from "@role-orchestrator/contracts";
import type { BaselineNodeSpec } from "@role-orchestrator/e2e-baseline";

/** The raw (schema-checked downstream) workflow input for the dogfood run. */
export function dogfoodWorkflowRaw(specs: readonly BaselineNodeSpec[]): unknown {
  return {
    id: "wf-dogfood-1",
    name: "M6-04 受控 dogfood 小功能",
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

function node(spec: {
  readonly id: string;
  readonly role: RoleId;
  readonly kind?: BaselineNodeSpec["kind"];
  readonly dependencies?: readonly string[];
  readonly capabilityTags?: readonly string[];
  readonly title: string;
  readonly objective: string;
  readonly scenario?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly reviewsNode?: string;
}): BaselineNodeSpec {
  return {
    id: spec.id,
    role: spec.role,
    kind: spec.kind ?? "plain",
    dependencies: spec.dependencies ?? [],
    // The frozen contracts schema (via createRunGraph) is the authority over
    // these tags; the cast only bridges this table's plain-string input.
    capabilityTags: (spec.capabilityTags ?? []) as BaselineNodeSpec["capabilityTags"],
    acceptanceCriteria: [`验收：${spec.title}`],
    title: spec.title,
    objective: spec.objective,
    scenario: spec.scenario ?? "success",
    ...(spec.files === undefined ? {} : { files: spec.files }),
    ...(spec.reviewsNode === undefined ? {} : { reviewsNode: spec.reviewsNode })
  };
}

export const DF_IMPL_FILE_REL = "src/feature/app.txt";
export const DF_IMPL_FILE_CONTENT = "dogfood feature: first candidate output\n";
export const DF_FIX_FILE_REL = "src/feature/fix.txt";
export const DF_FIX_FILE_CONTENT = "dogfood feature: approved continuation repair output\n";

/** The dogfood graph, in topological order. */
export const DF_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "plan",
    role: "coordinator",
    title: "dogfood 计划",
    objective: "拆解小功能并产出首个节点产物（fake-claude）",
    capabilityTags: ["planning"]
  }),
  node({
    id: "impl",
    role: "developer",
    kind: "writer",
    dependencies: ["plan"],
    title: "dogfood 实现",
    objective: "在独立 worktree 写入小功能输出文件（fake-codex）",
    files: { [DF_IMPL_FILE_REL]: DF_IMPL_FILE_CONTENT },
    capabilityTags: ["backend"]
  }),
  node({
    id: "integrate",
    role: "architect",
    kind: "integration",
    dependencies: ["impl"],
    title: "dogfood 集成",
    objective: "集成首个候选为 candidateSha（单 writer 集成）",
    capabilityTags: ["architecture"]
  }),
  node({
    id: "review",
    role: "reviewer",
    kind: "review",
    dependencies: ["integrate"],
    title: "dogfood 首轮审查（注入失败）",
    objective: "对首轮候选执行验证命令（失败路径，触发受控扩图 Proposal）",
    reviewsNode: "integrate",
    capabilityTags: ["testing"]
  })
];

/**
 * The round-2 specs the expansion mints (derived — the driver declares them
 * only so the pump-side runner knows each minted node's role/behavior; the
 * AUTHORITY for their existence, ids, roles and dependencies is the
 * expander's durable `review_expansions` row, which the driver reads back).
 */
export const DF_FIX_ROUND2_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "integrate-fix-2",
    role: "architect",
    kind: "writer",
    dependencies: ["integrate"],
    title: "dogfood 修复（第 2 轮，审批检查点主体）",
    objective: "首轮执行提出未授权写入；批准后由有限续行完成修复输出",
    files: { [DF_FIX_FILE_REL]: DF_FIX_FILE_CONTENT },
    capabilityTags: ["architecture"]
  }),
  node({
    id: "integrate-review-2",
    role: "reviewer",
    kind: "review",
    dependencies: ["integrate-fix-2"],
    title: "dogfood 复审（第 2 轮，中断注入主体）",
    objective: "首次启动在 A24 窗口被中断；人工解决后重试并对新候选记录 pass（A12 绑定）",
    reviewsNode: "integrate-fix-2",
    capabilityTags: ["testing"]
  })
];

/** The review expectations: BOTH files must be present for a pass verdict. */
export function dfReviewExpectations(): Readonly<Record<string, string>> {
  return {
    [DF_IMPL_FILE_REL]: DF_IMPL_FILE_CONTENT,
    [DF_FIX_FILE_REL]: DF_FIX_FILE_CONTENT
  };
}
