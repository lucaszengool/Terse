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
 * 家具是**实打实的形体**:有厚度的板、有棱的箱、圆的瓶和管,每个面有自己的材质和法线,
 * 由 room-surface.js 在 GPU 上长成细密的点(见那个文件顶上的说明)。
 *
 * ⚠ 词不在这里翻译(和 wallpaper-project.js 同一条规矩):这里只给英文兜底,宿主把
 * 翻好的词传给 room-scene。
 */

import { MAT, F } from './room-surface.js';

const TAU = Math.PI * 2;

/* ── 文件在干什么 ──────────────────────────────────────────────────────────
   ⚠ 服务端 api/github-room.js 有同一套判据(深扫时给 role),这里是**没有深扫数据
   时的兜底**,只看文件名。两份判据由测试对账(room-interior.test.mjs)。 */
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
   正面朝向。"靠墙的柜子开口朝屋里"只是换一个朝向,不是换一套画法。 */
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
function kit(o, S, G) {
  const { X, Z, fx, fz } = o;
  const r = [fz, 0, -fx], f = [fx, 0, fz];
  const W = (u, y, v) => [X + fz * u + fx * v, y, Z - fx * u + fz * v];
  const lv = (a) => [fz * a[0] + fx * a[2], a[1], -fx * a[0] + fz * a[2]];
  const fl = o.indoor ? F.indoor : 0;
  const seed = o.seed || 0;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const m = o.mat;
  return {
    W, rnd: o.rnd,
    /** 方盒,(u, v) 是底面中心。 */
    box: (u, y, v, w, h, d, spec, faces) => S.box(W(u, y, v), r, f, w, h, d, spec, faces),
    tube: (a, b, rad, spec) => S.tube(W(a[0], a[1], a[2]), W(b[0], b[1], b[2]), rad, spec),
    cyl: (u, v, rad, y0, h, spec) => S.cyl(W(u, 0, v), rad, h, spec, 0, TAU, y0),
    disc: (u, y, v, r0, r1, spec, down) => S.disc(W(u, y, v), r0, r1, spec, down),
    ball: (u, y, v, R, spec, e0 = -Math.PI / 2, e1 = Math.PI / 2, sq = 1) => S.sphere(W(u, y, v), R, spec, 0, TAU, e0, e1, sq),
    quad: (c, U, V, spec, n) => S.quad(W(c[0], c[1], c[2]), lv(U), lv(V), spec, n ? lv(n) : undefined),
    /** 一颗发光的点 —— 数据光(一直亮)或灯(夜里亮)。 */
    glow: (u, y, v, c, s, tw = 0.6, kind = 2) => { if (G) { const p = W(u, y, v); G(p[0], p[1], p[2], c, s, tw, kind); } },
    wood: (k = 1) => sp(MAT.wood, shade(m.wood, k)),
    stone: (k = 1) => sp(MAT.marble, shade(m.stone, k), shade(m.stone, 0.55)),
    trim: (k = 1) => sp(MAT.metal, shade(m.trim, k)),
    lacq: (c) => sp(MAT.lacquer, c),
    glass: () => sp(MAT.glass, [0.66, 0.76, 0.82], [0.35, 0.35, 0.38]),
    paper: (c) => sp(MAT.paper, c, c, F.glow),
    canvas: (c1, c2) => sp(MAT.canvas, c1, c2),
    sp,
  };
}

/* ══ 家具上的东西:一个符号一件 ════════════════════════════════════════════
   每件返回自己顶上那一点(局部坐标),标签和高亮挂在那儿。s 是缩放,1 ≈ 25cm 高。
   v 是这件东西**正面**所在的深度(放在架子上时正面齐着架子边)。
   hi = 导出的符号:它是这个文件给别人用的那一面,所以带一道金边。 */
const GILT = [1, 0.84, 0.46];
export const ITEM = {
  /** 函数 = 一本书。书脊朝外,一格书架上一排,正是一个文件里一串函数的样子。 */
  fn(k, u, y, v, s, col, hi) {
    const w = 0.046 * s, h = 0.24 * s, d = 0.17 * s;
    k.box(u, y, v - d / 2, w, h, d, k.lacq(col));
    k.box(u, y + h * 0.1, v - d / 2 + 0.003, w * 0.7, h * 0.8, d, k.sp(MAT.paper, [0.92, 0.88, 0.78]), { front: false, back: false, left: false, right: false });
    if (hi) { k.box(u, y + h * 0.78, v + 0.001, w * 1.02, 0.012 * s, 0.004, k.lacq(GILT), { back: false }); k.glow(u, y + h * 0.8, v + 0.006, GILT, 0.02, 0.2); }
    return [u, y + h, v];
  },
  /** 类 = 一只箱子:它装着自己的方法,正像箱子装东西。 */
  class(k, u, y, v, s, col, hi) {
    const w = 0.28 * s, h = 0.17 * s, d = 0.2 * s;
    k.box(u, y, v - d / 2, w, h * 0.72, d, k.lacq(col));
    k.box(u, y + h * 0.72, v - d / 2, w * 1.02, h * 0.28, d * 1.02, k.lacq(shade(col, 0.7)));
    k.box(u, y + h * 0.05, v - d / 2, w * 1.03, 0.012 * s, d * 1.03, k.trim(), { bottom: false });
    if (hi) { k.box(u, y + h * 0.5, v + 0.002, 0.03 * s, 0.04 * s, 0.01, k.lacq(GILT), { back: false }); k.glow(u, y + h * 0.52, v + 0.01, GILT, 0.03, 0.2); }
    return [u, y + h, v];
  },
  /** 类型 = 一卷图纸:它不做事,它规定东西长什么样。 */
  type(k, u, y, v, s, col, hi) {
    const L = 0.26 * s, r = 0.034 * s;
    k.tube([u - L / 2, y + r, v - r], [u + L / 2, y + r, v - r], r, k.sp(MAT.paper, [0.9, 0.86, 0.74]));
    k.tube([u - L * 0.2, y + r, v - r], [u + L * 0.2, y + r, v - r], r * 1.08, k.lacq(col));
    for (const sgn of [-1, 1]) k.ball(u + sgn * (L / 2 + r * 0.4), y + r, v - r, r * 0.7, hi ? k.lacq(GILT) : k.wood(0.8));
    return [u, y + r * 2, v];
  },
  /** 测试 = 一只烧瓶:一次实验,结果装在瓶子里。 */
  test(k, u, y, v, s, col, hi) {
    const r = 0.07 * s;
    k.ball(u, y + r, v - r, r * 0.94, k.lacq(col), -Math.PI / 2, 0.35);      // 瓶里的液体 —— 这件东西的颜色
    k.ball(u, y + r, v - r, r, k.glass(), 0.2, Math.PI / 2);
    k.cyl(u, v - r, r * 0.3, y + r * 1.8, r * 1.3, k.glass());
    k.glow(u, y + r * 0.8, v - r, col, 0.05, 0.4);
    return [u, y + r * 3.1, v];
  },
  /** 组件 = 一尊小像:一块界面,单独立在那儿给人看。 */
  component(k, u, y, v, s, col, hi) {
    const r = 0.045 * s;
    k.disc(u, y + 0.012, v - r * 1.5, 0, r * 1.6, k.stone(0.9));
    k.cyl(u, v - r * 1.5, r * 1.6, y, 0.012, k.stone(0.8));
    k.cyl(u, v - r * 1.5, r, y + 0.012, 0.11 * s, k.lacq(col));
    k.ball(u, y + 0.012 + 0.11 * s + r * 0.85, v - r * 1.5, r * 0.85, k.lacq(col));
    if (hi) k.glow(u, y + 0.14 * s, v - r * 1.5, col, 0.05, 0.3);
    return [u, y + 0.21 * s, v];
  },
  /** hook = 一盏小灯笼,挂在钩子上(钩子架上挂 hook,字面意思)。 */
  hook(k, u, y, v, s, col, hi) {
    const r = 0.06 * s;
    k.tube([u, y, v], [u, y - 0.1 * s, v], 0.004, k.trim(0.6));
    k.ball(u, y - 0.1 * s - r, v, r, k.paper(col), -Math.PI / 2, Math.PI / 2, 1.25);
    k.disc(u, y - 0.1 * s + 0.004, v, 0, r * 0.55, k.trim(0.7));
    k.glow(u, y - 0.1 * s - r, v, col, 0.09, 0.5, 2);
    return [u, y, v];
  },
  /** 路由 = 一只铃:外面有人敲门,它就响。 */
  route(k, u, y, v, s, col, hi) {
    const r = 0.07 * s;
    k.ball(u, y, v - r, r, k.lacq(col), 0, Math.PI / 2, 1.3);
    k.ball(u, y - 0.004, v - r, r * 0.22, k.lacq(GILT));
    k.cyl(u, v - r, r * 0.12, y + r * 1.25, r * 0.4, k.trim());
    return [u, y + r * 1.7, v];
  },
  /** 导出的常量 = 一只罐子:装好了,放在那儿给人取。 */
  const(k, u, y, v, s, col, hi) {
    const r = 0.05 * s;
    k.cyl(u, v - r, r, y, 0.1 * s, k.lacq(col));
    k.disc(u, y + 0.1 * s, v - r, 0, r, k.lacq(shade(col, 0.8)));
    k.cyl(u, v - r, r * 0.72, y + 0.1 * s, 0.02 * s, k.lacq(shade(col, 0.6)));
    k.disc(u, y + 0.12 * s, v - r, 0, r * 0.72, k.lacq(hi ? GILT : shade(col, 0.6)));
    return [u, y + 0.12 * s, v];
  },
  /** 文档里的一节 = 一册书,比函数那本厚。 */
  heading(k, u, y, v, s, col, hi) { return ITEM.fn(k, u, y, v, s * 1.25, col, hi); },
  /** 数据表 = 一格抽屉:一张表,拉开就是一行行记录。 */
  table(k, u, y, v, s, col, hi) {
    const w = 0.3 * s, h = 0.1 * s;
    k.box(u, y, v - 0.01, w, h, 0.02, k.lacq(col), { back: false });
    k.box(u, y + h * 0.4, v + 0.01, w * 0.3, h * 0.2, 0.02, k.lacq(GILT), { back: false });
    return [u, y + h, v];
  },
};
/** 一件东西在架子上占多宽(局部单位,s=1)。 */
const ITEM_W = { fn: 0.066, heading: 0.08, class: 0.32, type: 0.33, test: 0.17, component: 0.16, hook: 0.16, route: 0.17, const: 0.13, table: 0.34 };

/** 在一层层架子上从左往右摆东西。放不下的就不摆 —— 调用方已经按重要程度排好了。 */
function shelve(k, items, levels, u0, u1, v, s, lang) {
  const slots = [];
  let li = 0, u = u0;
  for (let i = 0; i < items.length && li < levels.length; i++) {
    const it = items[i], wd = (ITEM_W[it.kind] || 0.12) * s;
    if (u + wd > u1) { li++; u = u0; if (li >= levels.length) break; }
    const draw = ITEM[it.kind] || ITEM.fn;
    const top = draw(k, u + wd / 2, levels[li], v, s, lang, it.exported);
    slots.push({ at: k.W(top[0], top[1], top[2]), sym: it });
    u += wd + 0.012 * s;
  }
  return slots;
}

/* ══ 家具:一个文件一件 ════════════════════════════════════════════════════
   o: { X, Z, fx, fz, w, h, items:[{name,kind,line,exported}], lang, mat:{wood,stone,trim},
        rnd, indoor, seed, extra } —— S 是 room-surface 的 Surfaces,G 是发光点。
   返回 { slots, top }。尺寸由调用方按文件大小给好。 */
export const FURN = {
  /** 柜子(一般源文件):开口朝外的多层柜,一格格放着它定义的东西。 */
  cabinet(o, S, G) {
    const k = kit(o, S, G), w = o.w, h = o.h, d = 0.42;
    k.box(0, 0, -d / 2, w, 0.08, d, k.wood(0.6));                               // 踢脚
    k.box(0, 0.08, -d + 0.012, w - 0.04, h - 0.12, 0.024, k.wood(0.55));        // 背板
    for (const sgn of [-1, 1]) k.box(sgn * (w / 2 - 0.02), 0.08, -d / 2, 0.04, h - 0.08, d, k.wood(0.95));
    k.box(0, h - 0.05, -d / 2, w + 0.04, 0.05, d + 0.03, k.wood(1));            // 顶板
    k.box(0, h, -d / 2 + 0.01, w + 0.08, 0.04, d + 0.06, k.trim(0.9), { bottom: true });   // 描金的冠
    const n = Math.max(2, Math.round((h - 0.2) / 0.34));
    const levels = [];
    for (let i = 0; i < n; i++) {
      const y = 0.08 + i * (h - 0.16) / n;
      k.box(0, y, -d / 2 + 0.01, w - 0.08, 0.022, d - 0.04, k.wood(0.85));
      levels.push(y + 0.022);
    }
    const slots = shelve(k, o.items, levels, -w / 2 + 0.06, w / 2 - 0.06, -0.03, 1, o.lang);
    return { slots, top: k.W(0, h + 0.32, 0) };
  },
  /** 书架(文档):比柜子高。一节是一册书。 */
  bookshelf(o, S, G) { return FURN.cabinet(Object.assign({}, o, { h: Math.max(o.h, 1.7) }), S, G); },
  /** 玻璃展柜(界面组件):一块界面就是一尊立在玻璃后面给人看的小像。 */
  vitrine(o, S, G) {
    const k = kit(o, S, G), w = o.w, h = Math.max(1.5, o.h), d = 0.52, base = 0.55;
    k.box(0, 0, -d / 2, w, base, d, k.wood(0.7));
    k.box(0, base - 0.03, -d / 2, w + 0.03, 0.03, d + 0.03, k.trim(0.8), { bottom: true });
    for (const su of [-1, 1]) for (const sv of [0, -d]) k.box(su * (w / 2 - 0.02), base, sv + (sv ? 0.02 : -0.02), 0.03, h - base, 0.03, k.trim(0.9));
    k.quad([-w / 2, base, 0], [w, 0, 0], [0, h - base, 0], k.glass(), [0, 0, 1]);
    for (const su of [-1, 1]) k.quad([su * w / 2, base, -d], [0, 0, d], [0, h - base, 0], k.glass(), [su, 0, 0]);
    k.box(0, h, -d / 2, w + 0.04, 0.05, d + 0.04, k.wood(0.8), { bottom: true });
    const mid = base + (h - base) / 2;
    k.box(0, mid - 0.01, -d / 2, w - 0.06, 0.012, d - 0.06, k.glass());
    const slots = shelve(k, o.items, [base + 0.002, mid + 0.002], -w / 2 + 0.07, w / 2 - 0.07, -0.08, 1.2, o.lang);
    for (let i = 0; i < 3; i++) k.glow(-w / 2 + (i + 0.5) * w / 3, h - 0.05, -d / 2, [0.8, 0.9, 1], 0.05, 0.1, 1);
    return { slots, top: k.W(0, h + 0.32, 0) };
  },
  /** 钩子架(hook):一根立柱两条横臂,每个 hook 是挂在上面的一盏小灯笼。 */
  hookRack(o, S, G) {
    const k = kit(o, S, G), h = Math.max(1.6, o.h), arm = Math.max(0.5, o.w / 2);
    k.disc(0, 0.03, 0, 0, 0.3, k.wood(0.7));
    k.cyl(0, 0, 0.3, 0, 0.03, k.wood(0.6));
    k.cyl(0, 0, 0.04, 0.03, h, k.wood(0.9));
    k.ball(0, h + 0.03, 0, 0.055, k.trim());
    const slots = [];
    const per = Math.max(1, Math.ceil(o.items.length / 2));
    [h - 0.08, h - 0.58].forEach((y, row) => {
      k.box(0, y - 0.02, 0, arm * 2, 0.035, 0.035, k.wood(0.85));
      const its = o.items.slice(row * per, row * per + per);
      its.forEach((it, i) => {
        const u = -arm + (i + 0.5) * (2 * arm) / Math.max(1, its.length);
        const top = ITEM.hook(k, u, y - 0.02, 0, 1.1, o.lang, it.exported);
        slots.push({ at: k.W(top[0], top[1], top[2]), sym: it });
      });
    });
    return { slots, top: k.W(0, h + 0.35, 0) };
  },
  /** 实验台(测试):一张石面台,每个测试用例是台上一只烧瓶。 */
  labBench(o, S, G) {
    const k = kit(o, S, G), w = Math.max(1.3, o.w), d = 0.72, y = 0.86;
    k.box(0, y - 0.05, 0, w, 0.05, d, k.stone(1), { bottom: true });
    k.box(0, y - 0.1, 0, w - 0.1, 0.05, d - 0.1, k.wood(0.7));
    for (const su of [-1, 1]) for (const sv of [-1, 1]) k.box(su * (w / 2 - 0.07), 0, sv * (d / 2 - 0.07), 0.05, y - 0.1, 0.05, k.wood(0.75));
    k.box(0, 0.12, 0, w - 0.14, 0.03, d - 0.14, k.wood(0.65));                   // 下层搁板
    k.box(0, y + 0.3, -d / 2 + 0.1, w - 0.2, 0.025, 0.04, k.trim(0.8));            // 试管架横杆
    for (const su of [-1, 1]) k.box(su * (w / 2 - 0.1), y, -d / 2 + 0.1, 0.03, 0.33, 0.03, k.trim(0.8));
    const cap = Math.floor((w - 0.12) / (0.17 * 1.2 + 0.015));
    const slots = shelve(k, o.items, [y], -w / 2 + 0.06, w / 2 - 0.06, 0.2, 1.2, o.lang)
      .concat(shelve(k, o.items.slice(cap), [y], -w / 2 + 0.06, w / 2 - 0.06, -0.06, 1.2, o.lang));
    return { slots, top: k.W(0, y + 0.85, 0) };
  },
  /** 绘图桌(类型定义):斜放的图板,上面摊着一卷卷图纸 —— 类型规定东西长什么样。 */
  draftTable(o, S, G) {
    const k = kit(o, S, G), w = Math.max(1.2, o.w), tilt = 0.32, y0 = 0.82, dep = 0.8;
    const U = [w, 0, 0], V = [0, Math.sin(tilt) * dep, -Math.cos(tilt) * dep];
    k.quad([-w / 2, y0, dep / 2], U, V, k.sp(MAT.tile, [0.78, 0.86, 0.94], o.lang), [0, 1, 0.3]);
    k.box(0, y0 - 0.04, dep / 2 - 0.02, w, 0.04, 0.04, k.wood(0.8));
    for (const su of [-1, 1]) {
      k.tube([su * (w / 2 - 0.06), 0, dep / 2 - 0.05], [su * (w / 2 - 0.06), y0, dep / 2 - 0.05], 0.025, k.wood(0.75));
      k.tube([su * (w / 2 - 0.06), 0, -dep / 2 + 0.1], [su * (w / 2 - 0.06), y0 + Math.sin(tilt) * dep, -dep / 2 + 0.05], 0.025, k.wood(0.75));
    }
    const at = (u, t) => [u, y0 + Math.sin(tilt) * t * dep + 0.012, dep / 2 - Math.cos(tilt) * t * dep];
    const slots = [];
    o.items.slice(0, 12).forEach((it, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const p = at(-w / 2 + 0.22 + col * (w - 0.44) / 2, 0.16 + row * 0.22);
      const top = (ITEM[it.kind] || ITEM.type)(k, p[0], p[1], p[2] + 0.04, 1, o.lang, it.exported);
      slots.push({ at: k.W(top[0], top[1], top[2]), sym: it });
    });
    return { slots, top: k.W(0, y0 + 0.9, 0) };
  },
  /** 控制台(配置):一张斜面操作台。旋钮是装饰 —— 配置文件没有符号可摆。 */
  console(o, S, G) {
    const k = kit(o, S, G), w = Math.max(1.0, o.w), h = 0.95, d = 0.55;
    k.box(0, 0, -d / 2, w, h, d, k.wood(0.65));
    k.quad([-w / 2, h, 0], [w, 0, 0], [0, 0.22, -d * 0.7], k.sp(MAT.lacquer, [0.1, 0.12, 0.14]), [0, 1, 0.4]);
    k.box(0, h + 0.22, -d / 2 - 0.05, w, 0.3, 0.06, k.wood(0.6));
    const knobs = Math.min(12, 3 + Math.round(w * 4));
    for (let i = 0; i < knobs; i++) {
      const t = (i % 6 + 0.5) / 6, row = Math.floor(i / 6);
      const u = -w / 2 + t * w, vv = -0.08 - row * 0.18, yy = h + 0.22 * (0.1 + row * 0.35);
      k.cyl(u, vv, 0.022, yy, 0.03, k.trim());
      k.glow(u, yy + 0.035, vv, o.lang, 0.035, 0.5);
    }
    const slots = shelve(k, o.items, [h + 0.23], -w / 2 + 0.05, w / 2 - 0.05, -0.36, 0.9, o.lang);
    return { slots, top: k.W(0, h + 0.65, 0) };
  },
  /** 画架(样式表):一幅画布,画上的颜色就是这门语言。 */
  easel(o, S, G) {
    const k = kit(o, S, G), W = 0.82, H = 0.95, y0 = 0.72;
    for (const su of [-1, 1]) k.tube([su * 0.36, 0, 0.18], [su * 0.08, y0 + H + 0.2, -0.04], 0.022, k.wood(0.85));
    k.tube([0, 0, -0.45], [0, y0 + H, -0.06], 0.02, k.wood(0.8));
    k.box(0, y0 - 0.05, 0, W + 0.1, 0.04, 0.08, k.wood(0.9));
    k.quad([-W / 2, y0, 0.02], [W, 0, 0], [0, H, -0.08], k.canvas(o.lang, [0.96, 0.93, 0.86]), [0, 0, 1]);
    const slots = shelve(k, o.items, [y0 - 0.01], -W / 2, W / 2, 0.04, 0.9, o.lang);
    return { slots, top: k.W(0, y0 + H + 0.4, 0) };
  },
  /** 画框(图片、字体等资源):挂在墙上。 */
  painting(o, S, G) {
    const k = kit(o, S, G), W = Math.max(0.8, Math.min(1.8, o.w)), H = W * 0.68, y0 = 1.25, v = -0.33;
    k.quad([-W / 2, y0, v], [W, 0, 0], [0, H, 0], k.canvas(o.lang, [0.88, 0.82, 0.7]), [0, 0, 1]);
    const fr = 0.06;
    k.box(0, y0 - fr, v - 0.02, W + fr * 2, fr, 0.05, k.trim(0.9));
    k.box(0, y0 + H, v - 0.02, W + fr * 2, fr, 0.05, k.trim(0.9));
    for (const su of [-1, 1]) k.box(su * (W / 2 + fr / 2), y0, v - 0.02, fr, H, 0.05, k.trim(0.9));
    k.glow(0, y0 + H + 0.12, v + 0.1, [1, 0.85, 0.6], 0.06, 0.2, 1);             // 画灯
    return { slots: [], top: k.W(0, y0 + H + 0.3, 0) };
  },
  /** 抽屉柜(数据/结构):一张表一格抽屉,把手是亮的。 */
  drawers(o, S, G) {
    const k = kit(o, S, G), w = o.w, h = Math.max(0.95, Math.min(1.6, o.h)), d = 0.5;
    k.box(0, 0, -d / 2, w, h, d, k.wood(0.7));
    k.box(0, h, -d / 2, w + 0.04, 0.035, d + 0.03, k.trim(0.85), { bottom: true });
    const rows = Math.max(3, Math.round(h / 0.22));
    const levels = [];
    for (let i = 0; i < rows; i++) {
      const y = 0.06 + i * (h - 0.1) / rows;
      levels.push(y + 0.02);
      k.box(0, y + 0.01, 0.005, w - 0.06, (h - 0.1) / rows - 0.025, 0.012, k.wood(0.9), { back: false });
    }
    const slots = shelve(k, o.items, levels, -w / 2 + 0.05, w / 2 - 0.05, 0.03, 1, o.lang);
    return { slots, top: k.W(0, h + 0.3, 0) };
  },
  /** 主案(入口):屋子尽头一座两级圆台,台上一张案。**所有路都从这里开始**,所以它最亮。 */
  dais(o, S, G) {
    const k = kit(o, S, G), R = 1.1;
    for (let step = 0; step < 2; step++) {
      const r = R - step * 0.26, y = 0.13 + step * 0.13;
      k.disc(0, y, 0, 0, r, k.stone(step ? 1 : 0.85));
      k.cyl(0, 0, r, y - 0.13, 0.13, k.stone(0.75));
      k.cyl(0, 0, r + 0.012, y - 0.015, 0.015, k.trim(0.9));
    }
    // 一圈光环贴着地:整间屋子最显眼的就是入口
    for (let i = 0; i < 90; i++) { const a = i / 90 * TAU; k.glow(Math.cos(a) * (R + 0.16), 0.02, Math.sin(a) * (R + 0.16), o.lang, 0.06, 0.6); }
    const w = Math.max(1.0, Math.min(1.6, o.w)), y = 0.26 + 0.76;
    k.box(0, y - 0.05, 0, w, 0.05, 0.62, k.wood(1));
    k.box(0, y - 0.11, 0, w - 0.1, 0.06, 0.52, k.trim(0.9));
    for (const su of [-1, 1]) k.box(su * (w / 2 - 0.1), 0.26, 0, 0.12, y - 0.37, 0.5, k.wood(0.85));
    const cap = Math.max(1, Math.floor((w - 0.1) / (0.066 * 1.3 + 0.015)));
    const slots = shelve(k, o.items, [y], -w / 2 + 0.05, w / 2 - 0.05, 0.25, 1.3, o.lang)
      .concat(shelve(k, o.items.slice(cap), [y], -w / 2 + 0.05, w / 2 - 0.05, -0.02, 1.3, o.lang));
    return { slots, top: k.W(0, y + 0.95, 0) };
  },
  /** 储物架:这间屋子里没单独摆出来的小文件,成捆放在这儿。它说的是"还有这么多",
   *  而不是假装屋里只有摆出来的那些。 */
  archive(o, S, G) {
    const k = kit(o, S, G), w = Math.max(1.3, o.w), h = 1.35, d = 0.42;
    for (const sgn of [-1, 1]) k.box(sgn * (w / 2 - 0.02), 0, -d / 2, 0.04, h, d, k.wood(0.7));
    const levels = [0.04, 0.48, 0.92];
    for (const y of levels) k.box(0, y - 0.025, -d / 2, w - 0.04, 0.025, d, k.wood(0.75));
    k.box(0, h - 0.03, -d / 2, w, 0.03, d, k.wood(0.8));
    const n = Math.min(45, o.extra || 0), box = [0.62, 0.52, 0.38];
    for (let i = 0; i < n; i++) {
      const li = i % 3, j = Math.floor(i / 3), u = -w / 2 + 0.1 + j * 0.1;
      if (u > w / 2 - 0.08) continue;
      k.box(u, levels[li], -0.12, 0.08, 0.13 + (i % 3) * 0.03, 0.22, k.sp(MAT.paper, shade(box, 0.8 + (i % 4) * 0.06)));
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
