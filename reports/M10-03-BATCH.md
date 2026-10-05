# M10-03 交付批报告(返修版)—— 多节点编排(声明层 v1 限制:每任务一个集成节点)+ 四角色绑定 UI(2026-10-05)

## 0. 返修记录(2026-10-05,第 1 轮审查阻断收口)

第 1 轮审查以实验实锤两项阻断(根因同源:声明层开放了 M7 integration 服务
(per-run 单集成——单 task 分支+单 integration worktree)支撑不了的图形态):

- **B1 链式 integration 确定性死锁**:`settleMultiNodeTerminal`
  (packages/orchestration/src/node-driver.ts)把上游 integration 的 accepted
  输出记账为 task/<runId> 分支上的 candidateSha,而该分支 tip 恒为合并基线;
  下游 integration 的 buildParents→integrateParents 校验「branch tip === 记账
  headSha」必抛 ParentOutputMovedError(packages/integration/src/integrate.ts)。
- **B2 并行 integration 候选含未声明依赖内容**:task 分支与 integration
  worktree 均 per-run 单例,第二个 integration 复用同一 task 分支续并,候选
  累积前一 integration 产物(即使无声明依赖边),review verdict 归属被污染。

**返修方案(维护者批准链内的务实收窄)**:声明层强制「每任务至多一个
integration kind 节点」(0 或 1 合法;≥2 一律拒绝)——链式/并行集成 v1 不支持,
后续版本需 M7 集成服务扩展,如实文档。该限制与 dogfood 母本形态一致(单
integrate 节点汇合多 developer 并行产物,BACKLOG 验收原文「多 Dev→Integration
→Reviewer」恰为单集成形态),产品主场景完全覆盖。落位两处:

1. **生产 POST /api/v1/runs 域门**:`validateWorkflowSpecs`
   (packages/orchestration/src/multi-node.ts)新增图级规则——integration 节点
   数 >1 抛 typed 400 `WORKFLOW_INTEGRATION_NODE_COUNT`,可读原因逐字
   「当前版本每任务支持一个集成节点;链式/并行集成将在后续版本支持」。
2. **冻结图模板生成器**:`toFrozenWorkflow`(同文件)独立携带同一
   at-most-one 门(同 typed 载体,defense in depth)——即使未来调用方绕过
   validateWorkflowSpecs,进入冻结图(及图修订行)的形状也必然合规。

测试钉死:orchestration multi-node.test.ts 新增 2 格(并行对拒绝+链式对拒绝
+0-integration 合法锚——0/1 边界显式固定,审批链 e2e ④ 的 plan→impl→review
零集成形状保持合法全绿;模板生成器独立防御格);local-api runs-multi-node
格① 新增 2 个 domainCells(两并行 integration/integration 依赖 integration
→400 WORKFLOW_INTEGRATION_NODE_COUNT,零行创建)+ 线上可读原因逐字断言。
本限制**不**改为「恰一个」:0-integration 多节点声明(纯 agent 链/审 agent
输出)机制上不受 B1/B2 影响,且恰一规则会打破既有绿色格④(零行为回归红线)。

## 1. Summary

## 1. Summary

M10「编排产品化」价值主体批(BACKLOG M10-03;M10-02 统一 RunDriver 的直接后续)把
M10-02 预留的两条接缝接到生产,并在浏览器侧补齐四角色配置的 UX 缺口:

- **多节点编排入生产入口**:POST /api/v1/runs 新增可选 strict `workflow` 字段
  (节点 id/role/kind[agent|integration|review]/objective/dependencies),生产
  RunDriver 按 kind 分派——agent=CLI 执行、integration=M7 单写合并(integrateParents,
  candidateSha 即后继基线)、review=reviewer CLI + M8 固定 SHA 审查会话(fail 落
  A12 绑定 verdict)+ 驱动自主触发 M10 受控扩图(A04/A38/A20 全链,repair/
  re-review 对自动入泵);依赖基线走 M5 baselineFor(后继节点基于前序 accepted
  output SHA,无 committer 时按 GIT_AND_WORKSPACES「没有代码修改的节点沿用
  inputSha」回落);轮循环/串行派发/all-terminal 收敛/catch-per-run 隔离逐字保持。
- **角色上下文注入(M6 接缝落地)**:多节点每个 CLI 节点的 stdin prompt =
  角色职责标头 + 节点 objective + 依赖产物引用(节点 id + accepted headSha;
  review 节点即被审 candidateSha);单节点路径保持裸 objective(v0.2.1 逐字平价);
  Memory/Context 完整注入留 M10-04(代码注释标明接缝)。
- **审查 verdict 的生产通道(零注入命令面)**:机器证据 = 审查者自身 engine 运行
  (recordValidationArtifact 记 exitCode——review 包文档明示的 engine 结果入口);
  verdict/findings = 冻结 contracts ExecutionResultSchema.review 通道(fake-cli 新
  `review` 场景以 `--review-exists` 内容判据说话);blocked/无结构化 verdict/
  fail 无 findings 一律节点 FAILED fail-closed,不开会话、不发明 verdict;
  A12 绑定 = 会话固定 candidateSha,agent 载荷声称的 SHA 不被信任。
- **四角色绑定 UI(外部评估第十节提前项)**:配置页新增「项目角色绑定(四角色,
  一次保存)」区(byDir 定位 + GET /api/v1/profiles 下拉 + 一次 PUT 四绑定,事务式
  全落或全不落)+ 新建任务表单绑定门控(绑定齐→启用+developer 只读提示;不齐→
  置灰+指向配置页;未登记目录→保持启用——422 探针是项目登记的唯一机制),消除
  「建任务→422→手动调 API」的开发者式流程。

多节点声明方式的决策:**(a) 自定义图已做,(b) 预设模板端点本批未做**(最简可行
裁决:模板是 (a) 之上的纯糖,客户端可由同一 schema 派生四节点图;加端点=新路由
+守卫面+契约测试而零表达能力增益;若维护者要求,落位点=local-api orchestrator.ts
schema + 静态页,能力上无前置依赖)。**v1 受支持形态收窄(返修,§0)**:自定义图
的表达面为「每任务至多一个 integration kind 节点」的 DAG(0/1 合法),链式/并行
集成不支持。

性质实录:六个功能提交 0702385(orchestration 多节点核心)/c6c8523(fake-cli
review 场景)/84c1f37(local-api schema+ports 透传)/3732f93(生产入口多节点 e2e
+integration 节点补齐 dogfood 母本 CLI 形状)/272bb80(orchestration 包描述如实
化)/8990c7c(四角色绑定 UI),本治理提交收口。零新增外部 npm 依赖,零新增包
(boundary-audit manifest 36 名与 release-audit workspacePackageCount 37 均无变化
——M10-02 已登记的两计数器口径不受本批影响)。

## 2. 多节点编排设计(模板+自定义图决策)

**声明层(自定义图)**:kind 是驱动进程派发簿记,不入 store——冻结 contracts
TaskNodeSchema 严格且无 kind 字段(A02 类型级断言),图修订行按冻结 schema 往返;
kinds 存 `context.multiNodeRuns` 的 per-run book(kinds/acceptedOutputs/candidates),
随创建登记、随扩图登记(minted fix=agent、re-review=review)。fail-closed 矩阵
(resolveNodeKind):无 book + 单节点形(恰一 execute)=agent(v0.2.1 平价)/有
book 按登记/登记 run 未知节点、review 节点角色被改、重启后多节点 re-drive=
OrchestrationDriverError 拒派发,绝不把 integration/review 节点误当 CLI agent
执行;durable claim 留 A24 恢复面。

**HTTP schema(模板候选位)**:RunCreateBodySchema 增可选
`workflow.strictObject({nodes: …}).min(1).max(64)`——逐字段形状/边界在 zod strict
(未知字段 400 INPUT_REJECTED,任意嵌套无 profileId/model 载体=A02 双层:此处 +
dag 冻结 schema);跨字段合法性在 orchestration 域门(validateWorkflowSpecs:预算
64/dup id/未知与自依赖/integration 需 ≥1 父/review 恰 1 依赖且 reviewer 角色
[expand NotReviewNodeError 同规],typed 400 WORKFLOW_*);**v1 集成节点数门
(返修新增):integration kind 节点 ≤1,≥2 = 400 WORKFLOW_INTEGRATION_NODE_COUNT
+可读原因,校验在 validateWorkflowSpecs(生产域门)与 toFrozenWorkflow(冻结图
模板生成器,独立防御)双处落地——见 §0**;拒绝零行(纯预写
validateWorkflowGraph 门先于任何 store 写)。workflow id/name 与冻结派生字段
(title/capabilityTags/acceptanceCriteria)服务端派生,调用方不可携带。**模板端点
未做**(见 Summary 决策)。

**派发与基线**:M5 baselineFor(依赖逆序取最近 accepted headSha,回退 run.baseSha)
决定 worktree 基;integration=M7 settleIntegrationClaim 后照常 launch 本节点 CLI
(dogfood 母本 568 行形状——否则调度器 claim 的 attempt 行永停 STARTING,attempt
结算归 engine 所有);candidateSha 入 candidates 表并作为 accepted 输出=后继基线。
agent 节点 SUCCEEDED 后经注入的 OutputCommitter 端口提交(生产组合根不传=零提交,
accepted 输出回落 inputSha);无 committer 时基线数学上仍正确(回落链),但下游
不包含上游 agent 产出——受控 Git Service 落地前的如实边界(待确认项 (a) 维持开放)。

**审查/扩图**:review 节点 SUCCEEDED 恒成立(verdict 是数据);fail→
requestReworkExpansion(requester=coordinator[A04],A38 乐观锁由 rework-driver 调用
瞬间读取,minted 即登记 kinds,A20 三轮封顶/user hold 不变)。续行(approval
checkpoint)经注入的 SettleMultiNodeContinuation 走同一 kind 结算,worktree 基=
baselineFor(approval-driver 保持零 node-driver 运行时边,模块单向)。

## 3. 角色上下文注入实现

家在 packages/orchestration/src/execution-input.ts(M10-02 预留的 M6 接缝):
- `buildNodePrompt`:确定性拼装——`[role: <r>] <固定职责标头一行>` + `任务目标:<objective>`
  + `依赖产物:` 逐依赖 `节点 <id>:accepted 输出 <headSha>`(无依赖=「基于 run 基线
  提交」)+ 尾注「Memory/Context 注入为后续批次接缝,本提示未携带」。
- `nodePromptObjective`:launch objective 汇聚点——无 book=objectiveOfRun(裸
  objective,v0.2.1 逐字);有 book=角色上下文。M4 派发与 M9 续行两条 launch 路径
  都经此(无环:实现在 execution-input,drivers 共同消费)。
- `objectiveOfNode`:图修订 walk(newest→oldest,跳 expand 结构占位——expand 新增
  STRUCTURAL_PLACEHOLDER_OBJECTIVE + isStructuralPlaceholderObjective 导出,消费者
  不再做散文匹配);原始节点取其真实定义,扩图 minted 节点取扩图修订中的真实
  objective。
- prompt 的落盘可断言:engine 把 prompt 写入 worktree 的 stdin-<executionId>.prompt
  .txt,e2e 逐字断言(plan=coordinator 标头+无依赖;impl 引用 plan 的 accepted
  输出=run base[沿用 inputSha];review 引用 integrate 的 candidateSha)。
- **M10-04 接缝位置(交接,见 §7)**:本函数族即注入点;Memory/Context 内容源
  (docs/MEMORY_AND_CONTEXT.md)经新端口(先例:OutputCommitter 生产缺省 none)
  注入即可,派发/续行两侧无需再改。

## 4. 绑定 UI(四角色)

- 配置页新增「项目角色绑定(四角色,一次保存)」区(#role-bindings-config):byDir
  定位(GET /api/v1/projects/role-bindings?projectDir=…)+四个 select(GET
  /api/v1/profiles 仅选择相关字段;当前绑定预选;当前列示 durable 真相)+一次保存
  (PUT /api/v1/projects/:id/role-bindings,ensureCsrfToken 会话 CSRF;成功注记在
  面板重载后写入——先写会被重载抹掉,浏览器实测抓出后修正);404 PROJECT_UNKNOWN
  =roleBindingsAbsenceHtml 诚实引导(先回工作台登记,422 是登记信号);typed 错误
  逐字(404 登记/422 UNKNOWN_PROFILE/422 EXECUTION_TARGET_MISMATCH A29/403/400)。
- 新建任务表单门控:createFormGate 三态(未知项目=启用——首次创建登记;四绑定齐=
  启用+developer 提示;不齐=objective+submit 置灰+静态指引指配置页签;projectDir
  保持可编辑)。
- 消毒与守卫:全部动态值经 esc()(敌意 profileId 转义逐字断言);保存载荷经
  allowlist(恰四内建角色,多余字段拒绝);无任何 model/profile 载体;后端事务式
  写与守卫管线五查/token/CSRF 全部原样。

## 5. 变更文件(git diff 4097d60..8990c7c,26 文件 + 本收口 3 文件)

- orchestration(14):src/{multi-node(新),node-driver,review-driver,run-creation,
  run-driver,approval-driver,execution-input,driver-contract,ports,context,errors,
  index,package.json}.ts/json + test/multi-node.test.ts(新)
- expand(1):src/expander.ts(STRUCTURAL_PLACEHOLDER_OBJECTIVE + 判定谓词导出)
- fake-cli(5):src/{scenarios,args,runner,main}.ts + test/scenario-matrix.test.ts
- local-api(5):src/{orchestrator,page}.ts + test/{runs-multi-node(新),page}.test.ts
- browser-e2e(2):src/browser.ts + test/flow-8-bindings.test.ts(新)
- 本收口(3):reports/M10-03-BATCH.md(新,不入冻结面)+ PROPOSALS.md(披露节)+
  CHECKSUMS.sha256(PROPOSALS 行按盘上纯 LF 字节重算)
- 返修(6):orchestration src/multi-node.ts(v1 集成节点数门双处)+
  test/multi-node.test.ts(+2 格);local-api test/runs-multi-node.test.ts
  (格① +2 domainCells+可读原因线上断言);docs/BACKLOG.md(M10-03 行 v1 限制
  声明)+ PROPOSALS.md(披露节返修块+标题收窄);CHECKSUMS.sha256(BACKLOG/
  PROPOSALS 行按盘上纯 LF 字节重算)

## 6. 测试及退出码(初批 2026-10-05 实跑;返修口径见 §6.1)

| 门禁 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| orchestration | pnpm --filter …/orchestration run typecheck / build / test | typecheck/build 过;test 41/41(新 11+旧 30) | 0 |
| expand | pnpm --filter …/expand run test | 27/27 | 0 |
| fake-cli | tsc + build + vitest | 29/29(矩阵 +4 行 +2 格) | 0 |
| dogfood(母本回归) | pnpm --filter …/dogfood run test | 13/13(A17/A19/A22/A24 全绿) | 0 |
| local-api | pnpm --filter …/local-api run test | 258/258(247 旧契约零改动 + 4 多节点 e2e + 7 绑定 UI 页面格) | 0 |
| browser-e2e | pnpm --filter …/browser-e2e run test | 22/22(11 文件含新 flow-8) | 0 |
| boundary-audit | pnpm --filter …/boundary-audit run test | 34/34(隔离复核;本批零新包) | 0 |
| 全仓 typecheck | pnpm typecheck | 61/61 | 0 |
| 全仓 build | pnpm build | 36/36 | 0 |
| 全仓 test(缓存口径) | pnpm test | 72/72(63 cached) | 0 |
| 全仓 test(冷口径) | turbo run test --concurrency=4 --force | 72/72 任务,0 cached,4m43.5s | 0 |
| 冻结面 | node planning-check.mjs | (a) 79/79+(b) self-test exit 0;批内复跑 2 次均 exit 0 | 0 |

### 6.1 返修门禁(2026-10-05 返修会话实跑;全量 --force 冷口径)

| 门禁 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| orchestration(包级先行) | pnpm --filter …/orchestration run typecheck / build / test | test 43/43(+2:v1 集成节点数门 2 形态拒绝+0/1 边界锚;模板生成器独立防御格) | 0 |
| local-api(多节点文件先行) | pnpm exec vitest run test/runs-multi-node.test.ts | 4/4(格① 新增 2 domainCells+可读原因线上断言) | 0 |
| 全仓 typecheck | pnpm typecheck | 61/61 | 0 |
| 全仓 test(冷口径) | pnpm exec turbo run test --concurrency=4 --force | 72/72 任务,0 cached,3m27.9s | 0 |
| 全仓 build(冷口径) | pnpm exec turbo run build --force | 36/36,0 cached,35.2s | 0 |
| 全仓 test(缓存口径) | pnpm test | 72/72(72 cached) | 0 |
| 冻结面 | node planning-check.mjs | (a) 79/79+(b) self-test exit 0 | 0 |

如实登记:①默认并发全仓 test 首跑 local-api#test 单败(既有满载 hook 脆弱性,
M10-02 已登记;local-api 单独实跑 258/258 即绿);②一次缓存口径
`pnpm test -- --concurrency=4` 出现 boundary-audit+capability-gate 2/72 瞬时失败,
两包隔离实跑与冷 --force 均绿,定性 flake 未深究;③browser-e2e 首跑 flow-4 满载
单败+flow-8 一处真实竞态(save 注记被重载抹掉,已修页面),隔离与复跑均绿。

## 7. 未验证项(如实移交;返修后口径)

**返修口径更新**:链式/并行 integration 形态在生产入口创建时即被声明层拒绝
(WORKFLOW_INTEGRATION_NODE_COUNT,v1 限制,见 §0)——这两类形态不再存在
「未验证的真实运行行为」,其不可支持性是声明契约与测试钉死的事实;真实 CLI 对
受支持形态(0/1 个集成节点)的多节点行为仍未验证,口径不变。

1. **真实 CLI 多节点冒烟未跑**:全部端到端为 fake-cli 替身(仓库纪律);真实
   claude/codex 对多节点 prompt/结构化 review 通道(ExecutionResult.review)的
   行为未验证——归维护者 real-CLI smoke。
2. **真窗交互未验证**:桌面壳(electron)内页面与绑定流的真窗验收未做;本批与
   既有页面同为 hermetic 纪律。
3. **(b) 预设模板端点未做**(决策见 §1/§2;落位点已登记)。
4. **OutputCommitter 生产缺省=待确认项 (a) 维持开放**:生产多节点无 committer 时
   下游基线回落 inputSha(基于 run base 而非上游 agent 产出);「B 基于 A 的
   accepted output」的完整形态在注入 committer 的组合根成立(测试即此形态)。
5. **Memory/Context 注入未实现**(M10-04 接缝,代码注释标明,见 §8)。
6. **并发保持 serial**(红线);dispatchJoin=parallel 未接线(M10-04)。
7. **重启后多节点 re-drive=拒绝 fail-closed**:resolveNodeKind 矩阵单测覆盖,
   无 e2e 重启格;durable claim 留 A24 恢复面。
8. **WS 多节点形态未加专格**:事件经未改动的 engine 持久化管线(校验和零漂
   断言覆盖);既有 ws-* 套件零回归。
9. **getReviewVerdict 的 invalidated/none 两 kind** 未展开专格(A12 负向断言按
   not-valid 表达)。

## 8. M10-04 交接

- **Memory/Context 注入接缝位置(唯一汇聚点)**:
  packages/orchestration/src/execution-input.ts 的 `buildNodePrompt`/`nodePromptObjective`
  (头注释「M10-04 SEAM」标明)——M4 派发与 M9 续行两条 launch 路径都已收口于此;
  内容源经新 RunDriverPorts 端口注入即可(先例:OutputCommitter 生产缺省 none,
  driver-surface 无命令字段红线继续有效),drivers 零改动。
- **并发开放**:runPumpRounds 的 dispatchJoin/参数与 PUMP_CONCURRENCY 常量组
  (constants.ts,注释标明「opening concurrency is the separate M10-04 decision」)
  已就位;生产组合根仍 serial+catch-per-run。
- **FAILED outcome**:run 状态词汇表无 failed 值(失败证据在节点/执行行,
  settleRunStatus 注释标明)——词汇表扩展是 M10-04 决策。
- **模板端点候选位**(若做):local-api orchestrator.ts 的 RunCreateBodySchema + 静
  态页;多节点执行机制无前置依赖。
- **接缝勿动清单(沿 M10-02)**:RunDriver 六操作暴露面(driver-surface 钉死)、
  审批红线(驱动永不批准)、M8 无注入命令面(driver-surface 类型钉死
  RunDriverPorts 无 validation* 字段)、A38 驱动侧读锁(rework-driver)。
