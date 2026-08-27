fn main() {
    // Force Cargo to re-run build script when frontend files change
    // Watch the WHOLE renderer directory, not a hand-picked list.
    //
    // Once a build script prints any rerun-if-changed, that list is exhaustive:
    // cargo re-runs the script ONLY when one of those paths changes. tauri_build
    // is what embeds frontendDist, and it runs inside this script - so every
    // renderer file that was missing from the list could go stale in the built
    // binary whenever the cargo cache was warm. The list named 11 files; the
    // renderer has many more, and wallpaper.html - the file this week was spent
    // on - was not one of them. Cargo scans a directory path recursively, so one
    // line cannot fall behind the way an enumerated list does.
    println!("cargo:rerun-if-changed=../src/renderer");
    println!("cargo:rerun-if-changed=../src/helpers/terse-local-proxy.js");
    tauri_build::build()
}
