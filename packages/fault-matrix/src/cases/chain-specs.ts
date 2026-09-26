/**
 * The fixed chain scenario of the fault matrix (M4-05): node specs shared by
 * the matrix cases, in the same shape vocabulary as the M2-06 baseline —
 *
 *   plan -> (alpha || beta) -> integrate -> review
 *
 * expressed once, so every case injects its fault into the SAME chain and
 * the matrix stays comparable across reruns.
 */
import type { RoleId } from "@role-orchestrator/contracts";
import type { ChainNodeSpec } from "../pipeline.js";

export const CHAIN_DEFINITION_REVISION = "rev-fm-1";

export const SEED_APP_TS = "export const app = 'role-orchestrator-fault-matrix';\n";
export const SEED_BASELINE_MD = "# fault matrix fixture\n\nseed content\n";
export const ALPHA_FILE_REL = "src/alpha/feature.ts";
export const ALPHA_FILE_CONTENT = "export const alpha = 'fault-matrix-alpha';\n";
export const BETA_FILE_REL = "src/beta/api.ts";
export const BETA_FILE_CONTENT = "export const beta = 'fault-matrix-beta';\n";

/** The full chain in topological order. */
export const CHAIN_SPECS: readonly ChainNodeSpec[] = [
  {
    id: "plan",
    role: "coordinator",
    kind: "plain",
    dependencies: [],
    capabilityTags: ["planning"],
    acceptanceCriteria: ["计划以结构化产物落盘"],
    title: "制定故障注入链路计划",
    objective: "合成 fake-claude 计划节点",
  },
  {
    id: "alpha",
    role: "developer",
    kind: "writer",
    dependencies: ["plan"],
    capabilityTags: ["backend"],
    acceptanceCriteria: ["仅修改 src/alpha/"],
    title: "实现 alpha 输出",
    objective: "合成 fake-codex 写节点",
    files: { [ALPHA_FILE_REL]: ALPHA_FILE_CONTENT },
  },
  {
    id: "beta",
    role: "developer",
    kind: "writer",
    dependencies: ["plan"],
    capabilityTags: ["backend"],
    acceptanceCriteria: ["仅修改 src/beta/"],
    title: "实现 beta 输出",
    objective: "合成 fake-codex 写节点",
    files: { [BETA_FILE_REL]: BETA_FILE_CONTENT },
  },
  {
    id: "integrate",
    role: "architect",
    kind: "integration",
    dependencies: ["alpha", "beta"],
    capabilityTags: ["architecture"],
    acceptanceCriteria: ["集成产物包含全部父输出"],
    title: "集成并行输出",
    objective: "IntegrationService 合并 alpha/beta",
  },
  {
    id: "review",
    role: "reviewer",
    kind: "review",
    dependencies: ["integrate"],
    capabilityTags: ["testing"],
    acceptanceCriteria: ["verdict 绑定 candidateSha"],
    title: "审查集成候选",
    objective: "固定 SHA 审查",
    reviewsNode: "integrate",
  }
] as readonly ChainNodeSpec[];

/** A single-node chain (checkpoint/retry cases): one writer, no dependencies. */
export function singleNodeSpec(nodeId: string, role: RoleId = "developer"): ChainNodeSpec {
  return {
    id: nodeId,
    role,
    kind: "writer",
    dependencies: [],
    capabilityTags: ["backend"],
    acceptanceCriteria: ["合成单节点"],
    title: "合成单写节点",
    objective: "M4-05 单节点场景"
  };
}

/** Seed + both writer outputs — the review's expected candidate content. */
export function chainExpectedFiles(): Record<string, string> {
  return {
    "src/app.ts": SEED_APP_TS,
    "docs/baseline.md": SEED_BASELINE_MD,
    [ALPHA_FILE_REL]: ALPHA_FILE_CONTENT,
    [BETA_FILE_REL]: BETA_FILE_CONTENT
  };
}

/** One exec writer branch + worktree + commit (the integration-case parent). */
export interface ParentBranch {
  readonly nodeId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly headSha: string;
}

