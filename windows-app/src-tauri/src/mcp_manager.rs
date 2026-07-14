//! MCP Manager — discover every MCP server configured across the user's coding
//! agents (Claude Code global + `.mcp.json`, Cursor, Windsurf), risk-score each
//! from its configuration (remote transport, embedded credentials, arbitrary
//! code-execution surface, unpinned supply chain, broad scopes), and let the
//! user enable/disable a server without hand-editing JSON.
//!
//! This is a static, read-only audit of the *config* — we never connect to a
//! server or run anything. Enable/disable moves an entry between `mcpServers`
//! and `mcpServersDisabled` in the same file, preserving everything else.

use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// One discovered MCP server plus its computed risk.
#[derive(Debug, Clone, Serialize)]
pub struct McpServer {
    pub name: String,
    /// Stable id: "<source_path>::<name>".
    pub id: String,
    /// Where it came from, human-readable ("Claude Code", "Cursor", "Windsurf").
    pub source: String,
    /// Absolute path of the config file that defines it.
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    /// "stdio" | "http" | "sse" | "unknown".
    pub transport: String,
    /// Command + args, or the remote URL — a short summary for display.
    pub command: String,
    pub enabled: bool,
    /// Env var *names* only (never values), so the UI can flag credential holders.
    #[serde(rename = "envKeys")]
    pub env_keys: Vec<String>,
    /// 0–100.
    pub risk: u8,
    #[serde(rename = "riskLevel")]
    pub risk_level: String,
    /// Human-readable reasons behind the score.
    pub reasons: Vec<String>,
}

/// A config file we know how to read, with the label shown to the user.
struct ConfigFile {
    path: PathBuf,
    source: &'static str,
}

fn config_files() -> Vec<ConfigFile> {
    let h = home();
    vec![
        ConfigFile { path: h.join(".claude.json"), source: "Claude Code" },
        ConfigFile { path: h.join(".mcp.json"), source: "Claude Code (.mcp.json)" },
        ConfigFile { path: h.join(".cursor/mcp.json"), source: "Cursor" },
        ConfigFile { path: h.join(".codeium/windsurf/mcp_config.json"), source: "Windsurf" },
    ]
}

/// Read a config file to JSON, guarding against the multi-MB `~/.claude.json`.
fn read_json(path: &PathBuf) -> Option<Value> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > 96 * 1_048_576 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// True for env keys that look like a secret we'd hate a rogue server to read.
fn looks_secret(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PAT", "APIKEY", "AUTH", "PRIVATE"]
        .iter()
        .any(|needle| k.contains(needle))
}

/// Score one server entry from its config object. Returns (risk, level, reasons).
fn score(entry: &Value, transport: &str, command: &str, env_keys: &[String]) -> (u8, String, Vec<String>) {
    let mut risk: i32 = 0;
    let mut reasons: Vec<String> = Vec::new();
    let cmd_l = command.to_ascii_lowercase();

    // Remote transport — your prompts and context leave the machine.
    if transport == "http" || transport == "sse" {
        risk += 30;
        reasons.push("Remote server — your prompts and context are sent to an external host.".into());
    }

    // Credentials in env — a compromised/malicious server could exfiltrate them.
    let secret_keys: Vec<&String> = env_keys.iter().filter(|k| looks_secret(k)).collect();
    if !secret_keys.is_empty() {
        risk += 25;
        let names = secret_keys.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        reasons.push(format!("Holds credentials in env ({names}) — exposed to whatever this server runs."));
    }

    // Arbitrary code-execution surface.
    if cmd_l.contains("sh -c") || cmd_l.contains("bash -c") || cmd_l.starts_with("sh ") || cmd_l.starts_with("bash ") {
        risk += 35;
        reasons.push("Launches a shell — runs arbitrary commands on your machine.".into());
    } else if cmd_l.contains("npx") || cmd_l.contains("uvx") || cmd_l.contains("bunx") || cmd_l.contains("pipx run") {
        risk += 15;
        reasons.push("Fetches and runs a package at launch (npx/uvx) — supply-chain surface.".into());
        // Unpinned package (no @version / no ==) is worse.
        let pinned = cmd_l.contains("@") && !cmd_l.contains("@latest");
        if !pinned {
            risk += 10;
            reasons.push("Package version is unpinned — you get whatever is published today.".into());
        }
    } else if cmd_l.contains("docker") {
        risk += 10;
        reasons.push("Runs a Docker container.".into());
    } else if cmd_l.contains("node ") || cmd_l.contains("python") || cmd_l.contains("deno ") {
        risk += 8;
        reasons.push("Runs a local script interpreter.".into());
    }

    // Broad scopes hinted by the command/args/name.
    if cmd_l.contains("filesystem") || cmd_l.contains(" / ") || cmd_l.ends_with(" /") || cmd_l.contains("--allow-write") || cmd_l.contains("$home") {
        risk += 15;
        reasons.push("Broad filesystem scope — can read/write widely.".into());
    }
    if cmd_l.contains("shell") || cmd_l.contains("exec") || cmd_l.contains("terminal") {
        risk += 12;
        reasons.push("Exposes shell/exec-style tools.".into());
    }

    // A server that carries no obvious risk still deserves a floor note.
    if reasons.is_empty() {
        reasons.push("Local stdio server with no credentials or code-fetch detected.".into());
    }

    // Env with any secret AND remote transport is the classic exfil combo.
    if (transport == "http" || transport == "sse") && !secret_keys.is_empty() {
        risk += 10;
        reasons.push("Remote + credentials — the highest-value exfiltration target.".into());
    }

    let _ = entry; // reserved for future per-tool inspection
    let risk = risk.clamp(0, 100) as u8;
    let level = if risk >= 60 { "high" } else if risk >= 30 { "medium" } else { "low" };
    (risk, level.to_string(), reasons)
}

/// Turn one `mcpServers` entry into a fully-scored `McpServer`.
fn build_server(name: &str, entry: &Value, source: &str, source_path: &str, enabled: bool) -> McpServer {
    // Transport + command summary.
    let url = entry.get("url").and_then(|v| v.as_str());
    let (transport, command) = if let Some(u) = url {
        let t = entry.get("type").and_then(|v| v.as_str()).unwrap_or("http");
        let t = if t.contains("sse") { "sse" } else { "http" };
        (t.to_string(), u.to_string())
    } else if let Some(cmd) = entry.get("command").and_then(|v| v.as_str()) {
        let args = entry
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let full = if args.is_empty() { cmd.to_string() } else { format!("{cmd} {args}") };
        ("stdio".to_string(), full)
    } else {
        ("unknown".to_string(), String::new())
    };

    let env_keys: Vec<String> = entry
        .get("env")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    let (risk, risk_level, reasons) = score(entry, &transport, &command, &env_keys);

    McpServer {
        name: name.to_string(),
        id: format!("{source_path}::{name}"),
        source: source.to_string(),
        source_path: source_path.to_string(),
        transport,
        command,
        enabled,
        env_keys,
        risk,
        risk_level,
        reasons,
    }
}

/// Pull servers from one config file's `mcpServers` (enabled) and
/// `mcpServersDisabled` (disabled) maps.
fn servers_from(cf: &ConfigFile, out: &mut Vec<McpServer>) {
    let Some(v) = read_json(&cf.path) else { return };
    let sp = cf.path.to_string_lossy().into_owned();
    for (key, enabled) in [("mcpServers", true), ("mcpServersDisabled", false)] {
        if let Some(obj) = v.get(key).and_then(|m| m.as_object()) {
            for (name, entry) in obj {
                out.push(build_server(name, entry, cf.source, &sp, enabled));
            }
        }
    }
}

/// Discover + score every configured MCP server.
pub fn list_servers() -> Vec<McpServer> {
    let mut out = Vec::new();
    for cf in config_files() {
        servers_from(&cf, &mut out);
    }
    // Highest risk first, then by name for stability.
    out.sort_by(|a, b| b.risk.cmp(&a.risk).then(a.name.cmp(&b.name)));
    out
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn mcp_list() -> Value {
    let servers = list_servers();
    let total = servers.len();
    let high = servers.iter().filter(|s| s.risk_level == "high").count();
    let medium = servers.iter().filter(|s| s.risk_level == "medium").count();
    let remote = servers.iter().filter(|s| s.transport == "http" || s.transport == "sse").count();
    let with_secrets = servers.iter().filter(|s| s.env_keys.iter().any(|k| looks_secret(k))).count();
    let enabled = servers.iter().filter(|s| s.enabled).count();
    serde_json::json!({
        "servers": servers,
        "summary": {
            "total": total,
            "high": high,
            "medium": medium,
            "low": total.saturating_sub(high + medium),
            "remote": remote,
            "withSecrets": with_secrets,
            "enabled": enabled,
            "disabled": total.saturating_sub(enabled),
        }
    })
}

/// Move a server between `mcpServers` and `mcpServersDisabled` in its own config
/// file. Round-trips the whole document as JSON so unrelated keys survive.
#[tauri::command]
pub fn mcp_set_enabled(source_path: String, name: String, enabled: bool) -> Result<bool, String> {
    let path = PathBuf::from(&source_path);
    let mut v = read_json(&path).ok_or_else(|| "config not readable".to_string())?;
    let obj = v.as_object_mut().ok_or_else(|| "config is not a JSON object".to_string())?;

    let (from_key, to_key) = if enabled {
        ("mcpServersDisabled", "mcpServers")
    } else {
        ("mcpServers", "mcpServersDisabled")
    };

    // Pull the entry out of the source map.
    let entry = obj
        .get_mut(from_key)
        .and_then(|m| m.as_object_mut())
        .and_then(|m| m.remove(&name))
        .ok_or_else(|| format!("server '{name}' not found in {from_key}"))?;

    // Insert into the destination map, creating it if needed.
    let dest = obj
        .entry(to_key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    dest.as_object_mut()
        .ok_or_else(|| format!("{to_key} is not an object"))?
        .insert(name, entry);

    let json = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(true)
}
