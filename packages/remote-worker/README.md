# @role-orchestrator/remote-worker

M7-03「验证可选容器/Remote Worker」的协议级仿真包。**仅设计/仿真，没有
真实运行时**：本包没有任何网络调用、没有真实容器、没有真实远程进程、没有
真实 TLS/mTLS 握手；交付的是严格 schema 的线协议 + 内存 fake transport +
模拟 worker + **真实的** `@role-orchestrator/store` 租约权威（`:memory:`
SQLite），以及一张 11 用例的故障注入矩阵（每个用例就是一个钉住测试）。
设计文档见 `reports/M7-03-remote-worker.md`。

## 边界声明（数据钉住，`src/tenancy.ts`）

- Remote worker **不是多租户安全**（NOT multi-tenant security）：它只是把
  同一个可信用户自己的执行放到另一台机器上，不隔离互不信任的主体。
- 一切证据均为**协议级仿真**证据；真实容器/远程运行时行为全部 unverified。

## 组成

- `src/protocol.ts`：线协议严格 schema（strictObject，未知字段拒绝）。
  命令：assign / cancel；事件：ack-assign / progress / heartbeat / result /
  cancel-confirmed / cancel-unconfirmed / cancel-after-terminal。success
  结果必须带 resultDigest（无证据不成功）；`cancel-confirmed` 的 receipt
  结构性不允许 unresolved（部分失败是另一种事件）；`posture` 字段是
  literal `local-trusted`——已授予的 Hardened 声明不可表达（A31）。
- `src/lease.ts`：控制面租约权威，**直接复用** `@role-orchestrator/store`
  的 `claimLease`/`releaseLease`/`releaseExpiredLeases`（真实迁移库）；
  新增 `validateWriteBack` 三择一判据：`no-live-lease` / `stale-token` /
  `lease-expired`——过期租约的写操作被拒绝，且槽位保持阻塞直到显式
  reconcile（超时只代表需 reconcile）。
- `src/transport.ts`：内存 fake transport + 故障注入：`seal()`（断缆，
  命令抛错、事件进 worker 重试箱）、`heal()`（重连，缓冲事件按原序晚到）、
  `dropInFlight()`（在途丢失）、`armDuplicateDelivery()`（重复交付）。
  按 executionId 路由入站事件（共享 bus 不偷别人的信）。
- `src/worker.ts`：模拟远端 worker——断缆后继续执行（僵尸）、at-least-once
  重试箱、命令级幂等（同 commandId 只重复 ack）、诚实树收据
  （`injectUnterminable` → `cancel-unconfirmed`，绝不谎报已杀，A26）。
- `src/session.ts`：控制面会话——事件管线顺序即契约（re-parse → 幂等键
  去重 → 归属守卫 → 终局后忽略 → fencing 校验 → 应用）；一个会话恰好一个
  终局；A22 未知路径 `observeUnknownOutcome` 落
  `RECOVERY_REQUIRED` + `autoRerun:false`，且**不归还租约**（本包没有任何
  重跑 API）。
- `src/auth.ts`：loopback token / mtls / 短期租约 token 三方案对比数据
  （威胁面逐字、验证格 literal unverified；推荐 mtls+租约 token 组合，
  同主机容器可 loopback+租约）。
- `src/posture.ts`：按 ExecutionTarget 的文件/网络/远端取消证据格
  （全部 literal unverified+null）；`resolvePosture("hardened", …)` 逐
  target 拒绝（HardenedPostureUnavailableError，引用 A31 与
  SECURITY_MODEL「不可选择」）；granted 词表只有 local-trusted，必附
  caveats（含多租户边界句）。
- `src/secrets.ts`：secret 引用面（`ref:<name>` 槽位名）+ 10 类凭据形态
  拒绝规则（含词界守卫的 `password=`/`token:` 赋值形态）——拒绝而非消毒
  （A42）。
- `src/matrix.ts` / `src/cases.ts` / `src/world.ts`：11 用例故障矩阵
  （RW-TRX-01/02、RW-LSN-01、RW-CXL-01..04、RW-EVT-01、RW-OUT-01、
  RW-SEC-01、RW-POST-01），用例函数用 `node:assert`（src 不依赖 vitest），
  每个用例即设计文档证据表引用的测试；world 提供迁移齐全的 `:memory:`
  库 + store 公共 API seed（满足 leases 外键）+ 注入式逻辑时钟。

## 测试（hermetic）

`pnpm test`（vitest）：`test/matrix-driven.test.ts`（12：注册表钉 + 11
用例）、`test/protocol-schemas.test.ts`（12：schema 严格性 / fencing 权威
/ 管线顺序）、`test/posture-auth.test.ts`（12：A31 姿态 / 认证对比数据 /
多租户边界 / secret 面）。零定时器、零网络、零临时文件。

## 明确不做

真实容器/远程执行、真实网络/握手、真实进程树终止、多租户隔离、任何自动
重跑路径（不存在对应 API）。以上任何一项的现实化都是独立的后续任务，必须
携带真实证据并走评审。
