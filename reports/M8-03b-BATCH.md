# M8-03b 开发批次报告:桌面壳安全加固(进程树审计 + CSP 导航锁定 + ADR 四项闭合)

日期:2026-09-29 · 执行角色:Developer · 基线:main c1c08da(M8-03a 治理批)·
ADR:reports/M8-03-desktop-shell-adr.md(2026-09-28 维护者「全选」批准,
本批已将状态头 Proposed→Approved 并回填四项【待实测】)

## Summary

三个开发任务加治理登记全部落地,候选提交 945890f → 6e9e3fd → 37cc391
(本报告与 PROPOSALS 披露为治理提交):

- **任务 1(进程树审计)**:`serve_child.rs` 引入 Windows Job Object 树杀——
  spawn 成功即 CreateJobObjectW + SetInformationJobObject(仅设
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)+ AssignProcessToJobObject(直接子
  进程原始句柄),赋 Job 失败 fail-closed 整体报错;kill() = TerminateJobObject
  + wait(树杀),Drop 先判存活再杀+幂等 wait,JobHandle 随 Drop CloseHandle
  (HANDLE 生命周期与「壳被外部强杀→Job 最后句柄关闭→整树被杀」的兜底语义
  注释写清);非 Windows 保持既有单进程 kill。唯一新增 Rust crate
  windows-sys 0.61.2(特性 JobObjects/Threading/Foundation/Security,理由见
  Cargo.toml 注释;Cargo.lock 仅 +1 行主依赖声明,该版本本就是 tauri 传递
  依赖)。测试卫生:fake 脚本 30s 自退兜底(kill 正常路径立杀);Drop 测试改
  只读存在性轮询(taskkill 全移除);新增孙进程树杀单测(Windows)与含空格/
  Windows 元字符 db 路径的 argv 机制性测试;166-169 注释按审查结论修正
  (补偿性 grep 限定非测试代码)。
- **任务 2(CSP 导航锁定 + M8-03a 归属本批 minor)**:`main.rs` 接线
  `on_navigation`(tauri 2.12 签名 Fn(&Url)->bool 以本地 crates 源核实),
  `navigation_allowed` = `url::is_allowed_navigation` 白名单 + 「恰为本壳
  serve 端口」精确匹配(url 模块预告的 M8-03b 叠加项),非白名单导航一律
  拒绝——初始加载 URL 由代码构造恒回环,回调是运行期全部导航的唯一裁决点
  (ADR 威胁建模 2b 落地);tauri.conf.json CSP `default-src 'none'`(严格
  JSON 实测不可承载注释,作用域说明入 README:仅作用于壳自家协议占位页,
  回环页面 CSP 由 local-api 自带,壳不注入不放宽);parse_shell_args 对齐
  serve strict(拒 `--` 旗标值,207 行注释修正后成立)+ 空 LOCALAPPDATA
  fail-closed;health.rs `wait_healthy_with_liveness` 存活钩子(listen 后
  崩溃秒级失败而非伪装超时)+ 80-82 注释修正;serve.ts shutdown 单飞化
  (重复调用返回同一条 in-flight promise)+ 信号退出链只挂一次(修复双重
  信号竞态提前 exit)、「父路径非目录」补测试;main.rs 布线可测化
  (`serve_ready_url_with` 成功/子进程死亡/超时/诊断行缺失四路径单测)。
- **任务 3(ADR 四项【待实测】闭合)**:①WebView2 在位率:一次性检测脚本
  `scripts/check-webview2.ps1` 本机实跑 pv=153.0.4234.48(exit 0);引导安装
  (外部写入)步骤入 README 归维护者。②guard 回归:引用既有测试(见下表)。
  ③capability 全拒+导航锁定:静态层+产物层结构断言入默认门禁
  (`tests/source_invariants.rs` 三测试);真窗探针按 ask 允许降级为示例 bin
  `examples/capability_probe.rs`(invoke 拒绝+外域导航拦截,证据 JSON 落盘),
  本机被 STATUS_ENTRYPOINT_NOT_FOUND(0xc0000139)阻塞——任何非主程序的
  tauri 链接二进制加载即崩(加载期、与目录无关),主程序正常,运行层证据
  不伪造、归维护者复跑。④体积:release 主 exe 8,649,216 字节(8.25 MB)
  回填;内存占用列维护者冒烟。另:壳「不持久化凭据」自查入测试(fs 白名单)。
- **任务 5(治理)**:ADR 状态头 Approved 化(指向 PROPOSALS.md 2026-09-28
  「全选」批准记录,初版可推翻条款保留;该文件不在冻结面,已核实)+ 实测
  回填节;PROPOSALS.md 追加「治理披露:M8-03b 桌面壳安全加固(2026-09-29)」;
  CHECKSUMS 同步 PROPOSALS 行(node crypto sha256);README 全量更新
  (PowerShell 集成变体/树杀后孤儿现状/探针跑法与预期输出/凭据不持久化
  自查/冒烟清单扩至 9 条)。

## 实际变更文件

`apps/desktop-shell/`:Cargo.toml、Cargo.lock(+1 行)、README.md、
tauri.conf.json(csp 一行)、src/{main,health,serve_child}.rs、
tests/source_invariants.rs*、examples/capability_probe.rs*、
scripts/check-webview2.ps1*(*新增)。
`packages/local-api/`:src/serve.ts、test/serve.test.ts。
治理面:reports/M8-03-desktop-shell-adr.md(状态头+回填节)、
PROPOSALS.md(追加节)、CHECKSUMS.sha256(PROPOSALS 行
9af4fa24…→de0a3970…)、reports/M8-03b-BATCH.md(本文件)。

未触碰:`packages/local-api/src/guard.ts`、`token.ts`(git 零 diff)、
pnpm-lock.yaml、pnpm-workspace.yaml、全部 workspace 包 package.json、
fixtures-real、tauri 能力清单(仍为空授权占位)。

## 实际执行的测试及退出码

| 命令 | 退出码 | 说明 |
|---|---|---|
| `pnpm typecheck`(根) | 0 | 58 任务全缓存 |
| `pnpm test`(根) | 0 | 70/70 任务;local-api 19 文件 204 passed(含 guard 拒绝矩阵) |
| `pnpm build`(根) | 0 | — |
| `npx turbo run test --force --filter=@role-orchestrator/release-audit` | 0 | repo-audit 6 测试 ✓;repo-audit.test.ts:62 `workspacePackageCount=36`、:68 `externalPackages=84` 断言实测通过 |
| `cargo test --manifest-path apps/desktop-shell/Cargo.toml` | 0 | 17 lib + 11 bin + 3 结构断言 passed / 0 failed;真实集成 `#[ignore]` 默认跳过 |
| `RO_SHELL_INTEGRATION=1 cargo test … -- --ignored` | 0 | `spawned_serve_child_reaches_local_api_over_loopback` ok(1 passed,0.63s):真实 spawn node(mise shim 链)+serve-bin.js → 端口提示=显式端口 → HTTP 探测在位 → 无凭据 `/api/v1/session` 403(TOKEN_REQUIRED)与带 Bearer/页面 200 断言 → kill |
| 跑后孤儿查证 | 0 | `powershell -NoProfile -Command '$m = Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -match "serve-bin[.]js" }; "orphans=" + ($m \| Measure-Object).Count'` → **orphans=0**(免自匹配写法;等价的 ask 原式 `match 'serve-bin\.js'` 同样零输出)。对照:M8-03a 时代每次 cargo test 确定性泄漏 2 条 shim 链孤儿,已根治 |
| `powershell … scripts/check-webview2.ps1` | 0 | FOUND HKLM\SOFTWARE\WOW6432Node\…\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5} **pv=153.0.4234.48**;HKLM 原生视图 ABSENT;HKCU ABSENT;RESULT: WebView2 Runtime IS present |
| `cargo build --release`(desktop-shell) | 0 | `target/release/role-orchestrator-desktop-shell.exe` = **8,649,216 字节(8.25 MB)** |
| `node planning-check.mjs` | 0 | CHECKSUMS 逐文件(含新 PROPOSALS 行)+ 干净副本自检 |
| 探针 `RO_SHELL_PROBE=1 cargo run --example capability_probe` | **未跑通** | 退出码 0xc0000139(STATUS_ENTRYPOINT_NOT_FOUND):**加载期**崩溃(无任何 stdout,main() 未执行),与所在目录无关(复制到 target/debug/ 同崩);`cargo test` 测试装置形态同崩。对照:同一依赖集的主程序二进制正常加载运行(`cargo run -- --db C:\no-such-dir\x.db` CLI 全流程:serve 诊断转发、壳失败路径非零退出、无窗口)。运行层证据不伪造,探针装置保留待维护者机复跑 |

## 未验证项(维护者冒烟清单,详见 apps/desktop-shell/README.md)

1. capability 全拒+导航锁定的**真窗运行层证据**:`$env:RO_SHELL_PROBE="1";
   cargo run --example capability_probe`,预期 `PROBE_EVIDENCE {"invoke_denied":
   "<拒绝详情>", "invoke_resolved": false, "nav_example_com_seen": true,
   "nav_example_com_blocked": true, "diagnostics": []}` + `PROBE_RESULT: …
   成立`——本验收机被 0xc0000139 阻塞,需无此加载器问题的机器。
2. 主程序 WebView 窗口加载冒烟(cargo run;探针的加载器崩溃是否同样影响
   主程序窗口创建路径未知,冒烟时留意)。
3. KILL_ON_JOB_CLOSE 外部强杀兜底(任务管理器结束壳进程→serve 整树退出)
   的进程级实证(冒烟步骤+核验命令在 README 冒烟第 3 步)。
4. WebView2 引导安装路径(Evergreen Bootstrapper 下载/安装,外部写入)。
5. 内存占用实测回填(任务管理器读壳+WebView2 子进程)。
6. 最小支持系统的 WebView2 在位率(本批样本=验收机 1 台)。
7. CI Windows 通道(ADR 影响节待实测,不随本批闭合)。
8. 发布(GUI 无控制台)形态 stderr 退化行为(M8-03c 改管道+排水或日志)。

## 风险

- **探针加载器问题根因未定位**:0xc0000139 出现在任何 tauri 链接的非主
  程序二进制上(测试装置/示例 bin),PE 导入表比对时间盒内未定位缺失入口
  点。若主程序窗口创建冒烟同样崩溃,则属本机 rustc/MSVC 工具链与系统 DLL
  契合问题,将同时阻塞 M8-03c 的 GUI 冒烟——建议维护者优先冒烟第 2 条。
- **tauri.conf.json 为严格 JSON**:CSP 作用域说明存放于 README,存在文档
  漂移风险(CSP 变更时必须同步 README「安全不变式」节)。
- **PROPOSALS.md 冻结面纪律**:自本批起其 CHECKSUMS 行随内容变化必须同步
  并过 planning-check,任何治理披露都增加一次冻结面更新义务。
- **windows-sys 特性面**:Win32_Security 因 CreateJobObjectW 绑定签名引入,
  实际未使用该类型(调用传 null);若未来 windows-sys 版本收紧特性映射需
  重核四个特性的最小性。
- **ADR 状态 Approved**:重新评估条件(最小支持系统 WebView2 不可用等)
  仍然有效,批准不豁免逐批验收。

## ADR 引用(reports/M8-03-desktop-shell-adr.md「M8-03b 实测回填」节,逐条映射)

1. **门禁 1(WebView2 Runtime 在位率与引导安装)**:在位率已实测——
   scripts/check-webview2.ps1 exit 0、pv=153.0.4234.48(证据:本报告上表
   + ADR 回填第 1 条);引导安装路径=外部写入,未执行,步骤移交维护者
   (README「M8-03b 实测记录与探针」末条)。样本边界如实标注:验收机 1 台,
   最小支持系统在位率仍属发布期冒烟,不触发重新评估条件 5。
2. **门禁 2(壳加载回环页面后 guard 管道全量回归)**:已实测——guard.ts/
   token.ts 零 diff(git 可证),`pnpm test` 根门禁 70/70(local-api 204
   含 guard.test.ts 五条拒绝语义矩阵),壳侧真实集成 403(TOKEN_REQUIRED)/
   200 断言 exit 0(证据:本报告上表 + ADR 回填第 2 条)。
3. **门禁 3(capability 全拒与导航白名单拒绝证据)**:静态层(零 command
   注册)与产物层(capabilities.json 空授权)已实测绿
   (tests/source_invariants.rs,证据:ADR 回填第 3 条 + 本报告上表);
   导航锁定已接线并单测(main.rs navigation_allowed 含端口精确匹配);
   **运行层真窗探针未在本机跑通**(0xc0000139,装置已交付
   examples/capability_probe.rs),归维护者复跑——ADR 回填如实标注。
4. **门禁 4(包体积/内存回填【假设】栏)**:体积已实测——release 主 exe
   8,649,216 字节(8.25 MB),落在「3–10 MB 量级」假设区间内(未打包主 exe
   口径,安装包属 M8-03c),不触发重新评估;内存占用未回填,归维护者冒烟
   (README)。CI Windows 通道(影响节)不随本批闭合。
