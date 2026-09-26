# @role-orchestrator/dag

M2-01 的 DAG 校验与节点状态机包。图合法性（A08）与角色解析（A03/A01）在返回
「可执行计划」之前完成，因此在任何 CLI 进程可能被启动之前就已拒绝；
节点状态机与持久化以 `docs/ORCHESTRATION.md` 第 3 节为唯一依据。

## 范围

- **图合法性（A08）**：`validateWorkflowPlan`（原始输入 → 冻结 Schema 解析 →
  图检查 → 拓扑计划）。每个缺陷一个类型化错误：
  - `DependencyCycleError`（正环，错误携带环路径）
  - `SelfDependencyError`（自依赖，单独成类）
  - `UnknownDependencyError`（缺失依赖：依赖 id 在图中不存在）
  - `DuplicateNodeIdError`（重复节点 id）
  - `UnknownNodeRoleError`（未知角色，A03：只有四个内置角色）
  - `WorkflowSchemaError`（Schema 层拒绝：未知字段/覆盖字段 A02/空节点列表）
  - `EmptyGraphError`（绕过 Schema 构造的空节点列表的防线）
  - `GraphBudgetExceededError`（节点/深度预算，默认 64 节点、深度 16，
    来自 ORCHESTRATION.md 第 5 节，可由调用方调整）
- **角色解析（A03）**：计划中用到的每个角色解析到具体 ProfileRevision。
  - `resolvePlanRolesFromBindings`：读当前绑定（计划期可行性检查）；
  - `resolvePlanRolesFromRunSnapshot`：只读 `run_profile_snapshots` 冻结行
    （A34，`createRunGraph` 采用）。五种拒绝语义（missing / unbound /
    multiple / unknown-profile / unknown-revision）复用 runtime-profile 的
    类型化错误，包装为 `PlanRoleResolutionError`（原错误为 cause）。
- **节点状态机**：11 个状态、18 条边，逐条转录自 ORCHESTRATION.md 第 3 节。
  `BLOCKED`、`SUCCEEDED`、`CANCELLED` 无出边；`FAILED -> READY` 必须经过
  `RETRY_PENDING`；`INTERRUPTED -> READY` 必须经过 `RECOVERY_REQUIRED`。
  - `transitionNodeState`：乐观守卫 UPDATE（`whereStateIn`，默认取
    `to` 的合法前驱集合），零行受影响时区分 `NoRowUpdatedError`（行不存在）
    与 `IllegalNodeTransitionError`（当前状态不在守卫集合内）。
  - `computeReadinessTransitions` / `propagateNodeStates`：依赖全部
    SUCCEEDED 才 PENDING -> READY（空依赖视为真）；任一依赖处于
    FAILED / INTERRUPTED / CANCELLED（含传递的 BLOCKED）则置 BLOCKED；
    WAITING_APPROVAL 与 RECOVERY_REQUIRED 不阻塞下游（下游保持 PENDING）。
    RUNNING 与终态永不被传播改写；RETRY_PENDING、READY -> RUNNING 等
    仍是显式调度决定。
- **RECOVERY_REQUIRED（A22 落点）**：节点级状态。判定逻辑完全复用
  `@role-orchestrator/reconcile`（probe / pid identity / side-effect
  evidence）；本包只做结果映射：`nodeActionForReconcileOutcome` 与
  `applyReconcileOutcomeToNode`（interrupted：RUNNING -> INTERRUPTED；
  recovery-required：INTERRUPTED -> RECOVERY_REQUIRED；observed-running：
  不变）。
- **迁移 003**：`task_nodes` 表 —— `UNIQUE(run_id, node_id)`、状态 CHECK
  （与 TS 的 `NODE_STATES` 同源插值）、依赖快照（JSON 数组，
  `json_type` CHECK）、`role_id` CHECK 四角色。经 `applyDagMigrations` /
  `DAG_MIGRATIONS`（001+002+003）应用。
- **图 revision 历史（M5-01，A38）**：迁移 015 `task_graph_revisions` 表
  （`UNIQUE(run_id, revision)`，`source` CHECK，workflow JSON
  `json_type='object'` CHECK）。`DAG_MIGRATIONS` 保持原样（既有多包链条钉住
  了各自的 applied-version 集合）；需要编辑能力的组装根改用
  `GRAPH_EDIT_MIGRATIONS`（001+002+003+015）/ `applyGraphEditMigrations`。
  - `recordInitialGraphRevision`：run 创建时一次性封存初始图定义
    （source "initial"，revision = 当时的 `task_runs.graph_revision`）。
    先纯校验（A03/A08/A02），再与 `task_nodes` 现行行逐一核对（节点集合、
    角色、依赖快照完全一致），已有 baseline 则拒绝。没有 baseline 的 run
    一律拒绝编辑——编辑需要完整定义（objective/title/acceptanceCriteria
    不在 `task_nodes` 镜像里），无法事后重建。
  - `applyGraphNodeEdit`：结构化节点编辑（role / objective / dependencies）
    的唯一入口，顺序见下节。
  - `getLatestGraphRevision` / `listGraphRevisions`：读当前/全历史 revision
    行；行内 JSON 不合冻结 Schema 时抛 `GraphRevisionIntegrityError`
    （读路径即拒绝，覆盖字段永不回流）。

## 编辑拒绝的顺序（`applyGraphNodeEdit`，A38）

1. 严格输入解析：patch 只接受 `role`/`objective`/`dependencies`（至少一项），
   未知字段（含 model/Profile 形态）被 zod strict 拒绝 —— A02 第三层；
2. run 必须存在，且已有 baseline（否则 `GraphRevisionBaselineMissingError`）；
3. `expectedGraphRevision` 必须等于当前 `task_runs.graph_revision`，否则
   `GraphRevisionConflictError`（过期写入者零行受影响，从不合并）；
4. 节点必须存在且状态属于 PENDING / READY / BLOCKED
   （`isNodeStructurallyEditable` / `EDITABLE_NODE_STATES`），否则
   `NodeNotEditableError`（A38 前半）；
5. 用 patch 重建**完整** workflow 后先 `validateWorkflowPlan`（A08/A03/A02
   全部形态，落库前拒绝），再用冻结快照解析全部角色（A34，编辑不得重绑）；
6. 一个事务内：以 `expectedGraphRevision` 为守卫的 `graph_revision` 乐观
   自增、带可编辑状态守卫的 `task_nodes` 行更新（`definition_revision` 推进
   到新 revision 字符串）、新 revision 行追加（source "ui-node-edit"）、
   blocked/ready 重新传播（只触 PENDING/READY）。

编辑不创建任何 Execution、不触碰调度队列——启动仍归既有调度链。

## 启动前拒绝的顺序（`createRunGraph`）

1. `validateWorkflowPlan`（纯函数，零写库）—— A08/A03 全部形态；
2. run 必须存在，且计划用到的每个角色必须能从冻结快照解析（A34）；
3. 全部 `task_nodes` 行（PENDING 初态 + 依赖快照）与首轮 blocked/ready
   传播在**同一个事务**内提交；任何一步失败都不留部分图。

测试以注入探针断言：上述任一形态被拒时，CLI 启动边界的探针计数为 0，
数据库中无任何节点行（见 `test/graph-validation.test.ts`）。

## 与其他包的边界

- `@role-orchestrator/contracts`：`WorkflowDefinitionSchema` / `RoleId` 等
  冻结契约；本包不放宽任何 Schema。
- `@role-orchestrator/store`：迁移框架、`task_nodes` 的底层、
  `NoRowUpdatedError` 等共享错误。
- `@role-orchestrator/runtime-profile`：绑定解析与冻结快照读（A01/A03/A34）。
- `@role-orchestrator/reconcile`：运行期判定；本包只映射判定结果到节点状态。
- Execution（进程尝试）阶段机在 store/engine；TaskRun 聚合状态在 store。
  节点状态与执行阶段是两个生命周期，不共享词汇。

## 已知边界

- `BLOCKED` 无出边：被阻塞分支按 ORCHESTRATION.md 保持阻塞或取消；
  分支续跑属于新 TaskRun 的调度策略，本包不自动复活任何节点。
- 预算（64 节点 / 深度 16）是文档工程默认值，"深度" 按依赖边数解释，
  调用方可通过 `budgets` 调整；Schema 上限 256 节点不变。
- 依赖快照在创建时冻结；revision 行只追加、从不改写。节点编辑
  （M5-01）与受控动态扩图（受控加节点，M5-02）都通过"新 revision 行 +
  乐观锁"落地，本包不提供改写既有 revision 行的入口。
