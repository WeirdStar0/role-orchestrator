/**
 * The five flow scenarios (M5-05): one source of truth per flow, from which
 * BOTH the raw workflow input (validated by `createRunGraph` against the
 * frozen contracts schema) and the pump's per-node behavior are derived.
 *
 * This mirrors the M2-06 baseline's scenario discipline: node specs are
 * DATA; all quota, state-machine, integration and review semantics come from
 * the product packages. The pump (pump.ts) — not the product — applies the
 * declared writer files and commits them, standing in for the controlled Git
 * Service commit step that lands in a later milestone.
 */
import type { RoleId } from "@role-orchestrator/contracts";
import type { BaselineNodeSpec } from "@role-orchestrator/e2e-baseline";

/** The raw (schema-checked downstream) workflow input for one flow. */
export function workflowRaw(workflowId: string, name: string, specs: readonly BaselineNodeSpec[]): unknown {
  return {
    id: workflowId,
    name,
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
  readonly delayMs?: number;
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
    ...(spec.delayMs === undefined ? {} : { delayMs: spec.delayMs }),
    ...(spec.files === undefined ? {} : { files: spec.files }),
    ...(spec.reviewsNode === undefined ? {} : { reviewsNode: spec.reviewsNode })
  };
}

// ---------------------------------------------------------------------------
// Flow 1 — 顺序 (sequential): s1 -> s2 -> s3, s2 is a slow writer whose
// RUNNING window is wide enough for the browser to capture the SVG state
// change live.
// ---------------------------------------------------------------------------

export const SEQ_FILE_REL = "src/seq/output.txt";
export const SEQ_FILE_CONTENT = "sequential flow output (browser e2e)\n";

export const SEQ_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "s1",
    role: "coordinator",
    title: "顺序流程入口",
    objective: "拆解顺序任务并产出首个节点产物（fake-claude）",
    capabilityTags: ["planning"]
  }),
  node({
    id: "s2",
    role: "developer",
    kind: "writer",
    dependencies: ["s1"],
    title: "顺序流程实现",
    objective: "在独立 worktree 写入顺序输出文件（fake-codex，慢速便于浏览器观察状态）",
    delayMs: 300,
    files: { [SEQ_FILE_REL]: SEQ_FILE_CONTENT },
    capabilityTags: ["backend"]
  }),
  node({
    id: "s3",
    role: "reviewer",
    dependencies: ["s2"],
    title: "顺序流程复核",
    objective: "确认顺序链终点状态（fake-codex）",
    capabilityTags: ["testing"]
  })
];

// ---------------------------------------------------------------------------
// Flow 2 — 并行 (parallel): plan -> (fe || be) -> integrate. Both branch
// nodes bind the developer role, hence ONE profile and ONE credential group;
// with the unverified-credential cap at 1 the scheduler serializes them (A07).
// ---------------------------------------------------------------------------

export const PAR_FE_FILE_REL = "src/frontend/style.css";
export const PAR_FE_FILE_CONTENT = "/* parallel frontend output (browser e2e) */\n";
export const PAR_BE_FILE_REL = "src/backend/api.ts";
export const PAR_BE_FILE_CONTENT = "export const api = { source: 'browser-e2e-parallel' };\n";

export const PAR_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "plan",
    role: "coordinator",
    title: "并行计划",
    objective: "给出并行分支计划（fake-claude）",
    capabilityTags: ["planning"]
  }),
  node({
    id: "fe",
    role: "developer",
    kind: "writer",
    dependencies: ["plan"],
    title: "并行前端分支",
    objective: "前端分支输出（fake-codex，凭据锁下与后端分支串行）",
    delayMs: 200,
    files: { [PAR_FE_FILE_REL]: PAR_FE_FILE_CONTENT },
    capabilityTags: ["frontend"]
  }),
  node({
    id: "be",
    role: "developer",
    kind: "writer",
    dependencies: ["plan"],
    title: "并行后端分支",
    objective: "后端分支输出（fake-codex，凭据锁下与前端分支串行）",
    delayMs: 200,
    files: { [PAR_BE_FILE_REL]: PAR_BE_FILE_CONTENT },
    capabilityTags: ["backend"]
  }),
  node({
    id: "integ",
    role: "architect",
    kind: "integration",
    dependencies: ["fe", "be"],
    title: "并行集成",
    objective: "合并两个并行分支为 candidateSha（A09）",
    capabilityTags: ["architecture"]
  })
];

// ---------------------------------------------------------------------------
// Flow 3 — 返工 (rework): a -> int (integration) -> r (reviewer). r fails the
// first candidate; the browser submits the controlled expansion; the minted
// int-fix-2 / int-review-2 pair runs and the re-review passes.
// ---------------------------------------------------------------------------

export const RW_A_FILE_REL = "src/feature/app.txt";
export const RW_A_FILE_CONTENT = "rework flow: first candidate output\n";
export const RW_FIX_FILE_REL = "src/feature/fix.txt";
export const RW_FIX_FILE_CONTENT = "rework flow: repair output for round 2\n";

export const RW_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "a",
    role: "developer",
    kind: "writer",
    title: "返工源头实现",
    objective: "产出首个候选（fake-codex）",
    files: { [RW_A_FILE_REL]: RW_A_FILE_CONTENT },
    capabilityTags: ["backend"]
  }),
  node({
    id: "int",
    role: "architect",
    kind: "integration",
    dependencies: ["a"],
    title: "返工候选集成",
    objective: "集成首个候选为 candidateSha",
    capabilityTags: ["architecture"]
  }),
  node({
    id: "r",
    role: "reviewer",
    kind: "review",
    dependencies: ["int"],
    title: "首轮审查（必失败）",
    objective: "对首轮候选执行验证命令（失败路径，触发扩图 Proposal）",
    reviewsNode: "int",
    capabilityTags: ["testing"]
  })
];

/** Round-2 specs minted by the expansion (run after the browser submits it). */
export const RW_FIX_ROUND2_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "int-fix-2",
    role: "architect",
    kind: "writer",
    dependencies: ["int"],
    title: "返工修复（第 2 轮）",
    objective: "在首轮候选之上落修复输出（扩图铸造节点）",
    files: { [RW_FIX_FILE_REL]: RW_FIX_FILE_CONTENT },
    capabilityTags: ["architecture"]
  }),
  node({
    id: "int-review-2",
    role: "reviewer",
    kind: "review",
    dependencies: ["int-fix-2"],
    title: "复审（第 2 轮，须通过）",
    objective: "对修复后的候选复审并记录 pass verdict（A12 绑定）",
    reviewsNode: "int-fix-2",
    capabilityTags: ["testing"]
  })
];

// ---------------------------------------------------------------------------
// Flow 4 — 审批 (approval): a1 (writer, the checkpoint subject) -> i1
// (integration, feeds the diff view's candidateSha).
// ---------------------------------------------------------------------------

export const AP_FILE_REL = "src/ApprovalFlow.txt";
export const AP_FILE_CONTENT = "approval flow: continuation output (browser e2e)\n";

export const AP_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "a1",
    role: "architect",
    kind: "writer",
    title: "审批主体节点",
    objective: "提出需要批准的写入动作并在续行后完成输出",
    files: { [AP_FILE_REL]: AP_FILE_CONTENT },
    capabilityTags: ["architecture"]
  }),
  node({
    id: "i1",
    role: "architect",
    kind: "integration",
    dependencies: ["a1"],
    title: "审批流集成",
    objective: "把续行输出集成为候选，供 diff 面板展示 candidateSha",
    capabilityTags: ["architecture"]
  })
];

// ---------------------------------------------------------------------------
// Flow 5 — 恢复 (recovery): r1 -> r2. r2's launch window is interrupted
// (A24 window, A22 recipe): RECOVERY_REQUIRED shows in the browser, the
// operator resolves, attempt 2 retries successfully.
// ---------------------------------------------------------------------------

export const REC_FILE_REL = "src/recovery/after-retry.txt";
export const REC_FILE_CONTENT = "recovery flow: retry output after human resolution\n";

export const REC_SPECS: readonly BaselineNodeSpec[] = [
  node({
    id: "r1",
    role: "developer",
    kind: "writer",
    title: "恢复流程前驱",
    objective: "先完成前驱输出（fake-codex）",
    files: { "src/recovery/first.txt": "recovery flow: first output\n" },
    capabilityTags: ["backend"]
  }),
  node({
    id: "r2",
    role: "developer",
    kind: "writer",
    dependencies: ["r1"],
    title: "恢复流程重试节点",
    objective: "中断后被人工解决并重试成功（A22）",
    files: { [REC_FILE_REL]: REC_FILE_CONTENT },
    capabilityTags: ["backend"]
  })
];
