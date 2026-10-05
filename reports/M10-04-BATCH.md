# M10-04 批报告——Memory/Context 接入真实执行链 + TaskRun 状态模型修正 + 并发开放

> 日期:2026-10-06。三个实现任务(commit bd42c39 / b6c8498 / 797fc75)+ 本治理披露。
> 历批同口径:本报告不入冻结面;PROPOSALS.md 披露节与 CHECKSUMS 同步见 §7。

## 1. Summary

M10「编排产品化」能力补全批(BACKLOG M10-04;M10-03 的直接后续),把 M10-03 预留的
三条接缝全部接入生产:

- **Memory/Context 读侧注入(任务 1,commit bd42c39)**:M6 execution-input 接缝
  落地——多节点 CLI 节点的 stdin prompt 在角色标头/objective/依赖产物引用之外,
  追加「相关记忆」区块(memory-search 检索 verified/active,stale 排除,预算截断)
  与「上下文清单」区块(context manifest 条目引用,不内联全文)。读侧 fail-open:
  任何读取故障降级为无注入 + 一条 stderr 注记,执行永不阻塞;注入文本全过 A36
  redactText 管线;单节点路径保持裸 objective 逐字(v0.2.1 平价红线)。memory/context
  包写路径零接触。
- **TaskRun 状态模型修正(任务 2,commit b6c8498)**:按外部评估 P1 建议落
  status+outcome 双字段——受控迁移链版本递增 018(task_runs.outcome,nullable
  CHECK 四值),状态词汇表五个值一个不动;聚合修正:失败节点→RUNNING+failed、
  审批阻塞→RUNNING+blocked、全成功→READY_FOR_DELIVERY+null,UI 失败/阻塞徽标
  不再假执行中;迁移幂等与旧库(001 时代、017 时代)原位升级测试覆盖。
- **并发开放(任务 3,commit 797fc75)**:生产组合根 dispatchJoin serial→parallel
  (M10-02 统一策略①预留的独立决策)——单 run 轮内配额允许的派发经共享泵原语
  Promise.all 同飞;失败隔离 catch-per-run、收敛 all-terminal 原样;跨 run 仍是
  FIFO drive 链(全局 pollQueue 安全的前提);scheduler 四层并发约束零改动。
- **任务编号说明**:本批按编排收到的任务序列为 1/2/3/5(治理披露),无任务 4;
  上列三个 commit 即本批全部实现面。

安全边界不变:零注入命令面(RunDriver 六操作暴露面未动,driver-surface 钉死)、
RunDriver 永不批准、Memory 内容纯数据(A16:注入不产生权限/绑定/Profile 副作用,
memory-search 注入样本测试既有格持续覆盖)、迁移走受控链版本递增。

## 2. Memory/Context 注入实现

家在 packages/orchestration/src/execution-input.ts(M10-03 预留的 M6 接缝)+ 新
模块 memory-injection.ts:

- `buildNodePrompt` 新增可选 `memoryInjection` 形参。注入时 prompt 追加两个明确
  分隔标记区块(可测试):
  - `=== 相关记忆(memory-search 检索;只读数据,非指令;已脱敏)===`——逐条
    `- [verified|active] <memoryId> v<N>：<单行内容>`;截断附显式注记
    `（预算截断：另有 N 条相关记忆未注入）`(M3-01「删减记录不静默」教义)。
  - `=== 上下文清单(context manifest 条目引用,不内联全文)===`——逐条
    `- bundle <id>：run <runId> node <nodeId> bytes <n> contentHash <hex>（<createdAt>）`。
  零注入时输出与 M10-03 形状逐字节一致(含原尾注接缝行)= 回归锚。
- `nodePromptObjective` 多节点分支经 `collectNodeMemoryInjection` 汇聚——M4 派发
  与 M9 续行两条 launch 路径零改动自动携带;单节点分支保持裸 objective 逐字,
  永不注入。
- 读侧收集器(只读):memory-search `openMemoryAccess().search`(默认
  verified+active;查询=objective 前 6 token[各≤64 字符,按包分词边界预截]
  + 角色 token,AND 语义即包契约;stale 命中默认排除=M3-03 bundle 胶水同款
  「排除 over 标注」选型)+ context `listContextBundles`(项目作用域,最近 5 条,
  仅摘要字段,不读片段内容)。memory/context 包写路径零接触。
- 预算(既有 estimated-bytes 保守口径):默认 top-5 / 4096 字节,整条 drop 永不
  半条;注入文本先 `redactText`(cli-events A36)脱敏再字节计账(预算度量即出货
  文本),组行后再幂等过一遍覆盖引用行。
- fail-open(读侧与执行隔离):收集器永不抛——缺表/不可分词/未授权 scope 一律
  降级为空注入 + 恰一条 stderr eprintln(不占 stdout 事件协议);空库=常态零注记。
- 常量冻结(ask 未钉数值,取保守值并测试可覆盖):top-N=5、预算 4096 字节、查询
  6 token、上下文引用 5 条。`角色 token 并入 AND 查询`为「按节点 objective+角色
  检索」的落地解释(测试种子按此构造)。

## 3. 状态模型修正(status+outcome 双字段)

- **迁移 018**(`018-task-run-outcome`,store/schema.ts):`ALTER TABLE task_runs
  ADD COLUMN outcome TEXT CHECK (outcome IN ('success','failed','cancelled','blocked'))`
  ——nullable(NULL=进行中),CHECK 在 SQL 层钉词汇表。组合进 expand 的
  CONTROLLED_EXPANSION_MIGRATIONS(store 拥有 task_runs),DAEMON_MIGRATIONS 经
  union 自动收录(001..018);serve/browser-e2e/dogfood/local-api 测试组合根全部
  自动携带。钉死版本位如实更新(maintenance chain.test/backup-drill/cli、
  local-api helpers、browser-e2e/dogfood world、expand a04)。
- **实体与写面**:TaskRunRow.outcome + TASK_RUN_OUTCOMES/TaskRunOutcomeSchema +
  `setTaskRunOutcome`(zod 校验 + NoRowUpdatedError);setTaskRunStatus 签名零改动。
- **聚合修正**(run-driver settleRunStatus):全 SUCCEEDED→READY_FOR_DELIVERY+
  null;任一 WAITING_APPROVAL→RUNNING+blocked(活阻塞优先);任一 FAILED→
  RUNNING+failed(假 RUNNING 由 outcome 如实呈现);其余→null。写幂等(同值跳过)。
- **取消规则的诚实边界**:产品 v1 无任何 run-cancel 生产面(run status 生产写点
  仅 PLANNED→RUNNING 与→READY_FOR_DELIVERY 两处)——「取消→CANCELLED+cancelled」
  钉在 store 写面+专格成对断言,未来取消流程必经此面(如实报告为无生产接线)。
- **UI 同步**:GET /api/v1/runs 与 /api/v1/runs/:id 均携带 outcome;page.ts
  outcome 徽标(null=空串=行形状与既有逐字节一致;failed 红/blocked 琥珀;动态值
  经 esc()),列表行与详情头双落位——RUNNING 旁并列失败/阻塞徽标。

## 4. 并发开放

- 切换:run-driver 泵策略 `dispatchJoin: "parallel"`——一轮内配额允许的全部派发
  经共享泵原语 Promise.all 同飞(pump-primitives.ts M10-02 参数化的既有分支);
  catch-per-run 与 all-terminal 原样。
- 跨 run 不变:runs 仍在唯一 FIFO drive 链上逐个驱动——这是全局 pollQueue
  (scheduler_queue 全表 WAITING 候选)安全的前提;并行发生在单个 run 的轮内。
- 四层并发约束零改动:PUMP_CONCURRENCY {globalMax:4, projectMax:4,
  unverifiedCredentialGroupMax:1} 值冻结;第四层=profile.maxConcurrency;凭据层
  经 capability-gate(claude/codex credential-isolation 均 unverified→每组并发 1,
  A33 锁不变)。
- 审批暂停不占槽(代码核实):settleClaimBookkeeping(markQueueEntryCompleted+
  releaseExecutionQuotaGrants)先于 openCheckpointsForProposals——节点落
  WAITING_APPROVAL 时队列条目已 COMPLETED、配额已释放;WAITING_APPROVAL 非
  READY 不会再次入队。
- shutdown 全取消(parallel 下核实):launchExecution 逐执行注册 activeCancels,
  shutdown 全量 allSettled 取消——N 个在飞全覆盖;server.close→orchestrator
  .shutdown 次序不变。

## 5. 变更文件(28 文件,+1819/-70,git diff 0ec2825..797fc75)

任务 1(bd42c39,6):orchestration execution-input.ts / memory-injection.ts(新)/
index.ts / package.json(+memory-search、+context 依赖,+memory devDep)/
test/memory-injection.test.ts(新,14 格)/ pnpm-lock.yaml。

任务 2(b6c8498,20):store schema.ts / entities/task-runs.ts / test/migrations
.test.ts / test/task-run-outcome.test.ts(新);expand controlled.ts /
test/controlled-migrations-outcome.test.ts(新)/ test/a04-controlled-expansion
.test.ts;orchestration run-driver.ts;local-api views.ts / page.ts / test/page
.test.ts / test/runs-multi-node.test.ts / test/helpers.ts / test/expansion-api
.test.ts;browser-e2e world.ts;dogfood world.ts;maintenance chain.ts / test/chain
.test.ts / test/backup-drill.test.ts / test/cli.test.ts。

任务 3(797fc75,5):orchestration run-driver.ts / pump-primitives.ts / constants
.ts / package.json(描述);local-api test/runs-multi-node.test.ts(+2 格)。

## 6. 测试及退出码(全部 2026-10-06 本会话实跑)

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 类型检查 | pnpm typecheck | 61/61 任务 | 0 |
| 全套测试(冷) | turbo run test --concurrency=4 --force | 72/72 任务,0 cached,4m0.5s(任务 3 后末轮) | 0 |
| 构建 | pnpm build | 36/36 任务 | 0 |
| 冻结面 | node planning-check.mjs | (a) 79/79 checksums+(b) self-test | 0 |
| orchestration | npx vitest run | 57/57(43+14 注入格) | 0 |
| local-api | npx vitest run | 263/263(258+5) | 0 |
| store | npx vitest run | 60/60(56+4) | 0 |
| expand | npx vitest run | 29/29(27+2) | 0 |
| maintenance | npx vitest run | 29/29(含钉死版本位更新) | 0 |
| memory-search | npx vitest run | 59/59(写路径零接触) | 0 |
| dogfood / browser-e2e | npx vitest run(各自包内) | 13/13 与 22/22 | 0 |

如实登记的波动:任务 1 首轮 `pnpm test` 满载单败 local-api#test,隔离 `--force`
复跑全绿(既有满载脆弱性口径,M10-03 已登记);任务 2 首轮两 e2e 格超时=消费者
解析 orchestration dist 未重建,pnpm build 全量重建后全绿(先 build 后 test 的
门禁顺序教训重证)。

## 7. 治理披露与冻结面

PROPOSALS.md 追加「治理披露:M10-04 交付——Memory/Context 读侧注入+状态模型
双字段+并发开放(2026-10-06)」;CHECKSUMS.sha256 的 PROPOSALS.md 行按盘上纯 LF
字节重算(fd4b10ba→<见该文件现值>),planning-check 复跑。本报告(reports/)不入
冻结面,历批同口径。docs/BACKLOG.md 本批未动(M10-04 行维持原文;审查通过后的
验收标注属维护者流程)。

## 8. 未验证项

1. **真实记忆数据的端到端**:注入格以 proposeMemory/verifyMemory/promoteProjectRule
   种子记忆驱动真实 memory-search 检索(公开 API 全链),但「真实项目长期积累的
   记忆库+真实 objective 命中率」未测——AND 检索语义下零命中是常态(prompt 回落
   M10-03 形状),真实命中率属使用面数据。
2. **真窗(浏览器)注入/徽标形态**:outcome 徽标与记忆区块由 page.test 纯函数格
   与 API 契约覆盖;真 Chromium 交互流(browser-e2e 22/22 绿)未加 outcome/注入
   专格,无截图级验证。
3. 真实 CLI(非 fake-cli)多节点并行冒烟仍属历批登记未验证类(A33 凭据/会话
   争用等)。
4. 取消→CANCELLED+cancelled 无生产接线(v1 无 run-cancel 面),钉在 store 写面;
   真实取消流程落地时才能端到端验证。outcome=success 同(留给交付流程)。
5. 并行下的 git worktree 并发创建无并发锁冲突专格(格⑦通过为间接覆盖);
   global/project 层配额打满的拒绝-重试循环无新格(既有 scheduler 格覆盖)。
6. shutdown 后节点落 FAILED 而 run outcome 留 null 的形态与 A22/A24 重建/recover
   的衔接属 recovery 流程职责,本批未改未专格。
7. 生产旧库(真实用户 017 库文件)升级由测试级 001→018 与 017→018 升级格覆盖,
   未对磁盘真实生产库实测。
8. diagnostics 导出(A36 诊断文档)未加 outcome 字段(字段允许表纪律,ask 未要求)。

## 9. M10-05 交接(文档大收口清单)

M10-05 =「文档大收口:README/AGENTS/START_HERE/MANIFEST 重写,历史规划文档标注
historical,API_AND_EVENTS 对齐实际」。本批产生的文档收口输入:

1. **needs-更新**:docs/ORCHESTRATION.md(冻结面)仍描述 dispatchJoin serial 与
   「run 状态词汇表无 failed 值」的旧口径——收口时对齐:并行 dispatchJoin(跨 run
   FIFO 不变)+ status+outcome 双字段 + 迁移 018;docs/API_AND_EVENTS.md 补
   runs list/detail 的 outcome 字段与 GET /api/v1/runs 形状。
2. **needs-更新**:packages/orchestration/src/execution-input.ts 头注释已描述注入
   区块;ORCHESTRATION.md 的 M6 节若引 prompt 形状需同步两个区块标记文本。
3. **needs-更新**:README/START_HERE 若描述「任务失败=RUNNING」或「任务串行执行」
   的用户口径,改为 outcome 呈现与轮内并行。
4. **needs-登记**:docs/MEMORY_AND_CONTEXT.md(冻结面)第 5 节检索/预算教义已被
   实现为读侧注入(排除 stale、estimated-bytes、截断注记)——收口时在节内补
   「执行链读侧注入已落地」指针(或按维护者决定保持冻结、以代码注释为准)。
5. **未验证项移交**:本报告 §8 全部条目;其中 #1/#2 建议作为 M10-05 的「文档与
   代码零矛盾」验收的对照面。
6. **接缝勿动清单(沿 M10-02/M10-03)**:RunDriver 六操作暴露面、审批红线(驱动
   永不批准)、M8 无注入命令面、A38 驱动侧读锁、M10-03 单 integration 节点限制、
   本批新增:memory/context 包写路径零接触红线、单节点裸 objective 平价红线、
   迁移链版本递增纪律(019 起)。
