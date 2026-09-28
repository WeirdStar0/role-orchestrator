//! Tauri build script: compiles the resources (icon embedding, ACL/capability
//! validation, tauri.conf.json codegen inputs) required by
//! `tauri::generate_context!` in src/main.rs.
fn main() {
    tauri_build::build()
}
