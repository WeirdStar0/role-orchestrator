# M9-01 批次报告:点火——POST /api/v1/runs 真实编排(M9-01-BATCH)

日期:2026-10-03 · 执行角色:Developer · 性质:**M9 首个功能批次交付,非发布
动作**——不打 tag、不发 Release、不动远端;发布动作按
`project/RELEASE_PROCESS.md` 由维护者决定。

## 1. Summary

dispatch 501 骨架升级为真实编排入口。`POST /api/v1/runs` 以严格 body
(objective 1..10000 / profileId / projectDir 绝对路径)创建任务:
projectDir 逐项 fail-closed(绝对路径→存在→是目录→git 仓库 HEAD 可解析),
项目/资料档/角色绑定按 repo_root 找建,单节点图(execute/developer,
objective 即用户目标)经冻结快照+图+revision 基线建图(与 M6-05 world
组合根序列一致),serve 进程内串行泵驱动:propagateNodeStates →
enqueueReadyNodes → pollQueue(真实配额+能力门+围栏)→ createWorktree
(A11 隔离,直接用用户目录)→ engine.startExecution(claimedAttempt 组合)
→队列/配额/节点簿记。事件照常经引擎脱敏落库(REST/WS 自动可见);审批卡
照常产生并只走既有审批面,批准后泵执行恰好一次 digest 绑定续行(A17/A19
不变)。`GET /api/v1/runs` 最小任务列表(id/objective/状态/时间,创建倒序);
原 `/api/v1/executions/:id/dispatch` 501 退役为 410 ENDPOINT_RETIRED。
serve 新增可选 `--profiles <file.json>`(冻结 ProfilesFileSchema 的 JSON,
零新增外部依赖);未配置编排的进程对 POST /api/v1/runs 诚实 503。
测试全 hermetic(仅仓库自带 fake-cli),21 文件 218/218 全绿;真实 claude
冒烟链路半程实证(创建→隔离→spawn→流式落库→超时树杀→可查),模型补全
半程因上游持续 503 未完成(如实记录,见 §5)。

## 2. 设计要点(驱动模型决策与理由)

**驱动模型:serve 进程内异步串行泵(单 promise 链)。**

1. **单用户本地优先简单**:`createOrchestrator`
   (`packages/local-api/src/orchestrator.ts`)持一条进程内 promise 链,
   createRun 的全部找建簿记与 driveRun 泵共用该链——互斥天然成立,零锁、
   零竞争窗口;M6-05 driver 的线性 pump 语义如实搬进服务进程,只是把
   「按固定 spec 列表」换成「从 DB 状态推进」。
2. **多 run 并发行为明确**:全局串行 FIFO,链上同时至多一个节点执行;
   调度器自身配额机器(globalMax 4 / projectMax 4 /
   unverifiedCredentialGroupMax 1+围栏令牌+重试窗)原样传入 pollQueue,
   串行只是永不触顶。测试⑤断言两 run 背靠背创建互不破坏。真实并发
   (多链/上限 N)留后续里程碑,调度器侧无需改动。
3. **进程退出不留孤儿**:`LocalApiServer.close()` 首步
   orchestrator.shutdown():closed 置位停链、对每个在飞执行调
   engine.cancel()(既有 killProcessTree 树杀,落 CANCELLED 持久证据)、
   最多等 15s 让簿记结算后才关 WS/HTTP;db.close 仍由调用方
   (runServe shutdown)最后执行。硬杀(TerminateProcess)绕过优雅路径时
   留下的是 A24 窗口持久证据,由既有 reconcileStartup 语义处理,泵绝不
   自动重跑(A22);泵只驱动本进程创建的 run,唯一例外是带「人工经守卫
   端点批准」记录的 checkpoint 续行。
4. **审批安全边界零变化**:泵只做「检测+开卡+续行」,决策权 100% 在既有
   `POST /api/v1/approvals/:id/decision`(该端点自身从不执行动作、从不
   消费审批、从不启动执行的原契约原样保留);续行经 continueAfterApproval
   的 digest 绑定(A17),一次批准恰好消费一次;server.ts 决策结果为
   APPROVED 后调 `orchestrator.onApprovalDecided(approvalId)` 仅是唤醒
   信号。无批量放权。

**profileId 与 A02**:body 的 profileId 是 Project RoleBinding 层选择面
——`runtime-profile/src/no-override.ts` 自己文档声明的 ALLOWED 门
(setRoleBinding/createProfile);图/节点零 profile/model 字段,内部路径
仍过 createTaskRunWithProfileSnapshot 的 assertNoProfileModelOverride;
运行创建时四角色全绑所选 profile(A01 要求四角色可解析;A34 冻结快照使
后续重绑不影响在途 run)。故此路由不跑 findOverrideFieldKey 载体扫描
(扫描会把合法 profileId 403),model 等其它载体由 strict schema 400
拒绝——与 graph-edit/expansion/decision 三面的 403 载体扫描不冲突。

**profile 加载**:组合根选项(LocalApiServerOptions.orchestration);
文件格式为 JSON(冻结 contracts ProfilesFileSchema),`serve --profiles
<file>` 加载——不解析 YAML 因仓库禁增外部 npm 依赖;
config/profiles.example.yaml 仍是人工参考。profile 行 find-or-create
幂等(重启同文件 no-op),同 id 不同定义 409
PROFILE_DEFINITION_CONFLICT(漂移是人的决定不是 upsert);first revision
的 externalConfigFiles 约定=configDir 下实际存在的 settings.json /
mcp.json。ProfileDefinition 在冻结 ProfileConfig 之上多一个进程内可选
invocationArgs(引擎同界 64×4096、引擎层拒 -m/--model),文件加载默认
[]——测试用它注入 fake-cli --scenario,真实 CLI 用 []。未配置编排的
进程:POST /api/v1/runs 503 ORCHESTRATION_NOT_CONFIGURED(诚实拒答)。

**projectDir/基线**:绝对路径(isAbsolute→resolve 归一)→存在→目录→
git rev-parse HEAD 取 baseSha,全 fail-closed;project 行按 repo_root
找建(id=derivedId('proj',repoRoot) 确定性),executionTarget 取运行
平台(win32→windows-native,A29 路径形检查照常);worktreesRoot 为
server 所有 scratch(构造时显式 mkdir,区别于「serve 不隐式建库目录」
纪律——那是针对用户输入路径),serve 场景默认 `<db 目录>/worktrees`。

**图与结果语义**:单节点 execute/developer。产品无 writer-commit /
review-session 能力(那是 e2e-baseline 的测试替身),故 M9-01 不进
integration/review/扩图机器;结果=执行事件流+终态(事件经引擎落库前
脱敏,REST/WS/页面自动可见)。run 状态聚合用既有词汇表:PLANNED→
RUNNING(泵拾起)→READY_FOR_DELIVERY(全节点 SUCCEEDED);节点失败
run 留 RUNNING(词汇表无失败值,证据在节点行/执行行,泵不发明状态);
WAITING_APPROVAL 停靠由节点态承载。objective 持久化在
task_graph_revisions 的冻结工作流 JSON(task_nodes 镜像无 objective 列),
列表端点由此读回,跨重启可查。

**dispatch 501→410**:同路由语义升级——该路径仍被路由识别(守卫管道
照常,无 CSRF 仍 403),POST 一律 410 ENDPOINT_RETIRED+指向
POST /api/v1/runs,旧客户端得机器可读迁移信号而非 404/501;不再读 body。

## 3. 变更文件(16 个,git status 实录)

新增:
- `packages/local-api/src/orchestrator.ts` —— 编排承载(建图/找建/
  串行泵/审批续行);
- `packages/local-api/test/runs-orchestration.test.ts` —— 5 组端到端;
- `reports/M9-01-BATCH.md` —— 本报告(不入冻结面清单,V0.1.1-BATCH 同口径)。

修改:
- `packages/local-api/src/server.ts` —— POST+GET /api/v1/runs、dispatch
  501→410、决策 APPROVED 后泵 nudge、close() 先 cancel 执行链;
- `packages/local-api/src/views.ts` —— listRunSummaryViews;
- `packages/local-api/src/serve.ts` —— `--profiles` 严格解析+编排装配;
- `packages/local-api/src/index.ts` —— 导出+文档;
- `packages/local-api/package.json` —— dependencies 增 engine/scheduler/
  runtime-profile 三个 workspace 包(devDeps 相应移出);外部依赖计数
  不变,零新增外部 npm 依赖(pnpm install 实跑,lockfile 仅 importer 段
  workspace 链接移动);
- `packages/local-api/test/helpers.ts` —— 导出 makeConfigDir;
- `packages/local-api/test/serve.test.ts` —— +4 格(--profiles 解析/
  runServe 无编排 503/带编排 fail-closed 400/profiles 文件坏 schema 拒启);
- `packages/local-api/test/server-matrix.test.ts`、
  `packages/local-api/test/server-dogfood.test.ts` —— dispatch 断言
  501→410(无 CSRF 403 断言照常保留);
- `CHANGELOG.md` —— Unreleased/Added 条目;
- `CHECKSUMS.sha256` —— CHANGELOG 行(5c08bb81→567f7095,纯 LF 重算)
  与 PROPOSALS 行(本批披露节)同步;
- `PROPOSALS.md` —— 治理披露节(§治理同步);
- `pnpm-lock.yaml` —— importer 段链接移动。

## 4. 实际执行的测试及退出码(2026-10-03 本会话实跑)

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --filter @role-orchestrator/local-api run typecheck` | 0 | 通过 |
| `pnpm --filter @role-orchestrator/local-api run test` | 0 | 21 文件 218/218(批前 209,恰增 9 断言) |
| `pnpm --filter @role-orchestrator/local-api run build` | 0 | dist 构建成功 |
| `node packages/release-audit/dist/cli.js secrets .` | 0 | verdict known-reservations-only;scannedFiles 1830/textFiles 1316/binaryFiles 513/oversizedSkipped 1;findings 37=6 known-fake-sentinel+31 test-sentinel;needs-judgment=0。口径披露:其中 .zcode 会话产物 2 条均 known-fake-sentinel,排除 .zcode 即 35 条——两口径零 needs-judgment |
| `node planning-check.mjs` | 0 | (a) CHECKSUMS 逐文件 +(b) 干净副本 self-test(本批触及冻结面 CHANGELOG/PROPOSALS/CHECKSUMS 故加跑) |

测试内容(全 hermetic,仅 fake-cli dist bins,绝不真调 claude/codex):
runs-orchestration.test.ts 五组——①建 run 201→泵驱动→run 详情
SUCCEEDED(pid>0,attempt1)+READY_FOR_DELIVERY+graph+事件含
started/result_reported/process_exited;②10 失败格(schema 5×
INPUT_REJECTED+域 5×typed 400)且列表零新增;③守卫:无 token→403
TOKEN_REQUIRED(既有 shipped 行为,防探测设计)、无/错 CSRF→403、
无编排进程→GET 200+POST 503;④审批全链:proposal profile 驱动→执行
FAILED 仅提案→审批卡 actionable PENDING(argv 全量先于决策可见)→
决策端点 approve→APPROVED→泵续行 attempt2 消费审批 CONSUMED→再提案
再停靠、提案副作用文件全程不存在(A19);⑤两 run 背靠背串行 FIFO 互不
破坏、双方 SUCCEEDED、列表倒序+objective 正确、
verifyEventChecksums(db)===[]。既有 21 文件全绿(ws-dogfood/
ws-backpressure/ws-replay/matrix/dogfood 观测面等)。

## 5. 真实 CLI 冒烟结果(2026-10-03 实跑,不入门禁)

**attempted-real,ended FAILED by sustained upstream 503——链路成功、
模型补全 unverified。**

- 环境:`where claude`→C:\Users\star\.local\bin\claude.exe
  (`claude --version`=2.1.281);codex 0.147.0-alpha.6.6 备而未用;
  fixture=临时真实 git 仓库(init+commit 26525755c9f3);profiles.json
  指向真实 claude.exe(configDir=C:/Users/star/.claude 仅存在性探测,
  零凭据读取;timeoutSeconds=180,extraArgs=[])。
- run1:POST /api/v1/runs→201;started(sessionId=efe82b61…,
  model=claude-opus-5[1m],permissionMode=default,cwd=worktree 隔离
  路径)→10×api-retry 全部 errorStatus 503(指数退避 534ms→38853ms)
  →process_exited exitCode 1→FAILED(nonzero-exit/missing-final-result/
  timeout,timedOut:true,killEvidence=taskkill /PID 96972)。
- run2(复核瞬时性):完全同型——10×503→exit 1→FAILED。判定为持续的
  上游服务不可用(认证已通过、会话已建立;非产品缺陷:重试与树杀按设计
  工作)。按 ask 预授权类别(配额/环境不支持)如实记录并停止,不伪造。
- 链路断言:run 详情/executions/events/approvals(空)/runs 列表
  (objective 正确回显)全部 200;超时树杀真实触发;无孤儿进程;
  冒烟临时目录已清理。
- 结论:真实 CLI 的「创建→隔离→spawn→流式落库→超时树杀→可查」半程
  已实证;「真实模型补全→result_reported→SUCCEEDED」半程待上游恢复后
  由维护者以同一 `--profiles` 方式重跑。

## 6. 未验证项(如实登记)

1. 真实模型补全半程(见 §5)。
2. codex 真实冒烟未执行(claude 已暴露上游不可用,同窗口跑 codex 大概率
   同因失败,未消耗额外真实调用)。
3. M9-01 run 的事件可见性以 REST 断言;WS /api/v1/events/live 对一次
   真实 M9-01 run 的直播未单独断言(WS 读同一落库行,ws-* 套件全绿为
   同路径间接证据)。
4. 桌面壳侧链:bundle:serve 未重跑,壳 spawn 的 serve-bundle.mjs 尚不含
   --profiles 能力;壳到「建任务→看结果」的贯通属 M9-02。
5. 并发>2 的 run、泵执行中途 serve 被硬杀后的 reconcile 恢复路径未构造
   测试(串行语义只对 2-run FIFO 断言;硬杀留 A24 窗口由既有 reconcile
   语义处理)。
6. reject 路径(审批被拒)后节点停留 WAITING_APPROVAL(被拒审批不可
   消费、状态机无失败型 run 状态)——行为如实,未构造端到端格。
7. externalConfigFiles「按存在性纳入」约定在真实配置目录下的漂移检测
   行为未触发(mcp.json 不在,空清单)。

## 7. 风险

- **串行泵吞吐**:单进程同时至多一个节点执行;多任务排队等待。对单用户
  本地场景可接受,若 M9-02 后出现并行诉求,调度器配额已就绪,泵需改为
  有界并发(改造点集中:enqueue/driveRun 的链结构)。
- **被拒审批的死端**:审批 reject 后节点永停 WAITING_APPROVAL,无重试/
  取消入口(M9-01 范围外);UI 需如实展示该状态,后续里程碑提供
  取消/重排入口。
- **失败 run 的状态语义**:run 级状态无失败值(词汇表限制),失败证据在
  节点/执行行;M9-02 UI 需按节点态渲染,勿把 RUNNING 误读为进行中。
- **真实 CLI 的中途审批暂停**(claude.mid-run-approval-in-noninteractive,
  M0 已知):default 权限模式下工具调用可能挂起至杀预算;冒烟未到达该
  阶段,真实使用时由 timeoutSeconds 兜底。
- **--profiles 文件**为明文 JSON,含可执行路径不含凭据;文件权限沿用
  所在数据目录的 ACL,未额外收紧(与 db 文件同目录同保护面)。

## 8. M9-02 交接说明(工作台 UI 端点契约)

全部端点走既有守卫管道:Bearer 会话令牌(Authorization: Bearer <token>,
token 文件由壳持有)+Origin 必须为 `http://127.0.0.1:<port>`+mutating
请求必须带 `x-csrf-token: <GET /api/v1/session 返回的 csrfToken>`。
响应统一带安全头;错误封装 `{"error":{"code","message"}}`。

### POST /api/v1/runs(创建任务;mutating,需 CSRF)

请求 body(strict,未知字段 400 INPUT_REJECTED):

```json
{
  "objective": "string,1..10000 字符,不可全空白",
  "profileId": "string,^[a-z][a-z0-9_-]{0,63}$,必须∈本进程已加载 profiles",
  "projectDir": "string,1..2048,绝对路径,已存在、是目录、是 git 仓库"
}
```

响应 `201`:

```json
{
  "schemaVersion": 1,
  "runId": "run-<base36时间>-<8hex>",
  "projectId": "proj-<40hex>",
  "status": "PLANNED",
  "statusEndpoint": "/api/v1/runs/<runId>"
}
```

错误(均为 `{"error":{...}}` 封装):400 INPUT_REJECTED(schema)·
400 UNKNOWN_PROFILE · 400 PROJECT_DIR_NOT_ABSOLUTE / PROJECT_DIR_MISSING /
PROJECT_DIR_NOT_DIRECTORY / PROJECT_DIR_NOT_GIT_REPOSITORY(fail-closed,
零落库)· 409 PROFILE_DEFINITION_CONFLICT · 401/403 守卫
(TOKEN_REQUIRED/TOKEN_INVALID/CSRF_REQUIRED 均 403)·
503 ORCHESTRATION_NOT_CONFIGURED(壳未传 profiles 时)。
profileId 可选值当前无枚举端点——M9-02 若需下拉框,建议由壳把
--profiles 文件内容直接渲染(同源、零新端点);如需 API 化再提案。

### GET /api/v1/runs(任务列表;创建倒序)

响应 `200`(无查询参数,未知参数 400):

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "id": "run-…",
      "projectId": "proj-…",
      "objective": "string|null(取冻结图 revisions 的入口节点;无 baseline 为 null)",
      "status": "PLANNED|RUNNING|READY_FOR_DELIVERY|DELIVERED|CANCELLED",
      "createdAt": "ISO-8601"
    }
  ]
}
```

状态渲染注意:任务失败时 run.status 仍为 RUNNING(词汇表无失败值),
失败证据在 `GET /api/v1/runs/:id` 的 executions[].phase(FAILED)与
graph 端点的节点态——UI 应以执行/节点态为准渲染失败。审批停靠时同样
RUNNING,需另查 `GET /api/v1/runs/:id/approvals`(PENDING+actionable
即有可决策审批卡;决策走既有
`POST /api/v1/approvals/:approvalId/decision`,body
`{decision:"approve"|"reject", decidedBy, reason?(reject 必填)}`)。

### 配套只读端点(既有,M9-01 未改契约)

`GET /api/v1/runs/:id`(详情+executions)·
`GET /api/v1/runs/:id/graph` · `GET /api/v1/executions/:id/events` ·
`WS /api/v1/events/live`(首消息 Bearer 认证)·
`GET /api/v1/session`(取 csrfToken)。
`POST /api/v1/executions/:id/dispatch` 已退役(410 ENDPOINT_RETIRED),
UI 不得再调用。
