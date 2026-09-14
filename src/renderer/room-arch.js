/**
 * room-arch.js — 一间屋子的**建筑**:地、墙、顶、柱、灯具、门,以及露天格局里的
 * 四合院和庭院、屋顶、天。全部是 room-surface.js 的面(实打实的形体 + 程序材质),
 * 灯、火、星是发光点。
 *
 * 一间屋子长什么样,由两样东西决定,而且两样都来自代码:
 *
 *   · **风格**(整座楼的)—— 词汇表。唐宋拿得到斗拱、格栅、梁架,古希腊拿得到凹槽柱和
 *     藻井,谁也够不着谁的件。见 room-interior.js 的 INTERIOR。
 *   · **这个目录自己的代码**(signatureOf)—— 在词汇表里挑哪一件、什么颜色、多高。
 *     测试多的屋子铺瓷砖、色调偏冷;文档多的是木地板、护墙板、偏暖;类和类型多的屋子
 *     顶是一格一格的藻井,散函数多的是敞开的梁架;主语言的颜色染在描金和墙上。
 *     所以同一座楼里的几间屋子同属一个风格,又各是各的样子 —— 而且是**有理由的**不同。
 *
 * ⚠ 颜色分两层:这里是房子的料;家具上的东西是语言色(room-furniture.js)。主语言在
 * 这里只**染一层淡色**,不接管房子 —— 否则两层颜色又混成一层了。
 */

import { MAT, F } from './room-surface.js';
import { mix, DOOR_W } from './room-interior.js';

const TAU = Math.PI * 2;
const sh = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** 这间屋子用的颜色。风格给底色,代码染一层:主语言进描金和墙,文件用途定冷暖。 */
export function coloursOf(ip) {
  const P = ip.pal, t = ip.tint || P.accent;
  const mood = ip.mood || { col: [0.9, 0.88, 0.84], k: 0 };
  const stone = mix(mix(P.stone, t, 0.08), mood.col, mood.k * 0.6);
  return {
    stone, stoneDark: sh(stone, 0.55),
    plaster: mix(mix(mix(P.stone, [0.95, 0.93, 0.88], 0.5), t, 0.1), mood.col, mood.k),
    accent: mix(P.accent, t, 0.4),
    roof: P.roof,
    timber: mix(P.timber || sh(P.stone, 0.6), mood.col, mood.k * 0.25),
    tint: t,
  };
}

/* ── 墙:四面,按门切段 ─────────────────────────────────────────────────── */
function wallsOf(r, doors) {
  const IN = 0.03;
  return [
    { s: 'N', at: r.z0 + IN, lo: r.x0, hi: r.x1, n: [0, 0, 1] },
    { s: 'S', at: r.z1 - IN, lo: r.x0, hi: r.x1, n: [0, 0, -1] },
    { s: 'W', at: r.x0 + IN, lo: r.z0, hi: r.z1, n: [1, 0, 0] },
    { s: 'E', at: r.x1 - IN, lo: r.z0, hi: r.z1, n: [-1, 0, 0] },
  ].map((w) => {
    const horiz = w.s === 'N' || w.s === 'S';
    w.P = (u, y) => (horiz ? [u, y, w.at] : [w.at, y, u]);
    w.dir = horiz ? [1, 0, 0] : [0, 0, 1];
    w.gaps = doors.filter((d) => (horiz ? Math.abs(d.cz - w.at) < 0.9 : Math.abs(d.cx - w.at) < 0.9)
      && (horiz ? d.cx > r.x0 && d.cx < r.x1 : d.cz > r.z0 && d.cz < r.z1))
      .map((d) => { const c = horiz ? d.cx : d.cz; return [c - DOOR_W / 2 - 0.04, c + DOOR_W / 2 + 0.04]; });
    // 墙上不开门的那几段
    const segs = [];
    let a = w.lo;
    for (const g of w.gaps.slice().sort((p, q) => p[0] - q[0])) { if (g[0] > a) segs.push([a, g[0]]); a = Math.max(a, g[1]); }
    if (a < w.hi) segs.push([a, w.hi]);
    w.segs = segs;
    return w;
  });
}

/* ══ 地 ═════════════════════════════════════════════════════════════════════ */
function floor(S, A, C, fl) {
  const { r, ip } = A, W = r.x1 - r.x0, D = r.z1 - r.z0;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, seed = A.seed;
  const q = (spec) => S.quad([r.x0, 0, r.z0], [W, 0, 0], [0, 0, D], Object.assign({ flags: fl, seed }, spec), [0, 1, 0]);
  switch (ip.floor) {
    case 'grid': q({ mat: MAT.gridglow, c1: sh(C.stone, 0.32), c2: C.accent }); break;
    case 'board': q({ mat: MAT.wood, c1: sh(C.timber, 1.05) }); break;
    case 'tatami': q({ mat: MAT.tatami, c1: [0.74, 0.72, 0.5], c2: [0.14, 0.12, 0.1] }); break;
    case 'mosaic': q({ mat: MAT.mosaic, c1: C.stone, c2: C.accent }); break;
    case 'band': q({ mat: MAT.sandstone, c1: C.stone }); break;
    case 'rosette': {
      q({ mat: MAT.marble, c1: C.stone, c2: C.stoneDark });
      // 地心一朵拼花:人会朝它走
      const R = Math.min(W, D) * 0.22;
      S.disc([cx, 0.004, cz], R * 0.86, R, { mat: MAT.metal, c1: C.accent, flags: fl, seed });
      S.disc([cx, 0.004, cz], 0, R * 0.86, { mat: MAT.mosaic, c1: C.stone, c2: C.accent, flags: fl, seed });
      break;
    }
    default: q({ mat: MAT.tile, c1: C.stone, c2: C.stoneDark });
  }
}

/* ══ 墙 ═════════════════════════════════════════════════════════════════════ */
function walls(S, G, A, C, fl) {
  const { r, ip, doors } = A, h = r.h, seed = A.seed;
  const dh = Math.min(3.0, h * 0.74);
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const kind = r.kind === 'pavilion' ? 'lattice' : r.kind === 'wing' ? 'wing' : r.kind === 'court' ? 'court' : r.kind === 'garden' ? 'fence' : ip.wall;
  for (const w of wallsOf(r, doors)) {
    const Q = (a, b, y0, y1, spec) => { if (b - a > 0.01 && y1 - y0 > 0.01) S.quad(w.P(a, y0), sh(w.dir, b - a), [0, y1 - y0, 0], spec, w.n); };
    // 竖着的木板:U 取竖直,V 沿墙 —— 木纹材质按 V 分板
    const QV = (a, b, y0, y1, spec) => { if (b - a > 0.01 && y1 - y0 > 0.01) S.quad(w.P(a, y0), [0, y1 - y0, 0], sh(w.dir, b - a), spec, w.n); };
    const strip = (y, hh, dep, spec) => {                                        // 贴墙的一道横条(踢脚、腰线、檐口)
      for (const [a, b] of w.segs) S.box(add3(w.P((a + b) / 2, y), sh(w.n, dep / 2)), w.dir, w.n, b - a, hh, dep, spec, { back: false, bottom: true });
    };
    for (const [a, b] of w.segs) {
      switch (kind) {
        case 'glass':
          Q(a, b, 0, 0.18, sp(MAT.stone, sh(C.stone, 0.4)));
          Q(a, b, 0.18, h, sp(MAT.glass, [0.52, 0.64, 0.74], sh(C.accent, 0.6)));
          break;
        case 'lattice':
          Q(a, b, 0, 0.9, sp(MAT.wood, sh(C.timber, 0.9)));
          Q(a, b, 0.9, h, sp(MAT.lattice, [0.94, 0.9, 0.8], sh(C.timber, 0.55), F.glow));
          break;
        case 'timber':
          QV(a, b, 0, h, sp(MAT.wood, C.timber));
          break;
        case 'mosaic':
          Q(a, b, 0, 1.4, sp(MAT.mosaic, C.stone, C.accent));
          Q(a, b, 1.4, h, sp(MAT.plaster, C.plaster));
          Q(a, b, h - 0.9, h - 0.5, sp(MAT.mosaic, C.accent, C.stone));
          break;
        case 'glyph':
          Q(a, b, 0, h, sp(MAT.glyph, C.stone, C.stoneDark));
          break;
        case 'wing': case 'court':                                                  // 青砖
          Q(a, b, 0, h, sp(MAT.brick, [0.46, 0.47, 0.49], [0.82, 0.8, 0.76]));
          break;
        case 'fence':                                                               // 庭院围墙:白壁、瓦檐
          Q(a, b, 0, h, sp(MAT.plaster, [0.92, 0.9, 0.84]));
          break;
        default:                                                                    // fin:护墙板 + 抹灰
          Q(a, b, 0, 1.05, sp(MAT.wood, sh(C.timber, 0.85)));
          Q(a, b, 1.05, h, sp(MAT.plaster, C.plaster));
      }
    }
    // 门楣:门洞上方那一截墙
    for (const [a, b] of w.gaps) {
      const spec = kind === 'glass' ? sp(MAT.glass, [0.52, 0.64, 0.74], sh(C.accent, 0.6))
        : kind === 'wing' || kind === 'court' ? sp(MAT.brick, [0.46, 0.47, 0.49], [0.82, 0.8, 0.76])
        : kind === 'glyph' ? sp(MAT.glyph, C.stone, C.stoneDark) : sp(MAT.plaster, kind === 'fence' ? [0.92, 0.9, 0.84] : C.plaster);
      Q(a, b, dh, h, spec);
      // 门框:两根立柱 + 一道楣。只由大厅(院子)这一侧画 —— 两间屋子各画一副,
      // 就是同一个位置叠了两副颜色不同的框,点混在一起一闪一闪。
      if (A.frames === false) continue;
      const frame = (ip.style.id === 'tang' || ip.style.id === 'edo' || kind === 'wing') ? sp(MAT.lacquer, ip.style.id === 'edo' ? sh(C.timber, 0.7) : [0.62, 0.16, 0.12]) : sp(MAT.metal, C.accent);
      for (const u of [a + 0.07, b - 0.07]) S.box(w.P(u, 0), w.dir, w.n, 0.14, dh, 0.22, frame);
      S.box(w.P((a + b) / 2, dh), w.dir, w.n, b - a + 0.1, 0.16, 0.24, frame, { bottom: true });
    }
    // 各种墙都有的:踢脚、檐口;fin / mosaic 还有腰线和壁柱
    if (kind !== 'fence' && kind !== 'court') {
      strip(0, 0.12, 0.03, sp(MAT.wood, sh(C.timber, 0.5)));
      strip(h - 0.22, 0.22, 0.14, kind === 'lattice' || kind === 'timber' || kind === 'wing' ? sp(MAT.wood, sh(C.timber, 0.7)) : sp(MAT.marble, C.stone, C.stoneDark));
    } else {
      strip(h - 0.2, 0.2, 0.3, sp(MAT.rooftile, C.roof));                         // 墙头瓦
    }
    if (kind === 'fin' || kind === 'mosaic' || !['glass', 'lattice', 'timber', 'glyph', 'wing', 'court', 'fence'].includes(kind)) {
      strip(1.03, 0.06, 0.05, sp(MAT.metal, C.accent));
    }
    if (kind === 'fin' || kind === 'glyph' || kind === 'lattice') {
      const step = kind === 'lattice' ? 1.8 : 3.2;
      for (let u = w.lo + step / 2; u < w.hi - 0.5; u += step) {
        if (w.gaps.some(([a, b]) => u > a - 0.5 && u < b + 0.5)) continue;
        const spec = kind === 'lattice' ? sp(MAT.wood, sh(C.timber, 0.75)) : sp(MAT.marble, C.stone, C.stoneDark);
        S.box(add3(w.P(u, 0), sh(w.n, 0.1)), w.dir, w.n, kind === 'lattice' ? 0.14 : 0.5, h - 0.22, kind === 'lattice' ? 0.12 : 0.2, spec, { back: false });
      }
    }
  }
}
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/* ══ 顶 ═════════════════════════════════════════════════════════════════════ */
function ceiling(S, G, A, C, fl) {
  const { r, ip } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, h = r.h;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, seed = A.seed;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const flat = (spec) => S.quad([r.x0, h, r.z0], [W, 0, 0], [0, 0, D], spec, [0, -1, 0]);
  switch (ip.ceil) {
    case 'coffer':
      flat(sp(MAT.coffer, mix(C.roof, C.plaster, 0.35), C.accent));
      for (let x = r.x0 + 2.2; x < r.x1 - 0.5; x += 2.2) S.aabb(x - 0.13, h - 0.3, r.z0, x + 0.13, h, r.z1, sp(MAT.marble, C.stone, C.stoneDark), { top: false, bottom: true });
      for (let z = r.z0 + 2.2; z < r.z1 - 0.5; z += 2.2) S.aabb(r.x0, h - 0.24, z - 0.1, r.x1, h, z + 0.1, sp(MAT.marble, C.stone, C.stoneDark), { top: false, bottom: true });
      break;
    case 'beam':
      flat(sp(MAT.wood, sh(C.timber, 0.75)));
      for (let z = r.z0 + 1.3; z < r.z1 - 0.3; z += 1.3) S.aabb(r.x0, h - 0.24, z - 0.09, r.x1, h, z + 0.09, sp(MAT.wood, sh(C.timber, 0.9)), { top: false, bottom: true });
      for (const f of [0.3, 0.7]) { const x = r.x0 + W * f; S.aabb(x - 0.18, h - 0.5, r.z0, x + 0.18, h - 0.24, r.z1, sp(MAT.lacquer, ip.style.id === 'tang' ? [0.6, 0.16, 0.12] : sh(C.timber, 0.65)), { top: false, bottom: true }); }
      break;
    case 'corbel': {
      flat(sp(MAT.sandstone, C.stone));
      for (let k = 0; k < 4; k++) {
        const inset = 0.25 + k * 0.35, y = h - 0.8 + k * 0.2;
        const x0 = r.x0 + inset, x1 = r.x1 - inset, z0 = r.z0 + inset, z1 = r.z1 - inset;
        const spec = sp(MAT.glyph, sh(C.stone, 1 - k * 0.06), C.stoneDark);
        S.aabb(r.x0, y, r.z0, r.x1, y + 0.2, z0, spec); S.aabb(r.x0, y, z1, r.x1, y + 0.2, r.z1, spec);
        S.aabb(r.x0, y, z0, x0, y + 0.2, z1, spec); S.aabb(x1, y, z0, r.x1, y + 0.2, z1, spec);
      }
      break;
    }
    case 'dome': case 'onion': {
      const R = Math.min(W, D) / 2 * 0.92;
      S.disc([cx, h, cz], R, Math.hypot(W, D) / 2 + 0.2, sp(MAT.plaster, C.plaster), true);
      const sq = ip.ceil === 'onion' ? 1.35 : 0.85;
      S.sphere([cx, h, cz], R, Object.assign(sp(MAT.coffer, mix(C.roof, C.plaster, 0.3), C.accent), { flags: fl | F.flip }), 0, TAU, 0, Math.PI / 2 - 0.08, sq);
      S.disc([cx, h, cz], R - 0.12, R + 0.05, sp(MAT.metal, C.accent), true);      // 穹顶脚一圈描金
      if (ip.light === 'oculus') S.disc([cx, h + R * sq - 0.02, cz], 0, R * 0.22, sp(MAT.paper, [1, 0.97, 0.9], null, 0), true);
      break;
    }
    default:
      flat(sp(MAT.plaster, C.plaster));
      S.aabb(r.x0, h - 0.12, r.z0, r.x1, h, r.z0 + 0.35, sp(MAT.plaster, sh(C.plaster, 0.9)), { top: false, bottom: true });
      S.aabb(r.x0, h - 0.12, r.z1 - 0.35, r.x1, h, r.z1, sp(MAT.plaster, sh(C.plaster, 0.9)), { top: false, bottom: true });
  }
}

/* ══ 柱 ═════════════════════════════════════════════════════════════════════ */
export function column(S, A, C, x, z, h, fl) {
  const { ip } = A, seed = A.seed;
  const sp = (mat, c1, c2) => ({ mat, c1, c2: c2 || c1, flags: fl, seed });
  const S0 = sp(MAT.marble, C.stone, C.stoneDark), GOLD = sp(MAT.metal, C.accent);
  switch (ip.col) {
    case 'fluted':
      S.aabb(x - 0.55, 0, z - 0.55, x + 0.55, 0.3, z + 0.55, S0);
      S.cyl([x, 0, z], 0.36, h - 0.72, sp(MAT.fluted, C.stone), 0, TAU, 0.3);
      S.cyl([x, 0, z], 0.46, 0.28, GOLD, 0, TAU, h - 0.42);
      S.aabb(x - 0.6, h - 0.14, z - 0.6, x + 0.6, h, z + 0.6, S0);
      break;
    case 'lotus':
      S.cyl([x, 0, z], 0.5, 0.25, sp(MAT.sandstone, C.stone));
      S.cyl([x, 0, z], 0.38, h - 0.9, sp(MAT.glyph, C.stone, C.stoneDark), 0, TAU, 0.25);
      S.sphere([x, h - 0.65, z], 0.62, sp(MAT.lacquer, mix(C.accent, [0.2, 0.55, 0.5], 0.4)), 0, TAU, -0.2, 1.2, 0.7);
      S.aabb(x - 0.5, h - 0.14, z - 0.5, x + 0.5, h, z + 0.5, sp(MAT.sandstone, C.stone));
      break;
    case 'dougong': {                                                              // 朱柱 + 层层挑出的斗拱
      S.cyl([x, 0, z], 0.42, 0.22, sp(MAT.stone, [0.55, 0.55, 0.55]));
      S.cyl([x, 0, z], 0.26, h - 0.7, sp(MAT.lacquer, [0.62, 0.15, 0.11]), 0, TAU, 0.22);
      for (let k = 0; k < 3; k++) {
        const y = h - 0.5 + k * 0.16, w = 0.5 + k * 0.32;
        S.aabb(x - w / 2, y, z - 0.18, x + w / 2, y + 0.14, z + 0.18, sp(MAT.lacquer, k % 2 ? [0.2, 0.45, 0.42] : [0.16, 0.3, 0.5]));
        S.aabb(x - 0.18, y, z - w / 2, x + 0.18, y + 0.14, z + w / 2, sp(MAT.lacquer, k % 2 ? [0.16, 0.3, 0.5] : [0.2, 0.45, 0.42]));
      }
      break;
    }
    case 'stave':
      S.cyl([x, 0, z], 0.3, h, sp(MAT.wood, C.timber));
      for (const y of [0.4, h - 0.6]) S.cyl([x, 0, z], 0.33, 0.12, sp(MAT.metal, sh(C.accent, 0.8)), 0, TAU, y);
      S.aabb(x - 0.45, h - 0.25, z - 0.45, x + 0.45, h, z + 0.45, sp(MAT.wood, sh(C.timber, 0.75)));
      break;
    case 'slender':
      S.cyl([x, 0, z], 0.28, 0.2, S0);
      S.cyl([x, 0, z], 0.16, h - 0.5, sp(MAT.fluted, C.stone), 0, TAU, 0.2);
      S.sphere([x, h - 0.3, z], 0.26, GOLD, 0, TAU, -1.2, 0.3, 1);
      S.aabb(x - 0.3, h - 0.1, z - 0.3, x + 0.3, h, z + 0.3, S0);
      break;
    default:                                                                       // plain:方柱
      S.aabb(x - 0.3, 0, z - 0.3, x + 0.3, h, z + 0.3, sp(MAT.plaster, sh(C.plaster, 0.92)));
      S.aabb(x - 0.36, 0, z - 0.36, x + 0.36, 0.22, z + 0.36, S0);
      S.aabb(x - 0.36, h - 0.22, z - 0.36, x + 0.36, h, z + 0.36, S0);
  }
}

/* ══ 灯 ═════════════════════════════════════════════════════════════════════
   灯具是实物(金属圈、纸灯罩、铜盆),亮的那部分是发光点;再登记一盏"灯"给夜光用。 */
function fixtures(S, G, A, C, fl) {
  const { r, ip, isHall } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, h = r.h;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, R = Math.min(W, D) / 2, rnd = A.rnd, seed = A.seed;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const warm = [1, 0.74, 0.46];
  const glowBall = (x, y, z, rad, col, n, size) => { for (let i = 0; i < n; i++) { const a = rnd() * TAU, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u) * rad * Math.sqrt(rnd()); G(x + Math.cos(a) * q, y + u * rad * 0.8, z + Math.sin(a) * q, col, size, 0.7, 1); } };
  const ring = (x, y, z, rad, spec, segs = 20) => { for (let i = 0; i < segs; i++) { const a0 = i / segs * TAU, a1 = (i + 1) / segs * TAU; S.tube([x + Math.cos(a0) * rad, y, z + Math.sin(a0) * rad], [x + Math.cos(a1) * rad, y, z + Math.sin(a1) * rad], 0.022, spec); } };
  switch (ip.light) {
    case 'chandelier': {
      const y0 = h - (isHall ? 1.9 : 1.1), GOLD = sp(MAT.metal, C.accent);
      S.tube([cx, h, cz], [cx, y0 + 0.9, cz], 0.02, GOLD);
      const tiers = isHall ? 3 : 2;
      for (let t = 0; t < tiers; t++) {
        const rad = (0.45 + t * 0.42) * (isHall ? 1 : 0.7), y = y0 + 0.7 - t * 0.35;
        ring(cx, y, cz, rad, GOLD);
        const bulbs = 8 + t * 6;
        for (let i = 0; i < bulbs; i++) { const a = i / bulbs * TAU; const bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad; S.cyl([bx, 0, bz], 0.018, 0.08, sp(MAT.paper, [1, 0.95, 0.85], null, F.glow), 0, TAU, y); glowBall(bx, y + 0.12, bz, 0.03, [1, 0.86, 0.6], 3, 0.06); }
      }
      A.lit(cx, y0, cz, Math.max(W, D) * (isHall ? 0.85 : 1.0), [1, 0.84, 0.62], isHall ? 1.9 : 1.4);
      break;
    }
    case 'lantern': {
      const n = isHall ? 4 : 1, rad = isHall ? Math.min(3.2, R * 0.5) : 0;
      for (let k = 0; k < n; k++) {
        const a = (k / Math.max(1, n)) * TAU + 0.4, lx = cx + Math.cos(a) * rad, lz = cz + Math.sin(a) * rad, ly = h - 1.35;
        S.tube([lx, h, lz], [lx, ly + 0.36, lz], 0.01, sp(MAT.metal, sh(C.accent, 0.6)));
        S.aabb(lx - 0.24, ly - 0.36, lz - 0.24, lx + 0.24, ly + 0.36, lz + 0.24, sp(MAT.paper, ip.style.id === 'tang' ? [0.95, 0.35, 0.22] : [0.96, 0.9, 0.78], null, F.glow), { bottom: true });
        S.aabb(lx - 0.28, ly + 0.36, lz - 0.28, lx + 0.28, ly + 0.42, lz + 0.28, sp(MAT.wood, sh(C.timber, 0.6)), { bottom: true });
        S.aabb(lx - 0.28, ly - 0.42, lz - 0.28, lx + 0.28, ly - 0.36, lz + 0.28, sp(MAT.wood, sh(C.timber, 0.6)), { bottom: true });
        glowBall(lx, ly, lz, 0.14, [1, 0.72, 0.4], 14, 0.12);
        A.lit(lx, ly, lz, isHall ? 7.5 : Math.max(W, D) * 0.95, ip.style.id === 'tang' ? [1, 0.55, 0.36] : warm, isHall ? 1.2 : 1.3);
      }
      break;
    }
    case 'brazier': {
      const n = isHall ? 4 : 1, Rb = isHall ? Math.min(W, D) * 0.32 : 0;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + 0.7, bx = cx + Math.cos(a) * Rb, bz = cz + Math.sin(a) * Rb, y = 0.92;
        for (let j = 0; j < 3; j++) { const la = j / 3 * TAU + a; S.tube([bx + Math.cos(la) * 0.34, 0, bz + Math.sin(la) * 0.34], [bx + Math.cos(la) * 0.14, y - 0.12, bz + Math.sin(la) * 0.14], 0.025, sp(MAT.metal, sh(C.accent, 0.55))); }
        S.sphere([bx, y + 0.1, bz], 0.46, sp(MAT.metal, sh(C.accent, 0.7)), 0, TAU, -Math.PI / 2, -0.15, 0.42);
        S.disc([bx, y + 0.03, bz], 0.36, 0.45, sp(MAT.metal, C.accent));
        // 火:几条火舌,根部白、梢是红的 —— 发光点,夜里亮
        for (let i = 0; i < 160; i++) {
          const t = Math.pow(rnd(), 1.5), j = (rnd() * 5) | 0, ph = j / 5 * TAU + k, H = 0.6 + ((j * 37) % 5) * 0.08;
          const wdt = 0.12 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t)), 0.8) * (1 - t * 0.5), aa = rnd() * TAU, rr = wdt * Math.sqrt(rnd());
          const col = t < 0.3 ? [1, 0.95, 0.8] : t < 0.65 ? [1, 0.6, 0.2] : [0.9, 0.25, 0.08];
          G(bx + Math.cos(ph) * 0.08 * (1 - t) + Math.cos(aa) * rr, y + 0.05 + t * H, bz + Math.sin(ph) * 0.08 * (1 - t) + Math.sin(aa) * rr, col, 0.07 + (1 - t) * 0.06, 1, 1);
        }
        A.block(bx, bz, 0.55);
        A.lit(bx, y + 0.5, bz, isHall ? 7 : Math.max(W, D) * 0.9, [1, 0.6, 0.3], 1.5);
      }
      break;
    }
    case 'candle': {
      const y = h - 1.2, rad = isHall ? 1.4 : 0.8, GOLD = sp(MAT.metal, sh(C.accent, 0.8));
      S.tube([cx, h, cz], [cx, y, cz], 0.015, GOLD);
      ring(cx, y, cz, rad, GOLD, 24);
      const n = isHall ? 14 : 8;
      for (let i = 0; i < n; i++) { const a = i / n * TAU, x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad; S.cyl([x, 0, z], 0.022, 0.16, sp(MAT.paper, [0.96, 0.93, 0.85]), 0, TAU, y); glowBall(x, y + 0.21, z, 0.02, [1, 0.8, 0.45], 4, 0.06); }
      A.lit(cx, y, cz, Math.max(W, D) * 0.8, [1, 0.78, 0.5], 1.3);
      break;
    }
    case 'strip': {
      const L = W * 0.6;
      S.aabb(cx - L / 2, h - 0.12, cz - 0.06, cx + L / 2, h - 0.06, cz + 0.06, sp(MAT.paper, [0.9, 0.95, 1], null, F.glow), { bottom: true });
      for (let i = 0; i < 60; i++) G(cx + (rnd() - 0.5) * L, h - 0.14, cz + (rnd() - 0.5) * 0.1, [0.85, 0.92, 1], 0.08, 0.2, 1);
      A.lit(cx, h - 0.5, cz, Math.max(W, D) * 0.85, [0.84, 0.9, 1], 1.4);
      break;
    }
    case 'oculus': {
      // 顶心一道天光:白天是光柱,夜里是一束淡淡的月光
      for (let i = 0; i < 700; i++) { const t = rnd(), a = rnd() * TAU, q = (0.3 + t * 0.9) * Math.sqrt(rnd()) * Math.min(1.6, R * 0.3); G(cx + Math.cos(a) * q, h - t * h, cz + Math.sin(a) * q, [1, 0.97, 0.88], 0.1, 0.3, 3); }
      A.lit(cx, h * 0.6, cz, Math.max(W, D) * 0.7, [0.55, 0.62, 0.8], 0.9);
      break;
    }
    default: A.lit(cx, h - 0.8, cz, Math.max(W, D) * 0.8, warm, 1.2);
  }
}

/* ══ 院子:四合院 ═══════════════════════════════════════════════════════════ */
function siheyuan(S, G, A, C) {
  const { r, rnd, doors } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, seed = A.seed;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: extra || 0, seed });
  // 方砖地 + 十字甬道(略高一点、浅一点的石)
  S.quad([r.x0, 0, r.z0], [W, 0, 0], [0, 0, D], sp(MAT.tile, [0.5, 0.5, 0.5], [0.3, 0.3, 0.3]), [0, 1, 0]);
  S.aabb(cx - 0.8, 0, r.z0, cx + 0.8, 0.02, r.z1, sp(MAT.tile, [0.66, 0.64, 0.6], [0.45, 0.44, 0.42]), { front: false, back: false });
  S.aabb(r.x0, 0, cz - 0.8, r.x1, 0.02, cz + 0.8, sp(MAT.tile, [0.66, 0.64, 0.6], [0.45, 0.44, 0.42]), { left: false, right: false });
  // 游廊:朱柱一圈,柱头一道彩画额枋,檐向院内斜下来
  const inset = 1.3, colH = 3.1, RED = sp(MAT.lacquer, [0.62, 0.15, 0.11]);
  const sides = [
    [[r.x0 + inset, r.z0 + inset], [r.x1 - inset, r.z0 + inset], [0, 0, 1]], [[r.x0 + inset, r.z1 - inset], [r.x1 - inset, r.z1 - inset], [0, 0, -1]],
    [[r.x0 + inset, r.z0 + inset], [r.x0 + inset, r.z1 - inset], [1, 0, 0]], [[r.x1 - inset, r.z0 + inset], [r.x1 - inset, r.z1 - inset], [-1, 0, 0]],
  ];
  let k = 0;
  for (const [a, b, n] of sides) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), nC = Math.max(2, Math.round(len / 2.6));
    for (let j = 0; j <= nC; j++) {
      const x = a[0] + (b[0] - a[0]) * j / nC, z = a[1] + (b[1] - a[1]) * j / nC;
      if (doors.some((d) => Math.abs(d.cx - x) < 1.6 && Math.abs(d.cz - z) < 1.6)) continue;
      S.cyl([x, 0, z], 0.13, colH, RED);
      S.cyl([x, 0, z], 0.2, 0.14, sp(MAT.stone, [0.6, 0.6, 0.58]));
      if ((k++ & 1) === 0) {                                                         // 檐下的红灯笼,隔一根挂一盏
        const lx = x + n[0] * 0.35, lz = z + n[2] * 0.35, ly = colH - 0.55;
        S.tube([lx, colH, lz], [lx, ly + 0.28, lz], 0.008, sp(MAT.metal, [0.3, 0.25, 0.2]));
        S.sphere([lx, ly, lz], 0.22, sp(MAT.paper, [0.95, 0.28, 0.18], null, F.glow), 0, TAU, -1.3, 1.3, 1.2);
        for (let i = 0; i < 10; i++) G(lx + (rnd() - 0.5) * 0.2, ly + (rnd() - 0.5) * 0.3, lz + (rnd() - 0.5) * 0.2, [1, 0.45, 0.28], 0.12, 0.8, 1);
        if ((k & 3) === 1) A.lit(lx, ly, lz, 6.5, [1, 0.5, 0.32], 1.2);
      }
    }
    const horiz = Math.abs(n[2]) > 0.5;
    const L = horiz ? [len, 0, 0] : [0, 0, len];
    // 额枋:青绿彩画
    S.box([(a[0] + b[0]) / 2, colH, (a[1] + b[1]) / 2], horiz ? [1, 0, 0] : [0, 0, 1], n, len + 0.3, 0.3, 0.2, sp(MAT.lacquer, [0.16, 0.36, 0.42]), { bottom: true });
    // 廊檐:从墙头斜下到柱外
    const back = [a[0] - n[0] * inset, colH + 0.9, a[1] - n[2] * inset];
    S.quad(back, L, [n[0] * (inset + 0.6), -0.75, n[2] * (inset + 0.6)], sp(MAT.rooftile, sh(C.roof, 0.85)), [0, 1, 0]);
    S.quad(back, L, [n[0] * (inset + 0.6), -0.75, n[2] * (inset + 0.6)], sp(MAT.wood, [0.55, 0.2, 0.14]), [0, -1, 0]);
  }
  // 两棵海棠:树干、枝、一树花
  for (const sx of [-1, 1]) {
    const tx = cx + sx * W / 4, tz = cz - D / 5;
    tree(S, rnd, tx, tz, 2.3, [0.3, 0.2, 0.14], [[1, 0.78, 0.84], [1, 0.9, 0.93], [0.93, 0.56, 0.68], [0.36, 0.55, 0.3]], 1.9, 5200, seed);
    A.block(tx, tz, 0.55);
  }
  // 两口青花瓷鱼缸
  for (const sx of [-1, 1]) {
    const bx = cx + sx * W / 4, bz = cz + D / 4, R = 0.5;
    S.sphere([bx, 0.36, bz], R, sp(MAT.mosaic, [0.92, 0.93, 0.95], [0.18, 0.3, 0.66]), 0, TAU, -1.0, 0.55, 0.9);
    S.disc([bx, 0.62, bz], 0, R * 0.86, sp(MAT.water, [0.05, 0.16, 0.18]));
    for (let f = 0; f < 3; f++) { const an = rnd() * TAU, q = rnd() * R * 0.5; for (let i = 0; i < 6; i++) G(bx + Math.cos(an) * q + (rnd() - 0.5) * 0.06, 0.63, bz + Math.sin(an) * q + (rnd() - 0.5) * 0.03, [1, 0.5, 0.15], 0.04, 0.3, 2); }
    A.block(bx, bz, 0.62);
  }
}

/** 一棵树:几段弯曲的干 + 一团花/叶(零散点,各自带朝外的法线,所以受光有体积)。 */
function tree(S, rnd, x, z, hgt, bark, cols, R, n, seed) {
  let px = x, pz = z, py = 0;
  for (let i = 0; i < 4; i++) {
    const nx = px + (rnd() - 0.5) * 0.3, nz = pz + (rnd() - 0.5) * 0.3, ny = py + hgt / 4;
    S.tube([px, py, pz], [nx, ny, nz], 0.16 * (1 - i * 0.18), { mat: MAT.bark, c1: bark, seed });
    px = nx; pz = nz; py = ny;
  }
  for (let b = 0; b < 5; b++) {
    const a = b / 5 * TAU + rnd(), L = R * 0.8;
    S.tube([px, py, pz], [px + Math.cos(a) * L, py + 0.5 + rnd() * 0.4, pz + Math.sin(a) * L], 0.06, { mat: MAT.bark, c1: bark, seed });
  }
  const cy = py + 0.7;
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u) * Math.pow(rnd(), 0.3);
    const nx = Math.cos(a) * q, ny = u * 0.62, nz = Math.sin(a) * q;
    S.dot([px + nx * R, cy + ny * R, pz + nz * R], [nx, ny + 0.3, nz], cols[(rnd() * cols.length) | 0], 0.07 + rnd() * 0.04);
  }
}

/* ══ 院子:日式庭院 ═════════════════════════════════════════════════════════ */
function garden(S, G, A, C) {
  const { r, rnd } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, seed = A.seed;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: extra || 0, seed });
  const band = 1.7, wood = [0.52, 0.38, 0.26];
  // 缘侧:沿四边一圈低低的木廊
  S.aabb(r.x0, 0, r.z0, r.x1, 0.08, r.z0 + band, sp(MAT.wood, wood), { back: false });
  S.aabb(r.x0, 0, r.z1 - band, r.x1, 0.08, r.z1, sp(MAT.wood, wood), { front: false });
  S.aabb(r.x0, 0, r.z0 + band, r.x0 + band, 0.08, r.z1 - band, sp(MAT.wood, wood), { left: false });
  S.aabb(r.x1 - band, 0, r.z0 + band, r.x1, 0.08, r.z1 - band, sp(MAT.wood, wood), { right: false });
  const inner = { x0: r.x0 + band, x1: r.x1 - band, z0: r.z0 + band, z1: r.z1 - band };
  const iw = inner.x1 - inner.x0, id = inner.z1 - inner.z0;
  // 白砂不是纯白:在太阳底下纯白就是一片烧掉的白,耙纹一道也看不见
  S.quad([inner.x0, 0.005, inner.z0], [iw, 0, 0], [0, 0, id], sp(MAT.gravel, [0.7, 0.69, 0.64]), [0, 1, 0]);
  // 三块石头,绕着石头一圈苔
  const rocks = [[inner.x0 + iw * 0.22, inner.z0 + id * 0.3, 0.95], [inner.x0 + iw * 0.3, inner.z0 + id * 0.64, 0.6], [inner.x0 + iw * 0.12, inner.z0 + id * 0.55, 0.45]];
  for (const [x, z, s] of rocks) {
    S.sphere([x, 0, z], s, sp(MAT.stone, [0.4, 0.4, 0.42]), 0, TAU, -0.1, Math.PI / 2, 0.7);
    S.sphere([x, 0.02, z], s * 1.02, sp(MAT.moss, [0.32, 0.46, 0.22]), 0, TAU, 0.9, Math.PI / 2, 0.7);
    S.disc([x, 0.012, z], s, s + 0.35, sp(MAT.moss, [0.34, 0.48, 0.24]));
    A.block(x, z, s + 0.15, s * 0.9 + 0.15);
  }
  // 池塘 + 池边石 + 锦鲤
  const pond = { x: inner.x0 + iw * 0.74, z: inner.z0 + id * 0.42, R: Math.min(iw * 0.17, id * 0.2) };
  S.disc([pond.x, 0.02, pond.z], 0, pond.R, sp(MAT.water, [0.05, 0.15, 0.18]));
  for (let i = 0; i < 26; i++) { const a = i / 26 * TAU; S.sphere([pond.x + Math.cos(a) * pond.R, 0.02, pond.z + Math.sin(a) * pond.R], 0.16 + rnd() * 0.08, sp(MAT.stone, [0.5, 0.5, 0.5]), 0, TAU, 0, Math.PI / 2, 0.7); }
  for (let f = 0; f < 6; f++) { const a = rnd() * TAU, q = rnd() * pond.R * 0.7, hd = rnd() * TAU; for (let i = 0; i < 18; i++) { const t = (rnd() - 0.5) * 0.34; S.dot([pond.x + Math.cos(a) * q + Math.cos(hd) * t, 0.03, pond.z + Math.sin(a) * q + Math.sin(hd) * t], [0, 1, 0], rnd() < 0.5 ? [1, 0.45, 0.12] : [0.95, 0.95, 0.92], 0.05); } }
  A.block(pond.x, pond.z, pond.R + 0.2);
  // 朱红拱桥
  const L = pond.R * 2.5, bw = 0.9, RED = sp(MAT.lacquer, [0.62, 0.18, 0.12]);
  const arc = (t) => 0.55 * Math.cos(t * Math.PI) + 0.06;
  for (let i = 0; i < 14; i++) {
    const t0 = i / 14 - 0.5, t1 = (i + 1) / 14 - 0.5;
    S.aabb(pond.x - bw / 2, arc(t0) - 0.04, pond.z + t0 * L, pond.x + bw / 2, arc(t0) + 0.02, pond.z + t1 * L, RED);
    for (const sx of [-1, 1]) S.tube([pond.x + sx * bw / 2, arc(t0) + 0.4, pond.z + t0 * L], [pond.x + sx * bw / 2, arc(t1) + 0.4, pond.z + t1 * L], 0.03, RED);
    if (i % 3 === 0) for (const sx of [-1, 1]) S.tube([pond.x + sx * bw / 2, arc(t0), pond.z + t0 * L], [pond.x + sx * bw / 2, arc(t0) + 0.42, pond.z + t0 * L], 0.03, RED);
  }
  // 石灯笼:台、柱、火袋(夜里亮)、笠
  const lanterns = [[pond.x + pond.R + 0.7, pond.z + pond.R * 0.4], [inner.x0 + iw * 0.2, inner.z0 + 0.8], [rocks[0][0] + 1.6, rocks[0][1] - 1.0]];
  const STONE = sp(MAT.stone, [0.6, 0.6, 0.57]);
  for (const [x, z] of lanterns) {
    S.aabb(x - 0.26, 0, z - 0.26, x + 0.26, 0.28, z + 0.26, STONE);
    S.cyl([x, 0, z], 0.1, 0.62, STONE, 0, TAU, 0.28);
    S.aabb(x - 0.22, 0.9, z - 0.22, x + 0.22, 0.95, z + 0.22, STONE);
    S.aabb(x - 0.17, 0.95, z - 0.17, x + 0.17, 1.28, z + 0.17, sp(MAT.paper, [1, 0.88, 0.62], null, F.glow), { top: false, bottom: false });
    S.sphere([x, 1.28, z], 0.38, STONE, 0, TAU, 0, 0.55, 0.5);
    S.sphere([x, 1.5, z], 0.07, STONE);
    for (let i = 0; i < 16; i++) G(x + (rnd() - 0.5) * 0.24, 1.0 + rnd() * 0.25, z + (rnd() - 0.5) * 0.24, [1, 0.76, 0.42], 0.1, 0.9, 1);
    A.lit(x, 1.1, z, 5.5, [1, 0.72, 0.42], 1.3);
    A.block(x, z, 0.4);
  }
  // 红枫、松
  const mx = inner.x0 + iw * 0.08, mz = inner.z0 + id * 0.12;
  tree(S, rnd, mx, mz, 2.0, [0.28, 0.18, 0.12], [[0.9, 0.24, 0.1], [1, 0.45, 0.14], [0.78, 0.14, 0.08], [0.95, 0.6, 0.2]], 1.7, 4200, seed);
  A.block(mx, mz, 0.45);
  const px = inner.x1 - iw * 0.06, pz = inner.z0 + id * 0.1;
  S.tube([px, 0, pz], [px + 0.2, 2.8, pz - 0.1], 0.15, sp(MAT.bark, [0.3, 0.22, 0.16]));
  for (let t = 0; t < 4; t++) S.disc([px + 0.1 + (rnd() - 0.5) * 0.4, 1.5 + t * 0.55, pz + (rnd() - 0.5) * 0.4], 0, 1.5 - t * 0.28, sp(MAT.leaf, [0.14, 0.32, 0.2], [0.22, 0.42, 0.26]));
  A.block(px, pz, 0.45);
}

/** 院子四周那几间房从院子里看得见的屋顶:两坡顶,脊沿长边,檐伸出去。 */
function roof(S, A, C) {
  const { r } = A, seed = A.seed;
  const along = (r.x1 - r.x0) >= (r.z1 - r.z0);
  const over = r.kind === 'pavilion' ? 0.7 : 1.0, steep = r.kind === 'pavilion' ? 0.62 : 0.45;
  const L = (along ? r.x1 - r.x0 : r.z1 - r.z0) + over * 2, Sp = (along ? r.z1 - r.z0 : r.x1 - r.x0) / 2 + over;
  const h = r.h, rise = Sp * steep;
  const col = r.kind === 'pavilion' ? [0.22, 0.23, 0.26] : sh(C.roof, 0.9);
  const spec = { mat: MAT.rooftile, c1: col, seed };
  const c0 = along ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2, a0 = (along ? r.x0 : r.z0) - over;
  const ridge = along ? [a0, h + rise, c0] : [c0, h + rise, a0];
  const Lv = along ? [L, 0, 0] : [0, 0, L];
  for (const sgn of [-1, 1]) {
    const down = along ? [0, -rise - over * steep, sgn * Sp] : [sgn * Sp, -rise - over * steep, 0];
    S.quad(ridge, Lv, down, spec, [along ? 0 : sgn, 1, along ? sgn : 0]);
  }
  const RIDGE = { mat: MAT.rooftile, c1: sh(col, 0.6), seed };
  if (along) S.aabb(a0, h + rise - 0.05, c0 - 0.15, a0 + L, h + rise + 0.2, c0 + 0.15, RIDGE);
  else S.aabb(c0 - 0.15, h + rise - 0.05, a0, c0 + 0.15, h + rise + 0.2, a0 + L, RIDGE);
}

/** 天:夜里星星和月亮,白天几朵云和太阳。发光点;只有露天的格局才画。 */
export function sky(G, rnd) {
  for (let i = 0; i < 2600; i++) {
    const an = rnd() * TAU, el = 0.12 + Math.pow(rnd(), 0.7) * 1.35, R = 110;
    G(Math.cos(an) * Math.cos(el) * R, 6 + Math.sin(el) * R, Math.sin(an) * Math.cos(el) * R, [0.85, 0.9, 1], 0.25 + rnd() * 0.5, 1, 1);
  }
  for (let i = 0; i < 900; i++) { const z = rnd() * 2 - 1, an = rnd() * TAU, q = Math.sqrt(1 - z * z) * Math.sqrt(rnd()); G(-36 + Math.cos(an) * q * 5, 62 + z * 5, -70 + Math.sin(an) * q * 5, [1, 0.97, 0.86], 1.6, 0.1, 1); }
  for (let c = 0; c < 8; c++) {
    const an = rnd() * TAU, R = 55 + rnd() * 35, cx = Math.cos(an) * R, cz = Math.sin(an) * R, cy = 30 + rnd() * 12;
    for (let i = 0; i < 500; i++) { const u = rnd() * 2 - 1, a = rnd() * TAU, q = Math.sqrt(1 - u * u) * Math.pow(rnd(), 0.4); G(cx + Math.cos(a) * q * 11, cy + u * 2.4, cz + Math.sin(a) * q * 6, [0.98, 0.98, 1], 4.5, 0.1, 3); }
  }
  for (let i = 0; i < 600; i++) { const z = rnd() * 2 - 1, an = rnd() * TAU, q = Math.sqrt(1 - z * z) * Math.sqrt(rnd()); G(46 + Math.cos(an) * q * 5, 66 + z * 5, -58 + Math.sin(an) * q * 5, [1, 0.94, 0.78], 2.4, 0.1, 3); }
}

/**
 * 盖一间屋子的建筑。
 * A: { r, ip, doors, isHall, open, lit(x,y,z,r,col,k), block(x,z,rx,rz), rnd, seed, roof:boolean }
 */
export function buildArchitecture(S, G, A) {
  const C = coloursOf(A.ip);
  const r = A.r, fl = r.open ? 0 : F.indoor;
  if (r.kind === 'court') { siheyuan(S, G, A, C); walls(S, G, A, C, 0); }
  else if (r.kind === 'garden') { garden(S, G, A, C); walls(S, G, A, C, 0); }
  else {
    floor(S, A, C, fl);
    walls(S, G, A, C, fl);
    ceiling(S, G, A, C, fl);
    fixtures(S, G, A, C, fl);
    if (A.isHall && A.ip.col !== 'none') {
      const W = r.x1 - r.x0, D = r.z1 - r.z0;
      const bays = Math.max(1, Math.min(4, A.ip.bays || 2));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let b = 0; b < bays; b++) {
        const x = (r.x0 + r.x1) / 2 + sx * (W / 2 - 2.0 - b * 3.4), z = (r.z0 + r.z1) / 2 + sz * (D / 2 - 1.9);
        if (Math.abs(x - (r.x0 + r.x1) / 2) < 2.2) continue;
        column(S, A, C, x, z, r.h, fl);
        A.block(x, z, 0.5);
      }
    }
  }
  if (A.roof) roof(S, A, C);
  return C;
}
