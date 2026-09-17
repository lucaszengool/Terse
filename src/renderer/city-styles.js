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
    const sub = { cx: hx, cz: hz, foot: hs, h: hh, name: t.name + i, kind: t.kind, files: 1, age: t.age, churn: 0 };
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

export const CITY_STYLES = [
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

export const DEFAULT_STYLE = 'modern';
const BY_ID = Object.fromEntries(CITY_STYLES.map((s) => [s.id, s]));
/** 不认识的风格 id 一律退回现代 —— 胶囊是别人机器上传过来的,不能信。 */
export function styleOf(id) { return BY_ID[id] || BY_ID[DEFAULT_STYLE]; }
/** 这个风格要不要 Pro 才能发布(生成和预览永远免费)。 */
export function styleNeedsPro(id) { return !styleOf(id).free; }

/** 这个风格能拼出多少种不重样的楼 —— 界面上写给人看的,也是这套语法的意义所在。 */
export function styleVariants(id) {
  const s = styleOf(id).slots;
  const ex = s.extra.length;
  const combosOfExtras = 1 + ex + (ex * (ex - 1)) / 2;      // 挑 0、1、2 件
  return s.base.length * s.body.length * s.skin.length * s.crown.length * combosOfExtras;
}
