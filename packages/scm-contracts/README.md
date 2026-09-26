# @role-orchestrator/scm-contracts

M7-01「设计 GitHub/GitLab 受控集成」的契约包：统一 SCMProvider 接口、读写权限
分离、A17 类推的远程写审批绑定与 A42 凭据纪律。**仅设计，未接真实
GitHub/GitLab**：本包没有任何网络代码与 transport 实现；随包兼容矩阵把每个
provider 的 verification 单元钉死在 `unverified`，因此默认（矩阵）验证查找下
读/写 client 一个都构造不出来——远程 SCM 面整体 fail-closed OFF。

## 组成

- `src/input.ts`：安全标量 schema（slug、git ref、SHA、时间戳、自由文本）。
  一律拒绝不消毒：控制字符、Trojan-Source 双向/零宽覆盖符、超长值、非法形态
  全部 fail-closed。
- `src/capability.ts`：provider 能力声明（baseUrl/apiFlavor/操作清单/token
  scope）与**兼容矩阵骨架**。矩阵 cell 的 verification 是 `z.literal("unverified")`
  ——出货的 schema 表达不了 "verified"；冒充已验证必须改代码走评审。含 SSRF
  式 base-url 防护（仅 https、无 userinfo/path/query）与精确 host allowlist
  检查（`assertBaseUrlAllowed`）。
- `src/credential.ts`（A42）：`ScmCredentialRef` 只接受引用形态（env 变量名 /
  keyring 条目 / 受保护文件路径），任何字段出现已知 token 形态即拒绝；
  `ResolvedCredentialHandle` 是不透明、无秘密的句柄（provider + 审计 label），
  真实 token 只存在于宿主侧的解析器里。
- `src/reads.ts`：只读操作模型（listIssues / listPullRequests / listChecks /
  listStatuses），严格 page 信封带 `malformedDropped` 计数（adapter 的投影
  义务），v1 读模型刻意不含正文文本。
- `src/writes.ts`：受控写命令（createIssueComment / createPullRequest /
  updatePullRequestText，刻意不含 merge/close/delete）+ `ScmApprovalRef` +
  收据 schema。收据只带结构事实与内容摘要，绝无内容与凭据。
- `src/write-binding.ts`：把写命令确定性地映射为 `@role-orchestrator/approval`
  的 `ActionDescriptor` 并复用其 `actionDigest`（A17 类推）。argv 为规范操作
  向量；内容以 sha256 进 argv；dimensions 钉死 network + external-side-effect
  + write（unscoped）+ 未知能力 → 任何远程写恒为高风险、必须用户审批。
- `src/clients.ts`：读写分离的**双重事实**。静态：`ScmReadOnlyClient` 及其
  `ScmReadTransport` 上不存在任何写方法（编译期断言随 tsc 失败即红）；运行时：
  `assertNoWriteCapability` 走 own+prototype 属性名复查；写 client 守卫链
  ApprovalRef 在场 → 形态 → provider 验证 → 能力声明 → 命令严格 schema →
  digest 匹配 → 真实 CAS 消费（宿主接线 `consumeApproval`）→ transport →
  严格投影 → 本包计算的收据。消费先于 transport：消费后 transport 失败 =
  审批已消耗、什么都没写，重试需要新审批（不自动重跑）。
- `src/events.ts`（A42）：审计事件 schema 无任何凭据字段（结构性脱敏）；
  `scrubCredentialMaterial` 深度走查 JSON 把 token 形态替换为 `[REDACTED]`；
  `assertEventCarriesNoCredential` 是宿主落盘前的后置条件。

## 测试

`pnpm vitest run`（turbo `test` 任务自动纳入），全部 hermetic：provider 永远
是内存 fake transport，审批走真实 SQLite（系统临时目录）+ `@role-orchestrator/
approval` 的真 CAS。覆盖：严格 schema（未知字段/意外枚举/超长/控制字符/
双向覆盖符）、credentialRef 拒明文 token、只读 client 无写能力、缺/错
ApprovalRef 拒绝（含 digest 不匹配与跨操作重放）、单次消费端到端（重复消费 /
PENDING / 过期 / 未知审批）、恒高风险不变量、事件与收据脱敏。

## 边界

- 本包不发起任何网络调用；真实 adapter 属后续独立验证任务。
- 兼容矩阵的 proposed token scope 是公开文档口径的**草案**，未经真实
  provider 验证；翻转任何 verification 单元需要证据 + 治理流程。
- 与 `packages/approval` 的关系是复用而非旁路：审批的创建/批准/消费语义
  全部以 approval 包为准，本包只做 SCM 命令到 ActionDescriptor 的确定性映射。
