#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Handle App Translocation and quarantine BEFORE Tauri initializes.
    // Downloaded DMGs trigger macOS App Translocation (random read-only path)
    // which breaks keychain, file access, and WebView events.
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(bundle) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                let bundle_path = bundle.to_string_lossy().to_string();

                if bundle_path.contains("/AppTranslocation/") {
                    // Auto-install to /Applications and relaunch
                    let dest = "/Applications/Terse.app";
                    let _ = std::process::Command::new("rm").args(["-rf", dest]).output();
                    let ok = std::process::Command::new("cp")
                        .args(["-R", &bundle_path, dest])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if ok {
                        let _ = std::process::Command::new("xattr")
                            .args(["-r", "-d", "com.apple.quarantine", dest])
                            .stderr(std::process::Stdio::null())
                            .output();
                        let _ = std::process::Command::new("open")
                            .args(["-n", dest])
                            .spawn();
                        std::process::exit(0);
                    }
                } else {
                    let _ = std::process::Command::new("xattr")
                        .args(["-r", "-d", "com.apple.quarantine", &*bundle_path])
                        .stderr(std::process::Stdio::null())
                        .output();
                }
            }
        }

        // Ensure HOME is set when launched via Finder
        if std::env::var("HOME").is_err() {
            if let Some(home) = dirs::home_dir() {
                std::env::set_var("HOME", home);
            }
        }
    }

    terse_lib::run()
}
