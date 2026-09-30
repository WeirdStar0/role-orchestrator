//! M8-05 资源定位链(纯函数,输入→候选→裁决全部显式,可单测):
//! 解析 serve 入口与 node 可执行文件,优先级恒为
//! ① 环境变量覆盖(RO_SHELL_SERVE_BIN / RO_SHELL_NODE,逐字采信)
//! ② exe 同目录捆绑资源(安装布局:NSIS resources 落在安装目录)
//! ③ 仓库 dev 布局(cargo run 的 cwd = apps/desktop-shell)。
//!
//! fail-closed 语义(维持 M8-03a 现状,不因捆绑布局放宽):
//! - ②③ 分支以「路径存在」为采信条件,三者皆不可用 = Err(诊断列出已尝试
//!   的全部候选),由 run() 打印诊断、非零码退出、不建窗;
//! - 环境变量覆盖仍逐字采信、不做存在性预检(与既有行为一致):调用侧的
//!   最终存在性核查/run 期 spawn 失败兜底——覆盖值指错了地方必须原样暴露,
//!   不能被静默回退到别的候选吞掉;
//! - env 覆盖值为空/全空白 = 配置错误,显式 Err(指名变量),不按未设置处理
//!   (空串路径若流入下游只会产生失真的诊断);
//! - node 的 ③ PATH 分支不做存在性预检:PATH 解析是 spawn 时 OS 的职责,
//!   预检需要自行扫描 PATH 目录(可移植性差且引入双源真相),spawn 失败
//!   已是既有的 fail-closed 出口。
//!
//! 只读约束:本模块零文件系统写入面(存在性探测用 Path::exists,无任何
//! std::fs 命名空间调用),被 tests/source_invariants.rs 的文件系统白名单
//! 扫描覆盖(SOURCES 含本文件)。
use std::path::{Path, PathBuf};

/// 安装布局下 exe 同目录的单文件 serve bundle(M8-05 任务 1 产物;
/// ESM 而非 cjs 的偏离披露见 PROPOSALS 2026-09-30 节)。
pub const BUNDLED_SERVE_FILE: &str = "serve-bundle.mjs";
/// 安装布局下 exe 同目录的便携 node(node-runtime/node.exe,
/// scripts/fetch-node-runtime.mjs 产物,经 NSIS resources 捆入安装目录)。
pub const BUNDLED_NODE_SUBPATH: &str = "node-runtime";
pub const BUNDLED_NODE_FILE: &str = "node.exe";
/// dev 布局:cargo run 的 cwd = apps/desktop-shell → monorepo 内的 serve bin。
pub const DEV_SERVE_PATH: &str = "../../packages/local-api/dist/serve-bin.js";
/// dev/兜底:走 PATH 的 node(RO_SHELL_NODE 未设且无捆绑 node 时)。
pub const PATH_NODE: &str = "node";

/// 环境变量覆盖的三态归一:`Err(诊断)` = 已设置但为空(配置错误);
/// `Ok(None)` = 未设置(走回退分支);`Ok(Some(value))` = 逐字采信。
fn classify_env(var_value: Option<&str>, var_name: &str) -> Result<Option<String>, String> {
    match var_value {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Err(format!(
            "环境变量 {var_name} 已设置但为空——视为配置错误,请删除该变量或给出有效路径"
        )),
        Some(value) => Ok(Some(value.to_string())),
    }
}

/// serve 入口解析(① env → ② exe 同目录 bundle → ③ 仓库 dev 路径)。
/// `exists` 注入以保持纯函数可测;调用侧传 `|p| p.exists()`。
pub fn resolve_serve_entry(
    env_override: Option<&str>,
    exe_dir: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    if let Some(value) = classify_env(env_override, "RO_SHELL_SERVE_BIN")? {
        return Ok(PathBuf::from(value));
    }
    let mut tried: Vec<String> = Vec::new();
    if let Some(dir) = exe_dir {
        let bundled = dir.join(BUNDLED_SERVE_FILE);
        if exists(&bundled) {
            return Ok(bundled);
        }
        tried.push(bundled.display().to_string());
    }
    let dev = PathBuf::from(DEV_SERVE_PATH);
    if exists(&dev) {
        return Ok(dev);
    }
    tried.push(dev.display().to_string());
    Err(format!(
        "serve 入口不存在(已尝试:{})——先在仓库根运行 \
         pnpm build && pnpm --filter @role-orchestrator/local-api run bundle:serve,\
         或用 RO_SHELL_SERVE_BIN 指定",
        tried.join("; ")
    ))
}

/// node 可执行文件解析(① env → ② exe 同目录 node-runtime/node.exe →
/// ③ PATH 上的 "node")。③ 不做存在性预检(见模块文档)。
pub fn resolve_node(
    env_override: Option<&str>,
    exe_dir: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    if let Some(value) = classify_env(env_override, "RO_SHELL_NODE")? {
        return Ok(PathBuf::from(value));
    }
    if let Some(dir) = exe_dir {
        let bundled = dir.join(BUNDLED_NODE_SUBPATH).join(BUNDLED_NODE_FILE);
        if exists(&bundled) {
            return Ok(bundled);
        }
    }
    Ok(PathBuf::from(PATH_NODE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 存在性探针:集合内的路径视为存在(测试里不碰真实文件系统)。
    fn existing<'a>(set: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |candidate: &Path| set.iter().any(|s| Path::new(s) == candidate)
    }

    fn exe_dir_with(suffix: &str) -> PathBuf {
        PathBuf::from("H:/install").join(suffix)
    }

    #[test]
    fn env_override_wins_over_everything_and_is_taken_verbatim() {
        // 覆盖值逐字采信(哪怕指向不存在的路径也不回退——调用侧核查兜底)。
        let resolved = resolve_serve_entry(
            Some("H:/custom/serve.mjs"),
            Some(&exe_dir_with("")),
            existing(&["H:/install/serve-bundle.mjs", DEV_SERVE_PATH]),
        )
        .expect("env override");
        assert_eq!(resolved, PathBuf::from("H:/custom/serve.mjs"));

        let node = resolve_node(
            Some("H:/custom/node.exe"),
            Some(&exe_dir_with("")),
            existing(&["H:/install/node-runtime/node.exe"]),
        )
        .expect("env override");
        assert_eq!(node, PathBuf::from("H:/custom/node.exe"));
    }

    #[test]
    fn empty_env_override_is_a_config_error_not_a_fallback() {
        // 空串/空白不是「未设置」:显式失败并指名变量(与「删掉变量」区分)。
        for value in ["", "   "] {
            let error = resolve_serve_entry(Some(value), None, existing(&[DEV_SERVE_PATH]))
                .expect_err("empty override must fail");
            assert!(error.contains("RO_SHELL_SERVE_BIN"), "{error}");
            assert!(error.contains("为空"), "{error}");

            let error = resolve_node(Some(value), None, existing(&[])).expect_err("empty override");
            assert!(error.contains("RO_SHELL_NODE"), "{error}");
        }
    }

    #[test]
    fn bundled_serve_resource_beats_the_dev_layout() {
        // 安装布局:exe 同目录 bundle 存在 → 优先于仓库相对路径。
        let resolved = resolve_serve_entry(
            None,
            Some(&exe_dir_with("")),
            existing(&["H:/install/serve-bundle.mjs", DEV_SERVE_PATH]),
        )
        .expect("bundled");
        assert_eq!(resolved, PathBuf::from("H:/install/serve-bundle.mjs"));
    }

    #[test]
    fn dev_layout_is_used_when_nothing_is_bundled() {
        // dev 布局(cargo run):exe 目录无 bundle → 仓库相对路径。
        let resolved = resolve_serve_entry(None, Some(&exe_dir_with("")), existing(&[DEV_SERVE_PATH]))
            .expect("dev layout");
        assert_eq!(resolved, PathBuf::from(DEV_SERVE_PATH));
    }

    #[test]
    fn missing_everything_is_fail_closed_with_all_candidates_in_the_diagnostic() {
        // ②③ 皆不存在:Err,诊断同时列出捆绑候选与 dev 候选(不建窗语义
        // 的输入面);env 未设置时才走到这里。
        let error = resolve_serve_entry(None, Some(&exe_dir_with("")), existing(&[]))
            .expect_err("nothing exists");
        assert!(error.contains("serve 入口不存在"), "{error}");
        assert!(error.contains("serve-bundle.mjs"), "{error}");
        assert!(error.contains(DEV_SERVE_PATH), "{error}");
        assert!(error.contains("RO_SHELL_SERVE_BIN"), "{error}");
    }

    #[test]
    fn no_exe_dir_skips_the_bundled_branch_entirely() {
        // exe 目录未知(current_exe 失败的退化形态):跳过 ②,③ 仍可用。
        let resolved = resolve_serve_entry(None, None, existing(&[DEV_SERVE_PATH])).expect("dev only");
        assert_eq!(resolved, PathBuf::from(DEV_SERVE_PATH));
        let error = resolve_serve_entry(None, None, existing(&[])).expect_err("nothing exists");
        assert!(!error.contains("serve-bundle.mjs"), "{error}");
    }

    #[test]
    fn bundled_node_beats_path_node() {
        let resolved = resolve_node(
            None,
            Some(&exe_dir_with("")),
            existing(&["H:/install/node-runtime/node.exe"]),
        )
        .expect("bundled node");
        assert_eq!(resolved, PathBuf::from("H:/install/node-runtime/node.exe"));
    }

    #[test]
    fn node_falls_through_to_path_when_no_bundled_runtime() {
        // ② 不存在 → ③ "node"(PATH;不做存在性预检,见模块文档)。
        let resolved =
            resolve_node(None, Some(&exe_dir_with("")), existing(&[])).expect("path node");
        assert_eq!(resolved, PathBuf::from(PATH_NODE));
        assert_eq!(resolved, PathBuf::from("node"));
    }

    #[test]
    fn node_without_exe_dir_goes_straight_to_path() {
        let resolved = resolve_node(None, None, existing(&[])).expect("path node");
        assert_eq!(resolved, PathBuf::from("node"));
    }
}
