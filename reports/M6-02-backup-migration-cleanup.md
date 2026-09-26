# M6-02 · 备份、迁移与安全清理

状态：已完成（Developer 视角交付，含自测证据）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M6-02（验收 A40/A41；完成标准「不删除未交付改动，失败迁移有可执行恢复步骤」）。

## 0. 实测环境（本会话真实执行）

| 项 | 值 | 命令/证据 |
|---|---|---|
| OS / Node / pnpm / git | Windows 10.0.26100 x64 / v25.0.0 / 10.14.0 / 2.54.0.windows.1 | `node -v`、`pnpm -v`、git 经 worktree 包 GitRunner（argv 数组，本会话仅作用于 `%TEMP%` 下测试自建 fixture 仓库，未对 H:\role-orchestrator 做任何 git 操作） |
| 冻结面 | `node planning-check.mjs` → exit 0（78/78 冻结文件 sha256 一致；干净副本 self-test exit 0） | 本会话实测 |
| 冻结脚本哈希 | `scripts/validate_bundle.py` sha256 `f829d28605441cdb3dd80de7b4f7c99d60bc10e6b5070984dbc03980f2342a6c`（未触碰） | `sha256sum scripts/validate_bundle.py` |
| 仓库内 self-test | exit 1（`node_modules` 断链扫入，已知保留问题） | `python scripts/validate_bundle.py --self-test` → exit 1，如实记录 |

## 1. 交付内容

### 1.1 store 包扩展：restore 前置校验（A41 前半的一半）

- 新文件 `packages/store/src/restore.ts`：`restoreBackup` 自 `backup.ts` 迁入（避免
  backup→migrations 循环导入；包入口继续 re-export，既有消费者不受影响），并新增：
  - 四层前置校验，任一失败在拷贝**任何字节之前**拒绝且活库零改动：
    存在性/路径检查 → 大小 ≥100 字节 + SQLite 3 魔数（**零字节文件会被 SQLite 当成
    合法空库**，integrity_check 会说 ok——实测发现并堵住的坑）→ 只读
    `PRAGMA integrity_check`（截断/结构损坏）→ 可选 `expectedMigrations`：
    对备份内 `schema_migrations` 逐条校验和验证（篡改→`checksum-mismatch`；
    比代码新→`unknown-applied-version` 降级守卫）。
  - `inspectBackupFile(backupPath)`：runbook「先校验再动手」独立步骤。
- 迁移原语未动（`applyMigrations` 的 `backupPath` 语义、checksum 纪律复用）。

### 1.2 新包 `packages/maintenance`（选型说明）

备份/校验是 store 的领域原语（放 store）；升级失败恢复 + 全库清理需要跨包视野
（worktree A40 语义、approvals、review_records、integration_records、outbox），
放进任何单一功能包都会倒置依赖 → 独立成包。依赖：store、worktree、contracts +
链条上的 12 个功能包（为组合真实守护进程链）。

- `src/chain.ts` — `composeMigrationUnion`（同版本不同 SQL/name 即 `MaintenanceError`，
  绝不静默取边）+ `DAEMON_MIGRATIONS`（001..017 全链，014 由 budget 补齐）+
  `DAEMON_CHAIN_MAX_VERSION`（17，新迁移从 018 起编）+ `daemonChainChecksums()`。
- `src/backup-drill.ts` — **可执行升级失败恢复 runbook**（`runUpgradeRecoveryDrill`）：
  在真实守护进程链 + 真实业务数据（store 实体 API 写 run/execution/events，
  memory 包写 memories，approval 包写 approvals，store 写 outbox）上端到端执行：
  - 分支 A（干净失败）：坏 018（故意的 SQL 语法错误）→ `MigrationError(application-failed)`
    → 库停在 001..017、`verifyMigrations` ok、数据完好 → 修正后的 018 以**同一版本号**
    重放成功（失败尝试未留记录，不构成重放坏迁移）。
  - 分支 B（库损坏→恢复）：带 `backupPath` 升级（备份先于失败写盘并过
    `inspectBackupFile`）→ 篡改 017 校验和模拟损坏 → `verifyMigrations` 拒绝
    （`checksum-mismatch`）→ 关闭全部连接 → `restoreBackup(expectedMigrations)`
    （17 条迁移记录逐一校验）→ `verifyMigrations` ok + 业务数据计数逐一相等 →
    修正后 018 应用成功。步骤全程留 `steps` 审计轨迹。
- `src/inventory.ts` — A40 清理清单（`planCleanup`，纯 dry-run）：八类对象逐项标注
  `auto / require-confirm / retain`（分级表见 `packages/maintenance/README.md` §5），
  只枚举能归属到引擎的对象；缺表（001/005/006/011 任一）→ `DatabaseSchemaError` fail-closed。
- `src/cleanup.ts` — 受控执行（`executeCleanup`）：未知确认 id 在执行任何东西之前
  abort；`retain` 永不执行；`require-confirm` 仅确认其 item id 才执行（A40 门）；
  乐观状态守卫（worktree 变脏→`uncommitted-changes-appeared`，行状态变化→
  `target-changed-since-plan`）；目录删除前包含检查；DB 行删除单事务守卫 WHERE；
  逐项回执 + totals。worktree 删除复用 worktree 包 `discardWorktree`（含 force 语义与
  分支保留）。
- `src/cli.ts` — `ro-maintenance` bin：`upgrade-drill` / `cleanup-plan` /
  `cleanup-execute --plan-file <f> [--confirm <id>]...`，JSON 输出，退出码 0/1/2。
- `README.md` — runbook 全文（迁移组合链、升级流程、失败三分支恢复、损坏备份拒绝、
  清理分级表、CLI、待维护者确认清单；无任何指向本地路径的 markdown 链接）。

### 1.3 A41 / A40 对照

- **A41 前半**（已有任务可读）：带完整业务数据的库 → 模拟升级失败（坏迁移）→
  restore → 迁移与数据完整可读：`runUpgradeRecoveryDrill` 分支 B +
  `packages/store/test/restore-verification.test.ts`。
- **A41 后半**（失败有恢复说明）：runbook 全文在 `packages/maintenance/README.md` §3
  （含分支 C：无备份时只能前向修复，永不回改已应用迁移）；可执行演示为
  `runUpgradeRecoveryDrill`（`test/backup-drill.test.ts` + CLI 测试持续验证）。
- **A40**（默认拒绝自动清理）：分级表 + 测试（见 §2）。「未交付改动」（dirty worktree）、
  「未消费审批」（PENDING approval）、「未投递 outbox」（pending 行）三类默认全部拒绝，
  仅显式确认后可清理；活跃尝试、集成冲突现场、终态审批记录、活动库为 `retain` 永不清理。

## 2. 测试证据（本会话真实执行，退出码以命令为准）

| 套件 | 结果 | 命令 |
|---|---|---|
| store 全包（含新增 7 个 restore 校验测试） | 8 文件 53 测试全过，exit 0 | `pnpm test`（packages/store） |
| maintenance 全包（新增 25 测试） | 5 文件 25 测试全过，exit 0 | `pnpm test`（packages/maintenance） |
| 全仓门禁 build | 28/28 任务成功，exit 0 | `pnpm build`（根目录） |
| 全仓门禁 typecheck | 51/51 任务成功，exit 0 | `pnpm typecheck`（根目录） |
| 全仓门禁 test（第 1 次） | **local-api#test 失败 1 次**（并行负载下 ws-live 用例超时类失败；单包复跑 18 文件 192 测试全过 exit 0）→ 第 2 次全绿 56/56 | `pnpm test`（根目录，两次）；详见 §4 风险 |
| 全仓门禁 test（强制全量重跑） | 见文末「最终门禁」 | `pnpm exec turbo run test --force` |

关键用例（每类对象的默认拒绝 + 显式确认路径均有）：

- 执行 worktree：干净终态 auto（删除后分支保留）/ dirty 默认拒绝、确认后 force 删除 /
  活跃尝试 retain / 目录丢失 retain（manual）/ 孤儿目录 require-confirm。
- 集成 worktree：DELIVERED auto / PLANNED require-confirm / IN_PROGRESS 与
  PAUSED_CONFLICT（冲突现场）retain。
- 验证 workspace：review 终态 auto / IN_PROGRESS retain / 无记录 require-confirm。
- evidence 目录：require-confirm（审计证据，确认前拒绝）。
- 临时 DB：引擎前缀 auto；活动库 retain；无名临时文件永不枚举（实测断言）。
- 队列行：pending outbox 默认拒绝、确认后守卫删除；已投递残留默认保留、opt-in 后
  auto 删除；PENDING approval 默认拒绝、确认后删除且回执带 actionDigest 快照；
  终态 approval retain。
- 乐观守卫：计划后行被投递→`target-changed-since-plan`；计划后 worktree 变脏→
  `uncommitted-changes-appeared`；计划扫描根被手改→`target-outside-scan-root`；
  未知确认 id 在任何删除前 abort。
- 损坏备份：截断 / 零字节 / 非 SQLite 垃圾 / 篡改校验和 / 降级守卫全部拒绝且活库不动。

## 3. 变更文件清单

新增：`packages/maintenance/**`（package.json、tsconfig.json、tsconfig.build.json、
vitest.config.ts、README.md、src/{index,errors,chain,inventory,cleanup,backup-drill,cli}.ts、
test/{helpers,chain,backup-drill,cleanup-plan,cleanup-execute,cli}.test.ts）、
`packages/store/src/restore.ts`、`packages/store/test/restore-verification.test.ts`、
`reports/M6-02-backup-migration-cleanup.md`（本文件）。
修改：`packages/store/src/backup.ts`（迁出 restore，留注释）、`packages/store/src/index.ts`
（+1 行 export）、`packages/store/README.md`（恢复一节更新为四层校验）、
`pnpm-lock.yaml`（pnpm install 登记新包 workspace 依赖）。
冻结面（AGENTS.md、docs/、schemas/、config/、prompts/、project/、根 contracts/、
scripts/、.github/、CHECKSUMS.sha256、根目录既有 .md）：零改动（planning-check 78/78 一致）。

## 4. 风险与未验证项

- **local-api#test 并行脆弱性（如实报告）**：全仓第 1 次 `pnpm test` 中该包 1 次失败
  （turbo 并行负载下 ws-live 类用例）；同包单独复跑 192/192 通过，第 2 次全仓运行
  56/56 通过。该包测试在本任务之前即含真实 WebSocket 计时类用例，本次新增的
  maintenance 套件（git fixture + 多进程）加大了并行峰值负载，可能是诱因之一；
  未定位到 local-api 侧的具体超时阈值，也未修改该包任何文件。第 3 次强制全量
  并行重跑结果见文末（该次所有套件同时真实执行，最能说明问题）。
- `runUpgradeRecoveryDrill` 的 002..017 迁移 SQL 来自各包已发布定义，但 drill 的
  业务数据只覆盖 store/memory/approval 三包 API；integration_records/review_records
  在 drill 中未写真实行（清理套件里以符合 CHECK 约束的 fixture 行覆盖扫描路径）。
- 收集/恢复流程未在真实守护进程（长期运行、多连接）下演练：本任务验证基于
  测试进程内的连接生命周期（关闭连接再 restore 的纪律已由 drill 分支 B 演示）。
- macOS/Linux/WSL 上的路径大小写语义（`canonicalPath` 在 win32 才折叠大小写）未实测，
  逻辑与 worktree 包 `samePath` 保持一致。

## 5. 待维护者确认（只列出，不代行）

1. 已投递 outbox 残留的保留期策略（现默认永久保留）。
2. evidence 目录允许 API 清理前所需的归档流程定义。
3. `git worktree prune` / locked worktree 解锁是否纳入受控自动化。
4. 清理回执是否持久化（018+ 新迁移，如 `cleanup_receipts` 表）。
5. local-api ws-live 并行脆弱性是否需要该包内部串行化/降负载处理（属该包域）。

## 6. 最终门禁（本会话真实命令与退出码）

| 门禁 | 命令 | 结果 |
|---|---|---|
| build | `pnpm build`（根目录） | exit 0，turbo 28/28 任务成功 |
| typecheck | `pnpm typecheck`（根目录） | exit 0，turbo 51/51 任务成功 |
| test（第 1 次，全并行） | `pnpm test`（根目录） | **exit 1：local-api#test 失败 1 次**（其余 52 任务成功）；同包隔离复跑 18 文件 192 测试全过 exit 0 |
| test（第 2 次） | `pnpm test`（根目录） | exit 0，56/56 任务成功（local-api 真实重跑通过） |
| test（第 3 次，**强制全量重跑**） | `pnpm exec turbo run test --force` | **exit 0，56/56 任务成功，0 cached**；28 包逐包计数合计 **1269 测试全过、0 失败、0 skip**（fault-matrix 自报 `15 passed, 0 failed, 0 skipped (platform gate)`） |

总量对账（每一环均有前会话/本会话实测记录）：1232（M6-01 改动前基线，27 包）→
+5（M6-01 补测，M6-01 报告 §5 实测 1237）→ +7（本任务 store restore 校验套件，
store 46→53）→ +25（本任务 maintenance 新包）= **1269**，与强制重跑逐包合计一致；
既有 1232 条全部保持通过。

第 3 次强制重跑使全部 28 个套件（含 local-api 的 ws-live 与 maintenance 的 git fixture 套件）
同时真实并发执行且全绿——第 1 次的 local-api 单次失败判定为并行峰值负载下的偶发
（该包文件本次零改动；详见 §4 风险第一条）。
