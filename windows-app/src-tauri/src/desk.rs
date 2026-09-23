//! 「粒子光标控制桌面」(Pro) —— the Windows half of `src-tauri/src/desk.rs`.
//!
//! The particle cursor grabs whatever window it is over, finds the buttons and
//! text boxes inside it, and a pinch presses one. Same commands and the same
//! JSON as macOS, so `desk-cursor.js` needs no Windows branch.
//!
//! Three differences, all forced by the platform:
//!
//!   · **No helper process.** macOS needs one because an AXUIElement cannot
//!     cross a process boundary, so a Swift child (`terse-desk`) holds the tree
//!     and answers over a pipe. Windows' UI Automation is a COM API any process
//!     can call about any window, so this talks to it directly — nothing to
//!     ship, spawn, supervise or leave running.
//!   · **No permission.** There is no Accessibility grant to ask for: UIA is
//!     open to desktop apps. `trust` therefore answers true rather than
//!     inventing a switch, and the UI's "allow Terse" step never appears.
//!   · **Elements are acted on by point, not by handle.** COM interfaces are
//!     bound to the thread that created them and cannot be parked in a static
//!     for a later command on another thread. What is remembered instead is
//!     each element's rectangle, and a press clicks its centre — which is the
//!     path macOS also falls back to, and the only one that works for the web
//!     content inside Electron agents anyway.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicIsize, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// What `scan` found last: id → (centre x, centre y) in physical pixels, plus
/// the kind, so `press` and `focus` know what they are touching.
static ELEMENTS: LazyLock<Mutex<HashMap<i64, (i32, i32, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicI64 = AtomicI64::new(1);
/// The window the cursor has hold of, for `move`.
static CAPTURED: AtomicIsize = AtomicIsize::new(0);

fn config_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse/desk.json")
}

pub fn enabled() -> bool {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/* ══════════════ UI Automation ══════════════ */

/// Control types that take typing, and the ones that take a press. UIA's ids
/// are stable numbers; naming them here keeps the walk readable.
const UIA_EDIT: i32 = 50004;
const UIA_DOCUMENT: i32 = 50030;
const UIA_COMBOBOX: i32 = 50003;
const UIA_BUTTON: i32 = 50000;
const UIA_CHECKBOX: i32 = 50002;
const UIA_HYPERLINK: i32 = 50005;
const UIA_LISTITEM: i32 = 50007;
const UIA_MENUITEM: i32 = 50011;
const UIA_RADIO: i32 = 50013;
const UIA_TAB_ITEM: i32 = 50019;
const UIA_SPLITBUTTON: i32 = 50031;

fn kind_of(ct: i32) -> Option<&'static str> {
    match ct {
        UIA_EDIT | UIA_DOCUMENT | UIA_COMBOBOX => Some("input"),
        UIA_BUTTON | UIA_CHECKBOX | UIA_HYPERLINK | UIA_LISTITEM | UIA_MENUITEM | UIA_RADIO
        | UIA_TAB_ITEM | UIA_SPLITBUTTON => Some("click"),
        _ => None,
    }
}

fn role_name(ct: i32) -> &'static str {
    match ct {
        UIA_EDIT => "Edit",
        UIA_DOCUMENT => "Document",
        UIA_COMBOBOX => "ComboBox",
        UIA_BUTTON => "Button",
        UIA_CHECKBOX => "CheckBox",
        UIA_HYPERLINK => "Hyperlink",
        UIA_LISTITEM => "ListItem",
        UIA_MENUITEM => "MenuItem",
        UIA_RADIO => "RadioButton",
        UIA_TAB_ITEM => "TabItem",
        UIA_SPLITBUTTON => "SplitButton",
        _ => "Element",
    }
}

/// Walk the automation tree of the window under `rect` and report everything
/// worth pointing at.
///
/// Bounded twice over, because the tree of a browser or an Electron app is
/// enormous and this runs while a hand is in the air: 6000 elements or 900 ms,
/// whichever comes first — the same budget macOS uses.
fn scan(hwnd: isize, rect: (f64, f64, f64, f64)) -> Value {
    use windows::core::Interface;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, TreeScope_Subtree,
    };

    let (rx, ry, rw, rh) = rect;
    let (rx2, ry2) = (rx + rw, ry + rh);
    let t0 = std::time::Instant::now();
    let mut out: Vec<Value> = Vec::new();
    let mut truncated = false;

    unsafe {
        // Apartment-threaded, and uninitialised before returning: this runs on
        // whatever thread the command landed on.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let res = (|| -> Result<(), String> {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
            let root: IUIAutomationElement = uia
                .ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void))
                .map_err(|e| e.to_string())?;
            // One pass for everything in the subtree that can be reached in the
            // control view: cheaper than walking child by child across a
            // process boundary, which is what makes a naive tree walk crawl.
            let cond = uia.CreateTrueCondition().map_err(|e| e.to_string())?;
            let found = root
                .FindAll(TreeScope_Subtree, &cond)
                .map_err(|e| e.to_string())?;
            let n = found.Length().unwrap_or(0);
            let mut table = ELEMENTS.lock().unwrap_or_else(|e| e.into_inner());
            for i in 0..n {
                if i > 6000 || t0.elapsed().as_millis() > 900 {
                    truncated = true;
                    break;
                }
                let Ok(el) = found.GetElement(i) else { continue };
                let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
                let Some(kind) = kind_of(ct) else { continue };
                let Ok(b) = el.CurrentBoundingRectangle() else { continue };
                let (x, y, w, h) = (
                    b.left as f64,
                    b.top as f64,
                    (b.right - b.left) as f64,
                    (b.bottom - b.top) as f64,
                );
                if w < 4.0 || h < 4.0 {
                    continue;
                }
                // Clipped to the window the cursor is over — scrolled-away rows
                // and panels behind it are not things anyone can point at.
                let (vx, vy) = (x.max(rx), y.max(ry));
                let (vx2, vy2) = ((x + w).min(rx2), (y + h).min(ry2));
                if vx2 - vx < 3.0 || vy2 - vy < 3.0 {
                    continue;
                }
                let title = el
                    .CurrentName()
                    .map(|s| s.to_string())
                    .unwrap_or_default()
                    .chars()
                    .take(60)
                    .collect::<String>();
                let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
                table.insert(
                    id,
                    (
                        ((vx + vx2) / 2.0) as i32,
                        ((vy + vy2) / 2.0) as i32,
                        kind.to_string(),
                    ),
                );
                out.push(json!({
                    "id": id, "role": role_name(ct), "sub": "", "kind": kind,
                    "title": title,
                    "x": vx, "y": vy, "w": vx2 - vx, "h": vy2 - vy,
                }));
            }
            let _ = el_drop(&uia);
            Ok(())
        })();
        CoUninitialize();
        if let Err(e) = res {
            return json!({ "ok": false, "error": e });
        }
    }
    json!({
        "ok": true,
        "count": out.len(),
        "truncated": truncated,
        "elements": out,
        "ms": t0.elapsed().as_millis() as u64,
    })
}

/// Nothing to release — kept so the scan body reads like the macOS one, where
/// the tree really does have to be let go of.
#[allow(clippy::needless_pass_by_value)]
fn el_drop(_uia: &windows::Win32::UI::Accessibility::IUIAutomation) -> Option<()> {
    None
}

/* ══════════════ pointer ══════════════ */

fn move_cursor(x: i32, y: i32) {
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
    unsafe {
        let _ = SetCursorPos(x, y);
    }
}

fn click_at(x: i32, y: i32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEINPUT,
    };
    move_cursor(x, y);
    std::thread::sleep(std::time::Duration::from_millis(16));
    let ev = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    let mut down = [ev(MOUSEEVENTF_LEFTDOWN)];
    let mut up = [ev(MOUSEEVENTF_LEFTUP)];
    unsafe {
        SendInput(&mut down, std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(std::time::Duration::from_millis(24));
        SendInput(&mut up, std::mem::size_of::<INPUT>() as i32);
    }
}

fn window_at(x: i32, y: i32) -> Option<Value> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, WindowFromPoint,
        GA_ROOT,
    };
    unsafe {
        let h = WindowFromPoint(POINT { x, y });
        if h.0.is_null() {
            return None;
        }
        let root = GetAncestor(h, GA_ROOT);
        let mut r = RECT::default();
        GetWindowRect(root, &mut r).ok()?;
        let mut pid = 0u32;
        GetWindowThreadProcessId(root, Some(&mut pid));
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(root, &mut buf).max(0) as usize;
        Some(json!({
            "pid": pid,
            "wid": root.0 as isize,
            "owner": crate::process_exe_name(pid).unwrap_or_default(),
            "title": String::from_utf16_lossy(&buf[..n]),
            "x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top,
        }))
    }
}

/* ══════════════ the command the page calls ══════════════ */

#[tauri::command(async)]
pub fn desk_call(cmd: Value) -> Result<Value, String> {
    let s = |k: &str| cmd.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let n = |k: &str| cmd.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    match cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("") {
        // There is no Accessibility grant on Windows. Saying "trusted" is the
        // truth here, not a stub: UIA answers for any desktop app.
        "trust" => Ok(json!({ "trusted": true })),
        "windowAt" => Ok(json!({
            "ok": true,
            "window": window_at(n("x") as i32, n("y") as i32).unwrap_or(Value::Null),
        })),
        "scan" => {
            let hwnd = window_at(
                (n("x") + n("w") / 2.0) as i32,
                (n("y") + 12.0) as i32,
            )
            .and_then(|w| w.get("wid").and_then(|v| v.as_i64()))
            .unwrap_or(0) as isize;
            if hwnd == 0 {
                return Ok(json!({ "ok": false, "error": "no_window" }));
            }
            CAPTURED.store(hwnd, Ordering::SeqCst);
            Ok(scan(hwnd, (n("x"), n("y"), n("w"), n("h"))))
        }
        "press" | "focus" => {
            let id = n("id") as i64;
            let hit = ELEMENTS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .cloned();
            let Some((x, y, _kind)) = hit else {
                return Ok(json!({ "ok": false, "error": "stale" }));
            };
            click_at(x, y);
            Ok(json!({ "ok": true, "via": "click" }))
        }
        "raise" => {
            let pid = n("pid") as u32;
            let ok = crate::ui_window_for_pid(pid)
                .map(crate::activate_window)
                .unwrap_or(false);
            Ok(json!({ "ok": ok }))
        }
        // Drag the grabbed window by an offset from where it started.
        "move" => {
            use windows::Win32::Foundation::{HWND, RECT};
            use windows::Win32::UI::WindowsAndMessaging::{
                GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
            };
            let h = CAPTURED.load(Ordering::SeqCst);
            if h == 0 {
                return Ok(json!({ "ok": false, "error": "no_window" }));
            }
            unsafe {
                let hwnd = HWND(h as *mut core::ffi::c_void);
                let mut r = RECT::default();
                if GetWindowRect(hwnd, &mut r).is_err() {
                    return Ok(json!({ "ok": false, "error": "no_window" }));
                }
                let (x, y) = (r.left + n("dx") as i32, r.top + n("dy") as i32);
                let _ = SetWindowPos(
                    hwnd, None, x, y, 0, 0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
                Ok(json!({
                    "ok": true, "x": x, "y": y,
                    "w": r.right - r.left, "h": r.bottom - r.top
                }))
            }
        }
        "click" => {
            click_at(n("x") as i32, n("y") as i32);
            Ok(json!({ "ok": true }))
        }
        "release" => {
            ELEMENTS.lock().unwrap_or_else(|e| e.into_inner()).clear();
            CAPTURED.store(0, Ordering::SeqCst);
            Ok(json!({ "ok": true }))
        }
        // The Claude Desktop shortcuts. macOS drives them through the
        // accessibility tree; here the window is raised and typed into, which is
        // the same thing from the app's point of view.
        "claudeJump" => {
            let ok = find_window_titled(&s("title"))
                .map(crate::activate_window)
                .unwrap_or(false);
            Ok(json!({ "ok": ok }))
        }
        "claudeSend" => {
            let text = s("text");
            if text.trim().is_empty() {
                return Ok(json!({ "ok": false, "error": "empty" }));
            }
            let Some(h) = find_window_titled(&s("title")) else {
                return Ok(json!({ "ok": false, "error": "no_window" }));
            };
            let saved = crate::clipboard_get();
            crate::clipboard_set(text.trim())?;
            if !crate::activate_window(h) {
                let _ = crate::clipboard_restore(saved);
                return Ok(json!({ "ok": false, "error": "activate_failed" }));
            }
            std::thread::sleep(std::time::Duration::from_millis(220));
            crate::press_ctrl_v();
            std::thread::sleep(std::time::Duration::from_millis(260));
            crate::press_enter();
            std::thread::sleep(std::time::Duration::from_millis(160));
            let _ = crate::clipboard_restore(saved);
            Ok(json!({ "ok": true }))
        }
        "claudeStop" => {
            let Some(h) = find_window_titled(&s("title")) else {
                return Ok(json!({ "ok": false, "error": "no_window" }));
            };
            crate::activate_window(h);
            std::thread::sleep(std::time::Duration::from_millis(120));
            crate::press_escape();
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("unknown desk command: {other}")),
    }
}

/// The visible window whose title contains `needle` (case-insensitive), or the
/// first Claude window when the needle is empty.
///
/// Shared with the session dock, which uses it to refuse to type into a
/// conversation it cannot positively identify.
pub(crate) fn window_titled(needle: &str) -> Option<windows::Win32::Foundation::HWND> {
    if needle.is_empty() {
        return None;
    }
    find_window_titled(needle)
}

fn find_window_titled(needle: &str) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, IsWindowVisible,
    };
    struct Find {
        needle: String,
        hit: isize,
    }
    unsafe extern "system" fn scan(h: HWND, lp: LPARAM) -> BOOL {
        let f = &mut *(lp.0 as *mut Find);
        if !IsWindowVisible(h).as_bool() {
            return TRUE;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(h, &mut buf).max(0) as usize;
        let title = String::from_utf16_lossy(&buf[..n]).to_ascii_lowercase();
        if title.is_empty() {
            return TRUE;
        }
        let want = if f.needle.is_empty() { "claude" } else { f.needle.as_str() };
        if title.contains(want) {
            f.hit = h.0 as isize;
            return BOOL(0);
        }
        TRUE
    }
    let mut f = Find { needle: needle.to_ascii_lowercase(), hit: 0 };
    unsafe {
        let _ = EnumWindows(Some(scan), LPARAM(&mut f as *mut Find as isize));
    }
    (f.hit != 0).then(|| HWND(f.hit as *mut core::ffi::c_void))
}

/* ══════════════ the switch ══════════════ */

#[tauri::command(async)]
pub fn desk_get_enabled() -> bool {
    enabled()
}

#[tauri::command(async)]
pub fn desk_set_enabled(app: AppHandle, on: bool) -> Result<Value, String> {
    if on && !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    if let Some(dir) = config_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(config_path(), json!({ "enabled": on }).to_string())
        .map_err(|e| e.to_string())?;
    let _ = app.emit("desk-enabled", on);
    if on {
        show_overlay(&app)?;
        // Always trusted on Windows: there is no grant, so the UI's "allow
        // Terse" step is never shown.
        return Ok(json!({ "enabled": true, "trusted": true }));
    }
    ELEMENTS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    CAPTURED.store(0, Ordering::SeqCst);
    // Only the window-grabbing half goes away. The cursor layer belongs to the
    // gesture feature and stays if hands are on.
    if !crate::hands::enabled() {
        hide_overlay(&app);
    }
    Ok(json!({ "enabled": false }))
}

#[tauri::command(async)]
pub fn desk_trust() -> bool {
    true
}

/// There is no Accessibility pane to send anyone to; the nearest thing Windows
/// has is Ease of Access, and opening it is better than a dead button.
#[tauri::command(async)]
pub fn desk_open_ax_settings() {
    let _ = crate::hidden_command("cmd")
        .args(["/C", "start", "", "ms-settings:easeofaccess"])
        .spawn();
}

/// Show or hide the cursor layer.
///
/// macOS takes the window off screen entirely when no hand is up, because a
/// full-screen transparent window is recomposited every frame there even when
/// nothing moves. Windows does not have that cost, but hiding still saves the
/// page's own animation, and the two platforms behave the same from the page's
/// side.
#[tauri::command]
pub fn desk_overlay_visible(app: AppHandle, show: bool) {
    let Some(w) = app.get_webview_window("desk-overlay") else { return };
    let _ = app.run_on_main_thread(move || {
        if show {
            let _ = w.show();
        } else {
            let _ = w.hide();
        }
    });
}

pub fn show_overlay(app: &AppHandle) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = show_overlay_main(&a) {
            crate::diag_log("desk", &format!("overlay: {e}"));
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
        Ok(Some(m)) => {
            let s = m.scale_factor();
            (m.size().width as f64 / s, m.size().height as f64 / s)
        }
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
    // Click-through, and never taking focus: it is a drawing of a cursor over
    // the desktop, and every click belongs to whatever is underneath.
    let _ = win.set_ignore_cursor_events(true);
    if let Ok(raw) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        };
        unsafe {
            let hwnd = HWND(raw.0);
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | (WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0
                    | WS_EX_LAYERED.0) as isize,
            );
        }
    }
    let _ = win.show();
    Ok(())
}

pub fn hide_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("desk-overlay") {
        let _ = w.hide();
    }
}

/// Bring the cursor layer back at launch for someone who left it on.
pub fn autostart(app: AppHandle) {
    if (enabled() || crate::hands::enabled()) && crate::license::License::load().is_pro() {
        let _ = show_overlay(&app);
    }
}
