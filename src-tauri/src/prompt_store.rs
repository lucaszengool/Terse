//! Prompt library — a small, local store of reusable prompts with
//! `{{variable}}` placeholders. Powers the ⌘⇧K palette that fills variables and
//! inserts the finished text into whatever app was focused. Persisted to
//! `~/.terse/prompts.json`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Derived `{{name}}` placeholder names, in first-seen order.
    #[serde(default)]
    pub variables: Vec<String>,
    #[serde(default)]
    pub created: String,
    #[serde(rename = "lastUsed", default)]
    pub last_used: String,
    #[serde(rename = "useCount", default)]
    pub use_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PromptData {
    #[serde(default)]
    prompts: Vec<Prompt>,
    #[serde(default)]
    seq: u64,
}

pub struct PromptStore {
    data: PromptData,
    file_path: PathBuf,
}

/// Extract `{{name}}` / `{{name=default}}` / `{{name|hint}}` placeholder names
/// from a body, de-duplicated and in first-seen order. Dependency-free scan so
/// we don't pull in a regex crate.
pub fn extract_vars(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(close) = body[i + 2..].find("}}") {
                let raw = &body[i + 2..i + 2 + close];
                // name ends at the first '=' or '|' (default / hint separators).
                let name = raw
                    .split(|c| c == '=' || c == '|')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !name.is_empty() && !out.contains(&name) {
                    out.push(name);
                }
                i += 2 + close + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

impl PromptStore {
    pub fn new() -> Self {
        let file_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".terse")
            .join("prompts.json");
        let data = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            PromptData::default()
        };
        PromptStore { data, file_path }
    }

    fn save(&self) {
        if let Some(dir) = self.file_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file_path, json);
        }
    }

    /// Prompts ordered most-recently-used first (falls back to created).
    pub fn list(&self) -> serde_json::Value {
        let mut items = self.data.prompts.clone();
        items.sort_by(|a, b| {
            let ka = if a.last_used.is_empty() { &a.created } else { &a.last_used };
            let kb = if b.last_used.is_empty() { &b.created } else { &b.last_used };
            kb.cmp(ka)
        });
        serde_json::json!({ "prompts": items })
    }

    pub fn get(&self, id: &str) -> serde_json::Value {
        self.data
            .prompts
            .iter()
            .find(|p| p.id == id)
            .map(|p| serde_json::to_value(p).unwrap_or_default())
            .unwrap_or(serde_json::Value::Null)
    }

    /// Insert or update a prompt. If `id` is empty a new one is minted. Returns
    /// the saved prompt (with derived variables + timestamps).
    pub fn save_prompt(&mut self, v: serde_json::Value) -> serde_json::Value {
        let now = chrono::Local::now().to_rfc3339();
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let tags: Vec<String> = v
            .get("tags")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|t| t.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        let variables = extract_vars(&body);

        if !id.is_empty() {
            if let Some(p) = self.data.prompts.iter_mut().find(|p| p.id == id) {
                p.title = title;
                p.body = body;
                p.tags = tags;
                p.variables = variables;
                let saved = p.clone();
                self.save();
                return serde_json::to_value(saved).unwrap_or_default();
            }
        }

        self.data.seq += 1;
        let new = Prompt {
            id: format!("p{}", self.data.seq),
            title,
            body,
            tags,
            variables,
            created: now,
            last_used: String::new(),
            use_count: 0,
        };
        self.data.prompts.push(new.clone());
        self.save();
        serde_json::to_value(new).unwrap_or_default()
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.data.prompts.len();
        self.data.prompts.retain(|p| p.id != id);
        let changed = self.data.prompts.len() != before;
        if changed {
            self.save();
        }
        changed
    }

    pub fn record_use(&mut self, id: &str) {
        if let Some(p) = self.data.prompts.iter_mut().find(|p| p.id == id) {
            p.use_count += 1;
            p.last_used = chrono::Local::now().to_rfc3339();
            self.save();
        }
    }
}

impl Default for PromptStore {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_prompts(state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.prompt_store.lock().unwrap_or_else(|e| e.into_inner()).list()
}

#[tauri::command]
pub fn get_prompt(id: String, state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.prompt_store.lock().unwrap_or_else(|e| e.into_inner()).get(&id)
}

#[tauri::command]
pub fn save_prompt(prompt: serde_json::Value, state: tauri::State<'_, crate::AppState>) -> serde_json::Value {
    state.prompt_store.lock().unwrap_or_else(|e| e.into_inner()).save_prompt(prompt)
}

#[tauri::command]
pub fn delete_prompt(id: String, state: tauri::State<'_, crate::AppState>) -> bool {
    state.prompt_store.lock().unwrap_or_else(|e| e.into_inner()).delete(&id)
}

#[tauri::command]
pub fn record_prompt_use(id: String, state: tauri::State<'_, crate::AppState>) {
    state.prompt_store.lock().unwrap_or_else(|e| e.into_inner()).record_use(&id);
}
