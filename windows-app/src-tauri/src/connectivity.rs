//! Connection Doctor — detect and auto-fix agent connectivity problems.
//!
//! Diagnoses the chain an agent needs to reach Claude: DNS → TCP/TLS to the API,
//! a broken HTTP(S) proxy in the environment, VPN interference, the auth token,
//! and — the most common local failure — Terse's own routing proxy on :7860
//! going down while `ANTHROPIC_BASE_URL` still points at it (which silently
//! kills every Claude Code request). `fix_all` restores what it safely can and
//! returns manual suggestions for the rest.

use serde::Serialize;
use serde_json::Value;
// Used only by the macOS-gated checks below; on Windows the reachability probes
// go through `crate::hidden_command` so no console window flashes.
#[allow(unused_imports)]
use std::process::Command;

const PROXY_PORT: u16 = 7860;

#[derive(Debug, Clone, Serialize)]
pub struct ConnCheck {
    pub id: String,
    pub label: String,
    /// "ok" | "warn" | "fail"
    pub status: String,
    pub detail: String,
    /// Whether `fix_all` can act on this automatically.
    pub fixable: bool,
    /// What the user should do if we can't fix it (empty when ok).
    pub suggestion: String,
}

impl ConnCheck {
    fn ok(id: &str, label: &str, detail: String) -> Self {
        ConnCheck { id: id.into(), label: label.into(), status: "ok".into(), detail, fixable: false, suggestion: String::new() }
    }
    fn warn(id: &str, label: &str, detail: String, fixable: bool, suggestion: &str) -> Self {
        ConnCheck { id: id.into(), label: label.into(), status: "warn".into(), detail, fixable, suggestion: suggestion.into() }
    }
    fn fail(id: &str, label: &str, detail: String, fixable: bool, suggestion: &str) -> Self {
        ConnCheck { id: id.into(), label: label.into(), status: "fail".into(), detail, fixable, suggestion: suggestion.into() }
    }
}

fn home() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// Does `~/.claude/settings.json` route Claude Code through Terse's local proxy?
fn base_url_points_to_terse() -> bool {
    let p = home().join(".claude/settings.json");
    if let Ok(txt) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            let url = v.get("env").and_then(|e| e.get("ANTHROPIC_BASE_URL")).and_then(|u| u.as_str()).unwrap_or("");
            return url.contains(&format!(":{PROXY_PORT}")) || url.contains("127.0.0.1") || url.contains("localhost");
        }
    }
    false
}

/// Is Terse's proxy actually listening on :7860?
fn proxy_port_alive() -> bool {
    crate::hidden_command("curl")
        .args(["-sS", "-o", "NUL", "--max-time", "3", &format!("http://127.0.0.1:{PROXY_PORT}/")])
        .output()
        .map(|o| o.status.success() || !o.stderr.is_empty() && String::from_utf8_lossy(&o.stderr).contains("Empty reply"))
        .unwrap_or(false)
}

/// Curl the Anthropic API and classify the result: reachable, DNS failure, or
/// timeout/no-route. Returns (ConnCheck for API, ConnCheck for DNS).
fn check_api_and_dns() -> (ConnCheck, ConnCheck) {
    let out = crate::hidden_command("curl")
        .args(["-sS", "-o", "NUL", "-w", "%{http_code} %{time_total}", "--max-time", "8",
               "https://api.anthropic.com/v1/messages"])
        .output();
    match out {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr).to_lowercase();
            let code = stdout.split_whitespace().next().unwrap_or("000");
            let secs = stdout.split_whitespace().nth(1).unwrap_or("0");
            let dns_bad = stderr.contains("could not resolve") || stderr.contains("resolve host");
            let dns = if dns_bad {
                ConnCheck::fail("dns", "DNS resolution", "Can't resolve api.anthropic.com".into(), true,
                    "Check your DNS / VPN. Fix all flushes the DNS cache; if it persists, switch DNS to 1.1.1.1 or disable a VPN.")
            } else {
                ConnCheck::ok("dns", "DNS resolution", "api.anthropic.com resolves".into())
            };
            let api = if code != "000" && code != "0" && !code.is_empty() {
                // Any HTTP status (even 401) proves the endpoint is reachable.
                let latency = secs.parse::<f64>().unwrap_or(0.0);
                if latency > 4.0 {
                    ConnCheck::warn("api", "Claude API reachable", format!("Reachable but slow ({latency:.1}s) — HTTP {code}"), false,
                        "High latency often means a VPN or proxy is in the path. Try disconnecting the VPN.")
                } else {
                    ConnCheck::ok("api", "Claude API reachable", format!("HTTP {code} in {latency:.1}s"))
                }
            } else if dns_bad {
                ConnCheck::fail("api", "Claude API reachable", "Unreachable — DNS failure".into(), false,
                    "Resolve the DNS problem above first.")
            } else if stderr.contains("timed out") || stderr.contains("timeout") {
                ConnCheck::fail("api", "Claude API reachable", "Connection timed out".into(), true,
                    "A VPN, firewall, or dead proxy is blocking api.anthropic.com. Fix all clears Terse's proxy override; otherwise disable the VPN/proxy.")
            } else {
                ConnCheck::fail("api", "Claude API reachable", format!("No response (curl: {})", stderr.trim().chars().take(80).collect::<String>()), true,
                    "Check your internet connection, VPN, and proxy settings.")
            };
            (api, dns)
        }
        Err(e) => (
            ConnCheck::fail("api", "Claude API reachable", format!("curl unavailable: {e}"), false, "Ensure curl is installed."),
            ConnCheck::ok("dns", "DNS resolution", "skipped".into()),
        ),
    }
}

/// Terse's local routing proxy — the usual local culprit.
fn check_terse_proxy() -> ConnCheck {
    let routed = base_url_points_to_terse();
    let alive = proxy_port_alive();
    if routed && !alive {
        ConnCheck::fail("terse_proxy", "Terse routing proxy",
            format!("Claude Code is pointed at Terse's proxy (:{PROXY_PORT}) but it isn't responding — every request will hang."), true,
            "Fix all removes the ANTHROPIC_BASE_URL override so Claude connects directly, then restarts the proxy.")
    } else if routed && alive {
        ConnCheck::ok("terse_proxy", "Terse routing proxy", format!("Healthy on :{PROXY_PORT}"))
    } else {
        ConnCheck::ok("terse_proxy", "Terse routing proxy", "Not in the request path (direct connection)".into())
    }
}

/// HTTP(S) proxy env vars that can silently break API calls.
fn check_proxy_env() -> ConnCheck {
    let mut set = Vec::new();
    for k in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() { set.push(format!("{k}={v}")); }
        }
    }
    if set.is_empty() {
        ConnCheck::ok("proxy_env", "System proxy", "No HTTP(S) proxy env set".into())
    } else {
        ConnCheck::warn("proxy_env", "System proxy", format!("Proxy set: {}", set.join(", ")), false,
            "If Claude can't connect, this proxy may be down or blocking api.anthropic.com. Unset it (unset HTTPS_PROXY HTTP_PROXY ALL_PROXY) and relaunch the agent.")
    }
}

/// VPN interfaces — informational; a common cause of timeouts/slow API.
#[cfg(target_os = "macos")]
fn check_vpn() -> ConnCheck {
    let nc = Command::new("scutil").arg("--nc").arg("list").output();
    let connected = nc.map(|o| String::from_utf8_lossy(&o.stdout).contains("Connected")).unwrap_or(false);
    // utun with an assigned IP is another VPN signal (WireGuard/NordVPN etc.)
    let utun = Command::new("ifconfig").output()
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.split("utun").skip(1).any(|blk| blk.lines().take(6).any(|l| l.trim_start().starts_with("inet ")))
        })
        .unwrap_or(false);
    if connected || utun {
        ConnCheck::warn("vpn", "VPN", "A VPN/tunnel interface is active".into(), false,
            "VPNs frequently cause API timeouts or slowness. If Claude is failing, try disconnecting the VPN and relaunching the agent.")
    } else {
        ConnCheck::ok("vpn", "VPN", "No active VPN detected".into())
    }
}
#[cfg(not(target_os = "macos"))]
fn check_vpn() -> ConnCheck {
    ConnCheck::ok("vpn", "VPN", "Not checked on this platform".into())
}

/// Claude Code OAuth token in the macOS Keychain.
#[cfg(target_os = "macos")]
fn check_auth() -> ConnCheck {
    let ok = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false);
    if ok {
        ConnCheck::ok("auth", "Claude auth token", "Token present in Keychain".into())
    } else {
        ConnCheck::fail("auth", "Claude auth token", "No Claude Code credentials found".into(), false,
            "Run `claude` in a terminal and sign in (or `claude login`) to refresh your token.")
    }
}
#[cfg(not(target_os = "macos"))]
fn check_auth() -> ConnCheck {
    ConnCheck::ok("auth", "Claude auth token", "Not checked on this platform".into())
}

/// Run every check. `stalled_agents` comes from the monitor (connected sessions
/// that haven't produced a response) so we can flag "Claude not responding".
pub fn scan(stalled_agents: &[String]) -> Vec<ConnCheck> {
    let (api, dns) = check_api_and_dns();
    let mut checks = vec![dns, api, check_terse_proxy(), check_proxy_env(), check_vpn(), check_auth()];
    if !stalled_agents.is_empty() {
        checks.push(ConnCheck::warn("agent_stall", "Agent responsiveness",
            format!("{} appears stalled (sent a request with no response)", stalled_agents.join(", ")), true,
            "Fix all nudges the session. If it stays stuck, the API checks above usually explain why."));
    } else {
        checks.push(ConnCheck::ok("agent_stall", "Agent responsiveness", "No stalled agents".into()));
    }
    checks
}

/// Best-effort automatic repairs. Returns (fixed_labels, actions_taken).
pub fn apply_fixes(checks: &[ConnCheck]) -> (Vec<String>, Vec<String>) {
    let mut fixed = Vec::new();
    let mut actions = Vec::new();

    let failed_ids: std::collections::HashSet<&str> = checks.iter()
        .filter(|c| c.status != "ok" && c.fixable)
        .map(|c| c.id.as_str())
        .collect();

    // 1. Dead Terse proxy override → remove it so Claude connects directly.
    if failed_ids.contains("terse_proxy") {
        crate::cleanup_proxy_configs();
        let _ = std::fs::remove_file(home().join(".terse").join("proxy.pid"));
        actions.push("Removed the stale Terse proxy override from ~/.claude/settings.json".into());
        fixed.push("Terse routing proxy".into());
    }

    // 2. DNS / timeout → flush the resolver cache (no-sudo path).
    if failed_ids.contains("dns") || failed_ids.contains("api") {
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("dscacheutil").arg("-flushcache").output();
            actions.push("Flushed the DNS resolver cache".into());
        }
    }

    (fixed, actions)
}
