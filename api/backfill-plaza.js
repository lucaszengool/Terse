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

const execFileP = promisify(execFile);
const UA = 'terse-plaza';
const SIZE = 128;                  // 和 landing/phone/frames.js 一致
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

async function treeOf(owner, repo) {
  if (!GH_TOKEN) return null;                     // 未认证时 60 次/小时,不够 47 个仓库用
  const meta = await ghApi(`/repos/${owner}/${repo}`);
  if (!meta) return null;
  const branch = meta.default_branch || 'main';
  const t = await ghApi(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  return { branch, tree: Array.isArray(t && t.tree) ? t.tree : [] };
}

/* ── 演示 → 帧 ─────────────────────────────────────────────────────────── */

const toDataUrl = (buf) => 'data:image/jpeg;base64,' + buf.toString('base64');

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
        .jpeg({ quality }).toBuffer();
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
      .slice(0, COUNT).map((f) => toDataUrl(fs.readFileSync(path.join(dir, f))));
  } catch (e) {
    return [];
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ⚠ 帧要**装进剩下的地方**,不是装进一个固定的尺寸。
   这些胶囊已经有封面和截图了,实测线上很多颗本身就有 130KB,而闸门在 160KB ——
   按 128px/q72 采十二帧几乎必然撑爆,于是第一版把每一段演示都丢掉了(日志里一排
   "demo dropped: too large")。丢掉的正好是这次补数据最想要的那一样东西。

   所以先算还剩多少地方,再挑一档采样。由细到粗试,第一个装得下的就用它;
   最粗的一档还装不下,才说明这颗胶囊真的没地方了。 */
const LADDER = [
  { size: 128, quality: 72, count: 12 },
  { size: 112, quality: 64, count: 12 },
  { size: 96, quality: 58, count: 10 },
  { size: 80, quality: 52, count: 8 },
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
    console.log('⚠ no GITHUB_TOKEN — file trees come from the city instead of the API');
  }

  const targets = list.filter((p) => p.capsule && parseRepo(p.capsule.link));
  console.log(`${targets.length} of them link to a GitHub repository\n`);

  const updates = [];
  let n = 0;
  for (const p of targets) {
    if (LIMIT && n >= LIMIT) break;
    n++;
    const { owner, repo } = parseRepo(p.capsule.link);
    const label = `${owner}/${repo}`.padEnd(30);
    try {
      const got = await treeOf(owner, repo);
      const tree = got ? got.tree : treeFromDirs(p.capsule.dirs);
      const branch = got ? got.branch : 'main';
      const pr = await probe(owner, repo, branch, tree);

      const cap = Object.assign({}, p.capsule);
      let did = [];
      if (pr.flow && (pr.flow.entry || (pr.flow.cmds || []).length)) { cap.flow = pr.flow; did.push('flow'); }
      if ((pr.verbs || []).length) { cap.verbs = pr.verbs; did.push(`verbs×${pr.verbs.length}`); }

      // 演示只在还没有帧的时候补 —— 已经有帧的说明作者自己传过东西,别覆盖他。
      if (!(cap.frames || []).length && pr.demo && pr.demo.motion) {
        // 剩下的地方 = 闸门 − 这颗胶囊现在的大小,再留 2KB 给 flow/verbs 和逗号。
        const budget = MAX_CAPSULE_BYTES - JSON.stringify(cap).length - 2048;
        const fr = budget > 8 * 1024 ? await sampleDemo(pr.demo.url, budget) : [];
        if (fr.length >= 2) {
          cap.frames = fr; cap.fps = 12;
          did.push(`demo×${fr.length}`);
        }
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
      if (e.message === 'rate-limited') break;
    }
  }

  console.log(`\n${updates.length} projects to update · ${apiCalls} GitHub API calls used`);
  if (DRY) return console.log('--dry: nothing written');
  if (!updates.length) return;
  if (!ADMIN) throw new Error('need --token or PLAZA_ADMIN_TOKEN to write');

  for (let i = 0; i < updates.length; i += 25) {
    const batch = updates.slice(i, i + 25);
    const r = await fetch(BASE + '/api/cloud/projects/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-terse-admin': ADMIN },
      body: JSON.stringify({ updates: batch }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`backfill failed: HTTP ${r.status} ${JSON.stringify(j)}`);
    console.log(`  wrote ${j.updated}/${batch.length}` + (j.failed && j.failed.length ? ` (failed: ${JSON.stringify(j.failed)})` : ''));
  }
  console.log('done');
}

if (require.main === module) main().catch((e) => { console.error('✗', e.message); process.exit(1); });
module.exports = { parseRepo, treeFromDirs, framesFromImage, sampleDemo };
