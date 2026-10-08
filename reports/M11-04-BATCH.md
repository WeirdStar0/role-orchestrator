# M11-04 批报告:执行可视化+Review+Approval+Diff(多节点/并行/返工循环在产品 UI 内闭环)+ M11-03 审查移交优先项逐条收口

批次日期:2026-10-08(本文件不入冻结面,历批同口径)

## 1. Summary

v0.4.0 第四批(M11-04)由三个 ask 组成,单一提交承载全部 32 文件(24 改+8 新;
提交形态如实:任务 1/2/3 成果留工作树、任务 4 一次性提交——M11-03 先例口径,
ask 编号与提交不一一对应,以本候选 SHA 与本节为准):

- **任务 1(移交优先项)**:M11-03 审查移交 minor ⑧(最高优先,blocked 终态
  页停摆)/⑦(WORKFLOW_* 九类人话)/⑤⑥(诚实标签)/①(34/35 笔误)/⑨⑬⑪
  ⑫⑮⑯(轻项)逐条收口,§2 逐条对照;
- **任务 2(本批验收主面)**:多节点/并行/返工循环人话呈现(节点图次级视图/
  轮内并行双卡/返工轮次+hold)、Reviewer 产品化(勘察→verdict/findings 可得、
  分级不可得如实降级)、Diff(unified 文本既有端点可得→自有轻量渲染)、审批
  e2e(action-proposal 全链+旧实现判别力双向实证)——§3-§6;
- **任务 3(实时性决策+可视化补充)**:执行日志实时性二选一裁决 **(a) 保持
  3s 轮询+如实标注**((b) one-time ticket WS 放弃理由全文见 §7)、多节点可视
  化组件化+SSR 渲染契约钉+并行双卡真浏览器钉——§7;
- **任务 4(本提交)**:批报告/PROPOSALS/BACKLOG/backlog.json/CHECKSUMS。

红线遵守:orchestration 语义零变化(run-driver/scheduler/engine/store schema
零触碰);唯一服务端新增=一个只读端点 GET /api/v1/runs/:id/review-records
(红线字面『新增只读端点』内:带凭据守卫+zod strict+只读+API_AND_EVENTS 登记);
expansions/diff/approvals 既有端点零改动;零新增 npm 依赖;git add 显式路径;
无 push 无 tag;冻结面改动(API_AND_EVENTS/PROPOSALS/BACKLOG/backlog.json)
逐文件纯 LF+CHECKSUMS 对应行重算,planning-check 80/80。

## 2. 移交优先项逐条处置(任务 1)

| minor | 内容 | 处置 | 位置/证据 |
| --- | --- | --- | --- |
| ⑧(最高优先) | runIsTerminal 把可恢复 outcome blocked 当终态→审批暂停页停摆 | 已收口 | runIsTerminal 移入 runStatus.ts:66 纯层并修语义(blocked 非终态;语义依据=run-driver.ts:381-383 blocked=RUNNING+决策后复位 null);decide() 成功后重拉 detail+graph+approvals+expansions 四面(重拉失败独立 catch 报『决策已生效,但刷新失败』不与成功横幅冲突);头部新增常驻手动『刷新』按钮;回归钉=runStatus.test 3 格(blocked→false/终态 outcome/终态 status);浏览器级由 app-approval-flow 钉(暂停期轮询活) |
| ⑦ | WORKFLOW_* 九类人话映射缺失(英文兜底) | 已收口 | runErrors.ts createRunFailureText 补九类专属句(NODES_OUT_OF_BUDGET 含 64 上限/DUPLICATE_NODE_ID/SELF_DEPENDENCY/UNKNOWN_DEPENDENCY/INTEGRATION_WITHOUT_PARENTS/REVIEW_DEPENDENCY_COUNT/REVIEW_ROLE/INTEGRATION_NODE_COUNT[与 multi-node.ts INTEGRATION_NODE_LIMIT_REASON 同句]/GRAPH_INVALID[含 cycle 专属句『依赖关系形成了环』,按服务端 DependencyCycleError 措辞匹配,服务端原文保留为详情];九句均含『本次没有创建任务』);头注量词修真(原『EXACTLY the ones the route can answer』改精确版:专句恰覆盖稳定语义 typed carriers,形状级 400 INPUT_REJECTED 与未来码设计性落诚实默认臂——新格钉死 INPUT_REJECTED 原样透出);格题 'maps every typed…' 改 'maps the typed… that carry dedicated sentences';workflowDraft.ts 集成句 每个任务→每任务 对齐服务端原句(消一字差,格同步) |
| ⑤⑥ | 『推荐分工已预填』无条件声称;『绑而未载入』与『未绑定完整』混同 | 已收口 | RoleBindingSection 新增纯函数 prefillFillableCount(template,profiles);NewTaskPage 预填句三态条件渲染(全预填/部分预填 N 个/无可预填);NewTaskPage 未完整面新增绑而未载入专属警示(FormStatus,N>0 时);ProjectsPage bindingFace 增 loadedProfileIds 参数+bound-not-loaded 第四态(卡面『四个角色已绑定,但其中 N 个角色的 AI 配置当前未载入』;页面 join 三面→四面 fetchProfiles,N+1 纪律不变,profiles 拉取失败降级空集=如实按未载入);shell.test 2 格纯钉五态/四态 |
| ① | 34/35 笔误 | 已收口(范围如实更正) | project/backlog.json deliveryNotes.M11-03.note 『承载全部 35 文件』→34(load→改→dumps;断言 issues 深等/其余 notes 逐项不变/git diff 恰 1 行);**ask 点名的 docs/BACKLOG.md 无此笔误**(grep 全文 '35' 仅 A35 验收码四处;M11-03 节 20+10+4=34 自洽)——该文件零改动;同一笔误实际另在 reports/M11-03-BATCH.md §6 标题(不入冻结面),已就地更正并标注来由;CHECKSUMS 仅 backlog.json 行重算 |
| ⑨ | 执行日志截断无提示 | 已收口 | api.ts 导出 EXECUTION_EVENT_PAGE_SIZE=200(fetch 同源引用);NodeDrillDown 满页渲染『仅显示前 200 条日志(更早日志未列出;完整日志可在诊断台查看)』 |
| ⑬ | ApprovalCard 头注与属性 id 现实不符 | 已收口 | 头注修真(二选一取『限定可见文本』臂):approvalId/digest/sha 不入可见文本;拒绝原因输入框可访问性 id approval-reason-<approvalId> 为 label htmlFor 句柄属属性级存在、非渲染文案,如实写明 |
| ⑪ | timeline.ts 头注声称 UI 从未渲染的『依赖成环』标签 | 已收口 | 头注修真(final catch-all wave 按普通『第 N 波』行渲染、无专属环标签;'never creatable' 修为 'refused at creation by the dag gate';grep 实证『依赖成环』全仓仅头注一处) |
| ⑫ | app-product-flow 控制台滤网过宽 | 已收口 | 滤网收紧为 smoke 同款 /Failed to load resource.*403/(认证流本应零 403,等效零容忍,形态对齐);实跑双 e2e 验证不误伤 |
| ⑮ | shell.test 空真断言 | 已收口 | 删除 not.toContain("开发者详情(内部标识)未折叠")(该子串任何渲染不可产生,恒真钉不住回归),留注释说明 |
| ⑯ | 405 载体漂移与派生 id 同构披露 | 已收口(披露于批报告) | 实证:server.ts /api/v1/projects 路径 POST 自 M11-03 起为登记面(通用 405 载体仅此一路径漂移,其余 /api/v1 路径非承诺方法仍 405);派生 id 同构=project-registry.ts:159 与 orchestration/run-creation.ts:217 同用 scheduler derivedId("proj", repoRoot)——登记与首运行创建对同一目录产出同一 id,无第二 id 空间 |

## 3. 多节点可视化(逐项可得/降级)

| 项 | 可得性 | 呈现 |
| --- | --- | --- |
| 多节点时间线 | graph 端点节点+timelineWaves 纯层(既有) | 拓扑分代波;真浏览器多节点链(app-rework-flow,4+4 节点)3+ 波渲染钉住 |
| 轮内并行 | 同波=声明代(数据真实形态) | 任务 3 补真浏览器双卡:workflow 双 developer 根→『第 1 波(2 个角色并行)』+第一波恰 2 卡;进程级同刻派发不断言(呈现层不声称调度真并行,M10-06 口径) |
| 节点图次级视图 | graph 声明依赖 | 时间线/节点图切换按钮;『节点 N(角色)』标签+『依赖:…』结构行;组件化(NodeGraphView)+SSR 契约钉(判别力=裸 id 泄漏进结构行即红;并行合并依赖行正则;行账自洽=行数-根数=依赖行数) |
| 返工轮次 | **既有 M5-02 GET /runs/:id/expansions 端点零改动覆盖**(勘察发现:轮次/fix/re-review 节点状态/findings/hold 全在) | ReworkRounds 组件:第 N 轮:评审(节点 X)未通过,发现 M 个问题→修复(状态)→复审(状态);fix/re-review 节点卡『第 N 轮返工』标签;全部来自持久化 review_expansions 真实行(lineage.ts 明令禁止 id 拼写猜测,未违反);A20 hold→『返工轮次已达上限(3 轮),任务已暂停等待你的处置(产品内的处置入口尚未提供,将在后续版本评估)』(处置文案经勘察修真:resolveRunHold 为包内原语,grep 实证无任何 HTTP/产品面可解 hold,初稿『可在旧工作台处理』系夸大已改);浏览器级全链钉住(2 轮+hold);『再集成』步如实呈现为真实链形状(修复产物直接受审,无再集成节点,不编造) |
| 审批暂停高亮+引导 | WAITING_APPROVAL 节点态+actionable 审批(既有) | timeline-node-waiting 高亮(既有)+『等待你的决定』按钮滚动至审批卡(新);真浏览器钉(app-approval-flow) |
| 执行日志 | 既有脱敏分页端点 | 3s 轮询口径标注+日志按需快照标注(§7);满页『仅显示前 200 条』(⑨) |
| 节点级『在改文件』 | **不可得(评估结论,兑现 M11-03 降级句承诺)**:dispatch kind 仅驱动进程簿记不入持久化图,普通 agent 节点的工作区文件活动无按节点留痕(diff-view.ts 仅集成记录携带候选) | 维持降级句(本批删去『将在 M11-04 评估』尾语——评估已完成,结论=无持久记录,登记不硬造);集成候选臂呈现文件清单+unified(见 §5) |

## 4. Review 产品化(勘察结论)

- **勘察结论(如实)**:verdict(pass/fail)+findings 持久化**可得**——
  review_records(review/src/record.ts,migration 006;verdict 经
  completeReviewRecord 守卫写入,findings 为 JSON 字符串数组);**问题分级
  (严重级)不可得**——contracts ReviewSchema.findings 为纯字符串,无分级
  字段,分级呈现需先有持久化字段(服务端面,红线内不做)→ 如实降级。
- **可达性缺口**:verdict 记录以 (run, review 节点 id, 候选 SHA) 绑定,而
  既有 diff 端点的内嵌 verdict 查询按键=被查节点自己的候选——评审节点无
  集成候选,既有面永远查不到(review 节点的记录经 node-driver.ts:298
  settleAgentReviewClaim 以节点自身 id 落库)。**唯一服务端新增**:
  GET /api/v1/runs/:id/review-records?nodeId=(review-view.ts 新建)——
  带凭据守卫+zod strict 双层(视图 schema+边界 re-parse,漂移即 500)+
  投影白名单(零内部 id/路径/manifest;blocked verdict 为不可能值
  fail-closed 500);API_AND_EVENTS 登记新行+CHECKSUMS 行重算;
  review-records.test.ts 6 格(200 双轮 oldest-first+投影纪律/空列表诚实/
  双 404/zod strict 400/405 Allow/403 守卫)。
- **呈现(Reviewer 节点下钻)**:『结论:通过/未通过(发现 N 个问题)』+
  逐条 findings 列表+多候选多轮记录(oldest first)+『当前评审记录不保存
  问题分级(严重级),仅保存逐条问题描述;分级呈现将在后续版本评估』如实
  句+节点自身返工状态(第 N 轮返工已触发,来自 expansions 面);真浏览器
  全链钉住(app-rework-flow:fail verdict+findings 命中缺失路径+无分级句
  +返工状态)。

## 5. Diff 决策

- **勘察**:diff.unified 文本**既有端点已回**(diff-view.ts -U3,字符封顶
  262,144+截断标记)——走『可得则自有轻量渲染』臂,零服务端改动。
- **实现**:fetchRunDiff 投影扩展 unified/unifiedTruncated;新
  diffLines.ts 纯分类器(逐行前缀协议:meta/hunk/add/del/context)+新
  components/UnifiedDiff.tsx(纯 React 文本节点,零 dangerouslySetInnerHTML,
  零高亮库,遵守 M11-03 交接转义纪律);双截断均声明(服务端字符帽+
  渲染器 MAX_DIFF_RENDER_LINES=2000 行帽)。
- **测试**:diffLines.test 4 格(前缀分类/包含非更改/类映射/真实片段端到
  端)+shell.test UnifiedDiff SSR 渲染契约 2 格(增删类恰一、上下文不着
  色、script 标签转义为文本、双截断文案);真浏览器验证到候选文件清单臂
  +空 unified 诚实臂(fake-cli 产品链无提交)——彩色行真实浏览器像素归
  维护者真实任务(§10)。

## 6. 审批 e2e(app-approval-flow,判别力双向实证)

- 链:向导登记(新 git fixture)→四角色绑定(developer=proposal profile,
  fake-cli action-proposal,proposal profile 绑定语义=M9-01 格⑤先例)→建
  任务→节点 WAITING_APPROVAL+run blocked→审批卡全要素(argv/高风险/
  repo.write/过期)→批准→消费卡『已被任务继续流程消费』+**新 PENDING 卡
  无刷新出现**→下钻尝试次数 2→再批准→3 次;A19 断言:提案路径始终
  不存在(两次批准后仍 false)。
- **判别力=旧实现下格红,双向实证(非声称)**:临时还原 M11-03 版
  runIsTerminal(blocked=终态)并重建 dist 后,该格恰红(TimeoutError at
  text=每 3 秒自动刷新,15s 超时,20.6s 失败);复原修复后重建,全绿
  (11.3s)。旧实现三处不可达:暂停期轮询指示消失、决策后新 PENDING 卡
  永不出现(轮询已死)、尝试数停在一。
- 配套:app-rework-flow.test.ts 新建(多节点验收面浏览器全链:4 节点声明
  (双并行根)→review 场景恒 fail→自动扩图 2 轮→A20 hold;断言时间线波/
  并行双卡/返工轮次段+轮次标签/节点图结构行/Reviewer 下钻四要素/集成候选
  臂/控制台滤网);app-product-flow 扩展(节点图切换往返)。

## 7. 日志实时性决策(任务 3,二选一)

**裁决=(a) 保持 3s 轮询+如实标注。** 实现:PollRefreshBadge
(components/RunVisualization.tsx)为轮询口径唯一声称点(非终态含 blocked
可见/终态恰消失,SSR 双格钉);执行日志面板新增『日志按需加载,不自动续拉;
点「刷新」获取最新(节点状态每 3 秒自动刷新)』——节点状态轮询与日志快照
两种口径分开如实写明;页面头注记录决策。

**(b) one-time ticket WS 放弃理由(全文)**:①需新增带凭据的一次性票端点
+WS 握手认证链改动,而 ADR 010(冻结面)已记载 ws 握手 fail-closed、壳的
Authorization 注入不覆盖 WS upgrade——(b) 必然伴生冻结面 ADR 增补+缓解清
单+票的单次短时/时钟/重放新边界,安全面与文档面成本显著高于收益;②单操作
者本地产品中,节点状态/审批/轮次的 3s 轮询+显式刷新已满足观测需求,日志
live-tail 的增量价值未被任何真实使用反馈证明(维护者真实使用主线未开始);
③WS 直播流并未消失——旧观测台的开发者级路径(ws-events.ts)保留,产品 UI
与开发者面分层不因 (a) 收窄。若维护者真实使用反馈要求 live tail,(b) 可在
后续批按 ADR 增补流程重评。

**多节点可视化补充(任务 3 第 2 项)**:可视化面组件化抽取
(RunVisualization.tsx:PollRefreshBadge/NodeGraphView/ReworkRounds/
nodeGraphLabels)+SSR 渲染契约 3 格(逐格判别力:裸 id 泄漏进结构行即红/
无轮次渲染空串即防伪造返工历史/终态徽标消失)+e2e 并行双卡真浏览器钉
(§6)。纯抽取经 76/76 套件证明行为保持。

## 8. 变更文件清单(批累计,单一提交,32 文件)

任务 1(18 文件):CHECKSUMS.sha256、project/backlog.json、
reports/M11-03-BATCH.md、apps/desktop-ui/src/{api.ts、runStatus.ts、
runStatus.test.ts、runErrors.ts、runErrors.test.ts、workflowDraft.ts、
workflowDraft.test.ts、timeline.ts、shell.test.tsx、components/
ApprovalCard.tsx、components/RoleBindingSection.tsx、pages/NewTaskPage.tsx、
pages/ProjectsPage.tsx、pages/RunDetailPage.tsx}。

任务 2(11 文件,其中 7 新):docs/API_AND_EVENTS.md、
packages/local-api/src/{server.ts、review-view.ts(新)}、
packages/local-api/test/review-records.test.ts(新)、
apps/desktop-ui/src/{api.ts(已计)、diffLines.ts(新)、diffLines.test.ts(新)、
components/UnifiedDiff.tsx(新)}、
packages/browser-e2e/test/{app-product-flow.test.ts、
app-approval-flow.test.ts(新)、app-rework-flow.test.ts(新)}、
apps/desktop-ui/src/app.css。

任务 3(4 文件,其中 1 新):apps/desktop-ui/src/
{components/RunVisualization.tsx(新)、pages/RunDetailPage.tsx(已计)、
shell.test.tsx(已计)}、packages/browser-e2e/test/app-rework-flow.test.ts(已计)。

任务 4(本提交,3 文件):reports/M11-04-BATCH.md(新,不入冻结面)、
PROPOSALS.md、docs/BACKLOG.md。

去重合计 32 文件(24 改+8 新:RunVisualization/UnifiedDiff/diffLines/
diffLines.test/review-view/review-records.test/app-approval-flow/
app-rework-flow)。CHECKSUMS.sha256 与 project/backlog.json 在任务 1 已改、
任务 4 再改,按文件计一次。

## 9. 测试及退出码(2026-10-08 本会话实跑,逐命令)

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`(仓库根,任务 1/2/3 后各轮) | 62/62 successful;exit 0(任务 2 首跑自曝 loadRunFaces 元组类型错 4 个 TS 错,修复后绿) |
| `pnpm test`(仓库根,任务 3 终态复跑) | 74/74 tasks successful;exit 0(2m32s;全仓含 browser-e2e 对新 dist 实跑) |
| `pnpm exec vitest run`(packages/local-api 直跑) | 30 文件 349/349 passed;exit 0(原 343+review-records 6) |
| `pnpm exec vitest run`(apps/desktop-ui 直跑) | 8 文件 79/79 passed;exit 0(原 62+任务 1 增 8+任务 2 增 6+任务 3 增 3;首跑 2 格红均为新格自身错[missingCount 算术/GRAPH_INVALID 兜底臂断言/SSR 注释分隔符],修正后绿,判别力如实) |
| `pnpm exec vitest run`(packages/browser-e2e 直跑) | 15 文件 26/26 passed;exit 0(app-approval-flow 11.3s/app-rework-flow 17.7-27.9s/app-product-flow 8.0s 含节点图切换;旧 12 流零回归) |
| **判别力双向实证** | 临时还原 M11-03 runIsTerminal(blocked=终态)+重建 dist→app-approval-flow 恰红(TimeoutError at text=每 3 秒自动刷新);复原+重建→绿(11.3s) |
| `pnpm build`(仓库根) | 37/37 successful;exit 0(desktop-ui dist 含节点图/返工轮次/评审记录/unified 渲染,grep 实证) |
| `node planning-check.mjs`(任务 2/4 各轮) | (a) 80/80 checksums match+(b) self-test exit 0(API_AND_EVENTS/BACKLOG/PROPOSALS/backlog.json 行重算后) |
| 全批 32 文件 BOM/CR 检查(python 逐字节,提交前终态) | 全部 BOM=False CR=0 纯 LF 尾 LF |

## 10. 未验证项

1. **多节点真实任务全流程(归维护者)**:完成标准『多节点真实任务全流程
   在产品 UI 内闭环』以真实 Claude/Codex 为准——自动化面=hermetic 全链
   (app-rework-flow:双并行根→集成→评审 fail→两轮返工→hold,真
   Chromium 全断言)已建并绿;真实 CLI 的最后一步归维护者环境(红线,不
   伪造)。评审产品化的浏览器验证已在本批 fake-cli 链内达成(verdict/
   findings/无分级句/返工状态),真实 CLI 的 findings 质量归维护者评估。
2. **节点级『在改文件』持久化评估结论(兑现 M11-03 降级句承诺)**:
   **不可得**——dispatch kind 仅驱动进程簿记、不入持久化图;普通 agent
   节点的工作区文件活动无按节点留痕;集成候选(Diff)仅在有集成产出的
   节点可得。结论=维持降级呈现(原句『将在 M11-04 评估』尾语已删,评估
   已完成);若未来需要,须先有 store 侧留痕面(服务端,非 UI 批)。
3. 彩色 diff 行的真实浏览器像素:fake-cli 产品链不产生文件提交→候选无文
   本改动→浏览器格验证到候选臂+空 unified 诚实臂;着色渲染由分类器单测+
   SSR 渲染契约钉住;真窗彩色 diff 归维护者真实任务。
4. hold(轮次上限)后的产品内处置入口不存在(resolveRunHold 为包内原语,
   无 HTTP 面)——UI 如实标注;处置归维护者/后续版本。
5. 『每 3 秒自动刷新』在真窗壳内的观感与 3s 间隔逐包节奏未逐秒断言(常量
   钉源码;轮询行为由 e2e 容差内到达间接证明)。
6. 审批决策在真窗壳注入下的端到端(headless 以 context 级 header 模拟
   ADR 010,守卫管线所见=普通已认证请求)——M11-03 遗留项延续。
7. 10 轮审查属批次后续流程(完成标准内),本报告交付时未开始。

## 11. M11-05 交接

- **已就绪面**:详情页四只读面轮询骨架(detail/graph/approvals/expansions
  统一 loadRunFaces)+三可视化组件(PollRefreshBadge/NodeGraphView/
  ReworkRounds,纯渲染可 SSR 测试)+UnifiedDiff/diffLines 纯层+review-
  records 只读端点+三条 /app e2e 基座(product-flow 全点击链/approval-flow
  判别力方法/rework-flow 多节点+扩图链,均含控制台滤网与 ADR 010 模拟认
  证先例)。
- **缺口(如实移交)**:①设置重写(AI 模型/Agent 团队/高级折叠)——设置
  页仍是占位骨架;②开发者模式收纳(观测台/Raw API/DAG Inspector 归设置>
  开发者);③hold 处置的产品内入口(resolveRunHold 无 HTTP 面,需先有服
  务端只写端点再谈 UI——超 UI 批红线,须另行立项);④问题分级(严重级)
  呈现——须先有持久化字段(contracts ReviewSchema 扩展+review_records 迁
  移,服务端面);⑤安装态 E2E(干净机路径)与 v0.4.0 版本抬升/发布(维
  护者批准链)。
- **测试面交接**:RunVisualization 三组件 SSR 契约格(伪造数据即可测,无
  需浏览器);app-rework-flow 的多节点+扩图+hold 链可作为 M11-05 安装态
  E2E 的场景模板;approval-flow 的旧实现判别力双向实证方法(临时还原→
  红→复原→绿)可供后续格复用。
- **约束提醒**:产品文案零内部 ID 默认视图纪律(shell.test 钉子持续有效;
  节点图/返工轮次结构行已钉零裸 id);服务端-authored 目标散文(proposal
  修复指令)引用节点 id/SHA 属持久化内容,如实渲染不属泄漏(批报告 §3
  口径);同步一次性门(oneShotGate)模式可复用;diff/unified 渲染沿用
  转义纪律(零 dangerouslySetInnerHTML);git add 显式路径;冻结面改动纯
  LF+重算 CHECKSUMS。
