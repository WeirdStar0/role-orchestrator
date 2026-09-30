//! 结构性不变式(ADR 待实测第 3 项的静态层 + 「壳不持久化凭据」自查层)。
//!
//! 扫描口径:src/ 下五个源文件的「生产区域」——文件内首个 `#[cfg(test)]`
//! 标记之前的部分(仓库布局约定 tests 模块置尾)。这是结构性金丝雀断言,
//! 不是安全边界:真正的运行时证据是 RO_SHELL_PROBE 真窗探针
//! (examples/capability_probe.rs,M8-03c 文档勘误:原稿误记为
//! tests/capability_probe.rs),布局若偏离「tests 置尾」约定,应以评审
//! 与探针为准。
//!
//! 金丝雀盲区(F 族审查移交,如实自述):本断言按字面标记匹配,类别名
//! 即可绕过——例如 `use tauri::command as hidden_command;` +
//! `#[hidden_command]`,或 `use tauri::invoke_handler as register;` 后
//! `register![…]`,生产区域零字面命中而 IPC 面已非空。故本测试只是对
//! 「无意的/照搬模板的」命令注册与文件写入的绊线,不构成对抗性改写下的
//! 边界;安全结论永远以运行层探针与评审为准。
use std::path::Path;

const SOURCES: [&str; 6] = ["main.rs", "lib.rs", "locate.rs", "serve_child.rs", "health.rs", "url.rs"];

fn production_region(file: &str) -> String {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(file),
    )
    .unwrap_or_else(|error| panic!("读取源码 {file} 失败: {error}"));
    match text.find("#[cfg(test)]") {
        Some(index) => text[..index].to_string(),
        None => text,
    }
}

/// ADR 待实测第 3 项(静态层):壳源码零 IPC command 注册。结构性论证:
/// tauri 页面侧 invoke 只能命中宿主以 `invoke_handler(generate_handler![…])`
/// 注册的 `#[tauri::command]`;生产区域零注册 ⇒ IPC 命令面为空集 ⇒ 页面对
/// 任何命令名的 invoke 都没有可命中目标,必被拒。叠加 capability 空集
/// (零放行规则,见下方构建产物断言),拒绝是双层的;运行时层由探针实证。
#[test]
fn shell_source_registers_no_ipc_commands() {
    for file in SOURCES {
        let region = production_region(file);
        for marker in ["invoke_handler", "generate_handler", "tauri::command"] {
            assert!(
                !region.contains(marker),
                "{file} 生产区域出现 IPC 命令注册标记 {marker:?}——页面侧 IPC 面不再为空,\
                 必须同步修正 ADR 第 3 项证据与本测试"
            );
        }
    }
}

/// 「壳不持久化凭据/配置」的自查层(ADR 集成不变式):生产区域唯一允许的
/// 文件系统动作是 main.rs 的 `std::fs::create_dir_all`——默认 db 路径的
/// 父目录创建;db 文件本身由 serve 子进程创建,壳对任何路径都不写内容、
/// 不落任何配置或凭据。README 安全节据此明示。
#[test]
fn production_source_writes_no_files_beyond_the_default_db_directory() {
    for file in SOURCES {
        let region = production_region(file);
        let mut rest = region.as_str();
        while let Some(index) = rest.find("std::fs::") {
            let call = &rest[index..];
            let is_whitelisted =
                file == "main.rs" && call.starts_with("std::fs::create_dir_all");
            assert!(
                is_whitelisted,
                "{file} 生产区域出现白名单外的文件系统调用(壳不得有任何配置/凭据写入):{:?}",
                call.split(['(', ';', '\n']).next().unwrap_or(call)
            );
            rest = &rest[index + "std::fs::".len()..];
        }
    }
}

/// ADR 待实测第 3 项(构建产物层):tauri-build 把 capabilities 编译为
/// gen/schemas/capabilities.json;占位 capability(windows 列表为空且
/// permissions 为空)生成的每一条 permissions 都必须是空数组。文件由
/// tauri-build 在构建时生成,不存在时(如全新树只跑过 cargo check)
/// 显式跳过并说明。
#[test]
fn generated_capabilities_grant_no_permissions() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("gen")
        .join("schemas")
        .join("capabilities.json");
    if !path.exists() {
        println!(
            "跳过:{} 尚未生成(tauri-build 产物;先跑一次 cargo build / cargo test 即产出)——\
             空授权断言以文件存在为前提",
            path.display()
        );
        return;
    }
    let text = std::fs::read_to_string(&path).expect("read capabilities.json");
    let fields = text.matches("\"permissions\":").count();
    let empty = text.matches("\"permissions\":[]").count();
    assert!(
        fields > 0,
        "capabilities.json 里没有任何 permissions 字段(格式不符合预期): {text}"
    );
    assert_eq!(
        fields, empty,
        "capabilities.json 存在非空 permissions——壳开始对页面授权,\
         capability 全拒证据失效,必须同步 ADR 第 3 项与本测试"
    );
}
