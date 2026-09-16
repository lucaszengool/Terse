/**
 * town-build.js — 把小镇的图纸(town-plan.js)盖成粒子:一栋栋别墅、树、长椅、路灯。
 *
 * 地、街、广场、公园**不在这里** —— 它们是 town-ground.js 那张俯视图上的颜色,由一圈
 * 跟着人走的点画出来。(第一版把地也铺成固定的点:两千五百万颗,脚下全是半米大的球。)
 *
 * 一栋房子 = 一个项目,走在街上看到的就是它的外观,所以外观不能是一个盒子:
 *
 *   台基   石头的底座,比楼身宽一点 —— 房子"坐"在地上,不是浮着
 *   楼身   外墙掺着这个项目主语言的颜色;每层一道腰线;四角壁柱
 *   窗     一格格排开,夜里从里面透出暖光(发光点,kind 1)
 *   檐冠   平顶压一圈女儿墙;唐宋、江户、北欧是两坡顶(风格来自胶囊里的 style)
 *   门脸   朝着街:门廊、两盏灯、几级台阶,门洞里一层这个项目语言色的光幕
 *   院子   临街一道矮树篱 —— 街道因此有了"沿街面",不是一排孤立的方块
 */
import { Surfaces, makeUniforms, MAT } from './room-surface.js';
import { langRgb } from './lang-colors.js';
import { asLight } from './room-interior.js';
import { designOf, kelvin } from './room-styles.js';
import { styleOf, seedOf, picker } from './city-styles.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** 一块凸多边形的面(屋顶、台基):按扫描线切成一条条矩形。
 *  ⚠ quad() 要的是平行四边形:把多边形的两条边当 U、V,画出来的是一块歪斜的、
 *  比地块还大的皮(第一版的地就是这么糊出去的)。 */
function paveConvex(S, poly, y, spec, step = 1.6) {
  let x0 = 1e9, x1 = -1e9;
  for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
  for (let x = x0; x < x1 - 1e-6; x += step) {
    const xa = x, xb = Math.min(x1, x + step);
    let lo = 1e9, hi = -1e9;
    for (const xx of [xa, xb]) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[0] <= xx && b[0] >= xx) || (b[0] <= xx && a[0] >= xx)) {
          const t = Math.abs(b[0] - a[0]) < 1e-9 ? 0 : (xx - a[0]) / (b[0] - a[0]);
          const z = a[1] + (b[1] - a[1]) * t;
          lo = Math.min(lo, z); hi = Math.max(hi, z);
        }
      }
    }
    if (hi <= lo + 1e-6) continue;
    S.quad([xa, y, lo], [xb - xa, 0, 0], [0, 0, hi - lo], spec, [0, 1, 0]);
  }
}

/** 多边形往外/往里挪 d 米(正数往外)。台基比楼身宽一点,檐口探出来一点。 */
function polyOffset(poly, d) {
  const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  return poly.map((p) => {
    const dx = p[0] - c[0], dz = p[1] - c[1], L = Math.hypot(dx, dz) || 1;
    return [p[0] + (dx / L) * d, p[1] + (dz / L) * d];
  });
}

/** 一棵树。 */
function tree(S, x, z, h, rnd, leafA, leafB) {
  S.tube([x, 0, z], [x + (rnd() - 0.5) * 0.4, h * 0.62, z + (rnd() - 0.5) * 0.4], 0.16 + rnd() * 0.08,
    { mat: MAT.bark, c1: [0.3, 0.22, 0.16], seed: rnd() * 10 });
  // 三层就够:一棵树是"一根杆 + 几片叶影",盘子大了既贵又假
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    S.disc([x + (rnd() - 0.5) * 0.6, h * (0.62 + t * 0.36), z + (rnd() - 0.5) * 0.6], 0,
      h * (0.3 - t * 0.18) + 0.25, { mat: MAT.leaf, c1: leafA, c2: leafB, seed: rnd() * 10 });
  }
}

/**
 * 把图纸盖起来。
 * @param {object} plan town-plan.js 的图纸
 * @param {object} o    { budget, uniforms, G(x,y,z,col,size,tw,kind), seed, styleId }
 * @returns {{S, U, lights, blocks, doors, labels}}
 */
export function buildTown(plan, o = {}) {
  const B = Math.max(0.25, Math.min(1, o.budget || 1));
  /* 点距 12–22 厘米(房子缩成别墅之后才付得起):点要小、要密,近看是细沙,不是一颗颗珠子。 */
  const S = new Surfaces(o.spacing || (B >= 0.9 ? 0.16 : B >= 0.6 ? 0.2 : 0.26));
  const U = o.uniforms || makeUniforms();
  const G = o.G || (() => {});
  const D = designOf(o.styleId || 'modern');
  const lights = [], blocks = [], doors = [], labels = [];
  const rnd = picker(seedOf('town:' + plan.plots.length + ':' + (o.seed || ''))).f;
  /* only:只盖这几栋(近处那份细的);props === false:广场、公园、路灯归那份粗的管,
     两份都盖一遍就是两遍的灯和两遍的树。 */
  const only = o.only ? new Set(o.only) : null;
  const props = o.props !== false;
  const seed = rnd() * 10;
  const sp = (mat, c1, c2) => ({ mat, c1, c2: c2 || c1, seed });

  /* 一个区一种气质:同一个城市的房子,墙色往同一个方向偏一点点 —— 走过街口会发觉换了地方 */
  const districtTint = new Map();
  plan.districts.forEach((d, i) => {
    const hue = (i / Math.max(1, plan.districts.length)) * TAU;
    districtTint.set(d.key, [0.5 + 0.5 * Math.cos(hue), 0.5 + 0.5 * Math.cos(hue + 2.1), 0.5 + 0.5 * Math.cos(hue + 4.2)]);
  });

  /* ── 一栋别墅 ─────────────────────────────────────────────────────────── */
  for (const plot of plan.plots) {
    if (only && !only.has(plot.id)) continue;
    const p = plot.project;
    // 颜色取的是室内那张设计单的色板(city-styles 那份是给外面那座城用的)
    const sid = styleOf(p.style || o.styleId || 'modern').id;
    const pal = designOf(sid).pal;
    const lang = asLight(langRgb(String(p.lang || '').toLowerCase()));
    const tint = districtTint.get(plot.district) || [1, 1, 1];
    /* 外墙压暗:粒子世界里"亮底 + 亮点"会一起烧成白 —— 底要暗,亮的只留窗、灯、门。
       (研究里的 70/25/5:七成画面在暗部,只有半成是亮的。) */
    const wall = mix3(mix3(pal.field, lang, 0.3), tint, 0.1).map((v) => v * 0.62);
    const trim = (pal.struct || [0.22, 0.22, 0.24]).map((v) => v * 0.6);
    const stone = (pal.stone || [0.5, 0.5, 0.52]).map((v) => v * 0.6);
    const poly = plot.poly, h = plot.h;
    const floors = Math.max(1, Math.round((h - 1.2) / 3));
    /* 墙上的纹样交给材质:一道腰线如果拿几何去做,是一条 10 米长、12 厘米高的盒子 ——
       这套系统会把细长的东西切成几十块方片,一条线 3000 颗点,一栋楼四十几条。 */
    const wallMat = sid === 'giza' || sid === 'hellas' || sid === 'maya' ? MAT.masonry : sid === 'norse' || sid === 'edo' ? MAT.wood : MAT.plaster;

    // 台基:比楼身宽 0.35 米,高 0.55
    const base = polyOffset(poly, 0.35);
    // ⚠ 台基顶面只留房子四周露出来的那一圈(房子压住的地方一颗点都看不见)
    paveConvex(S, base, 0.55, sp(MAT.stone, stone, mix3(stone, [0, 0, 0], 0.25)), 3.2);
    for (let i = 0; i < base.length; i++) {
      const a = base[i], b = base[(i + 1) % base.length];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 0.25) continue;
      S.quad([a[0], 0, a[1]], [ex, 0, ez], [0, 0.55, 0], sp(MAT.stone, mix3(stone, [0, 0, 0], 0.2)), [ez / L, 0, -ex / L]);
    }

    // 楼身:外墙 + 每层一道腰线 + 窗
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 0.3) continue;
      const ux = ex / L, uz = ez / L, nx = ez / L, nz = -ex / L;
      S.quad([a[0], 0.55, a[1]], [ex, 0, ez], [0, h - 0.55, 0], sp(wallMat, wall, mix3(wall, stone, 0.3)), [nx, 0, nz]);
      // 窗:每层一排,墙面朝外的一侧
      const cols = Math.max(1, Math.floor((L - 1.6) / 3.2));
      for (let c = 0; c < cols; c++) {
        const u = (L - 1.6) * ((c + 0.5) / cols) + 0.8;
        for (let f = 0; f < floors; f++) {
          const y = 1.25 + f * ((h - 0.55) / floors);
          if (y + 1.5 > h - 0.35) continue;
          const wx = a[0] + ux * u, wz = a[1] + uz * u;
          S.quad([wx - ux * 0.62 + nx * 0.07, y, wz - uz * 0.62 + nz * 0.07], [ux * 1.24, 0, uz * 1.24], [0, 1.5, 0],
            sp(MAT.glass, [0.08, 0.1, 0.13], [0.13, 0.15, 0.19]), [nx, 0, nz]);
          /* 窗框、窗台一概不做:一个盒子六个面、每个面最少 16 颗点,一扇窗就是几百颗。
             窗是"墙上一块暗玻璃 + 夜里透出来的光",这两样就够看。 */
          if (rnd() > 0.72) continue;                       // 有些窗是黑的:没人住的房子才每扇都一样
          const warm = 0.72 + rnd() * 0.26;
          for (let k = 0; k < 14; k++) {
            G(wx + (rnd() - 0.5) * 1.15 + nx * 0.14, y + 0.2 + rnd() * 1.25, wz + (rnd() - 0.5) * 1.15 + nz * 0.14,
              [warm, warm * 0.76, warm * 0.5], 0.13, 0.26, 1);
          }
        }
      }
    }

    /* 檐冠:唐宋、江户、北欧是两坡顶;别的压一圈女儿墙 —— 一条街上屋顶的轮廓不一样,
       远远看过去才认得出哪座是哪座 */
    const pitched = sid === 'tang' || sid === 'edo' || sid === 'norse';
    const eave = polyOffset(poly, 0.45);
    paveConvex(S, eave, h, sp(MAT.rooftile, pal.ceil || [0.22, 0.23, 0.26], mix3(pal.ceil || [0.22, 0.23, 0.26], [0, 0, 0], 0.3)), 2.4);
    // 檐:再往外一点的一块薄板。⚠ 不要用一圈细长的盒子 —— 见下面那条注释
    paveConvex(S, polyOffset(poly, 0.62), h - 0.06, sp(MAT.lacquer, trim), 2.4);
    if (pitched) {
      // 两坡:沿长边起脊
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const q of poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
      const along = (x1 - x0) >= (z1 - z0), rise = Math.min(3.2, (along ? z1 - z0 : x1 - x0) * 0.42);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const spec = sp(MAT.rooftile, mix3(pal.ceil || [0.2, 0.2, 0.24], trim, 0.4), trim);
      for (const s of [-1, 1]) {
        if (along) S.quad([x0 - 0.4, h + rise, cz], [x1 - x0 + 0.8, 0, 0], [0, -rise, s * ((z1 - z0) / 2 + 0.5)], spec, [0, 1, s]);
        else S.quad([cx, h + rise, z0 - 0.4], [0, 0, z1 - z0 + 0.8], [s * ((x1 - x0) / 2 + 0.5), -rise, 0], spec, [s, 1, 0]);
      }
    } else {
      for (let i = 0; i < eave.length; i++) {
        const a = eave[i], b = eave[(i + 1) % eave.length];
        const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
        if (L < 0.25) continue;
        // 女儿墙:一片立着的面,不是盒子(盒子六个面,其中五个谁也看不见)
        S.quad([a[0], h, a[1]], [ex, 0, ez], [0, 0.7, 0], sp(MAT.plaster, mix3(wall, stone, 0.4)), [ez / L, 0, -ex / L]);
      }
      // 屋顶上一点东西:水箱、天线 —— 天际线不整齐才好看
      if (rnd() < 0.5) {
        const bx = plot.cx + (rnd() - 0.5) * 2, bz = plot.cz + (rnd() - 0.5) * 2;
        S.box([bx, h + 0.3, bz], [1, 0, 0], [0, 0, 1], 1.2 + rnd(), 1 + rnd(), 1.2 + rnd(), sp(MAT.metal, mix3(trim, stone, 0.5)));
      }
    }

    /* 门脸:朝着街 —— 门廊、两盏灯、台阶,门洞里一层这个项目语言色的光幕 */
    const dr = plot.door, cs = Math.cos(dr.yaw), sn = Math.sin(dr.yaw);
    // 门朝向的单位向量(朝街):(-sin, -cos);沿墙的方向:(-cos, sin)
    const fx = -sn, fz = -cs, sx = -cs, sz = sn;
    const lk = kelvin(D.light.lampK);
    // 台阶
    for (let i = 0; i < 3; i++) {
      S.box([dr.x + fx * (0.5 + i * 0.35), 0.55 - (i + 1) * 0.18, dr.z + fz * (0.5 + i * 0.35)], [sx, 0, sz], [fx, 0, fz],
        2.4 - i * 0.2, 0.18, 0.4, sp(MAT.stone, stone));
    }
    // 门廊:两根柱子 + 一块顶
    for (const s of [-1, 1]) {
      S.tube([dr.x + sx * s * 1.05 + fx * 0.9, 0.55, dr.z + sz * s * 1.05 + fz * 0.9],
        [dr.x + sx * s * 1.05 + fx * 0.9, 3.0, dr.z + sz * s * 1.05 + fz * 0.9], 0.11, sp(MAT.lacquer, trim));
      const gx = dr.x + sx * s * 1.15 + fx * 0.35, gz = dr.z + sz * s * 1.15 + fz * 0.35;
      lights.push({ x: gx, y: 2.5, z: gz, r: 7, col: [lk[0], lk[1] * 0.9, lk[2] * 0.72], k: 1.4 });
      for (let k = 0; k < 12; k++) G(gx + (rnd() - 0.5) * 0.2, 2.45 + (rnd() - 0.5) * 0.18, gz + (rnd() - 0.5) * 0.2, [0.9, 0.76, 0.54], 0.08, 0.35, 1);
    }
    S.box([dr.x + fx * 0.9, 3.0, dr.z + fz * 0.9], [sx, 0, sz], [fx, 0, fz], 2.6, 0.22, 2.0, sp(MAT.lacquer, mix3(trim, stone, 0.3)), { bottom: true });
    // 门洞的光幕
    for (let k = 0, n = Math.round(300 * B) + 80; k < n; k++) {
      const u = (rnd() * 2 - 1) * 0.85, y = 0.6 + rnd() * 2.2;
      G(dr.x + sx * u + fx * 0.05, y, dr.z + sz * u + fz * 0.05, [lang[0] * 0.95, lang[1] * 0.95, lang[2] * 0.95], 0.055 + rnd() * 0.04, 0.8, 2);
    }

    /* 临街的院子:一道矮树篱 —— 街因此有了沿街面 */
    const hedge = sp(MAT.leaf, [0.11, 0.22, 0.13], [0.16, 0.3, 0.18]);
    for (const s of [-1, 1]) {
      const hx = dr.x + sx * s * 2.6 + fx * 0.6, hz = dr.z + sz * s * 2.6 + fz * 0.6;
      S.box([hx, 0, hz], [sx, 0, sz], [fx, 0, fz], 2.4, 0.75, 0.5, hedge);
      blocks.push({ x: hx, z: hz, r: 0.6 });
    }

    doors.push({ project: p, x: dr.x + fx * 0.9, z: dr.z + fz * 0.9, yaw: dr.yaw, title: p.title || p.id, h });
    labels.push({ x: plot.cx, y: h + (pitched ? 4.2 : 2.2), z: plot.cz, text: p.title || p.id, sub: (p.lang || '') + (p.files ? ' · ' + p.files + ' files' : ''), project: p });
    blocks.push({ poly: base, x: plot.cx, z: plot.cz, r: Math.sqrt(plot.area) * 0.7 });
  }

  /* ── 广场:中间一盏大灯、四张长椅(坐得下,才有人停下来) ── */
  for (const pz of (props ? plan.plazas : [])) {
    const lk = kelvin(D.light.lampK);
    lights.push({ x: pz.cx, y: 4.4, z: pz.cz, r: 20, col: [lk[0], lk[1] * 0.92, lk[2] * 0.78], k: 2.6 });
    S.tube([pz.cx, 0, pz.cz], [pz.cx, 4.4, pz.cz], 0.12, sp(MAT.metal, [0.2, 0.21, 0.23]));
    for (let i = 0; i < 34; i++) G(pz.cx + (rnd() - 0.5) * 0.45, 4.42 + (rnd() - 0.5) * 0.4, pz.cz + (rnd() - 0.5) * 0.45, [0.85, 0.75, 0.56], 0.1 + rnd() * 0.06, 0.35, 1);
    blocks.push({ x: pz.cx, z: pz.cz, r: 0.5 });
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + 0.4, bx = pz.cx + Math.cos(a) * pz.r * 0.6, bz = pz.cz + Math.sin(a) * pz.r * 0.6;
      const rx = [Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2)], fw = [Math.cos(a), 0, Math.sin(a)];
      S.box([bx, 0.42, bz], rx, fw, 2.2, 0.12, 0.5, sp(MAT.wood, [0.42, 0.3, 0.2]));
      S.box([bx, 0, bz], rx, fw, 2.2, 0.42, 0.14, sp(MAT.metal, [0.22, 0.23, 0.25]));
      blocks.push({ x: bx, z: bz, r: 0.9 });
    }
  }

  /* ── 公园的树(草地本身在俯视图里) ── */
  for (const pk of (props ? plan.parks : [])) {
    const n = Math.max(1, Math.round(Math.sqrt(pk.area) / 4.5));
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * Math.sqrt(pk.area) * 0.3;
      const x = pk.cx + Math.cos(a) * r, z = pk.cz + Math.sin(a) * r, hh = 4 + rnd() * 4;
      tree(S, x, z, hh, rnd, [0.12, 0.26, 0.15], [0.2, 0.36, 0.22]);
      blocks.push({ x, z, r: 0.5 });
      if (rnd() < 0.35) for (let k = 0; k < 10; k++) G(x + (rnd() - 0.5) * 2, hh * 0.7 + rnd() * 1.4, z + (rnd() - 0.5) * 2, [0.45, 0.8, 0.5], 0.09, 0.6, 4);
    }
  }

  /* ── 路灯:大道和街上每 26 米一盏 ── */
  for (const st of (props ? plan.streets : [])) {
    if (st.rank === 'lane') continue;
    const a = plan.nodes[st.a], b = plan.nodes[st.b];
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.floor(L / 26));
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1), x = lerp(a.x, b.x, t) + st.w * 0.42, z = lerp(a.z, b.z, t);
      S.tube([x, 0, z], [x, 3.6, z], 0.07, sp(MAT.metal, [0.2, 0.21, 0.23]));
      for (let k = 0; k < 13; k++) G(x + (rnd() - 0.5) * 0.24, 3.62 + (rnd() - 0.5) * 0.2, z + (rnd() - 0.5) * 0.24, [0.85, 0.72, 0.52], 0.095, 0.35, 1);
      lights.push({ x, y: 3.6, z, r: 11, col: [1, 0.84, 0.62], k: 1.3 });
      blocks.push({ x, z, r: 0.35 });
    }
  }

  return { S, U, lights, blocks, doors, labels };
}

/** 灯有上限(顶点 uniform 只放得下 24 盏):每帧挑离人最近的那几盏。 */
export function nearestLights(lights, x, z, n = 24) {
  return lights
    .map((l) => ({ l, d: (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((q) => q.l);
}
