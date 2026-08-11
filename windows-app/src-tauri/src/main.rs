#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows: ensure USERPROFILE is set (equivalent of macOS HOME check)
    #[cfg(target_os = "windows")]
    {
        if std::env::var("USERPROFILE").is_err() {
            if let Some(home) = dirs::home_dir() {
                std::env::set_var("USERPROFILE", home);
            }
        }

        // The "ghost titlebar" on our frameless transparent windows is not a window
        // style — CI confirmed WS_CAPTION=false, WS_POPUP set, DWM composition on, and
        // the grey bar stayed. It is WebView2 painting its own DefaultBackgroundColor
        // *below* the web content on focus/drag (tauri-apps/tauri#14764, and #14859
        // which was closed as a duplicate of it). Both are open upstream.
        //
        // WebView2 reads this env var when it creates its environment and uses it as
        // DefaultBackgroundColor, so it must be set before the first webview exists —
        // i.e. here, not in setup(). "0" = 0x00000000, alpha 0 → nothing to paint.
        // Setting the property after the fact still flashes the default first, which is
        // why the env var is the documented form of this workaround.
        if std::env::var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR").is_err() {
            std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");
        }
    }

    terse_lib::run()
}
