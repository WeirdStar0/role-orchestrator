# Changelog

## Unreleased

### Added

- M9-03 角色与模型配置页 + 壳侧接线收口：新增配置文件面
  `GET /api/v1/profiles/full`（来源路径 + 当前文件全文 + 经既有冻结
  ProfilesFileSchema 解析器得出的解析结果）与
  `PUT /api/v1/profiles/full`（body `{content: <全文>}`，经**既有**解析器
  严格校验后以「临时文件 + fsync + rename」原子写回来源路径；校验失败
  422 带解析器可读原因、原文件一字不动；无来源路径的进程对 GET/PUT 均
  409 PROFILE_SOURCE_ABSENT 诚实拒绝，不猜路径、不隐式重建被删文件）。
  页面新增第三页签『配置（profiles）』：配置摘要（runtime 的 claude/codex
  映射、maxConcurrency×timeoutSeconds 预算）+ 编辑器全文写回（失败只写
  状态、编辑器内容逐字保留；写回不热重载，重启 serve 生效——同 id 不同
  定义的 run 创建仍受 409 漂移门约束）；全部动态文本经转义（A36 不退），
  写回体单字段 allowlist（A02 UI 层）。壳侧接线：serve 子进程 argv 增加
  可选 `--profiles <per-user 约定路径>`（传配置文件路径，非令牌；约定
  路径 `%LOCALAPPDATA%\role-orchestrator\profiles.json` 与默认库同目录，
  **存在才传**，不存在则不传——serve 行为与 v0.1.1 一致，见桌面壳
  README）。`bundle:serve` 增加指名前置检查（fail-loud）：全部 workspace
  依赖的 dist 必须先经全 workspace `pnpm build` 产出，否则指名报错退出。
  零新增外部 npm 依赖（配置文件按 M9-01 契约为严格 JSON，不引入 YAML
  解析）。
- M9-02 任务工作台 UI v1：页面默认页签即工作台（观测台全部能力移入「高级」
  页签保留，无删减）。新建任务表单（objective 文本域 / profile 下拉 /
  工作目录输入含体验层绝对路径提示——存在性/目录/git 基线校验仍由后端
  fail-closed 执行，typed 400 原文回显）；新建 `GET /api/v1/profiles`
  只读端点（经既有守卫管道，仅返回 id/runtime/executionTarget/model/
  timeoutSeconds，可执行路径与 credentialGroup 不出进程；未配置编排的
  进程返回诚实空清单）。任务列表渲染 GET /api/v1/runs（objective/状态
  徽标/创建时间，创建倒序，2 秒自动刷新+手动刷新）；点行展开实时进度：
  执行清单复用既有 run-detail 渲染、失败执行显式标注（run 级状态词汇表
  无失败值）、事件经 WS /api/v1/events/live 直播（首消息认证，按 eventId
  去重）。全部动态文本经转义后插入（A36 不退）；表单体经显式 allowlist
  构建（A02 UI 层，无 model/Profile 字段）；无新增外部 npm 依赖。
- M9-01 任务工作台点火：`POST /api/v1/runs` 创建任务并驱动引擎调度 AI CLI
  执行。严格 body（objective 1..10000 / profileId / projectDir 绝对路径），
  projectDir 逐项 fail-closed（存在、目录、git 仓库、可解析 HEAD）；profileId
  是 Project RoleBinding 层选择面（A02 允许门），图与节点零 profile/model
  字段。serve 进程内串行泵驱动：建图（冻结快照+图+revision 基线）→
  调度（真实队列/配额/能力门）→ worktree 隔离 → engine 执行（fake-cli
  测试、真实 CLI 留维护者）→ 事件照常落库（REST/WS 自动可见）；审批卡照常
  走既有审批面（GET /runs/:id/approvals + POST /approvals/:id/decision），
  批准后泵执行恰好一次 digest 绑定续行（A17/A19 不变，无批量放权）。
  `GET /api/v1/runs` 最小任务列表（id/objective/状态/时间，创建倒序）。
  原 dispatch 501 骨架退役为 410 ENDPOINT_RETIRED（语义升级指向
  POST /api/v1/runs）；serve 新增可选 `--profiles <file.json>`（冻结
  ProfilesFileSchema 的 JSON，零新增外部依赖；未配置时 POST /api/v1/runs
  诚实 503）。local-api 依赖新增 @role-orchestrator/engine/scheduler/
  runtime-profile（workspace 内部包，外部依赖计数不变）。

### Changed

- `POST /api/v1/runs` 由 201 改为 **202 Accepted**：创建与驱动解耦——
  创建簿记（git rev-parse + 同步落库）移入独立的快速创建链，不再排队于
  串行驱动链之后；入队成功即返回 `{runId, status: "queued", statusEndpoint}`
  （驱动已在入队后异步进行，FIFO 顺序不变），修复前序任务执行期间
  （可达数十分钟）创建请求被阻塞的 M9-01 耦合。持久行状态仍以
  statusEndpoint（GET /api/v1/runs/:id）的冻结词汇表为准；M9-01 测试
  语义同步 201→202 并新增『长任务占链时 POST 即回且排队任务仍被执行』
  回归格。

### Fixed

- serve 独立进程入口建库时执行 schema 迁移，修复桌面壳首启页面
  `no such table: executions`（0.1.1 补丁）：runServe 于 openDatabase
  之后、HTTP 服务启动之前应用 `CONTROLLED_EXPANSION_MIGRATIONS`
  （001..013+015+016+017，幂等——已初始化库零迁移跳过，迁移失败传播
  且不启动服务），并补测试钉住新空库 executions 表在位 + 带 token 的
  run 详情 API 200、同库二次启动幂等、迁移失败传播。

## 0.1.0 — 候选（待维护者批准发布）

v0.1.0-rc 后的交付登记（M8-01 真实 CLI 联调 → M8-02 model-stats →
M8-03a/b/c 桌面壳 → M8-04 统计收尾 → M8-05 壳 serve 侧车捆绑 → M8-06
维护清理 → POLISH-4 终审，2026-09-28 至 09-30）。发布状态：
pending-maintainer（见 `project/RELEASE_PROCESS.md`），本节为候选内容，
正式发布由维护者逐项批准。

### Added

- M8-01 真实 CLI 受控联调窗口：维护者授权窗口内双 CLI（claude/codex）真实
  调用 smoke，闭合 8 项 unverified 格；M6-01 §7 能力矩阵新增 10 行
  verified（版本重测、会话恢复、权限/沙箱拒绝、取消树杀、账号隔离、
  Node v25.9.0 级联重测）；18 文件脱敏 fixtures 入
  `packages/cli-events/fixtures-real/m8-01-2026-09-28/`，另 4 文件脱敏
  usage fixtures 入 `packages/model-stats/fixtures-real/`。仍 unverified
  的平台项（Hardened 沙箱、双账号隔离、WSL 内 CLI、macOS/Linux、其他
  Windows 构建）维持 unknown-deny。
- M8-02 新包 `packages/model-stats`（第 36 个 workspace 包）：模型性能统计
  只读基础设施——`UsageEvent` strict schema（费用字段契约级
  `z.literal("unknown")`，CLI 自报价格不入约、结构性不可见）/ claude
  stream-json 与 codex `exec --json` 双方言 hermetic JSONL usage 提取器 /
  只追加 `PerformanceStore`（加载逐行 strict 复验，fail-closed）/ 只读
  `report()`（类表面封闭 pin + 决策词表检查）。
- M8-04 model-stats 收尾：`BudgetRefinement` 由恒 stub 填充为二态
  （`ready` / `insufficient-data`）只读阈值建议（per-model nearest-rank
  P95/P50，建议值附推导口径 method+n 与「建议非策略」诚实边界；样本阈值
  n=5，不足时输出显式缺口，两态在合法输入下绝不抛错、零副作用）；engine
  持久化路径 usage 事件 tee（`persistDrainedEvents` 可选 `usageSink`，
  engine 侧 fail-open，A36 脱敏边界不移动；生产接线未做，装配属调用方
  另批决策）。
- M8-03 桌面壳（选型 ADR `reports/M8-03-desktop-shell-adr.md` 推荐并经
  维护者 2026-09-28 批准后实现；Tauri v2 独立 Cargo 工程，不入 pnpm
  workspace）：
  - serve 入口与连接（M8-03a）：local-api 独立进程 serve（zod strict
    `--db`/`--port`），壳以 argv 数组 spawn（无 shell、不经手令牌），
    stdout 诊断行仅作端口提示，就绪裁决恒为回环 HTTP 探测，通过后建窗
    加载 `http://127.0.0.1:<port>`；健康检查失败非零退出、不建窗；
  - 安全加固（M8-03b）：Windows Job Object 进程树杀
    （`KILL_ON_JOB_CLOSE` 兜底，壳被外部强杀 serve 不孤儿化）；
    `on_navigation` 导航锁定（回环白名单 + 恰为本壳 serve 端口精确
    匹配）；壳协议页严格 CSP（`default-src 'none'`）；capability 近零
    （零 command 注册，静态层/产物层断言入默认门禁）；壳不持久化任何
    凭据（fs 白名单断言钉死）；
  - 托盘与导航拒绝壳内提示（M8-03c）：关闭按钮隐藏到托盘（壳常驻），
    托盘「退出」先 Job 树杀 serve 再退壳（顺序由 `shutdown_sequence`
    纯函数单测钉死）；导航拒绝在壳内弹窗提示（Windows MessageBoxW），
    文案仅 scheme+host+port（最小暴露）；
  - NSIS per-user 打包与开箱（M8-03c/M8-05）：`installMode currentUser`
    （无 UAC、不写 HKLM、无自动更新器；安装包未签名已披露）；M8-05 起
    安装包捆绑 serve 单文件 bundle（esbuild，1,347,146 字节）与便携
    node 25.9.0（官方 nodejs.org/dist 唯一来源，SHASUMS256 强校验），
    壳资源定位链「env 覆盖 → exe 同目录捆绑资源 → 仓库 dev 路径」
    fail-closed 维持（9 单测钉死）——安装后无需环境变量与仓库开箱即用
    （Windows 10/11 预置 WebView2；本机静默安装口径已验：静默安装 →
    无环境变量启动 → serve 链指向安装目录捆绑资源、端口监听、无凭据
    探测 403、强杀壳 serve 链 0.6 秒清零；真正干净 Windows 机器端到端
    与真窗交互属维护者冒烟清单）。
- M8-06 壳与统计包维护清理：fetch-node-runtime 失配先比对后写盘
  （fail-closed 零落盘）、bundle-serve 钉 `absWorkingDir`（产物与 cwd
  无关、字节可复现）、turbo build outputs 否定 glob（缓存命中不清
  serve-bundle.mjs）、desktop-shell README 补纯新克隆构建前置与 dev
  `cargo run` 遮蔽说明、测试补充（model-stats 64→68、engine usage-tee
  4→5）。守卫/令牌/serve/调度/统计建议数值零触及；运行时可见变化仅
  三处且披露在案（fetch 失配不再先写盘、tee 工厂入口校验收紧、budget
  取整口径串更新）。
- POLISH-4 全仓维护态 minor 终审：M8-06 十轮审查移交族逐条闭合（A–Q
  族），历批 POLISH 系列遗留扫描（closed-naturally 七项、锚点收口两项）
  与终审清单十二项逐条处置/归属；批次报告引用弃裸行号改文本锚；测试
  补充（model-stats 68→70）。产品源码、依赖、tauri 配置零触碰。

### Changed

- 测试基线 1593→1637（上一节冻结于 M8-02 时点；本次实跑 `pnpm test`
  exit 0，35 个 workspace 测试包逐包「Tests passed」合计 1637、0 失败；
  desktop-shell Rust 套件另计 46 passed / 1 env 门控 ignored，不入 pnpm
  计数）
- workspace 项目 35→36（新增 model-stats）
- 外部依赖 84→111（+27 = esbuild 与 26 个 `@esbuild/*` 平台可选二进制，
  属构建工具例外、不进运行期依赖树；repo-audit 运行期 externals 钉恰
  ws/yaml/zod 不变，THIRD_PARTY_NOTICES 同步 +27）
- NSIS 安装包 1.84 MiB → 24.78 MiB（捆绑便携 node 与 serve bundle）；
  release 主 exe 8.54 MiB，仍在 ADR「3–10 MB 量级」假设带
- 审计基线机械登记：release-audit `workspacePackageCount` 35→36、
  `externalPackages` 84→111、notices 覆盖 84→111；boundary-audit
  open-core manifest 扩名 34→35（增 model-stats）；engine 增 test-only
  devDependency `@role-orchestrator/model-stats`（运行时零 import）
- secrets-scan 默认排除目录增 cargo `target`（M8-05 第 1 次返修：构建
  产物树曾致满载扫描偶发超时，排除后 verdict 与 findings 逐字节一致）

### Fixed

- serve 信号退出竞态：shutdown 单飞化（重复调用复用同一 in-flight
  promise）+ 信号退出链只挂一次（M8-03b）
- 桌面壳测试孤儿进程根治：serve 子进程入 Job Object 树杀，消除 M8-03a
  时代每次 cargo test 确定性泄漏的 2 条 shim 链孤儿（M8-03b；其后单元
  与集成跑完按 serve-bin/ro-shell-fake 双模式核验 orphans=0）
- ws-backpressure 测试满载加固：采样改「≥40 样或 2 秒截止」双条件 +
  afterAll 显式 60s（M8-06 第 1 次返修；断言零改动，全量 70/70 复绿）

### 支持与限制（与 README 口径一致）

- 统计费用字段结构性 unknown：schema 层拒绝任何数字形态的 CLI 自报
  价格入契约。
- Worktree 分离代码目录，但不是安全沙箱；Local Trusted 模式仅用于用户
  明确信任的仓库；本地运行不等于模型离线运行。
- 执行路径 Windows 优先；桌面壳 Windows 渲染依赖系统 WebView2 Runtime
  （验收机实测 pv=153.0.4234.48；最小支持系统在位率抽样归发布期冒烟）。
- 桌面壳剩余 unverified 12 项（真窗交互、双击式 GUI 安装、真正干净
  Windows 端到端、WebView2 在位率抽样、capability 探针异机回填、内存
  占用回填等）见 `apps/desktop-shell/README.md`「当前 unverified（维护者
  冒烟清单）」节。

## 0.1.0-rc — 2026-09-26

规划包 0.1-draft 的全部 41 项开发任务（M0–M7）已实现并验收：
35 个 workspace 项目、1523 项测试全绿，各批次均经 10 轮连续独立审查
（开发/修复由 GLM-5.3-Flash 执行、审查由 GLM-5.3 执行，任何一轮失败清零重审）。

已实现（implemented）：

- 单任务持久化闭环：Profile 绑定、执行、事件、SQLite/outbox、最小页面；
- DAG 并行调度、资源租约、执行 worktree、集成与候选审查；
- 上下文与共享记忆（来源、权限、CAS、检索、注入防线）；
- 风险分级、一次性审批（actionDigest）、检查点、受控扩图、重试与预算、
  故障注入矩阵与恢复；
- 本地页面与 API（回环 + 令牌 + CSRF + 严格 CSP）、WS 实时事件、诊断导出；
- 备份、迁移与安全清理（升级演练、containment 守卫）；
- Windows 原生路径/进程/取消/权限/认证矩阵；
- SCM 集成、插件注册表、Remote Worker、商业边界的契约与协议级验证。

experimental / 设计验证（未接真实服务）：真实 GitHub/GitLab 调用、
真实容器与 Remote Worker 运行时、插件真实加载器（已交付 manifest 与
加载决策契约）。

unverified（按 unknown-deny 拒绝声明）：真实 claude/codex 联调、
macOS/Linux/WSL 原生、Hardened 沙箱边界、CLI 当前版本相对采集日漂移。

当前没有：用户启动命令/守护进程；执行入口 `POST
/api/v1/executions/:id/dispatch` 为鉴权完整的 501 骨架；全部端到端演示
使用 fake-cli 合成 CLI。发布状态：pending-maintainer（见
`project/RELEASE_PROCESS.md` 与 `reports/M6-05-release-candidate.md`）。

## 0.1-draft — 2026-09-21

形成 32 项需求冻结记录、四角色/单 Profile 约束、CLI 适配与能力验证方案、
DAG/Memory/Git/审批/恢复架构、分阶段开发计划与验收矩阵。
加入治理文件、ADR、示例配置、Schema、TypeScript 契约和规划包静态校验。
本版本为规划交付物，不包含可运行的 Orchestrator 应用。
