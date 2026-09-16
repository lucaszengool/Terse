/**
 * town-villa.js — 镇上一栋别墅的外观。**走进去看到什么,外面就长什么样。**
 *
 * 里面的格局来自 room-interior.js 的 layoutOf:中间一座厅(唐宋是四合院的院子、江户是庭院),
 * 最大的四个子目录各占一面。外面照同一张平面图盖:厅在中间,几间屋子贴在它的北、东、南、西,
 * 高低也按里面的层高 —— 只是缩到一栋真别墅的尺度(十几二十米见方,一两层,门 2.2 米高),
 * 人站在门口看过去是一栋房子,不是一座体育馆。
 *
 * 风格(room-styles.js 的八张设计单)决定外皮:
 *   tang    四合院:青砖围墙、红柱、灰瓦歇山顶、檐角起翘、朱门、红灯笼
 *   edo     庭院:深色木构、障子、宽檐的瓦顶、缘侧、石灯笼
 *   giza    砂岩、平顶、凹弧檐口、门前一对梯形塔门、方尖碑、彩带
 *   hellas  三级台基、大理石墙、一圈凹槽柱、回纹檐壁、低坡红瓦顶、山花
 *   maya    三层退台、红灰泥、正中一道台阶、屋脊上的镂空顶冠
 *   persia  砖墙、贴蓝瓷的伊旺大门(半穹)、厅上一座绿松石穹顶、城垛
 *   norse   长屋:矮木墙、几乎落地的陡草皮顶、山墙上交叉的龙头、烟孔
 *   modern  白墙、平顶出挑、大片玻璃、木饰面
 *
 * 坐标:每栋房子自己的 (u, v),u 沿街、v 朝街(+v 是门口那一侧)—— 和屋里的 x、z 一样。
 */
import { MAT } from './room-surface.js';
import { layoutOf, layoutFor } from './room-interior.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* ── 三角、梯形:Surfaces 只会画平行四边形,斜的面切成一条条来拼 ──────────── */
/** 梯形 ABCD(AB 底、DC 顶,D 在 A 上方、C 在 B 上方),切成高 ≤ step 的条。 */
export function trap(S, A, B, C, D, spec, want, step = 0.55) {
  const hgt = Math.hypot(...sub(lerp3(D, C, 0.5), lerp3(A, B, 0.5)));
  const k = Math.max(1, Math.ceil(hgt / step));
  for (let i = 0; i < k; i++) {
    const t0 = i / k, t1 = (i + 1) / k, tm = (t0 + t1) / 2;
    const P0 = lerp3(A, D, tm), P1 = lerp3(B, C, tm);
    const Vh = sub(lerp3(lerp3(A, D, t1), lerp3(B, C, t1), 0.5), lerp3(lerp3(A, D, t0), lerp3(B, C, t0), 0.5));
    S.quad(sub(P0, mul3(Vh, 0.5)), sub(P1, P0), Vh, spec, want);
  }
}
export function tri(S, A, B, C, spec, want, step) { trap(S, A, B, C, C, spec, want, step); }

/**
 * 这栋房子里面长什么样(大厅 + 四间),缩成外面要盖的体块。
 * @param dir  胶囊里最大的那个顶层目录(走进去就是它);没有就按项目的量编一个
 * @returns {{blocks, bw, bd, layout}} blocks 的坐标以整栋的中心为原点,+z 朝街
 */
export function massingOf(dir, styleId, target = 17) {
  const layout = layoutFor(styleId);
  const L = layoutOf(dir || {}, { layout });
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const r of L.rooms) { x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1); z0 = Math.min(z0, r.z0); z1 = Math.max(z1, r.z1); }
  const bw = x1 - x0, bd = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  // 缩成真别墅:最长的一边 target 米上下(大项目大一点)
  const k = Math.max(0.35, Math.min(0.85, target / Math.max(bw, bd)));
  const blocks = L.rooms.map((r) => ({
    x0: (r.x0 - cx) * k, x1: (r.x1 - cx) * k, z0: (r.z0 - cz) * k, z1: (r.z1 - cz) * k,
    // 高度不跟着缩:人的尺度不变(门、窗、层高),只是厅没有里面那么空
    h: r.isHall ? Math.max(3.4, Math.min(6.4, r.h * 0.82)) : Math.max(2.9, Math.min(4.4, r.h * 0.85)),
    hall: !!r.isHall, open: !!r.open, kind: r.kind, side: r.side || '', name: r.name,
  }));
  return { blocks, bw: bw * k, bd: bd * k, layout, k };
}

/** 一个没有胶囊的项目(原型页、老数据):按它的量编一个目录,好让它也有厅和几间屋。 */
export function fakeDir(p, rnd) {
  const n = 1 + Math.floor(rnd() * 4);
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(['dir' + i, 4 + Math.floor(rnd() * 30), Math.floor((+p.bytes || 20000) * (0.2 + rnd()))]);
  return { name: p.title || 'root', kids, leaves: [], bytes: +p.bytes || 20000, files: +p.files || 10 };
}

/**
 * 盖一栋。
 * @param ctx { S, G, rnd, plot, style (id), D (设计单), lang (语言色), m (massingOf 的结果),
 *              out: {lights, blocks, perches, smokes, flowers, doors, labels} }
 */
export function buildVilla(ctx) {
  const { S, G, rnd, plot, style, D, lang, m, out } = ctx;
  const pal = D.pal;
  const cx = plot.cx, cz = plot.cz, fx = plot.fx, fz = plot.fz, rx = fz, rz = -fx;
  // 局部 → 世界
  const P = (u, y, v) => [cx + rx * u + fx * v, y, cz + rz * u + fz * v];
  const V = (du, dy, dv) => [rx * du + fx * dv, dy, rz * du + fz * dv];
  const seed = rnd() * 10;
  const sp = (mat, c1, c2, flags) => ({ mat, c1, c2: c2 || c1, seed, flags: flags || 0 });
  const dimc = (c, k) => mul3(c, k);
  const B = m.blocks;
  const hall = B.find((b) => b.hall) || B[0];
  const base = ctx.plinth != null ? ctx.plinth : 0.3;

  /* 一个体块的四面墙。skipFront:门那面墙另外画(要开门洞) */
  const walls = (b, y0, spec, faces = {}) => {
    const w = b.x1 - b.x0, d = b.z1 - b.z0, h = b.h;
    if (faces.front !== false) S.quad(P(b.x0, y0, b.z1), V(w, 0, 0), V(0, h - y0, 0), spec, V(0, 0, 1));
    if (faces.back !== false) S.quad(P(b.x0, y0, b.z0), V(w, 0, 0), V(0, h - y0, 0), spec, V(0, 0, -1));
    if (faces.left !== false) S.quad(P(b.x0, y0, b.z0), V(0, 0, d), V(0, h - y0, 0), spec, V(-1, 0, 0));
    if (faces.right !== false) S.quad(P(b.x1, y0, b.z0), V(0, 0, d), V(0, h - y0, 0), spec, V(1, 0, 0));
  };
  /* 窗:沿一面墙每隔 bay 米一扇。kind 决定玻璃是什么(玻璃、格栅、障子、窄缝) */
  const windowsOn = (b, face, opt) => {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const L = face === 'front' || face === 'back' ? w : d;
    const bay = opt.bay || 2.6, ww = opt.w || 1.0, wh = opt.h || 1.4;
    const rows = b.h > 5.2 && !opt.oneRow ? 2 : 1;
    const n = Math.max(0, Math.floor((L - 1.2) / bay));
    for (let i = 0; i < n; i++) {
      const s = (L - n * bay) / 2 + (i + 0.5) * bay;
      if (opt.skip && opt.skip(s, L)) continue;
      for (let r = 0; r < rows; r++) {
        const y = base + (opt.sill || 0.95) + r * ((b.h - base) / rows);
        if (y + wh > b.h - 0.25) continue;
        let o, U, n0;
        if (face === 'front') { o = P(b.x0 + s - ww / 2, y, b.z1 + 0.04); U = V(ww, 0, 0); n0 = V(0, 0, 1); }
        else if (face === 'back') { o = P(b.x0 + s - ww / 2, y, b.z0 - 0.04); U = V(ww, 0, 0); n0 = V(0, 0, -1); }
        else if (face === 'left') { o = P(b.x0 - 0.04, y, b.z0 + s - ww / 2); U = V(0, 0, ww); n0 = V(-1, 0, 0); }
        else { o = P(b.x1 + 0.04, y, b.z0 + s - ww / 2); U = V(0, 0, ww); n0 = V(1, 0, 0); }
        S.quad(o, U, [0, wh, 0], opt.spec, n0);
        if (opt.frame) {
          // 窗台:一条薄板(只画顶面和正面)
          S.box(add(add(o, mul3(U, 0.5)), mul3(n0, 0.06)), [U[0] / ww, 0, U[2] / ww], n0, ww + 0.16, 0.08, 0.14, opt.frame, { back: false, left: false, right: false });
        }
        if (opt.shutters) for (const sd of [-1, 1]) {
          const so = add(add(o, mul3(U, sd < 0 ? -0.46 / ww : 1)), mul3(n0, 0.02));
          S.quad(so, mul3(U, 0.46 / ww), [0, wh, 0], opt.shutters, n0);
        }
        // 夜里窗里透出来的光(有的窗黑着)
        if (rnd() < (opt.lit != null ? opt.lit : 0.72)) {
          const warm = 0.7 + rnd() * 0.28, c = opt.glowCol || [warm, warm * 0.74, warm * 0.46];
          const cc = add(add(o, mul3(U, 0.5)), mul3(n0, 0.1));
          for (let k = 0; k < 9; k++) G(cc[0] + (rnd() - 0.5) * U[0] * 0.8, y + 0.2 + rnd() * (wh - 0.4), cc[2] + (rnd() - 0.5) * U[2] * 0.8, c, 0.12, 0.25, 1);
        }
        if (opt.flowers && r === rows - 1 && rnd() < 0.45) {
          const fc = add(add(o, mul3(U, 0.5)), mul3(n0, 0.18));
          const hue = rnd();
          for (let k = 0; k < 14; k++) {
            const col = hue < 0.33 ? [0.8, 0.2, 0.25] : hue < 0.66 ? [0.9, 0.75, 0.3] : [0.75, 0.45, 0.8];
            S.dot([fc[0] + (rnd() - 0.5) * U[0] * 1.05, y + 0.04 + rnd() * 0.22, fc[2] + (rnd() - 0.5) * U[2] * 1.05], [0, 1, 0], k % 3 ? col : [0.2, 0.42, 0.18], 0.09);
          }
          out.flowers.push({ x: fc[0], y: y + 0.2, z: fc[2] });
        }
      }
    }
  };
  /* 两坡顶。ridge 'u':屋脊沿 u(前后两坡);'v':沿 v(左右两坡,山墙朝街) */
  const gable = (b, pitch, roofSpec, gableSpec, ridge, over = 0.45, y0) => {
    const h = y0 != null ? y0 : b.h;
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const along = ridge || (w >= d ? 'u' : 'v');
    const half = (along === 'u' ? d : w) / 2, rise = half * Math.tan(pitch);
    const drop = over * Math.tan(pitch);
    if (along === 'u') {
      const zc = (b.z0 + b.z1) / 2;
      for (const s of [-1, 1]) {
        S.quad(P(b.x0 - over, h + rise, zc), V(w + over * 2, 0, 0), V(0, -rise - drop, s * (half + over)), roofSpec, V(0, 1, s));
      }
      for (const [u, n] of [[b.x0, -1], [b.x1, 1]]) tri(S, P(u, h, b.z0), P(u, h, b.z1), P(u, h + rise, zc), gableSpec, V(n, 0, 0));
      for (let t = 0.1; t <= 0.9; t += 0.2) out.perches.push(pt(P(lerp(b.x0, b.x1, t), h + rise + 0.05, zc)));
      return { top: h + rise, ridge: [P(b.x0, h + rise, zc), P(b.x1, h + rise, zc)] };
    }
    const xc = (b.x0 + b.x1) / 2;
    for (const s of [-1, 1]) {
      S.quad(P(xc, h + rise, b.z0 - over), V(0, 0, d + over * 2), V(s * (half + over), -rise - drop, 0), roofSpec, V(s, 1, 0));
    }
    for (const [v, n] of [[b.z0, -1], [b.z1, 1]]) tri(S, P(b.x0, h, v), P(b.x1, h, v), P(xc, h + rise, v), gableSpec, V(0, 0, n));
    for (let t = 0.1; t <= 0.9; t += 0.2) out.perches.push(pt(P(xc, h + rise + 0.05, lerp(b.z0, b.z1, t))));
    return { top: h + rise, ridge: [P(xc, h + rise, b.z0), P(xc, h + rise, b.z1)] };
  };
  /* 四坡顶(庑殿/歇山的简化):屋脊沿长边,两头是三角 */
  const hip = (b, pitch, roofSpec, over = 0.6, y0, curl = 0) => {
    const h = y0 != null ? y0 : b.h;
    const x0 = b.x0 - over, x1 = b.x1 + over, z0 = b.z0 - over, z1 = b.z1 + over;
    const w = x1 - x0, d = z1 - z0;
    const drop = over * Math.tan(pitch);
    const hy = h - drop;
    if (w >= d) {
      const rise = (d / 2) * Math.tan(pitch), zc = (z0 + z1) / 2;
      const ra = x0 + d / 2, rb = x1 - d / 2;
      trap(S, P(x0, hy, z1), P(x1, hy, z1), P(Math.max(ra, rb), hy + rise, zc), P(Math.min(ra, rb), hy + rise, zc), roofSpec, V(0, 1, 1));
      trap(S, P(x1, hy, z0), P(x0, hy, z0), P(Math.min(ra, rb), hy + rise, zc), P(Math.max(ra, rb), hy + rise, zc), roofSpec, V(0, 1, -1));
      tri(S, P(x0, hy, z0), P(x0, hy, z1), P(ra, hy + rise, zc), roofSpec, V(-1, 1, 0));
      tri(S, P(x1, hy, z1), P(x1, hy, z0), P(rb, hy + rise, zc), roofSpec, V(1, 1, 0));
      if (curl) for (const [u, v] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
        // 檐角起翘:角上一截往上翘的木
        const a = P(u, hy, v), c = P(cx === 0 ? u : u, hy, v);
        S.tube(a, add(add(c, V(Math.sign(u - (x0 + x1) / 2) * 0.35, 0, Math.sign(v - zc) * 0.35)), [0, curl * 0.7, 0]), 0.045, roofSpec);
      }
      for (let t = 0.2; t <= 0.8; t += 0.3) out.perches.push(pt(P(lerp(ra, rb, t), hy + rise + 0.05, zc)));
      return { top: hy + rise };
    }
    const rise = (w / 2) * Math.tan(pitch), xc = (x0 + x1) / 2;
    const ra = z0 + w / 2, rb = z1 - w / 2;
    trap(S, P(x0, hy, z0), P(x0, hy, z1), P(xc, hy + rise, Math.max(ra, rb)), P(xc, hy + rise, Math.min(ra, rb)), roofSpec, V(-1, 1, 0));
    trap(S, P(x1, hy, z1), P(x1, hy, z0), P(xc, hy + rise, Math.min(ra, rb)), P(xc, hy + rise, Math.max(ra, rb)), roofSpec, V(1, 1, 0));
    tri(S, P(x1, hy, z0), P(x0, hy, z0), P(xc, hy + rise, ra), roofSpec, V(0, 1, -1));
    tri(S, P(x0, hy, z1), P(x1, hy, z1), P(xc, hy + rise, rb), roofSpec, V(0, 1, 1));
    if (curl) for (const [u, v] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      const a = P(u, hy, v);
      S.tube(a, add(add(a, V(Math.sign(u - xc) * 0.35, 0, Math.sign(v - (z0 + z1) / 2) * 0.35)), [0, curl * 0.7, 0]), 0.045, roofSpec);
    }
    for (let t = 0.2; t <= 0.8; t += 0.3) out.perches.push(pt(P(xc, hy + rise + 0.05, lerp(ra, rb, t))));
    return { top: hy + rise };
  };
  const flat = (b, spec, over = 0.3, y) => {
    const h = y != null ? y : b.h;
    S.quad(P(b.x0 - over, h, b.z0 - over), V(b.x1 - b.x0 + over * 2, 0, 0), V(0, 0, b.z1 - b.z0 + over * 2), spec, [0, 1, 0]);
    // 板的厚度:正面一条
    S.quad(P(b.x0 - over, h - 0.25, b.z1 + over), V(b.x1 - b.x0 + over * 2, 0, 0), [0, 0.25, 0], spec, V(0, 0, 1));
    out.perches.push(pt(P(b.x0 + 0.3, h + 0.05, b.z1)), pt(P(b.x1 - 0.3, h + 0.05, b.z0)));
  };
  const parapet = (b, spec, hh = 0.6, merlon = 0) => {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    for (const [o, U, n] of [[P(b.x0, b.h, b.z1), V(w, 0, 0), V(0, 0, 1)], [P(b.x0, b.h, b.z0), V(w, 0, 0), V(0, 0, -1)],
      [P(b.x0, b.h, b.z0), V(0, 0, d), V(-1, 0, 0)], [P(b.x1, b.h, b.z0), V(0, 0, d), V(1, 0, 0)]]) {
      S.quad(o, U, [0, hh, 0], spec, n);
      if (merlon) {
        const L = Math.hypot(U[0], U[2]), k = Math.floor(L / merlon);
        for (let i = 0; i < k; i += 2) {
          const c = add(o, mul3(U, (i + 0.5) / k));
          S.box([c[0], b.h + hh, c[2]], [U[0] / L, 0, U[2] / L], n, merlon * 0.9, 0.45, 0.25, spec, { back: false, bottom: false });
        }
      }
    }
    out.perches.push(pt(P(b.x0, b.h + hh, b.z1)), pt(P(b.x1, b.h + hh, b.z1)), pt(P(b.x1, b.h + hh, b.z0)));
  };
  const pt = (q) => ({ x: q[0], y: q[1], z: q[2] });

  /* 门:在最朝街的那个体块正面中间 */
  let front = B[0];
  for (const b of B) if (b.z1 > front.z1 + 0.01 || (Math.abs(b.z1 - front.z1) < 0.01 && Math.abs((b.x0 + b.x1) / 2) < Math.abs((front.x0 + front.x1) / 2))) front = b;
  const doorU = 0, doorW = style === 'giza' || style === 'persia' || style === 'tang' ? 1.6 : 1.15, doorH = style === 'persia' ? 2.8 : 2.2;
  const doorAt = P(doorU, base, front.z1 + 0.05);
  const doorSpec = sp(MAT.wood, style === 'tang' ? [0.55, 0.1, 0.07] : dimc(pal.wood, 0.8), dimc(pal.wood, 0.5));
  const drawDoor = (spec = doorSpec) => {
    S.quad(P(doorU - doorW / 2, base, front.z1 + 0.06), V(doorW, 0, 0), [0, doorH, 0], spec, V(0, 0, 1));
    // 门口两盏灯
    for (const s of [-1, 1]) {
      const q = P(doorU + s * (doorW / 2 + 0.45), base + doorH + 0.1, front.z1 + 0.35);
      const lk = style === 'tang' ? [1, 0.35, 0.22] : [1, 0.78, 0.5];
      out.lights.push({ x: q[0], y: q[1], z: q[2], r: 7, col: lk, k: 1.2 });
      for (let k = 0; k < 10; k++) G(q[0] + (rnd() - 0.5) * 0.18, q[1] + (rnd() - 0.5) * 0.2, q[2] + (rnd() - 0.5) * 0.18, style === 'tang' ? [1, 0.3, 0.2] : [0.95, 0.78, 0.5], 0.09, 0.35, 1);
    }
  };
  // 门前的台阶(台基有多高就几级)
  const steps = (y, n, wide) => {
    for (let i = 0; i < n; i++) {
      const q = P(doorU, 0, front.z1 + 0.3 + (n - i) * 0.3);
      S.box(q, V(1, 0, 0), V(0, 0, 1), wide + (n - i) * 0.2, y * (i + 1) / n, 0.32, sp(MAT.stone, dimc(pal.stone, 0.7)), { back: false });
    }
  };

  const wallC = dimc(pal.field, 0.72), stoneC = dimc(pal.stone, 0.62), trimC = dimc(pal.struct, 0.7);
  let top = hall.h;

  /* ════ 各风格 ════ */
  if (style === 'tang') {
    // 四合院:院子(大厅)是露天的,四面的屋子围着它;外圈一道青砖墙
    const brick = sp(MAT.brick, [0.34, 0.35, 0.37], [0.62, 0.62, 0.6]);
    const tile = sp(MAT.rooftile, [0.2, 0.21, 0.23], [0.12, 0.12, 0.14]);
    const red = sp(MAT.lacquer, [0.5, 0.09, 0.06]);
    S.quad(P(-m.bw / 2 - 0.3, base, -m.bd / 2 - 0.3), V(m.bw + 0.6, 0, 0), V(0, 0, m.bd + 0.6), sp(MAT.stone, stoneC), [0, 1, 0]);
    for (const b of B) {
      if (b.hall) {
        // 院墙(院子没有屋子的那几面)
        const has = new Set(B.filter((q) => !q.hall).map((q) => q.side));
        const wb = Object.assign({}, b, { h: 2.6 });
        walls(wb, base, brick, { front: !has.has('S'), back: !has.has('N'), left: !has.has('W'), right: !has.has('E') });
        // 院子里一棵树(树冠交给 town-nature)
        out.trees.push({ x: P(0, 0, 0)[0], z: P(0, 0, 0)[2], kind: 'linden', h: 6 });
        continue;
      }
      walls(b, base, brick);
      // 朝院子那面:一排红柱
      const inward = b.side === 'N' ? b.z1 : b.side === 'S' ? b.z0 : null;
      if (inward != null) for (let u = b.x0 + 0.6; u < b.x1; u += 2.2) S.tube(P(u, base, inward + (b.side === 'N' ? 0.5 : -0.5)), P(u, b.h, inward + (b.side === 'N' ? 0.5 : -0.5)), 0.13, red);
      windowsOn(b, b.side === 'S' ? 'back' : b.side === 'N' ? 'front' : b.side === 'E' ? 'left' : 'right', { spec: sp(MAT.lattice, [0.82, 0.74, 0.6], [0.45, 0.1, 0.06]), bay: 2.2, glowCol: [1, 0.55, 0.3] });
      const r = hip(b, 0.52, tile, 0.9, b.h + 0.05, 0.45);
      top = Math.max(top, r.top);
    }
    // 大门:门楼 + 朱门 + 一对石狮
    const gw = 3.2;
    const gb = { x0: -gw / 2, x1: gw / 2, z0: m.bd / 2 - 0.5, z1: m.bd / 2 + 0.6, h: 3.6 };
    walls(gb, base, brick, { front: false });
    hip(gb, 0.55, tile, 0.7, gb.h, 0.35);
    front = gb;
    drawDoor(red);
    for (let k = 0; k < 18; k++) G(...P((rnd() - 0.5) * 1.3, base + 0.4 + rnd() * 1.6, gb.z1 + 0.1), [1, 0.8, 0.35], 0.05, 0.1, 2);
    for (const s of [-1, 1]) S.sphere(P(s * 2.2, base + 0.55, gb.z1 + 0.9), 0.5, sp(MAT.stone, [0.55, 0.55, 0.56]), 0, TAU, -0.3, Math.PI / 2, 1.2);
    steps(base, 2, gw + 0.6);
  } else if (style === 'edo') {
    // 庭院:院子是露天的,四周是木构的屋,宽檐、缘侧;门是一座小木门
    const woodC = [0.22, 0.16, 0.12];
    const shoji = sp(MAT.lattice, pal.paper || [0.92, 0.88, 0.8], woodC);
    const tile = sp(MAT.rooftile, [0.22, 0.23, 0.25], [0.14, 0.14, 0.16]);
    for (const b of B) {
      if (b.hall) {
        // 竹篱(没有屋子的那几面)
        const has = new Set(B.filter((q) => !q.hall).map((q) => q.side));
        walls(Object.assign({}, b, { h: 1.8 }), 0, sp(MAT.wattle, [0.45, 0.4, 0.22], [0.3, 0.25, 0.14]), { front: !has.has('S'), back: !has.has('N'), left: !has.has('W'), right: !has.has('E') });
        out.trees.push({ x: P(b.x0 + 1.5, 0, 0)[0], z: P(b.x0 + 1.5, 0, 0)[2], kind: 'maple', h: 4 });
        // 石灯笼
        const q = P(b.x1 - 1.5, 0, b.z0 + 1.5);
        S.box(q, V(1, 0, 0), V(0, 0, 1), 0.3, 0.9, 0.3, sp(MAT.stone, [0.5, 0.5, 0.48]));
        S.box([q[0], 0.9, q[2]], V(1, 0, 0), V(0, 0, 1), 0.55, 0.4, 0.55, sp(MAT.stone, [0.5, 0.5, 0.48]));
        for (let k = 0; k < 10; k++) G(q[0] + (rnd() - 0.5) * 0.2, 1.1 + rnd() * 0.15, q[2] + (rnd() - 0.5) * 0.2, [1, 0.7, 0.4], 0.07, 0.4, 1);
        continue;
      }
      // 缘侧:抬高 0.5 的木地台
      S.quad(P(b.x0 - 0.9, 0.5, b.z0 - 0.9), V(b.x1 - b.x0 + 1.8, 0, 0), V(0, 0, b.z1 - b.z0 + 1.8), sp(MAT.wood, [0.36, 0.26, 0.18]), [0, 1, 0]);
      walls(b, 0.5, shoji);
      for (const [u, v] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]]) S.tube(P(u, 0, v), P(u, b.h, v), 0.1, sp(MAT.wood, woodC));
      for (const f of ['front', 'back', 'left', 'right']) windowsOn(b, f, { spec: shoji, bay: 1.8, w: 1.5, h: 1.8, sill: 0.3, oneRow: true, lit: 0.9, glowCol: [1, 0.78, 0.52] });
      const r = hip(b, 0.5, tile, 1.3, b.h, 0.2);
      top = Math.max(top, r.top);
    }
    const gb = { x0: -1.2, x1: 1.2, z0: m.bd / 2 - 0.3, z1: m.bd / 2 + 0.3, h: 2.9 };
    for (const s of [-1, 1]) S.tube(P(s * 1.2, 0, gb.z1), P(s * 1.2, 2.9, gb.z1), 0.12, sp(MAT.wood, woodC));
    gable(gb, 0.5, tile, sp(MAT.wood, woodC), 'u', 0.5);
    front = gb;
    drawDoor(sp(MAT.wood, [0.4, 0.3, 0.2]));
  } else if (style === 'giza') {
    const sand = sp(MAT.sandstone, dimc(pal.field, 0.75), dimc(pal.stone, 0.7));
    const band = sp(MAT.bands4, dimc(pal.accent, 0.8), dimc(pal.gold, 0.8));
    for (const b of B) {
      walls(b, 0, sand);
      // 凹弧檐口:墙顶往外探的一条带
      for (const f of [[P(b.x0 - 0.2, b.h, b.z1 + 0.35), V(b.x1 - b.x0 + 0.4, 0, 0), V(0, 0, 1)], [P(b.x0 - 0.2, b.h, b.z0 - 0.35), V(b.x1 - b.x0 + 0.4, 0, 0), V(0, 0, -1)]]) {
        S.quad(sub(f[0], [0, 0.55, 0]), f[1], add([0, 0.55, 0], mul3(f[2], 0.0)), band, f[2]);
      }
      windowsOn(b, 'left', { spec: sp(MAT.glass, [0.08, 0.07, 0.06]), w: 0.5, h: 0.9, sill: 2.2, bay: 3.2, oneRow: true });
      windowsOn(b, 'right', { spec: sp(MAT.glass, [0.08, 0.07, 0.06]), w: 0.5, h: 0.9, sill: 2.2, bay: 3.2, oneRow: true });
      flat(b, sp(MAT.sandstone, dimc(pal.stone, 0.66)), 0.2);
      top = Math.max(top, b.h);
    }
    // 塔门:门两边两座往上收的梯形塔
    const pz = m.bd / 2 + 0.6;
    for (const s of [-1, 1]) {
      const u0 = s * 1.1, u1 = s * 4.2, hh = Math.max(hall.h + 1.8, 6);
      const uin = s * 1.3, uout = s * 3.8;
      trap(S, P(Math.min(u0, u1), 0, pz), P(Math.max(u0, u1), 0, pz), P(Math.max(uin, uout), hh, pz - 0.4), P(Math.min(uin, uout), hh, pz - 0.4), sand, V(0, 0.1, 1));
      trap(S, P(u1, 0, pz), P(u1, 0, pz - 2.4), P(uout, hh, pz - 2.0), P(uout, hh, pz - 0.4), sand, V(s, 0, 0));
      S.quad(P(Math.min(uin, uout), hh, pz - 2.0), V(Math.abs(uout - uin), 0, 0), V(0, 0, 1.6), sand, [0, 1, 0]);
      S.quad(P(Math.min(uin, uout), hh - 1.2, pz - 0.38), V(Math.abs(uout - uin), 0, 0), [0, 0.9, 0], band, V(0, 0, 1));
      // 方尖碑
      const ob = P(s * 5.6, 0, pz + 1.6);
      S.box(ob, V(1, 0, 0), V(0, 0, 1), 0.55, 4.6, 0.55, sp(MAT.glyph, dimc(pal.stone, 0.8), dimc(pal.ink, 1)), { top: false });
      tri(S, add(ob, [-0.28, 4.6, 0.28]), add(ob, [0.28, 4.6, 0.28]), add(ob, [0, 5.2, 0]), sp(MAT.goldleaf, pal.gold), [0, 0.5, 1]);
      out.trees.push({ x: P(s * 7, 0, pz)[0], z: P(s * 7, 0, pz)[2], kind: 'palm', h: 6 });
      top = Math.max(top, hh);
    }
    front = { x0: -1, x1: 1, z1: pz, h: 3 };
    drawDoor(sp(MAT.wood, dimc(pal.wood, 0.8)));
  } else if (style === 'hellas') {
    const marble = sp(MAT.marble, [0.6, 0.58, 0.55], [0.45, 0.44, 0.42]);
    const fluted = sp(MAT.fluted, [0.62, 0.6, 0.57]);
    const tile = sp(MAT.rooftile, [0.52, 0.24, 0.14], [0.36, 0.16, 0.1]);
    const meander = sp(MAT.meander, dimc(pal.accent, 0.9), [0.8, 0.78, 0.72]);
    // 三级台基
    for (let i = 0; i < 3; i++) {
      const o = 1.6 - i * 0.4;
      S.box(P(0, i * 0.22, 0), V(1, 0, 0), V(0, 0, 1), m.bw + o * 2, 0.22, m.bd + o * 2, sp(MAT.marble, [0.52, 0.5, 0.47]), { bottom: false });
    }
    const y0 = 0.66;
    for (const b of B) {
      const inner = { x0: b.x0 + (b.hall ? 1.2 : 0), x1: b.x1 - (b.hall ? 1.2 : 0), z0: b.z0 + (b.hall ? 1.2 : 0), z1: b.z1 - (b.hall ? 1.2 : 0), h: b.h };
      walls(inner, y0, marble);
      windowsOn(inner, 'left', { spec: sp(MAT.glass, [0.1, 0.1, 0.1]), bay: 3, h: 1.8 });
      windowsOn(inner, 'right', { spec: sp(MAT.glass, [0.1, 0.1, 0.1]), bay: 3, h: 1.8 });
      // 檐壁:回纹
      for (const [o, U, n] of [[P(b.x0, b.h - 0.6, b.z1), V(b.x1 - b.x0, 0, 0), V(0, 0, 1)], [P(b.x0, b.h - 0.6, b.z0), V(b.x1 - b.x0, 0, 0), V(0, 0, -1)]]) S.quad(o, U, [0, 0.6, 0], meander, n);
      if (b.hall) {
        // 一圈柱廊
        for (let u = b.x0 + 0.3; u <= b.x1 - 0.3 + 1e-6; u += 1.9) for (const v of [b.z0 + 0.3, b.z1 - 0.3]) S.tube(P(u, y0, v), P(u, b.h - 0.6, v), 0.24, fluted);
        for (let v = b.z0 + 2.2; v <= b.z1 - 2.2; v += 1.9) for (const u of [b.x0 + 0.3, b.x1 - 0.3]) S.tube(P(u, y0, v), P(u, b.h - 0.6, v), 0.24, fluted);
        const r = gable(b, 0.28, tile, marble, 'v', 0.4);
        top = Math.max(top, r.top);
      } else {
        const r = gable(b, 0.28, tile, marble, null, 0.3);
        top = Math.max(top, r.top);
      }
    }
    front = Object.assign({}, front, { z1: front.z1 - (front.hall ? 1.2 : 0) });
    drawDoor(sp(MAT.wood, [0.4, 0.28, 0.16]));
    for (const s of [-1, 1]) out.trees.push({ x: P(s * (m.bw / 2 + 2.5), 0, m.bd / 2)[0], z: P(s * (m.bw / 2 + 2.5), 0, m.bd / 2)[2], kind: 'cypress', h: 7 });
  } else if (style === 'maya') {
    const stucco = sp(MAT.plaster, dimc(pal.field, 0.85), dimc(pal.field, 0.6));
    const cream = sp(MAT.plaster, dimc(pal.struct, 0.75));
    const glyph = sp(MAT.glyph, dimc(pal.struct, 0.75), dimc(pal.ink, 1));
    // 三层退台
    const terr = 3, th = 0.8;
    for (let i = 0; i < terr; i++) {
      const o = 2.8 - i * 1.0;
      const tb = { x0: -m.bw / 2 - o, x1: m.bw / 2 + o, z0: -m.bd / 2 - o, z1: m.bd / 2 + o, h: (i + 1) * th };
      walls(tb, i * th, stucco);
      S.quad(P(tb.x0, tb.h, tb.z0), V(tb.x1 - tb.x0, 0, 0), V(0, 0, tb.z1 - tb.z0), cream, [0, 1, 0]);
    }
    const y0 = terr * th;
    // 正中的大台阶
    for (let i = 0; i < terr * 2; i++) {
      const q = P(0, 0, m.bd / 2 + 2.8 + 0.25 - i * 0.4);
      S.box(q, V(1, 0, 0), V(0, 0, 1), 2.6, (i + 1) * th / 2, 0.42, cream, { back: false });
    }
    for (const b of B) {
      const bb = Object.assign({}, b, { h: b.h + y0 });
      walls(bb, y0, stucco);
      S.quad(P(b.x0, bb.h - 0.9, b.z1 + 0.02), V(b.x1 - b.x0, 0, 0), [0, 0.9, 0], glyph, V(0, 0, 1));
      flat(bb, cream, 0.25);
      top = Math.max(top, bb.h);
      if (b.hall) {
        // 顶冠:屋顶正中一片镂空的高墙
        S.quad(P(b.x0 + 1, bb.h, (b.z0 + b.z1) / 2), V(b.x1 - b.x0 - 2, 0, 0), [0, 2.6, 0], sp(MAT.lattice, dimc(pal.struct, 0.7), dimc(pal.field, 0.7)), V(0, 0, 1));
        S.quad(P(b.x0 + 1, bb.h, (b.z0 + b.z1) / 2), V(b.x1 - b.x0 - 2, 0, 0), [0, 2.6, 0], sp(MAT.lattice, dimc(pal.struct, 0.7), dimc(pal.field, 0.7)), V(0, 0, -1));
        top = Math.max(top, bb.h + 2.6);
      }
    }
    // 门:梯形的叠涩拱
    const fz1 = front.z1 + 0.06;
    S.quad(P(-0.6, y0, fz1), V(1.2, 0, 0), [0, 1.6, 0], sp(MAT.glass, [0.05, 0.04, 0.04]), V(0, 0, 1));
    tri(S, P(-0.6, y0 + 1.6, fz1), P(0.6, y0 + 1.6, fz1), P(0, y0 + 2.5, fz1), sp(MAT.glass, [0.05, 0.04, 0.04]), V(0, 0, 1));
    out.lights.push({ x: P(0, 0, fz1)[0], y: y0 + 2, z: P(0, 0, fz1)[2], r: 8, col: [1, 0.6, 0.3], k: 1.3 });
    for (const s of [-1, 1]) {
      const q = P(s * 1.6, y0 + 0.2, fz1 + 0.6);
      for (let k = 0; k < 20; k++) G(q[0] + (rnd() - 0.5) * 0.3, q[1] + rnd() * 0.5, q[2] + (rnd() - 0.5) * 0.3, [1, 0.5 + rnd() * 0.3, 0.15], 0.1, 0.9, 2);
    }
    out.doorY = y0;
  } else if (style === 'persia') {
    const brickC = dimc(pal.floor, 0.72);
    const brick = sp(MAT.brick, brickC, mix3(brickC, [1, 1, 1], 0.3));
    const blue = sp(MAT.girih, dimc(pal.field, 0.9), dimc(pal.accent2, 0.9));
    const turq = sp(MAT.tile, dimc(pal.accent2, 0.85), dimc(pal.field, 0.8));
    for (const b of B) {
      walls(b, 0, brick);
      windowsOn(b, 'left', { spec: sp(MAT.lattice, [0.2, 0.18, 0.15], dimc(pal.floor, 0.6)), bay: 2.6, glowCol: [1, 0.72, 0.4] });
      windowsOn(b, 'right', { spec: sp(MAT.lattice, [0.2, 0.18, 0.15], dimc(pal.floor, 0.6)), bay: 2.6, glowCol: [1, 0.72, 0.4] });
      flat(b, sp(MAT.brick, brickC), 0.05);
      parapet(b, brick, 0.5, 0.8);
      top = Math.max(top, b.h + 0.95);
      if (b.hall) {
        // 厅上一座穹顶(鼓座 + 半球)
        const R = Math.min(b.x1 - b.x0, b.z1 - b.z0) * 0.3;
        const c = P((b.x0 + b.x1) / 2, b.h, (b.z0 + b.z1) / 2);
        S.cyl(c, R * 1.02, 1.2, sp(MAT.tile, dimc(pal.field, 0.8), dimc(pal.stone, 0.8)));
        S.sphere(add(c, [0, 1.2, 0]), R, turq, 0, TAU, 0, Math.PI / 2, 1.15);
        S.tube(add(c, [0, 1.2 + R * 1.15, 0]), add(c, [0, 2.2 + R * 1.15, 0]), 0.06, sp(MAT.goldleaf, pal.gold));
        top = Math.max(top, b.h + 2.2 + R * 1.15);
        out.perches.push(pt(add(c, [0, 1.25 + R * 1.15, 0])));
      }
    }
    // 伊旺:门前一座高的贴瓷拱门
    const iw = 4.2, ih = Math.max(hall.h + 1.6, 6.2), pz = front.z1 + 0.9;
    S.box(P(0, 0, pz - 0.45), V(1, 0, 0), V(0, 0, 1), iw + 1.6, ih, 0.9, brick, { back: false, front: false });
    for (const s of [-1, 1]) S.quad(P(s > 0 ? iw / 2 : -iw / 2 - 0.8, 0, pz), V(0.8, 0, 0), [0, ih, 0], blue, V(0, 0, 1));
    S.quad(P(-iw / 2 - 0.8, ih - 1.2, pz), V(iw + 1.6, 0, 0), [0, 1.2, 0], blue, V(0, 0, 1));
    // 拱里的半穹(四分之一球)
    S.sphere(P(0, ih - 1.2 - iw / 2 + 0.2, pz - 0.2), iw / 2, sp(MAT.mosaic, dimc(pal.accent2, 0.9), dimc(pal.gold, 0.9), 4), 0, Math.PI, 0, Math.PI / 2, 1);
    top = Math.max(top, ih);
    front = Object.assign({}, front, { z1: pz - 0.6 });
    drawDoor(sp(MAT.wood, [0.35, 0.22, 0.12]));
  } else if (style === 'norse') {
    const stave = sp(MAT.wood, [0.2, 0.14, 0.1], [0.12, 0.08, 0.06]);
    const turf = sp(MAT.turf, [0.16, 0.26, 0.12], [0.24, 0.2, 0.12]);
    for (const b of B) {
      // 长屋:墙矮(1.9),屋顶陡得几乎落地
      const lb = Object.assign({}, b, { h: 1.9 });
      S.quad(P(b.x0 - 0.2, 0, b.z0 - 0.2), V(b.x1 - b.x0 + 0.4, 0, 0), V(0, 0, b.z1 - b.z0 + 0.4), sp(MAT.stone, [0.35, 0.34, 0.32]), [0, 1, 0]);
      walls(lb, 0, stave);
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      const r = gable(lb, 1.0, turf, stave, w >= d ? 'u' : 'v', 0.35);
      top = Math.max(top, r.top);
      // 山墙上交叉的龙头
      const [ra, rb] = r.ridge;
      for (const e of [ra, rb]) {
        S.tube(add(e, [-0.5, -0.5, 0]), add(e, [0.5, 0.7, 0]), 0.07, stave);
        S.tube(add(e, [0.5, -0.5, 0]), add(e, [-0.5, 0.7, 0]), 0.07, stave);
      }
      if (b.hall) out.smokes.push({ x: (ra[0] + rb[0]) / 2, y: r.top, z: (ra[2] + rb[2]) / 2, k: 1.4 });
    }
    front = Object.assign({}, front, { h: 2.2 });
    drawDoor(sp(MAT.interlace, [0.3, 0.2, 0.12], [0.55, 0.4, 0.2]));
  } else {
    // modern:白墙、平顶出挑、大玻璃、木饰面
    const white = sp(MAT.plaster, [0.8, 0.78, 0.74]);
    const glass = sp(MAT.glass, [0.1, 0.13, 0.16], [0.18, 0.2, 0.24]);
    const woodS = sp(MAT.wood, [0.45, 0.3, 0.2]);
    for (const b of B) {
      walls(b, base, b.side === 'E' ? woodS : white);
      windowsOn(b, 'front', { spec: glass, bay: 2.6, w: 2.2, h: Math.min(2.4, b.h - 0.8), sill: 0.2, oneRow: true, lit: 0.8, glowCol: [1, 0.86, 0.68] });
      windowsOn(b, 'left', { spec: glass, bay: 3, w: 1.6, h: 1.6, lit: 0.6, glowCol: [1, 0.86, 0.68] });
      windowsOn(b, 'right', { spec: glass, bay: 3, w: 1.6, h: 1.6, lit: 0.6, glowCol: [1, 0.86, 0.68] });
      windowsOn(b, 'back', { spec: glass, bay: 3, w: 1.6, h: 1.6, lit: 0.6, glowCol: [1, 0.86, 0.68] });
      flat(b, sp(MAT.plaster, [0.7, 0.7, 0.68]), b.hall ? 1.2 : 0.4);
      top = Math.max(top, b.h);
    }
    S.quad(P(-m.bw / 2 - 0.6, base, -m.bd / 2 - 0.6), V(m.bw + 1.2, 0, 0), V(0, 0, m.bd + 1.2), sp(MAT.stone, [0.5, 0.49, 0.47]), [0, 1, 0]);
    drawDoor(sp(MAT.wood, [0.3, 0.22, 0.16]));
    steps(base, 1, 2);
  }

  /* 烟囱(砖的、木的风格才有):两坡顶的屋脊边上 */
  if ((style === 'tang' || style === 'edo' || style === 'modern' && rnd() < 0.3) && B.length > 1) {
    const b = B.find((q) => !q.hall) || hall;
    const q = P(b.x1 - 0.8, 0, (b.z0 + b.z1) / 2);
    const hh = top + 0.6;
    S.box([q[0], b.h, q[2]], V(1, 0, 0), V(0, 0, 1), 0.6, hh - b.h, 0.6, sp(MAT.brick, [0.38, 0.3, 0.26], [0.5, 0.5, 0.48]));
    out.smokes.push({ x: q[0], y: hh, z: q[2], k: 1 });
    out.perches.push({ x: q[0], y: hh + 0.02, z: q[2] });
  }

  /* 碰撞:整栋一个外接矩形(台基、柱廊、塔门都算进去),门口留在它前面。
     逐个体块挡会在厅和屋之间留缝 —— 人能挤进两间屋子中间去。 */
  const pad = style === 'maya' ? 2.8 : style === 'hellas' ? 1.6 : style === 'edo' ? 0.9 : style === 'tang' ? 0.3 : 0.2;
  const sideX = style === 'giza' ? Math.max(m.bw / 2, 4.4) : m.bw / 2 + pad;
  const frontZ = style === 'maya' ? m.bd / 2 + 3.1 : style === 'giza' ? m.bd / 2 + 0.7 : style === 'tang' ? m.bd / 2 + 0.7
    : style === 'persia' ? front.z1 + 1.0 : Math.max(front.z1, m.bd / 2) + (style === 'hellas' ? 1.6 : 0.2);
  const poly = [[sideX, frontZ], [-sideX, frontZ], [-sideX, -m.bd / 2 - pad], [sideX, -m.bd / 2 - pad]].map(([u, v]) => { const q = P(u, 0, v); return [q[0], q[2]]; });
  out.blocks.push({ poly, x: cx, z: cz, r: Math.hypot(sideX, m.bd / 2 + pad) + 1 });
  const dy = out.doorY || 0;
  out.doorY = 0;
  const dp = P(doorU, 0, frontZ + 1.1);
  return { door: { x: dp[0], z: dp[2], y: dy }, top, doorAt, frontZ };
}
