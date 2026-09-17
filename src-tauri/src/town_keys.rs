//! 代码小镇的键盘接管(macOS)。
//!
//! 小镇是壁纸,而壁纸窗口很难稳稳地拿到键盘:用户点一下桌面,Finder 就把焦点抢回去,
//! 方向键立刻变成"在桌面上选文件"。所以不靠焦点 —— 灵动岛旁边那颗「操控小镇」按钮
//! 开着的时候,在**系统这一层**(CGEventTap)把小镇用的那几个键拦下来,直接交给壁纸;
//! 按钮一关,拦截就停,键盘完全回到 Mac 的默认行为。
//!
//! 只拦这些:WASD、方向键、Q / R(转向)、E(进门)、空格(跳)、Esc(停下)。
//! 带 ⌘ / ⌃ / ⌥ 的组合一律放行(⌘⇧W、⌘Tab、⌘Space 照常用)。Shift 不拦,只顺带
//! 告诉小镇(按住跑)。自动连发的键不转发 —— 小镇自己记着"按住了哪些"。
//!
//! 鼠标也在这一层判断,而且**壁纸始终留在桌面图标后面**(文件照常看得见、点得到):
//! 在**空白桌面**上按下拖动 = 转小镇的视角(这一下不交给 Finder,所以不会拉出框选);
//! 按在文件图标、任何窗口、Dock、菜单栏上 = 原样交给系统。
//!
//! 需要「辅助功能」授权:没授权时 CGEventTapCreate 返回空,这里如实报告,按钮上会
//! 提示去系统设置打开。授权之后下一次打开按钮会重新创建。

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

type CGEventRef = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint { x: f64, y: f64 }
type CFMachPortRef = *mut c_void;
type TapCallback = extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "ApplicationServices", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, cb: TapCallback, user: *mut c_void) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGEventGetDoubleValueField(event: CGEventRef, field: u32) -> f64;
    fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: CFMachPortRef, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

const TAP_SESSION: u32 = 1;          // kCGSessionEventTap
const PLACE_HEAD: u32 = 0;           // kCGHeadInsertEventTap
const OPT_DEFAULT: u32 = 0;          // kCGEventTapOptionDefault(能吞掉事件)
const EV_MOUSE_DOWN: u32 = 1;
const EV_MOUSE_UP: u32 = 2;
const EV_MOUSE_DRAG: u32 = 6;
const FIELD_DELTA_X: u32 = 4;
const FIELD_DELTA_Y: u32 = 5;
const EV_KEY_DOWN: u32 = 10;
const EV_KEY_UP: u32 = 11;
const EV_FLAGS: u32 = 12;
const EV_TAP_OFF_TIMEOUT: u32 = 0xFFFF_FFFE;
const EV_TAP_OFF_USER: u32 = 0xFFFF_FFFF;
const FIELD_AUTOREPEAT: u32 = 8;
const FIELD_KEYCODE: u32 = 9;
const FLAG_SHIFT: u64 = 1 << 17;
const FLAG_CTRL: u64 = 1 << 18;
const FLAG_ALT: u64 = 1 << 19;
const FLAG_CMD: u64 = 1 << 20;

/// 按钮开着 = 拦截生效。
static ON: AtomicBool = AtomicBool::new(false);
static SHIFT: AtomicBool = AtomicBool::new(false);
static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static APP: OnceLock<AppHandle> = OnceLock::new();
/// 正在建 / 已经建好:避免同时起两条线程。建失败了会放回 false,下次再试。
static STARTING: Mutex<bool> = Mutex::new(false);
/// 这一次按下是在空白桌面上 → 接下来的拖动归小镇
static DRAGGING: AtomicBool = AtomicBool::new(false);
static FINDER_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 桌面图标的位置,短时间内缓存(读 AX 树要几毫秒到几十毫秒)
static ICONS: Mutex<(Option<std::time::Instant>, Vec<(f64, f64, f64, f64)>)> = Mutex::new((None, Vec::new()));

fn finder_pid() -> Option<u32> {
    let cached = FINDER_PID.load(Ordering::SeqCst);
    if cached != 0 { return Some(cached); }
    let pid = std::process::Command::new("pgrep").args(["-x", "Finder"]).output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().next()?.parse::<u32>().ok())?;
    FINDER_PID.store(pid, Ordering::SeqCst);
    Some(pid)
}

fn icon_rects() -> Option<Vec<(f64, f64, f64, f64)>> {
    if !crate::ax_read::is_trusted() { return None; }
    let mut g = ICONS.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = g.0.map(|t| t.elapsed() < std::time::Duration::from_millis(1500)).unwrap_or(false);
    if !fresh {
        let pid = finder_pid()?;
        let rects = crate::ax_read::desktop_icon_rects(pid);
        // Finder 重启过:pid 失效,下次重新找
        if rects.is_empty() { FINDER_PID.store(0, Ordering::SeqCst); }
        *g = (Some(std::time::Instant::now()), rects);
    }
    Some(g.1.clone())
}

/// (x, y) 底下有没有任何窗口 —— 普通窗口、Dock 条、菜单栏、Terse 自己的小浮层都算。
/// 桌面层(壁纸、图标那一层)不算。
///
/// ⚠ **铺满整块屏幕的透明浮层不算**:程序坞(Dock)一直挂着一个全屏、层级 20、
/// alpha=1 的窗口(调度中心 / 启动台用的),Terse 自己也有几块全屏透明浮层。
/// 把它们算进去,"空白桌面"就永远不存在 —— 这正是拖动一次都没被接管过的原因(实测)。
/// 普通层(0)的全屏窗口是真的全屏 app,照样算。
fn window_at(x: f64, y: f64) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation_sys::base::CFRelease;
    use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
    use core_foundation_sys::number::{kCFNumberDoubleType, CFNumberGetValue, CFNumberRef};
    #[repr(C)] struct Rect { x: f64, y: f64, w: f64, h: f64 }
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> Rect;
    }
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    const OPTS: u32 = (1 << 0) | (1 << 4);
    unsafe fn num(d: CFDictionaryRef, key: &str) -> Option<f64> {
        let k = CFString::new(key);
        let v = CFDictionaryGetValue(d, k.as_concrete_TypeRef() as *const c_void);
        if v.is_null() { return None; }
        let mut out = 0f64;
        if CFNumberGetValue(v as CFNumberRef, kCFNumberDoubleType, &mut out as *mut f64 as *mut c_void) { Some(out) } else { None }
    }
    unsafe {
        let arr = CGWindowListCopyWindowInfo(OPTS, 0);
        if arr.is_null() { return true; }                 // 不知道 → 当作有窗口,不抢
        let scr = CGDisplayBounds(CGMainDisplayID());
        let me = std::process::id() as f64;
        let mut hit = false;
        for i in 0..CFArrayGetCount(arr) {
            let d = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
            if d.is_null() { continue; }
            if num(d, "kCGWindowLayer").unwrap_or(0.0) < 0.0 { continue; }   // 桌面层
            if num(d, "kCGWindowAlpha").unwrap_or(1.0) <= 0.01 { continue; }
            let k = CFString::new("kCGWindowBounds");
            let b = CFDictionaryGetValue(d, k.as_concrete_TypeRef() as *const c_void) as CFDictionaryRef;
            if b.is_null() { continue; }
            let (bx, by) = (num(b, "X").unwrap_or(0.0), num(b, "Y").unwrap_or(0.0));
            let (bw, bh) = (num(b, "Width").unwrap_or(0.0), num(b, "Height").unwrap_or(0.0));
            let layer = num(d, "kCGWindowLayer").unwrap_or(0.0);
            let owner = num(d, "kCGWindowOwnerPID").unwrap_or(0.0);
            let full = bw >= scr.w * 0.9 && bh >= scr.h * 0.9;
            if full && (layer != 0.0 || owner == me) { continue; }   // 全屏透明浮层
            if x >= bx && x < bx + bw && y >= by && y < by + bh { hit = true; break; }
        }
        CFRelease(arr as *const c_void);
        hit
    }
}

/// 按下的地方是不是**空白桌面**:没有窗口,也不在任何文件图标上。
/// 图标读不出来(没授权)就当作不是 —— 宁可转不了视角,也不能让人点不动文件。
fn on_bare_desktop(x: f64, y: f64) -> bool {
    if window_at(x, y) { return false; }
    let Some(rects) = icon_rects() else { return false };
    !rects.iter().any(|&(rx, ry, rw, rh)| x >= rx - 4.0 && x < rx + rw + 4.0 && y >= ry - 4.0 && y < ry + rh + 4.0)
}

fn send_mouse(kind: &str, dx: f64, dy: f64) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("wallpaper", "town-mouse", serde_json::json!({ "t": kind, "dx": dx, "dy": dy }));
    }
}

/// macOS 虚拟键码 → 小镇认的 KeyboardEvent.key。
fn key_name(code: i64) -> Option<&'static str> {
    Some(match code {
        13 => "w", 0 => "a", 1 => "s", 2 => "d",
        12 => "q", 15 => "r", 14 => "e",
        49 => " ", 53 => "Escape",
        123 => "ArrowLeft", 124 => "ArrowRight", 125 => "ArrowDown", 126 => "ArrowUp",
        _ => return None,
    })
}

fn send(kind: &str, key: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("wallpaper", "town-key", serde_json::json!({ "t": kind, "key": key }));
    }
}

extern "C" fn on_event(_proxy: *mut c_void, etype: u32, ev: CGEventRef, _user: *mut c_void) -> CGEventRef {
    // 系统嫌我们慢/用户输入太密,会把 tap 关掉 —— 立刻重新打开,否则按钮亮着键却没反应
    if etype == EV_TAP_OFF_TIMEOUT || etype == EV_TAP_OFF_USER {
        let tap = TAP.load(Ordering::SeqCst);
        if !tap.is_null() && ON.load(Ordering::SeqCst) { unsafe { CGEventTapEnable(tap, true) }; }
        return ev;
    }
    if !ON.load(Ordering::SeqCst) || ev.is_null() { return ev; }
    unsafe {
        let flags = CGEventGetFlags(ev);
        if etype == EV_FLAGS {
            let shift = flags & FLAG_SHIFT != 0;
            if SHIFT.swap(shift, Ordering::SeqCst) != shift {
                send(if shift { "keydown" } else { "keyup" }, "Shift");
            }
            return ev;                                  // Shift 本身不吞
        }
        match etype {
            EV_MOUSE_DOWN => {
                let p = CGEventGetLocation(ev);
                if flags & (FLAG_CMD | FLAG_CTRL | FLAG_ALT | FLAG_SHIFT) == 0 && on_bare_desktop(p.x, p.y) {
                    DRAGGING.store(true, Ordering::SeqCst);
                    send_mouse("down", 0.0, 0.0);
                    return std::ptr::null_mut();              // 这一下归小镇,Finder 不拉框
                }
                return ev;
            }
            EV_MOUSE_DRAG => {
                if !DRAGGING.load(Ordering::SeqCst) { return ev; }
                send_mouse("drag", CGEventGetDoubleValueField(ev, FIELD_DELTA_X), CGEventGetDoubleValueField(ev, FIELD_DELTA_Y));
                return std::ptr::null_mut();
            }
            EV_MOUSE_UP => {
                if !DRAGGING.swap(false, Ordering::SeqCst) { return ev; }
                send_mouse("up", 0.0, 0.0);
                return std::ptr::null_mut();
            }
            _ => {}
        }
        if etype != EV_KEY_DOWN && etype != EV_KEY_UP { return ev; }
        if flags & (FLAG_CMD | FLAG_CTRL | FLAG_ALT) != 0 { return ev; }   // 快捷键照常
        let Some(name) = key_name(CGEventGetIntegerValueField(ev, FIELD_KEYCODE)) else { return ev };
        let repeat = CGEventGetIntegerValueField(ev, FIELD_AUTOREPEAT) != 0;
        if !repeat { send(if etype == EV_KEY_DOWN { "keydown" } else { "keyup" }, name); }
        std::ptr::null_mut()                            // 吞掉:这个键归小镇
    }
}

/// 起拦截线程(只起一次;上次没建成就再试)。返回 tap 是否可用。
fn ensure_tap() -> bool {
    if !TAP.load(Ordering::SeqCst).is_null() { return true; }
    {
        let mut starting = STARTING.lock().unwrap_or_else(|e| e.into_inner());
        if *starting { drop(starting); return wait_for_tap(); }
        *starting = true;
    }
    std::thread::spawn(|| unsafe {
        let mask: u64 = (1 << EV_KEY_DOWN) | (1 << EV_KEY_UP) | (1 << EV_FLAGS)
            | (1 << EV_MOUSE_DOWN) | (1 << EV_MOUSE_UP) | (1 << EV_MOUSE_DRAG);
        let tap = CGEventTapCreate(TAP_SESSION, PLACE_HEAD, OPT_DEFAULT, mask, on_event, std::ptr::null_mut());
        if tap.is_null() {
            // 没有辅助功能授权。放开 STARTING,下次打开按钮时再试。
            *STARTING.lock().unwrap_or_else(|e| e.into_inner()) = false;
            return;
        }
        let src = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, ON.load(Ordering::SeqCst));
        TAP.store(tap, Ordering::SeqCst);
        CFRunLoopRun();
    });
    wait_for_tap()
}

fn wait_for_tap() -> bool {
    for _ in 0..30 {
        if !TAP.load(Ordering::SeqCst).is_null() { return true; }
        if !*STARTING.lock().unwrap_or_else(|e| e.into_inner()) { return false; }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    !TAP.load(Ordering::SeqCst).is_null()
}

/// 打开 / 关掉键盘接管。返回拦截是否真的在工作(false = 缺辅助功能授权)。
pub fn set_capture(app: &AppHandle, on: bool) -> bool {
    let _ = APP.set(app.clone());
    ON.store(on, Ordering::SeqCst);
    if !on {
        let tap = TAP.load(Ordering::SeqCst);
        if !tap.is_null() { unsafe { CGEventTapEnable(tap, false) }; }
        // 松手时告诉小镇 Shift 已经抬起,免得一直在跑
        if SHIFT.swap(false, Ordering::SeqCst) { send("keyup", "Shift"); }
        if DRAGGING.swap(false, Ordering::SeqCst) { send_mouse("up", 0.0, 0.0); }
        return false;
    }
    let ok = ensure_tap();
    if ok { unsafe { CGEventTapEnable(TAP.load(Ordering::SeqCst), true) }; return true; }
    /* 没有辅助功能授权(Terse 没签名,每装一次新版授权就作废,而系统设置里那个勾看上去
       还是勾着的)。弹系统自己的授权框,然后等:开关还开着、授权一到,自动接上 ——
       不用人再去按一次开关。 */
    crate::ax_read::prompt_for_trust();
    if !WAITING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            for _ in 0..400 {                               // 最多等 10 分钟
                std::thread::sleep(std::time::Duration::from_millis(1500));
                if !ON.load(Ordering::SeqCst) { break; }
                if !crate::ax_read::is_trusted() { continue; }
                if ensure_tap() {
                    unsafe { CGEventTapEnable(TAP.load(Ordering::SeqCst), ON.load(Ordering::SeqCst)) };
                    if let Some(app) = APP.get() {
                        let _ = app.emit("town-control", serde_json::json!({ "on": true, "keys": true, "trusted": true }));
                    }
                    break;
                }
            }
            WAITING.store(false, Ordering::SeqCst);
        });
    }
    false
}

/// 正在等用户去系统设置里授权(只起一条等待线程)
static WAITING: AtomicBool = AtomicBool::new(false);

/// 拦截此刻是否在工作。
pub fn active() -> bool {
    ON.load(Ordering::SeqCst) && !TAP.load(Ordering::SeqCst).is_null()
}
