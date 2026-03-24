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
}

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
        self.save();
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
    /// Optimizations used this week (tracked locally)
    #[serde(default)]
    pub weekly_usage: u32,
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
            tier: "free".to_string(),
            status: "active".to_string(),
            limits: PlanLimits {
                optimizations_per_week: 200,
                max_sessions: 1,
                max_devices: 1,
            },
            clerk_user_id: None,
            expires_at: None,
            weekly_usage: 0,
            usage_week: current_week(),
        }
    }
}

fn current_week() -> u32 {
    let now = chrono::Local::now();
    now.format("%Y%W").to_string().parse().unwrap_or(0)
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
                        license.weekly_usage = 0;
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
        if self.limits.optimizations_per_week < 0 {
            return true; // unlimited
        }
        self.weekly_usage < self.limits.optimizations_per_week as u32
    }

    pub fn record_optimization(&mut self) {
        let week = current_week();
        if self.usage_week != week {
            self.weekly_usage = 0;
            self.usage_week = week;
        }
        self.weekly_usage += 1;
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
        (self.limits.optimizations_per_week - self.weekly_usage as i32).max(0)
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
            "clerkUserId": self.clerk_user_id,
            "expiresAt": self.expires_at,
        })
    }
}

/// Verify license with backend API (async, non-blocking)
pub async fn verify_license(clerk_user_id: &str) -> Option<License> {
    let url = format!("{}/api/license/{}", API_BASE, clerk_user_id);
    let output = tokio::process::Command::new("curl")
        .args(["-s", "--connect-timeout", "5", "--max-time", "10", &url])
        .output()
        .await
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

    // Load existing local data to preserve weekly_usage
    let mut existing = License::load();
    existing.tier = tier;
    existing.status = status;
    existing.limits = limits;
    existing.clerk_user_id = Some(clerk_user_id.to_string());
    existing.expires_at = v["expiresAt"].as_str().map(|s| s.to_string());
    existing.save();

    Some(existing)
}
