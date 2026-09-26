# @role-orchestrator/store

M1-01 的 SQLite 持久化包：版本化迁移、核心状态表与事务 outbox。
基于 Node 内置 `node:sqlite`（无需原生编译，Windows + Node v25.0.0 实测），
对应 `docs/adr/005-local-state-and-outbox.md` 的存储方向。

## 范围

- **迁移框架**：`schema_migrations`（version 主键、name、checksum、applied_at）；
  每个迁移在单事务内应用（先 INSERT 占用版本号，PK 冲突使“同版本二次应用”被拒绝，
  DDL 失败则与版本记录一起回滚）；`verifyMigrations` 重算 sha256 校验和，发现
  记录被篡改、SQL 定义变更或“数据库比代码新”（降级保护）；`applyMigrations` 支持
  `backupPath`，在任何待应用迁移之前先做整库备份。
- **核心表**（命名以 `docs/DOMAIN_MODEL.md` 为准，最小可行）：
  `projects`、`task_runs`、`executions`、`leases`、`events`、`outbox`。
- **A23 约束**：`executions` 上的部分唯一索引 `ux_executions_one_active_per_slot`
  保证同一 (run_id, node_id) 槽位至多一个处于 PREPARING/STARTING/RUNNING/FINALIZING
  的尝试。“DB commit 后、进程启动前崩溃”时，第二个连接无法再创建活跃尝试
  （约束层面杜绝重复启动）；reconcile 将旧尝试置为 INTERRUPTED 后才能创建新尝试。
- **outbox**：`enqueueOutboxMessage` 在与业务写入同一个 `withTransaction` 内调用，
  原子提交；dispatch（`claimOutboxMessages`）用租约语义（claim_token +
  claim_expires_at），至少一次投递，接收端按消息 id 去重。
- **事件**：`events.id` 主键使重放幂等（同 eventId 重复投递不产生重复行）；
  `UNIQUE(execution_id, seq)` 保证每执行序列号唯一；checksum 支持完整性核对。

## 事务边界

- 所有写操作通过 `withTransaction(db, fn)`（`BEGIN IMMEDIATE` → `COMMIT`/`ROLLBACK`）。
  `BEGIN IMMEDIATE` 提前取写锁，认领类流程不会在事务中途因锁升级而失败。
- 同一连接上的实体函数（createProject、enqueueOutboxMessage 等）自动加入当前
  打开的事务；在 `withTransaction` 内嵌套调用会抛出 `TransactionStateError`，
  组合方式是“在一个块内依次调用各函数”。
- outbox 原子性由调用方保证：把业务写入和 `enqueueOutboxMessage` 放进同一个
  `withTransaction` 块（本包测试覆盖回滚无残留与原子提交两条路径）。
- 迁移之外的 PRAGMA（`foreign_keys`、`busy_timeout`、`journal_mode`、
  `synchronous`）由 `openDatabase` 统一设置并在打开时读回验证；迁移 SQL 中
  永远不写 PRAGMA（部分 PRAGMA 不能在事务内执行，其余是连接级状态）。
- `synchronous=FULL` + WAL：进程崩溃与 OS 崩溃后已提交事务都不丢。

## 租约语义

- `claimLease`：检查活跃租约 -> fencing token 取同资源 `MAX+1` -> 插入，
  全程单事务。并发认领（跨连接/跨进程）恰好一个成功：写锁串行化 +
  `ux_leases_one_live_per_resource` 部分唯一索引兜底。
- **过期不等于可抢占**：DOMAIN_MODEL 规定“超时只代表需 reconcile”。过期后
  `claimLease` 返回 `granted: false, reason: "needs-reconcile"`；只有先执行
  `releaseExpiredLeases`（或对已确认死亡的持有者 `releaseLease`）后才能重新认领。
- fencing token 单调递增，供资源侧识别过期持有者；新认领 token 严格大于旧值。
- outbox 的 claim 用同样的租约列（claim_token/claim_expires_at）：调度器崩溃后
  租约过期消息可被重新认领（attempts 递增）；过期 token 的 complete 返回 false，
  僵尸调度器不能掩盖重投递。

## 备份与恢复（A41 基础）

备份（`backupDatabase(db, destinationPath)`）：

1. 前提：该连接不在事务中（否则抛错），且没有其他连接并发写入。
2. `PRAGMA wal_checkpoint(TRUNCATE)`——checkpoint 被阻塞（busy != 0）视为错误。
3. 整库文件复制到目标路径。
4. 用只读连接打开备份并运行 `PRAGMA integrity_check`，不是 ok 即抛
   `BackupError`——备份要么可用要么报错，绝不虚报成功。

恢复（`restoreBackup({ backupPath, databasePath, expectedMigrations? })`）：

1. **关闭所有指向 `databasePath` 的连接**（文件操作看不到打开的连接，
   带连接恢复会损坏状态）。
2. **前置校验（M6-02），先于任何字节拷贝**：文件必须 ≥100 字节且带 SQLite 3 魔数
   （零字节文件会被 SQLite 当成合法空库，`integrity_check` 会说 ok），
   只读打开并 `PRAGMA integrity_check` 必须为 ok；传入 `expectedMigrations` 时
   还会对备份内的 `schema_migrations` 逐条做校验和验证（篡改/异血统/更新架构
   以类型化 `MigrationError` 拒绝）。任一检查失败即拒绝，活库零改动。
   `inspectBackupFile(backupPath)` 可单独用于 runbook 的「先校验再动手」步骤。
3. 删除目标残留的 `-wal`/`-shm`（避免旧 WAL 重放到恢复后的文件上），
   然后用备份覆盖目标文件。
4. 重新 `openDatabase` 并运行 `verifyMigrations` + `PRAGMA integrity_check`。

迁移失败回退：`applyMigrations` 的失败迁移自身回滚（数据库停在旧版本），
`backupPath` 生成的备份用于整体回退到迁移前状态。完整的升级失败恢复 runbook
（含可执行演示）见 `packages/maintenance/README.md`。

## 进程身份与会话原语（M1-03 扩展）

M1-03 为 `executions` 补充了启动后记录进程身份的类型化 setter，均带可选
`wherePhaseIn` 守卫（零行命中抛 `NoRowUpdatedError`，绝不静默覆盖）：

- `setExecutionPidIdentity(db, { id, pidIdentity, wherePhaseIn?, now })`：
  写入 contracts `ProcessIdentity` 形状（pid、creationTime、executionNonce、
  target）的 JSON，读取侧 `readExecutionPidIdentity` 用同一 Schema 重新校验，
  被篡改或不完整的数据会抛错而不是被当作可用身份。
- `setExecutionSessionId(db, { id, sessionId, wherePhaseIn?, now })`：记录
  CLI 汇报的 session/thread id（定位符，不是凭据）。
- `listActiveAttempts(db)`：跨槽位扫描所有 ACTIVE 相位尝试，是启动
  reconcile（M1-05）的查询基元；配合 `markAttemptInterrupted` 释放槽位后
  才允许创建新尝试（A23 语义，测试覆盖）。
- A24 路径：dispatch token 唯一约束保证同一启动命令不会被重放成第二个
  尝试行；重启方通过 `getExecutionByDispatchToken` 找回旧尝试及其
  pid_identity，而不是重新派发。

## 已知边界

- **`node:sqlite` 在 Node 25 仍是实验特性**（会有 ExperimentalWarning）。本包
  engines 为 `node >=25`（与兄弟包的 `>=20` 不同），因为未加 flag 的
  `node:sqlite` 需要较新 Node；仅在 Node v25.0.0 / Windows 上验证过。
- 备份路径假设**备份复制期间无并发写入**（其他连接）。迁移前备份天然满足；
  运行期备份需调用方暂停写入。备份不用于多进程写场景的一致性快照。
- 时间戳必须是 `Date.prototype.toISOString()` 的固定宽度 UTC 形式，否则被
  拒绝——TEXT 时间的字典序比较依赖统一格式。
- Execution phase 的完整状态机校验（FSM）属于 M1-03；本包只保证约束层
  （唯一性、部分唯一索引、CHECK），`setAttemptPhase` 不做转移合法性检查。
- 三级配额、凭据组锁属于 M2-02；本包 `leases` 只提供单资源唯一租约原语。
- `task_runs.task_id` 无外键（`tasks` 表不在 M1-01 最小表集合内）。
- 事件/消息 payload 大小不做限制；按 DOMAIN_MODEL，大 payload 属于文件系统
  而非 SQLite，消费方应存引用。
- 本包**不存储、不哈希任何凭据**（token、API key、认证文件内容），也不做宿主
  配置漂移检测；Profile 相关的漂移检测（M1-02）只能对 Profile 配置中显式列出
  的非凭据文件做哈希，且不属于本包职责。
- SQLite 的 BUSY 在超过 busy_timeout 后以错误浮出；重试策略由调用方决定，
  本包不自动重试。
- 无语句缓存（每次 `prepare`）；对本地单用户守护进程的写入量足够。

## 快速上手

```ts
import {
  applyMigrations, verifyMigrations, openDatabase, withTransaction,
  createProject, createTaskRun, createActiveAttempt, enqueueOutboxMessage
} from "@role-orchestrator/store";

const db = openDatabase("orchestrator.db");
await applyMigrations(db, { backupPath: "backups/pre-migrate.db" });
verifyMigrations(db);

withTransaction(db, () => {
  createProject(db, { id: "proj-1", repoRoot: "h:/repos/demo",
    executionTarget: "windows-native", trustStatus: "requires-user-confirmation",
    now: new Date().toISOString() });
  enqueueOutboxMessage(db, { id: "msg-1", aggregateId: "proj-1",
    type: "project.created", payload: {}, now: new Date().toISOString() });
}); // 业务写入与 outbox 同事务提交
```

## 验证

在本包目录：`pnpm build`、`pnpm typecheck`、`pnpm test`。
测试覆盖：迁移重放安全、校验和篡改检出、迁移失败回滚与迁移前备份、
双连接认领竞争（含 worker 线程真实并发，恰好一个成功）、过期租约必须先
reconcile、outbox 原子回滚/提交、过期 claim 重认领与僵尸 complete 防护、
事件重放幂等与 seq 唯一、备份往返与恢复、A23 崩溃模拟（第二连接观察约束
阻止第二尝试，reconcile 后重试成功）。
