# 托盘「打开令牌文件」批次报告(TRAY-TOKENFILE-BATCH)

日期:2026-10-04 · 执行角色:Developer · 性质:M9-04 审查移交后续小功能
增量批(前驱:34a3ab4,v0.2.0 发布准备)。

## 1. 功能与设计(红线对照)

桌面壳系统托盘新增『打开令牌文件』菜单项,点击后**用系统默认程序打开
serve 的 session-token 文件**。ADR 硬红线「壳不经手令牌」的落地口径:

- 壳只持有 serve 诊断行报告的令牌文件**路径**(与端口发现同一 JSON 诊断
  通道;路径非秘密——reports/M8-03-desktop-shell-adr.md);壳不读取、不
  缓存、不复制该文件的任何内容,打开动作交 Windows `ShellExecuteW
  (0,"open",path,0,0,SW_SHOWNORMAL)`(系统默认 .txt 关联程序,不经
  shell 拼接参数);
- serve.ts **零改动**:listening 诊断行自 M8-03a 起已含 `tokenFile` 字段
  (serve.ts:241-248,值取 server.ts:1435)——勘察确认在位,bundle 无需
  重同步语义、local-api 测试无需动;活体佐证:以 dist/serve-bin.js 真实
  spawn 捕获诊断行,`FIELDS=event,boundAddress,port,tokenFile`、路径
  绝对、反斜杠以 `\\` 转义在行(探针为一次性脚本不入仓库,产物已清理);
- **严格解析**(serve_child.rs `parse_token_file_path`):行首前缀
  `{"event":"listening"` 与端口解析同约定;首个 `"tokenFile":"` 锚点后
  必须是合法 JSON 字符串值(最小转义集;非 JSON 转义/裸控制字符/代理对
  半码拒绝);unescape 后必须非空**绝对路径**且 ≤1024 字节防御上限
  (超长拒绝而非截断——截断产生指向不存在文件的假路径)。任一不满足
  静默 None(排水与端口发现不受影响),绝不 panic;
- **fail-safe 裁决**(main.rs `token_file_open_decision`,可测纯函数):
  路径已知且 `Path::exists` 才打开;未报告/空值/文件不存在 → MessageBoxW
  提示「令牌文件尚未生成(任务启动后自动创建)」(非 Windows: eprintln);
  lock 中毒同样收敛到提示;
- **平台门控**:菜单项仅 cfg(windows) 构建追加(非 Windows 保持 v0.2.0
  既有两项=行为零回归),非 Windows 分支降级 eprintln 且不参与菜单;
- windows-sys 特性最小新增 `Win32_UI_Shell`(ShellExecuteW;SW_SHOWNORMAL
  复用已启用的 Win32_UI_WindowsAndMessaging)——**零新增 crate**,
  Cargo.lock 零改动(git status 实证);无新增 npm 依赖;
- 既有托盘项(显示主窗口/退出)、关闭隐藏、serve 生命周期、健康检查、
  argv 凭据不变式全部不动(纯增量;argv 6/8 元素不变式测试原样保持
  且全绿)。

## 2. 实现明细(4 文件)

| 文件 | 变更 |
| --- | --- |
| `apps/desktop-shell/src/serve_child.rs` | ServeChild 新增 `token_file_path: Arc<Mutex<Option<String>>>`(与端口同模式);drain_and_discover 双槽(各自只取一次);新纯函数 `parse_token_file_path` + 访问器 `token_file_path()`(克隆返回不持锁);模块/函数文档同步(令牌文件路径字段消费披露) |
| `apps/desktop-shell/src/main.rs` | `TRAY_ID_OPEN_TOKEN_FILE="open-token-file"` + TrayAction::OpenTokenFile + 映射;cfg(windows) 菜单追加;`run_open_token_file`(lock→路径→裁决→ShellExecuteW/提示);`open_path_with_system_default`/`notify_token_file_not_ready` 双 cfg 分支;run() 菜单能力注释同步 |
| `apps/desktop-shell/Cargo.toml` | windows-sys features 追加 `Win32_UI_Shell`(仅 cfg(windows) 目标) |
| `apps/desktop-shell/README.md` | 菜单描述(Windows 三项/非 Windows 两项)+ 功能专节(红线/解析/裁决/特性披露)+ 人工冒烟清单第 7 步 |

测试增量(6 格):serve_child 纯函数正常形态(\\ 转义 unescape/正斜杠/
同 line 端口互不干扰)、恶意形态 12 断言(相对路径/./当前盘根 \foo/
空串/非字符串值/非 JSON 转义/裸换行/代理半码/未终止/超长拒/1024 边界
放行/前缀不符/字段缺失)、机制性真实 spawn 捕获、机制性无字段保持 None;
main.rs 裁决纯函数五断言(放行/未报告/不存在/空串/探针收恰原值)、
tray_menu_ids 扩展新 id 映射+近似串拒识。

## 3. 门禁(全量,exit 0)

- `cargo test --manifest-path apps/desktop-shell/Cargo.toml` = 0:
  **lib 32(+4)/ bin 19(+1)/ integration 1 ignored(按设计)/
  source_invariants 3**(fs 白名单与零 IPC 不变式过)。唯一 warning
  (tests/integration.rs 未用 PathBuf)经 git stash 对照实证为改动前
  既有,不在本批范围。
- `pnpm --filter @role-orchestrator/local-api test` = 0(23 文件
  246/246;serve.ts 未动,该门禁按 ask 条件不适用,实跑为非回归佐证)。
- 附加:`RO_SHELL_INTEGRATION=1 cargo test --test integration -- --ignored`
  = ok(真实 serve spawn → 新排水路径 → 健康探测 → 守卫 → kill)。
- 全量 `pnpm typecheck`(turbo 59/59)/ `pnpm test`(70 tasks)/
  `pnpm build`(35/35)= 0。**如实口径**:三项均为 turbo 缓存命中——
  本批 TS 输入相对上一实跑(34a3ab4 门禁+本会话 local-api 246/246)
  零变化,缓存命中即「输入未变」的确定性结论;壳侧 cargo test 为本批
  实跑。
- `node planning-check.mjs` = 0(见 §5,CHECKSUMS 同步后实跑)。

## 4. 构建链五步与本机卸载-安装-启动验证(全命令实跑)

README「打包分发」顺序:

1. `pnpm build` → 35/35(FULL TURBO);
2. `pnpm --filter @role-orchestrator/local-api run bundle:serve` →
   dist/serve-bundle.mjs **1,596,370 字节**;
3. `node scripts/fetch-node-runtime.mjs` → 幂等跳过(sha256 匹配钉值
   98843732431bad6c…,零网络);
4. `node scripts/sync-shell-sidecar.mjs` → sidecar/serve-bundle.mjs
   1,596,370 字节入树;
5. `cargo tauri build` → release 40.91s,Target x64,
   **role-orchestrator-shell_0.2.0_x64-setup.exe = 26,033,432 字节,
   sha256 eea620366c09599a32a56e80c35b15ac01403e11d13915205f5ad8d14f8bc
   751**(`Finished 1 bundle`)。构建树主 exe 8,993,280 字节,sha256
   fd2f84d064b1ce62…;二进制 grep 实证 `open-token-file`(菜单 id)与
   `ShellExecuteW` 各 1 命中;serve-bundle.mjs 含 `tokenFile` ×13
   (esbuild 文本直存),不含菜单 id——id 在壳 exe,符合分层。

**本机流程**(静默,经 PowerShell;M9-04 #65 教训:不经 bash 直启):

- 卸载前:数据目录 orchestrator.db sha256 `f1c1d714b195aa17…`(与
  M9-04 记录一致);无运行中壳/serve 实例。
- 静默卸载 `uninstall.exe /S _?=…`(Start-Process -Wait):安装目录仅剩
  uninstall.exe 自身(NSIS 不能删运行中自身映像,历批同现象)、HKCU
  登记键移除、数据目录原样(db sha 不变)。卸载器首进程 ExitCode 显示
  为空(GUI 进程 Start-Process 取值局限,如实登记),以目录/HKCU/数据
  三重终态替代判定。
- 静默安装 `setup.exe /S` → **INSTALL_EXIT=0**;四载荷在位:壳 exe
  8,993,280 字节、serve-bundle.mjs 1,596,370 字节(与 sidecar 入树副本
  `cmp` **逐字节相等**)、node-runtime\node.exe sha256=钉值、HKCU 恢复
  (DisplayVersion 0.2.0)。
- **安装 exe 与构建树 exe 差异如实披露**:3 字节不同(偏移
  6,732,153-55,字节 'NSS' vs 'UNK')——tauri 构建日志「Patching … with
  bundle type information: nsis」对安装器内嵌副本写的 bundle 类型标记,
  功能字节零差异;两份副本均含 `open-token-file` 与 `ShellExecuteW`。
- 启动(无环境变量):壳 pid **40872** → direct child serve pid **72160**
  (ParentProcessId 断言),serve 命令行逐字 = `node-runtime\node.exe
  serve-bundle.mjs --db …\orchestrator.db --port 0 --profiles
  …\profiles.json`(argv 8 元素:约定路径 profiles.json 在位被接线;
  serve 接受该文件启动 = 内容合法的旁证)。**真窗 'Role Orchestrator'
  可见**(EnumWindows,hwnd 173736052,pid=壳 40872)。
- serve 监听端口 **55874**(Get-NetTCPConnection 按 serve pid):
  `GET /` = **200**;`GET /api/v1/profiles/full` 无令牌 = **403
  TOKEN_REQUIRED**(守卫活体)。
- **令牌文件在位证据(路径元数据,内容零读取)**:
  %TEMP%\role-orchestrator-local-api\session-token-906a621ead0bf1d9.txt,
  LastWriteTime 2026-10-04 18:04:32 = 本次 serve 实例(44 字节 0o600
  形态由 serve 写);此刻点菜单 = 裁决放行路径。
- **『打开令牌文件』可用性间接证据链**(真窗点击不可自动化,见 §6):
  ① 安装形态 serve 与 dev 树 bundle 逐字节相同 → 诊断行 tokenFile 发射
  同一代码路径(dev 树活体探针已证);② 安装壳 exe 含菜单 id 与
  ShellExecuteW;③ 严格解析/裁决/提示三单元单测钉死;④ 当前会话令牌
  文件在位 → 点击即放行。
- 收尾:受控 `taskkill /PID 40872 /T /F` → 全树终结(含 mise shim 链
  31176→72160 及孙进程);SHELL: none / SERVE: none(孤儿=0);数据
  目录 db sha `f1c1d714…` 与卸载前逐字一致(数据目录为持久证据,不删
  库不改证);临时探针脚本与捕获文件已删。

## 5. 报告与披露(冻结面同步)

- 新增 `reports/TRAY-TOKENFILE-BATCH.md`(本文件;reports/ 不入冻结面
  清单,历批同口径)。
- `PROPOSALS.md` 追加「治理披露:托盘打开令牌文件(2026-10-04)」小节
  (设计只打开不经手/windows-sys 特性新增/门禁/unverified 移交)。
- `CHECKSUMS.sha256` PROPOSALS 行按盘上纯 LF 字节重算同步;CHANGELOG
  未动(ask 未列;0.2.0 已发布的 CHANGELOG 节不追溯,该功能条目随下一
  版本节收录,由维护者定夺)。
- `node planning-check.mjs` = 0((a) CHECKSUMS 79/79 + (b) 干净副本
  self-test)。

## 6. 未验证项(如实登记,归维护者)

1. **真窗托盘菜单点击**(『打开令牌文件』实弹 ShellExecuteW 拉起默认
   .txt 程序、『尚未生成』MessageBoxW 实弹)——真窗交互不可 headless
   自动化;单测覆盖路径捕获/严格解析/裁决/菜单 id 映射,README 冒烟
   第 7 步给出人工步骤。
2. cfg(not(windows)) 分支(菜单省略+eprintln 降级)未编译验证:本机
   rustup 仅 x86_64-pc-windows-msvc,tauri Linux 目标需系统级 GTK 依赖,
   交叉 cargo check 不可行;分支为 3 行内 eprintln,沿既有 cfg 先例。
3. ShellExecuteW ≤32 错误码分支(系统无 .txt 关联)由系统呈现、壳静默,
   未在安装形态演练。
4. GUI 向导安装形态与干净机器验证历批未跑,归维护者。
5. pnpm typecheck/test/build 为 turbo 缓存命中(TS 输入未变,见 §3
   口径);如需强制冷跑由维护者 `turbo force` 决定。
