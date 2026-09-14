/**
 * room-furniture.js — 房间里摆什么:**一件家具就是一个文件,家具上的一件东西就是
 * 文件里的一个符号。**
 *
 * 房间是目录(room-interior.js 的 layoutOf),这里管屋里的陈设。两条规矩:
 *
 *   一,**家具的种类说的是这个文件在干什么**(role),不是它用什么语言写的。入口是屋子
 *     尽头那座主案、测试是一张实验台、文档是书架、类型定义是一张摊着图纸的绘图桌 ——
 *     不看字,光看家具就知道这个文件在这个目录里扮演什么。
 *   二,**家具上的每一件东西都是一个真的符号**:一个函数一本书、一个类一只箱子、一个
 *     测试一只烧瓶。没有符号数据(老胶囊、还没深扫过的项目)就只摆家具、不摆东西 ——
 *     一格空书架的意思是"还不知道",一排编出来的书是撒谎。
 *
 * 颜色照旧分两层:家具是**房子的料**(风格调色板里的木、石、描金),家具上的东西是
 * **它的语言色**。一只蓝箱子放在朱红博古架上,说的是"TypeScript 写的类,住在唐宋的
 * 房子里",两件事互不打架。
 *
 * ⚠ 词不在这里翻译(和 wallpaper-project.js 同一条规矩):这里只给英文兜底,宿主把
 * 翻好的词传给 room-scene。
 */

import { mix } from './room-interior.js';

const TAU = Math.PI * 2;

/* ── 文件在干什么 ──────────────────────────────────────────────────────────
   ⚠ 服务端 api/github-room.js 有同一套判据(深扫时给 role),这里是**没有深扫数据
   时的兜底**,只看文件名。两份判据由测试对账,顺序也要一样:测试先于一切(
   Button.test.tsx 是测试,不是组件),入口先于组件(App.tsx 是入口)。 */
const JS_EXT = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro'];
const CODE_EXT = new Set([...JS_EXT, 'py', 'pyi', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'kts', 'cs',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'scala', 'dart', 'graphql', 'gql', 'proto']);
const ENTRY_EXT = new Set([...JS_EXT, 'py', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'cs', 'html', 'dart']);
const ASSET_EXT = new Set('png jpg jpeg gif svg webp ico avif bmp tiff woff woff2 ttf otf eot mp3 mp4 wav ogg webm mov m4a flac pdf'.split(' '));
const LOCKS = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|uv\.lock|flake\.lock)$/;
const CONFIG_NAMES = /^(Dockerfile|Makefile|GNUmakefile|Procfile|Gemfile|Rakefile|Pipfile|go\.mod|requirements[\w.-]*\.txt|\.[\w.-]+rc|\.editorconfig|\.gitignore|\.gitattributes|\.dockerignore|\.npmignore|\.env[\w.-]*|\.nvmrc|CODEOWNERS)$/i;

/** 和 api/github-room.js 的 roleOf **逐条同序**的移植 —— 测试把两边对着跑。
 *  @param {string} name 文件名   @param {string} [sub] 它在这座楼里的哪个子目录(可以多层) */
export function roleOfName(name, sub = '') {
  const b = String(name || '');
  const i = b.lastIndexOf('.');
  const ext = i > 0 ? b.slice(i + 1).toLowerCase() : '';
  const stem = b.replace(/\.[^.]*$/, '');
  const segs = String(sub || '').split('/').filter(Boolean);
  if (/\.(test|spec)\.[\w]+$/i.test(b) || /_test\.go$/.test(b) || /^test_.*\.py$/.test(b) || /_test\.py$/.test(b)
      || segs.some((s) => /^(tests?|__tests__|specs?|e2e)$/i.test(s))) return 'test';
  if (/\.d\.[mc]?ts$/.test(b)) return 'types';
  if (CODE_EXT.has(ext) && (/^(types|interfaces|models|schema)$/i.test(stem) || (/types$/i.test(stem) && /^[mc]?tsx?$/.test(ext)))) return 'types';
  if (/^(lib|main|mod)\.rs$/.test(b) || /^__(init|main)__\.py$/.test(b)) return 'entry';
  if (ENTRY_EXT.has(ext) && /^(index|main|app|App|server|cli)$/.test(stem)) return 'entry';
  if (/^use[A-Z0-9]\w*\.(ts|js|tsx|jsx|mjs|mts)$/.test(b)) return 'hook';
  if (/^(tsx|jsx|vue|svelte)$/.test(ext) && /^[A-Z]/.test(b)) return 'component';
  if (/^(json|jsonc|json5|yaml|yml|toml|ini|cfg|conf|env|properties|lock)$/.test(ext) || /\.config\.[\w]+$/.test(b)
      || LOCKS.test(b) || CONFIG_NAMES.test(b)) return 'config';
  if (/^(md|mdx|markdown|rst|txt|adoc)$/.test(ext) || (/^(LICENSE|LICENCE|COPYING|README|CHANGELOG|AUTHORS|NOTICE)$/i.test(stem) && !ext)) return 'docs';
  if (/^(css|scss|sass|less|styl)$/.test(ext)) return 'style';
  if (ASSET_EXT.has(ext)) return 'asset';
  if (/^(sql|csv|tsv|prisma|jsonl|ndjson|parquet)$/.test(ext) || segs.some((s) => /^migrations?$/i.test(s))) return 'data';
  return 'source';
}

/** 一种文件用途 → 一种家具,以及它愿意站在哪儿。
 *  wall = 靠墙(柜、架、画),floor = 屋子中间(台、案、架),center = 尽头正中。 */
export const ROLE = {
  entry:     { furn: 'dais',       place: 'center' },
  component: { furn: 'vitrine',    place: 'floor' },
  hook:      { furn: 'hookRack',   place: 'floor' },
  test:      { furn: 'labBench',   place: 'floor' },
  types:     { furn: 'draftTable', place: 'floor' },
  config:    { furn: 'console',    place: 'wall' },
  docs:      { furn: 'bookshelf',  place: 'wall' },
  style:     { furn: 'easel',      place: 'floor' },
  asset:     { furn: 'painting',   place: 'wall' },
  data:      { furn: 'drawers',    place: 'wall' },
  source:    { furn: 'cabinet',    place: 'wall' },
  archive:   { furn: 'archive',    place: 'wall' },
};
export const ROLES = Object.keys(ROLE);

/** 一种符号 → 家具上的一件东西。图标给图例和卡片用 —— 屏幕上的形状和图例里的图标
 *  必须是同一件东西,图例才是图例。 */
export const ITEM_ICON = {
  fn: '📕', class: '🧰', type: '📜', test: '🧪', component: '🗿', hook: '🏮',
  route: '🔔', const: '🏺', heading: '📘', table: '🗄️',
};
export const ROLE_ICON = {
  entry: '⛩️', component: '🗄️', hook: '🪝', test: '⚗️', types: '📐', config: '🎛️',
  docs: '📚', style: '🎨', asset: '🖼️', data: '🗃️', source: '🗂️', archive: '📦',
};

/** 英文兜底。宿主(手机 app)传自己翻好的一份进来覆盖。 */
export const WORDS_EN = {
  role_entry: 'Entry point', furn_entry: 'the dais at the far end',
  role_component: 'UI component', furn_component: 'a glass display case',
  role_hook: 'Hook', furn_hook: 'a hook rack',
  role_test: 'Tests', furn_test: 'a lab bench',
  role_types: 'Type definitions', furn_types: 'a drafting table',
  role_config: 'Configuration', furn_config: 'a control console',
  role_docs: 'Documentation', furn_docs: 'a bookshelf',
  role_style: 'Styles', furn_style: "a painter's easel",
  role_asset: 'Asset', furn_asset: 'a framed picture',
  role_data: 'Data / schema', furn_data: 'a chest of drawers',
  role_source: 'Source code', furn_source: 'a cabinet',
  role_archive: 'Smaller files', furn_archive: 'an archive rack',
  item_fn: 'function', item_class: 'class', item_type: 'type', item_test: 'test case',
  item_component: 'component', item_hook: 'hook', item_route: 'route', item_const: 'constant',
  item_heading: 'section', item_table: 'table',
  shape_fn: 'book', shape_class: 'chest', shape_type: 'scroll', shape_test: 'flask',
  shape_component: 'figurine', shape_hook: 'lantern', shape_route: 'bell', shape_const: 'jar',
  shape_heading: 'volume', shape_table: 'drawer',
};

/* ══ 局部坐标系 ═══════════════════════════════════════════════════════════
   每件家具在自己的坐标里画:u 朝右、y 朝上、v 朝前(朝着看它的人)。(fx, fz) 是
   正面朝向。所以"靠墙的柜子开口朝屋里"只是换一个朝向,不是换一套画法。 */
function kit(o, e) {
  const { X, Z, fx, fz, rnd, dens } = o;
  const P = (u, y, v, c, s, g) => e(X + fz * u + fx * v, y, Z - fx * u + fz * v, c, s, g ? 0.8 : 0.12, g || 0);
  const W = (u, y, v) => [X + fz * u + fx * v, y, Z - fx * u + fz * v];
  const R = (a, b) => a + rnd() * (b - a);
  const area = (a, b) => Math.max(1, Math.round(a * b * dens));
  /** 一块平面。v0 === v1 是立面,y0 === y1 是水平面。 */
  const plane = (u0, u1, y0, y1, v0, v1, c, s, n) => {
    const m = n || area(Math.abs(u1 - u0), Math.max(Math.abs(y1 - y0), Math.abs(v1 - v0)));
    for (let i = 0; i < m; i++) P(R(u0, u1), R(y0, y1), R(v0, v1), c, s);
  };
  const line = (a, b, c, s, g, n) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const m = n || Math.max(4, Math.round(len * dens * 0.16));
    for (let i = 0; i < m; i++) { const t = rnd(); P(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, c, s, g); }
  };
  /** 方盒的十二条棱 —— 家具读得清不清,靠的就是这一圈描边。 */
  const edges = (u0, u1, y0, y1, v0, v1, c, s, g) => {
    for (const y of [y0, y1]) for (const v of [v0, v1]) line([u0, y, v], [u1, y, v], c, s, g);
    for (const u of [u0, u1]) for (const v of [v0, v1]) line([u, y0, v], [u, y1, v], c, s, g);
    for (const u of [u0, u1]) for (const y of [y0, y1]) line([u, y, v0], [u, y, v1], c, s, g);
  };
  const cyl = (cu, cv, r, y0, y1, c, s, g, n) => {
    const m = n || area(TAU * r, Math.abs(y1 - y0));
    for (let i = 0; i < m; i++) { const a = rnd() * TAU; P(cu + Math.cos(a) * r, R(y0, y1), cv + Math.sin(a) * r, c, s, g); }
  };
  const disc = (cu, cv, r, y, c, s, g, n) => {
    const m = n || area(Math.PI * r, r);
    for (let i = 0; i < m; i++) { const a = rnd() * TAU, q = Math.sqrt(rnd()) * r; P(cu + Math.cos(a) * q, y, cv + Math.sin(a) * q, c, s, g); }
  };
  const ball = (cu, y, cv, r, c, s, g, n) => {
    const m = n || area(4 * Math.PI * r, r);
    for (let i = 0; i < m; i++) {
      const z = rnd() * 2 - 1, a = rnd() * TAU, q = Math.sqrt(1 - z * z);
      P(cu + Math.cos(a) * q * r, y + z * r, cv + Math.sin(a) * q * r, c, s, g);
    }
  };
  return { P, W, R, plane, line, edges, cyl, disc, ball, rnd };
}

/* ══ 家具上的东西:一个符号一件 ════════════════════════════════════════════
   每件返回自己顶上那一点(局部坐标),标签和高亮挂在那儿。s 是缩放,1 ≈ 25cm 高。
   hi = 导出的符号:它是这个文件给别人用的那一面,所以带一道亮边。 */
const dark = (c, k = 0.55) => [c[0] * k, c[1] * k, c[2] * k];
const GILT = [1, 0.86, 0.5];
export const ITEM = {
  /** 函数 = 一本书。书脊朝外,一格书架上一排,正是一个文件里一串函数的样子。 */
  fn(k, u, y, v, s, col, hi) {
    const w = 0.055 * s, h = 0.24 * s, d = 0.17 * s;
    k.plane(u - w / 2, u + w / 2, y, y + h, v, v, col, 0.55, 26);
    k.plane(u - w / 2, u + w / 2, y + h, y + h, v - d, v, dark(col), 0.5, 8);
    if (hi) k.line([u - w / 2, y + h * 0.82, v + 0.004], [u + w / 2, y + h * 0.82, v + 0.004], GILT, 0.45, 2, 5);
    return [u, y + h, v];
  },
  /** 类 = 一只箱子:它装着自己的方法,正像箱子装东西。 */
  class(k, u, y, v, s, col, hi) {
    const w = 0.28 * s, h = 0.17 * s, d = 0.2 * s;
    k.plane(u - w / 2, u + w / 2, y, y + h, v, v, col, 0.6, 40);
    k.plane(u - w / 2, u + w / 2, y + h, y + h, v - d, v, dark(col, 0.7), 0.6, 26);
    k.line([u - w / 2, y + h * 0.7, v + 0.004], [u + w / 2, y + h * 0.7, v + 0.004], dark(col, 0.35), 0.45, 0, 10);
    if (hi) k.ball(u, y + h * 0.55, v + 0.01, 0.018 * s, GILT, 0.45, 2, 8);
    return [u, y + h, v];
  },
  /** 类型 = 一卷图纸:它不做事,它规定东西长什么样。 */
  type(k, u, y, v, s, col, hi) {
    const L = 0.26 * s, r = 0.035 * s;
    for (let i = 0; i < 40; i++) { const a = k.rnd() * TAU; k.P(u + (k.rnd() - 0.5) * L, y + r + Math.sin(a) * r, v - r + Math.cos(a) * r, col, 0.5); }
    for (const sgn of [-1, 1]) k.ball(u + sgn * L / 2, y + r, v - r, r * 0.8, hi ? GILT : dark(col), 0.45, hi ? 2 : 0, 8);
    return [u, y + r * 2, v];
  },
  /** 测试 = 一只烧瓶:一次实验,结果装在瓶子里。 */
  test(k, u, y, v, s, col, hi) {
    const r = 0.07 * s;
    k.ball(u, y + r, v, r, [0.75, 0.85, 0.9], 0.4, 0, 30);
    k.ball(u, y + r * 0.8, v, r * 0.6, col, 0.5, 2, 14);                 // 瓶里的液体 —— 这件东西的颜色
    k.cyl(u, v, r * 0.28, y + r * 1.8, y + r * 3, [0.75, 0.85, 0.9], 0.35, 0, 10);
    return [u, y + r * 3, v];
  },
  /** 组件 = 一尊小像:一块界面,单独立在那儿给人看。 */
  component(k, u, y, v, s, col, hi) {
    const r = 0.045 * s;
    k.cyl(u, v, r, y, y + 0.12 * s, col, 0.5, 0, 22);
    k.ball(u, y + 0.12 * s + r, v, r * 0.85, col, 0.5, hi ? 2 : 0, 16);
    k.disc(u, v, r * 1.5, y + 0.005, dark(col), 0.45, 0, 8);
    return [u, y + 0.2 * s, v];
  },
  /** hook = 一盏小灯笼,挂在钩子上(钩子架上挂 hook,字面意思)。 */
  hook(k, u, y, v, s, col, hi) {
    const r = 0.06 * s;
    k.line([u, y, v], [u, y - 0.1 * s, v], [0.3, 0.3, 0.3], 0.35, 0, 5);
    k.ball(u, y - 0.1 * s - r, v, r, col, 0.55, 2, 22);
    return [u, y, v];
  },
  /** 路由 = 一只铃:外面有人敲门,它就响。 */
  route(k, u, y, v, s, col, hi) {
    const r = 0.07 * s;
    for (let i = 0; i < 34; i++) { const a = k.rnd() * TAU, t = k.rnd(); k.P(u + Math.cos(a) * r * (0.35 + t * 0.65), y + (1 - t) * r * 1.3, v + Math.sin(a) * r * (0.35 + t * 0.65), col, 0.5); }
    k.ball(u, y - 0.01, v, r * 0.25, GILT, 0.4, 2, 5);
    return [u, y + r * 1.3, v];
  },
  /** 导出的常量 = 一只罐子:装好了,放在那儿给人取。 */
  const(k, u, y, v, s, col, hi) {
    const r = 0.05 * s;
    k.cyl(u, v, r, y, y + 0.1 * s, col, 0.5, 0, 22);
    k.cyl(u, v, r * 0.7, y + 0.1 * s, y + 0.12 * s, dark(col), 0.45, 0, 8);
    return [u, y + 0.12 * s, v];
  },
  /** 文档里的一节 = 一册书,比函数那本厚。 */
  heading(k, u, y, v, s, col, hi) { return ITEM.fn(k, u, y, v, s * 1.25, col, hi); },
  /** 数据表 = 一格抽屉:一张表,拉开就是一行行记录。 */
  table(k, u, y, v, s, col, hi) {
    const w = 0.3 * s, h = 0.1 * s;
    k.plane(u - w / 2, u + w / 2, y, y + h, v, v, col, 0.5, 30);
    k.line([u - w * 0.15, y + h / 2, v + 0.01], [u + w * 0.15, y + h / 2, v + 0.01], GILT, 0.4, 2, 6);
    return [u, y + h, v];
  },
};
/** 一件东西在架子上占多宽(局部单位,s=1)。 */
const ITEM_W = { fn: 0.07, heading: 0.09, class: 0.32, type: 0.3, test: 0.17, component: 0.13, hook: 0.16, route: 0.17, const: 0.13, table: 0.34 };

/** 在一层层架子上从左往右摆东西。放不下的就不摆 —— 调用方已经按重要程度排好了。 */
function shelve(k, items, levels, u0, u1, v, s, lang) {
  const slots = [];
  let li = 0, u = u0;
  for (let i = 0; i < items.length && li < levels.length; i++) {
    const it = items[i], w = (ITEM_W[it.kind] || 0.12) * s;
    if (u + w > u1) { li++; u = u0; if (li >= levels.length) break; }
    const draw = ITEM[it.kind] || ITEM.fn;
    const top = draw(k, u + w / 2, levels[li], v, s, lang, it.exported);
    slots.push({ at: k.W(top[0], top[1], top[2]), sym: it });
    u += w + 0.015 * s;
  }
  return slots;
}

/* ══ 家具:一个文件一件 ════════════════════════════════════════════════════
   o: { X, Z, fx, fz, w, h, items:[{name,kind,line,exported}], lang, mat:{wood,stone,trim},
        rnd, dens, extra } —— 返回 { slots, top }。尺寸由调用方按文件大小给好。 */
export const FURN = {
  /** 柜子(一般源文件):开口朝外的多层柜,一格格放着它定义的东西。 */
  cabinet(o, e) {
    const k = kit(o, e), { w, h } = o, d = 0.42, m = o.mat;
    k.plane(-w / 2, w / 2, 0, h, -d, -d, dark(m.wood, 0.6), 0.9);          // 背板
    for (const sgn of [-1, 1]) k.plane(sgn * w / 2, sgn * w / 2, 0, h, -d, 0, m.wood, 0.9);
    k.plane(-w / 2, w / 2, h, h, -d, 0, m.wood, 0.9);
    const n = Math.max(2, Math.round(h / 0.36));
    const levels = [];
    for (let i = 0; i < n; i++) {
      const y = 0.08 + i * (h - 0.12) / n;
      k.plane(-w / 2, w / 2, y, y, -d, 0, dark(m.wood, 0.85), 0.8);
      levels.push(y + 0.01);
    }
    k.edges(-w / 2, w / 2, 0, h, -d, 0, m.trim, 0.8);
    const slots = shelve(k, o.items, levels, -w / 2 + 0.04, w / 2 - 0.04, -0.06, 1, o.lang);
    return { slots, top: k.W(0, h + 0.3, 0) };
  },
  /** 书架(文档):比柜子高、窄、更深一点。一节是一册书。 */
  bookshelf(o, e) {
    const r = FURN.cabinet(Object.assign({}, o, { h: Math.max(o.h, 1.6) }), e);
    return r;
  },
  /** 玻璃展柜(界面组件):一块界面就是一尊立在玻璃后面给人看的小像。 */
  vitrine(o, e) {
    const k = kit(o, e), { w, h } = o, d = 0.5, m = o.mat;
    const glass = [0.55, 0.7, 0.78];
    k.plane(-w / 2, w / 2, 0, 0.5, -d, 0, dark(m.wood, 0.7), 0.9);             // 底座
    k.edges(-w / 2, w / 2, 0.5, h, -d, 0, m.trim, 0.7);
    for (const v of [0, -d]) k.plane(-w / 2, w / 2, 0.5, h, v, v, glass, 0.35, Math.round(w * (h - 0.5) * o.dens * 0.12));
    const levels = [0.52, 0.52 + (h - 0.5) / 2];
    k.plane(-w / 2, w / 2, levels[1], levels[1], -d, 0, glass, 0.4, Math.round(w * d * o.dens * 0.3));
    const slots = shelve(k, o.items, levels, -w / 2 + 0.05, w / 2 - 0.05, -d / 2, 1.2, o.lang);
    return { slots, top: k.W(0, h + 0.3, 0) };
  },
  /** 钩子架(hook):一根立柱两条横臂,每个 hook 是挂在上面的一盏小灯笼。 */
  hookRack(o, e) {
    const k = kit(o, e), h = Math.max(1.5, o.h), m = o.mat, arm = Math.max(0.5, o.w / 2);
    k.cyl(0, 0, 0.045, 0, h, m.wood, 0.7, 0, Math.round(h * 90));
    k.disc(0, 0, 0.3, 0.01, dark(m.wood), 0.7);
    const slots = [];
    const per = Math.max(1, Math.ceil(o.items.length / 2));
    [h - 0.1, h - 0.55].forEach((y, row) => {
      k.line([-arm, y, 0], [arm, y, 0], m.trim, 0.6);
      const its = o.items.slice(row * per, row * per + per);
      its.forEach((it, i) => {
        const u = -arm + (i + 0.5) * (2 * arm) / Math.max(1, its.length);
        const top = (ITEM[it.kind] === ITEM.hook ? ITEM.hook : ITEM.hook)(k, u, y, 0, 1.1, o.lang, it.exported);
        slots.push({ at: k.W(top[0], top[1], top[2]), sym: it });
      });
    });
    return { slots, top: k.W(0, h + 0.3, 0) };
  },
  /** 实验台(测试):一张台面,每个测试用例是台上一只烧瓶。 */
  labBench(o, e) {
    const k = kit(o, e), w = Math.max(1.2, o.w), d = 0.7, y = 0.85, m = o.mat;
    k.plane(-w / 2, w / 2, y, y, -d / 2, d / 2, m.stone, 0.9);
    k.edges(-w / 2, w / 2, y - 0.05, y, -d / 2, d / 2, m.trim, 0.7);
    for (const su of [-1, 1]) for (const sv of [-1, 1]) k.line([su * (w / 2 - 0.05), 0, sv * (d / 2 - 0.05)], [su * (w / 2 - 0.05), y, sv * (d / 2 - 0.05)], dark(m.wood), 0.7);
    // 试管架:后排一道横杆
    k.line([-w / 2 + 0.1, y + 0.35, -d / 2 + 0.08], [w / 2 - 0.1, y + 0.35, -d / 2 + 0.08], m.trim, 0.5);
    const levels = [y + 0.005];
    const slots = shelve(k, o.items, levels, -w / 2 + 0.06, w / 2 - 0.06, 0.05, 1.2, o.lang)
      .concat(shelve(k, o.items.slice(Math.floor((w - 0.12) / (0.17 * 1.2 + 0.018))), levels, -w / 2 + 0.06, w / 2 - 0.06, -0.2, 1.2, o.lang));
    return { slots, top: k.W(0, y + 0.8, 0) };
  },
  /** 绘图桌(类型定义):斜放的图板,上面摊着一卷卷图纸 —— 类型规定东西长什么样。 */
  draftTable(o, e) {
    const k = kit(o, e), w = Math.max(1.1, o.w), m = o.mat;
    const tilt = 0.35, y0 = 0.8, dep = 0.8;
    const at = (u, t) => [u, y0 + Math.sin(tilt) * t * dep, -dep / 2 + Math.cos(tilt) * t * dep];
    for (let i = 0; i < Math.round(w * dep * o.dens); i++) { const u = (k.rnd() - 0.5) * w, p = at(u, k.rnd()); k.P(p[0], p[1], p[2], [0.82, 0.86, 0.9], 0.8); }
    // 图纸上的格线:这张桌子的颜色就是这门语言
    for (let g = 0; g < 5; g++) { const t = (g + 0.5) / 5; const a = at(-w / 2, t), b = at(w / 2, t); k.line(a, b, o.lang, 0.4, 2); }
    for (const su of [-1, 1]) k.line([su * (w / 2 - 0.05), 0, 0], [su * (w / 2 - 0.05), y0, 0], dark(m.wood), 0.7);
    k.line([-w / 2, y0, -dep / 2], [w / 2, y0, -dep / 2], m.trim, 0.6);
    const slots = [];
    o.items.slice(0, 12).forEach((it, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const u = -w / 2 + 0.2 + col * (w - 0.4) / 2, p = at(u, 0.2 + row * 0.22);
      const top = (ITEM[it.kind] || ITEM.type)(k, p[0], p[1], p[2] + 0.04, 1, o.lang, it.exported);
      slots.push({ at: k.W(top[0], top[1], top[2]), sym: it });
    });
    return { slots, top: k.W(0, y0 + 0.9, 0) };
  },
  /** 控制台(配置):一张斜面操作台。旋钮是装饰 —— 配置文件没有符号可摆。 */
  console(o, e) {
    const k = kit(o, e), w = Math.max(0.9, o.w), m = o.mat, h = 1.0, d = 0.5;
    k.plane(-w / 2, w / 2, 0, h, 0, 0, dark(m.wood, 0.7), 0.9);
    k.plane(-w / 2, w / 2, h, h, -d, 0, m.stone, 0.8);
    k.edges(-w / 2, w / 2, 0, h, -d, 0, m.trim, 0.7);
    const knobs = Math.min(12, 3 + Math.round(o.w * 4));
    for (let i = 0; i < knobs; i++) {
      const u = -w / 2 + 0.1 + (i % 6) * (w - 0.2) / 5, vv = -0.12 - Math.floor(i / 6) * 0.2;
      k.disc(u, vv, 0.03, h + 0.01, o.lang, 0.45, 2, 8);
    }
    const slots = shelve(k, o.items, [h + 0.01], -w / 2 + 0.05, w / 2 - 0.05, -0.4, 0.9, o.lang);
    return { slots, top: k.W(0, h + 0.4, 0) };
  },
  /** 画架(样式表):一幅画布,颜色就是这门语言。 */
  easel(o, e) {
    const k = kit(o, e), m = o.mat, W = 0.8, H = 0.9, y0 = 0.7;
    for (const su of [-1, 1]) k.line([su * 0.35, 0, 0.15], [su * 0.1, y0 + H + 0.2, -0.05], m.wood, 0.7);
    k.line([0, 0, -0.4], [0, y0 + H, -0.05], m.wood, 0.7);
    for (let i = 0; i < Math.round(W * H * o.dens); i++) {
      const u = (k.rnd() - 0.5) * W, y = y0 + k.rnd() * H;
      const sw = Math.floor((u / W + 0.5) * 4);
      k.P(u, y, -0.02, mix(o.lang, [1, 1, 1], sw * 0.18), 0.8);
    }
    k.edges(-W / 2, W / 2, y0, y0 + H, -0.03, -0.01, m.trim, 0.6);
    const slots = shelve(k, o.items, [y0 - 0.02], -W / 2, W / 2, 0.05, 0.9, o.lang);
    return { slots, top: k.W(0, y0 + H + 0.4, 0) };
  },
  /** 画框(图片、字体等资源):挂在墙上。 */
  painting(o, e) {
    const k = kit(o, e), m = o.mat, W = Math.max(0.7, o.w), H = W * 0.7, y0 = 1.3;
    for (let i = 0; i < Math.round(W * H * o.dens * 1.2); i++) {
      const u = (k.rnd() - 0.5) * W, y = y0 + k.rnd() * H;
      const t = Math.sin(u * 6 + y * 4) * 0.5 + 0.5;
      k.P(u, y, -0.36, mix(mix(o.lang, [0.95, 0.9, 0.8], 0.55), [0.3, 0.45, 0.6], t * 0.5), 0.75);
    }
    k.edges(-W / 2 - 0.05, W / 2 + 0.05, y0 - 0.05, y0 + H + 0.05, -0.38, -0.33, m.trim, 0.8);
    return { slots: [], top: k.W(0, y0 + H + 0.3, 0) };
  },
  /** 抽屉柜(数据/结构):一张表一格抽屉,把手是亮的。 */
  drawers(o, e) {
    const k = kit(o, e), { w } = o, h = Math.max(0.9, Math.min(1.6, o.h)), d = 0.5, m = o.mat;
    k.plane(-w / 2, w / 2, h, h, -d, 0, m.wood, 0.9);
    for (const sgn of [-1, 1]) k.plane(sgn * w / 2, sgn * w / 2, 0, h, -d, 0, dark(m.wood, 0.8), 0.9);
    k.plane(-w / 2, w / 2, 0, h, 0, 0, dark(m.wood, 0.75), 0.9);
    k.edges(-w / 2, w / 2, 0, h, -d, 0, m.trim, 0.7);
    const rows = Math.max(3, Math.round(h / 0.22));
    const levels = [];
    for (let i = 0; i < rows; i++) { const y = 0.06 + i * (h - 0.1) / rows; levels.push(y); k.line([-w / 2, y, 0.005], [w / 2, y, 0.005], dark(m.trim, 0.6), 0.5); }
    const slots = shelve(k, o.items, levels, -w / 2 + 0.05, w / 2 - 0.05, 0.02, 1, o.lang);
    return { slots, top: k.W(0, h + 0.3, 0) };
  },
  /** 主案(入口):屋子尽头一座圆台,台上一张案。**所有路都从这里开始**,所以它最亮。 */
  dais(o, e) {
    const k = kit(o, e), m = o.mat, R = 1.05;
    for (let step = 0; step < 2; step++) {
      const r = R - step * 0.25, y = 0.12 + step * 0.14;
      k.disc(0, 0, r, y, step ? m.stone : dark(m.stone, 0.8), 0.8, 0, Math.round(Math.PI * r * r * o.dens * 0.7));
      k.cyl(0, 0, r, y - 0.13, y, dark(m.stone, 0.7), 0.8);
      k.cyl(0, 0, r + 0.01, y, y + 0.005, m.trim, 0.55, 0, Math.round(r * 90));
    }
    // 一圈光环:整间屋子最显眼的就是入口
    k.cyl(0, 0, R + 0.18, 0.02, 0.05, o.lang, 0.6, 2, 140);
    const w = Math.max(0.9, Math.min(1.6, o.w)), y = 0.26 + 0.75;
    k.plane(-w / 2, w / 2, y, y, -0.3, 0.3, m.wood, 0.85);
    k.edges(-w / 2, w / 2, 0.26, y, -0.3, 0.3, m.trim, 0.7);
    const slots = shelve(k, o.items, [y + 0.005], -w / 2 + 0.05, w / 2 - 0.05, 0.05, 1.3, o.lang)
      .concat(shelve(k, o.items.slice(Math.max(1, Math.floor((w - 0.1) / (0.09 * 1.3)))), [y + 0.005], -w / 2 + 0.05, w / 2 - 0.05, -0.18, 1.3, o.lang));
    return { slots, top: k.W(0, y + 0.9, 0) };
  },
  /** 储物架:这间屋子里没单独摆出来的小文件,成捆放在这儿。它说的是"还有这么多",
   *  而不是假装屋里只有摆出来的那些。 */
  archive(o, e) {
    const k = kit(o, e), w = Math.max(1.2, o.w), h = 1.3, d = 0.4, m = o.mat;
    k.edges(-w / 2, w / 2, 0, h, -d, 0, m.trim, 0.6);
    const levels = [0.05, 0.5, 0.95];
    for (const y of levels) k.plane(-w / 2, w / 2, y, y, -d, 0, dark(m.wood, 0.8), 0.8);
    const n = Math.min(45, o.extra || 0);
    for (let i = 0; i < n; i++) {
      const li = i % 3, j = Math.floor(i / 3);
      const u = -w / 2 + 0.08 + j * 0.1;
      if (u > w / 2 - 0.08) continue;
      k.plane(u - 0.035, u + 0.035, levels[li] + 0.01, levels[li] + 0.15, -0.05, -0.05, dark(m.trim, 0.6), 0.5, 10);
    }
    return { slots: [], top: k.W(0, h + 0.3, 0) };
  },
};

/** 一件家具多大:高是代码量(行数,没有就按字节折算),宽是它有几件东西。 */
export function furnSize(file) {
  const lines = file.lines || Math.round((file.bytes || 0) / 32);
  const h = Math.max(0.9, Math.min(2.3, 0.8 + Math.log2(1 + lines / 40) * 0.24));
  const n = (file.items || []).length;
  const w = Math.max(0.8, Math.min(2.0, 0.7 + n * 0.06 + Math.log2(1 + (file.bytes || 0) / 4000) * 0.12));
  return { h, w };
}
