//! Terse Cowork — publishes this device's live coding-agent sessions + working logs
//! to Terse cloud so teammates (and their agents, via the MCP server) can watch in
//! real time. Mirrors the lightweight `curl`-based HTTP pattern in `license.rs` —
//! no extra HTTP dependency. Publishing only happens when a team token is configured
//! and `share_logs` is on.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const API_BASE: &str = "https://www.terseai.org";

// ── Config (persisted to ~/.terse/cowork.json) ──

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoworkConfig {
    #[serde(rename = "teamId", default)]
    pub team_id: Option<String>,
    #[serde(rename = "teamName", default)]
    pub team_name: Option<String>,
    #[serde(rename = "teamToken", default)]
    pub team_token: Option<String>,
    #[serde(rename = "shareLogs", default = "default_true")]
    pub share_logs: bool,
}

fn default_true() -> bool { true }

fn config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".terse").join("cowork.json")
}

impl CoworkConfig {
    pub fn load() -> Self {
        let path = config_path();
        if path.exists() {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(cfg) = serde_json::from_str::<CoworkConfig>(&data) {
                    return cfg;
                }
            }
        }
        CoworkConfig { share_logs: true, ..Default::default() }
    }

    pub fn save(&self) {
        let path = config_path();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = fs::write(&path, json);
        }
    }

    pub fn is_active(&self) -> bool {
        self.share_logs
            && self.team_token.as_ref().map_or(false, |t| !t.is_empty())
            && self.team_id.as_ref().map_or(false, |t| !t.is_empty())
    }

    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "teamId": self.team_id,
            "teamName": self.team_name,
            "shareLogs": self.share_logs,
            "connected": self.team_token.as_ref().map_or(false, |t| !t.is_empty()),
            "apiBase": API_BASE,
        })
    }
}

/// Runtime state shared across scan ticks: config + per-agent last-published
/// message timestamp (for incremental log streaming).
#[derive(Default)]
pub struct CoworkState {
    pub config: CoworkConfig,
    last_ts: HashMap<String, String>,
    last_project: HashMap<String, String>,
}

impl CoworkState {
    pub fn new() -> Self {
        CoworkState {
            config: CoworkConfig::load(),
            last_ts: HashMap::new(),
            last_project: HashMap::new(),
        }
    }
}

// ── Tauri commands ──

/// Resolve a team token to its team via /api/cloud/whoami, then persist it.
pub fn resolve_and_save_token(token: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/cloud/whoami", API_BASE);
    let output = std::process::Command::new("curl")
        .args([
            "-s", "--connect-timeout", "5", "--max-time", "10",
            "-H", &format!("x-terse-team-token: {}", token),
            &url,
        ])
        .output()
        .map_err(|e| format!("curl failed: {}", e))?;

    let body = String::from_utf8_lossy(&output.stdout);
    let v: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|_| "Invalid response from server".to_string())?;
    let team_id = v["team_id"].as_str().ok_or_else(|| {
        v["error"].as_str().unwrap_or("Invalid team token").to_string()
    })?;

    let mut cfg = CoworkConfig::load();
    cfg.team_id = Some(team_id.to_string());
    cfg.team_name = v["team_name"].as_str().map(|s| s.to_string());
    cfg.team_token = Some(token.to_string());
    cfg.save();
    Ok(cfg.snapshot())
}

// ── Publishing (called from the agent scan loop) ──

fn map_kind(role: &str, msg_type: &str, has_tool: bool) -> &'static str {
    if role == "tool" { return "tool_result"; }
    if msg_type == "tool_use" || has_tool { return "tool_call"; }
    "message"
}

/// Build the JSON body for one agent and the new log entries since last publish.
/// Returns None if nothing meaningful to send.
fn build_body(
    snapshot: &serde_json::Value,
    user_email: Option<&str>,
    last_ts: &mut HashMap<String, String>,
) -> Option<(String, serde_json::Value)> {
    let agent_type = snapshot["agentType"].as_str().unwrap_or("agent").to_string();

    // Incremental log: messages newer than the last published timestamp for this agent.
    let prev_ts = last_ts.get(&agent_type).cloned().unwrap_or_default();
    let mut newest_ts = prev_ts.clone();
    let mut log: Vec<serde_json::Value> = Vec::new();
    let mut latest_text = String::new();

    if let Some(msgs) = snapshot["recentMessages"].as_array() {
        for m in msgs {
            let ts = m["timestamp"].as_str().unwrap_or("").to_string();
            let role = m["role"].as_str().unwrap_or("assistant");
            let msg_type = m["type"].as_str().unwrap_or("text");
            let tool = m["toolName"].as_str();
            let text = m["text"].as_str().unwrap_or("");
            if !text.is_empty() { latest_text = text.to_string(); }

            // Only forward entries strictly newer than what we've already sent.
            let is_new = if ts.is_empty() { false } else { ts.as_str() > prev_ts.as_str() };
            if is_new {
                if ts.as_str() > newest_ts.as_str() { newest_ts = ts.clone(); }
                log.push(serde_json::json!({
                    "role": role,
                    "kind": map_kind(role, msg_type, tool.is_some()),
                    "tool": tool,
                    "text": text,
                    "tokens": m["tokens"].as_u64().unwrap_or(0),
                }));
            }
        }
    }
    last_ts.insert(agent_type.clone(), newest_ts);

    let task = latest_text.chars().take(200).collect::<String>();
    let session = serde_json::json!({
        "user_email": user_email,
        "device": "mac",
        "agent_type": agent_type,
        "agent_name": snapshot["agentName"].as_str().unwrap_or(&agent_type),
        "project": snapshot["project"].as_str().unwrap_or(""),
        "model": snapshot["model"].as_str().unwrap_or(""),
        "status": "active",
        "task": task,
        "context_window": snapshot["contextMax"].as_u64().unwrap_or(0),
        "context_used": snapshot["currentContext"].as_u64().unwrap_or(0),
        "tokens_in": snapshot["totalInputTokens"].as_u64().unwrap_or(0),
        "tokens_out": snapshot["totalOutputTokens"].as_u64().unwrap_or(0),
        "tokens_saved": 0,
        "tool_calls": snapshot["toolCallCount"].as_u64().unwrap_or(0),
        "turns": snapshot["turns"].as_u64().unwrap_or(0),
    });

    let body = serde_json::json!({ "session": session, "log": log });
    Some((agent_type, body))
}

fn post_json(path: &str, token: &str, body: &str) {
    let url = format!("{}{}", API_BASE, path);
    let _ = std::process::Command::new("curl")
        .args([
            "-s", "-o", "/dev/null", "-X", "POST",
            "--connect-timeout", "5", "--max-time", "10",
            "-H", "Content-Type: application/json",
            "-H", &format!("x-terse-team-token: {}", token),
            "-d", body,
            &url,
        ])
        .output();
}

/// Publish a single agent snapshot. Safe to call every scan tick; it diffs the
/// working log internally so only new entries are sent.
pub fn publish_snapshot(
    state: &mut CoworkState,
    snapshot: &serde_json::Value,
    user_email: Option<&str>,
) {
    if !state.config.is_active() { return; }
    let token = match state.config.team_token.clone() { Some(t) => t, None => return };

    // Remember the project per agent so an end-event can target the same session row.
    let agent_type = snapshot["agentType"].as_str().unwrap_or("agent").to_string();
    let project = snapshot["project"].as_str().unwrap_or("").to_string();
    state.last_project.insert(agent_type, project);

    if let Some((_agent, body)) = build_body(snapshot, user_email, &mut state.last_ts) {
        if let Ok(s) = serde_json::to_string(&body) {
            post_json("/api/cloud/agent-sessions", &token, &s);
        }
    }
}

/// Mark an agent session as ended (called when an agent disconnects).
pub fn publish_ended(state: &mut CoworkState, agent_type: &str, user_email: Option<&str>) {
    if !state.config.is_active() { return; }
    let token = match state.config.team_token.clone() { Some(t) => t, None => return };
    state.last_ts.remove(agent_type);
    let project = state.last_project.remove(agent_type).unwrap_or_default();
    let body = serde_json::json!({
        "session": {
            "user_email": user_email,
            "device": "mac",
            "agent_type": agent_type,
            "project": project,
            "status": "ended",
        }
    });
    if let Ok(s) = serde_json::to_string(&body) {
        post_json("/api/cloud/agent-sessions", &token, &s);
    }
}

/// Send a presence heartbeat for this member.
pub fn publish_presence(state: &CoworkState, user_email: Option<&str>) {
    if !state.config.is_active() { return; }
    let (token, email) = match (state.config.team_token.clone(), user_email) {
        (Some(t), Some(e)) => (t, e.to_string()),
        _ => return,
    };
    let body = serde_json::json!({ "user_email": email, "status": "online", "device": "mac" });
    if let Ok(s) = serde_json::to_string(&body) {
        post_json("/api/cloud/presence", &token, &s);
    }
}
