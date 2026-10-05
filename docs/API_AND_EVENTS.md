# API、事件与契约

本文件描述**已实现的本地 API**：local-api serve 进程仅监听回环地址，
每个 API 请求必须携带启动时生成的 256-bit 会话令牌（bearer；令牌写入当前
用户目录 0o600 文件），写操作另需会话绑定的 CSRF 令牌（`GET /api/v1/session`
下发）与同源 Origin；无 CORS 头，跨源读取按构造失败。公共接口统一为
`/api/v1`，请求体为严格 Schema（未知字段默认拒绝，特别是 profileId/model
覆盖与权限扩展字段）；所有响应携带 no-store/nosniff/严格 CSP 安全头，
日志只记录方法、路径与结果并经脱敏。
设计草案期（0.1-draft）预留但**未实现**的端点（如 `POST /runs/:id/pause`、
`POST /runs/:id/cancel`、`POST /nodes/:id/retry`、`POST /projects`、
`POST /tasks`、通用 `POST /executions/:id/recover`）不在下表；实现前不得
按本文件宣称这些能力。run 级取消的生产面 v1 不存在（见 §3）。

## 1. 已实现端点（v1，2026-10-06 对齐）

| 方法与路径 | 行为 | 关键约束 |
|---|---|---|
| GET /api/v1/runs | 任务列表（objective/状态/outcome/时间，创建倒序） | 项目隔离 |
| POST /api/v1/runs | 创建任务并入队驱动（202 `{runId, status:"queued", statusEndpoint}`） | body `{objective, projectDir, workflow?}`；projectDir 逐项 fail-closed（存在/目录/git 仓库）；**无 profileId**（v0.2.1 破坏性变更：任务创建对项目角色绑定只读，四角色绑定不齐 422 ROLE_BINDINGS_INCOMPLETE）；`workflow` 为可选多节点声明（≤64 节点，v1 每任务至多一个 integration 节点，≥2 被 400 WORKFLOW_INTEGRATION_NODE_COUNT 拒绝） |
| GET /api/v1/runs/:id | 任务详情：status+outcome+执行清单 | outcome 字段见 §2 |
| GET /api/v1/runs/:id/graph | 图画布数据（SVG-canvas） | 只读 |
| POST /api/v1/runs/:id/graph/edits | graphRevision 乐观锁节点编辑 | 编辑不启动执行；A02 载体 403、过期 revision 409 |
| GET/POST /api/v1/runs/:id/expansions | Proposal 视图 / 受控动态扩图请求 | A04 权限门 403、A38 乐观锁 409、三轮上限 |
| GET /api/v1/runs/:id/approvals | 审批视图（argv/SHA/权限增量/风险/过期全要素） | 决策前可见完整 digest |
| POST /api/v1/approvals/:id/decision | 按 actionDigest 接受/拒绝 | 候选变化/过期 409；无批量放权 |
| GET /api/v1/runs/:id/diff?nodeId= | 集成候选 vs 基线的 git diff | 只读、封顶 |
| GET /api/v1/runs/:id/contexts | context bundle 片段清单（层级/信任/截断标记） | 不暴露凭据 |
| GET /api/v1/runs/:id/diagnostics?format=json\|html | 脱敏诊断导出 | 字节离开进程前过 redact 管线；HTML 零脚本 |
| GET /api/v1/executions/:id/events | 单执行事件流（脱敏、分页） | envelope 见 §5 |
| POST /api/v1/executions/:id/dispatch | 已退役（410 ENDPOINT_RETIRED） | 派发语义归 POST /api/v1/runs |
| GET /api/v1/profiles | 已载入 profile 只读摘要（id/runtime/executionTarget/model/timeoutSeconds） | 可执行路径与 credentialGroup 不出进程 |
| GET /api/v1/profiles/full | profiles 配置文件源路径+全文+解析结果 | 无配置源进程 409 PROFILE_SOURCE_ABSENT |
| PUT /api/v1/profiles/full | 配置文件守卫下原子写回（临时文件+fsync+rename） | 经既有冻结解析器严格校验；失败原文件一字不动；写回重启 serve 生效 |
| GET /api/v1/projects/role-bindings?projectDir= | 按仓库根只读查项目四角色绑定 | 未登记项目绑定全 null（引导） |
| PUT /api/v1/projects/:id/role-bindings | 一次事务配置四角色绑定 | 恰四个内建角色；profile 须已载入（422 UNKNOWN_PROFILE）；执行目标不匹配 422 |
| GET /api/v1/session | 下发会话绑定 CSRF 令牌 | 已认证页面专用 |
| WS /api/v1/events/live | 实时事件订阅 | 升级走同一守卫管道；首消息认证；cursor 补发至少一次投递、按 eventId 去重；背压分页 |
| GET / app.js / app.css | 工作台静态页面 | 同守卫管道与安全头 |

## 2. TaskRun 状态与 outcome 双字段（M10-04）

`status` 词汇表冻结不变：`PLANNED / RUNNING / READY_FOR_DELIVERY /
DELIVERED / CANCELLED`（由节点状态聚合推断，不从 CLI exit code 推断）。
M10-04 起受控迁移 **018**（`018-task-run-outcome`）为 `task_runs` 增加
`outcome` 列——nullable，非 NULL 时受 SQL CHECK 钉死为
`success / failed / cancelled / blocked` 四值。两字段正交呈现：

- 全部节点 SUCCEEDED → `RUNNING→READY_FOR_DELIVERY` + `outcome=null`
  （`success` 由交付流程拥有）；
- 任一节点 WAITING_APPROVAL → 保持 `RUNNING` + `outcome="blocked"`
  （活阻塞优先呈现）；
- 任一节点 FAILED → 保持 `RUNNING` + `outcome="failed"`
  （状态词汇表无 failed 值，假"执行中"由 outcome 如实呈现）；
- 其余（在途/PENDING）→ `outcome=null`。写幂等（同值跳过）。

取消诚实边界：「取消 → CANCELLED + cancelled」规则钉在 store 写面与
成对专格；产品 v1 无任何 run-cancel 生产面（无路由/UI），未来取消流程
必经此面。GET /api/v1/runs 与 /api/v1/runs/:id 均携带 `outcome`
（null=进行中）；UI 在 RUNNING 旁并列失败/阻塞徽标。

## 3. 驱动与并发（M10-04 起）

serve 进程内统一 RunDriver（M10-02 组合根）以 FIFO 顺序逐个驱动 run；
**单 run 一轮内**配额允许的全部派发经共享泵原语 `Promise.all` 并行同飞
（`dispatchJoin: "parallel"`）。失败隔离：单 run 驱动故障只终止该 run
（catch-per-run），serve 存活；收敛条件仍为全节点终态。并发上限沿用
scheduler 四层约束（global 4 / project 4 / profile.maxConcurrency /
unverified 凭据组 1）零改动；审批暂停不占并发槽（落
WAITING_APPROVAL 时队列条目已 COMPLETED、配额授予已释放）；shutdown
对全部在飞执行统一取消（落持久 CANCELLED）。

## 4. 幂等与错误

读操作天然幂等；POST /api/v1/runs 的重复提交语义为「每次调用都是新
任务」（202），0.1-draft 草案的 Idempotency-Key 头未实现，实现前不得
宣称。常见错误码（实现面）：INPUT_REJECTED（严格 schema 未知字段）、
ROLE_BINDINGS_INCOMPLETE、UNKNOWN_PROFILE、EXECUTION_TARGET_MISMATCH、
PROFILE_DEFINITION_CONFLICT（七字段漂移门 409）、PROFILE_SOURCE_ABSENT、
ORCHESTRATION_NOT_CONFIGURED、WORKFLOW_*（多节点声明合法性族：
DUPLICATE_NODE_ID / SELF_DEPENDENCY / UNKNOWN_DEPENDENCY / CYCLE /
BUDGET / INTEGRATION_NODE_COUNT 等）、GRAPH_REVISION_CONFLICT、
CANDIDATE_CHANGED、APPROVAL_EXPIRED / APPROVAL_INVALIDATED、
ENDPOINT_RETIRED。面向用户的错误包含可操作原因，不回传完整命令环境
或凭据。

## 5. 事件信封

```json
{
  "schemaVersion": 1,
  "eventId": "evt_example",
  "projectId": "project_example",
  "runId": "run_example",
  "executionId": "execution_example",
  "seq": 12,
  "type": "execution.tool_completed",
  "occurredAt": "2026-09-21T00:00:00Z",
  "payload": {
    "toolCallId": "call_example",
    "summary": "Test command completed",
    "exitCode": 0,
    "evidenceRef": "artifact_example"
  }
}
```

示例时间和 ID 为占位数据，不代表真实执行。
每 execution seq 单调；跨 execution 订阅另用 serverCursor，
不能用全局时间戳推导严格先后顺序。
重放允许至少一次投递，客户端按 eventId 去重。
大型内容走 artifacts，事件仅保存引用/hash/摘要。

## 6. 数据与迁移

状态库为 SQLite，schema 经**受控迁移链**版本递增（当前 001..018；
018 即 §2 的 `task_runs.outcome`）。迁移幂等（重放零应用），旧库原位
升级（001 时代、017 时代库均有机位测试覆盖），迁移失败传播且 serve
不启动；expand 包为受控链组合家（001..018 无缝升位）。schema 演进只
走链上新增版本，不改写历史版本定义。
