# M9-02 批次报告:工作台 UI v1——壳打开即是任务工作台(M9-02-BATCH)

日期:2026-10-03 · 执行角色:Developer · 性质:**M9 第二个功能批次交付,非发布
动作**——不打 tag、不发 Release、不动远端;发布动作按
`project/RELEASE_PROCESS.md` 由维护者决定。

## 1. Summary

页面默认页签改为任务工作台:『新建任务』表单(objective 文本域、profile
下拉来自新端点 GET /api/v1/profiles、工作目录输入含体验层绝对路径提示)→
创建即 202 Accepted;『任务列表』渲染 GET /api/v1/runs(objective/状态徽标/
创建时间,创建倒序,2 秒自动刷新+手动刷新);点任务行展开实时进度——执行
清单复用既有 run-detail 渲染、失败执行显式标注、事件经既有 WS
/api/v1/events/live 直播(首消息认证,按 eventId 去重);M5 观测台全部能力
原样移入『高级』页签(零删减,元素 id 不变)。耦合解法选**方案①**:
POST /api/v1/runs 改 202——创建簿记移入独立的快速创建链(与驱动链分离),
入队成功即返回 `{runId, status:"queued", statusEndpoint}`,HTTP 响应不再
等待在飞任务完成;M9-01 测试语义同步 201→202,并新增『长任务占链时 POST
即回且排队任务仍被执行』回归格。安全边界零变化:全部请求走既有守卫管道
(令牌+CSRF),输入校验边界仍是后端 strict schema(前端只有体验层提示),
A36 渲染消毒不退(所有动态文本经 esc 转义),A02 不退(表单体 allowlist
构建,无 model/Profile 字段),审批面原样保留(工作台详情页明确指向高级
页签的审批卡)。零新增外部 npm 依赖。

## 2. 设计要点

### 2.1 耦合解法:选①(202+异步入队即返回),理由

- **问题实证**(M9-01 审查输入):`createRun` 原实现把创建簿记排在串行
  驱动链上(`orchestrator.ts` 单 promise 链),当前序 run 的节点执行在飞
  (真实 CLI 可达数十分钟)时,POST /api/v1/runs 的整个 HTTP 响应被阻塞
  到它结束——工作台「点创建」会挂住整页。
- **为什么不是方案②**(前端排队态):前端排队态治标不治本——响应仍被
  阻塞,fetch 无法完成,任何 UI 状态都无从渲染;且 typed 400(项目目录
  fail-closed 等)也要等到在飞任务结束才返回,交互完全不可用。
- **方案①实现**(`orchestrator.ts`):新增 `creationChain`,与驱动链
  `chain` 分离。创建是 ms 级(一次 git rev-parse spawn + 同步 store 写入),
  在创建链上自串行(find-or-create 无竞态),其驱动仍 `enqueue` 到驱动链
  ——**FIFO 顺序不变**(创建串行化保证每次创建在下一个创建开始前把它的
  driveRun 追加到驱动链);驱动链语义零变化(单进程至多一个节点执行)。
  `shutdown` 等待两条链结算(15s 宽限)。异步驱动安全由构造保证:
  `driveRun` 全程从 store 重读状态,不依赖创建调用的内存态。
- **响应语义**:202 + `{schemaVersion:1, runId, projectId,
  status:"queued", statusEndpoint}`。`status:"queued"` 是**接受态**
  (已入队、驱动异步进行),不是持久行状态——持久状态仍在 statusEndpoint
  以冻结词汇表(PLANNED/RUNNING/READY_FOR_DELIVERY/…)查询。响应体不发明
  新的持久状态值。
- **测试语义同步**:runs-orchestration 五格 201→202;新增格⑥(挂起
  profile 占链 → 第二个 POST 断言 <10s 返回且 `status:"queued"` 且此刻
  挂起 run 仍在 RUNNING → 挂起 run 被引擎杀预算终止后,排队 run 仍被
  FIFO 驱动到 SUCCEEDED);新增格⑦(profiles 端点)。

### 2.2 GET /api/v1/profiles(最小 profiles 列表端点)

- 只读、经完整守卫管道(/api 前缀 ⇒ Bearer 令牌;GET 无 CSRF 面);
  无查询参数(未知参数 400);非 GET/HEAD 405。
- 返回 `{schemaVersion:1, profiles:[{id, runtime, executionTarget, model,
  timeoutSeconds}]}`(id 排序)。**可执行路径(executable)、configDir、
  credentialGroup 刻意不出进程**——下拉选择面只需要这些字段。
- 未配置编排的进程返回诚实空清单(它驱动不了任何任务,也不提供任何可选
  项),不是 503——读端点与 POST 的 503 ORCHESTRATION_NOT_CONFIGURED
  分工如实。数据来自组合根启动时已校验的同一份 profiles 定义
  (`orchestrator.listProfiles()`),无第二事实源。

### 2.3 工作台 UI(page.ts 惯例:零构建、零新依赖、零框架)

- **页签结构**:`#page-tabs`(工作台=默认/高级)+ 两个容器 div。高级页签
  原样承载全部 M5 观测面(run-detail/events/DAG 画布/节点编辑/扩图/审批/
  diff/上下文,元素 id 一字不动)。浏览器 e2e 的既有 `openLocalPage`
  助手补一步「点高级页签」——操作者语义就是「去观测台」。
- **新建任务表单**:objective textarea(maxlength 10000)/ profile select
  (载入可用 profiles 按钮 → GET /api/v1/profiles)/ projectDir 输入 +
  提示 span。**提示是体验层**:浏览器无法 stat 文件系统,前端只判绝对路径
  形状(盘符/POSIX 根/UNC,charCode 92 避开反斜杠字面量);存在性/目录/
  git 基线校验由后端 fail-closed 执行,typed 400 原文映射为字段级错误文案
  (`createRunFailureText`)。表单体经 `buildRunCreatePayload` 显式
  allowlist 构建(objective/profileId/projectDir)——A02 的 UI 层,与
  buildNodeEditPayload 同纪律;CSRF 经 GET /api/v1/session 照旧。
- **任务列表**:`renderRunList` 纯函数(vm 可测);行=objective(esc)+
  状态徽标(持久状态+中文浅注,未知状态原样转义显示)+创建时间;创建倒序
  由端点保证;自动刷新 2 秒轮询(可关)+手动刷新按钮。轮询在无令牌时静默
  跳过(不刷 403 噪音)。列表驱动选轮询而非 WS:既有 WS 端点按执行订阅且
  一连接一订阅(ws-events.ts 协议约束),run 级生命周期无原生流,轮询
  GET /api/v1/runs 是最小且对守卫/配额零压力的实现;详情页的实时性则由
  WS 承担(见下)。
- **任务详情/实时进度**:点行展开 `#workbench-detail`。骨架稳定
  (`workbenchDetailSkeleton`):徽标+失败注+run-detail 卡片槽每 2s 随详情
  轮询重渲染,**事件盒不重渲染**——WS 追加永不被轮询清掉。失败注如实:
  run 级状态无失败值(M9-01 §7 交接),存在 FAILED 执行时显式
  `role="alert"` 标注,绝不把 RUNNING 渲染成健康。事件流:每个执行一条
  WebSocket(服务端协议一连接一订阅),首消息 auth+subscribe,客户端按
  eventId 去重(A39 客户端义务),追加走与既有 renderEvents 相同的
  `eventToHtml` esc 路径;断线由下一轮详情轮询重开。审批/图/diff 等完整
  观测面指向高级页签,不重复建设。
- **安全不退(与既有同构)**:所有动态文本经 esc(stripAnsi+escapeHtml)
  后插入;严格 CSP 不变(connect-src 'self' 覆盖同源 WS,M5-05
  collectLiveEvents 即同先例);令牌流程不变(手输令牌、内存持有、不进
  URL/源码);无批量放权词汇(FORBIDDEN_UI_PHRASES 结构测试照常)。

## 3. 变更文件(12 个,git status 实录)

- `packages/local-api/src/orchestrator.ts` — 创建链/驱动链分离、
  `CreatedRunView.status:"queued"`、`listProfiles()`/`ProfileSummaryView`、
  shutdown 双链结算;
- `packages/local-api/src/server.ts` — POST /api/v1/runs 202、GET
  /api/v1/profiles 路由、模块文档;
- `packages/local-api/src/page.ts` — 页签+工作台(表单/列表/详情/WS 客户端)
  +CSS,模块文档;
- `packages/local-api/src/index.ts` — 导出文档(M9 表面描述);
- `packages/local-api/test/runs-orchestration.test.ts` — 201→202、格⑥
  (202 耦合回归)、格⑦(profiles 端点)、挂起 profile;
- `packages/local-api/test/page.test.ts` — M9-02 工作台 7 格(骨架/A36/
  A02 allowlist/提示边界/typed 400 文案/徽标);
- `packages/browser-e2e/test/helpers.ts` — startHarness 可选 orchestration;
- `packages/browser-e2e/src/browser.ts` — openLocalPage 高级页签步 +
  工作台助手 9 个;
- `packages/browser-e2e/test/flow-6-workbench.test.ts` — 工作台浏览器
  端到端(新);
- `CHANGELOG.md` — Unreleased Added(M9-02)+ Changed(202);
- `CHECKSUMS.sha256` — CHANGELOG 行同步(纯 LF 重算);
- `reports/M9-02-BATCH.md` — 本报告(不入冻结面清单,M9-01-BATCH 同口径)。

## 4. 实际执行的测试及退出码(2026-10-03 本会话实跑)

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --filter @role-orchestrator/local-api run typecheck` | 0 | 通过 |
| `pnpm --filter @role-orchestrator/local-api run test` | 0 | 21 文件 227/227(批前 218,恰增 9:格⑥⑦+页面 7 格) |
| `pnpm --filter @role-orchestrator/local-api run build` | 0 | dist 构建成功 |
| `pnpm --filter @role-orchestrator/browser-e2e run typecheck` | 0 | 通过 |
| `pnpm --filter @role-orchestrator/browser-e2e run test` | 0 | 9 文件 20/20(flow-1..5+a38+a39+evidence-rotation 全回归+flow-6 新格) |
| `node packages/release-audit/dist/cli.js secrets .` | 0 | verdict known-reservations-only(默认排除面);排除 .zcode 复测(scanSecrets excludeDirNames+.zcode):1676 文件,findings 35=31 test-sentinel+4 known-fake-sentinel,**needs-judgment=0** |
| `node planning-check.mjs` | 0 | (a) CHECKSUMS 逐文件 +(b) 干净副本 self-test(本批触及冻结面 CHANGELOG/CHECKSUMS 故加跑) |

新增测试内容(全 hermetic,仅 fake-cli dist bins):

- **runs-orchestration 格⑥(202 耦合回归)**:挂起 profile(timeout 场景,
  杀预算 30s=profile schema 下限)占住驱动链 → 等其执行 RUNNING → 计时
  POST 第二个 run:**202 + `status:"queued"` + 耗时 <10s**,且此刻挂起 run
  仍 RUNNING(证明没等链)→ 挂起 run 被引擎超时树杀(FAILED 证据)后,
  排队 run 被 FIFO 驱动到 READY_FOR_DELIVERY+SUCCEEDED(证明『响应即回
  且任务仍被执行』)。
- **格⑦(profiles 端点)**:3 个已加载 profile 的 id/runtime/
  executionTarget/model/timeoutSeconds 正确;序列化体不含 executable/
  configDir/credentialGroup;无令牌 403 TOKEN_REQUIRED;查询参数 400;
  POST 405;无编排进程 200+空清单。
- **页面 vm 测试(page.test.ts +7)**:高级页签保留全部既有观测面 id;
  run 行敌意 objective 无活 img/script(标签白名单断言);失败执行显式
  标注;创建 payload allowlist 拒 model/profileRevision/空目标/超长/空白
  profile/空目录(A02 UI 层);projectDirHint 只判形状(盘符/POSIX/UNC
  通过,相对路径提示含 PROJECT_DIR_NOT_ABSOLUTE);typed 400→文案映射;
  profile 选项转义且无敏感字段。
- **browser-e2e flow-6(真实 Chromium)**:打开即工作台(默认页签)→
  载入 profiles(下拉含 profile-wb-claude)→ 填表单创建 → 状态文本
  「已接受(202 queued)」→ 列表 2s 轮询自动出现该任务 → 点行展开 →
  WS 直播事件 ≥3 条(服务端日志:accepted(first-message-auth)→
  subscribe → terminal SUCCEEDED)→ 徽标 READY_FOR_DELIVERY+执行
  SUCCEEDED → 敌意 objective 创建后列表零活 img 元素、原文以惰性文本
  可见(A36)→ 高级页签任务图画布照常(execute=SUCCEEDED)。全程截图
  入 evidence。

## 5. 未验证项(如实登记)

1. **桌面壳侧链未贯通**:bundle:serve 未重跑,壳 spawn 的 serve-bundle.mjs
   仍不带 `--profiles`(M9-01 §8 交接项,属壳侧 M9-03+);工作台在壳内
   当前会看到 POST 503 ORCHESTRATION_NOT_CONFIGURED,这是诚实拒绝而非
   缺陷。真实端到端(壳→serve --profiles→工作台建任务)待壳侧接线。
2. **真窗(GUI)交互归维护者**:本批 UI 验证面为 headless Chromium
   (browser-e2e)与 node:vm DOM 沙盒——真实桌面窗口内的交互(焦点切换、
   窗口尺寸/高 DPI 下的画布与表格布局、输入法下的 objective 输入、真窗中
   的 WS 断连恢复)未验证,按 v0.1.1 先例列入维护者验证清单。
3. 真实 CLI(claude/codex)下的工作台全流程未冒烟(M9-01 §5 上游 503
   未恢复;本批全部验证走 fake-cli,hermetic 纪律不变)。
4. WS 断线自动重开依赖 2s 轮询的惰性重订阅,未构造「WS 中途断开」的
   专门浏览器格(a39 已在既有套件覆盖服务端重放/去重语义)。
5. 任务列表自动刷新在长列表(>百行)下的渲染开销未测量(本地单用户
   场景,当前规模 O(行数) innerHTML 重建可接受)。

## 6. 风险

- **202 契约变化**:按 ask 预授权「选①需同步改 M9-01 测试语义」执行;
  任何仍按 201 处理 M9-01 响应的旧客户端需适配(当前仓库内无此类调用方;
  壳尚未调用该端点)。已在 CHANGELOG Changed 披露。
- **创建/驱动分链后的写交错**:创建簿记(projects/profiles/bindings/
  task_runs/graph/queue 的新行)可与在飞驱动簿记在不同表上交错——单连接
  同步 SQLite + 单线程事件循环下无部分写;创建相互串行(创建链),驱动
  FIFO 不变(测试⑤⑥背书)。
- **UI 轮询**:2s 轮询是本地回环 + 单用户取向;配额/串行泵语义未变,
  多开页面只是多几条只读轮询。
- **被拒审批死端/失败 run 状态语义**:沿用 M9-01 §7 如实登记——工作台
  以失败注+事件流呈现,不发明状态;取消/重排入口留后续里程碑。

## 7. M9-03 交接说明

- **POST /api/v1/runs 新契约**:202 Accepted,body
  `{schemaVersion:1, runId, projectId, status:"queued", statusEndpoint}`;
  错误面与 M9-01 §8 完全一致(400 INPUT_REJECTED/UNKNOWN_PROFILE/
  PROJECT_DIR_*、409 PROFILE_DEFINITION_CONFLICT、401/403 守卫、503
  ORCHESTRATION_NOT_CONFIGURED)。
- **GET /api/v1/profiles**(新):守卫同任意 /api 读;200
  `{schemaVersion:1, profiles:[{id,runtime,executionTarget,model,
  timeoutSeconds}]}`;无编排=空清单;未知查询参数 400;非 GET/HEAD 405。
- 工作台 UI 的 profile 下拉数据源即该端点;壳侧接线 `--profiles` 后自然
  亮起。观测台全部能力在高级页签,元素 id 未动,既有壳侧选择器(若有)
  不受影响。
