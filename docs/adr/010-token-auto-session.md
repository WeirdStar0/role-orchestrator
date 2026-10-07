# ADR 010：会话令牌自动会话（壳注入 Authorization）

状态：Accepted（维护者已批方向：2026-10-07 M11 立项裁决「会话令牌从界面完全消失，
壳自动建立认证会话」；机制选型与缓解清单为本批 M11-01 工程决策，经批内审查门禁）
日期：2026-10-07
关联需求与 Issue：docs/BACKLOG.md M11 产品基准（「会话令牌从界面完全消失」条目）、
M11-01 范围①②；M8-03 桌面壳 ADR（reports/M8-03-desktop-shell-adr.md）中
「壳不经手令牌」红线的修订
批准维护者：维护者（2026-10-07，M11 立项；安全边界修订声明见 M11 立项登记与
PROPOSALS 披露）

## 背景

local-api 的安全模型（docs/SECURITY_MODEL.md、packages/local-api/src/token.ts）：
serve 启动时生成 256-bit 会话令牌，写入仅当前用户可读的令牌文件
（`%TEMP%\role-orchestrator-local-api\session-token-<16hex>.txt`，home/temp
目录 fail-closed 校验，POSIX 0o600 验证）；每个 `/api/*` 请求必须携带
`Authorization: Bearer <token>`（server.ts guard pipeline：loopback → Host →
Origin → Bearer → CSRF）。页面侧（page.ts）要求操作者手动打开令牌文件、复制、
粘贴进 `#token-input`——这是首启体验的最大障碍（M11 立项依据：真实使用首日
反馈「第一次使用就要理解令牌是什么」），也是 v0.4.0 产品基准「会话令牌从界面
完全消失」的直接对象。

原红线（v0.1.0，M8-03 ADR）：「壳不经手令牌」——不读、不缓存、不进 argv/env、
不持久化。该红线在 v0.1/v0.2/v0.3 阶段是正确的默认（壳能力最小化），但与
维护者 2026-10-07 批准的产品方向冲突。本 ADR 记录红线的修订与新边界。

事实约束（工程勘察，本批实证）：
- 令牌文件本就与令牌同敏度、同用户可读：token.ts 的可见性保证是「目录
  per-user ACL」（Windows 不伪造 NTFS ACL，靠 home/temp 目录归属判定）。
  同一用户会话内的任何进程（含壳）读它不引入新的访问主体。
- Tauri 2.12 / wry 0.57 的 `on_web_resource_request` 仅对 `tauri://` 自定义
  协议触发（tauri-2.12.0/src/webview/webview_window.rs 文档原文 "Currently
  only implemented for the tauri URI protocol … not executed when using
  external URLs"），对壳加载的外部 `http://127.0.0.1:<port>` 请求不触发；
  但 wry 在 WebView2 后端注册了全局 `add_WebResourceRequested` 事件管线，
  壳可经 `WebviewWindow::with_webview` 拿到 `ICoreWebView2`，自行追加
  `AddWebResourceRequestedFilter("http://127.0.0.1:<port>/*", ALL)` 与
  请求头改写（webview2-com 0.39 已在依赖树内，锁文件不新增 crate）。
- WS 升级请求（/api/v1/events/live）的守卫本就接受可选 Bearer 头
  （ws-events.ts：升级头认证通过则 preAuthenticated，跳过首帧认证）；
  浏览器无法给 WebSocket 设头，页面现走首帧 auth（`{"type":"auth",
  "token":…}`）。壳注入若覆盖 WS 握手（WebView2 运行时按 ALL 过滤器上下文
  对 ws 握手触发 WebResourceRequested），直播流自动认证；不触发的运行时上
  该流退化为失败关闭（连接被 4002 拒，页面轮询照常）——不引入任何新的
  服务器语义。

## 决策

选定机制：**壳注入 Authorization**。壳在 serve 健康就绪后读取令牌文件一次，
内容驻内存（一个 `String`，随窗口闭包移动），经 WebView2
`WebResourceRequested` 事件对发往 `http://127.0.0.1:<serve 端口>` 的请求改写
`Authorization` 头为 `Bearer <token>`；页面（旧页 page.ts，后续新 UI 同理）
加载时对 `/api/v1/session` 发一次不带本地令牌的探测：200 ⇒ 已认证，隐藏令牌
栏；非 2xx/异常 ⇒ 维持手动流（零 DOM 变化）。local-api 守卫管线、CSRF、
CSP、导航白名单、令牌文件写入与 ACL 全部零变化（本批 serve 侧无一行改动）。

不变式（缓解清单）：
1. **仅 loopback 来源注入**：过滤器字面量 `http://127.0.0.1:<port>/*` 由壳
   自己构造；事件回调内再用纯函数
   `should_inject_authorization(uri, serve_port)` 复核（scheme 必 http、host
   恰为 `127.0.0.1`、端口精确等于本壳 serve 端口、禁 userinfo/路径伪装——与
   main.rs::navigation_allowed 同一白名单口径）。非匹配请求一律不动头。
2. **内存中转**：令牌内容读入后仅存在一个 `String` 里，随闭包移动进事件
   回调；无第二份拷贝、无结构体持有、壳退出即随进程消亡。
3. **不落日志不持久化**：session.rs 生产区域零日志宏（println!/eprintln!/
   tracing/log）、零文件写（tests/source_invariants.rs 结构性金丝雀断言，
   扩展既有「唯一白名单 fs 调用」断言：全壳仅允许 main.rs 的
   create_dir_all 与 session.rs 的一次 read_to_string）；诊断失败路径只报
   COM 步骤名，绝不含令牌内容。serve 侧日志行为不变（请求行本来就剥
   query、不记头）。
4. **令牌文件 ACL 不变**：壳只读；token.ts 未动；写路径、模式、位置校验
   原样。
5. **壳不记日志**：无新增任何壳侧日志面；「打开令牌文件」托盘功能保留
   （手动场景兼容）。
6. **页面不可读令牌**：注入发生在网络层请求头，页面 JS 无法读取自己的请求
   头；令牌不进 DOM、不进 URL、不进任何页面变量。已认证模式下页面以非秘密
   哨兵值（`shell-auto-session`）满足既有加载器的「令牌非空」守卫——哨兵
   即使原样到达服务器也只是 403 TOKEN_INVALID（fail-closed），不是凭据。

安全论证（威胁模型不变）：令牌文件的可见边界是「当前 OS 用户」；壳进程就
是该用户的既有进程，读取它没有给任何新主体新增访问能力——原来能读到令牌
的代码（操作者的眼睛和手、同用户的任意进程）集合不变。注入面被过滤器+纯
函数双重限制在本壳 serve 的回环 origin 上；该 origin 上的守卫管线
（Bearer 常量时比较、CSRF、Origin）全部保留——壳注入的恰恰是守卫本来就要
求的那一个头，认证强度不变。风险转移点如实披露：壳进程内存中驻留令牌内容
（此前只有 serve 进程驻留）——同用户进程读取边界内，非新增暴露面；跨用户
隔离仍由令牌文件 ACL 与 OS 会话边界承担。

## 替代方案

- **一次性引导码**（serve 生成一次性 code 经壳深链/剪贴板交给页面，页面换
  取会话）：拒绝。code 经 URL/深链传递正是本项目「令牌不进 URL」红线要防
  的泄漏类（历史记录/日志/Referer）；需要改 serve 语义（新端点+一次性状态）
  与页面协议，动 orchestration 面，复杂度与收益不成比例。
- **维持手动**（现状）：拒绝。不解决首启最大障碍，与维护者已批的产品基准
  直接冲突；作为回退路径保留（见「验证与回退」）。
- **tauri on_web_resource_request**：技术不可行——对外部 URL 不触发
  （见背景），不采用。

## 影响

- 兼容：serve/API/事件协议零变化；旧页在纯浏览器（无壳）下探测必被拒，
  手动流零回归（browser-e2e 旧页测试面保持）；旧页在壳内已认证时隐藏令牌
  栏是唯一页面行为变化（M11-01 范围②明确允许）。
- 已知限制（如实披露）：已认证模式下，若 WebView2 运行时不对 WS 握手触发
  注入，直播事件流按服务器既有 fail-closed 语义拒绝（页面轮询与全部 HTTP
  面不受影响）；该路径由维护者真窗冒烟覆盖（维护者环境动作③）。
- 权限：壳新增两个 Windows 直接依赖（webview2-com、windows-strings——均已
  在 Cargo.lock 依赖树内，不新增 crate、不动 npm 依赖面）；壳 IPC 命令面
  保持空集（source_invariants 金丝雀继续成立）。
- 数据：零持久化新增；数据库零接触。
- 成本：每请求一次字符串前缀判定（纳秒级），无网络往返、无轮询。
- 恢复/迁移：无数据迁移；回退即恢复手动流。
- 商业边界：无（本机制完全本地）。

## 验证与回退

测试（本批实跑）：
- cargo test（壳）：session.rs 纯函数单测——令牌内容校验（43 字符 base64url
  形态，trim 尾换行）、读令牌决策（未报告/空路径/读取失败/合法内容四路）、
  头构造（Bearer 形态、空/空白/控制字符拒绝）、注入判定（精确端口/他端口/
  无端口/localhost/https/userinfo/路径伪装全部拒绝）；结构金丝雀——
  session.rs 生产区域零日志宏、全壳 fs 调用白名单（仅 db 目录创建+令牌一次
  读）、argv 无凭据旗标（既有）。
- local-api 页面测试：探测决策纯函数（未认证 null/已认证取 csrf）、探测
  fetch 不携带本地令牌、已认证隐藏 #connect 的 CSS 生效（[hidden] 规则）、
  手动骨架原样保留。
- 维护者真窗冒烟（移交，环境动作③）：壳启动后令牌栏自动消失、API 面可用
  （含直播流路径核实）；同 URL 用系统浏览器打开令牌栏仍在（手动流）。

回退：撤掉壳侧两处接线（读令牌一次 + with_webview 注入注册）即可整体回到
手动流；页面探测失败自动落回手动形态，无需页面回退。重新评估条件：维护者
真窗冒烟发现注入不可靠，或审查门禁发现缓解清单任一条不成立——回退后按
「维持手动」替代方案立项。
