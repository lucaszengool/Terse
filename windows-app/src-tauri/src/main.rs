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
    }

    terse_lib::run()
}
