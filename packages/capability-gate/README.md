# @role-orchestrator/capability-gate

M0-06 的能力门注册表：把已验收 M0 报告中证实的能力状态与危险模式编码为带类型的、
经 Zod 校验的注册表数据，并导出纯查询函数。这是 M1（Profile 绑定、执行生命周期、
审批检查点）消费的起点数据 —— 本包**不含运行时拦截器**，是否执行、如何执行由消费方负责。

## 数据来源

- `reports/M0-03-claude-capability.md`（claude 2.1.278，8 次真实调用 + 2026-09-22 补采附录 2 次）
- `reports/M0-04-codex-capability.md`（codex-cli 0.154.0，9 次真实调用）
- `reports/M0-05-windows-launcher.md`（Windows 进程树/路径/PID/WSL 实测）
- `packages/cli-events/fixtures-real/`（脱敏真实流 fixture 与 manifest）
- 冻结治理文档：`docs/SECURITY_MODEL.md`、`docs/CLI_ADAPTERS.md`、`docs/ACCEPTANCE.md`

逐格状态与证据引用见 `reports/M0-06-capability-matrix.md`（本包 `CAPABILITY_RECORDS`
是该矩阵的机器可读孪生）。

## 导出

- `BLOCKED_ARGV_PATTERNS` / `isBlocked(argvText)` / `blockedPatternFor(argvText)`：
  argv 形危险模式（`--dangerously-skip-permissions` 命名族、codex `danger-full-access`、
  `--skip-git-repo-check` 环境门绕过）。
- `BLOCKED_ASSUMPTIONS` / `checkAssumption(id)`：被阻止的实现假设
  （codex 默认模式无人值守写、claude 非交互中途审批、未受控隐式加载、
  exit 0/subtype success 即业务成功、仅凭 PID 的身份判定、跨命名空间 PID、
  未验证能力按支持处理）。**未知 id 也返回 blocked（unknown-deny，fail-closed）**。
- `CAPABILITY_RECORDS` / `statusOf(capability)`：CLI × 能力维度的四态记录
  （verified / unsupported / unverified / blocked）。**未知能力 id 返回 unverified**
  —— 永不返回 verified。
- `isUsable(status)`：仅 `verified` 为真；能力未知绝不标记支持。

## 修改规则

1. 任何状态变更必须引用真实命令/真实 fixture 证据（报告章节 + 文件名），不接受推断。
2. 新增 blocked 条目必须有已验收证据；`requiredControl` 描述替代控制，不是本包行为。
3. 本包数据经模块加载时 `zod` 严格校验并拒绝重复 id —— 数据写错会在导入时立即失败。
