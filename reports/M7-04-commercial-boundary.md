# M7-04 · 冻结独立团队商业版接口边界（开源核心 vs 团队控制平面的产品化边界）

状态：已完成（**仅设计与边界审计机制，无任何商业版代码**——本仓库不存在
商业版实现、商业许可证文本或商业依赖；真实仓库审计通过是**机制验证**
（审计机器工作、当前无可发现之物），**不是存在性验证**，见 §0 与
`packages/boundary-audit/src/statements.ts:59` DESIGN_ONLY_DISCLOSURE）。
角色：architect（Developer 授权执行）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md:242`（验收 A01/A02）与 §M7-04（`docs/BACKLOG.md:256-258`：
「团队控制平面单独产品化，不改变开源本地功能与单选绑定」「商业依赖不进入
开源核心启动/构建路径；条款经发布前核查」）。
授权依据：`reports/M6-05-release-candidate.md` §8（维护者 2026-09-24 批准，
解除 M7-01..04 对 M6-05 的依赖）。
只读引用：冻结文件 `docs/adr/009-open-core-and-license.md`（本任务**零触碰**，
复跑核对见 §8；该 ADR 的「商业边界已确认」即本文档的规范来源）。
交付物：本文档 + 新包 `packages/boundary-audit`（第 35 个 workspace project；
基线更新披露见 `PROPOSALS.md` M7-04 节）。

## 0. 诚实声明（先行）

本文档区分两类事实，风格沿用 `reports/M7-03-remote-worker.md`：

- **已实现并有测试**（§6 真实命令与退出码）：`packages/boundary-audit` 的
  边界审计器——读取 workspace 各 `package.json`、按 R1–R5 规则产生违规
  数据、对自身 fixture 树（含故意违规样例）全分支测试 26/26、对真实仓库
  实跑一次 verdict=pass。全部 hermetic（OS 临时目录 fixture 树，零网络、
  零 git、零真实 CLI 调用）。
- **仅设计（未实现）**：商业版本身的**任何**代码、许可证文本、安装包或
  控制面服务——本任务不产出、也不允许产出；§4 的 A01/A02 商业控制面
  声明是对**未来**商业实现的数据级约束（导出常量 + 测试钉死），不是存在
  证据；§5 发布前核查清单是**维护者待办**，本任务不代行其中任何一项决定
  （`release-audit` 的 pending 项原样保留并复测为 pending）。

## 1. 背景与问题

冻结 ADR 009（`docs/adr/009-open-core-and-license.md`，2026-09-21，
Partially accepted）已确认：**完整本地核心开源；团队治理/协作/托管独立
发布；许可候选发布前确认**；其「未采用方案」明确否决两件事——按角色/本地
DAG 收费锁，以及**商业服务作为核心运行依赖**。其「后果」同样钉住两条：
保留核心功能与安全审计；**不能假定对全部贡献拥有重许可权、不能共享个人
订阅**。BACKLOG M7-04 要求把这个产品化决策变成**可执行的边界**：团队控制
平面单独产品化，不改变开源本地功能与单选绑定。

当前仓库里还没有一行商业代码，所以真正的交付物是「冻结」：把边界表达为
**数据 + 审计规则**，使未来任何一笔让商业依赖进入开源核心启动/构建路径的
改动在 `pnpm test` / 审计 CLI 上直接变红，而不是靠评审记忆。同时按 ADR
要求把「发布前条款核查」落成清单，联动 `release-audit` 已有的 pending
项（不代行维护者决定）。

## 2. 产品化边界（开源核心 vs 团队控制平面）

按 ADR 009 逐句落位（表中的「本仓现状」是已实现事实；「商业面」是仅设计
的定位声明，无对应代码）：

| 能力域 | 侧别 | 本仓现状（开源核心） | 商业团队控制平面（仅设计定位） |
|---|---|---|---|
| 编排引擎/DAG/调度/扩展 | 开源核心 | `dag`/`engine`/`scheduler`/`expand` 已实现并有测试 | 同一核心，无 fork |
| 角色绑定与模型解析（A01/A02） | 开源核心 | `runtime-profile`/`dag`/`contracts` 已实现并有测试 | **消费**同一权威，禁止另起路径（§4） |
| 本地状态/审批/能力门/预算 | 开源核心 | `store`/`approval`/`capability-gate`/`budget` 已实现并有测试 | 同上；商业面可增加审批**入口**，不得削弱审批语义（A17/A35 语义保持） |
| CLI 适配/本地 web/记忆 | 开源核心 | `fake-cli`/`context`/`memory`/`memory-search`/`cli-events`/`local-api` 等 | 不变 |
| 受控扩展点（M7-01/02/03 契约） | 开源核心 | `scm-contracts`/`plugin-registry`/`remote-worker`（全部 fail-closed、仅设计） | 商业托管可作为这些契约的**实现方**，实现方仍受同一边界审计 |
| 团队治理/协作/托管 | **商业面** | **无代码** | 多人策略分发、托管审批台、集中审计归档、计费/席位等——独立发布物 |
| 收费锁/许可校验组件 | **禁入**（ADR 未采用方案） | 无 | **不得**以任何形式进入核心启动/构建路径；核心不探测自身是否「已付费」 |

两条不变量（本文档与审计器共同钉住）：

1. **依赖方向单向**：商业面 → 开源核心允许；开源核心 → 商业面禁止
   （R1/R1b，§3）。
2. **核心可独立启动/构建**：删除全部 `commercial: true` 包后，开源核心的
   install/typecheck/test/build 必须原样成立——这正是「商业依赖不进入开源
   核心启动/构建路径」的可检验形式（R2/R3 保证核心自身的外部依赖与图形状
   也不被商业间接绑架）。

## 3. 依赖方向规则与边界审计器（已实现并有测试）

`packages/boundary-audit`（结构照抄 release-audit：package.json 三脚本、
tsconfig×2、vitest、zod strict 输入 schema、typed errors、CLI bin）。
入口 `auditCommercialBoundary`（`src/audit.ts:137`）读 `packages/*/package.json`
（严格说：packages 目录下每个含可解析 package.json 的子目录），违规一律是
**结果数据**（`BoundaryViolation[]`），不是异常；`verdict: "pass"|"fail"`。

### 3.1 核心包清单（closed manifest）

`OPEN_CORE_PACKAGE_MANIFEST`（`src/core-manifest.ts:16`）是**闭清单**：34 个
`@role-orchestrator/*` 名字（M7-03 为止的 33 个包 + 审计器自身），sorted、
unique、全部带 scope（测试钉住）。清单与树的差集**本身就是发现**：

- R4a `core-manifest-drift`：树中非商业包不在清单上 → 违规。新包必须显式
  进清单（或标记 commercial），边界**不能悄悄移动**——与 release-audit
  钉包数同一哲学，且粒度到「哪个包」。
- R4b `core-manifest-contradiction`：商业包出现在清单上 → 违规。

### 3.2 commercial 标记机制

一个 workspace 包加入商业面的**唯一**方式：自身 `package.json` 顶层字段
`"commercial": true`（`COMMERCIAL_MARKER_FIELD`，`src/core-manifest.ts:73`）。
没有第二种机制，且解析是 fail-closed **朝审查方向**（`src/manifest.ts`）：

- 字段非布尔（如字符串 `"true"`）→ 记 `malformed-commercial-marker`，
  该包**继续按开源核心接受全部核心规则**（R1/R2/清单成员检查照跑）——
  畸形标记只会招来更多审查，永不豁免（fixture 测试同时断言 anomaly 与
  其外部依赖违规两个发现）。
- 任何其他 `/commercial/i` 键（如 `isCommercial`）→ 记 anomaly，别名永不
  生效。

### 3.3 规则表（违规即审计失败：violations 非空 ⇒ verdict=fail ⇒ CLI exit 1）

| 规则 | 语义 | 依据 |
|---|---|---|
| R1 `commercial-dep-in-core` | 核心包 `dependencies`（启动/运行路径）含商业 workspace 包 | ask 规则 1a；ADR 009 未采用方案 |
| R1b `commercial-devdep-in-core` | 核心包 `devDependencies`（构建路径）含商业包——turbo `build` `dependsOn: ["^build"]`（`turbo.json`）沿依赖+devDependencies 图展开，pnpm 亦把 devDeps 链入安装 | ask 边界句「启动/**构建**路径」的加强 |
| R2 `external-dep-outside-allowlist` | 核心包 `dependencies` 引入 allowlist（`CORE_EXTERNAL_RUNTIME_ALLOWLIST` = `ws`/`yaml`/`zod`，`src/core-manifest.ts:64`——与真实树逐包核对一致，亦被 release-audit 的 runtime externals 断言独立钉住，`packages/release-audit/test/repo-audit.test.ts:81`）之外的外部运行时依赖 | ask 规则 1b；devDependencies 工具链（typescript/vitest/@types/node）不在本规则范围，lockfile 完整性/许可证仍归 release-audit |
| R3 `workspace-dependency-cycle` | workspace 运行时依赖图（dependencies 边）成环，环经旋转归一并去重（`findRuntimeCycles`，`src/audit.ts:101`） | 无环是方向规则可静态判定的前提；含商业包的环必然同时触发 R1 |
| R4a/R4b/R4c | 清单漂移 / 清单矛盾 / 畸形标记（§3.1–3.2） | 清单不许静默过期 |
| R5 `dangling-workspace-dep` | `workspace:` 式引用（或解析为 workspace 包名的依赖）指向不存在的包 | 防拼写漏洞把商业包变成幽灵依赖 |

商业包自身的依赖**不在**核心规则范围内（R1/R1b/R2 只扫核心包）——商业面
允许依赖核心与自己的外部依赖；其外部依赖的完整性/许可证仍由 release-audit
的全仓 lockfile 审计覆盖，且新增外部依赖会立刻踩中 release-audit 的
84-count/coverage 断言（见 §5 清单第 6 项）。

### 3.4 真实仓库实跑（机制验证，非存在性验证）

命令（于 `packages/boundary-audit`，先 `pnpm run build`）：
`node dist/cli.js <仓库根>`。实测退出码 **0**：

```
verdict: pass
workspacePackageCount: 34        # 33 个既有包 + 审计器自身
commercialPackages: []
violations: 0
runtimeWorkspaceEdges: 178       # 运行时 workspace 依赖边，无环
corePackagesUsed: 34             # 与内置清单逐一吻合（零漂移）
externalAllowlistUsed: ["ws","yaml","zod"]
```

**如实声明**：本仓库当前没有任何 `commercial: true` 包，R1/R1b/R4b 在真实
树上从未有真实目标可抓——「通过」证明的是**机制在工作**（清单吻合、
178 条边无环、外部依赖全在 allowlist、畸形标记无），不证明「商业依赖从未
侵入」这一存在命题。抓违规的能力由 fixture 证明：§6 的规则分支测试含故意
违规样例（R1 商业依赖、R1b dev 依赖、R2 allowlist 外依赖、R3 双节点环与
自环、R4a/b/c、R5），全部真实抓到。真实运行通过同时被 CLI 契约测试覆盖
（fixture 树 exit 0/1/2 三分支）。

真实仓库审计**有意不做成 pinned 测试**：若钉进 `pnpm test`，此后每个新包
都要再改一处基线——per-package-Add 的「被注意到」义务已由 release-audit
计数断言 + PROPOSALS 披露协议承担，本包不制造第二个漂移点（README 同文
声明）。操作者可随时用上述命令复跑。

## 4. A01/A02 在商业控制面同样成立（声明，钉为数据）

三条导出常量（`src/statements.ts`），逐字被 `test/audit.test.ts` 钉死，
改一句都要过评审；`auditCommercialBoundary` 的**每一个**返回结果都携带
boundary statement 与 design-only disclosure（数据与声明不可分离）。

- **A01**（`A01_COMMERCIAL_STATEMENT`，`src/statements.ts:32`）：单选绑定
  在商业控制面原样成立——任何角色（含未来商业面暴露的角色）经**同一**
  开源权威绑定到恰好一个 Profile：`packages/runtime-profile` 的
  `resolveRoleBinding` + `packages/dag/src/roles.ts:11`（计划期角色解析，
  五种拒绝 missing/unbound/multiple/unknown-profile/unknown-revision 在
  启动前完成，`roles.ts:49`）；运行冻结快照语义（A34）不变。商业面
  **不得**提供替代的 Profile 选择路径、第二绑定权威、或任何让一个角色绑
  零个/多个 Profile 的方式。
- **A02**（`A02_COMMERCIAL_STATEMENT`，`src/statements.ts:46`）：覆盖拒绝
  在商业控制面原样成立——Node/Task/Workflow 级注入 model/Profile 字段在
  三层被拒（冻结契约 schema；API 严格 parse——`packages/dag/src/graph.ts:26-28`
  「strict, so model/profile override fields and unknown keys are rejected
  at parse time (A02)」；UI 层），且运行时深扫守卫
  `packages/runtime-profile/src/no-override.ts:5-16`
  （`FORBIDDEN_OVERRIDE_KEYS` 闭词表 + `NodeOverrideRejectedError`）同样
  适用于商业控制面输入。商业扩展**永不**放松、别名化或绕过该守卫；商业包
  不得向任何表面添加禁止的 override 键。
- 验收原文锚点：`docs/ACCEPTANCE.md:8-9`（A01「缺失/多个/未知 Profile 均
  在启动前拒绝」、A02「schema/API/UI 三层均拒绝」）。

**状态如实标注**：以上是**设计约束声明**（本任务红线要求交付的「声明」），
其在本仓的强制性由（a）测试钉死语句本身、（b）审计器的 R1/R1b/R4 家族
保证商业包只能作为被审计的依赖进入核心图、（c）既有 A01/A02 测试
（`packages/dag/test/roles.test.ts` 等）继续全绿共同承载。**商业面上的
实际强制**（商业代码真实消费这些守卫）无实现、无测试——见 §7。

## 5. 许可条款发布前核查清单（维护者待办；本任务不代行任何一项）

联动 `packages/release-audit/test/repo-audit.test.ts` 钉住的 pending 项
（release-audit 42/42 复跑全绿，以下 pending 状态原样保留）。清单是 ADR
009「验证与重新评估」节的展开；**每一项都需要维护者决定，自动化只提供
证据**：

| # | 核查项 | 当前证据（release-audit 钉住） | 联动机制 |
|---|---|---|---|
| 1 | 正式 LICENSE 放置（候选文本与 canonical Apache-2.0 逐字一致、字节不同） | `checkLicenseCandidate`: status `candidate-matches-canonical`、`formalization: pending-maintainer-confirmation`、`formalLicenseExists: false`（repo-audit.test.ts:90-99） | 翻转须维护者动作；审计不提供「许可已定」信号 |
| 2 | 版权主体/重许可权边界确认（ADR 后果：不能假定对全部贡献拥有重许可权） | 同上 pending | 商业版条款起草的前置 |
| 3 | 商业版许可条款单独核查（团队控制平面的发布条款、供应商使用条款——ADR 验证节明列） | 无对应自动化；仅本文档登记 | 商业依赖若引入，触发第 6 项 |
| 4 | 安全渠道配置（private channel） | `inventoryGovernance.privateChannel.status: not-configured-documented`（repo-audit.test.ts:106-108） | 翻转须维护者配置 |
| 5 | CODEOWNERS 实名化与 release approval | `codeowners.status: placeholder-only`、`releaseApproval.status: pending-maintainer`、`maintainerIdentityRecorded: false`（repo-audit.test.ts:103-111） | 候选 SHA 冻结与签署（M6-05 §8.3）仍属未来发布动作 |
| 6 | 外部依赖台账：notices 覆盖与新增依赖纪律 | `noticesCovered: []`、`noticesUncovered: 84`、runtime externals 恰 ws/yaml/zod（repo-audit.test.ts:79-88） | **任何**新外部依赖（含未来商业包引入的）都会踩红 release-audit 的 84-count/coverage 断言 → 强制走披露 + license 审查；boundary-audit R2 则守核心侧 allowlist |
| 7 | 冻结面完好 | 本任务收尾复测：78/78 OK（唯一 FAILED=.gitignore，任务允许保留项） | 每次交付门禁复跑 |

明确**不**由本任务代行：放置 LICENSE、替换 CODEOWNERS、启用渠道、身份
登记、对外发布（M6-05 §8.3 未授权清单原样引用）。boundary-audit 不输出
任何「license ready」语义——`verdict` 只表达依赖方向边界，不表达条款状态。

## 6. 已实现并有测试（本会话真实执行的证据）

新增文件：`packages/boundary-audit/`（src 7 模块：errors/statements/
core-manifest/manifest/audit/cli/index；test 2 套件 + helpers；README +
构建三件套）。对既有文件的修改仅两处披露性改动（§8）。

单包实测（真实退出码）：

| 命令（于 packages/boundary-audit，除注明外） | 退出码 | 结果 |
|---|---|---|
| `pnpm install`（仓库根） | 0 | `Scope: all 35 workspace projects`；`resolved 84`（外部依赖集合不变） |
| `pnpm exec tsc -p tsconfig.json` | 0 | 全仓严格编译 |
| `pnpm exec vitest run` | 0 | **2 文件 26 测试全过**（audit 21：规则分支/输入校验/清单与语句钉死；cli 5：exit 0/1/2 契约） |
| `pnpm run build` | 0 | dist 14 产物（tsc declaration） |
| `node dist/cli.js <仓库根>`（真实仓库审计） | 0 | §3.4：verdict pass、34 包、0 违规、178 边 |

测试要点（全部 hermetic——OS 临时目录 fixture 树，零网络/零 git/零真实
CLI 调用）：**三个 ask 点名 fixture 全部在列并真实抓到**——商业依赖违规
fixture（R1，`commercial-dep-in-core`）、allowlist 外外部依赖 fixture（R2，
`external-dep-outside-allowlist`，且 allowlist 内的 zod 阴性不误报）、循环
依赖 fixture（R3：双节点环归一化为最小起点报告一次 + 自环退化用例 +
diamond 无环阴性）；另覆盖 R1b/R4a/R4b/R4c/R5、畸形标记 fail-closed 朝
审查（anomaly + 核心规则照跑双发现）、商业包外部依赖不受 R2 约束的定向
不对称、stray 目录跳过、两次运行序列化逐字节一致（确定性）、strict 输入
schema 拒未知字段、坏 JSON/无名包 ManifestParseError、缺根/缺 packages 目录
AuditTargetMissingError、内置清单闭性（sorted/unique/scoped/含审计器自身）、
A01/A02/design-only 语句逐字钉死。

## 7. 「已实现并有测试」vs「仅设计（未实现）」

| 项 | 状态 | 依据 |
|---|---|---|
| 边界审计器 R1–R5 与 CLI 契约 | 已实现并有测试（fixture 全分支） | §6 |
| 真实仓库审计通过 | 已执行，**机制验证非存在性验证** | §3.4 |
| 核心包清单 + commercial 标记机制 | 已实现并有测试（fixture 演练；真实树上无商业包可解析） | §3.1–3.2 |
| A01/A02 商业控制面声明 | **仅设计声明**（数据级钉死；商业面真实强制无实现） | §4、`src/statements.ts` |
| 商业版任何代码/许可证/安装包 | **不存在**（本任务红线禁止） | §0 |
| 发布前条款清单各待办 | **仅设计登记**（维护者 pending 原样保留） | §5 |

## 8. 基线更新与披露（红线允许的既有文件改动）

1. `packages/release-audit/test/repo-audit.test.ts:41-45`：
   `workspacePackageCount` 断言 **34 → 35**（本包为第 35 个 workspace
   project；ask 所记「31 包」基线经 M7-01/M7-02/M7-03 三次披露已演进为
   34，见 `PROPOSALS.md` 相应节），附注释；该用例其余断言零改动（外部依赖
   恰 84、license 表、runtime 外部 ws/yaml/zod 全部保持——复跑 42/42
   实测）。修改前先跑出基线事实：原断言 34 通过（42/42）。
2. `PROPOSALS.md`：文末追加「M7-04 披露」一节（只追加，未动既有内容）。
3. 冻结面零接触：`docs/`（含只读引用的 `docs/adr/009`）、`schemas/`、
   `config/`、`prompts/`、`project/`、`contracts/`、`tools/`、`scripts/`、
   `.github/` 未修改未新增；`CHECKSUMS.sha256` 记录的 78 文件未触碰
   （复跑见 §9）。

## 9. 门禁结果（真实退出码，收尾回填）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install`（仓库根） | 0 | `Scope: all 35 workspace projects`；`resolved 84`（外部包集合不变，`pnpm-lock.yaml` 仅新增 importer 段） |
| `pnpm typecheck`（全仓 turbo） | 0 | 57 tasks 全部成功（Cached 57，含新包） |
| `pnpm test`（全仓 turbo） | 0 | 68 tasks 全部成功（Cached 62） |
| `pnpm exec turbo run test --force`（强制全量真实执行，0 cached） | 0 | 68 tasks 全部成功；**vitest 合计 1503 通过 / 0 失败** = 基线 1477（M7-03 终态）+ 新增 26（boundary-audit：audit 21 + cli 5）；release-audit 42 保持 |
| `pnpm build`（全仓 turbo） | 0 | 34 build tasks 全部成功（含 `@role-orchestrator/boundary-audit:build`） |
| `node planning-check.mjs` | 0 | part (a) checksum 78/78 OK（.gitignore 行跳过）+ part (b) 干净副本 self-test exit 0 |
| `sha256sum -c CHECKSUMS.sha256` | 1（预期） | 78 个 `: OK`；唯一 FAILED 为 `.gitignore`——任务允许的保留项，与 planning-check part (a) 一致 |

如实记录的中间失败（均已修复，未触碰任何既有包）：开发迭代中
(a) `audit.ts` 头注释含 `packages/*/package.json`，注释内 `*/` 提前闭合
块注释导致整文件解析错（改为不含 `*/` 的措辞）；(b) 一处 arrow 函数
`: void` 简写体返回 number 的严格编译错、测试漏 `node:path` import；
(c) 首轮 vitest 3 失败——CLI fixture 用了不在内置清单上的核心包名
（触发设计内的 `core-manifest-drift`，改为取清单真名）与 R4c 断言取错同包
多发现中的第一条（改为按 rule+package 定位）；(d) CLI 首版会把 `--json`
当 repoRoot 路径解析，改为显式拒 flag（usage error，exit 2）并补契约测试。

## 10. 偏离与风险

**偏离**

1. ask 建议参照 `packages/release-audit` 建包——已照做（三脚本/two
   tsconfig/vitest/engines node>=25/zod strict 输入/typed errors/CLI bin/
   README），未依赖任何 workspace 包（本审计器必须零 workspace 依赖才能
   审计它们——自我审计含在清单中，外部依赖仅 zod）。
2. ask 基线数字与仓库实际不一致：ask 记「31 包 / 1316 测试」，仓库实际
   （M7-03 后）为 34 workspace project / 1477 测试（`repo-audit.test.ts`
   原断言 34、`PROPOSALS.md` M7-01/02/03 披露节为证）。按红线 6「真实新
   计数」原则更新为 35 并追加披露，未回退任何既有披露。
3. R1b（核心 devDependencies → 商业包也算违规）是对 ask 规则字面
   （`dependencies`）的**加强**而非偏离：ask 的边界句本身含「构建路径」，
   turbo `^build` 沿 devDeps 展开（§3.3），不加这条则构建路径侧无守卫；
   R3 按运行时边计算（deps+devDeps 全图无环已另行实测核实，真实树两图
   均无环），R1b 已从方向上覆盖 dev 侧商业侵入。
4. 真实仓库审计做成 CLI 实跑 + 报告记录，而非 pinned 测试（§3.4 末段理
   由）；「机制验证非存在性验证」的限定同时写进导出数据
   （`DESIGN_ONLY_DISCLOSURE`）、README 与本 §3.4，任何审计输出的消费者
   都会看到。

**风险**

1. **清单维护摩擦是特性也是风险**：新包必须显式进 `OPEN_CORE_PACKAGE_MANIFEST`
   （否则 R4a 红）。这保证边界移动必被评审看见，但若维护者机械地把未来
   商业包「顺手」加进清单而非打标记，R4b 只在包已带标记时才红——「未标记
   的商业意图包」任何机制都识别不了，只能靠评审与本 §2 的定位表约束。
2. **标记可被删**：商业包删除 `"commercial": true` 即变回「未listed 核心」
   → R4a 立即红（进不了核心清单），不会静默洗白为合法核心——该路径是
   封死的；真正的残余风险在**评审纪律**而非机制。
3. **R2 allowlist 是快照**：ws/yaml/zod 与真实树及 release-audit 断言三方
   一致（2026-09-24）；核心引入新的合法外部依赖需同步改 allowlist +
   release-audit 披露 + license 审查（§5 第 6 项），三处不同步会以某处红
   收场（设计如此，但要对「红 = 流程问题而非代码问题」有心理预期）。
4. **A01/A02 声明的强制性边界**（§4 末段）：在本仓内是数据 + 测试 + 审计
   三层承载；商业面作为独立发布物落地时，其仓库不受本仓测试约束——届时
   必须以「依赖开源核心权威包」为硬条款写进商业版设计与集成验收，本文档
   的声明是该条款的源头，不是替代品。
