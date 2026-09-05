// Ported from src-tauri/src/projects.rs. The scan, the capsule format and the
// 64KB cap are deliberately IDENTICAL — a capsule built on Windows is uploaded
// to the same plaza and rebuilt by Mac viewers, so any drift here shows up as a
// project that renders differently depending on who made it.
//
// One function differs, and only because it has to: agent_dirs. See below.
//! projects.rs — 把一个项目文件夹压成一颗**粒子胶囊**。
//!
//! 这个功能的全部聪明之处在于:**粒子生成器早就有了**。壁纸引擎(mineradio)本来就
//! 会拿一张图,给每颗粒子取色、算一张边缘/深度图,再把统计数字聚成会浮现的字。所以
//! "把项目变成 3D 粒子"不需要任何新的渲染 —— 只需要给那台引擎换一组输入。
//!
//! 胶囊就是那组输入,而且**小到可以直接当参数传**:
//!
//!   { v, id, title, subtitle, tags, cover(224px 的 data URL), shots[], lines[], … }
//!
//! 一颗典型胶囊 8–20KB。上传的是它,不是图片、更不是渲染好的画面;别人收到之后在
//! **自己的机器上**跑同一台引擎生成同样的粒子。服务器只存 JSON,不渲染、不转码 ——
//! 这就是"服务器成本最小"的那条路,和 3D 场景流式传输里"传表示、不传帧"是同一个道理。
//!
//! 扫描只读三样东西:清单文件(package.json / Cargo.toml / pyproject.toml)、README、
//! 以及仓库里的图片文件本身。**不读任何源码内容** —— 又快又不越界。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 封面缩到多大。**96 太小了** —— 采样格子比像素还粗,粒子聚出来是一团认不出的
/// 色块(第一版就是这样)。224 能看清结构,一张 JPEG 仍旧只有 10–20KB,胶囊照样
/// 是"参数级"的大小。
const COVER_PX: u32 = 224;
/// 除封面外还带几张 —— 加上封面一共 5 张。
pub const MAX_SHOTS: usize = 4;
/// 单颗胶囊的硬上限(字节)。5 张 224px 的 JPEG 正常在 30–90KB。服务端也会再挡
/// 一次 —— 这是成本闸门,不是防御式编程,而且**客户端是可以被绕过的**,所以两边都挡。
pub const MAX_CAPSULE_BYTES: usize = 160 * 1024;
/// 语言统计走多少个文件就够。项目大小差几个数量级,而饼图只要比例。
const MAX_SCAN_FILES: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Capsule {
    /// 胶囊格式版本。收到更高版本的人要能认出"我读不懂这颗",而不是画出一团错的东西。
    pub v: u32,
    pub id: String,
    /// 本机路径。**不上传**(见 for_upload):别人的机器上它毫无意义,而且是隐私。
    #[serde(default)]
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 封面:224px 长边的 JPEG data URL。粒子的落点和颜色全从它来。
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub shots: Vec<String>,
    /// 会被粒子聚成的短句(文件数、语言占比之类)。
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub files: u32,
    /// 语言占比,已经排好序:[("rust", 0.62), ("ts", 0.30)]
    #[serde(default)]
    pub langs: Vec<(String, f32)>,
    #[serde(default)]
    pub created_at: String,
    /// 用户有没有把它发到广场(本机记账,服务端另有一份)。
    #[serde(default)]
    pub published: bool,
    /// 用户自己改过的字段名单 —— 重新扫描时**不许覆盖**这些。
    /// 一次 rescan 把人改好的标题冲掉,他就再也不会用这个功能了。
    #[serde(default)]
    pub edited: Vec<String>,
}

impl Capsule {
    /// 上传用的那一份:去掉本机路径和记账字段。
    pub fn for_upload(&self) -> serde_json::Value {
        serde_json::json!({
            "v": self.v, "id": self.id, "title": self.title, "subtitle": self.subtitle,
            "tags": self.tags, "cover": self.cover, "shots": self.shots,
            "lines": self.lines, "files": self.files, "langs": self.langs,
        })
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn stable_id(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    format!("p_{:x}", h.finalize())[..14].to_string()
}

// ── 图片 → data URL ────────────────────────────────────────────────────────

/// 用系统自带的 sips 缩图 + 转 JPEG,再 base64。
///
/// 和桌面壁纸那条路同一个做法:macOS 本来就有 sips,为了缩一张图引入一个图像库
/// 不值得。缩到 224px 之后一张封面大约 10–20KB —— 仍旧是"参数",不是"图片"。
pub fn image_data_url(src: &Path) -> Option<String> {
    let tmp = std::env::temp_dir().join(format!(
        "terse-cap-{}.jpg",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos()
    ));
    let out = std::process::Command::new("sips")
        .args(["-Z", &COVER_PX.to_string(), "-s", "format", "jpeg"])
        .arg(src)
        .arg("--out")
        .arg(&tmp)
        .output()
        .ok()?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    let bytes = std::fs::read(&tmp).ok()?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.is_empty() || bytes.len() > MAX_CAPSULE_BYTES {
        return None;
    }
    Some(format!("data:image/jpeg;base64,{}", crate::b64(&bytes)))
}

fn is_image(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif"
    )
}

/// README 里**第一张图**。作者自己选出来放在最上面的那张,几乎总是最能代表项目的 ——
/// 比"仓库里最大的图片"这种启发式准得多,所以它排在最前面试。
fn cover_from_readme(root: &Path, readme: &str) -> Option<PathBuf> {
    let mut cands: Vec<String> = Vec::new();
    // ![alt](path)
    for (i, _) in readme.match_indices("![") {
        if let Some(open) = readme[i..].find("](") {
            let rest = &readme[i + open + 2..];
            if let Some(close) = rest.find(')') {
                cands.push(rest[..close].trim().to_string());
            }
        }
    }
    // <img src="path">
    for (i, _) in readme.match_indices("<img") {
        let rest = &readme[i..];
        if let Some(s) = rest.find("src=") {
            let after = &rest[s + 4..];
            let q = after.chars().next()?;
            if q == '"' || q == '\'' {
                if let Some(close) = after[1..].find(q) {
                    cands.push(after[1..1 + close].trim().to_string());
                }
            }
        }
    }
    for c in cands {
        // 远程图和徽章跳过:胶囊必须能离线生成,而 shields.io 的徽章不是项目的样子。
        if c.starts_with("http") || c.contains("badge") || c.contains("shields.io") {
            continue;
        }
        let rel = c.split('#').next().unwrap_or(&c).split('?').next().unwrap_or(&c);
        let p = root.join(rel.trim_start_matches("./").trim_start_matches('/'));
        if p.is_file() && is_image(&p) {
            return Some(p);
        }
    }
    None
}

/// 没有 README 图时的退路:仓库里挑一张。
///
/// 打分而不是取最大:一个 200KB 的 favicon 拼图不如 docs/screenshot.png 能代表项目。
/// 目录名和文件名里的线索(screenshot/hero/banner/demo/preview/logo)优先。
fn cover_from_tree(root: &Path) -> Vec<PathBuf> {
    let mut scored: Vec<(i32, u64, PathBuf)> = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .max_depth(Some(4))
        .build();
    for e in walker.flatten() {
        let p = e.path();
        if !p.is_file() || !is_image(p) {
            continue;
        }
        let lower = p.to_string_lossy().to_ascii_lowercase();
        if lower.contains("/node_modules/") || lower.contains("/target/")
            || lower.contains("/.git/") || lower.contains("/dist/")
        {
            continue;
        }
        let size = p.metadata().map(|m| m.len()).unwrap_or(0);
        // 太小的多半是图标碎片,太大的缩图慢
        if size < 8_000 || size > 12_000_000 {
            continue;
        }
        let mut score = 0;
        for (kw, pts) in [
            ("screenshot", 60), ("hero", 50), ("banner", 45), ("preview", 40),
            ("demo", 35), ("cover", 35), ("logo", 20),
        ] {
            if lower.contains(kw) {
                score += pts;
            }
        }
        for (dir, pts) in [("/docs/", 25), ("/assets/", 20), ("/media/", 20), ("/.github/", 15)] {
            if lower.contains(dir) {
                score += pts;
            }
        }
        scored.push((score, size, p.to_path_buf()));
        if scored.len() > 400 {
            break;
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored.into_iter().map(|(_, _, p)| p).collect()
}

// ── 名字 / 简介 ────────────────────────────────────────────────────────────

fn manifest_name_desc(root: &Path) -> (Option<String>, Option<String>) {
    if let Ok(s) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            return (
                v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string()),
                v.get("description").and_then(|x| x.as_str()).map(|s| s.to_string()),
            );
        }
    }
    for (file, key) in [("Cargo.toml", "name"), ("pyproject.toml", "name")] {
        if let Ok(s) = std::fs::read_to_string(root.join(file)) {
            let mut name = None;
            let mut desc = None;
            for line in s.lines().take(40) {
                let l = line.trim();
                if name.is_none() && l.starts_with(key) && l.contains('=') {
                    name = l.split('=').nth(1).map(|v| v.trim().trim_matches('"').to_string());
                }
                if desc.is_none() && l.starts_with("description") && l.contains('=') {
                    desc = l.split('=').nth(1).map(|v| v.trim().trim_matches('"').to_string());
                }
            }
            if name.is_some() {
                return (name, desc);
            }
        }
    }
    (None, None)
}

fn read_readme(root: &Path) -> Option<String> {
    for n in ["README.md", "readme.md", "README.MD", "Readme.md", "README.rst", "README.txt"] {
        if let Ok(s) = std::fs::read_to_string(root.join(n)) {
            return Some(s);
        }
    }
    None
}

/// README 的第一段正文。跳过标题、徽章、HTML、引用块 —— 那些都不是一句介绍。
fn readme_blurb(readme: &str) -> Option<String> {
    for line in readme.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with('!') || l.starts_with('<')
            || l.starts_with('>') || l.starts_with('[') || l.starts_with("---")
        {
            continue;
        }
        let clean: String = l
            .replace("**", "")
            .replace('`', "")
            .chars()
            .take(140)
            .collect();
        if clean.chars().count() >= 12 {
            return Some(clean);
        }
    }
    None
}

fn readme_title(readme: &str) -> Option<String> {
    for line in readme.lines().take(30) {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("# ") {
            let t: String = rest.trim().replace('`', "").chars().take(48).collect();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

// ── 语言占比 ───────────────────────────────────────────────────────────────

fn lang_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "rust",
        "ts" | "tsx" => "ts",
        "js" | "jsx" | "mjs" | "cjs" => "js",
        "py" => "python",
        "go" => "go",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "c++",
        "rb" => "ruby",
        "php" => "php",
        "cs" => "c#",
        "html" => "html",
        "css" | "scss" => "css",
        "sh" | "bash" => "shell",
        "sql" => "sql",
        _ => return None,
    })
}

/// 语言占比按**字节**算,不是按文件数 —— GitHub 的 Linguist 就是这么算的,而且这才
/// 是对的:一个仓库里 200 个一行的 JSON 和 20 个上千行的 Rust,按文件数会说它是个
/// JSON 项目。
fn scan_langs(root: &Path) -> (u32, Vec<(String, f32)>) {
    use std::collections::HashMap;
    let mut counts: HashMap<&'static str, u64> = HashMap::new();
    let mut files = 0u32;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .max_depth(Some(8))
        .build();
    for e in walker.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        files += 1;
        if let Some(l) = p.extension().and_then(|x| x.to_str()).and_then(lang_of) {
            // 单个文件的贡献封顶:一份几 MB 的压缩包或生成物不该一个人决定整张饼图
            let sz = p.metadata().map(|m| m.len().min(2_000_000)).unwrap_or(0);
            *counts.entry(l).or_insert(0) += sz;
        }
        if files as usize >= MAX_SCAN_FILES {
            break;
        }
    }
    let total: u64 = counts.values().sum();
    let mut langs: Vec<(String, f32)> = counts
        .into_iter()
        .map(|(k, v)| (k.to_string(), if total > 0 { v as f32 / total as f32 } else { 0.0 }))
        .collect();
    langs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    langs.truncate(5);
    (files, langs)
}

/// 项目的几条"事实":最近一次提交、许可证、远端。都是**便宜**的问法 —— 一次 git
/// 命令、一次目录读 —— 而它们正是让一个项目看起来像真的存在的那几行字。
fn project_facts(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let git = |args: &[&str]| -> Option<String> {
        let o = std::process::Command::new("git")
            .arg("-C").arg(root).args(args).output().ok()?;
        if !o.status.success() { return None; }
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    };
    if let Some(when) = git(&["log", "-1", "--format=%cr"]) {
        out.push(format!("updated {when}"));
    }
    if let Some(n) = git(&["rev-list", "--count", "HEAD"]) {
        if let Ok(v) = n.parse::<u64>() {
            out.push(format!("{} commits", if v >= 1000 { format!("{:.1}k", v as f64 / 1000.0) } else { v.to_string() }));
        }
    }
    for name in ["LICENSE", "LICENSE.md", "LICENCE", "COPYING"] {
        if let Ok(s) = std::fs::read_to_string(root.join(name)) {
            let head = s.lines().take(3).collect::<Vec<_>>().join(" ").to_ascii_lowercase();
            let kind = if head.contains("mit license") { "MIT" }
                else if head.contains("apache") { "Apache-2.0" }
                else if head.contains("gnu general public") { "GPL" }
                else if head.contains("bsd") { "BSD" }
                else { "" };
            if !kind.is_empty() { out.push(kind.to_string()); }
            break;
        }
    }
    out
}

// ── 扫描 ───────────────────────────────────────────────────────────────────

/// 把一个文件夹扫成一颗胶囊。`keep` 是上一版(重新扫描时用),用户改过的字段原样保留。
pub fn scan(path: &Path, keep: Option<&Capsule>) -> Result<Capsule, String> {
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    let path_s = path.to_string_lossy().to_string();
    let readme = read_readme(path).unwrap_or_default();
    let (mname, mdesc) = manifest_name_desc(path);
    let dir_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());

    let title = readme_title(&readme)
        .or(mname)
        .unwrap_or(dir_name)
        .trim()
        .to_string();
    let subtitle = mdesc
        .or_else(|| readme_blurb(&readme))
        .unwrap_or_default();

    // 封面:先信 README 里作者自己放的第一张图,再退回按名字/目录打分挑。
    let mut picks: Vec<PathBuf> = Vec::new();
    if let Some(p) = cover_from_readme(path, &readme) {
        picks.push(p);
    }
    for p in cover_from_tree(path) {
        if picks.len() >= MAX_SHOTS + 1 {
            break;
        }
        if !picks.contains(&p) {
            picks.push(p);
        }
    }
    let mut cover = String::new();
    let mut shots: Vec<String> = Vec::new();
    for p in picks {
        match image_data_url(&p) {
            Some(u) if cover.is_empty() => cover = u,
            Some(u) if shots.len() < MAX_SHOTS => shots.push(u),
            _ => {}
        }
    }

    let (files, langs) = scan_langs(path);
    let mut lines: Vec<String> = Vec::new();
    if files > 0 {
        lines.push(format!("{files} files"));
    }
    if !langs.is_empty() {
        // 只把前三种写成一行字(粒子聚出来的句子要短);完整的比例留在 langs 里,
        // 界面上画成 GitHub 那样的语言条。
        lines.push(
            langs
                .iter()
                .take(3)
                .map(|(l, f)| format!("{l} {:.0}%", f * 100.0))
                .collect::<Vec<_>>()
                .join(" · "),
        );
    }
    for f in project_facts(path) {
        lines.push(f);
    }
    lines.truncate(4);

    let mut cap = Capsule {
        v: 1,
        id: keep.map(|k| k.id.clone()).unwrap_or_else(|| stable_id(&path_s)),
        path: path_s,
        title,
        subtitle,
        tags: langs.iter().map(|(l, _)| l.clone()).collect(),
        cover,
        shots,
        lines,
        files,
        langs,
        created_at: keep.map(|k| k.created_at.clone()).unwrap_or_else(now_iso),
        published: keep.map(|k| k.published).unwrap_or(false),
        edited: keep.map(|k| k.edited.clone()).unwrap_or_default(),
    };

    // 用户改过的字段一律不覆盖。重新扫描是为了跟上项目的变化,不是把人的编辑抹掉 ——
    // 被 rescan 冲掉一次自己写的标题,他就再也不会用这个功能了。
    if let Some(k) = keep {
        for f in &k.edited {
            match f.as_str() {
                "title" => cap.title = k.title.clone(),
                "subtitle" => cap.subtitle = k.subtitle.clone(),
                "cover" => cap.cover = k.cover.clone(),
                "shots" => cap.shots = k.shots.clone(),
                "lines" => cap.lines = k.lines.clone(),
                _ => {}
            }
        }
    }
    Ok(cap)
}

// ── 本机存储 ───────────────────────────────────────────────────────────────

fn store_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("projects.json")
}

pub fn load() -> Vec<Capsule> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Capsule>>(&s).ok())
        .unwrap_or_default()
}

pub fn save(list: &[Capsule]) {
    let p = store_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(s) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(p, s);
    }
}

/// 正在被 agent 使用的项目文件夹(还没加进来的那些)。
///
/// 用的是 agent_monitor 里同一条路子:问 lsof 要那几个进程的 cwd。**不猜**、不扫全盘 ——
/// 你现在正在写的那个项目,本来就是最该出现在列表最上面的那个。
pub fn agent_dirs() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Windows has no `lsof -d cwd`. agent_monitor already had to solve this to
    // attribute usage to a project at all, so this asks it rather than inventing
    // a second answer that could disagree with the one the rest of the app uses.
    for p in crate::agent_monitor::agent_working_dirs() {
        if p.is_empty() || out.iter().any(|x| *x == p) {
            continue;
        }
        // The home directory itself, and a drive root, are not "projects".
        let home = dirs::home_dir().unwrap_or_default();
        let path = Path::new(&p);
        if path == home || path.parent().is_none() {
            continue;
        }
        out.push(p);
    }
    out
}
