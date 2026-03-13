use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

// ── Agent Definitions ──

#[derive(Debug, Clone)]
struct AgentDef {
    name: &'static str,
    icon: &'static str,
    process_names: &'static [&'static str],
    log_dir: Option<PathBuf>,
    parser: &'static str,
}

/// Find the best Claude Code session across ALL running claude processes.
/// Returns (project_dir, pid, session_file) for the most recently written session.
fn find_best_claude_session() -> Option<(PathBuf, u32, PathBuf)> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude/projects");

    // Get all claude PIDs and their CWDs
    let output = std::process::Command::new("lsof")
        .args(["-c", "claude", "-a", "-d", "cwd", "-Fn"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pid_cwds: Vec<(u32, String)> = Vec::new();
    let mut current_pid: Option<u32> = None;

    for line in stdout.lines() {
        if let Some(pid_str) = line.strip_prefix('p') {
            current_pid = pid_str.parse().ok();
        } else if let Some(path) = line.strip_prefix('n') {
            if let Some(pid) = current_pid {
                if path.starts_with('/') {
                    pid_cwds.push((pid, path.to_string()));
                }
            }
        }
    }

    // Deduplicate by CWD (multiple PIDs may share the same CWD)
    let mut seen_cwds = std::collections::HashSet::new();
    pid_cwds.retain(|(_, cwd)| seen_cwds.insert(cwd.clone()));

    // For each unique CWD, find the project dir and its most recent session
    let mut best: Option<(PathBuf, u32, PathBuf, SystemTime)> = None;

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

        if let Some(file) = find_latest_session(&project_dir) {
            if let Ok(meta) = fs::metadata(&file) {
                if let Ok(mtime) = meta.modified() {
                    if best.as_ref().map_or(true, |(_, _, _, t)| mtime > *t) {
                        best = Some((project_dir, *pid, file, mtime));
                    }
                }
            }
        }
    }

    best.map(|(dir, pid, file, _)| (dir, pid, file))
}

/// Encode a CWD path the same way Claude Code does for project folder names.
/// Claude Code replaces '/' with '-' and also may normalize other characters.
fn encode_cwd_for_claude(cwd: &str) -> Vec<String> {
    // Primary: just replace / with -
    let primary = cwd.replace('/', "-");
    let mut candidates = vec![primary.clone()];
    // Also try replacing _ with - (Claude Code may normalize underscores)
    if cwd.contains('_') {
        candidates.push(cwd.replace('/', "-").replace('_', "-"));
    }
    candidates
}

/// Resolve the Claude Code log directory for a specific PID by reading its CWD
fn resolve_claude_log_dir(pid: u32) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude/projects");

    // Use lsof to get the CWD of the specific process
    let output = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "cwd", "-Fn"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix('n') {
            if path.starts_with('/') {
                for encoded in encode_cwd_for_claude(path) {
                    let project_dir = projects_dir.join(&encoded);
                    eprintln!("[terse-agent] PID {} cwd={}, trying {:?} exists={}", pid, path, project_dir, project_dir.exists());
                    if project_dir.exists() {
                        return Some(project_dir);
                    }
                }
            }
        }
    }

    // Fallback: try parent processes (claude may be spawned by npm)
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
    {
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

    // Get CWDs of running claude processes via lsof
    if let Ok(output) = std::process::Command::new("lsof")
        .args(["-c", "claude", "-a", "-d", "cwd", "-Fn"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut cwds: Vec<String> = Vec::new();
        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix('n') {
                if path.starts_with('/') {
                    cwds.push(path.to_string());
                }
            }
        }
        // For each CWD, check if a matching project folder exists
        for cwd in &cwds {
            let encoded = cwd.replace('/', "-");
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
            log_dir: claude_log_dir,
            parser: "claudeCode",
        }),
        ("openclaw", AgentDef {
            name: "OpenClaw",
            icon: "\u{1F99E}",
            process_names: &["openclaw", "claw"],
            log_dir: Some(home.join(".openclaw")),
            parser: "openclaw",
        }),
        ("aider", AgentDef {
            name: "Aider",
            icon: "\u{1F527}",
            process_names: &["aider"],
            log_dir: None,
            parser: "generic",
        }),
        ("cursor-agent", AgentDef {
            name: "Cursor Agent",
            icon: "\u{1F4DD}",
            process_names: &["Cursor Helper", "Cursor.app"],
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

        // Parse content
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

                        // Track large tool results (>1000 tokens)
                        if result_tokens > 1000 {
                            // Get the tool name from the previous message if available
                            let tool_name = self.messages.iter().rev()
                                .find(|m| m.msg_type == "tool_use")
                                .and_then(|m| m.tool_name.clone())
                                .unwrap_or_else(|| "unknown".to_string());
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

    /// Read new lines from session file
    fn read_new_lines(&mut self) {
        let file_path = match &self.session_file {
            Some(p) => p.clone(),
            None => return,
        };

        let metadata = match fs::metadata(&file_path) {
            Ok(m) => m,
            Err(_) => return,
        };
        let file_size = metadata.len();
        if file_size <= self.watcher_offset {
            return;
        }

        let mut file = match fs::File::open(&file_path) {
            Ok(f) => f,
            Err(_) => return,
        };
        let _ = file.seek(SeekFrom::Start(self.watcher_offset));

        let len = (file_size - self.watcher_offset) as usize;
        let mut buf = vec![0u8; len];
        if file.read_exact(&mut buf).is_err() {
            return;
        }
        self.watcher_offset = file_size;

        let text = String::from_utf8_lossy(&buf);
        let lines: Vec<&str> = text.split('\n').collect();

        // Handle incomplete last line
        if let Some(last) = lines.last() {
            if !last.is_empty() {
                self.watcher_offset -= last.len() as u64;
            }
        }

        for line in &lines[..lines.len().saturating_sub(1)] {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                self.parse_claude_code_line(&obj);
            }
        }
    }
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
}

impl AgentMonitor {
    pub fn new() -> Self {
        AgentMonitor {
            sessions: HashMap::new(),
            pending: Vec::new(),
            detected: HashMap::new(),
            miss_count: HashMap::new(),
        }
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
        self.sessions.values().filter(|s| s.connected).map(|s| s.get_snapshot()).collect()
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

        // Resolve log dir: for Claude Code, find the session matching the focused VS Code window.
        // Try the detected PID first, then try all claude PIDs in the same VS Code workspace.
        let resolved_log_dir = if detection.parser == "claudeCode" {
            // Try detected PID
            let mut dir = resolve_claude_log_dir(detection.pid);
            // If that fails or gives a different project, scan all claude PIDs
            if dir.is_none() {
                if let Some((d, pid, _)) = find_best_claude_session() {
                    session.pid = pid;
                    dir = Some(d);
                }
            }
            dir.or(detection.log_dir.clone())
        } else {
            detection.log_dir.clone()
        };
        eprintln!("[terse-agent] accept_agent: resolved log dir = {:?}", resolved_log_dir);

        // Find latest session file
        if let Some(log_dir) = &resolved_log_dir {
            if let Some(file) = find_latest_session(log_dir) {
                // Read existing history
                if let Ok(content) = fs::read_to_string(&file) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            session.parse_claude_code_line(&obj);
                        }
                    }
                }
                if let Ok(meta) = fs::metadata(&file) {
                    session.watcher_offset = meta.len();
                }
                session.session_file = Some(file);
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
            for proc in &procs {
                let comm_lower = proc.comm.to_lowercase();
                let matched = def.process_names.iter().any(|name| {
                    let lname = name.to_lowercase();
                    let basename = comm_lower.rsplit('/').next().unwrap_or(&comm_lower);
                    basename == lname || comm_lower.contains(&format!("/{}", lname))
                        || (comm_lower.contains(&lname) && !comm_lower.contains(".xpc/") && !comm_lower.contains("framework"))
                });
                if matched {
                    now_detected.insert(*type_key);
                    if !self.detected.contains_key(*type_key)
                        && !self.sessions.contains_key(*type_key)
                        && !self.pending.iter().any(|d| d.agent_type == *type_key)
                    {
                        self.detected.insert(type_key.to_string(), proc.pid);
                        let detection = PendingDetection {
                            agent_type: type_key.to_string(),
                            name: def.name.to_string(),
                            icon: def.icon.to_string(),
                            pid: proc.pid,
                            log_dir: def.log_dir.clone(),
                            parser: def.parser.to_string(),
                        };
                        self.pending.push(detection.clone());
                        new_detections.push((*type_key, detection));
                    }
                    break;
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

fn list_processes() -> Option<Vec<ProcessInfo>> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid,comm"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let procs: Vec<ProcessInfo> = stdout.lines().skip(1).filter_map(|line| {
        let trimmed = line.trim();
        let space_idx = trimmed.find(' ')?;
        let pid = trimmed[..space_idx].parse().ok()?;
        let comm = trimmed[space_idx + 1..].trim().to_string();
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

        for (_, detection) in &new_detections {
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
                    session.read_new_lines();
                    if session.messages.len() != prev_msg_count {
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
