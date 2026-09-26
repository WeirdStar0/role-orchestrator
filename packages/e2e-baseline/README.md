# @role-orchestrator/e2e-baseline

M2-06 · 并行开发端到端基准。**纯测试与基准驱动包，不含产品逻辑**：它把一个
synthetic 示例 workflow 沿真实链路完整走一遍，并把验收矩阵 A09/A11/A12 与
"图、产物、代码基线和日志均可追溯" 钉成可重复运行的测试。

```text
plan (coordinator)
  ├─ frontend (developer) ┐ 并行分支，修改不同文件
  └─ backend  (developer) ┘
        integrate (architect)   <- IntegrationService 合并，产出 candidateSha
              review (reviewer) <- 固定 SHA 审查，verdict 绑定 candidateSha
                    followup (developer)
                          integrate-followup (architect) <- 候选真实变化（A12 前提）
```

前五个节点即 `docs/BACKLOG.md` M2-06 的 plan/design/frontend/backend/review
示例（design 落在 architect 角色的 integrate 节点上）；后两个节点在**同一次
run 内**让候选真实前移——新的 writer 输出被第二次集成真正合并出新的
candidateSha，而不是凭空查询一个捏造的 SHA。

## 链路与验收映射

每一次 `runBaseline` 都按顺序使用各包的公共服务面，无任何旁路：

| 阶段 | 调用 | 覆盖验收 |
| --- | --- | --- |
| 建图 | `dag.createRunGraph`（冻结 Schema 校验 + 角色快照解析，先于一切 spawn） | A08/A03/A02/A34 |
| 调度 | `scheduler.enqueueReadyNodes` + `pollQueue`（原子认领：三级配额 + 凭据锁 + fencing grant + STARTING 尝试 + dispatch outbox） | A07/A33 的端到端观察 |
| 隔离 | `worktree.createWorktree`（固定 baseSha，用户仓库只读快照随结果返回） | A11/A40 |
| 执行 | `engine.startExecution`（`claimedAttempt: true`；fake-cli dist bin 作为真实子进程） | A06/A24/A29 |
| 集成 | `integration.integrateParents`（单 writer task 分支、有序合并、inputSha 集合 + candidateSha） | A09/A10/A25 |
| 审查 | `review.openReviewSession` + `runValidationCommand` + `completeReview`（detached 基线、一次性验证目录、verdict 绑定 candidateSha） | A12/A13 |
| 传播 | `dag.propagateNodeStates` / `transitionNodeState`（READY/RUNNING/SUCCEEDED；失败路径 BLOCKED） | — |

对应测试文件：

- `test/e2e-parallel-baseline.test.ts` — 全链路 SUCCEEDED；并行兄弟同轮认领、
  凭据锁串行化真实执行；候选内容含两个并行输出；store 全量可追溯（事件有序
  且校验和完整、outbox、集成记录、审查记录）。
- `test/a09-multi-parent.test.ts` — 集成记录的 inputSha 集合 = 两个父输出
  （有序）；candidateSha 在 git 祖先与文件内容两层包含全部父输出；后续集成
  把新输出叠加在旧候选之上（C1 是 C2 的祖先）。
- `test/a11-user-repo.test.ts` — 用户仓库（含一个未提交 dirty 文件）全程
  逐字节不变：HEAD/分支/状态指纹与每次建 worktree 前的快照一致；全部 git
  worktree 都在托管根内。
- `test/a12-verdict-tamper.test.ts` — pass verdict 绑定的 candidateSha 与
  集成产物一致；候选真实变化后（C2）旧 verdict 查询返回 `invalidated` 且不
  携带任何 verdict；C1 查询依然 `valid`（精确绑定，不是删记录）。
- `test/repeatable-baseline.test.ts` — 两个独立世界跑同一基准：baseSha、
  各 writer 输出 SHA、candidateSha 链、inputSha 集合、配额行为、审查判定
  逐字段一致（内容与提交身份全部确定，DB 时间来自固定序列时钟）；清理后
  scratch 目录真实消失。
- `test/failure-diagnostics.test.ts` — 把 backend 换成 `error-result` 场景：
  引擎 fail-closed 判 FAILED，驱动器抛 `BaselineDriverError`，现场摘要包含
  失败节点与原因、下游 BLOCKED、保留的 worktree（A40）、最后落库事件；用户
  仓库无损，失败分支上没有任何输出提交。

## 驱动器是什么、不是什么

`runBaseline` 只做基准搬运，所有语义来自各包：

- **节点输出提交是基准替身**。fake-cli 场景输出 synthetic 事件流，按设计不
  写任何仓库文件；`writer-commit.ts`（驱动器侧）把场景声明的文件写入该节点
  的 execution worktree、只 `git add` 这些路径并提交——它代表后续里程碑的
  受控 Git Service 提交步骤（`docs/GIT_AND_WORKSPACES.md` 的"仅提交允许的
  文件"）。提交身份固定，因此相同内容跨世界得到相同 SHA。
- **引擎入口 `claimedAttempt`**。调度器的 dispatch claim 已在同一事务里创建
  尝试行（STARTING），engine 新增的可选输入让启动器核验认领行而不是再插入
  （A23 约束下也不可能再插入）；错配以 `ClaimedAttemptInvalidError` 拒绝。
  缺省 `false`，M1-03 语义不变。
- 失败诊断摘要只含 store 事实（节点状态、执行相位与原因、事件尾部、队列、
  校验和），不含任何推断。

## 已知边界（如实声明）

- **并行分支的真实进程执行被凭据锁串行化**。frontend/backend 是两个
  developer 节点，A01 规定每角色绑定单个 Profile，两者共用 developer
  Profile（同一凭据组）；`claude/codex.credential-isolation` 在能力矩阵中是
  unverified，凭据组并发上限是契约字面量 1。因此基准观察到的是：同一轮里
  两个 READY 兄弟都进入认领，一个被 `quota-full:credential:<组>` 拒绝并按
  重试窗口重试，两个子进程在时间轴上不重叠——这是 A33 的正确产品语义，不是
  基准缺陷。图与队列层面的并行认领、配额仲裁、fencing 与释放/恢复全部被
  真实行使；进程级真并发属于凭据隔离 verified 之后的行为。
- **引擎的 DB 时间戳用墙时钟**（M1-03 既有行为，不在本包控制面内）；驱动器
  自身可控的时间戳来自固定序列时钟，因此跨世界可重复的是 id/SHA/状态，不是
  墙钟列。
- review 基线 worktree 与集成 worktree 遵循 A40：本包不清理它们；整个
  scratch 目录（仓库、托管根、store、配置目录）在测试 teardown 中整体移除。
- `pnpm vitest run` 直跑本包需要先构建依赖链（fake-cli 的 dist bin 是被
  spawn 的真实文件）；仓库根 `pnpm build` 即满足，turbo 管道已按
  `test dependsOn ^build, build` 编排。

## 验证

仓库根目录：`pnpm build`、`pnpm typecheck`、`pnpm test`（turbo 对全部
workspace 包生效）。本包内：`pnpm build`、`pnpm typecheck`、`pnpm test`。
基准环境会记录在测试输出（Node/git 版本随平台变化，仓库状态由 A11 快照
断言保证）。
