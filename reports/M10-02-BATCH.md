# M10-02 交付批报告 —— 统一 RunDriver:正式执行真相(2026-10-05)

> 性质:M10「编排产品化」主体批(对应 BACKLOG 第 57 项 M10-02)。
> 设计输入:`.zcode/m10-02-design-input.md`(并行勘察产出)+ 维护者提供外部评估
> 分步策略。本报告覆盖任务 1(主体 A:生产平价抽取)、任务 2(主体 B:三副本
> 收敛)、任务 3(收口:可选阶段骨架+dogfood 组合根化)与任务 5(治理披露)。
> 本文件不入 CHECKSUMS.sha256 冻结面清单(历批同口径)。

## 1. Summary

新建 `packages/orchestration`(`@role-orchestrator/orchestration`,workspace 包,
**零外部 npm 依赖**——dependencies 全为 `workspace:*`),把原先三处各自为政的
泵/驱动与生产泵统一为**一套正式执行真相**:

- **生产面**:local-api `orchestrator.ts` 从 1054 行完整链路实现降薄为约 180 行
  组合根(仅保留 HTTP 面:zod body schema、启动选项校验、parseProfilesFile),
  执行全部委托 `createRunDriver`;server.ts 增 `mapOrchestrationRejection` 错误
  映射层(错误载体倒置)。
- **共享原语**(任务 2):结算四件套三粒度(settleClaimedNode /
  settleClaimBookkeeping / transitionNodeTerminal)、轮循环原语
  `runPumpRounds`(dispatchJoin serial|parallel + errorIsolation
  throw-up|catch-per-run + convergence all-succeeded|all-terminal 参数化)、
  `baselineFor`、`buildParents`、`storedEventViews`——e2e-baseline /
  browser-e2e / dogfood 三副本全部改为消费 orchestration 导出。
- **可选阶段骨架**(任务 3):M7 integration-driver、M8 review-driver、
  M10 rework-driver、M11 recovery-driver(显式独立入口)入包;dogfood 驱动
  降薄为「测试组合根+断言」,经 orchestration 跑通全链。

六个功能提交(外加本治理提交):

| 提交 | 内容 | 文件 |
|---|---|---|
| `b0ca7c1` | 任务 1a:新建 orchestration 包(M1-M6/M9/M12 模块+单测) | 20 |
| `d80cd42` | 任务 1b:local-api 组合根化+server.ts 映射层+依赖接线 | 4 |
| `fcac20a` | 任务 2a:pump-primitives(四件套+轮循环)+生产 driveRun 消费 | 6 |
| `f323a25` | 任务 2b:三方消费改造(三副本收敛) | 7 |
| `3ce4e60` | 任务 3a:M7/M8/M10/M11 骨架+生产暴露面守卫 | 7 |
| `21e33c1` | 任务 3b:dogfood 降薄为组合根+断言 | 3 |
| (本提交) | 任务 5:报告+披露+boundary-audit manifest 扩员 | 见 §3 |

## 2. 设计要点(模块 M1-M13 落地对照)

| 模块 | 状态 | 落点 |
|---|---|---|
| M1 driver-contract | ✅ 任务 1 | `src/driver-contract.ts`(RunDriver 接口+视图类型+ProfileDefinition)、`src/errors.ts`(自有错误家族 OrchestrationRejectionError)、`src/constants.ts`(冻结常量组) |
| M2 run-creation | ✅ 任务 1 | `src/run-creation.ts`(createRunChecked/ensureProject/ensureProfileRow 七字段漂移门/ensureProfileRevision/requireCompleteRoleBindings 纯读/setProjectRoleBindings 唯一绑定写面) |
| M3 run-driver | ✅ 任务 1+2 | `src/run-driver.ts`(createRunDriver:串行链+creation 链+activeCancels+shutdown;driveRun 自任务 2 起消费 runPumpRounds) |
| M4 node-driver | ✅ 任务 1+2 | `src/node-driver.ts`(runClaimedDispatch/launchExecution/settleNodeTerminal;结算改消费四件套原语) |
| M5 dependency-resolver | ✅ 任务 1+2 | `src/dependency-resolver.ts`(baselineFor 自 e2e-baseline driver.ts:305 泛化搬入;buildParents;三方消费) |
| M6 execution-input | ✅ 任务 1 | `src/execution-input.ts`(ExecutionLaunchInput/resolveExecutionSettings/executionPrompt/objectiveOfRun/repoRootOf/storedEventViews;M10-03 角色上下文注入接缝留此未实现) |
| M7 integration-driver | ✅ 任务 3 | `src/integration-driver.ts`(settleIntegrationClaim:可选阶段,生产单节点图休眠) |
| M8 review-driver | ✅ 任务 3 | `src/review-driver.ts`(settleReviewClaim:validationScript 仅测试组合根可注入——RunDriver 面零此字段) |
| M9 approval-driver | ✅ 任务 1 | `src/approval-driver.ts`(openCheckpointsForProposals/continueApprovedCheckpoints;**永不批准**红线不变) |
| M10 rework-driver | ✅ 任务 3 | `src/rework-driver.ts`(requestReworkExpansion:A38 锁由驱动调用瞬间读取,组合根无 revision 入参) |
| M11 recovery-driver | ✅ 任务 3 | `src/recovery-driver.ts`(scanStartupRecovery/landRecoveryOutcome/listRecoveryItems/resolveRecoveryItem;显式独立入口,泵循环零引用) |
| M12 ports | ✅ 任务 1 | `src/ports.ts`(Clock/LogSink;缺省行为逐字=原 nowIso/logPumpNote,stdout 形态未动——策略⑧壳侧排水耦合) |
| M13 observability | ⏸ 未实现 | 设计输入标注可选、随泵骨架顺带;v1 未落,onRoundStarted 窗口已由 runPumpRounds deps 预留(基准泵消费中),timeline/trace 观测窗留 M10-03/04 |

统一策略 11 项落地:①dispatchJoin 参数化生产 serial✅ ②catch-per-run(run 边界
隔离)+all-terminal 生产✅ ③dependency-resolver 统一✅ ④集成/审查/扩图/恢复=
可选阶段,生产休眠;recovery 显式入口✅ ⑤OutputCommitter 生产缺省无(未引入,
接口未预留——接缝留 M10-04 Memory 批)⑥审批红线✅ ⑦错误载体倒置✅
⑧Clock/LogSink 注入且 stdout 形态逐字✅ ⑨local-api 保留面/orchestration 暴露面
按设计✅(driver-surface 单测钉死六操作)⑩storedEventViews 副本即抽即消✅
⑪202 vs 进程内由组合根承载✅。

## 3. 变更文件

任务 1(20+4):packages/orchestration/** 全新 20 文件(package.json、tsconfig×2、
vitest.config、src 12、test 4);local-api:package.json(+orchestration 依赖)、
src/orchestrator.ts(重写为组合根)、src/server.ts(映射层)。

任务 2(6+7):orchestration:src/pump-primitives.ts(新)、test/pump-primitives.test.ts(新)、
index.ts、dependency-resolver.ts(buildParents 返回可变数组)、node-driver.ts、
run-driver.ts;三方:packages/e2e-baseline/{package.json,src/driver.ts}、
packages/browser-e2e/{package.json,src/pump.ts}、packages/dogfood/{package.json,src/driver.ts}。

任务 3(7+3):orchestration:package.json(+expand/integration/reconcile/review 边)、
src/{integration-driver,review-driver,rework-driver,recovery-driver,index}.ts、
test/driver-surface.test.ts;dogfood:{package.json,src/driver.ts}。

本治理提交(任务 5):`reports/M10-02-BATCH.md`(新)、`PROPOSALS.md`(追加披露
节)、`CHECKSUMS.sha256`(PROPOSALS 行 LF 重算)、
`packages/boundary-audit/src/core-manifest.ts`(OPEN_CORE_PACKAGE_MANIFEST
35→36 名)。

依赖图变化:orchestration → {approval, checkpoint, cli-events, contracts, dag,
engine, expand, integration, reconcile, review, runtime-profile, scheduler,
store, worktree}(全 workspace:*);local-api/dogfood/browser-e2e/e2e-baseline
→ orchestration。dogfood 移除 {integration, reconcile} 直接边(经 orchestration
M7/M11)。pnpm-lock.yaml 仅 workspace 链接变化,零新增外部依赖。

## 4. 三方 composition root 统一验收实录(验收实锤)

**dogfood 全链经 orchestration**(任务 3,2026-10-05 实跑两遍 16:19/16:21):
`pnpm --filter @role-orchestrator/dogfood run test` → 13/13。链路逐段:
plan→frontend‖backend(多节点,依赖基线经 M5 baselineFor:后继节点 worktree
基于前序 accepted headSha,非 run.baseSha——多节点依赖基线正确的机制载体)
→integrate(M7)→review FAIL(内容接地注入,M8)→M10 受控扩图(A04/A38/A20
守卫活体:coordinator requester、minted integrate-fix-2/integrate-review-2、
graphRevision 递增)→修复执行真提案未授权写(A19:未批副作用不发生)→
A17 digest 拒改活体(tampered 路径被 ApprovalDigestMismatchError 拒、approval
保持 APPROVED、checkpoint 保持 WAITING、零 attempt 行)→人工批准→唯一
digest 绑定续行执行写入并 CONSUMED→注入启动窗中断(真 claim 无 launcher,
A24 窗:attempt STARTING/outbox/grants)→M11 scanStartupRecovery 真扫
(decision=recovery-required/reason=launch-window-undetermined/probe 零调用)
→RECOVERY_REQUIRED(A22:第二 attempt 被 ActiveAttemptConflictError 拒、
rescan 幂等、queue entry 保持 DISPATCHED、grants 保持持有)→人工
resolveRecoveryItem→INTERRUPTED→显式 retry→M8 re-review PASS 绑定新
candidate→全节点 SUCCEEDED+A11 用户仓三重不变式。事件校验和零 mismatch。

**生产组合根**(local-api,单 execute 节点图):`pnpm --filter
@role-orchestrator/local-api run test` → 247/247(23 文件,测试文件自 M10-01
后**零改动**——git diff 实证)。格①即生产冒烟:POST /api/v1/runs → 202
{status:"queued"} → 泵 PLANNED→RUNNING→READY_FOR_DELIVERY,execution
SUCCEEDED,事件可查;M10-01 语义格(差异化绑定→建任务→role_bindings 全列
含 updated_at 字节不变→run 冻结项目 developer profile)前后双跑通过。

**双收敛策略**:all-terminal(生产)——local-api 套件+orchestration
driver-surface 谓词格(空集不收敛);all-succeeded(测试)——browser-e2e
21/21 + e2e-baseline 21/21(空集即收敛,原语义逐字)。

**边界审计活体**(任务 5):boundary-audit 对真实树在 manifest 扩员**前**
verdict=fail、恰好一条 `core-manifest-drift` 指名
@role-orchestrator/orchestration("the boundary cannot change silently" 机制
活体);按 M8-02 先例扩员后(35→36 名)verdict=pass。**两个计数器口径如实
澄清(第 2 轮审查 B2 勘误——首版此处把正确的预估当错值驳回)**:本句
workspacePackageCount=36 是 boundary-audit 的 OPEN_CORE_PACKAGE_MANIFEST
**名单计数**(36 个包名,无根条目);而编排脚本预估文案「36→37」指向
release-audit 依赖审计的 `workspacePackageCount`(pnpm-lock importers:
根 `.` + 全部 workspace 包)——**该预估是正确的**,M10-02 加包后 importers
36→37,首版漏做 release-audit 侧登记(repo-audit.test.ts 钉死 toBe(36)
在候选树实跑 exit 1),B1 修正:断言改 toBe(37)。两计数器恒差一根条目,
不得互相驳回。

## 5. 测试及退出码(口径标注见行内与 §5.1)

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run`(orchestration) | 30/30(6 文件;含冻结常量/错误家族/端口/轮循环原语 10 格/暴露面守卫 4 格)exit 0 |
| `pnpm exec tsc -p tsconfig.json` / `pnpm run build`(orchestration) | exit 0 / exit 0 |
| `pnpm --filter @role-orchestrator/dogfood run test` | 13/13 exit 0(改造前后双跑:15:37→16:21) |
| `pnpm --filter @role-orchestrator/browser-e2e run test` | 21/21 exit 0(15:37→16:22 双跑) |
| `pnpm --filter @role-orchestrator/e2e-baseline run test` | 21/21 exit 0(15:36→15:57 双跑) |
| `pnpm --filter @role-orchestrator/local-api run test` | 247/247(23 文件)exit 0(迁移前后双跑 9/9 核心格+全量多次) |
| `pnpm exec tsc -p tsconfig.json`(local-api/dogfood/browser-e2e/e2e-baseline) | 各 exit 0 |
| 根 `pnpm typecheck` / `pnpm test` / `pnpm build` | 61/61、72/72、36/36 全 exit 0。**口径勘误(第 2 轮审查 B2)**:首版 72/72 系 turbo 缓存重放(pnpm-lock.yaml 不在 test 任务 hash 输入,加包后重放旧绿日志,冷缓存必红)——本行缓存口径数字仅证门禁命令形态,真相以 B1 修正后 `turbo run test --force --continue=dependencies-successful` 冷重算实跑为准,实测记录见 §5.1 审查拦截记录 |
| `pnpm --filter @role-orchestrator/boundary-audit run test` | 34/34 exit 0 |
| `node packages/boundary-audit/dist/cli.js <repoRoot>` | 扩员前 fail(恰 1 条 core-manifest-drift)→扩员后 pass |
| `node planning-check.mjs` | exit 0((a) 79/79 冻结面校验+(b) 干净副本 self-test exit 0),每任务批后复跑 |

行为零漂移锚:runs-orchestration.test.ts 与三方套件测试文件**零改动**通过
(git diff 实证);55 项承重文案/常量片段旧新对照脚本实扫 zero missing
(任务 1,临时脚本已删);dag states.ts computeReadinessTransitions 源码实证
propagate 从不产生 SUCCEEDED/FAILED(轮循环原语收敛检查位置无生产漂移)。

### 5.1 审查拦截记录(第 2 轮返修,2026-10-05,如实入档)

**拦截事实**:第 2 轮审查实跑实证首版登记不完整+数字失实——B1:
`packages/release-audit/test/repo-audit.test.ts:66` 的 workspacePackageCount
钉死断言仍 toBe(36),在候选树(a5f2b1a)实跑 exit 1『expected 37 to be
36』。M8-02 先例确立加包**双登记**义务:boundary-audit manifest 名单侧已
登记(36 名含 orchestration),release-audit 依赖审计侧(importers 计数)
漏做。B2:本报告首版 §4 把正确的『36→37』预估当错值驳回(所询『实盘』
是 boundary-audit 名单计数,与 release-audit importers 是两个口径,恒差
一根条目),且 §5 门禁表『全命令实跑 72/72』系 turbo **缓存重放假象**
(test 任务 hash 不含 pnpm-lock.yaml,加包后重放旧绿日志,冷缓存必红)。
PROPOSALS.md 治理披露同文失实,两处均已修正。

**修正后冷重算实测(2026-10-05 本机实跑,替代缓存口径)**:

| 命令 | 结果 |
|---|---|
| `pnpm exec turbo run test --force --continue=dependencies-successful`(默认并发) | exit 1,**71/72**:唯一失败=local-api `test/diff-view.test.ts` beforeAll 钩子触发 vitest 默认 10s hookTimeout(72 任务全并行满载;该文件与 vitest.config.ts 自 79238fd 零改动,非本批引入;套件内 239 passed+8 skipped/247 **零断言失败**;同命令两跑 2/2 复现同点)。release-audit 43/43(含 toBe(37) 修复断言)在该跑中即全绿 |
| `pnpm --filter @role-orchestrator/local-api run test` | 247/247(23 文件)exit 0(单独实跑,证满载超时非断言问题) |
| `pnpm exec turbo run test --force --continue=dependencies-successful --concurrency=4` | **exit 0,72/72 任务,0 cached**,5m38.79s;36 个 vitest 包 **1710 测试全绿**(release-audit 43/43、local-api 247/247、dogfood 13/13、browser-e2e 21/21、e2e-baseline 21/21、orchestration 30/30、boundary-audit 34/34、fault-matrix 17/17 等) |
| `pnpm exec turbo run typecheck --force` | 61/61 exit 0(0 cached,58.5s) |
| `pnpm exec turbo run build --force` | 36/36 exit 0(0 cached,43.9s) |
| `pnpm typecheck` / `pnpm test` / `pnpm build`(缓存口径复跑) | 61/61(60 cached)、72/72(70 cached;release-audit 因断言修改真实重跑并绿)、36/36(36 cached) |

**登记不掩盖**:diff-view.test.ts beforeAll 依赖默认 10s hookTimeout,在
全并行冷重算满载下必超时——属**既有测试基建脆弱性**(v0.1.0-rc 起如此,
历批从未全仓 --force 冷跑故从未暴露)。本轮红线只动断言/文档/披露,
不改 vitest 配置,如实留后续批次处置(候选方向:hookTimeout 显式化或
冷跑并发预算)。本轮真值口径:冷重算以 --concurrency=4 实跑为准,
不再以缓存口径数字充当『全命令实跑』。

## 6. 未验证项(如实移交)

1. 非 Windows 平台:编排格 skipIf(!win32),本机仅 windows 实跑。
2. 全仓 `pnpm build` 为 turbo 缓存口径(36/36 cached),触及包 --force
   (29/29、22/22)已真实执行补证;未做全仓 36 任务 --force。
   【第 2 轮返修补验 2026-10-05】全仓 build --force 36/36、typecheck
   --force 61/61 已真实执行(0 cached,exit 0,见 §5.1);test --force
   默认并发 exit 1(既有满载 hook 超时,见 §5.1 登记)、--concurrency=4
   冷重算 72/72 exit 0。本项首句对首版仍成立,补验后『未做全仓 --force』
   不再成立。
3. dogfood 恢复/续行路径的单件 releaseExecutionQuotaGrants 保留内联(非四件套),
   未单独抽原语;行为由 dogfood 13/13 承载。
4. M8 的消费方当前仅 dogfood;e2e-baseline/browser-e2e review 段仍各自手写
   (findings 文案与期望机制各异,本批门禁未要求;两包对 M7/M8 开放,收敛留
   后续批次)。
5. M13 observability(timeline/trace 观测窗)未实现;onRoundStarted 窗口已由
   runPumpRounds 预留并被 browser-e2e 消费。
6. OutputCommitter 端口未引入(生产缺省无,产品决策待确认项 (a) 留 M10-04)。
7. 真壳/NSIS/托盘链未重建(不在本批范围);CHANGELOG 未动(条目随下一版本节
   由维护者收录)。
8. 双收敛验证中 dogfood 自身不消费轮循环原语(逐节点严格单派发断言式,任务 2
   已登记);其 all-succeeded 语义由内部 allNodesSucceeded 断言与两个基准泵
   套件承载。

## 7. M10-03 交接

- **多节点入口**:RunCreateBody→单 execute 节点图的构造在 orchestration
  run-creation.ts(workflow 字面);M10-03 多节点/角色上下文注入的接缝已在
  execution-input.ts(注释标位)与 run-driver.onRoundBegin 之外自然空位。
- **角色上下文注入**:M6 execution-input.ts 预留;v1 无实现。
- **并发开放(M10-04)**:runPumpRounds 的 dispatchJoin=serial→parallel 仅需
  组合根换参数+errorIsolation 语义复核(catch-per-run 已是 run 边界);quota
  机器(globalMax/projectMax/unverifiedCredentialGroupMax)原样在 PUMP_CONCURRENCY。
- **FAILED/outcome(M10-04)**:convergence=all-terminal 已接受 FAILED 终态,
  run 级 RUNNING 留存语义未动;outcome 字段留 M10-04。
- **绑定 UI**:评估第十节已采纳并入 M10-03(配置页四角色绑定表);后端
  PUT /api/v1/projects/:id/role-bindings 与 by-projectDir 读面已就绪(M10-01)。
- **接缝勿动清单**:RunDriver 六操作暴露面(driver-surface 钉死)、审批红线
  (永不批准)、A38 驱动内读锁、ValidationCommand 不进生产面。

—— 报告完(候选 SHA 以 git log 为准,沿 #60 教训不在文内写死)。
