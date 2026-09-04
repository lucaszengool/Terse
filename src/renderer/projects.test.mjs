/* 项目粒子。
   这个功能的成立条件只有一条:**传的是参数,画是本地生成的**。一旦哪天有人为了省事
   改成"服务端存图片"或者"预览时再拉一次",账单就会随着用的人数线性长起来,而这件事
   在代码里看不出来 —— 所以把它钉成断言。

   第二条是编辑不能被扫描冲掉:被 rescan 覆盖一次自己写的标题,人就再也不会用它了。 */
import { readFileSync } from 'node:fs';

const R = new URL('./', import.meta.url).pathname;
const layer = readFileSync(R + 'wallpaper-project.js', 'utf8');
const eng = readFileSync(R + 'mineradio-wallpaper.js', 'utf8');
const page = readFileSync(R + 'projects.js', 'utf8');
const wall = readFileSync(R + 'wallpaper.html', 'utf8');
const api = readFileSync(new URL('../../api/projects.js', import.meta.url).pathname, 'utf8');
const rs = readFileSync(new URL('../../src-tauri/src/projects.rs', import.meta.url).pathname, 'utf8');

let pass = 0; const fails = [];
const ok = (l, c) => (c ? pass++ : fails.push(l));

// ── 1. 图**必须**是粒子,不是贴图 ─────────────────────────────────────────
{
  ok('每颗粒子记住自己那个像素的颜色', /attribute vec3 aColor/.test(layer));
  ok('落点是从图上采出来的', /function sampleImage/.test(layer) && /getImageData/.test(layer));
  ok('太暗的像素不占粒子', /LUMA_FLOOR/.test(layer));
  // 加性混合会把 24000 颗点烧成一个白方块(实测)。这一层是一张图,不是光。
  ok('图这一层不用加性混合', /blending: THREE\.NormalBlending/.test(layer)
     && !/blending: THREE\.AdditiveBlending/.test(layer));
  ok('聚散和字形层同一套手法', /uForm/.test(layer) && /1\.0 - uForm/.test(layer));
  ok('它是一段有头有尾的演出,不是开关', /play\(life = 20000/.test(layer) && /outMs/.test(layer));
}

// ── 2. 引擎:缩影和标题在同一个 Group 里,3D 一转一起转 ──────────────────
{
  ok('引擎能演一个项目', /showProject\(cap, ms = 20000\)/.test(eng));
  ok('缩影挂在字形层那个 Group 下', /grp\.add\(this\._projLayer\.points\)/.test(eng));
  ok('有缩影就得画那一层', /projLive/.test(eng));
  ok('销毁时一起收掉', /this\._projLayer\.dispose\(\)/.test(eng));
  ok('壁纸页收到事件就演', /listen\('wallpaper-project'/.test(wall));
}

// ── 3. 成本:传参数,不传画面 ─────────────────────────────────────────────
{
  ok('服务端有硬上限', /MAX_CAPSULE_BYTES = 64 \* 1024/.test(api));
  ok('超了就拒绝', /413/.test(api) && /Capsule too large/.test(api));
  // 远程图会让"预览"变成一次对第三方的请求,而且那张图随时会变。
  ok('只收内联的图', /\^data:image\\\/\(jpeg\|png\|webp\);base64/.test(api));
  ok('一个人挂的数量有上限', /MAX_PER_IDENTITY/.test(api));
  ok('主键带身份,别人覆盖不了你的项目', /function serverId\(identity, srcId\)/.test(api));
  // 列表直接带整颗胶囊 —— 点预览时不再请求服务器,粒子在本机生成。
  ok('列表里就带着胶囊', /capsule = JSON\.parse\(r\.capsule\)/.test(api));
  ok('点预览不再请求服务器', /preview\(p\.capsule \|\| p\)/.test(page));
  // 224 而不是 96:96 的采样格子比像素还粗,粒子聚出来是一团认不出的色块(实测)。
  ok('换封面在本机缩到和扫描同一个尺寸', /const S = 224;/.test(page) && /toDataURL\('image\/jpeg'/.test(page));
  ok('上传那一份不带本机路径', /pub fn for_upload/.test(rs) && !/"path": self\.path/.test(rs));
}

// ── 4. 扫描不许冲掉人的编辑 ───────────────────────────────────────────────
{
  ok('改过的字段记在 edited 里', /pub edited: Vec<String>/.test(rs));
  ok('重扫时逐个还原', /for f in &k\.edited/.test(rs));
  ok('封面走 sips,不引图像库', /Command::new\("sips"\)/.test(rs));
  ok('只读清单和 README,不读源码', /fn manifest_name_desc/.test(rs) && /fn read_readme/.test(rs));
  ok('入口是"此刻正在干活的文件夹"', /pub fn agent_dirs/.test(rs));
}

// ── 5. 用户报过的三件事 ───────────────────────────────────────────────────
{
  // 「都是虚的,看不清粒子」:采样是散列的 → 结构没了;点比间距大 → 糊成一片。
  ok('按扫描顺序等距取样,不是散列', /lit\[Math\.floor\(p \* lit\.length \/ n\)\]/.test(layer));
  ok('采样格子比封面细', /SAMPLE_W = 224/.test(layer));
  ok('点小于间距', /1\.15 \+ uForm \* 0\.75/.test(layer));
  // 「只出现了图片,没有标题」:_queueGlyph 有节流有配额,大字那条路才是必到的。
  ok('标题走必到的大字通道', /this\._logPending = \{ label: String\(cap\.title\)/.test(eng));
  ok('先清空队列,别排在旧内容后面', /this\._glyphQueue\.length = 0;/.test(eng));
  // 「像 GitHub 那样识别语言百分比」:按字节算(Linguist 的算法),而不是按文件数。
  ok('语言占比按字节算', /m\.len\(\)\.min\(2_000_000\)/.test(rs));
  ok('还带上提交时间/许可证这些事实', /fn project_facts/.test(rs));
  ok('界面上画成语言条', /function langBar/.test(page) && /LANG_COLOR/.test(page));
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
