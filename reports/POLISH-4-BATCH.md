# POLISH-4 批次报告:全仓维护态 minor 终审(M8-06 十轮审查移交族收口 + 历批 POLISH 系列遗留扫描)

日期:2026-09-30。开发者会话交付 BACKLOG POLISH-4(第 51 项)范围全部三块:
M8-06 十轮审查移交族逐条闭合(A/B/C/D/F/G/H/I/J/K/L/M/N/P/Q 族;移交 ask
未登记 E 族)、历批 POLISH 系列遗留扫描、终审清单产出。立项与验收原文见
docs/BACKLOG.md「POLISH-4」;治理披露见 PROPOSALS.md 2026-09-30 的
POLISH-4 各节(立项/交付)。本报告不在 CHECKSUMS 冻结面。
全文引用弃用裸行号:定位以文件名+唯一文本锚/函数名/节名为准,个别
「扫描时点行号」仅作辅助标注、以文本锚为准(会随文件增长漂移)。

## 0. Summary

三块全交付:①移交族闭合——A 族「唯一运行时行为变化」改三处枚举式
(两份文件,三处经 M8-06 候选提交 diff 实证)、B 族裸行号引用锚点化(两份
BATCH 报告七处+「:179 失实措辞」三处)、C/D 族测试钉值(budget.test 新增
两用例:N7 双 ready+双 gap 词表变体、P95=4200 ceil 方向钉;套件 68→70)、
F/G/H/I/J/K/L 族 BATCH 纳米修正七处、M 族取整口径残留、N 族计数口径
(11 行/10 hunk,diff 实证)、P/Q 族测试措辞;②历批扫描——POLISH-1/2/3
披露节与三份报告全文读毕+两轮 grep sweep:closed-naturally 七项、本批
锚点收口两项(PROPOSALS 旧披露节两处漂移行号删号留锚、USAGE.md 快照数
对齐引源)、剩余终审清单十二项逐条处置/归属;③治理——PROPOSALS 交付节、
CHECKSUMS 三次同步、候选提交。**行为语义零变化**(产品源码、依赖、tauri
配置零触碰;改动=文档/披露措辞、报告引用锚点化、测试注释/用例标题措辞
与新增测试用例)。终态门禁:全仓 typecheck/test/build=0(FULL TURBO)、
cargo test=0(26+17+3 passed/1 ignored)、model-stats 单包
typecheck/test/build=0/0/0(7 文件/70 tests)、planning-check=0
((a) 79/79+(b) 干净副本 self-test exit 0)。本提交即 POLISH-4 批次候选
提交(候选链 b5e383b→本提交)。

### 变更文件清单(本批全部,工作树→本提交)

| 文件 | 变更 | 任务 |
|---|---|---|
| `reports/M8-06-BATCH.md` | A 族枚举式、B 族锚点化+失实措辞引文锚、F 笔误、G 证据指针、H(=B)、I 口径+补列、J 归属、K 枚举补登、L 行号校正、N 计数口径 | 1 |
| `reports/M8-04-BATCH.md` | B 族三条目锚点化(百分位方法/建议口径字符串/诚实边界) | 1 |
| `PROPOSALS.md` | A 族枚举式(M8-06 交付节)、M 族取整口径、N 族计数口径、POLISH-1 披露节两处行号锚点化、交付节追加 | 1/3/5 |
| `CHECKSUMS.sha256` | PROPOSALS 行三次按盘上 LF 字节重算(31ab08c3…→a9cd18f8…→31f821a6…→6c88b481…) | 1/3/5 |
| `USAGE.md` | 「清理前后必须复核扫描计数」条快照数对齐引源(1620/1091→1622/1093) | 3 |
| `packages/model-stats/test/budget.test.ts` | +2 用例(C 族 N7 双 ready 双 gap 变体、D 族 P95=4200 方向钉)+用例标题措辞(Q 族) | 1/2 |
| `packages/model-stats/test/fixtures-real.test.ts` | 注释措辞(P 族) | 1 |
| `reports/POLISH-4-BATCH.md` | 本报告(新) | 3/5 |

## 1. 前置说明(红线口径)

- **零行为变更**:守卫/令牌/serve/调度/统计建议数值零触及;产品源码、
  package.json/lockfile、tauri 配置零触碰;测试改动=注释/用例标题措辞
  (P/Q 族)+新增用例(C/D 族),既有断言零改动、零跳过。
- 历史批次报告(M8-06 之前,含 POLISH-1/2/3.md、M8-03c-BATCH.md)原文
  零改动,其行号类残留按终审清单「明确不做」登记;M8-04/M8-06-BATCH 属
  本周期报告可直接修。
- USAGE.md 为现行使用文档(非冻结面、非历史报告),沿用 POLISH-3 就地
  修正先例。
- 验证=全量门禁(终态复跑)+单包门禁+冻结面校验(§5),文档措辞类改动
  逐处 diff/grep 实证(§2 对照表)。

## 2. 移交族逐条处置对照表

| 族 | 移交内容 | 处置 | 证据/落点(锚点式) |
|---|---|---|---|
| A | PROPOSALS M8-06 交付节与 M8-06-BATCH 前置说明的『唯一运行时行为变化=fetch 失配不再先写盘』 | **闭合**(两份文件改枚举式:运行时可见变化共三处——①fetch 失配不再先写盘;②tee.ts createUsageSink 入口校验收紧(空串/未知字段工厂即抛);③budget.ts 取整口径串字节变化) | 三处均经 M8-06 候选提交 diff 实证为该提交实改(tee.ts UsageSinkOptionsSchema strict min(1)+入口 parse;budget.ts method 串「the next 1000(-token bucket)」→「a multiple of 1000」),非虚构枚举 |
| B | M8-04-BATCH 三条目裸行号(「百分位方法」「建议口径字符串」「诚实边界」)+M8-06-BATCH 四处(budget.ts 变更清单行、§4 M7/M1 行、§3.2 PROPOSALS 哈希引用)+『:179 失实措辞』三处 | **闭合**(改函数名/字段名/口径串/节名+哈希引文锚:percentileNearestRank、P95/P50 口径串、HONESTY_BOUNDARY、requiredSampleCount 字段 JSDoc、MIN_SAMPLES_PER_MODEL 常量注释、PROPOSALS「治理披露:M8-05 交付」节「体积与可复算」小节+2defbf82… 哈希;失实措辞改「%TEMP% scratch」/「delete the scratch download」引文锚) | 锚名经 4fd2fa0 与现行文件双端核实指向同一目标;PROPOSALS 旧「:1395」引用已漂移(扫描时点 :1399),锚点必要性实证;M8-04-BATCH「budget.ts:187」亦已漂移(现 :198) |
| C | N7 决策词表断言改用双 ready+双 gap 输入(复用本批 M5 既有用例形状),使 regex 覆盖 suggestion 与 gap 两种对象的字面键名 | **闭合**(budget.test 新增变体用例:重建 M5 四模型输入,前置断言 ready+2 suggestions+2 gaps 后对 JSON.stringify(outcome) 跑同一词表 regex;原单 ready 用例原样保留) | 执行通过=gap 对象字面键(reason/observedSampleCount/requiredSampleCount)的序列化面无被禁词表键 |
| D | 补 P95=4200 用例(ceil→5000/round→4000,钉住向上取整方向) | **闭合**(新增用例:outputs 第 5 序位 4200,toBe(5000);4200 距 4000 为 200、距 5000 为 800,nearest 会得 4000) | 与既有 5500→6000、4000→4000、911→1000(fixtures-real)构成取整矩阵全覆盖 |
| F | M8-06-BATCH Summary『p npm test』笔误 | **闭合**(改 pnpm test) | — |
| G | §5『全量门禁终态』行证据指针『见 §7』失实 | **闭合**(改指 PROPOSALS『治理披露:M8-06 交付』节门禁退出码段) | §7 原文核对:仅载 CHECKSUMS/planning-check,无全量门禁终态记录 |
| H | 同 B 族 M8-06-BATCH 内 PROPOSALS 哈希引用 | **闭合**(见 B 族「体积与可复算」锚) | — |
| I | §2『全仓 grep 零残留』失实+§8 漏列 | **闭合**(§2 ADR 行改『reports/ 外零残留』;§8 第 6 条补列 M8-03c-BATCH 另两行并注明补列缘由) | grep reports/ 实证旧式 ADR 行号引用恰四行(:19/:23/:113/:117,原列仅 :23/:113) |
| J | §3.5 check-ignore 归属未标注 | **闭合**(标注 apps/desktop-shell/.gitignore) | — |
| K | §0 M8-04-BATCH 变更枚举漏两处取整措辞 | **闭合**(补「:13/:121 取整措辞×2 改『1000 的整数倍』口径」) | M8-06 候选提交该文件 diff 实证两处「1000 档」被改 |
| L | §0 两处时点行号偏差 | **闭合**(main.rs 首处改「:142-143」——引用跨两行注释;integration.rs 改「:31-38」) | 现行 main.rs 实读;integration.rs diff hunk(新文件新增行恰 :31-38) |
| M | PROPOSALS M8-04 披露节『向上取整 1000 档』残留 | **闭合**(改『向上取整到 1000 的整数倍』;冻结面,CHECKSUMS 同步,planning-check 过) | 同句其余部分未动 |
| N | 『ADR 行号引用改节名 10 处』计数失准 | **闭合**(M8-06-BATCH 两处+PROPOSALS 文档清理清单改『11 行(一处引用跨两行注释,按 hunk 归并为 10 处)』并写明口径) | git show M8-06 候选提交实证:main.rs 4 hunk/5 改行+Cargo.toml 1/1+PROPOSALS 5/5=10 hunk/11 行 |
| P | fixtures-real.test.ts『rounded up to the 1000 bucket』注释 | **闭合**(改『a multiple of 1000』) | 断言与既有钉串(method 串)零改动 |
| Q | budget.test.ts 用例标题『the 1000 bucket』 | **闭合**(同上) | 同上 |
| — | (E 族) | 移交 ask 未登记 E 族,无处置对象(如实记录) | — |

## 3. 实际执行的测试及退出码(按任务;全部本会话实跑)

| 检查 | 命令 | 退出 | 要点 |
|---|---|---|---|
| 冻结面(任务 1) | `node planning-check.mjs` | 0 | (a) 79/79(PROPOSALS 行重算后)+(b) 干净副本 self-test exit 0 |
| model-stats 套件(任务 1) | `pnpm --filter @role-orchestrator/model-stats run test` | 0 | 7 文件/68 tests(P/Q 措辞改动后) |
| model-stats 三门(任务 2) | `pnpm --filter @role-orchestrator/model-stats run typecheck / test / build` | 0/0/0 | test:7 文件/70 tests(budget 17→19,C/D 两新用例) |
| 冻结面(任务 3) | `node planning-check.mjs` ×2 | 0/0 | 锚点收口+CHECKSUMS 第二次同步后;两次实跑 |
| 全仓 typecheck(任务 5 终态) | `pnpm typecheck` | 0 | 59/59 FULL TURBO |
| 全仓 test(任务 5 终态) | `pnpm test` | 0 | 70/70 successful,FULL TURBO——任务 2 已对改动测试文件实跑重跑全绿,其后测试相关内容零变化(文档类改动非 turbo 输入);编排器第 4 阶段(任务 3 后、同一代码/测试状态)亦实跑全量四门通过,本行为终态复跑 |
| 全仓 build(任务 5 终态) | `pnpm build` | 0 | 35/35 FULL TURBO |
| 壳测试(任务 5 终态) | `cargo test --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 26+17+3 passed / 1 ignored |
| 冻结面(任务 5) | `node planning-check.mjs` | 0 | 交付节追加+CHECKSUMS 第三次同步后;(a) 79/79+(b) exit 0 |

## 4. 历批 POLISH 系列遗留扫描与终审清单

扫描来源:PROPOSALS「POLISH-1 发布后收尾批次」「POLISH-2 维护批次」「文档
勘误(POLISH-3 批次)」三披露节全文;reports/POLISH-1/2/3.md 全文;
reports/POLISH*-BATCH.md 不存在(ls 实证)。sweep:`grep -n "归属下批|归属后续|后续批|下批|另批|待维护者|维护者另批|归维护者" reports/*.md`
及 待/TODO/留待/unverified 补扫(含 HARDENING-1/2、M8-BATCH、M6/M7 系)。

### 4.1 本批已按锚点策略收口

1. PROPOSALS「POLISH-1 发布后收尾批次」披露节的 `repo-audit.test.ts` 裸行号
   引用 ×2(「:25」指 binaryFiles pin、「:28」指 `packages/browser-e2e/evidence/`
   前缀 reservation 断言;引文文本本就随后,行号经查已分别漂移至扫描时点
   的 :38 与 :46-48)→ 删行号、留引文锚。
2. USAGE.md「清理前后必须复核扫描计数」条的时点快照数与自引来源不符
   (scanned 1620/text 1091;所引 `reports/POLISH-1.md` 2026-09-26 实测为
   scanned 1622/text 1093,binary 529 一致)→ 对齐引源值。

### 4.2 closed-naturally(逐项核对现状)

1. POLISH-1 终审分级 #1、#9+#17、#3、#7、#15 → POLISH-2 批次关闭
   (PROPOSALS「POLISH-2 维护批次」披露节首句+POLISH-2 报告范围行)。
2. POLISH-1 #16(secrets-scan 注释精度)→ POLISH-3 D2;#1/#10(归因/时点)
   → POLISH-3 D3 勘误节。
3. M6-05 §6 十项待维护者确认 → 2026-09-28「仓库转公开」披露节记载
   「全部关闭」;第 4 项(真实 CLI 联调)转 M8-01 并已执行完毕。
4. HARDENING-1「风险与未验证项」第 1 条(release-audit 全审计用例默认
   5000ms 超时满载 flake,建议后续评估 testTimeout)→ 已自然闭合:该用例
   现带显式 20s 预算(repo-audit.test.ts「secret scan: verdict is
   known-reservations-only…」用例 `{ timeout: 20_000 }` 实测在位),且
   M8-05 第 1 次返修将 cargo `target` 加入 secrets-scan 默认
   excludeDirNames 消除满载磁盘争用根因,M8-05/M8-06 满载全量复绿。
5. PROPOSALS「发布前文档收口」节裸「当前 1523/34/35/84 计数」→ POLISH-3
   勘误节第 2 条确立「该节日期时点值」读法;勘误所述位置未漂移。
6. USAGE.md §8 快照值随 evidence 再生浮动 → 设计内(POLISH-3 报告
   「风险与边界」节已披露;pin 由不可修改测试钉住)。
7. PROPOSALS「Linux 环境配平」披露节「VERIFICATION.md 第 9 行」引用 →
   VERIFICATION.md 冻结未动,该行即所述「机器可读结果由 …--json-output
   validation-report.json」行,引用未漂移。

### 4.3 终审清单(剩余维护态 minor 全量盘点 + 每条处置/归属)

| # | 项 | 来源(锚点定位) | 处置 | 归属 |
|---|---|---|---|---|
| 1 | secrets-scan 默认 excludeDirNames 增 `.zcode`(gitignored 工具目录,与 node_modules 同类) | PROPOSALS「POLISH-2 维护批次」披露节「备案(不在本批次实施)」条 | 需代码+独立治理披露(扫描语义变化,超本批授权面;源码默认表现无 `.zcode` 实证) | 后续经审查批次(维护者立项) |
| 2 | codex input_tokens 是否已剔除 cached 份额 | model-stats README「TODO(M8-04 审查移交 M8 族…留待后续批澄清)」注记;M8-06-BATCH §2「归属后续批」行 | 需真实样本采集(澄清前不改任何口径串文本) | 后续批(M8-01 式真实 CLI 窗口) |
| 3 | tee 生产接线(sink 装配进 StartExecution 链) | M8-04-BATCH「未验证项」第 1 条;M8-06-BATCH §2「归属维护者另批」行 | strict 契约入参属行为变更,需批准 | 维护者另批 |
| 4 | desktop-shell 维护者冒烟清单全集:双击 GUI 向导安装、真窗交互(托盘/关闭隐藏/导航拒绝提示)、真正干净 Windows 端到端、WebView2 在位率抽样与引导安装路径、capability_probe 运行层探针异机回填(本验收机 STATUS_ENTRYPOINT_NOT_FOUND 阻塞,M8-03b 起)、内存占用回填、发布形态 stderr 句柄退化行为 | desktop-shell README「当前 unverified(维护者冒烟清单)」节;capability_probe 单项在 M8-06-BATCH §2 四行归属未单列,本清单显式补登 | 归维护者冒烟/异机实测并回填 | 维护者 |
| 5 | M8-01 矩阵仍 unverified 平台项(A31 Hardened、双账号隔离、WSL1/WSL2 内 CLI、macOS/Linux、其他 Windows 构建) | PROPOSALS「M8-01 真实 CLI 受控联调窗口执行完毕」节「仍 unverified 的项」句 | 均有明确原因、非单窗口可闭合 | 维护者后续窗口/矩阵验证 |
| 6 | M7 系后续提案:P-M7-01-A 真实 SCM adapter、P-M7-01-B merge/close/delete 维度映射、P-M7-02-A 插件加载器、P-M7-02-B manifest 签名与发布者身份,及真实 provider/插件 smoke 窗口授权 | reports/M7-01-scm-integration.md「待维护者确认 / 后续提案」节、reports/M7-02-plugin-tool-registry.md 同名节 | 未立项;设计-only 立场(HARDENING-1「仅设计(未实现)」条与 M7-04 一致) | 维护者里程碑裁量(提案,非缺陷) |
| 7 | BudgetRefinement 建议采纳 | M8-04-BATCH「建议非策略;采纳需维护者批准,另批处理」边界 | 常设策略边界,非缺陷 | 维护者策略决定 |
| 8 | M6-01 探针「更轻的按 PID 过滤查询」替代方案 | reports/M6-05-release-candidate.md「reconcile 真实探针测试负载敏感」条(待维护者裁量) | 明确不做:显式 20s 预算方案在位且有量化余量,M8-05/M8-06 满载全绿,改动无增益 | 维护者如不同意可另批重启 |
| 9 | 已停跑 label 的 evidence 历史目录一次性清理 | POLISH-1 报告「风险与边界」节(按 label 前缀轮转不自动收缩停跑 label) | 可选手工动作(清理前后按 USAGE §8 守则复核三项计数) | 维护者(如需) |
| 10 | 仓库内直跑 `validate_bundle.py --self-test` exit 1(node_modules 第三方文档断链) | AGENTS.md 检查命令段;PROPOSALS「Linux 环境配平」披露节 (b)「已知保留问题不变」 | 明确不做:已知登记问题;planning-check 第 (b) 步干净副本为设计内运行方式 | 无(设计内) |
| 11 | 本周期报告残留单行级(移交族 B 族点名范围外,本扫描观察到、未改):M8-04-BATCH「tee 侧口径」条目的 persistence.ts 裸行号与 tee.ts 双时期行号;M8-04-BATCH 风险节「(1000/1000 档)」与推导索引「P95 rank 5=911→1000 档」旧式措辞;PROPOSALS M8-04 披露节「P95 911→1000 档」数值陈述;M8-06-BATCH「.gitignore」条「planning-check.mjs:61」及 §0 其余时点行号 | 各报告对应文本锚 | 归属下个文档批锚点化/口径统一(单行级;如无下批,维护者裁定接受为时点快照) | 下个文档批 / 维护者裁定 |
| 12 | 历史快照行号引用不改:reports/POLISH-1.md(「repo-audit.test.ts:25」「:27-28」两处)、reports/POLISH-3.md(D1 表「repo-audit.test.ts:32」、「PROPOSALS.md:453」引文、「HEAD:PROPOSALS.md 第 848–877 行」git 事实陈述)、reports/M8-03c-BATCH.md(旧式 ADR 行号四行,以「集成不变式第 66/67 行」文本可锚定) | 各报告原文 | 明确不做:红线禁改 M8-06 之前历史报告原文;各引文自带锚文本、内容未被证伪;如维护者要求统一,沿 POLISH-3 勘误小节先例另批勘误 | 维护者裁定(默认维持) |

## 5. 治理与冻结面同步

- CHECKSUMS.sha256 PROPOSALS 行三次按盘上 LF 字节重算:基线 31ab08c3… →
  任务 1 a9cd18f8… → 任务 3 31f821a6… → 任务 5 6c88b481…;全程 CR=0
  (每次改动后 python 实测 CR 计数为 0)。
- docs/BACKLOG.md、project/backlog.json 已于立项提交(b5e383b)同步,本批
  未再动;USAGE.md、reports/* 非冻结面。
- PROPOSALS.md 新增节:治理披露:POLISH-4 交付(2026-09-30)。
- git add 纪律:显式路径清单八文件、零 -A;无 push、无历史改写。

## 6. 未验证项/归属(汇总)

1. 「此前盘点约 12 项」原始清单在仓库内不可逐字复得(仅工作流脚本转述
   USAGE 快照锚定/前向指针/行号类三类);扫描按三类为纲重建,超出三类
   的原盘点单项可能未被覆盖。
2. M6/M7 系「待维护者确认」项按「仓库转公开披露 M6-05 §6 十项全部关闭」
   整体判定闭合,未逐报告逐项复核与 M6-05 §6 清单的映射;「M7 四提案
   未立项」为负面证据判定(grep 无对应批次交付),非维护者确认。
3. 终审清单第 11 条(本周期报告残留单行级)与第 12 条(历史快照行号)
   本批未改,归属/理由见清单;HARDENING-1 flake「自然闭合」依据是显式
   20s 预算在位+满载复绿的在案记录,未追溯该预算的具体入账提交。
4. 全仓 test/build 终态为 FULL TURBO 缓存命中(测试相关内容自任务 2 实跑
   全绿后零变化;文档类改动非 turbo 输入);全量四门在文档追加前另由编排
   器第 4 阶段对同一代码/测试状态实跑通过。model-stats 单包实跑记录在
   任务 2(7 文件/70 tests)。
5. 候选提交后的冻结面终验按工作流收口路径由编排器复跑 planning-check。
