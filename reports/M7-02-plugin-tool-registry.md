# M7-02 · 设计受控插件与工具扩展（版本化 manifest + 权限 scope + 可信来源分级 + 禁用策略）

状态：已完成（**仅设计与契约实现，无真实插件加载器**——本包没有任何读盘
加载、进程启动、网络连接或执行代码；本设计与设计中的任何部分都未加载过
真实插件，见 §8「已实现/仅设计」边界与 §9）。
角色：architect（Developer 授权执行）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M7-02（验收 A16/A35；完成标准「插件无法绕过
角色、图预算或审批控制面」）。
开工依据：维护者 2026-09-24 批准 M6-05 候选并授权 M7 开工
（`reports/M6-05-release-candidate.md` §8）。
交付物：本文档 + 新包 `packages/plugin-registry`（第 33 个 workspace 包，
基线更新披露见 `PROPOSALS.md` M7-02 节）。

**诚实声明（先行）**：本文档区分两类事实——「已实现并有测试」（本会话真实
执行的命令与退出码见 §7）与「仅设计（未实现/未验证）」（§8/§9 逐项列出）。
不存在插件加载器：磁盘发现、清单签名、实际加载、进程/连接生命周期、卸载
清理全部未实现；已实现的是这些环节的**唯一判定契约**（manifest schema、
信任清单记录、一个纯函数加载判定、审计事件 schema）与 hermetic 测试。
真实 CLI 插件生态（claude plugins/skills/agents、codex skills/MCP）的隐式
加载行为仅在 M0 探测过存在性（`claude.implicit-loading.explicit-control` 恒
为 unverified），本设计对它们的实际禁用/纳管**未经真实验证**。

## 0. 背景与问题

产品必须回答一个 M0 已实测暴露的问题：CLI 会在产品控制面之外隐式加载插件
生态。`packages/capability-gate` 的 blocked assumption
`implicit-loading.unmanaged-clean-baseline` 记录了真实证据：claude init 一次
隐式加载 9 个用户级 MCP server、13 个 agents、133 个 skills、4 个 plugins、
SessionStart hooks 与 171 个 slash commands，且 hook 事件真实出现在协议流里；
codex exec 流内 item error 直接提示 skills/plugins 已隐式加载。裸 `-p` /
`exec` 不是干净的，未经「清单 + hash + 显式信任/禁用」管理的隐式加载不得
进入有执行权限的运行（requiredControl: `explicit-management`）。

同时冻结的安全模型已给出插件的地位：
`docs/SECURITY_MODEL.md`（信任级别节）——「Agent 输出、仓库内容、依赖脚本、
MCP 返回、外部网页以及 **CLI 插件均不是权限来源**」；（开源供应链节）——
「MCP/Plugin/CLI 自带 hooks 要求**信任清单、版本/fingerprint 和受控启用**」。

M7-02 的范围是**设计 + 契约层实现**：把这两条原则落成可执行的判定契约——
版本化 manifest（semver + sha256 内容完整性）、声明式最小权限 scope（映射到
既有 capability-gate 检查与闭权限词汇）、可信来源三级分级（默认拒绝）、
kill switch 与禁用处置语义、以及逐条攻击路径的缓解。真实加载器与真实生态
纳管属后续独立验证任务（§10）。

## 1. 目标 / 非目标

**目标**

- G1 版本化 manifest 契约：严格 SemVer 2.0.0、sha256 内容 integrity、闭枚举
  scope 列表、发布方 trust 声明；全 strict schema，未知字段默认拒绝。
- G2 权限 scope 声明模型：声明式、最小权限（空 scope 合法且是地板）、scope
  与 contracts 闭权限词汇一一恒等映射、每个 scope 以数据形式引用既有
  capability-gate `REQUIRED_CONTROLS`；计量（budgetMetered）被
  `z.literal(true)` 钉死——免计量 scope 在类型层面不可表达（A35）。
- G3 可信来源分级：`builtin > verified > untrusted`，**默认拒绝**（清单缺席
  即 untrusted）；verified 必须带摘要钉（schema 层强制）；manifest 的 trust
  声明必须与清单**一致**，否则拒绝（防自封 verified、防调包）。
- G4 禁用策略：全局/按 id kill switch 与清单 disabled 标志，先于一切信任与
  scope 逻辑；判定是纯函数、不存在缓存接受——宿主逐次调用重估，禁用后下一
  次调用即被拒（§5 给出已加载实例处置的设计语义）。
- G5 完整性双钉：产物字节 vs manifest digest、manifest digest vs 清单钉，
  两个独立断言都必须成立。
- G6 覆盖词汇注入拒绝（A02/A16 类推）：model/Profile/role/permission/
  budget/approval/argv/env 等授权承载键名出现在 manifest 任何层级、或任何
  字符串值携带 permission-skip flag 文本（复用 capability-gate `isBlocked`
  同一注册表），一律以专用理由拒绝，先于 schema 解析。
- G7 审计面无文本（A42/A36）：审计事件是闭字段集，manifest 自由文本在结构
  上不可达；schema 未通过的拒绝连 id 都不落事件。

**非目标（本期明确不做）**

- N1 真实插件加载器（磁盘发现、校验加载、沙箱化执行、卸载清理）——后续
  独立任务；本包是它的唯一判定入口契约。
- N2 真实 claude/codex 插件生态纳管（如何禁用裸 `-p` 的隐式加载、MCP 清单
  不可见问题）：M0 结论是 explicit-control **unverified**，需要真实 CLI
  smoke 窗口，本任务红线禁止真实调用。
- N3 清单签名/公钥基础设施：v1 用 sha256 内容钉 + 宿主清单记录，签名是
  §10 提案。
- N4 manifest 市场/分发渠道、团队版共享信任清单（M7-04 边界）。
- N5 容器/Remote Worker 场景（M7-03 边界）。

## 2. 方案总览（ADR 决策记录）

- **D1 唯一判定入口，且是纯函数**。`evaluatePluginLoad`
  （`packages/plugin-registry/src/decision.ts:122`）是本包唯一能说「接受」
  的地方：无 I/O、无时钟、无随机性，同样输入恒等输出（测试钉住）。因此
  「每次工具调用重估」成为宿主义务而非性能牺牲——不存在需要失效的缓存
  接受，禁用语义天然成立（D5）。
- **D2 信任是宿主清单的事实，manifest 只携带必须一致的声明**。清单记录
  （`PluginInventoryRecordSchema`，`src/manifest.ts:135`）持有 tier、
  disabled、recordedDigest、来源标签；manifest 的 `trust` 字段是发布方声明，
  两者不等即 `trust-claim-mismatch` 拒绝（`decision.ts:171-178`）。自封
  verified 与调包攻击都被压到同一失败。
- **D3 scope 词汇借用而非新造**。五个 scope（`src/scope.ts:36`）逐字取自
  contracts 的 `PERMISSION_IDS`（有效权限是交集的既有模型，`src/scope.ts`
  头注），控制引用逐字取自 capability-gate 的 `REQUIRED_CONTROLS`——与
  M0-06 矩阵同一词汇，执行层不需要翻译层。绑定表在模块加载时按自身
  schema 重新 parse（capability-gate 的 registry 纪律），漂移即启动失败。
- **D4 计量不可豁免是类型事实**。`budgetMetered: z.literal(true)`
  （`src/scope.ts:62`）：一个「不计量」的 scope 在 schema 层面不可表达，
  A35 边界不是评审提醒而是类型错误。测试遍历全部 scope 断言恒真。
- **D5 禁用 = 下一次判定即拒**。kill switch（全局/按 id）在检查链第 3 步，
  先于清单、信任、完整性、scope（`decision.ts:146-152`）；接受态不存在
  缓存，测试钉住「同一输入先接受、加 kill switch 后拒绝」的处置语义。
  已加载实例的运行时拆除属加载器职责，设计见 §5。
- **D6 注入扫描先于 schema 解析，并委托同一份 gate 注册表**。原始输入上
  先跑 `scanForOverrideInjection`（`src/override-scan.ts`），键名命中闭集
  （`FORBIDDEN_OVERRIDE_KEYS`，`src/override-scan.ts:32`）即以
  `override-field` 拒绝（而非笼统 schema-invalid，攻击信号可见）；字符串值
  逐个过 capability-gate `isBlocked`（`src/override-scan.ts:29,107`）——gate
  注册表增长时 manifest 面自动收紧，无漂移副本。扫描深度上限 8、循环哨兵、
  结果条数上限，路径只由命中键名（闭集成员）与哨兵构成，不回显值。
- **D7 预期拒绝是值不是异常**。八个拒绝理由是闭枚举判别联合
  （`decision.ts` `PLUGIN_LOAD_REJECTION_REASONS`）；类型化错误只留给宿主
  接线错误（`PluginDecisionInputError`：digest 非 64 位 hex、verified 缺钉、
  输入容器未知字段）。宿主不会把「插件被拒」误处理成「注册表坏了」。
- **D8 审计投影是最小纯函数**。`pluginLoadAuditEvent`
  （`src/events.ts:51`）从判定值投影闭字段集事件；override-field /
  schema-invalid 两类前置拒绝的 id/version/digest 恒为 null——未解析的
  敌控数据不进审计，连 id 字段也不进。

## 3. 接口与不变量

### 3.1 版本化 manifest（G1）

`PluginManifestSchema`（`src/manifest.ts:108`，strictObject）：

| 字段 | 约束 | 位置 |
|---|---|---|
| `manifestVersion` | `z.literal(1)`，升位 = 破坏性 schema 变更 | `manifest.ts` |
| `id` | `^[a-z][a-z0-9.-]{1,79}$`（与 gate id 同形、独立命名空间） | `manifest.ts:27` |
| `name` / `description` | 有界文本，拒控制字符 + Trojan-Source 双向/零宽覆盖符（U+200B–200F/202A–202E/2060–2069/FEFF） | `manifest.ts:77-81` |
| `version` | 严格 SemVer 2.0.0（禁前导零，可带 prerelease/build），本地实现零新依赖 | `manifest.ts:33-42` |
| `entrypoint` | 相对 posix 路径，禁 `/` 开头、反斜杠、盘符、`.`/`..` 段（`src/manifest.ts:84`） | |
| `integrity` | `{ algorithm: z.literal("sha256"), digest: 64 位小写 hex }`（`manifest.ts:50`） | |
| `scopes` | 闭枚举数组，`withUniqueItems`，max 16；**空列表合法（最小权限地板）** | |
| `trust` | `builtin \| verified \| untrusted` 发布方声明 | `manifest.ts:56` |

注意 manifest 里**不存在**的字段：model、Profile、role、permission 授予、
budget、quota、approval、argv、env、hooks、MCP 定义——覆盖词汇连「等
schema 拒绝」的机会都没有（扫描先拒绝并点名，见 3.4）。

### 3.2 权限 scope 声明模型（G2）

五个 scope 与绑定表 `SCOPE_CONTROL_BINDINGS`（`src/scope.ts:70`，冻结）：

| scope | permissionId（恒等） | requiredControls（gate 词汇） | approvalRequired | budgetMetered |
|---|---|---|---|---|
| `repo.read` | `repo.read` | verified-only | false | **true** |
| `repo.write` | `repo.write` | node-checkpoint + explicit-authorization + verified-only | true | **true** |
| `git.read` | `git.read` | verified-only | false | **true** |
| `tests.run` | `tests.run` | full-success-conditions + verified-only | false | **true** |
| `memory.propose` | `memory.propose` | explicit-authorization | false | **true** |

刻意不在词汇中的：`dag.propose`、`decision.propose`（插件不获得图/决定
提案权）、一切执行形 scope（spawn/process/MCP connect——插件消费能力，
不创造执行，A35）。闭枚举：新增 = schema 变更走评审。

映射是**数据不是执行**：`scopeBindings` 随接受判定返回，enforcement 在执行
层；本包保证的是「漏声明计量/控制」不可表达 + 词汇与既有控制面同一。

### 3.3 加载判定守卫链（顺序即契约，`src/decision.ts:122-208`）

1. 注入扫描（原始输入）→ `override-field`；
2. 严格 schema（未知字段/semver/integrity/枚举）→ `schema-invalid`；
3. kill switch 全局 / 按 id → `kill-switch`（急停先于一切插件事实）；
4. 清单缺席 → `untrusted-source`（**默认拒绝**）；
5. 清单 disabled → `disabled`；
6. tier = untrusted → `untrusted-source`；
7. trust 声明 ≠ 清单 tier → `trust-claim-mismatch`；
8. 双完整性钉（清单钉 → 产物字节）→ `integrity-mismatch`；
9. 声明 scope ⊄ 宿主 allowlist → `scope-not-allowlisted`（精确匹配）；
10. accept（tier 恒为 builtin/verified，grantedScopes + scopeBindings）。

不变量（测试钉住）：expected 拒绝全部是值；detail 只含闭词汇 token 与
zod path+code，绝无 manifest 自由文本；schema 未过则 id 不出现在任何输出；
同一输入判定相等（纯）。

### 3.4 覆盖词汇注入扫描（G6）

键名闭集 42 项（`src/override-scan.ts:32`），按 lowercase 精确比较，覆盖
六类授权承载词：model/Profile、role/binding、permission 授予、budget/quota、
approval 控制面、prompt/env/argv 与未纳管扩展面（hooks/mcp/plugins/
subagents）。字符串值逐个过 `isBlocked`（gate 的
`argv.permission-skip-flags` 与 `argv.environment-gate-bypass` 注册表）。
深度 >8 或环结构本身判为检出（fail-closed：扫不动的 manifest 不是可加载
的 manifest）。

## 4. 可信来源分级与默认拒绝（G3）

| tier | 含义 | 清单钉（recordedDigest） | 加载 |
|---|---|---|---|
| `builtin` | 随产品分发的核心工具 | 可选（建议钉） | 可（仍受 kill switch / allowlist 约束） |
| `verified` | 维护者/用户显式核验过的来源 | **必须**（schema 强制，`manifest.ts:147`） | 可 |
| `untrusted` | 其余一切，**含清单缺席者** | — | 恒拒 |

三条强化：(a) 默认拒绝——`inventoryRecord: null` 即拒，没有「未列出但
无害」的推理；(b) verified 必须带摘要钉——升级信任的那一刻就钉死了具体
产物，调包在完整性步失败；(c) 双向一致——manifest 声明可以「低于」清单
（`trust-claim-mismatch` 仍拒，宁可错拒不可错放）。分级回答的是信任来源
问题，不豁免任何后续检查：scope allowlist、计量、审批对三个 tier 一视
同仁。

## 5. 禁用策略：kill switch 与已加载实例的处置（G4）

**已实现（契约层）**：全局 `killSwitchAll` / 按 id `killSwitchIds` 与清单
`disabled` 三入口；检查链位置在一切信任/scope 逻辑之前；判定纯函数无缓存
接受，宿主**逐次调用重估**是唯一正确接线方式——禁用生效后下一次调用即
`kill-switch` / `disabled`，测试钉住「先接受 → 加 kill switch → 拒」序列。

**仅设计（加载器职责，未实现）**：已加载实例的运行时处置——(a) 停止派发：
kill switch 置位后加载器对新调用直接以判定值拒绝，不再触达实例；(b) 在途
调用：以有界等待收回（复用 process-lab 的树终止纪律：身份三元组 +
`taskkill /T /F` 或平台等价，A26/A27 语义），不得依赖插件自愿退出；(c) 状态
落盘：禁用事实与时间戳进宿主运行记录，reconcile 可核对；(d) 无复活路径：
重启用必须走显式清单变更（人工），不存在「重试到启用」的循环。这些语义的
真实实现与验证属后续加载器任务，本包不做任何进程操作。

## 6. 威胁模型（每条攻击路径 → 缓解 → 残留风险）

| 攻击路径（对应验收） | 缓解（已实现并有测试） | 残留风险（移交后续任务） |
|---|---|---|
| 插件绕过角色单选绑定（A01）：manifest 携带 role/roles/roleid 重定义执行者 | 键名闭集扫描第 1 步拒绝（`override-field`）；schema 本无 role 字段；执行层绑定来自 Profile 体系，manifest 数据不参与 | 执行层接线质量（属 M1 既有面，非本包） |
| 插件注入 model/Profile 覆盖（A02 类推：schema/API/UI 三层） | manifest 面是新增一层：model/modelid/modeloverride/profile/profiles/profileid/profilerevision 等键名任意层级命中即拒；大小写不敏感；测试含嵌套与数组形态 | 真实加载器必须对「加载后 artifact 内部文本」另设防线——本包只管 manifest 面 |
| 注入「忽略策略」类文本改变授权（A16 类推：内容是数据不是指令） | `ignorepolicy`/`systemprompt` 键名拒绝；授权判定（信任/scope）只读清单与闭枚举，任何 manifest 文本不进入判定输入；事件结构上无文本字段 | memory/context 注入面由 M3 既有纪律承担（memory content is DATA）；本包不重复其机制，只是不为其开新口 |
| 插件额外发起绕过配额的执行（A35） | 词汇中不存在执行形 scope（exec.spawn/dag.propose 等测试钉死不存在）；`budgetMetered` 被 `z.literal(true)` 钉死；manifest 无 argv/env/hooks/mcp 字段——插件无法声明第二执行通道 | 真实加载器的进程/连接管理必须把每次调用接进 DAG 计量；CLI 自身隐式子 agent 的实测面（A35 M0 证据）属 fake-cli/budget 既有任务 |
| 绕过审批控制面（A17 类推） | manifest 无 approval/actionDigest 字段（键名闭集拒绝）；需要审批的 scope（repo.write）由绑定表声明 `approvalRequired: true`，审批语义仍由 `@role-orchestrator/approval` 独占，本包不旁路不重写（M7-01 同纪律） | 无新增（approval 生命周期由其包测试承担） |
| 供应链调包：同一 id 下替换产物 | 双完整性钉：产物 vs manifest digest + manifest digest vs 清单 recordedDigest（verified 必钉）；任何一钉不中即 `integrity-mismatch` | 分发渠道与传输完整性（签名）——§10 提案 |
| 自封 verified / 清单与 manifest 权限不一致 | `trust-claim-mismatch`：声明必须与清单 tier 相等；verified 缺钉连判定输入都不接受（抛宿主错误） | 清单自身的管理流程（谁有权升级 tier）属治理，见 §10 |
| 隐式加载绕过注册表（M0 实测：裸 CLI 自带 plugins/skills/agents） | 设计立场：未经本判定链的加载不存在合法形态；「clean baseline」是 gate 里的 blocked assumption | **本设计对真实 CLI 隐式加载无约束力**——禁用参数/机制在 M0 为 unverified（N2），需真实 smoke 窗口 |
| 审计/日志泄露（A42/A36） | 事件闭字段集；前置拒绝 id/version/digest 恒 null；错误与 detail 只含结构事实；扫描路径不回显值 | 无新增（通用脱敏由 cli-events A36 层承担） |

## 7. 已实现并有测试（本会话真实执行的证据）

新增文件：`packages/plugin-registry/`（src 7 模块：index/errors/scope/
manifest/override-scan/decision/events + test 4 套件 + helpers + README +
构建三件套）。对既有文件的唯一修改：
`packages/release-audit/test/repo-audit.test.ts:41-45`（workspacePackageCount
32→33，附注释，先例 M6-04/M7-01）与 `PROPOSALS.md`（只允许的追加披露）。
冻结面零接触（78 个记录文件未动；pnpm-lock.yaml 仅新增 importer 段）。

单包实测（本会话，真实退出码）：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install`（仓库根） | 0 | `Scope: all 33 workspace projects`；外部包仍 resolved 84 |
| `pnpm exec tsc -p tsconfig.json`（plugin-registry） | 0 | 全严格编译（含测试） |
| `pnpm exec vitest run`（plugin-registry） | 0 | **4 文件 51 测试全过**（manifest-schema 13 / load-decision 24 / override-scan 9 / audit-event 5） |
| `pnpm run build`（plugin-registry） | 0 | dist 14 个产物（7 模块 × js + d.ts，无 sourcemap，与 release-audit 同策略） |
| `pnpm exec vitest run`（release-audit，基线更新后） | 0 | 42/42：外部依赖仍恰 84、license 表不变、runtime 外部仍 ws/yaml/zod、workspacePackageCount=33 |

开发过程真实迭代记录：首跑 51 测试中 2 失败（测试自身预期错误：闭键集漏
`profileoverride` 变体；trust-mismatch 用例意外构成完全匹配），修正后
复跑 exit 0——实现无改动，仅补齐键集变体与用例构造（见 §12 偏离 3）。

测试要点（全部 hermetic：纯函数 + node:crypto 现算 sha256；无网络、无进程、
无真实插件、无磁盘加载）：

- **schema 严格性**（13）：未知顶层/嵌套字段、7 种非法 semver
  （`1.2`/`v1.2.3`/前导零/`-01`/四段/空串）、digest 大写/63/65/非 hex/
  sha512、重复 scope、越界 scope（`dag.propose`/`exec.spawn`/尾随空格）、
  空 scope 合法（最小权限地板）、非法 id、控制字符与双向覆盖符、entrypoint
  五种穿越形态、verified 缺钉、清单未知字段。
- **加载判定全分支**（24）：接受（builtin/verified + 绑定表 1:1 + 纯性）；
  默认拒绝（清单缺席）；untrusted；trust 声明不一致（升/降两个方向）；
  全局/按 id kill switch（含对合法 builtin 仍拒）；disabled；处置序列
  （先接受→加 kill switch→拒）；双完整性钉（产物漂移/清单钉漂移/双钉
  成立）；scope 超集拒/子集过/空 allowlist；override-field 先于 schema
  （model/profileId/role/permissions/budget/危险 flag 文本）；schema-invalid
  分支且 id 不外泄；宿主输入错误抛 `PluginDecisionInputError`；敌控输入
  全程不抛（拒绝是值）；scope 词汇不变量（恒等映射 + 控制引用 + 计量恒真
  + 执行形 scope 不存在）。
- **注入扫描**（9）：顶层/嵌套/数组/大小写命中与路径形态；`--dangerously-
  skip-permissions` 与 `danger-full-access` 值文本经 gate 委托检出；环安全；
  深度上限即检出；发现路径不回显敌控值；闭键集抽样。
- **审计事件**（5）：接受 1:1 投影；8 个拒绝理由 1:1 + 确定性；前置拒绝
  id/digest 恒 null；事件 schema 严格 + reason 闭枚举；序列化字节级断言
  不含 manifest 名称/描述/哨兵 token（A42/A16）。

全仓门禁（真实退出码，任务收尾回填）：见 §11。

## 8. 「已实现并有测试」vs「仅设计（未实现）」

| 项 | 状态 | 依据 |
|---|---|---|
| 版本化 manifest（semver/integrity/scope/trust，全 strict） | 已实现并有测试 | `src/manifest.ts`；manifest-schema 13 测试 |
| 加载决策纯函数（十步守卫链、八拒绝理由、默认拒绝） | 已实现并有测试 | `src/decision.ts:122-208`；load-decision 24 测试 |
| scope→既有检查映射（恒等权限 + gate 控制引用 + 计量钉死） | 已实现并有测试（数据面；enforcement 属执行层设计） | `src/scope.ts`；load-decision 词汇不变量 |
| 覆盖词汇注入扫描（键名闭集 + gate 值委托 + 环/深度安全） | 已实现并有测试 | `src/override-scan.ts`；override-scan 9 测试 |
| kill switch / disabled 先行 + 无缓存接受的重估语义 | 已实现并有测试（判定层） | `src/decision.ts:146-162`；kill-switch/disposal 用例 |
| 审计事件结构无文本（A42/A16） | 已实现并有测试 | `src/events.ts`；audit-event 5 测试 |
| 真实插件加载器（发现/校验加载/执行/卸载/在途收回） | **仅设计**（§5 处置语义；无一行实现） | N1、§9.1 |
| 已加载实例运行时拆除的有界等待/树终止接线 | **仅设计**（复用 process-lab 纪律的方案记录） | §5(b)、§9.1 |
| manifest 签名/分发渠道信任 | **仅设计留待后续**（v1 = sha256 钉 + 宿主清单） | N3、§10 |
| 对真实 claude/codex 插件生态的纳管与禁用 | **仅设计（未验证）**——M0 实测隐式加载存在，显式控制 unverified | N2、§9.2 |
| 宿主逐次重估的实际接线（调度器/执行层调用本判定） | **仅设计**（契约与测试就绪，接线属执行层任务） | §9.3 |

## 9. 不可本机验证项（unverified，含所需环境）

1. **真实加载器行为**：磁盘发现、加载失败路径、卸载/拆除、在途调用的有界
   收回——需要加载器实现任务；本任务红线禁止把设计写成实现。
2. **真实 CLI 插件生态约束**：claude/codex 是否存在产品可用的插件禁用参数、
   MCP 清单不可见时的替代防线——需要维护者授权的真实 smoke 窗口；本任务
   禁止真实调用（M0 `claude.implicit-loading.explicit-control` 恒 unverified，
   本设计未改变该状态）。
3. **端到端 A16/A35 全链路**：插件工具调用被逐次判定、计量进 DAG 预算、
   注入记忆/manifest 文本不改变绑定——需要调度器/执行层接线；本包按红线
   保持语义（不新增 fallback、不旁路审批），全链路属 M7 后续任务。
4. **签名与分发信任**：sha256 钉只能证明「与清单记录一致」，不能证明发布
   者身份；需要密码学签名设计与密钥治理（§10 提案）。

## 10. 待维护者确认 / 后续提案（不在本任务代行）

1. P-M7-02-A（提案）：插件加载器任务立项——以 `evaluatePluginLoad` 为唯一
   判定入口（逐次调用），实现发现/校验/执行/处置，并给 §5(b) 的拆除语义
   配真实测试；建议单列 M7/M8 批次。
2. P-M7-02-B（提案）：manifest 签名与发布者身份（signing ceremony、密钥
   保管、verified tier 的升级流程与审计记录）——需先有 ADR，不随本批次
   隐式扩权。
3. 真实 CLI 插件禁用机制的 smoke 窗口授权（§9.2 的唯一闭合路径）；在其
   之前，产品 UI/文档必须继续按「裸 CLI 非干净基线」表述（gate blocked
   assumption 既有立场）。

## 11. 门禁结果（真实退出码，收尾回填）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install` | 0 | `Scope: all 33 workspace projects`；外部包集合不变（resolved 84） |
| `pnpm typecheck`（全仓 turbo） | 0 | 55 tasks 全部成功（含新包；新包单包 `tsc -p tsconfig.json` 亦 0） |
| `pnpm test`（全仓 turbo） | 0 | 64 tasks 全部成功；复跑 `pnpm exec turbo run test --force`（强制全量真实执行，0 cached）亦 0，**vitest 合计 1441 通过 / 0 失败** = 基线 1390 + 新增 51（plugin-registry 51 = manifest-schema 13 + load-decision 24 + override-scan 9 + audit-event 5；release-audit 42 保持、scm-contracts 74 保持） |
| `pnpm build`（全仓 turbo） | 0 | 32 build tasks 全部成功（含 `@role-orchestrator/plugin-registry:build`） |
| `node planning-check.mjs` | 0 | part (a) `checksum verification OK: 78/78 files match`（.gitignore 行跳过）+ part (b) 干净副本 self-test exit 0（126 个本地 md 链接检查含本报告与新 README） |
| `sha256sum -c CHECKSUMS.sha256` | 1（预期） | 78 个 `: OK`；唯一 FAILED 为 `.gitignore`——任务允许的保留项，与 planning-check part (a) 一致 |

## 12. 偏离与风险

**偏离**

1. ask 建议参照 `packages/release-audit` 建包——已照做（package.json/
   tsconfig 三件套/vitest/engines node>=25/zod strict schema 风格），并按
   M7-01 先例依赖既有 workspace 包（contracts / capability-gate）。
2. ask 要求「manifest schema 含 trust 字段」——已实现，但语义定为**发布方
   声明**而非授权事实：授权只读宿主清单，声明不一致即拒。这是对「信任
   字段」唯一不放大的读法（若 trust 字段本身可自证授权，分级即失效）。
3. 开发迭代中修正两处**测试自身**预期（键集 `profileoverride` 变体补齐、
   trust-mismatch 用例重构造）；对实现行为的修正为零，对既有测试的改动
   仅红线允许的 release-audit 包计数（32→33）+ `PROPOSALS.md` 追加。
4. semver 校验本地实现（正则，严格 SemVer 2.0.0），不引入 `semver` 外部
   依赖——红线 5（release-audit 外部依赖计数断言保持 84，已实测）。

**风险**

1. 键名闭集与值扫描是当前威胁清单，不是完备证明：换一种拼写的覆盖键
   （如未被列入的同义词）不会被键名扫描捕获——但 schema strictness 仍会以
   `schema-invalid` 拒绝它（manifest 无透传字段），防线是双层的，`override-
   field` 只是更响亮的信号。闭集演进随评审进行（单文件，可见）。
2. 「逐次重估」依赖宿主正确接线：契约无法强制加载器每调用重估；加载器
   任务必须把该义务写进其测试（§10.1 已含）。
3. `budgetMetered` 钉在本包只是声明面：真实计量在执行层（budget 包）；
   若未来 DAG 预算语义变化（如按 token 计量），本包 scope 绑定表需同步
   评审——有意的摩擦，防止计量面静默变化。
4. 空 scope 插件合法（最小权限地板）意味着「无能力插件」可加载并可被
   审计；若产品要求更严（无 scope 即拒），是 schema `min(1)` 的一行变更
   + 评审，当前选择以最小权限原则为准。
