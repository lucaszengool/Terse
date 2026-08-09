// Persists real agent token usage (Claude Code session logs) into the stats store.
//
// One mechanism serves both backfill and live tracking: a per-file byte-offset
// ledger. Each scan reads every recent session JSONL from its last offset to EOF,
// attributes each message's tokens to that message's OWN date, records them, and
// advances the offset. Running it once at startup backfills history; running it on
// an interval captures live growth. Because the offset only moves forward and is
// persisted to disk, nothing is ever counted twice — even across app restarts.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::stats_store::{AttrStats, DayAttribution, StatsStore};

/// Only open session files modified within this window (days). Messages inside
/// them are still attributed to their own (possibly older) date.
const FILE_WINDOW_DAYS: u64 = 30;

fn terse_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse")
}

fn ledger_path() -> PathBuf {
    terse_dir().join("agent_usage_ledger.json")
}

/// Separate offset ledger for the attribution (by-model/MCP/tool) backfill, so it
/// can re-read history independently WITHOUT re-recording token usage.
fn attr_ledger_path() -> PathBuf {
    terse_dir().join("agent_attribution_ledger.json")
}

fn load_ledger_from(path: &PathBuf) -> HashMap<String, u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, u64>>(&s).ok())
        .unwrap_or_default()
}

fn save_ledger_to(path: &PathBuf, ledger: &HashMap<String, u64>) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(ledger) {
        let _ = fs::write(path, json);
    }
}

fn load_ledger() -> HashMap<String, u64> {
    load_ledger_from(&ledger_path())
}

fn save_ledger(ledger: &HashMap<String, u64>) {
    save_ledger_to(&ledger_path(), ledger);
}

/// Recursively collect *.jsonl files under `dir` modified within FILE_WINDOW_DAYS.
fn collect_recent_jsonl(dir: &Path, cutoff: SystemTime, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_recent_jsonl(&path, cutoff, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(meta) = entry.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if mtime >= cutoff {
                        out.push(path);
                    }
                }
            }
        }
    }
}

/// Parse an ISO-8601 timestamp into a local YYYY-MM-DD date string.
fn date_from_timestamp(ts: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

/// Per-line usage extracted from a Claude Code JSONL message.
/// `input` is the TOTAL input (fresh + cache_read + cache_create); `cache_read` and
/// `cache_create` are the cheaper subsets of it, kept separately so cost can be
/// estimated accurately downstream.
#[derive(Default, Clone, Copy)]
struct LineUsage {
    input: u64,
    output: u64,
    tool_calls: u64,
    cache_read: u64,
    cache_create: u64,
    /// Number of assistant turns this usage represents (1 per usable JSONL line).
    messages: u64,
}

/// Model + tool-name attribution carried alongside a line's usage.
#[derive(Default)]
struct LineMeta {
    model: String,
    tools: Vec<String>,
}

/// Extract (date, usage, meta) from one Claude Code JSONL line.
/// Returns None for lines without usable usage data.
fn parse_line(line: &str) -> Option<(String, LineUsage, LineMeta)> {
    let obj: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg = obj.get("message")?;

    let date = obj
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(date_from_timestamp)
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

    let mut u = LineUsage::default();
    if let Some(usage) = msg.get("usage") {
        let raw = usage["input_tokens"].as_u64().unwrap_or(0);
        u.cache_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        u.cache_create = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        u.input = raw + u.cache_read + u.cache_create;
        u.output = usage["output_tokens"].as_u64().unwrap_or(0);
    }

    let mut meta = LineMeta::default();
    meta.model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                u.tool_calls += 1;
                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                    meta.tools.push(name.to_string());
                }
            }
        }
    }

    if u.input == 0 && u.output == 0 && u.tool_calls == 0 {
        return None;
    }
    // Each assistant generation (output tokens present) counts as one message turn.
    if u.output > 0 {
        u.messages = 1;
    }
    Some((date, u, meta))
}

/// Fold one line's model/tool attribution into a day's accumulator.
/// MCP tools are named `mcp__<server>__<tool>`; the server segment is bucketed.
fn apply_meta(day: &mut DayAttribution, u: &LineUsage, meta: &LineMeta) {
    let model = if meta.model.is_empty() { "unknown" } else { meta.model.as_str() };
    let m = day.models.entry(model.to_string()).or_default();
    m.tokens_in += u.input;
    m.tokens_out += u.output;
    m.cache_read += u.cache_read;
    m.cache_creation += u.cache_create;
    m.tool_calls += u.tool_calls;

    for tool in &meta.tools {
        *day.tools.entry(tool.clone()).or_default() += 1;
        if let Some(rest) = tool.strip_prefix("mcp__") {
            let server = rest.split("__").next().unwrap_or(rest);
            if !server.is_empty() {
                let e: &mut AttrStats = day.mcp_servers.entry(server.to_string()).or_default();
                e.tool_calls += 1;
            }
        }
    }
}

/// Read one file from `start_offset` to the last complete line, returning the
/// per-date usage it contains and the new offset. Pure I/O + parsing — touches
/// no shared state, so it runs without holding the stats lock.
fn scan_file(path: &Path, start_offset: u64) -> (HashMap<String, LineUsage>, HashMap<String, DayAttribution>, u64) {
    let file_size = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return (HashMap::new(), HashMap::new(), start_offset),
    };

    // File rotated/truncated (e.g. replaced) — reprocess from the top.
    let offset = if file_size < start_offset { 0 } else { start_offset };
    if file_size <= offset {
        return (HashMap::new(), HashMap::new(), offset);
    }

    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (HashMap::new(), HashMap::new(), offset),
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return (HashMap::new(), HashMap::new(), offset);
    }

    let mut buf = Vec::with_capacity((file_size - offset) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return (HashMap::new(), HashMap::new(), offset);
    }

    // Only consume up to the last newline; a trailing partial line is left for
    // the next scan once it's fully written.
    let last_nl = match buf.iter().rposition(|&b| b == b'\n') {
        Some(p) => p,
        None => return (HashMap::new(), HashMap::new(), offset), // no complete line yet
    };
    let complete = &buf[..=last_nl];

    let mut by_date: HashMap<String, LineUsage> = HashMap::new();
    let mut attr_by_date: HashMap<String, DayAttribution> = HashMap::new();
    for line in complete.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(line) {
            if let Some((date, u, meta)) = parse_line(text) {
                let e = by_date.entry(date.clone()).or_default();
                e.input += u.input;
                e.output += u.output;
                e.tool_calls += u.tool_calls;
                e.cache_read += u.cache_read;
                e.cache_create += u.cache_create;
                e.messages += u.messages;
                apply_meta(attr_by_date.entry(date).or_default(), &u, &meta);
            }
        }
    }

    (by_date, attr_by_date, offset + complete.len() as u64)
}

/// Scan all recent Claude Code session logs (no lock held) and return the
/// newly-seen usage folded per-date plus the advanced ledger. Returns None when
/// there is nothing new to record.
type ScanResult = (HashMap<String, LineUsage>, HashMap<String, DayAttribution>, HashMap<String, u64>);

fn collect_new_usage() -> Option<ScanResult> {
    let home = dirs::home_dir()?;
    let projects = home.join(".claude/projects");
    if !projects.exists() {
        return None;
    }

    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(FILE_WINDOW_DAYS * 24 * 3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut files = Vec::new();
    collect_recent_jsonl(&projects, cutoff, &mut files);
    if files.is_empty() {
        return None;
    }

    let mut ledger = load_ledger();
    let mut totals: HashMap<String, LineUsage> = HashMap::new();
    let mut attr_totals: HashMap<String, DayAttribution> = HashMap::new();
    let mut changed = false;

    for path in &files {
        let key = path.to_string_lossy().to_string();
        let start = ledger.get(&key).copied().unwrap_or(0);
        let (by_date, attr_by_date, new_offset) = scan_file(path, start);
        for (date, u) in by_date {
            let e = totals.entry(date).or_default();
            e.input += u.input;
            e.output += u.output;
            e.tool_calls += u.tool_calls;
            e.cache_read += u.cache_read;
            e.cache_create += u.cache_create;
            e.messages += u.messages;
        }
        for (date, attr) in attr_by_date {
            attr_totals.entry(date).or_default().merge(&attr);
        }
        if new_offset != start {
            ledger.insert(key, new_offset);
            changed = true;
        }
    }

    if changed {
        Some((totals, attr_totals, ledger))
    } else {
        None
    }
}

/// Scan recent Claude Code session logs and fold newly-seen token usage into the
/// stats store. The heavy file parsing happens before the lock is acquired; the
/// store lock is held only for the brief record+flush. Safe to call repeatedly;
/// idempotent via the persisted offset ledger.
pub fn scan_once(store: &Mutex<StatsStore>) {
    // Attribution is handled by `scan_attribution_once` (its own ledger), so the
    // discarded attr map here just goes unused.
    let (totals, _attr, ledger) = match collect_new_usage() {
        Some(v) => v,
        None => return,
    };

    {
        let mut s = store.lock().unwrap_or_else(|e| e.into_inner());
        for (date, u) in &totals {
            s.record_agent_usage_for_date(date, u.input, u.output, u.tool_calls, u.cache_read, u.cache_create, u.messages);
        }
        s.flush();
    }

    // Persist the ledger only after the usage is committed, so a crash mid-write
    // re-reads (and re-records) rather than silently dropping tokens.
    save_ledger(&ledger);
}

/// Record per-model / per-MCP / per-tool attribution over the recent session logs,
/// using its OWN offset ledger — completely independent of usage recording, so the
/// two never double-count each other. Idempotent via the ledger; call it both at
/// startup (backfills history) and on the live interval (captures new activity).
pub fn scan_attribution_once(store: &Mutex<StatsStore>) {
    let home = match dirs::home_dir() { Some(h) => h, None => return };
    let projects = home.join(".claude/projects");
    if !projects.exists() { return; }

    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(FILE_WINDOW_DAYS * 24 * 3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut files = Vec::new();
    collect_recent_jsonl(&projects, cutoff, &mut files);
    if files.is_empty() { return; }

    let path = attr_ledger_path();
    let mut ledger = load_ledger_from(&path);
    let mut attr_totals: HashMap<String, DayAttribution> = HashMap::new();
    let mut changed = false;

    for file in &files {
        let key = file.to_string_lossy().to_string();
        let start = ledger.get(&key).copied().unwrap_or(0);
        let (_usage, attr_by_date, new_offset) = scan_file(file, start);
        for (date, attr) in attr_by_date {
            attr_totals.entry(date).or_default().merge(&attr);
        }
        if new_offset != start {
            ledger.insert(key, new_offset);
            changed = true;
        }
    }

    if !changed { return; }
    {
        let mut s = store.lock().unwrap_or_else(|e| e.into_inner());
        for (date, attr) in &attr_totals {
            s.record_attribution_for_date(date, attr);
        }
        s.flush();
    }
    save_ledger_to(&path, &ledger);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_and_date_and_tools() {
        let line = r#"{"timestamp":"2026-06-23T10:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":50,"output_tokens":40},"content":[{"type":"tool_use","name":"Read"},{"type":"text","text":"hi"}]}}"#;
        let (date, u, meta) = parse_line(line).expect("should parse");
        // 100 + 900 + 50 = 1050 input; output 40; one tool_use
        assert_eq!(u.input, 1050);
        assert_eq!(u.output, 40);
        assert_eq!(u.tool_calls, 1);
        assert_eq!(u.cache_read, 900);
        assert_eq!(u.cache_create, 50);
        assert_eq!(meta.tools, vec!["Read".to_string()]);
        assert!(date.starts_with("2026-06-23") || date.starts_with("2026-06-22"), "got {date}"); // tz-dependent
    }

    #[test]
    fn skips_lines_without_usage() {
        let line = r#"{"timestamp":"2026-06-23T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn offset_only_advances_past_complete_lines() {
        // Two complete lines + a partial third (no trailing newline on the partial).
        let dir = std::env::temp_dir().join("terse_scan_test");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("session.jsonl");
        let complete = "{\"timestamp\":\"2026-06-23T01:00:00Z\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n{\"timestamp\":\"2026-06-23T02:00:00Z\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input_tokens\":20,\"output_tokens\":7}}}\n";
        let partial = "{\"timestamp\":\"2026-06-23T03:00:00Z\",\"message\":{\"role\":\"assist";
        fs::write(&path, format!("{complete}{partial}")).unwrap();

        let (by_date, _attr, new_off) = scan_file(&path, 0);
        // Offset must stop at the end of the last complete line, not include the partial.
        assert_eq!(new_off, complete.len() as u64);
        // Two complete lines: 10+20 input, 5+7 output, attributed to 2026-06-23.
        let (inp, out) = by_date.values().fold((0u64, 0u64), |a, b| (a.0 + b.input, a.1 + b.output));
        assert_eq!(inp, 30);
        assert_eq!(out, 12);

        // Re-scanning from the new offset with no new complete line is a no-op.
        let (again_dates, _again_attr, again_off) = scan_file(&path, new_off);
        assert_eq!(again_off, new_off);
        assert!(again_dates.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
