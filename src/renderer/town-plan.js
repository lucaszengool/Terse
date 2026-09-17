/**
 * town-plan.js — 广场就是一座小镇:每个项目是镇上的一栋房子。这里只算**图纸**,不画东西。
 *
 * 纯函数,同样的项目列表永远是同一座镇 —— 镇子必须认得出来:今天走过的那条街,
 * 明天还在那儿。所以没有 Math.random,种子从项目 id 来。
 *
 * 怎么长出来的(参考 Watabou 的中世纪城镇生成器和 Parish & Müller 那套"全局目标 +
 * 局部约束",但砍到 10–200 栋房子这个量级能跑得动的程度):
 *
 *   1 分区   同一个城市的项目挨着住(没有城市就按主语言)。每个区占一块扇形。
 *   2 选址   大项目靠近镇中心,小项目往外;同区的人挨着。再做几轮 Lloyd 松弛,
 *            让点之间的距离均匀 —— 不松弛的话总有两栋房子贴在一起、另一边空一片。
 *   3 地块   每个点的地块 = 它的 Voronoi 单元:拿镇子的外圈多边形,挨个用"我和邻居
 *            的中垂线"切一刀。切的时候谁真的切下了一条边,谁就是邻居 —— 街道的图
 *            就是这么来的,不用再写一遍 Delaunay。
 *   4 街道   邻接图上取最小生成树(保证处处走得到,不会走进死胡同迷宫),再补 15%
 *            的短边成环(不用原路返回)。每条边走过多少人(betweenness)决定它是
 *            大道、街还是小巷。
 *   5 广场   最热闹的几个路口:把那里的地块让出来当广场。空地块就是公园。
 *   6 门     房子的门开在朝着最近那条街的那面墙上 —— 门永远对着路。
 */

/* ── 小工具:定死的随机数(种子来自项目 id) ────────────────────────────── */
export function hash01(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function rng(seed) {
  let s = (hash01(seed) * 4294967296) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const TAU = Math.PI * 2;

/* ── 自己挑的地 ─────────────────────────────────────────────────────────────
   发布项目时可以挑一块地(0 .. PLOT_SLOTS-1),别墅就盖在那儿。
   挑的地必须**不随镇上有几栋房子而变** —— 别人每发布一个项目,你的别墅就搬一次家,
   那就不叫"挑"了。所以地块不按这座镇的半径算,直接按米:向日葵螺旋(Vogel),
   第 k 块在 r = 40 + 18·√(k+½) 米、方位 k·137.5°。
   相邻两块隔 ≈ 18·√π ≈ 32 米,和房子间距(20–36 米)同一个量级;地块由 Voronoi 切,
   挨着也不会重叠,只是院子小一点。编号越小越靠镇中心。
   ⚠ api/projects.js 的 PLOT_SLOTS 必须和这里相同(api/projects.test.js 对账)。 */
export const PLOT_SLOTS = 120;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** 第 k 块地的中心(米)。 */
export function plotSlot(k) {
  const r = 40 + 18 * Math.sqrt(k + 0.5), a = k * GOLDEN;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r };
}
/** 是不是一块存在的地。 */
export function validPlot(k) {
  return Number.isInteger(k) && k >= 0 && k < PLOT_SLOTS;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/* ── 多边形 ─────────────────────────────────────────────────────────────── */
/** 用一条半平面切多边形(Sutherland–Hodgman)。留下 n·p + c >= 0 的那一半。 */
function clipHalf(poly, nx, nz, c) {
  const out = [];
  const side = (p) => nx * p[0] + nz * p[1] + c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}
export function polyCentroid(poly) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [poly[0][0], poly[0][1]];
  return [cx / (3 * a), cz / (3 * a)];
}
/** 多边形往里缩 d 米(每条边沿法线平移后再切)。够小就返回 null —— 那块地盖不了房子。 */
export function polyInset(poly, d) {
  let out = poly;
  for (let i = 0; i < poly.length && out.length >= 3; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0], ez = q[1] - p[1], L = Math.hypot(ex, ez) || 1;
    // 外法线朝右手边(多边形是逆时针的)
    const nx = ez / L, nz = -ex / L;
    // 留下"在这条边内侧至少 d 米"的那一半:-(n·x) + (n·p) - d >= 0
    out = clipHalf(out, -nx, -nz, (nx * p[0] + nz * p[1]) - d);
  }
  return out.length >= 3 ? out : null;
}
/** 点在凸多边形里(逆时针)。 */
export function insideConvex(q, poly) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0]) > 1e-9) return false;
  }
  return true;
}
function ngon(cx, cz, r, n) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = i / n * TAU; p.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return p;
}

/* ── 街道图:最小生成树 + 一点环 ─────────────────────────────────────────── */
/** Prim:保证每栋房子都走得到。 */
function mst(n, edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []); if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e); adj.get(e.b).push(e);
  }
  const inTree = new Array(n).fill(false), keep = [];
  inTree[0] = true;
  let frontier = (adj.get(0) || []).slice();
  for (let k = 0; k < n - 1 && frontier.length; k++) {
    frontier.sort((p, q) => p.d - q.d);
    let e = null;
    while (frontier.length) { const c = frontier.shift(); if (inTree[c.a] !== inTree[c.b]) { e = c; break; } }
    if (!e) break;
    keep.push(e);
    const add = inTree[e.a] ? e.b : e.a;
    inTree[add] = true;
    for (const f of adj.get(add) || []) if (inTree[f.a] !== inTree[f.b]) frontier.push(f);
  }
  return keep;
}
/** 每条边被多少条最短路径用到 —— 大道和小巷的区别不是画上去的,是走出来的。 */
function betweenness(n, edges) {
  const adj = new Map();
  edges.forEach((e, i) => {
    if (!adj.has(e.a)) adj.set(e.a, []); if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push([e.b, i]); adj.get(e.b).push([e.a, i]);
  });
  const use = new Array(edges.length).fill(0);
  for (let s = 0; s < n; s++) {
    const prev = new Array(n).fill(-1), pe = new Array(n).fill(-1), seen = new Array(n).fill(false);
    const q = [s];
    seen[s] = true;
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      for (const [w, ei] of adj.get(v) || []) if (!seen[w]) { seen[w] = true; prev[w] = v; pe[w] = ei; q.push(w); }
    }
    for (let t = 0; t < n; t++) { let v = t; while (v !== s && pe[v] >= 0) { use[pe[v]]++; v = prev[v]; } }
  }
  return use;
}

/**
 * 一座小镇的图纸。
 *
 * @param {Array} projects 广场上的项目 [{ id, title, lang, bytes, files, city, country }]
 * @param {object} [opts] seed 种子 · spacing 房子间距(米) · relax Lloyd 松弛几轮
 * @returns {{plots, streets, nodes, plazas, parks, districts, spawn, radius}}
 */
export function planTown(projects, opts = {}) {
  const list = (Array.isArray(projects) ? projects : []).filter((p) => p && p.id).slice(0, 400);
  const seed = opts.seed || 'terse-town';
  const rand = rng(seed + ':' + list.length);
  const n = list.length;
  if (!n) return { plots: [], streets: [], nodes: [], plazas: [], parks: [], districts: [], spawn: { x: 0, z: 0, yaw: 0 }, radius: 40 };

  /* 0 自己挑了地的:一块地只给列表里第一个挑它的(服务端本来就不让两个人挑同一块) */
  const pinOf = new Map(), usedSlot = new Set();
  for (const p of list) {
    const k = p.plot == null || p.plot === '' ? NaN : +p.plot;
    if (validPlot(k) && !usedSlot.has(k)) { usedSlot.add(k); pinOf.set(p.id, k); }
  }
  const nAuto = n - pinOf.size;

  /* 1 分区:同一个城市的住一块儿(没有城市就按主语言) */
  const keyOf = (p) => (p.city ? 'c:' + String(p.city).toLowerCase() : p.lang ? 'l:' + String(p.lang).toLowerCase() : 'other');
  const groups = new Map();
  for (const p of list) {
    const k = keyOf(p);
    if (!groups.has(k)) groups.set(k, { key: k, name: p.city || p.lang || 'elsewhere', lang: p.lang || '', items: [] });
    groups.get(k).items.push(p);
  }
  // 大区先占好角度,小区插空 —— 每次都一样的次序
  const districts = [...groups.values()].sort((a, b) => b.items.length - a.items.length || (a.key < b.key ? -1 : 1));

  /* 2 选址:代码越多越靠里(镇中心是这座镇最"重"的几个项目) */
  const mass = (p) => Math.log10(1 + (+p.bytes || 0) / 1000) + Math.log10(1 + (+p.files || 0)) * 0.6;
  const ranked = list.slice().sort((a, b) => mass(b) - mass(a));
  const rankOf = new Map(ranked.map((p, i) => [p.id, i]));
  const spacing = +opts.spacing || 20;
  // 半径:让所有房子都摊得开(面积 ≈ n × 间距²),再留出中心广场和外圈
  let radius = Math.max(60, Math.sqrt(n * spacing * spacing / Math.PI) * 1.3 + 22);
  // 挑的地在外圈时,镇子(和城墙)要把它圈进来
  for (const k of pinOf.values()) radius = Math.max(radius, plotSlot(k).r + 30);
  let sites = [];
  let at = 0;
  for (const d of districts) {
    d.items.sort((a, b) => mass(b) - mass(a));
    // 挑了地的直接落在自己的地上;剩下的照老规矩分扇区(扇区只按没挑地的数)
    const auto = d.items.filter((p) => !pinOf.has(p.id));
    for (const p of d.items) {
      if (!pinOf.has(p.id)) continue;
      const q = plotSlot(pinOf.get(p.id));
      sites.push({ p, x: q.x, z: q.z, district: d.key, pin: true });
    }
    if (!auto.length) continue;
    const span = auto.length / nAuto * TAU;
    const a0 = at;
    at += span;
    auto.forEach((p, i) => {
      const r01 = (rankOf.get(p.id) + 0.5) / n;                    // 0 = 最大的项目
      const rr = 26 + Math.sqrt(r01) * (radius - 46);
      const a = a0 + span * ((i + 0.5) / auto.length) + (rand() - 0.5) * span * 0.5;
      sites.push({ p, x: Math.cos(a) * rr + (rand() - 0.5) * spacing * 0.5, z: Math.sin(a) * rr + (rand() - 0.5) * spacing * 0.5, district: d.key });
    });
  }
  /* 自动排的房子撞到了挑好的地上:往外让开,不然两块地都切得太小、盖不下房子 */
  const pins = sites.filter((q) => q.pin);
  if (pins.length) {
    const clear = spacing * 0.9;
    for (const q of sites) {
      if (q.pin) continue;
      for (const pp of pins) {
        const dx = q.x - pp.x, dz = q.z - pp.z, d0 = Math.hypot(dx, dz);
        if (d0 >= clear) continue;
        const ux = d0 > 1e-6 ? dx / d0 : Math.cos(rankOf.get(q.p.id) || 0), uz = d0 > 1e-6 ? dz / d0 : Math.sin(rankOf.get(q.p.id) || 0);
        q.x = pp.x + ux * clear; q.z = pp.z + uz * clear;
      }
    }
  }
  // 公园和广场的地:再撒一些没有项目的点,镇子才有空当
  const extra = Math.max(3, Math.round(n * 0.18));
  for (let i = 0; i < extra; i++) {
    const a = rand() * TAU, rr = 20 + Math.sqrt(rand()) * (radius - 34);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    // 公园不压在挑好的地上
    if (pins.some((pp) => Math.hypot(x - pp.x, z - pp.z) < spacing * 0.7)) continue;
    sites.push({ p: null, x, z, district: '' });
  }

  /* Lloyd 松弛:点往自己地块的重心挪,间距就均匀了 */
  const bound = ngon(0, 0, radius, 22);
  const relax = opts.relax == null ? 3 : opts.relax;
  let cells = [];
  for (let pass = 0; pass <= relax; pass++) {
    cells = voronoi(sites, bound);
    if (pass === relax) break;
    sites = sites.map((s, i) => {
      const c = cells[i].poly;
      if (s.pin || !c || c.length < 3) return s;          // 挑好的地不挪
      const [cx, cz] = polyCentroid(c);
      return Object.assign({}, s, { x: s.x + (cx - s.x) * 0.72, z: s.z + (cz - s.z) * 0.72 });
    });
  }

  /* 4 街道:邻接图 → 最小生成树 + 15% 的环 */
  const edgeKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  const seenE = new Map();
  cells.forEach((c, i) => {
    for (const j of c.nb) {
      if (j <= i) continue;
      const k = edgeKey(i, j);
      if (!seenE.has(k)) seenE.set(k, { a: i, b: j, d: dist(sites[i], sites[j]) });
    }
  });
  const all = [...seenE.values()].sort((p, q) => p.d - q.d);
  const keep = mst(sites.length, all);
  const inKeep = new Set(keep.map((e) => edgeKey(e.a, e.b)));
  for (const e of all) {
    if (keep.length >= Math.round((sites.length - 1) * 1.15)) break;
    if (!inKeep.has(edgeKey(e.a, e.b))) { keep.push(e); inKeep.add(edgeKey(e.a, e.b)); }
  }
  const use = betweenness(sites.length, keep);
  const maxUse = Math.max(1, ...use);
  const streets = keep.map((e, i) => {
    const t = use[i] / maxUse;
    // 大道 12 米、街 8 米、巷 4.5 米 —— 宽度是走出来的,不是随手定的
    const w = t > 0.55 ? 12 : t > 0.2 ? 8 : 4.5;
    return { a: e.a, b: e.b, w, rank: t > 0.55 ? 'avenue' : t > 0.2 ? 'street' : 'lane', use: use[i] };
  });
  const halfW = new Array(sites.length).fill(2.2);
  for (const s of streets) { halfW[s.a] = Math.max(halfW[s.a], s.w / 2); halfW[s.b] = Math.max(halfW[s.b], s.w / 2); }

  /* 5 广场:最热闹的三个路口;6 门:朝着最近的那条街 */
  const nodeUse = new Array(sites.length).fill(0);
  streets.forEach((s, i) => { nodeUse[s.a] += use[i]; nodeUse[s.b] += use[i]; });
  const plazaIdx = new Set(sites.map((_, i) => i).filter((i) => sites[i].p == null)
    .sort((i, j) => nodeUse[j] - nodeUse[i]).slice(0, 3));

  const plots = [], parks = [], plazas = [];
  cells.forEach((c, i) => {
    const s = sites[i];
    if (!c.poly || c.poly.length < 3) return;
    const inner = polyInset(c.poly, halfW[i] + 0.6);
    const [cx, cz] = polyCentroid(c.poly);
    if (!s.p) {
      if (plazaIdx.has(i)) plazas.push({ cx, cz, r: Math.max(6, Math.sqrt(polyArea(c.poly) / Math.PI) * 0.8), poly: inner || c.poly });
      else parks.push({ cx, cz, poly: inner || c.poly, area: polyArea(c.poly) });
      return;
    }
    if (!inner) return;                                   // 太小了,盖不下 —— 那块地就空着
    // 门:朝着最近那个路口的那条边的中点
    let best = null;
    for (const j of c.nb) {
      const d0 = dist(s, sites[j]);
      if (!best || d0 < best.d) best = { d: d0, j };
    }
    const to = best ? sites[best.j] : { x: 0, z: 0 };
    const dx = to.x - s.x, dz = to.z - s.z, L = Math.hypot(dx, dz) || 1;
    /* 房子只占地块的一小块,剩下的是院子 —— 别墅不是把整块地砌满。
       (第一版正是砌满的:一栋 1084 平米、25 米高的方块,一栋房就是五十万颗点。)
       中世纪的房子是**长方形**的:窄面朝街(一户人家的门脸 5–8 米),往里深 —— 这就是
       burgage 地块的样子。长方形才盖得出两坡顶、山墙、一层层探出来的楼(jetty)。 */
    let [ix, iz] = polyCentroid(inner);
    // 挑了地的:房子就盖在挑的那个点上(地块稀的时候,重心可能离它二三十米)
    if (s.pin && insideConvex([s.x, s.z], inner)) { ix = s.x; iz = s.z; }
    const fx = dx / L, fz = dz / L, rx = fz, rz = -fx;      // f 朝街,r 沿街(和 x/z 同一手性)
    const want = Math.max(55, Math.min(200, 55 + mass(s.p) * 30));
    let wd = 0, dp = 0;                                      // 门脸窄、进深长(挤不下就方一点)
    let foot = null;
    /* 别墅外面多大由它里面的平面图定(town-build 的 villaMassing 算好了 fw × fd);
       没给就按量估一个。放不下先缩,再试方一点的比例。 */
    const hasFoot = +s.p.fw > 0 && +s.p.fd > 0;
    const base0 = hasFoot ? Math.sqrt(s.p.fw * s.p.fd) : Math.sqrt(want);
    const ratios = hasFoot ? [s.p.fd / s.p.fw, 1, s.p.fw / s.p.fd] : [1.35, 1, 0.75];
    for (let k = 1; k > 0.12 && !foot; k *= 0.9) for (const ratio of ratios) for (const back of [0.25, 0]) {
      if (foot) break;
      wd = base0 / Math.sqrt(ratio); dp = base0 * Math.sqrt(ratio);
      const w2 = wd * k / 2, d2 = dp * k / 2;
      // 往后让一点:门前留出台阶和院子口(挤的地块就不让)
      const ox = ix - fx * d2 * back, oz = iz - fz * d2 * back;
      const rect = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => [ox + rx * u * w2 + fx * v * d2, oz + rz * u * w2 + fz * v * d2]);
      if (rect.every((q) => insideConvex(q, inner)) && polyArea(rect) > 20) { foot = rect; wd *= k; dp *= k; }
    }
    let rect = !!foot;
    if (!foot) {
      // 挤得放不下长方形的地块:照老办法,地块缩一圈就是房子(屋顶盖成四坡)
      const cellA = polyArea(inner);
      const k = Math.min(1, Math.sqrt(want / Math.max(1, cellA)));
      foot = k < 0.999 ? inner.map((q) => [ix + (q[0] - ix) * k, iz + (q[1] - iz) * k]) : inner;
      wd = dp = Math.sqrt(polyArea(foot));
    }
    const area = polyArea(foot);
    const [hx, hz] = polyCentroid(foot);
    // 两到四层;镇中心那几个最大的项目高一点,当地标
    const tall = rankOf.get(s.p.id) < 3 ? 1.3 : 1;
    const h = Math.max(5.5, Math.min(12, 5.5 + mass(s.p) * 1.7)) * tall;
    const reach = dp / 2 + 0.35;
    // 这户人家做什么:门口的招牌、院子里的东西、夜里的光都跟着它
    const th = hash01(seed + ':trade:' + s.p.id);
    const trade = th < 0.07 ? 'tavern' : th < 0.12 ? 'smithy' : th < 0.17 ? 'bakery' : th < 0.22 ? 'weaver' : th < 0.26 ? 'cooper' : 'home';
    plots.push({
      id: s.p.id, project: s.p, district: s.district, poly: foot, cell: inner, cx: hx, cz: hz, area, h,
      w: wd, d: dp, fx, fz, rect, trade, site: i,
      door: { x: hx + fx * reach, z: hz + fz * reach, yaw: Math.atan2(-fx, -fz) },
    });
  });

  // 最大的广场排第一:它是集市,人从这里出生
  plazas.sort((p, q) => q.r - p.r);
  /* 出生点:最热闹的那个广场中间(没有广场就镇中心),脸朝镇子里 */
  const sp = plazas[0] || { cx: 0, cz: 0 };
  const spawn = { x: sp.cx, z: sp.cz + 3, yaw: Math.atan2(sp.cx - sp.cx, -(sp.cz - (sp.cz + 3))) };

  const nodes = sites.map((s, i) => ({ x: s.x, z: s.z, use: nodeUse[i], plot: !!s.p }));
  const world = planWorld({ plots, streets, plazas, parks, radius, nodes }, seed + ':' + n);

  return {
    plots, streets, plazas, parks, radius, world,
    nodes,
    districts: districts.map((d) => {
      const own = plots.filter((p) => p.district === d.key);
      const cx = own.reduce((a, p) => a + p.cx, 0) / (own.length || 1);
      const cz = own.reduce((a, p) => a + p.cz, 0) / (own.length || 1);
      return { key: d.key, name: d.name, lang: d.lang, n: own.length, cx, cz };
    }).filter((d) => d.n),
    spawn,
  };
}

/** 每个点的地块:拿外圈多边形,挨个用中垂线切。谁切下了边,谁就是邻居。 */
function voronoi(sites, bound) {
  const out = [];
  for (let i = 0; i < sites.length; i++) {
    let poly = bound;
    const nb = [];
    // 只跟近处的点比:远处的中垂线切不到自己这块地
    const near = sites.map((s, j) => ({ j, d: dist(sites[i], s) })).filter((q) => q.j !== i).sort((a, b) => a.d - b.d).slice(0, 18);
    for (const { j } of near) {
      const a = sites[i], b = sites[j];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      let nx = a.x - b.x, nz = a.z - b.z;
      const L = Math.hypot(nx, nz) || 1;
      nx /= L; nz /= L;
      const before = poly.length;
      const cut = clipHalf(poly, nx, nz, -(nx * mx + nz * mz));
      // 真的切掉了东西 = 这两块地挨着
      if (cut.length !== before || cut.some((p, k) => p !== poly[k])) nb.push(j);
      poly = cut;
      if (poly.length < 3) break;
    }
    out.push({ poly, nb });
  }
  return out;
}

/* ── 镇子以外、镇子中间的那些"不是谁家的"东西 ─────────────────────────────
   研究笔记(真实的中世纪小镇):城墙 5–6 米高、2 米厚,四五十米一座塔;城门洞 3–4 米宽;
   墙外一圈护城河;市场广场中间一口井、一座市场十字;教堂的塔是全镇的地标,从哪条街都
   看得见;墙外是一圈条田、牧场、果园,一座风车,一条小河带着水磨;再往外是林子。 */

/** 线段 ab 上离 q 最近的距离。 */
function segDist(q, a, b) {
  const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
  let t = ((q[0] - a[0]) * ex + (q[1] - a[1]) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(q[0] - a[0] - ex * t, q[1] - a[1] - ez * t);
}
/** 折线上离 q 最近的距离。 */
export function polylineDist(q, pts) {
  let d = 1e9;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(q, pts[i], pts[i + 1]));
  return d;
}
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return Math.abs(d); };

/** 在凸多边形里找一块朝 (fx,fz) 的 w×d 长方形,放得下就返回四个角。 */
export function fitRect(poly, cx, cz, fx, fz, w, d, minK = 0.45) {
  const rx = fz, rz = -fx;
  for (let k = 1; k >= minK; k *= 0.92) {
    const w2 = w * k / 2, d2 = d * k / 2;
    const rect = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => [cx + rx * u * w2 + fx * v * d2, cz + rz * u * w2 + fz * v * d2]);
    if (rect.every((q) => insideConvex(q, poly))) return { rect, k, w: w * k, d: d * k };
  }
  return null;
}

export function planWorld(T, seed) {
  const rand = rng(seed + ':world');
  const R = T.radius;
  const wallR = R + 8;
  /* 城墙:一圈,半径轻轻起伏(手砌的墙不是圆规画的) */
  const NW = Math.max(28, Math.round(TAU * wallR / 11));
  const ph1 = rand() * TAU, ph2 = rand() * TAU;
  const wallAt = (a) => wallR * (1 + 0.025 * Math.sin(a * 3 + ph1) + 0.015 * Math.sin(a * 5 + ph2));
  const wallPts = [];
  for (let i = 0; i < NW; i++) { const a = i / NW * TAU; const r = wallAt(a); wallPts.push([Math.cos(a) * r, Math.sin(a) * r]); }

  /* 城门:四个方向上各挑一个最靠外的路口,从它往外开一道门(门至少隔开 60°) */
  const gates = [];
  const off = rand() * TAU;
  const outer = T.nodes.map((nd, i) => ({ i, a: Math.atan2(nd.z, nd.x), r: Math.hypot(nd.x, nd.z) }))
    .filter((q) => T.streets.some((st) => st.a === q.i || st.b === q.i));
  const nGates = R > 110 ? 4 : 3;
  for (let g = 0; g < nGates; g++) {
    // 门按方向均分;里侧接最近的那个外圈路口(按"往这个方向走得多远"挑)
    const a = off + g / nGates * TAU;
    const c = outer.slice().sort((p, q) => q.r * Math.cos(angDiff(q.a, a)) - p.r * Math.cos(angDiff(p.a, a)))[0];
    const r = wallAt(a);
    gates.push({ a, x: Math.cos(a) * r, z: Math.sin(a) * r, w: 4, node: c && angDiff(c.a, a) < 1.2 ? c.i : -1 });
  }
  /* 城门里侧接上街:一条从最近路口到门洞的街(街道图因此走得出城) */
  for (const G of gates) {
    const ni = T.nodes.length;
    T.nodes.push({ x: Math.cos(G.a) * (wallAt(G.a) - 3), z: Math.sin(G.a) * (wallAt(G.a) - 3), use: 0, plot: false, gate: true });
    if (G.node >= 0) T.streets.push({ a: G.node, b: ni, w: 6, rank: 'street', use: 0, gate: true });
    G.inner = ni;
  }

  const moat = { r0: wallR + 3, r1: wallR + 10 };
  const forest = { r0: wallR + 150, r1: wallR + 250 };
  /* 出城的土路:门外一直走到林子里,路微微弯 */
  const roads = gates.map((G) => {
    const pts = [];
    const bend = (rand() - 0.5) * 0.5;
    for (let k = 0; k <= 12; k++) {
      const r = wallAt(G.a) + k / 12 * (forest.r1 - wallR + 10);
      const a = G.a + Math.sin(k / 12 * Math.PI) * bend * (r - wallR) / r;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return { pts, w: 4.5, gate: G };
  });

  /* 小河:从护城河流出去,在两道门之间最宽的那道空当里,弯弯曲曲 */
  const ga = gates.map((G) => ((G.a % TAU) + TAU) % TAU).sort((p, q) => p - q);
  let gap = { a: off, w: 0 };
  for (let i = 0; i < ga.length; i++) {
    const a0 = ga[i], a1 = i + 1 < ga.length ? ga[i + 1] : ga[0] + TAU;
    if (a1 - a0 > gap.w) gap = { a: a0, w: a1 - a0 };
  }
  const streamA = gap.a + gap.w * (0.3 + rand() * 0.15);
  const stream = { pts: [], w: 5 };
  for (let k = 0; k <= 30; k++) {
    const r = moat.r1 - 1 + k / 30 * (forest.r1 + 30 - moat.r1);
    const a = streamA + Math.sin(k * 0.55 + rand() * 0.2) * 14 / r + Math.sin(k * 0.21) * 22 / r;
    stream.pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const wm = stream.pts[6], wm2 = stream.pts[7];
  const sdx = wm2[0] - wm[0], sdz = wm2[1] - wm[1], sL = Math.hypot(sdx, sdz) || 1;
  const watermill = { x: wm[0] - sdz / sL * 9, z: wm[1] + sdx / sL * 9, wheel: { x: wm[0] - sdz / sL * 3.2, z: wm[1] + sdx / sL * 3.2 }, fx: sdz / sL, fz: -sdx / sL };

  /* 墙外那一圈地:门和门之间切成一块块扇形,种地、放牧、果园 */
  const sectors = [];
  const gateAs = ga.length ? ga : [off];
  for (let i = 0; i < gateAs.length; i++) {
    const a0 = gateAs[i], a1 = i + 1 < gateAs.length ? gateAs[i + 1] : gateAs[0] + TAU;
    const span = a1 - a0;
    const k = Math.max(1, Math.round(span / 0.42));
    for (let j = 0; j < k; j++) {
      const s0 = a0 + span * j / k + 0.05, s1 = a0 + span * (j + 1) / k - 0.05;
      // 两圈:近的一圈是地和果园,远的一圈是牧场(牛羊离林子近,离镇子远)
      for (const [r0, r1] of [[moat.r1 + 10, moat.r1 + 72], [moat.r1 + 80, forest.r0 - 6]]) {
        const u = rand();
        const kind = r0 < moat.r1 + 20 ? (u < 0.7 ? 'field' : 'orchard') : (u < 0.62 ? 'pasture' : u < 0.85 ? 'field' : 'orchard');
        sectors.push({ a0: s0, a1: s1, r0, r1, kind });
      }
    }
  }
  const nearStream = (x, z, m) => polylineDist([x, z], stream.pts) < m;
  const CROPS = ['wheat', 'rye', 'barley', 'flax', 'cabbage', 'fallow'];
  const fields = [], pastures = [], orchards = [];
  const HERDS = ['sheep', 'cow', 'sheep', 'horse', 'goat', 'cow'];
  for (const sc of sectors) {
    const am = (sc.a0 + sc.a1) / 2, rm = (sc.r0 + sc.r1) / 2;
    const cx = Math.cos(am) * rm, cz = Math.sin(am) * rm;
    if (sc.kind === 'field') {
      // 条田:沿半径方向的一条条,宽 7–9 米
      const strips = Math.max(2, Math.round((sc.a1 - sc.a0) * rm / 8));
      const crops = [];
      for (let k = 0; k < strips; k++) crops.push(CROPS[Math.floor(rand() * CROPS.length)]);
      fields.push(Object.assign({}, sc, { crops, cx, cz }));
    } else if (sc.kind === 'pasture') {
      const r = Math.min((sc.r1 - sc.r0) / 2, (sc.a1 - sc.a0) * rm / 2) - 3;
      const bx = Math.cos(am) * (sc.r0 + 7), bz = Math.sin(am) * (sc.r0 + 7);
      pastures.push(Object.assign({}, sc, { x: cx, z: cz, r, kind: HERDS[pastures.length % HERDS.length],
        barn: { x: bx, z: bz, yaw: Math.atan2(-Math.cos(am), -Math.sin(am)) } }));
    } else {
      orchards.push(Object.assign({}, sc, { x: cx, z: cz, r: Math.min((sc.r1 - sc.r0) / 2, (sc.a1 - sc.a0) * rm / 2) - 2 }));
    }
  }
  /* 风车:离镇子不远的一块地中间(磨坊都在墙外的高处) */
  const wf = fields.filter((f) => f.r0 < moat.r1 + 20 && !nearStream(f.cx, f.cz, 25))[0] || fields[0];
  const windmill = wf ? { x: Math.cos((wf.a0 + wf.a1) / 2) * (wf.r1 + 4), z: Math.sin((wf.a0 + wf.a1) / 2) * (wf.r1 + 4) } : null;

  /* 市场:最热闹的那个广场。井在中间,摊子围一圈,朝里 */
  // 最大的那个广场当集市(出生点那个广场未必最大)
  const P0 = T.plazas.slice().sort((p, q) => q.r - p.r)[0];
  let market = null;
  if (P0) {
    const stalls = [];
    const ns = Math.max(3, Math.min(10, Math.floor(TAU * P0.r * 0.72 / 4.6)));
    for (let i = 0; i < ns; i++) {
      const a = i / ns * TAU + 0.3;
      // 摊子离井 4 米以上;广场小的时候往里收,收不下就不摆
      for (const k of [0.74, 0.6, 0.5]) {
        const rr = Math.max(4.2, P0.r * k);
        const x = P0.cx + Math.cos(a) * rr, z = P0.cz + Math.sin(a) * rr;
        if (!insideConvex([x + Math.cos(a) * 1.4, z + Math.sin(a) * 1.4], P0.poly)) continue;
        stalls.push({ x, z, yaw: Math.atan2(Math.cos(a), Math.sin(a)), goods: Math.floor(rand() * 6) });
        break;
      }
    }
    market = { x: P0.cx, z: P0.cz, r: P0.r, well: { x: P0.cx, z: P0.cz }, cross: { x: P0.cx + P0.r * 0.4, z: P0.cz - P0.r * 0.25 }, stalls };
  }

  /* 教堂:离镇中心最近、够大的一块空地(那块地就成了墓园) */
  let church = null;
  const parks = T.parks.slice().sort((p, q) => Math.hypot(p.cx, p.cz) - Math.hypot(q.cx, q.cz));
  for (const pk of parks) {
    if (pk.area < 220) continue;
    // 教堂东西向(中世纪的规矩:祭坛朝东)
    const fit = fitRect(pk.poly, pk.cx, pk.cz, 1, 0, 8, 22, 0.55);
    if (!fit) continue;
    const tw = Math.min(5.5, fit.w * 0.75);
    church = { x: pk.cx, z: pk.cz, fx: 1, fz: 0, w: fit.w, d: fit.d, rect: fit.rect, yard: pk.poly,
      tower: { x: pk.cx - (fit.d / 2 - tw / 2), z: pk.cz, s: tw, h: 17 + fit.k * 4, spire: 13 + fit.k * 5 } };
    pk.church = true;
    break;
  }
  if (church) T.parks.splice(T.parks.findIndex((p) => p.church), 1);

  /* 后院(burgage):房子背后,那一侧没有街过来的,种菜、劈柴、养鸡 */
  const yards = [];
  for (const pl of T.plots) {
    const bx = -pl.fx, bz = -pl.fz;
    const st = T.streets.filter((q) => q.a === pl.site || q.b === pl.site).map((q) => {
      const o = T.nodes[q.a === pl.site ? q.b : q.a];
      const dx = o.x - pl.cx, dz = o.z - pl.cz, L = Math.hypot(dx, dz) || 1;
      return dx / L * bx + dz / L * bz;
    });
    if (st.some((c) => c > 0.55)) continue;
    const depth = pl.d || 8;
    const gx = pl.cx + bx * (depth / 2 + 3.2), gz = pl.cz + bz * (depth / 2 + 3.2);
    if (!insideConvex([gx, gz], pl.cell)) continue;
    // 这块地能往后铺多深
    let deep = 2.4;
    while (deep < 9 && insideConvex([pl.cx + bx * (depth / 2 + 1 + deep), pl.cz + bz * (depth / 2 + 1 + deep)], pl.cell)) deep += 0.6;
    if (deep < 3) continue;
    const h = hash01(seed + ':yard:' + pl.id);
    yards.push({ plot: pl.id, x: pl.cx + bx * (depth / 2 + 1 + deep / 2), z: pl.cz + bz * (depth / 2 + 1 + deep / 2),
      fx: bx, fz: bz, w: Math.min(pl.w || 6, 7), d: deep, coop: h < 0.35, tree: h > 0.5, wood: true });
  }

  return { wall: { r: wallR, pts: wallPts, at: null, gates, h: 5.6 }, moat, forest, roads, stream, watermill, windmill,
    fields, pastures, orchards, market, church, yards };
}

/** 墙在这个方向有多远(给碰撞和地图用;和 planWorld 里那条是同一个形状,按折线插值)。 */
export function wallRadiusAt(world, a) {
  const pts = world.wall.pts, n = pts.length;
  const t = ((a % TAU) + TAU) % TAU / TAU * n;
  const i = Math.floor(t) % n, j = (i + 1) % n, f = t - Math.floor(t);
  return Math.hypot(pts[i][0], pts[i][1]) * (1 - f) + Math.hypot(pts[j][0], pts[j][1]) * f;
}
