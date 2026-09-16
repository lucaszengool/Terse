/**
 * geo-backfill.js — 给广场上 GitHub 导入的项目补上"在星球上的哪儿"。
 *
 *   node api/geo-backfill.js            只打印会改什么(默认,dry-run,什么都不写)
 *   node api/geo-backfill.js --apply    真的写进数据库(一个事务)
 *
 * 位置 = 仓库作者在 GitHub 主页上**公开填写**的所在地(users/:owner 的 location),
 * 用 geo.js 的城市表换成坐标,取整到一度。认不出来的不补 —— 不上星球比落错地方好。
 * 只补还没有 geo 的项目;已经有位置的(发布时 Cloudflare 给的)一律不碰。幂等。
 * 连哪个库、为什么要在线上容器里跑,见 restyle-github.js 顶部。
 */
const { parseRepo } = require('./github-capsule');
const { geocodePlace } = require('./geo');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

async function ownerLocation(owner) {
  const headers = { 'User-Agent': 'terse-plaza', Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const r = await fetch('https://api.github.com/users/' + encodeURIComponent(owner), { headers });
  if (!r.ok) return null;
  const j = await r.json();
  return (j && j.location) || null;
}

/** 读全部项目 → 查作者所在地 → 算清单;apply 时一个事务写回。 */
async function geoBackfill(db, { apply = false, log = console.log } = {}) {
  const plan = [], cache = new Map();
  for (const row of db.allWallProjects.all()) {
    let cap;
    try { cap = JSON.parse(row.capsule); } catch (e) { continue; }
    if (!cap || cap.geo) continue;
    const link = String(cap.link || '');
    if (!/^https?:\/\/(www\.)?github\.com\//i.test(link)) continue;
    const r = parseRepo(link);
    if (!r) continue;
    const owner = r.full.split('/')[0];
    if (!cache.has(owner)) cache.set(owner, await ownerLocation(owner).catch(() => null));
    const where = cache.get(owner);
    const geo = geocodePlace(where);
    log(`${geo ? '✓' : '·'} ${r.full.padEnd(40)} ${JSON.stringify(where || '')} → ${geo ? `${geo.city || geo.country} (${geo.lat}, ${geo.lon})` : 'skip'}`);
    if (geo) plan.push({ id: row.id, title: row.title, capsule: Object.assign({}, cap, { geo }) });
  }
  if (apply && plan.length) {
    db.db.transaction(() => {
      for (const p of plan) db.updateWallProjectCapsule.run({ id: p.id, title: p.title, capsule: JSON.stringify(p.capsule) });
    })();
  }
  return plan;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const db = require('./db');
  geoBackfill(db, { apply }).then((plan) => {
    console.log(`${apply ? 'wrote' : 'would write'} geo for ${plan.length} project(s)${apply ? '' : ' — run with --apply to write'}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { geoBackfill };
