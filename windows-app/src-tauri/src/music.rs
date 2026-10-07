//! 音乐模式 (Windows) —— the Windows half of `src-tauri/src/music.rs`.
//!
//! Everything about LYRICS is the macOS file unchanged: the LRCLIB and 网易云
//! lookups, the duration matching, the .lrc parsing and the on-disk cache. Only
//! the answer to "what is playing right now" is platform work, and here it is
//! better than it is there: Windows publishes it as a documented WinRT service
//! (the system media transport controls — the source behind the volume flyout's
//! media tile), so there is no JXA reader, no stderr trap, and no automation
//! prompt. Spotify, browsers, Apple Music for Windows, 网易云 — anything that
//! shows in that flyout reports here.
//!
//! Two consequences worth knowing:
//!   · The timeline is documented too (position, end time, last-updated), so
//!     `elapsed` / `duration` / `ts` come from the system rather than from a
//!     player's own reporting, and `playing` is the session's own PlaybackStatus
//!     rather than a `rate` field that some players leave at 0 forever.
//!   · SMTC does not hand over a FILE PATH, exactly as MediaRemote does not, so
//!     the two local tiers (a sidecar .lrc, tags inside the file) cannot run and
//!     lookup starts at LRCLIB. The code for those tiers is kept so the two
//!     files stay comparable.

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
    // The same keys the macOS probe prints, because the music page reads them by
    // name: `isPlaying` decides "paused" vs "playing", `age` how stale the
    // player's last report is.
    match snapshot() {
        Some(r) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            serde_json::json!({
                "app": r.app, "bundle": r.aumid,
                "title": r.title, "artist": r.artist, "album": r.album,
                "duration": r.duration, "elapsed": r.elapsed, "rate": r.rate,
                "isPlaying": if r.playing { 1 } else { 0 },
                "age": if r.updated > 0.0 { (now - r.updated).max(0.0).round() } else { -1.0 },
            })
        }
        // Not `unsupported`: Windows always has the service, it just has no
        // session right now — the page then says "nothing playing yet".
        None => serde_json::json!({}),
    }
}



/* ── MediaRemote:在放什么 + 播到第几秒 ─────────────────────────────────── */




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
    let out = crate::hidden_command("curl")
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

fn local_track_path(_bundle: &str) -> Option<std::path::PathBuf> {
    // The system media transport controls do not hand over a file path — the
    // same hole MediaRemote has on macOS, which is why the Mac asks Music.app
    // directly through AppleScript. Windows has no single player to ask, so the
    // two local tiers never run here and lookup starts at LRCLIB. The tier code
    // below is kept so the two copies of this file stay comparable.
    None
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
    let out = crate::hidden_command("curl")
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

/// One reading of the system's now-playing session.
struct Snap {
    app: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    elapsed: f64,
    playing: bool,
    rate: f64,
    /// Unix seconds when the player last published `elapsed`; 0 = it never says.
    updated: f64,
    /// "Spotify.exe", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", …
    aumid: String,
}

/// Ask the system what is playing, right now.
///
/// macOS reads MediaRemote through a long-lived JXA child whose output arrives
/// on stderr; Windows publishes the same thing as a WinRT service that can
/// simply be asked, so this is a plain call with nothing to keep alive.
fn snapshot() -> Option<Snap> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    let mgr = Manager::RequestAsync().ok()?.get().ok()?;
    let session = mgr.GetCurrentSession().ok()?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
    if title.trim().is_empty() {
        return None;
    }
    let info = session.GetPlaybackInfo().ok();
    let playing = info
        .as_ref()
        .and_then(|i| i.PlaybackStatus().ok())
        .map(|st| st == Status::Playing)
        .unwrap_or(false);
    // The timeline. `Position` is where the track was at `LastUpdatedTime`, not
    // now: most players only update it on play, pause and seek. Reporting it as
    // the position "now" would snap the lyrics back to the last seek on every
    // poll. So the snapshot is passed on exactly as the Mac's is — elapsed at a
    // moment — and the page extrapolates `elapsed + (now - ts) * rate`.
    let tl = session.GetTimelineProperties().ok();
    let secs = |x: windows::Foundation::TimeSpan| x.Duration as f64 / 10_000_000.0;
    let duration = tl
        .as_ref()
        .map(|t| {
            t.EndTime().map(secs).unwrap_or(0.0) - t.StartTime().map(secs).unwrap_or(0.0)
        })
        .unwrap_or(0.0)
        .max(0.0);
    let elapsed = tl
        .as_ref()
        .and_then(|t| t.Position().ok())
        .map(secs)
        .unwrap_or(0.0)
        .max(0.0);
    // A FILETIME: 100 ns ticks since 1601. Zero (or nonsense) when the player
    // publishes no timeline at all.
    let updated = tl
        .as_ref()
        .and_then(|t| t.LastUpdatedTime().ok())
        .map(|d| (d.UniversalTime - 116_444_736_000_000_000) as f64 / 10_000_000.0)
        .unwrap_or(0.0);
    // The rate is optional and some players never set it, and several leave it
    // at 1.0 while paused — so it is only believed while `playing` says so. That
    // flag is the session's own PlaybackStatus, the same "trust the system's
    // is-playing, not the rate" rule the macOS note arrived at.
    let rate = if playing {
        info.as_ref()
            .and_then(|i| i.PlaybackRate().ok())
            .and_then(|r| r.Value().ok())
            .filter(|r| *r > 0.0)
            .unwrap_or(1.0)
    } else {
        0.0
    };
    let aumid = session
        .SourceAppUserModelId()
        .map(|h| h.to_string_lossy())
        .unwrap_or_default();
    Some(Snap {
        app: aumid
            .rsplit('!')
            .next()
            .unwrap_or(&aumid)
            .trim_end_matches(".exe")
            .split('.')
            .next_back()
            .unwrap_or(&aumid)
            .to_string(),
        title,
        artist: props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default(),
        album: props.AlbumTitle().map(|h| h.to_string_lossy()).unwrap_or_default(),
        duration,
        elapsed,
        playing,
        rate,
        updated,
        aumid: aumid.clone(),
    })
}

/// The loop that keeps the page fed. Polled every two seconds, the same cadence
/// the macOS reader pushes at — the page extrapolates between pushes, so the
/// lyrics do not step.
fn spawn_reader(app: tauri::AppHandle) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut last_track = String::new();
        while ON.load(Ordering::Relaxed) {
            if let Some(r) = snapshot() {
                let track = format!("{}\u{1}{}", r.artist, r.title);
                let (lines, source) = if track != last_track {
                    last_track = track;
                    fetch_lyrics(&r.aumid, &r.artist, &r.title, &r.album, r.duration)
                } else {
                    // Same track: the lyrics are already in hand, and the page
                    // wants the whole state every time.
                    STATE
                        .lock()
                        .ok()
                        .and_then(|s| s.clone())
                        .map(|s| (s.lines, s.source))
                        .unwrap_or_default()
                };
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                // Believe the player's timestamp only when it is a real moment in
                // the past (and not older than the track itself). A player with
                // no timeline leaves it at zero; then the page must run the clock
                // itself from what was last reported, or the lyrics pin to one line.
                let ts_ok = r.updated > 0.0
                    && r.updated <= now + 2.0
                    && (r.duration <= 0.0 || now - r.updated <= r.duration + 30.0);
                let has_timeline = r.duration > 0.0 && ts_ok;
                let self_clock = r.playing && !has_timeline;
                let ts = if ts_ok { r.updated.min(now) } else { now };
                let st = MusicState {
                    app: r.app,
                    bundle: r.aumid,
                    title: r.title,
                    artist: r.artist,
                    album: r.album,
                    duration: r.duration,
                    elapsed: r.elapsed,
                    ts,
                    // Same contract as the Mac: rate 0 + self_clock → the page's own clock.
                    rate: if self_clock { 0.0 } else { r.rate },
                    lines,
                    source,
                    age: (now - ts).max(0.0),
                    playing: r.playing,
                    self_clock,
                };
                if let Ok(mut s) = STATE.lock() {
                    *s = Some(st.clone());
                }
                let _ = app.emit("music-state", &st);
            } else {
                // Nothing playing any more: say so, rather than leaving the last
                // track's lyrics on the wallpaper.
                if !last_track.is_empty() {
                    last_track.clear();
                    if let Ok(mut s) = STATE.lock() {
                        *s = None;
                    }
                    let _ = app.emit("music-state", serde_json::json!({}));
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}
