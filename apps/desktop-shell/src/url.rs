//! M8-03a stage 2(下一任务填实现):WebView 导航的回环 origin 锁定。
//!
//! 目标规则(ADR):壳加载的 URL 锁定为 http://127.0.0.1:<port>(或
//! localhost 等价回环 origin);任何非该 origin 的导航(含 window.open、
//! 重定向、外链)一律拒绝并在壳内提示。页面令牌流不经壳,壳不提供任何
//! 「导出/同步」通道扩大暴露。
