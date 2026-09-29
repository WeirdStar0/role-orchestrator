# M8-03c 开发批次报告:桌面壳 托盘/窗口管理 + 导航拒绝「壳内提示」 + NSIS per-user 打包 + 文档清理

日期:2026-09-29 · 执行角色:Developer · 基线:main 481f05af(M8-03b 治理批)·
候选提交:182f020 → ffc6226 → 74e4c7a → 本提交(治理)。
ADR:reports/M8-03-desktop-shell-adr.md(集成不变式 + 威胁建模)。

覆盖范围(本 Developer 会话接收并交付的任务 1、2、3、5;任务 4 未在本
会话接收,如另有交付以其自己的报告为准):

- **任务 1(托盘 + 窗口管理 + 导航拒绝壳内提示 + M8-03b 移交代码
  minor)**:Cargo.toml 启用 tauri `tray-icon` feature(未新增 Rust
  crate:tray-icon 0.25.1 本就是 tauri 可选依赖且 Cargo.lock 早已含其
  条目,启用后 Cargo.lock 实测零 diff;windows-sys 仅扩特性
  Win32_UI_WindowsAndMessaging(MessageBoxW/MB_OK,导航拒绝壳内提示),
  不引入任何 dialog/notification 插件)。托盘图标复用 bundle 资源
  icons/icon.ico(context default_window_icon,缺失 fail-closed panic);
  右键菜单「显示主窗口/退出」+ 左键双击恢复(show_menu_on_left_click
  false,菜单走右键);关闭按钮 = CloseRequested prevent_close + hide
  隐藏到托盘(ADR 集成不变式第 67 行);**托盘退出 = 先 Job 树杀 serve
  再 app.exit**——顺序抽成纯函数 `shutdown_sequence` 钉死并单测;
  serve 子进程经 Arc<Mutex<_>> 共享给托盘闭包,JobHandle 加
  unsafe impl Send(SAFETY:内核 HANDLE 非线程从属,注释论证)。导航
  拒绝提示(ADR 第 66 行落地,闭合审查 K 族):on_navigation 拒绝时
  MessageBoxW MB_OK,文案仅 scheme+host+port(最小暴露,单测钉死
  path/query/fragment 不进文案);非 Windows 降级 eprintln。移交代码
  minor:L 族(liveness try_wait Err fail-open→fail-closed + 取舍注释)、
  M 族(LOCALAPPDATA 非空但非绝对路径 is_absolute 拒绝 + 测试)、
  N 族(超时亚秒毫秒格式化 + 断言)、E/F/G 族注释级(spawn→Assign
  微秒窗口与 CREATE_SUSPENDED 取舍;金丝雀「类别名绕过」盲区自述;
  树杀测试判别力依赖 mise shim 前提)。菜单 id→动作映射纯函数单测。
- **任务 2(NSIS per-user 打包)**:tauri.conf.json bundle.targets
  ["nsis"] + windows.nsis.installMode "currentUser"(MSI/WiX 记录为
  可选目标);构建工具 tauri-cli v2.12.0(cargo install ^2 --locked,
  4m14s);首次构建从官方源下载 NSIS 工具链到 %LOCALAPPDATA%\tauri\
  (SHA1 校验,来源 github.com/tauri-apps binary-releases nsis-3.11.zip
  + nsis_tauri_utils.dll v0.5.3,tauri-bundler 2.10.0 源码实证);
  installMode currentUser 经 tauri-bundler installer.nsi 实证:
  RequestExecutionLevel user(无 UAC)、默认落盘
  %LOCALAPPDATA%\role-orchestrator-shell(任务假设 %LOCALAPPDATA%\Programs
  下不成立,按实证修正)、卸载登记 HKCU 非 HKLM;无 updater 配置
  (grep 0 处 + 无 tauri-plugin-updater);安装包未签名如实披露;
  serve 侧车不捆(fail-closed 拒绝启动)如实披露。
- **任务 3(M8-03b 十轮审查文档措辞清理)**:逐族修复见 PROPOSALS
  勘误/披露节;M8-03a-BATCH.md 历史快照不改原文,勘误入 PROPOSALS。
- **任务 5(治理)**:PROPOSALS 治理披露节 + 本报告 + CHECKSUMS 同步。

## 实际变更文件(基线 481f05a → 本提交累计,git diff --stat 实证)

`apps/desktop-shell/`:Cargo.toml、tauri.conf.json(bundle 三行)、
README.md、src/main.rs(托盘/提示/minor + 注释)、src/url.rs(现状化
注释)、src/serve_child.rs(Send 标记 + E/G 族注释)、
tests/source_invariants.rs(探针路径勘误 + F 族盲区自述)。
治理面:PROPOSALS.md(治理披露 + 勘误节)、CHECKSUMS.sha256(PROPOSALS
行两次同步:de0a3970…→f4ad917b…→ae8c5386…→本提交行)、
reports/M8-03-desktop-shell-adr.md(A/H/B/Q 族)、
reports/M8-03b-BATCH.md(B/C/J/T 族内联修正)、本文件。

未触碰(实证):packages/local-api/src/guard.ts、token.ts(git 零
diff)、全部 workspace 包 package.json 与 pnpm-lock.yaml、
pnpm-workspace.yaml(481f05a..HEAD 该路径零改动)、apps/desktop-shell/
Cargo.lock(零 diff,未新增 crate)、fixtures-real、能力清单
(capabilities/main.json 与 gen/schemas/capabilities.json 空授权断言
持续绿)。注意:本批零 npm 面改动,故未重跑 pnpm 全量门禁(下一阶段
统一跑;M8-03b 记录 204/204 为最近一次实证)。

## 实际执行的测试及退出码

| 命令 | 退出码 | 说明 |
|---|---|---|
| `cargo test --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 17 lib + 17 bin(新增 6:托盘映射/退出顺序/提示文案/wide/超时格式/非绝对 LOCALAPPDATA)+ 3 结构断言 passed / 0 failed,零警告;集成默认忽略。任务 1/3 后各复跑一次均绿 |
| `RO_SHELL_INTEGRATION=1 cargo test … -- --ignored` | 0 | `spawned_serve_child_reaches_local_api_over_loopback` 1 passed(0.58s/0.68s 两跑) |
| 跑后孤儿查证(原模式 serve-bin[.]js) | 0 | orphans=0 |
| 跑后孤儿查证(M8-03c 扩展双模式 `(serve-bin[.]js\|ro-shell[-]fake)`,R 族) | 0 | orphans=0,免自匹配已实测(命令行含字面 `[.]`/`[-]` 不被正则命中) |
| `cargo install tauri-cli --version "^2" --locked` | 0 | **tauri-cli v2.12.0**,编译 4m14s(19:52:52→19:57:09),安装至 ~/.cargo/bin/cargo-tauri.exe |
| `cargo tauri build` | 0 | release 编译 45.36s + NSIS 打包,全流程 51s;产物 `target/release/bundle/nsis/role-orchestrator-shell_0.1.0_x64-setup.exe` = **1,931,291 字节(1.84 MiB)**;同批 release 主 exe 8,886,272 字节(8.48 MB,较 M8-03b +237KB 系 tray-icon,仍在 ADR 3–10MB 假设带) |
| 产物核验(python/PowerShell 只读) | 0 | VersionInfo=role-orchestrator-shell 0.1.0;PE machine=0x014C(NSIS 32 位 stub 惯例,载荷 x64——build 日志 Info Target: x64);含 Nullsoft 标记 |
| `node planning-check.mjs` | 0 | 两次(治理披露同步后、勘误节同步后):CHECKSUMS 79/79 逐文件 + 干净副本自检 passed |
| git 零 diff 核验 | — | guard.ts/token.ts、Cargo.lock、pnpm 面均 481f05a..HEAD 零改动 |

## 未验证项(维护者冒烟,详见 apps/desktop-shell/README.md unverified 清单)

1. **托盘真窗交互**:图标显示/右键菜单/「显示主窗口」/「退出」点击/
   左键双击恢复/关闭按钮隐藏——机制层(映射、顺序、接线)已单测,
   真窗行为只能人工(冒烟步骤 2-4 条)。
2. **导航拒绝壳内提示真窗证据**:debug 构建 DevTools 触发外域导航 →
   MB_OK 弹窗、文案仅 scheme+host+port、页面不跳转(冒烟第 5 条);
   模态阻塞期间页面冻结与提示框排队属预期、未真窗验证。
3. **干净 Windows 安装运行冒烟**(安装属系统写入,Developer 不执行):
   无 UAC、落盘 %LOCALAPPDATA%\role-orchestrator-shell、HKCU 登记命中
   且 HKLM 全树无写入(reg query 核查法在 README)、/S 静默变体、
   安装态运行(需 RO_SHELL_SERVE_BIN 指路,侧车后续)、卸载。
4. **MSI 目标**:按 ask 记录为可选未启用(WiX 更重),维护者需要时
   targets 加 "msi" 再启。
5. 沿袭项:capability 真窗探针(0xc0000139 本机阻塞)、内存占用回填、
   最小支持系统 WebView2 在位率、KILL_ON_JOB_CLOSE 外部强杀进程级实证、
   stderr 管道化(顺延后续任务)、安装包签名。

## 风险

- **真窗行为零运行层证据**:托盘与导航提示的机制层单测绿,但本验收机
  非主程序 tauri 二进制加载崩溃(0xc0000139,沿袭 M8-03b 未定位)使
  真窗冒烟成为整批验收的前置——建议维护者优先冒烟第 2 条。
- **安装包未签名**:SmartScreen 未知发布者告警;签名链路属后续。
- **侧车不捆**:安装态开箱即用不成立(fail-closed 拒启动),操作者
  需 RO_SHELL_SERVE_BIN 指路——已 README 披露,侧车布局属后续任务。
- **tauri.conf.json 严格 JSON**:bundle 配置说明存放 README,存在文档
  漂移风险(CSP 与 bundle 变更必须同步)。
- **PROPOSALS/CHECKSUMS 冻结面义务**:本批三次同步校验和,后续任何
  PROPOSALS 变更都增加一次 planning-check 义务。

## ADR 引用(reports/M8-03-desktop-shell-adr.md)

- **集成不变式第 66 行**(非白名单导航一律拒绝并在壳内提示):任务 1
  交付(MB_OK 壳内提示 + 最小暴露文案),闭合审查 K 族;机制归因勘误
  (J 族)分层:顶层=on_navigation / window.open=NewWindowRequested
  默认拒 / iframe=local-api CSP,安全结论不变。
- **集成不变式第 67 行**(关闭→托盘;托盘退出先停子进程):任务 1
  落地并单测钉死顺序(shutdown_sequence)。
- **威胁建模 3(本地提权缓解)**:任务 2 落地——per-user 安装
  (currentUser → RequestExecutionLevel user)、不写 HKLM(卸载键
  HKCU)、不做服务、不要求管理员、无自动更新器;MSI 为未启用可选。
- **门禁 4(体积)**:主 exe 8.25→8.48MB 更新 + 安装包 1.84MB(首测),
  均在「3–10 MB 量级」假设带内,不触发重新评估。
