# M8-06 批次报告:壳与统计包维护清理(任务 1 脚本/构建加固 + 任务 2 测试补充 + 任务 3 历批文档措辞 + 第 1 次返修 + 候选收口)

日期:2026-09-30。开发者会话交付 BACKLOG M8-06(第 50 项)范围全部三块
(脚本/构建加固、测试补充、历批文档措辞)与第 1 次返修。立项与验收原文见
docs/BACKLOG.md「M8-06 · 壳与统计包维护清理」;治理披露见 PROPOSALS.md
2026-09-30 的 M8-06 各节(立项 / 第 1 次返修 / 交付)。本报告不在 CHECKSUMS
冻结面。

## 0. Summary

四块全交付:①脚本/构建加固——fetch-node-runtime 失配**先比对后写盘**
(零落盘 fail-closed,假钉值端到端实证)+ 失实注释/错误消息按实现改写;
bundle-serve 钉 esbuild absWorkingDir(钉前实测三 cwd 三哈希,钉后任意
cwd 复现 M8-05 基线 2defbf82…/1,347,146 B);turbo build outputs 否定
glob(缓存载荷 39→38 文件零 serve-bundle,命中不清盘);.gitignore 补
.git-commit-msg*;desktop-shell README 补新克隆前置(exit 101 实证)与
dev cargo run 遮蔽(字节级实验实证)。②测试补充 7 项——model-stats
64→68、engine usage-tee 4→5,全部先按实现核验再落笔(N7 先以构建产物
实跑确认现行输出可通过)。③历批文档措辞——desktop-shell README 四处、
ADR 行号引用改节名 10 处、integration/source_invariants 注释、两份 BATCH
报告、PROPOSALS 三处,逐处实证后改写。④第 1 次返修——ws-backpressure
采样密度抗满载加固(断言零改动,全量复跑 70/70 绿)。
**行为语义零变化**(§1);终态门禁:p npm test 70/70 exit 0、cargo test
(desktop-shell) exit 0、model-stats typecheck/test/build 全 0、
planning-check exit 0。本提交即 M8-06 批次候选提交(候选链 42fc826→本提交)。

### 变更文件清单(本批全部,工作树 → 本提交)

| 文件 | 变更 | 任务 |
|---|---|---|
| `scripts/fetch-node-runtime.mjs` | +21/−8:钉值比对前置(失配 exit 1 零落盘)+ :32/:179 失实措辞按实现改写 | 1 |
| `packages/local-api/scripts/bundle-serve.mjs` | build() 增 absWorkingDir=包根 + 根因注释(产物 cwd 无关) | 1 |
| `turbo.json` | build.outputs `["dist/**"]` → `["dist/**","!dist/serve-bundle.mjs"]` | 1 |
| `.gitignore` | 末尾增 `.git-commit-msg*` + 注释(防 fa4f0f5 复发) | 1 |
| `apps/desktop-shell/README.md` | 构建节增「纯新克隆前置」「dev cargo run 遮蔽」;84→111;spawn 句改定位链口径;主 exe 8,955,904;四###合并 | 1+3 |
| `packages/model-stats/src/budget.ts` | :278 口径串「a multiple of 1000」+:101 注释;:124 requiredSampleCount 真实语义;:38-43 MIN_SAMPLES 真实不变量 | 2 |
| `packages/model-stats/src/tee.ts` | UsageSinkOptionsSchema min(1) strict + createUsageSink 入口即 parse | 2 |
| `packages/model-stats/test/budget.test.ts` | +3:N7 词表恢复 / M5 双 ready+双 gap 排序 / M6 整倍数;钉串同步 | 2 |
| `packages/model-stats/test/tee.test.ts` | +1:空串归属入口拒绝(store.size===0) | 2 |
| `packages/model-stats/test/fixtures-real.test.ts` | 钉串同步(a multiple of 1000) | 2 |
| `packages/model-stats/README.md` | 取整口径「1000 的整数倍,整倍数原值保留」 | 2 |
| `packages/engine/test/usage-tee.test.ts` | +1:A36 tee 行 vs 落库行同脱敏对照 | 2 |
| `packages/local-api/test/ws-backpressure.test.ts` | +18/−4:采样双条件退出(≥40 样或 2s)+ afterAll 60s;断言零改动 | 返修 1 |
| `apps/desktop-shell/Cargo.toml` | :27 ADR 行号→节名 | 3 |
| `apps/desktop-shell/src/main.rs` | ×4 ADR 行号→节名(:143/:163/:409/:425) | 3 |
| `apps/desktop-shell/tests/integration.rs` | :30-36 注释改 CARGO_MANIFEST_DIR 实际口径 | 3 |
| `apps/desktop-shell/tests/source_invariants.rs` | :3 「五个源文件」→「SOURCES 清单所列」(不写死计数) | 3 |
| `reports/M8-04-BATCH.md` | MIN_SAMPLES 算术×2 改真实不变量;:132 行号改函数名+双时期 | 3 |
| `reports/M8-05-BATCH.md` | :49 验收行刷新为已验口径;:118 「+27=esbuild 1+@esbuild/* 26」 | 3 |
| `PROPOSALS.md` | MIN_SAMPLES 算术修正;importers 36→35;.git-commit-msg 限定;ADR 行号→节名×5;M8-06 返修披露节;M8-06 交付披露节 | 3+5 |
| `CHECKSUMS.sha256` | .gitignore 行、PROPOSALS 行 ×2 次按盘上 LF 字节重算 | 1+3+5 |
| `reports/M8-06-BATCH.md` | 本报告(新) | 5 |

## 1. 前置说明(红线口径)

- **本批零行为变更**:守卫/令牌/serve/调度/统计建议数值零触及;
  `tauri.conf.json` resources 声明未动;npm 外部依赖恰 111 零增减
  (零 package.json/lockfile 改动)。唯一运行时行为变化 =
  fetch-node-runtime 失配时不再先写盘(fail-closed 增强,M8-06 立项范围
  明示允许);其余变更面 = 构建期脚本、turbo 缓存编排、.gitignore、
  注释/文档措辞、测试(新增+基建加固)。
- **验证 = 全量门禁 + 新增测试**(§5),文档措辞类改动逐处 grep/python
  核验(各任务节)。

## 2. 逐族 minor 处置对照表

| 族/项 | 来源 | 处置 | 证据 |
|---|---|---|---|
| fetch-node-runtime 比对前置(fail-closed) | M8-05 审查移交 | **闭合** | §3.1 假钉值 e2e 零落盘 |
| fetch-node-runtime :32/:179 失实措辞 | M8-05 审查移交 | **闭合** | 按实现改写(全程内存持有 zip,无 %TEMP%) |
| bundle-serve 产物 cwd 敏感 | M8-05 审查移交 | **闭合** | §3.2 钉前三哈希/钉后基线复现 |
| turbo 缓存携带/清掉 serve-bundle.mjs | M8-05 审查移交 | **闭合** | §3.3 manifest 38 文件零命中 |
| .git-commit-msg* 入库面 | M8-05 审查移交(fa4f0f5) | **闭合** | .gitignore 模式 + PROPOSALS 限定语 |
| 新克隆 cargo 构建前置失登记 | M8-05 审查移交 | **闭合** | exit 101 实测 + README 四步链 |
| dev cargo run 遮蔽失登记 | M8-05 审查移交 | **闭合** | 字节级实验(sidecar→target 副本同变) |
| N7 决策词表 outcome 级断言 | M8-04 审查移交 | **闭合** | 先以 dist 实跑确认可通过再恢复;budget.test 17 tests |
| M4 A36 tee 对照 | M8-04 审查移交 | **闭合** | 嵌套密文 tee 行=落库行,实现无缺口 |
| M5 双 suggestion/双 gap 排序 | M8-04 审查移交 | **闭合** | 乱序输入规范序+反转 deep-equal |
| M6 取整措辞与整倍数 | M8-04 审查移交 | **闭合** | 「a multiple of 1000」+ P95 4000→4000;README/BATCH 同句同步 |
| N3 attribution 入口早校验 | M8-04 审查移交 | **闭合** | min(1) 入口即抛;空串 store.size===0 |
| M7 requiredSampleCount 注释 | M8-04 审查移交 | **闭合** | 真实语义(floor 类 vs eventCount 类) |
| M1 MIN_SAMPLES 推导算术 | M8-04 审查移交 | **闭合** | 真实不变量(node 枚举 n=1..30);阈值 5 未动 |
| README 84→111 / spawn 句 / 主 exe 体积 / 四### | M8-05 审查移交 | **闭合** | task 3 四处,python UTF-8 核验 |
| ADR 行号引用(66/67) | M8-03c 移交家族 | **闭合**(在位引用 10 处改节名;历史快照不改) | 全仓 grep 零残留;现行 ADR :66-67 实为令牌流条目,节名引用消除漂移 |
| integration.rs :32-33 exe 目录口径 | M8-04/05 审查移交 | **闭合** | CARGO_MANIFEST_DIR 实际语义 |
| source_invariants.rs :3 计数写死 | M8-04/05 审查移交 | **闭合** | SOURCES 清单口径 |
| 两份 BATCH 陈旧行(M8-05 :49/:118;M8-04 :85-86/:113-114/:132) | 本周期报告可直接改 | **闭合** | 已验口径/+27 精确化/真实不变量/函数名行号 |
| PROPOSALS 三处精度 | M8-06 立项其三 | **闭合** | MIN_SAMPLES/importers 35(实测)/.git-commit-msg 限定 |
| codex input_tokens 口径澄清(M8 族 TODO) | M8-04 登记移交 | **归属后续批** | model-stats README TODO 注记在位(M8-05 落地);澄清需真实样本采集 |
| 双击 GUI 向导/真窗交互/真正干净 Windows 端到端 | 历批 unverified | **归属维护者冒烟** | desktop-shell README unverified 清单 |
| tee 生产接线(sink 装配) | M8-04 unverified | **归属维护者另批** | strict 契约入参属行为变更,接线需批准 |
| 内存占用回填/stderr 管道化 | M8-03 系 unverified | **归属维护者/后续任务** | 原 unverified 清单未动 |
| M8-03c-BATCH:23/:113 旧式 ADR 行号引用 | (触及项关联) | **不改(历史快照);判定无需勘误行** | ADR 内容未变,历史陈述不被证伪;POLISH-3 先例仅在证伪时启用 |

## 3. 脚本/构建加固明细(任务 1,实测记录)

1. **fetch-node-runtime.mjs**:钉值比对移至 writeFileSync 之前——假钉值
   (64×'a')端到端:重下 37,531,403B zip → SHASUMS256 验过(929552b8…)→
   解出 98843732… ≠ 假钉 → exit 1「nothing was written to disk」,
   node.exe mtime/size/sha256 三元组逐项不变(零落盘);钉值复原后幂等
   重跑 exit 0(mtime/size 不变 = 零写盘)。:32「%TEMP% scratch」与
   :179「delete the scratch download」均按实现改写(实现全程内存持有
   zip,从不落盘临时文件)。「首下」与 SHASUMS 层失配注入未重演(逻辑
   零改动,M8-05 已验三路径)。
2. **bundle-serve.mjs**:钉前实测证实敏感——同一 dist 输入三 cwd 三哈希
   (基线 2defbf82…(包目录)/仓库根 8bae06f4…/C:\ f78eec5e…),根因 =
   esbuild 把模块路径内嵌进产物(__commonJS 键与 // 注释),基准缺省 =
   调用方 cwd;钉 absWorkingDir=包根后,标准调用与 C:\ 直跑均精确复现
   M8-05 基线 2defbf8241…/1,347,146 B(「钉后不变」,且证明 dist 输入
   自 M8-05 未变);sidecar 同哈希零漂移;PROPOSALS:1395 引用的哈希即
   该值,披露保持为真无需改写。
3. **turbo 缓存**:官方文档确认 outputs 否定 glob 后实证——清 .turbo/cache
   (6378 文件)→ pnpm build 全 miss 35/35 exit 0 → 新 local-api 条目
   366454aae9f74b4a:manifest 38 文件(旧 39)零 serve-bundle、
   tar.zst 解包 grep 计 0、dist/serve-bin.js 仍在;复跑 35/35 cached
   (FULL TURBO)且 serve-bundle.mjs mtime/哈希不变(命中不清盘)。方案
   选择否决 bundle:serve 任务化(改变 build 管道语义,超授权面)与
   sync-shell-sidecar 新鲜度校验(治标,防不住命中清盘本身)。
4. **.gitignore**:增 `.git-commit-msg*` + 注释;CHECKSUMS .gitignore 行
   LF 重算(planning-check 对该行显式跳过且允许修订,planning-check.mjs:61)。
5. **desktop-shell README**:新克隆前置——bundle.resources 两资源均不入库
   (check-ignore 实证 .gitignore:10/:14),任何 cargo 构建经 tauri-build
   校验+复制;实测移走 node.exe → cargo check **exit 101**
   `resource path 'node-runtime\node.exe' doesn't exist`,放回 exit 0;
   给出前置四步(=五步链前四步)。dev 遮蔽——tauri-build 复制资源到
   target/debug(本机在位实证),dev cargo run 命中定位链②优先于③;
   字节级实验:sidecar 改 1 字节 → cargo build → target 副本同变
   (2defbf82…→2d711642…),复原→复建复原;写明解除方法。

## 4. 测试补充清单(任务 2,先核验后落笔)

| 项 | 内容 | 核验方式 |
|---|---|---|
| N7 | outcome 决策词表断言恢复(budget.test) | 先以构建产物 dist/budget.js 实跑:ready/insufficient 两态现行输出均通过正则,再恢复为钉死用例 |
| M4 | A36 tee 对照(usage-tee.test +1) | 嵌套 {Authorization:"Bearer sk-xyz-secret-value"} → 落库行与 tee 行均「Bearer [REDACTED]」零密文,JSON.parse(teeLine) deep-equal 落库 usage(『tee 所见=表中所存』钉死;实现无缺口,未改脱敏逻辑) |
| M5 | 双 ready+双 gap 排序(budget.test +1) | zeta/alpha ready + poor/ghost gap 乱序输入 → suggestions ["alpha","zeta"]、gaps ["ghost-model","poor-model"],数组反转 deep-equal |
| M6 | 取整措辞+整倍数(budget.test +1) | P95=4000→4000(sorted rank5=4000 不进位);口径串改「rounded up to a multiple of 1000」 |
| N3 | 入口早校验(tee.ts + tee.test +1) | UsageSinkOptionsSchema(zod strict,min(1))工厂入口即 parse;空串 claude/codex 各 toThrow 且 store.size===0;未知字段同拒;全仓调用方核查零破坏 |
| M7 | requiredSampleCount 注释(budget.ts:124) | floor 类给 MIN_SAMPLES、mismatch 类给声明 eventCount(ready 性质=observed===declared) |
| M1 | MIN_SAMPLES 推导(budget.ts:38-43;README/BATCH/PROPOSALS 同句) | node 枚举 n=1..30:rank=⌈0.95n⌉,n≤19 恒=n(P95 即最大值),n=20 起 rank 19=次大;旧句「n=5 起 P95 与 P50 才不同」错误(n=2 起即不同);阈值 5 未动 |

计数:model-stats 套件 64→68(budget 14→17、tee 5→6);engine usage-tee
4→5(套件 30→31)。

## 5. 实际执行的测试及退出码(按任务;全部本会话实跑)

| 检查 | 命令 | 退出 | 要点 |
|---|---|---|---|
| 壳单测+不变式 | `cargo test --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 26+17+3=46 passed/1 ignored(集成 env 门控);任务 1、3(注释改动后复验)、返修前基线各跑一次均 0 |
| local-api 套件 | `pnpm --filter @role-orchestrator/local-api run test` | 0 | 20 文件/206 tests(任务 1;返修后全量复跑中同套件再绿) |
| 冻结面 | `node planning-check.mjs` | 0 | a 79/79(.gitignore 行跳过)+ b exit 0;每次 CHECKSUMS 同步后跑(共 4 次) |
| turbo 全量构建 | `pnpm build`(清 .turbo/cache 后) | 0 | 35/35 miss;复跑 35/35 cached 且 serve-bundle.mjs 存活 |
| 缺资源两态 | `cargo check`(node.exe 移走/放回) | 101/0 | README 前置说明实证 |
| fetch-node-runtime 幂等 | `node scripts/fetch-node-runtime.mjs` | 0 | mtime/size 不变;假钉值 e2e = exit 1 零落盘 |
| bundle:serve 双 cwd | `pnpm --filter … run bundle:serve` 与 `cd C:\ && node …` | 0/0 | 钉后均 = 2defbf82…/1,347,146 B |
| model-stats 门禁 | `pnpm --filter @role-orchestrator/model-stats run typecheck / test / build` | 0/0/0 | test:7 文件/68 tests;verbose 单列新测试 4 条全过 |
| engine 套件 | `pnpm --filter @role-orchestrator/engine run test` | 0 | 5 文件/31 tests(含 M4 新用例,verbose 单跑过) |
| N7 预检 | node 对 dist/budget.js 注入正则 | — | ready/insufficient 两态均通过(现行输出无词表键) |
| M1 不变量 | node 枚举 rank(0.95,n) n=1..30 | — | n≤19 恒=max;n=20 rank19=次大 |
| lockfile importer 计数 | python 解析 pnpm-lock.yaml | — | 36 importer 中恰 35 含 esbuild@0.28.2 因子 |
| ws-backpressure 隔离 | `pnpm exec vitest run test/ws-backpressure.test.ts` | 0 | 修复前隔离 2/2 绿(定性负载敏感);修复后 2/2 绿 |
| **全量门禁** | `pnpm test`(返修复跑) | **0** | **70/70 successful**;local-api#test 实跑 206/206 |
| **全量门禁终态** | `pnpm test`(候选收口前终跑) | 见 §7 | 本提交前最后实跑 |

## 6. 第 1 次返修记录

全量门禁首跑 pnpm test 失败(唯一失败 local-api#test;审计套件全绿——
**审计计数断言零失败,审计面零改动**,git diff 实证)。三例全在
ws-backpressure.test.ts 且单根因级联:采样循环纯墙钟 600ms+10ms sleep,
满载(transform 42.94s/import 68.30s)实测 ~37ms/迭代 → 16 样 < 20 →
测试在 client.close() 前中止 → 被遗弃暂停连接把 server.close() 拖过
10s hook 预算 + 下一用例静默前置不满足。修复(断言零改动):采样改
「≥40 样或 2s 截止」双条件 + afterAll 显式 60s。隔离 2/2 绿;全量复跑
70/70 exit 0。详见 PROPOSALS「治理披露:M8-06 第 1 次返修」节。

## 7. 治理与冻结面同步

- CHECKSUMS.sha256 同步三次:.gitignore 行(任务 1)、PROPOSALS 行
  (任务 3)、PROPOSALS 行(任务 5 返修披露+交付披露;LF 字节全程
  CR=0);planning-check 每次同步后实跑均 exit 0。
- PROPOSALS.md 新增节:治理披露:M8-06 立项(立项提交)、M8-06 第 1 次
  返修、M8-06 交付(本提交)。
- git add 纪律:显式路径清单(§0 清单逐文件),零 -A;无 push、无历史
  改写。

## 8. 未验证项/归属(汇总)

1. codex input_tokens 是否已剔除 cached 份额——M8 族 TODO 注记在位,
   澄清需真实样本采集,归属后续批(README TODO 文本零改动原则维持)。
2. 真正干净 Windows 机器端到端、双击式 GUI 向导、真窗交互(托盘/关闭
   隐藏/导航拒绝提示)——归维护者冒烟(desktop-shell README unverified
   清单;本批仅实证首个失败点 exit 101 与前置四步正确性)。
3. fetch-node-runtime「首下」与 SHASUMS 层失配注入未重演(逻辑零改动,
   M8-05 已验);NSIS 重打未执行(bundle 产物字节零漂移,无触发面)。
4. turbo 否定 glob 远程缓存形态未验(本仓无远程缓存,本地已实证)。
5. 内存占用回填/stderr 管道化/tee 生产接线——维持原归属(维护者冒烟/
   另批/后续任务)。
6. M8-03c-BATCH:23/:113 旧式行号引用不改(历史快照);如维护者希望
   统一,沿 POLISH-3 先例另行勘误批处理。
