// Ported from src-tauri/src/feeds.rs.
//
// Two of the three sources carry over as they are: notifications come from the
// same messages module (which reads Windows' Action Center here instead of
// Notification Center), and window titles come from ax_read — a real
// implementation on Windows rather than an Accessibility grant. The third,
// "what is playing", is macOS MediaRemote and has no Windows implementation
// yet; it says so once in the log instead of appearing as a source that never
// produces anything.
//
// The macOS-only helpers (mod mac, the JXA reader) are removed rather than
// left behind cfg, so this file only contains code that runs here. The part
// that decides WHAT to show — one new title per source per scan, forget a
// window when it closes — is copied unchanged: that is what keeps the feed
// readable, and it is not platform work.
//! 信息流 —— everything Terse can see flowing past on this Mac, as one stream
//! for the wallpaper's big text.
//!
//! Three kinds of source, each read the cheapest way that needs no new grant:
//!
//!   · 通知 / 系统 — every app's notifications, from the Notification Center
//!     database `messages.rs` already reads (Full Disk Access). No longer only
//!     chat apps: a build finishing or a calendar alert is information too, and
//!     the user can switch any single app off.
//!   · 窗口 — the title of every on-screen window, via Accessibility (already
//!     granted for replies). CGWindowList gives the owners without Screen
//!     Recording; the titles come from AX, not from `kCGWindowName`, which is
//!     the part Screen Recording would gate. A browser window's title is its
//!     active tab, so a new page or video shows up here as it opens.
//!   · 媒体 — whatever is playing (music, a YouTube / Bilibili video in a
//!     browser), from MediaRemote. Since macOS 15.4 mediaremoted refuses
//!     unentitled callers, but `osascript` is allowed through, so a long-lived
//!     JXA loop does the reading and prints one JSON line per change.
//!
//! Every source has a switch. Defaults follow the user's rule: at first run
//! everything found is on; after that, a newly discovered source is added
//! (when `auto_add`) and a prompt asks whether to keep it.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// How long after the very first start everything found counts as "already
/// there" rather than "new". The media reader reports a few seconds after the
/// window scan, so a single tick would prompt for things that were there all along.
const BASELINE_SECS: i64 = 30;
/// Window/media events kept in memory for the wallpaper.
const MAX_LIVE: usize = 300;
/// One window source may put a new title on the wallpaper at most this often —
/// a terminal whose title ticks every few seconds should not own the big text.
const WINDOW_GAP_SECS: i64 = 10;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn yes() -> bool { true }

/* ══════════════ 配置 ══════════════ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    /// `notif:<bundle>` · `window:<bundle>` · `media:<bundle>` (bundle lower-cased)
    pub key: String,
    /// "notif" | "system" | "window" | "media"
    pub kind: String,
    pub app_id: String,
    pub name: String,
    /// On the wallpaper.
    pub on: bool,
    /// Discovered after the baseline and not yet answered in the prompt.
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub first_seen: i64,
    #[serde(default)]
    pub last_seen: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedConfig {
    /// First-run discovery is over; anything found from now on is "new".
    #[serde(default)]
    pub baselined: bool,
    /// New sources start playing (and the prompt offers to remove them) rather
    /// than waiting silently for a yes.
    #[serde(default = "yes")]
    pub auto_add: bool,
    #[serde(default)]
    pub sources: HashMap<String, Source>,
    /// Which source families ("notif" / "window" / "media") are past their
    /// baseline. Per family, not global: a family whose permission arrives late
    /// (Accessibility on a fresh unsigned build) would otherwise find every open
    /// window *after* a global baseline had passed, and prompt for all of them.
    #[serde(default)]
    pub baselined_kinds: Vec<String>,
}

impl Default for FeedConfig {
    fn default() -> Self {
        FeedConfig { baselined: false, auto_add: true, sources: HashMap::new(), baselined_kinds: Vec::new() }
    }
}

/// The baseline unit of a source key: the part before the colon.
fn unit(key: &str) -> &str {
    key.split(':').next().unwrap_or("")
}

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("feeds.json")
}

fn load() -> FeedConfig {
    if let Some(cfg) = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<FeedConfig>(&t).ok())
    {
        let mut cfg = cfg;
        // Written by the single-flag version: every family it had seen counts
        // as baselined; a family it never saw still gets its own baseline.
        if cfg.baselined && cfg.baselined_kinds.is_empty() {
            let mut kinds: Vec<String> = cfg.sources.keys().map(|k| unit(k).to_string()).collect();
            kinds.sort();
            kinds.dedup();
            cfg.baselined_kinds = kinds;
        }
        return cfg;
    }
    // First run of this feature: carry over the apps muted under the old
    // per-app switch, so upgrading never un-mutes anything.
    let mut cfg = FeedConfig::default();
    for id in crate::messages::load_config().muted {
        let lower = id.to_ascii_lowercase();
        let key = format!("notif:{lower}");
        cfg.sources.insert(key.clone(), Source {
            kind: notif_kind(&lower).into(),
            name: crate::messages::app_display_name(&lower),
            app_id: lower, key, on: false, pending: false, first_seen: now(), last_seen: 0,
        });
    }
    cfg
}

static CFG: LazyLock<Mutex<FeedConfig>> = LazyLock::new(|| Mutex::new(load()));

fn save(cfg: &FeedConfig) {
    let p = config_path();
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    let _ = std::fs::write(&p, serde_json::to_string_pretty(cfg).unwrap_or_default());
}

fn cfg() -> std::sync::MutexGuard<'static, FeedConfig> {
    CFG.lock().unwrap_or_else(|e| e.into_inner())
}

/// Is this source on the wallpaper? A source not seen by the scanner yet
/// follows the same default a newly found one would get.
fn is_on(c: &FeedConfig, key: &str) -> bool {
    c.sources.get(key).map(|s| s.on)
        .unwrap_or(c.auto_add || !c.baselined_kinds.iter().any(|u| u == unit(key)))
}

/// System notifications are the `com.apple.*` ones that are not messaging.
fn notif_kind(bundle: &str) -> &'static str {
    // The Windows equivalent of "com.apple.*": an AppUserModelID belonging to
    // Windows itself. Those are the build-finished and security alerts, as
    // opposed to a person messaging you.
    let l = bundle.to_ascii_lowercase();
    let from_windows = l.starts_with("microsoft.windows.")
        || l.starts_with("windows.")
        || l.contains("\\windows\\")
        || l.starts_with("microsoft.") && !crate::messages::is_chat_app(bundle);
    if from_windows && !crate::messages::is_chat_app(bundle) { "system" } else { "notif" }
}

/* ══════════════ 条目 ══════════════ */

/// One thing for the big text. Field names match `messages::Message` so the
/// wallpaper renders a notification and a window title the same way.
#[derive(Debug, Clone, Serialize)]
pub struct FeedItem {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub app_id: String,
    pub app_name: String,
    pub sender: String,
    pub group: Option<String>,
    pub body: String,
    pub ts: i64,
}

#[derive(Default)]
struct Live {
    items: VecDeque<FeedItem>,
    /// window source → titles already put on the wallpaper and still open
    shown: HashMap<String, HashSet<String>>,
    /// window source → titles seen on the previous scan (a title must survive
    /// two scans before it counts, so a counter in a title bar is not news)
    prev: HashMap<String, HashSet<String>>,
    last_emit: HashMap<String, i64>,
    seq: u64,
}

static LIVE: LazyLock<Mutex<Live>> = LazyLock::new(|| Mutex::new(Live::default()));

fn live() -> std::sync::MutexGuard<'static, Live> {
    LIVE.lock().unwrap_or_else(|e| e.into_inner())
}

fn push_item(mut it: FeedItem) {
    let mut l = live();
    l.seq += 1;
    it.id = format!("{}-{}-{}", it.source, it.ts, l.seq);
    l.items.push_front(it);
    while l.items.len() > MAX_LIVE { l.items.pop_back(); }
}

/* ══════════════ 发现 ══════════════ */

struct Seen { key: String, kind: &'static str, app_id: String, name: String }

/// Record every source seen this tick; returns the ones that are new since
/// their family's baseline, which is what the prompt is for.
///
/// `first_report` is when each family first produced anything in this run. A
/// family's baseline runs from THAT moment, not from app start — so window
/// titles that only become readable once Accessibility is granted are treated
/// as "already open", not as a burst of new sources.
fn observe(seen: Vec<Seen>, first_report: &mut HashMap<String, i64>) -> Vec<Source> {
    let t = now();
    let mut c = cfg();
    let mut fresh = Vec::new();
    let mut changed = false;
    for s in &seen {
        first_report.entry(unit(&s.key).to_string()).or_insert(t);
    }
    for (u, t0) in first_report.iter() {
        if t - t0 >= BASELINE_SECS && !c.baselined_kinds.iter().any(|x| x == u) {
            c.baselined_kinds.push(u.clone());
            c.baselined = true;
            changed = true;
        }
    }
    for s in seen {
        if let Some(src) = c.sources.get_mut(&s.key) {
            src.last_seen = t;
            continue;
        }
        let base = c.baselined_kinds.iter().any(|x| x == unit(&s.key));
        let src = Source {
            key: s.key.clone(), kind: s.kind.into(), app_id: s.app_id, name: s.name,
            on: c.auto_add || !base, pending: base,
            first_seen: t, last_seen: t,
        };
        if src.pending { fresh.push(src.clone()); }
        c.sources.insert(s.key, src);
        changed = true;
    }
    if changed { save(&c); }
    fresh
}

/// Ask about new sources: a toast per source (a summary card past three), and
/// an event for the message page so the question is still there after the
/// toast has gone.
fn prompt(app: &AppHandle, fresh: &[Source]) {
    if fresh.is_empty() { return; }
    let auto = cfg().auto_add;
    let _ = app.emit("feeds-new", fresh);
    let Some(win) = app.get_webview_window("toast") else { return };
    let _ = win.show();
    let label = |k: &str| match k { "window" => "窗口", "media" => "正在播放", "system" => "系统通知", _ => "通知" };
    let body = if auto { "已加入壁纸大字。不想看就点「不要」,随时可以在 消息 → 信息流 里改。" }
               else { "要把它放进壁纸大字吗?之后也可以在 消息 → 信息流 里开关。" };
    for s in fresh.iter().take(3) {
        let _ = app.emit_to("toast", "terse-toast", serde_json::json!({
            "id": format!("feed-{}", s.key), "kind": "feed", "severity": "low", "ts": now(),
            "title": format!("发现新信息流 · {} · {}", s.name, label(&s.kind)),
            "body": body, "feedKey": s.key, "feedOn": s.on,
        }));
    }
    if fresh.len() > 3 {
        let _ = app.emit_to("toast", "terse-toast", serde_json::json!({
            "id": format!("feed-more-{}", now()), "kind": "feed", "severity": "low", "ts": now(),
            "title": format!("还有 {} 个新信息流", fresh.len() - 3),
            "body": "在 消息 → 信息流 里逐个决定。", "action": "open-msgs",
        }));
    }
}

/* ══════════════ 窗口 ══════════════ */

/// Apps whose windows are chrome, not content.
const SKIP_WINDOW_APPS: &[&str] = &[
    // Windows: our own windows, and the shell surfaces that are always "open"
    // but are not something the user thinks of as a window of theirs.
    "terse", "explorer", "searchhost", "shellexperiencehost", "startmenuexperiencehost",
    "textinputhost", "applicationframehost", "systemsettings", "lockapp",
    "com.pruneai.app", "com.apple.dock", "com.apple.windowmanager", "com.apple.controlcenter",
    "com.apple.notificationcenterui", "com.apple.loginwindow", "com.apple.systemuiserver",
    "com.apple.spotlight", "com.apple.textinputmenuagent", "com.apple.screencaptureui",
];



/// Every on-screen window's title, the Windows way.
///
/// macOS needs an Accessibility grant for this and asks CGWindowList for the
/// owners; Windows needs no grant at all, so this is one EnumWindows pass for
/// the owning processes and then ax_read::window_titles per process. The
/// diffing below — one new title per source per scan, forget a window when it
/// closes so reopening it is news again — is copied unchanged from the macOS
/// version, because that logic is what makes the feed readable rather than a
/// firehose, and it has nothing to do with the platform.
#[cfg(target_os = "windows")]
mod win {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE,
        WS_EX_TOOLWINDOW,
    };

    /// Processes owning at least one window a person can actually see.
    pub fn onscreen_pids() -> Vec<u32> {
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let out = &mut *(lparam.0 as *mut Vec<u32>);
            if !IsWindowVisible(hwnd).as_bool() { return TRUE; }
            if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & (WS_EX_TOOLWINDOW.0 as isize) != 0 { return TRUE; }
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32).is_ok() && cloaked != 0 { return TRUE; }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 && !out.contains(&pid) { out.push(pid); }
            TRUE
        }
        let mut pids: Vec<u32> = Vec::new();
        unsafe { let _ = EnumWindows(Some(cb), LPARAM(&mut pids as *mut Vec<u32> as isize)); }
        pids
    }

    /// (id, display name) for a process — the executable's stem, which is what a
    /// person recognises: "chrome", "Code", "WeChat".
    pub fn app_of(pid: u32) -> Option<(String, String)> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(h);
            if !ok { return None; }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            let stem = std::path::Path::new(&full).file_stem()?.to_string_lossy().to_string();
            if stem.is_empty() { return None; }
            Some((stem.to_ascii_lowercase(), stem))
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_windows(names: &mut HashMap<u32, (String, String)>) -> Vec<Seen> {
    let mut seen = Vec::new();
    let t = now();
    let mut current: HashMap<String, (String, String, Vec<String>)> = HashMap::new();
    for pid in win::onscreen_pids() {
        let info = match names.get(&pid) {
            Some(i) => i.clone(),
            None => match win::app_of(pid) {
                Some(i) => { names.insert(pid, i.clone()); i }
                None => continue,
            },
        };
        let (bundle, name) = info;
        let lower = bundle.to_ascii_lowercase();
        if SKIP_WINDOW_APPS.contains(&lower.as_str()) || lower.contains("inputmethod") { continue; }
        let titles: Vec<String> = crate::ax_read::window_titles(pid, 6)
            .into_iter()
            // A window titled with its own app's name says nothing new.
            .filter(|s| s.chars().count() >= 2 && !s.eq_ignore_ascii_case(&name))
            .collect();
        let key = format!("window:{lower}");
        seen.push(Seen { key: key.clone(), kind: "window", app_id: lower.clone(), name: name.clone() });
        current.entry(key).or_insert_with(|| (lower, name, Vec::new())).2.extend(titles);
    }
    let mut l = live();
    let mut out = Vec::new();
    for (key, (app_id, name, titles)) in &current {
        let now_set: HashSet<String> = titles.iter().cloned().collect();
        let prev = l.prev.get(key).cloned().unwrap_or_default();
        let mut shown = l.shown.remove(key).unwrap_or_default();
        // Forget closed windows, so reopening one is news again.
        shown.retain(|s| now_set.contains(s));
        let last = l.last_emit.get(key).copied().unwrap_or(0);
        // One new title per source per scan, and not faster than WINDOW_GAP_SECS;
        // anything held back is still "not shown" and goes out on a later scan.
        if t - last >= WINDOW_GAP_SECS {
            if let Some(title) = titles.iter().find(|s| !shown.contains(*s) && prev.contains(*s)) {
                out.push(FeedItem {
                    id: String::new(), source: key.clone(), kind: "window".into(),
                    app_id: app_id.clone(), app_name: name.clone(),
                    sender: title.clone(), group: None, body: String::new(), ts: t,
                });
                shown.insert(title.clone());
                l.last_emit.insert(key.clone(), t);
            }
        }
        l.shown.insert(key.clone(), shown);
        l.prev.insert(key.clone(), now_set);
    }
    l.prev.retain(|k, _| current.contains_key(k));
    drop(l);
    for it in out { push_item(it); }
    seen
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn scan_windows(_names: &mut HashMap<u32, (String, String)>) -> Vec<Seen> { Vec::new() }

/* ══════════════ 通知来源 ══════════════ */

fn scan_notification_sources(names: &mut HashMap<String, String>) -> Vec<Seen> {
    crate::messages::apps_in_record()
        .into_iter()
        .filter(|b| !b.contains("pruneai") && !b.is_empty())
        .map(|b| {
            let name = names.entry(b.clone()).or_insert_with(|| pretty_name(&b)).clone();
            Seen { key: format!("notif:{b}"), kind: notif_kind(&b), app_id: b, name }
        })
        .collect()
}

fn pretty_name(bundle: &str) -> String {
    let known = crate::messages::app_display_name(bundle);
    // app_display_name falls back to the last bundle component; a real app
    // name from LaunchServices beats "scripteditor2".
    // macOS has a second chance here — LaunchServices knows an app's real name
    // when the bundle id does not. Windows already has the real thing: the id
    // IS the executable's stem, so there is nothing better to look up.
    known
}

/* ══════════════ 媒体 ══════════════ */

/// Long-lived JXA reader. `osascript` gets past the 15.4 MediaRemote
/// entitlement check where Terse itself would not; printing only on change
/// keeps the pipe quiet while nothing changes.
///
/// It exits once Terse is gone. It only ever prints on change, so nothing else
/// would tell it: a quit Terse used to leave the loop running forever, one more
/// orphan per launch. The test is `getppid() == 1` (reparented to launchd) —
/// NSRunningApplication looked like the obvious check and reported a live
/// parent as gone from JXA, which would have killed the reader on its first loop.
const NOW_PLAYING_JXA: &str = r#"
function run() {
  const MR = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
  MR.load;
  const R = $.NSClassFromString('MRNowPlayingRequest');
  if (!R || R.isNil()) { console.log(JSON.stringify({ unsupported: true })); return; }
  const s = (v) => { try { return (v === undefined || v === null || v.isNil()) ? '' : String(ObjC.unwrap(v)); } catch (e) { return ''; } };
  ObjC.bindFunction('getppid', ['int', []]);
  let last = null;
  while (true) {
    if ($.getppid() === 1) return;
    let line = '{}';
    try {
      const client = R.localNowPlayingPlayerPath.client;
      const info = R.localNowPlayingItem.nowPlayingInfo;
      const g = (k) => { try { return s(info.valueForKey(k)); } catch (e) { return ''; } };
      line = JSON.stringify({ app: s(client.displayName), bundle: s(client.bundleIdentifier),
        title: g('kMRMediaRemoteNowPlayingInfoTitle'), artist: g('kMRMediaRemoteNowPlayingInfoArtist') });
    } catch (e) { line = '{}'; }
    if (line !== last) { last = line; console.log(line); }
    delay(3);
  }
}
"#;

#[derive(Deserialize, Default)]
struct NowPlaying {
    #[serde(default)] app: String,
    #[serde(default)] bundle: String,
    #[serde(default)] title: String,
    #[serde(default)] artist: String,
    #[serde(default)] unsupported: bool,
}

/// Newly seen media sources, drained by the scanner tick so all discovery goes
/// through one place.
static MEDIA_SEEN: LazyLock<Mutex<Vec<(String, String)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn start_media_reader() {
    // macOS reads "what is playing" from MediaRemote through a long-lived JXA
    // reader. Windows exposes the same thing through the system media transport
    // controls, which is a real piece of work and is not done — so this source
    // simply never appears, rather than appearing and staying empty. Said once,
    // in the log, so the absence is findable.
    crate::diag_log("feeds", "now-playing source is macOS-only for now; no media items will appear");
}

/* ══════════════ 权限 ══════════════
   信息流靠两个只有用户能给的权限:完全磁盘访问(读通知)和辅助功能(读窗口标题)。
   Terse 没签名,每次重新打包 macOS 都会作废旧的授权,而系统设置里那个勾看着还开着 ——
   人根本不会知道功能为什么停了。所以缺哪个就主动弹一张卡,点一下直接到能开的地方。
   30 分钟最多提醒一次,给了就不再出现。 */

const PERM_NAG_SECS: i64 = 30 * 60;

fn check_permissions(app: &AppHandle, last_nag: &mut HashMap<&'static str, i64>) {
    let t = now();
    let st = crate::messages::feed_status();
    // "no_database" is an OS layout we cannot read at all — a permission card
    // would send the user to grant something that would not help.
    let fda_missing = !st.available && st.reason == "no_permission";
    #[cfg(target_os = "macos")]
    let ax_missing = !crate::ax_read::is_trusted();
    #[cfg(not(target_os = "macos"))]
    let ax_missing = false;
    let asks: [(&'static str, bool, &str, &str); 2] = [
        // Terse ships unsigned, so an update silently voids both grants while the
        // switches still LOOK on. The cards say so, because "it's already on"
        // is exactly what the user sees and why they would otherwise stop there.
        ("fulldisk", fda_missing, "信息流读不到通知",
         "要「完全磁盘访问权限」才能读各个 app 的通知。点「去开启」,在列表里打开 Terse。如果它看起来已经是开的,先关掉再打开一次(每次更新 Terse 之后都要这样)。"),
        ("accessibility", ax_missing, "信息流读不到窗口标题",
         "要「辅助功能」权限才能读窗口标题。点「去开启」找到 Terse:如果开关已经是开的,先关掉再打开一次(每次更新 Terse 之后都要这样)。"),
    ];
    for (which, missing, title, body) in asks {
        if !missing { last_nag.remove(which); continue; }
        if t - last_nag.get(which).copied().unwrap_or(0) < PERM_NAG_SECS { continue; }
        last_nag.insert(which, t);
        let Some(win) = app.get_webview_window("toast") else { continue };
        let _ = win.show();
        let _ = app.emit_to("toast", "terse-toast", serde_json::json!({
            "id": format!("feed-perm-{which}-{t}"), "kind": "feed", "severity": "medium", "ts": t,
            "title": title, "body": body, "permWhich": which,
        }));
    }
}

/// Take the user to the one place the missing permission can be switched on.
/// Accessibility has a real system prompt; Full Disk Access has no API at all,
/// so the most that can be done is open its list.
pub fn fix_permission(which: &str) {
    // Neither grant exists on Windows: window titles need no permission, and
    // there is no Full Disk Access to open a pane for. check_permissions never
    // raises either card here, so this should not be reachable — if it is, say
    // so rather than shelling out to a macOS URL that cannot work.
    crate::diag_log("feeds", &format!("fix_permission(\"{which}\") — nothing to grant on Windows"));
}

/* ══════════════ 主循环 ══════════════ */

/// Start watching. Call once from setup.
pub fn start(app: AppHandle) {
    start_media_reader();
    std::thread::spawn(move || {
        let mut first_report: HashMap<String, i64> = HashMap::new();
        let mut perm_nag: HashMap<&'static str, i64> = HashMap::new();
        let mut pid_names: HashMap<u32, (String, String)> = HashMap::new();
        let mut bundle_names: HashMap<String, String> = HashMap::new();
        let mut tick: u64 = 0;
        loop {
            let mut seen = scan_windows(&mut pid_names);
            // The notification store changes slowly; its source list every 20s is plenty.
            if tick % 5 == 0 { seen.extend(scan_notification_sources(&mut bundle_names)); }
            for (b, name) in MEDIA_SEEN.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
                seen.push(Seen { key: format!("media:{b}"), kind: "media", app_id: b, name });
            }
            // pids get reused; a small cache that is sometimes rebuilt is enough.
            if pid_names.len() > 200 { pid_names.clear(); }
            let fresh = observe(seen, &mut first_report);
            prompt(&app, &fresh);
            // First look ~8s in (the toast window exists by then), then once a minute.
            if tick % 15 == 2 { check_permissions(&app, &mut perm_nag); }
            tick += 1;
            std::thread::sleep(std::time::Duration::from_secs(4));
        }
    });
}

/* ══════════════ 给命令用的 ══════════════ */

/// The wallpaper's list: every switched-on source, newest first.
pub fn for_wallpaper(limit: usize) -> Vec<FeedItem> {
    let c = cfg().clone();
    let mut out: Vec<FeedItem> = Vec::new();
    if let Ok(msgs) = crate::messages::recent(limit.max(1) * 4, false) {
        for m in msgs {
            let key = format!("notif:{}", m.app_id.to_ascii_lowercase());
            if !is_on(&c, &key) { continue; }
            out.push(FeedItem {
                kind: notif_kind(&m.app_id.to_ascii_lowercase()).into(),
                source: key, id: m.id, app_id: m.app_id, app_name: m.app_name,
                sender: m.sender, group: m.group, body: m.body, ts: m.ts,
            });
        }
    }
    out.extend(live().items.iter().filter(|it| is_on(&c, &it.source)).cloned());
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out.truncate(limit);
    out
}

pub fn sources_json() -> serde_json::Value {
    let c = cfg().clone();
    let order = |k: &str| match k { "notif" => 0, "system" => 1, "window" => 2, "media" => 3, _ => 4 };
    let mut list: Vec<Source> = c.sources.into_values().collect();
    list.sort_by(|a, b| order(&a.kind).cmp(&order(&b.kind))
        .then(b.pending.cmp(&a.pending))
        .then(b.last_seen.cmp(&a.last_seen)));
    serde_json::json!({
        "autoAdd": c.auto_add,
        "baselined": c.baselined,
        "pending": list.iter().filter(|s| s.pending).count(),
        "sources": list,
        // macOS keeps this helper in lib.rs; here the ax_read shim already owns
        // the question, and its answer is always yes — reading window titles on
        // Windows needs no grant.
        "accessibility": crate::ax_read::is_trusted(),
    })
}

/// Switch one source. Answering the prompt goes through here too.
pub fn set_source(key: &str, on: bool) -> Result<(), String> {
    let mut c = cfg();
    let src = c.sources.get_mut(key).ok_or_else(|| format!("unknown source {key}"))?;
    src.on = on;
    src.pending = false;
    let app_id = src.app_id.clone();
    save(&c);
    drop(c);
    // Keep the old per-app mute list in step; the Windows build and older
    // wallpaper pages still read it.
    if let Some(_) = key.strip_prefix("notif:") {
        let _ = crate::messages::set_app_on_wallpaper(&app_id, on);
    }
    Ok(())
}

/// Called when the old notification switch is used, so both lists agree.
pub fn mirror_notif_switch(app_id: &str, on: bool) {
    let key = format!("notif:{}", app_id.to_ascii_lowercase());
    let mut c = cfg();
    if let Some(s) = c.sources.get_mut(&key) {
        s.on = on;
        s.pending = false;
        save(&c);
    }
}

pub fn set_auto_add(on: bool) {
    let mut c = cfg();
    c.auto_add = on;
    save(&c);
}

/// Answer every open prompt at once: keep them as they are (`on = None`), or
/// set them all on / off.
pub fn resolve_pending(on: Option<bool>) {
    let mut c = cfg();
    for s in c.sources.values_mut().filter(|s| s.pending) {
        s.pending = false;
        if let Some(v) = on { s.on = v; }
    }
    save(&c);
}
