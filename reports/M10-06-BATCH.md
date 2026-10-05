# M10-06 批报告——v0.3.0 发布批(审查承接/托盘收口/端到端演练/版本抬升)

> 日期:2026-10-06 起。历批同口径:本报告不入冻结面;随批次任务逐节增补,
> commits 链存在结构性缺口(条目自身及所在提交哈希写入时不可知),候选
> SHA 以 git log 为准(沿历批教训不在文内写死)。

## 1. Summary

按 reports/M10-05-BATCH.md §9 交接清单与 docs/BACKLOG.md M10-06 行执行。
本节随任务交付增补。

## 2. 任务 1:M10-05 十轮审查承接(六条 minor,逐条带锚点)

- **a. docs/ORCHESTRATION.md §11 第 7 条**:主句改写为直接陈述 M10-05
  决策②落地后的新形状锚——现行尾注接缝行『（多节点工作流；本提示未携带
  Memory/Context 注入。）』+三方字面量一致(本会话 grep 逐字实证:
  packages/orchestration/src/execution-input.ts:176、
  packages/orchestration/test/memory-injection.test.ts:64
  M10_03_SEAM_NOTE 常量、packages/orchestration/test/multi-node.test.ts:353
  内联断言);删除『任务 2 将显式变更』将来时表述,改为【决策②已落地,
  M10-05 任务 2】+决策记录指针(M10-05 批报告 §3 与 PROPOSALS.md
  「治理披露:M10-05 交付——文档大收口+审查承接修复(2026-10-06)」§三)。
  零注入锚语义不变(仍是回归锚),仅从"待变更"改为"已落地"的如实陈述。
- **b. project/LICENSING.md 头注指针勘误。二选一决策=改指真实出处,
  不在 GOVERNANCE.md 补录**。理由:采用记录的真实出处已存在——
  PROPOSALS.md:277「治理披露：发布身份项落地（2026-09-25，维护者批准）」
  与 MAINTAINERS.md:14(公开发布门禁节,LICENSE 转正条目);而 GOVERNANCE.md:29
  仍是候选期原文(§贡献与权利仍称"许可证候选为 Apache-2.0,发布前须确认"),
  向治理文件补录采用记录属 GOVERNANCE.md:17 许可证类变更(须 ADR+明确
  维护者批准)且 GOVERNANCE.md:46 要求治理文件逐稳定发布复核——属维护者
  发布前流程,不由 Developer 代行。LICENSING.md 仅头注勘误(登记原注有误
  及原因),正文按历史原样保留零触碰。
- **c. AGENTS.md『范围与事实』持久化**:『M10-01..M10-04 已交付:…』逐批
  枚举改为持久表述(当前里程碑 M10 一句话+已交付任务与进度以
  docs/BACKLOG.md 当前里程碑节为准,本文件不逐批枚举以免陈旧);
  『安全要求』节逐字保留(提交前以 git diff 实证零触碰)。
- **d. project/backlog.json deliveryNotes**:新增 M10-06 条目(status
  "in-progress"、commits [],随后续任务更新),note 如实注明 commits 链
  结构性缺口(条目自身及所在提交哈希写入时尚不可知,M10-05 历史节同理)
  与『全链以 git log 为准』;M10-05 历史节零触碰(json load→dumps 后写,
  round-trip 断言+issues 61 项 id/status 逐一断言未变+git diff 仅 +5 行
  实证;末字节无换行与原格式一致,CR=0)。
- **e. 勘误(历史批报告不改写,登记于本节)**:reports/M10-05-BATCH.md §6
  『变更文件清单(本批累计,26 文件)』——该计数写于任务 3 时点(三任务
  11+11+5,去重 CHECKSUMS 重复一行)对当时为真;其后返修 commit(全量门禁
  第 1 轮 diff-view 钩子加固)新增
  packages/local-api/test/diff-view.test.ts,全批累计实为 **27 文件**。
  §6 未随返修更新,以本节为准;M10-05 批报告正文按红线不改写。
- **f. packages/local-api/test/diff-view.test.ts 头注释数字修正**:兄弟
  套件钩子预算实为 **60s/90s 且仅 beforeAll**——runs-orchestration.test.ts:68
  `T0_TIMEOUT_MS = 60_000`(beforeAll :229 以之收口 :322)、
  runs-multi-node.test.ts:69 `T0_TIMEOUT_MS = 90_000`(beforeAll :290 收口
  :427);两套件 afterAll(:324-:333 与 :429-:436)均裸钩无显式预算;
  runs-multi-node 的 `CELL_TIMEOUT_MS = 120_000`(:70)仅用于单测格
  (:751/:872)非钩子预算。原注释『already carry explicit 60s/120s hook
  budgets』三处不精确(数值 120s、把单测预算当钩子预算、暗示双钩均预算),
  改为精确表述:满载第 1 轮时点唯 diff-view 的 beforeAll 裸钩;兄弟套件
  仅 beforeAll 预算 60s/90s、afterAll 裸钩;本套件 beforeAll/afterAll
  各带显式 60s。仅注释,零代码语义变化。

## 3. 变更文件清单

任务 1(本节,7 文件):docs/ORCHESTRATION.md、project/LICENSING.md、
AGENTS.md、project/backlog.json、packages/local-api/test/diff-view.test.ts、
CHECKSUMS.sha256(四行重算:AGENTS/ORCHESTRATION/LICENSING/backlog.json)、
本报告。后续任务增补。

## 4. 测试及退出码(任务 1,2026-10-06 本会话实跑)

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 冻结面门禁 | node planning-check.mjs | (a) 79/79 匹配+(b) 干净副本 self-test passed(schemas 7/localLinksChecked 145/backlogItems 61/selfTestsPassed 37) | 0 |
| diff-view 隔离确认(仅注释变更) | cd packages/local-api && npx vitest run test/diff-view.test.ts | 8/8 | 0 |

## 5. 未验证项(任务 1)

1. ORCHESTRATION.md §11.7 新形状三方字面量一致性由本会话 grep 逐字实证,
   但 orchestration/local-api 测试套件未在本任务全量重跑(决策②锚定测试
   自 2b9a733 起未变;diff-view 隔离 8/8 覆盖 f 条触碰文件,全量
   pnpm test 属批次收官门禁)。
2. GOVERNANCE.md 未补录采用记录(决策 b 的另一半):其 §贡献与权利仍为
   候选期口径,属维护者发布前治理复核流程;v0.3.0 发布检查时应复核。
3. AGENTS.md『安全要求』节逐字保留以 git diff 实证(仅范围与事实块
   变更),但 AGENTS.md 作为工作区指令被注入 agent 会话的生效时点不由
   本批控制。
4. deliveryNotes.M10-06 条目 status "in-progress"/commits [] 为时点如实
   值,随后续任务更新;其自身提交哈希结构性不可知(§2 d 条已注明)。
后续任务增补。
