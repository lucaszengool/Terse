use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const SOURCE_TYPES: &[&str] = &["browser", "agent", "editor", "manual"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceStats {
    #[serde(rename = "tokensIn")]
    pub tokens_in: u64,
    #[serde(rename = "tokensOut")]
    pub tokens_out: u64,
    #[serde(rename = "tokensSaved")]
    pub tokens_saved: u64,
    #[serde(rename = "messagesTotal")]
    pub messages_total: u64,
    #[serde(rename = "messagesOptimized")]
    pub messages_optimized: u64,
    #[serde(rename = "toolCalls")]
    pub tool_calls: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsData {
    pub days: HashMap<String, HashMap<String, SourceStats>>,
}

pub struct StatsStore {
    data: StatsData,
    dirty: bool,
    file_path: PathBuf,
}

impl StatsStore {
    pub fn new() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let dir = home.join(".terse");
        let file_path = dir.join("stats.json");

        let data = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            StatsData::default()
        };

        StatsStore {
            data,
            dirty: false,
            file_path,
        }
    }

    fn today_key() -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }

    fn ensure_day(&mut self, day: &str) {
        if !self.data.days.contains_key(day) {
            let mut day_data = HashMap::new();
            for src in SOURCE_TYPES {
                day_data.insert(src.to_string(), SourceStats::default());
            }
            self.data.days.insert(day.to_string(), day_data);
        }
    }

    pub fn record_optimization(&mut self, source: &str, original_tokens: u64, optimized_tokens: u64) {
        let day = Self::today_key();
        self.ensure_day(&day);

        let src_key = if SOURCE_TYPES.contains(&source) { source } else { "manual" };
        if let Some(day_data) = self.data.days.get_mut(&day) {
            if let Some(src) = day_data.get_mut(src_key) {
                src.tokens_in += original_tokens;
                src.messages_total += 1;
                let saved = original_tokens.saturating_sub(optimized_tokens);
                if saved > 0 {
                    src.tokens_saved += saved;
                    src.messages_optimized += 1;
                }
            }
        }
        self.dirty = true;
        self.maybe_save();
    }

    pub fn record_agent_usage(&mut self, input_tokens: u64, output_tokens: u64, tool_calls: u64) {
        let day = Self::today_key();
        self.ensure_day(&day);

        if let Some(day_data) = self.data.days.get_mut(&day) {
            if let Some(src) = day_data.get_mut("agent") {
                src.tokens_in += input_tokens;
                src.tokens_out += output_tokens;
                src.tool_calls += tool_calls;
            }
        }
        self.dirty = true;
    }

    pub fn get_stats(&self, period: &str) -> serde_json::Value {
        let start_date = match period {
            "day" => Self::today_key(),
            "week" => {
                let d = chrono::Local::now() - chrono::Duration::days(7);
                d.format("%Y-%m-%d").to_string()
            }
            "month" => {
                let d = chrono::Local::now() - chrono::Duration::days(30);
                d.format("%Y-%m-%d").to_string()
            }
            _ => "2000-01-01".to_string(),
        };

        let mut summary = serde_json::json!({
            "tokensIn": 0u64, "tokensOut": 0u64, "tokensSaved": 0u64,
            "messagesTotal": 0u64, "messagesOptimized": 0u64, "toolCalls": 0u64,
        });

        let mut by_source: HashMap<String, serde_json::Value> = HashMap::new();
        for src in SOURCE_TYPES {
            by_source.insert(src.to_string(), serde_json::json!({
                "tokensIn": 0u64, "tokensOut": 0u64, "tokensSaved": 0u64,
                "messagesTotal": 0u64, "messagesOptimized": 0u64, "toolCalls": 0u64,
            }));
        }
        let mut by_day: Vec<serde_json::Value> = Vec::new();

        let mut sorted_days: Vec<&String> = self.data.days.keys().collect();
        sorted_days.sort();

        for day in sorted_days {
            if day.as_str() < start_date.as_str() { continue; }
            let day_data = &self.data.days[day];
            let mut day_sum = serde_json::json!({
                "date": day, "tokensIn": 0u64, "tokensOut": 0u64,
                "tokensSaved": 0u64, "messagesTotal": 0u64, "toolCalls": 0u64,
            });

            for src_key in SOURCE_TYPES {
                if let Some(s) = day_data.get(*src_key) {
                    // Add to summary
                    summary["tokensIn"] = serde_json::json!(summary["tokensIn"].as_u64().unwrap_or(0) + s.tokens_in);
                    summary["tokensOut"] = serde_json::json!(summary["tokensOut"].as_u64().unwrap_or(0) + s.tokens_out);
                    summary["tokensSaved"] = serde_json::json!(summary["tokensSaved"].as_u64().unwrap_or(0) + s.tokens_saved);
                    summary["messagesTotal"] = serde_json::json!(summary["messagesTotal"].as_u64().unwrap_or(0) + s.messages_total);
                    summary["messagesOptimized"] = serde_json::json!(summary["messagesOptimized"].as_u64().unwrap_or(0) + s.messages_optimized);
                    summary["toolCalls"] = serde_json::json!(summary["toolCalls"].as_u64().unwrap_or(0) + s.tool_calls);

                    // Add to by_source
                    if let Some(bs) = by_source.get_mut(*src_key) {
                        bs["tokensIn"] = serde_json::json!(bs["tokensIn"].as_u64().unwrap_or(0) + s.tokens_in);
                        bs["tokensOut"] = serde_json::json!(bs["tokensOut"].as_u64().unwrap_or(0) + s.tokens_out);
                        bs["tokensSaved"] = serde_json::json!(bs["tokensSaved"].as_u64().unwrap_or(0) + s.tokens_saved);
                        bs["messagesTotal"] = serde_json::json!(bs["messagesTotal"].as_u64().unwrap_or(0) + s.messages_total);
                        bs["messagesOptimized"] = serde_json::json!(bs["messagesOptimized"].as_u64().unwrap_or(0) + s.messages_optimized);
                        bs["toolCalls"] = serde_json::json!(bs["toolCalls"].as_u64().unwrap_or(0) + s.tool_calls);
                    }

                    // Add to day sum
                    day_sum["tokensIn"] = serde_json::json!(day_sum["tokensIn"].as_u64().unwrap_or(0) + s.tokens_in);
                    day_sum["tokensOut"] = serde_json::json!(day_sum["tokensOut"].as_u64().unwrap_or(0) + s.tokens_out);
                    day_sum["tokensSaved"] = serde_json::json!(day_sum["tokensSaved"].as_u64().unwrap_or(0) + s.tokens_saved);
                    day_sum["messagesTotal"] = serde_json::json!(day_sum["messagesTotal"].as_u64().unwrap_or(0) + s.messages_total);
                    day_sum["toolCalls"] = serde_json::json!(day_sum["toolCalls"].as_u64().unwrap_or(0) + s.tool_calls);
                }
            }
            by_day.push(day_sum);
        }

        let tokens_in = summary["tokensIn"].as_u64().unwrap_or(0);
        let tokens_saved = summary["tokensSaved"].as_u64().unwrap_or(0);
        let pct = if tokens_in > 0 { ((tokens_saved as f64 / tokens_in as f64) * 100.0).round() as u64 } else { 0 };
        summary["percentSaved"] = serde_json::json!(pct);

        serde_json::json!({
            "summary": summary,
            "bySource": by_source,
            "byDay": by_day,
            "period": period,
        })
    }

    fn maybe_save(&mut self) {
        if !self.dirty { return; }
        let dir = self.file_path.parent().unwrap();
        let _ = fs::create_dir_all(dir);
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.file_path, json);
        }
        self.dirty = false;
    }

    pub fn flush(&mut self) {
        self.dirty = true;
        self.maybe_save();
    }
}
