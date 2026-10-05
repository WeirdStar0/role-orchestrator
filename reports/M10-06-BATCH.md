# M10-06 批报告——v0.3.0 发布批(审查承接/托盘收口/端到端演练/版本抬升)

> 日期:2026-10-06 起。历批同口径:本报告不入冻结面;随批次任务逐节增补,
> commits 链存在结构性缺口(条目自身及所在提交哈希写入时不可知),候选
> SHA 以 git log 为准(沿历批教训不在文内写死)。

## 1. Summary

按 reports/M10-05-BATCH.md §9 交接清单与 docs/BACKLOG.md M10-06 行执行。
任务 1=M10-05 十轮审查六条 minor 承接(§2);任务 2=托盘加固收口——
README 冒烟清单可自动化证据本机收口、真窗交互逐项降级(§3);任务 3=
v0.3.0 版本抬升+CHANGELOG/发布说明草稿+新 NSIS 安装包+安装面端到端
演练(§4,含阶段 5 全量门禁自动面);任务 5=治理披露(PROPOSALS 同日节/
BACKLOG 完成标记/backlog.json deliveryNotes 终态/本报告 Release 执行
清单/CHECKSUMS 终同步,§8);任务 4 编号空缺属编排序列(M10-04 先例)。
真实 claude/codex 冒烟按红线未执行(§4.5)。commits 链存在结构性缺口
(条目自身哈希写入时不可知),候选 SHA 以 git log 为准。

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

## 4. 任务 3:v0.3.0 版本抬升、发布说明与端到端演练(交接清单第 2/3 项,2026-10-06)

### 4.1 版本抬升与产物

- 四处 0.3.0:根 package.json(0.2.0→)、packages/local-api/package.json
  (0.2.1→)、apps/desktop-shell/tauri.conf.json(0.2.0→)、
  apps/desktop-shell/Cargo.toml(0.2.0→)+Cargo.lock 随构建同步。
  `pnpm install`:「Lockfile is up to date, resolution step is skipped」,
  `git diff --stat pnpm-lock.yaml` 零输出——**lockfile 零变化,外部依赖
  零变化**(如实断言)。
- CHANGELOG「Unreleased」落定为「0.3.0 — 2026-10-06」:版本线说明
  (0.2.1 预抬未单独发布,破坏性变更随 0.3.0 首发入库)+M10 系列六条
  Added(RunDriver/多节点 DAG/读侧注入/outcome 双字段/文档大收口/托盘
  收口与发布批);迁移说明=受控链 001..018 幂等,旧库自动迁移。
  CHECKSUMS CHANGELOG 行重算。
- 发布说明草稿 reports/V0.3.0-RELEASE-NOTES.md:按 RELEASE_PROCESS 四
  分类(implemented/experimental/unverified/unsupported)+已知限制
  (未签名/SmartScreen、GOVERNANCE 复核提示、真实 CLI 冒烟与干净机归
  维护者、回退口径);费用字段结构性 unknown、沙箱 Trusted-only 如实
  载明。
- **新 NSIS 安装包**:五步构建链 exit 0(pnpm build 36/36 → bundle:serve
  1,708,278 字节 → fetch-node-runtime 幂等哈希命中零网络 →
  sync-shell-sidecar → cargo tauri build 36.39s)。产物
  `apps/desktop-shell/target/release/bundle/nsis/role-orchestrator-shell_0.3.0_x64-setup.exe`
  = **26,056,761 字节(24.85 MiB)**,SHA256
  `ac92cf8c8e80f31674f06cf8e58e49de6d457e0133b4bcd321bddfeb6abcc5ee`。

### 4.2 阶段 5 自动面

`pnpm test` 全量门禁 **72/72 任务 exit 0**(70 cached——版本抬升仅打掉
local-api 缓存链,实跑绿;M10 新面由既有 e2e 套件内容寻址覆盖)。

### 4.3 安装面演练 A(卸旧-装新-开箱六断言+带凭据 200)

全流程 PowerShell Start-Process 传参(/S 不经 MSYS),exit 0:

- 卸载 0.2.0:uninstall.exe /S → 安装目录与 HKCU 键消失,**数据目录
  保留**(profiles.json sha 45762b2a… 前后一致)。
- 安装 0.3.0:/S 静默 → exe VersionInfo **0.3.0**、serve-bundle.mjs
  1,708,278 字节、node.exe sha256 钉值 `98843732…` 命中、HKCU
  DisplayVersion=0.3.0、HKLM 无写入。
- **六断言**:①RO_SHELL_* 未设;②壳进程存活;③serve 链命令行=安装
  目录 node+serve-bundle.mjs+默认 db+--profiles 约定路径(argv 数组,
  非仓库路径);④127.0.0.1:54241 监听+窗口标题 "Role Orchestrator"
  +WebView2 子进程在位;⑤`GET /`=200、无凭据 `/api/v1/session`=403;
  ⑥强杀壳→4 秒预算内孤儿清零。
- **带凭据 API 200(v0.1.0 教训)**:读 serve token 文件(%TEMP%
  \role-orchestrator-local-api\)→ Bearer 调 `/api/v1/profiles/full`
  **200**(rawText 在案)+GET /api/v1/session 发 CSRF 令牌。
- **旧库幂等迁移**:用户 db(3 条 v0.1.x/v0.2.0 时代 run,含 M9-04 真实
  claude 任务的 RUNNING 诚实终态)被 0.3.0 serve 开箱打开,task_runs
  结构含 outcome 列(018 已在位),三条旧 run 原样;`schema_migrations`
  为版本标记(PRAGMA user_version 恒 0,迁移链不用它)。**如实登记**:
  演练前 db 主文件仅 4096 字节(数据全在 WAL),演练脚本的 sqlite 只读
  计数连接在 close 时触发 WAL checkpoint,主文件合入为 462,848 字节
  ——数据零丢失(task_runs=3 前后一致、内容不变),属 SQLite 常规
  checkpoint 而非写改;演练全程 db 只增不改(新增 5 条演练 run)。

### 4.4 安装面演练 B(M10 新面 API 实证,fake wrapper 零真实 CLI)

经配置页写回链(PUT /profiles/full:无 Origin 403 守卫→带 Origin 200,
bytesWritten=954,盘上逐字相等)+重启载入后:

- **多节点 workflow 声明**:`POST /api/v1/runs` 携 `workflow.nodes` 双
  agent 节点(developer/coordinator 异角色)→ 422 ROLE_BINDINGS_INCOMPLETE
  (projectId 在案)→ PUT role-bindings 四绑定 200(profileRevision 1)
  → **202** run-muvv1fzn;strict schema 实证:节点恰 5 字段
  (id/role/kind/objective/dependencies),多余字段 400 INPUT_REJECTED。
- **轮内并行观测(双 profile 双凭据组)**:两节点执行窗
  23:08:18.891→33.239 与 23:08:18.934→33.256——**43ms 错峰、14.3s
  完全重叠**=真并行;同批对照:同 profile 同凭据组的前序 run 双节点
  **串行**(窗口首尾相接,12-14s 间隔)——四层并发约束的 unverified
  凭据组层在安装面按设计生效(负对照)。
- **outcome 双字段**:run 终态 **READY_FOR_DELIVERY + outcome=null**
  (success 归交付流程,聚合规则如实);db 面任务 outcome 列在位。
- **Memory/Context 注入区块(决策②形状)**:wrapper 捕获 stdin prompt,
  多节点两 prompt 均以『（多节点工作流；本提示未携带 Memory/Context
  注入。）』尾注收尾(2/2);决策①记忆区块形状(需真实记忆注入)由
  orchestration 58/58 自动面覆盖,安装面未播种记忆(不写用户库)。
- **单节点裸 objective 平价红线**:无 workflow 的 run prompt 与 objective
  **逐字相等**且不含尾注(安装面实证)。
- **v1 限制负例**:双 integration 节点声明 → **400
  WORKFLOW_INTEGRATION_NODE_COUNT**。
- **漂移门活体证据(意外收获)**:首试沿用 M9-04 演练 id
  drill-fake-claude 被拒——409 PROFILE_DEFINITION_CONFLICT(stored
  executable=ro-m904-e2e wrapper ≠ requested)——用户库中 v0.2.0 演练
  的 profile 修订仍在,七字段漂移门跨版本生效;改新 id(drill4-*)通过。
- **数据保留**:profiles.json 演练后字节级还原(sha 一致);用户 db
  只增(3 旧 run 原样+5 演练 run 全 READY_FOR_DELIVERY);收尾孤儿=0;
  机器终态=0.3.0 已安装。

### 4.5 真实 CLI 冒烟(红线第 1 条)

**未执行**(维护者清单如实登记):全程演练执行面只用仓库 fake-cli
(双 wrapper 经 --scenario success --delay-ms 驱动),零真实 claude/codex
调用;产品内真实 CLI 全链(尤其多节点/并行场景)保持 unverified 口径
(发布说明已载)。

## 5. 变更文件清单

任务 1(7 文件):docs/ORCHESTRATION.md、project/LICENSING.md、
AGENTS.md、project/backlog.json、packages/local-api/test/diff-view.test.ts、
CHECKSUMS.sha256(四行重算:AGENTS/ORCHESTRATION/LICENSING/backlog.json)、
本报告。
任务 2(2 文件):apps/desktop-shell/README.md(冒烟清单 v0.3.0 化+证据
登记+核验命令模式修正;apps/desktop-shell 不入冻结面,CHECKSUMS 零影响)、
本报告。
任务 3(9 文件):package.json、packages/local-api/package.json、
apps/desktop-shell/tauri.conf.json、apps/desktop-shell/Cargo.toml、
apps/desktop-shell/Cargo.lock、CHANGELOG.md(Unreleased→0.3.0 落定,
CHECKSUMS 行重算)、CHECKSUMS.sha256、reports/V0.3.0-RELEASE-NOTES.md
(新)、本报告。pnpm-lock.yaml 零变化(§4.1);sidecar/serve-bundle.mjs
经构建链重同步但字节与盘上版一致(esbuild 确定性输出,零 diff 不列)。
任务 5(6 文件):PROPOSALS.md(治理披露:M10-06 交付——v0.3.0 发布批,
2026-10-06)、docs/BACKLOG.md(M10-06 行交付标记+M10-06 交付摘要节)、
project/backlog.json(deliveryNotes.M10-06→delivered/commits 三枚/全链
以 git log 为准)、CHECKSUMS.sha256(PROPOSALS/BACKLOG/backlog.json 三行
终同步)、本报告(§1 终化+§8)。安装包产物在 target/(gitignore)不入库,
仅路径与 SHA256 入披露(§4.1/§8)。

## 6. 测试及退出码(2026-10-06 本会话实跑)

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

任务 3:

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 全 workspace 构建 | pnpm build | 36/36 任务 | 0 |
| 构建链 2-4 步 | bundle:serve / fetch-node-runtime / sync-shell-sidecar | bundle 1,708,278 字节;node 哈希钉值幂等零网络 | 0 |
| NSIS 打包 | cd apps/desktop-shell && cargo tauri build | 0.3.0 包 26,056,761 字节(release 36.39s) | 0 |
| **阶段 5 全量门禁** | pnpm test | 72/72 任务(70 cached,版本抬升仅打掉 local-api 链) | 0 |
| 安装面演练 A | powershell -File ro-drill-a-install.ps1(临时) | 卸旧/装新/六断言+带凭据 200 全过 | 0 |
| 安装面演练 B | python ro-drill-b-m10faces.py(临时) | §4.4 全过(含负例与漂移门活体) | 0 |
| 冻结面 | node planning-check.mjs | 提交前复验 CHANGELOG 行重算后 | 0(见提交信息) |

## 7. 未验证项

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

任务 3:

8. **真实 claude/codex 冒烟未执行**(红线第 1 条;§4.5)——产品内真实
   CLI 全链(尤其多节点/并行场景)保持 unverified,归维护者清单;模型
   补全半程与上游可用性未探测。
9. 安装面 outcome 徽标的**视觉呈现**未人眼验证(安装态 UI 渲染);
   outcome 徽标逻辑由 browser-e2e 自动面覆盖,本机安装面仅 API 层实证
   (READY_FOR_DELIVERY+outcome null)。
10. Memory/Context 注入区块的决策①形状(真实记忆注入后的区块头)未在
    安装面播种验证(不写用户库)——由 orchestration 58/58 自动面覆盖;
    安装面实证的是决策②零注入尾注形状(2/2 prompt)。
11. 演练 sqlite 连接触发 WAL checkpoint 使 db 主文件 4096→462,848 字节
    (数据零丢失,§4.3 如实登记)——f1c1d714 前缀的旧主文件字节态不再
    存在,后续批次比对基线以本次登记为准。
12. 演练向用户库新增 5 条 run/项目行/profile 修订(drill3-/drill4- 系列)
    与 8 个 worktree 目录——属演练持久证据(历批同口径,不删证);旧
    profiles.json 字节级还原。
13. 干净 Windows 机器端到端、双击式 GUI 向导安装、WebView2 在位率抽样
    仍归维护者(发布说明与 README 清单已载);tag v0.3.0 与 Release 页
    未触(维护者批准链)。

## 8. Release 就绪与执行清单(维护者批准链;Developer 不执行)

**候选就绪态**:本报告所属提交即候选(candidateSha 以 git log 为准,
commits 链结构性缺口见 §1);全部门禁绿——planning-check 79/79+self-test
exit 0、pnpm build 36/36、pnpm test 72/72、cargo test 54 passed 0 failed、
五步构建链 exit 0、安装面演练 A/B 全过(§3-§4)。

维护者执行步骤(按 project/RELEASE_PROCESS.md 逐项):

1. **发布检查终审**:README 与版本说明(reports/V0.3.0-RELEASE-NOTES.md)
   的 implemented/experimental/unverified/unsupported 四分类逐项核对;
   费用不可用=unknown、沙箱=Trusted-only 表述在位;包内 secret 检查;
   审查第三方许可与依赖锁(lockfile 零变化断言在 §4.1)。
2. **冒烟清单或显式接受**:真实 claude/codex 冒烟(§7 条目 8)、干净机
   端到端、WebView2 在位率抽样、真窗交互(托盘菜单点击/双击恢复/导航
   提示观感/capability 运行层探针在无阻塞机器复跑)——
   apps/desktop-shell/README.md v0.3.0 清单与发布说明已逐项列明。
3. **治理复核**:GOVERNANCE.md 逐稳定发布复核(仍候选期口径;Apache-2.0
   采用记录在 PROPOSALS 2026-09-25 节与 MAINTAINERS.md——M10-05 审查
   (b) 条处置登记);CHANGELOG 0.3.0 节终审。
4. **批准后执行**:打 tag v0.3.0 → 建 Release 页(附安装包产物
   `role-orchestrator-shell_0.3.0_x64-setup.exe`,26,056,761 字节,
   SHA256 ac92cf8c8e80f31674f06cf8e58e49de6d457e0133b4bcd321bddfeb6abcc5ee,
   产物在 target/ 不入库由维护者自构建或归档)→ 归档 → 远端推送。
5. **回退预案**:保留 0.2.0 安装包(bundle 目录在档)与数据目录备份;
   迁移链 001..018 只增不改,降级=旧版安装包+备份数据目录;回退不丢弃
   未交付 worktree/审批证据。
