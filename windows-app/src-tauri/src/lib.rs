// The agent snapshot/timeline `json!` literals are large enough to blow the
// default 128-deep macro recursion limit (macOS carries the same raise).
#![recursion_limit = "512"]

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
mod graph_store;
mod graph_extract;

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
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
};

/// PID of the local optimizer proxy (node) so shutdown can kill it. A spawned
/// node child outlives its parent on Windows, so without this it kept port 7860
/// held after Terse quit.
static PROXY_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Kill everything Terse spawned: the UI Automation key-monitor helpers and the
/// local node proxy. Called from the tray's Quit item and from `RunEvent::Exit`,
/// so no exit path leaves stray processes in Task Manager.
fn shutdown_children(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.key_monitors.stop_all();
    }
    let pid = PROXY_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid != 0 {
        let _ = hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    // Undo the agent config ourselves. The proxy has its own cleanupOnExit, but
    // it is wired to SIGINT/SIGTERM/'exit' — and `taskkill /F` above is
    // TerminateProcess, which runs no handler at all. Windows has no signals, so
    // that cleanup has never once executed here.
    //
    // The cost of the gap is not cosmetic: openai_base_url = "http://127.0.0.1:
    // 7860/v1" stays in the user's ~/.codex/config.toml after Terse quits, and
    // Codex keeps sending requests to a port nothing is listening on — 502 Bad
    // Gateway, forever, until they find and delete the line by hand. A Pro user
    // on Windows 11 lost a working Codex to exactly this and had to diagnose it
    // themselves. Terse must not leave another program broken behind it.
    clear_codex_proxy_config();
}

/// Strip a terse-managed `openai_base_url` (a 127.0.0.1 address) from
/// `~/.codex/config.toml`, leaving everything else byte-for-byte alone.
///
/// Only ever removes OUR line — a user's own base URL pointing somewhere else is
/// left untouched. Safe to call when the file is absent or was never modified.
fn clear_codex_proxy_config() -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    let p = home.join(".codex").join("config.toml");
    let Ok(content) = std::fs::read_to_string(&p) else { return false };
    let cleaned: String = content
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with("openai_base_url") && t.contains("127.0.0.1"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    // `lines()` drops a trailing newline; put one back only if there was one.
    let cleaned = if content.ends_with('\n') && !cleaned.is_empty() {
        format!("{cleaned}\n")
    } else {
        cleaned
    };
    if cleaned != content {
        if std::fs::write(&p, cleaned).is_ok() {
            eprintln!("[terse] removed terse openai_base_url from {}", p.display());
            return true;
        }
    }
    false
}
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_deep_link::DeepLinkExt;

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
    /// Knowledge-graph runtime state (current repo + watch flag).
    pub graph: Mutex<graph_store::GraphState>,
    /// Live file watcher for the knowledge graph. Held so dropping it stops
    /// watching; `None` when live updates are off.
    pub graph_watcher: Mutex<Option<notify::RecommendedWatcher>>,
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
            graph: Mutex::new(graph_store::GraphState::new()),
            graph_watcher: Mutex::new(None),
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
    navigate_main(&app, "stats.html");
}

#[tauri::command]
fn navigate_back(app: AppHandle) {
    navigate_main(&app, "index.html");
}

#[tauri::command]
fn record_optimization(source: String, original_tokens: u64, optimized_tokens: u64, state: tauri::State<'_, AppState>, app: AppHandle) {
    let saved = original_tokens.saturating_sub(optimized_tokens);
    {
        let mut store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
        store.record_optimization(&source, original_tokens, optimized_tokens);
    }
    publish_usage_event(&state, &source, original_tokens, optimized_tokens);
    // stats.html re-renders off this; without it the Stats page only refreshed
    // when it was reopened.
    let _ = app.emit("stats-updated", ());
    // 1 coin per optimization call regardless of tokens saved
    {
        let mut pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
        pet_store.add_coins(1);
    }
    if saved > 0 {
        // Feed the pet
        let total = {
            let store = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
            store.get_stats("all")["summary"]["tokensSaved"].as_u64().unwrap_or(0)
        };
        let _ = app.emit("pet-fed", serde_json::json!({
            "saved": saved,
            "totalSaved": total,
            "source": source,
        }));
        // Milestone: every time coin balance crosses UNLOCK_COST_PET boundary
        let new_coins = {
            let pet_store = state.pet_store.lock().unwrap_or_else(|e| e.into_inner());
            pet_store.coin_balance()
        };
        let prev_coins = new_coins.saturating_sub(1); // before this coin
        if new_coins / pet_store::UNLOCK_COST_PET > prev_coins / pet_store::UNLOCK_COST_PET {
            let _ = app.emit("pet-milestone", serde_json::json!({
                "kind": "unlock-available",
                "text": format!("New unlock available! ({} coins)", new_coins),
            }));
        }
    }
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
fn get_doctor_settings() -> doctor::DoctorSettings {
    doctor::load_settings()
}

/// Toggle the fully-clear glass look, mirroring the macOS command exactly:
/// `enabled = true` (horizon) → strip the native material so the window is bare
/// transparent and the wallpaper reads through crisply; `false` (every other
/// dark theme) → put the material back so the desktop frosts behind the window.
///
/// Mac swaps an NSVisualEffectView. The Windows counterpart is Mica — DWM's
/// wallpaper-derived material, which behaves like vibrancy in that it blurs and
/// deliberately does not sample other windows. Acrylic is NOT the counterpart:
/// on 22H2+ it composites near-opaque whatever tint alpha it is given, and it
/// sat under the theme's own gradient, so the window read flat grey.
///
/// This used to call `clear_acrylic` unconditionally while `setup` applied
/// `apply_mica` — two different DWM attributes, so the clear was a no-op and
/// horizon could never actually go clear on Windows.
#[tauri::command]
fn set_clear_glass(app: tauri::AppHandle, enabled: bool) {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_mica, clear_mica};
        // Only the large rectangular surfaces, matching where `setup` rounds via
        // DWM. The island and toast are clipped to a shape with SetWindowRgn,
        // and DWM paints its backdrop over the whole rectangle ignoring that
        // region — mica on the island fills the pill's corners back in. They
        // stay plain transparent, which is also what Mac does with them.
        // Remembered for windows that do not exist yet: build_lazy_window reads
        // this so a Doctor opened after a theme change is not the one surface
        // still wearing the old finish.
        CLEAR_GLASS.store(enabled, std::sync::atomic::Ordering::Relaxed);
        for lbl in ["main", "doctor", "farm", "palette"] {
            if let Some(win) = app.get_webview_window(lbl) {
                // Both error on pre-22000 builds, where the window is simply
                // transparent already — a downgrade, not a breakage.
                if enabled {
                    let _ = clear_mica(&win);
                } else {
                    let _ = apply_mica(&win, Some(true));
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&app, enabled);
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
                        // OUR port only — not any loopback address.
                        //
                        // This matched every 127.0.0.1 URL, so it deleted a rival
                        // relay's setting at startup, before the proxy's chaining
                        // logic ever saw it. The proxy then found the key absent,
                        // concluded nobody owned it, and claimed the port outright.
                        // That is the whole "Claude Code sync stopped working"
                        // report: not the proxy overwriting the relay, this
                        // erasing it a moment earlier. CI reproduced it as
                        // CHAIN FAIL with settings.json reading 7860 and no
                        // upstream recorded.
                        let ours = url.contains(":7860");
                        if ours {
                            // Hand the setting back to whoever we chained in
                            // front of, rather than leaving Claude Code with
                            // nothing.
                            let restored = std::fs::read_to_string(
                                home.join(".terse").join("anthropic-upstream.json"),
                            )
                            .ok()
                            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(String::from));
                            match restored {
                                Some(up) => {
                                    env.insert(
                                        "ANTHROPIC_BASE_URL".into(),
                                        serde_json::Value::String(up.clone()),
                                    );
                                    eprintln!("[terse] restored ANTHROPIC_BASE_URL to {up}");
                                }
                                None => {
                                    env.remove("ANTHROPIC_BASE_URL");
                                }
                            }
                            if env.is_empty() {
                                json.as_object_mut().map(|o| o.remove("env"));
                            }
                            if let Ok(out) = serde_json::to_string_pretty(&json) {
                                let _ = std::fs::write(&settings_file, out);
                            }
                        } else {
                            eprintln!("[terse] leaving another proxy's ANTHROPIC_BASE_URL alone: {url}");
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
    app: AppHandle,
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
    // `app` goes along so the fix can emit per-step progress the card draws as a
    // progress bar, and so an elevated retry can be prompted mid-fix.
    tauri::async_runtime::spawn_blocking(move || doctor::apply_fix(&app, &finding))
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
    if let Some(w) = ensure_window(&app, "pet") { let _ = w.show(); }
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
        #[cfg(target_os = "windows")]
        if let Ok(raw) = win.hwnd() {
            strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
        }
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
            navigate_main(&app, "cowork.html");
        }
    });
}

/// Hide every dashboard widget window (positions are preserved).
#[tauri::command]
fn hide_dashboards(app: AppHandle) {
    // NOTE: the cursor poll stays alive — it also drives hover-OPEN on the pill.
    for (label, _, _, _, _, _) in dash_layout(island_screen_width(&app)) {
        if let Some(win) = app.get_webview_window(&label) {
            // DESTROY, not hide. Hiding a webview keeps its renderer process
            // resident for the rest of the session, so nine dashboards opened
            // once by a stray hover stayed in memory all day. They hold no state
            // worth preserving — every number is re-read from the backend on
            // open — and ensure_window rebuilds them on the next hover.
            //
            // No CloseRequested handler is registered for these, so nothing can
            // veto it and nothing is left half-closed.
            let _ = win.destroy();
        }
    }
}

/// Terse Rooms — parity with macOS show_room_window / hide_room_window.
#[tauri::command]
fn show_room_window(app: AppHandle, focus: Option<bool>) -> Result<(), String> {
    // ensure_window: the room is built on first open like the pet and the farm,
    // not kept resident from launch.
    if let Some(w) = ensure_window(&app, "room") {
        w.show().map_err(|e| e.to_string())?;
        // Appears BESIDE what you are doing when it opens itself with the room;
        // it only takes the keyboard when you asked for it by hand.
        if focus.unwrap_or(true) {
            w.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_room_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("room") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
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
        // The pet's state lives in pet_store on the Rust side, not in the page,
        // so closing it costs nothing and frees a renderer.
        w.destroy().map_err(|e| e.to_string())?;
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
        make_rounded(&win, ISLAND_CARD_W, clamped, 22.0);
    }
}

/// Size the island to an arbitrary alert-banner rect, kept top-center. Separate from
/// `island_resize` because an alert is its own width (wider than the pill, narrower
/// than the monitor card) rather than the fixed card width.
#[tauri::command]
fn island_alert_size(w: f64, h: f64, app: AppHandle) {
    if let Some(win) = app.get_webview_window("island") {
        let sw = island_screen_width(&app);
        let max_h = (island_screen_height(&app) - ISLAND_Y - 12.0).max(200.0);
        let cw = w.max(ISLAND_PILL_W).min((sw - 16.0).max(ISLAND_PILL_W));
        let ch = h.max(ISLAND_PILL_H).min(max_h);
        let x = ((sw - cw) / 2.0).max(0.0);
        let _ = win.set_size(tauri::LogicalSize::new(cw, ch));
        let _ = win.set_position(tauri::LogicalPosition::new(x, ISLAND_Y));
        make_rounded(&win, cw, ch, 22.0);
    }
}

/// True when the island overlay is on screen — lets the alert layer choose the island
/// as the presentation surface and fall back to the toast window otherwise.
#[tauri::command]
fn island_is_visible(app: AppHandle) -> bool {
    app.get_webview_window("island")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
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
        // Pill uses a full-height radius so the ends are semicircular; the card keeps 22px.
        let radius = if expanded { 22.0 } else { h / 2.0 };
        make_rounded(&win, w, h, radius);
    }
}

/// Clip a frameless window to a rounded-rectangle region so it reads as a pill/card
/// — the Windows equivalent of macOS's native island corner radius (22px). Windows 10
/// does NOT round frameless windows (that's Win11 only), and the acrylic backdrop fills
/// the whole rectangular window, so without this the island shows as a rectangle with a
/// tinted halo instead of the Mac's clean rounded pill. A GDI region is fixed to the size
/// it was built for, so this MUST be re-applied after every resize (pill <-> card).
/// Whether the last `set_clear_glass` asked for bare glass (horizon) or a
/// material. A window built after that call has to be told, or it would be the
/// one surface on screen wearing the wrong finish.
static CLEAR_GLASS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Everything setup() used to do to these windows AFTER building them.
///
/// The rounding, frame-stripping and event handlers live in loops in setup()
/// that run once, over the windows that exist at that moment. A window built
/// later is invisible to them, so it would come up with square corners, a native
/// caption and no re-strip on focus. This is that treatment, applied at build
/// time instead.
#[cfg(target_os = "windows")]
fn attach_lazy_chrome(w: &tauri::WebviewWindow, radius: f64) {
    // make_rounded calls strip_native_frame internally, so this covers both.
    let round = move |win: &tauri::WebviewWindow| {
        if let Ok(sz) = win.inner_size() {
            let sf = win.scale_factor().unwrap_or(1.0);
            make_rounded(win, sz.width as f64 / sf, sz.height as f64 / sf, radius);
        }
    };
    round(w);

    // DWM corner preference — the setup loop applies this to main/doctor/farm/
    // palette, because a GDI region does not clip a DWM backdrop.
    if let Ok(raw) = w.hwnd() {
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        };
        let pref = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                windows::Win32::Foundation::HWND(raw.0),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&pref) as u32,
            );
        }
    }

    // Match the material the rest of the app is wearing right now.
    if !CLEAR_GLASS.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = window_vibrancy::apply_mica(w, Some(true));
    }

    let w2 = w.clone();
    w.on_window_event(move |ev| {
        match ev {
            tauri::WindowEvent::Resized(_) => {
                round(&w2);
                if let Ok(raw) = w2.hwnd() {
                    strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                }
            }
            tauri::WindowEvent::Focused(_) => {
                if let Ok(raw) = w2.hwnd() {
                    strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                }
            }
            _ => {}
        }
    });
    clear_ghost_titlebar(w);
}

/// Build one of the on-demand windows.
///
/// Moved out of setup() so these four are no longer created at launch. Each was
/// a full WebView2 instance — its own renderer process, resident for the whole
/// session — sitting hidden behind `.visible(false)` for users who never open
/// the pet, the farm, the palette or the Doctor. Gating their animations helped
/// with drawing; it could not give back the process.
///
/// The geometry is derived here rather than inherited from setup's locals, which
/// is the only change from the original blocks.
#[cfg(target_os = "windows")]
fn build_lazy_window(app: &AppHandle, label: &str) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let (screen_width, monitor_h) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let sf = m.scale_factor();
            (m.size().width as f64 / sf, m.size().height as f64 / sf)
        })
        .unwrap_or((1920.0, 1080.0));

    let (w, radius) = match label {
        "palette" => {
            let pw = 560.0;
            let ph = 480.0;
            (
                WebviewWindowBuilder::new(app, "palette", WebviewUrl::App("palette.html".into()))
                    .title("Terse Prompt Palette")
                    .inner_size(pw, ph)
                    .position(((screen_width - pw) / 2.0) as f64, 120.0)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .resizable(false)
                    .shadow(false)
                    .skip_taskbar(true)
                    .focused(false)
                    .visible(false)
                    .build()?,
                14.0,
            )
        }
        "pet" => {
            let pw = 240.0;
            let ph = 260.0;
            (
                WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
                    .title("Terse Pet")
                    .inner_size(pw, ph)
                    .position((screen_width - pw - 24.0) as f64, (monitor_h - ph - 60.0) as f64)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .resizable(false)
                    .shadow(false)
                    .skip_taskbar(true)
                    .focused(false)
                    .visible(false)
                    .build()?,
                0.0,
            )
        }
        "farm" => (
            WebviewWindowBuilder::new(app, "farm", WebviewUrl::App("farm.html".into()))
                .title("Terse Farm")
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .inner_size(1366.0, 768.0)
                .min_inner_size(1100.0, 618.0)
                .position((screen_width / 2.0 - 683.0) as f64, 80.0)
                .always_on_top(false)
                .resizable(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?,
            16.0,
        ),
        "room" => (
            // Terse Rooms. Ported from macOS, minus the AppKit-only bits:
            // title_bar_style(Overlay) / hidden_title / accept_first_mouse have no
            // Windows equivalent, so this uses the frameless + transparent shape
            // every other window here uses and gets its rounding from
            // attach_lazy_chrome.
            WebviewWindowBuilder::new(app, "room", WebviewUrl::App("room.html".into()))
                .title("Terse Room")
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .inner_size(780.0, 480.0)
                .min_inner_size(560.0, 340.0)
                .position((screen_width / 2.0 - 390.0) as f64, 90.0)
                .always_on_top(false)
                .resizable(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?,
            16.0,
        ),
        "doctor" => (
            WebviewWindowBuilder::new(app, "doctor", WebviewUrl::App("doctor.html".into()))
                .title("Terse Doctor")
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .inner_size(1040.0, 800.0)
                .min_inner_size(820.0, 640.0)
                .position((screen_width / 2.0 - 520.0) as f64, 70.0)
                .always_on_top(false)
                .resizable(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()?,
            16.0,
        ),
        _ => {
            // The nine floating dashboards. Same treatment, geometry straight
            // from dash_layout so it cannot drift from the reposition path.
            //
            // These were the real resident cost, not the four above: the window
            // dump showed 'Terse Dashboard' NINE times at launch, one webview
            // each, for panels that appear on pill hover and are almost never
            // all open at once.
            let Some((_, kind, dx, dy, dw, dh)) = dash_layout(island_screen_width(app))
                .into_iter()
                .find(|(l, ..)| l == label)
            else {
                return Ok(());
            };
            let w = WebviewWindowBuilder::new(
                app, label, WebviewUrl::App(format!("dash.html?w={kind}").into()),
            )
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
            .build()?;
            make_rounded(&w, dw, dh, 20.0);
            eprintln!("[terse] built dashboard '{label}' on demand");
            return Ok(());
        }
    };

    // The pet is a shaped sprite, not a card — rounding it would clip the art.
    if radius > 0.0 {
        attach_lazy_chrome(&w, radius);
    } else if let Ok(raw) = w.hwnd() {
        strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
    }
    eprintln!("[terse] built '{label}' on demand");
    Ok(())
}

/// The window, building it first if this is the first time it has been asked for.
///
/// Drop-in for `get_webview_window` at every site that is about to SHOW one of
/// the on-demand windows. Sites that merely poke an already-open window still use
/// get_webview_window, so nothing is created as a side effect of a status check.
fn ensure_window(app: &AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Some(w);
    }
    // Build on the MAIN thread, and wait for it.
    //
    // Every call site here is a #[tauri::command], which runs on a worker
    // thread. Creating a webview off the main thread is not supported: on
    // Windows it produced a window that came up as about:blank with room.html
    // never loading, and the calling command hung. Reported exactly that way
    // after the Rooms build. setup() got away with it only because setup()
    // already runs on the main thread - moving creation to first use is what
    // exposed it, and it affects the pet, farm, palette, Doctor and the nine
    // dashboards equally, not just the room.
    //
    // run_on_main_thread is fire-and-forget, so a channel carries the result
    // back and this blocks until the window exists. Callers immediately call
    // .show() on what we return; handing them a half-built window is the bug.
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let a = app.clone();
        let lbl = label.to_string();
        let dispatched = app
            .run_on_main_thread(move || {
                if let Err(e) = build_lazy_window(&a, &lbl) {
                    eprintln!("[terse] could not build '{lbl}': {e}");
                }
                let _ = tx.send(());
            })
            .is_ok();
        if dispatched {
            // Bounded: a wedged main thread must not hang the command for ever.
            let _ = rx.recv_timeout(std::time::Duration::from_secs(10));
        }
    }
    app.get_webview_window(label)
}

fn make_rounded(win: &tauri::WebviewWindow, w_logical: f64, h_logical: f64, radius: f64) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{BOOL, HWND};
        use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
        let scale = win.scale_factor().unwrap_or(1.0);
        let w = (w_logical * scale).round() as i32;
        let h = (h_logical * scale).round() as i32;
        let d = (radius * scale * 2.0).round() as i32;
        if w > 0 && h > 0 {
            if let Ok(raw) = win.hwnd() {
                // tauri's hwnd() comes from a newer `windows` crate than our direct
                // dep, so its HWND is a different type. Rebuild our HWND from the raw
                // pointer (both are `HWND(*mut c_void)`) so the versions line up.
                let hwnd = HWND(raw.0);
                unsafe {
                    // SetWindowRgn takes ownership of the region; don't delete it.
                    let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, d, d);
                    let _ = SetWindowRgn(hwnd, rgn, BOOL(1));
                }
                strip_native_frame(hwnd);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (win, w_logical, h_logical, radius); }
}

/// Clear the WebView2 ghost titlebar (tauri#14764) by resizing the window once.
///
/// That upstream bug paints a leftover titlebar background BELOW the web content
/// on transparent windows; it is not a window style, which is why CI kept
/// reporting WS_CAPTION=false while the bar stayed on screen. The issue reports
/// that resizing makes it disappear, so nudge the height by a pixel and back.
///
/// The guard is essential: a resize fires Resized, whose handler strips the
/// frame, which previously nudged again — an infinite loop that wiped the island
/// off the desktop. This runs at most once at a time, and never from inside
/// strip_native_frame.
#[cfg(target_os = "windows")]
fn clear_ghost_titlebar(win: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static NUDGING: AtomicBool = AtomicBool::new(false);
    if NUDGING.swap(true, Ordering::SeqCst) {
        diag_log("frame-strip", &format!("flush SKIPPED (re-entrant) for '{}'", win.label()));
        return;
    }
    let styles = |w: &tauri::WebviewWindow| -> String {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE};
        match w.hwnd() {
            Ok(raw) => unsafe {
                let h = windows::Win32::Foundation::HWND(raw.0);
                format!(
                    "style=0x{:08X} ex=0x{:08X}",
                    GetWindowLongPtrW(h, GWL_STYLE),
                    GetWindowLongPtrW(h, GWL_EXSTYLE)
                )
            },
            Err(_) => "no hwnd".into(),
        }
    };
    let before = styles(win);
    if let Ok(sz) = win.inner_size() {
        let _ = win.set_size(tauri::PhysicalSize::new(sz.width, sz.height + 1));
        let _ = win.set_size(tauri::PhysicalSize::new(sz.width, sz.height));
        diag_log(
            "frame-strip",
            &format!(
                "flush RAN for '{}' {}x{}  before: {}  after: {}",
                win.label(), sz.width, sz.height, before, styles(win)
            ),
        );
    } else {
        diag_log("frame-strip", &format!("flush for '{}': inner_size() failed", win.label()));
    }
    NUDGING.store(false, Ordering::SeqCst);
}

/// Remove the native caption from a window built with `decorations(false)`.
///
/// tao leaves WS_CAPTION and WS_SYSMENU on undecorated windows so that snap and
/// resize keep working, and relies on DWM not painting them. That held while an
/// acrylic backdrop covered the non-client area; with the backdrop gone the OS
/// paints the caption itself, so the island rendered with a faint "Terse Island"
/// title and real minimize/maximize/close buttons floating over the pill — a
/// second window frame sitting behind the glass, exactly as reported.
///
/// WS_THICKFRAME is deliberately kept: it carries resizing, and dropping it
/// would freeze the size of every window this runs on.
#[cfg(target_os = "windows")]
fn strip_native_frame(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_EX_CLIENTEDGE,
        WS_EX_DLGMODALFRAME, WS_EX_STATICEDGE, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_POPUP, WS_SYSMENU,
    };
    use windows::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        // WS_CAPTION is WS_BORDER|WS_DLGFRAME, so the title bar and its border
        // both go with it.
        let drop_bits =
            (WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as isize;
        // Adding WS_POPUP is what actually guarantees it: a popup window has no
        // caption by definition, so this holds even if something re-sets the
        // caption bit behind us. Clearing the bits alone left the classic grey
        // gradient title bar drawn by USER32.
        let stripped = (style & !drop_bits) | WS_POPUP.0 as isize;
        // The extended styles draw their own raised/sunken edges, which survive
        // the caption removal and leave a visible outline around the glass.
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let ex_stripped = ex
            & !((WS_EX_DLGMODALFRAME.0 | WS_EX_WINDOWEDGE.0 | WS_EX_CLIENTEDGE.0
                | WS_EX_STATICEDGE.0) as isize);
        if ex_stripped != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_stripped);
        }
        // Belt and braces: tell DWM not to render the non-client area at all.
        // Clearing the style bits removed the min/max/close buttons but DWM kept
        // painting the caption itself, so the ghost "Terse Island" / "Terse"
        // title survived on top of the glass. DWMNCRP_DISABLED stops that at the
        // compositor, whatever the style bits end up saying — and it is immune
        // to anything that re-applies them later on show or focus.
        {
            use windows::Win32::Graphics::Dwm::{
                DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY,
            };
            let policy = DWMNCRP_DISABLED;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                &policy as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&policy) as u32,
            );
        }
        if stripped != style || ex_stripped != ex {
            SetWindowLongPtrW(hwnd, GWL_STYLE, stripped);
            // Without SWP_FRAMECHANGED the non-client area is not recalculated
            // and the caption keeps being drawn until something else resizes it.
            let _ = SetWindowPos(
                hwnd, None, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            // SWP_FRAMECHANGED recalculates the non-client area but does not make
            // DWM rebuild the window's composited surface. On a transparent
            // window nothing repaints the strip where the caption used to be, so
            // the old title stayed on screen as a ghost long after WS_CAPTION
            // was gone — the CI diagnostic reported WS_CAPTION=False on every
            // window while the screenshot still showed "Terse Island". Force a
            // frame redraw. NOT a size nudge: resizing fires a Resized event,
            // whose handler calls back into this function, which resizes
            // again — an infinite loop that wedged the island right off the
            // desktop the one build it shipped in.
            let _ = RedrawWindow(
                hwnd, None, None,
                RDW_FRAME | RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN,
            );
        }
    }
}

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
    navigate_main(&app, "cowork.html");
}

/// Navigate the MAIN window to the Doctor (体检) report in-place. This keeps the
/// Doctor inside the single main window (reached via the dock button) instead of
/// spawning a second floating window.
#[tauri::command]
fn navigate_to_doctor(app: AppHandle) {
    navigate_main(&app, "doctor.html");
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
        // ensure_window, not get_webview_window: these are no longer built at
        // launch, so the first hover on the pill is what creates them.
        if let Some(win) = ensure_window(&app, &label) {
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
        if let Some(w) = ensure_window(&app, "pet") { let _ = w.show(); }
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
            &st, &source, "windows", "", "", &mode,
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
    if let Some(w) = ensure_window(&app, "doctor") {
        #[cfg(target_os = "windows")]
        if let Ok(raw) = w.hwnd() {
            strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
        }
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_farm_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = ensure_window(&app, "farm") {
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
        navigate_main(&app, "index.html");
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn show_pet_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = ensure_window(&app, "pet") {
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
        // single-instance MUST be registered first; with the deep-link feature it
        // also forwards a `terse://` URL from a second launch to the running app —
        // on Windows that second launch is how the browser hands the sign-in token
        // over, so without this `handle_connect_url` never fires.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                if let Ok(raw) = win.hwnd() {
                    strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                }
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        // Native folder picker — Tauri webviews have no JS `prompt()`, so
        // `graph_pick_folder` needs the dialog plugin.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        // Remember each floating window's position/size across restarts and
        // multi-monitor setups — but NEVER restore visibility or maximized/
        // fullscreen state. Default flags include VISIBLE, which would re-open
        // every window that was open at last quit (farm, palette, dashboards…).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            // Register the terse:// connect handler + handle a cold-start launch URL.
            {
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_connect_url(&handle, &url);
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        handle_connect_url(app.handle(), &url);
                    }
                }
            }
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

            // ── Prompt palette window (Ctrl+Shift+K) ──
            // Frameless, transparent, always-on-top, centred near the top of the
            // screen like a Spotlight/Raycast launcher. Hidden until the hotkey.
            // Without this window `show_palette` had nothing to show.
            // palette / pet / farm / doctor are NOT built here any more — see
            // build_lazy_window. Each was a resident WebView2 renderer process for
            // a window most users never open.

            // ── Live token wallpaper window (desktop-pinned; hidden until enabled) ──
            // Built once here on the main thread; enable/disable just shows/hides it.
            {
                let (ww, wh) = app
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map(|m| {
                        let sf = m.scale_factor();
                        (m.size().width as f64 / sf, m.size().height as f64 / sf)
                    })
                    .unwrap_or((1920.0, 1080.0));
                let _wall = WebviewWindowBuilder::new(app, "wallpaper", WebviewUrl::App("wallpaper.html".into()))
                    .title("Terse Wallpaper")
                    .inner_size(ww, wh)
                    .position(0.0, 0.0)
                    .decorations(false)
                    .transparent(false)
                    .resizable(false)
                    .shadow(false)
                    .skip_taskbar(true)
                    .focused(false)
                    .visible(false)
                    .build()?;
            }

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

            // ── Alert toast window ──
            // Terse's own notification banner, top-right, always on top. It replaces
            // the OS notification (unthemeable, English-only, absent on Windows).
            // Created hidden and resized to its card stack by toast.js.
            let toast_x = screen_width - notifications::TOAST_W - 14.0;
            let _toast_win = WebviewWindowBuilder::new(app, "toast", WebviewUrl::App("toast.html".into()))
                .title("Terse Alert")
                .inner_size(notifications::TOAST_W, 140.0)
                .position(toast_x, 42.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(false)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .accept_first_mouse(true)
                .visible_on_all_workspaces(true)
                .visible(false)
                .build()?;

            // ── Floating dashboard widget windows (灵动仪表盘) ──
            // Built on first hover, not here — see build_lazy_window. The window
            // dump showed NINE of these resident at launch, one webview each.

            // Backdrop material: bare transparency at startup, Mica on demand.
            //
            // Four attempts, so the reasoning is worth keeping. apply_acrylic
            // composites a near-opaque backdrop on Windows 11 22H2+ (26100 here)
            // whatever tint alpha it is given, and it sat UNDER the theme's own
            // translucent gradient — the window read as flat grey however far
            // the tint came down. Mica is the Win11 material that does behave
            // like macOS vibrancy: DWM derives it from the DESKTOP WALLPAPER,
            // blurred and tinted, and deliberately does not sample other
            // windows, so background windows stop bleeding through.
            //
            // But applying it at startup is what made every big Windows window
            // look frosted where Mac looked like clear glass — Mac applies no
            // material until the theme asks for one. So Mica moved to
            // set_clear_glass, which is the same seam Mac swaps vibrancy on.
            #[cfg(target_os = "windows")]
            {
                // NO backdrop material at startup — the Mac build's rule, ported.
                //
                // src-tauri/src/lib.rs:4183 spells out why: "horizon" is the
                // default theme and it is clear glass, so applying a native
                // material underneath frosts the desktop into a flat slab, which
                // is the exact look horizon exists to avoid. Mac therefore starts
                // bare and lets the frontend call set_clear_glass(false) when the
                // user picks any other theme. Mica was being applied here
                // unconditionally, which is why every big Windows window read as
                // frosted while the same theme on Mac read as clear glass.
                //
                // Trade-off this re-opens, recorded so it isn't rediscovered a
                // fourth time: bare transparency has no material, so windows
                // behind Terse show through sharply instead of dissolving into a
                // wash. Mica hid that by deriving its backdrop from the wallpaper
                // only. It now comes back with the theme, via set_clear_glass.
                for lbl in ["main", "doctor", "farm", "palette"] {
                    if let Some(w) = app.get_webview_window(lbl) {
                        // Round these through DWM rather than SetWindowRgn. The
                        // GDI region does not clip the mica backdrop, so a
                        // mica'd window rounded that way still shows four square
                        // corners; DWMWA_WINDOW_CORNER_PREFERENCE rounds the
                        // composited result, backdrop included.
                        if let Ok(raw) = w.hwnd() {
                            use windows::Win32::Graphics::Dwm::{
                                DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                                DWMWCP_ROUND,
                            };
                            let pref = DWMWCP_ROUND;
                            unsafe {
                                let _ = DwmSetWindowAttribute(
                                    windows::Win32::Foundation::HWND(raw.0),
                                    DWMWA_WINDOW_CORNER_PREFERENCE,
                                    &pref as *const _ as *const std::ffi::c_void,
                                    std::mem::size_of_val(&pref) as u32,
                                );
                            }
                        }
                    }
                }
                // Every frameless window needs the rounded GDI region, not just
                // the island. Windows does not round frameless windows itself
                // (Win11 rounds only decorated ones), and the acrylic backdrop
                // fills the raw rectangle — so a card whose CSS has a 20px
                // radius renders with four opaque black square corners poking
                // out past its own border. That is the corner artefact visible
                // on every dashboard.
                for (label, _, _, _, w_l, h_l) in dash_layout(screen_width) {
                    if let Some(w) = app.get_webview_window(&label) {
                        make_rounded(&w, w_l, h_l, 20.0);
                    }
                }
                // Same for the other frameless surfaces. Doctor and Farm are
                // resizable, so their region is re-cut on resize; palette and
                // toast are fixed.
                for (lbl, radius) in [("doctor", 16.0), ("farm", 16.0), ("palette", 14.0), ("toast", 14.0)] {
                    if let Some(w) = app.get_webview_window(lbl) {
                        let round = move |win: &tauri::WebviewWindow| {
                            if let Ok(sz) = win.inner_size() {
                                let sf = win.scale_factor().unwrap_or(1.0);
                                make_rounded(win, sz.width as f64 / sf, sz.height as f64 / sf, radius);
                            }
                        };
                        round(&w);
                        let w2 = w.clone();
                        w.on_window_event(move |ev| {
                            if let tauri::WindowEvent::Resized(_) = ev { round(&w2); }
                        });
                    }
                }
                // Clip the island to a rounded pill (its acrylic fills the whole
                // rectangle otherwise) so it matches macOS's rounded island. The
                // pill uses a full-height radius; resize handlers re-round on expand.
                if let Some(w) = app.get_webview_window("island") {
                    make_rounded(&w, ISLAND_PILL_W, ISLAND_PILL_H, ISLAND_PILL_H / 2.0);
                }

                // Same treatment for the main window: styles.css gives body a 16px
                // radius, but the acrylic backdrop fills the raw rectangle, so
                // without a matching GDI region the glass slab has square corners
                // poking out past its own rounded edge. The main window is
                // resizable and a region is fixed to the size it was cut for, so
                // re-cut it on every resize.
                if let Some(w) = app.get_webview_window("main") {
                    let round_main = |win: &tauri::WebviewWindow| {
                        if let Ok(sz) = win.inner_size() {
                            let sf = win.scale_factor().unwrap_or(1.0);
                            make_rounded(win, sz.width as f64 / sf, sz.height as f64 / sf, 16.0);
                        }
                    };
                    round_main(&w);
                    let w2 = w.clone();
                    w.on_window_event(move |ev| {
                        if let tauri::WindowEvent::Resized(_) = ev {
                            if let Ok(sz) = w2.inner_size() {
                                let sf = w2.scale_factor().unwrap_or(1.0);
                                make_rounded(&w2, sz.width as f64 / sf, sz.height as f64 / sf, 16.0);
                            }
                        }
                    });
                }
            }

            // Every window this app creates is decorations(false) — main and the
            // popup from tauri.conf.json, the rest from their builders — so none
            // of them should carry a native caption. strip_native_frame runs
            // inside make_rounded, but main and several others never go through
            // make_rounded, which is why the MAIN window still showed a ghost
            // "Terse" title and □ ✕ buttons after the island was fixed. Sweep
            // every window once, here, after they all exist, rather than relying
            // on whichever ones happen to be rounded.
            #[cfg(target_os = "windows")]
            for (_label, w) in app.webview_windows() {
                // EXCEPT the wallpaper. strip_native_frame adds WS_POPUP, and a
                // popup cannot also be WS_CHILD — which is exactly what a window
                // re-parented into WorkerW has to be to draw on the desktop
                // surface. This sweep runs over every window and so quietly
                // turned the wallpaper back into a popup after pin_wallpaper_window
                // had made it a child, and the Resized that pinning fires re-ran
                // it again afterwards. The window was parented correctly and
                // still drew nothing.
                if _label == "wallpaper" {
                    continue;
                }
                if let Ok(raw) = w.hwnd() {
                    strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                }
                // Most of these windows are built hidden and shown later, and the
                // frame comes back when they are. Stripping once during setup is
                // therefore not enough — the Doctor window kept its caption for
                // exactly this reason. Re-strip on show/focus/resize. Tauri keeps
                // window-event listeners in a list, so this does not displace the
                // rounding handlers registered above.
                let w2 = w.clone();
                w.on_window_event(move |ev| {
                    if matches!(
                        ev,
                        tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)
                    ) {
                        if let Ok(raw) = w2.hwnd() {
                            strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                        }
                        // Then flush the stale surface, ONCE per window, the first
                        // time it is focused.
                        //
                        // Stripping the style stops the caption being drawn again;
                        // it does not erase what was already drawn. On a
                        // transparent window nothing repaints that strip, so
                        // whatever landed there before the strip just stays. CI
                        // proves it is exactly this: with identical app code, two
                        // consecutive runs disagreed — the island came out clean in
                        // one and ghosted in the other, while the Doctor ghosted in
                        // both. That is a race against the first paint, not a
                        // missing style bit, and it is why WS_CAPTION=False kept
                        // being reported next to a visible title bar.
                        //
                        // The nudge already existed but was only ever applied to
                        // `main`, which is why main is the one window that came out
                        // clean consistently. Every frameless window needs it.
                        //
                        // Only on first focus: nudging on every focus/resize would
                        // flicker, and the re-entrancy guard inside
                        // clear_ghost_titlebar stops the Resized this fires from
                        // nudging again.
                        if matches!(ev, tauri::WindowEvent::Focused(true)) {
                            use std::collections::HashSet;
                            use std::sync::Mutex;
                            static FLUSHED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
                            let mut g = FLUSHED.lock().unwrap_or_else(|e| e.into_inner());
                            let seen = g.get_or_insert_with(HashSet::new);
                            if seen.insert(w2.label().to_string()) {
                                drop(g);
                                clear_ghost_titlebar(&w2);
                            }
                        }
                    }
                });
            }

            // main is `visible: false` in tauri.conf.json on Windows ONLY, and is
            // shown HERE, after the sweep above has stripped its frame. Tauri
            // creates and shows a visible:true window before setup() runs, so
            // Windows painted main's caption before any of our code could strip
            // it — and on a transparent window nothing ever repaints over those
            // pixels, which is why the ghost "Terse" title outlived four
            // different fixes. Stripping first and showing second is the only
            // ordering where the caption is never drawn at all.
            #[cfg(target_os = "windows")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                // No flush here any more. frame-strip.log caught this call
                // running while main was style=0x14CF0000 — WS_CAPTION,
                // WS_SYSMENU, WS_THICKFRAME, min/max, no WS_POPUP. In other
                // words the sweep above HAD stripped it, and then show() put the
                // whole native frame back, so this flush was repainting a window
                // that still had a real caption — flushing the ghost IN rather
                // than out.
                //
                // set_focus() fires Focused(true), whose handler strips the frame
                // and only then flushes. The third line of that same log confirms
                // the ordering works: main flushed again at style=0x94040000,
                // WS_POPUP set and no caption. That is the flush that clears it,
                // and it is the one the island and Doctor now get too.
            }

            // Tray icon + right-click menu (parity with macOS). Until now the
            // Windows tray had NO menu, so there was no way to quit Terse at all —
            // users had to kill it from Task Manager.
            let tray_show = MenuItemBuilder::with_id("tray_show", "Show / Hide Terse").build(app)?;
            let mode_light = MenuItemBuilder::with_id("mode_light", "Mode: Soft").build(app)?;
            let mode_balanced = MenuItemBuilder::with_id("mode_balanced", "Mode: Normal").build(app)?;
            let mode_aggressive = MenuItemBuilder::with_id("mode_aggressive", "Mode: Aggressive").build(app)?;
            let tray_doctor = MenuItemBuilder::with_id("tray_doctor", "Open Doctor · 体检").build(app)?;
            let tray_stats = MenuItemBuilder::with_id("tray_stats", "Open Stats").build(app)?;
            let tray_quit = MenuItemBuilder::with_id("tray_quit", "Quit Terse").build(app)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[
                    &tray_show, &sep,
                    &mode_light, &mode_balanced, &mode_aggressive, &sep,
                    &tray_doctor, &tray_stats, &sep,
                    &tray_quit,
                ])
                .build()?;

            let toggle_main = |app: &AppHandle| {
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            };

            let _tray = TrayIconBuilder::new()
                .tooltip("Terse")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let app = app.clone();
                    match event.id().as_ref() {
                        "tray_show" => toggle_main(&app),
                        "tray_doctor" => {
                            if let Some(win) = ensure_window(&app, "doctor") {
                                #[cfg(target_os = "windows")]
                                if let Ok(raw) = win.hwnd() {
                                    strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                                }
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "tray_stats" => {
                            if let Some(win) = app.get_webview_window("main") {
                                #[cfg(target_os = "windows")]
                                if let Ok(raw) = win.hwnd() {
                                    strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
                                }
                                let _ = win.show();
                                let _ = win.set_focus();
                                navigate_main(&app, "stats.html");
                            }
                        }
                        // Clean shutdown: kill helper children first, then exit.
                        // RunEvent::Exit does the same for every other exit path.
                        "tray_quit" => {
                            shutdown_children(&app);
                            app.exit(0);
                        }
                        id @ ("mode_light" | "mode_balanced" | "mode_aggressive") => {
                            let mode = match id {
                                "mode_light" => "light",
                                "mode_aggressive" => "aggressive",
                                _ => "balanced",
                            };
                            let state = app.state::<AppState>();
                            let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
                            s.aggressiveness = mode.to_string();
                            let _ = app.emit("settings-changed", serde_json::to_value(&*s).unwrap_or_default());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
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

            // Register global shortcuts. These are optional conveniences — if
            // another app already owns the hotkey (very common with Ctrl+Shift+C
            // on Windows: WeChat, screenshot tools, etc.), registration returns
            // "HotKey already registered". Never let that abort setup: a taken
            // shortcut must not stop the whole app from launching.
            let app_handle = app.handle().clone();
            if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+T", move |_app, _shortcut, _event| {
                if let Some(win) = app_handle.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }) {
                eprintln!("[terse] Ctrl+Shift+T shortcut unavailable (already in use): {}", e);
            }

            // Doctor (体检) toggle — parity with macOS ⌘⇧D.
            let app_handle_doctor = app.handle().clone();
            if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+D", move |_app, _shortcut, _event| {
                if let Some(win) = ensure_window(&app_handle_doctor, "doctor") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }) {
                eprintln!("[terse] Ctrl+Shift+D shortcut unavailable (already in use): {}", e);
            }

            // Prompt Library — parity with macOS ⌘⇧K. The library lives inside the
            // main window as a sidebar panel, so this just fronts the window and
            // asks the frontend to open it.
            let app_handle_prompts = app.handle().clone();
            if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+K", move |_app, _shortcut, _event| {
                if let Some(win) = app_handle_prompts.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                    let _ = win.emit("open-prompts", ());
                }
            }) {
                eprintln!("[terse] Ctrl+Shift+K shortcut unavailable (already in use): {}", e);
            }

            let app_handle2 = app.handle().clone();
            if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+C", move |_app, _shortcut, _event| {
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
            }) {
                eprintln!("[terse] Ctrl+Shift+C shortcut unavailable (already in use): {}", e);
            }

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
                // Heal a config left behind by any earlier crash, force-kill or
                // older build, BEFORE the new proxy decides what to write.
                //
                // Users already stranded by this cannot be reached by a fix that
                // only runs on exit — their config.toml is broken right now, and
                // the only symptom is Codex failing with 502 against a dead port,
                // which reads like an OpenAI outage rather than something Terse
                // did. Clearing it at startup means installing the update is the
                // whole repair; nobody has to hand-edit a TOML file.
                //
                // Safe to do unconditionally: the proxy re-adds the line moments
                // later if this session should be routed, and now skips it
                // entirely for ChatGPT-account sessions.
                clear_codex_proxy_config();
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
                        PROXY_PID.store(child.id(), std::sync::atomic::Ordering::SeqCst);
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

            // Auto-build knowledge graphs for every repo an agent is working in,
            // caching them locally so the Graph tab opens instantly and agents get
            // an up-to-date token-saving digest without the user lifting a finger.
            start_graph_autobuild(app.handle().clone());

            // Restore the live desktop wallpaper if the user left it enabled.
            // (The window was created above; re-parenting behind the desktop is
            // dispatched to the main thread by show_wallpaper_window.)
            if get_wallpaper_config().get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                let _ = show_wallpaper_window(&app.handle());
            }

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
            show_room_window,
            hide_room_window,
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
            island_alert_size,
            island_is_visible,
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
            notifications::toast_resize,
            notifications::toast_hide,
            notifications::toast_action,
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
            navigate_to_graph,
            navigate_to_wallpaper,
            // ── Parity: knowledge graph ──
            graph_status,
            graph_build,
            graph_get,
            graph_list,
            graph_add_folder,
            graph_pick_folder,
            graph_remove,
            graph_save_overlay,
            graph_write_digest,
            graph_set_watch,
            // ── Parity: live desktop wallpaper ──
            get_desktop_picture,
            get_wallpaper_config,
            set_wallpaper_config,
            set_wallpaper_enabled,
            get_token_pulse,
            // ── Parity: referrals + upgrade prompt ──
            request_upgrade,
            get_referral_info,
            redeem_referral_code,
            focus_app,
            get_doctor_settings,
            set_clear_glass,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Every exit path — tray Quit, Alt+F4 on the last window, a taskbar
            // close, a signal — lands here. Reap our helper children before the
            // process goes away so nothing survives in Task Manager.
            if let tauri::RunEvent::Exit = event {
                shutdown_children(app);
            }
        });
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
        navigate_main(&app, "farm.html");
    }
}

/// Navigate the MAIN window to the Alert Center in-place.
#[tauri::command]
fn navigate_to_alerts(app: AppHandle) {
    navigate_main(&app, "alerts.html");
}

/// Navigate the MAIN window to the session-history page in-place.
#[tauri::command]
fn navigate_to_history(app: AppHandle) {
    navigate_main(&app, "history.html");
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
        if let Some(w) = ensure_window(&app, "palette") {
            #[cfg(target_os = "windows")]
            if let Ok(raw) = w.hwnd() {
                strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
            }
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
        // Same reasoning as the dashboards: the palette is a stateless picker,
        // rebuilt from the prompt store each time it opens.
        let _ = w.destroy();
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
fn connectivity_scan(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let stalled = {
        let monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
        monitor.stalled_agents()
    };
    let checks = connectivity::scan(&stalled);
    let fails = checks.iter().filter(|c| c.status == "fail").count();
    let warns = checks.iter().filter(|c| c.status == "warn").count();
    let fixable = checks.iter().filter(|c| c.status != "ok" && c.fixable).count();
    let status = if fails > 0 { "fail" } else if warns > 0 { "warn" } else { "ok" };
    serde_json::json!({ "checks": checks, "fails": fails, "warns": warns, "fixable": fixable, "status": status })
}

#[tauri::command]
fn connectivity_fix_all(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let stalled = {
        let monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
        monitor.stalled_agents()
    };
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


// ── Knowledge Graph ─────────────────────────────────────────────────────────
//
// A Graphify-style code knowledge graph built locally with tree-sitter (see
// graph_extract.rs), with a token-optimized digest agents read instead of
// grepping (graph_store::write_digest) and a human overlay that survives
// re-extraction (graph_store::merge). Live updates come from a debounced notify
// watcher toggled by `graph_set_watch`.

/// Resolve which repo to operate on: explicit arg → last-opened repo → the repo
/// the active coding agent is currently working in.
fn resolve_repo(path: Option<String>, state: &AppState) -> Option<std::path::PathBuf> {
    if let Some(p) = path {
        let p = p.trim();
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    if let Some(r) = lock_or_recover(&state.graph).current_repo.clone() {
        return Some(r);
    }
    graph_extract::detect_active_repo().map(std::path::PathBuf::from)
}

/// Merge overlay, (re)write the digest, optionally credit token savings to Stats,
/// then notify the UI. `record` is true only for user-initiated builds so live
/// watcher rebuilds don't inflate the savings counter.
fn finalize_graph(
    app: &AppHandle,
    repo: &std::path::Path,
    graph: &graph_store::KnowledgeGraph,
    record: bool,
) -> serde_json::Value {
    let overlay = graph_store::load_overlay(&graph.repo_hash);
    let merged = graph_store::merge(graph, &overlay);

    let (tokens_saved, digest_tokens) = match graph_store::write_digest(repo, &merged) {
        Ok(res) => {
            if record && res.source_tokens > 0 {
                let state = app.state::<AppState>();
                lock_or_recover(&state.stats_store)
                    .record_optimization("graph", res.source_tokens, res.digest_tokens);
            }
            (res.tokens_saved(), res.digest_tokens)
        }
        Err(_) => (0, 0),
    };

    let _ = app.emit(
        "graph-updated",
        serde_json::json!({
            "repo": repo.to_string_lossy(),
            "builtAt": graph.built_at,
            "nodes": merged.nodes.len(),
            "edges": merged.edges.len(),
        }),
    );

    serde_json::json!({
        "ok": true,
        "repo": repo.to_string_lossy(),
        "builtAt": graph.built_at,
        "nodes": merged.nodes.len(),
        "edges": merged.edges.len(),
        "files": graph.file_count,
        "clusters": merged.communities.len(),
        "tokensSaved": tokens_saved,
        "digestTokens": digest_tokens,
    })
}

#[tauri::command]
fn graph_status(path: Option<String>, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let detected = graph_extract::detect_active_repo();
    let watching = lock_or_recover(&state.graph).watching;
    let mut out = serde_json::json!({ "watching": watching, "detected": detected });
    if let Some(repo) = resolve_repo(path, &state) {
        let hash = graph_store::repo_hash(&repo);
        out["repo"] = serde_json::json!(repo.to_string_lossy());
        if let Some(g) = graph_store::load_graph(&hash) {
            out["hasGraph"] = serde_json::json!(true);
            out["builtAt"] = serde_json::json!(g.built_at);
            out["nodes"] = serde_json::json!(g.nodes.len());
            out["edges"] = serde_json::json!(g.edges.len());
            out["files"] = serde_json::json!(g.file_count);
            out["clusters"] = serde_json::json!(g.communities.len());
        } else {
            out["hasGraph"] = serde_json::json!(false);
        }
    } else {
        out["hasGraph"] = serde_json::json!(false);
    }
    out
}

/// Shared build path: extract off-thread, cache, write the digest, and record it
/// in the registry. `record` credits token savings to Stats (user-initiated only);
/// `set_current` points the app at this repo (skip for silent background builds).
async fn do_graph_build(
    app: &AppHandle,
    repo: std::path::PathBuf,
    source: &str,
    record: bool,
    set_current: bool,
) -> Result<serde_json::Value, String> {
    if !repo.exists() {
        return Err(format!("Path does not exist: {}", repo.display()));
    }
    {
        let state = app.state::<AppState>();
        let mut gs = lock_or_recover(&state.graph);
        gs.upsert(&repo, source);
        if set_current {
            gs.set_repo(&repo);
        }
    }
    let repo2 = repo.clone();
    let graph = tauri::async_runtime::spawn_blocking(move || graph_extract::build(&repo2))
        .await
        .map_err(|e| e.to_string())?;
    graph_store::save_graph(&graph);
    let out = finalize_graph(app, &repo, &graph, record);
    let saved = out.get("tokensSaved").and_then(|v| v.as_u64()).unwrap_or(0);
    {
        let state = app.state::<AppState>();
        lock_or_recover(&state.graph).mark_built(&graph, saved);
    }
    Ok(out)
}

#[tauri::command]
async fn graph_build(path: Option<String>, app: AppHandle) -> Result<serde_json::Value, String> {
    let repo = {
        let state = app.state::<AppState>();
        resolve_repo(path, &state)
            .ok_or("No repository detected. Open a folder path, or start a coding agent in one.")?
    };
    do_graph_build(&app, repo, "auto", true, true).await
}

/// Register a folder the user picks and build its graph immediately.
#[tauri::command]
async fn graph_add_folder(path: String, app: AppHandle) -> Result<serde_json::Value, String> {
    let repo = std::path::PathBuf::from(path.trim());
    if !repo.is_dir() {
        return Err(format!("Not a folder: {}", repo.display()));
    }
    do_graph_build(&app, repo, "manual", true, true).await
}

/// Open a native folder picker and return the chosen path (or null if cancelled).
/// Tauri webviews don't implement JS `prompt()`, so folder selection must go
/// through the dialog plugin.
#[tauri::command]
async fn graph_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|fp| fp.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string()))
}

/// All known graphs (registry ∪ currently-detected active repos) for the switcher.
#[tauri::command]
fn graph_list(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let active = graph_extract::detect_active_repos();
    let active_set: std::collections::HashSet<&String> = active.iter().collect();
    let (entries, last_viewed) = {
        let mut gs = lock_or_recover(&state.graph);
        gs.upsert_active(&active);
        let last_viewed = gs.registry.last_viewed.clone();
        let mut entries: Vec<serde_json::Value> = gs
            .registry
            .repos
            .iter()
            .map(|e| {
                let name = std::path::Path::new(&e.repo)
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|| e.repo.clone());
                serde_json::json!({
                    "repo": e.repo,
                    "name": name,
                    "source": e.source,
                    "builtAt": e.built_at,
                    "nodes": e.nodes,
                    "edges": e.edges,
                    "files": e.files,
                    "tokensSaved": e.tokens_saved,
                    "hasGraph": graph_store::cache_exists(&e.hash),
                    "active": active_set.contains(&e.repo),
                    "lastActive": e.last_active,
                    "lastViewed": e.last_viewed,
                })
            })
            .collect();
        // Most useful first: active, then most-recently active/viewed.
        entries.sort_by(|a, b| {
            let av = |v: &serde_json::Value| v.get("active").and_then(|x| x.as_bool()).unwrap_or(false);
            let recency = |v: &serde_json::Value| {
                v.get("lastActive").and_then(|x| x.as_u64()).unwrap_or(0)
                    .max(v.get("lastViewed").and_then(|x| x.as_u64()).unwrap_or(0))
            };
            av(b).cmp(&av(a)).then(recency(b).cmp(&recency(a)))
        });
        (entries, last_viewed)
    };
    serde_json::json!({ "repos": entries, "lastViewed": last_viewed })
}

/// Forget a repo (and delete its cached graph + overlay).
#[tauri::command]
fn graph_remove(path: String, state: tauri::State<'_, AppState>) -> serde_json::Value {
    let repo = std::path::PathBuf::from(path.trim());
    let hash = graph_store::repo_hash(&repo);
    graph_store::delete_cache(&hash);
    lock_or_recover(&state.graph).remove(&repo);
    serde_json::json!({ "ok": true })
}

#[tauri::command]
fn graph_get(
    path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let repo = resolve_repo(path, &state).ok_or("No repository selected")?;
    let hash = graph_store::repo_hash(&repo);
    let graph = graph_store::load_graph(&hash)
        .ok_or("No graph has been built for this repository yet")?;
    let overlay = graph_store::load_overlay(&hash);
    let merged = graph_store::merge(&graph, &overlay);
    // Remember this as the last-viewed graph so it re-opens here next launch.
    {
        let mut gs = lock_or_recover(&state.graph);
        gs.upsert(&repo, "auto");
        gs.set_viewed(&repo);
    }
    Ok(serde_json::json!({
        "repo": repo.to_string_lossy(),
        "graph": serde_json::to_value(&merged).unwrap_or_default(),
        "overlay": serde_json::to_value(&overlay).unwrap_or_default(),
    }))
}

#[tauri::command]
fn graph_save_overlay(
    path: Option<String>,
    overlay: serde_json::Value,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let repo = {
        let state = app.state::<AppState>();
        resolve_repo(path, &state).ok_or("No repository selected")?
    };
    let hash = graph_store::repo_hash(&repo);
    let overlay: graph_store::GraphOverlay =
        serde_json::from_value(overlay).map_err(|e| format!("Bad overlay: {}", e))?;
    graph_store::save_overlay(&hash, &overlay);
    // Rewrite the digest so agents immediately see the human edits, and refresh
    // the UI — but don't credit savings (no new extraction happened).
    if let Some(graph) = graph_store::load_graph(&hash) {
        let merged = graph_store::merge(&graph, &overlay);
        let _ = graph_store::write_digest(&repo, &merged);
        let _ = app.emit(
            "graph-updated",
            serde_json::json!({ "repo": repo.to_string_lossy(), "builtAt": graph.built_at }),
        );
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn graph_write_digest(
    path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let repo = resolve_repo(path, &state).ok_or("No repository selected")?;
    let hash = graph_store::repo_hash(&repo);
    let graph = graph_store::load_graph(&hash).ok_or("No graph built yet")?;
    let overlay = graph_store::load_overlay(&hash);
    let merged = graph_store::merge(&graph, &overlay);
    let res = graph_store::write_digest(&repo, &merged).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "digestPath": res.digest_path.to_string_lossy(),
        "tokensSaved": res.tokens_saved(),
        "digestTokens": res.digest_tokens,
        "sourceTokens": res.source_tokens,
    }))
}

#[tauri::command]
fn graph_set_watch(
    enabled: bool,
    path: Option<String>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    use notify::Watcher;

    if !enabled {
        let state = app.state::<AppState>();
        *lock_or_recover(&state.graph_watcher) = None; // drop → stops watching
        lock_or_recover(&state.graph).watching = false;
        return Ok(serde_json::json!({ "watching": false }));
    }

    let repo = {
        let state = app.state::<AppState>();
        resolve_repo(path, &state).ok_or("No repository selected")?
    };
    if !repo.exists() {
        return Err(format!("Path does not exist: {}", repo.display()));
    }

    // Debounced rebuild pipeline: the watcher pings a channel; a task coalesces
    // bursts (800ms quiet) then rebuilds off the UI thread. Digest writes use
    // non-source extensions, so they never re-trigger this watcher.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| graph_extract::is_source_path(p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&repo, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    {
        let state = app.state::<AppState>();
        lock_or_recover(&state.graph).set_repo(&repo);
        *lock_or_recover(&state.graph_watcher) = Some(watcher);
        lock_or_recover(&state.graph).watching = true;
    }

    let task_app = app.clone();
    let task_repo = repo.clone();
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            // Coalesce a burst of edits before rebuilding.
            loop {
                tokio::select! {
                    v = rx.recv() => { if v.is_none() { return; } }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(800)) => break,
                }
            }
            let build_repo = task_repo.clone();
            if let Ok(graph) =
                tauri::async_runtime::spawn_blocking(move || graph_extract::build(&build_repo)).await
            {
                graph_store::save_graph(&graph);
                finalize_graph(&task_app, &task_repo, &graph, false);
            }
        }
    });

    Ok(serde_json::json!({ "watching": true, "repo": repo.to_string_lossy() }))
}

/// Point the main window at the knowledge-graph UI (mirrors `navigate_to_farm`).
#[tauri::command]
fn navigate_to_graph(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = win.current_monitor() {
            let sf = monitor.scale_factor();
            let sw = monitor.size().width as f64 / sf;
            let sh = monitor.size().height as f64 / sf;
            let w = 1220.0_f64.min(sw - 40.0);
            let h = 820.0_f64.min(sh - 80.0);
            let _ = win.set_size(tauri::LogicalSize::new(w, h));
            let _ = win.center();
        }
        navigate_main(&app, "graph.html");
    }
}

/// Background service: periodically detect every repo a coding agent is working
/// in and keep a cached graph + digest for each. Builds a repo when it has no
/// cache yet, or when the cache is stale (>6h) and the repo is still active, so
/// the work stays cheap. Digest writes use non-source extensions, so they never
/// trip the live watcher. Token savings are NOT credited here (only user builds
/// count) to avoid inflating Stats.
fn start_graph_autobuild(app: AppHandle) {
    const STALE_SECS: u64 = 6 * 3600;
    const INTERVAL_SECS: u64 = 180;
    // At most this many builds per pass, so a burst of stale repos is amortized
    // across several ticks instead of hammering the CPU at once.
    const MAX_BUILDS_PER_PASS: u32 = 2;
    tauri::async_runtime::spawn(async move {
        // Let the app fully settle before the first (heaviest) pass.
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        loop {
            let repos = graph_extract::detect_active_repos();
            if !repos.is_empty() {
                {
                    let state = app.state::<AppState>();
                    lock_or_recover(&state.graph).upsert_active(&repos);
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let mut built: u32 = 0;
                for r in &repos {
                    let repo = std::path::PathBuf::from(r);
                    if !repo.is_dir() {
                        continue;
                    }
                    let hash = graph_store::repo_hash(&repo);
                    let needs = match graph_store::load_graph(&hash) {
                        None => true,
                        Some(g) => now.saturating_sub(g.built_at) > STALE_SECS,
                    };
                    if needs {
                        // Silent build: don't steal the user's current-repo selection,
                        // don't credit savings. Space builds out so a machine with
                        // several active repos never sees one big CPU spike.
                        let _ = do_graph_build(&app, repo, "auto", false, false).await;
                        built += 1;
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        if built >= MAX_BUILDS_PER_PASS {
                            break;
                        }
                    }
                }
                let _ = app.emit("graph-registry-updated", ());
            }
            tokio::time::sleep(std::time::Duration::from_secs(INTERVAL_SECS)).await;
        }
    });
}

// ── Live token wallpaper (desktop-pinned) ─────────────────────────────────
//
// Windows port of the macOS live wallpaper. Same config file, same commands and
// same events, so the shared `wallpaper.html` / `wallpaper-control.html` drive
// both platforms unchanged. Only two things are genuinely platform-specific:
// where the user's real desktop picture lives, and how a window gets pinned
// behind the desktop icons.

fn wallpaper_config_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("wallpaper.json")
}

fn wallpaper_default_config() -> serde_json::Value {
    serde_json::json!({
        // OFF by default.
        //
        // It was on, reasoning that the particle wallpaper is what people
        // install Terse to see. But that made it the one heavy thing running
        // before the user had clicked anything: a four-slot, 60000-particle-per-
        // line WebGL field, started for everyone at launch. Without hardware
        // acceleration that is the largest single cost the app has - the CI
        // runner showed one renderer at 485% with the app otherwise idle.
        //
        // Everything else now waits for a click too: pet, farm, palette, Doctor
        // and the nine dashboards are built on first use and destroyed on close.
        // This was the last thing starting on its own.
        //
        // Defaults apply only when wallpaper.json is absent, so anyone who has
        // already turned it ON keeps it on. Switching it on persists.
        "enabled": false,
        // 默认引擎 = mineradio(真桌面壁纸 + 粒子律动);"topography" 切回音域回响光柱地形
        "engine": "mineradio",
        // Pro 的粒子风格(src/renderer/wallpaper-styles.js)。"cinematic" 是原来那一种,
        // 也是老配置文件里缺这个字段时前端自己会退回的那一种 —— 升级不会改变任何人看到的画面。
        "style": "cinematic",
        "theme": "neon", "quality": 56, "angle": 55, "intensity": 1.0
    })
}

/// 极简 base64(只为把一张 JPEG 塞进 data URL,不值得为它加一个依赖)
fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Path to the user's **current** desktop picture on Windows.
///
/// Two sources, best first:
/// 1. `%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper` — what Windows
///    actually renders (already cropped/scaled to the desktop, and correct even
///    when the wallpaper came from a theme, a slideshow or Spotlight). It has no
///    file extension; the decoder sniffs the content, so that's fine.
/// 2. `HKCU\Control Panel\Desktop\WallPaper` — the original source file. Used
///    when the transcoded copy is missing (fresh profile, some OEM images).
/// 3. Windows' own stock wallpaper under `%WINDIR%\Web`, which is always
///    present. This mirrors the macOS side's fall back to `Sonoma.heic`:
///    mineradio colours its particles by sampling this image, so returning
///    None left the Windows wallpaper visibly different from the Mac build — a
///    dark, colourless field — whenever 1 and 2 both miss (a solid-colour
///    desktop, a policy-managed profile, or a wallpaper on a drive that isn't
///    mounted). Now the engine always has a base image, same as on the Mac.
fn desktop_picture_source() -> Option<std::path::PathBuf> {
    if let Some(appdata) = dirs::config_dir() {
        let transcoded = appdata
            .join("Microsoft")
            .join("Windows")
            .join("Themes")
            .join("TranscodedWallpaper");
        if transcoded.exists() {
            return Some(transcoded);
        }
    }
    // `reg` failing must fall through to the stock image, not abort the lookup.
    if let Ok(out) = hidden_command("reg")
        .args(["query", r"HKCU\Control Panel\Desktop", "/v", "WallPaper"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(idx) = line.find("REG_SZ") {
                let val = line[idx + "REG_SZ".len()..].trim();
                if !val.is_empty() {
                    let p = std::path::PathBuf::from(val);
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
        }
    }
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
    for cand in [
        r"Web\Wallpaper\Windows\img0.jpg",
        r"Web\Wallpaper\Theme1\img1.jpg",
        r"Web\Screen\img100.jpg",
    ] {
        let p = std::path::Path::new(&windir).join(cand);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 用户**当前那张真桌面壁纸**,缩到 1920 宽的 JPEG data URL。
///
/// mineradio 引擎的粒子是按底图取色的 —— 拿到这张图,粒子就长成用户自己壁纸的样子。
/// macOS 用 `sips` 缩图;Windows 没有 sips,改用系统自带的 PowerShell + System.Drawing
/// (Windows PowerShell 5.1 一定有),同样不引入图像处理依赖。
/// 结果缓存在 ~/.terse/wallpaper-bg.jpg,壁纸窗口每次启动直接读缓存。
#[tauri::command]
fn get_desktop_picture(force: Option<bool>) -> Option<String> {
    let cache = dirs::home_dir()?.join(".terse").join("wallpaper-bg.jpg");
    let fresh = std::fs::metadata(&cache)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|e| e.as_secs() < 3600).unwrap_or(false))
        .unwrap_or(false);
    if force.unwrap_or(false) || !fresh {
        let src = desktop_picture_source()?;
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Downscale to 1920 wide (keeping aspect) and re-encode as JPEG q82 —
        // the same output `sips -Z 1920` produces on the Mac side.
        let script = format!(
            r#"$ErrorActionPreference='Stop';
Add-Type -AssemblyName System.Drawing;
$img=[System.Drawing.Image]::FromFile('{src}');
$w=$img.Width; $h=$img.Height;
if ($w -gt 1920) {{ $h=[int]([math]::Round($h*1920.0/$w)); $w=1920 }}
$bmp=New-Object System.Drawing.Bitmap $w,$h;
$g=[System.Drawing.Graphics]::FromImage($bmp);
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
$g.DrawImage($img,0,0,$w,$h);
$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {{ $_.MimeType -eq 'image/jpeg' }};
$p=New-Object System.Drawing.Imaging.EncoderParameters 1;
$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),82;
$bmp.Save('{dst}',$codec,$p);
$g.Dispose(); $bmp.Dispose(); $img.Dispose();"#,
            src = src.to_string_lossy().replace('\'', "''"),
            dst = cache.to_string_lossy().replace('\'', "''"),
        );
        let ok = hidden_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        // Last resort: hand the original bytes over un-resized rather than showing
        // nothing (the engine only samples colours from it).
        if !ok && !cache.exists() {
            let bytes = std::fs::read(&src).ok()?;
            return Some(format!("data:image/jpeg;base64,{}", b64(&bytes)));
        }
    }
    let bytes = std::fs::read(&cache).ok()?;
    Some(format!("data:image/jpeg;base64,{}", b64(&bytes)))
}

#[tauri::command]
fn get_wallpaper_config() -> serde_json::Value {
    std::fs::read_to_string(wallpaper_config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(wallpaper_default_config)
}

/// Persist wallpaper config and push it live to the running wallpaper window.
#[tauri::command]
fn set_wallpaper_config(config: serde_json::Value, app: AppHandle) -> bool {
    let p = wallpaper_config_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let ok = std::fs::write(&p, serde_json::to_string_pretty(&config).unwrap_or_default()).is_ok();
    // Live update: the wallpaper window re-reads theme/quality/angle on this event.
    let _ = app.emit("wallpaper-config", &config);
    ok
}

/// Pin an existing window behind the desktop icons — the Windows counterpart of
/// the macOS `kCGDesktopWindowLevel` trick.
///
/// Explorer paints the desktop in a `WorkerW` window that sits *behind* the
/// icon host (`SHELLDLL_DefView`). That WorkerW only exists once Progman has
/// been poked with the undocumented `0x052C` message, so we send it first, then
/// walk Progman's siblings for the WorkerW that has **no** SHELLDLL_DefView
/// child — that is the wallpaper layer — and re-parent into it. Falls back to
/// parenting under Progman itself on shells where the split never happens.
///
/// The window is restyled to `WS_CHILD` (dropping `WS_POPUP` and the frame bits)
/// before re-parenting — SetParent does not do this for you, and a popup handed
/// to SetParent is composited nowhere. It is also made click-through
/// (`WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`), matching the Mac behaviour;
/// `WS_EX_TOOLWINDOW` is NOT set, since it conflicts with the child parenting
/// and a child window is already out of Alt-Tab.
/// Append a line to `~/.terse/wallpaper-pin.log`.
///
/// The wallpaper pin is the one code path in this app that CI provably cannot
/// exercise: the runner reports `Progman = 0` and zero top-level WorkerW, so
/// every branch below the parent lookup has never executed there. Screenshots
/// from a bare desktop cannot tell "wrong host", "right host, not compositing"
/// and "never ran" apart either. This is how a real machine reports which one it
/// was — ask the user for the file rather than guessing from a picture.
#[cfg(target_os = "windows")]
fn pin_log(line: &str) {
    diag_log("wallpaper-pin", line)
}

/// Append to `~/.terse/<name>.log`, and echo to stderr.
///
/// This is how the wallpaper bug got solved after five builds of guessing from
/// screenshots: the log said `defview_on_progman=true ... chosen=0x2009a` and
/// settled in one line what no picture could. The ghost titlebar is the same
/// shape of problem — intermittent, invisible to a style dump — so it gets the
/// same treatment rather than another round of theories.
#[cfg(target_os = "windows")]
pub(crate) fn diag_log(name: &str, line: &str) {
    use std::io::Write;
    // Timestamped. Without one, these lines cannot be ordered against anything
    // else — a CI run left "codex session search ... age 2s" next to "LATE-ATTACH
    // DID NOT FIRE" and the only way to tell which happened first was to infer it
    // from the workflow's own clock. An untimed diagnostic log answers "what"
    // but not "when", and "when" was the whole question.
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    eprintln!("[terse][{name}] {line}");
    if let Some(dir) = dirs::home_dir() {
        let p = dir.join(".terse").join(format!("{name}.log"));
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "[{ts}] {line}");
        }
    }
}

#[cfg(target_os = "windows")]
fn pin_wallpaper_window(win: &tauri::WebviewWindow) {
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetSystemMetrics, GetWindowLongPtrW, SendMessageTimeoutW, SetParent,
        SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, SMTO_NORMAL, SM_CXVIRTUALSCREEN,
        HWND_BOTTOM, SM_CYVIRTUALSCREEN, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
    };

    let raw = match win.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    // tauri's `windows` crate version differs from ours — rebuild from the raw
    // pointer so the HWND types line up (same fix as `make_rounded`).
    let hwnd = HWND(raw.0);

    unsafe {
        let progman = FindWindowExW(None, None, w!("Progman"), None).unwrap_or_default();
        if !progman.is_invalid() {
            // Ask Progman to spawn the wallpaper WorkerW. Timeout so a wedged
            // Explorer can't hang our main thread.
            //
            // TWO messages, with wParam 0xD — not one with wParam 0. The bare
            // (0x052C, 0, 0) form is the old Windows 8 recipe and it is what we
            // were sending; on current Windows 11 it does not reliably spawn the
            // second WorkerW, so the sibling search below found nothing and the
            // window got parented to Progman, where it never draws. The 0xD/0
            // then 0xD/1 pair is the form every working implementation uses.
            for lp in [0isize, 1] {
                let _ = SendMessageTimeoutW(
                    progman,
                    0x052C,
                    WPARAM(0xD),
                    LPARAM(lp),
                    SMTO_NORMAL,
                    1000,
                    None,
                );
            }
        }

        // Finding the wallpaper host, in the order the shell actually arranges
        // it. The previous version took the last top-level WorkerW *without* a
        // SHELLDLL_DefView child, which is not the same thing: there are
        // normally two or three WorkerWs and that picked an arbitrary one, so
        // the window was re-parented somewhere that never draws. CI confirmed
        // it — wallpaper.json said enabled, wallpaper-bg.jpg was generated, and
        // the desktop still showed the stock picture.
        //
        // 1) If SHELLDLL_DefView is a direct child of Progman (the usual case
        //    on Windows 11), Progman itself is the correct parent: our window
        //    then draws over the wallpaper and under the icons.
        // 2) Otherwise DefView lives inside a WorkerW, and the wallpaper host
        //    is that WorkerW's NEXT sibling of the same class.
        // Walk every top-level WorkerW ONCE, recording both candidates:
        //   · the sibling immediately after whichever host owns SHELLDLL_DefView
        //   · the first WorkerW that has no DefView child at all
        //
        // The previous version short-circuited: if DefView was a direct child of
        // Progman it never looked at the WorkerWs and parented to Progman. That
        // is the common Windows 11 layout, and parenting there puts us in the
        // same child list as the icons, sunk to HWND_BOTTOM — i.e. underneath
        // the picture Progman paints. Correct parent, invisible result.
        let defview_owner_is_progman = FindWindowExW(progman, None, w!("SHELLDLL_DefView"), None)
            .map(|h| !h.is_invalid())
            .unwrap_or(false);
        let mut after_defview = HWND::default();
        let mut first_bare = HWND::default();
        let mut worker_count = 0usize;
        let mut worker = FindWindowExW(None, None, w!("WorkerW"), None).unwrap_or_default();
        while !worker.is_invalid() {
            worker_count += 1;
            let has_defview = FindWindowExW(worker, None, w!("SHELLDLL_DefView"), None)
                .map(|h| !h.is_invalid())
                .unwrap_or(false);
            if has_defview && after_defview.is_invalid() {
                after_defview = FindWindowExW(None, worker, w!("WorkerW"), None).unwrap_or_default();
            } else if !has_defview && first_bare.is_invalid() {
                first_bare = worker;
            }
            worker = FindWindowExW(None, worker, w!("WorkerW"), None).unwrap_or_default();
        }
        // When DefView sits on Progman there is no "sibling after" to find, so
        // the bare WorkerW is the wallpaper layer. When DefView sits inside a
        // WorkerW, the sibling after it is. Prefer whichever the layout implies,
        // then the other, then Progman as a last resort.
        let target = if defview_owner_is_progman {
            if !first_bare.is_invalid() { first_bare } else { after_defview }
        } else if !after_defview.is_invalid() {
            after_defview
        } else {
            first_bare
        };
        let parent = if target.is_invalid() { progman } else { target };
        // Record what the shell actually looked like. CI cannot test any of this
        // — the runner has no Progman and no WorkerW at all (the diagnostic came
        // back "Progman = 0, total top-level WorkerW: 0"), so this path has never
        // once executed there. The only machine that can answer is a real
        // desktop, and this is how it reports back.
        pin_log(&format!(
            "progman={:?} defview_on_progman={} workerw_count={} after_defview={:?} \
             first_bare={:?} chosen={:?}{}",
            progman.0, defview_owner_is_progman, worker_count, after_defview.0,
            first_bare.0, parent.0,
            if parent.is_invalid() { "  << NO PARENT - pin aborted" } else { "" }
        ));
        if !parent.is_invalid() {
            // WS_CHILD, and NOT WS_POPUP. This is the piece that was missing, and
            // it is why the wallpaper never appeared on a real desktop however
            // correctly it was parented: SetParent does not add WS_CHILD for you,
            // and a WS_POPUP window handed to SetParent stays a popup owned by
            // the host instead of becoming part of the desktop surface — so it
            // is composited nowhere. Every working implementation of this trick
            // sets WS_CHILD explicitly and drops the frame styles.
            //
            // WS_THICKFRAME goes too. Elsewhere in this file it is deliberately
            // KEPT (it carries resizing), but the wallpaper is not resizable and
            // a sizing border on a desktop child is just a frame that can paint.
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let drop_bits = (WS_POPUP.0 | WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0
                | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as isize;
            SetWindowLongPtrW(
                hwnd,
                GWL_STYLE,
                (style & !drop_bits) | (WS_CHILD.0 | WS_VISIBLE.0) as isize,
            );
            // WS_EX_APPWINDOW forces a taskbar button, WS_EX_WINDOWEDGE draws a
            // raised edge, and WS_EX_TOOLWINDOW — which this function used to ADD
            // — makes the window a floating tool palette, the opposite of a
            // desktop child. All three come off; the reference implementations
            // strip exactly these.
            let ex0 = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let ex_drop =
                (WS_EX_APPWINDOW.0 | WS_EX_WINDOWEDGE.0 | WS_EX_TOOLWINDOW.0) as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex0 & !ex_drop);

            let _ = SetParent(hwnd, parent);
            // MUST reposition after re-parenting. SetParent re-interprets the
            // window's coordinates as client-relative to its new parent, so the
            // 0,0 + monitor-size we set before showing no longer means what it
            // did — without this the wallpaper lands off-screen or at the wrong
            // size, which looks identical to "the wallpaper never appeared".
            // Sized to the whole virtual screen so it spans multi-monitor
            // setups the way the macOS desktop level does — but positioned at
            // 0,0, NOT at SM_X/YVIRTUALSCREEN. Those are desktop coordinates,
            // and a child's origin is its parent's client area: the host spans
            // the virtual desktop, so its 0,0 already IS the top-left. With a
            // monitor left of the primary, SM_XVIRTUALSCREEN is negative and
            // would have shoved the wallpaper off the side.
            let cx = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let cy = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if cx > 0 && cy > 0 {
                // HWND_BOTTOM, not NOZORDER. The icons live in SHELLDLL_DefView,
                // a sibling under the same parent, so inserting at the top of
                // the z-order painted the wallpaper OVER them — CI showed the
                // particle field drawing correctly with every desktop icon
                // gone. macOS's kCGDesktopWindowLevel sits below the icons;
                // sinking to the bottom of the parent's children is the
                // equivalent, and puts us above the static wallpaper but under
                // the icons.
                let _ = SetWindowPos(
                    hwnd, HWND_BOTTOM, 0, 0, cx, cy,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }

        // Click-through, so the desktop stays fully usable.
        //
        // WS_EX_TOOLWINDOW is deliberately NOT added back. It used to be, to keep
        // the window out of Alt-Tab — but it also marks the window a floating
        // tool palette, which fights the WS_CHILD desktop parenting set above and
        // was stripped there for that reason. Re-adding it here would have undone
        // that two lines later. A WS_CHILD window is already absent from Alt-Tab,
        // so it bought nothing.
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let add = (WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | add);

        // What the window ended up as, so the log answers "did it take?" rather
        // than only "what did we ask for?".
        let final_style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let final_ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mut r = windows::Win32::Foundation::RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut r);
        pin_log(&format!(
            "  result: style=0x{:08X} ex=0x{:08X} WS_CHILD={} WS_POPUP={} rect={},{} {}x{}",
            final_style,
            final_ex,
            final_style & WS_CHILD.0 as isize != 0,
            final_style & WS_POPUP.0 as isize != 0,
            r.left, r.top, r.right - r.left, r.bottom - r.top
        ));
    }
    let _ = win.set_ignore_cursor_events(true);
}

#[cfg(not(target_os = "windows"))]
fn pin_wallpaper_window(_win: &tauri::WebviewWindow) {}

/// Size the (already-created) wallpaper window to the primary display, pin it
/// behind the desktop, and show it. The window itself is built once in `setup`
/// on the main thread; commands only show/hide it (thread-safe).
fn show_wallpaper_window(app: &AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("wallpaper")
        .ok_or_else(|| "wallpaper window not initialized".to_string())?;
    if let Ok(Some(m)) = app.primary_monitor() {
        let sf = m.scale_factor();
        let w = m.size().width as f64 / sf;
        let h = m.size().height as f64 / sf;
        let _ = win.set_position(tauri::LogicalPosition::new(0.0, 0.0));
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    }
    let _ = win.show();
    // Re-parenting touches the shell's window tree — must run on the main thread,
    // so this is safe whether called from `setup` or from a command handler thread.
    let win2 = win.clone();
    let _ = app.run_on_main_thread(move || pin_wallpaper_window(&win2));

    // Then again, twice, a beat later. On Windows 11 24H2 the wallpaper WorkerW
    // frequently does not exist yet when an app launches with the session — it
    // is spawned by Explorer some time after login. Pinning once at startup then
    // finds nothing, falls back to Progman, and the wallpaper silently never
    // draws; the user sees the toggle ON and a bare desktop, which is exactly
    // the report. Re-pinning is idempotent, so the cost of being early is one
    // wasted SetParent.
    let app2 = app.clone();
    let win3 = win.clone();
    std::thread::spawn(move || {
        for delay_ms in [1500u64, 5000] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let w = win3.clone();
            let _ = app2.run_on_main_thread(move || pin_wallpaper_window(&w));
        }
    });
    Ok(())
}

#[tauri::command]
fn set_wallpaper_enabled(on: bool, app: AppHandle) -> Result<(), String> {
    let mut cfg = get_wallpaper_config();
    cfg["enabled"] = serde_json::json!(on);
    let _ = set_wallpaper_config(cfg, app.clone());
    if on {
        show_wallpaper_window(&app)?;
    } else if let Some(w) = app.get_webview_window("wallpaper") {
        let _ = w.hide();
    }
    Ok(())
}

/// Cheap token counter (today, in+out) that the wallpaper polls to drive pulses.
#[tauri::command]
fn get_token_pulse(state: tauri::State<'_, AppState>) -> u64 {
    state.stats_store.lock().unwrap_or_else(|e| e.into_inner()).today_total_tokens()
}

/// Navigate the MAIN window to a bundled page.
///
/// The origin differs by platform: macOS/Linux serve the app from
/// `tauri://localhost`, Windows from `http://tauri.localhost`. Every navigation
/// here hardcoded the macOS form, and `"tauri://localhost/x.html".parse()`
/// SUCCEEDS as a URL — it is syntactically valid — so the eval fallback beneath
/// it never fired. WebView2 was handed a scheme it does not serve and simply
/// did nothing: clicking Wallpaper, Stats, Alerts, History, Team or Graph left
/// the user on whatever page they were already on. That is the
/// "点进去啥都没有" report.
///
/// Resolving against the window's CURRENT url gets the right origin on both.
fn navigate_main(app: &AppHandle, page: &str) {
    let Some(win) = app.get_webview_window("main") else { return };
    // navigate() must run on the main thread — every caller is a
    // #[tauri::command] on a worker thread, and off-thread WebView2 navigation
    // does nothing at all. Same class as the blank about:blank windows.
    let w = win.clone();
    let page_owned = page.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Ok(cur) = w.url() {
            if let Ok(url) = cur.join(&page_owned) {
                // The result was discarded and the function returned regardless,
                // so the fallback below was unreachable whenever join() worked -
                // which is always. A failed navigate therefore looked exactly
                // like a click that did nothing, which is how "clicking
                // Wallpaper does nothing" was reported.
                match w.navigate(url) {
                    Ok(()) => return,
                    Err(e) => eprintln!("[terse] navigate to {page_owned} failed: {e}"),
                }
            }
        }
        // Last resort: let the page itself do a relative navigation.
        let _ = w.eval(&format!("window.location.replace('/{}');", page_owned));
    });
}

/// Navigate the MAIN window to the wallpaper control page in-place.
#[tauri::command]
fn navigate_to_wallpaper(app: AppHandle) {
    navigate_main(&app, "wallpaper-control.html");
}

// ── Referral program + upgrade prompt (parity with macOS) ───────────────────

/// Bring the main window forward and open the Pro upgrade sheet. Called from the
/// floating popup when a free user tries to apply an optimization — monitoring is
/// free, but applying the trim is Pro.
#[tauri::command]
fn request_upgrade(app: AppHandle, reason: Option<String>) {
    let reason = reason.unwrap_or_default();
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        if let Ok(raw) = w.hwnd() {
            strip_native_frame(windows::Win32::Foundation::HWND(raw.0));
        }
        let _ = w.show();
        let _ = w.set_focus();
        // If the main window is currently on a Pro-gated sub-page (Doctor, Stats,
        // …) rather than the app shell, navigate back to the shell with an
        // `#upgrade` flag — app.js opens the paywall from that hash on load. When
        // already on the shell, the running app.js catches the event below.
        let on_shell = w
            .url()
            .ok()
            .map(|u| {
                let p = u.path();
                p == "/" || p.ends_with("index.html")
            })
            .unwrap_or(true);
        if !on_shell {
            navigate_main(&app, "index.html#upgrade");
            return;
        }
    }
    let _ = app.emit("open-paywall", serde_json::json!({ "reason": reason }));
}

/// A stable, shareable 6-char invite code derived from the user id — shown while
/// the backend referral service is still being wired up.
fn referral_code_for(clerk: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(clerk.as_bytes());
    let d = h.finalize();
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..6).map(|i| ALPHABET[(d[i] as usize) % ALPHABET.len()] as char).collect()
}

/// Referral dashboard for the Invite screen. Prefers the backend (authoritative
/// counts + rewards); falls back to a display-only code so the UI always works.
#[tauri::command]
async fn get_referral_info(app: AppHandle) -> serde_json::Value {
    let clerk = {
        let st = app.state::<AppState>();
        let auth = lock_or_recover(&st.auth);
        auth.clerk_user_id.clone()
    };
    let clerk = match clerk {
        Some(c) if !c.is_empty() => c,
        _ => return serde_json::json!({ "signedIn": false }),
    };
    if let Some(mut info) = license::fetch_referral(&clerk).await {
        info["signedIn"] = serde_json::json!(true);
        return info;
    }
    let code = referral_code_for(&clerk);
    serde_json::json!({
        "signedIn": true,
        "code": code,
        "shareUrl": format!("https://www.terseai.org/?ref={}", code),
        "invited": 0,
        "converted": 0,
        "proDaysEarned": 0,
        "pending": true, // backend attribution not live yet
        "rewardText": "Give 14 days of Pro, get 14 days of Pro",
    })
}

/// Redeem a friend's invite code. On a backend-confirmed grant, re-verify the
/// license so Pro entitlements refresh immediately.
#[tauri::command]
async fn redeem_referral_code(code: String, app: AppHandle) -> Result<serde_json::Value, String> {
    let clerk = {
        let st = app.state::<AppState>();
        let auth = lock_or_recover(&st.auth);
        auth.clerk_user_id.clone()
    };
    let clerk = clerk.ok_or("Please sign in first.")?;
    let code = code.trim().to_uppercase();
    if code.is_empty() {
        return Err("Enter an invite code.".to_string());
    }
    let res = license::redeem_referral(&clerk, &code).await?;
    if res.get("granted").and_then(|v| v.as_bool()).unwrap_or(false) {
        if let Some(lic) = license::verify_license(&clerk).await {
            let st = app.state::<AppState>();
            *lock_or_recover(&st.license) = lic;
        }
        let _ = app.emit("license-updated", ());
    }
    Ok(res)
}

/// Bring an app to the front by name. Used when the user clicks an option on an
/// approval card: we focus the agent's own window so they answer there. We do NOT
/// synthesise the keystroke — injecting keys into a terminal off a heuristic text
/// match could approve the wrong thing.
#[tauri::command]
fn focus_app(app: String) {
    // Reject anything that isn't a plain app name before it reaches the shell.
    if app.is_empty()
        || app.len() > 40
        || !app.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.')
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        capture::activate_app(&app).await;
    });
}
