# M8-04 开发批次报告:模型统计收尾——BudgetRefinement 只读阈值建议 + engine usage tee

日期:2026-09-30 · 执行角色:Developer · 基线:main fbae3f5(M8-04 立项治理批)·
候选提交:b7aecb9(任务 1)→ 4fd2fa0(任务 2)→ 本提交(任务 4,治理)。

覆盖范围(本 Developer 会话接收并交付的任务 1、2、4;任务 3 未在本会话
接收,如另有交付以其自己的报告为准):

- **任务 1(BudgetRefinement 从 stub 填充为只读阈值建议)**:
  `packages/model-stats/src/budget.ts` 状态机由恒 `"stub"` 改为
  `"ready" | "insufficient-data"` 二态。ready 时按 per-model 观测分布产出
  建议(单回合输出 token 上限 = 每回合 outputTokens 的 nearest-rank P95
  向上取整到 1000 档;输入预算参考 = 每回合 inputTokens——fresh input、
  不含 cache 读/写——的 nearest-rank P50,不取档);每个建议值附推导口径
  字段(method 名 + 样本量 n)。样本阈值 `MIN_SAMPLES_PER_MODEL = 5`
  (依据见推导索引 §6);不足时逐 model 输出四类缺口
  (no-per-event-samples / insufficient-samples / sample-count-mismatch /
  events-without-summary);ready 另要求样本数 == summary.eventCount
  (拒绝在声明聚合的子集上给建议)。接口向后兼容:输入保留
  `{ summaries }` 形状、新增可选 `events`(逐回合样本);stub 时代调用
  仍合法、得显式缺口而非异常。两态在 schema 合法输入下绝不抛错、零
  副作用(输入不 mutate、输出 deep-freeze、同输入同输出)。detail 双态
  均写明:**建议非策略;采纳需维护者批准,另批处理**。输出经新增 4 个
  zod strict schema 可校验并同步导出;建议值全部为 token 整数计数,
  无任何费用数字;`costUsd` `z.literal("unknown")` 契约未动。
- **任务 2(engine 持久化路径 tee usage 事件)**:勘察确定 usage 以
  `usage_reported` 事件 payload `{ usage: <原文对象> }` 落盘、raw type 恒
  保留于 sourceType 且不携带原始行文本,故 tee 语义 = 把**刚落盘的脱敏
  载荷**按保留的 sourceType 重序列化为提取器可消费的合成行
  `{ type: <sourceType>, usage: <脱敏后 usage> }`,现有 claude/codex
  提取器零修改复用。`persistDrainedEvents` 增第 5 可选参数
  `options.usageSink`,默认不传时行为与现在逐字节一致(引擎既有
  persistence/lifecycle 测试零改动全绿回归证明)。fail-open 边界在
  engine:事务提交后调用 sink,整段 try/catch,任何异常只出一行拍平的
  stderr 诊断(`[model-stats usage tee] fail-open: …`),persist 语义、
  返回值、行内容零改动。tee 只收本批 stored 事件(重放重复不重复计数);
  tee 输入经同一 `redactEventPayload` 幂等重导出,与 events 表存储字节
  一致——**A36 边界不移动:engine 落盘什么就 tee 什么**。
  `packages/model-stats/src/tee.ts` 新增 `createUsageSink(store, options)`
  适配器:store 实例与文件路径由调用方显式创建传入(engine 不知道路径、
  不建目录、不落盘,flushToFile 仍归调用方);落盘 usage 载荷不含 model,
  归属由调用方显式给出(`claudeModelId`/`codexModelId`),缺失落显式
  哨兵 `"unknown"`、绝不猜;适配器诚实可抛错,fail-open 是 engine 侧
  保证(注释言明分工)。engine 仅 devDependencies 增
  `@role-orchestrator/model-stats workspace:*`(test-only;lockfile +3 行
  workspace link,**外部依赖恰 84 不变**,`pnpm install` resolved 84 实录)。
- **任务 4(治理)**:本报告 + PROPOSALS 治理披露节 + CHECKSUMS 同步。

## 实际变更文件(基线 fbae3f5 → 4fd2fa0,git diff --stat 实证 13 文件 +1319/-65;治理提交另加本报告/PROPOSALS/CHECKSUMS)

`packages/model-stats/`:src/budget.ts(重写)、src/tee.ts(新增)、
src/index.ts、test/budget.test.ts(重写 14 例)、test/fixtures-real.test.ts
(全链路 +4 例)、test/tee.test.ts(新增 5 例)、test/helpers.ts(补窗口
fixture 读取)、README.md、package.json(仅 description 行)。
`packages/engine/`:src/persistence.ts、test/usage-tee.test.ts(新增 4 例)、
package.json(devDependencies 一行)。根:pnpm-lock.yaml(+3 行)。

未触碰(实证):`@role-orchestrator/budget`、scheduler、
`packages/engine/src/lifecycle.ts`、`packages/cli-events`、
`packages/model-stats/src/schema.ts` 的 `costUsd z.literal("unknown")`
契约、全部既有调用方的默认行为(dogfood 直调
`persistDrainedEvents` 四参不传 sink,5/5 回归绿)。

## 实际执行的测试及退出码

| 命令 | 退出码 | 说明 |
|---|---|---|
| `pnpm --filter @role-orchestrator/model-stats run typecheck` | 0 | 任务 1、2 后各跑一次 |
| `pnpm --filter @role-orchestrator/model-stats run test` | 0 | 任务 1:6 文件 59/59;任务 2 后:7 文件 64/64(新增 tee.test 5 例)。首跑曾有 3 失败:测试断言 `errors` 全空过严,与 s2-codex-tool.jsonl 第 8 行真实坏行(提取器按设计记录 `unparseable-json` 不吞掉)相抵,按实况修正断言后全绿——修正的是测试预期,非产品代码 |
| `pnpm --filter @role-orchestrator/model-stats run build` | 0 | 任务 1 收尾与任务 2(tee 导出进 dist)共两次 |
| `pnpm --filter @role-orchestrator/engine run typecheck` | 0 | strict 全开(含 noUncheckedIndexedAccess/exactOptionalPropertyTypes) |
| `pnpm --filter @role-orchestrator/engine run test` | 0 | 5 文件 30/30:既有 persistence.test.ts 3/3、lifecycle.test.ts 8/8(**执行语义零改动回归**)、invocation 10、claimed-attempt 5、新增 usage-tee.test.ts 4 |
| `pnpm --filter @role-orchestrator/local-api exec vitest run test/server-dogfood.test.ts` | 0 | 加跑:persistDrainedEvents 既有直接调用方 5/5(不传 sink 零变化跨包成立;非任务点名的门禁,extra) |
| `pnpm install --no-frozen-lockfile` | 0 | engine devDep workspace link;`resolved 84`(外部依赖数不变) |
| `node planning-check.mjs` | 0 | 治理披露同步后实跑:CHECKSUMS 79/79 逐文件 + 干净副本自检 exit 0 |

## 未验证项

1. **真实 CLI 生产数据的 tee 全链路**——hermetic 测试覆盖(fixtures-real
   七个补窗口 jsonl 的真实 usage 载荷经 engine 级与适配器级全链路),
   生产观测属运行期;`startExecution→drainAndPersist` 的 sink 生产接线
   未做(StartExecutionInput 为 strict zod 数据契约,函数回调入参属行为
   变更,装配属调用方组装决策——tee 已在持久化入口就绪,接线需维护者
   另批决定)。
2. **MIN_SAMPLES_PER_MODEL=5 的统计合理性**——仅有注释依据(n=5 起
   nearest-rank P95 与 P50 才指向不同观测)与真实小样本(n=5 恰为边界)
   佐证,未做大样本统计验证;建议值本质是小窗口描述统计。
3. **建议的采纳效果**——无验证对象:建议非策略、未接入任何执行面,
   采纳与否属维护者策略决定(另批),不存在可观测的调度行为可测。
4. s2-codex-tool.jsonl 第 8 行坏行成因(捕获/脱敏过程产物)未溯源——
   仅按提取器既有「记录不吞掉」设计钉死其被记录的事实。
5. stderr 诊断行内容未脱敏(错误消息可能含环境细节;不落盘、不进事件
   表,多行已拍平为单行)。
6. 多 execution 共享同一 PerformanceStore 的真实并发聚合未验证
   (store 为单进程内存 + 追加文件语义,并发共享属调用方组装责任)。

## 风险

- **建议基于极小样本窗口(claude n=5,codex n=2)**:ready 桶的建议值
  (1000/1000 档)对样本量敏感;若未来批准采纳,应先扩充观测窗口再
  重新推导(推导口径可复算,见 §6)。insufficient-data 缺口机制使小样本
  桶无法产出建议,该风险被结构性限缩但未消除。
- **tee 生产接线缺位**:统计旁路当前在持久化入口就绪但无生产调用方传入
  sink,即统计侧实际不活跃——不存在「悄悄生效」路径,但也意味着
  M8-04 的统计价值需后续接线批次才兑现。
- **engine devDep 引入 model-stats**:test-only workspace 依赖,运行时
  无 import(结构化回调解耦);若未来把适配器改挂 engine 内会引入
  正式依赖,需另批评审。

## 建议口径的推导说明索引(全部只读输出;采纳属维护者策略决定,本批不表述为「已生效」)

1. 阈值常量与依据:`packages/model-stats/src/budget.ts:33-44`
   (MIN_SAMPLES_PER_MODEL=5:n=5 起 nearest-rank P95 rank 5 与 P50
   rank 3 才指向不同观测,更小 n 的「P95」是最大值伪装;诚实下限而非
   质量声明)。
2. 百分位方法:`budget.ts:187`(nearest-rank,rank=⌈p·n⌉,1-based,
   输入数组先拷贝再排序,不改调用方数组)。
3. 建议口径字符串(随每个建议值携带,method+n 可审计):
   `budget.ts:278`(P95 向上取整 1000 档)、`budget.ts:284`(P50,fresh
   input,cache 读/写除外——UsageEvent.inputTokens 语义)。
4. 诚实边界(detail 双态携带):`budget.ts:174-179`(建议非策略;采纳
   需维护者批准,另批处理;不触碰 budget/scheduler 执行面)。
5. 真实窗口实测推导(可复算):`test/fixtures-real.test.ts:103-160`——
   claude-opus-5[1m] 桶 5 回合,outputs [394,137,3,3,911] 排序后
   [3,3,137,394,911],P95 rank 5=911→1000 档;inputs [6,2,4,2,2] 排序后
   [2,2,2,4,6],P50 rank 3=2(不取档);codex gpt-6-sol 桶 2 回合
   <5→insufficient-samples 缺口。同组推导另见
   `test/budget.test.ts` 状态机边界例(n=4 缺口/n=5 ready/6000 档取整
   例/子集拒绝例)。
6. tee 侧口径(建议的输入从何而来):`packages/engine/src/persistence.ts:173-180`
   (tee 线 = 刚落盘的脱敏 usage 载荷按保留 sourceType 重序列化;只收
   stored 事件)、`packages/model-stats/src/tee.ts:62-88`(合成行→既有
   提取器→store;model 归属显式传入,缺失落哨兵)。
