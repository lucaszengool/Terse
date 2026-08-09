// ── Doctor core: the half of the scanner that is identical on every platform ──
//
// SHARED SOURCE. This file is compiled into BOTH apps:
//   macOS   src-tauri/src/doctor.rs          → #[path = "../../shared/doctor_core.rs"]
//   Windows windows-app/src-tauri/src/doctor.rs → #[path = "../../../shared/doctor_core.rs"]
//
// It exists because these three items drifted apart once already: macOS grew a
// one-click fix engine while Windows kept advisory-only cards, and the shared
// doctor.js — which keys its button labels and progress steps off these exact
// strings — silently behaved differently per platform. Anything here must stay
// free of platform APIs (no process spawning, no OS paths beyond dirs::home_dir)
// so both crates can compile it unchanged.
//
// Platform-specific remediation (deleting to Trash vs Recycle Bin, UAC
// elevation, TCC permission panes, MCP config edits) stays in each doctor.rs.

use serde::Serialize;

/// A single scanner result the UI renders as a clean-able card row.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,           // stable id, e.g. "cache:claude-opus-4-8"
    pub category: String,     // "cache" | "mcp" | "prompt" | "loop" | "context" | "cost" | "config" | "junk" | "disk" | "guard"
    pub category_label: String,
    pub severity: String,     // "high" | "medium" | "low"
    pub title: String,
    pub detail: String,
    pub tokens_wasted: u64,
    pub usd_wasted: f64,
    pub bytes: u64,           // for junk findings
    pub latency_note: String, // human note about the speed impact
    pub fix_kind: String,     // "optimize" | "advise" | "delete"
    pub fix_label: String,    // button label, e.g. "Clean", "Enable", "How to fix"
    pub fixable: bool,        // false → advisory only, nothing to apply
    pub paths: Vec<String>,   // concrete files for "delete" findings
}

pub fn promote_all_fixable(findings: &mut [Finding]) {
    for f in findings.iter_mut() {
        if f.fixable {
            continue;
        }
        let id = f.id.as_str();
        let (kind, label): (&str, &str) = if id.starts_with("cache:idle-ttl-churn") {
            ("tune", "Keep cache warm")
        } else if id.starts_with("cache:low-hit-rate") {
            ("tune", "Stabilise prefix")
        } else if id.starts_with("cache:") {
            ("tune", "Enable cache-safe mode")
        } else if id.starts_with("mcp:claude-md-bloat") || id.starts_with("context:claude-md-tax") {
            ("claude-md-trim", "Trim CLAUDE.md")
        } else if id.starts_with("mcp:unused-default-tools") {
            // This id is suffixed with a SESSION id, not a server name, so there
            // is nothing for mcp-disable to act on — which tools a session left
            // untouched is a judgement call. Take the user straight to the config.
            if f.paths.is_empty() {
                f.paths = vec![dirs::home_dir()
                    .unwrap_or_default()
                    .join(".claude.json")
                    .to_string_lossy()
                    .into_owned()];
            }
            ("open-path", "Open config")
        } else if id.starts_with("mcp:") {
            ("mcp-disable", "Disable unused servers")
        } else if id.starts_with("context:near-window-limit") {
            ("tune", "Auto-compact")
        } else if id.starts_with("context:high-burn-rate") {
            ("tune", "Compress results")
        } else if id.starts_with("cost:frontier-overuse") {
            ("tune", "Route cheap turns")
        } else if id.starts_with("cost:output-heavy") || id.starts_with("config:cap-output") {
            ("tune", "Cap output")
        } else if id.starts_with("config:stable-tool-order") {
            ("tune", "Freeze tool order")
        } else if id.starts_with("config:prewarm-cache") {
            ("tune", "Prewarm cache")
        } else {
            // Anything unrecognised stays advisory rather than getting a button
            // that does nothing — a fix that silently no-ops is worse than advice.
            continue;
        };
        f.fix_kind = kind.into();
        f.fix_label = label.into();
        f.fixable = true;
    }
}

/// Named steps for a fix, so the card can draw a real progress bar instead of a
/// spinner. Kept in the backend so the labels match what actually happens.
pub fn fix_steps_for(kind: &str, id: &str) -> Vec<&'static str> {
    match kind {
        "delete" => vec!["Re-checking files", "Moving to Trash", "Recounting space"],
        "kill-process" => vec!["Verifying processes", "Sending stop signal", "Confirming exit"],
        "mcp-disable" => vec![
            "Reading MCP config",
            "Backing up config",
            "Stashing idle servers",
            "Verifying config",
        ],
        "claude-md-trim" => vec![
            "Reading CLAUDE.md",
            "Backing up original",
            "Drafting trimmed copy",
            "Opening for review",
        ],
        "grant-permission" => vec!["Checking permission", "Opening System Settings"],
        "tune" => {
            if id.starts_with("cache:") {
                vec!["Reading settings", "Enabling cache tuning", "Saving"]
            } else {
                vec!["Reading settings", "Applying tuning", "Saving"]
            }
        }
        _ => vec!["Applying", "Saving"],
    }
}
