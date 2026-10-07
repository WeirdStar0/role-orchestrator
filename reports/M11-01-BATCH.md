# M11-01 批报告:Desktop Renderer 基座(令牌自动会话 + /app 新 UI)

批次日期:2026-10-07(本文件不入冻结面,历批同口径)

## 1. Summary

v0.4.0「Desktop Product Experience」第一批(M11-01)全部五个范围项交付,
两个开发提交加一个终化提交:

- **任务 1 令牌自动会话(commit aa49f7c,13 文件)**:ADR
  docs/adr/010-token-auto-session.md 新建(冻结面,CHECKSUMS 增行)+壳侧
  令牌注入实现(session.rs 纯函数+WebView2 接线+结构金丝雀)+page.ts 唯一
  页面增强(已认证隐藏令牌栏,手动流零回归)+page.test.ts 同步。
- **任务 2 新 UI 基座(commit 7ebeb9c,43 文件)**:apps/desktop-ui 新包
  (白名单内栈)+设计 token+四入口布局+/app 首页接既有 POST /runs+
  项目/历史/设置骨架+单文件构建与 local-api/壳/安装器接线+审计双登记
  (boundary+release+THIRD_PARTY_NOTICES)+browser-e2e /app smoke+
  新增只读 GET /api/v1/projects(范围判断如实披露:项目列表无既有端点)。
- **任务 4 批交付终化(本提交,5 文件)**:本批报告+PROPOSALS 治理披露+
  BACKLOG 完成态+backlog.json deliveryNotes+CHECKSUMS 终同步。

提交链如实(以 git log 为准):aa49f7c(任务 1)→7ebeb9c(任务 2)→本提交
(任务 4 终化)。本工作流的 ask 序列为任务 1/2/4,无独立「任务 3」提交;
V031-02 先例口径:ask 编号与提交编号不一一对应时以 git log 与本节为准,
不虚构造数。

红线遵守:orchestration 语义零变化(既有 API 端点/守卫管线/调度/事件协议
零改动——任务 2 新增的 GET /api/v1/projects 是只读新端点,不动任何既有
语义);旧页 / 与全部行为本批不动(/debug 重定位按 3b5a168 勘误留 M11-03);
browser-e2e 旧页测试面零回归(12 文件 23/23 实跑);新依赖全在 M11 白名单
内;git add 显式路径;无 push 无 tag。

## 2. ADR 摘要与红线修订(docs/adr/010-token-auto-session.md)

- **背景**:手动复制粘贴令牌是首启最大障碍;v0.1.0 红线「壳不经手令牌」与
  维护者 2026-10-07 批准方向(M11 立项:「会话令牌从界面完全消失,壳自动
  建立认证会话」)冲突,本 ADR 记录修订。
- **方案对比**:壳注入 Authorization(选定)/一次性引导码(拒——令牌进
  URL 泄漏类且须改 serve 语义)/维持手动(拒——不解决障碍,留作回退)/
  tauri `on_web_resource_request`(技术不可行:tauri-2.12.0
  webview_window.rs 文档原文 "Currently only implemented for the tauri URI
  protocol…not executed when using external URLs",本会话以本地 crates 源
  核实)。
- **选定机制**:serve 健康就绪后壳读令牌文件**一次**进内存,经 WebView2
  `WebResourceRequested` 对 `http://127.0.0.1:<serve 端口>` 请求注入
  `Authorization: Bearer <token>`;页面加载探测 /api/v1/session(不带本地
  令牌),200⇒隐藏令牌栏,拒绝⇒手动流原样。
- **缓解清单(六条,均有测试锚)**:①仅 loopback 来源注入(过滤器字面量
  +回调内纯函数复核,与 navigation_allowed 同口径);②内存中转(一份
  String 随闭包移动);③不落日志不持久化(source_invariants 金丝雀:
  session.rs 零日志宏零文件写;全壳 fs 白名单恰两处);④令牌文件 ACL
  不变(壳只读,token.ts 零改动);⑤壳不记日志(诊断只含 COM 步骤名);
  ⑥页面不可读令牌(网络层头注入;哨兵 shell-auto-session 非凭据,误达
  服务器即 403 fail-close)。
- **安全论证**:令牌文件可见边界本就是当前 OS 用户(token.ts home/temp
  fail-closed + 0o600/NTFS per-user);壳是该用户的既有进程,读取不引入
  新主体,威胁模型不变。风险转移点如实披露:壳进程内存驻留令牌内容
  (此前仅 serve 进程驻留),跨用户隔离仍由文件 ACL 与 OS 会话边界承担。
- **红线修订面**:「壳不经手令牌」修订为「壳只读一次+回环注入」,过时
  表述在 main.rs/serve_child.rs/lib.rs/integration.rs/desktop-shell README
  同步修订;desktop-shell 的 argv/env 零令牌参数与零持久化不变式保留。

## 3. 自动认证实现(壳侧,commit aa49f7c)

- `src/session.rs` 新建,判定逻辑纯函数+单测:session_token_from_content
  (43 字符 base64url 常量形态校验)、read_session_token(未报告/空路径
  零触达文件系统,IO 注入,失败⇒None⇒降级手动流)、
  authorization_header_value(Bearer 构造;空白/CRLF 头注入形态/非 ASCII
  拒绝)、should_inject_authorization(url 白名单+显式端口精确匹配)。
- `install_authorization_injection`(cfg windows):`with_webview` →
  ICoreWebView2(webview2-com 0.39,=wry 0.57 同版本传递依赖,Cargo.lock
  零新增 crate)→ `AddWebResourceRequestedFilter("http://127.0.0.1:<port>/*",
  ALL)` → `add_WebResourceRequested` 回调复核后 `SetHeader`(替换语义)。
  Cargo.toml 增 webview2-com 0.39 + windows-strings 0.5 两个直接依赖
  (均为树内同版,锁文件仅包清单两行)。
- main.rs 布线:serve_ready_url 成功后读令牌一次(路径取 serve 诊断行
  tokenFile 字段)→ with_webview 移动 `Option<String>`;None 不接线;
  COM 失败 eprintln 仅步骤名,壳继续运行。
- 结构金丝雀(tests/source_invariants.rs):SOURCES 增 session.rs;fs
  白名单恰两处(main.rs create_dir_all + main.rs 注入的 read_to_string);
  新测试 session_module_never_logs_or_writes_the_token(零
  println!/eprintln!/print!/dbg!/tracing/log::/写盘形态)。壳 IPC 命令面
  空集不变式保留。
- **已知限制(ADR 如实披露)**:旧页直播流(WS)依赖 WebView2 运行时对
  ws:// 握手触发 WebResourceRequested(升级守卫本就接受可选 Bearer 头并
  preAuthenticate);不触发的运行时上该流按服务器既有 fail-closed 拒绝
  (页面轮询不受影响)。真窗核验归维护者(见 §9)。
- page.ts 增强(本批唯一页面行为变化):探测 /api/v1/session→已认证隐藏
  #connect 令牌栏+哨兵播种+csrf 缓存;未认证/纯浏览器零 DOM 变化;
  CSS 补 `#connect[hidden]{display:none}`;page.test.ts 增三测试共 33 过。

## 4. 新 UI 基座(commit 7ebeb9c)

- **结构**:apps/desktop-ui 新包(Vite 8.3 + React 19.3 + TS 5.9 +
  React Router 7.18 + Lucide 1.52,逐一 pnpm view 核实 peer/license,全部
  在 M11 冻结白名单);无重型 UI 库——组件原语自建(components/ui.tsx)。
  tsconfig 独立(bundler 解析,镜像根 strict 全集)。测试走
  react-dom/server renderToString(无 jsdom/testing-library,白名单零
  外溢),10/10 过。
- **token(src/tokens.css)**:Light/Dark 跟随系统(prefers-color-scheme);
  中性灰阶+恰四状态色 running/success/error/warning;1px 边框
  (--border-w);8/12px 圆角(--radius-s/--radius-m);无大面积阴影;
  Inter/系统中文字体栈;主区 --max-read: 900px;侧栏 --sidebar-width:
  240px(220-260 冻结带内)。
- **四入口**:侧栏 NavLink(新任务 SquarePen/项目 Folder/历史 History/
  设置 Settings,纯文本断言钉死)+ /app 根路由(basename);首页
  NewTaskPage=『今天想完成什么?』hero+目标输入(textarea,maxLength
  10000)+项目下拉(GET /api/v1/projects,空则引导旧工作台登记)+开始执行
  (POST /runs:objective+projectDir 恰好 allowlist;类型化 400/422/503
  人话化——runErrors.ts 词汇对齐旧页 createRunFailureText;校验留服务端)
  →成功 navigate /app/runs/:id 占位详情页(人话状态,不渲染内部 id);
  项目页(只读列表 repoRoot+createdAt)/历史页(run 列表人话状态:
  runStatus.ts outcome 优先派生 执行中/已完成/失败/等待审批/已取消,防
  RUNNING 假执行中;SSR/真 DOM 双面断言)/设置页(M11-05 占位+旧页链接)。
  内部 ID 不进默认视图:GET /api/v1/projects 不发 id,组件不渲染 id,
  shell 测试断言 csrfToken/profileId/run-x/proj-x 均不出现。
- **首页接线**:api.ts 客户端刻意不发 Authorization(认证=壳注入,ADR
  010);CSRF 经 GET /api/v1/session 取得后随 POST 回传;未认证状态呈显式
  人话(浏览器直开提示),不产生控制台噪音。
- **新增只读端点(范围判断如实披露)**:项目列表无既有端点
  (GET /api/v1/projects/role-bindings?projectDir=… 是按目录查询,runs 列表
  不含 projectDir),历史页与首页下拉需要 repoRoot——新增
  GET /api/v1/projects(views.ts::listProjectSummaryViews,只回
  repoRoot+createdAt,守卫管线照全站)。既有端点语义零改动。

## 5. 静态产物接线决策

- **单文件构建**:vite.config.ts 内本地插件 `appSingleFile`(零新增 npm
  依赖)在 generateBundle 把 JS/CSS 内联进唯一 dist/index.html(281.78KB
  实测);替换用函数形式(字符串替换会解释 \$&/\$' 序列——实测踩过并
  修复);残留外链/意外资产/多文件即 fail the build;`</script`→`<\/script`
  转义防自终止。
- **local-api 服务**:app-ui.ts 定位链(①安装布局:与 serve 入口同目录的
  desktop-ui.html——NSIS resource;②仓库 dev 布局:apps/desktop-ui/dist/
  index.html,相对 import.meta.url 解析,tsc dist 与 esbuild bundle 双形
  态兼容)→启动读一次→按所服务字节逐块 sha256 生成内容哈希 CSP
  (`script-src 'sha256-…'`,无 unsafe-inline,default-src 'none' 底线)。
  **与 CSP 兼容理由**:单文件的内联脚本不是放行内联,而是钉死到具体构建
  产物,纪律等价旧页 `script-src 'self'` 且更强。**与安装器兼容理由**:
  serve 侧是单 esbuild bundle,新 UI 同为单文件,安装器只多携带一个资源
  文件(tauri.conf.json resources 增 sidecar/desktop-ui.html;
  scripts/sync-shell-sidecar.mjs staging 两件,缺 desktop-ui 构建时指名
  `pnpm --filter @role-orchestrator/desktop-ui run build` 报错)。
- **缺失降级**:产物缺失(旧安装包/未构建树)/app 以 302 回退 /(旧页)
  ——每个候选保持产品可用,不出现 404 死路;app-route 测试钉死(含
  non-loopback Host 在 302 前被守卫拒绝的 A30 连续性)。
- **壳默认 URL**:url.rs::loopback_url → `http://127.0.0.1:<port>/app`
  (范围④);导航白名单对 path 不敏感,仍只认 scheme/host/port。
- **turbo 依赖的等效方案说明**:desktop-ui 与 local-api 零 workspace 依赖
  (纯 HTTP 面),构建互相独立;产物在 serve **运行时**读取而非构建期内联
  (tsc 不能内联 HTML,esbuild 单包不含桌面产物亦可运行),因此无需跨包
  构建依赖边;仓库根 `pnpm build`(turbo)天然先产出 desktop-ui dist,
  `pnpm test` dependsOn build 保证 browser-e2e smoke 运行时产物在位。
  完整理由书见 apps/desktop-ui/README.md。

## 6. 审计双登记(37→38 + 新外部依赖)

- **boundary-audit**:BoundaryAuditOptionsSchema 增 additionalPackageDirs
  (默认 [] ,fixtures 全兼容);repo 级新 pin 测试(repo-audit.test.ts):
  扫 packages/+apps/ ⇒ workspacePackageCount 37、零违规、manifest 37 名、
  allowlist 七名;并如实钉死「默认扫描对 apps/ 成员不可见」的覆盖差距
  (R4a 只对发现的包触发)。OPEN_CORE_PACKAGE_MANIFEST 36→37 增
  @role-orchestrator/desktop-ui;CORE_EXTERNAL_RUNTIME_ALLOWLIST 增
  react/react-dom/react-router-dom/lucide-react(冻结 UI 栈;vite/
  @vitejs/plugin-react/typescript 留 devDependencies,归 release-audit
  lockfile 面)。套件 36/36。
- **release-audit**:repo-audit.test.ts pin 更新——importers 37→38;
  外部依赖 111→123;licenseSummary MIT 46→57 / ISC 3→4(11 MIT + 1 ISC
  本机安装,平台门控集合不变);runtime externals = ws/yaml/zod + 四 UI
  栈;THIRD_PARTY_NOTICES 覆盖 111→123。套件 43/43。
- **THIRD_PARTY_NOTICES.md**(冻结面):增录 12 名(@types/react、
  @types/react-dom、@vitejs/plugin-react、cookie、csstype、lucide-react、
  react、react-dom、react-router、react-router-dom、scheduler、
  set-cookie-parser),头部计数行与两个分节数更新;CHECKSUMS 行重算
  de9e35be→eaf76924。
- **范围披露**:PROPOSALS.md 的 count-baseline 变更披露(37→38、111→123)
  按历批惯例随本交付节(治理披露:M11-01 交付)承载。

## 7. 变更文件清单(批累计,三提交)

任务 1(aa49f7c,13 文件):docs/adr/010-token-auto-session.md(新)、
CHECKSUMS.sha256、apps/desktop-shell/Cargo.toml、apps/desktop-shell/Cargo.lock、
apps/desktop-shell/README.md、apps/desktop-shell/src/lib.rs、
apps/desktop-shell/src/main.rs、apps/desktop-shell/src/session.rs(新)、
apps/desktop-shell/src/serve_child.rs、apps/desktop-shell/tests/integration.rs、
apps/desktop-shell/tests/source_invariants.rs、packages/local-api/src/page.ts、
packages/local-api/test/page.test.ts。

任务 2(7ebeb9c,43 文件):CHECKSUMS.sha256、THIRD_PARTY_NOTICES.md、
pnpm-workspace.yaml、pnpm-lock.yaml、apps/desktop-shell/README.md、
apps/desktop-shell/src/main.rs、apps/desktop-shell/src/url.rs、
apps/desktop-shell/tauri.conf.json、scripts/sync-shell-sidecar.mjs、
packages/boundary-audit/src/audit.ts、packages/boundary-audit/src/core-manifest.ts、
packages/boundary-audit/test/audit.test.ts、
packages/boundary-audit/test/repo-audit.test.ts(新)、
packages/release-audit/test/repo-audit.test.ts、packages/local-api/src/app-ui.ts(新)、
packages/local-api/src/index.ts、packages/local-api/src/server.ts、
packages/local-api/src/views.ts、packages/local-api/test/app-ui.test.ts(新)、
packages/local-api/test/app-route.test.ts(新)、
packages/browser-e2e/test/app-shell-smoke.test.ts(新)、
apps/desktop-ui/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,
index.html,README.md}(新 6)、apps/desktop-ui/src/{main.tsx,App.tsx,api.ts,
app.css,tokens.css,runStatus.ts,runErrors.ts}(新 7)、apps/desktop-ui/src/
components/ui.tsx(新)、apps/desktop-ui/src/pages/{NewTaskPage,ProjectsPage,
HistoryPage,SettingsPage,RunDetailPage}.tsx(新 5)、apps/desktop-ui/src/
{runStatus,runErrors}.test.ts+shell.test.tsx(新 3)。

任务 4(本提交,5 文件):reports/M11-01-BATCH.md(新,不入冻结面)、
PROPOSALS.md、docs/BACKLOG.md、project/backlog.json、CHECKSUMS.sha256。

## 8. 测试及退出码(2026-10-07 本会话实跑,逐命令)

| 命令 | 结果 |
| --- | --- |
| `cargo test`(apps/desktop-shell,任务 1 后与任务 2 后各一轮) | ok 37 passed(lib)+ ok 19 passed(bin)+ 1 ignored(集成,env 门)+ ok 4 passed(source_invariants)+ ok 0(doc-tests);exit 0 |
| `node planning-check.mjs` | (a) 80/80 checksums match+(b) self-test exit 0;进程 exit 0 |
| `pnpm typecheck`(仓库根,turbo) | 62/62 successful;exit 0 |
| `pnpm build`(仓库根,turbo) | 37/37 successful;exit 0 |
| `pnpm test`(仓库根,turbo,全仓) | 74/74 tasks successful;exit 0(local-api 26 文件 285/285 在内) |
| `pnpm --filter @role-orchestrator/desktop-ui run build` | vite build → dist/index.html 281.78 kB 单文件;exit 0 |
| `pnpm --filter @role-orchestrator/desktop-ui run typecheck` | 无错误;exit 0 |
| `pnpm --filter @role-orchestrator/desktop-ui run test` | 3 文件 10/10 passed;exit 0 |
| `pnpm exec vitest run`(packages/local-api,全量) | 26 文件 285/285 passed(含新 app-ui+app-route 14/14);exit 0 |
| `pnpm exec vitest run`(packages/browser-e2e,全量直跑) | 12 文件 23/23 passed(8 flow+evidence-rotation+M 系+a38/a39+新 app-shell-smoke);exit 0 |
| `pnpm --filter @role-orchestrator/boundary-audit run test` | 36/36 passed;exit 0 |
| `pnpm --filter @role-orchestrator/release-audit run test` | 43/43 passed;exit 0 |
| `node scripts/sync-shell-sidecar.mjs` | staged serve-bundle.mjs(1708278 bytes)+desktop-ui.html(281784 bytes);exit 0 |
| 43+13 文件 BOM/CR 检查(python 逐字节) | 全部 BOM=False CR=0(纯 LF) |

## 9. 未验证项

1. **真窗人工观察(归维护者)**:壳内 /app 实际渲染+令牌自动认证端到端
   (含页面令牌栏自动隐藏、POST /runs 真实建任务)、WS 直播流在当前
   WebView2 运行时是否随握手注入 preAuthenticate(ADR 已知限制,不触发时
   按服务器 fail-closed 拒绝、轮询不受影响)——headless 不可达,属维护者
   环境动作③的扩展面。
2. 安装态(NSIS 打包→安装→壳加载 /app 读 desktop-ui.html 资源)未实跑;
   tauri-build 对新 resource 的校验已由 cargo test 通过,完整安装链归
   M11-05 安装态 E2E。
3. 10 轮审查属批次后续流程(完成标准内),本报告交付时未开始。
4. PROPOSALS/BACKLOG 的审计基线变更披露随本交付节登记;历批「审查拦截
   记录」节在本批尚无内容(审查未开始),后续轮次以批报告增节承载。

## 10. M11-02 交接

- **已就绪面**:自动认证(壳)使 M11-02 的首启向导可以在零令牌输入下建
  任务;/app 骨架的新任务页已有项目下拉+目标输入,首启向导(M11-02)接入
  点=NewTaskPage 的空项目引导态(当前指向旧工作台登记,M11-02 换成自动
  检测+默认 Profiles+默认绑定流程)与 /api/v1/projects 的空列表语义。
- **已知缺口(如实移交)**:①项目登记目前只发生在首次 POST /runs(422
  ROLE_BINDINGS_INCOMPLETE 登记信号)——M11-02 的「默认绑定」要落「干净
  环境→检测 CLI→生成默认 Profiles→默认四角色绑定」,需要 serve 侧编排
  配置写入路径(M9-03 的 profiles 写回端点已提供原子写回原语);②CLI
  自动检测(claude/codex 在位判定)尚无任何实现,需新的只读探测面
  (与壳的 health 探测同风格,argv 数组直调);③首启向导的 UI 容器
  (向导流)未预留路由,/app 路由表可直接扩展。
- **测试面交接**:desktop-ui 的 renderToString 测试模式(无 DOM 依赖)与
  browser-e2e 的 /app smoke 骨架(加载/侧栏/控制台干净)可直接复制为
  向导面的测试基座;server 侧新端点测试范式见
  packages/local-api/test/app-route.test.ts(appUiHtml/token 注入)。
- **约束提醒**:M11-02 涉及 profiles 写入与角色绑定时,继续遵守「配置
  写回不热重载、重启生效」「四角色绑定事务式全落或全不落」的既有语义;
  CLI 探测不得引入任何 shell 拼接或自动权限提升。
