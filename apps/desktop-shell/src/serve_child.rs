//! M8-03a stage 2(下一任务填实现):local-api serve 子进程管理。
//!
//! 约束(仓库硬红线 + ADR reports/M8-03-desktop-shell-adr.md):
//! - spawn 一律 argv 数组,不开 shell,不经 cmd/bash 拼接;
//! - 令牌流完全不经手:不读、不缓存、不放进子进程 argv/env、不持久化
//!   (local-api 写 per-user 0o600 文件,操作者自行读取粘贴到页面);
//! - 绝不以子进程 stdout 文本判定成功——stdout 仅用于诊断转发(取监听
//!   端口提示),「在位」判定只走 [`crate::health`] 的 HTTP 探测。
