//! 粒子模式 (Pro) —— the Windows half of `src-tauri/src/particle_mode.rs`.
//!
//! Another agent's window, captured a dozen times a second and redrawn as a
//! field of particles on a click-through overlay. Same commands, same events
//! and the same payload shapes as macOS, so `particle-window.js` and the
//! control panel need no Windows branch.
//!
//! What is genuinely different here:
//!
//!   · **No permission exists to ask for.** macOS needs the screen-recording
//!     grant and its whole permission dance (probe, prompt, self-test); Windows
//!     lets a process read the pixels of another window it did not create. So
//!     pm_has_permission / pm_request_permission answer true rather than
//!     pretending there is a switch somewhere.
//!   · **Capture is PrintWindow, not ScreenCaptureKit.** With
//!     PW_RENDERFULLCONTENT it also captures windows drawn by a GPU compositor
//!     (Chromium, Electron, WebView2 — i.e. every agent worth capturing), which
//!     plain BitBlt of the screen cannot do while another window overlaps them.
//!     It reads the window's own content, so the capture keeps working when
//!     Terse's overlay is sitting on top of it — on macOS that is what the
//!     window-id capture buys, and here it comes from the same choice.
//!   · **A window id is ours, not the system's.** macOS has stable CGWindowIDs;
//!     an HWND is a 64-bit pointer that does not fit the u32 the pages already
//!     speak, so pm_windows hands out small ids and remembers which HWND each
//!     one meant.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
// PrintWindow is filed under Storage::Xps in the windows crate, not with the
// other window calls — it is the same user32 export regardless.
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

/// Known agents, matched on a FRAGMENT of the executable or window title — the
/// same table macOS matches against bundle ids, minus the Apple-only entries
/// and plus the terminals people actually run agents in on Windows.
const KNOWN: &[(&str, &str)] = &[
    ("claude", "Claude"),
    ("anthropic", "Claude"),
    ("openai", "Codex"),
    ("codex", "Codex"),
    ("cursor", "Cursor"),
    ("code", "VS Code"),
    ("windowsterminal", "Terminal"),
    ("wt", "Terminal"),
    ("conhost", "Terminal"),
    ("powershell", "PowerShell"),
    ("cmd", "Command Prompt"),
    ("warp", "Warp"),
    ("alacritty", "Alacritty"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
];

fn known_label(exe: &str, title: &str) -> Option<&'static str> {
    let e = exe.to_ascii_lowercase();
    let t = title.to_ascii_lowercase();
    KNOWN
        .iter()
        .find(|(needle, _)| e.contains(needle) || t.contains(needle))
        .map(|(_, label)| *label)
}

#[derive(Serialize, Clone)]
pub struct AgentWindow {
    pub id: u32,
    /// App name (Claude, Codex, Terminal…)
    pub app: String,
    /// The executable, standing in for macOS's bundle id.
    pub bundle: String,
    pub title: String,
    pub pid: i32,
    /// Where the window is, in logical pixels — the overlay has to land exactly
    /// on top of it, and that is what this is for.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Whether it is an agent we recognise. Unknown ones are still listed, just
    /// after the known ones.
    pub known: bool,
}

/// id → HWND, from the last pm_windows. An HWND is a pointer and the pages
/// speak u32 ids, so the mapping lives here rather than in the payload.
static WINDOWS: OnceLock<Mutex<Vec<(u32, isize)>>> = OnceLock::new();
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn registry() -> &'static Mutex<Vec<(u32, isize)>> {
    WINDOWS.get_or_init(|| Mutex::new(Vec::new()))
}

/// The monitor scale, so the rectangles handed to the page are the logical
/// pixels its CSS and Tauri's window positions are in.
fn scale(app: Option<&AppHandle>) -> f64 {
    app.and_then(|a| a.primary_monitor().ok().flatten())
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

#[derive(Default)]
pub struct Capture {
    running: AtomicBool,
    window: AtomicU32,
}

/// Nothing to grant on Windows: reading another window's pixels needs no
/// permission, so this is true rather than a switch that does not exist.
#[tauri::command]
pub fn pm_has_permission() -> bool {
    true
}

#[tauri::command]
pub fn pm_request_permission() -> bool {
    true
}

struct Scan {
    out: Vec<AgentWindow>,
    me: u32,
}

unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> windows::Win32::Foundation::BOOL {
    let s = &mut *(lp.0 as *mut Scan);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return TRUE;
    }
    // Tool windows are palettes and tooltips: not the thing anyone means.
    if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    if crate::is_cloaked(hwnd) {
        return TRUE;
    }
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() {
        return TRUE;
    }
    let (w, h) = ((r.right - r.left) as f64, (r.bottom - r.top) as f64);
    // Small floaters and strips are not what anyone wants to watch.
    if w < 200.0 || h < 150.0 {
        return TRUE;
    }
    let mut buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
    let title = String::from_utf16_lossy(&buf[..n]);
    if title.trim().is_empty() {
        return TRUE;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    // Never ourselves: a particle window capturing the particle window is a
    // mirror facing a mirror.
    if pid == s.me {
        return TRUE;
    }
    let exe = crate::process_exe_name(pid).unwrap_or_default();
    if exe.to_ascii_lowercase().contains("terse") {
        return TRUE;
    }
    let label = known_label(&exe, &title);
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((id, hwnd.0 as isize));
    s.out.push(AgentWindow {
        id,
        app: label.map(|l| l.to_string()).unwrap_or_else(|| {
            exe.trim_end_matches(".exe").to_string()
        }),
        bundle: exe,
        title,
        pid: pid as i32,
        x: r.left as f64,
        y: r.top as f64,
        w,
        h,
        known: label.is_some(),
    });
    TRUE
}

/// Which windows can become particles right now.
///
/// EnumWindows walks front to back, so the order is the stacking order the
/// picker shows. Unlike macOS there is no permission probe folded in here —
/// there is no permission — so this never returns NEEDS_PERMISSION and the page
/// never shows that branch.
#[tauri::command]
pub fn pm_windows(app: AppHandle) -> Result<Vec<AgentWindow>, String> {
    registry().lock().unwrap_or_else(|e| e.into_inner()).clear();
    let mut scan = Scan { out: Vec::new(), me: std::process::id() };
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut scan as *mut Scan as isize));
    }
    // Physical pixels from Win32, logical for the page.
    let k = scale(Some(&app));
    for w in &mut scan.out {
        w.x /= k;
        w.y /= k;
        w.w /= k;
        w.h /= k;
    }
    // Known agents first, then everything else — same order as macOS.
    scan.out.sort_by_key(|w| !w.known);
    Ok(scan.out)
}

fn hwnd_of(id: u32) -> Option<HWND> {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, h)| HWND(*h as *mut core::ffi::c_void))
}

fn find_window(id: u32) -> Result<HWND, String> {
    let h = hwnd_of(id).ok_or_else(|| "那个窗口不在了".to_string())?;
    unsafe {
        if !IsWindowVisible(h).as_bool() {
            return Err("那个窗口不在了".into());
        }
        if IsIconic(h).as_bool() {
            // Minimised windows have nothing to print. Not fatal — the user may
            // restore it, and pm_start's miss counter waits for that.
            return Err("那个窗口最小化了".into());
        }
    }
    Ok(h)
}

/// Where a window is now, in logical pixels. The overlay follows a window that
/// is dragged or resized, and this is what it follows.
#[tauri::command]
pub fn pm_window_rect(app: AppHandle, id: u32) -> Option<(f64, f64, f64, f64)> {
    let h = hwnd_of(id)?;
    let mut r = RECT::default();
    unsafe {
        if GetWindowRect(h, &mut r).is_err() {
            return None;
        }
    }
    let k = scale(Some(&app));
    Some((
        r.left as f64 / k,
        r.top as f64 / k,
        (r.right - r.left) as f64 / k,
        (r.bottom - r.top) as f64 / k,
    ))
}

/// One frame of a window, as JPEG bytes plus the size they represent.
///
/// PW_RENDERFULLCONTENT is the flag that makes this work at all for the apps
/// people run agents in: Chromium, Electron and WebView2 windows render through
/// the compositor, and without it PrintWindow returns a blank or stale surface.
fn grab_jpeg(hwnd: HWND) -> Result<(Vec<u8>, u32, u32), String> {
    const PW_RENDERFULLCONTENT: u32 = 0x00000002;
    // A particle field does not need a retina frame, and every pixel here costs
    // JPEG time and IPC. Long edge capped, aspect kept.
    const MAX_EDGE: u32 = 900;
    unsafe {
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).map_err(|e| e.to_string())?;
        let (w, h) = ((r.right - r.left), (r.bottom - r.top));
        if w <= 0 || h <= 0 {
            return Err("窗口没有大小".into());
        }
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h; // top-down, the order encoders expect
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dc = CreateCompatibleDC(None);
        let bmp: HBITMAP = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|e| e.to_string())?;
        let old = SelectObject(dc, HGDIOBJ(bmp.0));
        let ok = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        SelectObject(dc, old);

        let mut rgb: Vec<u8> = Vec::new();
        if ok && !bits.is_null() {
            let n = (w * h) as usize;
            let src = std::slice::from_raw_parts(bits as *const u8, n * 4);
            rgb.reserve(n * 3);
            for p in src.chunks_exact(4) {
                rgb.extend_from_slice(&[p[2], p[1], p[0]]); // BGRA → RGB
            }
        }
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        if rgb.is_empty() {
            return Err("这一帧没抓到".into());
        }

        let img = image::RgbImage::from_raw(w as u32, h as u32, rgb)
            .ok_or_else(|| "帧的大小对不上".to_string())?;
        let (mut dw, mut dh) = (w as u32, h as u32);
        let img = if dw.max(dh) > MAX_EDGE {
            let k = MAX_EDGE as f64 / dw.max(dh) as f64;
            dw = ((dw as f64 * k).round() as u32).max(1);
            dh = ((dh as f64 * k).round() as u32).max(1);
            image::imageops::resize(&img, dw, dh, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut jpg: Vec<u8> = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut std::io::Cursor::new(&mut jpg), 70)
            .encode(img.as_raw(), dw, dh, image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
        Ok((jpg, dw, dh))
    }
}

/// Start turning this window into particles.
///
/// One frame is grabbed BEFORE the thread starts, so a failure is reported to
/// the caller instead of the UI saying "on" while nothing appears — same
/// contract as macOS.
#[tauri::command]
pub fn pm_start(
    app: AppHandle,
    state: tauri::State<'_, Arc<Capture>>,
    id: u32,
    fps: Option<u32>,
) -> Result<(), String> {
    let h = find_window(id)?;
    grab_jpeg(h)?;

    state.running.store(false, Ordering::SeqCst); // stop whatever was running
    std::thread::sleep(Duration::from_millis(60));
    state.running.store(true, Ordering::SeqCst);
    state.window.store(id, Ordering::SeqCst);

    let fps = fps.unwrap_or(12).clamp(1, 30);
    let period = Duration::from_millis((1000 / fps.max(1)) as u64);
    let cap = state.inner().clone();
    std::thread::spawn(move || {
        let mut seq: u64 = 0;
        let mut misses = 0u32;
        while cap.running.load(Ordering::SeqCst) && cap.window.load(Ordering::SeqCst) == id {
            let t0 = std::time::Instant::now();
            match find_window(id).and_then(grab_jpeg) {
                Ok((jpg, dw, dh)) => {
                    misses = 0;
                    seq += 1;
                    let _ = app.emit(
                        "pm-frame",
                        serde_json::json!({
                            "id": id, "seq": seq, "w": dw, "h": dh,
                            "jpeg": crate::b64(&jpg),
                        }),
                    );
                }
                Err(e) => {
                    // Minimised, being dragged, briefly unreadable. Several in a
                    // row is giving up; one is not, or the particles vanish the
                    // moment someone moves the window.
                    misses += 1;
                    if misses >= 8 {
                        let _ = app.emit("pm-lost", serde_json::json!({ "id": id, "why": e }));
                        break;
                    }
                }
            }
            let spent = t0.elapsed();
            if spent < period {
                std::thread::sleep(period - spent);
            }
        }
        cap.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn pm_stop(state: tauri::State<'_, Arc<Capture>>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    state.window.store(0, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn pm_status(state: tauri::State<'_, Arc<Capture>>) -> serde_json::Value {
    serde_json::json!({
        "running": state.running.load(Ordering::SeqCst),
        "window": state.window.load(Ordering::SeqCst),
    })
}

/// Say something to the agent whose window this is.
///
/// Typed through the clipboard and Ctrl+V rather than character by character,
/// for the reason macOS does the same: the agents worth talking to are Electron
/// apps, and setting a textarea's value directly never reaches React's state —
/// the box shows the text and Enter sends an empty message. A paste is a real
/// user edit.
///
/// The user's clipboard is saved and put back.
#[tauri::command]
pub fn pl_send(app: AppHandle, pid: u32, text: String) -> Result<String, String> {
    let t = text.trim().to_string();
    if t.is_empty() {
        return Err("空的".into());
    }
    // The window belongs to the process that HAS one — an agent CLI is often a
    // child of the app that shows the conversation.
    let target = crate::ui_window_for_pid(pid).ok_or_else(|| "找不到这个 agent 所在的窗口".to_string())?;
    let saved = crate::clipboard_get();
    crate::clipboard_set(&t)?;
    if !crate::activate_window(target) {
        let _ = crate::clipboard_restore(saved);
        return Err("那个窗口没能激活".into());
    }
    std::thread::sleep(Duration::from_millis(220));
    crate::press_ctrl_v();
    std::thread::sleep(Duration::from_millis(260));
    crate::press_enter();
    std::thread::sleep(Duration::from_millis(180));
    let _ = crate::clipboard_restore(saved);
    // Focus back to the particle panel: the target was raised to paste into it,
    // and leaving it in front is not what the user asked for.
    if let Some(win) = app.get_webview_window("particles") {
        let _ = win.set_focus();
    }
    Ok(t)
}
