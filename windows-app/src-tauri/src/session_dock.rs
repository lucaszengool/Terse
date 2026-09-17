//! A partial port of src-tauri/src/session_dock.rs — the parts the ROOM window
//! needs: find_transcript and sd_send for room_link, and sd_active, which lists
//! the live agent sessions a person can connect into a room. Without it the
//! room's "connect" panel is empty and the whole agent channel is unreachable,
//! however many rl_* commands exist. The session dock proper (17 commands, the docked window, the
//! transcript watchers) is macOS Accessibility and window-server work and is
//! still on the ledger in renderer-deps.test.mjs.
//!
//! The call sites are spelled exactly as they are on macOS, so when the rest is
//! ported this file grows rather than moving.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

pub(crate) fn find_transcript(id: &str) -> Option<PathBuf> {
    // id 只许是 uuid 的字符 —— 它要拼进路径,别让一个怪 id 走出 projects 目录
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let projects = home().join(".claude/projects");
    for e in std::fs::read_dir(&projects).ok()?.flatten() {
        let p = e.path().join(format!("{id}.jsonl"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Type a line into a Claude DESKTOP session by finding it in the sidebar.
///
/// macOS does this through the Accessibility tree. Windows has no equivalent
/// wired up — the honest answer is to say so, because the alternative is
/// sending a message into the wrong conversation, which room_link's own
/// comment calls worse than not sending it at all. Everything else in the room
/// channel is unaffected: Claude Code and Codex are reached through
/// dock_hook's queue, OpenClaw through its CLI.
pub fn sd_send(title: String, _text: String) -> Value {
    crate::diag_log("room", &format!(
        "sd_send(\"{title}\") — driving the Claude Desktop window is macOS-only, not sent"));
    json!({ "ok": false, "error": "Claude Desktop is not supported on Windows yet" })
}

// ── sd_active and its closure, from the macOS file (call-graph closure, 21 items) ──

/// Every running process's image name and full command line, cached for eight
/// seconds — the same freshness codex_live already used for lsof. One
/// PowerShell query costs a few hundred milliseconds, and live_ids and
/// codex_live both need it on every refresh of the room's "connect" list.
fn processes() -> Vec<(String, String)> {
    use std::sync::{Mutex, OnceLock};
    static C: OnceLock<Mutex<Option<(std::time::Instant, Vec<(String, String)>)>>> = OnceLock::new();
    let c = C.get_or_init(|| Mutex::new(None));
    if let Some((t, v)) = c.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if t.elapsed().as_secs() < 8 { return v.clone(); }
    }
    let out = crate::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               "Get-CimInstance Win32_Process | ForEach-Object { $_.Name + \"`t\" + $_.CommandLine }"])
        .output();
    let v: Vec<(String, String)> = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).lines()
            .filter_map(|l| l.split_once('\t').map(|(n, c)| (n.trim().to_string(), c.trim().to_string())))
            .collect(),
        Err(_) => Vec::new(),
    };
    *c.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), v.clone()));
    v
}

/// 此刻有进程在跑的会话(`--resume=<id>` 出现在某个进程的参数里)。
fn live_ids() -> HashSet<String> {
    // macOS reads every process's arguments with `ps -axo args=`; Windows has no
    // ps, so the same text comes from the shared, cached process list.
    let mut set = HashSet::new();
    {
        let s: String = processes().iter().map(|(_, cmd)| cmd.as_str()).collect::<Vec<_>>().join("\n");
        for part in s.split("--resume=").skip(1) {
            let id: String = part.chars().take_while(|c| c.is_ascii_hexdigit() || *c == '-').collect();
            if id.len() == 36 {
                set.insert(id);
            }
        }
    }
    set
}

fn walk_json(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_json(&p, out, depth + 1);
        } else if p.extension().map(|x| x == "json").unwrap_or(false) {
            out.push(p);
        }
    }
}

#[tauri::command(async)]
pub fn sd_sessions() -> Vec<Value> {
    // Claude Desktop keeps these under its app-data folder: ~/Library/Application
    // Support on macOS, %APPDATA% on Windows. dirs::config_dir() is exactly that
    // on both, so this is the macOS path rather than a guess at a new one.
    let root = dirs::config_dir().unwrap_or_default().join("Claude").join("claude-code-sessions");
    let mut files = Vec::new();
    walk_json(&root, &mut files, 0);
    let live = live_ids();
    let mut rows: Vec<(i64, Value)> = Vec::new();
    for f in files {
        let Ok(txt) = std::fs::read_to_string(&f) else { continue };
        let Ok(d) = serde_json::from_str::<Value>(&txt) else { continue };
        if d.get("isArchived").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(cli) = d.get("cliSessionId").and_then(|v| v.as_str()) else { continue };
        let last = d.get("lastActivityAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let cwd = d.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
        let project = Path::new(cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        rows.push((last, json!({
            "id": cli,
            "title": d.get("title").and_then(|v| v.as_str()).unwrap_or("(untitled)"),
            "project": project,
            "cwd": cwd,
            "lastActivityAt": last,
            "turns": d.get("completedTurns").and_then(|v| v.as_i64()).unwrap_or(0),
            "model": d.get("model").and_then(|v| v.as_str()).unwrap_or(""),
            "live": live.contains(cli),
            // Desktop 侧栏里那个 ⚠ 就是这个字段
            "error": d.get("error").map(|e| !e.is_null()).unwrap_or(false),
        })));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, v)| v).collect()
}

/// 会话栏只放**此刻有进程在跑**的会话,每条带上从记录尾巴读出来的状态。
///
/// 状态是"兜底"的那一层:记录只能告诉我们最后写下的是什么 —— 一个还没有结果的
/// tool_use 可能是在跑,也可能是在等你批准,光看记录分不出来。真正的"等你"来自
/// permission.rs 的中继(`permission-request` 事件),网页那边叠上去。
#[tauri::command(async)]
pub fn sd_active() -> Vec<Value> {
    let mut v = claude_active();
    v.extend(codex_active());
    v
}

fn claude_active() -> Vec<Value> {
    sd_sessions()
        .into_iter()
        .filter(|s| s.get("live").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|mut s| {
            let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let st = find_transcript(&id).map(|p| tail_state(&p)).unwrap_or_else(|| json!({ "state": "idle" }));
            if let (Some(o), Some(t)) = (s.as_object_mut(), st.as_object()) {
                for (k, v) in t {
                    o.insert(k.clone(), v.clone());
                }
            }
            s
        })
        .collect()
}

/// 读一段记录的**尾巴**(最后 256KB)判断它此刻在干嘛。整份读太贵 —— 会话栏每几秒
/// 就要问一次所有在跑的会话,而一份记录动辄几 MB。
fn tail_state(path: &Path) -> Value {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return json!({ "state": "idle" }) };
    let meta = f.metadata().ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    // 多久没写过了 —— 判断"卡住 / 空闲"全靠它
    let age = meta.and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map(|d| d.as_secs()).unwrap_or(u64::MAX);
    let start = len.saturating_sub(256 * 1024);
    let _ = f.seek(SeekFrom::Start(start));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // 从中间切进来的第一行是半截,不要
    }
    let mut pending: Vec<(String, String, String)> = Vec::new(); // (tool_use_id, 工具名, 参数)
    let mut last_role = String::new();
    let mut last_stop = String::new();
    let mut last_text = String::new();
    let mut ctx: i64 = 0;
    // 事件流(带时间):会话栏用它算"你离开期间它干了什么"、判断卡住
    let mut events: Vec<Value> = Vec::new();
    let mut err_streak: u32 = 0;
    let mut recent_calls: Vec<String> = Vec::new();
    let mut compact_ts: i64 = 0;
    // 最近一次 TodoWrite:{total, done, active} —— 卡片上显示"✓ 3/7 · 正在:…"(没有就不显示)
    let mut todos: Option<Value> = None;
    // 还没回答的 AskUserQuestion / ExitPlanMode 的输入(tool_use_id → input):它们在等**你**,不是在跑
    let mut asks: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    // 这一轮从哪一刻开始(最后一条人说的话)—— 卡片上"本轮 12 分钟"
    let mut turn_start: i64 = 0;
    // 最后一段回答写下的时刻 —— 会话栏据此判断"有你没看过的新回答"
    let mut last_text_ts: i64 = 0;
    // 它改过的文件(全路径)—— 只按这些文件算改动,不是整个分支的 diff
    let mut edit_paths: Vec<String> = Vec::new();
    // 记录里出现过的 PR 链接(gh pr create 的输出、回答里贴的链接)
    let mut prs: Vec<String> = Vec::new();
    let ts_of = |d: &Value| -> i64 {
        d.get("timestamp").and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp_millis()).unwrap_or(0)
    };
    for line in lines {
        let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
        let flag = |k: &str| d.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        if flag("isSidechain") {
            continue;
        }
        let ts = ts_of(&d);
        // 上下文被压缩:这一刻之前的细节只剩摘要 —— 会话栏要让人看见这件事发生了
        if flag("isCompactSummary") {
            compact_ts = ts;
            events.push(json!({ "t": ts, "k": "compact" }));
            continue;
        }
        if flag("isMeta") {
            continue;
        }
        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let msg = d.get("message");
        if t == "assistant" {
            // 上下文用量 = 最后一次请求的输入(含缓存)—— 就是此刻上下文窗口里装了多少
            if let Some(u) = msg.and_then(|m| m.get("usage")) {
                let g = |k: &str| u.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
                let c = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
                if c > 0 {
                    ctx = c;
                }
            }
            last_stop = msg.and_then(|m| m.get("stop_reason")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        }
        last_role = t.to_string();
        if t == "user" {
            // 人说的话(不是工具结果)= 新的一轮
            let human = match msg.and_then(|m| m.get("content")) {
                Some(Value::String(_)) => true,
                Some(Value::Array(bs)) => !bs.iter().any(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_result")),
                _ => false,
            };
            if human && ts > 0 {
                turn_start = ts;
            }
        }
        match msg.and_then(|m| m.get("content")) {
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    match b.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "tool_use" => {
                            let tid = b.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                            let inp = b.get("input");
                            let arg = ["description", "command", "file_path", "pattern", "url", "query", "prompt"]
                                .iter()
                                .find_map(|k| inp.and_then(|i| i.get(*k)).and_then(|v| v.as_str()))
                                .unwrap_or("");
                            let kind = match name.as_str() { "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit", "Bash" => "cmd", _ => "tool" };
                            let short = if kind == "edit" { Path::new(arg).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() } else { clip(arg, 60) };
                            if kind == "edit" {
                                let fp = inp.and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path"))).and_then(|v| v.as_str()).unwrap_or("");
                                if !fp.is_empty() {
                                    edit_paths.retain(|p| p != fp);
                                    edit_paths.push(fp.to_string());
                                    if edit_paths.len() > 80 { edit_paths.remove(0); }
                                }
                            }
                            if name == "AskUserQuestion" || name == "ExitPlanMode" {
                                asks.insert(tid.clone(), json!({ "tool": name, "input": inp.cloned().unwrap_or(Value::Null) }));
                            }
                            events.push(json!({ "t": ts, "k": kind, "v": short }));
                            recent_calls.push(format!("{name}:{arg}"));
                            if recent_calls.len() > 6 { recent_calls.remove(0); }
                            if name == "TodoWrite" {
                                if let Some(arr) = b.get("input").and_then(|i| i.get("todos")).and_then(|t| t.as_array()) {
                                    let st = |t: &Value| t.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string();
                                    let done = arr.iter().filter(|t| st(t) == "completed").count();
                                    let active = arr.iter().find(|t| st(t) == "in_progress")
                                        .and_then(|t| t.get("activeForm").or_else(|| t.get("content")))
                                        .and_then(|s| s.as_str()).unwrap_or("");
                                    todos = Some(json!({ "total": arr.len(), "done": done, "active": clip(active, 60) }));
                                }
                            }
                            pending.push((tid, name, clip(arg, 200)));
                        }
                        "tool_result" => {
                            let tid = b.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                            pending.retain(|p| p.0 != tid);
                            asks.remove(tid);
                            match b.get("content") {
                                Some(Value::String(s)) => find_prs(s, &mut prs),
                                Some(Value::Array(cs)) => for c in cs { if let Some(s) = c.get("text").and_then(|v| v.as_str()) { find_prs(s, &mut prs) } },
                                _ => {}
                            }
                            if b.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
                                err_streak += 1;
                                events.push(json!({ "t": ts, "k": "err" }));
                            } else {
                                err_streak = 0;
                            }
                        }
                        "text" if t == "assistant" => {
                            last_text = b.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            find_prs(&last_text, &mut prs);
                            if !last_text.trim().is_empty() { last_text_ts = ts; }
                        }
                        _ => {}
                    }
                }
            }
            Some(Value::String(s)) if t == "assistant" => { last_text = s.clone(); last_text_ts = ts; }
            _ => {}
        }
    }
    // 有没结果的工具调用 → 在跑工具(也可能在等批准,那由中继事件来改);
    // 最后是用户那边(提问或工具结果)→ 模型在想;最后是一段说完的回答 → 刚完成。
    // 太久没动一律算空闲 —— 实测只看"最后一行是谁"会把空闲 25 分钟的会话判成"思考中"。
    // 等你回答的提问 / 等你看的计划:不管挂了多久都算"在等你"(它不会自己动)
    let ask = pending.iter().rev().find_map(|p| asks.get(&p.0)).map(|a| {
        let inp = a.get("input").cloned().unwrap_or(Value::Null);
        if a.get("tool").and_then(|v| v.as_str()) == Some("ExitPlanMode") {
            json!({ "kind": "plan", "text": clip(&strip_tags(inp.get("plan").and_then(|v| v.as_str()).unwrap_or("")), 600) })
        } else {
            let q = inp.get("questions").and_then(|v| v.as_array()).and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
            let opts: Vec<String> = q.get("options").and_then(|v| v.as_array()).map(|a| a.iter()
                .filter_map(|o| o.get("label").and_then(|v| v.as_str()).map(|s| clip(s, 40))).take(4).collect()).unwrap_or_default();
            let more = inp.get("questions").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(1);
            json!({ "kind": "question", "text": clip(q.get("question").and_then(|v| v.as_str()).unwrap_or(""), 300), "options": opts, "count": more })
        }
    });
    let subagents = pending.iter().filter(|p| p.1 == "Task" || p.1 == "Agent").count();
    let (state, tool, arg) = if ask.is_some() {
        ("ask", String::new(), String::new())
    } else if let Some(p) = pending.last() {
        (if age < 900 { "tool" } else { "idle" }, p.1.clone(), p.2.clone())
    } else if last_role == "user" {
        (if age < 300 { "think" } else { "idle" }, String::new(), String::new())
    } else if last_stop == "end_turn" || (last_stop.is_empty() && age > 20) {
        (if age < 120 { "done" } else { "idle" }, String::new(), String::new())
    } else {
        (if age < 60 { "work" } else { "idle" }, String::new(), String::new())
    };
    // 在打转:最近 3 次工具调用一模一样(同一个工具、同一个参数)
    let n = recent_calls.len();
    let repeat = n >= 3 && recent_calls[n - 1] == recent_calls[n - 2] && recent_calls[n - 2] == recent_calls[n - 3];
    let skip = events.len().saturating_sub(300);
    json!({
        "state": state,
        "tool": tool,
        "arg": arg,
        "age": age,
        "ctx": ctx,
        "summary": clip(&strip_tags(&last_text).replace('\n', " "), 180),
        "errStreak": err_streak,
        "repeat": repeat,
        "compactTs": compact_ts,
        "todos": todos,
        "events": events.into_iter().skip(skip).collect::<Vec<_>>(),
        "ask": ask,
        "subagents": subagents,
        "turnStart": turn_start,
        "lastTextTs": last_text_ts,
        "editPaths": edit_paths,
        "prs": prs,
    })
}

/// 从一段文字里找 GitHub PR 链接(去重,留最近 3 个)
fn find_prs(s: &str, out: &mut Vec<String>) {
    if !s.contains("/pull/") {
        return;
    }
    for (i, _) in s.match_indices("https://github.com/") {
        let rest = &s[i..];
        let end = rest.find(|c: char| c.is_whitespace() || "\"'()[]<>`,".contains(c)).unwrap_or(rest.len());
        let url = &rest[..end];
        let parts: Vec<&str> = url.trim_start_matches("https://github.com/").split('/').collect();
        if parts.len() >= 4 && parts[2] == "pull" {
            let n: String = parts[3].chars().take_while(|c| c.is_ascii_digit()).collect();
            if n.is_empty() {
                continue;
            }
            let u = format!("https://github.com/{}/{}/pull/{}", parts[0], parts[1], n);
            out.retain(|x| x != &u);
            out.push(u);
            if out.len() > 3 { out.remove(0); }
        }
    }
}

pub const CODEX_PREFIX: &str = "codex:";

fn ts_ms(d: &Value) -> i64 {
    d.get("timestamp").and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis()).unwrap_or(0)
}

fn file_age(p: &Path) -> u64 {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map(|d| d.as_secs()).unwrap_or(u64::MAX)
}

fn codex_db() -> Option<PathBuf> {
    std::fs::read_dir(home().join(".codex")).ok()?.flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let v: u32 = n.strip_prefix("state_")?.strip_suffix(".sqlite")?.parse().ok()?;
            Some((v, e.path()))
        })
        .max_by_key(|x| x.0).map(|x| x.1)
}

fn codex_threads() -> Vec<Value> {
    use rusqlite::{Connection, OpenFlags};
    let Some(db) = codex_db() else { return vec![] };
    let Ok(c) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else { return vec![] };
    let _ = c.busy_timeout(std::time::Duration::from_millis(300));
    let Ok(mut st) = c.prepare("select id, rollout_path, cwd, title, coalesce(git_branch,''), coalesce(model,''), coalesce(updated_at_ms, updated_at*1000) \
        from threads where archived = 0 order by 7 desc limit 40") else { return vec![] };
    let rows = st.query_map([], |r| Ok(json!({
        "id": r.get::<_, String>(0)?, "rollout": r.get::<_, String>(1)?, "cwd": r.get::<_, String>(2)?,
        "title": r.get::<_, String>(3)?, "branch": r.get::<_, String>(4)?, "model": r.get::<_, String>(5)?, "updated": r.get::<_, i64>(6)?,
    })));
    let out: Vec<Value> = match rows { Ok(it) => it.flatten().collect(), Err(_) => vec![] };
    out
}

/// 表里记的是 .jsonl;Codex Desktop 实际存的可能是 .jsonl.zst
fn codex_rollout(p: &str) -> Option<PathBuf> {
    let p = PathBuf::from(p);
    if p.exists() { return Some(p); }
    let z = PathBuf::from(format!("{}.zst", p.display()));
    z.exists().then_some(z)
}

fn codex_read(p: &Path) -> String {
    if p.extension().map(|e| e == "zst").unwrap_or(false) {
        let Some(z) = crate::agent_monitor::zstd_binary() else { return String::new() };
        return crate::hidden_command(z).arg("-dc").arg(p).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    }
    std::fs::read_to_string(p).unwrap_or_default()
}

/// (有没有 Codex 进程, Codex 进程开着的 rollout 文件)。lsof 要几百毫秒,缓存 8 秒
fn codex_live() -> (bool, HashSet<String>) {
    use std::sync::{Mutex, OnceLock};
    static C: OnceLock<Mutex<Option<(std::time::Instant, bool, HashSet<String>)>>> = OnceLock::new();
    let c = C.get_or_init(|| Mutex::new(None));
    if let Some((t, r, s)) = c.lock().unwrap().as_ref() {
        if t.elapsed().as_secs() < 8 { return (*r, s.clone()); }
    }
    // pgrep → the shared process list. There is no lsof on Windows, and reading
    // another process's open handles needs NtQuerySystemInformation, so `open`
    // stays empty. That is not a new behaviour invented here: with no open-file
    // list, codex_active already falls back to "a rollout written in the last
    // five minutes is live" and marks the row liveGuess. Windows simply always
    // takes that path.
    let running = processes().iter().any(|(name, _)| name.to_ascii_lowercase().contains("codex"));
    let open: HashSet<String> = HashSet::new();
    *c.lock().unwrap() = Some((std::time::Instant::now(), running, open.clone()));
    (running, open)
}

fn codex_active() -> Vec<Value> {
    let (running, open) = codex_live();
    if !running { return vec![] }
    codex_threads().into_iter().filter_map(|t| {
        let rp = codex_rollout(t["rollout"].as_str()?)?;
        let rps = rp.to_string_lossy().to_string();
        let exact = open.iter().any(|o| rps.starts_with(o.as_str()) || o.starts_with(rps.as_str()));
        if !exact && file_age(&rp) >= 300 { return None; }
        let cwd = t["cwd"].as_str().unwrap_or("").to_string();
        let mut st = codex_state(&rp);
        let o = st.as_object_mut()?;
        o.insert("id".into(), json!(format!("{CODEX_PREFIX}{}", t["id"].as_str()?)));
        o.insert("agent".into(), json!("codex"));
        o.insert("title".into(), json!(clip(t["title"].as_str().unwrap_or("Codex"), 80)));
        o.insert("project".into(), json!(Path::new(&cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()));
        o.insert("cwd".into(), json!(cwd));
        o.insert("model".into(), t["model"].clone());
        o.insert("lastActivityAt".into(), t["updated"].clone());
        o.insert("live".into(), json!(true));
        o.insert("liveGuess".into(), json!(!exact));
        Some(st)
    }).take(12).collect()
}

/// Codex 的命令常是 ["bash","-lc","真正的命令"] —— 只留真正那一句
fn codex_cmd(v: Option<&Value>) -> String {
    match v {
        Some(Value::Array(a)) => {
            let s: Vec<&str> = a.iter().filter_map(|x| x.as_str()).collect();
            if s.len() >= 3 && (s[1] == "-lc" || s[1] == "-c") { s[2..].join(" ") } else { s.join(" ") }
        }
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn codex_patch_files(p: &Value) -> Vec<String> {
    p.get("changes").and_then(|c| c.as_object()).map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

/// 读 rollout 判断它此刻在干嘛(字段和 tail_state 一样,会话栏同一套画法)
fn codex_state(path: &Path) -> Value {
    let age = file_age(path);
    let text = codex_read(path);
    let lines: Vec<&str> = text.lines().collect();
    let (mut running, mut last_done) = (false, false);
    let (mut turn_start, mut last_text_ts, mut ctx, mut ctx_max) = (0i64, 0i64, 0i64, 0i64);
    let mut last_text = String::new();
    let mut approval: Option<(String, String, String)> = None; // (call_id, 工具, 参数)
    let mut execs: Vec<(String, String)> = Vec::new();         // 在跑的命令 (call_id, 命令)
    let (mut events, mut edit_paths, mut prs): (Vec<Value>, Vec<String>, Vec<String>) = (vec![], vec![], vec![]);
    let mut err_streak = 0u32;
    for line in &lines[lines.len().saturating_sub(4000)..] {
        let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
        let ts = ts_ms(&d);
        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let p = d.get("payload").cloned().unwrap_or(Value::Null);
        let pt = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let call = p.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if t == "event_msg" {
            match pt {
                "task_started" => { running = true; last_done = false; turn_start = ts; }
                "task_complete" => {
                    running = false; last_done = true; approval = None; execs.clear();
                    let m = s("last_agent_message"); if !m.is_empty() { last_text = m; last_text_ts = ts; }
                }
                "turn_aborted" => { running = false; last_done = false; approval = None; execs.clear(); }
                "user_message" => turn_start = ts,
                "agent_message" => { let m = s("message"); find_prs(&m, &mut prs); if !m.is_empty() { last_text = m; last_text_ts = ts; } }
                "exec_approval_request" => approval = Some((call, "Shell".into(), codex_cmd(p.get("command")))),
                "apply_patch_approval_request" => approval = Some((call, "Patch".into(), codex_patch_files(&p).join(", "))),
                "exec_command_begin" => {
                    if approval.as_ref().map(|a| a.0 == call).unwrap_or(false) { approval = None; }
                    let c = codex_cmd(p.get("command"));
                    events.push(json!({ "t": ts, "k": "cmd", "v": clip(&c, 60) }));
                    execs.push((call, c));
                }
                "exec_command_end" => {
                    execs.retain(|e| e.0 != call);
                    if p.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0) != 0 { err_streak += 1; events.push(json!({ "t": ts, "k": "err" })); } else { err_streak = 0; }
                    for k in ["stdout", "aggregated_output", "formatted_output"] { find_prs(&s(k), &mut prs); }
                }
                "patch_apply_begin" => {
                    if approval.as_ref().map(|a| a.0 == call).unwrap_or(false) { approval = None; }
                    for f in codex_patch_files(&p) {
                        events.push(json!({ "t": ts, "k": "edit", "v": Path::new(&f).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default() }));
                        edit_paths.retain(|x| x != &f); edit_paths.push(f);
                    }
                }
                "patch_apply_end" => if p.get("success").and_then(|v| v.as_bool()) == Some(false) { err_streak += 1; events.push(json!({ "t": ts, "k": "err" })); },
                "token_count" => if let Some(info) = p.get("info") {
                    let c = info.get("last_token_usage").and_then(|u| u.get("input_tokens")).and_then(|v| v.as_i64()).unwrap_or(0);
                    if c > 0 { ctx = c; }
                    if let Some(w) = info.get("model_context_window").and_then(|v| v.as_i64()) { ctx_max = w; }
                },
                _ => {}
            }
        } else if t == "response_item" && pt == "message" && p.get("role").and_then(|v| v.as_str()) == Some("assistant") && last_text.is_empty() {
            // 老格式(没有 event_msg)退而求其次
            last_text = p.get("content").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|x| x.get("text").and_then(|v| v.as_str())).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            last_text_ts = ts;
        }
    }
    let (state, tool, arg, waiting) = if let Some(a) = &approval {
        ("tool", a.1.clone(), a.2.clone(), true) // 在 Codex 里等你批准(它自己不会动)
    } else if running && age < 900 {
        match execs.last() { Some(e) => ("tool", "Shell".to_string(), e.1.clone(), false), None => ("think", String::new(), String::new(), false) }
    } else if last_done && age < 120 {
        ("done", String::new(), String::new(), false)
    } else {
        ("idle", String::new(), String::new(), false)
    };
    let skip = events.len().saturating_sub(300);
    json!({
        "state": state, "tool": tool, "arg": clip(&arg, 200), "age": age, "waiting": waiting,
        "ctx": ctx, "ctxMax": ctx_max,
        "summary": clip(&last_text.replace('\n', " "), 180),
        "errStreak": err_streak, "repeat": false, "compactTs": 0, "todos": Value::Null,
        "events": events.into_iter().skip(skip).collect::<Vec<_>>(),
        "ask": Value::Null, "subagents": 0, "turnStart": turn_start, "lastTextTs": last_text_ts,
        "editPaths": edit_paths, "prs": prs,
    })
}

/// 把 `<system-reminder>…</system-reminder>` 这类给模型看的附注剥掉 —— 那不是人说的话。
fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    // task-notification:后台任务结束时系统塞进对话的通知,是给模型看的,不是谁说的话
    for tag in ["system-reminder", "command-message", "command-args", "local-command-stdout", "task-notification"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let mut acc = String::new();
        while let Some(i) = rest.find(&open) {
            acc.push_str(&rest[..i]);
            match rest[i..].find(&close) {
                Some(j) => rest = &rest[i + j + close.len()..],
                None => { rest = ""; break; }
            }
        }
        acc.push_str(rest);
        out = acc;
        rest = Box::leak(out.clone().into_boxed_str());
    }
    out.trim().to_string()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n).collect::<String>() + "…" }
}

/// Codex 的全文(和 parse_transcript 一样的形状)。有 event_msg 就用它(那才是人和模型说的话),
/// 没有(老 CLI 格式)才从 response_item 里捡
fn codex_transcript(path: &Path) -> Vec<Value> {
    let text = codex_read(path);
    let (mut ev, mut ri): (Vec<Value>, Vec<Value>) = (vec![], vec![]);
    for line in text.lines() {
        let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
        let ts = d.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let p = d.get("payload").cloned().unwrap_or(Value::Null);
        let pt = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let row = |role: &str, kind: &str, text: String| json!({ "role": role, "kind": kind, "text": clip(&text, 60000), "ts": ts });
        let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if t == "event_msg" {
            match pt {
                "user_message" if !s("message").trim().is_empty() => ev.push(row("user", "text", s("message"))),
                "agent_message" if !s("message").trim().is_empty() => ev.push(row("assistant", "text", s("message"))),
                "exec_command_begin" => ev.push(row("assistant", "tool", format!("Shell  {}", clip(&codex_cmd(p.get("command")), 300)))),
                "patch_apply_begin" => ev.push(row("assistant", "tool", format!("Patch  {}", codex_patch_files(&p).join(", ")))),
                _ => {}
            }
        } else if t == "response_item" {
            match pt {
                "message" => {
                    let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
                    if role != "user" && role != "assistant" { continue; }
                    let txt = p.get("content").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|x| x.get("text").and_then(|v| v.as_str())).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                    if !txt.trim().is_empty() && !txt.trim_start().starts_with('<') { ri.push(row(role, "text", txt)); }
                }
                "function_call" => ri.push(row("assistant", "tool", format!("{}  {}", s("name"), clip(&s("arguments"), 300)))),
                _ => {}
            }
        }
    }
    if ev.iter().any(|r| r["kind"] == "text") { ev } else { ri }
}

// macOS's session_dock tests for the functions this port carries. The fourth,
// sd_git_only_counts_paths_inside_the_repo, is left behind with sd_git itself.
#[cfg(test)]
mod tests {
    use super::*;

    /// The one piece of this file written for Windows rather than copied:
    /// finding live Claude sessions from process command lines instead of
    /// `ps -axo args=`. The macOS tests cannot reach it, so this starts a real
    /// process whose command line carries a `--resume=<id>` marker and checks
    /// live_ids() sees it.
    ///
    /// PowerShell joins every argument after -Command into one script, so the
    /// trailing `#` turns the marker into a comment: the child just sleeps, but
    /// its command line — which is all live_ids reads — still contains the id.
    #[cfg(windows)]
    #[test]
    fn live_ids_finds_a_resume_id_on_a_real_command_line() {
        let id = "11111111-2222-3333-4444-555555555555";
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30; #"])
            .arg(format!("--resume={id}"))
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn powershell");
        // Let it appear in the process table before the (uncached) first scan.
        std::thread::sleep(std::time::Duration::from_secs(3));
        let found = live_ids();
        let _ = child.kill();
        let _ = child.wait();
        assert!(found.contains(id), "live_ids did not see the marker; found {} ids", found.len());
    }

    fn write_transcript(name: &str, lines: &[Value]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sd_test_{}_{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(&p, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        p
    }

    #[test]
    fn tail_state_reads_pending_question_pr_and_edits() {
        let now = chrono::Utc::now();
        let ts = |s: i64| (now - chrono::Duration::seconds(s)).to_rfc3339();
        let mut lines = vec![
            json!({"type":"user","timestamp":ts(300),"message":{"role":"user","content":"please fix it"}}),
            json!({"type":"assistant","timestamp":ts(290),"message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/repo/a.rs","old_string":"x","new_string":"y"}}]}}),
            json!({"type":"user","timestamp":ts(280),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}),
            json!({"type":"assistant","timestamp":ts(270),"message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"gh pr create"}}]}}),
            json!({"type":"user","timestamp":ts(260),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"https://github.com/o/r/pull/42\n"}]}}),
            json!({"type":"assistant","timestamp":ts(250),"message":{"role":"assistant","content":[
                {"type":"text","text":"Opened the PR."},
                {"type":"tool_use","id":"t3","name":"AskUserQuestion","input":{"questions":[{"question":"Merge now?","options":[{"label":"Yes"},{"label":"No"}]}]}}]}}),
        ];
        let v = tail_state(&write_transcript("ask", &lines));
        assert_eq!(v["state"], "ask");
        assert_eq!(v["ask"]["kind"], "question");
        assert_eq!(v["ask"]["text"], "Merge now?");
        assert_eq!(v["ask"]["options"], json!(["Yes", "No"]));
        assert_eq!(v["prs"], json!(["https://github.com/o/r/pull/42"]));
        assert_eq!(v["editPaths"], json!(["/repo/a.rs"]));
        let turn = v["turnStart"].as_i64().unwrap();
        assert!(turn > 0, "turnStart should come from the human prompt");
        assert!(v["lastTextTs"].as_i64().unwrap() > turn);

        // 回答之后就不再是"在问你"
        lines.push(json!({"type":"user","timestamp":ts(10),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t3","content":"Yes"}]}}));
        let v = tail_state(&write_transcript("answered", &lines));
        assert_ne!(v["state"], "ask");
        assert!(v["ask"].is_null());
        // 工具结果不算新的一轮
        assert_eq!(v["turnStart"].as_i64().unwrap(), turn);
    }

    #[test]
    fn find_prs_dedupes_and_trims() {
        let mut out = Vec::new();
        find_prs("see https://github.com/o/r/pull/7/files and (https://github.com/o/r/pull/7) or https://github.com/o/r/issues/3", &mut out);
        assert_eq!(out, vec!["https://github.com/o/r/pull/7".to_string()]);
    }


    #[test]
    fn codex_rollout_state_and_transcript() {
        let now = chrono::Utc::now();
        let ts = |s: i64| (now - chrono::Duration::seconds(s)).to_rfc3339();
        let ev = |s: i64, p: Value| json!({ "timestamp": ts(s), "type": "event_msg", "payload": p });
        let mut lines = vec![
            json!({ "timestamp": ts(100), "type": "session_meta", "payload": { "id": "x", "cwd": "/repo" } }),
            ev(90, json!({ "type": "user_message", "message": "fix the build" })),
            ev(89, json!({ "type": "task_started", "model_context_window": 272000 })),
            ev(80, json!({ "type": "exec_approval_request", "call_id": "c1", "command": ["bash", "-lc", "cargo build"] })),
        ];
        let p = write_transcript("codex_wait", &lines);
        let v = codex_state(&p);
        assert_eq!(v["state"], "tool");
        assert_eq!(v["waiting"], true);
        assert_eq!(v["tool"], "Shell");
        assert_eq!(v["arg"], "cargo build");

        lines.extend([
            ev(70, json!({ "type": "exec_command_begin", "call_id": "c1", "command": ["bash", "-lc", "cargo build"] })),
            ev(60, json!({ "type": "exec_command_end", "call_id": "c1", "exit_code": 0, "stdout": "ok" })),
            ev(50, json!({ "type": "patch_apply_begin", "call_id": "c2", "changes": { "/repo/src/a.rs": {} } })),
            ev(40, json!({ "type": "token_count", "info": { "last_token_usage": { "input_tokens": 12345 }, "model_context_window": 272000 } })),
            ev(30, json!({ "type": "agent_message", "message": "Done, see https://github.com/o/r/pull/9" })),
            ev(29, json!({ "type": "task_complete", "last_agent_message": "Done, see https://github.com/o/r/pull/9" })),
        ]);
        let p = write_transcript("codex_done", &lines);
        let v = codex_state(&p);
        assert_eq!(v["state"], "done");
        assert_eq!(v["waiting"], false);
        assert_eq!(v["ctx"], 12345);
        assert_eq!(v["ctxMax"], 272000);
        assert_eq!(v["editPaths"], json!(["/repo/src/a.rs"]));
        assert_eq!(v["prs"], json!(["https://github.com/o/r/pull/9"]));
        let tr = codex_transcript(&p);
        let kinds: Vec<(String, String)> = tr.iter().map(|r| (r["role"].as_str().unwrap().into(), r["kind"].as_str().unwrap().into())).collect();
        assert_eq!(kinds, vec![("user".into(), "text".into()), ("assistant".into(), "tool".into()), ("assistant".into(), "tool".into()), ("assistant".into(), "text".into())]);
        assert_eq!(tr[1]["text"], "Shell  cargo build");
    }
}
