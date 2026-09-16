/**
 * town-landmarks.js — 镇上不属于哪个项目的那些东西:城墙、城门、桥、集市、教堂、风车、
 * 水磨、谷仓、篱笆、大车、干草,还有城门里那几排木骨泥墙的老房子。
 *
 * 尺寸照真实的中世纪小镇(研究笔记):
 *   城墙 5.6 米高、2 米厚,四五十米一座塔;城门洞 4 米宽、4.5 米高;
 *   井口 1.5 米宽、0.9 米高,上面一个 2.2 米的木架;市场十字 4.5 米;摊子 2.6×1.8,棚高 2.2;
 *   教堂塔 17–21 米,尖顶再加 13–18;风车 11 米、叶片半径 8;水车直径 5 米;
 *   大车 2.0×1.1,轮子 1.1;木骨泥墙的房子门脸 5–7 米、两三层、每层往外探 0.45。
 *
 * ⚠ 细长的东西(篱笆、绳子、窗框)不做几何,交给材质:见 town-build 开头那条注释。
 */
import { MAT } from './room-surface.js';
import { trap, tri } from './town-villa.js';
import { insideConvex, polylineDist, wallRadiusAt } from './town-plan.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** 一个朝 (fx,fz) 的局部坐标系:P(u, y, v),u 沿 r、v 沿 f。 */
function frame(cx, cz, fx, fz) {
  const L = Math.hypot(fx, fz) || 1;
  fx /= L; fz /= L;
  const rx = fz, rz = -fx;
  return {
    P: (u, y, v) => [cx + rx * u + fx * v, y, cz + rz * u + fz * v],
    V: (du, dy, dv) => [rx * du + fx * dv, dy, rz * du + fz * dv],
    r: [rx, 0, rz], f: [fx, 0, fz],
  };
}

export function buildLandmarks(ctx) {
  const { S, G, rnd, plan, out } = ctx;
  const W = plan.world;
  if (!W) return;
  const seed = rnd() * 10;
  const sp = (mat, c1, c2, flags) => ({ mat, c1, c2: c2 || c1, seed, flags: flags || 0 });
  const stone = sp(MAT.stone, [0.42, 0.4, 0.37], [0.3, 0.29, 0.27]);
  const stoneL = sp(MAT.stone, [0.45, 0.43, 0.4], [0.33, 0.32, 0.3]);
  const oak = sp(MAT.wood, [0.26, 0.18, 0.12], [0.18, 0.12, 0.08]);
  const tile = sp(MAT.rooftile, [0.42, 0.2, 0.13], [0.3, 0.14, 0.09]);
  const slate = sp(MAT.shingle, [0.2, 0.21, 0.24], [0.28, 0.29, 0.32]);
  const thatch = sp(MAT.thatch, [0.46, 0.38, 0.22], [0.2, 0.26, 0.14]);
  const lantern = (x, y, z, r = 9, big = false) => {
    out.lights.push({ x, y, z, r, col: [1, 0.78, 0.5], k: big ? 1.8 : 1.2 });
    out.lamps.push({ x, y, z });
    for (let k = 0; k < (big ? 18 : 11); k++) G(x + (rnd() - 0.5) * 0.2, y + (rnd() - 0.5) * 0.22, z + (rnd() - 0.5) * 0.2, [0.95, 0.74, 0.46], 0.09, 0.35, 1);
  };
  const block = (x, z, r) => out.blocks.push({ x, z, r });
  const polyBlock = (pts) => {
    const x = pts.reduce((a, p) => a + p[0], 0) / pts.length, z = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    out.blocks.push({ poly: pts, x, z, r: Math.max(...pts.map((p) => Math.hypot(p[0] - x, p[1] - z))) + 0.5 });
  };

  /* ── 城墙 ── */
  const wallH = W.wall.h, gateHalf = (G0) => (G0.w / 2 + 3.2) / wallRadiusAt(W, G0.a);
  const nearGate = (a) => W.wall.gates.find((G0) => { let d = Math.abs(a - G0.a) % TAU; if (d > Math.PI) d = TAU - d; return d < gateHalf(G0); });
  const pts = W.wall.pts;
  let sinceTower = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const am = Math.atan2(a[1] + b[1], a[0] + b[0]);
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    const nx = (a[0] + b[0]) / 2, nz = (a[1] + b[1]) / 2, NL = Math.hypot(nx, nz);
    const on = [nx / NL, 0, nz / NL];                                   // 朝外
    sinceTower += L;
    if (nearGate(Math.atan2(a[1], a[0])) || nearGate(Math.atan2(b[1], b[0])) || nearGate(am)) { sinceTower = 0; continue; }
    // 外面、里面两面,顶上一条走道,外沿一排城垛
    S.quad([a[0] + on[0], 0, a[1] + on[2]], [ex, 0, ez], [0, wallH, 0], stone, on);
    S.quad([a[0] - on[0], 0, a[1] - on[2]], [ex, 0, ez], [0, wallH - 0.9, 0], stone, [-on[0], 0, -on[2]]);
    S.quad([a[0] - on[0], wallH - 0.9, a[1] - on[2]], [ex, 0, ez], [on[0] * 2, 0, on[2] * 2], stoneL, [0, 1, 0]);
    const k = Math.floor(L / 1.6);
    for (let j = 0; j < k; j += 2) {
      const t = (j + 0.5) / k;
      S.box([lerp(a[0], b[0], t) + on[0] * 0.85, wallH, lerp(a[1], b[1], t) + on[2] * 0.85], [ex / L, 0, ez / L], on, 1.2, 0.7, 0.35, stone, { bottom: false });
    }
    out.perches.push({ x: nx - on[0] * 0.3, y: wallH - 0.85, z: nz - on[2] * 0.3 });
    // 墙:一段段凸多边形挡着
    polyBlock([[a[0] + on[0] * 1.2, a[1] + on[2] * 1.2], [b[0] + on[0] * 1.2, b[1] + on[2] * 1.2], [b[0] - on[0] * 1.2, b[1] - on[2] * 1.2], [a[0] - on[0] * 1.2, a[1] - on[2] * 1.2]]);
    // 塔:四五十米一座,圆的,锥顶
    if (sinceTower > 44) {
      sinceTower = 0;
      const tr = 3.2, th = wallH + 3.8;
      S.cyl([a[0], 0, a[1]], tr, th, stone);
      coneRoof(S, [a[0], th, a[1]], tr + 0.5, 4.2, slate, 10);
      for (let q = 0; q < 6; q++) {
        const aa = q / 6 * TAU;
        lantern(a[0] + Math.cos(aa) * (tr + 0.05), th - 1.6, a[1] + Math.sin(aa) * (tr + 0.05), 0, false);
      }
      block(a[0], a[1], tr + 0.3);
      out.perches.push({ x: a[0], y: th + 4.1, z: a[1] });
    }
  }
  /* ── 城门:两座方塔夹着门洞,上面一段带顶的门楼;门外一座木桥过护城河 ── */
  for (const G0 of W.wall.gates) {
    const F = frame(G0.x, G0.z, Math.cos(G0.a), Math.sin(G0.a));     // f 朝城外
    const tw = 4.2, gw = G0.w, th = wallH + 5.5;
    for (const s of [-1, 1]) {
      const u = s * (gw / 2 + tw / 2);
      S.box(F.P(u, 0, 0), F.r, F.f, tw, th, 5, stone);
      // 塔顶的城垛
      for (const [du, dv] of [[-1.4, 2.4], [0, 2.4], [1.4, 2.4], [-1.4, -2.4], [1.4, -2.4]]) S.box(F.P(u + du, th, dv), F.r, F.f, 0.9, 0.7, 0.3, stone, { bottom: false });
      block(...[F.P(u, 0, 0)[0], F.P(u, 0, 0)[2]], 2.9);
      lantern(...F.P(s * (gw / 2 + 0.3), 3.4, 2.7), 12, true);
      lantern(...F.P(s * (gw / 2 + 0.3), 3.4, -2.7), 12, false);
      out.perches.push({ x: F.P(u, 0, 0)[0], y: th + 0.7, z: F.P(u, 0, 0)[2] });
      // 塔上的旗
      const pole = F.P(u, th, 0);
      S.tube(pole, add(pole, [0, 3.2, 0]), 0.05, oak);
      out.banners.push({ x: pole[0], y: pole[1] + 2.4, z: pole[2], dx: F.r[0], dz: F.r[2], col: s > 0 ? [0.55, 0.1, 0.08] : [0.12, 0.2, 0.45] });
    }
    // 门洞上面的门楼
    S.box(F.P(0, 4.6, 0), F.r, F.f, gw, th - 4.6 - 1.2, 5, stone, { bottom: true });
    S.quad(F.P(-gw / 2, 4.3, 2.5), F.V(gw, 0, 0), [0, 0.3, 0], sp(MAT.lattice, [0.12, 0.1, 0.08], [0.25, 0.2, 0.15]), F.f);   // 吊闸的底
    const rb = { u0: -gw / 2 - tw, u1: gw / 2 + tw };
    trap(S, F.P(rb.u0, th, 2.8), F.P(rb.u1, th, 2.8), F.P(rb.u1 - 2.5, th + 2.6, 0), F.P(rb.u0 + 2.5, th + 2.6, 0), tile, F.V(0, 1, 1));
    trap(S, F.P(rb.u1, th, -2.8), F.P(rb.u0, th, -2.8), F.P(rb.u0 + 2.5, th + 2.6, 0), F.P(rb.u1 - 2.5, th + 2.6, 0), tile, F.V(0, 1, -1));
    tri(S, F.P(rb.u0, th, -2.8), F.P(rb.u0, th, 2.8), F.P(rb.u0 + 2.5, th + 2.6, 0), tile, F.V(-1, 1, 0));
    tri(S, F.P(rb.u1, th, 2.8), F.P(rb.u1, th, -2.8), F.P(rb.u1 - 2.5, th + 2.6, 0), tile, F.V(1, 1, 0));
    // 桥:从门口跨过护城河
    const b0 = W.moat.r0 - 1.8 - wallRadiusAt(W, G0.a), b1 = W.moat.r1 + 2 - wallRadiusAt(W, G0.a);
    S.box(F.P(0, 0.05, (b0 + b1) / 2), F.r, F.f, gw + 0.6, 0.3, b1 - b0, sp(MAT.wood, [0.32, 0.23, 0.15], [0.22, 0.16, 0.1]), { bottom: true });
    for (const s of [-1, 1]) {
      S.quad(F.P(s * (gw / 2 + 0.3), 0.35, b0), F.V(0, 0, b1 - b0), [0, 0.9, 0], sp(MAT.lattice, [0.3, 0.22, 0.14], [0.25, 0.18, 0.12]), F.V(s, 0, 0));
      for (let v = b0; v <= b1; v += 2.4) S.tube(F.P(s * (gw / 2 + 0.3), -1.2, v), F.P(s * (gw / 2 + 0.3), 1.3, v), 0.09, oak);
    }
    out.gates.push({ x: G0.x, z: G0.z, a: G0.a });
    // 门口一辆大车、几捆干草
    cart(F.P(gw / 2 + 5.5, 0, -6), F.f);
    hay(F.P(-gw / 2 - 5, 0, -5.5), 1.1);
  }

  /* ── 集市:井、市场十字、摊子 ── */
  const M = W.market;
  if (M) {
    const w0 = [M.well.x, 0, M.well.z];
    S.cyl(w0, 0.8, 0.9, stoneL);
    S.disc([w0[0], 0.9, w0[2]], 0.55, 0.85, stoneL);
    S.disc([w0[0], 0.35, w0[2]], 0, 0.55, sp(MAT.water, [0.05, 0.08, 0.1]));
    for (const s of [-1, 1]) S.tube([w0[0] + s * 0.75, 0.9, w0[2]], [w0[0] + s * 0.75, 2.5, w0[2]], 0.08, oak);
    S.tube([w0[0] - 0.9, 2.3, w0[2]], [w0[0] + 0.9, 2.3, w0[2]], 0.06, oak);
    for (const s of [-1, 1]) S.quad([w0[0] - 1.1, 2.9, w0[2]], [2.2, 0, 0], [0, -0.55, s * 1.05], thatch, [0, 1, s]);
    S.box([w0[0] + 0.3, 1.2, w0[2]], [1, 0, 0], [0, 0, 1], 0.3, 0.35, 0.3, oak);             // 水桶
    block(w0[0], w0[2], 1.1);
    out.perches.push({ x: w0[0], y: 2.95, z: w0[2] });
    // 市场十字:台阶 + 石柱 + 顶上一个十字
    const c0 = [M.cross.x, 0, M.cross.z];
    for (let i = 0; i < 3; i++) S.box([c0[0], i * 0.25, c0[2]], [1, 0, 0], [0, 0, 1], 2.6 - i * 0.6, 0.25, 2.6 - i * 0.6, stoneL, { bottom: false });
    S.tube([c0[0], 0.75, c0[2]], [c0[0], 4.6, c0[2]], 0.16, stoneL);
    S.box([c0[0], 4.3, c0[2]], [1, 0, 0], [0, 0, 1], 0.9, 0.16, 0.16, stoneL);
    block(c0[0], c0[2], 1.4);
    out.perches.push({ x: c0[0], y: 4.65, z: c0[2] });
    lantern(c0[0] + 0.5, 3.4, c0[2], 18, true);
    // 摊子:四根柱、一块斜棚(条纹布)、一张台面,台上是货
    const AWN = [[[0.55, 0.12, 0.1], [0.85, 0.8, 0.7]], [[0.14, 0.26, 0.5], [0.85, 0.8, 0.7]], [[0.2, 0.4, 0.22], [0.82, 0.74, 0.5]], [[0.6, 0.45, 0.12], [0.5, 0.15, 0.1]]];
    const GOODS = [[0.7, 0.2, 0.15], [0.85, 0.6, 0.2], [0.35, 0.55, 0.2], [0.75, 0.7, 0.55], [0.5, 0.3, 0.6], [0.6, 0.45, 0.3]];
    M.stalls.forEach((st, i) => {
      const F = frame(st.x, st.z, Math.sin(st.yaw) * -1, Math.cos(st.yaw) * -1);
      const aw = AWN[i % AWN.length];
      for (const [u, v, hh] of [[-1.3, -0.9, 2.5], [1.3, -0.9, 2.5], [-1.3, 0.9, 2.1], [1.3, 0.9, 2.1]]) S.tube(F.P(u, 0, v), F.P(u, hh, v), 0.05, oak);
      S.quad(F.P(-1.45, 2.55, -1.05), F.V(2.9, 0, 0), add(F.V(0, 0, 2.3), [0, -0.55, 0]), sp(MAT.bands4, aw[0], aw[1]), F.V(0, 1, 0.3));
      S.box(F.P(0, 0, 0.7), F.r, F.f, 2.4, 0.9, 0.6, sp(MAT.wood, [0.36, 0.25, 0.16]));
      const gc = GOODS[(st.goods + i) % GOODS.length];
      for (let k = 0; k < 60; k++) {
        const q = F.P((rnd() - 0.5) * 2.2, 0.95 + rnd() * 0.18, 0.7 + (rnd() - 0.5) * 0.5);
        S.dot(q, [0, 1, 0], rnd() < 0.2 ? [0.3, 0.22, 0.14] : gc.map((c) => c * (0.8 + rnd() * 0.3)), 0.14);
      }
      // 摊子边上的木桶、筐
      S.cyl(F.P(1.7, 0, 0.3), 0.3, 0.8, sp(MAT.wood, [0.36, 0.24, 0.14]));
      S.disc(F.P(1.7, 0.8, 0.3), 0, 0.3, sp(MAT.wood, [0.3, 0.2, 0.12]));
      const pts4 = [[1.5, 1.2], [-1.5, 1.2], [-1.5, -1.1], [1.5, -1.1]].map(([u, v]) => { const q = F.P(u, 0, v); return [q[0], q[2]]; });
      polyBlock(pts4);
      out.stalls.push({ x: st.x, z: st.z, fx: F.f[0], fz: F.f[2] });
      out.perches.push({ x: F.P(0, 2.4, 0)[0], y: 2.4, z: F.P(0, 2.4, 0)[2] });
    });
    // 广场四角的长椅
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + 0.8, bx = M.x + Math.cos(a) * M.r * 0.42, bz = M.z + Math.sin(a) * M.r * 0.42;
      S.box([bx, 0.42, bz], [Math.cos(a + Math.PI / 2), 0, Math.sin(a + Math.PI / 2)], [Math.cos(a), 0, Math.sin(a)], 1.8, 0.1, 0.45, sp(MAT.wood, [0.38, 0.27, 0.17]));
      block(bx, bz, 0.7);
      out.benches.push({ x: bx, z: bz, yaw: a });
    }
  }

  /* ── 教堂 ── */
  const C = W.church;
  if (C) {
    const F = frame(C.x, C.z, C.fx, C.fz);    // f 朝东(祭坛那头)
    const nw = C.w, nd = C.d, nh = 8.5;
    const wallS = sp(MAT.stone, [0.5, 0.48, 0.44], [0.36, 0.34, 0.31]);
    // 中殿:长方的墙 + 陡的石板顶
    for (const [o, U, n] of [[F.P(-nw / 2, 0, -nd / 2), F.V(0, 0, nd), F.V(-1, 0, 0)], [F.P(nw / 2, 0, -nd / 2), F.V(0, 0, nd), F.V(1, 0, 0)]]) {
      S.quad(o, U, [0, nh, 0], wallS, n);
    }
    S.quad(F.P(-nw / 2, 0, nd / 2), F.V(nw, 0, 0), [0, nh, 0], wallS, F.f);
    const rise = nw / 2 * Math.tan(0.95);
    for (const s of [-1, 1]) S.quad(F.P(0, nh + rise, -nd / 2 - 0.3), F.V(0, 0, nd + 0.6), add(F.V(s * (nw / 2 + 0.5), 0, 0), [0, -rise - 0.5 * Math.tan(0.95), 0]), slate, F.V(s, 1, 0));
    tri(S, F.P(-nw / 2, nh, nd / 2), F.P(nw / 2, nh, nd / 2), F.P(0, nh + rise, nd / 2), wallS, F.f);
    // 尖拱的彩色玻璃窗:两边各一排,夜里透出彩光
    const GLASS = [[0.8, 0.2, 0.2], [0.2, 0.35, 0.85], [0.9, 0.7, 0.2], [0.3, 0.7, 0.4]];
    for (const s of [-1, 1]) for (let v = -nd / 2 + 3.5; v < nd / 2 - 1; v += 3.2) {
      const o = F.P(s * (nw / 2 + 0.05), 2.4, v - 0.55);
      S.quad(o, F.V(0, 0, 1.1), [0, 3.2, 0], sp(MAT.mosaic, [0.2, 0.25, 0.5], [0.55, 0.15, 0.12], 2), F.V(s, 0, 0));
      tri(S, F.P(s * (nw / 2 + 0.05), 5.6, v - 0.55), F.P(s * (nw / 2 + 0.05), 5.6, v + 0.55), F.P(s * (nw / 2 + 0.05), 6.4, v), sp(MAT.mosaic, [0.2, 0.25, 0.5], [0.55, 0.15, 0.12], 2), F.V(s, 0, 0));
      for (let k = 0; k < 16; k++) {
        const q = F.P(s * (nw / 2 + 0.2), 2.6 + rnd() * 3.4, v + (rnd() - 0.5) * 0.9);
        G(q[0], q[1], q[2], GLASS[k % 4], 0.16, 0.2, 1);
      }
    }
    // 塔:方塔 + 八角尖顶,钟楼开口
    const T = C.tower, ts = T.s;
    const tc = F.P(-nd / 2 + ts / 2 - 0.2, 0, 0);
    // 塔的朝向和中殿一致
    const TT = frame(tc[0], tc[2], C.fx, C.fz);
    for (const [u, v, n, U] of [[-ts / 2, -ts / 2, TT.V(-1, 0, 0), TT.V(0, 0, ts)], [ts / 2, -ts / 2, TT.V(1, 0, 0), TT.V(0, 0, ts)], [-ts / 2, -ts / 2, TT.V(0, 0, -1), TT.V(ts, 0, 0)], [-ts / 2, ts / 2, TT.V(0, 0, 1), TT.V(ts, 0, 0)]]) {
      S.quad(TT.P(u, 0, v), U, [0, T.h, 0], wallS, n);
    }
    // 钟楼的开口(暗的)和挂在里面的钟
    for (const [u, v, n, U] of [[-ts / 2 - 0.05, -0.6, TT.V(-1, 0, 0), TT.V(0, 0, 1.2)], [ts / 2 + 0.05, -0.6, TT.V(1, 0, 0), TT.V(0, 0, 1.2)], [-0.6, ts / 2 + 0.05, TT.V(0, 0, 1), TT.V(1.2, 0, 0)], [-0.6, -ts / 2 - 0.05, TT.V(0, 0, -1), TT.V(1.2, 0, 0)]]) {
      S.quad(TT.P(u, T.h - 4, v), U, [0, 2.4, 0], sp(MAT.glass, [0.04, 0.04, 0.05]), n);
    }
    out.bell = { x: tc[0], y: T.h - 2.6, z: tc[2] };
    // 塔顶一圈矮墙 + 八角尖顶
    coneRoof(S, [tc[0], T.h, tc[2]], ts * 0.62, T.spire, slate, 8);
    S.tube([tc[0], T.h + T.spire, tc[2]], [tc[0], T.h + T.spire + 1.6, tc[2]], 0.05, sp(MAT.goldleaf, [0.8, 0.6, 0.25]));
    S.tube([tc[0] - 0.45, T.h + T.spire + 1.15, tc[2]], [tc[0] + 0.45, T.h + T.spire + 1.15, tc[2]], 0.05, sp(MAT.goldleaf, [0.8, 0.6, 0.25]));
    out.perches.push({ x: tc[0], y: T.h + 0.05, z: tc[2] }, { x: tc[0] + ts / 2, y: T.h, z: tc[2] });
    out.landmark = { x: tc[0], z: tc[2], h: T.h + T.spire };
    // 西门(塔底)
    const door = TT.P(-ts / 2 - 0.06, 0, -0.8);
    S.quad(door, TT.V(0, 0, 1.6), [0, 3, 0], sp(MAT.wood, [0.3, 0.2, 0.12]), TT.V(-1, 0, 0));
    lantern(...TT.P(-ts / 2 - 0.4, 3.4, 1.3), 10);
    // 碰撞
    polyBlock([[nw / 2, nd / 2], [-nw / 2, nd / 2], [-nw / 2, -nd / 2 - 0.2], [nw / 2, -nd / 2 - 0.2]].map(([u, v]) => { const q = F.P(u, 0, v); return [q[0], q[2]]; }));
    block(tc[0], tc[2], ts * 0.72);
    // 墓园:矮石墙没有(挡路),只有墓碑和一棵紫杉
    for (let i = 0; i < 18; i++) {
      const a = rnd() * TAU, r = nd * 0.55 + rnd() * 5;
      const x = C.x + Math.cos(a) * r, z = C.z + Math.sin(a) * r;
      if (!insideConvex([x, z], C.yard)) continue;
      S.box([x, 0, z], [Math.cos(a), 0, Math.sin(a)], [-Math.sin(a), 0, Math.cos(a)], 0.55, 0.7 + rnd() * 0.3, 0.12, sp(MAT.stone, [0.45, 0.45, 0.44]));
      block(x, z, 0.35);
    }
    const yx = C.x + C.fz * (nw / 2 + 4), yz = C.z - C.fx * (nw / 2 + 4);
    if (insideConvex([yx, yz], C.yard)) out.trees.push({ x: yx, z: yz, kind: 'yew', h: 7 });
  }

  /* ── 城门里的老房子:木骨泥墙、一层层探出来、陡的瓦顶、烟囱冒烟 ── */
  const occupied = (x, z, r) => plan.plots.some((p) => Math.hypot(p.cx - x, p.cz - z) < Math.sqrt(p.area) * 0.75 + r)
    || (C && Math.hypot(C.x - x, C.z - z) < C.d / 2 + r + 2) || (M && Math.hypot(M.x - x, M.z - z) < M.r + r)
    || out.rowhouses.some((h) => Math.hypot(h.x - x, h.z - z) < h.r + r);
  for (const G0 of W.wall.gates) {
    const inx = -Math.cos(G0.a), inz = -Math.sin(G0.a);     // 朝城里
    for (let k = 0; k < 5; k++) for (const s of [-1, 1]) {
      const along = 9 + k * 7.2;
      const sx = -inz * s, sz = inx * s;                      // 街的两边
      const x = G0.x + inx * along + sx * 8.5, z = G0.z + inz * along + sz * 8.5;
      if (occupied(x, z, 5)) continue;
      rowhouse(x, z, -sx, -sz, 5.6 + rnd() * 1.6, 8 + rnd() * 2);
    }
  }
  function rowhouse(x, z, fx, fz, w, d) {
    const F = frame(x, z, fx, fz);
    const floors = 2 + (rnd() < 0.4 ? 1 : 0), fh = 2.8, jet = 0.45;
    const lime = [[0.72, 0.66, 0.54], [0.66, 0.6, 0.48], [0.62, 0.56, 0.5], [0.7, 0.62, 0.46]][Math.floor(rnd() * 4)];
    const beam = [0.2, 0.13, 0.09];
    const ht = sp(MAT.halftimber, lime, beam);
    // 底层:石头
    const b0 = { x0: -w / 2, x1: w / 2, z0: -d / 2, z1: d / 2 };
    boxWalls(F, b0, 0, fh, stoneL);
    let top = fh;
    for (let f = 1; f < floors; f++) {
      const j = jet * f;
      const bf = { x0: -w / 2 - j * 0.3, x1: w / 2 + j * 0.3, z0: -d / 2 - j, z1: d / 2 + j };
      boxWalls(F, bf, fh * f, fh * (f + 1), ht);
      // 探出来的那一截的底面
      S.quad(F.P(bf.x0, fh * f, d / 2 + j - jet), F.V(bf.x1 - bf.x0, 0, 0), F.V(0, 0, jet), sp(MAT.wood, beam), [0, -1, 0]);
      // 窗、窗板、花箱
      for (let u = -w / 2 + 1.1; u < w / 2 - 0.6; u += 1.9) {
        const o = F.P(u, fh * f + 0.9, bf.z1 + 0.04);
        S.quad(o, F.V(0.8, 0, 0), [0, 1.1, 0], sp(MAT.lattice, [0.12, 0.1, 0.08], [0.3, 0.24, 0.14]), F.f);
        const shut = [[0.2, 0.32, 0.2], [0.45, 0.14, 0.1], [0.16, 0.24, 0.4]][Math.floor(rnd() * 3)];
        S.quad(add(o, F.V(-0.42, 0, 0.02)), F.V(0.4, 0, 0), [0, 1.1, 0], sp(MAT.wood, shut), F.f);
        S.quad(add(o, F.V(0.82, 0, 0.02)), F.V(0.4, 0, 0), [0, 1.1, 0], sp(MAT.wood, shut), F.f);
        if (rnd() < 0.7) for (let q = 0; q < 8; q++) G(o[0] + F.r[0] * (0.15 + rnd() * 0.5), fh * f + 1.1 + rnd() * 0.7, o[2] + F.r[2] * (0.15 + rnd() * 0.5), [1, 0.72, 0.42], 0.13, 0.25, 1);
        if (rnd() < 0.5) {
          const c = [[0.8, 0.2, 0.25], [0.9, 0.75, 0.3], [0.75, 0.45, 0.8]][Math.floor(rnd() * 3)];
          for (let q = 0; q < 10; q++) S.dot(add(o, F.V(0.4 + (rnd() - 0.5) * 0.8, 0.02 + rnd() * 0.18, 0.18)), [0, 1, 0], q % 3 ? c : [0.2, 0.4, 0.18], 0.09);
          out.flowers.push({ x: o[0], y: fh * f + 1, z: o[2] });
        }
      }
      top = fh * (f + 1);
    }
    // 屋顶:山墙朝街(德式)或檐口朝街(英式)
    const gableFront = rnd() < 0.6;
    const roof = rnd() < 0.55 ? tile : rnd() < 0.5 ? thatch : slate;
    const bt = { x0: -w / 2 - jet, x1: w / 2 + jet, z0: -d / 2 - jet * (floors - 1), z1: d / 2 + jet * (floors - 1) };
    const pitch = 0.95;
    if (gableFront) {
      const half = (bt.x1 - bt.x0) / 2, rise = half * Math.tan(pitch);
      for (const s of [-1, 1]) S.quad(F.P(0, top + rise, bt.z0 - 0.3), F.V(0, 0, bt.z1 - bt.z0 + 0.6), add(F.V(s * (half + 0.35), 0, 0), [0, -rise - 0.35, 0]), roof, F.V(s, 1, 0));
      for (const [v, n] of [[bt.z1, 1], [bt.z0, -1]]) tri(S, F.P(bt.x0, top, v), F.P(bt.x1, top, v), F.P(0, top + rise, v), ht, F.V(0, 0, n));
      out.perches.push({ x: F.P(0, 0, 0)[0], y: top + rise, z: F.P(0, 0, 0)[2] });
      const ch = F.P(half * 0.5, 0, -d * 0.2);
      chimney(ch, top + rise * 0.5, top + rise + 0.8);
    } else {
      const half = (bt.z1 - bt.z0) / 2, rise = half * Math.tan(pitch);
      for (const s of [-1, 1]) S.quad(F.P(bt.x0 - 0.3, top + rise, 0), F.V(bt.x1 - bt.x0 + 0.6, 0, 0), add(F.V(0, 0, s * (half + 0.35)), [0, -rise - 0.35, 0]), roof, F.V(0, 1, s));
      for (const [u, n] of [[bt.x0, -1], [bt.x1, 1]]) tri(S, F.P(u, top, bt.z0), F.P(u, top, bt.z1), F.P(u, top + rise, 0), ht, F.V(n, 0, 0));
      out.perches.push({ x: F.P(0, 0, 0)[0], y: top + rise, z: F.P(0, 0, 0)[2] });
      chimney(F.P(w * 0.3, 0, 0), top + rise * 0.6, top + rise + 0.8);
    }
    // 门、门边的灯、招牌、柴垛、木桶
    const dq = F.P(-w * 0.2, 0, d / 2 + 0.05);
    S.quad(add(dq, F.V(-0.5, 0, 0)), F.V(1, 0, 0), [0, 2.1, 0], sp(MAT.wood, [0.3, 0.2, 0.12]), F.f);
    lantern(...F.P(-w * 0.2 + 0.8, 2.3, d / 2 + 0.3), 7);
    if (rnd() < 0.35) sign(F.P(w * 0.1, 3.2, d / 2 + 0.2), F);
    if (rnd() < 0.6) woodpile(F.P(w / 2 + 0.4, 0, 0), F.f, d * 0.6);
    if (rnd() < 0.5) barrels(F.P(w * 0.3, 0, d / 2 + 0.6), 1 + Math.floor(rnd() * 3));
    const poly = [[w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2], [w / 2, -d / 2]].map(([u, v]) => { const q = F.P(u, 0, v); return [q[0], q[2]]; });
    polyBlock(poly);
    out.rowhouses.push({ x, z, r: Math.hypot(w, d) / 2, door: { x: dq[0] + fx * 0.8, z: dq[2] + fz * 0.8 } });
  }
  function boxWalls(F, b, y0, y1, spec) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    S.quad(F.P(b.x0, y0, b.z1), F.V(w, 0, 0), [0, y1 - y0, 0], spec, F.f);
    S.quad(F.P(b.x0, y0, b.z0), F.V(w, 0, 0), [0, y1 - y0, 0], spec, F.V(0, 0, -1));
    S.quad(F.P(b.x0, y0, b.z0), F.V(0, 0, d), [0, y1 - y0, 0], spec, F.V(-1, 0, 0));
    S.quad(F.P(b.x1, y0, b.z0), F.V(0, 0, d), [0, y1 - y0, 0], spec, F.V(1, 0, 0));
  }
  function chimney(q, y0, y1) {
    S.box([q[0], y0, q[2]], [1, 0, 0], [0, 0, 1], 0.55, y1 - y0, 0.55, sp(MAT.brick, [0.36, 0.2, 0.15], [0.5, 0.48, 0.44]));
    out.smokes.push({ x: q[0], y: y1, z: q[2], k: 1 });
    out.perches.push({ x: q[0], y: y1 + 0.02, z: q[2] });
  }
  function sign(q, F) {
    S.tube(add(q, F.V(0, 0.35, -0.2)), add(q, F.V(0, 0.35, 0.8)), 0.035, sp(MAT.metal, [0.15, 0.15, 0.16]));
    const kinds = [[0.55, 0.35, 0.12], [0.2, 0.3, 0.5], [0.5, 0.12, 0.1]];
    const c = kinds[Math.floor(rnd() * 3)];
    for (const s of [-1, 1]) S.quad(add(q, F.V(0, -0.35, 0.05)), F.V(0, 0, 0.7), [0, 0.65, 0], sp(MAT.wood, c, [0.8, 0.7, 0.3]), F.V(s, 0, 0));
    out.banners.push({ x: q[0], y: q[1], z: q[2], sign: true });
  }
  function woodpile(q, f, len) {
    const r = [f[2], 0, -f[0]];
    S.box(q, f, r, len, 1.1, 0.7, sp(MAT.bark, [0.36, 0.26, 0.18], [0.5, 0.4, 0.28]));
    S.quad(add(q, [0, 1.3, 0]), [f[0] * len, 0, f[2] * len], [r[0] * 0.9, -0.2, r[2] * 0.9], sp(MAT.shingle, [0.3, 0.24, 0.18]), [0, 1, 0]);
  }
  function barrels(q, n) {
    for (let i = 0; i < n; i++) {
      const c = [q[0] + (i - (n - 1) / 2) * 0.7, 0, q[2] + (rnd() - 0.5) * 0.3];
      S.cyl(c, 0.3, 0.85, sp(MAT.wood, [0.38, 0.25, 0.14], [0.2, 0.14, 0.08]));
      S.disc([c[0], 0.85, c[2]], 0, 0.3, sp(MAT.wood, [0.32, 0.22, 0.13]));
      block(c[0], c[2], 0.35);
    }
  }
  function cart(q, f) {
    const r = [f[2], 0, -f[0]];
    const F = frame(q[0], q[2], f[0], f[2]);
    S.box(F.P(0, 0.75, 0), F.r, F.f, 1.1, 0.12, 2.0, sp(MAT.wood, [0.36, 0.26, 0.16]));
    for (const s of [-1, 1]) S.quad(F.P(s * 0.55, 0.87, -1), F.V(0, 0, 2), [0, 0.4, 0], sp(MAT.wood, [0.32, 0.22, 0.14]), F.V(s, 0, 0));
    for (const s of [-1, 1]) {
      const c = F.P(s * 0.65, 0.55, 0);
      // 轮子:竖着的一圈 —— 用一段管子绕一圈太贵,画成一个竖的环(8 根辐条的影子交给材质)
      for (let k = 0; k < 12; k++) {
        const a0 = k / 12 * TAU, a1 = (k + 1) / 12 * TAU;
        S.tube(add(c, add(F.V(0, 0, Math.cos(a0) * 0.55), [0, Math.sin(a0) * 0.55, 0])), add(c, add(F.V(0, 0, Math.cos(a1) * 0.55), [0, Math.sin(a1) * 0.55, 0])), 0.05, oak);
      }
    }
    for (const s of [-1, 1]) S.tube(F.P(s * 0.4, 0.7, 1), F.P(s * 0.35, 0.3, 3.2), 0.04, oak);
    for (let k = 0; k < 80; k++) S.dot(F.P((rnd() - 0.5) * 0.9, 0.9 + rnd() * 0.5, (rnd() - 0.5) * 1.8), [0, 1, 0], [0.62 + rnd() * 0.1, 0.52, 0.28], 0.16);
    block(q[0], q[2], 1.3);
    out.perches.push({ x: q[0], y: 1.3, z: q[2] });
  }
  function hay(q, s) {
    S.cyl([q[0], 0, q[2]], 0.7 * s, 1.0 * s, thatch);
    S.disc([q[0], 1.0 * s, q[2]], 0, 0.7 * s, thatch);
    block(q[0], q[2], 0.8 * s);
  }

  /* ── 墙外:风车、水磨、谷仓、牧场的篱笆、果园、田里的草垛 ── */
  if (W.windmill) {
    const q = [W.windmill.x, 0, W.windmill.z];
    // 土台 + 立柱 + 木身 + 两坡顶;叶片交给 town-nature(要转)
    S.sphere([q[0], -1.5, q[2]], 5, sp(MAT.earth, [0.3, 0.32, 0.2]), 0, TAU, 0, Math.PI / 2, 0.55);
    S.tube([q[0], 0, q[2]], [q[0], 4.5, q[2]], 0.35, oak);
    const F = frame(q[0], q[2], Math.cos(Math.atan2(q[2], q[0])), Math.sin(Math.atan2(q[2], q[0])));
    boxWalls(F, { x0: -2, x1: 2, z0: -2.4, z1: 2.4 }, 4.2, 9.5, sp(MAT.wood, [0.42, 0.33, 0.24], [0.3, 0.22, 0.15]));
    for (const s of [-1, 1]) S.quad(F.P(-2.3, 11.6, 0), F.V(4.6, 0, 0) || 0, add(F.V(0, 0, s * 2.7), [0, -2.4, 0]), slate, F.V(0, 1, s));
    for (const [u, n] of [[-2, -1], [2, 1]]) tri(S, F.P(u, 9.5, -2.4), F.P(u, 9.5, 2.4), F.P(u, 11.6, 0), sp(MAT.wood, [0.42, 0.33, 0.24]), F.V(n, 0, 0));
    out.mills.push({ kind: 'wind', x: F.P(0, 0, -2.7)[0], y: 8.2, z: F.P(0, 0, -2.7)[2], ax: -F.f[0], az: -F.f[2], r: 8 });
    block(q[0], q[2], 3.4);
    out.perches.push({ x: q[0], y: 11.6, z: q[2] });
    lantern(...F.P(1.2, 5, -2.6), 8);
  }
  const WM = W.watermill;
  if (WM) {
    const F = frame(WM.x, WM.z, WM.fx, WM.fz);
    boxWalls(F, { x0: -3.5, x1: 3.5, z0: -3, z1: 3 }, 0, 3, stoneL);
    boxWalls(F, { x0: -3.5, x1: 3.5, z0: -3, z1: 3 }, 3, 5.4, sp(MAT.halftimber, [0.7, 0.64, 0.52], [0.2, 0.13, 0.09]));
    for (const s of [-1, 1]) S.quad(F.P(-3.9, 8.6, 0), F.V(7.8, 0, 0), add(F.V(0, 0, s * 3.4), [0, -3.6, 0]), thatch, F.V(0, 1, s));
    for (const [u, n] of [[-3.5, -1], [3.5, 1]]) tri(S, F.P(u, 5.4, -3), F.P(u, 5.4, 3), F.P(u, 8.6, 0), sp(MAT.halftimber, [0.7, 0.64, 0.52], [0.2, 0.13, 0.09]), F.V(n, 0, 0));
    chimney(F.P(2, 0, 0), 7, 9.2);
    out.mills.push({ kind: 'water', x: WM.wheel.x, y: 2.4, z: WM.wheel.z, ax: WM.fx, az: WM.fz, r: 2.5 });
    polyBlock([[3.5, 3], [-3.5, 3], [-3.5, -3], [3.5, -3]].map(([u, v]) => { const q = F.P(u, 0, v); return [q[0], q[2]]; }));
    lantern(...F.P(0, 2.5, 3.3), 8);
  }
  for (const pa of W.pastures) {
    // 谷仓
    const F = frame(pa.barn.x, pa.barn.z, -Math.sin(pa.barn.yaw), -Math.cos(pa.barn.yaw));
    boxWalls(F, { x0: -5, x1: 5, z0: -3.5, z1: 3.5 }, 0, 3.6, sp(MAT.wood, [0.36, 0.16, 0.1], [0.24, 0.1, 0.07]));
    for (const s of [-1, 1]) S.quad(F.P(-5.4, 7.2, 0), F.V(10.8, 0, 0), add(F.V(0, 0, s * 3.9), [0, -3.9, 0]), rnd() < 0.5 ? thatch : slate, F.V(0, 1, s));
    for (const [u, n] of [[-5, -1], [5, 1]]) tri(S, F.P(u, 3.6, -3.5), F.P(u, 3.6, 3.5), F.P(u, 7.2, 0), sp(MAT.wood, [0.36, 0.16, 0.1]), F.V(n, 0, 0));
    S.quad(F.P(-1.6, 0, 3.55), F.V(3.2, 0, 0), [0, 3, 0], sp(MAT.lattice, [0.25, 0.18, 0.12], [0.4, 0.3, 0.2]), F.f);
    polyBlock([[5, 3.5], [-5, 3.5], [-5, -3.5], [5, -3.5]].map(([u, v]) => { const q = F.P(u, 0, v); return [q[0], q[2]]; }));
    out.perches.push({ x: pa.barn.x, y: 7.2, z: pa.barn.z });
    lantern(...F.P(2.2, 3.2, 3.8), 8);
    hay(F.P(7, 0, 1), 1);
    // 篱笆:一圈木桩 + 两道横杆(编篱材质画在一条矮带子上,木桩才是几何)
    const n = Math.max(12, Math.round(TAU * pa.r / 3.2));
    for (let i = 0; i < n; i++) {
      const a0 = i / n * TAU, a1 = (i + 1) / n * TAU;
      const p0 = [pa.x + Math.cos(a0) * pa.r, pa.z + Math.sin(a0) * pa.r], p1 = [pa.x + Math.cos(a1) * pa.r, pa.z + Math.sin(a1) * pa.r];
      if (polylineDist(p0, W.stream.pts) < W.stream.w) continue;
      if (W.roads.some((rd) => polylineDist(p0, rd.pts) < rd.w)) continue;
      S.tube([p0[0], 0, p0[1]], [p0[0], 1.2, p0[1]], 0.07, oak);
      S.tube([p0[0], 0.55, p0[1]], [p1[0], 0.55, p1[1]], 0.04, oak);
      S.tube([p0[0], 1.05, p0[1]], [p1[0], 1.05, p1[1]], 0.04, oak);
      if (i % 3 === 0) out.perches.push({ x: p0[0], y: 1.22, z: p0[1] });
    }
  }
  for (const o of W.orchards) {
    // 果园:一行行苹果、梨树(树冠在 town-nature)
    const rows = Math.max(2, Math.floor(o.r * 2 / 6));
    for (let i = 0; i < rows; i++) for (let j = 0; j < rows; j++) {
      const x = o.x + (i - (rows - 1) / 2) * 6 + (rnd() - 0.5), z = o.z + (j - (rows - 1) / 2) * 6 + (rnd() - 0.5);
      if (Math.hypot(x - o.x, z - o.z) > o.r) continue;
      if (polylineDist([x, z], W.stream.pts) < W.stream.w + 2) continue;
      if (W.roads.some((rd) => polylineDist([x, z], rd.pts) < rd.w + 1.5)) continue;
      out.trees.push({ x, z, kind: rnd() < 0.7 ? 'apple' : 'pear', h: 3.6 + rnd() });
    }
  }
  for (const f of W.fields) {
    // 草垛、路边的稻草人
    if (rnd() < 0.5) {
      const a = lerp(f.a0, f.a1, 0.3 + rnd() * 0.4), r = lerp(f.r0, f.r1, 0.3 + rnd() * 0.4);
      hay([Math.cos(a) * r, 0, Math.sin(a) * r], 1.3);
    }
    if (rnd() < 0.3) {
      const a = lerp(f.a0, f.a1, 0.5), r = lerp(f.r0, f.r1, 0.6), q = [Math.cos(a) * r, 0, Math.sin(a) * r];
      S.tube(q, add(q, [0, 1.9, 0]), 0.05, oak);
      S.tube(add(q, [-0.6, 1.4, 0]), add(q, [0.6, 1.4, 0]), 0.04, oak);
      S.sphere(add(q, [0, 1.95, 0]), 0.18, thatch);
      S.box(add(q, [0, 0.9, 0]), [1, 0, 0], [0, 0, 1], 0.5, 0.6, 0.25, sp(MAT.canvas, [0.4, 0.28, 0.2]));
      out.perches.push({ x: q[0], y: 2.1, z: q[2] });
    }
  }
  /* ── 后院:菜畦边的柴垛、鸡舍、晾衣绳上的布 ── */
  for (const y of W.yards) {
    const F = frame(y.x, y.z, y.fx, y.fz);   // f 朝房子后面(背街)
    if (y.wood) woodpile(F.P(-y.w / 2 + 0.4, 0, 0), F.f, Math.min(2.4, y.d * 0.7));
    if (y.coop) {
      const q = F.P(y.w / 2 - 1, 0, y.d / 2 - 1);
      S.box(q, F.r, F.f, 1.4, 1.1, 1.2, sp(MAT.wood, [0.4, 0.3, 0.2]));
      S.quad(add(q, [0, 1.35, 0]), F.V(0, 0, 1.4), F.V(1.6, -0.3, 0), thatch, [0, 1, 0]);
      block(q[0], q[2], 0.9);
      out.perches.push({ x: q[0], y: 1.4, z: q[2] });
    }
    if (y.tree) out.trees.push({ x: F.P(y.w / 4, 0, y.d / 4)[0], z: F.P(y.w / 4, 0, y.d / 4)[2], kind: rnd() < 0.5 ? 'apple' : 'pear', h: 3.5 });
    if (rnd() < 0.5) {
      // 晾衣:两根杆,中间几块布(布是一小块点的面,不画绳子)
      const a = F.P(-y.w / 2 + 0.6, 0, y.d / 2 - 0.4), b = F.P(y.w / 2 - 0.6, 0, y.d / 2 - 0.4);
      S.tube(a, add(a, [0, 1.9, 0]), 0.04, oak); S.tube(b, add(b, [0, 1.9, 0]), 0.04, oak);
      const n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, c = add([lerp(a[0], b[0], t), 0, lerp(a[2], b[2], t)], [0, 1.85, 0]);
        out.cloths.push({ x: c[0], y: c[1], z: c[2], dx: F.r[0], dz: F.r[2], w: 0.5 + rnd() * 0.3, h: 0.6 + rnd() * 0.4,
          col: [[0.85, 0.82, 0.74], [0.55, 0.2, 0.15], [0.25, 0.35, 0.6], [0.8, 0.7, 0.4]][Math.floor(rnd() * 4)] });
      }
    }
  }
}

/** 圆锥 / 八角锥的顶:n 片三角。 */
export function coneRoof(S, c, r, h, spec, n = 8) {
  for (let i = 0; i < n; i++) {
    const a0 = i / n * TAU, a1 = (i + 1) / n * TAU, am = (a0 + a1) / 2;
    tri(S, [c[0] + Math.cos(a0) * r, c[1], c[2] + Math.sin(a0) * r], [c[0] + Math.cos(a1) * r, c[1], c[2] + Math.sin(a1) * r], [c[0], c[1] + h, c[2]], spec,
      [Math.cos(am), r / h, Math.sin(am)], 0.8);
  }
}
