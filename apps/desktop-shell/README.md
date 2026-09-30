# role-orchestrator 桌面壳(M8-03a/c,Tauri v2)

本目录是**独立 Cargo 工程**,刻意**不注册进 pnpm workspace**(`pnpm-workspace.yaml`
不改):壳的 Rust/WebView2 工具链独立于 npm 侧 111 个外部依赖的审计面,按
[ADR](../../reports/M8-03-desktop-shell-adr.md) 以独立披露管理。

结构:`src/lib.rs`(纯逻辑库:serve_child / health / url)+ `src/main.rs`
(壳流程:参数解析 → spawn serve → HTTP 探测 → 建窗口 + 托盘)。窗口由代码在
local-api serve 子进程就绪后创建(`tauri.conf.json` 的 `app.windows` 为空
数组);`shell-ui/` 仅为 `build.frontendDist` 的构建占位,运行时不加载。

窗口生命周期与托盘(M8-03c):托盘图标复用 bundle 资源 `icons/icon.ico`;
右键菜单两项「显示主窗口 / 退出」,左键双击恢复窗口;**关闭按钮 = 隐藏到
托盘**(壳常驻)而非退出;真正的退出只在托盘菜单——先 Job 树杀 serve
子进程再退出壳(顺序由 `main.rs::shutdown_sequence` 钉死并单测)。托盘
feature = tauri 的 `tray-icon`(已含于 tauri,未新增 crate);导航拒绝的
壳内提示用 windows-sys 的 MessageBoxW(`Win32_UI_WindowsAndMessaging`
特性,未引入任何 dialog/notification 插件)。

## 构建

```bash
cd apps/desktop-shell
cargo check   # 快速门禁;首次会从 crates.io 拉取并编译大量依赖,属正常
cargo build   # 完整编译(target/ 已在本目录 .gitignore 忽略)
cargo test    # 单元测试(url / serve_child / health / 壳参数 / 托盘菜单
              # 映射与退出顺序 / 导航提示文案)+ 结构性不变式
              # (tests/source_invariants.rs:零 command 注册、
              # fs 白名单、capabilities 空授权);集成测试默认忽略
```

**纯新克隆前置(M8-06 登记)**:上面的 cargo 命令并非零前置——`tauri.conf.json`
的 `bundle.resources` 声明了 `sidecar/serve-bundle.mjs` 与
`node-runtime/node.exe`,而 tauri-build 在**任何** cargo 构建(check/build/
test 都会执行 build script)时校验并复制这些资源;纯新克隆上两者皆不存在,
cargo 会以 `resource path ... doesn't exist`(exit 101,M8-05 实证,见
「打包分发」节)失败。先在**仓库根**产出并同步捆绑资源:

```bash
pnpm build                                                   # 1. local-api dist(tsc)
pnpm --filter @role-orchestrator/local-api run bundle:serve  # 2. 单文件 bundle → packages/local-api/dist/serve-bundle.mjs
node scripts/fetch-node-runtime.mjs                          # 3. 便携手 node → apps/desktop-shell/node-runtime/node.exe(SHASUMS256 校验,幂等)
node scripts/sync-shell-sidecar.mjs                          # 4. bundle 副本入树 → apps/desktop-shell/sidecar/
```

即「打包分发」节五步构建链的前四步(第五步 `cargo tauri build` 只在出
安装包时需要,cargo check/test 不需要);四步齐后再进本目录跑 cargo。

**dev cargo run 遮蔽(M8-06 登记)**:cargo 构建会让 tauri-build 把声明的
resources 复制到产物 exe 同目录(本机实证:`target/debug/serve-bundle.mjs`
与 `target/debug/node-runtime/` 在位)。dev `cargo run` 的 exe 在
`target/debug/`,于是壳定位链 **②(exe 同目录 `serve-bundle.mjs`)优先于
③(仓库 `packages/local-api/dist/serve-bin.js`)** 命中——改了 local-api
源码后,仅 `pnpm build` + `cargo run` 加载的仍是 target 目录里的**旧
bundle 副本**。要让变更可见:重跑 bundle:serve + sync-shell-sidecar 刷新
入树副本,再重新 `cargo build`(tauri-build 检测到 resource 变化即重跑并
按新字节重新复制,本机实测:改 sidecar 一字节 → cargo build → target
副本同变;还原 → 同法复原);想强制走 dev ③ 分支,删除 `target/debug/`
下的 `serve-bundle.mjs` 与 `node-runtime/` 副本即可。

孤儿进程现状(M8-03b):M8-03a 审查实证的「每次 cargo test 确定性泄漏
2 条 serve 孤儿(shim 链幸存)」已由 Job Object 树杀根治——单元与集成
测试跑完均无 serve-bin 与 ro-shell-fake 假脚本残留(M8-03c 勘误补:
原核验命令只匹配 serve-bin 模式,漏假脚本链,已扩为双模式),
核验命令见「集成测试」节。

工具链:cargo/rustc ≥ 1.95(本机 1.95.0 已验证);Windows 渲染依赖系统
WebView2。

## 运行

前置(M8-05 起二选一,由定位链自动裁决):

- **仓库 dev 布局**:仓库根 `pnpm build`(产出
  `packages/local-api/dist/serve-bin.js`)+ `pnpm
  --filter @role-orchestrator/local-api run bundle:serve`(产出
  `serve-bundle.mjs`,dev 运行不需要它,装安装包才需要);node 在 PATH 上;
- **安装布局**:安装包自带全部载荷(见「打包分发」),无需仓库。

然后:

```bash
cd apps/desktop-shell
cargo run
```

流程与参数:

- 壳自身只接受 `--db <path>`(可选):缺省为
  `%LOCALAPPDATA%\role-orchestrator\orchestrator.db`(壳会显式创建默认目录;
  显式 `--db` 时不建目录,父目录缺失由 serve 按设计拒绝);
- 壳经资源定位链解析 serve 入口与 node 可执行文件(链与 fail-closed 语义
  见下文「资源定位链」节),再以 argv 数组 spawn
  `node <serve 入口> --db <path> --port 0`(无
  shell;不传任何令牌参数——壳不经手令牌,令牌流保持「local-api 写
  per-user 0o600 文件,操作者自行读取粘贴到页面」);
- 就绪判定:先从子进程 stdout 诊断行**发现**监听端口(仅提示),随后对
  `http://127.0.0.1:<port>` 做 **HTTP 探测**(收到任何合法状态行即在位,
  含 403 守卫拒绝)——绝不以 stdout 文本判定成功;
- 探测通过后创建标题 "Role Orchestrator" 的窗口加载
  `http://127.0.0.1:<port>` 并建立系统托盘(M8-03c:关闭按钮隐藏到托盘,
  托盘菜单/双击恢复,托盘「退出」先树杀 serve 再退壳);健康检查失败打印
  诊断、非零码退出、不建窗口。

资源定位链(M8-05,纯函数实现见 `src/locate.rs`,单测钉死三分支与优先级):

- **serve 入口**:① `RO_SHELL_SERVE_BIN` 环境变量(逐字采信)→ ② exe 同
  目录 `serve-bundle.mjs`(安装布局:NSIS resources 落在安装目录)→ ③ 仓库
  相对路径 `../../packages/local-api/dist/serve-bin.js`(dev 布局);
- **node**:① `RO_SHELL_NODE` 环境变量 → ② exe 同目录
  `node-runtime\node.exe`(便携手 runtime)→ ③ PATH 上的 `node`;
- **fail-closed 不变**:全部分支不可用 = 诊断列出已尝试候选 + 非零码退出、
  不建窗;env 覆盖值指错地方原样暴露(不静默回退);覆盖值设为空串视为
  配置错误并指名变量。

### 维护者冒烟步骤(最小清单)

1. 仓库根 `pnpm build`(产出 `packages/local-api/dist/serve-bin.js`);
2. `cd apps\desktop-shell && cargo run`——预期:无控制台报错,数秒内弹出
   标题 "Role Orchestrator" 的窗口,加载 local-api 回环页面,任务栏通知区
   出现壳的托盘图标;
3. **关闭按钮 → 隐藏到托盘(M8-03c 起,替代旧「关闭即退出」预期)**:
   点窗口关闭按钮——预期窗口消失但壳与 serve 子进程**都还在**(任务管理器
   确认壳进程与 `serve-bin.js` 相关 node 进程仍在);托盘左键双击(或右键
   菜单「显示主窗口」)——预期窗口重新出现;
4. **托盘退出顺序**:托盘右键 → 「退出」——预期壳与 serve 一并退出
   (实现顺序 = 先 Job 树杀 serve 再退壳,由 `shutdown_sequence` 单测
   钉死;人工核验):
   `powershell -NoProfile -Command '$m = Get-CimInstance Win32_Process |
   Where-Object { $_.CommandLine -match "(serve-bin[.]js|ro-shell[-]fake)"
   }; "orphans=" + ($m | Measure-Object).Count'` 应为 0,且壳进程消失。
   **外部强杀变体**:
   任务管理器直接结束壳进程,serve 整树应随 KILL_ON_JOB_CLOSE 兜底退出,
   同命令核验;
5. **导航拒绝并壳内提示(M8-03c 可执行步骤,debug 构建下操作)**:
   `cargo run` 起壳后,在页面内右键 → Inspect 打开 DevTools,Console 执行
   `location.href = 'http://example.com/harvest?token=x'`——预期:壳内弹出
   MB_OK 提示框,文案只含 `http://example.com`(scheme+host+port,**不含**
   path/query——最小暴露),页面不发生跳转;点确定后壳继续可用(托盘/窗口
   均正常)。非白名单的其它形态(如 `https://`、其它端口回环)同理被拒;
6. 故意给坏库路径 `cargo run -- --db C:\no-such-dir\x.db`——预期:打印
   serve 诊断后非零码退出、不弹窗(serve 拒绝隐式建目录)。

工具链说明:本机 rustc 1.95.0 的 std 已移除 `CommandExt::windows_hide`
(rmeta 扫描核实),壳以底层等价 `creation_flags(0x0800_0000)`
(CREATE_NO_WINDOW)达成同一效果;Rust 升级需重验该路径。

## 集成测试(默认不跑)

真实 spawn serve 子进程 → 探测在位 → 断言无凭据 API 请求被 403 拒绝、
`GET /` 为 200 → kill 子进程:

```bash
# 前置:仓库根 pnpm build(产出 packages/local-api/dist)
cd H:\role-orchestrator
set RO_SHELL_INTEGRATION=1
cargo test --manifest-path apps/desktop-shell/Cargo.toml -- --ignored
```

POSIX bash:`RO_SHELL_INTEGRATION=1 cargo test --manifest-path
apps/desktop-shell/Cargo.toml -- --ignored`。

PowerShell 变体(M8-03b 补):

```powershell
$env:RO_SHELL_INTEGRATION = "1"
cargo test --manifest-path apps/desktop-shell/Cargo.toml -- --ignored
```

跑完后自证无孤儿残留(M8-03b 树杀验收;M8-03c 勘误补:匹配面扩为
serve-bin 与 ro-shell-fake 两类——单测的假 serve/树杀脚本命令行含
`ro-shell-fake-*`,原命令漏该模式;`[.]`/`[-]` 是免自匹配写法):

```powershell
powershell -NoProfile -Command '$m = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "(serve-bin[.]js|ro-shell[-]fake)" }; "orphans=" + ($m | Measure-Object).Count; $m | Select-Object ProcessId,CommandLine | Format-List'
```

## 打包分发(NSIS per-user 安装包,M8-03c)

ADR 威胁建模 3(本地提权缓解)的落地:**per-user 安装——不写 HKLM、不做
Windows 服务、不要求管理员、初版不做自动更新器**。

- **构建工具(披露项)**:`cargo install tauri-cli --version "^2" --locked`
  ——构建工具,**非运行时依赖**(Cargo.toml/Cargo.lock 无此条目,不进
  任何审计面)。本机实装 **tauri-cli v2.12.0**(2026-09-29,编译
  4m14s,exit 0)。
- **构建命令**:`cd apps\desktop-shell && cargo tauri build`。本机实测:
  release 编译 45.36s + NSIS 打包,全流程 51s(exit 0)。**首次运行外部
  下载披露**:tauri-cli 从官方源下载 NSIS 工具链到 `%LOCALAPPDATA%\tauri\
  (NSIS 子目录)——来源(git 实证 tauri-bundler 2.10.0 源码 mod.rs):
  `https://github.com/tauri-apps/binary-releases/releases/download/
  nsis-3.11/nsis-3.11.zip`(SHA1 校验)与
  `https://github.com/tauri-apps/nsis-tauri-utils/releases/download/
  nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll`;仅构建机需要,安装机
  不触网(安装包内置全部载荷)。
- **构建顺序(M8-05 起,四步前置一步同步,缺一不可)**:

  ```bash
  pnpm build                                                # 1. local-api dist(tsc)
  pnpm --filter @role-orchestrator/local-api run bundle:serve  # 2. 单文件 bundle → dist/serve-bundle.mjs
  node scripts/fetch-node-runtime.mjs                       # 3. 便携手 node → apps/desktop-shell/node-runtime/node.exe(SHASUMS256 校验,幂等)
  node scripts/sync-shell-sidecar.mjs                       # 4. bundle 副本入树 → apps/desktop-shell/sidecar/(tauri resources 只收包内相对路径)
  cd apps/desktop-shell && cargo tauri build                # 5. 壳 release + NSIS
  ```

  **缺任一产物时构建的行为**:①②缺 → `sync-shell-sidecar` 以指名命令的
  错误退出;③缺 → `sync-shell-sidecar` 预检报错并指向
  `fetch-node-runtime`;四个前置齐了但 `tauri.conf.json` 声明的 resource
  文件在打包时缺失 → tauri-build 直接失败(`resource path ... doesn't
  exist`,exit 101,本机实证)——安装包永远不会在缺载荷的情况下被产出。
  `../` 形态的资源路径(指向包外 dist)经实证不被 tauri-build 接受,故
  走同步脚本入树。
- **捆绑资源(M8-05,`tauri.conf.json` `bundle.resources`)**:安装根下
  `serve-bundle.mjs`(exe 同目录)与 `node-runtime\node.exe`——正是壳定位
  链 ② 分支查找的两个路径(见「运行」节)。安装机不触网:载荷全部内置于
  安装包(本机构建实证:打包器先把两个 resource 复制到
  `target\release\`(exe 旁),再交 NSIS 打包)。产物体积变化:M8-03c 的
  1,931,291 字节(1.84 MiB)→ **25,976,568 字节(24.77 MiB)**(任务 2
  首打;任务 3 按构建顺序重打同口径 25,986,431 字节 = **24.78 MiB**,
  +9,863 字节为重打间常规波动),增量 ≈ 便携
  node.exe(95,618,048 字节,NSIS 压缩后)+ 单文件 bundle(1,347,146
  字节)。
- **产物**:`target\release\bundle\nsis\role-orchestrator-shell_0.1.0_x64
  -setup.exe` = **1,931,291 字节(1.84 MiB)**(本机实测;tauri build
  日志 `Finished 1 bundle`)。同批 release 主 exe(未打包口径)M8-05
  实测 **8,955,904 字节(8.54 MiB)**——M8-03c 记录 8,886,272(8.48 MiB,
  较 M8-03b 的 8,649,216 增加 237 KB,原因:tray-icon 特性激活 +
  导航提示/托盘代码),M8-05 增定位链与捆绑资源加载后再测 +69,632 字节,
  仍在 ADR「3–10 MB 量级」假设带内。核验记录:setup.exe PE 头 machine=0x014C
  (i386)属 NSIS 惯例——安装器 stub 是 32 位启动器,x64 应用载荷在包内
  (build 日志 `Info Target: x64`),VersionInfo 为
  role-orchestrator-shell 0.1.0,含 Nullsoft 标记。**M8-05 更新**:捆绑
  serve 侧车与便携 node 后,同口径安装包为 **25,986,431 字节(24.78
  MiB,任务 3 重打;首打 25,976,568/24.77)**(见上文「捆绑资源」条);
  体积变化的完整披露见 PROPOSALS 2026-09-30 M8-05 节。
- **便携手 node 运行时(M8-05 下载披露)**:`scripts/fetch-node-runtime.mjs`
  从**唯一来源官方 nodejs.org/dist** 下载,版本对齐 mise.toml
  (`node = "25.9.0"`,验收基线 node 25 线)。本机实跑记录(2026-09-30):
  - URL:`https://nodejs.org/dist/v25.9.0/node-v25.9.0-win-x64.zip`;
  - zip 体积 **37,531,403 字节**,sha256
    `929552b8305effac843ba7b4270c437aefb702fc3fbd73fcd1bffd35d4ac284e`
    (与同源 `SHASUMS256.txt` 逐字节核对,不匹配即拒绝解压);
  - 解压仅取 `node.exe` → `apps/desktop-shell/node-runtime/node.exe`,
    体积 **95,618,048 字节**,sha256
    `98843732431bad6c2c165908bb7dde6fe2a221ddbc491a955d548a2e6ab9ebff`
    (钉在脚本常量:已存在且哈希吻合则零网络跳过,损坏则重下修复——
    三条路径均实测);
  - 下载产物不入库(`.gitignore` `/node-runtime/`),属构建机工具,
    随 NSIS 进安装包;装机不触网。
  本机核验:便携 node 直跑 `--version` = v25.9.0、`node:sqlite` 可用
  (serve 的 store 依赖)。
- **配置说明**(`tauri.conf.json` 为严格 JSON,注释不可承载,记录在此):
  `bundle.targets: ["nsis"]`——MSI 需 WiX 工具链更重,记录为**可选目标**,
  维护者需要时在 targets 加 `"msi"` 再启;`bundle.windows.nsis.installMode:
  "currentUser"`——**落盘路径以 tauri-bundler 2.10.0 模板实证为准**:
  currentUser → `RequestExecutionLevel user`(无 UAC)、默认安装目录
  `$LOCALAPPDATA\${PRODUCTNAME}` 即 **`%LOCALAPPDATA%\role-orchestrator
  -shell`**(任务假设的 `%LOCALAPPDATA%\Programs` 下不成立——tauri NSIS
  模板只有 `both` 模式涉 Program Files 形态,如实修正)、卸载登记键
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\role-
  orchestrator-shell`(HKCU,非 HKLM)。
- **无自动更新器(核实)**:tauri 2 的 updater = 独立插件
  (`tauri-plugin-updater`)+ `bundle.createUpdaterArtifacts` 配置;本工程
  两者皆无(Cargo.toml 无该插件,tauri.conf.json 全文 0 处 updater 字样)。
  更新 = 重新安装(ADR:引入更新器必须先过签名校验设计并另立 ADR)。
  安装包**未签名**(无证书配置),SmartScreen 会提示未知发布者——冒烟时
  属预期。
- **已知边界(M8-03c 披露 → M8-05 闭合,现状描述)**:安装包自 M8-05 起
  捆绑 serve 侧车单文件(`serve-bundle.mjs`)与便携 node 运行时
  (`node-runtime\node.exe`),安装后的 exe 按「env 覆盖 → exe 同目录捆绑
  资源 → 仓库 dev 路径」的定位链自动开箱启动 serve,无需任何环境变量、
  无需仓库存在(定位链与 fail-closed 语义见「运行」节)。**已验证(任务 3,
  本机静默安装口径)**:静默 /S 安装 → 不设任何环境变量从安装目录启动 →
  serve 进程链命令行指向安装目录捆绑资源、端口监听、无凭据 API 探测 403、
  强杀壳后 serve 链 0.6 秒清零(证据见 reports/M8-05-BATCH.md §3)。
  **仍未验证**:双击式 GUI 向导安装、真窗交互(托盘/关闭隐藏/导航拒绝
  壳内提示)与真正干净 Windows 机器(无 node/无仓库)的端到端——属
  维护者冒烟清单(见文末 unverified)。

### 维护者冒烟步骤(安装包)

授权与已验口径:M8-05 任务 3 已获授权在本机走完静默路径——静默 /S 安装、
HKLM 无写入、开箱启动、强杀清零、卸载/重装(证据见 reports/M8-05-BATCH.md
§3);下列步骤中双击式 GUI 向导与真窗交互部分仍归维护者。

1. 双击 `target\release\bundle\nsis\role-orchestrator-shell_0.1.0_x64
   -setup.exe`(非静默):全程**不应出现 UAC 提权弹窗**;默认安装路径应为
   `%LOCALAPPDATA%\role-orchestrator-shell`;
2. per-user 落盘核查(装完执行):
   `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\
   role-orchestrator-shell"` 应有输出(DisplayName/DisplayVersion 等);
   `reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\
   role-orchestrator-shell"` 应报「找不到指定的注册表项」;再以
   `reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall"
   /f role-orchestrator /s` 复核 HKLM 全树无该产品登记(**无 HKLM 写入**
   证据);
3. 静默变体(可选):`…-setup.exe /S`(NSIS 标准静默旗标,tauri 模板
   一等支持:静默路径含降级拦截与桌面快捷方式处理)——同样不应有 UAC,
   落盘路径与注册表核查同上;
4. 启动安装后的 `role-orchestrator-desktop-shell.exe`(M8-05 起**不需要
   任何环境变量**:安装目录自带 `serve-bundle.mjs` 与
   `node-runtime\node.exe`,定位链 ② 分支自动命中):预期窗口直接加载
   回环页面;可另验失败形态——`role-orchestrator-desktop-shell.exe --db
   C:\no-such-dir\x.db` 应打印 serve 诊断后非零退出、不弹窗;按上文
   「维护者冒烟步骤」2-5 条验托盘/关闭隐藏/导航拒绝;
5. 卸载(可选):Windows「设置→应用」或安装目录 uninstall.exe,确认安装
   目录与 HKCU 登记键移除。

## M8-03b 实测记录与探针(ADR 四项【待实测】的闭合证据)

- **WebView2 Runtime 在位率(本机实测 2026-09-29)**:
  `powershell -NoProfile -ExecutionPolicy Bypass -File
  scripts/check-webview2.ps1` → HKLM WOW6432Node 视图命中 **pv=
  153.0.4234.48**,exit 0(样本 = 验收机 1 台;最小支持系统在位率属发布期
  冒烟)。
- **体积实测(release,M8-03b 口径)**:`cargo build --release` →
  `target/release/role-orchestrator-desktop-shell.exe` = **8,649,216 字节
  (8.25 MB)**,落在 ADR【假设】栏的 3–10 MB 量级内(未打包主 exe 口径,
  安装包属 M8-03c。**M8-03c 更新**:tray-icon 特性激活后同口径实测
  8,886,272 字节(8.48 MB),仍在假设带内,见「打包分发」节)。**内存占用(维护者冒烟)**:任务管理器读壳进程与
  WebView2 子进程常驻内存,回填 ADR。
- **capability 全拒 + 导航锁定**:
  - 静态层/产物层已入默认门禁:`tests/source_invariants.rs`(src 生产
    区域零 `invoke_handler`/`generate_handler`/`tauri::command`;
    `gen/schemas/capabilities.json` 全部 permissions 为空数组——文件不存在
    时显式跳过并说明)。
  - 真窗运行层探针(需桌面会话;`RO_SHELL_PROBE=1` 为刻意显式开关):

    ```powershell
    $env:RO_SHELL_PROBE = "1"
    cargo run --example capability_probe
    ```

    预期输出:`PROBE_EVIDENCE {"invoke_denied": "<拒绝详情>",
    "invoke_resolved": false, "nav_example_com_seen": true,
    "nav_example_com_blocked": true, "diagnostics": []}` 随后
    `PROBE_RESULT: capability 全拒 + 导航锁定拒绝证据成立…`,证据同步落盘
    `target/shell-probe-evidence.json`,断言失败非零码退出。
  - **已知阻塞(如实标注)**:本验收机上任何**非主程序**的 tauri 链接
    二进制(测试装置与示例 bin)加载即以 STATUS_ENTRYPOINT_NOT_FOUND
    (0xc0000139)崩溃——加载期失败、与所在目录无关;同一依赖集的主程序
    二进制正常加载运行。运行层证据需在无此问题的机器执行(ADR 回填第 3
    项已如实标注,不伪造)。
- **引导安装路径(维护者冒烟;下载/安装属外部写入,Developer 不执行)**:
  若目标机 `check-webview2.ps1` 报 NOT found——从 Microsoft 官方
  Evergreen 页面下载 Bootstrapper(MicrosoftEdgeWebview2Setup.exe),
  per-user 运行安装,完成后重跑脚本应报 FOUND 且 pv 非空。

## 安全不变式(摘要,完整论证与威胁建模见 ADR)

- **壳不经手令牌**:不读、不缓存、不放进子进程 argv/env、不持久化;
  serve_child 的 argv 形态被单元测试钉死(恰 6 个元素,无任何令牌旗标);
- **壳不持久化任何凭据/配置(M8-03b 自查)**:生产源码唯一的文件系统动作
  是默认 db 路径的父目录创建(main.rs `std::fs::create_dir_all`;由
  tests/source_invariants.rs 的 fs 白名单断言钉死)——db 文件本身由 serve
  创建,壳对任何路径不写内容,唯一落盘语义就是把 db 路径参数传给 serve;
- **spawn 契约**:argv 数组、不开 shell、不经 cmd/bash 拼接;
- **在位判定**:只靠回环 HTTP 探测收到响应;子进程 stdout 仅用于端口提示
  发现,发现后继续排水,不作为任何成功判据;
- **URL 规则与导航锁定(M8-03b 已接线;M8-03c 补壳内提示与机制归因勘误,
  安全结论不变)**:壳只加载 `http://127.0.0.1:<port>`(禁止 localhost
  字样、0.0.0.0、:: 与 userinfo 形态)。导航防线分层:
  - **顶层文档导航**:`WebviewWindowBuilder::on_navigation` 是运行期裁决
    点——`main.rs::navigation_allowed` 在 `url::is_allowed_navigation`
    白名单之上叠加「恰为本壳 serve 端口」的精确匹配,非白名单导航一律
    拒绝(false 阻止)并**在壳内提示**——Windows 用 windows-sys 的
    MessageBoxW 弹 MB_OK(不引入任何 dialog/notification 插件),文案按
    最小暴露原则只含 scheme+host+port(path/query/fragment 一概不进
    文案,防令牌类内容经提示面外泄);非 Windows 降级 eprintln;
  - **window.open/新窗请求**:走 WebView2 NewWindowRequested——壳未注册
    新窗处理器,wry 0.57.0 默认 `SetHandled(true)` **拒绝**(webview2/
    mod.rs:849 实证);
  - **iframe 导航**:对上述回调不可见(WebView2 顶层 NavigationStarting
    不含 frame),防线是 local-api 页面自身 CSP(page.ts:72
    `default-src 'none'` 含 frame-src 回退,外域帧根本无法创建)。
  初始加载 URL 由代码构造、恒回环,不依赖回调放行。
- **托盘退出顺序(M8-03c,ADR 集成不变式)**:托盘菜单「退出」= 先停
  local-api 子进程(Job 树杀)再退出壳,顺序由 `main.rs::shutdown_
  sequence` 纯函数钉死并单测;关闭按钮 = 隐藏到托盘(壳常驻)而非退出,
  恢复路径 = 托盘菜单「显示主窗口」或托盘左键双击。菜单事件闭包只能
  「杀子进程」与「退出壳」,不经手任何令牌;serve 子进程所有权经
  `Arc<Mutex<_>>` 共享(JobHandle 以 unsafe impl Send 声明可跨线程,
  SAFETY 论证见 serve_child.rs——内核句柄非线程从属,且 Windows 菜单
  事件实际在事件循环主线程投递)。
- **严格 CSP(M8-03b)**:`tauri.conf.json` 的 `app.security.csp` 为
  `default-src 'none'`。作用域:该 CSP 只作用于壳自家协议(tauri:// /
  http://tauri.localhost)下由 `build.frontendDist` 提供的页面,即
  `shell-ui/` 构建占位页——纯 HTML、无脚本/内联样式/图片,故无需任何附加
  指令(保持指令面为空即最严);tauri 对自家协议响应会自动追加其注入 IPC
  初始化脚本所需的源(`dangerousDisableAssetCspModification` 默认
  false),严格值不破坏壳自身页面。真正加载的回环页面
  (`http://127.0.0.1:<port>`)是外部源,响应头 CSP 由 local-api 自带,壳
  不注入、不放宽——本配置对它不生效。注:tauri.conf.json 按**严格 JSON**
  解析(本批实测:JSON5 注释使 tauri-build 报 "key must be a string" 而
  失败),作用域说明因此记录在此处而非配置文件内。
- **进程树不留孤儿(M8-03b,Windows)**:serve 子进程 spawn 成功即入
  Job Object(唯一限额 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`):
  `ServeChild::kill()` 为 Job 树杀——TerminateJobObject 一次性终结整棵
  后代链(mise shim 场景下 direct child → mise → 真实 node 全部在内,
  单测按孙进程存在性轮询实证);壳进程自身死亡(含被外部强杀)时内核
  关闭 Job 最后句柄,整树兜底被杀,serve 不孤儿化。Job 只作用于壳自己
  spawn 的子进程;非 Windows 平台保持既有单进程 kill。实现依赖
  windows-sys(本批唯一新增 Rust crate,特性最小集:JobObjects +
  Threading + Foundation + Security,理由见 Cargo.toml 注释);
- **capability 近零(当前状态)**:`capabilities/main.json` 为占位
  (`windows: []` + `permissions: []`),且 `tauri.conf.json` 显式
  `app.security.capabilities: []`——页面侧没有任何壳命令通道;tauri-build
  已解析该占位 capability 且不授任何权限。**M8-03b 计划**:收敛并实测
  全部 command 拒绝(空 capability 下页面侧发起任意宿主调用被拒的证据
  回填 ADR);若实测证明必须引入 core 权限,取最小集并在此登记理由;
  同时把 `url::is_allowed_navigation`(已实现并单测)接到窗口导航锁定。
- 同用户任意代码执行不在威胁模型内;壳不以提权方式 spawn 任何进程。

## 当前 unverified(维护者冒烟清单)

1. 真实 WebView 窗口加载:窗口创建代码已实现但需在有图形会话的机器上
   `cargo run` 冒烟(加载回环页面、标题;关闭按钮→隐藏到托盘后 serve
   随壳常驻,退出经托盘——M8-03c 措辞更新,原「关闭窗口后 serve 子进程
   随之退出」为托盘化之前的旧预期,现行为见冒烟步骤 3-4 条)。
2. WebView2 在位率:**本验收机已实测**(pv=153.0.4234.48,
   check-webview2.ps1 exit 0,见「M8-03b 实测记录与探针」;M8-03c 按
   实况拆分改写,原「未实测」措辞过时);**剩**:最小支持系统的在位率
   抽样(发布期冒烟)与引导安装路径(外部写入,见第 8 条)。
3. capability 全拒绝证据:**静态层与产物层已实测**
   (tests/source_invariants.rs 三断言,默认门禁绿);**运行层探针**
   (`cargo run --example capability_probe`)在本验收机被
   STATUS_ENTRYPOINT_NOT_FOUND 阻塞(见「M8-03b 实测记录与探针」),
   需维护者在无此加载器问题的机器实跑并回填证据。
4. 发布(GUI 无控制台)形态下子进程 stderr 继承句柄的退化行为未验证:
   debug/控制台运行 stderr 正常转发。**里程碑归属勘误(M8-03c 统一)**:
   原稿「需在 M8-03b 改为管道+排水或日志文件」与实况不符——M8-03b 实际
   移交 M8-03c(M8-03b-BATCH.md unverified 第 8 条),M8-03c 已交付任务
   (托盘/导航提示/打包)未含 stderr 管道化,**顺延为后续任务**。
5. 导航锁定已在代码层接线并单测(on_navigation + 端口精确匹配),**壳内
   提示(M8-03c)与运行期拒绝证据需真窗冒烟**:按「维护者冒烟步骤」第
   5 条执行(DevTools Console 触发外域导航,预期 MB_OK 提示且文案仅含
   scheme+host+port、页面不跳转)。
6. 包体积:**已回填**(ADR【假设】栏:M8-03b 未打包主 exe 8.25MB;M8-03c
   同口径更新 8.48MB + NSIS 安装包 1.84MB,见「打包分发」节;M8-03c 按
   实况拆分改写);**剩**:内存占用实测(第 9 条,任务管理器读壳进程与
   WebView2 子进程常驻内存回填 ADR)。
7. KILL_ON_JOB_CLOSE 的外部强杀兜底(壳进程被任务管理器强杀 → Job 最后
   句柄关闭 → serve 整树被杀)是 OS 记载语义,本批未做进程级实证;冒烟
   方法:启动壳后在任务管理器结束壳进程,确认 serve/node 无残留
   (M8-03b 单测已实证的是 kill()/Drop 两条主动路径的树杀)。
8. WebView2 引导安装路径(Evergreen Bootstrapper 下载/安装)未实测——
   外部写入,步骤见「M8-03b 实测记录与探针」末条,归维护者。
9. 内存占用实测未回填(任务管理器读壳进程与 WebView2 子进程常驻内存,
   回填 ADR【假设】栏)。
10. **真窗托盘交互(M8-03c)无法自动化测试,归维护者冒烟**:托盘图标
    显示、右键菜单弹出、菜单「显示主窗口」/「退出」点击、左键双击恢复、
    关闭按钮隐藏到托盘——机制层已由单测覆盖的部分:菜单 id→动作映射、
    退出顺序(先停 serve 后退壳)、关闭拦截的接线代码在 setup 内;
    点击/双击/隐藏/恢复的真窗行为只能人工冒烟(冒烟步骤第 2-4 条)。
11. 导航拒绝提示的弹窗观感(文案换行、阻塞期间页面冻结属预期)与连续
    被拒导航的提示框排队行为(MB_OK 模态按序弹出)未做真窗验证。
12. **安装包(M8-05 任务 3 已在本机完成安装态冒烟,显式授权 per-user
    静默路径;证据见 reports/M8-05-BATCH.md §3)**:静默 /S 安装、落盘
    `%LOCALAPPDATA%\role-orchestrator-shell`(exe + serve-bundle.mjs +
    node-runtime\node.exe)、HKCU 登记且 HKLM 两视图无写入、卸载/重装
    均已实测;**开箱验证已过**:不设任何环境变量从安装目录启动 → serve
    进程链命令行指向安装目录捆绑资源(便携 node + serve-bundle.mjs,非
    仓库路径)、端口监听、无凭据 `/api/v1/session` 探测 403、默认 db 被
    serve 打开(WAL 旁文件现身)、任务管理器级强杀壳后 serve 链 0.6 秒
    清零(预算 4 秒)。**仍归维护者**:双击式 GUI 向导安装路径、真窗交互
    (窗口加载/标题/托盘/导航拒绝壳内提示——冒烟步骤 2-5 条),以及
    **真正干净 Windows 机器**(无仓库/无构建产物/无工具链)的端到端。
