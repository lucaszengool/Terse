//! 粒子模式 —— 把别的 agent 的窗口,变成桌面上的一团粒子。
//!
//! Claude Desktop、Codex、Cursor 的窗口逐帧抓下来,盖上一层**全透明、鼠标穿透**的
//! 窗口,把那一帧重画成粒子。你看到的是粒子,点下去的却还是它本来那个窗口 ——
//! 焦点、光标、快捷键、输入法,全都还在原来那个 app 手里。
//!
//! **为什么走像素,不走文字。**
//! 这个 app 里已经有一套 AX 读文本的路(capture.rs),但那条路对每个 app 都要单独适配:
//! Electron 的画布读不出来,终端里的 Codex 更是一片黑。而"同一个窗口、同样的信息"这句话,
//! 只有像素做得到 —— 它对任何 app 都成立,包括明天才装上的那个。
//!
//! **为什么抓帧必须留在 app 进程里。**
//! 屏幕录制是**纯 TCC 门禁**:没有任何 entitlement 能打开它,只有用户点"允许"。而一个
//! 被直接 exec 起来的命令行小工具**根本不会弹那个框** —— 它只会安安静静地拿不到画面,
//! 和"功能坏了"长得一模一样。所以这里不派 helper,自己抓。
//!
//! **为什么是 objc2,不是 `screencapturekit` crate。**
//! 那个 crate 拖着 `apple-metal`,而它内含一段 Swift bridge,要比这台机器(SDK 15.0)
//! 更新的 Xcode 才编得过。为了一个我们根本用不到的 Metal 模块让整个 app 编不出来,
//! 不划算。objc2 那一族是纯 Rust 绑定,没有这条尾巴。
//!
//! **为什么是 `SCScreenshotManager`,不是 `SCStream`。**
//! 流要自己声明一个实现 `SCStreamOutput` 协议的 ObjC 类,还要管它的生命周期;而
//! 我们要的只是"每秒十几帧",一个定时器调 `captureImage` 就够了 —— 而且**停得干净**:
//! 线程一停就是真停了,不会留下一个还在录屏的流让菜单栏那个紫点一直亮着。

#![allow(unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_core_foundation::CGRect;
use objc2_core_graphics::CGImage;
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCScreenshotManager, SCStreamConfiguration, SCWindow,
};

/// 抓帧的长边。480 够把一个窗口的骨架说清楚,再大就是白烧带宽 —— 粒子本来就
/// 不是逐像素还原,它是**采样**。
const LONG_EDGE: u32 = 480;
/// JPEG 质量。粒子只取颜色和位置,压缩噪点在采样之后根本看不出来。
const JPEG_Q: u8 = 62;

/// 一个能变成粒子的窗口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentWindow {
    pub id: u32,
    /// app 名(Claude、Codex、Terminal…)
    pub app: String,
    pub bundle: String,
    pub title: String,
    pub pid: i32,
    /// 窗口在桌面上的位置和大小 —— 覆盖层要严丝合缝地盖上去,靠的就是它。
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 是不是我们认得的 agent。认不出来的也列,只是排在后面:
    /// 别替用户决定他想把哪个窗口变成粒子。
    pub known: bool,
}

/// 认得的 agent。匹配 bundle id 的**片段**,不是全等 —— Cursor 有好几个 bundle id,
/// Claude 的桌面版和 CLI 也各叫各的。
const KNOWN: &[(&str, &str)] = &[
    ("claude", "Claude"),
    ("anthropic", "Claude"),
    ("openai", "Codex"),
    ("codex", "Codex"),
    ("cursor", "Cursor"),
    ("visualstudio.code", "VS Code"),
    ("iterm", "iTerm"),
    ("apple.terminal", "Terminal"),
    ("warp", "Warp"),
    ("ghostty", "Ghostty"),
    ("alacritty", "Alacritty"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
];

fn known_label(bundle: &str, app: &str) -> Option<&'static str> {
    let b = bundle.to_ascii_lowercase();
    let a = app.to_ascii_lowercase();
    KNOWN
        .iter()
        .find(|(needle, _)| b.contains(needle) || a.contains(needle))
        .map(|(_, label)| *label)
}

/// `SCShareableContent` 只有回调式的取法,这里把它**等成同步的**。
///
/// 超时是必须的:没给屏幕录制授权的时候,那个回调可能一直不回来,而调用它的是
/// 一条 Tauri 命令 —— 界面会就那么卡死,连"去开权限"都点不了。
fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel::<Result<Retained<SCShareableContent>, String>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        let msg = if content.is_null() {
            let detail = unsafe { err.as_ref() }
                .map(|e| unsafe { e.localizedDescription() }.to_string())
                .unwrap_or_else(|| "no content".into());
            Err(detail)
        } else {
            Ok(unsafe { Retained::retain(content) }.ok_or_else(|| "retain failed".to_string()))
                .and_then(|v| v)
        };
        let _ = tx.send(msg);
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&block) };
    rx.recv_timeout(Duration::from_secs(6))
        .map_err(|_| "screen-recording permission not granted (timed out)".to_string())?
}

/// 从粒子窗口**把一句话发给 agent**。
///
/// 这是"两头都通"里的另一头。读那一头走 agent 自己的 JSONL(agent_monitor 一直在 tail),
/// 写这一头走**已经在跑的那个窗口** —— 不是新起一个进程。
///
/// ⚠ 为什么不 `claude -p --resume <id>` 另开一个:实测这台机器上的登录态是
/// **由桌面宿主注入到子进程环境里的 `CLAUDE_CODE_OAUTH_TOKEN`**,磁盘上没有
/// `.credentials.json`。Terse 自己 spawn 一个 claude 只会得到 "Not logged in"。
/// 而去别的进程环境里捞那个 token 是偷凭据,不是集成。
///
/// 走 AX 这条路反而更对:它把字送进**用户自己那个已经登录、已经在那个会话里**的窗口,
/// 一分钱的额外用量都不产生,也不需要任何 API 凭据。这套机制(clear + paste + Enter,
/// 还带终端的粘贴时序)是优化器早就在用的 `capture::KeyMonitorState`,不是新写的。
#[tauri::command]
pub fn pl_send(app: tauri::AppHandle, pid: u32, text: String) -> Result<String, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("空的".into());
    }
    /* ⚠ 发给**有界面的那个进程**,不是 agent 自己的 pid。
       实测:用户的 Claude Code 是 Claude Desktop 拉起来的子进程(claude → disclaimer →
       Claude.app),`claude` 自己**一个窗口都没有**。拿它的 pid 去激活、去敲键,等于对着
       一个后台进程喊话。所以顺着父进程往上找,找到第一个真正有界面的 app:
       桌面版里跑的是 Claude Desktop,终端里跑的是 Terminal / iTerm。 */
    let ui = ui_owner(pid).ok_or_else(|| "找不到这个 agent 所在的窗口".to_string())?;

    /* 对面的焦点**必须在输入框上**才敲。⌘V 是往当前焦点里贴的 —— 焦点要是停在
       别处,这句话就贴进了别的地方;而 Claude Desktop 同时开着好几段对话,贴错一段
       比没发出去糟糕得多。宁可拒绝,也不能"大概发出去了"。 */
    let role = focused_role(ui).unwrap_or_default();
    if !(role == "AXTextArea" || role == "AXTextField" || role == "AXComboBox") {
        return Err(format!("对面的输入框没有焦点({})—— 先点一下它的输入框再发", if role.is_empty() { "无" } else { &role }));
    }

    /* 走**粘贴**,不走直接改 AXValue。Claude Desktop 是 Electron + React:直接改
       textarea 的值不会触发 input 事件,React 的状态还是空的 —— 框里明明有字,回车
       发出去的却是一条空消息,而且整条链路每一步都会报"成功"。粘贴是真的用户输入,
       React 看得见。

       剪贴板**先存后还**。原来这条路直接覆盖用户的剪贴板,每发一句就吞掉一次人家
       复制的东西 —— 代码里那句"剪贴板由 JS 那边负责存还"是假的,没有任何地方在还。 */
    let saved = clip_get();
    clip_set(t);
    if !activate_pid(ui) {
        restore_clip(saved);
        return Err("那个窗口没能激活".into());
    }
    std::thread::sleep(std::time::Duration::from_millis(220));
    post_key(9, true);    // ⌘V   (kVK_ANSI_V)
    std::thread::sleep(std::time::Duration::from_millis(260));
    post_key(36, false);  // Return
    std::thread::sleep(std::time::Duration::from_millis(180));
    restore_clip(saved);
    /* 把焦点**还给粒子面板**。刚才为了粘贴把对面的 app 提到了前台,不还回来的话,
       人接着打的下一句会直接打进 Claude Desktop 里。前端那句 `hidden.focus()` 做不到
       这件事 —— 网页里 focus 一个元素,不会把整个窗口重新激活。 */
    if let Some(w) = tauri::Manager::get_webview_window(&app, "particles") {
        let _ = w.set_focus();
    }
    Ok(app_name(ui))
}

/// 从 agent 的 pid 往上找第一个"有界面"的进程(NSRunningApplication 的
/// activationPolicy == Regular)。最多走 10 层,到 launchd 就停。
fn ui_owner(pid: u32) -> Option<u32> {
    let mut cur = pid;
    for _ in 0..10 {
        if cur <= 1 {
            return None;
        }
        if is_gui_app(cur) {
            return Some(cur);
        }
        cur = parent_pid(cur)?;
    }
    None
}

fn parent_pid(pid: u32) -> Option<u32> {
    let o = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output().ok()?;
    String::from_utf8_lossy(&o.stdout).trim().parse().ok()
}

fn is_gui_app(pid: u32) -> bool {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let app: id = msg_send![class!(NSRunningApplication),
                                runningApplicationWithProcessIdentifier: pid as i32];
        if app == nil {
            return false;
        }
        let policy: i64 = msg_send![app, activationPolicy];
        policy == 0 // NSApplicationActivationPolicyRegular
    }
}

fn app_name(pid: u32) -> String {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let app: id = msg_send![class!(NSRunningApplication),
                                runningApplicationWithProcessIdentifier: pid as i32];
        if app == nil {
            return String::new();
        }
        let name: id = msg_send![app, localizedName];
        ns_to_string(name)
    }
}

/// 对面那个 app 现在焦点在什么元素上。借 terse-ax 的 read-pid,和优化器同一条路。
fn focused_role(pid: u32) -> Option<String> {
    let o = std::process::Command::new(crate::capture::ax_bin_path())
        .args(["read-pid", &pid.to_string()])
        .output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
    v.get("role").and_then(|r| r.as_str()).map(|s| s.to_string())
}

unsafe fn ns_to_string(s: cocoa::base::id) -> String {
    use objc::{msg_send, sel, sel_impl};
    if s == cocoa::base::nil {
        return String::new();
    }
    let c: *const std::os::raw::c_char = msg_send![s, UTF8String];
    if c.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned()
}

/// 只存**文字**。剪贴板里要是图片或文件,这里保不住 —— 那是已知的边界,不是疏忽。
fn clip_get() -> Option<String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
        let ty = NSString::alloc(nil).init_str("public.utf8-plain-text");
        let s: id = msg_send![pb, stringForType: ty];
        if s == nil { None } else { Some(ns_to_string(s)) }
    }
}

fn clip_set(text: &str) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: i64 = msg_send![pb, clearContents];
        let ty = NSString::alloc(nil).init_str("public.utf8-plain-text");
        let ns = NSString::alloc(nil).init_str(text);
        let _: bool = msg_send![pb, setString: ns forType: ty];
    }
}

fn restore_clip(saved: Option<String>) {
    match saved {
        Some(s) => clip_set(&s),
        None => unsafe {
            use cocoa::base::id;
            use objc::{class, msg_send, sel, sel_impl};
            let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
            let _: i64 = msg_send![pb, clearContents];
        },
    }
}

fn post_key(key: u16, cmd: bool) {
    use objc2_core_graphics::{CGEvent, CGEventFlags, CGEventTapLocation};
    let down = CGEvent::new_keyboard_event(None, key, true);
    let up = CGEvent::new_keyboard_event(None, key, false);
    if cmd {
        CGEvent::set_flags(down.as_deref(), CGEventFlags::MaskCommand);
        CGEvent::set_flags(up.as_deref(), CGEventFlags::MaskCommand);
    }
    CGEvent::post(CGEventTapLocation::HIDEventTap, down.as_deref());
    CGEvent::post(CGEventTapLocation::HIDEventTap, up.as_deref());
}

/// 把某个 pid 的 app 提到前台。
pub fn activate_pid(pid: u32) -> bool {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let app: id = msg_send![class!(NSRunningApplication),
                                runningApplicationWithProcessIdentifier: pid as i32];
        if app == nil {
            return false;
        }
        // NSApplicationActivateIgnoringOtherApps = 1 << 1
        let ok: bool = msg_send![app, activateWithOptions: 2u64];
        ok
    }
}

/// 有没有屏幕录制权限。**不弹框**,只问。
///
/// ⚠ 这个函数存在的理由是实测出来的:光调 ScreenCaptureKit **不会**让系统弹授权框,
/// 它只会立刻返回 `SCStreamErrorUserDeclined`(中文是"用户拒绝了…捕捉的TCC")——
/// 而那句话读起来像"用户点了拒绝",实际上是"这个 app 压根还没被问过"。
/// 想让系统真的问一次,必须显式调 `CGRequestScreenCaptureAccess`。
#[tauri::command]
pub fn pm_has_permission() -> bool {
    unsafe { objc2_core_graphics::CGPreflightScreenCaptureAccess() }
}

/// 请求屏幕录制权限 —— **这一下才会弹框**。
///
/// 系统一个进程只会问一次:答过之后再调就直接返回上次的答案,不会再弹。所以这一下
/// 得挑在人**正打算用这个功能**的时候(点开粒子那一页),而不是开机的时候 ——
/// 开机弹一个没头没脑的录屏授权,多数人只会点"不允许",而那个"不"是记一辈子的。
#[tauri::command]
pub fn pm_request_permission() -> bool {
    unsafe { objc2_core_graphics::CGRequestScreenCaptureAccess() }
}

/// 现在桌面上有哪些窗口可以变成粒子。
///
/// 顺手也是**权限探针**:第一次调用会让系统弹出屏幕录制的授权框。拿不到内容和
/// "一个窗口都没有"必须能被上层分开 —— 混成一句话,人就会对着空列表干瞪眼。
#[tauri::command]
pub fn pm_windows() -> Result<Vec<AgentWindow>, String> {
    // 先问权限再去列窗口。没授权的时候 ScreenCaptureKit 报的是"用户拒绝",
    // 而真相往往是"还没问过" —— 这两句话给用户的下一步完全不同。
    if !pm_has_permission() {
        return Err("NEEDS_PERMISSION".into());
    }
    let content = shareable_content()?;
    let windows = unsafe { content.windows() };
    let mut out: Vec<AgentWindow> = Vec::new();
    for w in windows.iter() {
        unsafe {
            if !w.isOnScreen() {
                continue;
            }
            // 只要**普通窗口层**。菜单栏、Dock、桌面壁纸和我们自己那些浮层都在别的层上,
            // 列出来只会让人从一堆看不懂的条目里找自己的编辑器。
            if w.windowLayer() != 0 {
                continue;
            }
            let f: CGRect = w.frame();
            if f.size.width < 200.0 || f.size.height < 150.0 {
                continue; // 小浮窗、提示条:不是拿来看的东西
            }
            let Some(owner) = w.owningApplication() else { continue };
            let app = owner.applicationName().to_string();
            let bundle = owner.bundleIdentifier().to_string();
            // 不把自己变成粒子 —— 粒子窗口再去抓自己,就是一面对着镜子的镜子。
            if bundle.contains("pruneai") || bundle.contains("terse") {
                continue;
            }
            let label = known_label(&bundle, &app);
            out.push(AgentWindow {
                id: w.windowID(),
                app: label.unwrap_or(&app).to_string(),
                bundle,
                title: w.title().map(|t| t.to_string()).unwrap_or_default(),
                pid: owner.processID(),
                x: f.origin.x,
                y: f.origin.y,
                w: f.size.width,
                h: f.size.height,
                known: label.is_some(),
            });
        }
    }
    // 认得的排前面,其余按窗口从大到小。人来这一页是为了找 Claude,不是为了逛窗口列表。
    out.sort_by(|a, b| {
        b.known.cmp(&a.known).then(
            (b.w * b.h)
                .partial_cmp(&(a.w * a.h))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    Ok(out)
}

/// 那个窗口现在在哪儿 —— 覆盖层隔一会儿问一次,好跟着它走。
#[tauri::command]
pub fn pm_window_rect(id: u32) -> Option<(f64, f64, f64, f64)> {
    let content = shareable_content().ok()?;
    let windows = unsafe { content.windows() };
    for w in windows.iter() {
        unsafe {
            if w.windowID() == id {
                let f = w.frame();
                return Some((f.origin.x, f.origin.y, f.size.width, f.size.height));
            }
        }
    }
    None
}

/// 按窗口 id 找到那个 `SCWindow`。窗口会关,所以每一帧都要重新找 —— 抓着一个
/// 已经没了的窗口不放,只会拿到一片黑,而不是一个错误。
fn find_window(id: u32) -> Result<Retained<SCWindow>, String> {
    let content = shareable_content()?;
    let windows = unsafe { content.windows() };
    for w in windows.iter() {
        if unsafe { w.windowID() } == id {
            return Ok(w);
        }
    }
    Err("那个窗口已经不在了".into())
}

/// 抓一帧,直接编成 JPEG。
fn grab_jpeg(window: &SCWindow) -> Result<(Vec<u8>, u32, u32), String> {
    let f = unsafe { window.frame() };
    let (sw, sh) = (f.size.width.max(1.0), f.size.height.max(1.0));
    let scale = (LONG_EDGE as f64 / sw.max(sh)).min(1.0);
    let dw = ((sw * scale) as u32).max(1);
    let dh = ((sh * scale) as u32).max(1);

    let filter = unsafe {
        SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), window)
    };
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        // 缩放交给 ScreenCaptureKit 自己做:它在 GPU 上缩,比我们把整帧搬回内存再缩快得多。
        config.setWidth(dw as usize);
        config.setHeight(dh as usize);
        config.setShowsCursor(false);
        // 窗口自己的阴影会在粒子里变成一圈脏边 —— 这一层要的是内容,不是外框。
        config.setIgnoreShadowsSingleWindow(true);
    }

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let block = RcBlock::new(move |img: *mut CGImage, err: *mut NSError| {
        if img.is_null() {
            let detail = unsafe { err.as_ref() }
                .map(|e| unsafe { e.localizedDescription() }.to_string())
                .unwrap_or_else(|| "no image".into());
            let _ = tx.send(Err(detail));
            return;
        }
        let _ = tx.send(cgimage_to_jpeg(unsafe { &*img }));
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            Some(&block),
        );
    }
    let jpg = rx
        .recv_timeout(Duration::from_secs(4))
        .map_err(|_| "capture timed out".to_string())??;
    Ok((jpg, dw, dh))
}

/// CGImage → JPEG。
///
/// 走一次 `CGBitmapContext`,而不是去读原图的 data provider:图有可能是任何一种像素
/// 排布(BGRA、YUV、带 padding 的 stride),而画进一个我们自己开的 context,
/// 出来的一定是我们指定的那一种。少一层猜,就少一整类"颜色是乱的"的 bug。
fn cgimage_to_jpeg(img: &CGImage) -> Result<Vec<u8>, String> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextGetData, CGBitmapInfo, CGColorSpaceCreateDeviceRGB,
        CGContextDrawImage, CGImageAlphaInfo, CGImageGetHeight, CGImageGetWidth,
    };
    let w = unsafe { CGImageGetWidth(Some(img)) };
    let h = unsafe { CGImageGetHeight(Some(img)) };
    if w == 0 || h == 0 {
        return Err("empty frame".into());
    }
    let stride = w * 4;
    let mut buf = vec![0u8; stride * h];
    let cs = unsafe { CGColorSpaceCreateDeviceRGB() }.ok_or("no colorspace")?;
    let ctx = unsafe {
        CGBitmapContextCreate(
            buf.as_mut_ptr().cast(),
            w,
            h,
            8,
            stride,
            Some(&cs),
            CGBitmapInfo::ByteOrder32Big.0 | CGImageAlphaInfo::PremultipliedLast.0 as u32,
        )
    }
    .ok_or("bitmap context")?;
    unsafe {
        CGContextDrawImage(
            Some(&ctx),
            CGRect {
                origin: objc2_core_foundation::CGPoint { x: 0.0, y: 0.0 },
                size: objc2_core_foundation::CGSize {
                    width: w as f64,
                    height: h as f64,
                },
            },
            Some(img),
        );
    }
    // context 画完之后 buf 才是有内容的;CGBitmapContextGetData 只是确认它用的就是这块内存
    let _ = unsafe { CGBitmapContextGetData(Some(&ctx)) };

    let mut rgb = vec![0u8; w * h * 3];
    for i in 0..(w * h) {
        rgb[i * 3] = buf[i * 4];
        rgb[i * 3 + 1] = buf[i * 4 + 1];
        rgb[i * 3 + 2] = buf[i * 4 + 2];
    }
    let mut out = Vec::with_capacity(w * h / 8);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_Q);
    enc.encode(&rgb, w as u32, h as u32, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 正在跑的那一路抓帧。同一时刻只留一路 —— 两个粒子窗口各抓各的,等于把一台
/// 笔记本的风扇拉满去画两团光。
#[derive(Default)]
pub struct Capture {
    running: AtomicBool,
    window: AtomicU32,
}

/// 开始把这个窗口抓成粒子。
#[tauri::command]
pub fn pm_start(
    app: AppHandle,
    state: tauri::State<'_, Arc<Capture>>,
    id: u32,
    fps: Option<u32>,
) -> Result<(), String> {
    // 先探一帧再开线程。开得起来才叫开始 —— 否则界面显示"已开启",屏幕上却什么都没有,
    // 而真正的原因(没授权/窗口没了)被咽在一个后台线程里。
    let w = find_window(id)?;
    grab_jpeg(&w)?;

    state.running.store(false, Ordering::SeqCst); // 停掉上一路
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
            match find_window(id).and_then(|w| grab_jpeg(&w)) {
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
                    // 窗口被最小化、被关掉、或者临时抓不到。连着几次都不行才收工,
                    // 一次失败就退出的话,拖动窗口的那一瞬间粒子就没了。
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

/// 收工。**一定要真的停** —— 录屏不停,菜单栏那个紫点就一直亮着,而用户看到的是
/// "我明明关了,它还在录我的屏"。
#[tauri::command]
pub fn pm_stop(state: tauri::State<'_, Arc<Capture>>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    state.window.store(0, Ordering::SeqCst);
    Ok(())
}

/// 现在在抓吗、抓的哪个。
#[tauri::command]
pub fn pm_status(state: tauri::State<'_, Arc<Capture>>) -> serde_json::Value {
    serde_json::json!({
        "running": state.running.load(Ordering::SeqCst),
        "window": state.window.load(Ordering::SeqCst),
    })
}

/// 自检:开机时跑一遍完整的抓帧链路,把结果写进 `~/.terse/particles.log`,
/// 并且把**真的抓到的那一帧**存成 `/tmp/pm_selftest.jpg`。
///
/// 为什么需要它:屏幕录制的授权记在**系统那张 root 才读得到的 TCC 库**里,所以
/// `cargo test` 在开发机上永远跑不通这条路 —— 它只会报"用户拒绝"。而 `screencapture`
/// 能用不算数:那是苹果自己签的、带私有 TCC 豁免的命令,和我们这个未签名的 app
/// 走的根本不是同一条判定。**只有 app 自己跑出来的结果才作数。**
///
/// 只在 `~/.terse/pm-probe` 这个标记文件存在时才跑,跑完就把标记删掉 —— 普通用户
/// 一次都不会碰到它,更不会因为它在开机时被弹一个莫名其妙的录屏授权框。
pub fn selftest() {
    let home = dirs::home_dir().unwrap_or_default();
    let marker = home.join(".terse").join("pm-probe");
    if !marker.exists() {
        return;
    }
    let _ = std::fs::remove_file(&marker);

    /* ⚠ 请求**必须在主线程上发**。
       TCC 的授权框是一块要画到屏幕上的 UI,而 AppKit 只在主线程上画东西。从后台线程调
       `CGRequestScreenCaptureAccess`,它不会报错、也不会弹框,只会立刻返回 false ——
       又是一次"安静地什么都没发生"。第一版就是这么写的,实测三次都没有框。 */
    let pre = pm_has_permission();
    let requested = if pre { true } else { pm_request_permission() };

    std::thread::spawn(move || {
        let mut log = String::new();
        log.push_str(&format!("preflight={pre}\nrequested={requested} (main thread)\n"));
        if !pre {
            std::thread::sleep(std::time::Duration::from_secs(20));
            log.push_str(&format!("after_prompt_preflight={}\n", pm_has_permission()));
        }
        match pm_windows() {
            Err(e) => log.push_str(&format!("WINDOWS ERR {e}\n")),
            Ok(ws) => {
                log.push_str(&format!("WINDOWS {} found\n", ws.len()));
                for w in ws.iter().take(10) {
                    log.push_str(&format!(
                        "  [{}] {:<10} {:>5.0}x{:<5.0} known={} {}\n",
                        w.id, w.app, w.w, w.h, w.known,
                        w.title.chars().take(46).collect::<String>()
                    ));
                }
                // 抓一帧真的画面 —— 这才是"能用"的唯一证据
                if let Some(t) = ws.iter().find(|w| w.known).or_else(|| ws.first()) {
                    match find_window(t.id).and_then(|w| grab_jpeg(&w)) {
                        Ok((jpg, dw, dh)) => {
                            log.push_str(&format!(
                                "GRAB ok id={} {}x{} {} bytes -> /tmp/pm_selftest.jpg\n",
                                t.id, dw, dh, jpg.len()
                            ));
                            let _ = std::fs::write("/tmp/pm_selftest.jpg", &jpg);
                        }
                        Err(e) => log.push_str(&format!("GRAB ERR {e}\n")),
                    }
                }
            }
        }
        let path = home.join(".terse").join("particles.log");
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new("/")));
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "--- selftest {t} ---\n{log}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 从已知的 RGB 像素造一张 CGImage,走一遍 `cgimage_to_jpeg`,再把 JPEG 解回来对颜色。
    ///
    /// 这条测试**刻意不碰屏幕录制**。抓帧要 TCC 授权,而授权在系统那张只有 root 读得了的
    /// 库里 —— 也就是说"抓不到画面"这条路在开发机上根本跑不起来。但真正容易错的从来
    /// 不是权限,是**通道顺序和上下颠倒**:BGRA 当成 RGBA 画出来是蓝脸,CGContext 的
    /// 原点在左下、位图在左上,画反了整幅是倒的。把这一段和权限拆开,它就能被测。
    #[test]
    fn jpeg_roundtrip_keeps_channels_and_orientation() {
        use objc2_core_graphics::{
            CGColorSpaceCreateDeviceRGB, CGDataProviderCreateWithData, CGImageAlphaInfo,
            CGImageCreate, CGBitmapInfo,
        };
        const W: usize = 8;
        const H: usize = 8;
        // 上半红、下半蓝 —— 颠倒了立刻看得出来;左右各留一列绿,通道错了也逃不掉。
        let mut rgba = vec![0u8; W * H * 4];
        for y in 0..H {
            for x in 0..W {
                let i = (y * W + x) * 4;
                let (r, g, b) = if x == 0 { (0, 255, 0) }
                    else if y < H / 2 { (255, 0, 0) } else { (0, 0, 255) };
                rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
            }
        }
        let img = unsafe {
            let provider = CGDataProviderCreateWithData(
                std::ptr::null_mut(),
                rgba.as_ptr().cast(),
                rgba.len(),
                None,
            ).expect("data provider");
            let cs = CGColorSpaceCreateDeviceRGB().expect("colorspace");
            CGImageCreate(
                W, H, 8, 32, W * 4, Some(&cs),
                CGBitmapInfo(CGImageAlphaInfo::PremultipliedLast.0 as u32),
                Some(&provider), std::ptr::null(), false,
                objc2_core_graphics::CGColorRenderingIntent::RenderingIntentDefault,
            ).expect("cgimage")
        };

        let jpg = cgimage_to_jpeg(&img).expect("encode");
        assert!(jpg.len() > 100, "JPEG 太小,多半根本没画上去");

        let decoded = image::load_from_memory(&jpg).expect("decode").to_rgb8();
        assert_eq!(decoded.dimensions(), (W as u32, H as u32));
        let px = |x: u32, y: u32| { let p = decoded.get_pixel(x, y).0; (p[0] as i32, p[1] as i32, p[2] as i32) };
        let top = px(4, 1);
        let bottom = px(4, 6);
        // JPEG 是有损的,所以比的是"哪个通道占优",不是精确值
        assert!(top.0 > 150 && top.2 < 90, "上半该是红的,拿到 {top:?} —— 多半上下颠倒或通道错位");
        assert!(bottom.2 > 150 && bottom.0 < 90, "下半该是蓝的,拿到 {bottom:?}");
        let left = px(0, 3);
        assert!(left.1 > 130 && left.0 < 110, "最左那一列该是绿的,拿到 {left:?}");
    }

    /// 认得的 agent 要按 bundle id 的片段命中,而不是全等。
    #[test]
    fn known_agents_match_on_fragments() {
        assert_eq!(known_label("com.anthropic.claudefordesktop", "Claude"), Some("Claude"));
        assert_eq!(known_label("com.todesktop.230313mzl4w4u92", "Cursor"), Some("Cursor"));
        assert_eq!(known_label("com.apple.Terminal", "Terminal"), Some("Terminal"));
        // 不认得的不能瞎猜成 agent —— 列出来可以,但别排到前面去
        assert_eq!(known_label("com.apple.finder", "Finder"), None);
    }
}
