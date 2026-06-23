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

use crate::stats_store::StatsStore;

/// Only open session files modified within this window (days). Messages inside
/// them are still attributed to their own (possibly older) date.
const FILE_WINDOW_DAYS: u64 = 30;

fn ledger_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".terse")
        .join("agent_usage_ledger.json")
}

fn load_ledger() -> HashMap<String, u64> {
    fs::read_to_string(ledger_path())
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, u64>>(&s).ok())
        .unwrap_or_default()
}

fn save_ledger(ledger: &HashMap<String, u64>) {
    let path = ledger_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(ledger) {
        let _ = fs::write(&path, json);
    }
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

/// Extract (date, input, output, tool_calls) from one Claude Code JSONL line.
/// Returns None for lines without usable usage data.
fn parse_line(line: &str) -> Option<(String, u64, u64, u64)> {
    let obj: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg = obj.get("message")?;

    let date = obj
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(date_from_timestamp)
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

    let (mut input, mut output) = (0u64, 0u64);
    if let Some(usage) = msg.get("usage") {
        let raw = usage["input_tokens"].as_u64().unwrap_or(0);
        let cache_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        let cache_create = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        input = raw + cache_read + cache_create;
        output = usage["output_tokens"].as_u64().unwrap_or(0);
    }

    let mut tool_calls = 0u64;
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                tool_calls += 1;
            }
        }
    }

    if input == 0 && output == 0 && tool_calls == 0 {
        return None;
    }
    Some((date, input, output, tool_calls))
}

/// Read one file from `start_offset` to the last complete line, returning the
/// per-date usage it contains and the new offset. Pure I/O + parsing — touches
/// no shared state, so it runs without holding the stats lock.
fn scan_file(path: &Path, start_offset: u64) -> (HashMap<String, (u64, u64, u64)>, u64) {
    let empty = HashMap::new();
    let file_size = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return (empty, start_offset),
    };

    // File rotated/truncated (e.g. replaced) — reprocess from the top.
    let offset = if file_size < start_offset { 0 } else { start_offset };
    if file_size <= offset {
        return (empty, offset);
    }

    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (empty, offset),
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return (empty, offset);
    }

    let mut buf = Vec::with_capacity((file_size - offset) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return (empty, offset);
    }

    // Only consume up to the last newline; a trailing partial line is left for
    // the next scan once it's fully written.
    let last_nl = match buf.iter().rposition(|&b| b == b'\n') {
        Some(p) => p,
        None => return (empty, offset), // no complete line yet
    };
    let complete = &buf[..=last_nl];

    let mut by_date: HashMap<String, (u64, u64, u64)> = HashMap::new();
    for line in complete.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(line) {
            if let Some((date, inp, out, tc)) = parse_line(text) {
                let e = by_date.entry(date).or_insert((0, 0, 0));
                e.0 += inp;
                e.1 += out;
                e.2 += tc;
            }
        }
    }

    (by_date, offset + complete.len() as u64)
}

/// Scan all recent Claude Code session logs (no lock held) and return the
/// newly-seen usage folded per-date plus the advanced ledger. Returns None when
/// there is nothing new to record.
fn collect_new_usage() -> Option<(HashMap<String, (u64, u64, u64)>, HashMap<String, u64>)> {
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
    let mut totals: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let mut changed = false;

    for path in &files {
        let key = path.to_string_lossy().to_string();
        let start = ledger.get(&key).copied().unwrap_or(0);
        let (by_date, new_offset) = scan_file(path, start);
        for (date, (inp, out, tc)) in by_date {
            let e = totals.entry(date).or_insert((0, 0, 0));
            e.0 += inp;
            e.1 += out;
            e.2 += tc;
        }
        if new_offset != start {
            ledger.insert(key, new_offset);
            changed = true;
        }
    }

    if changed {
        Some((totals, ledger))
    } else {
        None
    }
}

/// Scan recent Claude Code session logs and fold newly-seen token usage into the
/// stats store. The heavy file parsing happens before the lock is acquired; the
/// store lock is held only for the brief record+flush. Safe to call repeatedly;
/// idempotent via the persisted offset ledger.
pub fn scan_once(store: &Mutex<StatsStore>) {
    let (totals, ledger) = match collect_new_usage() {
        Some(v) => v,
        None => return,
    };

    {
        let mut s = store.lock().unwrap_or_else(|e| e.into_inner());
        for (date, (inp, out, tc)) in &totals {
            s.record_agent_usage_for_date(date, *inp, *out, *tc);
        }
        s.flush();
    }

    // Persist the ledger only after the usage is committed, so a crash mid-write
    // re-reads (and re-records) rather than silently dropping tokens.
    save_ledger(&ledger);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_and_date_and_tools() {
        let line = r#"{"timestamp":"2026-06-23T10:00:00.000Z","message":{"role":"assistant","usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":50,"output_tokens":40},"content":[{"type":"tool_use","name":"Read"},{"type":"text","text":"hi"}]}}"#;
        let (date, inp, out, tc) = parse_line(line).expect("should parse");
        // 100 + 900 + 50 = 1050 input; output 40; one tool_use
        assert_eq!(inp, 1050);
        assert_eq!(out, 40);
        assert_eq!(tc, 1);
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

        let (by_date, new_off) = scan_file(&path, 0);
        // Offset must stop at the end of the last complete line, not include the partial.
        assert_eq!(new_off, complete.len() as u64);
        // Two complete lines: 10+20 input, 5+7 output, attributed to 2026-06-23.
        let (inp, out, _tc) = by_date.values().fold((0, 0, 0), |a, b| (a.0 + b.0, a.1 + b.1, a.2 + b.2));
        assert_eq!(inp, 30);
        assert_eq!(out, 12);

        // Re-scanning from the new offset with no new complete line is a no-op.
        let (again_dates, again_off) = scan_file(&path, new_off);
        assert_eq!(again_off, new_off);
        assert!(again_dates.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
