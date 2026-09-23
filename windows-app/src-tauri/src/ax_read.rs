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
pub struct WindowText {
    pub title: String,
    pub text: String,
}

/// Everything readable in each of this process's windows.
///
/// macOS walks the Accessibility tree for this and needs the grant that goes
/// with it. Windows publishes the same thing through UI Automation, which any
/// desktop app may read — so approval prompts are detected here without asking
/// the user for anything.
///
/// Bounded per window: a browser's tree is enormous, this runs every 1.5 s, and
/// the prompt being looked for is always near the top of a dialog.
pub fn window_text(pid: u32, cap_chars: usize) -> Vec<WindowText> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, TreeScope_Subtree,
    };
    let mut out: Vec<WindowText> = Vec::new();
    let hwnds = windows_of_pid(pid);
    if hwnds.is_empty() {
        return out;
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            for h in hwnds {
                let t0 = std::time::Instant::now();
                let Ok(root): Result<IUIAutomationElement, _> =
                    uia.ElementFromHandle(HWND(h as *mut core::ffi::c_void))
                else {
                    continue;
                };
                let title = root.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                let mut text = String::new();
                if let Ok(cond) = uia.CreateTrueCondition() {
                    if let Ok(all) = root.FindAll(TreeScope_Subtree, &cond) {
                        let n = all.Length().unwrap_or(0);
                        for i in 0..n {
                            if text.len() >= cap_chars || t0.elapsed().as_millis() > 400 {
                                break;
                            }
                            let Ok(el) = all.GetElement(i) else { continue };
                            let Ok(name) = el.CurrentName() else { continue };
                            let name = name.to_string();
                            let line = name.trim();
                            if line.is_empty() {
                                continue;
                            }
                            // The same line repeated is a list of identical
                            // controls, not more information.
                            if !text.ends_with(line) {
                                text.push_str(line);
                                text.push('\n');
                            }
                        }
                    }
                }
                out.push(WindowText { title, text });
            }
        }
        CoUninitialize();
    }
    out
}

/// The visible top-level windows belonging to a process.
fn windows_of_pid(pid: u32) -> Vec<isize> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };
    struct Acc {
        want: u32,
        out: Vec<isize>,
    }
    unsafe extern "system" fn scan(h: HWND, lp: LPARAM) -> BOOL {
        let a = &mut *(lp.0 as *mut Acc);
        let mut p = 0u32;
        GetWindowThreadProcessId(h, Some(&mut p));
        if p == a.want && IsWindowVisible(h).as_bool() && a.out.len() < 8 {
            a.out.push(h.0 as isize);
        }
        TRUE
    }
    let mut a = Acc { want: pid, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(scan), LPARAM(&mut a as *mut Acc as isize));
    }
    a.out
}

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
