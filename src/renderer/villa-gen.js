/**
 * villa-gen.js — 代码**别墅**的生成语法(代码城市的室内版)。
 *
 * 代码城市把一个项目说成"从外面看的一栋楼";别墅把同一个项目翻到里面来:
 * **一个顶层目录 = 一个房间**。走进去,房子的平面图就是仓库的目录树。
 *
 *     房间占地   ∝  目录里的文件数        —— 大目录是大厅,小目录是储物间
 *     房间用途   ←  dir.kind             —— source=书房/工坊  docs=图书室
 *                                            assets=画廊  test=实验室  config=机房
 *     墙/材质色  ←  该目录的主语言        —— 和代码城市同一条色带(lang-colors)
 *     灯光冷暖   ←  age_days / churn      —— 最近动过的房间是暖的、亮的;荒废的发冷
 *     陈设/热度  ←  hot 文件的 churn      —— 改得最勤的文件是房间里发光的那件东西
 *
 * 和 city-styles.js 一样,这里**指标映射固定、只有形在变**,而且**种子来自名字**,
 * 不用 Math.random:同一个仓库每次进门都是同一套平面图,否则人会以为项目变了。
 *
 * 这个文件**不认识 three,也不认识 Spark** —— 它只把表面"撒成高斯点",通过一个
 * emit(x,y,z, r,g,b, scale, opacity) 回调交出去。谁来渲染是 villa.js 的事。
 * 这样它能被单测(node 里 import 不进来 three),也能换渲染后端。
 */

/* ── 稳定伪随机(整份文件不许出现 Math.random)────────────────────────── */
export function seedOf(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}
function picker(seed) {
  let n = seed >>> 0;
  return {
    f() { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; },
    of(arr) { return arr[Math.floor(this.f() * arr.length) % arr.length]; },
    odds(p) { return this.f() < p; },
    int(lo, hi) { return lo + Math.floor(this.f() * (hi - lo + 1)); },
    range(lo, hi) { return lo + this.f() * (hi - lo); },
  };
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const scalec = (c, k) => [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)];

/* ── 语言 → 颜色 ────────────────────────────────────────────────────────
   和 lang-colors.js 同一张表(这里内联一份,免得 villa-gen 依赖 DOM 模块)。 */
const LANG_HEX = {
  rust: '#dea584', ts: '#3178c6', typescript: '#3178c6', js: '#f1e05a', javascript: '#f1e05a',
  python: '#3572A5', py: '#3572A5', go: '#00ADD8', swift: '#F05138', kotlin: '#A97BFF',
  java: '#b07219', c: '#555555', 'c++': '#f34b7d', cpp: '#f34b7d', ruby: '#701516',
  php: '#4F5D95', 'c#': '#178600', csharp: '#178600', html: '#e34c26', css: '#563d7c',
  scss: '#c6538c', shell: '#89e051', bash: '#89e051', sql: '#e38c00', json: '#cbcb41',
  yaml: '#cb171e', toml: '#9c4221', markdown: '#083fa1', md: '#083fa1',
};
const LANG_FALLBACK = [0.54, 0.54, 0.56];
export function langRgb(lang) {
  const hex = LANG_HEX[String(lang || '').toLowerCase()];
  if (!hex) return LANG_FALLBACK.slice();
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ── 每种目录的"房型"性格 ─────────────────────────────────────────────── */
// 注意:splat 是**自发光**的(没有光照模型),颜色就是最终亮度 —— 所以底色要给够,
// 不然屋里一片漆黑。地板/墙用中等亮度,靠灯和陈设再拉对比。
const KIND = {
  source: { label: 'source', floor: [0.34, 0.33, 0.40], accent: [0.55, 0.85, 1.0], warm: 0.15 },
  docs:   { label: 'docs',   floor: [0.44, 0.37, 0.28], accent: [1.0, 0.86, 0.5],  warm: 0.5 },
  assets: { label: 'assets', floor: [0.38, 0.31, 0.44], accent: [1.0, 0.5, 0.85],  warm: 0.35 },
  test:   { label: 'test',   floor: [0.28, 0.40, 0.35], accent: [0.5, 1.0, 0.7],   warm: 0.1 },
  config: { label: 'config', floor: [0.40, 0.40, 0.32], accent: [0.7, 0.75, 0.8],  warm: 0.2 },
};
const kindOf = (k) => KIND[k] || KIND.source;

/* 房间"最近有没有人住"→ 0(荒废/冷)..1(刚动过/暖)。churn 大且 age 小 = 暖。 */
function liveness(dir) {
  const age = Number(dir.age_days ?? dir.ageDays ?? 999);
  const churn = Number(dir.churn ?? 0);
  const fresh = clamp01(1 - age / 120);          // 4 个月内算"新"
  const busy = clamp01(Math.log2(1 + churn) / 8); // churn 用对数,别让一个热目录吃掉全部
  return clamp01(fresh * 0.65 + busy * 0.55);
}

/* ── 平面图布局 ─────────────────────────────────────────────────────────
   一条中央走廊沿 +Z 伸进去,房间左右交替挂在走廊两侧。房间太多就上二楼
   (楼梯在走廊尽头)。全程只用种子,保证同仓库同平面图。 */
const EYE = 1.6;              // 眼高(米)
const WALL_H = 3.0;          // 层高
const FLOOR_GAP = 0.6;       // 楼板厚
const CORR_W = 3.2;          // 走廊宽
const DOOR_W = 1.6;          // 门洞宽
const PER_FLOOR = 8;         // 每层最多几个房间

export function buildVilla(capsule) {
  const cap = capsule || {};
  const dirs = (Array.isArray(cap.dirs) ? cap.dirs : []).filter((d) => d && (d.files || 0) >= 0);
  const seed = seedOf(cap.title || cap.id || 'terse');
  const P = picker(seed);

  // 房间排序:source 在前(住得最勤的先给最好的位置),再 docs/test/assets/config;
  // 同类里文件多的在前。稳定,不依赖输入顺序。
  const order = { source: 0, docs: 1, test: 2, assets: 3, config: 4 };
  const rooms = dirs
    .map((d, i) => ({ raw: d, k: d.kind || 'source', files: Math.max(1, d.files || 1), idx: i }))
    .sort((a, b) => (order[a.k] - order[b.k]) || (b.files - a.files) || (a.idx - b.idx));

  // 没有目录数据时,造一个"单间小屋",这样空项目也能进得去、不至于黑屏。
  if (!rooms.length) {
    rooms.push({ raw: { name: cap.title || 'root', kind: 'source', files: 1, langs: cap.langs || [] }, k: 'source', files: 1, idx: 0 });
  }

  const built = [];
  const doors = [];
  let corridorLen = 0;
  const floors = Math.max(1, Math.ceil(rooms.length / PER_FLOOR));

  // 房间尺寸:占地 ∝ sqrt(files),夹在温和的范围里(别让一个巨目录撑爆房子)。
  const sizeOf = (files) => {
    const s = Math.sqrt(files);
    const w = clamp(3.2 + s * 0.55, 3.4, 9.5);
    const d = clamp(3.0 + s * 0.5, 3.2, 8.5);
    return { w, d };
  };

  for (let f = 0; f < floors; f++) {
    const floorRooms = rooms.slice(f * PER_FLOOR, (f + 1) * PER_FLOOR);
    const y0 = f * (WALL_H + FLOOR_GAP);
    // 左右两侧各自推进,房间隔着走廊面对面 —— 否则会拉成一条又长又细的隧道。
    const zBySide = { '-1': f === 0 ? 5.0 : 4.0, '1': f === 0 ? 5.0 : 4.0 };
    floorRooms.forEach((r, i) => {
      const side = (i % 2 === 0) ? -1 : 1;       // 左右交替
      const { w, d } = sizeOf(r.files);
      const cx = side * (CORR_W / 2 + w / 2);
      const cz = zBySide[side] + d / 2;
      const dir = r.raw;
      const lang = dir.lang || (dir.langs && dir.langs[0] && dir.langs[0][0]) || (cap.langs && cap.langs[0] && cap.langs[0][0]) || '';
      const live = liveness(dir);
      const hot = (Array.isArray(cap.hot) ? cap.hot : [])
        .filter((h) => matchDir(h.name, dir.name))
        .sort((a, b) => (b.churn || 0) - (a.churn || 0))
        .slice(0, 5);
      built.push({
        id: 'r' + f + '_' + i,
        name: String(dir.name || 'dir').replace(/\/+$/,'') || '/',
        kind: r.k, floor: f, files: r.files, lang,
        color: langRgb(lang), live,
        churn: dir.churn || 0, ageDays: dir.age_days ?? dir.ageDays ?? null,
        cx, cz, w, d, y0, side, hot,
        seed: seedOf((cap.title || '') + dir.name + f),
      });
      // 门:房间朝走廊那面开一个洞,门在走廊中心线上对着房间中心。
      doors.push({ room: 'r' + f + '_' + i, x: side * (CORR_W / 2), z: cz, floor: f, w: DOOR_W });
      zBySide[side] = cz + d / 2 + 1.4; // 该侧往里挪一格
      corridorLen = Math.max(corridorLen, zBySide[side]);
    });
  }

  // 门厅(foyer)在走廊起点,进门第一眼站的地方。
  const foyer = { x: 0, z: 2.2, y: 0 };
  const entrance = { x: 0, z: -3.5, y: 0 }; // 屋外正门口(相机从这里进)
  const stair = floors > 1 ? { x: 0, z: corridorLen + 1.2 } : null;

  // 别墅外壳的包围盒。
  const maxHalfW = built.reduce((m, r) => Math.max(m, Math.abs(r.cx) + r.w / 2), CORR_W);
  const bounds = {
    x0: -maxHalfW - 1.2, x1: maxHalfW + 1.2,
    z0: -1.5, z1: corridorLen + 2.0,
    floors, floorH: WALL_H + FLOOR_GAP, wallH: WALL_H,
  };

  const domLang = (cap.langs && cap.langs[0] && cap.langs[0][0]) || (built[0] && built[0].lang) || '';
  return {
    title: cap.title || 'Untitled', subtitle: cap.subtitle || '',
    files: cap.files || dirs.reduce((s, d) => s + (d.files || 0), 0),
    rooms: built, doors, foyer, entrance, stair, bounds,
    domLang, domColor: langRgb(domLang),
    langs: cap.langs || [], seed,
    corridor: { w: CORR_W, len: corridorLen },
    eye: EYE,
  };
}

/* hot 文件名 "src/renderer/x.js" 属不属于目录 "renderer"?宽松匹配路径里含该段。 */
function matchDir(fileName, dirName) {
  if (!fileName || !dirName) return false;
  const seg = String(dirName).replace(/\/+$/,'').split('/').pop().toLowerCase();
  return String(fileName).toLowerCase().split(/[\\/]/).includes(seg);
}

/* ── 撒点:把别墅表面变成高斯点 ─────────────────────────────────────────
   emit(x,y,z, r,g,b, scale, opacity)。density 是全局密度系数(高清程度)。 */

// 在一个轴对齐矩形墙面上撒点。plane: 'x' 固定 x(YZ 面), 'z' 固定 z(XY 面)。
function wall(emit, o) {
  const { plane, at, a0, a1, y0, y1, col, density, gapC, gapHalf, jitter = 0.02, sc = 0.028 } = o;
  const A = Math.abs(a1 - a0), Hh = Math.abs(y1 - y0);
  const cols = Math.max(2, Math.round(A * 9 * density));
  const rows = Math.max(2, Math.round(Hh * 9 * density));
  for (let i = 0; i <= cols; i++) {
    const u = i / cols, av = lerp(a0, a1, u);
    // 门洞:某个高度以下、某段宽度内不撒点
    if (gapC != null && Math.abs(av - gapC) < gapHalf) {
      // 门楣以上还是要有墙
      for (let j = 0; j <= rows; j++) {
        const v = j / rows, y = lerp(y0, y1, v);
        if (y < y0 + DOOR_W * 1.3) continue;
        emitAt(emit, plane, at, av, y, col, density, jitter, sc);
      }
      continue;
    }
    for (let j = 0; j <= rows; j++) {
      const v = j / rows, y = lerp(y0, y1, v);
      // 墙面明暗:靠地脚略深,踢脚线更亮一点,做出体积
      const shade = 0.82 + 0.18 * v + (v < 0.06 ? 0.15 : 0);
      emitAt(emit, plane, at, av, y, scalec(col, shade), density, jitter, sc);
    }
  }
}
function emitAt(emit, plane, at, a, y, col, density, jitter, sc) {
  const jx = (hash(a * 12.9 + y * 78.2) - 0.5) * jitter;
  const jy = (hash(a * 3.7 + y * 51.1) - 0.5) * jitter;
  if (plane === 'x') emit(at + jx, y + jy, a, col[0], col[1], col[2], sc, 0.95);
  else emit(a, y + jy, at + jx, col[0], col[1], col[2], sc, 0.95);
}
function hash(x) { const s = Math.sin(x * 127.1) * 43758.5453; return s - Math.floor(s); }

// 水平面(地板/天花)撒点。
function slab(emit, o) {
  const { x0, x1, z0, z1, y, col, density, sc = 0.03, op = 0.95, jitter = 0.02 } = o;
  const nx = Math.max(2, Math.round(Math.abs(x1 - x0) * 8 * density));
  const nz = Math.max(2, Math.round(Math.abs(z1 - z0) * 8 * density));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    const x = lerp(x0, x1, i / nx), z = lerp(z0, z1, j / nz);
    const jx = (hash(x * 9.1 + z * 4.3) - 0.5) * jitter;
    const jz = (hash(x * 2.7 + z * 8.9) - 0.5) * jitter;
    const t = 0.9 + 0.2 * hash(x * 1.3 + z * 2.1);
    emit(x + jx, y, z + jz, col[0] * t, col[1] * t, col[2] * t, sc, op);
  }
}

// 一个实心光点云球(热点文件 / 灯 / 陈设的"发光体")。
function blob(emit, o) {
  const { x, y, z, r, col, density, op = 1, glow = 1 } = o;
  const n = Math.max(12, Math.round(120 * r * density));
  const p = picker(seedOf(x + '' + y + z));
  for (let i = 0; i < n; i++) {
    const u = p.f(), v = p.f();
    const th = u * Math.PI * 2, ph = Math.acos(2 * v - 1);
    const rr = r * (0.4 + 0.6 * Math.cbrt(p.f()));
    emit(x + rr * Math.sin(ph) * Math.cos(th), y + rr * Math.cos(ph), z + rr * Math.sin(ph) * Math.sin(th),
      col[0] * glow, col[1] * glow, col[2] * glow, 0.03 + r * 0.05, op);
  }
}

// 一个盒子的表面点(家具原语)。
function boxSurf(emit, o) {
  const { cx, cy, cz, w, h, d, col, density, sc = 0.026 } = o;
  const nx = Math.max(2, Math.round(w * 8 * density));
  const ny = Math.max(2, Math.round(h * 8 * density));
  const nz = Math.max(2, Math.round(d * 8 * density));
  const hw = w / 2, hh = h / 2, hd = d / 2;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    const x = cx - hw + w * i / nx, z = cz - hd + d * j / nz;
    emit(x, cy + hh, z, col[0], col[1], col[2], sc, 0.96); // 顶
  }
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const x = cx - hw + w * i / nx, y = cy - hh + h * j / ny;
    emit(x, y, cz - hd, col[0] * 0.85, col[1] * 0.85, col[2] * 0.85, sc, 0.96);
    emit(x, y, cz + hd, col[0] * 0.85, col[1] * 0.85, col[2] * 0.85, sc, 0.96);
  }
  for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    const y = cy - hh + h * j / ny, z = cz - hd + d * k / nz;
    emit(cx - hw, y, z, col[0] * 0.7, col[1] * 0.7, col[2] * 0.7, sc, 0.96);
    emit(cx + hw, y, z, col[0] * 0.7, col[1] * 0.7, col[2] * 0.7, sc, 0.96);
  }
}

/* ── 房间陈设(按 kind)——— 让"内部结构完整反映代码结构"落到看得见的东西上 ── */
function furnishRoom(emit, room, density) {
  const P = picker(room.seed);
  const kc = kindOf(room.kind);
  const { cx, cz, w, d, y0 } = room;
  const accent = mix(kc.accent, room.color, 0.5);
  const bright = 0.5 + room.live * 0.9;

  if (room.kind === 'docs') {
    // 图书室:靠墙一排书架,书脊颜色 = 语言色的深浅变化
    const shelfN = clamp(Math.round(room.files / 4), 2, Math.floor(w / 0.9));
    for (let i = 0; i < shelfN; i++) {
      const x = cx - w / 2 + 0.6 + i * ((w - 1.2) / Math.max(1, shelfN - 1));
      boxSurf(emit, { cx: x, cy: y0 + 0.9, cz: cz - d / 2 + 0.35, w: 0.5, h: 1.8, d: 0.35, col: scalec(room.color, 0.5), density });
      for (let b = 0; b < 6; b++) {
        blob(emit, { x, y: y0 + 0.35 + b * 0.28, z: cz - d / 2 + 0.3, r: 0.09, col: scalec(room.color, 0.7 + P.f() * 0.6), density, glow: 0.8 });
      }
    }
  } else if (room.kind === 'assets') {
    // 画廊:墙上挂发光画框(比例来自 files),中间一座展台
    const artN = clamp(Math.round(room.files / 3), 2, 6);
    for (let i = 0; i < artN; i++) {
      const x = cx - w / 2 + w * (i + 0.5) / artN;
      const hue = [P.f(), P.range(0.4, 1), P.range(0.4, 1)];
      slabPanel(emit, x, y0 + 1.6, cz + d / 2 - 0.12, 0.9, 0.7, mix(accent, hue, 0.6), density);
    }
    boxSurf(emit, { cx, cy: y0 + 0.5, cz, w: 1.2, h: 1.0, d: 1.2, col: scalec(kc.floor, 1.5), density });
    blob(emit, { x: cx, y: y0 + 1.4, z: cz, r: 0.35, col: accent, density, glow: bright, op: 0.9 });
  } else if (room.kind === 'test') {
    // 实验室:成排工作台 + 闪烁指示灯(绿=通过基调)
    const benchN = clamp(Math.round(room.files / 6), 1, 3);
    for (let i = 0; i < benchN; i++) {
      const z = cz - d / 2 + d * (i + 0.7) / (benchN + 0.4);
      boxSurf(emit, { cx, cy: y0 + 0.5, cz: z, w: w * 0.7, h: 0.9, d: 0.5, col: [0.16, 0.2, 0.19], density });
      for (let l = 0; l < 8; l++) {
        const x = cx - w * 0.32 + (w * 0.64) * l / 7;
        blob(emit, { x, y: y0 + 1.05, z, r: 0.05, col: P.odds(0.75) ? [0.3, 1, 0.5] : [1, 0.4, 0.3], density, glow: 1.4 });
      }
    }
  } else if (room.kind === 'config') {
    // 机房:管道 + 控制面板
    for (let i = 0; i < 3; i++) {
      const x = cx - w / 2 + 0.5 + i * 0.6;
      boxSurf(emit, { cx: x, cy: y0 + 1.2, cz: cz - d / 2 + 0.3, w: 0.18, h: 2.4, d: 0.18, col: [0.4, 0.42, 0.46], density });
    }
    boxSurf(emit, { cx, cy: y0 + 0.9, cz, w: 1.6, h: 1.4, d: 0.5, col: [0.2, 0.22, 0.26], density });
    for (let l = 0; l < 10; l++) {
      blob(emit, { x: cx - 0.7 + 1.4 * (l / 9), y: y0 + 1.1 + (l % 2) * 0.3, z: cz + 0.26, r: 0.045, col: accent, density, glow: 1.2 });
    }
  } else {
    // 书房/工坊(source):写字台 + 发光的"显示器"(语言色),外加书架
    boxSurf(emit, { cx, cy: y0 + 0.5, cz, w: Math.min(2.4, w * 0.5), h: 0.9, d: 0.9, col: [0.22, 0.18, 0.15], density });
    slabPanel(emit, cx, y0 + 1.35, cz - 0.35, 1.1, 0.7, scalec(room.color, 1.3 * bright), density, 'z');
    boxSurf(emit, { cx: cx - w / 2 + 0.4, cy: y0 + 1.0, cz: cz, w: 0.4, h: 2.0, d: Math.min(d * 0.6, 2), col: scalec(room.color, 0.45), density });
  }

  // 热点文件 —— 房间中央上方悬浮的发光体,越热越亮越大。
  room.hot.forEach((h, i) => {
    const ang = i / Math.max(1, room.hot.length) * Math.PI * 2 + room.seed % 6;
    const rr = Math.min(w, d) * 0.28;
    const churn = h.churn || 1;
    blob(emit, {
      x: cx + Math.cos(ang) * rr, y: y0 + 2.1, z: cz + Math.sin(ang) * rr,
      r: clamp(0.12 + Math.log2(1 + churn) * 0.03, 0.12, 0.4),
      col: mix(accent, [1, 1, 0.85], 0.4), density, glow: 1.2 + clamp(churn / 40, 0, 1), op: 0.9,
    });
  });

  // 顶灯:暖度来自 liveness。
  blob(emit, { x: cx, y: y0 + WALL_H - 0.25, z: cz, r: 0.22,
    col: mix([0.6, 0.72, 1.0], [1.0, 0.82, 0.55], kc.warm + room.live * 0.4), density, glow: 0.8 + room.live, op: 0.85 });
}

// 一面发光的薄板(画/屏),plane 默认贴 z 墙(法向 z)。
function slabPanel(emit, x, y, z, w, h, col, density, plane = 'z') {
  const nx = Math.max(3, Math.round(w * 12 * density)), ny = Math.max(3, Math.round(h * 12 * density));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const a = -w / 2 + w * i / nx, b = -h / 2 + h * j / ny;
    const edge = (Math.abs(a) > w / 2 - 0.08 || Math.abs(b) > h / 2 - 0.08) ? 0.4 : 1;
    if (plane === 'z') emit(x + a, y + b, z, col[0] * edge, col[1] * edge, col[2] * edge, 0.02, 0.98);
    else emit(x, y + b, z + a, col[0] * edge, col[1] * edge, col[2] * edge, 0.02, 0.98);
  }
}

/* ── 室内整体 ──────────────────────────────────────────────────────────── */
export function paintInterior(model, emit, opts = {}) {
  const density = opts.density ?? 1;
  const { rooms, corridor, bounds } = model;

  // 走廊:一条沿 +Z 的地毯 + 顶灯串
  for (let f = 0; f < bounds.floors; f++) {
    const y0 = f * bounds.floorH;
    slab(emit, { x0: -corridor.w / 2, x1: corridor.w / 2, z0: -1.0, z1: corridor.len + 1.5, y: y0 + 0.02,
      col: [0.30, 0.29, 0.35], density, sc: 0.032 });
    slab(emit, { x0: -corridor.w / 2, x1: corridor.w / 2, z0: -1.0, z1: corridor.len + 1.5, y: y0 + bounds.wallH - 0.05,
      col: [0.2, 0.2, 0.24], density: density * 0.6, sc: 0.03, op: 0.7 });
    const lamps = Math.max(2, Math.round(corridor.len / 3));
    for (let i = 0; i < lamps; i++) {
      blob(emit, { x: 0, y: y0 + bounds.wallH - 0.2, z: 0.5 + corridor.len * i / (lamps - 1 || 1), r: 0.16, col: [1, 0.94, 0.78], density, glow: 1.6, op: 0.95 });
    }
  }
  // 门厅标识:一块发光地徽
  slab(emit, { x0: -1.2, x1: 1.2, z0: model.foyer.z - 1.2, z1: model.foyer.z + 1.2, y: 0.05,
    col: scalec(model.domColor, 1.2), density: density * 1.2, sc: 0.03, op: 0.9 });

  // 每个房间
  for (const room of rooms) {
    const { cx, cz, w, d, y0, side } = room;
    const kc = kindOf(room.kind);
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    // 地板(kind 色,叠一点语言色),踢脚发光
    slab(emit, { x0, x1, z0, z1, y: y0 + 0.02, col: mix(kc.floor, room.color, 0.15 + room.live * 0.1), density });
    // 天花(暗)
    slab(emit, { x0, x1, z0, z1, y: y0 + WALL_H - 0.03, col: scalec(kc.floor, 0.6), density: density * 0.55, sc: 0.03, op: 0.7 });
    // 四面墙。朝走廊那面(内侧)开门。
    const innerX = side < 0 ? x1 : x0; // 靠走廊的一面
    const wallCol = mix([0.42, 0.42, 0.47], room.color, 0.26);
    const litCol = mix(wallCol, kc.accent, 0.18 + room.live * 0.28);
    // 前后墙(法向 z)
    wall(emit, { plane: 'z', at: z0, a0: x0, a1: x1, y0, y1: y0 + WALL_H, col: litCol, density });
    wall(emit, { plane: 'z', at: z1, a0: x0, a1: x1, y0, y1: y0 + WALL_H, col: wallCol, density });
    // 左右墙(法向 x);靠走廊那面开门洞对着房间中心 cz
    wall(emit, { plane: 'x', at: innerX, a0: z0, a1: z1, y0, y1: y0 + WALL_H, col: litCol, density, gapC: cz, gapHalf: DOOR_W / 2 });
    wall(emit, { plane: 'x', at: side < 0 ? x0 : x1, a0: z0, a1: z1, y0, y1: y0 + WALL_H, col: wallCol, density });
    // 陈设
    furnishRoom(emit, room, density);
  }
  return model;
}

/* ── 别墅外壳(先看外观用)——— 外墙、坡屋顶、亮着的窗、正门 ── */
export function paintExterior(model, emit, opts = {}) {
  const density = opts.density ?? 0.8;
  const { bounds, domColor, rooms } = model;
  const { x0, x1, z0, z1 } = bounds;
  const totalH = bounds.floors * bounds.floorH;
  const wallCol = mix([0.26, 0.25, 0.28], domColor, 0.25);
  // 四面外墙
  wall(emit, { plane: 'z', at: z0, a0: x0, a1: x1, y0: 0, y1: totalH, col: wallCol, density, gapC: model.entrance.x, gapHalf: 1.2 });
  wall(emit, { plane: 'z', at: z1, a0: x0, a1: x1, y0: 0, y1: totalH, col: scalec(wallCol, 0.9), density });
  wall(emit, { plane: 'x', at: x0, a0: z0, a1: z1, y0: 0, y1: totalH, col: scalec(wallCol, 0.95), density });
  wall(emit, { plane: 'x', at: x1, a0: z0, a1: z1, y0: 0, y1: totalH, col: scalec(wallCol, 0.95), density });
  // 地基/前庭
  slab(emit, { x0: x0 - 2, x1: x1 + 2, z0: z0 - 4, z1: z1 + 1, y: -0.02, col: [0.1, 0.12, 0.11], density: density * 0.5, sc: 0.05, op: 0.9 });
  // 坡屋顶(两坡),颜色 = 主语言
  const roofCol = scalec(domColor, 0.8);
  const ridge = totalH + Math.min(2.4, (x1 - x0) * 0.18);
  const nx = Math.max(4, Math.round((x1 - x0) * 6 * density));
  const nz = Math.max(4, Math.round((z1 - z0) * 6 * density));
  for (let i = 0; i <= nx; i++) {
    const u = i / nx, x = lerp(x0, x1, u);
    const y = lerp(totalH, ridge, 1 - Math.abs(u - 0.5) * 2);
    for (let j = 0; j <= nz; j++) {
      const z = lerp(z0, z1, j / nz);
      emit(x, y, z, roofCol[0], roofCol[1], roofCol[2], 0.04, 0.97);
    }
  }
  // 亮着的窗:每个房间在外墙对应位置开一扇,亮度 = liveness
  for (const room of rooms) {
    const onOuter = Math.abs((room.side < 0 ? room.cx - room.w / 2 : room.cx + room.w / 2)) ;
    const wx = room.side < 0 ? x0 + 0.06 : x1 - 0.06;
    slabPanel(emit, room.cx, room.y0 + 1.6, room.side < 0 ? x0 : x1, 1.0, 1.1,
      scalec(mix([0.2, 0.25, 0.35], [1, 0.85, 0.55], room.live), 0.6 + room.live), density, room.side ? 'x' : 'x');
  }
  // 正门:发光门框
  slabPanel(emit, model.entrance.x, 1.3, z0, 1.6, 2.2, scalec(domColor, 1.2), density, 'z');
  return model;
}
