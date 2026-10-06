# V031-02 批报告——真实使用采集批:只读导出工具 + 演练模板 + 审查精度族(2026-10-06)

## 1. Summary

v0.3.1「Real Usage & Stabilization」P1 批(为维护者环境动作备料),三个提交,
零外部 npm 依赖(lockfile 零变化),零运行时行为变更(唯一新增可执行面=
独立只读导出脚本,不入任何生产代码路径):

- **任务 1 备料(commit c69af36,4 文件)**:①`scripts/usage-stats.mjs`
  新建——对库中每个 task_run 导出 BACKLOG V031-02 行定义的 13 项指标
  (JSON/MD),`node:sqlite` READONLY 打开(与 packages/store 迁移框架
  同源),聚合口径全部按受控迁移链真实字段勘察后落查询,unknown-deny
  教义落实(⑨⑪ 如实 unknown,见 §2);②`reports/REAL-USE-DRILL-TEMPLATE.md`
  新建——5 类任务×13 指标登记表+操作 SOP+人工观察栏六维度(§3);
  ③README.md 增『真实使用验证(v0.3.1 主线)』节(冻结面,CHECKSUMS
  仅该行重算)。
- **任务 2 审查精度族(commit 23a485b,6 文件)**:V031-01 审查移交精度族
  逐项——族A 断言新增(唯一授权面)、族C/F/G 纯注释、族I BACKLOG 门禁
  数字对齐;移交勘误三项登记至本提交 PROPOSALS 披露节(§4)。
- **任务 4 终化(本提交,5 文件)**:本批报告(不入冻结面,历批同口径)、
  PROPOSALS 治理披露节、docs/BACKLOG.md V031-02 标完成态、
  project/backlog.json deliveryNotes.V031-02(先 dumps 后写)、
  CHECKSUMS.sha256 三行终同步。任务 2 ask 所称「任务 3 披露」未单列
  提交——其勘误登记面由本提交的 PROPOSALS 披露节承载(提交链如实:
  c69af36→23a485b→本提交)。

门禁(2026-10-06 本会话实跑):orchestration vitest 65/65 exit 0;先
`pnpm build`(exit 0)重建 dist 后 local-api vitest 268/268 exit 0;
`node planning-check.mjs` exit 0(历次:(a) 79/79 checksums match+
(b) self-test exit 0);`node scripts/usage-stats.mjs --db
"%LOCALAPPDATA%\role-orchestrator\orchestrator.db" --format md` 经 cmd
原样实跑 exit 0 且输出含 8 个真实 run(逐命令表见 §6)。红线遵守:用户库
全程只读连接绝不写入;模板/批报告/文档不入运行时;git add 显式路径;
无 push 无 tag。

第 2 轮审查拦截 B1(模板 POST /runs 示例体与真实校验面矛盾)已返修:
示例体重写为真实可用形状并经 dist 导出 schema safeParse 确定性验证,
详见 §8;§7-5 失实声称已就地更正。

## 2. 导出脚本(scripts/usage-stats.mjs):用法与逐指标可导出性

**用法**:`node scripts/usage-stats.mjs --db <SQLite 路径>
[--format json|md] [--run <runId>]`。`--format md`=人读摘要表(每 run
一行 13 列)+明细+口径速览;`--format json`(默认)=机器可读,含
metricsLegend。退出码:0 成功;2 用法错误;3 库打不开/库无 task_runs 表/
--run 不存在(如实失败,不以空导出掩盖)。聚合口径 13 项逐条写入脚本头
注释(含来源表与迁移版本号)。对用户库只读:`new DatabaseSync(path,
{ readOnly: true })`,绝不写入;零 import 产品包。

**勘察依据(本会话实读)**:受控迁移链真实字段——store/schema.ts(001
核心表+018 outcome)、runtime-profile/migration.ts(002)、dag(003/015/
016)、scheduler(004)、integration/record.ts(005)、review/record.ts
(006)、context/persist.ts(007)、memory(008)、memory-search(009/010)、
approval(011)、checkpoint(012)、expand(013/017/controlled.ts 受控链
001-013+015-018)、budget/migration.ts(014);真实用户库只读勘察:28 表、
schema_migrations 版本实测 [1..13,15,16,17,18]——**014 不在产品链,
execution_usage/node_retry_state/run_budgets/budget_run_holds 四表在真实
库不存在**。

**逐指标可导出性(13 项,unknown-deny 如实)**:

| # | 指标 | 判定 | 来源与说明 |
|---|---|---|---|
| ① | 任务成败 | 可导出 | task_runs.status+outcome(001/018) |
| ② | 用到的角色 | 可导出 | task_nodes.role_id 计数+run_profile_snapshots 冻结快照(003/002) |
| ③ | DAG 实际展开 | 可导出 | task_nodes 节点+dependencies 冻结快照展开为边;review_expansions 标注扩图产物(003/013) |
| ④ | executions 数 | 可导出 | COUNT(executions by run)(001) |
| ⑤ | 失败/重试次数 | 可导出 | executions 终态 phase 分类+attempt≥2 计数(001;attempt 的 source of truth 即 executions 表) |
| ⑥ | 审批次数 | 可导出 | approvals by requested_by_run_id 分状态+approval_checkpoints by run 分状态(011/012) |
| ⑦ | Reviewer fail 次数 | 可导出 | review_records state='COMPLETED' AND verdict='fail',附 pass/blocked/INVALID(006) |
| ⑧ | 上下文命中 | 可导出,现状预期 0 | context_bundles by run(007,run_id 关联真实有效);现状注记:v1 产品编排路径读侧注入不落新 bundle 行,bundle assemble+persist 仅 context-e2e 驱动面(dogfood/browser-e2e)写入——真实产品 run 预期 0/无行,现状非故障 |
| ⑨ | Memory 命中 | **unknown** | 该指标当前无持久记录:读侧检索(orchestration/memory-injection.ts,collectNodeMemoryInjection)只把命中注入节点 prompt 从不落库;bundle_fragments layer='memory' 仅 context-e2e 面写入。需人工评估(模板观察栏)或后续批补持久记录 |
| ⑩ | 总耗时 | 可导出(区间近似) | task_runs.created_at→MAX(executions.updated_at);task_runs 无 finished_at 列,口径如实入头注释;无执行行记 null |
| ⑪ | CLI usage | **unknown** | 该指标当前无持久记录:迁移 014 execution_usage 不在产品受控链(真实库实测无该表);model-stats PerformanceStore 独立 JSONL 且 UsageEventSchema 无 runId 字段(结构性无 run 级关联);产品 serve/orchestration 未接线 usageSink(grep 零命中)。脚本对 execution_usage 做表存在性探测,未来入库自动改真实值 |
| ⑫ | 人工介入点 | 可导出 | approvals(请求/批准/拒绝+理由)+approval_checkpoints(WAITING/CONTINUED/CANCELLED)+expansion_user_holds(挂起/解除)按时间排序时间线(011/012/013) |
| ⑬ | 最终 diff 指针 | 可导出 | integration_records.integration_branch+candidate_sha+state(005);无集成行记「无集成记录」 |

**实跑证据(2026-10-06)**:对真实库 `%LOCALAPPDATA%\role-orchestrator\
orchestrator.db`(8 个真实 run,2026-10-03/05 的 fake wrapper 演练留存)
`--format md` exit 0 输出 8 行摘要(如 run-muse4pch:READY_FOR_DELIVERY/
null、developer:1、1 节点 0 边、1 exec、0/0/0、耗时 1s、⑨⑪ unknown);
`--format json` 可解析(8 runs/13 legend/13 metric keys/readOnly:true);
`--run` 过滤 exit 0;空库诚实失败 exit 3;缺 --db exit 2。2 节点 run 依赖
边 0 经只读直查 dependencies JSON 确认是真实数据非解析丢失。临时种子库
(真实 DDL+014 表+审批 CONSUMED/checkpoint CONTINUED/hold 行)验证了
execution_usage 在库分支与介入时间线渲染分支,并修复一处渲染缺陷(表存在
且有数据时摘要格误显 unknown)。

## 3. 演练模板(reports/REAL-USE-DRILL-TEMPLATE.md):结构

五节:①一次性准备(安装/启动/**壳令牌文件模式取令牌**/profiles.json
配置/四角色绑定/就绪验证);②每次演练通用 SOP(5 类任务选型→**单节点与
多节点 workflow 两种建任务方式**(含 POST /api/v1/runs workflow 示例体,
v1 限制:每任务至多一个 integration 节点)→实时观测(WS 进度/一次性
actionDigest 审批卡/阻塞徽标/人工动作随手记)→usage-stats 留档命令→
登记);③13 指标登记表空表模板(⑨⑪ 标注 unknown 需人工补记、⑧ 标注
现状预期 0);④人工观察栏——维护者评估提的六个真实问题维度(Coordinator
拆任务质量/Architect 冗余度/依赖上下文适量度/Developer 重复工作/Reviewer
严苛度/Memory 噪声),1–5 评分+证据栏;⑤五类任务演练节 D1–D5(小 bug/
小功能/跨前后端/架构重构/Reviewer 首轮 fail 返工)各含登记表与观察栏
占位;⑥留档纪律(⑨⑪ 不伪造成导出值、⑧ 照实记 0、脱敏自决、缺陷走
提案渠道)。模板不入冻结面;填写副本含真实任务内容,归档与脱敏程度由
维护者自决。

## 4. 精度族收口对照(V031-01 审查移交,commit 23a485b)

| 族 | 位置 | 处置 |
|---|---|---|
| A | orchestration/test/memory-injection.test.ts context-refs 上限格 | 断言新增(本批唯一授权面):全量 prompt 相等断言(expect.toBe),二选一中取全量相等——措辞绑定的 not.toContain 只能判别复用「预算截断」词汇的注记,全量相等对本格完全确定(记忆侧空+refs 块恰 5 行),期望串由 injection.contextRefs 字段构造经 redactText 镜像生产渲染路径;格注与尾注判别力注释同步改如实(原『cannot land silently either way』refs 侧半真)。原 toContain/not.toContain 行不动;65/65 实跑含新断言一次通过 |
| C | orchestration/test/pump-primitives.test.ts 两并行格判别力注释 | 纯注释:thrown-fault 格第 4 臂与超时现状锚格 sibling-abort 臂改如实——本格记录现行 detached-continuation 形状,组合层取消不使本格红(格 stub 派发层,stub promise 不可被组合层中止),该语义落地时须在组合/e2e 面钉;保留臂不动 |
| F | local-api/test/runs-multi-node.test.ts 聚合优先级格+审批续行窗口现状锚格 | 纯注释:『终态 blocked wait=中途漂移不恢复的兜底,非独立钉』——outcome 决策前已 blocked 且本路径从不可见离开 blocked,省略性变异(再停审批不再重聚)不可观测;真正判别臂=分支序翻转/mid-flight 异值臂;断言本体不动 |
| G | local-api/test/runs-orchestration.test.ts 409 漂移门格判别力首臂 | 纯注释:括号限定词改显式双臂——PURE DELETION(stored 行仍 600,仅 409 断言红)/UPSERT REPLACEMENT(行变 601,双红);与 2f72d2a 的 PROPOSALS/批报告勘误同口径对齐 |
| I | docs/BACKLOG.md V031-01 交付摘要 | 门禁数字 267/267→268/268 对齐终态(第 5 轮返修门范围锚格后 268=263+1+3+1),括注注明对齐来源;CHECKSUMS 仅该行重算(4c29a82e…→50a4a293…) |

族I 移交勘误三项(批报告 commits 结构性缺口/§2.1 指针/M10-06 §9 引用
改标)与族A 的 PROPOSALS/BACKLOG『双侧钉』表述勘误:**历史文档不改写**
(V031-01-BATCH.md、backlog.json 既有 note、BACKLOG V031-01 既有节均
保持原样),统一登记于本提交 PROPOSALS『治理披露:V031-02 交付』精度族
勘误登记小节(含本会话机械复核证据)。

## 5. 变更文件清单(批累计,15 文件)

任务 1(c69af36,4 文件):

| 文件 | 变更 |
|---|---|
| scripts/usage-stats.mjs | 新建,只读导出工具(755 行,零外部依赖,零产品包 import) |
| reports/REAL-USE-DRILL-TEMPLATE.md | 新建,5 类任务×13 指标演练模板 |
| README.md | 『真实使用验证(v0.3.1 主线)』节(+15 行,冻结面) |
| CHECKSUMS.sha256 | README 行重算(1b0dfe1b…→9a4e7252…) |

任务 2(23a485b,6 文件):

| 文件 | 变更 |
|---|---|
| packages/orchestration/test/memory-injection.test.ts | 族A:全量 prompt 相等断言+格注/尾注改如实(唯一断言新增) |
| packages/orchestration/test/pump-primitives.test.ts | 族C:两并行格判别力注释改写(纯注释) |
| packages/local-api/test/runs-multi-node.test.ts | 族F:两格判别力第 3 臂改写(纯注释) |
| packages/local-api/test/runs-orchestration.test.ts | 族G:409 格首臂双臂显式化(纯注释) |
| docs/BACKLOG.md | 族I:V031-01 摘要门禁 267/267→268/268 |
| CHECKSUMS.sha256 | docs/BACKLOG.md 行重算(4c29a82e…→50a4a293…) |

任务 4(本提交,5 文件):

| 文件 | 变更 |
|---|---|
| reports/V031-02-BATCH.md | 新建,本报告(不入冻结面) |
| PROPOSALS.md | 追加『治理披露:V031-02 交付(2026-10-06)』节(冻结面) |
| docs/BACKLOG.md | V031-02 标完成态+交付摘要节(冻结面) |
| project/backlog.json | deliveryNotes 增 V031-02(先 dumps 后写,冻结面) |
| CHECKSUMS.sha256 | PROPOSALS/BACKLOG/backlog.json 三行重算 |

第 2 轮审查返修(本提交,2 文件,零生产代码变更):

| 文件 | 变更 |
|---|---|
| reports/REAL-USE-DRILL-TEMPLATE.md | §2 示例体重写(去 workflow.id/name、每节点补必填 kind/dependencies、单 integration 汇聚形)+§1 令牌位置措辞更正(§8) |
| reports/V031-02-BATCH.md | §1 返修注记/§5 本表/§6 返修命令行/§7-5 更正/§8 拦截记录新增 |

## 6. 测试及退出码(2026-10-06 本会话实跑)

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 任务 1 门禁(冻结面) | node planning-check.mjs(CHECKSUMS 更新前后各一次,提交后再复跑) | (a) 79/79 checksums match+(b) self-test exit 0 | 0 |
| 任务 1 脚本实跑(ask 点名) | 经 .cmd 以 cmd 原生展开跑 `node scripts\usage-stats.mjs --db "%LOCALAPPDATA%\role-orchestrator\orchestrator.db" --format md` | 8 个真实 run 摘要行 | 0 |
| 任务 1 脚本实跑(bash 等价面) | node scripts/usage-stats.mjs --db "$LOCALAPPDATA/role-orchestrator/orchestrator.db" --format md(>文件) | 同上 | 0 |
| 任务 1 json 形态 | 同上 --format json+node -e JSON.parse 断言 | 8 runs/13 legend/13 metric keys/readOnly:true | 0 |
| 任务 1 --run 过滤 | --run run-muvv1fw5-8ac56682 --format md | 恰 1 run | 0 |
| 任务 1 空库/缺参 | --db 空文件;缺 --db;--help | 诚实失败 3;用法错 2;帮助 0 | 3/2/0 |
| 任务 1 种子库分支 | node:sqlite 建真实 DDL 种子库(含 014 表+审批/续行/挂起行)→脚本 md | execution_usage 在库分支+时间线渲染分支验证;修复摘要格渲染缺陷 | 0 |
| 任务 1 真实数据核对 | node:sqlite 只读直查 task_nodes.dependencies | 2 节点 run 依赖边 0=真实数据 | 0 |
| 任务 2 orchestration | pnpm vitest run(packages/orchestration) | 65/65(8 文件,含族A 新断言) | 0 |
| 任务 2 dist 重建 | pnpm build(仓库根) | 36 包构建 | 0 |
| 任务 2 local-api | pnpm vitest run(packages/local-api,先重建 dist) | 268/268(24 文件,129.92s) | 0 |
| 任务 2 冻结面 | node planning-check.mjs | 79/79+self-test | 0 |
| 任务 2 注释面校验 | git diff 过滤非注释行(grep -vE '//\|\*') | 族C/F/G 零非注释 diff 行 | 0 |
| 任务 4 冻结面 | node planning-check.mjs(CHECKSUMS 终同步后) | 79/79+self-test | 0 |
| 任务 4 backlog.json | python json load→dumps(ensure_ascii=False,indent=2,尾 LF)→断言 63 issues id/status 不变、去新增键后逐字节一致、纯 LF | 通过 | 0 |
| 返修构建 | pnpm build(仓库根) | 36/36 FULL TURBO(全缓存=src 与既有 dist 零漂移,dist 可作真实导出源) | 0 |
| 返修确定性验证(§8) | node --input-type=module -e:模板 json 围栏逐字提取→dist RunCreateBodySchema.safeParse;原错误体对照;validateWorkflowSpecs 补充 | 修正体 success=true(1 integration+4 agent,依赖齐全);错误体 success=false 恰 6 issues;域门过 | 0 |
| 返修冻结面 | node planning-check.mjs(返修提交前) | 79/79+self-test(模板/批报告不入冻结面,CHECKSUMS 零变化) | 0 |

## 7. 未验证项

1. **真实任务跑批=维护者主线,本批首要未验证项**:5 类真实任务
   (D1–D5)×13 指标演练从未执行——模板与导出工具的**使用面**未经过
   一次真实演练检验(操作步骤的可执行性、观察栏的可用性、⑨⑪ 人工补记
   的实际负担)属 v0.3.1 维护者环境动作①(BACKLOG 维护者环境动作节),
   非仓库批可闭合面。真实 CLI(claude/codex)E2E 全链沿用 v0.3.0 口径
   unverified(README 能力边界节)。
2. 族A 全量相等断言的判别力方向(未来新增 refs 侧注记→格红)经逻辑
   构造核对,未做变异实证(未临时注入注记观察格红);族C『组合层取消
   不使本格红』与族F『省略性变异不可观测』为推理改写+审查结论承接,
   均未变异实证。
3. usage-stats 的 execution_usage 在库分支仅经临时种子库(真实 DDL)
   验证;真实产品路径 014 永缺表(受控链不含),该分支在生产库不可达
   ——探测分支属前瞻面。
4. ⑧ 上下文命中「现状预期 0」的定性依据为读侧代码面勘察
   (assembleContextBundle 调用方=context-e2e 驱动面,orchestration/
   local-api 零调用,grep 实证);真实产品长期使用中是否出现非零行
   未验证(若出现,即 dogfood 面产物)。
5. 演练模板内 POST /runs workflow 示例体的可执行性:**本条原文声称
   「字段形状对照 local-api server.ts 的 body 校验面与 README/API 文档」
   ——该声称失实**(第 2 轮审查拦截 B1):示例体携带 schema 不接受的
   workflow.id/name 且全部节点缺必填 kind、首节点缺必填 dependencies,
   按真实校验面 RunCreateBodySchema.safeParse 失败 6 处——即形状从未
   被正确对照过。已返修:示例体重写为真实可用形状,经 dist 导出
   schema safeParse 确定性验证通过(命令与输出原文见 §8)。「未起真实
   serve 发请求」这一点返修后仍属实,照旧移交:schema 层与域门层
   (validateWorkflowSpecs)已覆盖,真实 serve 端到端(绑定/profile 就绪
   下的 202 全链)仍属维护者环境动作①。
6. 『10 轮审查』属批次后续流程,未在本交付内完成(历批同口径)。
7. 全量 `pnpm test`(turbo 全部任务)未在本批重跑;门禁按 ask 点名面
   (orchestration+local-api)与冻结面(planning-check)执行。
8. 历批未验证项(V031-01 §7 各项、M10-04/M10-05 §8 移交项)照旧移交,
   本批未触碰。

## 8. 审查拦截记录(第 2 轮,2026-10-06)

**拦截项 B1:模板操作步骤与实际产品流矛盾**。审查指出
reports/REAL-USE-DRILL-TEMPLATE.md §2 的多节点 `POST /api/v1/runs`
workflow 示例体按真实校验面必然 400 INPUT_REJECTED;审查者以 dist 导出
的真实 RunCreateBodySchema(packages/local-api/src/orchestrator.ts
:165-192 的编译产物,POST /runs 唯一 body 校验面,server.ts:1307
safeParse 调用点)实测失败。

**原文要点(三类缺陷)**:①`workflow.id`/`workflow.name` 为
strictObject 未识别键——schema 的 workflow 只接受 `nodes`
(orchestrator.ts:187-191),id/name 由系统派生不接受传入(多节点
`wf-${runId}`/固定名,run-creation.ts:160-163+multi-node.ts:51);②四个
节点全部缺必填 `kind`(enum agent|integration|review,
orchestrator.ts:168);③首节点 plan 缺必填 `dependencies` 数组
(orchestrator.ts:174,无 .optional)。

**本会话实测证据(2026-10-06,与审查者同法:dist 导出
RunCreateBodySchema.safeParse)**。先 `pnpm build`(36/36 FULL TURBO
全缓存,exit 0——src 与既有 dist 零漂移,dist 可作真实导出源),再
原样执行(仓库根;[1] 修正体=从返修后模板 json 围栏逐字提取,[2]
原错误体=返修前模板示例原状,[3] 域门补充):

```
$ grep -c "RunCreateBodySchema" packages/local-api/dist/orchestrator.js && node --input-type=module -e "
> import { readFileSync } from 'node:fs';
> const { RunCreateBodySchema } = await import('./packages/local-api/dist/orchestrator.js');
> const md = readFileSync('reports/REAL-USE-DRILL-TEMPLATE.md', 'utf8');
> const m = md.match(/\x60{3}json\n([\s\S]*?)\x60{3}/);
> if (m === null) { console.error('NO JSON BLOCK FOUND IN TEMPLATE'); process.exit(9); }
> const fixed = JSON.parse(m[1]);
> console.log('=== [1] FIXED body (extracted verbatim from reports/REAL-USE-DRILL-TEMPLATE.md json block) ===');
> const ok = RunCreateBodySchema.safeParse(fixed);
> console.log('safeParse success =', ok.success);
> if (!ok.success) { console.log(JSON.stringify(ok.error.issues, null, 2)); process.exit(1); }
> console.log('parsed.workflow.nodes =', JSON.stringify(ok.data.workflow.nodes.map(n => ({ id: n.id, role: n.role, kind: n.kind, dependencies: n.dependencies })), null, 1));
> const bad = {
>   objective: '<一句话任务目标>',
>   projectDir: '<绝对路径>',
>   workflow: {
>     id: 'wf-drill-1',
>     name: '<任务名>',
>     nodes: [
>       { id: 'plan', role: 'architect', objective: '<设计目标>' },
>       { id: 'impl', role: 'developer', objective: '<实现目标>', dependencies: ['plan'] },
>       { id: 'integrate', role: 'developer', objective: '<集成目标>', dependencies: ['impl'] },
>       { id: 'review', role: 'reviewer', objective: '<审查目标>', dependencies: ['integrate'] }
>     ]
>   }
> };
> console.log('=== [2] ORIGINAL (pre-fix) body: workflow.id/workflow.name present, no kind, first node no dependencies ===');
> const res = RunCreateBodySchema.safeParse(bad);
> console.log('safeParse success =', res.success);
> if (!res.success) {
>   console.log('issue count =', res.error.issues.length);
>   for (const i of res.error.issues) {
>     console.log('  path=' + JSON.stringify(i.path).replace(/,/g, '.') + ' code=' + i.code + ' message=' + i.message);
>   }
> }
> console.log('=== [3] domain gate supplement: validateWorkflowSpecs on the fixed node set ===');
> const { validateWorkflowSpecs } = await import('./packages/orchestration/dist/multi-node.js');
> const specs = ok.data.workflow.nodes.map(n => ({ id: n.id, role: n.role, kind: n.kind, objective: n.objective, dependencies: n.dependencies }));
> try { validateWorkflowSpecs(specs); console.log('validateWorkflowSpecs = PASSED (budget/unique ids/unknown deps/self dep/integration parents/at-most-one-integration all pass)'); }
> catch (e) { console.log('validateWorkflowSpecs = REFUSED: ' + e.message); process.exit(1); }
> ";
1
=== [1] FIXED body (extracted verbatim from reports/REAL-USE-DRILL-TEMPLATE.md json block) ===
safeParse success = true
parsed.workflow.nodes = [
 {
  "id": "plan",
  "role": "architect",
  "kind": "agent",
  "dependencies": []
 },
 {
  "id": "impl-fe",
  "role": "developer",
  "kind": "agent",
  "dependencies": [
   "plan"
  ]
 },
 {
  "id": "impl-be",
  "role": "developer",
  "kind": "agent",
  "dependencies": [
   "plan"
  ]
 },
 {
  "id": "integrate",
  "role": "architect",
  "kind": "integration",
  "dependencies": [
   "impl-fe",
   "impl-be"
  ]
 },
 {
  "id": "review",
  "role": "reviewer",
  "kind": "agent",
  "dependencies": [
   "integrate"
  ]
 }
]
=== [2] ORIGINAL (pre-fix) body: workflow.id/workflow.name present, no kind, first node no dependencies ===
safeParse success = false
issue count = 6
  path=["workflow"."nodes".0."kind"] code=invalid_value message=Invalid option: expected one of "agent"|"integration"|"review"
  path=["workflow"."nodes".0."dependencies"] code=invalid_type message=Invalid input: expected array, received undefined
  path=["workflow"."nodes".1."kind"] code=invalid_value message=Invalid option: expected one of "agent"|"integration"|"review"
  path=["workflow"."nodes".2."kind"] code=invalid_value message=Invalid option: expected one of "agent"|"integration"|"review"
  path=["workflow"."nodes".3."kind"] code=invalid_value message=Invalid option: expected one of "agent"|"integration"|"review"
  path=["workflow"] code=unrecognized_keys message=Unrecognized keys: "id", "name"
=== [3] domain gate supplement: validateWorkflowSpecs on the fixed node set ===
validateWorkflowSpecs = PASSED (budget/unique ids/unknown deps/self dep/integration parents/at-most-one-integration all pass)

SCRIPT_EXIT=0
```

失败恰 **6 处**(4×节点缺 kind=invalid_value + 1×首节点缺
dependencies=invalid_type + 1×workflow unrecognized_keys 恰含 "id"
"name" 两键)——与审查「safeParse 失败 6 处」独立复核一致;修正体
success=true。补充域门 validateWorkflowSpecs
(packages/orchestration/src/multi-node.ts:90-162:预算/唯一 id/未知
依赖/自依赖/integration 须有父节点/至多一个 integration)同过,即修正
体照抄可同时过 schema 层与域门层(真实 202 全链仍须绑定/profile 就绪,
§7-5)。

**返修处置**:

1. **示例体重写**(参照真实测试体
   packages/local-api/test/runs-multi-node.test.ts:485-520 四节点图):
   去 `workflow.id`/`workflow.name`;5 节点全部补必填 kind——恰 1 个
   integration 节点(kind:"integration",两 developer 节点并行汇入,
   即 multi-node.ts:77-78 「v1 supported form:many developer nodes
   merged by ONE integration node」,D3 验证意图),其余 4 节点
   kind:"agent";全部补必填 dependencies(首节点 `[]`)。顺带注明两条
   真实语义:带 workflow 时各节点由自身 objective 驱动、顶层 objective
   仍作为任务记录(run-creation.ts:160-163);要演示 D5 受控返工扩图须
   把审查节点声明为 kind:"review"(约束:恰好一个依赖+role 必为
   reviewer,multi-node.ts:137-156)。
2. **模板其余操作步骤逐项核对真实产品流**(本会话实读代码面):令牌
   位置措辞由「当前用户目录」更正为「当前用户临时目录」(默认
   `%TEMP%\role-orchestrator-local-api\session-token-<随机>.txt`,
   server.ts:1647-1649;home/temp 均合法,token.ts:10-17);其余核对
   全部一致未改——profiles 默认路径 `%LOCALAPPDATA%\role-orchestrator\
   profiles.json`(desktop-shell main.rs:108-120)、example.yaml 转换
   约定(serve.ts:38-39)、写回不热重载+重启生效+同 id 改 model 不产生
   新 revision(profiles-config.ts:25-39)、未绑定目录 422 引导
   (run-creation.ts:229-244)、创建对绑定零副作用(run-creation.ts
   :126-129)、单节点裸 objective(run-creation.ts:144-159)、WS 直播
   (ws-events.ts:2-3,/api/v1/events/live)、一次性 actionDigest 审批卡
   (page.ts:45-49)、三轮耗尽「等用户」挂起(controlled.ts:6,439)、
   usage-stats 留档命令(任务 1 已实跑,§6)。
3. **§7-5 失实声称就地更正**(原「字段形状对照 body 校验面」系失实
   ——形状从未被正确对照过,见上);§1/§5/§6 同步返修注记。零生产代码
   变更(本返修仅触 reports/ 两文件,packages/*/src 与 apps/ 零差异)。
