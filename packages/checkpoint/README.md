# @role-orchestrator/checkpoint

M4-02 — 审批检查点与有限续行（approval checkpoints + bounded continuation）。

设计依据：`docs/CLI_ADAPTERS.md`「审批能力不可假定一致」（节点检查点）、
`docs/ACCEPTANCE.md` A17/A18/A19/A22/A34、`packages/approval`（M4-01）与
`packages/capability-gate`（M0-06）。

## 动作提案协议（A19）

CLI 的事件流/结果负载可能携带**结构化 action proposal**（本包 `ActionProposal`，
strict schema，未知字段拒绝）。本包从不执行提案描述的动作，也从不在线回答
任何 control request。按 capability-gate 数据判定通道：

- 两个捆绑运行时（claude / codex）在 M0 实测中都**没有可靠的交互审批通道**
  （对应 gate 单元 `claude.permission-approval-behavior` /
  `codex.approval-sandbox-rejection-path` 均为 unverified），且 gate 将
  node-checkpoint 钉为无人值守执行的必要控制（blocked assumptions
  `codex.default-mode-unattended-write`、`claude.mid-run-approval-in-noninteractive`）
  → 提案走**检查点路径**：当前执行已安全结束，提案转为审批请求。
- 提案声明其动作类型**依赖**中途交互审批通道（`requiresInteractiveApproval`）
  而该通道未被 M0 验证 → **直接拒绝该动作类型**（fail-closed，零写入，
  不创建审批、不创建检查点）。
- 运行时既无已验证通道也无 node-checkpoint 假定 → 拒绝（无法证明边界）。

`extractActionProposals` 永不抛出：无法严格解析的 `approval_requested` /
result 载荷进入 `unparsable`（记录原因），永远不能变成可审批动作。

## 检查点服务

`openApprovalCheckpoint(db, input)`：

1. 前置：执行处于**终态**（SUCCEEDED/FAILED/INTERRUPTED/CANCELLED）。对活跃
   尝试打开检查点 = 伪造中途暂停，类型化拒绝（`CheckpointExecutionNotEndedError`）。
2. 从冻结快照读取路径构建完整 `ActionDescriptor`（runtime、全量 argv、cwd、
   repo root/baseSha/targetSha、冻结 profile revision、权限增量、维度、
   所需能力），判定 A19 处置。
3. 通过 `@role-orchestrator/approval` 创建一次性审批（幂等键 =
   execution + proposalId；A17 actionDigest 绑定）。
4. 节点经 dag 状态机 `RUNNING -> WAITING_APPROVAL`（等待语义复用既有状态机，
   不发明新状态）；整仓事务，回放（同一 execution + proposal）返回同一行。

## 有限续行

审批批准后，`continueAfterApproval(db, input)` 在**一个事务**内完成：

- 读取冻结快照（`readRunRoleProfile`，A34：续行不改 Profile）并核对审批绑定
  的 profile revision（不一致 → `ContinuationProfileMismatchError`）；
- 在 A23 单活跃尝试约束下创建新 attempt（phase `STARTING`，新 dispatch token）；
- 检查点 CAS `WAITING -> CONTINUED`（一个检查点至多续行一次）；
- 以呈现的动作做审批 CAS 消费（actionDigest 精确匹配，A17/A18；已消费/过期/
  未批准各自类型化拒绝）；
- 写入 dispatch outbox（`checkpoint.continuation-requested`），由既有 dispatch
  管道消费；启动本身交给 engine 的 claimed-attempt 组合
  （`startExecution({ claimedAttempt: true, dispatchToken, ... })`）。

任何守卫失败（A23 冲突、digest 不匹配、CAS 落空）整体回滚：审批绝不会在
没有对应 execution 的情况下被消耗，也绝不会一次授权两个执行。

## 未审批的副作用不发生

检查点路径本身不执行任何动作：提案在原执行结束时只是数据。唯一能携带动作的
是新 execution —— 它以全新进程运行，且必须先经 `consumeApproval` 的
actionDigest CAS 消费审批。E2E（`packages/fake-cli` dist bin，synthetic）以
sentinel 文件证明：检查点后文件不存在、原进程已退出；批准续行后，只有新
execution 的进程写入了该文件。

## A22

续行 execution 落入「副作用已发生但结果未知」时，复用
`@role-orchestrator/reconcile`：`decideExecution` →
`applyReconcileMarker("recovery-required")`（attempt 保持活跃相位，A23 槽位
持续阻塞）→ 操作员处置后经 dag bridge `RUNNING -> INTERRUPTED ->
RECOVERY_REQUIRED`。全程无自动重跑。

## 迁移

`CHECKPOINT_MIGRATIONS` = 001..010 既有链 + `011-approvals`（M4-01）+
`012-approval-checkpoints`（本包）。始终经 `applyCheckpointMigrations` 应用。

## 测试

`pnpm test`（vitest）：通道判定、提案提取、检查点服务、有限续行、fake-cli
端到端、A22 恢复。所有数据均为 synthetic；dogfood 只使用 `packages/fake-cli`
的 dist bin，从不调用真实 claude/codex，也不读取任何凭据或 CLI 配置。
