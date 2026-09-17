//! 会话栏 —— 屏幕左边一条细线,鼠标一碰就展开成 Claude Desktop 那张会话列表;
//! 再停在某一条上,右边就铺开那段对话的全文。毛玻璃,不抢焦点。
//!
//! **列表从哪儿来**:不是我们自己拼的。Claude Desktop 把它侧栏里的每一段会话都存在
//! `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` 里 ——
//! 标题(`title`)就是侧栏上那一行字,`lastActivityAt` 就是它的排序。按这个排,顺序和
//! 你在 Desktop 里看到的**一模一样**(实测逐行对上)。
//!
//! **全文从哪儿来**:每条会话的 `cliSessionId` 对应 `~/.claude/projects/*/<id>.jsonl`,
//! 那是 Claude Code 自己逐行追加的记录。
//!
//! **"正在跑"怎么判断**:Desktop 为每个打开的会话起一个 `claude … --resume=<id>`
//! 进程。按 id 对 `ps` 的参数 —— 精确,不靠"最近几分钟动过"这种猜。
//!
//! ⚠ 这两个文件格式都是**内部格式**,Claude 升级可能改。所以这里每个字段都是
//! "有就用、没有就算了",读不懂的行直接跳过,绝不因为一行怪数据整张列表空掉。

use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// 此刻有进程在跑的会话(`--resume=<id>` 出现在某个进程的参数里)。
fn live_ids() -> HashSet<String> {
    let out = std::process::Command::new("ps").args(["-axo", "args="]).output();
    let mut set = HashSet::new();
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout);
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

/// 会话列表 —— 和 Claude Desktop 侧栏同一份数据、同一个顺序。
// (async):不带 async 的 Tauri 命令跑在**主线程**上。这里要跑 ps、读一百多个 JSON ——
// 每几秒一次堵住主线程,整个 app 所有窗口都会一顿一顿的(实测被强制退出过一次)。
#[tauri::command(async)]
pub fn sd_sessions() -> Vec<Value> {
    let root = home().join("Library/Application Support/Claude/claude-code-sessions");
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn sd_git_only_counts_paths_inside_the_repo() {
        let repo = env!("CARGO_MANIFEST_DIR");
        let mine = format!("{repo}/src/session_dock.rs");
        let v = sd_git(repo.to_string(), vec![mine.clone(), "/elsewhere/x.rs".into()]);
        assert!(!v["branch"].as_str().unwrap_or("").is_empty());
        for f in v["files"].as_array().unwrap() {
            assert!(f["path"].as_str().unwrap().ends_with("src/session_dock.rs"), "unexpected file {f}");
        }
        let none = sd_git(repo.to_string(), vec!["/elsewhere/x.rs".into()]);
        assert_eq!(none["files"], json!([]));
        assert_eq!(none["add"], 0);
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

/// 5 小时用量窗口 —— 和 ccusage 同一种切法:窗口从第一条消息所在的**整点**开始,持续 5 小时;
/// 超过 5 小时或中间断了 5 小时以上就开下一个窗口。按消息 id 去重(续接的会话会把历史复制
/// 进新文件)。token 数 = 输入 + 输出 + 写缓存,**不含读缓存**(读缓存不怎么占额度)。
///
/// Desktop 自己有一个 5 小时的总圆环,但看不出**是哪个会话在烧** —— 这里按会话拆开,
/// 外加最近 10 分钟的速度,会话栏用它画"每张卡往燃料条里流多少粒子"。
#[tauri::command(async)]
pub fn sd_usage() -> Value {
    use std::io::{Seek, SeekFrom};
    let now = chrono::Utc::now().timestamp_millis();
    let horizon = now - 10 * 3600 * 1000;
    let mut rows: Vec<(i64, String, i64)> = Vec::new(); // (时间, 会话 id, token)
    let mut seen = HashSet::new();
    let projects = home().join(".claude/projects");
    for dir in std::fs::read_dir(&projects).into_iter().flatten().flatten() {
        for f in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().map(|x| x != "jsonl").unwrap_or(true) {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            let recent = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64 > horizon).unwrap_or(false);
            if !recent {
                continue;
            }
            let sid = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let Ok(mut fh) = std::fs::File::open(&p) else { continue };
            // 只读最后 8MB:10 小时内的消息都在文件尾部
            let start = meta.len().saturating_sub(8 * 1024 * 1024);
            let _ = fh.seek(SeekFrom::Start(start));
            let mut buf = Vec::new();
            let _ = fh.read_to_end(&mut buf);
            let text = String::from_utf8_lossy(&buf);
            for line in text.lines() {
                if !line.contains("\"usage\"") {
                    continue;
                }
                let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
                let Some(msg) = d.get("message") else { continue };
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !id.is_empty() && !seen.insert(id) {
                    continue;
                }
                let Some(u) = msg.get("usage") else { continue };
                let g = |k: &str| u.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
                let tok = g("input_tokens") + g("output_tokens") + g("cache_creation_input_tokens");
                let ts = d.get("timestamp").and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|t| t.timestamp_millis()).unwrap_or(0);
                if ts > horizon && tok > 0 {
                    rows.push((ts, sid.clone(), tok));
                }
            }
        }
    }
    rows.sort_by_key(|r| r.0);
    const H: i64 = 3600 * 1000;
    let mut block_start: i64 = 0;
    let mut last_ts: i64 = 0;
    let mut cur: Vec<&(i64, String, i64)> = Vec::new();
    for r in &rows {
        if block_start == 0 || r.0 >= block_start + 5 * H || r.0 - last_ts > 5 * H {
            block_start = r.0 - r.0.rem_euclid(H);
            cur.clear();
        }
        cur.push(r);
        last_ts = r.0;
    }
    if block_start == 0 || now >= block_start + 5 * H {
        return json!({ "active": false, "total": 0, "perSession": {}, "ratePerMin": 0 });
    }
    let mut per: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut per_recent: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut total = 0;
    let mut recent = 0;
    for r in &cur {
        total += r.2;
        *per.entry(r.1.clone()).or_default() += r.2;
        if r.0 > now - 10 * 60 * 1000 {
            recent += r.2;
            *per_recent.entry(r.1.clone()).or_default() += r.2;
        }
    }
    json!({
        "active": true,
        "start": block_start,
        "resetAt": block_start + 5 * H,
        "total": total,
        "perSession": per,
        "recentPerSession": per_recent,
        "ratePerMin": recent / 10,
    })
}

/// 跳到 Claude Desktop 里**这一段**会话(在它的侧栏里按标题找到那一行按下去)。
/// Claude Desktop 没有打开某段会话的 URL scheme,只能这样;找不到就只把 Claude 调到前台。
#[tauri::command(async)]
pub fn sd_jump(title: String) -> Value {
    let r = crate::desk::call_desk(json!({ "cmd": "claudeJump", "title": title }), 5)
        .unwrap_or_else(|e| json!({ "ok": false, "error": e }));
    eprintln!("[dock] jump \"{title}\" -> {r}");
    if r.get("ok").and_then(|b| b.as_bool()) != Some(true) { let _ = sd_open_claude(); }
    r
}

/// 往这一段会话里发一句话(继续 / 压缩 / 用户自己打的字)。
/// 必须先在侧栏里按标题找到它 —— 找不到就**不发**(发进别的会话比不发糟得多)。
#[tauri::command(async)]
pub fn sd_send(title: String, text: String) -> Value {
    remember_front();
    let mut r = crate::desk::call_desk(json!({ "cmd": "claudeSend", "title": title, "text": text }), 9)
        .unwrap_or_else(|e| json!({ "ok": false, "error": e }));
    // 发完切回你原来的窗口(没找到会话、没发出去也切 —— Claude 已经被调到前面了)
    let back = restore_front();
    if let Some(o) = r.as_object_mut() { o.insert("restored".into(), json!(back)); }
    eprintln!("[dock] send \"{title}\" ({} chars) -> {r}", text.chars().count());
    r
}

/// 叫这一段会话停下(按它的 Stop 按钮;找不到就 Esc)
#[tauri::command(async)]
pub fn sd_stop(title: String) -> Value {
    remember_front();
    let mut r = crate::desk::call_desk(json!({ "cmd": "claudeStop", "title": title }), 7)
        .unwrap_or_else(|e| json!({ "ok": false, "error": e }));
    let back = restore_front();
    if let Some(o) = r.as_object_mut() { o.insert("restored".into(), json!(back)); }
    eprintln!("[dock] stop \"{title}\" -> {r}");
    r
}

/// 会话状态变了(需要你 / 做完了 / 出错了):响一声 + 系统通知(和 Vibe Island 一样的思路 ——
/// 人不盯着屏幕的时候,是声音把人叫回来的)。
#[tauri::command(async)]
pub fn sd_alert(app: tauri::AppHandle, kind: String, title: String, body: String) {
    let sound = match kind.as_str() { "need" => "Glass", "error" => "Basso", _ => "Hero" };
    let _ = std::process::Command::new("afplay").arg(format!("/System/Library/Sounds/{sound}.aiff")).spawn();
    let severity = if kind == "error" { "warn" } else { "info" };
    let head = match kind.as_str() { "need" => "需要你", "error" => "出错了", _ => "做完了" };
    crate::notifications::notify(&app, "session", &format!("{head} · {title}"), &body, severity,
        &format!("dock|{kind}|{title}"), None);
}

/// 回复框要打字:让会话栏窗口临时成为焦点窗口(平时它从不抢焦点)
#[tauri::command]
pub fn sd_focus_input(app: tauri::AppHandle) {
    use tauri::Manager;
    remember_front(); // 抢焦点之前记住你在用哪个 app,发完切回去
    if let Some(w) = app.get_webview_window("sessions-dock") { let _ = w.set_focus(); }
}

/// 把 Claude Desktop 调到前台。Desktop 没有"打开某一段会话"的链接方式(文档里没有 URL scheme),
/// 所以只能到这一步 —— 按钮上也照实写"打开 Claude",不假装能跳到那一条。
#[tauri::command(async)]
pub fn sd_open_claude() -> Result<(), String> {
    std::process::Command::new("open").args(["-a", "Claude"]).status().map(|_| ()).map_err(|e| e.to_string())
}

/* ── Codex(OpenAI Codex.app / codex CLI)──────────────────────────────────
 * 列表:~/.codex/state_N.sqlite 的 threads 表(标题、cwd、分支、模型、rollout_path)—— Codex 自己的索引。
 * 在跑:Codex 进程此刻**开着**的 rollout 文件(lsof,精确)。lsof 看不到时退一步:有 Codex 进程、
 *       rollout 5 分钟内写过 → 也算在跑,但标 liveGuess(界面照实说是按最近写入判断的)。
 * 状态 / 全文:rollout JSONL(session_meta / event_msg / response_item),.jsonl.zst 先解压。
 * ⚠ 没核实到 Codex 有 Claude 那种能答题 / 送话的钩子 → Codex 会话在会话栏里能看、能跳过去(codex://threads/<id>),不直控。 */
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
        return std::process::Command::new(z).arg("-dc").arg(p).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
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
    let running = std::process::Command::new("pgrep").args(["-i", "codex"]).output().map(|o| !o.stdout.is_empty()).unwrap_or(false);
    let mut open = HashSet::new();
    if running {
        if let Ok(o) = std::process::Command::new("lsof").args(["-Fn", "-c", "/codex/i"]).output() {
            for l in String::from_utf8_lossy(&o.stdout).lines() {
                if let Some(p) = l.strip_prefix('n') {
                    if p.contains("/.codex/sessions/") && p.contains("rollout-") { open.insert(p.to_string()); }
                }
            }
        }
    }
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
/// 在 Codex 里打开这一段(Codex.app 注册了 codex://threads/<id>);打不开就只把 Codex 调到前面
#[tauri::command(async)]
pub fn sd_codex_open(id: String) -> Value {
    let tid = id.trim_start_matches(CODEX_PREFIX);
    if tid.is_empty() || !tid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return json!({ "ok": false, "error": "bad_id" });
    }
    let ok = std::process::Command::new("open").arg(format!("codex://threads/{tid}")).status().map(|s| s.success()).unwrap_or(false);
    if !ok { let _ = std::process::Command::new("open").args(["-b", "com.openai.codex"]).status(); }
    json!({ "ok": ok })
}

/* ── 这段会话的改动 ────────────────────────────────────────────────────────
 * 只算**它自己改过的那些文件**里还没提交的部分 —— 不是整个分支的 diff。
 * (Claude Desktop 侧栏的 +N −M 是分支 diff,几个会话共用一个仓库时每条都一样,
 *  anthropics/claude-code#46294 就是在抱怨这个。) */
fn git(dir: &str, args: &[&str]) -> Option<String> {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}
/// (仓库根, 分支, 仓库里的那些路径)—— 仓库外的路径交给 git 会让整条命令失败,先滤掉
fn repo_paths(cwd: &str, paths: &[String]) -> Option<(String, String, Vec<String>)> {
    if !Path::new(cwd).is_dir() {
        return None;
    }
    let top = git(cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let mut ps: Vec<String> = paths.iter().filter(|p| p.starts_with(&format!("{top}/"))).cloned().collect();
    ps.dedup();
    ps.truncate(200);
    Some((top, branch, ps))
}
fn untracked(top: &str, ps: &[String]) -> HashSet<String> {
    let mut a = vec!["ls-files", "--others", "--exclude-standard", "--full-name", "--"];
    a.extend(ps.iter().map(|s| s.as_str()));
    git(top, &a).map(|s| s.lines().map(|l| format!("{top}/{l}")).collect()).unwrap_or_default()
}
fn line_count(p: &str) -> i64 {
    std::fs::metadata(p).ok().filter(|m| m.len() < 4 << 20)
        .and_then(|_| std::fs::read(p).ok()).map(|b| b.iter().filter(|c| **c == b'\n').count() as i64).unwrap_or(0)
}

/// 分支 + 这段会话改过的文件里还没提交的 +/−。会话栏每 10 秒左右问一次每条会话,缓存 8 秒。
#[tauri::command(async)]
pub fn sd_git(cwd: String, paths: Vec<String>) -> Value {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, (std::time::Instant, Value)>>> = OnceLock::new();
    let key = format!("{cwd}\n{}", paths.join("\n"));
    let cache = CACHE.get_or_init(|| Mutex::new(Default::default()));
    if let Some((t, v)) = cache.lock().unwrap().get(&key) {
        if t.elapsed().as_secs() < 8 {
            return v.clone();
        }
    }
    let Some((top, branch, ps)) = repo_paths(&cwd, &paths) else { return json!({}) };
    let (mut add, mut del) = (0i64, 0i64);
    let mut files: Vec<Value> = Vec::new();
    if !ps.is_empty() {
        let mut a = vec!["diff", "--numstat", "HEAD", "--"];
        a.extend(ps.iter().map(|s| s.as_str()));
        for l in git(&top, &a).unwrap_or_default().lines() {
            let mut it = l.splitn(3, '\t');
            let (x, y, p) = (it.next().unwrap_or("0"), it.next().unwrap_or("0"), it.next().unwrap_or(""));
            let (x, y) = (x.parse::<i64>().unwrap_or(0), y.parse::<i64>().unwrap_or(0));
            add += x;
            del += y;
            files.push(json!({ "path": p, "add": x, "del": y }));
        }
        for p in untracked(&top, &ps) {
            let n = line_count(&p);
            add += n;
            files.push(json!({ "path": p.trim_start_matches(&format!("{top}/")), "add": n, "del": 0, "new": true }));
        }
    }
    let v = json!({ "branch": branch, "add": add, "del": del, "files": files, "root": top });
    let mut c = cache.lock().unwrap();
    if c.len() > 64 { c.clear(); }
    c.insert(key, (std::time::Instant::now(), v.clone()));
    v
}

/// 预览里"改动"那一页:这段会话改过的文件的未提交 diff(每个文件最多 160 行,总共最多 700 行)
#[tauri::command(async)]
pub fn sd_diff(cwd: String, paths: Vec<String>) -> Value {
    let Some((top, _, ps)) = repo_paths(&cwd, &paths) else { return json!({ "files": [] }) };
    if ps.is_empty() {
        return json!({ "files": [] });
    }
    let mut a = vec!["diff", "HEAD", "--no-color", "--no-ext-diff", "-U2", "--"];
    a.extend(ps.iter().map(|s| s.as_str()));
    let text = git(&top, &a).unwrap_or_default();
    let mut files: Vec<Value> = Vec::new();
    let mut cur: Option<(String, Vec<String>, i64, i64)> = None;
    let mut total = 0usize;
    let flush = |cur: &mut Option<(String, Vec<String>, i64, i64)>, files: &mut Vec<Value>| {
        if let Some((p, ls, x, y)) = cur.take() {
            files.push(json!({ "path": p, "add": x, "del": y, "lines": ls }));
        }
    };
    for l in text.lines() {
        if l.starts_with("diff --git ") {
            flush(&mut cur, &mut files);
            let p = l.rsplit(" b/").next().unwrap_or("").to_string();
            cur = Some((p, Vec::new(), 0, 0));
            continue;
        }
        let Some(c) = cur.as_mut() else { continue };
        if l.starts_with("+++") || l.starts_with("---") || l.starts_with("index ") || l.starts_with("new file") || l.starts_with("deleted file") || l.starts_with("similarity") || l.starts_with("rename ") || l.starts_with("old mode") || l.starts_with("new mode") {
            continue;
        }
        if l.starts_with('+') { c.2 += 1 } else if l.starts_with('-') { c.3 += 1 }
        if c.1.len() < 160 && total < 700 {
            c.1.push(clip(l, 220));
            total += 1;
        }
    }
    flush(&mut cur, &mut files);
    for p in untracked(&top, &ps) {
        let body = std::fs::read_to_string(&p).unwrap_or_default();
        let ls: Vec<String> = body.lines().take(80).map(|l| format!("+{}", clip(l, 220))).collect();
        files.push(json!({ "path": p.trim_start_matches(&format!("{top}/")), "add": body.lines().count(), "del": 0, "new": true, "lines": ls }));
    }
    json!({ "files": files })
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

/// 解析过的全文缓存:按 (文件大小, 修改时间) 认。
///
/// 预览每 3 秒刷一次,而一份 JSONL 动辄 6–7MB。**要显示全部历史**就得读整份文件,
/// 但没理由每 3 秒整份重读 —— 文件没变就直接用上次的结果,变了再解析。
static TRANSCRIPT_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, u128, std::sync::Arc<Vec<Value>>)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 这一行里的图算不算进编号。parse_transcript 和 sd_image **共用这一个判断**。
fn counts_for_images(d: &Value) -> bool {
    let flag = |k: &str| d.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    if flag("isSidechain") || flag("isCompactSummary") || flag("isMeta") {
        return false;
    }
    matches!(d.get("type").and_then(|v| v.as_str()), Some("user") | Some("assistant"))
}

fn parse_transcript(path: &Path) -> Vec<Value> {
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    let mut buf = String::new();
    // **整份读**。用户要的是"所有的对话历史",不是尾巴上那几百 KB ——
    // 第一版只读最后 900KB,长会话的前半段根本看不到。
    let _ = f.read_to_string(&mut buf);
    let mut out: Vec<Value> = Vec::new();
    let mut img_n: usize = 0; // 文件里第几张图 —— sd_image 按这个编号去取
    for line in buf.lines() {
        let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
        if d.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue; // 子 agent 的旁支,不是这段对话本身
        }
        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = d.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // 上下文被压缩过的地方留一条分隔线 —— 那是真实发生过的事,藏起来会让人以为
        // 对话在那儿断了一截。
        if d.get("isCompactSummary").and_then(|v| v.as_bool()).unwrap_or(false) {
            out.push(json!({ "role": "system", "kind": "divider", "text": "上下文已压缩 · 之前的内容仍在上面", "ts": ts }));
            continue;
        }
        if d.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        if t != "user" && t != "assistant" {
            continue;
        }
        let content = d.get("message").and_then(|m| m.get("content"));
        let mut push = |kind: &str, text: String| {
            let text = if kind == "tool" || kind == "image" { text } else { strip_tags(&text) };
            if !text.is_empty() {
                // 上限只是防一条几十万字的怪消息把界面卡死,正常对话一个字都不截
                out.push(json!({ "role": t, "kind": kind, "text": clip(&text, 60000), "ts": ts }));
            }
        };
        match content {
            Some(Value::String(s)) => push("text", s.clone()),
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    match b.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "text" => push("text", b.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                        "image" => {
                            // 图片不内联进 transcript(一张截图 base64 就是几百 KB,整段对话
                            // 塞进一次 IPC 会卡住预览)。只给一个编号,前端需要时再单独要。
                            push("image", format!("img:{img_n}"));
                            img_n += 1;
                        }
                        "tool_use" => {
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                            let inp = b.get("input");
                            let arg = ["description", "command", "file_path", "pattern", "url", "query", "prompt"]
                                .iter()
                                .find_map(|k| inp.and_then(|i| i.get(*k)).and_then(|v| v.as_str()))
                                .unwrap_or("");
                            push("tool", format!("{name}  {}", clip(arg, 300)));
                        }
                        _ => {} // thinking / tool_result:不是对话本身
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// 一段会话的**全部**历史。`limit` 只在调用方明确要少的时候才截。
#[tauri::command(async)]
pub fn sd_transcript(id: String, limit: Option<usize>) -> Vec<Value> {
    if let Some(tid) = id.strip_prefix(CODEX_PREFIX) {
        let Some(p) = codex_threads().into_iter().find(|t| t["id"] == tid).and_then(|t| codex_rollout(t["rollout"].as_str()?)) else { return Vec::new() };
        let all = codex_transcript(&p);
        let skip = all.len().saturating_sub(limit.unwrap_or(usize::MAX));
        return all.into_iter().skip(skip).collect();
    }
    let Some(path) = find_transcript(&id) else { return Vec::new() };
    let meta = std::fs::metadata(&path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta.and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos()).unwrap_or(0);
    let cached = TRANSCRIPT_CACHE.lock().ok()
        .and_then(|c| c.get(&path).filter(|(s, m, _)| *s == size && *m == mtime).map(|(_, _, v)| v.clone()));
    let all = match cached {
        Some(v) => v,
        None => {
            let v = std::sync::Arc::new(parse_transcript(&path));
            if let Ok(mut c) = TRANSCRIPT_CACHE.lock() {
                if c.len() > 24 { c.clear(); } // 只留最近看过的几段,别无限长
                c.insert(path.clone(), (size, mtime, v.clone()));
            }
            v
        }
    };
    let n = limit.unwrap_or(usize::MAX);
    let skip = all.len().saturating_sub(n);
    all.iter().skip(skip).cloned().collect()
}

/// 取对话里第 `n` 张图,缩到长边 ≤560px、重编成 JPEG,返回 data URL。
///
/// 为什么要缩:粒子只需要几百像素宽的底图 —— 一张 3MB 的截图原样过 IPC、原样解码,
/// 每次 hover 都要卡一下,换来的清晰度粒子根本表达不出来。
static IMAGE_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<(PathBuf, usize), String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[tauri::command(async)]
pub fn sd_image(id: String, n: usize) -> Option<String> {
    use base64::Engine;
    let path = find_transcript(&id)?;
    if let Some(v) = IMAGE_CACHE.lock().ok().and_then(|c| c.get(&(path.clone(), n)).cloned()) {
        return Some(v);
    }
    let buf = std::fs::read_to_string(&path).ok()?;
    let mut seen = 0usize;
    for line in buf.lines() {
        if !line.contains("\"image\"") {
            continue;
        }
        let Ok(d) = serde_json::from_str::<Value>(line) else { continue };
        // ⚠ 跳过规则必须和 parse_transcript **一字不差**。编号是"第几张图",两边只要有一边
        // 多数或少数了一行,之后每一张图都会张冠李戴 —— 而且不会报错,只是显示错的图。
        if !counts_for_images(&d) {
            continue;
        }
        let Some(Value::Array(blocks)) = d.get("message").and_then(|m| m.get("content")) else { continue };
        for b in blocks {
            if b.get("type").and_then(|v| v.as_str()) != Some("image") {
                continue;
            }
            if seen == n {
                let src = b.get("source");
                let data = src.and_then(|s| s.get("data")).and_then(|v| v.as_str())?;
                let media = src.and_then(|s| s.get("media_type")).and_then(|v| v.as_str()).unwrap_or("image/png");
                /* 先缩小再过 IPC。解不开的时候**把原图直接交出去**,而不是返回空 ——
                   实测这段会话里前两张是 WebP,当时 image crate 只开了 jpeg/png,解码失败,
                   sd_image 返回 None,会话栏里那两张图就永远停在"加载中"。
                   webview 自己认得 webp/png/jpeg/gif,原图大一点,但总比一个永远的占位好。 */
                let thumb = base64::engine::general_purpose::STANDARD.decode(data).ok()
                    .and_then(|bytes| image::load_from_memory(&bytes).ok())
                    .and_then(|img| {
                        let rgb = img.thumbnail(560, 560).to_rgb8();
                        let mut out = Vec::new();
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
                            .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8).ok()?;
                        Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out)))
                    });
                let url = match thumb {
                    Some(u) => u,
                    None if media.starts_with("image/") && data.len() < 8_000_000 => format!("data:{media};base64,{data}"),
                    None => return None,
                };
                if let Ok(mut c) = IMAGE_CACHE.lock() {
                    if c.len() > 64 { c.clear(); }
                    c.insert((path.clone(), n), url.clone());
                }
                return Some(url);
            }
            seen += 1;
        }
    }
    None
}

/// 会话栏的状态。宽度、展开与否由 **Rust 这边**说了算,不是网页。
///
/// ⚠ 为什么不让网页自己管 hover:这个窗口**永远不会是焦点窗口**(它不能抢你正在用的
/// app 的焦点),而 macOS 上非焦点窗口里的 WKWebView 收不到鼠标移动事件 —— 第一版就是
/// 这么死的:窗口在,10px 宽,鼠标怎么碰都不展开。真机探针测出来 w 一直是 10。
/// 所以改成原生轮询全局光标位置(NSEvent.mouseLocation,不要任何权限),边缘判断在这儿做,
/// 光标在栏里的位置再以 `sd-mouse` 事件发给网页,网页只负责"哪一行被指着"。
struct Dock {
    mode: String,
    top: f64,
    h: f64,
    sw: f64,
    sh: f64,
    /// 从粒子页"打开会话栏"时:在人第一次移进来之前不收起,免得还没够到就没了
    pinned_until: Option<std::time::Instant>,
    entered: bool,
    outside_since: Option<std::time::Instant>,
    last: (i32, i32),
}

static DOCK: std::sync::LazyLock<std::sync::Mutex<Dock>> = std::sync::LazyLock::new(|| {
    std::sync::Mutex::new(Dock { mode: "strip".into(), top: 34.0, h: 800.0, sw: 1440.0, sh: 900.0,
        pinned_until: None, entered: false, outside_since: None, last: (-1, -1) })
});

fn width_of(mode: &str, sw: f64) -> f64 {
    match mode {
        // 2026-09 全粒子版:列表 400(卡片里要放命令和按钮),预览再往右 560;收起是 14 宽的状态珠轨
        "list" => 400.0,
        "preview" => (400.0 + 560.0f64).min(sw - 20.0),
        _ => 14.0,
    }
}

/// 主屏的可见区域(不含菜单栏、程序坞),换成"从屏幕顶往下量"的 (上沿, 下沿)
#[cfg(target_os = "macos")]
fn visible_band() -> Option<(f64, f64)> {
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil};
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        let screens: id = NSScreen::screens(nil);
        if screens == nil { return None; }
        let n: u64 = msg_send![screens, count];
        if n == 0 { return None; }
        let s: id = msg_send![screens, objectAtIndex: 0u64];
        let f = NSScreen::frame(s);
        let vf = NSScreen::visibleFrame(s);
        let full = f.size.height;
        if full <= 0.0 || vf.size.height <= 0.0 { return None; }
        Some((full - (vf.origin.y + vf.size.height), full - vf.origin.y))
    }
}

/* 走辅助功能往 Claude 里打字时,Claude 会被调到前面。发之前记住你原来在用哪个 app(不算 Terse 自己 ——
 * 在会话栏里打字时 Terse 临时是焦点),发完立刻切回去:Claude 只闪不到一秒,手上的窗口不被抢走。 */
static FRONT_APP: std::sync::Mutex<i32> = std::sync::Mutex::new(0);
#[cfg(target_os = "macos")]
fn frontmost_pid() -> i32 {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let a: id = msg_send![ws, frontmostApplication];
        if a == nil { return 0; }
        msg_send![a, processIdentifier]
    }
}
#[cfg(not(target_os = "macos"))]
fn frontmost_pid() -> i32 { 0 }
fn remember_front() {
    let p = frontmost_pid();
    if p > 0 && p != std::process::id() as i32 {
        if let Ok(mut f) = FRONT_APP.lock() { *f = p; }
    }
}
/// 切回发送前的那个 app;返回有没有切。
/// (NSRunningApplication.activate 只是给窗口服务器发个请求,不必在主线程 —— 所以这里不要 AppHandle,
///  sd_send 的签名保持不变:room_link.rs 也直接调它)
fn restore_front() -> bool {
    let pid = FRONT_APP.lock().map(|f| *f).unwrap_or(0);
    if pid <= 0 { return false; }
    #[cfg(target_os = "macos")]
    unsafe {
        use cocoa::base::{id, nil, BOOL};
        use objc::{class, msg_send, sel, sel_impl};
        let ra: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if ra == nil { return false; }
        let _: BOOL = msg_send![ra, activateWithOptions: 2u64]; // ActivateIgnoringOtherApps
        return true;
    }
    #[allow(unreachable_code)]
    false
}

fn ensure_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("sessions-dock") {
        return Ok(w);
    }
    let (sw, sh) = match app.primary_monitor() {
        Ok(Some(m)) => { let s = m.scale_factor(); (m.size().width as f64 / s, m.size().height as f64 / s) }
        _ => (1440.0, 900.0),
    };
    // 高度只到**可见区域**(去掉菜单栏和程序坞)为止:原来按整块屏幕算,窗口底部压在程序坞后面,
    // 预览最下面的回复框经常看不到(用户反馈)
    #[allow(unused_mut)]
    let (mut top, mut h) = (34.0, (sh - 34.0 - 12.0).max(300.0));
    #[cfg(target_os = "macos")]
    if let Some((vis_top, vis_bottom)) = visible_band() {
        top = vis_top + 9.0;
        h = (vis_bottom - 10.0 - top).max(300.0);
    }
    if let Ok(mut d) = DOCK.lock() { d.top = top; d.h = h; d.sw = sw; d.sh = sh; }
    let win = WebviewWindowBuilder::new(app, "sessions-dock", WebviewUrl::App("session-dock.html".into()))
        .title("Terse Sessions")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .visible_on_all_workspaces(true)
        .inner_size(14.0, h)
        .position(0.0, top)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        // 2026-09:窗口 **100% 透明** —— 不再加毛玻璃(NSVisualEffectView)。桌面上只剩粒子字;
        // 可读性靠每个粒子字自带的暗色光晕和卡片自己的粒子淡底(pdock-engine.js 的 raster)。
        use cocoa::base::{id, NO};
        use objc::{class, msg_send, sel, sel_impl};
        if let Ok(ptr) = win.ns_window() {
            let ns: id = ptr as id;
            unsafe {
                let _: () = msg_send![ns, setLevel: 3i64];
                let _: () = msg_send![ns, setCollectionBehavior: ((1u64 << 0) | (1u64 << 8))];
                let _: () = msg_send![ns, setOpaque: NO];
                let clear: id = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![ns, setBackgroundColor: clear];
                /* 玻璃要**尽量透**:HudWindow 材质本身偏厚,把它那层 NSVisualEffectView 的
                   不透明度降到 0.62 —— 还有模糊,但看得见后面的东西。字的可读性不靠玻璃,
                   靠每个粒子字自带的暗色光晕(pdock-engine.js 的 raster)。 */
                use cocoa::base::{BOOL, YES};
                let content: id = msg_send![ns, contentView];
                let subs: id = msg_send![content, subviews];
                let n: usize = msg_send![subs, count];
                for i in 0..n {
                    let v: id = msg_send![subs, objectAtIndex: i];
                    let is_fx: BOOL = msg_send![v, isKindOfClass: class!(NSVisualEffectView)];
                    if is_fx == YES {
                        let _: () = msg_send![v, setAlphaValue: 0.62f64];
                    }
                }
            }
        }
    }
    Ok(win)
}

/// 真正改窗口大小 + 告诉网页现在是哪种状态。
fn apply(app: &tauri::AppHandle, mode: &str) {
    use tauri::Emitter;
    let Ok(win) = ensure_window(app) else { return };
    let (top, h, sw) = DOCK.lock().map(|d| (d.top, d.h, d.sw)).unwrap_or((34.0, 800.0, 1440.0));
    let w = width_of(mode, sw);
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
    let _ = win.set_position(tauri::LogicalPosition::new(0.0, top));
    let _ = win.show();
    let _ = app.emit("sd-state", json!({ "mode": mode }));
}

/// 网页要求换状态(比如停在某一行上 → preview)。
#[tauri::command]
pub fn sd_dock(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    ensure_window(&app)?;
    if let Ok(mut d) = DOCK.lock() { d.mode = mode.clone(); }
    apply(&app, &mode);
    Ok(())
}

/// 从粒子页点"打开会话栏":展开,并且**在人移进来之前不收起**(最多 10 秒)。
#[tauri::command]
pub fn sd_dock_open(app: tauri::AppHandle) -> Result<(), String> {
    ensure_window(&app)?;
    if let Ok(mut d) = DOCK.lock() {
        d.mode = "list".into();
        d.entered = false;
        d.outside_since = None;
        d.pinned_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(10));
    }
    apply(&app, "list");
    Ok(())
}

#[tauri::command]
pub fn sd_dock_hide(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("sessions-dock") {
        let _ = w.hide();
    }
}

/// 全局光标位置(左上原点、逻辑坐标)。
#[cfg(target_os = "macos")]
fn cursor(sh: f64) -> (f64, f64) {
    use cocoa::appkit::NSEvent;
    let p = unsafe { NSEvent::mouseLocation(cocoa::base::nil) };
    (p.x, sh - p.y) // NSEvent 是左下原点
}
#[cfg(not(target_os = "macos"))]
fn cursor(_sh: f64) -> (f64, f64) { (1e9, 1e9) }

/// 开机就起:建出那条细线,然后每 50ms 看一眼光标。
pub fn start(app: tauri::AppHandle) {
    let _ = ensure_window(&app).map(|_| apply(&app, "strip"));
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        use tauri::Emitter;
        let (mode, top, h, sw, sh) = match DOCK.lock() {
            Ok(d) => (d.mode.clone(), d.top, d.h, d.sw, d.sh),
            Err(_) => continue,
        };
        let (mx, my) = cursor(sh);
        let in_y = my >= top && my <= top + h;
        let w = width_of(&mode, sw);
        let now = std::time::Instant::now();
        if mode == "strip" {
            // 贴到屏幕最左边那几像素就展开 —— 和 Dock 的"碰到边缘就出来"是同一个手感
            if mx <= 4.0 && in_y {
                if let Ok(mut d) = DOCK.lock() { d.mode = "list".into(); d.entered = true; d.outside_since = None; d.pinned_until = None; }
                apply(&app, "list");
            }
            continue;
        }
        let inside = mx >= 0.0 && mx <= w && in_y;
        let mut collapse = false;
        if let Ok(mut d) = DOCK.lock() {
            if inside {
                d.entered = true;
                d.outside_since = None;
                let cur = (mx as i32, (my - top) as i32);
                if cur != d.last {
                    d.last = cur;
                    let _ = app.emit("sd-mouse", json!({ "x": mx, "y": my - top, "inside": true }));
                }
            } else {
                let pinned = !d.entered && d.pinned_until.map(|t| now < t).unwrap_or(false);
                if !pinned {
                    let since = *d.outside_since.get_or_insert(now);
                    // 留 450ms:鼠标从列表滑去预览的那一下会短暂擦过边界,立刻收起的话,
                    // 人永远够不到右边那一栏
                    if now.duration_since(since) > std::time::Duration::from_millis(450) {
                        d.mode = "strip".into();
                        d.outside_since = None;
                        d.last = (-1, -1);
                        collapse = true;
                    }
                }
            }
        }
        if collapse {
            let _ = app.emit("sd-mouse", json!({ "inside": false }));
            apply(&app, "strip");
        }
    });
}
