//! splash.rs —— 启动画面 (Windows;和 macOS 同一份逻辑)
//!
//! Windows 这边多一件事:主窗口原来在 setup 里无条件 show,启动画面要是不接管
//! 那一句,窗口就会在启动画面还转着的时候先跳出来 —— 两个都在,谁也说不清。
//! 所以那一句交给 finish()(前端喊到 or 8 秒看门狗),和 Mac 走同一条路。
//!
//! 原注释:启动画面:主窗口还在准备的时候,先给人看一块**会动**的东西。
//!
//! 主窗口在 tauri.conf.json 里是 `visible: false`,由这里在"准备好了"的那一刻
//! show 出来;启动画面(`splash.html`)同时关掉。
//!
//! ⚠ **必须有兜底**。把主窗口的可见性交给前端一句 invoke,等于把"app 能不能用"
//!   押在那条脚本链一定会跑完上 —— 而那条链里任何一个文件加载失败、任何一句抛错,
//!   用户看到的就是一块永远转下去的启动图,连窗口都没有,只能强退。
//!   所以这里有一个 8 秒的看门狗:前端没喊到,就自己把窗口亮出来。
//!   宁可让人看到一个还没初始化完的界面,也不能让人看着一块转圈的图干等。
//!
//! ⚠ 两条路进来只生效一次(AtomicBool),否则前端喊到的同时看门狗也到点,
//!   会 show 两次、close 两次 —— close 一个已经关掉的窗口在 Tauri 里是 Err,
//!   不致命,但日志里会多一条看不懂的错。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;

static DONE: AtomicBool = AtomicBool::new(false);

/// 关掉启动画面 + 亮出主窗口。谁先到算谁的,只真正做一次。
pub fn finish(app: &tauri::AppHandle, why: &str) {
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(s) = app.get_webview_window("splash") {
        let _ = s.close();
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.set_focus();
    }
    crate::diag_log("splash", &format!("主窗口已显示({why})"));
}

/// 前端准备好了。index.html 的脚本链跑完会调这个。
#[tauri::command]
pub fn app_ready(app: tauri::AppHandle) {
    finish(&app, "frontend");
}

/// 看门狗:8 秒之后无论如何都把主窗口亮出来。
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        finish(&app, "watchdog 8s");
    });
}
