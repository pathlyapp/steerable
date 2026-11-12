use crate::python_runner::{self, PythonRunnerLock, RunnerSetup};
use crate::DesktopConfig;
use command_group::{CommandGroup, GroupChild};
#[cfg(unix)]
use command_group::{Signal, UnixChildExt};
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use url::Url;

const READY_PREFIX: &str = "STEERABLE_HOST_READY ";
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize)]
struct ReadyRecord {
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductRuntime {
    python_runner: Option<String>,
}

fn write_diag(dir: &Path, name: &str, body: &str) {
    let _ = std::fs::write(dir.join(name), body);
}

fn remember_line(recent: &Mutex<Vec<String>>, line: &str) {
    let Ok(mut lines) = recent.lock() else {
        return;
    };
    if lines.len() == 40 {
        lines.remove(0);
    }
    lines.push(line.to_string());
}

fn format_host_exit(reason: &str, recent: &Mutex<Vec<String>>) -> String {
    let detail = recent.lock().ok().and_then(|lines| {
        lines
            .iter()
            .rev()
            .find(|line| {
                line.contains("failed to start")
                    || line.contains("StoreAlreadyOwnedError")
                    || line.contains("storage upgrade blocked")
                    || line.contains("web build not found")
            })
            .cloned()
    });
    match detail {
        Some(line) => format!("{reason}: {line}"),
        None => reason.to_string(),
    }
}

fn append_diag(dir: &Path, name: &str, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
    {
        let _ = writeln!(file, "{line}");
    }
}

pub struct HostProcess {
    child: Mutex<Option<GroupChild>>,
}

impl HostProcess {
    pub fn spawn(app: &AppHandle, config: &DesktopConfig) -> Result<(Self, Url), String> {
        match Self::spawn_inner(app, config) {
            Ok(started) => Ok(started),
            Err(error) => {
                if let Some(dir) = env::var_os("DEEPPATH_USER_DATA_DIR") {
                    let dir = PathBuf::from(dir);
                    let _ = std::fs::create_dir_all(&dir);
                    write_diag(&dir, "host-error.txt", &error);
                }
                Err(error)
            }
        }
    }

    fn spawn_inner(app: &AppHandle, config: &DesktopConfig) -> Result<(Self, Url), String> {
        let paths = HostPaths::resolve(app, config)?;
        let user_data = match env::var_os("DEEPPATH_USER_DATA_DIR") {
            Some(path) => PathBuf::from(path),
            None => app
                .path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join(&config.data_dir_name),
        };
        std::fs::create_dir_all(&user_data).map_err(|error| error.to_string())?;
        let sidecar_tmp = user_data.join("sidecar/tmp");
        std::fs::create_dir_all(&sidecar_tmp).map_err(|error| error.to_string())?;
        let python_runner = paths.resolve_python_runner(app, config, &user_data);
        if let Err(error) = &python_runner {
            eprintln!("[python-runner] {error}; run_code will be unavailable");
            app.dialog()
                .message(format!(
                    "Python 运行器安装失败，run_code 本次不可用。\n\n{error}"
                ))
                .title("Python 运行器")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
        write_diag(
            &user_data,
            "host-spawn.txt",
            &format!(
                "node={}\nserver={}\napp_root={}\nweb_dist={}\n",
                paths.node.display(),
                paths.server_entry.display(),
                paths.app_root.display(),
                paths.web_dist.display()
            ),
        );

        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.server_entry)
            .current_dir(&paths.app_root)
            .env("APP_FLAVOR", &config.product_id)
            .env("VITE_APP_FLAVOR", &config.product_id)
            .env("DEEPPATH_BS_HOST", "127.0.0.1")
            .env("DEEPPATH_BS_PORT", "0")
            .env("DEEPPATH_WEB_DIST", &paths.web_dist)
            .env("DEEPPATH_USER_DATA_DIR", &user_data)
            .env("TMPDIR", &sidecar_tmp)
            .env("TMP", &sidecar_tmp)
            .env("TEMP", &sidecar_tmp)
            .env("STEERABLE_HOST_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let python_path = python_runner
            .as_ref()
            .ok()
            .and_then(|runner| runner.as_deref())
            .map(Path::to_path_buf);
        paths.apply_runtime_env(&mut command, python_path.clone());

        let mut child = spawn_group(&mut command).map_err(|error| {
            format!(
                "failed to start Node host with {}: {error}",
                paths.node.display()
            )
        })?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| "Node host stdout was not piped".to_string())?;
        let stderr = child
            .inner()
            .stderr
            .take()
            .ok_or_else(|| "Node host stderr was not piped".to_string())?;

        let (ready_tx, ready_rx) = mpsc::channel();
        let (stderr_done_tx, stderr_done_rx) = mpsc::channel();
        let recent = Arc::new(Mutex::new(Vec::<String>::new()));
        let stdout_dir = user_data.clone();
        let stdout_recent = Arc::clone(&recent);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        println!("[node-host] {line}");
                        remember_line(&stdout_recent, &line);
                        append_diag(&stdout_dir, "host-node.log", &line);
                        if let Some(record) = line.strip_prefix(READY_PREFIX) {
                            let parsed = serde_json::from_str::<ReadyRecord>(record)
                                .map_err(|error| error.to_string());
                            let _ = ready_tx.send(parsed);
                        }
                    }
                    Err(error) => {
                        append_diag(
                            &stdout_dir,
                            "host-node.log",
                            &format!("stdout error: {error}"),
                        );
                        let _ = ready_tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        let stderr_dir = user_data.clone();
        let stderr_recent = Arc::clone(&recent);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[node-host] {line}");
                remember_line(&stderr_recent, &line);
                append_diag(&stderr_dir, "host-node.log", &line);
            }
            let _ = stderr_done_tx.send(());
        });

        let started = Instant::now();
        let ready = loop {
            match ready_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = stderr_done_rx.recv_timeout(Duration::from_millis(500));
                    let _ = child.kill();
                    return Err(format_host_exit(
                        "Node host exited before reporting readiness",
                        &recent,
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                let _ = stderr_done_rx.recv_timeout(Duration::from_millis(500));
                return Err(format_host_exit(
                    &format!("Node host exited before reporting readiness: {status}"),
                    &recent,
                ));
            }
            if started.elapsed() >= START_TIMEOUT {
                let _ = child.kill();
                return Err(format_host_exit(
                    "Node host did not become ready within 30 seconds",
                    &recent,
                ));
            }
        };
        write_diag(
            &user_data,
            "host-ready.json",
            &serde_json::to_string(&ready).map_err(|error| error.to_string())?,
        );
        write_diag(
            &user_data,
            "host-runtime.json",
            &host_runtime_document(
                &paths.web_dist,
                paths.sidecar_python.as_deref(),
                python_path.as_deref(),
                paths.engine_dir.as_deref(),
            ),
        );
        let url = Url::parse(&format!("http://{}:{}/", ready.host, ready.port))
            .map_err(|error| error.to_string())?;
        Ok((
            Self {
                child: Mutex::new(Some(child)),
            },
            url,
        ))
    }

    pub fn stop(&self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = child.take() {
            #[cfg(unix)]
            {
                let _ = child.signal(Signal::SIGTERM);
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct HostPaths {
    node: PathBuf,
    server_entry: PathBuf,
    app_root: PathBuf,
    web_dist: PathBuf,
    engine_dir: Option<PathBuf>,
    sidecar_python: Option<PathBuf>,
}

impl HostPaths {
    fn apply_runtime_env(&self, command: &mut Command, python_runner: Option<PathBuf>) {
        if let Some(sidecar_python) = &self.sidecar_python {
            command.env("STEERABLE_SIDECAR_PYTHON", sidecar_python);
        }
        if let Some(engine_dir) = &self.engine_dir {
            let egress_proxy = engine_dir.join(platform_binary("steerable-egress-proxy"));
            if egress_proxy.exists() {
                command.env("STEERABLE_EGRESS_PROXY_BIN", egress_proxy);
            }
            let win_spawn_helper = engine_dir.join("win-spawn-helper/win-spawn-helper.exe");
            if win_spawn_helper.exists() {
                command.env("DEEPPATH_WIN_SPAWN_HELPER", win_spawn_helper);
            }
        }
        if let Some(python_runner) = python_runner {
            command.env("STEERABLE_PYTHON", python_runner);
        }
    }

    fn resolve_python_runner(
        &self,
        app: &AppHandle,
        config: &DesktopConfig,
        user_data: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if let Some(explicit) = env::var_os("STEERABLE_PYTHON") {
            let explicit = PathBuf::from(explicit);
            if explicit.is_absolute() && explicit.is_file() {
                python_runner::configure(
                    app,
                    RunnerSetup {
                        user_data: user_data.to_path_buf(),
                        node: self.node.clone(),
                        engine_dir: self.engine_dir.clone(),
                        lock: None,
                        target_name: platform_tag().into(),
                        supported: false,
                        active_runner: Some(explicit.clone()),
                    },
                );
                return Ok(Some(explicit));
            }
            return Err("STEERABLE_PYTHON must name an existing absolute file".into());
        }
        let Some(engine_dir) = &self.engine_dir else {
            return Ok(None);
        };
        let product: ProductRuntime = serde_json::from_str(
            &std::fs::read_to_string(
                self.app_root
                    .join("products")
                    .join(&config.product_id)
                    .join("product.json"),
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let Some(python_runner_mode) = product.python_runner.as_deref() else {
            return Ok(None);
        };
        if python_runner_mode == "sidecar" {
            let runner = self
                .sidecar_python
                .clone()
                .ok_or_else(|| "packaged Python sidecar runtime is missing".to_string())?;
            python_runner::configure(
                app,
                RunnerSetup {
                    user_data: user_data.to_path_buf(),
                    node: self.node.clone(),
                    engine_dir: self.engine_dir.clone(),
                    lock: None,
                    target_name: platform_tag().into(),
                    supported: false,
                    active_runner: Some(runner.clone()),
                },
            );
            return Ok(Some(runner));
        }
        let lock: PythonRunnerLock = serde_json::from_str(
            &std::fs::read_to_string(engine_dir.join("python-runner-lock.json"))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let target_name = platform_tag();
        let target = lock
            .targets
            .get(target_name)
            .ok_or_else(|| format!("Python runner does not support {target_name}"))?;

        let active_runner = if python_runner_mode == "bundle" {
            let runner = engine_dir.join("python-runner").join(&target.runner);
            runner
                .is_file()
                .then_some(runner)
                .ok_or_else(|| "bundled Python runner is missing".to_string())?
        } else if python_runner_mode == "download" {
            python_runner::configured_runner(user_data)
                .or_else(|| python_runner::default_runner(user_data, &lock, target_name, target))
                .unwrap_or_default()
        } else {
            return Err(format!(
                "unsupported pythonRunner mode {python_runner_mode:?}"
            ));
        };
        let active_runner = (!active_runner.as_os_str().is_empty()).then_some(active_runner);
        python_runner::configure(
            app,
            RunnerSetup {
                user_data: user_data.to_path_buf(),
                node: self.node.clone(),
                engine_dir: self.engine_dir.clone(),
                lock: Some(lock),
                target_name: target_name.into(),
                supported: python_runner_mode == "download",
                active_runner: active_runner.clone(),
            },
        );
        Ok(active_runner)
    }

    fn resolve(app: &AppHandle, config: &DesktopConfig) -> Result<Self, String> {
        if cfg!(debug_assertions) {
            let app_root = config.development_root.clone();
            return Ok(Self {
                node: env::var_os("DEEPPATH_TAURI_NODE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("node")),
                server_entry: env::var_os("DEEPPATH_TAURI_SERVER_ENTRY")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| app_root.join("dist/devtools/dev-server.js")),
                web_dist: env::var_os("DEEPPATH_WEB_DIST")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        app_root
                            .join("products")
                            .join(&config.product_id)
                            .join("web/dist")
                    }),
                app_root,
                engine_dir: None,
                sidecar_python: env::var_os("STEERABLE_SIDECAR_PYTHON").map(PathBuf::from),
            });
        }

        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let resource_dir = node_compatible_path(&resource_dir);
        let host_root = resource_dir.join("node-host");
        let app_root = host_root.join("app-dist");
        let python_name = if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        };
        let python_root = resource_dir.join("python-runtime").join(platform_tag());
        let sidecar_python = [
            python_root.join("python").join(python_name),
            python_root.join("python/bin").join(python_name),
            python_root.join(python_name),
            python_root.join("bin").join(python_name),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            format!(
                "packaged Python sidecar runtime is missing under {}",
                python_root.display()
            )
        })?;
        Ok(Self {
            node: env::var_os("DEEPPATH_TAURI_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| resource_dir.join(node_resource_name())),
            server_entry: app_root
                .join("products")
                .join(&config.product_id)
                .join("server.js"),
            web_dist: host_root.join("web-dist"),
            app_root,
            engine_dir: Some(resource_dir.join("engine")),
            sidecar_python: Some(sidecar_python),
        })
    }
}

fn host_runtime_document(
    web_dist: &Path,
    sidecar_python: Option<&Path>,
    python: Option<&Path>,
    engine_dir: Option<&Path>,
) -> String {
    let mut doc = serde_json::Map::new();
    doc.insert(
        "webDist".to_string(),
        serde_json::Value::String(web_dist.display().to_string()),
    );
    if let Some(path) = sidecar_python.filter(|path| path.is_file()) {
        doc.insert(
            "sidecarPython".to_string(),
            serde_json::Value::String(path.display().to_string()),
        );
    }
    if let Some(path) = python.filter(|path| path.is_file()) {
        doc.insert(
            "python".to_string(),
            serde_json::Value::String(path.display().to_string()),
        );
    }
    if let Some(engine_dir) = engine_dir {
        let egress = engine_dir.join(platform_binary("steerable-egress-proxy"));
        if egress.is_file() {
            doc.insert(
                "egressProxyBin".to_string(),
                serde_json::Value::String(egress.display().to_string()),
            );
        }
        let helper = engine_dir.join("win-spawn-helper/win-spawn-helper.exe");
        if helper.is_file() {
            doc.insert(
                "winSpawnHelper".to_string(),
                serde_json::Value::String(helper.display().to_string()),
            );
        }
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(doc))
        .unwrap_or_else(|_| "{}".to_string())
}

fn platform_binary(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn platform_tag() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else {
        "unsupported"
    }
}

fn node_resource_name() -> &'static str {
    if cfg!(windows) {
        "engine/node.exe"
    } else {
        "node/node"
    }
}

fn node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        let verbatim_unc = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
        if let Some(rest) = wide.strip_prefix(verbatim_unc.as_slice()) {
            let mut normalized = r"\\".encode_utf16().collect::<Vec<_>>();
            normalized.extend_from_slice(rest);
            return PathBuf::from(OsString::from_wide(&normalized));
        }
        let verbatim = r"\\?\".encode_utf16().collect::<Vec<_>>();
        if let Some(rest) = wide.strip_prefix(verbatim.as_slice()) {
            return PathBuf::from(OsString::from_wide(rest));
        }
    }
    path.to_path_buf()
}

fn spawn_group(command: &mut Command) -> std::io::Result<GroupChild> {
    #[cfg(windows)]
    {
        // node.exe is a console-subsystem binary. Hide it once this host is a
        // GUI app, or Windows opens a second console at launch.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        return command
            .group()
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        command.group_spawn()
    }
}

#[cfg(test)]
mod tests {
    use super::host_runtime_document;

    #[test]
    fn host_runtime_document_records_files_that_exist() {
        let dir = std::env::temp_dir().join(format!(
            "host-runtime-doc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let python = dir.join("python");
        std::fs::write(&python, "").unwrap();
        let missing = dir.join("missing-python");
        let json = host_runtime_document(
            &dir.join("web"),
            Some(python.as_path()),
            Some(missing.as_path()),
            None,
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["webDist"], dir.join("web").display().to_string());
        assert_eq!(value["sidecarPython"], python.display().to_string());
        assert!(value.get("python").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
