/**
 * room-interior.js — 走进一座楼之后的**室内文法**。
 *
 * city-styles.js 管的是外面:一栋楼被拆成台基 × 楼身 × 外皮 × 楼冠 × 附件,风格
 * 决定每个槽位能用哪些件,种子从目录名算。这个文件是同一件事的**里面**:
 *
 *     地面 floor × 墙面 wall × 顶 ceiling × 灯具 light × 柱式 column × 陈列 display
 *
 * 为什么不是"一个风格一间样板房":那样同一个项目里四个目录会长得一模一样,只是
 * 大小不同 —— 那不叫装修,那叫复制粘贴。槽位一拆,persia 一个风格就能拼出几十种
 * 不重样的厅堂,而每一间仍然一眼看得出是波斯。
 *
 * ⚠ 三条规矩,和外面那套是同一条:
 *
 *   一,**风格跟着楼走**。走进一座蓝釉洋葱穹顶的楼,里面不能是北欧木构。风格 id
 *     直接取胶囊里那个,`styleOf` 兜底不认识的值。
 *   二,**种子取自目录名**,而且用的是 city-styles 导出的同一个 `seedOf` ——
 *     同一个目录每次进去必须是同一间屋子。各写一份哈希就会各自漂移。
 *   三,**颜色分两层**:房子的颜色来自风格调色板(砂岩、朱红、蓝釉),文件的颜色
 *     来自它的语言。前者是外观,后者是数据 —— 混在一起,颜色就不再说明任何事。
 */

import { styleOf, seedOf, picker } from './city-styles.js';

/* ── 每个风格能用哪些件 ──────────────────────────────────────────────────────
   词汇表的差别就是风格的差别:唐宋拿得到斗拱和格栅,古希腊只拿得到凹槽柱和藻井,
   两边都拿不到对方的件。 */
export const INTERIOR = {
  modern: { floor: ['slab', 'grid'],      wall: ['fin', 'glass'],      ceil: ['flat', 'coffer'],   light: ['strip', 'chandelier'], col: ['plain', 'none'], disp: ['plinth', 'pillar'] },
  tang:   { floor: ['board', 'rosette'],  wall: ['lattice', 'timber'], ceil: ['beam', 'coffer'],   light: ['lantern'],             col: ['dougong'],       disp: ['pillar', 'shelf'] },
  edo:    { floor: ['tatami', 'board'],   wall: ['lattice', 'timber'], ceil: ['beam', 'flat'],     light: ['lantern', 'candle'],   col: ['plain'],         disp: ['plinth', 'shelf'] },
  giza:   { floor: ['band', 'slab'],      wall: ['glyph', 'fin'],      ceil: ['flat', 'corbel'],   light: ['brazier', 'oculus'],   col: ['lotus'],         disp: ['pillar', 'niche'] },
  hellas: { floor: ['mosaic', 'slab'],    wall: ['fin', 'glyph'],      ceil: ['dome', 'coffer'],   light: ['oculus', 'brazier'],   col: ['fluted'],        disp: ['plinth', 'pillar'] },
  maya:   { floor: ['band', 'mosaic'],    wall: ['glyph', 'fin'],      ceil: ['corbel', 'flat'],   light: ['brazier'],             col: ['plain', 'none'], disp: ['pillar', 'niche'] },
  persia: { floor: ['mosaic', 'rosette'], wall: ['mosaic', 'lattice'], ceil: ['onion', 'dome'],    light: ['chandelier', 'lantern'], col: ['slender'],     disp: ['niche', 'pillar'] },
  norse:  { floor: ['board'],             wall: ['timber', 'lattice'], ceil: ['beam', 'corbel'],   light: ['candle', 'brazier'],   col: ['stave'],         disp: ['shelf', 'pillar'] },
};
const FALLBACK = INTERIOR.modern;

/* ── 小工具 ── */
const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const mix = (a, b, t) => [cl(a[0] + (b[0] - a[0]) * t), cl(a[1] + (b[1] - a[1]) * t), cl(a[2] + (b[2] - a[2]) * t)];
/** 调色板里的颜色是**漆**,加色混合里要当**光**用,不提亮就一片灰。 */
export function asLight(rgb, k = 0.95) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
  return [cl(rgb[0] / mx * k), cl(rgb[1] / mx * k), cl(rgb[2] / mx * k)];
}

/**
 * 这个目录该装成什么样。纯函数,同样的入参永远同样的结果。
 * @param {string} styleId  胶囊里的风格 id(外面那座城市用的同一个)
 * @param {string} dirName  目录名 —— 种子
 */
export function interiorOf(styleId, dirName) {
  const style = styleOf(styleId);
  const voc = INTERIOR[style.id] || FALLBACK;
  // 加一个盐:同一个目录的"外形"和"装修"不该被同一串随机数绑在一起。
  const p = picker(seedOf('interior:' + dirName + '@' + style.id));
  return {
    style,
    pal: style.pal,
    floor: p.of(voc.floor), wall: p.of(voc.wall), ceil: p.of(voc.ceil),
    light: p.of(voc.light), col: p.of(voc.col), disp: p.of(voc.disp),
    // 一间屋子自己的两个小变量:纹样的疏密、柱子的根数。
    grain: p.int(6, 14), bays: p.int(2, 4), rnd: p,
  };
}

/** 这套文法一共能拼出多少间不重样的屋子 —— 和 styleVariants 是同一个意思。 */
export function interiorVariants() {
  let n = 0;
  for (const v of Object.values(INTERIOR)) n += v.floor.length * v.wall.length * v.ceil.length * v.light.length * v.col.length * v.disp.length;
  return n;
}

/* ══ 地面 ══════════════════════════════════════════════════════════════════ */
export const FLOOR = {
  /** 放射拼花。厅堂的地面得有个中心,人会朝它走。 */
  rosette(o, e) {
    const { cx, cz, R, r, n, rnd, c1, c2 } = o;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * R * 1.2;
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
      if (!inside(r, x, z)) continue;
      const k = (Math.abs(Math.cos(a * o.grain)) * 0.5 + 0.5) * (Math.abs(Math.sin(rad * 2.6)) * 0.45 + 0.55);
      if (rnd() > k * 0.85 + 0.12) continue;
      e(x, lowY(rnd), z, mix(mix(c1, c2, k * 0.6), [0.02, 0.03, 0.05], 1 - k * 0.8), 0.5 + k * 0.85, 0.22);
    }
  },
  /** 方格石板。缝亮、面暗 —— 现代和古希腊的地。 */
  slab(o, e) {
    const { r, n, rnd, c1, c2 } = o, g = 1.6;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const fx = Math.abs(((x / g) % 1 + 1) % 1 - 0.5), fz = Math.abs(((z / g) % 1 + 1) % 1 - 0.5);
      const seam = Math.max(fx, fz) > 0.44;
      if (!seam && rnd() > 0.30) continue;
      e(x, lowY(rnd), z, seam ? c2 : mix(c1, [0.02, 0.03, 0.05], 0.55), seam ? 0.95 : 0.5, seam ? 0.35 : 0.18);
    }
  },
  /** 细密马赛克。波斯和古希腊的地,颜色在两色之间跳。 */
  mosaic(o, e) {
    const { r, n, rnd, c1, c2, grain } = o, g = 0.42;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const ix = Math.floor(x / g), iz = Math.floor(z / g);
      const h = ((Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) >>> 0) / 4294967296;
      const star = Math.abs(Math.sin((ix + iz) * 0.7)) * 0.5 + Math.abs(Math.cos((ix - iz) * 0.5)) * 0.5;
      if (rnd() > 0.24 + star * 0.5) continue;
      e(x, lowY(rnd), z, mix(c1, c2, h > 0.5 ? 0.85 : 0.12), 0.55 + star * 0.5, 0.25);
    }
  },
  /** 木地板长条。唐宋、江户、北欧。 */
  board(o, e) {
    const { r, n, rnd, c1, c2 } = o, w = 0.55;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const f = Math.abs(((z / w) % 1 + 1) % 1 - 0.5);
      if (f > 0.42) { e(x, lowY(rnd), z, c2, 0.8, 0.3); continue; }   // 板缝
      if (rnd() > 0.34) continue;
      e(x, lowY(rnd), z, mix(c1, [0.03, 0.02, 0.02], 0.5 + f * 0.6), 0.55, 0.15);
    }
  },
  /** 席纹:方格,每格纹理转 90°。江户。 */
  tatami(o, e) {
    const { r, n, rnd, c1, c2 } = o, g = 1.9;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const ix = Math.floor(x / g), iz = Math.floor(z / g);
      const fx = Math.abs(((x / g) % 1 + 1) % 1 - 0.5), fz = Math.abs(((z / g) % 1 + 1) % 1 - 0.5);
      if (Math.max(fx, fz) > 0.45) { e(x, lowY(rnd), z, c2, 0.9, 0.35); continue; }   // 席边
      const along = (ix + iz) % 2 ? x : z;
      if (Math.abs(((along / 0.1) % 1 + 1) % 1 - 0.5) > 0.35 && rnd() < 0.5) continue;
      if (rnd() > 0.28) continue;
      e(x, lowY(rnd), z, mix(c1, [0.03, 0.03, 0.02], 0.55), 0.5, 0.12);
    }
  },
  /** 横向条带。砂岩和玛雅 —— 地是一层层铺过去的。 */
  band(o, e) {
    const { r, n, rnd, c1, c2 } = o;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const b = Math.abs(Math.sin(z * 1.5));
      if (rnd() > 0.2 + b * 0.55) continue;
      e(x, lowY(rnd), z, mix(mix(c1, c2, b * 0.7), [0.03, 0.03, 0.04], 0.45), 0.55 + b * 0.5, 0.2);
    }
  },
  /** 发光网格。现代。 */
  grid(o, e) {
    const { r, n, rnd, c1, c2 } = o, g = 1.15;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const fx = Math.abs(((x / g) % 1 + 1) % 1 - 0.5), fz = Math.abs(((z / g) % 1 + 1) % 1 - 0.5);
      const line = Math.max(fx, fz) > 0.46;
      if (!line && rnd() > 0.12) continue;
      e(x, lowY(rnd), z, line ? c2 : mix(c1, [0.02, 0.02, 0.04], 0.7), line ? 0.85 : 0.42, line ? 0.45 : 0.15);
    }
  },
};
const lowY = (rnd) => 0.01 + rnd() * 0.015;
const inside = (r, x, z) => x > r.x0 + 0.1 && x < r.x1 - 0.1 && z > r.z0 + 0.1 && z < r.z1 - 0.1;

/* ══ 墙面 ══════════════════════════════════════════════════════════════════ */
export const WALL = {
  /** 竖向壁柱/凹槽。最通用的一件,现代到古希腊都在用。 */
  fin(o, e) { curtain(o, e, (u, yt) => Math.pow(Math.abs(Math.cos(u * 1.15)), 8) * 0.75 + (1 - yt) * 0.28 + 0.2); },
  /** 木格栅:横竖都有线。唐宋、江户。 */
  lattice(o, e) {
    curtain(o, e, (u, yt, y) => {
      const v = Math.pow(Math.abs(Math.cos(u * 2.2)), 6), h = Math.pow(Math.abs(Math.cos(y * 3.1)), 6);
      return Math.max(v, h) * 0.8 + 0.14;
    });
  },
  /** 拼花砖:细密的方格,亮度按格跳。波斯。 */
  mosaic(o, e) {
    curtain(o, e, (u, yt, y) => {
      const iu = Math.floor(u * 3.2), iy = Math.floor(y * 3.2);
      const h = ((Math.imul(iu, 374761393) ^ Math.imul(iy, 668265263)) >>> 0) / 4294967296;
      return (h > 0.55 ? 0.8 : 0.22) + (1 - yt) * 0.12;
    }, 0.55);
  },
  /** 横向浮雕带/文字带。古埃及、玛雅、古希腊的檐壁。 */
  glyph(o, e) {
    curtain(o, e, (u, yt, y) => {
      const band = Math.pow(Math.abs(Math.sin(y * 2.4)), 10);
      const mark = Math.pow(Math.abs(Math.sin(u * 7.0)), 3);
      return band * (0.35 + mark * 0.6) + 0.16;
    }, 0.5);
  },
  /** 木板:竖向密板。北欧、江户。 */
  timber(o, e) { curtain(o, e, (u, yt) => (Math.abs(((u / 0.42) % 1 + 1) % 1 - 0.5) > 0.4 ? 0.85 : 0.2) + (1 - yt) * 0.18); },
  /** 玻璃幕墙:横向楼层线 + 冷光。现代。 */
  glass(o, e) {
    curtain(o, e, (u, yt, y) => (Math.abs(((y / 0.85) % 1 + 1) % 1 - 0.5) > 0.42 ? 0.9 : 0.16) + (1 - yt) * 0.1, 0.35);
  },
};

/** 墙的公共部分:一面光帘,密度由 `f(u, yt, y)` 决定,门洞处留空。 */
function curtain(o, e, f, goldMix = 0.5) {
  const { x0, z0, x1, z1, h, n, rnd, c1, c2, gap } = o;
  const horiz = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const len = horiz ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  for (let i = 0; i < n; i++) {
    const u = rnd() * len;
    const px = horiz ? Math.min(x0, x1) + u : x0;
    const pz = horiz ? z0 : Math.min(z0, z1) + u;
    if (gap && px > gap.x0 && px < gap.x1 && pz > gap.z0 && pz < gap.z1) continue;
    const yt = Math.pow(rnd(), 1.5), y = yt * h;
    const k = f(u, yt, y);
    if (rnd() > k) continue;
    const c = mix(mix([0.09, 0.11, 0.16], c1, 0.5 + (1 - yt) * 0.35), c2, Math.min(1, k) * goldMix);
    e(px + (horiz ? 0 : (rnd() - 0.5) * 0.12), y, pz + (horiz ? (rnd() - 0.5) * 0.12 : 0), c, 0.7 + k * 1.1, 0.35);
    if (rnd() < 0.045) e(px, h - 0.06 + rnd() * 0.12, pz, c2, 1.3, 0.6);       // 檐口
  }
}

/* ══ 顶 ════════════════════════════════════════════════════════════════════ */
export const CEIL = {
  /** 半球穹顶 + 肋。古希腊、波斯。 */
  dome(o, e) { domeLike(o, e, (phi) => Math.cos(phi), (phi) => Math.sin(phi)); },
  /** 洋葱穹顶:腰部鼓出去,顶上收成尖。波斯就靠这个被认出来。 */
  onion(o, e) {
    domeLike(o, e, (phi) => Math.cos(phi) * (1 + Math.sin(phi * 2) * 0.32), (phi) => Math.sin(phi) * 1.12 + Math.pow(Math.sin(phi), 8) * 0.3);
  },
  /** 藻井:一格一格凹进去的方顶。唐宋、古希腊、现代。 */
  coffer(o, e) {
    const { cx, cz, r, y, n, rnd, c1, c2, grain } = o, g = 1.5;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const fx = Math.abs(((x / g) % 1 + 1) % 1 - 0.5), fz = Math.abs(((z / g) % 1 + 1) % 1 - 0.5);
      const rib = Math.max(fx, fz) > 0.42;
      const d = Math.max(fx, fz);
      if (!rib && rnd() > 0.2) continue;
      e(x, y - (rib ? 0 : (0.5 - d) * 0.5), z, rib ? c2 : mix(c1, [0.03, 0.04, 0.06], 0.5), rib ? 1.0 : 0.55, rib ? 0.4 : 0.2);
    }
  },
  /** 梁架:一根根横梁 + 檩。唐宋、江户、北欧。 */
  beam(o, e) {
    const { r, y, n, rnd, c1, c2 } = o, g = 1.25;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const f = Math.abs(((z / g) % 1 + 1) % 1 - 0.5);
      if (f > 0.40) { e(x, y - 0.12 + rnd() * 0.1, z, c2, 1.15, 0.35); continue; }   // 梁
      if (Math.abs(((x / 2.6) % 1 + 1) % 1 - 0.5) > 0.44) { e(x, y - 0.02, z, mix(c1, c2, 0.5), 0.95, 0.3); continue; }
      if (rnd() > 0.10) continue;
      e(x, y, z, mix(c1, [0.03, 0.03, 0.04], 0.6), 0.5, 0.15);
    }
  },
  /** 叠涩:一层层往里收的假拱。玛雅、古埃及、北欧。 */
  corbel(o, e) {
    const { cx, cz, r, y, n, rnd, c1, c2 } = o;
    const W = (r.x1 - r.x0) / 2, D = (r.z1 - r.z0) / 2, steps = 5;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(rnd() * steps), t = s / steps;
      const w = W * (1 - t * 0.82), d = D * (1 - t * 0.82);
      const yy = y - (1 - t) * 0.9;
      const onX = rnd() < 0.5;
      const x = onX ? cx + (rnd() - 0.5) * 2 * w : cx + (rnd() < 0.5 ? -w : w);
      const z = onX ? cz + (rnd() < 0.5 ? -d : d) : cz + (rnd() - 0.5) * 2 * d;
      e(x, yy, z, mix(c1, c2, t * 0.7), 0.8 + t * 0.9, 0.3);
    }
  },
  /** 平顶 + 一点点结构线。现代、古埃及、玛雅。 */
  flat(o, e) {
    const { r, y, n, rnd, c1, c2 } = o;
    for (let i = 0; i < n; i++) {
      const x = r.x0 + rnd() * (r.x1 - r.x0), z = r.z0 + rnd() * (r.z1 - r.z0);
      const line = Math.abs(((x / 3.2) % 1 + 1) % 1 - 0.5) > 0.45;
      if (!line && rnd() > 0.13) continue;
      e(x, y - rnd() * 0.05, z, line ? c2 : mix(c1, [0.03, 0.04, 0.06], 0.62), line ? 0.9 : 0.45, line ? 0.35 : 0.15);
    }
  },
};

function domeLike(o, e, radAt, yAt) {
  const { cx, cz, R, y, hgt, n, rnd, c1, c2, grain } = o;
  const ribs = Math.max(8, grain);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, phi = Math.pow(rnd(), 0.72) * Math.PI / 2;
    const rad = radAt(phi) * R, yy = y + yAt(phi) * hgt;
    const rib = Math.pow(Math.abs(Math.cos(a * ribs / 2)), 10);
    if (rnd() > 0.16 + rib * 0.8 + Math.sin(phi) * 0.3) continue;
    e(cx + Math.cos(a) * rad, yy, cz + Math.sin(a) * rad,
      mix(mix(c1, [0.14, 0.18, 0.28], 0.42), c2, rib * 0.7 + Math.sin(phi) * 0.28), 0.9 + rib * 1.9, 0.5);
  }
  for (let i = 0; i < n * 0.02; i++) {                       // 顶心
    const a = rnd() * Math.PI * 2, rad = rnd() * 0.5;
    e(cx + Math.cos(a) * rad, y + yAt(Math.PI / 2) * hgt - 0.05, cz + Math.sin(a) * rad, c2, 2.0, 0.85);
  }
}

/* ══ 灯具 ══════════════════════════════════════════════════════════════════ */
export const LIGHT = {
  /** 多层水晶吊灯。波斯、现代。 */
  chandelier(o, e) {
    const { cx, cy, cz, n, rnd, c1, c2 } = o, tiers = 4;
    for (let i = 0; i < n; i++) {
      const t = Math.floor(rnd() * tiers) / (tiers - 1);
      const R = 0.5 + (1 - t) * 1.5, a = rnd() * Math.PI * 2;
      const bead = Math.pow(Math.abs(Math.sin(a * 14)), 6);
      if (rnd() > 0.22 + bead * 0.8) continue;
      e(cx + Math.cos(a) * R, cy - t * 1.5 - rnd() * 0.12, cz + Math.sin(a) * R, mix(c2, mix(c1, [1, 1, 1], 0.4), rnd() * 0.5), 1.25 + bead * 2.1, 1.0);
    }
    chain(o, e);
  },
  /** 宫灯:几盏方灯垂下来。唐宋、江户、波斯。 */
  lantern(o, e) {
    const { cx, cy, cz, n, rnd, c1, c2 } = o;
    const lamps = 4, R = 1.5;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * lamps), a = (k / lamps) * Math.PI * 2 + 0.4;
      const lx = cx + Math.cos(a) * R, lz = cz + Math.sin(a) * R;
      const u = rnd();
      if (u < 0.16) { e(lx + (rnd() - 0.5) * 0.04, cy + rnd() * 0.9, lz + (rnd() - 0.5) * 0.04, c2, 1.0, 0.5); continue; }  // 吊绳
      // 灯身:一个小方笼,边亮
      const sx = (rnd() - 0.5), sy = (rnd() - 0.5), sz = (rnd() - 0.5);
      const edge = (Math.abs(sx) > 0.42) + (Math.abs(sy) > 0.42) + (Math.abs(sz) > 0.42) >= 2;
      if (!edge && rnd() > 0.5) continue;
      e(lx + sx * 0.5, cy - 0.35 + sy * 0.62, lz + sz * 0.5, edge ? c2 : mix(c1, [1, 0.92, 0.7], 0.65), edge ? 1.3 : 1.7, edge ? 0.5 : 1.0);
    }
  },
  /** 火盆:地上的一圈火。古埃及、玛雅、北欧。 */
  brazier(o, e) {
    const { cx, cz, n, rnd, c1, c2, r } = o;
    const spots = 4;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * spots), a = (k / spots) * Math.PI * 2 + 0.7;
      const R = Math.min(r.x1 - r.x0, r.z1 - r.z0) * 0.32;
      const bx = cx + Math.cos(a) * R, bz = cz + Math.sin(a) * R;
      const u = rnd();
      if (u < 0.42) {                                   // 火焰
        const t = rnd();
        const rad = 0.28 * (1 - t) * (0.6 + rnd() * 0.8);
        const aa = rnd() * Math.PI * 2;
        e(bx + Math.cos(aa) * rad, 0.95 + t * 1.0, bz + Math.sin(aa) * rad, mix([1, 0.72, 0.28], [1, 0.95, 0.72], 1 - t), 1.5 + (1 - t) * 1.4, 1.0);
      } else if (u < 0.72) {                            // 盆
        const aa = rnd() * Math.PI * 2;
        e(bx + Math.cos(aa) * 0.36, 0.75 + rnd() * 0.16, bz + Math.sin(aa) * 0.36, c2, 1.2, 0.3);
      } else {                                          // 柱脚
        const aa = rnd() * Math.PI * 2;
        e(bx + Math.cos(aa) * 0.1, rnd() * 0.75, bz + Math.sin(aa) * 0.1, mix(c1, c2, 0.4), 0.9, 0.2);
      }
    }
  },
  /** 顶心采光:一道从天而降的光轴。古希腊、古埃及。 */
  oculus(o, e) {
    const { cx, cy, cz, n, rnd, c2 } = o;
    for (let i = 0; i < n; i++) {
      const t = rnd();                                  // 0 = 顶, 1 = 地
      const rad = (0.42 + t * 1.5) * (0.35 + rnd() * 0.75);
      const a = rnd() * Math.PI * 2;
      const y = cy + 0.6 - t * (cy + 0.5);
      if (rnd() > 1 - t * 0.55) continue;               // 越往下越稀
      e(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad, mix(c2, [1, 0.97, 0.88], 0.45 * (1 - t)), 0.9 + (1 - t) * 1.5, 0.75);
    }
  },
  /** 烛台:一圈小火苗。北欧、江户。 */
  candle(o, e) {
    const { cx, cy, cz, n, rnd, c1, c2 } = o;
    const R = 1.35, k = 12;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * k), a = (j / k) * Math.PI * 2;
      const lx = cx + Math.cos(a) * R, lz = cz + Math.sin(a) * R;
      const u = rnd();
      if (u < 0.3) e(lx + (rnd() - 0.5) * 0.05, cy - 0.15 + rnd() * 0.22, lz + (rnd() - 0.5) * 0.05, mix([1, 0.85, 0.5], [1, 0.97, 0.8], rnd()), 1.7, 1.0);
      else if (u < 0.55) e(lx + (rnd() - 0.5) * 0.06, cy - 0.45 + rnd() * 0.3, lz + (rnd() - 0.5) * 0.06, c2, 1.0, 0.25);   // 蜡
      else {                                            // 铁圈
        const aa = rnd() * Math.PI * 2;
        e(cx + Math.cos(aa) * R, cy - 0.5, cz + Math.sin(aa) * R, mix(c1, c2, 0.5), 0.85, 0.2);
      }
    }
    chain(o, e);
  },
  /** 一道灯带。现代。 */
  strip(o, e) {
    const { cx, cz, r, cy, n, rnd, c2 } = o;
    const L = (r.x1 - r.x0) * 0.55;
    for (let i = 0; i < n; i++) {
      const u = (rnd() - 0.5) * L;
      e(cx + u, cy + 0.35 + (rnd() - 0.5) * 0.04, cz + (rnd() - 0.5) * 0.14, mix(c2, [1, 1, 1], 0.5), 1.5, 0.55);
    }
  },
};
function chain(o, e) {
  const { cx, cy, cz, n, rnd, c2 } = o;
  for (let i = 0; i < n * 0.024; i++) e(cx + (rnd() - 0.5) * 0.06, cy + rnd() * 1.4, cz + (rnd() - 0.5) * 0.06, c2, 1.1, 0.7);
}

/* ══ 柱式 ══════════════════════════════════════════════════════════════════ */
export const COL = {
  /** 凹槽柱:古希腊的那根。 */
  fluted(o, e) { shaft(o, e, { R: 0.30, flutes: 12, cap: 'flare', baseK: 1.45 }); },
  /** 莲花柱:柱头张开成花。古埃及。 */
  lotus(o, e) { shaft(o, e, { R: 0.34, flutes: 8, cap: 'lotus', baseK: 1.25 }); },
  /** 斗拱:柱头层层挑出。唐宋。 */
  dougong(o, e) { shaft(o, e, { R: 0.26, flutes: 0, cap: 'bracket', baseK: 1.2 }); },
  /** 北欧木柱:粗、直、柱头有雕。 */
  stave(o, e) { shaft(o, e, { R: 0.28, flutes: 4, cap: 'knot', baseK: 1.1 }); },
  /** 波斯细柱:很细,柱头小。 */
  slender(o, e) { shaft(o, e, { R: 0.17, flutes: 16, cap: 'flare', baseK: 1.6 }); },
  /** 方柱:现代、玛雅、江户。 */
  plain(o, e) { shaft(o, e, { R: 0.26, flutes: 0, cap: 'none', baseK: 1.15, square: true }); },
  none() {},
};

function shaft(o, e, k) {
  const { x, z, h, n, rnd, c1, c2 } = o;
  for (let i = 0; i < n; i++) {
    const yt = rnd(), y = yt * h, a = rnd() * Math.PI * 2;
    const flute = k.flutes ? 0.5 + 0.5 * Math.cos(a * k.flutes) : 0.7;
    let rad = k.R * (0.92 + flute * 0.1), c = mix([0.13, 0.16, 0.22], c1, 0.35 + flute * 0.3), sz = 1.0 + flute * 0.85;
    if (yt > 0.92) {
      const t = (yt - 0.92) / 0.08;
      if (k.cap === 'flare')        { rad = k.R * (1.4 + t * 1.5); c = c2; sz = 1.5; }
      else if (k.cap === 'lotus')   { rad = k.R * (1.1 + Math.pow(t, 0.55) * 2.2); c = mix(c2, [1, 0.9, 0.55], t); sz = 1.6; }
      else if (k.cap === 'bracket') { rad = k.R * (1.0 + Math.floor(t * 3) * 0.85); c = c2; sz = 1.5; }   // 斗拱:三层
      else if (k.cap === 'knot')    { rad = k.R * (1.25 + Math.abs(Math.sin(a * 5)) * 0.6); c = c2; sz = 1.4; }
      else                          { rad = k.R * 1.2; c = mix(c1, c2, 0.6); sz = 1.2; }
    } else if (yt < 0.05) { rad = k.R * (k.baseK - yt * 4); c = mix(c2, c1, 0.5); sz = 1.2; }
    if (k.square) {
      const s = rnd() < 0.5 ? -1 : 1;
      const on = rnd() < 0.5;
      e(x + (on ? s * rad : (rnd() - 0.5) * 2 * rad), y, z + (on ? (rnd() - 0.5) * 2 * rad : s * rad), c, sz, 0.3);
    } else {
      e(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad, c, sz, 0.3);
    }
  }
}

/* ══ 文件怎么陈列 ══════════════════════════════════════════════════════════
   一个文件就是一件展品。高度永远是它的字节数 —— 变的只有它被怎么摆出来。 */
export const DISP = {
  /** 光柱:一根发光的柱子 + 绕着它的环。 */
  pillar(o, e) {
    const { x, z, h, n, rnd, lang, c2 } = o, R = 0.17;
    for (let i = 0; i < n; i++) {
      const u = rnd();
      if (u < 0.62) {
        const y = rnd() * h, a = rnd() * Math.PI * 2;
        e(x + Math.cos(a) * R * (0.7 + rnd() * 0.4), y, z + Math.sin(a) * R * (0.7 + rnd() * 0.4), mix(lang, [1, 1, 1], Math.pow(y / h, 2) * 0.55), 1.0 + (y / h) * 1.1, 0.5);
      } else if (u < 0.86) {
        const ring = Math.floor(rnd() * 3), a = rnd() * Math.PI * 2, rr = 0.34 + ring * 0.05;
        e(x + Math.cos(a) * rr, h * (0.35 + ring * 0.26), z + Math.sin(a) * rr, mix(lang, c2, 0.45), 1.2, 0.9);
      } else {
        const a = rnd() * Math.PI * 2, rr = rnd() * 0.2;
        e(x + Math.cos(a) * rr, h + rnd() * 0.3, z + Math.sin(a) * rr, mix(lang, [1, 1, 1], 0.6), 1.55, 1.0);
      }
    }
    footing(o, e);
  },
  /** 基座 + 悬在上面的一块。现代、古希腊、江户。 */
  plinth(o, e) {
    const { x, z, h, n, rnd, lang, c1, c2 } = o;
    const pedH = Math.min(1.0, 0.35 + h * 0.22);
    for (let i = 0; i < n; i++) {
      const u = rnd();
      if (u < 0.42) {                                   // 台座:方的
        const s = rnd() < 0.5 ? -1 : 1, on = rnd() < 0.5, rad = 0.34;
        e(x + (on ? s * rad : (rnd() - 0.5) * 2 * rad), rnd() * pedH, z + (on ? (rnd() - 0.5) * 2 * rad : s * rad), mix(c1, c2, 0.35), 0.95, 0.22);
      } else {                                          // 悬着的那件:上下窄、中间宽
        const t = rnd();
        const rad = 0.26 * Math.sin(t * Math.PI) + 0.04;
        const a = rnd() * Math.PI * 2;
        e(x + Math.cos(a) * rad, pedH + 0.25 + t * (h - 0.2), z + Math.sin(a) * rad, mix(lang, [1, 1, 1], t * 0.5), 1.15 + t, 0.85);
      }
    }
    footing(o, e);
  },
  /** 壁龛:靠墙的一格,文件在龛里。波斯、古埃及、玛雅。 */
  niche(o, e) {
    const { x, z, h, n, rnd, lang, c2 } = o;
    for (let i = 0; i < n; i++) {
      const u = rnd();
      if (u < 0.34) {                                   // 龛的拱边
        const t = rnd() * Math.PI;
        e(x + Math.cos(t) * 0.42, 0.25 + Math.sin(t) * (h + 0.35), z + (rnd() - 0.5) * 0.1, c2, 1.15, 0.45);
      } else if (u < 0.5) {                             // 龛脚
        const s = rnd() < 0.5 ? -1 : 1;
        e(x + s * 0.42, rnd() * (h * 0.4 + 0.25), z + (rnd() - 0.5) * 0.1, mix(c2, lang, 0.4), 1.0, 0.3);
      } else {                                          // 里面那团光
        const a = rnd() * Math.PI * 2, rad = rnd() * 0.2;
        e(x + Math.cos(a) * rad, 0.35 + rnd() * h, z + Math.sin(a) * rad * 0.5, mix(lang, [1, 1, 1], rnd() * 0.5), 1.25, 0.8);
      }
    }
    footing(o, e);
  },
  /** 架子:一层层摞上去,每层一道光。唐宋、北欧。 */
  shelf(o, e) {
    const { x, z, h, n, rnd, lang, c1, c2 } = o;
    const tiers = Math.max(2, Math.round(h * 1.6));
    for (let i = 0; i < n; i++) {
      const u = rnd();
      if (u < 0.5) {                                    // 层板
        const k = Math.floor(rnd() * tiers);
        const y = 0.2 + (k / tiers) * h;
        e(x + (rnd() - 0.5) * 0.84, y, z + (rnd() - 0.5) * 0.4, mix(c1, c2, 0.5), 1.0, 0.28);
      } else if (u < 0.72) {                            // 立柱
        const s = rnd() < 0.5 ? -1 : 1;
        e(x + s * 0.42, rnd() * (h + 0.2), z + (rnd() - 0.5) * 0.4, mix(c1, c2, 0.3), 0.95, 0.2);
      } else {                                          // 架上的东西
        const k = Math.floor(rnd() * tiers);
        e(x + (rnd() - 0.5) * 0.7, 0.28 + (k / tiers) * h + rnd() * 0.16, z + (rnd() - 0.5) * 0.3, mix(lang, [1, 1, 1], rnd() * 0.45), 1.3, 0.75);
      }
    }
    footing(o, e);
  },
};
function footing(o, e) {
  const { x, z, n, rnd, c1, c2 } = o;
  for (let i = 0; i < n / 5; i++) {
    const a = rnd() * Math.PI * 2, rr = 0.25 + rnd() * 0.22;
    e(x + Math.cos(a) * rr, 0.01 + rnd() * 0.04, z + Math.sin(a) * rr, mix(c2, c1, 0.4), 1.05, 0.3);
  }
}
