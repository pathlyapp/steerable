use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const EVENT: &str = "python-runner-state";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PythonRunnerLock {
    pub(crate) version: String,
    pub(crate) python_version: String,
    pub(crate) python_build_standalone_release: String,
    pub(crate) targets: HashMap<String, PythonRunnerTarget>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct PythonRunnerTarget {
    pub(crate) triple: String,
    pub(crate) sha256: String,
    pub(crate) runner: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerConfig {
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<PathBuf>,
    runner: PathBuf,
}

#[derive(Clone)]
struct RunnerContext {
    user_data: PathBuf,
    node: PathBuf,
    engine_dir: PathBuf,
    lock: PythonRunnerLock,
    target_name: String,
    target: PythonRunnerTarget,
    supported: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRunnerSnapshot {
    supported: bool,
    source: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configured_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_runner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configured_runner: Option<String>,
    restart_required: bool,
}

struct Tracked {
    source: String,
    phase: String,
    percent: Option<u8>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<String>,
    configured_url: Option<String>,
    active_runner: Option<PathBuf>,
    configured_runner: Option<PathBuf>,
}

impl Default for Tracked {
    fn default() -> Self {
        Self {
            source: "default".into(),
            phase: "idle".into(),
            percent: None,
            downloaded_bytes: None,
            total_bytes: None,
            message: None,
            configured_url: None,
            active_runner: None,
            configured_runner: None,
        }
    }
}

pub struct PythonRunnerState {
    context: Mutex<Option<RunnerContext>>,
    tracked: Mutex<Tracked>,
    cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    gate: tokio::sync::Mutex<()>,
}

pub(crate) struct RunnerSetup {
    pub(crate) user_data: PathBuf,
    pub(crate) node: PathBuf,
    pub(crate) engine_dir: Option<PathBuf>,
    pub(crate) lock: Option<PythonRunnerLock>,
    pub(crate) target_name: String,
    pub(crate) supported: bool,
    pub(crate) active_runner: Option<PathBuf>,
}

impl Default for PythonRunnerState {
    fn default() -> Self {
        Self {
            context: Mutex::new(None),
            tracked: Mutex::new(Tracked::default()),
            cancel: Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
        }
    }
}

fn config_path(user_data: &Path) -> PathBuf {
    user_data.join("python-runner/config.json")
}

fn read_config(user_data: &Path) -> Option<RunnerConfig> {
    let bytes = std::fs::read(config_path(user_data)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_config(user_data: &Path, config: &RunnerConfig) -> Result<(), String> {
    let path = config_path(user_data);
    let parent = path
        .parent()
        .ok_or_else(|| "Python runner config has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

fn default_url(context: &RunnerContext) -> String {
    let filename = format!(
        "cpython-{}+{}-{}-install_only_stripped.tar.gz",
        context.lock.python_version,
        context.lock.python_build_standalone_release,
        context.target.triple
    );
    format!(
        "https://github.com/astral-sh/python-build-standalone/releases/download/{}/{}",
        context.lock.python_build_standalone_release, filename
    )
}

fn default_destination(context: &RunnerContext) -> PathBuf {
    context
        .user_data
        .join("python-runner")
        .join(&context.lock.version)
        .join(&context.target_name)
}

fn custom_destination(context: &RunnerContext, url: &str) -> PathBuf {
    let digest = Sha256::digest(url.as_bytes());
    context.user_data.join("python-runner").join(format!(
        "custom-{}",
        hex::encode(digest).chars().take(12).collect::<String>()
    ))
}

fn runner_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn snapshot(app: &AppHandle) -> PythonRunnerSnapshot {
    let state = app.state::<PythonRunnerState>();
    let context = state.context.lock().ok().and_then(|value| value.clone());
    let tracked = state.tracked.lock().ok();
    let (source, phase, percent, downloaded, total, message, configured_url, active, configured) =
        if let Some(tracked) = tracked.as_ref() {
            (
                tracked.source.clone(),
                tracked.phase.clone(),
                tracked.percent,
                tracked.downloaded_bytes,
                tracked.total_bytes,
                tracked.message.clone(),
                tracked.configured_url.clone(),
                tracked.active_runner.clone(),
                tracked.configured_runner.clone(),
            )
        } else {
            (
                "default".into(),
                "error".into(),
                None,
                None,
                None,
                Some("Python runner state is unavailable".into()),
                None,
                None,
                None,
            )
        };
    PythonRunnerSnapshot {
        supported: context.as_ref().is_some_and(|value| value.supported),
        source,
        phase,
        percent,
        downloaded_bytes: downloaded,
        total_bytes: total,
        message,
        default_url: context.as_ref().map(default_url),
        configured_url,
        active_runner: active.as_deref().map(runner_string),
        configured_runner: configured.as_deref().map(runner_string),
        restart_required: active != configured,
    }
}

fn publish(app: &AppHandle) {
    let _ = app.emit(EVENT, snapshot(app));
}

pub(crate) fn configure(app: &AppHandle, setup: RunnerSetup) {
    let state = app.state::<PythonRunnerState>();
    let config = read_config(&setup.user_data);
    let valid_config = config.filter(|value| value.runner.is_absolute() && value.runner.is_file());
    if let (Some(engine_dir), Some(lock)) = (setup.engine_dir, setup.lock) {
        if let Some(target) = lock.targets.get(&setup.target_name).cloned() {
            if let Ok(mut context) = state.context.lock() {
                *context = Some(RunnerContext {
                    user_data: setup.user_data,
                    node: setup.node,
                    engine_dir,
                    lock,
                    target_name: setup.target_name,
                    target,
                    supported: setup.supported,
                });
            }
        }
    }
    if let Ok(mut tracked) = state.tracked.lock() {
        tracked.source = valid_config
            .as_ref()
            .map(|value| value.source.clone())
            .unwrap_or_else(|| "default".into());
        tracked.configured_url = valid_config.as_ref().and_then(|value| value.url.clone());
        tracked.configured_runner = valid_config
            .as_ref()
            .map(|value| value.runner.clone())
            .or_else(|| setup.active_runner.clone());
        tracked.active_runner = setup.active_runner;
    };
}

pub(crate) fn configured_runner(user_data: &Path) -> Option<PathBuf> {
    let config = read_config(user_data)?;
    (config.runner.is_absolute() && config.runner.is_file()).then_some(config.runner)
}

pub(crate) fn default_runner(
    user_data: &Path,
    lock: &PythonRunnerLock,
    target_name: &str,
    target: &PythonRunnerTarget,
) -> Option<PathBuf> {
    let runner = user_data
        .join("python-runner")
        .join(&lock.version)
        .join(target_name)
        .join(&target.runner);
    runner.is_file().then_some(runner)
}

fn set_phase(
    app: &AppHandle,
    phase: &str,
    percent: Option<u8>,
    downloaded: Option<u64>,
    total: Option<u64>,
    message: Option<String>,
) {
    if let Ok(mut tracked) = app.state::<PythonRunnerState>().tracked.lock() {
        tracked.phase = phase.into();
        tracked.percent = percent;
        tracked.downloaded_bytes = downloaded;
        tracked.total_bytes = total;
        tracked.message = message;
    }
    publish(app);
}

fn clip_message(message: impl Into<String>) -> String {
    let message = message.into();
    let mut chars = message.chars();
    let clipped = chars.by_ref().take(180).collect::<String>();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

fn next_download_percent(downloaded: u64, total: Option<u64>, previous: u8) -> Option<u8> {
    let total = total.filter(|value| *value > 0)?;
    let percent = ((downloaded.saturating_mul(100) / total).min(100)) as u8;
    (percent == 100 || percent >= previous.saturating_add(5)).then_some(percent)
}

async fn install(app: AppHandle, custom_url: Option<String>) -> PythonRunnerSnapshot {
    let state = app.state::<PythonRunnerState>();
    let _gate = state.gate.lock().await;
    let context = state.context.lock().ok().and_then(|value| value.clone());
    let Some(context) = context.filter(|value| value.supported) else {
        set_phase(
            &app,
            "error",
            None,
            None,
            None,
            Some("当前产品不支持下载 Python 运行器".into()),
        );
        return snapshot(&app);
    };
    let custom_url = custom_url
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let url = custom_url.clone().unwrap_or_else(|| default_url(&context));
    if !url.starts_with("https://") && !url.starts_with("http://") {
        set_phase(
            &app,
            "error",
            None,
            None,
            None,
            Some("下载地址必须以 http:// 或 https:// 开头".into()),
        );
        return snapshot(&app);
    }
    let is_custom = custom_url.is_some();
    let destination = if is_custom {
        custom_destination(&context, &url)
    } else {
        default_destination(&context)
    };
    let runner = destination.join(&context.target.runner);
    set_phase(&app, "downloading", Some(0), Some(0), None, None);
    let installer = context.engine_dir.join("install-python-runner.mjs");
    let mut command = Command::new(&context.node);
    command
        .arg(installer)
        .args(["--url", &url, "--destination"])
        .arg(&destination)
        .args(["--runner", &context.target.runner, "--progress", "true"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    if !is_custom {
        command.args(["--sha256", &context.target.sha256]);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            set_phase(
                &app,
                "error",
                None,
                None,
                None,
                Some(clip_message(error.to_string())),
            );
            return snapshot(&app);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    if let Ok(mut cancel) = state.cancel.lock() {
        *cancel = Some(cancel_tx);
    }
    let mut lines = stdout.map(|value| BufReader::new(value).lines());
    let mut downloaded = 0;
    let mut total = None;
    let mut last_percent: u8 = 0;
    let status = loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                terminate_download(&mut child).await;
                break None;
            }
            result = child.wait() => break result.ok(),
            line = async {
                match lines.as_mut() {
                    Some(lines) => lines.next_line().await,
                    None => Ok(None),
                }
            }, if lines.is_some() => {
                match line {
                    Ok(Some(line)) => {
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                            continue;
                        };
                        match value.get("type").and_then(|item| item.as_str()) {
                            Some("progress") => {
                                downloaded = value.get("downloaded").and_then(|item| item.as_u64()).unwrap_or(downloaded);
                                total = value.get("total").and_then(|item| item.as_u64()).or(total);
                                let percent = next_download_percent(downloaded, total, last_percent);
                                if total.is_none() || percent.is_some() {
                                    if let Some(percent) = percent {
                                        last_percent = percent;
                                    }
                                    set_phase(&app, "downloading", percent, Some(downloaded), total, None);
                                }
                            }
                            Some("phase") => {
                                let phase = value.get("phase").and_then(|item| item.as_str()).unwrap_or("downloading");
                                set_phase(&app, phase, None, Some(downloaded), total, None);
                            }
                            _ => {}
                        }
                    }
                    Ok(None) => lines = None,
                    Err(error) => {
                        eprintln!("[python-runner] progress stream failed: {error}");
                        lines = None;
                    }
                }
            }
        }
    };
    if let Ok(mut cancel) = state.cancel.lock() {
        *cancel = None;
    }
    let success = status.is_some_and(|value| value.success()) && runner.is_file();
    if !success {
        let message = if status.is_none() {
            "下载已取消".into()
        } else {
            let stderr = match stderr {
                Some(stderr) => {
                    let mut reader = BufReader::new(stderr);
                    let mut value = String::new();
                    let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut value).await;
                    value
                }
                None => String::new(),
            };
            clip_message(if stderr.trim().is_empty() {
                format!("Python runner installer exited with {status:?}")
            } else {
                stderr
            })
        };
        set_phase(
            &app,
            if status.is_none() { "idle" } else { "error" },
            None,
            None,
            None,
            Some(message),
        );
        return snapshot(&app);
    }
    let config = RunnerConfig {
        source: if is_custom {
            "url".into()
        } else {
            "default".into()
        },
        url: is_custom.then_some(url),
        path: None,
        runner: runner.clone(),
    };
    if let Err(error) = write_config(&context.user_data, &config) {
        set_phase(&app, "error", None, None, None, Some(clip_message(error)));
        return snapshot(&app);
    }
    let restart_required = if let Ok(mut tracked) = state.tracked.lock() {
        let restart_required = tracked.active_runner.as_ref() != Some(&runner);
        tracked.source = config.source;
        tracked.configured_url = config.url;
        tracked.configured_runner = Some(runner);
        restart_required
    } else {
        true
    };
    set_phase(
        &app,
        "ready",
        None,
        Some(downloaded),
        total,
        Some(if restart_required {
            "安装完成，重启应用后即可使用 run_code。".into()
        } else {
            "Python 运行器已就绪。".into()
        }),
    );
    snapshot(&app)
}

async fn terminate_download(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{pid}")])
                .status()
                .await;
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
                .await;
        }
    }
    let _ = child.kill().await;
}

#[tauri::command]
pub fn python_runner_snapshot(app: AppHandle) -> PythonRunnerSnapshot {
    snapshot(&app)
}

#[tauri::command]
pub async fn python_runner_download(app: AppHandle, url: Option<String>) -> PythonRunnerSnapshot {
    install(app, url).await
}

#[tauri::command]
pub fn python_runner_cancel(app: AppHandle) -> PythonRunnerSnapshot {
    if let Ok(mut cancel) = app.state::<PythonRunnerState>().cancel.lock() {
        if let Some(cancel) = cancel.take() {
            let _ = cancel.send(());
        }
    }
    snapshot(&app)
}

#[tauri::command]
pub fn python_runner_pick_local(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("选择 Python 可执行文件")
        .blocking_pick_file()
        .and_then(|value| value.into_path().ok())
        .map(|value| runner_string(&value))
}

async fn validate_local(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("Python path must be an existing absolute file".into());
    }
    let mut command = Command::new(path);
    command.args([
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ]);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Selected Python could not be started".into());
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version.trim().split('.');
    let major = parts.next().and_then(|value| value.parse::<u8>().ok());
    let minor = parts.next().and_then(|value| value.parse::<u8>().ok());
    if !matches!((major, minor), (Some(3), Some(9..=u8::MAX))) {
        return Err(format!(
            "Python 3.9 or newer is required; found {}",
            version.trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn python_runner_use_local(app: AppHandle, path: String) -> PythonRunnerSnapshot {
    let path = PathBuf::from(path);
    if let Err(error) = validate_local(&path).await {
        set_phase(&app, "error", None, None, None, Some(clip_message(error)));
        return snapshot(&app);
    }
    let context = app
        .state::<PythonRunnerState>()
        .context
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let Some(context) = context else {
        set_phase(
            &app,
            "error",
            None,
            None,
            None,
            Some("Python 运行器不可用".into()),
        );
        return snapshot(&app);
    };
    let config = RunnerConfig {
        source: "local".into(),
        url: None,
        path: Some(path.clone()),
        runner: path.clone(),
    };
    if let Err(error) = write_config(&context.user_data, &config) {
        set_phase(&app, "error", None, None, None, Some(clip_message(error)));
        return snapshot(&app);
    }
    let restart_required = if let Ok(mut tracked) = app.state::<PythonRunnerState>().tracked.lock()
    {
        let restart_required = tracked.active_runner.as_ref() != Some(&path);
        tracked.source = "local".into();
        tracked.configured_url = None;
        tracked.configured_runner = Some(path);
        restart_required
    } else {
        true
    };
    set_phase(
        &app,
        "ready",
        None,
        None,
        None,
        Some(if restart_required {
            "配置已保存，重启应用后即可使用 run_code。".into()
        } else {
            "当前会话已在使用这个 Python 运行器。".into()
        }),
    );
    snapshot(&app)
}

#[tauri::command]
pub fn python_runner_use_default(app: AppHandle) -> PythonRunnerSnapshot {
    let state = app.state::<PythonRunnerState>();
    let context = state.context.lock().ok().and_then(|value| value.clone());
    let Some(context) = context else {
        return snapshot(&app);
    };
    let runner = default_destination(&context).join(&context.target.runner);
    if runner.is_file() {
        let config = RunnerConfig {
            source: "default".into(),
            url: None,
            path: None,
            runner: runner.clone(),
        };
        if write_config(&context.user_data, &config).is_ok() {
            if let Ok(mut tracked) = state.tracked.lock() {
                let restart_required = tracked.active_runner.as_ref() != Some(&runner);
                tracked.source = "default".into();
                tracked.configured_url = None;
                tracked.configured_runner = Some(runner);
                tracked.phase = "ready".into();
                tracked.message = Some(if restart_required {
                    "配置已保存，重启应用后即可使用 run_code。".into()
                } else {
                    "当前会话已在使用默认 Python 运行器。".into()
                });
            }
        }
    }
    publish(&app);
    snapshot(&app)
}

#[tauri::command]
pub fn python_runner_restart(app: AppHandle) {
    app.request_restart();
}

pub fn maybe_prompt(app: &AppHandle) {
    let current = snapshot(app);
    if !current.supported
        || current.configured_runner.is_some()
        || std::env::var_os("CI").is_some()
        || std::env::var("DEEPPATH_PYTHON_RUNNER").ok().as_deref() == Some("skip")
    {
        return;
    }
    let app_for_download = app.clone();
    app.dialog()
        .message(
            "Aroli 可以在后台下载独立的 Python 运行器来启用 run_code。\n\n\
             下载期间不影响聊天和其他功能，安装完成后重启应用即可使用。",
        )
        .title("安装 Python 代码运行器")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "后台下载".to_string(),
            "稍后".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                tauri::async_runtime::spawn(async move {
                    install(app_for_download, None).await;
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_download_directories_are_stable_and_distinct() {
        let context = RunnerContext {
            user_data: PathBuf::from("/tmp/data"),
            node: PathBuf::new(),
            engine_dir: PathBuf::new(),
            lock: PythonRunnerLock {
                version: "1".into(),
                python_version: "3.12".into(),
                python_build_standalone_release: "20260901".into(),
                targets: HashMap::new(),
            },
            target_name: "test".into(),
            target: PythonRunnerTarget {
                triple: "test".into(),
                sha256: String::new(),
                runner: "python/bin/python3".into(),
            },
            supported: true,
        };
        assert_eq!(
            custom_destination(&context, "https://example.com/a"),
            custom_destination(&context, "https://example.com/a")
        );
        assert_ne!(
            custom_destination(&context, "https://example.com/a"),
            custom_destination(&context, "https://example.com/b")
        );
    }

    #[test]
    fn reports_download_percent_in_five_percent_steps() {
        assert_eq!(next_download_percent(4, Some(100), 0), None);
        assert_eq!(next_download_percent(5, Some(100), 0), Some(5));
        assert_eq!(next_download_percent(9, Some(100), 5), None);
        assert_eq!(next_download_percent(100, Some(100), 96), Some(100));
        assert_eq!(next_download_percent(10, None, 0), None);
    }

    #[test]
    fn configured_runner_requires_an_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "steerable-python-runner-test-{}",
            std::process::id()
        ));
        let runner = root.join("python3");
        std::fs::create_dir_all(&root).unwrap();
        let config = RunnerConfig {
            source: "local".into(),
            url: None,
            path: Some(runner.clone()),
            runner: runner.clone(),
        };
        write_config(&root, &config).unwrap();
        assert_eq!(configured_runner(&root), None);
        std::fs::write(&runner, b"python").unwrap();
        assert_eq!(configured_runner(&root), Some(runner));
        std::fs::remove_dir_all(root).unwrap();
    }
}
