/**
 * github-capsule.js — 一条 GitHub 链接 → 一颗胶囊。挂在 /api/cloud/github。
 *
 * **为什么需要它。** 到今天为止,发布一个项目必须有那台 Mac:胶囊是本地扫描出来的,
 * 而手机上没有文件夹可扫。于是这个 app 在手机上是**只能看不能发**的 —— 对一个
 * "刷别人项目"的产品来说,这不是缺一个功能,这是缺了另外半个闭环。抖音之所以是
 * 抖音,是因为你手上那台设备既能刷也能发。
 *
 * **为什么是 GitHub 而不是"上传截图"。** 别的同类站点(CheckMyVibeCode、
 * Vibe Coding Showcase)都是"贴个链接 + 传张图 + 写段话",那是 Product Hunt 的形状,
 * 而它把这个产品唯一特别的地方扔掉了:项目**自己会长出画面**。所以这里仍然只收
 * **参数**,不收像素 —— 城市依旧是在看的人自己机器上摆出来的。
 *
 * **公开 API 就够,不用 clone。** 一次扫描是五个公开请求:
 *
 *   · /repos/{o}/{r}                     名字、简介、许可证、默认分支
 *   · /repos/{o}/{r}/languages           **就是 Linguist 的字节数** —— 和扫描端
 *                                        算 langs 的口径一模一样,不用换算
 *   · /git/trees/{branch}?recursive=1    整棵文件树 → 顶层目录就是城市里的楼
 *   · /stats/commit_activity             52 周 × 7 天 = **正好 371 个数**,
 *                                        提交天际线要的就是这个形状
 *   · /contributors                      贡献者
 *
 * ⚠ 拿不到的东西**就不放进去**,不猜。`hot`(改得最勤的文件)要逐个提交去查文件
 * 列表,一次扫描会变成上百个请求;`graph`(依赖星座)要读源码解析 import。两样都
 * 留空 —— 城市少一层读法,好过编一层假的。
 *
 * ⚠ 没有 token 时 GitHub 给的是**每小时 60 次**,而且是按 IP 算的,所以是整台
 * 服务器共享 12 次扫描。设了 GITHUB_TOKEN 就是 5000。所以这里缓存一小时:同一个
 * 仓库连点五次只花一次额度,而人第一件想做的事就是连点五次。
 */
const express = require('express');
const { png } = require('./tinypng');

const router = express.Router();

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'terse-plaza';
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map();                 // repo → { at, capsule }

/* 语言 → 颜色表认得的键。和 projects.rs 的 lang_of 一份口径:那张表是小写的,
   传 'TypeScript' 进去,每座塔都会退回同一个灰色。 */
const LANG_KEY = {
  Rust: 'rust', TypeScript: 'ts', JavaScript: 'js', Python: 'python', Go: 'go',
  Swift: 'swift', Kotlin: 'kotlin', Java: 'java', C: 'c', 'C++': 'c++',
  Ruby: 'ruby', PHP: 'php', 'C#': 'c#', HTML: 'html', CSS: 'css',
  Shell: 'shell', SQL: 'sql',
};
const EXT_LANG = {
  rs: 'rust', ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'python', go: 'go', swift: 'swift', kt: 'kotlin', java: 'java',
  c: 'c', h: 'c', cpp: 'c++', cc: 'c++', hpp: 'c++', rb: 'ruby', php: 'php',
  cs: 'c#', html: 'html', css: 'css', sh: 'shell', sql: 'sql',
};
/* 目录名 → 种类。和扫描端同一套,城市按它决定这座楼是什么形状。 */
const KIND_OF = {
  src: 'code', lib: 'code', app: 'code', api: 'code', server: 'code',
  test: 'test', tests: 'test', spec: 'test', __tests__: 'test',
  docs: 'docs', doc: 'docs', examples: 'docs', example: 'docs',
  assets: 'assets', public: 'assets', static: 'assets', images: 'assets',
  config: 'config', scripts: 'config', '.github': 'config', build: 'config',
};

/** owner/repo,从人可能贴进来的任何一种形式里取出来。 */
function parseRepo(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // github.com/o/r, https://github.com/o/r.git, git@github.com:o/r, o/r
  const m = s.match(/github\.com[/:]+([^/\s]+)\/([^/\s#?]+)/i)
         || s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const owner = m[1], repo = m[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo, full: `${owner}/${repo}` };
}

async function gh(path) {
  const res = await fetch('https://api.github.com' + path, {
    headers: Object.assign(
      { Accept: 'application/vnd.github+json', 'User-Agent': UA },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}
    ),
  });
  if (res.status === 404) { const e = new Error('No such repository'); e.code = 404; throw e; }
  if (res.status === 403 || res.status === 429) {
    const e = new Error('GitHub rate limit reached — try again in a few minutes');
    e.code = 429; throw e;
  }
  if (!res.ok) { const e = new Error('GitHub said ' + res.status); e.code = 502; throw e; }
  return res.json();
}
/** 这几样缺了不该让整次扫描失败 —— 少一层读法,不是少一个项目。 */
const soft = (p) => gh(p).catch(() => null);

/** 语言字节数 → [[键, 占比]],降序,取前三。和扫描端一样按**字节**不按文件数。 */
function langsOf(map) {
  const rows = Object.entries(map || {})
    .map(([k, v]) => [LANG_KEY[k] || k.toLowerCase(), +v || 0])
    .filter((r) => r[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, r) => a + r[1], 0) || 1;
  return rows.slice(0, 3).map((r) => [r[0], +(r[1] / total).toFixed(3)]);
}

/** 文件树 → 城市里的楼。顶层一个目录一座,根目录下的散文件合成一座 "root"。 */
function dirsOf(tree) {
  const by = new Map();
  for (const node of tree) {
    if (node.type !== 'blob') continue;
    const parts = String(node.path || '').split('/');
    const top = parts.length > 1 ? parts[0] : 'root';
    if (top.startsWith('.') && top !== '.github') continue;
    let d = by.get(top);
    if (!d) { d = { name: top, files: 0, bytes: 0, langs: new Map(), kids: new Map(), depth: 1 }; by.set(top, d); }
    d.files++;
    d.bytes += +node.size || 0;
    d.depth = Math.max(d.depth, parts.length - 1);
    const ext = (parts[parts.length - 1].split('.').pop() || '').toLowerCase();
    const lang = EXT_LANG[ext];
    if (lang) d.langs.set(lang, (d.langs.get(lang) || 0) + (+node.size || 0));
    if (parts.length > 2) {
      const kid = parts[1];
      const k = d.kids.get(kid) || [kid, 0, 0];
      k[1]++; k[2] += +node.size || 0;
      d.kids.set(kid, k);
    }
  }
  return [...by.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 25)
    .map((d) => {
      const ls = [...d.langs.entries()].sort((a, b) => b[1] - a[1]);
      const tot = ls.reduce((a, r) => a + r[1], 0) || 1;
      return {
        name: d.name,
        files: d.files,
        bytes: d.bytes,
        kind: KIND_OF[d.name] || 'code',
        // 一座楼取**它自己**的主语言,不是整个项目的 —— 城市因此是多色的。
        langs: ls.slice(0, 3).map((r) => [r[0], +(r[1] / tot).toFixed(3)]),
        kids: [...d.kids.values()].sort((a, b) => b[2] - a[2]).slice(0, 8),
        depth: Math.min(4, d.depth),
        churn: 0,
        age_days: 0,
      };
    });
}

/** 52 周 × 7 天 → 371 个小整数,正好是天际线要的长度。 */
function commitsOf(weeks) {
  if (!Array.isArray(weeks) || !weeks.length) return [];
  const out = [];
  for (const w of weeks.slice(-53)) {
    const days = (w && Array.isArray(w.days)) ? w.days : [0, 0, 0, 0, 0, 0, 0];
    for (const d of days) out.push(Math.max(0, Math.min(9999, +d || 0)));
  }
  return out.slice(-371);
}

/** 封面。用**主语言的颜色**生成,而不是去抓仓库的 OG 图 —— 那是一张外部图片,
 *  要多一次请求、几十 KB,而且随时会变。这张永远画得出来,并且和城市同色。 */
const LANG_HEX = {
  rust: '#dea584', ts: '#3178c6', js: '#f1e05a', python: '#3572A5', go: '#00ADD8',
  swift: '#F05138', kotlin: '#A97BFF', java: '#b07219', c: '#555555', 'c++': '#f34b7d',
  ruby: '#701516', php: '#4F5D95', 'c#': '#178600', html: '#e34c26', css: '#563d7c',
  shell: '#89e051', sql: '#e38c00',
};
function coverFor(langs, seedStr) {
  const hex = (LANG_HEX[(langs[0] || [])[0]] || '#6ee7b7').slice(1);
  const n = parseInt(hex, 16);
  const a = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const hex2 = (LANG_HEX[(langs[1] || [])[0]] || '#1b2430').slice(1);
  const m = parseInt(hex2, 16);
  const b = [(m >> 16) & 255, (m >> 8) & 255, m & 255];
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 131 + seedStr.charCodeAt(i)) >>> 0;
  const ang = (h % 360) * Math.PI / 180;
  const buf = png(96, 72, (u, v) => {
    const t = Math.min(1, Math.max(0, u * Math.cos(ang) + v * Math.sin(ang)));
    return [0, 1, 2].map((i) => Math.round((a[i] * 0.75) * (1 - t) + (b[i] * 0.55) * t));
  });
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function build(owner, repo) {
  const meta = await gh(`/repos/${owner}/${repo}`);
  const branch = meta.default_branch || 'main';
  const [langMap, tree, weeks, people] = await Promise.all([
    soft(`/repos/${owner}/${repo}/languages`),
    soft(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`),
    soft(`/repos/${owner}/${repo}/stats/commit_activity`),
    soft(`/repos/${owner}/${repo}/contributors?per_page=12`),
  ]);

  const langs = langsOf(langMap);
  const dirs = (tree && Array.isArray(tree.tree)) ? dirsOf(tree.tree) : [];
  const files = dirs.reduce((a, d) => a + d.files, 0);

  const lines = [];
  if (meta.stargazers_count) lines.push(`★ ${meta.stargazers_count}`);
  if (meta.license && meta.license.spdx_id && meta.license.spdx_id !== 'NOASSERTION') {
    lines.push(meta.license.spdx_id);
  }
  if (meta.pushed_at) {
    const days = Math.round((Date.now() - Date.parse(meta.pushed_at)) / 86400000);
    lines.push(days <= 1 ? 'pushed today' : `pushed ${days}d ago`);
  }

  return {
    v: 2,
    id: 'gh_' + owner.toLowerCase() + '_' + repo.toLowerCase(),
    title: String(repo).slice(0, 48),
    subtitle: String(meta.description || '').slice(0, 160),
    // 介绍先用简介垫上,发布前人可以自己改 —— 这一步正是"上传时写文案"。
    desc: String(meta.description || '').slice(0, 600),
    tags: [(langs[0] || [])[0], owner.toLowerCase()].filter(Boolean).slice(0, 4),
    cover: coverFor(langs, owner + '/' + repo),
    shots: [],
    lines: lines.slice(0, 4),
    files,
    langs,
    dirs,
    style: 'modern',
    links: [],
    commits: commitsOf(weeks),
    // ⚠ 拿不到就留空,不猜 —— 见文件顶部。
    graph: null,
    hot: [],
    people: (Array.isArray(people) ? people : [])
      .filter((p) => p && p.login && p.login.indexOf('@') < 0)
      .slice(0, 12)
      .map((p) => [String(p.login).slice(0, 40), Math.max(0, +p.contributions || 0)]),
    // 点得开的那条链接。扫描出来的项目天然有一个 —— 就是它自己的仓库。
    link: meta.html_url || '',
    source: { kind: 'github', owner, repo, url: meta.html_url || '' },
  };
}

// POST /api/cloud/github/scan   { url }  → { capsule }
// **不发布**。扫完先给人看一眼,让他改标题和介绍再决定发不发 —— 上传前能预览,
// 是"发布"和"提交"之间的全部区别。
router.post('/scan', async (req, res) => {
  const r = parseRepo((req.body || {}).url);
  if (!r) return res.status(400).json({ error: 'Not a GitHub repository link' });

  const hit = cache.get(r.full);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.json({ ok: true, capsule: hit.capsule, cached: true });
  }
  try {
    const capsule = await build(r.owner, r.repo);
    if (!capsule.dirs.length) {
      return res.status(422).json({ error: 'That repository has no files to build a city from' });
    }
    cache.set(r.full, { at: Date.now(), capsule });
    res.json({ ok: true, capsule });
  } catch (e) {
    res.status(e.code === 404 ? 404 : e.code === 429 ? 429 : 502)
       .json({ error: e.message || 'Could not read that repository' });
  }
});

module.exports = router;
module.exports.parseRepo = parseRepo;
module.exports.langsOf = langsOf;
module.exports.dirsOf = dirsOf;
module.exports.commitsOf = commitsOf;
