#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Remove macOS quarantine from the entire app bundle BEFORE Tauri initializes.
    // Downloaded DMGs add quarantine which breaks WebView event delivery.
    // Must run before any WebView is created.
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(bundle) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                let _ = std::process::Command::new("xattr")
                    .args(["-r", "-d", "com.apple.quarantine", &*bundle.to_string_lossy()])
                    .stderr(std::process::Stdio::null())
                    .output();
            }
        }
    }

    terse_lib::run()
}
