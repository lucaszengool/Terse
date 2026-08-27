use std::path::Path;

/// Build the C# UI Automation helper if it isn't already sitting next to the
/// other helper scripts.
///
/// `tauri.conf.json` bundles `../helpers/terse-uia.exe` as a hard resource, but
/// only the C# *source* is checked in — so a clean clone used to fail the bundle
/// step before Rust even linked, with a resource-not-found error that reads like
/// a config typo. Publishing it here makes `cargo tauri build` self-contained on
/// any machine that has the .NET SDK.
///
/// Non-fatal by design: if `dotnet` is missing we print a clear warning naming
/// the one command to run, rather than failing an otherwise fine Rust build.
fn build_uia_helper() {
    let src_dir = Path::new("../helpers/terse-uia");
    let program_cs = src_dir.join("Program.cs");
    let exe = Path::new("../helpers/terse-uia.exe");

    println!("cargo:rerun-if-changed=../helpers/terse-uia/Program.cs");
    println!("cargo:rerun-if-changed=../helpers/terse-uia/terse-uia.csproj");

    if !program_cs.exists() {
        return; // nothing to build from
    }

    // Rebuild only when the helper is missing or older than its source.
    let up_to_date = match (exe.metadata().and_then(|m| m.modified()), program_cs.metadata().and_then(|m| m.modified())) {
        (Ok(a), Ok(b)) => a >= b,
        _ => false,
    };
    if up_to_date {
        return;
    }

    let out_dir = src_dir.join("publish");
    let status = std::process::Command::new("dotnet")
        .args([
            "publish",
            "terse-uia.csproj",
            "-c",
            "Release",
            "-r",
            "win-x64",
            "--self-contained",
            "true",
            "-p:PublishSingleFile=true",
            // Required to build a net8.0-windows project from a non-Windows host
            // (Linux/macOS CI). Harmless on Windows.
            "-p:EnableWindowsTargeting=true",
            "-o",
            "publish",
        ])
        .current_dir(src_dir)
        .status();

    match status {
        Ok(s) if s.success() => {
            let built = out_dir.join("terse-uia.exe");
            if let Err(e) = std::fs::copy(&built, exe) {
                println!(
                    "cargo:warning=terse-uia.exe published but could not be copied to helpers/: {}",
                    e
                );
            }
        }
        Ok(s) => println!("cargo:warning=dotnet publish for terse-uia failed ({s}). Build it manually: cd windows-app/helpers/terse-uia && dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o . "),
        Err(_) => println!("cargo:warning=.NET SDK not found — terse-uia.exe (UI Automation capture helper) was not built. Install the .NET 8 SDK, or the bundle step will fail on the missing resource."),
    }
}

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
    println!("cargo:rerun-if-changed=../../src/renderer");
    println!("cargo:rerun-if-changed=../../src/helpers/terse-local-proxy.js");

    // Runs on any host — `dotnet publish -r win-x64 -p:EnableWindowsTargeting=true`
    // cross-publishes fine from macOS/Linux, so CI can produce the installer too.
    build_uia_helper();

    tauri_build::build()
}
