# M11-03 批报告:项目+新任务向导+任务历史与详情时间线(产品 UI 核心交互批)+ M11-02 移交族 B/C/D 收口

批次日期:2026-10-08(本文件不入冻结面,历批同口径)

## 1. Summary

v0.4.0 第三批(M11-03,项目+新任务+任务历史主界面)由任务 1(项目页+登记流
+新任务向导+移交族 B/C+仓库卫生)、任务 2(任务历史+详情 Agent 时间线+
browser-e2e 核心流+移交族 D)、任务 4(本提交:批报告/PROPOSALS/BACKLOG/
backlog.json/CHECKSUMS)三个 ask 组成。

**提交形态如实(与历批不同)**:本工作流的门禁重跑循环设计下,任务 1/2 的
成果留在工作树、仅任务 4 一次性提交——本批为**单一提交承载全部 34 文件**
(19 改+15 新;CHECKSUMS 在任务 1 已改、终化再改,按文件计一次),不存在
a21fc58→2c70e7b 式的逐任务提交链;ask 编号与提交不再一一对应,以 git log(单一候选 SHA)与
本节为准,不虚构造数。仓库卫生:packages/local-api 下的遗留物 `nul` 文件与
`%TEMP%ro-r8-release/` 目录(均 untracked+ignored,.gitignore:45/47 实证)
已在任务 1 删除,不进提交。

红线遵守:orchestration 语义零变化(守卫/审批/调度/事件协议/既有端点行为
不动——唯一语义变化见 §2 的 POST /api/v1/projects 登记,已按新端点纪律
登记 API_AND_EVENTS 并测试钉住);新增 npm 依赖零;git add 显式路径;无
push 无 tag;冻结面改动(API_AND_EVENTS.md/PROPOSALS.md/BACKLOG.md/
backlog.json)逐文件纯 LF+CHECKSUMS 重算,planning-check 80/80。

范围如实:M11-03 登记范围五项(项目选择器[目录浏览+git 校验前置]/新任务
向导/任务历史/任务详情时间线/完成标准『维护者真实项目跑通第一个真实任务』)
——前四项交付;**目录浏览按 ask 的二选一裁决为『纯路径输入+校验按钮』**,
不做 GET /api/v1/fs/list(理由见 §2);『维护者真实项目跑通第一个真实
任务』归维护者环境动作(真实 Claude/Codex 首任务,红线,自动化面=
fake-cli e2e 已建,§7)。

## 2. 项目流(GET /api/v1/projects + POST /api/v1/projects)

**目录浏览二选一裁决:纯路径输入+校验按钮,不加 GET /api/v1/fs/list。**
理由:fs/list 即便只读+zod strict+带凭据,也是给单操作者本地产品新增一张
宿主目录枚举面(攻击面/披露面成本);维护者的路径输入本就是文件管理器
复制粘贴;校验真相由服务端 fail-closed 四道门承担,UI 只做绝对路径形状
提示(旧页 projectDirHint 同纪律:存在性/git 校验永远在服务端)。按真实
使用反馈再评估。

**『既有 POST /api/v1/projects』的披露(重要,如实)**:任务 1 ask 称调
『POST /api/v1/projects 既有 fail-closed 校验』,但该端点在交付前**不存在**
(server.ts 原 `/api/v1/projects` 对非 GET 一律 405 "read-only; use GET";
docs/API_AND_EVENTS.md 草案节把 `POST /projects` 列为设计期未实现端点;
grep 实证)。按 ask 的行为规格**新建**最小登记面 packages/local-api/src/
project-registry.ts+路由:严格单字段 body `{projectDir}`(zod strict);
校验链与运行创建逐门一致(非绝对路径→不存在→非目录→无 git HEAD,四道
400 逐门拒绝零写入,码字与 run-creation.ts 相同);落行走**同一 store 原语**
createProject+**同派生 id** derivedId("proj", repoRoot)+**同平台
executionTarget 映射**(复用 setup.ts executionTargetForPlatform)+同
trustStatus——与 ensureProject 逐项对齐;幂等=不 upsert(已登记 200
existing:true 一字不动);响应不含内部 id(GET 列表同纪律);不触碰角色
绑定。**该端点是新增 mutating 面,超出红线 1 字面『新增只读端点』示例
清单**——范围判断与理由:M11-02 §10 交接明示绑定写有先后依赖(项目行由
首次 POST /runs 创建,向导绑定步骤对未登记目录不可达:GET role-bindings
404 PROJECT_UNKNOWN、PUT 无 :id),『按目录预登记』即该交接点名的 M11-03
设计候选;零编排语义(不建 run/不改绑定/不动调度)。**唯一语义变化**:
该路径的 POST 从通用 405 拒绝改为登记面(GET 逐字节不变)——API_AND_EVENTS
新行登记+app-route.test 原格改钉(405→400 INPUT_REJECTED)+本节披露。

**登记不初始化绑定行(勘察发现,如实)**:新登记的项目 role_bindings 恰
0 条——与被 422 拒绝的首运行创建留下的项目完全同形态
(initializeProjectRoleBindings 归事务式 PUT);两条登记路径形态一致=
路径无关;UI 侧统一按『行缺失=null 绑定』判定。顺带勘误 API_AND_EVENTS
role-bindings GET 行原『未登记项目绑定全 null』表述(该形态仅 PUT 初始化
后存在)。

**项目页(/app/projects)**:人话卡片=目录名(dirNameFromPath 纯函数)+
全路径+绑定状态(四角色已绑定/绑定不完整差 N 个/不可用如实)+最近任务数+
登记时间;数据=三个既有只读面的客户端 join(GET /api/v1/projects 无 id+
每项目 GET role-bindings 取 projectId 句柄与绑定态+GET /api/v1/runs 的
projectId 投影[服务端 M9-01 起既回传,客户端原丢弃,现投影];N+1 选取
已在头注披露:本地单操作者项目数小、每查为廉价读);『登记项目』表单四道
门专属人话句(registerFailureText,每句含『没有写入任何内容』)+登记成功
引导去新任务页完成绑定(绑定面单一不重复);旧工作台原生 `<a href="/">`
钉子保持(handover A 延续)。

## 3. 新任务向导(绑定内嵌)

NewTaskPage 重写为四步向导:①项目下拉(目录名+全路径)+内嵌『校验并
登记』入口(成功即刷新下拉并选中)→②角色绑定状态检查(GET
role-bindings)→③目标输入→④『开始执行』(POST /runs 单节点起步)。

- **内嵌绑定步骤**:未绑定完整→四角色编辑器(选择器=已载入 profiles,
  预填 defaultBindingTemplate[M11-02 setup/status 提供,B1 返修后四态
  语义]:模板映射 runtime→已载入 profile,只补空选择不覆盖操作者已选)
  →『保存绑定』走**既有事务式 PUT role-bindings**(全落或全不落,零新增
  语义)→成功展示四角色卡片。四角色卡片=产品名(Claude Code/Codex,
  经 loaded-profiles join);绑而未载入如实『已绑定,但该 AI 配置当前
  未载入』;卡片零内部 id(id 只作 select 值与 PUT 句柄,旧页先例)。
  绑定人话族 bindingFailureText:UNKNOWN_PROFILE/EXECUTION_TARGET_MISMATCH/
  PROFILE_DEFINITION_CONFLICT/PROJECT_NOT_FOUND/ORCHESTRATION_NOT_CONFIGURED
  (每句含『本次绑定没有写入』=事务式语义如实)。
- **多节点『高级』折叠**(details 受控组件,提交失败自动展开):节点行=
  类型(执行/集成/评审)+角色+目标+依赖复选(按原始序号标注);人话预检
  (workflowDraft.ts,逐条对齐 multi-node.ts 的 400 载体):≤64 节点/
  集成节点须有父/评审恰一依赖且 reviewer/单 integration;服务端仍是权威
  (预检失败给出人话,服务端拒绝原样透出);无节点=单节点运行;A02 纪律:
  请求体显式 allowlist 构建(objective/projectDir+非空 workflow)。
- 成功跳 /app/runs/:id;绑定不齐/草稿非法/目标空均门禁在前并人话提示;
  ROLE_BINDINGS_INCOMPLETE 兜底文案改为指向向导自身绑定步骤(旧『旧配置
  页』指针删除,测试钉死不回归)。
- **移交族 C(generateDefaults 双发守卫)**:新 oneShotGate.ts 同步一次性
  门(take/release 纯函数);NewTaskPage.generateDefaults 接入——React
  状态更新异步,原 `setup.phase!=="ready"` 守卫在快速双击下两次都过;同步
  take 在任何渲染周期前拒绝第二次,成功/失败均 release(可重试)。
  SetupPage.generate 存在同型缺陷,同批同族修复(超出 ask 点名文件一行,
  如实登记)。即使守卫失效,服务端 409 PROFILES_ALREADY_CONFIGURED 幂等=
  拒绝兜底仍在(既有 setup.test 格)。oneShotGate.test 4 格钉同步语义
  (renderToString 套件无法点击,这是本套件下能钉到的诚实面;浏览器内
  双击行为由本批 e2e 的点击链覆盖)。
- **移交族 B(『未检测到』文案映射)**:runErrors.ts 增共享提取器
  notFoundMissNames(details.notFound→claude→Claude Code/codex→Codex→
  未知原样),SetupPage 与 NewTaskPage 两处提取点改用——错误卡『本次未
  检测到:』行与主消息产品名一致(原两处直传裸 id);runErrors.test 4 格
  钉住(含非字符串元素过滤)。

## 4. 任务历史与详情时间线(逐项可得/降级)

**历史页**:人话状态列(outcome 优先+status 组合的既有 runHumanStatus)、
服务端创建倒序原样、点行进详情(ListRow 主体 role=link+回车,查看链接
保留)。

**详情页(/app/runs/:id)逐项**:

| 项 | 可得性 | 呈现 |
| --- | --- | --- |
| 头部状态/目标/项目 | status+outcome 既有;目标=runs 列表入口节点目标(与历史行同源);项目名=项目列表×绑定查寻 projectId 匹配(一次性) | 徽标+目标+项目+创建时间;非终态 3s 轮询(三只读面),终态自停 |
| Agent 时间线 | GET /runs/:id/graph 节点(nodeId/role/objective/dependencies/state) | 角色人话名+状态徽标+耗时(可计算则示)+节点目标;**按声明依赖 Kahn 分代(timeline.ts),同代同排=轮内并行如实**;WAITING_APPROVAL 高亮 |
| 节点下钻 | executions(attempt/phase/双时间戳)+GET /executions/:id/events(脱敏分页) | 尝试次数+逐次(phase/耗时)+日志(type 原样+payload.summary/text 字符串优先,未知类型不硬译)+显式刷新 |
| 『在改文件』『Diff』 | GET /runs/:id/diff?nodeId= 对任意节点作答,但**仅集成记录携带候选**(diff-view.ts 实证);普通 agent 节点的工作区文件活动**无按节点持久化** | 有候选→文件清单(path/status/增删/二进制/截断/冲突);无候选→原句降级『该信息当前未持久化……将在 M11-04 评估』(e2e 钉住真实出现) |
| 节点『Integration』专名 | **不可得**:dispatch kind 仅驱动进程簿记、不入持久化图(graph.ts 无 kind 字段) | 按四角色人话呈现,不杜撰专名 |
| 『等待集成』状态 | **不可得**:dag 冻结 NODE_STATES 无此态 | 已完成节点等待下游如实显示『已完成』;nodeHumanState 注释钉死不发明 |
| 完整 unified diff 文本/A12 verdict | 端点可得(diff.unified/review)但本批 UI 未渲染 | 文件清单+冲突已示;完整 diff 指引诊断台——范围判断(属 M11-04 Diff 查看批)非不可得,如实登记 |
| 审批呈现 | GET /runs/:id/approvals 全要素;POST decision 既有守卫面 | **接入(二选一裁决)**,理由与实现见 §5 |

**审批操作接入决策与理由**:ask 二选一(接既有 API vs 展示『请在诊断台
处理』)。裁决=**接入**:POST /api/v1/approvals/:id/decision 是既有守卫面
(per-actionDigest、无批量、拒绝必填原因、决策永不执行动作/永不消费审批
——消费归检查点续行),旧页已有等价流(page.ts:1395-1435 实证),产品
UI 不接反而倒退。实现:ApprovalCard 纯组件(A17 纪律:决策前 argv/风险级
人话+原因/新增权限/过期时间全要素可见;每条单独批/拒;无全局放权词汇;
非 actionable 的失效原因如实渲染且不给按钮;拒绝原因框拒绝时必填,服务端
再验);decidedBy 用诚实固定标识 "local-operator"(api.ts
LOCAL_OPERATOR_IDENTITY);决策后人话反馈+审批视图刷新;
approvalDecisionFailureText 人话族(已失效 409/已过期 409/认证族)。

**内部 ID 折叠**:runId/projectId/taskId/baseSha/图修订号/节点与执行与
审批 id 全部收进页底『开发者详情(内部标识)』折叠 details,默认视图零
内部 ID(SSR 钉子断言)。

## 5. 移交族处置对照(族 B/C/D 及 nul 清理)

| 族 | 内容 | 处置 | 位置/证据 |
| --- | --- | --- | --- |
| B | 『未检测到』文案映射(claude→Claude Code/codex→Codex 与主消息一致) | 已收口 | runErrors.ts notFoundMissNames 共享提取器;SetupPage/NewTaskPage 两处提取点改用;runErrors.test 4 格(含非字符串过滤) |
| C | generateDefaults 双发守卫(守卫补同步检查) | 已收口 | oneShotGate.ts 同步一次性门(take/release);NewTaskPage.generateDefaults+SetupPage.generate(同型缺陷同族修复,如实登记超出点名一行);oneShotGate.test 4 格钉同步语义;服务端 409 幂等兜底不变 |
| D | createProfilesFileAtomic 三拒绝分支原语级测试;setup.test.ts:382 注释与 :12 头注过述修正 | 已收口 | ①profiles-config.ts 增可选第三参 lastLookIsFile(仅 rename 前 last-look 探针可注入,默认实 statSync,cli-discovery isFile 同缝;前置/父目录检查恒真实;既有调用零变化)——同步测试无法赢真实 fs 竞态,此为该分支唯一可达的原语级测试面;②test/profiles-config-create.test.ts 4 格:父目录缺失 409 PROFILE_SOURCE_ABSENT/已存在前置 409 PROFILES_ALREADY_EXISTS 原字节不动+无临时文件残留(readdir 实断言)/last-look 注入再拒 409 目标仍缺+目录空/对照格(默认路径照常建出经冻结解析器复验的文件=注入缝零行为变化);③setup.test.ts 创建路径格『no temp file was left behind』注释由声称变断言(按 .m11-02-tmp- 模式过滤 readdir;首跑曾因目录含 fixture worktrees 过严失败,改按模式过滤=断言本义);④头注 POST 侧『the single-CLI fallback』改『the two single-CLI arms (claude-only / codex-only)——the M11-02 B1 rework's intent mapping, not a fallback』(B1 返修已修 GET 侧四态头注,本批补齐 POST 侧残留;行号相对拦截版漂移如实注明) |
| nul 清理 | packages/local-api 下 nul 与 %TEMP%ro-r8-release/ | 已删除 | 删除前 git check-ignore 实证(.gitignore:45 nul/:47 %TEMP%ro-*)+find 确认目录无文件;删除后复查无残留;均 untracked+ignored 不进提交 |

## 6. 变更文件清单(批累计,单一提交,35 文件)

任务 1(20 文件):CHECKSUMS.sha256、docs/API_AND_EVENTS.md、
packages/local-api/src/{index.ts、server.ts、project-registry.ts(新)}、
packages/local-api/test/{app-route.test.ts、project-registry.test.ts(新)}、
apps/desktop-ui/src/{api.ts、app.css、runErrors.ts、runErrors.test.ts、
shell.test.tsx、oneShotGate.ts(新)、oneShotGate.test.ts(新)、
workflowDraft.ts(新)、workflowDraft.test.ts(新)、
components/RoleBindingSection.tsx(新)、pages/{NewTaskPage.tsx、
ProjectsPage.tsx、SetupPage.tsx}。

任务 2(10 文件):packages/local-api/src/profiles-config.ts、
packages/local-api/test/{setup.test.ts、profiles-config-create.test.ts(新)}、
packages/browser-e2e/test/app-product-flow.test.ts(新)、
apps/desktop-ui/src/{runStatus.ts、timeline.ts(新)、timeline.test.ts(新)、
components/ApprovalCard.tsx(新)、pages/{HistoryPage.tsx、
RunDetailPage.tsx}}。

任务 4(本提交,4 文件;CHECKSUMS.sha256 已在任务 1 计入,此处仅改其
终值):reports/M11-03-BATCH.md(新,不入冻结面)、PROPOSALS.md、
docs/BACKLOG.md、project/backlog.json。

## 7. 测试及退出码(2026-10-08 本会话实跑,逐命令)

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`(仓库根,任务 1/2 后各一轮) | 62/62 successful;exit 0 |
| `pnpm test`(仓库根,任务 2 后;门禁原规模复跑亦过) | 74/74 tasks successful;exit 0(2m33s;local-api 以变更源未走缓存实跑,desktop-ui/browser-e2e 同) |
| `pnpm build`(仓库根) | 37/37 successful;exit 0(desktop-ui 单文件产物 335,563B 含详情页/审批卡/时间线) |
| `pnpm exec vitest run`(apps/desktop-ui) | 6 文件 62/62 passed;exit 0(原 48+timeline 9+ApprovalCard/详情页/历史 SSR 钉 5) |
| `pnpm exec vitest run`(packages/local-api,任务 1 时点直跑) | 29 文件 339/339 passed;exit 0(原 326+project-registry 13) |
| `pnpm exec vitest run test/profiles-config-create.test.ts test/setup.test.ts`(移交族 D) | 2 文件 20/20 passed;exit 0(4 新格+setup 16) |
| `pnpm exec vitest run test/app-product-flow.test.ts`(browser-e2e) | 1/1 passed(8.29s,真实 Chromium:登记→绑定→建任务→详情时间线→下钻降级句→终态→历史→点行重进) |
| `pnpm exec vitest run test/app-shell-smoke.test.ts`(browser-e2e) | 1/1 passed;exit 0(零回归) |
| `node planning-check.mjs`(终态) | (a) 80/80 checksums match+(b) self-test exit 0;进程 exit 0 |
| 全批 34 文件 BOM/CR 检查(python 逐字节,提交前终态) | 全部 BOM=False CR=0 纯 LF 尾 LF |

**门禁返修登记(第 1 次pnpm test)**:首跑全量 test 时 project-registry.test.ts
域格 describe 的 beforeAll 钩子超时(vitest hookTimeout 未配置=默认 10s;
钩子内 createGitFixture 跑真实 git init/commit spawn 链,直跑 7.65s 存活,
turbo 并行负载下超 10s;同包其余 333 格全绿=纯时序非语义)。修复=同包
先例原样(runs-orchestration.test.ts T0_TIMEOUT_MS 模式):三处含真实
fixture/起服的 beforeAll 传 FIXTURE_HOOK_TIMEOUT_MS=60_000,不全局调
hookTimeout;afterAll 保持默认与先例一致。修复后单文件 13/13、整包
339/339、仓库根 pnpm test 74/74 复跑全绿。唯一变更文件逐字节复核过。

## 8. 未验证项

1. **真实 Claude/Codex 首任务(归维护者)**:『维护者真实项目跑通第一个
   真实任务』的完成标准以真实 CLI 为准——自动化面=fake-cli e2e
   (app-product-flow 全点击链)已建并绿;真实任务的最后一步归维护者
   环境(红线,不伪造)。
2. **审批操作 UI 的浏览器内决策点击**:核心流无审批场景,e2e 未覆盖
   approve/reject 点击(决策面有既有服务端测试+ApprovalCard 纯渲染格+
   人话族测试);真窗审批操作随维护者真实任务首验。
3. **壳内/真窗认证态全流程**:认证=壳注入(ADR 010),headless e2e 以
   context 级 header 注入模拟(守卫管线所见=普通已认证请求);壳注入的
   端到端仍归维护者真窗(M11-01 遗留项延续)。
4. 审批卡 LIVE 高亮的真实 WAITING_APPROVAL 场景、多节点多波时间线、
   集成节点候选 Diff 的浏览器呈现:fake-cli 成功场景为单节点——多节点
   与审批场景的浏览器级验证归 M11-04(其验收即多节点全流程)。
5. 执行日志不自动续拉(显式刷新;节点状态由 3s 轮询驱动),WS 直播流
   接入留 M11-04。
6. 10 轮审查属批次后续流程(完成标准内),本报告交付时未开始。

## 9. M11-04 交接

- **已就绪面**:详情页骨架(头部/时间线分代/下钻/审批卡/开发者详情)与
  其全部数据源客户端投影(api.ts:fetchRunDetail/fetchRunGraph/
  fetchRunApprovals/fetchExecutionEvents/fetchRunDiff/decideApproval);
  timeline.ts 纯层(分代/尝试跨度/事件行);diff 端点集成候选文件清单
  已接;审批决策已接(卡+人话族);e2e 基座(context 级认证注入+全
  点击链)可直接复制为 M11-04 多节点/审批场景的测试面。
- **缺口(如实移交)**:①unified diff 文本与 A12 verdict 的 UI 渲染
  (端点字段已投影层可得,diff.unified/review);②审批操作 e2e 场景
  (proposal/timeout profile 组合);③执行日志 WS 直播(替代 3s 轮询+
  手动刷新);④多节点/并行/返工循环的产品化呈现(M11-04 验收主面);
  ⑤节点级『在改文件』持久化评估(本批降级句承诺的 M11-04 评估点)。
- **测试面交接**:desktop-ui timeline.test/wave 分代/状态映射格、
  ApprovalCard actionable/失效两态格、详情页 SSR 零 id 钉子;
  local-api profiles-config-create 四格(注入缝先例);
  browser-e2e app-product-flow(认证注入+点击链+降级句钉子)。
- **约束提醒**:产品文案零内部 ID 默认视图纪律(shell.test 钉子持续
  有效);同步一次性门(oneShotGate)模式可供 M11-04 危险操作按钮复用;
  diff/unified 渲染须沿用既有转义纪律(React 默认转义+CSP,不引入
  dangerouslySetInnerHTML);git add 显式路径;冻结面改动纯 LF+重算
  CHECKSUMS。
