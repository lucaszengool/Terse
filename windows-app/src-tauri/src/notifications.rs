//! Unified alert layer for Terse.
//!
//! One dispatcher routes every proactive alert — Doctor findings, disk cleanup,
//! budget burn, cache regressions, model-routing nudges, context overflow —
//! through the channels the user opted into: the native macOS Notification
//! Center (via `osascript`, so no extra crate/capability), a Slack incoming
//! webhook, and the in-app Alert Center (a `tauri` event + a persisted ring
//! buffer the UI reads back).
//!
//! Settings + the recent-alert history live in `~/.terse/alerts.json`.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// How many past alerts the Alert Center keeps.
const MAX_RECENT: usize = 120;

/// Alert families the dispatcher understands. Kept in sync with the Alert
/// Center UI so per-kind toggles line up.
///
/// `agent`   — attention layer: an agent finished / is blocked on a permission /
///             went idle waiting for you.
/// `summary` — a session completion report card.
/// `digest`  — the weekly roll-up.
pub const KINDS: &[&str] = &[
    "doctor", "cleanup", "budget", "cache", "routing", "context", "agent", "summary", "digest",
];

fn alerts_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("alerts.json")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn severity_rank(sev: &str) -> u8 {
    match sev {
        "high" => 2,
        "medium" => 1,
        _ => 0,
    }
}

/// User-controlled routing preferences for the alert layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertSettings {
    /// Master switch — off means nothing fires or records.
    pub enabled: bool,
    /// Post to the macOS Notification Center.
    pub native: bool,
    /// Post to the Slack webhook.
    pub slack: bool,
    /// Record to the in-app Alert Center + emit a live toast.
    #[serde(rename = "inApp", default = "yes")]
    pub in_app: bool,
    /// Slack incoming-webhook URL (the user's secret; only ever sent to Slack).
    #[serde(rename = "slackWebhook", default)]
    pub slack_webhook: String,
    /// Lowest severity that is allowed to fire: `low` | `medium` | `high`.
    #[serde(rename = "minSeverity", default = "medium")]
    pub min_severity: String,
    /// Per-kind enable map (see `KINDS`).
    #[serde(default)]
    pub kinds: HashMap<String, bool>,
    /// Minimum minutes between two alerts that share a dedupe key.
    #[serde(rename = "throttleMinutes", default = "default_throttle")]
    pub throttle_minutes: u64,
    /// Quiet-hours window (local hour, 0–23). Native + Slack are muted inside
    /// it; alerts are still recorded so the Center shows them later.
    #[serde(rename = "quietStart", default)]
    pub quiet_start: Option<u8>,
    #[serde(rename = "quietEnd", default)]
    pub quiet_end: Option<u8>,
    /// Send a phone push via an [ntfy](https://ntfy.sh) topic. This is the
    /// "get it on your phone" channel — the user subscribes to the topic in the
    /// free ntfy app; we POST the alert body to it.
    #[serde(default)]
    pub push: bool,
    /// ntfy topic URL, e.g. `https://ntfy.sh/terse-a1b2c3`. Only the alert text
    /// is ever sent here.
    #[serde(rename = "pushUrl", default)]
    pub push_url: String,
    /// Per-kind snooze: kind → unix-seconds until which the kind is muted on all
    /// channels (still recorded to the Center). Set by the "Snooze" action.
    #[serde(default)]
    pub snooze: HashMap<String, u64>,
}

fn yes() -> bool { true }
fn medium() -> String { "medium".into() }
fn default_throttle() -> u64 { 60 }

impl Default for AlertSettings {
    fn default() -> Self {
        let mut kinds = HashMap::new();
        for k in KINDS {
            kinds.insert((*k).to_string(), true);
        }
        AlertSettings {
            enabled: true,
            native: true,
            slack: false,
            in_app: true,
            slack_webhook: String::new(),
            min_severity: "medium".into(),
            kinds,
            throttle_minutes: 60,
            quiet_start: None,
            quiet_end: None,
            push: false,
            push_url: String::new(),
            snooze: HashMap::new(),
        }
    }
}

impl AlertSettings {
    /// Is `hour` (0–23) inside the quiet window? Handles wrap-around windows
    /// like 22→7.
    fn in_quiet_hours(&self, hour: u8) -> bool {
        match (self.quiet_start, self.quiet_end) {
            (Some(s), Some(e)) if s != e => {
                if s < e {
                    hour >= s && hour < e
                } else {
                    hour >= s || hour < e
                }
            }
            _ => false,
        }
    }
}

/// One recorded alert. `id` is monotonic within a run; `ts` is unix seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub severity: String,
    pub ts: u64,
    #[serde(default)]
    pub read: bool,
    /// Optional UI hint (e.g. `open-doctor`, `open-cleanup`, `open-budget`)
    /// the Alert Center turns into an action button.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Persisted {
    #[serde(default)]
    settings: AlertSettings,
    #[serde(default)]
    recent: VecDeque<AlertRecord>,
}

pub struct AlertCenter {
    settings: AlertSettings,
    recent: VecDeque<AlertRecord>,
    /// dedupe key → last fire time (unix seconds). In-memory only.
    last_fired: HashMap<String, u64>,
    file_path: PathBuf,
    seq: u64,
}

impl AlertCenter {
    pub fn new() -> Self {
        let file_path = alerts_path();
        let p: Persisted = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Persisted::default()
        };
        AlertCenter {
            settings: p.settings,
            recent: p.recent,
            last_fired: HashMap::new(),
            file_path,
            seq: 0,
        }
    }

    fn save(&self) {
        if let Some(dir) = self.file_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let p = Persisted {
            settings: self.settings.clone(),
            recent: self.recent.clone(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&p) {
            let _ = fs::write(&self.file_path, json);
        }
    }

    pub fn settings_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.settings).unwrap_or_default()
    }

    pub fn set_settings(&mut self, v: serde_json::Value) {
        if let Ok(mut s) = serde_json::from_value::<AlertSettings>(v) {
            // Keep every known kind present so the UI never sees a gap.
            for k in KINDS {
                s.kinds.entry((*k).to_string()).or_insert(true);
            }
            self.settings = s;
            self.save();
        }
    }

    pub fn recent_json(&self) -> serde_json::Value {
        let unread = self.recent.iter().filter(|a| !a.read).count();
        serde_json::json!({
            "alerts": self.recent.iter().collect::<Vec<_>>(),
            "unread": unread,
        })
    }

    pub fn mark_all_read(&mut self) {
        for a in self.recent.iter_mut() {
            a.read = true;
        }
        self.save();
    }

    pub fn clear(&mut self) {
        self.recent.clear();
        self.save();
    }

    /// Decide whether an alert of `kind`/`severity` is allowed to fire right
    /// now. Enforces the master switch, per-kind toggle, severity floor and the
    /// per-dedupe-key throttle.
    fn should_fire(&self, kind: &str, severity: &str, dedupe_key: &str, now: u64) -> bool {
        let s = &self.settings;
        if !s.enabled {
            return false;
        }
        if !s.kinds.get(kind).copied().unwrap_or(true) {
            return false;
        }
        // Per-kind snooze: muted until the stored timestamp passes.
        if let Some(&until) = s.snooze.get(kind) {
            if now < until {
                return false;
            }
        }
        if severity_rank(severity) < severity_rank(&s.min_severity) {
            return false;
        }
        if let Some(&last) = self.last_fired.get(dedupe_key) {
            if now.saturating_sub(last) < s.throttle_minutes * 60 {
                return false;
            }
        }
        true
    }

    fn record(&mut self, kind: &str, title: &str, body: &str, severity: &str, action: Option<String>, now: u64) -> AlertRecord {
        self.seq += 1;
        let rec = AlertRecord {
            id: format!("{}-{}", now, self.seq),
            kind: kind.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            severity: severity.to_string(),
            ts: now,
            read: false,
            action,
        };
        self.recent.push_front(rec.clone());
        while self.recent.len() > MAX_RECENT {
            self.recent.pop_back();
        }
        self.save();
        rec
    }
}

impl Default for AlertCenter {
    fn default() -> Self {
        Self::new()
    }
}

/// Escape a string for embedding inside an AppleScript double-quoted literal.
fn as_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' | '\r' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(target_os = "macos")]
fn notify_native(title: &str, body: &str) {
    // subtitle carries the alert's own title; the app name stays "Terse".
    let script = format!(
        "display notification {} with title \"Terse\" subtitle {}",
        as_quote(body),
        as_quote(title)
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

#[cfg(not(target_os = "macos"))]
fn notify_native(_title: &str, _body: &str) {}

fn post_slack(webhook: &str, text: &str) {
    let body = serde_json::json!({ "text": text }).to_string();
    let _ = crate::hidden_command("curl")
        .arg("-sS").arg("-X").arg("POST")
        .arg("-H").arg("Content-Type: application/json")
        .arg("--data").arg(&body)
        .arg("--max-time").arg("10")
        .arg(webhook)
        .output();
}

/// Post a plain-text phone push to an ntfy topic. `title` becomes the push
/// title header; `severity` maps to ntfy priority + a tag emoji.
fn post_push(topic_url: &str, title: &str, body: &str, severity: &str) {
    let (prio, tag) = match severity {
        "high" => ("urgent", "rotating_light"),
        "medium" => ("high", "warning"),
        _ => ("default", "information_source"),
    };
    let _ = crate::hidden_command("curl")
        .arg("-sS").arg("-X").arg("POST")
        .arg("-H").arg(format!("Title: Terse — {}", title.replace(['\n', '\r'], " ")))
        .arg("-H").arg(format!("Priority: {}", prio))
        .arg("-H").arg(format!("Tags: {}", tag))
        .arg("--data").arg(body)
        .arg("--max-time").arg("10")
        .arg(topic_url)
        .output();
}

/// The single entry point every alert source calls. Applies the user's routing
/// rules, records the alert, and fans it out to the enabled channels.
///
/// `dedupe_key` collapses repeats (e.g. the same Doctor finding id) under the
/// throttle window so a background loop can call this every cycle safely.
pub fn dispatch(
    app: &AppHandle,
    kind: &str,
    title: &str,
    body: &str,
    severity: &str,
    dedupe_key: &str,
    action: Option<String>,
) {
    let state = app.state::<crate::AppState>();
    let now = now_unix();
    let hour = chrono::Local::now().format("%H").to_string().parse::<u8>().unwrap_or(0);

    let (rec, do_native, do_slack, webhook, do_in_app, do_push, push_url) = {
        let mut ac = state.alerts.lock().unwrap_or_else(|e| e.into_inner());
        if !ac.should_fire(kind, severity, dedupe_key, now) {
            return;
        }
        ac.last_fired.insert(dedupe_key.to_string(), now);
        let rec = ac.record(kind, title, body, severity, action, now);
        let quiet = ac.settings.in_quiet_hours(hour);
        (
            rec,
            ac.settings.native && !quiet,
            ac.settings.slack && !quiet && ac.settings.slack_webhook.starts_with("https://hooks.slack.com/"),
            ac.settings.slack_webhook.clone(),
            ac.settings.in_app,
            ac.settings.push && !quiet && ac.settings.push_url.starts_with("https://"),
            ac.settings.push_url.clone(),
        )
    };

    if do_in_app {
        let _ = app.emit("alert", &rec);
    }
    if do_native {
        notify_native(title, body);
    }
    if do_slack {
        let sev_icon = match severity { "high" => "🔴", "medium" => "🟠", _ => "🔵" };
        let msg = format!("{} *Terse — {}*\n{}", sev_icon, title, body);
        let w = webhook.clone();
        std::thread::spawn(move || post_slack(&w, &msg));
    }
    if do_push {
        let (t, b, s) = (title.to_string(), body.to_string(), severity.to_string());
        std::thread::spawn(move || post_push(&push_url, &t, &b, &s));
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_alert_settings(state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.alerts.lock().unwrap_or_else(|e| e.into_inner()).settings_json()
}

#[tauri::command]
pub fn set_alert_settings(settings: serde_json::Value, state: tauri::State<'_, crate::AppState>) -> bool {
    state.alerts.lock().unwrap_or_else(|e| e.into_inner()).set_settings(settings);
    true
}

#[tauri::command]
pub fn get_recent_alerts(state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.alerts.lock().unwrap_or_else(|e| e.into_inner()).recent_json()
}

#[tauri::command]
pub fn mark_alerts_read(state: tauri::State<'_, crate::AppState>) -> bool {
    state.alerts.lock().unwrap_or_else(|e| e.into_inner()).mark_all_read();
    true
}

#[tauri::command]
pub fn clear_alerts(state: tauri::State<'_, crate::AppState>) -> bool {
    state.alerts.lock().unwrap_or_else(|e| e.into_inner()).clear();
    true
}

/// Fire an alert on demand — used by the "Send test alert" button and by any
/// frontend flow that wants to surface something through the same pipeline.
#[tauri::command]
pub fn dispatch_alert(
    app: AppHandle,
    kind: String,
    title: String,
    body: String,
    severity: String,
) {
    let k = if KINDS.contains(&kind.as_str()) { kind.clone() } else { "doctor".to_string() };
    // Manual/test alerts bypass the throttle by using a unique dedupe key.
    let dedupe = format!("manual:{}:{}", k, now_unix());
    dispatch(&app, &k, &title, &body, &severity, &dedupe, None);
}

/// Snooze (or un-snooze) a whole alert kind for `minutes`. Passing `minutes = 0`
/// clears an active snooze. Backs the "Snooze" inline action on toasts.
#[tauri::command]
pub fn snooze_alert_kind(kind: String, minutes: u64, state: tauri::State<'_, crate::AppState>) -> bool {
    let mut ac = state.alerts.lock().unwrap_or_else(|e| e.into_inner());
    if minutes == 0 {
        ac.settings.snooze.remove(&kind);
    } else {
        ac.settings.snooze.insert(kind, now_unix() + minutes * 60);
    }
    ac.save();
    true
}

/// Route a proactive alert through the same pipeline from Rust callers
/// (agent_monitor, circuit breaker, digest). Thin wrapper so other modules don't
/// need to reach into `dispatch`'s full signature.
pub fn notify(app: &AppHandle, kind: &str, title: &str, body: &str, severity: &str, dedupe_key: &str, action: Option<&str>) {
    dispatch(app, kind, title, body, severity, dedupe_key, action.map(|s| s.to_string()));
}
