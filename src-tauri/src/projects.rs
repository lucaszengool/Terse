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

/// 胶囊格式版本。**每加一层要扫出来的东西就 +1** —— 它是"这颗胶囊缺不缺料"的唯一
/// 判据,而不是靠挨个检查某个字段是不是空的(空的可能是真的没有,比如不是 git 仓库)。
///
/// v1 → v2:代码城市(dirs / links)、提交天际线(commits)、依赖星座(graph)。
pub const CAPSULE_V: u32 = 2;
/// 语言统计走多少个文件就够。项目大小差几个数量级,而饼图只要比例。
const MAX_SCAN_FILES: usize = 4000;
/// 代码城市里最多几座塔。再多就不是城市了,是一排看不清的栅栏 —— 而且每一座塔在
/// 屏幕上只有那么大,粒子分完就谁也认不出谁。
const MAX_CITY_DIRS: usize = 16;

/// **依赖星座**:这个仓库真正的代码图,摆成一团三维的星。
///
/// 这一块是 Terse 独有的:知识图谱(`graph_store`)已经把符号级的调用/引用关系抽在
/// 本机磁盘上了 —— 别的工具要画这张图,得先把整个仓库重新解析一遍。
///
/// **坐标是在发布者的机器上算好、定点化之后传的**,不是在每台机器上各跑一次力导向。
/// 两个理由:力导向有随机初值,各跑各的会让同一个项目在每个人屏幕上长得都不一样
/// (那就不是"这个项目的形状"了);而且它是 O(n²),不该在别人的壁纸上每次预览都跑。
/// 120 个点 × 3 个 i16 ≈ 900 字节 —— 比跑一次还便宜。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Constellation {
    /// 每个节点 `[x, y, z, degree, community]`。坐标是 −1000..1000 的定点整数。
    pub n: Vec<[i32; 5]>,
    /// 边,按节点下标。
    pub e: Vec<[u32; 2]>,
    /// 社区的名字(最多 8 个)—— 星座的图例。
    pub c: Vec<String>,
}

/// 一个**改得最勤的文件**。热点图上的一团光。
///
/// 「改动频度 × 体量」是 Adam Tornhill 那套读法:一个又大又天天改的文件,是这个仓库
/// 真正的压力点 —— 它既不是"最大的文件",也不是"最近改的文件",而是两者相乘。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HotFile {
    /// 只留文件名和它上面一层 —— 全路径是本机信息,而且太长画不下。
    pub name: String,
    /// 最近 400 次提交里,它被动过几次。
    pub churn: u32,
    /// 字节。热点的大小是 churn × 体量,两个都得有。
    pub bytes: u64,
    /// 它归哪座楼 —— 热点图和城市用同一套颜色,才看得出"是哪一块在烧"。
    pub dir: String,
}

/// 一个顶层目录的体量 —— 代码城市里的一座建筑。
///
/// 这几个字段就是那座建筑的**全部设计图**:长什么形状、多高、几层窗、亮不亮、
/// 身上分几段颜色,全由它们决定。加一个字段就等于给这座城市多一种能被看见的信息,
/// 而胶囊只重了几十个字节 —— 这正是"传参数、不传画面"最划算的地方。
///
/// **楼高用的是代码字节,不是行数**:数行要把每个源文件都读一遍,而这次扫描的一条
/// 硬规矩就是**不读源码**(只读清单、README 和图片)。字节是 stat 就能拿到的,和行数
/// 在视觉上是同一个读数 —— 为了一个看不出差别的指标去读掉人家整个仓库,不值。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DirStat {
    /// 顶层目录名;仓库根目录下的散文件归在 "/" 这一座里。
    pub name: String,
    /// 占地:这个目录下有多少个文件。
    pub files: u32,
    /// 楼高:这个目录下**源码**文件的字节数(单文件封顶,和语言饼图同一个口径)。
    pub bytes: u64,
    /// 楼色:这个目录里字节最多的语言。没有已知语言就是空的(画成灰色)。
    pub lang: String,
    /// 这个目录里的语言构成(前 3,按字节)。塔身按它**分色带** —— 一座 60% Rust
    /// 40% TS 的楼,底下六成是 Rust 色,上面四成是 TS 色。一眼看出哪块是混的。
    #[serde(default)]
    pub langs: Vec<(String, f32)>,
    /// 这个目录是**干什么的**:source / test / docs / assets / config。
    /// 它决定这座建筑长成什么形状 —— 塔、厂房、圆仓、公园还是一片小屋。
    /// 一座全是方盒子的城市只能看出大小;形状一分,"这个仓库由什么组成"才看得出来。
    #[serde(default)]
    pub kind: String,
    /// 这座楼底下的二级目录(最多 8 个,`[名字, 文件数, 字节]`)。放射年轮要靠它才
    /// 有第二圈 —— 只有顶层的年轮就是一个饼图,而饼图看不出"深"。
    #[serde(default)]
    pub kids: Vec<(String, u32, u64)>,
    /// 目录树在这底下有多深。塔的**退台层数**由它来 —— 深的目录长成阶梯状高塔。
    #[serde(default)]
    pub depth: u32,
    /// 最近一次改动距今多少天。9999 = 不知道(不是 git 仓库)。窗户的**冷暖**由它定:
    /// 昨天动过的楼窗是亮的暖的,两年没碰的是暗的冷的。
    #[serde(default)]
    pub age_days: u32,
    /// 最近 400 次提交里动过这个目录的次数。最热的那座会长出一根**信标**。
    #[serde(default)]
    pub churn: u32,
}

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
    /// 介绍。副标题是**一行**(卡片上那句),这个是**一段** —— 广场里点「展开」才看得全,
    /// 和发视频时的标题与文案是同一组关系。扫描扫不出它:一个项目为什么值得看,
    /// 只有作者知道,所以它默认是空的,由人自己写。
    #[serde(default)]
    pub desc: String,
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
    /// 提交天际线:最近 53 周、每天多少次提交(371 个小数字)。
    /// 城市有结构、有材料、有关系,唯独**没有时间** —— 这一条把时间补上。
    #[serde(default)]
    pub commits: Vec<u16>,
    /// 上一次扫描**为什么没扫到东西**。空 = 一切正常。
    ///
    /// 这个字段存在的理由:未签名的 app 每换一个版本,二进制就变了,macOS 会让原来那条
    /// "允许访问桌面"的授权**对不上号** —— 于是 `read_dir` 被拒,而 `stat` 和 git 子进程
    /// 照常。表现出来就是"城市不见了,别的都在",而屏幕上什么都不说。
    /// 本机诊断,**不上传**(见 for_upload)。
    #[serde(default)]
    pub scan_error: String,
    /// 热点:改得最勤的那几个文件。
    #[serde(default)]
    pub hot: Vec<HotFile>,
    /// 贡献者:`[名字, 提交数]`,最多 12 个。
    #[serde(default)]
    pub people: Vec<(String, u32)>,
    /// 依赖星座(见上)。没建过知识图谱就是空的。
    #[serde(default)]
    pub graph: Option<Constellation>,
    /// 目录之间的**依赖**:`[顶层目录下标 a, 下标 b, 权重]`,权重 = 代码图里连接这两个
    /// 目录的边数。城市上空那几道弧就是它。
    ///
    /// 这是 Terse 独有的一块:知识图谱(`graph_store`)已经把这个仓库真正的调用/引用
    /// 关系抽在本机磁盘上了 —— 别的工具要画这张图得先把仓库重新解析一遍。
    #[serde(default)]
    pub links: Vec<(u32, u32, u32)>,
    /// 代码城市的**建筑风格**(见 src/renderer/city-styles.js):modern / tang / edo /
    /// giza / hellas / maya / persia / norse。空 = 现代(免费那一种)。
    /// 换风格只换形状,不换任何一个读数 —— 高度还是代码量,灯还是"最近动过没有"。
    #[serde(default)]
    pub style: String,
    /// 代码城市:一个顶层目录一座塔。**这几十个数字就是那座城市的全部** ——
    /// 收到胶囊的人在自己机器上把它摆成塔、上色、采成粒子。传的还是参数,不是画面。
    #[serde(default)]
    pub dirs: Vec<DirStat>,
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
            "desc": self.desc,
            "lines": self.lines, "files": self.files, "langs": self.langs,
            "dirs": self.dirs, "style": self.style, "links": self.links,
            "commits": self.commits, "graph": self.graph,
            "hot": self.hot, "people": self.people,
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

/// 一个目录是**干什么的**。城市里的形状全靠它:测试是厂房、文档是公园、素材是圆仓、
/// 配置是一片小屋、其余是塔。
///
/// 先看名字再看内容:名字是作者**明说**的意图(叫 `tests` 的目录就是测试),内容只是
/// 推测。两者都拿不准就当源码 —— 塔是这座城市的默认形状,猜错了也只是少一点信息,
/// 不会把一个源码目录画成一片草地。
fn dir_kind(name: &str, exts: &std::collections::HashMap<String, u32>, files: u32) -> &'static str {
    let n = name.trim_matches('/').to_ascii_lowercase();
    let is = |set: &[&str]| set.iter().any(|k| n == *k || n.starts_with(&format!("{k}-")) || n.ends_with(&format!("-{k}")));
    if is(&["test", "tests", "spec", "specs", "e2e", "__tests__", "testing"]) { return "test"; }
    if is(&["doc", "docs", "documentation", "guide", "guides", "book", "example", "examples", "demo"]) { return "docs"; }
    if is(&["asset", "assets", "image", "images", "img", "media", "static", "public", "font", "fonts", "icon", "icons", "resources", "res"]) { return "assets"; }
    if is(&["script", "scripts", "config", "configs", "ci", "infra", "deploy", "build", "tools", ".github", ".vscode"]) { return "config"; }
    // 名字没说,就问内容。比例要**过半**才算数:三成 markdown 的源码目录还是源码目录。
    let share = |set: &[&str]| -> f32 {
        if files == 0 { return 0.0; }
        set.iter().map(|e| *exts.get(*e).unwrap_or(&0)).sum::<u32>() as f32 / files as f32
    };
    if share(&["md", "mdx", "rst", "txt", "adoc"]) > 0.6 { return "docs"; }
    if share(&["png", "jpg", "jpeg", "gif", "svg", "webp", "mp4", "mov", "woff", "woff2", "ttf", "otf", "ico"]) > 0.6 { return "assets"; }
    if share(&["yml", "yaml", "toml", "ini", "cfg", "sh", "bash", "plist", "lock"]) > 0.6 { return "config"; }
    "source"
}

/// 每个顶层目录"最近一次被碰是什么时候"和"被碰得有多勤"。
///
/// **一次 git 调用拿到全部**,不是一个目录问一次:16 个目录 = 16 次进程启动,在大仓库
/// 上就是好几秒,而这是一次"点一下就要出画面"的扫描。`-n 400` 给输出封了顶 ——
/// 再久远的历史对"这块最近热不热"没有意义,却会让输出变成几万行。
fn dir_history(root: &Path) -> (std::collections::HashMap<String, (u32, u32)>, std::collections::HashMap<String, u32>) {
    use std::collections::HashMap;
    let mut out: HashMap<String, (u32, u32)> = HashMap::new();
    // 顺带把**每个文件**被动过几次也数出来。热点图要的就是它,而这份日志已经在手上 ——
    // 为了同一份数据再跑一次 `git log` 是白付两遍。
    let mut per_file: HashMap<String, u32> = HashMap::new();
    let o = match std::process::Command::new("git")
        .arg("-C").arg(root)
        .args(["log", "-n", "400", "--format=%ct", "--name-only", "--no-renames"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (out, per_file),  // 不是 git 仓库:城市照样立得起来,只是没有冷暖
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let text = String::from_utf8_lossy(&o.stdout);
    let mut ts: u64 = 0;
    // 一次提交里同一个目录被动了十个文件,只算一次 —— 否则"改动频度"变成"文件数"。
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in text.lines() {
        if line.is_empty() { seen.clear(); continue; }
        if let Ok(v) = line.parse::<u64>() {
            if line.len() >= 9 { ts = v; seen.clear(); continue; }
        }
        let top = line.split('/').next().unwrap_or("");
        // 文件级的频度**不去重**:同一次提交里改了它就是改了它。去重是给"目录"用的
        // (否则一次动十个文件的提交会让那个目录的频度翻十倍)。
        *per_file.entry(line.to_string()).or_insert(0) += 1;
        let key = if line.contains('/') { top.to_string() } else { "/".to_string() };
        if !seen.insert(key.clone()) { continue; }
        let age_days = if ts > 0 && now > ts { ((now - ts) / 86_400) as u32 } else { 9999 };
        let e = out.entry(key).or_insert((9999, 0));
        if age_days < e.0 { e.0 = age_days; }       // 日志是新到旧,第一次见到的就是最新
        e.1 += 1;
    }
    (out, per_file)
}

/// 热点:**改动频度 × 体量**最高的那几个文件。
///
/// 两个都要:只看频度,排在最前的是 CHANGELOG 和版本号;只看体量,排在最前的是
/// 生成物和词表。相乘之后剩下的,才是这个仓库真正在烧的地方。
fn hotspots(root: &Path, per_file: &std::collections::HashMap<String, u32>) -> Vec<HotFile> {
    const MAX_HOT: usize = 40;
    if per_file.is_empty() { return Vec::new(); }
    let mut v: Vec<HotFile> = per_file
        .iter()
        .filter(|(_, &c)| c >= 2)                      // 只动过一次的不叫热点
        .filter_map(|(path, &churn)| {
            let full = root.join(path);
            let bytes = std::fs::metadata(&full).ok().filter(|m| m.is_file())?.len().min(4_000_000);
            if bytes == 0 { return None; }             // 已经删掉的文件不该还在图上烧
            let mut parts = path.rsplit('/');
            let file = parts.next().unwrap_or(path);
            let up = parts.next();
            Some(HotFile {
                name: match up { Some(u) => format!("{u}/{file}"), None => file.to_string() },
                churn,
                bytes,
                dir: path.split('/').next().filter(|_| path.contains('/')).unwrap_or("/").to_string(),
            })
        })
        .collect();
    // 热度 = 频度 × log(体量):体量直接相乘会让一个 2MB 的文件压过所有人,
    // 而"大"这件事的边际意义是递减的 —— 500 行和 5000 行的差别,远大于 5 万和 50 万。
    let heat = |h: &HotFile| (h.churn as f64) * ((h.bytes as f64).max(2.0)).ln();
    v.sort_by(|a, b| heat(b).partial_cmp(&heat(a)).unwrap_or(std::cmp::Ordering::Equal)
        .then(a.name.cmp(&b.name)));
    v.truncate(MAX_HOT);
    v
}

/// 贡献者:谁写了这个仓库。
///
/// `git shortlog -sn` 一次问完。名字**只留人名,不留邮箱** —— 邮箱是个人信息,
/// 而这颗胶囊是要发到广场上去的。
fn contributors(root: &Path) -> Vec<(String, u32)> {
    let o = match std::process::Command::new("git")
        .arg("-C").arg(root)
        .args(["shortlog", "-sn", "--all", "--no-merges"])
        .env("GIT_PAGER", "cat")
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let line = line.trim();
        let Some((n, name)) = line.split_once('\t').or_else(|| line.split_once("  ")) else { continue };
        let Ok(commits) = n.trim().parse::<u32>() else { continue };
        let name: String = name.trim().chars().take(24).collect();
        if name.is_empty() { continue; }
        out.push((name, commits));
        if out.len() >= 12 { break; }
    }
    out
}

/// 最近 53 周每天的提交数。GitHub 那块贡献图的原始数据。
///
/// 单独一次 `git log`(只要时间戳,不要文件名)—— 便宜得很,而且 `dir_history` 那次
/// 是按**提交条数**封顶的(-n 400),盖不住一整年。两件事就两次问,别为了省一次调用
/// 把一个封顶条件硬套到另一个问题上。
fn commit_days(root: &Path) -> Vec<u16> {
    const DAYS: usize = 371;                 // 53 周 × 7
    let mut out = vec![0u16; DAYS];
    let o = match std::process::Command::new("git")
        .arg("-C").arg(root)
        .args(["log", "--since=53.weeks", "--format=%ct"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),              // 不是 git 仓库:没有时间这一层
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let today = now / 86_400;
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let Ok(ts) = line.trim().parse::<u64>() else { continue };
        let day = ts / 86_400;
        if day > today { continue; }
        let back = (today - day) as usize;
        if back < DAYS { out[DAYS - 1 - back] = out[DAYS - 1 - back].saturating_add(1); }
    }
    if out.iter().all(|&v| v == 0) { Vec::new() } else { out }
}

/// 把知识图谱摆成一团三维的星。
///
/// 取度数最高的一批节点 —— 一个几千符号的仓库里,真正说明"它长什么样"的就是那些
/// 枢纽。剩下的叶子节点只会把画面糊成一团雾。
///
/// 力导向用的是最朴素的 Fruchterman–Reingold:同类相斥、有边相吸、逐步降温。
/// 初值**不是随机的**,是从节点下标推出来的 —— 同一颗胶囊每次扫描都得摆出同一团星,
/// 否则每次重扫,别人看到的"这个项目"就换了个形状。
fn constellation(root: &Path) -> Option<Constellation> {
    use std::collections::HashMap;
    const MAX_NODES: usize = 120;
    const ITERS: usize = 220;

    let g = crate::graph_store::load_graph(&crate::graph_store::repo_hash(root))?;
    if g.nodes.len() < 4 { return None; }

    let mut idx: Vec<usize> = (0..g.nodes.len()).collect();
    idx.sort_by(|&a, &b| g.nodes[b].degree.cmp(&g.nodes[a].degree).then(g.nodes[a].id.cmp(&g.nodes[b].id)));
    idx.truncate(MAX_NODES);
    let keep: HashMap<&str, usize> = idx.iter().enumerate().map(|(i, &n)| (g.nodes[n].id.as_str(), i)).collect();

    let mut edges: Vec<[u32; 2]> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for e in &g.edges {
        let (Some(&a), Some(&b)) = (keep.get(e.src.as_str()), keep.get(e.dst.as_str())) else { continue };
        if a == b { continue; }
        let k = (a.min(b), a.max(b));
        if seen.insert(k) { edges.push([k.0 as u32, k.1 as u32]); }
    }
    if edges.is_empty() { return None; }

    let n = idx.len();
    // 稳定的初值:节点下标 → 球面上一点(黄金角螺旋)。均匀、确定、不用随机数。
    let mut px = vec![0f32; n]; let mut py = vec![0f32; n]; let mut pz = vec![0f32; n];
    for i in 0..n {
        let t = (i as f32 + 0.5) / n as f32;
        let phi = (1.0 - 2.0 * t).acos();
        let theta = std::f32::consts::PI * (1.0 + 5f32.sqrt()) * i as f32;
        px[i] = phi.sin() * theta.cos();
        py[i] = phi.sin() * theta.sin();
        pz[i] = phi.cos();
    }
    let k = (1.0f32 / n as f32).cbrt() * 1.6;      // 理想边长
    let mut temp = 0.55f32;
    let (mut dx, mut dy, mut dz) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    for _ in 0..ITERS {
        for v in dx.iter_mut() { *v = 0.0; }
        for v in dy.iter_mut() { *v = 0.0; }
        for v in dz.iter_mut() { *v = 0.0; }
        for i in 0..n {
            for j in (i + 1)..n {
                let (ex, ey, ez) = (px[i] - px[j], py[i] - py[j], pz[i] - pz[j]);
                let d2 = ex * ex + ey * ey + ez * ez + 1e-4;
                let d = d2.sqrt();
                let f = k * k / d2;                 // 斥力 ∝ 1/d²
                let (ux, uy, uz) = (ex / d, ey / d, ez / d);
                dx[i] += ux * f; dy[i] += uy * f; dz[i] += uz * f;
                dx[j] -= ux * f; dy[j] -= uy * f; dz[j] -= uz * f;
            }
        }
        for e in &edges {
            let (i, j) = (e[0] as usize, e[1] as usize);
            let (ex, ey, ez) = (px[i] - px[j], py[i] - py[j], pz[i] - pz[j]);
            let d = (ex * ex + ey * ey + ez * ez).sqrt().max(1e-3);
            let f = d * d / k;                      // 引力 ∝ d²
            let (ux, uy, uz) = (ex / d, ey / d, ez / d);
            dx[i] -= ux * f; dy[i] -= uy * f; dz[i] -= uz * f;
            dx[j] += ux * f; dy[j] += uy * f; dz[j] += uz * f;
        }
        for i in 0..n {
            let d = (dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i]).sqrt().max(1e-6);
            let step = d.min(temp) / d;
            px[i] += dx[i] * step; py[i] += dy[i] * step; pz[i] += dz[i] * step;
            // 轻轻往回收,免得孤立的点被斥力推到天边
            px[i] *= 0.999; py[i] *= 0.999; pz[i] *= 0.999;
        }
        temp *= 0.985;
    }

    // 归一化到 −1000..1000 的定点整数 —— 传出去的是这个,不是浮点
    let mut m = 1e-6f32;
    for i in 0..n { m = m.max(px[i].abs()).max(py[i].abs()).max(pz[i].abs()); }
    let sc = 1000.0 / m;

    // 社区:图谱自己聚出来的。星座按它上色 —— 颜色就是"这几块是一伙的"。
    let mut labels: Vec<String> = Vec::new();
    let mut cslot: HashMap<u32, usize> = HashMap::new();
    for c in g.communities.iter().take(8) {
        cslot.insert(c.id, labels.len());
        labels.push(c.label.chars().take(20).collect());
    }
    let nodes: Vec<[i32; 5]> = idx.iter().enumerate().map(|(i, &gi)| {
        let nd = &g.nodes[gi];
        let comm = nd.community.and_then(|c| cslot.get(&c).copied()).map(|v| v as i32).unwrap_or(-1);
        [(px[i] * sc) as i32, (py[i] * sc) as i32, (pz[i] * sc) as i32, nd.degree.min(9999) as i32, comm]
    }).collect();

    // 边也封顶:一团超过两三百条边的星座,看到的是雾,不是结构。
    edges.sort_by_key(|e| (e[0], e[1]));
    edges.truncate(260);
    Some(Constellation { n: nodes, e: edges, c: labels })
}

/// 顶层目录之间的依赖,从**本机已经建好的知识图谱**里收敛出来。
///
/// 图谱是按符号(函数/类/文件)建的,几千个节点摆不进一座城市;这里把每条边**收到
/// 它两端所属的顶层目录**上,同一对目录之间的边合成一条、记条数。几千条边收成
/// 二十几条,而"这块和那块有来往、来往多密"恰恰是收敛之后才看得出来的。
///
/// 没建过图谱就返回空 —— 城市照常立起来,只是天上没有那几道弧。
fn dir_links(root: &Path, names: &[String]) -> Vec<(u32, u32, u32)> {
    use std::collections::HashMap;
    let Some(g) = crate::graph_store::load_graph(&crate::graph_store::repo_hash(root)) else {
        return Vec::new();
    };
    let slot: HashMap<&str, u32> = names.iter().enumerate().map(|(i, n)| (n.as_str(), i as u32)).collect();
    // 节点 id → 它属于哪座建筑
    let mut of: HashMap<&str, u32> = HashMap::new();
    for n in &g.nodes {
        let top = n.path.split('/').next().unwrap_or("");
        let key = if n.path.contains('/') { top } else { "/" };
        if let Some(i) = slot.get(key) { of.insert(n.id.as_str(), *i); }
    }
    let mut count: HashMap<(u32, u32), u32> = HashMap::new();
    for e in &g.edges {
        let (Some(&a), Some(&b)) = (of.get(e.src.as_str()), of.get(e.dst.as_str())) else { continue };
        if a == b { continue; }           // 楼内部的调用不画 —— 画出来是一团自环
        *count.entry((a.min(b), a.max(b))).or_insert(0) += 1;
    }
    let mut out: Vec<(u32, u32, u32)> = count.into_iter().map(|((a, b), w)| (a, b, w)).collect();
    // 只留最粗的那些。全画出来,城市上空就是一张网 —— 网什么也说不出来。
    out.sort_by(|x, y| y.2.cmp(&x.2).then(x.0.cmp(&y.0)).then(x.1.cmp(&y.1)));
    out.truncate(18);
    out
}

/// 语言占比按**字节**算,不是按文件数 —— GitHub 的 Linguist 就是这么算的,而且这才
/// 是对的:一个仓库里 200 个一行的 JSON 和 20 个上千行的 Rust,按文件数会说它是个
/// JSON 项目。
fn scan_langs(root: &Path) -> (u32, Vec<(String, f32)>, Vec<DirStat>, Vec<HotFile>) {
    use std::collections::HashMap;
    let mut counts: HashMap<&'static str, u64> = HashMap::new();
    // 代码城市在**同一次遍历**里顺手统计出来。为了它再走一遍目录树,是把这个功能
    // 里最贵的那一步(几千次 stat)白付两遍。
    // (文件数, 源码字节, 语言→字节, 扩展名→文件数, 最深层数)
    type Slot = (u32, u64, HashMap<&'static str, u64>, HashMap<String, u32>, u32, HashMap<String, (u32, u64)>);
    let mut per_dir: HashMap<String, Slot> = HashMap::new();
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
        // 这个文件归哪座塔:顶层目录名,根目录下的散文件归 "/"。
        let top = p
            .strip_prefix(root)
            .ok()
            .and_then(|r| {
                let mut it = r.components();
                let first = it.next()?;
                // 还有下一段才说明它在子目录里;否则是根目录下的散文件。
                if it.next().is_some() { Some(first.as_os_str().to_string_lossy().to_string()) } else { None }
            })
            .unwrap_or_else(|| "/".to_string());
        // 这个文件埋在顶层目录下面几层 —— 塔的退台层数看它
        let depth = p.strip_prefix(root).ok()
            .map(|r| r.components().count().saturating_sub(1) as u32)
            .unwrap_or(1);
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        let slot = per_dir.entry(top).or_insert_with(|| (0, 0, HashMap::new(), HashMap::new(), 0, HashMap::new()));
        slot.0 += 1;
        if !ext.is_empty() { *slot.3.entry(ext).or_insert(0) += 1; }
        if depth > slot.4 { slot.4 = depth; }
        // 二级目录:放射年轮的第二圈。只有一圈的年轮就是个饼图,而饼图看不出"深"。
        let kid = p.strip_prefix(root).ok().and_then(|r| {
            let mut it = r.components();
            it.next()?;                                   // 顶层那一段
            let second = it.next()?;
            if it.next().is_some() { Some(second.as_os_str().to_string_lossy().to_string()) } else { None }
        });
        if let Some(k) = kid {
            let sz = p.metadata().map(|m| m.len().min(2_000_000)).unwrap_or(0);
            let ke = slot.5.entry(k).or_insert((0, 0));
            ke.0 += 1; ke.1 += sz;
        }
        if let Some(l) = p.extension().and_then(|x| x.to_str()).and_then(lang_of) {
            // 单个文件的贡献封顶:一份几 MB 的压缩包或生成物不该一个人决定整张饼图
            let sz = p.metadata().map(|m| m.len().min(2_000_000)).unwrap_or(0);
            *counts.entry(l).or_insert(0) += sz;
            slot.1 += sz;
            *slot.2.entry(l).or_insert(0) += sz;
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

    let (hist, per_file) = dir_history(root);
    let mut dirs: Vec<DirStat> = per_dir
        .into_iter()
        .map(|(name, (f, bytes, langmap, exts, depth, kidmap))| {
            // 这座楼的语言构成:前 3 名,按字节。色带就是按它分的。
            let tot: u64 = langmap.values().sum();
            let mut mix: Vec<(String, f32)> = langmap
                .iter()
                .map(|(l, v)| (l.to_string(), if tot > 0 { *v as f32 / tot as f32 } else { 0.0 }))
                .collect();
            mix.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            mix.truncate(3);
            let lang = mix.first().map(|(l, _)| l.clone()).unwrap_or_default();
            let kind = dir_kind(&name, &exts, f).to_string();
            let (age_days, churn) = hist.get(&name).copied().unwrap_or((9999, 0));
            // 二级目录按体量排前 8 —— 年轮外圈那些扇形的宽度就是它们
            let mut kids: Vec<(String, u32, u64)> = kidmap.into_iter()
                .map(|(k, (kf, kb))| (k, kf, kb)).collect();
            kids.sort_by(|a, b| b.2.max(b.1 as u64 * 2_000).cmp(&a.2.max(a.1 as u64 * 2_000)).then(a.0.cmp(&b.0)));
            kids.truncate(8);
            DirStat { name, files: f, bytes, lang, langs: mix, kind, depth, age_days, churn, kids }
        })
        .collect();
    // 排序看的是"代码量为主、文件数为辅":一个塞了两千张图的 assets 目录不该是这座
    // 城市的主楼,但它也不该被挤出城 —— 一座只有塔的城市看不出这个仓库还有文档和素材,
    // 而形状的多样正是这座城市能多说的那部分信息。所以给文件数折算一个很轻的当量。
    let weight = |d: &DirStat| d.bytes.max(d.files as u64 * 2_000);
    dirs.sort_by(|a, b| weight(b).cmp(&weight(a)).then(b.files.cmp(&a.files)).then(a.name.cmp(&b.name)));
    dirs.truncate(MAX_CITY_DIRS);
    (files, langs, dirs, hotspots(root, &per_file))
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

    let (files, langs, dirs, hot) = scan_langs(path);
    // 弧要连的是**城市里真有的那几座楼**,所以下标只能在截断之后算。
    let dir_names: Vec<String> = dirs.iter().map(|d| d.name.clone()).collect();
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
        v: CAPSULE_V,
        id: keep.map(|k| k.id.clone()).unwrap_or_else(|| stable_id(&path_s)),
        path: path_s,
        title,
        subtitle,
        // 扫描扫不出介绍 —— 一个项目为什么值得看只有作者知道。重扫时保留人写过的
        // 那一段(见下面的 edited 分支),新扫出来的就是空的,等人自己写。
        desc: keep.map(|k| k.desc.clone()).unwrap_or_default(),
        tags: langs.iter().map(|(l, _)| l.clone()).collect(),
        cover,
        shots,
        lines,
        files,
        langs,
        dirs,
        links: dir_links(path, &dir_names),
        commits: commit_days(path),
        graph: constellation(path),
        hot,
        people: contributors(path),
        // scan() 走的是完整那条路;它自己没有 read_dir 探针,扫到了就是没毛病。
        scan_error: String::new(),
        // 风格是**用户选的**,不是扫出来的 —— 重扫一次不能把人挑的风格冲回默认。
        style: keep.map(|k| k.style.clone()).unwrap_or_default(),
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
                // 介绍是**只可能**由人写的,所以重扫永远不许碰它。
                "desc" => cap.desc = k.desc.clone(),
                "cover" => cap.cover = k.cover.clone(),
                "shots" => cap.shots = k.shots.clone(),
                "lines" => cap.lines = k.lines.clone(),
                "style" => cap.style = k.style.clone(),
                _ => {}
            }
        }
    }
    Ok(cap)
}

// ── 本机存储 ───────────────────────────────────────────────────────────────

/// 把一颗**旧胶囊**补上后来才有的那几层,不动它别的任何东西。
///
/// 为什么需要这个:代码城市、天际线、星座都是扫描时算出来的,而一颗 9 月 4 号扫的
/// 胶囊里根本没有这些字段。人点预览,看到的还是"一张图 + 几行字" —— 功能在代码里
/// 是活的,在他屏幕上从来没出现过,而且他没有任何理由知道要去按一下「重新扫描」。
/// **一个只有内行才知道要手动触发的功能,等于没做。**
///
/// 刻意**不走整条 scan()**:那条路会重挑封面、重编 224px JPEG、重读 README ——
/// 又慢,又可能覆盖人自己改过的东西。这里只补"扫出来的、纯派生的"那几项。
fn refresh_city(cap: &mut Capsule) -> bool {
    let root = Path::new(&cap.path);
    if cap.path.is_empty() || !root.is_dir() {
        note(&format!("skip id={} path={:?} is_dir=false", cap.id, cap.path));
        return false;                       // 文件夹没了:留着旧胶囊,别把它清空
    }
    let (files, langs, dirs, hot) = scan_langs(root);
    /* 扫完记一行。
       这一行是有来历的:用户装了新版、胶囊也确实补过料(commits / graph / hot 全有),
       **偏偏 files / langs / dirs 三个全是空的** —— 也就是那次目录遍历一条都没吐出来,
       而 git 那几路全正常。这种情况在终端里怎么都复现不了,所以只能让 app 自己说。
       `read_dir` 是**独立的一次系统调用**:它能分清"操作系统不让我列这个目录"和
       "ignore 把所有东西都过滤掉了" —— 这两件事的修法完全不同。 */
    let listed = match std::fs::read_dir(root) {
        Ok(it) => { cap.scan_error = String::new(); format!("{}", it.count()) }
        Err(e) => {
            // 列不了目录 = 十有八九是系统权限。把**怎么修**直接写进胶囊,
            // 而不是让人对着一片空白猜。
            cap.scan_error = if e.kind() == std::io::ErrorKind::PermissionDenied {
                "perm".into()
            } else {
                format!("io:{}", e.kind() as u8 as char)
            };
            format!("ERR {e}")
        }
    };
    note(&format!(
        "scan id={} root={:?} read_dir={} walked_files={} dirs={} langs={} hot={}",
        cap.id, cap.path, listed, files, dirs.len(), langs.len(), hot.len(),
    ));
    let dir_names: Vec<String> = dirs.iter().map(|d| d.name.clone()).collect();
    cap.links = dir_links(root, &dir_names);
    cap.dirs = dirs;
    cap.commits = commit_days(root);
    cap.graph = constellation(root);
    cap.hot = hot;
    cap.people = contributors(root);
    cap.files = files;
    // 语言占比是**扫出来的**,不是人写的 —— 除非他自己改过
    if !cap.edited.iter().any(|e| e == "langs") {
        cap.langs = langs;
    }
    /* **扫出楼来了才算补完**。
       原来这里无条件盖上 `v = CAPSULE_V`,于是万一某一次扫描什么都没扫到,这颗胶囊就
       **永远**停在"已经是最新版"上,再也不会重试 —— 一次偶然的失败被固化成了永久的空白。
       补料很便宜(一秒),而"永远看不到城市"很贵。 */
    if cap.dirs.is_empty() {
        if cap.scan_error.is_empty() { cap.scan_error = "empty".into(); }
        note(&format!("NO BUILDINGS id={} why={} — 不盖版本号,下次开列表再试一遍",
                      cap.id, cap.scan_error));
        return false;
    }
    cap.scan_error = String::new();
    cap.v = CAPSULE_V;
    true
}

/// 开机第一次列项目时,把所有旧胶囊补齐。
///
/// 同步做的:它只跑一次(补完 `v` 就到位了),而且走的是上面那条轻路径 —— 没有
/// 图片编码。让人多等一秒、然后所有东西都在,好过让人永远看不到。
pub fn upgrade_stale(list: &mut Vec<Capsule>) -> bool {
    let mut changed = false;
    for cap in list.iter_mut() {
        // 已经是最新版的,或者手上这颗**明明有楼**的,都不用再动
        if cap.v >= CAPSULE_V && !cap.dirs.is_empty() { continue; }
        if cap.v >= CAPSULE_V && cap.path.is_empty() { continue; }   // 没路径也无从补起
        if refresh_city(cap) { changed = true; }
    }
    changed
}

/// 往 `~/.terse/projects.log` 记一行。
///
/// 为什么要有它:这个功能出过一次**只在 app 里才出现**的故障 —— 终端里同一个函数、
/// 同一个路径,扫得好好的;装成 .app 之后同一次扫描一个文件都没有。那种时候唯一能问的
/// 就是 app 自己。日志只记事实(几条、报什么错),不记内容。
fn note(line: &str) {
    use std::io::Write;
    let p = dirs::home_dir().unwrap_or_default().join(".terse").join("projects.log");
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new("/")));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{t} {line}");
    }
}

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
    #[cfg(target_os = "macos")]
    for proc_name in ["claude", "codex", "cursor-agent"] {
        let Ok(o) = std::process::Command::new("lsof")
            .args(["-c", proc_name, "-a", "-d", "cwd", "-Fn"])
            .output()
        else {
            continue;
        };
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some(p) = line.strip_prefix('n') {
                if p.starts_with('/') && !out.iter().any(|x| x == p) {
                    // 家目录本身、以及根目录不算"项目"
                    let home = dirs::home_dir().unwrap_or_default();
                    if Path::new(p) != home && p != "/" {
                        out.push(p.to_string());
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 扫描必须**真的扫出楼来**。
    ///
    /// 这条测试是有来历的:代码城市上线之后,用户点预览看到的还是老样子 —— 因为他那颗
    /// 胶囊是功能上线前扫的,`dirs` 是空的。空 `dirs` 不会报错,它只是安静地不画城市,
    /// 而"安静地什么都没有"和"这个功能没做"在屏幕上长得一模一样。所以这里钉死:
    /// 拿一个真实的目录树去扫,必须出楼,而且每座楼都得带着画它要用的那几个数。
    #[test]
    fn scan_finds_buildings_in_a_real_tree() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));   // src-tauri/,里面至少有 src/
        let (files, langs, dirs, _hot) = scan_langs(root);
        assert!(files > 0, "扫了一棵真实的目录树,却一个文件都没有");
        assert!(!langs.is_empty(), "一个全是 .rs 的目录,语言占比不该是空的");
        assert!(!dirs.is_empty(), "有文件却一座楼都没有 —— 城市就是这样静悄悄地消失的");
        let src = dirs.iter().find(|d| d.name == "src").expect("src/ 该是一座楼");
        assert!(src.files > 0 && src.bytes > 0, "楼有名字却没有体量,画出来是一块地皮");
        assert_eq!(src.lang, "rust", "src/ 全是 .rs,主语言该是 rust");
        assert!(dirs.iter().all(|d| !d.kind.is_empty()), "每座楼都得知道自己是什么形状");
        // 年轮的第二圈:不能要求**每座**楼都有子目录(src/ 就是一层平铺的 .rs),
        // 但整棵树里至少得有一座有 —— 一圈都收不到,年轮就退化成饼图了。
        assert!(dirs.iter().any(|d| !d.kids.is_empty()), "一个二级目录都没收到,年轮只剩一圈");
    }

    /// 热点必须**又勤又大**,而不是"最近改过"或者"最大的文件"。
    #[test]
    fn hotspots_rank_by_churn_times_size() {
        use std::collections::HashMap;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut pf: HashMap<String, u32> = HashMap::new();
        pf.insert("Cargo.toml".into(), 40);      // 又勤、又是真文件
        pf.insert("src/lib.rs".into(), 6);       // 不那么勤,但极大
        pf.insert("build.rs".into(), 1);         // 只动过一次 —— 不算热点
        pf.insert("no/such/file.rs".into(), 99); // 已经删掉的:不该还在图上烧
        let hot = hotspots(root, &pf);
        assert!(!hot.is_empty(), "有改动记录却一个热点都没有");
        assert!(hot.iter().all(|h| h.churn >= 2), "只动过一次的不叫热点");
        assert!(hot.iter().all(|h| h.bytes > 0), "零字节的文件画不出热度");
        assert!(!hot.iter().any(|h| h.name.contains("such")), "已经不存在的文件不该上榜");
    }

    /// 旧胶囊必须能被就地补齐 —— 而且**不动人改过的字段**。
    #[test]
    fn a_stale_capsule_upgrades_in_place() {
        let root = env!("CARGO_MANIFEST_DIR");
        let mut list = vec![Capsule {
            v: 1,
            id: "p_test".into(),
            path: root.into(),
            title: "我自己起的名字".into(),
            edited: vec!["title".into()],
            ..Default::default()
        }];
        assert!(upgrade_stale(&mut list), "v1 的胶囊必须被认成需要补料");
        let c = &list[0];
        assert_eq!(c.v, CAPSULE_V);
        assert!(!c.dirs.is_empty(), "补完还是没有楼,那就白补了");
        assert_eq!(c.title, "我自己起的名字", "补料**不许**碰人自己改过的标题");
        // 补过一次就不该再补:否则每次开列表都要重扫一遍整棵树
        assert!(!upgrade_stale(&mut list), "已经是最新版的胶囊不该被反复重扫");
    }
}
