/**
 * github-room.js — 走进一座楼。挂在 /api/cloud/github/room(见 github-capsule.js)。
 *
 * 城市那一层只知道"文件名 + 字节"(git trees API)。走进楼里,每个文件是一件家具,
 * 文件里的每个符号(函数、类、类型、测试……)是家具上的一样东西 —— 这要读源码。
 *
 * ★ 整个仓库下载**一次**:codeload 的 tar.gz。它**不占 REST 配额**(和 repo-probe.js
 * 走 raw 是同一个道理),一个请求拿到全部内容,而逐个文件去 raw 取要几百次。
 * 下载是流式的:gunzip → 自己写的最小 tar 解析器 → 每个文件读完立刻抽出符号和
 * import,原文随即丢掉。缓存里只留**索引**(元数据 + 符号 + 出入度),不留源码。
 *
 * ★ **人永远不该等第二次下载。** 索引落盘(sqlite 的 room_index,gzip 的 JSON),重启还在;
 * 内存 LRU 挡在它前面。有缓存就立刻答,不管多旧 —— 旧过六小时就在**后台**用 git
 * smart-HTTP 问一句 HEAD 变了没有(不占配额):没变只刷新时间,变了才在后台重下重建。
 * 只有**从没见过**的仓库才让请求等。为了让这种情况少发生,三处提前预热:扫描之后、
 * 手机打开项目窗口时(/room/warm)、服务器启动时把广场上的 GitHub 项目挨个过一遍。
 *
 * ⚠ 全局最多同时下两个;排队时顺序是 人在楼门口(/room)> 手机预热 > 后台。
 * 同一个仓库的多个请求共用一个任务。
 *
 * ⚠ 符号是正则抽的,"够用就好"。它回答"这件家具上摆着什么",不是编译器。
 * 认不出来就少摆一样,不会编一样。
 */
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { langOf } = require('./github-city');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'terse-plaza';

const MAX_Z = 80 * 1024 * 1024;          // 压缩后超过这个 → 413
const MAX_RAW = 400 * 1024 * 1024;       // 解压后超过这个 → 413
const MAX_KEEP = 256 * 1024;             // 单文件超过这个就不读内容,只记大小(和行数)
const MAX_META = 1024 * 1024;            // pax / longname 头本身的上限 —— 正常只有几百字节
const TIMEOUT_MS = 30 * 1000;
const HEAD_TIMEOUT_MS = 10 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;     // 超过这个就在**后台**问一次 HEAD 变了没有 —— 请求照样立刻答
const NEG_404_MS = 60 * 60 * 1000;       // 记住"没有这个仓库"一小时
const NEG_413_MS = 24 * 60 * 60 * 1000;  // 记住"太大了"一天 —— 每次重新下 80MB 再说一遍太大,是在烧带宽
const RETRY_MS = 10 * 60 * 1000;         // 后台问 HEAD 失败了,十分钟内不再问
const MAX_ACTIVE = 2;                    // 全局最多同时下载两个仓库
const MAX_REPOS = 8;                     // 内存里最多留八个索引(LRU),其余在磁盘上
const MAX_FILES = 160;
const MAX_KIDS = 12;
const MAX_SYM = 24;
const MAX_EDGES = 600;

/* ⚠ 和 github-city.js 的 SKIP **逐字一致**(那边没导出它,这里抄一份)。改一边就要改另一边:
   城市里没有的楼,楼里也不该有家具。区别只有一处:城市只看顶层目录,这里看**每一段**
   —— packages/x/node_modules 在楼里同样是别人的代码。 */
const SKIP = /^(node_modules|vendor|third_party|\.git|dist|build|out|target|\.next|\.venv|venv|__pycache__|Pods|\.idea|\.vscode)$/i;

/* 读内容的扩展名。没有扩展名的(Makefile、LICENSE、.gitignore)也读 —— 读进来发现
   有 NUL 字节就当二进制(行数 0)。其余的只记大小。 */
const TEXT_EXT = new Set((
  'rs ts tsx mts cts js jsx mjs cjs py pyi go swift kt kts java c h cc cpp cxx hpp hh ' +
  'rb php cs html htm css scss sass less styl sh bash zsh fish ps1 sql ' +
  'md mdx markdown rst txt adoc json jsonc json5 yaml yml toml ini cfg conf env xml ' +
  'vue svelte astro prisma graphql gql proto csv tsv lock gradle cmake mk svg ' +
  'm mm scala lua dart ex exs erl hs ml r jl pl zig nim tf hcl el clj sol ejs hbs properties'
).split(' '));

const JS_EXT = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro']);
const CODE_EXT = new Set([...JS_EXT, 'py', 'pyi', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'kts', 'cs',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'scala', 'dart', 'graphql', 'gql', 'proto']);

const baseOf = (p) => String(p).slice(String(p).lastIndexOf('/') + 1);
const dirOf = (p) => { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
/** 扩展名(小写,不带点)。`.env` 这种点开头的整个名字不算扩展名。 */
function extOf(p) { const b = baseOf(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }

function fail(code, msg) { const e = new Error(msg); e.code = code; return e; }

/* ── tar ─────────────────────────────────────────────────────────────────── */

function cstr(h, off, len) {
  const end = h.indexOf(0, off);
  return h.toString('utf8', off, end < 0 || end > off + len ? off + len : end);
}
/** 数字字段:八进制文本,或者最高位置 1 的 base-256(GNU 的大文件写法)。 */
function tarNum(h, off, len) {
  if (h[off] & 0x80) {
    let n = h[off] & 0x7f;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + h[i];
    return n;
  }
  return parseInt(cstr(h, off, len).trim() || '0', 8) || 0;
}
/** 校验和:把 148..155 当成空格求和。⚠ 不校验的话,一张 HTML 错误页也会被当成
    tar"解析"出一堆乱码文件名 —— 那比直接报错难查得多。 */
function checksumOk(h) {
  const want = tarNum(h, 148, 8);
  let u = 0, s = 0;
  for (let i = 0; i < 512; i++) {
    const b = (i >= 148 && i < 156) ? 32 : h[i];
    u += b; s += b > 127 ? b - 256 : b;
  }
  return want === u || want === s;
}
/** pax 记录:"<字节长度> key=value\n"。⚠ 长度是**字节**,不是字符 —— 中文路径按
    字符切会切歪,所以在 Buffer 上切。 */
function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('ascii', i, sp), 10);
    if (!(len > 0) || i + len > buf.length) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * 增量 tar 解析器。数据一块块 push 进来(块多大都行,一个字节也行)。
 *
 * @param {(e:{path:string,size:number,data:Buffer|null,lines?:number})=>void} onFile  每个普通文件读完调一次
 * @param {(path:string,size:number)=>('keep'|'count'|'size'|null)} [want]
 *   keep = 留内容;count = 不留内容只数换行;size = 只记大小;null = 整个跳过(不回调)。
 *   不给就全部 keep(parseTar 用)。
 *
 * 认的类型:'0' / '\0' / '7' 普通文件;'L' GNU 长名;'x' pax(path、size);
 * 'g' 全局 pax 交给 onGlobal(git archive 在那里写 comment=<提交 sha>);其它类型(目录、
 * 链接)读过去就扔。路径**原样**给出,不去掉顶层目录。
 */
function tarParser(onFile, want, onGlobal) {
  let buf = Buffer.alloc(0);
  let cur = null;                 // 正在读的这一项
  let longName = null, pax = null;

  function header(h) {
    let zero = true;
    for (let i = 0; i < 512; i++) if (h[i]) { zero = false; break; }
    if (zero) return;             // 归档结尾的两个空块
    if (!checksumOk(h)) throw fail(502, 'Archive is not a tar file');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    let size = tarNum(h, 124, 12);
    if (type === 'L' || type === 'x' || type === 'g' || type === 'K') {
      cur = { meta: type, size, left: size + ((512 - size % 512) % 512), got: 0, parts: [], mode: size <= MAX_META ? 'keep' : 'size' };
    } else {
      const name = cstr(h, 0, 100);
      const ustar = h.toString('ascii', 257, 262) === 'ustar';
      const prefix = ustar ? cstr(h, 345, 155) : '';
      const path = (pax && pax.path) || longName || (prefix ? prefix + '/' + name : name);
      if (pax && pax.size != null && /^\d+$/.test(pax.size)) size = +pax.size;
      longName = pax = null;       // 只管紧跟着的下一项
      const file = type === '0' || type === '7';
      let mode = null;
      if (file) mode = want ? want(path, size) : 'keep';
      if (mode === 'keep' && size > MAX_KEEP && want) mode = 'count';
      cur = { path, size, file: file && mode != null, mode, left: size + ((512 - size % 512) % 512), got: 0, parts: [], nl: 0, last: 10 };
    }
  }

  function finish() {
    const c = cur; cur = null;
    if (c.meta) {
      if (c.mode !== 'keep') return;
      const d = Buffer.concat(c.parts);
      if (c.meta === 'L') longName = cstr(d, 0, d.length);
      else if (c.meta === 'x') pax = parsePax(d);
      else if (c.meta === 'g' && onGlobal) onGlobal(parsePax(d));
      return;
    }
    if (!c.file) return;
    const e = { path: c.path, size: c.size, data: c.mode === 'keep' ? Buffer.concat(c.parts) : null };
    if (c.mode === 'count') e.lines = c.nl + (c.size > 0 && c.last !== 10 ? 1 : 0);
    onFile(e);
  }

  function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (cur) {
        const n = Math.min(cur.left, buf.length);
        const dn = Math.max(0, Math.min(n, cur.size - cur.got));   // 其中真正是数据的那段(剩下的是补齐)
        if (dn) {
          const s = buf.subarray(0, dn);
          if (cur.mode === 'keep') cur.parts.push(s);
          else if (cur.mode === 'count') {
            for (let i = s.indexOf(10); i >= 0; i = s.indexOf(10, i + 1)) cur.nl++;
            cur.last = s[dn - 1];
          }
          cur.got += dn;
        }
        cur.left -= n; buf = buf.subarray(n);
        if (cur.left > 0) return;
        finish();
      } else {
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        header(h);
        if (cur && cur.left === 0) finish();
      }
    }
  }

  function end() { if (cur) throw fail(502, 'Archive ended in the middle of a file'); }
  return { push, end };
}

/** 整块 buffer 版本(测试用;流式那条路走的是同一个 tarParser)。 */
function parseTar(buffer) {
  const out = [];
  const t = tarParser((e) => out.push({ path: e.path, size: e.size, data: e.data }));
  t.push(buffer); t.end();
  return out;
}

/* ── 角色 ────────────────────────────────────────────────────────────────── */

const ENTRY_EXT = new Set([...JS_EXT, 'py', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'cs', 'html', 'dart']);
const ASSET_EXT = new Set('png jpg jpeg gif svg webp ico avif bmp tiff woff woff2 ttf otf eot mp3 mp4 wav ogg webm mov m4a flac pdf'.split(' '));
const LOCKS = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|uv\.lock|flake\.lock)$/;
const CONFIG_NAMES = /^(Dockerfile|Makefile|GNUmakefile|Procfile|Gemfile|Rakefile|Pipfile|go\.mod|requirements[\w.-]*\.txt|\.[\w.-]+rc|\.editorconfig|\.gitignore|\.gitattributes|\.dockerignore|\.npmignore|\.env[\w.-]*|\.nvmrc|CODEOWNERS)$/i;

/**
 * 这件家具是什么。**判断顺序就是优先级**,先中先得:
 *
 *   test → types → entry → hook → component → config → docs → style → asset → data → source
 *
 *   · test 最先:Button.test.tsx 首先是测试,其次才是 tsx;tests/ 下的 index.ts 也是测试。
 *   · types 在 entry 前:index.d.ts 是类型声明,不是入口。
 *   · entry 在 component 前:App.tsx 是入口。
 *   · config 在 docs 前:requirements.txt 是配置,不是文档。
 *   · types.* / models.* / schema.* 只认代码扩展名:types.json 是配置,schema.sql 是数据。
 */
function roleOf(path) {
  const p = String(path || '');
  const b = baseOf(p), ext = extOf(p), stem = b.replace(/\.[^.]*$/, '');
  const segs = p.split('/').slice(0, -1);

  if (/\.(test|spec)\.[\w]+$/i.test(b) || /_test\.go$/.test(b) || /^test_.*\.py$/.test(b) || /_test\.py$/.test(b)
      || segs.some((s) => /^(tests?|__tests__|specs?|e2e)$/i.test(s))) return 'test';
  if (/\.d\.[mc]?ts$/.test(b)) return 'types';
  if (CODE_EXT.has(ext) && (/^(types|interfaces|models|schema)$/i.test(stem) || /types$/i.test(stem) && /^[mc]?tsx?$/.test(ext))) return 'types';
  if (/^(lib|main|mod)\.rs$/.test(b) || /^__(init|main)__\.py$/.test(b)) return 'entry';
  if (ENTRY_EXT.has(ext) && /^(index|main|app|App|server|cli)$/.test(stem)) return 'entry';
  if (/^use[A-Z0-9]\w*\.(ts|js|tsx|jsx|mjs|mts)$/.test(b)) return 'hook';
  if (/^(tsx|jsx|vue|svelte)$/.test(ext) && /^[A-Z]/.test(b)) return 'component';
  if (/^(json|jsonc|json5|yaml|yml|toml|ini|cfg|conf|env|properties|lock)$/.test(ext) || /\.config\.[\w]+$/.test(b)
      || LOCKS.test(b) || CONFIG_NAMES.test(b)) return 'config';
  if (/^(md|mdx|markdown|rst|txt|adoc)$/.test(ext) || /^(LICENSE|LICENCE|COPYING|README|CHANGELOG|AUTHORS|NOTICE)$/i.test(stem) && !ext) return 'docs';
  if (/^(css|scss|sass|less|styl)$/.test(ext)) return 'style';
  if (ASSET_EXT.has(ext)) return 'asset';
  if (/^(sql|csv|tsv|prisma|jsonl|ndjson|parquet)$/.test(ext) || segs.some((s) => /^migrations?$/i.test(s))) return 'data';
  return 'source';
}

/* ── 符号 ────────────────────────────────────────────────────────────────── */

const LONG_LINE = 400;     // 比这长的行不跑声明正则 —— 多半是数据或压缩代码,而且正则会慢

const RX = {
  jsFn: /^(export\s+)?(default\s+)?(?:declare\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*[(<]/,
  jsClass: /^(export\s+)?(default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  jsIface: /^(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  jsType: /^(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<.*>)?\s*=/,
  jsEnum: /^(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  jsVar: /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/,
  jsFnish: /^(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|\(\s*$|\([^)]*$|[A-Za-z_$][\w$]*\s*=>|(?:React\.)?(?:memo|forwardRef)\s*[(<]|styled[.(])/,
  jsCjs: /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
  // ⚠ 不锚在行首、带 g:`describe('x', () => { it('y', …) })` 写成一行时两个都要。
  jsTest: /(?:^|[^\w$.])(?:describe|it|test|suite|context)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))*\s*\(\s*(['"`])((?:(?!\1).){1,200})\1/g,
  jsRoute: /\b[\w$]*(?:app|router|server|fastify|api|routes?)\.(get|post|put|patch|delete|del|all|use|head|options)\s*\(\s*(['"`])(\/[^'"`]*|\*)\2/i,
};

function jsSyms(ctx) {
  const { lines, add, full, ext } = ctx;
  const jsx = ext === 'tsx' || ext === 'jsx';
  const fnKind = (name) => /^use[A-Z0-9]/.test(name) ? 'hook' : (jsx && /^[A-Z]/.test(name) ? 'component' : 'fn');
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const t = raw.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    const ln = i + 1;
    let m;
    let tests = 0;
    RX.jsTest.lastIndex = 0;
    while ((m = RX.jsTest.exec(raw))) { add(m[2], 'test', ln, 0); tests++; }
    if (tests) continue;
    if ((m = RX.jsRoute.exec(raw))) { add(m[1].toUpperCase() + ' ' + m[3], 'route', ln, 0); continue; }
    if (raw !== raw.trimStart()) continue;                    // 声明只认顶格的
    if ((m = RX.jsFn.exec(t))) { const n = m[4] || (m[2] ? 'default' : ''); add(n, fnKind(n), ln, m[1]); continue; }
    if ((m = RX.jsClass.exec(t))) { add(m[3], 'class', ln, m[1]); continue; }
    if ((m = RX.jsIface.exec(t))) { add(m[2], 'type', ln, m[1]); continue; }
    if ((m = RX.jsType.exec(t))) { add(m[2], 'type', ln, m[1]); continue; }
    if ((m = RX.jsEnum.exec(t))) { add(m[2], 'type', ln, m[1]); continue; }
    if ((m = RX.jsCjs.exec(t))) { add(m[1], fnKind(m[1]), ln, 1); continue; }
    if ((m = RX.jsVar.exec(t))) {
      if (RX.jsFnish.test(m[3])) add(m[2], fnKind(m[2]), ln, m[1]);
      else if (m[1]) add(m[2], 'const', ln, 1);               // 没导出的常量不摆出来
    }
  }
  /* UMD / IIFE:整份文件包在 (function () { … })() 里,顶格一个声明都没有 —— expressjs/cors
     的 lib/index.js 就是这样,实测一个符号都抽不出来。那就退一步:包装层里**最浅**那一层
     缩进的 function 声明就是"顶层"。⚠ 用最浅的那层,不是固定的"≤ 4":两格缩进的文件里
     4 格已经是函数里的局部函数了。
     ⚠ 只在顶格一无所获时才退:正常文件里缩进的 function 是局部函数,不是家具上的东西。 */
  if (!ctx.out.some((s) => s[1] !== 'test' && s[1] !== 'route')) {
    const cand = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const ind = raw.length - raw.trimStart().length;
      if (!ind || ind > 8 || raw.length > LONG_LINE) continue;
      const fm = RX.jsFn.exec(raw.trim());
      if (fm && fm[4]) cand.push([ind, i + 1, fm[4]]);
    }
    const min = Math.min(...cand.map((c) => c[0]));
    for (const c of cand) if (c[0] === min) add(c[2], fnKind(c[2]), c[1], 0);
    ctx.out.sort((a, b) => a[2] - b[2]);
  }
  /* 事后补导出标记:`module.exports = { a, b }` 和 `export { a, b as c }` 写在文件末尾,
     声明那一行看不出来。⚠ 这个仓库自己的 api/*.js 全是这种写法。 */
  const names = new Set();
  const grab = (body) => body.split(',').forEach((s) => {
    const n = s.trim().split(/\s*:\s*|\s+as\s+/)[0].replace(/^\.\.\./, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
  });
  let m;
  const reObj = /module\.exports\s*=\s*\{([^}]*)\}/g;
  while ((m = reObj.exec(ctx.text))) grab(m[1]);
  const reEs = /^export\s*\{([^}]*)\}/gm;
  while ((m = reEs.exec(ctx.text))) grab(m[1]);
  const reOne = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
  while ((m = reOne.exec(ctx.text))) names.add(m[2]);
  const reDef = /^\s*(?:export\s+default|module\.exports\s*=)\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
  while ((m = reDef.exec(ctx.text))) names.add(m[1]);
  for (const s of ctx.out) if (names.has(s[0])) s[3] = 1;
}

function pySyms({ lines, add, full }) {
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const t = raw.trim();
    if (!t || t[0] === '#') continue;
    const top = raw === raw.trimStart();
    const ln = i + 1;
    let m;
    if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(t))) {
      if (/^test/.test(m[1])) add(m[1], 'test', ln, 0);      // 类里的 test_x 也算
      else if (top) add(m[1], 'fn', ln, m[1][0] !== '_');
      continue;
    }
    if (top && (m = /^class\s+([A-Za-z_]\w*)/.exec(t))) { add(m[1], 'class', ln, m[1][0] !== '_'); continue; }
    if ((m = /^@[\w.]*?\.(route|api_route|get|post|put|patch|delete|websocket)\(\s*(?:path\s*=\s*)?[rbuf]?(['"])([^'"]*)\2/.exec(t))) {
      add((/route$/.test(m[1]) ? '' : m[1].toUpperCase() + ' ') + m[3], 'route', ln, 0); continue;
    }
    if (top && (m = /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=(?!=)/.exec(t))) add(m[1], 'const', ln, 1);
  }
}

function goSyms({ lines, add, full, path }) {
  const testFile = /_test\.go$/.test(path);
  let inType = false;
  const up = (n) => /^[A-Z]/.test(n);
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const ln = i + 1;
    let m;
    if (inType) {
      if (/^\)/.test(raw)) { inType = false; continue; }
      if ((m = /^\s+([A-Za-z_]\w*)\s+(?:struct|interface|[\w.*[\]]+)/.exec(raw))) add(m[1], 'type', ln, up(m[1]));
      continue;
    }
    if ((m = /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/.exec(raw))) { add(m[1] + '.' + m[2], 'fn', ln, up(m[2])); continue; }
    if ((m = /^func\s+([A-Za-z_]\w*)/.exec(raw))) {
      add(m[1], testFile && /^(Test|Benchmark|Fuzz|Example)/.test(m[1]) ? 'test' : 'fn', ln, up(m[1])); continue;
    }
    if (/^type\s*\(/.test(raw)) { inType = true; continue; }
    if ((m = /^type\s+([A-Za-z_]\w*)/.exec(raw))) { add(m[1], 'type', ln, up(m[1])); continue; }
    if ((m = /^(?:const|var)\s+([A-Z]\w*)\b/.exec(raw))) { add(m[1], 'const', ln, 1); continue; }
    if ((m = /\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/.exec(raw))) {
      add((/^Handle/.test(m[1]) ? '' : m[1].toUpperCase() + ' ') + m[2], 'route', ln, 0);
    }
  }
}

function rustSyms({ lines, add, full }) {
  let pendingTest = false;
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const t = raw.trim();
    const top = raw === raw.trimStart();
    const ln = i + 1;
    let m;
    if (!t || t.startsWith('//')) continue;
    if ((m = /^#\[(get|post|put|patch|delete)\(\s*"([^"]*)"/.exec(t))) { add(m[1].toUpperCase() + ' ' + m[2], 'route', ln, 0); continue; }
    if (/^#\[(?:[\w:]+::)?test\b/.test(t)) { pendingTest = true; continue; }
    if (t.startsWith('#[')) continue;                         // 别的属性不打断 #[test]
    if ((m = /^(pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(t))) {
      if (pendingTest) add(m[2], 'test', ln, 0);
      else if (top) add(m[2], 'fn', ln, m[1]);
      pendingTest = false; continue;
    }
    pendingTest = false;
    if (!top) {
      if ((m = /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\b/.exec(t))) add(m[2].toUpperCase() + ' ' + m[1], 'route', ln, 0);
      continue;
    }
    if ((m = /^(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|type)\s+([A-Za-z_]\w*)/.exec(t))) { add(m[3], 'type', ln, m[1]); continue; }
    if ((m = /^pub(?:\([^)]*\))?\s+(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/.exec(t))) add(m[1], 'const', ln, 1);
  }
}

/** java / kotlin / c# / swift / scala —— 同一套"类型 + 方法"的形状。 */
function jvmSyms({ lines, add, full, ext }) {
  const kt = ext === 'kt' || ext === 'kts', sw = ext === 'swift';
  const isPub = (s) => kt ? !/\b(private|internal)\b/.test(s) : sw ? /\b(public|open)\b/.test(s) : /\bpublic\b/.test(s);
  let pendingTest = false;
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const t = raw.trim();
    const ln = i + 1;
    let m;
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (/^(@Test\b|@ParameterizedTest\b|\[(Fact|Theory|Test|TestMethod|TestCase)\b)/.test(t)) { pendingTest = true; continue; }
    if (t[0] === '@' || t[0] === '[') continue;
    if ((m = /^((?:(?:public|private|protected|internal|open|final|abstract|sealed|static|data|partial|fileprivate|inline|value|annotation|export|enum|inner|readonly)\s+)*)(class|interface|struct|enum|protocol|object|record|trait)\s+([A-Za-z_]\w*)/.exec(t))) {
      add(m[3], /^(class|object|record)$/.test(m[2]) ? 'class' : 'type', ln, isPub(m[1] || (kt ? '' : raw)));
      pendingTest = false; continue;
    }
    m = (kt && /^((?:[\w@]+\s+)*)fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(`[^`]+`|[A-Za-z_]\w*)/.exec(t))
      || (sw && /^((?:[\w@]+\s+)*)func\s+([A-Za-z_]\w*)/.exec(t))
      || (!kt && !sw && /^((?:(?:public|protected|private|internal|static|final|abstract|synchronized|async|override|virtual|sealed|native|default|extern|unsafe|new)\s+)+)(?:<[^>]+>\s+)?[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*\(/.exec(t));
    if (m) {
      const name = m[2].replace(/`/g, '');
      add(name, pendingTest || (sw && /^test/.test(name)) ? 'test' : 'fn', ln, isPub(m[1] || ''));
    }
    pendingTest = false;
  }
}

function cSyms({ lines, add, full }) {
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE || raw !== raw.trimStart()) continue;
    const t = raw.trim();
    const ln = i + 1;
    let m;
    if (!t || t[0] === '#' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    if ((m = /^(?:typedef\s+)?(struct|class|union|enum)(?:\s+class)?\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?:[:{]|$)/.exec(t))) {
      add(m[2], m[1] === 'class' ? 'class' : 'type', ln, 1); continue;
    }
    if (t.endsWith(';') || /^(if|for|while|switch|return|else|do|case|typedef|using|namespace|template|static_assert|extern\s+"C")\b/.test(t)) continue;
    /* 函数定义:前面至少有一个类型词,后面是名字和 "(",本行或下一行要有 "{"。
       ⚠ 类型词的字符集故意不含 * 和 & —— 两边字符集重叠会让正则回溯爆炸。 */
    if ((m = /^((?:[\w:<>,]+[\s*&]+)+)([A-Za-z_~][\w:~]*)\s*\(([^;]*)$/.exec(t))) {
      const next = (lines[i + 1] || '').trim();
      if (t.includes('{') || next.startsWith('{') || (t.endsWith(',') && !t.includes(')'))) {
        add(m[2], 'fn', ln, !/^static\b/.test(m[1]));
      }
    }
  }
}

function rubySyms({ lines, add, full }) {
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const ln = i + 1;
    let m;
    if ((m = /^\s*(?:describe|context|it|test|specify)\s*\(?\s*(['"])(.+?)\1/.exec(raw))) { add(m[2], 'test', ln, 0); continue; }
    if ((m = /^\s*(get|post|put|patch|delete)\s+['"](\/[^'"]*)['"]/.exec(raw))) { add(m[1].toUpperCase() + ' ' + m[2], 'route', ln, 0); continue; }
    if ((m = /^\s*(class|module)\s+([A-Z][\w:]*)/.exec(raw))) { add(m[2], 'class', ln, 1); continue; }
    if ((m = /^(\s*)def\s+(?:self\.)?(\w+[?!=]?)/.exec(raw)) && m[1].length <= 4) add(m[2], /^test_/.test(m[2]) ? 'test' : 'fn', ln, 1);
  }
}

function phpSyms({ lines, add, full }) {
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (raw.length > LONG_LINE) continue;
    const ln = i + 1;
    let m;
    if ((m = /Route::(get|post|put|patch|delete|any|match)\(\s*['"]([^'"]+)['"]/.exec(raw))) { add(m[1].toUpperCase() + ' ' + m[2], 'route', ln, 0); continue; }
    if ((m = /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(raw))) { add(m[2], m[1] === 'class' ? 'class' : 'type', ln, 1); continue; }
    if ((m = /^\s*((?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+&?([A-Za-z_]\w*)/.exec(raw))) {
      add(m[2], /^test/.test(m[2]) ? 'test' : 'fn', ln, !/private|protected/.test(m[1]));
    }
  }
}

function mdSyms({ lines, add, full }) {
  let fence = false;
  for (let i = 0; i < lines.length && !full(); i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (!m) continue;
    const txt = m[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').trim();
    if (txt) add(txt, 'heading', i + 1, 0);
  }
}

function sqlSyms({ text, add, ext }) {
  const re = ext === 'prisma'
    ? /^model\s+([A-Za-z_]\w*)/gm
    : /\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged|virtual)\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"[]?[\w.]+[`"\]]?)/gi;
  let m, line = 1, at = 0;
  while ((m = re.exec(text)) && at >= 0) {
    for (let i = text.indexOf('\n', at); i >= 0 && i < m.index; i = text.indexOf('\n', i + 1)) line++;
    at = m.index;
    add(m[1].replace(/[`"[\]]/g, ''), 'table', line, 0);
  }
}

function symParserFor(ext) {
  if (JS_EXT.has(ext)) return jsSyms;
  if (ext === 'py' || ext === 'pyi') return pySyms;
  if (ext === 'go') return goSyms;
  if (ext === 'rs') return rustSyms;
  if (/^(java|kt|kts|cs|swift|scala)$/.test(ext)) return jvmSyms;
  if (/^(c|h|cc|cpp|cxx|hpp|hh)$/.test(ext)) return cSyms;
  if (ext === 'rb') return rubySyms;
  if (ext === 'php') return phpSyms;
  if (/^(md|mdx|markdown)$/.test(ext)) return mdSyms;
  if (ext === 'sql' || ext === 'prisma') return sqlSyms;
  return null;
}

/**
 * 一个文件里的符号 → [[名字, 种类, 行号(从 1 起), 是否导出 1/0]],按出现顺序,最多 24 个。
 * 纯正则、不抛异常 —— 出了任何问题就把已经认出来的交出去。
 */
function symbolsOf(path, text) {
  const out = [];
  try {
    const s = String(text || '');
    if (!s || /\.min\.[a-z]+$/i.test(String(path))) return out;
    const ext = extOf(path);
    const fn = symParserFor(ext);
    if (!fn) return out;
    const lines = s.split(/\r?\n/);
    if (s.length / lines.length > 300) return out;          // 压缩过的一行文件,读不出东西
    const seen = new Set();
    const add = (name, kind, line, exp) => {
      const n = String(name || '').trim().slice(0, 40);
      if (!n || out.length >= MAX_SYM) return;
      const k = kind + '\0' + n;
      if (seen.has(k)) return;                              // 重载、同名测试只摆一次
      seen.add(k);
      out.push([n, kind, line, exp ? 1 : 0]);
    };
    fn({ lines, add, full: () => out.length >= MAX_SYM, text: s, ext, path: String(path), out });
  } catch (e) { /* 交出已经认出来的 */ }
  return out;
}

/* ── import ──────────────────────────────────────────────────────────────── */

/**
 * 一个文件 import 了什么 → 原样的说明符(去重)。rust 的 `mod x;` 记成 "mod x"。
 * 只抽,不解析 —— 解析在 resolveImport,它需要知道仓库里有哪些文件。
 */
function importsOf(path, text) {
  const out = new Set();
  try {
    const s = String(text || '');
    const ext = extOf(path);
    let m;
    const all = (re, g = 1, f = (x) => x) => { re.lastIndex = 0; while ((m = re.exec(s))) out.add(f(m[g])); };
    if (JS_EXT.has(ext)) {
      all(/(?:^|[^\w$.])(?:import|export)\s*(?:type\s+)?(?:[\w$*{}\s,]*?\s*from\s*)?['"]([^'"\n]+)['"]/g);
      all(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g);
      all(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g);
    } else if (/^(css|scss|sass|less)$/.test(ext)) {
      all(/@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/g);
    } else if (ext === 'py' || ext === 'pyi') {
      for (const line of s.split('\n')) {
        if ((m = /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+(.+)/.exec(line))) {
          if (/^\.+$/.test(m[1])) {
            // `from . import a, b` —— a、b 多半是同级模块
            m[2].replace(/[()\\]/g, '').split(',').forEach((x) => {
              const n = x.trim().split(/\s+as\s+/)[0];
              if (/^\w+$/.test(n)) out.add(m[1] + n);
            });
          } else out.add(m[1]);
        } else if ((m = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*$/.exec(line))) {
          m[1].split(',').forEach((x) => out.add(x.trim().split(/\s+as\s+/)[0]));
        }
      }
    } else if (ext === 'go') {
      all(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm);
      const blocks = /^import\s*\(([\s\S]*?)\)/gm;
      let b;
      while ((b = blocks.exec(s))) { const re = /"([^"]+)"/g; while ((m = re.exec(b[1]))) out.add(m[1]); }
    } else if (ext === 'rs') {
      all(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm, 1, (x) => 'mod ' + x);
      all(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|self)::[\w:]+)/gm);
    } else if (/^(c|h|cc|cpp|cxx|hpp|hh|m|mm)$/.test(ext)) {
      all(/^\s*#\s*(?:include|import)\s*"([^"]+)"/gm);
    } else if (ext === 'rb') {
      all(/^\s*require_relative\s*\(?\s*['"]([^'"]+)['"]/gm);
    }
  } catch (e) { /* 少几条边而已 */ }
  return [...out].filter(Boolean);
}

/** posix 拼路径,处理 . 和 ..。越过仓库根就是 null。 */
function joinPath(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const seg of String(rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

const JS_PROBE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];

function probeJs(base, set) {
  if (base == null) return null;
  if (set.has(base)) return base;
  // ESM 的 TS 写法:源码里写 './x.js',磁盘上是 x.ts
  const sw = /\.(m|c)?jsx?$/.exec(base);
  if (sw) {
    const stem = base.slice(0, -sw[0].length);
    for (const e of sw[1] === 'm' ? ['.mts'] : sw[1] === 'c' ? ['.cts'] : ['.ts', '.tsx']) if (set.has(stem + e)) return stem + e;
  }
  for (const e of JS_PROBE) if (set.has(base + e)) return base + e;
  for (const e of JS_PROBE) if (set.has(base + '/index' + e)) return base + '/index' + e;
  return null;
}

/**
 * 说明符 → 仓库里的一个文件路径,或者 null。只认**仓库内部**的边:
 *   js/ts/css  相对路径,补扩展名、补 /index.*;`@/x` `~/x` 当成 src/x(再退回根目录 x)
 *   python     相对的点号;绝对的 a.b 从本文件所在目录一路往上找 a/b.py
 *   c/c++      相对于本文件,再退回仓库根、include/、src/
 *   rust       `mod x;` 找同级的 x.rs / x/mod.rs;`crate::a::b` 从 crate 根找
 *   ruby       require_relative
 *   go 及其它   null(go 的包是目录,不是文件,硬连到某个文件是编的)
 * 裸包名(react、os、serde)一律 null —— 那是别人的代码。
 */
function resolveImport(fromPath, spec, fileSet) {
  try {
    const from = String(fromPath), s0 = String(spec || '');
    const ext = extOf(from);
    const dir = dirOf(from);
    const set = fileSet;
    if (JS_EXT.has(ext) || /^(css|scss|sass|less)$/.test(ext)) {
      const s = s0.replace(/[?#].*$/, '');
      if (/^\.\.?\//.test(s)) {
        const base = joinPath(dir, s);
        const hit = probeJs(base, set);
        if (hit || base == null) return hit;
        if (/^s[ac]ss$/.test(ext)) {                       // sass 的 _partial
          for (const e of ['.scss', '.sass', '.css']) {
            const p = joinPath(dirOf(base), '_' + baseOf(base) + e);
            if (set.has(p)) return p;
          }
          if (set.has(base + '.css')) return base + '.css';
        }
        return set.has(base + '.css') ? base + '.css' : null;
      }
      if (/^[@~]\//.test(s)) return probeJs('src/' + s.slice(2), set) || probeJs(s.slice(2), set);
      return null;
    }
    if (ext === 'py' || ext === 'pyi') {
      const dots = (/^\.+/.exec(s0) || [''])[0].length;
      const rest = s0.slice(dots).replace(/\./g, '/');
      const probe = (base) => {
        if (base == null) return null;
        if (rest && set.has(base + '.py')) return base + '.py';
        if (set.has((base ? base + '/' : '') + '__init__.py')) return (base ? base + '/' : '') + '__init__.py';
        return null;
      };
      if (dots) {
        let d = dir;
        for (let i = 1; i < dots; i++) { if (!d) return null; d = dirOf(d); }
        return probe(rest ? joinPath(d, rest) : d);
      }
      if (!rest) return null;
      for (let d = dir; ; d = dirOf(d)) {
        const hit = probe(d ? d + '/' + rest : rest);
        if (hit) return hit;
        if (!d) return null;
      }
    }
    if (/^(c|h|cc|cpp|cxx|hpp|hh|m|mm)$/.test(ext)) {
      for (const p of [joinPath(dir, s0), joinPath('', s0), joinPath('include', s0), joinPath('src', s0)]) if (p && set.has(p)) return p;
      return null;
    }
    if (ext === 'rs') {
      let m;
      if ((m = /^mod (\w+)$/.exec(s0))) {
        const b = baseOf(from);
        const d = /^(mod|lib|main)\.rs$/.test(b) ? dir : from.replace(/\.rs$/, '');
        for (const p of [joinPath(d, m[1] + '.rs'), joinPath(d, m[1] + '/mod.rs')]) if (set.has(p)) return p;
        return null;
      }
      if ((m = /^(crate|self)::([\w:]+)$/.exec(s0))) {
        let root;
        if (m[1] === 'self') root = /^(mod|lib|main)\.rs$/.test(baseOf(from)) ? dir : from.replace(/\.rs$/, '');
        else {
          for (let d = dir; ; d = dirOf(d)) {
            const pre = d ? d + '/' : '';
            if (set.has(pre + 'lib.rs') || set.has(pre + 'main.rs')) { root = d; break; }
            if (!d) return null;
          }
        }
        const segs = m[2].split('::').filter(Boolean);
        for (let n = segs.length; n > 0; n--) {
          const b = joinPath(root, segs.slice(0, n).join('/'));
          if (set.has(b + '.rs')) return b + '.rs';
          if (set.has(b + '/mod.rs')) return b + '/mod.rs';
        }
      }
      return null;
    }
    if (ext === 'rb') {
      const p = joinPath(dir, s0);
      if (p == null) return null;
      return set.has(p) ? p : set.has(p + '.rb') ? p + '.rb' : null;
    }
  } catch (e) { /* null */ }
  return null;
}

/* ── 索引 ────────────────────────────────────────────────────────────────── */

const isSkipped = (p) => p.split('/').some((s) => SKIP.test(s));
const isText = (p) => { const e = extOf(p); return !e || TEXT_EXT.has(e); };

/** 一个文件 → 索引里的一行。data 为 null 时只记大小(和流式数出来的行数)。 */
function fileMeta(path, size, data, lines) {
  const f = { p: path, b: size, l: 0, lang: langOf(path), role: roleOf(path), sym: [], imps: [] };
  if (data) {
    // 前 8KB 里有 NUL 就是二进制 —— 和 git 自己判断的办法一样
    if (data.subarray(0, 8000).indexOf(0) >= 0) return f;
    const text = data.toString('utf8');
    f.l = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    f.sym = symbolsOf(path, text);
    f.imps = importsOf(path, text);
  } else if (lines != null) f.l = lines;
  return f;
}

/** 流式和整块两条路共用的"收文件"逻辑:去掉归档顶层的 repo-sha/,跳过 SKIP,决定读不读内容。 */
function collector() {
  const files = [];
  const strip = (p) => { const i = p.indexOf('/'); return i < 0 ? '' : p.slice(i + 1); };
  const col = {
    files,
    sha: '',
    want(path, size) {
      const p = strip(path);
      if (!p || isSkipped(p)) return null;
      if (!isText(p)) return 'size';
      return size <= MAX_KEEP ? 'keep' : 'count';
    },
    onFile(e) { files.push(fileMeta(strip(e.path), e.size, e.data, e.lines)); },
    /* git archive 的全局 pax 头里写着 comment=<提交 sha>(实测和 info/refs 的 HEAD 一致)
       —— 下载本身就说明了这是哪个版本,不用再问一次。 */
    onGlobal(p) { const c = String((p && p.comment) || ''); if (/^[0-9a-f]{40,64}$/.test(c)) col.sha = c; },
  };
  return col;
}

/**
 * 文件行 → 带出入度和边的索引。只算**解析得到的仓库内部边**,同一对文件只算一次。
 * 每个文件多一个 `to`:它 import 的那些文件在 files 里的下标(升序)—— 房间里的 edges 由它来。
 * ⚠ 存下标不存路径:vite 两千八百个文件,路径再存一遍就是几百 KB。
 * @param {{p:string,b:number,l:number,lang:string,role:string,sym:any[],imps?:string[]}[]} files
 */
function buildIndex(files) {
  const pos = new Map(files.map((f, i) => [f.p, i]));
  const set = new Set(pos.keys());
  const inn = new Map();
  for (const f of files) {
    const outs = new Set();
    for (const s of f.imps || []) {
      const r = resolveImport(f.p, s, set);
      if (r && r !== f.p) outs.add(r);
    }
    f.out = outs.size;
    f.to = [...outs].map((p) => pos.get(p)).sort((a, b) => a - b);
    for (const r of outs) inn.set(r, (inn.get(r) || 0) + 1);
    delete f.imps;
  }
  for (const f of files) f.imp = inn.get(f.p) || 0;
  return { v: INDEX_V, at: Date.now(), files };
}

/** 一整个 tar.gz(Buffer)→ 索引。不联网;测试和离线工具用,流式那条路共用 collector。 */
function indexArchive(gz) {
  const col = collector();
  const t = tarParser(col.onFile, col.want, col.onGlobal);
  t.push(zlib.gunzipSync(gz)); t.end();
  const idx = buildIndex(col.files);
  idx.sha = col.sha;
  return idx;
}

/* ── 联网 ────────────────────────────────────────────────────────────────── */

/* 可以换掉的依赖。测试里换成假的 fetch / 时钟 / 存储 —— 不联网,不碰真库。 */
const deps = { fetch: (...a) => globalThis.fetch(...a), now: () => Date.now(), store: null, maxActive: MAX_ACTIVE };
/** 换依赖:{ fetch, now, store, maxActive }。 */
function configure(o) { Object.assign(deps, o || {}); return deps; }

function ghHeaders() {
  const h = { 'User-Agent': UA };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}

async function fetchArchive(owner, repo, signal) {
  /* codeload 是 github.com/archive 重定向过去的地方,直接打它省一跳。它不行再走
     github.com 那条(跟着重定向)—— 私有仓库带 token 时走的是后者。 */
  const urls = [
    `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`,
    `https://github.com/${owner}/${repo}/archive/HEAD.tar.gz`,
  ];
  let status = 0;
  for (const u of urls) {
    const res = await deps.fetch(u, { headers: ghHeaders(), redirect: 'follow', signal });
    if (res.ok && res.body) return res;
    status = res.status;
    try { await res.body?.cancel(); } catch (e) { /* 不要了 */ }
  }
  throw status === 404 ? fail(404, 'No such repository') : fail(502, 'GitHub said ' + status);
}

/** 下载 + 流式解析一个仓库 → 索引(带 sha)。30 秒总时限,压缩 80MB / 解压 400MB 封顶。 */
async function indexRepo(owner, repo, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS);
  const tooBig = () => fail(413, 'That repository is too large to walk into');
  try {
    const res = await fetchArchive(owner, repo, ac.signal);
    if ((+res.headers.get('content-length') || 0) > MAX_Z) { try { await res.body.cancel(); } catch (e) { /* */ } throw tooBig(); }
    const col = collector();
    const tar = tarParser(col.onFile, col.want, col.onGlobal);
    let z = 0, raw = 0;
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (src) { for await (const c of src) { z += c.length; if (z > MAX_Z) throw tooBig(); yield c; } },
      zlib.createGunzip(),
      async function (src) { for await (const c of src) { raw += c.length; if (raw > MAX_RAW) throw tooBig(); tar.push(c); } },
      { signal: ac.signal },
    );
    tar.end();
    const idx = buildIndex(col.files);
    idx.sha = col.sha;
    return idx;
  } catch (e) {
    if (e && (e.code === 404 || e.code === 413)) throw e;
    if (ac.signal.aborted) throw fail(502, 'GitHub took too long to send that repository');
    throw fail(502, 'Could not read that repository' + (e && e.message ? ' (' + e.message + ')' : ''));
  } finally { clearTimeout(timer); }
}

/**
 * info/refs 的 pkt-line → HEAD 的 sha。
 *   "001e# service=git-upload-pack\n" "0000" "<长度><sha> HEAD\0<能力…>\n" …
 * 返回 sha;'' = 第一条 ref 不是 HEAD(空仓库);undefined = 字节还不够,再读。
 */
function headOf(buf) {
  let i = 0;
  while (i + 4 <= buf.length) {
    const n = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (Number.isNaN(n)) return '';
    if (n === 0) { i += 4; continue; }                    // flush
    if (n < 4) return '';
    if (i + n > buf.length) return undefined;
    const line = buf.toString('utf8', i + 4, i + n);
    i += n;
    if (line.startsWith('#')) continue;
    const m = /^([0-9a-f]{40,64}) ([^\0\n]+)/.exec(line);
    return m && m[2] === 'HEAD' && !/^0+$/.test(m[1]) ? m[1] : '';
  }
  return undefined;
}

/** 现在的 HEAD 是哪个提交。git smart-HTTP,**不占 REST 配额**;读到第一条 ref 就挂断
    —— torvalds/linux 的整张 refs 表有 250KB,我们只要头两百字节。
    ⚠ 仓库不存在时 GitHub 回的是 **401**(它在叫你登录),不是 404。 */
async function headSha(owner, repo) {
  const res = await deps.fetch(`https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`,
    { headers: ghHeaders(), redirect: 'follow', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
  if (res.status === 401 || res.status === 404) {
    try { await res.body?.cancel(); } catch (e) { /* */ }
    throw fail(404, 'No such repository');
  }
  if (!res.ok || !res.body) throw fail(502, 'GitHub said ' + res.status);
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf = Buffer.concat([buf, Buffer.from(value)]);
      const h = headOf(buf);
      if (h !== undefined) return h;
      if (done || buf.length > 64 * 1024) return '';
    }
  } finally { try { await reader.cancel(); } catch (e) { /* 挂断 */ } }
}

/* ── 磁盘 ────────────────────────────────────────────────────────────────── */

/* 和其它表同一个 sqlite 文件(db.js 导出了 db 句柄)。表建在这里而不是 db.js:它是一份
   **随时可以扔掉的缓存** —— 整张表删掉,代价只是下一个人等一次下载,不丢任何人的数据。
   gz 是索引(元数据 + 符号 + 出入度)的 gzip JSON,**永远没有源码原文**。
   err ≠ 0 的行是"记住的失败"(404 / 413),gz 为空。时间都是毫秒。 */
function sqliteStore() {
  const { db } = require('./db');
  db.exec(`CREATE TABLE IF NOT EXISTS room_index (
    repo TEXT PRIMARY KEY,
    sha TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    gz BLOB,
    err INTEGER NOT NULL DEFAULT 0,
    msg TEXT NOT NULL DEFAULT ''
  )`);
  const get = db.prepare('SELECT * FROM room_index WHERE repo = ?');
  const peek = db.prepare('SELECT repo, sha, fetched_at, checked_at, size, err FROM room_index WHERE repo = ?');
  const put = db.prepare(`INSERT INTO room_index (repo, sha, fetched_at, checked_at, size, gz, err, msg)
    VALUES (@repo, @sha, @fetched_at, @checked_at, @size, @gz, @err, @msg)
    ON CONFLICT(repo) DO UPDATE SET sha = excluded.sha, fetched_at = excluded.fetched_at,
      checked_at = excluded.checked_at, size = excluded.size, gz = excluded.gz, err = excluded.err, msg = excluded.msg`);
  const touch = db.prepare('UPDATE room_index SET checked_at = ? WHERE repo = ?');
  return {
    get: (k) => get.get(k),
    peek: (k) => peek.get(k),
    put: (row) => put.run(row),
    touch: (k, at) => touch.run(at, k),
  };
}
function store() { if (!deps.store) deps.store = sqliteStore(); return deps.store; }
/* 磁盘出了错不能让请求答不出来 —— 缓存坏了就当没有缓存。 */
function safe(fn) {
  try { return fn(); } catch (e) { console.error('[room] index store:', e.message); return null; }
}

/* 索引格式的版本。改了 fileMeta / buildIndex 的字段就加一。v2 加了 to(边)。
   ⚠ 旧版本的行**照样立刻拿来答**(少一层边而已),同时在后台按新格式重建 —— 人不等。 */
const INDEX_V = 2;
function encode(idx) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ v: INDEX_V, at: idx.at, sha: idx.sha || '', files: idx.files })));
}
function decode(gz) {
  if (!gz) return null;
  const o = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  return o && o.v >= 1 && o.v <= INDEX_V && Array.isArray(o.files) ? { v: o.v, at: o.at, sha: o.sha || '', files: o.files } : null;
}

/* ── 内存 + 新鲜度 ──────────────────────────────────────────────────────── */

const keyOf = (owner, repo) => (owner + '/' + repo).toLowerCase();
const negTtl = (code) => code === 413 ? NEG_413_MS : NEG_404_MS;

/* 内存:key → { sha, fetchedAt, checkedAt, idx, err, msg, tryAt }。Map 的插入顺序就是新旧。 */
const mem = new Map();
function remember(key, e) {
  mem.delete(key); mem.set(key, e);
  while (mem.size > MAX_REPOS) mem.delete(mem.keys().next().value);
}
const negLive = (e) => !!e.err && deps.now() - e.checkedAt < negTtl(e.err);
/** 该不该在后台看一眼:旧过六小时,或者是旧格式的索引。 */
const needsCheck = (e) => deps.now() - e.checkedAt > STALE_MS || !!(e.idx && e.idx.v !== INDEX_V);

/** 内存里有就用内存的,没有就从磁盘读上来(并放进内存)。都没有 → null。 */
function lookup(key) {
  const hit = mem.get(key);
  if (hit) { remember(key, hit); return hit; }
  const row = safe(() => store().get(key));
  if (!row) return null;
  let e;
  if (row.err) e = { sha: '', fetchedAt: row.fetched_at, checkedAt: row.checked_at, idx: null, err: row.err, msg: row.msg };
  else {
    const idx = safe(() => decode(row.gz));
    if (!idx) return null;
    e = { sha: row.sha, fetchedAt: row.fetched_at, checkedAt: row.checked_at, idx, err: 0 };
  }
  remember(key, e);
  return e;
}

/** 有没有**能用的**缓存(成功的,或者还没过期的失败)。不解压 —— 启动预热用它跳过。 */
function isCached(key) {
  const e = mem.get(key);
  if (e) return !e.err || negLive(e);
  const row = safe(() => store().peek(key));
  return !!row && (!row.err || deps.now() - row.checked_at < negTtl(row.err));
}

function save(key, e, gz, keepInMemory) {
  if (keepInMemory) remember(key, e); else mem.delete(key);
  safe(() => store().put({
    repo: key, sha: e.sha || '', fetched_at: e.fetchedAt, checked_at: e.checkedAt,
    size: gz ? gz.length : 0, gz: gz || null, err: e.err || 0, msg: e.msg || '',
  }));
}

/* ── 下载队列 ──────────────────────────────────────────────────────────────── */

/* 优先级:人站在楼门口 > 手机刚打开项目窗口 > 后台(启动预热、过期重验)。 */
const PRI = { room: 3, warm: 2, bg: 1 };
const jobs = new Map();          // key → job(排队中或在跑)
const queue = [];                // 还没开始的 job
const bg = new Set();            // 所有在飞的后台 promise —— 测试用 _idle() 等它们
let active = 0, seq = 0;

function track(p) { bg.add(p); p.then(() => bg.delete(p), () => bg.delete(p)); return p; }

function schedule(key, pri, run) {
  const have = jobs.get(key);
  if (have) { if (pri > have.pri) have.pri = pri; return have.promise; }   // 同一个仓库共用一个任务,顺带提级
  const job = { key, pri, run, seq: seq++, started: false };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  job.promise.catch(() => {});   // 没人等的后台任务失败了,不能变成 unhandledRejection
  track(job.promise);
  jobs.set(key, job);
  queue.push(job);
  pump();
  return job.promise;
}

function pump() {
  while (active < deps.maxActive && queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i], b = queue[bi];
      if (a.pri > b.pri || (a.pri === b.pri && a.seq < b.seq)) bi = i;
    }
    const job = queue.splice(bi, 1)[0];
    job.started = true;
    active++;
    Promise.resolve().then(job.run).then(job.resolve, job.reject)
      .finally(() => { active--; jobs.delete(job.key); pump(); });
  }
}

/**
 * 下载 + 建索引 + 落盘,排进队列。
 * ⚠ 失败时如果手上已经有一份好的索引,**留着它**(只把 checked_at 往后推,免得每个请求都
 * 重下一遍 80MB);只有从没成功过的仓库才把 404 / 413 记下来。
 */
function download(owner, repo, pri, keepInMemory = true) {
  const key = keyOf(owner, repo);
  return schedule(key, pri, async () => {
    try {
      const idx = await indexRepo(owner, repo);
      const t = deps.now();
      const e = { sha: idx.sha || '', fetchedAt: t, checkedAt: t, idx, err: 0 };
      save(key, e, encode(idx), keepInMemory || mem.has(key));
      return e;
    } catch (err) {
      const t = deps.now();
      const prev = mem.get(key);
      const row = prev ? null : safe(() => store().peek(key));
      if ((prev && !prev.err) || (row && !row.err)) {
        if (prev) prev.checkedAt = t;
        safe(() => store().touch(key, t));
      } else if (err.code === 404 || err.code === 413) {
        save(key, { sha: '', fetchedAt: t, checkedAt: t, idx: null, err: err.code, msg: err.message }, null, true);
      }
      throw err;
    }
  });
}

const reval = new Map();         // key → 正在进行的后台重验
/** 后台重验:问 HEAD;没变就刷新时间,变了就排一个后台下载。永远不让请求等。 */
function revalidate(owner, repo, key, e) {
  const t = deps.now();
  if (reval.has(key) || jobs.has(key) || (e.tryAt && t - e.tryAt < RETRY_MS)) return;
  e.tryAt = t;
  const p = (async () => {
    // 旧格式的索引:不用问 HEAD,sha 一样也得按新格式重建一次。
    const upgrade = !!(e.idx && e.idx.v !== INDEX_V);
    let head = '';
    if (!upgrade) {
      try { head = await headSha(owner, repo); } catch (x) { return; }   // 问不到就下次再问,旧的照用
    }
    const cur = mem.get(key) || e;
    if (!upgrade && head && head === cur.sha) {
      const now = deps.now();
      cur.checkedAt = now;
      safe(() => store().touch(key, now));
      return;
    }
    await download(owner, repo, PRI.bg, mem.has(key)).catch(() => {});
  })().finally(() => reval.delete(key));
  reval.set(key, p);
  track(p);
}

/**
 * 一个仓库的索引。有缓存(不管多旧)就立刻给;旧了顺手在后台重验。
 * 只有从没见过的仓库(或者记住的失败已经过期)才等下载。
 */
async function getIndex(owner, repo, opts = {}) {
  const key = keyOf(owner, repo);
  const e = lookup(key);
  if (e && !e.err) {
    if (needsCheck(e)) revalidate(owner, repo, key, e);
    return e.idx;
  }
  if (e && negLive(e)) throw fail(e.err, e.msg || 'Could not read that repository');
  return (await download(owner, repo, opts.priority || PRI.room)).idx;
}

/** 预热:不等,只说现在是什么状态。'cached' | 'warming'(在下)| 'queued'(在排队)。 */
function warm(owner, repo, pri = PRI.warm) {
  const key = keyOf(owner, repo);
  const j = jobs.get(key);
  if (j) { if (pri > j.pri) j.pri = pri; return j.started ? 'warming' : 'queued'; }
  const e = lookup(key);
  if (e && !e.err) {
    if (needsCheck(e)) revalidate(owner, repo, key, e);
    return 'cached';
  }
  if (e && negLive(e)) return 'cached';
  download(owner, repo, pri);
  const nj = jobs.get(key);
  return nj && nj.started ? 'warming' : 'queued';
}

/** 等所有后台的事做完 —— 只给测试和离线脚本用。 */
async function idle() { while (bg.size) await Promise.allSettled([...bg]); }

/* ── 启动预热 ──────────────────────────────────────────────────────────────── */

/** "owner/name" 或者一条 github.com 的链接 → { owner, repo };别的都是 null。 */
function repoOf(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)/i.exec(s) || /^([^/\s]+)\/([^/\s]+)$/.exec(s);
  if (!m) return null;
  const owner = m[1], repo = m[2].replace(/\.git$/i, '');
  const okName = (n) => /^[A-Za-z0-9_.-]{1,100}$/.test(n) && !/^\.+$/.test(n);
  return okName(owner) && okName(repo) ? { owner, repo } : null;
}

/**
 * 启动时把广场上的 GitHub 项目挨个索引一遍,新发布的先来,最多 200 个,**一次一个**,
 * 中间歇一会儿;已经有缓存的跳过。排在最低优先级,人一来就让路。
 * ⚠ 只由 server.js 在 listen 之后调用 —— require 这个文件不会启动它。
 *
 * @param {{list?:()=>{capsule:string|object}[], delayMs?:number, startDelayMs?:number, max?:number}} [opts]
 * @returns {{stop:()=>void, done:Promise<number>}}  done 给出这一轮真正下载了几个
 */
function startWarmer(opts = {}) {
  const delay = opts.delayMs == null ? 4000 : opts.delayMs;
  const max = opts.max || 200;
  const list = opts.list || (() => require('./db').listWallProjects.all({ limit: 1000 }));
  let stopped = false;
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  const done = (async () => {
    // 让启动先把自己的事做完(清垃圾帖、种子数据),再开始占带宽。
    await sleep(opts.startDelayMs == null ? 15000 : opts.startDelayMs);
    let rows = [];
    try { rows = list() || []; } catch (e) { console.error('[room] warmer: cannot list projects:', e.message); return 0; }
    const seen = new Set(), todo = [];
    for (const row of rows) {
      let cap = row && row.capsule;
      if (typeof cap === 'string') { try { cap = JSON.parse(cap); } catch (e) { continue; } }
      const r = repoOf(cap && (cap.link || (cap.source && cap.source.url)));
      if (!r || !/github\.com/i.test(String((cap && (cap.link || (cap.source && cap.source.url))) || ''))) continue;
      const k = keyOf(r.owner, r.repo);
      if (seen.has(k)) continue;
      seen.add(k); todo.push(r);
      if (todo.length >= max) break;
    }
    let n = 0;
    for (const r of todo) {
      if (stopped) break;
      if (isCached(keyOf(r.owner, r.repo))) continue;
      // ⚠ 不放进内存:两百个仓库挨个过,会把人正在逛的那几个挤出 LRU。它们在磁盘上就够了。
      try { await download(r.owner, r.repo, PRI.bg, false); } catch (e) { /* 下一个 */ }
      n++;
      if (delay) await sleep(delay);
    }
    if (n) console.log(`[room] warmer: indexed ${n} of ${todo.length} plaza repos`);
    return n;
  })();
  return { stop() { stopped = true; }, done };
}

/* ── 一个房间 ─────────────────────────────────────────────────────────────── */

/**
 * 索引 + 楼名 → 房间。纯函数。
 *
 * 楼名是一个顶层目录名;没有哪个顶层目录叫这个名字(或者给的是 '' / '/'),就是
 * **根目录下的散文件** —— github-city 把它们合成一座楼,那座楼叫 '/'(胶囊那边叫 'root')。
 * 带斜杠的子路径(src/components)也照前缀认,顺手的事。
 * 什么都没有 → null(→ 404)。
 */
function roomOf(index, dir) {
  const d = String(dir == null ? '' : dir).replace(/^\/+|\/+$/g, '');
  const all = (index && index.files) || [];
  const pre = d + '/';
  let picked = d ? all.filter((f) => f.p.startsWith(pre)) : [];
  const root = !picked.length;
  if (root) picked = all.filter((f) => f.p.indexOf('/') < 0);
  if (!picked.length) return null;

  const kids = new Map();
  const subOf = (f) => { const rest = root ? f.p : f.p.slice(pre.length); return rest.indexOf('/') > 0 ? rest.slice(0, rest.indexOf('/')) : ''; };
  for (const f of picked) {
    const sub = subOf(f);
    if (sub) { const k = kids.get(sub) || [sub, 0, 0]; k[1]++; k[2] += f.b; kids.set(sub, k); }
  }
  picked.sort((a, b) => b.b - a.b || (a.p < b.p ? -1 : 1));
  const kept = picked.slice(0, MAX_FILES);
  /* 边:[i, j] = files[i] import 了 files[j],下标是**这份响应**里的。两头都得在列表里 ——
     被 160 截掉的文件没有家具,指向它的线没有地方落。按 (i, j) 排好,最多 600 条。
     旧格式的索引(v1,没有 to)给空数组,不猜。 */
  const at = new Map(kept.map((f, i) => [f, i]));
  const edges = [];
  kept.forEach((f, i) => {
    const js = [];
    for (const t of f.to || []) { const j = at.get(all[t]); if (j !== undefined && j !== i) js.push(j); }
    js.sort((a, b) => a - b);
    for (const j of js) edges.push([i, j]);
  });
  return {
    dir: root ? '/' : d,
    root,
    truncated: picked.length > MAX_FILES,
    total: picked.length,
    kids: [...kids.values()].sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_KIDS),
    files: kept.map((f) => ({ n: baseOf(f.p), p: f.p, sub: subOf(f), b: f.b, l: f.l, lang: f.lang, role: f.role, sym: f.sym, imp: f.imp || 0, out: f.out || 0 })),
    edges: edges.slice(0, MAX_EDGES),
  };
}

/* HTTP 缓存。同一个 sha 的同一座楼永远是同一份响应,所以 ETag = sha + 楼。
   ⚠ ROOM_V 是响应格式的版本:改了 roomOf / fileMeta 的输出就加一,旧 ETag 全部作废 ——
   否则手机会拿着 304 继续用旧形状的数据。
   v2:加了 edges。索引的版本也算进去 —— 同一个 sha,旧格式索引答出来的(没有边)和
   重建之后的(有边)必须是两个 ETag,否则手机拿着没有边的那份会一直被 304。 */
const ROOM_V = 2;
const CACHE_CONTROL = 'public, max-age=600, stale-while-revalidate=86400';
function etagOf(idx, dir) {
  const h = crypto.createHash('sha1').update(`${ROOM_V}\0${idx.v || 1}\0${dir}`).digest('hex').slice(0, 10);
  return `"${String(idx.sha || 't' + idx.at).slice(0, 16)}-${h}"`;
}
function etagMatches(inm, tag) {
  if (!inm) return false;
  return String(inm).split(',').some((s) => { const t = s.trim().replace(/^W\//, ''); return t === '*' || t === tag; });
}

// GET /api/cloud/github/room?repo=owner/name&dir=src
async function handler(req, res) {
  const q = req.query || {};
  const r = repoOf(q.repo);
  if (!r) return res.status(400).json({ error: 'repo must look like owner/name' });
  const dir = typeof q.dir === 'string' ? q.dir : q.dir == null ? '' : null;
  if (dir == null || dir.length > 300 || /(^|\/)\.\.(\/|$)|[\0-\x1f]/.test(dir)) return res.status(400).json({ error: 'Bad dir' });
  try {
    const idx = await getIndex(r.owner, r.repo);
    const room = roomOf(idx, dir);
    if (!room) return res.status(404).json({ error: 'No such directory in that repository' });
    const tag = etagOf(idx, room.dir);
    res.set('ETag', tag);
    res.set('Cache-Control', CACHE_CONTROL);
    if (etagMatches((req.headers || {})['if-none-match'], tag)) return res.status(304).end();
    res.json(Object.assign({ ok: true, repo: `${r.owner}/${r.repo}`, sha: idx.sha || '' }, room));
  } catch (e) {
    res.status(e && (e.code === 404 || e.code === 413) ? e.code : 502)
       .json({ error: (e && e.message) || 'Could not read that repository' });
  }
}

// POST /api/cloud/github/room/warm {repo}   (也收 GET ?repo=)→ 202,**从不等下载**
// 手机在项目窗口一打开就调它 —— 离有人走进楼门大约还有二十秒,够把索引备好。
function warmHandler(req, res) {
  const r = repoOf((req.body && req.body.repo) || (req.query && req.query.repo));
  if (!r) return res.status(400).json({ error: 'repo must look like owner/name' });
  const state = warm(r.owner, r.repo);
  const body = { ok: true, state };
  const e = mem.get(keyOf(r.owner, r.repo));
  if (e && e.err && negLive(e)) body.err = e.err;   // 记住的 404 / 413:手机可以不画那扇门
  res.status(202).json(body);
}

module.exports = {
  handler, warmHandler, warm, startWarmer, configure,
  roomOf, getIndex, indexRepo, indexArchive, buildIndex, fileMeta,
  parseTar, tarParser, roleOf, symbolsOf, importsOf, resolveImport,
  headOf, headSha, repoOf, etagOf, encode, decode,
  _mem: mem, _store: store, _idle: idle, _stats: () => ({ active, queued: queue.length, jobs: jobs.size }),
};
