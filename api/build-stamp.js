/**
 * build-stamp.js — 一个版本号,盖住**这一页真正会去下载的每一个文件**。
 *
 * 为什么存在,见 api/cache.test.js 的开头:CDN 拿着六个半小时前的 /phone/*.js
 * 不放,cf-cache-status: HIT。源站的头改不动已经存下的那一条,能改的只有 URL ——
 * 新的一版就是新的地址,没有旧条目可命中。
 *
 * ⚠ 而这个文件之所以被单拆出来,是因为那条规则**已经被写错过两次**,两次都是
 * 同一个形状:名单是手写的,而页面在长。
 *
 *   第一次是引擎。戳只由 landing/ 下那六个文件算出来,可真正画东西的粒子引擎在
 *   src/renderer,走 /app-assets 送出去。于是每一个渲染器的修复都带着**没变的戳**
 *   发布 —— 地址没变,Cloudflare 和手机接着发旧引擎。修好了、部署了、永远取不到。
 *
 *   第二次是这一轮自己:广场长出了 social.js / frames.js / plaza-field.js /
 *   tunes.js 四个新脚本,m.html 一直在加载它们,而名单一个都没加。也就是说
 *   frames.js —— 刚写完的那个采样器 —— 改了也不会换地址。
 *
 * 所以名单不再手写:**从 HTML 里读出来**。页面加载什么,戳就盖什么,加一个
 * <script> 就自动进名单,再也没有"记得去改那个数组"这一步。手写只剩引擎里那几个
 * **被别的模块 import 进去的**文件 —— 它们不出现在任何 HTML 里,只能列。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 会被扫描的页面。app 本体和 float 那一页各自加载各自的一套脚本。 */
const SHELLS = ['m.html', 'float.html'];

/* 引擎里**没有任何 HTML 提到**的那些:它们是被 mineradio-wallpaper.js 用 ES
   import 拉进去的(shaders / 项目层 / 城市配色 / 语言配色)。扫描看不见,只能手列。
   直接被 <script> 或 import() 点名的那几个由下面的扫描兜住,不必在这里重复,
   重复了也不会错 —— 去重是按路径做的。 */
const ENGINE_ASSETS = [
  'mineradio-wallpaper.js', 'mineradio-shaders.js', 'wallpaper-project.js',
  'wallpaper-styles.js', 'wallpaper-view3d.js', 'wallpaper-hud.js',
  'city-styles.js', 'lang-colors.js', 'rooms.js',
];

/** 一段文本里所有 `/phone/xxx.js`。src="" 和 import() 都是这个形状。 */
function refsIn(text, prefix) {
  const out = [];
  const re = new RegExp(prefix.replace(/\//g, '\\/') + '([A-Za-z0-9._-]+\\.js)', 'g');
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function readShells() {
  return SHELLS.map((f) => {
    try { return fs.readFileSync(path.join(ROOT, 'landing', f), 'utf8'); }
    catch { return ''; }
  }).join('\n');
}

/**
 * app 自己的代码,相对 landing/。
 *
 * sw.js 是手加的一个:它不是被 <script> 引进来的,是 navigator.serviceWorker
 * 注册的,而它恰恰是最要命的一个 —— 一个过期的 service worker 会用自己那份过期
 * 缓存去答复其余所有文件,一个旧副本就把整个 app 钉在它发布时的那一版上。
 */
function phoneAssets() {
  const seen = new Set(['sw.js']);
  for (const rel of refsIn(readShells(), '/phone/')) seen.add('phone/' + rel);
  return [...seen].sort();
}

/** 引擎,相对 src/renderer。手列的 + HTML/app.js 里点过名的。 */
function engineAssets() {
  const seen = new Set(ENGINE_ASSETS);
  let appjs = '';
  try { appjs = fs.readFileSync(path.join(ROOT, 'landing', 'phone', 'app.js'), 'utf8'); }
  catch { /* app.js 读不到时,手列的那份仍然成立 */ }
  // vendor/ 排除在外:three.module.min.js 是四分之三兆,几乎不变,而且它在
  // importmap 里,换地址要连 importmap 一起换。
  for (const rel of refsIn(readShells() + '\n' + appjs, '/app-assets/')) seen.add(rel);
  return [...seen].sort();
}


/* ── 把版本号写进引擎**自己**的 import 里 ─────────────────────────────────
   app.js 给它 import 的东西都挂了 ?v=<build>,所以 mineradio-wallpaper.js 每次都是
   新的。可它接着用**裸相对路径**去 import 自己的模块 ——
   `import { ProjectLayer } from './wallpaper-project.js'` —— 那个地址永远不变。

   ⚠ 实测:部署完几分钟后源站已经是新文件,而边缘还在发一份 `age: 2518` 的旧的,
   `max-age` 写着 300。这就是那个会无视源站头的 CDN TTL 覆盖,`/phone/*.js` 上
   量到过 age 23435。从源站这边**没有任何一个头**能改变它。

   能改变的只有地址:新的一版就是新的地址,没有旧条目可命中。所以在**发出去的
   那一刻**把这些 specifier 重写掉。这是同一个形状的第四次 —— 戳漏了引擎、漏了手机
   自己的脚本、service worker 又坐在两者前面 —— 而这一次补的是唯一一个从外面够不到
   的地方。 */

/** 只改**相对**且以 .js 结尾的 specifier:裸的 'three' 必须继续走 importmap,
 *  已经带查询串的原样不动。 */
const IMPORT_SPECIFIER = /(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.\/[A-Za-z0-9._-]+\.js)(['"])/g;

function stampImports(text, build) {
  if (typeof text !== 'string' || !build) return text;
  return text.replace(IMPORT_SPECIFIER, (m, a, spec, b) => `${a}${spec}?v=${build}${b}`);
}

/** 参与计算的全部文件,`{base, rel}` —— 测试拿它去和页面对账。 */
function stampedFiles() {
  return [
    ...phoneAssets().map((rel) => ({ base: 'landing', rel })),
    ...engineAssets().map((rel) => ({ base: path.join('src', 'renderer'), rel })),
  ];
}

/** 大小 + mtime 折成一个短字符串。文件变了它就变,不变就不变。 */
function buildStamp() {
  let acc = 0;
  for (const { base, rel } of stampedFiles()) {
    try {
      const st = fs.statSync(path.join(ROOT, base, rel));
      acc = (acc * 31 + st.size + Math.floor(st.mtimeMs)) >>> 0;
    } catch { /* 缺的文件就是不贡献,不是错误 */ }
  }
  return acc.toString(36);
}

module.exports = { buildStamp, stampedFiles, phoneAssets, engineAssets, ENGINE_ASSETS, SHELLS, stampImports, IMPORT_SPECIFIER };
