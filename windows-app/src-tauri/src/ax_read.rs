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
    use windows::core::Interface;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
        TreeScope_Subtree, UIA_TextPatternId,
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
                // A terminal: read what is ON SCREEN from the element that holds
                // the text, and nothing else. See terminal_text for why the
                // window itself cannot be asked.
                if is_terminal_window(h) {
                    let text = terminal_text(&uia, &root, cap_chars);
                    if !text.is_empty() {
                        out.push(WindowText { title, text });
                        continue;
                    }
                }
                let mut text = String::new();
                // A CONSOLE keeps its contents in a text pattern, not in the
                // names of child elements — a terminal window walked the way a
                // dialog is walked reports nothing at all. That matters more
                // here than anywhere else: Claude Code's CLI prompt ("Do you
                // want to proceed?") lives in exactly such a window, and CI
                // caught this reading textlen=0 from a PowerShell window that
                // had the question on screen.
                if let Ok(pat) = root.GetCurrentPattern(UIA_TextPatternId) {
                    if let Ok(tp) = pat.cast::<IUIAutomationTextPattern>() {
                        if let Ok(range) = tp.DocumentRange() {
                            if let Ok(t) = range.GetText(cap_chars as i32) {
                                let t = t.to_string();
                                // Consoles pad every line to the buffer width.
                                for line in t.lines() {
                                    let line = line.trim_end();
                                    if !line.is_empty() {
                                        text.push_str(line);
                                        text.push('\n');
                                    }
                                }
                            }
                        }
                    }
                }
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

/// Is this a terminal's top-level window — classic conhost, or Windows Terminal
/// (the default terminal on Windows 11)?
///
/// Decided by window class, so the dialog path that already works for Electron
/// agents (Claude, Cursor, Code) is left exactly as it was.
fn is_terminal_window(h: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(HWND(h as *mut core::ffi::c_void), &mut buf) };
    let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    matches!(class.as_str(), "ConsoleWindowClass" | "CASCADIA_HOSTING_WINDOW_CLASS")
}

/// The text a terminal is SHOWING, read from the element that holds it.
///
/// Two things had to change from asking the window, and CI showed both. A
/// console window's own element has no text pattern: its tree is a scrollbar,
/// a title bar and a child called "Text Area", and the text pattern is on that
/// child. Asked at the window, a PowerShell window with "Do you want to
/// proceed?" on screen read back as `Vertical / Line up / … / Close / Text
/// Area` — chrome only, so no prompt was ever recognised.
///
/// And the range: DocumentRange starts at the TOP of the scrollback, so the
/// first few thousand characters of a long Claude Code session are its
/// beginning, and the prompt waiting at the bottom is never reached. A blocked
/// prompt is by definition on screen, so the visible ranges are what is read;
/// the document range is only the fallback.
fn terminal_text(
    uia: &windows::Win32::UI::Accessibility::IUIAutomation,
    root: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    cap_chars: usize,
) -> String {
    use windows::core::{Interface, VARIANT};
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTextPattern, TreeScope_Subtree, UIA_IsTextPatternAvailablePropertyId,
        UIA_TextPatternId,
    };
    let mut raw = String::new();
    unsafe {
        let Ok(cond) =
            uia.CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
        else {
            return String::new();
        };
        // Subtree includes the window itself, so a terminal that does put the
        // pattern on its root is still covered.
        let Ok(found) = root.FindAll(TreeScope_Subtree, &cond) else { return String::new() };
        let n = found.Length().unwrap_or(0).min(4);
        for i in 0..n {
            let Ok(el) = found.GetElement(i) else { continue };
            let Ok(pat) = el.GetCurrentPattern(UIA_TextPatternId) else { continue };
            let Ok(tp) = pat.cast::<IUIAutomationTextPattern>() else { continue };
            let before = raw.len();
            if let Ok(ranges) = tp.GetVisibleRanges() {
                for r in 0..ranges.Length().unwrap_or(0) {
                    if let Ok(range) = ranges.GetElement(r) {
                        if let Ok(t) = range.GetText(cap_chars as i32) {
                            raw.push_str(&t.to_string());
                            raw.push('\n');
                        }
                    }
                }
            }
            if raw.len() == before {
                if let Ok(range) = tp.DocumentRange() {
                    if let Ok(t) = range.GetText(cap_chars as i32) {
                        raw.push_str(&t.to_string());
                        raw.push('\n');
                    }
                }
            }
        }
    }
    // Consoles pad every line to the buffer width, and the rows below the
    // cursor are blank.
    let mut text = String::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if !line.is_empty() {
            text.push_str(line);
            text.push('\n');
        }
    }
    text
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
