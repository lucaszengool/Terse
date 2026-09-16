//! The Windows stand-in for macOS's ax_read.
//!
//! macOS reads window titles through the Accessibility API, which needs a grant
//! the user must give and can revoke — hence is_trusted / prompt_for_trust, and
//! the "turn it on" card the feed shows when it is missing.
//!
//! Windows needs no grant to read the titles of top-level windows: EnumWindows
//! and GetWindowTextW are available to any process in the session. So the two
//! permission calls answer yes, honestly rather than as a stub — there is
//! nothing to ask for — and the feed's permission card simply never appears.
//!
//! Only the pieces feeds.rs uses are here. The name and signatures match the
//! macOS module so the call sites are identical on both sides.

/// Windows has no Accessibility grant to hold, so this is always true.
pub fn is_trusted() -> bool {
    true
}

/// Nothing to prompt for; already permitted.
pub fn prompt_for_trust() -> bool {
    true
}

/// The titles of one process's on-screen windows, newest-first order as the
/// window manager reports them, at most `max`.
///
/// Cloaked windows are skipped: a minimised store app or a window on another
/// virtual desktop still reports visible and keeps a stale title, and the feed
/// would announce a page the user closed an hour ago. Tool windows are skipped
/// for the same reason the window census skips them — palettes and tray
/// helpers are not what a person means by "my windows".
pub fn window_titles(pid: u32, max: usize) -> Vec<String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    struct Want {
        pid: u32,
        max: usize,
        out: Vec<String>,
    }

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let w = &mut *(lparam.0 as *mut Want);
        if w.out.len() >= w.max {
            return TRUE;
        }
        let mut owner: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut owner));
        if owner != w.pid || !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & (WS_EX_TOOLWINDOW.0 as isize) != 0 {
            return TRUE;
        }
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return TRUE;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n > 0 {
            let t = String::from_utf16_lossy(&buf[..n as usize]);
            if !t.trim().is_empty() {
                w.out.push(t);
            }
        }
        TRUE
    }

    let mut want = Want { pid, max, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut want as *mut Want as isize));
    }
    want.out
}
