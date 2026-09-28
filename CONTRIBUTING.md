# 贡献指南

## 开始前

阅读 AGENTS.md、需求基线和开发计划。
从 docs/BACKLOG.md 选择可独立验收的任务，不以”实现全部系统”作为单个 PR。
仓库使用 pnpm workspace 管理 36 个项目：`pnpm install --frozen-lockfile && pnpm build && pnpm test`。

## 工作流程

Issue 定义目标、验收、允许路径、依赖与风险。
Architect/维护者确认接口与必要 ADR；Developer 在隔离分支实现；
Reviewer 检查候选提交与测试；维护者决定合并。
分支示例：feat/M0-02-fake-cli、fix/M2-04-parent-snapshot。
主干保持可验证；提交小步、可回滚，不混入无关重构。

## 验证

本包可执行：
`python -m pip install -r tools/requirements-plan.txt`
以及 `python scripts/validate_bundle.py --self-test`。

M0 后所有应用变更至少包含 typecheck、lint、相关 unit/integration 和 build；
用户流程变更补 E2E；CLI 升级补真实 smoke 与合约 fixtures。
PR 中附实际命令、结果、未验证项和原因。
不要提交账号、Token、session 原文、真实客户代码或包含秘密的测试样本。

## PR 要求

明确关联 Issue、需求 ID 与验收 ID。
改变配置字段时同步 Schema、examples、docs、迁移说明和负向测试。
影响恢复、权限、Git 集成和 Memory scope 的改动必须说明最坏失败情形。
新增依赖说明必要性和许可证；大变更先设计后编码。
不将自动生成内容作为免于审查的理由。

## DCO 与许可证

在正式许可确认后，建议所有提交使用 `git commit -s`，
以 Signed-off-by 表明按 DCO 提交。真实姓名/邮箱遵从贡献者自己的发布选择。
不得冒用他人身份或为未授权代码签名。
DCO 正文与适用依据参见 docs/SOURCES.md；本包不要求贡献者转让版权。

## AI 辅助

AI 可以草拟实现和测试，但提交者对来源、正确性、安全和许可负责。
说明哪些部分由 Agent 生成、人工验证了什么。不能只让同一生成过程自评后直接发布。
