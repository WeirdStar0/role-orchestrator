# V031-01 批报告——测试稳定批:并行故障专项 + 登记缺口逐项闭合(2026-10-06)

## 1. Summary

v0.3.1「Real Usage & Stabilization」的 P0 仓库内批,两个工作项、两个提交,
零外部 npm 依赖(lockfile 零变化):

- **任务 1 并行故障专项(commit fb69e5b,4 文件)**:唯一生产改动=
  per-dispatch 隔离日志——pump-primitives 并行 join 增可选
  `onDispatchFault` 逐派发记录钩子,run-driver 接既有 LogSink;同轮并发
  第二个故障的 rejection 不再被 Promise.all 静默吞没(M10-04 审查 R4 建议
  落地)。join/隔离语义逐字节不变;新增 parallel+catch-per-run 专格 2 格
  (58→60),变异实证非恒真;shutdown 取消快照 straddle 窗口以注释登记
  (引 PROPOSALS M10-05 勘误 3),零行为改动。
- **任务 2 聚合与登记缺口逐项(commit b3ac603,4 文件,零生产改动)**:
  WAITING_APPROVAL>FAILED 聚合优先级格、「其余→null」直接断言、审批续行
  窗口现状锚(发现并如实登记:登记预期的 mid-flight blocked→null 在 v1
  语义下不可经 run outcome 观测)、409 七字段漂移门正向用例(实际触发面
  =PUT role-bindings)、M10-05 登记缺口五格(context-refs 上限/fail-open
  复合/未知项目降级/预算 halt-on-first-overflow/flatten 多行)、
  apps/desktop-shell/README 三处将来时回指 M10-06 §4.3 已执行证据链。

门禁(2026-10-06 本会话实跑):orchestration vitest 65/65 exit 0
(58+2+5);local-api vitest 267/267 exit 0(263+1+3,先重建 orchestration
dist);pnpm typecheck 61/61 exit 0;orchestration build exit 0;任务 1 期
共享泵消费方旁证 e2e-baseline 21/21、browser-e2e 22/22 exit 0。
「10 轮审查」属批次后续流程,未在本交付内完成(历批同口径,M10-05 §8.6
先例)。红线遵守:业务行为语义零变化(唯一生产改动=per-dispatch 隔离
日志);stdout 事件协议、A36 脱敏边界、事件 REST/WS 契约、守卫/审批/
调度四层约束零触碰;零新增外部依赖;git add 显式路径;无 push 无 tag。

## 2. 任务 1:并行故障专项(commit fb69e5b)

### 2.1 生产改动(唯一允许面):per-dispatch 隔离日志

- `packages/orchestration/src/pump-primitives.ts`:`PumpRoundsDeps` 增可选
  `onDispatchFault(error, round)` 钩子;parallel join 分支每个派发 promise
  先 `.catch` 记录再原样 rethrow。Promise.all 只上浮同轮**首个** rejection
  至 catch-per-run 边界(onIsolatedError)——此前同轮第二并发故障零记录。
  钩子只记录后原样 rethrow:join 的 rejection 身份/时序/隔离边界不变;
  serial join 无此窗口(逐个 await 本就全量入 catch);benchmark 泵
  (browser-e2e/e2e-baseline)不传钩子,零触碰(单测旁证见 §5)。
- `packages/orchestration/src/run-driver.ts`:接线 `onDispatchFault`→既有
  `LogSink`(`createStdoutLogSink`,redactText 先行,ports.ts:37-43,与
  `drive failed`/`round bound` 注记同面同纪律),记
  `[orchestrator] dispatch fault (round N): <message>` 一行。stdout 事件
  协议(事件流 JSON)、A36 脱敏边界(sink 内 redactText 不变)、事件
  REST/WS 契约零改动;隔离语义不变(单 run 故障仍不杀 serve,故障仍恰
  终结该 run 的驱动)。
- `packages/orchestration/src/node-driver.ts`:shutdown 取消快照 straddle
  窗口(派发路径 `await createWorktree` 先于 `launchExecution` 的
  `activeCancels.set`)以注释登记——引 PROPOSALS M10-05 批勘误 3:窗口内
  (已派发未注册)执行不在 shutdown 的 allSettled 遍历内,由自身完成/
  超时收敛;兜底=引擎树杀+A24 证据 reconcile(A22);e2e 格⑦钉注册后
  覆盖。零行为改动。
- 同步头注释三处(pump-primitives 模块头/dep 注释、run-driver 模块头/
  driveRun doc)。

### 2.2 新专格逐格判别力(pump-primitives.test.ts,58→60)

1. **格「dispatchJoin parallel + catch-per-run:thrown fault」**:单轮
   [a,b,c],a@5ms/b@15ms 双故障、c@30ms 非故障在飞。断言:pump 正常返回
   `{rounds:1, stopReason:"isolated-error"}`(驱动链继续;兄弟 run 隔离+
   serve 存活由 e2e 格⑥端到端钉)、round 2 永不 poll("d" 不派发)、
   `onIsolatedError` 恰收 join 首故障 ["boom a"](run 边界隔离语义未变)、
   `onDispatchFault` 双记录 ["boom a@1","boom b@1"](boom b=曾被吞没者,
   且在 pump 返回后才落记录=钩子价值本体)、join 每个在飞 promise 由测试
   join 后 c 自行结算(兄弟不因故障中止)。
   红路径:回退 bare join→onDispatchFault 永不触发→faults 空→红;隔离
   破坏(故障逃逸)→rejects→红;故障不终结驱动(allSettled join)→
   round-bound 红;中止在飞兄弟→c 不结算→红。**变异实证**:临时回退
   primitive 为 bare join 后两新格红(断言输出 `expected [] to deeply
   equal ['boom a@1', 'boom b@1']`)而旧 58 格全绿,已恢复原实现复跑
   60/60。
2. **格「超时传播现状锚」**:parallel 下 t@8ms 引擎超时形故障不中止同轮
   在飞兄弟 s(s@25ms 自行终态,事件序 poll→start:t→start:s→
   fault:timeout t@1→end:s,end:s 严格晚于 fault)。注释明示**现状锚非
   期望规范**——v0.4 run 级取消若改「超时中止同轮兄弟」语义必须有意改写
   本格。红路径:增兄弟中止→end:s 不落地→红;超时故障不终结驱动→
   stopReason 红。

### 2.3 shutdown 全取消覆盖零回归(既有格核实)

`runs-multi-node.test.ts` 格⑦(parallel dispatchJoin 双 READY 兄弟同飞、
shutdown 双 CANCELLED,full-cancel coverage)在任务 1 门禁内随套件通过,
并单文件复跑 7/7 逐格确认(含格⑥ catch-per-run 失败隔离/serve 存活)。

## 3. 任务 2:聚合断言、409 正向与登记缺口逐项(commit b3ac603)

### 3.1 聚合断言三格(runs-multi-node.test.ts,7→10)

置于格⑥与格⑦之间(放置纪律:⑦ shutdown 格必须保持套件末位——其格内
`orchestrator.shutdown()` 关闭驱动,后置格无法驱动 run):

1. **聚合优先级格「WAITING_APPROVAL 压过 FAILED」**:boom(error-result)
   FAILED+brk(action-proposal)WAITING_APPROVAL 并存→run RUNNING+
   outcome=blocked(detail 与 /api/v1/runs 列表双面;settleRunStatus 分支
   序钉死,run-driver.ts:358-365);决策续行 attempt 2 再停审批后终态复
   断言 blocked;共享哨兵 A19 未写。红路径:分支序翻转/合并→blocked 断言
   全红;列表丢 outcome→红;再停审批后不再聚→终态 wait 红。
2. **「其余→null」直接断言**:HOLD/HOLD_B 两凭据组双兄弟在飞→run
   RUNNING+outcome=null。注释如实限定机制:outcome 仅 round-begin 写,
   pump join 使在飞窗保持新 run 初值 null——在飞 run 无伪造执行中呈现。
   红路径:在飞聚出非 null 伪造值→红。
3. **审批续行窗口现状锚(重要发现如实登记)**:登记预期「审批续行后
   blocked→null 过渡」在 v1 语义下**不可经 run outcome 观测**——naive
   null-wait 格实跑超时(39.7s)暴露真实语义:续行在 pump round-begin 内
   同步跑完(run-driver onRoundBegin await continueApprovedCheckpoints,
   approval-driver await 整个 launch),settleRunStatus 仅在其后运行。
   新增 PROPOSAL_SLOW profile(fake-cli `--delay-ms 2000`×3 stdout 帧
   ≈6s 拉宽在飞窗;自带哨兵不染④的 A19 哨兵;additive,无 profile 列表
   断言受影响)后改钉现状:决策→attempt 2 RUNNING 在飞(node 脱离
   WAITING_APPROVAL,60s 内实观测=非恒真)→outcome 保持 blocked(非 null
   非 failed)→再停审批 blocked。注释明示现状锚非期望规范;null
   fallthrough 的可观测面=新 run 初值(格 2)+完成态,如实入 §7。

### 3.2 409 七字段漂移门正向用例(runs-orchestration.test.ts 自含 restart 格)

实际触发面=**PUT /api/v1/projects/:id/role-bindings**(server.ts 拒绝序
#6→setProjectRoleBindings→ensureProfileRow 七字段 find,run-creation.ts:
424-441;ask 中「POST /api/v1/profiles」非实际面,按 ask 的「或实际触发
面」落点)。同 id 同 configDir 纪律下仅 timeoutSeconds 600→601 漂移:
restart 后 PUT 得 **HTTP 409**+body 含 PROFILE_DEFINITION_CONFLICT/
timeoutSeconds/601,且 profiles 表 stored 行仍 600(拒绝非 upsert)。
此前仅错误族映射(orchestration errors.test.ts:53)与否定断言
(M9-04 #62 model-only 两格 `not.toContain`),无正向。红路径(分臂如实,
第 5 轮拦截勘误,§8):门移除/收窄(静默 upsert)→PUT 200+行变 601
双红=本格真实红路径;**门过宽臂原声称失实**——原句「门过宽(连
model-only 也 409)→同套件 #62 负格红」经第 5 轮审查机械复核不成立:
#62 模型编辑后只达 POST /runs(不经 ensureProfileRow)与 PUT
/api/v1/profiles/full(仅原子写回源文件,不物化行),#62 唯一一次 PUT
bindings 在模型编辑**之前**且走 createProfile 分支(无门比对),故
过宽门下 #62 恒绿——该臂由返修新增的门范围锚格钉死(测试文件内
「drift-gate scope anchor」格,变异实证红/恢复绿,§8)。

### 3.3 M10-05 登记缺口五格(memory-injection.test.ts,15→20)

1. **context-refs 上限格**:7 bundle 播种(逐条递增时间戳——listContext
   Bundles ORDER BY created_at ASC、id 仅 tiebreak,首版同刻播种即红据此
   修正)→refs 恰为最近 5 条逆序(CONTEXT_REFS_MAX_ENTRIES=5)、最旧 2 条
   出清、prompt 只渲染存活引用。**现状如实双侧钉**:refs 侧无截断注记
   (预算截断注记仅记忆侧,execution-input.ts:170-206)——ask 原文
   「截断与注记」中注记半句与实现不符,按现状钉死并登记,不伪造注记。
   红路径:无帽/错窗/错序→ids 断言红;出清 bundle 泄回 prompt→红。
2. **context 侧 fail-open 复合格**:仅 DROP context_bundles(记忆侧健康
   且有 admissible 命中)→**整注入**降级 EMPTY_MEMORY_INJECTION(已收集
   记忆一并弃)+恰一条 stderr 注记;再 DROP memories 双侧坏仍每收集恰一条。
   红路径:context 故障外抛→红;记忆在复合故障中存活→EMPTY 断言红;
   每侧各报一条→长度断言红。
3. **未知项目降级格**:openMemoryAccess typed refusal(UnknownMemory
   ProjectError,access.ts:141-148 projects 表检查)→上游 catch→EMPTY+
   恰一条注记含 `project "proj-never-registered" does not exist`。红路径:
   外抛→红;静默无注记→红。
4. **预算 halt-on-first-overflow 钉死**:A 可容纳+B 首溢+C 更小本可容纳、
   budget=A+C 字节→entries 恰 [A] 且 truncated=2(break 非 continue;
   continue 版会答 [A,C]/1)。红路径:break 改 continue→双红。
5. **flatten 多行正例**:`\n` 与 `\r\n`(含 surrounding whitespace)折叠
   单空、孤立 `\r` 留存=**现状锚非期望规范**(flatten 模式要求 `\n`,
   MemoryInjectionEntry.content doc 在案);future flatten 变更须有意改写。
   红路径:停折 CRLF→逐字节相等断言红;改折孤立 \r→现状锚断言红。

### 3.4 desktop-shell README 三处将来时回指

`apps/desktop-shell/README.md` 三处改回指 reports/M10-06-BATCH.md §4.3
已执行证据链(演练 A 实测):头节「安装态复核**已随** M10-06 任务 3 的
0.3.0 安装包重打执行(卸旧-装新-开箱演练,§4.3);残余(真正干净
Windows 机器的端到端)仍归维护者清单」;条目 1「安装布局同证据链复核
**已随**演练 A 执行(六断言实测)」;条目 12「**已随**任务 3 重打…
卸旧 0.2.0(数据目录保留)→/S 装 0.3.0→开箱六断言→带凭据 API 200→
旧库幂等迁移,§4.3」。残余维护者项(双击式 GUI 向导/真窗交互/真正干净
机)逐字保留明确。grep 实证「随重打执行/重打后的安装布局/安装态复核随」
零残留;该文件不在 CHECKSUMS(grep 零命中),纯 LF 无 BOM。

## 4. 变更文件清单(本批累计,8 文件)

任务 1(fb69e5b):
| 文件 | 变更 |
|---|---|
| packages/orchestration/src/pump-primitives.ts | onDispatchFault 可选钩子+parallel join 逐派发记录(唯一生产改动) |
| packages/orchestration/src/run-driver.ts | onDispatchFault 接既有 LogSink+头注释 |
| packages/orchestration/src/node-driver.ts | shutdown straddle 窗口注释登记(零行为) |
| packages/orchestration/test/pump-primitives.test.ts | parallel+catch-per-run 专格 2 格(58→60) |

任务 2(b3ac603):
| 文件 | 变更 |
|---|---|
| packages/local-api/test/runs-multi-node.test.ts | 聚合三格+PROPOSAL_SLOW profile(7→10) |
| packages/local-api/test/runs-orchestration.test.ts | 409 漂移门正向自含格 |
| packages/orchestration/test/memory-injection.test.ts | 登记缺口五格(15→20) |
| apps/desktop-shell/README.md | 三处将来时回指 §4.3(零 CHECKSUMS 涉及) |

本任务(任务 4,交付物):reports/V031-01-BATCH.md(新)、PROPOSALS.md
(追加治理披露节)、docs/BACKLOG.md(V031-01 标完成态+交付摘要节)、
project/backlog.json(deliveryNotes.V031-01,先 dumps 后写 LF)、
CHECKSUMS.sha256(PROPOSALS/BACKLOG/backlog.json 三行重算)。

返修任务(第 5 轮拦截 B1,§8):packages/local-api/test/runs-orchestration.test.ts
(门范围锚格新格+409 格判别力注释勘误)、reports/V031-01-BATCH.md
(§3.2 红路径句分臂勘误+新增本节 §8+§4/§5 补返修行)、PROPOSALS.md
(V031-01 判别力表第 6 行勘误+锚格新行、M9-04 审查移交登记 (b) 补注)、
CHECKSUMS.sha256(PROPOSALS 行重算)。生产源码零改动:变异实证的临时
改动(§8)已 git restore,提交内 packages/*/src 与前驱提交零差异。

## 5. 测试及退出码(2026-10-06 本会话实跑)

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 任务 1 orchestration | pnpm --filter @role-orchestrator/orchestration run typecheck + run test | typecheck 0;60/60(58+2) | 0 |
| 变异实证(任务 1) | 临时回退 primitive bare join→run test→恢复复跑 | 两新格红/旧 58 绿;恢复后 60/60 | 1→0 |
| 任务 1 local-api | orchestration build(exit 0)后 pnpm --filter @role-orchestrator/local-api run test | 263/263(含格⑥⑦) | 0 |
| 任务 1 共享泵旁证 | pnpm --filter @role-orchestrator/e2e-baseline run test;browser-e2e 同 | 21/21;22/22 | 0 |
| 任务 2 memory-injection 单文件 | vitest run test/memory-injection.test.ts | 20/20(15+5) | 0 |
| 任务 2 409 格单测 | vitest run test/runs-orchestration.test.ts -t drift | 1 passed/9 skipped | 0 |
| 任务 2 runs-multi-node 单文件 | vitest run test/runs-multi-node.test.ts | 首轮 9/10(null-wait 超时=发现)→重设计后 10/10 | 0 |
| 批门禁 orchestration 全套 | run test + run build | 65/65;build exit 0 | 0 |
| 批门禁 local-api 全套 | 先 build 后 run test | 267/267(263+1+3) | 0 |
| 类型检查 | pnpm typecheck | 61/61 | 0 |

返修任务(第 5 轮拦截 B1)追加实跑:

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 锚格单跑(现状) | vitest run test/runs-orchestration.test.ts -t "scope anchor" | 1 passed/10 skipped | 0 |
| 变异实证(过宽臂,临时模拟 contemplated (b)) | 临时在 ensureProfileRow 增 model 比对(读 revision 层 durable model)→重建 orchestration→vitest run 同文件全量 | **锚格红**(`AssertionError: expected 409 to be 200`,rebind PUT)/#62 model-only 格**绿**/漂移 409 格**绿**/其余 8 格**绿**(11 中 1 failed) | 1 |
| 变异恢复 | git restore run-creation.ts→重建→vitest run 同文件全量 | 11/11 | 0 |
| 返修批门禁 orchestration | run typecheck + run test + run build | typecheck 0;65/65;build 0 | 0 |
| 返修批门禁 local-api | 先 build 后 run test | 268/268(263+1+3+1 锚格) | 0 |
| 返修类型检查 | pnpm typecheck | 61/61 | 0 |

## 6. 与三轮审查移交清单的逐项闭合对照

| 移交源 | 条目 | 处置 |
|---|---|---|
| M10-04 审查 R4(经 BACKLOG V031-01 范围①) | 同轮并发第二故障被 Promise.all 静默吞没→per-dispatch 隔离日志 | **闭合**(fb69e5b,§2.1) |
| M10-04 §8 未验证项 5 | worktree 并发创建并发锁冲突专格;配额拒绝-重试循环无新格 | **开放**——不在本批四项工作面;原文自注「格⑦通过为间接覆盖」「既有 scheduler 格覆盖」;照旧移交 |
| M10-04 §8 未验证项 3 | 真实 CLI 并行冒烟(A33 凭据/会话争用等) | **开放,升主线**——即 v0.3.1 维护者真实使用主线(§7) |
| PROPOSALS 测试缺口提案登记(1)/M10-05 缺口登记同项 | parallel dispatchJoin+catch-per-run 失败隔离专格与 per-dispatch 日志 | **闭合**(fb69e5b §2.2 格 1) |
| PROPOSALS 登记项 (2) | context-refs 上限(top-N)专格 | **闭合**(§3.3-1) |
| PROPOSALS 登记项 (3) | context 侧 fail-open 复合格 | **闭合**(§3.3-2) |
| PROPOSALS 登记项 (4) | 未知项目(openMemoryAccess typed refusal)降级格 | **闭合**(§3.3-3) |
| PROPOSALS 登记项 (5) | WAITING_APPROVAL 优先于 FAILED 的聚合格 | **闭合**(§3.1-1) |
| PROPOSALS 登记项 (6) | 预算 halt-on-first-overflow 语义钉死格 | **闭合**(§3.3-4) |
| PROPOSALS 登记项 (7) | flatten 多行内容折叠正例格 | **闭合**(§3.3-5) |
| M10-06 §9 审查 minorsCarried | 409 正向无专测(触发点 run-creation.ts:424-441) | **闭合**(§3.2) |
| M10-06 §9+维护者动作⑤ | 88 项 M10-06 文档 minor 按族随批消化(P2) | **部分随批**:desktop-shell README 三处将来时=本批消化(§3.4);其余仍归维护者 P2 清单,不升主线 |
| BACKLOG V031-01 范围②「blocked→null 复位直接断言」 | 审批续行后 blocked→null 过渡 | **以现状锚闭合**(§3.1-3):mid-flight null 在 v1 语义不可观测,如实改钉现状+登记;完成态复位路径在现 fake-cli 场景集不可达(§7) |

## 7. 未验证项

1. **真实 CLI(claude/codex)下的并行故障端到端**——本批全部专格运行于
   fake-cli/单元注入面;真实 CLI 在 30–90 分钟真实任务中同轮并发故障的
   实况(per-dispatch 日志行在真实 serve stdout 的落地、真实超时/取消
   传播)未验证,**即 v0.3.1 维护者真实使用主线**(BACKLOG「维护者环境
   动作①」,5 类任务留档),非仓库批可闭合面。
2. 「审批续行成功→blocked→null→READY_FOR_DELIVERY」完成态复位路径在现
   fake-cli 场景集不可达(action-proposal 每次续行再提案,④格钉死的
   shipped 语义);触达需扩 fake-cli 场景或改生产,均超本批「零行为变更」
   红线。null fallthrough 实测可观测面=新 run 初值(§3.1-2)+完成态。
3. PROPOSAL_SLOW 在飞窗(≈6s vs 250ms 轮询)在本验收机绿;未在更慢机器
   验证余量(慢机风险=轮询错过窗口→格超时红,非静默假绿)。
4. M10-04 §8 未验证项 5(worktree 并发锁专格)照旧移交(§6)。
5. 「10 轮审查」属批次后续流程,未在本交付内完成(历批同口径)。
6. 全量 `pnpm test`(turbo 72 任务)未在本批重跑;门禁按 ask 点名面
   (orchestration+local-api)执行,另加跑 typecheck/build/共享泵旁证。
7. M10-04 §8 其余未验证项(1/2/4/6/7/8)与 M10-05 §8 各项照旧移交,
   本批未触碰。

## 8. 第 5 轮拦截记录(B1「判别力声称失实」,2026-10-06)

**拦截原文要点**:第 5 轮审查以「判别力声称失实」拦截本批 409 漂移门
正向用例(b3ac603)——该格判别力注释与 §3.2、PROPOSALS V031-01 判别力
表第 6 行均声称「门过宽(连 model-only 也 409)→同套件 #62 负格红」,
审查判定该臂不成立,判别力声称与实现事实不符。

**机械复核证据链(审查者给出,本返修逐项独立复核一致,行号为本会话
实读)**:PROFILE_DEFINITION_CONFLICT 唯一产生点=run-creation.ts:435-441
(ensureProfileRow,七字段比对 :423-433);唯一调用点=同文件 :323
(setProjectRoleBindings 物化循环);唯一生产调用点=server.ts:1555
(PUT /api/v1/projects/:id/role-bindings→orchestrator 适配 run-driver
:184-188→run-creation)。M9-04 #62 格内唯一一次 PUT bindings 在模型
编辑**之前**(新 id→createProfile 分支,不经过门比对);模型编辑后
#62 只达 PUT /api/v1/profiles/full(profiles-config.ts:25-29:仅原子
写回源文件,不热重载不物化)与 POST /api/v1/runs(创建链不调
ensureProfileRow)。profiles 表无 model 列(runtime-profile
entities/profiles.ts:17-31,model 在 revision 层)。结论:过宽变异
(model 纳入门比对)下 #62 恒绿——原声称掩盖的真实覆盖洞=「409 门的
比对字段范围(七字段恰闭)无任何格钉死」。

**返修处置**(commit b3ac603 消息不可改,沿 M10-06 §9/M10-02 §5.1
拦截入档惯例,以本节+三处勘误更正):

| 项 | 处置 |
|---|---|
| 判别力注释勘误(测试文件 409 格) | 过宽臂改如实:明示不可经 #62 判别、原声称失实(注明第 5 轮拦截 B1),由下方锚格钉死 |
| 新格:门范围锚格(runs-orchestration.test.ts「drift-gate scope anchor」) | 同 id 物化(V1)→PUT profiles/full 仅改 model(盘上前提断言)→restart(V2 在载定义)→再 PUT bindings:断言 200 非 409、rebind view 四角色钉 revision 1、profiles 行逐字节不变、revision 恒恰 [1,V1]、role_bindings 除 updated_at(重 PUT 设计使然,setRoleBinding UPDATE 无条件)外逐字节不变;非恒真三红路径见格注 |
| 锚格变异实证 | 临时模拟 contemplated (b)(ensureProfileRow 读 revision 层 durable model 入比对)→重建→同文件全量:**锚格红**(`AssertionError: expected 409 to be 200`)/#62 **绿**/漂移格**绿**/其余格**绿**(11 中恰 1 failed)——过宽臂与 #62 的正交性获直接实证;git restore→重建→11/11 绿 |
| §3.2 红路径句 | 分臂勘误(收窄/移除臂=真实红路径;过宽臂=失实声称,锚格补齐) |
| PROPOSALS V031-01 判别力表第 6 行 | 红路径格分臂勘误;表增锚格行(11→12 新格),披露节补返修句 |
| PROPOSALS M9-04 审查移交登记 (b) | 补注:该现状已由门范围锚格钉死,落地须同时显式改写锚格 |

**边界如实**:变异实证的临时生产改动未入库(git restore 恢复,提交内
packages/*/src 与前驱零差异)。锚格对 (b) 的判别力前提=「落地形态真实
读取 durable model 与载入定义比对」——若读 revision 层(本次变异所
模拟,现存储唯一 durable model 所在)或读未来新增的 model 列,红路径
同样成立(均见 V1≠V2);若实现为「新增永不触发的比对」,则不构成
「将 model 纳入比对字段」,不在 (b) 语义内,锚格对其无判别力亦无需有。
