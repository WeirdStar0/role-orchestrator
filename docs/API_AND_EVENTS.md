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

## 1. 已实现端点（v1，2026-10-08 对齐）

| 方法与路径 | 行为 | 关键约束 |
|---|---|---|
| GET /api/v1/runs | 任务列表（objective/状态/outcome/时间，创建倒序） | 项目隔离 |
| POST /api/v1/runs | 创建任务并入队驱动（202 `{runId, status:"queued", statusEndpoint}`） | body `{objective, projectDir, workflow?}`；projectDir 逐项 fail-closed（存在/目录/git 仓库）；**无 profileId**（v0.2.1 破坏性变更：任务创建对项目角色绑定只读，四角色绑定不齐 422 ROLE_BINDINGS_INCOMPLETE）；`workflow` 为可选多节点声明（≤64 节点，v1 每任务至多一个 integration 节点，≥2 被 400 WORKFLOW_INTEGRATION_NODE_COUNT 拒绝）；声明本身为 strictObject、只接受 `nodes` 键，未识别键（如 id/name——二者由系统派生，不接受传入）一律 400 INPUT_REJECTED；每节点必填 `{id, role, kind, objective, dependencies}`：`kind` 必填，取 `agent|integration|review`；`dependencies` 必填数组（根节点为 `[]`）；域门：integration 节点须 ≥1 父节点（WORKFLOW_INTEGRATION_WITHOUT_PARENTS）、review 节点须恰 1 依赖且 role=reviewer（WORKFLOW_REVIEW_DEPENDENCY_COUNT／WORKFLOW_REVIEW_ROLE） |
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
| GET /api/v1/projects/role-bindings?projectDir= | 按仓库根只读查项目四角色绑定 | 未登记目录 404 PROJECT_UNKNOWN；已登记但尚未配置绑定的项目 rows 为空（绑定行由事务式 PUT 初始化，四角色均视为未绑定——M11-03 勘误：原「全 null」表述仅覆盖 PUT 初始化后的形态） |
| PUT /api/v1/projects/:id/role-bindings | 一次事务配置四角色绑定 | 恰四个内建角色；profile 须已载入（422 UNKNOWN_PROFILE）；执行目标不匹配 422 |
| GET /api/v1/projects | 已登记项目只读列表（repoRoot+createdAt，创建倒序） | 不含内部 id（内部 id 不进默认视图） |
| POST /api/v1/projects | 项目登记（M11-03）：严格 body `{projectDir}`，按运行创建同款四道 fail-closed 门校验（非绝对路径/不存在/非目录/非 git 仓库→400，逐门拒绝零写入），随后以与运行创建 find-or-create 完全相同的 store 原语+派生 id+平台 executionTarget 落项目行 | 守卫全链（token+Origin+CSRF）；幂等=不 upsert：已登记目录 200 `existing:true` 一字不动；响应不含内部 id（与 GET 列表同纪律）；不触碰角色绑定（绑定写面唯一为 PUT role-bindings）；不建任务不改编排语义；GET 列表行为逐字节不变（M11-03 起 POST 由通用 405 拒绝改为登记面，系本行登记的语义变化） |
| GET /api/v1/setup/status | 首启状态：claude/codex 检测结果（found/path/source）+ profiles 配置状态（源路径/存在/可用 profile 数/启动已载入数）+ 默认四角色绑定模板建议 | 探测纯只读：PATH 逐目录+`~/.local/bin`+npm 全局前缀（仅环境变量，不执行 npm），零 shell/零进程执行/零提权；未发现=如实 not found；响应 shape 经 zod 钉死 |
| POST /api/v1/setup/first-run | 生成默认 profiles.json（推荐组合 coordinator/architect/reviewer→claude、developer→codex；单 CLI 全落该 CLI；maxConcurrency 4/timeoutSeconds 1800/model null/credentialGroup 按 CLI 区分） | body 必须为 `{}`（strict，未知字段 400）；经既有原子写回（校验先行+临时文件+fsync+rename）；幂等=拒绝：已存在可用 profiles 409 PROFILES_ALREADY_CONFIGURED（原文件一字不动，启动后损坏的文件按 replace 修复）；两 CLI 均未发现 422 CLIS_NOT_FOUND（含未发现清单）；无主目录 422 HOME_DIRECTORY_UNAVAILABLE；无 --profiles 接线 409 PROFILE_SOURCE_ABSENT；**不热重载**——响应 `restartRequired: true`，重启 serve 生效；声明但尚不存在的 --profiles 文件是合法首启态（serve 以零 profile 启动并记住源路径，first-run 经原子创建路径落盘） |
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
宣称。POST /api/v1/setup/first-run 的幂等语义为「拒绝」：已存在可用
profiles 时 409 PROFILES_ALREADY_CONFIGURED，绝不覆盖既有可用配置。
常见错误码（实现面）：INPUT_REJECTED（严格 schema 未知字段）、
ROLE_BINDINGS_INCOMPLETE、UNKNOWN_PROFILE、EXECUTION_TARGET_MISMATCH、
PROFILE_DEFINITION_CONFLICT（七字段漂移门 409）、PROFILE_SOURCE_ABSENT、
PROFILES_CONTENT_INVALID（422 内容不过冻结解析器）、PROFILES_ALREADY_EXISTS、
PROFILES_ALREADY_CONFIGURED、CLIS_NOT_FOUND、HOME_DIRECTORY_UNAVAILABLE、
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
