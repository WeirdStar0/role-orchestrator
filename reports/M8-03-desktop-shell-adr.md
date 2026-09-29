# ADR（初版）：桌面壳技术选型——M8-03

状态：Proposed（初版，可被推翻——见「验证与回退」的重新评估条件）
日期：2026-09-28
关联需求与 Issue：M8 里程碑立项（bf15a62，BACKLOG M8-03）；本仓库 v0.1.0-rc
（tag `v0.1.0-rc`）发布后的体验增强方向。
批准维护者：待批准（本 ADR 为 Developer 批次产出的提案，未经维护者验收）

> **范围声明：本文件仅为 ADR，未实现任何桌面壳代码。** 实现属后续批次，
> 需另行立项、排期并经维护者批准。本文不修改任何现有包，不引入代码改动。

## 背景

v0.1.0-rc 已发布，产品界面由 `@role-orchestrator/local-api` 提供：本地 Web
服务，安全边界为回环绑定 + 请求守卫管道（A30，`packages/local-api/src/guard.ts`）：

1. 仅绑定回环地址，远端地址必须为 loopback（绑定之外的纵深防御）；
2. `Host` 头必须精确为 `127.0.0.1:<port>` / `localhost:<port>`（防 DNS
   rebinding——攻击页解析到 127.0.0.1 仍会带攻击域 Host）；
3. 每个 API 请求必须带 `Authorization: Bearer <会话令牌>`；令牌为服务启动时
   生成的 256-bit 随机值，落盘于**当前用户** home/temp 下的 0o600 文件
   （Windows 以 per-user 目录 ACL 为可见性保证，`packages/local-api/src/token.ts`），
   绝不出现在 URL/日志/仓库；
4. `Origin` 头（若存在）必须是允许的回环 origin，跨站请求被拒；
5. 变更类请求必须带 `x-csrf-token` 头与令牌比对。

用户今天通过浏览器打开该页面。桌面壳（desktop shell）的目标是提供原生窗口
体验：系统托盘图标、自动启动 local-api 子进程、关闭窗口最小化到托盘而非退出。
**已确认需求**仅此三项加"沿用现有页面"；其余均为工程假设，见下文标注。

关键约束（来自本批次 ask 与既有安全基线，均为已确认约束）：

- 壳进程**不得获得超出页面的任何权限**；
- 完整复用 local-api 的回环 + 令牌 + CSRF 边界，壳不得成为旁路；
- 壳**不持久化凭据**（不存令牌、不存 CLI auth、不存任何密钥材料）。

## 决策

**初版推荐 Tauri v2（Rust 宿主 + 系统 WebView2），明确标注：这是初版 ADR，
可被推翻**；推翻条件与重新评估门槛见「验证与回退」。

按 ask 要求的五维对比（下表中标注【假设】的数字为公开文档口径的工程假设，
本仓库未实测；标注【待实测】的能力必须在实现批次的首个验证窗口里实测）：

| 维度 | Electron | Tauri v2 | Neutralino.js |
|---|---|---|---|
| 包体积【假设】 | 最大：自带完整 Chromium + Node，安装包约 80–100 MB 量级 | 小：宿主为 Rust 二进制，渲染用系统 WebView2，安装包约 3–10 MB 量级 | 最小：单轻量进程，约 2–5 MB 量级 |
| 内存占用【假设】 | 最高：每应用一份 Chromium，多窗口/常驻托盘场景更明显 | 中低：复用系统 WebView2 运行时 | 低（与 Tauri 同为系统 webview 路线） |
| 安全模型 | 主进程是完整 Node 进程（fs/net 全量可用）——壳进程的权限天花板恰好是我们要避免的"超出页面的权限"；需靠 contextIsolation + 纪律性最小 preload 收敛；导航锁定靠 `will-navigate`/`setWindowOpenHandler` 事件回调（默认允许，需显式拒绝）【假设】 | IPC/原生调用默认**全拒**，按 capability/permission 显式授权（v2 权限 ACL）；渲染器与宿主天然上下文隔离；导航目标可在窗口配置中白名单锁定到回环 origin【假设】 | 页面通过 WS/HTTP 与内置服务通信，native API 按 `nativeAllowList` 粗粒度暴露给**页面侧**——方向相反：把原生能力直接递给页面上下文；无独立的宿主侧权限裁决层【假设】 |
| Windows 兼容性【假设+待实测】 | 成熟度最高：自带渲染器，Windows 10/11 行为一致；托盘/自启动生态最全 | 依赖 WebView2（Windows 11 与近期 Windows 10 经 Edge 更新普遍预装；存量旧系统可能需引导安装 Evergreen Runtime）——**待实测**：本仓库验收机与最小支持系统的 WebView2 在位率 | 支持 Windows，渲染同样走系统 WebView2/Edge 路线；社区与 Windows 深度适配（托盘细节、多显示器 DPI）成熟度低于前两者【假设】 |
| 与 local-api 架构契合度 | 可行：壳加载 `http://127.0.0.1:<port>`；但壳自带 Node 主进程与 local-api 同机双 Node 运行时，边界重叠、职责含混 | 契合最好：壳退化为"窗口 + 托盘 + 子进程管理器"三件事；页面与 local-api 之间的数据路径完全不经过壳（壳只负责把 WebView 指向回环 URL），令牌/CSRF 流零改动 | 可行，但页面↔壳通信模型与"壳不添加权限"的方向相悖 |

**推荐论证（Tauri v2）**：本批 ask 的硬约束是"壳进程不获得超出页面的任何权限"。
三个候选里只有 Tauri v2 的默认态恰好是这个约束——渲染器对宿主的一切 IPC 调用
默认被拒，capability 显式列出才放行；实现批次将把 capability 收敛到近零
（理想为空集：壳只需窗口/托盘/子进程三个宿主侧能力，页面无需任何命令通道）。
Electron 默认态相反（全量 Node 主进程），靠纪律收敛；Neutralino 的 native
通道直接开给页面侧，方向性不符。壳体积与内存是次要加分项，不是决定项。

**与 local-api 的集成不变式（对三个候选同等适用，实现批次必须遵守）**：

- 壳以子进程方式启动 local-api（现有产品进程），不修改其绑定、守卫、令牌逻辑；
- 令牌流完全不变：local-api 生成并写入 per-user 0o600 文件，页面自行读取；
  壳**不**经手令牌——不读、不缓存、不放入子进程 argv/env、不持久化；
- 壳加载的 URL 锁定为 `http://127.0.0.1:<port>`（或 localhost 等价回环 origin），
  任何非该 origin 的导航（含 window.open、重定向、外链）一律拒绝并在壳内提示；
- 关闭按钮 → 隐藏到托盘；托盘菜单提供真正的退出（先停 local-api 子进程再退出壳）。

## 替代方案

1. **Electron**：生态最成熟（托盘、自启动、崩溃上报、自动更新样样齐备），
   Windows 一致性最好，且与仓库 TypeScript 技术栈同语言。未作为初版推荐的
   原因：默认权限面（全量 Node 主进程）与"壳不得超出页面权限"的硬约束方向
   相反，需要靠约定而非机制收敛；自持 Chromium 的体积/内存成本对一个
   "窗口 + 托盘"需求过重。**若 Tauri 路线在实测中受阻（见回退条件），
   Electron 是第一顺位替代**，届时以 contextIsolation + 空 preload +
   导航全拒回调为验收项。
2. **Neutralino.js**：体积最小、引入最快。未推荐的原因：native API 粗粒度
   直达页面侧的模型与 least-privilege 方向相悖；进程隔离/上下文隔离能力弱于
   前两者；Windows 深度适配的社区验证较少。
3. **不做壳（维持浏览器入口）**：功能上完全可行，当前安全边界也最简单。
   系统托盘/自启动/关闭最小化三项原生体验是本 ADR 的存在理由；若维护者
   判定价值不足，本 ADR 整体作废即是正确决定。

## 影响

- **兼容**：页面与 API 契约零改动（壳不改 local-api）；新增独立壳工程
  （建议 `apps/desktop-shell/` 或独立仓库，实现批次再定），不影响 36 个
  workspace 包与 84 个外部依赖的现有审计面——壳的工具链（Rust/WebView2
  加载器）如进入 monorepo，须作为独立披露走依赖审计增量。
- **权限**：壳进程以当前用户运行，不做服务、不做提权安装；capability 收敛
  到近零是验收项而非优化项。
- **数据**：壳自身不持久化任何凭据；可持久化的仅窗口状态（位置/尺寸）。
  local-api 的令牌文件、会话、审计记录路径与格式均不变。
- **成本**：新增 Rust 工具链与 WebView2 目标平台的构建/测试矩阵；CI 需要
  Windows 构建通道（现有 product-gates 已有 Windows job，工作量可控【待实测】）。
- **恢复**：壳崩溃不影响 local-api（独立进程）；local-api 退出时托盘应提示
  且壳进入可重连状态（重启子进程或退出，实现批次定）。无数据迁移。
- **商业边界**：壳属开放核心侧（无商业控制面依赖），届时按 boundary-audit
  规则登记（若以 workspace 包形式落地，需同步 OPEN_CORE_PACKAGE_MANIFEST，
  与 M8-02 先例一致）。

## 威胁建模（桌面壳新增攻击面）

前提：与 local-api 现状一致，**同用户任意代码执行不在威胁模型内**（能注入
同用户进程的攻击者已拥有该用户会话，防御无意义）；壳不得使现状变差。

1. **进程注入**（第三方代码注入壳/WebView 进程）
   - 面：壳常驻托盘 = 长生命周期进程，注入窗口更长。
   - 缓解：壳以普通用户权限运行（非服务、不提权），注入所得与用户自己的
     浏览器相当；壳进程内无常驻秘密（不持久化、不缓存令牌——数据路径根本
     不经过壳）；WebView2 走系统级 Edge 更新通道获得渲染层补丁【假设，待实测】。
   - 残余风险：显式接受（同用户威胁模型外）。
2. **IPC 劫持**
   - a) 渲染器→壳宿主 IPC（Tauri command 通道）：capability 默认全拒 +
     近零授权，页面无可调用的壳命令 ⇒ 无劫持面。验收：空 capability 清单
     下列举全部 command 并证明 403/deny。
   - b) 页面→攻击者导航（钓鱼重定向/外链外泄令牌页）：导航锁定到回环 origin
     白名单，非白名单导航一律拒绝；页面拿到的令牌今日在浏览器里同样可见，
     壳不扩大该暴露（不提供任何"导出/同步/云"通道）。
   - c) 壳↔local-api 子进程通道（argv/env/stdout）：壳启动 local-api 时
     **不得**经 argv/env 传令牌（令牌流保持文件交付不变）；stdout 仅用于
     诊断转发，不得以 stdout 文本判定成功（仓库既有规则）。
3. **本地提权**（壳成为提权跳板）
   - 面：安装器、自启动、自动更新是经典提权入口。
   - 缓解：per-user 安装（不写 HKLM、不做 Windows 服务、不要求管理员）；
     自启动用 HKCU Run 键或 per-user Startup 目录，指向当前用户可执行文件；
     初版**不做**自动更新器（更新 = 重新安装；引入更新器必须先过签名校验
     设计并另立 ADR）；壳不以 elevated 令牌 spawn 任何进程。
4. **新增拒绝语义的回归风险**：本 ADR 不改 local-api 任何拒绝语义；实现
   批次的验收必须包含"壳存在时守卫管道行为不变"的既有测试回归（guard
   管道 5 条全绿）。

## 验证与回退

本 ADR 为纯设计决策，无可执行验证；实现批次必须交付的验证门禁：

1. 【待实测】目标 Windows（验收机同版本）WebView2 Runtime 在位率实测；
   不在位时的引导安装路径可用性。
2. 【待实测】壳加载回环页面后，local-api guard 管道既有测试全量回归绿
   （Host/Origin/Bearer/CSRF 五条拒绝语义一项不变）。
3. 【待实测】capability/权限清单为空（或近零）时，页面侧发起任意宿主调用
   被拒的证据；导航白名单拒绝外域导航的证据。
4. 【待实测】包体积/内存实测数字回填本 ADR 的【假设】栏；若 Tauri 实测
   与假设显著背离（体积 > Electron 量级或 WebView2 兼容性不可行），触发
   重新评估。
5. **重新评估条件**（任一成立则推翻本初版，按替代方案顺位重议）：
   - WebView2 在最小支持系统上不可用且引导安装不可接受；
   - 维护者不接受引入 Rust 工具链的构建/维护成本；
   - 实测安全模型与本文假设不符（如 capability 并非默认拒绝）；
   - 产品需求扩展到壳必须持有多页面状态/离线渲染（架构前提变化）。   - 产品需求扩展到壳必须持有多页面状态/离线渲染（架构前提变化）。

### M8-03b 实测回填(2026-09-29,Developer 批次;验收归维护者)

上列门禁 1–4 的实测证据(数字与命令原文)如下;样本量与边界如实标注:

1. **WebView2 在位率(门禁 1,已实测)**:验收开发机(Windows 11 Pro
   build 26100 x64)实跑 `apps/desktop-shell/scripts/check-webview2.ps1`
   (一次性检测,exit 0):三个标准安装视图中
   `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
   命中,**pv=153.0.4234.48**(name: Microsoft Edge WebView2 Runtime,
   location: C:\Program Files (x86)\Microsoft\EdgeWebView\Application);
   HKLM 原生视图与 HKCU 变体未命中。样本量 = 验收机 1 台——「最小支持
   系统」的在位率仍是发布期冒烟项,重新评估条件 5 不变。**引导安装路径**
   (下载/运行 Evergreen Bootstrapper)属外部写入,Developer 不执行:手动
   步骤已写入 README 维护者冒烟节,归维护者。
2. **guard 管道回归(门禁 2,已实测)**:壳存在场景下守卫语义零改动
   (git 可证:guard.ts/token.ts 自 M8-03a 起零 diff)。回归证据引用既有
   测试,不另造轮子:
   `pnpm --filter @role-orchestrator/local-api run test` → **19 文件
   204 passed / 0 failed**(含 guard.test.ts 全拒绝矩阵与 serve.test.ts);
   `cargo test --manifest-path apps/desktop-shell/Cargo.toml` → 17 lib +
   11 bin passed / 0 failed,exit 0;真实集成
   `RO_SHELL_INTEGRATION=1 … -- --ignored` 的
   `tests/integration.rs::spawned_serve_child_reaches_local_api_over_loopback`
   实跑 exit 0,断言无凭据 `/api/v1/session` → **403**(TOKEN_REQUIRED,
   守卫拒绝形态即「在位」证据)、带 Bearer 200 与 `GET /` → **200**。
3. **capability 全拒 + 导航锁定(门禁 3,静态层与产物层已实测;运行层
   装置已交付、本机被加载器问题阻塞——如实标注)**:
   - **静态层(实测,绿)**:`apps/desktop-shell/tests/source_invariants.rs::
     shell_source_registers_no_ipc_commands`——src 五个源文件的
     #[cfg(test)] 前生产区域 `invoke_handler` / `generate_handler` /
     `tauri::command` 零命中。结构性论证:页面侧 invoke 只能命中宿主注册
     过的 command ⇒ 命令面为空集 ⇒ 任何 invoke 无目标必拒;叠加 capability
     空集,拒绝是双层的。
   - **产物层(实测,绿)**:同文件
     `generated_capabilities_grant_no_permissions`——tauri-build 产出的
     `gen/schemas/capabilities.json` 中每一条 permissions 都是空数组
     (文件不存在时显式跳过并说明)。
   - **运行层(探针已交付,本机未跑通)**:`apps/desktop-shell/examples/
     capability_probe.rs`(真窗加载占位页 → 页面侧对未注册命令 invoke 断言
     拒绝 → example.com 导航断言被 on_navigation 阻止,证据 JSON 打印
     stdout 并落盘 target/shell-probe-evidence.json)。本机实测:该探针
     **以任何非主程序二进制形态(tauri 测试装置与示例 bin)加载即以
     STATUS_ENTRYPOINT_NOT_FOUND(0xc0000139)崩溃**——加载期失败,与
     目录无关;同一依赖集的主程序二进制正常加载运行(serve 全流程 CLI 实跑
     通过)。根因在本机 rustc/MSVC 链接产物与系统 DLL 的契合层,超出探针
     工程范围,不伪造运行层证据;跑法与预期输出已写入 README,归维护者在
     可用机器执行。窗口内导航锁定的单测覆盖见
     `src/main.rs::navigation_lock_requires_the_exact_serve_port_on_top_of_the_whitelist`。
4. **包体积(门禁 4,已实测)**:`cargo build --release` 主程序
   `target/release/role-orchestrator-desktop-shell.exe` 实测
   **8,649,216 字节(8.25 MB)**,落在本文【假设】栏「安装包约 3–10 MB
   量级」的假设区间内(偏高段,不含打包压缩;结论:与假设无显著背离,
   不触发重新评估);口径差异如实标注:该数字是未打包的主 exe
   (release),非打包/安装包布局(安装包属 M8-03c)。**内存占用**为维护者
   冒烟(README 冒烟节:任务管理器读常驻内存回填)。CI Windows 通道
   (影响节的【待实测】)不随本批闭合。

回退路径：壳为独立增量工程，删除壳即完全回退，local-api 与页面零残留。
