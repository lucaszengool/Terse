//! desk.rs —— 「粒子光标控制桌面」(Pro)。
//!
//! 用户用手势抓住桌面上**任意**窗口,粒子光标自动吸附到窗口里最近的按钮 / 输入框 / 链接上,
//! 捏一下就按下去。三块:
//!   · terse-desk(Swift,src/helpers/terse-desk.swift):常驻子进程,用辅助功能 API 找窗口、
//!     列出能操作的元素、按按钮、点、移窗口。AXUIElement 引用不能跨进程,所以它得常驻。
//!   · desk-overlay 窗口:全屏、透明、**点击穿透**、所有桌面空间都在 —— 只负责画粒子光标、
//!     窗口轮廓和"预锁定"的框(desk-overlay.html / desk-cursor.js)。
//!   · 这里:管子进程(按 seq 对应请求和回复)、开关、Pro 闸门、overlay 窗口。
//!
//! 权限:辅助功能。terse-desk 是 Terse 的子进程,系统按 Terse 算。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct Desk {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    seq: u64,
    pending: HashMap<u64, mpsc::Sender<Value>>,
}

static DESK: LazyLock<Mutex<Desk>> = LazyLock::new(|| Mutex::new(Desk::default()));

fn bin_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            for rel in ["Resources/terse-desk", "Resources/helpers/terse-desk"] {
                let p = contents.join(rel);
                if p.exists() {
                    return p;
                }
            }
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/helpers/terse-desk"))
}

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse/desk.json")
}

pub fn enabled() -> bool {
    std::fs::read_to_string(config_path()).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn ensure_helper() -> Result<(), String> {
    let mut d = DESK.lock().map_err(|e| e.to_string())?;
    if let Some(c) = d.child.as_mut() {
        if matches!(c.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    let bin = bin_path();
    if !bin.exists() {
        return Err(format!("找不到 terse-desk:{}", bin.display()));
    }
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    d.stdin = child.stdin.take();
    d.child = Some(child);
    d.pending.clear();
    eprintln!("[desk] started {}", bin.display());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let seq = v.get("seq").and_then(|s| s.as_u64()).unwrap_or(0);
            if seq == 0 {
                eprintln!("[desk] {line}");
                continue;
            }
            if let Ok(mut d) = DESK.lock() {
                if let Some(tx) = d.pending.remove(&seq) {
                    let _ = tx.send(v);
                }
            }
        }
        eprintln!("[desk] helper exited");
        if let Ok(mut d) = DESK.lock() {
            d.child = None;
            d.stdin = None;
            d.pending.clear();
        }
    });
    Ok(())
}

fn call(mut cmd: Value, timeout: Duration) -> Result<Value, String> {
    ensure_helper()?;
    let (tx, rx) = mpsc::channel();
    {
        let mut d = DESK.lock().map_err(|e| e.to_string())?;
        d.seq += 1;
        let seq = d.seq;
        cmd["seq"] = json!(seq);
        d.pending.insert(seq, tx);
        let line = cmd.to_string() + "\n";
        d.stdin.as_mut().ok_or("no stdin")?.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    }
    rx.recv_timeout(timeout).map_err(|_| "timeout".to_string())
}

/// 给会话栏用的(跳到 Claude 里的某一段会话 / 发一句话 / 叫它停下)—— 不走 desk_call 的 Pro 闸门
pub fn call_desk(cmd: Value, secs: u64) -> Result<Value, String> {
    call(cmd, Duration::from_secs(secs))
}

/// overlay 页面的统一入口:{cmd:"windowAt"|"scan"|"press"|"focus"|"raise"|"move"|"click"|"release"|"trust", ...}
/// Pro 功能:每一次调用都查许可 —— 这是能替用户点任意按钮的通道,前端的闸门不够。
#[tauri::command(async)]
pub fn desk_call(cmd: Value) -> Result<Value, String> {
    if !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    let secs = if cmd.get("cmd").and_then(|c| c.as_str()) == Some("scan") { 4 } else { 2 };
    call(cmd, Duration::from_secs(secs))
}

#[tauri::command(async)]
pub fn desk_get_enabled() -> bool {
    enabled()
}

/// 主界面「手势」页的开关:存下来,开 → 显示粒子光标层并检查辅助功能(没授权会弹系统提示)
#[tauri::command(async)]
pub fn desk_set_enabled(app: AppHandle, on: bool) -> Result<Value, String> {
    if on && !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    if let Some(dir) = config_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(config_path(), json!({ "enabled": on }).to_string()).map_err(|e| e.to_string())?;
    let _ = app.emit("desk-enabled", on);
    if on {
        show_overlay(&app)?;
        let t = call(json!({ "cmd": "trust", "prompt": true }), Duration::from_secs(2)).unwrap_or(json!({}));
        return Ok(json!({ "enabled": true, "trusted": t.get("trusted").cloned().unwrap_or(json!(false)) }));
    }
    // 关掉的只是"抓窗口"这一层;光标层本身还在(粒子手 + 统一光标由手势控制管)
    let _ = call(json!({ "cmd": "release" }), Duration::from_millis(500));
    if !crate::hands::enabled() { hide_overlay(&app); }
    Ok(json!({ "enabled": false }))
}

/// 辅助功能授权了没有(不弹框)
#[tauri::command(async)]
pub fn desk_trust() -> bool {
    call(json!({ "cmd": "trust", "prompt": false }), Duration::from_secs(2)).ok()
        .and_then(|v| v.get("trusted").and_then(|b| b.as_bool())).unwrap_or(false)
}

/// 光标层显示 / 藏起来。**没有手的时候把整个窗口从屏幕上拿走**(orderOut):
/// macOS 上透明窗口哪怕内容一动不动,WindowServer 也每一帧把整个窗口重新合成一遍
/// (tauri-apps/tauri#15471,Intel 上 WebKit.GPU 能到 1380% CPU)—— 全屏的透明光标层常驻在那里,
/// 就是白白烧 GPU。拿走之后网页还在跑(事件照收),手一出现就 orderFrontRegardless 放回来(不抢焦点)。
#[tauri::command]
pub fn desk_overlay_visible(app: AppHandle, show: bool) {
    let Some(w) = app.get_webview_window("desk-overlay") else { return };
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use cocoa::base::{id, nil};
            use objc::{msg_send, sel, sel_impl};
            if let Ok(ptr) = w.ns_window() {
                let ns: id = ptr as id;
                unsafe {
                    if show { let _: () = msg_send![ns, orderFrontRegardless]; }
                    else { let _: () = msg_send![ns, orderOut: nil]; }
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        { if show { let _ = w.show(); } else { let _ = w.hide(); } }
    });
}

#[tauri::command(async)]
pub fn desk_open_ax_settings() {
    let _ = Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status();
}

pub fn autostart(app: AppHandle) {
    if (enabled() || crate::hands::enabled()) && crate::license::License::load().is_pro() {
        let _ = show_overlay(&app);
    }
}

/// 显示光标层(没有就建)。**不管从哪个线程调,都交给主线程去做。**
///
/// ⚠ 2026-09-12 一打开就闪退:hands::autostart 在后台线程里调它,建窗口 + setIgnoresMouseEvents /
/// setLevel 这些 AppKit 调用跑在了非主线程上 → AppKit 直接 SIGILL("Must only be used from the
/// main thread")。手势开关开着、摄像头授权过的用户每次启动都会崩。
pub fn show_overlay(app: &AppHandle) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = show_overlay_main(&a) {
            eprintln!("[desk] overlay: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

fn show_overlay_main(app: &AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("desk-overlay") {
        let _ = w.show();
        return Ok(());
    }
    let (sw, sh) = match app.primary_monitor() {
        Ok(Some(m)) => { let s = m.scale_factor(); (m.size().width as f64 / s, m.size().height as f64 / s) }
        _ => (1440.0, 900.0),
    };
    let win = WebviewWindowBuilder::new(app, "desk-overlay", WebviewUrl::App("desk-overlay.html".into()))
        .title("Terse Cursor")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .visible_on_all_workspaces(true)
        .inner_size(sw, sh)
        .position(0.0, 0.0)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::{id, NO, YES};
        use objc::{class, msg_send, sel, sel_impl};
        if let Ok(ptr) = win.ns_window() {
            let ns: id = ptr as id;
            unsafe {
                // 点击穿透:光标层只负责画,鼠标和点击全都落到下面真正的窗口
                let _: () = msg_send![ns, setIgnoresMouseEvents: YES];
                // 浮在普通窗口和浮动面板之上(弹出菜单那一层)
                let _: () = msg_send![ns, setLevel: 101i64];
                // 所有桌面空间 + 全屏 app 里也在 + 不进 ⌘` 循环
                let _: () = msg_send![ns, setCollectionBehavior: ((1u64 << 0) | (1u64 << 4) | (1u64 << 6) | (1u64 << 8))];
                let _: () = msg_send![ns, setOpaque: NO];
                let _: () = msg_send![ns, setHasShadow: NO];
                let clear: id = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![ns, setBackgroundColor: clear];
            }
        }
    }
    Ok(())
}

pub fn hide_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("desk-overlay") {
        let _ = w.close();
    }
}
