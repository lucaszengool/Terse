use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

const CLAUDE_CODE_DEFAULT_TOOLS: &[&str] = &[
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "WebFetch",
    "WebSearch", "TodoWrite", "LSP", "Skill", "ToolSearch", "NotebookEdit",
    "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "CronCreate",
    "CronDelete", "CronList", "EnterWorktree", "ExitWorktree",
];

// ── Agent Definitions ──

#[derive(Debug, Clone)]
struct AgentDef {
    name: &'static str,
    icon: &'static str,
    process_names: &'static [&'static str],
    /// Fallback: also detect by checking if these config/log dirs exist and were
    /// recently modified (for agents that run inside another process, e.g. Cline in VS Code)
    config_detect_dirs: Vec<PathBuf>,
    log_dir: Option<PathBuf>,
    parser: &'static str,
}

/// Get the CWD of a Windows process by PID using PowerShell Get-CimInstance.
/// Returns the working directory if available from the CommandLine field.
fn get_process_cwd_by_pid(pid: u32) -> Option<String> {
    // On Windows, there's no direct equivalent of lsof -d cwd.
    // We use PowerShell to query the process CommandLine and ExecutablePath,
    // then try to extract the CWD from common patterns.
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            &format!(
                "Get-CimInstance Win32_Process -Filter \"ProcessId={}\" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json",
                pid
            ),
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let obj: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;

    // Try to extract CWD from command line arguments
    // Claude Code typically runs as: node ... --cwd <path> or is launched from a directory
    let cmd_line = obj["CommandLine"].as_str().unwrap_or("");

    // Check for --cwd argument
    if let Some(idx) = cmd_line.find("--cwd") {
        let rest = &cmd_line[idx + 5..];
        let trimmed = rest.trim_start();
        // Could be --cwd=<path> or --cwd <path>
        let path = if trimmed.starts_with('=') {
            trimmed[1..].trim_start()
        } else {
            trimmed
        };
        // Extract path (may be quoted)
        let cwd = if path.starts_with('"') {
            path[1..].split('"').next().unwrap_or("")
        } else {
            path.split_whitespace().next().unwrap_or("")
        };
        if !cwd.is_empty() {
            return Some(cwd.to_string());
        }
    }

    // Fallback: try to get the process's current directory via PowerShell
    // This uses a .NET call that may require elevation
    let cwd_output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            &format!(
                "try {{ (Get-Process -Id {}).StartInfo.WorkingDirectory }} catch {{ '' }}",
                pid
            ),
        ])
        .output()
        .ok()?;

    let cwd = String::from_utf8_lossy(&cwd_output.stdout).trim().to_string();
    if !cwd.is_empty() {
        return Some(cwd);
    }

    // Last resort: derive from executable path (go up from bin dir)
    if let Some(exe_path) = obj["ExecutablePath"].as_str() {
        if let Some(parent) = Path::new(exe_path).parent() {
            return Some(parent.to_string_lossy().to_string());
        }
    }

    None
}

/// Get CWDs of all running claude processes on Windows.
/// Returns Vec<(pid, cwd)>.
fn get_claude_pid_cwds() -> Vec<(u32, String)> {
    // Use PowerShell to find all claude processes and their command lines
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*claude*' } | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json",
        ])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() { return Vec::new(); }

    // PowerShell returns a single object (not array) if only one result
    let entries: Vec<serde_json::Value> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(v) => vec![v],
            Err(_) => Vec::new(),
        }
    };

    let mut pid_cwds = Vec::new();
    for entry in &entries {
        let pid = entry["ProcessId"].as_u64().unwrap_or(0) as u32;
        if pid == 0 { continue; }

        // Try to get CWD from command line or other methods
        if let Some(cwd) = get_process_cwd_by_pid(pid) {
            if !cwd.is_empty() {
                pid_cwds.push((pid, cwd));
            }
        }
    }

    pid_cwds
}

/// Find the best Claude Code session across ALL running claude processes.
/// Returns (project_dir, pid, session_file) for the most recently written session.
fn find_best_claude_session() -> Option<(PathBuf, u32, PathBuf)> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude/projects");

    // Get all claude PIDs and their CWDs via Windows process enumeration
    let mut pid_cwds = get_claude_pid_cwds();

    // Deduplicate by CWD (multiple PIDs may share the same CWD)
    let mut seen_cwds = std::collections::HashSet::new();
    pid_cwds.retain(|(_, cwd)| seen_cwds.insert(cwd.clone()));

    // For each unique CWD, find the project dir and its most recent session.
    // Prefer the Claude instance whose CWD matches the focused terminal.
    // Use the frontmost terminal app's current directory as a hint.
    let focused_cwd = get_focused_terminal_cwd();
    let mut best: Option<(PathBuf, u32, PathBuf, SystemTime, bool)> = None;

    for (pid, cwd) in &pid_cwds {
        let mut project_dir_opt: Option<PathBuf> = None;
        for encoded in encode_cwd_for_claude(cwd) {
            let candidate = projects_dir.join(&encoded);
            if candidate.exists() {
                project_dir_opt = Some(candidate);
                break;
            }
        }
        let project_dir = match project_dir_opt {
            Some(d) => d,
            None => continue,
        };

        // Check if this PID's CWD matches the focused terminal
        let is_focused = focused_cwd.as_ref().map_or(false, |fc| cwd == fc);

        if let Some(file) = find_latest_session(&project_dir) {
            if let Ok(meta) = fs::metadata(&file) {
                if let Ok(mtime) = meta.modified() {
                    // Prefer focused match over recency
                    let dominated = best.as_ref().map_or(true, |(_, _, _, t, was_focused)| {
                        if is_focused && !was_focused { true }
                        else if !is_focused && *was_focused { false }
                        else { mtime > *t }
                    });
                    if dominated {
                        best = Some((project_dir, *pid, file, mtime, is_focused));
                    }
                }
            }
        }
    }

    if let Some((_, _, ref file, _, _)) = best {
        eprintln!("[terse-agent] best_claude_session: {:?}", file);
    }
    best.map(|(dir, pid, file, _, _)| (dir, pid, file))
}

/// Get the CWD of the focused terminal window's foreground process.
/// On Windows, finds the most recently started claude process (highest PID).
fn get_focused_terminal_cwd() -> Option<String> {
    let mut pid_cwds = get_claude_pid_cwds();
    // Find the claude PID with the highest PID number (most recently started)
    pid_cwds.sort_by(|a, b| b.0.cmp(&a.0));
    pid_cwds.first().map(|(pid, cwd)| {
        eprintln!("[terse-agent] focused_terminal_cwd: PID {} → {}", pid, cwd);
        cwd.clone()
    })
}

/// Encode a CWD path the same way Claude Code does for project folder names.
/// On Windows, Claude Code replaces '\' and '/' with '-' and strips drive letters.
fn encode_cwd_for_claude(cwd: &str) -> Vec<String> {
    // Normalize backslashes to forward slashes first
    let normalized = cwd.replace('\\', "/");
    // Primary: replace / with -
    let primary = normalized.replace('/', "-");
    let mut candidates = vec![primary.clone()];
    // Also try replacing _ with - (Claude Code may normalize underscores)
    if normalized.contains('_') {
        candidates.push(normalized.replace('/', "-").replace('_', "-"));
    }
    // On Windows, also try with the drive letter stripped (e.g., C:/Users/... -> -Users-...)
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        let without_drive = &normalized[2..];
        let encoded = without_drive.replace('/', "-");
        candidates.push(encoded.clone());
        if without_drive.contains('_') {
            candidates.push(without_drive.replace('/', "-").replace('_', "-"));
        }
    }
    candidates
}

/// Resolve the Claude Code log directory for a specific PID by reading its CWD
fn resolve_claude_log_dir(pid: u32) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude/projects");

    // Use Windows process query to get the CWD of the specific process
    let cwd = get_process_cwd_by_pid(pid)?;

    for encoded in encode_cwd_for_claude(&cwd) {
        let project_dir = projects_dir.join(&encoded);
        eprintln!("[terse-agent] PID {} cwd={}, trying {:?} exists={}", pid, cwd, project_dir, project_dir.exists());
        if project_dir.exists() {
            return Some(project_dir);
        }
    }

    // Fallback: try parent process (claude may be spawned by npm/node)
    let parent_output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            &format!(
                "(Get-CimInstance Win32_Process -Filter \"ProcessId={}\").ParentProcessId",
                pid
            ),
        ])
        .output()
        .ok();

    if let Some(output) = parent_output {
        if let Ok(ppid) = String::from_utf8_lossy(&output.stdout).trim().parse::<u32>() {
            if ppid > 1 {
                return resolve_claude_log_dir(ppid);
            }
        }
    }
    None
}

/// Find the Claude Code project directory by reading CWD of running claude processes
fn find_claude_project_dir(home: &Path) -> Option<PathBuf> {
    let projects_dir = home.join(".claude/projects");
    if !projects_dir.exists() { return None; }

    // Get CWDs of running claude processes via Windows process enumeration
    let pid_cwds = get_claude_pid_cwds();

    // For each CWD, check if a matching project folder exists
    for (_, cwd) in &pid_cwds {
        for encoded in encode_cwd_for_claude(cwd) {
            let project_dir = projects_dir.join(&encoded);
            if project_dir.exists() {
                eprintln!("[terse-agent] found project dir for cwd={}: {:?}", cwd, project_dir);
                return Some(project_dir);
            }
        }
    }

    // Fallback: find the most recently modified project subdirectory
    let mut newest: Option<(PathBuf, SystemTime)> = None;
    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            if let Ok(meta) = fs::metadata(entry.path()) {
                if let Ok(mtime) = meta.modified() {
                    if newest.as_ref().map_or(true, |(_, t)| mtime > *t) {
                        newest = Some((entry.path(), mtime));
                    }
                }
            }
        }
    }
    newest.map(|(p, _)| p)
}

fn agent_defs() -> Vec<(&'static str, AgentDef)> {
    let home = dirs::home_dir().unwrap_or_default();
    let appdata = std::env::var("APPDATA").map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData/Roaming"));
    // Claude Code stores sessions in ~/.claude/projects/<url-encoded-cwd>/
    // We need to find the right project folder. Strategy:
    // 1. Try to read the CWD of any running 'claude' process
    // 2. Fall back to scanning all project dirs for the most recent session
    let claude_log_dir = find_claude_project_dir(&home);
    eprintln!("[terse-agent] claude log dir: {:?}", claude_log_dir);
    vec![
        ("claude-code", AgentDef {
            name: "Claude Code",
            icon: "\u{1F916}",
            process_names: &["claude"],
            config_detect_dirs: vec![],
            log_dir: claude_log_dir,
            parser: "claudeCode",
        }),
        ("openclaw", AgentDef {
            name: "OpenClaw",
            icon: "\u{1F99E}",
            process_names: &["openclaw", "claw"],
            config_detect_dirs: vec![home.join(".openclaw")],
            log_dir: Some(home.join(".openclaw")),
            parser: "openclaw",
        }),
        ("aider", AgentDef {
            name: "Aider",
            icon: "\u{1F527}",
            process_names: &["aider"],
            config_detect_dirs: vec![],
            log_dir: None,
            parser: "generic",
        }),
        ("cursor-agent", AgentDef {
            name: "Cursor Agent",
            icon: "\u{1F4DD}",
            // Cursor main binary is "Cursor.exe", helpers are "Cursor Helper" etc.
            process_names: &["Cursor", "Cursor Helper"],
            config_detect_dirs: vec![
                home.join(".cursor"),
                appdata.join("Cursor"),
            ],
            log_dir: None,
            parser: "generic",
        }),
        ("codex", AgentDef {
            name: "Codex CLI",
            icon: "\u{1F4AC}",
            process_names: &["codex"],
            config_detect_dirs: vec![home.join(".codex")],
            log_dir: Some(home.join(".codex")),
            parser: "generic",
        }),
        ("copilot", AgentDef {
            name: "Copilot CLI",
            icon: "\u{2708}",
            // Copilot CLI runs as `gh copilot` — process is `gh`.
            // Also check for dedicated copilot CLI binary names.
            process_names: &["github-copilot", "copilot-cli", "ghcs"],
            config_detect_dirs: vec![
                home.join(".github-copilot"),
                appdata.join("Code/User/globalStorage/github.copilot-chat"),
            ],
            log_dir: Some(home.join(".github-copilot")),
            parser: "generic",
        }),
        ("cline", AgentDef {
            name: "Cline",
            icon: "\u{1F50D}",
            // Cline runs as a VS Code extension — no standalone process.
            // Detection relies on config dirs being recently modified.
            process_names: &[],
            config_detect_dirs: vec![
                home.join(".cline"),
                home.join("Documents/Cline"),
                appdata.join("Code/User/globalStorage/saoudrizwan.claude-dev"),
            ],
            log_dir: Some(home.join(".cline")),
            parser: "generic",
        }),
        ("windsurf", AgentDef {
            name: "Windsurf",
            icon: "\u{1F3C4}",
            process_names: &["Windsurf", "Windsurf Helper"],
            config_detect_dirs: vec![
                home.join(".windsurf"),
                appdata.join("Windsurf"),
            ],
            log_dir: None,
            parser: "generic",
        }),
    ]
}

// ── Agent Session Data ──

#[derive(Debug, Clone)]
pub struct AgentSessionData {
    pub agent_type: String,
    pub agent_name: String,
    pub agent_icon: String,
    pub pid: u32,
    pub connected: bool,
    pub session_file: Option<PathBuf>,
    /// Multiple watched JSONL files (path → read offset) for multi-terminal monitoring
    pub watched_files: Vec<(PathBuf, u64)>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_create_tokens: u64,
    pub detected_model: Option<String>,
    pub turns: u32,
    pub tool_call_count: u32,
    pub messages: Vec<AgentMessage>,
    pub cache_efficiency: u32,
    pub watcher_offset: u64,
    pub started_at: std::time::Instant,
    pub file_reads: HashMap<String, u32>,  // path → read count
    pub large_results: Vec<(String, u64)>, // (tool_name, tokens)
    pub last_input_tokens: u64,            // most recent API call's input_tokens (= current context size)
    pub tools_used: HashMap<String, u32>,           // tool_name → call count
    pub tool_result_total_tokens: u64,              // sum of all tool result tokens
    pub tool_result_compressible: u64,              // estimated compressible tokens
    pub duplicate_tool_calls: u64,                  // count of duplicate tool calls
    pub duplicate_tool_tokens: u64,                 // tokens wasted on duplicate calls
    tool_call_hashes: HashSet<String>,              // cache keys for duplicate detection
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentMessage {
    pub role: String,
    pub text: String,
    pub tokens: u64,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl AgentSessionData {
    fn new(agent_type: &str, name: &str, icon: &str, pid: u32) -> Self {
        AgentSessionData {
            agent_type: agent_type.to_string(),
            agent_name: name.to_string(),
            agent_icon: icon.to_string(),
            pid,
            connected: false,
            session_file: None,
            watched_files: Vec::new(),
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_create_tokens: 0,
            detected_model: None,
            turns: 0,
            tool_call_count: 0,
            messages: Vec::new(),
            cache_efficiency: 0,
            watcher_offset: 0,
            started_at: std::time::Instant::now(),
            file_reads: HashMap::new(),
            large_results: Vec::new(),
            last_input_tokens: 0,
            tools_used: HashMap::new(),
            tool_result_total_tokens: 0,
            tool_result_compressible: 0,
            duplicate_tool_calls: 0,
            duplicate_tool_tokens: 0,
            tool_call_hashes: HashSet::new(),
        }
    }

    fn get_snapshot(&self) -> serde_json::Value {
        let total = self.total_input_tokens + self.total_output_tokens;
        let pricing = self.get_model_pricing();
        let est_cost = (self.total_input_tokens as f64 / 1000.0) * pricing.0
            + (self.total_output_tokens as f64 / 1000.0) * pricing.1
            + (self.total_cache_read_tokens as f64 / 1000.0) * pricing.2;

        // Context fill: use last API call's input_tokens as current context size
        let context_max: u64 = 200_000;
        let current_context = self.last_input_tokens;
        let context_fill = if current_context > 0 {
            ((current_context as f64 / context_max as f64) * 100.0).min(100.0) as u32
        } else { 0 };

        // Burn rate: tokens per minute
        let elapsed_secs = self.started_at.elapsed().as_secs().max(1);
        let burn_rate = (total as f64 / (elapsed_secs as f64 / 60.0)).round() as u64;

        // Redundant file reads
        let redundant_reads: Vec<_> = self.file_reads.iter()
            .filter(|(_, count)| **count >= 2)
            .map(|(path, count)| serde_json::json!({
                "path": path,
                "count": count,
                "wastedReads": count - 1,
            }))
            .collect();

        let reread_waste: u64 = self.file_reads.iter()
            .filter(|(_, c)| **c >= 2)
            .map(|(_, c)| (*c as u64 - 1) * 800) // ~800 tokens per average file read
            .sum();

        // Large tool results
        let large_results: Vec<_> = self.large_results.iter()
            .map(|(name, tok)| serde_json::json!({ "tool": name, "tokens": tok }))
            .collect();

        // Token breakdown by role
        let user_tokens: u64 = self.messages.iter()
            .filter(|m| m.role == "user").map(|m| m.tokens).sum();
        let assistant_tokens: u64 = self.messages.iter()
            .filter(|m| m.role == "assistant").map(|m| m.tokens).sum();
        let tool_tokens: u64 = self.messages.iter()
            .filter(|m| m.role == "tool").map(|m| m.tokens).sum();

        // Send full text for user messages (optimizer needs it), truncate others for display
        let recent: Vec<_> = self.messages.iter().rev().take(30).rev().map(|m| {
            let text = if m.role == "user" {
                safe_truncate(&m.text, 2000)
            } else {
                safe_truncate(&m.text, 120)
            };
            serde_json::json!({
                "role": m.role,
                "type": m.msg_type,
                "toolName": m.tool_name,
                "text": text,
                "tokens": m.tokens,
                "timestamp": m.timestamp,
            })
        }).collect();

        serde_json::json!({
            "id": format!("agent-{}-{}", self.agent_type, self.pid),
            "agentType": self.agent_type,
            "agentName": self.agent_name,
            "agentIcon": self.agent_icon,
            "connected": self.connected,
            "model": self.detected_model,
            "watchedFiles": self.watched_files.len(),
            "turns": self.turns,
            "totalInputTokens": self.total_input_tokens,
            "totalOutputTokens": self.total_output_tokens,
            "totalCacheReadTokens": self.total_cache_read_tokens,
            "totalCacheCreateTokens": self.total_cache_create_tokens,
            "totalTokens": total,
            "estimatedCost": (est_cost * 1000.0).round() / 1000.0,
            "recentMessages": recent,
            "toolCallCount": self.tool_call_count,
            "cacheEfficiency": self.cache_efficiency,
            // New analytics
            "contextFill": context_fill,
            "currentContext": current_context,
            "contextMax": context_max,
            "burnRate": burn_rate,
            "elapsedMinutes": (elapsed_secs as f64 / 60.0).round() as u64,
            "redundantReads": redundant_reads,
            "rereadWaste": reread_waste,
            "largeToolResults": large_results,
            "tokenBreakdown": {
                "user": user_tokens,
                "assistant": assistant_tokens,
                "tool": tool_tokens,
            },
            "toolManagement": self.get_tool_management_snapshot(),
            "toolResultStats": self.get_tool_result_stats_snapshot(),
            "toolCachePotential": {
                "duplicateCalls": self.duplicate_tool_calls,
                "duplicateCallTokens": self.duplicate_tool_tokens,
                "tokensWasted": self.duplicate_tool_tokens,
            },
            "conversationBloat": 0,
            "totalWastedTokens": 0,
            "contextDedupAlerts": [],
            "redundantToolCalls": [],
            "turnBreakdown": [],
            "allUserMessages": self.messages.iter()
                .filter(|m| m.role == "user" && m.msg_type == "text")
                .map(|m| {
                    let text = safe_truncate(&m.text, 2000);
                    serde_json::json!({ "text": text, "tokens": m.tokens, "timestamp": m.timestamp })
                })
                .collect::<Vec<_>>(),
            "allToolUses": self.messages.iter()
                .filter(|m| m.msg_type == "tool_use" || m.msg_type == "tool_result")
                .map(|m| serde_json::json!({
                    "type": m.msg_type,
                    "toolName": m.tool_name,
                    "text": safe_truncate(&m.text, 500),
                    "tokens": m.tokens,
                }))
                .collect::<Vec<_>>(),
            "optimizationStats": {
                "totalUserTokens": 0,
                "potentialSavings": 0,
                "optimizedMessages": 0,
            },
            "autoOptimized": { "count": 0, "tokensSaved": 0 },
        })
    }

    fn get_model_pricing(&self) -> (f64, f64, f64) {
        let m = self.detected_model.as_deref().unwrap_or("").to_lowercase();
        if m.contains("opus") { (0.015, 0.075, 0.0015) }
        else if m.contains("haiku") { (0.0008, 0.004, 0.00008) }
        else { (0.003, 0.015, 0.0003) }
    }

    fn get_tool_management_snapshot(&self) -> serde_json::Value {
        let used: serde_json::Map<String, serde_json::Value> = self.tools_used.iter()
            .map(|(k, v)| (k.clone(), serde_json::json!(*v)))
            .collect();

        // Unused tool estimate: only count after 5+ turns
        let (unused_estimate, estimated_overhead) = if self.turns >= 5 {
            let unused = CLAUDE_CODE_DEFAULT_TOOLS.iter()
                .filter(|t| !self.tools_used.contains_key(**t))
                .count() as u64;
            (unused, unused * 300)
        } else {
            (0, 0)
        };

        serde_json::json!({
            "used": used,
            "unusedEstimate": unused_estimate,
            "estimatedOverhead": estimated_overhead,
            "overheadPerTurn": estimated_overhead,
        })
    }

    fn get_tool_result_stats_snapshot(&self) -> serde_json::Value {
        let large_count = self.large_results.len() as u64;

        // Build top consumers: aggregate by tool name
        let mut consumer_map: HashMap<String, (u64, u32)> = HashMap::new();
        for (tool, tokens) in &self.large_results {
            let entry = consumer_map.entry(tool.clone()).or_insert((0, 0));
            entry.0 += tokens;
            entry.1 += 1;
        }
        let mut top_consumers: Vec<serde_json::Value> = consumer_map.iter()
            .map(|(tool, (total_tokens, call_count))| {
                serde_json::json!({
                    "tool": tool,
                    "totalTokens": total_tokens,
                    "callCount": call_count,
                })
            })
            .collect();
        top_consumers.sort_by(|a, b| {
            let ta = a["totalTokens"].as_u64().unwrap_or(0);
            let tb = b["totalTokens"].as_u64().unwrap_or(0);
            tb.cmp(&ta)
        });
        top_consumers.truncate(5);

        serde_json::json!({
            "totalTokens": self.tool_result_total_tokens,
            "compressibleTokens": self.tool_result_compressible,
            "largeCount": large_count,
            "topConsumers": top_consumers,
        })
    }

    fn parse_claude_code_line(&mut self, obj: &serde_json::Value) {
        let msg = match obj.get("message") {
            Some(m) => m,
            None => return,
        };
        let role = match msg.get("role").and_then(|r| r.as_str()) {
            Some(r) => r.to_string(),
            None => return,
        };
        if obj.get("type").and_then(|t| t.as_str()) == Some("file-history-snapshot") {
            return;
        }

        let ts = obj.get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // Detect model
        if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
            self.detected_model = Some(m.to_string());
        }
        if let Some(m) = obj.get("model").and_then(|m| m.as_str()) {
            self.detected_model = Some(m.to_string());
        }

        // Track tokens
        if let Some(usage) = msg.get("usage") {
            let raw_input = usage["input_tokens"].as_u64().unwrap_or(0);
            let cache_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
            let cache_create = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            let input = raw_input + cache_read + cache_create;
            let output = usage["output_tokens"].as_u64().unwrap_or(0);
            self.total_input_tokens += input;
            self.total_output_tokens += output;
            self.total_cache_read_tokens += cache_read;
            self.total_cache_create_tokens += cache_create;

            // Track current context size (= input tokens of latest API call)
            if input > 0 {
                self.last_input_tokens = input;
            }

            if self.total_input_tokens > 0 {
                self.cache_efficiency = ((self.total_cache_read_tokens as f64
                    / self.total_input_tokens as f64) * 100.0) as u32;
            }
        }

        // Parse content — handle both array (assistant messages) and string (user messages)
        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
            for block in content {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or("").to_string();
                        let tokens = estimate_tokens(&text);
                        self.messages.push(AgentMessage {
                            role: role.clone(),
                            text,
                            tokens,
                            timestamp: ts.clone(),
                            msg_type: "text".to_string(),
                            tool_name: None,
                        });
                    }
                    Some("tool_use") => {
                        let name = block["name"].as_str().unwrap_or("").to_string();
                        self.tool_call_count += 1;

                        // Track tools_used counts
                        *self.tools_used.entry(name.clone()).or_insert(0) += 1;

                        // Duplicate detection: hash tool_name + first 100 chars of input
                        let input_text = block.get("input")
                            .map(|v| v.to_string())
                            .unwrap_or_default();
                        let input_prefix = safe_truncate(&input_text, 100);
                        let cache_key = format!("{}:{}", name, input_prefix);
                        if !self.tool_call_hashes.insert(cache_key) {
                            // Already seen this tool+input combo
                            self.duplicate_tool_calls += 1;
                        }

                        // Track file reads for redundancy detection
                        if name == "Read" || name == "read_file" || name == "cat" {
                            if let Some(input) = block.get("input") {
                                let path = input["file_path"].as_str()
                                    .or_else(|| input["path"].as_str())
                                    .unwrap_or("");
                                if !path.is_empty() {
                                    *self.file_reads.entry(path.to_string()).or_insert(0) += 1;
                                }
                            }
                        }

                        self.messages.push(AgentMessage {
                            role: "tool".to_string(),
                            text: format!("Tool: {}", name),
                            tokens: 0,
                            timestamp: ts.clone(),
                            msg_type: "tool_use".to_string(),
                            tool_name: Some(name),
                        });
                    }
                    Some("tool_result") => {
                        let result_text = if let Some(s) = block["content"].as_str() {
                            s.to_string()
                        } else if let Some(arr) = block["content"].as_array() {
                            arr.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("")
                        } else {
                            String::new()
                        };
                        let result_tokens = estimate_tokens(&result_text);

                        // Get the tool name from the previous message if available
                        let tool_name = self.messages.iter().rev()
                            .find(|m| m.msg_type == "tool_use")
                            .and_then(|m| m.tool_name.clone())
                            .unwrap_or_else(|| "unknown".to_string());

                        // Track tool result token totals
                        self.tool_result_total_tokens += result_tokens;

                        // Estimate compressible tokens using RTK-style analysis
                        let compress_rate = match tool_name.as_str() {
                            "Bash" => estimate_bash_compressibility(&result_text),
                            "Read" | "read_file" => estimate_read_compressibility(&result_text),
                            "Grep" | "rg" => 0.45,
                            "Glob" | "find" => 0.55,
                            "WebFetch" | "WebSearch" => 0.35,
                            "Agent" => 0.25,
                            _ => 0.20,
                        };
                        self.tool_result_compressible += (result_tokens as f64 * compress_rate) as u64;

                        // Check if this result belongs to a duplicate call — track wasted tokens
                        {
                            let call_count = self.tools_used.get(&tool_name).copied().unwrap_or(0) as u64;
                            let unique_count = self.tool_call_hashes.iter()
                                .filter(|k| k.starts_with(&format!("{}:", tool_name)))
                                .count() as u64;
                            if call_count > unique_count {
                                self.duplicate_tool_tokens += result_tokens;
                            }
                        }

                        // Track large tool results (>1000 tokens)
                        if result_tokens > 1000 {
                            self.large_results.push((tool_name, result_tokens));
                        }

                        let truncated = if result_text.len() > 100 {
                            format!("{}...", safe_truncate(&result_text, 100))
                        } else {
                            result_text.clone()
                        };
                        self.messages.push(AgentMessage {
                            role: "tool".to_string(),
                            text: format!("Result: {}", truncated),
                            tokens: result_tokens,
                            timestamp: ts.clone(),
                            msg_type: "tool_result".to_string(),
                            tool_name: None,
                        });
                    }
                    _ => {}
                }
            }
        } else if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
            self.messages.push(AgentMessage {
                role: role.clone(),
                text: text.to_string(),
                tokens: estimate_tokens(text),
                timestamp: ts.clone(),
                msg_type: "text".to_string(),
                tool_name: None,
            });
        }

        // New user turn
        if role == "user" && obj.get("toolUseResult").is_none() {
            self.turns += 1;
        }

        // Cap messages
        if self.messages.len() > 200 {
            self.messages = self.messages.split_off(self.messages.len() - 200);
        }
    }

    fn parse_codex_line(&mut self, obj: &serde_json::Value) {
        let event_type = obj.get("type")
            .or_else(|| obj.get("event_type"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let ts = obj.get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(model) = obj.get("turn_context")
            .and_then(|tc| tc.get("model"))
            .and_then(|m| m.as_str())
        {
            self.detected_model = Some(model.to_string());
        }
        if let Some(model) = obj.get("model").and_then(|m| m.as_str()) {
            self.detected_model = Some(model.to_string());
        }

        match event_type {
            "turn.started" => {
                self.turns += 1;
            }

            "turn.completed" => {
                let u = obj.get("usage")
                    .or_else(|| obj.get("payload").and_then(|p| p.get("usage")))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);

                let input = u["input_tokens"].as_u64().unwrap_or(0);
                let cached = u["cached_input_tokens"].as_u64().unwrap_or(0);
                let output = u["output_tokens"].as_u64().unwrap_or(0);

                let new_total = input + cached + output;
                let cur_total = self.total_input_tokens + self.total_output_tokens;
                if new_total > cur_total {
                    self.total_input_tokens = input + cached;
                    self.total_cache_read_tokens = cached;
                    self.total_output_tokens = output;
                    self.last_input_tokens = input + cached;
                    if self.total_input_tokens > 0 {
                        self.cache_efficiency = ((self.total_cache_read_tokens as f64
                            / self.total_input_tokens as f64) * 100.0) as u32;
                    }
                }
            }

            "item.started" => {
                let item = obj.get("item")
                    .or_else(|| obj.get("payload").and_then(|p| p.get("item")))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let itype = item["type"].as_str().unwrap_or("");
                if codex_is_tool(itype) {
                    let name = item["name"].as_str()
                        .unwrap_or_else(|| codex_tool_display_name(itype))
                        .to_string();
                    self.tool_call_count += 1;
                    *self.tools_used.entry(name.clone()).or_insert(0) += 1;
                    let arg = codex_extract_arg(&item);
                    self.messages.push(AgentMessage {
                        role: "tool".to_string(),
                        text: format!("Tool: {}", name),
                        tokens: 0,
                        timestamp: ts.clone(),
                        msg_type: "tool_use".to_string(),
                        tool_name: Some(name),
                    });
                    let _ = arg;
                }
            }

            "item.completed" | "item.added" | "item.updated" => {
                let item = obj.get("item")
                    .or_else(|| obj.get("payload").and_then(|p| p.get("item")))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let itype = item["type"].as_str().unwrap_or("");

                match itype {
                    "message" | "agent_message" | "reasoning" => {
                        let text = item["text"].as_str()
                            .or_else(|| item["content"].as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text.is_empty() {
                            let tokens = estimate_tokens(&text);
                            self.messages.push(AgentMessage {
                                role: "assistant".to_string(),
                                text,
                                tokens,
                                timestamp: ts.clone(),
                                msg_type: "text".to_string(),
                                tool_name: None,
                            });
                        }
                    }
                    "input_message" => {
                        let text = item["content"].as_str()
                            .or_else(|| item["text"].as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text.is_empty() {
                            let tokens = estimate_tokens(&text);
                            self.messages.push(AgentMessage {
                                role: "user".to_string(),
                                text,
                                tokens,
                                timestamp: ts.clone(),
                                msg_type: "text".to_string(),
                                tool_name: None,
                            });
                        }
                    }
                    t if codex_is_tool(t) => {
                        let name = item["name"].as_str()
                            .unwrap_or_else(|| codex_tool_display_name(t))
                            .to_string();
                        let output = item["output"].as_str()
                            .or_else(|| item["content"].as_str())
                            .unwrap_or("");
                        let result_tokens = estimate_tokens(output);
                        self.tool_result_total_tokens += result_tokens;
                        if result_tokens > 1000 {
                            self.large_results.push((name, result_tokens));
                        }
                    }
                    _ => {}
                }
            }

            _ => {}
        }

        if self.messages.len() > 200 {
            self.messages = self.messages.split_off(self.messages.len() - 200);
        }
    }

    fn parse_generic_line(&mut self, obj: &serde_json::Value) {
        if obj.get("message").is_some() {
            self.parse_claude_code_line(obj);
            return;
        }

        let role = match obj.get("role").and_then(|r| r.as_str()) {
            Some(r) => r.to_string(),
            None => return,
        };

        let ts = obj.get("timestamp").or_else(|| obj.get("ts"))
            .and_then(|t| t.as_str()).unwrap_or("").to_string();

        if let Some(m) = obj.get("model").and_then(|m| m.as_str()) {
            self.detected_model = Some(m.to_string());
        }

        if let Some(usage) = obj.get("usage") {
            let input = usage["prompt_tokens"].as_u64()
                .or_else(|| usage["input_tokens"].as_u64())
                .unwrap_or(0);
            let output = usage["completion_tokens"].as_u64()
                .or_else(|| usage["output_tokens"].as_u64())
                .unwrap_or(0);
            if input > 0 || output > 0 {
                self.total_input_tokens += input;
                self.total_output_tokens += output;
                if input > 0 { self.last_input_tokens = input; }
                if self.total_input_tokens > 0 {
                    self.cache_efficiency = ((self.total_cache_read_tokens as f64
                        / self.total_input_tokens as f64) * 100.0) as u32;
                }
            }
        }

        if let Some(calls) = obj.get("tool_calls").and_then(|c| c.as_array()) {
            for call in calls {
                let name = call.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                self.tool_call_count += 1;
                *self.tools_used.entry(name.clone()).or_insert(0) += 1;
                self.messages.push(AgentMessage {
                    role: role.clone(),
                    text: format!("[{}]", name),
                    tokens: 10,
                    timestamp: ts.clone(),
                    msg_type: "tool_use".to_string(),
                    tool_name: Some(name),
                });
            }
        }

        let text = match obj.get("content") {
            Some(c) if c.is_string() => c.as_str().unwrap_or("").to_string(),
            Some(c) if c.is_array() => {
                c.as_array().unwrap().iter()
                    .filter_map(|b| {
                        b.get("text").and_then(|t| t.as_str())
                            .or_else(|| b.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("")
            }
            _ => String::new(),
        };

        if !text.is_empty() {
            let tokens = estimate_tokens(&text);
            self.messages.push(AgentMessage {
                role: role.clone(),
                text,
                tokens,
                timestamp: ts,
                msg_type: "text".to_string(),
                tool_name: None,
            });
        }

        if role == "user" {
            self.turns += 1;
        }

        if self.messages.len() > 200 {
            self.messages = self.messages.split_off(self.messages.len() - 200);
        }
    }

    /// Read new lines from session file
    fn read_new_lines(&mut self) {
        // Cursor: re-read from SQLite to pick up new messages
        if self.agent_type == "cursor-agent" && self.session_file.is_none() && self.watched_files.is_empty() {
            let msgs = read_cursor_conversations();
            let new_count = msgs.len();
            if new_count > self.messages.len() {
                let prev = self.messages.len();
                for (role, text, ts) in msgs.into_iter().skip(prev) {
                    let msg_type = if role == "tool" { "tool_use" } else { "text" }.to_string();
                    let tokens = estimate_tokens(&text);
                    self.messages.push(AgentMessage { role: role.clone(), text, tokens, timestamp: ts, msg_type, tool_name: None });
                    if role == "user" { self.turns += 1; }
                }
                self.total_input_tokens = self.messages.iter().map(|m| m.tokens).sum();
            }
            return;
        }
        // Read from all watched files (multi-terminal support)
        if !self.watched_files.is_empty() {
            self.read_new_lines_multi();
            return;
        }
        // Legacy single-file path
        let file_path = match &self.session_file {
            Some(p) => p.clone(),
            None => return,
        };
        let mut offset = self.watcher_offset;
        self.read_file_from_offset(&file_path, &mut offset);
        self.watcher_offset = offset;
    }

    fn read_new_lines_multi(&mut self) {
        // Also discover any new JSONL files that appeared since last scan
        if self.agent_type == "claude-code" {
            let all_files = find_all_active_jsonl_globally();
            for file in all_files {
                if !self.watched_files.iter().any(|(p, _)| *p == file) {
                    // New file — start reading from beginning to catch up
                    eprintln!("[terse-agent] new session file: {:?}", file.file_name().unwrap_or_default());
                    self.watched_files.push((file, 0));
                }
            }
        }

        let mut total_parsed = 0u32;
        let mut total_failed = 0u32;
        for i in 0..self.watched_files.len() {
            let (path, offset) = self.watched_files[i].clone();
            let metadata = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let file_size = metadata.len();
            if file_size <= offset { continue; }

            let mut file = match fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let _ = file.seek(SeekFrom::Start(offset));
            let len = (file_size - offset) as usize;
            let mut buf = vec![0u8; len];
            if file.read_exact(&mut buf).is_err() { continue; }

            let mut new_offset = file_size;
            let text = String::from_utf8_lossy(&buf);
            let lines: Vec<&str> = text.split('\n').collect();
            if let Some(last) = lines.last() {
                if !last.is_empty() {
                    new_offset -= last.len() as u64;
                }
            }
            self.watched_files[i].1 = new_offset;

            for line in &lines[..lines.len().saturating_sub(1)] {
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    self.parse_claude_code_line(&obj);
                    total_parsed += 1;
                } else {
                    total_failed += 1;
                }
            }
        }
        if total_parsed > 0 || total_failed > 0 {
            eprintln!("[terse-agent] read_new_lines_multi: {} parsed, {} failed, {} files, {} total msgs",
                total_parsed, total_failed, self.watched_files.len(), self.messages.len());
        }
    }

    fn read_file_from_offset(&mut self, file_path: &Path, offset: &mut u64) {
        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => return,
        };
        let file_size = metadata.len();
        if file_size <= *offset { return; }

        let mut file = match fs::File::open(file_path) {
            Ok(f) => f,
            Err(_) => return,
        };
        let _ = file.seek(SeekFrom::Start(*offset));
        let len = (file_size - *offset) as usize;
        let mut buf = vec![0u8; len];
        if file.read_exact(&mut buf).is_err() { return; }
        *offset = file_size;

        let text = String::from_utf8_lossy(&buf);
        let lines: Vec<&str> = text.split('\n').collect();
        if let Some(last) = lines.last() {
            if !last.is_empty() {
                *offset -= last.len() as u64;
            }
        }

        let parser = self.agent_type.clone();
        let mut parsed = 0u32;
        let mut failed = 0u32;
        for line in &lines[..lines.len().saturating_sub(1)] {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                match parser.as_str() {
                    "codex" => self.parse_codex_line(&obj),
                    "claude-code" => self.parse_claude_code_line(&obj),
                    _ => self.parse_generic_line(&obj),
                }
                parsed += 1;
            } else {
                failed += 1;
            }
        }
        if parsed > 0 {
            eprintln!("[terse-agent] read_new_lines: {} parsed, {} failed, {} total msgs", parsed, failed, self.messages.len());
        }
    }
}

/// Estimate compression rate for Bash tool output using RTK-style heuristics.
/// RTK achieves 60-92% compression on common dev commands.
fn estimate_bash_compressibility(output: &str) -> f64 {
    let lines: Vec<&str> = output.lines().collect();
    let line_count = lines.len();
    if line_count == 0 { return 0.0; }

    // Detect output type and estimate compression rate

    // Git output: 80-92% compressible (RTK's best category)
    if output.contains("modified:") || output.contains("Changes not staged")
        || output.contains("On branch") || output.contains("diff --git")
        || output.contains("commit ") && output.contains("Author:") {
        return 0.85;
    }

    // Test output: 90%+ compressible (failures-only strategy)
    if output.contains("PASS") || output.contains("FAIL")
        || output.contains("test result:") || output.contains("Tests:")
        || output.contains("✓") || output.contains("✗")
        || output.contains("passed") && output.contains("failed") {
        return 0.90;
    }

    // Build/compile output: 80% compressible
    if output.contains("Compiling") || output.contains("warning[")
        || output.contains("error[") || output.contains("BUILD")
        || output.contains("webpack") || output.contains("tsc") {
        return 0.80;
    }

    // Log output: 70-85% compressible (deduplication)
    let mut repeated_lines = 0;
    let mut seen = std::collections::HashSet::new();
    for line in &lines {
        let normalized = line.trim();
        if normalized.len() > 10 && !seen.insert(normalized) {
            repeated_lines += 1;
        }
    }
    if repeated_lines > line_count / 4 {
        return 0.75 + (repeated_lines as f64 / line_count as f64) * 0.15;
    }

    // JSON output: 80-95% compressible (structure-only)
    if output.trim_start().starts_with('{') || output.trim_start().starts_with('[') {
        return 0.85;
    }

    // Stack traces: 60-80% compressible
    let stack_frames = lines.iter()
        .filter(|l| l.trim_start().starts_with("at ") || l.contains("File \""))
        .count();
    if stack_frames > 3 {
        return 0.70;
    }

    // ANSI/progress output: 85-95% compressible
    if output.contains("\x1B[") || output.contains("Progress:")
        || output.contains("Downloading") {
        return 0.85;
    }

    // File listings: 50-70% compressible
    let path_lines = lines.iter()
        .filter(|l| (l.contains('/') || l.contains('\\')) && !l.contains(' ') && l.len() < 200)
        .count();
    if path_lines > line_count / 2 {
        return 0.55;
    }

    // Default for other Bash output
    0.35
}

/// Estimate compression rate for Read tool output (source code).
/// RTK's aggressive mode strips function bodies for 60-90% reduction.
fn estimate_read_compressibility(content: &str) -> f64 {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() { return 0.0; }

    // Count comment lines and blank lines
    let mut comments = 0;
    let mut blanks = 0;
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() { blanks += 1; }
        else if trimmed.starts_with("//") || trimmed.starts_with('#')
            || trimmed.starts_with("/*") || trimmed.starts_with('*') {
            comments += 1;
        }
    }

    let overhead_ratio = (comments + blanks) as f64 / lines.len() as f64;

    // Large files are more compressible (more function bodies to strip)
    let size_factor = if lines.len() > 500 { 0.70 }
        else if lines.len() > 200 { 0.55 }
        else if lines.len() > 50 { 0.45 }
        else { 0.30 };

    // Combine: overhead + size factor
    (overhead_ratio * 0.8 + size_factor * 0.6).min(0.90)
}

fn codex_is_tool(itype: &str) -> bool {
    matches!(itype, "command_execution" | "function_call" | "local_shell_call"
                  | "web_search_call" | "mcp_call" | "file_read" | "code_execution")
}

fn codex_tool_display_name(itype: &str) -> &'static str {
    match itype {
        "command_execution" | "local_shell_call" => "shell",
        "web_search_call" => "web_search",
        "file_read" => "read",
        "code_execution" => "code",
        "mcp_call" => "mcp",
        _ => "tool",
    }
}

fn codex_extract_arg(item: &serde_json::Value) -> String {
    if let Some(s) = item["command"].as_str() { return s.to_string(); }
    if let Some(s) = item["query"].as_str() { return s.to_string(); }
    if let Some(s) = item["path"].as_str() { return s.to_string(); }
    if let Some(v) = item.get("arguments") {
        if let Some(s) = v.as_str() { return s.to_string(); }
        return v.to_string();
    }
    String::new()
}

fn estimate_tokens(text: &str) -> u64 {
    let words = text.split_whitespace().count();
    let punct = text.chars().filter(|c| !c.is_alphanumeric() && !c.is_whitespace()).count();
    (words as f64 * 1.3 + punct as f64 * 0.5).ceil() as u64
}

/// Truncate a string at a char boundary, never panicking on multi-byte UTF-8
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── Agent Monitor ──

#[derive(Debug, Clone)]
pub struct PendingDetection {
    pub agent_type: String,
    pub name: String,
    pub icon: String,
    pub pid: u32,
    pub log_dir: Option<PathBuf>,
    pub parser: String,
}

pub struct AgentMonitor {
    pub sessions: HashMap<String, AgentSessionData>,
    pub pending: Vec<PendingDetection>,
    detected: HashMap<String, u32>, // type → pid
    miss_count: HashMap<String, u32>,
    plan_cache: HashMap<String, (AgentPlanInfo, std::time::Instant)>,
    /// Agents manually disconnected by user — suppressed from auto-detection until explicit reconnect
    suppressed: std::collections::HashSet<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentPlanInfo {
    pub plan: String,
    #[serde(rename = "rateLimitTier")]
    pub rate_limit_tier: Option<String>,
    #[serde(rename = "shortTerm")]
    pub short_term: Option<UsagePeriod>,
    #[serde(rename = "longTerm")]
    pub long_term: Option<UsagePeriod>,
    #[serde(rename = "requestsUsed")]
    pub requests_used: Option<u64>,
    #[serde(rename = "requestsMax")]
    pub requests_max: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsagePeriod {
    pub utilization: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<String>,
    pub label: String,
}

impl AgentMonitor {
    pub fn new() -> Self {
        AgentMonitor {
            sessions: HashMap::new(),
            pending: Vec::new(),
            detected: HashMap::new(),
            miss_count: HashMap::new(),
            plan_cache: HashMap::new(),
            suppressed: std::collections::HashSet::new(),
        }
    }

    pub fn get_cached_plan_info(&self, agent_type: &str) -> Option<&AgentPlanInfo> {
        if let Some((info, fetched_at)) = self.plan_cache.get(agent_type) {
            if fetched_at.elapsed() < Duration::from_secs(300) {
                return Some(info);
            }
        }
        None
    }

    pub fn set_plan_info(&mut self, agent_type: &str, info: AgentPlanInfo) {
        self.plan_cache.insert(agent_type.to_string(), (info, std::time::Instant::now()));
    }

    pub fn get_pending_detections(&self) -> Vec<serde_json::Value> {
        self.pending.iter().map(|d| {
            serde_json::json!({
                "type": d.agent_type,
                "name": d.name,
                "icon": d.icon,
                "pid": d.pid,
            })
        }).collect()
    }

    pub fn get_connected_sessions(&self) -> Vec<serde_json::Value> {
        // Sort by data richness so Claude Code (with JSONL logs) always comes first,
        // preventing Cursor/Codex (hook-only, zero token stats) from being sessions[0]
        let mut sessions: Vec<&AgentSessionData> = self.sessions.values().filter(|s| s.connected).collect();
        sessions.sort_by(|a, b| {
            let score = |s: &&AgentSessionData| s.total_input_tokens + s.turns as u64 * 1000;
            score(b).cmp(&score(a))
        });
        sessions.iter().map(|s| s.get_snapshot()).collect()
    }

    pub fn has_any_connected(&self) -> bool {
        self.sessions.values().any(|s| s.connected)
    }

    pub fn get_session_snapshot(&self, agent_type: &str) -> Option<serde_json::Value> {
        self.sessions.get(agent_type).map(|s| s.get_snapshot())
    }

    pub fn accept_agent(&mut self, agent_type: &str) -> Option<serde_json::Value> {
        let idx = self.pending.iter().position(|d| d.agent_type == agent_type)?;
        let detection = self.pending.remove(idx);

        let mut session = AgentSessionData::new(
            &detection.agent_type, &detection.name, &detection.icon, detection.pid,
        );

        if detection.parser == "claudeCode" {
            // Multi-terminal: find ALL active JSONL files across all Claude Code sessions
            let all_files = find_all_active_jsonl_globally();
            eprintln!("[terse-agent] accept_agent: found {} active JSONL files", all_files.len());

            // Read existing history from all files
            for file in &all_files {
                if let Ok(content) = fs::read_to_string(file) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            session.parse_claude_code_line(&obj);
                        }
                    }
                }
                let offset = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
                session.watched_files.push((file.clone(), offset));
            }
            // Also set session_file to newest for backward compat
            session.session_file = all_files.first().cloned();
            eprintln!("[terse-agent] loaded {} files: {} messages, {} turns, {} input tokens",
                all_files.len(), session.messages.len(), session.turns, session.total_input_tokens);
        } else if agent_type == "cursor-agent" {
            // Cursor stores conversations in SQLite (cursorDiskKV table), not JSONL files.
            let msgs = read_cursor_conversations();
            eprintln!("[terse-agent] cursor-agent: loaded {} messages from SQLite", msgs.len());
            for (role, text, ts) in msgs {
                let msg_type = if role == "tool" { "tool_use" } else { "text" }.to_string();
                let tokens = estimate_tokens(&text);
                session.messages.push(AgentMessage { role: role.clone(), text, tokens, timestamp: ts, msg_type, tool_name: None });
                if role == "user" { session.turns += 1; }
                session.total_input_tokens = session.messages.iter().map(|m| m.tokens).sum();
            }
        } else if detection.parser == "codex" {
            // Codex: find rollout file in ~/.codex/sessions/YYYY/MM/DD/
            let session_file = find_codex_session();
            eprintln!("[terse-agent] accept_agent codex: session_file = {:?}", session_file);
            if let Some(ref file) = session_file {
                if let Ok(content) = fs::read_to_string(file) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            session.parse_codex_line(&obj);
                        }
                    }
                }
                if let Ok(meta) = fs::metadata(file) {
                    session.watcher_offset = meta.len();
                }
                session.session_file = Some(file.clone());
            }
        } else {
            // Single-file path for other agents (Aider, etc.)
            let session_file = if let Some(log_dir) = &detection.log_dir {
                find_latest_session(log_dir)
            } else {
                None
            };
            eprintln!("[terse-agent] accept_agent: session_file = {:?}", session_file);

            if let Some(ref file) = session_file {
                if let Ok(content) = fs::read_to_string(file) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            session.parse_generic_line(&obj);
                        }
                    }
                }
                if let Ok(meta) = fs::metadata(file) {
                    session.watcher_offset = meta.len();
                }
                session.session_file = Some(file.clone());
            }
        }

        session.connected = true;
        let snapshot = session.get_snapshot();
        self.sessions.insert(agent_type.to_string(), session);
        Some(snapshot)
    }

    pub fn dismiss_agent(&mut self, agent_type: &str) {
        self.pending.retain(|d| d.agent_type != agent_type);
    }

    pub fn disconnect_agent(&mut self, agent_type: &str) {
        if let Some(session) = self.sessions.get_mut(agent_type) {
            session.connected = false;
        }
        self.sessions.remove(agent_type);
        // Suppress auto-reconnection until user explicitly reconnects via +
        self.suppressed.insert(agent_type.to_string());
    }

    /// Clear suppression for an agent type (called when user clicks + to reconnect)
    pub fn unsuppress_agent(&mut self, agent_type: &str) {
        self.suppressed.remove(agent_type);
        self.detected.remove(agent_type);
    }

    /// Scan for running agent processes. Returns (new_detections, lost_agent_types)
    pub fn scan(&mut self) -> (Vec<(&'static str, PendingDetection)>, Vec<String>) {
        let procs = match list_processes() {
            Some(p) => p,
            None => return (Vec::new(), Vec::new()),
        };

        let defs = agent_defs();
        let mut now_detected = std::collections::HashSet::new();
        let mut new_detections = Vec::new();

        for (type_key, def) in &defs {
            // Method 1: Process name matching
            let mut matched_pid: Option<u32> = None;
            if !def.process_names.is_empty() {
                for proc in &procs {
                    let comm_lower = proc.comm.to_lowercase();
                    let matched = def.process_names.iter().any(|name| {
                        let lname = name.to_lowercase();
                        let basename = comm_lower.rsplit('\\').next()
                            .unwrap_or_else(|| comm_lower.rsplit('/').next().unwrap_or(&comm_lower));
                        // Strip .exe suffix for comparison on Windows
                        let basename_no_ext = basename.strip_suffix(".exe").unwrap_or(basename);
                        basename_no_ext == lname || basename == lname
                            || comm_lower.contains(&format!("\\{}", lname))
                            || comm_lower.contains(&format!("/{}", lname))
                            || (comm_lower.contains(&lname) && !comm_lower.contains(".xpc\\") && !comm_lower.contains("framework"))
                    });
                    if matched {
                        matched_pid = Some(proc.pid);
                        break;
                    }
                }
            }

            // Method 2: Config dir detection (for agents like Cline that run inside
            // another process). Check if any config dir was modified in the last 2 minutes.
            if matched_pid.is_none() && !def.config_detect_dirs.is_empty() {
                for dir in &def.config_detect_dirs {
                    if dir.exists() {
                        if let Ok(meta) = fs::metadata(dir) {
                            if let Ok(mtime) = meta.modified() {
                                let age = SystemTime::now().duration_since(mtime).unwrap_or(Duration::from_secs(u64::MAX));
                                if age < Duration::from_secs(120) {
                                    // Config dir recently modified — agent is likely active
                                    matched_pid = Some(0); // pid 0 = detected via config
                                    eprintln!("[terse-agent] {} detected via config dir: {:?} (modified {}s ago)",
                                        def.name, dir, age.as_secs());
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if let Some(pid) = matched_pid {
                now_detected.insert(*type_key);
                if !self.detected.contains_key(*type_key)
                    && !self.sessions.contains_key(*type_key)
                    && !self.pending.iter().any(|d| d.agent_type == *type_key)
                    && !self.suppressed.contains(*type_key)
                {
                    self.detected.insert(type_key.to_string(), pid);
                    let detection = PendingDetection {
                        agent_type: type_key.to_string(),
                        name: def.name.to_string(),
                        icon: def.icon.to_string(),
                        pid,
                        log_dir: def.log_dir.clone(),
                        parser: def.parser.to_string(),
                    };
                    self.pending.push(detection.clone());
                    new_detections.push((*type_key, detection));
                }
            }
        }

        // Check for lost agents (3 consecutive misses)
        let lost: Vec<String> = self.detected.keys()
            .filter(|k| !now_detected.contains(k.as_str()))
            .cloned()
            .collect();

        let mut lost_types = Vec::new();
        for key in lost {
            let count = self.miss_count.entry(key.clone()).or_insert(0);
            *count += 1;
            if *count >= 3 {
                self.detected.remove(&key);
                self.miss_count.remove(&key);
                self.sessions.remove(&key);
                self.pending.retain(|d| d.agent_type != key);
                lost_types.push(key);
            }
        }

        // Reset miss count for detected agents
        for key in &now_detected {
            self.miss_count.remove(*key);
        }

        (new_detections, lost_types)
    }
}

/// Find the most recently written JSONL file across ALL Claude Code project directories
fn find_newest_jsonl_globally() -> Option<PathBuf> {
    find_all_active_jsonl_globally().into_iter().next()
}

/// Find ALL active JSONL session files across all Claude Code project dirs.
/// Returns files modified within the last 30 minutes, sorted newest first.
fn find_all_active_jsonl_globally() -> Vec<PathBuf> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let projects_dir = home.join(".claude/projects");
    if !projects_dir.exists() { return Vec::new(); }

    let mut active: Vec<(PathBuf, SystemTime)> = Vec::new();

    if let Ok(project_entries) = fs::read_dir(&projects_dir) {
        for project in project_entries.flatten() {
            if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            if let Ok(files) = fs::read_dir(project.path()) {
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                    if let Ok(meta) = fs::metadata(&path) {
                        if let Ok(mtime) = meta.modified() {
                            let age = SystemTime::now().duration_since(mtime).unwrap_or(Duration::from_secs(u64::MAX));
                            if age < Duration::from_secs(30 * 60) {
                                active.push((path, mtime));
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort newest first
    active.sort_by(|a, b| b.1.cmp(&a.1));
    // Only log on first call or count change (avoid spam)
    static LAST_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let prev = LAST_COUNT.swap(active.len(), std::sync::atomic::Ordering::Relaxed);
    if !active.is_empty() && active.len() != prev {
        eprintln!("[terse-agent] found {} active JSONL files globally", active.len());
    }
    active.into_iter().map(|(p, _)| p).collect()
}

/// Find the most recent active Codex rollout JSONL file.
/// Codex stores sessions at: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
fn find_codex_session() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let sessions_dir = home.join(".codex/sessions");
    if !sessions_dir.exists() { return None; }

    let mut newest: Option<(PathBuf, SystemTime)> = None;

    let Ok(years) = fs::read_dir(&sessions_dir) else { return None };
    for year in years.flatten() {
        if !year.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let Ok(months) = fs::read_dir(year.path()) else { continue };
        for month in months.flatten() {
            if !month.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let Ok(days) = fs::read_dir(month.path()) else { continue };
            for day in days.flatten() {
                if !day.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                let Ok(files) = fs::read_dir(day.path()) else { continue };
                for file in files.flatten() {
                    let p = file.path();
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if !name.starts_with("rollout-") || !name.ends_with(".jsonl") { continue; }
                    if let Ok(meta) = fs::metadata(&p) {
                        if let Ok(mtime) = meta.modified() {
                            if newest.as_ref().map_or(true, |(_, t)| mtime > *t) {
                                newest = Some((p, mtime));
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some((path, mtime)) = newest {
        let age = SystemTime::now().duration_since(mtime).unwrap_or(Duration::from_secs(u64::MAX));
        if age < Duration::from_secs(30 * 60) {
            eprintln!("[terse-agent] codex session: {:?}", path);
            return Some(path);
        }
    }
    None
}

/// Read recent Cursor conversations from the cursorDiskKV SQLite table (Windows paths).
fn read_cursor_conversations() -> Vec<(String, String, String)> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };

    let appdata = std::env::var("APPDATA").map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData/Roaming"));
    let global_db = appdata.join("Cursor/User/globalStorage/state.vscdb");
    let ws_root = appdata.join("Cursor/User/workspaceStorage");
    let mut dbs_to_try: Vec<PathBuf> = vec![global_db];

    if let Ok(entries) = fs::read_dir(&ws_root) {
        let mut ws_dbs: Vec<(PathBuf, SystemTime)> = entries.flatten()
            .filter_map(|e| {
                let db = e.path().join("state.vscdb");
                let mtime = fs::metadata(&db).ok()?.modified().ok()?;
                Some((db, mtime))
            })
            .collect();
        ws_dbs.sort_by(|a, b| b.1.cmp(&a.1));
        dbs_to_try.extend(ws_dbs.into_iter().map(|(p, _)| p));
    }

    let mut all_msgs: Vec<(String, String, String)> = Vec::new();

    for db_path in &dbs_to_try {
        if !db_path.exists() { continue; }

        // Use sqlite3.exe to read bubble data (ships with Windows or installed via scoop/winget)
        let output = match std::process::Command::new("sqlite3.exe")
            .arg("-json")
            .arg(db_path)
            .arg("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId%' AND length(value) > 50 ORDER BY rowid LIMIT 1000;")
            .output()
        {
            Ok(o) => o,
            Err(_) => continue,
        };

        if !output.status.success() { continue; }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let rows: Vec<serde_json::Value> = match serde_json::from_str(&stdout) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for row in &rows {
            let value_str = match row["value"].as_str() {
                Some(v) => v,
                None => continue,
            };
            let bubble: serde_json::Value = match serde_json::from_str(value_str) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let bubble_type = bubble["type"].as_u64().unwrap_or(0);
            let role = match bubble_type {
                1 => "user",
                2 => "assistant",
                _ => continue,
            };
            let ts = bubble["createdAt"].as_u64().unwrap_or(0).to_string();

            let text = extract_cursor_bubble_text(&bubble);
            if text.is_empty() && bubble_type == 2 { continue; }

            if let Some(tool_results) = bubble["toolResults"].as_array() {
                for tr in tool_results {
                    let tool_name = tr["toolName"].as_str()
                        .or_else(|| tr["name"].as_str())
                        .unwrap_or("tool");
                    let tool_text = tr["output"].as_str()
                        .or_else(|| tr["result"].as_str())
                        .unwrap_or("");
                    all_msgs.push(("tool".to_string(), format!("[{}] {}", tool_name, &tool_text[..tool_text.len().min(200)]), ts.clone()));
                }
            }

            if !text.is_empty() {
                all_msgs.push((role.to_string(), text, ts));
            }
        }

        if !all_msgs.is_empty() { break; }
    }

    all_msgs.sort_by(|a, b| a.2.cmp(&b.2));
    all_msgs
}

fn extract_cursor_bubble_text(bubble: &serde_json::Value) -> String {
    if let Some(rich) = bubble["richText"].as_str() {
        if !rich.is_empty() && rich.starts_with('{') {
            if let Ok(rt) = serde_json::from_str::<serde_json::Value>(rich) {
                let text = extract_lexical_text(&rt);
                if !text.is_empty() { return text; }
            }
        }
    }
    if let Some(t) = bubble["text"].as_str() {
        if !t.is_empty() { return t.to_string(); }
    }
    if let Some(t) = bubble["rawText"].as_str() {
        if !t.is_empty() { return t.to_string(); }
    }
    String::new()
}

fn extract_lexical_text(node: &serde_json::Value) -> String {
    if let Some(text) = node["text"].as_str() {
        return text.to_string();
    }
    let mut out = String::new();
    if let Some(children) = node["children"].as_array() {
        for child in children {
            let t = extract_lexical_text(child);
            if !t.is_empty() {
                if !out.is_empty() { out.push(' '); }
                out.push_str(&t);
            }
        }
    }
    out
}

fn find_latest_session(log_dir: &Path) -> Option<PathBuf> {
    if !log_dir.exists() { return None; }

    let mut newest: Option<(PathBuf, SystemTime)> = None;

    let mut check_jsonl = |path: PathBuf| {
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { return; }
        if let Ok(meta) = fs::metadata(&path) {
            if let Ok(mtime) = meta.modified() {
                if newest.as_ref().map_or(true, |(_, t)| mtime > *t) {
                    newest = Some((path, mtime));
                }
            }
        }
    };

    // Scan both direct files AND subdirectories for .jsonl files
    // Claude Code stores sessions as: ~/.claude/projects/<project-name>/<uuid>.jsonl
    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let ft = entry.file_type().unwrap_or_else(|_| entry.file_type().unwrap());
            if ft.is_file() {
                check_jsonl(entry.path());
            } else if ft.is_dir() {
                // Also check subdirectories (for other agent types)
                if let Ok(files) = fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        check_jsonl(file.path());
                    }
                }
            }
        }
    }

    // Only return if modified in last 30 minutes
    if let Some((path, mtime)) = newest {
        let age = SystemTime::now().duration_since(mtime).unwrap_or(Duration::from_secs(u64::MAX));
        if age < Duration::from_secs(30 * 60) {
            return Some(path);
        }
    }
    None
}

struct ProcessInfo {
    pid: u32,
    comm: String,
}

/// List all running processes on Windows using `tasklist /FO CSV /NH`.
fn list_processes() -> Option<Vec<ProcessInfo>> {
    let output = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let procs: Vec<ProcessInfo> = stdout.lines().filter_map(|line| {
        // tasklist CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
        let trimmed = line.trim();
        if trimmed.is_empty() { return None; }
        let fields: Vec<&str> = trimmed.split(',').collect();
        if fields.len() < 2 { return None; }
        // Strip surrounding quotes
        let comm = fields[0].trim_matches('"').to_string();
        let pid_str = fields[1].trim_matches('"');
        let pid: u32 = pid_str.trim().parse().ok()?;
        Some(ProcessInfo { pid, comm })
    }).collect();
    Some(procs)
}

/// Background scanning thread
pub fn start_scanning(app: AppHandle) {
    use crate::AppState;

    eprintln!("[terse-agent] scanner started");
    loop {
        std::thread::sleep(Duration::from_secs(5));

        let state = app.state::<AppState>();

        // Scan for new agents
        let (new_detections, lost_types) = {
            let mut monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
            monitor.scan()
        };

        if !new_detections.is_empty() {
            eprintln!("[terse-agent] detected {} new agents", new_detections.len());
        }

        // Auto-connect these agents (skip manual accept banner)
        const AUTO_CONNECT: &[&str] = &["claude-code", "cursor-agent", "codex"];
        for (_, detection) in &new_detections {
            if AUTO_CONNECT.contains(&detection.agent_type.as_str()) {
                let mut monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(snap) = monitor.accept_agent(&detection.agent_type) {
                    eprintln!("[terse-agent] auto-connected {}", detection.agent_type);
                    let _ = app.emit("agent-connected", serde_json::json!({"session": snap}));
                }
                continue;
            }
            let _ = app.emit("agent-detected", serde_json::json!({
                "type": detection.agent_type,
                "name": detection.name,
                "icon": detection.icon,
                "pid": detection.pid,
            }));
        }

        for agent_type in &lost_types {
            let _ = app.emit("agent-lost", serde_json::json!({
                "type": agent_type,
            }));
        }

        // Read new lines from connected sessions
        let updates: Vec<(String, serde_json::Value)> = {
            let mut monitor = state.agent_monitor.lock().unwrap_or_else(|e| e.into_inner());
            let mut updates: Vec<(String, serde_json::Value)> = Vec::new();
            let types: Vec<String> = monitor.sessions.keys().cloned().collect();
            for agent_type in types {
                if let Some(session) = monitor.sessions.get_mut(&agent_type) {
                    if !session.connected { continue; }
                    let prev_msg_count = session.messages.len();
                    let prev_tokens = session.total_input_tokens + session.total_output_tokens;
                    session.read_new_lines();
                    // Detect changes by message count or token growth
                    let new_tokens = session.total_input_tokens + session.total_output_tokens;
                    if session.messages.len() != prev_msg_count || new_tokens != prev_tokens {
                        updates.push((agent_type.clone(), session.get_snapshot()));
                    }
                }
            }
            updates
        };

        for (agent_type, snapshot) in updates {
            let _ = app.emit("agent-update", serde_json::json!({
                "agentType": agent_type,
                "session": snapshot,
            }));
        }
    }
}

// ── Plan/Usage Detection ──

/// Fetch Claude plan info on Windows.
/// Reads credentials from %APPDATA%\Claude Code\credentials.json or
/// the Windows Credential Manager, then queries the usage API.
pub fn fetch_claude_plan_info() -> Option<AgentPlanInfo> {
    // Strategy 1: Read credentials from %APPDATA%\Claude Code\credentials.json
    let cred_json = read_claude_credentials_from_file()
        .or_else(read_claude_credentials_from_credential_manager)?;

    // Token is nested under claudeAiOauth
    let oauth = &cred_json["claudeAiOauth"];
    let access_token = oauth["accessToken"].as_str()?;
    let rate_limit_tier = oauth.get("rateLimitTier")
        .and_then(|v| v.as_str()).map(String::from);

    // Derive plan name from rateLimitTier
    let plan = match rate_limit_tier.as_deref() {
        Some(t) if t.contains("max_20x") => "max_20x".to_string(),
        Some(t) if t.contains("max_5x") => "max_5x".to_string(),
        Some(t) if t.contains("max") => "max".to_string(),
        Some(t) if t.contains("pro") => "pro".to_string(),
        Some(t) if t.contains("free") => "free".to_string(),
        Some(t) => t.to_string(),
        None => {
            // Fallback: try `claude auth status`
            let auth_out = std::process::Command::new("claude")
                .args(["auth", "status", "--json"])
                .output().ok();
            if let Some(out) = auth_out {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    v["subscriptionType"].as_str().unwrap_or("unknown").to_string()
                } else { "unknown".to_string() }
            } else { "unknown".to_string() }
        }
    };

    // Call usage API
    let usage_output = std::process::Command::new("curl")
        .args(["-s", "--connect-timeout", "5", "--max-time", "10",
               "-H", &format!("Authorization: Bearer {}", access_token),
               "-H", "anthropic-beta: oauth-2025-04-20",
               "https://api.anthropic.com/api/oauth/usage"])
        .output().ok();

    let mut short_term = None;
    let mut long_term = None;

    if let Some(out) = usage_output {
        if let Ok(usage) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
            short_term = usage.get("five_hour").map(|v| UsagePeriod {
                utilization: v["utilization"].as_f64().unwrap_or(0.0),
                resets_at: v["resets_at"].as_str().map(String::from),
                label: "5h".into(),
            });
            long_term = usage.get("seven_day").map(|v| UsagePeriod {
                utilization: v["utilization"].as_f64().unwrap_or(0.0),
                resets_at: v["resets_at"].as_str().map(String::from),
                label: "7d".into(),
            });
        }
    }

    Some(AgentPlanInfo {
        plan,
        rate_limit_tier,
        short_term,
        long_term,
        requests_used: None,
        requests_max: None,
    })
}

/// Read Claude Code credentials from %APPDATA%\Claude Code\credentials.json
fn read_claude_credentials_from_file() -> Option<serde_json::Value> {
    let appdata = std::env::var("APPDATA").ok()?;
    let cred_path = Path::new(&appdata).join("Claude Code").join("credentials.json");
    if !cred_path.exists() {
        // Also try the .claude directory in home
        let home = dirs::home_dir()?;
        let alt_path = home.join(".claude").join("credentials.json");
        if alt_path.exists() {
            let content = fs::read_to_string(&alt_path).ok()?;
            return serde_json::from_str(&content).ok();
        }
        return None;
    }
    let content = fs::read_to_string(&cred_path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Read Claude Code credentials from Windows Credential Manager using cmdkey.
/// Falls back to PowerShell CredentialManager module.
fn read_claude_credentials_from_credential_manager() -> Option<serde_json::Value> {
    // Try PowerShell to read from Windows Credential Manager
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            r#"
            try {
                $cred = Get-StoredCredential -Target 'Claude Code-credentials' -ErrorAction Stop
                if ($cred) {
                    $cred.Password | ConvertFrom-SecureString -AsPlainText
                }
            } catch {
                # Fallback: try cmdkey list and extract
                $list = cmdkey /list:Claude* 2>&1
                Write-Output $list
            }
            "#,
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() { return None; }

    // Try to parse as JSON directly (from Get-StoredCredential)
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Some(v);
    }

    None
}

pub fn fetch_cursor_plan_info() -> Option<AgentPlanInfo> {
    let home = dirs::home_dir()?;
    let appdata = std::env::var("APPDATA").map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData/Roaming"));
    let db_path = appdata.join("Cursor/User/globalStorage/state.vscdb");
    if !db_path.exists() { return None; }
    let db_str = db_path.to_str()?;

    // Read plan type (use sqlite3.exe on Windows)
    let plan_output = std::process::Command::new("sqlite3.exe")
        .args(["-readonly", db_str,
               "SELECT value FROM ItemTable WHERE key='cursorAuth/stripeMembershipType'"])
        .output().ok()?;
    let plan = String::from_utf8_lossy(&plan_output.stdout).trim().to_string();
    if plan.is_empty() { return None; }

    // Read userId and accessToken for API call
    let uid_output = std::process::Command::new("sqlite3.exe")
        .args(["-readonly", db_str,
               "SELECT value FROM ItemTable WHERE key='cursorAuth/cachedUserId'"])
        .output().ok();
    let token_output = std::process::Command::new("sqlite3.exe")
        .args(["-readonly", db_str,
               "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'"])
        .output().ok();

    let user_id = uid_output.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let access_token = token_output.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let mut requests_used = None;
    let mut requests_max = None;
    let mut short_term = None;

    if !access_token.is_empty() && !user_id.is_empty() {
        let usage_output = std::process::Command::new("curl")
            .args(["-s", "--connect-timeout", "5", "--max-time", "10",
                   "-H", &format!("Cookie: WorkosCursorSessionToken={}", access_token),
                   &format!("https://www.cursor.com/api/usage?user={}", user_id)])
            .output().ok();

        if let Some(out) = usage_output {
            if let Ok(usage) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                let used = usage["gpt-4"]["numRequests"].as_u64();
                let max_req = usage["gpt-4"]["maxRequestUsage"].as_u64();
                requests_used = used;
                requests_max = max_req;
                if let (Some(u), Some(m)) = (used, max_req) {
                    short_term = Some(UsagePeriod {
                        utilization: if m > 0 { (u as f64 / m as f64) * 100.0 } else { 0.0 },
                        resets_at: usage["startOfMonth"].as_str().map(String::from),
                        label: "Monthly".into(),
                    });
                }
            }
        }
    }

    Some(AgentPlanInfo {
        plan,
        rate_limit_tier: None,
        short_term,
        long_term: None,
        requests_used,
        requests_max,
    })
}
