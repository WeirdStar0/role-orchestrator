import {
  BlockedArgvPatternSchema,
  BlockedAssumptionSchema,
  CapabilityStatusRecordSchema,
  type BlockedArgvPattern,
  type BlockedAssumption,
  type CapabilityStatusRecord
} from "./schema.js";

/**
 * M0-06 capability-gate registry DATA.
 *
 * Every entry below is grounded in accepted M0 evidence (reports/M0-03,
 * reports/M0-04, reports/M0-05 and their fixtures under
 * packages/cli-events/fixtures-real/) or in frozen docs. No entry marks an
 * unproven capability as supported; unknown is denied by default.
 *
 * This file is data for M1 consumption. It deliberately contains no runtime
 * interceptor - enforcement lives in the (future) execution layer.
 *
 * Shared evidence shorthand used below:
 * - M03 = reports/M0-03-claude-capability.md (section refs like "M03 s5#1")
 * - M04 = reports/M0-04-codex-capability.md
 * - M05 = reports/M0-05-windows-launcher.md
 * - FIX/claude/<file>, FIX/codex/<file> = packages/cli-events/fixtures-real/
 * - APPENDIX = M03 补采附录 (added by M0-06, 2026-09-22: 2 attempts, both failed)
 */

/* ------------------------------------------------------------------ */
/* Blocked argv-shaped patterns                                        */
/* ------------------------------------------------------------------ */

const RAW_BLOCKED_ARGV_PATTERNS = [
  {
    id: "argv.permission-skip-flags",
    patternSource: "--dangerously-[a-z0-9-]+|danger-full-access",
    title: "跳过权限/审批/沙箱的 CLI 参数（--dangerously-skip-permissions 及等价物）",
    rationale:
      "任何以 --dangerously- 命名族的参数（claude --dangerously-skip-permissions、codex --dangerously-bypass-approvals-and-sandbox 等）都会关闭权限/审批/沙箱控制面；codex 的 danger-full-access 沙箱模式是等价的保护关闭。M0 实测全程未使用此类参数，产品侧默认禁止，无 v1 授权路径。",
    requiredControl: "forbidden",
    evidence: [
      "docs/CLI_ADAPTERS.md: 默认不启用自动跳过权限的参数",
      "docs/SECURITY_MODEL.md 授权规则: deny 优先；Unknown 能力不视作允许",
      "M03 s2 / M04 s2: 全部真实调用未使用任何跳过权限参数",
      "M06 gate: capability-matrix 报告 blocked 列"
    ]
  },
  {
    id: "argv.environment-gate-bypass",
    patternSource: "--skip-git-repo-check",
    title: "绕过 codex exec 的 git 环境门",
    rationale:
      "codex exec 默认拒绝在非 git 目录运行（exit 1 + stderr 提示，683ms 实测），这是经真实命令验证的默认防护。静默绕过它等于关闭一个控制面检查；确需使用时必须逐次显式授权并记录，不得成为默认参数。",
    requiredControl: "explicit-authorization",
    evidence: [
      "M04 s2 环境门发现: 非 git 目录 exit 1，--skip-git-repo-check 全程未使用",
      "FIX/codex/manifest.json environmentGate: 逐字记录的默认拒绝观察",
      "M06 gate: capability-matrix 报告 codex 非交互入口行"
    ]
  }
] as const;

/* ------------------------------------------------------------------ */
/* Blocked assumptions / implementation claims                         */
/* ------------------------------------------------------------------ */

const RAW_BLOCKED_ASSUMPTIONS = [
  {
    id: "codex.default-mode-unattended-write",
    claim:
      "codex exec 默认模式可以无人值守直接写工作区（不需要产品侧检查点）。",
    title: "codex 无审批写入的无人值守使用",
    rationale:
      "真实默认模式权限探针：要求创建的文件被真实创建（盘上 5 字节验证），command_execution 以 exit_code 0 完成，全程无 approval.requested/approval.denied 事件——CLI 不会替产品挡住工作区写入，也没有可等待的审批通道。任何具备写能力的无人值守执行必须先经过节点检查点。",
    requiredControl: "node-checkpoint",
    evidence: [
      "M04 s3#3 + s7 A19: 写入直接落盘、无审批事件",
      "FIX/codex/codex-permission-probe-write-executed.real.jsonl",
      "docs/CLI_ADAPTERS.md 审批能力不可假定一致: 节点检查点"
    ]
  },
  {
    id: "claude.mid-run-approval-in-noninteractive",
    claim:
      "claude -p 非交互执行会在中途请求审批并暂停等待产品决策。",
    title: "claude 非交互模式存在中途审批暂停",
    rationale:
      "全部真实 -p 调用（错误/重试/resume/模型/权限探针共 8+2 次）从未出现 control_request(can_use_tool) 或任何审批请求事件；非交互模式没有可假设的中途暂停通道。依赖中途暂停的设计会在真实运行中直接越过未授权动作。",
    requiredControl: "node-checkpoint",
    evidence: [
      "M03 s3#3 + s7 A19: control_request 从未出现",
      "M03 补采附录 (M0-06): 2026-09-22 两次补采同样无任何审批事件",
      "docs/CLI_ADAPTERS.md: 不能从日志里看见危险命令就声称已阻止其执行"
    ]
  },
  {
    id: "implicit-loading.unmanaged-clean-baseline",
    claim:
      "裸 -p / exec 是干净的：CLI 不会加载宿主级 MCP/agents/skills/plugins/hooks，无需显式管理。",
    title: "未受控的 CLI 隐式配置加载",
    rationale:
      "claude init 事件实测隐式加载 9 个用户级 MCP server、13 个 agents、133 个 skills、4 个 plugins、SessionStart hooks 与 171 个 slash commands（hook 事件真实出现在协议流里）；codex exec 流内 item error 直接提示 skills/plugins 已隐式加载，且 MCP 清单在流中不可见——流里没有不等于没有加载。未经清单+hash+显式信任管理的隐式加载不得进入有执行权限的运行。",
    requiredControl: "explicit-management",
    evidence: [
      "M03 s6: 隐式加载清单与 hook 事件观察",
      "FIX/claude/manifest.json inventorySizes: tools 33/44, mcp_servers 9, slash_commands 171, skills 133, agents 13, plugins 4",
      "M04 s6: skills/plugins 隐式加载流内直接证据；MCP 清单不可见",
      "docs/CLI_ADAPTERS.md 隐式行为控制; docs/SECURITY_MODEL.md 开源供应链"
    ]
  },
  {
    id: "success.exit0-or-subtype-as-business-success",
    claim:
      "exit 0（或 result subtype 为 success）足以判定业务成功。",
    title: "以退出码/子类型代替业务成功判定",
    rationale:
      "codex 真实成功流 turn.completed 只带 usage、无业务负载（平凡成功 fail-closed 为 business-schema-invalid，CLI exit 0 不等于业务成功）；claude 真实 API 失败流给出 subtype:\"success\" + is_error:true + exit 1。成功判定必须使用完整条件：exitCode=0、最终结果无 error（以 is_error/terminal_reason 为准）、业务 schema 有效、要求的证据存在。",
    requiredControl: "full-success-conditions",
    evidence: [
      "M04 s5#1 + FIX/codex/codex-trivial-success.real.jsonl: exit 0 仍 business-schema-invalid",
      "M03 s5#1 + FIX/claude/claude-api-error-429.real.jsonl: subtype success 仍判失败",
      "docs/CLI_ADAPTERS.md 事件规范: 成功条件至少为四要件"
    ]
  },
  {
    id: "process.pid-only-identity",
    claim:
      "以 PID 存活检查或单杀顶层 PID 足以识别并终止 CLI 进程树。",
    title: "仅凭 PID 的进程身份判定与部分终止",
    rationale:
      "Windows 实测 PID 秒级复用（3000 个短命进程仅 2099 个不同 PID，901 次复用）；杀 .cmd/npm shim（不带 /T）会把整条 CLI 子树变成实测存活的孤儿。身份判定必须用 (pid, name, parentPid, creationTime) 三元组，终止必须 taskkill /T /F（或平台等价树终止），并保存终止前身份快照供 reconcile 核对。",
    requiredControl: "identity-and-tree-kill",
    evidence: [
      "M05 s4 场景1/场景4 + s5 结论1/结论3",
      "M05 s6: pid-reuse 与 cmd-wrapper 测试（packages/process-lab）"
    ]
  },
  {
    id: "platform.cross-namespace-pid",
    claim:
      "Windows 侧可以直接解释或操作 WSL 内的 PID（或反向混用两侧进程语义）。",
    title: "跨命名空间混用 PID",
    rationale:
      "实测 Windows 侧对 Linux PID 的存活检查结果无意义（恒 false）；两侧 PID 命名空间互不可见。Windows 级联死亡与 POSIX/WSL 孤儿语义相反，取消/恢复语义必须按 execution target 分别定义，混用属于 A29 方向的前置错误。",
    requiredControl: "per-target-semantics",
    evidence: [
      "M05 s4 场景5 + s5 结论4: Windows isAlive(linuxPid)=false；WSL 内 setsid/负 PGID 语义",
      "docs/ACCEPTANCE.md A29: 不隐式转换执行"
    ]
  },
  {
    id: "claim.unverified-capability-as-supported",
    claim:
      "无 verified 证据的能力可以按支持启用（unknown 视作允许）。",
    title: "把未经验证的能力标记为支持",
    rationale:
      "治理规则明确 Unknown 能力不视作允许；M0 三份报告中所有未证实能力均记 unverified 而非支持。statusOf 对未知能力 id 一律返回 unverified（denied by default），isUsable 仅对 verified 为真——消费方不得绕过该判定把 unknown/unverified 当作可用。",
    requiredControl: "unknown-deny",
    evidence: [
      "docs/SECURITY_MODEL.md 授权规则: Unknown 能力不视作允许",
      "docs/ACCEPTANCE.md A32/A33 + 发布阻断级别",
      "docs/BACKLOG.md M0-06 完成标准: 能力未知不标记支持",
      "M06 gate: reports/M0-06-capability-matrix.md 状态图例"
    ]
  }
] as const;

/* ------------------------------------------------------------------ */
/* Capability matrix cells (CLI x dimension)                           */
/* ------------------------------------------------------------------ */

const RAW_CAPABILITY_RECORDS = [
  // ---- claude 2.1.278 ----
  {
    capability: "claude.noninteractive-entry",
    cli: "claude",
    status: "verified",
    summary:
      "-p 非交互入口可用：8 次真实调用全部产出完整事件流并保留退出码语义。",
    evidence: ["M03 s4 调用#2-#8", "FIX/claude/manifest.json fixtures[0..4]"]
  },
  {
    capability: "claude.stream-parsing.error-path",
    cli: "claude",
    status: "verified",
    summary:
      "错误/重试/4xx 路径的 stream-json 流（17/15/8 行）全部可解析；api_retry 映射为 diagnostic，不视为进展。",
    evidence: [
      "FIX/claude/claude-api-error-429.real.jsonl",
      "FIX/claude/claude-invalid-model-400.real.jsonl",
      "packages/cli-events/test/real-fixtures.test.ts（含随机分片重放）"
    ]
  },
  {
    capability: "claude.stream-parsing.success-path",
    cli: "claude",
    status: "unverified",
    summary:
      "成功推理路径流形态从未采集：2026-09-21 三次 429；2026-09-22 补采 2 次仍失败（429/502）。解析映射仅有 synthetic 近似 + 错误流侧证。",
    evidence: ["M03 s3#2b + s9#1", "APPENDIX (M0-06)"]
  },
  {
    capability: "claude.success-verdict.failure-detection",
    cli: "claude",
    status: "verified",
    summary:
      "失败判定以 is_error 为准：真实 API 失败流 result subtype 为 success 但 is_error:true、terminal_reason:api_error、exit 1；normalizer 与 contract 测试已钉住该陷阱。",
    evidence: [
      "M03 s5#1",
      "FIX/claude/claude-api-error-429.real.jsonl finalResult",
      "packages/cli-events/src/normalizer.ts claudeResult"
    ]
  },
  {
    capability: "claude.success-verdict.business-success",
    cli: "claude",
    status: "unverified",
    summary:
      "业务成功判定规范缺真实成功样本：平凡真实运行的 result 行无 structured_output（错误流旁证），成功流结构化输出条件未知；按 fail-closed 设计。",
    evidence: ["M03 s5#4", "M03 s9#1", "M06 gate: PROPOSALS.md 结构化输出契约提案"]
  },
  {
    capability: "claude.permission-approval-behavior",
    cli: "claude",
    status: "unverified",
    summary:
      "init 记录 permissionMode:default（verified）；control_request 审批事件在全部真实调用中从未出现（按无通道设计）；默认权限下的实际拒绝形态未观察（探针未达工具阶段即 429）。",
    evidence: ["M03 s3#3 + s7 A19", "FIX/claude/claude-permission-probe-429.real.jsonl behaviorNote"]
  },
  {
    capability: "claude.resume.parameter-and-session",
    cli: "claude",
    status: "verified",
    summary:
      "--resume <session-id> 被接受且新 init 的 session_id 与被恢复 session 一致（运行期比对 True）。",
    evidence: ["M03 s3#4a", "FIX/claude/claude-resume-session-429.real.jsonl"]
  },
  {
    capability: "claude.resume.continuity",
    cli: "claude",
    status: "unverified",
    summary: "resume 后的对话延续被 429 阻断，无法观察。",
    evidence: ["M03 s3#4b"]
  },
  {
    capability: "claude.model-settings.acceptance",
    cli: "claude",
    status: "verified",
    summary:
      "模型名不做参数层校验：无效名 stderr unrecognized_model 警告 + init.model 透传 + 网关 400（无重试）；有效名无警告且 init.model 原样回显。",
    evidence: [
      "M03 s3#5a/#5b",
      "FIX/claude/claude-invalid-model-400.real.jsonl",
      "FIX/claude/claude-valid-model-echo-429.real.jsonl"
    ]
  },
  {
    capability: "claude.model-settings.inference",
    cli: "claude",
    status: "unverified",
    summary: "指定有效模型后的推理被 429 阻断，未观察。",
    evidence: ["M03 s4 调用#7"]
  },
  {
    capability: "claude.structured-business-output",
    cli: "claude",
    status: "unverified",
    summary:
      "structured_output 从未在真实流中出现；其出现条件未知，不得标支持。产品业务成功需要显式结构化输出契约。",
    evidence: ["M03 s5#4"]
  },
  {
    capability: "claude.process-tree-control",
    cli: "claude",
    status: "verified",
    summary:
      "Windows 进程树终止机制 verified（CLI 无关）：taskkill /T /F 全灭实测；杀 shim 一级不级联留孤儿；Node v25 父死级联（detached 豁免）；以 fake-claude + 真实 OS 命令证明，真实 claude 进程树未单独测量。",
    evidence: ["M05 s4 场景1/场景3 + s5 结论1/结论2/结论8"]
  },
  {
    capability: "claude.credential-isolation",
    cli: "claude",
    status: "unverified",
    summary:
      "仅能从 init apiKeySource:none 间接观察认证形态；按约束未探测凭据配置，A33 认证锁并发设计维持不标 verified。",
    evidence: ["M03 s7 A33", "docs/ACCEPTANCE.md A33"]
  },
  {
    capability: "claude.implicit-loading.observation",
    cli: "claude",
    status: "verified",
    summary:
      "隐式加载存在性 verified：init 隐式加载 9 MCP/13 agents/133 skills/4 plugins/SessionStart hooks/171 slash commands，hook 事件真实出现在协议流（两次调用 hook 数量可变）。",
    evidence: ["M03 s6", "FIX/claude/manifest.json inventorySizes"]
  },
  {
    capability: "claude.implicit-loading.explicit-control",
    cli: "claude",
    status: "unverified",
    summary:
      "显式禁用/管理这些隐式加载的参数与机制未测试（受真实调用约束未探索）；在证实可禁用前不得假设裸 -p 干净。",
    evidence: ["M03 s6 结论", "docs/CLI_ADAPTERS.md 隐式行为控制"]
  },
  {
    capability: "claude.unattended-write-mode",
    cli: "claude",
    status: "blocked",
    summary:
      "无人值守写入模式必须保持禁用：非交互无审批通道（真实调用零审批事件）+ 默认权限拒绝行为 unverified，二者叠加使无人值守写无法满足授权交集。",
    evidence: ["M03 s7 A19", "gate: claude.mid-run-approval-in-noninteractive", "docs/SECURITY_MODEL.md 授权规则"]
  },
  {
    capability: "claude.platform-difference.win32-native",
    cli: "claude",
    status: "verified",
    summary: "win32 10.0.26100 x64 原生实测（8+2 次真实调用，Git Bash/cmd 宿主）。",
    evidence: ["M03 s1", "M06 gate: reports/M0-06-platform-baseline.md win32 节"]
  },
  {
    capability: "claude.platform-difference.other-platforms",
    cli: "claude",
    status: "unverified",
    summary:
      "macOS/Linux-native/WSL1 无任何实测；WSL2/Ubuntu 仅进程语义实测、CLI 行为未实测。全部标 unverified。",
    evidence: ["M05 s7 未验证项#1", "M06 gate: reports/M0-06-platform-baseline.md"]
  },

  // ---- codex 0.154.0 ----
  {
    capability: "codex.noninteractive-entry",
    cli: "codex",
    status: "verified",
    summary:
      "codex exec --json 非交互入口可用（9 次真实调用）；环境门：非 git 目录默认拒绝（exit 1）。",
    evidence: ["M04 s3#1/#2 + s4", "FIX/codex/manifest.json environmentGate"]
  },
  {
    capability: "codex.stream-parsing",
    cli: "codex",
    status: "verified",
    summary:
      "成功与失败真实流全部可解析；item error 映射为新增 error 事件；turn.started 可滞后于首个 item——顺序不可假设已钉进测试。",
    evidence: [
      "M04 s5#2/#3",
      "FIX/codex/ 全部 5 个 fixture",
      "packages/cli-events/test/real-codex-fixtures.test.ts"
    ]
  },
  {
    capability: "codex.success-verdict.cli-level",
    cli: "codex",
    status: "verified",
    summary:
      "CLI 层成功/失败判定 verified：turn.completed（带 usage）/turn.failed/isError 真实形态已采集并钉住。",
    evidence: [
      "FIX/codex/codex-trivial-success.real.jsonl",
      "FIX/codex/codex-invalid-model-turn-failed.real.jsonl"
    ]
  },
  {
    capability: "codex.permission-default-writes-executed",
    cli: "codex",
    status: "verified",
    summary:
      "默认模式权限行为 verified：工作区写入被直接执行（盘上验证），无任何审批事件；CLI 不替产品挡写入。",
    evidence: ["M04 s3#3", "FIX/codex/codex-permission-probe-write-executed.real.jsonl"]
  },
  {
    capability: "codex.approval-sandbox-rejection-path",
    cli: "codex",
    status: "unverified",
    summary:
      "approval.requested/approval.denied 与沙箱拦截的真实形态未观察（默认模式未出现拒绝；探索需产品层显式授权）。",
    evidence: ["M04 s9#2"]
  },
  {
    capability: "codex.resume",
    cli: "codex",
    status: "verified",
    summary:
      "codex exec resume <id> --json - 复用同一 thread_id（脱敏占位符保留同一性证据）；会话延续有 input_tokens 近翻倍的客观计量证据。",
    evidence: ["M04 s3#4 + s5#8", "FIX/codex/codex-resume-session.real.jsonl"]
  },
  {
    capability: "codex.model-settings",
    cli: "codex",
    status: "verified",
    summary:
      "模型设置 verified：参数层不拒绝任意名；账号层门控——gpt-6-astra 正常成功，无效名与目录内未授权名同形 turn.failed；模型接受度按账号而非二进制目录。",
    evidence: ["M04 s3#5a/#5b", "FIX/codex/codex-invalid-model-turn-failed.real.jsonl", "FIX/codex/codex-valid-model-success.real.jsonl"]
  },
  {
    capability: "codex.structured-business-output",
    cli: "codex",
    status: "unverified",
    summary:
      "turn.completed 只带 usage、无业务负载（真实成功流 verified）；--output-schema 能否产出有效业务负载未验证。平凡真实成功 fail-closed business-schema-invalid。",
    evidence: ["M04 s5#1 + s9#3", "FIX/codex/codex-trivial-success.real.jsonl behaviorNote"]
  },
  {
    capability: "codex.process-tree-control",
    cli: "codex",
    status: "verified",
    summary:
      "进程树终止机制 verified（CLI 无关，同 claude 行）：taskkill /T /F、身份三元组、Node v25 级联均以 fake-cli + 真实 OS 命令证明；两方言 runner 共享同一 spawn/frame 引擎。",
    evidence: ["M05 s4 + s7 未验证项#4"]
  },
  {
    capability: "codex.credential-isolation",
    cli: "codex",
    status: "unverified",
    summary:
      "仅后端错误文本旁证 ChatGPT account 类型；按约束未探测凭据配置，不标 verified。",
    evidence: ["M04 s7 A33", "docs/ACCEPTANCE.md A33"]
  },
  {
    capability: "codex.implicit-loading.skills-plugins",
    cli: "codex",
    status: "verified",
    summary:
      "skills/plugins 隐式加载存在性 verified：无效模型调用的 item error 明确提示 skills 上下文预算与禁用指引——非交互 exec 默认加载用户级 skills/plugins。",
    evidence: ["M04 s6", "FIX/codex/codex-invalid-model-turn-failed.real.jsonl"]
  },
  {
    capability: "codex.implicit-loading.mcp",
    cli: "codex",
    status: "unverified",
    summary:
      "exec JSONL 流不携带 MCP 清单/连接状态——流不可见不等于未加载；MCP 是否加载 unknown，按 unknown-deny 处理。",
    evidence: ["M04 s6 + s7 A35"]
  },
  {
    capability: "codex.unattended-write-mode",
    cli: "codex",
    status: "blocked",
    summary:
      "无人值守写入模式必须保持禁用，直到强制节点检查点：默认模式写入直接落盘且无审批通道（verified）。",
    evidence: ["M04 s7 A19", "gate: codex.default-mode-unattended-write", "docs/CLI_ADAPTERS.md 审批能力不可假定一致"]
  },
  {
    capability: "codex.platform-difference.win32-native",
    cli: "codex",
    status: "verified",
    summary:
      "win32 10.0.26100 x64 原生实测：npm 包平台二进制 codex.exe 经 mise shim 进入 PATH（9 次调用）。",
    evidence: ["M04 s1", "M06 gate: reports/M0-06-platform-baseline.md win32 节"]
  },
  {
    capability: "codex.platform-difference.other-platforms",
    cli: "codex",
    status: "unverified",
    summary:
      "macOS/Linux-native/WSL1 无任何实测；WSL2/Ubuntu 仅进程语义实测、CLI 行为未实测。全部标 unverified。",
    evidence: ["M05 s7 未验证项#1", "M06 gate: reports/M0-06-platform-baseline.md"]
  }
] as const;

/* ------------------------------------------------------------------ */
/* Parse at module load: malformed registry data fails fast.           */
/* ------------------------------------------------------------------ */

function parseUnique<T, E>(
  schema: { parse: (value: unknown) => T },
  raw: readonly E[],
  idOf: (entry: E) => string
): T[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = idOf(entry);
    if (seen.has(id)) {
      throw new Error(`capability-gate registry: duplicate id ${id}`);
    }
    seen.add(id);
  }
  return raw.map((entry) => schema.parse(entry));
}

export const BLOCKED_ARGV_PATTERNS: readonly BlockedArgvPattern[] = parseUnique(
  BlockedArgvPatternSchema,
  RAW_BLOCKED_ARGV_PATTERNS,
  (entry) => entry.id
);

export const BLOCKED_ASSUMPTIONS: readonly BlockedAssumption[] = parseUnique(
  BlockedAssumptionSchema,
  RAW_BLOCKED_ASSUMPTIONS,
  (entry) => entry.id
);

export const CAPABILITY_RECORDS: readonly CapabilityStatusRecord[] = parseUnique(
  CapabilityStatusRecordSchema,
  RAW_CAPABILITY_RECORDS,
  (entry) => entry.capability
);
