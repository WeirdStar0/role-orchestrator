# @role-orchestrator/scheduler

M2-02 调度域包：三级并发配额（global / project / profile）、credentialGroup 凭据锁
（A33）与公平 READY 队列。对应验收：A07（并行图资源竞争，同时满足
global/project/profile/credential lock）、A33（Profile 目录分开但凭据共享 →
不标记 verified，认证锁限制并发）。M4-04 在此之上补齐：受控 requeue-to-WAITING
（A21/A22，重试分类守卫）、held-run 调度强制点与 run 级资源/费用预算在
dispatch 事务内的落库检查（A37，与 `@role-orchestrator/budget` 组合）。

依赖既有十包的语义基座：`store` 的 `withTransaction`（`BEGIN IMMEDIATE`）与
lease/fencing 模式、`contracts` 的 policies schema（strict 校验，
`unverifiedCredentialGroupMax` 是契约字面量 1）、`capability-gate` 的
verified/unverified 判定、`dag` 的节点状态机（READY -> RUNNING 的显式转换）、
`runtime-profile` 的冻结 run 快照（A34 读取路径）。

## 迁移

Migration 004（`SCHEDULER_MIGRATIONS` = 001+002+003+004，经
`applySchedulerMigrations` 应用）建两张表：

- `quota_grants` — 计数型配额授予：每行一次 (execution, dimension) 获取，
  分级 `resource_key`、每 key 单调 `fencing_token`、`expires_at`、
  `released_at`。`UNIQUE(resource_key, fencing_token)` 把"A07 fencing 无重复
  授予"钉在约束层面，跨进程/跨线程成立。
- `scheduler_queue` — 公平队列：`UNIQUE(run_id, node_id)` 一节点一队列行
  （重复入队被吸收）；`state ∈ WAITING | DISPATCHED | COMPLETED |
  GATE_BLOCKED | CANCELLED`；`attempts` + `not_before` 构成配额拒绝后的重试
  窗口。

## 配额语义

- **三级同时生效，不做 `min()` 合并**（`docs/ORCHESTRATION.md` 第 4 节）：
  每级是独立的计数资源 key——`global`、`project:<projectId>`、
  `profile:<profileId>`、`credential:<groupId>`，一次认领事务同时检查全部。
  global/project 上限来自 strict 解析的 `policies.concurrency`
  （`parseConcurrencyPolicy`，未知字段拒绝）；profile 上限来自
  `profiles.max_concurrency`。
- **凭据锁（A33）**：`credentialGroupMax(runtime, max)` 查 capability-gate
  注册表的 `<runtime>.credential-isolation`；只有 `verified` 才解除锁（返回
  `null`，不再占用凭据维度），否则上限为 `unverifiedCredentialGroupMax`（契约
  字面量 1）。未知 runtime/能力 id 一律按未验证处理（fail-closed）。同组串行、
  异组互不阻塞。
- **授予全有或全无**：`acquireQuotaSlots`（自带事务）或
  `acquireQuotaSlotsInTransaction`（加入调用方事务，dispatch claim 用这条
  路径）按 global → project → profile → credential 顺序授予；任一维满额即
  抛 `QuotaFullSignal` 回滚整笔，`acquireQuotaSlots` 把它折叠成
  `{ granted: false, blockedBy }` 结果值。满额信息含 `liveCount` 与
  `expiredHeld`。
- **过期不等于可抢占**：过期 grant 仍然占坑，只有
  `releaseExpiredQuotaGrants`（显式 reconcile 步骤，对应 store 的
  `releaseExpiredLeases`）能释放。`pollQueue` 每轮开头先执行这一步。
- 释放路径：`releaseExecutionQuotaGrants`（执行完成，按行数返回）、
  `releaseQuotaGrant`（单条）、`releaseExpiredQuotaGrants`（reconcile）。

## Fencing 协议

每 key 的 fencing token 在认领事务内取 `MAX(全历史)+1`：严格单调、无空洞、
永不复用（`UNIQUE(resource_key, fencing_token)` 兜底）。grant id 由
`(executionId, dimension)` 确定性派生——同一执行对同一维度的二次获取会撞
主键并得到 `DuplicateGrantError`（调用方 bug，拒绝而不是重复计数）。
下游持有者可据 token 判断自己是否已被释放/超越；过期持有者由 reconcile
清出，绝不被自动抢断。

## 公平性保证

`pollQueue` 每轮：

1. strict 解析并发策略（失败则整轮不动）；执行过期 reconcile；
2. 取 `state='WAITING' AND not_before <= now` 的候选，按
   `priority ASC, enqueued_at ASC, id ASC` 排序（先优先级、再等待时间）；
3. **饥饿上限**：等待超过 `starvationMs` 的候选整批提到队首（再按最老优先）
   ——满额 Profile 的积压无法永久占住队列；
4. 逐个候选：capability gate（见下）→ 原子 claim。claim 是单事务：授予
   四维 fencing grant → 创建 STARTING 活跃尝试（A23 部分唯一索引）→ 节点
   READY -> RUNNING（dag 守卫转换）→ 队列行 DISPATCHED → dispatch outbox
   消息。任何一步失败整笔回滚，不存在半认领。
5. **配额拒绝不丢不重**：条目保持 `WAITING`，节点保持 `READY`，
   `attempts+1`、`not_before = now + retryWindowMs`、`last_reason` 记录被哪个
   key 拒绝；其他 Profile/Project 的候选照常继续尝试。

## Capability gate 接线

每个候选 dispatch 前先过 `evaluateDispatchGate(runtime, requiredCapability)`：

- `<runtime>.noninteractive-entry` 必须 `verified`（M0-06 能力矩阵）；
- 队列行可携带 `requiredCapability`（能力矩阵 cell id），同样必须
  `verified`；
- **unknown id 一律拒绝**（gate 的 `statusOf` 对未知 id 返回
  `unverified`+`known:false`），从不当作可用。被拒条目记 `GATE_BLOCKED` 与
  原因，节点不动、无 grant、无 outbox。

## 压力测试（A07）怎么证明

- 多项目多 Profile 饱和竞争：每轮 poll 后对每个 key 断言活跃 grant 数
  ≤ 配额；结束后对授予记录做 sweep-line 重放，任一时刻各级并发 ≤ 配额；
  每 key fencing token 恰为 1..n（无重复、无空洞）；每节点恰好派发一次。
- `worker_threads` 风暴：24 个真实线程各自持独立连接对同一文件库争抢
  global=1 + 两组 credential=2 的槽位。竞争是确定性构造：屏障协议让全部
  线程连接就绪后同时起跑，phase-1 拿到 grant 的工作线程持槽不放，直到
  全部 24 个首次尝试都上报——因此 “至少 23 次 quota-full” 由构造保证，
  不再依赖机器负载的时序运气（修复既往 'contention really happened'
  断言在满载 turbo 下偶发失败的问题）。实时采样 + 记录级断言双重验证
  fencing 无重复授予；worker 对瞬态 SQLITE_BUSY 做有界重试（传输层细节，
  绝不当作协议结论）。
- 满额 Profile 不阻塞他者、配额释放后队列恢复、过期 grant 经 reconcile
  释放后恢复，各有独立用例。

测试通过 turbo 运行（`build` 是 `test` 的依赖）：worker 测试导入本包构建
产物 `dist/index.js`——这是真实的已发布代码路径。未经构建直接 `vitest run`
会因缺少 dist 失败，这是构建顺序前置条件，不是被跳过的断言。


## M4-04：受控 requeue、held-run 强制点与 run 预算

与 `@role-orchestrator/budget` 组合实现 A21/A22/A37：

- **requeueForRetry（唯一的自动重排路径）**：FAILED 节点 + COMPLETED/
  DISPATCHED 队列行（执行必须已终态 FAILED）→ 队列行 WAITING + 节点
  FAILED -> RETRY_PENDING -> READY（守卫转换），单事务完成。守卫链全部
  fail-closed：非 FAILED 节点拒绝（`RequeueNotAllowedError`）；held run
  拒绝（`RunHeldError`）；A22 不可自动重试类别（结果未知/审批拒绝/凭据
  锁死/取消/进程中断或存活）拒绝（`NonRetryableFailureError`，节点保持
  FAILED）；三次总尝试已满则记 `attempts-exhausted` hold 并抛
  `AttemptsExhaustedError`（第四次尝试不存在）；protocol/schema 类失败
  只给一次重试（`ConditionalRetryExhaustedError`）。A34：requeue 不做任何
  Profile 重解析——队列行保持冻结快照字段。
- **dispatch 侧 A21 兜底**：claim 事务内在写锁下重读槽位尝试数，超过
  `MAX_NODE_ATTEMPTS = 3` 即抛 `AttemptCapExceededSignal`，条目记
  `GATE_BLOCKED`（reason `attempt-cap:3`）——即使有人绕过 requeue 强行
  把条目/节点放回候选位置，第四次尝试也不会发生。
- **held-run 强制点**：`enqueueReadyNodes` 对 held run（未解决的
  expansion_user_holds 或 scheduling-blocking 预算 hold）直接抛
  `RunHeldError`，零行写入；`pollQueue` 对 held run 的 WAITING 条目记
  `GATE_BLOCKED`（reason `run-held:...`），不静默丢弃也不派发。
- **run 预算（A37）**：`evaluateDispatchBudgetGate` 在 claim 前只读预检，
  `recordDispatchConsumption` 在 claim 事务内落账（executions_used 恒增、
  nodes_used 仅首次尝试递增），满额抛 `BudgetExceededSignal` 整笔回滚。
  执行预算/节点预算/时长超限 → 条目 `GATE_BLOCKED`（预算上限冻结，出路是
  新 TaskRun）+ 记录对应 hold；usage 不可判定达到阈值 → 条目保持 WAITING
  （`last_reason = budget:usage-undetermined`）+ 记录
  `usage-undetermined` hold——人工决议（接受未知成本）后下一个 poll 自然
  恢复派发，usage 在任何展示中始终是 unavailable，绝不写 0。
- **迁移组合**：本包自己的链仍是 001..004；预算表来自
  `BUDGET_SCHEMA_MIGRATION`（014）。预算检查按表存在性启用（presence-
  tolerant）：仅迁移到 004 的旧库行为不变（A21 上限照常生效，它只需要
  executions 表）；完整链上的 run 可选 enroll——未 enroll 的 run 只受
  A21 上限约束。held-run 检查对 `expansion_user_holds`（013）同样按
  存在性启用。

## 已知边界

- `granted_at`/`released_at` 是调用方时钟的取证时间戳：高争用下 `acquire`
  可能先取时钟、后等待写锁，因此跨连接对 `[granted_at, released_at]` 做区间
  重放会高估重叠（见 worker 压力测试注释）。墙时钟证据请用活跃计数采样；
  记录级的强制性由 per-key token 恰为 1..n 与
  `UNIQUE(resource_key, fencing_token)` 保证。单连接、受控时钟下（如进程内
  压力测试）区间重放仍然成立。
- `pollQueue` 的队列消费在单连接内顺序进行，但 claim 原子性由
  `BEGIN IMMEDIATE` 保证，多 daemon/多线程同时 poll 是安全的。
- 完成协议的最小面：`markQueueEntryCompleted`（DISPATCHED -> COMPLETED）与
  grant 释放是两个独立步骤，二者之间崩溃会留下"已完成条目 + 活跃 grant"的
  可见状态，由下一轮 poll 的 reconcile 释放；节点 FAILED/SUCCEEDED 终态写
  入仍属引擎/supervisor 的生命周期（本包只消费其结果），而
  FAILED -> RETRY_PENDING -> READY 的受控重排自 M4-04 起在本包
  （`requeueForRetry`，见下节）。
- `GATE_BLOCKED`/`CANCELLED` 是终态；能力矩阵更新后的重新入队是显式操作
  （重新 `createRunGraph`/新 run），本包不做自动重评估。
- 凭据锁解除依赖 capability-gate 注册表的 `verified` 证据；本包不读取任何
  凭据或 CLI 配置，仅引用矩阵 cell 的状态。
- `pollQueue` 单轮候选上限 1024（节点/深度预算内的防御性上限）。
