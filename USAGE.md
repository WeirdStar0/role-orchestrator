# USAGE — 使用说明（与当前实现一致）

本文面向想在本仓库上运行与观察 role-orchestrator 当前能力的使用者。
写在这里的每一条都对照当前实现核实过；实现没有的能力不会出现在本文里。
产品定位与目标体验见 `docs/PRD.md`；验收语义见 `docs/ACCEPTANCE.md`；
平台支持范围以 `reports/M6-01-platform-matrix.md` 为唯一权威矩阵。

## 1. 当前形态（先读这一节）

本仓库是 TypeScript monorepo 工作区（`packages/*`，pnpm + turbo），不是已发布的
终端用户应用：

- 没有 `orchestrator start` 这类用户启动命令，也没有安装包/守护进程产品。
  根 `README.md` 的「阅读顺序」与本节共同构成入口。
- 浏览器页面与本地 API（`@role-orchestrator/local-api`）已可用：仅绑定
  `127.0.0.1`、令牌鉴权、任务图/扩图/审批/diff/上下文五个面板、实时事件与
  安全诊断导出。它读取的是编排数据库，只读为主（见第 6/7 节的能力边界）。
- 编排链路（建图、调度、执行、集成、审查、扩图、审批检查点、恢复）由各包的
  公共 API 组合驱动，已由端到端基准真实跑通：
  `packages/e2e-baseline`（并行开发基准）、`packages/browser-e2e`（五条用户流程的
  浏览器端到端）、`packages/context-e2e`（跨 CLI 上下文协作）、
  `packages/dogfood`（M6-04 受控 dogfood：全链路 + 失败注入 + 恢复）。
- 执行入口 `POST /api/v1/executions/:id/dispatch` 仍是鉴权完整的 `501
  NOT_IMPLEMENTED` 骨架：真正的守护进程编排属于后续里程碑。不要把本仓库当成
  可以直接接真实 claude/codex 干活的产品；全部端到端演示都使用
  `packages/fake-cli` 的 dist bin（合成 CLI，从不调用真实 claude/codex）。
- 维护者确认事项（LICENSE 正式化、Codeowners、私密渠道、发布批准）尚未完成，
  见第 9 节；在此之前本仓库不对外声称已可按开源许可使用。

## 2. 安装前提

| 前提 | 版本依据（本仓实测） | 说明 |
|---|---|---|
| Node.js | 端到端包要求 `>=25`；实测 v25.0.0 | 工作区根 `engines` 为 `>=20`（M0 引导值）；`packages/browser-e2e`、`packages/dogfood` 等 `engines.node` 为 `>=25` |
| pnpm | 10.14（`packageManager: pnpm@10.14.0`） | workspace + turbo 任务管道 |
| git | 实测 2.54.0.windows.1 | fixture 仓库、worktree、集成、diff 均为真实 git 调用 |
| Python 3 | 实测 3.13.14 | 仅用于冻结的 `scripts/validate_bundle.py` 静态检查，不是产品栈 |
| Chromium 缓存 | playwright-core 1.61.0（chromium-1228） | 仅 `packages/browser-e2e` 需要；缓存缺失时报 `BrowserLaunchError` 并给出补救命令，不会伪造通过 |

不需要任何真实 claude/codex 账号或凭据；仓库代码从不读取 CLI 认证文件。

## 3. 构建与自检

```bash
pnpm install
pnpm build        # 全工作区 tsc 构建（turbo 登记所有包）
pnpm typecheck    # 全工作区严格类型检查
pnpm test         # 全工作区 vitest（turbo 登记所有包）
pnpm run planning:check   # 冻结面完整性：78 个文件 sha256 + 干净副本静态自检
```

已知保留问题：在仓库内直接运行 `python scripts/validate_bundle.py --self-test`
会因 `node_modules` 在场导致冻结的链接检查 exit 1；这是登记在 `PROPOSALS.md`
的既有问题（上游提案待批），`pnpm run planning:check` 的第 (b) 步在无
`node_modules` 的干净副本中运行同一脚本并透传退出码（当前 exit 0）。

单包运行示例：`pnpm vitest run`（在 `packages/dogfood` 目录内）跑 M6-04 的
受控 dogfood 全链路。

## 4. 启动本地页面服务（当前形态）

当前可启动的是 `@role-orchestrator/local-api` 的编程式服务：对着一个已迁移的
编排数据库（SQLite）启动回环 API 与页面。端到端包里的组合顺序即权威用法
（见 `packages/browser-e2e` 的 `src/world.ts` 与 `test/helpers.ts`）：

1. 建库并应用迁移组合链（例如 `@role-orchestrator/expand` 的
   `applyControlledExpansionMigrations`，001..013 + 015..017；全链并集见
   `@role-orchestrator/maintenance` 的 `DAEMON_MIGRATIONS`）。
2. `startLocalApiServer({ db })`，可选 `port`（默认 0 = 临时端口）与
   `tokenFile`。启动序列 fail-closed：
   - 生成 256 位会话令牌并写入仅当前用户可读的令牌文件；
   - 只绑定 `127.0.0.1`，listen 之后断言内核观察到的地址确实是回环，否则拒绝服务；
   - 派生会话绑定的 CSRF 令牌（每启动随机 secret 的 HMAC，不持久化）。
3. 返回值携带 `port / boundAddress / token / csrfToken / tokenFile / close()`。

不提供任何非回环监听；向 `0.0.0.0` 或非回环地址绑定的用法不存在于实现中。

## 5. 令牌获取

- 令牌文件默认写在 `<用户临时目录>/role-orchestrator-local-api/session-token-<16个十六进制字符>.txt`；
  位置检查 fail-closed（仅允许当前用户主目录或用户临时目录；Windows 上每用户
  ACL 即可见性边界，POSIX 上写入后复核 0600）。
- 令牌是 43 字符的 base64url（256 位熵）。用文本编辑器打开令牌文件读取后，
  粘贴进页面的「会话令牌」输入框，或作为 `Authorization: Bearer <token>` 头
  调用 API。
- 令牌只经该请求头传输：不进 URL、不进日志、不写进页面源码。请把它当凭据对待；
  重启服务即换新令牌（令牌文件每次启动唯一）。

## 6. 页面导览

页面为无构建的静态 HTML + 原生 JS/CSS（`GET /`、`/app.js`、`/app.css`），
所有动态文本经转义后进 DOM，严格 CSP（`default-src 'none'`），无 CORS 头。

| 区域 | 操作 | 你会看到 |
|---|---|---|
| 连接区 | 粘贴会话令牌 + 执行 ID，点「加载执行与事件」 | 执行状态与事件日志（脱敏、转义渲染） |
| 任务图（DAG） | 输入运行 ID，点「加载任务图」 | SVG 画布：节点状态/角色/锁定标记；运行或已结束节点显示「锁定」不可编辑（A38） |
| 节点编辑器 | 点击画布上可编辑节点 | 表单只有 role/objective/dependencies 四角色选择——不存在也无法提交 model/Profile 覆盖（A02）；编辑只落新 revision，不会触发执行 |
| 动态扩图 | 点「加载扩图状态」 | review fail 的 Proposal 卡（findings、将铸造的节点）、发起角色选择（A04 服务端强制 + 拒绝审计）、预算余量（每运行 64 节点/依赖深度 16、每链审查上限 3 轮）、A20 等待横幅 |
| 审批 | 点「加载审批」 | 每张审批卡在决策前展示完整动作要素：完整 argv、目标/基线 SHA、仓库根、cwd、冻结 Profile revision、权限增量、维度/写范围、风险等级与原因、过期时间、actionDigest；决策只针对该卡上的单个 digest；已失效（候选已变/过期/已决定）显示徽章且无批准按钮；页面不存在任何全局放权/批量批准控件（A17） |
| diff | 输入节点 ID，点「加载 diff」 | 集成候选相对基线的统一 diff（git 只读读取，截断标记）+ 该 candidateSha 的审查绑定状态（A12：候选一变旧结论即失效） |
| 上下文 | 点「加载上下文」 | context bundle 片段清单（层级/trust/来源/字节/截断标记）与每片段的 traceFragment 追溯 |

实时事件：页面同源下可连 `WS /api/v1/events/live`（升级走同一守卫管道，首消息
令牌鉴权；断线按 cursor 重放、按 eventId 去重、字节预算分页 + 背压，A39）。
诊断导出：`GET /api/v1/runs/:runId/diagnostics?format=json|html`，导出前过
脱敏管道（A36/A42），无凭据、无可执行内容。

## 7. 常用操作（API 形态）

错误信封统一为 `{"error":{"code","message"}}`；`/api/*` 全部要求 Bearer 令牌，
变更类请求还要求合法 Origin 与 `x-csrf-token`（页面从 `GET /api/v1/session` 取回）。

| 操作 | 调用 | 失败语义（fail-closed） |
|---|---|---|
| 读运行/执行/事件 | `GET /api/v1/runs/:runId`、`GET /api/v1/executions/:id`、`GET /api/v1/executions/:id/events?after=&limit=` | secret 字段（dispatchToken、pid nonce）不出进程；`limit` ≤ 200，未知查询参数拒绝 |
| 编辑图节点 | `POST /api/v1/runs/:runId/graph/edits` | 409 `GRAPH_REVISION_CONFLICT`（响应附 `currentGraphRevision`，重载后再试）；运行/结束节点 409 `NODE_NOT_EDITABLE`；model/Profile 覆盖字段 403 `PROFILE_OVERRIDE_REJECTED`；其余未知字段 400 |
| 提交受控扩图 | `POST /api/v1/runs/:runId/expansions` | 无权限角色 403（拒绝原因入审计）；过期 revision 409（附当前值）；三轮封顶/用户挂起 409；超预算 400 |
| 审批决策 | `POST /api/v1/approvals/:approvalId/decision`（`{decision: "approve"|"reject", decidedBy, reason?}`，拒绝必填 reason） | 候选已变/已决定 409 `APPROVAL_INVALIDATED`；过期 409 `APPROVAL_EXPIRED`；决策不执行动作也不消费审批 |
| 执行入口 | `POST /api/v1/executions/:id/dispatch` | 如实返回 501 `NOT_IMPLEMENTED`（鉴权链完整；编排属后续里程碑） |

重复执行的例子都在端到端包里：并行、返工、审批、恢复各流程见
`packages/browser-e2e/test/`，全链路 + 注入 + 恢复见 `packages/dogfood`。

## 8. 故障排查

- **403/400 且提示 Host/Origin/CSRF**：A30 守卫管道拒绝（外部网页、DNS
  rebinding、跨源、缺 CSRF）。用 `http://127.0.0.1:<port>/` 原样访问；令牌过期
  就重启服务取新令牌。
- **409 `GRAPH_REVISION_CONFLICT`**：别人/别的窗口已更新图。读取响应里的
  `currentGraphRevision`，重载图后带着新 revision 重试——系统绝不静默覆盖。
- **审批显示「已失效」**：候选 SHA 已变化、审批已过期或已决定。旧的通过不再
  适用（A12/A17 语义），需要对新候选走新的审查与审批。
- **节点/执行显示 `RECOVERY_REQUIRED`**：执行有副作用但结果未知（如启动窗口
  中断）。系统不会自动重跑；处理路径是恢复清单（`listRecoveryItems`）→ 人工
  确认（`resolveRecoveryItem`，转 INTERRUPTED）→ 显式重试。完整演示见
  `packages/dogfood` 的链路测试与证据。
- **升级/迁移失败**：按 `@role-orchestrator/maintenance` 的 runbook 先认
  `MigrationError.kind`（`application-failed` 干净回滚、`checksum-mismatch`
  必须恢复备份、`unknown-applied-version` 停止人工裁决）。升级前用
  `applyMigrations` 的 `backupPath` 参数拿备份。运维 CLI：
  `ro-maintenance <upgrade-drill|cleanup-plan|cleanup-execute|help>`。
- **路径问题（Windows）**：进程 cwd 超过 260 字符时任何进程 spawn 都会 ENOENT、
  git worktree 在超长路径下 exit 128——两者都是 fail-closed 边界（命令不会执行
  一半）；中文/空格/跨盘/`.cmd` shim 路径已验证可用。清理阶段使用白名单原语
  （Node 25 的 `fs.cpSync`/`fs.rmSync` 对非 ASCII 路径有缺陷，登记为上游提案）。
- **`pnpm run planning:check` 失败**：冻结文件与本仓 `CHECKSUMS.sha256` 不一致。
  这说明有冻结面被改动；按 `CONTRIBUTING.md` 的治理流程处理，不要手工改哈希。
- **browser-e2e 启动失败**：Chromium 缓存缺失或版本不匹配，错误会带补救命令；
  流程按未验证报告，不会伪造通过。

### evidence 目录手工清理守则（browser-e2e / dogfood）

两个端到端包的 `evidence/` 目录是**真实运行产物**，同时被 release-audit 的
仓库级扫描计数断言（`packages/release-audit/test/repo-audit.test.ts`，该测试
不允许修改）钉住。手工清理前必须知道以下事实：

- **轮转机制（POLISH-1）**：每次运行生成 `evidence/<label>-<UTC 时间戳>/` 新
  目录后，写入方会把**同一 label** 的旧目录轮转到只保留最新 22 个（
  `EVIDENCE_ROTATION_KEEP = 22` / `DOGFOOD_EVIDENCE_ROTATION_KEEP = 22`），
  只删同 label 的更旧目录，永不触碰当前运行目录、其他 label 或 evidence 根
  之外的任何内容；单目录删除失败只记入 driver log，不会让测试运行失败。
- **清理前后必须复核扫描计数**：轮转与 release-audit 的审计 pin 是耦合的——
  K=22 是按测量定死的（2026-09-26 实测 binary 529 > 500、scanned 1620 > 1500、
  text 1091 > 900；见 `reports/POLISH-1.md`）。手工清理前先跑一遍
  release-audit 的 secret 扫描记下三项计数，清理后再复核：**跌破任一 pin
  （scanned > 1500 / text > 900 / binary > 500）就需要重测证据基线或调整 K**，
  不能只靠测试兜底。
- **停跑 label 的手工清理是 pin 破坏源**：binary > 500 的 pin（repo-audit
  为严格 `toBeGreaterThan(500)`，即必须 ≥ 501）依赖留存的 browser-e2e 截图
  PNG。余量极小：binary 实测 529 对 pin 500，真实硬顶 **28 张 PNG**
  （529−501）。量级基准（POLISH-2 第 7/8 轮实测）：24 张 PNG 是全套 7 个
  label 各 1 个最新目录的**代合计**（5+4+5+5+4+1+0），不是单目录数——
  单目录实测 0–5 张（flow 类 4–5、regression-a38 为 1、a39 为 0，PNG 目录
  均值 4.0）。据此余量以代计约 **1.17 代**（28/24），以目录计约 **7 个
  PNG 目录**。停跑 label 整组实测：flow-1/3/4 整组 110 张、flow-2/5 整组
  88 张——删除这两组中任何一组都会直接打破不可修改的审计断言，使全仓
  `pnpm test` 变红；regression-a38 整组 22 张（529−22=507 仍绿，但余量
  仅剩 6 张）；regression-a39 整组 0 张 PNG（不适用）。宁可高估风险：
  清理任何停跑 label 前后都按上一条复核三项计数。
- **扫描器假定静态树**：secrets-scan 假定扫描期间目录树不被并发修改；
  并发删除的目录按 ENOENT 跳过（2026-09-26 起容错），因此并发运行期（如
  满载 turbo 期间）三项计数会临时收窄——POLISH-2 本轮实测 binary 曾至
  509 仍绿。计数复核请在无并发测试运行时进行，按保守（更低）值判断余量。
- **轮转开关 `BROWSER_E2E_EVIDENCE_ROTATION`**：仅 browser-e2e 有此环境变量，
  且值**严格等于 `"1"`** 时才在常规 vitest 运行中启用轮转（包内
  `vitest.config.ts` 已设置）；缺失或任何其他值都不轮转（库默认关，也可用
  `Evidence.start(..., { rotate: true })` 按次开启）。dogfood 无开关：
  轮转是默认行为，按次用 `{ rotate: false }` 关闭。

## 9. 已知限制与支持范围

支持范围以 `reports/M6-01-platform-matrix.md` 为唯一权威（每一格带证据与
状态），要点：

- **win32-native（本参考机）verified**：中文/空格/跨盘/`.cmd`/长路径形态、
  进程树终止、PID 复用身份判定、认证锁并发语义、CLI 版本（采集日事实）。
- **unverified，按 unknown-deny 处理**：macOS / Linux-native / WSL1 全部维度；
  WSL2 仅进程语义已验证（CLI 行为未验证）；两 CLI 的凭据隔离；Hardened 沙箱
  边界（因此产品只标 Local Trusted，不宣称 Hardened）；两 CLI 的当前版本是否
  仍为采集日值。
- **由 unverified 决定的产品现状**：认证锁并发恒为 1（契约字面量，不是旋钮）；
  无人值守写入强制走节点检查点；能力未验证绝不标 verified。
- **当前没有的能力**：用户启动命令/守护进程、执行入口（501 骨架）、真实
  claude/codex 的联调运行、远程仓库操作（默认不做）。
- **待维护者确认（本仓不代行、不伪造）**：LICENSE 正式化与版权主体、
  GitHub CODEOWNERS、私密安全报告渠道、发布批准（M6-05）；清单见
  `reports/M6-03-release-security.md` 第 6 节。

## 10. 文档索引

- 产品与验收：`docs/PRD.md`、`docs/ACCEPTANCE.md`、`docs/REQUIREMENTS_BASELINE.md`
- 架构与计划：`docs/ARCHITECTURE.md`、`DEVELOPMENT_PLAN.md`、`docs/BACKLOG.md`
- 安全与治理：`AGENTS.md`、`GOVERNANCE.md`、`docs/SECURITY_MODEL.md`、`SECURITY.md`
- 平台矩阵与里程碑证据：`reports/M6-01-platform-matrix.md`、
  `reports/M6-02-backup-migration-cleanup.md`、`reports/M6-03-release-security.md`、
  `reports/M6-04-dogfood.md`
- 端到端演示包：`packages/e2e-baseline`、`packages/browser-e2e`、
  `packages/context-e2e`、`packages/dogfood`
