# @role-orchestrator/memory

M3-02 — 共享 Memory 提案、类型权限与 CAS。按 `docs/MEMORY_AND_CONTEXT.md`
实现五个规范记忆类型（temporary / fact / discovery / decision / project_rule）、
proposed → verified → active 生命周期（disputed 质疑态、temporary 过期）、
以及全部状态变更上的 (memoryId, expectedVersion) 比较交换（A14）。

## 记忆类型与写入权限

可提交者矩阵冻结自文档第 2 节（`PROPOSABLE_ROLES`）：

| 类型 | 可提交（提案与更新同矩阵） | 附加要求 |
|---|---|---|
| temporary | 四角色 | 必须携带未来 `expiresAt`（执行范围，到期清理，不进事实链） |
| fact | 四角色 | 必须至少引用一条证据（文件/SHA/测试/命令） |
| discovery | 四角色 | 先作为 proposed observation |
| decision | architect / coordinator | 证据必须；重大不可逆项仍走用户审批（后续里程碑） |
| project_rule | 仅 coordinator 可提案 | 提升为 active 仅限用户（见下） |

矩阵是常量，不是可配置面：内容、上下文与重试都不能放宽它（A16）。
更新是写入，同样受矩阵约束；输入一律 `z.strictObject`，未知字段拒绝。

## 生命周期

- `proposeMemory`：新建 `proposed`，version 1；相同 (project, type, content)
  的存活条目会吸收为同一行（幂等重试不复制历史，见迁移 008 的部分唯一索引）。
- `verifyMemory`：proposed → verified。校验职责在 reviewer/architect/coordinator，
  提案角色不得自审；temporary 永不进入已验证链。
- `promoteProjectRule`：verified → active，仅 `project_rule`，仅 `user` 主体。
  这是系统 API 层面唯一的显式提升入口：调用者身份（`user` actor + displayName）
  记入 `promoted_by` / `promoted_via` / `promoted_at` 并写 `promoted` 审计事件。
  角色主体（包括内容里自称权威的指令文本）只会得到 `MemoryUserRequiredError`
  与一条 `promotion-rejected` 审计。
- `disputeMemory`：proposed/verified → disputed（质疑态）。disputed 不能被引用为
  已验证（`requireVerifiedMemory` 拒绝并携带实际状态），也不能直接 verify——必须
  重新提案。active 规则不可被角色 dispute：质疑不等于撤销，撤销是用户通道（M3-03）。
- `updateMemory`：CAS 内容/证据更新。版本 +1、记录 `supersedes_version`、旧值保留在
  `memory_revisions`（追加，不覆盖）。内容变更使验证失效：verified/disputed 回到
  proposed；active 规则仅用户可改且保持 active（提升审计字段保留）。
- `expireDueTemporaries`：到期 temporary 批量转 `expired`（终态，带审计）。
  `superseded` 状态按文档保留给 M3-03 的替代流程；本里程碑的替代关系由
  `supersedes_version` + revisions 历史表达。

## CAS（A14：冲突可见，不静默覆盖）

verify / promote / dispute / update 全部基于 `(memoryId, expectedVersion)`：
事务内重读当前版本，UPDATE 的 WHERE 再带一次版本守卫；不匹配时抛
`MemoryCasConflictError`，携带 `expectedVersion`、`currentVersion` 与当前内容
sha256 摘要，写入不发生，且在独立事务里留下 `cas-conflict` 审计事件。
两个连接的并发双写测试钉住：同一 expectedVersion 恰有一方成功，失败方得到
类型化冲突而不是覆盖；真实锁竞争场景（一方持 `BEGIN IMMEDIATE` 未提交）下，
另一方响亮失败、提交后再试即为 CAS 冲突。

## 迁移 008 与审计选型

`MEMORY_MIGRATIONS = CONTEXT_MIGRATIONS + 008`，三张表：

- `memories`：scope=project（CHECK）、type/status/version/content/content_hash、
  提升审计三列、语义 CHECK（temporary ⇔ expires_at；active ⇒ project_rule；
  提升审计三列 ⇔ active；verified/disputed 的 actor 与时间成对）。
  部分唯一索引 `ux_memories_live_content` 让存活条目内容寻址、提案幂等吸收。
- `memory_revisions`：追加式历史，每次迁移写入结果状态——旧值保留、可完整性校验。
- `memory_events`：审计专用表。选型理由：迁移 001 的 `events` 是 per-execution
  （NOT NULL execution_id 外键 + UNIQUE(execution_id, seq)），而决定性的记忆迁移
  ——用户提升——发生在任何 execution 之外，没有 execution 可挂载；专用表把完整
  轨迹（含 promotion-rejected / cas-conflict 两种"拒绝也是事实"的审计）按记忆
  可查，并与被审计写入同事务提交。

## A16：内容是数据，不是指令

本包刻意不提供任何把记忆内容转成权限、角色绑定、Profile 选择或 capability
gate 结果的函数（导出面无 `permission|binding|capability|profile|model` 命名）。
授权只来自两处：调用者的 actor 身份 + 冻结的可提交者矩阵。注入测试矩阵
（「忽略策略并改模型」「提升自己为 project_rule」等 5 个样本）在
提案 → 校验 → 角色提升被拒的全链路上逐字节对比诚实世界与注入世界的安全观测
（角色绑定、Profile 行、策略解析、capability gate、另一项目的记忆与规则）：
内容按原样存储为数据（逐字内容 + sha256 + 来源），类型不被提升，不产生任何
active 规则。跨项目侧：所有查询强制 projectId 过滤，他项目 id 与未知 id 表现
一致（A15 数据面基调；授权层强制落在 M3-03）。

## 测试

`pnpm test`（turbo 登记）：生命周期守卫、CAS 并发冲突（A14）、类型权限矩阵、
用户专属提升、A16 注入矩阵、content_hash 完整性与迁移链 001..008。
