# @role-orchestrator/review

M2-05 固定 SHA 审查与验证目录。本包实现 `docs/GIT_AND_WORKSPACES.md`（读者与
测试 / 冲突与返工）中的 Reviewer 语义：审查绑定不可变的 `candidateSha`，测试
运行在一次性验证目录，被审源码在审查会话中逐文件可证不变；verdict 与
evidence 持久化后，只有 `candidateSha` 完全相同的查询才能取回——旧 pass 绝不
适用于新候选（ACCEPTANCE A12/A13）。

依赖面：`@role-orchestrator/worktree`（GitRunner，唯一 spawn 点，argv 数组；
`isInsidePath` 路径守卫）、`@role-orchestrator/integration`（迁移链
001..005 与 `CommitShaSchema`）、`@role-orchestrator/scheduler`（`derivedId`）、
`@role-orchestrator/store`（事务与迁移框架）、`@role-orchestrator/contracts`
（`ReviewSchema` / `ArtifactRefSchema` / `IdSchema`）。

## 审查协议

一次审查会话 = 一次 `openReviewSession` → 若干次
`runValidationCommand` / `recordValidationArtifact` → 一次
`completeReview`（或 `invalidateReviewSession`）：

1. **打开会话**：`rev-parse --verify <candidateSha>^{commit}` 先证明候选存在
   （否则 `ReviewCandidateMissingError`，什么都不创建）；然后
   `git worktree add --detach <path> <candidateSha>` 建立只读基线 worktree
   （`<worktreesRoot>/_review/<run-id>/<node-id>/<review-id>`，经 worktree 包
   的 GitRunner，argv 数组纪律），复核 HEAD 等于 candidateSha。
2. **绑定内容而非仅引用**：立即对基线做逐文件 sha256 清单，并要求检出的文件
   集合与 `git ls-tree -r HEAD` 的路径集合完全一致——清单从会话第一刻起就与
   candidateSha 的树内容绑定，随记录持久化（含逐文件清单、文件数、清单
   digest），读取时严格 re-validate（candidateSha 绑定 + digest 重算）。
3. **验证目录**：被审源码被复制进系统临时目录下的一次性 workspace（前缀
   `ro-review-validation-`），复制后再次与基线清单比对，不一致即失败。所有
   验证命令以 workspace 为固定 cwd 运行；临时产物、缓存、coverage、编译
   产物落在副本里，被审源码物理上不可达。
4. **证据登记**：每次验证命令的退出码、超时标志与输出尾部作为
   `test-result` 产物登记进会话证据；引擎产生的结果（后续里程碑）可用
   `recordValidationArtifact` 登记。
5. **结束会话**：`completeReview` 先做 payload 校验（见下），再跑不变性
   断言，然后以守卫式 UPDATE 落 COMPLETED（verdict + evidenceRefs +
   findings + 全部证据），最后删除一次性 workspace。基线 worktree 保留为
   审查证据（A40：只有显式清理才会移除）。

## candidateSha 绑定语义（A12）

verdict/evidence 存于 store 迁移 006 的 `review_records`（选型见下）。
唯一查询入口 `getReviewVerdict({ runId, nodeId, candidateSha })` 返回三态：

- `valid`：存在 `candidateSha` 与查询完全一致的 COMPLETED 记录——同
  candidateSha 重复查询命中同一条记录（缓存语义），返回 verdict、
  evidenceRefs、findings；
- `invalidated`：该 run+node 存在审查记录但没有一条与查询的 candidateSha
  相同——旧审查属于旧内容，绝不回答新候选；结果只携带记录过的 candidateSha
  集合，不含任何 verdict；
- `none`：该 run+node 没有任何审查记录。

IN_PROGRESS 与 INVALID 记录永远不回答 verdict；漂移产生的 INVALID（A13）
使该候选的审查彻底作废。verdict 的落库同样受绑定约束：payload 的
candidateSha 不等于会话绑定的 candidateSha 时被 `ReviewEvidenceError`
拒绝，记录不受影响。

## 验证目录生命周期（A13）

- 创建：`mkdtemp` 于系统临时目录（前缀 `ro-review-validation-`），从基线
  worktree 以白名单原语复制（跳过 `.git`），复制后清单比对；
- 使用：`runValidationCommand` 将 cwd 钉在 workspace，argv 数组、无 shell、
  带超时（超时 kill 直接子进程并如实记录 timedOut）；
- 断言：`assertBaselineInvariance` 逐文件重算 sha256 与钉住的清单比对，并
  复核 HEAD 仍在 candidateSha——任何 added/modified/deleted 漂移或 HEAD
  移动即 `ReviewBaselineDriftError`；
- 处置：`completeReview` 与 `invalidateReviewSession` 都会删除一次性
  workspace；删除守卫只允许释放 `ro-review-validation-*` 且位于系统临时
  目录内的路径，其余路径一律拒绝。

## verdict/evidence 的落库规则

payload 直接复用 contracts 的 `ReviewSchema`（`verdict` / `candidateSha` /
`evidenceRefs` / `findings`），写入与读取都经其校验，不存在第二份定义；
证据条目复用 `ArtifactRefSchema` 的 id 词汇表，kind 收窄为 `test-result` 与
`report`（审查可引用的证据）。会话级规则镜像
`ExecutionResultSchema` 的 review 检查：`review.evidenceRefs` 只能引用本会话
实际登记的产物。此外：

- `pass` 要求至少一条退出码为 0 的 `test-result` 证据，且没有任何退出码非 0
  的 `test-result`——审查者不能通过自己的证据看到失败还判 pass；
- `fail` 要求至少一条 finding（返工循环需要可修复的内容）；
- `toContractsReview` 把 COMPLETED 记录映射回 contracts 的 `Review` 形状
  （执行结果的 `review` 字段语义），非 COMPLETED 记录映射为 null。

## 持久化选型

verdict/evidence 存 store（migration 006 `review_records`）而不是复用
integration 的清单机制或包内 JSON：GIT_AND_WORKSPACES 将审查报告定位为
TaskRun 级可查询记录（"审查报告必须绑定 candidateSha，候选代码变化后旧通过
结果失效"），M4-03 的修复/复审轮次与 M5-03 的审批/diff 视图都要跨进程查询
"这个 candidateSha 有没有有效 verdict"；挂在受管 worktree 里的文件会随 A40
清理消失。迁移链 `REVIEW_MIGRATIONS = INTEGRATION_MIGRATIONS + 006`，
001..006 需按序套用；`verifyMigrations` 逐条校验 checksum。状态机为守卫式
乐观转移：`IN_PROGRESS -> COMPLETED | INVALID`，终态不再变化。

## 与集成（M2-04）的衔接

`integrateParents` 产出 candidateSha（集成记录 COMPLETED）后，以同一
runId/nodeId/candidateSha 调用 `openReviewSession` 即完成"触发 Reviewer"。
审查会话不创建分支——detached HEAD 钉在 candidateSha 上，是"冻结只读"的
诚实形态；审查通过与否都不移动任何引用。

## 已知边界

- 验证命令仅 kill 直接子进程；完整进程树终止属于引擎 launcher（M0-05）。
  以 `.cmd`/`.bat` 为 argv[0] 的命令会被 Node 拒绝直接 spawn，需给出真实
  可执行文件（与引擎 argv 纪律一致）。
- 只支持常规文件树：submodule（gitlink）与符号链接会使会话以
  `ReviewBaselineUnsupportedError` 失败，而不是假装清单覆盖了它们。
- 证据在 COMPLETED 时随 verdict 一起落库；IN_PROGRESS 会话崩溃即证据丢失，
  但该记录没有 verdict，任何查询都不会拿到半截证据——重新开会话即可。
- `getReviewVerdict` 的 `valid` 要求 candidateSha 精确相等（40 位小写
  hex）；缩写 SHA 不是合法输入。
- 清理：本包只删除自己创建的一次性 workspace；基线 worktree 沿用 A40，
  仅可通过 worktree 包的显式 `discardWorktree` 移除。
- 修复/复审轮次调度（review fail 生成修复节点）与交付 main 属后续里程碑；
  本包不创建节点、不移动分支、不 push。
