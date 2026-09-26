# M6-01 · Windows 与扩展平台矩阵（证据盘点）

状态：已完成。角色：Reviewer（汇总）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M6-01（验收 A28/A29/A31/A32/A33）；完成标准「路径、取消、权限、认证与 CLI 版本矩阵有证据」。

本报告只汇总**已证实**的事实：每一格标注证据来源（哪份报告/哪个测试文件/本会话哪条命令的退出码）与状态（verified / unverified / blocked）。凡本会话真实执行过的检查均附命令与退出码；未执行、不可本机执行的一律 unverified 并写明所需环境。没有格子因「应该可以」而标 verified。

## 0. 本次实测环境（全部本会话实测）

| 项 | 值 | 本次实测命令 |
|---|---|---|
| OS | Windows 10.0.26100.7171 x64（系统 locale zh-CN，控制台代码页 936/GBK） | `cmd.exe /d /c ver` |
| Node / pnpm | v25.0.0 / 10.14.0 | `node -v` / `pnpm -v` |
| git | 2.54.0.windows.1 | `git --version`（仅查询版本，未对本仓库做任何 git 操作） |
| Python | 3.13.14 | `python --version` |
| WSL | `wsl --status` exit 0（WSL2/Ubuntu 默认；本机不支持 WSL1） | `wsl.exe --status` → exit 0 |
| 冻结面 | `pnpm run planning:check` exit 0（78 个冻结文件 sha256 逐一一致 + 干净副本 self-test exit 0） | `node planning-check.mjs` → exit 0 |
| 仓库内 self-test | exit 1（`node_modules` 在场导致冻结 `check_links` 扫入第三方断链）——已知保留问题，如实记录 | `python scripts/validate_bundle.py --self-test` → exit 1 |
| 冻结脚本哈希 | `scripts/validate_bundle.py` sha256 `f829d28605441cdb3dd80de7b4f7c99d60bc10e6b5070984dbc03980f2342a6c`（与 `CHECKSUMS.sha256` 一致，未触碰） | `sha256sum scripts/validate_bundle.py` |

测试基线（改动前，本会话实测）：`pnpm test` exit 0，27 包 **1232 通过 / 0 失败**。改动后最终门禁见 §5。

## 1. 证据盘点矩阵

状态图例沿用 M0-06：verified（真实命令/fixture 已证实）｜unverified（无证据或只覆盖部分，按 unknown-deny 处理）｜blocked（该用法本身危险，禁止启用）。「本会话复跑」列 = 2026-09-24 本次任务中真实执行的证据。

### 1.1 路径（A28：中文/空格/长路径/不同盘符/.cmd）

| 格 | 平台/对象 | 状态 | 证据来源 | 本会话复跑 |
|---|---|---|---|---|
| 中文+空格目录全链路（dist 拷贝→.cmd shim→JSONL 事件流→严格拒绝） | win32-native | **verified** | `reports/M0-05-windows-launcher.md` §4 场景2；`packages/process-lab/test/unicode-paths.test.ts` | ✅ `pnpm vitest run`（process-lab，6 文件 12 测试全过，exit 0） |
| **`.cmd` shim × 长路径(>260) × 中文 × 空格三者叠加**（M0-05 §7 未验证项#5 / 平台基线 §7.5 的空白格） | win32-native | **verified（本次补测闭合）** | 新增 `packages/process-lab/test/longpath-cjk-shim.test.ts` 测试 1：390 字符 shim 路径、407 字符目标脚本、`cmd.exe /d /c`、中文+空格 cwd → success exit 0、7 行合法 JSONL、`is_error=false`、未知参数 exit 2 | ✅ 同上（该测试实测通过，839ms） |
| 长路径直启（node 直带 >260 脚本参数） | win32-native | **verified** | `reports/M0-05-windows-launcher.md` §4 场景2（420 字符脚本 exit 0） | ✅ 本次探测复现（C1：node 直带 413 字符脚本参数 exit 0） |
| **>260 cwd 是硬边界：任何进程 spawn 即 ENOENT，命令绝不执行（fail-closed）** | win32-native | **verified（本次补测钉住）** | 新增 `packages/process-lab/test/longpath-cjk-shim.test.ts` 测试 2：node 与 cmd.exe 在 >260 cwd 下 spawn 均报 ENOENT，marker 文件从未创建；本会话探测 C2/C3 同结果（exit code -4058） | ✅ 同上（该测试实测通过） |
| `cmd /s` 引号剥离陷阱（必须 `/d /c`，禁 `/s`） | win32-native | **verified** | `reports/M0-05-windows-launcher.md` §4 场景2、§5 结论5；`packages/engine/src/invocation.ts` `resolveExecutionCommand`（`.cmd` → `["/d","/c",shim]`）；`packages/engine/test/invocation.test.ts` | ✅ `pnpm test`（engine 26 测试全过） |
| git worktree 跨盘（repo 与 worktree 不同盘符） | win32-native | **verified（平台门控：需可写第二盘）** | `packages/worktree/test/paths.test.ts`（`test.skipIf` 无第二盘时如实声明跳过；本机 H: 在场，实测通过） | ✅ `pnpm test`（worktree 20 测试全过） |
| git worktree 中文+空格仓库与工作树、argv 无注入 | win32-native | **verified** | `packages/worktree/test/paths.test.ts` 测试 1（CJK 路径单一 argv 元素、无引号注入、全周期 create→write→status→discard） | ✅ 同上 |
| **>260 长路径 git worktree：工具链拒绝，fail-closed**（`core.longpaths` 已知边界） | win32-native | **verified（fail-closed 行为）** | `packages/worktree/test/paths.test.ts` 测试 2（git-for-windows 2.54.0 实测：262/301 字符 exit 128；`-c core.longpaths=true` 与仓库级配置反而使任意长度 add 失败 `$GIT_DIR too big`；钉住 typed `GitCommandError` + 无目录 + 用户仓库不动）；边界登记于 `packages/worktree/README.md`「已知边界」节（该节明言「应记入 M6-01 Windows 兼容矩阵」，即本节） | ✅ 同上 |
| Node 25 `fs.cpSync`/`fs.rmSync` 非 ASCII 路径缺陷（staging/清理禁用，改经验证原语白名单） | win32-native | **verified（缺陷现状）** | `reports/M0-05-windows-launcher.md` §4 场景2、§5 结论6；上游提案 `PROPOSALS.md` P-M06-4；`packages/worktree/README.md` 与 `packages/process-lab/src/fakecli.ts`/`scratch.ts` 的白名单实现 | 间接（本会话全部测试经这些原语完成拷贝/清理，无失败） |
| 路径中文/空格/长路径/跨盘 —— macOS / Linux-native / WSL1 / WSL2 内 | 非 win32 | **unverified** | `reports/M0-06-platform-baseline.md` §2–§4；`packages/capability-gate/src/registry.ts`（`*.platform-difference.other-platforms` = unverified） | ❌ 无本机（见 §3） |

**给 A28 的矩阵结论（win32-native）**：中文/空格/跨盘/`.cmd`/长路径五形态全部有实测证据；长路径在**进程 cwd 位置**（>260 spawn ENOENT）与 **git worktree 位置**（exit 128 fail-closed）各有一条硬边界，在 **argv/脚本参数位置**（含 .cmd shim 全链路）可用。三处边界均已钉入测试。

### 1.2 取消（A26 树杀/级联/orphan；A27 PID 复用）

| 格 | 平台/对象 | 状态 | 证据来源 | 本会话复跑 |
|---|---|---|---|---|
| `taskkill /PID <pid> /T /F` 树杀全灭（cmd→node→node→node 链 + conhost） | win32-native | **verified** | `reports/M0-05-windows-launcher.md` §4 场景1；`packages/process-lab/test/cmd-wrapper.test.ts` | ✅ `pnpm vitest run`（process-lab） |
| 杀 `.cmd` shim 不带 `/T` → 整条 node 子树孤儿存活（必须 /T 的实证） | win32-native | **verified** | 同上（cmd-wrapper 测试 2） | ✅ 同上 |
| Node v25 父死级联（杀 node root 子孙同灭；正常退出同样触发；`detached:true` 豁免；杀 cmd 一级不级联） | win32-native（当前实测版本，非永久结论） | **verified** | `reports/M0-05-windows-launcher.md` §4 场景3 级联边界 1–5、§5 结论2；`packages/process-lab/test/cancel-semantics.test.ts` | ✅ 同上（cancel-semantics 2 测试通过） |
| 挂起进程单杀 `taskkill /F`：死亡 + 非干净退出（exit 1），取消不得据此误报业务失败 | win32-native | **verified** | `reports/M0-05-windows-launcher.md` §4 场景3 case A/C、§5 结论8 | ✅ 同上 |
| PID 秒级复用（3000 spawn → 2099 distinct，901 次复用）；身份判定必须 `(pid,name,parentPid,creationTime)` 三元组 | win32-native | **verified** | `reports/M0-05-windows-launcher.md` §4 场景4；`packages/process-lab/test/pid-reuse.test.ts`；blocked 假设 `process.pid-only-identity`（`packages/capability-gate/src/registry.ts`） | ✅ 同上（pid-reuse 2 测试通过，碰撞实测出现） |
| WSL2 内：单杀 root 留孤儿；负 PGID SIGKILL 全灭（与 Windows 级联相反） | WSL2/Ubuntu | **verified（仅进程语义）** | `reports/M0-05-windows-launcher.md` §4 场景5；`packages/process-lab/test/wsl.test.ts` | ✅ `pnpm vitest run`（process-lab，wsl 2 测试通过——本会话真实执行了 WSL 内 setsid/kill 实验） |
| 取消/恢复语义按 execution target 分别定义；跨命名空间 PID 混用拒绝 | 全平台 | **verified（拒绝语义）** | `packages/reconcile/src/decide.ts`（非 windows-native target 拒绝解释 PID）；`packages/reconcile/test/decide.test.ts`；blocked 假设 `platform.cross-namespace-pid` | ✅ `pnpm test`（reconcile 25 测试全过） |
| 故障注入矩阵中的进程边界（launch 失败/取消路径） | win32-native | **verified** | `packages/fault-matrix/test/`（15 用例，`0 failed, 0 skipped (platform gate)`，本会话 `pnpm test` 输出实测） | ✅ |

### 1.3 权限（A33 认证锁与 unverified 语义）

| 格 | 状态 | 证据来源 | 本会话复跑 |
|---|---|---|---|
| 凭据组并发 = 1（`unverifiedCredentialGroupMax` 为契约字面量，非旋钮） | **verified（约束在位）** | `packages/contracts/src/schema/policies.ts`（`z.literal(1)`）；`packages/scheduler/test/policy-gate.test.ts`（非 1 一律拒绝） | ✅ `pnpm test`（contracts 44 / scheduler 45 测试全过） |
| `credentialGroupMax` 在隔离未证实前恒为 1（两 CLI 现状） | **verified** | `packages/scheduler/test/policy-gate.test.ts`（A33 describe） | ✅ 同上 |
| 凭据隔离能力格双 CLI 均 unverified → dispatch gate 拒绝 | **verified（fail-closed 语义）** | `packages/scheduler/test/policy-gate.test.ts`（`evaluateDispatchGate("claude","claude.credential-isolation")` → `allowed:false`）；`packages/capability-gate/src/registry.ts` 两个 `*.credential-isolation` 格 = unverified | ✅ 同上 |
| 能力未知不标记支持：`statusOf(未知)` → unverified、`isUsable` 仅 verified、未知假设 → blocked | **verified** | `packages/capability-gate/test/registry.test.ts`（unknown-deny / isUsable 测试） | ✅ `pnpm vitest run`（capability-gate 18 测试全过） |

### 1.4 认证（A33/A31：凭据隔离与 Hardened 边界现状）

| 格 | 状态 | 证据来源 | 本会话复跑 |
|---|---|---|---|
| claude 凭据隔离 | **unverified**（仅 `apiKeySource:"none"` 间接旁证；按约束未探测凭据配置） | `reports/M0-06-capability-matrix.md` §1 该格；`reports/M0-03-claude-capability.md` §7 A33 | ❌ 本任务禁止调用真实 claude/读取凭据（见 §3.1） |
| codex 凭据隔离 | **unverified**（仅后端错误文本旁证 ChatGPT account） | `reports/M0-06-capability-matrix.md` §2 该格；`reports/M0-04-codex-capability.md` §7 A33 | ❌ 同上 |
| A31 Hardened 边界的**现有拒绝行为**：当前不存在任何 Hardened 宣称，因为没有任何格子提供其前置（沙箱/审批拒绝路径双 CLI 均 unverified，沙箱关闭模式 blocked） | **verified（不宣称姿态，本次补测钉住）** | 新增 `packages/capability-gate/test/registry.test.ts` describe「A31/A32 posture」3 测试：两个沙箱相邻格必须保持 unverified 且不可用、两个 unattended-write 保持 blocked、`claim.unverified-capability-as-supported` 必须 blocked（unknown-deny）；旁证 `reports/M0-06-capability-matrix.md` §5 | ✅ `pnpm vitest run`（capability-gate 18 测试全过） |
| A31 完整验收（测试脚本真实读取宿主 secret 被真实 Hardened 沙箱边界阻止） | **unverified** | 无任何平台有 verified 强沙箱证据（M0-06 §5；`codex.approval-sandbox-rejection-path` unverified） | ❌ 所需环境见 §3.2 |
| A32：CLI 不能证明强沙箱 → 只能标 Local Trusted | **verified（产品姿态）** | `config/policies.yaml`（冻结，`mode: local-trusted`）；`packages/contracts/src/schema/policies.ts` SecurityPolicySchema；M0-06 §5 | ✅ `pnpm test`（contracts 示例校验过） |

### 1.5 A29（Windows-native 与 WSL 路径/世界混用 → 前置错误，不隐式转换）

显式拒绝测试**已存在且覆盖完整**（本次盘点确认无缺口，不补）：

| 格 | 状态 | 证据来源 | 本会话复跑 |
|---|---|---|---|
| profile/project/request target 不一致 → 类型化错误，不隐式转换 | **verified** | `packages/runtime-profile/src/target.ts` `checkExecutionTarget`；`packages/runtime-profile/test/target.test.ts` | ✅ `pnpm test`（runtime-profile 107 测试全过） |
| 路径形态分类（win32 盘符/UNC/`\\wsl$`/POSIX 绝对/相对） | **verified** | 同上 `classifyPathForm` 测试 | ✅ 同上 |
| windows-native + POSIX 绝对路径拒绝；wsl + 盘符路径拒绝；wsl + 非 WSL UNC 拒绝；`\\wsl$` 两个世界都拒绝 | **verified** | `packages/runtime-profile/test/target.test.ts`（path-form 各 it）；注册时同样拒绝（createProfile） | ✅ 同上 |
| engine launcher 层对非 windows-native target 拒绝执行（不做隐式转换） | **verified** | `packages/engine/src/invocation.ts`（`SUPPORTED_EXECUTION_TARGETS` + 快照校验）；`packages/engine/test/invocation.test.ts`（A29 it） | ✅ `pnpm test`（engine 26 测试全过） |
| WSL2 进程语义与 native 分开记录、跨命名空间 PID 不可混用 | **verified（WSL2 进程语义）** | `reports/M0-05-windows-launcher.md` §4 场景5、§5 结论4；`packages/process-lab/test/wsl.test.ts` | ✅ 本会话复跑通过 |

### 1.6 CLI 版本（实测记录）

| 格 | 状态 | 证据来源 | 本会话复跑 |
|---|---|---|---|
| claude `2.1.278`（`2.1.278 (Claude Code)`）于 Windows 10.0.26100 x64，2026-09-21 真实调用 8 次 + 2026-09-22 补采 2 次 | **verified（截至采集日）** | `packages/cli-events/fixtures-real/claude/manifest.json`（`cli.version`/`versionOutput` 逐字记录）；钉住测试 `packages/cli-events/test/real-fixtures.test.ts`；`reports/M0-03-claude-capability.md` §1 | ✅ 钉住测试随 `pnpm test` 通过（147 测试全过）。**「当前仍为该版本」不可本机复验**：需调用真实 claude，本任务禁止（§3.1） |
| codex-cli `0.154.0`（`codex-cli 0.154.0`）同环境，2026-09-21 真实调用 9 次 | **verified（截至采集日）** | `packages/cli-events/fixtures-real/codex/manifest.json`；`packages/cli-events/test/real-codex-fixtures.test.ts`；`reports/M0-04-codex-capability.md` §1 | ✅ 同上（147 含 codex fixture 测试） |
| 两 CLI 当前版本是否仍为上述值 | **unverified** | 无（禁止真实调用） | ❌ 见 §3.1 |

### 1.7 平台矩阵总览（扩展平台记录）

| 平台 | 状态 | 本次新增/变化 | 证据 |
|---|---|---|---|
| win32-native（10.0.26100.7171 x64） | **优先目标，verified（范围内）** | 新增：shim×长路径×中文×空格叠加格闭合（可用）；>260 cwd spawn 边界钉住（fail-closed）；A31 不宣称姿态钉住 | 本报告 §1.1–§1.5 全部 ✅ 行 |
| WSL2 / Ubuntu | **verified（仅进程语义）；CLI 行为 unverified** | 无新增（wsl.test.ts 本会话复跑通过） | §1.2 WSL 行；`reports/M0-06-platform-baseline.md` §2 |
| WSL1 | **unverified（本机不支持，0 实测）** | 无 | `wsl --status` 实测输出；平台基线 §3 |
| macOS / Linux-native | **unverified（无本机，0 实测）** | 无 | 平台基线 §4；`packages/contracts` `EXECUTION_TARGETS` 枚举不构成验证 |

## 2. 本次缺口补测（全部真实执行）

| # | 缺口 | 补测 | 实测结果 |
|---|---|---|---|
| 1 | M0-05 §7 未验证项#5 / 平台基线 §7.5：`cmd /d /c` shim × >260 长路径 × 中文 × 空格叠加从未测量（A28 唯一空白格） | 新增 `packages/process-lab/test/longpath-cjk-shim.test.ts` 测试 1（win32 门控，如实声明） | **通过**（exit 0，839ms）：390 字符 shim / 407 字符目标，success exit 0 + 7 行 JSONL + `is_error:false` + `structured_output` 在位；未知参数 exit 2。结论：该格 **可用**，M0-05 的 long-path 空白格闭合 |
| 2 | 同一探测发现的硬边界：>260 cwd 的 spawn 行为此前只对 git 记录过（worktree README），未对 node/cmd.exe 泛化钉住 | 同文件测试 2（win32 门控） | **通过**：node 与 cmd.exe 在 >260 cwd 下 spawn 均 ENOENT（探测实测 exit code -4058），marker 证明命令从未执行 → launcher 依赖的 fail-closed 性质成立并钉入测试 |
| 3 | A31 Hardened 边界的现有拒绝行为无显式测试（此前只有逐格 pin，没有「不存在 Hardened 宣称依据」的姿态不变量） | 新增 `packages/capability-gate/test/registry.test.ts` describe「A31/A32 posture」3 测试 | **通过**（capability-gate 15 → 18 测试）：沙箱相邻格保持 unverified 且 `isUsable=false`、unattended-write 双双 blocked、unknown-deny 假设 blocked |
| 4 | A29 WSL 路径混用拒绝的显式测试（ask 点名核查） | **盘点确认已存在，无需补**：`packages/runtime-profile/test/target.test.ts`（path-form 全形态 + 注册时拒绝）、`packages/engine/test/invocation.test.ts`（launcher 层拒绝非 windows-native）、`packages/reconcile/test/decide.test.ts`（跨命名空间 PID 拒绝） | ✅ 随 `pnpm test` 全部通过 |

补测过程说明（如实）：A28 叠加格的首轮探测曾出现「node 收到含控制字符的模块路径」的假象，逐层二分后确认是**探测脚本自身的转义序列缺陷**（batch 文件被写入了 0x08/0x0C 字节），非平台行为；最终钉住测试的 shim 内容经控制字节扫描为空（`fileControlBytes: []`）后判定。矩阵证据一律以内容清洁的 shim 为准。

Turbo 登记：两个补测文件分别位于既有 `packages/process-lab` 与 `packages/capability-gate` 的 `test/`，随既有 `test: vitest run` 脚本自动进入根 `turbo run test` 管道（§5 的 `pnpm test` 实测含新测试：1237 通过）。

## 3. 不可本机验证项（unverified，含所需环境）

1. **两 CLI 真实凭据隔离（A33 数据面）**：需要用户自行认证的真实 claude/codex、双账号隔离实验（独立 configDir 下 API key/会话是否互不可见）；本任务约束禁止调用真实 CLI、禁止读取凭据与 CLI 配置文件。在此之前认证锁并发维持 1（§1.3，已钉住）。
2. **A31 完整验收（Hardened 沙箱真实阻止 secret 读取）**：需要存在一个经真实证据验证的强沙箱平台/模式（当前两 CLI 的审批/沙箱拒绝路径均 unverified）；按验收规则，达不到就必须禁用该声明——当前「不宣称 Hardened」即为合规姿态（§1.4，已钉住）。
3. **两 CLI 当前版本重测**：需要维护者授权的真实 smoke 窗口（真实调用有配额成本）；fixture 清单中的 2.1.278/0.154.0 是采集日事实，不自动外推为当前事实。
4. **macOS / Linux-native 全部维度**：需要对应实体机或指定 CI 载体（且不以 CI 编译成功替代真实 CLI 验证）。
5. **WSL1**：本机 `wsl --status` 明示不支持；需要支持 WSL1 的宿主。
6. **WSL2 内两 CLI 安装/认证/协议行为**：需要 WSL 发行版内的真实 CLI 认证；本机仅进程语义可测且已测（§1.2）。
7. **其他 Windows 构建/长路径注册表配置下的 >260 边界**：本机单一配置（LongPaths 未显式配置）实测 ENOENT；其他构建需各自实测，本结论不外推。
8. **Node 25 父死级联的版本范围**（沿袭 M0-05 未验证项#3）：仅声明本机 v25.0.0 复现；Node 升级/降级后必须重跑 `packages/process-lab` 五+一场景。

## 4. 待维护者确认清单（本任务不代行、不伪造已确认状态）

1. `PROPOSALS.md` P-M06-5 冻结文档更新清单（ADR 007/002、`docs/CLI_ADAPTERS.md`、`docs/SECURITY_MODEL.md`、`docs/ACCEPTANCE.md` 补记证据指针）——属冻结面变更，须走治理流程；本任务未触碰。
2. `PROPOSALS.md` P-M06-4（Node 25 fs 缺陷上游提案）的上游提交与跟踪。
3. 真实 smoke 窗口的授权与排期（§3.1/§3.3 两项 unverified 的唯一闭合路径）。
4. LICENSE 正式化、Codeowners、私密渠道、发布批准（M6-03/M6-05 范围，本任务零接触，此处仅登记存在）。

## 5. 门禁结果（真实退出码，任务收尾时回填）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm test`（改动前基线） | 0 | 27 包 1232 通过 / 0 失败（reconcile:test 为 turbo 缓存命中，未真实执行） |
| `pnpm vitest run`（process-lab，单包） | 0 | 6 文件 **12** 测试（含新增 2） |
| `pnpm vitest run`（capability-gate，单包） | 0 | 1 文件 **18** 测试（含新增 3） |
| `pnpm vitest run`（reconcile，单包，超时调整后） | 0 | 3 文件 25 测试 |
| `pnpm typecheck`（最终） | 0 | 50 tasks |
| `pnpm test`（最终） | 0 | 27 包 **1237 通过 / 0 失败**（54 tasks 全部成功） |
| `pnpm build`（最终） | 0 | 27 tasks |
| `pnpm run planning:check` | 0 | 78 个冻结文件 sha256 一致；干净副本 self-test exit 0（`PROPOSALS.md` 追加披露后复跑仍 0） |
| `python scripts/validate_bundle.py --self-test`（仓库内） | 1 | 已知保留问题（`node_modules` 断链），未修复、未掩盖、未绕过 |

如实记录的中间失败：超时调整前，两次全量 `pnpm test`（exit 1）在 reconcile「the default probe is the real windowsProcessProbe」上以 `Error: Test timed out in 5000ms` 失败——这是本次新增测试使 turbo 缓存失效后**首次真实执行**该包所暴露的既有负载敏感问题（单包运行绿、断言零改动）；完整披露与待维护者裁量的替代方案见 `PROPOSALS.md` M6-01 披露节。

## 6. 偏离与风险

**偏离**
1. ask 指引「PROPOSALS.md 中已登记的长路径/core.longpaths 已知边界」：实际登记位置是 `packages/worktree/README.md`「已知边界」节（含 core.longpaths 实测结论）与钉住测试 `packages/worktree/test/paths.test.ts`；`PROPOSALS.md` 只有相关的 Node 25 fs 上游提案（P-M06-4），无 core.longpaths 条目。本报告按实际位置引用。
2. ask 点名「A29 WSL 路径混用拒绝的显式测试若缺失则补」：盘点确认测试已存在且覆盖三层（runtime-profile/engine/reconcile），未重复补测，仅登记证据（§1.5）。
3. 新增测试 5 条（process-lab 2 + capability-gate 3），既有 1232 条全部保持，总数 1237。
4. **对既有文件的唯一修改**：`packages/reconcile/test/scan-store.test.ts` 的真实探针测试加显式 `{ timeout: 20_000 }`（与其内部 15 秒探针预算一致），零断言改动、零跳过。动机与两次全量红跑的完整经过见 §5 附注与 `PROPOSALS.md` M6-01 披露节；替代方案（更轻的按 PID 过滤查询）属行为微调，留给维护者裁量，本任务未实施。

**风险**
1. >260 cwd 的 ENOENT 边界与 git worktree 长路径拒绝均属**当前工具链实测事实**（Node 25.0.0 / git-for-windows 2.54.0 / 本机构建）；工具链升级可能改变行为，届时以 process-lab/worktree 测试失败为信号重测。
2. A28 叠加格的「可用」结论限定于本机配置；分发环境（不同 Windows 构建、杀软、长路径注册表开关）可能出现差异，矩阵使用方应把 win32 行视为「已在本参考机验证」而非「Windows 全系保证」。
3. 认证/Hardened 两大 unverified 面（§3.1/§3.2）决定认证锁并发=1 与 Local-Trusted-only 姿态必须维持，任何提前放松都是把未知当允许（blocked 假设 `claim.unverified-capability-as-supported` 已钉住拒绝语义）。
