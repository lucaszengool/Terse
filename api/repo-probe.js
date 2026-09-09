/**
 * repo-probe.js — 读出一个仓库**在干什么**,而不只是**由什么组成**。
 *
 * 代码城市回答的是"这个项目有多大、分几块" —— 那是**形状**。它答不了"它是干嘛的"。
 * 这个文件补的就是那一半,三样东西:
 *
 *   A. **作者自己录的演示**。调研出来最有用的一条:最受欢迎的一百个仓库里
 *      **62% 的 README 里已经有一段 GIF 或视频**,而且冲到一千星的项目几乎都把它
 *      放在前三百行。也就是说"一步步演示"这件事,大部分好项目**已经做完了**,而且
 *      是作者本人做的 —— 我要做的只是把它找出来,不是重新发明一个。
 *
 *   B. **入口点**。静态分析里判断"程序从哪开始跑"的老办法:package.json 的 bin、
 *      Cargo.toml 的 [[bin]]、pyproject 的 scripts、Go 的 cmd/、__main__。
 *      从入口出发能到达的地方才是这个项目**真正会做的事**。
 *
 *   C. **动词**。命令名和 README 的小标题里那些祈使句:scan / diff / report。
 *      三个动词说清楚一个工具是干嘛的,比任何架构图都快。
 *
 * ⚠ 全部走 raw.githubusercontent,**不花 API 配额**。没有 token 时 GitHub API 一小时
 * 只给 60 次,而扫描本身已经要用掉五次;清单文件走 raw 就一次都不占。
 */

const UA = 'terse-plaza';
const RAW = 'https://raw.githubusercontent.com';

/** 取一个文本文件。取不到就是没有,不是错误 —— 大部分仓库没有大部分清单。 */
async function raw(owner, repo, branch, file) {
  try {
    const res = await fetch(`${RAW}/${owner}/${repo}/${branch}/${file}`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return null;
    const len = +res.headers.get('content-length') || 0;
    if (len > 400 * 1024) return null;            // 超大的 README 不值得读
    return await res.text();
  } catch (e) { return null; }
}

/* ── A. 作者自己录的演示 ─────────────────────────────────────────────────── */

/** README 里**靠前**的第一张动图或视频。
 *
 *  ⚠ 只看前面一截。README 底部往往挂着一堆徽章、赞助商 logo、贡献者头像 ——
 *  那些也是图片,但没有一张是"这个东西怎么用"。演示放在最前面,这是约定俗成的,
 *  调研里那句"冲到一千星的项目几乎都把它放在前三百行"说的就是这件事。 */
/* 徽章、头像、赞助商 logo —— 都是图片,没有一张在讲这个东西怎么用。 */
const NOT_MEDIA = /shields\.io|badge|travis|circleci|codecov|appveyor|sonarcloud|opencollective|buymeacoffee|ko-fi|patreon|gitpod|contrib\.rocks|starchart|star-history|forthebadge|visitor|hits\.seeyoufarm|profile-counter/i;

const MOTION_EXT = /\.(gif|mp4|webm|mov|apng)(\?|$)/i;
const STILL_EXT = /\.(png|jpe?g|webp|svg)(\?|$)/i;
/* GitHub 自己的附件域:拖进 issue / README 的图和视频没有扩展名,而那恰恰是
   最近几年**最常见**的演示放法。当动图算。 */
const GH_ATTACH = /user-images\.githubusercontent\.com|github\.com\/user-attachments/i;

/** 相对路径补成 raw 的绝对地址。已经是绝对的原样返回。 */
function absolutise(u, owner, repo, branch) {
  const t = String(u || '').trim().replace(/^<|>$/g, '');
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return 'https:' + t;
  if (t.startsWith('data:')) return '';                 // 内联的图不用再抓
  return `${RAW}/${owner}/${repo}/${branch}/${t.replace(/^\.?\//, '')}`;
}

/**
 * A. 这个项目**所有**能收集到的画面,按重要程度排好。
 *
 * 原来这里只取第一张会动的图就返回了。可一个项目的 README 常常是:一张主视觉,
 * 底下几段各配一张截图,再往下还有一段录屏 —— 只取一张,等于把作者铺陈了一整页
 * 的东西压成一格。这一版把它们**全部**收下来,再排序。
 *
 * 排序的依据,按份量从大到小:
 *
 *   · **位置**。README 是从上往下写的,越靠前越是作者想让你先看见的。首图几乎
 *     总是主视觉 —— 所以第一张(排除徽章之后)单独加一大笔分,这就是"首图"。
 *   · **会不会动**。一段 GIF 讲清楚的事,十张截图讲不清。
 *   · **名字**。demo / preview / screenshot / usage 这些词是作者自己标的用途;
 *     logo / icon / banner 是装饰,往后排(但不丢 —— 它常常就是首图)。
 *   · **alt 文本**同理,而且它是作者用人话写的说明。
 *
 * ⚠ 仓库里的图也收:README 里没贴、但躺在 docs/ assets/ screenshots/ 里的
 * GIF,是"这个项目里任何 gif 动图"这句话的字面意思。它们排在 README 里那些
 * 之后 —— 作者没把它贴出来,多半有他的道理。
 */
function collectMedia(md, owner, repo, branch, tree) {
  const seen = new Map();
  const push = (rawUrl, score, why, alt) => {
    const url = absolutise(rawUrl, owner, repo, branch);
    if (!url || NOT_MEDIA.test(url)) return;
    const motion = MOTION_EXT.test(url) || GH_ATTACH.test(url);
    if (!motion && !STILL_EXT.test(url)) return;
    // SVG 画不成粒子帧(要光栅化),而且多半是 logo。收下但排最后。
    const isSvg = /\.svg(\?|$)/i.test(url);
    const prev = seen.get(url);
    const s = score + (motion ? 260 : 0) + (isSvg ? -220 : 0) + hintScore(url + ' ' + (alt || ''));
    if (!prev || s > prev.score) seen.set(url, { url, motion, score: s, why, alt: alt || '' });
  };

  if (md) {
    /* ⚠ 整篇都读,不再只看前 12000 字 —— 排序靠的是位置分,不是截断。截断会把
       长 README 后半段的录屏整段丢掉,而那常常是最好的一段。 */
    const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|<img[^>]*?src=["']([^"']+)["'][^>]*?>|<(?:video|source)[^>]*?src=["']([^"']+)["'][^>]*?>/gi;
    let m, order = 0;
    while ((m = re.exec(md)) !== null) {
      const alt = m[1] || (m[0].match(/alt=["']([^"']*)["']/i) || [])[1] || '';
      const url = m[2] || m[3] || m[4];
      /* 位置分。第一张(排除徽章后)就是首图,单独一大笔;之后按在文档里的深度
         递减,到文末趋近于零 —— README 底部挂的是贡献者头像和赞助商。 */
      const at = m.index / Math.max(1, md.length);
      const pos = Math.round(620 * Math.pow(1 - at, 2.2));
      push(url, pos + (order === 0 ? 300 : 0), order === 0 ? 'hero' : 'readme', alt);
      order++;
    }
  }

  /* 仓库里躺着的图。只看那几个**放给人看**的目录 —— 全仓库扫会把测试夹具、
     图标集、node_modules 里的东西全捞进来。 */
  for (const nd of (tree || [])) {
    const path = (nd && nd.path) || '';
    if (!/^(docs?|assets?|images?|img|screenshots?|media|examples?|\.github)\//i.test(path)) continue;
    if (!MOTION_EXT.test(path) && !STILL_EXT.test(path)) continue;
    // README 里贴过的不重复计分(push 里按 url 去重,分数取高的那个)。
    push(path, 40, 'repo', path.split('/').pop());
  }

  const all = [...seen.values()].sort((a, b) => b.score - a.score);

  /* ⚠ 首图**钉在第一位**,不参与排序。README 第一张图是作者选的门面 —— 哪怕它
     只是个 logo,那也是他决定你先看见的东西,而排序会把它压到一段录屏底下
     (实测 gum:第一张 gum.png 被 VHS 那段 GIF 挤到第二)。
     "先放首图,再按重要程度放其余的" —— 顺序就是这么两段。 */
  const heroAt = all.findIndex((m) => m.why === 'hero');
  if (heroAt > 0) all.unshift(all.splice(heroAt, 1)[0]);
  return all;
}

/** demo / screenshot 这些词是作者自己标的用途;logo / icon 是装饰。 */
function hintScore(text) {
  const t = String(text).toLowerCase();
  let s = 0;
  if (/demo|preview|usage|example|walkthrough|showcase|in-action|recording|screencast|vhs/.test(t)) s += 180;
  if (/screenshot|screen-shot|shot\d|capture/.test(t)) s += 120;
  if (/hero|cover|splash|header/.test(t)) s += 90;
  if (/logo|icon|favicon|avatar|banner|wordmark|mascot/.test(t)) s -= 200;
  if (/diagram|architecture|flow/.test(t)) s += 60;
  if (/light|dark/.test(t)) s -= 30;          // 同一张图的明暗两版,留一张就够
  return s;
}

/** 兼容旧调用:排第一的那个,外加"会动的里排第一的"。 */
function readmeDemo(md, owner, repo, branch, tree) {
  const all = collectMedia(md, owner, repo, branch, tree);
  if (!all.length) return null;
  const motion = all.find((x) => x.motion);
  const pick = motion || all[0];
  return { url: pick.url, motion: !!pick.motion };
}

/* ── B. 入口点 ───────────────────────────────────────────────────────────── */

/** 从清单和文件树判断:这个东西是**怎么被跑起来的**。
 *
 * ⚠ 先把**所有**证据收齐,再排名 —— 不要一门语言一门语言地问"是不是你",
 * 第一个答上来的说了算。第一版就是那么写的,于是 tach 被判成了库:它是一个
 * Python 命令行工具,但内核是 Rust,根目录同时有 Cargo.toml 和 pyproject.toml;
 * Rust 那一支先跑,看见 `[lib]`(PyO3 扩展)就定了性,Python 那一支被 `!out.kind`
 * 直接跳过 —— 一个给别的语言当扩展用的库,盖掉了人真正在敲的那个命令。
 *
 * 排名的规矩:**命令 > 服务 > 应用 > 库**。一个项目可以同时是好几样,而人记住的
 * 是他怎么用它 —— 你敲 `tach`,不会说"我 import 了 tach 的 native 扩展"。
 */
function entryPoints(manifests, tree) {
  const paths = (tree || []).map((n) => n.path || '');
  const set = new Set(paths);
  const has = (p) => set.has(p);
  const under = (p) => paths.some((x) => x.startsWith(p));
  const matches = (re) => paths.some((x) => re.test(x));

  const sig = { cli: null, service: null, app: null, lib: null };
  let name = '';

  // ── Node ──
  if (manifests.pkg) {
    let j = null;
    try { j = JSON.parse(manifests.pkg); } catch (e) {}
    if (j) {
      name = name || j.name || '';
      if (j.bin) {
        sig.cli = typeof j.bin === 'string' ? [j.name].filter(Boolean) : Object.keys(j.bin).slice(0, 6);
      }
      if (j.scripts && (j.scripts.start || j.scripts.serve || j.scripts.dev)) {
        if (has('index.html') || under('public/') || under('app/') || under('src/pages/')) sig.app = [];
        else sig.service = [];
      }
      if (j.main || j.exports || j.module) sig.lib = [];
    }
  }
  // ── Rust ──
  if (manifests.cargo) {
    const t = manifests.cargo;
    name = name || (t.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || '';
    /* ⚠ 工作区里的二进制看不见。oryx 的根 Cargo.toml 只有 `[workspace] members`,
       真正的入口在 `oryx-tui/src/main.rs` —— 只看根目录的 src/main.rs 会漏掉整类
       项目。所以问文件树:**任何**一层的 src/main.rs 都算。 */
    if (/\[\[bin\]\]/.test(t) || has('src/main.rs') || under('src/bin/') || matches(/(^|\/)src\/main\.rs$/)) {
      sig.cli = sig.cli || [name].filter(Boolean);
    }
    if (/\[lib\]/.test(t) || has('src/lib.rs')) sig.lib = sig.lib || [];
  }
  // ── Python ──
  if (manifests.pyproject) {
    const t = manifests.pyproject;
    name = name || (t.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || '';
    // 三种写法都要认:新标准、poetry、setuptools 那一代。
    const seg = t.split(/\[project\.scripts\]|\[tool\.poetry\.scripts\]|console_scripts/)[1];
    if (seg) {
      const cmds = (seg.split(/\n\s*\[/)[0].match(/^\s*"?([A-Za-z0-9_-]+)"?\s*=/gm) || [])
        .map((x) => x.replace(/["\s=]/g, '')).filter(Boolean).slice(0, 6);
      if (cmds.length) sig.cli = sig.cli || cmds;
    }
    if (!sig.cli && (matches(/(^|\/)__main__\.py$/) || has('main.py'))) sig.cli = sig.cli || [name].filter(Boolean);
    sig.lib = sig.lib || [];
  }
  // ── Go ──
  if (manifests.gomod) {
    const mod = (manifests.gomod.match(/^module\s+(\S+)/m) || [])[1] || '';
    /* ⚠ 去掉结尾的 /v2。Go 的模块路径把大版本写在路径里
       (`github.com/charmbracelet/gum/v2`),直接取最后一段拿到的是 "v2" ——
       实测 gum 的命令名就变成了 v2。 */
    name = name || mod.replace(/\/v[0-9]+$/, '').split('/').pop();
    const cmds = [...new Set(paths.map((p) => (p.match(/^cmd\/([^/]+)\//) || [])[1]).filter(Boolean))];
    if (cmds.length) sig.cli = sig.cli || cmds.slice(0, 6);
    else if (has('main.go')) sig.cli = sig.cli || [name].filter(Boolean);
    else sig.lib = sig.lib || [];
  }

  // 什么清单都没有:看得见什么就说什么。
  if (!sig.cli && !sig.service && !sig.app && !sig.lib) {
    if (has('Dockerfile') || under('server/') || under('api/')) sig.service = [];
    else if (has('index.html') || under('src/pages/') || under('app/')) sig.app = [];
    else sig.lib = [];
  }

  // 命令 > 服务 > 应用 > 库。
  for (const kind of ['cli', 'service', 'app', 'lib']) {
    if (sig[kind]) return { kind, entry: name, cmds: sig[kind] };
  }
  return { kind: 'lib', entry: name, cmds: [] };
}

/* ── C. 动词 ─────────────────────────────────────────────────────────────── */

/* 一个 README 的小标题里,大部分是套话。这些不是这个项目在做的事。 */
const BORING = new Set([
  'installation', 'install', 'usage', 'getting started', 'quick start', 'quickstart',
  'features', 'license', 'licence', 'contributing', 'contributors', 'acknowledgements',
  'roadmap', 'faq', 'documentation', 'docs', 'examples', 'example', 'api', 'changelog',
  'requirements', 'prerequisites', 'configuration', 'config', 'development', 'testing',
  'credits', 'support', 'sponsors', 'star history', 'table of contents', 'about',
  'how to use', 'how it works', 'why', 'motivation', 'benchmarks', 'alternatives',
  /* ⚠ 剥掉 emoji 之后剩下的那个词也要在这张表上。"## 📸 Demo" 去掉相机变成
     "Demo" —— 而 BORING 里当时只有 "features",于是这一条一路走到了动词里。
     "Demo" 讲的是这篇 README 有一段演示,不是这个项目会做什么。 */
  'demo', 'demos', 'screenshot', 'screenshots', 'preview', 'gallery', 'showcase',
  'video', 'videos', 'overview', 'introduction', 'intro', 'usage examples',
  '演示', '截图', '预览', '简介', '概述',
  '安装', '使用', '快速开始', '特性', '功能', '文档', '贡献', '许可证', '目录',
]);

/** 这个项目**会做哪些动作**。命令名优先 —— 那是作者自己给动作起的名字;
 *  不够就拿 README 的小标题补,套话滤掉。 */
function verbsOf(md, entry) {
  const out = [];
  for (const c of (entry.cmds || [])) {
    const v = String(c).trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  }
  if (md) {
    const heads = (md.slice(0, 20000).match(/^#{2,3}\s+(.+)$/gm) || [])
      /* ⚠ 先把开头的 emoji 和符号剥掉再判。README 里"## ✨ Features"非常常见,
         而 BORING 里存的是 "features" —— 带着那颗星就对不上,于是套话原样漏了出来
         (实测 oryx 的动词是 "📸 Demo"、"✨ Features")。 */
      .map((h) => h.replace(/^#{2,3}\s+/, '').replace(/[*_`#]/g, '')
                   .replace(/^[\s️‍←-⇿☀-➿\u{1F000}-\u{1FAFF}]+/gu, '')
                   .trim())
      .filter((h) => h.length >= 2 && h.length <= 22)
      .filter((h) => !BORING.has(h.toLowerCase()))
      // 徽章行和纯链接的标题不要
      .filter((h) => !/^\[|\]\(|https?:/.test(h))
      /* ⚠ 安装说明不是"这个项目会做什么"。实测 bat 的小标题里混进来一串
         "On Ubuntu (using apt)"、"On Alpine Linux" —— 那讲的是怎么装,
         不是它能干嘛。 */
      /* ⚠ "From source" 也是安装说明。原来的表里有 "build from source" 和
         "from crates",光秃秃的 "From source" 却漏了 —— 而那正是最常见的写法。
         这里只点名几种装法,不是 `^from\s` 一刀切:"From CSV to JSON" 是个真动作。 */
      .filter((h) => !/^on\s|install|ubuntu|debian|alpine|arch\b|macos|windows|homebrew|brew\b|apt\b|yum|pacman|从源码|源码安装|build from source|binary release|from crates|download|prebuilt|^via\s|^using\s/i.test(h))
      .filter((h) => !/^from\s+(source|binar|release|crates|pypi|npm|nix|aur|snap|tarball)/i.test(h));
    for (const h of heads) {
      if (out.length >= 6) break;
      if (out.indexOf(h) < 0) out.push(h);
    }
  }
  return out.slice(0, 6);
}

/** 一次探测。build() 里调一次,五个 raw 请求,**不占 API 配额**。 */
async function probe(owner, repo, branch, tree) {
  /* ⚠ README 不一定叫 README.md。oryx 的 `README.md` 是 404 —— 于是既没有演示
     也没有动词,而它两样都有,只是文件名不同。挨个试到有为止,试的次数不要紧:
     raw 不占 API 配额。 */
  const readme = async () => {
    for (const f of ['README.md', 'readme.md', 'README.MD', 'Readme.md',
                     'README.rst', 'README', 'docs/README.md', '.github/README.md']) {
      const t = await raw(owner, repo, branch, f);
      if (t) return t;
    }
    return null;
  };
  const [md, pkg, cargo, pyproject, gomod] = await Promise.all([
    readme(),
    raw(owner, repo, branch, 'package.json'),
    raw(owner, repo, branch, 'Cargo.toml'),
    raw(owner, repo, branch, 'pyproject.toml'),
    raw(owner, repo, branch, 'go.mod'),
  ]);
  const entry = entryPoints({ pkg, cargo, pyproject, gomod }, tree);
  const media = collectMedia(md, owner, repo, branch, tree);
  return {
    media,
    demo: readmeDemo(md, owner, repo, branch, tree),
    flow: { kind: entry.kind, entry: entry.entry || repo, cmds: entry.cmds },
    verbs: verbsOf(md, entry),
  };
}

module.exports = { probe, readmeDemo, collectMedia, entryPoints, verbsOf };
