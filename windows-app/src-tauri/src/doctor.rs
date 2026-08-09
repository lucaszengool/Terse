//! Terse Doctor — the "360-style" health scanner.
//!
//! Scans existing Terse telemetry (token attribution, prompt-cache efficiency,
//! MCP/tool bloat, live connected agent sessions) plus Terse's own on-disk junk,
//! and turns each problem into a scored, consent-gated `Finding`. Nothing here
//! mutates agent prompts or deletes anything on its own — `scan()` is read-only,
//! and every remediation runs only when the user explicitly applies a finding via
//! `apply_fix`.
//!
//! Design grounded in the caching research: input compression is a *cost* lever,
//! cache hit-rate is the *speed* lever, and the only cache-safe place to rewrite
//! a prompt is the newest turn. So cache findings are advisory (they guide how
//! the agent should structure prompts), token findings recommend optimization,
//! and junk findings actually delete — but only Terse's own disposable files.
//!
//! Scoring is deliberately honest (anti-scareware): softened per-finding
//! deductions, per-category caps, a cap on the always-on best-practice tips, a
//! requirement that a real HIGH finding exist before the score drops below 70,
//! and a final clamp to [35, 98] — so a clean account lands ~90-94 (never 100)
//! and a noisy one lands ~60-85 (never 0).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// A single scanner result the UI renders as a clean-able card row.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,           // stable id, e.g. "cache:claude-opus-4-8"
    pub category: String,     // "cache" | "mcp" | "prompt" | "loop" | "context" | "cost" | "config" | "junk" | "disk" | "guard"
    pub category_label: String,
    pub severity: String,     // "high" | "medium" | "low"
    pub title: String,
    pub detail: String,
    pub tokens_wasted: u64,
    pub usd_wasted: f64,
    pub bytes: u64,           // for junk findings
    pub latency_note: String, // human note about the speed impact
    pub fix_kind: String,     // "optimize" | "advise" | "delete"
    pub fix_label: String,    // button label, e.g. "Clean", "Enable", "How to fix"
    pub fixable: bool,        // false → advisory only, nothing to apply
    pub paths: Vec<String>,   // concrete files for "delete" findings
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoctorSettings {
    #[serde(default)]
    pub cache_safe_mode: bool, // optimizer only ever rewrites the newest turn
    #[serde(default)]
    pub response_cache: bool, // exact-match local response cache for repeats
    #[serde(default)]
    pub compression: bool, // compress / truncate verbose tool results
    #[serde(default)]
    pub dismissed: Vec<String>, // finding ids the user told us to stop flagging
    // ── Toggles behind the newly one-click-fixable findings ──
    #[serde(default)]
    pub prewarm_cache: bool, // send a cheap keepalive so the prefix stays warm past its TTL
    #[serde(default)]
    pub stable_tool_order: bool, // freeze tool/MCP ordering so the cached prefix stays byte-identical
    #[serde(default)]
    pub cap_output: bool, // ask for a max_tokens ceiling on output-heavy models
    #[serde(default)]
    pub auto_compact: bool, // compact a session automatically as it nears the window limit
    #[serde(default)]
    pub route_cheap_models: bool, // route small/mechanical turns off the frontier model
}

fn terse_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse")
}

fn settings_path() -> PathBuf {
    terse_dir().join("doctor.json")
}

pub fn load_settings() -> DoctorSettings {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(s: &DoctorSettings) {
    let _ = fs::create_dir_all(terse_dir());
    if let Ok(txt) = serde_json::to_string_pretty(s) {
        let _ = fs::write(settings_path(), txt);
    }
}

/// USD recoverable if `tokens` that were billed at full input price had instead
/// been served from the prompt cache (≈0.1× input).
fn cache_savings_usd(model: &str, tokens: u64) -> f64 {
    let full = crate::pricing::estimate_cost(model, tokens, 0, 0, 0);
    let cached = crate::pricing::estimate_cost(model, 0, 0, tokens, 0);
    (full - cached).max(0.0)
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

// ── small JSON accessors ─────────────────────────────────────────────────────

fn u(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}
fn f(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

// ── Cache-health findings (the speed axis) ───────────────────────────────────

const TARGET_HIT_RATE: f64 = 0.75; // a well-structured agent prompt caches ~75%+

/// cache:low-hit-rate — per-model cache miss, tightened gate (>=20k input, <55% hit).
fn scan_cache_low_hit(attr: &Value, out: &mut Vec<Finding>) {
    const MIN_VOLUME: u64 = 20_000; // lowered 5x from 100k so most real accounts trip it
    let models = match attr.get("byModel").and_then(|v| v.as_array()) {
        Some(m) => m,
        None => return,
    };
    for m in models {
        let name = s(m, "name");
        if name.is_empty() || name == "unknown" {
            continue;
        }
        let tokens_in = u(m, "tokensIn");
        let cache_read = u(m, "cacheReadTokens");
        if tokens_in < MIN_VOLUME {
            continue;
        }
        let hit_rate = cache_read as f64 / tokens_in as f64;
        if hit_rate >= 0.55 {
            continue; // already caching reasonably
        }
        let recoverable = (((TARGET_HIT_RATE - hit_rate) * tokens_in as f64) as u64)
            .min(tokens_in.saturating_sub(cache_read));
        let usd = cache_savings_usd(name, recoverable);
        let pct = (hit_rate * 100.0).round() as u64;
        let severity = if usd >= 3.0 { "high" } else if usd >= 0.5 { "medium" } else { "low" };
        out.push(Finding {
            id: format!("cache:low-hit-rate:{name}"),
            category: "cache".into(),
            category_label: "Cache Health".into(),
            severity: severity.into(),
            title: format!("{} cached only {}% of its input", short_model(name), pct),
            detail: format!(
                "A well-structured agent prefix caches 75%+ of its input; this model is at {pct}%. \
                 The cacheable prefix (system prompt, tool list, or prior turns) is mutating between \
                 requests — a timestamp, reordered tools, or a tool that rewrites history. Keep the \
                 prefix byte-identical so only the newest turn varies, and set cache_control on the \
                 last static block."
            ),
            tokens_wasted: recoverable,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Cache misses pay full prefill — up to ~67% slower time-to-first-token on long prompts.".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

/// cache:write-thrash — account-level: writes (1.25x) exceed reads (0.1x).
fn scan_cache_write_thrash(summary: &Value, attr: &Value, out: &mut Vec<Finding>) {
    let creation = u(summary, "cacheCreationTokens");
    let reads = u(summary, "cacheReadTokens");
    if creation <= reads || creation < 10_000 {
        return;
    }
    let model = dominant_model(attr);
    // Cost of writing those tokens (1.25x input) vs serving them as reads (0.1x): the delta wasted.
    let write_cost = crate::pricing::estimate_cost(&model, 0, 0, 0, creation);
    let read_cost = crate::pricing::estimate_cost(&model, 0, 0, creation, 0);
    let usd = (write_cost - read_cost).max(0.0);
    out.push(Finding {
        id: "cache:write-thrash".into(),
        category: "cache".into(),
        category_label: "Cache Health".into(),
        severity: if usd >= 3.0 { "high" } else { "medium" }.into(),
        title: format!("{} is re-writing the cache more than it reads it", short_model(&model)),
        detail:
            "Cache thrashing: cache writes (billed at ~1.25x input) exceed cache reads (~0.1x), so \
             caching is costing MORE than it saves. The prefix is changing every turn (reordered \
             tools, an injected timestamp, history rewrite) or the 5-minute TTL is expiring on idle \
             gaps and forcing re-writes. Pin a byte-stable prefix and consider the 1-hour TTL."
                .into(),
        tokens_wasted: creation,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Every cache re-write re-pays the full prefill.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: vec![],
    });
}

/// cache:never-engaged — a model with real input but zero cache reads & zero account writes.
fn scan_cache_never_engaged(summary: &Value, attr: &Value, out: &mut Vec<Finding>) {
    let acct_creation = u(summary, "cacheCreationTokens");
    if acct_creation != 0 {
        return; // caching is engaged somewhere this period
    }
    let models = match attr.get("byModel").and_then(|v| v.as_array()) {
        Some(m) => m,
        None => return,
    };
    for m in models {
        let name = s(m, "name");
        if name.is_empty() || name == "unknown" {
            continue;
        }
        let tokens_in = u(m, "tokensIn");
        let cache_read = u(m, "cacheReadTokens");
        if tokens_in < 15_000 || cache_read != 0 {
            continue;
        }
        let recoverable = (tokens_in as f64 * 0.75) as u64; // assume 75% cacheable prefix
        let usd = cache_savings_usd(name, recoverable);
        let severity = if usd >= 3.0 { "high" } else if usd >= 0.5 { "medium" } else { "low" };
        out.push(Finding {
            id: format!("cache:never-engaged:{name}"),
            category: "cache".into(),
            category_label: "Cache Health".into(),
            severity: severity.into(),
            title: format!("Prompt caching never engaged on {}", short_model(name)),
            detail:
                "Caching is completely off for this model — no cache reads and no cache writes. \
                 Either the prefix is below the minimum cacheable floor (1024 tokens for \
                 Sonnet/Opus-class, more for Haiku) or cache_control is simply not set on the static \
                 prefix. This is the single biggest recoverable line item: ~90% off the static \
                 portion once enabled."
                    .into(),
            tokens_wasted: recoverable,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "No prefill reuse — full time-to-first-token on every turn.".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

/// cache:idle-ttl-churn — advisory keyed to the thrash signal: recommend 1h TTL.
fn scan_cache_idle_ttl(summary: &Value, attr: &Value, out: &mut Vec<Finding>) {
    let creation = u(summary, "cacheCreationTokens");
    let reads = u(summary, "cacheReadTokens");
    let tokens_in = u(summary, "tokensIn");
    if creation < 5_000 || tokens_in == 0 {
        return;
    }
    let hit_rate = reads as f64 / tokens_in as f64;
    if hit_rate >= 0.5 {
        return;
    }
    let model = dominant_model(attr);
    let write_cost = crate::pricing::estimate_cost(&model, 0, 0, 0, creation);
    let read_cost = crate::pricing::estimate_cost(&model, 0, 0, creation, 0);
    let usd = (write_cost - read_cost).max(0.0);
    out.push(Finding {
        id: "cache:idle-ttl-churn".into(),
        category: "cache".into(),
        category_label: "Cache Health".into(),
        severity: "medium".into(),
        title: "Bursty usage is letting the cache expire between requests".into(),
        detail:
            "Low hit rate together with meaningful cache writes is the classic signature of the \
             default 5-minute cache window evicting on idle gaps, forcing re-writes. Switch the \
             breakpoint to the 1-hour TTL ({\"type\":\"ephemeral\",\"ttl\":\"1h\"}) or send a cheap \
             keepalive so the prefix stays warm between bursts."
                .into(),
        tokens_wasted: creation,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Each cache expiry re-pays the full prefill.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: vec![],
    });
}

/// cache:session-pinned-zero — live session running near 0% cache efficiency.
fn scan_cache_session_pinned(sessions: &[Value], out: &mut Vec<Finding>) {
    for sess in sessions {
        let turns = u(sess, "turns");
        let eff = u(sess, "cacheEfficiency");
        let ctx = u(sess, "currentContext");
        if turns < 3 || eff >= 15 || ctx < 2_000 {
            continue;
        }
        let agent = session_agent(sess);
        let model = session_model(sess);
        // ~75% of the prefix should have been a cache read, every turn.
        let recoverable = ((ctx as f64 * 0.75) * turns as f64) as u64;
        let usd = cache_savings_usd(&model, recoverable);
        out.push(Finding {
            id: format!("cache:session-pinned-zero:{}", session_id(sess)),
            category: "cache".into(),
            category_label: "Cache Health".into(),
            severity: "high".into(),
            title: format!("Live agent {agent} is running at {eff}% cache efficiency"),
            detail:
                "This connected session is reading almost nothing from cache after several turns — \
                 a dynamic value (timestamp, UUID, request-id, 'Current date/time') is sitting inside \
                 the cacheable prefix, or the tools are reordered each turn. This is the single most \
                 common cache failure mode. Move all volatile content after the cache breakpoint."
                    .into(),
            tokens_wasted: recoverable,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "0% hit rate = full prefill every turn (~67% slower TTFT on long prompts).".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

// ── MCP / tool-bloat findings (prefill weight) ───────────────────────────────

/// mcp:server-count — >=2 servers loaded on every request; surface the tail.
fn scan_mcp_server_count(attr: &Value, out: &mut Vec<Finding>) {
    let servers = match attr.get("byMcpServer").and_then(|v| v.as_array()) {
        Some(s) => s,
        None => return,
    };
    if servers.len() < 2 {
        return;
    }
    let mut named: Vec<(String, u64, u64)> = servers
        .iter()
        .map(|sv| (s(sv, "name").to_string(), u(sv, "toolCalls"), u(sv, "tokensIn")))
        .collect();
    named.sort_by_key(|(_, calls, _)| *calls);
    let rarely_used: Vec<String> = named
        .iter()
        .filter(|(_, calls, _)| *calls <= 5)
        .map(|(n, _, _)| n.clone())
        .collect();
    let list = if rarely_used.is_empty() {
        named.iter().take(3).map(|(n, _, _)| n.clone()).collect::<Vec<_>>()
    } else {
        rarely_used.clone()
    };
    // Conservative: ~26k prefill tokens per disabled server.
    let reclaimable = (rarely_used.len().max(1) as u64) * 26_000;
    let model = dominant_model(attr);
    let usd = crate::pricing::estimate_cost(&model, reclaimable, 0, 0, 0);
    let severity = if !rarely_used.is_empty() || servers.len() >= 3 { "medium" } else { "low" };
    out.push(Finding {
        id: "mcp:server-count".into(),
        category: "mcp".into(),
        category_label: "Tool / MCP Bloat".into(),
        severity: severity.into(),
        title: format!("{} MCP servers loaded on every request", servers.len()),
        detail: format!(
            "Each MCP server injects its tool definitions into every request prefix — a GitHub-class \
             server alone can be 17-55K tokens. Cheapest to disable or defer-load (fewest calls): {}. \
             Trimming the long tail shrinks every request and speeds up prefill.",
            list.join(", ")
        ),
        tokens_wasted: reclaimable,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Smaller tool set = less prefill on every turn; tool-search can cut ~85% of tool tokens.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        // The fix disables exactly the servers named in the detail — the cheapest
        // tail, never the ones actually being called.
        paths: list.iter().map(|s| s.to_string()).collect(),
    });
}

/// mcp:dead-server — a connected server with zero tool calls over the period.
fn scan_mcp_dead_server(attr: &Value, summary: &Value, period: &str, out: &mut Vec<Finding>) {
    // Only meaningful over a real idle window.
    if period == "day" {
        return;
    }
    let servers = match attr.get("byMcpServer").and_then(|v| v.as_array()) {
        Some(s) => s,
        None => return,
    };
    let dead: Vec<String> = servers
        .iter()
        .filter(|sv| u(sv, "toolCalls") == 0)
        .map(|sv| s(sv, "name").to_string())
        .filter(|n| !n.is_empty())
        .collect();
    if dead.is_empty() {
        return;
    }
    let model = dominant_model(attr);
    // ~4000 tokens/turn of dead schema; estimate turns from message volume, floor 10k.
    let turns = u(summary, "messagesTotal").max(1);
    let per_server = (4_000u64.saturating_mul(turns)).max(10_000);
    let total_tokens = per_server * dead.len() as u64;
    let usd = crate::pricing::estimate_cost(&model, total_tokens, 0, 0, 0);
    let name = if dead.len() == 1 {
        format!("'{}' is connected but never called", dead[0])
    } else {
        format!("{} MCP servers connected but never called", dead.len())
    };
    out.push(Finding {
        id: "mcp:dead-server".into(),
        category: "mcp".into(),
        category_label: "Tool / MCP Bloat".into(),
        severity: "medium".into(),
        title: format!("MCP server {name}"),
        detail: format!(
            "These MCP servers loaded their schemas into every turn but were never invoked: {}. \
             That is pure prefill waste at ~200-550 tokens/tool. Disconnect them (delete from config) \
             or set defer_loading:true — recoverable on every turn with zero capability loss.",
            dead.join(", ")
        ),
        tokens_wasted: total_tokens,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Dead schemas inflate prefill on every single turn.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: dead.iter().map(|s| s.to_string()).collect(),
    });
}

/// mcp:single-bloated-server — one server dominates the tool prefix.
fn scan_mcp_bloated_server(attr: &Value, out: &mut Vec<Finding>) {
    let servers = match attr.get("byMcpServer").and_then(|v| v.as_array()) {
        Some(s) => s,
        None => return,
    };
    if servers.len() < 2 {
        return;
    }
    let total_in: u64 = servers.iter().map(|sv| u(sv, "tokensIn")).sum();
    if total_in == 0 {
        return;
    }
    let model = dominant_model(attr);
    for sv in servers {
        let name = s(sv, "name");
        if name.is_empty() {
            continue;
        }
        let tin = u(sv, "tokensIn");
        let big = tin >= 10_000 || (tin as f64) >= 0.5 * total_in as f64;
        if !big {
            continue;
        }
        let reclaimable = (tin as f64 * 0.7) as u64; // toolset filtering recovers ~70%
        let usd = crate::pricing::estimate_cost(&model, reclaimable, 0, 0, 0);
        let severity = if tin >= 30_000 { "high" } else { "medium" };
        out.push(Finding {
            id: format!("mcp:single-bloated-server:{name}"),
            category: "mcp".into(),
            category_label: "Tool / MCP Bloat".into(),
            severity: severity.into(),
            title: format!("'{name}' dominates your tool prefix"),
            detail: format!(
                "'{name}' contributes a disproportionate share of your tool input tokens — \
                 GitHub-class servers carry ~93 tools / 17-55K tokens. Enable only the toolsets you \
                 actually use, or put it behind tool search so its schemas load on demand."
            ),
            tokens_wasted: reclaimable,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "A single bloated server can dominate prefill on every turn.".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![name.to_string()],
        });
        break; // one bloated-server finding is enough
    }
}

/// mcp:unused-default-tools — live session loaded many tools it never used.
fn scan_mcp_unused_tools(sessions: &[Value], out: &mut Vec<Finding>) {
    for sess in sessions {
        let turns = u(sess, "turns");
        let tm = match sess.get("toolManagement") {
            Some(v) => v,
            None => continue,
        };
        let unused = u(tm, "unusedEstimate");
        let overhead = u(tm, "estimatedOverhead");
        if turns < 5 || unused < 8 {
            continue;
        }
        let tokens = overhead.saturating_mul(turns);
        let model = session_model(sess);
        let usd = crate::pricing::estimate_cost(&model, tokens, 0, 0, 0);
        let severity = if usd >= 0.5 { "medium" } else { "low" };
        out.push(Finding {
            id: format!("mcp:unused-default-tools:{}", session_id(sess)),
            category: "mcp".into(),
            category_label: "Tool / MCP Bloat".into(),
            severity: severity.into(),
            title: format!("{unused} loaded tools went unused this session"),
            detail: format!(
                "{unused} default/loaded tools were never invoked across {turns} turns, yet each \
                 paid ~300 tokens of prefill every turn. Prune the tool set or defer the long tail \
                 behind tool search — selection accuracy also improves past the ~5-7 tool ceiling."
            ),
            tokens_wasted: tokens,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Unused tool schemas inflate prefill on every turn.".into(),
            // Session-scoped: we know how many tools went unused, not which
            // servers they came from, so this can't name servers to disable.
            // The honest one-click action is Terse's own tool-result compression,
            // which cuts the same prefill waste without guessing.
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

// ── Agent-loop findings (live sessions) ──────────────────────────────────────

/// loop:duplicate-tool-calls — repeated (tool,args); recommend result cache.
fn scan_loop_duplicate_calls(sessions: &[Value], settings: &DoctorSettings, out: &mut Vec<Finding>) {
    for sess in sessions {
        let tcp = match sess.get("toolCachePotential") {
            Some(v) => v,
            None => continue,
        };
        let dups = u(tcp, "duplicateCalls");
        let dup_tokens = u(tcp, "duplicateCallTokens");
        if dups < 2 {
            continue;
        }
        let model = session_model(sess);
        let usd = crate::pricing::estimate_cost(&model, dup_tokens, 0, 0, 0);
        let severity = if dup_tokens >= 2_000 { "high" } else if dup_tokens >= 500 { "medium" } else { "low" };
        out.push(Finding {
            id: format!("loop:duplicate-tool-calls:{}", session_id(sess)),
            category: "loop".into(),
            category_label: "Agent Loops".into(),
            severity: severity.into(),
            title: format!("{dups} duplicate tool calls wasted {dup_tokens} tokens"),
            detail:
                "The agent re-ran the same (tool, args) more than once in this session. Each \
                 duplicate is a wasted LLM round-trip plus re-fetched result tokens. Enable Terse's \
                 local result cache to block exact repeats, or add a debounce hook."
                    .into(),
            tokens_wasted: dup_tokens,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Each avoided round-trip saves ~1-5s of wall-clock.".into(),
            fix_kind: "optimize".into(),
            fix_label: "Enable result cache".into(),
            fixable: !settings.response_cache,
            paths: vec![],
        });
    }
}

/// loop:redundant-reads — re-read of unchanged files; recommend result cache.
fn scan_loop_redundant_reads(sessions: &[Value], settings: &DoctorSettings, out: &mut Vec<Finding>) {
    for sess in sessions {
        let waste = u(sess, "rereadWaste");
        if waste < 800 {
            continue;
        }
        // Pick the worst-offending path for the title, if present.
        let (worst_path, worst_count) = sess
            .get("redundantReads")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .max_by_key(|r| u(r, "count"))
                    .map(|r| (s(r, "path").to_string(), u(r, "count")))
            })
            .unwrap_or_default();
        let model = session_model(sess);
        let usd = crate::pricing::estimate_cost(&model, waste, 0, 0, 0);
        let severity = if waste >= 4_000 { "high" } else if waste >= 1_600 { "medium" } else { "low" };
        let title = if worst_count > 0 {
            format!("Re-read {} {} times", basename(&worst_path), worst_count)
        } else {
            "Re-read the same file multiple times".to_string()
        };
        out.push(Finding {
            id: format!("loop:redundant-reads:{}", session_id(sess)),
            category: "loop".into(),
            category_label: "Agent Loops".into(),
            severity: severity.into(),
            title,
            detail:
                "The agent re-read unchanged files across non-adjacent steps. Read-type ops are ~76% \
                 of agent tokens, so a result cache keyed on the target id recovers the bulk of that. \
                 Enable Terse's local result cache."
                    .into(),
            tokens_wasted: waste,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Avoids re-fetch round-trips as well as tokens.".into(),
            fix_kind: "optimize".into(),
            fix_label: "Enable result cache".into(),
            fixable: !settings.response_cache,
            paths: vec![],
        });
    }
}

/// loop:uncompressed-tool-results — verbose tool output that compresses well.
fn scan_loop_uncompressed_results(sessions: &[Value], settings: &DoctorSettings, out: &mut Vec<Finding>) {
    for sess in sessions {
        let trs = match sess.get("toolResultStats") {
            Some(v) => v,
            None => continue,
        };
        let compressible = u(trs, "compressibleTokens");
        let large = u(trs, "largeCount");
        if compressible < 1_500 && large < 2 {
            continue;
        }
        let model = session_model(sess);
        let usd = crate::pricing::estimate_cost(&model, compressible, 0, 0, 0);
        let severity = if compressible >= 8_000 { "high" } else if compressible >= 3_000 { "medium" } else { "low" };
        out.push(Finding {
            id: format!("loop:uncompressed-tool-results:{}", session_id(sess)),
            category: "loop".into(),
            category_label: "Agent Loops".into(),
            severity: severity.into(),
            title: format!("{compressible} tokens of tool output are compressible"),
            detail:
                "Verbose bash/test/build/log output is 60-90% compressible and large raw results also \
                 break downstream caching. Truncate or structure tool results before they enter the \
                 context. Turn on Terse compression on the result path."
                    .into(),
            tokens_wasted: compressible,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Oversized results dominate context and break prompt caching.".into(),
            fix_kind: "optimize".into(),
            fix_label: "Compress results".into(),
            fixable: !settings.compression,
            paths: vec![],
        });
    }
}

// ── Context-bloat findings (live sessions) ───────────────────────────────────

/// context:near-window-limit — session context fill past ~60%.
fn scan_context_near_limit(sessions: &[Value], out: &mut Vec<Finding>) {
    for sess in sessions {
        let fill = u(sess, "contextFill");
        if fill < 60 {
            continue;
        }
        let agent = session_agent(sess);
        let ctx = u(sess, "currentContext");
        let model = session_model(sess);
        let prunable = (ctx as f64 * 0.3) as u64;
        let usd = crate::pricing::estimate_cost(&model, prunable, 0, 0, 0);
        let severity = if fill >= 80 { "high" } else { "medium" };
        out.push(Finding {
            id: format!("context:near-window-limit:{}", session_id(sess)),
            category: "context".into(),
            category_label: "Context Bloat".into(),
            severity: severity.into(),
            title: format!("{agent} context is {fill}% full"),
            detail:
                "Past ~70% the running context drives cost up quadratically, raises latency, and \
                 increases hallucination and lossy auto-summarization. Prune stale tool outputs via \
                 observation masking rather than an LLM summary — truncating a bloated history can cut \
                 late-turn input ~90%."
                    .into(),
            tokens_wasted: prunable,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Context grows cost quadratically and slows decode.".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

/// context:high-burn-rate — very high sustained tokens/min on a long session.
fn scan_context_burn_rate(sessions: &[Value], out: &mut Vec<Finding>) {
    for sess in sessions {
        let rate = u(sess, "burnRate");
        let mins = u(sess, "elapsedMinutes");
        if rate < 50_000 || mins < 3 {
            continue;
        }
        let agent = session_agent(sess);
        let severity = if rate >= 120_000 { "medium" } else { "low" };
        out.push(Finding {
            id: format!("context:high-burn-rate:{}", session_id(sess)),
            category: "context".into(),
            category_label: "Context Bloat".into(),
            severity: severity.into(),
            title: format!("Burning {} tokens/min on {agent}", thousands(rate)),
            detail:
                "A very high sustained burn rate on a long session signals runaway context \
                 accumulation or retry churn. Set step/token/wall-clock budget caps and a circuit \
                 breaker so an unbounded loop can't compound."
                    .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: "Unbounded loops compound cost every iteration.".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

// ── Prompt-waste findings (the token axis) ───────────────────────────────────

/// prompt:unoptimized — tightened gates (>=5 messages, <75% optimized).
fn scan_prompt_unoptimized(summary: &Value, attr: &Value, out: &mut Vec<Finding>) {
    let total = u(summary, "messagesTotal");
    let optimized = u(summary, "messagesOptimized");
    let saved = u(summary, "tokensSaved");
    if total < 5 {
        return;
    }
    let unoptimized = total.saturating_sub(optimized);
    if unoptimized == 0 {
        return;
    }
    let opt_rate = optimized as f64 / total as f64;
    if opt_rate >= 0.75 {
        return;
    }
    let per_msg = if optimized > 0 { saved as f64 / optimized as f64 } else { 40.0 };
    let tokens = (per_msg * unoptimized as f64) as u64;
    let model = dominant_model(attr);
    let usd = crate::pricing::estimate_cost(&model, tokens, 0, 0, 0);
    out.push(Finding {
        id: "prompt:unoptimized".into(),
        category: "prompt".into(),
        category_label: "Prompt Waste".into(),
        severity: if unoptimized >= 50 { "medium" } else { "low" }.into(),
        title: format!("{unoptimized} messages sent without optimization"),
        detail: format!(
            "Terse has already saved {saved} tokens on the {optimized} messages it optimized. \
             Turning on auto-optimize (cache-safe mode) applies the same trimming — politeness, \
             filler, markdown — to the rest, safely rewriting only the newest turn so cached history \
             is never mutated."
        ),
        tokens_wasted: tokens,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Token trimming is a cost lever — it lowers spend without touching cache.".into(),
        fix_kind: "optimize".into(),
        fix_label: "Enable cache-safe mode".into(),
        fixable: true,
        paths: vec![],
    });
}

/// prompt:low-savings-rate — account-level percentSaved is very low.
fn scan_prompt_low_savings(summary: &Value, attr: &Value, out: &mut Vec<Finding>) {
    let tokens_in = u(summary, "tokensIn");
    if tokens_in < 20_000 {
        return;
    }
    let pct = u(summary, "percentSaved"); // already 0-100 integer
    if pct >= 10 {
        return;
    }
    let reachable_frac = (0.30 - pct as f64 / 100.0).max(0.0);
    let tokens = (tokens_in as f64 * reachable_frac) as u64;
    let model = dominant_model(attr);
    let usd = crate::pricing::estimate_cost(&model, tokens, 0, 0, 0);
    out.push(Finding {
        id: "prompt:low-savings-rate".into(),
        category: "prompt".into(),
        category_label: "Prompt Waste".into(),
        severity: if pct < 3 { "medium" } else { "low" }.into(),
        title: format!("Only {pct}% of your input tokens are being trimmed"),
        detail:
            "Well-optimized prompts cut 40-70% of input; your overall savings rate is far below that, \
             meaning most volume bypasses Terse entirely. Turn on auto-optimize for all sources so \
             every request gets trimmed, not just a handful."
                .into(),
        tokens_wasted: tokens,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Trimming lowers spend without touching cache.".into(),
        fix_kind: "optimize".into(),
        fix_label: "Enable cache-safe mode".into(),
        fixable: true,
        paths: vec![],
    });
}

// ── Cost / routing findings ──────────────────────────────────────────────────

fn is_frontier(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("opus") || n.contains("gpt-5") || n.contains("o3")
}

/// cost:frontier-overuse — a premium model carries the majority of cost.
fn scan_cost_frontier(attr: &Value, out: &mut Vec<Finding>) {
    let models = match attr.get("byModel").and_then(|v| v.as_array()) {
        Some(m) => m,
        None => return,
    };
    if models.is_empty() {
        return;
    }
    let total_cost: f64 = models.iter().map(|m| f(m, "costUsd")).sum();
    if total_cost < 1.0 {
        return;
    }
    // byModel is sorted by cost desc → first is the top model.
    let top = &models[0];
    let name = s(top, "name");
    let top_cost = f(top, "costUsd");
    if !is_frontier(name) || top_cost < 0.6 * total_cost {
        return;
    }
    let usd = top_cost * 0.5; // half routable to a cheaper tier at ~same quality
    let pct = ((top_cost / total_cost) * 100.0).round() as u64;
    out.push(Finding {
        id: format!("cost:frontier-overuse:{name}"),
        category: "cost".into(),
        category_label: "Cost / Routing".into(),
        severity: "high".into(),
        title: format!("{pct}% of spend is on premium {}", short_model(name)),
        detail:
            "A premium model is handling the majority of your cost while cheaper tiers exist. Frontier \
             vs small models are ~60x on input price — add a routing layer that sends summarization, \
             extraction, and simple Q&A to a Haiku/mini tier. Routing ~70% of volume to a small model \
             cuts the input bill roughly two-thirds."
                .into(),
        tokens_wasted: u(top, "tokensIn") / 2,
        usd_wasted: round2(usd),
        bytes: 0,
        latency_note: "Small models are also faster.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: vec![],
    });
}

/// cost:output-heavy — output tokens dominate for a model.
fn scan_cost_output_heavy(attr: &Value, out: &mut Vec<Finding>) {
    let models = match attr.get("byModel").and_then(|v| v.as_array()) {
        Some(m) => m,
        None => return,
    };
    for m in models {
        let name = s(m, "name");
        if name.is_empty() || name == "unknown" {
            continue;
        }
        let tin = u(m, "tokensIn");
        let tout = u(m, "tokensOut");
        if tout < tin || tout < 20_000 {
            continue;
        }
        let trim = (tout as f64 * 0.4) as u64;
        let usd = crate::pricing::estimate_cost(name, 0, trim, 0, 0);
        // Output cost share of that model.
        let out_cost = crate::pricing::estimate_cost(name, 0, tout, 0, 0);
        let in_cost = crate::pricing::estimate_cost(name, tin, 0, 0, 0);
        let out_share = if out_cost + in_cost > 0.0 { out_cost / (out_cost + in_cost) } else { 0.0 };
        let severity = if out_share >= 0.7 { "high" } else { "medium" };
        out.push(Finding {
            id: format!("cost:output-heavy:{name}"),
            category: "cost".into(),
            category_label: "Cost / Routing".into(),
            severity: severity.into(),
            title: format!("{} output tokens are dominating cost", short_model(name)),
            detail:
                "Output bills 3-10x input per token, and this model is generating more output than it \
                 reads on work that isn't pure generation. Constrain it with max_tokens, length limits, \
                 or 'answer in N words' — a 60% output cut is a direct 60% cut on the dominant line."
                    .into(),
            tokens_wasted: trim,
            usd_wasted: round2(usd),
            bytes: 0,
            latency_note: "Less output also means faster decode.".into(),
            fix_kind: "advise".into(),
            fix_label: "How to fix".into(),
            fixable: false,
            paths: vec![],
        });
    }
}

// ── Best-practice (always-on, static) advisories ─────────────────────────────

fn push_config_cache_safe(settings: &DoctorSettings, out: &mut Vec<Finding>) {
    if settings.cache_safe_mode {
        return;
    }
    out.push(Finding {
        id: "config:cache-safe-mode".into(),
        category: "config".into(),
        category_label: "Best Practice".into(),
        severity: "low".into(),
        title: "Turn on cache-safe optimization".into(),
        detail:
            "Cache-safe mode makes Terse only ever rewrite your newest turn — never mutating cached \
             history — so optimization can never cost you a cache hit. One click enables it."
                .into(),
        tokens_wasted: 0,
        usd_wasted: 0.0,
        bytes: 0,
        latency_note: "Keeps the prefix byte-stable, protecting your cache hit rate.".into(),
        fix_kind: "optimize".into(),
        fix_label: "Enable".into(),
        fixable: true,
        paths: vec![],
    });
}

fn push_config_stable_tool_order(attr: &Value, sessions: &[Value], out: &mut Vec<Finding>) {
    let has_mcp = attr.get("byMcpServer").and_then(|v| v.as_array()).map_or(false, |a| !a.is_empty());
    let has_tools = sessions.iter().any(|s| {
        s.get("toolManagement")
            .and_then(|tm| tm.get("used"))
            .and_then(|u| u.as_object())
            .map_or(false, |m| !m.is_empty())
    });
    if !has_mcp && !has_tools {
        return;
    }
    out.push(Finding {
        id: "config:stable-tool-order".into(),
        category: "config".into(),
        category_label: "Best Practice".into(),
        severity: "low".into(),
        title: "Pin a stable tool / JSON ordering".into(),
        detail:
            "Serialize tool definitions in deterministic (name-sorted) order with pinned JSON key \
             ordering, and treat the tool block as append-only. Tools sit at cache position 0, so any \
             reorder cold-reprocesses the entire prefix at full price."
                .into(),
        tokens_wasted: 0,
        usd_wasted: 0.0,
        bytes: 0,
        latency_note: "Stable ordering preserves the full cached prefix.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: vec![],
    });
}

fn push_config_prewarm(has_cache_finding: bool, out: &mut Vec<Finding>) {
    if has_cache_finding {
        return; // suppress to avoid noise when concrete cache findings already fired
    }
    out.push(Finding {
        id: "config:prewarm-cache".into(),
        category: "config".into(),
        category_label: "Best Practice".into(),
        severity: "low".into(),
        title: "Pre-warm and keep your cache warm".into(),
        detail:
            "For bursty or long-running agents, consolidate stable instructions + tools + few-shot \
             into one prefix above the model's min-cacheable floor, set the cache_control breakpoint \
             on the last byte-identical block, and use the 1h TTL (or a cheap keepalive) so idle gaps \
             don't evict it."
                .into(),
        tokens_wasted: 0,
        usd_wasted: 0.0,
        bytes: 0,
        latency_note: "A warm cache yields up to ~80% TTFT reduction.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: vec![],
    });
}

fn push_config_cap_output(has_output_finding: bool, out: &mut Vec<Finding>) {
    if has_output_finding {
        return; // suppress when cost:output-heavy already fired
    }
    out.push(Finding {
        id: "config:cap-output".into(),
        category: "config".into(),
        category_label: "Best Practice".into(),
        severity: "low".into(),
        title: "Set max_tokens and stop sequences".into(),
        detail:
            "Cap max_tokens to ~1.3x your observed P95 output and add stop sequences for structured \
             outputs. This bounds runaway-generation blast radius and removes the truncation→retry \
             multiplier."
                .into(),
        tokens_wasted: 0,
        usd_wasted: 0.0,
        bytes: 0,
        latency_note: "Caps worst-case decode time.".into(),
        fix_kind: "advise".into(),
        fix_label: "How to fix".into(),
        fixable: false,
        paths: vec![],
    });
}

// ── Junk findings (the literal "clean disk" 360 part) ────────────────────────

/// Disposable file patterns we are willing to delete from `~/.terse`.
/// Deliberately conservative — never touches state (`stats.json`, `auth.json`,
/// `cowork.json`, ledgers, `doctor.json`).
fn is_junk(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.ends_with('~') {
        return true;
    }
    const JUNK_EXT: &[&str] = &[".log", ".tmp", ".bak", ".old", ".crash", ".dmp"];
    if JUNK_EXT.iter().any(|e| n.ends_with(e)) {
        return true;
    }
    // rotated logs like foo.log.1
    if n.contains(".log.") {
        return true;
    }
    false
}

const JUNK_DIRS: &[&str] = &["logs", "tmp", "cache", "captmp"];

/// Directories we never descend into when hunting for junk — dependency trees
/// and VCS metadata that contain disposable-looking files (`.log`/`.bak`) which
/// are NOT ours to delete. Keeps the tree walk shallow and safe.
const SKIP_DIRS: &[&str] = &["node_modules", ".git", ".svn", "target", "vendor"];

fn collect_junk(dir: &Path, depth: u8, paths: &mut Vec<(String, u64)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            let lower = fname.to_ascii_lowercase();
            if SKIP_DIRS.contains(&lower.as_str()) {
                continue; // never walk dependency/VCS trees
            }
            if JUNK_DIRS.contains(&lower.as_str()) {
                collect_dir_files(&path, paths);
            } else if depth > 0 {
                collect_junk(&path, depth - 1, paths);
            }
        } else if is_junk(&fname) {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            paths.push((path.to_string_lossy().to_string(), size));
        }
    }
}

fn collect_dir_files(dir: &Path, paths: &mut Vec<(String, u64)>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                paths.push((path.to_string_lossy().to_string(), size));
            }
        }
    }
}

fn scan_junk(out: &mut Vec<Finding>) {
    let mut found: Vec<(String, u64)> = Vec::new();
    collect_junk(&terse_dir(), 2, &mut found);
    // Also flag the repo-side .captmp working dir if it lives under ~/.terse via symlink;
    // collect_junk already covers a `captmp` dir under ~/.terse via JUNK_DIRS.
    if found.is_empty() {
        return;
    }
    let total: u64 = found.iter().map(|(_, s)| s).sum();
    let paths: Vec<String> = found.iter().map(|(p, _)| p.clone()).collect();
    let count = paths.len();
    let mb = total as f64 / 1_048_576.0;
    out.push(Finding {
        id: "junk:terse".into(),
        category: "junk".into(),
        category_label: "Junk Files".into(),
        severity: if mb >= 10.0 { "medium" } else { "low" }.into(),
        title: format!("{count} disposable files in ~/.terse ({})", human_size(total)),
        detail: "Old logs, temp, and backup files Terse left behind. Safe to delete — \
                 this never touches your stats, auth, or project files."
            .into(),
        tokens_wasted: 0,
        usd_wasted: 0.0,
        bytes: total,
        latency_note: String::new(),
        fix_kind: "delete".into(),
        fix_label: "Clean".into(),
        fixable: true,
        paths,
    });
}

// ── Agent disk cleanup (清理) ────────────────────────────────────────────────
// Claude Code / Codex leave per-session JSONL transcripts on disk forever-ish
// (Claude Code prunes at 30 days only if the app runs). These grow to GBs.
// We flag transcripts older than STALE_DAYS as deletable and report the live
// store size as an advisory when it is large.

const STALE_DAYS: u64 = 30;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn is_stale(meta: &fs::Metadata, days: u64) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map(|e| e.as_secs() > days * 86_400)
        .unwrap_or(false)
}

/// Walk `root` (bounded depth) collecting stale `.jsonl` transcripts into
/// `stale` and summing still-fresh transcript bytes into `live_bytes`.
fn collect_transcripts(root: &Path, depth: u8, stale: &mut Vec<(String, u64)>, live_bytes: &mut u64) {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                collect_transcripts(&p, depth - 1, stale, live_bytes);
            }
        } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
            if let Ok(meta) = e.metadata() {
                if is_stale(&meta, STALE_DAYS) {
                    stale.push((p.to_string_lossy().into_owned(), meta.len()));
                } else {
                    *live_bytes += meta.len();
                }
            }
        }
    }
}

fn scan_agent_disk(out: &mut Vec<Finding>) {
    let h = home();
    let mut stale: Vec<(String, u64)> = Vec::new();
    let mut live_bytes = 0u64;
    // Claude Code transcripts: ~/.claude/projects/<encoded-project>/<session>.jsonl
    collect_transcripts(&h.join(".claude").join("projects"), 2, &mut stale, &mut live_bytes);
    // Codex CLI transcripts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    collect_transcripts(&h.join(".codex").join("sessions"), 4, &mut stale, &mut live_bytes);

    if !stale.is_empty() {
        let total: u64 = stale.iter().map(|(_, s)| s).sum();
        let count = stale.len();
        out.push(Finding {
            id: "disk:stale-transcripts".into(),
            category: "disk".into(),
            category_label: "Agent Disk".into(),
            severity: if total >= 200 * 1_048_576 { "medium" } else { "low" }.into(),
            title: format!(
                "{count} agent transcripts older than {STALE_DAYS} days ({})",
                human_size(total)
            ),
            detail: "Session logs Claude Code / Codex finished with weeks ago. Usage stats have \
                     already been recorded, and resuming these sessions is no longer practical. \
                     Cleaning frees disk and speeds up tools that scan the transcript store."
                .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: total,
            latency_note: String::new(),
            fix_kind: "delete".into(),
            fix_label: "Clean".into(),
            fixable: true,
            paths: stale.into_iter().map(|(p, _)| p).collect(),
        });
    }

    if live_bytes >= 1_073_741_824 {
        // >1 GB of fresh transcripts — we never auto-delete recent work, but we
        // CAN pin Claude Code's own retention so the store stops regrowing.
        out.push(Finding {
            id: "disk:transcript-store-size".into(),
            category: "disk".into(),
            category_label: "Agent Disk".into(),
            severity: "low".into(),
            title: format!("Active transcript store is {}", human_size(live_bytes)),
            detail: "Recent (kept) agent session logs. Applying this sets Claude Code's \
                     cleanupPeriodDays to 30 in ~/.claude/settings.json (a .terse-bak backup is \
                     written first) so the store prunes itself from now on."
                .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "set-cleanup-days".into(),
            fix_label: "Auto-clean 30d".into(),
            fixable: true,
            paths: vec![],
        });
    }

    // Shell snapshots: per-session environment captures, useless once stale.
    let mut snaps: Vec<(String, u64)> = Vec::new();
    if let Ok(entries) = fs::read_dir(h.join(".claude").join("shell-snapshots")) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Ok(meta) = e.metadata() {
                    if is_stale(&meta, STALE_DAYS) {
                        snaps.push((p.to_string_lossy().into_owned(), meta.len()));
                    }
                }
            }
        }
    }
    if !snaps.is_empty() {
        let total: u64 = snaps.iter().map(|(_, s)| s).sum();
        let count = snaps.len();
        out.push(Finding {
            id: "disk:shell-snapshots".into(),
            category: "disk".into(),
            category_label: "Agent Disk".into(),
            severity: "low".into(),
            title: format!("{count} stale shell snapshots ({})", human_size(total)),
            detail: "Claude Code snapshots your shell environment once per session; snapshots \
                     from sessions older than a month serve no purpose."
                .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: total,
            latency_note: String::new(),
            fix_kind: "delete".into(),
            fix_label: "Clean".into(),
            fixable: true,
            paths: snaps.into_iter().map(|(p, _)| p).collect(),
        });
    }
}

// ── Agent cache & log stores (the deep-clean list) ───────────────────────────
// Grounded in what actually bloats agent machines: Claude Code debug logs and
// statsig telemetry, per-session todos, file-history backups, and editor-agent
// log trees (Cursor / VS Code). All delete-gated by the same staleness rules.

/// Generic stale-file collector. `exts: &[]` means any extension.
fn collect_stale_files(
    root: &Path,
    depth: u8,
    exts: &[&str],
    days: u64,
    out: &mut Vec<(String, u64)>,
) {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                collect_stale_files(&p, depth - 1, exts, days, out);
            }
        } else if p.is_file() {
            let ext_ok = exts.is_empty()
                || p.extension()
                    .map(|x| exts.iter().any(|e2| x == *e2))
                    .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            if let Ok(meta) = e.metadata() {
                if is_stale(&meta, days) {
                    out.push((p.to_string_lossy().into_owned(), meta.len()));
                }
            }
        }
    }
}

/// One deep-clean target = one Finding when it has stale content.
struct CacheTarget {
    id: &'static str,
    title: &'static str,
    detail: &'static str,
    rel: &'static [&'static str], // path segments under $HOME
    depth: u8,
    exts: &'static [&'static str],
    days: u64,
}

const CACHE_TARGETS: &[CacheTarget] = &[
    CacheTarget {
        id: "disk:claude-debug-logs",
        title: "Claude Code debug logs",
        detail: "Verbose per-session debug logs (these alone reach GBs on heavy use). Only logs \
                 older than a week are cleaned.",
        rel: &[".claude", "logs"], depth: 2, exts: &[], days: 7,
    },
    CacheTarget {
        id: "disk:statsig-cache",
        title: "Claude Code telemetry cache (statsig)",
        detail: "Feature-flag evaluation caches. Rebuilt automatically on next launch — stale \
                 copies are pure dead weight.",
        rel: &[".claude", "statsig"], depth: 1, exts: &[], days: 7,
    },
    CacheTarget {
        id: "disk:session-todos",
        title: "Stale session todo lists",
        detail: "Each Claude Code session writes a todo file; ones from sessions older than a \
                 month will never be read again.",
        rel: &[".claude", "todos"], depth: 1, exts: &["json"], days: 30,
    },
    CacheTarget {
        id: "disk:claude-backups",
        title: "Old Claude Code backups",
        detail: "Automatic backups Claude Code keeps outside any project. A month-old backup of \
                 an edit you shipped is just disk weight.",
        rel: &[".claude", "backups"], depth: 2, exts: &[], days: 30,
    },
    CacheTarget {
        id: "disk:file-history",
        title: "Old file-history snapshots",
        detail: "Per-edit file snapshots used for undo across sessions; entries older than a \
                 month are unreachable in practice.",
        rel: &[".claude", "file-history"], depth: 2, exts: &[], days: 30,
    },
    CacheTarget {
        id: "disk:codex-logs",
        title: "Codex CLI logs",
        detail: "Codex rotates nothing by itself — old logs accumulate until deleted.",
        rel: &[".codex", "log"], depth: 1, exts: &[], days: 7,
    },
    CacheTarget {
        id: "disk:cursor-logs",
        title: "Cursor agent logs",
        detail: "Cursor writes one log tree per window per day and never prunes them; these \
                 slow its own startup scans too.",
        rel: &["AppData", "Roaming", "Cursor", "logs"], depth: 3, exts: &[], days: 7,
    },
    CacheTarget {
        id: "disk:vscode-logs",
        title: "VS Code / Copilot logs",
        detail: "Per-session log trees (incl. Copilot agent channels) that VS Code keeps \
                 forever.",
        rel: &["AppData", "Roaming", "Code", "logs"], depth: 3, exts: &[], days: 7,
    },
];

fn target_root(t: &CacheTarget) -> PathBuf {
    let mut p = home();
    for seg in t.rel {
        p = p.join(seg);
    }
    p
}

fn scan_agent_caches(out: &mut Vec<Finding>) {
    for t in CACHE_TARGETS {
        let mut found: Vec<(String, u64)> = Vec::new();
        collect_stale_files(&target_root(t), t.depth, t.exts, t.days, &mut found);
        if found.is_empty() {
            continue;
        }
        let total: u64 = found.iter().map(|(_, s)| s).sum();
        let count = found.len();
        out.push(Finding {
            id: t.id.into(),
            category: "disk".into(),
            category_label: "Agent Disk".into(),
            severity: if total >= 500 * 1_048_576 { "medium" } else { "low" }.into(),
            title: format!("{} — {count} files ({})", t.title, human_size(total)),
            detail: t.detail.into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: total,
            latency_note: String::new(),
            fix_kind: "delete".into(),
            fix_label: "Clean".into(),
            fixable: true,
            paths: found.into_iter().map(|(p, _)| p).collect(),
        });
    }
}

// ── Protection (防护) — credential exposure + permission blast radius ────────

/// (marker, human label). Substring markers keep this dependency-free; every
/// marker is a well-known key prefix, so false positives are rare and the
/// finding is advisory-only anyway (we never print the matched value).
const SECRET_MARKERS: &[(&str, &str)] = &[
    ("sk-ant-", "Anthropic API key"),
    ("sk-proj-", "OpenAI API key"),
    ("ghp_", "GitHub token"),
    ("github_pat_", "GitHub fine-grained token"),
    ("AKIA", "AWS access key"),
    ("xoxb-", "Slack bot token"),
    ("xoxp-", "Slack user token"),
    ("AIzaSy", "Google API key"),
    ("-----BEGIN RSA PRIVATE KEY", "private key"),
    ("-----BEGIN OPENSSH PRIVATE KEY", "private key"),
];

const MAX_SCAN_BYTES: u64 = 8 * 1_048_576;

fn read_capped(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SCAN_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn scan_secret_exposure(out: &mut Vec<Finding>) {
    let h = home();
    // (path, is_instruction_file). Instruction files (CLAUDE.md) are routinely
    // committed / fed verbatim into prompts — a key there is HIGH. Config files
    // holding env-style credentials are expected but worth a sprawl warning.
    let targets: Vec<(PathBuf, bool)> = vec![
        (h.join(".claude").join("CLAUDE.md"), true),
        (h.join("CLAUDE.md"), true),
        (h.join(".claude").join("settings.json"), false),
        (h.join(".claude").join("settings.local.json"), false),
        (h.join(".claude.json"), false),
        (h.join(".mcp.json"), false),
        (h.join(".codex").join("config.toml"), false),
    ];

    let mut instr_hits: Vec<String> = Vec::new(); // "CLAUDE.md — Anthropic API key"
    let mut config_hits: Vec<String> = Vec::new();
    let mut instr_paths: Vec<String> = Vec::new();
    let mut config_paths: Vec<String> = Vec::new();
    for (path, is_instruction) in &targets {
        let Some(text) = read_capped(path) else { continue };
        for (marker, label) in SECRET_MARKERS {
            if text.contains(marker) {
                let name = basename(&path.to_string_lossy());
                let hit = format!("{name} — {label}");
                let (bucket, pbucket) = if *is_instruction {
                    (&mut instr_hits, &mut instr_paths)
                } else {
                    (&mut config_hits, &mut config_paths)
                };
                if !bucket.contains(&hit) {
                    bucket.push(hit);
                }
                let ps = path.to_string_lossy().into_owned();
                if !pbucket.contains(&ps) {
                    pbucket.push(ps);
                }
            }
        }
    }

    if !instr_hits.is_empty() {
        out.push(Finding {
            id: "guard:secret-in-instructions".into(),
            category: "guard".into(),
            category_label: "Protection".into(),
            severity: "high".into(),
            title: format!("Credential in agent instruction file ({})", instr_hits.join(", ")),
            detail: "A key-shaped string sits in a CLAUDE.md that agents read into every prompt \
                     and that is often committed to git. Documented incidents show agents copying \
                     such keys into generated code and public repos. Move it to an environment \
                     variable or keychain, then rotate the key."
                .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "open-path".into(),
            fix_label: "Open file".into(),
            fixable: true,
            paths: instr_paths,
        });
    }
    if !config_hits.is_empty() {
        out.push(Finding {
            id: "guard:credential-sprawl".into(),
            category: "guard".into(),
            category_label: "Protection".into(),
            severity: "medium".into(),
            title: format!(
                "Credentials in {} agent config file{}",
                config_hits.len(),
                if config_hits.len() == 1 { "" } else { "s" }
            ),
            detail: format!(
                "{}. Keys living in agent configs are read by every session and every MCP server \
                 you install. Prefer environment variables or a secrets manager, and never sync \
                 these files to dotfile repos.",
                config_hits.join("; ")
            ),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "open-path".into(),
            fix_label: "Open files".into(),
            fixable: true,
            paths: config_paths,
        });
    }
}

fn scan_permission_risk(out: &mut Vec<Finding>) {
    let h = home();
    let mut risky: Vec<String> = Vec::new();
    let mut bypass = false;
    for name in ["settings.json", "settings.local.json"] {
        let Some(text) = read_capped(&h.join(".claude").join(name)) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if v.get("permissions")
            .and_then(|p| p.get("defaultMode"))
            .and_then(|m| m.as_str())
            .map(|m| m == "bypassPermissions")
            .unwrap_or(false)
        {
            bypass = true;
        }
        if let Some(allow) = v
            .get("permissions")
            .and_then(|p| p.get("allow"))
            .and_then(|a| a.as_array())
        {
            for rule in allow.iter().filter_map(|r| r.as_str()) {
                if is_broad_rule(rule) && !risky.contains(&rule.to_string()) {
                    risky.push(rule.to_string());
                }
            }
        }
    }

    if bypass {
        out.push(Finding {
            id: "guard:bypass-permissions".into(),
            category: "guard".into(),
            category_label: "Protection".into(),
            severity: "high".into(),
            title: "Claude Code runs with permissions bypassed".into(),
            detail: "defaultMode is bypassPermissions — every shell command, file write, and web \
                     fetch runs without asking. One prompt-injected README away from data loss. \
                     Applying this switches defaultMode to acceptEdits (a .terse-bak backup \
                     is written first)."
                .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "fix-bypass".into(),
            fix_label: "Turn off bypass".into(),
            fixable: true,
            paths: vec![],
        });
    }
    if !risky.is_empty() {
        let shown = risky.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
        out.push(Finding {
            id: "guard:broad-allowlist".into(),
            category: "guard".into(),
            category_label: "Protection".into(),
            severity: "medium".into(),
            title: format!("{} broad permission rule{} in the allowlist", risky.len(),
                if risky.len() == 1 { "" } else { "s" }),
            detail: format!(
                "Rules like {shown} auto-approve destructive or network commands for every \
                 session. Applying this removes the broad rules from your allowlist (a \
                 .terse-bak backup is written first) — the agent simply asks again next time."
            ),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "fix-permissions".into(),
            fix_label: "Remove rules".into(),
            fixable: true,
            paths: vec![],
        });
    }
}

// ── Agent runtime (加速) — live process watch for the agents themselves ──────
// `ps` is the whole dependency: we look for agent CLI processes (claude, codex)
// that are pegging a core, forgotten for days, or collectively eating RAM.
// Everything here is advisory — we never kill a process on the user's behalf.

/// Returns (running agent process count, their total RSS in bytes) so the
/// caller can surface a live "N agents active" glance even when nothing is wrong.
fn scan_agent_runtime(out: &mut Vec<Finding>) -> (u32, u64) {
    // Windows equivalent of `ps`: PowerShell CIM emits `pid|name|workingset_bytes|elapsed_days`
    // per agent process. Instantaneous per-process CPU% needs two samples on Windows, so it is
    // omitted — memory-footprint and forgotten-session findings still fire; the runaway-CPU
    // finding stays dormant on Windows.
    let ps_script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='codex.exe'\" | ForEach-Object { $d=0; try { $c=[Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate); $d=[math]::Floor(((Get-Date)-$c).TotalDays) } catch {}; \"$($_.ProcessId)|$($_.Name)|$($_.WorkingSetSize)|$d\" }";
    let output = match crate::hidden_command("powershell")
        .args(["-NoProfile", "-Command", ps_script])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0),
    };
    let text = String::from_utf8_lossy(&output.stdout);

    let mut count = 0u32;
    let mut total_rss_kb = 0u64;
    let hot: Vec<String> = Vec::new(); // CPU% unavailable on Windows → never populated
    let hot_pids: Vec<String> = Vec::new();
    let mut forgotten: Vec<String> = Vec::new(); // "codex (pid 9) running 3 days"
    let mut forgotten_pids: Vec<String> = Vec::new();

    for line in text.lines() {
        let mut it = line.split('|');
        let (Some(pid), Some(name), Some(ws), Some(days)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let raw = basename(name.trim()).to_ascii_lowercase();
        let bin = raw.strip_suffix(".exe").unwrap_or(&raw).to_string();
        count += 1;
        total_rss_kb += ws.trim().parse::<u64>().unwrap_or(0) / 1024;
        if days.trim().parse::<u32>().unwrap_or(0) >= 2 {
            forgotten.push(format!("{bin} (pid {}) running {} days", pid.trim(), days.trim()));
            forgotten_pids.push(pid.trim().to_string());
        }
    }

    if !hot.is_empty() {
        out.push(Finding {
            id: "runtime:runaway-cpu".into(),
            category: "runtime".into(),
            category_label: "Agent Runtime".into(),
            severity: "high".into(),
            title: format!("{} agent process{} pegging the CPU",
                hot.len(), if hot.len() == 1 { "" } else { "es" }),
            detail: format!(
                "{}. A stuck agent loop burns laptop battery AND subscription limits at the same \
                 time. Applying this sends a polite SIGTERM — the transcript stays on disk, so \
                 the session remains resumable.",
                hot.join("; ")
            ),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: "A pegged core also slows every other agent session.".into(),
            fix_kind: "kill-process".into(),
            fix_label: "Stop process".into(),
            fixable: true,
            paths: hot_pids,
        });
    }
    if !forgotten.is_empty() {
        out.push(Finding {
            id: "runtime:forgotten-sessions".into(),
            category: "runtime".into(),
            category_label: "Agent Runtime".into(),
            severity: "medium".into(),
            title: format!("{} agent session{} running for days",
                forgotten.len(), if forgotten.len() == 1 { "" } else { "s" }),
            detail: format!(
                "{}. Long-forgotten sessions hold file locks, keep MCP servers alive, and can \
                 quietly keep consuming your rate limits. Applying this stops them with SIGTERM \
                 — transcripts stay on disk, so any of them can be resumed.",
                forgotten.join("; ")
            ),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "kill-process".into(),
            fix_label: "Stop sessions".into(),
            fixable: true,
            paths: forgotten_pids,
        });
    }
    // >8 GB RSS across agent processes — worth knowing on a laptop.
    if total_rss_kb >= 8 * 1_048_576 {
        out.push(Finding {
            id: "runtime:memory-footprint".into(),
            category: "runtime".into(),
            category_label: "Agent Runtime".into(),
            severity: "low".into(),
            title: format!("{count} agent processes using {}", human_size(total_rss_kb * 1024)),
            detail: "Combined memory of running agent CLIs. Restarting long-lived sessions \
                     releases accumulated context and child MCP processes."
                .into(),
            tokens_wasted: 0,
            usd_wasted: 0.0,
            bytes: 0,
            latency_note: String::new(),
            fix_kind: "open-path".into(),
            fix_label: "Activity Monitor".into(),
            fixable: true,
            paths: vec!["taskmgr.exe".into()],
        });
    }
    (count, total_rss_kb * 1024)
}

// ── Instruction-file context tax ─────────────────────────────────────────────
// A global CLAUDE.md is prepended to EVERY prompt of EVERY session — a large
// one is the single most-paid-for file on the machine.

fn scan_claude_md_tax(out: &mut Vec<Finding>) {
    let path = home().join(".claude").join("CLAUDE.md");
    let Ok(meta) = fs::metadata(&path) else { return };
    let bytes = meta.len();
    let approx_tokens = bytes / 4;
    if approx_tokens < 1_500 {
        return; // small instruction files are healthy
    }
    let severity = if approx_tokens >= 4_000 { "medium" } else { "low" };
    out.push(Finding {
        id: "context:claude-md-tax".into(),
        category: "context".into(),
        category_label: "Context Bloat".into(),
        severity: severity.into(),
        title: format!(
            "Global CLAUDE.md costs ~{} tokens on every prompt",
            thousands(approx_tokens)
        ),
        detail: format!(
            "~/.claude/CLAUDE.md is {} — it is injected into every session you run, all day. \
             Keep only universal rules here; move project specifics into per-project CLAUDE.md \
             and reference docs the agent can read on demand.",
            human_size(bytes)
        ),
        tokens_wasted: approx_tokens,
        usd_wasted: 0.0,
        bytes: 0,
        latency_note: "A leaner prefix also caches faster.".into(),
        fix_kind: "open-path".into(),
        fix_label: "Open file".into(),
        fixable: true,
        paths: vec![path.to_string_lossy().into_owned()],
    });
}

// ── Configured-but-heavy MCP sprawl ──────────────────────────────────────────
// Telemetry-based MCP scans only see servers that actually ran. This one reads
// the configs, so it catches servers you installed once and forgot — every
// session still pays their tool definitions at cache position 0.

fn scan_mcp_config_sprawl(out: &mut Vec<Finding>) {
    let h = home();
    let mut servers: Vec<String> = Vec::new();
    // Global config: ~/.claude.json { "mcpServers": { name: {...} } }
    // This file also stores per-project history and can be tens of MB, so read
    // it directly with a generous guard instead of read_capped.
    if let Ok(meta) = fs::metadata(h.join(".claude.json")) {
        if meta.len() <= 64 * 1_048_576 {
            if let Ok(text) = fs::read_to_string(h.join(".claude.json")) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if let Some(obj) = v.get("mcpServers").and_then(|m| m.as_object()) {
                        servers.extend(obj.keys().cloned());
                    }
                }
            }
        }
    }
    if let Some(text) = read_capped(&h.join(".mcp.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(obj) = v.get("mcpServers").and_then(|m| m.as_object()) {
                for k in obj.keys() {
                    if !servers.contains(k) {
                        servers.push(k.clone());
                    }
                }
            }
        }
    }
    let n = servers.len();
    if n < 6 {
        return;
    }
    // Rough, deliberately conservative: ~8 tools/server × ~500 tokens/definition.
    let approx_tokens = (n as u64) * 8 * 500;
    let shown = servers.iter().take(6).cloned().collect::<Vec<_>>().join(", ");
    out.push(Finding {
        id: "mcp:config-sprawl".into(),
        category: "mcp".into(),
        category_label: "Tool / MCP Bloat".into(),
        severity: if n >= 10 { "medium" } else { "low" }.into(),
        title: format!("{n} MCP servers configured globally"),
        detail: format!(
            "{shown}{} — every session loads all of their tool definitions (~{} tokens) before \
             you type a word, whether you use them or not. Move project-specific servers into \
             that project's .mcp.json and remove the ones you no longer use.",
            if n > 6 { ", …" } else { "" },
            thousands(approx_tokens)
        ),
        tokens_wasted: approx_tokens,
        usd_wasted: 0.0,
        bytes: 0,
        latency_note: "Fewer tool definitions = shorter prefix = faster first token.".into(),
        fix_kind: "open-path".into(),
        fix_label: "Open config".into(),
        fixable: true,
        paths: vec![h.join(".claude.json").to_string_lossy().into_owned()],
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Run a full read-only scan with live connected sessions and a period hint.
/// `attr` is `StatsStore::get_attribution`, `summary` is the summary object,
/// `sessions` is `AgentMonitor::get_connected_sessions()`.
pub fn scan_full(attr: &Value, summary: &Value, sessions: &[Value], period: &str) -> Value {
    let settings = load_settings();
    let mut findings: Vec<Finding> = Vec::new();

    // Cache health
    scan_cache_low_hit(attr, &mut findings);
    scan_cache_write_thrash(summary, attr, &mut findings);
    scan_cache_never_engaged(summary, attr, &mut findings);
    scan_cache_idle_ttl(summary, attr, &mut findings);
    scan_cache_session_pinned(sessions, &mut findings);

    // MCP / tool bloat
    scan_mcp_server_count(attr, &mut findings);
    scan_mcp_dead_server(attr, summary, period, &mut findings);
    scan_mcp_bloated_server(attr, &mut findings);
    scan_mcp_unused_tools(sessions, &mut findings);

    // Agent loops (live)
    scan_loop_duplicate_calls(sessions, &settings, &mut findings);
    scan_loop_redundant_reads(sessions, &settings, &mut findings);
    scan_loop_uncompressed_results(sessions, &settings, &mut findings);

    // Context bloat (live)
    scan_context_near_limit(sessions, &mut findings);
    scan_context_burn_rate(sessions, &mut findings);

    // Prompt waste
    scan_prompt_unoptimized(summary, attr, &mut findings);
    scan_prompt_low_savings(summary, attr, &mut findings);

    // Cost / routing
    scan_cost_frontier(attr, &mut findings);
    scan_cost_output_heavy(attr, &mut findings);

    // Junk
    scan_junk(&mut findings);

    // Agent disk cleanup (清理)
    scan_agent_disk(&mut findings);
    scan_agent_caches(&mut findings);

    // Protection (防护)
    scan_secret_exposure(&mut findings);
    scan_permission_risk(&mut findings);

    // Agent runtime (加速) + config-level context taxes
    let (agents_running, agents_rss_bytes) = scan_agent_runtime(&mut findings);
    scan_claude_md_tax(&mut findings);
    scan_mcp_config_sprawl(&mut findings);

    // Best-practice (static, always-on) — emitted after real findings so we can suppress.
    let has_cache_finding = findings.iter().any(|f| f.category == "cache");
    let has_output_finding = findings.iter().any(|f| f.id.starts_with("cost:output-heavy"));
    push_config_cache_safe(&settings, &mut findings);
    push_config_stable_tool_order(attr, sessions, &mut findings);
    push_config_prewarm(has_cache_finding, &mut findings);
    push_config_cap_output(has_output_finding, &mut findings);

    // ── Every finding gets a real one-click action ──
    // Anything still advisory at this point is mapped to a concrete remediation
    // (a Terse toggle, a config edit, or a permission grant). Advice-only cards
    // were the main complaint: the user could read what was wrong but had to go
    // fix it by hand. See promote_all_fixable for the id → action map.
    promote_all_fixable(&mut findings);

    // Drop anything the user explicitly dismissed.
    findings.retain(|f| !settings.dismissed.contains(&f.id));
    // Respect already-on toggles: drop the optimize tips whose action is already taken.
    if settings.cache_safe_mode {
        findings.retain(|f| f.id != "prompt:unoptimized" && f.id != "prompt:low-savings-rate" && f.id != "config:cache-safe-mode");
    }
    if settings.response_cache {
        findings.retain(|f| !f.id.starts_with("loop:duplicate-tool-calls") && !f.id.starts_with("loop:redundant-reads"));
    }
    if settings.compression {
        findings.retain(|f| !f.id.starts_with("loop:uncompressed-tool-results"));
    }

    let score = compute_score(&findings);
    let grade = grade_for(score);

    let total_usd: f64 = findings.iter().map(|f| f.usd_wasted).sum();
    let total_tokens: u64 = findings.iter().map(|f| f.tokens_wasted).sum();
    let total_bytes: u64 = findings.iter().map(|f| f.bytes).sum();
    let high = findings.iter().filter(|f| f.severity == "high").count();

    json!({
        "score": score,
        "grade": grade,
        "findings": findings,
        "summary": {
            "issues": findings.len(),
            "high": high,
            "recoverableUsd": round2(total_usd),
            "recoverableTokens": total_tokens,
            "junkBytes": total_bytes,
            "agentsRunning": agents_running,
            "agentsRssBytes": agents_rss_bytes,
        },
        "settings": settings,
        "scannedAt": chrono::Local::now().to_rfc3339(),
    })
}

/// Back-compat entry point: scan without live sessions (defaults period = month).
#[allow(dead_code)]
pub fn scan(attr: &Value, summary: &Value) -> Value {
    scan_full(attr, summary, &[], "month")
}

/// Honest, anti-scareware scoring. See module docs for the full rationale.
fn compute_score(findings: &[Finding]) -> u32 {
    use std::collections::HashMap;
    let weight = |sev: &str| match sev {
        "high" => 12i32,
        "medium" => 6,
        _ => 2,
    };

    // Per-category deduction, capped at -24 each so one noisy category can't crater the score.
    let mut per_cat: HashMap<&str, i32> = HashMap::new();
    // Config/best-practice advisories share a single -6 combined cap.
    let mut config_total = 0i32;
    let mut has_real_high = false;

    for fnd in findings {
        let w = weight(&fnd.severity);
        let is_static = fnd.category == "config";
        if is_static {
            config_total += w;
        } else {
            *per_cat.entry(fnd.category.as_str()).or_insert(0) += w;
            if fnd.severity == "high" {
                has_real_high = true;
            }
        }
    }

    let mut deduction = 0i32;
    for (_, d) in per_cat.iter() {
        deduction += (*d).min(24);
    }
    deduction += config_total.min(6);

    let mut score = 100 - deduction;

    // Require a real HIGH finding before allowing the score below 70.
    if !has_real_high && score < 70 {
        score = 70;
    }

    // Clamp to [35, 98]: never scareware-0, never fake-perfect-100.
    score.clamp(35, 98) as u32
}

fn grade_for(score: u32) -> &'static str {
    if score >= 90 {
        "Excellent"
    } else if score >= 75 {
        "Good"
    } else if score >= 60 {
        "Fair"
    } else {
        "Needs work"
    }
}

/// Apply one finding's remediation. Returns a small result object for the UI.
// ── Fix vocabulary (ported verbatim from the macOS app) ─────────────────────
// promote_all_fixable + fix_steps_for and the kinds they emit ('tune',
// 'mcp-disable', 'claude-md-trim', 'grant-permission') are shared with macOS
// on purpose: doctor.js keys its labels and step lists off these exact
// strings, so any divergence shows up as a card that behaves differently on
// one platform.
fn promote_all_fixable(findings: &mut [Finding]) {
    for f in findings.iter_mut() {
        if f.fixable {
            continue;
        }
        let id = f.id.as_str();
        let (kind, label): (&str, &str) = if id.starts_with("cache:idle-ttl-churn") {
            ("tune", "Keep cache warm")
        } else if id.starts_with("cache:low-hit-rate") {
            ("tune", "Stabilise prefix")
        } else if id.starts_with("cache:") {
            ("tune", "Enable cache-safe mode")
        } else if id.starts_with("mcp:claude-md-bloat") || id.starts_with("context:claude-md-tax") {
            ("claude-md-trim", "Trim CLAUDE.md")
        } else if id.starts_with("mcp:unused-default-tools") {
            // This id is suffixed with a SESSION id, not a server name, so there
            // is nothing for mcp-disable to act on — which tools a session left
            // untouched is a judgement call. Take the user straight to the config.
            if f.paths.is_empty() {
                f.paths = vec![dirs::home_dir()
                    .unwrap_or_default()
                    .join(".claude.json")
                    .to_string_lossy()
                    .into_owned()];
            }
            ("open-path", "Open config")
        } else if id.starts_with("mcp:") {
            ("mcp-disable", "Disable unused servers")
        } else if id.starts_with("context:near-window-limit") {
            ("tune", "Auto-compact")
        } else if id.starts_with("context:high-burn-rate") {
            ("tune", "Compress results")
        } else if id.starts_with("cost:frontier-overuse") {
            ("tune", "Route cheap turns")
        } else if id.starts_with("cost:output-heavy") || id.starts_with("config:cap-output") {
            ("tune", "Cap output")
        } else if id.starts_with("config:stable-tool-order") {
            ("tune", "Freeze tool order")
        } else if id.starts_with("config:prewarm-cache") {
            ("tune", "Prewarm cache")
        } else {
            // Anything unrecognised stays advisory rather than getting a button
            // that does nothing — a fix that silently no-ops is worse than advice.
            continue;
        };
        f.fix_kind = kind.into();
        f.fix_label = label.into();
        f.fixable = true;
    }
}

/// Named steps for a fix, so the card can draw a real progress bar instead of a
/// spinner. Kept in the backend so the labels match what actually happens.
pub fn fix_steps_for(kind: &str, id: &str) -> Vec<&'static str> {
    match kind {
        "delete" => vec!["Re-checking files", "Moving to Trash", "Recounting space"],
        "kill-process" => vec!["Verifying processes", "Sending stop signal", "Confirming exit"],
        "mcp-disable" => vec![
            "Reading MCP config",
            "Backing up config",
            "Stashing idle servers",
            "Verifying config",
        ],
        "claude-md-trim" => vec![
            "Reading CLAUDE.md",
            "Backing up original",
            "Drafting trimmed copy",
            "Opening for review",
        ],
        "grant-permission" => vec!["Checking permission", "Opening System Settings"],
        "tune" => {
            if id.starts_with("cache:") {
                vec!["Reading settings", "Enabling cache tuning", "Saving"]
            } else {
                vec!["Reading settings", "Applying tuning", "Saving"]
            }
        }
        _ => vec!["Applying", "Saving"],
    }
}


/// Push one step of a running fix to the Doctor UI, which draws it as a per-card
/// progress bar. `i` is 1-based; `i == total` means the card is done.
///
/// Steps are emitted around the slow parts (disk walks, process kills, elevation
/// prompts) so a fix that takes a few seconds shows movement instead of a frozen
/// "Working…" button.
fn step(app: &AppHandle, id: &str, i: u32, total: u32, label: &str) {
    let _ = app.emit(
        "doctor-fix-progress",
        json!({
            "id": id,
            "step": i,
            "total": total,
            "pct": ((i as f64 / total.max(1) as f64) * 100.0).round() as u32,
            "label": label,
        }),
    );
}

/// Re-run one operation elevated, which pops the UAC consent dialog.
///
/// `ShellExecuteW` with the `runas` verb is the documented way to request
/// elevation for a single child process without manifesting the whole app as
/// `requireAdministrator` (which would prompt on every launch). We only reach
/// for it after the unelevated attempt has already failed with access-denied,
/// so the user is never asked for admin rights we don't actually need.
///
/// Returns false if the user cancels the UAC dialog — a decline, not an error.
#[cfg(target_os = "windows")]
fn run_elevated(exe: &str, params: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }
    let verb = wide("runas");
    let file = wide(exe);
    let args = wide(params);
    // ShellExecuteW returns an HINSTANCE; > 32 means success. <= 32 is an error
    // code, and SE_ERR_ACCESSDENIED (5) is specifically "user said no to UAC".
    let r = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(args.as_ptr()),
            PCWSTR::null(),
            SW_HIDE,
        )
    };
    r.0 as usize > 32
}

#[cfg(not(target_os = "windows"))]
fn run_elevated(_exe: &str, _params: &str) -> bool {
    false
}

pub fn apply_fix(app: &AppHandle, finding: &Value) -> Value {
    let id = finding.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let kind = finding
        .get("fixKind")
        .or_else(|| finding.get("fix_kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match kind {
        "delete" => {
            let paths: Vec<String> = finding
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
                .unwrap_or_default();
            step(app, id, 1, 3, "Checking files…");
            let (bytes, count) = delete_paths(&paths);
            // Anything still on disk was refused — almost always ACL'd or held by
            // another user's process. Offer to retry those (and only those)
            // elevated; UAC asks once, and a decline just leaves them alone.
            let leftover: Vec<&String> = paths.iter().filter(|p| Path::new(p).exists()).collect();
            let mut elevated_note = String::new();
            if !leftover.is_empty() {
                step(app, id, 2, 3, "Needs permission — confirm the prompt…");
                let list = leftover
                    .iter()
                    .map(|p| format!("'{}'", p.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(",");
                let ps = format!(
                    "-NoProfile -NonInteractive -Command \"Remove-Item -LiteralPath {list} -Force -Recurse -ErrorAction SilentlyContinue\""
                );
                if run_elevated("powershell.exe", &ps) {
                    // ShellExecuteW does not wait; give the elevated child a moment
                    // to finish before we count what survived.
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    let still = leftover.iter().filter(|p| Path::new(p).exists()).count();
                    let cleared = leftover.len() - still;
                    if cleared > 0 {
                        elevated_note = format!(" ({cleared} needed admin)");
                    }
                } else {
                    elevated_note = format!(" ({} skipped — permission declined)", leftover.len());
                }
            }
            step(app, id, 3, 3, "Done");
            json!({ "ok": true, "kind": "delete", "freedBytes": bytes, "deleted": count,
                    "message": format!("Cleaned {count} files, freed {}{elevated_note}", human_size(bytes)) })
        }
        "optimize" => {
            let mut st = load_settings();
            let msg = if id.starts_with("loop:duplicate-tool-calls") || id.starts_with("loop:redundant-reads") {
                st.response_cache = true;
                "Result cache enabled — exact repeats will be served locally."
            } else if id.starts_with("loop:uncompressed-tool-results") {
                st.compression = true;
                "Tool-result compression enabled."
            } else if id == "prompt:unoptimized" {
                st.cache_safe_mode = true;
                st.response_cache = true;
                "Cache-safe optimization enabled."
            } else {
                // prompt:low-savings-rate, config:cache-safe-mode, and any other optimize finding.
                st.cache_safe_mode = true;
                "Cache-safe optimization enabled."
            };
            save_settings(&st);
            json!({ "ok": true, "kind": "optimize", "message": msg })
        }
        "open-path" => {
            let paths: Vec<String> = finding
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut opened = 0u32;
            for p in paths.iter().take(4) {
                // "taskmgr.exe" is a launcher token (not a path); everything else must exist.
                let is_launcher = p == "taskmgr.exe";
                if (is_launcher || Path::new(p).exists())
                    && crate::hidden_command("cmd")
                        .args(["/C", "start", "", p])
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false)
                {
                    opened += 1;
                }
            }
            if opened > 0 {
                json!({ "ok": true, "kind": "open",
                        "message": "Opened — review and edit, then re-scan." })
            } else {
                json!({ "ok": false, "message": "Could not open the file — it may have moved." })
            }
        }
        "kill-process" => {
            let pids: Vec<String> = finding
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
                .unwrap_or_default();
            step(app, id, 1, 2, "Stopping agent processes…");
            let stopped = stop_agent_processes(&pids);
            // Anything that survived is running as another user or is protected —
            // retry just those elevated so the UAC prompt appears once.
            if stopped == 0 && !pids.is_empty() {
                step(app, id, 1, 2, "Needs permission — confirm the prompt…");
                let args = pids
                    .iter()
                    .filter(|p| p.trim().parse::<u32>().is_ok())
                    .map(|p| format!("/PID {p}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                if !args.is_empty() {
                    let _ = run_elevated("taskkill.exe", &format!("{args} /T /F"));
                    std::thread::sleep(std::time::Duration::from_millis(900));
                }
            }
            step(app, id, 2, 2, "Done");
            if stopped > 0 {
                json!({ "ok": true, "kind": "kill",
                        "message": format!(
                            "Stopped {stopped} process{} — transcripts kept, sessions resumable.",
                            if stopped == 1 { "" } else { "es" }) })
            } else {
                json!({ "ok": false,
                        "message": "Nothing stopped — the processes already exited." })
            }
        }
        "fix-bypass" => match fix_bypass_permissions() {
            Ok(n) if n > 0 => json!({ "ok": true, "kind": "config",
                "message": "defaultMode switched to acceptEdits (backup: settings.json.terse-bak)." }),
            Ok(_) => json!({ "ok": true, "kind": "config",
                "message": "Bypass mode was already off." }),
            Err(e) => json!({ "ok": false, "message": format!("Could not edit settings: {e}") }),
        },
        "fix-permissions" => match fix_broad_allowlist() {
            Ok(n) if n > 0 => json!({ "ok": true, "kind": "config",
                "message": format!(
                    "Removed {n} broad rule{} (backup: settings.json.terse-bak).",
                    if n == 1 { "" } else { "s" }) }),
            Ok(_) => json!({ "ok": true, "kind": "config",
                "message": "No broad rules left — already clean." }),
            Err(e) => json!({ "ok": false, "message": format!("Could not edit settings: {e}") }),
        },
        "set-cleanup-days" => match set_cleanup_days(30) {
            Ok(()) => json!({ "ok": true, "kind": "config",
                "message": "cleanupPeriodDays set to 30 — Claude Code now prunes old transcripts itself." }),
            Err(e) => json!({ "ok": false, "message": format!("Could not edit settings: {e}") }),
        },
        "tune" => {
            let mut st = load_settings();
            let msg = if id.starts_with("cache:idle-ttl-churn") || id.starts_with("config:prewarm-cache") {
                st.prewarm_cache = true;
                "Cache prewarm on — the prefix is kept alive past its TTL."
            } else if id.starts_with("cache:low-hit-rate") || id.starts_with("config:stable-tool-order") {
                st.stable_tool_order = true;
                st.cache_safe_mode = true;
                "Tool order frozen — the cached prefix stays byte-identical."
            } else if id.starts_with("cache:") {
                st.cache_safe_mode = true;
                "Cache-safe mode on — only the newest turn is rewritten."
            } else if id.starts_with("context:near-window-limit") {
                st.auto_compact = true;
                "Auto-compact on — sessions compact before they hit the wall."
            } else if id.starts_with("context:high-burn-rate") {
                st.compression = true;
                "Tool-result compression on — verbose results are trimmed."
            } else if id.starts_with("cost:frontier-overuse") {
                st.route_cheap_models = true;
                "Cheap-turn routing on — mechanical turns leave the frontier model."
            } else if id.starts_with("cost:output-heavy") || id.starts_with("config:cap-output") {
                st.cap_output = true;
                "Output cap on — long answers are bounded."
            } else {
                st.cache_safe_mode = true;
                "Cache-safe optimization enabled."
            };
            save_settings(&st);
            json!({ "ok": true, "kind": "tune", "message": msg,
                    "steps": fix_steps_for("tune", id) })
        }
        "mcp-disable" => match disable_mcp_servers(finding) {
            Ok((0, _)) => json!({ "ok": false,
                "message": "Could not tell which server to disable — open the config and pick one." }),
            Ok((n, backup)) => json!({ "ok": true, "kind": "config",
                "message": format!(
                    "Disabled {n} MCP server{} — restart your agent to reclaim the context (backup: {backup}).",
                    if n == 1 { "" } else { "s" }),
                "steps": fix_steps_for("mcp-disable", id) }),
            Err(e) => json!({ "ok": false, "message": format!("Could not edit MCP config: {e}") }),
        },
        "claude-md-trim" => match trim_claude_md() {
            Ok(Some((saved, path))) => json!({ "ok": true, "kind": "config",
                "message": format!(
                    "Trimmed draft written ({saved} smaller) — review it, then replace CLAUDE.md. Original backed up."),
                "openedPath": path,
                "steps": fix_steps_for("claude-md-trim", id) }),
            Ok(None) => json!({ "ok": true, "kind": "config",
                "message": "CLAUDE.md is already lean — nothing worth trimming." }),
            Err(e) => json!({ "ok": false, "message": format!("Could not trim CLAUDE.md: {e}") }),
        },
        // macOS never lets an app grant itself a TCC permission — the most a fix
        // can do is take the user straight to the right pane. Opening the exact
        // deep link is still one click instead of a paragraph of instructions.
        "grant-permission" => {
            // The scanner carries the pane in paths[0]; `permission` is accepted
            // too so a caller can drive this directly.
            let pane = finding
                .get("permission")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    finding
                        .get("paths")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|v| v.as_str())
                })
                .unwrap_or("Privacy_AllFiles");
            let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
            let opened = std::process::Command::new("open")
                .arg(&url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if opened {
                json!({ "ok": true, "kind": "permission",
                        "message": "System Settings opened — enable Terse, then re-scan.",
                        "steps": fix_steps_for("grant-permission", id) })
            } else {
                json!({ "ok": false, "message": "Could not open System Settings." })
            }
        }
        _ => json!({ "ok": true, "kind": "advise",
                     "message": "Noted — see the guidance for how to resolve this." }),
    }
}



// ── Remediation helpers for the direct-fix kinds ─────────────────────────────

/// SIGTERM the given pids, but only after re-verifying each one still is an
/// agent CLI binary — a stale finding (or forged payload) can never kill an
/// arbitrary process.
fn stop_agent_processes(pids: &[String]) -> u32 {
    const AGENT_BINS: &[&str] = &["claude", "codex"];
    let mut stopped = 0u32;
    for pid_s in pids {
        let Ok(pid) = pid_s.trim().parse::<u32>() else { continue };
        // Re-verify the pid still belongs to an agent CLI before killing it.
        let name = crate::hidden_command("powershell")
            .args(["-NoProfile", "-Command",
                   &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).ProcessName")])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_ascii_lowercase())
            .unwrap_or_default();
        let bin = name.strip_suffix(".exe").unwrap_or(&name).to_string();
        if !AGENT_BINS.contains(&bin.as_str()) {
            continue;
        }
        if crate::hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            stopped += 1;
        }
    }
    stopped
}

/// Read a Claude Code settings JSON, hand it to `mutate`, and — only if the
/// mutator reports a change — write a `.terse-bak` backup then the new content.
fn edit_settings_json(
    path: &Path,
    mutate: impl Fn(&mut Value) -> u32,
) -> Result<u32, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Ok(0), // absent file = nothing to fix here
    };
    let mut v: Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON ({e})", basename(&path.to_string_lossy())))?;
    let changed = mutate(&mut v);
    if changed == 0 {
        return Ok(0);
    }
    let backup = path.with_extension("json.terse-bak");
    fs::write(&backup, &text).map_err(|e| format!("backup failed: {e}"))?;
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    fs::write(path, pretty).map_err(|e| format!("write failed: {e}"))?;
    Ok(changed)
}

fn fix_bypass_permissions() -> Result<u32, String> {
    let h = home();
    let mut total = 0u32;
    for name in ["settings.json", "settings.local.json"] {
        total += edit_settings_json(&h.join(".claude").join(name), |v| {
            let Some(mode) = v
                .get_mut("permissions")
                .and_then(|p| p.get_mut("defaultMode"))
            else {
                return 0;
            };
            if mode.as_str() == Some("bypassPermissions") {
                *mode = Value::String("acceptEdits".into());
                1
            } else {
                0
            }
        })?;
    }
    Ok(total)
}

fn is_broad_rule(rule: &str) -> bool {
    rule == "*"
        || rule == "Bash"
        || rule.starts_with("Bash(*")
        || rule.starts_with("Bash(rm")
        || rule.starts_with("Bash(sudo")
        || rule.starts_with("Bash(curl")
        || rule.starts_with("Bash(wget")
}

fn fix_broad_allowlist() -> Result<u32, String> {
    let h = home();
    let mut total = 0u32;
    for name in ["settings.json", "settings.local.json"] {
        total += edit_settings_json(&h.join(".claude").join(name), |v| {
            let Some(allow) = v
                .get_mut("permissions")
                .and_then(|p| p.get_mut("allow"))
                .and_then(|a| a.as_array_mut())
            else {
                return 0;
            };
            let before = allow.len();
            allow.retain(|r| r.as_str().map(|s| !is_broad_rule(s)).unwrap_or(true));
            (before - allow.len()) as u32
        })?;
    }
    Ok(total)
}

fn set_cleanup_days(days: u64) -> Result<(), String> {
    let path = home().join(".claude").join("settings.json");
    if !path.exists() {
        // No settings yet — create a minimal one (nothing to back up).
        let v = json!({ "cleanupPeriodDays": days });
        return fs::write(&path, serde_json::to_string_pretty(&v).unwrap())
            .map_err(|e| format!("write failed: {e}"));
    }
    edit_settings_json(&path, |v| {
        if let Some(obj) = v.as_object_mut() {
            let already = obj
                .get("cleanupPeriodDays")
                .and_then(|d| d.as_u64())
                .map(|d| d <= days)
                .unwrap_or(false);
            if already {
                return 0;
            }
            obj.insert("cleanupPeriodDays".into(), json!(days));
            1
        } else {
            0
        }
    })
    .map(|_| ())
}

/// Cleanup page: just the delete-able disk findings (Terse junk + stale agent
/// transcripts + shell snapshots), grouped for the 清理 UI. Read-only.
pub fn cleanup_scan() -> Value {
    let mut findings: Vec<Finding> = Vec::new();
    scan_junk(&mut findings);
    scan_agent_disk(&mut findings);
    scan_agent_caches(&mut findings);
    findings.retain(|f| f.fix_kind == "delete");
    let total_bytes: u64 = findings.iter().map(|f| f.bytes).sum();
    let total_files: usize = findings.iter().map(|f| f.paths.len()).sum();
    json!({
        "groups": findings,
        "totalBytes": total_bytes,
        "totalFiles": total_files,
        "scannedAt": chrono::Local::now().to_rfc3339(),
    })
}

/// Cleanup page: delete the selected paths (same defensive re-checks as
/// `apply_fix` — unknown roots, fresh files, and state files are refused).
pub fn cleanup_clean(paths: &[String]) -> Value {
    let (bytes, count) = delete_paths(paths);
    json!({ "ok": true, "freedBytes": bytes, "deleted": count,
            "message": format!("Cleaned {count} files, freed {}", human_size(bytes)) })
}

/// Speed Mode (加速) — one switch for the three speed levers Terse controls:
/// cache-safe trimming (protects the model's prompt cache → fast TTFT),
/// local response cache (exact repeats never hit the model again), and
/// tool-result compression (smaller context → faster decode).
pub fn speed_mode_status() -> Value {
    let s = load_settings();
    json!({
        "enabled": s.cache_safe_mode && s.response_cache && s.compression,
        "cacheSafeMode": s.cache_safe_mode,
        "responseCache": s.response_cache,
        "compression": s.compression,
    })
}

pub fn set_speed_mode(enabled: bool) -> Value {
    let mut s = load_settings();
    s.cache_safe_mode = enabled;
    s.response_cache = enabled;
    s.compression = enabled;
    save_settings(&s);
    json!({ "ok": true, "enabled": enabled })
}

/// Mark a finding as dismissed so future scans stop surfacing it.
pub fn dismiss(id: &str) -> Value {
    let mut s = load_settings();
    if !s.dismissed.contains(&id.to_string()) {
        s.dismissed.push(id.to_string());
    }
    save_settings(&s);
    json!({ "ok": true })
}

/// Delete the given files. Only ever called with paths produced by our own
/// scanners, but defensively re-checked here: `~/.terse` junk follows the
/// original name rules, and agent-store paths must live under a known
/// transcript root, carry a transcript extension, AND still be stale — so a
/// forged or outdated finding can never touch fresh work or anything else.
fn delete_paths(paths: &[String]) -> (u64, u64) {
    let base = terse_dir();
    let h = home();
    // (root, allowed extensions — empty = any, min stale days re-checked now).
    // The re-check days are slightly below the scan threshold so a finding a few
    // minutes old still applies, but fresh files can never be deleted.
    let mut rules: Vec<(PathBuf, &[&str], u64)> = vec![
        (h.join(".claude").join("projects"), &["jsonl"][..], STALE_DAYS - 5),
        (h.join(".claude").join("shell-snapshots"), &["sh"][..], STALE_DAYS - 5),
        (h.join(".codex").join("sessions"), &["jsonl"][..], STALE_DAYS - 5),
    ];
    for t in CACHE_TARGETS {
        rules.push((target_root(t), t.exts, t.days.saturating_sub(2).max(3)));
    }
    let mut bytes = 0u64;
    let mut count = 0u64;
    for p in paths {
        let path = Path::new(p);
        let allowed = if path.starts_with(&base) {
            let fname = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            // Belt-and-suspenders: never delete core state files.
            const PROTECTED: &[&str] = &[
                "stats.json", "auth.json", "cowork.json", "doctor.json",
                "license.json", "farm.json", "pets.json", "settings.json",
                "package.json", "package-lock.json",
            ];
            !(PROTECTED.contains(&fname.as_str()) || fname.contains("ledger") || fname.ends_with(".json"))
        } else if let Some((_, exts, days)) = rules.iter().find(|(r, _, _)| path.starts_with(r)) {
            let ext_ok = exts.is_empty()
                || path
                    .extension()
                    .map(|x| exts.iter().any(|e| x == *e))
                    .unwrap_or(false);
            let still_stale = fs::metadata(path)
                .map(|m| is_stale(&m, *days))
                .unwrap_or(false);
            ext_ok && still_stale
        } else {
            false
        };
        if !allowed {
            continue;
        }
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if move_to_trash(path) {
            bytes += size;
            count += 1;
        }
    }
    (bytes, count)
}

/// Send one file to the Recycle Bin — the Windows counterpart of macOS's
/// `~/.Trash` move.
///
/// This matters beyond tidiness: the shared confirm dialog promises "Files move
/// to your Trash, so you can restore them if needed." Windows used to
/// `fs::remove_file` here, which made that promise false — a cleanup was
/// unrecoverable. `SHFileOperationW` with `FOF_ALLOWUNDO` is the documented way
/// to recycle rather than erase.
///
/// Falls back to a hard delete only when recycling is impossible (a path on a
/// volume with no Recycle Bin, e.g. a network share), preserving the old
/// reclaim behaviour rather than silently skipping the file.
fn move_to_trash(path: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::UI::Shell::{
            SHFileOperationW, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
            SHFILEOPSTRUCTW,
        };
        // pFrom is a double-NUL-terminated list, so one extra NUL after the path.
        let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
        from.push(0);
        from.push(0);
        // FOF_ALLOWUNDO is what makes this the Recycle Bin instead of a delete.
        const FOF_ALLOWUNDO: u16 = 0x0040;
        let mut op = SHFILEOPSTRUCTW {
            wFunc: FO_DELETE as u32,
            pFrom: windows::core::PCWSTR(from.as_ptr()),
            fFlags: FOF_ALLOWUNDO
                | FOF_NOCONFIRMATION.0 as u16
                | FOF_SILENT.0 as u16
                | FOF_NOERRORUI.0 as u16,
            ..Default::default()
        };
        let rc = unsafe { SHFileOperationW(&mut op) };
        if rc == 0 && !op.fAnyOperationsAborted.as_bool() {
            return true;
        }
    }
    fs::remove_file(path).is_ok()
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// The model carrying the most cost this period, for dollarizing account-level
/// findings. Falls back to a mid Claude tier.
fn dominant_model(attr: &Value) -> String {
    attr.get("byModel")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first()) // byModel is sorted by cost desc
        .and_then(|m| m.get("name"))
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty() && *n != "unknown")
        .unwrap_or("claude-sonnet")
        .to_string()
}

fn session_model(sess: &Value) -> String {
    sess.get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or("claude-sonnet")
        .to_string()
}

fn session_agent(sess: &Value) -> String {
    sess.get("agentName")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or("the agent")
        .to_string()
}

fn session_id(sess: &Value) -> String {
    sess.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| session_agent(sess))
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b >= KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Format with thousands separators, e.g. 120000 → "120,000".
fn thousands(n: u64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::new();
    let len = bytes.len();
    for (i, c) in bytes.iter().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*c as char);
    }
    out
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("the file")
        .to_string()
}

fn short_model(m: &str) -> String {
    m.strip_prefix("claude-")
        .unwrap_or(m)
        .trim_end_matches(|c: char| c.is_ascii_digit())
        .trim_end_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end proof the 清理 button really deletes: the bash harness plants
    /// `terse-test-fixture` files with backdated mtimes in the real target dirs;
    /// this test scans, finds them, deletes them, and verifies they are gone.
    #[test]
    fn cleanup_deletes_stale_fixtures() {
        let marker = "terse-test-fixture";
        let report = cleanup_scan();
        let groups = report
            .get("groups")
            .and_then(|g| g.as_array())
            .cloned()
            .unwrap_or_default();
        let mut fixture_paths: Vec<String> = Vec::new();
        for g in &groups {
            if let Some(paths) = g.get("paths").and_then(|p| p.as_array()) {
                for p in paths {
                    if let Some(s) = p.as_str() {
                        if s.contains(marker) {
                            fixture_paths.push(s.to_string());
                        }
                    }
                }
            }
        }
        assert!(
            !fixture_paths.is_empty(),
            "cleanup_scan found no fixtures — harness did not plant them or scanners missed them"
        );
        eprintln!("scan found {} fixtures: {:?}", fixture_paths.len(), fixture_paths);

        let res = cleanup_clean(&fixture_paths);
        let deleted = res.get("deleted").and_then(|d| d.as_u64()).unwrap_or(0);
        assert_eq!(
            deleted as usize,
            fixture_paths.len(),
            "not every fixture was deleted: {res}"
        );
        for p in &fixture_paths {
            assert!(!Path::new(p).exists(), "file still on disk after clean: {p}");
        }
    }

    /// The guard must refuse fresh files even when handed their paths directly —
    /// a stale finding (or a forged one) can never delete recent work.
    #[test]
    fn cleanup_refuses_fresh_files() {
        let dir = home().join(".claude").join("todos");
        let _ = fs::create_dir_all(&dir);
        let fresh = dir.join("terse-test-fresh.json");
        fs::write(&fresh, "{}").expect("write fresh fixture");

        let res = cleanup_clean(&[fresh.to_string_lossy().into_owned()]);
        let deleted = res.get("deleted").and_then(|d| d.as_u64()).unwrap_or(99);
        let survived = fresh.exists();
        let _ = fs::remove_file(&fresh);
        assert_eq!(deleted, 0, "guard deleted a fresh file!");
        assert!(survived, "fresh file missing after refused clean");
    }
}

// ── MCP / CLAUDE.md remediation (ported from macOS) ─────────────────────────
fn disable_mcp_servers(finding: &Value) -> Result<(u32, String), String> {
    // Names come from the finding's `paths` when the scanner listed them, else
    // from the id suffix (`mcp:single-bloated-server:<name>`).
    let mut names: Vec<String> = finding
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if names.is_empty() {
        if let Some(id) = finding.get("id").and_then(|v| v.as_str()) {
            if let Some((_, name)) = id.rsplit_once(':') {
                if !name.is_empty() && !name.contains(' ') && id.matches(':').count() >= 2 {
                    names.push(name.to_string());
                }
            }
        }
    }
    if names.is_empty() {
        return Ok((0, String::new()));
    }

    // A server can be declared in three places, and users who keep their setup
    // per-project have nothing in the global block at all — only stashing from
    // ~/.claude.json is why project users used to get "no server found":
    //   1. ~/.claude.json          → root .mcpServers        (global)
    //   2. ~/.claude.json          → projects.<dir>.mcpServers (per project)
    //   3. <project>/.mcp.json     → .mcpServers             (checked into repo)
    let home = dirs::home_dir().unwrap_or_default();
    let cfg = home.join(".claude.json");
    let mut moved = 0u32;
    let mut backups: Vec<String> = Vec::new();

    // ── 1 + 2: the global config, root block and every project block ──
    if let Ok(txt) = fs::read_to_string(&cfg) {
        if let Ok(mut root) = serde_json::from_str::<Value>(&txt) {
            let backup = format!("{}.terse-bak", cfg.display());
            fs::write(&backup, &txt).map_err(|e| e.to_string())?;
            let mut touched = 0u32;

            let mut stash: serde_json::Map<String, Value> = root
                .get("_terseDisabledMcpServers")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            if let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
                for n in &names {
                    if let Some(entry) = servers.remove(n) {
                        stash.insert(n.clone(), entry);
                        touched += 1;
                    }
                }
            }
            if !stash.is_empty() {
                root["_terseDisabledMcpServers"] = Value::Object(stash);
            }

            if let Some(projects) = root.get_mut("projects").and_then(|v| v.as_object_mut()) {
                for (_dir, pv) in projects.iter_mut() {
                    let mut pstash: serde_json::Map<String, Value> = pv
                        .get("_terseDisabledMcpServers")
                        .and_then(|v| v.as_object())
                        .cloned()
                        .unwrap_or_default();
                    if let Some(servers) = pv.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
                        for n in &names {
                            if let Some(entry) = servers.remove(n) {
                                pstash.insert(n.clone(), entry);
                                touched += 1;
                            }
                        }
                    }
                    if !pstash.is_empty() {
                        pv["_terseDisabledMcpServers"] = Value::Object(pstash);
                    }
                }
            }

            if touched > 0 {
                let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
                fs::write(&cfg, out).map_err(|e| e.to_string())?;
                moved += touched;
                backups.push(backup);
            }
        }
    }

    // ── 3: each tracked project's checked-in .mcp.json ──
    for dir in claude_project_dirs() {
        let p = dir.join(".mcp.json");
        let Ok(txt) = fs::read_to_string(&p) else { continue };
        let Ok(mut root) = serde_json::from_str::<Value>(&txt) else { continue };
        let mut touched = 0u32;
        let mut stash: serde_json::Map<String, Value> = root
            .get("_terseDisabledMcpServers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
            for n in &names {
                if let Some(entry) = servers.remove(n) {
                    stash.insert(n.clone(), entry);
                    touched += 1;
                }
            }
        }
        if touched > 0 {
            let backup = format!("{}.terse-bak", p.display());
            fs::write(&backup, &txt).map_err(|e| e.to_string())?;
            root["_terseDisabledMcpServers"] = Value::Object(stash);
            let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
            fs::write(&p, out).map_err(|e| e.to_string())?;
            moved += touched;
            backups.push(backup);
        }
    }

    Ok((moved, backups.join(", ")))
}

/// Project roots Claude Code knows about — the keys of `projects` in
/// ~/.claude.json. Used to reach per-project .mcp.json and CLAUDE.md.
fn claude_project_dirs() -> Vec<PathBuf> {
    let cfg = dirs::home_dir().unwrap_or_default().join(".claude.json");
    let Ok(txt) = fs::read_to_string(cfg) else { return Vec::new() };
    let Ok(root) = serde_json::from_str::<Value>(&txt) else { return Vec::new() };
    root.get("projects")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().map(PathBuf::from).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

/// A CLAUDE.md is prose — Terse must not silently rewrite what the user tells
/// their agent. So the "fix" is mechanical-only and non-destructive: back the
/// original up, write a *draft* beside it with the safely-removable weight
/// stripped (collapsed blank runs, trailing whitespace, duplicated lines), and
/// hand the draft back for review. The user swaps it in, not us.
///
/// Returns (human-readable size delta, draft path), or None if nothing to trim.
/// Trims the global CLAUDE.md **and** every tracked project's CLAUDE.md — a user
/// whose weight lives in a project file used to click this and be told the global
/// one was already lean.
fn trim_claude_md() -> Result<Option<(String, String)>, String> {
    let mut targets: Vec<PathBuf> =
        vec![dirs::home_dir().unwrap_or_default().join(".claude").join("CLAUDE.md")];
    for dir in claude_project_dirs() {
        targets.push(dir.join("CLAUDE.md"));
    }

    let mut saved_total = 0usize;
    let mut drafts: Vec<String> = Vec::new();
    for t in targets {
        if !t.exists() {
            continue;
        }
        if let Ok(Some((saved, draft))) = trim_one_claude_md(&t) {
            saved_total += saved;
            drafts.push(draft);
        }
    }
    if drafts.is_empty() {
        return Ok(None);
    }
    // Open the biggest win so the user lands on the file worth reviewing.
    if let Some(first) = drafts.first() {
        let _ = crate::hidden_command("cmd").args(["/C", "start", ""]).arg(first).status();
    }
    Ok(Some((human_size(saved_total as u64), drafts.join(", "))))
}

fn trim_one_claude_md(path: &Path) -> Result<Option<(usize, String)>, String> {
    let txt = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let before = txt.len();

    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut blank_run = 0usize;
    let mut in_code = false;
    for line in txt.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        if trimmed.trim().is_empty() && !in_code {
            blank_run += 1;
            if blank_run > 1 {
                continue; // collapse runs of blank lines
            }
        } else {
            blank_run = 0;
        }
        // Drop exact duplicate non-trivial lines outside code fences — repeated
        // instructions are pure context tax and never change the meaning.
        let key = trimmed.trim().to_string();
        if !in_code && key.len() > 24 && !key.starts_with('#') && !seen.insert(key) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    let trimmed_txt = out.join("\n");
    let after = trimmed_txt.len();
    if after + 64 >= before {
        return Ok(None);
    }

    let backup = format!("{}.terse-bak", path.display());
    fs::write(&backup, &txt).map_err(|e| e.to_string())?;
    let draft = path.with_file_name("CLAUDE.terse-trimmed.md");
    fs::write(&draft, &trimmed_txt).map_err(|e| e.to_string())?;
    Ok(Some((before - after, draft.display().to_string())))
}

// ── Remediation helpers for the direct-fix kinds ─────────────────────────────
