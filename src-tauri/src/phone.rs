//! The link between this machine and the Terse phone web app.
//!
//! WHY THIS IS NOT `cowork`. cowork.rs already ships agent snapshots to the
//! cloud — but every one of its publishers returns early unless a TEAM token is
//! configured, and a person putting their own wallpaper on their own phone has
//! no team. Reusing that path would have meant inventing a team of one, with a
//! dashboard and members and an owner, for something that is really "this Mac,
//! that phone".
//!
//! WHAT TRAVELS. Exactly what the wallpaper window already reads for its own
//! HUD: today's token stats and the connected agent sessions. Nothing is
//! computed here that the desktop does not already show on its own screen.
//!
//! THREE THINGS KEEP IT QUIET, and all three matter on a laptop battery:
//!   · off unless the user turned it on (`share`)
//!   · nothing sent until a phone has actually claimed the pairing
//!   · nothing sent while no phone is watching — the server reports that back
//!     on every push, so a phone in a pocket costs one request every 30s
//!     instead of one every three seconds.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const API_BASE: &str = "https://www.terseai.org";

/// How often a frame goes out while someone is looking.
const PUSH_EVERY: Duration = Duration::from_secs(3);
/// How often we bother to ask whether anyone started looking again.
const IDLE_PROBE: Duration = Duration::from_secs(30);

/// The shortest gap between two notifications carrying the SAME tag.
const NOTIFY_EVERY: Duration = Duration::from_secs(15 * 60);

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PhoneConfig {
    /// The row id on the server. Only needed for display.
    pub link_id: Option<String>,
    /// This machine's bearer credential. The server stores only its hash.
    pub secret: Option<String>,
    /// Whether a phone has claimed the pairing yet.
    #[serde(default)]
    pub linked: bool,
    /// Master switch. Off by default: pushing what your agents are doing to a
    /// cloud relay is a decision, not a default.
    #[serde(default)]
    pub share: bool,
    pub device_name: Option<String>,
}

fn config_path() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".terse");
    p.push("phone.json");
    p
}

impl PhoneConfig {
    pub fn load() -> Self {
        std::fs::read_to_string(config_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let path = config_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, s);
        }
    }

    /// Everything the settings UI needs. The secret is deliberately NOT in here:
    /// it is this machine's credential and the renderer has no use for it.
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "paired": self.secret.is_some(),
            "linked": self.linked,
            "share": self.share,
            "deviceName": self.device_name,
        })
    }
}

/// Push pacing, kept out of the config so it is never written to disk.
struct Pacing {
    last_push: Option<Instant>,
    /// Whether a phone had the app open at the last push. Starts true so the
    /// very first frame after pairing always goes out.
    watching: bool,
}

static PACING: Mutex<Pacing> = Mutex::new(Pacing { last_push: None, watching: true });

/// When each tag was last sent. Not persisted: a restart is a fresh start, and
/// re-announcing a still-blocked agent once after one is the right behaviour.
static NOTIFIED: Mutex<BTreeMap<String, Instant>> = Mutex::new(BTreeMap::new());

// ── HTTP ───────────────────────────────────────────────────────────────────
// Shelling out to curl, the same way cowork.rs does. It keeps this module free
// of an async runtime and a TLS stack for what amounts to three requests.

fn curl(args: &[&str]) -> Option<serde_json::Value> {
    let out = std::process::Command::new("curl")
        .args(["-s", "--connect-timeout", "5", "--max-time", "10"])
        .args(args)
        .output()
        .ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

fn device_kind() -> &'static str {
    if cfg!(target_os = "windows") { "windows" } else { "mac" }
}

/// A name a person will recognise in a list on their phone. The hostname is the
/// only thing available that is actually theirs; the .local suffix Bonjour adds
/// is noise on a phone screen.
fn device_name() -> String {
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| if cfg!(target_os = "windows") { "Windows PC".into() } else { "Mac".into() });
    host.trim_end_matches(".local").to_string()
}

/// Ask the server for a fresh pair code. Returns the code and the URL that goes
/// into the QR — the URL comes from the server rather than being assembled here,
/// so the code in the QR and the page that redeems it cannot drift apart.
pub fn pair() -> Result<serde_json::Value, String> {
    let name = device_name();
    let body = serde_json::json!({ "device": device_kind(), "name": name }).to_string();
    let url = format!("{}/api/cloud/link/pair", API_BASE);
    let res = curl(&["-X", "POST", "-H", "Content-Type: application/json", "-d", &body, &url])
        .ok_or_else(|| "Could not reach Terse — check your connection".to_string())?;

    let secret = res["secret"].as_str().ok_or_else(|| {
        res["error"].as_str().unwrap_or("The server did not return a pairing code").to_string()
    })?;

    // A NEW pairing replaces the old one on this machine. Keeping both would
    // leave a secret on disk that nothing can ever reach again, and the user
    // would have no way to tell which of two codes is the live one.
    let mut cfg = PhoneConfig::load();
    cfg.link_id = res["id"].as_str().map(|s| s.to_string());
    cfg.secret = Some(secret.to_string());
    cfg.device_name = Some(name);
    cfg.linked = false;
    cfg.save();

    if let Ok(mut p) = PACING.lock() {
        p.last_push = None;
        p.watching = true;
    }

    Ok(serde_json::json!({
        "code": res["code"],
        "url": res["url"],
        "expiresIn": res["expires_in"],
    }))
}

/// Has a phone claimed it yet? Called on a timer by the pairing sheet, and once
/// on launch so the settings screen is honest about the machine's state.
pub fn status() -> serde_json::Value {
    let mut cfg = PhoneConfig::load();
    let secret = match cfg.secret.clone() {
        Some(s) => s,
        None => return cfg.snapshot(),
    };

    let url = format!("{}/api/cloud/link/status", API_BASE);
    let header = format!("x-terse-device: {}", secret);
    let res = match curl(&["-H", &header, &url]) {
        Some(r) => r,
        // Offline: report what we last knew rather than claiming to be unlinked.
        // "Not linked" would send the user off to re-pair a link that is fine.
        None => return cfg.snapshot(),
    };

    // A 401 means the phone unpaired this machine. The secret is dead, so
    // forgetting it is the honest response — anything else leaves the settings
    // screen claiming a link that no longer exists.
    if res["error"].is_string() && !res["linked"].is_boolean() {
        cfg.secret = None;
        cfg.link_id = None;
        cfg.linked = false;
        cfg.save();
        return cfg.snapshot();
    }

    let linked = res["linked"].as_bool().unwrap_or(false);
    if linked != cfg.linked {
        cfg.linked = linked;
        cfg.save();
    }
    if let (Ok(mut p), Some(w)) = (PACING.lock(), res["watching"].as_bool()) {
        p.watching = w;
    }
    cfg.snapshot()
}

/// Turn sharing on or off. Off takes effect on the next tick; nothing needs to
/// be torn down because nothing is held open.
pub fn set_share(on: bool) -> serde_json::Value {
    let mut cfg = PhoneConfig::load();
    cfg.share = on;
    cfg.save();
    cfg.snapshot()
}

/// Forget the pairing from this side. The phone's own list is unaffected — it
/// unpairs from there — but this machine stops pushing immediately.
pub fn unlink() -> serde_json::Value {
    let mut cfg = PhoneConfig::load();
    cfg.secret = None;
    cfg.link_id = None;
    cfg.linked = false;
    cfg.save();
    cfg.snapshot()
}

/// Ask the phone to interrupt its owner.
///
/// THIS SIDE DECIDES, not the server. The desktop already knows when an agent is
/// blocked on approval or a budget is about to break; the server sees only a
/// snapshot and would have to re-derive that badly. So the rule stays here and
/// the server just delivers.
///
/// Rate-limited per `tag`, because the conditions that call this are usually
/// evaluated on a scan tick — a blocked agent is still blocked on the next one,
/// and a phone that buzzes every few seconds gets its notifications turned off
/// for good. The same tag inside the window is dropped; a different one is not,
/// so a budget warning is never swallowed by an approval that fired first.
pub fn notify(title: &str, body: &str, tag: &str) -> bool {
    let cfg = PhoneConfig::load();
    if !cfg.share || !cfg.linked { return false; }
    let secret = match cfg.secret.clone() { Some(s) => s, None => return false };
    if body.trim().is_empty() { return false; }

    {
        let mut seen = match NOTIFIED.lock() { Ok(g) => g, Err(e) => e.into_inner() };
        let now = Instant::now();
        // Anything older than the window is not worth remembering, and pruning
        // here keeps this from growing for the life of the process.
        seen.retain(|_, at| now.duration_since(*at) < NOTIFY_EVERY);
        if seen.contains_key(tag) { return false; }
        seen.insert(tag.to_string(), now);
    }

    let body_json = serde_json::json!({ "title": title, "body": body, "tag": tag }).to_string();
    let url = format!("{}/api/cloud/link/notify", API_BASE);
    let header = format!("x-terse-device: {}", secret);
    curl(&["-X", "POST", "-H", "Content-Type: application/json",
           "-H", &header, "-d", &body_json, &url]).is_some()
}

/// Send one frame, if it is time and there is anyone to send it to.
///
/// Called from the agent scan loop, which already holds everything this needs —
/// so this adds no polling of its own. Returns quietly in every declined case:
/// it runs several times a second and must never be a place that logs.
pub fn maybe_push(stats: &serde_json::Value, sessions: &[serde_json::Value]) {
    let cfg = PhoneConfig::load();
    if !cfg.share || !cfg.linked { return; }
    let secret = match cfg.secret.clone() { Some(s) => s, None => return };

    {
        let mut p = match PACING.lock() { Ok(p) => p, Err(e) => e.into_inner() };
        // A phone that is not open still gets a frame occasionally — that is what
        // makes it show live data the instant it is unlocked, instead of a stale
        // one plus a wait. It is just far rarer than when someone is watching.
        let interval = if p.watching { PUSH_EVERY } else { IDLE_PROBE };
        if let Some(last) = p.last_push {
            if last.elapsed() < interval { return; }
        }
        p.last_push = Some(Instant::now());
    }

    let body = serde_json::json!({
        "stats": stats,
        // The phone renders at most a handful; sending forty would be bytes
        // nobody looks at, on a connection that may be cellular.
        "sessions": sessions.iter().take(8).collect::<Vec<_>>(),
    })
    .to_string();

    let url = format!("{}/api/cloud/link/push", API_BASE);
    let header = format!("x-terse-device: {}", secret);
    // The reply carries whether anyone is watching, which is the whole reason
    // this is not fire-and-forget.
    if let Some(res) = curl(&["-X", "POST", "-H", "Content-Type: application/json",
                              "-H", &header, "-d", &body, &url]) {
        if let (Ok(mut p), Some(w)) = (PACING.lock(), res["watching"].as_bool()) {
            p.watching = w;
        }
    }
}
