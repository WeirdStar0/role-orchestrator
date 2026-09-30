# M8-05 批次报告:壳 serve 侧车捆绑(任务 1 单文件 bundle + 任务 2 安装包载荷与定位链 + 任务 3 重打与开箱验证)

日期:2026-09-30。开发者会话交付 BACKLOG M8-05(第 49 项)的实现任务 1 与 2。
立项与验收原文见 docs/BACKLOG.md「M8-05 · 壳 serve 侧车捆绑」;治理披露见
PROPOSALS.md 2026-09-30 两节(任务 1、任务 2)。本报告不在 CHECKSUMS 冻结面。

## 1. 候选链

- 7b0b31b(立项,governance)→ e1909a1(任务 1:serve 入口单文件 bundle)→
  本提交(任务 2:便携 node 下载 + NSIS resources + 壳定位链 + README 收口)。

## 2. 范围与验收对照(BACKLOG M8-05)

| 验收点 | 状态 | 证据 |
|---|---|---|
| esbuild 单文件 bundle(node: 内置 external) | 已交付(任务 1) | e1909a1;dist/serve-bundle.mjs 1,347,146 B;冒烟 2/2 |
| 构建脚本下载便携手 zip(版本对齐 mise、SHA256 校验、URL 与体积入披露) | 已交付(任务 2) | scripts/fetch-node-runtime.mjs;§3 披露数字 |
| NSIS extraFiles(bundle + node.exe) | 已交付(任务 2) | tauri.conf.json bundle.resources;cargo tauri build exit 0;§4 |
| 壳定位链捆绑资源优先、RO_SHELL_* 保留覆盖 | 已交付(任务 2) | src/locate.rs 纯函数 + 9 单测;integration.rs 同链复刻 |
| README 打包节与「已知边界」收口 | 已交付(任务 2) | apps/desktop-shell/README.md 运行/打包/已知边界/冒烟四节改写 |
| 无环境变量且仓库 dist 不可用前提下安装版壳开箱运行 | **本机部分实证,安装态归维护者** | release exe 直跑实证 ② 分支 spawn 成功;双击安装→启动属系统写入,归维护者冒烟(README unverified 12) |
| 守卫/令牌/serve 语义零变化 | 保持 | 红线检查见 §6;serve_child argv 契约单测原样绿 |

## 3. 便携 node 运行时下载披露(实测 2026-09-30)

- 版本口径:mise.toml `[tools] node = "25.9.0"`(node 25 验收基线线),非 latest;
- URL:`https://nodejs.org/dist/v25.9.0/node-v25.9.0-win-x64.zip`
  (唯一来源官方 nodejs.org/dist);
- zip 体积:**37,531,403 字节**;sha256:**929552b8305effac843ba7b4270c437aefb702fc3fbd73fcd1bffd35d4ac284e**
  (与同源 SHASUMS256.txt 逐字节核对,不匹配即拒绝解压、非零退出、零落盘);
- 解压仅取 node.exe → `apps/desktop-shell/node-runtime/node.exe`:
  体积 **95,618,048 字节**,sha256
  **98843732431bad6c2c165908bb7dde6fe2a221ddbc491a955d548a2e6ab9ebff**
  (钉在脚本常量,幂等:存在且吻合 → 零网络跳过;损坏 → 重下修复);
- 本机核验:便携 node `--version` = v25.9.0、`node:sqlite` 可用;
- 三条脚本路径(首次下载 / 幂等跳过 / 损坏修复)全部实测,exit 0;
- 产物不入库:`apps/desktop-shell/.gitignore` 增 `/node-runtime/`;
- 解压实现:脚本内置的最小 ZIP 读取器(node:zlib inflateRaw/store),
  无新增 npm 依赖(esbuild 仍是任务 1 登记的唯一例外)、无外部解压进程。

## 4. 安装包捆绑与体积变化

- `tauri.conf.json` `bundle.resources`(map 形态,tauri v2):
  `sidecar/serve-bundle.mjs → serve-bundle.mjs`(安装根,exe 同目录)、
  `node-runtime/node.exe → node-runtime/node.exe`;
- **资源路径为何走包内同步副本**:tauri-build 的资源解析不接受 `../`
  逃逸(实证:`"../packages/..."` 声明使 build script 以
  `resource path ... doesn't exist` 失败 exit 101,即便文件存在、即便
  cargo 从包目录运行);故 `scripts/sync-shell-sidecar.mjs` 把 bundle
  副本同步进 `apps/desktop-shell/sidecar/`(gitignored),tauri 引包内
  相对路径;
- 构建:`cargo tauri build` exit 0(`Finished 1 bundle`);打包器先把两个
  resource 复制到 `target/release/`(exe 旁)再交 NSIS——与安装布局同构;
- 体积:M8-03c 记录 1,931,291 字节(1.84 MiB)→ **25,976,568 字节
  (24.77 MiB)**,增量 ≈ 便携 node(NSIS 压缩后)+ 单文件 bundle;
- NSIS 载荷的直接列表工具本机没有(7z/tar 均不可列 NSIS);安装树落盘
  形态的最终证据归维护者安装态冒烟(本批不做系统写入)。

## 5. 壳定位链(M8-05 任务 2 核心)

- `src/locate.rs`(新,纯函数):serve 入口 ① RO_SHELL_SERVE_BIN →
  ② exe 同目录 serve-bundle.mjs → ③ `../../packages/local-api/dist/serve-bin.js`;
  node ① RO_SHELL_NODE → ② exe 同目录 node-runtime/node.exe → ③ PATH "node";
- fail-closed:①逐字采信(指错原样暴露,调用侧/run()核查兜底;空串=配置
  错误指名变量);②③以存在性为采信条件;全不可用 = Err 诊断列出全部候选
  → 非零退出、不建窗(维持 M8-03a 语义);node ③ 不做 PATH 预检(OS 职责,
  spawn 失败即既有 fail-closed 出口,模块文档说明);
- 单测 9 个(三分支 × 优先级 × 退化形态:env 优先、空 env 报错、bundled
  胜 dev、全缺诊断含两候选、exe_dir None 跳过 ②、node 回落 PATH);
- `tests/integration.rs`:serve 入口解析改走同一 `locate::resolve_serve_entry`
  (测试进程 exe 目录在 target/deps,自然落 ③ dev 分支,与壳 dev 运行一致;
  env 覆盖在测试同样生效,注明);
- `tests/source_invariants.rs`:SOURCES 扩 `locate.rs`(文件系统白名单与
  IPC 零注册金丝雀覆盖新文件;首跑曾因 locate.rs 注释含字面 `std::fs::`
  误报,改写注释措辞,扫描逻辑零改动);
- 本机端到端实证(非窗口路径):`target/release/role-orchestrator-
  desktop-shell.exe --db C:/no-such-dir/m805-probe.db` → exit 1,stderr
  首行即**捆绑 bundle 内 serve 进程的诊断**(`database directory ... does
  not exist`)——定位链 ② 两个分支真实命中并 spawn;随后壳 fail-closed
  退出、无窗口;孤儿核验 `serve-bundle[.]mjs|ro-shell[-]fake` 匹配 0。

## 6. 红线自查

- 守卫/令牌/serve 语义零变化:serve_child.rs、guard/token/serve.ts 零改动
  (git diff 实证);argv 恰 6 元素、无令牌旗标单测原样绿;
- 定位链保持 fail-closed(§5);env 覆盖能力保留且行为兼容(空串从
  「滑到失真诊断」变为「显式配置错误」,失败方向不变,如实披露);
- spawn 恒 argv 数组、不以 stdout 判定成功、不持久化凭据、无自动更新器:
  全部不变(source_invariants 三金丝雀 + serve_child 单测绿);
- 外部依赖零新增(任务 1 的 esbuild 仍是唯一登记例外;fetch 脚本零依赖);
- node 便携手 zip 仅构建期下载,来源官方 nodejs.org/dist,SHASUMS256 强制
  校验,node.exe 与 bundle 产物均不入库(.gitignore 两条);
- git:显式路径清单 add,无 -A,无 push,无历史改写。

## 7. 门禁退出码(本批实跑)

| 命令 | 结果 |
|---|---|
| `cargo test --manifest-path apps/desktop-shell/Cargo.toml` | **0**:26(lib,含 locate 9)+ 17(main)+ 3(source_invariants)+ 0(integration,env 门控 ignore)+ 0(doc)= 46 passed / 1 ignored / 0 failed |
| `cargo check --manifest-path apps/desktop-shell/Cargo.toml` | 0(resources 声明齐全后) |
| `cargo tauri build`(apps/desktop-shell) | 0,`Finished 1 bundle`(25,976,568 B) |
| `node scripts/fetch-node-runtime.mjs`(三路径) | 0 / 0 / 0(下载校验 / 幂等跳过 / 损坏修复) |
| `node scripts/sync-shell-sidecar.mjs` | 0;缺产物分支报错退出亦实测 |
| `node planning-check.mjs` | 提交前复跑,见提交消息(预期 (a) 79/79 +(b) exit 0) |

## 8. 未验证项(维护者冒烟清单,README unverified 同步)

1. 安装态开箱冒烟:双击 setup.exe(无 UAC、`%LOCALAPPDATA%\role-orchestrator-shell`
   落盘、HKCU 登记)→ **不设任何环境变量**直接启动 → 窗口加载回环页面
   (定位链 ② 命中捆绑资源的真机证据);
2. 干净 Windows 机器(无 node、无仓库)同形态端到端——「开箱即用」验收
   的最终形态证据;
3. NSIS 安装树内落盘形态(serve-bundle.mjs 在安装根、node-runtime\node.exe
   在子目录)与卸载后两文件移除;
4. 真窗托盘/导航拒绝等既有维护者冒烟项(README unverified 1-11 未变)。

## 9. M8-03c 披露边界条目闭合注明

M8-03c PROPOSALS 披露(2026-09-29)与 apps/desktop-shell/README.md「打包
分发」节记载的已知边界——「安装包只装壳 exe,不捆 serve 侧车;安装态启动
需 RO_SHELL_SERVE_BIN 指路」——由本批闭合:安装包现捆 bundle + node.exe,
安装态开箱无需环境变量(本机 release 形态实证 + 单测钉优先级;安装态真机
证据归 §8.1)。README「已知边界」条目已改写为现状描述;历史披露文本按
「历史快照只勘误不改旧文」惯例零改动,闭合关系以本节与本批 PROPOSALS
披露为准。附带项(M8-04 审查移交):codex input_tokens 口径 unverified
TODO 注记已加在 packages/model-stats/README.md 口径串旁(指向
src/schema.ts:30 与 src/parse.ts:250-252),口径串文本零改动。

## 10. 风险

- 安装包从 1.84 MiB 增至 24.77 MiB(便携 node 为必要代价,ADR 体积假设
  带外,已在 PROPOSALS 披露);
- 便携 node 与 mise node 同版本钉死(25.9.0),mise 升版时需同步
  fetch 脚本常量(脚本头注释标明对齐依据,漂移不会静默——常量即披露);
- tauri-build 拒绝包外资源路径属构建期硬失败(早失败,不会产出缺载荷
  安装包),但同步脚本成为构建顺序的必要一步(README 已写死顺序与缺产物行为)。

---

## 任务 3 交付:重打 NSIS 安装包与本机开箱验证(2026-09-30 补记)

授权说明:安装/卸载属系统写入,前两批按「归维护者」边界未执行;任务 3
指示显式授权本机执行(per-user 静默安装,currentUser 模式 = 仅 HKCU +
%LOCALAPPDATA%,无 HKLM、无提权,可卸载),据此执行并全程留证。

### 3.1 构建实录(按 README 钉死的顺序,2026-09-30 16:26-16:29)

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm build` | exit 0,35/35 turbo tasks,39.6s,0 cached |
| 2 | `pnpm --filter @role-orchestrator/local-api run bundle:serve` | exit 0,dist/serve-bundle.mjs 1,347,146 字节(与任务 1 首造逐字节同形) |
| 3 | `node scripts/fetch-node-runtime.mjs` | exit 0,**幂等零网络跳过**(node.exe sha256 与钉值吻合) |
| 4 | `node scripts/sync-shell-sidecar.mjs` | exit 0,sidecar/serve-bundle.mjs 1,347,146 字节入树 |
| 5 | `cargo tauri build` | exit 0,`Finished 1 bundle` |

- **安装包体积**:25,986,431 字节(**24.78 MiB**)——M8-03c 基线
  1,931,291 字节(1.84 MiB)的 13.5 倍;较任务 2 所记 25,976,568 字节
  (+9,863 字节,重打间常规波动:release exe 时间戳/打包序差异)。
- 本步门禁:`cargo test --manifest-path apps/desktop-shell/Cargo.toml`
  = **0**(26+17+3 passed,1 integration env 门控 ignore,0 failed)。

### 3.2 静默安装与落盘核查

- 安装:`powershell Start-Process -FilePath <setup.exe> -ArgumentList '/S'
  -PassThru -Wait` → **installer exit=0**(PowerShell 传参,规避 bash
  对 `/S` 的路径改写);
- 落盘(安装前旧 M8-03c 版仅 exe+uninstall.exe 两件 → 安装后):
  `%LOCALAPPDATA%\role-orchestrator-shell\` = role-orchestrator-desktop-shell.exe
  (8,955,904 B)+ **serve-bundle.mjs(1,347,146 B,安装根)+ node-runtime\
  node.exe(95,618,048 B)** + uninstall.exe——恰为定位链 ② 查找形态;
- 注册表:HKCU `...\Uninstall\role-orchestrator-shell` 存在
  (DisplayName/DisplayVersion 0.1.0/InstallLocation=%LOCALAPPDATA%
  \role-orchestrator-shell);HKLM 两视图(Uninstall 与 WOW6432Node)均无
  role-orchestrator 键(**per-user 无 HKLM 写入证据**)。

### 3.3 开箱验证(模拟干净机器口径:不设 RO_SHELL_SERVE_BIN / RO_SHELL_NODE,无参数启动)

验证脚本逐条输出(EVIDENCE 行,PowerShell -File 执行,exit 0):

1. `env at launch: RO_SHELL_SERVE_BIN=[] RO_SHELL_NODE=[]`——开箱前置;
2. `shell pid=60872 started from C:\Users\star\AppData\Local\role-orchestrator-shell (no args, no env overrides)`;
3. `serve cmdline: "C:\...\role-orchestrator-shell\node-runtime\node.exe"
   C:\...\role-orchestrator-shell\serve-bundle.mjs --db
   C:\Users\star\AppData\Local\role-orchestrator\orchestrator.db --port 0`
   ——**进程链指向安装目录捆绑资源(非仓库路径)**,argv 数组形态,默认
   db 路径由壳解析传入;
4. `serve node executable path: C:\...\node-runtime\node.exe`——便携
   node(非 PATH node)实证;
5. `serve pid=69060 LISTENING on 127.0.0.1:61439`——端口监听;
6. `GET / -> 200`(页面外壳公开系设计,serve.test.ts 头注同口径);
   `GET /api/v1/session without Authorization -> 403`——**无凭据探测被
   守卫拒绝**(守卫管道恒 403,无 401;任务文本「401/403」按真实语义落在
   403);
7. 默认 db:`serve argv carries default db path: True`;db 本体在本机
   先存(2026-09-29 维护者冒烟遗留,如实记录——「创建」语义不可在本机
   重演,由 serve 单测与既有冒烟覆盖);**打开证据**:serve 运行期间
   `orchestrator.db-shm`/`orchestrator.db-wal` 现身(16:31 时间戳);
8. **强杀清零**:`Stop-Process -Force`(= 任务管理器级 TerminateProcess)
   杀壳 → serve 链 **0.6 秒清零**(预算 4 秒,200ms 轮询粒度),壳进程
   同步消失——KILL_ON_JOB_CLOSE 兜底在安装形态实证;
9. 收尾:静默卸载 `uninstall.exe /S` exit 0 → 安装目录移除、HKCU 键移除
   (实证);随后**重装新构建**(/S,exit 0)——机器终态 = 新版(含捆绑
   载荷)已安装,优于验证前的旧 M8-03c 残留;终态核查:安装根三件 +
   node-runtime/ + HKCU DisplayVersion 0.1.0。

### 3.4 任务 3 后的 unverified 残项(如实)

- **真正干净 Windows**(无仓库、无构建产物、无 mise 工具链)的安装运行:
  本机仍带仓库与工具链,「干净」是模拟口径(env 变量清空 + 装载的是安装包
  自带载荷,serve 链全程未触仓库路径——由 cmdline 实证);无外部依赖的
  全新机器终验仍归维护者;
- 真窗交互(窗口加载回环页面、标题、托盘显示/菜单、关闭隐藏、导航拒绝
  壳内提示)未在本任务断言(需人眼与桌面会话交互),沿用 README 冒烟
  清单归维护者;
- 双击式(GUI 向导)安装路径未走(静默 /S 为任务指定口径),UAC 缺席
  的 GUI 形态沿用 M8-03c 冒烟清单。
