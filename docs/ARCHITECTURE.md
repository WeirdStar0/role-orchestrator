# 架构设计

## 架构原则

业务核心不依赖 CLI 参数、数据库驱动或 HTTP 框架。
调度器是确定性软件，Coordinator 是产生计划与业务决定的 Agent。
Agent 输出只能作为待校验数据，不能直接修改调度状态、权限或角色绑定。
模块先使用同一 daemon 部署，通过清晰接口隔离；不提前拆成微服务。

```text
Browser UI / Local CLI
          |
   Local API + WebSocket  <-- Authentication / Host & Origin checks
          |
   Application Services
          |
   Role Resolver --- immutable TaskRun Config Snapshot
          |
   DAG Scheduler --- Policy Engine --- Approval Service
          |                  |
   Execution Runtime   Context Engine --- Memory / Artifacts
          |
   CLI Adapter Interface
       /             \
 Claude Code        Codex
       \             /
   Execution Target / Process Supervisor
          |
   Workspace Service --- Git Integration Service

Storage: SQLite state + outbox / filesystem artifacts + logs / Git code
```

## 模块边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| core | 图校验、调度规则、状态机、角色解析 | 拼接 shell、操作 UI |
| adapters | 能力探测、协议事件转换、会话标识 | 决定模型优先级、绕过审批 |
| runtime-local | 启停进程树、超时、日志、平台路径 | 解释业务需求 |
| git | snapshot、worktree、commit、串行集成 | 自动授权 push、强制覆盖 main |
| context | 记忆授权、检索、输入清单、预算截断 | 直接把 Agent 输出变成全局规则 |
| storage | 事务、迁移、outbox、文件完整性 | 自行决定任务是否成功 |
| api | 鉴权、参数校验、幂等请求、事件订阅 | 承担调度器实现 |
| web | DAG、diff、日志、审批交互 | 访问 CLI 认证文件 |

TypeScript monorepo 使用 pnpm + Turborepo。
前端 React/Vite、TanStack Router/Query、Zustand；
后端 Node.js/Fastify；SQLite/Drizzle；Zod 做运行时校验；
Vitest/Playwright 测试。M0 选择并锁定实测依赖版本，
不在规划包中声称任何依赖是“最新版本”。

## 调度与持久化

采用状态表 + 事务 outbox，不做全量事件溯源。
认领节点、分配资源租约、记录 Execution 与 outbox 在同一数据库事务内完成。
进程启动发生在事务外，通过 dispatchToken 和重启 reconcile 处理不确定窗口。
同一 project/task 的集成操作使用租约与 fencing token，旧持有者不能提交结果。

SQLite 单机写入由 daemon 管理；WAL、busy timeout 与备份需实测。
事务提交成功后再发布事件；WebSocket 掉线不影响后台状态。
大日志与产物先写临时文件、flush、原子 rename，随后存元数据；重启时处理孤立文件。

## Execution target

Windows-native 使用 Windows 路径、Git 与 CLI；WSL 使用 Linux 路径、Git 与 CLI。
Profile 的 target 与 Project 的 target 必须一致。
macOS/Linux 为扩展实现，不能因为 TypeScript 能运行就宣称全部能力已验证。
对于 `.cmd` 启动器，由专用 Windows launcher 解析，不通过字符串拼接用户输入；
能解析为 Node 脚本时用受信任 node 路径 + 参数数组执行。

## 可扩展边界

Adapter、SandboxProvider、SCMProvider、ArtifactStore 使用版本化接口。
首版仅 LocalRuntime + SQLite；RemoteWorker、Docker 不假装已经存在。
商业版可更换控制平面与授权服务，复用 open core 领域契约，但不能依赖共享订阅凭据。

## 不变式

任何已启动 Execution 都可追溯到项目、节点、配置 hash、输入 hash 和基础 Git SHA。
角色绑定只从 TaskRun 的项目快照解析。
执行能力不足时停止，不以关闭全部权限检查作为“自动修复”。
代码结果、记忆事实、审批决定均独立保存来源；模型文字不是执行证据。
