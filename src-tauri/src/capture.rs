use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Dev path (compile-time, used when running via `cargo run`)
const AX_BIN_DEV: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/helpers/terse-ax");

/// Resolve terse-ax binary path: check bundled resource first, then dev path
fn ax_bin() -> String {
    // In a bundled .app, the binary is at Contents/MacOS/terse
    // and resources are at Contents/Resources/helpers/terse-ax
    if let Ok(exe) = std::env::current_exe() {
        let resources = exe.parent()
            .and_then(|p| p.parent()) // Contents/
            .map(|p| p.join("Resources/helpers/terse-ax"));
        if let Some(bundled) = resources {
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
    }
    AX_BIN_DEV.to_string()
}

/// Lazy-initialized path to terse-ax
static AX_BIN_PATH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let path = ax_bin();
    eprintln!("[terse] terse-ax path: {}", path);
    path
});

/// Get the terse-ax binary path
fn ax_bin_path() -> &'static str {
    &AX_BIN_PATH
}
const BRIDGE_PORT: u16 = 47821;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub pid: u32,
    pub bundle_id: String,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct CaptureResult {
    pub text: String,
    pub method: String,
    pub ok: bool,
    pub focused: bool,
}

impl Default for CaptureResult {
    fn default() -> Self {
        CaptureResult {
            text: String::new(),
            method: "none".to_string(),
            ok: false,
            focused: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WriteResult {
    pub ok: bool,
    pub method: String,
}

/// Get frontmost app info via osascript + JXA
pub async fn get_front_app() -> AppInfo {
    let script = r#"
ObjC.import("Cocoa");
function run() {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var name = app.localizedName.js;
  var bid = app.bundleIdentifier.js;
  var pid = app.processIdentifier;
  var title = "";
  try {
    var se = Application("System Events");
    var procs = se.processes.whose({unixId: pid});
    if (procs.length > 0) { try { title = procs[0].windows[0].name(); } catch(e) {} }
  } catch(e) {}
  return JSON.stringify({name: name, bundleId: bid, pid: pid, title: title});
}"#;

    match Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                AppInfo {
                    name: v["name"].as_str().unwrap_or("?").to_string(),
                    pid: v["pid"].as_u64().unwrap_or(0) as u32,
                    bundle_id: v["bundleId"].as_str().unwrap_or("").to_string(),
                    title: v["title"].as_str().unwrap_or("").to_string(),
                }
            } else {
                AppInfo { name: "?".into(), pid: 0, bundle_id: String::new(), title: String::new() }
            }
        }
        Err(_) => AppInfo { name: "?".into(), pid: 0, bundle_id: String::new(), title: String::new() },
    }
}

/// Activate app by name
pub async fn activate_app(app_name: &str) {
    let script = format!("tell application \"{}\" to activate", app_name);
    let _ = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

/// Send keystrokes via System Events
pub async fn send_keys(cmd: &str) {
    let script = format!("tell application \"System Events\" to {}", cmd);
    let _ = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
}

/// Read text via AX API from an app's focused element
pub async fn read_ax_app(pid: u32, hint_x: Option<f64>, hint_y: Option<f64>) -> CaptureResult {
    let mut args = vec!["read-app".to_string(), pid.to_string()];
    if let (Some(x), Some(y)) = (hint_x, hint_y) {
        args.push(format!("{}", x as i32));
        args.push(format!("{}", y as i32));
    }

    match Command::new(ax_bin_path())
        .args(&args)
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                let ok = v["ok"].as_bool().unwrap_or(false);
                let value = v["value"].as_str().unwrap_or("").to_string();
                let strategy = v["strategy"].as_str().unwrap_or("app");
                if ok && value.trim().len() > 0 {
                    CaptureResult {
                        text: value,
                        method: format!("ax-{}", strategy),
                        ok: true,
                        focused: false,
                    }
                } else {
                    CaptureResult::default()
                }
            } else {
                CaptureResult::default()
            }
        }
        Err(_) => CaptureResult::default(),
    }
}

/// Read via Cmd+C selection
pub async fn read_selection(app_name: &str) -> CaptureResult {
    activate_app(app_name).await;
    send_keys("keystroke \"c\" using command down").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Read clipboard via pbpaste
    match Command::new("pbpaste").output().await {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if text.is_empty() {
                CaptureResult::default()
            } else {
                CaptureResult {
                    text,
                    method: "selection".to_string(),
                    ok: true,
                    focused: false,
                }
            }
        }
        Err(_) => CaptureResult::default(),
    }
}

/// Write text to target app via AX or clipboard paste
pub async fn write_to_app(app_name: &str, text: &str, pid: u32) -> WriteResult {
    // Try AX direct write first
    if pid > 0 {
        activate_app(app_name).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = write_ax(pid, text).await;
        if result.ok {
            return result;
        }
    }

    // Fallback: activate, Cmd+A, paste
    activate_app(app_name).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Set clipboard
    let mut child = match Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return WriteResult { ok: false, method: "clipboard-error".to_string() },
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes()).await;
    }
    let _ = child.wait().await;

    send_keys("keystroke \"a\" using command down").await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    send_keys("keystroke \"v\" using command down").await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    WriteResult { ok: true, method: "paste".to_string() }
}

/// Write text via AX (direct AXValue set)
pub async fn write_ax(pid: u32, text: &str) -> WriteResult {
    let mut child = match Command::new(ax_bin_path())
        .args(["write-pid", &pid.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return WriteResult { ok: false, method: "ax-error".to_string() },
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes()).await;
    }

    match child.wait_with_output().await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                WriteResult {
                    ok: v["ok"].as_bool().unwrap_or(false),
                    method: "ax-write".to_string(),
                }
            } else {
                WriteResult { ok: false, method: "ax-error".to_string() }
            }
        }
        Err(_) => WriteResult { ok: false, method: "ax-error".to_string() },
    }
}

/// Spellcheck via terse-ax
pub async fn spellcheck_text(text: &str) -> Result<String, String> {
    let mut child = Command::new(ax_bin_path())
        .arg("spellcheck")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes()).await;
    }

    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if v["ok"].as_bool().unwrap_or(false) {
            Ok(v["corrected"].as_str().unwrap_or(text).to_string())
        } else {
            Ok(text.to_string())
        }
    } else {
        Ok(text.to_string())
    }
}

/// Check if VS Code bridge is alive
pub async fn is_bridge_alive() -> bool {
    match reqwest_lite(&format!("http://127.0.0.1:{}/ping", BRIDGE_PORT)).await {
        Some(body) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                v["ok"].as_bool().unwrap_or(false) && v["bridge"].as_str() == Some("terse")
            } else {
                false
            }
        }
        None => false,
    }
}

/// Read from VS Code bridge
pub async fn read_bridge() -> CaptureResult {
    match reqwest_lite(&format!("http://127.0.0.1:{}/text", BRIDGE_PORT)).await {
        Some(body) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                let ok = v["ok"].as_bool().unwrap_or(false);
                let focused = v["focused"].as_bool().unwrap_or(false);
                let text = v["text"].as_str().unwrap_or("").to_string();
                if ok && focused && !text.is_empty() {
                    CaptureResult { text, method: "bridge".into(), ok: true, focused: true }
                } else {
                    CaptureResult { focused, ..Default::default() }
                }
            } else {
                CaptureResult::default()
            }
        }
        None => CaptureResult::default(),
    }
}

/// Write to VS Code bridge
pub async fn write_bridge(text: &str) -> bool {
    let body = serde_json::json!({"text": text}).to_string();
    match http_post(&format!("http://127.0.0.1:{}/replace", BRIDGE_PORT), &body).await {
        Some(resp) => {
            serde_json::from_str::<serde_json::Value>(&resp)
                .map(|v| v["ok"].as_bool().unwrap_or(false))
                .unwrap_or(false)
        }
        None => false,
    }
}

/// Install VS Code bridge extension
pub async fn install_bridge() -> serde_json::Value {
    let home = dirs::home_dir().unwrap_or_default();
    let src_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vscode-extension");

    let ext_dirs: Vec<std::path::PathBuf> = [
        home.join(".vscode/extensions"),
        home.join(".vscode-insiders/extensions"),
        home.join(".cursor/extensions"),
    ]
    .into_iter()
    .filter(|d| d.exists())
    .collect();

    if ext_dirs.is_empty() {
        return serde_json::json!({"ok": false, "error": "No VS Code extensions directory found"});
    }

    let ext_name = "terse.terse-bridge-0.1.0";
    let mut installed = 0;

    for ext_dir in &ext_dirs {
        let dest = ext_dir.join(ext_name);
        if dest.exists() {
            let _ = std::fs::remove_dir_all(&dest);
        }
        if let Err(_) = std::fs::create_dir_all(&dest) {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&src_dir) {
            for entry in entries.flatten() {
                let _ = std::fs::copy(entry.path(), dest.join(entry.file_name()));
            }
            installed += 1;
        }
    }

    if installed > 0 {
        serde_json::json!({"ok": true, "installed": installed})
    } else {
        serde_json::json!({"ok": false, "error": "Failed to install"})
    }
}

/// Enable AX tree on Electron apps (VS Code, Cursor)
pub async fn enable_ax_for_app(pid: u32) -> bool {
    match Command::new(ax_bin_path())
        .args(["enable-ax", &pid.to_string()])
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            serde_json::from_str::<serde_json::Value>(stdout.trim())
                .map(|v| v["ok"].as_bool().unwrap_or(false))
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Reload VS Code via bridge
pub async fn reload_bridge() -> bool {
    match http_post(&format!("http://127.0.0.1:{}/reload", BRIDGE_PORT), "").await {
        Some(resp) => serde_json::from_str::<serde_json::Value>(&resp)
            .map(|v| v["ok"].as_bool().unwrap_or(false))
            .unwrap_or(false),
        None => false,
    }
}

/// Send batch keystrokes in a single osascript call (faster)
pub async fn send_keys_batch(cmds: &[&str], delays: &[f64]) {
    let mut parts = Vec::new();
    for (i, cmd) in cmds.iter().enumerate() {
        parts.push(cmd.to_string());
        if i < delays.len() && delays[i] > 0.0 {
            parts.push(format!("delay {}", delays[i]));
        }
    }
    let script = format!("tell application \"System Events\"\n{}\nend tell", parts.join("\n"));
    let _ = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

/// Read ALL text via Cmd+A → Cmd+C → Right arrow (deselect)
pub async fn read_all_via_clipboard(_app_name: &str) -> CaptureResult {
    // Save clipboard
    let saved = Command::new("pbpaste").output().await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // Set sentinel
    set_clipboard("__TERSE_SENTINEL__").await;

    send_keys_batch(
        &[
            "keystroke \"a\" using command down",
            "keystroke \"c\" using command down",
            "key code 124", // right arrow to deselect
        ],
        &[0.08, 0.15, 0.0],
    ).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let captured = Command::new("pbpaste").output().await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // Restore clipboard
    let saved_clone = saved.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if saved_clone != "__TERSE_SENTINEL__" {
            set_clipboard(&saved_clone).await;
        }
    });

    if captured == "__TERSE_SENTINEL__" {
        return CaptureResult { method: "clipboard-empty".into(), ..Default::default() };
    }

    // Extract last user input from terminal output
    let user_input = parse_last_input(&captured);
    if user_input.len() >= 3 {
        CaptureResult { text: user_input, method: "clipboard-input".into(), ok: true, focused: false }
    } else {
        CaptureResult { method: "clipboard-no-input".into(), ..Default::default() }
    }
}

/// Write via clipboard paste — universal method for any app (Cmd+A → Cmd+V)
/// Write to a terminal input by clearing the current line first, then pasting.
/// Uses Ctrl+A (go to start of line) + Ctrl+K (kill to end of line) to clear,
/// then Cmd+V to paste the optimized text.
pub async fn write_via_clipboard_terminal(text: &str) -> WriteResult {
    let saved = Command::new("pbpaste").output().await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    set_clipboard(text).await;

    // Clear terminal input then paste optimized text.
    // For ink/readline CLIs: End → kill-backward → kill-forward → paste
    // Also try Home → kill-forward as fallback
    send_keys_batch(
        &[
            "keystroke \"e\" using control down",   // Ctrl+E: go to end
            "keystroke \"u\" using control down",   // Ctrl+U: kill to start of line
        ],
        &[0.02, 0.02],
    ).await;
    // Small delay to let the kill register
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    send_keys_batch(
        &[
            "keystroke \"a\" using control down",   // Ctrl+A: go to start
            "keystroke \"k\" using control down",   // Ctrl+K: kill to end
        ],
        &[0.02, 0.02],
    ).await;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    // Now paste the optimized text
    send_keys_batch(
        &[
            "keystroke \"v\" using command down",   // Cmd+V: paste
        ],
        &[0.0],
    ).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Restore clipboard
    let saved_clone = saved;
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        set_clipboard(&saved_clone).await;
    });

    WriteResult { ok: true, method: "clipboard-terminal".to_string() }
}

pub async fn write_via_clipboard(app_name: &str, text: &str, skip_activate: bool) -> WriteResult {
    let saved = Command::new("pbpaste").output().await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    set_clipboard(text).await;

    if !skip_activate {
        activate_app(app_name).await;
    }

    // Cmd+A to select all text in the focused field, then Cmd+V to replace
    send_keys_batch(
        &[
            "keystroke \"a\" using command down",
            "keystroke \"v\" using command down",
        ],
        &[0.08, 0.0],
    ).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Restore clipboard after a brief delay
    let saved_clone = saved;
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        set_clipboard(&saved_clone).await;
    });

    WriteResult { ok: true, method: "clipboard-paste".to_string() }
}

async fn set_clipboard(text: &str) {
    if let Ok(mut child) = Command::new("pbcopy").stdin(Stdio::piped()).spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
        let _ = child.wait().await;
    }
}

/// Parse last user input from terminal output (Claude Code uses "❯" prompt)
fn parse_last_input(full_text: &str) -> String {
    let lines: Vec<&str> = full_text.split('\n').collect();
    let mut last_prompt_idx: Option<usize> = None;

    for i in (0..lines.len()).rev() {
        let t = lines[i].trim_start();
        // Skip system lines
        if t.starts_with("❯❯") || t.starts_with("››") || t.starts_with("──")
            || t.starts_with(">>") || t.is_empty() { continue; }
        // Separator bars
        if t.len() >= 3 && t.chars().all(|c| "─━═▬_-".contains(c)) { continue; }
        // Single prompt
        if t.starts_with("❯ ") || t.starts_with("› ") || t == "❯" || t == "›" {
            last_prompt_idx = Some(i);
            break;
        }
    }

    let prompt_idx = match last_prompt_idx {
        Some(i) => i,
        None => return String::new(),
    };

    let mut input_lines = Vec::new();
    for i in prompt_idx..lines.len() {
        let t = lines[i].trim_start();

        if i > prompt_idx {
            if t.starts_with("❯❯") || t.starts_with("››") || t.starts_with(">>") { break; }
            if t.len() >= 3 && t.chars().all(|c| "─━═▬_-".contains(c)) { break; }
        }

        let line = if i == prompt_idx {
            // Strip prompt char
            lines[i].trim_start().trim_start_matches('❯').trim_start_matches('›')
                .trim_start_matches(' ').to_string()
        } else {
            lines[i].to_string()
        };
        input_lines.push(line);
    }

    // Trim trailing empty
    while input_lines.last().map_or(false, |l| l.trim().is_empty()) {
        input_lines.pop();
    }

    input_lines.join("\n").trim().to_string()
}

// ── Key Monitor (CGEventTap via terse-ax) ──

#[derive(Clone)]
pub struct KeyMonitorState {
    inner: Arc<Mutex<KeyMonitorInner>>,
}

struct KeyMonitorInner {
    monitors: HashMap<u32, KeyMonitorHandle>,
}

struct KeyMonitorHandle {
    buffer: String,
    last_update: std::time::Instant,
    ready: bool,
    stdin_tx: Option<tokio::sync::mpsc::Sender<String>>,
    enter_tx: Option<tokio::sync::mpsc::Sender<String>>, // channel for enter events → main thread
}

impl KeyMonitorState {
    pub fn new() -> Self {
        KeyMonitorState {
            inner: Arc::new(Mutex::new(KeyMonitorInner {
                monitors: HashMap::new(),
            })),
        }
    }

    pub fn start_monitor(&self, pid: u32, enter_tx: tokio::sync::mpsc::Sender<String>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.monitors.contains_key(&pid) { return; }

        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<String>(32);

        let handle = KeyMonitorHandle {
            buffer: String::new(),
            last_update: std::time::Instant::now(),
            ready: false,
            stdin_tx: Some(stdin_tx.clone()),
            enter_tx: Some(enter_tx),
        };
        inner.monitors.insert(pid, handle);

        let state = self.clone();
        tokio::spawn(async move {
            let mut child = match Command::new(ax_bin_path())
                .args(["key-monitor", &pid.to_string()])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => {
                    state.inner.lock().unwrap_or_else(|e| e.into_inner()).monitors.remove(&pid);
                    return;
                }
            };

            let stdout = child.stdout.take().unwrap();
            let mut child_stdin = child.stdin.take().unwrap();
            let mut reader = BufReader::new(stdout).lines();

            // Forward stdin messages to child
            let stdin_state = state.clone();
            tokio::spawn(async move {
                while let Some(msg) = stdin_rx.recv().await {
                    if tokio::io::AsyncWriteExt::write_all(&mut child_stdin, format!("{}\n", msg).as_bytes()).await.is_err() {
                        break;
                    }
                }
                let _ = stdin_state; // keep alive
            });

            // Read stdout lines
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() { continue; }
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(handle) = inner.monitors.get_mut(&pid) {
                        if msg["ok"].as_bool() == Some(true) && msg["monitoring"].as_bool() == Some(true) {
                            handle.ready = true;
                        } else if msg.get("enter").is_some() {
                            // Enter intercepted in send mode
                            let text = msg["text"].as_str().unwrap_or("").to_string();
                            if let Some(tx) = &handle.enter_tx {
                                let _ = tx.try_send(text);
                            }
                        } else if let Some(text) = msg["text"].as_str() {
                            handle.buffer = text.to_string();
                            handle.last_update = std::time::Instant::now();
                        }
                        // wrote / enterSent handled via await on caller side
                    }
                }
            }

            // Process ended
            state.inner.lock().unwrap_or_else(|e| e.into_inner()).monitors.remove(&pid);
        });
    }

    pub fn stop_monitor(&self, pid: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.monitors.remove(&pid); // dropping stdin_tx kills the process
    }

    pub fn get_buffer(&self, pid: u32) -> Option<(String, std::time::Instant)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.monitors.get(&pid)
            .filter(|h| h.ready)
            .map(|h| (h.buffer.clone(), h.last_update))
    }

    pub fn reset_buffer(&self, pid: u32, text: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = inner.monitors.get_mut(&pid) {
            handle.buffer = text.to_string();
            handle.last_update = std::time::Instant::now();
        }
    }

    pub fn is_running(&self, pid: u32) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.monitors.get(&pid).map_or(false, |h| h.ready)
    }

    pub fn set_send_mode(&self, pid: u32, on: bool) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = inner.monitors.get(&pid) {
            if let Some(tx) = &handle.stdin_tx {
                let msg = serde_json::json!({"cmd": "set-send-mode", "on": on}).to_string();
                let _ = tx.try_send(msg);
            }
        }
    }

    pub fn write_text(&self, pid: u32, text: &str) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = inner.monitors.get(&pid) {
            if let Some(tx) = &handle.stdin_tx {
                let msg = serde_json::json!({"cmd": "write", "text": text}).to_string();
                let _ = tx.try_send(msg);
            }
        }
    }

    pub fn send_enter(&self, pid: u32) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = inner.monitors.get(&pid) {
            if let Some(tx) = &handle.stdin_tx {
                let msg = serde_json::json!({"cmd": "enter"}).to_string();
                let _ = tx.try_send(msg);
            }
        }
    }
}

// ── Simple HTTP helpers (no reqwest dependency) ──

async fn reqwest_lite(url: &str) -> Option<String> {
    // Use curl for simplicity (available on all macOS)
    let output = Command::new("curl")
        .args(["-s", "--connect-timeout", "1", "--max-time", "2", url])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}

async fn http_post(url: &str, body: &str) -> Option<String> {
    let output = Command::new("curl")
        .args([
            "-s", "--connect-timeout", "1", "--max-time", "2",
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "-d", body,
            url,
        ])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}
