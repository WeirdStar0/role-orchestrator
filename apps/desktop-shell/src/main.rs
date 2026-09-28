//! role-orchestrator 桌面壳 — M8-03a 可构建骨架(stage 1)。
//!
//! 本阶段只搭骨架:窗口不在配置里创建(`tauri.conf.json` 的 `app.windows`
//! 为空数组),正式窗口由后续阶段的代码在 local-api serve 子进程就绪
//! (HTTP 探测收到响应,绝不以子进程 stdout 文本判定成功)之后创建,并
//! 把导航锁定到回环 origin。连接逻辑的落点:
//! - [`serve_child`] 启动/停止 `role-orchestrator-local-api-serve` 子进程;
//! - [`health`] 回环 HTTP 探测「local-api 在位」;
//! - [`url`] WebView 导航的回环 origin 锁定。
//!
//! 安全不变式(完整论证见 reports/M8-03-desktop-shell-adr.md):
//! 壳不经手令牌(不读/不缓存/不进子进程 argv/env/不持久化);spawn 一律
//! argv 数组、不开 shell;壳进程不获得超出页面的任何权限(capability 近零)。

// 发布构建隐藏控制台窗口(标准 Tauri 模板做法);调试构建保留以便诊断。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod health;
mod serve_child;
mod url;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("role-orchestrator desktop shell failed to start");
}
