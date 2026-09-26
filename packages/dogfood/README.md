# @role-orchestrator/dogfood

M6-04 的受控 dogfood 包：纯测试/驱动包（无产品逻辑），在系统临时目录的隔离 git
fixture 仓库（A11 用户仓库，复用 `@role-orchestrator/e2e-baseline` 的
`createFixtureRepo`，绝不触碰 `H:\role-orchestrator` 本体——它保持非 git 状态）
上，把一个小功能经完整编排链路真实跑通，并把每个失败注入点、恢复动作与验收
观察记录在驱动时间线与 `evidence/` 证据目录里。面向使用者的总入口是根目录的
`USAGE.md`（安装前提、本地页面服务启动、令牌获取、页面导览、常用操作、故障
排查、已知限制与支持范围）；本包是其「受控 dogfood 证据链」一节的可执行依据，
结果报告见 `reports/M6-04-dogfood.md`。

所有 CLI 执行都是已构建的 fake-cli dist bin（dogfood）；从不调用真实
claude/codex，从不读取任何凭据或 CLI 配置文件内容。

## 链路与注入点

```
建图      createRunnableDogfoodRun（冻结快照 + 图 + revision 基线）
调度      scheduler.enqueueReadyNodes -> pollQueue（真实配额 + fencing）
执行      engine.startExecution（fake-cli dist bin 真子进程）
          + writer 输出提交（受控 Git Service 提交步骤的基准替身，见
            e2e-baseline 的 commitNodeOutput）
集成      integration.integrateParents（inputSha 集 + candidateSha）
review    review.openReviewSession -> runValidationCommand -> completeReview
注入 1    首轮 review 的验证命令要求尚不存在的修复文件 —— 有真实内容依据的
          FAIL（verdict 按 A12 绑定 candidateSha）
恢复 1    expand.requestControlledExpansion（A04 发起角色权限 + A38 乐观锁，
          M4-03 三轮封顶/无环复验守卫原样生效）铸造
          integrate-fix-2 + integrate-review-2
注入 2    修复节点首轮执行经 fake-cli `action-proposal` 场景真实提出未授权
          写入（CLI 安全结束，协议判定如实 FAILED；副作用不发生）
恢复 2    checkpoint.openApprovalCheckpoint（节点 WAITING_APPROVAL）->
          A17 拒改探针（改变命令路径的续行被 ApprovalDigestMismatchError
          拒绝，审批/checkpoint/尝试行原样不动）-> 批准 ->
          checkpoint.continueAfterApproval 有限续行 —— 只有这次获准的执行
          真正执行了该写入
注入 3    复审节点的真实调度认领后启动器不再运行 —— 持久状态恰为 A24 窗口
          （attempt STARTING、dispatch outbox 已提交、配额占用、无 pid 身份）
恢复 3    reconcile.reconcileStartup（真实扫描，launch-window 决策无需 OS
          探针）-> dag 桥 -> 节点 RECOVERY_REQUIRED（A22：不自动重跑；
          第二次尝试被 A23 约束拒绝；队列条目保持 DISPATCHED 不回流）->
          listRecoveryItems 人工清单 -> resolveRecoveryItem 人工解决 ->
          显式重试成功，复审对修复候选记录 pass（A12 绑定新 candidateSha）
```

## 与 M5-05 浏览器流程的关系

复用同一 harness 模式（world + 场景单一事实来源 + 泵式调度原语 + 证据目录），
但本包驱动的是链路本身而非浏览器页面。浏览器层的五条用户流程见
`packages/browser-e2e`；跨 CLI 上下文协作见 `packages/context-e2e`。

## 已知边界

- writer 输出提交与「失败尝试的队列/配额簿记」是基准替身（与 M2-06/M5-05
  相同的已披露边界）：受控 Git Service 与恢复侧的自动簿记服务属于后续里程碑。
- 审批「操作员」步骤（批准、解决恢复项）是协议内的显式人工决策点，由驱动以
  记名方式执行，不构成治理状态变更，也不等于自批合并。
- 证据目录 `evidence/` 为真实运行产物（driver.log.txt + dogfood-timeline.json）。
