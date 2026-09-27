mod commands;
mod host;
mod python_runner;
mod update;

use commands::{
    host_capture_screenshot, host_read_clipboard_text, host_save_text_file, host_select_directory,
};
use host::HostProcess;
use python_runner::{
    python_runner_cancel, python_runner_download, python_runner_pick_local, python_runner_restart,
    python_runner_snapshot, python_runner_use_default, python_runner_use_local,
};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use update::{app_release_check, app_release_install, app_release_snapshot};

/// Product values required by the reusable desktop host.
pub struct DesktopConfig {
    pub product_id: String,
    pub product_name: String,
    pub data_dir_name: String,
    pub development_root: PathBuf,
}

impl DesktopConfig {
    pub fn new(
        product_id: impl Into<String>,
        product_name: impl Into<String>,
        data_dir_name: impl Into<String>,
        development_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            product_id: product_id.into(),
            product_name: product_name.into(),
            data_dir_name: data_dir_name.into(),
            development_root: development_root.into(),
        }
    }
}

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let new_chat = MenuItemBuilder::with_id("new-chat", "新建对话")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_terminal = MenuItemBuilder::with_id("open-terminal", "打开终端")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("app-quit", "退出")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "文件")
        .item(&new_chat)
        .separator()
        .close_window()
        .separator()
        .item(&quit)
        .build()?;
    // Predefined Paste delivers an empty clipboard into WKWebView. Own the
    // shortcut and read the pasteboard from the host process instead.
    let paste = MenuItemBuilder::with_id("edit-paste", "粘贴")
        .accelerator("CmdOrCtrl+V")
        .build(app)?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .item(&paste)
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "视图")
        .item(&open_terminal)
        .separator()
        .fullscreen()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().0.as_str() {
        "new-chat" => {
            let _ = app.emit("menu:new-chat", ());
        }
        "open-terminal" => {
            let _ = app.emit("menu:open-terminal", ());
        }
        "edit-paste" => {
            let _ = app.emit("menu:paste", ());
        }
        "app-quit" => app.exit(0),
        _ => {}
    });
    Ok(())
}

static REVEAL_WHEN_READY: AtomicBool = AtomicBool::new(false);
static INSTANCE_PING: AtomicBool = AtomicBool::new(false);

/// Shows the running desktop window.
///
/// Closing the macOS window hides it. `set_focus` then does nothing until
/// `show` has run on the main thread, so the activation is posted again
/// after that show.
fn reveal_main_window(app: &tauri::AppHandle) {
    if app.get_webview_window("main").is_none() {
        REVEAL_WHEN_READY.store(true, Ordering::SeqCst);
        return;
    }
    focus_main_window(app);
    let later = app.clone();
    let _ = app.run_on_main_thread(move || focus_main_window(&later));
}

fn focus_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn is_database_in_use(error: &str) -> bool {
    error.contains("StoreAlreadyOwnedError") || error.contains("store already owned")
}

fn database_in_use_message(product_name: &str) -> String {
    format!(
        "再打开一次{product_name}时，会回到已经打开的窗口。\n\n\
         这次没有回到那个窗口，是因为本地数据库正被另一个进程占用。\
         如果终端里还在跑 pnpm dev:bs，先在那个终端按 Ctrl+C 停掉，再重新打开{product_name}。\n\n\
         重新启动后的开发服务会使用单独的数据目录，之后可以和桌面版同时开。"
    )
}

/// Asks an already running desktop app to reveal its window.
///
/// A ping that this process receives itself means the database is held by
/// something other than a second copy of the app.
fn wake_other_desktop_app(app: &tauri::AppHandle) -> bool {
    #[cfg(unix)]
    {
        INSTANCE_PING.store(false, Ordering::SeqCst);
        if ping_single_instance(&app.config().identifier).is_err() {
            return false;
        }
        for _ in 0..10 {
            if INSTANCE_PING.load(Ordering::SeqCst) {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        true
    }
    #[cfg(not(unix))]
    {
        let _ = app;
        false
    }
}

#[cfg(unix)]
fn ping_single_instance(identifier: &str) -> std::io::Result<()> {
    let socket = PathBuf::from(format!(
        "/tmp/{}_si.sock",
        identifier.replace(['.', '-'], "_")
    ));
    let mut stream = std::os::unix::net::UnixStream::connect(socket)?;
    stream.set_write_timeout(Some(Duration::from_millis(200)))?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let args = std::env::args().collect::<Vec<_>>().join("\0");
    stream.write_all(cwd.to_string_lossy().as_bytes())?;
    stream.write_all(b"\0\0")?;
    stream.write_all(args.as_bytes())?;
    stream.flush()?;
    Ok(())
}

/// Runs a Tauri desktop shell around the shared Node HostRuntime.
pub fn run(context: tauri::Context<tauri::Wry>, config: DesktopConfig) {
    let product_name = config.product_name.clone();
    let builder = tauri::Builder::default()
        .manage(update::UpdateState::default())
        .manage(python_runner::PythonRunnerState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            INSTANCE_PING.store(true, Ordering::SeqCst);
            reveal_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            host_select_directory,
            host_save_text_file,
            host_capture_screenshot,
            host_read_clipboard_text,
            app_release_snapshot,
            app_release_check,
            app_release_install,
            python_runner_snapshot,
            python_runner_download,
            python_runner_cancel,
            python_runner_pick_local,
            python_runner_use_local,
            python_runner_use_default,
            python_runner_restart
        ])
        .setup(move |app| {
            install_menu(app)?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                let (host, url) = match HostProcess::spawn(&handle, &config) {
                    Ok(started) => started,
                    Err(error) => {
                        if is_database_in_use(&error) && wake_other_desktop_app(&handle) {
                            handle.exit(0);
                            return;
                        }
                        let database_in_use = is_database_in_use(&error);
                        let message = if database_in_use {
                            database_in_use_message(&config.product_name)
                        } else {
                            error
                        };
                        let exit_handle = handle.clone();
                        handle
                            .dialog()
                            .message(message)
                            .title(if database_in_use {
                                format!("{} 无法再开一个", config.product_name)
                            } else {
                                format!("{} 无法启动", config.product_name)
                            })
                            .kind(if database_in_use {
                                MessageDialogKind::Warning
                            } else {
                                MessageDialogKind::Error
                            })
                            .show(move |_| exit_handle.exit(1));
                        return;
                    }
                };
                handle.manage(host);
                let allowed_origin = url.origin().ascii_serialization();
                if let Err(error) =
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title(&config.product_name)
                        .inner_size(1200.0, 800.0)
                        .min_inner_size(900.0, 650.0)
                        .on_navigation(move |url| {
                            url.origin().ascii_serialization() == allowed_origin
                        })
                        .build()
                {
                    let exit_handle = handle.clone();
                    handle
                        .dialog()
                        .message(error.to_string())
                        .title(format!("{} 无法启动", config.product_name))
                        .kind(MessageDialogKind::Error)
                        .show(move |_| exit_handle.exit(1));
                    return;
                }
                if REVEAL_WHEN_READY.swap(false, Ordering::SeqCst) {
                    focus_main_window(&handle);
                }
                python_runner::maybe_prompt(&handle);
                update::start(&handle);
            });
            Ok(())
        });

    let app = builder
        .build(context)
        .unwrap_or_else(|error| panic!("failed to build {product_name} desktop host: {error}"));
    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } => {
            if let Some(host) = app.try_state::<HostProcess>() {
                host.stop();
            }
            app.state::<update::UpdateState>().install_pending();
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && cfg!(target_os = "macos") => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } if label == "main" && !cfg!(target_os = "macos") => {
            app.exit(0);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => reveal_main_window(app),
        _ => {}
    });
}
