# role-orchestrator · 多模型角色编排工具

开源、本地优先的 CLI Agent 编排工具：用浏览器界面与本地常驻进程，把
Claude Code CLI 与 Codex CLI 统一调度进 Coordinator / Architect / Developer /
Reviewer 四个固定角色。每个项目的每个角色单选一个 Profile（不允许多重绑定，
不允许 Workflow / Task / Node 覆盖，不自动替换模型），以可动态扩展的 DAG、
共享记忆、执行级 Git Worktree、代码集成、验证与人工审批完成复杂开发任务。

## 当前状态

- **v0.1.0-rc 已通过维护者验收**（2026-09-25，记录见
  [reports/MAINTAINER-ACCEPTANCE-2026-09-25.md](reports/MAINTAINER-ACCEPTANCE-2026-09-25.md)）。
- pnpm workspace 34 个包、1500+ 测试；GitHub Actions 双平台门禁
  （ubuntu 全门禁 + windows 原生路径/进程面）。
- 平台定位诚实陈述：执行路径（进程生命周期、进程树终止、Win32 身份探针）
  当前实现为 **Windows 优先**；ubuntu CI 跑全部测试，平台专属用例按显式
  门控跳过并在输出中声明。Linux/macOS 原生执行在契约中预留，尚未实现。

## 快速开始

```bash
# 前置：Node.js >= 20（推荐 25，见 packages/runtime-profile 的 engines）、pnpm 10.14
# 仓库根提供 mise.toml：mise install 可一次装齐 node/pnpm/python
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm test
```

- 规划包静态自检（配置 / Schema / DAG / 权限 / 文档链接 + 负向测试）：
  `python scripts/validate_bundle.py --self-test`（依赖见
  tools/requirements-plan.txt；仓库内直跑因 node_modules 断链按已知问题
  exit 1，干净副本内 exit 0——由 `node planning-check.mjs` 统一校验）。
- 浏览器端到端（可选）：`npx playwright@1.61.0 install chromium` 后运行
  `packages/browser-e2e`。
- 端到端演示：`packages/dogfood`（全链路 + 失败注入 + 恢复）、
  `packages/e2e-baseline`（并行开发基准）。

## 仓库结构

实际交付为 pnpm workspace：`packages/` 下 contracts、store、dag、
scheduler、engine、runtime-profile、approval、checkpoint、review、
context、memory、memory-search、worktree、integration、reconcile、
local-api、cli-events、expand、maintenance、release-audit、
boundary-audit、fault-matrix、process-lab、fake-cli、dogfood、
e2e-baseline、browser-e2e、context-e2e、implicit-verify、plugin-registry、
remote-worker、scm-contracts 等包，另含 `scripts/`（规划包校验器）、
`config/`（配置协议示例）、`schemas/`（JSON Schema）、`contracts/`
（TypeScript 设计契约）、`docs/`（需求/架构/验收矩阵/ADR）。
规划期清单见 [MANIFEST.md](MANIFEST.md)。

## 文档地图

1. [需求冻结记录](docs/REQUIREMENTS_BASELINE.md) 与 [产品规格](docs/PRD.md)
2. [架构](docs/ARCHITECTURE.md)、[开发计划](DEVELOPMENT_PLAN.md)、[验收矩阵](docs/ACCEPTANCE.md)
3. [Agent 规范](AGENTS.md)、[治理](GOVERNANCE.md)、[贡献流程](CONTRIBUTING.md)
4. [安全模型](docs/SECURITY_MODEL.md)、[风险与待验证项](docs/RISKS.md)
5. 决策记录见 [docs/adr/](docs/adr/)；发布流程见
   [project/RELEASE_PROCESS.md](project/RELEASE_PROCESS.md)

## 安全边界

Worktree 分离代码目录，但不是安全沙箱。
Local Trusted 模式仅用于用户明确信任的仓库；强隔离能力必须通过实测后才能标记可用。
本地运行不等于模型离线运行，代码与上下文仍可能由 CLI 发送到配置的服务商。
不导出 CLI 认证凭据，不共享跨项目记忆，不默认操作远程仓库。

## 许可证与安全

- 许可证：Apache-2.0（2026-09-25 正式采用，见 [LICENSE](LICENSE)；
  治理记录见 [GOVERNANCE.md](GOVERNANCE.md) 与 [MAINTAINERS.md](MAINTAINERS.md)）。
  第三方依赖归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 的渠道私密报告，不要开公开 Issue。
