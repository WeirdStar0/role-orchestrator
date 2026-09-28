//! 壳的库入口:纯逻辑模块供 bin(main.rs)与 tests/integration.rs 共用。
//! 连接逻辑的安全语义见各模块文档;总不变式见 ADR
//! reports/M8-03-desktop-shell-adr.md:壳不经手令牌、spawn 一律 argv 数组、
//! 在位判定只靠 HTTP 探测(绝不以子进程 stdout 文本判定成功)。
pub mod health;
pub mod serve_child;
pub mod url;
