//! 真实集成测试(默认不跑,`#[ignore]` + 环境开关双保险):
//! spawn 真实 local-api serve 子进程(入口经壳的同一资源定位链解析,M8-05:
//! env 覆盖 → 捆绑资源 → 仓库 dev 路径;显式临时端口 + 临时 db 路径),
//! 经 HTTP 探测确认在位,断言守卫拒绝与页面可载,然后 kill 子进程。
//!
//! 开启方式(见 apps/desktop-shell/README.md):先在仓库根 `pnpm build`
//! (产出 local-api dist),然后:
//!   RO_SHELL_INTEGRATION=1 cargo test --manifest-path apps/desktop-shell/Cargo.toml -- --ignored
//!
//! 红线对照:壳侧令牌完全不经手(argv 无令牌参数,见 serve_child 单测);
//! 成功判定 = 本文件里的 HTTP 探测,子进程 stdout 只用于端口提示发现。
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use role_orchestrator_desktop_shell::health::{request_status, wait_healthy};
use role_orchestrator_desktop_shell::locate;
use role_orchestrator_desktop_shell::serve_child::ServeChild;

#[test]
#[ignore = "真实集成测试:需 RO_SHELL_INTEGRATION=1 且已构建 packages/local-api/dist(先 pnpm build),见 README"]
fn spawned_serve_child_reaches_local_api_over_loopback() {
    if std::env::var("RO_SHELL_INTEGRATION").as_deref() != Ok("1") {
        println!(
            "跳过:RO_SHELL_INTEGRATION != 1。开启方式:仓库根 pnpm build 后,\
             RO_SHELL_INTEGRATION=1 cargo test --manifest-path apps/desktop-shell/Cargo.toml -- --ignored"
        );
        return;
    }
    // 手工复刻壳的资源定位链(M8-05):走与 main.rs 同一个纯函数
    // locate::resolve_serve_entry——env 覆盖 → exe 同目录捆绑资源 → 仓库 dev
    // 路径。此处的 exe_dir 实参是 CARGO_MANIFEST_DIR(本包目录),并非测试
    // 进程真实的 exe 目录(cargo 的 target/deps,不参与解析):② 分支据此
    // 探测 <包目录>\serve-bundle.mjs——dev 树包根无该文件(入树副本在
    // sidecar/),因此自然落到 ③ 仓库 dev 分支(与壳在 cargo run 下的解析
    // 一致);捆绑分支的优先级与 fail-closed 诊断由 locate 单测钉死,安装
    // 布局的端到端行为归维护者安装态冒烟。env 覆盖(RO_SHELL_SERVE_BIN)在
    // 测试里同样生效,便于指向任意构建产物。
    let serve_bin = match locate::resolve_serve_entry(
        std::env::var("RO_SHELL_SERVE_BIN").ok().as_deref(),
        Some(Path::new(env!("CARGO_MANIFEST_DIR"))),
        |candidate| candidate.exists(),
    ) {
        Ok(path) => path,
        Err(message) => {
            println!("跳过:{message}");
            return;
        }
    };
    let serve_bin = serve_bin.to_string_lossy().to_string();

    // 壳需要已知端口:先绑 0 拿一个此刻确定空闲的端口再释放让给 serve
    // (极小的抢占窗口,测试环境可接受)。
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe port");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    // 临时 db 路径:父目录先建好——serve 按设计拒绝隐式建目录。
    let dir = std::env::temp_dir().join(format!("ro-shell-integration-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let db = dir.join("orchestrator.db");

    let result = (|| -> Result<(), String> {
        // M9-03:集成测试不接 profiles(None)——serve 无 --profiles 时行为与
        // v0.1.1 一致;接线形态由 serve_child 的单测与专用回显格覆盖。
        let mut child = ServeChild::spawn_serve("node", &serve_bin, db.to_string_lossy().as_ref(), port, None)
            .map_err(|error| format!("spawn 失败: {error}"))?;
        // 诊断行发现的端口应等于显式传入端口(端口提示路径的端到端验证)
        let discovered = child
            .wait_for_discovered_port(Duration::from_secs(30))
            .ok_or("serve 未报告监听端口")?;
        assert_eq!(discovered, port, "诊断行端口应等于显式传入端口");
        // HTTP 探测裁决:在位
        assert!(
            wait_healthy(port, Duration::from_secs(30), Duration::from_millis(200)),
            "健康检查未通过"
        );
        // 守卫生效的直接证据:无凭据的 API 请求被拒。现网守卫语义是
        // 403 TOKEN_REQUIRED(guard 管道不用 401;「收到响应即在位」里
        // 的拒绝形态正是这个)。
        assert_eq!(
            request_status(port, "/api/v1/session", Duration::from_secs(5)),
            Some(403),
            "无凭据 API 请求应被守卫拒绝"
        );
        // 页面可载:GET / 200(WebView 窗口将加载的同一回环 URL)
        assert_eq!(
            request_status(port, "/", Duration::from_secs(5)),
            Some(200),
            "回环页面应可加载"
        );
        child.kill().expect("kill serve child");
        let _ = child.wait();
        Ok(())
    })();

    // Windows 下句柄释放可能稍慢,尽力清理
    std::fs::remove_dir_all(&dir).ok();
    result.expect("integration assertions");
}
