#!/usr/bin/env node
/**
 * backfill-plaza.js — 给**已经在墙上**的项目补上"它在干什么"那一层。
 *
 *   node api/backfill-plaza.js --dry                         看看会改什么,不写
 *   node api/backfill-plaza.js --remote https://www.terseai.org --token <ADMIN>
 *
 * 为什么需要这个脚本:探针后来学会了读入口点、动词和作者自己录的演示,可这些字段
 * 是**发布那一刻**写进胶囊的 —— 已经发出去的一百颗里一个都没有。实测线上:
 *
 *     flow 0 / 100    verbs 0 / 100    frames 0 / 100
 *
 * 也就是说升级完全看不见。不是渲染坏了,是那些胶囊里根本没有这些字段 —— 和当初
 * "点项目什么都不显示"的第一个原因是同一个:`published:true` 只记得"发过一次"。
 *
 * ⚠ 它走的是 /backfill 那条管理口,不是公开的发布口。公开口上的三道闸
 * (每地址十条/小时、十分钟六十条的保险丝、upsert 刷新 published_at)全都是对的,
 * 但它们防的是陌生人,而这是运维动作 —— 尤其最后一条:重发会把补过的项目整体顶到
 * 最前面,把这面特意排过顺序的墙搅乱。/backfill 只改胶囊,不动时间。
 *
 * ⚠ 演示是在**这台机器上**采帧的,不是在服务器上。sharp 能把 GIF 一页一页解出来
 * (实测 gum 那段 760 页,取 12 帧 ≈ 6KB),而服务器不该为了一次补数据长出一个
 * 图像解码依赖。视频要 ffmpeg,没有就跳过 —— 跳过一段视频,不该让整次补数据失败。
 */
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe } = require('./repo-probe');
const { buildCity } = require('./github-city');

const execFileP = promisify(execFile);
const UA = 'terse-plaza';
/* ⚠ WebP,不是 JPEG,而且尺寸翻倍 —— 这两件事一起做**不花钱**。
   同一张截图实测:JPEG 224px = 4.4KB,WebP 448px = 4.4KB;WebP 560px = 6.3KB,
   比现在存着的那张 224px JPEG(7.1KB)还小。也就是说清晰度翻两倍半是白拿的,
   代价是负数。sanitize 本来就收 data:image/webp。 */
/* 448,不是 560。存得比粒子画得出来的更细是白花钱:图那一层拿到约 90000 颗粒子
   (110000 的 82%),16:9 摊开就是 400×225 —— 再高的分辨率一颗粒子也表现不出来,
   只是把胶囊撑大、把别的截图挤掉。448 给采样留一点余量,到此为止。 */
const STILL_SIZE = 448, STILL_Q = 74;
const SIZE = 256;                  // 动图每一帧;12 帧 WebP ≈ 53KB(原来 128px JPEG 是 45KB)
const FRAME_Q = 72;
const COUNT = 12;
const MAX_CAPSULE_BYTES = 160 * 1024;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.indexOf(name) > 0;

const BASE = (arg('--remote', 'http://localhost:3000') || '').replace(/\/$/, '');
const ADMIN = arg('--token', process.env.PLAZA_ADMIN_TOKEN || '');
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const DRY = has('--dry');
const LIMIT = +arg('--limit', '0') || 0;
/* 重新分配画面。默认**不覆盖**已有的 cover/frames/shots —— 那可能是作者自己传的。
   但上一轮补数据把 12 帧铺满了预算,于是同一颗胶囊再也塞不下一张截图;要按
   "首图 → 动图 → 其余"重新摊一遍,就得先把这三格腾出来。 */
const REFRESH = has('--refresh');

const ghHeaders = Object.assign({ 'User-Agent': UA, Accept: 'application/vnd.github+json' },
  GH_TOKEN ? { Authorization: 'Bearer ' + GH_TOKEN } : {});

let apiCalls = 0;
async function ghApi(p) {
  apiCalls++;
  const r = await fetch('https://api.github.com' + p, { headers: ghHeaders });
  if (r.status === 403 || r.status === 429) throw new Error('rate-limited');
  if (!r.ok) return null;
  return r.json();
}

/** github.com/owner/repo 从那条"点得开的链接"里拆出来。 */
function parseRepo(link) {
  const m = String(link || '').match(/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

/* 没有 token 时,一棵**从城市里倒推出来**的树。楼就是顶层目录,kids 是它下面那层。
   ⚠ 它只有目录,没有文件 —— 所以 src/main.rs、main.go、__main__.py 这类判据在这条
   路上是失效的,cmd/<名字>/ 和 server/ 这种还在。够用,但不如真的树,报告里会说
   清楚哪一个项目走的是哪条路,免得把"探针判错了"和"没给它看文件树"混为一谈。 */
function treeFromDirs(dirs) {
  const out = [];
  for (const d of (dirs || [])) {
    if (!d || !d.name) continue;
    out.push({ path: d.name });
    for (const k of (d.kids || [])) if (k && k[0]) out.push({ path: d.name + '/' + k[0] });
  }
  return out;
}

/* ⚠ **一个仓库一次调用**,靠猜分支,而不是先问 /repos 要 default_branch。
   第一版是问的,两次调用 × 47 个仓库 = 94 次,而未认证的额度是一小时 60 次 ——
   于是它干脆在没有 token 时**完全不取树**,退回到用城市倒推的那棵。结果实测出来
   就摆在那儿:47 个里 32 个被判成 "lib",包括 oryx、dagu、gonzo 这些明摆着的命令行
   工具。城市里只有目录,没有文件,而 src/main.rs、main.go、__main__.py、cmd/x/
   全是**文件**判据 —— 少了它们,排名就一路掉到最后那一档,而 "lib" 恰好是
   "什么都没匹配上"的默认值。一个默认值冒充答案,比没有答案更糟。

   main 猜不中再试 master,绝大多数仓库两次之内命中,平均下来一个略多于一次。
   顺带把**分支**也定下来了:README 是按分支从 raw 取的,分支猜错就一个动词都读
   不到,而那和"这个仓库没写小标题"看起来一模一样。 */
async function treeOf(owner, repo) {
  for (const branch of ['main', 'master']) {
    const t = await ghApi(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
    if (t && Array.isArray(t.tree) && t.tree.length) return { branch, tree: t.tree };
  }
  return null;
}

/* ── 演示 → 帧 ─────────────────────────────────────────────────────────── */

const toDataUrl = (buf) => 'data:image/webp;base64,' + buf.toString('base64');
/* ⚠ ffmpeg 那一路吐的是 JPEG。用上面那个函数会造出一个**声明成 webp 却装着 JPEG**
   的 data URL —— 浏览器解不出来,而且不报错,只是那几帧是空的。格式和标签必须一起走。 */
const toJpegUrl = (buf) => 'data:image/jpeg;base64,' + buf.toString('base64');

/** GIF / 动图。sharp 按页解,**每一页都是合成好的整幅**(实测 800×450、alpha 全 255),
 *  不是那种只有变化矩形的差分帧 —— 差分帧直接存下来会是一堆碎片。 */
async function framesFromImage(buf, size, quality, count) {
  const md = await sharp(buf).metadata();
  const pages = md.pages || 1;
  if (pages < 2) return [];                        // 静图不是演示
  const out = [];
  for (let i = 0; i < count; i++) {
    const page = Math.min(pages - 1, Math.floor((pages * (i + 0.5)) / count));
    try {
      const f = await sharp(buf, { page })
        .resize(size, size, { fit: 'inside' })
        .webp({ quality }).toBuffer();
      out.push(toDataUrl(f));
    } catch (e) { /* 单独一页解不出来就少一帧,不必让整段演示失败 */ }
  }
  return out;
}

/** 视频。ffmpeg 均匀抽帧;这台机器上没有 ffmpeg 就跳过这一个项目的演示。 */
async function framesFromVideo(buf, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-demo-'));
  const src = path.join(dir, 'in' + ext);
  try {
    fs.writeFileSync(src, buf);
    await execFileP('ffmpeg', ['-v', 'error', '-i', src,
      '-vf', `fps=4,scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease`,
      '-frames:v', String(COUNT), '-q:v', '6', path.join(dir, 'f%02d.jpg')]);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
      .slice(0, COUNT).map((f) => toJpegUrl(fs.readFileSync(path.join(dir, f))));
  } catch (e) {
    return [];
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/** 一张静图 → 一个 data URL。SVG 也吃(sharp 会光栅化),失败就当没有这张。 */
async function stillOf(url, size, quality) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) return '';
    const out = await sharp(buf, { pages: 1 })
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality }).toBuffer();
    return toDataUrl(out);
  } catch (e) { return ''; }
}

/* ⚠ 帧要**装进剩下的地方**,不是装进一个固定的尺寸。
   这些胶囊已经有封面和截图了,实测线上很多颗本身就有 130KB,而闸门在 160KB ——
   按 128px/q72 采十二帧几乎必然撑爆,于是第一版把每一段演示都丢掉了(日志里一排
   "demo dropped: too large")。丢掉的正好是这次补数据最想要的那一样东西。

   所以先算还剩多少地方,再挑一档采样。由细到粗试,第一个装得下的就用它;
   最粗的一档还装不下,才说明这颗胶囊真的没地方了。 */
const LADDER = [
  { size: 256, quality: 72, count: 12 },
  { size: 208, quality: 66, count: 12 },
  { size: 160, quality: 60, count: 10 },
  { size: 128, quality: 54, count: 8 },
];

async function sampleDemo(url, budget) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const type = String(r.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 40 * 1024 * 1024) return [];
  if (type.startsWith('video/') || /\.(mp4|webm|mov)(\?|$)/i.test(url)) {
    const fr = await framesFromVideo(buf, (url.match(/\.(mp4|webm|mov)(\?|$)/i) || [, 'mp4'])[1].replace(/^/, '.'));
    return weigh(fr) <= budget ? fr : [];
  }
  for (const step of LADDER) {
    const fr = await framesFromImage(buf, step.size, step.quality, step.count);
    if (fr.length < 2) return [];
    if (weigh(fr) <= budget) return fr;
  }
  return [];
}

/** 这串帧在 JSON 里占多少字节 —— 引号和逗号也算,闸门量的是整颗胶囊的 JSON。 */
const weigh = (frames) => frames.reduce((a, f) => a + f.length + 3, 2);

/* ── 主流程 ────────────────────────────────────────────────────────────── */

async function main() {
  const res = await fetch(BASE + '/api/cloud/projects/public?limit=100');
  if (!res.ok) throw new Error('cannot read the plaza: HTTP ' + res.status);
  const list = ((await res.json()).projects || []);
  console.log(`plaza: ${list.length} posts on ${BASE}`);
  if (!GH_TOKEN) {
    console.log('⚠ no GITHUB_TOKEN — 60 API calls an hour, roughly one per repo.');
  }

  const targets = list.filter((p) => p.capsule && parseRepo(p.capsule.link));
  console.log(`${targets.length} of them link to a GitHub repository\n`);

  const updates = [];
  let n = 0, rateLimited = false;
  for (const p of targets) {
    if (LIMIT && n >= LIMIT) break;
    n++;
    const { owner, repo } = parseRepo(p.capsule.link);
    const label = `${owner}/${repo}`.padEnd(30);
    try {
      /* ⚠ 配额用光了**不要停**。文件树走 API(未认证一小时 60 次),而画面和 README
         走 raw —— raw 不占配额。第一版撞到 429 就 break,于是 47 个里只补了 7 个,
         而剩下 40 个真正缺的恰恰是画面,不是文件树。
         所以:限流之后照常往下走,只是没有树。 */
      let got = null;
      if (!rateLimited) {
        try { got = await treeOf(owner, repo); }
        catch (e) {
          if (e.message !== 'rate-limited') throw e;
          rateLimited = true;
          console.log('⚠ GitHub rate limit reached — continuing without file trees (media still works)');
        }
      }
      const tree = got ? got.tree : treeFromDirs(p.capsule.dirs);
      const branch = got ? got.branch : 'main';
      const pr = await probe(owner, repo, branch, tree);

      const cap = Object.assign({}, p.capsule);
      let did = [];

      /* ── 代码城市 ────────────────────────────────────────────────────
         广场上四十八个 GitHub 项目一座楼都没有 —— github-capsule 从来不写 dirs,
         因为目录级的字节数看起来非 clone 不可。其实不用:文件树**每个 blob 都带
         size**,一次调用就够(见 api/github-city.js)。年龄和改动量还要每个目录
         一次 commits 调用,合起来一个仓库约十三次 —— 未认证的一小时六十次撑不住
         四个仓库,所以这一段**只在有 token 的时候跑**,没有就跳过,而不是盖一座
         没有窗、没有信标的假城。 */
      if (got && GH_TOKEN && !(cap.dirs || []).length) {
        try {
          const city = await buildCity(ghApi, owner, repo, branch, got.tree);
          if (city.dirs.length) {
            cap.dirs = city.dirs;
            if (city.langs.length) cap.langs = city.langs;
            did.push(`city×${city.dirs.length}`);
          }
        } catch (e) {
          if (e.message === 'rate-limited') rateLimited = true;
        }
      }
      /* ⚠ 没有真的文件树时**不要覆盖已经对的 flow**。src/main.rs、main.go、
         __main__.py、cmd/x/ 全是文件判据,树里没有文件,排名就一路掉到最后一档,
         而 "lib" 正是"什么都没匹配上"的默认值 —— 上一轮 47 个里 32 个被这样判成
         了库。一个默认值冒充答案,比保留上一轮那个正确答案糟得多。 */
      const trusted = !!got;
      const better = pr.flow && (pr.flow.entry || (pr.flow.cmds || []).length)
        && (trusted || !p.capsule.flow || pr.flow.kind !== 'lib');
      if (better) { cap.flow = pr.flow; did.push('flow'); }
      if ((pr.verbs || []).length) { cap.verbs = pr.verbs; did.push(`verbs×${pr.verbs.length}`); }

      /* ── 画面:首图,然后按重要程度把能装下的都装进去 ──────────────────
         胶囊里有三个放画面的地方,各有各的读法,不能混:
           cover  一张 —— 卡片上那张脸,用**首图**(作者选的门面);
           frames 一串 —— 一个动作,按帧率连着放,用排最前的那段**动图**;
           shots  几张 —— 各自独立的截图,轮播。
         预算是一整颗胶囊 160KB,所以顺序就是优先级:先 cover,再 frames,
         剩下多少就放多少张 shots。⚠ 装不下的那一张**不装**,而不是让整颗超限。 */
      const media = pr.media || [];
      /* ⚠ --refresh **不能直接清空**。sanitize 会拒收一颗 kind:'image' 却既没有
         cover 又没有 frames 的胶囊(那确实不是一张图),于是"先清空、再去抓、
         抓不到"就变成整条更新被拒:实测 40 条里 11 条 "bad capsule"。
         服务端没有丢东西(拒收 = 保持原样),但那一轮对它们等于没跑。
         所以腾出来的东西先留着,抓到了才换,没抓到就放回去。 */
      const kept = { cover: cap.cover, frames: cap.frames || [], shots: cap.shots || [] };
      if (REFRESH) { cap.cover = ''; cap.frames = []; cap.shots = []; }
      const room = () => MAX_CAPSULE_BYTES - JSON.stringify(cap).length - 2048;

      /* ⚠ 一段动图会把整颗胶囊吃光。12 帧 128px 实测 60–100KB,而闸门是 160KB ——
         上一轮就是这么把 oryx、clawpanel 铺到 157KB,再也放不下一张截图的。
         所以给动图**留一个上限**:它拿走的不能超过还剩下的一半多一点,另一半留给
         其余的图。一个项目的画面不是一段录屏,是一整页。 */
      const stillsAhead = media.filter((m) => !m.motion).length;

      // 1. 首图 → cover。已经有封面的不覆盖(作者自己传的那张更该留着)。
      const hero = media.find((m) => !m.motion) || null;
      if (!cap.cover && hero && room() > 12 * 1024) {
        const c = await stillOf(hero.url, STILL_SIZE, STILL_Q);
        if (c && c.length < room()) { cap.cover = c; did.push('cover'); }
      }

      // 2. 排最前的那段动图 → frames。
      const motion = media.find((m) => m.motion);
      if (!(cap.frames || []).length && motion) {
        const all = room();
        const budget = stillsAhead > 1 ? Math.floor(all * 0.55) : all;
        const fr = budget > 8 * 1024 ? await sampleDemo(motion.url, budget) : [];
        if (fr.length >= 2) {
          cap.frames = fr; cap.fps = 12;
          did.push(`demo×${fr.length}`);
        }
      }

      /* 3. 其余的图 → shots,按名次装到装不下为止。
         ⚠ 已经当过 cover 或者已经被采成 frames 的那两张要跳过,否则同一张画面
         在一颗胶囊里出现两遍 —— 看的人会以为轮播卡住了。 */
      if (!(cap.shots || []).length) {
        const used = new Set([hero && hero.url, motion && motion.url].filter(Boolean));
        const shots = [];
        for (const m of media) {
          if (shots.length >= 10 || m.motion || used.has(m.url)) continue;
          if (room() < 10 * 1024) break;
          /* ⚠ 清晰度也按名次花。前几张是人真正会看的,给足;越往后越是补充,
             给小一点。一律 448 的结果是复杂的截图一张就吃掉半颗胶囊,后面的全被
             挤掉(实测 PawWork 从 10 张掉到 1 张)—— 那不是"更清楚",那是更少。
             媒体本来就是**按重要程度排好的**,分辨率跟着同一个顺序花就是了。 */
          const rank = shots.length;
          const size = rank < 3 ? STILL_SIZE : (rank < 6 ? 352 : 288);
          const one = await stillOf(m.url, size, rank < 3 ? STILL_Q : 70);
          if (!one) continue;
          // 每一张都**先量再放**:剩下的地方装不下这一张,就换下一张(可能更小)。
          if (one.length + 3 > room()) continue;
          shots.push(one); cap.shots = shots;
        }
        if (shots.length) did.push(`shots×${shots.length}`);
      }

      /* 抓不到就把原来的放回去 —— 空着比原来那张差。 */
      if (REFRESH) {
        if (!cap.cover && kept.cover) { cap.cover = kept.cover; did.push('cover kept'); }
        if (!(cap.frames || []).length && kept.frames.length) { cap.frames = kept.frames; did.push('frames kept'); }
        if (!(cap.shots || []).length && kept.shots.length) { cap.shots = kept.shots; did.push('shots kept'); }
      }

      if (!did.length) { console.log(`${label} —`); continue; }

      /* ⚠ 加完再量一次。胶囊有 160KB 的闸,而帧是唯一会把它撑爆的东西 ——
         撑爆了就把帧丢掉,保住 flow/verbs,而不是整条更新失败。 */
      let size = JSON.stringify(cap).length;
      if (size > MAX_CAPSULE_BYTES && cap.frames !== p.capsule.frames) {
        cap.frames = p.capsule.frames || [];
        did = did.filter((d) => !d.startsWith('demo'));
        did.push('demo dropped: too large');
        size = JSON.stringify(cap).length;
      }
      console.log(`${label} ${did.join(' · ')}  [${(size / 1024).toFixed(0)}KB${got ? '' : ', city tree'}]`);
      updates.push({ id: p.id, capsule: cap });
    } catch (e) {
      console.log(`${label} ✗ ${e.message}`);
      if (e.message === 'rate-limited') rateLimited = true;   // 不再中断,见上面
    }
  }

  console.log(`\n${updates.length} projects to update · ${apiCalls} GitHub API calls used`);
  if (DRY) return console.log('--dry: nothing written');
  if (!updates.length) return;
  if (!ADMIN) throw new Error('need --token or PLAZA_ADMIN_TOKEN to write');

  /* ⚠ 分批要按**字节**,不是按条数。第一版一批 25 条,而 /api/cloud/projects 的
     JSON parser 上限是 220kb —— 那个数是照着**一颗**胶囊定的(160KB 加一点余量)。
     25 颗最大能到 4MB,于是整次补数据在第一批就撞回一个 413,而且 express 的 413
     没有 body,报出来是个空对象,看不出是谁太大。
     按大小攒,一批就自然是一到两颗,永远在闸门里面;顺带还把失败的影响缩小到
     一颗 —— 一颗坏胶囊不该带走另外二十四颗。 */
  const LIMIT_BYTES = 180 * 1024;
  let wrote = 0, batch = [], bytes = 2;
  const flush = async () => {
    if (!batch.length) return;
    const r = await fetch(BASE + '/api/cloud/projects/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-terse-admin': ADMIN },
      body: JSON.stringify({ updates: batch }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`backfill failed after ${wrote} written: HTTP ${r.status} ${JSON.stringify(j)}`);
    wrote += j.updated || 0;
    if (j.failed && j.failed.length) console.log(`  ⚠ ${JSON.stringify(j.failed)}`);
    process.stdout.write(`\r  wrote ${wrote}/${updates.length}`);
    batch = []; bytes = 2;
  };
  for (const u of updates) {
    const size = JSON.stringify(u).length + 2;
    if (batch.length && bytes + size > LIMIT_BYTES) await flush();
    batch.push(u); bytes += size;
  }
  await flush();
  console.log(`\ndone — ${wrote} of ${updates.length} updated`);
}

if (require.main === module) main().catch((e) => { console.error('✗', e.message); process.exit(1); });
module.exports = { parseRepo, treeFromDirs, framesFromImage, sampleDemo };
