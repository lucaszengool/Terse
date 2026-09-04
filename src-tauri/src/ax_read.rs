//! In-process Accessibility reads.
//!
//! Why this exists instead of shelling out to the `terse-ax` helper:
//! Terse ships UNSIGNED, and macOS grants Accessibility to unsigned code per-binary
//! (path + cdhash). `terse-ax` is a separate process, so it needed its OWN grant —
//! and any rebuild of that helper changed its hash and silently voided it. Users
//! would have hit the same wall on every update, with no error, just nothing
//! happening. Doing the AX calls inside the Terse process means the app's own grant
//! applies, there is nothing extra to approve, and it survives rebuilds.

#![cfg(target_os = "macos")]

use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};

#[allow(non_camel_case_types)]
type pid_t = i32;
type AXUIElementRef = CFTypeRef;
type AXError = i32;
const KAX_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    fn AXUIElementCreateApplication(pid: pid_t) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn CFBooleanGetTypeID() -> usize;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
}

extern "C" {
    static kCFBooleanTrue: CFTypeRef;
}

/// AXError from the most recent Electron-activation attempt (0 = accepted).
pub static LAST_ACTIVATION: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-999);

/// True when THIS process (Terse itself) holds the Accessibility grant.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Ask macOS to show the "grant Accessibility" dialog for Terse.
///
/// Needed because Terse is unsigned: the grant is bound to the binary's hash, so
/// every update silently voids it while the System Settings checkbox still LOOKS
/// enabled. Without a prompt the user has no way to know anything is wrong — the
/// feature just stops. This raises the real system dialog instead.
/// Returns true if already trusted (no dialog shown).
pub fn prompt_for_trust() -> bool {
    unsafe {
        if AXIsProcessTrusted() {
            return true;
        }
        // Build the options dict with the TYPED CFDictionary, which installs
        // kCFTypeDictionaryKeyCallBacks. Hand-rolling CFDictionaryCreate with NULL
        // callbacks made it compare keys by POINTER identity rather than string
        // equality, so AXIsProcessTrustedWithOptions never found the prompt key,
        // got null back, and crashed in CFGetTypeID.
        let key = CFString::new("AXTrustedCheckOptionPrompt");
        let val = CFBoolean::true_value();
        let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const std::ffi::c_void)
    }
}

fn copy_attr(el: AXUIElementRef, attr: &str) -> Option<CFTypeRef> {
    if el.is_null() {
        return None;
    }
    let key = CFString::new(attr);
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out as *mut CFTypeRef)
    };
    if err == KAX_SUCCESS && !out.is_null() {
        Some(out)
    } else {
        None
    }
}

fn as_string(v: CFTypeRef) -> Option<String> {
    if v.is_null() {
        return None;
    }
    unsafe {
        if CFGetTypeID(v) != CFStringGetTypeID() {
            return None;
        }
        let s: CFString = CFString::wrap_under_get_rule(v as CFStringRef);
        Some(s.to_string())
    }
}

/// Recursively collect text from an element tree, depth-limited.
fn walk(el: CFTypeRef, depth: usize, out: &mut Vec<String>, budget: &mut usize) {
    if depth > 18 || *budget == 0 || el.is_null() {
        return;
    }
    if let Some(role_ref) = copy_attr(el, "AXRole") {
        let role = as_string(role_ref).unwrap_or_default();
        unsafe { CFRelease(role_ref) };
        if matches!(
            role.as_str(),
            "AXTextArea" | "AXTextField" | "AXStaticText" | "AXTextView" | "AXWebArea" | "AXButton"
        ) {
            // AXValue holds the text for fields; buttons carry theirs in AXTitle,
            // which is where the app dialog's "Deny 1" / "Allow once 2" live.
            for attr in ["AXValue", "AXTitle"] {
                if let Some(v) = copy_attr(el, attr) {
                    if let Some(s) = as_string(v) {
                        if !s.trim().is_empty() {
                            out.push(s);
                            *budget = budget.saturating_sub(1);
                        }
                    }
                    unsafe { CFRelease(v) };
                }
            }
        }
    }
    if let Some(kids_ref) = copy_attr(el, "AXChildren") {
        unsafe {
            if CFGetTypeID(kids_ref) == CFArrayGetTypeID() {
                let arr = kids_ref as CFArrayRef;
                let n = CFArrayGetCount(arr);
                for i in 0..n {
                    let kid = CFArrayGetValueAtIndex(arr, i) as CFTypeRef;
                    walk(kid, depth + 1, out, budget);
                }
            }
            CFRelease(kids_ref);
        }
    }
}

/// 桌面图标的矩形(屏幕坐标,左上原点)。
///
/// 3D 壁纸要"看鼠标在哪儿"决定这一下算拖画面还是算点文件,所以必须知道图标在哪。
/// Finder 的 AppleScript 在这台机器上问不出来(`position of every item of desktop`
/// 全是 -1,`icon view options` 直接报错),但 AX 树里是齐的:
///   Finder(app) → 第一个 AXScrollArea → 它的第一个孩子 → 每个孩子就是一个图标。
///
/// 拿不到就返回空 —— 调用方据此退回"不接管鼠标",宁可少一个功能,也不能让人点不动
/// 自己的文件。
pub fn desktop_icon_rects(finder_pid: u32) -> Vec<(f64, f64, f64, f64)> {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGPoint { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGSize { width: f64, height: f64 }
    extern "C" {
        fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut std::ffi::c_void) -> bool;
    }
    const KAX_VALUE_CGPOINT: u32 = 1;
    const KAX_VALUE_CGSIZE: u32 = 2;

    let mut out = Vec::new();
    if !is_trusted() { return out; }
    unsafe {
        let app = AXUIElementCreateApplication(finder_pid as pid_t);
        if app.is_null() { return out; }

        /// el 的第 i 个孩子(不持有,调用方别 release)
        unsafe fn children(el: CFTypeRef) -> Option<CFArrayRef> {
            let kids = copy_attr(el, "AXChildren")?;
            if CFGetTypeID(kids) != CFArrayGetTypeID() { CFRelease(kids); return None; }
            Some(kids as CFArrayRef)   // 调用方负责 CFRelease
        }

        let mut scroll: CFTypeRef = std::ptr::null();
        if let Some(kids) = children(app) {
            let n = CFArrayGetCount(kids);
            for i in 0..n {
                let kid = CFArrayGetValueAtIndex(kids, i) as CFTypeRef;
                let role = copy_attr(kid, "AXRole").and_then(|r| { let s = as_string(r); CFRelease(r); s });
                if role.as_deref() == Some("AXScrollArea") { scroll = kid; break; }
            }
            // scroll 是数组里的元素,数组释放后不能再用 —— 先把要的东西读完
            if !scroll.is_null() {
                if let Some(inner) = children(scroll) {
                    if CFArrayGetCount(inner) > 0 {
                        let list = CFArrayGetValueAtIndex(inner, 0) as CFTypeRef;
                        if let Some(icons) = children(list) {
                            let m = CFArrayGetCount(icons).min(400);
                            for j in 0..m {
                                let ic = CFArrayGetValueAtIndex(icons, j) as CFTypeRef;
                                let mut p = CGPoint::default();
                                let mut sz = CGSize::default();
                                let mut got_p = false;
                                let mut got_s = false;
                                if let Some(v) = copy_attr(ic, "AXPosition") {
                                    got_p = AXValueGetValue(v, KAX_VALUE_CGPOINT,
                                                            &mut p as *mut CGPoint as *mut std::ffi::c_void);
                                    CFRelease(v);
                                }
                                if let Some(v) = copy_attr(ic, "AXSize") {
                                    got_s = AXValueGetValue(v, KAX_VALUE_CGSIZE,
                                                            &mut sz as *mut CGSize as *mut std::ffi::c_void);
                                    CFRelease(v);
                                }
                                if got_p && got_s && sz.width > 1.0 && sz.height > 1.0 {
                                    out.push((p.x, p.y, sz.width, sz.height));
                                }
                            }
                            CFRelease(icons as CFTypeRef);
                        }
                    }
                    CFRelease(inner as CFTypeRef);
                }
            }
            CFRelease(kids as CFTypeRef);
        }
        CFRelease(app);
    }
    out
}

/// One window's visible text.
pub struct WindowText {
    pub title: String,
    pub text: String,
}

/// Read every window of `pid`. Returns an empty vec when AX is unavailable.
pub fn window_text(pid: u32, cap_chars: usize) -> Vec<WindowText> {
    let mut out = Vec::new();
    if !is_trusted() {
        return out;
    }
    unsafe {
        let app = AXUIElementCreateApplication(pid as pid_t);
        if app.is_null() {
            return out;
        }
        // Electron/Chromium (Claude, Cursor, VS Code, Windsurf) builds no
        // accessibility tree until an assistive technology asks. These private
        // attributes are the ask; native apps just reject them.
        for k in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            let key = CFString::new(k);
            let err = AXUIElementSetAttributeValue(app, key.as_concrete_TypeRef(), kCFBooleanTrue);
            // Record whether Chromium accepted the request. A non-zero AXError here
            // is the difference between "tree not built yet" and "attribute refused",
            // which need completely different fixes.
            LAST_ACTIVATION.store(err, std::sync::atomic::Ordering::Relaxed);
        }
        let _ = CFBooleanGetTypeID(); // keep the symbol referenced

        if let Some(wins_ref) = copy_attr(app, "AXWindows") {
            if CFGetTypeID(wins_ref) == CFArrayGetTypeID() {
                let arr = wins_ref as CFArrayRef;
                let n = CFArrayGetCount(arr).min(8);
                for i in 0..n {
                    let win = CFArrayGetValueAtIndex(arr, i) as CFTypeRef;
                    let title = copy_attr(win, "AXTitle")
                        .and_then(|t| {
                            let s = as_string(t);
                            CFRelease(t);
                            s
                        })
                        .unwrap_or_default();
                    let mut parts = Vec::new();
                    let mut budget = 4000usize;
                    walk(win, 0, &mut parts, &mut budget);
                    let mut text = parts.join("\n");
                    // Prompts sit at the BOTTOM of a buffer — clip the head, keep the tail.
                    if text.chars().count() > cap_chars {
                        let skip = text.chars().count() - cap_chars;
                        text = text.chars().skip(skip).collect();
                    }
                    out.push(WindowText { title, text });
                }
            }
            CFRelease(wins_ref);
        }
        CFRelease(app);
    }
    out
}
