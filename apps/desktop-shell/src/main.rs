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
/// LOCALAPPDATA 未设置(异常环境)是配置错误,不猜默认。
fn default_db_path(local_app_data: Option<&str>) -> Result<PathBuf, String> {
    let base =
        local_app_data.ok_or("环境变量 LOCALAPPDATA 未设置,且未显式给出 --db")?;
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

    // 端口提示(仅发现)→ HTTP 探测(裁决)。端口发现失败只说明诊断行
    // 未到/进程已死;「在位」结论由 wait_healthy 的探测给出。
    let result = (|| -> Result<u16, String> {
        let port = child
            .wait_for_discovered_port(Duration::from_secs(30))
            .ok_or("serve 子进程 30s 内未报告监听端口(诊断行缺失或进程已退出)")?;
        if !health::wait_healthy(port, Duration::from_secs(30), Duration::from_millis(200)) {
            return Err(format!(
                "local-api 未在 30s 内通过回环健康检查(127.0.0.1:{port})"
            ));
        }
        Ok(port)
    })();
    let port = match result {
        Ok(port) => port,
        Err(message) => {
            // 显式先停子进程再退出(Drop 也会兜底);绝不建窗口。
            drop(child);
            return Err(message);
        }
    };

    tauri::Builder::default()
        .setup(move |app| {
            // 唯一合法回环 URL;导航锁定(M8-03b)会把 url::is_allowed_navigation
            // 接到窗口的 on_navigation 上,本批先只锁定初始加载目标。
            let parsed = tauri::Url::parse(&url::loopback_url(port))?;
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(parsed),
            )
            .title("Role Orchestrator")
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
    fn rejects_duplicate_unknown_and_valueless_forms() {
        assert!(parse_shell_args(args(&["--db", "a.db", "--db", "b.db"]), None).is_err());
        assert!(parse_shell_args(args(&["--verbose"]), None).is_err());
        assert!(parse_shell_args(args(&["stray"]), None).is_err());
        assert!(parse_shell_args(args(&["--db"]), None).is_err());
        assert!(parse_shell_args(args(&["--db", ""]), None).is_err());
        // --db=value 形态不识别(与 serve 的 strict 口径一致)
        assert!(parse_shell_args(args(&["--db=a.db"]), None).is_err());
    }
}
