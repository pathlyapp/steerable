//! Minimal Steerable desktop host.
//!
//! Everything a product has to write: four values and one call. The window,
//! menus, single-instance behaviour, clipboard bridge, updater and the Node
//! host supervision all live in `steerable_agent_shell_tauri`.
//!
//! Replace the four values below to brand the build; nothing else changes. To
//! ship it, see this example's README for bundling the runtime and signing.

use std::path::Path;
use steerable_agent_shell_tauri::DesktopConfig;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The product root is the directory the Node host runs from. A packaged
    // build resolves it from the bundle; during development it is the
    // repository that contains `src-tauri`.
    let development_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must be inside the product directory");

    let config = DesktopConfig::new(
        option_env!("STEERABLE_PRODUCT_ID").unwrap_or("example"),
        option_env!("STEERABLE_PRODUCT_NAME").unwrap_or("Steerable Example"),
        option_env!("STEERABLE_DATA_DIR_NAME").unwrap_or(".steerable-example"),
        development_root,
    );
    steerable_agent_shell_tauri::run(tauri::generate_context!(), config);
}
