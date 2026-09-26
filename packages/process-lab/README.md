# @role-orchestrator/process-lab

M0-05 Windows launcher / 进程树终止验证实验室。用真实命令（`taskkill`、
`cmd.exe`、PowerShell `Win32_Process` 查询、`wsl.exe`）对 launcher 关键语义
做可复现实验，并把可自动化部分固化为 vitest 测试。

**本包是观测工具，不是产品代码。** 事件数据全部来自 `@role-orchestrator/fake-cli`
（SYNTHETIC 标记）；不调用真实 claude/codex，不读取任何凭据。

## 覆盖的场景

| 场景 | 内容 | 验收方向 |
|---|---|---|
| cmd-wrapper | npm 风格 `.cmd` 包装器（`call node` + `%*` + 退出码传播）；`taskkill /T /F` 树杀 vs 不带 `/T` 的残留 | A26/A28 |
| unicode-path | 中文+空格目录下完整链路（dist 拷贝 + shim + cwd）；事件流完整性；未知参数 exit 2；>260 字符长路径观测 | A28 |
| cancel-semantics | 挂起 CLI 的单杀与树杀；root 被杀后 child/grandchild 孤儿状态可观测化（PID + 存活 + 身份） | A26 |
| pid-reuse | 短命进程 cohort 间 PID 值复用观测；(pid, name, parent, creationTime) 身份判定机制 | A27 |
| wsl | `wsl --status` 只读探测；可用时在默认发行版内跑 grandchild 场景：单杀留孤儿、负 PGID SIGKILL 全灭 | A29 |

## 用法

```bash
pnpm build                       # 仓库根先构建（fake-cli dist 必须存在）
node dist/experiments/main.js cmd-wrapper        # 场景 1，打印 JSON 并以退出码表达结论
node dist/experiments/main.js unicode-path       # 场景 2
node dist/experiments/main.js cancel-semantics   # 场景 3
node dist/experiments/main.js pid-reuse          # 场景 4
node dist/experiments/main.js wsl                # 场景 5
pnpm test                        # vitest 全部自动化场景
```

实验驱动打印 JSON 记录（每个真实命令的 argv、退出码、观测值），退出码 0 仅当
场景预期行为成立；WSL 缺失属于环境事实，返回 `verified:false` 且退出码 0。

## 关键机制说明

- **身份判定**：`isAlive(pid)`（signal 0）在 PID 复用后会误报；`queryProcessIdentity`
  用 PowerShell `Get-CimInstance Win32_Process` 取 (pid, name, parentPid,
  creationTime)，创建时间戳是复用判别的依据。`expectPidGone` 两者结合。
- **`.cmd` 启动**：Node ≥ 18.20 出于 CVE-2024-27980 直接 spawn `.cmd` 返回
  EINVAL，必须经 `cmd.exe /d /s /c <shim>`；这正是树杀问题的来源（cmd 与
  node 不共享 job）。
- **清理安全**：所有测试/实验通过 `TreeRegistry` 在 finally 中对登记的树执行
  `taskkill /T /F`，断言失败不会泄漏挂起进程。

实测结论与 launcher 设计建议见 `reports/M0-05-windows-launcher.md`。
