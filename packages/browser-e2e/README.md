# @role-orchestrator/browser-e2e — M5-05 五类浏览器端到端基准

纯测试/驱动包（无产品逻辑）：用**真实 Chromium 浏览器**驱动 `@role-orchestrator/local-api`
的本地事件页，把五条用户流程走完并留下**真实截图与驱动日志**证据；同时固定 A38/A39
的浏览器层回归。产物只在本包与系统临时目录内——`H:\role-orchestrator` 保持非 git 状态。

## 五流程 ↔ 验收映射

| 流程 | 测试文件 | 走的真实链路 | 浏览器层断言（全部读 DOM，非 HTTP 状态码） | 验收 |
|---|---|---|---|---|
| 顺序 | `test/flow-1-sequential.test.ts` | dag 建图 → scheduler 派发 → engine（fake-cli dist bin 真子进程）→ worktree → writer commit | 初始画布（READY/PENDING）→ 运行中 SVG 显示 `s2 RUNNING`（中途截图）→ 终态全 `SUCCEEDED` 且 SVG class 由 `node-state-PENDING` 变为 `node-state-SUCCEEDED`；执行详情与事件列表在页面加载渲染 | M5-05 范围；运行节点无编辑表单（A38 前半）、编辑载荷构造器拒绝 model/Profile（A02 UI 层） |
| 并行 | `test/flow-2-parallel.test.ts` | 同上；两个分支同角色→同 Profile→同凭据组，未验证凭据并发上限 1（A33/A07） | SVG 显示一支 `RUNNING` 而另一支未启动（串行化的 UI 呈现，截图）；旁证：调度器凭据配额拒绝 `credential:creds-codex 1/1` + 两支执行墙钟窗口不相交 | M5-05 范围 |
| 返工 | `test/flow-3-rework.test.ts` | 首轮 reviewer 真链路验证失败（内容缺失）→ 受控扩图协议（A04 权限校验、A38 乐观锁、A20 三轮封顶）→ 修复/复审真链路 | 扩图 Proposal 卡（fail 原因/findings）在页面可见；页内提交扩图请求后**画布出现铸造节点 `int-fix-2`/`int-review-2`**；复审 verdict=pass 绑定新 candidateSha（A12，旧 candidate 查询返回 invalidated） | M5-05 范围（A20 语义延续） |
| 审批 | `test/flow-4-approval.test.ts` | 检查点提案（A19：执行已结束、节点 WAITING_APPROVAL）→ 审批守卫迁移 → `continueAfterApproval` 消费审批并铸造续行执行（真 fake-cli 子进程）→ 集成产生候选 | 审批卡**决策前展示完整动作要素**（完整 argv、目标/基线 SHA、仓库根、cwd、冻结 Profile revision、权限增量、风险等级 high、过期时间、风险原因）；全页无全局放权词汇（A17）；页内批准后显示已批准；diff 面板显示 candidateSha + 统一 diff | M5-05 范围（A17/A18 语义延续） |
| 恢复 | `test/flow-5-recovery.test.ts` | A24 启动窗口中断（STARTING + 待派发 outbox + 无 pid）→ reconcile 判 recovery-required → dag 桥落 RECOVERY_REQUIRED → `resolveRecoveryRequired`（人工解决）→ 第 2 次尝试真链路重试成功 | SVG 显示 `r2 RECOVERY_REQUIRED`（截图）；中断执行的详情面板显示 STARTING（未终态）；RECOVERY_REQUIRED 期间第二次尝试被拒（A22 不自动重跑）；重试后终态画布 + 事件页 | A22 |
| A38 回归 | `test/a38-stale-edit-conflict.test.ts` | 页面持有旧 graphRevision；另一操作会话经受守卫的 HTTP API 先行改图 | 过时 revision 提交 → 409 `GRAPH_REVISION_CONFLICT` → **UI 显示冲突提示**（「冲突：…(A38) —— 请重新加载任务图」），请求被丢弃、定义历史只追加不改写；编辑表单字段集恰为 role/objective/dependencies（A02） | A38 |
| A39 回归 | `test/a39-ws-replay-dedup.test.ts` | 浏览器页内（`page.evaluate`，同源受 CSP `connect-src 'self'` 约束）运行真实 WebSocket 客户端：首帧 auth + subscribe | 连接 1 收全量事件后**断开**；离线追加事件；连接 2 以过时 `afterEventId` 游标重连 → 服务端 at-least-once 重放（原始并集确有重复帧）→ **按 eventId 去重后无丢失无重复**（逐条等于库中事件集、seq 无空洞）；两连接都收到 `execution-terminal` | A39 |

## 驱动选型（本机实测）

选 **playwright-core@1.61.0（精确锁定）+ Chromium revision 1228**，理由：

- 本机探测（2026-09-23，win32）：`%LOCALAPPDATA%\ms-playwright\chromium-1228` 已有完整安装
  （`INSTALLATION_COMPLETE` + `DEPENDENCIES_VALIDATED`）；playwright-core 1.61.0 的
  `browsers.json` 恰好要求 revision 1228，版本对齐、无需下载。
- 已实测启动并读页成功（launch → `page.setContent` → 读回文本，Chromium 149.0.7827.55）。
- 相比 puppeteer-core+系统 Edge/Chrome：锁定 registry revision 后浏览器版本确定，截图可复现；
  playwright 的等待/选择器语义更贴合本包的 DOM 断言。
- 若本机缺少该 revision 的浏览器：启动会**显式失败**（`BrowserLaunchError`，附补救命令），
  相关流程如实报 unverified——绝不伪造截图。

### 运行前提

1. Node >= 25（`node:sqlite`），pnpm 10.14，仓库已 `pnpm install`。
2. **必须先构建 fake-cli**（全程 dogfood 唯一 CLI，绝不调用真实 claude/codex）：
   仓库根执行 `pnpm build`。缺 dist bin 时 world 会抛 `FakeCliNotBuiltError`。
3. Chromium revision 1228。若本机缓存缺失，执行：
   `npx playwright@1.61.0 install chromium`
   （下载到 `%LOCALAPPDATA%\ms-playwright\chromium-1228`，与本包锁定的 1.61.0 对齐。）
4. 本机有可用 git（fixture 仓库与集成分支需要；只允许在系统临时目录内执行）。

## 运行方式

```bash
# 单包（在 packages/browser-e2e 下）
pnpm test        # vitest run —— 七个测试文件并行，每个文件独立 world+服务器+浏览器
# 全仓
pnpm test        # turbo run test（本包自动纳入 workspace/turbo，无额外登记）
```

turbo 的 `test` 任务依赖 `^build` + `build`，因此 `pnpm test` 会先完成 fake-cli 等构建。

## 截图与日志证据

- 位置：`packages/browser-e2e/evidence/<测试标签>-<UTC 时间戳>/`
- 每个流程目录包含：
  - 编号命名的**真实浏览器截图**（初始画布 / 关键中间态 / 终态，全页 PNG）；
  - `driver.log.txt`——驱动日志（世界参数、服务器端口、每轮派发、每次 DOM 读回的
    状态串、每次截图的 URL、清理记录）；
  - 少量结构化产物（如 A39 的 `a39-ws-frame-transcript.json` 帧转录）。
- 每次运行生成新目录（不覆盖历史证据）；A39/A38 回归目录同样带截图/转录。

## 隔离与清理

- 浏览器：headless Chromium，每个测试文件**独立 BrowserContext（一次性用户资料目录）**，
  结束即 `browser.close()` 杀掉实例并丢弃资料目录。
- local-api：`startLocalApiServer` 绑定 `127.0.0.1` 随机端口；会话令牌只在内存与仅当前用户
  可读的临时文件中，从不进入 URL 或截图可读区（截图里令牌框为密码域）。
- store/git：数据库与 fixture 仓库都在 `os.tmpdir()` 的 scratch 树内；git 只在该树内执行；
  teardown 用 `removeTreeRobust`（M0-05 白名单原语）整树删除。
- 端口：临时端口，服务器关闭后由内核回收。

## 边界说明（诚实声明）

- 本包的 pump/世界是**基准 harness**（与 M2-06 e2e-baseline 同一纪律）：writer 的文件提交
  （`commitNodeOutput`）与 reviewer 的验证命令是"受控 Git Service 提交步"落地前的替身，
  有注释标明；所有配额、状态机、集成、审查语义都来自产品包。
- 「人工解决」恢复步骤由驱动以 `resolveRecoveryRequired` 执行——这是运营者决策动作，
  页面（按当前设计）不提供该按钮；浏览器层断言覆盖 RECOVERY_REQUIRED 的显示与重试后的终态。
- A39 的服务端会话存续期间持续补发 `catchup` 帧（轮询语义）；浏览器客户端把 terminal 之后
  的 catchup 视为保活噪声，不会据此把"静默"误判为未完成。
- 本包交付中发现并修复了 local-api 页面执行面板的一个**既有接线缺陷**（`wireDom` 未解包
  `{schemaVersion, execution}` 响应体，真实浏览器下执行详情渲染为 undefined）；修复为
  一行解包，local-api 既有测试全部保持通过（该接线此前无任何测试覆盖）。
