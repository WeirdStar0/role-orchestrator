# role-orchestrator 桌面壳(M8-03a,Tauri v2 骨架)

本目录是**独立 Cargo 工程**,刻意**不注册进 pnpm workspace**(`pnpm-workspace.yaml`
不改):壳的 Rust/WebView2 工具链独立于 npm 侧 84 个外部依赖的审计面,按
[ADR](../../reports/M8-03-desktop-shell-adr.md) 以独立披露管理。

当前为 **M8-03a stage 1(可构建骨架)**:连接逻辑未实现,只建立
`src/serve_child.rs` / `src/health.rs` / `src/url.rs` 骨架与其安全约束注释。
`tauri.conf.json` 的 `app.windows` 为空数组——正式窗口由代码在 local-api
serve 子进程就绪后创建;`shell-ui/` 仅为 `build.frontendDist` 的构建占位,
运行时不会加载。

## 构建

```bash
cd apps/desktop-shell
cargo check   # 快速门禁;首次会从 crates.io 拉取并编译大量依赖,属正常
cargo build   # 完整编译(target/ 已在本目录 .gitignore 忽略)
cargo test    # 骨架阶段尚无测试用例
```

工具链:cargo/rustc ≥ 1.95(本机 1.95.0 已验证 `cargo check` 通过);Windows
渲染依赖系统 WebView2。

## 运行前置(下一阶段接入后生效)

- 仓库根 `pnpm build` 产出 `packages/local-api/dist`(含
  `serve-bin.js`,bin 名 `role-orchestrator-local-api-serve`);
- serve 启动形态:`node packages/local-api/dist/serve-bin.js --db <store.db路径>`
  (`--port` 缺省 0 = 临时端口;目录必须已存在,serve 不隐式建目录);
- 就绪判定:对 `http://127.0.0.1:<port>` 的 **HTTP 探测收到响应**——绝不以
  子进程 stdout 的 `{"event":"listening",...}` 诊断行判定成功(那行只是
  端口发现提示)。

## 安全不变式(摘要,完整论证与威胁建模见 ADR)

- **壳不经手令牌**:不读、不缓存、不放进子进程 argv/env、不持久化。令牌流
  保持「local-api 写 per-user 0o600 文件,操作者自行读取粘贴到页面」;
- **spawn 契约**:argv 数组、不开 shell、不经 cmd/bash 拼接;
- **导航锁定**:WebView 只允许回环 origin(127.0.0.1/localhost 等价形式),
  其余导航(window.open/重定向/外链)一律拒绝并在壳内提示;
- **capability 近零**:`capabilities/main.json` 为占位(`windows: []` +
  `permissions: []`),且 `tauri.conf.json` 显式 `app.security.capabilities:
  []`——页面侧没有任何壳命令通道。**M8-03b 将收敛并实测全部 command 拒绝**
  (空 capability 下页面侧发起任意宿主调用被拒的证据回填 ADR);若实测证明
  必须引入 core 权限,取最小集并在此登记理由;
- 同用户任意代码执行不在威胁模型内;壳不以提权方式 spawn 任何进程。

## 当前 unverified(维护者冒烟清单)

1. 真实窗口加载:窗口创建代码属下一阶段,本阶段未运行壳,WebView 正确加载
   回环页面未验证(ADR 待实测项 2)。
2. WebView2 Runtime 在位率与引导安装路径未实测(ADR 待实测项 1)。
3. capability 全拒绝证据未实测(本阶段连窗口都未创建;M8-03b 验收项)。
4. `cargo run` 未执行(骨架无窗口逻辑,运行只会有空事件循环);本阶段验证
   范围是 `cargo check` 可编译。
5. 包体积/内存实测数字未回填 ADR 的【假设】栏(M8-03b/c)。
