# Changelog

## Unreleased

### Added
- M8-01 真实 CLI 受控联调窗口执行完毕——双 CLI 8 项 unverified 格闭合，18 文件脱敏 fixtures 入 `packages/cli-events/fixtures-real/m8-01-2026-09-28/`
- M8-02 新包 `packages/model-stats`：模型性能统计只读基础设施（UsageEvent strict schema / 双 CLI JSONL 解析器 / PerformanceStore 只追加 / report() / BudgetRefinement stub）
- M8-03 桌面壳 ADR（`reports/M8-03-desktop-shell-adr.md`）：Electron vs Tauri v2 vs Neutralino.js 五维选型 + 威胁建模（Proposed，待维护者批准后进实现批次）
- M8 里程碑三项正式立项入 BACKLOG（44 项）

### Changed
- 测试基线 1548→1593（+45 model-stats）
- workspace 项目 35→36（新增 model-stats）

## 0.1.0-rc — 2026-09-26

规划包 0.1-draft 的全部 41 项开发任务（M0–M7）已实现并验收：
35 个 workspace 项目、1523 项测试全绿，各批次均经 10 轮连续独立审查
（开发/修复由 GLM-5.3-Flash 执行、审查由 GLM-5.3 执行，任何一轮失败清零重审）。

已实现（implemented）：

- 单任务持久化闭环：Profile 绑定、执行、事件、SQLite/outbox、最小页面；
- DAG 并行调度、资源租约、执行 worktree、集成与候选审查；
- 上下文与共享记忆（来源、权限、CAS、检索、注入防线）；
- 风险分级、一次性审批（actionDigest）、检查点、受控扩图、重试与预算、
  故障注入矩阵与恢复；
- 本地页面与 API（回环 + 令牌 + CSRF + 严格 CSP）、WS 实时事件、诊断导出；
- 备份、迁移与安全清理（升级演练、containment 守卫）；
- Windows 原生路径/进程/取消/权限/认证矩阵；
- SCM 集成、插件注册表、Remote Worker、商业边界的契约与协议级验证。

experimental / 设计验证（未接真实服务）：真实 GitHub/GitLab 调用、
真实容器与 Remote Worker 运行时、插件真实加载器（已交付 manifest 与
加载决策契约）。

unverified（按 unknown-deny 拒绝声明）：真实 claude/codex 联调、
macOS/Linux/WSL 原生、Hardened 沙箱边界、CLI 当前版本相对采集日漂移。

当前没有：用户启动命令/守护进程；执行入口 `POST
/api/v1/executions/:id/dispatch` 为鉴权完整的 501 骨架；全部端到端演示
使用 fake-cli 合成 CLI。发布状态：pending-maintainer（见
`project/RELEASE_PROCESS.md` 与 `reports/M6-05-release-candidate.md`）。

## 0.1-draft — 2026-09-21

形成 32 项需求冻结记录、四角色/单 Profile 约束、CLI 适配与能力验证方案、
DAG/Memory/Git/审批/恢复架构、分阶段开发计划与验收矩阵。
加入治理文件、ADR、示例配置、Schema、TypeScript 契约和规划包静态校验。
本版本为规划交付物，不包含可运行的 Orchestrator 应用。
