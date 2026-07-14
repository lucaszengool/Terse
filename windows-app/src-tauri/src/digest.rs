//! Weekly digest — one consolidated "here's what Terse saved you" roll-up,
//! delivered at most once per ISO week instead of a stream of pings.
//!
//! State (the last week we sent) lives in `~/.terse/digest.json`.

use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

fn digest_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("digest.json")
}

/// ISO week label like `2026-W28`, used to fire exactly once per week.
fn iso_week_now() -> String {
    let now = chrono::Local::now();
    let iso = now.iso_week();
    format!("{}-W{:02}", iso.year(), iso.week())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DigestState {
    #[serde(default)]
    last_week: String,
}

fn load_state() -> DigestState {
    fs::read_to_string(digest_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(s: &DigestState) {
    if let Some(dir) = digest_path().parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(j) = serde_json::to_string_pretty(s) {
        let _ = fs::write(digest_path(), j);
    }
}

/// Throttle the once-per-hour eligibility check so the 5s scan loop doesn't
/// recompute stats every tick.
static LAST_CHECK: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Build the digest payload from this week's stats. Returns None if there's
/// nothing worth reporting (no savings and no spend).
fn build_payload(app: &AppHandle) -> Option<(String, String, serde_json::Value)> {
    let state = app.state::<crate::AppState>();
    let stats = {
        let ss = state.stats_store.lock().unwrap_or_else(|e| e.into_inner());
        ss.get_stats("week")
    };
    let summary = stats.get("summary").cloned().unwrap_or_default();
    let saved = summary.get("tokensSaved").and_then(|v| v.as_u64()).unwrap_or(0);
    let pct = summary.get("percentSaved").and_then(|v| v.as_u64()).unwrap_or(0);
    let tokens_in = summary.get("tokensIn").and_then(|v| v.as_u64()).unwrap_or(0);
    let tokens_out = summary.get("tokensOut").and_then(|v| v.as_u64()).unwrap_or(0);
    let active_days = stats.get("byDay").and_then(|v| v.as_object()).map(|o| o.len())
        .or_else(|| stats.get("byDay").and_then(|v| v.as_array()).map(|a| a.len()))
        .unwrap_or(0);

    if saved == 0 && tokens_in == 0 && tokens_out == 0 {
        return None;
    }

    // Dollarize the saved tokens at a representative input rate for the headline.
    let usd = crate::pricing::estimate_cost("claude-sonnet-5", saved, 0, 0, 0);
    let saved_h = human_tokens(saved);
    let title = "Your week with Terse 📰".to_string();
    let body = format!(
        "Saved {} tokens (~${:.2}) · {}% leaner · active {} day{}.",
        saved_h, usd, pct, active_days, if active_days == 1 { "" } else { "s" }
    );
    let data = serde_json::json!({
        "tokensSaved": saved,
        "percentSaved": pct,
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "activeDays": active_days,
        "estimatedUsd": (usd * 100.0).round() / 100.0,
    });
    Some((title, body, data))
}

fn human_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.0}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// Compose + fire the digest through the alert pipeline and emit an event for
/// any in-app card. Records the ISO week so it won't repeat.
fn send(app: &AppHandle, week: &str) {
    if let Some((title, body, data)) = build_payload(app) {
        let _ = app.emit("weekly-digest", &data);
        crate::notifications::notify(app, "digest", &title, &body, "low", &format!("digest:{}", week), Some("open-stats"));
    }
    save_state(&DigestState { last_week: week.to_string() });
}

/// Called from the scan loop. Fires the digest the first eligible tick of a new
/// ISO week. Cheap: real work only runs once per hour and once per week.
pub fn maybe_send_weekly(app: &AppHandle) {
    {
        let mut last = LAST_CHECK.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = *last {
            if t.elapsed().as_secs() < 3600 {
                return;
            }
        }
        *last = Some(std::time::Instant::now());
    }
    let week = iso_week_now();
    let st = load_state();
    if st.last_week != week {
        // Don't fire on the very first run ever (no baseline yet) — just record
        // the week so the *next* week produces the first real digest.
        if st.last_week.is_empty() {
            save_state(&DigestState { last_week: week });
        } else {
            send(app, &week);
        }
    }
}

/// Manual trigger — "View this week's digest" button / testing.
#[tauri::command]
pub fn send_weekly_digest_now(app: AppHandle) -> serde_json::Value {
    match build_payload(&app) {
        Some((title, body, data)) => {
            let _ = app.emit("weekly-digest", &data);
            let dedupe = format!("digest:manual:{}", iso_week_now());
            crate::notifications::notify(&app, "digest", &title, &body, "low", &dedupe, Some("open-stats"));
            serde_json::json!({ "sent": true, "data": data })
        }
        None => serde_json::json!({ "sent": false }),
    }
}
