mod capture;
mod agent_monitor;
mod agent_usage_scan;
mod stats_store;
mod pricing;
mod license;
mod cowork;
mod pet_store;
mod farm_store;
mod doctor;
mod notifications;
mod circuit;
mod digest;
mod mcp_manager;
mod connectivity;
mod prompt_store;
mod session_history;

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

/// CREATE_NO_WINDOW — suppresses the flashing console window when spawning child
/// processes (powershell, cmd, taskkill, curl, terse-uia.exe) on Windows.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a `std::process::Command` that never flashes a console window. Every
/// child-process spawn in the app goes through this (or capture.rs's tokio twin)
/// so background scans/polls stay invisible.
pub fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
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
    pub pet_store: Mutex<pet_store::PetStore>,
    pub farm_store: Mutex<farm_store::FarmStore>,
    pub license: Mutex<license::License>,
    pub auth: Mutex<license::AuthState>,
    pub cowork: Mutex<cowork::CoworkState>,
    pub is_picking: Mutex<bool>,
    pub is_auto_replacing: Mutex<bool>,
    pub auto_replaced: Mutex<bool>,
    pub last_text_change_time: Mutex<u64>,
    pub popup_visible_for_text: Mutex<bool>,
    pub key_monitors: capture::KeyMonitorState,
    pub hook_stats_synced: Mutex<u64>,
    pub alerts: Mutex<notifications::AlertCenter>,
    pub circuit: Mutex<circuit::CircuitBreaker>,
    pub prompt_store: Mutex<prompt_store::PromptStore>,
    /// App name that was frontmost when the prompt palette was opened, so an
    /// inserted prompt is pasted back into it (the palette itself steals focus).
    pub palette_target: Mutex<String>,
    pub session_history: Mutex<session_history::SessionHistoryStore>,
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
            pet_store: Mutex::new(pet_store::PetStore::new()),
            farm_store: Mutex::new(farm_store::FarmStore::new()),
            license: Mutex::new(license::License::load()),
            auth: Mutex::new(license::AuthState::load()),
            cowork: Mutex::new(cowork::CoworkState::new()),
            is_picking: Mutex::new(false),
            is_auto_replacing: Mutex::new(false),
            auto_replaced: Mutex::new(false),
            last_text_change_time: Mutex::new(0),
            popup_visible_for_text: Mutex::new(false),
            key_monitors: capture::KeyMonitorState::new(),
            hook_stats_synced: Mutex::new(0),
            alerts: Mutex::new(notifications::AlertCenter::new()),
            circuit: Mutex::new(circuit::CircuitBreaker::new()),
            prompt_store: Mutex::new(prompt_store::PromptStore::new()),
            palette_target: Mutex::new(String::new()),
            session_history: Mutex::new(session_history::SessionHistoryStore::new()),
        }
    }
}

// ── App detection (Windows: match by process executable name) ──
const ELECTRON_APP_INFO: &[(&str, &str, &str)] = &[
    ("Code.exe", "Code", "VS Code"),
    ("Code - Insiders.exe", "Code - Insiders", "VS Code Insiders"),
    ("code-oss.exe", "Code - OSS", "VS Code OSS"),
    ("Cursor.exe", "Cursor", "Cursor"),
    ("Claude.exe", "Claude", "Claude Code"),
];

fn is_ax_blind(bundle_id: &str) -> bool {
    ELECTRON_APP_INFO.iter().any(|(bid, _, _)| *bid == bundle_id)
}

/// Browsers where UI Automation reads the URL bar instead of page inputs.
/// These should use key monitor for text capture.
/// On Windows, we match by process executable name.
const BROWSER_BUNDLES: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "Arc.exe",
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
    // On Windows: %APPDATA%/Code/User/settings.json (or .cursor)
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
        dirs::home_dir().unwrap_or_default().join("AppData").join("Roaming").to_string_lossy().to_string()
    });
    let appdata_path = std::path::PathBuf::from(&appdata);
    let mut candidate_paths = vec![
        appdata_path.join(settings_dir).join("User/settings.json"),
    ];
    if settings_dir == "Cursor" {
        let home = dirs::home_dir().unwrap_or_default();
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
                "msg": format!("{}: accessibility enabled. Please reload {} (Ctrl+Shift+P \u{2192} \"Reload Window\") for live detection.", label, label),
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
            || name_lower == "terse.exe";
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
                || session.bundle_id.contains("Code.exe") {
                // Terminal/editor without UIA access (VS Code terminal, etc.)
                // Use Ctrl+A (select all) + paste
                capture::write_via_clipboard_terminal(&text).await
            } else {
                // For all other apps (browsers, editors, any app) — use clipboard:
                // Ctrl+A to select all, Ctrl+V to paste. This is the most reliable
                // write method across all Windows apps.
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
    // Windows: use PowerShell Set-Clipboard (console window suppressed)
    let _ = {
        let mut __c = Command::new("powershell");
        __c.creation_flags(CREATE_NO_WINDOW);
        __c
    }
        .args(["-NoProfile", "-Command", &format!("Set-Clipboard -Value '{}'", text.replace('\'', "''"))])
        .output()
        .await;
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
                "message": "No active subscription. Start a free trial to use Terse."
            }));
            return Err("Quota exhausted. Upgrade your plan or wait until next week.".to_string());
        }
    }

    let snapshot = {
        let mut monitor = lock_or_recover(&state.agent_monitor);
        // Clear suppression so this agent can be detected again
        monitor.unsuppress_agent(&agent_type);
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
fn activate_session(session_id: Option<u32>, agent_type: Option<String>, state: tauri::State<'_, AppState>, app: AppHandle) -> bool {
    // Activate a session by ID (manual) or agent_type (agent session) and show its popup
    let mut label = String::new();

    if let Some(agent) = &agent_type {
        // Agent session — find its name
        let monitor = lock_or_recover(&state.agent_monitor);
        if let Some(snapshot) = monitor.get_session_snapshot(agent) {
            label = snapshot["agentName"].as_str().unwrap_or(agent).to_string();
        } else {
            label = agent.clone();
        }
    } else if let Some(sid) = session_id {
        // Manual session — find by ID in HashMap<u32, Session>
        let sessions = lock_or_recover(&state.sessions);
        if let Some(s) = sessions.get(&sid) {
            label = if s.title.is_empty() { s.name.clone() } else { s.title.clone() };
        }
    }

    // Set active session
    if let Some(sid) = session_id {
        *state.active_session_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(sid);
        *state.candidate_session_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(sid);
    }
    *state.popup_visible_for_text.lock().unwrap_or_else(|e| e.into_inner()) = true;
    *state.last_popup_text.lock().unwrap_or_else(|e| e.into_inner()) = String::new();

    // Show popup
    let _ = app.emit("popup-show", serde_json::json!({
        "app": label,
        "sessionId": session_id,
        "agentType": agent_type,
    }));
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.show();
    }
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

    // Fetch in background thread (blocking I/O)
    eprintln!("[terse] get_agent_plan_info called for: {}", agent_type);
    let at = agent_type.clone();
    let info = tokio::task::spawn_blocking(move || {
        eprintln!("[terse] fetching plan info for: {}", at);
        let result = match at.as_str() {
            "claude-code" => agent_monitor::fetch_claude_plan_info(),
            "cursor-agent" | "cursor" => agent_monitor::fetch_cursor_plan_info(),
            _ => None,
        };
        eprintln!("[terse] plan info result: {:?}", result.is_some());
        result
    }).await.map_err(|e| e.to_string())?;

    if let Some(ref plan_info) = info {
        let mut monitor = lock_or_recover(&state.agent_monitor);
        monitor.set_plan_info(&agent_type, plan_info.clone());
        eprintln!("[terse] plan info cached: plan={}", plan_info.plan);
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
            hook_script: "terse-rewrite.ps1",
            hook_include: "../../helpers/terse-rewrite.ps1",
            settings_path: home.join(".claude/settings.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "PreToolUse",
                matcher: "Bash",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "terse-optimize-tools.ps1",
                include: "../../helpers/hooks/terse-optimize-tools.ps1",
                matcher: "Read|Grep",
                hook_event: "PreToolUse",
            }),
        }),
        "cursor" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-cursor.ps1",
            hook_include: "../../helpers/hooks/terse-hook-cursor.ps1",
            settings_path: home.join(".cursor/hooks.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "preToolUse",
                matcher: "run_terminal_command",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-cursor.ps1",
                include: "../../helpers/hooks/terse-tool-optimizer-cursor.ps1",
                matcher: "read_file|grep_search",
                hook_event: "preToolUse",
            }),
        }),
        "cline" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-cline.ps1",
            hook_include: "../../helpers/hooks/terse-hook-cline.ps1",
            settings_path: home.join(".cline/settings.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "PreToolUse",
                matcher: "execute_command",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-cline.ps1",
                include: "../../helpers/hooks/terse-tool-optimizer-cline.ps1",
                matcher: "read_file|list_files",
                hook_event: "PreToolUse",
            }),
        }),
        "codex" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-codex.ps1",
            hook_include: "../../helpers/hooks/terse-hook-codex.ps1",
            settings_path: home.join(".codex/codex.toml"),
            install_method: AgentInstallMethod::Toml,
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-codex.ps1",
                include: "../../helpers/hooks/terse-tool-optimizer-codex.ps1",
                matcher: "read_file|search|view",
                hook_event: "pre_tool_use",
            }),
        }),
        "copilot" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-copilot.ps1",
            hook_include: "../../helpers/hooks/terse-hook-copilot.ps1",
            settings_path: home.join(".github-copilot/hooks/preToolUse/terse-hook-copilot.ps1"),
            install_method: AgentInstallMethod::DropFile,
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-copilot.ps1",
                include: "../../helpers/hooks/terse-tool-optimizer-copilot.ps1",
                matcher: "view|grep|search",
                hook_event: "preToolUse",
            }),
        }),
        "openclaw" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-openclaw.ts",
            hook_include: "../../helpers/hooks/terse-hook-openclaw.ts",
            settings_path: home.join(".openclaw/hooks/terse-hook-openclaw.ts"),
            install_method: AgentInstallMethod::DropFile,
            tool_optimizer: None, // OpenClaw doesn't support pre-tool hooks yet
        }),
        "windsurf" => Ok(AgentHookConfig {
            hook_script: "hooks/terse-hook-windsurf.ps1",
            hook_include: "../../helpers/hooks/terse-hook-windsurf.ps1",
            settings_path: home.join(".windsurf/hooks.json"),
            install_method: AgentInstallMethod::JsonSettings {
                hook_event: "pre_tool_use",
                matcher: "shell",
            },
            tool_optimizer: Some(ToolOptimizerConfig {
                script: "hooks/terse-tool-optimizer-windsurf.ps1",
                include: "../../helpers/hooks/terse-tool-optimizer-windsurf.ps1",
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
            "../../helpers/terse-rewrite.ps1" => include_str!("../../helpers/terse-rewrite.ps1"),
            "../../helpers/hooks/terse-hook-cursor.ps1" => include_str!("../../helpers/hooks/terse-hook-cursor.ps1"),
            "../../helpers/hooks/terse-hook-cline.ps1" => include_str!("../../helpers/hooks/terse-hook-cline.ps1"),
            "../../helpers/hooks/terse-hook-codex.ps1" => include_str!("../../helpers/hooks/terse-hook-codex.ps1"),
            "../../helpers/hooks/terse-hook-copilot.ps1" => include_str!("../../helpers/hooks/terse-hook-copilot.ps1"),
            "../../helpers/hooks/terse-hook-openclaw.ts" => include_str!("../../helpers/hooks/terse-hook-openclaw.ts"),
            "../../helpers/hooks/terse-hook-windsurf.ps1" => include_str!("../../helpers/hooks/terse-hook-windsurf.ps1"),
            _ => return Err("Unknown hook script".to_string()),
        };
        std::fs::write(&hook_dest, script)
            .map_err(|e| format!("Failed to write hook: {}", e))?;
    }

    // Also deploy terse-compress.js alongside the hook
    let compress_dest = terse_dir.join("terse-compress.js");
    if !compress_dest.exists() {
        let compress_src = include_str!("../../../src/helpers/terse-compress.js");
        std::fs::write(&compress_dest, compress_src)
            .map_err(|e| format!("Failed to write terse-compress.js: {}", e))?;
    }

    // No chmod needed on Windows

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
            if let Some(res_dir) = exe_path.parent() {
                let bundled = res_dir.join(tool_opt.script);
                if bundled.exists() {
                    let _ = std::fs::copy(&bundled, &tool_hook_dest);
                }
            }
        }
        // No chmod needed on Windows
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

            // No chmod needed on Windows

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
            let hook_path = home.join(".github-copilot/hooks/preToolUse/terse-hook-copilot.ps1");
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
                "message": "No active subscription. Start a free trial to use Terse."
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

// ── Spellcheck ──

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
            "message": "No active subscription. Start a free trial to use Terse."
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

/// Download the ONNX complexity model to ~/.terse/ml/ in a background thread.
/// Called on first sign-in so the installer stays small and the model arrives after activation.
fn trigger_ml_model_download() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let ml_dir    = home.join(".terse").join("ml");
    let model_dst = ml_dir.join("complexity-model.onnx");

    if model_dst.exists() && model_dst.metadata().map(|m| m.len()).unwrap_or(0) > 10_000_000 {
        return;
    }

    std::thread::spawn(move || {
        let _ = std::fs::create_dir_all(&ml_dir);

        let urls = [
            "https://github.com/lucaszengool/Terse/releases/download/v1.3.1/complexity-model.onnx",
        ];

        let tmp = ml_dir.join("complexity-model.onnx.part");

        for url in &urls {
            eprintln!("[terse-ml] downloading model from {}", url);
            let status = crate::hidden_command("curl")
                .args([
                    "-L", "--silent", "--show-error",
                    "--retry", "3", "--retry-delay", "2",
                    "-o", &tmp.to_string_lossy(),
                    url,
                ])
                .status();

            match status {
                Ok(s) if s.success() => {
                    let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                    if size > 10_000_000 {
                        let _ = std::fs::rename(&tmp, &model_dst);
                        eprintln!("[terse-ml] model downloaded ({:.1} MB) — ML routing active", size as f64 / 1e6);
                        return;
                    } else {
                        eprintln!("[terse-ml] download too small ({} bytes), retrying next URL", size);
                        let _ = std::fs::remove_file(&tmp);
                    }
                }
                Ok(s)  => eprintln!("[terse-ml] curl exited {}", s),
                Err(e) => eprintln!("[terse-ml] curl failed: {}", e),
            }
        }
        eprintln!("[terse-ml] model download failed — keyword routing will be used");
    });
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

    // Kick off ML model download in background (only runs if model not already present)
    trigger_ml_model_download();
}

#[tauri::command]
fn sign_out(state: tauri::State<'_, AppState>) {
    let mut auth = lock_or_recover(&state.auth);
    auth.sign_out();

    // Reset license to expired (no free plan)
    let mut lic = lock_or_recover(&state.license);
    lic.clerk_user_id = None;
    lic.tier = "expired".to_string();
    lic.status = "none".to_string();
    lic.limits = license::PlanLimits {
        optimizations_per_week: 0,
        max_sessions: 0,
        max_devices: 0,
    };
    lic.trial_end = None;
    lic.save();
}

/// Remove ANTHROPIC_BASE_URL from ~/.claude/settings.json if it points to our proxy.
/// Called on app startup (cleanup from previous crash) and when proxy exits.
fn cleanup_proxy_configs() {
    let home = dirs::home_dir().unwrap_or_default();
    let settings_file = home.join(".claude").join("settings.json");
    if settings_file.exists() {
        if let Ok(data) = std::fs::read_to_string(&settings_file) {
            if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(env) = json.get_mut("env").and_then(|e| e.as_object_mut()) {
                    if let Some(url) = env.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str()) {
                        if url.contains("127.0.0.1") {
                            env.remove("ANTHROPIC_BASE_URL");
                            if env.is_empty() {
                                json.as_object_mut().map(|o| o.remove("env"));
                            }
                            if let Ok(out) = serde_json::to_string_pretty(&json) {
                                let _ = std::fs::write(&settings_file, out);
                                eprintln!("[terse] cleaned up proxy config from ~/.claude/settings.json");
                            }
                        }
                    }
                }
            }
        }
    }
    // Also clean up PID file
    let _ = std::fs::remove_file(home.join(".terse").join("proxy.pid"));
}


// ═══════════════════════════════════════════════════════════════════════════
// Parity port from the macOS backend: Doctor · Cleanup · Speed · Cowork · Pets ·
// Farm · Dynamic Island · floating dashboards. Platform-specific calls (open,
// ps, cocoa) were adapted to Windows equivalents; everything else is verbatim.
// ═══════════════════════════════════════════════════════════════════════════

// ── Dynamic Island (灵动岛) + floating dashboard geometry (ported from macOS) ──
const ISLAND_PILL_W: f64 = 360.0;
const ISLAND_PILL_H: f64 = 44.0;
const ISLAND_CARD_W: f64 = 440.0;
const ISLAND_CARD_DEFAULT_H: f64 = 520.0;
const ISLAND_Y: f64 = 4.0;

const DASHBOARDS: &[(&str, f64, f64)] = &[
    ("session", 322.0, 372.0),
    ("saved", 300.0, 220.0),
    ("compression", 300.0, 238.0),
    ("cache", 300.0, 210.0),
    ("focus", 300.0, 226.0),
    ("tools", 322.0, 252.0),
    ("agents", 300.0, 214.0),
    ("savings", 300.0, 218.0),
    ("activity", 340.0, 320.0),
];
const DASH_GAP: f64 = 14.0;
const DASH_ORIGIN_X: f64 = 40.0;
const DASH_ORIGIN_Y: f64 = 56.0;

/// True while the dashboard constellation is revealed; gates the cursor-poll thread.
static DASH_POLL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn check_ax_permission() -> bool {
    // Windows UI Automation needs no accessibility-permission grant (unlike macOS AX),
    // so this is always true — kept for shared-frontend command parity.
    true
}

#[tauri::command]
async fn cleanup_clean(paths: Vec<String>) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || doctor::cleanup_clean(&paths))
        .await
        .unwrap_or_else(|_| serde_json::json!({ "ok": false, "message": "clean task failed" }))
}

#[tauri::command]
async fn cleanup_scan() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(doctor::cleanup_scan)
        .await
        .unwrap_or_else(|_| serde_json::json!({ "groups": [] }))
}

#[tauri::command]
fn clear_cowork_token(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let mut cw = lock_or_recover(&state.cowork);
    cw.config.team_id = None;
    cw.config.team_name = None;
    cw.config.team_token = None;
    cw.config.save();
    cw.config.snapshot()
}

/// Compute a left→right, wrap-on-overflow tiled layout for the dashboard windows.
/// Returns (label, kind, x, y, w, h) for each.
fn dash_layout(screen_w: f64) -> Vec<(String, String, f64, f64, f64, f64)> {
    let mut out = Vec::new();
    let (mut x, mut y, mut row_h) = (DASH_ORIGIN_X, DASH_ORIGIN_Y, 0.0f64);
    let max_x = (screen_w - DASH_ORIGIN_X).max(DASH_ORIGIN_X + 360.0);
    for (kind, w, h) in DASHBOARDS {
        if x + *w > max_x {
            x = DASH_ORIGIN_X;
            y += row_h + DASH_GAP;
            row_h = 0.0;
        }
        out.push((format!("dash-{}", kind), kind.to_string(), x, y, *w, *h));
        x += *w + DASH_GAP;
        row_h = row_h.max(*h);
    }
    out
}

/// True if at least one dashboard widget window is currently visible.
#[tauri::command]
fn dashboards_visible(app: AppHandle) -> bool {
    for (label, _, _, _, _, _) in dash_layout(island_screen_width(&app)) {
        if let Some(win) = app.get_webview_window(&label) {
            if win.is_visible().unwrap_or(false) {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
async fn doctor_apply_fix(
    finding: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Gate ONLY remediation: scanning + the report are free.
    {
        let auth = lock_or_recover(&state.auth);
        if !auth.signed_in {
            return Ok(serde_json::json!({
                "ok": false,
                "needsAuth": true,
                "reason": "login",
                "message": "Sign in to clean."
            }));
        }
    }
    {
        let can = { lock_or_recover(&state.license).can_optimize() };
        if !can && !in_grace(&state) {
            return Ok(serde_json::json!({
                "ok": false,
                "needsAuth": true,
                "reason": "subscription",
                "message": "An active subscription is required to clean."
            }));
        }
    }
    tauri::async_runtime::spawn_blocking(move || doctor::apply_fix(&finding))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn doctor_dismiss(id: String) -> serde_json::Value {
    doctor::dismiss(&id)
}

// NOTE: the doctor/cleanup commands are async + spawn_blocking because they walk
// large on-disk stores — a sync command would run on the main thread and freeze
// the whole UI for the duration of the scan.
#[tauri::command]
async fn doctor_scan(
    period: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let period = period.unwrap_or_else(|| "month".to_string());
    let (attr, stats) = {
        let store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
        (store.get_attribution(&period), store.get_stats(&period))
    };
    let sessions = {
        let monitor = lock_or_recover(&state.agent_monitor);
        monitor.get_connected_sessions()
    };
    let summary = stats.get("summary").cloned().unwrap_or(stats);
    tauri::async_runtime::spawn_blocking(move || {
        doctor::scan_full(&attr, &summary, &sessions, &period)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn equip_pet(pet_id: String, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        pet_store.equip_pet(&pet_id)?;
    }
    if let Some(w) = app.get_webview_window("pet") { let _ = w.show(); }
    let _ = app.emit("pet-equipped", serde_json::json!({ "petId": pet_id }));
    Ok(())
}

#[tauri::command]
fn equip_skin(pet_id: String, skin_id: String, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        pet_store.equip_skin(&pet_id, &skin_id)?;
    }
    let _ = app.emit("skin-equipped", serde_json::json!({ "petId": pet_id, "skinId": skin_id }));
    Ok(())
}

#[tauri::command]
fn farm_add_fishing_coins(amount: u64, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.add_fishing_coins(amount);
    Ok(())
}

#[tauri::command]
fn farm_buy_decoration(dec_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.buy_decoration(&dec_id)
}

#[tauri::command]
fn farm_buy_tile_skin(tile_idx: usize, skin_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.buy_tile_skin(tile_idx, &skin_id)
}

#[tauri::command]
fn farm_clear(tile_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.clear_tile(tile_idx)
}

#[tauri::command]
fn farm_expand(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<u64, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    let cost = farm.expand_land()?;
    let _ = app.emit("farm-updated", serde_json::json!({}));
    Ok(cost)
}

#[tauri::command]
fn farm_fertilize(tile_idx: usize, state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    let coin_bal = {
        let pet = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        let spent = pet.data().coins_spent + farm.data.coins_spent_farm;
        pet.data().coins_earned.saturating_sub(spent)
    };
    farm.fertilize(tile_idx, coin_bal)
}

#[tauri::command]
fn farm_harvest(tile_idx: usize, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<serde_json::Value, String> {
    let result = {
        let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
        farm.harvest(tile_idx)?
    };
    let units = result["units"].as_u64().unwrap_or(0);
    let xp = result["xpGained"].as_u64().unwrap_or(0);
    let _ = app.emit("farm-harvest", serde_json::json!({ "tileIdx": tile_idx, "units": units, "xpGained": xp }));
    Ok(result)
}

#[tauri::command]
fn farm_plant(tile_idx: usize, crop_id: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    let coin_bal = {
        let pet = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        let spent = pet.data().coins_spent + farm.data.coins_spent_farm;
        pet.data().coins_earned.saturating_sub(spent)
    };
    farm.plant(tile_idx, &crop_id, coin_bal)
}

#[tauri::command]
fn farm_pool_clear(pool_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.pool_clear(pool_idx)
}

#[tauri::command]
fn farm_pool_fertilize(pool_idx: usize, state: tauri::State<'_, AppState>) -> Result<u64, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    let coin_bal = {
        let pet = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        let spent = pet.data().coins_spent + farm.data.coins_spent_farm;
        pet.data().coins_earned.saturating_sub(spent)
    };
    farm.pool_fertilize(pool_idx, coin_bal)
}

#[tauri::command]
fn farm_pool_harvest(pool_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.pool_harvest(pool_idx)
}

#[tauri::command]
fn farm_pool_plant(pool_idx: usize, crop_id: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    let coin_bal = {
        let pet = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        let spent = pet.data().coins_spent + farm.data.coins_spent_farm;
        pet.data().coins_earned.saturating_sub(spent)
    };
    farm.pool_plant(pool_idx, &crop_id, coin_bal)
}

#[tauri::command]
fn farm_pool_water(pool_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.pool_water(pool_idx)
}

#[tauri::command]
fn farm_remove_pest(tile_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.remove_pest(tile_idx)
}

#[tauri::command]
fn farm_remove_weed(tile_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.remove_weed(tile_idx)
}

#[tauri::command]
fn farm_sell_crops(crop_id: String, amount: u64, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<u64, String> {
    let gained = {
        let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
        farm.sell_crops(&crop_id, amount)?
    };
    let _ = app.emit("farm-sell", serde_json::json!({ "cropId": crop_id, "amount": amount, "harvestCoins": gained }));
    Ok(gained)
}

// ── Farm Window mini mode ──
#[tauri::command]
fn farm_set_mini(mini: bool, app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("farm") {
        if mini {
            w.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 110.0, height: 110.0 }))
                .map_err(|e| e.to_string())?;
        } else {
            w.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 1366.0, height: 768.0 }))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn farm_water(tile_idx: usize, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    farm.water(tile_idx)
}

/// Reveal the dynamic island and expand it onto a specific agent. Called when the user
/// clicks an agent (Claude) session in the main window — instead of popping the legacy
/// popup, we "pull down" the island and focus that agent's panel. island.js listens for
/// the `island-focus` event and drives the expand + panel-switch.
#[tauri::command]
fn focus_island(agent_type: Option<String>, app: AppHandle) {
    if let Some(win) = app.get_webview_window("island") {
        let _ = win.show();
    }
    let _ = app.emit("island-focus", serde_json::json!({ "agentType": agent_type }));
}

#[tauri::command]
fn get_agent_attribution(period: String, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
    store.get_attribution(&period)
}

#[tauri::command]
fn get_cowork_config(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let cw = lock_or_recover(&state.cowork);
    let mut snap = cw.config.snapshot();
    // Include the signed-in member's email so the Team window can identify itself,
    // and the team token so it can open the SSE stream (this is the local machine's
    // own webview — the token already lives in ~/.terse/cowork.json).
    let email = lock_or_recover(&state.auth).email.clone();
    snap["userEmail"] = serde_json::json!(email);
    snap["teamToken"] = serde_json::json!(cw.config.team_token);
    snap
}

#[tauri::command]
fn get_farm_state(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let mut farm = state.farm_store.lock().unwrap_or_else(|e| e.into_inner());
    let coin_bal = {
        let pet = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        let farm_spent = farm.data.coins_spent_farm;
        let earned = pet.data().coins_earned;
        let pet_spent = pet.data().coins_spent;
        earned.saturating_sub(pet_spent).saturating_sub(farm_spent)
    };
    let saved_token_bal = {
        let stats = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
        stats.total_tokens_saved().saturating_sub(farm.data.saved_tokens_spent_farm)
    };
    farm.get_state(coin_bal, saved_token_bal)
}

/// Returns full pet state + coin balance (1 coin earned per optimization call)
#[tauri::command]
fn get_pet_state(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
    let stats = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
    let lifetime_saved = stats.get_stats("all")["summary"]["tokensSaved"].as_u64().unwrap_or(0);
    let coin_balance = pet_store.coin_balance();
    serde_json::json!({
        "data": pet_store.data(),
        "lifetimeTokensSaved": lifetime_saved,
        "spendableBalance": coin_balance,
        "unlockCostPet": pet_store::UNLOCK_COST_PET,
        "unlockCostSkin": pet_store::UNLOCK_COST_SKIN,
    })
}

/// Handle a `terse://connect?token=tct_…` deep link: focus the app immediately,
/// then resolve + persist the team token off-thread and open the Team window.
/// Called from the deep-link plugin (`on_open_url`) and on cold-start launch.
fn handle_connect_url(app: &AppHandle, url: &tauri::Url) {
    if url.scheme() != "terse" { return; }
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned());

    // Bring the window forward right away — feels instant even while we verify.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }

    let token = match token { Some(t) if !t.trim().is_empty() => t.trim().to_string(), _ => return };
    let app = app.clone();
    std::thread::spawn(move || {
        if cowork::resolve_and_save_token(&token).is_ok() {
            {
                let state = app.state::<AppState>();
                let mut cw = lock_or_recover(&state.cowork);
                cw.config = cowork::CoworkConfig::load();
            }
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(u) = "tauri://localhost/cowork.html".parse() {
                    let _ = win.navigate(u);
                }
            }
        }
    });
}

/// Hide every dashboard widget window (positions are preserved).
#[tauri::command]
fn hide_dashboards(app: AppHandle) {
    // NOTE: the cursor poll stays alive — it also drives hover-OPEN on the pill.
    for (label, _, _, _, _, _) in dash_layout(island_screen_width(&app)) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.hide();
        }
    }
}

#[tauri::command]
fn hide_doctor_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("doctor") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn hide_farm_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("farm") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_island_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("island") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn hide_pet_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("pet") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// True while the signed-in user is inside the 15-minute post-login grace window.
/// Callers MUST NOT hold the license lock when calling this (it locks `auth`, and
/// save_auth locks auth→license, so nesting license→auth here could deadlock).
fn in_grace(state: &AppState) -> bool {
    let auth = lock_or_recover(&state.auth);
    auth.in_grace()
}

/// Fit the expanded card to its rendered content height (analogous to resize_popup).
#[tauri::command]
fn island_resize(h: f64, app: AppHandle) {
    if let Some(win) = app.get_webview_window("island") {
        let sw = island_screen_width(&app);
        // Allow the card to grow nearly the full screen height; the webview scrolls
        // internally beyond this so the chevron-details always reveal fully.
        let max_h = (island_screen_height(&app) - ISLAND_Y - 12.0).max(360.0);
        let clamped = h.max(120.0).min(max_h);
        let x = ((sw - ISLAND_CARD_W) / 2.0).max(0.0);
        let _ = win.set_size(tauri::LogicalSize::new(ISLAND_CARD_W, clamped));
        let _ = win.set_position(tauri::LogicalPosition::new(x, ISLAND_Y));
    }
}

/// Logical height of the primary monitor (caps how tall the expanded island may grow).
fn island_screen_height(app: &AppHandle) -> f64 {
    match app.primary_monitor() {
        Ok(Some(m)) => m.size().height as f64 / m.scale_factor(),
        _ => 900.0,
    }
}

/// Logical width of the primary monitor (for horizontally re-centering the island on resize).
fn island_screen_width(app: &AppHandle) -> f64 {
    match app.primary_monitor() {
        Ok(Some(m)) => m.size().width as f64 / m.scale_factor(),
        _ => 1440.0,
    }
}

/// Hover toggle: collapse to the pill or expand to the monitor card, kept top-center.
#[tauri::command]
fn island_set_expanded(expanded: bool, app: AppHandle) {
    if let Some(win) = app.get_webview_window("island") {
        let sw = island_screen_width(&app);
        let (w, h) = if expanded {
            (ISLAND_CARD_W, ISLAND_CARD_DEFAULT_H)
        } else {
            (ISLAND_PILL_W, ISLAND_PILL_H)
        };
        let x = ((sw - w) / 2.0).max(0.0);
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let _ = win.set_position(tauri::LogicalPosition::new(x, ISLAND_Y));
    }
}

/// On macOS this rounded the native window layer via Cocoa. Windows 11 rounds
/// frameless windows itself and the frontend applies `border-radius`, so this is
/// a deliberate no-op kept for call-site parity.
fn make_rounded(_win: &tauri::WebviewWindow, _radius: f64) {}

/// Called after a confirmed Stripe purchase — marks pet owned without spending coins.
#[tauri::command]
fn mark_pet_purchased(pet_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
    pet_store.mark_pet_purchased(&pet_id);
    Ok(())
}

#[tauri::command]
fn minimize_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.minimize();
    }
}

#[tauri::command]
fn navigate_to_cowork(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = "tauri://localhost/cowork.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/cowork.html');");
        }
    }
}

/// Navigate the MAIN window to the Doctor (体检) report in-place. This keeps the
/// Doctor inside the single main window (reached via the dock button) instead of
/// spawning a second floating window.
#[tauri::command]
fn navigate_to_doctor(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // The main window is the 980×650 360-style shell — the Doctor renders
        // inside it at that size, so no resize/recenter dance is needed.
        if let Ok(url) = "tauri://localhost/doctor.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/doctor.html');");
        }
    }
}

/// Open the Terse Cloud team dashboard in the default browser. `path` is an
/// optional suffix under `/teams` (e.g. a team id); when absent we send the user
/// to the create/connect flow (`?connect=app`) so the website can hand a token
/// straight back via the `terse://` deep link.
#[tauri::command]
fn open_cloud_teams(path: Option<String>, state: tauri::State<'_, AppState>) {
    const BASE: &str = "https://www.terseai.org";
    let url = match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let p = p.trim_start_matches('/');
            format!("{}/teams/{}", BASE, p)
        }
        None => {
            // If already connected, deep-link to this team; else the connect flow.
            let team_id = lock_or_recover(&state.cowork).config.team_id.clone();
            match team_id {
                Some(id) if !id.is_empty() => format!("{}/teams/{}", BASE, id),
                _ => format!("{}/teams?connect=app", BASE),
            }
        }
    };
    let _ = crate::hidden_command("cmd").args(["/C","start","",&url]).spawn();
}

/// Show every dashboard widget window. The windows themselves are created hidden
/// at setup (window creation must run on the main thread); this just reveals them.
#[tauri::command]
fn open_dashboards(app: AppHandle) {
    for (label, _, _, _, _, _) in dash_layout(island_screen_width(&app)) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.show();
            let _ = win.set_always_on_top(true);
        }
    }
    // Nudge the (until now hidden) dashboards to reseed their live agent registry the
    // instant they're revealed, so they never show a stale "0 online" / empty state.
    let _ = app.emit("dashboards-shown", ());
    // Start the global cursor poll that reliably drives hover-collapse.
    start_dash_cursor_poll(app);
}

/// Open an arbitrary http(s) URL in the user's default browser (e.g. Slack web,
/// the webhook setup page). Restricted to http/https so it can't launch apps.
#[tauri::command]
fn open_url(url: String) {
    let u = url.trim();
    if u.starts_with("http://") || u.starts_with("https://") {
        let _ = crate::hidden_command("cmd").args(["/C","start","",u]).spawn();
    }
}

/// Called from popup.js when it detects a new tool call during monitoring.
/// Adds 1 coin and fires pet-fed with the tool name so the pet can react contextually.
#[tauri::command]
fn pet_work_detected(state: tauri::State<'_, AppState>, app: AppHandle, saved_estimate: u64, tool_name: Option<String>) {
    {
        let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        pet_store.add_coins(1);
        let coins = pet_store.coin_balance();
        let prev_coins = coins.saturating_sub(1);
        if coins / pet_store::UNLOCK_COST_PET > prev_coins / pet_store::UNLOCK_COST_PET {
            let _ = app.emit("pet-milestone", serde_json::json!({
                "kind": "unlock-available",
                "text": format!("New unlock available! ({} coins)", coins),
            }));
        }
    }
    let total = {
        let store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
        store.get_stats("all")["summary"]["tokensSaved"].as_u64().unwrap_or(0)
    };
    let _ = app.emit("pet-fed", serde_json::json!({
        "saved": saved_estimate,
        "totalSaved": total,
        "source": "monitor",
        "toolName": tool_name.unwrap_or_default(),
    }));
}

#[tauri::command]
fn pick_starter_pet(pet_id: String, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool, String> {
    let picked = {
        let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        pet_store.pick_starter(&pet_id)
    };
    if picked {
        // Show pet window + emit event so popup + pet windows refresh
        if let Some(w) = app.get_webview_window("pet") { let _ = w.show(); }
        let _ = app.emit("pet-equipped", serde_json::json!({ "petId": pet_id }));
    }
    Ok(picked)
}

/// Push one optimization as an aggregate usage event to the team dashboard
/// (counts only, no text), off the UI thread so the curl never blocks. No-op
/// unless connected to a team with the `share_stats` opt-in on.
fn publish_usage_event(state: &AppState, source: &str, original: u64, optimized: u64) {
    let cfg = { lock_or_recover(&state.cowork).config.clone() };
    if !cfg.is_stats_active() { return; }
    let mode = lock_or_recover(&state.settings).aggressiveness.clone();
    let email = lock_or_recover(&state.auth).email.clone();
    let source = source.to_string();
    let saved = original.saturating_sub(optimized);
    std::thread::spawn(move || {
        let st = cowork::CoworkState::from_config(cfg);
        cowork::publish_event(
            &st, &source, "mac", "", "", &mode,
            original, 0, saved, 0, 0, email.as_deref(),
        );
    });
}

/// Historically shrank the main window back to the compact 340×460 monitor when
/// leaving the Doctor. The main window is now a persistent 980×650 shell, so
/// returning must keep whatever size the user has — this is intentionally a no-op.
fn restore_compact_main(_win: &tauri::WebviewWindow) {}

/// After the grace window elapses, if the user still has no active plan, tear down
/// the "try it" affordances: emit `trial-grace-expired` (the main window shows the
/// paywall, the Dynamic Island hides itself) and disconnect any live agents so the
/// monitor stops. If they subscribed during the window, this is a no-op.
fn schedule_grace_expiry(app: AppHandle, secs: i64) {
    std::thread::spawn(move || {
        if secs > 0 {
            std::thread::sleep(std::time::Duration::from_secs(secs as u64));
        }
        let state = app.state::<AppState>();
        let has_plan = { lock_or_recover(&state.license).can_optimize() };
        if has_plan || in_grace(&state) {
            return; // subscribed, or the window was extended/restarted — nothing to do
        }
        {
            let mut monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
            let types: Vec<String> = monitor.sessions.keys().cloned().collect();
            for t in &types { monitor.disconnect_agent(t); }
        }
        let _ = app.emit("trial-grace-expired", serde_json::json!({}));
    });
}

/// POST a plain message to a Slack incoming webhook. The webhook is the user's
/// secret and is only ever sent to Slack. Done with curl (off the main thread)
/// so there's no browser-CORS issue. Returns Ok once Slack accepts it.
#[tauri::command]
async fn send_slack_alert(webhook: String, text: String) -> Result<(), String> {
    let w = webhook.trim().to_string();
    if !w.starts_with("https://hooks.slack.com/") {
        return Err("Not a Slack webhook URL (expected https://hooks.slack.com/…)".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let body = serde_json::json!({ "text": text }).to_string();
        let output = crate::hidden_command("curl")
            .arg("-sS").arg("-X").arg("POST")
            .arg("-H").arg("Content-Type: application/json")
            .arg("--data").arg(&body)
            .arg("--max-time").arg("10")
            .arg(&w)
            .output()
            .map_err(|e| e.to_string())?;
        let resp = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && (resp == "ok" || resp.is_empty()) {
            Ok(())
        } else if !resp.is_empty() {
            Err(resp)
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_cowork_share_logs(enabled: bool, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let mut cw = lock_or_recover(&state.cowork);
    cw.config.share_logs = enabled;
    cw.config.save();
    cw.config.snapshot()
}

/// Opt in/out of pushing aggregate token-usage events to the team dashboard.
/// Independent of `share_logs` (live agent logs).
#[tauri::command]
fn set_cowork_share_stats(enabled: bool, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let mut cw = lock_or_recover(&state.cowork);
    cw.config.share_stats = enabled;
    cw.config.save();
    cw.config.snapshot()
}

/// Join a team by pasting its team token. Resolves the team via the cloud and persists it.
#[tauri::command]
async fn set_cowork_token(token: String, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let token = token.trim().to_string();
    if token.is_empty() { return Err("Empty token".into()); }
    // Network validation (curl, up to 10s) must never run on the main thread.
    let snap = tauri::async_runtime::spawn_blocking(move || cowork::resolve_and_save_token(&token))
        .await
        .map_err(|e| e.to_string())??;
    // Reload config into runtime state so publishing starts immediately.
    let mut cw = lock_or_recover(&state.cowork);
    cw.config = cowork::CoworkConfig::load();
    Ok(snap)
}

#[tauri::command]
fn set_pet_settings(settings: pet_store::PetSettings, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        pet_store.set_settings(settings.clone());
    }
    let _ = app.emit("pet-settings-updated", serde_json::to_value(&settings).unwrap_or_default());
    Ok(())
}

#[tauri::command]
fn set_speed_mode(enabled: bool) -> serde_json::Value {
    doctor::set_speed_mode(enabled)
}

#[tauri::command]
fn show_doctor_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("doctor") {
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_farm_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("farm") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_island_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("island") {
        let _ = win.show();
    }
    // Hover-open is native-driven: the poll must be live whenever the pill is.
    start_dash_cursor_poll(app);
}

/// Bring the main window to the front on its primary view (index.html). The
/// main window's init runs the paywall check on load, so this is how an
/// unentitled user is routed from the Doctor to the in-app paywall.
#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        restore_compact_main(&win);
        if let Ok(url) = "tauri://localhost/index.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/index.html');");
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn show_pet_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("pet") {
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn speed_mode_status() -> serde_json::Value {
    doctor::speed_mode_status()
}

/// Poll the global cursor position and emit a single consolidated inside/outside
/// signal for the whole dashboard constellation (island pill + every visible board).
///
/// Per-window DOM `mouseleave` events were too flaky to drive collapse: the boards
/// are separate transparent overlay windows, so crossing the gaps between them — or
/// leaving fast — dropped/raced the leave event and the set stayed open. A global
/// cursor poll sidesteps all of that: it knows the real pointer position regardless
/// of which (if any) window owns it. `NSEvent.mouseLocation` is thread-safe, so this
/// is safe off the main thread. Emits `dash-cursor-outside` only after the pointer
/// has been clear of every window for a short grace period (so brisk gap-crossings
/// between adjacent boards don't trigger a false collapse).
fn start_dash_cursor_poll(app: AppHandle) {
    use std::sync::atomic::Ordering;
    // swap returns the previous value; bail if a poll loop is already live.
    if DASH_POLL_RUNNING.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        // Hover must feel instant in BOTH directions, and webview mouseenter is
        // unreliable on unfocused overlay windows — so this native poll is the
        // single source of truth: 40ms tick, immediate open on island entry,
        // short grace before close so diagonal travel between windows never
        // flickers the set shut.
        const PILL_MARGIN: f64 = 10.0;   // slack around the island pill
        const SET_MARGIN: f64 = 18.0;    // slack around each dashboard window
        const GRACE: std::time::Duration = std::time::Duration::from_millis(170);
        let mut last_inside: Option<bool> = None;
        let mut last_island = false;
        let mut outside_since: Option<std::time::Instant> = None;
        loop {
            if !DASH_POLL_RUNNING.load(Ordering::SeqCst) { break; }
            let labels: Vec<String> =
                dash_layout(island_screen_width(&app)).into_iter().map(|t| t.0).collect();
            let island_visible = app
                .get_webview_window("island")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if !island_visible {
                // Island hidden: keep serving hover-close while any dashboard is
                // still up; once everything is gone this loop has no job left.
                let any_dash = labels.iter().any(|l| {
                    app.get_webview_window(l).and_then(|w| w.is_visible().ok()).unwrap_or(false)
                });
                if !any_dash { break; }
            }

            let cursor = match app.cursor_position() {
                Ok(c) => c,
                Err(_) => { std::thread::sleep(std::time::Duration::from_millis(120)); continue; }
            };
            let hits = |w: &tauri::WebviewWindow, margin: f64| -> bool {
                if !w.is_visible().unwrap_or(false) { return false; }
                let (p, s) = match (w.outer_position(), w.outer_size()) {
                    (Ok(p), Ok(s)) => (p, s),
                    _ => return false,
                };
                let (x0, y0) = (p.x as f64 - margin, p.y as f64 - margin);
                let (x1, y1) = (p.x as f64 + s.width as f64 + margin, p.y as f64 + s.height as f64 + margin);
                cursor.x >= x0 && cursor.x <= x1 && cursor.y >= y0 && cursor.y <= y1
            };

            // OPEN path: entering the island fires on the SAME tick, no grace.
            let island_hit = app
                .get_webview_window("island")
                .map(|w| hits(&w, PILL_MARGIN))
                .unwrap_or(false);
            if island_hit && !last_island {
                let _ = app.emit("island-hover", ());
            }
            last_island = island_hit;

            let mut inside = island_hit;
            if !inside {
                for l in &labels {
                    if let Some(w) = app.get_webview_window(l) { if hits(&w, SET_MARGIN) { inside = true; break; } }
                }
            }

            if inside {
                outside_since = None;
                if last_inside != Some(true) {
                    let _ = app.emit("dash-cursor-inside", ());
                    last_inside = Some(true);
                }
            } else {
                let firmly_out = match outside_since {
                    Some(t) => t.elapsed() >= GRACE,
                    None => { outside_since = Some(std::time::Instant::now()); false }
                };
                if firmly_out && last_inside != Some(false) {
                    let _ = app.emit("dash-cursor-outside", ());
                    last_inside = Some(false);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        DASH_POLL_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// Re-tile all dashboard windows back to their default grid positions.
#[tauri::command]
fn tile_dashboards(app: AppHandle) {
    let sw = island_screen_width(&app);
    for (label, _, x, y, _, _) in dash_layout(sw) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
    }
}

/// Show or hide a single dashboard widget by kind (e.g. "saved"). Returns the new
/// visible state so the launcher can reflect it.
#[tauri::command]
fn toggle_dashboard(kind: String, app: AppHandle) -> bool {
    let label = format!("dash-{}", kind);
    if let Some(win) = app.get_webview_window(&label) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return false;
        }
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        return true;
    }
    // Window not found (shouldn't happen — they're created at setup). Show the set.
    open_dashboards(app);
    true
}

/// Status of the post-login grace window for the renderer (paywall + island).
#[tauri::command]
fn trial_grace_status(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let has_plan = { lock_or_recover(&state.license).can_optimize() };
    let auth = lock_or_recover(&state.auth);
    let rem = auth.grace_remaining_secs();
    serde_json::json!({
        "inGrace": auth.in_grace(),
        "remainingSecs": rem,
        "hasPlan": has_plan,
        "expired": auth.grace_start.is_some() && !auth.in_grace() && !has_plan,
    })
}

#[tauri::command]
fn unlock_pet(pet_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let stats = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
    let lifetime_saved = stats.get_stats("all")["summary"]["tokensSaved"].as_u64().unwrap_or(0);
    drop(stats); // release before locking pet_store
    let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
    let spent = pet_store.data().tokens_spent;
    let available = lifetime_saved.saturating_sub(spent);
    pet_store.unlock_pet(&pet_id, available)
}

#[tauri::command]
fn unlock_skin(pet_id: String, skin_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let stats = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
    let lifetime_saved = stats.get_stats("all")["summary"]["tokensSaved"].as_u64().unwrap_or(0);
    drop(stats);
    let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
    let spent = pet_store.data().tokens_spent;
    let available = lifetime_saved.saturating_sub(spent);
    pet_store.unlock_skin(&pet_id, &skin_id, available)
}


pub fn run() {
    // Persist any panic to ~/.terse/crash.log so a launch crash on a user's
    // machine (which has no console) is diagnosable instead of a silent white flash.
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(dir) = dirs::home_dir() {
                let dir = dir.join(".terse");
                let _ = std::fs::create_dir_all(&dir);
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
                    let _ = writeln!(f, "[panic] {}", info);
                    if let Some(loc) = info.location() {
                        let _ = writeln!(f, "  at {}:{}", loc.file(), loc.line());
                    }
                }
            }
            default_hook(info);
        }));
    }

    // WebView2 guard: without the runtime the window dies as a silent white
    // flash (see tauri#4389 — a denied/failed WebView2 install leaves the app
    // installed but unlaunchable, with no error). Detect it up front and tell
    // the user what to do instead.
    if let Err(e) = tauri::webview_version() {
        if let Some(dir) = dirs::home_dir() {
            let dir = dir.join(".terse");
            let _ = std::fs::create_dir_all(&dir);
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
                let _ = writeln!(f, "[launch] WebView2 runtime not available: {}", e);
            }
        }
        let msg = "Terse needs the Microsoft Edge WebView2 runtime, but it is not installed on this PC. \
                   Terse 需要 Microsoft Edge WebView2 运行时才能启动，当前系统未安装。\
                   Click OK to open the download page — install WebView2, then start Terse again. \
                   点击确定打开下载页面，安装 WebView2 后重新打开 Terse。";
        let _ = crate::hidden_command("powershell")
            .args(["-NoProfile", "-Command",
                   &format!("Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{}','Terse — WebView2')", msg)])
            .status();
        let _ = crate::hidden_command("cmd")
            .args(["/C", "start", "", "https://developer.microsoft.com/microsoft-edge/webview2/"])
            .spawn();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            // Ensure HOME/USERPROFILE is set
            if std::env::var("USERPROFILE").is_err() {
                if let Some(home) = dirs::home_dir() {
                    std::env::set_var("USERPROFILE", home);
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
                .visible(false)
                .build()?;

            // ── Pet companion window (Windows: bottom-right, transparent, on-top) ──
            let pet_w = 240.0;
            let pet_h = 260.0;
            let monitor_h = monitor.size().height as f64 / monitor.scale_factor();
            let pet_x = (screen_width - pet_w - 24.0) as f64;
            let pet_y = (monitor_h - pet_h - 60.0) as f64;
            let pet_visible = {
                let st = app.state::<AppState>();
                let pet_store = st.pet_store.lock().unwrap_or_else(|e| e.into_inner());
                pet_store.data().equipped_pet.is_some()
            };
            let _pet_win = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
                .title("Terse Pet")
                .inner_size(pet_w, pet_h)
                .position(pet_x, pet_y)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .visible(pet_visible)
                .build()?;

            // ── Farm window (hidden until opened) ──
            let farm_x = (screen_width / 2.0 - 683.0) as f64;
            let _farm_win = WebviewWindowBuilder::new(app, "farm", WebviewUrl::App("farm.html".into()))
                .title("Terse Farm")
                .inner_size(1366.0, 768.0)
                .min_inner_size(1100.0, 618.0)
                .position(farm_x, 80.0)
                .always_on_top(false)
                .resizable(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?;

            // ── Doctor window (体检 — hidden until opened) ──
            let doc_x = (screen_width / 2.0 - 520.0) as f64;
            let _doctor_win = WebviewWindowBuilder::new(app, "doctor", WebviewUrl::App("doctor.html".into()))
                .title("Terse Doctor")
                .inner_size(1040.0, 800.0)
                .min_inner_size(820.0, 640.0)
                .position(doc_x, 70.0)
                .always_on_top(false)
                .resizable(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?;

            // ── Dynamic Island window (灵动岛 — agent monitor pill) ──
            let island_x = ((screen_width - ISLAND_PILL_W) / 2.0) as f64;
            let _island_win = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("island.html".into()))
                .title("Terse Island")
                .inner_size(ISLAND_PILL_W, ISLAND_PILL_H)
                .position(island_x, ISLAND_Y)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?;

            // ── Floating dashboard widget windows (灵动仪表盘) ──
            for (label, kind, dx, dy, dw, dh) in dash_layout(screen_width) {
                let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("dash.html?w={}", kind).into()))
                    .title("Terse Dashboard")
                    .inner_size(dw, dh)
                    .position(dx, dy)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .resizable(false)
                    .shadow(false)
                    .skip_taskbar(true)
                    .focused(false)
                    .visible(false)
                    .build();
            }

            // Windows: acrylic blur behind the frameless overlays so the frosted-glass
            // frontend reads correctly (parity with macOS vibrancy). Best-effort.
            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_acrylic;
                for lbl in ["island", "doctor", "farm"] {
                    if let Some(w) = app.get_webview_window(lbl) {
                        let _ = apply_acrylic(&w, Some((18, 18, 20, 125)));
                    }
                }
                for (label, _, _, _, _, _) in dash_layout(screen_width) {
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = apply_acrylic(&w, Some((18, 18, 20, 125)));
                    }
                }
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

            // Persist real agent token usage into the stats store (parity with macOS):
            // backfill recent Claude Code / Codex session logs on launch, then re-scan
            // every 30s for live growth. Powers the Doctor, attribution, and stats.
            let app_handle_usage = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    {
                        let state = app_handle_usage.state::<AppState>();
                        agent_usage_scan::scan_once(&state.stats_store);
                        agent_usage_scan::scan_attribution_once(&state.stats_store);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(30));
                }
            });

            // Start combined focus + text polling
            let app_handle4 = app.handle().clone();
            std::thread::spawn(move || {
                start_polling(app_handle4);
            });

            // Kill any existing proxy (from previous session or older Terse version)
            // so the new proxy can bind port 7860 and re-configure settings.json.
            {
                let home = dirs::home_dir().unwrap_or_default();
                let pid_file = home.join(".terse").join("proxy.pid");
                if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = pid_str.trim().parse::<u32>() {
                        let _ = crate::hidden_command("taskkill")
                            .args(["/PID", &pid.to_string(), "/F"])
                            .output();
                        std::thread::sleep(std::time::Duration::from_millis(400));
                    }
                }
            }

            // Clean up any stale proxy config from previous crash
            cleanup_proxy_configs();

            // Start local API proxy for auto model routing
            std::thread::spawn(move || {
                let home = dirs::home_dir().unwrap_or_default();
                let proxy_script = home.join(".terse").join("terse-local-proxy.js");
                // Deploy proxy script if not present or outdated
                let proxy_src = include_str!("../../../src/helpers/terse-local-proxy.js");
                let _ = std::fs::create_dir_all(home.join(".terse"));
                let _ = std::fs::write(&proxy_script, proxy_src);

                // Find node binary on Windows
                let mut candidates: Vec<String> = vec![];

                // Check Program Files
                candidates.push(r"C:\Program Files\nodejs\node.exe".into());
                candidates.push(r"C:\Program Files (x86)\nodejs\node.exe".into());

                // Check NVM for Windows
                if let Ok(appdata) = std::env::var("APPDATA") {
                    let nvm_dir = std::path::PathBuf::from(&appdata).join("nvm");
                    if nvm_dir.exists() {
                        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                            let mut versions: Vec<_> = entries.filter_map(|e| e.ok())
                                .filter(|e| e.path().join("node.exe").exists())
                                .map(|e| e.path().join("node.exe").to_string_lossy().to_string())
                                .collect();
                            versions.sort();
                            if let Some(latest) = versions.pop() {
                                candidates.push(latest);
                            }
                        }
                    }
                }

                // Also try fnm (Fast Node Manager)
                if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                    let fnm_dir = std::path::PathBuf::from(&localappdata).join("fnm_multishells");
                    if fnm_dir.exists() {
                        if let Ok(entries) = std::fs::read_dir(&fnm_dir) {
                            let mut versions: Vec<_> = entries.filter_map(|e| e.ok())
                                .filter(|e| e.path().join("node.exe").exists())
                                .map(|e| e.path().join("node.exe").to_string_lossy().to_string())
                                .collect();
                            versions.sort();
                            if let Some(latest) = versions.pop() {
                                candidates.push(latest);
                            }
                        }
                    }
                }

                // Try `where node` as a fallback (works if node is on PATH)
                if let Ok(output) = crate::hidden_command("where").arg("node").output() {
                    if output.status.success() {
                        if let Ok(paths) = String::from_utf8(output.stdout) {
                            if let Some(first) = paths.lines().next() {
                                let p = first.trim().to_string();
                                if !p.is_empty() {
                                    candidates.push(p);
                                }
                            }
                        }
                    }
                }

                let node_bin = candidates.iter().find(|p| std::path::Path::new(p.as_str()).exists()).cloned();
                let node = match node_bin {
                    Some(n) => n,
                    None => { eprintln!("[terse] node not found, skipping local proxy"); return; }
                };
                // Start proxy on port 7860
                match crate::hidden_command(&node)
                    .arg(&proxy_script)
                    .arg("--port").arg("7860")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                {
                    Ok(mut child) => {
                        eprintln!("[terse] local proxy started on port 7860");
                        // Log stderr in background
                        if let Some(stderr) = child.stderr.take() {
                            std::thread::spawn(move || {
                                use std::io::BufRead;
                                let reader = std::io::BufReader::new(stderr);
                                for line in reader.lines().map_while(Result::ok) {
                                    eprintln!("[terse-proxy] {}", line);
                                }
                            });
                        }
                        // Wait for child (keeps it alive until app exits)
                        let _ = child.wait();
                        // Proxy exited — ALWAYS clean up agent configs
                        eprintln!("[terse] proxy exited — cleaning up agent configs");
                        cleanup_proxy_configs();
                    }
                    Err(e) => {
                        eprintln!("[terse] failed to start local proxy: {}", e);
                    }
                }
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
            activate_session,
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
            // ── Parity commands ported from macOS ──
            minimize_window,
            open_url,
            check_ax_permission,
            trial_grace_status,
            get_agent_attribution,
            doctor_scan,
            doctor_apply_fix,
            doctor_dismiss,
            cleanup_scan,
            cleanup_clean,
            speed_mode_status,
            set_speed_mode,
            show_doctor_window,
            hide_doctor_window,
            navigate_to_doctor,
            show_main_window,
            navigate_to_cowork,
            get_cowork_config,
            set_cowork_token,
            set_cowork_share_logs,
            set_cowork_share_stats,
            clear_cowork_token,
            open_cloud_teams,
            send_slack_alert,
            show_island_window,
            hide_island_window,
            island_set_expanded,
            island_resize,
            focus_island,
            open_dashboards,
            hide_dashboards,
            toggle_dashboard,
            tile_dashboards,
            dashboards_visible,
            show_farm_window,
            hide_farm_window,
            farm_set_mini,
            get_farm_state,
            farm_plant,
            farm_water,
            farm_fertilize,
            farm_harvest,
            farm_clear,
            farm_remove_pest,
            farm_remove_weed,
            farm_expand,
            farm_buy_tile_skin,
            farm_buy_decoration,
            farm_sell_crops,
            farm_pool_plant,
            farm_pool_water,
            farm_pool_harvest,
            farm_pool_fertilize,
            farm_pool_clear,
            farm_add_fishing_coins,
            show_pet_window,
            hide_pet_window,
            get_pet_state,
            pick_starter_pet,
            unlock_pet,
            mark_pet_purchased,
            equip_pet,
            unlock_skin,
            equip_skin,
            set_pet_settings,
            pet_work_detected,
            // ── Parity: budget / burn-rate ──
            get_budget,
            set_budget,
            get_budget_status,
            // ── Parity: alerts / notifications ──
            notifications::dispatch_alert,
            notifications::get_alert_settings,
            notifications::set_alert_settings,
            notifications::get_recent_alerts,
            notifications::mark_alerts_read,
            notifications::clear_alerts,
            notifications::snooze_alert_kind,
            // ── Parity: circuit breaker ──
            circuit::get_circuit_settings,
            circuit::set_circuit_settings,
            circuit::get_circuit_trips,
            circuit::circuit_resume,
            // ── Parity: weekly digest ──
            digest::send_weekly_digest_now,
            // ── Parity: MCP manager ──
            mcp_manager::mcp_list,
            mcp_manager::mcp_set_enabled,
            // ── Parity: prompt library ──
            prompt_store::list_prompts,
            prompt_store::save_prompt,
            prompt_store::delete_prompt,
            prompt_store::get_prompt,
            prompt_store::record_prompt_use,
            // ── Parity: session history ──
            session_history::get_session_history,
            session_history::list_session_history,
            session_history::clear_session_history,
            session_history::delete_session_history,
            // ── Parity: command palette ──
            show_palette,
            hide_palette,
            insert_prompt_text,
            // ── Parity: session timeline / replay ──
            get_session_timeline,
            export_session_replay,
            // ── Parity: memory (CLAUDE.md) ──
            claude_md_list,
            claude_md_read,
            claude_md_write,
            // ── Parity: connectivity doctor ──
            connectivity_scan,
            connectivity_fix_all,
            // ── Parity: in-main-window navigation ──
            navigate_to_farm,
            navigate_to_alerts,
            navigate_to_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Parity commands ported from macOS: budget, palette, memory, timeline, connectivity ──

#[tauri::command]
fn get_budget(state: tauri::State<'_, AppState>) -> serde_json::Value {
    state.stats_store.lock().unwrap_or_else(|e| e.into_inner()).get_budget()
}

#[tauri::command]
fn set_budget(budget: serde_json::Value, state: tauri::State<'_, AppState>) -> bool {
    state.stats_store.lock().unwrap_or_else(|e| e.into_inner()).set_budget(budget);
    true
}

#[tauri::command]
fn get_budget_status(state: tauri::State<'_, AppState>) -> serde_json::Value {
    state.stats_store.lock().unwrap_or_else(|e| e.into_inner()).budget_status()
}

/// Navigate the MAIN window to the Farm in-place, sized up for the game.
#[tauri::command]
fn navigate_to_farm(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = win.current_monitor() {
            let sf = monitor.scale_factor();
            let sw = monitor.size().width as f64 / sf;
            let sh = monitor.size().height as f64 / sf;
            let w = 1200.0_f64.min(sw - 40.0);
            let h = 780.0_f64.min(sh - 80.0);
            let _ = win.set_size(tauri::LogicalSize::new(w, h));
            let _ = win.center();
        }
        if let Ok(url) = "tauri://localhost/farm.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/farm.html');");
        }
    }
}

/// Navigate the MAIN window to the Alert Center in-place.
#[tauri::command]
fn navigate_to_alerts(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = "tauri://localhost/alerts.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/alerts.html');");
        }
    }
}

/// Navigate the MAIN window to the session-history page in-place.
#[tauri::command]
fn navigate_to_history(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = "tauri://localhost/history.html".parse() {
            let _ = win.navigate(url);
        } else {
            let _ = win.eval("window.location.replace('/history.html');");
        }
    }
}

/// Open the prompt palette. Captures the frontmost app first (so an inserted
/// prompt is pasted back into it), then shows + focuses the palette window.
fn open_palette(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let front = capture::get_front_app().await;
        if let Some(st) = app.try_state::<AppState>() {
            let _ = st.palette_target.lock().map(|mut g| { *g = front.name.clone(); });
        }
        if let Some(w) = app.get_webview_window("palette") {
            let _ = w.show();
            let _ = w.set_focus();
            let _ = app.emit("palette-open", ());
        }
    });
}

#[tauri::command]
fn show_palette(app: AppHandle) {
    open_palette(&app);
}

#[tauri::command]
fn hide_palette(app: AppHandle) {
    if let Some(w) = app.get_webview_window("palette") {
        let _ = w.hide();
    }
}

/// Insert finished prompt text: copy to clipboard (guaranteed), then re-activate
/// the app that was frontmost when the palette opened and paste at the cursor.
#[tauri::command]
async fn insert_prompt_text(text: String, state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool, String> {
    let target = state.palette_target.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(w) = app.get_webview_window("palette") {
        let _ = w.hide();
    }
    // Guaranteed path: text is on the clipboard even if paste-back fails.
    let _ = apply_to_clipboard(text.clone()).await;
    if !target.is_empty() && target.to_lowercase() != "terse" {
        capture::activate_app(&target).await;
        tokio::time::sleep(std::time::Duration::from_millis(140)).await;
        let _ = capture::write_via_clipboard_terminal(&text).await;
    }
    Ok(true)
}

// ── Session timeline / shareable replay ──

#[tauri::command]
fn get_session_timeline(agent_type: Option<String>, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let at = agent_type.unwrap_or_default();
    let monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
    monitor.get_timeline_for(&at, 400).unwrap_or_else(|| serde_json::json!({ "steps": [], "totalSteps": 0 }))
}

/// HTML-escape for embedding text in the self-contained replay.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Render a timeline object into a single self-contained, shareable HTML file.
fn build_replay_html(tl: &serde_json::Value) -> String {
    let name = tl.get("agentName").and_then(|v| v.as_str()).unwrap_or("Agent");
    let project = tl.get("project").and_then(|v| v.as_str()).unwrap_or("");
    let model = tl.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let total_steps = tl.get("totalSteps").and_then(|v| v.as_u64()).unwrap_or(0);
    let total_tokens = tl.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let empty = vec![];
    let steps = tl.get("steps").and_then(|v| v.as_array()).unwrap_or(&empty);

    let mut rows = String::new();
    for st in steps {
        let role = st.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let ttype = st.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let tool = st.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
        let text = st.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let tokens = st.get("tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cost = st.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ts = st.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let label = if !tool.is_empty() { format!("{role} · {tool}") }
            else if !ttype.is_empty() { format!("{role} · {ttype}") }
            else { role.to_string() };
        rows.push_str(&format!(
            "<div class=\"step {role}\"><div class=\"meta\"><span class=\"role\">{}</span>\
             <span class=\"num\">{} tok · ${:.3}</span><span class=\"ts\">{}</span></div>\
             <pre>{}</pre></div>",
            html_escape(&label), tokens, cost, html_escape(ts), html_escape(text)
        ));
    }

    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Terse Replay — {name}</title>\
         <style>\
         body{{margin:0;background:#0b0f0c;color:#e8f0e8;font:14px/1.5 -apple-system,system-ui,sans-serif}}\
         header{{position:sticky;top:0;background:#0f1511;border-bottom:1px solid #223;padding:16px 24px}}\
         h1{{margin:0 0 4px;font-size:18px}}h1 b{{color:#c6f24e}}\
         .sub{{color:#8aa08a;font-size:13px}}\
         .wrap{{max-width:900px;margin:0 auto;padding:20px}}\
         .step{{border:1px solid #1c2a1c;border-radius:12px;margin:10px 0;overflow:hidden;background:#0f1511}}\
         .step.user{{border-color:#2a3a5a}}.step.assistant{{border-color:#3a2a5a}}.step.tool{{border-color:#2a3a2a}}\
         .meta{{display:flex;gap:12px;align-items:center;padding:8px 14px;background:#121a13;font-size:12px}}\
         .role{{font-weight:700;color:#c6f24e}}.num{{color:#8aa08a}}.ts{{margin-left:auto;color:#5a705a}}\
         pre{{margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word;color:#cfe0cf;font:12px/1.5 ui-monospace,Menlo,monospace}}\
         </style></head><body>\
         <header><div class=\"wrap\" style=\"padding:0\"><h1><b>Terse</b> Replay — {name}</h1>\
         <div class=\"sub\">{project}{model_sep}{model} · {total_steps} steps · {total_tokens} tokens</div></div></header>\
         <div class=\"wrap\">{rows}</div>\
         <div class=\"wrap\" style=\"color:#5a705a;font-size:12px;text-align:center;padding-bottom:40px\">Generated by Terse · terseai.org</div>\
         </body></html>",
        name = html_escape(name), project = html_escape(project),
        model_sep = if model.is_empty() { "" } else { " · " }, model = html_escape(model),
        total_steps = total_steps, total_tokens = total_tokens, rows = rows,
    )
}

/// Export the current timeline as a self-contained HTML replay in ~/Downloads;
/// returns the written file path.
#[tauri::command]
fn export_session_replay(agent_type: Option<String>, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let at = agent_type.unwrap_or_default();
    let tl = {
        let monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
        monitor.get_timeline_for(&at, 2000).ok_or_else(|| "no session to export".to_string())?
    };
    let html = build_replay_html(&tl);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let agent = tl.get("agentType").and_then(|v| v.as_str()).unwrap_or("agent");
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no downloads dir".to_string())?;
    let path = dir.join(format!("terse-replay-{agent}-{ts}.html"));
    std::fs::write(&path, html).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ── Rules / Memory Manager (Remember) — CLAUDE.md across projects ──

#[tauri::command]
fn claude_md_list() -> serde_json::Value {
    let home = dirs::home_dir().unwrap_or_default();
    let mut candidates: Vec<(std::path::PathBuf, &str)> = vec![
        (home.join(".claude/CLAUDE.md"), "Global"),
        (home.join(".claude/CLAUDE.local.md"), "Global (local)"),
    ];
    if let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(projs) = v.get("projects").and_then(|p| p.as_object()) {
                for key in projs.keys().take(60) {
                    candidates.push((std::path::Path::new(key).join("CLAUDE.md"), "Project"));
                }
            }
        }
    }
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (path, scope) in candidates {
        let ps = path.to_string_lossy().into_owned();
        if !seen.insert(ps.clone()) { continue; }
        if let Ok(meta) = std::fs::metadata(&path) {
            let bytes = meta.len();
            files.push(serde_json::json!({
                "path": ps,
                "name": path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                "scope": scope,
                "bytes": bytes,
                "tokens": bytes / 4,
            }));
        }
    }
    serde_json::json!({ "files": files })
}

#[tauri::command]
fn claude_md_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn claude_md_write(path: String, content: String) -> Result<bool, String> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(true)
}

// ── Connection Doctor — detect + auto-fix agent connectivity ──

#[tauri::command]
fn connectivity_scan() -> serde_json::Value {
    // Windows does not yet compute stalled-agent state; the API/DNS/proxy probes
    // are the substantive checks and run regardless.
    let stalled: Vec<String> = Vec::new();
    let checks = connectivity::scan(&stalled);
    let fails = checks.iter().filter(|c| c.status == "fail").count();
    let warns = checks.iter().filter(|c| c.status == "warn").count();
    let fixable = checks.iter().filter(|c| c.status != "ok" && c.fixable).count();
    let status = if fails > 0 { "fail" } else if warns > 0 { "warn" } else { "ok" };
    serde_json::json!({ "checks": checks, "fails": fails, "warns": warns, "fixable": fixable, "status": status })
}

#[tauri::command]
fn connectivity_fix_all() -> serde_json::Value {
    let stalled: Vec<String> = Vec::new();
    let before = connectivity::scan(&stalled);
    let (fixed, actions) = connectivity::apply_fixes(&before);
    std::thread::sleep(std::time::Duration::from_millis(600));
    let after_checks = connectivity::scan(&stalled);
    let remaining: Vec<_> = after_checks.iter().filter(|c| c.status != "ok").cloned().collect();
    serde_json::json!({
        "fixed": fixed,
        "actions": actions,
        "checks": after_checks,
        "remaining": remaining,
    })
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
                if name_lower == "terse"
                    || name_lower == "terse.exe"
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
                // ── Browsers: UIA reads URL bar, not page inputs. Use key monitor. ──
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
                // ── Other apps: UI Automation works reliably ──
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
                    // UIA failed — fall back to key monitor
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
