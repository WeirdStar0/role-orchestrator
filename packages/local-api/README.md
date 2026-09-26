# @role-orchestrator/local-api

M1-04 的本地鉴权 API 与最小事件页面：仅绑定 `127.0.0.1` 的 `node:http` 服务，
对应验收 `A30`（外部网页请求 localhost API 被 Host/Origin/会话检查阻止）与
`A36`（渲染消毒 + 出进程脱敏；「落盘前脱敏」由 `@role-orchestrator/engine`
的持久化路径在本包之外的写库侧实现，见 `packages/engine/README.md`）。API 路径
形态以 `docs/API_AND_EVENTS.md` 的 `/api/v1` 前缀约定为准；本包只做只读读取与
鉴权骨架，真正的启动编排属于后续里程碑。

## 安全边界

- **只绑定回环**：`server.listen(port, "127.0.0.1")`，listen 之后用
  `server.address()` 断言内核观察到的地址确实是 `127.0.0.1`，否则关闭并抛
  `LocalApiConfigurationError`；每个请求再校验 `socket.remoteAddress` 是回环
  （纵深防御）。
- **会话令牌**：启动时 `crypto.randomBytes(32)` 生成 256 位 base64url 令牌，
  写入仅当前用户可读的令牌文件。位置检查 fail-closed：只允许当前用户主目录
  或用户临时目录（Windows 上即每用户 ACL 边界，文档化的等效机制）；POSIX 上
  写入后用 `stat` 复核 `0600`。令牌只经 `Authorization: Bearer` 头传输，
  不进 URL、不进日志、不写进页面源码。
- **A30 守卫管道**（任一不过即 400/403/405，处理器不会看到伪造请求）：
  1. Host 必须恰好是 `127.0.0.1:<port>` 或 `localhost:<port>` —— 这同时是
     DNS rebinding 防护：`attacker.example` 即使解析到 127.0.0.1，其 Host
     头也不会匹配白名单；无端口、带尾点、`[::1]`、错误端口全部拒绝；
  2. 所有 `/api/*` 请求必须携带 `Authorization: Bearer <token>`（常数时间
     比较）；
  3. Origin 存在时必须是 `http://127.0.0.1:<port>` / `http://localhost:<port>`，
     跨源拒绝；变更类请求必须携带 Origin；
  4. 变更类请求必须携带会话绑定的 CSRF 令牌（`x-csrf-token`，由每启动随机
     secret 对会话令牌做 HMAC 派生，常数时间比较）；
  5. 方法白名单之外（TRACE/OPTIONS 等）一律 405。
- **响应卫生**：所有响应带 `Cache-Control: no-store`、
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、严格 CSP
  （`default-src 'none'`，脚本/样式仅 `'self'`）；从不发送任何 CORS 头。
- **请求日志**：只记录方法、路径与结果，并再次过脱敏；请求头（含令牌）永不
  落日志。

## API 面

| 方法与路径 | 行为 |
|---|---|
| `GET /api/v1/runs/:runId` | 任务运行详情 + 全部尝试（secret 字段投影掉：`dispatchToken`、pid identity nonce 不出进程） |
| `GET /api/v1/executions/:id` | 执行状态（phase/attempt/pid/sessionId） |
| `GET /api/v1/executions/:id/events?after=&limit=` | 事件日志（envelope 形态对齐 `docs/API_AND_EVENTS.md`；`after` 游标、`limit` ≤ 200、未知查询参数拒绝） |
| `POST /api/v1/executions/:id/dispatch` | 变更接口鉴权骨架：鉴权完整（令牌 + Origin + CSRF），通过后如实返回 501 `NOT_IMPLEMENTED`；请求体只接受空对象，未知字段拒绝 |
| `GET /api/v1/runs/:runId/graph` | M5-01 任务图视图：`graphRevision` + 节点列表（nodeId/role/objective/dependencies/state/`editable`），`editable` 只对 PENDING/READY/BLOCKED 为真（A38） |
| `POST /api/v1/runs/:runId/graph/edits` | M5-01 结构化节点编辑：见下节（乐观锁 409 / 运行节点 409 / A02 覆盖字段 403 / A08 落库前 400）；409 体附 `currentGraphRevision` |
| `GET /api/v1/runs/:runId/expansions` | M5-02 扩图 Proposal 视图：pendingTriggers / expansions / unresolvedHold / 预算余量，见下节 |
| `POST /api/v1/runs/:runId/expansions` | M5-02 受控扩图：转发到 expand 包的受控入口（A04 权限 403+审计 / A38 乐观锁 409+当前 revision / A20 三轮封顶 409 / 预算 400），见下节 |
| `GET /api/v1/runs/:runId/approvals` | M5-03 审批视图：每条审批的完整动作要素（argv / 目标 SHA / 基线 / cwd / 冻结 revision / 权限增量 / 风险等级与原因 / 过期时间 / actionDigest）+ 检查点关联 + A17 失效状态，见下节 |
| `POST /api/v1/approvals/:approvalId/decision` | M5-03 审批决策：`{decision: approve\|reject, decidedBy, reason?}`（拒绝必填 reason）；走 approval 包的守卫 CAS，候选已变化/已决定 409 `APPROVAL_INVALIDATED`、已过期 409 `APPROVAL_EXPIRED`；决策不执行动作也不消费审批 |
| `GET /api/v1/runs/:runId/diff?nodeId=` | M5-03 候选 diff：integration record 的 baseSha→candidateSha 统一 diff（数据源 git，GitRunner 只读 `git diff`，输出截断标记）+ A12 三态 verdict 绑定，见下节 |
| `GET /api/v1/runs/:runId/contexts` | M5-03 上下文视图：context bundle 片段清单（层级 / 来源 / trust / 截断标记 / 字节与 hash）+ 每片段 `traceFragment` 追溯，见下节 |
| `GET /api/v1/runs/:runId/diagnostics?format=json\|html` | M5-04 安全诊断导出（A36/A42）：图状态 + 执行 + 事件 + 记忆引用 + 审批记录，先 `redactJsonValue` 再 `redactText` 才落到响应体/文件；JSON 以 attachment 提供（`nosniff` + 严格 CSP，无 script 面），HTML 全部动态文本转义且零 `<script>`，见下节 |
| `WS /api/v1/events/live` | M5-04 实时事件订阅（A39）：升级请求走同一守卫管道；首消息令牌鉴权（或升级头 Bearer）；`subscribe` 带 cursor（`afterSeq` / `afterEventId`）；断线按 cursor 重放、至少一次投递、客户端按 `eventId` 去重；长日志按字节预算分页 + `bufferedAmount` 流控；追平且执行已终态时发送 `execution-terminal`，见下节 |
| `GET /api/v1/session` | 把会话绑定的 CSRF 令牌交给已通过 Bearer 鉴权的页面（页面用它回填 `x-csrf-token`）；未鉴权 403 |
| `GET /` `/app.js` `/app.css` | 静态页面：事件视图 + M5-01 DAG 画布与节点编辑表单 + M5-02 扩图面板 + M5-03 审批 / diff / 上下文面板（无构建，HTML + 原生 JS/CSS 字符串模板） |

错误信封统一为 `{"error":{"code","message"}}`。

## M5-01 任务图编辑（A02/A38）

选型说明：采用**"409 冲突 + 追加式 revision 行"**组合。`task_runs.graph_revision`
是当前 revision；每次图变更必须在请求体里携带 `expectedGraphRevision`，
不匹配返回 409 `GRAPH_REVISION_CONFLICT`（选 409 而不是"自动合并到新
revision"，因为被拒绝的写入者必须重读图后再表达意图，静默重放会掩盖并发
编辑）。变更本身以**新 `task_graph_revisions` 行**记录（完整 workflow JSON），
既有行从不改写，历史可按 revision 重建。

- **A02 三层拒绝**：UI 层 —— 页面脚本 `buildNodeEditPayload` 只从白名单
  （role/objective/dependencies）构造请求体，其他字段名（model/profile/
  profileId 等）在浏览器里直接抛错，永不成为请求字段；渲染出的表单经测试
  钉死为四角色 select + objective + dependencies，无任何 model/Profile 输入。
  API 层 —— 编辑体在 Schema 解析**之前**做覆盖字段扫描（大小写不敏感、
  任意嵌套深度），命中即 403 `PROFILE_OVERRIDE_REJECTED`；其余未知字段才是
  400 `INPUT_REJECTED`。dag/contracts 层 —— patch 走严格 Schema、重建的
  workflow 重新过冻结 `WorkflowDefinitionSchema`（`packages/dag` 测试钉住）。
- **A38 运行节点不可原地修改**：只有 PENDING / READY / BLOCKED 节点接受结构
  编辑；其余状态返回 409 `NODE_NOT_EDITABLE`，历史零改动。视图的 `editable`
  字段驱动画布把锁定节点渲染为提示而非表单。
- **A08 落库前拒绝**：编辑用 patch 重建完整图并重新校验，环 / 自依赖 /
  缺失依赖 / 未知角色分别映射 400 `DEPENDENCY_CYCLE` / `SELF_DEPENDENCY` /
  `UNKNOWN_DEPENDENCY` / `UNKNOWN_NODE_ROLE`；拒绝发生时 revision 与
  revision 行零变化。角色变更还会用 run 的冻结快照重新解析（A34，解不开是
  409 `ROLE_NOT_RESOLVABLE`，编辑不得隐式重绑）。
- **编辑不触发执行**：端点只落库（revision 自增 + `task_nodes` 行更新 +
  新 revision 行 + blocked/ready 重传播），不创建 Execution、不触碰调度
  队列；测试断言编辑前后 `executions` 计数为 0。
- **组合根约定**：run 创建时须调用 dag 包的 `recordInitialGraphRevision`
  封存初始定义，否则该 run 的编辑请求得到 409 `GRAPH_BASELINE_MISSING`
  （完整定义无法从 `task_nodes` 镜像重建；视图仍可正常渲染）。
- **画布**：DAG 用内联 SVG 渲染（节点框 + 依赖边 + 状态配色类
  `node-state-<STATE>`，无 canvas 2D、无外部 JS 库、无构建步骤）；所有
  动态文本（节点 id、状态、objective、属性值）一律走既有 `esc`（去 ANSI +
  HTML 转义），延续 A36 渲染消毒语义；409 冲突在页面上呈现为"请重新加载
  任务图"，绝不静默重试。

## M5-02 受控动态扩图（A04/A20/A38）

UI 发起的扩图**转发**到 `@role-orchestrator/expand` 的 `requestControlledExpansion`
（本包不做扩图决策，只做映射）：A04 权限门（发起角色的 `canCreateSubtasks`
校验，拒绝原因先落审计再抛错）→ A38 乐观锁门（`expectedGraphRevision` 不匹配
即 409，响应体附 `currentGraphRevision`）→ 委托 M4-03 协议（grounded fail
verdict、幂等回放、user hold、三轮封顶、组合图无环复验全部原样生效）→
provenance 审计 + 追加式 definition-history 行。

- **视图** `GET /api/v1/runs/:runId/expansions`：`pendingTriggers`（reviewer
  fail verdict 且尚未扩图的 Proposal——findings、拟铸节点 id、代数、修复目标、
  `roundsExhausted`）、`expansions`（已执行扩图 + 请求人 `requestedBy`，来自
  `granted` 审计行）、`unresolvedHold`（A20 等待用户）、`budget`
  （`maxNodes`/`maxDepth` 当前 64/16 与余量；深度用与扩图器相同的结构占位
  组合图计算）。未知 run 404。
- **请求** `POST /api/v1/runs/:runId/expansions`：体为
  `{ expectedGraphRevision, reviewNodeId, candidateSha(40-hex), requesterRoleId,
  repairedNodeId? }`；成功 201（`created: true`，附 `fixNode`/`reviewNode`/
  `revision`）或 200（幂等回放 `created: false`）。**不触发执行**（测试断言
  `executions` 计数不变）。
- **错误映射**（类型化领域错误 → HTTP，原因在 message，结构化上下文在信封旁）：
  权限拒绝 → 403 `EXPANSION_PERMISSION_DENIED`（`denialReason` 在体中，原因
  已先写入 `expansion_request_audit`，A04）；过时 revision → 409
  `GRAPH_REVISION_CONFLICT` + `currentGraphRevision`（A38，客户端刷新重试）；
  三轮封顶 → 409 `REVIEW_ROUNDS_EXHAUSTED`；run 已 hold → 409
  `RUN_HELD_FOR_USER`；无 fail verdict / 非 reviewer 节点 → 409
  `NO_FAIL_VERDICT` / `NOT_REVIEW_NODE`；预算耗尽（64 节点 / 深度 16）→ 400
  `GRAPH_BUDGET_EXCEEDED`（limit/actual 在 message）；A02 覆盖字段与编辑端点
  同一扫描，命中 403 `PROFILE_OVERRIDE_REJECTED`；未知字段 / 坏 SHA → 400。
- **UI**：页面新增"动态扩图（Proposal）"面板（与 DAG 画布同一 `esc` 消毒、
  同一无构建/无内联 handler 约束）。Proposal 卡片显示谁请求（角色选择器）、
  为什么 fail（findings）、拟新增节点与预算余量；未解决 hold 渲染"等待用户
  显式处理"横幅；`buildExpansionRequestPayload` 白名单
  （requesterRoleId/repairedNodeId）是 A02 的 UI 层；403/409 一律显式提示
  （409 文案带当前 revision 并声明"本次请求已被丢弃，不会静默覆盖"）。
- **组合根约定**：扩图端点要求 run 已应用完整
  `CONTROLLED_EXPANSION_MIGRATIONS`（001..013 + 015 + 016 + 017，见 expand 包）
  且已记录 revision 基线；没有基线的扩图会得到 `EXPANSION_CONFLICT`（409）。

## M5-03 审批、diff 与上下文视图（A17/A12/A16 呈现）

三个视图端点 + 一个决策端点，全部走既有守卫管道（Bearer/Origin/CSRF）与统一
消毒语义。本包只做"呈现 + 映射"，领域判定全部复用既有包：

- **审批视图（A17）** `GET /api/v1/runs/:runId/approvals`：审批列表来自
  approval 包的 `listApprovalsForRun`（读时重算 digest/grading，篡改即
  fail-closed），每条显示 `actionDigest` 构成要素的全部可见项——完整 argv
  （含 argv[0]、保序）、`repo.root/baseSha/targetSha`、cwd、冻结
  profileRevision、派生权限增量（required − granted）、效果维度与写范围、
  所需能力、风险等级 + 原因、过期时间；检查点关联来自 checkpoint 包的
  `listCheckpointsForRun`。节点当前候选 SHA 来自 M2-04 的 integration
  record。
- **A17 失效呈现**：`invalidations` 非空即"不可批准"——`CANDIDATE_CHANGED`
  （审批绑定 targetSha ≠ 节点当前候选：原审批已无法被消费，UI 显示「已失效」
  且不渲染批准按钮；API 层在 CAS 之前直接 409 `APPROVAL_INVALIDATED` 并附
  `currentCandidateSha`）、`EXPIRED`（过期审批不可批准，409
  `APPROVAL_EXPIRED`；PENDING 过期行的 EXPIRED 物化仍由 approval 包完成）、
  `STATUS_*`（已决定/已消费）。拒绝（必须填 reason）对已失效审批仍然开放
  ——拒绝是安全方向。决策绝不执行动作、绝不消费审批（消费仍归检查点续行的
  digest CAS，A17/A18 语义不变，测试钉住决策后 executions 计数为 0 且状态
  仅到 APPROVED）。
- **审批不诱导全局放权（A17 语义延续，结构测试钉住）**：UI 只有对单个
  actionDigest 的批准/拒绝（每个决策表单带 `data-approval-id` +
  `data-approval-digest`）；"全部允许""信任此站点"类全局放权词汇在页面外壳
  与脚本（屏蔽清单字面量之外）零出现（`FORBIDDEN_UI_PHRASES` 钉住）；
  决策体同样先过 A02 覆盖字段扫描（403 `PROFILE_OVERRIDE_REJECTED`），
  `buildApprovalDecisionPayload` 白名单（decision/decidedBy/reason）是 UI 层。
- **候选 diff（A12）** `GET /api/v1/runs/:runId/diff?nodeId=`：数据源是
  M2-04/M2-05 语义的 integration record（`baseSha`→`candidateSha`），diff
  用 worktree 包的 `GitRunner`（唯一 spawn 点、argv 数组、无 shell）执行
  只读 `git diff --name-status/--numstat/-U3`（两个 SHA 均先过 40-hex 校验，
  无注入面）；统一 diff 文本截断封顶（262,144 字符 / 400 文件，超出打
  `truncated` 标记，绝不静默流式全量）。git 现实与库记录不符（如提交被
  回收）→ 409 `DIFF_SOURCE_UNAVAILABLE`；无集成记录 → 诚实返回
  `candidateSha: null`（"尚未产生候选提交"），不是 404；节点不在图中 → 404。
- **A12 verdict 绑定**：diff 响应携带 review 包 `getReviewVerdict` 的三态
  原文——`valid`（结论只对该 candidateSha 有效，UI 显示 verdict + 完成时间
  + 证据）、`invalidated`（candidateSha 已变化：UI 显示「已失效」横幅并列出
  曾记录的 candidate，绝不渲染旧 pass——数据结构本身就不带旧 verdict）、
  `none`（无审查记录）。
- **上下文视图（A16 数据面 → 视图）** `GET /api/v1/runs/:runId/contexts`：
  bundle 清单（contentHash/manifestHash/预算方法与余量/超出标记）+ 每片段
  清单——层级（project_rule > role > task > dependency > memory 及其优先级
  序号）、来源 provenance（kind/id/revision/profileId/commitSha/artifactId）、
  trust 类别（policy / verified-evidence / untrusted-content，memory 永远是
  数据）、字节数与内容 hash、`included`/`omittedReason` 截断标记（超出字节
  预算的片段带 `budget-bytes-exceeded`，规则层永不截断），以及逐片段调用
  context 包 `traceFragment` 的追溯记录。片段内容本身不出视图（以 hash 钉住）。
- **渲染安全**：三个面板全部沿用同一 `esc`（去 ANSI + HTML 转义）——统一
  diff 中若含 `<script>`/伪造标签，只会以惰性文本出现（测试用真实 git
  fixture 的恶意 diff 内容钉住）；trust 以类别徽章呈现，截断以红色标记呈现，
  已失效以「已失效」徽章 + 无操作按钮呈现。
- **组合根约定**：审批/diff/上下文端点要求相应包的迁移已应用（011/012 审批
  与检查点、006 review、007 context、005 integration——完整链即
  `CONTROLLED_EXPANSION_MIGRATIONS`）；diff 端点要求项目 `repoRoot` 是真实
  git 仓库（读不到 diff 时显式 409，绝不显示空 diff 冒充"无变更"）。

## M5-04 事件订阅、cursor 重放与背压（A39/A30）

`WS /api/v1/events/live`（对齐 `docs/API_AND_EVENTS.md` 的 `WS /events/live` 行；
跨 execution 订阅按该文档另用 serverCursor，本里程碑只做单 execution 订阅）。
外部依赖仅新增 `ws` 一个（浏览器/Node 两侧唯一的 WebSocket 实现，升级守卫需要
`noServer` 模式挂到既有 `node:http` 服务上），理由：A39 明确要求 WebSocket。

- **升级守卫（A30 延续）**：upgrade 请求在握手前走与 HTTP 相同的管道——回环
  peer、Host 恰好 `127.0.0.1:<port>`/`localhost:<port>`（DNS rebinding 防护）、
  Origin 白名单（读语义：缺失可，跨源 403）。拒绝时直接在升级 socket 上写
  原始 HTTP 响应（400/403/404/503 + 统一错误信封）。
- **令牌鉴权两条路**：非浏览器客户端可在升级请求带 `Authorization: Bearer
  <token>`（错误令牌在握手前即 403）；浏览器 WebSocket 无法自定义请求头，且本
  服务从不接受 URL 中的令牌（会落日志），因此默认走**首消息鉴权**——连上后第一
  条帧必须是 `{"type":"auth","token":"..."}`，超时关闭 4001，令牌错误关闭 4002
  （常数时间比较，令牌不落日志）。查询串一律 400 拒绝。
- **cursor 重放与去重（A39）**：`{"type":"subscribe","executionId","afterSeq"?|
  "afterEventId"?}` 从 cursor 起重放（`afterEventId` 解析到库内 seq；未知或不属
  于该 execution 的 cursor 关闭 4004）。投递语义是**至少一次**，每帧携带 store
  的 `eventId`（engine 侧为 sha256(executionId+行内容) 派生，重放幂等），客户端
  重连后按 `eventId` 去重即无丢失无重复。**终态必达**：`result_reported` /
  `process_exited` / `lifecycle_outcome` 是持久行，engine 在同一事务里写
  `lifecycle_outcome` 并置终态 phase，所以断线期间发生的终态在重连 cursor 重放
  后必达；追平且执行已终态时再发一帧 `{"type":"execution-terminal","phase"}`
  （轮询持续到连接关闭，迟到的帧也不会被吞）。
- **长日志背压**：重放页来自 store 的 `listEventPageForExecution`——行数与
  **payload 字节预算**双上限（默认 200 行 / 256 KiB，单页最多在内存里放一页）；
  发送泵在 `ws.bufferedAmount` ≥ 高水位（默认 1 MiB）时等待排空再取下一页。
  64 MiB 级合成日志的测试：暂停读端后 daemon 出站队列钉在高水位+至多一页，
  恢复后 16,384 个事件全部恰好一次、seq 连续、`catchup` 收尾。入站帧上限
  64 KiB、禁用 permessage-deflate（避免压缩内存放大）。
- **帧协议**：服务器→客户端 `ready` / `event`（envelope 与 REST 事件路由同构，
  含同一遍 A36 出进程脱敏）/ `catchup` / `execution-terminal` / `error`；客户端
  →服务器 `auth` / `subscribe`（zod strictObject，未知字段拒绝）。每连接一条订
  阅；连接数上限 64；ping/pong 保活（30s，两次未响应即断开）。

## M5-04 安全诊断导出（A36/A42）

`GET /api/v1/runs/:runId/diagnostics?format=json|html` 产出单 run 的诊断包：
图状态（M5-01 视图投影）+ 执行（secret 字段投影视图，`dispatchToken` 与
pid identity 永不入文）+ 全部事件 + 记忆引用（经 A15 授权会话
`MemoryAccess`，绝不裸查询）+ 审批记录（M5-03 视图，读时重验 digest）。复用
M3-04 `exportDiagnosticPackage` 先例的管道：

1. **A42 内容边界（脱敏之前）**：原始会话内容不入导出——`message_delta.text`、
   `result_reported.resultText` 替换为单向 sha256 引用（`textRef`/`resultTextRef`，
   含字节数）；记忆内容只导出 ≤160 字符摘要（带截断标记）+ `contentHash`——
   引用与摘要，非全文；序列化超过 64 Ki 字符的事件 payload 替换为
   `{exportTruncated, payloadSha256, payloadChars}` 引用（截断留痕不静默，大
   内容按 `docs/API_AND_EVENTS.md` 走 artifacts）。
2. **脱敏第一遍**：`redactJsonValue` 深度脱敏结构化文档（序列化前）。
3. **脱敏第二遍**：序列化后的 JSON 文本在**落盘/出进程前**再过 `redactText`
   ——文件 sink（`writeDiagnosticExportFile`，供受控导出与测试读回断言）与
   HTTP 响应体的字节完全相同，sink 永远看不到未脱敏字节。
4. **无可执行内容**：JSON 形态以 `application/json` + `Content-Disposition:
   attachment` 提供，叠加 `X-Content-Type-Options: nosniff` 与严格 CSP，无
   script 注入面；HTML 形态**只从已脱敏文档渲染**——零 `<script>` 元素、零内联
   handler、零 style 属性，所有动态文本经 `sanitizeDisplayText`（去 ANSI +
   HTML 转义），存储型恶意 payload 只能以惰性文本出现（测试用含
   `<script>`/`onerror=`/伪造 secret 的事件与记忆内容钉住）。

## A36 双层消毒

- **落盘前脱敏（第一层，在 engine）**：engine 的持久化路径（协议事件批次与
  `lifecycle_outcome` / `lifecycle_launch_failed` 生命周期事件）在写入 `events`
  表**之前**对 payload 做深度脱敏，含秘密形态的文本进入数据库时已是占位符。
  实现与测试见 `packages/engine`；dogfood 测试直接读回 `events` 表原始行断言
  「库内已脱敏」。
- **出进程脱敏（第二层，纵深防御，在本包）**：脱敏实现是共享模块
  `@role-orchestrator/cli-events` 的 `redact`（本包的 `redactText` /
  `redactJsonValue` 即自该包 re-export）。事件 payload 离开本进程前、以及请求
  日志行写 stdout 前，都会再过一遍脱敏：即使某个非 engine 写入方把秘密原文
  直接写进了库，API 也绝不会把它再读出去。默认模式清单覆盖 `Bearer <token>`、
  `token=`/`api-key=`/`password:` 等键值形态；模式清单可配置
  （`RedactionOptions.patterns`），可选高熵长串扫描默认关闭（熵评分是启发式，
  避免误伤普通 hash）。占位符 `[REDACTED]` 本身不匹配任何模式，脱敏幂等。
- **渲染消毒**（`sanitize.ts` + `page.ts`）：页面所有动态文本先去 ANSI 转义
  序列、再 HTML 转义后才拼入 DOM；服务端附加 CSP 兜底。测试把服务端下发的
  `app.js` 原文放进 `node:vm` 沙箱执行，用 `<script>`、`<img onerror>`、
  伪造 secret 的日志样本断言渲染结果里除页面模板自身的标签外不存在任何裸
  标签（无脚本执行面）。

## 命令

```bash
pnpm --filter @role-orchestrator/local-api build
pnpm --filter @role-orchestrator/local-api typecheck
pnpm --filter @role-orchestrator/local-api test
```

测试包含伪造请求矩阵（错误 Host / 跨源 Origin / 无令牌 / 错 CSRF / 错误方法，
含 M5-04 的 WS 升级拒绝：坏 Host、跨源 Origin、URL 令牌、错 Bearer）、正常回环
请求、监听地址断言、脱敏与转义正反例，以及用 `@role-orchestrator/engine` 驱动
fake-cli dist bin 的端到端 dogfood（真实执行事件经鉴权 API 读出，并经 WS 从
cursor 0 全量重放：无丢失、无重复、终态必达）。M5-04 新增：断线 → 期间产生事件
（含终态）→ 重连 cursor 重放 → 无丢失无重复的回归断言；64 MiB 级合成日志的
背压断言（暂停读端时出站队列钉在高水位内，恢复后全量恰好一次送达）；诊断导出
的落盘前脱敏（读回文件字节断言秘密/transcript/记忆全文零残留）与 HTML/JSON
无可执行内容断言。

## 已知边界

- Windows 不做逐文件 ACL 校验（libuv 无法表达 NTFS ACL）；依赖"令牌文件位于
  每用户目录"这一默认边界，并在 `docs/SECURITY_MODEL.md` 允许的等效机制范围内。
- run/execution/event/graph/expansion/approval/diff/context 视图只读；写路径
  只有 M5-01 图编辑、M5-02 受控扩图转发与 M5-03 审批决策（决策不触发执行，
  消费仍归检查点续行）。WS 订阅（M5-04）是 store 的只读游标流，不写任何状态。
- 实时订阅只覆盖单 execution（cursor 为 per-execution seq / eventId）；跨
  execution 订阅按 `docs/API_AND_EVENTS.md` 需另用 serverCursor，尚未实现。
- 诊断导出要求项目已应用完整 M5 迁移链（记忆引用经 memory-search 的授权会话
  读取，需要其表结构）；导出中超出 64 Ki 字符的事件 payload 以 hash 引用替代
  （大内容按 `docs/API_AND_EVENTS.md` 应走 artifacts）。
- 审批决策的"续行"（消费审批并创建新执行）由引擎的检查点续行链路完成，本包
  不提供该入口；UI 只呈现 APPROVED 状态与其检查点。
- diff 视图信任项目行的 `repoRoot` 为真实 git 仓库；git 命令只以只读 `diff`
  形态执行，且输出有截断上限。上下文视图不输出片段内容本身（以内容 hash
  钉住，需要内容时走受控导出路径）。
