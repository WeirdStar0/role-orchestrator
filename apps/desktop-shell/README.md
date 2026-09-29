# role-orchestrator 桌面壳(M8-03a,Tauri v2)

本目录是**独立 Cargo 工程**,刻意**不注册进 pnpm workspace**(`pnpm-workspace.yaml`
不改):壳的 Rust/WebView2 工具链独立于 npm 侧 84 个外部依赖的审计面,按
[ADR](../../reports/M8-03-desktop-shell-adr.md) 以独立披露管理。

结构:`src/lib.rs`(纯逻辑库:serve_child / health / url)+ `src/main.rs`
(壳流程:参数解析 → spawn serve → HTTP 探测 → 建窗口)。窗口由代码在
local-api serve 子进程就绪后创建(`tauri.conf.json` 的 `app.windows` 为空
数组);`shell-ui/` 仅为 `build.frontendDist` 的构建占位,运行时不加载。

## 构建

```bash
cd apps/desktop-shell
cargo check   # 快速门禁;首次会从 crates.io 拉取并编译大量依赖,属正常
cargo build   # 完整编译(target/ 已在本目录 .gitignore 忽略)
cargo test    # 单元测试(url / serve_child / health / 壳参数);集成测试默认忽略
```

工具链:cargo/rustc ≥ 1.95(本机 1.95.0 已验证);Windows 渲染依赖系统
WebView2。

## 运行

前置:仓库根 `pnpm build` 产出 `packages/local-api/dist/serve-bin.js`;node
在 PATH 上。然后:

```bash
cd apps/desktop-shell
cargo run
```

流程与参数:

- 壳自身只接受 `--db <path>`(可选):缺省为
  `%LOCALAPPDATA%\role-orchestrator\orchestrator.db`(壳会显式创建默认目录;
  显式 `--db` 时不建目录,父目录缺失由 serve 按设计拒绝);
- 壳以 argv 数组 spawn `node …/serve-bin.js --db <path> --port 0`(无
  shell;不传任何令牌参数——壳不经手令牌,令牌流保持「local-api 写
  per-user 0o600 文件,操作者自行读取粘贴到页面」);
- 就绪判定:先从子进程 stdout 诊断行**发现**监听端口(仅提示),随后对
  `http://127.0.0.1:<port>` 做 **HTTP 探测**(收到任何合法状态行即在位,
  含 403 守卫拒绝)——绝不以 stdout 文本判定成功;
- 探测通过后创建标题 "Role Orchestrator" 的窗口加载
  `http://127.0.0.1:<port>`;健康检查失败打印诊断、非零码退出、不建窗口。

环境变量覆盖(开发用):`RO_SHELL_NODE`(node 路径,默认走 PATH)、
`RO_SHELL_SERVE_BIN`(serve 入口,默认
`../../packages/local-api/dist/serve-bin.js`,相对 apps/desktop-shell)。

### 维护者冒烟步骤(最小清单)

1. 仓库根 `pnpm build`(产出 `packages/local-api/dist/serve-bin.js`);
2. `cd apps\desktop-shell && cargo run`——预期:无控制台报错,数秒内弹出
   标题 "Role Orchestrator" 的窗口,加载 local-api 回环页面;
3. 关闭窗口——预期:壳与 local-api serve 子进程一并退出
   (任务管理器确认无残留 `role-orchestrator-local-api-serve`/node 子进程);
4. 故意给坏库路径 `cargo run -- --db C:\no-such-dir\x.db`——预期:打印
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

跑完后自证无孤儿残留(M8-03b 树杀验收,serve-bin.js 相关 node 进程必须
为零;查询命令本身不含 `serve-bin.js` 字面串,[.] 是免自匹配写法):

```powershell
powershell -NoProfile -Command '$m = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "serve-bin[.]js" }; "orphans=" + ($m | Measure-Object).Count; $m | Select-Object ProcessId,CommandLine | Format-List'
```

## 安全不变式(摘要,完整论证与威胁建模见 ADR)

- **壳不经手令牌**:不读、不缓存、不放进子进程 argv/env、不持久化;
  serve_child 的 argv 形态被单元测试钉死(恰 6 个元素,无任何令牌旗标);
- **spawn 契约**:argv 数组、不开 shell、不经 cmd/bash 拼接;
- **在位判定**:只靠回环 HTTP 探测收到响应;子进程 stdout 仅用于端口提示
  发现,发现后继续排水,不作为任何成功判据;
- **URL 规则与导航锁定(M8-03b 已接线)**:壳只加载
  `http://127.0.0.1:<port>`(禁止 localhost 字样、0.0.0.0、:: 与 userinfo
  形态);`WebviewWindowBuilder::on_navigation` 是运行期全部导航
  (window.open/重定向/链接点击)的唯一裁决点:`main.rs::navigation_allowed`
  在 `url::is_allowed_navigation` 白名单之上叠加「恰为本壳 serve 端口」的
  精确匹配,非白名单导航一律拒绝(false 阻止);初始加载 URL 由代码构造、
  恒回环,不依赖回调放行。
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
   `cargo run` 冒烟(加载回环页面、标题、关闭窗口后 serve 子进程随之退出)。
2. WebView2 Runtime 在位率与引导安装路径未实测(ADR 待实测项)。
3. capability 全拒绝证据未实测(M8-03b 验收项)。
4. 发布(GUI 无控制台)形态下子进程 stderr 继承句柄的退化行为未验证:
   debug/控制台运行 stderr 正常转发;windows_subsystem="windows" 的发布
   构建需在 M8-03b 改为管道+排水或日志文件。
5. 导航锁定已在代码层接线(on_navigation + 单测),但运行期拒绝证据
   (真实窗口里重定向/window.open/外链被拒并提示)需有图形会话的机器
   冒烟。
6. 包体积/内存实测数字未回填 ADR 的【假设】栏(M8-03b/c)。
7. KILL_ON_JOB_CLOSE 的外部强杀兜底(壳进程被任务管理器强杀 → Job 最后
   句柄关闭 → serve 整树被杀)是 OS 记载语义,本批未做进程级实证;冒烟
   方法:启动壳后在任务管理器结束壳进程,确认 serve/node 无残留
   (M8-03b 单测已实证的是 kill()/Drop 两条主动路径的树杀)。
