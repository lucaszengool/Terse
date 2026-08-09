//! Agent budget guardrail — the enforcement half of cost control.
//!
//! Terse already *reports* spend (stats, fuel gauge) and *alerts* on caps. This
//! module is the piece the market is missing on the desktop: it *acts*. A
//! token-velocity circuit breaker watches each live session's burn rate and
//! cumulative spend, and when a ceiling is crossed it can escalate from a loud
//! alert to actually **pausing** the agent process (SIGSTOP) or **killing** it
//! (SIGTERM) — before the next expensive API call goes out.
//!
//! The distinction that matters: a billing alert emails you *after* the money is
//! gone; a circuit breaker trips *before* the runaway loop's next request.
//!
//! Settings + trip history live in `~/.terse/circuit.json`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

fn circuit_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("circuit.json")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What to do when a ceiling is crossed. `alert` never touches the process; the
/// stronger modes require the user to opt in because they interrupt real work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BreakerAction {
    /// Fire a high-severity alert only (default, safe).
    Alert,
    /// Suspend the agent process (SIGSTOP). Resumable from the UI (SIGCONT).
    Pause,
    /// Terminate the agent process (SIGTERM).
    Kill,
}

impl Default for BreakerAction {
    fn default() -> Self {
        BreakerAction::Alert
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitSettings {
    /// Master switch. When off, `evaluate` is a no-op.
    pub enabled: bool,
    /// Escalation once a ceiling trips.
    #[serde(default)]
    pub action: BreakerAction,
    /// Trip if sustained burn rate exceeds this many tokens/minute. The most
    /// important signal — a retry loop spikes burn rate within seconds.
    #[serde(rename = "burnLimitPerMin", default = "default_burn")]
    pub burn_limit_per_min: u64,
    /// Trip if a single session's cumulative tokens exceed this.
    #[serde(rename = "sessionTokenCap", default = "default_session_cap")]
    pub session_token_cap: u64,
    /// Trip if a single session's estimated cost (USD) exceeds this.
    #[serde(rename = "sessionCostCap", default = "default_cost_cap")]
    pub session_cost_cap: f64,
    /// How many consecutive high-burn ticks before we trip. Avoids tripping on a
    /// single big prompt; a real loop stays hot across ticks.
    #[serde(rename = "sustainTicks", default = "default_sustain")]
    pub sustain_ticks: u32,
}

fn default_burn() -> u64 { 80_000 }
fn default_session_cap() -> u64 { 5_000_000 }
fn default_cost_cap() -> f64 { 20.0 }
fn default_sustain() -> u32 { 2 }

impl Default for CircuitSettings {
    fn default() -> Self {
        CircuitSettings {
            enabled: false, // opt-in: enforcement interrupts real work
            action: BreakerAction::Alert,
            burn_limit_per_min: default_burn(),
            session_token_cap: default_session_cap(),
            session_cost_cap: default_cost_cap(),
            sustain_ticks: default_sustain(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripRecord {
    pub id: String,
    pub session_id: String,
    pub agent_type: String,
    pub reason: String,
    pub action: String,
    /// Whether the process action actually succeeded (pause/kill signal sent).
    pub enforced: bool,
    pub burn_rate: u64,
    pub tokens: u64,
    pub cost: f64,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Persisted {
    #[serde(default)]
    settings: CircuitSettings,
    #[serde(default)]
    trips: Vec<TripRecord>,
}

pub struct CircuitBreaker {
    pub settings: CircuitSettings,
    trips: Vec<TripRecord>,
    /// session id → consecutive high-burn tick count.
    hot_streak: HashMap<String, u32>,
    /// session id → unix seconds it was tripped, so we don't re-trip every tick.
    tripped_at: HashMap<String, u64>,
    /// session ids currently paused by us (eligible for resume).
    paused: HashMap<String, u32>, // session id → pid
    file_path: PathBuf,
    seq: u64,
}

impl CircuitBreaker {
    pub fn new() -> Self {
        let file_path = circuit_path();
        let p: Persisted = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Persisted::default()
        };
        CircuitBreaker {
            settings: p.settings,
            trips: p.trips,
            hot_streak: HashMap::new(),
            tripped_at: HashMap::new(),
            paused: HashMap::new(),
            file_path,
            seq: 0,
        }
    }

    fn save(&self) {
        if let Some(dir) = self.file_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let mut trips = self.trips.clone();
        // keep the last 100 trips
        if trips.len() > 100 {
            let start = trips.len() - 100;
            trips = trips.split_off(start);
        }
        let p = Persisted { settings: self.settings.clone(), trips };
        if let Ok(json) = serde_json::to_string_pretty(&p) {
            let _ = fs::write(&self.file_path, json);
        }
    }

    pub fn settings_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.settings).unwrap_or_default()
    }

    pub fn set_settings(&mut self, v: serde_json::Value) {
        if let Ok(s) = serde_json::from_value::<CircuitSettings>(v) {
            self.settings = s;
            self.save();
        }
    }

    pub fn trips_json(&self) -> serde_json::Value {
        serde_json::to_value(self.trips.iter().rev().take(30).collect::<Vec<_>>()).unwrap_or_default()
    }
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new()
    }
}

/// Send a POSIX signal to `pid`. macOS/Linux only; returns whether it launched.
#[cfg(unix)]
fn signal(pid: u32, sig: &str) -> bool {
    std::process::Command::new("kill")
        .arg(format!("-{}", sig))
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn signal(_pid: u32, _sig: &str) -> bool {
    false
}

/// One live-session reading, extracted from the agent snapshot.
pub struct Reading {
    pub session_id: String,
    pub agent_type: String,
    pub pid: u32,
    pub burn_rate: u64,
    pub tokens: u64,
    pub cost: f64,
}

/// Evaluate a session against the breaker each monitor tick. Returns a trip
/// record if it tripped this tick (already dispatched + emitted), else None.
pub fn evaluate(app: &AppHandle, r: &Reading) -> Option<TripRecord> {
    let state = app.state::<crate::AppState>();
    let now = now_unix();

    // Decide under the lock, act outside it.
    let (should_trip, reason, action, seq) = {
        let mut cb = state.circuit.lock().unwrap_or_else(|e| e.into_inner());
        if !cb.settings.enabled {
            cb.hot_streak.remove(&r.session_id);
            return None;
        }
        // Don't re-trip a session within 60s of its last trip.
        if let Some(&t) = cb.tripped_at.get(&r.session_id) {
            if now.saturating_sub(t) < 60 {
                return None;
            }
        }

        // Copy the scalars we need so no borrow of `cb.settings` is held while
        // we mutate `cb.hot_streak` below.
        let token_cap = cb.settings.session_token_cap;
        let cost_cap = cb.settings.session_cost_cap;
        let burn_limit = cb.settings.burn_limit_per_min;
        let sustain = cb.settings.sustain_ticks.max(1);
        let action = cb.settings.action;

        let over_tokens = token_cap > 0 && r.tokens >= token_cap;
        let over_cost = cost_cap > 0.0 && r.cost >= cost_cap;
        let over_burn = burn_limit > 0 && r.burn_rate >= burn_limit;

        // Burn must be sustained across ticks; token/cost caps trip immediately.
        let streak = if over_burn {
            let c = cb.hot_streak.entry(r.session_id.clone()).or_insert(0);
            *c += 1;
            *c
        } else {
            cb.hot_streak.remove(&r.session_id);
            0
        };
        let burn_trips = over_burn && streak >= sustain;

        if !(burn_trips || over_tokens || over_cost) {
            return None;
        }

        let reason = if over_tokens {
            format!("session hit {} tokens (cap {})", r.tokens, token_cap)
        } else if over_cost {
            format!("session hit ${:.2} (cap ${:.2})", r.cost, cost_cap)
        } else {
            format!("burn rate {} tok/min sustained (limit {})", r.burn_rate, burn_limit)
        };
        cb.tripped_at.insert(r.session_id.clone(), now);
        cb.hot_streak.remove(&r.session_id);
        cb.seq += 1;
        (true, reason, action, cb.seq)
    };

    if !should_trip {
        return None;
    }

    // Enforce outside the lock.
    let enforced = match action {
        BreakerAction::Alert => false,
        BreakerAction::Pause => {
            let ok = r.pid > 1 && signal(r.pid, "STOP");
            if ok {
                let mut cb = state.circuit.lock().unwrap_or_else(|e| e.into_inner());
                cb.paused.insert(r.session_id.clone(), r.pid);
            }
            ok
        }
        BreakerAction::Kill => r.pid > 1 && signal(r.pid, "TERM"),
    };

    let action_str = match action {
        BreakerAction::Alert => "alert",
        BreakerAction::Pause => "pause",
        BreakerAction::Kill => "kill",
    };

    let rec = TripRecord {
        id: format!("trip-{}-{}", now, seq),
        session_id: r.session_id.clone(),
        agent_type: r.agent_type.clone(),
        reason: reason.clone(),
        action: action_str.to_string(),
        enforced,
        burn_rate: r.burn_rate,
        tokens: r.tokens,
        cost: (r.cost * 100.0).round() / 100.0,
        ts: now,
    };

    {
        let mut cb = state.circuit.lock().unwrap_or_else(|e| e.into_inner());
        cb.trips.push(rec.clone());
        cb.save();
    }

    // Loud, actionable alert through the unified pipeline.
    let verb = match action {
        BreakerAction::Alert => "flagged",
        BreakerAction::Pause if enforced => "PAUSED",
        BreakerAction::Kill if enforced => "STOPPED",
        _ => "flagged (enforcement failed)",
    };
    let title = format!("Budget breaker {} {}", verb, r.agent_type);
    let body = format!("{}. ~${:.2} this session.", reason, rec.cost);
    let dedupe = format!("circuit:{}", r.session_id);
    crate::notifications::notify(app, "budget", &title, &body, "high", &dedupe, Some("open-budget"));

    let _ = app.emit("circuit-trip", &rec);
    Some(rec)
}

/// Resume a session we paused (SIGCONT). No-op if we didn't pause it.
#[tauri::command]
pub fn circuit_resume(session_id: String, state: tauri::State<'_, crate::AppState>) -> bool {
    let pid = {
        let mut cb = state.circuit.lock().unwrap_or_else(|e| e.into_inner());
        cb.tripped_at.remove(&session_id);
        cb.paused.remove(&session_id)
    };
    match pid {
        Some(pid) if pid > 1 => signal(pid, "CONT"),
        _ => false,
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_circuit_settings(state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.circuit.lock().unwrap_or_else(|e| e.into_inner()).settings_json()
}

#[tauri::command]
pub fn set_circuit_settings(settings: serde_json::Value, state: tauri::State<'_, crate::AppState>) -> bool {
    state.circuit.lock().unwrap_or_else(|e| e.into_inner()).set_settings(settings);
    true
}

#[tauri::command]
pub fn get_circuit_trips(state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.circuit.lock().unwrap_or_else(|e| e.into_inner()).trips_json()
}
