//! role-orchestrator 桌面壳(M8-03a 连接阶段)。
//!
//! 流程:解析壳自身参数(仅 --db <path> 可选)→ spawn local-api serve 子
//! 进程(argv 数组,见 [`serve_child`])→ HTTP 探测就绪(见 [`health`])→
//! 创建 WebView 窗口加载唯一合法回环 URL(见 [`url`])。健康检查失败则
//! 打印诊断并以非零码退出,不建窗口。
//!
//! 安全不变式(完整论证见 ADR reports/M8-03-desktop-shell-adr.md):
//! 壳不经手令牌(不读/不缓存/不进子进程 argv/env/不持久化);spawn 一律
//! argv 数组、不开 shell;在位判定只靠 HTTP 探测,stdout 只提供端口提示;
//! 壳进程不获得超出页面的任何权限。

// 发布构建隐藏控制台窗口(标准 Tauri 模板做法);调试构建保留以便诊断。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::Duration;

use role_orchestrator_desktop_shell::{health, serve_child, url};

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

/// 默认库路径:%LOCALAPPDATA%/role-orchestrator/orchestrator.db。
/// fail-closed:LOCALAPPDATA 未设置或为空字符串都是配置错误,不猜默认——
/// 空字符串会静默构造出 cwd 相对路径,把默认库落到壳的启动目录里(审查
/// minor),必须显式拒绝。
fn default_db_path(local_app_data: Option<&str>) -> Result<PathBuf, String> {
    let base = match local_app_data {
        Some(base) if !base.is_empty() => base,
        Some(_) => {
            return Err(
                "环境变量 LOCALAPPDATA 为空字符串,且未显式给出 --db".to_string(),
            )
        }
        None => return Err("环境变量 LOCALAPPDATA 未设置,且未显式给出 --db".to_string()),
    };
    Ok(PathBuf::from(base)
        .join("role-orchestrator")
        .join("orchestrator.db"))
}

/// serve 子进程的 node 可执行文件:默认走 PATH;可用 RO_SHELL_NODE 覆盖。
fn node_path() -> String {
    std::env::var("RO_SHELL_NODE").unwrap_or_else(|_| "node".to_string())
}

/// serve 入口:默认 dev 布局(cargo run 的 cwd = apps/desktop-shell →
/// monorepo 的 packages/local-api/dist/serve-bin.js);可用 RO_SHELL_SERVE_BIN
/// 覆盖。打包布局(M8-03b/c 侧车资源)落地时更新默认值。
fn serve_bin_path() -> String {
    std::env::var("RO_SHELL_SERVE_BIN")
        .unwrap_or_else(|_| "../../packages/local-api/dist/serve-bin.js".to_string())
}

/// 导航裁决(可测纯函数,ADR 威胁建模 2(b) 的落地):`url::is_allowed_
/// navigation` 的白名单规则(http scheme + host 恰为 127.0.0.1 + 合法端口
/// + 禁 userinfo)之上,叠加「恰为本壳 serve 端口」的精确匹配(url 模块
/// 预告的 M8-03b 约束)——即使 scheme/host 全对,指向其它端口的回环导航
/// 同样拒绝;省缺端口(http 默认 80)不构成精确匹配。
fn navigation_allowed(target: &tauri::Url, serve_port: u16) -> bool {
    url::is_allowed_navigation(target.as_str()) && target.port() == Some(serve_port)
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
            "local-api 未在 {}s 内通过回环健康检查(127.0.0.1:{port};超时或 serve 进程已退出)",
            health_timeout.as_secs()
        ));
    }
    Ok((port, url::loopback_url(port)))
}

/// 壳的真实布线:端口提示走 ServeChild 的诊断行发现,存活断言走子进程
/// try_wait(Some = 已退出)——每轮探测前核查,serve 在 listen 后崩溃时
/// 秒级失败而非把崩溃伪装成整段超时。窗口装配不在此函数内(留在 run)。
fn serve_ready_url(
    child: &mut serve_child::ServeChild,
    discovery_timeout: Duration,
    health_timeout: Duration,
    interval: Duration,
) -> Result<(u16, String), String> {
    let discovered_port = child.wait_for_discovered_port(discovery_timeout);
    serve_ready_url_with(
        discovered_port,
        || child.try_wait().ok().flatten().is_none(),
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
    let node = node_path();
    let serve_bin = serve_bin_path();
    if !std::path::Path::new(&serve_bin).exists() {
        return Err(format!(
            "serve 入口不存在: {serve_bin}——先在仓库根运行 pnpm build,或用 RO_SHELL_SERVE_BIN 指定"
        ));
    }
    let db = config
        .db
        .to_str()
        .ok_or("数据库路径不是合法 UTF-8")?
        .to_string();

    let mut child = serve_child::ServeChild::spawn_serve(&node, &serve_bin, &db, 0)
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

    tauri::Builder::default()
        .setup(move |app| {
            // 初始加载 URL 由 serve_ready_url 构造,恒为回环形态(url 模块)。
            let parsed = tauri::Url::parse(&page_url)?;
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(parsed),
            )
            .title("Role Orchestrator")
            // 运行期全部导航(window.open/重定向/链接点击)的唯一裁决点——
            // ADR 威胁建模 2(b):非白名单导航(含指向其它端口的回环目标)
            // 一律拒绝(false 阻止)。初始加载 URL 由代码构造、恒回环且
            // 端口即 serve 端口,不依赖本回调放行(tauri 2.12 签名:
            // Fn(&Url) -> bool,以本地 crates 源核实)。
            .on_navigation(move |target| navigation_allowed(target, serve_port))
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|error| format!("tauri 事件循环异常退出: {error}"))?;

    // 窗口关闭(事件循环结束)后:Drop 先停 serve 子进程再退出壳。
    drop(child);
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
    fn empty_localappdata_is_refused_not_relativized() {
        // fail-closed(审查 minor):空字符串 LOCALAPPDATA 若被接受,默认库
        // 会静默落到 cwd 相对树(role-orchestrator/orchestrator.db)——比
        // 报错危险得多,必须显式拒绝。
        let error = parse_shell_args(args(&[]), Some("")).expect_err("empty LOCALAPPDATA");
        assert!(error.contains("LOCALAPPDATA"), "{error}");
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
        assert_eq!(page_url, format!("http://127.0.0.1:{port}"));
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
