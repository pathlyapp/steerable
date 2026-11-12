//! Window zoom for the desktop webview.
//!
//! Steps run from 80% to 200% by 10%. A stored value outside that range, or a
//! value that is not a number, becomes 100%. A requested step clamps instead.

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const MIN_ZOOM: f64 = 0.8;
pub const MAX_ZOOM: f64 = 2.0;
pub const ZOOM_STEP: f64 = 0.1;
pub const DEFAULT_ZOOM: f64 = 1.0;

#[derive(Clone, serde::Serialize)]
struct ZoomChanged {
    scale: f64,
}

pub struct ZoomMenuItems {
    pub file: Submenu<Wry>,
    pub new_chat: MenuItem<Wry>,
    pub quit: MenuItem<Wry>,
    pub edit: Submenu<Wry>,
    pub paste: MenuItem<Wry>,
    pub zoom_in: MenuItem<Wry>,
    pub zoom_in_plus: MenuItem<Wry>,
    pub zoom_out: MenuItem<Wry>,
    pub zoom_reset: MenuItem<Wry>,
    pub view: Submenu<Wry>,
    pub open_terminal: MenuItem<Wry>,
}

pub struct ZoomControls {
    path: PathBuf,
    scale: Mutex<f64>,
    menu: ZoomMenuItems,
}

pub struct ZoomMenuLabels {
    pub file: &'static str,
    pub new_chat: &'static str,
    pub quit: &'static str,
    pub edit: &'static str,
    pub paste: &'static str,
    pub view: &'static str,
    pub zoom_in: &'static str,
    pub zoom_out: &'static str,
    pub zoom_reset: &'static str,
    pub open_terminal: &'static str,
}

/// App-menu labels for the page locale. Both zoom-in rows share one label.
/// Undo, cut, and the other predefined items stay with the operating system.
pub fn zoom_menu_labels(locale: &str) -> ZoomMenuLabels {
    let normalized = locale.trim().to_lowercase().replace('_', "-");
    if normalized == "zh" || normalized.starts_with("zh-") {
        ZoomMenuLabels {
            file: "文件",
            new_chat: "新建对话",
            quit: "退出",
            edit: "编辑",
            paste: "粘贴",
            view: "视图",
            zoom_in: "放大",
            zoom_out: "缩小",
            zoom_reset: "实际大小",
            open_terminal: "打开终端",
        }
    } else {
        ZoomMenuLabels {
            file: "File",
            new_chat: "New chat",
            quit: "Quit",
            edit: "Edit",
            paste: "Paste",
            view: "View",
            zoom_in: "Zoom in",
            zoom_out: "Zoom out",
            zoom_reset: "Actual size",
            open_terminal: "Open terminal",
        }
    }
}

pub struct LoadedZoom {
    pub scale: f64,
    pub rewrite: bool,
    pub invalid: Option<String>,
}

/// Round to the nearest 10% step and keep the result inside 80%–200%.
pub fn snap_zoom(scale: f64) -> f64 {
    if !scale.is_finite() {
        return DEFAULT_ZOOM;
    }
    let percent = (scale * 100.0).round() as i64;
    let tenths = ((percent as f64) / 10.0).round() as i64;
    let tenths = tenths.clamp((MIN_ZOOM * 10.0) as i64, (MAX_ZOOM * 10.0) as i64);
    (tenths as f64) / 10.0
}

/// Move by `direction` steps from the current level. `0` only snaps.
pub fn step_zoom(current: f64, direction: i32) -> f64 {
    let base = snap_zoom(current);
    snap_zoom(base + f64::from(direction) * ZOOM_STEP)
}

pub fn zoom_in_enabled(scale: f64) -> bool {
    snap_zoom(scale) < MAX_ZOOM - 1e-9
}

pub fn zoom_out_enabled(scale: f64) -> bool {
    snap_zoom(scale) > MIN_ZOOM + 1e-9
}

/// Read `zoom` from `window-state.json`.
///
/// A missing file or a missing field is 100% and is not an error. A
/// non-numeric or out-of-range field is 100% and `invalid` explains why.
/// `rewrite` is set when the file is an object whose stored zoom should be
/// replaced with `scale`.
pub fn read_window_zoom(path: &Path) -> LoadedZoom {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return LoadedZoom {
                scale: DEFAULT_ZOOM,
                rewrite: false,
                invalid: None,
            };
        }
        Err(error) => {
            return LoadedZoom {
                scale: DEFAULT_ZOOM,
                rewrite: false,
                invalid: Some(format!("could not read window-state.json: {error}")),
            };
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return LoadedZoom {
                scale: DEFAULT_ZOOM,
                rewrite: false,
                invalid: Some(format!("window-state.json is not JSON: {error}")),
            };
        }
    };
    let Some(object) = value.as_object() else {
        return LoadedZoom {
            scale: DEFAULT_ZOOM,
            rewrite: false,
            invalid: Some("window-state.json is not an object".to_string()),
        };
    };
    match object.get("zoom") {
        None => LoadedZoom {
            scale: DEFAULT_ZOOM,
            rewrite: false,
            invalid: None,
        },
        Some(zoom) => match interpret_stored_zoom(zoom) {
            Ok(scale) => {
                let stored = zoom.as_f64().unwrap_or(scale);
                LoadedZoom {
                    scale,
                    rewrite: (scale - stored).abs() > 1e-9,
                    invalid: None,
                }
            }
            Err(detail) => LoadedZoom {
                scale: DEFAULT_ZOOM,
                rewrite: true,
                invalid: Some(detail),
            },
        },
    }
}

fn interpret_stored_zoom(value: &Value) -> Result<f64, String> {
    let Some(scale) = value.as_f64() else {
        return Err(format!("zoom is not a number ({value})"));
    };
    if !scale.is_finite() || !(MIN_ZOOM..=MAX_ZOOM).contains(&scale) {
        return Err(format!("zoom {scale} is outside 0.8..=2.0"));
    }
    Ok(snap_zoom(scale))
}

/// Write `zoom`, keeping every other field already in the file.
pub fn write_zoom(path: &Path, scale: f64) -> Result<(), String> {
    let mut object = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| match value {
                Value::Object(object) => Some(object),
                _ => None,
            })
            .unwrap_or_default(),
        Err(_) => Map::new(),
    };
    let quant = snap_zoom(scale);
    let number = serde_json::Number::from_f64(quant)
        .ok_or_else(|| format!("zoom {quant} is not a JSON number"))?;
    object.insert("zoom".to_string(), Value::Number(number));
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    let mut text =
        serde_json::to_string_pretty(&Value::Object(object)).map_err(|error| error.to_string())?;
    text.push('\n');
    fs::write(path, text).map_err(|error| error.to_string())
}

pub fn user_data_dir(app: &AppHandle, data_dir_name: &str) -> Result<PathBuf, String> {
    let dir = match std::env::var_os("DEEPPATH_USER_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => app
            .path()
            .home_dir()
            .map_err(|error| error.to_string())?
            .join(data_dir_name),
    };
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn bind(app: &tauri::App, data_dir_name: &str, menu: ZoomMenuItems) -> Result<(), String> {
    let path = user_data_dir(app.handle(), data_dir_name)?.join("window-state.json");
    app.manage(ZoomControls {
        path,
        scale: Mutex::new(DEFAULT_ZOOM),
        menu,
    });
    Ok(())
}

pub fn apply_locale(app: &AppHandle, locale: &str) {
    let Some(controls) = app.try_state::<ZoomControls>() else {
        return;
    };
    let labels = zoom_menu_labels(locale);
    let _ = controls.menu.file.set_text(labels.file);
    let _ = controls.menu.new_chat.set_text(labels.new_chat);
    let _ = controls.menu.quit.set_text(labels.quit);
    let _ = controls.menu.edit.set_text(labels.edit);
    let _ = controls.menu.paste.set_text(labels.paste);
    let _ = controls.menu.view.set_text(labels.view);
    let _ = controls.menu.zoom_in.set_text(labels.zoom_in);
    let _ = controls.menu.zoom_in_plus.set_text(labels.zoom_in);
    let _ = controls.menu.zoom_out.set_text(labels.zoom_out);
    let _ = controls.menu.zoom_reset.set_text(labels.zoom_reset);
    let _ = controls.menu.open_terminal.set_text(labels.open_terminal);
}

pub fn apply_saved(app: &AppHandle) {
    let Some(controls) = app.try_state::<ZoomControls>() else {
        return;
    };
    let loaded = read_window_zoom(&controls.path);
    if let Some(detail) = &loaded.invalid {
        eprintln!("[zoom] {detail}; using 100%");
    }
    let _ = commit(app, &controls, loaded.scale, loaded.rewrite, false);
}

pub fn zoom_in(app: &AppHandle) {
    let Some(controls) = app.try_state::<ZoomControls>() else {
        return;
    };
    let next = step_zoom(current_scale(&controls), 1);
    let _ = commit(app, &controls, next, true, true);
}

pub fn zoom_out(app: &AppHandle) {
    let Some(controls) = app.try_state::<ZoomControls>() else {
        return;
    };
    let next = step_zoom(current_scale(&controls), -1);
    let _ = commit(app, &controls, next, true, true);
}

pub fn zoom_reset(app: &AppHandle) {
    let Some(controls) = app.try_state::<ZoomControls>() else {
        return;
    };
    let _ = commit(app, &controls, DEFAULT_ZOOM, true, true);
}

pub fn current_scale(controls: &ZoomControls) -> f64 {
    *controls
        .scale
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn commit(
    app: &AppHandle,
    controls: &ZoomControls,
    scale: f64,
    persist: bool,
    notify: bool,
) -> Result<f64, String> {
    let scale = snap_zoom(scale);
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_zoom(scale)
            .map_err(|error| format!("set_zoom failed: {error}"))?;
    }
    *controls
        .scale
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = scale;
    let _ = controls.menu.zoom_in.set_enabled(zoom_in_enabled(scale));
    let _ = controls
        .menu
        .zoom_in_plus
        .set_enabled(zoom_in_enabled(scale));
    let _ = controls.menu.zoom_out.set_enabled(zoom_out_enabled(scale));
    if persist {
        if let Err(error) = write_zoom(&controls.path, scale) {
            eprintln!("[zoom] failed to write window-state.json: {error}");
        }
    }
    if notify {
        let _ = app.emit("ui:zoom-changed", ZoomChanged { scale });
    }
    Ok(scale)
}

#[tauri::command]
pub fn ui_get_zoom(app: AppHandle) -> f64 {
    app.try_state::<ZoomControls>()
        .map(|controls| current_scale(&controls))
        .unwrap_or(DEFAULT_ZOOM)
}

#[tauri::command]
pub fn ui_set_locale(app: AppHandle, locale: String) {
    apply_locale(&app, &locale);
}

#[tauri::command]
pub fn ui_set_zoom(app: AppHandle, scale: f64) -> f64 {
    if !scale.is_finite() {
        eprintln!("[zoom] ignoring non-numeric zoom");
        return ui_get_zoom(app);
    }
    let Some(controls) = app.try_state::<ZoomControls>() else {
        return DEFAULT_ZOOM;
    };
    match commit(&app, &controls, scale, true, true) {
        Ok(applied) => applied,
        Err(error) => {
            eprintln!("[zoom] {error}");
            current_scale(&controls)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zoom-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("window-state.json")
    }

    #[test]
    fn menu_steps_match_the_ten_percent_grid() {
        let mut scale = DEFAULT_ZOOM;
        scale = step_zoom(scale, 1);
        assert!((scale - 1.1).abs() < 1e-9);
        scale = step_zoom(scale, 1);
        scale = step_zoom(scale, 1);
        assert!((scale - 1.3).abs() < 1e-9);
        scale = step_zoom(scale, -1);
        assert!((scale - 1.2).abs() < 1e-9);
        assert!((step_zoom(scale, 0) - 1.2).abs() < 1e-9);
        assert!((DEFAULT_ZOOM - 1.0).abs() < 1e-9);
    }

    #[test]
    fn menu_labels_follow_the_page_locale() {
        let chinese = zoom_menu_labels("zh-CN");
        assert_eq!(chinese.file, "文件");
        assert_eq!(chinese.new_chat, "新建对话");
        assert_eq!(chinese.quit, "退出");
        assert_eq!(chinese.edit, "编辑");
        assert_eq!(chinese.paste, "粘贴");
        assert_eq!(chinese.view, "视图");
        assert_eq!(chinese.zoom_in, "放大");
        assert_eq!(chinese.zoom_out, "缩小");
        assert_eq!(chinese.zoom_reset, "实际大小");
        assert_eq!(chinese.open_terminal, "打开终端");
        let english = zoom_menu_labels("en");
        assert_eq!(english.file, "File");
        assert_eq!(english.new_chat, "New chat");
        assert_eq!(english.quit, "Quit");
        assert_eq!(english.edit, "Edit");
        assert_eq!(english.paste, "Paste");
        assert_eq!(english.view, "View");
        assert_eq!(english.zoom_in, "Zoom in");
        assert_eq!(english.zoom_out, "Zoom out");
        assert_eq!(english.zoom_reset, "Actual size");
        assert_eq!(english.open_terminal, "Open terminal");
        assert_eq!(zoom_menu_labels("").zoom_in, "Zoom in");
    }

    #[test]
    fn steps_stop_at_the_ends() {
        let mut scale = DEFAULT_ZOOM;
        for _ in 0..20 {
            scale = step_zoom(scale, 1);
        }
        assert!((scale - MAX_ZOOM).abs() < 1e-9);
        assert!(!zoom_in_enabled(scale));
        assert!(zoom_out_enabled(scale));
        scale = DEFAULT_ZOOM;
        for _ in 0..20 {
            scale = step_zoom(scale, -1);
        }
        assert!((scale - MIN_ZOOM).abs() < 1e-9);
        assert!(!zoom_out_enabled(scale));
        assert!(zoom_in_enabled(scale));
    }

    #[test]
    fn an_in_range_off_step_value_snaps() {
        assert!((snap_zoom(1.25) - 1.3).abs() < 1e-9);
        assert!((snap_zoom(1.5) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn a_missing_file_is_one_hundred_percent() {
        let path = temp_file("missing");
        let loaded = read_window_zoom(&path);
        assert!(loaded.invalid.is_none());
        assert!(!loaded.rewrite);
        assert!((loaded.scale - 1.0).abs() < 1e-9);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_non_numeric_zoom_resets_and_keeps_other_fields() {
        let path = temp_file("bad");
        fs::write(&path, "{\n  \"theme\": \"dark\",\n  \"zoom\": \"abc\"\n}\n").unwrap();
        let loaded = read_window_zoom(&path);
        assert!(loaded.invalid.unwrap().contains("not a number"));
        assert!(loaded.rewrite);
        assert!((loaded.scale - 1.0).abs() < 1e-9);
        write_zoom(&path, loaded.scale).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["zoom"], 1.0);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_out_of_range_zoom_resets() {
        let path = temp_file("range");
        fs::write(&path, "{\"zoom\": 3}\n").unwrap();
        let loaded = read_window_zoom(&path);
        assert!(loaded.invalid.unwrap().contains("outside"));
        assert!((loaded.scale - 1.0).abs() < 1e-9);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_stored_step_round_trips() {
        let path = temp_file("round");
        write_zoom(&path, 1.5).unwrap();
        let loaded = read_window_zoom(&path);
        assert!(loaded.invalid.is_none());
        assert!(!loaded.rewrite);
        assert!((loaded.scale - 1.5).abs() < 1e-9);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn broken_json_is_not_overwritten() {
        let path = temp_file("broken");
        fs::write(&path, "not-json").unwrap();
        let loaded = read_window_zoom(&path);
        assert!(loaded.invalid.is_some());
        assert!(!loaded.rewrite);
        assert_eq!(fs::read_to_string(&path).unwrap(), "not-json");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
