//! role-orchestrator 桌面壳(M8-03a 连接 → M8-03c 托盘常驻)。
//!
//! 流程:解析壳自身参数(仅 --db <path> 可选)→ spawn local-api serve 子
//! 进程(argv 数组,见 [`serve_child`])→ HTTP 探测就绪(见 [`health`])→
//! 创建 WebView 窗口加载唯一合法回环 URL(见 [`url`])并建立系统托盘。
//! 健康检查失败则打印诊断并以非零码退出,不建窗口。
//!
//! 窗口生命周期(M8-03c,ADR 集成不变式):关闭按钮 = 隐藏到托盘(壳
//! 常驻)而非退出;托盘菜单「显示主窗口」或托盘双击恢复;真正的退出只在
//! 托盘菜单——先停 local-api 子进程(Job 树杀)再退出壳,顺序由
//! [`shutdown_sequence`] 钉死并单测。
//!
//! 安全不变式(完整论证见 ADR reports/M8-03-desktop-shell-adr.md;M11-01
//! 令牌红线的修订与缓解清单见 ADR docs/adr/010-token-auto-session.md):
//! spawn 一律 argv 数组、不开 shell;在位判定只靠 HTTP 探测,stdout 只提供
//! 端口提示;非白名单导航一律拒绝并在壳内提示(提示文案按最小暴露原则只
//! 含 scheme+host+port);壳进程不获得超出页面的任何权限(零 IPC 命令面)。
//! 令牌(M11-01 修订,维护者已批方向):壳读令牌文件**一次**进内存,经
//! WebView2 对本壳 serve 的回环请求注入 Authorization 头(仅
//! `http://127.0.0.1:<serve 端口>` 来源、不落日志、不持久化、令牌文件 ACL
//! 不变、失败降级手动流);argv/env 仍零令牌参数,子进程语义不变。

// 发布构建隐藏控制台窗口(标准 Tauri 模板做法);调试构建保留以便诊断。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager as _;
use role_orchestrator_desktop_shell::{health, locate, serve_child, session, url};

/// 壳自身参数:仅 `--db <path>` 可选(strict:未知参数/重复/缺值/空值报错)。
#[derive(Debug, PartialEq, Eq)]
struct ShellConfig {
    db: PathBuf,
    /// db 来自默认值(而非显式 --db)时,壳显式准备其父目录;serve 本身按
    /// 设计不隐式建目录,显式路径的目录缺失必须原样暴露给操作者。
    db_is_default: bool,
}

fn parse_shell_args<I: Iterator<Item = String>>(
    mut args: I,
    local_app_data: Option<&str>,
) -> Result<ShellConfig, String> {
    let mut db: Option<String> = None;
    while let Some(arg) = args.next() {
        if arg != "--db" {
            return Err(format!("未知参数 {arg:?};壳只接受 --db <path>"));
        }
        if db.is_some() {
            return Err("--db 重复给出;只能一个".to_string());
        }
        let value = args.next().ok_or("--db 需要一个值")?;
        if value.is_empty() {
            return Err("--db 的值不能为空".to_string());
        }
        // 对齐 serve strict(packages/local-api/src/serve.ts parseServeArgs:
        // 以 "--" 开头的 token 是下一个旗标,不是值):`--db --port 1` 里的
        // "--port" 若被吞成 db 路径,配置错误会被推迟到 serve 深处才暴露。
        if value.starts_with("--") {
            return Err(format!("--db 需要一个值;得到的是旗标 {value:?}"));
        }
        db = Some(value);
    }
    match db {
        Some(db) => Ok(ShellConfig {
            db: PathBuf::from(db),
            db_is_default: false,
        }),
        None => Ok(ShellConfig {
            db: default_db_path(local_app_data)?,
            db_is_default: true,
        }),
    }
}

/// LOCALAPPDATA 基准(fail-closed,db 与 profiles 两个默认路径共用):未设置、
/// 为空字符串、或非空但非绝对路径都是配置错误,不猜默认——空串与非绝对路径
/// (如 "relative/base")都会静默构造出 cwd 相对路径,把默认产物落到壳的
/// 启动目录里(审查 minor:空串为 M8-03b、非绝对路径为 M8-03c 移交项),
/// 必须显式拒绝。
fn local_app_data_base(local_app_data: Option<&str>) -> Result<PathBuf, String> {
    let base = match local_app_data {
        Some(base) if !base.is_empty() => base,
        Some(_) => {
            return Err(
                "环境变量 LOCALAPPDATA 为空字符串,且未显式给出 --db".to_string(),
            )
        }
        None => return Err("环境变量 LOCALAPPDATA 未设置,且未显式给出 --db".to_string()),
    };
    let base_path = PathBuf::from(base);
    // M 族(审查移交):非空但非绝对的 LOCALAPPDATA 与空串同罪——相对
    // 路径同样静默落成 cwd 相对树,与空串共用同一条 fail-closed 拒绝路径。
    if !base_path.is_absolute() {
        return Err(format!(
            "环境变量 LOCALAPPDATA 不是绝对路径({base:?}),且未显式给出 --db"
        ));
    }
    Ok(base_path)
}

/// 默认库路径:%LOCALAPPDATA%/role-orchestrator/orchestrator.db。
fn default_db_path(local_app_data: Option<&str>) -> Result<PathBuf, String> {
    Ok(local_app_data_base(local_app_data)?
        .join("role-orchestrator")
        .join("orchestrator.db"))
}

/// 默认 profiles 配置路径(M9-03 壳侧接线):%LOCALAPPDATA%/role-orchestrator/
/// profiles.json——与默认库同目录的 per-user 约定路径。
///
/// 与 serve --profiles 语义的对齐(勘察结论,README 同步披露):serve 侧
/// (packages/local-api/src/serve.ts)没有内置默认读取路径——它只读 `--profiles`
/// 显式传入的那一个路径。因此「约定路径与 serve 的读取路径一致」的落地方式
/// 是:壳把这个约定路径作为 `--profiles` 的值传给子进程,单一事实源即该
/// 约定;文件不存在时壳不传旗标(存在才传),serve 无 `--profiles` 时行为
/// 与 v0.1.1 完全一致(无编排)。壳只传「配置文件路径」,绝不读取其内容、
/// 绝不经手任何令牌。
fn default_profiles_path(local_app_data: Option<&str>) -> Result<PathBuf, String> {
    Ok(local_app_data_base(local_app_data)?
        .join("role-orchestrator")
        .join("profiles.json"))
}

/// exe 所在目录(捆绑资源定位基准,M8-05):NSIS 安装布局下 resources 落在
/// 安装目录(Windows 上即 exe 同目录),dev 布局下指向 target/{debug|release}
/// ——那里通常没有捆绑资源,定位链自然落回仓库 dev 路径。current_exe 失败
/// 或无父目录时 None:定位链跳过捆绑分支(dev 分支兜底 / 都没有则诊断失败)。
fn exe_directory() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(Path::to_path_buf)
}

/// serve 子进程的 node 可执行文件:定位链(① RO_SHELL_NODE → ② exe 同目录
/// node-runtime\node.exe → ③ PATH "node")见 [`locate::resolve_node`];
/// fail-closed 语义与候选诊断也在该纯函数内,单测钉死。
fn node_path(exe_dir: Option<&Path>) -> Result<String, String> {
    locate::resolve_node(std::env::var("RO_SHELL_NODE").ok().as_deref(), exe_dir, |candidate| {
        candidate.exists()
    })
    .map(|path| path.to_string_lossy().into_owned())
}

/// serve 入口:定位链(① RO_SHELL_SERVE_BIN → ② exe 同目录 serve-bundle.mjs
/// → ③ 仓库 dev 路径 serve-bin.js)见 [`locate::resolve_serve_entry`]。
fn serve_bin_path(exe_dir: Option<&Path>) -> Result<PathBuf, String> {
    locate::resolve_serve_entry(
        std::env::var("RO_SHELL_SERVE_BIN").ok().as_deref(),
        exe_dir,
        |candidate| candidate.exists(),
    )
}

/// 导航裁决(可测纯函数,ADR 威胁建模 2(b) 的落地):`url::is_allowed_
/// navigation` 的白名单规则(http scheme + host 恰为 127.0.0.1 + 合法端口
/// + 禁 userinfo)之上,叠加「恰为本壳 serve 端口」的精确匹配(url 模块
/// 预告的 M8-03b 约束)——即使 scheme/host 全对,指向其它端口的回环导航
/// 同样拒绝;省缺端口(http 默认 80)不构成精确匹配。
fn navigation_allowed(target: &tauri::Url, serve_port: u16) -> bool {
    url::is_allowed_navigation(target.as_str()) && target.port() == Some(serve_port)
}

/// 被拒导航的用户可见定位串(可测纯函数):只含 scheme+host+port。
/// 最小暴露原则——path/query/fragment 一概不进文案:query 可能承载令牌类
/// 内容,壳的提示面永不承载令牌类信息(M11-01 起壳在内存经手令牌用于回环
/// 注入,ADR docs/adr/010-token-auto-session.md;提示面收敛照旧)。
fn rejected_navigation_display(target: &tauri::Url) -> String {
    let port = match target.port() {
        Some(port) => format!(":{port}"),
        None => String::new(),
    };
    format!(
        "{}://{}{}",
        target.scheme(),
        target.host_str().unwrap_or("<无 host>"),
        port
    )
}

/// 宽字符串(UTF-16,NUL 结尾)——MessageBoxW 的 PCWSTR 入参形态。
#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 导航拒绝的「壳内提示」落地(ADR「集成不变式」节:非白名单导航
/// 一律拒绝并<b>在壳内提示</b>,M8-03c 闭合审查 K 族)。约束语义:
/// - Windows 用已依赖的 windows-sys 的 user32 MessageBoxW 弹 MB_OK 模态
///   提示(不为此引入任何 dialog/notification 插件——硬红线);
/// - 回调内弹窗会阻塞导航裁决直至用户确认,这是预期行为:壳内提示本就
///   要求用户在场;回调在事件循环线程串行执行,多个被拒导航的提示框按
///   顺序排队出现,不会并发重入;
/// - 非 Windows 平台降级为 eprintln 诊断(GUI 形态下该行无处可去,仅作
///   调试期诊断;壳的目标平台是 Windows)。
fn notify_rejected_navigation(target: &tauri::Url) {
    let origin = rejected_navigation_display(target);
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK};
        let text = to_wide(&format!(
            "已阻止导航到非白名单目标:{origin}\n\n\
             本壳只允许加载 http://127.0.0.1:<serve 端口> 上的页面。"
        ));
        let caption = to_wide("Role Orchestrator");
        // SAFETY:两个 PCWSTR 实参都是刚构造、NUL 结尾的 UTF-16 缓冲,且
        // 存活至本调用返回;HWND 传 null(无属主对话框,窗口此刻可能处于
        // 托盘隐藏态);MB_OK 即单按钮信息框。返回值(用户点了哪个按钮)
        // 对 MB_OK 无信息量,忽略。
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("role-orchestrator-shell: 已拒绝非白名单导航:{origin}");
    }
}

// ---- 「打开令牌文件」(M9-04):裁决、打开、提示三个可测单元 ----
//
// 边界(M9-04;M11-01 修订见 ADR docs/adr/010-token-auto-session.md):本
// 功能只做「用系统默认程序打开令牌文件」——壳持有 serve 诊断行报告的**路
// 径**(与端口发现同一 JSON 诊断通道,路径非秘密),通过 ShellExecuteW
// "open" 交给系统默认 .txt 关联程序;本功能自身不读取文件内容(令牌内容的
// 唯一读取面在 session::read_session_token,一次进内存用于回环注入)。

/// 「打开令牌文件」点击的裁决(可测纯函数,fail-safe):仅当 serve 已报告
/// 路径且该路径此刻存在时放行打开(Some);报告缺失(None = 诊断行未到/
/// 旧版 bundle/严格解析拒绝恶意形态)、空值、文件已不存在一律 None →
/// 调用侧给「尚未生成」提示,不 panic、不创建任何东西。`path_exists` 注入
/// 保持纯函数可测(调用侧传 `|p| Path::new(p).exists()`);壳在此全程只
/// 持有路径字符串。
fn token_file_open_decision(
    reported: Option<&str>,
    mut path_exists: impl FnMut(&str) -> bool,
) -> Option<String> {
    let path = reported.filter(|candidate| !candidate.is_empty())?;
    if path_exists(path) {
        Some(path.to_string())
    } else {
        None
    }
}

/// 用系统默认关联程序打开路径(Windows:ShellExecuteW "open"——资源管理器
/// 同款动词,由系统解析 .txt 的当前用户关联;不指定任何具体程序,不经
/// shell 拼接参数)。返回值(>32 为成功句柄、≤32 为 SE_err 错误码)忽略:
/// 打开失败(无关联程序等)由系统自行呈现,壳不再叠加提示,也绝不因此
/// panic。
#[cfg(windows)]
fn open_path_with_system_default(path: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = to_wide("open");
    let file = to_wide(path);
    // SAFETY:verb/file 都是刚构造、NUL 结尾的 UTF-16 缓冲,存活至本调用
    // 返回;参数与目录传 null(不参与);SW_SHOWNORMAL 常规显示;HWND null
    // (无属主窗口,托盘态下主窗口可能隐藏)。
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// 非 Windows 降级(菜单构建时该项被省略,本分支仅兜底防误达):诊断输出。
#[cfg(not(windows))]
fn open_path_with_system_default(path: &str) {
    eprintln!("role-orchestrator-shell: 打开令牌文件(非 Windows 降级诊断):{path}");
}

/// 「令牌文件尚未生成」的壳内提示(Windows:MessageBoxW,与导航拒绝提示
/// 同模式、不引入任何插件;非 Windows:诊断输出)。触发面:serve 未报告
/// 路径(诊断行未到/字段缺失/形态被拒)或报告的路径此刻不存在。
fn notify_token_file_not_ready() {
    let text = "令牌文件尚未生成(任务启动后自动创建)";
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK};
        let wide_text = to_wide(text);
        let caption = to_wide("Role Orchestrator");
        // SAFETY:两个 PCWSTR 实参都是刚构造、NUL 结尾的 UTF-16 缓冲,且
        // 存活至本调用返回;HWND 传 null(无属主对话框,窗口此刻可能处于
        // 托盘隐藏态);MB_OK 单按钮,返回值无信息量,忽略。
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide_text.as_ptr(),
                caption.as_ptr(),
                MB_OK,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("role-orchestrator-shell: {text}");
    }
}

/// 托盘「打开令牌文件」的唯一路径(菜单事件闭包调用):裁决(纯函数)通过
/// 即交给系统默认程序打开,否则壳内提示。lock 中毒/路径异常全部收敛到
/// 「尚未生成」提示,绝不 panic;本功能不读取文件内容(令牌内容的唯一读
/// 取面在 session::read_session_token,见 ADR docs/adr/010-token-auto-session.md)。
fn run_open_token_file(child: &Mutex<serve_child::ServeChild>) {
    let reported = child.lock().ok().and_then(|serve| serve.token_file_path());
    match token_file_open_decision(reported.as_deref(), |candidate| {
        Path::new(candidate).exists()
    }) {
        Some(path) => open_path_with_system_default(&path),
        None => notify_token_file_not_ready(),
    }
}

// ---- 系统托盘(M8-03c):标识与退出顺序抽成可测单元 ----

/// 托盘菜单项 id:事件分发按 id 判定、与菜单文案解耦,映射被单测钉死。
const TRAY_ID_SHOW_MAIN: &str = "show-main-window";
/// M9-04「打开令牌文件」(仅 Windows 构建;非 Windows 平台菜单构建时省略
/// 该项,见托盘装配处的 cfg 注释)。
const TRAY_ID_OPEN_TOKEN_FILE: &str = "open-token-file";
const TRAY_ID_QUIT: &str = "quit-and-stop-serve";

/// 托盘输入的归一化动作(菜单项与托盘双击共用)。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum TrayAction {
    ShowMainWindow,
    OpenTokenFile,
    QuitShell,
}

/// 纯函数:菜单项 id → 动作。未知 id 一律 None(调用侧显式诊断),不得
/// 静默吞掉未登记标识——菜单层新增项而忘接事件时必须在日志可见。
fn tray_menu_action(id: &str) -> Option<TrayAction> {
    match id {
        TRAY_ID_SHOW_MAIN => Some(TrayAction::ShowMainWindow),
        TRAY_ID_OPEN_TOKEN_FILE => Some(TrayAction::OpenTokenFile),
        TRAY_ID_QUIT => Some(TrayAction::QuitShell),
        _ => None,
    }
}

/// 壳退出序列的步骤(顺序即执行顺序)。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ShutdownStep {
    /// 停 local-api serve 子进程(Windows:Job 树杀,含 shim 链后代)。
    StopServeChild,
    /// 退出壳事件循环(app.exit)。
    ExitShell,
}

/// 纯函数:壳的退出序列——ADR 集成不变式的落地:「托盘菜单提供真正的
/// 退出(先停 local-api 子进程再退出壳)」。顺序钉死在此并单测:任何
/// 把 ExitShell 提前的改动都会让单测变红,而不是悄悄产生 serve 孤儿。
fn shutdown_sequence() -> [ShutdownStep; 2] {
    [ShutdownStep::StopServeChild, ShutdownStep::ExitShell]
}

/// 执行退出序列(托盘「退出」菜单的唯一路径)。副作用映射:
/// StopServeChild → ServeChild::kill(Job 树杀;kill 内含 wait 回收),
/// ExitShell → app.exit(0)。树杀失败按尽力而为吞掉错误——Drop 的
/// KILL_ON_JOB_CLOSE 兜底仍在(见 serve_child 模块文档),但两步顺序
/// 绝不颠倒:壳退出时 serve 必须已被终结。
fn run_shutdown_sequence(child: &Mutex<serve_child::ServeChild>, app: &tauri::AppHandle<tauri::Wry>) {
    for step in shutdown_sequence() {
        match step {
            ShutdownStep::StopServeChild => {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
            }
            ShutdownStep::ExitShell => app.exit(0),
        }
    }
}

/// 托盘「显示主窗口」/双击托盘的恢复路径:显示 + 取最小化 + 聚焦。
fn show_main_window(app: &tauri::AppHandle<tauri::Wry>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 纯函数(N 族审查移交):诊断文案里的超时时长——亚秒显示为毫秒,
/// 整秒显示为秒。此前 `as_secs()` 会把 400ms 的测试超时显示成 "0s",
/// 诊断失真;真实布线用整秒(30s),测试用亚秒,两种口径都必须可读。
fn format_timeout(duration: Duration) -> String {
    if duration.as_secs() > 0 {
        format!("{}s", duration.as_secs())
    } else {
        format!("{}ms", duration.as_millis())
    }
}

/// 可测布线核心(不含 tauri 窗口):「端口提示发现 → 存活约束下的健康等待
/// → 唯一合法回环 URL 构造」的纯编排。discovered_port = None(诊断行缺失
/// 或子进程已死)立即失败;liveness(壳传入子进程存活断言)为 false 或
/// 健康超时同样失败——成功时返回 (serve 端口, 壳可加载的回环 URL)。
fn serve_ready_url_with(
    discovered_port: Option<u16>,
    liveness: impl FnMut() -> bool,
    health_timeout: Duration,
    interval: Duration,
) -> Result<(u16, String), String> {
    let port = discovered_port
        .ok_or_else(|| "serve 子进程未报告监听端口(诊断行缺失或进程已退出)".to_string())?;
    if !health::wait_healthy_with_liveness(port, health_timeout, interval, liveness) {
        return Err(format!(
            "local-api 未在 {} 内通过回环健康检查(127.0.0.1:{port};超时或 serve 进程已退出)",
            format_timeout(health_timeout)
        ));
    }
    Ok((port, url::loopback_url(port)))
}

/// 壳的真实布线:端口提示走 ServeChild 的诊断行发现,存活断言走子进程
/// try_wait——每轮探测前核查,serve 在 listen 后崩溃时秒级失败而非把
/// 崩溃伪装成整段超时。窗口装配不在此函数内(留在 run)。
fn serve_ready_url(
    child: &mut serve_child::ServeChild,
    discovery_timeout: Duration,
    health_timeout: Duration,
    interval: Duration,
) -> Result<(u16, String), String> {
    let discovered_port = child.wait_for_discovered_port(discovery_timeout);
    serve_ready_url_with(
        discovered_port,
        || match child.try_wait() {
            // 尚未退出 = 存活。
            Ok(None) => true,
            // 已退出 = 确定死亡。
            Ok(Some(_)) => false,
            // L 族(审查移交):存活查询本身失败(Err)从 fail-open 改为
            // fail-closed——视为已死、快速失败。取舍:误判死亡的代价是
            // 过早放弃等待,而 30s 健康超时兜底本就会放弃,损失的只是
            // 等待时长;反向的 fail-open 则把「查询失败」伪装成「进程
            // 健在」,把句柄级故障拖成整段超时,与仓库 fail-closed 风格
            // 相悖,故宁可快速失败。
            Err(_) => false,
        },
        health_timeout,
        interval,
    )
}

fn run() -> Result<(), String> {
    let config = parse_shell_args(
        std::env::args().skip(1),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
    )?;
    if config.db_is_default {
        if let Some(parent) = config.db.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建默认数据目录 {}: {error}", parent.display()))?;
        }
    }
    // 资源定位链(M8-05):env 覆盖 → exe 同目录捆绑资源 → 仓库 dev 布局,
    // 纯函数见 locate 模块(单测钉死三分支与优先级);任何分支都不可用 =
    // Err 诊断 + 下面的 process::exit(1),不建窗(fail-closed 维持现状)。
    let exe_dir = exe_directory();
    let node = node_path(exe_dir.as_deref())?;
    let serve_bin = serve_bin_path(exe_dir.as_deref())?;
    if !serve_bin.exists() {
        return Err(format!(
            "serve 入口不存在: {}——先在仓库根运行 pnpm build,或用 RO_SHELL_SERVE_BIN 指定",
            serve_bin.display()
        ));
    }
    // spawn_serve 契约是 &str argv:非 UTF-8 的入口路径无法进 argv,显式
    // 拒绝而非静默丢失。
    let serve_bin = match serve_bin.to_str() {
        Some(serve_bin) => serve_bin.to_string(),
        None => {
            return Err(format!(
                "serve 入口路径不是合法 UTF-8:{}",
                serve_bin.display()
            ))
        }
    };
    let db = config
        .db
        .to_str()
        .ok_or("数据库路径不是合法 UTF-8")?
        .to_string();

    // M9-03 壳侧接线:默认 per-user profiles 约定路径,存在才传(语义见
    // default_profiles_path / serve_child_argv:值是配置文件路径,非令牌)。
    // 约定路径无法确定(LOCALAPPDATA 不可用且用了显式 --db)或文件不存在时
    // 不传旗标——serve 无 --profiles 时行为与 v0.1.1 完全一致,页面配置页
    // 会以 409 PROFILE_SOURCE_ABSENT 给出接线引导,壳侧不猜路径。
    let profiles_path: Option<String> = match default_profiles_path(
        std::env::var("LOCALAPPDATA").ok().as_deref(),
    ) {
        Ok(path) => match path.to_str() {
            Some(text) if Path::new(text).is_file() => Some(text.to_string()),
            _ => None,
        },
        Err(_) => None,
    };

    let mut child = serve_child::ServeChild::spawn_serve(
        &node,
        &serve_bin,
        &db,
        0,
        profiles_path.as_deref(),
    )
    .map_err(|error| format!("启动 local-api serve 子进程失败: {error}"))?;

    // 端口提示(仅发现)→ HTTP 探测(裁决)→ 唯一合法回环 URL:编排见
    // serve_ready_url。失败时显式先停子进程再退出(Drop 也会兜底),绝不
    // 建窗口。
    let (serve_port, page_url) = match serve_ready_url(
        &mut child,
        Duration::from_secs(30),
        Duration::from_secs(30),
        Duration::from_millis(200),
    ) {
        Ok(ready) => ready,
        Err(message) => {
            drop(child);
            return Err(message);
        }
    };

    // M11-01(ADR docs/adr/010-token-auto-session.md)令牌自动会话:健康
    // 就绪后读令牌文件一次进内存(serve 在写诊断行前已落盘该文件,端口就绪
    // ⇒ 文件在;路径来自 serve 自己的诊断行,读取失败/形态不合 ⇒ None ⇒
    // 自动认证不启用,页面探测自动落回手动流——fail-safe,壳不因此失败、
    // 不产生任何携带内容的诊断)。此后令牌内容仅经 `session_token` 这一份
    // String 移动进窗口闭包;全壳唯一的读取调用在 session::read_session_
    // token 的注入参数处(source_invariants 白名单钉死),零日志零写盘。
    let session_token = session::read_session_token(child.token_file_path().as_deref(), |path| {
        std::fs::read_to_string(path).ok()
    });

    // 托盘「退出」菜单需要在事件循环闭包里触达 serve 子进程:所有权移入
    // Arc<Mutex<_>> 共享(菜单事件闭包有 Send+Sync 静态边界;Windows 上
    // 菜单事件实际在事件循环主线程投递,Send 由 JobHandle 的 unsafe impl
    // 声明满足,依据见 serve_child)。菜单事件不经手任何令牌内容——它能
    // 「杀子进程」「退出壳」,以及「用系统默认程序打开令牌文件」:最后者
    // 只把 serve 诊断行报告的路径(非秘密,与端口发现同一诊断通道)交给
    // ShellExecuteW;令牌内容的唯一读取面在 session::read_session_token
    // (M11-01,ADR docs/adr/010-token-auto-session.md),菜单闭包零接触。
    let child = Arc::new(Mutex::new(child));
    // run() 保留一份引用计数:事件循环结束后执行尾部兜底 Drop(见尾部)。
    let child_for_tail = Arc::clone(&child);

    tauri::Builder::default()
        .setup(move |app| {
            // 初始加载 URL 由 serve_ready_url 构造,恒为回环形态(url 模块)。
            let parsed = tauri::Url::parse(&page_url)?;
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(parsed),
            )
            .title("Role Orchestrator")
            // 顶层文档导航的运行期裁决点(机制归因 M8-03c 文档勘误,安全
            // 结论不变:WebView2 NavigationStarting 仅顶层文档触发本回调;
            // window.open/新窗请求走 NewWindowRequested,壳未注册新窗
            // 处理器,wry 0.57.0 默认 SetHandled(true) 拒绝——webview2/
            // mod.rs:849;iframe 导航对本回调不可见,防线是 local-api
            // 页面自身 CSP page.ts:72 default-src 'none')——ADR 威胁建模
            // 2(b):非白名单导航(含指向其它端口的回环目标)一律拒绝
            // (false 阻止)并在壳内提示(ADR「集成不变式」节,M8-03c
            // 落地)。初始加载 URL 由代码构造、恒回环且端口即 serve 端口,
            // 不依赖本回调放行(tauri 2.12 签名:Fn(&Url) -> bool,
            // 以本地 crates 源核实)。
            .on_navigation(move |target| {
                let allowed = navigation_allowed(target, serve_port);
                if !allowed {
                    // 拒绝与提示缺一不可;提示文案只含 scheme+host+port
                    // (最小暴露),弹窗阻塞裁决属预期(见
                    // notify_rejected_navigation 文档)。
                    notify_rejected_navigation(target);
                }
                allowed
            })
            .build()?;

            // M11-01:把自动认证接线装进 WebView2(页面静态资源不经令牌守
            // 卫,首份文档导航不受本接线时序影响;/api/* 的 fetch 发生在页
            // 面加载后,过滤器届时必已注册)。令牌 None(未报告/读取失败/
            // 形态不合)⇒ 完全不接线,页面保持手动流;接线 COM 失败 ⇒ 诊断
            // 只含步骤名(session.rs 契约),壳继续运行,页面落回手动流。
            // 壳对页面零 IPC 授权不变:本接线是网络层请求头改写,不是
            // tauri command,capability 面保持空集。
            let token_for_injection = session_token;
            let port_for_injection = serve_port;
            let _ = window.with_webview(move |webview| {
                #[cfg(windows)]
                if let Some(token) = token_for_injection.as_deref() {
                    if let Err(diagnostic) =
                        session::install_authorization_injection(&webview, port_for_injection, token)
                    {
                        eprintln!("role-orchestrator-shell: 自动认证未启用({diagnostic})");
                    }
                }
                #[cfg(not(windows))]
                {
                    let _ = (&webview, port_for_injection, &token_for_injection);
                }
            });

            // ADR「集成不变式」节:关闭按钮 → 隐藏到托盘(壳常驻)而非
            // 退出;真正的退出只在托盘菜单。拦截 CloseRequested 后窗口不会
            // 真正关闭,事件循环因此不会因「最后一个窗口关闭」而退出。
            {
                let closable = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = closable.hide();
                    }
                });
            }

            // 托盘:图标复用 bundle 资源(icons/icon.ico 经 tauri-build 编入
            // 可执行资源,context 以 default_window_icon 暴露)。托盘常驻是
            // 本批硬需求且是隐藏后唯一的恢复入口,图标缺失直接失败关闭,
            // 绝不静默跑出一个「关掉就再也唤不回」的壳。
            let tray_icon = app
                .default_window_icon()
                .expect("bundle 图标缺失:tauri.conf.json bundle.icon 未编入资源")
                .clone();
            let tray_menu_builder = tauri::menu::MenuBuilder::new(app)
                .text(TRAY_ID_SHOW_MAIN, "显示主窗口");
            // M9-04:「打开令牌文件」仅 Windows 构建追加(依赖 ShellExecuteW);
            // 非 Windows 平台菜单保持 v0.2.0 的既有两项(行为零回归),点击
            // 路径的降级诊断见 open_path_with_system_default 的 cfg 分支。
            #[cfg(windows)]
            let tray_menu_builder =
                tray_menu_builder.text(TRAY_ID_OPEN_TOKEN_FILE, "打开令牌文件");
            let tray_menu = tray_menu_builder.text(TRAY_ID_QUIT, "退出").build()?;
            let child_for_tray = Arc::clone(&child);
            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Role Orchestrator")
                .menu(&tray_menu)
                // 左键不弹菜单(默认行为会弹):把左键序列让给「双击恢复
                // 窗口」——tray-icon 在 Windows 上左键抬起即弹菜单会吃掉
                // 双击判定;菜单改由右键唤出(menu_on_right_click 默认开)。
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match tray_menu_action(event.id().as_ref()) {
                    Some(TrayAction::ShowMainWindow) => show_main_window(app),
                    Some(TrayAction::OpenTokenFile) => {
                        // M9-04:裁决(serve 报告的路径 + 此刻存在性)通过才
                        // 打开;未报告/不存在 → 壳内提示(fail-safe,见
                        // run_open_token_file)。
                        run_open_token_file(&child_for_tray);
                    }
                    Some(TrayAction::QuitShell) => {
                        // ADR 不变式:退出 = 先停 local-api 子进程(Job 树
                        // 杀)再退出壳;顺序由 shutdown_sequence 钉死并单测。
                        run_shutdown_sequence(&child_for_tray, app);
                    }
                    None => {
                        eprintln!(
                            "role-orchestrator-shell: 未登记的托盘菜单 id:{}",
                            event.id().as_ref()
                        );
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键双击恢复窗口(与菜单「显示主窗口」同一动作)。
                    if let tauri::tray::TrayIconEvent::DoubleClick {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|error| format!("tauri 事件循环异常退出: {error}"))?;

    // 兜底停 serve:正常退出路径(托盘菜单)已在事件循环内树杀整树,此处
    // 的 ServeChild::drop 幂等(已死只补一次 wait);任何绕过托盘菜单的
    // 退出路径(事件循环异常等)都经此停 serve。若共享的 Arc 因任何原因
    // 未归一(闭包随 App 的释放时机),壳进程退出本身仍有 KILL_ON_JOB_CLOSE
    // 内核兜底(见 serve_child 模块文档),serve 不会孤儿化。
    drop(child_for_tail);
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("role-orchestrator-shell: {message}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Instant;

    fn args<'a>(list: &'a [&'a str]) -> impl Iterator<Item = String> + 'a {
        list.iter().map(|s| s.to_string())
    }

    #[test]
    fn explicit_db_path_is_taken_verbatim() {
        let config =
            parse_shell_args(args(&["--db", "h:/data/o.db"]), Some("C:/Users/u/AppData/Local"))
                .expect("valid args");
        assert_eq!(config.db, PathBuf::from("h:/data/o.db"));
        assert!(!config.db_is_default);
    }

    #[test]
    fn default_db_is_under_localappdata() {
        let config =
            parse_shell_args(args(&[]), Some("C:/Users/u/AppData/Local")).expect("default");
        assert!(config.db.starts_with("C:/Users/u/AppData/Local"));
        assert_eq!(
            config.db.parent().and_then(|p| p.file_name()),
            Some(std::ffi::OsStr::new("role-orchestrator"))
        );
        assert_eq!(
            config.db.file_name(),
            Some(std::ffi::OsStr::new("orchestrator.db"))
        );
        assert!(config.db_is_default);
    }

    #[test]
    fn default_requires_localappdata() {
        let error = parse_shell_args(args(&[]), None).expect_err("no LOCALAPPDATA");
        assert!(error.contains("LOCALAPPDATA"));
    }

    #[test]
    fn default_profiles_path_is_next_to_the_default_db() {
        // M9-03:per-user profiles 约定路径与默认库同目录
        // (%LOCALAPPDATA%/role-orchestrator/profiles.json),且与 db 共用
        // 同一条 LOCALAPPDATA fail-closed 出口(未设置/空串/非绝对路径)。
        let profiles =
            default_profiles_path(Some("C:/Users/u/AppData/Local")).expect("profiles path");
        assert!(profiles.starts_with("C:/Users/u/AppData/Local"));
        assert_eq!(
            profiles.parent().and_then(|p| p.file_name()),
            Some(std::ffi::OsStr::new("role-orchestrator"))
        );
        assert_eq!(profiles.file_name(), Some(std::ffi::OsStr::new("profiles.json")));
        // db 与 profiles 同目录:单一数据目录,README 披露的约定。
        let db = default_db_path(Some("C:/Users/u/AppData/Local")).expect("db path");
        assert_eq!(db.parent(), profiles.parent());
        // fail-closed 与 default_db_path 同口径。
        assert!(default_profiles_path(None).is_err());
        assert!(default_profiles_path(Some("")).is_err());
        assert!(default_profiles_path(Some("relative/base")).is_err());
        assert!(default_profiles_path(Some("C:/Users/u/AppData/Local")).is_ok());
    }

    #[test]
    fn empty_localappdata_is_refused_not_relativized() {
        // fail-closed(审查 minor):空字符串 LOCALAPPDATA 若被接受,默认库
        // 会静默落到 cwd 相对树(role-orchestrator/orchestrator.db)——比
        // 报错危险得多,必须显式拒绝。
        let error = parse_shell_args(args(&[]), Some("")).expect_err("empty LOCALAPPDATA");
        assert!(error.contains("LOCALAPPDATA"), "{error}");
    }

    #[test]
    fn non_absolute_localappdata_is_refused_not_relativized() {
        // M 族(审查移交):非空但非绝对的 LOCALAPPDATA 与空串同罪——
        // 相对路径同样会静默落成 cwd 相对树,必须显式拒绝,且与空串共用
        // default_db_path 里同一条 fail-closed 出口。
        let error =
            parse_shell_args(args(&[]), Some("relative/base")).expect_err("relative LOCALAPPDATA");
        assert!(error.contains("LOCALAPPDATA"), "{error}");
        assert!(default_db_path(Some("relative/base")).is_err());
        assert!(default_db_path(Some(".")).is_err());
        // 绝对形态放行(盘符与 UNC)。
        assert!(default_db_path(Some("C:/Users/u/AppData/Local")).is_ok());
        assert!(default_db_path(Some("\\\\server\\share")).is_ok());
    }

    #[test]
    fn rejects_duplicate_unknown_and_valueless_forms() {
        assert!(parse_shell_args(args(&["--db", "a.db", "--db", "b.db"]), None).is_err());
        assert!(parse_shell_args(args(&["--verbose"]), None).is_err());
        assert!(parse_shell_args(args(&["stray"]), None).is_err());
        assert!(parse_shell_args(args(&["--db"]), None).is_err());
        assert!(parse_shell_args(args(&["--db", ""]), None).is_err());
        // --db=value 形态不识别(与 serve 的 strict 口径一致)
        assert!(parse_shell_args(args(&["--db=a.db"]), None).is_err());
    }

    #[test]
    fn rejects_flag_like_db_values_as_missing() {
        // 对齐 serve strict(serve.ts parseServeArgs:值以 "--" 开头按缺值
        // 拒绝;审查 minor:壳此前会把 "--port" 吞成 db 路径)。修正后
        // 「与 serve 的 strict 口径一致」的说法才成立。
        let error =
            parse_shell_args(args(&["--db", "--port"]), None).expect_err("flag-like value");
        assert!(error.contains("--db"), "{error}");
        assert!(parse_shell_args(args(&["--db", "--port", "8123"]), None).is_err());
        assert!(parse_shell_args(args(&["--db", "--whatever"]), None).is_err());
    }

    #[test]
    fn navigation_lock_requires_the_exact_serve_port_on_top_of_the_whitelist() {
        // 白名单内且端口精确匹配:放行
        let ok = tauri::Url::parse("http://127.0.0.1:8123/index.html").expect("url");
        assert!(navigation_allowed(&ok, 8123));
        // 同为回环,端口不同一律拒绝
        let other_port = tauri::Url::parse("http://127.0.0.1:9999/").expect("url");
        assert!(!navigation_allowed(&other_port, 8123));
        // 省缺端口(http 默认 80)不构成精确匹配
        let default_port = tauri::Url::parse("http://127.0.0.1/").expect("url");
        assert!(!navigation_allowed(&default_port, 8123));
        // 基础白名单之外的形态维持拒绝:localhost 字样/非 http/userinfo/
        // 路径伪装
        for raw in [
            "http://localhost:8123/",
            "https://127.0.0.1:8123/",
            "http://127.0.0.1@evil.example:8123/",
            "http://evil.example/127.0.0.1:8123",
        ] {
            let target = tauri::Url::parse(raw).expect("url");
            assert!(!navigation_allowed(&target, 8123), "{raw} 应被拒");
        }
    }

    #[test]
    fn rejected_navigation_display_carries_only_scheme_host_port() {
        // K 族落地(壳内提示的最小暴露):文案必须含被阻导航的 host,但
        // path/query/fragment 一概不得出现——query 是令牌类内容最典型的
        // 藏身处,壳的提示面不承载令牌类内容(最小暴露收敛照旧)。
        let target =
            tauri::Url::parse("http://evil.example:8443/harvest?token=secret-value#frag")
                .expect("url");
        let text = rejected_navigation_display(&target);
        assert_eq!(text, "http://evil.example:8443");
        assert!(text.contains("evil.example"));
        assert!(!text.contains("harvest"), "{text}");
        assert!(!text.contains("token"), "{text}");
        assert!(!text.contains("secret"), "{text}");
        assert!(!text.contains("frag"), "{text}");
        // 无端口目标不显示空端口段。
        let no_port = tauri::Url::parse("https://evil.example/x").expect("url");
        assert_eq!(rejected_navigation_display(&no_port), "https://evil.example");
    }

    #[cfg(windows)]
    #[test]
    fn wide_notice_is_nul_terminated() {
        // MessageBoxW 的 PCWSTR 契约:NUL 结尾。
        assert_eq!(to_wide("ab"), vec![97u16, 98u16, 0]);
        assert_eq!(to_wide(""), vec![0u16]);
    }

    #[test]
    fn tray_menu_ids_map_to_registered_actions_only() {
        assert_eq!(
            tray_menu_action(TRAY_ID_SHOW_MAIN),
            Some(TrayAction::ShowMainWindow)
        );
        // M9-04:「打开令牌文件」id 登记(菜单项仅 Windows 构建,映射本身
        // 平台无关、恒可测)。
        assert_eq!(
            tray_menu_action(TRAY_ID_OPEN_TOKEN_FILE),
            Some(TrayAction::OpenTokenFile)
        );
        assert_eq!(tray_menu_action(TRAY_ID_QUIT), Some(TrayAction::QuitShell));
        // 未登记/近似串不得命中任何动作(拒绝静默吞掉)。
        assert_eq!(tray_menu_action(""), None);
        assert_eq!(tray_menu_action("quit"), None);
        assert_eq!(tray_menu_action("show"), None);
        assert_eq!(tray_menu_action("open-token"), None);
        assert_eq!(tray_menu_action("open-token-file-x"), None);
    }

    #[test]
    fn token_file_open_decision_requires_a_reported_existing_path() {
        // 放行:serve 已报告 + 注入的存在性探针为真 → 恰返回该路径。
        let reported = Some("C:/Users/ro/AppData/Local/Temp/ro/session-token-ab.txt");
        assert_eq!(
            token_file_open_decision(reported, |candidate| candidate.ends_with(".txt")),
            Some(reported.expect("static").to_string())
        );
        // serve 未报告(诊断行未到/旧版 bundle/恶意形态被拒)→「尚未生成」。
        assert_eq!(token_file_open_decision(None, |_| true), None);
        // 报告了但文件此刻不存在(已被 serve 清理/重启换文件)→ 同样提示。
        assert_eq!(token_file_open_decision(reported, |_| false), None);
        // 空串报告 ≠ 有效路径,拒绝(哪怕存在性探针恒真)。
        assert_eq!(token_file_open_decision(Some(""), |_| true), None);
        // 存在性探针按裁决入参原样收到报告值(注入不偏移)。
        let mut seen: Vec<String> = Vec::new();
        let _ = token_file_open_decision(reported, |candidate| {
            seen.push(candidate.to_string());
            false
        });
        assert_eq!(seen, vec![reported.expect("static").to_string()]);
    }

    #[test]
    fn shutdown_sequence_stops_serve_before_exiting_the_shell() {
        // ADR 集成不变式(托盘退出 = 先停 local-api 子进程再退出壳)的
        // 钉死:StopServeChild 必须在 ExitShell 之前。顺序反转即测试红,
        // 而不是悄悄产生 serve 孤儿。
        let sequence = shutdown_sequence();
        assert_eq!(
            sequence,
            [ShutdownStep::StopServeChild, ShutdownStep::ExitShell]
        );
        let stop = sequence
            .iter()
            .position(|step| *step == ShutdownStep::StopServeChild)
            .expect("序列必须包含停 serve 步骤");
        let exit = sequence
            .iter()
            .position(|step| *step == ShutdownStep::ExitShell)
            .expect("序列必须包含退出壳步骤");
        assert!(stop < exit, "停 serve 必须先于退出壳");
    }

    /// 回环假应答器:每个连接收完请求后答一行最小合法状态行(至多 rounds
    /// 次);返回端口与回收线程句柄(与 health.rs 组件测试同一配方)。
    fn spawn_status_responder(rounds: u32) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            for _ in 0..rounds {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut sink = [0u8; 512];
                    let _ = stream.read(&mut sink);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                }
            }
        });
        (port, handle)
    }

    #[test]
    fn ready_wiring_builds_the_loopback_url_on_success() {
        let (port, responder) = spawn_status_responder(1);
        let (bound, page_url) = serve_ready_url_with(
            Some(port),
            || true,
            Duration::from_secs(5),
            Duration::from_millis(50),
        )
        .expect("ready");
        assert_eq!(bound, port);
        // M11-01 ④:壳默认加载 /app(新 UI 根;产物缺失由 serve 302 回退旧页)。
        assert_eq!(page_url, format!("http://127.0.0.1:{port}/app"));
        responder.join().expect("responder thread");
    }

    #[test]
    fn ready_wiring_fails_fast_when_the_provider_dies() {
        // 失败路径一(子进程死亡):存活断言为 false 必须不等满 5s 名义
        // 超时——listen 后崩溃秒级暴露的布线级证明。
        let started = Instant::now();
        let error = serve_ready_url_with(
            Some(1), // 任意端口:存活断言先行,不应触网
            || false,
            Duration::from_secs(5),
            Duration::from_millis(50),
        )
        .expect_err("dead provider");
        assert!(error.contains("健康检查"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "应快速失败而非等满超时,实际耗时 {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn timeout_diagnostics_format_subsecond_values_as_milliseconds() {
        // N 族(审查移交):诊断文案的超时格式化——亚秒不得显示成 "0s"。
        assert_eq!(format_timeout(Duration::from_secs(30)), "30s");
        assert_eq!(format_timeout(Duration::from_millis(400)), "400ms");
        assert_eq!(format_timeout(Duration::from_millis(0)), "0ms");
    }

    #[test]
    fn ready_wiring_times_out_when_nothing_listens() {
        // 失败路径二(超时):先绑后放拿一个此刻确定空闲的端口(与既有
        // 测试同口径,存在极小抢占窗口),存活恒真,等待必须以失败收场。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let error = serve_ready_url_with(
            Some(port),
            || true,
            Duration::from_millis(400),
            Duration::from_millis(100),
        )
        .expect_err("idle port");
        assert!(error.contains("健康检查"), "{error}");
        // N 族(审查移交):亚秒超时在诊断文案里按毫秒显示,不再失真为
        // "0s"。
        assert!(error.contains("400ms"), "{error}");
        assert!(!error.contains("0s"), "{error}");
    }

    #[test]
    fn ready_wiring_fails_when_the_diagnostic_line_never_arrives() {
        // 发现失败(诊断行缺失/子进程已死):立即失败,不进入健康等待。
        let error = serve_ready_url_with(
            None,
            || false,
            Duration::from_secs(5),
            Duration::from_millis(50),
        )
        .expect_err("no discovery");
        assert!(error.contains("监听端口"), "{error}");
    }
}
