# M8-03a 开发批次报告:桌面壳脚手架(serve 入口 + Tauri 骨架 + 壳-local-api 连接)

日期:2026-09-28 · 执行角色:Developer · 基线:main 722cc7e(1593 测试 /
36 workspace 项目 / 外部依赖 84)· ADR:reports/M8-03-desktop-shell-adr.md
(已批准,Tauri v2)

## Summary

三个任务全部落地,候选提交 8751e9a → 90f2c68 → 818d519(治理批为本报告
所在提交):

- **任务 1(serve 入口)**:`packages/local-api` 新增独立进程入口——
  `src/serve.ts`(zod strict 参数 schema `{db, port 默认 0=临时端口}`;
  `parseServeArgs` 拒绝重复/未知/缺值/非法值并附一行 usage;`runServe`
  用 `openDatabase` 打开库、父目录不存在显式报错不隐式建目录;listen 后
  向 stdout 打一行 JSON 诊断 `{"event":"listening",boundAddress,port,
  tokenFile}`——诊断转发,令牌文件路径非秘密而文件本身 0o600,下游成功
  判定永不依赖该行,注释写明区分;幂等 `shutdown` server.close→db.close,
  SIGINT/SIGTERM 注册且注释 Windows 尽力而为)+ `src/serve-bin.ts`(薄
  bin,任何错误 stderr + exitCode 1)+ bin 登记 + 10 个测试。零新增 npm
  依赖;`guard.ts`/`token.ts` 未触碰。
- **任务 2(Tauri 骨架)**:新建 `apps/desktop-shell/` 独立 Cargo 工程
  (不入 pnpm workspace):tauri 2.12.0 / tauri-build 2.7.0,edition 2021,
  rust-version 1.95;`tauri.conf.json` productName/identifier/
  `app.windows: []`(窗口由代码在 serve 就绪后创建)/frontendDist 指向
  `shell-ui/` 构建占位页;capabilities 近零占位(`windows: []` +
  `permissions: []` + 配置显式空清单);32x32 32bpp 占位 icon 由
  `scripts/make-placeholder-icon.mjs` 纯字节构造;`.gitignore` 处理
  `/target` 与 `/gen/schemas`(根 .gitignore 未动)。
- **任务 3(壳-local-api 连接)**:`url.rs`(只允许构造
  `http://127.0.0.1:<port>`,禁 localhost/0.0.0.0/::;`is_allowed_navigation`
  规则函数防 userinfo/路径绕过、端口边界——本批仅单测与文档,M8-03b 接
  导航锁定);`serve_child.rs`(argv 纯函数恰 6 元素、断言无任何令牌旗标;
  spawn 无 shell,stdin 关/stdout 管道=端口提示发现+持续排水/stderr 继承
  转发;spawn 后立即 try_wait 校验存活;Drop kill+wait);`health.rs`
  (手写最小 GET,Host 恰为 `127.0.0.1:<port>`,收到任何合法状态行含
  403 即在位;`wait_healthy` 轮询);`main.rs`(--db 可选,缺省
  `%LOCALAPPDATA%\role-orchestrator\orchestrator.db`;spawn→端口提示发现
  (仅提示)→HTTP 探测 30s→`WebviewWindowBuilder` + `WebviewUrl::External`
  建窗口 "Role Orchestrator";健康检查失败 eprintln+非零退出不建窗口);
  `tests/integration.rs`(`#[ignore]` + `RO_SHELL_INTEGRATION=1` 双开关)。
- **任务 5(治理)**:本披露 + PROPOSALS.md 追加节 + CHECKSUMS 同步
  (PROPOSALS.md 纳入冻结面,口径修正已在 PROPOSALS 第 5 条如实披露)+
  README 完善。

## 实际变更文件

`packages/local-api/`:`package.json`(bin 字段)、`src/index.ts`(导出
serve + 文档)、`src/serve.ts`*、`src/serve-bin.ts`*、`test/serve.test.ts`*
(*新增)。

`apps/desktop-shell/`(全新目录):`.gitignore`、`Cargo.toml`、
`Cargo.lock`、`build.rs`、`tauri.conf.json`、`capabilities/main.json`、
`icons/icon.ico`、`scripts/make-placeholder-icon.mjs`、`shell-ui/index.html`、
`src/{lib,main,url,serve_child,health}.rs`、`tests/integration.rs`、
`README.md`。Rust 构建产物(target/、gen/schemas/)由目录内 .gitignore
排除,不入库。

治理面:`PROPOSALS.md`(追加节)、`CHECKSUMS.sha256`(+1 行,
9af4fa24…2513f)、`reports/M8-03a-BATCH.md`(本文件)。

未触碰:`pnpm-workspace.yaml`、`pnpm-lock.yaml`、全部 36 个 workspace
包的 package.json 依赖、`packages/local-api/src/guard.ts`、`token.ts`、
根 `.gitignore`、fixtures-real。

## 实际执行的测试及退出码

| 命令 | 退出码 | 说明 |
|---|---|---|
| `pnpm --filter @role-orchestrator/local-api run typecheck` / `test` / `build` | 0 / 0 / 0 | 任务 1 门禁;test 第二轮 202 passed(build 后 bin 冒烟实跑) |
| `cargo check --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 任务 2 门禁;首次拉取编译 tauri 全树 1m22s,重跑 0.85s 零 warning |
| `cargo test --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 14 lib + 4 bin 通过,1 集成默认忽略 |
| `RO_SHELL_INTEGRATION=1 cargo test … -- --ignored` | 0 | 真实集成:spawn node+serve-bin.js→端口提示=显式端口→探测在位→403(TOKEN_REQUIRED)与 200 断言→kill |
| `cargo build --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 完整编译 |
| `pnpm typecheck`(根,全仓) | 0 | 任务 5 全量五门 |
| `pnpm test`(根,全仓) | 0 | turbo 全缓存 70/70;另 `turbo run test --force` 强制实跑 0:1603 passed / 0 failed / 0 skipped(1593 基线 + serve 新增 10),含 release-audit repo-audit 断言 workspacePackageCount=36、externalPackages=84 全绿 |
| `pnpm build`(根,全仓) | 0 | 任务 5 全量五门 |
| `node planning-check.mjs` | 0 | (a) 79/79 校验和匹配(新增 PROPOSALS.md 行后);(b) 干净副本自检 exit 0 |

## 未验证项

1. **真实 WebView 窗口加载冒烟**:`cargo run` 需图形会话,本批未运行壳
   进程;窗口创建/加载回环页面/关闭后 serve 随之退出待维护者冒烟。
2. **WebView2 Runtime 在位率与引导安装路径**(ADR 待实测第 1 项)。
3. **capability 全拒绝证据**(空 capability 下页面侧宿主调用被拒)——
   M8-03b 验收项。
4. **导航锁定接线**(重定向/window.open/外链拒绝)——M8-03b;
   `url::is_allowed_navigation` 已实现并单测。
5. 发布(GUI 无控制台)形态下子进程 stderr 继承句柄的退化行为(M8-03b
   改管道+排水或日志文件)。
6. 包体积/内存实测数字回填 ADR【假设】栏(M8-03b/c)。
7. serve 的 SIGINT/SIGTERM 实际投递路径(Windows 无法可靠向子进程投递
   信号;注册/注销已单测,Ctrl+C 冒烟归维护者)。

## 风险

- **诊断行格式耦合**:壳的端口提示解析(`parse_listening_port`)与
  local-api 的 emit 格式按前缀+首 `"port":` 字段约定钉死(两侧单测);
  任一侧改格式必须同步并回归。
- **端口发现与存活的区分**:诊断行缺失只能靠 30s 超时判定,最终裁决仍是
  HTTP 探测;serve 进程若在 listen 后立即死,表现为健康检查超时。
- **工具链演进**:本机 rustc 1.95.0 的 std 已移除
  `CommandExt::windows_hide`(rmeta 扫描核实),已用底层等价
  `creation_flags(0x0800_0000)`(CREATE_NO_WINDOW)替代;Rust 升级需重验
  该路径。
- **PROPOSALS.md 纳入冻结面**(口径修正):后续任何批次修改 PROPOSALS.md
  必须同步 CHECKSUMS 并过 planning-check,否则冻结门禁失败。
- **壳默认 serve 路径相对 cwd**(`cargo run` 须在 apps/desktop-shell 下;
  可用 `RO_SHELL_SERVE_BIN`/`RO_SHELL_NODE` 覆盖):打包布局(M8-03b/c
  侧车资源)落地时必须改默认值。

## ADR 引用

- reports/M8-03-desktop-shell-adr.md:集成不变式五条(子进程启动、令牌流
  文件交付、URL 锁定回环、托盘退出顺序、关闭最小化)——本批实现前两条的
  连接层,后两条属 M8-03c;威胁建模 2c(stdout 仅诊断转发、argv 不传令牌)
  由 serve_child/health 的结构与单测落实。
- docs/BACKLOG.md M8-03a 行:本批交付连接层;「cargo build 通过」已实测,
  「WebView 正确加载页面」转维护者冒烟(unverified 1),「五条守卫全部
  生效」由 403/200 集成断言 + 全仓 1603 测试(含 guard 矩阵)回归证明。
