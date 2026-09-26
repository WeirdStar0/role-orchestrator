# M0-05 · Windows launcher 与进程树终止验证报告

状态：已完成（检查单 A26/A27/A28/A29 方向全部覆盖；0 次 blocked；真实 claude/codex 调用 0 次——本任务全部结论由 fake-cli + 真实 OS 命令（taskkill/cmd.exe/PowerShell/wsl.exe）产出，无需消耗真实调用配额，符合约束 6 的节流要求）。
对应任务：docs/BACKLOG.md `M0-05`（依赖 M0-01/M0-02 已完成）。角色：Developer。
日期：2026-09-22（本地时区 UTC+8，实验发生于 01:44–02:30）。所有结论绑定本报告记录的真实命令退出码与观测输出；无任何手写 PASS。

## 1. 环境与实测版本

| 项 | 值 | 来源 |
|---|---|---|
| OS | Windows 10.0.26100 x64（系统 locale zh-CN，控制台代码页 936/GBK） | 本次实测 |
| Node / pnpm | v25.0.0 / 10.14.0 | 本次实测 |
| shell 层 | Git Bash 宿主 cmd.exe | 本次实测 |
| WSL | 可用（`wsl --status` exit 0）：默认分发 Ubuntu，默认版本 2；本机配置不支持 WSL1 | 场景 5 实测 |
| WSL 内 Node | v22.17.1（Linux 原生二进制，非 Windows 互操作） | 场景 5 实测 |
| fake-cli dist | 18 个文件（`pnpm build` 后拷贝基线） | 场景 2 计数 |
| PowerShell | powershell.exe 5.1（Win32_Process 查询通道） | 本次实测 |

## 2. 交付物

- 新包 `packages/process-lab`（观测实验室，不含产品代码，无包依赖它）：
  - `src/`：taskkill 封装、Win32_Process 身份查询（pid/name/parent/creationTime）、npm 风格 `.cmd` shim 生成、fake-cli dist 安装（Unicode 安全拷贝）、PID 复用 cohort 观测、WSL 探测与 POSIX 驱动生成、`TreeRegistry` 清理安全网；
  - `src/experiments/`：五场景实验驱动（`node dist/experiments/main.js <scenario>`，JSON 记录 + 退出码表达结论）；
  - `test/`：5 个 vitest 文件、10 个自动化测试（复用 cli-events 测试工具的思路，未改动其代码）；
  - `README.md`：用法与机制说明。
- 本报告（`reports/M0-05-windows-launcher.md`）。
- `pnpm-lock.yaml`：新增 process-lab importer（`pnpm install` 正常依赖变更；不在 CHECKSUMS.sha256 记录内，`pnpm run planning:check` 通过验证）。

冻结面核对：`pnpm run planning:check` exit 0（(a) CHECKSUMS.sha256 全部 78 个记录文件逐一 sha256 校验通过——AGENTS.md、docs/、schemas/、config/、prompts/、project/、contracts/、scripts/、.github/ 零改动；(b) 干净副本内 `python scripts/validate_bundle.py --self-test` exit 0）。本仓库非 git 仓库，无 git 写操作。

## 3. 检查单逐项结论

| 验收 | 场景 | 结论 | 依据 |
|---|---|---|---|
| A26 | 任务取消但 shell 启动孙进程 | **verified（含重大行为发现）** | §4 场景 1/3：杀 `.cmd` shim（不带 /T）→ node 子树全部存活为孤儿；杀 node root（不带 /T）→ 在 Node v25 上子孙**随 root 一起死**（libuv 父死级联）；`/T /F` 永远全灭。三种结果均可观测化（PID + 存活 + 身份三元组） |
| A27 | PID 被其他进程复用 | **verified** | §4 场景 4：3000 个短命进程仅 2099 个不同 PID（901 次复用）；cohort 实验稳定在 1–3 轮内观测到碰撞；同 PID 的新持有者以 Win32_Process creationTime 区分 |
| A28 | 中文/空格/长路径/不同盘符/.cmd | **verified** | §4 场景 2：中文+空格目录全链路 exit 0、事件流完整、未知参数 exit 2；420 字符脚本路径 exit 0；H:→C: 跨盘拷贝正常；`cmd /s` 引号剥离陷阱实测复现（必须 `/c`）；Node cpSync/rmSync 在非 ASCII 路径崩溃/静默失效（0xC0000409）——已用经验证原语绕开 |
| A29 | Windows-native 与 WSL 混用 | **verified（WSL 侧）** | §4 场景 5：WSL 内同样场景单杀留孤儿、负 PGID SIGKILL 全灭；Windows 侧对 Linux PID 的存活检查结果无意义（实测 false）。两侧结果分开记录，未混写 |

## 4. 场景明细（实测命令、退出码、观测）

### 场景 1 · npm `.cmd` 包装器与树杀（`node dist/experiments/main.js cmd-wrapper`，exit 0；vitest 3 条）

shim 内容为代表性 npm 风格包装器：`@ECHO OFF` + `SETLOCAL` + `SET "_TARGET=%~dp0fake-cli-dist\bin\fake-claude.js"` + `call node "%_TARGET%" %*` + `ENDLOCAL & EXIT /B %_CODE%`。

实测进程树（Win32_Process 父链枚举，树走查 probe 输出）：

```text
node(实验进程)
└─ cmd.exe <shim>                       ← spawn .cmd 必须经 cmd.exe（见发现 8）
   ├─ conhost.exe                       ← cmd 的控制台宿主
   └─ node.exe（fake root，call node 启动）
      └─ node.exe（child）
         └─ node.exe（grandchild）
            └─ conhost.exe              ← grandchild 的控制台宿主
```

| 步骤 | 命令 | 退出码 | 观测 |
|---|---|---|---|
| 树杀 | `taskkill /PID <shim> /T /F` | 0 | stdout（GBK）逐条列出终止了 **6 个 PID**：整条链 + 2 个 conhost；cmd 退出码 1（非干净退出）；四个关键 PID 全部确认死亡 |
| 单杀 shim | `taskkill /PID <shim> /F`（无 /T） | 0 | taskkill 只点名 shim；shim 死；fake root/child/grandchild **全部存活**，且创建时间戳与杀前一致（证明是原进程而非 PID 复用巧合）→ 孤儿树；随后对 root `taskkill /T /F`（exit 0）全灭 |
| 退出码传播 | shim 分别跑 `--scenario success` / `error-result` / 未知参数 | 0 / 1 / 2 | `call node` + `EXIT /B %ERRORLEVEL%` 正确逐级传播；未知参数被 fake CLI 严格拒绝（exit 2），证明 argv 经 shim 完整透传 |

### 场景 2 · Unicode/空格路径、长路径、不同盘符（`node dist/experiments/main.js unicode-path`，exit 0；vitest 1 条）

- 中文+空格目录（形如 `process-lab 中文 目录 带空格-XXXXXX`，位于 C: 临时目录；仓库在 H: → 跨盘）下：拷贝 dist（18 文件）、写 shim、以该目录为 cwd 启动 → `--scenario success` **exit 0**，stderr 含 SYNTHETIC banner，stdout 7 行全部为合法 JSON，末行 `result.is_error=false` 且带 `structured_output`；真实形态参数（`-p --output-format stream-json --model <v>`）被接受；未知参数 **exit 2**。
- **`cmd /s` 引号剥离陷阱（实测复现）**：`cmd.exe /d /s /c "<含空格路径>\x.cmd"` → cmd 剥掉外层引号后按空格截断，报「`C:\...\proc-lab` 不是内部或外部命令」，exit 1、零输出；改用 `/d /c`（无 /s）后同一 shim 正常执行且 `exit /b 7` 的 7 正确透传。不带 /s 时 cmd 的两引号规则会保留引号。
- **Node 25.0.0 / win32 fs API 在非 ASCII 路径上损坏（本次最重要的工程发现之一）**：
  - `fs.cpSync(src, dst, {recursive:true})`，dst 含中文：在隔离子进程中**硬崩溃**，退出码 `0xC0000409`（fail-fast；Git Bash 显示为低字节 9），零 stderr；dst 目录已存在时则**静默无操作**（exit 0 但拷贝 0 个文件）；
  - `fs.rmSync(file)`：子进程中同样 `0xC0000409` 崩溃且文件仍在；进程内调用则**静默无操作**（不抛错、文件仍在）；
  - `fs.rmSync(recursive)`：同样崩溃；
  - 逐原语验证可用：`mkdirSync` / `copyFileSync` / `readdirSync` / `statSync` / `existsSync` / `writeFileSync` / `readFileSync` / `unlinkSync` / `rmdirSync`（均带事后 existsSync 验证）。process-lab 的 dist 安装与 scratch 清理已全部改用这些原语的手写递归。
- 长路径：构造 396 字符目录链（7×35 字符段）mkdir 成功、dist 拷贝成功、以 **420 字符**脚本路径 `node <script> --scenario success` → **exit 0** 且事件流完整。本配置未观察到 MAX_PATH 260 限制（长路径已启用/节点清单感知）。

### 场景 3 · 取消与 daemon 丢失语义（`node dist/experiments/main.js cancel-semantics`，exit 0；vitest 2 条）

| Case | 命令 | 观测 |
|---|---|---|
| A：timeout 场景 + `taskkill /F` | 单杀挂起 root | 杀前确认挂起（1.5s 后仍 alive）；kill exit 0；进程死亡；退出码 1（非干净）；`expectPidGone` 通过 |
| B：grandchild 场景 + `taskkill /F`（无 /T） | 单杀 root | taskkill stdout 只点名 root PID，但 child 与 grandchild **同样死亡**（2s 观测窗内身份查询返回 null）→ **Node v25 libuv 父死级联** |
| C：timeout 场景 + `taskkill /T /F` | 树杀无子进程的 root | kill exit 0；死亡；非干净退出 |

级联边界（专项 probe 实测，多次独立验证）：

1. node → node → node：`taskkill /F` 杀中层 node → 其子 node 同死；
2. node → cmd.exe（长命 ping）：`taskkill /F` 杀 node → cmd 子进程同死（级联覆盖 node 经 libuv spawn 的一切子进程）；
3. `detached: true`（Windows 上即 CREATE_NEW_PROCESS_GROUP/DETACHED 语义）启动的子进程**豁免**于级联，父死后仍存活；
4. 级联在父进程**正常退出**（exit 0）时同样生效：分离观察者探针实测，父进程优雅退出约 300ms 后，非 detached 子进程已死亡。级联3探针中未 await 的 taskkill 清理子进程正是被该机制吞掉，致使一个 detached hold.js（PID 69148）残留至实验后——已以 Stop-Process 手动清理并记录在案；
5. 对照：cmd-wrapper 场景中杀 **cmd.exe**（shim）不触发级联（cmd 不是 node，其 node 子进程由 cmd 启动）→ node 子树整体孤儿存活。

机制归属说明：该行为是 Node 25 所带 libuv 在 Windows 上的父死清理方向变化（与 Bun 1.4 在 Windows 上采用 recursive kill-on-close Job Object 的同类动向一致，见 libuv issue 「kill child processes on Windows when the parent dies」与 Bun 1.4 changelog；本报告仅声明在本机 Node v25.0.0 实测复现，不声明具体引入版本）。

**POSIX/WSL 对照**：同一 grandchild 场景在 WSL 内 `kill -9 <root>` 后 child/grandchild **存活**（POSIX 无 job 对象，孤儿语义），与 Windows Node 25 的级联行为相反——取消语义不可跨平台假设（A29）。

### 场景 4 · PID 复用观测（`node dist/experiments/main.js pid-reuse`，exit 0；vitest 2 条）

方法：150 个/轮的短命子进程（`cmd.exe /d /c ping -n 4 127.0.0.1`，寿命约 3s），轮间全退出屏障；同一 PID 值在后续轮重现即证明该数值已被分配给不同进程。

| 运行 | 观测 |
|---|---|
| 探测 1（600 并发 spawn） | 600 个不同 PID（并发在途不重复） |
| 探测 2（10 轮×300，轮间屏障） | 3000 spawn → **2099 个不同 PID，901 次复用**；PID 分布区间 712–70640，分配**非单调**（在低区段循环） |
| 实验（150/轮，首轮碰撞即停） | 多次运行稳定在 **round 1–3** 出现碰撞；碰撞 PID 的新持有者身份实测捕获：`pid=22772, name=cmd.exe, creationTime=新时间戳` |
| vitest 断言 | 12 轮预算内必现碰撞（实际 1–3 轮）；身份含 creationTime |

**结论（A27/reconcile 设计输入）**：Windows 上 PID 值在秒级窗口内即可被复用；「以 PID 判断进程身份」不可靠（`process.kill(pid,0)` 与 taskkill by-PID 都可能命中复用后的无关进程）。身份判定必须使用三元组 `(pid, name, parentPid, creationTime)`（Win32_Process）；process-lab 的 `expectPidGone` 即「signal-0 快路径 + 身份查询纠偏」的实现。

### 场景 5 · WSL（`node dist/experiments/main.js wsl`，exit 0；vitest 2 条）——与 native 分开记录，未混写

| 步骤 | 命令 | 退出码 | 观测 |
|---|---|---|---|
| 只读探测 | `wsl --status` | 0 | 输出为 UTF-16LE（已正确解码）：默认分发 Ubuntu、默认版本 2、本机配置不支持 WSL1 |
| Linux node | `wsl -e sh -c 'command -v node ...'` | 0 | v22.17.1（发行版内原生 node） |
| 同场景驱动 | 单次 `wsl -e sh -c 'sh driver.sh'`（dist 拷入发行版 /tmp，`setsid` 启动 grandchild 场景） | 0 | rootPid==PGID（setsid 生效）；`kill -9 <root>` → root 死、child(341)/grandchild(352) **存活**（孤儿）；`kill -9 -<PGID>` → 全灭 |
| 跨命名空间观测 | Windows 侧 `isAlive(<linuxPid>)` | — | false——Linux PID 对 Windows 存活检查无意义，两侧 PID 永不混用（A29） |

## 5. 对 launcher 设计的结论

1. **树杀必须 `taskkill /PID <pid> /T /F`**：/T 是唯一内建树遍历终止；/F 对无窗口控制台程序必需。不带 /T 时杀 `.cmd`/npm shim 会把整条 CLI 子树变成孤儿（实测存活且事件流可继续）。
2. **不能把「父死级联」当终止机制**：Node 25/win32 上杀 node root 会连累子孙，但 (a) 杀 shim 一级不级联；(b) 该行为随 libuv/Node 版本变化（POSIX/WSL 无此行为）。launcher 应解析到**真实 node 进程 PID**（经 Win32_Process parent 链），并对该 PID 执行 /T /F；必须存活的辅助进程用 `detached: true` 显式豁免。
3. **PID 身份判定需要创建时间戳辅助**（A27）：PID 秒级复用；终止前的身份快照 (pid,name,parent,creationTime) 是 reconcile 判「杀没杀对」的依据；signal-0 检查必须与身份查询结合。
4. **取消/退出语义按平台分别定义**（A29）：Windows 级联 vs POSIX 孤儿；WSL 内树杀是负 PGID SIGKILL；两侧 PID 命名空间互不可见，reconcile 不得跨命名空间解释 PID。
5. **进程启动必须 `cmd.exe /d /c`**：Node ≥18.20 直接 spawn `.cmd` 返回 EINVAL（CVE-2024-27980）；且**不可用 /s**（引号剥离导致含空格路径按空格截断）。
6. **路径处理**：中文+空格+跨盘+>260 长路径在本配置全链路可用；但 Node 25 的 `fs.cpSync`/`fs.rmSync` 在非 ASCII 路径上崩溃（0xC0000409）或静默失效——staging/清理必须使用经验证原语（mkdir/copyFile/unlink/rmdir 的手写递归）并对结果做 existsSync 验收。
7. **不要解析 taskkill/stderr 文本**：本机 taskkill 输出为 GBK 编码本地化文本（「成功: 已终止 PID…」）；cmd 错误输出同为 GBK。唯一可靠信号是退出码 + Win32_Process 事后核对。
8. **退出码语义**：被 `taskkill /F` 终止的进程对父进程呈现 exit code 1（非干净退出）——与 cli-events「非零退出=失败」判定一致，取消场景不得据此误报业务失败之外的错误细节。

## 6. 测试与门禁台账（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm build`（改动前基线） | 0 | 3 tasks |
| `pnpm test`（改动前基线） | 0 | 既有测试 **198** 通过（fake-cli 23 + contracts 44 + cli-events 131） |
| `pnpm typecheck`（最终） | 0 | 6 tasks（含 process-lab） |
| `pnpm test`（最终） | 0 | **208** 通过（既有 198 全部保持 + process-lab 10 新增）；8 tasks |
| `pnpm build`（最终） | 0 | 4 tasks |
| `pnpm run planning:check` | 0 | (a) 78 个冻结文件 sha256 全部一致；(b) 干净副本 self-test exit 0 |
| vitest 单包 `pnpm vitest run`（process-lab） | 0 | 5 文件 10 测试，约 21s |

process-lab 测试清单：cmd-wrapper 3（树杀/无 /T 残留/退出码传播）、unicode-paths 1（中文+空格目录全链路+严格拒绝）、cancel-semantics 2（单杀挂起进程/级联树灭）、pid-reuse 2（复用碰撞/身份三元组机制）、wsl 2（探测记录/发行版内树杀）。所有 spawn 树经 `TreeRegistry` 在 finally 中 `taskkill /T /F` 兜底，断言失败不泄漏挂起进程；等待均为轮询而非固定 sleep。

## 7. 与任务说明的偏离与未验证项

**偏离（deviations）**

1. 任务说明称「全部 164 个既有测试」，基线实测为 **198**（M0-04 交付后测试数已增长）；以 198 为保持基线，全部通过。
2. 任务说明场景 3 预设「Windows 单杀（无 /T）后观察孤儿」——实测 Node 25 存在父死级联，root 单杀不留孤儿；孤儿场景实测存在于**杀 cmd shim** 一级（场景 1 phase 2 覆盖）。两支行为均如实记录并固化为测试，未虚构「孤儿存活」结果。
3. 真实 claude/codex 调用 **0 次**：M0-05 检查单（launcher/进程树语义）全部可由 fake-cli（SYNTHETIC）与真实 OS 命令覆盖，真实调用不增加证据强度；约束 7 的 fixtures-real 流程因此未触发。
4. `pnpm-lock.yaml`（根目录非冻结工程配置）新增 process-lab importer 条目，属「必要的工程配置」变更；经 `planning:check` 校验不在冻结记录内。

**未验证项（unverified）**

1. WSL1：本机配置不支持（`wsl --status` 明示），仅验证 WSL2/Ubuntu 路径。
2. `cmd /c` shim 在**超长路径（>260）**下的组合行为：长路径 probe 只验证了 `node <长路径脚本>` 直启；未组合 shim+超长路径+中文三者叠加。
3. Node 25 级联行为的具体引入版本/上游提交：本报告仅声明本机 v25.0.0 实测复现，未做版本二分验证。
4. codex 方言（fake-codex）的 launcher 场景：场景均以 fake-claude 执行；两方言 runner 共享同一 spawn/frame 引擎（`packages/fake-cli/src/runner.ts`），差异仅在事件形状，不影响进程语义结论。

**风险**

1. Node 25 级联使「CLI 的孙进程在 Windows 上天然随父死」成为默认，且**父进程正常退出也会触发**（kill-on-close 语义）——若产品未来依赖「取消/退出后子孙存活以便恢复/取证」，必须显式 `detached: true` 并自行登记 PID（登记清单不能放在会随父进程消失的通道里）；升级/降级 Node 都可能翻转语义（M1-03 实现取消时需重新执行本套件确认）。同时注意：launcher 自身的清理子进程若不 await，也会被自己的退出级联吞掉。
2. `fs.cpSync`/`fs.rmSync` 的非 ASCII 崩溃属于工具链层风险：任何在中文路径下做 dist 拷贝/清理的脚本（含本仓库未来 CI）都会踩中；建议在 M0-06 兼容矩阵中记录为 Node 25.0.0/win32 已知缺陷并给出本报告的原语白名单。
3. PID 复用窗口为秒级：reconcile 若只做「PID 存活检查」可能在复用发生后误判旧进程存活并误杀新进程；必须落实第 5 节结论 3。

## 8. Artifact 引用

- 包：`packages/process-lab`（README 含场景表与用法；`dist/experiments/main.js` 五场景驱动可复跑）。
- 测试：`packages/process-lab/test/*.test.ts`（5 文件 10 测试，纳入根 turbo 管道：`pnpm test`）。
- 报告：本文件。
- 复跑命令（仓库根，需先 `pnpm build`）：
  `node packages/process-lab/dist/experiments/main.js cmd-wrapper`、`... unicode-path`、`... cancel-semantics`、`... pid-reuse`、`... wsl`（各打印 JSON 记录并以 0/1 表达结论）。
