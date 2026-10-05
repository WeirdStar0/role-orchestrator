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

M10-04（受控迁移 018，`018-task-run-outcome`）起 TaskRun 携带
status+outcome 双字段：状态词汇表五个值一个不动；`outcome` 为
nullable 的呈现列，SQL CHECK 钉死 `success/failed/cancelled/blocked`。
聚合修正（run 驱动写面，同值幂等跳过）：全部节点 SUCCEEDED →
READY_FOR_DELIVERY + null（success 由交付流程拥有）；任一节点
WAITING_APPROVAL → 保持 RUNNING + blocked（活阻塞优先呈现）；任一节点
FAILED → 保持 RUNNING + failed（状态词汇表无 failed 值，失败由 outcome
如实呈现，不再假"执行中"）；其余 → null。「取消 → CANCELLED +
cancelled」规则钉在 store 写面与成对专格——产品 v1 无 run-cancel 生产
面（无路由/UI），真实取消流程落地时必经此面。API 与 UI 的呈现见
docs/API_AND_EVENTS.md §2。

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

## 9. RunDriver 组合根与并发（2026-10 现实）

生产组合根为 `packages/orchestration` 的统一 RunDriver（M10-02 起
serve/dogfood/browser-e2e 三方共用，消除 test/product path divergence）。
serve 进程内以唯一 FIFO drive 链逐个驱动 run——这是全局 pollQueue
（scheduler_queue 全表 WAITING 候选）安全的前提。

M10-04 起单 run 一轮内的派发为**并行 join**（`dispatchJoin: "parallel"`，
共享泵原语的既有参数化分支）：一轮内配额允许的全部节点派发经
`Promise.all` 同飞。并行只发生在单个 run 的轮内，不跨 run。失败隔离
catch-per-run（单 run 驱动故障只终止该 run，serve 进程照常）；收敛
条件仍为全部节点终态；shutdown 对全部在飞执行统一取消（落持久
CANCELLED）。审批暂停不占并发槽：节点落 WAITING_APPROVAL 时其队列
条目已 COMPLETED、配额授予已释放，且 WAITING_APPROVAL 非 READY 不会
再次入队。

并发上限沿用 scheduler 四层约束零改动：global / project /
profile.maxConcurrency / 凭据组（capability-gate 状态读取；
claude/codex credential-isolation 均 unverified → 每凭据组并发 1，
A33 锁语义不变）——同 profile 兄弟节点按凭据层设计串行化，属约束的
如实生效而非缺陷。

## 10. 多节点编排声明层（v1 限制）

`POST /api/v1/runs` 的可选 `workflow` 字段声明多节点图：每节点
`{id, role, kind: agent|integration|review, objective, dependencies}`；
缺省时创建既有的单节点 "execute" 图（形状不变）。声明经域门校验
（id 唯一、依赖存在、无环、预算、review/integration 形状）后冻结为
图模板与图修订行；生产域门之外，冻结图模板生成器（toFrozenWorkflow）
设独立防御门。

**v1 限制（如实声明）**：每任务至多一个 integration kind 节点——
≥2 个被 400 WORKFLOW_INTEGRATION_NODE_COUNT 拒绝（可读原因随响应）。
原因：M7 integration 服务为 per-run 单集成（单 task 分支+单 integration
worktree），链式/并行集成会确定性死锁或污染候选归属；扩展前置为 M7
集成服务的图形态化。纯 agent 链与审 agent 输出的多节点声明不受影响。
多节点 CLI 节点的 stdin prompt 组成与 Memory/Context 注入见
docs/MEMORY_AND_CONTEXT.md。

## 11. 接缝勿动清单

沿 M10-02/M10-03/M10-04 批报告交接收口为常设清单（2026-10-05/06）；
触碰以下接缝属边界变更，须先过批次决策与披露：

1. **RunDriver 六操作暴露面**（driver-surface 测试钉死；不加命令面）。
2. **审批红线**：驱动永不批准（A17/A19；审批只经既有审批面）。
3. **M8 无注入命令面**：RunDriverPorts 类型无 validation* 字段。
4. **A38 驱动侧读锁**（rework-driver 的图修订读语义）。
5. **M10-03 声明层限制**：每任务至多一个 integration 节点（§10）。
6. **单节点裸 objective 逐字平价红线**：单节点 run 的 prompt 恒为
   裸 objective 逐字（v0.2.1 平价），永不注入 Memory/Context。
7. **零注入形状锚**：多节点 prompt 零注入时与 M10-03 形状经 M10-05
   显式冻结形状决策②修订尾注接缝行后的形状逐字节一致，是回归锚；现行
   尾注接缝行为『（多节点工作流；本提示未携带 Memory/Context 注入。）』，
   三方字面量一致（execution-input.ts 生产实现 /
   memory-injection.test.ts M10_03_SEAM_NOTE 常量锚 / multi-node.test.ts
   内联断言）。【决策②已落地，M10-05 任务 2】旧值→新值→理由记录于
   M10-05 批报告 §3 与 PROPOSALS.md「治理披露:M10-05 交付——文档大收口
   +审查承接修复(2026-10-06)」§三；自落地起以本条所述新形状为锚。
8. **memory/context 包写路径零接触红线**：执行链读侧只走
   memory-search/context 包公开 API，不改写任何存储语义。
9. **迁移链版本递增纪律**：schema 演进只走受控链新增版本（019 起），
   001..018 既有定义不改写。
