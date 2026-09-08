// Ported from src-tauri/src/permission.rs.
//
// Pure std + tauri - a localhost HTTP server, a JSON merge and a transcript
// read - so it crosses over unchanged apart from two things that would fail
// SILENTLY if copied verbatim: the include_str! path is one level deeper here,
// and the hook command has to be quoted (see install_hook).
//
// The hook itself is Node, which Windows runs the same way; this app already
// spawns node for the local proxy.
//! permission.rs — answer Claude Code permission prompts from the island.
//!
//! TWO hook events feed this, and the split is the whole design:
//!
//!   PreToolUse                     → POST /permission.  Can decide. May hold.
//!   Notification/permission_prompt → POST /notify.      Observes. Never holds.
//!
//! PreToolUse runs BEFORE Claude Code's permission check, so nothing at that
//! moment knows whether the call will actually be prompted for. The previous
//! version guessed — it reimplemented Claude Code's read-only-command list and
//! rule matcher and hoped they agreed. Every disagreement in the "it will
//! prompt" direction put a card up for work nobody was being asked to approve
//! and held the agent for up to ten seconds while it waited. The hook is
//! registered globally in ~/.claude/settings.json, so that landed on every
//! session on the machine at once: "turning the island on stops my other
//! sessions".
//!
//! The Notification event is ground truth — it fires only when Claude Code has
//! genuinely put a permission prompt on screen, and carries the same
//! tool_use_id as the PreToolUse call. Terse records the signature, and ONLY
//! signatures learned that way ever get a card. A call that has never been
//! prompted for is passed through instantly. False positives are structurally
//! impossible; the price is that the first occurrence of a given command goes
//! to the terminal as usual, and the island takes over from then on.
//!
//! Flow once learned:
//!   hook → POST /permission → emit `permission-request` to the island window
//!        → island shows preview + buttons → permission_respond command
//!        → decision travels back over the channel → HTTP response → hook
//!
//! Standing aside is expressed by replying `{"decision":"none"}`; the hook
//! turns anything that is not allow/deny/ask into SILENCE, which is Claude
//! Code's documented way of saying "no decision, carry on". Printing an
//! invented value like "defer" — which is what the old build did on nearly
//! every call — is a schema violation on the agent's hot path.
//!
//! A hand-rolled HTTP/1.1 read is used rather than pulling in a web framework:
//! the surface is one localhost route with one method, and the app already
//! links plenty. It only ever binds 127.0.0.1.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const PERMISSION_PORT: u16 = 47822;

/// How long the island holds the call before handing it back to Claude Code.
///
/// The two UIs cannot be live at once: Claude Code only draws its own prompt
/// AFTER the hook returns, so while the island holds the call there is nothing
/// in the terminal, and once it lets go the decision is already made. The
/// design is therefore a relay — island first, terminal as the fallback — and
/// this window is how long the user has to use the island before the familiar
/// prompt takes over. Short on purpose: waiting must never feel like a hang.
const WAIT: Duration = Duration::from_secs(10);

/// How long the island gets to prove it can actually draw the card.
///
/// A window that EXISTS is not a window that can answer: a webview can be alive
/// to the window server while its JS is wedged, background-throttled or
/// mid-reload, and in that state nobody can press a button — yet the agent would
/// still be held for the full WAIT. That is precisely how sessions ended up
/// frozen. So the island must call back (permission_ack, sent after two frames,
/// i.e. after layout) before we hold anything. No ack → instant defer.
const ACK_WAIT: Duration = Duration::from_millis(1200);

/// Append one line to ~/.terse/permission.log.
///
/// This subsystem sits in the agent's critical path — when it misbehaves the
/// symptom is "my session froze", with nothing anywhere explaining why. Every
/// decision is logged so the cause is one `tail` away.
fn plog(msg: &str) {
    let p = home().join(".terse").join("permission.log");
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write as _;
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{t}] {msg}");
    }
}

/// Island permission control is OPT-IN.
///
/// The flag is "on" rather than "off" so the default is off by construction: a
/// feature that sits in the agent's critical path must never be something a
/// user discovers by having their session wedged. Settings → Island permission
/// control creates and removes this file (see set_permission_control).

/// The user's home directory, with a seam for the hook tests.
///
/// install_hook edits a real ~/.claude/settings.json, so its test must be
/// pointed at a throwaway directory. The macOS test does that by setting $HOME,
/// which dirs::home_dir() honours on unix — but on Windows it resolves the
/// profile through SHGetKnownFolderPath and ignores EVERY environment variable,
/// so there is no variable to set. The override exists only under cfg(test);
/// release builds compile to a plain home_dir() call.
fn home() -> std::path::PathBuf {
    #[cfg(test)]
    {
        if let Some(p) = TEST_HOME.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return p;
        }
    }
    dirs::home_dir().unwrap_or_default()
}

#[cfg(test)]
static TEST_HOME: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

fn enabled() -> bool {
    home().join(".terse").join("permission-on").exists()
}

pub fn is_enabled() -> bool { enabled() }

/// Turn the feature on/off: flag file + hook registration in one place, so the
/// two can never disagree (hook installed but feature off, or vice versa).
pub fn set_enabled(on: bool) -> Result<bool, String> {
    let f = home().join(".terse").join("permission-on");
    if let Some(d) = f.parent() { let _ = std::fs::create_dir_all(d); }
    if on {
        std::fs::write(&f, b"1").map_err(|e| e.to_string())?;
        // The two are mutually exclusive by intent. Answering on the island means
        // you want to SEE each request and decide; auto-approve means the button
        // is pressed for you after 2s. Leaving both on gives you a card you are
        // racing against, which is the worst of both. Turning the island on is
        // the more explicit choice, so it wins and clears auto.
        let m = get_auto_modes();
        if !m.claude.is_empty() || !m.codex.is_empty() {
            let _ = set_auto_modes(AutoModes::default());
            plog("auto-approve cleared (island permission control switched on)");
        }
        plog("enabled by user");
        install_hook()
    } else {
        let _ = std::fs::remove_file(&f);
        plog("disabled by user");
        uninstall_hook()
    }
}

/// Force the switch back to its default (off) — flag file gone, hook gone.
///
/// Called once per launch from setup(). The switch used to persist: enable it
/// once and every future launch re-installed a PreToolUse hook into
/// ~/.claude/settings.json, putting Terse in the critical path of every agent
/// the user ran from then on, indefinitely, whether or not they still wanted it.
/// Now it is a per-session decision — you turn it on in Settings when you want
/// it, and closing the app always leaves the agent's config clean.
///
/// Separate from set_enabled(false) only so the log says what actually happened;
/// "disabled by user" in permission.log would be a lie, and that log is the one
/// place anybody looks when a session mysteriously stalls.
pub fn reset_to_default() {
    let f = home().join(".terse").join("permission-on");
    let was_on = f.exists();
    if was_on {
        let _ = std::fs::remove_file(&f);
        plog("reset to default (off) at launch — was on");
    }
    match uninstall_hook() {
        Ok(true) => plog("hook removed at launch"),
        Ok(false) => {}
        Err(e) => plog(&format!("hook NOT removed at launch: {e}")),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub tool_use_id: String,
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: serde_json::Value,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub permission_mode: String,
    /// Assigned here, not by the hook — the island echoes it back so a reply
    /// can never be routed to the wrong pending call.
    #[serde(default)]
    pub id: String,
    /// "" | "once" | "always" — auto-approval mode for the agent that asked.
    #[serde(default)]
    pub auto: String,
    /// Path to the session transcript, forwarded by the hook. Used to answer
    /// "why is it running this?" — see read_context.
    #[serde(default)]
    pub transcript_path: String,
    /// What the agent said it was doing, and what the user asked for. A bare
    /// command is not enough to decide on: `rm -rf build` is routine during a
    /// clean and alarming out of nowhere, and only the surrounding turn tells
    /// you which one this is.
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub task: String,
    /// Optional self-identification, e.g. "codex". Claude Code's own hook does
    /// not send it (everything arriving over PreToolUse is Claude by
    /// definition); it exists so a Codex-side bridge can say so explicitly
    /// rather than being guessed at from the session id.
    #[serde(default)]
    pub agent: String,
}

/// After a card goes unanswered, stop holding anything for this long.
///
/// This is the difference between "one 10-second pause" and "every tool call in
/// every running session pauses 10 seconds". An unanswered card means the user
/// is not looking at the island — they are in a terminal, in another app, or
/// away — and in that state holding the NEXT call has no chance of being
/// answered either. It is the single biggest reason other sessions felt frozen:
/// nothing was stuck, but a background agent doing fifty tool calls paid ten
/// seconds for each one. Any answered card clears it immediately.
/// Default two minutes was too blunt: while quiet, no card is shown, so a user
/// who came back to the island had no way to say "I'm here" and simply saw the
/// feature do nothing. One minute, plus the hover escape hatch below
/// (island_set_expanded → clear_quiet), keeps the protection without the dead
/// zone. Overridable for diagnosis and for tests that must not idle a minute
/// between cases.
fn backoff() -> Duration {
    let secs = std::env::var("TERSE_PERMISSION_BACKOFF_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60);
    Duration::from_secs(secs)
}

#[derive(Default)]
pub struct PermissionHub {
    pending: Mutex<HashMap<String, Sender<String>>>,
    /// Set by permission_ack when the island has actually drawn the card.
    acked: Mutex<HashMap<String, Sender<()>>>,
    /// Epoch seconds until which we hold nothing. See BACKOFF.
    quiet_until: std::sync::atomic::AtomicU64,
    /// Gated PreToolUse calls seen this run, and permission_prompt
    /// notifications seen. The ratio is how Terse works out whether the
    /// Notification event exists at all in this environment — see
    /// notification_presumed_dead().
    gated_seen: std::sync::atomic::AtomicU64,
    notify_seen: std::sync::atomic::AtomicU64,
    /// tool_use_id → signature, for calls we let through.
    ///
    /// The Notification event tells us Claude Code prompted, and carries the
    /// tool_use_id — but not the tool input, so it cannot compute a signature on
    /// its own. This is how the two events are joined up. Bounded; the entries
    /// are only interesting for the moment between PreToolUse and the prompt.
    recent: Mutex<Vec<(String, String)>>,
}

/// Most recent calls kept for the Notification event to match against. A prompt
/// follows its PreToolUse within milliseconds, so this only has to survive that
/// gap; the cap is what keeps a long session from growing it without bound.
const RECENT_MAX: usize = 256;

/// Gated calls to wait through before deciding this host cannot deliver the
/// Notification event. Small enough that a desktop-app user starts getting
/// cards within a minute of normal work, large enough that a CLI user who
/// simply has not hit a prompt yet is not mislabelled.
const NOTIFY_GRACE: u64 = 6;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl PermissionHub {
    /// Resolve a waiting request. Returns false if the id is unknown (already
    /// answered, or timed out and cleaned up) so the UI can stop showing it.
    pub fn respond(&self, id: &str, decision: &str) -> bool {
        let tx = {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            p.remove(id)
        };
        match tx {
            Some(tx) => {
                // Someone is at the island after all — resume holding.
                self.quiet_until.store(0, std::sync::atomic::Ordering::Relaxed);
                tx.send(decision.to_string()).is_ok()
            }
            None => false,
        }
    }

    /// "I'm here." Hovering the island is a user standing at the control, which
    /// is the one thing the quiet period cannot otherwise learn: while quiet no
    /// card is drawn, so there is nothing to click to prove presence.
    pub fn clear_quiet(&self) {
        self.quiet_until.store(0, std::sync::atomic::Ordering::Relaxed);
    }

    fn is_quiet(&self) -> bool {
        now_secs() < self.quiet_until.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn go_quiet(&self) {
        self.quiet_until
            .store(now_secs() + backoff().as_secs(), std::sync::atomic::Ordering::Relaxed);
    }

    /// The island reports that the card is on screen and interactive.
    pub fn ack(&self, id: &str) -> bool {
        let tx = { self.acked.lock().unwrap_or_else(|e| e.into_inner()).remove(id) };
        match tx { Some(tx) => tx.send(()).is_ok(), None => false }
    }

    fn arm_ack(&self, id: &str, tx: Sender<()>) {
        self.acked.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), tx);
    }

    fn cancel_ack(&self, id: &str) {
        self.acked.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub fn cancel(&self, id: &str) {
        let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        p.remove(id);
    }

    fn note_gated(&self) -> u64 {
        self.gated_seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }
    fn note_notify(&self) {
        self.notify_seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// True once this environment has proved it will never deliver the
    /// Notification event.
    ///
    /// The learning design assumes Notification/permission_prompt fires when
    /// Claude Code puts a prompt on screen. That is true of the terminal CLI —
    /// and NOT true of Claude Desktop, the VS Code extension, or Windows, where
    /// the event simply never arrives while PreToolUse works normally
    /// (anthropics/claude-code#35541, #59718, #56936, #17170). In those hosts
    /// Terse would sit inert forever: nothing is ever learned, so no card is
    /// ever shown, which is exactly "I enabled it and the island does nothing".
    ///
    /// So: watch. If enough calls that WOULD have been worth asking about have
    /// gone by without a single notification, conclude the event is unavailable
    /// here and fall back to predicting. Re-evaluated per run, and one real
    /// notification permanently switches this host back to ground truth.
    pub fn notification_presumed_dead(&self) -> bool {
        use std::sync::atomic::Ordering::Relaxed;
        self.notify_seen.load(Relaxed) == 0 && self.gated_seen.load(Relaxed) >= NOTIFY_GRACE
    }

    pub fn env_counts(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (self.gated_seen.load(Relaxed), self.notify_seen.load(Relaxed))
    }

    /// Note what a tool_use_id was about, so a later permission_prompt
    /// notification for that id can be turned back into a signature.
    fn remember_call(&self, tool_use_id: &str, key: &str) {
        if tool_use_id.is_empty() {
            return;
        }
        let mut r = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = r.iter_mut().find(|(id, _)| id == tool_use_id) {
            slot.1 = key.to_string();
            return;
        }
        r.push((tool_use_id.to_string(), key.to_string()));
        if r.len() > RECENT_MAX {
            let excess = r.len() - RECENT_MAX;
            r.drain(0..excess);
        }
    }

    fn lookup_call(&self, tool_use_id: &str) -> Option<String> {
        let r = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        r.iter().find(|(id, _)| id == tool_use_id).map(|(_, k)| k.clone())
    }
}

/// Start the listener. Never panics the app: a busy port just means the feature
/// is off for this run and the hook's `defer` keeps Claude Code's own prompt.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PERMISSION_PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[permission] port {PERMISSION_PORT} unavailable: {e}");
                return;
            }
        };
        eprintln!("[permission] listening on 127.0.0.1:{PERMISSION_PORT}");
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            // One thread per request: each blocks for up to WAIT, so they must
            // not queue behind each other — two agents can prompt at once.
            std::thread::spawn(move || handle(app, stream));
        }
    });
}

/// The reply that means "Terse has no decision". The hook turns anything that
/// is not allow/deny/ask into silence, which is Claude Code's documented way of
/// saying "carry on with the normal permission flow".
const PASS: &str = r#"{"decision":"none"}"#;

fn handle(app: AppHandle, mut stream: TcpStream) {
    let (path, body) = match read_request(&mut stream) {
        Some(b) => b,
        None => return respond_http(&mut stream, PASS),
    };

    // Notification/permission_prompt — Claude Code really did put a prompt on
    // screen. Record it and get out of the way; this event can never decide.
    if path.starts_with("/notify") {
        return handle_notify(&app, &body, &mut stream);
    }

    let mut req: PermissionRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(_) => return respond_http(&mut stream, PASS),
    };
    // GATED: only take over calls Claude Code would actually have prompted for.
    //
    // PreToolUse fires before EVERY tool call — Read, Grep, TodoWrite included.
    // The first version answered all of them, so the island popped a card for
    // work the user was never being asked to approve AND held the agent blocked
    // while it waited. Anything outside the gate is deferred instantly, which
    // costs one local round-trip and leaves Claude Code's own flow untouched.
    if !enabled() {
        return respond_http(&mut stream, PASS);
    }

    let key = rule_key(&req);

    // Remember what this call WAS, so that if Claude Code goes on to prompt for
    // it, the Notification event — which carries the tool_use_id but not the
    // tool input — can recover the signature. Cheap, bounded, in memory only.
    //
    // BEFORE any filter, deliberately. Everything below is a reason not to show
    // a card, and none of them is a reason not to LEARN. Registering after the
    // filters meant that any call our own heuristics waved through could never
    // be matched to its notification — so if Claude Code did prompt for it, the
    // signature was never recorded and the island would never handle that call,
    // no matter how many times it came round.
    app.state::<PermissionHub>().remember_call(&req.tool_use_id, &key);

    // Ground truth first: if Claude Code has really prompted for this, our own
    // heuristics are demonstrably wrong about it and must not get a veto.
    let observed = is_observed(&key, &req.tool_name);

    if !observed && !needs_prompt(&req) {
        plog(&format!("pass (not gated / already allowed) {}", req.tool_name));
        return respond_http(&mut stream, PASS);
    }
    // Only calls that got this far are evidence about the environment: they are
    // the ones a permission prompt could plausibly have followed.
    let seen = app.state::<PermissionHub>().note_gated();

    // ── The gate: only ever ask about what Claude Code has really asked about ─
    //
    // PreToolUse runs BEFORE Claude Code's permission check, so at this instant
    // nothing here can know whether this call will be prompted for. The old
    // version guessed — it reimplemented the read-only-command list and the
    // settings rule matcher and hoped they agreed with Claude Code. When the
    // guess said "prompt" and Claude Code disagreed, the island put a card up
    // for work nobody was being asked to approve and held the agent while it
    // waited. Across every session on the machine, that is what "enabling the
    // island stops my other sessions" was.
    //
    // So stop guessing. `observed` holds signatures Claude Code has actually
    // raised a permission prompt for, learned from the Notification event. A
    // signature that has never prompted is passed through instantly — no card,
    // no hold, nothing to notice. The cost is that the FIRST time a given
    // command comes up it goes to the terminal as usual; from then on the
    // island handles it. False positives become structurally impossible.
    if !observed {
        if !app.state::<PermissionHub>().notification_presumed_dead() {
            plog(&format!("pass (never seen Claude prompt for this) {}", redact(&key)));
            return respond_http(&mut stream, PASS);
        }
        // Fallback mode. This host does not deliver Notification, so there is no
        // ground truth to wait for and predicting is the only option left. The
        // protections that make a wrong guess survivable are all still in force
        // below: nothing is held unless the island is visible AND acks that the
        // card is painted, the hold is capped at WAIT, and one unanswered card
        // silences the feature for a minute.
        if seen == NOTIFY_GRACE {
            plog("environment does not deliver Notification/permission_prompt —                   falling back to prediction (Claude Desktop / VS Code / Windows)");
        }
    }
    // Nobody answered the last card, so don't make this call wait to find that
    // out again. One unanswered card costs one pause, not one per tool call.
    if app.state::<PermissionHub>().is_quiet() {
        plog(&format!("pass (backing off, last card unanswered) {}", req.tool_name));
        return respond_http(&mut stream, PASS);
    }
    // If the island cannot actually show the card there is nobody to answer, so
    // waiting would freeze the agent for the full timeout for no reason.
    // Liveness: the window merely EXISTING is not enough. A webview can be
    // alive to the window server while its JS is wedged, unfocused-throttled or
    // mid-reload — and in that state nobody can press a button, so holding the
    // agent for the full timeout is pure damage. That is exactly how sessions
    // ended up frozen. We hold only after the island ACKs that it drew the card.
    let island_ready = app
        .get_webview_window("island")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if !island_ready {
        plog(&format!("pass (island not visible) {}", req.tool_name));
        return respond_http(&mut stream, PASS);
    }

    // Monotonic-ish unique id without pulling in uuid here.
    req.id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    let (ctx, task) = read_context(&req.transcript_path);
    req.context = ctx;
    req.task = task;

    // Auto mode still SHOWS the card — the point of a preview is that you can
    // see what is being approved. The island counts down and presses the button
    // itself, so the flow stays visible and auditable instead of silent.
    let modes = get_auto_modes();
    req.auto = match agent_of(&req) { "codex" => modes.codex.clone(), _ => modes.claude.clone() };

    // A remembered "always allow" answers instantly — the card never appears and
    // the agent is not made to wait on a decision the user already gave.
    if load_rules().iter().any(|r| r == &key) {
        return respond_http(
            &mut stream,
            &serde_json::json!({ "decision": "allow", "reason": "Always-allowed in Terse" }).to_string(),
        );
    }

    let (tx, rx) = channel::<String>();
    let (atx, arx) = channel::<()>();
    {
        let hub = app.state::<PermissionHub>();
        let mut p = hub.pending.lock().unwrap_or_else(|e| e.into_inner());
        p.insert(req.id.clone(), tx);
        drop(p);
        hub.arm_ack(&req.id, atx);
    }

    // Show the island's expanded card with the preview.
    // Context lengths only, never the text: this log exists to explain a hang,
    // and a user's conversation has no business being copied into a file that
    // outlives it.
    plog(&format!(
        "ASK {} id={} ctx={} task={}",
        req.tool_name, req.id, req.context.len(), req.task.len()
    ));
    let _ = app.emit("permission-request", &req);

    // Hold the agent only once the island has confirmed the card is painted.
    if arx.recv_timeout(ACK_WAIT).is_err() {
        let hub = app.state::<PermissionHub>();
        hub.cancel(&req.id);
        hub.cancel_ack(&req.id);
        let _ = app.emit("permission-timeout", &req.id);
        plog(&format!("pass (island did not ack in {}ms) id={}", ACK_WAIT.as_millis(), req.id));
        return respond_http(&mut stream, PASS);
    }

    let mut decision = rx.recv_timeout(WAIT).unwrap_or_else(|_| {
        // Timed out — drop the pending entry and let the terminal prompt win.
        let hub = app.state::<PermissionHub>();
        hub.cancel(&req.id);
        hub.go_quiet();
        let _ = app.emit("permission-timeout", &req.id);
        plog(&format!(
            "TIMEOUT after {}s → pass id={} (holding nothing for {}s)",
            WAIT.as_secs(), req.id, backoff().as_secs()
        ));
        "none".to_string()
    });

    // "always" is Terse's own vocabulary; Claude Code only understands allow.
    if decision == "always" {
        remember_rule(&key);
        decision = "allow".to_string();
    }
    plog(&format!("DECISION {decision} id={}", req.id));
    let payload = serde_json::json!({ "decision": decision, "reason": "Answered in Terse" });
    respond_http(&mut stream, &payload.to_string());
}

// ── Ground truth: what Claude Code ACTUALLY prompts for ──────────────────────
//
// Written only by the Notification/permission_prompt event, which fires when
// Claude Code has genuinely put a permission prompt on screen. Nothing else may
// add to this file — the moment a guess can write here, the island starts
// interrupting for calls nobody was asked about, which is the whole failure
// this replaces.

/// Keep the log to shapes, never contents.
///
/// A signature for a Bash call is short, but for an MCP tool it falls back to
/// the whole tool_input, and that was being appended verbatim to
/// ~/.terse/permission.log — entire scripts, file contents, query text. This log
/// exists to explain a stall and outlives the session it describes; it has no
/// business holding what the user was doing.
fn redact(key: &str) -> String {
    match key.split_once(':') {
        Some((head, rest)) if rest.len() > 48 => format!("{head}:<{} chars>", rest.len()),
        _ => key.to_string(),
    }
}

fn observed_path() -> std::path::PathBuf {
    home().join(".terse").join("permission-observed.json")
}

fn load_observed() -> Vec<String> {
    std::fs::read_to_string(observed_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// Coarse companion to the exact signature: "Claude Code has been seen to
/// prompt for this TOOL in this environment at all".
fn tool_key(tool: &str) -> String { format!("tool:{tool}") }

/// Has Claude Code ever really prompted for this?
///
/// TWO tiers, and the coarse one is what makes the feature work at all.
/// The exact signature alone is close to useless in practice: any command
/// containing a shell metacharacter keys on the WHOLE command line (see
/// rule_key), and real agent commands are heredocs, `cd x && y` chains and
/// pipelines — each unique, never repeated, so a signature learned from one
/// could never match anything again. The log was wall-to-wall
/// "never seen Claude prompt for this" for exactly that reason.
///
/// So the coarse tier records the tool. Once Claude Code has genuinely prompted
/// for a Bash command here, later Bash calls can reach the island — but only
/// those that ALSO survive needs_prompt(), which drops read-only commands and
/// anything the user's own allow rules already cover. Terse still starts
/// completely inert and still needs proof that this environment prompts at all;
/// a user in bypassPermissions or with broad allow rules never sees a card.
fn is_observed(key: &str, tool: &str) -> bool {
    // An env override exists purely so the end-to-end test can start from a
    // known state; it is never set in a shipped app.
    if std::env::var("TERSE_PERMISSION_ASSUME_OBSERVED").is_ok() {
        return true;
    }
    let v = load_observed();
    let tk = tool_key(tool);
    v.iter().any(|k| k == key || *k == tk)
}

fn mark_observed(key: &str) -> bool {
    let mut v = load_observed();
    if v.iter().any(|k| k == key) {
        return false;
    }
    v.push(key.to_string());
    // Keep it from growing forever in a long-lived install. Oldest out first;
    // anything evicted simply goes back to the terminal once and is re-learned.
    let max = 2000;
    if v.len() > max {
        let excess = v.len() - max;
        v.drain(0..excess);
    }
    let p = observed_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(txt) = serde_json::to_string_pretty(&v) {
        let _ = std::fs::write(&p, txt);
    }
    true
}

/// Notification/permission_prompt: Claude Code is asking the user, right now.
///
/// This handler must be fast and must never hold: Claude Code waits for the
/// hook to finish, and its own prompt is already on screen, so anything slow
/// here is dead time in front of a user who is being asked a question.
fn handle_notify(app: &AppHandle, body: &str, stream: &mut TcpStream) {
    // Reply first, work after. Nothing downstream depends on the answer.
    respond_http(stream, PASS);

    app.state::<PermissionHub>().note_notify();

    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return };
    let tool_use_id = v.get("toolUseId").and_then(|x| x.as_str()).unwrap_or("");
    let tool_name = v.get("toolName").and_then(|x| x.as_str()).unwrap_or("");

    // The signature comes from the PreToolUse call with the same tool_use_id.
    // Without a match there is nothing precise to record — and recording the
    // bare tool name would mean "Bash prompted once" turning into "hold every
    // Bash call forever", which is exactly the over-reach being removed.
    // The coarse tier is recorded even without a matching PreToolUse call: the
    // tool name arrives on the notification itself, and "Claude Code prompts for
    // Bash in this environment" is the fact that actually unlocks the feature.
    if !tool_name.is_empty() && mark_observed(&tool_key(tool_name)) {
        plog(&format!("notify: LEARNED Claude prompts for {tool_name} here"));
    }
    let Some(key) = app.state::<PermissionHub>().lookup_call(tool_use_id) else {
        plog(&format!("notify: no matching call for {tool_name} id={tool_use_id} — tool tier only"));
        return;
    };
    if mark_observed(&key) {
        plog(&format!("notify: LEARNED (Claude really prompts for this) {}", redact(&key)));
    }
    // Someone is being asked a question at a terminal, which means they are at
    // the keyboard — a good moment to stop backing off.
    app.state::<PermissionHub>().clear_quiet();
}

/// What the gate has learned, for the control page. Surfacing this is not a
/// nicety: "why did the island not ask me about that?" has exactly one honest
/// answer, and it is this list.
pub fn learned() -> Vec<String> { load_observed() }

/// Start over. Each cleared command simply goes back to the terminal once and
/// is re-learned from the next real prompt.
pub fn forget_learned() -> Result<(), String> {
    let p = observed_path();
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    plog("learned set cleared by user");
    Ok(())
}

/// Tail of ~/.terse/permission.log — the page shows it so a user can see what
/// the feature did without going hunting in a file.
pub fn recent_log(n: usize) -> Vec<String> {
    let p = home().join(".terse").join("permission.log");
    let Ok(txt) = std::fs::read_to_string(&p) else { return Vec::new() };
    txt.lines().rev().take(n).map(|l| l.to_string()).collect::<Vec<_>>()
        .into_iter().rev().collect()
}

/// Tools Claude Code can raise a permission prompt for.
///
/// Read, Grep, Glob, TodoWrite and friends are deliberately absent: they are
/// never gated, so intercepting them only produced noise. This list is the
/// difference between "the island asks about what you're being asked about"
/// and "the island interrupts every single tool call".
const GATED_TOOLS: &[&str] = &[
    "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch",
];

fn needs_prompt(req: &PermissionRequest) -> bool {
    let t = req.tool_name.as_str();
    // MCP tools are always user-approved, whatever the server.
    if !(GATED_TOOLS.contains(&t) || t.starts_with("mcp__")) {
        return false;
    }
    // A read-only shell command is waved through by Claude Code itself, so the
    // island must not put a card up for it. Without this the card fired for
    // `ls`, `git status`, `echo` — calls the user was never being asked about,
    // which is both noise and an agent held for no reason.
    if t == "Bash" && is_read_only_command(req) {
        return false;
    }
    match req.permission_mode.as_str() {
        // Nothing prompts at all.
        "bypassPermissions" => false,
        // Plan mode blocks side-effecting tools rather than asking.
        "plan" => false,
        // Edits are pre-approved here; Bash and the network tools still prompt.
        "acceptEdits" if matches!(t, "Write" | "Edit" | "NotebookEdit") => false,
        _ => !already_allowed(req),
    }
}

/// Shell programs that only read. Deliberately short: a wrong entry here means
/// a card the user never sees for a command that WAS worth seeing, so anything
/// with a write mode (`sed -i`, `tee`, `awk`), an installer, or a network
/// fetcher stays off the list.
/// `find` and `fd` are absent on purpose: `find . -delete` and `-exec rm {} \;`
/// are deletions wearing a search's clothes, and the first word of the line
/// cannot tell them apart from a plain search.
const READ_ONLY_PROGRAMS: &[&str] = &[
    "ls", "pwd", "echo", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep",
    "rg", "ag", "which", "type", "file", "stat", "date", "whoami",
    "uname", "hostname", "id", "du", "df", "tree", "basename", "dirname",
    "realpath", "uniq", "cut", "column", "jq", "printf", "true", "test",
];

/// `git`-style tools where only some subcommands are read-only. `git branch`
/// and `git remote` are excluded for the same reason as find: `branch -D` and
/// `remote add` share their first two words with the harmless listing form.
const READ_ONLY_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("git", &["status", "diff", "log", "show", "blame", "describe", "rev-parse", "ls-files"]),
    ("cargo", &["--version", "tree"]),
    ("npm", &["ls", "list", "view", "outdated"]),
    ("docker", &["ps", "images", "version"]),
    ("kubectl", &["get", "describe", "logs"]),
];

fn is_read_only_command(req: &PermissionRequest) -> bool {
    let Some(cmd) = req.tool_input.get("command").and_then(|v| v.as_str()) else {
        return false;
    };
    // Anything that can redirect, substitute or background is treated as
    // unknown: the interesting part of such a line is not its first word.
    if cmd.contains('>') || cmd.contains('<') || cmd.contains('`') || cmd.contains("$(") {
        return false;
    }
    let mut any = false;
    for seg in cmd.split("&&").flat_map(|s| s.split("||")).flat_map(|s| s.split(';')).flat_map(|s| s.split('|')) {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        any = true;
        let mut words = seg.split_whitespace();
        let Some(prog) = words.next() else { return false };
        // Strip a path so /bin/ls counts as ls.
        let prog = prog.rsplit('/').next().unwrap_or(prog);
        if READ_ONLY_PROGRAMS.contains(&prog) {
            continue;
        }
        // The first word that is not an option is the subcommand.
        let sub = words.find(|w| !w.starts_with('-')).unwrap_or("");
        match READ_ONLY_SUBCOMMANDS.iter().find(|(p, _)| *p == prog) {
            Some((_, subs)) if subs.contains(&sub) => continue,
            _ => return false,
        }
    }
    any
}

/// True when the user's own permission rules already cover this call, so Claude
/// Code will run it WITHOUT prompting.
///
/// This is the difference between a usable feature and a pest. A real project's
/// settings.local.json can hold thousands of allow rules; without consulting
/// them the island interrupts for calls the user long ago approved — which is
/// every call, for anyone who has been using Claude Code for a while.
///
/// Rules are read from the project first (that is where they accumulate) and
/// then the global file. Unreadable or unfamiliar rules are simply skipped:
/// mis-parsing one must never turn into "block the user with a card".
fn already_allowed(req: &PermissionRequest) -> bool {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    // Walk UP from the session's cwd. Claude Code resolves project settings from
    // the repo root, which is often above the directory the agent is working in
    // (monorepo packages, nested tooling dirs). Only checking cwd itself would
    // miss the rules for anyone not sitting exactly at the root.
    if !req.cwd.is_empty() {
        let mut dir = Some(std::path::Path::new(&req.cwd));
        let mut depth = 0;
        while let Some(d) = dir {
            let c = d.join(".claude");
            files.push(c.join("settings.local.json"));
            files.push(c.join("settings.json"));
            depth += 1;
            if depth > 12 {
                break;
            }
            dir = d.parent();
        }
    }
    if let Some(h) = Some(home()) {
        files.push(h.join(".claude").join("settings.local.json"));
        files.push(h.join(".claude").join("settings.json"));
    }

    for f in files {
        let Ok(txt) = std::fs::read_to_string(&f) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else { continue };
        let Some(perms) = v.get("permissions") else { continue };

        // A deny match means Claude Code blocks the call outright — it never
        // prompts, so there is nothing for the island to ask about either.
        for list in ["deny", "allow"] {
            let Some(rules) = perms.get(list).and_then(|a| a.as_array()) else { continue };
            for r in rules {
                let Some(rule) = r.as_str() else { continue };
                if rule_matches(rule, req) {
                    return true;
                }
            }
        }
    }
    false
}

/// Match one rule against the pending call.
///
/// Two shapes occur in practice:
///   `WebSearch`            — bare tool name, allows every call to that tool
///   `Bash(npm install:*)`  — `:*` suffix is a PREFIX match on the argument
///   `Bash(exact command)`  — everything else is exact
fn rule_matches(rule: &str, req: &PermissionRequest) -> bool {
    let tool = req.tool_name.as_str();
    let Some((rt, rest)) = rule.split_once('(') else {
        // Bare tool name. For MCP the server prefix alone covers every tool it
        // exposes, e.g. `mcp__github` allows `mcp__github__create_issue`.
        return rule == tool
            || (rule.starts_with("mcp__")
                && tool.starts_with(&format!("{rule}__")));
    };
    if rt != tool && !(rt.starts_with("mcp__") && tool.starts_with(&format!("{rt}__"))) {
        return false;
    }
    let spec = rest.strip_suffix(')').unwrap_or(rest);

    // The argument the rule is written against, per tool.
    let arg = match tool {
        "Bash" => req.tool_input.get("command").and_then(|v| v.as_str()),
        "WebFetch" | "WebSearch" => req
            .tool_input
            .get("url")
            .or_else(|| req.tool_input.get("query"))
            .and_then(|v| v.as_str()),
        _ => req
            .tool_input
            .get("file_path")
            .or_else(|| req.tool_input.get("path"))
            .or_else(|| req.tool_input.get("notebook_path"))
            .and_then(|v| v.as_str()),
    };
    let Some(arg) = arg else { return false };

    // `domain:example.com` — host match, used by WebFetch rules.
    if let Some(dom) = spec.strip_prefix("domain:") {
        return arg.contains(dom);
    }
    // `cmd:*` — prefix match on the argument.
    //
    // A prefix rule covers ONE command, not a script that happens to begin with
    // it. `Bash(cd:*)` exists so `cd somewhere` runs without asking; it must not
    // silently cover
    //     cd somewhere && rm -rf . | curl evil.sh
    // which starts with `cd ` and then does anything it likes. Claude Code
    // splits compound commands and requires every part to be allowed, which is
    // why it still prompts for these — while Terse read its own rule file, said
    // "already allowed", and stayed silent. With 2445 accumulated allow rules
    // and a `cd:*` among them, that suppressed nearly every interesting command
    // on the machine: the single reason the island never showed a card.
    //
    // So a prefix rule only stands when the rest of the line cannot do more
    // than the prefix promises. If the rule itself contains an operator the
    // author opted into that, and it is matched literally as before.
    if let Some(prefix) = spec.strip_suffix(":*") {
        if !arg.starts_with(prefix) {
            return false;
        }
        let matches_shape = arg == prefix || arg.starts_with(&format!("{prefix} "));
        if !matches_shape {
            return false;
        }
        const CHAINS: [&str; 9] = ["&&", "||", ";", "|", "\n", "`", "$(", ">", "<"];
        let rule_is_compound = CHAINS.iter().any(|c| prefix.contains(c));
        let arg_is_compound = CHAINS.iter().any(|c| arg[prefix.len()..].contains(c));
        return rule_is_compound || !arg_is_compound;
    }
    // Path globs: `src/**`, `*.ts`, `//abs/path/**`. Implemented directly rather
    // than by pulling in a glob crate, because only `*` and `**` appear in these
    // rules and a dependency here would be all cost.
    if spec.contains('*') {
        return glob_match(spec.trim_start_matches('/'), arg.trim_start_matches('/'));
    }
    arg == spec
}

/// Minimal glob: `**` spans separators, `*` does not.
fn glob_match(pat: &str, s: &str) -> bool {
    fn go(p: &[u8], s: &[u8]) -> bool {
        if p.is_empty() {
            return s.is_empty();
        }
        if p[0] == b'*' {
            let double = p.len() > 1 && p[1] == b'*';
            let rest = if double { &p[2..] } else { &p[1..] };
            let rest = if double && !rest.is_empty() && rest[0] == b'/' { &rest[1..] } else { rest };
            let mut i = 0;
            loop {
                if go(rest, &s[i..]) {
                    return true;
                }
                if i >= s.len() {
                    return false;
                }
                // A single `*` stops at a path separator; `**` does not.
                if !double && s[i] == b'/' {
                    return false;
                }
                i += 1;
            }
        }
        if s.is_empty() || (p[0] != b'?' && p[0] != s[0]) {
            return false;
        }
        go(&p[1..], &s[1..])
    }
    go(pat.as_bytes(), s.as_bytes())
}

/// Pull the surrounding turn out of the session transcript: what the agent last
/// said out loud, and what the user last asked for.
///
/// Read from the END of the file. A long session's transcript runs to many MB
/// and this sits in the agent's critical path, so only the tail is touched and
/// the whole thing is best-effort — no context is a worse card, never a hang.
fn read_context(path: &str) -> (String, String) {
    if path.is_empty() {
        return (String::new(), String::new());
    }
    let Ok(mut f) = std::fs::File::open(path) else { return (String::new(), String::new()) };
    let Ok(meta) = f.metadata() else { return (String::new(), String::new()) };
    const TAIL: u64 = 256 * 1024;
    let start = meta.len().saturating_sub(TAIL);
    use std::io::Seek;
    if f.seek(std::io::SeekFrom::Start(start)).is_err() {
        return (String::new(), String::new());
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (String::new(), String::new());
    }
    let text = String::from_utf8_lossy(&buf);

    let mut said = String::new();
    let mut asked = String::new();
    // Newest first: the last thing said is the reason for the call in hand.
    for line in text.lines().rev() {
        if said.len() > 0 && !asked.is_empty() {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let role = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let content = v.get("message").and_then(|m| m.get("content"));
        if role == "assistant" && said.is_empty() {
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                for b in arr {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            let t = t.trim();
                            if !t.is_empty() {
                                said = clip(t, 240);
                            }
                        }
                    }
                }
            }
        } else if role == "user" && asked.is_empty() {
            // Tool RESULTS are also "user" rows; those are not a request.
            let is_result = content
                .and_then(|c| c.as_array())
                .map(|a| a.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result")))
                .unwrap_or(false);
            if is_result {
                continue;
            }
            let txt = match content {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            let txt = txt.trim();
            // Skip the harness's own injected blocks — they are not the ask.
            if !txt.is_empty() && !txt.starts_with("<") {
                asked = clip(txt, 160);
            }
        }
    }
    (said, asked)
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        return s;
    }
    s.chars().take(n).collect::<String>() + "…"
}

/// Read one HTTP/1.1 request and return its body. Only Content-Length framing
/// is supported, which is all the hook sends.
/// Returns (path, body). The path is what tells the two hook events apart:
/// `/permission` can decide, `/notify` only observes.
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut len = 0usize;
    let mut path = String::new();
    let mut first = true;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let t = line.trim_end();
        if first {
            // "POST /permission HTTP/1.1"
            path = t.split_whitespace().nth(1).unwrap_or("/").to_string();
            first = false;
            continue;
        }
        if t.is_empty() {
            break; // end of headers
        }
        if let Some(v) = t.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    if len == 0 || len > 1_000_000 {
        return None;
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).ok()?;
    Some((path, String::from_utf8(buf).ok()?))
}

fn respond_http(stream: &mut TcpStream, json: &str) {
    let res = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        json.len(),
        json
    );
    let _ = stream.write_all(res.as_bytes());
    let _ = stream.flush();
}


// ── Auto-approval ────────────────────────────────────────────────────────────
//
// Answers prompts without asking. This is the same power as Claude Code's
// bypass mode, so it is off by default, stored per agent, and never inferred —
// only an explicit choice in the UI turns it on.
//
//   "off"    ask as normal
//   "once"   answer allow, decision applies to this call only
//   "always" answer allow AND remember the rule, so it stops asking
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoModes {
    #[serde(default)]
    pub claude: String,
    #[serde(default)]
    pub codex: String,
}

fn auto_path() -> std::path::PathBuf {
    home().join(".terse").join("permission-auto.json")
}

pub fn get_auto_modes() -> AutoModes {
    std::fs::read_to_string(auto_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn set_auto_modes(m: AutoModes) -> Result<(), String> {
    let p = auto_path();
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    let txt = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    std::fs::write(&p, txt).map_err(|e| e.to_string())?;
    plog(&format!("auto modes set: claude={} codex={}", m.claude, m.codex));
    Ok(())
}

/// Which agent a request came from.
///
/// The PreToolUse hook is Claude Code's own mechanism, so anything arriving
/// here is Claude unless it says otherwise. `agent` is accepted on the payload
/// so a future Codex-side integration can identify itself without changing
/// anything else.
fn agent_of(req: &PermissionRequest) -> &'static str {
    if req.agent.eq_ignore_ascii_case("codex")
        || req.session_id.to_ascii_lowercase().contains("codex")
    {
        "codex"
    } else {
        "claude"
    }
}

// ── Remembered "always allow" decisions ──────────────────────────────────────
//
// Deliberately NOT written into ~/.claude/settings.json's permissions.allow.
// That would mean generating Claude Code rule syntax (`Bash(npm test:*)` and
// friends) from arbitrary tool input; a wrong guess writes broken rules into
// the user's own config, and an over-broad one silently widens what the agent
// may do forever. Terse remembers the decision on its own side instead, where
// the matching is exact and revocable by deleting one file.
fn rules_path() -> std::path::PathBuf {
    home().join(".terse").join("permission-rules.json")
}

/// A stable, CONSERVATIVE signature for "this kind of call".
///
/// For Bash this is the program plus its first non-option argument (`npm test`,
/// `rm build`), not the whole command line — so approving `npm test` does not
/// also approve `npm publish`, and never approves an unrelated binary. Anything
/// we cannot characterise falls back to the tool name plus the full input,
/// which simply means it only ever matches an identical call.
///
/// Skipping OPTIONS to find that argument is the whole point, and taking the
/// literal second word instead was a real hole: `rm -rf build` and `rm -rf /etc`
/// both reduce to `rm -rf`, so they were the same signature. This key also backs
/// the "always allow" rules — meaning one approval of `rm -rf build` silently
/// covered `rm -rf` of anything else, forever. Keyed on the target instead, the
/// two are distinct and each has to be approved on its own.
fn rule_key(req: &PermissionRequest) -> String {
    let t = req.tool_name.as_str();
    if t == "Bash" {
        if let Some(cmd) = req.tool_input.get("command").and_then(|v| v.as_str()) {
            let mut it = cmd.split_whitespace();
            let a = it.next().unwrap_or("");
            // The first word that is not a flag: the subcommand for `git status`,
            // the target for `rm -rf build`.
            let b = it.find(|w| !w.starts_with('-')).unwrap_or("");
            // A shell metacharacter means the rest of the line can do anything,
            // so such a command is never generalised — exact match only.
            if !cmd.contains(|c| matches!(c, ';' | '|' | '&' | '`' | '$' | '>' | '<')) {
                return format!("Bash:{a} {b}").trim_end().to_string();
            }
            return format!("Bash!:{cmd}");
        }
    }
    for k in ["file_path", "url", "pattern"] {
        if let Some(v) = req.tool_input.get(k).and_then(|x| x.as_str()) {
            return format!("{t}:{k}={v}");
        }
    }
    format!("{t}:{}", req.tool_input)
}

fn load_rules() -> Vec<String> {
    std::fs::read_to_string(rules_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn remember_rule(key: &str) {
    let mut r = load_rules();
    if r.iter().any(|x| x == key) {
        return;
    }
    r.push(key.to_string());
    let dir = rules_path();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(txt) = serde_json::to_string_pretty(&r) {
        let _ = std::fs::write(rules_path(), txt);
    }
}

/// Deploy the hook script and register it in ~/.claude/settings.json.
///
/// Merge rules, in order of importance:
///   1. Never write to a settings.json we could not parse — a malformed file is
///      far more likely to be mid-edit than genuinely broken, and clobbering it
///      would destroy the user's configuration.
///   2. Only ever touch hooks.PreToolUse, and inside it only the entry whose
///      command mentions terse-permission-hook.js. Every other hook the user
///      has is left byte-identical.
///   3. Append, never replace the array.
///   4. Idempotent: running on every launch updates our own entry in place.
pub fn install_hook() -> Result<bool, String> {
    if !enabled() {
        plog("install skipped (feature off)");
        return Ok(false);
    }
    let home = home();
    let terse_dir = home.join(".terse");
    std::fs::create_dir_all(&terse_dir).map_err(|e| e.to_string())?;

    let script = terse_dir.join("terse-permission-hook.js");
    let src = include_str!("../../../src/helpers/terse-permission-hook.js");
    std::fs::write(&script, src).map_err(|e| e.to_string())?;

    let settings = home.join(".claude").join("settings.json");
    let mut root: serde_json::Value = if settings.exists() {
        let txt = std::fs::read_to_string(&settings).map_err(|e| e.to_string())?;
        if txt.trim().is_empty() {
            serde_json::json!({})
        } else {
            // Rule 1: bail out rather than overwrite something we cannot read.
            serde_json::from_str(&txt)
                .map_err(|e| format!("settings.json is not valid JSON, leaving it alone: {e}"))?
        }
    } else {
        serde_json::json!({})
    };

    // Quoted, unlike the macOS original. A Windows home directory routinely has
    // a space in it - "C:\\Users\\First Last" is what the installer makes from a
    // Microsoft account name - and `node C:\\Users\\First Last\\.terse\\hook.js` parses
    // as node plus two arguments. The hook then never runs, and a hook that
    // never runs is indistinguishable from the feature being switched off.
    let cmd = format!("node \"{}\"", script.display());
    // Match only the tools that can prompt. "*" registered us for EVERY tool
    // call, so even with the server-side gate the hook process was spawned for
    // Read/Grep/TodoWrite — pure overhead on the agent's hot path.
    //
    // `timeout` is the hard ceiling on how long this hook may hold a tool call.
    // 60s was far longer than anything the code can actually wait for (WAIT +
    // ACK_WAIT ≈ 11s, and the script self-terminates at 16.5s), so it only ever
    // mattered when something had already gone wrong — at which point it let a
    // wedged hook sit on the call for a minute. 20s leaves headroom over the
    // real ceiling and caps the damage.
    let pre_entry = serde_json::json!({
        "matcher": "Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch|mcp__.*",
        "hooks": [ { "type": "command", "command": cmd, "timeout": 20 } ]
    });
    // The observation half. This one can never decide anything and never holds
    // a call — it is how Terse learns which calls Claude Code genuinely prompts
    // for, which is what keeps the island from interrupting anything else.
    let notify_entry = serde_json::json!({
        "matcher": "permission_prompt",
        "hooks": [ { "type": "command", "command": cmd, "timeout": 5 } ]
    });

    let mine = |v: &serde_json::Value| -> bool {
        v.get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| {
                hs.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.contains("terse-permission-hook.js"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    };

    let mut changed = false;
    {
        let hooks = root
            .as_object_mut()
            .ok_or("settings.json root is not an object")?
            .entry("hooks")
            .or_insert_with(|| serde_json::json!({}));
        let hooks_obj = hooks.as_object_mut().ok_or("hooks is not an object")?;

        for (event, entry) in [("PreToolUse", pre_entry), ("Notification", notify_entry)] {
            let slot = hooks_obj.entry(event).or_insert_with(|| serde_json::json!([]));
            let arr = slot.as_array_mut().ok_or(format!("{event} is not an array"))?;
            match arr.iter().position(mine) {
                Some(i) => {
                    if arr[i] != entry {
                        arr[i] = entry;
                        changed = true;
                    }
                }
                None => {
                    arr.push(entry);
                    changed = true;
                }
            }
        }
    }

    if changed {
        if settings.exists() {
            let _ = std::fs::copy(&settings, settings.with_extension("json.terse-bak"));
        }
        if let Some(parent) = settings.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        std::fs::write(&settings, out).map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

/// Remove Terse's hook, leaving every other hook untouched.
pub fn uninstall_hook() -> Result<bool, String> {
    let settings = home().join(".claude").join("settings.json");
    if !settings.exists() {
        return Ok(false);
    }
    let txt = std::fs::read_to_string(&settings).map_err(|e| e.to_string())?;
    let mut root: serde_json::Value =
        serde_json::from_str(&txt).map_err(|_| "settings.json is not valid JSON".to_string())?;

    // BOTH events, or the observation half is left behind wired to a script the
    // uninstall just orphaned — a hook that runs on every permission prompt for
    // a feature the user has turned off.
    let mut changed = false;
    for event in ["PreToolUse", "Notification"] {
        let Some(arr) = root
            .get_mut("hooks")
            .and_then(|h| h.get_mut(event))
            .and_then(|p| p.as_array_mut())
        else {
            continue;
        };
        let before = arr.len();
        arr.retain(|v| {
            !v.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.contains("terse-permission-hook.js"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });
        if arr.len() != before {
            changed = true;
        }
        // Leave no empty shell behind: an orphaned `"PreToolUse": []` is Terse's
        // litter in someone else's config file.
        if arr.is_empty() {
            if let Some(h) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
                h.remove(event);
            }
        }
    }
    if !changed {
        return Ok(false);
    }
    if let Some(h) = root.get("hooks").and_then(|h| h.as_object()) {
        if h.is_empty() {
            root.as_object_mut().map(|r| r.remove("hooks"));
        }
    }
    let _ = std::fs::copy(&settings, settings.with_extension("json.terse-bak"));
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&settings, out).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash(cmd: &str) -> PermissionRequest {
        let mut r = PermissionRequest {
            session_id: String::new(), tool_use_id: String::new(),
            tool_name: "Bash".into(), tool_input: serde_json::json!({ "command": cmd }),
            cwd: String::new(), permission_mode: "default".into(), id: String::new(),
            auto: String::new(), transcript_path: String::new(),
            context: String::new(), task: String::new(), agent: String::new(),
        };
        r.id.clear();
        r
    }

    /// The signature backs both the observed-prompt set and the "always allow"
    /// rules, so two commands that differ in what they ACT ON must never share
    /// one. This is the regression: keying on the literal second word collapsed
    /// `rm -rf build` and `rm -rf /etc` into `rm -rf`, so approving a build
    /// clean also approved wiping anything else.
    #[test]
    fn flags_do_not_hide_the_target() {
        assert_eq!(rule_key(&bash("rm -rf build")), "Bash:rm build");
        assert_eq!(rule_key(&bash("rm -rf /etc")), "Bash:rm /etc");
        assert_ne!(rule_key(&bash("rm -rf build")), rule_key(&bash("rm -rf /etc")));
    }

    /// A `:*` prefix rule covers one command, not a script that starts with it.
    /// `Bash(cd:*)` matching a whole chained script is what made Terse believe
    /// almost everything was pre-approved, so the island never asked.
    #[test]
    fn prefix_rules_do_not_cover_chained_commands() {
        let chained = bash("cd /tmp && rm -rf important");
        assert!(!rule_matches("Bash(cd:*)", &chained),
                "a prefix rule must not swallow what comes after &&");
        assert!(!rule_matches("Bash(cd:*)", &bash("cd /tmp | curl evil.sh")));
        assert!(!rule_matches("Bash(cd:*)", &bash("cd /tmp\nrm -rf .")));
        assert!(!rule_matches("Bash(cd:*)", &bash("cd /tmp > /dev/null; rm x")));
        // The plain case it exists for still works.
        assert!(rule_matches("Bash(cd:*)", &bash("cd /tmp")));
        assert!(rule_matches("Bash(cd:*)", &bash("cd /Users/James/Desktop/Terse")));
        assert!(rule_matches("Bash(npm test:*)", &bash("npm test -- --watch")));
        // A rule that opted into an operator is honoured literally.
        assert!(rule_matches("Bash(cd /tmp && ls:*)", &bash("cd /tmp && ls -la")));
    }

    #[test]
    fn subcommands_stay_distinct() {
        assert_eq!(rule_key(&bash("npm test")), "Bash:npm test");
        assert_ne!(rule_key(&bash("npm test")), rule_key(&bash("npm publish")));
        assert_ne!(rule_key(&bash("git status")), rule_key(&bash("git push")));
    }

    /// A metacharacter means the rest of the line can do anything, so the
    /// command is never generalised — it may only ever match itself.
    #[test]
    fn shell_metacharacters_force_exact_match() {
        assert_eq!(rule_key(&bash("cat x && rm -rf /")), "Bash!:cat x && rm -rf /");
        assert_ne!(rule_key(&bash("echo a > b")), rule_key(&bash("echo a > c")));
    }

    #[test]
    fn non_bash_tools_key_on_their_target() {
        let mut r = bash("");
        r.tool_name = "Write".into();
        r.tool_input = serde_json::json!({ "file_path": "/tmp/a", "content": "x" });
        assert_eq!(rule_key(&r), "Write:file_path=/tmp/a");
        r.tool_input = serde_json::json!({ "file_path": "/tmp/b", "content": "x" });
        assert_eq!(rule_key(&r), "Write:file_path=/tmp/b");
    }
}

#[cfg(test)]
mod hook_tests {
    use super::*;

    /// install_hook / uninstall_hook edit the user's real ~/.claude/settings.json,
    /// so they are exercised against a throwaway home.
    ///
    /// Through TEST_HOME rather than $HOME, which is what the macOS original
    /// does: dirs::home_dir() honours $HOME on unix, but on Windows it goes to
    /// SHGetKnownFolderPath and ignores the environment entirely — so the copied
    /// test wrote its fixture into a temp dir and then asserted against the real
    /// profile, and failed on the first line.
    ///
    /// One test rather than several: $HOME is process-wide, and cargo runs tests
    /// in parallel threads, so splitting these would let them race each other.
    #[test]
    fn installs_and_removes_both_events_without_touching_anything_else() {
        let tmp = std::env::temp_dir().join(format!("terse-hooktest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        *TEST_HOME.lock().unwrap_or_else(|e| e.into_inner()) = Some(tmp.clone());

        // A settings.json that already has the user's own hooks in it.
        let original = serde_json::json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "my-own-linter" }] }
                ],
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "say done" }] }
                ]
            }
        });
        let settings = tmp.join(".claude").join("settings.json");
        std::fs::write(&settings, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        std::fs::create_dir_all(tmp.join(".terse")).unwrap();
        std::fs::write(tmp.join(".terse").join("permission-on"), b"1").unwrap();
        assert!(enabled(), "flag file should make the feature enabled");

        assert!(install_hook().unwrap(), "first install should change the file");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();

        let ours = |arr: &serde_json::Value| -> usize {
            arr.as_array().unwrap().iter()
                .filter(|e| serde_json::to_string(e).unwrap().contains("terse-permission-hook.js"))
                .count()
        };
        assert_eq!(ours(&v["hooks"]["PreToolUse"]), 1, "PreToolUse entry added");
        assert_eq!(ours(&v["hooks"]["Notification"]), 1, "Notification entry added");
        assert_eq!(v["hooks"]["Notification"][0]["matcher"], "permission_prompt");
        // The user's own config must come through untouched.
        assert_eq!(v["model"], "opus");
        assert_eq!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "my-own-linter");
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");

        // Idempotent: a second install is a no-op.
        assert!(!install_hook().unwrap(), "second install should change nothing");

        assert!(uninstall_hook().unwrap(), "uninstall should change the file");
        let v2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(ours(&v2["hooks"]["PreToolUse"]), 0, "our PreToolUse entry gone");
        assert!(v2["hooks"].get("Notification").is_none(),
                "Notification array held only our entry, so it should be gone entirely");
        // Everything of the user's survives.
        assert_eq!(v2["model"], "opus");
        assert_eq!(v2["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "my-own-linter");
        assert_eq!(v2["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");

        assert!(!uninstall_hook().unwrap(), "second uninstall should change nothing");

        // A settings.json we cannot parse is never written to.
        std::fs::write(&settings, "{ this is not json").unwrap();
        assert!(install_hook().is_err(), "must refuse an unparseable settings.json");
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{ this is not json");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
