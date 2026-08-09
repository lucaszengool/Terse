use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use chrono::Datelike;

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
    /// Subset of `tokens_in` that were prompt-cache reads (~10× cheaper than fresh input).
    #[serde(rename = "cacheReadTokens", default)]
    pub cache_read_tokens: u64,
    /// Subset of `tokens_in` that were prompt-cache writes (~1.25× fresh input).
    #[serde(rename = "cacheCreationTokens", default)]
    pub cache_creation_tokens: u64,
}

/// Token counts attributed to one model (or MCP server). All `_in` totals include
/// their cache subsets, mirroring `SourceStats`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AttrStats {
    #[serde(rename = "tokensIn", default)]
    pub tokens_in: u64,
    #[serde(rename = "tokensOut", default)]
    pub tokens_out: u64,
    #[serde(rename = "cacheReadTokens", default)]
    pub cache_read: u64,
    #[serde(rename = "cacheCreationTokens", default)]
    pub cache_creation: u64,
    #[serde(rename = "toolCalls", default)]
    pub tool_calls: u64,
}

impl AttrStats {
    fn add(&mut self, o: &AttrStats) {
        self.tokens_in += o.tokens_in;
        self.tokens_out += o.tokens_out;
        self.cache_read += o.cache_read;
        self.cache_creation += o.cache_creation;
        self.tool_calls += o.tool_calls;
    }
}

/// One day's attribution breakdown: by model, by MCP server, and a tool-call
/// histogram. Populated by the session-log scanner.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DayAttribution {
    #[serde(default)]
    pub models: HashMap<String, AttrStats>,
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: HashMap<String, AttrStats>,
    #[serde(default)]
    pub tools: HashMap<String, u64>,
}

impl DayAttribution {
    pub fn merge(&mut self, o: &DayAttribution) {
        for (k, v) in &o.models { self.models.entry(k.clone()).or_default().add(v); }
        for (k, v) in &o.mcp_servers { self.mcp_servers.entry(k.clone()).or_default().add(v); }
        for (k, v) in &o.tools { *self.tools.entry(k.clone()).or_default() += v; }
    }
}

/// User-set spend caps (USD). 0 means "no cap for this period".
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BudgetConfig {
    #[serde(rename = "weeklyUsd", default)]
    pub weekly_usd: f64,
    #[serde(rename = "monthlyUsd", default)]
    pub monthly_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsData {
    pub days: HashMap<String, HashMap<String, SourceStats>>,
    /// date (YYYY-MM-DD) → per-model / per-MCP / per-tool attribution.
    #[serde(default)]
    pub attribution: HashMap<String, DayAttribution>,
    #[serde(default)]
    pub budget: BudgetConfig,
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

    /// Record raw agent token usage attributed to a specific day (YYYY-MM-DD).
    /// Used by the session-log scanner for both backfill and live tracking.
    /// Does NOT touch tokens_saved — savings are only credited by real compression.
    /// `messages` is the count of assistant turns this batch represents.
    /// Caller is responsible for flushing (batch many calls, then `flush()`).
    pub fn record_agent_usage_for_date(&mut self, day: &str, input_tokens: u64, output_tokens: u64, tool_calls: u64, cache_read: u64, cache_creation: u64, messages: u64) {
        if input_tokens == 0 && output_tokens == 0 && tool_calls == 0 { return; }
        self.ensure_day(day);
        if let Some(day_data) = self.data.days.get_mut(day) {
            if let Some(src) = day_data.get_mut("agent") {
                src.tokens_in += input_tokens;
                src.tokens_out += output_tokens;
                src.tool_calls += tool_calls;
                src.cache_read_tokens += cache_read;
                src.cache_creation_tokens += cache_creation;
                src.messages_total += messages;
            }
        }
        self.dirty = true;
    }

    /// Merge one day's attribution (by model / MCP / tool) into the store.
    /// Caller flushes. Used by the session-log scanner alongside the agent totals.
    pub fn record_attribution_for_date(&mut self, day: &str, attr: &DayAttribution) {
        if attr.models.is_empty() && attr.mcp_servers.is_empty() && attr.tools.is_empty() { return; }
        self.data.attribution.entry(day.to_string()).or_default().merge(attr);
        self.dirty = true;
    }

    fn period_start(period: &str) -> String {
        match period {
            "day" => Self::today_key(),
            "week" => (chrono::Local::now() - chrono::Duration::days(7)).format("%Y-%m-%d").to_string(),
            "month" => (chrono::Local::now() - chrono::Duration::days(30)).format("%Y-%m-%d").to_string(),
            _ => "2000-01-01".to_string(),
        }
    }

    /// Aggregate attribution over a period into ranked, dollarized lists:
    /// `byModel` (sorted by est cost), `byMcpServer` (by tool calls), `byTool` (by count).
    pub fn get_attribution(&self, period: &str) -> serde_json::Value {
        let start = Self::period_start(period);
        let mut agg = DayAttribution::default();
        for (day, attr) in &self.data.attribution {
            if day.as_str() < start.as_str() { continue; }
            agg.merge(attr);
        }

        let cost_of = |s: &AttrStats, model: &str| -> f64 {
            let fresh = s.tokens_in.saturating_sub(s.cache_read + s.cache_creation);
            crate::pricing::estimate_cost(model, fresh, s.tokens_out, s.cache_read, s.cache_creation)
        };

        let mut by_model: Vec<serde_json::Value> = agg.models.iter().map(|(name, s)| {
            serde_json::json!({
                "name": name,
                "tokensIn": s.tokens_in, "tokensOut": s.tokens_out,
                "cacheReadTokens": s.cache_read, "toolCalls": s.tool_calls,
                "costUsd": (cost_of(s, name) * 10000.0).round() / 10000.0,
            })
        }).collect();
        by_model.sort_by(|a, b| b["costUsd"].as_f64().unwrap_or(0.0)
            .partial_cmp(&a["costUsd"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));

        let mut by_mcp: Vec<serde_json::Value> = agg.mcp_servers.iter().map(|(name, s)| {
            serde_json::json!({
                "name": name, "toolCalls": s.tool_calls,
                "tokensIn": s.tokens_in, "tokensOut": s.tokens_out,
                "costUsd": (cost_of(s, "") * 10000.0).round() / 10000.0,
            })
        }).collect();
        by_mcp.sort_by(|a, b| b["toolCalls"].as_u64().unwrap_or(0).cmp(&a["toolCalls"].as_u64().unwrap_or(0)));

        let mut by_tool: Vec<serde_json::Value> = agg.tools.iter()
            .map(|(name, c)| serde_json::json!({ "name": name, "count": c }))
            .collect();
        by_tool.sort_by(|a, b| b["count"].as_u64().unwrap_or(0).cmp(&a["count"].as_u64().unwrap_or(0)));

        serde_json::json!({
            "byModel": by_model,
            "byMcpServer": by_mcp,
            "byTool": by_tool.into_iter().take(20).collect::<Vec<_>>(),
            "period": period,
        })
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
            "cacheReadTokens": 0u64, "cacheCreationTokens": 0u64,
        });

        let mut by_source: HashMap<String, serde_json::Value> = HashMap::new();
        for src in SOURCE_TYPES {
            by_source.insert(src.to_string(), serde_json::json!({
                "tokensIn": 0u64, "tokensOut": 0u64, "tokensSaved": 0u64,
                "messagesTotal": 0u64, "messagesOptimized": 0u64, "toolCalls": 0u64,
                "cacheReadTokens": 0u64, "cacheCreationTokens": 0u64,
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
                    summary["cacheReadTokens"] = serde_json::json!(summary["cacheReadTokens"].as_u64().unwrap_or(0) + s.cache_read_tokens);
                    summary["cacheCreationTokens"] = serde_json::json!(summary["cacheCreationTokens"].as_u64().unwrap_or(0) + s.cache_creation_tokens);

                    // Add to by_source
                    if let Some(bs) = by_source.get_mut(*src_key) {
                        bs["tokensIn"] = serde_json::json!(bs["tokensIn"].as_u64().unwrap_or(0) + s.tokens_in);
                        bs["tokensOut"] = serde_json::json!(bs["tokensOut"].as_u64().unwrap_or(0) + s.tokens_out);
                        bs["tokensSaved"] = serde_json::json!(bs["tokensSaved"].as_u64().unwrap_or(0) + s.tokens_saved);
                        bs["messagesTotal"] = serde_json::json!(bs["messagesTotal"].as_u64().unwrap_or(0) + s.messages_total);
                        bs["messagesOptimized"] = serde_json::json!(bs["messagesOptimized"].as_u64().unwrap_or(0) + s.messages_optimized);
                        bs["toolCalls"] = serde_json::json!(bs["toolCalls"].as_u64().unwrap_or(0) + s.tool_calls);
                        bs["cacheReadTokens"] = serde_json::json!(bs["cacheReadTokens"].as_u64().unwrap_or(0) + s.cache_read_tokens);
                        bs["cacheCreationTokens"] = serde_json::json!(bs["cacheCreationTokens"].as_u64().unwrap_or(0) + s.cache_creation_tokens);
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

    /// Today's in+out token total — the cheap counter the live wallpaper polls
    /// to drive its pulses (`get_token_pulse`).
    pub fn today_total_tokens(&self) -> u64 {
        let day = Self::today_key();
        self.data
            .days
            .get(&day)
            .map(|d| d.values().map(|s| s.tokens_in + s.tokens_out).sum())
            .unwrap_or(0)
    }

    pub fn total_tokens_saved(&self) -> u64 {
        self.data.days.values()
            .flat_map(|day| day.values())
            .map(|s| s.tokens_saved)
            .sum()
    }

    // ── Budgets & burn-rate ────────────────────────────────────────────────

    pub fn get_budget(&self) -> serde_json::Value {
        serde_json::to_value(&self.data.budget).unwrap_or_default()
    }

    pub fn set_budget(&mut self, v: serde_json::Value) {
        if let Ok(b) = serde_json::from_value::<BudgetConfig>(v) {
            self.data.budget = b;
            self.dirty = true;
            self.maybe_save();
        }
    }

    /// Real dollarized spend across the attribution ledger for every day
    /// on/after `start` (YYYY-MM-DD). Mirrors `get_attribution`'s cost math.
    fn cost_since(&self, start: &str) -> f64 {
        let mut total = 0.0;
        for (day, attr) in &self.data.attribution {
            if day.as_str() < start {
                continue;
            }
            for (model, s) in &attr.models {
                let fresh = s.tokens_in.saturating_sub(s.cache_read + s.cache_creation);
                total += crate::pricing::estimate_cost(model, fresh, s.tokens_out, s.cache_read, s.cache_creation);
            }
        }
        total
    }

    fn days_in_month(year: i32, month: u32) -> i64 {
        let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
        let first = chrono::NaiveDate::from_ymd_opt(year, month, 1);
        let next = chrono::NaiveDate::from_ymd_opt(ny, nm, 1);
        match (first, next) {
            (Some(f), Some(n)) => (n - f).num_days(),
            _ => 30,
        }
    }

    /// Build a per-period status object: spend-to-date, % of cap, burn rate
    /// ($/day) and the projected end-of-period spend. Only periods with a cap
    /// set (> 0) are included.
    pub fn budget_status(&self) -> serde_json::Value {
        let now = chrono::Local::now();
        let today = now.date_naive();

        let mk = |cap: f64, start: chrono::NaiveDate, days_total: i64| -> serde_json::Value {
            let start_str = start.format("%Y-%m-%d").to_string();
            let spent = self.cost_since(&start_str);
            let days_elapsed = ((today - start).num_days() + 1).max(1);
            let burn = spent / days_elapsed as f64;
            let projected = burn * days_total as f64;
            let pct = if cap > 0.0 { (spent / cap * 100.0).round() as i64 } else { 0 };
            let proj_pct = if cap > 0.0 { (projected / cap * 100.0).round() as i64 } else { 0 };
            serde_json::json!({
                "cap": (cap * 100.0).round() / 100.0,
                "spent": (spent * 10000.0).round() / 10000.0,
                "pct": pct,
                "burnPerDay": (burn * 10000.0).round() / 10000.0,
                "projected": (projected * 100.0).round() / 100.0,
                "projectedPct": proj_pct,
                "daysElapsed": days_elapsed,
                "daysTotal": days_total,
                "overProjected": projected > cap,
                "startDate": start_str,
            })
        };

        let mut out = serde_json::Map::new();

        if self.data.budget.weekly_usd > 0.0 {
            let weekday = today.weekday().num_days_from_monday() as i64;
            let monday = today - chrono::Duration::days(weekday);
            out.insert("weekly".into(), mk(self.data.budget.weekly_usd, monday, 7));
        }
        if self.data.budget.monthly_usd > 0.0 {
            let first = today.with_day(1).unwrap_or(today);
            let dim = Self::days_in_month(today.year(), today.month());
            out.insert("monthly".into(), mk(self.data.budget.monthly_usd, first, dim));
        }

        serde_json::Value::Object(out)
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
