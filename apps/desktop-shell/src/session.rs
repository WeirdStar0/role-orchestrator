//! 会话令牌自动会话(M11-01,ADR docs/adr/010-token-auto-session.md):
//! 壳读令牌文件一次进内存,经 WebView2 `WebResourceRequested` 事件对本壳
//! serve 的回环请求注入 `Authorization: Bearer <token>` 头。
//!
//! 红线修订与缓解(完整论证见 ADR;此处只列可测不变式):
//! - 仅 loopback 来源注入:过滤器字面量 `http://127.0.0.1:<port>/*` 之外,
//!   回调内再用 [`should_inject_authorization`] 纯函数复核(scheme http +
//!   host 恰 127.0.0.1 + 端口精确匹配 + 禁 userinfo/路径伪装,与
//!   main.rs::navigation_allowed 同一白名单口径);
//! - 内存中转:令牌内容读入后仅一份 `String`,随闭包移动;无第二份持有;
//! - 不落日志不持久化:本模块生产区域零日志宏、零文件系统调用(唯一的读
//!   取动作由调用侧 main.rs 经注入参数传入)——
//!   tests/source_invariants.rs 金丝雀钉死;
//! - 令牌文件 ACL 不变:只读;token.ts(serve 侧)零改动;
//! - 诊断失败路径只报 COM 步骤名,绝不含令牌内容或 URI 内容。
//!
//! 判定逻辑全部抽成纯函数(IO 经闭包注入),单测钉死。
use crate::url;

/// 令牌形态:serve 侧 token.ts 生成的 256-bit base64url 恰 43 字符
/// (TOKEN_PATTERN `/^[A-Za-z0-9_-]{43}$/`;文件内容为 `token + "\n"`)。
/// 壳按同一常量形态校验,防止被篡改的文件把任意字符串送进请求头。
const SESSION_TOKEN_LEN: usize = 43;

/// 从令牌文件内容提取会话令牌(纯函数):trim 两端空白(吃掉写入方的尾
/// 换行)后必须恰为 43 字符的 base64url 形态;其余形态(空/过短/过长/含
/// 非法字符)一律 None——绝不猜测性还原失真输入。
pub fn session_token_from_content(content: &str) -> Option<String> {
    let token = content.trim();
    if token.len() != SESSION_TOKEN_LEN {
        return None;
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    Some(token.to_string())
}

/// 读令牌决策(纯函数,IO 注入):serve 诊断行报告的路径存在且非空才发起
/// 读取;读取失败(None)或内容不合形态一律 None。None = 自动认证不启用,
/// 页面探测落回手动流(fail-safe,绝不 panic、绝不产生任何提示文案携带令
/// 牌)。`read` 注入保持纯函数可测;调用侧(main.rs)传入一次性的
/// read_to_string 探针——这是全壳唯一一处令牌文件读取(source_invariants
/// 白名单钉死),内容除返回值外去向为零。
pub fn read_session_token(
    reported_path: Option<&str>,
    read: impl FnOnce(&str) -> Option<String>,
) -> Option<String> {
    let path = reported_path.filter(|candidate| !candidate.is_empty())?;
    let content = read(path)?;
    session_token_from_content(&content)
}

/// Authorization 头的值(纯函数):恰为 `Bearer <token>`;空白/空令牌与含
/// 控制字符或非 ASCII 的令牌(头注入防线,合法令牌形态下不可能出现)一律
/// None ⇒ 调用侧不设头。
pub fn authorization_header_value(session_token: &str) -> Option<String> {
    let token = session_token.trim();
    if token.is_empty() {
        return None;
    }
    if token
        .chars()
        .any(|ch| (ch as u32) < 0x21 || (ch as u32) > 0x7e)
    {
        return None;
    }
    Some(format!("Bearer {token}"))
}

/// 从 URI 提取 authority 里的显式端口段(纯函数)。省缺端口返回 None:
/// 与壳导航锁同口径(http 默认 80 不构成精确匹配)。
fn explicit_port(raw_uri: &str) -> Option<u16> {
    let scheme_end = raw_uri.find("://")?;
    let rest = &raw_uri[scheme_end + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let (_, port) = authority.split_once(':')?;
    port.parse::<u16>().ok()
}

/// 注入判定(纯函数,ADR 缓解 1 的复核层):URI 必须落在壳的基础白名单内
/// ([`url::is_allowed_navigation`]:http + host 恰 127.0.0.1 + 合法端口 +
/// 禁 userinfo/路径伪装),且显式端口精确等于本壳 serve 端口。过滤器字面量
/// 已把事件面限到 `http://127.0.0.1:<port>/*`,本函数是第二道复核:任何
/// 其它形态(含同机其他端口)一律不动头。
pub fn should_inject_authorization(raw_uri: &str, serve_port: u16) -> bool {
    url::is_allowed_navigation(raw_uri) && explicit_port(raw_uri) == Some(serve_port)
}

/// 把注入接线装进 WebView2(Windows):取 ICoreWebView2,注册
/// `http://127.0.0.1:<port>/*`(ALL 资源上下文)过滤器与请求事件回调;回
/// 调对通过 [`should_inject_authorization`] 复核的请求以
/// [`authorization_header_value`] 的值 SetHeader(覆盖页可能自带的
/// Authorization——含页面哨兵值,语义是替换而非追加)。任何 COM 步骤失败
/// 都原样上抛步骤名(不含令牌/URI 内容),调用侧降级为手动流。回调内绝不
/// 记日志、绝不改动响应(不 SetResponse ⇒ 请求照常走网络栈)。
#[cfg(windows)]
pub fn install_authorization_injection(
    webview: &tauri::webview::PlatformWebview,
    serve_port: u16,
    session_token: &str,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller, ICoreWebView2WebResourceRequest,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    };
    use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
    use windows_strings::{HSTRING, PWSTR};

    let controller: ICoreWebView2Controller = webview.controller();
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|error| format!("CoreWebView2: {error}"))?;
    let filter = HSTRING::from(format!("http://127.0.0.1:{serve_port}/*"));
    unsafe { core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) }
        .map_err(|error| format!("AddWebResourceRequestedFilter: {error}"))?;

    let token = session_token.to_string();
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let request: ICoreWebView2WebResourceRequest = match unsafe { args.Request() } {
            Ok(request) => request,
            Err(_) => return Ok(()),
        };
        let mut uri_ptr = PWSTR::null();
        if unsafe { request.Uri(&mut uri_ptr) }.is_err() {
            return Ok(());
        }
        let uri = take_pwstr(uri_ptr);
        if !should_inject_authorization(&uri, serve_port) {
            return Ok(());
        }
        let Some(value) = authorization_header_value(&token) else {
            return Ok(());
        };
        if let Ok(headers) = unsafe { request.Headers() } {
            let name = HSTRING::from("Authorization");
            let value = HSTRING::from(value);
            let _ = unsafe { headers.SetHeader(&name, &value) };
        }
        Ok(())
    }));
    let mut event_token: i64 = 0;
    unsafe { core.add_WebResourceRequested(&handler, &mut event_token) }
        .map_err(|error| format!("add_WebResourceRequested: {error}"))?;
    Ok(())
}

/// 非 Windows 平台无 WebView2:接线不存在(壳的目标平台是 Windows;非
/// Windows 构建保持手动流,main.rs 接线处 cfg 隔离)。
#[cfg(not(windows))]
#[allow(dead_code)]
pub fn install_authorization_injection(
    _webview: &tauri::webview::PlatformWebview,
    _serve_port: u16,
    _session_token: &str,
) -> Result<(), String> {
    Err("authorization injection is Windows-only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 恰 43 字符的 base64url 形态(与 serve 侧 token.ts 的 TOKEN_PATTERN
    /// 同构);测试专用静态值,非任何真实凭据。
    const VALID_TOKEN: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    const TOKEN_FILE_TEXT: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG\n";

    #[test]
    fn extracts_the_constant_shape_token_from_file_content() {
        // 正常形态:token + 尾换行(serve 写入格式),trim 后恰 43 字符。
        assert_eq!(
            session_token_from_content(TOKEN_FILE_TEXT).as_deref(),
            Some(VALID_TOKEN)
        );
        // 无尾换行、两端空白包夹同样接受(trim 语义)。
        assert_eq!(
            session_token_from_content(VALID_TOKEN).as_deref(),
            Some(VALID_TOKEN)
        );
        assert_eq!(
            session_token_from_content(&format!("  {VALID_TOKEN}\r\n")).as_deref(),
            Some(VALID_TOKEN)
        );
        // 空内容 / 纯空白 → None。
        assert_eq!(session_token_from_content(""), None);
        assert_eq!(session_token_from_content("   \n"), None);
        // 形态偏离一律拒绝:过短、过长、非法字符(base64url 之外的 +、/、
        // 控制字符)——绝不猜测性还原。
        assert_eq!(session_token_from_content(&VALID_TOKEN[..42]), None);
        assert_eq!(session_token_from_content(&format!("{VALID_TOKEN}x")), None);
        assert_eq!(
            session_token_from_content(&format!("{}+/", &VALID_TOKEN[..41])),
            None
        );
        assert_eq!(
            session_token_from_content(&format!("{}\u{00e9}", &VALID_TOKEN[..42])),
            None
        );
    }

    #[test]
    fn read_session_token_requires_a_reported_path_and_well_formed_content() {
        // serve 未报告路径(诊断行缺失/旧版 bundle)→ 不发起读取;空串报告
        // ≠ 有效路径,同样拒绝。注入读取器记录触达过的路径,断言两个拒绝
        // 路径都零触达。
        let reads: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
        let probe = |path: &str| {
            reads.borrow_mut().push(path.to_string());
            Some(TOKEN_FILE_TEXT.to_string())
        };
        assert_eq!(read_session_token(None, probe), None);
        assert_eq!(read_session_token(Some(""), probe), None);
        assert!(
            reads.borrow().is_empty(),
            "未报告/空路径时不得触达文件系统"
        );
        // 读取失败(IO 错误被调用侧吃成 None)→ None。
        assert_eq!(read_session_token(Some("C:/t/session-token.txt"), |_| None), None);
        // 报告 + 读取成功 + 形态合法 → 恰返回令牌;read 收到的恰是报告路径。
        let mut seen: Vec<String> = Vec::new();
        let token = read_session_token(Some("C:/t/session-token.txt"), |path| {
            seen.push(path.to_string());
            Some(TOKEN_FILE_TEXT.to_string())
        });
        assert_eq!(token.as_deref(), Some(VALID_TOKEN));
        assert_eq!(seen, vec!["C:/t/session-token.txt".to_string()]);
        // 内容失真(被篡改的文件)→ None:失真输入不进请求头。
        assert_eq!(
            read_session_token(Some("C:/t/session-token.txt"), |_| Some(
                "short".to_string()
            )),
            None
        );
    }

    #[test]
    fn builds_the_bearer_header_and_refuses_header_injection_shapes() {
        assert_eq!(
            authorization_header_value(VALID_TOKEN).as_deref(),
            Some(&format!("Bearer {VALID_TOKEN}")[..])
        );
        // trim 语义:两端空白不吃进头值。
        assert_eq!(
            authorization_header_value(&format!("  {VALID_TOKEN} ")).as_deref(),
            Some(&format!("Bearer {VALID_TOKEN}")[..])
        );
        // 空 / 纯空白 → None(不设头)。
        assert_eq!(authorization_header_value(""), None);
        assert_eq!(authorization_header_value("   "), None);
        // 控制字符(含 CRLF 头注入形态)与非 ASCII → None(合法令牌形态下
        // 不可能;这是纵深防御,不是形态校验的主防线)。
        assert_eq!(authorization_header_value("abc\r\nX-Evil: 1"), None);
        assert_eq!(authorization_header_value("abc\ttab"), None);
        assert_eq!(authorization_header_value("tokén"), None);
        // 头值只可能是 "Bearer " + 令牌本身,不携带任何额外内容。
        let value = authorization_header_value(VALID_TOKEN).expect("header value");
        assert!(value.starts_with("Bearer "));
        assert_eq!(&value["Bearer ".len()..], VALID_TOKEN);
    }

    #[test]
    fn injects_only_for_the_exact_serve_port_on_the_literal_loopback_host() {
        let port = 8123u16;
        // 恰好本壳 serve 端口的回环请求:注入(含路径/query/子资源形态)。
        assert!(should_inject_authorization("http://127.0.0.1:8123/", port));
        assert!(should_inject_authorization("http://127.0.0.1:8123", port));
        assert!(should_inject_authorization("http://127.0.0.1:8123/app.js", port));
        assert!(should_inject_authorization(
            "http://127.0.0.1:8123/api/v1/session?after=3#top",
            port
        ));
        // 同为回环、端口不同:绝不注入(同机其他本地服务零接触)。
        assert!(!should_inject_authorization("http://127.0.0.1:9999/", port));
        assert!(!should_inject_authorization("http://127.0.0.1:0/", port));
        // 省缺端口(http 默认 80)不构成精确匹配。
        assert!(!should_inject_authorization("http://127.0.0.1/", port));
        // 基础白名单之外全拒绝:localhost 字样 / https / 其它 host / userinfo
        // / 路径伪装。
        for raw in [
            "http://localhost:8123/",
            "https://127.0.0.1:8123/",
            "ws://127.0.0.1:8123/",
            "http://0.0.0.0:8123/",
            "http://evil.example:8123/",
            "http://127.0.0.1@evil.example:8123/",
            "http://evil.example/127.0.0.1:8123",
            "http://127.0.0.1:8123x/",
        ] {
            assert!(
                !should_inject_authorization(raw, port),
                "{raw} 不得触发注入"
            );
        }
        // 端口边界:u16 全域精确比较。
        assert!(should_inject_authorization("http://127.0.0.1:65535/", 65535));
        assert!(!should_inject_authorization("http://127.0.0.1:65536/", 65535));
        assert!(!should_inject_authorization("http://127.0.0.1:abc/", 65535));
        assert!(!should_inject_authorization("http://127.0.0.1:/", 65535));
    }

    #[test]
    fn the_extracted_token_never_appears_in_any_decision_diagnostics() {
        // 决策层的错误/None 路径不产生任何文本(壳不记日志的机制性保证:
        // 这些纯函数的失败输出只有 None,连可泄漏的字符串都不存在)。
        // 本测试把这一性质钉成形态:全部失败路径的返回值都是单位类型 None。
        let failures = [
            read_session_token(None, |_| Some(TOKEN_FILE_TEXT.to_string())),
            read_session_token(Some("C:/t/x.txt"), |_| None),
            read_session_token(Some("C:/t/x.txt"), |_| Some("garbage".to_string())),
            authorization_header_value(""),
            session_token_from_content(""),
        ];
        for failure in failures {
            assert_eq!(failure, None);
        }
    }
}
