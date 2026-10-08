# role-orchestrator · 多模型角色编排任务工作台

开源、本地优先的 AI CLI 编排产品：桌面壳 + 本地常驻 serve + 浏览器工作台，
把 Claude Code CLI 与 Codex CLI 统一调度进 Coordinator / Architect / Developer /
Reviewer 四个固定角色。每个项目的每个角色单选一个 Profile（不允许多重绑定，
不允许 Workflow / Task / Node 覆盖，不自动替换模型），以可声明的多节点 DAG、
共享记忆与上下文注入、执行级 Git Worktree、代码集成、验证与一次性人工审批
完成复杂开发任务。

- **当前版本**：v0.4.0（2026-10-08 发布，tag `v0.4.0`）。v0.4.0=产品 UI
  重构版（M11「Desktop Product Experience」五批全部交付）：全新桌面任务
  界面（默认 `/app`，旧工作台保留于 `/`）、会话令牌自动认证（页面零令牌
  输入）、首启零配置（自动检测 Claude Code / Codex 并生成推荐配置）、
  项目+任务+Agent 时间线、多节点执行可视化（审批/返工/Diff）。
  版本历史见 [CHANGELOG.md](CHANGELOG.md)。
- **开发协议**：每个任务批次经 10 轮连续独立审查；交付记录见 [reports/](reports)
  与 [PROPOSALS.md](PROPOSALS.md)；当前里程碑见 [docs/BACKLOG.md](docs/BACKLOG.md)。
- **平台定位诚实陈述**：执行路径（进程生命周期、进程树终止、桌面壳）为
  **Windows 优先**；macOS/Linux/WSL 原生执行未验证，按 unknown-deny 不声明支持。

## 开箱即用（Windows 安装包路径）

1. **安装**：运行 NSIS per-user 安装包（`role-orchestrator-shell_<版本>_x64-setup.exe`）。
   无 UAC、不写 HKLM、安装到 `%LOCALAPPDATA%\role-orchestrator-shell`；安装包
   自带 serve 单文件 bundle 与便携 Node.js runtime，装机不触网。安装包未签名，
   SmartScreen 提示未知发布者属预期。构建安装包的五步链见
   [apps/desktop-shell/README.md](apps/desktop-shell/README.md)。
2. **启动**：打开壳。壳自动拉起本地 serve（仅监听 `127.0.0.1` 随机端口）、
   健康探测通过后建窗加载工作台页面；关闭按钮 = 隐藏到托盘（壳常驻），
   托盘「退出」先终止 serve 进程树再退壳。
3. **令牌**：serve 启动即生成 256-bit 会话令牌，写入当前用户目录下的
   0o600 令牌文件；托盘菜单「打开令牌文件」用系统默认程序打开该文件，
   把令牌粘贴进页面即完成登录。壳不经手令牌内容；API 无令牌一律 403。
4. **profiles（角色与模型配置）**：把符合冻结 ProfilesFileSchema 的严格 JSON
   放到约定路径 `%LOCALAPPDATA%\role-orchestrator\profiles.json`（可由
   `config/profiles.example.yaml` 转换），或直接在页面「配置」页签查看/
   原子写回该文件（写回不热重载，重启壳生效；同 id 修改 model 不产生新
   revision，需要变更模型请新建不同 id 的 profile）。内容非法时 serve 拒绝
   启动（fail-closed，不建窗）。
5. **建任务**：工作台表单填写 objective 与项目目录（绝对路径、已存在、
   git 仓库）。执行用哪个 profile 由**项目角色绑定**决定（「配置」页签
   四角色一次保存；未绑定目录首次创建会以 422 引导先绑定）。任务创建
   对绑定零副作用（只读并冻结快照）。多节点 DAG 经 API 声明
   （`POST /api/v1/runs` 的 `workflow` 字段；v1 限制：每任务至多一个
   integration 节点，链式/并行集成将在后续版本支持）。
6. **观测与交付**：任务列表与实时进度（WS 直播事件）、审批卡片
   （一次性 actionDigest，批准/拒绝针对单个动作）、失败/阻塞徽标
   （status+outcome 双字段呈现，不再把失败假显示为执行中）。完成后经
   集成分支产出候选 SHA 与 diff/测试证据，人工验收后交付。

## 从源码构建（开发者路径）

```bash
# 前置：Node.js >= 20（packages/runtime-profile 要求 >= 25）、pnpm 10.14；
# 仓库根 mise.toml：mise install 可一次装齐 node/pnpm/python
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm test
```

- 规划包静态自检（配置 / Schema / DAG / 权限 / 文档链接 + 负向测试）：
  `python scripts/validate_bundle.py --self-test`（仓库内直跑因 node_modules
  断链按已知问题 exit 1，干净副本内 exit 0——由 `node planning-check.mjs`
  统一校验：CHECKSUMS 逐文件 + 干净副本自检）。
- 桌面壳（Tauri v2 独立 Cargo 工程）：构建、运行与维护者冒烟清单见
  [apps/desktop-shell/README.md](apps/desktop-shell/README.md)。
- 端到端演示与基准：`packages/dogfood`（全链路 + 失败注入 + 恢复）、
  `packages/browser-e2e`（真 Chromium 五类用户流程）、`packages/e2e-baseline`
  （并行开发基准）。依赖 dist 的端到端测试先 `pnpm build`。

## 能力边界

按 [project/RELEASE_PROCESS.md](project/RELEASE_PROCESS.md) 的发布检查口径
区分（「失败/未验证项不能伪装已支持」）：

**implemented（已实现、有测试与验收证据）**

- 单机单用户本地产品闭环：安装包开箱、令牌流、profiles 配置页、建任务、
  实时进度、审批卡、outcome 徽标、托盘常驻（Windows）。
- 四角色单 Profile 绑定与冻结快照；任务创建只读绑定（零配置副作用）。
- 多节点 DAG 编排声明（≤64 节点：依赖/预算/环/角色合法性检查）与
  单 run 轮内并行派发（scheduler 四层并发约束不变：global/project/
  profile.maxConcurrency/unverified 凭据组）；跨 run 仍为 FIFO。
- TaskRun `status`+`outcome` 双字段（受控迁移 018）与失败/阻塞徽标；
  状态词汇表 PLANNED/RUNNING/READY_FOR_DELIVERY/DELIVERED/CANCELLED 不变。
- Memory/Context 读侧注入：verified/active 检索（stale 排除）、top-5 与
  4096 字节预算（整条丢弃 + 截断注记）、A36 脱敏、读侧 fail-open；
  memory/context 包写路径零接触；单节点 prompt 保持裸 objective。
- 执行与治理面：执行级 Git worktree、多父基线集成、固定 SHA 审查、
  受控动态扩图、一次性审批（actionDigest）、重试分类与预算、恢复协议、
  事件 REST/WS、脱敏诊断导出、SQLite 受控迁移链（001..018）、备份演练。
- 模型性能统计只读基础设施（`packages/model-stats`；费用字段结构性
  unknown——CLI 自报价格不入契约）。
- 真实 CLI 适配：claude/codex 双方言协议适配器与 M8-01 受控联调冒烟
  （版本、事件、取消、恢复、账号隔离已有脱敏 fixtures 与矩阵记录）。

**experimental（已实现但边界明确，未接生产服务）**

- SCM 受控集成（GitHub/GitLab）：SCMProvider 契约与协议级验证，未接
  真实远端服务。
- 插件注册表（版本化 manifest 与加载决策契约）、Remote Worker/容器
  （传输/租约/取消契约）：设计验证级，无真实运行时接入。

**unverified（按 unknown-deny 拒绝声明支持）**

- 产品内真实 CLI 端到端全链（尤其多节点/并行场景）：v0.2.0 演练中真实
  claude spawn 成功、因上游服务 503 未完成模型补全（如实登记）；真实
  长期记忆库的检索命中率（AND 检索零命中是常态）。
- 真窗交互（托盘菜单点击、导航拒绝壳内提示）、双击式 GUI 向导安装、
  真正干净 Windows 机器端到端、WebView2 在位率抽样、release 形态
  stderr 退化行为（维护者冒烟清单，见 apps/desktop-shell/README.md
  v0.3.0 口径清单）。
- macOS/Linux/WSL 原生执行、Hardened 沙箱边界、CLI 当前版本相对采集日
  的漂移；磁盘真实生产库（017 时代）的升级实测（测试级 001→018 已覆盖）。

**unsupported（明确不支持）**

- 多用户/多租户/云部署；非回环远程访问（API 仅 `127.0.0.1` + 令牌）。
- run 级取消生产面（v1 无 cancel 路由与 UI；取消仅存在于 serve 关停/
  超时与执行级引擎取消，落执行行不迁移 run 状态）。
- 自动模型切换、模型投票、fallback、临时切换账号规避配额；Workflow/
  Task/Node 层的 Profile 覆盖。
- 跨项目记忆共享；每任务多于一个 integration 节点的编排（链式/并行
  集成将在后续版本支持）。
- 沙箱声明：Worktree 分离代码目录，但**不是安全沙箱**；Local Trusted
  模式仅用于用户明确信任的仓库。

## 真实使用验证(v0.3.1 主线)

v0.3.1 的主线是**真实任务数据**:用产品内 Claude+Codex 跑 5 类真实任务
(小 bug / 小功能 / 跨前后端 / 架构重构 / Reviewer 首轮 fail 返工)并按
13 项指标留档。操作步骤与记录表见
[reports/REAL-USE-DRILL-TEMPLATE.md](reports/REAL-USE-DRILL-TEMPLATE.md);
只读导出每个任务 run 的指标摘要:

```bash
node scripts/usage-stats.mjs --db "%LOCALAPPDATA%\role-orchestrator\orchestrator.db" --format md
```

脚本对用户库只读(node:sqlite `readOnly: true`,即 SQLITE_OPEN_READONLY),
零运行时行为变更;Memory 命中与 CLI usage
两项当前在库中无持久记录,导出如实标 unknown 并附人工补记说明。

## 仓库结构与文档地图

pnpm workspace：`packages/` 下 contracts、store、dag、scheduler、engine、
runtime-profile、approval、checkpoint、review、context、memory、memory-search、
worktree、integration、reconcile、local-api、cli-events、expand、maintenance、
orchestration、model-stats、release-audit、boundary-audit、fault-matrix、
process-lab、fake-cli、dogfood、e2e-baseline、browser-e2e、context-e2e、
implicit-verify、plugin-registry、remote-worker、scm-contracts 等 36 个包；
`apps/desktop-shell` 为独立 Cargo 桌面壳工程；另有 `scripts/`（规划包校验器）、
`config/`（配置协议示例）、`schemas/`（JSON Schema）、`contracts/`（TypeScript
设计契约）、`docs/`（需求/架构/验收矩阵/ADR）、`reports/`（批次报告）。
冻结面文件清单见 [MANIFEST.md](MANIFEST.md)。

1. 产品与上手：本 README、[START_HERE.md](START_HERE.md)、
   [docs/BACKLOG.md](docs/BACKLOG.md)（当前里程碑）
2. 运行时行为（与代码同步维护）：[docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)
   （DAG 调度与生命周期、接缝勿动清单）、
   [docs/API_AND_EVENTS.md](docs/API_AND_EVENTS.md)（已实现 API 与事件）、
   [docs/MEMORY_AND_CONTEXT.md](docs/MEMORY_AND_CONTEXT.md)（共享记忆与上下文注入）
3. 设计与验收：[docs/PRD.md](docs/PRD.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、
   [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
4. 规则与治理：[AGENTS.md](AGENTS.md)、[GOVERNANCE.md](GOVERNANCE.md)、
   [CONTRIBUTING.md](CONTRIBUTING.md)
5. 历史规划（文件头已标注 historical，正文保留原样）：
   [docs/REQUIREMENTS_BASELINE.md](docs/REQUIREMENTS_BASELINE.md)、
   [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)
6. 决策记录见 [docs/adr/](docs/adr)；发布流程见
   [project/RELEASE_PROCESS.md](project/RELEASE_PROCESS.md)

## 安全边界

Worktree 分离代码目录，但不是安全沙箱。
Local Trusted 模式仅用于用户明确信任的仓库；强隔离能力必须通过实测后才能标记可用。
本地运行不等于模型离线运行，代码与上下文仍可能由 CLI 发送到配置的服务商。
不导出 CLI 认证凭据，不共享跨项目记忆，不默认操作远程仓库。
Memory 与工具输出按纯数据处理：注入 prompt 不产生任何权限/绑定/Profile 副作用。

## 许可证与安全

- 许可证：Apache-2.0（2026-09-25 正式采用，见 [LICENSE](LICENSE)；
  治理记录见 [GOVERNANCE.md](GOVERNANCE.md) 与 [MAINTAINERS.md](MAINTAINERS.md)）。
  第三方依赖归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 的渠道私密报告，不要开公开 Issue。
