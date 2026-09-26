# @role-orchestrator/integration

M2-04 多父基线与单 writer 集成。本包实现 `docs/GIT_AND_WORKSPACES.md` 中的
IntegrationService：每个 TaskRun 的 `task/<run-id>` 集成分支有且只有一个
writer（本包的集成 worktree），按拓扑顺序合并全部已接受的父输出，落
inputSha 集合与 candidateSha，并在 git 提交与数据库落账之间提供崩溃核对
（A09/A10/A25）。

依赖面：`@role-orchestrator/worktree`（GitRunner，唯一 spawn 点，argv 数组）、
`@role-orchestrator/dag`（节点状态机）、`@role-orchestrator/scheduler`
（derivedId / 迁移链）、`@role-orchestrator/store`（事务与迁移框架）、
`@role-orchestrator/contracts`（IdSchema）。

## 集成协议

`integrateParents(deps, input)` 一次调用完成一次后继节点的基线装配：

1. **认领**：读取 `integration_records`（UNIQUE(run_id, node_id)，一节点一条
   记录）。已有记录按状态分流：COMPLETED 且 candidateSha 仍可从分支头达达
   则幂等吸收为 `already-integrated`；PAUSED_CONFLICT 再次抛出
   `IntegrationConflictError`（暂停是终态，恢复属后续里程碑）；
   IN_PROGRESS 先走 reconcile 探针（见下）。
2. **worktree 获取**：集成 worktree 固定在
   `<worktreesRoot>/_integration/<run-id>`（下划线前缀不可能是合法 id，因此
   与 `exec/<run>/<node>/<attempt>` 的执行 worktree 永远不会路径冲突）。
   已注册则复用（校验挂接分支）；不存在则
   `git worktree add -b task/<run-id> <path> <baseSha>`（与 M2-03 同形）；
   分支残留而目录丢失时先证明分支仍从 baseSha 可达再挂接，绝不覆盖。
3. **校验目标旧 SHA**：逐父核对 `refs/heads/<exec branch>` 尖端必须等于已
   接受的 outputSha，否则 `ParentOutputMovedError`，此时什么都还没改。
4. **按既定顺序合并**：对每个父执行
   `git merge --no-ff -m <确定性消息> <parentSha>`（顺序即调用方给的拓扑
   序）。已合并过的父在重试中是 git 的 no-op（"Already up to date"），这是
   重试不重复提交的第一层保证。
5. **落账**：分支头记为 candidateSha；先更新 manifest（记录"预期 commit
   SHA"），再以乐观守卫 `state='IN_PROGRESS'` 置 COMPLETED。

冲突路径（A10）：某次 merge 产生未合并条目时，先把记录置为 PAUSED_CONFLICT
（含冲突文件清单、冲突父节点），然后抛出类型化 `IntegrationConflictError`。
全程没有 `--ours` / `--theirs`、没有 abort、没有删除：父分支、父 worktree、
冲突现场（MERGE_HEAD + 冲突标记）全部保留。

## manifest 结构

manifest 持久化在 `integration_records.manifest`（JSON，读取时严格
re-validate），结构由 `IntegrationManifestSchema` 定义：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 恒为 1 |
| `integrationId` | `derivedId("integ", run, node, …有序父SHA)`，确定性 id |
| `runId` / `nodeId` | run 与后继节点 |
| `repoPath` | 用户仓库（分支元数据所有者，只在此做引用级操作） |
| `integrationBranch` | `task/<run-id>`，唯一 writer 分支 |
| `integrationWorktreePath` | `<worktreesRoot>/_integration/<run-id>` |
| `baseSha` | run 的固定基线 |
| `parents` | 结构化 inputSha 集合：`{ nodeId, branch, headSha }`，拓扑序 |
| `candidateSha` | 预期/实际的集成产物 commit SHA；完成前为 null |
| `createdAt` | 记录创建时间 |

确定性提交标识：所有 merge commit 使用固定 author/committer/date 环境
（`DETERMINISTIC_COMMIT_ENV`，2000-01-01T00:00:00+00:00），消息内嵌
integrationId、步数与父 SHA。因此整个集成是 (基树, 有序父集合) 的纯函数：
两个内容相同的独立仓库会得到逐字节相同的 commit SHA（测试有跨仓库断言），
这是崩溃重试"绝不重复提交"的第二层保证。

## 崩溃恢复语义（A25）

`reconcileIntegration(deps, input)` 只读 git、只做一次守卫式补账，输出唯一
verdict：

- `committed`：分支头包含 manifest 记录的 candidateSha —— git 半边已完成，
  补记 DB（IN_PROGRESS→COMPLETED，守卫式 UPDATE，天然幂等），绝不重建
  commit；
- `already-recorded`：COMPLETED 记录且 candidateSha 仍可从分支头到达，复核
  通过；
- `conflict-paused`：A10 暂停态，只查询不动 git；
- `merge-in-progress`：IN_PROGRESS 且 worktree 有未合并条目/未收尾的
  MERGE_HEAD —— 可能是一次未及记录的 A10 冲突，刻意不自动清理（人工检查，
  等待不丢失任何东西）；
- `safe-to-retry`：IN_PROGRESS、worktree 干净、manifest 尚无 candidateSha ——
  重新调用 `integrateParents` 即可，已合并父是 no-op，确定性标识保证产物
  SHA 与中断前完全一致。

覆盖的崩溃窗口（均有测试，用 DB 代理在精确语句处注入进程死亡）：

1. 最后一次 merge 已提交、COMPLETED 落账前 → `committed` 补记；
2. 最后一次 merge 已提交、manifest 更新前 → `safe-to-retry`，重试产出同一
   candidateSha 且分支提交数不增；
3. 冲突已发生、PAUSED_CONFLICT 落账前 → `merge-in-progress`，父分支无损。

## 持久化选型

inputSha 集合与 manifest 存 store（migration 005 `integration_records`）而
不是包内 JSON 文件：GIT_AND_WORKSPACES 将集成记录定位为 TaskRun 级可查询
记录（"保存集成记录与新 candidateSha -> 触发 Reviewer"），审查绑定与恢复
里程碑都要跨进程读它；放进受管 worktree 的文件会随 A40 清理消失，也无法
支撑"git 已提交、DB 未知"的崩溃语义。迁移链
`INTEGRATION_MIGRATIONS = SCHEDULER_MIGRATIONS + 005`，001..005 需按序套用。

## 与 dag/scheduler 的衔接

- `applyIntegrationOutcomeToNode`：PAUSED_CONFLICT 把 PENDING/READY 的后继
  节点守卫式迁移到 BLOCKED（不会带着不存在的基线进入调度）；COMPLETED 不
  改节点状态——节点成功仍属于执行生命周期，桥只做限制不做提升。
- `assertNodeNotIntegrationPaused`：任何要把节点判 SUCCEEDED 的调用方必须
  先过的门；状态机层面 BLOCKED 也没有到 SUCCEEDED 的边。
- scheduler 侧 dispatch token 已改为 `derivedId("dispatch", entry, attempt)`，
  同节点重试不再复用 token（见 scheduler 包 queue.ts 与其测试）。

## 已知边界

- 冲突恢复（人工决策、Developer 修复节点、重新集成）不在 M2-04 范围；
  PAUSED_CONFLICT 与 merge-in-progress 都停在"可查询、无丢失"。
- `merge-in-progress`（未记录的冲突现场）需要人工检查，本包永不自动
  abort/cleanup。
- 集成分支历史在冲突暂停时可能包含冲突父之前已完成的 merge commit——它们
  只含已接受输出，不是数据丢失。
- 集成产物尚不触发 Reviewer（M2-05 的固定 SHA 审查目录承接）。
- 交付到 main、push/PR/部署均不在此包（文档规定 maintainer 受控执行）。
- 集成 worktree 的清理沿用 A40：只有显式 `discardWorktree`，本包不删除任何
  目录。
