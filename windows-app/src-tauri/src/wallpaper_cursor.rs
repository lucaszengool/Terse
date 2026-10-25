//! wallpaper_cursor —— the pointer's position for the wallpaper's hover ripple (Windows; macOS: src-tauri's file of the
//! same name).
//!
//! The wallpaper window is click-through, so its page never gets a mousemove. This reads the system cursor ~30 times a
//! second and sends `wallpaper-cursor` {x, y} in the page's own coordinates; the page turns that into a ripple
//! (`_triggerRipple`, wallpaper.html wireHoverRipple). Nothing is sent while the pointer is still (> 1 px moves only),
//! and the loop idles while the wallpaper or `hoverRipple` (wallpaper.json, default on) is off.
//!
//! Windows-specific: the cursor comes back in physical pixels and the wallpaper window covers the whole virtual screen,
//! whose origin can be negative (a monitor to the left of the primary) — so the position is taken relative to the
//! window and divided by its scale factor, which is what the page's CSS pixels are.
//!
//! The older 3D-mode pump in lib.rs sends the same event as a tuple (x, y, 1) for the icon hit-test; the page tells the
//! two apart by shape, as it does on macOS.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut last = (-9999.0f64, -9999.0f64);
        loop {
            let cfg = crate::wallpaper_cfg();
            let wall_on = cfg.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let hover_on = cfg.get("hoverRipple").and_then(|v| v.as_bool()).unwrap_or(true);
            let win = app.get_webview_window("wallpaper");
            let (Some(win), true, true) = (win, wall_on, hover_on) else {
                last = (-9999.0, -9999.0);
                std::thread::sleep(Duration::from_millis(500));
                continue;
            };
            if let (Ok(p), Ok(o)) = (app.cursor_position(), win.outer_position()) {
                let sf = win.scale_factor().unwrap_or(1.0).max(0.1);
                let x = (p.x - o.x as f64) / sf;
                let y = (p.y - o.y as f64) / sf;
                let (dx, dy) = (x - last.0, y - last.1);
                if dx * dx + dy * dy > 1.0 {
                    let _ = app.emit("wallpaper-cursor", serde_json::json!({ "x": x, "y": y }));
                    last = (x, y);
                }
            }
            std::thread::sleep(Duration::from_millis(33));
        }
    });
}
