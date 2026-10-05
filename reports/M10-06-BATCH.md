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

## 3. 任务 2:托盘加固收口(交接清单第 1 项,2026-10-06)

对 apps/desktop-shell/README.md『当前 unverified(维护者冒烟清单)』12 项中
属托盘/真窗交互者逐项处置:可自动化证据本机实跑,真窗交互如实降级。
自动化冒烟一律显式 `--db` 指向临时目录(零触碰用户数据
%LOCALAPPDATA%\role-orchestrator\);serve 经定位链 ② 命中
target\debug\serve-bundle.mjs + node-runtime\node.exe(dev 遮蔽现状,
README「dev cargo run 遮蔽」节既有记载)。

### 3.1 自动化冒烟证据(脚本:powershell -File,exit 0;输出逐行如下)

| # | 步骤 | 实测结果 |
|---|---|---|
| E0 | 基线孤儿核查 | 扩展模式(serve-bin/serve-bundle/ro-shell-fake)= 0;README 原双模式 = 0 |
| E1/E2 | 起壳(显式临时 --db)→ 进程链+端口发现 | 壳 pid 72256;serve 子进程 pid 104152,命令行 `"…node-runtime\node.exe" …serve-bundle.mjs --db <临时>\smoke.db --port 0 --profiles <约定路径>`(argv 8 元素、无 shell、无任何令牌旗标);监听端口 65432(Get-NetTCPConnection 按 listen 进程发现) |
| E3 | HTTP 探测 | `GET http://127.0.0.1:65432/` = **200**;无凭据 `GET /api/v1/session` = **403**(凭据不变式) |
| E4 | 窗口存在性 | MainWindowTitle = **"Role Orchestrator"**,MainWindowHandle 非 0;WebView2 子进程 ≥1 |
| E5 | 关闭拦截(WM_CLOSE 程序化等效路径,非真实 X 点击) | SendMessage(hwnd, WM_CLOSE) → 2 秒后:壳存活=True、原 hwnd IsWindowVisible=**false**(已隐藏非销毁)、serve 存活=True——main.rs:578-580 CloseRequested→prevent_close+hide 的运行期行为实证 |
| E6 | 外部强杀兜底(KILL_ON_JOB_CLOSE) | `Stop-Process -Force` 杀壳 → **4 秒预算内**孤儿计数=0(reapedWithin4s=True);README 原双模式亦=0 |
| E7 | 清理与终态 | 临时目录移除;终态孤儿=0 |
| 补 | 运行层 capability 探针复测 | `RO_SHELL_PROBE=1 cargo run --example capability_probe` → **0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND**(与 M8-03b 记载的本机阻塞一致,如实复现) |
| 补 | 仓库自带集成测试 | `RO_SHELL_INTEGRATION=1 cargo test --manifest-path apps/desktop-shell/Cargo.toml -- --ignored` → spawned_serve_child_reaches_local_api_over_loopback **1/1 ok**,跑后孤儿=0 |

### 3.2 逐项处置(12 项)

| 项 | 处置 | 说明 |
|---|---|---|
| 1 真实 WebView 窗口加载 | **部分闭合** | 自动化证据收口(进程链/端口/200/403/窗口标题/WebView2 子进程);降级剩余:页面渲染人眼可视确认+0.3.0 安装布局复核 |
| 2 WebView2 在位率 | 未动(非托盘面) | 本机已实测(M8-03b);剩余属发布期抽样 |
| 3 capability 运行层 | **降级(复核)** | 2026-10-06 复测仍 0xc0000139 本机阻塞,措辞已登记复测日期 |
| 4 release stderr 退化 | 未动(非托盘面) | 维持既有「顺延为后续任务」 |
| 5 导航拒绝壳内提示 | **降级(措辞精确化)** | 触发需真窗 DevTools,headless 不可行——机制层(on_navigation+端口精确匹配)单测覆盖不变 |
| 6 包体积 | 未动(非托盘面) | 维持已回填状态 |
| 7 强杀兜底树杀 | **闭合** | 本机进程级实证(Stop-Process -Force → 4s 内孤儿 0) |
| 8 WebView2 引导安装 | 未动 | 外部写入,归维护者 |
| 9 内存占用 | 未动(非托盘面) | 未采集(不虚报) |
| 10 真窗托盘交互 | **部分闭合** | WM_CLOSE 拦截路径实测(隐藏+双进程存活);降级剩余:托盘图标显示/菜单弹出/三项菜单点击/双击恢复/真实 X 点击——真窗点击类不可自动化 |
| 11 提示观感/排队 | **降级(措辞精确化)** | 同第 5 条 headless 不可行 |
| 12 安装包 | 未动+v0.3.0 标注 | 静默路径复核随任务 3 重打执行;GUI 向导/干净机仍归维护者 |

### 3.3 冒烟清单精度修正(随本任务)

README 孤儿核验命令两处(冒烟步骤 4/集成测试节)由双模式
`(serve-bin[.]js|ro-shell[-]fake)` 扩为三模式(增 `serve-bundle[.]mjs`)
——bundle 布局 serve 进程命令行含 serve-bundle.mjs,原模式对其不匹配;
本批自动化冒烟的 serve 即 bundle 形态(E2 命令行实证),漏配会使 bundle
布局的泄漏假阴性。README 冒烟清单头节改标 v0.3.0 口径+2026-10-06 更新。

## 4. 变更文件清单

任务 1(7 文件):docs/ORCHESTRATION.md、project/LICENSING.md、
AGENTS.md、project/backlog.json、packages/local-api/test/diff-view.test.ts、
CHECKSUMS.sha256(四行重算:AGENTS/ORCHESTRATION/LICENSING/backlog.json)、
本报告。
任务 2(2 文件):apps/desktop-shell/README.md(冒烟清单 v0.3.0 化+证据
登记+核验命令模式修正;apps/desktop-shell 不入冻结面,CHECKSUMS 零影响)、
本报告。后续任务增补。

## 5. 测试及退出码(2026-10-06 本会话实跑)

任务 1:

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 冻结面门禁(提交前) | node planning-check.mjs | (a) 79/79 匹配+(b) 干净副本 self-test passed(schemas 7/localLinksChecked 145/backlogItems 61/selfTestsPassed 37) | 0 |
| 冻结面门禁(提交后复跑) | node planning-check.mjs | 同上 | 0 |
| diff-view 隔离确认(仅注释变更) | cd packages/local-api && npx vitest run test/diff-view.test.ts | 8/8 | 0 |

任务 2:

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| **批门禁(ask 指定)** | cargo test --manifest-path apps/desktop-shell/Cargo.toml | 32 lib+19 main+3 source_invariants=**54 passed 0 failed**,1 ignored(集成按设计默认不跑) | 0 |
| 自动化冒烟 | powershell -NoProfile -ExecutionPolicy Bypass -File <临时脚本> | §3.1 证据表 E0-E7 全过 | 0 |
| capability 探针复测 | RO_SHELL_PROBE=1 cargo run --example capability_probe | 0xc0000139(本机已知阻塞如实复现,非回归) | 非 0(0xc0000139) |
| 集成测试(补证) | RO_SHELL_INTEGRATION=1 cargo test --manifest-path apps/desktop-shell/Cargo.toml -- --ignored | 1/1 ok,跑后孤儿=0 | 0 |

## 6. 未验证项

任务 1:

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

任务 2(§3.2 降级项归维护者冒烟,此外):

5. WM_CLOSE 程序化等效路径与真实鼠标点击 X 按钮在消息层等价
   (WM_CLOSE 即系统对 X 的标准派发),但「真实点击」的人眼确认仍在
   维护者清单(条目 10)。
6. 本机冒烟为 debug dev 布局(定位链 ② 命中 target 副本);安装布局
   (0.3.0 重打后)的同证据链复核随任务 3 执行。
7. capability 探针的非 0 退出属本机已知加载器阻塞的如实复现,不记为
   门禁失败;其运行层证据仍需无此问题的机器(条目 3)。
后续任务增补。
