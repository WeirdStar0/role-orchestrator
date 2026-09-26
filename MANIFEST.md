# 交付文件清单

本包包含 80 个文件。以下均为实际交付，不是未来目录占位。

应用 apps/ 与 packages/ 尚未实现；本清单中仅有规划、契约、配置与验证工具。


## 根目录与治理

| 文件 | 内容 |
|---|---|
| [.gitattributes](.gitattributes) | 仓库辅助配置 |
| [.gitignore](.gitignore) | 仓库辅助配置 |
| [AGENTS.md](AGENTS.md) | Repository Agent Instructions |
| [CHANGELOG.md](CHANGELOG.md) | Changelog |
| [CHECKSUMS.sha256](CHECKSUMS.sha256) | 逐文件 SHA-256；排除本摘要文件自身 |
| [CLAUDE.md](CLAUDE.md) | Claude Code repository instructions |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 社区行为规范 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |
| [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) | 开发计划 |
| [GOVERNANCE.md](GOVERNANCE.md) | 项目治理 |
| [LICENSE.proposed.txt](LICENSE.proposed.txt) | Apache-2.0 许可候选；未正式采用 |
| [MAINTAINERS.md](MAINTAINERS.md) | 维护者 |
| [MANIFEST.md](MANIFEST.md) | 文件清单 |
| [README.md](README.md) | 多模型角色编排工具 · 项目启动包 |
| [SECURITY.md](SECURITY.md) | 安全政策 |
| [START_HERE.md](START_HERE.md) | 开发启动入口 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方内容与归属记录 |
| [VERIFICATION.md](VERIFICATION.md) | 交付物验证 |
| [validation-report.json](validation-report.json) | 实际静态校验结果 |

## 产品、架构与工程设计

| 文件 | 内容 |
|---|---|
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 验收与测试矩阵 |
| [docs/API_AND_EVENTS.md](docs/API_AND_EVENTS.md) | API、事件与契约 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计 |
| [docs/BACKLOG.md](docs/BACKLOG.md) | 首批开发任务 |
| [docs/CLI_ADAPTERS.md](docs/CLI_ADAPTERS.md) | CLI Adapter 设计与兼容验证 |
| [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md) | 领域模型与数据设计 |
| [docs/GIT_AND_WORKSPACES.md](docs/GIT_AND_WORKSPACES.md) | Git、工作树与代码集成 |
| [docs/MEMORY_AND_CONTEXT.md](docs/MEMORY_AND_CONTEXT.md) | 共享记忆与上下文 |
| [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) | DAG 调度与任务生命周期 |
| [docs/PRD.md](docs/PRD.md) | 产品规格 |
| [docs/PROFILE_AND_MODEL.md](docs/PROFILE_AND_MODEL.md) | Profile、角色与模型 |
| [docs/REQUIREMENTS_BASELINE.md](docs/REQUIREMENTS_BASELINE.md) | 需求冻结记录 |
| [docs/RISKS.md](docs/RISKS.md) | 风险、验证缺口与发布阻断 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 开源与商业路线图 |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | 安全模型 |
| [docs/SOURCES.md](docs/SOURCES.md) | 外部证据与核实记录 |

## 架构决策记录

| 文件 | 内容 |
|---|---|
| [docs/adr/001-fixed-roles-and-binding.md](docs/adr/001-fixed-roles-and-binding.md) | ADR 001：固定四角色与单 Profile 绑定 |
| [docs/adr/002-cli-runtime-first.md](docs/adr/002-cli-runtime-first.md) | ADR 002：首批仅支持 Claude/Codex CLI |
| [docs/adr/003-execution-worktree.md](docs/adr/003-execution-worktree.md) | ADR 003：Execution 工作树与单 writer 集成 |
| [docs/adr/004-shared-memory.md](docs/adr/004-shared-memory.md) | ADR 004：受控共享记忆代替原始会话复制 |
| [docs/adr/005-local-state-and-outbox.md](docs/adr/005-local-state-and-outbox.md) | ADR 005：SQLite 状态表与事务 outbox |
| [docs/adr/006-dag-revisions-and-repair.md](docs/adr/006-dag-revisions-and-repair.md) | ADR 006：不可变执行定义与返工扩图 |
| [docs/adr/007-trusted-local-and-capabilities.md](docs/adr/007-trusted-local-and-capabilities.md) | ADR 007：可信本地与可验证强隔离分层 |
| [docs/adr/008-local-web-and-typescript.md](docs/adr/008-local-web-and-typescript.md) | ADR 008：Local Web 与 TypeScript 模块化单体 |
| [docs/adr/009-open-core-and-license.md](docs/adr/009-open-core-and-license.md) | ADR 009：开放本地核心与独立商业扩展 |
| [docs/adr/TEMPLATE.md](docs/adr/TEMPLATE.md) | ADR NNN：标题 |

## 配置与 Schema

| 文件 | 内容 |
|---|---|
| [config/README.md](config/README.md) | 配置说明 |
| [config/policies.yaml](config/policies.yaml) | 可验证示例；非本机已配置实例 |
| [config/profiles.example.yaml](config/profiles.example.yaml) | 可验证示例；非本机已配置实例 |
| [config/project.example.yaml](config/project.example.yaml) | 可验证示例；非本机已配置实例 |
| [config/result.example.json](config/result.example.json) | 可验证示例；非本机已配置实例 |
| [config/roles.yaml](config/roles.yaml) | 可验证示例；非本机已配置实例 |
| [config/task-request.example.json](config/task-request.example.json) | 可验证示例；非本机已配置实例 |
| [config/workflows.yaml](config/workflows.yaml) | 可验证示例；非本机已配置实例 |
| [schemas/execution-result.schema.json](schemas/execution-result.schema.json) | JSON Schema，拒绝未定义字段 |
| [schemas/policies.schema.json](schemas/policies.schema.json) | JSON Schema，拒绝未定义字段 |
| [schemas/profiles.schema.json](schemas/profiles.schema.json) | JSON Schema，拒绝未定义字段 |
| [schemas/project.schema.json](schemas/project.schema.json) | JSON Schema，拒绝未定义字段 |
| [schemas/roles.schema.json](schemas/roles.schema.json) | JSON Schema，拒绝未定义字段 |
| [schemas/task-request.schema.json](schemas/task-request.schema.json) | JSON Schema，拒绝未定义字段 |
| [schemas/workflows.schema.json](schemas/workflows.schema.json) | JSON Schema，拒绝未定义字段 |

## 契约、角色提示与检查脚本

| 文件 | 内容 |
|---|---|
| [contracts/README.md](contracts/README.md) | 契约草案 |
| [contracts/runtime.ts](contracts/runtime.ts) | TypeScript 设计契约，非运行时实现 |
| [prompts/architect.md](prompts/architect.md) | architect 角色提示模板 |
| [prompts/coordinator.md](prompts/coordinator.md) | coordinator 角色提示模板 |
| [prompts/developer.md](prompts/developer.md) | developer 角色提示模板 |
| [prompts/reviewer.md](prompts/reviewer.md) | reviewer 角色提示模板 |
| [scripts/validate_bundle.py](scripts/validate_bundle.py) | 规划包静态校验与正/负向自测 |
| [tools/requirements-plan.txt](tools/requirements-plan.txt) | 仓库辅助配置 |

## 项目流程与 GitHub 模板

| 文件 | 内容 |
|---|---|
| [.github/CODEOWNERS](.github/CODEOWNERS) | 注释模板，待填写真实账号 |
| [.github/ISSUE_TEMPLATE/bug_report.yml](.github/ISSUE_TEMPLATE/bug_report.yml) | Issue / CI 配置；未部署到远程仓库 |
| [.github/ISSUE_TEMPLATE/config.yml](.github/ISSUE_TEMPLATE/config.yml) | Issue / CI 配置；未部署到远程仓库 |
| [.github/ISSUE_TEMPLATE/feature_request.yml](.github/ISSUE_TEMPLATE/feature_request.yml) | Issue / CI 配置；未部署到远程仓库 |
| [.github/ISSUE_TEMPLATE/task.yml](.github/ISSUE_TEMPLATE/task.yml) | Issue / CI 配置；未部署到远程仓库 |
| [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) | 说明文档 |
| [.github/workflows/validate-planning.yml](.github/workflows/validate-planning.yml) | Issue / CI 配置；未部署到远程仓库 |
| [project/DEFINITION_OF_DONE.md](project/DEFINITION_OF_DONE.md) | Definition of Done |
| [project/LICENSING.md](project/LICENSING.md) | 许可与第三方治理 |
| [project/RELEASE_PROCESS.md](project/RELEASE_PROCESS.md) | 发布流程 |
| [project/REVIEW_POLICY.md](project/REVIEW_POLICY.md) | 代码评审政策 |
| [project/backlog.json](project/backlog.json) | 41 个 planned 任务，尚未导入远程平台 |
