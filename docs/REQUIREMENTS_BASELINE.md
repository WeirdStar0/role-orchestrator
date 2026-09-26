# 需求冻结记录

基线：0.1-draft，2026-09-21。本文取代访谈中与用户最终回答冲突的示例。
“完整目标”指完整路线图，不表示第一次发布同时具备所有能力。

## 已确认需求

| ID | 冻结结论 | 约束 |
|---|---|---|
| R01 | 当前个人使用，本项目开源 | 后续付费团队版独立发布 |
| R02 | 首批仅接 Claude Code CLI、Codex CLI | 不做直接模型 API 后端、桌面自动点击 |
| R03 | 角色单选 Profile | 不投票、不辩论、不自动模型路由或模型 fallback |
| R04 | 内置四角色 | Coordinator / Architect / Developer / Reviewer |
| R05 | 复杂 DAG | AI 生成、用户编辑、受约束动态扩展 |
| R06 | 子任务权限按角色配置 | 模型只能提出请求，系统授权后落地 |
| R07 | 共享记忆与上下文 | 项目/任务/角色/执行分层，非复制完整对话 |
| R08 | Memory 分类授权 | facts、discoveries、decisions、rules、temporary 分开 |
| R09 | 执行级隔离 | Task 集成分支 + Execution 工作树 |
| R10 | 完整目标分期实施 | 企业能力在另一个产品版本中 |
| R11 | Profile 描述 CLI 运行环境 | 认证仍由 CLI 自己管理 |
| R12 | 每个角色一个 Profile | 同一 Profile 可供多个角色使用 |
| R13 | 当前不允许覆盖角色绑定 | Workflow/Task/Node 都不能指定 Profile 或模型 |
| R14 | Coordinator 选择角色，不选择模型 | 模型映射由用户配置决定 |
| R15 | DAG 可编辑 | UI 不提供节点 Profile 选择器 |
| R16 | 启动装配上下文、结束提取记忆 | 不跨 CLI 移植原始 session |
| R17 | 分类型管理记忆修改权限 | 不允许用记忆写入提升权限 |
| R18 | 实时事件日志 | WebSocket 展示，支持序号重放 |
| R19 | 风险分级介入 | 低风险 Agent，中风险 Coordinator，高风险用户 |
| R20 | 重试与返工有上限 | maxAttempts=3，maxReviewRounds=3，超限暂停 |
| R21 | Local Web + 本地 daemon | 桌面外壳后续考虑 |
| R22 | TypeScript 技术栈 | React/Vite、Fastify、SQLite/Drizzle、Zod、Vitest/Playwright |
| R23 | Windows 优先，跨平台架构 | macOS/Linux 功能逐步完成，分平台标识验证状态 |
| R24 | SQLite 元数据，文件存日志与产物 | Git 保存代码事实 |
| R25 | 不保存账号密码、Token 明文 | 使用 CLI 登录与凭据环境；仅保存引用/非敏感配置 |
| R26 | 从早期加入恢复机制 | 中断后 reconcile，再 Resume/Retry/Abort |
| R27 | 首版本地 Git | GitHub/GitLab 集成后续实现 |
| R28 | MCP 不充当核心编排协议 | 可在 Adapter 内桥接 CLI 的受控能力 |
| R29 | 轻量权限策略 | 不是团队 RBAC；实际约束必须有执行层支持 |
| R30 | Global/Profile/Project 并发限制 | 同时满足全部配额，不是简单对数字取最小 |
| R31 | 商业版卖协作、治理与托管 | 开源核心不锁角色、DAG、日志、记忆、审批 |
| R32 | 尽早 dogfooding | 在可回滚沙盒分支中使用，不能自我批准治理修改 |

## 为使方案可实现而补充的工程默认值

这些不是用户新增回答，可通过 ADR 修改，而不是重新开展全面访谈。

| ID | 工程默认值 | 理由 |
|---|---|---|
| D01 | 工作名 role-orchestrator | 后续可改，不影响领域模型 |
| D02 | RoleBinding 归属于 Project | 个人有多个仓库，保持明确边界 |
| D03 | TaskRun 创建时固定完整配置快照 | 执行中修改 Profile 不悄悄改变正在运行的任务 |
| D04 | 许可证 Apache-2.0 候选，发布前确认 | 支持开源核心与独立商业扩展；不是法律结论 |
| D05 | 主分支交付需用户确认 | 自动集成仅发生在工具托管的 task 分支 |
| D06 | 未知权限能力默认拒绝无人值守高风险执行 | 不把提示词或命令名称当安全控制 |
| D07 | Windows 原生与 WSL 为不同 execution target | 不混用 git、路径、CLI 和进程管理体系 |
| D08 | 有副作用的失败不能盲目重试 | 先检查进程、文件、Git 与外部操作结果 |
| D09 | 默认关闭 CLI 内部不受控子 Agent | 防止绕过角色绑定、DAG 预算与并发管理 |
| D10 | reviewer 源码逻辑只读，测试可写临时目录 | 测试不是纯读操作 |

## 明确排除

当前产品不提供节点级 Profile 覆盖、自动模型切换、按模型投票、用户自建新角色、
网页账号自动化、订阅限额规避、跨项目自动记忆共享、默认自动 push/deploy。
不把“任意可填写模型 ID”解释为“任意服务商必定兼容任意 CLI”。

## 变更规则

已确认项变更需有 Issue、影响说明与维护者批准。
R03/R13/R14 或安全边界变更必须有 ADR；既有 TaskRun 不回写新默认值。
