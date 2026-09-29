//! 「local-api 在位」的健康检查:唯一裁决手段是对 127.0.0.1:<port> 的
//! HTTP 探测<b>收到响应</b>(仓库硬红线:绝不以子进程 stdout 文本判定成功)。
//! 任何合法状态行都算在位——包括 401/403,守卫管道正常拒绝未授权请求恰恰
//! 证明服务在位;连接被拒、读写超时或读到非 HTTP 字节 = 未就绪。
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const LOOPBACK: [u8; 4] = [127, 0, 0, 1];

/// 对 port 的 path 发一次最小手写 GET(Host 恰为 127.0.0.1:<port>),
/// 返回响应状态行里的状态码。None = 未就绪(连不上 / 超时 / 非 HTTP 响应)。
pub fn request_status(port: u16, path: &str, timeout: Duration) -> Option<u16> {
    let addr = SocketAddr::from((LOOPBACK, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    // 状态行必然在首包前几十字节内;读到首个换行为止
    let mut buf = [0u8; 128];
    let mut total = 0usize;
    while total < buf.len() {
        match stream.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if buf[..total].contains(&b'\n') {
                    break;
                }
            }
            Err(_) => return None, // 超时或中断:未就绪
        }
    }
    let line_end = buf[..total]
        .iter()
        .position(|&b| b == b'\r' || b == b'\n')
        .unwrap_or(total);
    status_code(std::str::from_utf8(&buf[..line_end]).ok()?)
}

/// GET / 的在位判定:收到任何合法状态行即在位(状态码不限)。
pub fn probe_once(port: u16, timeout: Duration) -> bool {
    request_status(port, "/", timeout).is_some()
}

/// 存活约束下的轮询:每轮探测前先调 `liveness`(壳传入 serve 子进程的存活
/// 断言),返回 false 即提供者已死——立即失败、不再触网、不等满超时。
/// 动机(审查 minor):serve 在 listen 后崩溃时,壳必须秒级失败,而不是把
/// 崩溃伪装成整段超时。
pub fn wait_healthy_with_liveness<F>(
    port: u16,
    timeout: Duration,
    interval: Duration,
    mut liveness: F,
) -> bool
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        if !liveness() {
            return false;
        }
        if probe_once(port, timeout.min(Duration::from_secs(1))) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(interval);
    }
}

/// 无存活约束的便利形式(单测的纯端口轮询路径);壳的真实布线走
/// [`wait_healthy_with_liveness`]。
pub fn wait_healthy(port: u16, timeout: Duration, interval: Duration) -> bool {
    wait_healthy_with_liveness(port, timeout, interval, || true)
}

/// 纯函数:状态行合法性与状态码提取。"HTTP/1.1 401 Unauthorized" → Some(401)。
pub fn status_code(line: &str) -> Option<u16> {
    let mut parts = line.split_ascii_whitespace();
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    let code = parts.next()?;
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    code.parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    // 注:下方测试直接调用 stream 的 read/write_all 而无需自行引入 trait——
    // 文件顶部的 `use std::io::{Read, Write};` 经 `use super::*` 重导入了
    // 本模块;方法解析仍要求 trait 在作用域内,与工具链演进无关(审查
    // minor:原注释把这一点错记成 std 演进行为)。
    use std::net::TcpListener;

    #[test]
    fn parses_any_legal_status_line_including_guard_refusals() {
        assert_eq!(status_code("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(status_code("HTTP/1.1 401 Unauthorized"), Some(401));
        assert_eq!(status_code("HTTP/1.0 403 Forbidden"), Some(403));
        assert_eq!(status_code("HTTP/1.1 501 Not Implemented"), Some(501));
        assert_eq!(status_code("NOT-HTTP 200 OK"), None);
        assert_eq!(status_code("HTTP/1.1 abc"), None);
        assert_eq!(status_code("HTTP/1.1 40"), None);
        assert_eq!(status_code("HTTP/1.1"), None);
        assert_eq!(status_code(""), None);
    }

    #[test]
    fn a_guard_refusal_counts_as_in_position() {
        // 回环假服务:accept 后回答 401(守卫拒绝形态)——在位判定为真。
        // 恰好答两次:第一次喂给 wait_healthy 的探测,第二次喂给下面的
        // request_status(每次探测都是独立的真实连接)。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut sink = [0u8; 512];
                    let _ = stream.read(&mut sink); // 收完请求再答
                    let _ =
                        stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
                }
            }
        });
        assert!(wait_healthy(port, Duration::from_secs(5), Duration::from_millis(50)));
        assert_eq!(request_status(port, "/", Duration::from_secs(2)), Some(401));
        server.join().expect("server thread");
    }

    #[test]
    fn a_dead_provider_fails_the_wait_immediately_not_at_timeout() {
        // liveness=false 快速失败(组件级):名义超时 5s,存活断言先行且
        // 返回 false——不得触网、不得等满超时,毫秒级返回 false。这正是
        // 「serve 在 listen 后崩溃时壳秒级失败」的机制(审查 minor)。
        let started = Instant::now();
        assert!(!wait_healthy_with_liveness(
            1, // 任意端口:存活断言先于任何探测,该端口不应被触碰
            Duration::from_secs(5),
            Duration::from_millis(50),
            || false
        ));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "存活断言失败应立即返回,实际耗时 {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn an_idle_port_fails_within_the_short_timeout() {
        // 纯端口轮询超时(存活恒真的便利形式):先绑定拿一个此刻确定空闲的
        // 端口再释放(存在极小的被抢占窗口)
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        assert!(!wait_healthy(
            port,
            Duration::from_millis(400),
            Duration::from_millis(100)
        ));
        assert_eq!(request_status(port, "/", Duration::from_millis(300)), None);
    }
}
