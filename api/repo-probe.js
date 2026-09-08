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
function readmeDemo(md, owner, repo, branch) {
  if (!md) return null;
  const head = md.slice(0, 12000);              // 大约前三百行
  const cands = [];

  // ![alt](url) 和 <img src="url">,以及 <video src=…> / <source src=…>
  const re = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img[^>]+src=["']([^"']+)["']|<(?:video|source)[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(head))) cands.push(m[1] || m[2] || m[3]);

  for (const c of cands) {
    let u = String(c).trim();
    if (!u) continue;
    // 徽章不是演示。shields/badge/travis 那一排全是状态图标。
    if (/shields\.io|badge|travis|circleci|codecov|appveyor|sonarcloud|opencollective/i.test(u)) continue;
    // 相对路径要补成绝对的。
    if (!/^https?:\/\//i.test(u)) {
      u = `${RAW}/${owner}/${repo}/${branch}/${u.replace(/^\.?\//, '')}`;
    }
    // GitHub 自己的附件域(拖进 issue 的图/视频)也算,它们是真的演示。
    const isMotion = /\.(gif|mp4|webm|mov)(\?|$)/i.test(u)
      || /user-images\.githubusercontent\.com|github\.com\/user-attachments/i.test(u);
    const isStill = /\.(png|jpe?g|webp)(\?|$)/i.test(u);
    if (isMotion) return { url: u, motion: true };
    if (isStill && !cands.still) cands.still = u;
  }
  return cands.still ? { url: cands.still, motion: false } : null;
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
  return {
    demo: readmeDemo(md, owner, repo, branch),
    flow: { kind: entry.kind, entry: entry.entry || repo, cmds: entry.cmds },
    verbs: verbsOf(md, entry),
  };
}

module.exports = { probe, readmeDemo, entryPoints, verbsOf };
