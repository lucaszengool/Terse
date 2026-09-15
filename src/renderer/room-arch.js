/**
 * room-arch.js — 一间屋子的**建筑**:地、墙、窗、顶、柱、灯具、门,以及露天格局里的
 * 四合院和庭院、屋顶、天。全部是 room-surface.js 的面(实打实的形体 + 程序材质),
 * 灯、火、星、光尘是发光点。
 *
 * 每种风格照着史料去做,不是换个颜色(依据见 room-styles.js 顶上的说明):
 *   唐宋  朱柱立在覆盆石础上,柱头一层斗拱,青绿叠晕彩画,平棊格子顶,八角藻井悬在主案上方
 *   江户  榻榻米错缝铺、黑布边;障子透光,襖是金箔;长押、栏间;竿缘天井;床之间
 *   古埃及 粗壮的莲花柱排成柱林,顶是深蓝底金星,墙上一层层浮雕带,纸莎草楣,凹弧檐口
 *   古希腊 凹槽柱、额枋、三陇板、回纹;颜色只在三米以上;蓝底金星的藻井;穹顶开天眼
 *   玛雅  赤铁矿红的墙、玛雅蓝的边,陡峭的叠涩拱,木梁横在起拱线上,灰塑面具
 *   波斯  钴蓝墙裙、星形花砖、书法带、蜂窝檐口;人字砖地上一块大地毯;花窗投下光斑
 *   北欧  竖板墙、斜十字撑,两排柱子分出三跨,中间一条长火塘,屋顶开烟孔,上半截被熏黑
 *   现代  洞石、胡桃木、极细的黄铜边,2cm 的暗缝,藏起来的暖光带
 *
 * 一间屋子装什么,由这个目录的代码决定(room-interior.js 的 interiorOf):同一个风格里,
 * 测试多的屋子、文档多的屋子、类型多的屋子,地、墙、顶都挑不同的件。
 */

import { MAT, F } from './room-surface.js';
import { mix, DOOR_W } from './room-interior.js';
import { designOf, kelvin } from './room-styles.js';

const TAU = Math.PI * 2;
const sh = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** 这间屋子用的颜色:风格的设计单给底色,代码只染一层 —— 主语言进点睛色,文件用途定冷暖。 */
export function coloursOf(ip) {
  const D = designOf(ip.style.id), p = D.pal, t = ip.tint || p.accent;
  const field = ip.mood ? mix(p.field, ip.mood.col, ip.mood.k * 0.4) : p.field;
  return Object.assign({}, p, {
    D, field, accent2: mix(p.accent2, t, 0.3),
    // 家具和旧代码用的名字
    timber: p.wood, plaster: field, stoneDark: sh(p.stone, 0.55), roof: ip.pal.roof, tint: t,
    // 灯光一半往白里靠:照亮东西、露出它们本来的颜色,而不是把一屋子都染成同一种橙金(火苗本身还是橙的)
    lamp: ((k) => [0.5 + 0.5 * k[0] * D.light.lampTint[0], 0.46 + 0.5 * k[1] * D.light.lampTint[1], 0.4 + 0.5 * k[2] * D.light.lampTint[2]])(kelvin(D.light.lampK)),
  });
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
    const segs = [];
    let a = w.lo;
    for (const g of w.gaps.slice().sort((p, q) => p[0] - q[0])) { if (g[0] > a) segs.push([a, g[0]]); a = Math.max(a, g[1]); }
    if (a < w.hi) segs.push([a, w.hi]);
    w.segs = segs;
    return w;
  });
}

/** 墙外面是露天(可以开窗),还是另一间屋子(开了窗就是看进隔壁)。 */
function exteriorAt(A, w, u, y) {
  // 给了高度 y 时:隔壁屋顶比这扇窗低,窗外就是天 —— 大殿高出两侧厢房的那一截开高侧窗
  const p = w.P(u, 1), qx = p[0] - w.n[0] * 0.5, qz = p[2] - w.n[2] * 0.5;
  return !(A.rooms || []).some((o) => o !== A.r && qx > o.x0 && qx < o.x1 && qz > o.z0 && qz < o.z1 && (y == null || y < o.h + 0.25));
}

/* ── 窗 ─────────────────────────────────────────────────────────────────────
   每种风格一种窗:光从哪里、以什么形状进来,是这个风格的一大半。 */
const WIN = {
  slats: (h) => ({ y0: h - 1.7, y1: h - 0.55, w: 1.4, step: 2.8 }),        // 古埃及高侧窗:石条
  lattice: (h) => ({ y0: 0.95, y1: Math.min(h - 0.8, 3.3), w: 1.6, step: 3.4 }), // 唐宋格扇窗
  shoji: (h) => ({ y0: 0.3, y1: Math.min(h - 0.55, 1.8), w: 1.7, step: 1.9 }),  // 障子
  jali: (h) => ({ y0: 2.1, y1: Math.min(h - 1.3, 4.0), w: 1.1, step: 3.0 }),    // 波斯花窗
  porthole: (h) => ({ y0: h - 1.35, y1: h - 0.75, w: 0.6, step: 3.2 }),        // 北欧"风眼"
  slots: (h) => ({ y0: 2.0, y1: Math.min(h - 1.0, 3.4), w: 0.38, step: 2.4 }),  // 玛雅窄窗
  glass: (h) => ({ y0: 0.25, y1: h - 0.3, w: 2.6, step: 3.0 }),               // 现代落地窗
};
function windowsOn(A, w, h, type, st) {
  const cfg = WIN[type](h);
  if (st === 'hellas') { cfg.y0 = h - 3.7; cfg.y1 = h - 2.5; }             // 希腊:窗在额枋下面,不切彩带
  if (cfg.y1 - cfg.y0 < 0.4 || cfg.y0 < 0.1) return { list: [], band: [0, 0] };
  const list = [];
  for (let c = w.lo + cfg.step; c + cfg.w / 2 < w.hi - 0.6; c += cfg.step) {
    const u0 = c - cfg.w / 2, u1 = c + cfg.w / 2;
    if (!w.segs.some(([a, b]) => u0 > a + 0.35 && u1 < b - 0.35)) continue;
    if (!exteriorAt(A, w, c, cfg.y0)) continue;
    list.push([u0, u1]);
  }
  return { list, band: [cfg.y0, cfg.y1] };
}
/** 墙面这一块减去窗洞,剩下的一块块交给 emit。 */
function cutRect(a, b, y0, y1, wins, band, emit) {
  if (!wins.length || y1 <= band[0] || y0 >= band[1]) return emit(a, b, y0, y1);
  if (y0 < band[0]) emit(a, b, y0, band[0]);
  if (y1 > band[1]) emit(a, b, band[1], y1);
  const m0 = Math.max(y0, band[0]), m1 = Math.min(y1, band[1]);
  let x = a;
  for (const [u0, u1] of wins) { if (u1 <= a || u0 >= b) continue; if (u0 > x) emit(x, Math.min(u0, b), m0, m1); x = Math.max(x, u1); }
  if (x < b) emit(x, b, m0, m1);
}
/** 窗框和窗格。格子是实物,阳光从格子之间漏进来,地上就是这扇窗的影子。 */
function windowFill(S, A, C, w, u0, u1, y0, y1, type, fl) {
  const seed = A.seed;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const P = (u, y, d = 0) => add3(w.P(u, y), sh(w.n, d));
  const mid = (u0 + u1) / 2, W = u1 - u0, H = y1 - y0;
  const frame = type === 'glass' ? sp(MAT.metal, C.accent) : type === 'slats' || type === 'jali' || type === 'slots' ? sp(MAT.sandstone, C.stone) : sp(MAT.wood, sh(C.struct, 0.9));
  S.box(P(mid, y0 - 0.08, 0.05), w.dir, w.n, W + 0.16, 0.08, 0.22, frame);
  S.box(P(mid, y1, 0.03), w.dir, w.n, W + 0.16, 0.08, 0.16, frame);
  const vbar = (u, bw, spec, dep = 0.07) => S.box(P(u, y0), w.dir, w.n, bw, H, dep, spec);
  const hbar = (y, bh, spec, dep = 0.07) => S.box(P(mid, y), w.dir, w.n, W, bh, dep, spec);
  switch (type) {
    case 'slats': for (let u = u0 + 0.12; u < u1 - 0.05; u += 0.28) vbar(u, 0.1, sp(MAT.sandstone, C.stone), 0.3); break;
    case 'lattice': {
      const bar = sp(MAT.wood, sh(C.struct, 0.55));
      for (let u = u0 + 0.12; u < u1 - 0.02; u += 0.12) vbar(u, 0.024, bar, 0.05);
      for (let y = y0 + 0.16; y < y1 - 0.02; y += 0.16) hbar(y, 0.024, bar, 0.05);
      break;
    }
    case 'shoji': {
      const bar = sp(MAT.wood, C.struct);
      for (let u = u0 + 0.2; u < u1 - 0.02; u += 0.2) vbar(u, 0.014, bar, 0.03);
      for (let y = y0 + 0.3; y < y1 - 0.02; y += 0.3) hbar(y, 0.014, bar, 0.03);
      // 纸:白天透光(uDayGlow),夜里被屋里的灯照得发暖;它挡直射光 —— 障子里没有硬光柱
      S.quad(P(u0, y0, -0.02), sh(w.dir, W), [0, H, 0], sp(MAT.paper, C.paper || [0.95, 0.91, 0.85]), w.n);
      break;
    }
    case 'jali': {
      const bar = sp(MAT.marble, C.stone, sh(C.stone, 0.8));
      for (let u = u0 + 0.14; u < u1 - 0.02; u += 0.14) vbar(u, 0.028, bar, 0.08);
      for (let y = y0 + 0.14; y < y1 - 0.02; y += 0.14) hbar(y, 0.028, bar, 0.08);
      // 斜向的一组,和横竖的叠成星格 —— 光斑是一地星星
      for (let k = -8; k < 16; k++) {
        const a = u0 + k * 0.28;
        S.tube(P(Math.max(u0, a), y0 + Math.max(0, u0 - a)), P(Math.min(u1, a + H), y0 + Math.min(H, u1 - a)), 0.012, bar);
      }
      break;
    }
    case 'porthole': {
      const R = W / 2, cy = (y0 + y1) / 2, ring = sp(MAT.wood, sh(C.struct, 0.7));
      for (let i = 0; i < 12; i++) { const a0 = i / 12 * TAU, a1 = (i + 1) / 12 * TAU; S.tube(P(mid + Math.cos(a0) * R, cy + Math.sin(a0) * R, 0.03), P(mid + Math.cos(a1) * R, cy + Math.sin(a1) * R, 0.03), 0.05, ring); }
      vbar(mid, 0.05, ring, 0.05); S.box(P(mid, cy - 0.025), w.dir, w.n, W, 0.05, 0.05, ring);
      break;
    }
    case 'glass': {
      S.quad(P(u0, y0, -0.01), sh(w.dir, W), [0, H, 0], sp(MAT.glass, [0.5, 0.58, 0.62], sh(C.struct, 0.8)), w.n);
      for (let u = u0; u <= u1 + 0.01; u += W / 2) vbar(u, 0.03, sp(MAT.metal, C.struct), 0.05);
      break;
    }
    default: break;
  }
  (A.windows || []).push({ o: w.P(u0, y0), U: sh(w.dir, W), V: [0, H, 0], n: w.n, type, r: A.r });
}

/* ══ 地 ═════════════════════════════════════════════════════════════════════ */
function floor(S, A, C, fl) {
  const { r, ip } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, st = ip.style.id, seed = A.seed;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const q = (mat, c1, c2) => S.quad([r.x0, 0, r.z0], [W, 0, 0], [0, 0, D], { mat, c1, c2: c2 || c1, flags: fl, seed }, [0, 1, 0]);
  const strip = (x0, z0, x1, z1, mat, c1, c2, y = 0.004) => S.quad([x0, y, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], { mat, c1, c2: c2 || c1, flags: fl, seed }, [0, 1, 0]);
  switch (st) {
    case 'tang':
      ip.floor === 'board' ? q(MAT.wood, mix(C.wood, C.floor, 0.35)) : q(MAT.tile40, C.floor);
      if (A.isHall) {
        // 主案前一张宝相花毯,四周一圈联珠纹边 —— 唐锦的两样招牌纹样,石青、石绿、朱砂、金
        const rw = Math.min(7.2, W * 0.36), rd = Math.min(6, D * 0.38), rx = cx - rw / 2, rz = r.z0 + 3.2;
        strip(rx - 0.45, rz - 0.45, rx + rw + 0.45, rz + rd + 0.45, MAT.lianzhu, [0.14, 0.22, 0.42], C.gold, 0.005);
        strip(rx, rz, rx + rw, rz + rd, MAT.baoxiang, [0.46, 0.12, 0.08], C.gold, 0.008);
      }
      if (ip.floor !== 'board') {
        // 方砖地沿墙内侧一圈联珠纹锦带(离墙 0.6m、宽 0.5m)
        const m = 0.5, bw = 0.9, LZ = [0.22, 0.34, 0.62];
        strip(r.x0 + m, r.z0 + m, r.x1 - m, r.z0 + m + bw, MAT.lianzhu, LZ, C.gold, 0.005);
        strip(r.x0 + m, r.z1 - m - bw, r.x1 - m, r.z1 - m, MAT.lianzhu, LZ, C.gold, 0.005);
        strip(r.x0 + m, r.z0 + m + bw, r.x0 + m + bw, r.z1 - m - bw, MAT.lianzhu, LZ, C.gold, 0.005);
        strip(r.x1 - m - bw, r.z0 + m + bw, r.x1 - m, r.z1 - m - bw, MAT.lianzhu, LZ, C.gold, 0.005);
      }
      break;
    case 'edo': ip.floor === 'tatami' ? q(MAT.tatami, C.floor, C.ink) : q(MAT.wood, C.wood); break;
    case 'giza':
      q(MAT.slab12, C.floor);
      if (A.isHall) {
        // 中殿一池彩绘地面(阿玛纳大宫的做法):蓝水、莲叶、睡莲、鱼,两边一道彩带镶边
        const x0 = cx - 1.5, x1 = cx + 1.5, z0 = r.z0 + 3.4, z1 = r.z1 - 3.0;
        strip(x0 - 0.22, z0 - 0.22, x1 + 0.22, z1 + 0.22, MAT.bands4, C.accent, C.accent2, 0.005);
        strip(x0, z0, x1, z1, MAT.pond, C.accent, C.gold, 0.008);
      }
      break;
    case 'hellas':
      if (ip.floor === 'mosaic') {
        q(MAT.mosaic, [0.86, 0.83, 0.76], [0.72, 0.66, 0.56]);   // 素色的石子底:颜色留给中间那块镶嵌画
        // 回纹边 + 中心一块圆形镶嵌画
        const m = 0.9, bw = 0.36;
        strip(r.x0 + m, r.z0 + m, r.x1 - m, r.z0 + m + bw, MAT.meander, [0.85, 0.82, 0.74], [0.14, 0.13, 0.12]);
        strip(r.x0 + m, r.z1 - m - bw, r.x1 - m, r.z1 - m, MAT.meander, [0.85, 0.82, 0.74], [0.14, 0.13, 0.12]);
        // 中心一块佩拉那样的卵石镶嵌(黑底卷草),外面一圈回纹
        const er = Math.min(W, D) * 0.2;
        S.disc([cx, 0.005, cz], er, er + 0.4, { mat: MAT.meander, c1: [0.85, 0.82, 0.74], c2: [0.3, 0.08, 0.05], flags: fl, seed });
        S.disc([cx, 0.006, cz], 0, er, { mat: MAT.pebble, c1: C.accent2, c2: C.gold, flags: fl, seed });
      } else q(MAT.tile, C.floor, C.stone);
      break;
    case 'maya':
      // 玛雅宫殿的地常是抹灰后刷赤铁矿红;两头一道玛雅蓝的边
      q(MAT.plaster, sh(C.field, 0.72));
      strip(r.x0, r.z0, r.x1, r.z0 + 0.35, MAT.lacquer, C.accent); strip(r.x0, r.z1 - 0.35, r.x1, r.z1, MAT.lacquer, C.accent);
      break;
    case 'persia': q(MAT.herringbone, C.floor); break;
    case 'norse':
      q(MAT.earth, C.floor);
      strip(r.x0, r.z0, r.x1, r.z0 + 1.4, MAT.wood, C.wood, null, 0.006); strip(r.x0, r.z1 - 1.4, r.x1, r.z1, MAT.wood, C.wood, null, 0.006);
      // 火塘两边各一条织毯(和墙上挂毯同一种:红底一队人马),从大殿这头铺到那头
      if (A.isHall) for (const sz of [-1, 1]) strip(r.x0 + 2, cz + sz * 1.9 - 0.4, r.x1 - 2, cz + sz * 1.9 + 0.4, MAT.tapestry, [0.55, 0.1, 0.06], C.gold, 0.007);
      break;
    // 现代一律洞石:发光网格地看着像廉价写字楼。测试多的屋子(grid)只是石头略深一档
    default:
      q(MAT.travertine, ip.floor === 'grid' ? sh(C.floor, 0.88) : C.floor);
      // 主案前一张色域羊毛毯:素净的洞石上,一块柔边的大色
      if (A.isHall) strip(cx - 3, r.z0 + 3, cx + 3, r.z0 + 7, MAT.colorfield, [A.rnd(), A.rnd(), A.rnd()], null, 0.008);
      break;
  }
}

/* ══ 墙 ═════════════════════════════════════════════════════════════════════ */
function walls(S, G, A, C, fl) {
  const { r, ip, doors } = A, h = r.h, seed = A.seed, st = ip.style.id;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const dh = Math.min(3.0, h * 0.74);
  const outdoor = r.kind === 'court' || r.kind === 'garden';
  const kind = r.kind === 'pavilion' ? 'pavilion' : r.kind === 'wing' ? 'wing' : r.kind === 'court' ? 'court' : r.kind === 'garden' ? 'fence' : st;
  const winType = outdoor || ip.wall === 'glass' ? null
    : r.kind === 'pavilion' ? 'shoji' : r.kind === 'wing' ? 'lattice'
    : (st === 'hellas' && ip.ceil === 'dome') ? null : C.D.window;
  const spring = st === 'maya' && !outdoor ? h * 0.5 : h;                    // 玛雅:墙只到起拱线,上面是叠涩拱
  for (const w of wallsOf(r, doors)) {
    const wins = winType ? windowsOn(A, w, spring, winType, st) : { list: [], band: [0, 0] };
    const put = (vert) => (a, b, y0, y1, spec) => cutRect(a, b, y0, y1, wins.list, wins.band, (a2, b2, y2, y3) => {
      if (b2 - a2 < 0.01 || y3 - y2 < 0.01) return;
      if (vert) S.quad(w.P(a2, y2), [0, y3 - y2, 0], sh(w.dir, b2 - a2), spec, w.n);
      else S.quad(w.P(a2, y2), sh(w.dir, b2 - a2), [0, y3 - y2, 0], spec, w.n);
    });
    const Q = put(false), QV = put(true);
    const strip = (y, hh, dep, spec) => { for (const [a, b] of w.segs) S.box(add3(w.P((a + b) / 2, y), sh(w.n, dep / 2)), w.dir, w.n, b - a, hh, dep, spec, { back: false, bottom: true }); };
    const interior = !exteriorAt(A, w, (w.lo + w.hi) / 2);
    const posts = (step, bw, dep, spec, y1 = h) => {
      for (let u = w.lo + step / 2; u < w.hi - 0.3; u += step) {
        if (w.gaps.some(([a, b]) => u > a - 0.4 && u < b + 0.4) || wins.list.some(([a, b]) => u > a - 0.1 && u < b + 0.1)) continue;
        S.box(add3(w.P(u, 0), sh(w.n, dep / 2)), w.dir, w.n, bw, y1, dep, spec, { back: false });
      }
    };
    for (const [a, b] of w.segs) {
      switch (kind) {
        case 'tang':
          if (ip.wall === 'timber') QV(a, b, 0, h - 0.95, sp(MAT.wood, C.wood));
          else { QV(a, b, 0, 0.9, sp(MAT.wood, C.wood)); Q(a, b, 0.9, h - 0.95, sp(MAT.plaster, C.field)); }
          Q(a, b, h - 0.95, h - 0.55, sp(MAT.lianzhu, [0.46, 0.12, 0.08], C.gold));   // 联珠团窠的锦带
          Q(a, b, h - 0.55, h, sp(MAT.caihua, C.accent, C.accent2));
          break;
        case 'edo': case 'pavilion':
          // 屋里的隔墙是金箔襖,外墙开障子;长押以上是栏间,再往上是聚乐土墙
          Q(a, b, 0, Math.min(1.8, h - 0.4), (interior || w.s === 'N') && kind === 'edo' ? sp(MAT.fusuma, C.gold) : sp(MAT.plaster, kind === 'pavilion' ? [0.9, 0.88, 0.8] : C.field));
          if (h > 2.3) Q(a, b, 1.9, Math.min(2.3, h - 0.05), sp(MAT.lattice, C.paper || [0.9, 0.86, 0.78], C.struct));
          if (h > 2.35) Q(a, b, 2.3, h, sp(MAT.plaster, kind === 'pavilion' ? [0.9, 0.88, 0.8] : C.field));
          break;
        case 'giza':
          // 墙裙黑、红、黄三道(奈菲尔塔丽墓),上面一层层彩色浮雕带,顶上一排纸莎草束楣(kheker)
          Q(a, b, 0, 0.16, sp(MAT.lacquer, [0.08, 0.07, 0.07]));
          Q(a, b, 0.16, 0.3, sp(MAT.lacquer, [0.62, 0.2, 0.12]));
          Q(a, b, 0.3, 0.44, sp(MAT.lacquer, [0.78, 0.6, 0.25]));
          Q(a, b, 0.44, h - 1.3, sp(MAT.glyph, C.relief || C.field, C.ink));
          Q(a, b, h - 1.3, h - 0.8, sp(MAT.kheker, C.relief || C.field, C.gold));
          Q(a, b, h - 0.8, h - 0.72, sp(MAT.lacquer, C.accent));
          break;
        case 'hellas':
          Q(a, b, 0, h - 2.2, sp(MAT.masonry, C.field, C.stone));   // 第一风格:仿石块的彩色灰泥,一块一种颜色
          Q(a, b, h - 2.2, h - 1.6, sp(MAT.marble, C.field, C.stone));
          Q(a, b, h - 1.6, h - 0.85, sp(MAT.triglyph, C.accent, C.accent2));
          Q(a, b, h - 0.85, h - 0.6, sp(MAT.meander, [0.78, 0.6, 0.28], C.blue2 || C.accent));
          Q(a, b, h - 0.6, h, sp(MAT.marble, C.field, C.stone));
          break;
        case 'maya':
          Q(a, b, 0, 0.9, sp(MAT.plaster, C.field));
          Q(a, b, 0.9, spring, sp(MAT.fresco, C.accent, C.ink));   // 伯南帕克:玛雅蓝底上一排排戴羽冠的人像
          break;
        case 'persia':
          Q(a, b, 0, 1.2, sp(MAT.mosaic, C.ink, C.accent));
          Q(a, b, 1.2, 1.3, sp(MAT.lacquer, C.stone));
          Q(a, b, 1.3, h - 1.7, sp(MAT.girih, C.accent, C.accent2));
          Q(a, b, h - 1.7, h - 0.9, sp(MAT.mirror, [0.8, 0.82, 0.88], C.gold));   // 镜面镶嵌(四十柱宫):碎镜星花,映着各色的光
          Q(a, b, h - 0.9, h - 0.36, sp(MAT.glyph, C.ink, C.stone));
          Q(a, b, h - 0.36, h, sp(MAT.lacquer, C.stone));
          break;
        case 'norse':
          QV(a, b, 0, 1.55, sp(MAT.wood, C.field));
          Q(a, b, 1.55, 2.15, sp(MAT.tapestry, [0.55, 0.1, 0.06], C.gold));   // 奥塞贝格那样的挂毯:红底一队人马
          QV(a, b, 2.15, h, sp(MAT.wood, C.field));
          break;
        case 'wing': case 'court':
          Q(a, b, 0, h, sp(MAT.brick, [0.42, 0.44, 0.46], [0.8, 0.78, 0.74]));
          break;
        case 'fence':
          Q(a, b, 0, h, sp(MAT.plaster, [0.9, 0.88, 0.82]));
          break;
        default:                                                                   // modern
          if (ip.wall === 'glass') {
            Q(a, b, 0, h, sp(MAT.glass, [0.48, 0.56, 0.6], C.struct));
            // 一整面玻璃墙就是一扇大窗:阳光带着竖梃的影子铺进来
            if (exteriorAt(A, w, (a + b) / 2)) (A.windows || []).push({ o: w.P(a, 0), U: sh(w.dir, b - a), V: [0, h, 0], n: w.n, type: 'glass', r: A.r }); for (let u = a + 1.3; u < b; u += 1.3) S.box(add3(w.P(u, 0), sh(w.n, 0.03)), w.dir, w.n, 0.035, h, 0.06, sp(MAT.metal, C.struct), { back: false }); }
          else if (w.s === 'N') QV(a, b, 0.03, h - 0.03, sp(MAT.wood, C.wood));       // 背墙:一整面胡桃木
          else Q(a, b, 0.03, h - 0.03, sp(MAT.plaster, C.field));
          // 色域画:一幅一种配色 —— 素净的屋子里,最亮的颜色挂在墙上
          if (ip.wall !== 'glass' && w.s !== 'N') for (let u = a + 2.2; u + 1.9 < b; u += 4.6) {
            if (wins.list.some(([x0, x1]) => u + 1.7 > x0 && u < x1)) continue;
            S.quad(add3(w.P(u, 1.1), sh(w.n, 0.04)), sh(w.dir, 1.7), [0, 1.3, 0], sp(MAT.colorfield, [A.rnd(), A.rnd(), A.rnd()]), w.n);
            S.box(add3(w.P(u + 0.85, 1.06), sh(w.n, 0.02)), w.dir, w.n, 1.78, 0.04, 0.04, sp(MAT.metal, C.gold));
          }
          Q(a, b, 0, 0.03, sp(MAT.lacquer, C.struct)); Q(a, b, h - 0.03, h, sp(MAT.lacquer, C.struct));   // 2cm 暗缝
      }
    }
    // 门楣:门洞上方那一截墙
    for (const [a, b] of w.gaps) {
      const lintel = kind === 'giza' ? sp(MAT.glyph, C.relief || C.field, C.ink) : kind === 'persia' ? sp(MAT.girih, C.accent, C.accent2)
        : kind === 'norse' ? sp(MAT.wood, C.field) : kind === 'maya' ? sp(MAT.plaster, C.field)
        : kind === 'wing' || kind === 'court' ? sp(MAT.brick, [0.42, 0.44, 0.46], [0.8, 0.78, 0.74])
        : kind === 'tang' ? sp(MAT.plaster, C.field) : sp(MAT.plaster, kind === 'fence' ? [0.9, 0.88, 0.82] : C.field);
      Q(a, b, dh, spring, lintel);
      // 门框只由大厅(院子)这一侧画 —— 两边各画一副就叠在一起闪
      if (A.frames === false) continue;
      doorFrame(S, A, C, w, a, b, dh, kind, fl);
    }
    // 各风格墙上的线脚
    switch (kind) {
      case 'tang': posts(3.4, 0.32, 0.14, sp(MAT.lacquer, C.struct), h - 0.55); strip(0, 0.14, 0.05, sp(MAT.stone, C.stone)); break;
      case 'edo': case 'pavilion':
        posts(1.9, 0.12, 0.12, sp(MAT.wood, C.struct));
        if (h > 2.0) strip(1.8, 0.1, 0.07, sp(MAT.wood, C.struct));             // 长押
        strip(0, 0.06, 0.04, sp(MAT.wood, C.struct));
        break;
      case 'giza':
        for (let y = 1.5; y < h - 1.35; y += 1.0) { strip(y, 0.06, 0.02, sp(MAT.lacquer, C.accent)); strip(y + 0.06, 0.03, 0.02, sp(MAT.lacquer, [0.62, 0.2, 0.12])); }
        strip(h - 0.72, 0.72, 0.36, sp(MAT.bands4, C.accent, C.accent2));        // 凹弧檐口
        strip(h - 0.8, 0.08, 0.14, sp(MAT.lacquer, C.gold));                     // 圆线脚
        break;
      case 'hellas':
        for (const y of [h - 2.0, h - 1.82]) strip(y, 0.03, 0.03, sp(MAT.marble, C.field, C.stone));   // 额枋的三道横线
        strip(h - 0.6, 0.6, 0.34, sp(MAT.marble, C.field, C.stone));
        for (const [a, b] of w.segs) for (let u = a + 0.1; u < b - 0.1; u += 0.24) S.box(add3(w.P(u, h - 0.72), sh(w.n, 0.06)), w.dir, w.n, 0.12, 0.12, 0.12, sp(MAT.lacquer, Math.round((u - a) / 0.24) % 2 ? C.gold : C.accent2), { back: false });
        break;
      case 'maya':
        strip(0.9, 0.14, 0.03, sp(MAT.lacquer, C.accent)); strip(spring - 0.18, 0.18, 0.05, sp(MAT.lacquer, C.accent));
        for (let u = w.lo + 1.4; u < w.hi - 0.5; u += 2.6) {
          if (w.gaps.some(([a, b]) => u > a - 0.4 && u < b + 0.4) || wins.list.some(([a, b]) => u > a - 0.3 && u < b + 0.3)) continue;
          S.quad(add3(w.P(u - 0.16, 1.15), sh(w.n, 0.01)), sh(w.dir, 0.32), [0, spring - 1.5, 0], sp(MAT.glyph, C.ceil, C.ink), w.n);
        }
        break;
      case 'persia':
        strip(h - 0.36, 0.12, 0.1, sp(MAT.metal, C.gold)); strip(h - 0.24, 0.12, 0.2, sp(MAT.mosaic, C.accent2, C.stone)); strip(h - 0.12, 0.12, 0.3, sp(MAT.lacquer, C.stone));
        strip(1.2, 0.04, 0.02, sp(MAT.metal, C.gold));
        break;
      case 'norse':
        strip(0, 0.2, 0.12, sp(MAT.wood, C.ink));                                 // 地梁
        strip(h - 0.25, 0.25, 0.14, sp(MAT.wood, C.struct));
        // 斜十字撑:每跨一对
        for (let u = w.lo + 0.3; u < w.hi - 2.4; u += 2.4) {
          if (w.gaps.some(([a, b]) => u + 2.1 > a && u < b)) continue;
          const y0 = h * 0.55, y1 = h - 0.3, wood = sp(MAT.wood, C.struct);
          S.tube(add3(w.P(u, y0), sh(w.n, 0.08)), add3(w.P(u + 2.1, y1), sh(w.n, 0.08)), 0.05, wood);
          S.tube(add3(w.P(u, y1), sh(w.n, 0.08)), add3(w.P(u + 2.1, y0), sh(w.n, 0.08)), 0.05, wood);
        }
        break;
      case 'wing': case 'court': case 'fence':
        strip(h - 0.2, 0.2, 0.3, sp(MAT.rooftile, kind === 'fence' ? [0.26, 0.27, 0.3] : C.roof));
        break;
      default:
        break;
    }
    for (const [u0, u1] of wins.list) windowFill(S, A, C, w, u0, u1, wins.band[0], wins.band[1], winType, fl);
  }
}

/** 门框,各是各的:唐宋朱漆、埃及凹弧檐、波斯尖拱、北欧雕花门柱、现代一线黄铜。 */
function doorFrame(S, A, C, w, a, b, dh, kind, fl) {
  const seed = A.seed, sp = (mat, c1, c2) => ({ mat, c1, c2: c2 || c1, flags: fl, seed });
  const mid = (a + b) / 2;
  const post = (u, bw, dep, spec) => S.box(w.P(u, 0), w.dir, w.n, bw, dh, dep, spec);
  const head = (y, hh, ww, dep, spec) => S.box(w.P(mid, y), w.dir, w.n, ww, hh, dep, spec, { bottom: true });
  switch (kind) {
    case 'tang': case 'wing': post(a + 0.08, 0.16, 0.24, sp(MAT.lacquer, C.struct || [0.6, 0.18, 0.12])); post(b - 0.08, 0.16, 0.24, sp(MAT.lacquer, C.struct || [0.6, 0.18, 0.12])); head(dh, 0.2, b - a + 0.3, 0.26, sp(MAT.caihua, C.accent || [0.12, 0.3, 0.48], C.accent2 || [0.18, 0.48, 0.4])); break;
    case 'edo': case 'pavilion': post(a + 0.06, 0.12, 0.14, sp(MAT.wood, C.struct)); post(b - 0.06, 0.12, 0.14, sp(MAT.wood, C.struct)); head(dh, 0.1, b - a, 0.14, sp(MAT.wood, C.struct)); break;
    case 'giza':
      post(a + 0.12, 0.24, 0.3, sp(MAT.glyph, C.relief || C.field, C.ink)); post(b - 0.12, 0.24, 0.3, sp(MAT.glyph, C.relief || C.field, C.ink));
      head(dh, 0.12, b - a + 0.3, 0.34, sp(MAT.lacquer, C.gold)); head(dh + 0.12, 0.34, b - a + 0.6, 0.42, sp(MAT.bands4, C.accent, C.accent2));
      break;
    case 'persia': {
      post(a + 0.08, 0.16, 0.2, sp(MAT.mosaic, C.accent, C.accent2)); post(b - 0.08, 0.16, 0.2, sp(MAT.mosaic, C.accent, C.accent2));
      // 尖拱:两段圆弧在门顶上方相交
      const half = (b - a) / 2, R = half * 1.25, gold = sp(MAT.metal, C.gold);
      for (const sgn of [-1, 1]) {
        const cxu = mid - sgn * (R - half);
        for (let i = 0; i < 10; i++) {
          const t0 = i / 10, t1 = (i + 1) / 10, a0 = Math.acos((half - (R - half)) / R) * 0 + t0 * Math.acos((R - half) / R), a1 = t1 * Math.acos((R - half) / R);
          S.tube(add3(w.P(cxu + sgn * Math.cos(a0) * R, dh + Math.sin(a0) * R), sh(w.n, 0.06)), add3(w.P(cxu + sgn * Math.cos(a1) * R, dh + Math.sin(a1) * R), sh(w.n, 0.06)), 0.05, gold);
        }
      }
      break;
    }
    case 'maya': post(a + 0.2, 0.4, 0.5, sp(MAT.plaster, C.ceil)); post(b - 0.2, 0.4, 0.5, sp(MAT.plaster, C.ceil)); head(dh, 0.3, b - a + 0.5, 0.5, sp(MAT.wood, C.wood)); break;
    case 'norse':
      post(a + 0.12, 0.24, 0.26, sp(MAT.interlace, C.struct, C.accent)); post(b - 0.12, 0.24, 0.26, sp(MAT.interlace, C.struct, C.accent));
      head(dh, 0.26, b - a + 0.4, 0.28, sp(MAT.interlace, C.struct, C.accent));
      break;
    case 'hellas': post(a + 0.1, 0.2, 0.3, sp(MAT.marble, C.field, C.stone)); post(b - 0.1, 0.2, 0.3, sp(MAT.marble, C.field, C.stone)); head(dh, 0.24, b - a + 0.4, 0.32, sp(MAT.meander, [0.78, 0.6, 0.28], C.blue2 || C.accent)); break;
    case 'court': case 'fence': break;
    default: post(a + 0.015, 0.03, 0.08, sp(MAT.metal, C.gold)); post(b - 0.015, 0.03, 0.08, sp(MAT.metal, C.gold)); head(dh, 0.03, b - a, 0.08, sp(MAT.metal, C.gold));
  }
}

/* ══ 顶 ═════════════════════════════════════════════════════════════════════ */
function ceiling(S, G, A, C, fl) {
  const { r, ip } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, h = r.h, st = ip.style.id, seed = A.seed;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const flat = (spec, y = h) => S.quad([r.x0, y, r.z0], [W, 0, 0], [0, 0, D], spec, [0, -1, 0]);
  const beamX = (z, bw, bh, spec) => S.aabb(r.x0, h - bh, z - bw / 2, r.x1, h, z + bw / 2, spec, { top: false, bottom: true });
  const beamZ = (x, bw, bh, spec) => S.aabb(x - bw / 2, h - bh, r.z0, x + bw / 2, h, r.z1, spec, { top: false, bottom: true });
  const dome = (sq, mat, c1, c2, oculus) => {
    const R = Math.min(W, D) / 2 * 0.92;
    S.disc([cx, h, cz], R, Math.hypot(W, D) / 2 + 0.2, sp(MAT.plaster, C.field), true);
    const e1 = oculus ? Math.acos(0.19) : Math.PI / 2 - 0.06;
    S.sphere([cx, h, cz], R, Object.assign(sp(mat, c1, c2), { flags: fl | F.flip }), 0, TAU, 0, e1, sq);
    S.disc([cx, h, cz], R - 0.14, R + 0.05, sp(MAT.metal, C.gold), true);
    if (oculus) {
      const yT = h + R * sq * Math.sin(e1), rr = R * Math.cos(e1);
      S.disc([cx, yT, cz], rr, rr + 0.14, sp(MAT.metal, [0.55, 0.45, 0.28]), true);
      (A.windows || []).push({ o: [cx - rr, yT, cz - rr], U: [rr * 2, 0, 0], V: [0, 0, rr * 2], n: [0, -1, 0], type: 'oculus', r: A.r });
    }
  };
  switch (st) {
    case 'tang':
      if (ip.ceil === 'beam') { flat(sp(MAT.wood, sh(C.wood, 0.8))); for (let z = r.z0 + 1.2; z < r.z1 - 0.3; z += 1.2) beamX(z, 0.16, 0.2, sp(MAT.wood, C.wood)); }
      else flat(sp(MAT.gridcoffer, C.accent2, C.gold));
      for (let x = r.x0 + 3.4; x < r.x1 - 0.5; x += 3.4) beamZ(x, 0.3, 0.36, sp(MAT.caihua, C.accent, C.accent2));
      break;
    case 'edo':
      flat(sp(MAT.wood, C.ceil));
      for (let z = r.z0 + 0.45; z < r.z1 - 0.1; z += 0.45) beamX(z, 0.03, 0.035, sp(MAT.wood, C.struct));   // 竿缘
      if (ip.ceil === 'beam') for (let x = r.x0 + 2.8; x < r.x1 - 0.5; x += 2.8) beamZ(x, 0.2, 0.22, sp(MAT.wood, C.struct));
      break;
    case 'giza':
      flat(sp(MAT.stars, C.ceil, C.gold));
      if (ip.ceil === 'corbel') for (let k = 0; k < 3; k++) { const i = 0.3 + k * 0.4, y = h - 0.9 + k * 0.3, spec = sp(MAT.bands4, C.accent, C.accent2); S.aabb(r.x0, y, r.z0, r.x1, y + 0.3, r.z0 + i, spec); S.aabb(r.x0, y, r.z1 - i, r.x1, y + 0.3, r.z1, spec); }
      break;
    case 'hellas':
      if (ip.ceil === 'dome') dome(0.9, MAT.cofferstar, C.ceil, C.gold, true);
      else {
        flat(sp(MAT.cofferstar, C.ceil, C.gold));
        for (let x = r.x0 + 2.4; x < r.x1 - 0.4; x += 2.4) beamZ(x, 0.2, 0.3, sp(MAT.marble, C.field, C.stone));
        for (let z = r.z0 + 2.4; z < r.z1 - 0.4; z += 2.4) beamX(z, 0.2, 0.3, sp(MAT.marble, C.field, C.stone));
      }
      break;
    case 'maya': {
      // 叠涩拱:两边一层层往里收,每层 7cm 起步,收成一条窄窄的拱顶石
      const along = W >= D, span = along ? D : W, L = along ? W : D, y0 = h * 0.5, n = 12;
      const half = span / 2, inStep = (half - 0.25) / n, upStep = (h - y0) / n;
      const c0 = along ? cz : cx, l0 = along ? r.x0 : r.z0;
      for (let k = 0; k < n; k++) {
        for (const sgn of [-1, 1]) {
          const a = c0 + sgn * (half - k * inStep), b = c0 + sgn * (half - (k + 1) * inStep), y = y0 + k * upStep;
          const lo = Math.min(a, b), hi = Math.max(a, b);
          const spec = sp(MAT.plaster, k === 0 ? C.accent : C.ceil);
          if (along) S.aabb(l0, y, lo, l0 + L, y + upStep, hi, spec, { top: false, bottom: true, front: sgn < 0, back: sgn > 0, left: false, right: false });
          else S.aabb(lo, y, l0, hi, y + upStep, l0 + L, spec, { top: false, bottom: true, left: sgn > 0, right: sgn < 0, front: false, back: false });
        }
      }
      if (along) S.quad([r.x0, h, c0 - 0.25], [W, 0, 0], [0, 0, 0.5], sp(MAT.plaster, C.ceil), [0, -1, 0]);
      else S.quad([c0 - 0.25, h, r.z0], [0.5, 0, 0], [0, 0, D], sp(MAT.plaster, C.ceil), [0, -1, 0]);
      // 起拱线上一根根横梁(人心果木)
      for (let t = l0 + 0.6; t < l0 + L - 0.3; t += 0.9) {
        if (along) S.tube([t, y0 + 0.05, c0 - half + 0.05], [t, y0 + 0.05, c0 + half - 0.05], 0.07, sp(MAT.wood, C.wood));
        else S.tube([c0 - half + 0.05, y0 + 0.05, t], [c0 + half - 0.05, y0 + 0.05, t], 0.07, sp(MAT.wood, C.wood));
      }
      break;
    }
    case 'persia':
      if (ip.ceil === 'dome' || ip.ceil === 'onion') {
        dome(ip.ceil === 'onion' ? 1.35 : 0.95, MAT.girih, C.accent, C.accent2, false);
        const R = Math.min(W, D) / 2 * 0.92, yT = h + R * (ip.ceil === 'onion' ? 1.35 : 0.95) - 0.1;
        S.disc([cx, yT, cz], 0, R * 0.2, sp(MAT.mosaic, C.gold, C.accent2), true);   // 顶心放射团花
      } else flat(sp(MAT.girih, C.accent, C.accent2));
      break;
    case 'norse': {
      // 两坡屋顶的内面:乌黑的松木板、一根根椽,屋脊中间开烟孔
      const along = W >= D, span = along ? D : W, L = along ? W : D, half = span / 2, rise = half * 0.9;
      const c0 = along ? cz : cx, l0 = along ? r.x0 : r.z0, gap = 0.7, mid = l0 + L / 2;
      const roofQ = (t0, t1, sgn, frac) => {
        const e = [0, 0, 0], ridge = along ? [t0, h + rise * frac, c0 + sgn * half * (1 - frac)] : [c0 + sgn * half * (1 - frac), h + rise * frac, t0];
        const Lv = along ? [t1 - t0, 0, 0] : [0, 0, t1 - t0];
        const down = along ? [0, -rise * frac, sgn * half * frac] : [sgn * half * frac, -rise * frac, 0];
        S.quad(ridge, Lv, down, sp(MAT.wood, C.ceil), [along ? 0 : -sgn, -1, along ? -sgn : 0]);
        return e;
      };
      for (const sgn of [-1, 1]) { roofQ(l0, mid - gap, sgn, 1); roofQ(mid + gap, l0 + L, sgn, 1); roofQ(mid - gap, mid + gap, sgn, 0.72); }
      for (let t = l0 + 0.45; t < l0 + L; t += 0.9) for (const sgn of [-1, 1]) {
        const a = along ? [t, h, c0 + sgn * half] : [c0 + sgn * half, h, t], b = along ? [t, h + rise, c0] : [c0, h + rise, t];
        S.tube(a, b, 0.07, sp(MAT.wood, sh(C.struct, 0.7)));
      }
      // 山墙:两头的三角,用一条条横板叠出来
      for (const end of [l0, l0 + L]) for (let k = 0; k < 10; k++) {
        const f0 = k / 10, f1 = (k + 1) / 10, wdt = span * (1 - f0);
        const y = h + rise * f0, hh = rise * (f1 - f0) + 0.02;
        if (along) S.aabb(end - 0.03, y, c0 - wdt / 2, end + 0.03, y + hh, c0 + wdt / 2, sp(MAT.wood, C.ceil));
        else S.aabb(c0 - wdt / 2, y, end - 0.03, c0 + wdt / 2, y + hh, end + 0.03, sp(MAT.wood, C.ceil));
      }
      (A.windows || []).push({ o: along ? [mid - gap, h + rise * 0.72, c0 - 0.3] : [c0 - 0.3, h + rise * 0.72, mid - gap], U: along ? [gap * 2, 0, 0] : [0, 0, gap * 2], V: along ? [0, 0, 0.6] : [0.6, 0, 0], n: [0, -1, 0], type: 'smokehole', r: A.r });
      A.ridge = h + rise;
      break;
    }
    default:                                                                         // modern
      flat(sp(MAT.plaster, C.field));
      if (ip.ceil === 'coffer') { for (let x = r.x0 + 1.8; x < r.x1 - 0.4; x += 1.8) beamZ(x, 0.12, 0.4, sp(MAT.plaster, sh(C.field, 0.95))); for (let z = r.z0 + 1.8; z < r.z1 - 0.4; z += 1.8) beamX(z, 0.12, 0.4, sp(MAT.plaster, sh(C.field, 0.95))); }
      else S.quad([cx - W * 0.3, h - 0.005, cz - 0.12], [W * 0.6, 0, 0], [0, 0, 0.24], sp(MAT.lacquer, C.struct), [0, -1, 0]);
  }
}

/* ══ 柱 ═════════════════════════════════════════════════════════════════════ */
export function column(S, A, C, x, z, h, fl) {
  const { ip } = A, seed = A.seed, st = ip.style.id;
  const sp = (mat, c1, c2) => ({ mat, c1, c2: c2 || c1, flags: fl, seed });
  switch (st) {
    case 'tang': {                                                                   // 朱柱 + 覆盆础 + 斗拱
      const tier = Math.min(1.3, h * 0.2), colH = h - tier, rr = Math.max(0.2, colH / 18);
      S.cyl([x, 0, z], rr * 1.5, 0.12, sp(MAT.stone, C.stone));
      S.sphere([x, 0.12, z], rr * 1.4, sp(MAT.stone, C.stone), 0, TAU, 0, 1.0, 0.35);
      S.cyl([x, 0, z], rr, colH - 0.2, sp(MAT.lacquer, C.struct), 0, TAU, 0.2);
      for (let k = 0; k < 3; k++) {
        const y = colH + k * tier / 3, wdt = 0.5 + k * 0.42, hh = tier / 3 - 0.02;
        S.aabb(x - wdt / 2, y, z - 0.17, x + wdt / 2, y + hh, z + 0.17, sp(MAT.caihua, k % 2 ? C.accent2 : C.accent, k % 2 ? C.accent : C.accent2));
        S.aabb(x - 0.17, y, z - wdt / 2, x + 0.17, y + hh, z + wdt / 2, sp(MAT.caihua, k % 2 ? C.accent : C.accent2, k % 2 ? C.accent2 : C.accent));
        for (const s1 of [-1, 1]) { S.aabb(x + s1 * wdt / 2 - 0.1, y + hh - 0.08, z - 0.1, x + s1 * wdt / 2 + 0.1, y + hh + 0.02, z + 0.1, sp(MAT.lacquer, C.gold)); }
      }
      break;
    }
    case 'giza': {                                                                   // 莲花柱:粗、上四分之一彩带、闭合花苞柱头
      const rr = Math.min(0.85, Math.max(0.45, h / 11));
      S.cyl([x, 0, z], rr * 1.15, 0.2, sp(MAT.sandstone, C.stone));
      S.cyl([x, 0, z], rr, h * 0.62, sp(MAT.glyph, C.field, C.ink), 0, TAU, 0.2);   // 柱身是砂岩色,不是浮雕的白底
      S.cyl([x, 0, z], rr * 1.01, h * 0.16, sp(MAT.bands4, C.accent, C.accent2), 0, TAU, 0.2 + h * 0.62);
      S.sphere([x, h * 0.82, z], rr * 1.18, sp(MAT.bands4, C.accent2, C.accent), 0, TAU, -1.2, 1.35, 0.9);
      S.aabb(x - rr * 0.9, h - 0.3, z - rr * 0.9, x + rr * 0.9, h, z + rr * 0.9, sp(MAT.sandstone, C.stone));
      break;
    }
    case 'hellas': {                                                                 // 凹槽柱:柱础台阶、馒头柱头、方顶板
      const rr = Math.max(0.3, h / 13);
      S.aabb(x - rr * 1.5, 0, z - rr * 1.5, x + rr * 1.5, 0.2, z + rr * 1.5, sp(MAT.marble, C.field, C.stone));
      S.cyl([x, 0, z], rr, h - 0.75, sp(MAT.fluted, C.field), 0, TAU, 0.2);
      S.sphere([x, h - 0.55, z], rr * 1.4, sp(MAT.marble, C.field, C.stone), 0, TAU, -0.2, 0.9, 0.42);
      S.aabb(x - rr * 1.45, h - 0.28, z - rr * 1.45, x + rr * 1.45, h - 0.05, z + rr * 1.45, sp(MAT.marble, C.field, C.stone));
      break;
    }
    case 'persia':
      S.cyl([x, 0, z], 0.26, 0.2, sp(MAT.marble, C.stone));
      S.cyl([x, 0, z], 0.15, h - 0.8, sp(MAT.mosaic, C.accent, C.accent2), 0, TAU, 0.2);
      for (let k = 0; k < 3; k++) { const wdt = 0.36 + k * 0.16, y = h - 0.6 + k * 0.2; S.aabb(x - wdt / 2, y, z - wdt / 2, x + wdt / 2, y + 0.2, z + wdt / 2, sp(k === 1 ? MAT.mosaic : MAT.metal, k === 1 ? C.accent2 : C.gold, C.stone)); }
      break;
    case 'norse': {                                                                  // 立柱 + 顶上一圈交织纹 + 兽头
      S.cyl([x, 0, z], 0.17, h, sp(MAT.wood, C.struct));
      S.cyl([x, 0, z], 0.18, 0.28, sp(MAT.interlace, C.struct, C.accent), 0, TAU, h - 0.55);
      const cx = (A.r.x0 + A.r.x1) / 2, cz = (A.r.z0 + A.r.z1) / 2, dx = cx - x, dz = cz - z, dl = Math.hypot(dx, dz) || 1;
      S.sphere([x + dx / dl * 0.12, h - 0.75, z + dz / dl * 0.12], 0.13, sp(MAT.lacquer, C.accent));
      S.tube([x + dx / dl * 0.18, h - 0.78, z + dz / dl * 0.18], [x + dx / dl * 0.42, h - 0.84, z + dz / dl * 0.42], 0.06, sp(MAT.lacquer, C.accent));
      break;
    }
    case 'maya':
      S.aabb(x - 0.35, 0, z - 0.35, x + 0.35, h * 0.5, z + 0.35, sp(MAT.plaster, C.ceil));
      S.aabb(x - 0.37, 1.0, z - 0.37, x + 0.37, 1.14, z + 0.37, sp(MAT.lacquer, C.accent));
      break;
    default:                                                                           // modern:一根极细的拉丝钢柱
      S.cyl([x, 0, z], 0.08, h, sp(MAT.metal, [0.55, 0.56, 0.58]));
  }
}

/** 大厅里的柱子怎么排:埃及是柱林,北欧是两排分出三跨,江户不立柱,其余沿边一跨一跨。 */
function hallColumns(S, A, C, fl) {
  const { r, ip } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, st = ip.style.id;
  if (st === 'edo' || ip.col === 'none') return;
  const at = (x, z) => { if (A.doors.some((d) => Math.hypot(d.cx - x, d.cz - z) < 2.2)) return; column(S, A, C, x, z, st === 'maya' ? r.h * 0.5 : r.h, fl); A.block(x, z, st === 'giza' ? 1.0 : 0.5); };
  if (st === 'giza') {
    const rows = D > 13 ? [D / 2 - 2.2, D / 2 - 4.6] : [D / 2 - 2.2];
    for (const dz of rows) for (const sz of [-1, 1]) for (let x = r.x0 + 2.4; x < r.x1 - 2.2; x += 2.6) { if (Math.abs(x - cx) < 2.4) continue; at(x, cz + sz * dz); }
    return;
  }
  if (st === 'norse') {
    for (const sz of [-1, 1]) for (let x = r.x0 + 2.0; x < r.x1 - 1.8; x += 2.6) at(x, cz + sz * D * 0.24);
    return;
  }
  const bays = Math.max(1, Math.min(4, ip.bays || 2));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let b = 0; b < bays; b++) {
    const x = cx + sx * (W / 2 - 2.0 - b * 3.4), z = cz + sz * (D / 2 - 1.9);
    if (Math.abs(x - cx) < 2.2) continue;
    at(x, z);
  }
}

/* ══ 灯 ═════════════════════════════════════════════════════════════════════
   灯具是实物(金属圈、纸灯罩、铜盆),亮的那部分是发光点;再登记一盏"灯"给夜光用。
   灯的颜色由风格的色温决定:宫灯 2200K 偏红、北欧火塘 1800K、现代 2700K。 */
function fixtures(S, G, A, C, fl) {
  const { r, ip, isHall } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, h = r.h, st = ip.style.id;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, R = Math.min(W, D) / 2, rnd = A.rnd, seed = A.seed;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  const lamp = C.lamp, GOLD = sp(MAT.metal, C.gold);
  const glowBall = (x, y, z, rad, col, n, size) => { for (let i = 0; i < n; i++) { const a = rnd() * TAU, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u) * rad * Math.sqrt(rnd()); G(x + Math.cos(a) * q, y + u * rad * 0.8, z + Math.sin(a) * q, col, size, 0.7, 1); } };
  const ring = (x, y, z, rad, spec, segs = 20) => { for (let i = 0; i < segs; i++) { const a0 = i / segs * TAU, a1 = (i + 1) / segs * TAU; S.tube([x + Math.cos(a0) * rad, y, z + Math.sin(a0) * rad], [x + Math.cos(a1) * rad, y, z + Math.sin(a1) * rad], 0.022, spec); } };
  const flame = (x, y, z, H, n) => {
    for (let i = 0; i < n; i++) {
      const t = Math.pow(rnd(), 1.5), j = (rnd() * 5) | 0, ph = j / 5 * TAU, hh = H * (0.7 + ((j * 37) % 5) * 0.08);
      const wdt = H * 0.2 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t)), 0.8) * (1 - t * 0.5), aa = rnd() * TAU, rr = wdt * Math.sqrt(rnd());
      const col = t < 0.3 ? [1, 0.95, 0.8] : t < 0.65 ? [1, 0.6, 0.2] : [0.9, 0.25, 0.08];
      G(x + Math.cos(ph) * 0.06 * (1 - t) + Math.cos(aa) * rr, y + t * hh, z + Math.sin(ph) * 0.06 * (1 - t) + Math.sin(aa) * rr, col, 0.06 + (1 - t) * 0.05, 1, 1);
    }
    for (let i = 0; i < n / 5; i++) { const t = rnd(); G(x + (rnd() - 0.5) * 0.5 * t, y + H + t * 2.2, z + (rnd() - 0.5) * 0.5 * t, [1, 0.5, 0.15], 0.018, 1, 1); }   // 火星往上飘
  };
  const smoke = (x, y, z, top, n, spread) => { for (let i = 0; i < n; i++) { const t = rnd(), ph = t * 9 + rnd() * 0.4; G(x + Math.sin(ph) * 0.12 * t * spread, y + t * (top - y), z + Math.cos(ph * 1.3) * 0.12 * t * spread, sh(C.D.sky.fogAway, 0.12), 0.08 + t * 0.35, 0.3, 2); } };   // 烟带着雾色,灰的加法烟像镜头上的灰
  const brazier = (bx, bz) => {
    const y = 0.92;
    for (let j = 0; j < 3; j++) { const la = j / 3 * TAU; S.tube([bx + Math.cos(la) * 0.34, 0, bz + Math.sin(la) * 0.34], [bx + Math.cos(la) * 0.14, y - 0.12, bz + Math.sin(la) * 0.14], 0.025, sp(MAT.metal, [0.42, 0.33, 0.2])); }
    S.sphere([bx, y + 0.1, bz], 0.46, sp(MAT.metal, [0.5, 0.38, 0.22]), 0, TAU, -Math.PI / 2, -0.15, 0.42);
    S.disc([bx, y + 0.03, bz], 0.36, 0.45, GOLD);
    flame(bx, y + 0.05, bz, 0.7, 160);
    A.block(bx, bz, 0.55);
    A.lit(bx, y + 0.5, bz, isHall ? 7.5 : Math.max(W, D) * 0.9, lamp, 1.6, { flame: true });
  };
  // 每种风格一套夜里的灯
  if (st === 'norse' && isHall) {
    // 长火塘:大厅正中一条石边的火,是整间屋子唯一的主光
    const L = Math.min(4.5, W * 0.3), hw = 0.45;
    S.aabb(cx - L / 2, 0, cz - hw - 0.14, cx + L / 2, 0.22, cz - hw, sp(MAT.stone, C.stone));
    S.aabb(cx - L / 2, 0, cz + hw, cx + L / 2, 0.22, cz + hw + 0.14, sp(MAT.stone, C.stone));
    S.aabb(cx - L / 2 - 0.14, 0, cz - hw - 0.14, cx - L / 2, 0.22, cz + hw + 0.14, sp(MAT.stone, C.stone));
    S.aabb(cx + L / 2, 0, cz - hw - 0.14, cx + L / 2 + 0.14, 0.22, cz + hw + 0.14, sp(MAT.stone, C.stone));
    S.quad([cx - L / 2, 0.06, cz - hw], [L, 0, 0], [0, 0, hw * 2], sp(MAT.earth, [0.16, 0.09, 0.06]), [0, 1, 0]);
    for (let k = 0; k < 5; k++) flame(cx - L / 2 + (k + 0.5) * L / 5, 0.08, cz + (rnd() - 0.5) * 0.3, 0.8, 120);
    for (let i = 0; i < 300; i++) { const t = rnd(); G(cx + (rnd() - 0.5) * L, 0.9 + t * (h + 1.5), cz + (rnd() - 0.5) * 0.8 * (1 + t), [1, 0.45, 0.12], 0.015, 1, 1); }
    for (const f of [-0.35, 0, 0.35]) A.lit(cx + f * L, 0.9, cz, 9, lamp, 1.7, { flame: true });
    A.block(cx, cz, L / 2 + 0.4, hw + 0.4);
    return;
  }
  if (st === 'modern' && isHall) {
    // 藏起来的暖光带:沿墙顶一圈,光往下洗墙 —— 看不见灯珠,只看见被照亮的墙
    for (const [x0, z0, x1, z1] of [[r.x0 + 0.3, r.z0 + 0.3, r.x1 - 0.3, r.z0 + 0.3], [r.x0 + 0.3, r.z1 - 0.3, r.x1 - 0.3, r.z1 - 0.3], [r.x0 + 0.3, r.z0 + 0.3, r.x0 + 0.3, r.z1 - 0.3], [r.x1 - 0.3, r.z0 + 0.3, r.x1 - 0.3, r.z1 - 0.3]]) {
      const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 6));
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; A.lit(x0 + (x1 - x0) * t, h - 0.4, z0 + (z1 - z0) * t, 5.5, lamp, 1.1); }
      for (let i = 0; i < L * 30; i++) { const t = rnd(); G(x0 + (x1 - x0) * t, h - 0.08, z0 + (z1 - z0) * t, [1, 0.84, 0.62], 0.05, 0.1, 1); }
    }
    return;
  }
  /* 灯具守风格:江户点行灯,唐宋挂宫灯,波斯挂镂空铜灯,古埃及、玛雅烧火盆 —— 不会在
     榻榻米上方吊一圈西式烛台。代码挑的那一档只决定数量和大小。 */
  const SIG = { edo: 'lantern', tang: 'lantern', persia: 'lantern', giza: 'brazier', maya: 'brazier', hellas: ip.light === 'oculus' ? 'oculus' : 'brazier' };
  const kind = SIG[st] || ip.light;
  switch (kind) {
    case 'chandelier': {
      const y0 = h - (isHall ? 1.9 : 1.1);
      S.tube([cx, h, cz], [cx, y0 + 0.9, cz], 0.02, GOLD);
      const tiers = isHall ? 3 : 2;
      for (let t = 0; t < tiers; t++) {
        const rad = (0.45 + t * 0.42) * (isHall ? 1 : 0.7), y = y0 + 0.7 - t * 0.35;
        ring(cx, y, cz, rad, GOLD);
        const bulbs = 8 + t * 6;
        for (let i = 0; i < bulbs; i++) { const a = i / bulbs * TAU, bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad; S.cyl([bx, 0, bz], 0.03, 0.07, sp(MAT.glass, [0.85, 0.9, 0.92]), 0, TAU, y); glowBall(bx, y + 0.1, bz, 0.03, [1, 0.86, 0.6], 3, 0.06); }
      }
      A.lit(cx, y0, cz, Math.max(W, D) * (isHall ? 0.85 : 1.0), lamp, isHall ? 1.9 : 1.4);
      break;
    }
    case 'lantern': {
      const n = isHall ? 4 : 1, rad = isHall ? Math.min(3.2, R * 0.5) : 0;
      for (let k = 0; k < n; k++) {
        const a = (k / Math.max(1, n)) * TAU + 0.4, lx = cx + Math.cos(a) * rad, lz = cz + Math.sin(a) * rad, ly = h - 1.35;
        S.tube([lx, h, lz], [lx, ly + 0.4, lz], 0.01, sp(MAT.metal, sh(C.gold, 0.6)));
        if (st === 'persia') {
          // 镂空铜灯:灯罩是金属球,光从孔里漏出去,墙上一片星点
          S.sphere([lx, ly, lz], 0.28, GOLD, 0, TAU, -1.4, 1.4, 1.15);
          glowBall(lx, ly, lz, 0.12, [1, 0.78, 0.45], 14, 0.1);
          for (let i = 0; i < 700; i++) {
            const dx = rnd() * 2 - 1, dy = rnd() * 2 - 1.2, dz = rnd() * 2 - 1, dl = Math.hypot(dx, dy, dz) || 1;
            const ux = dx / dl, uy = dy / dl, uz = dz / dl;
            const tx = ux > 0 ? (r.x1 - 0.05 - lx) / ux : (r.x0 + 0.05 - lx) / ux, tz = uz > 0 ? (r.z1 - 0.05 - lz) / uz : (r.z0 + 0.05 - lz) / uz;
            const ty = uy > 0 ? (h - 0.05 - ly) / uy : (0.02 - ly) / uy, t = Math.min(tx, tz, ty);
            // 星点:近处小而亮,远处大而淡 —— 像铜灯孔里漏出去的光斑,不是一粒粒沙
            if (t > 0 && t < 9) G(lx + ux * t, ly + uy * t, lz + uz * t, [1, 0.72, 0.4], 0.05 + t * 0.012, 0.75 - t * 0.05, 1);
          }
        } else if (st === 'edo') {
          // 行灯:纸糊的方灯,放在地上
          const fx = cx + (k % 2 ? 1 : -1) * (W / 2 - 2.6), fz = cz + (k < 2 ? -1 : 1) * (D / 2 - 2.6);
          for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) S.aabb(fx + sx * 0.14 - 0.02, 0, fz + sz * 0.14 - 0.02, fx + sx * 0.14 + 0.02, 0.62, fz + sz * 0.14 + 0.02, sp(MAT.wood, C.struct));
          S.aabb(fx - 0.15, 0.12, fz - 0.15, fx + 0.15, 0.6, fz + 0.15, sp(MAT.paper, [0.96, 0.9, 0.78], null, F.glow), { bottom: true });
          glowBall(fx, 0.35, fz, 0.1, [1, 0.72, 0.4], 12, 0.1);
          A.lit(fx, 0.45, fz, isHall ? 5.2 : Math.max(W, D), lamp, 1.2, { flame: true });
          A.block(fx, fz, 0.35);
          continue;
        } else {
          // 宫灯:红绸,上下金边,垂穗
          const red = st === 'tang' ? [0.78, 0.2, 0.12] : [0.96, 0.9, 0.78];
          S.cyl([lx, 0, lz], 0.26, 0.62, sp(MAT.paper, red, null, F.glow), 0, TAU, ly - 0.31);
          S.disc([lx, ly + 0.31, lz], 0, 0.29, GOLD); S.disc([lx, ly - 0.31, lz], 0, 0.29, GOLD, true);
          for (let i = 0; i < 6; i++) { const a2 = i / 6 * TAU; S.tube([lx + Math.cos(a2) * 0.2, ly - 0.31, lz + Math.sin(a2) * 0.2], [lx + Math.cos(a2) * 0.2, ly - 0.62, lz + Math.sin(a2) * 0.2], 0.008, sp(MAT.lacquer, C.accent2)); }
          glowBall(lx, ly, lz, 0.16, [1, 0.6, 0.38], 16, 0.12);
        }
        A.lit(lx, ly, lz, isHall ? 7.5 : Math.max(W, D) * 0.95, lamp, isHall ? 1.2 : 1.3);
      }
      break;
    }
    case 'brazier': {
      const n = isHall ? 4 : 1, Rb = isHall ? Math.min(W, D) * 0.32 : 0;
      for (let k = 0; k < n; k++) { const a = (k / n) * TAU + 0.7; brazier(cx + Math.cos(a) * Rb, cz + Math.sin(a) * Rb); }
      if (st === 'maya') smoke(cx, 1.4, cz, h, 500, 6);                              // 柯巴脂的烟,聚在拱顶下
      break;
    }
    case 'candle': {
      const y = h - 1.2, rad = isHall ? 1.4 : 0.8;
      S.tube([cx, h, cz], [cx, y, cz], 0.015, GOLD);
      ring(cx, y, cz, rad, GOLD, 24);
      const n = isHall ? 14 : 8;
      for (let i = 0; i < n; i++) { const a = i / n * TAU, x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad; S.cyl([x, 0, z], 0.022, 0.16, sp(MAT.paper, [0.96, 0.93, 0.85]), 0, TAU, y); glowBall(x, y + 0.21, z, 0.02, [1, 0.8, 0.45], 4, 0.06); }
      A.lit(cx, y, cz, Math.max(W, D) * 0.8, lamp, 1.3, { flame: true });
      break;
    }
    case 'strip': {
      const L = W * 0.6;
      S.aabb(cx - L / 2, h - 0.12, cz - 0.06, cx + L / 2, h - 0.06, cz + 0.06, sp(MAT.paper, [0.95, 0.92, 0.86], null, F.glow), { bottom: true });
      A.lit(cx, h - 0.5, cz, Math.max(W, D) * 0.85, lamp, 1.4);
      break;
    }
    case 'oculus': A.lit(cx, h * 0.6, cz, Math.max(W, D) * 0.7, [0.55, 0.62, 0.8], 0.7); break;
    default: A.lit(cx, h - 0.8, cz, Math.max(W, D) * 0.8, lamp, 1.2);
  }
}

/* ══ 各风格的点睛之笔(只在大厅) ═════════════════════════════════════════════ */
function heroes(S, G, A, C, fl) {
  const { r, ip } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, h = r.h, st = ip.style.id, rnd = A.rnd, seed = A.seed;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, dz = r.z0 + 2.05;      // 主案大致在北墙正中往前 2m
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: fl | (extra || 0), seed });
  switch (st) {
    case 'tang': {
      // 八角藻井:三圈一层层往里收,悬在主案上方,中心一颗宝珠灯
      for (let k = 0; k < 3; k++) {
        const Rr = 1.9 - k * 0.42, y = h - 0.22 - k * 0.2;
        for (let i = 0; i < 8; i++) {
          const a0 = (i + 0.5) / 8 * TAU, a1 = (i + 1.5) / 8 * TAU;
          S.tube([cx + Math.cos(a0) * Rr, y, dz + Math.sin(a0) * Rr], [cx + Math.cos(a1) * Rr, y, dz + Math.sin(a1) * Rr], 0.09, sp(MAT.caihua, k % 2 ? C.accent2 : C.accent, C.gold));
        }
      }
      S.disc([cx, h - 0.66, dz], 0, 1.05, sp(MAT.gridcoffer, C.gold, C.accent2), true);
      S.tube([cx, h - 0.66, dz], [cx, h - 1.5, dz], 0.012, sp(MAT.metal, C.gold));
      S.sphere([cx, h - 1.62, dz], 0.14, sp(MAT.paper, [1, 0.95, 0.82], null, F.glow));
      for (let i = 0; i < 20; i++) G(cx + (rnd() - 0.5) * 0.14, h - 1.62 + (rnd() - 0.5) * 0.14, dz + (rnd() - 0.5) * 0.14, [1, 0.9, 0.7], 0.1, 0.5, 1);
      A.lit(cx, h - 1.7, dz, 6, [1, 0.85, 0.62], 1.2);
      // 帷幔:主案两侧垂下的红绸,金边
      for (const sx of [-1, 1]) {
        const x = cx + sx * 1.9;
        S.quad([x - 0.4, 0.4, dz - 0.9], [0.8, 0, 0], [0, h - 1.2, 0], sp(MAT.canvas, [0.56, 0.14, 0.1], [0.7, 0.2, 0.12]), [0, 0, 1]);
        S.aabb(x - 0.42, 0.38, dz - 0.91, x + 0.42, 0.46, dz - 0.87, sp(MAT.metal, C.gold));
      }
      // 香炉和三缕香烟
      S.cyl([cx, 0, dz + 1.9], 0.18, 0.28, sp(MAT.metal, [0.46, 0.36, 0.22]));
      for (let k = 0; k < 3; k++) for (let i = 0; i < 90; i++) { const t = i / 90, ph = t * 7 + k * 2; G(cx + (k - 1) * 0.05 + Math.sin(ph) * 0.1 * t, 0.3 + t * 2.4, dz + 1.9 + Math.cos(ph * 1.3) * 0.08 * t, [0.3, 0.29, 0.28], 0.02 + t * 0.03, 0.4, 2); }
      A.block(cx, dz + 1.9, 0.35);
      // 两侧垂下的幡:联珠纹织锦的长条,红、青、绿、金轮换,底下三根流苏
      const BAN = [[0.62, 0.14, 0.1], [0.12, 0.3, 0.55], [0.15, 0.45, 0.32], [0.78, 0.58, 0.2]];
      let bi = 0;
      for (const sx of [-1, 1]) for (let z = r.z0 + 3.5; z < r.z1 - 2.5; z += 3.2) {
        const x = sx < 0 ? r.x0 + 0.35 : r.x1 - 0.35, y1 = h - 1.0, y0 = Math.max(2.4, y1 - 3.0);
        S.quad([x, y0, z - 0.3], [0, 0, 0.6], [0, y1 - y0, 0], sp(MAT.lianzhu, BAN[bi % 4], C.gold), [-sx, 0, 0]);
        S.aabb(x - 0.03, y1, z - 0.36, x + 0.03, y1 + 0.06, z + 0.36, sp(MAT.metal, C.gold));
        for (let k = 0; k < 3; k++) S.tube([x, y0, z - 0.2 + k * 0.2], [x, y0 - 0.45, z - 0.2 + k * 0.2], 0.012, sp(MAT.lacquer, BAN[(bi + k + 1) % 4]));
        bi++;
      }
      break;
    }
    case 'edo': {
      // 床之间:北墙右侧一块高出一截的龛,挂一幅轴,一枝山茶
      const tx = cx + W * 0.25, tz = r.z0 + 0.5;
      S.aabb(tx - 0.95, 0, tz - 0.45, tx + 0.95, 0.12, tz + 0.45, sp(MAT.wood, sh(C.struct, 1.3)));
      S.quad([tx - 0.3, 0.75, r.z0 + 0.06], [0.6, 0, 0], [0, 1.2, 0], sp(MAT.canvas, [0.86, 0.8, 0.66], [0.2, 0.18, 0.16]), [0, 0, 1]);
      S.tube([tx - 0.34, 1.96, r.z0 + 0.08], [tx + 0.34, 1.96, r.z0 + 0.08], 0.015, sp(MAT.wood, C.struct));
      S.cyl([tx + 0.45, 0, tz], 0.07, 0.2, sp(MAT.lacquer, C.accent), 0, TAU, 0.12);
      S.tube([tx + 0.45, 0.3, tz], [tx + 0.36, 0.62, tz + 0.02], 0.008, sp(MAT.bark, [0.3, 0.22, 0.14]));
      S.sphere([tx + 0.36, 0.64, tz + 0.02], 0.035, sp(MAT.lacquer, [0.72, 0.1, 0.12]));
      A.lit(tx, 1.6, tz + 0.6, 2.4, [1, 0.8, 0.6], 0.7);
      // 违棚:旁边高低错开的两层架
      S.aabb(tx + 1.1, 0.9, tz - 0.3, tx + 1.8, 0.94, tz + 0.1, sp(MAT.wood, C.struct));
      S.aabb(tx + 1.3, 1.2, tz - 0.3, tx + 2.0, 1.24, tz + 0.1, sp(MAT.wood, C.struct));
      A.block(tx, tz, 1.1, 0.6);
      // 六扇屏风(金底老松,和襖同一种画),折成之字立在床之间对面那一侧
      const bx = cx - W * 0.22, bz = r.z0 + 0.9;
      for (let k = 0; k < 6; k++) S.quad([bx - 1.65 + k * 0.55, 0.02, bz + (k % 2) * 0.18], [0.55, 0, k % 2 ? -0.18 : 0.18], [0, 1.55, 0], sp(MAT.fusuma, C.gold), [0, 0, 1]);
      A.block(bx, bz + 0.1, 1.7, 0.35);
      break;
    }
    case 'maya':
      // 灰塑长鼻面具:四角各叠三张
      for (const [mx, mz] of [[r.x0 + 0.6, r.z0 + 0.6], [r.x1 - 0.6, r.z0 + 0.6]]) {
        for (let k = 0; k < 3; k++) {
          const y = 0.4 + k * 0.85;
          S.aabb(mx - 0.4, y, mz - 0.25, mx + 0.4, y + 0.75, mz + 0.25, sp(MAT.plaster, k % 2 ? C.field : C.ceil));
          for (const sx of [-1, 1]) S.disc([mx + sx * 0.18, y + 0.5, mz + 0.26], 0, 0.08, sp(MAT.lacquer, C.accent));
          S.tube([mx, y + 0.35, mz + 0.26], [mx, y + 0.1, mz + 0.5], 0.06, sp(MAT.lacquer, C.gold));
        }
      }
      break;
    case 'persia': {
      // 地毯 + 主案背后的伊万:尖拱,拱里一层层蜂窝檐
      S.quad([cx - 4, 0.008, cz - 5], [8, 0, 0], [0, 0, 10], { mat: MAT.carpet, c1: C.red || [0.6, 0.2, 0.15], c2: C.ink, flags: fl, seed, uv0: [-4, -5] }, [0, 1, 0]);
      const iw = 4.2, ih = Math.min(h - 0.6, 5.2), z = r.z0 + 0.1;
      for (let t = 0; t < 5; t++) {
        const y = ih - 0.9 - t * 0.28, wdt = iw * (0.35 + t * 0.14), n = Math.max(3, Math.round(wdt / 0.32));
        for (let i = 0; i < n; i++) {
          const u = cx - wdt / 2 + (i + 0.5) * wdt / n;
          S.aabb(u - 0.13, y, z, u + 0.13, y + 0.26, z + 0.18 + (4 - t) * 0.1, sp(t % 2 ? MAT.mosaic : MAT.lacquer, t % 2 ? C.accent2 : C.stone, C.accent));
          if (t % 2 === 0) S.aabb(u - 0.04, y - 0.02, z, u + 0.04, y + 0.02, z + 0.2 + (4 - t) * 0.1, sp(MAT.metal, C.gold));
        }
      }
      for (const sx of [-1, 1]) S.aabb(cx + sx * iw / 2 - 0.15, 0, z, cx + sx * iw / 2 + 0.15, ih - 0.6, z + 0.35, sp(MAT.mosaic, C.accent, C.accent2));
      // 伊万两边两盆橘树:绿松石釉的盆,深绿的叶里挂着橙色的果
      for (const sx of [-1, 1]) {
        const tx = cx + sx * (iw / 2 + 1.2), tz = r.z0 + 1.4;
        S.cyl([tx, 0, tz], 0.36, 0.55, sp(MAT.mosaic, C.accent2, C.stone));
        tree(S, rnd, tx, tz, 1.3, [0.3, 0.2, 0.12], [[0.1, 0.34, 0.14], [0.16, 0.44, 0.2], [0.98, 0.55, 0.08], [0.08, 0.28, 0.12]], 0.85, 1600, seed);
        A.block(tx, tz, 0.55);
      }
      break;
    }
    case 'norse':
      // 墙上一排圆盾
      for (const sz of [-1, 1]) for (let x = r.x0 + 1.6; x < r.x1 - 1.2; x += 2.4) {
        const z = sz < 0 ? r.z0 + 0.1 : r.z1 - 0.1, cols = [C.accent, C.accent2, C.wool || [0.78, 0.72, 0.6]];
        S.sphere([x, 2.2, z], 0.42, sp(MAT.lacquer, cols[Math.abs(Math.round(x)) % 3]), 0, TAU, 0, 0.35, 1);
        S.sphere([x, 2.2, z + sz * -0.02], 0.08, sp(MAT.metal, C.gold));
      }
      break;
    default:
      // 现代:角上两盆橄榄树,深色石盆
      if (st === 'modern') for (const [px2, pz2] of [[r.x0 + 1.3, r.z0 + 1.3], [r.x1 - 1.3, r.z0 + 1.3]]) {
        S.cyl([px2, 0, pz2], 0.38, 0.5, sp(MAT.stone, [0.25, 0.25, 0.27]));
        tree(S, rnd, px2, pz2, 1.6, [0.3, 0.25, 0.2], [[0.3, 0.42, 0.25], [0.38, 0.5, 0.3], [0.24, 0.36, 0.22]], 0.8, 1800, seed);
        A.block(px2, pz2, 0.55);
      }
      break;
  }
}

/* ══ 院子:四合院 ═══════════════════════════════════════════════════════════ */
function siheyuan(S, G, A, C) {
  const { r, rnd, doors } = A, W = r.x1 - r.x0, D = r.z1 - r.z0, seed = A.seed;
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  const sp = (mat, c1, c2, extra) => ({ mat, c1, c2: c2 || c1, flags: extra || 0, seed });
  S.quad([r.x0, 0, r.z0], [W, 0, 0], [0, 0, D], sp(MAT.tile40, [0.45, 0.46, 0.47]), [0, 1, 0]);
  S.aabb(cx - 0.8, 0, r.z0, cx + 0.8, 0.02, r.z1, sp(MAT.tile40, [0.62, 0.61, 0.58]), { front: false, back: false });
  S.aabb(r.x0, 0, cz - 0.8, r.x1, 0.02, cz + 0.8, sp(MAT.tile40, [0.62, 0.61, 0.58]), { left: false, right: false });
  // 游廊
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
      if ((k++ & 1) === 0) {
        const lx = x + n[0] * 0.35, lz = z + n[2] * 0.35, ly = colH - 0.55;
        S.tube([lx, colH, lz], [lx, ly + 0.28, lz], 0.008, sp(MAT.metal, [0.3, 0.25, 0.2]));
        S.sphere([lx, ly, lz], 0.22, sp(MAT.paper, [0.95, 0.28, 0.18], null, F.glow), 0, TAU, -1.3, 1.3, 1.2);
        for (let i = 0; i < 10; i++) G(lx + (rnd() - 0.5) * 0.2, ly + (rnd() - 0.5) * 0.3, lz + (rnd() - 0.5) * 0.2, [1, 0.45, 0.28], 0.12, 0.8, 1);
        if ((k & 3) === 1) A.lit(lx, ly, lz, 6.5, [1, 0.5, 0.32], 1.2, { flame: true });
      }
    }
    const horiz = Math.abs(n[2]) > 0.5, L = horiz ? [len, 0, 0] : [0, 0, len];
    S.box([(a[0] + b[0]) / 2, colH, (a[1] + b[1]) / 2], horiz ? [1, 0, 0] : [0, 0, 1], n, len + 0.3, 0.3, 0.2, sp(MAT.caihua, [0.12, 0.3, 0.48], [0.18, 0.48, 0.4]), { bottom: true });
    const back = [a[0] - n[0] * inset, colH + 0.9, a[1] - n[2] * inset];
    S.quad(back, L, [n[0] * (inset + 0.6), -0.75, n[2] * (inset + 0.6)], sp(MAT.rooftile, [0.3, 0.31, 0.34]), [0, 1, 0]);
    S.quad(back, L, [n[0] * (inset + 0.6), -0.75, n[2] * (inset + 0.6)], sp(MAT.wood, [0.55, 0.2, 0.14]), [0, -1, 0]);
  }
  // 影壁:进门先见的那面墙,青砖、中间一方斜铺的砖心、瓦顶
  const sz = r.z1 - 0.8;
  S.aabb(cx - 1.7, 0, sz - 0.18, cx + 1.7, 2.6, sz + 0.18, sp(MAT.brick, [0.42, 0.44, 0.46], [0.8, 0.78, 0.74]));
  S.quad([cx - 0.9, 0.7, sz - 0.19], [1.8, 0, 0], [0, 1.3, 0], sp(MAT.tile40, [0.52, 0.53, 0.54]), [0, 0, -1]);
  S.aabb(cx - 1.9, 2.6, sz - 0.3, cx + 1.9, 2.75, sz + 0.3, sp(MAT.rooftile, [0.3, 0.31, 0.34]));
  A.block(cx, sz, 1.8, 0.35);
  for (const sx of [-1, 1]) {
    const tx = cx + sx * W / 4, tz = cz - D / 5;
    tree(S, rnd, tx, tz, 2.3, [0.3, 0.2, 0.14], [[1, 0.78, 0.84], [1, 0.9, 0.93], [0.93, 0.56, 0.68], [0.36, 0.55, 0.3]], 1.9, 5200, seed);
    A.block(tx, tz, 0.55);
  }
  // 两口鱼缸,缸里浮着荷叶和一朵荷花
  for (const sx of [-1, 1]) {
    const bx = cx + sx * W / 4, bz = cz + D / 4, R = 0.5;
    S.sphere([bx, 0.36, bz], R, sp(MAT.mosaic, [0.92, 0.93, 0.95], [0.18, 0.3, 0.66]), 0, TAU, -1.0, 0.55, 0.9);
    S.disc([bx, 0.62, bz], 0, R * 0.86, sp(MAT.water, [0.05, 0.16, 0.18]));
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU + sx; S.disc([bx + Math.cos(a) * 0.22, 0.63, bz + Math.sin(a) * 0.22], 0, 0.13, sp(MAT.leaf, [0.22, 0.42, 0.22], [0.3, 0.5, 0.26])); }
    S.sphere([bx - 0.05, 0.72, bz + 0.05], 0.06, sp(MAT.lacquer, [0.9, 0.55, 0.65]));
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
  S.aabb(r.x0, 0, r.z0, r.x1, 0.08, r.z0 + band, sp(MAT.wood, wood), { back: false });
  S.aabb(r.x0, 0, r.z1 - band, r.x1, 0.08, r.z1, sp(MAT.wood, wood), { front: false });
  S.aabb(r.x0, 0, r.z0 + band, r.x0 + band, 0.08, r.z1 - band, sp(MAT.wood, wood), { left: false });
  S.aabb(r.x1 - band, 0, r.z0 + band, r.x1, 0.08, r.z1 - band, sp(MAT.wood, wood), { right: false });
  const inner = { x0: r.x0 + band, x1: r.x1 - band, z0: r.z0 + band, z1: r.z1 - band };
  const iw = inner.x1 - inner.x0, id = inner.z1 - inner.z0;
  S.quad([inner.x0, 0.005, inner.z0], [iw, 0, 0], [0, 0, id], sp(MAT.gravel, [0.66, 0.65, 0.6]), [0, 1, 0]);
  // 石头三块一组,不对称;砂纹绕着它们一圈圈(uRocks)
  const rocks = [[inner.x0 + iw * 0.22, inner.z0 + id * 0.3, 0.95], [inner.x0 + iw * 0.3, inner.z0 + id * 0.64, 0.6], [inner.x0 + iw * 0.12, inner.z0 + id * 0.55, 0.45]];
  for (const [x, z, s] of rocks) {
    S.sphere([x, 0, z], s, sp(MAT.stone, [0.4, 0.4, 0.42]), 0, TAU, -0.1, Math.PI / 2, 0.7);
    S.sphere([x, 0.02, z], s * 1.02, sp(MAT.moss, [0.32, 0.4, 0.2]), 0, TAU, 0.9, Math.PI / 2, 0.7);
    S.disc([x, 0.012, z], s, s + 0.3, sp(MAT.moss, [0.34, 0.42, 0.22]));
    A.block(x, z, s + 0.15, s * 0.9 + 0.15);
    (A.rocks || []).push({ x, z, r: s + 0.3 });
  }
  const pond = { x: inner.x0 + iw * 0.74, z: inner.z0 + id * 0.42, R: Math.min(iw * 0.17, id * 0.2) };
  S.disc([pond.x, 0.02, pond.z], 0, pond.R, sp(MAT.water, [0.05, 0.15, 0.18]));
  for (let i = 0; i < 26; i++) { const a = i / 26 * TAU; S.sphere([pond.x + Math.cos(a) * pond.R, 0.02, pond.z + Math.sin(a) * pond.R], 0.16 + rnd() * 0.08, sp(MAT.stone, [0.5, 0.5, 0.5]), 0, TAU, 0, Math.PI / 2, 0.7); }
  for (let f = 0; f < 6; f++) { const a = rnd() * TAU, q = rnd() * pond.R * 0.7, hd = rnd() * TAU; for (let i = 0; i < 18; i++) { const t = (rnd() - 0.5) * 0.34; S.dot([pond.x + Math.cos(a) * q + Math.cos(hd) * t, 0.03, pond.z + Math.sin(a) * q + Math.sin(hd) * t], [0, 1, 0], rnd() < 0.5 ? [1, 0.45, 0.12] : [0.95, 0.95, 0.92], 0.05); } }
  A.block(pond.x, pond.z, pond.R + 0.2);
  // 池上低低的一层雾(夜里)
  for (let i = 0; i < 500; i++) { const a = rnd() * TAU, q = Math.sqrt(rnd()) * pond.R * 1.3; G(pond.x + Math.cos(a) * q, 0.12 + rnd() * 0.35, pond.z + Math.sin(a) * q, [0.07, 0.08, 0.1], 0.5, 0.1, 1); }
  const L = pond.R * 2.5, bw = 0.9, RED = sp(MAT.lacquer, [0.62, 0.18, 0.12]);
  const arc = (t) => 0.55 * Math.cos(t * Math.PI) + 0.06;
  for (let i = 0; i < 14; i++) {
    const t0 = i / 14 - 0.5, t1 = (i + 1) / 14 - 0.5;
    S.aabb(pond.x - bw / 2, arc(t0) - 0.04, pond.z + t0 * L, pond.x + bw / 2, arc(t0) + 0.02, pond.z + t1 * L, RED);
    for (const sx of [-1, 1]) S.tube([pond.x + sx * bw / 2, arc(t0) + 0.4, pond.z + t0 * L], [pond.x + sx * bw / 2, arc(t1) + 0.4, pond.z + t1 * L], 0.03, RED);
    if (i % 3 === 0) for (const sx of [-1, 1]) S.tube([pond.x + sx * bw / 2, arc(t0), pond.z + t0 * L], [pond.x + sx * bw / 2, arc(t0) + 0.42, pond.z + t0 * L], 0.03, RED);
  }
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
    // 近水的那盏,水里有它的倒影
    if (Math.hypot(x - pond.x, z - pond.z) < pond.R + 1.5) for (let i = 0; i < 60; i++) { const t = rnd(); G(x + (pond.x - x) * 0.4 * t + (rnd() - 0.5) * 0.12, 0.03, z + (pond.z - z) * 0.4 * t + (rnd() - 0.5) * 0.3, [1, 0.62, 0.3], 0.05, 1, 1); }
    A.lit(x, 1.1, z, 5.5, [1, 0.72, 0.42], 1.3, { flame: true });
    A.block(x, z, 0.4);
  }
  // 蹲踞:石钵、一根竹筒
  const tx = lanterns[1][0] + 1.2, tz = lanterns[1][1] + 0.4;
  S.cyl([tx, 0, tz], 0.3, 0.32, STONE); S.disc([tx, 0.3, tz], 0, 0.24, sp(MAT.water, [0.05, 0.15, 0.18]));
  S.tube([tx + 0.7, 0.55, tz], [tx + 0.12, 0.42, tz], 0.03, sp(MAT.wood, [0.52, 0.5, 0.3]));
  A.block(tx, tz, 0.35);
  // 飞石:从南边缘侧弯弯地走到桥头
  for (let i = 0; i < 9; i++) { const t = i / 8; S.disc([inner.x0 + iw * (0.45 + 0.2 * t) + Math.sin(t * 5) * 0.5, 0.012, inner.z1 - 0.3 - t * id * 0.55], 0, 0.24 + ((i * 7) % 3) * 0.03, sp(MAT.stone, [0.55, 0.55, 0.53])); }
  // 萤火虫
  for (let i = 0; i < 70; i++) G(inner.x0 + rnd() * iw, 0.3 + rnd() * 1.4, inner.z0 + rnd() * id, [0.78, 0.88, 0.44], 0.05, 1, 1);
  const mx = inner.x0 + iw * 0.08, mz = inner.z0 + id * 0.12;
  tree(S, rnd, mx, mz, 2.0, [0.28, 0.18, 0.12], [[0.66, 0.2, 0.16], [0.8, 0.3, 0.12], [0.58, 0.12, 0.08], [0.85, 0.5, 0.16]], 1.7, 4200, seed);
  A.block(mx, mz, 0.45);
  const px = inner.x1 - iw * 0.06, pz = inner.z0 + id * 0.1;
  S.tube([px, 0, pz], [px + 0.2, 2.8, pz - 0.1], 0.15, sp(MAT.bark, [0.3, 0.22, 0.16]));
  for (let t = 0; t < 4; t++) S.disc([px + 0.1 + (rnd() - 0.5) * 0.4, 1.5 + t * 0.55, pz + (rnd() - 0.5) * 0.4], 0, 1.5 - t * 0.28, sp(MAT.leaf, [0.12, 0.26, 0.16], [0.2, 0.34, 0.22]));
  A.block(px, pz, 0.45);
}

/** 院子四周那几间房从院子里看得见的屋顶:两坡顶,脊沿长边,檐伸出去。 */
function roof(S, A, C) {
  const { r } = A, seed = A.seed;
  const along = (r.x1 - r.x0) >= (r.z1 - r.z0);
  const over = r.kind === 'pavilion' ? 0.7 : 1.0, steep = r.kind === 'pavilion' ? 0.62 : 0.45;
  const L = (along ? r.x1 - r.x0 : r.z1 - r.z0) + over * 2, Sp = (along ? r.z1 - r.z0 : r.x1 - r.x0) / 2 + over;
  const h = r.h, rise = Sp * steep;
  const col = r.kind === 'pavilion' ? [0.22, 0.23, 0.26] : [0.3, 0.31, 0.34];
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
    // 云:很淡的一团(泛光加强以后,亮的云会糊成几大块白光)
    for (let i = 0; i < 500; i++) { const u = rnd() * 2 - 1, a = rnd() * TAU, q = Math.sqrt(1 - u * u) * Math.pow(rnd(), 0.4); G(cx + Math.cos(a) * q * 11, cy + u * 2.4, cz + Math.sin(a) * q * 6, [0.22, 0.23, 0.27], 3.0, 0.1, 3); }
  }
}

/**
 * 盖一间屋子的建筑。
 * A: { r, ip, doors, rooms, isHall, lit(x,y,z,r,col,k,opts), block(x,z,rx,rz), rnd, seed, roof, frames,
 *      windows:[](收集窗口,场景拿去做光柱), rocks:[](庭院的石头,砂纹绕着走) }
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
    if (A.isHall) { hallColumns(S, A, C, fl); heroes(S, G, A, C, fl); }
  }
  if (A.roof) roof(S, A, C);
  return C;
}
