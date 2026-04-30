fn main() {
    // Force Cargo to re-run build script when frontend files change
    println!("cargo:rerun-if-changed=../../src/renderer/popup.js");
    println!("cargo:rerun-if-changed=../../src/renderer/popup.css");
    println!("cargo:rerun-if-changed=../../src/renderer/popup.html");
    println!("cargo:rerun-if-changed=../../src/renderer/app.js");
    println!("cargo:rerun-if-changed=../../src/renderer/index.html");
    println!("cargo:rerun-if-changed=../../src/renderer/styles.css");
    println!("cargo:rerun-if-changed=../../src/renderer/tauri-bridge.js");
    println!("cargo:rerun-if-changed=../../src/renderer/stats.html");
    println!("cargo:rerun-if-changed=../../src/renderer/optimizer-bundle.js");
    println!("cargo:rerun-if-changed=../../src/renderer/i18n.js");
    println!("cargo:rerun-if-changed=../../src/helpers/terse-local-proxy.js");
    tauri_build::build()
}
