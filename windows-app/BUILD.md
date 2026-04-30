# Terse for Windows — Build Instructions

## Prerequisites

1. **Rust** (via [rustup](https://rustup.rs/))
2. **Node.js** (for the frontend and helper scripts)
3. **WebView2** (ships with Windows 10/11, needed by Tauri)
4. **.ico icon**: Convert `src-tauri/icons/icon.png` to `src-tauri/icons/icon.ico` using any PNG-to-ICO converter

## Build Steps

```powershell
# From the project root (Terse/)
cd windows-app/src-tauri

# Build in debug mode
cargo tauri dev

# Build release installer
cargo tauri build
```

## Architecture

This is a Windows port of the macOS Tauri app. Key platform differences:

| Component | macOS | Windows |
|-----------|-------|---------|
| Text capture | terse-ax (Swift, AX API) | terse-uia.exe (C#, UI Automation) |
| Clipboard | pbcopy/pbpaste | PowerShell Set/Get-Clipboard |
| Keystroke injection | osascript + System Events | SendKeys via PowerShell |
| Foreground app detection | JXA (JavaScript for Automation) | Win32 GetForegroundWindow |
| Process listing | ps -axo pid,comm | tasklist /FO CSV |
| Process CWD detection | lsof -d cwd | PowerShell Get-CimInstance |
| Credentials | macOS Keychain | Windows Credential Manager / AppData |
| App paths | Library/Application Support/ | %APPDATA%/ |
| Hook scripts | .sh (Bash) | .ps1 (PowerShell) |
| Rounded corners | Cocoa NSWindow API | Native Windows 11 / Tauri |

## Frontend

The frontend is shared — `src/renderer/` is used by both macOS and Windows builds.
The `tauri.conf.json` points to `../../src/renderer` as the `frontendDist`.

## terse-uia.exe

The Windows capture helper (`terse-uia.exe`) needs to be built separately.
It should provide the same CLI interface as the macOS `terse-ax`:

- `terse-uia read-app <PID> [X Y]` — Read focused element text via UI Automation
- `terse-uia write-pid <PID>` — Write stdin text to focused element
- `terse-uia spellcheck` — Spellcheck stdin text via Windows spell API
- `terse-uia enable-uia <PID>` — Enable UI Automation on Electron app
- `terse-uia key-monitor <PID>` — Monitor keyboard input for a process

All commands output JSON on stdout (e.g., `{"ok":true,"value":"..."}`)
