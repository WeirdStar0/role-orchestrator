//! ADR 待实测第 3 项的运行时层探针(独立示例 bin 形态,由测试装置降级:
//! 本机实测 cargo test 装置加载 tauri 链接产物时以 STATUS_ENTRYPOINT_
//! NOT_FOUND(0xc0000139)崩溃,而普通 bin(主程序)同一依赖集加载运行
//! 正常——探针以 `cargo run --example` 的普通二进制形态交付,证据能力
//! 不变;静态层/产物层证据仍在 tests/source_invariants.rs)。
//!
//! 流程:加载壳自家协议占位页(frontendDist = shell-ui/index.html)→ 宿主
//! `eval` 注入探针脚本 → ①页面对一个**未注册**命令发起 invoke:结构上壳零
//! `invoke_handler`(见 tests/source_invariants.rs)⇒ 无命令可命中,叠加
//! capability 空集 ⇒ promise 必被拒绝——拒绝详情(命令不存在/无放行规则)
//! 经专用回呼 URL 送回宿主;②页面发起 `https://example.com` 导航:必须被
//! on_navigation 阻止(ADR 威胁建模 2b)。证据以 JSON 打印 stdout 并写入
//! `target/shell-probe-evidence.json`;断言失败以非零码退出。
//!
//! 跑法(需有桌面会话;RO_SHELL_PROBE=1 是刻意的显式开关):
//!   PowerShell:$env:RO_SHELL_PROBE="1"; cargo run --example capability_probe
//!   bash:      RO_SHELL_PROBE=1 cargo run --example capability_probe
//! 无头 CI 不设该变量即直接退出(退出码 2),不弹窗。
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct ProbeEvidence {
    /// invoke 被拒的详情(页面侧 catch 到的拒绝原因,原样记录)
    invoke_denied: Option<String>,
    /// invoke 意外成功 = capability 全拒证据失效
    invoke_resolved: bool,
    /// on_navigation 看到 example.com
    nav_example_com_seen: bool,
    /// 且返回 false 阻止
    nav_example_com_blocked: bool,
    /// 页面侧异常/未知回调(诊断用;非空即探针本身出了问题)
    diagnostics: Vec<String>,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn record_callback(evidence: &mut ProbeEvidence, rest: &str) {
    let (kind, value) = match rest.split_once('=') {
        Some(pair) => pair,
        None => {
            evidence
                .diagnostics
                .push(format!("malformed callback: {rest}"));
            return;
        }
    };
    let decoded = percent_decode(value);
    match kind {
        "invoke-denied" => evidence.invoke_denied = Some(decoded),
        "invoke-resolved" => evidence.invoke_resolved = true,
        // 桥缺失/页面异常:探针自身失败的诊断,不是 capability 证据
        "bridge" | "page-error" => evidence.diagnostics.push(format!("{kind}: {decoded}")),
        other => evidence
            .diagnostics
            .push(format!("unknown callback kind: {other}")),
    }
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 探针脚本:等 tauri IPC 桥就绪(至多 10s)→ 对未注册命令 invoke(必须被
/// 拒)→ 500ms 后发起外域导航(必须被 on_navigation 阻止)。两个证据都经
/// `ro-probe:` 回呼 URL 送回宿主;被测的拒绝机制同时就是回传通道。
const PROBE_JS: &str = r#"
(async () => {
  const send = (kind, value) => { location.href = 'ro-probe:' + kind + '=' + encodeURIComponent(String(value)); };
  try {
    for (let i = 0; i < 100 && !window.__TAURI_INTERNALS__; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!window.__TAURI_INTERNALS__) { send('bridge', 'tauri IPC bridge missing after 10s'); return; }
    try {
      const result = await window.__TAURI_INTERNALS__.invoke('probe_command_that_must_not_exist');
      send('invoke-resolved', JSON.stringify(result));
    } catch (error) {
      send('invoke-denied', typeof error === 'string' ? error : ((error && error.message) || JSON.stringify(error)));
    }
    setTimeout(() => { location.href = 'https://example.com/ro-shell-probe'; }, 500);
  } catch (error) {
    send('page-error', String(error));
  }
})();
"#;

fn main() {
    if std::env::var("RO_SHELL_PROBE").as_deref() != Ok("1") {
        println!(
            "capability probe 需要 RO_SHELL_PROBE=1(刻意的显式开关,防误弹窗)。\
             跑法:PowerShell $env:RO_SHELL_PROBE=\"1\"; cargo run --example capability_probe"
        );
        std::process::exit(2);
    }
    let evidence = Arc::new(Mutex::new(ProbeEvidence::default()));

    let run_result = {
        let evidence = Arc::clone(&evidence);
        tauri::Builder::default()
            .setup(move |app| {
                let window = tauri::webview::WebviewWindowBuilder::new(
                    app,
                    "probe",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("ro-shell capability probe")
                .on_navigation({
                    let evidence = Arc::clone(&evidence);
                    move |url| {
                        let text = url.as_str().to_string();
                        // 壳自家协议的初始加载目标:放行(探针必须先加载占位页)
                        let is_own_protocol_page = text.starts_with("http://tauri.localhost")
                            || text.starts_with("https://tauri.localhost")
                            || text.starts_with("tauri://localhost");
                        let mut guard = evidence.lock().expect("probe evidence poisoned");
                        if text.contains("example.com") {
                            // 外域导航:记录「已看到」,随后返回 false 阻止——
                            // 与生产 on_navigation 同一拒绝语义
                            guard.nav_example_com_seen = true;
                            guard.nav_example_com_blocked = true;
                            false
                        } else if let Some(rest) = text.strip_prefix("ro-probe:") {
                            record_callback(&mut guard, rest);
                            false
                        } else if is_own_protocol_page {
                            true
                        } else {
                            guard
                                .diagnostics
                                .push(format!("unexpected navigation blocked: {text}"));
                            false
                        }
                    }
                })
                .build()?;

                // 注入线程:等页面加载与 tauri 初始化脚本就绪后 eval 探针
                let injector_window = window.clone();
                let injector_evidence = Arc::clone(&evidence);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    if let Err(error) = injector_window.eval(PROBE_JS) {
                        injector_evidence
                            .lock()
                            .expect("probe evidence poisoned")
                            .diagnostics
                            .push(format!("eval failed: {error}"));
                    }
                });

                // 结束哨兵:证据齐(invoke 拒绝 + 外域导航被拦)或 60s 超时,
                // 统一由这里退出事件循环——断言在 run() 返回后进行
                let handle = app.handle().clone();
                let watcher_evidence = Arc::clone(&evidence);
                std::thread::spawn(move || {
                    let deadline = Instant::now() + Duration::from_secs(60);
                    loop {
                        let done = {
                            let guard = watcher_evidence.lock().expect("probe evidence poisoned");
                            guard.invoke_denied.is_some() && guard.nav_example_com_seen
                        };
                        if done || Instant::now() >= deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    // 给最后的回呼留一点在途时间
                    std::thread::sleep(Duration::from_millis(500));
                    handle.exit(0);
                });
                Ok(())
            })
            .run(tauri::generate_context!())
            .map_err(|error| error.to_string())
    };

    let evidence = evidence.lock().expect("probe evidence poisoned");
    let report = format!(
        "{{\"invoke_denied\": {}, \"invoke_resolved\": {}, \"nav_example_com_seen\": {}, \
         \"nav_example_com_blocked\": {}, \"diagnostics\": [{}]}}",
        evidence
            .invoke_denied
            .as_deref()
            .map(|detail| format!("\"{}\"", json_escape(detail)))
            .unwrap_or_else(|| "null".to_string()),
        evidence.invoke_resolved,
        evidence.nav_example_com_seen,
        evidence.nav_example_com_blocked,
        evidence
            .diagnostics
            .iter()
            .map(|entry| format!("\"{}\"", json_escape(entry)))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!("PROBE_EVIDENCE {report}");
    let evidence_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/shell-probe-evidence.json");
    match std::fs::write(&evidence_path, &report) {
        Ok(()) => println!("PROBE_EVIDENCE_FILE {}", evidence_path.display()),
        Err(error) => println!("PROBE_EVIDENCE_FILE 写入失败: {error}"),
    }

    let mut failed = false;
    if let Err(error) = run_result {
        eprintln!("探针窗口/事件循环失败(无桌面会话?): {error}");
        std::process::exit(3);
    }
    if evidence.invoke_resolved {
        eprintln!("FAIL: capability 全拒证据失效——未注册命令的 invoke 竟然成功");
        failed = true;
    }
    if !evidence
        .invoke_denied
        .as_deref()
        .is_some_and(|detail| !detail.trim().is_empty())
    {
        eprintln!(
            "FAIL: 页面侧 invoke 未收到拒绝详情(证据缺失);diagnostics: {:?}",
            evidence.diagnostics
        );
        failed = true;
    }
    if !(evidence.nav_example_com_seen && evidence.nav_example_com_blocked) {
        eprintln!(
            "FAIL: 外域导航未被 on_navigation 拦截(seen={}, blocked={});diagnostics: {:?}",
            evidence.nav_example_com_seen, evidence.nav_example_com_blocked, evidence.diagnostics
        );
        failed = true;
    }
    if !evidence.diagnostics.is_empty() {
        eprintln!("FAIL: 探针自身出现诊断异常: {:?}", evidence.diagnostics);
        failed = true;
    }
    if failed {
        std::process::exit(1);
    }
    println!("PROBE_RESULT: capability 全拒 + 导航锁定拒绝证据成立(ADR 第 3 项运行层)");
}
