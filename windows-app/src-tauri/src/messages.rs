//! 评论/消息投屏 — the message feed the wallpaper plays as particles.
//!
//! Same `Message` shape as the macOS build, because the page that renders it is
//! shared and must not care which OS filled it in. The SOURCE is necessarily
//! different: macOS reads Notification Center's SQLite database and decodes a
//! binary plist payload; Windows keeps the same idea in a different place, the
//! Action Center database at
//! `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`, whose
//! payload is toast XML rather than a plist.
//!
//! Both rest on the same fragile premise, and it is worth stating plainly: this
//! reads NOTIFICATIONS, not chat histories. A message that never raised a
//! notification — muted conversation, app not running, notifications turned off
//! for it — does not exist as far as this is concerned. It is a feed of what the
//! machine was told, not a feed of what was said.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Stable id so the UI can de-duplicate across polls.
    pub id: String,
    /// The app's AppUserModelID — Windows' answer to a bundle identifier.
    pub app_id: String,
    /// Human name for that app ("微信"), or a best guess from the AUMID.
    pub app_name: String,
    /// Who sent it. For a group message this is the person, not the group.
    pub sender: String,
    /// Group / channel name when the message came from one.
    pub group: Option<String>,
    /// The message text.
    pub body: String,
    /// Unix seconds.
    pub ts: i64,
}

/// AUMID fragment → display name. Matched case-insensitively as a substring,
/// because a Windows AUMID is not a stable reverse-DNS string the way a bundle
/// id is: WeChat alone appears as a raw path, as `Tencent.WeChat`, and as a
/// shell-link GUID form depending on how it was installed.
const KNOWN_APPS: &[(&str, &str)] = &[
    ("wechat", "微信"),
    ("weixin", "微信"),
    ("wework", "企业微信"),
    ("wxwork", "企业微信"),
    ("tencent.qq", "QQ"),
    ("\\qq.exe", "QQ"),
    ("dingtalk", "钉钉"),
    ("lark", "飞书"),
    ("feishu", "飞书"),
    ("bilibili", "哔哩哔哩"),
    ("slack", "Slack"),
    ("telegram", "Telegram"),
    ("discord", "Discord"),
    ("whatsapp", "WhatsApp"),
    ("signal", "Signal"),
    ("skype", "Skype"),
    ("teams", "Teams"),
    ("outlook", "Outlook"),
    ("thunderbird", "Thunderbird"),
    ("line.exe", "LINE"),
];

const CHAT_HINTS: &[&str] = &[
    "chat", "messenger", "message", "talk", "wechat", "weixin", "qq",
    "telegram", "whatsapp", "signal", "discord", "slack", "line", "kakao",
    "viber", "skype", "mattermost", "rocket", "element", "matrix", "dingtalk",
    "lark", "feishu", "teams", "mail", "outlook",
];

pub fn app_display_name(aumid: &str) -> String {
    let lower = aumid.to_ascii_lowercase();
    if let Some((_, name)) = KNOWN_APPS.iter().find(|(frag, _)| lower.contains(frag)) {
        return name.to_string();
    }
    // Fall back to something a person can read: the executable stem, or the last
    // dotted component. "…\Tencent\WeChat\WeChat.exe" → "WeChat".
    let tail = aumid.rsplit(['\\', '/']).next().unwrap_or(aumid);
    let stem = tail.strip_suffix(".exe").unwrap_or(tail);
    let stem = stem.rsplit('.').next().unwrap_or(stem);
    if stem.is_empty() { aumid.to_string() } else { stem.to_string() }
}

pub fn is_chat_app(aumid: &str) -> bool {
    let lower = aumid.to_ascii_lowercase();
    KNOWN_APPS.iter().any(|(frag, _)| lower.contains(frag))
        || CHAT_HINTS.iter().any(|h| lower.contains(h))
}

fn db_path() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let p = std::path::Path::new(&local)
        .join("Microsoft")
        .join("Windows")
        .join("Notifications")
        .join("wpndatabase.db");
    if p.exists() { Some(p) } else { None }
}

/// Windows FILETIME (100-nanosecond ticks since 1601-01-01) → Unix seconds.
fn filetime_to_unix(ft: i64) -> i64 {
    // 11644473600 = seconds between 1601-01-01 and 1970-01-01.
    (ft / 10_000_000) - 11_644_473_600
}

/// Pull the `<text>` runs out of a toast payload.
///
/// Hand-parsed rather than pulling in an XML crate: the payload is a fixed,
/// machine-generated shape (`<toast><visual><binding><text>…`), and the only
/// thing wanted from it is the ordered list of text runs. By convention the
/// first is the title — the sender, or the group — and the rest are the body.
fn toast_texts(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<text") {
        rest = &rest[i + 5..];
        let Some(gt) = rest.find('>') else { break };
        // A self-closing <text/> carries nothing.
        if rest.as_bytes().get(gt.wrapping_sub(1)) == Some(&b'/') {
            rest = &rest[gt + 1..];
            continue;
        }
        rest = &rest[gt + 1..];
        let Some(end) = rest.find("</text>") else { break };
        let raw = &rest[..end];
        rest = &rest[end + 7..];
        let t = unescape_xml(raw).trim().to_string();
        if !t.is_empty() {
            out.push(t);
        }
    }
    out
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        // Last, or an escaped entity in the text would be double-decoded.
        .replace("&amp;", "&")
}

/// Recent notifications, newest first.
pub fn recent(limit: usize, chat_only: bool) -> Result<Vec<Message>, String> {
    let path = db_path().ok_or_else(|| "no notification database on this system".to_string())?;

    // Windows holds this database open and writes to it constantly, so a plain
    // read-only open loses to the lock often enough to look like "the feed is
    // empty". Copy first, read the copy: a snapshot a few milliseconds old is
    // the right trade for a feed that refreshes on a timer anyway.
    let tmp = std::env::temp_dir().join("terse-wpn-snapshot.db");
    let src = match std::fs::copy(&path, &tmp) {
        Ok(_) => tmp.clone(),
        Err(_) => path.clone(),
    };

    let conn = rusqlite::Connection::open_with_flags(
        &src,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("cannot open the notification database: {e}"))?;

    // Over-fetch: rows are dropped by the chat filter and by payloads with no
    // text, so asking for exactly `limit` would routinely return fewer.
    let scan = (limit.max(1) * 12).min(2000) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT h.PrimaryId, n.ArrivalTime, n.Payload, n.Id \
             FROM Notification n JOIN NotificationHandler h ON n.HandlerId = h.RecordId \
             ORDER BY n.ArrivalTime DESC LIMIT ?1",
        )
        .map_err(|e| format!("notification query failed: {e}"))?;

    let rows = stmt
        .query_map([scan], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, i64>(1).unwrap_or(0),
                row.get::<_, String>(2).unwrap_or_default(),
                row.get::<_, i64>(3).unwrap_or(0),
            ))
        })
        .map_err(|e| format!("notification query failed: {e}"))?;

    let mut out = Vec::new();
    for r in rows.flatten() {
        let (aumid, arrival, payload, row_id) = r;
        if aumid.is_empty() {
            continue;
        }
        if chat_only && !is_chat_app(&aumid) {
            continue;
        }
        let texts = toast_texts(&payload);
        if texts.is_empty() {
            continue;
        }
        // One text run is a bare notice with no sender — the title IS the whole
        // message. Two or more: the first names who or where it came from.
        let (sender, body) = if texts.len() == 1 {
            (app_display_name(&aumid), texts[0].clone())
        } else {
            (texts[0].clone(), texts[1..].join(" "))
        };
        if body.is_empty() {
            continue;
        }
        out.push(Message {
            id: format!("{aumid}:{row_id}"),
            app_name: app_display_name(&aumid),
            app_id: aumid,
            sender,
            group: None,
            body,
            ts: filetime_to_unix(arrival),
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

pub fn recent_for_wallpaper(limit: usize) -> Result<Vec<Message>, String> {
    let muted = load_config().muted;
    // Over-fetch before filtering: muting two or three apps out of a `limit`-
    // sized page routinely leaves nothing at all.
    let raw = recent(limit.max(1) * 4, true)?;
    Ok(raw
        .into_iter()
        .filter(|m| !muted.iter().any(|x| *x == m.app_id))
        .take(limit)
        .collect())
}

pub fn set_app_on_wallpaper(app_id: &str, on: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.muted.retain(|x| x != app_id);
    if !on {
        cfg.muted.push(app_id.to_string());
    }
    save_config(&cfg)
}

fn config_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("messages.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MsgConfig {
    /// Apps kept off the wallpaper. Affects the wallpaper only.
    #[serde(default)]
    pub muted: Vec<String>,
}

pub fn load_config() -> MsgConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_config(cfg: &MsgConfig) -> Result<(), String> {
    let p = config_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&p, serde_json::to_string_pretty(cfg).unwrap_or_default())
        .map_err(|e| e.to_string())
}


/* ══════════════ 回复:开会话 / 发送 ══════════════

   Deliberately two calls, not one, and the split is the safety property — not
   an implementation detail.

   Step 1 opens the conversation and sends NOTHING. Step 2 sends into whatever
   conversation is open. In between, a person looks at the screen. The macOS
   build did this because WeChat exposes no accessibility tree there, so no code
   can confirm which conversation the search actually landed on: the machine can
   send, it just cannot prove to whom. Windows is no better placed to promise it
   — the search box is driven by a hotkey the user is free to rebind, and a
   rebound hotkey means the paste goes somewhere else entirely. So the check
   stays with the person, and nothing here sends without a second, separate call
   that only the user's own click can make.

   ⚠ NONE of these recipes has been verified on a real Windows machine. The
   macOS file is honest that only its WeChat recipe was checked in place; here
   not even that is true — CI has no chat app installed, and I have no Windows
   box. They are transcriptions of each app's documented shortcut. A wrong
   hotkey does not send to the wrong person (step 2 is a separate deliberate
   act), it simply fails to open a search box, and the user sees that.
*/

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyResult {
    pub ok: bool,
    pub error: Option<String>,
}

fn fail(msg: impl Into<String>) -> ReplyResult {
    ReplyResult { ok: false, error: Some(msg.into()) }
}

struct ReplyRecipe {
    /// Process name for Get-Process — Windows has no bundle identifier.
    process: &'static str,
    /// The app's search / quick-jump shortcut, in SendKeys notation.
    search: &'static str,
    /// How long the app needs after being fronted before it will take a hotkey.
    open_delay_ms: u64,
}

fn recipe_for(app_id: &str) -> Option<ReplyRecipe> {
    let lower = app_id.to_ascii_lowercase();
    // Substring, not equality: a Windows AUMID is not a canonical identifier
    // (see app_display_name) and arrives in several shapes for the same app.
    if lower.contains("wechat") || lower.contains("weixin") {
        return Some(ReplyRecipe { process: "WeChat", search: "^f", open_delay_ms: 900 });
    }
    if lower.contains("wxwork") || lower.contains("wework") {
        return Some(ReplyRecipe { process: "WXWork", search: "^+f", open_delay_ms: 1100 });
    }
    if lower.contains("qq") {
        return Some(ReplyRecipe { process: "QQ", search: "^f", open_delay_ms: 900 });
    }
    if lower.contains("lark") || lower.contains("feishu") {
        return Some(ReplyRecipe { process: "Feishu", search: "^k", open_delay_ms: 1000 });
    }
    if lower.contains("dingtalk") {
        return Some(ReplyRecipe { process: "DingTalk", search: "^f", open_delay_ms: 1000 });
    }
    if lower.contains("telegram") {
        return Some(ReplyRecipe { process: "Telegram", search: "^f", open_delay_ms: 700 });
    }
    if lower.contains("slack") {
        return Some(ReplyRecipe { process: "slack", search: "^k", open_delay_ms: 900 });
    }
    if lower.contains("discord") {
        return Some(ReplyRecipe { process: "Discord", search: "^k", open_delay_ms: 900 });
    }
    None
}

/// Put text on the clipboard without letting it become PowerShell.
///
/// The existing set_clipboard interpolates into `Set-Clipboard -Value '…'`,
/// which is fine for a word and wrong for a message: a newline ends the
/// statement and a quote escapes the literal, so the reply someone actually
/// typed is exactly the input most likely to break it. Base64 never contains a
/// character the shell cares about.
async fn clipboard_set_safe(text: &str) {
    let b64 = crate::b64(text.as_bytes());
    let script = format!(
        "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64}')))"
    );
    let _ = crate::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
}

fn clipboard_get() -> String {
    crate::hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_end_matches(['\r', '\n']).to_string())
        .unwrap_or_default()
}

/// Step 1 of replying: open the conversation and stop, sending nothing.
pub async fn open_chat(app_id: &str, target: &str) -> ReplyResult {
    let Some(r) = recipe_for(app_id) else {
        return fail(format!("{} 暂不支持", app_display_name(app_id)));
    };
    if target.trim().is_empty() {
        return fail("没有会话名,不知道要打开哪一个");
    }
    // Saved and put back: quietly emptying somebody's clipboard is a nasty thing
    // for a background app to do, and the search term is pasted rather than
    // typed because Chinese through an IME gets eaten or mistyped.
    let saved = clipboard_get();
    crate::capture::activate_app(r.process).await;
    tokio::time::sleep(std::time::Duration::from_millis(r.open_delay_ms)).await;
    clipboard_set_safe(target).await;
    crate::capture::send_keys(r.search).await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    crate::capture::send_keys("^v").await;
    tokio::time::sleep(std::time::Duration::from_millis(450)).await;
    crate::capture::send_keys("{ENTER}").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    if !saved.is_empty() {
        clipboard_set_safe(&saved).await;
    }
    ReplyResult { ok: true, error: None }
}

/// Step 2: send into the conversation the user has just confirmed by eye.
///
/// This types nothing on its own initiative. It runs only when the person has
/// looked at the chat that step 1 opened and pressed send.
pub async fn send_to_open_chat(app_id: &str, text: &str) -> ReplyResult {
    let Some(r) = recipe_for(app_id) else {
        return fail(format!("{} 暂不支持", app_display_name(app_id)));
    };
    if text.trim().is_empty() {
        return fail("空消息");
    }
    let saved = clipboard_get();
    crate::capture::activate_app(r.process).await;
    tokio::time::sleep(std::time::Duration::from_millis(350)).await;
    clipboard_set_safe(text).await;
    crate::capture::send_keys("^v").await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    crate::capture::send_keys("{ENTER}").await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    if !saved.is_empty() {
        clipboard_set_safe(&saved).await;
    }
    ReplyResult { ok: true, error: None }
}

/// Can the feed be read at all? Drives the UI's "why is this empty" line.
pub fn status() -> serde_json::Value {
    match db_path() {
        None => serde_json::json!({
            "ok": false,
            "reason": "no-db",
            "detail": "找不到 Windows 通知数据库(wpndatabase.db)",
        }),
        Some(p) => match recent(1, false) {
            Ok(_) => serde_json::json!({ "ok": true, "path": p.to_string_lossy() }),
            Err(e) => serde_json::json!({ "ok": false, "reason": "unreadable", "detail": e }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_text_runs_come_out_in_order() {
        let xml = r#"<toast><visual><binding template="ToastGeneric">
            <text>张三</text><text>晚上一起吃饭吗</text>
            <image src="x.png"/></binding></visual></toast>"#;
        assert_eq!(toast_texts(xml), vec!["张三", "晚上一起吃饭吗"]);
    }

    #[test]
    fn self_closing_text_yields_nothing() {
        // Real payloads carry these, and an earlier cut read past them and swallowed
        // the following run's content as if it were the title.
        assert_eq!(toast_texts("<toast><text/><text>hi</text></toast>"), vec!["hi"]);
    }

    #[test]
    fn ampersand_is_decoded_last() {
        // "&amp;lt;" must survive as the literal "&lt;", not become "<".
        assert_eq!(toast_texts("<toast><text>a &amp;lt; b</text></toast>"), vec!["a &lt; b"]);
    }

    #[test]
    fn filetime_epoch_is_the_unix_epoch() {
        // 1970-01-01 expressed as FILETIME.
        assert_eq!(filetime_to_unix(116_444_736_000_000_000), 0);
    }

    #[test]
    fn aumid_shapes_all_resolve_to_one_name() {
        // The reason names are matched as substrings: the same app arrives under
        // three unrelated-looking identifiers depending on how it was installed.
        for id in [
            r"{6D809377}\Tencent\WeChat\WeChat.exe",
            "Tencent.WeChat_1.0.0.0",
            r"C:\Program Files\WeChat\WeChat.exe",
        ] {
            assert_eq!(app_display_name(id), "微信", "{id}");
            assert!(is_chat_app(id), "{id}");
        }
    }

    #[test]
    fn every_app_the_feed_surfaces_has_a_reply_recipe() {
        // A missing recipe is not a compile error, it is a reply button that
        // appears and then says "not supported" — worth failing here instead.
        for id in ["WeChat.exe", "Tencent.QQ", "Telegram", "slack", "Discord",
                   "Feishu", "DingTalk", "WXWork"] {
            assert!(recipe_for(id).is_some(), "no reply recipe for {id}");
        }
        // Mail apps pass the chat filter so their notifications show, but there
        // is deliberately no way to "reply" into one with a paste and Enter.
        assert!(recipe_for("Outlook").is_none());
    }

    #[test]
    fn recipes_accept_the_same_aumid_shapes_the_feed_produces() {
        // The recipe table and the name table must agree about what an AUMID
        // looks like, or the feed shows a message the reply path cannot act on.
        for id in [r"{6D809377}\Tencent\WeChat\WeChat.exe", "Tencent.WeChat_1.0.0.0"] {
            assert_eq!(recipe_for(id).unwrap().process, "WeChat", "{id}");
        }
    }

    #[test]
    fn an_unknown_app_still_gets_a_readable_name() {
        assert_eq!(app_display_name(r"C:\Apps\Frobnicator.exe"), "Frobnicator");
    }
}
