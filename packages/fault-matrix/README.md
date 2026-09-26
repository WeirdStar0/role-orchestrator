# @role-orchestrator/fault-matrix

M4-05 — 恢复故障注入矩阵（recovery fault-injection matrix）。纯测试与矩阵驱动包，
不含任何产品逻辑：它把 M4 批次与更早里程碑交付的恢复语义当作被测对象，在端到端链路

```text
dag 建图 → 调度（pollQueue 认领）→ engine 执行 fake-cli dist bin → worktree
→ integration（单 writer 集成）→ review（固定 SHA 审查）
```

的每个关键边界注入确定性失败，并断言恢复语义：无重复 writer / 重复提交、
未提交代码与审批证据保留、结果未知时 `RECOVERY_REQUIRED` 等待用户、
恢复后链路可继续且结果正确。

## 边界与手段

- **DB 边界**：确定性崩溃代理 `crashOnSqlFragment` / `dbCrashingAt`
  （`packages/integration/test/helpers.ts` 的 M2-04 `dbCrashingOn` 模式推广出
  「注入序号」），在第一条匹配的 `prepare` 语句处抛出 `SIMULATED CRASH`。
  代理之前的所有已提交写入保持不变，之后的从未发生——抛出瞬间的进程状态就是
  真实崩溃现场；落在 `withTransaction` 内时整个事务回滚，正是真实进程死亡的窗口。
- **进程边界**：真实 fake-cli dist bin 子进程（dogfood）、真实
  `taskkill /T /F` 树杀证据、真实 `Win32_Process` 身份探针与真实占位进程
  （M1-05 `scan-processes` 模式）。spawn→记录 PID 窗口按其持久终态
  （STARTING 行无 pid_identity）建模。
- **Git 边界**：临时目录内由测试自建 fixture 仓库（固定作者/日期身份 → 跨仓
  确定性 SHA），同 行冲突父分支、commit 后 DB 前崩溃的三窗口。
- **审批边界**：M4-02 检查点续行（`openApprovalCheckpoint` /
  `continueAfterApproval`）的事务边界与 A17 digest 绑定。
- **重试边界**：M4-04 `requeueForRetry` 受控重排 + 预算 hold（A21/A22）。

每个用例自带 world（临时目录 + 完整迁移链 001..014 =
`EXPAND_MIGRATIONS` + `BUDGET_SCHEMA_MIGRATION`）并在 `finally` 清理；
用例之间无顺序依赖，注册表顺序即固定注入顺序。

## 矩阵-验收映射表

| 用例 | 边界 | 注入点（固定） | 验收 | 断言的恢复语义 |
|---|---|---|---|---|
| `FM-DB-01` | DB | `prepare("INSERT INTO executions…")` 于 PREPARING 事务（序号 1） | A23 | 事务整体回滚；重启扫描零活跃；恢复后同槽位恰好一个有效尝试（SUCCEEDED）；校验和完好 |
| `FM-DB-02` | DB | `prepare("UPDATE integration_records SET state = 'COMPLETED'…")`（序号 1） | A25 | commit 已落地、DB 滞后；`reconcileIntegration` 按 manifest 回填；git log 零新增；重复 reconcile/re-integrate 幂等 |
| `FM-DB-03` | DB | `prepare("UPDATE integration_records SET manifest…")`（序号 1） | A25 | `safe-to-retry`；重试合并已为祖先的父（git no-op）复现同一 `candidateSha`，零重复提交 |
| `FM-DB-04` | DB | `prepare("SET state = 'PAUSED_CONFLICT'")`（序号 1） | A10, A25 | 未记录的冲突场景 → `merge-in-progress` 手工处置；分支仍在接受点；重集成类型化拒绝，绝不自动解冲突 |
| `FM-DB-05` | DB | `prepare("INSERT INTO approval_checkpoints…")` 于 openApprovalCheckpoint 事务（序号 1） | A19 | 审批/检查点/节点迁移三者要么全有要么全无；重放恰好创建一次；原执行终态不动 |
| `FM-PROC-01` | 进程 | STARTING 行无 `pid_identity`（spawn→记录 PID 窗口的持久终态） | A22, A23, A24 | `launch-window-undetermined` → RECOVERY_REQUIRED；A23 约束阻塞第二次尝试（绝不重发启动命令）；条目带副作用证据等人处置；处置后新尝试真实跑通 fake-cli 且 SUCCEEDED |
| `FM-PROC-02` | 进程 | 快照 executable 指向不存在的 direct 可执行（spawn ENOENT） | A21 | `lifecycle_launch_failed` + outbox 证据落盘；launch-failed 分类 `auto`；三次总尝试后 `AttemptsExhaustedError` + 预算 hold，第四次永不发生 |
| `FM-PROC-03` | 进程 | fake-cli `grandchild` 场景 + timeoutSeconds=2 kill 预算（win32） | A26 | 生命周期负载记录真实 `taskkill /PID … /T /F` 且退出码 0；根/子/孙进程经 process-lab 确认全部死亡 |
| `FM-PROC-04` | 进程 | 真实占位进程持有复用 PID，记录身份早于持有者 60s（win32 真探针） | A27 | `pid-reused-identity-mismatch` → 中断尝试；占位持有者存活（不误杀）；marker 记录存储 vs 观察身份；槽位释放 |
| `FM-GIT-01` | Git | 两个父分支修改 `shared.txt` 同一行（确定性冲突） | A10 | `PAUSED_CONFLICT` + 冲突文件清单；双方分支保持接受点；`assertNodeNotIntegrationPaused` 拒绝；节点 BLOCKED 无出边，传播不自愈 |
| `FM-A22-01` | 副作用 | 续行 execution 已提交 dispatch、pid 从未记录 | A22 | RECOVERY_REQUIRED 落节点状态；A23 阻塞第三次尝试；CONTINUED 检查点不能再次授权；recovery 分类零自动重试；propagation 不动 RECOVERY_REQUIRED；哨兵文件从未出现 |
| `FM-APR-01` | 审批 | 续行执行进入 A24 窗口后走完整恢复路径 | A17, A18, A22 | 审批保持 CONSUMED 且绑定同一 execution；digest/批准者/消费时间戳跨 reconcile 与处置逐字节不变；检查点保留单次续行证据；marker 保留副作用证据 |
| `FM-APR-02` | 审批 | `prepare("UPDATE approvals SET status = 'CONSUMED'…")` 于 continueAfterApproval 事务（序号 1） | A17, A18 | 改动呈现动作 → digest 类型化拒绝且零写入；崩溃 → 尝试行/检查点 CAS/审批 CAS/outbox 整体回滚；重放恰好一次成功，二次重放类型化拒绝 |
| `FM-RETRY-01` | 重试 | 每轮 launch 固定 error-result + `requeueForRetry` | A21 | 三次总尝试内受控重排（FAILED→RETRY_PENDING→READY）；耗尽后 `AttemptsExhaustedError` + `attempts-exhausted` hold；冻结 Profile revision 全程不变 |
| `FM-CHAIN-01` | 全链 | alpha 首次尝试固定 error-result（dag→调度→engine→worktree→集成→review） | A21 | 恰好一次失败、一次受控重试；全节点 SUCCEEDED；集成 `candidateSha` 内容同时携带两个父输出；review pass 绑定该 SHA；无残留恢复条目；用户未提交修改完好 |

## 矩阵驱动

`runFaultMatrix()` 按注册表固定顺序一次跑完全部用例，返回经
`MatrixReportSchema`（strict）校验的报告：每条含注入点描述、验收引用、
`pass | fail | skipped-platform`、错误消息与耗时；`renderMatrixReport`
渲染为通过/失败清单。平台门控如实申报：`FM-PROC-03`/`FM-PROC-04` 依赖
Windows 的 `taskkill` 与 `Win32_Process`（A29 拒绝跨命名空间解释 pid），
在其他平台上报告 `skipped-platform`，绝不静默计为通过。

## 测试

```bash
pnpm test        # 本包：三个 vitest 文件（分边界用例 + 一次全矩阵驱动）
pnpm typecheck
pnpm build
```

- `test/db-process-boundary.test.ts` — DB/进程边界逐用例；
- `test/recovery-boundary.test.ts` — Git/A22/审批/A21/全链逐用例；
- `test/matrix-driven.test.ts` — 注册表顺序契约 + 一次全矩阵驱动，报告
  零失败。

dogfood 只使用 `packages/fake-cli` 的 dist bin；全部事件流为 synthetic，
不调用真实 claude/codex，不读取任何凭据或 CLI 配置。fixture 仓库一律由测试
在系统临时目录内用 git 自建（本仓库工作区保持非 git 状态），teardown 使用
白名单原语递归删除（`fs.rm` 在 Node 25/win32 对非 ASCII 路径已损坏，M0-05）。

## 已知边界

- spawn→记录 PID 的崩溃窗口无法在不篡改引擎的情况下在进程内逐指令注入；
  矩阵按 M1-05 先例以该窗口的持久终态（STARTING 且无 pid_identity）建模，
  由真实 `reconcileStartup` 决策。
- `FM-PROC-02` 的 ghost 可执行文件形态是「路径必然不存在」，因此每次尝试
  都确定性失败——这正是 A21 上限断言的输入，而不是 flake。
- 迁移 014 之后的组合链属于后续里程碑；本包按 `@role-orchestrator/budget`
  迁移文档记载的组合模式自行组合 001..014，不新增迁移。
