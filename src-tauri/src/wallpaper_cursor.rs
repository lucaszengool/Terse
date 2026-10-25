//! wallpaper_cursor —— 把鼠标位置喂给壁纸,让粒子跟着指针起水波。
//!
//! 为什么需要 Rust 代打这一下?
//!   壁纸窗口是 `setIgnoresMouseEvents:YES`(点击穿透),DOM 收不到任何 mousemove ——
//!   不代 pump 的话 JS 完全看不到指针在哪。这里在系统这一层拿**全局光标位置**,
//!   每 ~33ms 推一次给 `wallpaper-cursor` 事件,壁纸页面接到后换成平面坐标、调
//!   `_triggerRipple`。桌面图标那张图不受影响。
//!
//! 开关:`wallpaper.json` 里的 `hoverRipple`(默认 **true**);壁纸关着时不轮询。
//! 频率:30 Hz 够平滑,CPU ~ 0.1% —— 比 `start_dash_cursor_poll` 的 40ms 还轻一点,
//! 因为我们只在**动了**(> 1 px)的时候才发事件。
//!
//! `cursor_position()` 是跨平台的,所以这块代码不限 OS。壁纸不开 / 选了不透明引擎时
//! 轮询自己歇着,不会抢功耗。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn start(app: AppHandle) {
    // swap() 返回旧值;已经有一条就别起第二条
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut last = (-9999.0f64, -9999.0f64);
        loop {
            if !RUNNING.load(Ordering::SeqCst) {
                break;
            }
            // 壁纸关着 / 功能关着 → 歇一会儿再看。读磁盘便宜(就 wallpaper.json 一个
            // 小 JSON 文件),不值得给它一个事件通道。
            let cfg = crate::wallpaper_cfg();
            let wall_on = cfg
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let hover_on = cfg
                .get("hoverRipple")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if !wall_on || !hover_on {
                last = (-9999.0, -9999.0); // 回来时让第一次 move 一定能过阈值
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            // cursor_position() 回的是逻辑像素,壁纸窗口也是逻辑像素铺的 (0,0,W,H) ——
            // 所以主屏上两者直接对齐,副屏上 x/y 会落在 [W, …) 外、就让 JS 那边忽略即可。
            if let Ok(p) = app.cursor_position() {
                let dx = p.x - last.0;
                let dy = p.y - last.1;
                // 1 px 门槛:静止不动时一帧都不发。双指针合成不出"假动",但也避免
                // 整条 renderer 为"没动"的事件起反应。
                if dx * dx + dy * dy > 1.0 {
                    let _ = app.emit(
                        "wallpaper-cursor",
                        serde_json::json!({ "x": p.x, "y": p.y }),
                    );
                    last = (p.x, p.y);
                }
            }
            std::thread::sleep(Duration::from_millis(33)); // ~30 Hz
        }
    });
}
