# 多模型角色编排工具 · 项目启动包

工作名：`role-orchestrator`。文档基线：`0.1-draft`，2026-09-21。
本文档包是需求、设计、开发计划和项目治理的交付物，不是已经实现的应用。
工作名不代表已完成商标、域名或包名查重。

## 产品定义

开源、本地优先、Windows 优先的 CLI Agent 编排工具。
使用浏览器界面与本地常驻进程，统一调度 Claude Code CLI 和 Codex CLI。
内置 Coordinator、Architect、Developer、Reviewer 四个角色；
每个项目中的每个角色单选一个 Profile，不允许 Workflow、Task、Node 覆盖，
不自动替换模型。Profile 可以被多个角色引用。

通过可编辑、可动态扩展的 DAG、共享记忆、执行级 Git Worktree、
代码集成、验证与人工审批完成复杂开发任务。
完整目标分期交付，不把未来能力写成当前已实现功能。
未来付费团队产品单独发布，复用开源核心，不削弱本地编排能力。

## 阅读顺序

1. [需求冻结记录](docs/REQUIREMENTS_BASELINE.md) 与 [产品规格](docs/PRD.md)
2. [架构](docs/ARCHITECTURE.md)、[开发计划](DEVELOPMENT_PLAN.md)、[首批任务](docs/BACKLOG.md)
3. [Agent 规范](AGENTS.md)、[治理](GOVERNANCE.md)、[贡献流程](CONTRIBUTING.md)
4. [配置说明](config/README.md)、[验收矩阵](docs/ACCEPTANCE.md)
5. [风险与待验证项](docs/RISKS.md)、[证据来源](docs/SOURCES.md)

## 本包包含的可用内容

`config/` 是拟定配置协议的有效示例，`schemas/` 是 JSON Schema。
`contracts/` 是供实现使用的 TypeScript 接口草案。
`scripts/validate_bundle.py` 可验证配置、DAG、权限约束和内部文档链接，
并运行拒绝危险配置的负向测试。
这些内容尚未经过真实 CLI 联调；不能运行 `orchestrator start`。
本包没有应用运行时代码，没有依赖锁文件，也没有声称已通过产品测试。

文档包检查（Python 仅用于这份交付物的静态检查，产品技术栈仍为 TypeScript）：

```bash
python -m pip install -r tools/requirements-plan.txt
python scripts/validate_bundle.py --self-test
```

## 决策状态

用户确认项与工程默认值分开记录于需求冻结文档。
许可证建议为 Apache-2.0，候选文本在
[LICENSE.proposed.txt](LICENSE.proposed.txt)，尚未作为仓库 LICENSE 生效。
公开发布前须由维护者确认许可证、版权主体、GitHub CODEOWNERS 身份和安全联系渠道；
在许可证正式采用之前，不应对外声称代码已经完成开源授权。

## 安全边界

Worktree 分离代码目录，但不是安全沙箱。
Local Trusted 模式仅用于用户明确信任的仓库；强隔离能力必须通过实测后才能标记可用。
本地运行不等于模型离线运行，代码与上下文仍可能由 CLI 发送到配置的服务商。
不导出 CLI 认证凭据，不共享跨项目记忆，不默认操作远程仓库。

## 后续仓库结构（尚待创建）

```text
apps/web                 React + Vite 管理界面
apps/daemon              Fastify 本地 API 与任务进程
apps/cli                 启停、诊断、导入配置
packages/contracts       公共契约与事件
packages/core            DAG、状态机、策略、角色解析
packages/adapter-claude   Claude CLI 适配
packages/adapter-codex    Codex CLI 适配
packages/runtime-local   进程生命周期与平台实现
packages/git             快照、worktree、集成
packages/context         共享记忆与上下文装配
packages/storage         SQLite、迁移、文件存储
packages/testing         Fake CLI、事件样本、故障注入
```

实际交付文件以 [MANIFEST.md](MANIFEST.md) 为准。
实际验证范围见 [VERIFICATION.md](VERIFICATION.md)；开始开发使用 [START_HERE.md](START_HERE.md)。
