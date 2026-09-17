//! Code Town's keyboard and mouse capture (Windows).
//!
//! The Windows half of `src-tauri/src/town_keys.rs`. The town is the wallpaper,
//! and the wallpaper is a child of Explorer's WorkerW, behind the desktop icons:
//! it can never hold keyboard focus, and clicks on the desktop go to Explorer's
//! icon list. So, as on macOS, nothing here relies on focus. While the "Control
//! town" pill is on, two low-level hooks (WH_KEYBOARD_LL / WH_MOUSE_LL) take the
//! town's keys and bare-desktop drags at the system level and hand them to the
//! wallpaper page; when the pill is off the hooks are removed entirely, so
//! Windows behaves exactly as if Terse were not running.
//!
//! What is taken:
//!   · W A S D, arrows, Q / R (turn), E (door), Space (jump), Esc (stop).
//!     Anything held with Ctrl / Alt / Win passes (Alt+Tab, Win+D, Ctrl+W work).
//!     Shift is forwarded (run) but never swallowed. Auto-repeat is not
//!     forwarded — the town tracks which keys are held.
//!   · A left-button press on BARE desktop (no window under it, not on an icon)
//!     and the drag that follows turn the camera. The press is swallowed so
//!     Explorer does not start a rubber-band selection. Presses on icons,
//!     windows, the taskbar — anywhere else — go through untouched.
//!
//! Unlike macOS this needs no permission: low-level hooks are available to any
//! desktop process. The one Windows limit is UIPI — while an elevated window is
//! in front, its input does not reach a non-elevated hook, so the town simply
//! does not move until that window loses focus.
//!
//! Microsoft Store builds (`--features msstore`) contain no hooks at all — the
//! submission states Terse installs no keyboard hook. There set_capture reports
//! keys:false and the town can still be watched, just not steered.
#![cfg_attr(feature = "msstore", allow(dead_code, unused_imports))]

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GetClassNameW, GetMessageW, GetWindowLongPtrW, GetWindowRect,
    IsWindowVisible, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, GWL_EXSTYLE,
    HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
    WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    WS_EX_TRANSPARENT,
};

/// Pill on = capture wanted.
static ON: AtomicBool = AtomicBool::new(false);
/// The hook thread's id while it runs (0 = no hooks installed).
static THREAD: AtomicU32 = AtomicU32::new(0);
static STARTING: Mutex<bool> = Mutex::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();
static SHIFT: AtomicBool = AtomicBool::new(false);
/// Town keys currently held (bit per virtual-key code < 256, split in four
/// words). A key-down for a bit already set is auto-repeat.
static HELD: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
/// The current press started on bare desktop → the drag belongs to the town.
static DRAGGING: AtomicBool = AtomicBool::new(false);
static LAST_X: AtomicI32 = AtomicI32::new(0);
static LAST_Y: AtomicI32 = AtomicI32::new(0);
/// Physical px per logical px ×1000, so drags match the Mac's point deltas.
static SCALE_MILLI: AtomicU32 = AtomicU32::new(1000);

/// Desktop icon rectangles (physical screen px), refreshed off the hook thread:
/// reading them means a round trip into explorer.exe, which must never happen
/// inside a low-level hook (Windows drops hooks that take too long).
/// `None` = could not be read → never treat anything as bare desktop.
static ICONS: Mutex<(Option<std::time::Instant>, Option<Vec<(i32, i32, i32, i32)>>)> =
    Mutex::new((None, None));

const VK_SHIFT: u32 = 0x10;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12;
const VK_LWIN: i32 = 0x5B;
const VK_RWIN: i32 = 0x5C;
const LLKHF_ALTDOWN: u32 = 0x20;

/// Virtual-key code → the KeyboardEvent.key the town understands.
/// Same set as the macOS keycode table.
pub(crate) fn key_name(vk: u32) -> Option<&'static str> {
    Some(match vk {
        0x57 => "w", 0x41 => "a", 0x53 => "s", 0x44 => "d",
        0x51 => "q", 0x52 => "r", 0x45 => "e",
        0x20 => " ", 0x1B => "Escape",
        0x25 => "ArrowLeft", 0x27 => "ArrowRight", 0x28 => "ArrowDown", 0x26 => "ArrowUp",
        _ => return None,
    })
}

fn held_set(vk: u32, on: bool) -> bool {
    let (w, b) = ((vk as usize / 64) & 3, 1u64 << (vk % 64));
    let prev = if on { HELD[w].fetch_or(b, Ordering::SeqCst) } else { HELD[w].fetch_and(!b, Ordering::SeqCst) };
    prev & b != 0
}

/// One diag line per capture session, so CI (and a user's log) can tell
/// "keys never arrived" from "keys arrived but the town ignored them".
static LOGGED_KEY: AtomicBool = AtomicBool::new(false);

fn send(kind: &str, key: &str) {
    if kind == "keydown" && !LOGGED_KEY.swap(true, Ordering::SeqCst) {
        crate::diag_log("town", &format!("first key captured: {key:?}"));
    }
    if let Some(app) = APP.get() {
        let _ = app.emit_to("wallpaper", "town-key", serde_json::json!({ "t": kind, "key": key }));
    }
}

fn send_mouse(kind: &str, dx: f64, dy: f64) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("wallpaper", "town-mouse", serde_json::json!({ "t": kind, "dx": dx, "dy": dy }));
    }
}

fn modifier_down() -> bool {
    unsafe {
        [VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
            .iter()
            .any(|&vk| (GetAsyncKeyState(vk) as u16) & 0x8000 != 0)
    }
}

fn shift_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_SHIFT as i32) as u16) & 0x8000 != 0 }
}

/// Classes that ARE the desktop: reaching one of these in z-order means nothing
/// covers the point.
fn is_desktop_class(name: &str) -> bool {
    name == "Progman" || name == "WorkerW"
}

struct Probe { x: i32, y: i32, hit: bool }

unsafe extern "system" fn probe_window(hwnd: HWND, lp: LPARAM) -> BOOL {
    let p = &mut *(lp.0 as *mut Probe);
    if !IsWindowVisible(hwnd).as_bool() { return BOOL(1); }
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() { return BOOL(1); }
    if p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom { return BOOL(1); }
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut buf).max(0) as usize;
    let class = String::from_utf16_lossy(&buf[..n]);
    // Reached the desktop itself: everything in front of it has been checked.
    if is_desktop_class(&class) { return BOOL(0); }
    // Click-through windows (Terse's own overlays, vendor HUDs) let the click
    // fall to what is below them, so they do not count as covering the desktop.
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TRANSPARENT.0 != 0 { return BOOL(1); }
    // Windows on another virtual desktop and suspended UWP frames are visible
    // by style but not on screen.
    if cloaked(hwnd) { return BOOL(1); }
    p.hit = true;
    BOOL(0)
}

unsafe fn cloaked(hwnd: HWND) -> bool {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    let mut v: u32 = 0;
    DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut v as *mut u32 as *mut core::ffi::c_void, 4).is_ok() && v != 0
}

/// Is any window over (x, y)? Top-level windows are enumerated front to back,
/// so the first one containing the point decides; the desktop classes end it.
fn window_at(x: i32, y: i32) -> bool {
    let mut p = Probe { x, y, hit: false };
    unsafe {
        let _ = EnumWindows(Some(probe_window), LPARAM(&mut p as *mut Probe as isize));
    }
    p.hit
}

/// Bare desktop: no window, not on an icon, and the icons were actually read.
/// Unreadable icons → false: better a camera that will not turn than a file
/// the user cannot click.
fn on_bare_desktop(x: i32, y: i32) -> bool {
    let g = ICONS.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = g.0.map(|t| t.elapsed() < std::time::Duration::from_secs(4)).unwrap_or(false);
    let Some(rects) = g.1.as_ref().filter(|_| fresh) else { return false };
    if rects.iter().any(|&(rx, ry, rw, rh)| x >= rx - 4 && x < rx + rw + 4 && y >= ry - 4 && y < ry + rh + 4) {
        return false;
    }
    drop(g);
    !window_at(x, y)
}

fn refresh_icons() {
    let v = crate::desktop_icon_rects();
    let rects = if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Some(
            v.get("rects").and_then(|r| r.as_array()).map(|a| {
                a.iter()
                    .map(|r| {
                        let n = |k: &str| r.get(k).and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                        (n("x"), n("y"), n("w"), n("h"))
                    })
                    .collect()
            }).unwrap_or_default(),
        )
    } else {
        None
    };
    *ICONS.lock().unwrap_or_else(|e| e.into_inner()) = (Some(std::time::Instant::now()), rects);
}

#[cfg(not(feature = "msstore"))]
unsafe extern "system" fn on_key(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code < 0 || !ON.load(Ordering::SeqCst) {
        return CallNextHookEx(HHOOK::default(), code, wp, lp);
    }
    let k = &*(lp.0 as *const KBDLLHOOKSTRUCT);
    let msg = wp.0 as u32;
    let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
    let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
    let vk = k.vkCode;
    if vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT {
        // Both shifts share one "Shift" in the town, so releasing one while the
        // other is held must not stop the run. The async state has not caught up
        // with THIS event yet, so ask about the other key only.
        let other = match vk { VK_LSHIFT => Some(VK_RSHIFT), VK_RSHIFT => Some(VK_LSHIFT), _ => None };
        let other_down = other.map(|o| (GetAsyncKeyState(o as i32) as u16) & 0x8000 != 0).unwrap_or(false);
        if !down && !up { return CallNextHookEx(HHOOK::default(), code, wp, lp); }
        let now = down || other_down;
        if SHIFT.swap(now, Ordering::SeqCst) != now {
            send(if now { "keydown" } else { "keyup" }, "Shift");
        }
        return CallNextHookEx(HHOOK::default(), code, wp, lp);
    }
    let Some(name) = key_name(vk) else { return CallNextHookEx(HHOOK::default(), code, wp, lp) };
    if down {
        if k.flags.0 & LLKHF_ALTDOWN != 0 || modifier_down() {
            return CallNextHookEx(HHOOK::default(), code, wp, lp);
        }
        if !held_set(vk, true) { send("keydown", name); }
        return LRESULT(1);
    }
    if up {
        // Only the release of a press we took. A key that was already down when
        // the pill came on must reach the app that saw it go down.
        if !held_set(vk, false) { return CallNextHookEx(HHOOK::default(), code, wp, lp); }
        send("keyup", name);
        return LRESULT(1);
    }
    CallNextHookEx(HHOOK::default(), code, wp, lp)
}

#[cfg(not(feature = "msstore"))]
unsafe extern "system" fn on_mouse(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code < 0 || !ON.load(Ordering::SeqCst) {
        return CallNextHookEx(HHOOK::default(), code, wp, lp);
    }
    let m = &*(lp.0 as *const MSLLHOOKSTRUCT);
    match wp.0 as u32 {
        WM_LBUTTONDOWN => {
            if !shift_down() && !modifier_down() && on_bare_desktop(m.pt.x, m.pt.y) {
                DRAGGING.store(true, Ordering::SeqCst);
                LAST_X.store(m.pt.x, Ordering::SeqCst);
                LAST_Y.store(m.pt.y, Ordering::SeqCst);
                send_mouse("down", 0.0, 0.0);
                crate::diag_log("town", &format!("drag started on bare desktop at {},{}", m.pt.x, m.pt.y));
                return LRESULT(1); // the town's; Explorer draws no selection box
            }
        }
        WM_MOUSEMOVE if DRAGGING.load(Ordering::SeqCst) => {
            // Not swallowed — the cursor keeps moving, as on macOS. Swallowing
            // would freeze it, and a lost button-up would then freeze it for good.
            let s = SCALE_MILLI.load(Ordering::SeqCst).max(1) as f64 / 1000.0;
            let dx = (m.pt.x - LAST_X.swap(m.pt.x, Ordering::SeqCst)) as f64 / s;
            let dy = (m.pt.y - LAST_Y.swap(m.pt.y, Ordering::SeqCst)) as f64 / s;
            if dx != 0.0 || dy != 0.0 { send_mouse("drag", dx, dy); }
        }
        WM_LBUTTONUP => {
            if DRAGGING.swap(false, Ordering::SeqCst) {
                send_mouse("up", 0.0, 0.0);
                return LRESULT(1);
            }
        }
        _ => {}
    }
    CallNextHookEx(HHOOK::default(), code, wp, lp)
}

#[cfg(feature = "msstore")]
fn start_hooks() -> bool { false }

/// Install the hooks on their own thread (they are called on the thread that
/// installed them, which therefore has to pump messages). Returns whether they
/// are in.
#[cfg(not(feature = "msstore"))]
fn start_hooks() -> bool {
    if THREAD.load(Ordering::SeqCst) != 0 { return true; }
    {
        let mut s = STARTING.lock().unwrap_or_else(|e| e.into_inner());
        if *s { drop(s); return wait_for_hooks(); }
        *s = true;
    }
    std::thread::spawn(|| unsafe {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::System::Threading::GetCurrentThreadId;
        let hmod = GetModuleHandleW(None).unwrap_or_default();
        let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), hmod, 0);
        let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), hmod, 0);
        let (kb, ms) = match (kb, ms) {
            (Ok(k), Ok(m)) => (k, m),
            (k, m) => {
                if let Ok(h) = k { let _ = UnhookWindowsHookEx(h); }
                if let Ok(h) = m { let _ = UnhookWindowsHookEx(h); }
                crate::diag_log("town", "SetWindowsHookExW failed — town keys unavailable");
                *STARTING.lock().unwrap_or_else(|e| e.into_inner()) = false;
                return;
            }
        };
        THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        *STARTING.lock().unwrap_or_else(|e| e.into_inner()) = false;
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(kb);
        let _ = UnhookWindowsHookEx(ms);
        THREAD.store(0, Ordering::SeqCst);
    });
    wait_for_hooks()
}

fn wait_for_hooks() -> bool {
    for _ in 0..50 {
        if THREAD.load(Ordering::SeqCst) != 0 { return true; }
        if !*STARTING.lock().unwrap_or_else(|e| e.into_inner()) { return false; }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    THREAD.load(Ordering::SeqCst) != 0
}

fn stop_hooks() {
    let tid = THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe { let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0)); }
    }
}

static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Turn capture on or off. Returns whether the hooks are really in.
pub fn set_capture(app: &AppHandle, on: bool) -> bool {
    let _ = APP.set(app.clone());
    ON.store(on, Ordering::SeqCst);
    if !on {
        LOGGED_KEY.store(false, Ordering::SeqCst);
        stop_hooks();
        // Tell the town everything it thinks is held has been let go, or it
        // keeps walking / running after the pill is off.
        if SHIFT.swap(false, Ordering::SeqCst) { send("keyup", "Shift"); }
        for vk in 0u32..256 {
            if let Some(name) = key_name(vk) {
                if held_set(vk, false) { send("keyup", name); }
            }
        }
        if DRAGGING.swap(false, Ordering::SeqCst) { send_mouse("up", 0.0, 0.0); }
        return false;
    }
    if let Some(sf) = app.get_webview_window("wallpaper").and_then(|w| w.scale_factor().ok()) {
        SCALE_MILLI.store((sf * 1000.0).round().max(1.0) as u32, Ordering::SeqCst);
    }
    // Keep the icon cache warm for as long as the pill is on.
    if !REFRESHING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            while ON.load(Ordering::SeqCst) {
                refresh_icons();
                std::thread::sleep(std::time::Duration::from_millis(1200));
            }
            REFRESHING.store(false, Ordering::SeqCst);
        });
    }
    start_hooks()
}

/// Whether capture is working right now.
pub fn active() -> bool {
    ON.load(Ordering::SeqCst) && THREAD.load(Ordering::SeqCst) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_table_matches_macos_set() {
        let names: Vec<_> = (0u32..256).filter_map(key_name).collect();
        for k in ["w", "a", "s", "d", "q", "r", "e", " ", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] {
            assert!(names.contains(&k), "missing {k}");
        }
        assert_eq!(names.len(), 13);
        assert_eq!(key_name(0x5A), None); // Z is not the town's
    }

    #[test]
    fn repeat_detection() {
        assert!(!held_set(0x57, true));
        assert!(held_set(0x57, true));   // second down = auto-repeat
        assert!(held_set(0x57, false));  // release of a held key
        assert!(!held_set(0x57, false)); // stray release
    }

    /// The hooks really go in on a real desktop, and come back out.
    #[cfg(not(feature = "msstore"))]
    #[test]
    fn hooks_install_and_remove() {
        assert!(start_hooks(), "SetWindowsHookExW refused");
        assert!(THREAD.load(Ordering::SeqCst) != 0);
        // A second start is a no-op, not a second pair of hooks.
        assert!(start_hooks());
        stop_hooks();
        for _ in 0..100 {
            if THREAD.load(Ordering::SeqCst) == 0 { break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(THREAD.load(Ordering::SeqCst), 0, "hook thread did not exit");
    }

    #[test]
    fn desktop_classes() {
        assert!(is_desktop_class("Progman"));
        assert!(is_desktop_class("WorkerW"));
        assert!(!is_desktop_class("Shell_TrayWnd"));
    }
}
