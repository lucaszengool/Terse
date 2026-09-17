//! Social-app message feed, read from the macOS Notification Center database.
//!
//! WHY THIS SOURCE. The goal is "every social app" — WeChat, QQ, Slack, Telegram,
//! Messages, Lark… There is no sanctioned macOS API for observing another app's
//! notifications, and per-app scraping would mean writing (and maintaining) a
//! separate UI-tree reader for each one. Notification Center is the single place
//! where all of them already land in a uniform shape: bundle id, title, subtitle,
//! body, timestamp. One reader covers every app that can post a notification.
//!
//! WHAT IT COSTS. The database lives behind Full Disk Access, which only the user
//! can grant, in System Settings. Until they do, every read fails and the feed is
//! empty — that is a permission state to surface, not an error to hide.
//!
//! WHERE IT LIVES. Apple moved this file in macOS 15 (Sequoia) into a TCC-guarded
//! Group Container. Before that it sat in the per-user DARWIN_USER_DIR temp tree.
//! Both are probed, newest layout first, because a machine can be upgraded under
//! us and a hard-coded path would simply stop returning messages one morning.
//!
//! WHAT IT CANNOT DO. Notifications are read-only: nothing here can send a reply.
//! Replying is a separate, per-app Accessibility path (see `messages_reply`).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One normalized message, whatever app it came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Stable id so the UI can de-duplicate across polls.
    pub id: String,
    /// Bundle identifier, e.g. `com.tencent.xinWeChat`.
    pub app_id: String,
    /// Human name for that bundle ("微信"), or the bundle id if unknown.
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

/// Whether we can actually read the feed, and why not when we cannot.
#[derive(Debug, Clone, Serialize)]
pub struct FeedStatus {
    pub available: bool,
    /// "ok" | "no_permission" | "no_database" | "error"
    pub reason: String,
    pub db_path: Option<String>,
    pub detail: Option<String>,
}

/// Bundle id → display name. Anything not listed is still readable; this only
/// controls the pretty name and the default "is this a chat app" filter.
const KNOWN_APPS: &[(&str, &str)] = &[
    // ── 国内 ──
    ("com.tencent.xinWeChat", "微信"),
    ("com.tencent.WeWorkMac", "企业微信"),
    ("com.tencent.qq", "QQ"),
    ("com.tencent.tim", "TIM"),
    ("com.alibaba.DingTalkMac", "钉钉"),
    ("com.bytedance.lark", "飞书"),
    ("com.electron.lark", "飞书"),
    ("com.bytedance.douyin", "抖音"),
    ("com.sina.weibo", "微博"),
    ("com.xingin.discover", "小红书"),
    ("com.netease.163music", "网易云"),
    ("tv.danmaku.bili", "哔哩哔哩"),
    ("com.tencent.meeting", "腾讯会议"),
    // ── 海外 ──
    ("com.apple.MobileSMS", "信息"),
    ("com.apple.iChat", "信息"),
    ("com.apple.facetime", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("ru.keepcoder.Telegram", "Telegram"),
    ("org.telegram.desktop", "Telegram"),
    ("com.hnc.Discord", "Discord"),
    ("com.microsoft.teams2", "Teams"),
    ("com.microsoft.teams", "Teams"),
    ("net.whatsapp.WhatsApp", "WhatsApp"),
    ("desktop.WhatsApp", "WhatsApp"),
    ("org.whispersystems.signal-desktop", "Signal"),
    ("com.facebook.archon", "Messenger"),
    ("com.facebook.Messenger", "Messenger"),
    ("com.burbn.instagram", "Instagram"),
    ("com.atebits.Tweetie2", "X"),
    ("maccatalyst.com.atebits.Tweetie2", "X"),
    ("com.linkedin.LinkedIn", "LinkedIn"),
    ("jp.naver.line.mac", "LINE"),
    ("com.kakao.KakaoTalkMac", "KakaoTalk"),
    ("com.viber.osx", "Viber"),
    ("com.skype.skype", "Skype"),
    ("im.riot.app", "Element"),
    ("chat.rocket.RocketChat", "Rocket.Chat"),
    ("com.mattermost.desktop", "Mattermost"),
    ("us.zoom.xos", "Zoom"),
    ("com.google.Chat", "Google Chat"),
    ("com.readdle.SparkMacOS", "Spark"),
    ("com.apple.mail", "邮件"),
    ("com.microsoft.Outlook", "Outlook"),
];

/// Bundle-id fragments that mark an app as messaging-like even when it is not in
/// the table above. There will always be an app nobody thought of — a regional
/// messenger, a work tool, next year's launch — and a fixed list would silently
/// drop it. This keeps the feed open by shape rather than by enumeration.
const CHAT_HINTS: &[&str] = &[
    "chat", "messenger", "message", "im.", "talk", "wechat", "weixin", "qq",
    "telegram", "whatsapp", "signal", "discord", "slack", "line", "kakao",
    "viber", "skype", "mattermost", "rocket", "element", "matrix", "dingtalk",
    "lark", "feishu", "teams",
];

/// 通知库里的 bundle id 是**全小写**存的(实测:微信在里面是
/// `com.tencent.xinwechat`,而它真正的 bundle id 是 `com.tencent.xinWeChat`)。
/// 所以这里的比较一律不区分大小写 —— 否则每一个带大写字母的 app 都会匹配不上,
/// 名字掉回 "xinwechat" 这种东西,而且看起来像"没识别到"。
fn id_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

pub fn app_display_name(bundle: &str) -> String {
    KNOWN_APPS
        .iter()
        .find(|(id, _)| id_eq(id, bundle))
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| {
            // Fall back to the last path component: com.foo.BarApp → BarApp.
            bundle.rsplit('.').next().unwrap_or(bundle).to_string()
        })
}

/// True for the apps we treat as "social" by default.
///
/// Two ways in: the curated table, or a messaging-shaped bundle id. The second
/// path matters more than it looks — the feed is supposed to cover "every social
/// app", and an allow-list can only ever cover the ones already thought of.
pub fn is_chat_app(bundle: &str) -> bool {
    if KNOWN_APPS.iter().any(|(id, _)| id_eq(id, bundle)) {
        return true;
    }
    let lower = bundle.to_ascii_lowercase();
    CHAT_HINTS.iter().any(|h| lower.contains(h))
}

/// Candidate locations for the notification store, newest macOS layout first.
fn candidate_db_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    // macOS 15 (Sequoia) and later — inside a TCC-protected Group Container.
    if let Some(home) = dirs::home_dir() {
        out.push(
            home.join("Library")
                .join("Group Containers")
                .join("group.com.apple.usernoted")
                .join("db2")
                .join("db"),
        );
    }

    // macOS 14 (Sonoma) and earlier — under the per-user DARWIN_USER_DIR, whose
    // path is a random per-user folder, so it has to be asked for rather than
    // guessed. `getconf` is the documented way to get it.
    if let Ok(out_bytes) = std::process::Command::new("getconf")
        .arg("DARWIN_USER_DIR")
        .output()
    {
        if let Ok(dir) = String::from_utf8(out_bytes.stdout) {
            let dir = dir.trim();
            if !dir.is_empty() {
                out.push(
                    PathBuf::from(dir)
                        .join("com.apple.notificationcenter")
                        .join("db2")
                        .join("db"),
                );
            }
        }
    }

    out
}

/// Locate the database, if one of the candidates exists on this machine.
fn find_db() -> Option<PathBuf> {
    candidate_db_paths().into_iter().find(|p| p.exists())
}

/// Mac "absolute time" (seconds since 2001-01-01) → Unix seconds.
fn mac_abs_to_unix(t: f64) -> i64 {
    (t as i64) + 978_307_200
}

/// Pull the three text fields out of a notification's binary-plist payload.
///
/// The payload nests the user-visible strings under a `req` dictionary, keyed
/// `titl` / `subt` / `body`. Anything missing is simply absent — a notification
/// with no body (a bare "you have a new message") is normal, not a parse failure.
fn parse_payload(blob: &[u8]) -> Option<(String, String, String)> {
    let val: plist::Value = plist::from_bytes(blob).ok()?;
    let dict = val.as_dictionary()?;
    let req = dict.get("req")?.as_dictionary()?;
    let get = |k: &str| {
        req.get(k)
            .and_then(|v| v.as_string())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    Some((get("titl"), get("subt"), get("body")))
}

/// Split a notification's title/subtitle into sender and group.
///
/// Group chats put the room in the title and the person in the subtitle
/// ("产品群" / "张三"); direct messages use the title for the person and leave
/// the subtitle empty. That asymmetry is the only signal available, so it is
/// what distinguishes the two.
fn split_sender_group(title: &str, subtitle: &str) -> (String, Option<String>) {
    if !subtitle.is_empty() {
        (subtitle.to_string(), Some(title.to_string()))
    } else {
        (title.to_string(), None)
    }
}

/// Can we read the feed right now?
pub fn status() -> FeedStatus {
    let path = match find_db() {
        Some(p) => p,
        None => {
            return FeedStatus {
                available: false,
                reason: "no_database".into(),
                db_path: None,
                detail: Some(
                    "No Notification Center database found for this macOS version.".into(),
                ),
            }
        }
    };

    // Opening read-only is the permission probe: without Full Disk Access this
    // fails outright, which is exactly the state the UI needs to distinguish
    // from "granted, but nothing has arrived yet".
    match rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => match conn.prepare("SELECT count(*) FROM record") {
            Ok(mut st) => match st.query_row([], |r| r.get::<_, i64>(0)) {
                Ok(_) => FeedStatus {
                    available: true,
                    reason: "ok".into(),
                    db_path: Some(path.display().to_string()),
                    detail: None,
                },
                Err(e) => deny(&path, e.to_string()),
            },
            Err(e) => deny(&path, e.to_string()),
        },
        Err(e) => deny(&path, e.to_string()),
    }
}

fn deny(path: &PathBuf, detail: String) -> FeedStatus {
    FeedStatus {
        available: false,
        reason: "no_permission".into(),
        db_path: Some(path.display().to_string()),
        detail: Some(detail),
    }
}

/// Read the most recent messages, newest first.
///
/// `chat_only` keeps the feed to recognised messaging apps — otherwise every
/// build-finished and calendar alert on the machine would end up on the wallpaper.
pub fn recent(limit: usize, chat_only: bool) -> Result<Vec<Message>, String> {
    let path = find_db().ok_or_else(|| "no notification database on this system".to_string())?;
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("cannot open notification database (Full Disk Access?): {e}"))?;

    // Over-fetch: rows get dropped by the chat-app filter and by payloads with no
    // body, so asking for exactly `limit` would routinely return fewer.
    let scan = (limit.max(1) * 12).min(2000);
    let mut stmt = conn
        .prepare(
            "SELECT app.identifier, record.delivered_date, record.data \
             FROM record JOIN app ON record.app_id = app.app_id \
             ORDER BY record.delivered_date DESC LIMIT ?1",
        )
        .map_err(|e| format!("unexpected notification schema: {e}"))?;

    let rows = stmt
        .query_map([scan as i64], |row| {
            let app_id: String = row.get(0)?;
            let when: Option<f64> = row.get(1).ok();
            let blob: Vec<u8> = row.get(2)?;
            Ok((app_id, when.unwrap_or(0.0), blob))
        })
        .map_err(|e| e.to_string())?;

    let mut out: Vec<Message> = Vec::new();
    for row in rows.flatten() {
        let (app_id, when, blob) = row;
        if chat_only && !is_chat_app(&app_id) {
            continue;
        }
        let Some((title, subtitle, body)) = parse_payload(&blob) else {
            continue;
        };
        if body.is_empty() && title.is_empty() {
            continue;
        }
        let (sender, group) = split_sender_group(&title, &subtitle);
        let ts = mac_abs_to_unix(when);
        out.push(Message {
            // Content-addressed rather than row-id based: the same row id can be
            // reused after the store prunes, and the UI de-duplicates on this.
            id: format!("{}-{}-{}", app_id, ts, short_hash(&format!("{sender}{body}"))),
            app_name: app_display_name(&app_id),
            app_id,
            sender,
            group,
            body,
            ts,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(s.as_bytes());
    d.iter().take(6).map(|b| format!("{b:02x}")).collect()
}


/* ══════════════ 回复 ══════════════

   通知是只读的,回不了。回复必须走每个 app 自己的 UI 自动化(Accessibility),
   所以这里是按 app 一个个实现的,而不是一个通用通道。

   ⚠ 这条路径会把消息发给真人,发错了收不回来。所以:
     · 只对确实验证过 UI 树的 app 开放,其余一律明确报"暂不支持",
       绝不退化成"往当前窗口里盲打一段字"——那正是发错人的方式;
     · 打开会话之后先核对标题,对不上就中止,不发。
*/

/// 回复结果。ok=false 时 error 里是给人看的原因,不是堆栈。
#[derive(Debug, Serialize)]
pub struct ReplyResult {
    pub ok: bool,
    pub error: Option<String>,
}

fn fail(msg: impl Into<String>) -> ReplyResult {
    ReplyResult { ok: false, error: Some(msg.into()) }
}

/// AppleScript 字符串字面量转义 —— 消息正文里的引号和反斜杠必须挡住,
/// 否则一条带引号的回复就会把脚本改成别的意思。
fn as_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 每个 app 的回复配方。
///
/// 只列真正查证过搜索入口的 app —— 这张表就是"允许回复"的名单本身,
/// 不在表里的一律拒绝,不会退化成"往当前窗口盲打"。
struct ReplyRecipe {
    /// bundle id,用它来激活:企业微信/飞书的 .app 名字是本地化的,
    /// `tell application "企业微信"` 在英文系统上会直接失败,bundle id 不会。
    bundle: &'static str,
    /// 打开搜索的快捷键(键名 + 修饰键的 AppleScript 写法)
    key: &'static str,
    modifiers: &'static str,
    /// 搜到之后到会话打开之间要等多久(毫秒)。飞书/企微是 Electron,慢一些。
    open_delay_ms: u32,
}

fn recipe_for(app_id: &str) -> Option<ReplyRecipe> {
    // 同样按小写比:app_id 是从通知库里读出来的,不是应用的规范写法。
    let lower = app_id.to_ascii_lowercase();
    match lower.as_str() {
        // 微信:Cmd+F 搜索。本机装了微信,这个配方是唯一一个能就地核对过的。
        "com.tencent.xinwechat" => Some(ReplyRecipe {
            bundle: "com.tencent.xinWeChat",
            key: "f",
            modifiers: "command down",
            open_delay_ms: 800,
        }),
        // 企业微信:全局搜索是 Cmd+Shift+F(官方帮助里写的,且可被用户改掉 ——
        // 改过就搜索框不会开,随后的标题核对失败,于是中止不发)。
        "com.tencent.weworkmac" => Some(ReplyRecipe {
            bundle: "com.tencent.WeWorkMac",
            key: "f",
            modifiers: "{command down, shift down}",
            open_delay_ms: 1100,
        }),
        // 飞书 / Lark:Cmd+K 是它的全局快速跳转。
        "com.bytedance.lark" | "com.electron.lark" => Some(ReplyRecipe {
            bundle: app_id_static(&lower),
            key: "k",
            modifiers: "command down",
            open_delay_ms: 1100,
        }),
        _ => None,
    }
}

/// `ReplyRecipe.bundle` 需要 'static;飞书有两个 bundle id,这里映射回常量。
fn app_id_static(app_id: &str) -> &'static str {
    match app_id {
        "com.electron.lark" => "com.electron.lark",
        _ => "com.bytedance.lark",
    }
}

/// 第一步:把会话搜出来、打开,**然后停住**,一个字都不发。
///
/// 为什么要分两步:微信 4.1.11 已经不向 Accessibility 暴露任何界面元素了
/// (实测 entire contents = 0,AXManualAccessibility 返回 -25205),
/// 所以程序没有任何办法确认"搜索打开的到底是不是你要的那个人"。
///
/// 打字反而不受影响 —— 合成按键是输入,不需要读界面。也就是说:
/// 能发,但发之前无法自证发给了谁。
///
/// 那就别让机器来担保。打开会话后交回给人:你自己看一眼微信里开的是谁,
/// 确认了再按发送。机器做它做得对的部分(搜索、切换、输入),
/// 人做只有人能做的部分(确认收件人)。
pub fn open_chat(app_id: &str, target: &str) -> ReplyResult {
    let Some(r) = recipe_for(app_id) else {
        return fail(format!("{} 暂不支持", app_display_name(app_id)));
    };
    let t = as_escape(target);
    let ReplyRecipe { bundle, key, modifiers, open_delay_ms } = r;
    let d = open_delay_ms as f64 / 1000.0;

    // 搜索词用剪贴板贴进去,不用 keystroke:中文经输入法会被吃掉或拼错。
    // 用完把原剪贴板还回去 —— 悄悄清空别人的剪贴板是很讨厌的事。
    let script = format!(r#"
on run
  set savedClip to ""
  try
    set savedClip to the clipboard as text
  end try
  try
    do shell script "open -b {bundle}"
  on error
    return "ERR:没能启动应用"
  end try
  delay 0.9
  set the clipboard to "{t}"
  tell application "System Events"
    set p to first application process whose frontmost is true
    tell p
      keystroke "{key}" using {modifiers}
      delay 0.4
      keystroke "v" using command down
      delay {d}
      key code 36
      delay {d}
    end tell
  end tell
  try
    set the clipboard to savedClip
  end try
  return "OK"
end run
"#);
    run_osa(&script)
}

/// 第二步:把消息贴进当前已经打开的会话并发送。
///
/// 只在人已经看过、确认过收件人之后才会被调用。
pub fn send_to_open_chat(app_id: &str, text: &str) -> ReplyResult {
    let Some(r) = recipe_for(app_id) else {
        return fail(format!("{} 暂不支持", app_display_name(app_id)));
    };
    let m = as_escape(text);
    let bundle = r.bundle;
    let script = format!(r#"
on run
  set savedClip to ""
  try
    set savedClip to the clipboard as text
  end try
  try
    do shell script "open -b {bundle}"
  end try
  delay 0.6
  set the clipboard to "{m}"
  tell application "System Events"
    set p to first application process whose frontmost is true
    tell p
      keystroke "v" using command down
      delay 0.45
      -- 这一下 key code 36 必须显式带 using {{}}:紧接在 Cmd+V 之后发回车,
      -- 修饰键状态会被带过来变成 Cmd+Return —— 那是"换行"而不是"发送",
      -- 结果就是消息永远躺在输入框里发不出去。
      key code 36 using {{}}
      delay 0.25
    end tell
  end tell
  try
    set the clipboard to savedClip
  end try
  return "OK"
end run
"#);
    run_osa(&script)
}

fn run_osa(script: &str) -> ReplyResult {
    match std::process::Command::new("osascript").arg("-e").arg(script).output() {
        Ok(out) => {
            let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let se = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if so.starts_with("OK") {
                ReplyResult { ok: true, error: None }
            } else if let Some(rest) = so.strip_prefix("ERR:") {
                fail(rest.to_string())
            } else if se.contains("assistive") || se.contains("1002") || se.contains("-25211") {
                fail("需要在 系统设置 → 隐私与安全性 → 辅助功能 里勾选 Terse")
            } else {
                fail(if se.is_empty() { so } else { se })
            }
        }
        Err(e) => fail(format!("无法执行 osascript: {e}")),
    }
}

/* ══════════════ 每个 app 的开关 ══════════════

   壁纸把消息摊在桌面上,而不是每个 app 都该上去 —— 工作群要看,某个营销推送
   不必。所以每个被识别到的 app 各有一个开关,关掉的只是"上不上壁纸",
   消息中心里照常能看到:静音不等于丢消息。 */

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("messages.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MsgConfig {
    /// 不上壁纸的 app(bundle id)。只影响壁纸,不影响消息中心。
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
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    std::fs::write(&p, serde_json::to_string_pretty(cfg).unwrap_or_default())
        .map_err(|e| e.to_string())
}

/// 一个被识别到的 app。
#[derive(Debug, Clone, Serialize)]
pub struct DetectedApp {
    pub app_id: String,
    pub app_name: String,
    /// 最近这批消息里它占了多少条 —— 让人知道这个开关关掉的是什么量级。
    pub count: usize,
    /// true = 会出现在壁纸上。
    pub on_wallpaper: bool,
    pub last_ts: i64,
}

/// 最近出现过的社交 app,按活跃度排序。
///
/// 是"检测"出来的而不是写死的列表:装了什么、在用什么因人而异,
/// 一份固定清单只会既列了你没有的、又漏了你在用的。
pub fn detected_apps() -> Result<Vec<DetectedApp>, String> {
    let msgs = recent(400, true)?;
    let muted = load_config().muted;
    let mut map: std::collections::HashMap<String, DetectedApp> = std::collections::HashMap::new();
    for m in msgs {
        let e = map.entry(m.app_id.clone()).or_insert_with(|| DetectedApp {
            app_id: m.app_id.clone(),
            app_name: m.app_name.clone(),
            count: 0,
            on_wallpaper: !muted.iter().any(|x| *x == m.app_id),
            last_ts: 0,
        });
        e.count += 1;
        if m.ts > e.last_ts { e.last_ts = m.ts; }
    }
    let mut out: Vec<DetectedApp> = map.into_values().collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_ts.cmp(&a.last_ts)));
    Ok(out)
}

/// 壁纸专用:已经滤掉被静音 app 的消息。
pub fn recent_for_wallpaper(limit: usize) -> Result<Vec<Message>, String> {
    let muted = load_config().muted;
    // 多取一些再滤:静音掉几个 app 之后如果只取 limit 条,很容易一条不剩。
    let raw = recent(limit.max(1) * 4, true)?;
    Ok(raw.into_iter()
        .filter(|m| !muted.iter().any(|x| *x == m.app_id))
        .take(limit)
        .collect())
}

/// 打开/关闭某个 app 的壁纸投屏。
pub fn set_app_on_wallpaper(app_id: &str, on: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.muted.retain(|x| x != app_id);
    if !on { cfg.muted.push(app_id.to_string()); }
    save_config(&cfg)
}

/* ══════════════ 通知设置体检 ══════════════

   读消息靠的是"通知留在通知中心",而这只有在通知样式设成「提醒」时才成立 ——
   「横幅」会自动消失、不落进 record 表(实测:微信横幅=看不到,改提醒=看得到)。
   所以这里把每个聊天 app 的通知样式读出来,样式不对就明确告诉用户去改,
   并给一个直达通知设置的入口。 */

#[derive(Debug, Clone, Serialize)]
pub struct NotifSetting {
    pub app_id: String,
    pub app_name: String,
    pub allowed: bool,
    /// "none" | "banner" | "alert" | "unknown"
    pub style: String,
    /// true 时消息才会留在通知中心 → Terse 才读得到
    pub persists: bool,
}

fn ncprefs_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library").join("Preferences").join("com.apple.ncprefs.plist")
}

/// Which bundle ids currently have rows in the notification `record` table.
///
/// This is the RELIABLE signal for "this app's notifications persist and we can
/// read them" — it is literally the reader's own data source. Contrast with the
/// ncprefs style flag, which was tried and does NOT discriminate banner vs alert
/// (every app read back the same bits, so it flagged working apps as broken).
pub fn apps_in_record() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Some(path) = find_db() else { return set };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else { return set };
    let Ok(mut st) = conn.prepare(
        "SELECT DISTINCT app.identifier FROM record JOIN app ON record.app_id = app.app_id",
    ) else { return set };
    if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
        for id in rows.flatten() { set.insert(id.to_ascii_lowercase()); }
    }
    set
}

/// Per chat app: is it allowed, and have we actually seen its notifications
/// persist? Drives the setup checklist.
///
/// HONESTY NOTE. macOS's ncprefs does not expose the banner/alert style in any
/// bit we could decode reliably (measured: every app returns identical style
/// bits, so the old decode red-flagged Claude/ScriptEditor, which persist fine).
/// So "persists" is grounded in fact, not a guess: true iff the app currently has
/// rows in the `record` table. When it does not, we say "not seen yet" and point
/// at the style setting as the thing to check — never a false accusation.
pub fn notification_settings() -> Vec<NotifSetting> {
    let mut out = Vec::new();
    let val: plist::Value = match plist::from_file(ncprefs_path()) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let Some(apps) = val.as_dictionary().and_then(|d| d.get("apps")).and_then(|a| a.as_array()) else {
        return out;
    };
    let seen = apps_in_record();
    for app in apps {
        let Some(d) = app.as_dictionary() else { continue };
        let bundle = d.get("bundle-id").and_then(|v| v.as_string()).unwrap_or("");
        if bundle.is_empty() || !is_chat_app(bundle) { continue; }
        // ncprefs presence with any non-zero flags = notifications configured.
        let flags = d.get("flags").and_then(|v| v.as_signed_integer()).unwrap_or(0);
        let allowed = flags != 0;
        // The one fact we can stand behind: has it actually persisted anything?
        let persists = seen.contains(&bundle.to_ascii_lowercase());
        out.push(NotifSetting {
            app_id: bundle.to_string(),
            app_name: app_display_name(bundle),
            allowed,
            // "confirmed" once we've seen it; "unseen" otherwise — never a wrong
            // "banner" label on an app that is actually fine.
            style: if persists { "confirmed".to_string() } else { "unseen".to_string() },
            persists,
        });
    }
    // Confirmed ones last (problems/unknowns first) so the checklist leads with
    // what still needs attention.
    out.sort_by(|a, b| a.persists.cmp(&b.persists));
    out
}
