//! 会话栏「直控」—— 在会话栏里直接回答提问、批准 / 打回计划、给在跑的会话发话、叫它停下,
//! 不用切到 Claude 去点。靠的是 Claude Code 自己的钩子(~/.claude/settings.json):
//!
//!   PreToolUse → POST 127.0.0.1:47823/terse-dock/pre
//!       每次调用工具之前问一下 Terse:有没有要交给这段会话的东西?
//!         · 排队的「停下」 → 拒绝这次调用 + continue:false,这一轮结束
//!         · 排队的话       → additionalContext,模型在这一步就读到
//!         · AskUserQuestion / ExitPlanMode → 在这里**等**你在会话栏里答(最多 ASK_WAIT),
//!           答案经 updatedInput.answers 填回去(Agent SDK 答题就是这个格式);超时 / 你点了
//!           「在 Claude 里答」→ 什么都不回,Claude 自己的界面照常出来
//!         · 其它 → 立刻回空
//!   Stop → POST 127.0.0.1:47823/terse-dock/stop
//!       它刚停下的那一刻:有排队的话 → decision:block + reason = 你的话,它接着干
//!
//! 钩子本身就是一行 curl:Terse 没开 → 连不上 → 什么都不输出 → Claude 照常。所以装着它是安全的,
//! Terse 启动时自动装(用户要求"一键 / 自动"),会话栏里有开关可以关。
//!
//! ⚠ Claude Code 在会话**启动时**读钩子:装上之前就开着的会话要重开一次才生效。
//!   "这段会话能不能直控" = 它的钩子来过没有(`seen`,存盘,Terse 重启也记得)。
//! ⚠ 已经完全停下的会话,没有任何钩子会触发 —— 那种只能走辅助功能(sd_send)。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const DOCK_PORT: u16 = 47823;
/// 等你在会话栏里回答的最长时间。这段时间里 Claude 自己的提问界面**不会**出来(钩子还没返回),
/// 所以不能太长;会话栏会响铃 + 系统通知把人叫过来。
const ASK_WAIT: Duration = Duration::from_secs(120);
const MARK: &str = "/terse-dock/";

struct Ask {
    sid: String,
    payload: Value,
    tx: Sender<Value>,
}
struct Queued {
    id: String,
    kind: String, // "msg" | "stop"
    text: String,
}
#[derive(Default)]
struct Hub {
    queue: HashMap<String, Vec<Queued>>,
    asks: HashMap<String, Ask>,
    /// sessionId → 钩子最近一次来的时间(毫秒)。有 = 这段会话装着钩子、能直控
    seen: HashMap<String, i64>,
}
fn hub() -> &'static Mutex<Hub> {
    static H: OnceLock<Mutex<Hub>> = OnceLock::new();
    H.get_or_init(|| {
        let seen = std::fs::read_to_string(seen_path()).ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, i64>>(&s).ok()).unwrap_or_default();
        Mutex::new(Hub { seen, ..Default::default() })
    })
}
fn lock() -> std::sync::MutexGuard<'static, Hub> {
    hub().lock().unwrap_or_else(|e| e.into_inner())
}
fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}
fn seen_path() -> PathBuf {
    home().join(".terse").join("dock-hooked.json")
}
fn off_flag() -> PathBuf {
    home().join(".terse").join("dock-direct-off")
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn new_id() -> String {
    format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0))
}

pub fn enabled() -> bool {
    !off_flag().exists()
}

/* ── 本机 HTTP(只绑 127.0.0.1,一条路由一个方法,不值得引一个框架) ── */
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let path = line.split_whitespace().nth(1)?.to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 { break; }
        let h = h.trim_end();
        if h.is_empty() { break; }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; len.min(8 << 20)];
    r.read_exact(&mut body).ok()?;
    Some((path, String::from_utf8_lossy(&body).to_string()))
}
fn respond(stream: &mut TcpStream, body: &str) {
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.flush();
}

fn take(sid: &str, kind: &str) -> Vec<Queued> {
    let mut h = lock();
    let Some(q) = h.queue.get_mut(sid) else { return vec![] };
    let (mine, rest): (Vec<Queued>, Vec<Queued>) = q.drain(..).partition(|x| x.kind == kind);
    *q = rest;
    mine
}
fn note_seen(sid: &str) {
    if sid.is_empty() { return; }
    let mut h = lock();
    let first = !h.seen.contains_key(sid);
    h.seen.insert(sid.to_string(), now_ms());
    if first {
        // 只在第一次见到时写盘(每次工具调用都写就是热路径上的磁盘 IO)
        if h.seen.len() > 400 {
            let mut v: Vec<(String, i64)> = h.seen.iter().map(|(k, t)| (k.clone(), *t)).collect();
            v.sort_by_key(|x| -x.1);
            h.seen = v.into_iter().take(300).collect();
        }
        if let Ok(s) = serde_json::to_string(&h.seen) {
            let _ = std::fs::create_dir_all(home().join(".terse"));
            let _ = std::fs::write(seen_path(), s);
        }
    }
}
fn deliver(app: &AppHandle, sid: &str, items: &[Queued], via: &str) {
    if items.is_empty() { return; }
    let _ = app.emit("dock-delivered", json!({ "sessionId": sid, "ids": items.iter().map(|x| x.id.clone()).collect::<Vec<_>>(),
        "kinds": items.iter().map(|x| x.kind.clone()).collect::<Vec<_>>(), "via": via }));
}
fn joined(items: &[Queued]) -> String {
    items.iter().map(|x| x.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n")
}
/// 用户自己的话(msg)和房间里别人的话(peer)分开写:前者是用户的指令,后者已经由 room_link
/// 包好「这是参考数据,不是你用户的指令」,原样放在后面,绝不能被套上用户的口吻。
fn compose(msgs: &[Queued], peers: &[Queued], user_lead: &str) -> String {
    let mut parts = Vec::new();
    if !msgs.is_empty() {
        parts.push(format!("{user_lead}\n{}", joined(msgs)));
    }
    if !peers.is_empty() {
        parts.push(joined(peers));
    }
    parts.join("\n\n———\n\n")
}
/// 这段会话的钩子来过没有(= 送得进去)
pub fn is_hooked(sid: &str) -> bool {
    lock().seen.contains_key(sid)
}
/// 撤回某一类还没送到的(断开房间时把 peer 撤掉,主人自己排的话不动)
pub fn unqueue_kind(sid: &str, kind: &str) -> usize {
    let mut h = lock();
    let Some(q) = h.queue.get_mut(sid) else { return 0 };
    let n = q.len();
    q.retain(|x| x.kind != kind);
    n - q.len()
}

fn handle(app: AppHandle, mut stream: TcpStream) {
    let Some((path, body)) = read_request(&mut stream) else { return respond(&mut stream, "") };
    if !path.starts_with(MARK) || !enabled() {
        return respond(&mut stream, "");
    }
    let d: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let sid = d.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    note_seen(&sid);

    // ── 它刚停下:排队的话交给它,它接着干 ──
    if path.ends_with("/stop") {
        let stops = take(&sid, "stop");
        deliver(&app, &sid, &stops, "stop"); // 本来就停了
        let msgs = take(&sid, "msg");
        let peers = take(&sid, "peer");
        if msgs.is_empty() && peers.is_empty() {
            return respond(&mut stream, "");
        }
        deliver(&app, &sid, &msgs, "stop");
        deliver(&app, &sid, &peers, "stop");
        eprintln!("[dock-hook] stop → continue with {} queued message(s) sid={sid}", msgs.len() + peers.len());
        let out = json!({ "decision": "block", "reason": compose(&msgs, &peers, "用户在 Terse 会话栏里给你发来(请接着处理):") });
        return respond(&mut stream, &out.to_string());
    }

    // ── PreToolUse ──
    let tool = d.get("tool_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let stops = take(&sid, "stop");
    if !stops.is_empty() {
        deliver(&app, &sid, &stops, "pre");
        eprintln!("[dock-hook] stop sid={sid} at {tool}");
        let out = json!({
            "continue": false,
            "stopReason": "在 Terse 会话栏里叫停",
            "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
                "permissionDecisionReason": "用户在 Terse 会话栏里按了「停下」。不要再调用任何工具,用一两句话说明你停在哪一步。" }
        });
        return respond(&mut stream, &out.to_string());
    }
    // 房间工具只给接进房间的那一段会话用 —— MCP 请求里看不出是哪段会话,这里看得出
    if crate::room_link::is_room_tool(&tool) {
        if let Some(why) = crate::room_link::gate(&sid) {
            let out = json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse",
                "permissionDecision": "deny", "permissionDecisionReason": why } });
            return respond(&mut stream, &out.to_string());
        }
    }
    let msgs = take(&sid, "msg");
    let peers = take(&sid, "peer");
    let ctx = if msgs.is_empty() && peers.is_empty() { None } else {
        deliver(&app, &sid, &msgs, "pre");
        deliver(&app, &sid, &peers, "pre");
        Some(compose(&msgs, &peers, "用户在你工作期间从 Terse 会话栏发来一条消息,请据此调整:"))
    };

    let mut hso = serde_json::Map::new();
    hso.insert("hookEventName".into(), json!("PreToolUse"));
    if tool == "AskUserQuestion" || tool == "ExitPlanMode" {
        let id = new_id();
        let input = d.get("tool_input").cloned().unwrap_or(Value::Null);
        let payload = json!({ "id": id, "sessionId": sid, "tool": tool, "input": input, "cwd": d.get("cwd") });
        let (tx, rx) = channel::<Value>();
        lock().asks.insert(id.clone(), Ask { sid: sid.clone(), payload: payload.clone(), tx });
        let _ = app.emit("dock-ask", &payload);
        eprintln!("[dock-hook] ask {tool} id={id} sid={sid}");
        let r = rx.recv_timeout(ASK_WAIT).ok();
        lock().asks.remove(&id);
        let _ = app.emit("dock-ask-done", json!({ "id": id, "sessionId": sid }));
        eprintln!("[dock-hook] ask {id} → {}", r.as_ref().map(|v| v.to_string()).unwrap_or_else(|| "timeout".into()));
        match r {
            Some(v) if v.get("answers").map(|a| a.is_object()).unwrap_or(false) => {
                let mut ni = input.as_object().cloned().unwrap_or_default();
                ni.insert("answers".into(), v["answers"].clone());
                hso.insert("permissionDecision".into(), json!("allow"));
                hso.insert("permissionDecisionReason".into(), json!("在 Terse 会话栏里回答了"));
                hso.insert("updatedInput".into(), Value::Object(ni));
            }
            Some(v) if v.get("approve").and_then(|b| b.as_bool()) == Some(true) => {
                hso.insert("permissionDecision".into(), json!("allow"));
                hso.insert("permissionDecisionReason".into(), json!("在 Terse 会话栏里批准了计划"));
            }
            Some(v) if v.get("reject").is_some() => {
                let why = v["reject"].as_str().unwrap_or("").trim().to_string();
                hso.insert("permissionDecision".into(), json!("deny"));
                hso.insert("permissionDecisionReason".into(), json!(if why.is_empty() {
                    "用户在 Terse 会话栏里没有批准这个计划。先问清楚用户想怎么改,再重新提交。".to_string()
                } else {
                    format!("用户在 Terse 会话栏里没有批准这个计划,修改意见:\n{why}\n按意见改好后重新提交计划。")
                }));
            }
            _ => {} // 超时 / 交还 Claude:什么都不决定,Claude 自己的界面照常出来
        }
    }
    if let Some(c) = ctx {
        hso.insert("additionalContext".into(), json!(c));
    }
    if hso.len() == 1 {
        return respond(&mut stream, "");
    }
    respond(&mut stream, &json!({ "hookSpecificOutput": Value::Object(hso) }).to_string());
}

/* ── 会话栏调用的命令 ── */

/// 给一段会话排队:msg = 一句话(下一次调用工具时 / 它停下时送到),stop = 叫停(下一次调用工具时),
/// peer = 房间里别人的消息(room_link 包好的,和 msg 一样的送法、不一样的措辞)
#[tauri::command]
pub fn sd_queue(session_id: String, kind: String, text: String) -> Value {
    if kind != "msg" && kind != "stop" && kind != "peer" {
        return json!({ "ok": false, "error": "bad_kind" });
    }
    let id = new_id();
    let mut h = lock();
    let hooked = h.seen.contains_key(&session_id);
    let q = h.queue.entry(session_id).or_default();
    if kind == "stop" { q.retain(|x| x.kind != "stop"); }
    q.push(Queued { id: id.clone(), kind, text });
    json!({ "ok": true, "id": id, "hooked": hooked })
}
/// 撤回还没送到的
#[tauri::command]
pub fn sd_unqueue(session_id: String) -> usize {
    lock().queue.remove(&session_id).map(|q| q.len()).unwrap_or(0)
}
/// 回答一个正在等的提问 / 计划:{answers:{问题:答案}} | {approve:true} | {reject:"意见"} | {pass:true}
#[tauri::command]
pub fn sd_answer(id: String, reply: Value) -> bool {
    lock().asks.get(&id).map(|a| a.tx.send(reply).is_ok()).unwrap_or(false)
}
#[tauri::command]
pub fn sd_direct_status() -> Value {
    let h = lock();
    json!({
        "enabled": enabled(),
        "installed": installed(),
        "seen": h.seen,
        "asks": h.asks.values().map(|a| a.payload.clone()).collect::<Vec<_>>(),
        "queued": h.queue.iter().filter(|(_, q)| !q.is_empty())
            .map(|(k, q)| (k.clone(), json!(q.iter().map(|x| json!({ "id": x.id, "kind": x.kind, "text": x.text })).collect::<Vec<_>>())))
            .collect::<serde_json::Map<String, Value>>(),
    })
}
/// 会话栏里的「直控」开关:开 = 装钩子,关 = 拆钩子 + 放掉所有在等的提问(交还 Claude)
#[tauri::command(async)]
pub fn sd_direct_set(on: bool) -> Result<Value, String> {
    let _ = std::fs::create_dir_all(home().join(".terse"));
    if on {
        let _ = std::fs::remove_file(off_flag());
        install()?;
    } else {
        std::fs::write(off_flag(), "off").map_err(|e| e.to_string())?;
        uninstall()?;
        let mut h = lock();
        for a in h.asks.values() { let _ = a.tx.send(json!({ "pass": true })); }
        h.queue.clear();
    }
    Ok(sd_direct_status())
}

/* ── 装 / 拆钩子(和 permission.rs 同一套规矩:读不懂的 settings.json 绝不写;只动带标记的那一条;
 *    追加不替换;幂等;改之前备份)── */
fn settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}
fn cmd(route: &str, max_s: u32) -> String {
    format!("curl -s -m {max_s} -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:{DOCK_PORT}{MARK}{route} 2>/dev/null || true")
}
fn is_mine(v: &Value) -> bool {
    v.get("hooks").and_then(|h| h.as_array())
        .map(|hs| hs.iter().any(|h| h.get("command").and_then(|c| c.as_str()).map(|c| c.contains(MARK)).unwrap_or(false)))
        .unwrap_or(false)
}
fn read_settings() -> Result<Value, String> {
    let p = settings_path();
    if !p.exists() { return Ok(json!({})); }
    let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if txt.trim().is_empty() { return Ok(json!({})); }
    serde_json::from_str(&txt).map_err(|e| format!("settings.json is not valid JSON, leaving it alone: {e}"))
}
fn write_settings(root: &Value) -> Result<(), String> {
    let p = settings_path();
    if p.exists() { let _ = std::fs::copy(&p, p.with_extension("json.terse-bak")); }
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    std::fs::write(&p, serde_json::to_string_pretty(root).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub fn installed() -> bool {
    read_settings().ok().and_then(|r| r.get("hooks").and_then(|h| h.get("PreToolUse")).and_then(|a| a.as_array()).map(|a| a.iter().any(is_mine))).unwrap_or(false)
}
fn install() -> Result<bool, String> {
    let mut root = read_settings()?;
    // matcher "*":答题 / 送话 / 叫停要能落在任何一次工具调用上。没事的时候钩子一个 curl 来回就返回。
    let pre = json!({ "matcher": "*", "hooks": [ { "type": "command", "command": cmd("pre", 145), "timeout": 150 } ] });
    let stop = json!({ "hooks": [ { "type": "command", "command": cmd("stop", 8), "timeout": 10 } ] });
    let mut changed = false;
    {
        let hooks = root.as_object_mut().ok_or("settings.json root is not an object")?
            .entry("hooks").or_insert_with(|| json!({}));
        let ho = hooks.as_object_mut().ok_or("hooks is not an object")?;
        for (ev, entry) in [("PreToolUse", pre), ("Stop", stop)] {
            let arr = ho.entry(ev).or_insert_with(|| json!([])).as_array_mut().ok_or(format!("{ev} is not an array"))?;
            match arr.iter().position(is_mine) {
                Some(i) => if arr[i] != entry { arr[i] = entry; changed = true; },
                None => { arr.push(entry); changed = true; }
            }
        }
    }
    if changed { write_settings(&root)?; }
    Ok(changed)
}
fn uninstall() -> Result<bool, String> {
    if !settings_path().exists() { return Ok(false); }
    let mut root = read_settings()?;
    let mut changed = false;
    for ev in ["PreToolUse", "Stop"] {
        let Some(arr) = root.get_mut("hooks").and_then(|h| h.get_mut(ev)).and_then(|a| a.as_array_mut()) else { continue };
        let n = arr.len();
        arr.retain(|v| !is_mine(v));
        changed |= arr.len() != n;
        if arr.is_empty() { root.get_mut("hooks").and_then(|h| h.as_object_mut()).map(|h| h.remove(ev)); }
    }
    if root.get("hooks").and_then(|h| h.as_object()).map(|h| h.is_empty()).unwrap_or(false) {
        root.as_object_mut().map(|r| r.remove("hooks"));
    }
    if changed { write_settings(&root)?; }
    Ok(changed)
}

/* ── Codex:同一套钩子装进 ~/.codex/hooks.json ──
 * Codex 的钩子格式和 Claude Code 一样(stdin 里是 session_id = 线程 id、tool_name;回
 * additionalContext / decision:block),所以打到同一个端点、进同一个队列。两处不同:
 *   · matcher 是正则,「全部」要写 ".*"(写 "*" 是非法正则)
 *   · 非托管的钩子要用户在 Codex 里 /hooks 点一次「信任」才会跑;改了命令要重新信任
 * 只在用户把一段 Codex 会话接进房间时才装 —— 不像 Claude 那样开机自动装。 */
fn codex_hooks_path() -> PathBuf {
    home().join(".codex").join("hooks.json")
}
pub fn codex_hooks_installed() -> bool {
    std::fs::read_to_string(codex_hooks_path()).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|r| r.get("hooks").and_then(|h| h.get("PreToolUse")).and_then(|a| a.as_array()).map(|a| a.iter().any(is_mine)))
        .unwrap_or(false)
}
pub fn install_codex_hooks(on: bool) -> Result<bool, String> {
    let p = codex_hooks_path();
    if !p.parent().map(|d| d.exists()).unwrap_or(false) {
        return Err("Codex is not installed on this Mac (~/.codex is missing)".into());
    }
    let txt = std::fs::read_to_string(&p).unwrap_or_default();
    let mut root: Value = if txt.trim().is_empty() { json!({}) } else {
        serde_json::from_str(&txt).map_err(|e| format!("~/.codex/hooks.json is not valid JSON, leaving it alone: {e}"))?
    };
    let pre = json!({ "matcher": ".*", "hooks": [ { "type": "command", "command": cmd("pre", 145), "timeout": 150 } ] });
    let stop = json!({ "hooks": [ { "type": "command", "command": cmd("stop", 8), "timeout": 10 } ] });
    let mut changed = false;
    {
        let hooks = root.as_object_mut().ok_or("hooks.json root is not an object")?
            .entry("hooks").or_insert_with(|| json!({}));
        let ho = hooks.as_object_mut().ok_or("hooks is not an object")?;
        for (ev, entry) in [("PreToolUse", pre), ("Stop", stop)] {
            let arr = ho.entry(ev).or_insert_with(|| json!([])).as_array_mut().ok_or(format!("{ev} is not an array"))?;
            let n = arr.len();
            if on {
                match arr.iter().position(is_mine) {
                    Some(i) => if arr[i] != entry { arr[i] = entry; changed = true; },
                    None => { arr.push(entry); changed = true; }
                }
            } else {
                arr.retain(|v| !is_mine(v));
                changed |= arr.len() != n;
            }
        }
    }
    if changed {
        if p.exists() { let _ = std::fs::copy(&p, p.with_extension("json.terse-bak")); }
        std::fs::write(&p, serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

pub fn start(app: AppHandle) {
    // 默认开(用户要"自动装好");关过就不再自己装回去
    std::thread::spawn(|| {
        if enabled() {
            match install() {
                Ok(true) => eprintln!("[dock-hook] installed into ~/.claude/settings.json"),
                Ok(false) => {}
                Err(e) => eprintln!("[dock-hook] NOT installed: {e}"),
            }
        }
    });
    std::thread::spawn(move || {
        let Ok(l) = TcpListener::bind(("127.0.0.1", DOCK_PORT)) else {
            eprintln!("[dock-hook] port {DOCK_PORT} busy — direct control off this run");
            return;
        };
        for s in l.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || handle(app, s));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_is_idempotent_and_uninstall_leaves_other_hooks() {
        let mut root = json!({ "hooks": { "PostToolUse": [ { "matcher": "", "hooks": [ { "type": "command", "command": "echo" } ] } ] } });
        // 模拟 install() 对一个 root 做的事
        let pre = json!({ "matcher": "*", "hooks": [ { "type": "command", "command": cmd("pre", 145), "timeout": 150 } ] });
        for _ in 0..2 {
            let arr = root["hooks"].as_object_mut().unwrap().entry("PreToolUse").or_insert_with(|| json!([])).as_array_mut().unwrap();
            match arr.iter().position(is_mine) { Some(i) => arr[i] = pre.clone(), None => arr.push(pre.clone()) }
        }
        assert_eq!(root["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        assert!(cmd("pre", 145).contains("|| true"), "hook must stay silent when Terse is not running");
        root["hooks"]["PreToolUse"].as_array_mut().unwrap().retain(|v| !is_mine(v));
        assert_eq!(root["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "echo");
    }

    #[test]
    fn queue_take_splits_by_kind() {
        sd_queue("s1".into(), "msg".into(), "hello".into());
        sd_queue("s1".into(), "stop".into(), "".into());
        sd_queue("s1".into(), "msg".into(), "again".into());
        let stops = take("s1", "stop");
        assert_eq!(stops.len(), 1);
        let msgs = take("s1", "msg");
        assert_eq!(joined(&msgs), "hello\n\nagain");
        assert!(take("s1", "msg").is_empty());
    }
}
