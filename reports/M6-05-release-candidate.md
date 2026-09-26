# M6-05 · 维护者审核本地版候选（候选证据包）

状态：审核材料已备齐，**等待维护者人工审核与批准**（批准本身是本任务完成的必要条件，见 §7）。
角色：Coordinator（证据汇总）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M6-05（验收 A42；完成标准「维护者人工批准才交付/发布；不把提案当发布权限」）。
前置：M6-01（`reports/M6-01-platform-matrix.md`）、M6-02（`reports/M6-02-backup-migration-cleanup.md`）、M6-03（`reports/M6-03-release-security.md`）、M6-04（`reports/M6-04-dogfood.md`）均已完成。

**本文件性质：审核材料，不构成发布批准。** 全文只汇总已证实的事实与未证实项；
每一项结论注明证据来源（哪份报告 / 哪个测试 / 本会话哪条命令的退出码）。
维护者专属决定只出现在 §6 的「待维护者确认」清单中，无任何「已确认」状态。

## 0. 本次会话实测（全部结论的证据边界）

以下命令均为 M6-05 会话真实执行，退出码如实记录：

| 检查 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 环境 | `node -v` / `pnpm -v` / `git --version` / `python --version` | 0 | v25.0.0 / 10.14.0 / 2.54.0.windows.1 / 3.13.14 |
| git 纪律 | 确认仓库无 `.git` 目录 | — | 非 git 状态保持；本会话对本仓库零 git 操作 |
| 冻结脚本 | `sha256sum scripts/validate_bundle.py` | 0 | `f829d28605441cdb3dd80de7b4f7c99d60bc10e6b5070984dbc03980f2342a6c`（与冻结记录一致，未触碰） |
| 冻结面完整性 | `node planning-check.mjs` | 0 | 78/78 冻结文件 sha256 一致；干净副本 self-test exit 0（126 个本地链接核对通过） |
| 仓库内 self-test | `python scripts/validate_bundle.py --self-test` | **1** | 已知保留问题（`node_modules` 断链扫入），登记于 `PROPOSALS.md`，未修复、未掩盖、未绕过 |
| 类型检查 | `pnpm typecheck` | 0 | 53/53 任务成功 |
| 测试（原样命令） | `pnpm test` | 0 | 60/60 任务成功（58 个为 turbo 缓存回放，2 个真实执行） |
| 测试（全量真实执行） | `pnpm exec turbo run test --force` | 0 | 60/60 任务、0 缓存；**1312 测试全部通过、0 失败、0 跳过**（fault-matrix 自报 `15 passed, 0 failed, 0 skipped (platform gate)`） |
| 构建 | `pnpm build` | 0 | 30/30 任务成功 |
| 发布审计复跑 | `node packages/release-audit/dist/cli.js all .` | 0 | `blocking: []`；secrets verdict `known-reservations-only`（2134 文件、21 条命中、needs-judgment 0）；详见 §2.4 |

测试总量对账（每一环均有对应批次报告记录）：1232（M6-01 改动前基线，27 包）→ +5（M6-01 补测）→ +7+25（M6-02 store 校验 + maintenance 新包）→ +42（M6-03 release-audit 新包）→ +1（M6-04 dogfood 链路）= **1312**，与本会话强制全量跑逐包合计一致；既有 1232 条全部保持通过、零跳过、零断言弱化。

## 1. 里程碑门禁汇总（M0..M6）

门禁定义引自 `DEVELOPMENT_PLAN.md`「二、阶段计划」表与各阶段「门禁」行。

**如实声明（评估方法）**：`reports/` 目录只含 M0 批次（4 份）与 M6 批次（4 份）的批次报告；**M1–M5 各批次的最终轮审查结论没有以文件形式存放在本仓库**（本会话亦无法读取工作流运行日志），因此 M1–M5 的门禁状态按「门禁定义 + 在仓证据包（各包 README 的里程碑映射与测试）+ 本会话全量强制测试」评估，不引用不存在的审查结论。凡下表写「在仓证据」处，均为本会话强制跑中真实执行的测试。

| 里程碑 | 门禁（`DEVELOPMENT_PLAN.md`） | 状态评估 | 在仓证据（本会话强制跑实测计数） |
|---|---|---|---|
| M0 验证与骨架 | 有版本化能力报告；所有不支持能力能拒绝而非绕过 | **达成** | 批次报告：`reports/M0-03-claude-capability.md`、`reports/M0-04-codex-capability.md`、`reports/M0-05-windows-launcher.md`、`reports/M0-06-capability-matrix.md`、`reports/M0-06-platform-baseline.md`（真实调用 claude 8+2 次 / codex 9 次 + 脱敏 fixture）。capability-gate 18 测试：33 能力格四态语义、2 argv 危险模式、7 blocked 假设、unknown-deny、A31/A32 不宣称姿态全部钉住（`packages/capability-gate`） |
| M1 持久化纵向闭环 | 任务可启动/停止/中断恢复，无凭据入库，无静默改模型 | **达成（基于在仓证据包）** | store（M1-01）53、runtime-profile（M1-02）107、engine（M1-03）26、local-api（M1-04）192、reconcile（M1-05）25；A34 漂移检测与 A02 Profile 不可覆盖由 contracts 44 + dag 86 钉住 |
| M2 并行 DAG 与 Git | 两开发分支并行、正确合流、冲突可暂停；用户目录不被修改 | **达成（基于在仓证据包）** | dag 86、scheduler 45、worktree 20、integration 14、review 19；端到端基准 `packages/e2e-baseline`（M2-06）21 测试：并行分支→集成 candidateSha→A12 绑定审查，A11 用户仓库不变 |
| M3 上下文与记忆 | 角色能复用有来源的上下文，跨项目泄漏测试为 0 | **达成（基于在仓证据包）** | context 40、memory 47、memory-search 59；跨 CLI 协作 `packages/context-e2e`（M3-04）15 测试：A15 结构化产物交接 + A36 导出脱敏 |
| M4 受控自动化 | 返工上限生效，重复审批无效，不确定副作用不自动重跑 | **达成（基于在仓证据包）** | approval 90、checkpoint 29、expand 27（M4-03 三轮封顶）、budget 32、implicit-verify 29、reconcile 25；故障注入矩阵 `packages/fault-matrix`（M4-05）：**15 条注入用例全过、0 跳过（platform gate）**，vitest 计 17 测试 |
| M5 产品交互 | 所有编辑都经图/权限校验；运行中节点不能被原地篡改；过时 graphRevision 返回冲突 | **达成（基于在仓证据包）** | local-api 192（含 A38 乐观锁 409、A02 服务端拒绝 Profile 覆盖）；浏览器端到端 `packages/browser-e2e`（M5-05）7 文件 7 流程：顺序/并行/返工/审批/恢复 + A38/A39 回归，真实 Chromium 截图证据 |
| M6 本地稳定版 | 所有 release-blocking 项关闭；发布说明区分 implemented/experimental/unsupported/unverified；**人工批准发布，不由 Agent 单独发布** | **release-blocking 关闭（M6-03 门内）；人工批准未发生** | 批次报告：`reports/M6-01-platform-matrix.md`、`reports/M6-02-backup-migration-cleanup.md`、`reports/M6-03-release-security.md`（§6.1「release-blocking 空」）、`reports/M6-04-dogfood.md`。本会话复跑 release-audit：`blocking: []`。未验证平台/能力的标注见本文件 §3。**「人工批准」尚未发生——它是 M6-05 的完成条件，不是本文件能替代的**（§6 第 5 项、§7） |

各批次收尾门禁的真实退出码记录在各批次报告：M6-01 §5（1237 通过）、M6-02 §6（1269 通过，含 local-api 一次并行脆弱性如实记录）、M6-03 §8（1311 通过）、M6-04 §7（1312 通过）；本会话以 1312 复跑确认为当前终态。

## 2. 证据索引（全部验收证据的可查清单）

### 2.1 批次报告（`reports/`，9 份）

| 文件 | 内容 |
|---|---|
| `reports/M0-03-claude-capability.md` | claude 2.1.278 真实接入：8 次调用台账 + 2 次补采；`is_error` 陷阱、隐式加载观测；成功路径 unverified |
| `reports/M0-04-codex-capability.md` | codex-cli 0.154.0 真实接入：9 次调用台账；成功/失败/权限探针；默认模式写入直接执行（无审批通道） |
| `reports/M0-05-windows-launcher.md` | Windows 进程语义：树杀/级联/PID 复用/路径/WSL 五场景实测 |
| `reports/M0-06-capability-matrix.md` | 33 能力格四态矩阵 + 危险模式阻止清单（capability-gate 数据面） |
| `reports/M0-06-platform-baseline.md` | 平台兼容基线：win32-native 已实测；WSL2 仅进程语义；WSL1/macOS/Linux unverified |
| `reports/M6-01-platform-matrix.md` | 平台矩阵补测：长路径×中文×空格 shim 格闭合；>260 cwd spawn ENOENT 边界；A31 不宣称姿态；§3 不可本机验证项 |
| `reports/M6-02-backup-migration-cleanup.md` | 备份/迁移/清理：restore 四层校验、runbook、A40 分级清理、1269 全绿（含一次 local-api 并行脆弱性如实披露） |
| `reports/M6-03-release-security.md` | 发布安全核对：secrets/依赖/许可/治理盘点；§6.1 release-blocking 空；§6.2 待维护者清单 |
| `reports/M6-04-dogfood.md` | 受控 dogfood：全链路 + 三处失败注入 + 恢复；A11/A17/A22 实测证据；USAGE.md 核实方式 |

### 2.2 测试计数（本会话 `pnpm exec turbo run test --force` 逐包实测，合计 1312）

| 包（里程碑） | 测试数 | 包（里程碑） | 测试数 |
|---|---|---|---|
| contracts (M0-01) | 44 | approval (M4-01) | 90 |
| fake-cli (M0-03/04) | 23 | checkpoint (M4-02) | 29 |
| cli-events (M0-03/04) | 147 | expand (M4-03) | 27 |
| capability-gate (M0-06) | 18 | budget (M4-04) | 32 |
| process-lab (M0-05) | 12 | fault-matrix (M4-05) | 17（15 条注入用例 platform gate 全过） |
| store (M1-01) | 53 | implicit-verify (M4-06) | 29 |
| runtime-profile (M1-02) | 107 | reconcile (M1-05/M4) | 25 |
| engine (M1-03) | 26 | context (M3-01) | 40 |
| local-api (M1-04) | 192 | memory (M3-02) | 47 |
| dag (M2-01) | 86 | memory-search (M3-02/03) | 59 |
| scheduler (M2-02) | 45 | context-e2e (M3-04) | 15 |
| worktree (M2-03) | 20 | e2e-baseline (M2-06) | 21 |
| integration (M2-04) | 14 | browser-e2e (M5-05) | 7 |
| review (M2-05) | 19 | maintenance (M6-02) | 25 |
| release-audit (M6-03) | 42 | dogfood (M6-04) | 1（全链路，8 次 fake-cli 真子进程） |

### 2.3 关键注入/恢复用例（可查、可复跑）

- **故障注入矩阵**（`packages/fault-matrix`，15 条，FM-PROC/FM-* 编号）：launch 失败（ENOENT）、取消路径、进程边界等；平台门控跳过为零，本会话自报 `allPassed=true`。
- **dogfood 三处失败注入**（`reports/M6-04-dogfood.md` §2 表 #05/#07/#11，证据目录 `packages/dogfood/evidence/dogfood-chain-2026-09-23T20-50-49-856Z/`）：review 内容依据 fail → 受控扩图；fake-cli `action-proposal` 未授权写入提案（写入未发生，A19）→ 审批检查点 + A17 拒改探针（`ApprovalDigestMismatchError`）；启动窗口中断（A24）→ reconcile 判 `launch-window-undetermined` → RECOVERY_REQUIRED 不自动重跑（A22）→ 人工解决 → 显式重试成功。
- **升级失败恢复演练**（`packages/maintenance` `runUpgradeRecoveryDrill`，`reports/M6-02-backup-migration-cleanup.md` §1.2）：分支 A 干净失败（坏 018 → 库停在 001..017 → 同版本重放成功）；分支 B 库损坏 → 备份校验 → 恢复 → 数据逐计数相等 → 修正迁移应用。
- **损坏备份拒绝**（`packages/store` restore 四层校验）：截断 / 零字节 / 非 SQLite 垃圾 / 篡改校验和 / 降级守卫全部拒绝且活库零改动。
- **浏览器五流程**（`packages/browser-e2e/test/flow-1..5`，截图证据 `packages/browser-e2e/evidence/`）：顺序、并行、返工、审批、恢复 + A38 过时 revision 冲突提示 + A39 断线重放去重。
- **A30/A32/A36 回归子集**（`reports/M6-03-release-security.md` §4，本会话随全量跑通过）：守卫管道 59、能力姿态 18、脱敏 147+3+3、契约 44。

### 2.4 发布审计（本会话复跑 `node packages/release-audit/dist/cli.js all .` → exit 0）

- `blocking: []`（secrets / dependencies / license / governance 四节均无阻断）。
- secrets：2134 文件（文本 1115、二进制 1019），21 条命中全部已分类（test-sentinel / known-fake-sentinel），`needs-judgment` 0，verdict `known-reservations-only` —— A42（发布包不含 auth、API key、原始 transcript）当前成立。
- dependencies：31 个 workspace 项目；specifier 不一致 0；缺 integrity 0；非默认 registry 0；未知 license 0；`noticesCovered` 0 / `noticesUncovered` 84（THIRD_PARTY_NOTICES.md 更新为待维护者项，见 §6）。
- license：候选文本措辞与 Apache-2.0 官方原文逐字一致（`wordingIdentical: true`、`byteIdentical: false`）、正式化状态 `pending-maintainer-confirmation`、正式 `LICENSE` 文件不存在。
- governance：CODEOWNERS `placeholder-only`（生效规则 0）；私密渠道 `not-configured-documented`；发布批准 `pending-maintainer`；维护者身份字段未记录。

## 3. 支持范围（verified / unverified 逐项）

权威矩阵是 `reports/M6-01-platform-matrix.md`（每一格带证据）；此处按发布口径汇总。

### 3.1 verified（仅限下述参考机与采集日事实）

| 项 | 范围与边界 | 证据 |
|---|---|---|
| 平台：win32-native | Windows 10.0.26100 x64（本参考机），**不外推为「Windows 全系保证」**（不同构建/杀软/长路径注册表配置未测） | `reports/M6-01-platform-matrix.md` §1.7、§6 风险 2 |
| 工具链 | Node v25.0.0 / pnpm 10.14.0 / git 2.54.0.windows.1 / Python 3.13.14 | 本会话 §0 实测 |
| 路径形态 | 中文/空格/跨盘/`.cmd` shim/长路径参数位置全链路可用（含 shim×>260×中文×空格叠加格） | 同上 §1.1 |
| 进程语义 | `taskkill /T /F` 树杀、Node 25 父死级联（当前实测版本）、PID 复用三元组身份、>260 cwd spawn ENOENT fail-closed | `reports/M0-05-windows-launcher.md`、`reports/M6-01-platform-matrix.md` §1.2 |
| CLI 版本（采集日事实） | claude `2.1.278`（2026-09-21 真实调用 8 次 + 09-22 补采 2 次）；codex-cli `0.154.0`（2026-09-21 真实调用 9 次）；**「当前仍为该版本」不可本机复验** | `packages/cli-events/fixtures-real/` manifest、`reports/M6-01-platform-matrix.md` §1.6 |
| WSL2 进程语义（仅进程） | setsid/负 PGID SIGKILL、跨命名空间 PID 拒绝；**CLI 行为不在内** | `reports/M0-05-windows-launcher.md` §4 场景 5 |
| 凭据锁语义 | 并发恒为 1（契约字面量，非旋钮）；凭据隔离 unverified → dispatch gate 拒绝（fail-closed） | `packages/contracts`、`packages/scheduler` 测试（A33） |
| 安全姿态 | 只标 Local Trusted，不宣称 Hardened（A31/A32 姿态不变量钉住） | `config/policies.yaml`、`packages/capability-gate` 测试 |
| 本地 API 安全面 | 仅回环绑定、令牌鉴权、A30 守卫管道、A36 落盘脱敏 + 渲染消毒（全部测试随全量跑通过） | `packages/local-api`、`packages/engine`、`packages/cli-events` |
| dogfood 全链路 | 建图→调度→执行→集成→审查→扩图→审批→中断→恢复→重试，fake-cli dist bin，A11/A17/A22 实测 | `reports/M6-04-dogfood.md` §2–§3 |

### 3.2 unverified（逐项；按 unknown-deny 处理，不得标 verified）

| # | 项 | 缺口 | 所需环境 |
|---|---|---|---|
| 1 | macOS 全部维度 | 0 次实测 | 实体机或指定 CI 载体（不以 CI 编译成功替代真实 CLI 验证） |
| 2 | Linux-native 全部维度 | 0 次实测 | 同上 |
| 3 | WSL1 全部维度 | 本机 `wsl --status` 明示不支持 | 支持 WSL1 的宿主 |
| 4 | WSL2 内两 CLI 安装/认证/协议行为 | 仅进程语义已验证，CLI 行为 0 实测 | WSL 发行版内真实 CLI 认证 |
| 5 | claude 凭据隔离（A33 数据面） | 仅 `apiKeySource:"none"` 旁证 | 双账号隔离实验（本任务禁止调用真实 CLI/读取凭据） |
| 6 | codex 凭据隔离（A33 数据面） | 仅错误文本旁证 ChatGPT account | 同上 |
| 7 | Hardened 沙箱边界（A31 完整验收） | 两 CLI 审批/沙箱拒绝路径均 unverified → 产品不宣称 Hardened | 经真实证据验证的强沙箱平台/模式 |
| 8 | 两 CLI 当前版本 | fixture 值是采集日事实，不自动外推 | 维护者授权的真实 smoke 窗口 |
| 9 | claude 成功推理路径/业务成功判定、结构化输出契约 | 429 窗口贯穿采集期，成功流从未采到（`PROPOSALS.md` P-M06-1） | 低峰窗口补采 + 结构化输出机制验证 |
| 10 | Node 版本范围 | 级联/边界行为仅声明 v25.0.0 复现 | Node 升降级后重跑 `packages/process-lab` |
| 11 | 其他 Windows 构建/长路径注册表配置 | 本机单一配置实测 | 各自实测，不外推 |
| 12 | POSIX 路径大小写语义 | `canonicalPath` 仅 win32 折叠大小写，逻辑与 worktree `samePath` 一致但未实测 | macOS/Linux 宿主 |

## 4. 已知限制（按主题归并；全部非阻断 minor 与已声明边界）

**平台与工具链（win32）**
- 进程 cwd >260 字符：任何进程 spawn 即 ENOENT，命令绝不执行（fail-closed）；git worktree 在超长路径下 exit 128（git-for-windows 2.54.0 实测），`core.longpaths=true` 反而使任意长度 add 失败（`$GIT_DIR too big`）——两条硬边界均已钉入测试（`reports/M6-01-platform-matrix.md` §1.1）。
- Node 25 `fs.cpSync`/`fs.rmSync` 对非 ASCII 路径崩溃/静默失效：staging/清理改用经验证原语白名单；上游提案 `PROPOSALS.md` P-M06-4 待提交跟踪。
- Node 25 父死级联（含正常退出触发、`detached:true` 豁免、杀 cmd shim 不级联）：仅声明当前实测版本，Node 升降级必须重跑 `packages/process-lab`（`reports/M0-05-windows-launcher.md` §5 结论 2）。
- GBK 控制台输出不可解析：唯一可靠信号是退出码 + Win32_Process 事后核对。
- `cmd /s` 引号剥离陷阱：启动器固定 `cmd.exe /d /c`（已钉住）。

**调度与凭据**
- 认证锁并发恒为 1（`unverifiedCredentialGroupMax: z.literal(1)`）：在凭据隔离（§3.2 第 5/6 项）证实前不可放松——这是 unverified 决定的产品现状，不是缺陷。
- 无人值守写入强制节点检查点（两 CLI 均无中途审批通道/不挡写入，blocked 假设钉住）。

**成功判定**
- 平凡真实运行在当前契约下一律 fail-closed（`business-schema-invalid`；CLI exit 0 ≠ 业务成功）：结构化输出契约机制属 `PROPOSALS.md` P-M06-1，是真实 CLI 联调的前置。
- claude 判定以 `is_error`/`terminal_reason` + 退出码 + 业务 schema 组合为准（`subtype:"success"` 陷阱已钉住）。

**工程与测试（如实登记的非阻断 minor）**
- reconcile 真实探针测试负载敏感：M6-01 披露的显式 20s 超时方案在位（零断言改动）；更轻的按 PID 过滤查询属行为微调，待维护者裁量（`PROPOSALS.md` M6-01 披露节）。
- local-api ws-live 类用例存在并行峰值脆弱性：M6-02 全量首跑失败 1 次、单包与后两次全量（含强制跑）全绿；该包文件零改动，未定位具体阈值（`reports/M6-02-backup-migration-cleanup.md` §4）。
- process-lab 级联用例的固定 2 秒墙钟在满载下不足：M6-04 已对齐为本包自有有界等待 `expectPidGone`（断言语义零弱化，`PROPOSALS.md` M6-04 披露节）。
- release-audit 工作区计数基线随包集合变化需手动更新（30→31 已披露）；turbo 缓存回放可能短暂恢复已迁移的孤儿 `dist/redact.*`（无导入引用，不影响行为，`PROPOSALS.md` 返修披露节）。
- 仓库内 `validate_bundle.py --self-test` exit 1（`node_modules` 断链）：冻结脚本不可触碰，`pnpm run planning:check` 的干净副本路径 exit 0 为准；上游提案在 `PROPOSALS.md` 头节。
- 升级演练业务数据只覆盖 store/memory/approval 三包 API；integration_records/review_records 在 drill 中未写真实行（清理套件以 fixture 行覆盖扫描路径）；恢复流程未在长期运行的真实守护进程下演练。
- dogfood 的 writer 提交与失败尝试簿记是已披露的基准替身；受控 Git Service 与恢复侧自动簿记属后续里程碑。
- `packages/browser-e2e/evidence/` 截图按次再生（二进制，仅文件名规则扫描）；M6-03 的 1980 → 本会话 2134 扫描文件数差异即来源于此。

**产品形态边界（当前没有的能力，发布说明须如实区分）**
- 无用户启动命令/守护进程；`POST /api/v1/executions/:id/dispatch` 为鉴权完整的 501 骨架；全部端到端演示使用 `packages/fake-cli` dist bin。
- 恢复人工解决后，已认领队列条目保持 DISPATCHED 不回流（A22 语义的设计呈现，非缺陷；显式重试走 engine 持有路径）。

## 5. 回退方案（引用）

- **升级/迁移失败恢复 RUNBOOK**：`packages/maintenance/README.md` §3（失败三分支：`application-failed` 干净回滚、`checksum-mismatch` 必须恢复备份、`unknown-applied-version` 停止人工裁决；分支 C 无备份时只能前向修复，永不回改已应用迁移）；§2 正常路径（升级前 `backupPath` 备份）；§4 损坏备份拒绝；可执行演示 `runUpgradeRecoveryDrill` 与运维 CLI `ro-maintenance <upgrade-drill|cleanup-plan|cleanup-execute>`。
- **恢复原语**：`@role-orchestrator/store` 的 `backupDatabase` / `inspectBackupFile` / `restoreBackup`（四层前置校验，任一失败在任何字节拷贝前拒绝）/ `verifyMigrations`；全链定义 `DAEMON_MIGRATIONS`（001..017，新迁移从 018 起编）。
- **安全清理回退面**：`packages/maintenance/README.md` §5 分级表（`auto` / `require-confirm` / `retain`）；A40 默认拒绝自动清理（dirty worktree、PENDING 审批、pending outbox 未确认一律不删）；乐观守卫（变脏/状态漂移即中止）。
- **用户指引**：`USAGE.md` §8「故障排查」（含升级/迁移失败、RECOVERY_REQUIRED 处理路径、路径边界）。
- **dogfood 流程回滚**：全部发生在系统临时目录 fixture 仓库；A11 证据表明用户仓库逐字节不变（`reports/M6-04-dogfood.md` §3）；仓库本体保持非 git、无任何历史可被改写。

## 6. 待维护者确认清单（逐项「需要维护者决定」；当前状态为 M6-05 会话实测）

| # | 事项 | 需要维护者决定的内容 | 当前状态（本会话实测） |
|---|---|---|---|
| 1 | **LICENSE 正式化** | 是否将逐字一致的 Apache-2.0 候选文本（`LICENSE.proposed.txt`）放置为正式 `LICENSE`；确认版权归属与 NOTICE 字段 | 正式 `LICENSE` **不存在**；审计状态 `pending-maintainer-confirmation`；`wordingIdentical: true` / `byteIdentical: false`（差异仅为空白排版） |
| 2 | **Codeowners** | 以真实维护账号替换 `.github/CODEOWNERS` 模板 | `placeholder-only`：**生效规则 0 条**（9 行全为注释，含发布前替换标记） |
| 3 | **私密安全报告渠道** | 启用并验证 GitHub private vulnerability reporting 或等效渠道；渠道未配置前不公开发布 | `not-configured-documented`：`SECURITY.md` 明文要求，文档中 **0 个具体联系点** |
| 4 | **真实 CLI dogfood 拓展批准** | 是否授权真实 claude/codex 的受控 dogfood / smoke 窗口（配额成本由维护者裁量）；这是 §3.2 第 5–9 项 unverified 的唯一闭合路径 | **未开展**：真实调用仅 M0 探测（claude 8+2 次 / codex 9 次，采集日 2026-09-21/22）；M6-04 dogfood 全部使用 `packages/fake-cli` dist bin |
| 5 | **发布批准（M6-05 完成条件）** | 人工批准 + 候选 SHA 冻结 + 签名/校验摘要；按 `project/RELEASE_PROCESS.md` 执行 | 审计状态 `pending-maintainer`：**不存在任何发布批准记录**；Agent 不是发布批准主体 |
| 6 | THIRD_PARTY_NOTICES.md 更新 | 84 个 npm 外部依赖当前覆盖 **0/84**；按冻结文档治理流程补记并同步 `CHECKSUMS.sha256` | `noticesUncovered: 84`（本会话复跑） |
| 7 | 维护者身份字段 | 真实 handle/组织/联系渠道写入 `MAINTAINERS.md` | `maintainerIdentityRecorded: false` |
| 8 | MPL-2.0 复核 | 确认以未修改依赖形式使用 lightningcss 家族符合许可与发行预期（本会话安装清单中 2 个 MPL-2.0 + 9 个同家族未装平台二进制，均 dev/test 工具链，runtime 交付面 ws/yaml/zod 不含） | 登记于 `reports/M6-03-release-security.md` §2.2/§6.2，不构成阻断 |
| 9 | 冻结文档更新清单 | `PROPOSALS.md` P-M06-5（ADR 007/002、CLI_ADAPTERS、SECURITY_MODEL、ACCEPTANCE 证据指针）与 P-M06-6（根 `README.md` 增补 USAGE 指引）——均属冻结面变更，须走治理流程并同步 `CHECKSUMS.sha256` | **提案（未获批）**，未实施 |
| 10 | 其他运维裁量项 | `reports/M6-02-backup-migration-cleanup.md` §5（outbox 保留期、evidence 归档、worktree prune 自动化、清理回执持久化、local-api 串行化）；`reports/M6-01-platform-matrix.md` §4（reconcile 探针替代方案、上游提案跟踪、smoke 窗口排期）；`.zcode/` 归属（建议公开前决定，未改 `.gitignore`） | 各报告原文，均未代行 |

## 7. 明确声明

1. **本文件是审核材料，不构成发布批准。** 文中任何「达成 / 关闭 / 通过」仅指对应测试或审计在记录环境中的真实结果，不等于发布许可。
2. **维护者人工批准是 M6-05 完成的必要条件**：在 §6 第 5 项发生之前，M6-05 不得标记为完成，本仓库不得对外宣称已可按开源许可使用或已可发布。
3. 提案不是权限：`PROPOSALS.md` 全部条目（含 P-M06-1..6 与各披露节）均为未获批提案，不因本文件引用而生效。
4. 未验证不标 verified：§3.2 全部条目按 unknown-deny 处理；相关产品行为（认证锁并发 1、节点检查点、Local Trusted-only）是被 unverified 决定的合规姿态，不是可提前放松的保守余量。
5. 本文件为新增文件，未触碰冻结面（`node planning-check.mjs` 在本文件落盘后复跑仍为 exit 0，78/78 一致）；未做任何测试代码变更。

## 8. 维护者决定记录（2026-09-24 追加）

维护者（Nick）于 2026-09-24 在审查会话中明确答复「**批准**」，范围与本文件配套的启动选项一致：

1. **批准对象**：本文件所述本地稳定版发布候选的技术状态——M0–M6 共 31 项任务全部 10/10 轮审查验收、1316 测试/30 包全绿、冻结面完好。
2. **授权效果**：解除 BACKLOG 中 M7-01..04 对 M6-05 的依赖，M7 四项架构设计/验证任务按既定协议（Flash 开发 + 10 轮连续审查）开工。
3. **不含的授权**：§6 第 1–10 项的正式发布类动作（放置正式 LICENSE、替换 CODEOWNERS、启用安全渠道、真实 CLI 联调、实际对外发布、notices 补记、身份登记等）**未因本次批准而生效**，仍逐项另行决定；第 5 项「实际发布」以未来单独的候选 SHA 冻结与签署为准。
4. 本节为追加记录，未修改 §0–§7 任何原文；冻结面核对在追加后复跑仍须通过。


## 9. 待确认清单状态更新（2026-09-25，维护者批准的身份项落地）

维护者批准并完成 §6 中的身份类事项（治理披露见 PROPOSALS.md 2026-09-25 节）：

- **第 1 项 LICENSE 正式化：已关闭**。根 `LICENSE` 已按候选文本逐字转正
  （sha256 `af975c97…`），审计状态 `formalized`。版权主体：Nick（个人名义）。
- **第 6 项 THIRD_PARTY_NOTICES：已关闭（附条件）**。84/84 依赖全部列入；
  其中 30 项未安装平台二进制按 unknown-deny 未标许可证，**发布前须经 registry
  复核**（此条件未完成前本项不算发布就绪）。
- **第 7 项 维护者身份：已关闭（附条件）**。MAINTAINERS.md 已记录 Nick 与
  handle 占位符 `@maintainer-handle`；真实 handle 替换前不视为发布就绪。
- **第 2 项 CODEOWNERS：部分关闭**。生效规则 7 条已建立（`rules-present`），
  全部指向 handle 占位符；真实 handle 替换后完全关闭。
- **第 3 项 安全渠道：方式已定**（GitHub 私密漏洞报告）；启用是维护者在
  GitHub 仓库设置中的操作，仓内文件无需变更，启用前保持
  `not-configured-documented`。
- **第 5 项 发布批准：保持 pending-maintainer**，未动。
- 其余（第 4、8、9、10 项）状态不变。

本节为追加记录，未修改 §0–§8 任何原文。

## 10. 待确认清单状态更新（2026-09-26，取代 §6/§9 表内已演进条目）

§6/§9 为历史时点快照。此后经维护者批准/确认，状态已演进（证据链见
PROPOSALS.md 各治理披露节与 reports/LICENSE-REVIEW-1.md）：

- 第 1 项 LICENSE：已关闭（formalized）。
- 第 2 项 CODEOWNERS：已关闭——7 条规则指向 @WeirdStar0（2026-09-25
  handle 批）；生效前提为仓库推送 GitHub。
- 第 6 项 NOTICES：已关闭——84/84 覆盖；30 项未安装依赖经 registry 逐条
  核实（MIT 20 / MPL-2.0 10，LICENSE-REVIEW-1）。
- 第 7 项 维护者身份：已关闭（@WeirdStar0）。
- 第 8 项 MPL-2.0：registry 复核与合规评估完成（LICENSE-REVIEW-1 §2），
  待维护者最终确认。
- 第 5 项 发布批准：保持 pending-maintainer。
- 第 3/4/9/10 项状态不变。

本节为追加记录，未修改 §0–§9 任何原文。

## 11. 第 3 项（安全报告渠道）关闭（2026-09-26）

§10 载「第 3 项状态不变」已被同日后续演进取代：GitHub private vulnerability
reporting 在维护者账号仓库设置页不可用（界面限制，社区同型问题），经维护者
决定渠道改配为邮箱 weirdstar@outlook.com（SECURITY.md 已更新，
PROPOSALS.md 2026-09-26 安全渠道披露节）。release-audit 状态翻转为
`contact-points-present`。转公开前维护者核验收信即可。
