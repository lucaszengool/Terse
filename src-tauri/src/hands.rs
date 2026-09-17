//! hands.rs —— 手势控制(Pro)的数据源。
//!
//! 起一个 `terse-hands`(Swift + Apple Vision,src/helpers/terse-hands.swift),它每识别完一帧
//! 就往 stdout 写一行 JSON;这里原样转发成 `hand-frame` 事件,**所有窗口共用一个摄像头、
//! 一个识别器**(会话栏、壁纸、手势预览各自订阅)。Rust 不解析每帧 —— 30fps × 所有窗口,
//! 解析再序列化是白花的功夫,网页那边的 gesture-core.js 自己 JSON.parse。
//!
//! 为什么不在网页里用 MediaPipe:wry 在 macOS 上没实现 WKWebView 的摄像头授权
//! (tauri-apps/wry#1195 未解决),getUserMedia 靠不住;被遮住的 WKWebView 还会被节流,
//! 追踪帧率掉到个位数。原生 Vision 两个问题都没有,而且省电。
//!
//! 摄像头权限记在 Terse.app 头上(子进程由它负责),所以 Info.plist 里必须有
//! NSCameraUsageDescription,否则系统直接杀掉进程。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
struct Hands {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    status: String,
    fps: f64,
    ms: f64,
}

static HANDS: LazyLock<Mutex<Hands>> = LazyLock::new(|| Mutex::new(Hands::default()));

/// 和 terse-ax 一样:先找打进 .app 的那份,再找仓库里的开发版
fn bin_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            for rel in ["Resources/terse-hands", "Resources/helpers/terse-hands"] {
                let p = contents.join(rel);
                if p.exists() {
                    return p;
                }
            }
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/helpers/terse-hands"))
}

fn running(h: &mut Hands) -> bool {
    match h.child.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    }
}

/// 订阅**原始** hand-frame 的窗口只剩两个:光标层(全屏唯一一个算手势的地方,算好后用
/// gesture-evt 分发给会话栏 / 壁纸 / 粒子模式)和主界面(手势页预览自己画骨架)。
const HAND_WINDOWS: [&str; 2] = ["main", "desk-overlay"];

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse/gesture.json")
}

/// 手势控制开着没有(全局开关,不是预览)。存在 ~/.terse/gesture.json,开机时读。
pub fn enabled() -> bool {
    std::fs::read_to_string(config_path()).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("enabled").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// 开机:开着手势控制、而且还是 Pro → 自己起追踪。订阅过期了就不起(摄像头灯不会莫名亮着)。
pub fn autostart(app: AppHandle) {
    // 摄像头权限不是"已允许"就不自己起:未签名的新 build 旧权限对不上,起了也只会被静默拒绝。
    // 留到用户打开「手势」页时,由 hands_camera_request 走一遍"查 → 请求"
    if enabled() && crate::license::License::load().is_pro() {
        let cam = camera_status_raw();
        eprintln!("[hands] autostart: camera {cam}");
        if cam == "authorized" {
            // 光标层是全屏唯一算手势、画粒子手的地方 —— 手势开着就得有它
            let _ = crate::desk::show_overlay(&app);
            let _ = hands_start(app);
        } else {
            let _ = app.emit("hand-status", &json!({ "status": "needs-permission" }));
        }
    }
}

fn parse_camera(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout).lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|v| v.get("camera").and_then(|c| c.as_str()).map(|s| s.to_string()))
}

/// 摄像头权限**在 Terse 主进程里**查和请求(AVCaptureDevice),不再让 terse-hands 子进程去问。
///
/// 实测(2026-09-11 12:42):子进程 `terse-hands --request` 连着问了三次、中间还 tccutil 清过
/// 一次记录,系统一次框都没弹、TCC.db 里也没留下任何记录 —— 由子进程代问这条路不可靠。
/// Apple 的标准做法是 **app 自己**请求:系统一定用 Terse 的名字和 NSCameraUsageDescription
/// 弹框;授权记在 com.pruneai.app 名下,之后 terse-hands 作为 Terse 的子进程沿用这个授权。
#[cfg(target_os = "macos")]
mod av {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use std::time::Duration;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    fn device_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    /// AVAuthorizationStatus:0 notDetermined / 1 restricted / 2 denied / 3 authorized
    pub fn status() -> String {
        let Some(cls) = device_class() else { return "unknown".into() };
        let media = NSString::from_str("vide"); // AVMediaTypeVideo
        let s: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
        match s { 0 => "notDetermined", 1 => "restricted", 2 => "denied", 3 => "authorized", _ => "unknown" }.into()
    }

    /// 弹系统权限框,等用户回答(回调在任意线程来,这里用通道等成同步的,带超时 ——
    /// 调它的是一条 Tauri 命令,不能让界面永远等下去)
    pub fn request(timeout: Duration) -> String {
        let Some(cls) = device_class() else { return "error".into() };
        let media = NSString::from_str("vide");
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let block = RcBlock::new(move |granted: Bool| { let _ = tx.send(granted.as_bool()); });
        unsafe { let _: () = msg_send![cls, requestAccessForMediaType: &*media, completionHandler: &*block]; }
        match rx.recv_timeout(timeout) {
            Ok(true) => "authorized".into(),
            Ok(false) => "denied".into(),
            Err(_) => "timeout".into(),
        }
    }
}

fn camera_status_raw() -> String {
    #[cfg(target_os = "macos")]
    { av::status() }
    #[cfg(not(target_os = "macos"))]
    { "unknown".into() }
}

/// 摄像头权限现在是什么状态(不弹框):authorized / notDetermined / denied / restricted
#[tauri::command(async)]
pub fn hands_camera_status() -> String {
    camera_status_raw()
}

/// 请求摄像头权限(弹系统框,等用户回答,最多 2 分钟)。
/// reset=true:先清掉 **Terse 自己的**摄像头记录再请求。未签名的 build 每次签名都变,
/// TCC 里旧的记录对不上新程序,会不弹框直接拒;清掉之后系统才会重新问。
/// 只清我们自己的 bundle id,不碰别的应用。
#[tauri::command(async)]
pub fn hands_camera_request(reset: bool) -> String {
    if reset {
        for id in ["com.pruneai.app", "com.pruneai.app.hands"] {
            let r = Command::new("/usr/bin/tccutil").args(["reset", "Camera", id]).output();
            eprintln!("[hands] tccutil reset Camera {id}: {:?}", r.map(|o| o.status.code()));
        }
    }
    eprintln!("[hands] camera request (reset={reset}) — status before: {}", camera_status_raw());
    #[cfg(target_os = "macos")]
    let r = av::request(std::time::Duration::from_secs(120));
    #[cfg(not(target_os = "macos"))]
    let r: String = "unsupported".into();
    eprintln!("[hands] camera request (reset={reset}) -> {r}");
    r
}

/// 打开「系统设置 → 隐私与安全性 → 摄像头」
#[tauri::command(async)]
pub fn hands_open_camera_settings() {
    let _ = Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera").status();
}

#[tauri::command(async)]
pub fn hands_get_enabled() -> bool {
    enabled()
}

/// 主界面「手势控制」页的开关:存下来,并立刻开 / 关追踪
#[tauri::command(async)]
pub fn hands_set_enabled(app: AppHandle, on: bool) -> Result<String, String> {
    if on && !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    if let Some(dir) = config_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(config_path(), json!({ "enabled": on }).to_string()).map_err(|e| e.to_string())?;
    let _ = app.emit("hand-enabled", on);
    if on {
        crate::desk::show_overlay(&app)?;   // 粒子手 + 统一的光标
        hands_start(app)
    } else {
        hands_stop();
        crate::desk::hide_overlay(&app);
        Ok("stopped".into())
    }
}

/// 开始追踪(手势功能打开 / 手势预览打开时调用)。已经在跑就什么也不做。
/// Pro 功能:这里再查一次许可 —— 前端的闸门可以被绕过,摄像头这一步不行。
#[tauri::command(async)]
pub fn hands_start(app: AppHandle) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("手势控制目前只支持 macOS".into());
    }
    if !crate::license::License::load().is_pro() {
        return Err("pro".into());
    }
    let mut h = HANDS.lock().map_err(|e| e.to_string())?;
    if running(&mut h) {
        return Ok(h.status.clone());
    }
    let bin = bin_path();
    if !bin.exists() {
        return Err(format!("找不到 terse-hands:{}", bin.display()));
    }
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // 识别器自己的报错直接进 terse 的 stderr —— 第一版丢到 null,摄像头出问题时什么都看不到
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| { eprintln!("[hands] spawn failed: {e}"); e.to_string() })?;
    eprintln!("[hands] started {}", bin.display());
    let stdout = child.stdout.take().ok_or("no stdout")?;
    h.stdin = child.stdin.take();
    h.child = Some(child);
    h.status = "starting".into();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with("{\"t\"") {
                // 只发给真正用手势的窗口。广播(emit)会把每秒 30 帧送进 Terse 的**每一个**
                // webview(农场、宠物、体检、岛……十几个),每个 WebContent 进程每秒被唤醒 30 次
                let _ = app.emit_filter("hand-frame", &line, |t| matches!(t,
                    tauri::EventTarget::WebviewWindow { label } | tauri::EventTarget::Webview { label } | tauri::EventTarget::Window { label }
                        if HAND_WINDOWS.contains(&label.as_str())));
            } else if let Ok(v) = serde_json::from_str::<Value>(&line) {
                // 状态行(running / denied / no-camera / fps)写进日志,手部帧不写(每秒 30 行)
                eprintln!("[hands] {line}");
                if let Ok(mut h) = HANDS.lock() {
                    if let Some(s) = v.get("status").and_then(|s| s.as_str()) {
                        h.status = s.to_string();
                    }
                    if let Some(f) = v.get("fps").and_then(|f| f.as_f64()) {
                        h.fps = f;
                        h.ms = v.get("ms").and_then(|m| m.as_f64()).unwrap_or(0.0);
                    }
                }
                let _ = app.emit("hand-status", &v);
            }
        }
        // 进程退出(被停掉、没有权限、没有摄像头)
        if let Ok(mut h) = HANDS.lock() {
            if h.status == "running" || h.status == "starting" || h.status == "paused" {
                h.status = "stopped".into();
            }
            h.child = None;
            h.stdin = None;
            let _ = app.emit("hand-status", &json!({ "status": h.status }));
        }
    });
    Ok("starting".into())
}

/// 停止追踪,释放摄像头(摄像头灯会灭)
#[tauri::command(async)]
pub fn hands_stop() {
    if let Ok(mut h) = HANDS.lock() {
        if let Some(stdin) = h.stdin.as_mut() {
            let _ = stdin.write_all(b"quit\n");
        }
        h.stdin = None;
        if let Some(mut c) = h.child.take() {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = c.kill();
                let _ = c.wait();
            });
        }
        h.status = "stopped".into();
    }
}

#[tauri::command(async)]
pub fn hands_status() -> Value {
    match HANDS.lock() {
        Ok(mut h) => {
            let r = running(&mut h);
            json!({ "running": r, "status": if r { h.status.clone() } else { "stopped".to_string() }, "fps": h.fps, "ms": h.ms })
        }
        Err(_) => json!({ "running": false, "status": "stopped" }),
    }
}
