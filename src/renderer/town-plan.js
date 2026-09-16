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
  const radius = Math.max(60, Math.sqrt(n * spacing * spacing / Math.PI) * 1.3 + 22);
  let sites = [];
  let at = 0;
  for (const d of districts) {
    const span = d.items.length / n * TAU;
    const a0 = at;
    at += span;
    d.items.sort((a, b) => mass(b) - mass(a));
    d.items.forEach((p, i) => {
      const r01 = (rankOf.get(p.id) + 0.5) / n;                    // 0 = 最大的项目
      const rr = 26 + Math.sqrt(r01) * (radius - 46);
      const a = a0 + span * ((i + 0.5) / d.items.length) + (rand() - 0.5) * span * 0.5;
      sites.push({ p, x: Math.cos(a) * rr + (rand() - 0.5) * spacing * 0.5, z: Math.sin(a) * rr + (rand() - 0.5) * spacing * 0.5, district: d.key });
    });
  }
  // 公园和广场的地:再撒一些没有项目的点,镇子才有空当
  const extra = Math.max(3, Math.round(n * 0.18));
  for (let i = 0; i < extra; i++) {
    const a = rand() * TAU, rr = 20 + Math.sqrt(rand()) * (radius - 34);
    sites.push({ p: null, x: Math.cos(a) * rr, z: Math.sin(a) * rr, district: '' });
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
      if (!c || c.length < 3) return s;
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
       (第一版正是砌满的:一栋 1084 平米、25 米高的方块,一栋房就是五十万颗点。) */
    const cellA = polyArea(inner);
    const want = Math.max(70, Math.min(260, 70 + mass(s.p) * 38));
    const k = Math.min(1, Math.sqrt(want / Math.max(1, cellA)));
    const [ix, iz] = polyCentroid(inner);
    const foot = k < 0.999 ? inner.map((q) => [ix + (q[0] - ix) * k, iz + (q[1] - iz) * k]) : inner;
    const area = polyArea(foot);
    // 层高 3 米,两到五层;镇中心那几个最大的项目高一点,当地标
    const tall = rankOf.get(s.p.id) < 3 ? 1.45 : 1;
    const h = Math.max(5.5, Math.min(16, 5.5 + mass(s.p) * 2.2)) * tall;
    const reach = Math.sqrt(area) * 0.5 + 1.4;
    plots.push({
      id: s.p.id, project: s.p, district: s.district, poly: foot, cell: inner, cx: ix, cz: iz, area, h,
      door: { x: ix + dx / L * reach, z: iz + dz / L * reach, yaw: Math.atan2(-dx / L, -dz / L) },
    });
  });

  /* 出生点:最热闹的那个广场中间(没有广场就镇中心),脸朝镇子里 */
  const sp = plazas[0] || { cx: 0, cz: 0 };
  const spawn = { x: sp.cx, z: sp.cz + 3, yaw: Math.atan2(sp.cx - sp.cx, -(sp.cz - (sp.cz + 3))) };

  return {
    plots, streets, plazas, parks, radius,
    nodes: sites.map((s, i) => ({ x: s.x, z: s.z, use: nodeUse[i], plot: !!s.p })),
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
