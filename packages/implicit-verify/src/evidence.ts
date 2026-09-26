import { z } from "zod";

/**
 * M4-06 frozen DATA-PLANE evidence for A35 (CLI 隐式配置 / 内部子 Agent/MCP).
 *
 * Everything in this module is a verbatim record of what the accepted M0
 * reports MEASURED with real CLI invocations. This package re-states the
 * facts as data so tests can pin the CONTROL PLANE (capability-gate +
 * scheduler + budget ledgers) against them. No number below was produced by
 * this package: 真实 CLI 隐式加载的行为验证属 M0-03/M0-04（及其拓展），
 * 本包只验证控制面对不可见性的处理.
 *
 * Sources (frozen, see CHECKSUMS.sha256):
 * - `reports/M0-03-claude-capability.md` 第 6/7 节 + `packages/cli-events/fixtures-real/claude/manifest.json`
 *   inventorySizes（tools 33/44, mcp_servers 9, slash_commands 171, skills 133,
 *   agents 13, plugins 4）。
 * - `reports/M0-04-codex-capability.md` 第 6/7 节。
 * - `docs/CLI_ADAPTERS.md`「隐式行为控制」、`docs/ACCEPTANCE.md` A34/A35 行。
 */

/** One measured implicit-loading fact from an M0 report. */
export const ImplicitLoadingFactSchema = z.strictObject({
  kind: z.enum([
    "mcp-servers",
    "agents",
    "skills",
    "plugins",
    "slash-commands",
    "session-start-hooks",
    "subagent-stats",
    "in-stream-skill-budget-hint",
    "mcp-manifest-invisible"
  ]),
  /** Measured count, or null when the report records a qualitative fact. */
  count: z.number().int().min(0).nullable(),
  /** Verbatim-scoped detail of what the report measured. */
  detail: z.string().min(1)
});
export type ImplicitLoadingFact = z.infer<typeof ImplicitLoadingFactSchema>;

/** Per-runtime data-plane observation of implicit loading (A35, measured in M0). */
export const RuntimeImplicitLoadingEvidenceSchema = z.strictObject({
  runtime: z.enum(["claude", "codex"]),
  /** The accepted M0 report section that measured these facts. */
  sourceReport: z.string().min(1),
  /** Capability-matrix cell that RECORDS the observation (status verified). */
  observationCellId: z.string().min(1),
  /** Capability-matrix cell for the explicit-control dimension (NOT verified). */
  controlCellId: z.string().min(1),
  facts: z.array(ImplicitLoadingFactSchema).min(1),
  conclusion: z.string().min(1),
  /**
   * The data-plane property this package verifies the control plane against:
   * the CLI's internal extra executions (its own sub-agents/MCP calls/hooks)
   * are INVISIBLE to the orchestrator's ledgers. At most aggregate stats
   * (claude `subagent_stats`) appear inside the result payload — the
   * executions themselves are not DAG-visible and not dispatchable.
   */
  ledgerVisibility: z.literal("invisible")
});
export type RuntimeImplicitLoadingEvidence = z.infer<typeof RuntimeImplicitLoadingEvidenceSchema>;

/** The frozen M0-03/M0-04 implicit-loading measurements, re-stated as data. */
export const M0_IMPLICIT_LOADING_EVIDENCE: readonly RuntimeImplicitLoadingEvidence[] = [
  {
    runtime: "claude",
    sourceReport: "reports/M0-03-claude-capability.md 第 6/7 节（A35）",
    observationCellId: "claude.implicit-loading.observation",
    controlCellId: "claude.implicit-loading.explicit-control",
    facts: [
      {
        kind: "mcp-servers",
        count: 9,
        detail: "init 事件列出 9 个用户级 MCP server（部分 connected，且两次调用连接集合不同）"
      },
      { kind: "agents", count: 13, detail: "init 隐式加载 13 个 agents" },
      { kind: "skills", count: 133, detail: "init 隐式加载 133 个 skills" },
      { kind: "plugins", count: 4, detail: "init 隐式加载 4 个 plugins" },
      { kind: "slash-commands", count: 171, detail: "init 列出 171 个 slash commands" },
      {
        kind: "session-start-hooks",
        count: null,
        detail:
          "SessionStart hook 以 hook_started/hook_response（含 exit_code/outcome）真实出现在协议流；两次调用 hook 数量可变（2 对或 1 对）"
      },
      {
        kind: "subagent-stats",
        count: null,
        detail:
          "result.subagent_stats 含 refused: depth_limit/concurrency_limit/budget 计数字段（本次全 0）——原生子 Agent 额外执行入口默认存在，但对编排器只是聚合计数，不是可派发/可计费的 execution"
      }
    ],
    conclusion:
      "原生子 Agent/MCP 的额外执行入口在真实环境默认存在；capability gate 必须将其纳入受控/计费/拒绝设计，不能假设裸 -p 是干净的。",
    ledgerVisibility: "invisible"
  },
  {
    runtime: "codex",
    sourceReport: "reports/M0-04-codex-capability.md 第 6/7 节（A33/A35）",
    observationCellId: "codex.implicit-loading.skills-plugins",
    controlCellId: "codex.implicit-loading.mcp",
    facts: [
      {
        kind: "in-stream-skill-budget-hint",
        count: null,
        detail:
          "调用 #6/#7/#8 流内 item error 明确提示 skills context budget 与禁用指引——非交互 exec 默认加载用户级 skills/plugins，即使事件流本体不显示清单"
      },
      {
        kind: "mcp-manifest-invisible",
        count: null,
        detail:
          "exec JSONL 流不携带 MCP 清单/连接状态；流里没有不等于没有加载（流不可见 ≠ 未加载）"
      }
    ],
    conclusion:
      "skills/plugins 隐式加载有直接流内证据；MCP 是否加载 unknown，按 unknown-deny 处理。",
    ledgerVisibility: "invisible"
  }
];

// Parse at module load: malformed evidence data fails fast (registry pattern).
for (const entry of M0_IMPLICIT_LOADING_EVIDENCE) {
  RuntimeImplicitLoadingEvidenceSchema.parse(entry);
}

/**
 * Expected capability-matrix cell statuses for the A35 surface, pinned so an
 * accidental registry weakening (an unverified cell flipped to verified, a
 * blocked usage mode flipped open) fails these tests loudly.
 */
export const A35_CAPABILITY_CELL_EXPECTATIONS: readonly {
  readonly capability: string;
  readonly expectedStatus: "verified" | "unverified" | "blocked";
  readonly why: string;
}[] = [
  {
    capability: "claude.implicit-loading.observation",
    expectedStatus: "verified",
    why: "claude init 隐式加载清单是真实采集的观察（M0-03 s6）"
  },
  {
    capability: "claude.implicit-loading.explicit-control",
    expectedStatus: "unverified",
    why: "显式禁用/管理隐式加载的机制从未测试——unverified 即不可用（unknown-deny）"
  },
  {
    capability: "claude.unattended-write-mode",
    expectedStatus: "blocked",
    why: "非交互无审批通道 + 默认权限拒绝行为 unverified，无人值守写无法满足授权交集"
  },
  {
    capability: "codex.implicit-loading.skills-plugins",
    expectedStatus: "verified",
    why: "skills/plugins 隐式加载有流内 item error 直接证据（M0-04 s6）"
  },
  {
    capability: "codex.implicit-loading.mcp",
    expectedStatus: "unverified",
    why: "exec 流不携带 MCP 清单；流不可见不等于未加载，按 unknown-deny"
  },
  {
    capability: "codex.unattended-write-mode",
    expectedStatus: "blocked",
    why: "默认模式写入直接落盘且无审批通道（verified），无人值守写必须保持禁用"
  }
];

/**
 * Expected blocked-assumption verdicts for the A35 surface (checkAssumption).
 * Each id MUST be listed+blocked with exactly this required control.
 */
export const A35_ASSUMPTION_EXPECTATIONS: readonly {
  readonly id: string;
  readonly requiredControl: "node-checkpoint" | "explicit-management";
  readonly why: string;
}[] = [
  {
    id: "codex.default-mode-unattended-write",
    requiredControl: "node-checkpoint",
    why: "codex 默认模式写入直接落盘、无审批事件（M0-04 s3#3 盘上 5 字节验证）"
  },
  {
    id: "claude.mid-run-approval-in-noninteractive",
    requiredControl: "node-checkpoint",
    why: "claude -p 全部真实调用零 control_request 审批事件——无中途暂停通道可假设"
  },
  {
    id: "implicit-loading.unmanaged-clean-baseline",
    requiredControl: "explicit-management",
    why: "裸 -p/exec 不干净：清单+hash+显式信任管理是前置条件（M0-03/04 实测）"
  }
];

/**
 * Per-runtime blocked assumptions an unattended-write decision probe must
 * consult. The implicit-loading assumption applies to both runtimes (the
 * M0-03/04 measurements cover both CLIs).
 */
export const A35_RUNTIME_ASSUMPTION_IDS: Readonly<
  Record<"claude" | "codex", readonly string[]>
> = {
  claude: [
    "claude.mid-run-approval-in-noninteractive",
    "implicit-loading.unmanaged-clean-baseline"
  ],
  codex: [
    "codex.default-mode-unattended-write",
    "implicit-loading.unmanaged-clean-baseline"
  ]
};
