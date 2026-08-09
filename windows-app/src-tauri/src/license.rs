use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const API_BASE: &str = "https://www.terseai.org";

// ── Auth State (persisted locally) ──

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthState {
    #[serde(rename = "clerkUserId")]
    pub clerk_user_id: Option<String>,
    pub email: Option<String>,
    #[serde(rename = "imageUrl")]
    pub image_url: Option<String>,
    #[serde(rename = "firstName")]
    pub first_name: Option<String>,
    #[serde(rename = "signedIn")]
    pub signed_in: bool,
    /// Start of the 15-minute "try it first" grace window (ISO 8601 / RFC 3339),
    /// set at first sign-in. During this window the subscription gate is suppressed
    /// so a new user can use Terse before being asked to start a free trial. Cleared
    /// on sign-out. Persisted so the window survives app restarts.
    #[serde(rename = "graceStart", default)]
    pub grace_start: Option<String>,
}

/// Length of the post-login "try it first" grace window, in seconds (15 minutes).
pub const GRACE_SECS: i64 = 15 * 60;

fn auth_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".terse").join("auth.json")
}

impl AuthState {
    pub fn load() -> Self {
        let path = auth_path();
        if path.exists() {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(auth) = serde_json::from_str::<AuthState>(&data) {
                    return auth;
                }
            }
        }
        AuthState::default()
    }

    pub fn save(&self) {
        let path = auth_path();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = fs::write(&path, json);
        }
    }

    pub fn sign_out(&mut self) {
        self.clerk_user_id = None;
        self.email = None;
        self.image_url = None;
        self.first_name = None;
        self.signed_in = false;
        self.grace_start = None;
        self.save();
    }

    /// Begin the grace window if it hasn't started yet (idempotent — preserves the
    /// original start across restarts so the 15 minutes don't reset every launch).
    pub fn ensure_grace_started(&mut self) {
        if self.grace_start.is_none() {
            self.grace_start = Some(chrono::Utc::now().to_rfc3339());
        }
    }

    /// Seconds left in the grace window (0 once elapsed or never started).
    pub fn grace_remaining_secs(&self) -> i64 {
        match self.grace_start.as_deref() {
            Some(s) => match chrono::DateTime::parse_from_rfc3339(s) {
                Ok(start) => (start.timestamp() + GRACE_SECS - chrono::Utc::now().timestamp()).max(0),
                Err(_) => 0,
            },
            None => 0,
        }
    }

    /// True while the user is still inside the post-login grace window.
    pub fn in_grace(&self) -> bool {
        self.grace_remaining_secs() > 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub tier: String,
    pub status: String,
    pub limits: PlanLimits,
    #[serde(rename = "clerkUserId")]
    pub clerk_user_id: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<String>,
    /// End of trial period (ISO 8601), None if not trialing
    #[serde(rename = "trialEnd", default)]
    pub trial_end: Option<String>,
    /// Optimizations used this week (tracked locally, supports fractional costs)
    #[serde(default)]
    pub weekly_usage: f64,
    /// Week number when usage was last reset
    #[serde(default)]
    pub usage_week: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanLimits {
    pub optimizations_per_week: i32,
    pub max_sessions: i32,
    pub max_devices: i32,
}

impl Default for License {
    fn default() -> Self {
        License {
            tier: "expired".to_string(),
            status: "none".to_string(),
            limits: PlanLimits {
                optimizations_per_week: 0,
                max_sessions: 0,
                max_devices: 0,
            },
            clerk_user_id: None,
            expires_at: None,
            trial_end: None,
            weekly_usage: 0.0,
            usage_week: current_week(),
        }
    }
}

fn current_week() -> u32 {
    let now = chrono::Local::now();
    now.format("%Y%W").to_string().parse().unwrap_or(0)
}

/// ISO-8601 timestamp of the next weekly quota reset (upcoming Monday 00:00 local).
/// Weekly usage zeroes when the `%W` week number rolls over, which happens at the
/// start of each Monday — so that's when the user's quota refreshes.
fn next_weekly_reset() -> String {
    use chrono::{Datelike, Duration, Local, TimeZone};
    let now = Local::now();
    let days_since_monday = now.weekday().num_days_from_monday() as i64;
    let days_until_next_monday = 7 - days_since_monday; // 7 when today is Monday
    let next_date = (now + Duration::days(days_until_next_monday)).date_naive();
    next_date
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).single())
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

fn license_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".terse").join("license.json")
}

impl License {
    pub fn load() -> Self {
        let path = license_path();
        if path.exists() {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(mut license) = serde_json::from_str::<License>(&data) {
                    // Reset weekly usage if new week
                    let week = current_week();
                    if license.usage_week != week {
                        license.weekly_usage = 0.0;
                        license.usage_week = week;
                        license.save();
                    }
                    return license;
                }
            }
        }
        License::default()
    }

    pub fn save(&self) {
        let path = license_path();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = fs::write(&path, json);
        }
    }

    pub fn can_optimize(&self) -> bool {
        // Expired/cancelled users cannot optimize
        if self.tier == "expired" || self.status == "cancelled" || self.status == "none" {
            return false;
        }
        if self.limits.optimizations_per_week < 0 {
            return true; // unlimited
        }
        self.weekly_usage < self.limits.optimizations_per_week as f64
    }

    pub fn record_optimization(&mut self) {
        self.record_optimization_cost(1.0);
    }

    pub fn record_optimization_cost(&mut self, cost: f64) {
        let week = current_week();
        if self.usage_week != week {
            self.weekly_usage = 0.0;
            self.usage_week = week;
        }
        self.weekly_usage += cost;
        self.save();
    }

    pub fn can_add_session(&self, current_count: usize) -> bool {
        if self.limits.max_sessions < 0 {
            return true; // unlimited
        }
        current_count < self.limits.max_sessions as usize
    }

    pub fn remaining_optimizations(&self) -> i32 {
        if self.limits.optimizations_per_week < 0 {
            return -1; // unlimited
        }
        ((self.limits.optimizations_per_week as f64 - self.weekly_usage).max(0.0)) as i32
    }

    pub fn is_trialing(&self) -> bool {
        self.status == "trialing"
    }

    pub fn get_snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "tier": self.tier,
            "status": self.status,
            "limits": {
                "optimizationsPerWeek": self.limits.optimizations_per_week,
                "maxSessions": self.limits.max_sessions,
                "maxDevices": self.limits.max_devices,
            },
            "weeklyUsage": self.weekly_usage,
            "remaining": self.remaining_optimizations(),
            "resetsAt": next_weekly_reset(),
            "clerkUserId": self.clerk_user_id,
            "expiresAt": self.expires_at,
            "trialEnd": self.trial_end,
        })
    }
}

/// Verify license with backend API (async, non-blocking)
pub async fn verify_license(clerk_user_id: &str) -> Option<License> {
    let url = format!("{}/api/license/{}", API_BASE, clerk_user_id);
    // Run curl on a blocking thread through the shared `hidden_command` helper
    // (CREATE_NO_WINDOW) rather than a bare `tokio::process::Command`. This is the
    // same path every other curl uses; the async spawn was the one status poll that
    // still flashed a console window on Windows (fired on every window focus).
    let output = tokio::task::spawn_blocking(move || {
        crate::hidden_command("curl")
            .args(["-s", "--connect-timeout", "5", "--max-time", "10", &url])
            .output()
    })
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let body = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;

    let tier = v["tier"].as_str().unwrap_or("free").to_string();
    let status = v["status"].as_str().unwrap_or("active").to_string();

    let limits = PlanLimits {
        optimizations_per_week: v["limits"]["optimizations_per_week"].as_i64().unwrap_or(200) as i32,
        max_sessions: v["limits"]["max_sessions"].as_i64().unwrap_or(1) as i32,
        max_devices: v["limits"]["max_devices"].as_i64().unwrap_or(1) as i32,
    };

    // Load existing local data to preserve weekly_usage across sign-ins
    // Quota is per-device, not per-user — prevents creating new accounts to bypass limits
    let mut existing = License::load();
    existing.tier = tier;
    existing.status = status;
    existing.limits = limits;
    existing.clerk_user_id = Some(clerk_user_id.to_string());
    existing.expires_at = v["expiresAt"].as_str().map(|s| s.to_string());
    existing.trial_end = v["trialEnd"].as_str().map(|s| s.to_string());
    existing.save();

    Some(existing)
}

// ── Referral program (cloud-tracked) ─────────────────────────────────────────
// The backend at {API_BASE}/api/referral owns code generation, attribution and
// reward granting (dual-sided: both referrer and referee get free Pro days).
// The client only displays state and forwards redemptions, so self-referral and
// abuse are prevented server-side. Until the endpoints ship, calls return None /
// a friendly "launching soon" and the client shows a deterministic display code.
//
// Both calls go through `hidden_command` (CREATE_NO_WINDOW) so curl never
// flashes a console window — the same rule every other curl on Windows follows.

/// GET the caller's referral dashboard (code, share URL, counts, rewards).
pub async fn fetch_referral(clerk_user_id: &str) -> Option<serde_json::Value> {
    let url = format!("{}/api/referral/{}", API_BASE, clerk_user_id);
    let output = tokio::task::spawn_blocking(move || {
        crate::hidden_command("curl")
            .args(["-s", "--connect-timeout", "5", "--max-time", "10", &url])
            .output()
    })
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let body = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    // Treat an error/empty object as "not live yet".
    if v.get("code").is_some() || v.get("invited").is_some() {
        Some(v)
    } else {
        None
    }
}

/// POST a friend's code to claim the give-get reward. Returns the backend's
/// verdict; `granted: true` means Pro was applied and the client should re-verify.
pub async fn redeem_referral(clerk_user_id: &str, code: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/referral/redeem", API_BASE);
    let payload =
        serde_json::json!({ "clerkUserId": clerk_user_id, "code": code }).to_string();
    let output = tokio::task::spawn_blocking(move || {
        crate::hidden_command("curl")
            .args([
                "-s", "-X", "POST", "-H", "Content-Type: application/json", "-d", &payload,
                "--connect-timeout", "5", "--max-time", "10", &url,
            ])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Could not reach the referral service.".to_string());
    }
    let body = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(body.trim())
        .map_err(|_| "Referrals are launching soon — your invite code is ready to share.".to_string())
}
