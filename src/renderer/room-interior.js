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
import { LANG_COLOR, LANG_FALLBACK, langOfFile } from './lang-colors.js';

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
    // disp 槽已经不用了(文件改由 room-furniture.js 摆成家具),但抽签照旧抽 ——
    // 删掉它,后面的 grain / bays 会整体错一位,每一间见过的屋子都会变样。
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

/** 墙的公共部分:一面光帘,密度由 `f(u, yt, y)` 决定,门洞处留空。
 *
 *  ⚠ 走近了墙是空的。纹样本身是稀的(按 k 抽掉一大半),远看成面,贴过去就只剩几颗
 *  零散的点,读不出"这里是一面墙"。所以每面墙不管什么风格都有三道**连续的线**:
 *  踢脚、腰线、檐口 —— 那是让一面墙在近处也站得住的骨架,和门一样,风格只改颜色。 */
function curtain(o, e, f, goldMix = 0.5) {
  const { x0, z0, x1, z1, h, n, rnd, c1, c2, gap } = o;
  const horiz = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const len = horiz ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const at = (u) => [horiz ? Math.min(x0, x1) + u : x0, horiz ? z0 : Math.min(z0, z1) + u];
  const inGap = (px, pz) => gap && px > gap.x0 && px < gap.x1 && pz > gap.z0 && pz < gap.z1;
  const jit = (s) => (rnd() - 0.5) * s;
  const base = mix([0.13, 0.15, 0.2], c1, 0.55);
  /* 墙皮:一层很细、很暗、均匀的小点。纹样负责"远看是什么风格",这一层负责
     "贴近了这里确实是一面墙" —— 小而暗,所以不开花,远处也不抢纹样的戏。 */
  const plaster = Math.round(n * 0.35);
  for (let i = 0; i < plaster; i++) {
    const [px, pz] = at(rnd() * len);
    if (inGap(px, pz)) continue;
    const y = Math.pow(rnd(), 1.25) * h;
    e(px + (horiz ? 0 : jit(0.05)), y, pz + (horiz ? jit(0.05) : 0), mix(base, c1, 0.2), 0.85, 0.08);
  }
  for (let i = plaster; i < n; i++) {
    const [px, pz] = at(rnd() * len);
    if (inGap(px, pz)) continue;
    const u = horiz ? px - Math.min(x0, x1) : pz - Math.min(z0, z1);
    const yt = Math.pow(rnd(), 1.5), y = yt * h;
    const k = f(u, yt, y);
    if (rnd() > k) continue;
    const c = mix(mix(base, c1, 0.2 + (1 - yt) * 0.35), c2, Math.min(1, k) * goldMix);
    e(px + (horiz ? 0 : jit(0.12)), y, pz + (horiz ? jit(0.12) : 0), c, 0.8 + k * 1.1, 0.35);
  }
  // 骨架:三道线,各自一段高度带。点数跟着墙长走,不跟着纹样的疏密走。
  const rails = [
    { y: 0.06, band: 0.12, c: mix(c1, c2, 0.25), sz: 1.0, tw: 0.25 },     // 踢脚
    { y: 1.05, band: 0.05, c: mix(c1, c2, 0.55), sz: 1.05, tw: 0.35 },    // 腰线
    { y: h - 0.1, band: 0.16, c: c2, sz: 1.3, tw: 0.55 },                  // 檐口
  ];
  const per = Math.round(len * 55);
  for (const rl of rails) {
    for (let i = 0; i < per; i++) {
      const [px, pz] = at(rnd() * len);
      if (inGap(px, pz) && rl.y < h * 0.62) continue;  // 门洞里没有踢脚和腰线,券以上的檐口照走
      e(px + (horiz ? 0 : jit(0.06)), rl.y + jit(rl.band), pz + (horiz ? jit(0.06) : 0), rl.c, rl.sz, rl.tw);
    }
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
  /** 火盆:地上的一圈火。古埃及、玛雅、北欧。
   *
   *  ⚠ 火不是圆锥。第一版半径随高度线性收、点在高度上均匀撒 —— 那就是一个实心圆锥,
   *  远看像一排圣诞树。火是**几条舌头**:每条自己多高、往哪边歪,中段最胖、顶上
   *  收成尖;点压在根部(那儿最亮),根部是白芯、梢是红的,再往上飘几颗火星。 */
  brazier(o, e) {
    const { cx, cz, n, rnd, c1, c2, r } = o;
    const spots = 4, TONGUES = 5, Y0 = 0.92;
    const R = Math.min(r.x1 - r.x0, r.z1 - r.z0) * 0.32;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * spots), a = (k / spots) * Math.PI * 2 + 0.7;
      const bx = cx + Math.cos(a) * R, bz = cz + Math.sin(a) * R;
      const u = rnd();
      if (u < 0.50) {                                   // 火舌
        const j = Math.floor(rnd() * TONGUES);
        // 每条舌头的高度、方位、歪向都是固定的(按盆号 × 舌头号取),不随粒子变 ——
        // 否则舌头会糊成一团光,看不出是几条。
        const hj = ((Math.imul(k * 7 + j, 2654435761) >>> 0) / 4294967296);
        const H = 0.55 + hj * 0.55, phi = j / TONGUES * Math.PI * 2 + hj * 1.3;
        const off = j === 0 ? 0 : 0.11;                 // 一条居中,其余围一圈
        const t = Math.pow(rnd(), 1.6);                 // 0 = 根,1 = 梢;点压在根部
        // 泪滴形:中段最胖,梢收成尖
        const w = 0.13 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t * 1.05)), 0.8) * (1 - t * 0.55);
        const lean = Math.sin(t * 2.4 + hj * 6) * 0.07 * t;
        const aa = rnd() * Math.PI * 2, rr = w * Math.sqrt(rnd());
        const core = rr < w * 0.4 && t < 0.45;
        const col = core ? [1, 0.96, 0.82]
          : t < 0.55 ? mix([1, 0.78, 0.34], [1, 0.52, 0.16], t / 0.55)
          : mix([1, 0.52, 0.16], [0.85, 0.2, 0.06], (t - 0.55) / 0.45);
        e(bx + Math.cos(phi) * off * (1 - t) + Math.cos(aa) * rr + Math.cos(phi) * lean,
          Y0 + t * H,
          bz + Math.sin(phi) * off * (1 - t) + Math.sin(aa) * rr + Math.sin(phi) * lean,
          col, (core ? 1.9 : 1.35) + (1 - t) * 0.9, 1.0);
      } else if (u < 0.535) {                           // 火星:往上飘,越高越稀越暗
        const t = Math.pow(rnd(), 0.6);
        e(bx + (rnd() - 0.5) * 0.5 * t, Y0 + 0.9 + t * 1.6, bz + (rnd() - 0.5) * 0.5 * t,
          mix([1, 0.7, 0.3], [0.7, 0.18, 0.05], t), 1.0 + (1 - t) * 0.6, 1.0);
      } else if (u < 0.575) {                           // 火光:盆周围一团很淡的大点,把地面照暖
        const aa = rnd() * Math.PI * 2, rr = 0.2 + rnd() * 0.9;
        e(bx + Math.cos(aa) * rr, Y0 + (rnd() - 0.3) * 0.6, bz + Math.sin(aa) * rr, [0.22, 0.1, 0.03], 3.2, 0.9);
      } else if (u < 0.80) {                            // 盆:一只浅碟,口沿最亮
        const s = Math.sqrt(rnd()), aa = rnd() * Math.PI * 2;
        const rim = s > 0.9;
        e(bx + Math.cos(aa) * 0.44 * s, Y0 - (1 - s * s) * 0.2 + (rim ? 0.02 : 0), bz + Math.sin(aa) * 0.44 * s,
          rim ? c2 : mix(c1, c2, 0.3), rim ? 1.25 : 0.95, 0.3);
      } else {                                          // 三条腿,往外撇
        const leg = Math.floor(rnd() * 3), la = leg / 3 * Math.PI * 2 + a;
        const t = rnd(), rr = 0.12 + (1 - t) * 0.22;
        e(bx + Math.cos(la) * rr, t * (Y0 - 0.18), bz + Math.sin(la) * rr, mix(c1, c2, 0.35 + t * 0.3), 0.9, 0.2);
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

/* ══ 平面图 ════════════════════════════════════════════════════════════════
   一个目录摆成一座厅:大厅在中间,最大的几个子目录是四面的房间。纯函数 ——
   room-scene.js 拿它盖房子,测试拿它对账,两边看到的是同一张图。 */
export const HALL_W = 18, HALL_D = 14, HALL_H = 6.2, ROOM_H = 3.6, DOOR_W = 2.4, PAD = 0.4;
/** 大厅四面各开一扇门。第五个子目录没有墙可以开门了 —— 它的文件留在大厅里,
 *  展品上照样写着它在哪个子目录下,而不是被丢掉。 */
const MAX_KID_ROOMS = 4;

const hex2rgb = (h) => { const n = parseInt(String(h).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

/** 一个文件的颜色:**它自己的**语言,认不出扩展名才退回目录的主语言。
 *  这是光的颜色,不是漆的颜色 —— 见 room-interior.js 的 asLight。 */
export function fileLight(name, dirLang) {
  const l = langOfFile(name) || dirLang || '';
  return asLight(hex2rgb(LANG_COLOR[l] || LANG_FALLBACK));
}

/** 外面那座楼是什么风格,里面就是什么格局:唐宋走进去是一座四合院,江户是一座
 *  庭院,其余是一座厅。风格跟着楼走,格局跟着风格走。 */
export function layoutFor(styleId) {
  return styleId === 'tang' ? 'siheyuan' : styleId === 'edo' ? 'garden' : 'hall';
}
export const LAYOUTS = ['hall', 'siheyuan', 'garden'];
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 一个文件,不管来自深扫(对象)还是胶囊的 leaves(三元组),都整理成同一个形状。
 *  sym 为 null 表示"不知道",[] 表示"扫过了,里面没有符号" —— 两者画法不同。 */
function fileOf(f, deep) {
  if (deep) {
    return {
      name: String(f.n || ''), path: String(f.p || ''), sub: String(f.sub || ''), bytes: +f.b || 0,
      lines: +f.l || 0, lang: String(f.lang || ''), role: f.role ? String(f.role) : '',
      sym: Array.isArray(f.sym) ? f.sym : [], imp: +f.imp || 0, out: +f.out || 0,
    };
  }
  return { name: String(f[0]), path: '', sub: String(f[2] || ''), bytes: +f[1] || 0, lines: 0, lang: '', role: '', sym: null, imp: 0, out: 0 };
}

/**
 * 胶囊里的一个目录 → 平面图。矩形既是几何也是碰撞。
 *
 * 大厅(或院子)在中间,最大的四个子目录各占一面。房间**多大由它装多少文件决定** ——
 * 固定尺寸的屋子,装三个文件是空旷的,装六十个就摆不下。
 *
 * @param {{name?:string, kids?:Array, leaves?:Array, detail?:object}} dir
 *   detail = 深扫结果(api/github-room.js):有它就用它的 files / kids,每个文件带符号
 * @param {{layout?:'hall'|'siheyuan'|'garden'}} [opts]
 */
export function layoutOf(dir, opts = {}) {
  const layout = LAYOUTS.includes(opts && opts.layout) ? opts.layout : 'hall';
  const open = layout !== 'hall';
  const name = String((dir && dir.name) || '/');
  const detail = dir && dir.detail && Array.isArray(dir.detail.files) ? dir.detail : null;
  const kidsSrc = detail && Array.isArray(detail.kids) ? detail.kids : (Array.isArray(dir && dir.kids) ? dir.kids : []);
  const kidsAll = kidsSrc
    .filter((k) => Array.isArray(k) && k[0])
    .map((k) => [String(k[0]), +k[1] || 0, +k[2] || 0]);
  // 最大的几个拿到房间。按字节排,和城市里"楼高是代码量"说的是同一件事。
  const kids = kidsAll.slice().sort((a, b) => b[2] - a[2]).slice(0, MAX_KID_ROOMS);

  /* 文件按它在哪个子目录下分进各个房间。对不上房间的(顶层文件、第五个以后的子目录)
     留在大厅。⚠ leaves 缺席和 leaves 为空是两回事:缺席是"胶囊在这个字段出现之前
     扫的",调用方要说一声;为空才是"这个目录里真没有文件"。 */
  const hasLeaves = !!detail || Array.isArray(dir && dir.leaves);
  const roomNames = new Set(kids.map((k) => k[0]));
  const byRoom = new Map();
  const src = detail ? detail.files : (Array.isArray(dir && dir.leaves) ? dir.leaves : []);
  for (const raw of src) {
    if (detail ? !(raw && raw.n) : !(Array.isArray(raw) && raw[0])) continue;
    const f = fileOf(raw, !!detail);
    const into = roomNames.has(f.sub) ? f.sub : '';
    if (!byRoom.has(into)) byRoom.set(into, []);
    byRoom.get(into).push(f);
  }
  const count = (k) => (byRoom.get(k) || []).length;

  const nh = count('');
  const W = open ? clampN(14 + Math.sqrt(nh) * 1.2, 14, 24) : clampN(16 + Math.sqrt(nh) * 1.4, 16, 28);
  const D = Math.round(W * 0.78 * 10) / 10;
  const hall = {
    x0: -W / 2, z0: -D / 2, x1: W / 2, z1: D / 2, name, files: +(dir && dir.files) || 0,
    h: open ? 3.4 : HALL_H, isHall: true, open,
    kind: layout === 'hall' ? 'hall' : layout === 'siheyuan' ? 'court' : 'garden',
  };
  const rooms = [hall];
  const doors = [];
  const avg = kids.reduce((a, k) => a + k[2], 0) / Math.max(1, kids.length);
  // 四合院的次序是 正房(北)→ 东厢 → 西厢 → 倒座(南);厅和庭院沿用 北东南西。
  const sides = layout === 'hall' ? ['N', 'E', 'S', 'W'] : ['N', 'E', 'W', 'S'];

  kids.forEach((k, i) => {
    const [kn, files, bytes] = k;
    const n = count(kn);
    const share = Math.max(0.55, Math.min(1.5, avg ? bytes / avg : 1));
    const side = sides[i];
    // along = 沿着共用那面墙的长度,deep = 往外伸多深
    let along = clampN(5.6 + Math.sqrt(n) * 1.0 + share * 1.2, 6, 13);
    let deep = clampN(4.8 + Math.sqrt(n) * 0.7 + share, 5, 10);
    let h = open ? 3.4 : ROOM_H;
    if (layout === 'siheyuan') {
      // 正房最宽最深最高;厢房贴满院子整条边;倒座和院子一样宽。
      if (side === 'N') { along = W + 2; deep = Math.max(deep, 6.5); h = 4.8; }
      else if (side === 'S') { along = W; deep = 5; h = 4.0; }
      else { along = D; deep = clampN(deep, 5, 7); h = 4.2; }
    }
    let rect;
    if (side === 'N')      rect = { x0: -along / 2, z0: hall.z0 - deep, x1: along / 2, z1: hall.z0 };
    else if (side === 'S') rect = { x0: -along / 2, z0: hall.z1, x1: along / 2, z1: hall.z1 + deep };
    else if (side === 'E') rect = { x0: hall.x1, z0: -along / 2, x1: hall.x1 + deep, z1: along / 2 };
    else                   rect = { x0: hall.x0 - deep, z0: -along / 2, x1: hall.x0, z1: along / 2 };
    Object.assign(rect, { name: kn, files, bytes, side, h, isHall: false, open: false, kind: layout === 'hall' ? 'room' : layout === 'siheyuan' ? 'wing' : 'pavilion' });
    rooms.push(rect);
    if (side === 'N' || side === 'S') {
      const z = side === 'N' ? hall.z0 : hall.z1;
      doors.push({ x0: -DOOR_W / 2, z0: z - 0.8, x1: DOOR_W / 2, z1: z + 0.8, side, room: kn, cx: 0, cz: z });
    } else {
      const x = side === 'E' ? hall.x1 : hall.x0;
      doors.push({ x0: x - 0.8, z0: -DOOR_W / 2, x1: x + 0.8, z1: DOOR_W / 2, side, room: kn, cx: x, cz: 0 });
    }
  });

  return {
    layout, open, name, hall, rooms, doors, byRoom, hasLeaves,
    hasSymbols: !!detail, truncated: !!(detail && detail.truncated),
    extraKids: kidsAll.length - kids.length,
    start: { x: 0, z: D / 2 - 2.4, yaw: 0 },
    // 院子里走不过去的东西(树、鱼缸、池塘、石头)。装饰画完才知道在哪儿,由它们自己登记。
    blocks: [],
  };
}

/* ══ 院子:四合院 / 日式庭院 ════════════════════════════════════════════════
   o: { r(院子矩形), rnd, pal:{stone, accent, roof, timber}(已提亮成光色), doors,
        lit(x,y,z,半径,颜色) 登记一盏灯, block(x,z,rx,rz) 登记一块走不过去的地, n(预算系数) }
   e(x,y,z,颜色,大小,闪烁,种类):种类 0 实物、1 夜里才亮的灯、2 数据光、3 白天才有的光。 */
const TAU2 = Math.PI * 2;
function blossom(e, rnd, x, y, z, R, cols, n) {
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU2, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u) * Math.pow(rnd(), 0.35);
    e(x + Math.cos(a) * q * R, y + u * R * 0.62, z + Math.sin(a) * q * R, cols[(rnd() * cols.length) | 0], 0.75 + rnd() * 0.4, 0.2, 0);
  }
}
function trunk(e, rnd, x, z, h, r, col, n) {
  for (let i = 0; i < n; i++) {
    const t = rnd(), a = rnd() * TAU2, bend = Math.sin(t * 2.4) * 0.25 * t;
    e(x + bend + Math.cos(a) * r * (1 - t * 0.5), t * h, z + Math.sin(a) * r * (1 - t * 0.5), col, 0.8, 0.1, 0);
  }
}
function doorNear(doors, x, z, d = 1.8) { return doors.some((dr) => Math.abs(dr.cx - x) < d && Math.abs(dr.cz - z) < d); }

export const COURT = {
  /** 四合院:方砖地、十字甬道、四面游廊(朱柱、檐下挂灯笼)、两棵海棠、两口鱼缸。 */
  siheyuan(o, e) {
    const { r, rnd, pal, doors, lit, block } = o, B = o.n || 1;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, W = r.x1 - r.x0, D = r.z1 - r.z0;
    const seam = mix(pal.stone, [0.1, 0.1, 0.1], 0.45), path = mix(pal.stone, [1, 1, 1], 0.25);
    // 方砖的缝:沿两个方向的线
    for (let i = 0; i < Math.round((W * D) * 26 * B); i++) {
      const x = r.x0 + rnd() * W, z = r.z0 + rnd() * D;
      const fx = Math.abs(((x / 0.8) % 1 + 1) % 1 - 0.5), fz = Math.abs(((z / 0.8) % 1 + 1) % 1 - 0.5);
      if (Math.max(fx, fz) > 0.46) e(x, 0.012, z, seam, 0.7, 0.1, 0);
    }
    // 十字甬道:从垂花门到正房,从东厢到西厢
    for (let i = 0; i < Math.round((W + D) * 1.6 * 70 * B); i++) {
      const alongZ = rnd() < D / (W + D);
      const x = alongZ ? cx + (rnd() - 0.5) * 1.6 : r.x0 + rnd() * W;
      const z = alongZ ? r.z0 + rnd() * D : cz + (rnd() - 0.5) * 1.6;
      e(x, 0.014, z, path, 0.85, 0.1, 0);
    }
    // 游廊:沿院子四边一圈朱柱,柱顶一道额枋,檐向院内伸出
    const inset = 0.8, step = 2.6, colH = 3.1;
    const perim = [
      [[r.x0 + inset, r.z0 + inset], [r.x1 - inset, r.z0 + inset]], [[r.x1 - inset, r.z0 + inset], [r.x1 - inset, r.z1 - inset]],
      [[r.x1 - inset, r.z1 - inset], [r.x0 + inset, r.z1 - inset]], [[r.x0 + inset, r.z1 - inset], [r.x0 + inset, r.z0 + inset]],
    ];
    let k = 0;
    for (const [a, b] of perim) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), nC = Math.max(2, Math.round(len / step));
      for (let j = 0; j <= nC; j++) {
        const x = a[0] + (b[0] - a[0]) * j / nC, z = a[1] + (b[1] - a[1]) * j / nC;
        if (doorNear(doors, x, z, 1.5)) continue;
        for (let i = 0; i < Math.round(160 * B); i++) { const an = rnd() * TAU2; e(x + Math.cos(an) * 0.12, rnd() * colH, z + Math.sin(an) * 0.12, pal.accent, 0.8, 0.12, 0); }
        // 檐下的红灯笼,隔一根挂一盏 —— 夜里这一圈就是整座院子的灯
        if ((k++ & 1) === 0) {
          const lx = x + (cx - x) * 0.06, lz = z + (cz - z) * 0.06, ly = colH - 0.55;
          for (let i = 0; i < Math.round(90 * B); i++) {
            const an = rnd() * TAU2, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u);
            e(lx + Math.cos(an) * q * 0.2, ly + u * 0.26, lz + Math.sin(an) * q * 0.2, [1, 0.35, 0.22], 1.1, 0.9, 1);
          }
          for (let i = 0; i < Math.round(40 * B); i++) {
            const an = rnd() * TAU2, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u);
            e(lx + Math.cos(an) * q * 0.21, ly + u * 0.27, lz + Math.sin(an) * q * 0.21, [0.62, 0.12, 0.08], 0.8, 0.1, 0);
          }
          // 光源名额有限(见 room-scene 的 MAX_LIGHTS):每一盏都在发光,每隔一盏才照地面
          if ((k & 3) === 1) lit(lx, ly, lz, 6.5, [1, 0.5, 0.32]);
        }
      }
      // 额枋 + 檐
      for (let i = 0; i < Math.round(len * 90 * B); i++) {
        const t = rnd(), x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        e(x, colH + (rnd() - 0.5) * 0.14, z, mix(pal.accent, [0.2, 0.5, 0.45], 0.35), 0.85, 0.2, 0);
        const out = rnd() * 1.4, nx = (cx - x), nz = (cz - z), nl = Math.hypot(nx, nz) || 1;
        e(x + nx / nl * (out - 0.6), colH + 0.55 - out * 0.35, z + nz / nl * (out - 0.6), pal.roof, 0.9, 0.1, 0);
      }
    }
    // 两棵海棠
    for (const sx of [-1, 1]) {
      const tx = cx + sx * W / 4, tz = cz - D / 5;
      trunk(e, rnd, tx, tz, 2.4, 0.16, [0.3, 0.2, 0.14], Math.round(500 * B));
      blossom(e, rnd, tx, 3.1, tz, 1.9, [[1, 0.78, 0.84], [1, 0.9, 0.93], [0.95, 0.6, 0.7], [0.35, 0.55, 0.3]], Math.round(4200 * B));
      block(tx, tz, 0.55, 0.55);
    }
    // 两口鱼缸:青花瓷缸,水面上几尾金鱼
    for (const sx of [-1, 1]) {
      const bx = cx + sx * W / 4, bz = cz + D / 4, R = 0.48;
      for (let i = 0; i < Math.round(700 * B); i++) {
        const t = rnd(), an = rnd() * TAU2, rr = R * (0.75 + Math.sin(t * Math.PI) * 0.25);
        const blue = Math.sin(an * 6 + t * 9) > 0.35;
        e(bx + Math.cos(an) * rr, t * 0.62, bz + Math.sin(an) * rr, blue ? [0.2, 0.32, 0.7] : [0.9, 0.92, 0.95], 0.75, 0.1, 0);
      }
      for (let i = 0; i < Math.round(260 * B); i++) { const an = rnd() * TAU2, q = Math.sqrt(rnd()) * R * 0.95; e(bx + Math.cos(an) * q, 0.6, bz + Math.sin(an) * q, [0.08, 0.2, 0.22], 0.75, 0.3, 0); }
      for (let f = 0; f < 3; f++) { const an = rnd() * TAU2, q = rnd() * R * 0.6; for (let i = 0; i < 10; i++) e(bx + Math.cos(an) * q + (rnd() - 0.5) * 0.08, 0.61, bz + Math.sin(an) * q + (rnd() - 0.5) * 0.04, [1, 0.5, 0.15], 0.6, 0.5, 2); }
      block(bx, bz, 0.6, 0.6);
    }
  },

  /** 日式庭院:四周一圈缘侧(木廊)、中间枯山水(耙过的白砂)、三块石头、一方池塘
   *  和一座朱红拱桥、几座石灯笼(夜里点着)、一棵红枫一棵松。 */
  garden(o, e) {
    const { r, rnd, pal, lit, block } = o, B = o.n || 1;
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, W = r.x1 - r.x0, D = r.z1 - r.z0;
    const wood = [0.52, 0.38, 0.26], sand = [0.86, 0.85, 0.8], rake = [0.62, 0.62, 0.58];
    const band = 1.7;
    // 缘侧:沿四边一圈木板
    for (let i = 0; i < Math.round((W + D) * 2 * band * 150 * B); i++) {
      const x = r.x0 + rnd() * W, z = r.z0 + rnd() * D;
      const inBand = x < r.x0 + band || x > r.x1 - band || z < r.z0 + band || z > r.z1 - band;
      if (!inBand) continue;
      const alongX = z < r.z0 + band || z > r.z1 - band;
      const f = Math.abs((((alongX ? z : x) / 0.3) % 1 + 1) % 1 - 0.5);
      e(x, 0.03, z, f > 0.44 ? mix(wood, [0, 0, 0], 0.5) : wood, 0.8, 0.1, 0);
    }
    const inner = { x0: r.x0 + band + 0.3, x1: r.x1 - band - 0.3, z0: r.z0 + band + 0.3, z1: r.z1 - band - 0.3 };
    const iw = inner.x1 - inner.x0, id = inner.z1 - inner.z0;
    // 石头:三块,摆在不挡中路的地方
    const rocks = [[inner.x0 + iw * 0.22, inner.z0 + id * 0.3, 0.95], [inner.x0 + iw * 0.3, inner.z0 + id * 0.62, 0.6], [inner.x0 + iw * 0.12, inner.z0 + id * 0.55, 0.45]];
    // 池塘在右边
    const pond = { x: inner.x0 + iw * 0.74, z: inner.z0 + id * 0.42, rx: iw * 0.17, rz: id * 0.2 };
    const inPond = (x, z) => ((x - pond.x) / pond.rx) ** 2 + ((z - pond.z) / pond.rz) ** 2 < 1;
    // 白砂 + 耙纹:平行的波纹,绕石头的地方改成一圈圈
    for (let i = 0; i < Math.round(iw * id * 170 * B); i++) {
      const x = inner.x0 + rnd() * iw, z = inner.z0 + rnd() * id;
      if (inPond(x, z)) continue;
      let ring = 99;
      for (const [rx, rz, rs] of rocks) { const d = Math.hypot(x - rx, z - rz) - rs; if (d < 1.2) ring = Math.min(ring, d); }
      const coord = ring < 1.2 ? ring : z + Math.sin(x * 0.8) * 0.12;
      const f = Math.abs(((coord / 0.22) % 1 + 1) % 1 - 0.5);
      e(x, 0.02, z, f > 0.38 ? rake : sand, 0.7, 0.05, 0);
    }
    for (const [rx, rz, rs] of rocks) {
      for (let i = 0; i < Math.round(rs * rs * 1500 * B); i++) {
        const an = rnd() * TAU2, u = rnd(), q = Math.sqrt(1 - u * u);
        const moss = u > 0.7 && rnd() < 0.6;
        e(rx + Math.cos(an) * q * rs, u * rs * 0.7, rz + Math.sin(an) * q * rs * 0.8, moss ? [0.3, 0.45, 0.22] : [0.34, 0.34, 0.36], 0.85, 0.05, 0);
      }
      block(rx, rz, rs + 0.15, rs * 0.8 + 0.15);
    }
    // 池塘:深色水面,白天有天光的碎亮,夜里映着灯
    for (let i = 0; i < Math.round(pond.rx * pond.rz * Math.PI * 180 * B); i++) {
      const an = rnd() * TAU2, q = Math.sqrt(rnd());
      const x = pond.x + Math.cos(an) * q * pond.rx, z = pond.z + Math.sin(an) * q * pond.rz;
      e(x, -0.02, z, [0.05, 0.14, 0.18], 0.8, 0.3, 0);
      if (rnd() < 0.05) e(x, 0.0, z, [0.8, 0.9, 1], 0.7, 1, 3);
    }
    for (let i = 0; i < Math.round((pond.rx + pond.rz) * 260 * B); i++) {   // 池边的石
      const an = rnd() * TAU2;
      e(pond.x + Math.cos(an) * pond.rx * (1 + rnd() * 0.08), rnd() * 0.18, pond.z + Math.sin(an) * pond.rz * (1 + rnd() * 0.08), [0.42, 0.42, 0.44], 0.95, 0.05, 0);
    }
    for (let f = 0; f < 6; f++) {                                           // 锦鲤
      const an = rnd() * TAU2, q = rnd() * 0.7, fx = pond.x + Math.cos(an) * q * pond.rx, fz = pond.z + Math.sin(an) * q * pond.rz, hd = rnd() * TAU2;
      for (let i = 0; i < 26; i++) { const t = (rnd() - 0.5) * 0.36; e(fx + Math.cos(hd) * t, 0.01, fz + Math.sin(hd) * t, rnd() < 0.5 ? [1, 0.45, 0.12] : [0.95, 0.95, 0.92], 0.55, 0.4, 0); }
    }
    block(pond.x, pond.z, pond.rx + 0.2, pond.rz + 0.2);
    // 朱红拱桥,横跨池塘窄的那一向
    const bw = 0.9, L = pond.rz * 2.4;
    for (let i = 0; i < Math.round(L * 300 * B); i++) {
      const t = rnd() - 0.5, u = (rnd() - 0.5) * bw, y = 0.55 * Math.cos(t * Math.PI) + 0.05;
      e(pond.x + u, y, pond.z + t * L, [0.62, 0.2, 0.14], 0.8, 0.1, 0);
      // 栏杆:桥面两边一道矮栏,跟着桥拱走
      if (rnd() < 0.3) e(pond.x + (rnd() < 0.5 ? -bw / 2 : bw / 2), y + 0.32, pond.z + t * L, [0.5, 0.14, 0.1], 0.7, 0.1, 0);
    }
    // 石灯笼:台、柱、火袋(夜里亮)、笠。⚠ 不放在中轴上 —— 那儿是通往尽头主案的路。
    const lanterns = [[pond.x + pond.rx + 0.7, pond.z + pond.rz * 0.4], [inner.x0 + iw * 0.2, inner.z0 + 0.7], [rocks[0][0] + 1.6, rocks[0][1] - 1.0]];
    for (const [lx, lz] of lanterns) {
      const stone = [0.55, 0.55, 0.52];
      for (let i = 0; i < Math.round(420 * B); i++) {
        const t = rnd(), an = rnd() * TAU2;
        const y = t * 1.75, rr = y < 0.35 ? 0.24 : y < 1.0 ? 0.09 : y < 1.4 ? 0.2 : 0.34 * (1 - (y - 1.4) / 0.35);
        e(lx + Math.cos(an) * rr, y, lz + Math.sin(an) * rr, stone, 0.8, 0.05, 0);
      }
      for (let i = 0; i < Math.round(80 * B); i++) e(lx + (rnd() - 0.5) * 0.22, 1.05 + rnd() * 0.3, lz + (rnd() - 0.5) * 0.22, [1, 0.78, 0.4], 1.2, 1, 1);
      lit(lx, 1.2, lz, 4.5, [1, 0.72, 0.4]);
      block(lx, lz, 0.4, 0.4);
    }
    // 红枫、松
    const mx = inner.x0 + iw * 0.08, mz = inner.z0 + id * 0.12;
    trunk(e, rnd, mx, mz, 2.0, 0.12, [0.28, 0.18, 0.12], Math.round(400 * B));
    blossom(e, rnd, mx, 2.7, mz, 1.7, [[0.92, 0.25, 0.12], [1, 0.45, 0.15], [0.8, 0.15, 0.1], [0.95, 0.6, 0.2]], Math.round(3600 * B));
    block(mx, mz, 0.45, 0.45);
    const px = inner.x1 - iw * 0.06, pz = inner.z0 + id * 0.1;
    trunk(e, rnd, px, pz, 2.6, 0.14, [0.3, 0.22, 0.16], Math.round(420 * B));
    for (let tier = 0; tier < 4; tier++) {
      for (let i = 0; i < Math.round(900 * B); i++) {
        const an = rnd() * TAU2, q = Math.sqrt(rnd()) * (1.5 - tier * 0.28);
        e(px + Math.cos(an) * q, 1.6 + tier * 0.55 + (rnd() - 0.5) * 0.15, pz + Math.sin(an) * q, [0.14, 0.32, 0.2], 0.8, 0.1, 0);
      }
    }
    block(px, pz, 0.45, 0.45);
  },
};

/** 院子四周那几间房从院子里看得见的屋顶:两坡顶,脊沿长边,檐伸出去。
 *  四合院是青瓦,庭院里的茶室是深灰的陡坡。 */
export function roofOf(o, e) {
  const { r, rnd, col, ridgeCol, steep = 0.42, over = 0.9 } = o, B = o.n || 1;
  const along = (r.x1 - r.x0) >= (r.z1 - r.z0);
  const L = along ? r.x1 - r.x0 : r.z1 - r.z0, S = along ? r.z1 - r.z0 : r.x1 - r.x0;
  const c0 = along ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2;
  const a0 = along ? r.x0 : r.z0;
  const n = Math.round((L + 2 * over) * (S + 2 * over) * 60 * B);
  for (let i = 0; i < n; i++) {
    const t = a0 - over + rnd() * (L + 2 * over), s = (rnd() - 0.5) * (S + 2 * over);
    const y = r.h + (S / 2 - Math.abs(s)) * steep;
    const tile = Math.abs(((t / 0.28) % 1 + 1) % 1 - 0.5) > 0.36;
    const c = tile ? mix(col, [0, 0, 0], 0.35) : col;
    if (along) e(t, y, c0 + s, c, 0.9, 0.08, 0); else e(c0 + s, y, t, c, 0.9, 0.08, 0);
  }
  // 屋脊,两头微微起翘
  for (let i = 0; i < Math.round((L + 2 * over) * 70 * B); i++) {
    const t = a0 - over + rnd() * (L + 2 * over), end = Math.max(0, Math.abs(t - (a0 + L / 2)) - L / 2) / over;
    const y = r.h + (S / 2) * steep + 0.12 + end * 0.35;
    if (along) e(t, y, c0, ridgeCol, 0.95, 0.2, 0); else e(c0, y, t, ridgeCol, 0.95, 0.2, 0);
  }
}

/** 天:白天几朵云和太阳,夜里星星和月亮。只有院子这种露天的格局才画。 */
export function skyOf(o, e) {
  const { rnd } = o, B = o.n || 1;
  for (let i = 0; i < Math.round(2200 * B); i++) {                       // 星:只在夜里
    const an = rnd() * TAU2, el = 0.18 + Math.pow(rnd(), 0.7) * 1.3, R = 90;
    e(Math.cos(an) * Math.cos(el) * R, 8 + Math.sin(el) * R, Math.sin(an) * Math.cos(el) * R, [0.85, 0.9, 1], 1.2 + rnd() * 2.4, 1, 1);
  }
  for (let i = 0; i < Math.round(600 * B); i++) {                        // 月
    const z = rnd() * 2 - 1, an = rnd() * TAU2, q = Math.sqrt(1 - z * z);
    e(-30 + Math.cos(an) * q * 4, 55 + z * 4, -60 + Math.sin(an) * q * 4, [1, 0.97, 0.86], 3, 0.2, 1);
  }
  for (let c = 0; c < 7; c++) {                                           // 云:只在白天
    const an = rnd() * TAU2, R = 50 + rnd() * 30, cx = Math.cos(an) * R, cz = Math.sin(an) * R, cy = 28 + rnd() * 10;
    for (let i = 0; i < Math.round(420 * B); i++) {
      const u = rnd() * 2 - 1, a = rnd() * TAU2, q = Math.sqrt(1 - u * u) * Math.pow(rnd(), 0.4);
      e(cx + Math.cos(a) * q * 9, cy + u * 2.2, cz + Math.sin(a) * q * 5, [0.95, 0.96, 1], 9, 0.1, 3);
    }
  }
  for (let i = 0; i < Math.round(500 * B); i++) {                         // 太阳
    const z = rnd() * 2 - 1, an = rnd() * TAU2, q = Math.sqrt(1 - z * z);
    e(40 + Math.cos(an) * q * 4, 60 + z * 4, -50 + Math.sin(an) * q * 4, [1, 0.93, 0.75], 4, 0.1, 3);
  }
}
