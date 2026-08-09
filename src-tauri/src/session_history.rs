//! Persistent agent-session history. Live sessions live only in memory in the
//! agent monitor; here we snapshot them to `~/.terse/history.json` so the user
//! can answer "what did this agent cost last week", search past runs and feed
//! per-project cost rollups. Snapshots are upserted (keyed by session id) from
//! the background monitor pass, so history accrues without touching the
//! monitor's disconnect path.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const MAX_RECORDS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionRecord {
    pub id: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    #[serde(rename = "agentName")]
    pub agent_name: String,
    pub project: String,
    pub model: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: u64,
    #[serde(rename = "cacheCreateTokens")]
    pub cache_create_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "toolCalls")]
    pub tool_calls: u64,
    pub turns: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    #[serde(rename = "firstSeen")]
    pub first_seen: String,
    #[serde(rename = "lastSeen")]
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct HistoryData {
    #[serde(default)]
    sessions: HashMap<String, SessionRecord>,
}

pub struct SessionHistoryStore {
    data: HistoryData,
    file_path: PathBuf,
}

fn snap_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn snap_u64(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

impl SessionHistoryStore {
    pub fn new() -> Self {
        let file_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".terse")
            .join("history.json");
        let data = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            HistoryData::default()
        };
        SessionHistoryStore { data, file_path }
    }

    fn save(&self) {
        if let Some(dir) = self.file_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file_path, json);
        }
    }

    /// Upsert one live-session snapshot (the object shape from
    /// `AgentSessionData::get_snapshot`). Cumulative counters are stored as the
    /// latest values; `first_seen` is preserved, `last_seen` bumped.
    pub fn record_snapshot(&mut self, snap: &serde_json::Value) {
        let id = snap_str(snap, "id");
        if id.is_empty() {
            return;
        }
        // Skip empty shells (hook-only sessions with no real usage yet).
        let total = snap_u64(snap, "totalTokens");
        if total == 0 && snap_u64(snap, "turns") == 0 {
            return;
        }
        let now = chrono::Local::now().to_rfc3339();
        let model = snap.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let cost = snap.get("estimatedCost").and_then(|c| c.as_f64()).unwrap_or(0.0);

        let entry = self.data.sessions.entry(id.clone()).or_insert_with(|| SessionRecord {
            id: id.clone(),
            first_seen: now.clone(),
            ..Default::default()
        });
        entry.agent_type = snap_str(snap, "agentType");
        entry.agent_name = snap_str(snap, "agentName");
        entry.project = snap_str(snap, "project");
        entry.model = model;
        entry.input_tokens = snap_u64(snap, "totalInputTokens");
        entry.output_tokens = snap_u64(snap, "totalOutputTokens");
        entry.cache_read_tokens = snap_u64(snap, "totalCacheReadTokens");
        entry.cache_create_tokens = snap_u64(snap, "totalCacheCreateTokens");
        entry.total_tokens = total;
        entry.tool_calls = snap_u64(snap, "toolCallCount");
        entry.turns = snap_u64(snap, "turns");
        entry.cost_usd = (cost * 1000.0).round() / 1000.0;
        entry.last_seen = now;

        self.prune();
        self.save();
    }

    pub fn record_many(&mut self, snaps: &[serde_json::Value]) {
        for s in snaps {
            self.record_snapshot(s);
        }
    }

    fn prune(&mut self) {
        if self.data.sessions.len() <= MAX_RECORDS {
            return;
        }
        let mut ids: Vec<(String, String)> = self
            .data
            .sessions
            .iter()
            .map(|(k, v)| (k.clone(), v.last_seen.clone()))
            .collect();
        ids.sort_by(|a, b| a.1.cmp(&b.1)); // oldest first
        let drop = self.data.sessions.len() - MAX_RECORDS;
        for (id, _) in ids.into_iter().take(drop) {
            self.data.sessions.remove(&id);
        }
    }

    fn sorted(&self) -> Vec<SessionRecord> {
        let mut items: Vec<SessionRecord> = self.data.sessions.values().cloned().collect();
        items.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        items
    }

    /// Full history + rollups (total cost, by-project, by-model) over a rolling
    /// window: `day` | `week` | `month` | `all`.
    pub fn list(&self, period: &str) -> serde_json::Value {
        let cutoff = match period {
            "day" => (chrono::Local::now() - chrono::Duration::days(1)).to_rfc3339(),
            "week" => (chrono::Local::now() - chrono::Duration::days(7)).to_rfc3339(),
            "month" => (chrono::Local::now() - chrono::Duration::days(30)).to_rfc3339(),
            _ => String::new(),
        };
        let items: Vec<SessionRecord> = self
            .sorted()
            .into_iter()
            .filter(|r| cutoff.is_empty() || r.last_seen.as_str() >= cutoff.as_str())
            .collect();

        let total_cost: f64 = items.iter().map(|r| r.cost_usd).sum();
        let total_tokens: u64 = items.iter().map(|r| r.total_tokens).sum();

        let mut by_project: HashMap<String, f64> = HashMap::new();
        let mut by_model: HashMap<String, f64> = HashMap::new();
        for r in &items {
            let proj = if r.project.is_empty() { "—".to_string() } else { r.project.clone() };
            *by_project.entry(proj).or_insert(0.0) += r.cost_usd;
            if !r.model.is_empty() {
                *by_model.entry(r.model.clone()).or_insert(0.0) += r.cost_usd;
            }
        }
        let mut proj_vec: Vec<_> = by_project
            .into_iter()
            .map(|(name, cost)| serde_json::json!({ "name": name, "costUsd": (cost * 1000.0).round() / 1000.0 }))
            .collect();
        proj_vec.sort_by(|a, b| b["costUsd"].as_f64().unwrap_or(0.0).partial_cmp(&a["costUsd"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
        let mut model_vec: Vec<_> = by_model
            .into_iter()
            .map(|(name, cost)| serde_json::json!({ "name": name, "costUsd": (cost * 1000.0).round() / 1000.0 }))
            .collect();
        model_vec.sort_by(|a, b| b["costUsd"].as_f64().unwrap_or(0.0).partial_cmp(&a["costUsd"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));

        serde_json::json!({
            "sessions": items,
            "summary": {
                "count": items.len(),
                "costUsd": (total_cost * 100.0).round() / 100.0,
                "totalTokens": total_tokens,
            },
            "byProject": proj_vec,
            "byModel": model_vec,
            "period": period,
        })
    }

    pub fn get(&self, id: &str) -> serde_json::Value {
        self.data
            .sessions
            .get(id)
            .map(|r| serde_json::to_value(r).unwrap_or_default())
            .unwrap_or(serde_json::Value::Null)
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let changed = self.data.sessions.remove(id).is_some();
        if changed {
            self.save();
        }
        changed
    }

    pub fn clear(&mut self) {
        self.data.sessions.clear();
        self.save();
    }
}

impl Default for SessionHistoryStore {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_session_history(period: Option<String>, state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    let period = period.unwrap_or_else(|| "week".to_string());
    state.session_history.lock().unwrap_or_else(|e| e.into_inner()).list(&period)
}

#[tauri::command]
pub fn get_session_history(id: String, state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.session_history.lock().unwrap_or_else(|e| e.into_inner()).get(&id)
}

#[tauri::command]
pub fn delete_session_history(id: String, state: tauri::State<'_, crate::AppState>) -> bool {
    state.session_history.lock().unwrap_or_else(|e| e.into_inner()).delete(&id)
}

#[tauri::command]
pub fn clear_session_history(state: tauri::State<'_, crate::AppState>) -> bool {
    state.session_history.lock().unwrap_or_else(|e| e.into_inner()).clear();
    true
}
