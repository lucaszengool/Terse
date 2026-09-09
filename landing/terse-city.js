/* ═══════════════════════════════════════════════════════════════════════════
   terse-city.js — the code city, for the website.

   GENERATED — do not hand-edit. Assembled from the app's own sources by
   scripts/build-landing-city.mjs, so the site's city is literally the app's
   city rather than a copy that drifts away from it:

     src/renderer/city-styles.js       — the 8 civilisations, whole
     src/renderer/lang-colors.js       — language -> colour, whole
     src/renderer/wallpaper-project.js — hash01c, sampleLabel, human, since, CITY_PITCH, CITY_YAW, KIND_RGB, sampleCity

   Exposed as window.TerseCity, because terse-field.js is a plain IIFE that the
   landing pages load with a bare <script> — there are no modules here.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

/* ── lang-colors.js ──────────────────────────────────────────────────────── */
/**
 * lang-colors.js — 一门语言一个颜色,**全 app 只有这一份**。
 *
 * 这张表原本抄在项目列表的语言条里。代码城市要给每座塔上色,用的必须是同一个
 * 颜色 —— 界面上是绿色的 shell,壁纸上不能变成蓝色,不然两处说的就不是同一件事了。
 * 复制一份最省事,然后它们会各自漂移;这种表一漂,人不会报 bug,只会觉得这个
 * 产品有点糊。
 *
 * 颜色沿用 GitHub Linguist 那一套 —— 用惯 GitHub 的人不需要看图例。
 */
const LANG_COLOR = {
  rust: '#dea584', ts: '#3178c6', js: '#f1e05a', python: '#3572A5', go: '#00ADD8',
  swift: '#F05138', kotlin: '#A97BFF', java: '#b07219', c: '#555555', 'c++': '#f34b7d',
  ruby: '#701516', php: '#4F5D95', 'c#': '#178600', html: '#e34c26', css: '#563d7c',
  shell: '#89e051', sql: '#e38c00',
};

/** 没认出来的语言。灰的 —— 它得存在,但不该跟真正的语言抢眼睛。 */
const LANG_FALLBACK = '#8A8A90';

/** '#dea584' → [0.87, 0.65, 0.52]。粒子的颜色是 0–1 的浮点,不是 CSS 字符串。 */
function langRgb(lang) {
  const hex = LANG_COLOR[lang] || LANG_FALLBACK;
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}


/* ── city-styles.js ──────────────────────────────────────────────────────── */
/**
 * city-styles.js — 代码城市的**建筑语法**。
 *
 * 一座城市说的是同一件事,只是用不同的语言说。**指标映射在所有风格里完全一样** ——
 * 高度永远是代码量,占地永远是文件数,色带永远是语言构成,灯永远是"最近动过没有",
 * 尖顶永远是改动最勤的那一块。变的只有**形**。
 *
 * 风格换了、读数也跟着换的话,它就不是皮肤,而是另一张图 —— 人会以为自己的项目变了。
 *
 * ── 为什么是"语法"而不是"一种风格一个函数" ──
 * 一个风格配一个生成器,一个仓库里所有的塔就长得一模一样,只是高矮不同 —— 那不叫
 * 城市,那叫柱状图。真实的城市里没有两栋楼是一样的,而它们又明显属于同一个地方。
 *
 * 所以这里抄的是**形状文法**(shape grammar):一栋楼被拆成几个槽位,每个槽位有
 * 若干可选件,风格决定**哪些件可以用**,每栋楼按自己的种子各挑一件:
 *
 *     台基 base  ×  楼身 body  ×  外皮 skin  ×  楼冠 crown  ×  附件 extra
 *
 * 一个风格里典型是 4 × 5 × 4 × 5 × 20 ≈ **上千种**不重样的组合,而代码只多了几个
 * 小函数。风格之间的区别不在数量,在**词汇表**:唐宋能用斗拱和出檐,古希腊只能用
 * 柱式和山花,两边都拿不到对方的件。
 *
 * 种子是**从目录名算出来的**,不是随机数:同一个项目每次生成必须是同一座城,
 * 否则每重聚一次,人的项目就换一副样子。
 */

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
/** 稳定伪随机。整个文件不许出现 Math.random —— 城市必须可复现。 */
function h01(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
/** 字符串 → 整数种子(FNV-1a)。同一个目录名永远拿到同一栋楼。 */
function seedOf(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}
/** 从种子里连续取值:每问一次换一个数,同一栋楼里各槽位互不相关。 */
function picker(seed) {
  let n = seed;
  return {
    /** 0..1 */
    f() { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; },
    /** 从数组里挑一个 */
    of(arr) { return arr[Math.floor(this.f() * arr.length) % arr.length]; },
    /** p 的概率为真 */
    odds(p) { return this.f() < p; },
    /** lo..hi 的整数 */
    int(lo, hi) { return lo + Math.floor(this.f() * (hi - lo + 1)); },
  };
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const shade = (c, k) => [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)];

/* ── 几何原语 ───────────────────────────────────────────────────────────────
   每个原语只管"把这一块的表面撒成粒子"。它们不认识风格,也不认识指标 ——
   颜色一律从 ctx.wallAt(t, 高度比) 拿,所以**换任何形状,语言色带都还在**。 */

/** 一个方盒的四立面 + 顶面。skin 决定立面上长什么。 */
function box(t, ctx, emit, o) {
  const { cx, cz, w, d, y0, y1 } = o;
  const n = o.n | 0; if (n <= 0) return;
  const hw = w / 2, hd = d / 2, hh = Math.max(0.001, y1 - y0);
  const sideA = 2 * (w + d) * hh, topA = w * d;
  const pTop = topA / (sideA + topA + 1e-6);
  const skin = o.skin || 'plain';
  const cols = Math.max(2, Math.min(7, Math.round(w * 13)));
  const rows = Math.max(1, Math.min(16, Math.round(hh * 11)));
  const lit = (skin === 'glass' || skin === 'grid') ? ctx.lit(t) : 0;
  const tint = o.tint || null;
  for (let k = 0; k < n; k++) {
    const r1 = h01(k * 3.1 + cx * 91 + y0 * 57 + (o.salt || 0));
    // 竖棱先画:轮廓是最先被认出来的东西
    if (k % 10 === 0) {
      const e = (k / 10 | 0) % 4;
      const y = y0 + h01(k * 1.7 + (o.salt || 0)) * hh;
      const c = tint || ctx.wallAt(t, (y - ctx.BASE) / Math.max(0.001, t.h));
      emit(cx + (e === 0 || e === 3 ? -hw : hw), y, cz + (e < 2 ? -hd : hd), c[0], c[1], c[2], 0.82);
      continue;
    }
    if (r1 < pTop) {
      const c = tint || ctx.wallAt(t, (y1 - ctx.BASE) / Math.max(0.001, t.h));
      emit(cx + (h01(k * 5.3) - 0.5) * w, y1, cz + (h01(k * 7.7) - 0.5) * d,
           c[0] * 1.04, c[1] * 1.04, c[2] * 1.04, 0.86);
      continue;
    }
    const face = (k * 7 + 3) % 4;
    const u = h01(k * 2.3 + (o.salt || 0)), v = h01(k * 4.9 + (o.salt || 0));
    const y = y0 + v * hh;
    let x, z;
    if (face === 0) { x = cx + (u - 0.5) * w; z = cz - hd; }
    else if (face === 1) { x = cx + hw; z = cz + (u - 0.5) * d; }
    else if (face === 2) { x = cx + (u - 0.5) * w; z = cz + hd; }
    else { x = cx - hw; z = cz + (u - 0.5) * d; }
    const fy = (y - ctx.BASE) / Math.max(0.001, t.h);
    const base = tint || ctx.wallAt(t, fy);
    emit(x, y, z, ...skinPaint(skin, base, u, v, cols, rows, face, lit, k), 0.8);
  }
}

/** 外皮:同一个落点,不同的上色/取舍。这是"细节"最便宜的来源 ——
 *  不加一颗粒子,一栋楼就从素混凝土变成砖砌、变成幕墙、变成花窗。 */
function skinPaint(skin, base, u, v, cols, rows, face, lit, k) {
  switch (skin) {
    case 'glass':
    case 'grid': {
      const gu = u * cols, gv = v * rows;
      const inW = (gu % 1) > 0.24 && (gu % 1) < 0.79 && (gv % 1) > 0.26 && (gv % 1) < 0.76;
      if (inW) {
        const id = Math.floor(gu) * 31 + Math.floor(gv) * 17 + face * 7;
        const on = ((Math.imul(id, 2654435761) >>> 0) % 1000) / 1000 < lit;
        return on ? [1.0, 0.93, 0.74] : [0.10, 0.12, 0.17];
      }
      return base;
    }
    case 'fins': {                       // 竖向密肋:高层最常见的"细"
      const f = (Math.floor(u * cols * 3) % 2) ? 1.20 : 0.72;
      return shade(base, f);
    }
    case 'bands': {                      // 横向腰线
      const f = (Math.floor(v * rows * 1.5) % 2) ? 1.14 : 0.80;
      return shade(base, f);
    }
    case 'brick': {                      // 砖缝:错缝,不是网格
      const row = Math.floor(v * rows * 2.4);
      const off = (row % 2) * 0.5;
      const bu = (u * cols * 2.2 + off) % 1;
      const bv = (v * rows * 2.4) % 1;
      const mortar = bu < 0.10 || bv < 0.14;
      return shade(base, mortar ? 0.62 : 0.98 + 0.10 * h01(row * 7 + Math.floor(bu * 9)));
    }
    case 'lattice': {                    // 花窗 / 格栅
      const gu = (u * cols * 2) % 1, gv = (v * rows * 1.6) % 1;
      const on = (gu > 0.30 && gu < 0.70) || (gv > 0.30 && gv < 0.70);
      return on ? shade(base, 0.55) : shade(base, 1.22);
    }
    case 'arches': {                     // 连拱廊
      const gu = (u * cols) % 1;
      const arch = Math.sin(gu * Math.PI);
      const inArch = v < arch * 0.55;
      return inArch ? shade(base, 0.42) : shade(base, 1.06);
    }
    case 'mosaic': {                      // 琉璃拼花
      const cell = Math.floor(u * cols * 3) * 13 + Math.floor(v * rows * 2) * 29;
      const r = h01(cell);
      return r > 0.72 ? [base[0] * 0.5, base[1] * 1.25, base[2] * 1.5]
           : r > 0.44 ? shade(base, 1.18) : shade(base, 0.78);
    }
    case 'columns': {                     // 壁柱:一根根半圆柱贴在墙上
      // 用余弦给每根柱子做**圆的明暗**,不是明暗两档 —— 两档是竖条纹,
      // 圆滑的过渡才让人读成"柱子"。
      const u2 = (u * cols) % 1;
      const round = 0.62 + 0.55 * Math.sin(u2 * Math.PI);
      // 柱头柱础各一道横线
      const capBase = v > 0.90 || v < 0.07;
      return shade(base, capBase ? 1.24 : round);
    }
    case 'timber': {                      // 木构:立柱 + 横枋
      const post = (Math.floor(u * cols * 1.6) % 2) === 0;
      const beam = ((v * rows) % 1) < 0.16;
      return shade(base, beam ? 0.66 : post ? 1.16 : 0.86);
    }
    default: {
      // 一点点砌块感。**很轻** —— 重了就变成砖墙,而 plain 的意义就是"没有纹样"。
      const cell = Math.floor(u * cols * 1.4) * 17 + Math.floor(v * rows * 1.2) * 31;
      return shade(base, 0.94 + 0.12 * h01(cell));
    }
  }
}

/** 圆柱(鼓座、塔身、粮仓)。 */
function cyl(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, r, y0, y1 } = o;
  const hh = Math.max(0.001, y1 - y0);
  for (let k = 0; k < n; k++) {
    const a = h01(k * 1.61 + (o.salt || 0)) * TAU;
    const v = h01(k * 4.13 + (o.salt || 0));
    const y = y0 + v * hh;
    const c = o.tint || ctx.wallAt(t, (y - ctx.BASE) / Math.max(0.001, t.h));
    // 凹槽:柱身上的竖纹,古典柱式的识别点
    const flute = o.flutes ? ((Math.floor(a / TAU * o.flutes) % 2) ? 1.16 : 0.80) : 1;
    emit(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, ...shade(c, flute), 0.8);
  }
}

/** 穹顶。onion = 洋葱顶(中亚/波斯),否则半球。ribs = 瓜棱。 */
function dome(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, r, y0 } = o;
  for (let k = 0; k < n; k++) {
    const a = h01(k * 1.9 + (o.salt || 0)) * TAU;
    const ph = h01(k * 3.7 + (o.salt || 0)) * Math.PI / 2;
    const bulge = o.onion ? 1 + 0.32 * Math.sin(ph * 2) : 1;
    const rr = r * Math.cos(ph) * bulge;
    const c = o.tint || ctx.wallAt(t, 1);
    const rib = o.ribs ? 1 + 0.22 * Math.sin(a * o.ribs) : 1;
    emit(cx + Math.cos(a) * rr, y0 + Math.sin(ph) * r * (o.onion ? 1.28 : 0.8),
         cz + Math.sin(a) * rr, ...shade(c, rib), 0.8);
  }
}

/** 锥体 / 四面金字塔。sides=4 是金字塔,大 sides 是圆锥。step>0 是阶梯式。 */
function pyramid(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, r, y0, h } = o;
  for (let k = 0; k < n; k++) {
    let v = Math.sqrt(h01(k * 1.93 + (o.salt || 0)));      // 面积加权:底下宽,粒子也多
    if (o.step) v = Math.floor(v * o.step) / o.step + 0.02;
    const rr = r * (1 - v);
    const c = o.tint || ctx.wallAt(t, v);
    if (o.sides === 4) {
      const face = (k * 5 + 1) % 4;
      const s = (h01(k * 3.3) - 0.5) * 2 * rr;
      const x = face === 1 ? cx + rr : face === 3 ? cx - rr : cx + s;
      const z = face === 0 ? cz - rr : face === 2 ? cz + rr : cz + s;
      // 迎光面亮、背光面暗 —— 不分明暗,四面锥看起来就是一个平三角
      emit(x, y0 + v * h, z, ...shade(c, (face === 0 || face === 3) ? 1.16 : 0.74), 0.82);
    } else {
      const a = h01(k * 5.7) * TAU;
      emit(cx + Math.cos(a) * rr, y0 + v * h, cz + Math.sin(a) * rr,
           ...shade(c, 0.82 + 0.34 * Math.cos(a)), 0.82);
    }
  }
}

/** 双坡屋顶(厅堂、长屋、和风的殿)。steep 越大越陡。 */
function gable(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, w, d, y0, ridge } = o;
  const hd = d / 2;
  for (let k = 0; k < n; k++) {
    const side = h01(k * 2.11 + (o.salt || 0)) < 0.5 ? -1 : 1;
    const u = h01(k * 3.37 + (o.salt || 0));
    const ov = o.overhang || 1.0;
    const c = o.tint || ctx.wallAt(t, 0.92);
    // 屋面上的瓦垄:一道道平行的浅纹,远看就是"这是瓦不是板"
    const tile = o.tiles ? ((Math.floor(h01(k * 6.1) * o.tiles) % 2) ? 1.10 : 0.88) : 1;
    emit(cx + (h01(k * 4.51 + (o.salt || 0)) - 0.5) * w * ov,
         y0 + (1 - u) * (ridge - y0), cz + side * hd * u * ov, ...shade(c, tile), 0.82);
  }
}

/** 出檐 + 斗拱。木构建筑的全部识别度都在这一圈上。 */
function eave(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, w, y } = o;
  const hw = w / 2;
  const nBracket = o.dougong ? Math.floor(n * 0.24) : 0;
  for (let k = 0; k < n - nBracket; k++) {
    const side = (k & 3);
    const u = (h01(k * 2.71 + (o.salt || 0)) - 0.5) * w;
    const e = h01(k * 3.77 + (o.salt || 0));
    const out = hw * (0.62 + 0.38 * e);
    const rise = (o.up || 0.055) * Math.pow(e, 2.2);        // 翼角起翘
    const x = side === 1 ? cx + out : side === 3 ? cx - out : cx + u * 1.18;
    const z = side === 0 ? cz - out : side === 2 ? cz + out : cz + u * 1.18;
    const tip = e > 0.86 ? 1.24 : 1.0;
    emit(x, y + rise, z, ...shade(o.tint, tip), 0.8);
  }
  /* 斗拱:檐下那一排层层出挑的木块。它是中国木构最独特的构件 —— 有它,一眼是
     中国建筑;没有它,层檐塔和任何一座有屋檐的房子长得都差不多。 */
  for (let k = 0; k < nBracket; k++) {
    const side = (k & 3);
    const u = (Math.floor(h01(k * 7.3) * 7) / 7 - 0.5) * w * 0.86;   // 均匀排布,不是随机撒
    const step = Math.floor(h01(k * 9.1) * 3);                        // 三跳
    const out = hw * (0.52 + step * 0.09);
    const x = side === 1 ? cx + out : side === 3 ? cx - out : cx + u;
    const z = side === 0 ? cz - out : side === 2 ? cz + out : cz + u;
    emit(x, y - 0.012 - step * 0.008, z, ...shade(o.tint, 1.30 - step * 0.12), 0.7);
  }
}

/** 一圈柱子(列柱神庙、拱廊、干栏)。 */
function columns(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, w, d, y0, h } = o;
  const hw = w / 2, hd = d / 2;
  const per = Math.max(3, Math.min(10, Math.round(w * 11)));
  for (let k = 0; k < n; k++) {
    const i = k % (per * 2 + 2);
    let px, pz;
    if (i < per) { px = cx - hw + (i + 0.5) * (w / per); pz = cz - hd; }
    else if (i < per * 2) { px = cx - hw + (i - per + 0.5) * (w / per); pz = cz + hd; }
    else { px = cx + (i === per * 2 ? -hw : hw); pz = cz + (h01(k) - 0.5) * d; }
    const v = h01(k * 1.37 + (o.salt || 0));
    const a = h01(k * 2.53 + (o.salt || 0)) * TAU;
    const rad = (w / per) * 0.20 * (v > 0.93 ? 1.34 : v < 0.06 ? 1.22 : 1);   // 柱头柱础略粗
    const flute = (Math.floor(a / TAU * 8) % 2) ? 1.14 : 0.82;
    emit(px + Math.cos(a) * rad, y0 + v * h, pz + Math.sin(a) * rad, ...shade(o.tint, flute), 0.78);
  }
}

/** 一根尖:塔刹、相轮、方尖碑顶、避雷针、alem。 */
function spire(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, y0, h } = o;
  const rings = o.rings || 0;
  for (let k = 0; k < n; k++) {
    const u = k / Math.max(1, n);
    let rr = (o.r0 || 0.008) * (1 - u * 0.85);
    // 相轮:一串套在刹杆上的圆环
    if (rings && u < 0.7) {
      const band = Math.floor(u / 0.7 * rings);
      if ((band % 2) === 0) rr *= 3.1;
    }
    const a = h01(k * 3.9 + (o.salt || 0)) * TAU;
    emit(cx + Math.cos(a) * rr, y0 + u * h, cz + Math.sin(a) * rr,
         ...shade(o.tint, u > 0.82 ? 1.5 : 1.1), u > 0.82 ? 0.8 : 0.6);
  }
}

/** 女儿墙 / 城垛。 */
function crenel(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, w, d, y } = o;
  const hw = w / 2, hd = d / 2;
  const teeth = Math.max(3, Math.round(w * 9));
  for (let k = 0; k < n; k++) {
    const side = k % 4;
    const i = Math.floor(h01(k * 1.3 + (o.salt || 0)) * teeth);
    if (o.gap !== false && (i % 2)) continue;                 // 齿间的空当
    const f = (i + 0.5) / teeth - 0.5;
    const up = h01(k * 5.1) * (o.h || 0.028);
    const x = side === 1 ? cx + hw : side === 3 ? cx - hw : cx + f * w;
    const z = side === 0 ? cz - hd : side === 2 ? cz + hd : cz + f * d;
    emit(x, y + up, z, ...shade(o.tint, 1.06), 0.78);
  }
}

/** 一圈挑出来的平台:阳台、宣礼塔的 balcony、观景层。 */
function balcony(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, r, y } = o;
  for (let k = 0; k < n; k++) {
    const a = h01(k * 2.9 + (o.salt || 0)) * TAU;
    const rr = r * (1 + 0.22 * h01(k * 4.4));
    const up = h01(k * 6.6) * 0.020;
    emit(cx + Math.cos(a) * rr, y + up, cz + Math.sin(a) * rr, ...shade(o.tint, 1.14), 0.72);
  }
}

/** 正面的大台阶(金字塔、神庙、台基)。 */
function stairs(t, ctx, emit, o) {
  const n = o.n | 0; if (n <= 0) return;
  const { cx, cz, w, y0, h, depth } = o;
  const steps = o.steps || 10;
  for (let k = 0; k < n; k++) {
    const u = h01(k * 1.7 + (o.salt || 0));
    const rung = Math.floor(u * steps) / steps;
    emit(cx + (h01(k * 2.9) - 0.5) * w, y0 + rung * h, cz + depth * (1 - rung),
         ...shade(o.tint, 0.94 + 0.14 * h01(k * 3.3)), 0.78);
  }
}

/* ── 槽位:每个槽位是一组"可选件" ────────────────────────────────────────────
   件与件之间**互不知情** —— 台基不知道楼冠是什么。所以任意组合都成立,
   一个风格加一件,它的组合数就整体乘一遍。 */

/** 台基。返回楼身该从多高开始。 */
const BASES = {
  none: () => 0,
  plinth: (t, ctx, emit, n, P, pal) => {
    box(t, ctx, emit, { cx: t.cx, cz: t.cz, w: t.foot * 1.22, d: t.foot * 1.22,
                        y0: ctx.BASE, y1: ctx.BASE + t.h * 0.05, n, tint: pal.stone });
    return t.h * 0.05;
  },
  stylobate: (t, ctx, emit, n, P, pal) => {                    // 三层退台石基
    let y = ctx.BASE;
    for (let i = 0; i < 3; i++) {
      const w = t.foot * (1.34 - i * 0.07);
      box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d: w, y0: y, y1: y + t.h * 0.022,
                          n: Math.floor(n / 3), tint: shade(pal.stone, 1 - i * 0.06), salt: i });
      y += t.h * 0.022;
    }
    return y - ctx.BASE;
  },
  terrace: (t, ctx, emit, n, P, pal) => {                      // 高台 + 正面踏道
    const hh = t.h * 0.11;
    box(t, ctx, emit, { cx: t.cx, cz: t.cz, w: t.foot * 1.30, d: t.foot * 1.30,
                        y0: ctx.BASE, y1: ctx.BASE + hh, n: Math.floor(n * 0.7), tint: pal.stone });
    stairs(t, ctx, emit, { cx: t.cx, cz: t.cz, w: t.foot * 0.42, y0: ctx.BASE, h: hh,
                           depth: t.foot * 0.72, steps: 7, n: n - Math.floor(n * 0.7), tint: shade(pal.stone, 1.1) });
    return hh;
  },
  arcade: (t, ctx, emit, n, P, pal) => {                       // 底层架空的拱廊
    const hh = t.h * 0.14;
    columns(t, ctx, emit, { cx: t.cx, cz: t.cz, w: t.foot * 1.1, d: t.foot * 1.1,
                            y0: ctx.BASE, h: hh, n, tint: pal.stone });
    return hh;
  },
};

/** 楼身。每个都返回楼顶的高度和顶面的宽度,楼冠要靠它落位。 */
const BODIES = {
  tower: (t, ctx, emit, n, P, pal, y0, skin) => {              // 单塔
    const y1 = ctx.BASE + t.h;
    box(t, ctx, emit, { cx: t.cx, cz: t.cz, w: t.foot, d: t.foot, y0, y1, n, skin });
    return { y: y1, w: t.foot };
  },
  setback: (t, ctx, emit, n, P, pal, y0, skin) => {            // 退台高塔
    const tiers = P.int(2, 4);
    let y = y0, w = t.foot;
    for (let i = 0; i < tiers; i++) {
      const frac = (i === tiers - 1) ? 1 : 0.54 - i * 0.07;
      const yTop = y + (ctx.BASE + t.h - y) * frac;
      box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d: w, y0: y, y1: yTop,
                          n: Math.floor(n / tiers), skin, salt: i });
      y = yTop; w *= 0.70;
    }
    return { y, w };
  },
  taper: (t, ctx, emit, n, P, pal, y0, skin) => {              // 收分:越往上越细
    const seg = 6;
    let y = y0, w = t.foot;
    const step = (ctx.BASE + t.h - y0) / seg;
    for (let i = 0; i < seg; i++) {
      box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d: w, y0: y, y1: y + step,
                          n: Math.floor(n / seg), skin, salt: i });
      y += step; w *= 0.90;
    }
    return { y, w };
  },
  cylinder: (t, ctx, emit, n, P, pal, y0, skin) => {
    const r = t.foot * 0.46;
    cyl(t, ctx, emit, { cx: t.cx, cz: t.cz, r, y0, y1: ctx.BASE + t.h, n,
                        flutes: skin === 'fins' ? 16 : 0 });
    return { y: ctx.BASE + t.h, w: r * 2 };
  },
  twin: (t, ctx, emit, n, P, pal, y0, skin) => {               // 双塔,一高一矮
    const w = t.foot * 0.44, gap = t.foot * 0.28;
    const h2 = t.h * (0.62 + P.f() * 0.22);
    box(t, ctx, emit, { cx: t.cx - gap, cz: t.cz, w, d: w, y0, y1: ctx.BASE + t.h,
                        n: Math.floor(n * 0.56), skin });
    box(t, ctx, emit, { cx: t.cx + gap, cz: t.cz, w, d: w, y0, y1: ctx.BASE + h2,
                        n: n - Math.floor(n * 0.56), skin, salt: 9 });
    return { y: ctx.BASE + t.h, w, cx: t.cx - gap };
  },
  ell: (t, ctx, emit, n, P, pal, y0, skin) => {                // L 形
    const a = t.foot * 0.62, b = t.foot * 0.42;
    box(t, ctx, emit, { cx: t.cx - b * 0.3, cz: t.cz, w: a, d: b, y0, y1: ctx.BASE + t.h,
                        n: Math.floor(n * 0.58), skin });
    box(t, ctx, emit, { cx: t.cx + a * 0.28, cz: t.cz + b * 0.5, w: b, d: a * 0.8,
                        y0, y1: ctx.BASE + t.h * 0.72, n: n - Math.floor(n * 0.58), skin, salt: 4 });
    return { y: ctx.BASE + t.h, w: a };
  },
  stepped: (t, ctx, emit, n, P, pal, y0, skin) => {            // 阶梯金字塔 / 塔庙
    const steps = P.int(3, 6);
    let y = y0, w = t.foot * 1.32;
    for (let i = 0; i < steps; i++) {
      const hh = (ctx.BASE + t.h - y0) / steps;
      box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d: w, y0: y, y1: y + hh * 0.88,
                          n: Math.floor(n / steps), skin, salt: i });
      y += hh; w *= 0.79;
    }
    return { y, w };
  },
  tiered: (t, ctx, emit, n, P, pal, y0, skin) => {             // 层檐塔:楼身 + 一圈檐
    const tiers = P.int(3, 6);
    const bodyN = Math.floor(n * 0.60 / tiers), eaveN = Math.floor(n * 0.36 / tiers);
    let y = y0, w = t.foot * 1.02;
    const step = (ctx.BASE + t.h - y0) / tiers;
    for (let i = 0; i < tiers; i++) {
      box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d: w, y0: y, y1: y + step * 0.76,
                          n: bodyN, skin, salt: i });
      eave(t, ctx, emit, { cx: t.cx, cz: t.cz, w: w * 1.52, y: y + step * 0.76, n: eaveN,
                           tint: pal.roof, up: pal.up, dougong: pal.dougong, salt: i });
      y += step; w *= 0.86;
    }
    return { y, w };
  },
  hall: (t, ctx, emit, n, P, pal, y0, skin) => {               // 低矮的厅堂:墙 + 大屋顶
    const w = t.foot * 1.24, d = t.foot * 0.84;
    const wallH = y0 + (ctx.BASE + t.h - y0) * 0.52;
    box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d, y0, y1: wallH, n: Math.floor(n * 0.5), skin });
    gable(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d, y0: wallH, ridge: ctx.BASE + t.h,
                          n: n - Math.floor(n * 0.5), tint: pal.roof, overhang: pal.overhang || 1.2,
                          tiles: pal.tiles || 0 });
    return { y: ctx.BASE + t.h, w: w * 0.4, done: true };
  },
};

/** 楼冠。 */
const CROWNS = {
  none: () => {},
  parapet: (t, ctx, emit, n, P, pal, top) =>
    crenel(t, ctx, emit, { cx: t.cx, cz: t.cz, w: top.w, d: top.w, y: top.y, n,
                           tint: pal.stone, gap: false, h: 0.018 }),
  crenel: (t, ctx, emit, n, P, pal, top) =>
    crenel(t, ctx, emit, { cx: t.cx, cz: t.cz, w: top.w, d: top.w, y: top.y, n, tint: pal.stone }),
  spire: (t, ctx, emit, n, P, pal, top) =>
    spire(t, ctx, emit, { cx: top.cx != null ? top.cx : t.cx, cz: t.cz, y0: top.y,
                          h: t.h * (0.18 + P.f() * 0.22), n, tint: pal.accent }),
  finial: (t, ctx, emit, n, P, pal, top) =>                    // 相轮:一串圆环
    spire(t, ctx, emit, { cx: t.cx, cz: t.cz, y0: top.y, h: t.h * 0.20, n,
                          tint: pal.accent, rings: P.int(3, 6) }),
  dome: (t, ctx, emit, n, P, pal, top) =>
    dome(t, ctx, emit, { cx: t.cx, cz: t.cz, r: top.w * 0.58, y0: top.y, n,
                         tint: pal.roof, ribs: P.odds(0.5) ? 8 : 0 }),
  onion: (t, ctx, emit, n, P, pal, top) =>
    dome(t, ctx, emit, { cx: t.cx, cz: t.cz, r: top.w * 0.56, y0: top.y, n,
                         tint: pal.roof, onion: true, ribs: 10 }),
  hip: (t, ctx, emit, n, P, pal, top) =>                       // 四坡攒尖
    pyramid(t, ctx, emit, { cx: t.cx, cz: t.cz, r: top.w * 0.68, y0: top.y,
                            h: t.h * 0.16, sides: 4, n, tint: pal.roof }),
  pyramidion: (t, ctx, emit, n, P, pal, top) =>
    pyramid(t, ctx, emit, { cx: t.cx, cz: t.cz, r: top.w * 0.52, y0: top.y,
                            h: t.h * 0.10, sides: 4, n, tint: pal.accent }),
  gableTop: (t, ctx, emit, n, P, pal, top) =>
    gable(t, ctx, emit, { cx: t.cx, cz: t.cz, w: top.w * 1.16, d: top.w * 1.16, y0: top.y,
                          ridge: top.y + t.h * 0.20, n, tint: pal.roof,
                          overhang: 1.2, tiles: pal.tiles || 0 }),
  pagodaTop: (t, ctx, emit, n, P, pal, top) => {               // 一圈檐 + 塔刹
    eave(t, ctx, emit, { cx: t.cx, cz: t.cz, w: top.w * 1.7, y: top.y, n: Math.floor(n * 0.6),
                         tint: pal.roof, up: pal.up, dougong: pal.dougong });
    spire(t, ctx, emit, { cx: t.cx, cz: t.cz, y0: top.y, h: t.h * 0.18,
                          n: n - Math.floor(n * 0.6), tint: pal.accent, rings: 4 });
  },
  lantern: (t, ctx, emit, n, P, pal, top) => {                 // 顶上一间小亭子
    const w = top.w * 0.44;
    box(t, ctx, emit, { cx: t.cx, cz: t.cz, w, d: w, y0: top.y, y1: top.y + t.h * 0.09,
                        n: Math.floor(n * 0.62), tint: pal.accent, skin: 'lattice' });
    pyramid(t, ctx, emit, { cx: t.cx, cz: t.cz, r: w * 0.72, y0: top.y + t.h * 0.09,
                            h: t.h * 0.07, sides: 4, n: n - Math.floor(n * 0.62), tint: pal.roof });
  },
  antenna: (t, ctx, emit, n, P, pal, top) => {
    spire(t, ctx, emit, { cx: t.cx, cz: t.cz, y0: top.y, h: t.h * (0.24 + P.f() * 0.3),
                          n, tint: [0.75, 0.80, 0.88], r0: 0.004 });
  },
};

/** 附件:0–2 件。城市的"参差"大半来自这里。 */
const EXTRAS = {
  minaret: (t, ctx, emit, n, P, pal) => {                      // 宣礼塔:柱身 + 平台 + 尖
    const r = t.foot * 0.07, x = t.cx + t.foot * 0.72;
    cyl(t, ctx, emit, { cx: x, cz: t.cz - t.foot * 0.3, r, y0: ctx.BASE,
                        y1: ctx.BASE + t.h * 1.32, n: Math.floor(n * 0.6), tint: pal.stone });
    balcony(t, ctx, emit, { cx: x, cz: t.cz - t.foot * 0.3, r: r * 2.1,
                            y: ctx.BASE + t.h * 1.0, n: Math.floor(n * 0.2), tint: pal.accent });
    spire(t, ctx, emit, { cx: x, cz: t.cz - t.foot * 0.3, y0: ctx.BASE + t.h * 1.32,
                          h: t.h * 0.16, n: Math.floor(n * 0.2), tint: pal.accent });
  },
  wing: (t, ctx, emit, n, P, pal) => {                         // 侧翼
    box(t, ctx, emit, { cx: t.cx + t.foot * 0.72, cz: t.cz + t.foot * 0.16,
                        w: t.foot * 0.5, d: t.foot * 0.62, y0: ctx.BASE,
                        y1: ctx.BASE + t.h * (0.28 + P.f() * 0.22), n, skin: 'bands', salt: 3 });
  },
  balconies: (t, ctx, emit, n, P, pal) => {                    // 几圈挑出的阳台
    const rings = P.int(2, 4);
    for (let i = 0; i < rings; i++) {
      balcony(t, ctx, emit, { cx: t.cx, cz: t.cz, r: t.foot * 0.58,
                              y: ctx.BASE + t.h * (0.3 + i * 0.2), n: Math.floor(n / rings),
                              tint: pal.accent, salt: i });
    }
  },
  buttress: (t, ctx, emit, n, P, pal) => {                     // 扶壁
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      box(t, ctx, emit, { cx: t.cx + Math.cos(a) * t.foot * 0.52, cz: t.cz + Math.sin(a) * t.foot * 0.52,
                          w: t.foot * 0.13, d: t.foot * 0.13, y0: ctx.BASE,
                          y1: ctx.BASE + t.h * 0.46, n: Math.floor(n / 4), tint: pal.stone, salt: i });
    }
  },
  chimney: (t, ctx, emit, n, P, pal, top) => {
    box(t, ctx, emit, { cx: t.cx + t.foot * 0.22, cz: t.cz - t.foot * 0.18,
                        w: t.foot * 0.09, d: t.foot * 0.09, y0: ctx.BASE + t.h * 0.7,
                        y1: ctx.BASE + t.h * 1.06, n, tint: pal.stone, skin: 'brick' });
  },
  flag: (t, ctx, emit, n, P, pal) => {
    spire(t, ctx, emit, { cx: t.cx + t.foot * 0.34, cz: t.cz + t.foot * 0.3,
                          y0: ctx.BASE + t.h, h: t.h * 0.2, n, tint: pal.accent, r0: 0.003 });
  },
  frontStairs: (t, ctx, emit, n, P, pal) => {
    stairs(t, ctx, emit, { cx: t.cx, cz: t.cz, w: t.foot * 0.46, y0: ctx.BASE,
                           h: t.h * 0.4, depth: t.foot * 0.8, steps: 12, n, tint: shade(pal.stone, 1.05) });
  },
  colonnade: (t, ctx, emit, n, P, pal) => {                    // 前廊
    columns(t, ctx, emit, { cx: t.cx, cz: t.cz + t.foot * 0.6, w: t.foot * 1.1, d: t.foot * 0.12,
                            y0: ctx.BASE, h: t.h * 0.5, n, tint: pal.stone });
  },
};

/* ── 一栋楼 ─────────────────────────────────────────────────────────────── */

/** 按风格的词汇表,给这一栋楼**抽一套件**,然后拼出来。
 *  种子来自目录名 —— 同一个项目每次都是同一座城。 */
function compose(t, count, emit, ctx, style) {
  const S = style.slots;
  const P = picker(seedOf(t.name + '|' + style.id + '|' + t.kind));
  const pal = style.pal;
  const baseK = P.of(S.base), bodyK = P.of(S.body), skinK = P.of(S.skin), crownK = P.of(S.crown);
  const nExtra = P.odds(S.extraOdds == null ? 0.55 : S.extraOdds) ? (P.odds(0.28) ? 2 : 1) : 0;
  const extras = [];
  for (let i = 0; i < nExtra && S.extra.length; i++) {
    const e = P.of(S.extra);
    if (!extras.includes(e)) extras.push(e);
  }

  // 粒子怎么分:楼身最多,楼冠次之 —— 冠是识别度最高的部位,给太少就糊了
  const nBase = baseK === 'none' ? 0 : Math.round(count * 0.10);
  const nCrown = crownK === 'none' ? 0 : Math.round(count * 0.17);
  const nEx = extras.length ? Math.round(count * 0.13) : 0;
  const nBody = Math.max(1, count - nBase - nCrown - nEx);

  const lift = (BASES[baseK] || BASES.none)(t, ctx, emit, nBase, P, pal) || 0;
  const top = (BODIES[bodyK] || BODIES.tower)(t, ctx, emit, nBody, P, pal, ctx.BASE + lift, skinK)
              || { y: ctx.BASE + t.h, w: t.foot };
  // hall 自带屋顶,再扣一顶冠就成了帽子上摞帽子
  if (!top.done) (CROWNS[crownK] || CROWNS.none)(t, ctx, emit, nCrown, P, pal, top);
  for (const e of extras) (EXTRAS[e] || (() => {}))(t, ctx, emit, Math.floor(nEx / extras.length), P, pal, top);
}

/* ── 不是"楼"的两种:树林和小屋群 ─────────────────────────────────────────── */

function grove(t, count, emit, ctx, o) {
  const hw = t.foot * 0.58;
  const nTree = Math.max(3, Math.min(9, Math.round(t.files / 6)));
  const leaf = o.leaf || [0.20, 0.52, 0.28];
  const trees = [];
  for (let i = 0; i < nTree; i++) {
    const a = (i / nTree) * TAU + (i % 3) * 0.5;
    const rr = hw * (0.30 + 0.62 * ((i * 7) % 5) / 5);
    trees.push({ x: t.cx + Math.cos(a) * rr, z: t.cz + Math.sin(a) * rr, h: 0.10 + ((i * 13) % 7) / 7 * 0.10 });
  }
  for (let k = 0; k < count; k++) {
    if (h01(k * 1.19) < 0.30) {
      const a = h01(k * 2.31) * TAU, rr = Math.sqrt(h01(k * 3.53)) * hw;
      emit(t.cx + Math.cos(a) * rr, ctx.BASE + 0.004 + h01(k * 4.7) * 0.012, t.cz + Math.sin(a) * rr,
           leaf[0] * 0.7, leaf[1] * 0.72, leaf[2] * 0.7, 0.7);
      continue;
    }
    const tr = trees[(h01(k * 5.9) * trees.length) | 0];
    const v = h01(k * 6.7), a = h01(k * 7.3) * TAU;
    let rr, y = ctx.BASE + v * tr.h;
    if (o.tree === 'palm') {
      if (v < 0.72) rr = 0.008;
      else { rr = 0.052 * Math.sin((v - 0.72) / 0.28 * Math.PI); y = ctx.BASE + tr.h * (0.72 + (v - 0.72) * 0.5); }
    } else if (o.tree === 'round') {
      rr = v < 0.34 ? 0.007 : 0.040 * Math.sin((v - 0.34) / 0.66 * Math.PI);
    } else {
      rr = 0.032 * (1 - v * 0.92);
    }
    const g = 0.72 + 0.5 * v;
    emit(tr.x + Math.cos(a) * rr, y, tr.z + Math.sin(a) * rr,
         Math.min(1, leaf[0] * g), Math.min(1, leaf[1] * g), Math.min(1, leaf[2] * g), 0.72);
  }
}

/** 小屋群:配置目录。**每间都自己抽一次**,所以一片小屋也是参差的。 */
function huts(t, count, emit, ctx, pal, o) {
  const nHut = Math.max(3, Math.min(7, Math.round(t.files / 8) + 2));
  const side = Math.ceil(Math.sqrt(nHut));
  const cellW = t.foot * 1.16 / side;
  const per = Math.max(1, Math.floor(count / nHut));
  for (let i = 0; i < nHut; i++) {
    const P = picker(seedOf(t.name + '#' + i));
    const hx = t.cx + (i % side + 0.5) * cellW - t.foot * 0.58;
    const hz = t.cz + (Math.floor(i / side) + 0.5) * cellW - t.foot * 0.58;
    const hs = cellW * (0.50 + P.f() * 0.20);
    const hh = t.h * (0.55 + P.f() * 0.55);
    // bands MUST come along. wallAt() reads t.bands to pick the language colour
    // at a given height, and a hut built without them crashed the whole city
    // (`t.bands.length` of undefined) for any config-kind directory drawn with
    // a plain skin and no tint. Inheriting is also what it should mean: a hut
    // cluster is still that directory, so it is still that directory's colours.
    const sub = { cx: hx, cz: hz, foot: hs, h: hh, name: t.name + i, kind: t.kind,
                  files: 1, age: t.age, churn: 0, bands: t.bands, rgb: t.rgb };
    const wallN = Math.floor(per * (o.roof === 'flat' ? 1 : 0.66));
    box(sub, ctx, emit, { cx: hx, cz: hz, w: hs, d: hs, y0: ctx.BASE, y1: ctx.BASE + hh,
                          n: wallN, skin: o.skin || 'plain', salt: i });
    if (o.roof === 'gable') {
      gable(sub, ctx, emit, { cx: hx, cz: hz, w: hs * 1.14, d: hs * 1.14, y0: ctx.BASE + hh,
                              ridge: ctx.BASE + hh * 1.42, n: per - wallN, tint: o.roofRgb || pal.roof,
                              overhang: 1.1, tiles: pal.tiles || 0, salt: i });
    } else if (o.roof === 'curve') {
      eave(sub, ctx, emit, { cx: hx, cz: hz, w: hs * 1.6, y: ctx.BASE + hh, n: per - wallN,
                             tint: o.roofRgb || pal.roof, up: 0.05, dougong: pal.dougong, salt: i });
    } else if (o.roof === 'dome') {
      dome(sub, ctx, emit, { cx: hx, cz: hz, r: hs * 0.52, y0: ctx.BASE + hh, n: per - wallN,
                             tint: o.roofRgb || pal.roof, onion: true, salt: i });
    }
  }
}

/* ── 风格表 ─────────────────────────────────────────────────────────────────
   一个风格 = 一张**词汇表** + 一组材料色。件都是共用的,风格只决定哪些件能用。
   `free: true` 的那一种所有人都能用;其余的发布到广场时要 Pro(生成和预览不要)。 */

const SLATE = [0.26, 0.34, 0.42];
const TILE = [0.30, 0.42, 0.40];
const VERMILION = [0.72, 0.24, 0.18];
const SAND = [0.84, 0.72, 0.50];
const MARBLE = [0.88, 0.86, 0.79];
const LIME = [0.74, 0.72, 0.62];
const TURQUOISE = [0.22, 0.62, 0.66];
const TIMBER = [0.44, 0.30, 0.20];
const GOLD = [0.92, 0.78, 0.36];
const STEEL = [0.62, 0.68, 0.78];

function mk(id, zh, en, blurb, pal, slots, special, free) {
  return { id, zh, en, blurb, pal, slots, special, free: !!free,
    build: {
      source: (t, c, e, x) => compose(t, c, e, x, byId[id]),
      test: (t, c, e, x) => compose(t, c, e, x, byId[id + '@test']),
      assets: (t, c, e, x) => compose(t, c, e, x, byId[id + '@assets']),
      docs: (t, c, e, x) => grove(t, c, e, x, special.docs),
      config: (t, c, e, x) => huts(t, c, e, x, pal, special.config),
    } };
}

const CITY_STYLES = [
  mk('modern', '现代', 'Modern',
    { zh: '玻璃幕墙、退台高塔、桁架与天线', en: 'Curtain walls, setbacks, masts' },
    { roof: SLATE, stone: [0.52, 0.56, 0.62], accent: STEEL, timber: TIMBER },
    { base: ['none', 'plinth', 'terrace', 'arcade'],
      body: ['tower', 'setback', 'taper', 'cylinder', 'twin', 'ell'],
      skin: ['glass', 'fins', 'bands', 'grid'],
      crown: ['parapet', 'antenna', 'lantern', 'none', 'spire'],
      extra: ['wing', 'balconies', 'chimney', 'flag'] },
    { docs: {}, config: { roof: 'gable' } }, true),

  mk('tang', '唐宋木构', 'Tang Dynasty',
    { zh: '层层出檐、斗拱与朱柱青瓦', en: 'Tiered eaves, dougong brackets, green tile' },
    { roof: TILE, stone: [0.66, 0.62, 0.56], accent: VERMILION, timber: VERMILION,
      up: 0.075, dougong: true, tiles: 9, overhang: 1.4 },
    { base: ['terrace', 'plinth', 'stylobate'],
      body: ['tiered', 'hall', 'setback', 'tower'],
      skin: ['timber', 'lattice', 'plain'],
      crown: ['pagodaTop', 'hip', 'finial', 'gableTop'],
      extra: ['colonnade', 'frontStairs', 'wing', 'flag'] },
    { docs: { tree: 'round', leaf: [0.24, 0.46, 0.28] }, config: { roof: 'curve' } }),

  mk('edo', '江户天守', 'Edo Japan',
    { zh: '白壁黑瓦、陡坡层塔与鯱吻', en: 'White keeps, steep dark roofs' },
    { roof: SLATE, stone: [0.80, 0.79, 0.74], accent: GOLD, timber: [0.28, 0.24, 0.22],
      up: 0.042, dougong: true, tiles: 12, overhang: 1.25 },
    { base: ['stylobate', 'terrace', 'plinth'],
      body: ['tiered', 'hall', 'taper'],
      skin: ['plain', 'timber', 'lattice'],
      crown: ['pagodaTop', 'hip', 'gableTop'],
      extra: ['frontStairs', 'wing', 'colonnade'] },
    { docs: { tree: 'round', leaf: [0.30, 0.44, 0.30] }, config: { roof: 'gable', roofRgb: SLATE } }),

  mk('giza', '古埃及', 'Ancient Egypt',
    { zh: '砂岩锥体、方尖碑与列柱厅', en: 'Sandstone pyramids, obelisks, hypostyle halls' },
    { roof: SAND, stone: SAND, accent: GOLD, timber: [0.56, 0.44, 0.28] },
    { base: ['stylobate', 'terrace', 'none'],
      body: ['stepped', 'taper', 'tower', 'hall'],
      skin: ['brick', 'bands', 'plain'],
      crown: ['pyramidion', 'parapet', 'none'],
      extra: ['colonnade', 'frontStairs', 'buttress'] },
    { docs: { tree: 'palm', leaf: [0.42, 0.54, 0.26] }, config: { roof: 'flat', skin: 'brick' } }),

  mk('hellas', '古希腊', 'Ancient Greece',
    { zh: '大理石列柱、三角山花与圆形神庙', en: 'Marble colonnades, pediments, tholoi' },
    { roof: LIME, stone: MARBLE, accent: [0.86, 0.72, 0.44], timber: TIMBER, tiles: 7 },
    { base: ['stylobate', 'terrace'],
      body: ['hall', 'cylinder', 'tower', 'ell'],
      skin: ['columns', 'plain', 'bands', 'arches'],
      crown: ['gableTop', 'dome', 'parapet'],
      extra: ['colonnade', 'frontStairs', 'buttress'] },
    { docs: { tree: 'round', leaf: [0.46, 0.52, 0.30] }, config: { roof: 'gable', roofRgb: MARBLE } }),

  mk('maya', '玛雅', 'Maya',
    { zh: '丛林里的阶梯神庙与宽大踏道', en: 'Jungle step-temples and broad stairs' },
    { roof: [0.62, 0.56, 0.42], stone: [0.74, 0.70, 0.58], accent: [0.82, 0.44, 0.30], timber: TIMBER },
    { base: ['terrace', 'stylobate', 'none'],
      body: ['stepped', 'hall', 'tower'],
      skin: ['brick', 'lattice', 'bands'],
      crown: ['lantern', 'crenel', 'none'],
      extra: ['frontStairs', 'colonnade', 'wing'] },
    { docs: { tree: 'palm', leaf: [0.18, 0.50, 0.24] }, config: { roof: 'gable', roofRgb: [0.52, 0.44, 0.28] } }),

  mk('persia', '波斯', 'Persia',
    { zh: '蓝釉洋葱穹顶、宣礼塔与拼花拱廊', en: 'Turquoise onion domes, minarets, tilework' },
    { roof: TURQUOISE, stone: SAND, accent: GOLD, timber: TIMBER },
    { base: ['arcade', 'plinth', 'terrace'],
      body: ['cylinder', 'tower', 'hall', 'twin'],
      skin: ['mosaic', 'arches', 'lattice', 'brick'],
      crown: ['onion', 'dome', 'lantern'],
      extra: ['minaret', 'colonnade', 'balconies'], extraOdds: 0.8 },
    { docs: { tree: 'palm', leaf: [0.24, 0.50, 0.34] }, config: { roof: 'dome', roofRgb: TURQUOISE } }),

  mk('norse', '北欧木构', 'Norse',
    { zh: '陡坡叠檐的木板教堂与长屋', en: 'Stave churches and longhouses' },
    { roof: TIMBER, stone: [0.56, 0.54, 0.50], accent: [0.78, 0.66, 0.42], timber: TIMBER,
      up: 0.0, tiles: 14, overhang: 1.3 },
    { base: ['plinth', 'none', 'terrace'],
      body: ['tiered', 'hall', 'taper'],
      skin: ['timber', 'plain'],
      crown: ['gableTop', 'spire', 'finial'],
      extra: ['buttress', 'chimney', 'wing', 'flag'] },
    { docs: { tree: 'cone', leaf: [0.16, 0.40, 0.30] }, config: { roof: 'gable', roofRgb: TIMBER } }),
];

/* test / assets 用同一张词汇表,但**偏向矮和宽** —— 测试目录和素材目录在城市里
   本来就该是厂房和仓库,不是主楼。同一个风格里长得像亲戚,又不是双胞胎。 */
const byId = {};
for (const s of CITY_STYLES) {
  byId[s.id] = s;
  byId[s.id + '@test'] = Object.assign({}, s, {
    id: s.id + '@test',
    slots: Object.assign({}, s.slots, {
      body: s.slots.body.filter((b) => b === 'hall' || b === 'ell' || b === 'stepped').concat(['hall']),
      crown: s.slots.crown.filter((c) => c !== 'antenna' && c !== 'spire').concat(['none']),
    }),
  });
  byId[s.id + '@assets'] = Object.assign({}, s, {
    id: s.id + '@assets',
    slots: Object.assign({}, s.slots, {
      body: s.slots.body.filter((b) => b === 'cylinder' || b === 'stepped' || b === 'tower').concat(['cylinder']),
      skin: s.slots.skin.filter((k) => k !== 'glass').concat(['bands']),
    }),
  });
}

const DEFAULT_STYLE = 'modern';
const BY_ID = Object.fromEntries(CITY_STYLES.map((s) => [s.id, s]));
/** 不认识的风格 id 一律退回现代 —— 胶囊是别人机器上传过来的,不能信。 */
function styleOf(id) { return BY_ID[id] || BY_ID[DEFAULT_STYLE]; }
/** 这个风格要不要 Pro 才能发布(生成和预览永远免费)。 */
function styleNeedsPro(id) { return !styleOf(id).free; }

/** 这个风格能拼出多少种不重样的楼 —— 界面上写给人看的,也是这套语法的意义所在。 */
function styleVariants(id) {
  const s = styleOf(id).slots;
  const ex = s.extra.length;
  const combosOfExtras = 1 + ex + (ex * (ex - 1)) / 2;      // 挑 0、1、2 件
  return s.base.length * s.body.length * s.skin.length * s.crown.length * combosOfExtras;
}


/* ── wallpaper-project.js: only what sampleCity needs ────────────────────── */
function hash01c(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

function sampleLabel(name, n, maxAspect) {
  const H = 44, PAD = 4;
  const probe = document.createElement('canvas').getContext('2d');
  const font = `700 ${H}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif`;
  probe.font = font;
  let t = String(name || '').trim();
  if (!t) return null;
  while (t.length > 3 && probe.measureText(t).width / H > maxAspect) t = t.slice(0, -1);
  if (t !== String(name).trim()) t = t.slice(0, -1) + '…';
  const w = Math.max(8, Math.ceil(probe.measureText(t).width) + PAD * 2);

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = H + PAD * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(t, cv.width / 2, cv.height / 2);

  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const lit = [];
  for (let i = 0; i < d.length; i += 4) if (d[i] > 90) lit.push(i);
  if (!lit.length) return null;
  const pts = new Float32Array(n * 2);
  for (let p = 0; p < n; p++) {
    // 和图、字同一套:按扫描顺序等距取,不散列 —— 散列取样保不住字的骨架。
    const i = lit[Math.floor(p * lit.length / n)];
    const px = (i / 4) % cv.width, py = Math.floor((i / 4) / cv.width);
    pts[p * 2] = (px + 0.5) / cv.width - 0.5;
    pts[p * 2 + 1] = 0.5 - (py + 0.5) / cv.height;
  }
  return { pts, aspect: cv.width / cv.height };
}

function human(bytes) {
  const b = +bytes || 0;
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'GB';
  if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + 'MB';
  if (b >= 1e3) return Math.round(b / 1e3) + 'KB';
  return b + 'B';
}

function since(days) {
  const d = +days;
  if (!Number.isFinite(d) || d >= 9999) return '';
  if (d <= 0) return 'today';
  if (d < 7) return d + 'd';
  if (d < 60) return Math.round(d / 7) + 'w';
  if (d < 730) return Math.round(d / 30) + 'mo';
  return Math.round(d / 365) + 'y';
}

const CITY_PITCH = 26 * Math.PI / 180;

const CITY_YAW = -22 * Math.PI / 180;

const KIND_RGB = {
  assets: [0.83, 0.66, 0.38],   // 砂黄:粮仓
  docs:   [0.42, 0.68, 0.46],   // 草绿:公园
  config: [0.48, 0.55, 0.68],   // 石板蓝:工棚
  test:   [0.62, 0.55, 0.72],   // 淡紫:厂房
  source: [0.54, 0.54, 0.56],
};

function sampleCity(dirs, n, styleId, links, commits, grow) {
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  // 每颗粒子画多大。楼身、地面、窗、标签要的点各不一样 —— 一个 40px 高的名字拿画
  // 楼那种点去画就是一条实心色带。
  const scale = new Float32Array(n); scale.fill(0.82);
  const list = (dirs || []).filter((d) => d && (d.files > 0 || d.bytes > 0)).slice(0, 16);
  if (!list.length || n <= 0) return { target, color, scale, used: 0 };

  // 体量:代码字节为主,没有代码的目录(文档、素材)按文件数折算 —— 否则一座
  // 两百张图的素材库高度是 0,城市里就少了这一块。
  const massOf = (d) => Math.max(+d.bytes || 0, (+d.files || 0) * 2000);
  const maxM = Math.max(1, ...list.map(massOf));
  /* ⚠ HEIGHT IS LOGARITHMIC, and it has to be.
     Every real repository has one directory that dwarfs the rest — a landing
     folder full of images, a build output, a vendored dependency. Measured on
     this project: `landing` is 115MB and the next building is 2.9MB, a spread
     of forty to one. Against a linear scale that is one skyscraper standing on
     a plain of stubs a few pixels high, and on a phone, where the whole city is
     scaled down to fit, those stubs read as a flat dotted haze — which is
     exactly how "the code city does not render" was reported.

     A log scale is the standard answer for data spanning three orders of
     magnitude, and this file already uses ln(bytes) for hotspot heat. Order is
     preserved — the biggest is still the tallest — but every building keeps a
     height you can compare. */
  const minM = Math.max(1, Math.min(...list.map(massOf)));
  const lgMin = Math.log(1 + minM), lgMax = Math.log(1 + maxM);
  const lgSpan = Math.max(1e-6, lgMax - lgMin);
  // All one size (a repo of equal folders) → everything at mid height rather
  // than a divide-by-nothing that puts the whole city at zero.
  const heightOf = (d) => (lgMax - lgMin < 1e-6
    ? 0.6
    : (Math.log(1 + massOf(d)) - lgMin) / lgSpan);

  /* 时钟的两个常量。GROW 夹在 (0,1]:0 会让整座城市空掉,而一幕什么都没有的
     城市和"城市坏了"在屏幕上一模一样。maxAge 保底 1,免得所有目录同龄时除以零。 */
  const GROW = (grow === undefined || grow === null) ? 1 : Math.max(0.001, Math.min(1, +grow || 0));
  const maxAge = Math.max(1, ...list.map((d) => (Number.isFinite(+d.age_days) ? +d.age_days : 0)));
  /* ⚠ 老胶囊的目录**根本没有 age_days**(扫描器后来才加的),于是每一座的年龄都是 0,
     也就是"全都是今天新建的" —— 出生时刻算出来全是 0.78,时钟走到 0.78 之前
     这座城市**一座楼都没有**。空城和"城市坏了"在屏幕上一模一样,而且不会报错。
     没有年龄可比就没有先后可言:那就让所有楼从一开始就在,只是一起往上长。 */
  const ordered = list.filter((d) => +d.age_days > 0).length >= 2;
  const maxF = Math.max(1, ...list.map((d) => +d.files || 0));
  const maxChurn = Math.max(0, ...list.map((d) => +d.churn || 0));
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows = Math.ceil(list.length / cols);
  const cell = 2 / cols;

  /* 座次:**耦合强的排在一起**。
     关系这件事最好的表达不是画一根线,是**位置** —— 位置是所有视觉通道里最强的
     一个(Bertin),而且它不占任何额外的笔墨:两块代码来往密,它们的楼就是邻居,
     这件事不需要标注,看一眼就在那儿。
     贪心排:先放最大的那座,之后每次挑"和已经放下的那些牵连最深"的一座接上去。
     没有图谱时退回按体量排 —— 城市照样有重心。 */
  const link = (Array.isArray(links) ? links : [])
    .map((l) => [l[0] | 0, l[1] | 0, Math.max(1, l[2] | 0)])
    .filter((l) => l[0] !== l[1] && l[0] < list.length && l[1] < list.length);
  const bond = (a, b) => { let w = 0; for (const l of link) if ((l[0] === a && l[1] === b) || (l[0] === b && l[1] === a)) w += l[2]; return w; };
  let order = list.map((_, i) => i);
  if (link.length) {
    const left = new Set(order);
    const seat = [];
    let cur = 0;                                   // list 已按体量排好,0 就是主楼
    left.delete(cur); seat.push(cur);
    while (left.size) {
      let best = -1, bw = -1;
      for (const c of left) {
        let w = 0;
        for (const placed of seat) w += bond(c, placed);
        // 平手时按体量(list 的原顺序)—— 否则同一颗胶囊每次扫出来的城市都在换位置
        if (w > bw || (w === bw && best >= 0 && c < best)) { bw = w; best = c; }
      }
      left.delete(best); seat.push(best);
    }
    order = seat;
  }
  const seatOf = new Array(list.length);
  order.forEach((li, pos) => { seatOf[li] = pos; });

  const towers0 = list.map((d, i) => {
    const kind = String(d.kind || 'source');
    const seat = seatOf[i];
    const cx = (seat % cols + 0.5) * cell - 1;
    const cz = (Math.floor(seat / cols) + 0.5) * (2 / rows) - 1;
    // 占地 ∝ √文件数(面积才是文件数,边长要开方),留出街道
    const foot = cell * (0.30 + 0.46 * Math.sqrt((+d.files || 0) / maxF));
    // 楼高压过一道 0.6 次幂:一个仓库里最大的目录常常比第二大的多一个数量级,
    // 线性画的话除了它以外全是地板。
    // 0.30 floor rather than 0.14: the smallest building is still a building,
    // and at a phone's scale anything under that is not a shape, it is a smudge.
    let h = 0.30 + 1.00 * heightOf(d);
    /* 时钟。age_days 是"这块结构有多老",所以最老的那座最先立起来 —— 把年龄摊到
       0..1 上就是它的出生时刻。⚠ 一座楼不是"啪"地出现的:出生后给它一小段时间
       往上长(RAMP),否则整幕就是几次跳变,不是生长。 */
    if (GROW < 1) {
      const RAMP = 0.22;
      /* ⚠ 出生时刻要压进 [0, 1−RAMP],不能直接用 1−age/maxAge。直接用的话,**最新**
         的那座楼出生在 0.93,到 GROW=1 时才长了三成 —— 而 GROW=1 画的是今天,
         必须和没有时钟时逐位相同。于是最后一拍会"啪"地跳一下,那一跳没有任何
         报错,只是看起来像掉了一帧。压完之后每一座都在时钟走到头之前长满。 */
      const born = ordered
        ? (1 - Math.min(1, (Number.isFinite(+d.age_days) ? +d.age_days : 0) / maxAge)) * (1 - RAMP)
        : 0;
      const t = (GROW - born) / RAMP;
      if (t <= 0) return null;                    // 那时候还没有这个目录
      h *= Math.min(1, t);
    }
    // 形状决定体量的读法:厂房是趴着的,公园是平的,圆仓是矮胖的。
    if (kind === 'test') h *= 0.42;
    if (kind === 'docs') h *= 0.10;
    if (kind === 'assets') h *= 0.55;
    if (kind === 'config') h *= 0.30;
    // 语言色带:底下是第一语言,往上依次换。一座 60% Rust / 40% TS 的楼看得出是混的。
    const mix = (Array.isArray(d.langs) ? d.langs : [])
      .map((x) => [String((x && x[0]) || ''), Math.max(0, +(x && x[1]) || 0)])
      .filter((x) => x[0] && x[1] > 0.02);
    const msum = mix.reduce((a, x) => a + x[1], 0) || 1;
    let acc = 0;
    const bands = mix.map(([l, f]) => { acc += f / msum; return { rgb: langRgb(l), upto: acc }; });
    if (bands.length) bands[bands.length - 1].upto = 1.001;
    // 退台:目录埋得越深,塔收得越多层。这是"这块结构有多深"唯一能看见的地方,
    // 也是这座城市天际线不至于全是一样方盒子的原因。
    const tiers = kind === 'source' ? Math.max(1, Math.min(3, (+d.depth || 1) - 1)) : 1;
    const age = +d.age_days;
    return {
      kind, cx, cz, foot, h, bands: bands.length ? bands : [{ rgb: KIND_RGB[kind] || langRgb(''), upto: 1.001 }],
      tiers, name: d.name,
      files: +d.files || 0,
      bytesRaw: +d.bytes || 0,
      age: Number.isFinite(age) ? age : 9999,
      churn: +d.churn || 0,
      rgb: d.lang ? langRgb(d.lang) : (KIND_RGB[kind] || langRgb('')),
      w: Math.sqrt(Math.max(1, massOf(d))),
    };
  });

  /* ⚠ 还没出生的那些被上面返回成了 null,要在这儿滤掉 —— 留着的话 wSum、
     包围盒和点的分配都会把它们算进去,于是画面里出现一片"看不见但占着地方"的
     楼:城市会莫名其妙地偏到一边,而且没有任何报错。 */
  const towers = towers0.filter(Boolean);
  if (!towers.length) return { target, color, scale, used: 0 };

  const wSum = towers.reduce((a, t) => a + t.w, 0) || 1;
  const nGround = Math.round(n * 0.05);
  const nLabels = Math.min(3, towers.length);
  const nLabelPts = nLabels ? Math.round(n * 0.09) : 0;
  // 提交天际线:53 周 × 7 天,摆在城市**后面**的一条带子。城市有结构、有材料、
  // 有关系,唯独没有时间;这条带子就是时间,而且过去理应在身后。
  const days = Array.isArray(commits) ? commits : [];
  const nSkyPts = days.some((v) => v > 0) ? Math.round(n * 0.09) : 0;
  // 屋顶牌:**每一座**都要有名字。街上那三块是"这个仓库主要是什么",屋顶牌是
  // "我现在看的这座是什么" —— 一座认不出名字的楼,再好看也只是装饰。
  const nTags = Math.min(12, towers.length);
  const nTagPts = Math.round(n * 0.10);
  // 地脉:关系那一层。**不是线** —— 是两块街区之间被踩出来的一片低低的、不匀的光。
  const paths = link.filter((l) => towers[l[0]] && towers[l[1]]);
  const nPathPts = paths.length ? Math.round(n * 0.11) : 0;
  const nTowers = n - nGround - nLabelPts - nTagPts - nPathPts - nSkyPts;
  const floorShare = Math.floor(nTowers / (towers.length * 4));
  let p = 0;

  const cp = Math.cos(CITY_PITCH), sp = Math.sin(CITY_PITCH);
  const cy_ = Math.cos(CITY_YAW), sy = Math.sin(CITY_YAW);
  const put = (x, y, z, r, g, b, sc) => {
    const x1 = x * cy_ + z * sy;
    const z1 = -x * sy + z * cy_;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const o = p * 3;
    target[o] = x1; target[o + 1] = y2; target[o + 2] = z2;
    color[o] = r; color[o + 1] = g; color[o + 2] = b;
    if (sc) scale[p] = sc;
    p++;
  };

  const BASE = -0.55;

  /* ── ① 地面:街道,不是一片噪点 ──
     第一版地面是随机撒的灰点,读起来像"楼下面有灰尘"。改成**街网 + 每栋楼的地台**:
     同样的粒子数,城市一下子就站住了,而且街网还顺带把网格布局说清楚了。 */
  {
    const g0 = 0.20, g1 = 0.26, g2 = 0.34;
    const half = nGround >> 1;
    for (let k = 0; k < half && p < nGround; k++) {
      // 街:沿格子边界的两组线
      const along = Math.random() * 2 - 1;
      const line = Math.floor(Math.random() * (cols + 1)) * cell - 1;
      const jitter = (Math.random() - 0.5) * 0.012;
      if (k & 1) put(line + jitter, BASE - 0.004, along, g0, g1, g2, 0.62);
      else put(along, BASE - 0.004, line + jitter, g0, g1, g2, 0.62);
    }
    // 地台:每栋楼脚下一圈亮一点的方框,把建筑和街面分开
    while (p < nGround) {
      const t = towers[(Math.random() * towers.length) | 0];
      const r = t.foot / 2 + 0.022;
      const u = (Math.random() - 0.5) * 2 * r;
      const e = Math.random() < 0.5;
      const [br, bg, bb] = t.rgb;
      put(t.cx + (e ? u : (Math.random() < 0.5 ? -r : r)),
          BASE - 0.002,
          t.cz + (e ? (Math.random() < 0.5 ? -r : r) : u),
          br * 0.30 + 0.10, bg * 0.30 + 0.10, bb * 0.30 + 0.10, 0.66);
    }
  }

  /* ── ② 建筑 ──
     一座全是方盒子的城市只能看出"大小",而形状能多说一件事:**这块是干什么的**。
     测试是趴着的厂房、文档是一片带树的公园、素材是圆仓、配置是一堆小屋、源码是塔。
     形状这一层是免费的信息 —— 它不占胶囊里任何一个额外的字节,只是把 kind 画出来。 */

  /** 这个高度上该是什么颜色:语言色带 + 越高越亮。 */
  const wallAt = (t, fy) => {
    // Guarded: an archetype that forgets to pass bands should lose its colour
    // banding, not take the entire wallpaper down with a TypeError.
    let rgb = (t.bands && t.bands.length) ? t.bands[t.bands.length - 1].rgb : t.rgb;
    for (const b of t.bands) if (fy <= b.upto) { rgb = b.rgb; break; }
    const lift = 0.52 + 0.42 * fy;
    return [Math.min(1, rgb[0] * lift), Math.min(1, rgb[1] * lift), Math.min(1, rgb[2] * lift)];
  };

  /** 窗户亮着的比例。**这是"这块代码还活着吗"在屏幕上的样子** ——
   *  昨天动过的楼灯火通明,两年没碰的黑着。城市里最会讲故事的一层。 */
  const litRatio = (age) => (age <= 7 ? 0.72 : age <= 45 ? 0.44 : age <= 200 ? 0.22 : age <= 800 ? 0.09 : 0.03);

  /* 建筑本身交给**风格**去长(见 city-styles.js)。这里只负责:分多少颗粒子给谁、
     那个高度该是什么颜色、窗该亮几成 —— 也就是**所有风格共用的那部分事实**。
     形状换了,读数不能跟着换:高度永远是代码量,灯永远是"最近动过没有"。 */
  const style = styleOf(styleId || DEFAULT_STYLE);
  const ctx = { BASE, wallAt, lit: (t) => litRatio(t.age) };

  const towerEnd = nGround + nTowers;
  // 建筑往里吐粒子的口子。**配额在这里挡**,不在每个原型里挡 —— 原型只管形状,
  // 一个写漏了边界检查的原型不该能把整个缓冲区写爆。
  const emit = (x, y, z, r, g, b, sc) => { if (p < towerEnd) put(x, y, z, r, g, b, sc); };
  for (let i = 0; i < towers.length && p < towerEnd; i++) {
    const t = towers[i];
    const share = Math.max(floorShare, Math.round(nTowers * t.w / wSum));
    const take = Math.min(share, towerEnd - p);
    const build = style.build[t.kind] || style.build.source;
    build(t, take, emit, ctx);
    // 信标:改动最勤的那座楼顶上立一根,尖是热的。城市里"现在正在动的是这一块"。
    // 它**不属于任何风格** —— 唐塔和金字塔上都该看得出哪一块正在被改。
    if (t.churn > 0 && t.churn === maxChurn && maxChurn >= 3 && p < towerEnd) {
      const mast = Math.min(200, towerEnd - p);
      for (let k = 0; k < mast; k++) {
        const u = k / mast;
        const hot = u > 0.82;
        put(t.cx + (Math.random() - 0.5) * 0.004, BASE + t.h + u * t.h * 0.30, t.cz + (Math.random() - 0.5) * 0.004,
            hot ? 1.0 : 0.95, hot ? 0.42 : 0.78, hot ? 0.30 : 0.55, hot ? 0.9 : 0.5);
      }
    }
  }

  /* ── ③ 提交天际线 ──
     53 周 × 7 天,一天一根小柱子,高度 = 那天的提交数。GitHub 贡献图立起来。

     摆在城市**背后**:这是这座城是怎么盖起来的,过去理应在身后。摆前面就得和
     名字那一排抢位置,而且会把"现在"挡在"过去"后面。 */
  if (nSkyPts > 0) {
    const skyEnd = p + nSkyPts;
    const COLS = 53, ROWS = 7;
    const maxDay = Math.max(1, ...days);
    const x0 = -1.02, x1 = 1.02, z0 = -1.22, z1 = -1.70;
    const cw = (x1 - x0) / COLS, cd = (z1 - z0) / ROWS;
    const total = days.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) || 1;
    const per = Math.max(2, Math.floor(nSkyPts / total));
    for (let i = 0; i < days.length && p < skyEnd; i++) {
      const v = days[i] | 0;
      if (v <= 0) continue;
      const col = Math.floor(i / ROWS), row = i % ROWS;
      if (col >= COLS) continue;
      const cx = x0 + (col + 0.5) * cw, cz = z0 + (row + 0.5) * cd;
      // 高度压过一道根号:一天二十次提交的日子不该把其余 364 天压成一条平线
      const hh = 0.02 + 0.30 * Math.sqrt(v / maxDay);
      // GitHub 那套绿:越勤越亮。亮度是**数量**,而颜色是"这是提交" —— 两件事分开。
      const t = Math.min(1, v / Math.max(2, maxDay * 0.6));
      const c = [0.09 + 0.16 * t, 0.20 + 0.62 * t, 0.14 + 0.22 * t];
      const take = Math.min(per, skyEnd - p);
      for (let k = 0; k < take; k++) {
        const f = (k + 0.5) / take;
        put(cx + (hash01c(k * 3.1 + i) - 0.5) * cw * 0.62,
            BASE + f * hh,
            cz + (hash01c(k * 7.3 + i) - 0.5) * cd * 0.62,
            c[0], c[1], c[2], 0.62);
      }
    }
    while (p < skyEnd) put((hash01c(p * 13) - 0.5) * 2.1, BASE - 0.004, z0 + hash01c(p * 17) * (z1 - z0), 0.10, 0.16, 0.13, 0.55);
  }

  /* ── ③b 地脉 ──
     两块街区之间来往越密,它们中间的地面就被踩得越亮。

     **刻意不画成线。** 第一版是从楼顶拉到楼顶的粒子弧 —— 规整、显眼、像是从别的
     软件贴上来的一层示意图,而不是这座城市自己长出来的东西。改成地面上一片**不匀
     的、中间宽两头收的低雾**:近看是散点,退一步才看出"这两块之间有条路"。关系这
     件事,主要交给**座次**去说(耦合强的本来就排成了邻居);这一层只是把它坐实,
     不该抢眼。 */
  if (nPathPts > 0) {
    const pathEnd = p + nPathPts;
    const maxW = Math.max(...paths.map((l) => l[2]));
    const wsum = paths.reduce((a, x) => a + Math.sqrt(x[2]), 0) || 1;
    for (const [ai, bi, w] of paths) {
      if (p >= pathEnd) break;
      const A = towers[ai], B = towers[bi];
      const share = Math.min(Math.round(nPathPts * Math.sqrt(w) / wsum), pathEnd - p);
      const strength = w / maxW;
      for (let k = 0; k < share; k++) {
        // 沿路不均匀:一段密一段疏,像是被走出来的,不是被画出来的
        let u = hash01c(k * 1.31 + ai * 17 + bi * 7);
        u = u + (hash01c(k * 5.7 + ai) - 0.5) * 0.22;
        u = Math.max(0, Math.min(1, u));
        if (hash01c(k * 9.1 + bi) > 0.35 + 0.65 * strength) continue;   // 稀的地方就是稀
        // 中间胖两头收:两端要收进楼底下,不然会看到两个突兀的端点
        const lens = Math.pow(Math.sin(Math.PI * u), 0.55);
        const spread = (A.foot + B.foot) * 0.28 * lens;
        const nx = -(B.cz - A.cz), nz = (B.cx - A.cx);
        const nl = Math.hypot(nx, nz) || 1;
        const off = (hash01c(k * 3.3 + ai * 5) + hash01c(k * 7.9 + bi * 3) - 1) * spread;
        const c = [
          A.rgb[0] + (B.rgb[0] - A.rgb[0]) * u,
          A.rgb[1] + (B.rgb[1] - A.rgb[1]) * u,
          A.rgb[2] + (B.rgb[2] - A.rgb[2]) * u,
        ];
        const glow = 0.16 + 0.30 * strength * lens;
        put(A.cx + (B.cx - A.cx) * u + nx / nl * off,
            BASE + 0.002 + hash01c(k * 11.3) * 0.010,
            A.cz + (B.cz - A.cz) * u + nz / nl * off,
            c[0] * glow + 0.05, c[1] * glow + 0.06, c[2] * glow + 0.08, 0.6);
      }
    }
    // 没用完的配额撒回街面 —— **绝不能塞到地底下**:整座城市按落点包围盒缩放,
    // 一颗埋在 y=−9 的隐形粒子会把城市在屏幕上压成一个小点(实测踩过)。
    while (p < pathEnd) put((hash01c(p) - 0.5) * 2.1, BASE - 0.004, (hash01c(p * 3) - 0.5) * 2.1, 0.20, 0.26, 0.34, 0.62);
  }

  /* ── ④ 标签 ── 位置在城市里,朝向对着屏幕。 */
  const unbake = (u, v) => {
    const y1 = v * cp, z1 = -v * sp;
    return [u * cy_ - z1 * sy, y1, u * sy + z1 * cy_];
  };

  /* 屋顶牌:每座楼头顶一块小牌子,写它叫什么。天空是空的,牌子放在自己屋顶正上方
     不会挡住别人 —— 而挂在楼身上会被这座楼自己的窗和色带吃掉。 */
  if (nTagPts > 0 && nTags > 0) {
    const tagEnd = p + nTagPts;
    const per = Math.floor(nTagPts / nTags);
    for (let i = 0; i < nTags && p < tagEnd; i++) {
      const t = towers[i];
      const h = 0.072, maxAspect = Math.max(3.2, (cell * 1.5) / h);
      const lab = sampleLabel(t.name, Math.min(per, tagEnd - p), maxAspect);
      if (!lab) continue;
      const w = h * lab.aspect;
      const ay = BASE + t.h + 0.07 + (t.churn === maxChurn && maxChurn >= 3 ? t.h * 0.32 : 0);
      const [lr, lg, lb] = [t.rgb[0] * 0.35 + 0.62, t.rgb[1] * 0.35 + 0.62, t.rgb[2] * 0.35 + 0.62];
      const take = Math.min(per, tagEnd - p);
      for (let k = 0; k < take; k++) {
        const [dx, dy, dz] = unbake(lab.pts[k * 2] * w, lab.pts[k * 2 + 1] * h);
        put(t.cx + dx, ay + dy, t.cz + dz, lr, lg, lb, 0.42);
      }
    }
    while (p < tagEnd) put((hash01c(p * 5) - 0.5) * 2.1, BASE - 0.004, (hash01c(p * 7) - 0.5) * 2.1, 0.20, 0.26, 0.34, 0.62);
  }
  if (nLabelPts > 0) {
    const LEADER = 110;
    const per = Math.floor(nLabelPts / nLabels);
    const boxW = (2 / nLabels) * 0.94;
    // 名字得**在真实大小下读得出来**才算数。放大到 2× 才看得清的标签等于没有 ——
    // 壁纸没有 hover,这一眼看不清就永远看不清了。
    const minH = 0.125;
    // 名字要站在**城外**。z 只推到 1.12 时,前排建筑被俯角压下来的投影正好盖在
    // 名字上 —— 城市越高压得越远,所以这条街得留够。
    const ROW_Y = BASE - 0.34, ROW_Z = 1.52;
    for (let i = 0; i < nLabels && p < n; i++) {
      const t = towers[i];
      const room = Math.min(per, n - p);
      const nMetric = Math.floor((room - LEADER) * 0.34);
      const lab = sampleLabel(t.name, Math.max(1, room - LEADER - nMetric), boxW / minH);
      if (!lab) continue;
      // **字高是固定的,宽度跟着名字走** —— 反过来(钉死宽度、由宽高比推字高)会让
      // "src" 这种短名字撑成巨无霸,而 "src-tauri" 缩成一行小字:同一排标签,
      // 字号差三倍。一排名字必须是同一个字号,那是"它们是同一类东西"的唯一提示。
      const h = minH, w = h * lab.aspect;
      const ax = -1 + (i + 0.5) * (2 / nLabels), ay = ROW_Y, az = ROW_Z;
      const [r0, g0, b0] = t.rgb;
      const lr = r0 * 0.45 + 0.55, lg = g0 * 0.45 + 0.55, lb = b0 * 0.45 + 0.55;
      const nPts = Math.max(1, room - LEADER - nMetric);
      for (let k = 0; k < nPts && p < n; k++) {
        const [dx, dy, dz] = unbake(lab.pts[k * 2] * w, lab.pts[k * 2 + 1] * h);
        put(ax + dx, ay + dy, az + dz, lr, lg, lb, 0.46);
      }
      // 名字下面一行读数:**几个文件、多大、多久没动**。名字说"这是什么",
      // 读数说"它在这个项目里有多重" —— 少了后半句,一座楼再高也只是好看。
      const facts = [t.files ? t.files + ' files' : '', human(t.bytesRaw), since(t.age)]
        .filter(Boolean).join(' · ');
      if (facts && nMetric > 8) {
        const mh = h * 0.52;
        const ml = sampleLabel(facts, Math.min(nMetric, n - p), boxW / mh);
        if (ml) {
          const mw = mh * ml.aspect;
          const take2 = Math.min(nMetric, n - p);
          for (let k = 0; k < take2 && p < n; k++) {
            const [dx, dy, dz] = unbake(ml.pts[k * 2] * mw, ml.pts[k * 2 + 1] * mh - h * 0.86);
            put(ax + dx, ay + dy, az + dz, lr * 0.72, lg * 0.74, lb * 0.80, 0.40);
          }
        }
      }
      const tx = t.cx, ty = BASE + 0.01, tz = t.cz + t.foot / 2;
      const [hx, hy, hz] = unbake(0, h * 0.62);
      const sx = ax + hx, syy = ay + hy, sz = az + hz;
      for (let k = 0; k < LEADER && p < n; k++) {
        const u = (k + 0.5) / LEADER;
        if (Math.floor(u * 26) % 2) continue;
        put(sx + (tx - sx) * u, syy + (ty - syy) * u, sz + (tz - sz) * u,
            r0 * 0.5 + 0.18, g0 * 0.5 + 0.18, b0 * 0.5 + 0.18, 0.5);
      }
    }
  }

  // 取整总会差几十颗,补在街上
  while (p < n) {
    put((Math.random() - 0.5) * 2.1, BASE - 0.004, (Math.random() - 0.5) * 2.1, 0.20, 0.26, 0.34, 0.62);
  }
  return { target, color, scale, used: p };
}

  root.TerseCity = {
    sampleCity: sampleCity,
    CITY_STYLES: CITY_STYLES,
    styleOf: styleOf,
    DEFAULT_STYLE: DEFAULT_STYLE,
    PITCH: CITY_PITCH,
    YAW: CITY_YAW
  };
})(window);
