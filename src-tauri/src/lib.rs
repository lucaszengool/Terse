mod capture;
mod agent_monitor;
mod stats_store;
mod license;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use serde::{Deserialize, Serialize};

/// Lock a mutex, recovering from poison (prevents cascade crashes)
fn lock_or_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| {
        eprintln!("[terse] recovering from poisoned mutex");
        e.into_inner()
    })
}
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// ── App State ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: u32,
    pub name: String,
    pub pid: u32,
    pub bundle_id: String,
    pub title: String,
    pub click_pos: Option<(f64, f64)>,
    pub last_text: String,
    pub ax_enabled: bool,
    pub read_method: String,
    pub key_monitor_started: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub aggressiveness: String,
    #[serde(rename = "removeFillerWords")]
    pub remove_filler_words: bool,
    #[serde(rename = "removePoliteness")]
    pub remove_politeness: bool,
    #[serde(rename = "removeHedging")]
    pub remove_hedging: bool,
    #[serde(rename = "removeMetaLanguage")]
    pub remove_meta_language: bool,
    #[serde(rename = "shortenPhrases")]
    pub shorten_phrases: bool,
    #[serde(rename = "simplifyInstructions")]
    pub simplify_instructions: bool,
    #[serde(rename = "removeRedundancy")]
    pub remove_redundancy: bool,
    #[serde(rename = "compressWhitespace")]
    pub compress_whitespace: bool,
    #[serde(rename = "compressCodeBlocks")]
    pub compress_code_blocks: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            aggressiveness: "balanced".to_string(),
            remove_filler_words: true,
            remove_politeness: true,
            remove_hedging: true,
            remove_meta_language: true,
            shorten_phrases: true,
            simplify_instructions: true,
            remove_redundancy: true,
            compress_whitespace: true,
            compress_code_blocks: true,
        }
    }
}

pub struct AppState {
    pub sessions: Mutex<HashMap<u32, Session>>,
    pub next_session_id: Mutex<u32>,
    pub active_session_id: Mutex<Option<u32>>,
    pub candidate_session_id: Mutex<Option<u32>>,
    pub settings: Mutex<Settings>,
    pub auto_mode: Mutex<String>,
    pub popup_minimized: Mutex<bool>,
    pub last_popup_text: Mutex<String>,
    pub last_front_bundle_id: Mutex<String>,
    pub agent_monitor: Mutex<agent_monitor::AgentMonitor>,
    pub stats_store: Mutex<stats_store::StatsStore>,
    pub license: Mutex<license::License>,
    pub auth: Mutex<license::AuthState>,
    pub is_picking: Mutex<bool>,
    pub is_auto_replacing: Mutex<bool>,
    pub auto_replaced: Mutex<bool>,
    pub last_text_change_time: Mutex<u64>,
    pub popup_visible_for_text: Mutex<bool>,
    pub key_monitors: capture::KeyMonitorState,
    pub hook_stats_synced: Mutex<u64>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            sessions: Mutex::new(HashMap::new()),
            next_session_id: Mutex::new(1),
            active_session_id: Mutex::new(None),
            candidate_session_id: Mutex::new(None),
            settings: Mutex::new(Settings::default()),
            auto_mode: Mutex::new("send".to_string()),
            popup_minimized: Mutex::new(false),
            last_popup_text: Mutex::new(String::new()),
            last_front_bundle_id: Mutex::new(String::new()),
            agent_monitor: Mutex::new(agent_monitor::AgentMonitor::new()),
            stats_store: Mutex::new(stats_store::StatsStore::new()),
            license: Mutex::new(license::License::load()),
            auth: Mutex::new(license::AuthState::load()),
            is_picking: Mutex::new(false),
            is_auto_replacing: Mutex::new(false),
            auto_replaced: Mutex::new(false),
            last_text_change_time: Mutex::new(0),
            popup_visible_for_text: Mutex::new(false),
            key_monitors: capture::KeyMonitorState::new(),
            hook_stats_synced: Mutex::new(0),
        }
    }
}

// ── Electron app detection ──
const ELECTRON_APP_INFO: &[(&str, &str, &str)] = &[
    ("com.microsoft.VSCode", "Code", "VS Code"),
    ("com.microsoft.VSCodeInsiders", "Code - Insiders", "VS Code Insiders"),
    ("com.visualstudio.code.oss", "Code - OSS", "VS Code OSS"),
    ("com.todesktop.230313mzl4w4u92", "Cursor", "Cursor"),
];

fn is_ax_blind(bundle_id: &str) -> bool {
    ELECTRON_APP_INFO.iter().any(|(bid, _, _)| *bid == bundle_id)
}

/// Browsers where AX window-walk reads the URL bar instead of page inputs.
/// These should use key monitor for text capture.
const BROWSER_BUNDLES: &[&str] = &[
    "com.google.Chrome",
    "com.google.Chrome.canary",
    "com.apple.Safari",
    "org.mozilla.firefox",
    "org.mozilla.nightly",
    "com.brave.Browser",
    "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi",
    "company.thebrowser.Browser",  // Arc
    "com.microsoft.edgemac",
];

fn is_browser(bundle_id: &str) -> bool {
    BROWSER_BUNDLES.iter().any(|b| *b == bundle_id)
}

fn get_electron_app_info(bundle_id: &str) -> Option<(&'static str, &'static str)> {
    ELECTRON_APP_INFO.iter()
        .find(|(bid, _, _)| *bid == bundle_id)
        .map(|(_, dir, label)| (*dir, *label))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Auto-setup Electron AX ──
async fn auto_setup_electron_ax(bundle_id: &str, pid: u32, app: &AppHandle, session_id: u32) {
    let (settings_dir, label) = match get_electron_app_info(bundle_id) {
        Some(info) => info,
        None => return,
    };

    // Step 1: Find and update settings.json
    let home = dirs::home_dir().unwrap_or_default();
    let mut candidate_paths = vec![
        home.join("Library/Application Support").join(settings_dir).join("User/settings.json"),
    ];
    if settings_dir == "Cursor" {
        candidate_paths.push(home.join(".cursor/User/settings.json"));
    }

    let mut _settings_ok = false;
    let mut needs_reload = false;

    for sp in &candidate_paths {
        if let Some(parent) = sp.parent() {
            if !parent.exists() { continue; }
        }

        let result = (|| -> Result<(bool, bool), Box<dyn std::error::Error>> {
            if !sp.exists() {
                let dir = sp.parent().ok_or("no parent")?;
                if !dir.exists() { return Err("no dir".into()); }
                std::fs::write(sp, "{\"editor.accessibilitySupport\": \"on\"}\n")?;
                return Ok((true, true));
            }
            let raw = std::fs::read_to_string(sp)?;
            // Strip comments for VS Code JSON
            let stripped = raw.lines()
                .map(|l| {
                    if let Some(idx) = l.find("//") { &l[..idx] } else { l }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let mut settings: serde_json::Value = serde_json::from_str(&stripped)?;
            if settings.get("editor.accessibilitySupport").and_then(|v| v.as_str()) == Some("on") {
                return Ok((true, false)); // Already set
            }
            settings["editor.accessibilitySupport"] = serde_json::json!("on");
            std::fs::write(sp, serde_json::to_string_pretty(&settings)?)?;
            Ok((true, true))
        })();

        match result {
            Ok((ok, reload)) => {
                _settings_ok = ok;
                needs_reload = reload;
                break;
            }
            Err(_) => continue,
        }
    }

    // Step 2: Enable AX on the process
    let ax_ok = capture::enable_ax_for_app(pid).await;

    // Update session
    {
        let state = app.state::<AppState>();
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = sessions.get_mut(&session_id) {
            session.ax_enabled = ax_ok;
        }
    }

    if needs_reload {
        let bridge_up = capture::is_bridge_alive().await;
        if bridge_up {
            let _ = app.emit("toast", serde_json::json!({
                "msg": format!("{}: enabling live detection, reloading...", label),
                "duration": 4000
            }));
            capture::reload_bridge().await;
            // After reload, re-enable AX on new process
            let app2 = app.clone();
            let bundle_id2 = bundle_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                let fresh_app = capture::get_front_app().await;
                if fresh_app.bundle_id == bundle_id2 && fresh_app.pid != pid {
                    {
                        let state = app2.state::<AppState>();
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(session) = sessions.get_mut(&session_id) {
                            session.pid = fresh_app.pid;
                        }
                    }
                    capture::enable_ax_for_app(fresh_app.pid).await;
                    {
                        let state = app2.state::<AppState>();
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(session) = sessions.get_mut(&session_id) {
                            session.ax_enabled = true;
                        }
                    }
                } else {
                    capture::enable_ax_for_app(pid).await;
                }
            });
        } else {
            let _ = app.emit("toast", serde_json::json!({
                "msg": format!("{}: accessibility enabled. Please reload {} (Cmd+Shift+P → \"Reload Window\") for live detection.", label, label),
                "duration": 8000
            }));
        }
    } else if ax_ok {
        let _ = app.emit("toast", serde_json::json!({
            "msg": format!("{}: live detection ready.", label)
        }));
    }
}

// ── Tauri Commands ──

#[tauri::command]
fn get_sessions(state: tauri::State<'_, AppState>) -> Vec<serde_json::Value> {
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let active_id = state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
    sessions.values().map(|s| {
        serde_json::json!({
            "id": s.id,
            "name": s.name,
            "pid": s.pid,
            "bundleId": s.bundle_id,
            "title": s.title,
            "active": Some(s.id) == *active_id,
        })
    }).collect()
}

#[tauri::command]
fn remove_session(id: u32, state: tauri::State<'_, AppState>, app: AppHandle) {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(session) = sessions.get(&id) {
        if session.key_monitor_started {
            state.key_monitors.stop_monitor(session.pid);
        }
    }
    sessions.remove(&id);
    let mut active = state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
    if *active == Some(id) {
        *active = None;
        *state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    let _ = app.emit("sessions-updated", ());
}

#[tauri::command]
async fn enter_pick_mode(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool, String> {
    {
        let mut picking = state.is_picking.lock().unwrap_or_else(|e| e.into_inner());
        if *picking { return Ok(false); }
        *picking = true;
    }
    let _ = app.emit("pick-mode", true);
    eprintln!("[terse] pick mode started — waiting for user to switch apps");

    // Poll until the frontmost app is NOT Terse (user switched away)
    // Then wait a brief moment and read the target app info
    // Timeout after 20 seconds
    let mut app_info = capture::AppInfo {
        name: "?".into(), pid: 0, bundle_id: String::new(), title: String::new(),
    };

    // Phase 1: Wait for user to leave Terse (up to 20s)
    let mut left_terse = false;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let info = capture::get_front_app().await;
        let name_lower = info.name.to_lowercase();
        let is_terse = info.name.is_empty()
            || info.name == "?"
            || name_lower == "terse"
            || name_lower == "electron"
            || info.bundle_id == "com.terse.app"
            || info.bundle_id == "com.github.Electron"
            || info.bundle_id == "com.github.electron";
        if !is_terse {
            // User switched to another app — wait a moment then read
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            app_info = capture::get_front_app().await;
            left_terse = true;
            eprintln!("[terse] picked app: {} ({})", app_info.name, app_info.bundle_id);
            break;
        }
    }

    {
        let mut picking = state.is_picking.lock().unwrap_or_else(|e| e.into_inner());
        *picking = false;
    }
    let _ = app.emit("pick-mode", false);

    if left_terse && app_info.name != "?" && !app_info.name.is_empty() {
        let id = {
            let mut next_id = state.next_session_id.lock().unwrap_or_else(|e| e.into_inner());
            let id = *next_id;
            *next_id += 1;
            id
        };
        let session = Session {
            id,
            name: app_info.name.clone(),
            pid: app_info.pid,
            bundle_id: app_info.bundle_id.clone(),
            title: app_info.title.clone(),
            click_pos: None,
            last_text: String::new(),
            ax_enabled: false,
            read_method: String::new(),
            key_monitor_started: false,
            active: false,
        };
        state.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(id, session);

        // Auto-setup AX for Electron apps
        if is_ax_blind(&app_info.bundle_id) {
            let app2 = app.clone();
            let bid = app_info.bundle_id.clone();
            tokio::spawn(async move {
                auto_setup_electron_ax(&bid, app_info.pid, &app2, id).await;
            });
        }

        let _ = app.emit("sessions-updated", ());
        let _ = app.emit("session-added", serde_json::json!({"id": id}));
        Ok(true)
    } else {
        let _ = app.emit("toast", serde_json::json!({"msg": "Could not detect app — click on target app first", "error": true}));
        Ok(false)
    }
}


#[tauri::command]
async fn capture_now(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let session_info = {
        let active_id = state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
        let candidate_id = state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner());
        let sid = active_id.or(*candidate_id);
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sid.and_then(|id| sessions.get(&id).cloned())
    };
    let session = match session_info {
        Some(s) => s,
        None => return Err("No active session".to_string()),
    };

    // Ensure popup is visible
    {
        let mut visible = state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner());
        if !*visible {
            *visible = true;
            let _ = app.emit("popup-show", serde_json::json!({
                "app": if session.title.is_empty() { &session.name } else { &session.title },
                "sessionId": session.id,
                            }));
            if let Some(popup) = app.get_webview_window("popup") {
                let _ = popup.show();
            }
        }
    }

    // Read text based on method
    let result = if session.read_method == "keymonitor" {
        let km = state.key_monitors.get_buffer(session.pid);
        match km {
            Some((text, _)) if text.len() >= 3 => capture::CaptureResult {
                text, method: "keymonitor".into(), ok: true, focused: false,
            },
            _ => capture::read_all_via_clipboard(&session.name).await,
        }
    } else if session.read_method == "clipboard" {
        capture::read_all_via_clipboard(&session.name).await
    } else {
        capture::read_selection(&session.name).await
    };

    if result.text.trim().len() >= 5 {
        let trimmed = result.text.trim().to_string();
        *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = trimmed.clone();
        if let Some(s) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&session.id) {
            s.last_text = trimmed.clone();
        }
        // Send to popup for optimization (optimizer runs in webview)
        let _ = app.emit("captured-text", serde_json::json!({
            "text": trimmed,
            "method": result.method,
            "app": if session.title.is_empty() { &session.name } else { &session.title },
            "sessionId": session.id,
        }));
    }
    Ok(())
}

#[tauri::command]
async fn replace_in_target(text: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let session_info = {
        let active_id = state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        active_id.and_then(|id| sessions.get(&id).cloned())
    };

    match session_info {
        Some(session) => {
            // Use matching write method
            let result = if session.read_method == "bridge" {
                let bridge_up = capture::is_bridge_alive().await;
                if bridge_up {
                    let ok = capture::write_bridge(&text).await;
                    capture::WriteResult { ok, method: "bridge".to_string() }
                } else {
                    capture::write_to_app(&session.name, &text, session.pid).await
                }
            } else if session.read_method == "keymonitor" || session.read_method == "keymonitor-cached"
                || session.bundle_id.contains("com.microsoft.VSCode") {
                // Terminal/editor without AX access (VS Code terminal, etc.)
                // Use Ctrl+A (go to start) + Ctrl+K (kill to end) + paste
                capture::write_via_clipboard_terminal(&text).await
            } else {
                // For all other apps (browsers, editors, any app) — use clipboard:
                // Cmd+A to select all, Cmd+V to paste. This is the most reliable
                // write method across all macOS apps. AX value set is unreliable
                // (Chrome appends instead of replacing, etc.)
                capture::write_via_clipboard(&session.name, &text, false).await
            };
            Ok(serde_json::json!({"ok": result.ok, "method": result.method}))
        }
        None => {
            // No session — copy to clipboard
            Ok(serde_json::json!({"ok": true, "method": "clipboard"}))
        }
    }
}

#[tauri::command]
async fn apply_to_clipboard(text: String) -> bool {
    use tokio::process::Command;
    use tokio::io::AsyncWriteExt;
    if let Ok(mut child) = Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
    {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
        let _ = child.wait().await;
    }
    true
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
fn update_settings(s: serde_json::Value, state: tauri::State<'_, AppState>, app: AppHandle) -> bool {
    let mut settings = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(a) = s.get("aggressiveness").and_then(|v| v.as_str()) {
        settings.aggressiveness = a.to_string();
    }
    macro_rules! update_bool {
        ($key:expr, $field:ident) => {
            if let Some(v) = s.get($key).and_then(|v| v.as_bool()) {
                settings.$field = v;
            }
        };
    }
    update_bool!("removeFillerWords", remove_filler_words);
    update_bool!("removePoliteness", remove_politeness);
    update_bool!("removeHedging", remove_hedging);
    update_bool!("removeMetaLanguage", remove_meta_language);
    update_bool!("shortenPhrases", shorten_phrases);
    update_bool!("simplifyInstructions", simplify_instructions);
    update_bool!("removeRedundancy", remove_redundancy);
    update_bool!("compressWhitespace", compress_whitespace);
    update_bool!("compressCodeBlocks", compress_code_blocks);
    let _ = app.emit("settings-changed", serde_json::to_value(&*settings).unwrap());
    true
}

#[tauri::command]
fn set_auto_mode(mode: String, state: tauri::State<'_, AppState>) -> bool {
    let prev = state.auto_mode.lock().unwrap_or_else(|e| e.into_inner()).clone();
    *state.auto_mode.lock().unwrap_or_else(|e| e.into_inner()) = mode.clone();

    // Toggle send mode on all active key monitors
    let send_on = mode == "send";
    let prev_send_on = prev == "send";
    if send_on != prev_send_on {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for session in sessions.values() {
            if session.key_monitor_started {
                state.key_monitors.set_send_mode(session.pid, send_on);
            }
        }
    }
    true
}

#[tauri::command]
fn close_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn set_popup_minimized(on: bool, state: tauri::State<'_, AppState>, app: AppHandle) -> bool {
    let mut minimized = state.popup_minimized.lock().unwrap_or_else(|e| e.into_inner());
    *minimized = on;
    if let Some(popup) = app.get_webview_window("popup") {
        if on {
            let _ = popup.set_size(tauri::LogicalSize::new(72.0, 72.0));
        } else {
            let _ = popup.set_size(tauri::LogicalSize::new(540.0, 200.0));
            // Restore popup for current session
            let sid = state.active_session_id.lock().unwrap_or_else(|e| e.into_inner())
                .or(*state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner()));
            if let Some(id) = sid {
                let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(session) = sessions.get(&id) {
                    *state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    let _ = app.emit("popup-show", serde_json::json!({
                        "app": if session.title.is_empty() { &session.name } else { &session.title },
                        "sessionId": session.id,
                                            }));
                }
            }
        }
    }
    true
}

#[tauri::command]
fn move_popup_by(dx: f64, dy: f64, app: AppHandle) {
    if let Some(popup) = app.get_webview_window("popup") {
        if let Ok(pos) = popup.outer_position() {
            let scale = popup.scale_factor().unwrap_or(1.0);
            let _ = popup.set_position(tauri::PhysicalPosition::new(
                pos.x + (dx * scale) as i32,
                pos.y + (dy * scale) as i32,
            ));
        }
    }
}

#[tauri::command]
fn resize_popup(h: f64, state: tauri::State<'_, AppState>, app: AppHandle) {
    let minimized = *state.popup_minimized.lock().unwrap_or_else(|e| e.into_inner());
    if minimized { return; }
    if let Some(popup) = app.get_webview_window("popup") {
        let clamped = h.max(120.0).min(800.0);
        let _ = popup.set_size(tauri::LogicalSize::new(540.0, clamped));
    }
}

// ── Agent Monitor Commands ──

#[tauri::command]
fn get_agent_detections(state: tauri::State<'_, AppState>) -> Vec<serde_json::Value> {
    let monitor = lock_or_recover(&state.agent_monitor);
    let d = monitor.get_pending_detections();
    eprintln!("[terse] get_agent_detections: {} pending", d.len());
    d
}

#[tauri::command]
fn get_agent_sessions(state: tauri::State<'_, AppState>) -> Vec<serde_json::Value> {
    let monitor = lock_or_recover(&state.agent_monitor);
    let sessions = monitor.get_connected_sessions();
    eprintln!("[terse] get_agent_sessions: {} connected", sessions.len());
    sessions
}

#[tauri::command]
async fn accept_agent(agent_type: String, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    eprintln!("[terse] accept_agent called for type={}", agent_type);

    // Block new connections if quota is exhausted
    {
        let lic = lock_or_recover(&state.license);
        if !lic.can_optimize() {
            let _ = app.emit("quota-exhausted", serde_json::json!({
                "remaining": 0,
                "message": "Weekly optimization quota reached. Upgrade your plan or wait until next week."
            }));
            return Err("Quota exhausted. Upgrade your plan or wait until next week.".to_string());
        }
    }

    let snapshot = {
        let mut monitor = lock_or_recover(&state.agent_monitor);
        monitor.accept_agent(&agent_type)
    };
    eprintln!("[terse] accept_agent result: has_snapshot={}", snapshot.is_some());
    if let Some(ref snap) = snapshot {
        let _ = app.emit("agent-connected", serde_json::json!({"session": snap}));
    }
    Ok(snapshot)
}

#[tauri::command]
fn dismiss_agent(agent_type: String, state: tauri::State<'_, AppState>) -> bool {
    let mut monitor = lock_or_recover(&state.agent_monitor);
    monitor.dismiss_agent(&agent_type);
    true
}

#[tauri::command]
fn disconnect_agent(agent_type: String, state: tauri::State<'_, AppState>, app: AppHandle) -> bool {
    let mut monitor = lock_or_recover(&state.agent_monitor);
    monitor.disconnect_agent(&agent_type);
    let _ = app.emit("agent-disconnected", serde_json::json!({"type": agent_type}));
    true
}

#[tauri::command]
fn get_agent_analytics(agent_type: String, state: tauri::State<'_, AppState>) -> Option<serde_json::Value> {
    let monitor = lock_or_recover(&state.agent_monitor);
    monitor.get_session_snapshot(&agent_type)
}

#[tauri::command]
async fn get_agent_plan_info(agent_type: String, state: tauri::State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    // Check cache first
    {
        let monitor = lock_or_recover(&state.agent_monitor);
        if let Some(cached) = monitor.get_cached_plan_info(&agent_type) {
            return Ok(Some(serde_json::to_value(cached).unwrap_or_default()));
        }
    }

    // Fetch in background thread (blocking I/O: keychain, curl, sqlite3)
    let at = agent_type.clone();
    let info = tokio::task::spawn_blocking(move || {
        match at.as_str() {
            "claude-code" => agent_monitor::fetch_claude_plan_info(),
            "cursor-agent" | "cursor" => agent_monitor::fetch_cursor_plan_info(),
            _ => None,
        }
    }).await.map_err(|e| e.to_string())?;

    if let Some(ref plan_info) = info {
        let mut monitor = lock_or_recover(&state.agent_monitor);
        monitor.set_plan_info(&agent_type, plan_info.clone());
    }

    Ok(info.map(|i| serde_json::to_value(i).unwrap_or_default()))
}

// ── Multi-Agent Hook Installation ──
//
// Supported agents and their hook protocols:
//   claude-code  — ~/.claude/settings.json  (PreToolUse, matcher: Bash)
//   cursor       — ~/.cursor/hooks.json     (beforeShellExecution)
//   cline        — ~/Documents/Cline/Rules/Hooks/  (PreToolUse, matcher: execute_command)
//   codex        — ~/.codex/codex.toml      (pre_tool_use, matcher: shell)
//   copilot      — ~/.github-copilot/hooks/ (preToolUse)
//   openclaw     — ~/.openclaw/hooks/       (tool.execute.before, TypeScript)

/// Per-agent config: hook script filename, settings path, hook key, matcher, install method
struct AgentHookConfig {
    hook_script: &'static str,
    hook_include: &'static str,
    settings_path: std::path::PathBuf,
    install_method: AgentInstallMethod,
    /// Optional tool optimizer hook (for Read/Grep/file tools)
    tool_optimizer: Option<ToolOptimizerConfig>,
}

struct ToolOptimizerConfig {
    script: &'static str,
    include: &'static str,
    matcher: &'static str,
    hook_event: &'static str,
}

enum AgentInstallMethod {
    /// JSON settings file with hooks.{event}[] array (Claude Code, Cursor, Cline)
    JsonSettings {
        hook_event: &'static str,
        matcher: &'static str,
    },
    /// TOML config file (Codex CLI)
    Toml,
    /// Drop hook file into directory (Copilot CLI, OpenClaw)
    DropFile,
}

fn get_agent_hook_config(agent: &str) -> Result<AgentHookConfig, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    match agent {
        "claude-code" => Ok(AgentHookConfig {
            hook_script: "terse-rewrite.sh",
            hook_include: "../../src/helpers/terse-rewrite.sh",
            settings_path: home.join(".claude/settings.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "PreToolUse",
                matcher: "Bash",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "terse-optimize-tools.sh",
                include: "../../src/helpers/terse-optimize-tools.sh",
                matcher: "Read|Grep",
                hook_event: "PreToolUse",
            }),
        }),
        "cursor" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-cursor.sh",
            hook_include: "../../src/helpers/hooks/terse-hook-cursor.sh",
            settings_path: home.join(".cursor/hooks.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "preToolUse",
                matcher: "run_terminal_command",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-cursor.sh",
                include: "../../src/helpers/hooks/terse-tool-optimizer-cursor.sh",
                matcher: "read_file|grep_search",
                hook_event: "preToolUse",
            }),
        }),
        "cline" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-cline.sh",
            hook_include: "../../src/helpers/hooks/terse-hook-cline.sh",
            settings_path: home.join(".cline/settings.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "PreToolUse",
                matcher: "execute_command",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-cline.sh",
                include: "../../src/helpers/hooks/terse-tool-optimizer-cline.sh",
                matcher: "read_file|list_files",
                hook_event: "PreToolUse",
            }),
        }),
        "codex" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-codex.sh",
            hook_include: "../../src/helpers/hooks/terse-hook-codex.sh",
            settings_path: home.join(".codex/codex.toml"),
            install_method: AgentInstallMethod::Toml,
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-codex.sh",
                include: "../../src/helpers/hooks/terse-tool-optimizer-codex.sh",
                matcher: "read_file|search|view",
                hook_event: "pre_tool_use",
            }),
        }),
        "copilot" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-copilot.sh",
            hook_include: "../../src/helpers/hooks/terse-hook-copilot.sh",
            settings_path: home.join(".github-copilot/hooks/preToolUse/terse-hook-copilot.sh"),
            install_method: AgentInstallMethod::DropFile,
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-copilot.sh",
                include: "../../src/helpers/hooks/terse-tool-optimizer-copilot.sh",
                matcher: "view|grep|search",
                hook_event: "preToolUse",
            }),
        }),
        "openclaw" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-openclaw.ts",
            hook_include: "../../src/helpers/hooks/terse-hook-openclaw.ts",
            settings_path: home.join(".openclaw/hooks/terse-hook-openclaw.ts"),
            install_method: AgentInstallMethod::DropFile,
            tool_optimizer: None, // OpenClaw doesn't support pre-tool hooks yet
        }),
        "windsurf" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-windsurf.sh",
            hook_include: "../../src/helpers/hooks/terse-hook-windsurf.sh",
            settings_path: home.join(".windsurf/hooks.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "pre_tool_use",
                matcher: "shell",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-windsurf.sh",
                include: "../../src/helpers/hooks/terse-tool-optimizer-windsurf.sh",
                matcher: "read_file|view_file",
                hook_event: "pre_tool_use",
            }),
        }),
        _ => Err(format!("Unknown agent: {}. Supported: claude-code, cursor, cline, codex, copilot, openclaw, windsurf", agent)),
    }
}

/// Write the hook script to the terse hooks dir and return destination path.
fn deploy_hook_script(config: &AgentHookConfig) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let terse_dir = home.join(".terse");
    std::fs::create_dir_all(&terse_dir).map_err(|e| format!("Failed to create ~/.terse: {}", e))?;

    // Determine destination
    let hook_dest = terse_dir.join(config.hook_script);
    if let Some(parent) = hook_dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create hook dir: {}", e))?;
    }

    // Try to find pre-built script next to the binary first
    let hook_src = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default()
        .join(config.hook_script);

    if hook_src.exists() {
        std::fs::copy(&hook_src, &hook_dest)
            .map_err(|e| format!("Failed to copy hook: {}", e))?;
    } else {
        // Write from embedded source
        let script = match config.hook_include {
            "../../src/helpers/terse-rewrite.sh" => include_str!("../../src/helpers/terse-rewrite.sh"),
            "../../src/helpers/hooks/terse-hook-cursor.sh" => include_str!("../../src/helpers/hooks/terse-hook-cursor.sh"),
            "../../src/helpers/hooks/terse-hook-cline.sh" => include_str!("../../src/helpers/hooks/terse-hook-cline.sh"),
            "../../src/helpers/hooks/terse-hook-codex.sh" => include_str!("../../src/helpers/hooks/terse-hook-codex.sh"),
            "../../src/helpers/hooks/terse-hook-copilot.sh" => include_str!("../../src/helpers/hooks/terse-hook-copilot.sh"),
            "../../src/helpers/hooks/terse-hook-openclaw.ts" => include_str!("../../src/helpers/hooks/terse-hook-openclaw.ts"),
            "../../src/helpers/hooks/terse-hook-windsurf.sh" => include_str!("../../src/helpers/hooks/terse-hook-windsurf.sh"),
            _ => return Err("Unknown hook script".to_string()),
        };
        std::fs::write(&hook_dest, script)
            .map_err(|e| format!("Failed to write hook: {}", e))?;
    }

    // Also deploy terse-compress.js alongside the hook
    let compress_dest = terse_dir.join("terse-compress.js");
    if !compress_dest.exists() {
        let compress_src = include_str!("../../src/helpers/terse-compress.js");
        std::fs::write(&compress_dest, compress_src)
            .map_err(|e| format!("Failed to write terse-compress.js: {}", e))?;
    }

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        let _ = std::fs::set_permissions(&hook_dest, perms);
    }

    Ok(hook_dest)
}

/// Install Terse hook for any supported agent.
#[tauri::command]
fn install_agent_hook(agent: Option<String>) -> Result<serde_json::Value, String> {
    let agent_id = agent.as_deref().unwrap_or("claude-code");
    let config = get_agent_hook_config(agent_id)?;
    let hook_dest = deploy_hook_script(&config)?;

    // Deploy tool optimizer hook if this agent supports it
    if let Some(ref tool_opt) = config.tool_optimizer {
        let home = dirs::home_dir().ok_or("Cannot find home directory")?;
        let terse_dir = home.join(".terse");
        let tool_hook_dest = terse_dir.join(tool_opt.script);
        if let Some(parent) = tool_hook_dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // Try source tree first, then bundled resources
        let tool_hook_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(tool_opt.include);
        if tool_hook_src.exists() {
            let _ = std::fs::copy(&tool_hook_src, &tool_hook_dest);
        } else if let Ok(exe_path) = std::env::current_exe() {
            if let Some(res_dir) = exe_path.parent().and_then(|p| p.parent()).map(|p| p.join("Resources")) {
                let bundled = res_dir.join(tool_opt.script);
                if bundled.exists() {
                    let _ = std::fs::copy(&bundled, &tool_hook_dest);
                }
            }
        }
        #[cfg(unix)]
        if tool_hook_dest.exists() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tool_hook_dest, std::fs::Permissions::from_mode(0o755));
        }
    }

    match config.install_method {
        AgentInstallMethod::JsonSettings { hook_event, matcher } => {
            // Ensure settings dir exists
            if let Some(parent) = config.settings_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create settings dir: {}", e))?;
            }

            let mut settings: serde_json::Value = if config.settings_path.exists() {
                let content = std::fs::read_to_string(&config.settings_path)
                    .map_err(|e| format!("Failed to read settings: {}", e))?;
                serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
            } else {
                serde_json::json!({})
            };

            let hook_entry = serde_json::json!({
                "matcher": matcher,
                "command": hook_dest.to_string_lossy()
            });

            let obj = settings.as_object_mut().ok_or("Invalid settings format")?;

            if let Some(pre_hooks) = obj.get_mut("hooks")
                .and_then(|h| h.get_mut(hook_event))
                .and_then(|p| p.as_array_mut())
            {
                let already = pre_hooks.iter().any(|h| {
                    let direct = h.get("command").and_then(|c| c.as_str())
                        .map_or(false, |c| c.contains("terse"));
                    let nested = h.get("hooks").and_then(|hs| hs.as_array())
                        .map_or(false, |hs| hs.iter().any(|inner| {
                            inner.get("command").and_then(|c| c.as_str())
                                .map_or(false, |c| c.contains("terse"))
                        }));
                    direct || nested
                });
                if !already {
                    pre_hooks.push(hook_entry);
                }
            } else {
                if !obj.contains_key("hooks") {
                    obj.insert("hooks".to_string(), serde_json::json!({}));
                }
                let h = obj.get_mut("hooks").unwrap().as_object_mut().unwrap();
                h.insert(hook_event.to_string(), serde_json::json!([hook_entry]));
            }

            // Register the tool optimizer hook entry if this agent supports it
            if let Some(ref tool_opt) = config.tool_optimizer {
                let home = dirs::home_dir().ok_or("Cannot find home directory")?;
                let tool_hook_path = home.join(".terse").join(tool_opt.script);
                if tool_hook_path.exists() {
                    let tool_event = tool_opt.hook_event;
                    let tool_entry = serde_json::json!({
                        "matcher": tool_opt.matcher,
                        "hooks": [{
                            "type": "command",
                            "command": tool_hook_path.to_string_lossy()
                        }]
                    });
                    // Ensure hooks.{tool_event} array exists
                    let hooks_obj = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
                    if let Some(hooks_map) = hooks_obj.as_object_mut() {
                        let event_arr = hooks_map.entry(tool_event)
                            .or_insert_with(|| serde_json::json!([]));
                        if let Some(arr) = event_arr.as_array_mut() {
                            let has_tool_hook = arr.iter().any(|h| {
                                h.get("matcher").and_then(|m| m.as_str())
                                    .map_or(false, |m| m.contains(&tool_opt.matcher[..3]))
                            });
                            if !has_tool_hook {
                                arr.push(tool_entry);
                            }
                        }
                    }
                }
            }

            std::fs::write(&config.settings_path, serde_json::to_string_pretty(&settings).unwrap())
                .map_err(|e| format!("Failed to write settings: {}", e))?;

            Ok(serde_json::json!({
                "installed": true,
                "agent": agent_id,
                "hookPath": hook_dest.to_string_lossy(),
                "settingsPath": config.settings_path.to_string_lossy(),
            }))
        }

        AgentInstallMethod::Toml => {
            // Codex CLI: append hook config to codex.toml
            if let Some(parent) = config.settings_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create codex dir: {}", e))?;
            }

            let existing = if config.settings_path.exists() {
                std::fs::read_to_string(&config.settings_path).unwrap_or_default()
            } else {
                String::new()
            };

            if existing.contains("terse-hook") {
                return Ok(serde_json::json!({
                    "installed": true,
                    "agent": agent_id,
                    "hookPath": hook_dest.to_string_lossy(),
                    "settingsPath": config.settings_path.to_string_lossy(),
                    "alreadyInstalled": true,
                }));
            }

            let toml_entry = format!(
                "\n\n# Terse token compression hook\n[[hooks.pre_tool_use]]\nmatcher = \"shell\"\ncommand = \"{}\"\n",
                hook_dest.to_string_lossy()
            );

            std::fs::write(&config.settings_path, existing + &toml_entry)
                .map_err(|e| format!("Failed to write codex.toml: {}", e))?;

            Ok(serde_json::json!({
                "installed": true,
                "agent": agent_id,
                "hookPath": hook_dest.to_string_lossy(),
                "settingsPath": config.settings_path.to_string_lossy(),
            }))
        }

        AgentInstallMethod::DropFile => {
            // Copilot CLI / OpenClaw: just copy the hook to the target directory
            if let Some(parent) = config.settings_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create hooks dir: {}", e))?;
            }

            std::fs::copy(&hook_dest, &config.settings_path)
                .map_err(|e| format!("Failed to install hook: {}", e))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perms = std::fs::Permissions::from_mode(0o755);
                let _ = std::fs::set_permissions(&config.settings_path, perms);
            }

            Ok(serde_json::json!({
                "installed": true,
                "agent": agent_id,
                "hookPath": config.settings_path.to_string_lossy(),
            }))
        }
    }
}

/// Check if the Terse hook is installed for a given agent (or all agents).
#[tauri::command]
fn check_agent_hook(agent: Option<String>) -> serde_json::Value {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return serde_json::json!({ "installed": false }),
    };

    // If a specific agent is requested, check just that one
    if let Some(ref agent_id) = agent {
        return check_single_agent_hook(&home, agent_id);
    }

    // Otherwise check all agents
    let agents = ["claude-code", "cursor", "cline", "codex", "copilot", "openclaw", "windsurf"];
    let mut results = serde_json::Map::new();
    for a in &agents {
        let status = check_single_agent_hook(&home, a);
        results.insert(a.to_string(), status);
    }
    serde_json::Value::Object(results)
}

fn check_single_agent_hook(home: &std::path::Path, agent: &str) -> serde_json::Value {
    match agent {
        "claude-code" => {
            let settings_path = home.join(".claude/settings.json");
            check_json_hook(&settings_path, "PreToolUse")
        }
        "cursor" => {
            let settings_path = home.join(".cursor/hooks.json");
            check_json_hook(&settings_path, "beforeShellExecution")
        }
        "cline" => {
            let settings_path = home.join(".cline/settings.json");
            check_json_hook(&settings_path, "PreToolUse")
        }
        "codex" => {
            let toml_path = home.join(".codex/codex.toml");
            if toml_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&toml_path) {
                    return serde_json::json!({ "installed": content.contains("terse-hook") });
                }
            }
            serde_json::json!({ "installed": false })
        }
        "copilot" => {
            let hook_path = home.join(".github-copilot/hooks/preToolUse/terse-hook-copilot.sh");
            serde_json::json!({ "installed": hook_path.exists() })
        }
        "openclaw" => {
            let hook_path = home.join(".openclaw/hooks/terse-hook-openclaw.ts");
            serde_json::json!({ "installed": hook_path.exists() })
        }
        "windsurf" => {
            let settings_path = home.join(".windsurf/hooks.json");
            check_json_hook(&settings_path, "preAction")
        }
        _ => serde_json::json!({ "installed": false, "error": "unknown agent" }),
    }
}

fn check_json_hook(settings_path: &std::path::Path, hook_event: &str) -> serde_json::Value {
    if !settings_path.exists() {
        return serde_json::json!({ "installed": false });
    }
    if let Ok(content) = std::fs::read_to_string(settings_path) {
        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(hooks) = settings.get("hooks")
                .and_then(|h| h.get(hook_event))
                .and_then(|p| p.as_array())
            {
                let installed = hooks.iter().any(|h| {
                    let direct = h.get("command").and_then(|c| c.as_str())
                        .map_or(false, |c| c.contains("terse"));
                    let nested = h.get("hooks").and_then(|hs| hs.as_array())
                        .map_or(false, |hs| hs.iter().any(|inner| {
                            inner.get("command").and_then(|c| c.as_str())
                                .map_or(false, |c| c.contains("terse"))
                        }));
                    direct || nested
                });
                return serde_json::json!({ "installed": installed });
            }
        }
    }
    serde_json::json!({ "installed": false })
}

/// Read compression stats from both hook tracking files and sync to stats_store
#[tauri::command]
fn get_hook_stats(state: tauri::State<'_, AppState>, app: AppHandle) -> serde_json::Value {
    let tmp = std::env::temp_dir();
    let stats_files = [
        tmp.join("terse-compress-stats.jsonl"),       // Bash compression
        tmp.join("terse-tool-optimize-stats.jsonl"),   // Read/Grep optimization
    ];

    let any_exists = stats_files.iter().any(|f| f.exists());
    if !any_exists {
        return serde_json::json!({
            "totalSaved": 0,
            "totalOriginal": 0,
            "totalOptimized": 0,
            "compressions": 0,
        });
    }

    let mut total_saved: u64 = 0;
    let mut total_original: u64 = 0;
    let mut total_optimized: u64 = 0;
    let mut count: u64 = 0;
    // Track new entries since last sync
    let mut new_original: u64 = 0;
    let mut new_optimized: u64 = 0;

    let last_synced = state.hook_stats_synced.lock().unwrap_or_else(|e| e.into_inner()).clone();

    for stats_file in &stats_files {
        if let Ok(content) = std::fs::read_to_string(stats_file) {
            for line in content.lines() {
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                    let saved = entry["saved"].as_u64().unwrap_or(0);
                    let orig = entry["originalTokens"].as_u64().unwrap_or(0);
                    let opt = entry["optimizedTokens"].as_u64().unwrap_or(0);
                    total_saved += saved;
                    total_original += orig;
                    total_optimized += opt;
                    count += 1;
                    if count > last_synced {
                        new_original += orig;
                        new_optimized += opt;
                    }
                }
            }
        }
    }

    // Sync new entries into stats_store and consume quota (1 per compression)
    let new_count = count.saturating_sub(last_synced);
    if new_count > 0 && new_original > 0 {
        let mut store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
        store.record_optimization("agent", new_original, new_optimized);

        // Each hook compression costs 0.3 quota
        let mut lic = state.license.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..new_count {
            lic.record_optimization_cost(0.3);
        }
        let exhausted = !lic.can_optimize();
        let remaining = lic.remaining_optimizations();
        drop(lic);

        *state.hook_stats_synced.lock().unwrap_or_else(|e| e.into_inner()) = count;

        let _ = app.emit("quota-updated", ());

        if exhausted {
            let mut monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
            let types: Vec<String> = monitor.sessions.keys().cloned().collect();
            for t in &types {
                monitor.disconnect_agent(t);
            }
            let _ = app.emit("quota-exhausted", serde_json::json!({
                "remaining": remaining,
                "message": "Weekly optimization quota reached. Upgrade your plan or wait until next week."
            }));
        }
    }

    serde_json::json!({
        "totalSaved": total_saved,
        "totalOriginal": total_original,
        "totalOptimized": total_optimized,
        "compressions": count,
        "percentSaved": if total_original > 0 {
            ((total_saved as f64 / total_original as f64) * 100.0).round() as u64
        } else { 0 },
    })
}

// ── Stats Commands ──

#[tauri::command]
fn get_stats(period: String, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
    store.get_stats(&period)
}

#[tauri::command]
fn navigate_to_stats(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // Use Tauri's internal URL scheme
        if let Ok(url) = "tauri://localhost/stats.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/stats.html');");
        }
    }
}

#[tauri::command]
fn navigate_back(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = "tauri://localhost/index.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/index.html');");
        }
    }
}

#[tauri::command]
fn record_optimization(source: String, original_tokens: u64, optimized_tokens: u64, state: tauri::State<'_, AppState>) {
    let mut store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
    store.record_optimization(&source, original_tokens, optimized_tokens);
}

#[tauri::command]
fn request_accessibility() -> bool {
    true
}

#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("[terse-js] {}", msg);
}

#[tauri::command]
fn emit_popup_update(data: serde_json::Value, app: AppHandle) {
    let _ = app.emit("popup-update", &data);
}

#[tauri::command]
fn send_enter(pid: u32, state: tauri::State<'_, AppState>) {
    state.key_monitors.send_enter(pid);
}

#[tauri::command]
fn clear_popup_state(state: tauri::State<'_, AppState>) {
    *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
}

// ── Spellcheck via terse-ax ──

#[tauri::command]
async fn spellcheck(text: String) -> Result<String, String> {
    capture::spellcheck_text(&text).await
}

// ── Get front app info ──

#[tauri::command]
async fn get_front_app() -> serde_json::Value {
    let info = capture::get_front_app().await;
    serde_json::json!({
        "name": info.name,
        "pid": info.pid,
        "bundleId": info.bundle_id,
        "title": info.title,
    })
}

// ── Read text from app ──

#[tauri::command]
async fn read_ax_app(pid: u32, hint_x: Option<f64>, hint_y: Option<f64>) -> serde_json::Value {
    let result = capture::read_ax_app(pid, hint_x, hint_y).await;
    serde_json::json!({
        "text": result.text,
        "method": result.method,
        "ok": result.ok,
    })
}

// ── Bridge commands ──

#[tauri::command]
async fn is_bridge_alive() -> bool {
    capture::is_bridge_alive().await
}

#[tauri::command]
async fn read_bridge() -> serde_json::Value {
    let result = capture::read_bridge().await;
    serde_json::json!({
        "text": result.text,
        "method": result.method,
        "ok": result.ok,
        "focused": result.focused,
    })
}

#[tauri::command]
async fn write_bridge(text: String) -> serde_json::Value {
    let result = capture::write_bridge(&text).await;
    serde_json::json!({"ok": result})
}

#[tauri::command]
async fn write_to_app(app_name: String, text: String, pid: u32) -> serde_json::Value {
    let result = capture::write_to_app(&app_name, &text, pid).await;
    serde_json::json!({"ok": result.ok, "method": result.method})
}

#[tauri::command]
async fn activate_app(app_name: String) -> bool {
    capture::activate_app(&app_name).await;
    true
}

#[tauri::command]
async fn install_bridge() -> serde_json::Value {
    capture::install_bridge().await
}

// ── License commands ──

#[tauri::command]
fn get_license(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let lic = lock_or_recover(&state.license);
    lic.get_snapshot()
}

#[tauri::command]
fn set_clerk_user(state: tauri::State<'_, AppState>, clerk_user_id: String) {
    let mut lic = lock_or_recover(&state.license);
    lic.clerk_user_id = Some(clerk_user_id);
    lic.save();
}

#[tauri::command]
async fn verify_license_remote(state: tauri::State<'_, AppState>, clerk_user_id: String) -> Result<serde_json::Value, String> {
    match license::verify_license(&clerk_user_id).await {
        Some(updated) => {
            let snapshot = updated.get_snapshot();
            let mut lic = lock_or_recover(&state.license);
            *lic = updated;
            Ok(snapshot)
        }
        None => {
            let lic = lock_or_recover(&state.license);
            Ok(lic.get_snapshot())
        }
    }
}

#[tauri::command]
fn check_can_optimize(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let lic = lock_or_recover(&state.license);
    serde_json::json!({
        "allowed": lic.can_optimize(),
        "remaining": lic.remaining_optimizations(),
        "tier": lic.tier,
    })
}

#[tauri::command]
fn record_optimization_usage(state: tauri::State<'_, AppState>, app: AppHandle) {
    let mut lic = lock_or_recover(&state.license);
    // Each user-initiated optimization (Send click, Optimize button) costs 0.5 quota
    lic.record_optimization_cost(0.5);
    let exhausted = !lic.can_optimize();
    let remaining = lic.remaining_optimizations();
    drop(lic);

    if exhausted {
        let mut monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
        let types: Vec<String> = monitor.sessions.keys().cloned().collect();
        for t in &types {
            monitor.disconnect_agent(t);
        }
        let _ = app.emit("quota-exhausted", serde_json::json!({
            "remaining": remaining,
            "message": "Weekly optimization quota reached. Upgrade your plan or wait until next week."
        }));
    }
}

#[tauri::command]
fn check_can_add_session(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let sessions = lock_or_recover(&state.sessions);
    let lic = lock_or_recover(&state.license);
    serde_json::json!({
        "allowed": lic.can_add_session(sessions.len()),
        "current": sessions.len(),
        "max": lic.limits.max_sessions,
        "tier": lic.tier,
    })
}

// ── Auth commands ──

#[tauri::command]
fn get_auth(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let auth = lock_or_recover(&state.auth);
    serde_json::json!({
        "signedIn": auth.signed_in,
        "clerkUserId": auth.clerk_user_id,
        "email": auth.email,
        "imageUrl": auth.image_url,
        "firstName": auth.first_name,
    })
}

#[tauri::command]
fn save_auth(state: tauri::State<'_, AppState>, clerk_user_id: String, email: String, image_url: String, first_name: String) {
    let mut auth = lock_or_recover(&state.auth);
    auth.clerk_user_id = Some(clerk_user_id.clone());
    auth.email = Some(email);
    auth.image_url = Some(image_url);
    auth.first_name = Some(first_name);
    auth.signed_in = true;
    auth.save();

    // Also update license with clerk user id
    let mut lic = lock_or_recover(&state.license);
    lic.clerk_user_id = Some(clerk_user_id);
    lic.save();
}

#[tauri::command]
fn sign_out(state: tauri::State<'_, AppState>) {
    let mut auth = lock_or_recover(&state.auth);
    auth.sign_out();

    // Reset license to free
    let mut lic = lock_or_recover(&state.license);
    lic.clerk_user_id = None;
    lic.tier = "free".to_string();
    lic.limits = license::PlanLimits {
        optimizations_per_week: 200,
        max_sessions: 1,
        max_devices: 1,
    };
    lic.save();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            // Remove macOS quarantine & translocation — prevents event system breakage
            // in DMG-installed apps (see tauri-apps/tauri#9052)
            if let Ok(exe) = std::env::current_exe() {
                // Find the .app bundle root (go up from Contents/MacOS/terse)
                if let Some(app_bundle) = exe.parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                {
                    let bundle_path = app_bundle.to_string_lossy();
                    // Check if running under App Translocation
                    if bundle_path.contains("/AppTranslocation/") {
                        eprintln!("[terse] WARNING: Running under App Translocation at {}", bundle_path);
                        eprintln!("[terse] Please move Terse.app to /Applications folder for full functionality");
                    }
                    // Remove quarantine from the entire app bundle
                    let _ = std::process::Command::new("xattr")
                        .args(["-r", "-d", "com.apple.quarantine", &*bundle_path])
                        .output();
                    eprintln!("[terse] cleared quarantine for {}", bundle_path);
                }
            }

            // Create popup window
            let monitor = app.primary_monitor()?.unwrap();
            let screen_width = monitor.size().width as f64 / monitor.scale_factor();
            let popup_w = 540.0;
            let popup_x = ((screen_width - popup_w) / 2.0) as f64;

            let _popup = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("popup.html".into()))
                .title("Terse Popup")
                .inner_size(popup_w, 200.0)
                .position(popup_x, 8.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .visible_on_all_workspaces(true)
                .visible(false)
                .build()?;

            // macOS: force transparent bg + rounded corners on both windows
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSWindow, NSColor, NSView};
                use cocoa::base::{nil, id, YES, NO};
                use cocoa::foundation::NSRect;
                use objc::{msg_send, sel, sel_impl, class};

                fn make_rounded(win: &tauri::WebviewWindow, radius: f64) {
                    if let Ok(raw) = win.ns_window() {
                        let ns_win = raw as id;
                        unsafe {
                            // Make window background transparent
                            ns_win.setBackgroundColor_(NSColor::clearColor(nil));
                            ns_win.setOpaque_(NO);
                            ns_win.setHasShadow_(YES);

                            // Get content view and set corner radius via CALayer
                            let content_view: id = msg_send![ns_win, contentView];
                            let _: () = msg_send![content_view, setWantsLayer: YES];
                            let layer: id = msg_send![content_view, layer];
                            let _: () = msg_send![layer, setCornerRadius: radius];
                            let _: () = msg_send![layer, setMasksToBounds: YES];
                        }
                    }
                }
                if let Some(w) = app.get_webview_window("main") { make_rounded(&w, 16.0); }
                if let Some(w) = app.get_webview_window("popup") { make_rounded(&w, 16.0); }
            }

            // Tray icon
            let _tray = TrayIconBuilder::new()
                .tooltip("Terse")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Register global shortcuts
            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+T", move |_app, _shortcut, _event| {
                if let Some(win) = app_handle.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            })?;

            let app_handle2 = app.handle().clone();
            app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+C", move |_app, _shortcut, _event| {
                // Trigger capture on the active session
                let app = app_handle2.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let session_info = {
                        let active_id = state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
                        let candidate_id = state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner());
                        let sid = active_id.or(*candidate_id);
                        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        sid.and_then(|id| sessions.get(&id).cloned())
                    };
                    if let Some(session) = session_info {
                        let result = capture::read_selection(&session.name).await;
                        if result.text.trim().len() >= 5 {
                            let trimmed = result.text.trim().to_string();
                            *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = trimmed.clone();
                            if let Some(s) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&session.id) {
                                s.last_text = trimmed.clone();
                            }
                            let _ = app.emit("captured-text", serde_json::json!({
                                "text": trimmed,
                                "method": result.method,
                                "app": if session.title.is_empty() { &session.name } else { &session.title },
                                "sessionId": session.id,
                            }));
                        }
                    }
                });
            })?;

            // Start agent monitor scanning
            let app_handle3 = app.handle().clone();
            std::thread::spawn(move || {
                agent_monitor::start_scanning(app_handle3);
            });

            // Start combined focus + text polling
            let app_handle4 = app.handle().clone();
            std::thread::spawn(move || {
                start_polling(app_handle4);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            remove_session,
            enter_pick_mode,
            capture_now,
            replace_in_target,
            apply_to_clipboard,
            get_settings,
            update_settings,
            set_auto_mode,
            close_window,
            set_popup_minimized,
            move_popup_by,
            resize_popup,
            debug_log,
            get_agent_detections,
            get_agent_sessions,
            accept_agent,
            dismiss_agent,
            disconnect_agent,
            get_agent_analytics,
            get_agent_plan_info,
            install_agent_hook,
            check_agent_hook,
            get_hook_stats,
            get_stats,
            navigate_to_stats,
            navigate_back,
            record_optimization,
            request_accessibility,
            debug_log,
            emit_popup_update,
            send_enter,
            clear_popup_state,
            spellcheck,
            get_front_app,
            read_ax_app,
            is_bridge_alive,
            read_bridge,
            write_bridge,
            write_to_app,
            activate_app,
            install_bridge,
            get_license,
            set_clerk_user,
            verify_license_remote,
            check_can_optimize,
            record_optimization_usage,
            check_can_add_session,
            get_auth,
            save_auth,
            sign_out,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Combined Focus + Text Polling ──

const _SETTLE_DELAY: u64 = 600; // ms to wait after last change before auto-replacing

fn start_polling(app: AppHandle) {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let mut last_bundle_id = String::new();
        let mut focus_tick = 0u64;
        eprintln!("[terse] polling thread started");

        loop {
            // Focus poll every 300ms, text poll every 600ms (interleaved)
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            focus_tick += 1;

            let state = app.state::<AppState>();

            // ── Guard checks ──
            let session_count = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).len();
            if session_count == 0 {
                if focus_tick % 10 == 0 { eprintln!("[terse] waiting for sessions..."); }
                continue;
            }
            if *state.is_picking.lock().unwrap_or_else(|e| e.into_inner()) { continue; }

            // ── FOCUS POLLING (every tick = 300ms) ──
            let app_info = capture::get_front_app().await;
            if app_info.name.is_empty() || app_info.name == "?" { continue; }

            let sig = if !app_info.bundle_id.is_empty() {
                app_info.bundle_id.clone()
            } else {
                app_info.name.clone()
            };

            if sig != last_bundle_id {
                last_bundle_id = sig.clone();

                // Skip if Terse itself
                let name_lower = app_info.name.to_lowercase();
                if app_info.bundle_id == "com.terse.app"
                    || app_info.bundle_id == "com.github.Electron"
                    || app_info.bundle_id == "com.github.electron"
                    || name_lower == "terse"
                    || name_lower == "electron"
                {
                    continue;
                }

                // Find matching session
                let session_match = {
                    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    let mut found = None;
                    for s in sessions.values_mut() {
                        if s.pid == app_info.pid
                            || (!s.bundle_id.is_empty() && s.bundle_id == app_info.bundle_id)
                            || s.name == app_info.name
                        {
                            // Update PID if matched by name/bundle
                            if s.pid != app_info.pid && (s.bundle_id == app_info.bundle_id || s.name == app_info.name) {
                                s.pid = app_info.pid;
                            }
                            found = Some(s.clone());
                            break;
                        }
                    }
                    found
                };

                if let Some(session) = session_match {
                    let prev_candidate = *state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner());

                    // Switching sessions
                    if prev_candidate != Some(session.id) {
                        // Stop key monitor on old session
                        if let Some(old_id) = prev_candidate {
                            let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(old) = sessions.get(&old_id) {
                                if old.key_monitor_started && old.pid != session.pid {
                                    state.key_monitors.stop_monitor(old.pid);
                                    // Mark as stopped (need mut)
                                    drop(sessions);
                                    if let Some(old) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&old_id) {
                                        old.key_monitor_started = false;
                                    }
                                }
                            }
                        }

                        *state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(session.id);
                        *state.active_session_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(session.id);
                        *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
                        *state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) = true;
                        *state.is_auto_replacing.lock().unwrap_or_else(|e| e.into_inner()) = false;
                        *state.auto_replaced.lock().unwrap_or_else(|e| e.into_inner()) = false;

                        // Switch popup to new session instantly (no hide/show flicker)
                        let _ = app.emit("popup-show", serde_json::json!({
                            "app": if session.title.is_empty() { &session.name } else { &session.title },
                            "sessionId": session.id,
                        }));
                        if let Some(popup) = app.get_webview_window("popup") {
                            if !popup.is_visible().unwrap_or(true) {
                                let _ = popup.show();
                            }
                        }
                        let _ = app.emit("sessions-updated", ());
                    }
                } else {
                    // Not a connected app — hide popup
                    let prev_active = *state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
                    *state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    *state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) = false;
                    if prev_active.is_some() {
                        let minimized = *state.popup_minimized.lock().unwrap_or_else(|e| e.into_inner());
                        if !minimized {
                            if let Some(popup) = app.get_webview_window("popup") {
                                if popup.is_visible().unwrap_or(false) {
                                    let _ = popup.hide();
                                    let _ = app.emit("popup-hide", ());
                                }
                            }
                        }
                        *state.active_session_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
                        let _ = app.emit("sessions-updated", ());
                    }
                    continue;
                }
            }

            // ── TEXT POLLING (every other tick = 600ms) ──
            if focus_tick % 2 != 0 { continue; }

            let active_id = *state.active_session_id.lock().unwrap_or_else(|e| e.into_inner());
            let active_id = match active_id {
                Some(id) => id,
                None => { eprintln!("[terse-poll] no active session"); continue; }
            };

            if *state.is_auto_replacing.lock().unwrap_or_else(|e| e.into_inner()) { continue; }

            let session = {
                let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                sessions.get(&active_id).cloned()
            };
            let session = match session {
                Some(s) => s,
                None => { eprintln!("[terse-poll] session {} not found", active_id); continue; }
            };

            eprintln!("[terse-poll] polling session {} ({}), bundle={}, ax_blind={}",
                session.id, session.name, session.bundle_id, is_ax_blind(&session.bundle_id));

            let mut result = capture::CaptureResult::default();
            let mut user_in_text_input = false;

            if is_ax_blind(&session.bundle_id) {
                // ── VS Code / Cursor: bridge (editor) or key monitor (terminal/webview) ──
                eprintln!("[terse-poll] checking bridge...");
                let bridge_up = capture::is_bridge_alive().await;
                eprintln!("[terse-poll] bridge_up={}", bridge_up);
                let mut in_editor = false;
                if bridge_up {
                    let br = capture::read_bridge().await;
                    if br.focused && br.ok && br.text.trim().len() >= 5 {
                        result = br;
                        user_in_text_input = true;
                        in_editor = true;
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(s) = sessions.get_mut(&active_id) {
                            s.read_method = "bridge".to_string();
                        }
                    }
                }

                if !in_editor {
                    eprintln!("[terse-poll] not in editor, using key monitor");
                    // Use key monitor
                    {
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(s) = sessions.get_mut(&active_id) {
                            s.read_method = "keymonitor".to_string();
                        }
                    }

                    let km_running = state.key_monitors.is_running(session.pid);
                    eprintln!("[terse-poll] km_running={} for pid={}", km_running, session.pid);
                    if !km_running {
                        eprintln!("[terse-poll] starting key monitor for pid={}", session.pid);
                        let (enter_tx, mut enter_rx) = tokio::sync::mpsc::channel::<String>(8);
                        state.key_monitors.start_monitor(session.pid, enter_tx);

                        let auto_mode = state.auto_mode.lock().unwrap_or_else(|e| e.into_inner()).clone();
                        if auto_mode == "send" {
                            state.key_monitors.set_send_mode(session.pid, true);
                        }

                        {
                            let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(s) = sessions.get_mut(&active_id) {
                                s.key_monitor_started = true;
                            }
                        }

                        // Spawn handler for Enter interceptions in send mode
                        let app2 = app.clone();
                        let session_id = active_id;
                        tokio::spawn(async move {
                            while let Some(text) = enter_rx.recv().await {
                                handle_send_mode_enter(&text, session_id, &app2).await;
                            }
                        });
                    }

                    if let Some((text, _)) = state.key_monitors.get_buffer(session.pid) {
                        if text.trim().len() >= 3 {
                            result = capture::CaptureResult {
                                text, method: "keymonitor".into(), ok: true, focused: false,
                            };
                            user_in_text_input = true;
                        }
                    }
                    if !user_in_text_input && !session.last_text.is_empty() {
                        result = capture::CaptureResult {
                            text: session.last_text.clone(),
                            method: "keymonitor-cached".into(), ok: true, focused: false,
                        };
                        user_in_text_input = true;
                    }
                }

                if !user_in_text_input {
                    // Show hint
                    if !*state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) {
                        *state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) = true;
                        let _ = app.emit("popup-show", serde_json::json!({
                            "app": if session.title.is_empty() { &session.name } else { &session.title },
                            "sessionId": session.id,
                                                    }));
                        if let Some(popup) = app.get_webview_window("popup") {
                            let _ = popup.show();
                        }
                    }
                    let bridge_missing = !capture::is_bridge_alive().await;
                    let _ = app.emit("popup-hint", serde_json::json!({
                        "app": if session.title.is_empty() { &session.name } else { &session.title },
                        "keyMonitor": true,
                        "axBlind": true,
                        "bridgeMissing": bridge_missing,
                    }));
                    continue;
                }
            } else if is_browser(&session.bundle_id) {
                // ── Browsers: AX reads URL bar, not page inputs. Use key monitor. ──
                {
                    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(s) = sessions.get_mut(&active_id) {
                        s.read_method = "keymonitor".to_string();
                    }
                }

                // Start key monitor if not running
                if !state.key_monitors.is_running(session.pid) {
                    let (enter_tx, mut enter_rx) = tokio::sync::mpsc::channel::<String>(8);
                    state.key_monitors.start_monitor(session.pid, enter_tx);

                    let auto_mode = state.auto_mode.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    if auto_mode == "send" {
                        state.key_monitors.set_send_mode(session.pid, true);
                    }

                    {
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(s) = sessions.get_mut(&active_id) {
                            s.key_monitor_started = true;
                        }
                    }

                    let app2 = app.clone();
                    let session_id = active_id;
                    tokio::spawn(async move {
                        while let Some(text) = enter_rx.recv().await {
                            handle_send_mode_enter(&text, session_id, &app2).await;
                        }
                    });
                }

                // Read from key monitor buffer
                if let Some((text, _)) = state.key_monitors.get_buffer(session.pid) {
                    if text.trim().len() >= 3 {
                        result = capture::CaptureResult {
                            text, method: "keymonitor".into(), ok: true, focused: false,
                        };
                        user_in_text_input = true;
                    }
                }
                if !user_in_text_input && !session.last_text.is_empty() {
                    result = capture::CaptureResult {
                        text: session.last_text.clone(),
                        method: "keymonitor-cached".into(), ok: true, focused: false,
                    };
                    user_in_text_input = true;
                }
            } else {
                // ── Other apps (Notes, Slack, etc.): AX works reliably ──
                let ax_result = capture::read_ax_app(
                    session.pid,
                    session.click_pos.map(|p| p.0),
                    session.click_pos.map(|p| p.1),
                ).await;

                if ax_result.ok && ax_result.text.trim().len() >= 5 {
                    user_in_text_input = true;
                    let method = ax_result.method.clone();
                    result = ax_result;
                    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(s) = sessions.get_mut(&active_id) {
                        s.read_method = method;
                    }
                } else {
                    // AX failed — fall back to key monitor
                    {
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(s) = sessions.get_mut(&active_id) {
                            s.read_method = "keymonitor".to_string();
                        }
                    }
                    if let Some((text, _)) = state.key_monitors.get_buffer(session.pid) {
                        if text.trim().len() >= 3 {
                            result = capture::CaptureResult {
                                text, method: "keymonitor".into(), ok: true, focused: false,
                            };
                            user_in_text_input = true;
                        }
                    }
                    if !user_in_text_input && !session.last_text.is_empty() {
                        result = capture::CaptureResult {
                            text: session.last_text.clone(),
                            method: "keymonitor-cached".into(), ok: true, focused: false,
                        };
                        user_in_text_input = true;
                    }
                }

                // Ensure key monitor runs for send/auto mode Enter interception
                let auto_mode = state.auto_mode.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if auto_mode != "off" && !state.key_monitors.is_running(session.pid) {
                    let (enter_tx, mut enter_rx) = tokio::sync::mpsc::channel::<String>(8);
                    state.key_monitors.start_monitor(session.pid, enter_tx);

                    if auto_mode == "send" {
                        state.key_monitors.set_send_mode(session.pid, true);
                    }

                    {
                        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(s) = sessions.get_mut(&active_id) {
                            s.key_monitor_started = true;
                        }
                    }

                    let app2 = app.clone();
                    let session_id = active_id;
                    tokio::spawn(async move {
                        while let Some(text) = enter_rx.recv().await {
                            handle_send_mode_enter(&text, session_id, &app2).await;
                        }
                    });
                }
            }

            // Ensure popup is visible
            if !*state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) {
                *state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) = true;
                let _ = app.emit("popup-show", serde_json::json!({
                    "app": if session.title.is_empty() { &session.name } else { &session.title },
                    "sessionId": session.id,
                                    }));
                if let Some(popup) = app.get_webview_window("popup") {
                    let _ = popup.show();
                }
            }

            eprintln!("[terse-poll] read: method={}, ok={}, text_len={}, in_input={}",
                result.method, result.ok, result.text.len(), user_in_text_input);

            if !user_in_text_input { continue; }

            // ── Process text ──
            let raw = result.text;
            let trimmed = raw.trim().to_string();
            eprintln!("[terse-poll] trimmed len={}, preview='{}'", trimmed.len(),
                safe_truncate(&trimmed, 60));

            // Detect cleared input
            let last_popup = state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if trimmed.len() < 2 && last_popup.len() > 2 {
                *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
                let _ = app.emit("popup-clear", ());
                continue;
            }
            if trimmed.len() < 5 { continue; }

            if trimmed != last_popup {
                let prev_text = last_popup.clone();
                *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = trimmed.clone();
                {
                    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(s) = sessions.get_mut(&active_id) {
                        s.last_text = trimmed.clone();
                    }
                }
                *state.last_text_change_time.lock().unwrap_or_else(|e| e.into_inner()) = now_ms();
                *state.auto_replaced.lock().unwrap_or_else(|e| e.into_inner()) = false;

                let is_deleting = trimmed.len() < prev_text.len();

                // Split: preserve the word currently being typed
                let ends_with_space = raw.ends_with(' ') || raw.ends_with('\n');

                let (text_to_optimize, current_word) = if !ends_with_space && !is_deleting {
                    if let Some(last_space_idx) = trimmed.rfind(' ') {
                        if last_space_idx > 0 {
                            (trimmed[..last_space_idx].to_string(), trimmed[last_space_idx..].to_string())
                        } else {
                            // First word — just preview
                            let _ = app.emit("popup-update", serde_json::json!({
                                "app": if session.title.is_empty() { &session.name } else { &session.title },
                                "original": &trimmed,
                                "optimized": &trimmed,
                                "stats": {"originalTokens": estimate_tokens(&trimmed), "optimizedTokens": estimate_tokens(&trimmed), "percentSaved": 0, "techniquesApplied": []},
                                "suggestions": [],
                                "method": &result.method,
                                "sessionId": session.id,
                            }));
                            continue;
                        }
                    } else {
                        // Single word — preview only
                        let _ = app.emit("popup-update", serde_json::json!({
                            "app": if session.title.is_empty() { &session.name } else { &session.title },
                            "original": &trimmed,
                            "optimized": &trimmed,
                            "stats": {"originalTokens": estimate_tokens(&trimmed), "optimizedTokens": estimate_tokens(&trimmed), "percentSaved": 0, "techniquesApplied": []},
                            "suggestions": [],
                            "method": &result.method,
                            "sessionId": session.id,
                        }));
                        continue;
                    }
                } else {
                    (trimmed.clone(), String::new())
                };

                // Send text to webview for optimization
                eprintln!("[terse-poll] emitting optimize-request, text_len={}", text_to_optimize.len());
                let _ = app.emit("optimize-request", serde_json::json!({
                    "text": &text_to_optimize,
                    "currentWord": &current_word,
                    "app": if session.title.is_empty() { &session.name } else { &session.title },
                    "method": &result.method,
                    "sessionId": session.id,
                    "isDeleting": is_deleting,
                    "autoMode": *state.auto_mode.lock().unwrap_or_else(|e| e.into_inner()),
                    "autoReplaced": *state.auto_replaced.lock().unwrap_or_else(|e| e.into_inner()),
                }));

                // Auto-replace settle timer is handled by webview via
                // the auto-replace-request event (see popup.js / tauri-bridge.js)
            }
        }
    });
}

/// Handle Enter intercepted in "Send" mode — optimize then submit
async fn handle_send_mode_enter(text: &str, session_id: u32, app: &AppHandle) {
    let state = app.state::<AppState>();

    // Skip optimization if an agent session is active — agent mode is monitor-only,
    // pressing Enter in a terminal with an agent connected should pass through normally
    {
        let monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
        if !monitor.sessions.is_empty() {
            // Agent connected — don't intercept, let Enter pass through
            if let Some(session) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&session_id) {
                state.key_monitors.send_enter(session.pid);
            }
            return;
        }
    }

    let session = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(&session_id).cloned()
    };
    let session = match session {
        Some(s) => s,
        None => return,
    };

    // Prefer AX-captured text (full content) over key monitor buffer (partial keystrokes)
    let best_text = {
        let last_ax = state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if last_ax.trim().len() >= text.trim().len() && last_ax.trim().len() >= 3 {
            last_ax
        } else {
            text.trim().to_string()
        }
    };

    if best_text.trim().len() < 3 {
        // Nothing to optimize — just send Enter through
        state.key_monitors.send_enter(session.pid);
        return;
    }

    // Send to webview for optimization via event
    let _ = app.emit("send-mode-optimize", serde_json::json!({
        "text": best_text.trim(),
        "sessionId": session_id,
        "pid": session.pid,
        "bundleId": session.bundle_id,
        "appName": session.name,
        "readMethod": session.read_method,
    }));
}

/// Truncate a string at a char boundary, never panicking on multi-byte UTF-8
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Rough token estimate (chars / 4)
fn estimate_tokens(text: &str) -> u64 {
    (text.len() as f64 / 4.0).ceil() as u64
}
