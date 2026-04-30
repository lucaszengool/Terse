use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Dev path (compile-time, used when running via `cargo run`)
const UIA_BIN_DEV: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../helpers/terse-uia.exe");

/// Resolve terse-uia.exe binary path: check bundled resource first, then dev path
fn uia_bin() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // In installed app, resources are alongside the exe
            let r1 = exe_dir.join("terse-uia.exe");
            if r1.exists() { return r1.to_string_lossy().to_string(); }
            // Try Resources subfolder (NSIS/WiX installer layout)
            let r2 = exe_dir.join("resources/terse-uia.exe");
            if r2.exists() { return r2.to_string_lossy().to_string(); }
        }
    }
    UIA_BIN_DEV.to_string()
}

/// Lazy-initialized path to terse-uia
static UIA_BIN_PATH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let path = uia_bin();
    eprintln!("[terse] terse-uia path: {}", path);
    path
});

/// Get the terse-uia binary path
fn uia_bin_path() -> &'static str {
    &UIA_BIN_PATH
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

/// Get foreground window info via PowerShell + Win32 API
pub async fn get_front_app() -> AppInfo {
    // Use PowerShell to get the foreground window's process info
    let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int count);
    public static string GetInfo() {
        var hwnd = GetForegroundWindow();
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        var sb = new StringBuilder(256); GetWindowText(hwnd, sb, 256);
        var title = sb.ToString();
        string name = ""; string path = "";
        try { var p = Process.GetProcessById((int)pid); name = p.ProcessName; path = p.MainModule.FileName; } catch {}
        return pid + "|" + name + "|" + title + "|" + path;
    }
}
"@
[FgWin]::GetInfo()
"#;

    match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let parts: Vec<&str> = stdout.trim().splitn(4, '|').collect();
            if parts.len() >= 3 {
                let pid = parts[0].parse::<u32>().unwrap_or(0);
                let name = parts[1].to_string();
                let title = parts[2].to_string();
                let exe_path = if parts.len() >= 4 { parts[3].to_string() } else { String::new() };
                // Use exe path as bundle_id equivalent on Windows
                AppInfo {
                    name: name.clone(),
                    pid,
                    bundle_id: exe_path,
                    title,
                }
            } else {
                AppInfo { name: "?".into(), pid: 0, bundle_id: String::new(), title: String::new() }
            }
        }
        Err(_) => AppInfo { name: "?".into(), pid: 0, bundle_id: String::new(), title: String::new() },
    }
}

/// Activate app by bringing its window to the foreground
pub async fn activate_app(app_name: &str) -> () {
    let script = format!(
        r#"$p = Get-Process -Name '{}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) {{ Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinActivate {{ [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }}
"@; [WinActivate]::ShowWindow($p.MainWindowHandle, 9); [WinActivate]::SetForegroundWindow($p.MainWindowHandle) }}"#,
        app_name
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

/// Send keystrokes via SendKeys or SendInput
pub async fn send_keys(keys: &str) -> () {
    // Convert macOS keystroke format to Windows SendKeys format
    // This function receives already-Windows-formatted SendKeys strings
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{}')"#,
        keys
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
}

/// Read text via UI Automation from an app's focused element
pub async fn read_ax_app(pid: u32, hint_x: Option<f64>, hint_y: Option<f64>) -> CaptureResult {
    let mut args = vec!["read-app".to_string(), pid.to_string()];
    if let (Some(x), Some(y)) = (hint_x, hint_y) {
        args.push(format!("{}", x as i32));
        args.push(format!("{}", y as i32));
    }

    match Command::new(uia_bin_path())
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
                        method: format!("uia-{}", strategy),
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

/// Read via Ctrl+C selection (Windows equivalent of Cmd+C)
pub async fn read_selection(app_name: &str) -> CaptureResult {
    activate_app(app_name).await;
    // Ctrl+C to copy selection
    send_keys("^c").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Read clipboard via PowerShell
    match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"])
        .output()
        .await
    {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if text.trim().is_empty() {
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

/// Write text to target app via UIA or clipboard paste
pub async fn write_to_app(app_name: &str, text: &str, pid: u32) -> WriteResult {
    // Try UIA direct write first
    if pid > 0 {
        activate_app(app_name).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = write_uia(pid, text).await;
        if result.ok {
            return result;
        }
    }

    // Fallback: activate, Ctrl+A, paste
    activate_app(app_name).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Set clipboard
    set_clipboard(text).await;

    send_keys("^a").await;
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    send_keys("^v").await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    WriteResult { ok: true, method: "paste".to_string() }
}

/// Write text via UIA (direct Value set)
pub async fn write_uia(pid: u32, text: &str) -> WriteResult {
    let mut child = match Command::new(uia_bin_path())
        .args(["write-pid", &pid.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return WriteResult { ok: false, method: "uia-error".to_string() },
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
                    method: "uia-write".to_string(),
                }
            } else {
                WriteResult { ok: false, method: "uia-error".to_string() }
            }
        }
        Err(_) => WriteResult { ok: false, method: "uia-error".to_string() },
    }
}

/// Spellcheck via terse-uia (uses Windows spellcheck API)
pub async fn spellcheck_text(text: &str) -> Result<String, String> {
    let mut child = Command::new(uia_bin_path())
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
    let src_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vscode-extension");

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

/// Enable UI Automation on Electron apps (VS Code, Cursor)
pub async fn enable_ax_for_app(pid: u32) -> bool {
    match Command::new(uia_bin_path())
        .args(["enable-uia", &pid.to_string()])
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

/// Send batch keystrokes (Windows version — sequential SendKeys calls)
pub async fn send_keys_batch(cmds: &[&str], delays: &[f64]) {
    for (i, cmd) in cmds.iter().enumerate() {
        send_keys(cmd).await;
        if i < delays.len() && delays[i] > 0.0 {
            tokio::time::sleep(std::time::Duration::from_millis((delays[i] * 1000.0) as u64)).await;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

/// Read ALL text via Ctrl+A -> Ctrl+C -> Right arrow (deselect)
pub async fn read_all_via_clipboard(_app_name: &str) -> CaptureResult {
    // Save clipboard
    let saved = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // Set sentinel
    set_clipboard("__TERSE_SENTINEL__").await;

    send_keys_batch(
        &[
            "^a",          // Ctrl+A: select all
            "^c",          // Ctrl+C: copy
            "{RIGHT}",     // right arrow to deselect
        ],
        &[0.08, 0.15, 0.0],
    ).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let captured = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"])
        .output()
        .await
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

/// Write to a terminal input by clearing the current line first, then pasting.
/// Uses Home + Shift+End to select all, then Ctrl+V to paste.
pub async fn write_via_clipboard_terminal(text: &str) -> WriteResult {
    let saved = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    set_clipboard(text).await;

    // Clear terminal input then paste optimized text
    // Home to go to start, Shift+End to select to end, then paste
    send_keys_batch(
        &[
            "{HOME}",           // Go to start of line
            "+{END}",           // Shift+End: select to end
        ],
        &[0.02, 0.02],
    ).await;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    send_keys_batch(
        &[
            "^v",               // Ctrl+V: paste (replaces selection)
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
    let saved = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    set_clipboard(text).await;

    if !skip_activate {
        activate_app(app_name).await;
    }

    // Ctrl+A to select all text in the focused field, then Ctrl+V to replace
    send_keys_batch(
        &[
            "^a",
            "^v",
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
    // Use PowerShell Set-Clipboard
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            &format!("Set-Clipboard -Value '{}'", text.replace("'", "''"))])
        .output()
        .await;
}

/// Parse last user input from terminal output (Claude Code uses ">" prompt on Windows)
fn parse_last_input(full_text: &str) -> String {
    let lines: Vec<&str> = full_text.split('\n').collect();
    let mut last_prompt_idx: Option<usize> = None;

    for i in (0..lines.len()).rev() {
        let t = lines[i].trim_start();
        // Skip system lines
        if t.starts_with(">>") || t.starts_with("──") || t.is_empty() { continue; }
        // Separator bars
        if t.len() >= 3 && t.chars().all(|c| "─━═▬_-".contains(c)) { continue; }
        // Prompt characters (Windows terminals may use > or ❯)
        if t.starts_with("> ") || t.starts_with("❯ ") || t.starts_with("› ") || t == ">" || t == "❯" || t == "›" {
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
            if t.starts_with(">>") || t.starts_with("››") { break; }
            if t.len() >= 3 && t.chars().all(|c| "─━═▬_-".contains(c)) { break; }
        }

        let line = if i == prompt_idx {
            lines[i].trim_start().trim_start_matches('>')
                .trim_start_matches('❯').trim_start_matches('›')
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

// ── Key Monitor (via terse-uia key-monitor) ──

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
    enter_tx: Option<tokio::sync::mpsc::Sender<String>>,
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
            let mut child = match Command::new(uia_bin_path())
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
                let _ = stdin_state;
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
                            let text = msg["text"].as_str().unwrap_or("").to_string();
                            if let Some(tx) = &handle.enter_tx {
                                let _ = tx.try_send(text);
                            }
                        } else if let Some(text) = msg["text"].as_str() {
                            handle.buffer = text.to_string();
                            handle.last_update = std::time::Instant::now();
                        }
                    }
                }
            }

            // Process ended
            state.inner.lock().unwrap_or_else(|e| e.into_inner()).monitors.remove(&pid);
        });
    }

    pub fn stop_monitor(&self, pid: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.monitors.remove(&pid);
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

// ── Simple HTTP helpers (using curl on Windows) ──

async fn reqwest_lite(url: &str) -> Option<String> {
    // Try curl first (available on Windows 10+), fall back to PowerShell Invoke-WebRequest
    let output = Command::new("curl")
        .args(["-s", "--connect-timeout", "1", "--max-time", "2", url])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).to_string())
        }
        _ => {
            // Fallback: PowerShell
            let ps_cmd = format!(
                "try {{ (Invoke-WebRequest -Uri '{}' -TimeoutSec 2 -UseBasicParsing).Content }} catch {{ }}",
                url
            );
            let output = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
                .output()
                .await
                .ok()?;
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                None
            }
        }
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
        .await;

    match output {
        Ok(o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).to_string())
        }
        _ => {
            // Fallback: PowerShell
            let ps_cmd = format!(
                "try {{ (Invoke-WebRequest -Uri '{}' -Method POST -ContentType 'application/json' -Body '{}' -TimeoutSec 2 -UseBasicParsing).Content }} catch {{ }}",
                url, body.replace("'", "''")
            );
            let output = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
                .output()
                .await
                .ok()?;
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                None
            }
        }
    }
}
