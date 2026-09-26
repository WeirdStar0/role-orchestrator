# @role-orchestrator/maintenance

M6-02 — 备份、迁移升级与安全清理（A40 / A41）。

本包是守护进程数据库的维护面：**升级失败恢复 runbook（可执行）**、**守护进程迁移组合链**、
**带安全分级的清理清单与回执**。恢复原语（`backupDatabase` / `restoreBackup` /
`verifyMigrations`）属于 `@role-orchestrator/store`；本包把它们组装成操作者可直接执行的流程。

选型说明（内聚性）：备份/校验是 store 的领域原语，因此 restore 前置校验放在 store；
而「升级失败恢复 + 全库清理」需要跨包视野（worktree 语义、approvals、review_records、
integration_records、outbox），放任何单一功能包都会倒置依赖 —— 所以独立成包，
以 `DAEMON_MIGRATIONS`（001..017 组合链）为唯一全链定义点。

---

## 1. 守护进程迁移组合链

每个功能包自带组合列表（如 `CONTROLLED_EXPANSION_MIGRATIONS` = 001..013+015..017），
但没有任何单一包导出守护进程实际运行的全链。本包提供：

- `composeMigrationUnion(lists)` — 按版本去重的并集。**同一版本出现在多个列表时，
  `upSql` 与 `name` 必须逐字节一致，否则抛 `MaintenanceError`**（绝不静默取一边）。
- `DAEMON_MIGRATIONS` — 全部已发布列表的并集 = 001..017（014 由 budget 包补齐）。
- `DAEMON_CHAIN_MAX_VERSION` — 当前 17；**新迁移从 018 起编**。
- `daemonChainChecksums()` — 运维输出用：每个版本的 sha256 校验和。

新增迁移的规则（与仓库约定一致）：

1. 在功能包里定义 `MigrationDefinition`，version 续接 `DAEMON_CHAIN_MAX_VERSION + 1`；
2. 把该包的组合列表加入 `src/chain.ts` 的 `shippedMigrationLists()`；
3. 永不修改已应用迁移的 SQL —— `schema_migrations` 记录的是 `sha256(upSql)`，
   改动即 `checksum-mismatch`（这是故意的防篡改语义，不是障碍）。

## 2. 升级流程（正常路径）

```bash
# 升级前：确保备份落在独立磁盘/目录
applyMigrations(db, { backupPath: "<dbPath>.pre-upgrade.db" })
```

`backupPath` 语义：**存在待应用迁移时**，先对整库做 WAL checkpoint + 文件拷贝 +
integrity_check（三者任一失败则整个升级中止），然后才运行第一个迁移。
每个迁移在独立事务中「先占版本号、再执行 DDL」，失败一起回滚。

## 3. 升级失败恢复 RUNBOOK（A41 后半）

先认错误类型（`MigrationError.kind`）：

| kind | 含义 | 数据库状态 |
|---|---|---|
| `application-failed` | 迁移 SQL 执行失败，事务已回滚 | 停留在前一版本，**数据完好** |
| `already-applied` | 同版本重复应用 | 无变化（幂等拒绝） |
| `checksum-mismatch` | 库内记录与代码定义不符（被改动/被篡改） | **不可再操作**，必须恢复 |
| `unknown-applied-version` | 库比代码新（降级）或历史断层 | 停止，人工裁决 |

### 分支 A：`application-failed`（干净失败）—— 不需要恢复

失败迁移的事务回滚了 DDL **和版本号预留**，`schema_migrations` 没有记录任何东西：

1. `verifyMigrations(db)` 必须返回 ok（版本停在 001..017）；业务数据可读。
2. 修好迁移代码（SQL 错误、缺依赖对象等）。
3. 重新运行升级。**用同一个版本号是合法的** —— 失败的尝试没有留下任何记录，
   这不构成「重放坏迁移」。
4. 再次 `verifyMigrations`，应包含新版本。

### 分支 B：库已损坏 / 升级被撤销 —— 从升级前备份恢复

症状：`checksum-mismatch`、升级后数据异常、或操作者决定放弃本次升级。

1. **停止守护进程，关闭对该库的一切连接。** restore 是纯文件操作，
   在活连接下恢复必然损坏状态。
2. 校验备份（不动任何字节）：
   `inspectBackupFile("<dbPath>.pre-upgrade.db")` —— 打不开 / 小于 100 字节 /
   缺 SQLite 魔数 / `PRAGMA integrity_check` 不为 ok，一律 `BackupError` 拒绝。
3. 恢复（推荐带迁移清单校验）：
   `restoreBackup({ backupPath, databasePath, expectedMigrations: DAEMON_MIGRATIONS })` ——
   在拷贝任何字节之前，对备份内的 `schema_migrations` 逐条校验和验证
   （结构合法但血统不对的库 —— 例如被篡改过的、或别的库 —— 会被类型化拒绝）。
   陈旧的 `-wal`/`-shm` 边车文件会被先删除。
4. 重开连接后验证：`verifyMigrations` ok（001..017）；业务数据可读
   （run/executions/events/memory/outbox/approvals 行数与升级前一致）。
5. 用修正后的迁移代码重跑升级（恢复后没有坏迁移的记录，同一版本号合法）。

### 分支 C：没有可用备份 —— 只能前向修复

如果 018 已经成功应用（有记录）但业务上是错的，**永不回改 018 的 SQL**：
在 019 里写补偿 DDL，并提交 ADR 说明原因。`verifyMigrations` 的校验和纪律
保证历史定义与库内容的一致性是可证明的。

### 可执行验证

runbook 的 A、B 两个分支由 `runUpgradeRecoveryDrill` 在真实守护进程链
（001..017）+ 真实业务数据（run/execution/events/memory/outbox/approval，
全部经各包公开 API 写入）上端到端执行；CLI 入口：

```bash
# 构建后执行（本工作区内）
pnpm build
node packages/maintenance/dist/cli.js upgrade-drill --work-dir <dir>
# 作为依赖安装后也可用 bin：ro-maintenance upgrade-drill
```

报告包含两个场景的逐步骤审计记录（steps）、恢复后 `verifyMigrations` 的版本表、
业务数据完整性断言。`test/backup-drill.test.ts` 与 `test/cli.test.ts` 持续验证。

---

## 4. 损坏备份的拒绝（restore 前置校验）

`restoreBackup`（store 包）在拷贝任何字节前执行四层校验，任一失败都拒绝且活库零改动：

1. 文件存在、不是内存库、与目标不同路径；
2. 大小 ≥ 100 字节且以 `SQLite format 3\0` 开头 —— **零字节文件会被 SQLite 当成
   合法空库，必须先在这里挡掉**；
3. 只读打开 + `PRAGMA integrity_check` = ok（截断/结构损坏在此拒绝）；
4. 传入 `expectedMigrations` 时，对备份内迁移记录逐条校验（篡改/异血统/更新架构在此拒绝，
   返回 `MigrationError`：`checksum-mismatch` 或 `unknown-applied-version` 降级守卫）。

对应测试：`packages/store/test/restore-verification.test.ts`（截断、零字节、垃圾文件、
篡改校验和、降级守卫、恢复后数据完整）。

---

## 5. 安全清理清单（A40）

依据 `docs/GIT_AND_WORKSPACES.md` 交付和清理：「只有已完成、已归档、没有未提交修改
且没有活动引用的 worktree 可自动清理。中断/失败/待审批工作树默认保留。清理先 dry-run
展示，再执行受管路径内删除。」

**`planCleanup(db, git, input)` 是 dry-run 本身**：枚举全部可清理对象并逐项标注安全等级，
不删任何东西。**`executeCleanup(db, git, plan, { confirmations })` 是受控执行**，
返回逐项回执（receipt）。

| 对象类别 | 判定 | 安全等级 | 默认 | 显式确认后 |
|---|---|---|---|---|
| execution worktree | 终态执行 + 无未提交修改 | `auto` | 可清理（保留 exec 分支） | — |
| execution worktree | 有未提交修改（未交付改动） | `require-confirm` | **拒绝** | force 删除 |
| execution worktree | 活跃尝试（PREPARING/STARTING/RUNNING/FINALIZING） | `retain` | 永不（A23 活引用） | 也不行 |
| execution worktree | 注册但目录丢失 / 被锁定 | `retain` | 人工处理（`git worktree prune`/unlock 属维护者） | 也不行 |
| execution worktree | 无 execution 记录的孤儿 | `require-confirm` | 拒绝 | 可清理 |
| integration worktree | run 已 DELIVERED/CANCELLED 且干净 | `auto` | 可清理（保留 task 分支） | — |
| integration worktree | run 未交付 / 有未提交修改 | `require-confirm` | **拒绝** | 可清理 |
| integration worktree | 集成 IN_PROGRESS / PAUSED_CONFLICT（冲突现场） | `retain` | 永不（单写者所有 / 现场保留） | 也不行 |
| 未注册目录 | 引擎根下 git 不认识的目录（创建失败残留），**且不是任何注册 worktree 的祖先目录** | `require-confirm` | **拒绝** | 可清理 |
| 未注册目录 | 注册 worktree 的祖先目录（标准布局 `<run>`、`<run>/<node>`） | 不产生清理项 | 结构容器，永不是清理对象 | — |
| validation workspace | review 终态（证据已在 review_records） | `auto` | 可清理 | — |
| validation workspace | review IN_PROGRESS / 无记录 | `retain` / `require-confirm` | 拒绝 | 仅无记录者可清理 |
| evidence 目录 | 显式 `evidenceRoots` 的子项 | `require-confirm` | **拒绝** | 归档确认后可清理 |
| 临时 DB | 引擎前缀（`ro-store-*` 等）目录/文件 | `auto` | 可清理 | — |
| 活动 DB 及边车 | 当前连接的库文件 | `retain` | 永不 | 也不行 |
| outbox 行 | `published_at IS NOT NULL`（已投递残留） | 默认 `retain`，`cleanPublishedOutboxRows` 开启后 `auto` | 保留 | — |
| outbox 行 | `published_at IS NULL`（未投递） | `require-confirm` | **拒绝**（先修投递，至少一次语义下删行即丢消息） | 可删行 |
| approval 行 | `status='PENDING'`（未消费） | `require-confirm` | **拒绝** | 可删行（回执带 actionDigest 快照） |
| approval 行 | 终态（CONSUMED/REJECTED/EXPIRED） | `retain` | 永不（审批审计记录） | 也不行 |

横切保证：

- **只提出能归属到引擎的对象**：git 注册项、引擎前缀的临时路径、自己拥有表的行、
  显式配置根下的目录。OS 临时根里的无名文件从不进入清单。
- **祖先目录跳过（scanDir 语义，A40 包含性）**：把候选目录归类为
  `unregistered-worktree-directory` 之前，先检查它是否为任何注册 worktree
  路径的祖先（`samePath`/`isInsidePath` 语义：规范化分隔符、大小写对齐的纯字符串
  比较，不依赖路径当前是否存在）。是则**跳过该候选、不产生清理项**——标准布局
  `<root>/<run>/<node>/<attempt>` 的 `<run>` 与 `<run>/<node>` 是结构容器，
  不是「git 不认识的失败残留」（旧文案对含注册 worktree 的目录是虚假陈述）。
  容器内部仍继续扫描：活跃 run 目录下创建失败、未注册的 attempt 残留依然可见、
  仍可按确认清理。
- **乐观状态守卫**：计划与执行之间对象变化 → 逐项拒绝（`uncommitted-changes-appeared` /
  `target-changed-since-plan`），绝不在过期信息上删除。worktree 走 worktree 包
  `discardWorktree` 的既有 A40 语义；DB 行删除在单事务里用守卫 WHERE
  （如 `DELETE FROM outbox WHERE id=? AND published_at IS NULL`）。
- **目录删除前做包含检查**：目标必须仍在计划声明的扫描根内（计划被手改即拒绝）。
- **包含性拒绝守卫（`containment-guard`，删除前最后一道闸）**：任何
  `remove-directory` 执行前，若删除目标内部（含目标本身）包含任何**注册
  worktree 路径**（执行时重新 `git worktree list --porcelain` 刷新，能拦下
  「计划之后才注册进该目录」的竞态）或本计划中任何 `retain` 项的文件系统路径，
  则该删除被拒绝（回执 `refused` + `reasonCode: containment-guard`），绝不递归
  删除。git 无法确认注册表时按失败关闭处理：一律拒绝删除。即使上游归类出错
  （例如旧版本计划把活跃 worktree 的祖先误标为可确认清理项），物理删除前仍有
  这道闸，活跃 worktree 与其目录树保持完整。
- **回执**：每个对象一行 —— `outcome`（removed/deleted/already-absent/refused/failed）、
  `reasonCode`、`confirmed`、`bytesFreed`，以及 totals。默认运行的回执本身就是
  「哪些对象被 A40 挡住」的答案；refused 是回执行，不是异常。
- schema 不足（缺 001/005/006/011 任一表）→ `DatabaseSchemaError`，先跑迁移链。

### CLI

```bash
# dry-run 清单（不删除任何东西）
ro-maintenance cleanup-plan --db <daemon.db> --repo <repo> --worktrees-root <root> \
  [--temp-root <dir>] [--evidence-root <dir>]... [--clean-published-outbox]

# 受控执行：只有 --confirm 点名的 item id 能越过默认拒绝
ro-maintenance cleanup-execute --plan-file plan.json [--confirm <itemId>]...
```

退出码：0 成功；1 操作失败；2 用法错误。计划与回执均为 JSON。

---

## 6. 本包不做什么

- 不自动跑任何清理：守护进程侧只允许调用 `planCleanup` 做展示；
  `executeCleanup` 必须由操作者带着确认清单显式触发。
- 不清理终态审批记录、冲突现场、活跃 writer 的 worktree、活动数据库；
  也绝不递归删除包含注册 worktree 或 retain 对象的目录（`containment-guard`）。
- 不代表维护者做发布/许可决定（见 reports/M6-02 报告中的「待维护者确认」清单）。

## 7. 待维护者确认（M6 纪律：只列出，不代行）

1. 已发布 outbox 残留的保留期策略（当前默认永久保留，`cleanPublishedOutboxRows` 仅显式开启）。
2. evidence 目录在何种归档流程完成后允许 API 清理（当前仅逐项显式确认）。
3. `git worktree prune` / locked worktree 解锁是否纳入后续受控自动化。
4. 清理回执当前作为返回值交给调用方记录；是否需要持久化到新迁移（018+ 的
   `cleanup_receipts` 表）由维护者决定。
