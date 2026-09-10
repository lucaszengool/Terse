/**
 * github-city.js — 给一个**没有被 clone 过**的仓库盖一座代码城市。
 *
 * 广场上四十八个 GitHub 项目一座楼都没有,而城市是这个产品最像它自己的一层。
 * 原因很简单:`github-capsule.js` 从来不写 `dirs` —— 目录级的字节数和改动频率
 * 看起来非把仓库拉下来不可。
 *
 * ★ 但不用。`/git/trees/:branch?recursive=1` **每个 blob 都带 size**,一次调用就能
 * 把整棵树连大小一起拿到(实测 oryx:103 条目、79 个 blob、未截断)。于是楼高、
 * 占地、语言配比、退台深度全都是**精确的**,不是估的 —— 和 Mac 扫描器算的是同一件事,
 * 只是数据来自 API 而不是磁盘。
 *
 * 只有两样非要历史不可:**窗户亮不亮**(age_days)和**信标**(churn)。它们是
 * "这块代码还活着吗"那一整层意思,没有它们城市就只是一堆几何体。所以每个目录问一次
 * `/commits?path=<dir>` —— 一次调用同时给出这两样:第一条的日期是年龄,条数是改动量。
 *
 * ⚠ 认证是硬要求。一个仓库 ≈ 1 + 目录数 ≈ 15 次调用,而未认证的额度是**一小时 60 次**
 * —— 四个仓库就用光了。带 token 是 5000,四十八个仓库约 700 次,绰绰有余。
 * 没有 token 时这个模块**明说自己不干活**,而不是悄悄回一座空城:一座空城和
 * "城市坏了"在屏幕上一模一样。
 *
 * ⚠ `links`(楼与楼之间的耦合)这里**给不出来**,那要解析 import。留空是诚实的:
 * 座次会退回按体量排,地脉那一层不画 —— 少一层,而不是编一层。
 */

/* 扩展名 → 语言名。⚠ 名字必须和 src/renderer/lang-colors.js 的键**逐字对上**,
   否则颜色会退回灰色,而灰色的意思是"没认出来" —— 界面上是绿色的 shell,城市里
   不能变成灰的,那两处说的就不是同一件事了。 */
const EXT_LANG = {
  rs: 'rust', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'python', pyi: 'python', go: 'go', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  java: 'java', c: 'c', h: 'c', cc: 'c++', cpp: 'c++', cxx: 'c++', hpp: 'c++', hh: 'c++',
  rb: 'ruby', php: 'php', cs: 'c#', html: 'html', htm: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell',
  sql: 'sql',
};

/* 目录的用途。城市靠它决定形状和高度系数(厂房趴着、公园是平的),所以判据要
   贴着**约定俗成的目录名**,不是猜。认不出来就是 source —— 大多数目录确实是代码。 */
function kindOf(name) {
  const n = String(name || '').toLowerCase();
  if (/^(test|tests|spec|specs|__tests__|e2e|fixtures?)$/.test(n)) return 'test';
  if (/^(doc|docs|documentation|examples?|website|book)$/.test(n)) return 'docs';
  if (/^(asset|assets|static|public|images?|img|media|res|resources|fonts?|icons?)$/.test(n)) return 'assets';
  if (/^(config|configs|\.github|\.circleci|ci|scripts?|tools?|infra|deploy|k8s|docker)$/.test(n)) return 'config';
  return 'source';
}

/* 不该出现在城市里的东西。它们是**别人的代码**或者构建产物 —— 画进去,城市讲的
   就不是这个项目的故事了(Mac 扫描器同样跳过这些)。 */
const SKIP = /^(node_modules|vendor|third_party|\.git|dist|build|out|target|\.next|\.venv|venv|__pycache__|Pods|\.idea|\.vscode)$/i;

const langOf = (path) => EXT_LANG[String(path).split('.').pop().toLowerCase()] || '';

/**
 * 一棵树 → 一排楼。纯函数,不联网 —— 联网的部分在下面 `buildCity` 里。
 *
 * @param {{path:string,type:string,size:number}[]} tree  /git/trees?recursive=1 的 tree
 */
function dirsFromTree(tree) {
  const acc = new Map();
  let rootFiles = 0, rootBytes = 0;
  const rootLangs = new Map();

  for (const nd of (tree || [])) {
    if (!nd || nd.type !== 'blob') continue;
    const path = String(nd.path || '');
    const top = path.indexOf('/') < 0 ? '' : path.slice(0, path.indexOf('/'));
    if (top && SKIP.test(top)) continue;
    const bytes = Math.max(0, +nd.size || 0);
    const lang = langOf(path);

    /* 根目录下的散文件(README、package.json、main.go)不属于任何一座楼。
       它们**合成一座**叫仓库名的楼 —— 丢掉的话,一个只有 main.go 的小仓库
       会盖出一座空城。 */
    if (!top) {
      rootFiles++; rootBytes += bytes;
      if (lang) rootLangs.set(lang, (rootLangs.get(lang) || 0) + bytes);
      continue;
    }

    let d = acc.get(top);
    if (!d) { d = { name: top, files: 0, bytes: 0, langs: new Map(), depth: 1, kids: new Map(), tests: 0 }; acc.set(top, d); }
    d.files++; d.bytes += bytes;
    /* 测试文件。CodeCharta 把"缺测试"画成红楼 —— 那是城市隐喻里最常被问的一个问题
       ("这块有没有人兜底")。按**文件名约定**认:目录叫 test/spec,或文件名带
       .test. / _test. / .spec. / test_ 前缀。认得出多少算多少,认不出的不去猜。 */
    if (/(^|\/)(tests?|specs?|__tests__|e2e)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+$/i.test(path)) d.tests++;
    if (lang) d.langs.set(lang, (d.langs.get(lang) || 0) + bytes);
    // 退台看的是这块结构埋得多深。
    d.depth = Math.max(d.depth, path.split('/').length - 1);
    const rest = path.slice(top.length + 1);
    const kid = rest.indexOf('/') > 0 ? rest.slice(0, rest.indexOf('/')) : '';
    if (kid) {
      const k = d.kids.get(kid) || { files: 0, bytes: 0 };
      k.files++; k.bytes += bytes;
      d.kids.set(kid, k);
    }
  }

  const shape = (d) => {
    // 语言配比按**字节**算,不是按文件数:一个一千行的 .rs 比十个一行的 .json 更能
    // 说明这块是什么做的。
    const total = [...d.langs.values()].reduce((a, b) => a + b, 0) || 1;
    const langs = [...d.langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([l, b]) => [l, +(b / total).toFixed(3)]);
    return {
      name: d.name,
      files: d.files,
      bytes: d.bytes,
      lang: langs.length ? langs[0][0] : '',
      langs,
      kind: kindOf(d.name),
      depth: d.depth,
      // 测试文件占比(0..1)。test/ 目录本身当然是 1 —— 那座楼就是测试。
      tests: d.files ? +(d.tests / d.files).toFixed(3) : 0,
      kids: [...d.kids.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
        .map(([n, k]) => [n, k.files, k.bytes]),
    };
  };

  const out = [...acc.values()].map(shape);
  if (rootFiles) {
    const total = [...rootLangs.values()].reduce((a, b) => a + b, 0) || 1;
    out.push({
      name: '/', files: rootFiles, bytes: rootBytes,
      lang: [...rootLangs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      langs: [...rootLangs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([l, b]) => [l, +(b / total).toFixed(3)]),
      kind: 'source', depth: 1, kids: [],
    });
  }
  // 城市最多十六座 —— 按体量留下最大的那些,小的合不进去也不该挤进画面。
  return out.sort((a, b) => Math.max(b.bytes, b.files * 2000) - Math.max(a.bytes, a.files * 2000)).slice(0, 16);
}

/** 整个仓库的语言配比 —— 街面上那条图例用它。 */
function langsOfTree(tree) {
  const by = new Map();
  for (const nd of (tree || [])) {
    if (!nd || nd.type !== 'blob') continue;
    const top = String(nd.path).split('/')[0];
    if (top && SKIP.test(top) && String(nd.path).includes('/')) continue;
    const l = langOf(nd.path);
    if (l) by.set(l, (by.get(l) || 0) + Math.max(0, +nd.size || 0));
  }
  const total = [...by.values()].reduce((a, b) => a + b, 0) || 1;
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([l, b]) => [l, +(b / total).toFixed(3)]);
}

/**
 * 一座完整的城市。需要一个能发 API 的函数(调用方带着 token 和限流处理)。
 *
 * @param {(path:string)=>Promise<any>} api  发 /repos/... 的那个函数
 */
async function buildCity(api, owner, repo, branch, tree) {
  const dirs = dirsFromTree(tree);
  if (!dirs.length) return { dirs: [], langs: [] };

  /* 年龄和改动量:每个目录一次调用,一次给两样 —— 最新那条提交的日期是年龄,
     条数是改动量(封顶 100,再多也只是"很活跃")。
     ⚠ 拿不到就留 0,而 0 的意思是"不知道",城市那边会当成"没有先后可言"而不是
     "全都是今天新建的"—— 那个区别在 sampleCity 里是一整座空城。 */
  const now = Date.now();
  await Promise.all(dirs.map(async (d) => {
    d.age_days = 0; d.churn = 0;
    const p = d.name === '/' ? '' : `&path=${encodeURIComponent(d.name)}`;
    const list = await api(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=100${p}`);
    if (!Array.isArray(list) || !list.length) return;
    const when = list[0] && list[0].commit && list[0].commit.committer && list[0].commit.committer.date;
    if (when) d.age_days = Math.max(0, Math.round((now - Date.parse(when)) / 86400000));
    d.churn = list.length;
    /* 谁在写这一块。CoderCity 把楼按作者切段上色;这里给两个数,够城市用:
         authors  这段历史里有几个不同的人;
         owner    改动最多的那一个人占几成 —— 接近 1 就是"巴士因子 = 1":
                  这块代码只有一个人懂,他走了就没人懂了。
       ⚠ 只看最近 100 条提交(一次调用的上限),所以说的是"最近谁在管",不是"谁写的"。 */
    const who = new Map();
    for (const c of list) {
      const k = (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.email) || '';
      if (k) who.set(k, (who.get(k) || 0) + 1);
    }
    d.authors = who.size;
    d.owner = who.size ? +(Math.max(...who.values()) / list.length).toFixed(3) : 0;
  }));

  /* 仓库级的几件事:星、fork、许可证、年纪、有没有 CI。一次调用。
     这些不画进楼里 —— 它们说的是"这个项目在外面怎么样",放在城市下面那几行字里。 */
  let meta = null;
  try {
    const m = await api(`/repos/${owner}/${repo}`);
    if (m) {
      meta = {
        stars: +m.stargazers_count || 0,
        forks: +m.forks_count || 0,
        issues: +m.open_issues_count || 0,
        license: (m.license && m.license.spdx_id && m.license.spdx_id !== 'NOASSERTION') ? m.license.spdx_id : '',
        age_days: m.created_at ? Math.max(0, Math.round((now - Date.parse(m.created_at)) / 86400000)) : 0,
        ci: (tree || []).some((n) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(String(n.path || ''))),
      };
    }
  } catch (e) { if (e && e.message === 'rate-limited') throw e; }

  return { dirs, langs: langsOfTree(tree), meta };
}

module.exports = { buildCity, dirsFromTree, langsOfTree, kindOf, langOf, EXT_LANG };
