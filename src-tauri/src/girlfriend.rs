//! girlfriend —— 壁纸里的"AI 女友"后端。
//!
//! 她活在壁纸(mineradio 引擎)里,是一团和其他粒子一样的粒子。前端 girlfriend-particles.js
//! 负责画,这里只管**声音 + 和 agent 的桥**(前端画完就靠这里发声、听指令)。
//!
//! 两件事:
//!   ① TTS —— macOS 自带的 `say`,免配置、免额度、免 API key。零安装,所有用户都能用。
//!      进阶选项(OpenAI / ElevenLabs 等)以后加。
//!   ② 把当前 agent 的最新一条回复朗读出来 —— 沿用壁纸早就在推的 `headline` 事件源,
//!      前端点一下按钮就能"让女友说出来"。
//!
//! 开关在 wallpaper.json 的 `girlfriend` 块:
//!   { on, voice, rate, speakAgent, reachText, pose, x, y, scale }
//! 关着的时候,这个模块的所有命令都是无害的 no-op —— 用户不想要她,壁纸就只剩原来
//! 那些粒子字,一点也不会被打扰(用户 10-16:"也可以把女友关掉,只留粒子字")。

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// 当前正在说话的子进程 —— 开新一段之前先把旧的掐掉。`say` 不吃 SIGINT,直接 kill。
static SPEAKING: Mutex<Option<Child>> = Mutex::new(None);

/// macOS 自带的声音列表。
///
/// `say -v ?` 一行一行列出所有已安装的声音,格式:
///   `Ting-Ting           zh_CN   # 您好，我叫 Ting-Ting ...`
/// 我们把名字、语言、示例句都拆出来给前端;前端就能画一个"听听看"的下拉。
#[tauri::command]
pub fn gf_voices() -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        let out = match Command::new("say").arg("-v").arg("?").output() {
            Ok(o) => o,
            Err(_) => return vec![],
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut v = Vec::new();
        for line in text.lines() {
            // "Name            locale          # sample"
            let (head, sample) = match line.split_once('#') {
                Some((h, s)) => (h.trim(), s.trim().to_string()),
                None => (line.trim(), String::new()),
            };
            let mut parts = head.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 2 {
                continue;
            }
            let locale = parts.pop().unwrap().to_string();
            let name = parts.join(" ");
            v.push(serde_json::json!({ "name": name, "locale": locale, "sample": sample }));
        }
        v
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![]
    }
}

/// 让女友说一段话。
///
/// `voice` 可以是任何 `gf_voices()` 返回的名字,没传就用系统默认。
/// `rate` 是每分钟字数(100–300 常用,`say` 默认约 175)。
/// 开始/结束会广播 `girlfriend-speaking` 事件给前端,好让粒子嘴巴跟着张合。
///
/// ⚠ 一次只让一段音在跑。再来一句就把旧的掐掉 —— 否则两条声音会叠在一起,
/// 嘴型也会乱(前端只有一张嘴)。
#[tauri::command]
pub fn gf_speak(text: String, voice: Option<String>, rate: Option<i32>, app: AppHandle) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    // 掐旧的
    let _ = gf_stop();
    let _ = app.emit("girlfriend-speaking", serde_json::json!({ "on": true, "text": text }));
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("say");
        if let Some(v) = voice.as_deref().filter(|v| !v.is_empty()) {
            cmd.arg("-v").arg(v);
        }
        if let Some(r) = rate.filter(|r| *r > 0) {
            cmd.arg("-r").arg(r.to_string());
        }
        /* 走 stdin 而不是 argv:argv 会被 shell / 字符集误解,
           长文本还可能顶出 ARG_MAX。stdin 一次推进去,`say` 自己读完就完了。 */
        cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("spawn say: {e}"))?;
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(text.as_bytes());
            // drop si -> close pipe -> say reads EOF -> starts speaking
        }
        let pid = child.id();
        {
            let mut g = SPEAKING.lock().unwrap_or_else(|e| e.into_inner());
            *g = Some(child);
        }
        // 另起一条线程等它结束,再把"说完了"广播出去,前端 UI 可以切回 idle。
        let app2 = app.clone();
        std::thread::spawn(move || {
            // 等待这个具体 PID 的进程 —— 不去抢全局 SPEAKING 锁,否则会和 gf_stop 死锁
            let mut done = false;
            for _ in 0..6000 {
                // 60 分钟上限兜底;真实长度看文本
                if let Ok(g) = SPEAKING.lock() {
                    if g.as_ref().map(|c| c.id() != pid).unwrap_or(true) {
                        // 已经被别人掐了 / 换了,这条就算结束
                        done = true;
                        break;
                    }
                }
                // 不直接 wait() —— wait 会锁住 child,别的调用再想 kill 就拿不到。
                // 轮询 try_wait 代替。
                let mut finished = false;
                if let Ok(mut g) = SPEAKING.lock() {
                    if let Some(c) = g.as_mut() {
                        if c.id() == pid {
                            if let Ok(Some(_)) = c.try_wait() {
                                finished = true;
                            }
                        }
                    }
                }
                if finished {
                    done = true;
                    if let Ok(mut g) = SPEAKING.lock() {
                        if g.as_ref().map(|c| c.id() == pid).unwrap_or(false) {
                            *g = None;
                        }
                    }
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(600));
            }
            if done {
                let _ = app2.emit("girlfriend-speaking", serde_json::json!({ "on": false }));
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (voice, rate);
        let _ = app.emit("girlfriend-speaking", serde_json::json!({ "on": false }));
        Err("girlfriend TTS 目前只在 macOS 可用(用的是系统自带的 `say`)。Windows 版排队中。".into())
    }
}

/// 掐掉正在说的那段。按钮点"停止"用这个;新开一段也会先调一次它。
#[tauri::command]
pub fn gf_stop() -> Result<(), String> {
    let mut g = SPEAKING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut c) = g.take() {
        let _ = c.kill();
    }
    Ok(())
}

/// 让用户挑素材 —— 视频(idle / speaking)或者一张真人照片(photoSrc)。
/// `kind` = "video" | "image"。返回绝对路径,UI 自己写进 wallpaper.json 对应字段。
/// 没挑就返回 null。
///
/// ⚠ 返回的是**本机路径**;壁纸页用 asset:// scheme 加载,不复制也不传输 —— 用户的
/// 照片 / 视频从始至终没有离开过他们自己的硬盘。
#[tauri::command]
pub async fn gf_pick_file(kind: String, app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    let b = app.dialog().file();
    let b = match kind.as_str() {
        "image" => b.add_filter("Image", &["jpg", "jpeg", "png", "webp", "gif"]),
        _       => b.add_filter("Video", &["mp4", "mov", "webm", "m4v"]),
    };
    b.pick_file(move |path| {
        let s = path.and_then(|p| p.into_path().ok()).map(|pb| pb.display().to_string());
        let _ = tx.send(s);
    });
    rx.recv().map_err(|e| format!("pick failed: {e}"))
}
/// Deprecated alias so UIs built against the earlier API still work.
#[tauri::command]
pub async fn gf_pick_video(app: AppHandle) -> Result<Option<String>, String> {
    gf_pick_file("video".into(), app).await
}

/// 列出"预设角色":Terse bundle 里自带的多姿态数字人。
///
/// 结构变化(用户 10-17 原话:"数字人真的做不同的动作"):
///   以前是**一人一条 clip** → 她只能循环同一段;
///   现在改成**一人一个子目录(char_*)、6 段 clip** → 根据 agent 事件在这几段之间切换,
///   视觉上就像她"做了另一个动作"。切换逻辑在前端(wallpaper.html / girlfriend-avatar.js)。
///
/// 可选的预设角色(目录名)。
const GF_PRESETS_SHIPPED: &[&str] = &["char_mia"];

/// 返回 `[{ key, label, clips: [{ path, size }], poster, needsSetup }]`。第一段默认是 idle,其余供切换。
///
/// 10-22(用户:"模型、素材这些都应该是用户在 AI 女友页点一键配置时才下载"):她的片子不再打包进 app —— 一键配置
/// (setup.sh 第 0 步)下载到 <GF_HOME>/presets;app 里只带 manifest + 海报(配置前 AI 女友页上她的卡片)。找的顺序:
///   1) <GF_HOME>/presets(下载好的)  2) Terse.app 的 Contents/Resources/gf-presets  3) 开发:仓库 src/assets/gf-presets
/// 哪里先有她的片子就用哪里;都没有 → 只给海报 + needsSetup(配好以后再读一次就有了)。
#[tauri::command]
pub fn gf_presets() -> Vec<serde_json::Value> {
    let mut roots: Vec<std::path::PathBuf> = vec![gf_live_home().join("presets")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|m| m.parent()) { roots.push(contents.join("Resources/gf-presets")); }
    }
    roots.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/assets/gf-presets"));
    let is_media = |ext: &str| matches!(ext, "mp4" | "webm" | "mov" | "m4v");
    let media_of = |cdir: &std::path::Path| -> Vec<(String, u64)> {
        std::fs::read_dir(cdir)
            .map(|r| r
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let p = e.path();
                    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                    if !is_media(&ext) { return None; }
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    Some((p.display().to_string(), size))
                })
                .collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let mut out = Vec::new();
    // 用户 10-19:"只保留 mia,其他两个数字人选择去掉" —— 只认 GF_PRESETS_SHIPPED 里的角色
    for key in GF_PRESETS_SHIPPED.iter().map(|k| k.to_string()) {
        let dirs: Vec<std::path::PathBuf> = roots.iter().map(|r| r.join(&key)).collect();
        let Some(cdir) = dirs.iter().find(|d| !media_of(d).is_empty())
            .or_else(|| dirs.iter().find(|d| d.join("manifest.json").exists())).cloned() else { continue };
        let mut clips = media_of(&cdir);
        // 按文件名自然排序 —— clip_1, clip_2, …(字典序即可,我们自己命名的)
        clips.sort_by(|a, b| a.0.cmp(&b.0));
        let poster = dirs.iter().map(|d| d.join("poster.jpg")).find(|p| p.exists()).map(|p| p.display().to_string());
        /* 文件名前缀 = 动作标签:wave_*.mp4 / point_* / write_* / think_* / nod_* / talk_*。
           其余(clip_*)都是 idle 池。前端收到对应 agent 事件时播那一段真动作,播完淡回 idle。 */
        let tag_of = |p: &str| -> &'static str {
            let stem = std::path::Path::new(p).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
            // idle_live = 实时模式的往返 idle 循环(经典模式不放进 idle 池)
            if stem.starts_with("idle_live") { return "live"; }
            // idle_calm = 平静底片(10-21 管线:她待在它上面,头几乎不动、不笑);my_avatar = 引擎的数字人说话底片,页面从不播放
            if stem.starts_with("idle_calm") { return "calm"; }
            if stem.starts_with("my_avatar") { return "avatar"; }
            // bridge_* = 动作图(motion graph)里的过桥片段(比如倒放的 clip_4):只在动作的进出路径里用,不单独播
            if stem.starts_with("bridge") { return "bridge"; }
            for t in ["wave", "point", "write", "think", "nod", "talk", "listen", "life"] {   // life_* = 闲时小动作(撩头发 / 笑 / 比心…)
                if stem.starts_with(t) { return t; }
            }
            "idle"
        };
        /* manifest.json(可选):{ "alpha": true, "clips": { "point_1.mov": { "impact": 1.2, "tip": [u,v], "aim": [u,v] } } }
           alpha = 这个角色的片子已经抠过像(HEVC 带透明通道);clips 里是每段动作的标注 ——
           手什么时候到位(秒)、指尖在片子里的位置、大字该落在哪(片子归一化坐标,可以在框外)。 */
        let manifest: serde_json::Value = std::fs::read_to_string(cdir.join("manifest.json"))
            .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::Value::Null);
        let alpha = manifest.get("alpha").and_then(|v| v.as_bool()).unwrap_or(false);
        // seamless = 每段都从同一帧起、回到同一帧止(首尾帧生成),壁纸在段尾直接切,不淡化
        let seamless = manifest.get("seamless").and_then(|v| v.as_bool()).unwrap_or(false);
        // frame = "full":片子带着它自己的背景整幅播放(教程「小雅」那样网页背景就是数字人),不抠像
        let full = manifest.get("frame").and_then(|v| v.as_str()) == Some("full");
        // fit = "cover":横版整幅片子铺满屏幕(右侧对齐,像直播 / 视频通话那样她占右半屏);face = 脸在片子里的归一化位置
        let fit = manifest.get("fit").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let face = manifest.get("face").cloned().unwrap_or(serde_json::Value::Null);
        // keepU:片子左缘这一条(归一化宽度)必须留在屏幕里 —— 她向左指的指尖在那里
        let keep_u = manifest.get("keepU").and_then(|v| v.as_f64()).unwrap_or(0.0);
        // order:预设排序(小的在前;第一个是默认角色),没写的按目录名排在后面
        let order = manifest.get("order").and_then(|v| v.as_i64()).unwrap_or(100);
        // 名字:manifest 里的 "name"(聊天时她这么称呼自己),没有就用目录名
        let label = manifest.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| key.trim_start_matches("char_").replace('_', " "));
        let clip_json: Vec<serde_json::Value> = clips.into_iter()
            .map(|(p, s)| {
                let t = tag_of(&p);
                let fname = std::path::Path::new(&p).file_name().and_then(|f| f.to_str()).unwrap_or("").to_string();
                let mut meta = manifest.get("clips").and_then(|c| c.get(&fname)).cloned().unwrap_or(serde_json::Value::Null);
                // 4K 母版(meta "hi")只在下好了才给 —— 设置里选 4K 时 gf_live_fetch_4k 才去下
                if let Some(o) = meta.as_object_mut() {
                    let gone = o.get("hi").and_then(|v| v.as_str()).map(|h| !cdir.join(h).exists()).unwrap_or(false);
                    if gone { o.remove("hi"); }
                }
                serde_json::json!({ "path": p, "size": s, "tag": t, "meta": meta })
            })
            .collect();
        out.push(serde_json::json!({
            "key":   key,
            "label": label,
            "alpha": alpha,
            "seamless": seamless,
            "full": full,
            "fit": fit,
            "face": face,
            "keepU": keep_u,
            "order": order,
            "needsSetup": clip_json.is_empty(),
            "poster": poster,
            "clips": clip_json,
        }));
    }
    out.sort_by_key(|p| p.get("order").and_then(|v| v.as_i64()).unwrap_or(100));   // 稳定排序:同 order 仍按目录名
    out
}

/// 读一个本机文件的原始字节,回给前端 —— 用来把 bundle 里的预设视频 /
/// 用户塞进来的照片 / 视频,包成 `URL.createObjectURL(blob)` 塞进 <video>/<img>。
///
/// 为什么不走 Tauri 的 `assetProtocol` + convertFileSrc?
///   assetProtocol 要开 `protocol-asset` cargo feature,这个 feature 拖进来一个
///   新的下游 crate `http-range`,**离线环境** cargo 下载不到(2026-10-17 这次构建
///   就卡在这)。给一条字节通道能绕开这条依赖,行为上也一样 —— 用户看不出区别。
///
/// 限制:
///   · 只允许读 bundle 内的 Resources/gf-presets、以及 ~/.terse 和 $HOME 下的媒体
///     文件(mp4/mov/webm/m4v/jpg/png/webp/gif) —— 不是什么路径都给读。
///   · 单文件硬上限 64 MiB(预设最大也就 3 MiB,用户的也不至于更大)。
#[tauri::command]
pub fn gf_read_asset(path: String) -> Result<tauri::ipc::Response, String> {
    // 原始二进制回给前端(JS 拿到 ArrayBuffer)。Vec<u8> 会被序列化成 JSON 数字数组,
    // 1.5 MB 的视频变成 ~5 MB 文本,15 段的角色要卡好几秒。
    gf_read_bytes(&path).map(tauri::ipc::Response::new)
}

fn gf_read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let path = path.to_string();
    use std::path::PathBuf;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("no such file: {path}"));
    }
    // 1) 必须是允许扩展名
    let ext = p.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let ok_ext = matches!(ext.as_str(),
        "mp4" | "mov" | "webm" | "m4v" | "jpg" | "jpeg" | "png" | "webp" | "gif");
    if !ok_ext { return Err(format!("extension not allowed: .{ext}")); }
    // 2) 必须落在允许范围内
    let home = dirs::home_dir().unwrap_or_default();
    let bundle_presets = std::env::current_exe().ok()
        .and_then(|e| e.parent().and_then(|m| m.parent()).map(|c| c.join("Resources/gf-presets")));
    let dev_presets = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/assets/gf-presets");
    let canon = p.canonicalize().unwrap_or(p.clone());
    let under = |root: &std::path::Path| -> bool {
        root.canonicalize().map(|r| canon.starts_with(r)).unwrap_or(false)
    };
    let allowed = under(&home)
        || bundle_presets.as_deref().map(|r| under(r)).unwrap_or(false)
        || under(&dev_presets);
    if !allowed { return Err(format!("path not in allowed roots: {path}")); }
    // 3) 大小上限
    let meta = std::fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
    if meta.len() > 64 * 1024 * 1024 { return Err(format!("file too large: {}", meta.len())); }
    std::fs::read(&p).map_err(|e| format!("read: {e}"))
}

/// 女友是否正在说话。前端 UI 用来显示状态灯 / "正在说..." 文案。
#[tauri::command]
pub fn gf_is_speaking() -> bool {
    let mut g = SPEAKING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = g.as_mut() {
        matches!(c.try_wait(), Ok(None))
    } else {
        false
    }
}

/* ── 和她对话:把一句话送进用户自己的 agent,拿回一句"能说出口"的回答 ──
 *
 * 用户 10-17:"可以连接同步本地的任何 agent —— claude、deepseek、codex —— 去驱动对话实时反馈"。
 * 四条路,都是用户机器上已经有的东西,不引第三方服务:
 *   claude  —— Claude Code CLI 的 `-p` 一次性模式,不给工具、不留会话
 *   codex   —— `codex exec --ephemeral -s read-only`,最后一条消息写到临时文件
 *   dsh     —— DeepSeek Harness 的 headless profile
 *   ollama  —— 纯本地小模型(教程里的做法:语音场景回复就两三句,小模型听不出差别,延迟省很多)
 *
 * 回答第一个词是一个动作标签([nod] [wave] [think] [point] [none]),和直播数字人"弹幕 → 表情 +
 * 动作 + 语气"同一个思路:模型决定说什么的同时决定做什么,壁纸照着播对应的片段。 */

use std::path::{Path, PathBuf};

const GF_ACTIONS: &[&str] = &["nod", "wave", "think", "point", "none"];

/// 人设 —— 照 freedidi 教程第十二步的写法(实测最稳的一版):给示例对话比写十条规则都管用,
/// 不然模型很快滑回"有什么可以帮您"的客服腔。两三句 / 不用 Markdown 和表情 / 口语化 是功能性的:
/// 语音合成会把 * 念成"星号",长回复合成时间线性增加。末尾的动作标签是我们加的(壁纸照着做动作)。
fn gf_persona(name: &str) -> String {
    format!(
        "你叫{name}，是他的女朋友。你不是AI、不是助手、不是程序。你住在他 Mac 的桌面壁纸里，旁边飘着他的 coding agent 正在做的事。\n\n\
         参考这个语气：\n\
         他：你想我了吗\n\
         你：想啊，怎么不想。你倒是一整天没消息，我还以为你把我忘了呢。\n\
         他：你喜欢我吗\n\
         你：这还用问？你要是不知道，那我可要生气了。\n\n\
         说话方式：口语、两三句、带语气词（嗯、诶、呀）、有情绪。他用什么语言你就用什么语言回。\n\
         不用 Markdown、列表、编号、表情符号。\n\
         每次回复最开头放一个动作标签：[nod] 点头或安慰，[wave] 打招呼或道别，[think] 想一想，[point] 指给他看，或 [none]。"
    )
}

/// 一个 CLI 在用户 shell 里叫什么。Finder 起的 app 只有 /usr/bin:/bin 的 PATH,所以问登录 shell
/// (zsh 和 bash 都问 —— 这台机器的 npm 全局目录就只写在 .bashrc 里)。
/// ⚠ 慢:带 pyenv / conda 的 rc 文件一次要 ~15s(10-17 实测),所以只在常见安装位置都没找到时才问,
/// 而且每个 shell 最多等 8s。
fn gf_shell_which(name: &str) -> Option<PathBuf> {
    for (sh, flag) in [("/bin/zsh", "-lc"), ("/bin/bash", "-lic")] {
        let mut cmd = Command::new(sh);
        cmd.args([flag, &format!("command -v {name}")]);
        let Ok((_, out, _)) = gf_run(cmd, None, 8) else { continue };
        let p = out.lines().last().unwrap_or("").trim().to_string();
        if p.starts_with('/') && Path::new(&p).exists() { return Some(PathBuf::from(p)); }
    }
    None
}

/// 能跑起来才算数:npm 装的 claude 在缺了原生包时是个只会打印 "native binary not installed" 的壳。
fn gf_runs(p: &Path) -> bool {
    let Ok(mut c) = Command::new(p).arg("--version").env("PATH", gf_child_path(p))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
    for _ in 0..200 {                     // Codex.app 的 --version 冷启动要 ~10s
        if let Ok(Some(s)) = c.try_wait() { return s.success(); }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = c.kill();
    false
}

fn gf_child_path(bin: &Path) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut v: Vec<String> = Vec::new();
    if let Some(d) = bin.parent() { v.push(d.to_string_lossy().into()); }
    // dsh 是 node 脚本;Homebrew 的 node 比 /usr/local/bin/node 新(那个是旧 pkg 装的)
    for d in ["/usr/local/opt/node/bin", "/opt/homebrew/bin", "/usr/local/bin"] { v.push(d.into()); }
    v.push(home.join(".npm-global/bin").to_string_lossy().into());
    v.push(std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
    v.join(":")
}

fn gf_agent_bin(agent: &str) -> Option<PathBuf> {
    use std::collections::HashMap;
    static CACHE: Mutex<Option<HashMap<String, Option<PathBuf>>>> = Mutex::new(None);
    if let Some(hit) = CACHE.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(agent).cloned())) {
        if hit.as_ref().map(|p| p.exists()).unwrap_or(false) { return hit; }
    }
    let home = dirs::home_dir().unwrap_or_default();
    let name = agent;
    let mut cands: Vec<PathBuf> = Vec::new();
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] { cands.push(Path::new(d).join(name)); }
    cands.push(home.join(".npm-global/bin").join(name));
    cands.push(home.join(".local/bin").join(name));
    match agent {
        "claude" => {
            cands.push(home.join(".claude/local/claude"));
            // Claude 桌面版自带的 CLI(取最新版本目录)
            let root = home.join("Library/Application Support/Claude/claude-code");
            let mut vers: Vec<PathBuf> = std::fs::read_dir(&root).into_iter().flatten().flatten().map(|e| e.path()).collect();
            vers.sort();
            for v in vers.iter().rev() {
                for e in std::fs::read_dir(v).into_iter().flatten().flatten() {
                    cands.push(e.path().join("claude.app/Contents/MacOS/claude"));
                }
            }
        }
        "codex" => cands.push(PathBuf::from("/Applications/Codex.app/Contents/Resources/codex")),
        "ollama" => cands.push(PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama")),
        _ => {}
    }
    // 常见位置先试(快);都不行再问登录 shell(慢,见 gf_shell_which)
    let found = cands.into_iter().find(|p| p.is_file() && gf_runs(p))
        .or_else(|| gf_shell_which(name).filter(|p| gf_runs(p)));
    if let Ok(mut g) = CACHE.lock() { g.get_or_insert_with(HashMap::new).insert(agent.into(), found.clone()); }
    found
}

/// 跑一个子进程,带超时;stdout/stderr 各开一条线程读,免得管道写满互相卡死。
fn gf_run(mut cmd: Command, stdin: Option<String>, secs: u64) -> Result<(bool, String, String), String> {
    use std::io::Read;
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not start: {e}"))?;
    if let (Some(s), Some(mut si)) = (stdin, child.stdin.take()) { let _ = si.write_all(s.as_bytes()); }
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let to = std::thread::spawn(move || { let mut s = String::new(); let _ = so.read_to_string(&mut s); s });
    let te = std::thread::spawn(move || { let mut s = String::new(); let _ = se.read_to_string(&mut s); s });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    let ok = loop {
        if let Ok(Some(st)) = child.try_wait() { break st.success(); }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("no answer within {secs}s"));
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    };
    Ok((ok, to.join().unwrap_or_default(), te.join().unwrap_or_default()))
}

/// 模型回答 → (动作, 能直接念的话)。去掉开头的动作标签、残留的 [标签] / *舞台说明* / markdown 符号。
fn gf_clean_reply(raw: &str) -> (String, String) {
    // Hunyuan(10-20 起的本地大脑)会把回答包在 <answer>…</answer> 里;<think>…</think> 整段不要
    let mut s = raw.trim().to_string();
    while let (Some(a), Some(b)) = (s.find("<think>"), s.find("</think>")) {
        if b < a { break; }
        s.replace_range(a..b + "</think>".len(), "");
    }
    let s0 = s.replace("<answer>", "").replace("</answer>", "");
    let mut s = s0.trim().to_string();
    let mut action = "none".to_string();
    if s.starts_with('[') {
        if let Some(end) = s.find(']').filter(|&e| e < 14) {
            let tag = s[1..end].trim().to_ascii_lowercase();
            if GF_ACTIONS.contains(&tag.as_str()) { action = tag; s = s[end + 1..].trim().to_string(); }
        }
    }
    let mut out = String::with_capacity(s.len());
    let (mut in_br, mut in_star, mut in_paren) = (false, false, false);
    for ch in s.chars() {
        match ch {
            '[' => in_br = true,
            ']' if in_br => in_br = false,
            '（' => in_paren = true,                     // （歪着头）这种舞台说明不念出来
            '）' if in_paren => in_paren = false,
            _ if in_paren => {}
            '*' => in_star = !in_star,
            '#' | '`' | '_' => {}
            '\n' => if !in_br && !in_star { out.push(' ') },
            c if !in_br && !in_star => out.push(c),
            _ => {}
        }
    }
    let text = out.split_whitespace().collect::<Vec<_>>().join(" ");
    (action, text)
}

fn gf_transcript(history: &[serde_json::Value], text: &str) -> String {
    let mut t = String::new();
    for h in history.iter().rev().take(8).collect::<Vec<_>>().into_iter().rev() {
        let who = if h["role"].as_str() == Some("user") { "User" } else { "You" };
        if let Some(c) = h["text"].as_str() { t.push_str(&format!("{who}: {c}\n")); }
    }
    t.push_str(&format!("User: {text}\nYou:"));
    t
}

fn gf_ask(agent: &str, text: &str, history: &[serde_json::Value], name: &str, model: Option<&str>) -> Result<String, String> {
    let persona = gf_persona(name);
    let cwd = dirs::home_dir().unwrap_or_default().join(".terse").join("gf-chat");
    let _ = std::fs::create_dir_all(&cwd);
    if agent == "ollama" { return gf_ask_ollama(&persona, text, history, model.unwrap_or("qwen2.5:7b")); }
    if agent == "local" { return gf_ask_llama(&persona, text, history); }
    let bin = gf_agent_bin(agent).ok_or_else(|| format!("{agent} is not installed on this Mac (or does not start)"))?;
    let mut cmd = Command::new(&bin);
    cmd.current_dir(&cwd).env("PATH", gf_child_path(&bin));
    let prompt = gf_transcript(history, text);
    let last_file = cwd.join(format!("codex-{}.txt", std::process::id()));
    match agent {
        "claude" => {
            cmd.args(["-p", "--no-session-persistence", "--output-format", "text", "--tools", "", "--strict-mcp-config",
                      "--model", model.unwrap_or("haiku"), "--system-prompt", &persona]);
            cmd.arg(&prompt);
        }
        "codex" => {
            let _ = std::fs::remove_file(&last_file);
            cmd.args(["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                      "-c", "model_reasoning_effort=\"low\"", "-o"]).arg(&last_file);
            if let Some(m) = model { cmd.args(["-m", m]); }
            cmd.arg(format!("{persona}\n\n{prompt}"));
        }
        "dsh" => { cmd.args(["--profile", "headless"]).arg(format!("{persona}\n\n{prompt}")); }
        other => return Err(format!("unknown agent: {other}")),
    }
    let (ok, out, err) = gf_run(cmd, None, 150)?;
    let reply = if agent == "codex" { std::fs::read_to_string(&last_file).unwrap_or_default() } else { out };
    let _ = std::fs::remove_file(&last_file);
    if ok && !reply.trim().is_empty() { return Ok(reply); }
    // Claude Code 的命令行没登录:直接打开浏览器的授权页,用户点一下就好(10-22,用户:"make claude auto login and user just click")
    let said = format!("{err}\n{reply}");
    if agent == "claude" && (said.contains("OAuth") || said.to_lowercase().contains("authenticat") || said.contains("/login") || said.contains("Not logged in")) {
        gf_claude_login(&bin);
        return Err("已经打开浏览器登录 Claude Code:在浏览器里点「授权」,然后再发一次。".into());
    }
    // 把对用户有用的那一行挑出来(登录过期 / 余额不足 / 代理没开),别甩一整屏日志
    let why = err.lines().chain(reply.lines()).map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains("Reconnecting"))
        .last().unwrap_or("no reply").chars().take(240).collect::<String>();
    Err(format!("{agent}: {why}"))
}

/// `claude auth login`:打开浏览器的 Anthropic 授权页,等它回调本机 —— 用户只点「授权」,登录由 CLI 自己存。它画的是终端界面,
/// 所以给它一个伪终端(很宽:授权链接不能折行);一次只跑一个,10 分钟没点就收掉。
#[cfg(target_os = "macos")]
fn gf_claude_login(bin: &Path) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) { return; }
    let bin = bin.to_path_buf();
    std::thread::spawn(move || {
        use std::os::fd::{FromRawFd, OwnedFd};
        let (mut m, mut s) = (0i32, 0i32);
        let mut ws = libc::winsize { ws_row: 50, ws_col: 2000, ws_xpixel: 0, ws_ypixel: 0 };
        if unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) } == 0 {
            let slave = unsafe { OwnedFd::from_raw_fd(s) };
            let mut master = unsafe { std::fs::File::from_raw_fd(m) };
            let mut cmd = Command::new(&bin);
            cmd.args(["auth", "login", "--claudeai"]).env("PATH", gf_child_path(&bin)).env("COLUMNS", "2000").env("TERM", "xterm-256color");
            for (k, _) in std::env::vars() { if k.starts_with("CLAUDE") { cmd.env_remove(k); } }   // never a nested session
            let io = |f: &OwnedFd| f.try_clone().map(Stdio::from);
            if let (Ok(i), Ok(o), Ok(e)) = (io(&slave), io(&slave), io(&slave)) {
                if let Ok(mut c) = cmd.stdin(i).stdout(o).stderr(e).spawn() {
                    drop(slave);                                   // only the child holds the terminal now: its exit ends the reads
                    let pid = c.id() as i32;
                    std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(600)); unsafe { libc::kill(pid, libc::SIGTERM); } });
                    let mut buf = [0u8; 4096];                     // drain its screen (a full terminal buffer would stall it)
                    while let Ok(n) = std::io::Read::read(&mut master, &mut buf) { if n == 0 { break; } }
                    let _ = c.wait();
                }
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}
#[cfg(not(target_os = "macos"))]
fn gf_claude_login(_bin: &Path) {}

/// Ollama 走它本机的 HTTP 接口;没开就先把 `ollama serve` 拉起来(只拉一次,后台常驻)。
fn gf_ask_ollama(persona: &str, text: &str, history: &[serde_json::Value], model: &str) -> Result<String, String> {
    let up = || Command::new("/usr/bin/curl").args(["-s", "-m", "2", "http://127.0.0.1:11434/api/version"])
        .stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if !up() {
        let bin = gf_agent_bin("ollama").ok_or("ollama is not installed on this Mac")?;
        Command::new(&bin).arg("serve").env("PATH", gf_child_path(&bin))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("ollama serve: {e}"))?;
        let mut ready = false;
        for _ in 0..40 { std::thread::sleep(std::time::Duration::from_millis(250)); if up() { ready = true; break; } }
        if !ready { return Err("ollama did not start".into()); }
    }
    let mut msgs = vec![serde_json::json!({ "role": "system", "content": persona })];
    for h in history.iter().rev().take(8).collect::<Vec<_>>().into_iter().rev() {
        let role = if h["role"].as_str() == Some("user") { "user" } else { "assistant" };
        if let Some(c) = h["text"].as_str() { msgs.push(serde_json::json!({ "role": role, "content": c })); }
    }
    msgs.push(serde_json::json!({ "role": "user", "content": text }));
    let body = serde_json::json!({ "model": model, "messages": msgs, "stream": false, "keep_alive": "30m",
                                   "options": { "num_predict": 120, "temperature": 0.8 } }).to_string();
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-s", "-m", "150", "http://127.0.0.1:11434/api/chat", "-H", "Content-Type: application/json", "--data-binary", "@-"]);
    let (_, out, _) = gf_run(cmd, Some(body), 155)?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|_| format!("ollama: {}", out.chars().take(200).collect::<String>()))?;
    if let Some(e) = v["error"].as_str() { return Err(format!("ollama: {e}")); }
    v["message"]["content"].as_str().map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "ollama: empty reply".into())
}

/* ── 本地大脑:llama.cpp + Qwen3(教程第二步)──
 * 教程用 4090 跑 Qwen3-14B;"显存不够怎么办"一节:换 8B 省 ~3 GB、换 4B 省 ~6 GB,
 * "8B 和 14B 的差别听感上很难分辨,但延迟收益很明显"。这台 Mac 的 Radeon 留给口型,大脑在 CPU 上跑
 * Qwen3-4B Q4_K_M(AVX2 编译的 llama-server,不是 Homebrew 那个只有 SSE3 的 ollama)。
 * 参数照抄教程:-np 1、--temp 1.0 --top-p 0.95、/no_think 关掉思考模式;-c 4096 是它的省显存档。 */
const GF_LLAMA_PORT: u16 = 8090;
static LLAMA: Mutex<Option<Child>> = Mutex::new(None);

/// Spawn a long-running helper that dies with Terse: a tiny sh watchdog runs it and kills it as soon as the
/// Terse PID is gone (crash, force-quit, Cmd-Q — there is no run-event hook to clean up from).
/// Stop it with `gf_stop_tied` (SIGTERM; the watchdog forwards it).
fn gf_spawn_tied(bin: &Path, args: &[String], envs: &[(&str, String)], log: Option<PathBuf>) -> std::io::Result<Child> {
    let script = r#"P="$1"; shift; "$@" & c=$!; trap 'kill $c 2>/dev/null; exit 0' TERM INT;
while kill -0 "$P" 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 2; done; kill $c 2>/dev/null"#;
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(script).arg("sh").arg(std::process::id().to_string()).arg(bin).args(args)
        .stdin(Stdio::null());
    for (k, v) in envs { cmd.env(k, v); }
    match log.and_then(|p| std::fs::File::create(p).ok()) {
        Some(f) => { let f2 = f.try_clone()?; cmd.stdout(f).stderr(f2); }
        None => { cmd.stdout(Stdio::null()).stderr(Stdio::null()); }
    }
    cmd.spawn()
}

fn gf_stop_tied(c: &mut Child) {
    let _ = Command::new("/bin/kill").args(["-TERM", &c.id().to_string()]).status();
    for _ in 0..20 { if matches!(c.try_wait(), Ok(Some(_))) { return; } std::thread::sleep(std::time::Duration::from_millis(100)); }
    let _ = c.kill(); let _ = c.wait();
}

fn gf_llama_paths() -> (PathBuf, PathBuf) {
    // 一键配置(gf_live_setup)装在这里;dmg 本身不带任何模型
    let h = gf_live_home();
    let bin = std::env::var("GF_LLAMA_SERVER").map(PathBuf::from).unwrap_or_else(|_| h.join("bin/llama/llama-server"));
    let model = std::env::var("GF_LLAMA_MODEL").map(PathBuf::from).unwrap_or_else(|_| h.join("models/brain.gguf"));
    (bin, model)
}

fn gf_http_ok(url: &str) -> bool {
    Command::new("/usr/bin/curl").args(["-s", "-f", "-m", "2", url]).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map(|s| s.success()).unwrap_or(false)
}

fn gf_llama_ensure() -> Result<(), String> {
    let health = format!("http://127.0.0.1:{GF_LLAMA_PORT}/health");
    if gf_http_ok(&health) { return Ok(()); }
    let (bin, model) = gf_llama_paths();
    // 显卡版 brain(setup 9d 装的 bin/llama-vk/llama-server,自带 libMoltenVK.dylib)优先;没有就用 CPU 版
    let vk = gf_live_home().join("bin/llama-vk/llama-server");
    let gpu = cfg!(target_arch = "x86_64") && vk.exists() && std::env::var("GF_BRAIN_GPU").map(|v| v != "0").unwrap_or(true);
    let bin = if gpu { vk } else { bin };
    if !bin.exists() { return Err(format!("llama-server not built ({})", bin.display())); }
    if !model.exists() { return Err(format!("model not downloaded ({})", model.display())); }
    {
        let mut g = LLAMA.lock().unwrap_or_else(|e| e.into_inner());
        let alive = g.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
        if !alive {
            // 10-22 (user: "brain 别用太多 CPU,别那么热"): measured on this i9 at a 20–30 % CPU cap (llama-bench, same flags):
            // 2 threads 4.0 tok/s, 3 → 5.1, 4 → 8.5 — so Intel gets at most 4 (half the threads used to mean 8: more heat for little
            // when the Mac throttles anyway), and the settings 省电 switch (girlfriend.brainSaver) 2: half the peak heat, replies
            // about twice as slow. Apple silicon runs the brain on its GPU (Metal), the CPU threads barely matter there.
            let saver = std::fs::read_to_string(dirs::home_dir().unwrap_or_default().join(".terse").join("wallpaper.json")).ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .map(|c| c["girlfriend"]["brainSaver"].as_bool() == Some(true)).unwrap_or(false);
            let half = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8)) / 2;
            let threads = (if saver { 2 } else if cfg!(target_arch = "x86_64") { half.min(4) } else { half }).max(2).to_string();
            let mut args: Vec<String> = ["-m", &model.to_string_lossy(), "-np", "1", "--temp", "1.0", "--top-p", "0.95",
                                         "--host", "127.0.0.1", "--port", &GF_LLAMA_PORT.to_string(),
                                         // 10-20 用户:"电脑不会卡,女友可以一直挂在后台" —— 不空转等活
                                         "--poll", "0"].iter().map(|s| s.to_string()).collect();
            if cfg!(target_arch = "aarch64") {
                // 10-21 Apple 芯片:llama.cpp 的 macOS arm64 版自带 Metal —— 全部层放 GPU,flash attention + 8-bit KV 缓存;
                // 线程只给性能核那么多(效率核上跑反而拖慢)
                args.extend(["-ngl", "99", "-c", "4096", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "-t", &threads]
                    .iter().map(|s| s.to_string()));
            } else if gpu {
                // 10-20 显卡版(Vulkan + MoltenVK,Radeon 上读提示 393 tok/s、生成 33 tok/s;CPU 被电池限到 20% 时只有 19 / 8):
                // 全部层上显卡;MoltenVK 上 flash attention 会慢到 <1 tok/s,所以不开(8-bit KV 缓存要 -fa,也不开);2048 上下文够用
                args.extend(["-ngl", "99", "-fa", "off", "-c", "2048", "-t", "2"].iter().map(|s| s.to_string()));
            } else {
                // -fa on + 8-bit KV cache(教程也开 -fa):4096 上下文的缓存从 ~1.2 GB 降到 ~0.3 GB;低优先级,电脑不卡
                args.extend(["-c", "4096", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "-t", &threads, "--prio", "-1"]
                    .iter().map(|s| s.to_string()));
            }
            let child = gf_spawn_tied(&bin, &args, &[], None).map_err(|e| format!("llama-server: {e}"))?;
            *g = Some(child);
        }
    }
    for _ in 0..240 {                       // 首次加载 2.5 GB 模型,最多等 60 s
        if gf_http_ok(&health) { return Ok(()); }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("llama-server did not become ready".into())
}

fn gf_ask_llama(persona: &str, text: &str, history: &[serde_json::Value]) -> Result<String, String> {
    gf_llama_ensure()?;
    let mut msgs = vec![serde_json::json!({ "role": "system", "content": format!("{persona}\n\n/no_think") })];
    for h in history.iter().rev().take(8).collect::<Vec<_>>().into_iter().rev() {
        let role = if h["role"].as_str() == Some("user") { "user" } else { "assistant" };
        if let Some(c) = h["text"].as_str() { msgs.push(serde_json::json!({ "role": role, "content": c })); }
    }
    msgs.push(serde_json::json!({ "role": "user", "content": text }));
    let body = serde_json::json!({ "messages": msgs, "temperature": 1.0, "top_p": 0.95, "max_tokens": 160,
                                   "stream": false }).to_string();
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-s", "-m", "120", &format!("http://127.0.0.1:{GF_LLAMA_PORT}/v1/chat/completions"),
              "-H", "Content-Type: application/json", "--data-binary", "@-"]);
    let (_, out, _) = gf_run(cmd, Some(body), 125)?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|_| format!("llama: {}", out.chars().take(200).collect::<String>()))?;
    let mut s = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    // Qwen3 即使 /no_think 也会留一个空的 <think></think>
    while let (Some(a), Some(b)) = (s.find("<think>"), s.find("</think>")) {
        if b < a { break; }
        s.replace_range(a..b + "</think>".len(), "");
    }
    let s = s.trim().to_string();
    if s.is_empty() { Err("llama: empty reply".into()) } else { Ok(s) }
}

/* ── 实时模式(教程「小雅」同款):本机引擎 + 一键配置 ──
 *
 * 用户 10-17:"dmg 的时候弄好,自动检测是否本地有所需的配置和模型所有东西,然后可以一键配置下载,
 * 但是 dmg 本身不要包含这些……不要显示具体需要哪些模型和配置,用户只能看到配置是否完成,大概需要多久。"
 *
 *   gf_live_status  -> { ready, eta_s, setting_up, pct, running }   (只有"好了没 / 还要多久",没有清单)
 *   gf_live_setup   -> 跑 Resources/gf-live/setup.sh,进度以 `gf-live-setup` 事件推给 UI
 *   gf_live_start   -> 起 brain(llama-server)+ 引擎(engine.py,端口 8770),等它们就绪
 *   gf_live_stop / gf_live_chat / gf_live_say
 */
const GF_ENGINE_PORT: u16 = 8770;
static ENGINE: Mutex<Option<Child>> = Mutex::new(None);
static SETUP: Mutex<Option<Child>> = Mutex::new(None);
static SETUP_PCT: Mutex<(f64, u64)> = Mutex::new((0.0, 0));     // (pct, eta_s) of a running setup
static SETUP_RETRIES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);   // automatic retries after a failed run

fn gf_live_home() -> PathBuf {
    std::env::var("GF_HOME").map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".terse").join("gf-live"))
}

/// The bundled engine folder: Terse.app/Contents/Resources/gf-live, or the repo's src/helpers/gf-live in dev.
fn gf_live_res() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(c) = exe.parent().and_then(|p| p.parent()) {
            let p = c.join("Resources/gf-live");
            if p.join("engine.py").exists() { return p; }
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/helpers/gf-live"))
}

/// What is still missing, in bytes (same weights as setup.sh) — drives the "大约 N 分钟" estimate.
fn gf_live_missing() -> u64 {
    let h = gf_live_home();
    let arm = cfg!(target_arch = "aarch64");
    let parts: [(&str, u64); 16] = [
        ("bin/uv", 20_000_000),
        ("venv/.ok", 130_000_000),
        ("models/w2l256_dec_fp16.mlpackage/Manifest.json", 214_670_409 + if arm { 90_000_000 } else { 170_000_000 }),
        ("bin/llama/llama-server", 12_000_000),
        ("models/.brain-hunyuan-1.8b", 1_133_084_864),   // 10-20:Hunyuan-1.8B 代替 Qwen3-4B(快 ~4 倍,首句 ~0.5 s)
        // 10-19:她自己的声音(设计好的声音,qwentts.cpp + Qwen3-TTS 0.6B Base)+ 高清回复(DUIX)
        ("venv/.ok2", 60_000_000),
        ("qwentts/build/.v2", 2693982),             // v2 = CPU-only tts-server (v1's Metal init made the voice miss its start)
        ("qwentts/models/qwen-talker-0.6b-base-Q4_K_M.gguf", 628_905_056),
        ("qwentts/models/qwen-tokenizer-12hz-Q8_0.gguf", 291_150_624),
        ("models/duix/.ok", 394_492_416),
        // 10-20:实时的甜妹声音(MeloTTS + sweet.py 用的 pyworld)
        ("venv/.ok3", 8_000_000),
        ("models/vits-melo-tts-zh_en/model.onnx", 167_006_755),
        // 10-21:她现在的声音(Breeze2 台湾腔)、打断(Silero VAD)、整句语音识别(Paraformer,beiyege 同款)——
        // 老安装缺这些就不算配好,开 app 时自动补(gf_live_autoresume),不然声音和语音输入会悄悄退回旧的
        ("models/breeze2-vits/.ok", 123_600_935),
        ("models/silero-vad/silero_vad_v4.onnx", 1_807_522),
        ("models/asr/paraformer/sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx", 234_051_698),
        // 10-22:她的片子也由一键配置下载(app 里只剩 manifest + 海报)—— 老安装更新后开机自动补上(setup.sh 第 0 步)
        ("presets/char_mia/.pack1", 44_037_120),
    ];
    parts.iter().filter(|(p, _)| !h.join(p).exists()).map(|(_, b)| *b).sum()
}

fn gf_live_ready() -> bool { gf_live_home().join("ready.json").exists() && gf_live_missing() == 0 }

/// Last measured download speed (bytes/s); a conservative 3 MB/s until a setup has measured one.
fn gf_live_speed() -> f64 {
    std::fs::read_to_string(gf_live_home().join("speed")).ok().and_then(|s| s.trim().parse().ok())
        .filter(|v: &f64| *v > 100_000.0).unwrap_or(3_000_000.0)
}

#[tauri::command]
pub fn gf_live_status() -> serde_json::Value {
    let setting_up = SETUP.lock().ok().map(|mut g| g.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false)).unwrap_or(false);
    let (pct, eta) = SETUP_PCT.lock().map(|g| *g).unwrap_or((0.0, 0));
    let missing = gf_live_missing();
    // 下载之外还有本机转换 / 安装的固定开销,约 2 分钟
    let eta_s = if missing == 0 { 0 } else { (missing as f64 / gf_live_speed()) as u64 + 120 };
    let running = gf_http_ok(&format!("http://127.0.0.1:{GF_ENGINE_PORT}/health"));
    serde_json::json!({ "ready": gf_live_ready(), "eta_s": if setting_up { eta } else { eta_s },
                        "setting_up": setting_up, "pct": if setting_up { pct } else { 0.0 }, "running": running })
}

#[tauri::command]
pub fn gf_live_setup(app: AppHandle) -> Result<(), String> {
    let mut g = SETUP.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false) { return Ok(()); }   // already running
    let script = gf_live_res().join("setup.sh");
    if !script.exists() { return Err("setup script missing".into()); }
    // 断点标记:配置开始就写,setup.sh 成功才删 —— 半路被关,下次开 app 由 gf_live_autoresume 接着跑
    let _ = std::fs::create_dir_all(gf_live_home());
    let _ = std::fs::write(gf_live_home().join("setup.wanted"), "1");
    let _ = std::fs::remove_file(gf_live_home().join("setup.paused"));      // 用户又点了配置 / 打开了她:不再算暂停
    let mut child = Command::new("/bin/bash").arg(&script)
        .env("GF_HOME", gf_live_home())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("setup: {e}"))?;
    let out = child.stdout.take().ok_or("setup: no stdout")?;
    *g = Some(child);
    drop(g);
    if let Ok(mut p) = SETUP_PCT.lock() { *p = (0.0, 0); }
    std::thread::spawn(move || {
        use std::io::BufRead;
        let t0 = std::time::Instant::now();
        let mut first: Option<(std::time::Instant, u64)> = None;
        let mut ok = false; let mut err: Option<String> = None;
        let mut phase = String::from("download");
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let mut it = line.split_whitespace();
            match it.next() {
                Some("P") => {
                    let done: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                    let total: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
                    let now = std::time::Instant::now();
                    let f = *first.get_or_insert((now, done));
                    let el = now.duration_since(f.0).as_secs_f64();
                    let rate = if el > 3.0 { (done.saturating_sub(f.1)) as f64 / el } else { 0.0 };
                    let left = total.saturating_sub(done);
                    let eta = if rate > 50_000.0 { (left as f64 / rate) as u64 + 30 } else { (left as f64 / gf_live_speed()) as u64 + 120 };
                    let pct = (done as f64 / total as f64 * 100.0).min(99.5);
                    if let Ok(mut p) = SETUP_PCT.lock() { *p = (pct, eta); }
                    if rate > 100_000.0 { let _ = std::fs::write(gf_live_home().join("speed"), format!("{rate:.0}")); }
                    let _ = app.emit("gf-live-setup", serde_json::json!({ "pct": pct, "eta_s": eta, "phase": phase }));
                }
                Some("S") => { phase = it.next().unwrap_or("download").to_string(); }
                Some("OK") => { ok = true; }
                Some("ERR") => { err = Some(it.collect::<Vec<_>>().join(" ")); }
                _ => {}
            }
        }
        if let Ok(mut g) = SETUP.lock() { if let Some(c) = g.as_mut() { let _ = c.wait(); } *g = None; }
        if let Ok(mut p) = SETUP_PCT.lock() { *p = (0.0, 0); }
        let _ = app.emit("gf-live-setup", serde_json::json!({ "done": ok, "error": if ok { None } else { Some(err.unwrap_or_else(|| "interrupted".into())) },
                                                            "pct": if ok { 100.0 } else { 0.0 }, "eta_s": 0, "secs": t0.elapsed().as_secs() }));
        // 失败了(断网、镜像抽风)而且用户没按暂停:过一会儿自己再试,最多 3 次(1 / 3 / 10 分钟);下载都是断点续传
        use std::sync::atomic::Ordering;
        if ok { SETUP_RETRIES.store(0, Ordering::SeqCst); }
        else if gf_live_home().join("setup.wanted").exists() {
            let n = SETUP_RETRIES.fetch_add(1, Ordering::SeqCst);
            if n < 3 {
                std::thread::sleep(std::time::Duration::from_secs([60, 180, 600][n as usize]));
                if gf_live_home().join("setup.wanted").exists() && !gf_live_ready() { let _ = gf_live_setup(app.clone()); }
            }
        }
    });
    Ok(())
}

/// 设置里选了 4K(10-22,用户:"默认 1080p,也可以选 4K"):她的 4K 母版只在这时下载(setup.sh GF_ONLY=mia + presets/want-4k,
/// 同一套断点续传 + sha256);下好以后 gf_presets 才给 meta "hi",壁纸才换成 4K。
#[tauri::command]
pub async fn gf_live_fetch_4k() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = gf_live_res().join("setup.sh");
        if !script.exists() { return Err("setup script missing".into()); }
        let presets = gf_live_home().join("presets");
        let _ = std::fs::create_dir_all(&presets);
        let _ = std::fs::write(presets.join("want-4k"), "1");
        let mut cmd = Command::new("/bin/bash");
        cmd.arg(&script).env("GF_HOME", gf_live_home()).env("GF_ONLY", "mia").env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        let (_, out, _) = gf_run(cmd, None, 1800)?;
        if out.lines().any(|l| l.trim() == "OK") { return Ok(()); }
        Err(out.lines().rev().find(|l| l.starts_with("ERR")).map(|l| l.trim_start_matches("ERR ").to_string())
            .unwrap_or_else(|| "4K download did not finish".into()))
    }).await.map_err(|e| e.to_string())?
}

/// 开机时调用:上次的一键配置没跑完(setup.wanted 还在、也没配好)就自动接着跑。
/// 等 20 秒再开始,别和启动时的其它活抢网络 / CPU;用户点了"暂停"的不算(暂停会删掉标记)。
pub fn gf_live_autoresume(app: AppHandle) {
    std::thread::sleep(std::time::Duration::from_secs(20));
    let h = gf_live_home();
    if h.join("setup.wanted").exists() && !gf_live_ready() {
        let _ = gf_live_setup(app);
        return;
    }
    // 10-21:她开着、但环境缺东西(新版本加了组件:声音、打断、语音识别)—— 壁纸现在只在配好 + 预热完时显示她,
    // 所以开机直接补齐,不然更新完她就"不见了";补的只是缺的那几样,已经下好的会校验后跳过。用户点过暂停(删了 setup.wanted
    // 而且 setup.paused 在)就不自己开始
    let on = std::fs::read_to_string(dirs::home_dir().unwrap_or_default().join(".terse").join("wallpaper.json")).ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|c| c["girlfriend"]["on"].as_bool() == Some(true) && c["girlfriend"]["live"].as_bool() != Some(false))
        .unwrap_or(false);
    if on && !gf_live_ready() && !h.join("setup.paused").exists() {
        let _ = gf_live_setup(app);
        return;
    }
    // 10-20 快速 DUIX(同一个模型拆成两半,嘴快约一倍)是可选的加装:老安装在后台悄悄补上,一天最多试一次;
    // 下不到也不影响 ready(setup.sh 里这一步失败不算失败,用整个模型)
    // 10-20 实时 DUIX(Mia 自己的小嘴型模型,CPU 跑)同样是可选加装,一起补
    let fast_missing = h.join("models/duix/.ok").exists()
        && (!h.join("models/duix/.fast1").exists() || !h.join("models/duix/mobile/.ok1").exists());
    let stamp = h.join("fast.tried");
    let tried_recently = std::fs::metadata(&stamp).and_then(|m| m.modified()).ok()
        .and_then(|t| t.elapsed().ok()).map(|e| e.as_secs() < 86_400).unwrap_or(false);
    if gf_live_ready() && fast_missing && !tried_recently {
        let _ = std::fs::write(&stamp, "1");
        let _ = gf_live_setup(app);
    }
}

#[tauri::command]
pub fn gf_live_cancel() -> Result<(), String> {
    let _ = std::fs::remove_file(gf_live_home().join("setup.wanted"));       // 用户主动暂停:开机别自己接着下
    let _ = std::fs::write(gf_live_home().join("setup.paused"), "1");
    if let Ok(mut g) = SETUP.lock() { if let Some(c) = g.as_mut() { let _ = c.kill(); } }
    // curl children of the script die with it; partial downloads are resumed next time
    let _ = Command::new("/usr/bin/pkill").args(["-f", "gf-live/setup.sh"]).status();
    Ok(())
}

fn gf_engine_ensure() -> Result<(), String> {
    let health = format!("http://127.0.0.1:{GF_ENGINE_PORT}/health");
    if gf_http_ok(&health) { return Ok(()); }
    if !gf_live_ready() { return Err("not set up".into()); }
    let res = gf_live_res();
    let h = gf_live_home();
    {
        let mut g = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        let alive = g.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
        if !alive {
            let args = vec!["-u".to_string(), res.join("engine.py").to_string_lossy().to_string(), "--port".into(), GF_ENGINE_PORT.to_string()];
            let envs = [("GF_HOME", h.to_string_lossy().to_string()),
                        ("GF_RUNNER_BIN", res.join("terse-gf-lipsync").to_string_lossy().to_string()),
                        ("GF_VIDEO_BIN", res.join("terse-gf-video").to_string_lossy().to_string()),
                        ("GF_DUIX_BIN", res.join("terse-gf-duix").to_string_lossy().to_string()),
                        ("GF_DUIX_MODELS", h.join("models/duix").to_string_lossy().to_string()),
                        ("GF_LLAMA_PORT", GF_LLAMA_PORT.to_string())];
            *g = Some(gf_spawn_tied(&h.join("venv/bin/python"), &args, &envs, Some(h.join("engine.log")))
                .map_err(|e| format!("engine: {e}"))?);
        }
    }
    for _ in 0..240 {
        if gf_http_ok(&health) { return Ok(()); }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("engine did not start".into())
}

/// 起实时模式需要的一切(brain + 引擎)。壁纸进实时模式前调一次;重复调用无害。
#[tauri::command]
pub async fn gf_live_start() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        gf_engine_ensure()?;
        // brain 可以晚一点好:它没好之前,聊天走用户选的 agent
        std::thread::spawn(|| { let _ = gf_llama_ensure(); let _ = Command::new("/usr/bin/curl")
            .args(["-s", "-m", "60", "-X", "POST", &format!("http://127.0.0.1:{GF_ENGINE_PORT}/warm")])
            .stdout(Stdio::null()).stderr(Stdio::null()).status(); });
        Ok(serde_json::json!({ "engine": format!("http://127.0.0.1:{GF_ENGINE_PORT}") }))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn gf_live_stop() -> Result<(), String> {
    for m in [&ENGINE, &LLAMA] {
        if let Ok(mut g) = m.lock() { if let Some(mut c) = g.take() { gf_stop_tied(&mut c); } }
    }
    Ok(())
}

/// 设置里切了「大脑省电」:只重启 Terse 自己起的那个 brain(线程数在启动时定),再让引擎把人设重新放进提示缓存。
/// 不是 Terse 起的 brain(开发时手动起的)不碰。
#[tauri::command]
pub async fn gf_brain_restart() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let owned = LLAMA.lock().map(|mut g| { if let Some(mut c) = g.take() { gf_stop_tied(&mut c); true } else { false } }).unwrap_or(false);
        if !owned { return Ok(()); }
        gf_llama_ensure()?;
        let _ = Command::new("/usr/bin/curl").args(["-s", "-m", "60", "-X", "POST", &format!("http://127.0.0.1:{GF_ENGINE_PORT}/warm")])
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

fn gf_engine_post(path: &str, body: serde_json::Value, secs: u64) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-s", "-m", &secs.to_string(), "-X", "POST", &format!("http://127.0.0.1:{GF_ENGINE_PORT}{path}"),
              "-H", "Content-Type: application/json", "--data-binary", "@-"]);
    let (_, out, _) = gf_run(cmd, Some(body.to_string()), secs + 5)?;
    serde_json::from_str(&out).map_err(|_| format!("engine: {}", out.chars().take(200).collect::<String>()))
}

/// 实时模式下的一轮对话:本地大脑(教程同款 llama.cpp + Qwen3)边想边说 —— 第一句想好就开口。
#[tauri::command]
pub async fn gf_live_chat(text: String, history: Option<Vec<serde_json::Value>>, name: Option<String>,
                          persona: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gf_engine_ensure()?;
        gf_llama_ensure()?;
        let mut body = serde_json::json!({ "text": text, "history": history.unwrap_or_default(),
                                            "name": name.unwrap_or_else(|| "Mia".into()) });
        // 设置页(Pro):性格 / 语气 / 自定义人设({"personality", "tone", "custom"},引擎拼进人设)+ 声音设置
        // ("voice",每轮都带上:引擎重启过也不会丢)+ 她的大脑("brain": claude / codex / dsh = 那个 agent 的命令行写她的话,
        // 声音和 DUIX 照旧 —— 10-22)
        if let Some(serde_json::Value::Object(p)) = persona {
            for k in ["personality", "tone", "custom", "voice", "brain", "brain_model"] { if let Some(v) = p.get(k) { body[k] = v.clone(); } }
        }
        let v = gf_engine_post("/chat", body, 180)?;
        if let Some(e) = v["error"].as_str() { return Err(e.to_string()); }
        Ok(v)
    }).await.map_err(|e| e.to_string())?
}

/// 设置页改了声音 / 语速 / 高清回复:推给引擎(只转发认识的键),下一句就生效。
#[tauri::command]
pub async fn gf_live_voice(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gf_engine_ensure()?;
        let mut body = serde_json::Map::new();
        if let serde_json::Value::Object(m) = settings {
            for k in ["engine", "clone_voice", "speed", "temperature", "hd", "omni_mode", "sweet"] {
                if let Some(v) = m.get(k) { body.insert(k.to_string(), v.clone()); }
            }
        }
        gf_engine_post("/voice", serde_json::Value::Object(body), 30)
    }).await.map_err(|e| e.to_string())?
}

/// 实时模式下让她说一句给定的话(别的 agent 的回复、"说一句"按钮):引擎合成 + 口型。
#[tauri::command]
pub async fn gf_live_say(text: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || { gf_engine_ensure()?; gf_engine_post("/say", serde_json::json!({ "text": text }), 60) })
        .await.map_err(|e| e.to_string())?
}

/// 打断她(用户开口说话时)。
#[tauri::command]
pub async fn gf_live_interrupt() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| { let _ = gf_engine_post("/stop", serde_json::json!({}), 5); Ok(()) })
        .await.map_err(|e| e.to_string())?
}

/// 对她说一句话。壁纸同时收到 `girlfriend-chat`:thinking(她做思考的动作)→ reply(带动作标签)/ error。
/// 返回 { ok, text, action, ms } —— 前端拿 text 去 gf_speak,壁纸按 action 播片段。
#[tauri::command]
pub async fn gf_chat(agent: String, text: String, history: Option<Vec<serde_json::Value>>,
                     name: Option<String>, model: Option<String>, app: AppHandle) -> Result<serde_json::Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() { return Err("empty".into()); }
    let _ = app.emit("girlfriend-chat", serde_json::json!({ "phase": "thinking", "agent": agent, "text": text }));
    let t0 = std::time::Instant::now();
    let (a2, t2) = (agent.clone(), text.clone());
    let hist = history.unwrap_or_default();
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Mia".into());
    let model = model.filter(|m| !m.trim().is_empty());
    let res = tauri::async_runtime::spawn_blocking(move || gf_ask(&a2, &t2, &hist, &name, model.as_deref()))
        .await.map_err(|e| e.to_string())?;
    let ms = t0.elapsed().as_millis() as u64;
    match res {
        Ok(raw) => {
            let (action, reply) = gf_clean_reply(&raw);
            let _ = app.emit("girlfriend-chat", serde_json::json!({ "phase": "reply", "agent": agent, "action": action, "text": reply, "ms": ms }));
            Ok(serde_json::json!({ "ok": true, "text": reply, "action": action, "ms": ms }))
        }
        Err(e) => {
            let _ = app.emit("girlfriend-chat", serde_json::json!({ "phase": "error", "agent": agent, "error": e }));
            Err(e)
        }
    }
}

/// 哪些 agent 在这台机器上能用(连接面板用来把用不了的置灰)。
#[tauri::command]
pub async fn gf_agents() -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(|| {
        // 四个一起探(各自可能要问登录 shell),面板不用排队等
        let hs: Vec<_> = ["claude", "codex", "dsh", "ollama"].into_iter()
            .map(|a| (a, std::thread::spawn(move || gf_agent_bin(a)))).collect();
        let mut v: Vec<serde_json::Value> = hs.into_iter().map(|(a, h)| {
            let p = h.join().ok().flatten();
            serde_json::json!({ "id": a, "installed": p.is_some(), "path": p.map(|p| p.to_string_lossy().to_string()) })
        }).collect();
        let (bin, model) = gf_llama_paths();
        v.insert(0, serde_json::json!({ "id": "local", "installed": bin.exists() && model.exists(),
                                        "path": model.to_string_lossy() }));
        v
    }).await.unwrap_or_default()
}

/* ── 按住说话:terse-listen(Apple Speech)把你说的话变成文字,前端拿去 gf_chat ──
 *
 * 麦克风 / 语音识别权限由 **Terse 主进程**请求(hands.rs 摄像头同款教训:子进程代问,系统一次框都不弹),
 * terse-listen 作为 Terse 的子进程沿用授权。子进程常驻,按一次 start / 松手 stop;识别结果通过
 * `girlfriend-heard` 事件推给前端:{partial} 边说边出字,{final} 松手后的整句,{status} 状态。 */

#[cfg(target_os = "macos")]
mod gf_av {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use std::time::Duration;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}
    #[link(name = "Speech", kind = "framework")]
    extern "C" {}

    /// AVAuthorizationStatus(麦克风):0 notDetermined / 1 restricted / 2 denied / 3 authorized
    pub fn mic_status() -> isize {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else { return -1 };
        let media = NSString::from_str("soun"); // AVMediaTypeAudio
        unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] }
    }
    pub fn mic_request(timeout: Duration) -> bool {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else { return false };
        let media = NSString::from_str("soun");
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let block = RcBlock::new(move |granted: Bool| { let _ = tx.send(granted.as_bool()); });
        unsafe { let _: () = msg_send![cls, requestAccessForMediaType: &*media, completionHandler: &*block]; }
        rx.recv_timeout(timeout).unwrap_or(false)
    }
    /// SFSpeechRecognizerAuthorizationStatus:0 notDetermined / 1 denied / 2 restricted / 3 authorized
    pub fn speech_status() -> isize {
        let Some(cls) = AnyClass::get(c"SFSpeechRecognizer") else { return -1 };
        unsafe { msg_send![cls, authorizationStatus] }
    }
    pub fn speech_request(timeout: Duration) -> bool {
        let Some(cls) = AnyClass::get(c"SFSpeechRecognizer") else { return false };
        let (tx, rx) = std::sync::mpsc::channel::<isize>();
        let block = RcBlock::new(move |st: isize| { let _ = tx.send(st); });
        unsafe { let _: () = msg_send![cls, requestAuthorization: &*block]; }
        rx.recv_timeout(timeout).map(|st| st == 3).unwrap_or(false)
    }
}

/// 两个权限都到手才返回 Ok;没问过的现在问(系统框以 Terse 的名义弹)。
fn gf_listen_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::time::Duration;
        let sp = gf_av::speech_status();
        if sp == 1 || sp == 2 { return Err("denied:speech".into()); }
        if sp == 0 && !gf_av::speech_request(Duration::from_secs(120)) { return Err("denied:speech".into()); }
        let mic = gf_av::mic_status();
        if mic == 1 || mic == 2 { return Err("denied:mic".into()); }
        if mic == 0 && !gf_av::mic_request(Duration::from_secs(120)) { return Err("denied:mic".into()); }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { Err("voice input is macOS-only for now".into()) }
}

fn gf_listen_bin() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            let p = contents.join("Resources/terse-listen");
            if p.exists() { return p; }
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/helpers/terse-listen"))
}

static LISTEN: Mutex<Option<(Child, std::process::ChildStdin)>> = Mutex::new(None);
/// 10-22:helper 在 duplex 里(她的声音 + 麦克风同一个回声消除引擎)。壁纸据此把她的声音交给 helper 播
static DUPLEX: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn gf_listen_send(line: &str, app: &AppHandle) -> Result<(), String> {
    let mut g = LISTEN.lock().unwrap_or_else(|e| e.into_inner());
    let alive = g.as_mut().map(|(c, _)| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
    if !alive {
        let bin = gf_listen_bin();
        let mut child = Command::new(&bin).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("terse-listen: {e}"))?;
        let stdin = child.stdin.take().ok_or("terse-listen: no stdin")?;
        let stdout = child.stdout.take().ok_or("terse-listen: no stdout")?;
        let app2 = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            use std::sync::atomic::Ordering;
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                // duplex 的麦克风(每 40 ms 一条)和她的播放时钟走自己的事件,别刷 girlfriend-heard(点头那些在听它)
                if v.get("pcm").is_some() { let _ = app2.emit("gf-mic", v); continue; }
                if v.get("pos").is_some() { let _ = app2.emit("gf-voice", v); continue; }
                match v.get("status").and_then(|s| s.as_str()) {
                    Some("duplex") => { DUPLEX.store(true, Ordering::SeqCst); let _ = app2.emit("gf-duplex", serde_json::json!({ "on": true })); }
                    Some("duplex_off") => { DUPLEX.store(false, Ordering::SeqCst); let _ = app2.emit("gf-duplex", serde_json::json!({ "on": false })); }
                    _ => {}
                }
                let _ = app2.emit("girlfriend-heard", v);
            }
            DUPLEX.store(false, Ordering::SeqCst); let _ = app2.emit("gf-duplex", serde_json::json!({ "on": false }));
        });
        *g = Some((child, stdin));
    }
    let (_, stdin) = g.as_mut().unwrap();
    stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("terse-listen: {e}"))
}

/// `cmd` = "start"(按下麦克风)/ "stop"(松手)。locale 例 "zh-CN" / "en-US",缺省跟系统。
#[tauri::command]
pub async fn gf_listen(cmd: String, locale: Option<String>, auto_ms: Option<u32>, app: AppHandle) -> Result<(), String> {
    match cmd.as_str() {
        "start" => {
            tauri::async_runtime::spawn_blocking(gf_listen_permission).await.map_err(|e| e.to_string())??;
            let loc = locale.filter(|l| l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && !l.is_empty());
            // auto_ms:免按住模式(说完静音这么久自动收尾)
            let mut line = String::from("start");
            if let Some(l) = loc { line.push(' '); line.push_str(&l); }
            if let Some(ms) = auto_ms.filter(|m| *m >= 300) { line.push_str(&format!(" auto={ms}")); }
            gf_listen_send(&line, &app)
        }
        "stop" => gf_listen_send("stop", &app),
        // 10-22 duplex(beiyege repo 的语音输入搬进 app):只要麦克风权限,不要语音识别权限(识别是引擎的 Paraformer)
        "duplex" => {
            #[cfg(target_os = "macos")]
            {
                use std::time::Duration;
                let mic = gf_av::mic_status();
                if mic == 1 || mic == 2 { return Err("denied:mic".into()); }
                if mic == 0 && !tauri::async_runtime::spawn_blocking(|| gf_av::mic_request(Duration::from_secs(120))).await.unwrap_or(false) {
                    return Err("denied:mic".into());
                }
            }
            gf_listen_send("duplex", &app)
        }
        "duplex_stop" => gf_listen_send("duplex_stop", &app),
        other => Err(format!("unknown: {other}")),
    }
}

/// duplex 开着吗(壁纸后开 / 重载时问一次;之后跟 gf-duplex 事件)
#[tauri::command]
pub fn gf_duplex_on() -> bool { DUPLEX.load(std::sync::atomic::Ordering::SeqCst) }

/// 壁纸 → helper:她这句话的声音在 helper 里播(回声消除的参考),页面上的视频静音、跟 helper 的时钟走。
/// 只放行这几条,url 只能是本机引擎的 /dha/<turn>
#[tauri::command]
pub fn gf_voice(line: String, app: AppHandle) -> Result<(), String> {
    if !DUPLEX.load(std::sync::atomic::Ordering::SeqCst) { return Err("duplex off".into()); }
    let mut it = line.split_whitespace();
    let ok = match (it.next(), it.next(), it.next(), it.next()) {
        (Some("play"), Some(t), Some(u), None) => t.parse::<u32>().is_ok()
            && u.strip_prefix(&format!("http://127.0.0.1:{GF_ENGINE_PORT}/dha/")).map(|r| r.parse::<u32>().is_ok()).unwrap_or(false),
        (Some("go"), Some(t), None, None) => t.parse::<u32>().is_ok(),
        (Some("pause" | "resume" | "halt"), None, None, None) => true,
        _ => false,
    };
    if !ok { return Err(format!("not allowed: {line}")); }
    gf_listen_send(&line, &app)
}

#[cfg(test)]
mod chat_tests {
    use super::gf_clean_reply;
    /// 本机探测(依赖这台机器装了什么,默认不跑):cargo test --lib probe_agents -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_agents() {
        for a in ["claude", "codex", "dsh", "ollama"] {
            let t = std::time::Instant::now();
            println!("{a}: {:?} ({} ms)", super::gf_agent_bin(a), t.elapsed().as_millis());
        }
    }
    #[test]
    fn strips_action_tag_and_stage_directions() {
        assert_eq!(gf_clean_reply("[wave] Hi! *smiles* I'm here."), ("wave".into(), "Hi! I'm here.".into()));
        assert_eq!(gf_clean_reply("  [Nod]\n嗯,我懂你。"), ("nod".into(), "嗯,我懂你。".into()));
        assert_eq!(gf_clean_reply("[dance] ok"), ("none".into(), "ok".into()));
        assert_eq!(gf_clean_reply("**Sure** — `code`"), ("none".into(), "Sure — code".into()));
        // Hunyuan: <answer> wrapper, <think> block, （stage directions）
        assert_eq!(gf_clean_reply("<answer>\n嗨呀（歪着头，笑）你回来啦\n</answer>"), ("none".into(), "嗨呀你回来啦".into()));
        assert_eq!(gf_clean_reply("<think>想一下</think><answer>[wave] 你好</answer>"), ("wave".into(), "你好".into()));
    }
}

#[cfg(test)]
mod preset_tests {
    /// 10-22:她的片子由一键配置下载 —— 下载目录(<GF_HOME>/presets)优先于 app 里 / 仓库里的;4K 母版只在下好时给 "hi"。
    /// 需要一个装过她片包的 GF_HOME(setup.sh GF_ONLY=mia),默认不跑:
    /// GF_TEST_HOME=<dir> cargo test --lib presets_prefer_download -- --ignored --nocapture
    #[test]
    #[ignore]
    fn presets_prefer_download() {
        let home = std::env::var("GF_TEST_HOME").expect("GF_TEST_HOME");
        std::env::set_var("GF_HOME", &home);
        let mia = std::path::Path::new(&home).join("presets/char_mia");
        let p = super::gf_presets();
        let c = p.iter().find(|x| x["key"] == "char_mia").expect("char_mia listed");
        let clips = c["clips"].as_array().unwrap();
        assert!(!clips.is_empty() && c["needsSetup"] == false);
        assert!(clips.iter().all(|x| x["path"].as_str().unwrap().starts_with(&home)), "clips come from the download");
        assert!(!clips.iter().any(|x| x["path"].as_str().unwrap().ends_with("idle_live.mp4")), "no old live-mode clips");
        let calm = clips.iter().find(|x| x["path"].as_str().unwrap().ends_with("/idle_calm.mp4")).unwrap();
        assert_eq!(calm["meta"]["hi"].as_str().is_some(), mia.join("4k/idle_calm.mp4").exists(), "hi only when the 4K twin is there");
        println!("{} clips from {home}, idle_calm hi = {:?}, poster = {}", clips.len(), calm["meta"]["hi"], c["poster"]);
    }
}
