# @role-orchestrator/expand

M4-03 有界修复与复审扩图（ACCEPTANCE A20：「reviewer 连续 fail → 三轮总审查后暂停，无图回边」）。本包实现 `docs/ORCHESTRATION.md` 第 5 节「返工不是有环图」的图侧语义：review 节点的 fail verdict 触发追加「修复节点 + 复审节点」，代数封顶三轮，超限的 run 等待用户，图保持无环。

依赖面：`@role-orchestrator/review`（A12 verdict 查询——扩图的唯一触发证据）、`@role-orchestrator/dag`（组合图复验 + 节点状态机 + 传播）、`@role-orchestrator/scheduler`（`derivedId`）、`@role-orchestrator/store`（事务/迁移框架）、`@role-orchestrator/checkpoint`（迁移链 001..012）、`@role-orchestrator/contracts`（`TaskNodeSchema` / `IdSchema`）。

## 扩图协议

一次扩图 = 一次 `requestReviewExpansion({ runId, reviewNodeId, candidateSha, repairedNodeId?, now })`，按以下 fail-closed 顺序执行：

1. **触发证据（不信任调用方口头 fail）**：`reviewNodeId` 必须是 run 内 role 为 `reviewer` 的既有节点（否则 `NotReviewNodeError`）；`getReviewVerdict({ runId, nodeId, candidateSha })`（M2-05 的 A12 查询）必须返回 `valid` 且 verdict 恰为 `fail`（`none` / `invalidated` / `pass` / `blocked` 一律 `NoFailVerdictError` 拒绝——`blocked` 表示审查未完成，不是自动返工触发器）。
2. **幂等回放**：扩图行以触发三元组 (run, failed review node, failed candidateSha) 为唯一键（`ux_review_expansions_trigger`）。同一 fail 的重复请求返回**同一对节点**（`created: false`），不产生任何新行——即使 run 已被 hold，回放也只是只读应答，不可能“继续”任何东西。
3. **用户 hold**：run 存在未解决的第四轮拒绝记录时，任何新扩图请求以 `RunHeldForUserError` 拒绝（见下“轮数计数与用户 hold”）。
4. **轮数预算**：触发 review 节点的代数 ≥ 3 时请求以 `ReviewRoundsExhaustedError`（`ExpandBudgetExceededError` 的子类）拒绝，并将 run 置入持久 hold。什么都不铸造。
5. **修复目标**：默认取失败 review 节点的**唯一**直接依赖；有 0 个或多个直接依赖时必须显式传 `repairedNodeId`（`AmbiguousRepairTargetError`），且显式目标必须在失败 review 的直接依赖之内（`RepairTargetNotReviewedError`）——修复节点只修复被审查过的东西。修复节点的 role 沿用被修复节点的 role（沿用角色 Profile，`docs/GIT_AND_WORKSPACES.md` 冲突与返工）。
6. **组合图复验（无环与预算门，写前执行）**：把 run 的**全部**已存节点 + 两个新铸定义组成完整 workflow，先过 `parseWorkflowDefinition`（冻结 schema，铸出定义的 title/objective/acceptance 全量受检），再过 `validateWorkflowGraph`（重复 id / 缺失依赖 / 环 / 节点与深度预算，默认 64 节点 / 深度 16）。任何拒绝都是 dag 的原样类型化错误，**零行写入**。
7. **单事务落库**：插入两个 `PENDING` task_nodes 行 + 扩图行，随后 `propagateNodeStates` 完成传播——被修复节点已 SUCCEEDED，故修复节点 `PENDING -> READY`；复审节点保持 `PENDING`。之后走既有 `enqueueReadyNodes -> pollQueue -> engine` 链路正常调度。

新铸节点 id：可读形式 `<被修复节点>-fix-<代数>` / `<被修复节点>-review-<代数>`（第一轮扩图即 `-fix-2` / `-review-2`）；当可读形式超出 64 字符 id 上限时回退为 `derivedId` 哈希形式（同样确定性——确定性是幂等的第二道存储级保障）。

**依赖指向**：修复节点依赖 = [被修复节点]；复审节点依赖 = [修复节点]。失败的 review 节点**不是**修复节点的图依赖——FAILED 是 dag 的阻塞依赖态，把它作为依赖会把要 healing 的分支重新阻塞。原 review 的候选上下文（节点 id、candidateSha、findings）以**持久数据**形式随扩图行存储，并写入修复节点的 objective；失败 review 的旧下游照常被 dag 传播规则阻塞——扩图只新增 healing 节点，从不改写或解锁历史。

## 轮数计数与用户 hold

- 代数定义：原计划中的 review 节点是第 1 代；第 n 代 fail 铸出的复审节点是第 n+1 代。代数从持久扩图行推导（`UNIQUE(run_id, review_node_id)` 使推导成为一次查表），从不从节点 id 拼写猜测。
- 预算：`MAX_REVIEW_ROUNDS = 3`，**含首次审查**（`docs/ORCHESTRATION.md` 第 5 节）。一条返工链最多到达第 3 代复审；第 3 代复审仍 fail 时，第四轮扩图请求被拒。预算按返工链计数（与文档图示一致）；run 内相互独立的 review 链各自封顶三轮。
- 双层防御：类型化 `ReviewRoundsExhaustedError` 之外，迁移 013 的 CHECK 约束（`new_generation <= 3`）使绕过类型层的写入也无法落库。
- **等待用户**：第四轮被拒时写入 `expansion_user_holds`（attempted_generation = 4，reason = `review-rounds-exhausted`）。run 不自动继续：没有第四代节点、没有任何自动入队。唯一出口是显式的 `resolveRunHold({ runId, note, now })`（用户处置记录）；即便解除，预算仍然耗尽——同一第四轮请求依旧被 `ReviewRoundsExhaustedError` 拒绝，且不会重建 hold（吸收进已解决的同一行）。读侧视图 `getRunReviewExpansionState` 返回 `maxReviewRounds` / 已用扩图 / 未解决 hold。

## 无环保证

- **只追加**：扩图器只有 INSERT 路径——任何既有节点的依赖快照都不存在被改写的代码路径；新节点的依赖只指向既有节点（被修复节点、修复节点），因此“新节点成为既有节点的依赖”这一回边方向在构造上不存在。
- **写前复验**：每次扩图前对组合图跑 dag 校验器（含环检测与预算）。即使某个计划的节点恰好字面命名如 `dev_a-fix-2`，也会在组合图复验中以 dag 的 `DuplicateNodeIdError` 拒绝，零行写入。
- **dag 拒绝回边**：尝试把新节点加为既有节点依赖时，dag 在两种形态下都拒绝——新节点尚不存在时是 `UnknownDependencyError`（缺失依赖），已存在时是 `DependencyCycleError`（正长度环）。
- **预算上限**：扩图使节点数/深度超过预算时，dag 的 `GraphBudgetExceededError` 原样传出，同样零行写入（先复验后写，无部分扩图）。

## 复审衔接（A12 语义自然生效）

复审节点是新 id：M2-05 的审查记录按 (run, node, candidateSha) 绑定，新节点名下没有任何旧记录；它对修复产出的**新 candidateSha** 走完整审查协议（只读基线 worktree、一次性验证目录、逐文件不变性断言）。旧 fail 绑定在旧 candidateSha 上——对任何新候选的查询得到 `invalidated`，永不回答 verdict。旧的 pass 同样不适用于新候选：这正是“旧 fail 不适用于新候选”的同一枚硬币。

## 与既有链路的复用

- 修复节点/复审节点是普通 `task_nodes` 行：`enqueueReadyNodes -> pollQueue -> engine（dispatch -> execute）` 原样适用（测试用 `packages/fake-cli` 的 dist bin 做真实子进程验证，从不调用真实 claude/codex）。
- RETRY_PENDING 语义：扩图节点与任何节点一样走 dag 状态机的 `FAILED -> RETRY_PENDING -> READY` 边（守卫式转移、类型化拒绝），之后按既有路径再调度。

## 已知边界

- **verdict 到节点状态的聚合不在本包**：fail verdict 不自动把 review 节点置 FAILED，最终交付门（“要求的最终 Reviewer 通过”才 READY_FOR_DELIVERY）是 run 聚合器（ORCHESTRATION.md 第 3 节）的职责；本包提供的是返工图与轮数预算。
- **修复产出新 candidateSha 的产生不在本包**：fix 执行的 commit 与集成产出的新 candidateSha 属于 M2-04 集成服务；复审节点消费的新候选由该链路提供。
- **队列无 requeue API**：已 COMPLETED/DISPATCHED 的队列条目重新入队属于 M4-04（重试分类与预算）；本包验证扩图节点的正常入队/认领/执行与 dag 重试边本身。
- **hold 的调度强制**：`expansion_user_holds` 是持久、可查询的 run 级等待用户状态；调度器消费 hold 的强制点随 M4-04 预算工作落地。扩图层面，hold 已使一切新扩图请求被拒。
- **图结构存储**：`task_nodes` 只存图结构（id/role/依赖快照），铸出定义的完整字段（title/objective/验收）保存在扩图行 `minted_definitions`（严格 JSON，读取时重新校验）；组合图复验对既有节点使用结构占位定义，只复验结构合法性。
- **迁移链**：`EXPAND_MIGRATIONS` 组合 001..012 + 013（`review_expansions`、`expansion_user_holds`）；请始终经 `applyExpandMigrations` 应用，避免部分链。

## 受控扩图入口（M5-02，A04/A38）

UI/API 发起的扩图走 `requestControlledExpansion({ runId, reviewNodeId,
candidateSha, requesterRoleId, expectedGraphRevision, repairedNodeId?, now })`——
它在 M4-03 协议**之前**加两道只读门，在协议**之后**补两条记录；M4-03 的全部
守卫（触发证据、幂等回放、user hold、三轮封顶、修复目标策略、组合图复验）
原样生效，本入口不重复实现也不绕过它们：

1. **A04 权限门（拒绝原因先落审计再抛错）**：`requesterRoleId` 在 run 所属
   project 的 `role_bindings` 中必须有行且 `canCreateSubtasks = true`
   （ORCHESTRATION.md 第 2 节：动态扩图先由 Agent 提交 Proposal，系统检查其
   角色 canCreateSubtasks）。拒绝以 `ExpansionPermissionDeniedError`（403 层
   自行映射）抛出，`reason` 取 `binding-missing`（无绑定行，fail-closed）或
   `can-create-subtasks-disabled`；**拒绝原因以 `denied-permission` 审计行
   （迁移 017 `expansion_request_audit`）在自己的事务里先落库，再抛错**——
   被拒请求不抹掉自己的证据。
2. **A38 失效传播门**：`expectedGraphRevision` 必须等于当前
   `task_runs.graph_revision`（dag 的 `GraphRevisionConflictError` 携带
   expected + current，客户端可刷新重试）。只读比较，零写入。
3. **委托 M4-03 协议**：`requestReviewExpansion` 原样执行（第 1–7 步）。
4. **provenance 审计**：成功（含幂等回放）后写 `granted` 审计行——UI 的
   Proposal 显示从它读取「谁请求」；扩图行本身仍是"铸了什么"的权威记录。
5. **definition-history 追加（失效传播的落点）**：扩图成功后，把「最新
   revision 行 + 全部扩图行 minted_definitions（按节点 id 去重）」组成的
   完整 workflow 作为**新的** `task_graph_revisions` 行（`source =
   'expansion'`，迁移 016 放宽的词表）追加，乐观锁与编辑同一形态。没有这一
   步，后续 UI 编辑会从缺失铸出节点的旧 workflow 重建定义，扩图节点会被
   静默丢出历史——本入口消除了该不一致，并使扩图本身成为失效传播点：
   其他客户端的下一次请求将得到 409 + 当前 revision。追加在持久冲突时按
   「重读当前 revision + 重新组合」有界重试（扩图是纯追加，对任何更新
   revision 重组都是无损的）；组合图写前过 dag 校验器（A08/预算），失败
   即响亮拒绝。

**读侧**：`listRunExpansionProposals(db, runId)` 返回待处理 Proposal（有
持久 fail verdict、尚未扩图的 reviewer 触发器——findings、拟铸节点 id 与
角色、代数与 `roundsExhausted`、修复目标是否需显式选择），供 UI 的 Proposal
显示使用；`listRunExpansionRequestAudit` 返回 run 的请求审计轨迹。

**迁移**：扩图启用型组合根使用
`applyControlledExpansionMigrations` / `CONTROLLED_EXPANSION_MIGRATIONS`
（001..013 + 015 + 016 + 017）。015 属 dag 的 M5-01（`task_graph_revisions`），
016 重建该表把 `source` 词表放宽为含 `'expansion'`（旧行原样保留），017 是
`expansion_request_audit`；两个新迁移因此从 016 起编。`EXPAND_MIGRATIONS`
保持 001..013 不变，既有消费链的迁移后置条件不受影响。

**新增依赖面**：`@role-orchestrator/runtime-profile`（`listRoleBindings`——
A04 权限门从 role_bindings 读取 `canCreateSubtasks`，不直接 SQL 触碰他包表）。
