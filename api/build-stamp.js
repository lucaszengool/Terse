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

module.exports = { buildStamp, stampedFiles, phoneAssets, engineAssets, ENGINE_ASSETS, SHELLS };
