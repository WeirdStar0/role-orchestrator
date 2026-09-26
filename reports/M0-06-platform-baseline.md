# M0-06 · 平台兼容基线（Windows 优先 + 扩展平台记录）

状态：已完成。角色：Architect（汇总）。日期：2026-09-22。
对应任务：`docs/BACKLOG.md` M0-06（验收 A31/A32/A33 方向）；`docs/DEVELOPMENT_PLAN.md` M0 门禁「Windows-native 是优先执行目标；WSL 单独记录，不能隐式替换」。

本文件汇总 M0 三份已验收报告中**按平台分开**的实测事实，并明确每个平台的验证边界。原则：未实测的平台上不声明任何支持；Node 版本特有行为标注为「当前实测版本」，不写成永久结论。

## 0. 平台矩阵总览

| 平台 | 状态 | 实测内容 | 证据 |
|---|---|---|---|
| win32-native（Windows 10.0.26100 x64） | **优先目标，已实测** | 两 CLI 真实调用、进程树终止、Unicode/空格/长路径/跨盘、PID 复用、cmd 启动语义 | `reports/M0-03-claude-capability.md`、`reports/M0-04-codex-capability.md`、`reports/M0-05-windows-launcher.md` §4 场景1–4 |
| WSL2 / Ubuntu（默认分发，wsl --status exit 0） | **单独记录（仅进程语义实测；CLI 行为未实测）** | setsid/进程组语义、POSIX 孤儿语义、跨命名空间 PID 不可混用 | M0-05 §4 场景5、§5 结论4 |
| WSL1 | **unverified（本机配置不支持，0 次实测）** | 无 | M0-05 §1（`wsl --status` 实测输出）+ §7 未验证项#1 |
| macOS / Linux-native | **unverified（无本机，0 次实测）** | 无 | `packages/contracts` EXECUTION_TARGETS 仅枚举目标，不构成验证；M0 无任何 macOS/Linux 证据 |

实测宿主：Node v25.0.0 / pnpm 10.14.0 / Git Bash 宿主 cmd.exe / 系统 locale zh-CN（控制台代码页 936/GBK）。

## 1. win32-native（已实测，产品优先目标）

已证实的平台事实（全部来自本机真实命令与盘上验证）：

1. **两 CLI 原生接入**：claude 2.1.278（8+2 次调用）、codex-cli 0.154.0（npm 包 `@openai/codex` → 平台二进制 `codex.exe`，经 mise shim 进入 PATH；9 次调用）。
2. **进程树终止**：`taskkill /PID <pid> /T /F` 是唯一内建树遍历终止；`/F` 对无窗口控制台程序必需；不带 `/T` 杀 `.cmd`/npm shim 会把整条 CLI 子树变成实测存活的孤儿（M0-05 §4 场景1）。
3. **进程启动**：spawn `.cmd` 必须经 `cmd.exe /d /c`（Node ≥18.20 直接 spawn `.cmd` 返回 EINVAL，CVE-2024-27980）；**不可用 `/s`**——实测 `/s` 剥掉外层引号后按空格截断含空格路径，`/d /c` 正常且 `exit /b` 退出码正确透传（M0-05 §4 场景2、§5 结论5）。
4. **路径**：中文+空格目录、420 字符脚本路径、H:→C: 跨盘全链路可用；本配置未观察到 MAX_PATH 260 限制（M0-05 §4 场景2）。但 Node 25 fs 缺陷见 §5。
5. **PID 身份**：PID 秒级复用（3000 spawn → 2099 个不同 PID，901 次复用；并发 600 无重复）；身份判定必须用 `(pid, name, parentPid, creationTime)` 三元组（Win32_Process），signal-0/PID-only 判定不可靠（M0-05 §4 场景4）。
6. **输出编码**：taskkill/cmd 的本地化输出为 GBK 文本，不可解析；唯一可靠信号是退出码 + Win32_Process 事后核对（M0-05 §5 结论7）。
7. **退出码语义**：被 `taskkill /F` 终止的进程对父进程呈现 exit code 1（非干净退出）——取消场景不得据此误报业务失败之外的错误细节（M0-05 §5 结论8）。

## 2. WSL2 / Ubuntu（单独记录，不与 native 混写）

实测（M0-05 §4 场景5，全部为真实 `wsl` 命令；WSL 内 Node v22.17.1 为发行版原生二进制）：

1. **setsid/进程组语义**：`setsid` 启动后 rootPid == PGID（生效）；`kill -9 <root>` 只杀 root，child/grandchild **存活**（POSIX 孤儿语义，与 Windows Node 25 父死级联相反）；`kill -9 -<PGID>`（负 PGID 组信号）全灭。→ WSL 内的树终止机制是**进程组信号**，不是 taskkill。
2. **跨命名空间 PID 不可混用**：Windows 侧对 Linux PID 的存活检查实测无意义（恒 false）。两侧 PID 命名空间互不可见；reconcile/取消语义必须按 execution target 分别定义，混用是 A29 方向的前置错误（对应 capability-gate blocked 假设 `platform.cross-namespace-pid`）。
3. **验证边界**：以上只是**进程语义**。两 CLI 在 WSL 内的安装、认证、协议行为 **0 次实测**（M0-03/M0-04 均为 Windows 原生）→ `wsl` target 上的 CLI 能力全部 unverified；产品不得把 win32 实测结论隐式推广到 WSL。

## 3. WSL1

本机 `wsl --status`（exit 0，UTF-16LE 输出已正确解码）明示「默认版本 2；本机配置不支持 WSL1」。**0 次实测** → WSL1 全部能力 unverified，产品层面视为「本环境不可用 + 未验证」，不得以 WSL2 结果替代声明。

## 4. macOS / Linux-native

无本机、无 CI 载体，**0 次实测** → 全部 unverified。`packages/contracts` 的 `EXECUTION_TARGETS` 枚举（`macos-native`/`linux-native`）只是目标世界模型，不构成任何验证声明。M6-01 要求「macOS/Linux 达标后逐项标识支持，不以 CI 编译成功替代真实 CLI 验证」——在此之前保持 unverified。

## 5. Node v25.0.0 特有发现（当前实测版本，非永久结论）

以下四项均为**本机 Node v25.0.0 + win32 实测**。它们随 Node/libuv 版本可能变化，升级/降级 Node 后必须重跑 `packages/process-lab` 五场景确认（M1-03 实现取消语义前的强制项）；本报告不声明具体引入版本，不做版本二分。

| 发现 | 实测内容 | 影响与对策 | 证据 |
|---|---|---|---|
| 父死级联（libuv kill-on-close 方向） | 杀 node root → 子孙随 root 一起死；**父进程正常退出（exit 0）同样触发**；`detached: true` 子进程豁免；杀 cmd shim 一级不级联（cmd 不是 node） | 不能把级联当终止机制：launcher 应解析真实 node PID（Win32_Process 父链）后 `/T /F`；必须存活的辅助进程显式 `detached: true` 并自行登记 PID；launcher 自身不 await 的清理子进程会被自己的退出级联吞掉 | M0-05 §4 场景1/场景3 级联边界 1–5、§5 结论2、§7 风险1 |
| `fs.cpSync`/`fs.rmSync` 非 ASCII 路径缺陷 | dst 含中文：`cpSync` 子进程硬崩溃 0xC0000409（零 stderr）/目录已存在时静默 0 拷贝；`rmSync`（单文件与 recursive）子进程崩溃或进程内静默无操作、文件仍在 | staging/清理禁用这两个 API，改用经验证原语白名单（`mkdirSync`/`copyFileSync`/`readdirSync`/`statSync`/`existsSync`/`writeFileSync`/`readFileSync`/`unlinkSync`/`rmdirSync`）的手写递归，并做事后 `existsSync` 验收 | M0-05 §4 场景2、§5 结论6、§7 风险2 |
| `cmd /d /c` 语义 | `/s` 剥外层引号 → 含空格路径按空格截断（exit 1、零输出）；`/d /c` 正常执行且退出码透传 | 启动器固定 `cmd.exe /d /c`，参数数组传递、不拼接 shell 字符串 | M0-05 §4 场景2、§5 结论5 |
| GBK 控制台输出 | taskkill/cmd 错误输出为 GBK 本地化文本 | 不解析子进程本地化文本；以退出码 + Win32_Process 事后核对为唯一信号 | M0-05 §5 结论7 |

## 6. 与能力矩阵和 gate 的衔接

- 能力矩阵的平台格子（`claude.platform-difference.win32-native` = verified；`*.platform-difference.other-platforms` = unverified）以本文件为准。
- blocked 假设 `process.pid-only-identity`、`platform.cross-namespace-pid` 把本文件 §1.5/§2.2 的教训编码进 `packages/capability-gate`，供 M1-03/M1-05 在实现取消与 reconcile 时拒绝危险设计。
- A29（Windows-native 与 WSL 路径混用 → 前置错误，不隐式转换执行）的数据面即 §2.2。

## 7. 未验证项汇总

1. WSL1：本机不支持，任何能力 0 实测。
2. macOS / Linux-native：0 实测。
3. WSL2/Ubuntu 内两 CLI 的安装、认证、协议、模型、resume 行为（仅进程语义实测）。
4. Node 25 级联行为的具体引入版本/上游提交（仅声明本机 v25.0.0 复现）。
5. `cmd /c` shim 在超长路径（>260）+中文+空格三者叠加的组合行为（M0-05 只单独验证了长路径直启）。
