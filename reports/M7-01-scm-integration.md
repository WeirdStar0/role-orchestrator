# M7-01 · 设计 GitHub/GitLab 受控集成（SCMProvider 读写分离 + A17 审批绑定 + A42 凭据纪律）

状态：已完成（**仅设计与契约实现，未接真实 GitHub/GitLab**——本包与设计中的
任何部分都未发起过真实网络调用，见 §8「已实现/仅设计」边界与 §9）。
角色：architect（Developer 授权执行）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M7-01（验收 A17/A42）；完成标准「PR/MR/CI 接口不
泄露凭据，远程写必须明确授权」。
交付物：本文档 + 新包 `packages/scm-contracts`（第 32 个 workspace 包，基线
更新披露见 `PROPOSALS.md` M7-01 节）。

**诚实声明（先行）**：本文档区分两类事实——「已实现并有测试」（本会话真实
执行的命令与退出码见 §7）与「仅设计（未实现/未验证）」（§9 逐项列出）。GitHub/
GitLab 的真实 REST/GraphQL 行为、token scope 的真实约束、真实凭据隔离均
**未验证**；兼容矩阵中的全部 verification 单元在 schema 层面被钉死为
`unverified`，因此本设计交付时远程 SCM 面**整体不可用（fail-closed OFF）**，
这是有意为之的合规姿态，不是未完成状态。

## 0. 背景与问题

产品以本地为主（Local Trusted，M6-05 维护者批准基线），但三类真实需求都要碰
远程 SCM：读取 CI 结论与 PR 状态以推进 DAG 判定；把受控产出（集成候选、评审
结论）写回远程（评论、开 PR/MR）；以及未来团队版的远端协作。远程 SCM 与既有
本地 git 边界（worktree/integration/reconcile）有三点本质不同：

1. **凭据形态**：本地 git 信任本机配置；远程 API 需要长期 token，一旦进入
   日志/事件/manifest/导出即泄露（A42：发布包不含 auth、API key、原始用户
   transcript——同一纪律必须约束运行时数据面）。
2. **写的作用域**：本地写被 worktree/task-branch/writeScope 词汇约束；远程写
   落在所有受控本地范围之外，是典型的「外部副作用」（docs/SECURITY_MODEL.md
   高风险类），必须走用户审批，且审批必须绑定**唯一精确的写动作**——A17 的
   类推场景：批准后改了目标 PR/SHA/内容，原审批必须不可消费。
3. **输入不可信**：issue 标题、分支名、PR 正文都是仓库控制的内容，可能携带
   控制字符、Trojan-Source 双向覆盖符或注入形态的 URL；provider 回显同样
   不可信。

M7-01 的范围是**设计 + 契约层实现**：统一 SCMProvider 接口、读写权限分离、
审批绑定与凭据纪律的可执行契约与 hermetic 测试。真实协议 adapter 属后续
独立验证任务（§10）。

## 1. 目标 / 非目标

**目标**

- G1 统一 `SCMProvider` 面：只读操作（listIssues / listPullRequests /
  listChecks / listStatuses）与受控写操作（createIssueComment /
  createPullRequest / updatePullRequestText）一套词汇、双 provider（github /
  gitlab）。
- G2 读写权限分离是**型别与运行时双重事实**：只读 client 的型别与依赖类型上
  不存在任何写方法（编译期断言，违反即构建失败）；运行时写调用缺 ApprovalRef
  抛专用错误 `ScmApprovalRequiredError`，且该检查先于一切校验与验证门。
- G3 远程写复用 `@role-orchestrator/approval` 的 `actionDigest` 单次消费语义
  （A17 类推）：写命令完整映射为 `ActionDescriptor`，审批后改变目标
  PR/issue/SHA/内容/绑定（runtime、profileRevision、worktree、baseSha、
  权限增量）任何一个元素，原审批不可消费；消费走真实 guarded CAS
  （`consumeApproval`），单次性、过期、状态、digest 全部由 approval 生命周期
  强制，本包不旁路、不重写。
- G4 凭据只经 `credentialRef` 引用（env 变量名 / keyring 条目 / 文件路径），
  任何 schema 字段拒绝明文 token 形态；审计事件 schema 结构性无凭据字段；
  收据只带内容 sha256 不带内容；深度脱敏器作为纵深防御（A42）。
- G5 token scope 最小化 + 按 provider 的兼容矩阵骨架，全部单元诚实标
  `unverified`。
- G6 恶意输入 fail-closed：未知字段拒绝、意外枚举拒绝、超长拒绝、控制字符与
  双向覆盖符（Trojan-Source）拒绝、base-url 的 SSRF 式注入拒绝。

**非目标（本期明确不做）**

- N1 真实网络 adapter（HTTP/GitQL 客户端、分页、限流、重试）——后续任务，
  且必须先有真实验证证据。
- N2 merge/close/delete 类写操作：合并进默认分支需要 main-branch-delivery
  风险维度映射，删除需要 delete 维度映射，各有独立审批语义；本期写操作枚举
  刻意不含它们（闭枚举，新增即 schema 变更，见 §3.1）。
- N3 正文文本的读取与下发管线（v1 读模型刻意不含 body 字段——不建模是最强的
  脱敏）。
- N4 团队版/多租户（M7-04 边界）、容器/Remote Worker（M7-03）。

## 2. 方案总览（ADR 决策记录）

- **D1 读写分离放在类型系统里，不在文档里**。`ScmReadOnlyClient` 接口与其
  依赖 `ScmReadTransport` 接口都只有 4 个读方法；`ScmControlledWriteClient`
  恰有 3 个写方法。两条编译期断言
  （`WriteMethodsAbsentFromReadOnlySurface`、`WriteMethodsPresentOnWriteClient`，
  `packages/scm-contracts/src/clients.ts:167-176`）使漂移直接构建失败；
  运行时 `assertNoWriteCapability` 走 own+prototype 属性名复查
  （`clients.ts:261-275`）。transport 拆成读写两个接口还有一个结构性收益：
  只读 client 的**依赖类型上**根本没有写方法，误用不可能成立。
- **D2 ApprovalRef 是独立方法参数，不是请求字段**。写方法签名是
  `(command, approvalRef)`：类型化调用方漏传是编译错误；非类型化调用方
  （JS、序列化重建）漏传/传 null 命中守卫链第 1 步的专用错误
  `ScmApprovalRequiredError`（`clients.ts:503-512`）。命令 schema 里没有
  approval 字段，无法把授权伪装成数据。
- **D3 复用而非重造审批语义**。`scmWriteActionDescriptor` 把写命令确定性映射
  为 approval 的 `ActionDescriptor` 并经 `ActionDescriptorSchema.parse` 验证
  （`write-binding.ts:79-125`）；digest 就是 approval 的 `actionDigest`；消费
  由宿主接线的 `consumeApproval` 完成（guarded CAS：`status='APPROVED' AND
  action_digest=? AND expires_at>?`，`packages/approval/src/lifecycle.ts:502-524`）。
  approval 的类型化失败（Unknown / State / Expired / AlreadyConsumed /
  DigestMismatch）原样穿透写 client，不包一层丢失类型。
- **D4 凭据两个形态，均无秘密**（A42）。`ScmCredentialRef` = 引用（env 变量
  名 / keyring service+account / 文件路径），任何字段命中已知 token 形态即
  拒绝（`credential.ts:140-166`）；`ResolvedCredentialHandle` = 不透明句柄
  （provider + 非秘密审计 label），真实 token 只在宿主侧解析器、在本包 seam
  （transport 实现）之外附加到请求上（`credential.ts:179-231`）。
- **D5 兼容矩阵把「未验证」钉进 schema**。出货 cell 的 verification 是
  `z.literal("unverified") + evidence: z.null()`（`capability.ts:108-111`）——
  数据层面表达不了「已验证」，冒充已验证必须改代码走评审。验证查找
  （`ScmVerificationLookup`）是唯一注入缝：默认实现读矩阵（恒 unverified），
  未来集成任务以代码变更+证据翻转单元；测试注入 verified 以演练全流程。
- **D6 消费先于传输**。写 client 的顺序是 digest 匹配 → 消费（CAS 是授权
  提交点）→ transport 调用（`clients.ts:587-622`）。消费后 transport 失败 =
  审批已消耗且什么都没写，重试需要新审批——与 A22「结果未知不自动重跑」同
  纪律，本包不做任何自动重试。
- **D7 读写两面的验证门都在构造期**。默认矩阵下 client 构造即抛
  `ScmProviderNotVerifiedError`（`clients.ts:294-299`），方法内另有每次调用的
  复查（防自定义查找随时间变化）。测试钉住：默认矩阵下读/写 client 一个都
  构造不出来。

## 3. 接口与不变量

### 3.1 闭枚举（新增 = schema 变更，走评审）

| 词汇 | 值 | 位置 |
|---|---|---|
| provider | `github` \| `gitlab` | `capability.ts:24` |
| 读操作 | `listIssues` `listPullRequests` `listChecks` `listStatuses` | `capability.ts:27` |
| 写操作 | `createIssueComment` `createPullRequest` `updatePullRequestText` | `capability.ts:33` |
| 拒绝码 | `approval-required` … `invariant-violation`（13 个，与错误类型 1:1） | `events.ts:26-40` |
| 风险维度 | 复用 approval 闭枚举（network / external-side-effect / write…） | `packages/approval/src/risk.ts:50` |

### 3.2 写 client 守卫链（顺序即契约）

`clients.ts:500-631`，每一步都有对应测试（§7）：

1. ApprovalRef 在场 → 否则 `ScmApprovalRequiredError`（专用、绝对，先于一切）；
2. ApprovalRef 形态（严格 schema，digest 64 位小写 hex）；
3. provider 写面在验证查找中为 verified（默认矩阵：恒拒）；
4. 操作在能力声明 `writes` 中（`ScmOperationNotDeclaredError`）；
5. 命令严格 schema（未知字段/恶意输入在此拒绝）；
6. digest 绑定：`actionDigest(映射的 ActionDescriptor)` 与
   `approvalRef.actionDigest` 精确比较 → 否则 `ScmApprovalDigestMismatchError`
   （失败尝试**不烧**审批，原审批保持 APPROVED）；
7. 消费（宿主接线 `consumeApproval`；审批侧类型化错误原样穿透）；
8. transport 调用 + 投影严格 schema（未投影的 provider 响应 =
   `ScmTransportContractError`）；
9. 收据由本包构建（结构事实 + 本包计算的 contentSha256），再经严格 schema。

不变量（测试钉住）：守卫链 1→3 的顺序；digest 不匹配时审批不被消费；审批
恒为高风险（`requiresApproval === true`，含 external-side-effect + network +
write-unscoped + capability-not-verified 四类理由，`write-binding.ts:1-32` 头注
与测试）；transport 未被任何守卫失败触达。

### 3.3 A17 绑定的 digest 输入（全部进入 hash）

argv = `["scm", provider, 操作slug, "--repo", owner/name, 主体参数
（--issue N / --source-branch+--target-branch / --pull-request N）,
"--title-sha256"/"--body-sha256"（canonicalJson 后 sha256）, "--base-sha",
"--head-sha"]`；cwd = 托管 worktree；repo.root/baseSha/targetSha =
本地仓库根 + 基线 + 候选；profileRevision；requiredPermissions =
`["repo.write"]`（v1 权限闭词汇表无 remote-write id，取最近事实）；
grantedPermissions（来自 binding，权限**增量**由 approval 派生）；
dimensions = `[network, external-side-effect, write]` + writeScope `unscoped`；
requiredCapabilities = `[scm.<provider>.remote-write]`（capability-gate 未知
id → 恒高风险）。内容以 sha256 进 argv：超长正文精确绑定且不违反描述符
元素长度上限，审批行中不存任何内容。

已钉住的突变矩阵（每个都产生不同 digest、原审批不可消费）：issue 号、正文、
repo owner/name、baseSha、headSha、worktree、profileRevision、runtime、
权限增量（注意：digest 绑定的是 approval 派生的增量集，而非 granted 原始
列表——这是 `packages/approval/src/digest.ts:57` 的既有语义，测试按此写）、
跨操作重放。

## 4. A42：凭据流与脱敏层

```
credentialRef(引用) ──宿主解析器(包外)──▶ ResolvedCredentialHandle(无秘密)
   │                                          │
   │ 仅结构引用, schema 拒明文                 │ 传输 seam: adapter 在包外
   ▼                                          ▼
  本包 schema/日志/事件/收据/导出 ◀── 只含 provider+label, 不含 token
```

- 结构性脱敏：`ScmAuditEventSchema` 是闭字段集，**不存在**能放 token 的字段
  （`events.ts:55-70`）；写事件只带 approvalId / actionDigest（哈希可示人）/
  contentSha256 / executionId。
- 深度脱敏：`scrubCredentialMaterial` 深走查 JSON，把 10 类已知 token 形态
  （GitHub PAT/fine-grained、GitLab PAT、Bearer/Basic、key=value、sk-ant、
  sk-、xox、AKIA）替换为 `[REDACTED]`，幂等（`credential.ts:45-116`）。
- 收据（`writes.ts:121-146`）只含结构事实 + contentSha256；测试断言收据与
  事件序列化中既无正文也无 token。
- 宿主落盘前可再叠加既有通用脱敏（`packages/cli-events/src/redact.ts` 的
  A36 层）——两层独立、可组合，本包不依赖它以保持契约包最小。

## 5. token scope 最小化与兼容矩阵骨架

随包矩阵（`capability.ts:135-163`，冻结）：

| provider | apiFlavor | 认证头（拟） | 拟最小 read scope | 拟最小 write scope | verification |
|---|---|---|---|---|---|
| github | github-rest-v3 | `token <pat>` | metadata:read, contents:read, issues:read, pull-requests:read | metadata:read, contents:read, issues:write, pull-requests:write | **unverified** / evidence null |
| gitlab | gitlab-rest-v4 | `PRIVATE-TOKEN` | read_api | api | **unverified** / evidence null |

明确声明：scope 集是**公开文档口径的草案**，未对照真实 provider 验证（本
任务禁止网络调用与凭据读取）；真实集成任务必须先重推导 scope 并以证据翻转
verification 单元。测试把 scope 集逐字钉死、断言读 scope 不含 write/admin
字样，防止无声明扩散。GitHub/GitLab 的真实 scope 约束（如 classic PAT 无法
只读仓库内容、fine-grained PAT 的权限粒度）属 **unverified**，见 §9。

## 6. 威胁模型（设计对策与残留风险）

| 威胁 | 对策（已实现） | 残留风险（移交真实 adapter 任务） |
|---|---|---|
| 凭据泄露面（日志/事件/manifest/导出） | 引用型 credentialRef + schema 拒明文；事件结构性无凭据字段；深度脱敏；收据只带摘要；错误消息只带结构事实（`errors.ts` 全类） | 宿主解析器与 adapter 内存中的 token 生命周期（本包 seam 之外） |
| 混淆仓库输入（控制字符、Trojan-Source 双向覆盖、超长、意外枚举） | 全输入严格 schema 拒绝不消毒（`input.ts`：控制字符 + U+200B-200F/202A-202E/2060-2069/FEFF + 长度界 + 闭枚举）；provider 回显经投影严格 parse，adapter 必须丢弃坏项并计数 `malformedDropped` | 极端 Unicode 形态（如未见过的覆盖符）的覆盖面——模式集随威胁情报演进 |
| SSRF 式 base-url 注入 | `ScmBaseUrlSchema`：仅 https、DNS host、无 userinfo/path/query/fragment（`capability.ts:62-67`）；`assertBaseUrlAllowed` 精确 host allowlist，无后缀把戏（`capability.ts:72-89`） | DNS rebinding（解析与连接两时刻 host 不一致）需 adapter 在连接层再校验 IP；allowlist 本身是部署配置，配置错误不在本包防御内 |
| 审批重放/漂移 | §3.2 守卫链 + approval 真实 CAS；跨操作重放、改目标、改内容、改绑定全部 digest 失配 | 无（审批侧语义由 approval 包测试承担） |
| 投影跳过（adapter 直接透传 provider JSON） | 投影严格 parse，`ScmTransportContractError` 响亮失败；`malformedDropped` 使丢弃可见不静默 | adapter 实现质量，由后续任务的验证覆盖 |
| 把未验证集成当可用 | 矩阵 verification = literal unverified；默认查找下读/写 client 构造即抛 | 无（该姿态由测试钉死） |

## 7. 已实现并有测试（本会话真实执行的证据）

新增文件：`packages/scm-contracts/`（src 9 个模块 + test 5 个套件 + helpers +
README + 构建三件套）。对既有文件的唯一修改：
`packages/release-audit/test/repo-audit.test.ts:41-46`（workspacePackageCount
31→32，附注释）与 `PROPOSALS.md`（只允许的追加披露）。冻结面零接触。

单包实测（本会话，真实退出码）：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install`（仓库根） | 0 | `Scope: all 32 workspace projects`；外部依赖集合不变 |
| `pnpm exec tsc -p tsconfig.json`（scm-contracts） | 0 | 全仓严格编译（含测试） |
| `pnpm exec vitest run`（scm-contracts） | 0 | **5 文件 74 测试全过**（schema-strictness 16 / capability-matrix 10 / readonly-split 11 / write-guard 29 / event-redaction 8） |
| `pnpm run build`（scm-contracts） | 0 | dist 产物生成（tsc declaration） |
| `pnpm exec vitest run`（release-audit，基线更新后） | 0 | 42/42：外部依赖仍恰 84、license 表不变、runtime 外部仍 ws/yaml/zod、workspacePackageCount=32 |

全仓门禁（真实退出码，任务收尾回填）：见 §11。

测试要点（全部 hermetic：provider 永远是内存 fake transport；审批走真实
SQLite 世界，建在系统临时目录，`createApprovalWorld` 镜像
`packages/approval/test/helpers.ts` 的接线）：

- **schema 严格性**：未知字段（含试图塞 `token` 字段）、意外枚举（provider/
  操作/状态）、超长（owner 129、ref 256、body 65537）、控制字符与
  Trojan-Source 覆盖符、credentialRef 明文 token（4 种走私形态逐字断言错误
  信息）、base-url 的 http/userinfo/path/query 注入——全部拒绝。
- **只读 client 无写能力**：own+prototype 属性名逐一断言不含任何写操作名；
  `assertNoWriteCapability` 对真实 client 通过、对塞入写方法的对象抛类型化
  错误；运行时 `client.createIssueComment === undefined`；构造期默认矩阵即拒。
- **写守卫链**：缺 ApprovalRef（undefined/null、且在验证面翻未验证时仍先行）
  → `ScmApprovalRequiredError` 且 transport 未触达；坏 ref 形态、未声明操作、
  坏命令 → 各自类型化拒绝；10 项 digest 突变矩阵 + 跨操作重放 →
  `ScmApprovalDigestMismatchError`，审批保持 APPROVED 不被烧。
- **单次消费端到端（真实 CAS）**：happy path（审批 APPROVED→CONSUMED、
  execution id 入库、收据与库一致）；同 ref 二次写 →
  `ApprovalAlreadyConsumedError`；PENDING → `ApprovalStateError`；过期 →
  `ApprovalExpiredError`；未知审批 id → 原样穿透。
- **A42 脱敏**：事件结构性无凭据字段（塞 `credential`/`password` 字段即
  schema 拒绝）；收据带 contentSha256 不带正文；深度脱敏幂等；写流程事件
  序列化断言不含正文与 token。
- **恒高风险不变量**：2 provider × 2 操作，grade=high、requiresApproval=true、
  四类理由齐备。

## 8. 「已实现并有测试」vs「仅设计（未实现）」

| 项 | 状态 | 依据 |
|---|---|---|
| 读写分离双重事实（型别断言 + 运行时面检查） | 已实现并有测试 | `clients.ts:167-176,261-275`；readonly-split 11 测试 |
| A17 类推 digest 绑定 + 真实 CAS 单次消费 | 已实现并有测试（真实 approval 生命周期，非 mock） | `write-binding.ts`；write-guard 29 测试 |
| credentialRef 拒明文 / 事件收据脱敏 | 已实现并有测试 | `credential.ts`、`events.ts`；schema-strictness + event-redaction |
| 兼容矩阵 fail-closed OFF（构造即拒） | 已实现并有测试 | `capability.ts`；两套件的构造期用例 |
| 恶意输入拒绝（含 Trojan-Source） | 已实现并有测试 | `input.ts`；schema-strictness |
| SCM 审计事件 + 验证查找注入缝 | 已实现并有测试（注入缝**仅供测试与未来证据翻转**） | `events.ts`、`capability.ts:169-204` |
| 真实 GitHub REST/GraphQL adapter | **仅设计**（transport 接口即它的落点，无实现） | §9.1 |
| token scope 真实性 / provider 兼容性 | **仅设计（未验证）** | §5、§9.2 |
| merge/close/delete 写操作、正文读取管线 | **仅设计留待后续**（闭枚举表达不了，刻意） | N2/N3 |
| DNS rebinding 连接层校验 | **仅设计**（对策记录于 §6，未实现） | §9.3 |

## 9. 不可本机验证项（unverified，含所需环境）

1. **真实 provider 协议行为**：REST v3 / REST v4 的实际请求/响应、分页、限流、
   错误形态——需要维护者授权的实时 provider 访问窗口；本任务红线禁止一切
   网络调用。闭合路径：后续 adapter 任务 + 真实 smoke 证据。
2. **token scope 真实约束**：拟最小 scope 集是否真能完成对应操作、classic vs
   fine-grained PAT 的粒度差异、GitLab role/scope 组合——需要真实 token 与
   实时验证；本任务禁止读取任何凭据。在此之前矩阵单元保持 unverified。
3. **DNS rebinding / 真实 SSRF 面**：需要可控网络环境实验；契约层只做了
   语法 + allowlist 防护。
4. **A42 端到端（真实凭据不出现在真实导出物）**：需要真实凭据的存在才能
   失败；本任务以形状化哨兵 token 测试，等价于 release-audit 的 sentinel
   方法论，不构成真实凭据证明。
5. **语义不变量的运行时全链路**（A01/A02/A16/A22/A26/A31/A35 等与 SCM 的
   交互）：本包按红线保持其语义（例如不新增 fallback、不绕过审批），但 SCM
   与调度/DAG 的全链路属 M7 后续任务。

## 10. 待维护者确认 / 后续提案（不在本任务代行）

1. P-M7-01-A（提案）：真实 adapter 任务立项（建议 M7 批次单列），范围 =
   ScmReadTransport/ScmWriteTransport 的 provider 实现、分页/限流/重试的
   fail-closed 语义、连接层 SSRF 防护、以及矩阵 verification 单元的证据翻转
   流程；翻转必须伴随真实 smoke 证据与评审。
2. P-M7-01-B（提案）：merge/close/delete 写操作的维度映射设计（main-branch-
   delivery / delete 维度进 digest 与审批）——需先有 ADR 补充，不随本批次
   隐式扩权。
3. 真实 provider smoke 窗口的授权与排期（§9.1/9.2 的唯一闭合路径）。

## 11. 门禁结果（真实退出码，收尾回填）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install` | 0 | `Scope: all 32 workspace projects`；外部包集合不变 |
| `pnpm typecheck`（全仓 turbo） | 0 | 54 tasks 全部成功（含新包；新包单包 `tsc -p tsconfig.json` 亦 0） |
| `pnpm test`（全仓 turbo） | 0 | 62 tasks 全部成功；复跑 `pnpm exec turbo run test --force`（强制全量真实执行）亦 0，**vitest 合计 1390 通过 / 0 失败** = 基线 1316 + 新增 74（scm-contracts 74 = schema-strictness 16 + capability-matrix 10 + readonly-split 11 + write-guard 29 + event-redaction 8；release-audit 42 保持） |
| `pnpm build`（全仓 turbo） | 0 | 31 build tasks 全部成功；复跑 `--force` 亦 0（31/31，含 `@role-orchestrator/scm-contracts:build`） |
| `node planning-check.mjs` | 0 | part (a) `checksum verification OK: 78/78 files match`（.gitignore 行跳过）+ part (b) 干净副本 self-test exit 0（含新增报告/README 的 md 链接检查） |
| `sha256sum -c CHECKSUMS.sha256` | 1（预期） | 78 个 `: OK`；唯一 FAILED 为 `.gitignore`——任务允许的保留项，与 planning-check part (a) 一致 |

## 12. 偏离与风险

**偏离**

1. ask 建议参照 `packages/release-audit` 建包结构——已照做（package.json/
   tsconfig/vitest 三件套 + engines node>=25 + zod 严格 schema 风格）。
2. ask 列的测试点「写调用缺/错 ApprovalRef 拒绝」在实现中比 ask 更强：
   ApprovalRef 检查是守卫链第 1 步（绝对先行），并以「验证面翻未验证仍先答
   approval-required」钉住顺序本身。
3. 权限增量突变用例按 approval 的既有语义调整（digest 绑定派生增量集而非
   granted 原始列表），测试注释已注明出处；这是复用语义的忠实结果，不是
   弱化。
4. 既有测试仅按红线允许的基线更新改了 release-audit 的包数断言（31→32）；
   `PROPOSALS.md` 只做了追加披露。

**风险**

1. 兼容矩阵的 scope 草案若与真实 provider 不符，翻转单元前必须重推导（流程
   已由 schema literal 钉死，误用需改代码，评审可见）。
2. 恶意输入模式集（控制字符/双向覆盖）是当前威胁清单，不是完备证明；新增
   形态需要演进 `input.ts` 的模式（闭单文件，评审即可见）。
3. 本包把「远程写恒高风险」钉死在映射与测试里；若未来 permission 词汇表
   扩展（如新增 `scm.write` 权限 id），需同步 `write-binding.ts` 的映射与
   digest 输入（schema 版本升位），否则审批与旧 digest 漂移——这是有意的
   摩擦，防止权限面静默变化。
