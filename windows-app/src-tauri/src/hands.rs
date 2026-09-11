//! hands.rs (Windows) — 手势控制 (Pro)'s data source.
//!
//! Same contract as the macOS hands.rs, command for command and event for
//! event, so the shared frontend (gesture-core.js and everything built on it)
//! cannot tell which one it is talking to:
//!
//!   commands  hands_start / hands_stop / hands_status / hands_get_enabled /
//!             hands_set_enabled / hands_camera_status / hands_camera_request /
//!             hands_open_camera_settings
//!   events    hand-frame   (only to the windows that use it — see HAND_WINDOWS)
//!             hand-status  (status lines and the 2-second fps/ms stats)
//!             hand-enabled (the switch; wallpaper and particle windows drop
//!                           their frame rate while it is on)
//!
//! What differs is where the frames come from. macOS spawns terse-hands
//! (Swift + Apple Vision) and reads its stdout. Windows has no Vision, so the
//! same lines come from hands-tracker.html — MediaPipe's hand landmarker, in a
//! 1-pixel webview that exists only while gestures are on — and arrive through
//! `hands_line` instead of a pipe. Rust still forwards each frame verbatim and
//! never parses it: 30 frames a second into several windows, parsing and
//! re-serialising would be pure waste, and gesture-core.js parses them itself.
//!
//! Off costs nothing: no window, no renderer process, no camera.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct Hands {
    status: String,
    fps: f64,
    ms: f64,
}

static HANDS: LazyLock<Mutex<Hands>> = LazyLock::new(|| Mutex::new(Hands::default()));

/// The tracker's window label. Only this window may speak for the camera.
pub const TRACKER: &str = "hands";

/// Identical to macOS: the main window (gesture page preview), the session dock,
/// the wallpaper, particle mode and the desk cursor. A plain emit would wake
/// every webview Terse has — farm, pet, Doctor, the island — 30 times a second.
/// Labels for windows Windows does not build yet cost nothing and keep the two
/// lists from drifting when those windows arrive.
const HAND_WINDOWS: [&str; 5] = ["main", "sessions-dock", "wallpaper", "particles", "desk-overlay"];

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("gesture.json")
}

/// The global switch, stored in ~/.terse/gesture.json — the same file macOS uses.
pub fn enabled() -> bool {
    std::fs::read_to_string(config_path()).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// At launch: switch on, still Pro, camera allowed → start tracking. Anything
/// else and the camera light stays off.
pub fn autostart(app: AppHandle) {
    if !(enabled() && crate::license::License::load().is_pro()) {
        return;
    }
    // Let setup finish and the event loop come up first: the tracker window is
    // built on the main thread, and there is no hurry to switch a camera on.
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let cam = camera_status_raw();
    crate::diag_log("hands", &format!("autostart: camera {cam}"));
    if cam == "authorized" {
        let _ = hands_start(app);
    } else {
        let _ = app.emit("hand-status", &json!({ "status": "needs-permission" }));
    }
}

/// Settings › Privacy & security › Camera.
///
/// A desktop app is governed by two switches — the camera as a whole
/// (ConsentStore\webcam) and "Let desktop apps access your camera"
/// (ConsentStore\webcam\NonPackaged) — plus a machine-wide policy under HKLM.
/// Any Deny wins. There is no "not determined": Windows never asks a desktop
/// app, it is simply allowed or not, so the answer is authorized or denied.
fn camera_status_raw() -> String {
    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam";
    let denied = |hive: &str, key: &str| -> bool {
        crate::hidden_command("reg")
            .args(["query", &format!(r"{hive}\{key}"), "/v", "Value"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("Deny"))
            .unwrap_or(false)
    };
    let nonpackaged = format!(r"{BASE}\NonPackaged");
    if denied("HKLM", BASE) || denied("HKCU", BASE) || denied("HKCU", &nonpackaged) {
        "denied".into()
    } else {
        "authorized".into()
    }
}

/// Whether the camera is allowed right now (never prompts).
#[tauri::command(async)]
pub fn hands_camera_status() -> String {
    camera_status_raw()
}

/// macOS pops a system prompt here. Windows has none to pop for a desktop app —
/// the camera is switched on or off in Settings — so this reports the current
/// answer, and the UI's existing "denied" path offers the Settings button.
/// `reset` is a macOS TCC notion (clearing a stale per-signature record) with
/// no Windows equivalent; it is accepted and ignored so the shared UI works.
#[tauri::command(async)]
pub fn hands_camera_request(reset: bool) -> String {
    let r = camera_status_raw();
    crate::diag_log("hands", &format!("camera request (reset={reset}) -> {r}"));
    r
}

/// Open Settings › Privacy & security › Camera.
#[tauri::command(async)]
pub fn hands_open_camera_settings() {
    let _ = crate::hidden_command("explorer").arg("ms-settings:privacy-webcam").spawn();
}

#[tauri::command(async)]
pub fn hands_get_enabled() -> bool {
    enabled()
}

/// The gesture page's switch: store it, tell every window, start or stop.
#[tauri::command(async)]
pub fn hands_set_enabled(app: AppHandle, on: bool) -> Result<String, String> {
    if on && !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    if let Some(dir) = config_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(config_path(), json!({ "enabled": on }).to_string()).map_err(|e| e.to_string())?;
    let _ = app.emit("hand-enabled", on);
    if on { hands_start(app) } else { hands_stop(app); Ok("stopped".into()) }
}

/// Start tracking. Already running → nothing to do.
///
/// The licence is checked here, in Rust, not only in the page: the front-end
/// gate can be bypassed, the camera cannot be allowed to be.
#[tauri::command(async)]
pub fn hands_start(app: AppHandle) -> Result<String, String> {
    if !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    if app.get_webview_window(TRACKER).is_some() {
        return Ok(HANDS.lock().map(|h| h.status.clone()).unwrap_or_default());
    }
    if let Ok(mut h) = HANDS.lock() {
        h.status = "starting".into();
        h.fps = 0.0;
        h.ms = 0.0;
    }
    // ensure_window builds on the main thread and waits for it; webviews created
    // off the main thread come up as about:blank on Windows.
    if crate::ensure_window(&app, TRACKER).is_none() {
        if let Ok(mut h) = HANDS.lock() { h.status = "error".into(); }
        return Err("could not create the gesture tracker".into());
    }
    crate::diag_log("hands", "tracker window up");
    Ok("starting".into())
}

/// Stop tracking. Destroying the window is what releases the camera — its
/// media stream dies with the page, and the camera light goes out.
#[tauri::command(async)]
pub fn hands_stop(app: AppHandle) {
    if let Some(w) = app.get_webview_window(TRACKER) {
        let _ = app.run_on_main_thread(move || { let _ = w.destroy(); });
    }
    if let Ok(mut h) = HANDS.lock() {
        h.status = "stopped".into();
        h.fps = 0.0;
        h.ms = 0.0;
    }
    let _ = app.emit("hand-status", &json!({ "status": "stopped" }));
}

#[tauri::command(async)]
pub fn hands_status(app: AppHandle) -> Value {
    let running = app.get_webview_window(TRACKER).is_some();
    match HANDS.lock() {
        Ok(h) if running => json!({ "running": true, "status": h.status, "fps": h.fps, "ms": h.ms }),
        _ => json!({ "running": false, "status": "stopped" }),
    }
}

/// One line from the tracker — exactly what terse-hands writes to stdout.
///
/// Frames (`{"t":…`) are forwarded verbatim and only to HAND_WINDOWS. Everything
/// else is a status or stats line: logged, remembered, and broadcast as
/// hand-status, which is what the macOS stdout reader does with the same lines.
#[tauri::command]
pub fn hands_line(app: AppHandle, window: tauri::WebviewWindow, line: String) {
    // Only the tracker speaks for the camera. Any other page calling this could
    // otherwise feed fabricated hands into every gesture consumer.
    if window.label() != TRACKER {
        return;
    }
    if line.starts_with("{\"t\"") {
        let _ = app.emit_filter("hand-frame", &line, |t| matches!(t,
            tauri::EventTarget::WebviewWindow { label } | tauri::EventTarget::Webview { label } | tauri::EventTarget::Window { label }
                if HAND_WINDOWS.contains(&label.as_str())));
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(&line) else { return };
    // Status lines go to the log; frames never do (30 a second).
    crate::diag_log("hands", &line);
    if let Ok(mut h) = HANDS.lock() {
        if let Some(s) = v.get("status").and_then(|s| s.as_str()) {
            h.status = s.to_string();
        }
        if let Some(f) = v.get("fps").and_then(|f| f.as_f64()) {
            h.fps = f;
            h.ms = v.get("ms").and_then(|m| m.as_f64()).unwrap_or(0.0);
        }
    }
    let _ = app.emit("hand-status", &v);
}

/// Answer the tracker webview's camera request ourselves.
///
/// wry registers a PermissionRequested handler that answers clipboard-read and
/// nothing else. An unanswered camera request makes WebView2 show its own
/// "allow camera?" prompt — inside the tracker, a 1-pixel window nobody can
/// see — so getUserMedia would wait forever with nothing on screen to explain
/// it. Only this window gets the handler, and it only ever loads our own page.
pub fn allow_camera(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|pw| {
        use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
        unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let mut token: i64 = 0;
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    });
}
