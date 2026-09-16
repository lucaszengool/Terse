/**
 * town-life.js — 把 town-life-sim.js 里那几百只活物画成粒子。
 *
 *   一种动物 = 一朵模板点云(几个椭球,Fibonacci 球面取点,点数按面积分)+ 一次 draw call。
 *   每只的位置、朝向、步子、姿势是实例属性,腿怎么甩、头怎么低、翅膀怎么扇全在顶点着色器里 ——
 *   CPU 每帧只写 8 个数一只。
 *
 *   虫和鱼没有 CPU 状态:蜜蜂在花之间飞、蝴蝶乱晃、蛾子绕灯、鱼在水里一闪,全按时间算。
 *   (萤火虫 room-atmos 已经有了,这里不画。)
 *
 * 光、雾、色调和小镇同一套公式,动物站在墙边不会像贴上去的。
 */
import * as THREE from 'three';
import { createSim } from './town-life-sim.js';

/* ── 模板:椭球拼出来的动物 ─────────────────────────────────────────────── */
/* 部位号:0 身子 · 1 头(连脖子、耳朵、角)· 2–5 腿 左前 右前 左后 右后 · 6 尾巴 · 7 翅膀 */
const E = (part, c, r, col, pivot, o = {}) => Object.assign({ part, c, r, col, pivot: pivot || c }, o);
const ellArea = (a, b, c) => { const p = 1.6075; return 4 * Math.PI * Math.pow((Math.pow(a * b, p) + Math.pow(a * c, p) + Math.pow(b * c, p)) / 3, 1 / p); };
const hashN = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** 椭球表面取点。点数 ∝ 面积 × 权重(腿和头太细,按面积分只剩一两颗,就给它加权)。 */
function bake(parts, n, scale) {
  const areas = parts.map((q) => ellArea(q.r[0], q.r[1], q.r[2]) * (q.w || 1));
  const tot = areas.reduce((a, b) => a + b, 0);
  const pos = [], piv = [], nrm = [], col = [], part = [], tint = [], size = [];
  const GA = Math.PI * (3 - Math.sqrt(5));
  let seed = 1;
  parts.forEach((q, pi) => {
    const k = Math.max(q.min || 4, Math.round(n * areas[pi] / tot));
    const sz = Math.sqrt(ellArea(q.r[0], q.r[1], q.r[2]) / k) * 1.05 * scale;   // 比点距略大:挨着成面,不成珠子
    const ct = Math.cos(q.tilt || 0), st = Math.sin(q.tilt || 0);
    for (let i = 0; i < k; i++) {
      const uy = 1 - 2 * (i + 0.5) / k, rr = Math.sqrt(1 - uy * uy), th = i * GA + pi;
      const ux = Math.cos(th) * rr, uz = Math.sin(th) * rr;
      let lx = ux * q.r[0], ly = uy * q.r[1], lz = uz * q.r[2];
      let nx = ux / q.r[0], ny = uy / q.r[1], nz = uz / q.r[2];
      // tilt > 0 = 前端往下(和着色器里低头同一个方向)
      [ly, lz] = [ly * ct - lz * st, lz * ct + ly * st];
      [ny, nz] = [ny * ct - nz * st, nz * ct + ny * st];
      const nl = Math.hypot(nx, ny, nz) || 1;
      const p = [q.c[0] + lx, q.c[1] + ly, q.c[2] + lz];
      let cc = typeof q.col === 'function' ? q.col(p, [ux, uy, uz]) : q.col;
      const j = 0.94 + hashN(seed++) * 0.12;                     // 每颗点一点点色差,不是一块塑料
      pos.push(p[0] * scale, p[1] * scale, p[2] * scale);
      piv.push(q.pivot[0] * scale, q.pivot[1] * scale, q.pivot[2] * scale);
      nrm.push(nx / nl, ny / nl, nz / nl);
      col.push(cc[0] * j, cc[1] * j, cc[2] * j);
      part.push(q.part); tint.push(q.tint ? 1 : 0); size.push(sz);
    }
  });
  return { pos, piv, nrm, col, part, tint, size, n: part.length };
}

/** 四条腿的:身子一个椭球,腿四根,头和尾巴由各自给。尺寸是真实的米。 */
function quad(o) {
  const { L, H, Wd, leg } = o;
  const by = leg + H / 2 - (o.sag || 0);
  const lr = o.legR || Math.max(0.018, Wd * 0.13);
  const parts = [E(0, [0, by, 0], [Wd / 2, H / 2, L / 2], o.col, [0, by, 0], { tint: o.tint !== false, min: 20 })];
  const lx = Wd / 2 * 0.6, lz = L / 2 * 0.64;
  [[-lx, lz], [lx, lz], [-lx, -lz], [lx, -lz]].forEach(([x, z], i) => {
    parts.push(E(2 + i, [x, leg / 2, z], [lr, leg / 2 + 0.01, lr * 1.1], o.legCol || o.col, [x, leg + H * 0.12, z], { w: 3, min: 5, tint: !o.legCol }));
  });
  return { parts, by, rear: -L / 2, leg };
}

/** 鸟:纺锤身子、圆头、尖嘴、尾羽、两片翅膀(飞的时候展开,落下收起)。 */
function bird(o) {
  const { L, span } = o, leg = o.leg || L * 0.18;
  const y = leg + L * 0.2;
  const hy = y + (o.neck || 0) + L * 0.18, hz = L * 0.42 + (o.neck || 0) * 0.3;
  const np = [0, y + L * 0.08, L * 0.3];
  const parts = [
    E(0, [0, y, 0], [L * (o.fat || 0.2), L * (o.fat || 0.2) * 1.1, L * 0.45], o.body, [0, y, 0], { min: 12 }),
    E(1, [0, hy, hz], [L * (o.headR || 0.15), L * (o.headR || 0.15), L * (o.headR || 0.15) * 1.1], o.head || o.body, np, { w: 2, min: 6 }),
    E(1, [0, hy - L * 0.02, hz + L * (o.headR || 0.15) + L * (o.beak || 0.08) * 0.8], [L * 0.03, L * 0.03, L * (o.beak || 0.08)], o.beakCol || [0.2, 0.18, 0.15], np, { w: 3, min: 3 }),
    E(2, [-L * 0.06, leg / 2, 0], [0.006 + L * 0.015, leg / 2, 0.006 + L * 0.015], o.legCol || [0.25, 0.2, 0.15], [-L * 0.06, leg, 0], { w: 4, min: 3 }),
    E(3, [L * 0.06, leg / 2, 0], [0.006 + L * 0.015, leg / 2, 0.006 + L * 0.015], o.legCol || [0.25, 0.2, 0.15], [L * 0.06, leg, 0], { w: 4, min: 3 }),
  ];
  if (o.neck) parts.push(E(1, [0, y + o.neck * 0.55, L * 0.36], [L * 0.05, o.neck * 0.6, L * 0.06], o.neckCol || o.body, np, { w: 2, min: 5, tilt: -0.3 }));
  if (o.fork) for (const s of [-1, 1]) parts.push(E(6, [s * L * 0.05, y + L * 0.02, -L * 0.62], [L * 0.03, L * 0.012, L * 0.32], o.tailCol || o.body, [0, y, -L * 0.4], { min: 4 }));
  else parts.push(E(6, [0, y + L * 0.03, -L * 0.55], [L * 0.1, L * 0.018, L * 0.2], o.tailCol || o.body, [0, y, -L * 0.4], { min: 5 }));
  for (const s of [-1, 1]) {
    parts.push(E(7, [s * (span / 4 + L * 0.05), y + L * 0.1, -L * 0.03], [span / 4, L * 0.022, L * (o.chord || 0.2)], o.wing || o.body,
      [s * L * 0.1, y + L * 0.1, 0], { min: 8, w: 1.4 }));
  }
  return parts.concat(o.extra ? o.extra(y, L) : []);
}

const DARK = [0.08, 0.07, 0.065];
const patches = (a, b, k) => (p) => (hashN(Math.floor(p[0] * k) * 13 + Math.floor(p[1] * k) * 7 + Math.floor(p[2] * k) * 3) < 0.38 ? b : a);
const tipped = (base, tip, at) => (p) => (Math.abs(p[0]) > at ? tip : base);

/* 每种动物:点数(预算 1 时)、放大倍数(小东西夸张一点才认得出)、模板、姿势参数、实例的毛色 */
const SPEC = {
  sheep: {
    n: 260, s: 1.1, tints: [[1, 1, 1], [1, 1, 1], [1, 1, 1], [0.97, 0.94, 0.86], [1, 1, 1], [0.24, 0.22, 0.2]],
    build() {
      const q = quad({ L: 1.1, H: 0.6, Wd: 0.62, leg: 0.36, col: [0.9, 0.88, 0.8], legCol: DARK, legR: 0.035, sag: -0.02 });
      q.parts.push(E(1, [0, q.by + 0.16, 0.62], [0.1, 0.12, 0.16], [0.1, 0.09, 0.085], [0, q.by + 0.1, 0.45], { w: 1.6, tilt: 0.5, min: 10 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.12, q.by + 0.25, 0.58], [0.06, 0.02, 0.03], [0.12, 0.1, 0.09], [0, q.by + 0.1, 0.45], { min: 3 }));
      q.parts.push(E(6, [0, q.by + 0.05, -0.58], [0.05, 0.08, 0.04], [0.86, 0.84, 0.76], [0, q.by + 0.15, -0.54], { tint: true, min: 3 }));
      return q;
    },
    gait: [0.45, 0, 0.012, 0], wag: [0.15, 3],
  },
  cow: {
    n: 380, s: 1, tints: [[1, 1, 1], [1, 1, 1], [0.62, 0.4, 0.26], [0.78, 0.56, 0.36]],
    build() {
      const q = quad({ L: 2.1, H: 0.9, Wd: 0.72, leg: 0.72, col: patches([0.93, 0.91, 0.87], [0.06, 0.055, 0.05], 3.2), legCol: null, legR: 0.07 });
      const hp = [0, q.by + 0.25, 0.85];
      q.parts.push(E(1, [0, q.by + 0.22, 1.08], [0.2, 0.26, 0.26], [0.9, 0.88, 0.84], hp, { tint: true, min: 10 }));
      q.parts.push(E(1, [0, q.by + 0.28, 1.36], [0.14, 0.17, 0.25], patches([0.9, 0.88, 0.84], [0.06, 0.055, 0.05], 5), hp, { tint: true, tilt: 0.7, w: 1.4, min: 14 }));
      q.parts.push(E(1, [0, q.by + 0.02, 1.52], [0.1, 0.07, 0.07], [0.75, 0.55, 0.52], hp, { min: 4 }));
      for (const s of [-1, 1]) {
        q.parts.push(E(1, [s * 0.2, q.by + 0.5, 1.28], [0.09, 0.022, 0.022], [0.85, 0.8, 0.66], hp, { w: 3, min: 4 }));
        q.parts.push(E(1, [s * 0.2, q.by + 0.38, 1.24], [0.08, 0.04, 0.03], [0.2, 0.17, 0.15], hp, { min: 3 }));
      }
      q.parts.push(E(0, [0, 0.72, -0.35], [0.14, 0.1, 0.16], [0.85, 0.6, 0.58], [0, q.by, 0], { min: 5 }));
      q.parts.push(E(6, [0, q.by - 0.1, -1.07], [0.03, 0.38, 0.03], [0.1, 0.09, 0.08], [0, q.by + 0.3, -1.05], { w: 3, min: 6 }));
      return q;
    },
    gait: [0.32, 0, 0.015, 0], wag: [0.25, 1.4], legTint: true,
  },
  horse: {
    n: 360, s: 1, tints: [[0.45, 0.28, 0.16], [0.6, 0.33, 0.16], [0.82, 0.8, 0.77], [0.16, 0.13, 0.12], [0.5, 0.36, 0.24]],
    build() {
      const q = quad({ L: 1.8, H: 0.72, Wd: 0.56, leg: 0.92, col: [1, 1, 1], legR: 0.055 });
      const np = [0, q.by + 0.18, 0.72];
      q.parts.push(E(1, [0, q.by + 0.5, 0.98], [0.13, 0.42, 0.17], [1, 1, 1], np, { tint: true, tilt: -0.72, min: 16 }));
      q.parts.push(E(1, [0, q.by + 0.78, 1.28], [0.1, 0.13, 0.3], [1, 1, 1], np, { tint: true, tilt: 0.95, w: 1.3, min: 14 }));
      q.parts.push(E(1, [0, q.by + 0.58, 0.88], [0.035, 0.42, 0.07], [0.08, 0.06, 0.05], np, { tilt: -0.72, w: 1.5, min: 10 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.05, q.by + 0.98, 1.15], [0.02, 0.06, 0.02], [0.3, 0.25, 0.2], np, { min: 3 }));
      q.parts.push(E(6, [0, q.by - 0.12, -1.0], [0.06, 0.42, 0.08], [0.08, 0.06, 0.05], [0, q.by + 0.25, -0.9], { tilt: -0.3, w: 1.6, min: 10 }));
      return q;
    },
    gait: [0.4, 0, 0.02, 0], wag: [0.2, 1.1],
  },
  goat: {
    n: 200, s: 1, tints: [[1, 1, 1], [0.62, 0.45, 0.3], [0.25, 0.2, 0.18], [0.85, 0.8, 0.72]],
    build() {
      const q = quad({ L: 0.9, H: 0.45, Wd: 0.36, leg: 0.5, col: [0.92, 0.9, 0.85], legR: 0.03 });
      const np = [0, q.by + 0.12, 0.35];
      q.parts.push(E(1, [0, q.by + 0.28, 0.46], [0.07, 0.18, 0.08], [0.92, 0.9, 0.85], np, { tint: true, tilt: -0.4, min: 8 }));
      q.parts.push(E(1, [0, q.by + 0.42, 0.6], [0.07, 0.08, 0.15], [0.92, 0.9, 0.85], np, { tint: true, tilt: 0.6, min: 10 }));
      q.parts.push(E(1, [0, q.by + 0.24, 0.68], [0.02, 0.07, 0.02], [0.3, 0.27, 0.22], np, { w: 3, min: 3 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.05, q.by + 0.58, 0.5], [0.018, 0.1, 0.02], [0.35, 0.3, 0.24], np, { tilt: -0.6, w: 3, min: 4 }));
      q.parts.push(E(6, [0, q.by + 0.22, -0.46], [0.03, 0.08, 0.03], [0.92, 0.9, 0.85], [0, q.by + 0.15, -0.42], { tint: true, tilt: -0.5, min: 3 }));
      return q;
    },
    gait: [0.45, 0, 0.012, 0], wag: [0.5, 6],
  },
  pig: {
    n: 220, s: 1, tints: [[1, 1, 1], [1, 1, 1], [0.5, 0.4, 0.38]],
    build() {
      const pink = [0.93, 0.66, 0.62];
      const q = quad({ L: 1.0, H: 0.55, Wd: 0.5, leg: 0.28, col: pink, legR: 0.04 });
      const np = [0, q.by, 0.4];
      q.parts.push(E(1, [0, q.by + 0.02, 0.56], [0.17, 0.17, 0.16], pink, np, { tint: true, min: 10 }));
      q.parts.push(E(1, [0, q.by - 0.03, 0.74], [0.07, 0.06, 0.04], [0.8, 0.5, 0.48], np, { w: 2, min: 4 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.1, q.by + 0.18, 0.6], [0.05, 0.02, 0.05], pink, np, { tint: true, tilt: 0.5, min: 3 }));
      q.parts.push(E(6, [0, q.by + 0.1, -0.53], [0.03, 0.03, 0.04], pink, [0, q.by + 0.08, -0.5], { tint: true, min: 3 }));
      return q;
    },
    gait: [0.5, 0, 0.012, 0], wag: [0.6, 5],
  },
  deer: {
    n: 240, s: 1,
    build() {
      const br = [0.55, 0.37, 0.22];
      const q = quad({ L: 1.3, H: 0.5, Wd: 0.36, leg: 0.82, col: br, legR: 0.028 });
      const np = [0, q.by + 0.12, 0.5];
      q.parts.push(E(1, [0, q.by + 0.4, 0.62], [0.07, 0.3, 0.09], br, np, { tilt: -0.3, min: 10 }));
      q.parts.push(E(1, [0, q.by + 0.7, 0.78], [0.07, 0.08, 0.17], br, np, { tilt: 0.5, w: 1.4, min: 10 }));
      for (const s of [-1, 1]) {
        q.parts.push(E(1, [s * 0.09, q.by + 0.8, 0.68], [0.05, 0.03, 0.02], br, np, { min: 3 }));
        q.parts.push(E(1, [s * 0.1, q.by + 0.98, 0.66], [0.02, 0.17, 0.02], [0.72, 0.62, 0.48], np, { tilt: -0.3, w: 3, min: 5 }));
        q.parts.push(E(1, [s * 0.16, q.by + 1.05, 0.72], [0.06, 0.015, 0.015], [0.72, 0.62, 0.48], np, { w: 3, min: 3 }));
      }
      q.parts.push(E(6, [0, q.by + 0.1, -0.66], [0.07, 0.1, 0.04], [0.95, 0.93, 0.9], [0, q.by + 0.15, -0.64], { w: 2, min: 6 }));
      return q;
    },
    gait: [0.5, 0, 0.02, 0], wag: [0.3, 4],
  },
  dog: {
    n: 160, s: 1.1, tints: [[0.55, 0.35, 0.2], [0.15, 0.13, 0.12], [0.85, 0.65, 0.35], [0.9, 0.88, 0.84], [0.5, 0.48, 0.46]],
    build() {
      const q = quad({ L: 0.7, H: 0.3, Wd: 0.24, leg: 0.32, col: [1, 1, 1], legR: 0.025 });
      const np = [0, q.by + 0.08, 0.3];
      q.parts.push(E(1, [0, q.by + 0.2, 0.42], [0.09, 0.1, 0.1], [1, 1, 1], np, { tint: true, min: 10 }));
      q.parts.push(E(1, [0, q.by + 0.16, 0.55], [0.045, 0.045, 0.08], [0.9, 0.9, 0.9], np, { tint: true, min: 5 }));
      q.parts.push(E(1, [0, q.by + 0.17, 0.63], [0.018, 0.018, 0.012], DARK, np, { min: 2 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.07, q.by + 0.27, 0.4], [0.025, 0.06, 0.02], [0.7, 0.7, 0.7], np, { tint: true, w: 2, min: 3 }));
      q.parts.push(E(6, [0, q.by + 0.12, -0.44], [0.025, 0.025, 0.14], [1, 1, 1], [0, q.by + 0.04, -0.33], { tint: true, tilt: -0.8, w: 2, min: 5 }));
      return q;
    },
    gait: [0.6, 0, 0.012, 0], wag: [0.7, 13],
  },
  fox: {
    n: 150, s: 1.1,
    build() {
      const or = [0.85, 0.4, 0.13];
      const q = quad({ L: 0.65, H: 0.26, Wd: 0.2, leg: 0.3, col: or, legCol: [0.12, 0.08, 0.06], legR: 0.02 });
      const np = [0, q.by + 0.06, 0.28];
      q.parts.push(E(1, [0, q.by + 0.14, 0.38], [0.08, 0.08, 0.09], or, np, { min: 8 }));
      q.parts.push(E(1, [0, q.by + 0.1, 0.5], [0.035, 0.035, 0.08], [0.92, 0.88, 0.82], np, { min: 4 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.05, q.by + 0.24, 0.36], [0.022, 0.05, 0.012], [0.15, 0.08, 0.05], np, { w: 2, min: 3 }));
      q.parts.push(E(0, [0, q.by - 0.04, 0.24], [0.07, 0.08, 0.08], [0.92, 0.88, 0.82], [0, q.by, 0], { min: 4 }));
      q.parts.push(E(6, [0, q.by - 0.02, -0.5], [0.06, 0.06, 0.24], (p) => (p[2] < -0.66 ? [0.95, 0.93, 0.9] : or), [0, q.by + 0.02, -0.3], { tilt: 0.3, w: 1.3, min: 10 }));
      return q;
    },
    gait: [0.6, 0, 0.012, 0], wag: [0.2, 2],
  },
  cat: {
    n: 100, s: 1.35, tints: [[0.55, 0.55, 0.55], [0.12, 0.11, 0.11], [0.9, 0.55, 0.25], [0.95, 0.93, 0.9], [0.6, 0.45, 0.3]],
    build() {
      const q = quad({ L: 0.4, H: 0.17, Wd: 0.15, leg: 0.17, col: [1, 1, 1], legR: 0.014 });
      const np = [0, q.by + 0.04, 0.17];
      q.parts.push(E(1, [0, q.by + 0.1, 0.25], [0.055, 0.052, 0.055], [1, 1, 1], np, { tint: true, w: 1.5, min: 8 }));
      for (const s of [-1, 1]) q.parts.push(E(1, [s * 0.032, q.by + 0.16, 0.24], [0.014, 0.03, 0.01], [0.9, 0.9, 0.9], np, { tint: true, w: 3, min: 3 }));
      q.parts.push(E(1, [0, q.by + 0.1, 0.305], [0.012, 0.012, 0.008], [0.8, 0.5, 0.5], np, { min: 1 }));
      const tp = [0, q.by + 0.04, -0.19];
      q.parts.push(E(6, [0, q.by + 0.13, -0.22], [0.016, 0.1, 0.016], [1, 1, 1], tp, { tint: true, tilt: 0.2, w: 2.5, min: 5 }));
      q.parts.push(E(6, [0, q.by + 0.24, -0.18], [0.015, 0.05, 0.015], [1, 1, 1], tp, { tint: true, tilt: -0.6, w: 2.5, min: 3 }));
      return q;
    },
    gait: [0.6, 0, 0.006, 0], wag: [0.35, 2.5],
  },
  rabbit: {
    n: 80, s: 1.3,
    build() {
      const gb = [0.55, 0.47, 0.37];
      const parts = [
        E(0, [0, 0.14, -0.01], [0.085, 0.1, 0.14], gb, [0, 0.14, 0], { min: 14 }),
        E(1, [0, 0.23, 0.12], [0.055, 0.055, 0.065], gb, [0, 0.18, 0.08], { w: 1.5, min: 8 }),
        E(2, [-0.04, 0.05, 0.1], [0.015, 0.05, 0.015], gb, [-0.04, 0.1, 0.1], { w: 3, min: 3 }),
        E(3, [0.04, 0.05, 0.1], [0.015, 0.05, 0.015], gb, [0.04, 0.1, 0.1], { w: 3, min: 3 }),
        E(4, [-0.06, 0.06, -0.07], [0.03, 0.055, 0.07], gb, [-0.06, 0.1, -0.05], { w: 1.5, min: 4 }),
        E(5, [0.06, 0.06, -0.07], [0.03, 0.055, 0.07], gb, [0.06, 0.1, -0.05], { w: 1.5, min: 4 }),
        E(6, [0, 0.15, -0.16], [0.03, 0.03, 0.025], [0.95, 0.93, 0.9], [0, 0.15, -0.14], { w: 2, min: 4 }),
      ];
      for (const s of [-1, 1]) parts.push(E(1, [s * 0.025, 0.33, 0.1], [0.014, 0.075, 0.01], [0.5, 0.42, 0.34], [0, 0.18, 0.08], { tilt: -0.25, w: 2.5, min: 4 }));
      return { parts, rear: -0.14, leg: 0.1 };
    },
    gait: [0.2, 0.12, 0, 0], wag: [0.1, 6],
  },
  chicken: {
    n: 90, s: 1.3, tints: [[1, 1, 1], [0.62, 0.35, 0.18], [0.62, 0.35, 0.18], [0.15, 0.14, 0.16], [0.75, 0.7, 0.62]],
    build() {
      const wc = [0.95, 0.93, 0.88];
      const parts = bird({ L: 0.34, span: 0.5, leg: 0.12, fat: 0.28, headR: 0.13, beak: 0.05, body: wc, wing: wc, beakCol: [0.85, 0.65, 0.2], legCol: [0.85, 0.62, 0.2], neck: 0.06,
        extra: (y, L) => [
          E(1, [0, y + L * 0.62, L * 0.44], [0.01, 0.028, 0.03], [0.8, 0.1, 0.08], [0, y + L * 0.08, L * 0.3], { w: 4, min: 4 }),
          E(1, [0, y + L * 0.28, L * 0.56], [0.008, 0.018, 0.01], [0.8, 0.1, 0.08], [0, y + L * 0.08, L * 0.3], { w: 4, min: 2 }),
          E(6, [0, y + L * 0.3, -L * 0.42], [0.02, 0.09, 0.06], wc, [0, y + L * 0.1, -L * 0.36], { tilt: 0.5, tint: true, w: 1.5, min: 6 }),
        ] });
      for (const p of parts) if (p.part === 0 || p.part === 7) p.tint = true;
      // 鸟那条平尾换成上面那条翘起来的
      return { parts: parts.filter((p) => !(p.part === 6 && !p.tint)), rear: -0.15, leg: 0.12 };
    },
    gait: [0.7, 0, 0.008, 18], wag: [0, 1], flapAlways: true,
  },
  duck: {
    n: 90, s: 1.3,
    build() {
      const parts = bird({ L: 0.4, span: 0.7, leg: 0.06, fat: 0.26, headR: 0.12, beak: 0.08, body: [0.5, 0.45, 0.38], wing: [0.42, 0.38, 0.32],
        head: [0.04, 0.3, 0.12], beakCol: [0.85, 0.72, 0.2], legCol: [0.9, 0.5, 0.15], neck: 0.07, neckCol: [0.04, 0.3, 0.12], tailCol: [0.15, 0.13, 0.12],
        extra: (y, L) => [E(0, [0, y + L * 0.04, L * 0.3], [L * 0.14, L * 0.14, L * 0.1], [0.4, 0.22, 0.14], [0, y, 0], { min: 5 }),
          E(1, [0, y + L * 0.14, L * 0.36], [L * 0.07, L * 0.02, L * 0.07], [0.95, 0.95, 0.95], [0, y + L * 0.08, L * 0.3], { w: 3, min: 4 })] });
      return { parts, rear: -0.18, leg: 0.06 };
    },
    gait: [0.6, 0, 0.005, 16], wag: [0.3, 4], sink: 0.1,
  },
  goose: {
    n: 110, s: 1.15,
    build() {
      const parts = bird({ L: 0.75, span: 1.5, leg: 0.2, fat: 0.24, headR: 0.08, beak: 0.08, body: [0.94, 0.93, 0.9], wing: tipped([0.9, 0.9, 0.88], [0.6, 0.6, 0.62], 0.35),
        beakCol: [0.95, 0.5, 0.12], legCol: [0.95, 0.5, 0.12], neck: 0.36 });
      return { parts, rear: -0.33, leg: 0.2 };
    },
    gait: [0.5, 0, 0.01, 10], wag: [0.2, 3],
  },
  sparrow: {
    n: 60, s: 1.4,
    build: () => ({ parts: bird({ L: 0.15, span: 0.24, leg: 0.025, body: [0.55, 0.42, 0.28], head: [0.45, 0.36, 0.28], wing: [0.42, 0.3, 0.2], beakCol: [0.2, 0.18, 0.16], legCol: [0.35, 0.28, 0.2],
      extra: (y, L) => [E(0, [0, y - L * 0.07, L * 0.12], [L * 0.14, L * 0.1, L * 0.22], [0.82, 0.78, 0.7], [0, y, 0], { min: 4 })] }), leg: 0.025, rear: -0.07 }),
    gait: [0.3, 0.03, 0, 60], wag: [0.1, 8],
  },
  pigeon: {
    n: 70, s: 1.25,
    build: () => ({ parts: bird({ L: 0.32, span: 0.64, leg: 0.05, body: [0.52, 0.54, 0.6], head: [0.45, 0.47, 0.53], wing: tipped([0.58, 0.6, 0.66], [0.2, 0.2, 0.24], 0.24), beakCol: [0.3, 0.28, 0.28], legCol: [0.7, 0.3, 0.3],
      extra: (y, L) => [E(0, [0, y + L * 0.12, L * 0.3], [L * 0.12, L * 0.12, L * 0.1], [0.3, 0.45, 0.4], [0, y, 0], { min: 5 })] }), leg: 0.05, rear: -0.15 }),
    gait: [0.5, 0, 0.006, 42], wag: [0.05, 3],
  },
  rook: {
    n: 70, s: 1.15,
    build: () => ({ parts: bird({ L: 0.45, span: 0.9, leg: 0.07, body: [0.05, 0.05, 0.065], wing: tipped([0.06, 0.06, 0.08], [0.03, 0.03, 0.04], 0.3), beak: 0.12, beakCol: [0.35, 0.33, 0.33], legCol: [0.05, 0.05, 0.05] }), leg: 0.07, rear: -0.2 }),
    gait: [0.5, 0, 0.006, 30], wag: [0.05, 3],
  },
  swallow: {
    n: 60, s: 1.5,
    build: () => ({ parts: bird({ L: 0.17, span: 0.33, leg: 0.02, body: (p) => (p[1] < 0.035 ? [0.92, 0.9, 0.86] : [0.05, 0.07, 0.2]), wing: [0.05, 0.06, 0.16], head: [0.05, 0.07, 0.2], fork: true, chord: 0.12,
      extra: (y, L) => [E(1, [0, y + L * 0.1, L * 0.5], [L * 0.06, L * 0.05, L * 0.04], [0.6, 0.12, 0.08], [0, y + L * 0.08, L * 0.3], { min: 3 })] }), leg: 0.02, rear: -0.08 }),
    gait: [0, 0, 0, 55], wag: [0, 1],
  },
  bat: {
    n: 60, s: 1.5,
    build: () => ({ parts: bird({ L: 0.09, span: 0.3, leg: 0.01, fat: 0.25, body: [0.14, 0.1, 0.08], wing: [0.1, 0.07, 0.06], chord: 0.45, headR: 0.18, beak: 0.02,
      extra: (y, L) => [-1, 1].map((s) => E(1, [s * L * 0.1, y + L * 0.35, L * 0.4], [L * 0.03, L * 0.08, L * 0.02], [0.12, 0.08, 0.07], [0, y, L * 0.3], { min: 2 })) }), leg: 0.01, rear: -0.04 }),
    gait: [0, 0, 0, 70], wag: [0, 1],
  },
  stork: {
    n: 160, s: 1,
    build() {
      const red = [0.85, 0.2, 0.12];
      const parts = bird({ L: 0.95, span: 1.9, leg: 0.52, fat: 0.17, headR: 0.06, beak: 0.2, body: [0.94, 0.93, 0.9], wing: tipped([0.94, 0.93, 0.9], [0.05, 0.05, 0.05], 0.5),
        beakCol: red, legCol: red, neck: 0.3, chord: 0.18 });
      return { parts, rear: -0.4, leg: 0.52 };
    },
    gait: [0.4, 0, 0.005, 12], wag: [0, 1],
  },
  owl: {
    n: 100, s: 1.2,
    build() {
      const parts = bird({ L: 0.36, span: 0.95, leg: 0.03, fat: 0.36, headR: 0.3, beak: 0.03, body: [0.5, 0.38, 0.26], wing: [0.45, 0.34, 0.24], head: [0.55, 0.43, 0.3], beakCol: [0.3, 0.26, 0.2], chord: 0.3,
        extra: (y, L) => [E(1, [0, y + L * 0.36, L * 0.52], [L * 0.2, L * 0.17, L * 0.04], [0.85, 0.8, 0.7], [0, y + L * 0.08, L * 0.3], { min: 8 })] });
      // 猫头鹰是竖着的:身子立起来,头在正上方
      for (const p of parts) if (p.part === 0) { p.r = [p.r[0], p.r[2] * 0.9, p.r[1]]; }
      return { parts, rear: -0.1, leg: 0.03 };
    },
    gait: [0, 0, 0, 20], wag: [0, 1],
  },
};

/* ── 着色器 ───────────────────────────────────────────────────────────── */
const LIFE_VS = `
attribute vec3 aPivot, aCol, aNrm;
attribute float aPart, aSize, aTint;
attribute vec4 iPosYaw, iAnim;
attribute vec3 iTint;
attribute float iSeed;
uniform float uTime, uPx, uNight, uFogA, uFogB, uExposure;
uniform vec3 uFogAway, uSunDir, uSunCol, uSky;
uniform vec4 uGait;   // 腿摆幅(弧度)· 跳多高 · 颠多少(米)· 翅膀拍多快
uniform vec4 uBody;   // 屁股在哪(z)· 腿长 · 冬毛 · 浮水沉多少
uniform vec2 uWag;    // 尾巴摆幅、快慢
varying vec3 vC;
vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
bool is(float st, float k){ return abs(st - k) < 0.5; }
void main(){
  if (iPosYaw.y < -500.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec3(0.0); return; }
  float ph = iAnim.x * 6.2831853, spd = iAnim.y, st = iAnim.z, pitch = iAnim.w;
  bool fly = st > 8.5 && st < 11.5, glide = is(st, 11.0), sit = is(st, 7.0);
  vec3 p = position, n = aNrm, q = p - aPivot;
  if (aPart < 0.5) {
    p = aPivot + q * uBody.z;                                    // 冬天毛厚一圈
  } else if (aPart < 1.5) {
    float pk = pitch;
    if (is(st, 16.0)) pk += max(0.0, sin(uTime * 9.0 + iSeed * 40.0)) * 0.9;   // 啄
    if (is(st, 17.0)) pk += 0.35 * sin(uTime * 2.5 + iSeed * 9.0);            // 舔毛
    if (is(st, 2.0)) pk += 0.08 * sin(uTime * 1.3 + iSeed * 20.0);             // 嚼
    q.zy = rot(q.zy, -pk); n.zy = rot(n.zy, -pk);                // pk > 0 低头
    p = aPivot + q;
  } else if (aPart < 5.5) {
    if (fly) p = aPivot + q * 0.3;                               // 飞的时候腿收起来
    else if (is(st, 13.0)) p = aPivot;                           // 游着:脚在水下
    else {
      bool diag = aPart < 2.5 || aPart > 4.5;                    // 左前 + 右后一对(小跑的对角步)
      float a = uGait.x * spd * 2.0 * sin(ph + (diag ? 0.0 : 3.14159));
      if (uGait.y > 0.0 && aPart > 3.5) a = -0.8 * sin(iAnim.x * 3.14159) * min(1.0, spd * 6.0);
      if (sit && aPart < 3.5) a = -0.55;                         // 坐着:前腿撑直
      if (sit && aPart > 3.5) q.y *= 0.4;
      q.zy = rot(q.zy, a);
      p = aPivot + q;
    }
  } else if (aPart < 6.5) {
    float calm = (is(st, 0.0) || sit || is(st, 14.0)) ? 1.0 : 0.35;
    q.xz = rot(q.xz, sin(uTime * uWag.y + iSeed * 30.0) * uWag.x * calm);
    p = aPivot + q;
  } else {
    if (fly) {
      float f = glide ? 0.12 * sin(uTime * 1.3 + iSeed * 9.0) : sin(uTime * uGait.w + iSeed * 40.0) * 0.95;
      q.xy = rot(q.xy, f * sign(q.x + 1e-4));
    } else if (is(st, 4.0) && uGait.w > 0.0 && uGait.w < 20.0) {
      q.xy = rot(q.xy, sin(uTime * uGait.w + iSeed * 40.0) * 0.7 * sign(q.x + 1e-4));   // 鸡鸭跑的时候扑腾
    } else { q.x *= 0.22; q.z *= 0.9; }                          // 收起来贴着身子
    p = aPivot + q;
  }
  if (sit) {                                                     // 以后胯为轴,前面抬起来,整个矮一截
    vec3 r = p - vec3(0.0, uBody.y, uBody.x);
    r.zy = rot(r.zy, 0.55); n.zy = rot(n.zy, 0.55);
    p = r + vec3(0.0, 0.0, uBody.x);
    p.y = max(p.y, 0.0);
  }
  if (is(st, 8.0)) { p.y *= 0.45; p.x *= 1.15; }                 // 趴着睡
  if (is(st, 13.0)) p.y -= uBody.w;
  if (fly) p.y += sin(uTime * 3.0 + iSeed * 20.0) * 0.02;
  else {
    p.y += sin(ph * 2.0) * uGait.z * min(1.0, spd * 3.0);
    if (uGait.y > 0.0) p.y += uGait.y * sin(iAnim.x * 3.14159) * min(1.0, spd * 6.0);
  }
  float s = 0.9 + 0.2 * iSeed;
  p *= s;
  float cy = cos(iPosYaw.w), sy = sin(iPosYaw.w);
  vec3 w = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy) + iPosYaw.xyz;
  vec3 N = normalize(vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy));
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float d = -mv.z;
  gl_PointSize = d > 420.0 ? 0.0 : clamp(aSize * s * uPx / max(0.2, d), 1.0, 24.0);
  vec3 alb = aCol * mix(vec3(1.0), iTint, aTint);
  vec3 lit = uSky * 0.75 + uSunCol * max(dot(N, uSunDir), 0.0) * 0.7;
  lit = mix(lit, vec3(0.05, 0.052, 0.062), uNight);
  vec3 c = 1.0 - exp(-1.1 * alb * lit * uExposure);
  c = pow(c, vec3(1.0 / 2.2));
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  vC = mix(c, uFogAway, fd);
  gl_Position = projectionMatrix * mv;
}`;
const LIFE_FS = `
precision highp float;
varying vec3 vC;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vC * (1.0 - 0.16 * smoothstep(0.12, 0.25, r2)), 1.0);
}`;

/* 虫和鱼:没有 CPU 状态。aI 是第几只,aK 是这只身上的第几颗点。
   uMode 0 蜜蜂(在花之间飞,每 4 秒换一朵)· 1 蝴蝶 · 2 蛾子(绕灯)· 3 鱼(河里、护城河里一闪) */
const BUG_VS = `
attribute float aI, aK;
uniform float uTime, uPx, uNight, uFogA, uFogB, uExposure, uOn, uMode, uNA;
uniform vec3 uFogAway, uSky, uSunCol, uCam;
uniform vec4 uAnch[32];
uniform vec2 uMoat;
varying vec3 vC; varying float vA;
float h1(float x){ return fract(sin(x * 12.9898 + 4.1414) * 43758.5453); }
vec3 anch(float k){ return uAnch[int(mod(k, max(uNA, 1.0)))].xyz; }
void main(){
  vec3 p = vec3(0.0); vec3 col = vec3(0.0); float size = 0.0, a = uOn;
  float s = h1(aI + 1.7), t = uTime;
  if (uNA < 0.5 || uOn < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vC = vec3(0.0); return; }
  if (uMode < 1.5) {
    float per = uMode < 0.5 ? 4.0 : 8.0;
    float T = t / per + s * 9.0, k = floor(T), f = fract(T);
    float m = smoothstep(0.0, uMode < 0.5 ? 0.3 : 0.5, f);
    vec3 A = anch(floor(h1(k - 1.0 + s * 91.0) * 32.0)), B = anch(floor(h1(k + s * 91.0) * 32.0));
    float arc = sin(m * 3.14159);
    p = mix(A, B, m);
    if (uMode < 0.5) {
      p += vec3(sin(t * 7.0 + s * 40.0), 0.5 * sin(t * 9.0 + s * 20.0), cos(t * 8.0 + s * 30.0)) * 0.12;
      p.y += 0.12 + arc * 0.9;
      col = aK < 0.5 ? vec3(0.9, 0.62, 0.08) : vec3(0.85, 0.87, 0.9);
      size = aK < 0.5 ? 0.025 : 0.02;
      if (aK > 0.5) p.y += 0.012;
    } else {
      p += vec3(sin(t * 0.9 + s * 40.0) + 0.4 * sin(t * 2.3 + s * 7.0), 0.0, cos(t * 0.7 + s * 30.0) + 0.4 * cos(t * 2.9 + s * 3.0)) * 0.6;
      p.y += 0.35 + arc * 1.4 + 0.3 * sin(t * 1.7 + s * 11.0);
      float fl = abs(sin(t * 13.0 + s * 30.0));
      vec3 wc = s < 0.3 ? vec3(0.95, 0.95, 0.9) : s < 0.55 ? vec3(0.95, 0.8, 0.2) : s < 0.8 ? vec3(0.9, 0.45, 0.1) : vec3(0.3, 0.45, 0.9);
      if (aK < 0.5) { col = vec3(0.1); size = 0.014; }
      else { float side = aK < 1.5 ? -1.0 : 1.0; p.x += side * 0.035 * fl; p.y += 0.02 * (1.0 - fl); col = wc; size = 0.04; }
    }
  } else if (uMode < 2.5) {
    vec3 L = anch(floor(s * 32.0));
    float ang = t * (3.0 + s * 3.0) + s * 40.0, r = 0.3 + 0.5 * h1(aI * 3.3);
    p = L + vec3(cos(ang) * r, 0.1 + 0.3 * sin(t * 5.0 + s * 9.0), sin(ang * 1.3) * r);
    col = vec3(1.0, 0.94, 0.82) * 0.9; size = 0.035;
    a *= uNight;
  } else {
    float moat = step(0.5, h1(aI * 7.1));
    vec2 base, dir;
    if (moat < 0.5 && uNA > 1.5) {
      float k = floor(s * (uNA - 1.0));
      vec2 A = uAnch[int(k)].xz, B = uAnch[int(k) + 1].xz;
      dir = normalize(B - A + 1e-4);
      base = mix(A, B, fract(s * 13.0 + t * 0.004 * (0.5 + s))) + vec2(-dir.y, dir.x) * (h1(aI * 3.0) - 0.5) * 2.2;
    } else {
      float ang = atan(uCam.z, uCam.x) + (h1(aI * 5.0) - 0.5) * 0.7 + t * 0.004 * (s - 0.5);
      float r = mix(uMoat.x + 1.2, uMoat.y - 1.2, h1(aI * 11.0));
      base = vec2(cos(ang), sin(ang)) * r;
      dir = vec2(-sin(ang), cos(ang));
    }
    float vis = smoothstep(0.25, 0.7, sin(t * 0.45 * (0.6 + s) + s * 50.0));   // 游上来一下又沉下去
    float o = aK < 0.5 ? 0.1 : aK < 1.5 ? 0.0 : -0.12;
    vec2 xz = base + dir * o + vec2(-dir.y, dir.x) * (aK > 1.5 ? sin(t * 8.0 + s * 20.0) * 0.03 : 0.0);
    p = vec3(xz.x, -0.1 + vis * 0.06, xz.y);
    col = vec3(0.07, 0.09, 0.085); size = (aK < 1.5 ? 0.08 : 0.06) * vis;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  float far = uMode > 2.5 ? 70.0 : uMode > 1.5 ? 90.0 : 45.0;
  gl_PointSize = (d > far || size <= 0.0) ? 0.0 : clamp(size * uPx / max(0.2, d), 1.0, 16.0);
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  if (uMode > 1.5 && uMode < 2.5) { vC = col * (1.0 - 0.6 * fd); }
  else {
    vec3 lit = mix(uSky * 0.75 + uSunCol * 0.45, vec3(0.05, 0.052, 0.062), uNight);
    vec3 c = pow(1.0 - exp(-1.1 * col * lit * uExposure), vec3(1.0 / 2.2));
    vC = mix(c, uFogAway, fd);
  }
  vA = a;
  gl_Position = projectionMatrix * mv;
}`;
const BUG_FS = `
precision highp float;
varying vec3 vC; varying float vA;
uniform float uGlow;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  if (uGlow > 0.5) { gl_FragColor = vec4(vC * exp(-r2 * 14.0) * vA, 1.0); return; }
  if (vA < 0.5) discard;
  gl_FragColor = vec4(vC, 1.0);
}`;

/**
 * @param plan  planTown() 的结果
 * @param U     小镇的共享 uniforms(按引用挂进来,town-scene 每帧改它们就行)
 * @param opts  budget 0.25..1 · seed · perches/lamps/flowers [{x,y,z}] · resolve(x,z,r) → {x,z}
 */
export function createLife(plan, U, opts = {}) {
  const B = Math.max(0.25, Math.min(1, +opts.budget || 1));
  const sim = createSim(plan, opts);
  const group = new THREE.Group();
  group.name = 'town-life';
  const meshes = [], bugs = [];
  const shared = { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uFogA: U.uFogA, uFogB: U.uFogB, uFogAway: U.uFogAway,
    uSunDir: U.uSunDir, uSunCol: U.uSunCol, uSky: U.uSky, uExposure: U.uExposure };

  /* 按种类分组;点数总量压在 12 万以内(镇子特别大、牧场特别多的时候整体降点数) */
  const byKind = new Map();
  for (const c of sim.creatures) { if (!byKind.has(c.kind)) byKind.set(c.kind, []); byKind.get(c.kind).push(c); }
  const detail = 0.55 + 0.45 * B;
  let want = 0;
  for (const [k, list] of byKind) want += (SPEC[k] ? SPEC[k].n : 0) * detail * list.length;
  const squeeze = Math.min(1, 110000 / Math.max(1, want));
  let points = 0;

  for (const [kind, list] of byKind) {
    const S = SPEC[kind];
    if (!S) continue;
    const t = S.build();
    const parts = t.parts;
    if (S.legTint) for (const p of parts) if (p.part >= 2 && p.part <= 5) p.tint = true;
    const T = bake(parts, Math.max(24, Math.round(S.n * detail * squeeze)), S.s);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(T.pos, 3));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(T.piv, 3));
    g.setAttribute('aNrm', new THREE.Float32BufferAttribute(T.nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(T.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(T.part, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(T.tint, 1));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(T.size, 1));
    const n = list.length;
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const tint = new Float32Array(n * 3), seed = new Float32Array(n);
    const tints = S.tints || [[1, 1, 1]];
    list.forEach((c, i) => {
      const tc = tints[Math.floor(c.seed * 997) % tints.length];
      tint[i * 3] = tc[0]; tint[i * 3 + 1] = tc[1]; tint[i * 3 + 2] = tc[2];
      seed[i] = c.seed;
      pos.array[i * 4 + 1] = -1000;
    });
    g.setAttribute('iPosYaw', pos);
    g.setAttribute('iAnim', anim);
    g.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 3));
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
    g.instanceCount = n;
    const uniforms = Object.assign({}, shared, {
      uGait: { value: new THREE.Vector4(...S.gait) },
      uBody: { value: new THREE.Vector4((t.rear || 0) * S.s, (t.leg || 0) * S.s, 1, (S.sink || 0) * S.s) },
      uWag: { value: new THREE.Vector2(...S.wag) },
    });
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader: LIFE_VS, fragmentShader: LIFE_FS, depthWrite: true, depthTest: true, transparent: false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.name = 'life-' + kind;
    group.add(pts);
    meshes.push({ kind, list, pos, anim, g, m, uniforms, pts });
    points += T.n * n;
  }

  /* ── 虫和鱼 ── */
  const W = plan.world;
  const flowers = sim.anchors.flowers.length ? sim.anchors.flowers
    : W ? W.yards.filter((y) => y.tree).map((y) => ({ x: y.x, y: 0.4, z: y.z }))
      .concat((plan.parks || []).map((p) => ({ x: p.cx, y: 0.3, z: p.cz })))
      .concat(W.orchards.map((o) => ({ x: o.x, y: 0.5, z: o.z }))) : [];
  function addBugs(mode, count, per, glow) {
    const n = Math.max(1, Math.round(count * B));
    const ai = new Float32Array(n * per), ak = new Float32Array(n * per);
    for (let i = 0; i < n; i++) for (let k = 0; k < per; k++) { ai[i * per + k] = i; ak[i * per + k] = k; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * per * 3), 3));
    g.setAttribute('aI', new THREE.BufferAttribute(ai, 1));
    g.setAttribute('aK', new THREE.BufferAttribute(ak, 1));
    const uniforms = Object.assign({}, shared, {
      uOn: { value: 0 }, uMode: { value: mode }, uNA: { value: 0 }, uGlow: { value: glow ? 1 : 0 },
      uCam: { value: new THREE.Vector3() }, uMoat: { value: new THREE.Vector2(W ? W.moat.r0 : 0, W ? W.moat.r1 : 0) },
      uAnch: { value: Array.from({ length: 32 }, () => new THREE.Vector4()) },
    });
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader: BUG_VS, fragmentShader: BUG_FS,
      depthWrite: !glow, transparent: !!glow, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = glow ? 3 : 0;
    group.add(pts);
    const b = { mode, g, m, uniforms, on: 0, next: 0 };
    bugs.push(b);
    points += n * per;
    return b;
  }
  const bees = addBugs(0, 48, 2, false);
  const flies = addBugs(1, 24, 3, false);
  const moths = addBugs(2, 40, 1, true);
  const fish = addBugs(3, 40, 3, false);
  if (W) {
    const sp = W.stream.pts.slice(0, 32);
    sp.forEach((p, i) => fish.uniforms.uAnch.value[i].set(p[0], 0, p[1], 1));
    fish.uniforms.uNA.value = sp.length;
  }
  const nearest = (list, x, z, n) => list.map((q) => ({ q, d: (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.q);
  function fillAnchors(b, list, cam, n) {
    const near = nearest(list, cam.x, cam.z, n);
    near.forEach((q, i) => b.uniforms.uAnch.value[i].set(q.x, q.y != null ? q.y : 0, q.z, 1));
    b.uniforms.uNA.value = near.length;
  }

  let last = -1;
  function update(dt, t, cam, env) {
    if (!(dt >= 0)) dt = 0;
    sim.step(dt, t, { x: cam.x, z: cam.z }, env || {});
    const F = sim.flags;
    const far2 = 420 * 420;
    for (const M of meshes) {
      const pa = M.pos.array, an = M.anim.array;
      for (let i = 0; i < M.list.length; i++) {
        const c = M.list[i], o = i * 4;
        const dx = c.x - cam.x, dz = c.z - cam.z;
        pa[o] = c.x; pa[o + 1] = c.hidden || dx * dx + dz * dz > far2 ? -1000 : c.y; pa[o + 2] = c.z; pa[o + 3] = c.yaw;
        an[o] = c.phase; an[o + 1] = c.speed; an[o + 2] = c.st; an[o + 3] = c.pitch;
      }
      M.pos.needsUpdate = true; M.anim.needsUpdate = true;
      if (M.kind === 'sheep') M.uniforms.uBody.value.z = F.winter ? 1.18 : F.season === 'summer' ? 0.94 : 1;   // 冬天毛厚,夏天刚剪过
    }
    /* 虫:开关慢慢淡入淡出;锚点(花、灯)半秒挑一次最近的 */
    const ease = Math.min(1, dt * 0.5);
    const goal = [F.bees && !F.wet ? 1 : 0, F.butterflies ? 1 : 0, F.moths ? 1 : 0, F.fish ? 1 : 0];
    bugs.forEach((b, i) => { b.on += (goal[i] - b.on) * (last < 0 ? 1 : ease); b.uniforms.uOn.value = b.on; b.uniforms.uCam.value.set(cam.x, cam.y, cam.z); });
    if (t - last > 0.5 || last < 0) {
      last = t;
      if (flowers.length) { fillAnchors(bees, flowers, cam, 32); fillAnchors(flies, flowers, cam, 32); }
      if (sim.anchors.lamps.length) fillAnchors(moths, sim.anchors.lamps, cam, 16);
    }
  }

  function stats() {
    const species = {};
    for (const M of meshes) species[M.kind] = M.list.length;
    return { species, points };
  }
  function dispose() {
    for (const M of meshes) { M.g.dispose(); M.m.dispose(); }
    for (const b of bugs) { b.g.dispose(); b.m.dispose(); }
    group.clear();
    if (group.parent) group.parent.remove(group);
  }

  return { group, update, ring: () => sim.ring(), near: (x, z, r) => sim.near(x, z, r), stats, dispose, sim };
}

export { SPEC as LIFE_SPECIES, bake as bakeLifeTemplate };
