//! A partial port of src-tauri/src/session_dock.rs — only the parts room_link
//! needs. The session dock proper (17 commands, the docked window, the
//! transcript watchers) is macOS Accessibility and window-server work and is
//! still on the ledger in renderer-deps.test.mjs.
//!
//! The call sites are spelled exactly as they are on macOS, so when the rest is
//! ported this file grows rather than moving.

use serde_json::{json, Value};
use std::path::PathBuf;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

pub(crate) fn find_transcript(id: &str) -> Option<PathBuf> {
    // id 只许是 uuid 的字符 —— 它要拼进路径,别让一个怪 id 走出 projects 目录
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let projects = home().join(".claude/projects");
    for e in std::fs::read_dir(&projects).ok()?.flatten() {
        let p = e.path().join(format!("{id}.jsonl"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Type a line into a Claude DESKTOP session by finding it in the sidebar.
///
/// macOS does this through the Accessibility tree. Windows has no equivalent
/// wired up — the honest answer is to say so, because the alternative is
/// sending a message into the wrong conversation, which room_link's own
/// comment calls worse than not sending it at all. Everything else in the room
/// channel is unaffected: Claude Code and Codex are reached through
/// dock_hook's queue, OpenClaw through its CLI.
pub fn sd_send(title: String, _text: String) -> Value {
    crate::diag_log("room", &format!(
        "sd_send(\"{title}\") — driving the Claude Desktop window is macOS-only, not sent"));
    json!({ "ok": false, "error": "Claude Desktop is not supported on Windows yet" })
}
