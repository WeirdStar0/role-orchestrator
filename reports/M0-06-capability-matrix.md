# M0-06 · 能力矩阵（capability gate 数据面）

状态：已完成。角色：Architect（汇总）。日期：2026-09-22。
对应任务：`docs/BACKLOG.md` M0-06（验收 A31/A32/A33 方向）；完成标准「能力未知不标记支持；不支持的危险模式被阻止」。

本报告只做一件事：把 M0-03/M0-04/M0-05 三份已验收报告与脱敏真实 fixture 中**已证实**的事实，汇总为逐格带状态的能力矩阵与可查询注册表。所有结论以真实命令退出码与盘上证据为准；没有任何格子因「应该可以」而标 verified。

## 0. 实测环境（所有 verified 证据的边界）

| 项 | 值 |
|---|---|
| OS | Windows 10.0.26100 x64（win32-native，优先目标；系统 locale zh-CN，控制台代码页 936/GBK） |
| Node / pnpm | v25.0.0 / 10.14.0 |
| shell 层 | Git Bash 宿主 cmd.exe |
| WSL | WSL2 / Ubuntu（仅进程语义实测）；WSL1 本机配置不支持；macOS / Linux-native 无本机 |
| claude | 2.1.278（真实调用 8 次 @2026-09-21 + 补采 2 次 @2026-09-22，见 M0-03 报告及补采附录） |
| codex-cli | 0.154.0（真实调用 9 次 @2026-09-21） |
| 证据目录 | `packages/cli-events/fixtures-real/`（claude 5 + codex 5，脱敏真实流，`synthetic:false`） |

**状态图例**：verified（真实命令/fixture 已证实）｜unsupported（已证实不存在——本期没有格子获得它，原因见 §3）｜unverified（无证据或证据只覆盖部分，按 unknown-deny 处理）｜blocked（该用法本身危险，禁止启用）。四态中只有 verified 可用（`isUsable`）。

## 1. claude 2.1.278 能力矩阵

| 能力维度 | capability id | 状态 | 证据引用 | 备注 |
|---|---|---|---|---|
| 非交互入口 | `claude.noninteractive-entry` | **verified** | `reports/M0-03-claude-capability.md` §4 调用#2–#8；`packages/cli-events/fixtures-real/claude/manifest.json` | `-p` 全部调用产出完整事件流 |
| 流协议与解析（错误/重试/4xx 路径） | `claude.stream-parsing.error-path` | **verified** | fixture `claude-api-error-429.real.jsonl`、`claude-invalid-model-400.real.jsonl`；`packages/cli-events/test/real-fixtures.test.ts`（含随机分片重放） | `api_retry` 映射 diagnostic，不视为进展 |
| 流协议与解析（成功推理路径） | `claude.stream-parsing.success-path` | **unverified** | M0-03 §3#2b、§9#1；补采附录（2026-09-22 两次补采均失败：429/502） | 成功流形态从未采集；解析映射仅 synthetic 近似 + 错误流侧证 |
| 成功判定（失败判定） | `claude.success-verdict.failure-detection` | **verified** | M0-03 §5#1；fixture `claude-api-error-429.real.jsonl` finalResult；`packages/cli-events/src/normalizer.ts` claudeResult | 真实陷阱：`subtype:"success"` + `is_error:true` + exit 1；判定必须以 `is_error`/`terminal_reason` 为准，contract 测试已钉住 |
| 成功判定（业务成功判定） | `claude.success-verdict.business-success` | **unverified** | M0-03 §5#4、§9#1 | 真实 result 行无 `structured_output`（错误流旁证）；成功流业务判定条件未知，按 fail-closed 设计 |
| 权限/审批行为 | `claude.permission-approval-behavior` | **unverified** | M0-03 §3#3、§7（A19）；fixture `claude-permission-probe-429.real.jsonl` behaviorNote | init `permissionMode:"default"`（verified）；`control_request` 审批事件在全部真实调用中**从未出现**（按无通道设计）；默认权限下实际拒绝形态未观察（探针未达工具阶段即 429） |
| 权限/审批行为（无人值守写模式） | `claude.unattended-write-mode` | **blocked** | M0-03 §7 A19；gate 条目 `claude.mid-run-approval-in-noninteractive`；`docs/SECURITY_MODEL.md` 授权规则 | 无审批通道 + 默认拒绝行为 unverified 叠加 → 无人值守写不可启用；必须节点检查点 |
| resume | `claude.resume.parameter-and-session` | **verified** | M0-03 §3#4a；fixture `claude-resume-session-429.real.jsonl` | `--resume <session-id>` 接受；init `session_id` 与被恢复 session 一致（运行期比对 True） |
| resume（语义连续性） | `claude.resume.continuity` | **unverified** | M0-03 §3#4b | 对话延续被 429 阻断 |
| 模型设置（参数接受度） | `claude.model-settings.acceptance` | **verified** | M0-03 §3#5a/#5b；fixture `claude-invalid-model-400.real.jsonl`、`claude-valid-model-echo-429.real.jsonl` | 无效名：stderr `unrecognized_model` + 400 无重试；有效名：无警告 + `init.model` 回显；参数层不校验 |
| 模型设置（指定模型推理） | `claude.model-settings.inference` | **unverified** | M0-03 §4 调用#7 | 推理被 429 阻断 |
| 结构化业务输出 | `claude.structured-business-output` | **unverified** | M0-03 §5#4 | `structured_output` 从未在真实流出现，出现条件未知 → 不得标支持 |
| 子进程/进程树控制 | `claude.process-tree-control` | **verified** | `reports/M0-05-windows-launcher.md` §4 场景1/场景3、§5 结论1/2/8 | 机制 CLI 无关：`taskkill /T /F` 全灭、杀 shim 一级留孤儿、Node v25 父死级联（detached 豁免）；以 fake-claude + 真实 OS 命令证明，真实 claude 进程树未单独测量 |
| 凭据隔离 | `claude.credential-isolation` | **unverified** | M0-03 §7（A33）；`docs/ACCEPTANCE.md` A33 | 仅 `apiKeySource:"none"` 间接观察；按约束未探测凭据配置；认证锁并发设计维持不标 verified |
| 外部配置/hooks/MCP/子Agent 隐式加载（存在性观测） | `claude.implicit-loading.observation` | **verified** | M0-03 §6；`packages/cli-events/fixtures-real/claude/manifest.json` inventorySizes | init 实测隐式加载 9 MCP / 13 agents / 133 skills / 4 plugins / SessionStart hooks / 171 slash commands；hook 事件真实出现在协议流 |
| 外部配置/hooks/MCP/子Agent 隐式加载（显式管理能力） | `claude.implicit-loading.explicit-control` | **unverified** | M0-03 §6 结论；`docs/CLI_ADAPTERS.md` 隐式行为控制 | 显式禁用/管理参数未测试；证实可禁用前不得假设裸 `-p` 干净 |
| 平台差异（win32-native） | `claude.platform-difference.win32-native` | **verified** | M0-03 §1；`reports/M0-06-platform-baseline.md` | 本平台原生实测 |
| 平台差异（其余平台） | `claude.platform-difference.other-platforms` | **unverified** | M0-05 §7 未验证项#1；`reports/M0-06-platform-baseline.md` | macOS / Linux-native / WSL1 无任何实测；WSL2 内 CLI 行为未实测 |

## 2. codex-cli 0.154.0 能力矩阵

| 能力维度 | capability id | 状态 | 证据引用 | 备注 |
|---|---|---|---|---|
| 非交互入口 | `codex.noninteractive-entry` | **verified** | `reports/M0-04-codex-capability.md` §3#1/#2、§4；`packages/cli-events/fixtures-real/codex/manifest.json` environmentGate | 9 次真实调用；环境门：非 git 目录默认拒绝（exit 1，683ms 实测） |
| 流协议与解析 | `codex.stream-parsing` | **verified** | M0-04 §5#2/#3；`packages/cli-events/fixtures-real/codex/` 全部 5 个 fixture；`packages/cli-events/test/real-codex-fixtures.test.ts` | 成功 + 失败真实流全可解析；`turn.started` 可滞后于首个 item（顺序不可假设，已钉住）；item error 映射为 error 事件 |
| 成功判定（CLI 层） | `codex.success-verdict.cli-level` | **verified** | fixture `codex-trivial-success.real.jsonl`、`codex-invalid-model-turn-failed.real.jsonl` | `turn.completed`（带 usage）/ `turn.failed` / `isError` 真实形态 |
| 权限/审批行为（默认模式） | `codex.permission-default-writes-executed` | **verified** | M0-04 §3#3；fixture `codex-permission-probe-write-executed.real.jsonl` | 要求创建的文件**被真实创建**（盘上验证），全程无 `approval.requested`/`approval.denied`——CLI 不替产品挡写入 |
| 权限/审批行为（审批/沙箱拒绝路径） | `codex.approval-sandbox-rejection-path` | **unverified** | M0-04 §9#2 | 默认模式未出现拒绝；探索需产品层显式授权，本次未做 |
| 权限/审批行为（无人值守写模式） | `codex.unattended-write-mode` | **blocked** | M0-04 §7（A19）；gate 条目 `codex.default-mode-unattended-write`；`docs/CLI_ADAPTERS.md` 审批能力不可假定一致 | 默认模式写入直接落盘（verified）→ 无人值守写必须强制节点检查点 |
| resume | `codex.resume` | **verified** | M0-04 §3#4、§5#8；fixture `codex-resume-session.real.jsonl` | 同一 `thread_id`（脱敏占位符保留同一性证据）；input_tokens 49807 ≈ 基线 24895 两倍（历史重放的计量证据） |
| 模型设置 | `codex.model-settings` | **verified** | M0-04 §3#5a/#5b；fixture `codex-invalid-model-turn-failed.real.jsonl`、`codex-valid-model-success.real.jsonl` | 参数层不拒绝任意名；账号层门控（gpt-6-astra 成功；目录内未授权名与无效名同形 turn.failed） |
| 结构化业务输出 | `codex.structured-business-output` | **unverified** | M0-04 §5#1、§9#3；fixture `codex-trivial-success.real.jsonl` behaviorNote | `turn.completed` 只带 usage、无业务负载（verified）→ 平凡真实成功 fail-closed `business-schema-invalid`；`--output-schema` 未验证 |
| 子进程/进程树控制 | `codex.process-tree-control` | **verified** | M0-05 §4、§7 未验证项#4 | 机制 CLI 无关（两方言 runner 共享同一 spawn/frame 引擎）；真实 codex 进程树未单独测量 |
| 凭据隔离 | `codex.credential-isolation` | **unverified** | M0-04 §7（A33）；`docs/ACCEPTANCE.md` A33 | 仅后端错误文本旁证 ChatGPT account；未探测凭据配置 |
| 外部配置/hooks/MCP/子Agent 隐式加载（skills/plugins） | `codex.implicit-loading.skills-plugins` | **verified** | M0-04 §6；fixture `codex-invalid-model-turn-failed.real.jsonl` | item error 明确提示 skills 上下文预算与禁用指引——非交互 exec 默认加载用户级 skills/plugins |
| 外部配置/hooks/MCP/子Agent 隐式加载（MCP） | `codex.implicit-loading.mcp` | **unverified** | M0-04 §6、§7（A35） | exec 流不携带 MCP 清单——**流不可见 ≠ 未加载**；按 unknown-deny 处理 |
| 平台差异（win32-native） | `codex.platform-difference.win32-native` | **verified** | M0-04 §1；`reports/M0-06-platform-baseline.md` | npm 包平台二进制 codex.exe 经 shim 进入 PATH，原生实测 |
| 平台差异（其余平台） | `codex.platform-difference.other-platforms` | **unverified** | M0-05 §7 未验证项#1；`reports/M0-06-platform-baseline.md` | 同 claude：未实测平台全部 unverified |

## 3. 为什么本期没有 unsupported 格子

`unsupported`（已证实不存在）要求证明能力在目标版本中不存在，而 M0 的真实调用窗口是有界的：claude 的 10 次调用（8+2）全部处于网关错误窗口或平凡提示词下，codex 的 9 次调用未触发审批/沙箱路径。「8 次调用里没出现 control_request」证明的是**按无通道设计**（对应 blocked 假设），不足以证明「该能力在 2.1.278 中不存在」。因此两个 CLI 的交互审批通道、claude 默认权限拒绝形态、codex 审批拒绝形态、结构化输出等一律记 unverified——宁可保守，不把有界缺失当反证。

## 4. 危险模式阻止清单（capability-gate 注册表）

机器可读实现：`packages/capability-gate`（Zod schema + 模块加载时校验 + 15 条测试覆盖每个条目）。这是 M1 消费的起点数据，**不含运行时拦截器**。

**argv 形危险模式（2 条，`isBlocked(argvText)` / `blockedPatternFor`）**

| id | 模式 | requiredControl | 证据 |
|---|---|---|---|
| `argv.permission-skip-flags` | `--dangerously-[a-z0-9-]+` 命名族（含 claude `--dangerously-skip-permissions`、codex `--dangerously-bypass-approvals-and-sandbox`）+ codex `danger-full-access` 沙箱关闭模式 | forbidden | `docs/CLI_ADAPTERS.md`（默认不启用自动跳过权限的参数）；M0-03 §2 / M0-04 §2（实测全程未使用） |
| `argv.environment-gate-bypass` | `--skip-git-repo-check` | explicit-authorization | M0-04 §2 环境门发现 + codex manifest environmentGate（默认拒绝 exit 1 实测） |

**被阻止的实现假设（7 条，`checkAssumption(id)`；未知 id 一律 blocked + unknown-deny）**

| id | 被阻止的声明 | requiredControl |
|---|---|---|
| `codex.default-mode-unattended-write` | codex exec 默认模式可无人值守直接写工作区、无需产品侧检查点 | node-checkpoint |
| `claude.mid-run-approval-in-noninteractive` | claude `-p` 会中途请求审批并暂停等待 | node-checkpoint |
| `implicit-loading.unmanaged-clean-baseline` | 裸 `-p`/exec 不加载宿主级 MCP/agents/skills/plugins/hooks，无需显式管理 | explicit-management |
| `success.exit0-or-subtype-as-business-success` | exit 0（或 result subtype success）足以判定业务成功 | full-success-conditions |
| `process.pid-only-identity` | 以 PID 存活/单杀顶层足以识别并终止进程树 | identity-and-tree-kill |
| `platform.cross-namespace-pid` | Windows 侧可直接解释/操作 WSL 内 PID（或反向） | per-target-semantics |
| `claim.unverified-capability-as-supported` | 无 verified 证据的能力按支持启用（unknown 视作允许） | unknown-deny |

**查询语义（fail-closed）**：`statusOf(未知能力)` 返回 `unverified`（`known:false`）；`checkAssumption(未知id)` 返回 blocked（`requiredControl:"unknown-deny"`）；`isUsable(status)` 仅对 `verified` 为真。三处共同实现「能力未知不标记支持 / Unknown 能力不视作允许」（`docs/SECURITY_MODEL.md`）。

## 5. A31 / A32 / A33 在矩阵中的落点

- **A31**（测试脚本读取宿主 secret 须在 Hardened 模式被阻止）：当前无任何 CLI 沙箱能力被证实（`codex.approval-sandbox-rejection-path` unverified、claude 权限拒绝行为 unverified）→ 按 `docs/SECURITY_MODEL.md`，**Hardened 模式不可选择/不宣称**；本矩阵不授予任何 Hardened 声明，等价于 A31 的 M0 侧保守闭合。
- **A32**（CLI 不能证明强沙箱 → UI 标记 Local Trusted 或拒绝）：两 CLI 的沙箱证据面均为 unverified → 产品模式只能标记 Local Trusted；对应 blocked/unverified 格子（`claude.unattended-write-mode`、`codex.unattended-write-mode`、两个权限维度）即 UI 门的数据来源。
- **A33**（Profile 目录分开但凭据共享 → 不标记 verified，认证锁限制并发）：两个 `credential-isolation` 格子均为 unverified（仅旁证）；与 `packages/contracts` 的 `unverifiedCredentialGroupMax: z.literal(1)`（并发 1）一致，维持不标 verified。

## 6. unverified 汇总（M1 前需补证的清单）

1. claude 成功推理路径流形态与业务成功判定（补采 2 次仍失败——429/502 网关窗口持续）。
2. claude 默认权限下的实际拒绝形态；codex 审批/沙箱拒绝路径真实形态。
3. claude `structured_output` 出现条件；codex `--output-schema` 实际效果。
4. claude resume 语义连续性、指定模型推理。
5. 两 CLI 凭据隔离（A33，须维持认证锁并发=1 直到证实）。
6. codex MCP 隐式加载是否发生（流不可见 ≠ 未加载）。
7. 隐式加载的显式禁用/管理机制（两 CLI 均未测试）。
8. 全部未实测平台（macOS / Linux-native / WSL1 / WSL2 内 CLI 行为）——详见 `reports/M0-06-platform-baseline.md`。

## 7. 交付物与测试

| 交付物 | 说明 |
|---|---|
| `reports/M0-06-capability-matrix.md` | 本文件（33 格状态 + 逐格证据） |
| `packages/capability-gate` | 注册表数据（2 argv 模式 + 7 blocked 假设 + 33 能力格）+ Zod schema + 查询函数 `isBlocked`/`blockedPatternFor`/`checkAssumption`/`statusOf`/`isUsable` + 15 条测试（覆盖每个条目与 fail-closed 语义） |
| `reports/M0-06-platform-baseline.md` | 平台兼容基线（本矩阵平台维度的展开） |
| `reports/M0-03-claude-capability.md` 补采附录 | 2026-09-22 两次补采如实记录（均失败） |
| `PROPOSALS.md` 追加条目 | 结构化输出契约、节点检查点强制、is_error 判定修正、Node 25 fs 上游提案、冻结文档更新清单 |

冻结面核对：本任务未触碰 `AGENTS.md`、`docs/`、`schemas/`、`config/`、`prompts/`、`project/`、`contracts/`、`scripts/`、`.github/`、`CHECKSUMS.sha256` 及根目录既有 `.md`（`PROPOSALS.md` 为本方披露文件，仅追加）。最终门禁结果见 §8（`pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm run planning:check` 真实退出码，任务完成时回填）。

## 8. 验证管道实测结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 7 tasks（新增 capability-gate） |
| `pnpm test` | 0 | 223 passed / 0 failed（既有 208 全部保持 + capability-gate 15 新增） |
| `pnpm build` | 0 | 5 tasks（终跑 turbo cache hit；capability-gate 已在本任务内单独执行 `pnpm build` 实际编译并产出 dist，exit 0） |
| `pnpm run planning:check` | 0 | (a) CHECKSUMS 78 个冻结文件 sha256 全部一致；(b) 干净副本 self-test exit 0 |

（上表为本任务收尾时实际执行的命令与退出码回填。）
