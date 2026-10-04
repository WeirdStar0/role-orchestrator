//! local-api serve 子进程管理(仓库硬红线 + ADR 不变式):
//! - spawn 一律 argv 数组、不开 shell、不经 cmd/bash 拼接;
//! - 令牌完全不经手:argv 里没有任何令牌参数,壳也不读令牌文件——令牌流
//!   保持「local-api 写 per-user 0o600 文件,操作者自行读取粘贴到页面」;
//! - 子进程 stdout 只用于「监听端口」与「令牌文件路径」两个诊断提示字段的
//!   发现(诊断行是壳与 serve 的私有 JSON 契约,路径非秘密;壳只持有路径
//!   供「用系统默认程序打开」——绝不读取该文件内容,令牌内容不经手),
//!   且发现之后仍继续排水到 EOF(防管道塞满阻塞子进程);成功与否永远由
//!   [`crate::health`] 的 HTTP 探测裁决,绝不以 stdout 文本判定。
//! - 进程树不留孤儿(M8-03b):Windows 上 spawn 成功即建 Job Object 并把
//!   direct child 赋入(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),kill() 升级为
//!   Job 树杀——审查实证的「shim 链(direct child → mise → 真实 node)在
//!   kill 只杀 direct child 时幸存、每次测试确定性泄漏孤儿、壳被外部强杀
//!   时 serve 孤儿化、drain 线程因孙进程持有 stdout 写端而阻塞 EOF」全部
//!   由此根治;壳进程自身死亡(含被外部强杀)时内核经 KILL_ON_JOB_CLOSE
//!   兜底终结整树。非 Windows 平台保持既有单进程 kill 行为(红线:Job 只
//!   作用于壳自己 spawn 的子进程,不得影响系统其它进程)。
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// 纯函数:serve 子进程的完整 argv。形态固定且可被单测精确断言(尤其:
/// 不含任何令牌参数);spawn 时以 argv[0] 为程序、其余为参数,无 shell。
///
/// M9-03:`profiles_path = Some(<profiles.json 路径>)` 时追加
/// `--profiles <路径>`——传给 serve 的是「配置文件路径」(壳默认 per-user
/// 约定路径,存在才传,见 main.rs::default_profiles_path),不是令牌,壳
/// 也不读取该文件内容;`None` 时不出现该旗标,serve 侧行为与 v0.1.1 完全
/// 一致(无编排,POST /api/v1/runs 诚实 503)。
pub fn serve_child_argv(
    node_path: &str,
    serve_bin_path: &str,
    db_path: &str,
    port: u16,
    profiles_path: Option<&str>,
) -> Vec<String> {
    let mut argv = vec![
        node_path.to_string(),
        serve_bin_path.to_string(),
        "--db".to_string(),
        db_path.to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    if let Some(profiles) = profiles_path {
        argv.push("--profiles".to_string());
        argv.push(profiles.to_string());
    }
    argv
}

/// Windows Job Object 树杀容器(M8-03b)。约束与安全语义:
/// - Job 只包住壳自己 spawn 的子进程:spawn 成功后立刻创建 Job 并把 direct
///   child 的进程句柄赋入;其后代进程默认继承 Job 成员身份(除非显式
///   CREATE_BREAKAWAY_FROM_JOB——mise/node 不这么做),系统其它进程不受
///   任何影响(红线:Job 不得波及壳自spawn 之外的进程)。
/// - KILL_ON_JOB_CLOSE 是「壳被外部强杀」的兜底:壳进程死亡 → 它持有的
///   Job 句柄被内核随之关闭 → Job 不再有任何句柄 → 内核终止全部成员进程。
///   该路径不依赖壳代码存活,serve 不孤儿化。
/// - HANDLE 生命周期与关闭语义:JobHandle 是 Job 原始 HANDLE 的唯一持有
///   者,随 ServeChild Drop 时 CloseHandle。正常 kill() 路径先用
///   TerminateJobObject 终结全树,之后的句柄关闭只是释放内核对象;而任何
///   更早的句柄关闭(壳崩溃/被强杀/错误路径提前 Drop)都触发同一条
///   KILL_ON_JOB_CLOSE 树杀语义——不存在「句柄关了树还活着」的窗口。
#[cfg(windows)]
mod job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job 句柄守卫:Drop = CloseHandle(见模块文档的关闭语义)。
    pub(super) struct JobHandle(HANDLE);

    /// SAFETY(Send 语义,M8-03c):HANDLE 是进程级内核对象句柄,**非线程
    /// 从属**——TerminateJobObject 与 CloseHandle 的内核语义允许任意线程
    /// 调用,句柄值跨线程移动本身无风险。本标记使 ServeChild(其余字段
    /// 均天然 Send)可放入跨线程共享的 `Arc<Mutex<_>>`,供托盘「退出」
    /// 菜单闭包触达(tauri 菜单事件闭包有 Send+Sync 静态边界;Windows 上
    /// 菜单事件实际在事件循环主线程投递,该标记满足的是静态约束而非真实
    /// 跨线程访问)。共享面只有 kill/kill 内的 wait,互斥由 Mutex 保证。
    unsafe impl Send for JobHandle {}

    impl JobHandle {
        /// 创建 Job(唯一限额 KILL_ON_JOB_CLOSE)并把 child 赋入。任何一步
        /// 失败都原样上抛:树杀不变式建立不起来,spawn_serve 必须 fail
        /// closed 整体报错,绝不在「杀不干净」的状态下放行。
        pub(super) fn create_for(child: &Child) -> io::Result<Self> {
            // SAFETY:以下均为 windows-sys 的 FFI 调用。Job 无名(名字参数
            // 传 null,不进命名对象空间,避免与系统其它 Job 冲突);结构体
            // 参数是本函数内构造的 POD;child 的原始进程句柄由 std 的 Child
            // 持有,存活期覆盖全部调用。
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // 从这里起句柄必须走 Self 的 Drop 关闭(错误路径自动释放)。
                let job = Self(handle);
                // JOBOBJECT_EXTENDED_LIMIT_INFORMATION 是纯 POD:零初始化即
                // 全字段默认;唯一要设的就是 KILL_ON_JOB_CLOSE——不设内存/
                // CPU 限额,不改变子进程的任何运行行为。
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if AssignProcessToJobObject(handle, child.as_raw_handle()) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        /// 树杀:一次性终止 Job 内全部成员(direct child 与所有后代,含
        /// shim/mise/node 链)。尽力而为语义:树已全灭时内核报错,忽略之。
        pub(super) fn terminate_tree(&self) {
            // SAFETY:句柄由 Self 独占持有,CloseHandle 之前始终有效。
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // 关闭 Job 句柄。KILL_ON_JOB_CLOSE 下这一关闭同时是兜底树杀的
            // 触发点(见模块文档);正常路径树已被 terminate_tree 清空,
            // 这里只是释放内核对象。
            // SAFETY:句柄未被复制、未被移出,恰关闭一次。
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub struct ServeChild {
    child: Child,
    /// Windows:Job 句柄守卫(语义见 [`job`] 模块文档)——kill 树杀的执行
    /// 句柄;KILL_ON_JOB_CLOSE 在壳进程死亡(含外部强杀)时兜底杀整树;
    /// 随 ServeChild Drop 关闭。
    #[cfg(windows)]
    job: job::JobHandle,
    /// stdout 诊断行里发现的监听端口(仅端口提示;见模块文档)。
    discovered: Arc<Mutex<Option<u16>>>,
    /// stdout 诊断行里发现的令牌文件**路径**(M9-04:与端口同一 JSON 诊断
    /// 行的 `tokenFile` 字段;仅路径,壳绝不读取该文件内容——打开动作由
    /// 调用侧 main.rs 交给系统默认程序。解析严格见 [`parse_token_file_path`]:
    /// 非绝对路径/超长等恶意形态一律拒绝,保持 None)。
    token_file_path: Arc<Mutex<Option<String>>>,
}

impl ServeChild {
    /// 启动 serve 子进程。stdin 关闭(serve 不读输入);stdout 管道(端口
    /// 发现 + 排水);stderr 继承(诊断直接转发到壳的控制台)。GUI 无控制台
    /// 形态下继承句柄的退化行为在 README unverified 登记(M8-03b 处理)。
    ///
    /// M9-03:`profiles_path` 语义见 [`serve_child_argv`]——Some(路径) 时
    /// argv 追加 `--profiles <路径>`(配置文件路径,非令牌);None 时不传,
    /// serve 无编排、行为与 v0.1.1 一致。
    pub fn spawn_serve(
        node_path: &str,
        serve_bin_path: &str,
        db_path: &str,
        port: u16,
        profiles_path: Option<&str>,
    ) -> std::io::Result<ServeChild> {
        let argv = serve_child_argv(node_path, serve_bin_path, db_path, port, profiles_path);
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // Windows: 不让子进程闪控制台窗。本工具链(std 1.95)的 CommandExt
        // 已无 windows_hide(见交付说明的工具链核对),其底层机制就是
        // CREATE_NO_WINDOW = 0x0800_0000,这里直接用 creation_flags 表达;
        // POSIX 无窗口形态,无需处理。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn()?;
        // Windows:spawn 成功后立刻建 Job 并把 direct child 赋入(树杀容器,
        // 语义见 job 模块文档)。赋 Job 失败 = 树杀不变式无法建立,fail
        // closed:回收刚 spawn 的子进程并整体报错,不放行「杀不干净」的
        // ServeChild。(注:spawn 返回到赋 Job 之间子进程若已自行退出,赋
        // Job 会失败并走此错误路径,子进程本就已死,无泄漏。)
        //
        // E 族(审查移交,注释级——残余窗口如实自述):spawn() 返回到下面
        // AssignProcessToJobObject 之间存在微秒级窗口,direct child 在此
        // 窗口内抢先 spawn 的孙进程不入 Job(后代继承成员身份按「创建时
        // 父进程是否已在 Job 内」判定)。取舍:不引入 CREATE_SUSPENDED 来
        // 消除窗口——std 的 Command 不暴露子进程主线程句柄,resume 需要
        // 额外的线程枚举与句柄管理,复杂度与微秒级窗口不成比例。实测口径:
        // mise shim 场景(direct child 的启动耗时远大于该窗口)在十轮审查
        // 的多轮实证中孤儿=0;下方的孙进程树杀单测覆盖的是赋 Job 之后的
        // 正常继承路径,这个微秒级窗口本身没有(也无法确定性)测试覆盖。
        #[cfg(windows)]
        let job = match job::JobHandle::create_for(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        // spawn 后立即校验存活:瞬间退出的子进程在这里就判失败。
        // (注:子进程如果晚几毫秒才退出,这里看不到——最终由 HTTP 探测
        // 超时兜底,本检查只是尽早失败的第一道。)
        if let Some(status) = child.try_wait()? {
            return Err(std::io::Error::other(format!(
                "serve 子进程立即退出(status: {status})"
            )));
        }
        let discovered = Arc::new(Mutex::new(None));
        let token_file_path = Arc::new(Mutex::new(None));
        if let Some(stdout) = child.stdout.take() {
            let port_slot = Arc::clone(&discovered);
            let token_slot = Arc::clone(&token_file_path);
            thread::spawn(move || drain_and_discover(stdout, port_slot, token_slot));
        }
        Ok(ServeChild {
            child,
            #[cfg(windows)]
            job,
            discovered,
            token_file_path,
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// stdout 诊断发现的监听端口。None = 尚未发现。这只是提示:真实在位
    /// 判定必须走 [`crate::health::wait_healthy`]。
    pub fn discovered_port(&self) -> Option<u16> {
        *self.discovered.lock().expect("discovery slot poisoned")
    }

    /// stdout 诊断发现的令牌文件**路径**(M9-04「打开令牌文件」菜单的取数
    /// 面)。None = serve 未报告(旧版 bundle/诊断行缺失/形态被严格解析
    /// 拒绝)。返回克隆避免持锁;调用侧只允许「把路径交给系统默认程序」,
    /// 绝不允许读取文件内容(硬红线:壳不经手令牌内容)。
    pub fn token_file_path(&self) -> Option<String> {
        self.token_file_path
            .lock()
            .expect("discovery slot poisoned")
            .clone()
    }

    /// 轮询等待端口发现(serve 在 listen 后立即写诊断行),超时返回 None。
    /// 需要可变借用以便在等待中观察到子进程已死并提前放弃。
    pub fn wait_for_discovered_port(&mut self, timeout: Duration) -> Option<u16> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(port) = self.discovered_port() {
                return Some(port);
            }
            if self.try_wait().ok().flatten().is_some() {
                return None; // 子进程已死,不再等待
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.discovered_port()
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.child.wait()
    }

    /// 终止 serve 子进程。Windows:Job 树杀 —— TerminateJobObject 一次性
    /// 终结 Job 全体成员(direct child 及其后代,含 shim 链上的 mise 与
    /// 真实 node),随后 wait 回收 direct child;Job 句柄保留到 Drop,期间
    /// KILL_ON_JOB_CLOSE 兜底持续在线。非 Windows:保持既有路径(仅杀
    /// direct child;POSIX 无 Job 等价物,现有行为是红线要求的不变项)。
    pub fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            self.job.terminate_tree();
            self.child.wait().map(|_| ())
        }
        #[cfg(not(windows))]
        {
            self.child.kill()
        }
    }
}

impl Drop for ServeChild {
    fn drop(&mut self) {
        // 兜底回收:子进程仍活则先杀(kill 内含 wait),不留僵尸;已退出
        // 则只补一次幂等 wait。Windows 上「杀」= Job 树杀,shim 链后代一并
        // 终结;随后 JobHandle 的 Drop 关闭 Job 句柄,KILL_ON_JOB_CLOSE 把
        // 任何残余成员清空。壳退出路径(窗口关闭/健康检查失败)都经过这里
        // 先停 serve 再退出;壳进程本身死亡时由内核兜底(见 job 模块文档)。
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.kill();
        }
        let _ = self.child.wait();
    }
}

/// 逐行读子进程 stdout:发现 listening 诊断行里的端口与令牌文件路径(各自
/// 只取一次),之后继续排水到 EOF——既不阻塞子进程,也保证壳代码除这两个
/// 提示字段外不消费任何 stdout 内容(结构上杜绝「以 stdout 文本判定成功」)。
/// EOF 在树杀后必然到达:Job 里持有 stdout 写端的全部后代一并被终结,排水
/// 线程随之结束(审查实证的 shim 场景排水线程永阻问题已由树杀根治)。
fn drain_and_discover(
    stdout: ChildStdout,
    port_slot: Arc<Mutex<Option<u16>>>,
    token_slot: Arc<Mutex<Option<String>>>,
) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let mut port_guard = port_slot.lock().expect("discovery slot poisoned");
        if port_guard.is_none() {
            *port_guard = parse_listening_port(&line);
        }
        drop(port_guard);
        let mut token_guard = token_slot.lock().expect("discovery slot poisoned");
        if token_guard.is_none() {
            *token_guard = parse_token_file_path(&line);
        }
        drop(token_guard);
    }
}

/// 纯函数:从壳自己约定的诊断行提取 `"port":<十进制数字>`。
/// 只认行首前缀 `{"event":"listening"`;前缀之后第一次出现的 "port": 必然
/// 是端口字段(event/boundAddress 的值都不含该子串,令牌文件路径字段排在
/// port 之后,任何路径内容都无法影响更早的文本)。壳只消费端口与令牌文件
/// 路径(后者见 [`parse_token_file_path`]),不读取其余字段,也不读令牌
/// 文件内容。
pub fn parse_listening_port(line: &str) -> Option<u16> {
    const PREFIX: &str = "{\"event\":\"listening\"";
    const MARKER: &str = "\"port\":";
    let rest = line.trim_start().strip_prefix(PREFIX)?;
    let index = rest.find(MARKER)?;
    let bytes = rest.as_bytes();
    let start = index + MARKER.len();
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == start {
        return None;
    }
    rest[start..end].parse::<u16>().ok()
}

/// 令牌文件路径的防御性长度上限(字节):serve 侧真实产物是
/// `join(tmpdir(), "role-orchestrator-local-api", "session-token-<16hex>.txt")`
/// (server.ts),远低于此值;该上限只为把「超长恶意输入」挡在解析层,不是
/// 业务约束。超长按拒绝处理(而非截断):截断会产生一个指向不存在文件的
/// 假路径,比不捕获更危险。
const MAX_TOKEN_FILE_PATH_LEN: usize = 1024;

/// 纯函数(M9-04):从壳自己约定的诊断行提取 `"tokenFile":"<路径>"`——
/// serve.ts 的 listening 诊断行自 M8-03a 起携带该字段,值是令牌文件**路径**
/// (文件本身 per-user 0o600;路径非秘密,ADR reports/M8-03-desktop-shell-adr.md)。
/// 严格接受形态,任一不满足即静默返回 None(排水继续,端口发现不受影响):
/// - 行首前缀必须是 `{"event":"listening"`(与 [`parse_listening_port`] 同一
///   约定,非诊断行一律忽略);
/// - 前缀之后第一次出现的 `"tokenFile":"` 锚点(event/boundAddress/port 的
///   值都不含该子串)后必须是一个合法 JSON 字符串值:最小转义集(`\"` `\\`
///   `\/` `\b` `\f` `\n` `\r` `\t` `\uXXXX`),非 JSON 转义/裸控制字符/
///   代理对半码(`\uD800` 形态,char::from_u32 为 None)一律拒绝——serve 用
///   JSON.stringify 紧凑输出,Windows 路径的反斜杠以 `\\` 到达,unescape
///   后即真实路径;
/// - unescape 后必须是非空**绝对路径**(相对路径会指到壳 cwd 下的错误位置)
///   且不超过 [`MAX_TOKEN_FILE_PATH_LEN`]。
/// 恶意/失真输入收敛为 None → 调用侧(main.rs)按「尚未生成」提示,绝不
/// panic。壳只持有路径,绝不读取该文件内容(硬红线:令牌内容不经手)。
pub fn parse_token_file_path(line: &str) -> Option<String> {
    const PREFIX: &str = "{\"event\":\"listening\"";
    const MARKER: &str = "\"tokenFile\":\"";
    let rest = line.trim_start().strip_prefix(PREFIX)?;
    let index = rest.find(MARKER)?;
    let mut chars = rest[index + MARKER.len()..].chars();
    let mut value = String::new();
    loop {
        let ch = chars.next()?;
        match ch {
            // 未转义引号 = JSON 字符串终止。
            '"' => break,
            '\\' => {
                let escape = chars.next()?;
                match escape {
                    '"' => value.push('"'),
                    '\\' => value.push('\\'),
                    '/' => value.push('/'),
                    'b' => value.push('\u{0008}'),
                    'f' => value.push('\u{000C}'),
                    'n' => value.push('\n'),
                    'r' => value.push('\r'),
                    't' => value.push('\t'),
                    'u' => {
                        let mut hex = String::new();
                        for _ in 0..4 {
                            hex.push(chars.next()?);
                        }
                        let code = u32::from_str_radix(&hex, 16).ok()?;
                        value.push(char::from_u32(code)?);
                    }
                    // 非 JSON 转义(如 \q)——失真输入,拒绝。
                    _ => return None,
                }
            }
            // JSON 字符串内不允许裸控制字符。
            other if (other as u32) < 0x20 => return None,
            other => value.push(other),
        }
        if value.len() > MAX_TOKEN_FILE_PATH_LEN {
            return None;
        }
    }
    if value.is_empty() || !Path::new(&value).is_absolute() {
        return None;
    }
    Some(value)
}

#[cfg(test)]
// argv 凭据不变式的最后防线说明(口径按审查结论修正):生产代码(即
// #[cfg(test)] 之外的全部源码,含标识符与注释)不得出现凭据参数字样,argv
// 形态由下方单测钉死;补偿性 grep 由 reviewer 限定在非测试代码——测试代码
// 里出现这些英文拼写只是断言用的字符串字面量,计入 grep 会误报,故如实
// 排除,而不是宣称「全 crate 零命中」。
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn argv_is_exactly_node_plus_serve_bin_plus_db_and_port() {
        // None(未接 profiles):形态与 v0.1.1 逐字节一致(6 元素)。
        assert_eq!(
            serve_child_argv("node", "dist/serve-bin.js", "h:/x/o.db", 8123, None),
            vec![
                "node",
                "dist/serve-bin.js",
                "--db",
                "h:/x/o.db",
                "--port",
                "8123"
            ]
        );
    }

    #[test]
    fn argv_appends_the_profiles_path_verbatim_when_wired() {
        // M9-03:Some(路径) 时恰追加 --profiles + 该路径(逐元素无损,
        // 传的是配置文件路径而非任何令牌);None 时该旗标绝不出现。
        let argv = serve_child_argv(
            "node",
            "serve-bundle.mjs",
            "h:/x/o.db",
            0,
            Some("C:/Users/u/AppData/Local/role-orchestrator/profiles.json"),
        );
        assert_eq!(
            argv,
            vec![
                "node".to_string(),
                "serve-bundle.mjs".to_string(),
                "--db".to_string(),
                "h:/x/o.db".to_string(),
                "--port".to_string(),
                "0".to_string(),
                "--profiles".to_string(),
                "C:/Users/u/AppData/Local/role-orchestrator/profiles.json".to_string(),
            ]
        );
        assert_eq!(serve_child_argv("node", "s.js", "x.db", 0, None).len(), 6);
        assert!(!serve_child_argv("node", "s.js", "x.db", 0, None)
            .iter()
            .any(|element| element.contains("profiles")));
    }

    #[test]
    fn argv_never_carries_any_credential_flag() {
        // 凭据不变式在两种接线形态下都成立:profiles 缺省与 profiles 携带
        // (路径是配置文件路径,不含任何凭据词汇)。
        for profiles in [None, Some("C:/u/role-orchestrator/profiles.json")] {
            let argv = serve_child_argv("node", "serve-bin.js", "x.db", 0, profiles);
            for element in &argv {
                let lower = element.to_ascii_lowercase();
                assert!(!lower.contains("credential"), "argv 携带 {element:?}");
                // 令牌相关旗标(--token/--token-file/--auth …)一个都不许出现
                assert!(!lower.contains("auth"), "argv 携带 {element:?}");
            }
            assert!(!argv.iter().any(|element| element.starts_with("--token")));
            // 形态冻结:None=6 元素,Some=8 元素,多一个参数都算契约破坏。
            assert_eq!(argv.len(), if profiles.is_none() { 6 } else { 8 });
        }
    }

    #[test]
    fn parses_the_port_from_the_listening_diagnostic_line_only() {
        assert_eq!(
            parse_listening_port(
                "{\"event\":\"listening\",\"boundAddress\":\"127.0.0.1\",\"port\":8123,\"somePath\":\"C:\\\\x\"}"
            ),
            Some(8123)
        );
        assert_eq!(parse_listening_port("{\"event\":\"listening\",\"port\":0}"), Some(0));
        assert_eq!(parse_listening_port("{\"event\":\"listening\",\"port\":65536}"), None);
        assert_eq!(parse_listening_port("{\"event\":\"listening\",\"port\":-1}"), None);
        assert_eq!(parse_listening_port("{\"event\":\"listening\",\"port\":}"), None);
        assert_eq!(parse_listening_port("{\"event\":\"other\",\"port\":8123}"), None);
        assert_eq!(parse_listening_port("GET / -> 200 (page)"), None);
        // 路径字段里即使出现同名子串,也拿不到首次出现之前的判定权
        assert_eq!(
            parse_listening_port(
                "{\"event\":\"listening\",\"port\":8123,\"somePath\":\"x:\\\\:\\\"port\\\":9\"}"
            ),
            Some(8123)
        );
    }

    #[test]
    fn parses_the_token_file_path_from_the_listening_diagnostic_line() {
        // M9-04:正常形态与 serve.ts 逐字段对齐(event/boundAddress/port/
        // tokenFile,JSON.stringify 紧凑输出;Windows 路径反斜杠以 \\ 到达,
        // unescape 后即真实路径)。
        let line = r#"{"event":"listening","boundAddress":"127.0.0.1","port":8123,"tokenFile":"C:\\Users\\ro\\AppData\\Local\\Temp\\role-orchestrator-local-api\\session-token-deadbeef.txt"}"#;
        assert_eq!(
            parse_token_file_path(line),
            Some(String::from(
                r"C:\Users\ro\AppData\Local\Temp\role-orchestrator-local-api\session-token-deadbeef.txt"
            ))
        );
        // 正斜杠绝对路径同样接受(Path::is_absolute 的 Windows 语义)。
        assert_eq!(
            parse_token_file_path(
                r#"{"event":"listening","port":0,"tokenFile":"C:/x/session-token.txt"}"#
            ),
            Some(String::from("C:/x/session-token.txt"))
        );
        // 同一条诊断行的两个消费面互不干扰:端口解析不受 tokenFile 值影响。
        assert_eq!(parse_listening_port(line), Some(8123));
    }

    #[test]
    fn rejects_malformed_or_malicious_token_file_path_forms() {
        // 非诊断行前缀一律忽略(与端口解析同一约定)。
        assert_eq!(
            parse_token_file_path(r#"{"event":"other","tokenFile":"C:/x.txt"}"#),
            None
        );
        // 诊断行不含 tokenFile 字段(旧版 bundle 形态)→ None。
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","boundAddress":"127.0.0.1","port":1}"#),
            None
        );
        // 值不是字符串(数字/null)→ None(找不到字符串开引号)。
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":123}"#),
            None
        );
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":null}"#),
            None
        );
        // 相对路径 → 拒绝(会静默指到壳 cwd 下的错误位置)。
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":"relative/token.txt"}"#),
            None
        );
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":"./session-token.txt"}"#),
            None
        );
        // 盘符缺省的当前盘根形态(\foo 有 root 但非绝对)同样拒绝。
        assert_eq!(
            parse_token_file_path(
                r#"{"event":"listening","tokenFile":"\\Windows\\not-absolute.txt"}"#
            ),
            None
        );
        // 空字符串值 → None。
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":""}"#),
            None
        );
        // 非 JSON 转义(\q)→ 拒绝(失真输入不做猜测性还原)。
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":"C:\q\bad.txt"}"#),
            None
        );
        // JSON 字符串内的裸控制字符(换行)→ 拒绝。
        assert_eq!(
            parse_token_file_path("{\"event\":\"listening\",\"tokenFile\":\"C:/x\ny.txt\"}"),
            None
        );
        // 代理对半码(\uD800 无配对,char::from_u32 为 None)→ 拒绝。
        // (边界如实披露:serve 真实输出不会对路径做 \u 转义,该拒绝只影响
        // 路径捕获 → 菜单「尚未生成」提示,不影响任何其它行为。)
        assert_eq!(
            parse_token_file_path(
                r#"{"event":"listening","tokenFile":"C:\\ro-\uD800-x.txt"}"#
            ),
            None
        );
        // 字符串未终止(EOF)→ None。
        assert_eq!(
            parse_token_file_path(r#"{"event":"listening","tokenFile":"C:/x.txt"#),
            None
        );
        // 超长路径(> 1024 字节)→ 拒绝而非截断(截断=指向不存在文件的假
        // 路径,比不捕获更危险)。
        let long_path = format!("C:/{}", "x".repeat(MAX_TOKEN_FILE_PATH_LEN));
        let long_line = format!(
            r#"{{"event":"listening","tokenFile":"{long_path}.txt"}}"#
        );
        assert_eq!(parse_token_file_path(&long_line), None);
        // 恰好等于上限的绝对路径放行(上限是防御边界,不是业务约束)。
        let boundary_path = format!("C:/{}", "x".repeat(MAX_TOKEN_FILE_PATH_LEN - 3));
        assert_eq!(boundary_path.len(), MAX_TOKEN_FILE_PATH_LEN);
        let boundary_line =
            format!(r#"{{"event":"listening","tokenFile":"{boundary_path}"}}"#);
        assert_eq!(parse_token_file_path(&boundary_line), Some(boundary_path));
    }

    // ---- 生命周期:假 node 脚本验证 spawn → 发现 → kill → wait ----

    /// 把路径变成可内联进生成脚本的 JS 字符串字面量(最小转义:反斜杠与
    /// 双引号;测试专用路径不含换行等其它控制字符)。
    fn js_string_literal(path: &std::path::Path) -> String {
        let raw = path
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        format!("\"{raw}\"")
    }

    fn write_fake_script(name: &str, body: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("{}-{}.js", name, std::process::id()));
        let mut file = std::fs::File::create(&path).expect("create fake script");
        file.write_all(body).expect("write fake script");
        path
    }

    /// 常驻假 serve 脚本:先打一行壳约定的诊断行(port 1,仅提示语义),再
    /// 定时器常驻直到被杀。泄漏卫生(审查实证:永生 fake 曾让每次 cargo
    /// test 确定性泄漏孤儿):kill 正常路径(Windows Job 树杀/POSIX kill)
    /// 会立即终结进程,这里的 30s 自退只是「kill 因任何原因未生效」时的防
    /// 泄漏兜底,不是正常退出路径,也不参与任何断言(30s 长于全部测试的
    /// 实际运行时长,不会与 kill 竞争)。
    fn write_fake_serve_script(name: &str) -> std::path::PathBuf {
        write_fake_script(
            name,
            br#"console.log('{"event":"listening","boundAddress":"127.0.0.1","port":1}');
setInterval(() => {}, 60000);
setTimeout(() => process.exit(0), 30000);
"#,
        )
    }

    fn spawn_fake_serve(script: &std::path::Path) -> ServeChild {
        ServeChild::spawn_serve(
            "node",
            script.to_str().expect("utf8 script path"),
            "unused.db",
            0,
            None,
        )
        .expect("spawn fake serve")
    }

    /// 进程存在性查询(只读,绝不杀进程):
    /// - Windows:tasklist 按精确 PID 过滤;CSV 行内出现带引号的 pid 字样才
    ///   算存在(无匹配时 tasklist 以 0 退出并打本地化 INFO,退出码不可
    ///   作为判据);
    /// - POSIX:/proc/<pid> 目录存在性。
    fn process_exists(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let output = Command::new("tasklist")
                .args(["/NH", "/FO", "CSV", "/FI", &format!("PID eq {pid}")])
                .output()
                .expect("run tasklist(Windows 系统自带,argv 数组直调)");
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        }
        #[cfg(not(windows))]
        {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }
    }

    /// 轮询直到进程消失。树杀要跨 shim/mise/node 多层,终止有毫秒级延迟;
    /// 超时返回 false 让断言如实失败,绝不静默放过。
    fn wait_until_gone(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !process_exists(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        !process_exists(pid)
    }

    #[test]
    fn spawn_discover_kill_wait_lifecycle_with_a_fake_node_script() {
        let script = write_fake_serve_script("ro-shell-fake-serve");
        let mut child = spawn_fake_serve(&script);
        assert!(child.pid() > 0);
        assert!(child.try_wait().expect("try_wait").is_none(), "刚 spawn 应存活");
        // 假脚本的诊断行被纯解析路径发现(port 1 只是提示,不探测它)
        assert_eq!(child.wait_for_discovered_port(Duration::from_secs(15)), Some(1));
        child.kill().expect("kill");
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "被 kill 的进程不应报告成功");
        std::fs::remove_file(&script).ok();
    }

    #[test]
    fn dropping_the_handle_kills_the_child() {
        let script = write_fake_serve_script("ro-shell-fake-serve-drop");
        let pid = {
            let child = spawn_fake_serve(&script);
            child.pid()
        }; // drop 触发杀树 + 回收
        // 审查 minor 修复:原实现无条件调用 taskkill(既无 cfg(windows),
        // 又以「第二次杀会报错」推断死亡——那是杀,不是存在性证据)。改为
        // 只读的存在性轮询:Drop 后该 pid 必须消失。
        assert!(
            wait_until_gone(pid, Duration::from_secs(15)),
            "pid {pid} 在 Drop 后 15s 仍存活"
        );
        std::fs::remove_file(&script).ok();
    }

    /// 树杀机制性测试(Windows):fake serve 再 spawn 一个孙 node 永生进程,
    /// kill 后断言孙进程也退出——后代默认继承 Job 成员身份,树杀必须覆盖
    /// 整棵链(这正是 shim 链场景:direct child → mise → 真实 node)。POSIX
    /// 无 Job 等价物、保持既有单进程 kill(红线),故本测试限 Windows。
    ///
    /// G 族(审查移交,注释级——判别力前提如实标注):本测试的判别力依赖
    /// 「PATH 上的 node 解析到 mise shim(测试机现状,存在真实多层链)」
    /// 这一前提——此时孙进程的死亡只能由我们的 Job 树杀解释。在 node 直
    /// 解析(无 shim 层)的机器上,libuv 为 node 子进程自建的 kill-on-close
    /// Job 可能在 direct child 死亡时连带终结孙进程,使本测试在我们的 Job
    /// 缺位时也可能绿(假阴性)。换环境复跑时须按此判读:红=确定性缺陷,
    /// 绿≠完备证明(完备证据是 shim 链环境的多轮实证,十轮审查孤儿=0)。
    #[cfg(windows)]
    #[test]
    fn kill_takes_down_the_whole_tree_including_the_grandchild() {
        // 孙 PID 由脚本报出到专用文件:stdout 的消费结构属壳(只取端口),
        // 测试旁路证据走文件,不经过也不污染诊断行语义。先写孙 PID 再打
        // 诊断行——端口被发现时 PID 文件必定就绪(顺序保证)。
        let pid_file = std::env::temp_dir().join(format!(
            "ro-shell-grandchild-{}.pid",
            std::process::id()
        ));
        std::fs::remove_file(&pid_file).ok(); // 清掉上次运行的残留
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(
            br#"const fs = require('node:fs');
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000); setTimeout(() => process.exit(0), 30000);'], { stdio: 'ignore' });
fs.writeFileSync("#,
        );
        body.extend_from_slice(js_string_literal(&pid_file).as_bytes());
        body.extend_from_slice(b", String(grandchild.pid));\n");
        body.extend_from_slice(
            br#"console.log('{"event":"listening","boundAddress":"127.0.0.1","port":1}');
setInterval(() => {}, 60000);
setTimeout(() => process.exit(0), 30000);
"#,
        );
        let script = write_fake_script("ro-shell-fake-tree", &body);
        let mut child = spawn_fake_serve(&script);
        assert_eq!(child.wait_for_discovered_port(Duration::from_secs(15)), Some(1));
        let grandchild_pid: u32 = std::fs::read_to_string(&pid_file)
            .expect("孙 PID 文件应在诊断行之前写出")
            .trim()
            .parse()
            .expect("孙 PID 应为十进制数字");
        assert!(
            process_exists(grandchild_pid),
            "前置失败:孙进程 {grandchild_pid} 应先确实存活"
        );
        child.kill().expect("kill");
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "被 kill 的进程不应报告成功");
        assert!(
            wait_until_gone(grandchild_pid, Duration::from_secs(15)),
            "孙进程 {grandchild_pid} 应随 Job 树杀一并退出"
        );
        std::fs::remove_file(&script).ok();
        std::fs::remove_file(&pid_file).ok();
    }

    /// spawn 机制性测试(审查 minor):库路径含空格与 Windows 元字符,在
    /// 真实临时目录下创建,走 spawn → 诊断行发现 → kill 全生命周期;fake
    /// 脚本把收到的 argv 原样落盘,断言逐元素无损。任何把 argv 拼接成单串
    /// 再交给 shell/自家解析的实现,在这个输入类上必然损毁(& 被当命令分隔、
    /// 空格被拆词、^ 括号 ; = 被转义层吃掉)——只有纯 argv 数组能无损传递。
    #[test]
    fn spawn_transmits_space_and_metachar_db_paths_verbatim_through_argv() {
        let dir = std::env::temp_dir().join(format!(
            "ro shell dir & ^ ({});= argv-contract",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir with metachars");
        let db = dir.join("ro & shell ^ (db);= x.db");
        std::fs::write(&db, b"").expect("create db placeholder");
        let echo_file =
            std::env::temp_dir().join(format!("ro-shell-argv-echo-{}.txt", std::process::id()));
        std::fs::remove_file(&echo_file).ok(); // 清掉上次运行的残留
        let mut body: Vec<u8> = Vec::new();
        // 先把收到的 argv 落盘再打诊断行(端口发现时回显必定就绪);逐元素
        // 一行、无任何转义层——本测试路径不含换行,行切分即无损还原。
        body.extend_from_slice(b"const fs = require('node:fs');\nfs.writeFileSync(");
        body.extend_from_slice(js_string_literal(&echo_file).as_bytes());
        body.extend_from_slice(b", process.argv.slice(2).join('\\n') + '\\n');\n");
        body.extend_from_slice(
            br#"console.log('{"event":"listening","boundAddress":"127.0.0.1","port":1}');
setInterval(() => {}, 60000);
setTimeout(() => process.exit(0), 30000);
"#,
        );
        let script = write_fake_script("ro-shell-fake-argv", &body);
        let mut child = ServeChild::spawn_serve(
            "node",
            script.to_str().expect("utf8 script path"),
            db.to_string_lossy().as_ref(),
            0,
            None,
        )
        .expect("spawn fake serve");
        assert_eq!(child.wait_for_discovered_port(Duration::from_secs(15)), Some(1));
        child.kill().expect("kill");
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "被 kill 的进程不应报告成功");
        let echoed = std::fs::read_to_string(&echo_file).expect("argv 回显文件应存在");
        let received: Vec<String> = echoed
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect();
        assert_eq!(
            received,
            vec![
                "--db".to_string(),
                db.to_string_lossy().to_string(),
                "--port".to_string(),
                "0".to_string()
            ],
            "argv 数组必须逐元素无损(含空格与元字符的路径)"
        );
        std::fs::remove_file(&script).ok();
        std::fs::remove_file(&echo_file).ok();
        std::fs::remove_file(&db).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// M9-03 机制性测试:profiles 路径(含空格与 Windows 元字符)经真实
    /// spawn 逐元素无损到达子进程 argv——Some 时恰为 --db/--port 之后的
    /// `--profiles <路径>` 两元素;与 db 路径同一回显配方,只有纯 argv 数组
    /// 能通过这个输入类。
    #[test]
    fn spawn_transmits_a_metachar_profiles_path_verbatim_through_argv() {
        let dir = std::env::temp_dir().join(format!(
            "ro profiles dir & ^ ({});= argv-contract",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir with metachars");
        let profiles = dir.join("ro & profiles ^ (x);= .json");
        std::fs::write(&profiles, b"{}").expect("create profiles placeholder");
        let echo_file =
            std::env::temp_dir().join(format!("ro-shell-profiles-echo-{}.txt", std::process::id()));
        std::fs::remove_file(&echo_file).ok(); // 清掉上次运行的残留
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(b"const fs = require('node:fs');\nfs.writeFileSync(");
        body.extend_from_slice(js_string_literal(&echo_file).as_bytes());
        body.extend_from_slice(b", process.argv.slice(2).join('\\n') + '\\n');\n");
        body.extend_from_slice(
            br#"console.log('{"event":"listening","boundAddress":"127.0.0.1","port":1}');
setInterval(() => {}, 60000);
setTimeout(() => process.exit(0), 30000);
"#,
        );
        let script = write_fake_script("ro-shell-fake-profiles-argv", &body);
        let mut child = ServeChild::spawn_serve(
            "node",
            script.to_str().expect("utf8 script path"),
            "unused.db",
            0,
            Some(profiles.to_str().expect("utf8 profiles path")),
        )
        .expect("spawn fake serve with profiles");
        assert_eq!(child.wait_for_discovered_port(Duration::from_secs(15)), Some(1));
        child.kill().expect("kill");
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "被 kill 的进程不应报告成功");
        let echoed = std::fs::read_to_string(&echo_file).expect("argv 回显文件应存在");
        let received: Vec<String> = echoed
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect();
        assert_eq!(
            received,
            vec![
                "--db".to_string(),
                "unused.db".to_string(),
                "--port".to_string(),
                "0".to_string(),
                "--profiles".to_string(),
                profiles.to_string_lossy().to_string(),
            ],
            "--profiles 与路径必须逐元素无损(含空格与元字符)"
        );
        std::fs::remove_file(&script).ok();
        std::fs::remove_file(&echo_file).ok();
        std::fs::remove_file(&profiles).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 常驻假 serve 脚本(M9-04,带 tokenFile):诊断行在 port 之后携带绝对
    /// 路径(正斜杠形态,无 JSON 转义需求——反斜杠 unescape 已由纯函数测试
    /// 钉死),其余与 [`write_fake_serve_script`] 相同。
    fn write_fake_serve_script_with_token_file(name: &str) -> std::path::PathBuf {
        write_fake_script(
            name,
            br#"console.log('{"event":"listening","boundAddress":"127.0.0.1","port":1,"tokenFile":"C:/Users/ro-test/session-token-deadbeef.txt"}');
setInterval(() => {}, 60000);
setTimeout(() => process.exit(0), 30000);
"#,
        )
    }

    /// M9-04 机制性测试:真实 spawn → 排水线程从诊断行捕获令牌文件路径。
    /// 壳全程只持路径(断言的是路径字符串本身),绝不触及文件内容。
    #[test]
    fn drain_thread_captures_the_token_file_path_from_a_real_spawn() {
        let script = write_fake_serve_script_with_token_file("ro-shell-fake-serve-token");
        let mut child = spawn_fake_serve(&script);
        assert_eq!(child.wait_for_discovered_port(Duration::from_secs(15)), Some(1));
        assert_eq!(
            child.token_file_path().as_deref(),
            Some("C:/Users/ro-test/session-token-deadbeef.txt")
        );
        child.kill().expect("kill");
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "被 kill 的进程不应报告成功");
        std::fs::remove_file(&script).ok();
    }

    #[test]
    fn drain_thread_leaves_the_token_file_path_none_without_the_field() {
        // 既有 fake serve(诊断行无 tokenFile 字段,旧版 bundle 形态):路径
        // 保持 None → 菜单点击走「尚未生成」提示(fail-safe),端口发现
        // 不受影响。
        let script = write_fake_serve_script("ro-shell-fake-serve-no-token");
        let mut child = spawn_fake_serve(&script);
        assert_eq!(child.wait_for_discovered_port(Duration::from_secs(15)), Some(1));
        assert_eq!(child.token_file_path(), None);
        child.kill().expect("kill");
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "被 kill 的进程不应报告成功");
        std::fs::remove_file(&script).ok();
    }
}
