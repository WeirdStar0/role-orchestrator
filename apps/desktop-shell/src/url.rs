//! 回环 URL 规则(M8-03a):壳只允许把 WebView 指向 http://127.0.0.1:<port>。
//! M11-01 ④起,壳的默认入口是 /app(新 UI 根;M11-01 范围④「壳默认加载新
//! UI」):[`loopback_url`] 返回 `http://127.0.0.1:<port>/app`。新 UI 产物
//! 未随 serve 部署时,local-api 的 /app 路由以 302 回退到 /(旧页)——每个
//! 候选保持产品可用;导航白名单对 path 不敏感(仍只认 scheme/host/port)。
//!
//! 决策(对照 ADR reports/M8-03-desktop-shell-adr.md):ADR 允许「127.0.0.1
//! 或 localhost 等价回环 origin」,本壳按更严的一档执行——只认 IP 字面量
//! 127.0.0.1,禁止 localhost 字样与 0.0.0.0/:: 等其它回环写法:形式唯一,
//! 导航锁定与 local-api 的 Host 守卫永远比对同一字符串。
//! 本批 [`is_allowed_navigation`] 的接线现状(M8-03c 文档勘误,原「M8-03b
//! 才接线」的历史预告已过时):已作为生产导航谓词接在
//! `WebviewWindowBuilder::on_navigation` 上(见 main.rs::navigation_
//! allowed,并叠加 serve 端口精确匹配)。

/// 构造壳可加载的唯一合法回环 URL(port 来自 serve 子进程就绪探测)。
/// M11-01 ④:默认加载 /app(新 UI 根);产物缺失时由 local-api 以 302 回退
/// 旧页(见本模块文档)。
pub fn loopback_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/app")
}

/// 导航白名单规则:scheme 必须是 http(大小写不敏感,RFC 3986 语义),
/// authority 的 host 必须恰为 127.0.0.1,可带合法端口(0..=65535 的十进制
/// 数字,禁止空端口段)。两条防绕过约束:
/// - 禁止 userinfo(@)——"http://127.0.0.1@evil.example/" 的真实 host 是
///   evil.example,前缀匹配会漏放,必须整段拒绝;
/// - host 在第一个 `/`、`?`、`#` 之前整段判定——路径里出现 127.0.0.1
///   字样不构成放行理由。
/// 端口缺省允许(host 规则即本批约定);M8-03b 起已在其上叠加「恰为本壳
/// serve 端口」的精确匹配(现状,见 main.rs::navigation_allowed)。
pub fn is_allowed_navigation(raw: &str) -> bool {
    // scheme 截止于 "://";必须是 http(大小写不敏感)。
    let Some(scheme_end) = raw.find("://") else {
        return false;
    };
    if !raw[..scheme_end].eq_ignore_ascii_case("http") {
        return false;
    }
    let rest = &raw[scheme_end + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        return false;
    }
    let (host, port_part) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if host != "127.0.0.1" {
        return false;
    }
    if let Some(port) = port_part {
        if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        // parse 兜底 65536+ 的越界值;0 允许(规则只约束 scheme/host,实际
        // 导航目标永远来自就绪探测后的真实端口)。
        if port.parse::<u16>().is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_single_allowed_loopback_form() {
        // M11-01 ④:默认入口是 /app(新 UI 根);产物缺失由 serve 302 回退旧页。
        assert_eq!(loopback_url(8123), "http://127.0.0.1:8123/app");
        // 端口类型即边界:u16 两端都能构造出合法字符串
        assert_eq!(loopback_url(0), "http://127.0.0.1:0/app");
        assert_eq!(loopback_url(65535), "http://127.0.0.1:65535/app");
        // 白名单对带 path 的形态照常放行(导航裁决只看 scheme/host/port)。
        assert!(is_allowed_navigation(&loopback_url(8123)));
    }

    #[test]
    fn allows_the_exact_loopback_host_with_path_and_query() {
        assert!(is_allowed_navigation("http://127.0.0.1:8123"));
        assert!(is_allowed_navigation("http://127.0.0.1:8123/"));
        assert!(is_allowed_navigation("http://127.0.0.1:8123/index.html"));
        assert!(is_allowed_navigation("http://127.0.0.1:8123/api/v1/session?after=3#top"));
        assert!(is_allowed_navigation("HTTP://127.0.0.1:1")); // scheme 大小写不敏感
    }

    #[test]
    fn rejects_every_non_http_scheme() {
        assert!(!is_allowed_navigation("https://127.0.0.1:8123"));
        assert!(!is_allowed_navigation("ftp://127.0.0.1:8123"));
        assert!(!is_allowed_navigation("file:///C:/Windows"));
        assert!(!is_allowed_navigation("xhttp://127.0.0.1:8123"));
        assert!(!is_allowed_navigation("http:/127.0.0.1:8123")); // 无 //
        assert!(!is_allowed_navigation("tauri://localhost"));
    }

    #[test]
    fn rejects_every_non_literal_loopback_host() {
        // localhost 字样按本批决策显式禁止(ADR 的宽松档不被采用)
        assert!(!is_allowed_navigation("http://localhost:8123"));
        assert!(!is_allowed_navigation("http://LOCALHOST:8123"));
        // 其它回环写法与任意域名
        assert!(!is_allowed_navigation("http://0.0.0.0:8123"));
        assert!(!is_allowed_navigation("http://[::1]:8123"));
        assert!(!is_allowed_navigation("http://[::]:8123"));
        assert!(!is_allowed_navigation("http://127.0.0.2:8123"));
        assert!(!is_allowed_navigation("http://127.1:8123"));
        assert!(!is_allowed_navigation("http://evil.example:8123"));
        assert!(!is_allowed_navigation("http://evil.example/127.0.0.1"));
        // userinfo 绕过形态:真实 host 是 @ 之后的域名
        assert!(!is_allowed_navigation("http://127.0.0.1@evil.example/"));
        assert!(!is_allowed_navigation("http://user:pw@127.0.0.1:8123"));
    }

    #[test]
    fn enforces_port_boundaries() {
        assert!(is_allowed_navigation("http://127.0.0.1:65535/x"));
        assert!(is_allowed_navigation("http://127.0.0.1:0"));
        assert!(!is_allowed_navigation("http://127.0.0.1:65536"));
        assert!(!is_allowed_navigation("http://127.0.0.1:99999"));
        assert!(!is_allowed_navigation("http://127.0.0.1:")); // 空端口段
        assert!(!is_allowed_navigation("http://127.0.0.1:abc"));
        assert!(!is_allowed_navigation("http://127.0.0.1:8123x"));
        assert!(!is_allowed_navigation("http://127.0.0.1:-1"));
        assert!(!is_allowed_navigation("http://127.0.0.1:0x50"));
    }

    #[test]
    fn rejects_malformed_targets() {
        assert!(!is_allowed_navigation(""));
        assert!(!is_allowed_navigation("127.0.0.1:8123"));
        assert!(!is_allowed_navigation("//127.0.0.1:8123"));
        assert!(!is_allowed_navigation("http://"));
        assert!(!is_allowed_navigation("http://127.0.0.1 8123"));
    }
}
