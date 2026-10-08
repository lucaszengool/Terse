//! music.rs —— 音乐模式:认出正在播放的歌 → 取回**逐行带时间戳**的歌词 → 推给壁纸聚成粒子字。
//!
//! 这一条和 agent 那条文字是**两条独立的通道**:可以只开一条,也可以两条同时在壁纸上。
//! 所以这里不碰 `setAgentLog` 那套,壁纸那边接的是另一个事件(`music-state`)。
//!
//! ── 三件事分别从哪儿来 ───────────────────────────────────────────────────
//! 1. **在放什么**:MediaRemote(走 `osascript` 的 JXA)。
//!    macOS 15.4 之后 MediaRemote 只对有 entitlement 的进程开放,Terse 自己问不到,
//!    但 `osascript` 过得去 —— feeds.rs 里那条"正在播放"用的就是这个办法,这里沿用。
//!    ⚠ 和 feeds.rs 的 reader **是两个进程**:那条三秒才看一眼、只管"有没有在放",
//!    歌词要的是**播放进度**,采样密度和字段都不一样。音乐模式关着时这条根本不起。
//! 2. **播到第几秒**:MediaRemote 给的是 (elapsed, timestamp, rate) 三元组 ——
//!    elapsed 是**采样那一刻**的进度。所以前端自己算 `elapsed + (now - ts) * rate`,
//!    这边两秒推一次对表就够,不用一秒一次把 osascript 问烂。
//! 3. **歌词**:LRCLIB(https://lrclib.net)。免费、不要 key、专门给播放器用的同步歌词库,
//!    返回标准 LRC(`[mm:ss.xx] 一行`)。取回来缓存在 `~/.terse/lyrics/`,
//!    同一首歌只联网一次 —— 翻来覆去听一首歌不该每次都去敲人家服务器。
//!
//! ⚠ 一个会错得很安静的地方:LRCLIB 按 (artist, track, album, duration) 匹配,
//!   duration 差几秒就可能匹配不到。所以先按四件套精确查,落空再退回只按
//!   artist+track 搜一遍,取时长最接近的那条 —— 不然"有歌词但是找不到"会很常见。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

/// 音乐模式开着吗(`~/.terse/wallpaper.json` 的 `music`)。默认 false。
static ON: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Default, Debug)]
pub struct MusicState {
    /// 播放器名字(Music / Spotify / …)
    pub app: String,
    pub bundle: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 整首多长(秒)
    pub duration: f64,
    /// 采样那一刻的进度(秒)
    pub elapsed: f64,
    /// 采样那一刻的 Unix 时间(秒)—— 前端靠它把进度外推到"现在"
    pub ts: f64,
    /// 1 = 在放,0 = 暂停
    pub rate: f64,
    /// 逐行歌词。空 = 还没取到 / 这首没有
    pub lines: Vec<LyricLine>,
    /// 歌词是哪儿来的:'sidecar' | 'embedded' | 'lrclib' | 'netease' | 'cache' | ''(没有)
    pub source: String,
    /// 系统那份快照已经多久没更新了(秒)。播放器不汇报进度时这个数会一直涨。
    pub age: f64,
    /// **系统说它在播吗**(`MRNowPlayingRequest.localIsPlaying`)。
    /// 这才是可靠的那个 —— info 字典里的 `rate` 有的播放器常年报 0,
    /// 暂停和播放长得一模一样(网易云实测:暂停时 rate=0 且 elapsed 冻住,
    /// 而 localIsPlaying=0 / localPlaybackState=3 说得清清楚楚)。
    pub playing: bool,
    /// 播放器**有没有在维护进度**:在播、但 rate 还是 0 → 它不报进度,
    /// 前端得自己走钟,否则歌词会钉死在某一句。
    pub self_clock: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LyricLine {
    /// 这一行从第几秒开始
    pub t: f64,
    pub text: String,
}

static STATE: Mutex<Option<MusicState>> = Mutex::new(None);

/// 壁纸窗口刚起来时主动问一次 —— 不然要等到下一次换歌才有东西显示。
#[tauri::command]
pub fn music_state() -> Option<MusicState> {
    STATE.lock().ok().and_then(|s| s.clone())
}

/// 问一次系统:现在认出的是什么。**不依赖**那条常驻 reader ——
/// reader 没起来、或者刚打开开关还没轮到,页面也能如实显示现状(而不是一句
/// "还没检测到" 让人以为是没在放歌)。
#[tauri::command(async)]
pub fn music_probe() -> serde_json::Value {
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", PROBE_JXA])
        .output();
    let Ok(out) = out else { return serde_json::json!({ "error": "osascript 起不来" }) };
    // ⚠ 同上:JXA 的 console.log 在 stderr
    let txt = if out.stderr.is_empty() { String::from_utf8_lossy(&out.stdout).to_string() }
              else { String::from_utf8_lossy(&out.stderr).to_string() };
    serde_json::from_str::<serde_json::Value>(txt.trim())
        .unwrap_or_else(|_| serde_json::json!({ "error": txt.trim() }))
}

const PROBE_JXA: &str = r#"
function run() {
  const MR = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
  MR.load;
  const R = $.NSClassFromString('MRNowPlayingRequest');
  if (!R || R.isNil()) { console.log(JSON.stringify({ unsupported: true })); return; }
  const s = (v) => { try { return (v === undefined || v === null || v.isNil()) ? '' : String(ObjC.unwrap(v)); } catch (e) { return ''; } };
  const n = (v) => { try { return (v === undefined || v === null || v.isNil()) ? 0 : Number(ObjC.unwrap(v)) || 0; } catch (e) { return 0; } };
  try {
    const client = R.localNowPlayingPlayerPath.client;
    const info = R.localNowPlayingItem.nowPlayingInfo;
    const g = (k) => { try { return info.valueForKey(k); } catch (e) { return null; } };
    let ts = 0;
    try { const d = g('kMRMediaRemoteNowPlayingInfoTimestamp');
          if (d && !d.isNil()) ts = Number(d.timeIntervalSince1970) || 0; } catch (e) {}
    let playing = 0, pstate = -1;
    try { playing = ObjC.unwrap(R.localIsPlaying) ? 1 : 0; } catch (e) {}
    try { pstate = Number(ObjC.unwrap(R.localPlaybackState)) || 0; } catch (e) {}
    console.log(JSON.stringify({
      app: s(client.displayName), bundle: s(client.bundleIdentifier),
      title: s(g('kMRMediaRemoteNowPlayingInfoTitle')),
      artist: s(g('kMRMediaRemoteNowPlayingInfoArtist')),
      duration: n(g('kMRMediaRemoteNowPlayingInfoDuration')),
      elapsed: n(g('kMRMediaRemoteNowPlayingInfoElapsedTime')),
      rate: n(g('kMRMediaRemoteNowPlayingInfoPlaybackRate')),
      isPlaying: playing, state: pstate,
      age: ts ? Math.round(Date.now()/1000 - ts) : -1
    }));
  } catch (e) { console.log(JSON.stringify({ error: String(e) })); }
}
"#;

/* ── MediaRemote:在放什么 + 播到第几秒 ─────────────────────────────────── */

const NOW_PLAYING_JXA: &str = r#"
function run() {
  const MR = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
  MR.load;
  const R = $.NSClassFromString('MRNowPlayingRequest');
  if (!R || R.isNil()) { console.log(JSON.stringify({ unsupported: true })); return; }
  const s = (v) => { try { return (v === undefined || v === null || v.isNil()) ? '' : String(ObjC.unwrap(v)); } catch (e) { return ''; } };
  const n = (v) => { try { return (v === undefined || v === null || v.isNil()) ? 0 : Number(ObjC.unwrap(v)) || 0; } catch (e) { return 0; } };
  ObjC.bindFunction('getppid', ['int', []]);
  while (true) {
    // Terse 退出之后这条也要退 —— 被 launchd 收养(ppid 1)就是信号。
    // (feeds.rs 里记过:用 NSRunningApplication 判会误报父进程已死。)
    if ($.getppid() === 1) return;
    let line = '{}';
    try {
      const client = R.localNowPlayingPlayerPath.client;
      const item = R.localNowPlayingItem;
      const info = item.nowPlayingInfo;
      const g = (k) => { try { return info.valueForKey(k); } catch (e) { return null; } };
      let ts = 0;
      try { const d = g('kMRMediaRemoteNowPlayingInfoTimestamp');
            if (d && !d.isNil()) ts = Number(d.timeIntervalSince1970) || 0; } catch (e) {}
      let playing = 0, pstate = -1;
      try { playing = ObjC.unwrap(R.localIsPlaying) ? 1 : 0; } catch (e) {}
      try { pstate = Number(ObjC.unwrap(R.localPlaybackState)) || 0; } catch (e) {}
      line = JSON.stringify({
        app: s(client.displayName), bundle: s(client.bundleIdentifier),
        title: s(g('kMRMediaRemoteNowPlayingInfoTitle')),
        artist: s(g('kMRMediaRemoteNowPlayingInfoArtist')),
        album: s(g('kMRMediaRemoteNowPlayingInfoAlbum')),
        duration: n(g('kMRMediaRemoteNowPlayingInfoDuration')),
        elapsed: n(g('kMRMediaRemoteNowPlayingInfoElapsedTime')),
        rate: n(g('kMRMediaRemoteNowPlayingInfoPlaybackRate')),
        ts: ts,
        /* ⚠ 真正可靠的"在不在播"**不是** info 字典里的 rate —— 网易云这类客户端
           常年报 0,暂停和播放长得一模一样。MRNowPlayingRequest 上有现成的
           `localIsPlaying` / `localPlaybackState`(实测:暂停时 0 / 3),
           这才是系统自己的判断,而且对所有播放器一视同仁。 */
        isPlaying: playing, state: pstate
      });
    } catch (e) { line = '{}'; }
    console.log(line);     // 每次都打:进度一直在走,"只在变化时打"会把对表的机会掐掉
    delay(2);
  }
}
"#;

#[derive(Deserialize, Default)]
struct Raw {
    #[serde(default)] app: String,
    #[serde(default)] bundle: String,
    #[serde(default)] title: String,
    #[serde(default)] artist: String,
    #[serde(default)] album: String,
    #[serde(default)] duration: f64,
    #[serde(default)] elapsed: f64,
    #[serde(default)] rate: f64,
    #[serde(default)] ts: f64,
    #[serde(default)] isPlaying: u8,
    #[serde(default)] state: i32,
}

/* ── 歌词 ───────────────────────────────────────────────────────────────── */

fn lyrics_dir() -> std::path::PathBuf {
    let d = dirs::home_dir().unwrap_or_default().join(".terse").join("lyrics");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// 缓存文件名:artist+title+duration 的简易散列。歌名里什么字符都可能有,不能直接当文件名。
fn cache_key(artist: &str, title: &str, dur: f64) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{artist}\u{1}{title}\u{1}{}", dur.round() as i64).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// `[mm:ss.xx] 文字` → (秒, 文字)。一行可以挂多个时间戳(LRC 允许),都要展开。
fn parse_lrc(src: &str) -> Vec<LyricLine> {
    let mut out: Vec<LyricLine> = Vec::new();
    for line in src.lines() {
        let mut rest = line;
        let mut stamps: Vec<f64> = Vec::new();
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else { break };
            let tag = &rest[1..end];
            // [ar:…] [ti:…] 这类元信息不是时间戳,跳过(但要把它从行里剥掉)
            if let Some((m, s)) = tag.split_once(':') {
                if let (Ok(m), Ok(s)) = (m.trim().parse::<f64>(), s.trim().parse::<f64>()) {
                    stamps.push(m * 60.0 + s);
                }
            }
            rest = &rest[end + 1..];
        }
        let text = rest.trim();
        for t in stamps {
            // 空行也留着:它是"这一句唱完了"的信号,壁纸上要把字散掉
            out.push(LyricLine { t, text: text.to_string() });
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn curl_get(url: &str) -> Option<String> {
    let out = std::process::Command::new("curl")
        .args(["-s", "--connect-timeout", "4", "--max-time", "10",
               "-H", "User-Agent: Terse (https://www.terseai.org)", url])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        b' ' => "%20".into(),
        _ => format!("%{b:02X}"),
    }).collect()
}

/// 取歌词。优先级是**从准到猜**:
///
///   ① 文件旁边的 `.lrc`      —— 你自己放在那儿的,没有比这更准的
///   ② 文件里面的标签         —— USLT / ©lyr / VORBIS,很多人就把 LRC 塞在这儿
///   ③ LRCLIB                 —— 免费、不要账号;西文和 FOSS 那一圈最全
///   ④ 网易云                 —— 中文歌几乎都有,LRCLIB 经常没有
///
/// ①② 只在**放本地文件**时才可能有(路径得问播放器要,见 local_track_path)。
/// ③④ 都是拿歌名去匹配,所以都按**时长最接近**挑,差 >15s 一律丢弃 ——
/// 同名歌、翻唱、伴奏太多,不卡时长很容易配上另一个版本,整首词都对不上拍。
///
/// ⚠ 本地那两条取到的**不一定带时间戳**(USLT 本来就是"非同步歌词")。
/// 没有时间戳的词没法跟着唱,所以这里要求至少两行、且有一行时间 > 0.5s,
/// 不满足就当没拿到,继续往下走 —— 否则会用一堆 t=0 的行把整首歌钉在第一句上。
fn fetch_lyrics(bundle: &str, artist: &str, title: &str, album: &str, dur: f64)
    -> (Vec<LyricLine>, String)
{
    let key = cache_key(artist, title, dur);
    let path = lyrics_dir().join(format!("{key}.lrc"));
    let spath = lyrics_dir().join(format!("{key}.src"));
    if let Ok(s) = std::fs::read_to_string(&path) {
        let src = std::fs::read_to_string(&spath).unwrap_or_else(|_| "cache".into());
        return (parse_lrc(&s), src.trim().to_string());
    }

    let usable = |t: &str| -> Option<Vec<LyricLine>> {
        let l = parse_lrc(t);
        if l.len() >= 2 && l.iter().any(|x| x.t > 0.5) { Some(l) } else { None }
    };

    let mut found: Option<(Vec<LyricLine>, String, String)> = None;   // (行, 来源, 原文)

    // ①② 本地文件
    if let Some(file) = local_track_path(bundle) {
        if let Some(t) = sidecar_lrc(&file).and_then(|t| usable(&t).map(|l| (l, t))) {
            found = Some((t.0, "sidecar".into(), t.1));
        } else if let Some(t) = embedded_lyrics(&file).and_then(|t| usable(&t).map(|l| (l, t))) {
            found = Some((t.0, "embedded".into(), t.1));
        }
    }

    // ③ LRCLIB:先四件套精确查,落空再搜索
    if found.is_none() {
        let url = format!(
            "https://lrclib.net/api/get?artist_name={}&track_name={}&album_name={}&duration={}",
            enc(artist), enc(title), enc(album), dur.round() as i64);
        let mut synced = curl_get(&url)
            .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("syncedLyrics").and_then(|s| s.as_str()).map(|s| s.to_string()))
            // 精确匹配到的那条也要**能用**才算数,不能只看非空:LRCLIB 是人人可写的,
            // 2026-10-07 实测 Rick Astley 那首的精确条目被改成了一行 "[00:00.00]probe",
            // 只判非空的话就不再去搜索,明明库里有几十条好的,却显示"没找到歌词"。
            .filter(|s| usable(s.as_str()).is_some());
        if synced.is_none() {
            let surl = format!("https://lrclib.net/api/search?artist_name={}&track_name={}",
                               enc(artist), enc(title));
            if let Some(body) = curl_get(&surl) {
                if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(&body) {
                    let mut best: Option<(f64, String)> = None;
                    for it in arr {
                        let d = it.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let Some(sy) = it.get("syncedLyrics").and_then(|v| v.as_str()) else { continue };
                        if sy.trim().is_empty() { continue; }
                        let gap = if dur > 0.0 { (d - dur).abs() } else { 0.0 };
                        if best.as_ref().map(|(g, _)| gap < *g).unwrap_or(true) {
                            best = Some((gap, sy.to_string()));
                        }
                    }
                    synced = best.filter(|(g, _)| *g <= 15.0).map(|(_, sy)| sy);
                }
            }
        }
        if let Some(t) = synced.and_then(|t| usable(&t).map(|l| (l, t))) {
            found = Some((t.0, "lrclib".into(), t.1));
        }
    }

    // ④ 网易云
    if found.is_none() {
        if let Some(t) = netease_lyrics(artist, title, dur).and_then(|t| usable(&t).map(|l| (l, t))) {
            found = Some((t.0, "netease".into(), t.1));
        }
    }

    let (lines, src, text) = found.unwrap_or_default();
    // 没找到也写一个空缓存:不然每次播到这首都要把四条路再走一遍
    let _ = std::fs::write(&path, &text);
    let _ = std::fs::write(&spath, &src);
    (lines, src)
}

/* ── 本地文件自带的歌词(最准的一条)─────────────────────────────────────
   放本地文件时,词往往就在文件旁边或者文件里面 —— 这比拿歌名去库里猜准得多:
   没有同名歌配错版本的问题,也不用联网。Mineradio 的本地播放版就是这么做的。

   路径从哪儿来:MediaRemote **不给**文件路径,所以只能问播放器本人。
   Music.app 走 AppleScript(`location of current track`)—— 流媒体的曲目没有
   location,会抛错,当没有处理即可。别的播放器各有各的脚本接口,先只接 Music.app:
   在 Mac 上放本地文件的,十有八九就是它。

   ⚠ 第一次问会弹"允许 Terse 控制 Music.app"的自动化授权。拒绝了也不致命:
   这条路直接当没有,后面还有 LRCLIB 和网易云兜底。 */

fn local_track_path(bundle: &str) -> Option<std::path::PathBuf> {
    if !bundle.eq_ignore_ascii_case("com.apple.Music") { return None; }
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", r#"tell application "Music"
            if player state is stopped then return ""
            try
                return POSIX path of (get location of current track)
            on error
                return ""
            end try
        end tell"#])
        .output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { return None; }
    let path = std::path::PathBuf::from(p);
    if path.exists() { Some(path) } else { None }
}

/// 同名的 .lrc —— 最常见的"外置歌词"。
fn sidecar_lrc(path: &std::path::Path) -> Option<String> {
    for ext in ["lrc", "LRC"] {
        let p = path.with_extension(ext);
        if let Ok(s) = std::fs::read_to_string(&p) {
            if !s.trim().is_empty() { return Some(s); }
        }
    }
    None
}

/// 文件**里面**的歌词。三种容器各有各的放法,都只读前几 MB(标签都在开头)。
fn embedded_lyrics(path: &std::path::Path) -> Option<String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut buf = Vec::new();
    {
        use std::io::Read;
        let mut f = std::fs::File::open(path).ok()?;
        // 标签在文件头;读 4MB 足够,不去啃一首几十兆的无损
        f.by_ref().take(4 * 1024 * 1024).read_to_end(&mut buf).ok()?;
    }
    match ext.as_str() {
        "m4a" | "m4b" | "mp4" | "aac" => mp4_lyrics(&buf),
        "mp3" => id3_uslt(&buf),
        "flac" => flac_lyrics(&buf),
        _ => None,
    }
}

/// MP4/M4A:moov → udta → meta → ilst → `©lyr` → data。
/// ⚠ `meta` 是个 full box:size+type 之后还有 4 字节的 version/flags,
///   不跳过这 4 字节,下一层的 size 就会读成垃圾(这是解 m4a 最常见的坑)。
fn mp4_lyrics(buf: &[u8]) -> Option<String> {
    fn find(buf: &[u8], want: &[u8; 4], depth: usize) -> Option<Vec<u8>> {
        if depth > 6 { return None; }
        let mut i = 0usize;
        while i + 8 <= buf.len() {
            let size = u32::from_be_bytes([buf[i], buf[i+1], buf[i+2], buf[i+3]]) as usize;
            let typ = &buf[i+4..i+8];
            if size < 8 || i + size > buf.len() { break; }
            let body = &buf[i+8..i+size];
            if typ == want { return Some(body.to_vec()); }
            if matches!(typ, b"moov" | b"udta" | b"ilst") {
                if let Some(r) = find(body, want, depth + 1) { return Some(r); }
            }
            if typ == b"meta" && body.len() > 4 {
                if let Some(r) = find(&body[4..], want, depth + 1) { return Some(r); }
            }
            i += size;
        }
        None
    }
    let lyr = find(buf, b"\xA9lyr", 0)?;
    // 里面是一个 data box:size+type+4(version/flags)+4(locale)+文本
    let mut i = 0usize;
    while i + 8 <= lyr.len() {
        let size = u32::from_be_bytes([lyr[i], lyr[i+1], lyr[i+2], lyr[i+3]]) as usize;
        if size < 16 || i + size > lyr.len() { break; }
        if &lyr[i+4..i+8] == b"data" {
            return Some(String::from_utf8_lossy(&lyr[i+16..i+size]).to_string());
        }
        i += size;
    }
    None
}

/// MP3 的 ID3v2:USLT 帧(非同步歌词)。很多人往里面塞的其实是带时间戳的 LRC。
fn id3_uslt(buf: &[u8]) -> Option<String> {
    if buf.len() < 10 || &buf[0..3] != b"ID3" { return None; }
    let ver = buf[3];
    // 头里的大小是 synchsafe:每字节只用 7 位
    let total = ((buf[6] as usize & 0x7f) << 21) | ((buf[7] as usize & 0x7f) << 14)
              | ((buf[8] as usize & 0x7f) << 7) | (buf[9] as usize & 0x7f);
    let end = (10 + total).min(buf.len());
    let mut i = 10usize;
    while i + 10 <= end {
        let id = &buf[i..i+4];
        if id == b"\0\0\0\0" { break; }
        // ⚠ v4 的帧长是 synchsafe,v3 不是。按版本分,否则长帧会整条读歪
        let sz = if ver >= 4 {
            ((buf[i+4] as usize & 0x7f) << 21) | ((buf[i+5] as usize & 0x7f) << 14)
          | ((buf[i+6] as usize & 0x7f) << 7) | (buf[i+7] as usize & 0x7f)
        } else {
            u32::from_be_bytes([buf[i+4], buf[i+5], buf[i+6], buf[i+7]]) as usize
        };
        if sz == 0 || i + 10 + sz > end { break; }
        if id == b"USLT" {
            let f = &buf[i+10..i+10+sz];
            if f.len() < 4 { return None; }
            let enc = f[0];
            let rest = &f[4..];                       // 跳过 3 字节语言
            // 描述符和正文之间隔一个终止符:UTF-16 是两个字节
            let (desc_end, text) = match enc {
                1 | 2 => {
                    let mut j = 0;
                    while j + 1 < rest.len() && !(rest[j] == 0 && rest[j+1] == 0) { j += 2; }
                    (j + 2, &rest[(j + 2).min(rest.len())..])
                }
                _ => {
                    let j = rest.iter().position(|&b| b == 0).unwrap_or(0);
                    (j + 1, &rest[(j + 1).min(rest.len())..])
                }
            };
            let _ = desc_end;
            return Some(match enc {
                1 | 2 => decode_utf16(text),
                _ => String::from_utf8_lossy(text).to_string(),
            });
        }
        i += 10 + sz;
    }
    None
}

fn decode_utf16(b: &[u8]) -> String {
    if b.len() < 2 { return String::new(); }
    let (le, body) = match (b[0], b[1]) {
        (0xFF, 0xFE) => (true, &b[2..]),
        (0xFE, 0xFF) => (false, &b[2..]),
        _ => (true, b),
    };
    let u: Vec<u16> = body.chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&u)
}

/// FLAC:VORBIS_COMMENT(块类型 4)里的 LYRICS / UNSYNCEDLYRICS。
fn flac_lyrics(buf: &[u8]) -> Option<String> {
    if buf.len() < 4 || &buf[0..4] != b"fLaC" { return None; }
    let mut i = 4usize;
    loop {
        if i + 4 > buf.len() { return None; }
        let last = buf[i] & 0x80 != 0;
        let typ = buf[i] & 0x7f;
        let len = ((buf[i+1] as usize) << 16) | ((buf[i+2] as usize) << 8) | buf[i+3] as usize;
        let body = buf.get(i+4..i+4+len)?;
        if typ == 4 {
            let mut p = 0usize;
            let vlen = u32::from_le_bytes(body.get(p..p+4)?.try_into().ok()?) as usize;
            p += 4 + vlen;
            let n = u32::from_le_bytes(body.get(p..p+4)?.try_into().ok()?) as usize;
            p += 4;
            for _ in 0..n {
                let l = u32::from_le_bytes(body.get(p..p+4)?.try_into().ok()?) as usize;
                p += 4;
                let item = String::from_utf8_lossy(body.get(p..p+l)?).to_string();
                p += l;
                let up = item.to_ascii_uppercase();
                if up.starts_with("LYRICS=") || up.starts_with("UNSYNCEDLYRICS=") || up.starts_with("LRC=") {
                    return item.split_once('=').map(|(_, v)| v.to_string());
                }
            }
            return None;
        }
        if last { return None; }
        i += 4 + len;
    }
}

/* ── 网易云兜底 ─────────────────────────────────────────────────────────
   LRCLIB 的强项是西文和 FOSS 播放器那一圈;中文歌它经常没有,而网易云几乎都有。
   用的是不要登录的公开接口(验证过):
     搜索   /api/search/get?s=&type=1&limit=
     取词   /api/song/lyric?id=&lv=1&kv=1&tv=-1
   ⚠ 必须带 Referer: https://music.163.com,不带会被挡。
   ⚠ 搜出来的第一条经常是翻唱/伴奏 —— 所以同样按**时长最接近**挑,差 >15s 丢弃。 */
fn netease_lyrics(artist: &str, title: &str, dur: f64) -> Option<String> {
    let q = format!("{title} {artist}");
    let url = format!("https://music.163.com/api/search/get?s={}&type=1&limit=10", enc(&q));
    let body = curl_get_ref(&url, "https://music.163.com")?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let songs = v.get("result")?.get("songs")?.as_array()?;
    let mut best: Option<(f64, i64)> = None;
    for s in songs {
        let id = s.get("id").and_then(|x| x.as_i64())?;
        let d = s.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        let gap = if dur > 0.0 { (d - dur).abs() } else { 0.0 };
        if best.as_ref().map(|(g, _)| gap < *g).unwrap_or(true) { best = Some((gap, id)); }
    }
    let (gap, id) = best?;
    if dur > 0.0 && gap > 15.0 { return None; }
    let lurl = format!("https://music.163.com/api/song/lyric?id={id}&lv=1&kv=1&tv=-1");
    let lb = curl_get_ref(&lurl, "https://music.163.com")?;
    let lv: serde_json::Value = serde_json::from_str(&lb).ok()?;
    let lrc = lv.get("lrc").and_then(|l| l.get("lyric")).and_then(|x| x.as_str()).unwrap_or("");
    if lrc.trim().is_empty() { None } else { Some(lrc.to_string()) }
}

fn curl_get_ref(url: &str, referer: &str) -> Option<String> {
    let out = std::process::Command::new("curl")
        .args(["-s", "--connect-timeout", "4", "--max-time", "10",
               "-H", &format!("Referer: {referer}"),
               "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", url])
        .output().ok()?;
    if !out.status.success() { return None; }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/* ── 起停 ───────────────────────────────────────────────────────────────── */

fn read_flag() -> bool {
    crate::wallpaper_cfg().get("music").and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn start(app: tauri::AppHandle) {
    /* ⚠ 这里**不能只靠 `wallpaper-config` 事件**。
       第一版就是那样:开机读一次配置,之后等事件来再起 reader。结果用户在设置里
       打开开关之后,壁纸那边变了、这边却一直没动,音乐页永远显示"还没检测到" ——
       而系统其实认得出歌(实测:标题/艺人/时长都在)。
       一个只在"某个事件确实送到了"时才工作的东西,出问题时是**静默**的。
       改成每三秒看一眼配置:谁改的、怎么改的、事件有没有送到,都不影响。 */
    std::thread::spawn(move || loop {
        let on = read_flag();
        let was = ON.swap(on, Ordering::Relaxed);
        if !was && on { spawn_reader(app.clone()); }
        if was && !on {
            if let Ok(mut s) = STATE.lock() { *s = None; }
            let _ = app.emit("music-state", serde_json::json!({ "off": true }));
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    });
}

/// 读 JXA 的那条线程。音乐模式关掉时它自己退(JXA 那边也会跟着收到 EOF)。
fn spawn_reader(app: tauri::AppHandle) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) { return; }   // 已经有一条了
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        /* ⚠ **JXA 的 `console.log` 写的是 stderr,不是 stdout。**
           第一版读 stdout、把 stderr 丢进 /dev/null —— 于是 reader 一直活着、
           一直在吐,吐的每一行都被扔了,音乐页永远显示"还没检测到"。
           (feeds.rs 里那条早就是 `stdout(null) + stderr(piped)`,我没照着抄。)
           在终端里测不出来:终端默认把两条流一起显示,看着就"有输出"。 */
        let mut child = match std::process::Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", NOW_PLAYING_JXA])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn() {
            Ok(c) => c,
            Err(e) => { eprintln!("[music] 起不来 osascript: {e}"); RUNNING.store(false, Ordering::SeqCst); return; }
        };
        let stream = child.stderr.take().expect("piped");     // ⚠ 见上:JXA 走 stderr
        let mut last_track = String::new();
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if !ON.load(Ordering::Relaxed) { break; }
            let Ok(r) = serde_json::from_str::<Raw>(&line) else { continue };
            if r.title.trim().is_empty() { continue; }
            let track = format!("{}\u{1}{}", r.artist, r.title);
            let changed = track != last_track;
            let (lines, source) = if changed {
                last_track = track.clone();
                fetch_lyrics(&r.bundle, &r.artist, &r.title, &r.album, r.duration)
            } else {
                // 同一首歌:歌词不用再取,把上一次的带上(前端只认整份状态)
                STATE.lock().ok().and_then(|s| s.clone())
                    .map(|s| (s.lines, s.source)).unwrap_or_default()
            };
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let age = if r.ts > 0.0 { (now - r.ts).max(0.0) } else { 0.0 };
            let st = MusicState {
                app: r.app, bundle: r.bundle, title: r.title, artist: r.artist, album: r.album,
                duration: r.duration, elapsed: r.elapsed, ts: r.ts, rate: r.rate, lines, source,
                age,
                playing: r.isPlaying == 1,
                self_clock: r.isPlaying == 1 && r.rate <= 0.0,
            };
            if let Ok(mut s) = STATE.lock() { *s = Some(st.clone()); }
            let _ = app.emit("music-state", &st);
        }
        let _ = child.kill();
        RUNNING.store(false, Ordering::SeqCst);
    });
}
