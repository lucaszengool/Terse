/**
 * restyle-github.js — 广场上**已经发布**的 GitHub 导入项目,风格补成"从代码里来"的那一个。
 *
 *   node api/restyle-github.js            只打印会改什么(默认,dry-run,什么都不写)
 *   node api/restyle-github.js --apply    真的写进数据库(一个事务)
 *
 * 为什么要补:github-capsule.js 以前把每个导入项目都写死成 'modern',于是广场上所有
 * GitHub 项目长成同一座城。新扫描现在用 styleForCode(主语言 → 一路传统,仓库名的哈希
 * 在这一路里挑一个);这个脚本把旧的也按同一条规则补上。
 *
 * 只动这种:胶囊的 link 是一个 github.com 仓库,并且 style 是 'modern' 或者空。
 * ⚠ 作者自己挑过别的风格(tang、norse……)的一律不碰。
 * ⚠ 幂等:改完的不再是 modern;算出来本来就是 modern 的没有要改的 —— 跑第二遍什么都不做。
 * ⚠ 连哪个库由 db.js 决定(TERSE_DATA_DIR → RAILWAY_VOLUME_MOUNT_PATH → <repo>/data),
 *   启动时那行 "[db] sqlite: …" 就是它要改的文件。先 dry-run 看一眼再 --apply。
 */
const { styleForCode, parseRepo } = require('./github-capsule');

/** 纯函数:数据库的行 → 要改的清单 [{id, title, repo, from, to, capsule}]。不写任何东西。 */
function planRestyle(rows) {
  const plan = [];
  for (const row of rows || []) {
    if (!row) continue;
    let cap;
    try { cap = typeof row.capsule === 'string' ? JSON.parse(row.capsule) : row.capsule; } catch (e) { continue; }
    if (!cap || typeof cap !== 'object') continue;
    const link = String(cap.link || '');
    if (!/^https?:\/\/(www\.)?github\.com\//i.test(link)) continue;
    const r = parseRepo(link);
    if (!r) continue;
    /* ⚠ Mac 扫描出来的项目也可能挂着 github 链接,而它的 'modern' 是作者**自己挑的**。
       projects.js 把胶囊自己的 id 存成 srcId,GitHub 导入的是 gh_<owner>_<repo>(见
       github-capsule.js 的 build)。有 srcId 却不是 gh_ 开头 → 不是导入的,不碰。
       没有 srcId 的老行照规则走:link 是 github 仓库 + modern/空。 */
    if (cap.srcId && !/^gh_/.test(String(cap.srcId))) continue;
    const from = String(cap.style || '');
    if (from && from !== 'modern') continue;
    const to = styleForCode(cap.langs, r.full);
    if (to === from) continue;
    plan.push({ id: row.id, title: row.title, repo: r.full, from, to, capsule: Object.assign({}, cap, { style: to }) });
  }
  return plan;
}

/** 读全部项目 → 算清单 → apply 时在一个事务里写回。返回清单。
 *  @param {object} db  require('./db') 的导出(用 allWallProjects / updateWallProjectCapsule / db) */
function restyle(db, { apply = false } = {}) {
  const plan = planRestyle(db.allWallProjects.all());
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
  const plan = restyle(db, { apply });
  for (const p of plan) {
    console.log(`${apply ? 'restyled     ' : 'would restyle'}  ${p.id}  ${p.repo}  ${p.from || '(empty)'} → ${p.to}`);
  }
  console.log(apply
    ? `\n${plan.length} project(s) restyled.`
    : `\n${plan.length} project(s) would change — dry run, nothing written. Re-run with --apply to write.`);
}

module.exports = { planRestyle, restyle };
