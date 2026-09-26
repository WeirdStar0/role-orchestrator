# DAG 调度与任务生命周期

## 1. 调度器与 Coordinator 的分工

Coordinator 负责理解目标、提出 DAG、选择内置角色、评估业务风险及验收范围。
DAG Scheduler 负责授权、图合法性、资源配额、启动、状态变化与恢复。
Coordinator 没有数据库管理权限，不能自行启动未登记进程、切换 Profile 或批准高风险工具。

配置解析唯一链路：

```text
TaskRun.configSnapshot
  -> Project RoleBinding[roleId]
  -> pinned ProfileRevision
  -> capability check
  -> Execution
```

没有 Workflow/Task/Node Profile 覆盖。配置修改仅用于新 TaskRun；
要更换已经冻结的绑定，必须显式创建新 TaskRun，保留原 run 的历史。
同一节点重试沿用同一 Profile revision，不做隐式模型 fallback。

## 2. 图定义与动态变更

节点声明 id、role、dependencies、目标、capabilityTags 和验收条件。
系统节点另有受控类型，如 integration、approval，不伪装成第五个 Agent 角色。
节点输出必须通过角色结果 Schema 校验，才能成为后继可消费的依赖产物。

计划导入时检查：ID 唯一、所有依赖存在、无自依赖、拓扑排序成功、
四角色绑定完备、模型/Profile 不可覆盖、权限足够、节点与深度预算未超限。
模型生成的未知字段拒绝，而不是静默接受或降级。

动态扩图先由 Agent 提交 Proposal，系统检查其角色 canCreateSubtasks 与剩余预算。
变化使用 expectedGraphRevision 乐观锁；只可增加尚未执行的后继。
修改 RUNNING/SUCCEEDED 节点需要建立新定义 revision，不能改写原执行证据。
用户删除依赖/更改验收标准时必须重新校验受影响后继，不能复用过时“通过”结果。

## 3. 节点、进程与任务状态分离

Node 状态：

```text
PENDING -> READY -> RUNNING -> SUCCEEDED
RUNNING -> FAILED | WAITING_APPROVAL | INTERRUPTED | CANCELLED
FAILED -> RETRY_PENDING -> READY
WAITING_APPROVAL -> READY | CANCELLED
INTERRUPTED -> RECOVERY_REQUIRED -> READY | CANCELLED
PENDING/READY -> BLOCKED | CANCELLED
```

`WAITING_APPROVAL -> READY` 表示获得有效许可后创建新尝试，
不保证原 CLI 进程仍在运行；可以续接时也要创建清楚的执行阶段记录。
审批拒绝令相关分支取消或保持 blocked，按 DAG 策略决定整个 run 是否终止。
用户暂停调度会阻止新节点启动；已有进程选择“允许当前完成”或“安全停止”，必须显式。

Execution phase：

```text
PREPARING -> STARTING -> RUNNING -> FINALIZING -> SUCCEEDED
任何未完成阶段 -> FAILED | INTERRUPTED | CANCELLED
```

TaskRun 状态为各节点状态的聚合，不直接从某个 CLI 的 exit code 推断。
要求的最终 Reviewer 通过、所有交付节点完成、候选 SHA 有效且无未决审批，
任务才进入 READY_FOR_DELIVERY；人工接受后 DELIVERED。
CLI exit 0 只是成功必要条件之一，不等于任务验收通过。

## 4. 原子认领与配额

每次认领同时检查 Global、Project、Profile 的活动租约数。
例如 Profile A 满额时，只阻止 A；其他可用 Profile 的任务仍可运行。
不得把三级配额简单取 min 后当成全局总配额。

同一个凭据组若未验证可并发刷新认证，增加 credentialGroup 锁；
不同 Profile 名字不自动代表不同账号。此锁补充三级配额，不替代它们。
等待审批且进程已退出时释放执行槽；原进程仍存活则继续占槽，避免隐形超额。

READY 队列先按优先级再按等待时间排序，设置 starvation 上限。
认领使用数据库事务：检查配额 -> lease -> execution -> dispatch outbox。
进程启动器用唯一 dispatchToken 去重，未知启动结果必须 reconcile，不能重发启动命令。

## 5. 返工不是有环图

```text
dev_a + dev_b -> integration_0 -> review_0
review_0 不通过:
  -> repair_1 -> integration_1 -> review_1
review_1 不通过:
  -> repair_2 -> integration_2 -> review_2
```

`maxReviewRounds=3` 包含首次审查，即最多再生成两轮修复与复审。
审查失败不会添加返回旧节点的边；它提交 RevisionProposal 生成新节点。
`maxAttempts=3` 是每个节点最多三次进程尝试（首次 + 两次重试），与返工轮数分开。
图节点数、Execution 总数、运行时长预算对“扩图 × 重试 × 返工”同时设上限。
默认工程值：每 run 最多 64 节点、96 次 Execution、依赖深度 16，可由用户调整。

## 6. 重试分类

可考虑自动重试：明确未产生副作用的启动失败、短暂通信失败、限流后同 Profile 等待。
不能直接自动重试：认证失效、权限缺失、协议无法解析、未知模型、
schema 不合格反复发生、Git 冲突、进程是否仍存活未知、可能完成的外部写操作。
有副作用的失败先保存 diff、检查 Git 和操作记录，再决定继续或新建修复任务。
等待和退避不修改模型配置；超出上限进入 PAUSED/RECOVERY_REQUIRED。

## 7. 恢复协议

启动 daemon 时锁定数据库实例，扫描非终态 execution 与未完成 outbox。
校验 pid + 创建时间 + execution nonce，避免 PID 复用误杀其他进程。
确认旧进程及其子进程已退出或受可接管 supervisor 控制，检查 worktree 和输出完整性。
将不确定对象置为 RECOVERY_REQUIRED；保留工作树、事件、未提交改动。

Resume 使用相同 CLI、Profile revision、execution target 与安全校验后的会话 ID。
Retry 创建新的 Execution/attempt；不得把有改动的工作树无条件清空。
Abort 先终止受管进程树，保留诊断和未交付改动，清理需单独确认。
不承诺恢复进程内存、未输出 token 或任意时刻的 exactly-once 外部副作用。

## 8. 完成协议

确认进程退出 -> 校验最终事件/结果 schema -> 保存产物 hash ->
校验允许写入的路径与 Git diff -> 创建受管提交/记录引用 ->
提交 FINALIZING 到 SUCCEEDED 的事务及 outbox。
崩溃发生在任一步时都可通过 run manifest、Git SHA 和幂等键确定下一步。
