/**
 * town-build.js — 把小镇的图纸(town-plan.js)盖成粒子。
 *
 *   别墅       town-villa.js:每个项目一栋,**外观照它里面的平面图和风格盖**,缩到真别墅的尺度
 *   不是谁家的  town-landmarks.js:城墙、城门、桥、集市、教堂、城门里的老房子、风车、水磨、谷仓……
 *   树、烟、转的和飘的  town-nature.js(这里只登记它们在哪)
 *
 * 地、街、广场、公园、田**不在这里** —— 它们是 town-ground.js 那张俯视图上的颜色,由一圈
 * 跟着人走的点画出来。(第一版把地也铺成固定的点:两千五百万颗,脚下全是半米大的球。)
 *
 * ⚠ 细长的装饰几何是天坑:一条 10 米长 12 厘米高的腰线 = 3000 颗点(方片最小 4×4),
 * 一栋楼四十几条 —— 纹样一律交给材质。
 */
import { Surfaces, makeUniforms, MAT } from './room-surface.js';
import { langRgb } from './lang-colors.js';
import { asLight } from './room-interior.js';
import { designOf } from './room-styles.js';
import { styleOf, seedOf, picker } from './city-styles.js';
import { buildVilla, massingOf, fakeDir } from './town-villa.js';
import { buildLandmarks } from './town-landmarks.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

/** 走进这栋房子时进的是哪个目录:城市里最高的那座楼 = 字节最多的顶层目录。 */
export function villaDir(p) {
  const cap = (p && p.project && p.project.capsule) || (p && p.capsule) || null;
  const dirs = cap && Array.isArray(cap.dirs) ? cap.dirs.filter((d) => d && d.name) : [];
  if (!dirs.length) return null;
  return dirs.slice().sort((a, b) => (+b.bytes || 0) - (+a.bytes || 0))[0];
}
/** 这个项目的别墅风格(和屋里 createRoom 用的是同一个)。 */
export function villaStyle(p) {
  const cap = (p && p.project && p.project.capsule) || null;
  return styleOf((cap && cap.style) || p.style || 'modern').id;
}
/** 一栋别墅外面多大、什么形:给 planTown 用(fw × fd),盖的时候再用一次。 */
export function villaMassing(p) {
  const style = villaStyle(p);
  const rnd = picker(seedOf('villa:' + p.id)).f;
  const dir = villaDir(p) || fakeDir(p, rnd);
  const mass = Math.log10(1 + (+p.bytes || 0) / 1000);
  // 大项目的别墅大一点:14–22 米
  return Object.assign(massingOf(dir, style, 14 + Math.min(8, mass * 1.6)), { style });
}

/**
 * 把图纸盖起来。
 * @param {object} plan town-plan.js 的图纸
 * @param {object} o    { budget, uniforms, G(x,y,z,col,size,tw,kind), seed, spacing, only, props }
 */
export function buildTown(plan, o = {}) {
  const B = Math.max(0.25, Math.min(1, o.budget || 1));
  const S = new Surfaces(o.spacing || (B >= 0.9 ? 0.16 : B >= 0.6 ? 0.2 : 0.26));
  const U = o.uniforms || makeUniforms();
  const G = o.G || (() => {});
  const rnd = picker(seedOf('town:' + plan.plots.length + ':' + (o.seed || ''))).f;
  /* only:只盖这几栋(近处那份细的);props === false:不属于哪栋房子的东西归那份粗的管,
     两份都盖一遍就是两遍的灯和两遍的树。 */
  const only = o.only ? new Set(o.only) : null;
  const props = o.props !== false;
  const out = {
    lights: [], blocks: [], doors: [], labels: [], perches: [], smokes: [], flowers: [], trees: [], lamps: [],
    banners: [], cloths: [], mills: [], gates: [], stalls: [], benches: [], rowhouses: [], villas: [],
    bell: null, landmark: null, doorY: 0,
  };
  const seed = rnd() * 10;
  const sp = (mat, c1, c2) => ({ mat, c1, c2: c2 || c1, seed });

  /* ── 别墅 ── */
  for (const plot of plan.plots) {
    if (only && !only.has(plot.id)) continue;
    const p = plot.project;
    const m0 = p.massing || villaMassing(p);
    const style = m0.style || villaStyle(p);
    // 地块比平面图小的时候整体缩一点(只缩水平方向,门和层高不变)
    const kk = Math.min(1, (plot.w || m0.bw) / m0.bw, (plot.d || m0.bd) / m0.bd);
    const m = kk < 0.999 ? Object.assign({}, m0, {
      bw: m0.bw * kk, bd: m0.bd * kk,
      blocks: m0.blocks.map((b) => Object.assign({}, b, { x0: b.x0 * kk, x1: b.x1 * kk, z0: b.z0 * kk, z1: b.z1 * kk })),
    }) : m0;
    const lang = asLight(langRgb(String(p.lang || '').toLowerCase()));
    const vr = picker(seedOf('villa:' + plot.id)).f;
    const res = buildVilla({ S, G, rnd: vr, plot, style, D: designOf(style), lang, m, out });
    // 门洞里一层这个项目语言色的光幕(走近了就知道这是谁家)
    const dxr = plot.fz, dzr = -plot.fx;
    const fzF = res.frontZ != null ? res.frontZ : m.bd / 2;
    for (let k = 0, n = Math.round(160 * B) + 40; k < n; k++) {
      const u = (vr() * 2 - 1) * 0.55, y = res.door.y + 0.35 + vr() * 1.9;
      G(plot.cx + dxr * u + plot.fx * (fzF + 0.12), y, plot.cz + dzr * u + plot.fz * (fzF + 0.12), [lang[0] * 0.95, lang[1] * 0.95, lang[2] * 0.95], 0.05 + vr() * 0.04, 0.8, 2);
    }
    out.doors.push({ project: p, x: res.door.x, z: res.door.z, yaw: Math.atan2(-plot.fx, -plot.fz), title: p.title || p.id, h: res.top, style, trade: plot.trade });
    out.labels.push({ x: plot.cx, y: res.top + 1.6, z: plot.cz, text: p.title || p.id, sub: (p.lang || '') + (p.files ? ' · ' + p.files + ' files' : ''), project: p });
    out.villas.push({ id: plot.id, x: plot.cx, z: plot.cz, fx: plot.fx, fz: plot.fz, door: res.door, top: res.top, w: m.bw, d: m.bd, style, trade: plot.trade });
    // 门口的招牌(做买卖的人家)
    if (plot.trade && plot.trade !== 'home') {
      const sx = plot.cx + plot.fx * (fzF + 0.4) + dxr * 1.6, sz = plot.cz + plot.fz * (fzF + 0.4) + dzr * 1.6;
      S.tube([sx, 0, sz], [sx, 3.1, sz], 0.05, sp(MAT.wood, [0.25, 0.17, 0.1]));
      S.tube([sx, 2.9, sz], [sx + plot.fx * 0.9, 2.9, sz + plot.fz * 0.9], 0.035, sp(MAT.metal, [0.15, 0.15, 0.16]));
      const SIGN = { tavern: [0.55, 0.32, 0.1], smithy: [0.25, 0.26, 0.3], bakery: [0.7, 0.55, 0.3], weaver: [0.4, 0.2, 0.45], cooper: [0.45, 0.3, 0.16] };
      for (const s of [-1, 1]) S.quad([sx + plot.fx * 0.15, 2.05, sz + plot.fz * 0.15], [plot.fx * 0.7, 0, plot.fz * 0.7], [0, 0.75, 0], sp(MAT.wood, SIGN[plot.trade] || [0.4, 0.3, 0.2], [0.8, 0.7, 0.3]), [dxr * s, 0, dzr * s]);
      out.blocks.push({ x: sx, z: sz, r: 0.25 });
      if (plot.trade === 'smithy' || plot.trade === 'bakery') {
        // 炉火:门边一团一直亮着的橙光
        const fx0 = plot.cx + plot.fx * (fzF + 0.2) - dxr * 2.2, fz0 = plot.cz + plot.fz * (fzF + 0.2) - dzr * 2.2;
        out.lights.push({ x: fx0, y: 1.2, z: fz0, r: 6, col: [1, 0.45, 0.15], k: 1.6 });
        for (let k = 0; k < 40; k++) G(fx0 + (vr() - 0.5) * 0.6, 0.6 + vr() * 1.1, fz0 + (vr() - 0.5) * 0.6, [1, 0.35 + vr() * 0.3, 0.08], 0.1, 0.9, 2);
        out.smokes.push({ x: fx0, y: res.top + 0.3, z: fz0, k: 1.3 });
      }
      if (plot.trade === 'tavern') {
        for (const s of [-1, 1]) {
          const bx = plot.cx + plot.fx * (fzF + 2.2) + dxr * s * 3, bz = plot.cz + plot.fz * (fzF + 2.2) + dzr * s * 3;
          S.box([bx, 0.45, bz], [dxr, 0, dzr], [plot.fx, 0, plot.fz], 1.8, 0.08, 0.5, sp(MAT.wood, [0.35, 0.25, 0.16]));
          S.box([bx, 0, bz], [dxr, 0, dzr], [plot.fx, 0, plot.fz], 1.6, 0.45, 0.1, sp(MAT.wood, [0.28, 0.2, 0.13]));
          out.benches.push({ x: bx, z: bz, yaw: Math.atan2(plot.fx, plot.fz) });
          out.blocks.push({ x: bx, z: bz, r: 0.6 });
        }
      }
    }
  }

  if (!props) return Object.assign({ S, U }, out);

  /* ── 城墙、城门、集市、教堂、老房子、墙外 ──
     ⚠ 单独一份点:粗的那份在人身边 15 米以内是不画的(那一圈归细的那份,而细的那份只有最近几栋别墅),
     城门、井、摊子放在粗的那份里,走到跟前就没了 —— 从城里往外看,城门只剩两根细条。 */
  const SL = new Surfaces(o.landSpacing || (B >= 0.9 ? 0.2 : B >= 0.6 ? 0.24 : 0.3));
  buildLandmarks({ S: SL, G, rnd, plan, out });
  out.SL = SL;

  /* ── 别的广场:一口饮水槽、一盏灯、几张长椅 ── */
  const M = plan.world && plan.world.market;
  const S0 = S;
  {
  const S = SL;
  for (const pz of plan.plazas) {
    if (M && Math.hypot(pz.cx - M.x, pz.cz - M.z) < 1) continue;
    out.lights.push({ x: pz.cx, y: 3.4, z: pz.cz, r: 16, col: [1, 0.8, 0.55], k: 2 });
    out.lamps.push({ x: pz.cx, y: 3.4, z: pz.cz });
    S.tube([pz.cx, 0, pz.cz], [pz.cx, 3.2, pz.cz], 0.1, sp(MAT.wood, [0.25, 0.17, 0.1]));
    for (let i = 0; i < 24; i++) G(pz.cx + (rnd() - 0.5) * 0.35, 3.4 + (rnd() - 0.5) * 0.35, pz.cz + (rnd() - 0.5) * 0.35, [0.9, 0.72, 0.46], 0.1, 0.35, 1);
    S.box([pz.cx + 1.6, 0, pz.cz], [1, 0, 0], [0, 0, 1], 2, 0.6, 0.6, sp(MAT.stone, [0.42, 0.41, 0.39]));
    S.quad([pz.cx + 0.65, 0.45, pz.cz - 0.25], [1.9, 0, 0], [0, 0, 0.5], sp(MAT.water, [0.06, 0.09, 0.11]), [0, 1, 0]);
    out.blocks.push({ x: pz.cx, z: pz.cz, r: 0.4 }, { x: pz.cx + 1.6, z: pz.cz, r: 1.1 });
    out.perches.push({ x: pz.cx, y: 3.3, z: pz.cz });
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * TAU + 0.4, bx = pz.cx + Math.cos(a) * pz.r * 0.6, bz = pz.cz + Math.sin(a) * pz.r * 0.6;
      const rx = [Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2)], fw = [Math.cos(a), 0, Math.sin(a)];
      S.box([bx, 0.42, bz], rx, fw, 1.8, 0.1, 0.45, sp(MAT.wood, [0.38, 0.27, 0.17]));
      S.box([bx, 0, bz], rx, fw, 1.6, 0.42, 0.12, sp(MAT.stone, [0.35, 0.34, 0.33]));
      out.blocks.push({ x: bx, z: bz, r: 0.8 });
      out.benches.push({ x: bx, z: bz, yaw: a });
    }
  }

  /* ── 路灯:木杆挑一盏灯笼,大道和街上每 22 米一盏 ── */
  for (const st of plan.streets) {
    if (st.rank === 'lane') continue;
    const a = plan.nodes[st.a], b = plan.nodes[st.b];
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.floor(L / 22));
    const ux = (b.x - a.x) / (L || 1), uz = (b.z - a.z) / (L || 1);
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1), side = i % 2 ? 1 : -1;
      const x = lerp(a.x, b.x, t) - uz * side * (st.w * 0.5 - 0.4), z = lerp(a.z, b.z, t) + ux * side * (st.w * 0.5 - 0.4);
      if (plan.plots.some((p) => Math.hypot(p.cx - x, p.cz - z) < Math.sqrt(p.area) * 0.8)) continue;
      S.tube([x, 0, z], [x, 3.3, z], 0.07, sp(MAT.wood, [0.24, 0.16, 0.1]));
      S.tube([x, 3.2, z], [x + uz * side * 0.6, 3.2, z - ux * side * 0.6], 0.03, sp(MAT.metal, [0.15, 0.15, 0.16]));
      const lx = x + uz * side * 0.6, lz = z - ux * side * 0.6;
      for (let k = 0; k < 12; k++) G(lx + (rnd() - 0.5) * 0.2, 2.95 + (rnd() - 0.5) * 0.22, lz + (rnd() - 0.5) * 0.2, [0.92, 0.72, 0.46], 0.095, 0.35, 1);
      out.lights.push({ x: lx, y: 2.95, z: lz, r: 10, col: [1, 0.8, 0.55], k: 1.2 });
      out.lamps.push({ x: lx, y: 2.95, z: lz });
      out.blocks.push({ x, z, r: 0.3 });
      out.perches.push({ x, y: 3.35, z });
    }
  }
  }

  return Object.assign({ S: S0, U }, out);
}

/** 灯有上限(顶点 uniform 只放得下 24 盏):每帧挑离人最近的那几盏。 */
export function nearestLights(lights, x, z, n = 24) {
  return lights
    .map((l) => ({ l, d: (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((q) => q.l);
}
