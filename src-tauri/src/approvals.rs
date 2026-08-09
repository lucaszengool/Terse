//! Detect agent approval prompts ("allow / always allow / deny") across BOTH the
//! terminal CLIs and the desktop/editor apps, for Claude Code, Codex and Cursor.
//!
//! Why screen text and not the session logs: a `tool_use` with no matching
//! `tool_result` in the JSONL looks identical whether the agent is *blocked on a
//! permission prompt* or the tool is simply still running. A 30-second `bash` call
//! and a waiting prompt are indistinguishable there, so log-based detection would
//! fire constantly on long-running tools. The on-screen question is the only
//! unambiguous signal, so we read it via the AX helper's `window-text` command.
//!
//! Prompt shapes covered (see PATTERNS + parse_prompt):
//!   Claude Code CLI   "Do you want to proceed?"        + numbered 1./2./3. options
//!                     "Do you want to make this edit to X?"
//!                     "Do you want to create X?"
//!   Claude Code app   "Allow Claude to run X?"          + Deny / Allow once / Always allow
//!   Codex CLI         "Allow command?" / "Apply patch?" + y/n, or numbered options
//!   Cursor            "Run command?" / "Accept changes?"
//! Unknown shapes fall through to None rather than guessing.

use serde::Serialize;

/// One pending approval, as surfaced to the island.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApprovalPrompt {
    /// Stable id so the same on-screen prompt isn't re-announced every poll.
    pub id: String,
    /// "claude" | "codex" | "cursor"
    pub agent: String,
    /// "terminal" | "app"
    pub surface: String,
    /// Host application name, e.g. "Terminal", "Claude", "Cursor".
    pub app: String,
    /// Window title — "which window is asking".
    pub window: String,
    /// The question itself, e.g. "Allow Claude to run Start preview server?".
    pub question: String,
    /// The step/command being approved (the preview), if we could isolate it.
    pub detail: String,
    /// Selectable options in display order.
    pub options: Vec<ApprovalOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApprovalOption {
    /// Full option text as shown.
    pub label: String,
    /// Keystroke that selects it ("1", "2", "y", "n", "esc"), when we can tell.
    pub key: String,
    /// True for the "always / don't ask again" variant, which deserves a warning tint.
    pub sticky: bool,
    /// True for the reject/deny option.
    pub deny: bool,
}

/// Questions that mean "an agent is blocked waiting for the user".
/// Matched case-insensitively against the tail of the window text.
const QUESTION_MARKERS: &[(&str, &str)] = &[
    // (marker, agent)
    ("do you want to proceed?", "claude"),
    ("do you want to make this edit", "claude"),
    ("do you want to create", "claude"),
    ("do you want to run", "claude"),
    ("do you want to delete", "claude"),
    ("do you want to read", "claude"),
    ("allow claude to run", "claude"),
    ("allow claude to", "claude"),
    ("claude needs permission", "claude"),
    ("claude wants to", "claude"),
    ("would you like to proceed", "claude"),
    ("apply patch?", "codex"),
    ("allow command?", "codex"),
    ("allow codex to", "codex"),
    ("codex wants to", "codex"),
    ("approve this command", "codex"),
    ("run this command?", "codex"),
    ("accept changes?", "cursor"),
    ("run command?", "cursor"),
    ("cursor wants to", "cursor"),
];

/// Text that means the prompt has been answered / is not actually pending.
const RESOLVED_MARKERS: &[&str] = &["esc to interrupt", "esc to cancel·"];

fn is_option_line(line: &str) -> Option<ApprovalOption> {
    let t = line.trim();
    if t.is_empty() || t.len() > 120 {
        return None;
    }
    let low = t.to_lowercase();

    // Numbered: "1. Yes", "❯ 2. Yes, and don't ask again", "2) Approve"
    let numbered = t
        .trim_start_matches(['❯', '>', '*', '•', ' '])
        .trim_start();
    let mut chars = numbered.chars();
    if let Some(d) = chars.next() {
        if d.is_ascii_digit() {
            let rest = chars.as_str();
            if rest.starts_with('.') || rest.starts_with(')') {
                let label = rest[1..].trim().to_string();
                if !label.is_empty() {
                    let l = label.to_lowercase();
                    return Some(ApprovalOption {
                        sticky: l.contains("don't ask") || l.contains("dont ask") || l.contains("always"),
                        deny: l.starts_with("no") || l.contains("reject") || l.contains("deny") || l.contains("cancel"),
                        key: d.to_string(),
                        label,
                    });
                }
            }
        }
    }

    // App-style buttons: "Deny 1", "Allow once 2 ⌘↵", "Always allow"
    for (needle, deny) in [
        ("always allow", false),
        ("allow once", false),
        ("allow all", false),
        ("allow", false),
        ("approve", false),
        ("accept", false),
        ("deny", true),
        ("reject", true),
        ("decline", true),
    ] {
        if low.starts_with(needle) {
            // trailing digit is the shortcut ("Deny 1", "Allow once 2 ⌘↵")
            let key = t
                .chars()
                .find(|c| c.is_ascii_digit())
                .map(|c| c.to_string())
                .unwrap_or_default();
            return Some(ApprovalOption {
                label: t.to_string(),
                key,
                sticky: low.contains("always") || low.contains("all"),
                deny,
            });
        }
    }

    // Codex y/n: "y = approve", "(y/n)", "n - reject"
    if low.starts_with("y =") || low.starts_with("y)") || low.starts_with("y -") {
        return Some(ApprovalOption { label: t.to_string(), key: "y".into(), sticky: false, deny: false });
    }
    if low.starts_with("n =") || low.starts_with("n)") || low.starts_with("n -") {
        return Some(ApprovalOption { label: t.to_string(), key: "n".into(), sticky: false, deny: true });
    }
    None
}

/// Cheap stable hash so the same prompt keeps one id across polls.
fn stable_id(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{:x}", h)
}

/// Parse one window's visible text. Returns None when nothing is pending.
pub fn parse_prompt(app: &str, window: &str, text: &str, surface: &str) -> Option<ApprovalPrompt> {
    if text.is_empty() {
        return None;
    }
    // Only the tail matters — a prompt sits at the bottom of a terminal buffer, and
    // scanning the whole scrollback would match questions the user already answered.
    let tail: String = {
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(60);
        lines[start..].join("\n")
    };
    let low = tail.to_lowercase();

    if RESOLVED_MARKERS.iter().any(|m| low.contains(m)) {
        return None;
    }

    let (marker, agent) = QUESTION_MARKERS.iter().find(|(m, _)| low.contains(m))?;

    // Locate the question line (the last one containing the marker).
    let lines: Vec<&str> = tail.lines().collect();
    let qidx = lines
        .iter()
        .rposition(|l| l.to_lowercase().contains(marker))?;
    let question = lines[qidx].trim().to_string();

    // Options follow the question.
    let mut options = Vec::new();
    for l in lines.iter().skip(qidx + 1) {
        if let Some(o) = is_option_line(l) {
            if !options.iter().any(|e: &ApprovalOption| e.label == o.label) {
                options.push(o);
            }
        }
        if options.len() >= 6 {
            break;
        }
    }
    // The app dialog puts its buttons after a body; if we found none after the
    // question, sweep the whole tail (buttons can precede on some layouts).
    if options.is_empty() {
        for l in lines.iter() {
            if let Some(o) = is_option_line(l) {
                if !options.iter().any(|e: &ApprovalOption| e.label == o.label) {
                    options.push(o);
                }
            }
        }
    }
    // No options means it isn't actually an interactive prompt.
    if options.is_empty() {
        return None;
    }

    // Detail = the lines between the question and the first option (the command,
    // the diff header, the reason) — this is the "which step" preview.
    let first_opt = lines
        .iter()
        .skip(qidx + 1)
        .position(|l| is_option_line(l).is_some())
        .map(|p| qidx + 1 + p)
        .unwrap_or(lines.len());
    let detail = lines[(qidx + 1).min(lines.len())..first_opt.min(lines.len())]
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let detail = if detail.chars().count() > 400 {
        detail.chars().take(400).collect::<String>() + "…"
    } else {
        detail
    };

    Some(ApprovalPrompt {
        id: stable_id(&[app, window, &question, &detail]),
        agent: agent.to_string(),
        surface: surface.to_string(),
        app: app.to_string(),
        window: window.to_string(),
        question,
        detail,
        options,
    })
}

/// Apps worth polling, and whether they're a terminal or a GUI app surface.
pub const HOSTS: &[(&str, &str)] = &[
    ("Terminal", "terminal"),
    ("iTerm2", "terminal"),
    ("Ghostty", "terminal"),
    ("WezTerm", "terminal"),
    ("Alacritty", "terminal"),
    ("kitty", "terminal"),
    ("Warp", "terminal"),
    ("Hyper", "terminal"),
    ("Claude", "app"),
    ("Cursor", "app"),
    ("Code", "app"),
    ("Windsurf", "app"),
    ("Zed", "app"),
];

// ── Live scanning ────────────────────────────────────────────────────────────

use std::collections::HashSet;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Ids already announced, so a prompt left on screen isn't re-emitted every tick.
static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Find the host apps we care about. Returns (pid, app-name, surface).
///
/// Uses `ps` and matches on the executable BASENAME rather than pgrep. pgrep was
/// silently useless here: Claude.app is hardened/notarized, so its argv isn't
/// readable — `pgrep -x Claude`, `pgrep -f Claude.app/...` and even plain
/// `pgrep Claude` all miss the main process (plain pgrep matches only its helper
/// processes, which own no windows). `ps -Ao pid,comm` reports it fine.
fn host_pids() -> Vec<(u32, String, String)> {
    let mut out = Vec::new();
    let output = match Command::new("ps").args(["-Ao", "pid=,comm="]).output() {
        Ok(o) => o,
        Err(_) => return out,
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        let (pid_s, path) = match line.split_once(char::is_whitespace) {
            Some(p) => p,
            None => continue,
        };
        let pid: u32 = match pid_s.trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let base = path.trim().rsplit('/').next().unwrap_or("").trim();
        if let Some((name, surface)) = HOSTS.iter().find(|(n, _)| *n == base) {
            out.push((pid, name.to_string(), surface.to_string()));
        }
    }
    out
}

/// Append a diagnostic line to ~/.terse/approvals.log (best-effort, never panics).
/// This exists because every failure mode in this chain is SILENT — no AX grant, an
/// Electron app that doesn't expose its tree, a helper that won't exec — all look
/// identical from outside: nothing happens.
fn dlog(msg: &str) {
    use std::io::Write;
    if let Some(home) = std::env::var_os("HOME") {
        let dir = std::path::Path::new(&home).join(".terse");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("approvals.log"))
        {
            let _ = writeln!(f, "{}", msg);
        }
    }
}

/// Read one app's windows IN-PROCESS and parse each for a prompt.
///
/// This deliberately does not shell out to the `terse-ax` helper: Terse is unsigned,
/// so macOS grants Accessibility per-binary, and the helper needed a separate grant
/// that every rebuild silently invalidated. Reading here means the app's own grant
/// is the only one anybody has to give.
fn scan_pid(pid: u32, app: &str, surface: &str) -> Vec<ApprovalPrompt> {
    let wins = crate::ax_read::window_text(pid, 8000);
    if wins.is_empty() {
        dlog(&format!("[{} pid={}] no windows readable", app, pid));
    }
    let mut found = Vec::new();
    for w in wins {
        dlog(&format!(
            "[{} pid={}] window title={:?} textlen={} activation_err={}{}",
            app, pid, w.title, w.text.len(),
            crate::ax_read::LAST_ACTIVATION.load(std::sync::atomic::Ordering::Relaxed),
            // When a window yields almost nothing, dump it verbatim — that reveals
            // whether we're seeing chrome-only or a genuinely empty tree.
            if w.text.len() < 200 { format!(" raw={:?}", w.text) } else { String::new() }
        ));
        if let Some(p) = parse_prompt(app, &w.title, &w.text, surface) {
            dlog(&format!("[{} pid={}] >>> MATCHED: {}", app, pid, p.question));
            found.push(p);
        }
    }
    found
}

/// One sweep across every host app. Emits `terse-approval` for prompts not yet
/// announced, and `terse-approval-cleared` once a prompt disappears (the user
/// answered it in the terminal), so the island can drop a stale card.
pub fn scan_once(app: &AppHandle) {
    let mut live: HashSet<String> = HashSet::new();
    let mut fresh: Vec<ApprovalPrompt> = Vec::new();

    let hosts = host_pids();
    dlog(&format!(
        "--- sweep: {} host(s) {:?}",
        hosts.len(),
        hosts.iter().map(|(p, n, _)| format!("{}:{}", n, p)).collect::<Vec<_>>()
    ));
    for (pid, name, surface) in hosts {
        for p in scan_pid(pid, &name, &surface) {
            live.insert(p.id.clone());
            fresh.push(p);
        }
    }

    let mut guard = SEEN.lock().unwrap();
    let seen = guard.get_or_insert_with(HashSet::new);

    let island_up = app
        .get_webview_window("island")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);

    for p in &fresh {
        if seen.insert(p.id.clone()) {
            let _ = app.emit("terse-approval", p);
            if island_up {
                let _ = app.emit_to("island", "terse-approval", p);
            } else {
                // Island hidden — a blocked agent still has to reach the user, so
                // fall back to the toast window rather than swallowing it.
                if let Some(win) = app.get_webview_window("toast") {
                    let _ = win.show();
                    let body = if p.detail.is_empty() { p.question.clone() } else { p.detail.clone() };
                    let _ = app.emit_to(
                        "toast",
                        "terse-toast",
                        serde_json::json!({
                            "kind": "agent",
                            "severity": "high",
                            "title": p.question,
                            "body": body,
                            "action": null,
                        }),
                    );
                }
            }
        }
    }
    // Anything previously seen but no longer on screen has been answered.
    let gone: Vec<String> = seen.difference(&live).cloned().collect();
    for id in gone {
        seen.remove(&id);
        let _ = app.emit("terse-approval-cleared", &id);
        let _ = app.emit_to("island", "terse-approval-cleared", &id);
    }
}

/// Background poll. Cheap enough at 1.5s: one `pgrep` per host plus an AX read
/// only for apps that are actually running.
pub fn spawn_scanner(app: AppHandle) {
    std::thread::spawn(move || {
        // Give the app a moment to finish launching before the first sweep.
        std::thread::sleep(std::time::Duration::from_secs(3));
        // Ask once at startup if we lack the grant. Terse is unsigned, so an app
        // update voids the previous grant while the checkbox still looks enabled —
        // the user needs a real dialog, not silence.
        if !crate::ax_read::is_trusted() {
            dlog("Accessibility missing at startup — prompting the user");
            crate::ax_read::prompt_for_trust();
        }
        loop {
            // Always scan. This used to be gated on the island being visible, which
            // meant any reason the island was hidden (free tier, user closed it)
            // silently disabled approval detection — a blocked agent went unreported.
            // scan_once() picks the surface: island when it's up, toast otherwise.
            if !crate::ax_read::is_trusted() {
                dlog("Terse itself lacks Accessibility — approvals cannot be read");
            }
            scan_once(&app);
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim shape of the Claude Code desktop dialog.
    const CLAUDE_APP: &str = "\
Allow Claude to run Start preview server?
Start preview server
Contains shell syntax (&) that cannot be statically analyzed
(nohup python3 -m http.server 8851 > /tmp/pv9.log 2>&1 &) ; sleep 5
Deny 1
Allow once 2 ⌘↵";

    // Claude Code CLI numbered prompt.
    const CLAUDE_CLI: &str = "\
Bash(rm -rf build/)
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for similar commands
  3. No, and tell Claude what to do differently (esc)";

    const CODEX_CLI: &str = "\
Apply patch?
 src/main.rs | 12 +++++---
y = approve
n = reject";

    #[test]
    fn detects_claude_desktop_dialog() {
        let p = parse_prompt("Claude", "Claude", CLAUDE_APP, "app").expect("should detect");
        assert_eq!(p.agent, "claude");
        assert_eq!(p.surface, "app");
        assert!(p.question.contains("Allow Claude to run"));
        assert_eq!(p.options.len(), 2, "{:?}", p.options);
        assert!(p.options.iter().any(|o| o.deny && o.key == "1"));
        assert!(p.options.iter().any(|o| !o.deny && o.key == "2"));
        assert!(p.detail.contains("http.server"), "detail={}", p.detail);
    }

    #[test]
    fn detects_claude_cli_numbered_prompt() {
        let p = parse_prompt("Terminal", "bash", CLAUDE_CLI, "terminal").expect("should detect");
        assert_eq!(p.agent, "claude");
        assert_eq!(p.options.len(), 3, "{:?}", p.options);
        assert_eq!(p.options[0].key, "1");
        assert!(p.options[1].sticky, "option 2 is the don't-ask-again variant");
        assert!(p.options[2].deny, "option 3 is the reject");
    }

    #[test]
    fn detects_codex_yes_no() {
        let p = parse_prompt("Terminal", "codex", CODEX_CLI, "terminal").expect("should detect");
        assert_eq!(p.agent, "codex");
        assert!(p.options.iter().any(|o| o.key == "y" && !o.deny));
        assert!(p.options.iter().any(|o| o.key == "n" && o.deny));
    }

    #[test]
    fn ignores_ordinary_output() {
        assert!(parse_prompt("Terminal", "bash", "npm install\nadded 42 packages\n$ ", "terminal").is_none());
    }

    #[test]
    fn ignores_question_without_options() {
        // A question echoed in scrollback with no selectable options is not pending.
        let t = "Do you want to proceed?\nthe user already answered this\n$ ls";
        assert!(parse_prompt("Terminal", "bash", t, "terminal").is_none());
    }

    #[test]
    fn id_is_stable_across_polls_and_differs_per_prompt() {
        let a = parse_prompt("Claude", "Claude", CLAUDE_APP, "app").unwrap();
        let b = parse_prompt("Claude", "Claude", CLAUDE_APP, "app").unwrap();
        assert_eq!(a.id, b.id, "same prompt must keep one id");
        let c = parse_prompt("Terminal", "bash", CLAUDE_CLI, "terminal").unwrap();
        assert_ne!(a.id, c.id, "different prompts must differ");
    }

    #[test]
    fn only_the_tail_is_considered() {
        // An old answered prompt far up the scrollback must not re-fire.
        let mut buf = String::from("Do you want to proceed?\n1. Yes\n2. No\n");
        for i in 0..200 {
            buf.push_str(&format!("line {}\n", i));
        }
        assert!(parse_prompt("Terminal", "bash", &buf, "terminal").is_none());
    }
}
