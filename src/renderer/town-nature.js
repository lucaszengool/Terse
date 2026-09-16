/**
 * town-nature.js — 镇上会动、会变的那些:树(按树种)、树篱、野花、烟、风车和水车、旗子和晾的布。
 *
 * 树不是屋子那种"面上长出来的点":一棵树 = 一根干 + 一团团叶子的点,一次 draw call 画完全镇
 * (包括墙外那一圈林子)。颜色**按树种、按季节**在 CPU 上算好十几个数,交给着色器 ——
 * 研究笔记里的色板:春 #8DBF5A、夏 #4E7A34、秋 椴树 #D9A441 / 山毛榉 #B5652B / 橡树 #8A6A2F、
 * 冬 紫杉仍是 #2F4A2C;苹果、梨春天开花,夏秋挂果;冬天落叶的树只剩枝。
 * 一棵树一棵树地变色(每颗叶子点一个阈值),不是全镇同时一下子换。
 *
 * 风:Crytek 的主干弯曲(高度的平方)+ 叶子的小抖动,阵风是一道道移动的正弦(Ghost of Tsushima 的做法,
 * 不查噪声纹理)。
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;
export const SPECIES = { bark: 0, oak: 1, linden: 2, beech: 3, apple: 4, pear: 5, willow: 6, yew: 7, poplar: 8, cypress: 9, palm: 10, maple: 11, hedge: 12, flower: 13, bush: 14, pine: 15 };
const NS = 16;

const hx = (h, k = 0.62) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255 * k, ((n >> 8) & 255) / 255 * k, (n & 255) / 255 * k]; };
/* 每个树种四季的 [主色, 副色(花/果/秋色的另一半), 叶子还剩多少] */
const PAL = {
  spring: { oak: ['#7FAE4E', '#A7C96A', 1], linden: ['#8DBF5A', '#B4D878', 1], beech: ['#8DC05A', '#A9D46E', 1], apple: ['#8DBF5A', '#F4D6DE', 1], pear: ['#8DBF5A', '#F6F1E8', 1],
    willow: ['#A6C86A', '#C4DC86', 1], yew: ['#2F4A2C', '#3B5A34', 1], poplar: ['#8DBF5A', '#A9D46E', 1], cypress: ['#2E4A2A', '#3A5A30', 1], palm: ['#5A8A3A', '#6E9A44', 1],
    maple: ['#8DBF5A', '#C9D870', 1], hedge: ['#5E8A3E', '#7AA84E', 1], bush: ['#6E9A44', '#E8E0F0', 1], pine: ['#2F4A30', '#46643A', 1] },
  summer: { oak: ['#4E7A34', '#3E6A2C', 1], linden: ['#4E7A34', '#5E8A3C', 1], beech: ['#4A7632', '#3E6A2C', 1], apple: ['#4E7A34', '#B8302A', 1], pear: ['#4E7A34', '#C8B84A', 1],
    willow: ['#6E9A44', '#7EA84E', 1], yew: ['#2F4A2C', '#344E2E', 1], poplar: ['#4E7A34', '#5A8A3A', 1], cypress: ['#2E4A2A', '#34502C', 1], palm: ['#4E7A34', '#6E9A44', 1],
    maple: ['#4E7A34', '#5E8A3C', 1], hedge: ['#3E6A2C', '#4E7A34', 1], bush: ['#4E7A34', '#3A3A70', 1], pine: ['#2A4430', '#3A5A34', 1] },
  autumn: { oak: ['#8A6A2F', '#6E5A2A', 0.8], linden: ['#D9A441', '#C98F2E', 0.75], beech: ['#B5652B', '#9A4E22', 0.7], apple: ['#9A8A40', '#C8302A', 0.6], pear: ['#C8A040', '#D0B040', 0.6],
    willow: ['#B8B050', '#9A9A44', 0.8], yew: ['#2F4A2C', '#344E2E', 1], poplar: ['#E0C040', '#C8A830', 0.65], cypress: ['#2E4A2A', '#34502C', 1], palm: ['#5A7A3A', '#6E8A44', 1],
    maple: ['#C8301E', '#E07028', 0.75], hedge: ['#7A6A30', '#9A5A2A', 0.85], bush: ['#8A3A2A', '#5A2A40', 0.8], pine: ['#2A4430', '#3A5A34', 1] },
  winter: { oak: ['#6A5A40', '#5A4A34', 0.12], linden: ['#6A5A40', '#5A4A34', 0.06], beech: ['#9A6A3A', '#7A5230', 0.25], apple: ['#6A5A40', '#5A4A34', 0.03], pear: ['#6A5A40', '#5A4A34', 0.03],
    willow: ['#8A8A50', '#7A7A48', 0.1], yew: ['#2A4228', '#2F4A2C', 1], poplar: ['#6A5A40', '#5A4A34', 0.05], cypress: ['#2A4228', '#2F4A2C', 1], palm: ['#4E6A34', '#5A7A3A', 1],
    maple: ['#6A5A40', '#5A4A34', 0.05], hedge: ['#4E5A30', '#5A5A34', 0.7], bush: ['#4E4A30', '#5A4A34', 0.4], pine: ['#26402C', '#30503A', 1] },
};
const ORDER = ['bark', 'oak', 'linden', 'beech', 'apple', 'pear', 'willow', 'yew', 'poplar', 'cypress', 'palm', 'maple', 'hedge', 'flower', 'bush', 'pine'];

/** 这个季节(0 春 1 夏 2 秋 3 冬,可以是小数:换季时慢慢过渡)每个树种的颜色。 */
export function seasonPalette(season) {
  const names = ['spring', 'summer', 'autumn', 'winter'];
  const s = ((season % 4) + 4) % 4, i0 = Math.floor(s), i1 = (i0 + 1) % 4, t = s - i0;
  const A = [], Bc = [], K = [];
  for (const sp of ORDER) {
    if (sp === 'bark') { A.push(hx('#4A3A2C', 0.5)); Bc.push(hx('#5A4634', 0.5)); K.push(1); continue; }
    if (sp === 'flower') {
      // 野花:春夏开,秋天剩一点,冬天没有
      A.push([0.8, 0.8, 0.8]); Bc.push([0.8, 0.8, 0.8]);
      K.push([1, 1, 0.3, 0][i0] * (1 - t) + [1, 1, 0.3, 0][i1] * t);
      continue;
    }
    const p0 = PAL[names[i0]][sp], p1 = PAL[names[i1]][sp];
    const a0 = hx(p0[0]), a1 = hx(p1[0]), b0 = hx(p0[1]), b1 = hx(p1[1]);
    A.push(a0.map((v, k) => v + (a1[k] - v) * t));
    Bc.push(b0.map((v, k) => v + (b1[k] - v) * t));
    K.push(p0[2] + (p1[2] - p0[2]) * t);
  }
  return { A, B: Bc, K };
}

const NATURE_VS = `
attribute vec3 aN; attribute vec4 aInfo;   // 树种、随机数、离地多高(0..1)、世界大小
uniform float uTime, uPx, uNight, uFogA, uFogB, uExposure, uWind, uSnowCov, uFar2;
uniform vec3 uSunDir, uSunCol, uSky, uFogAway, uFogSun;
uniform vec3 uSpA[${NS}], uSpB[${NS}]; uniform float uSpK[${NS}];
uniform float uBlossom, uFruit;
varying vec3 vC; varying float vA;
float h11(float x){ return fract(sin(x * 91.3458) * 47453.5453); }
void main(){
  int sp = int(aInfo.x + 0.5);
  float rr = aInfo.y, hgt = aInfo.z;
  vec3 p = position;
  vec3 base = uSpA[sp], alt = uSpB[sp];
  float keep = uSpK[sp];
  bool leaf = sp != 0;
  // 落叶:这颗叶子点在不在(每颗一个阈值,一棵棵慢慢秃)
  if (leaf && rr > keep) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  vec3 col = base;
  if (sp == 4 || sp == 5) {
    // 果树:春天一树花,夏秋挂果(副色),只占一部分点
    float f = fract(rr * 37.0);
    col = mix(base, alt, step(1.0 - max(uBlossom * 0.8, uFruit * 0.18), f));
  } else if (sp == 13) {
    // 野花:颜色按随机数挑一种
    float k = fract(rr * 13.0);
    col = k < 0.25 ? vec3(0.62, 0.1, 0.1) : k < 0.5 ? vec3(0.2, 0.3, 0.62) : k < 0.75 ? vec3(0.72, 0.66, 0.2) : vec3(0.7, 0.7, 0.66);
    if (fract(rr * 71.0) < 0.45) col = base * vec3(0.3, 0.5, 0.25);
  } else if (leaf) {
    col = mix(base, alt, fract(rr * 17.0) * 0.8);
  }
  col *= 0.8 + 0.4 * fract(rr * 53.0);
  // 风:越高摆得越多;阵风一道道扫过去
  float gust = 0.5 + 0.5 * sin(dot(p.xz, vec2(0.11, 0.07)) - uTime * 1.1);
  float sway = (uWind * (0.35 + gust) + 0.08) * hgt * hgt;
  p.x += sway * (0.6 + 0.2 * sin(uTime * 1.7 + rr * 9.0));
  p.z += sway * 0.45 * sin(uTime * 1.3 + p.x * 0.2);
  if (leaf) p += (vec3(sin(uTime * 3.1 + rr * 40.0), sin(uTime * 2.3 + rr * 20.0), cos(uTime * 2.7 + rr * 30.0))) * 0.03 * (0.4 + uWind) * hgt;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  float sz = aInfo.w;
  // 远处的树:一半的点就够,剩下的放大一点
  if (leaf && d > 70.0) { if (fract(rr * 97.0) < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; } sz *= 1.4; }
  // 近处不许成珠子:一颗叶子点最多十几个像素
  gl_PointSize = clamp(sz * uPx / max(d, 0.1), 1.0, sp == 13 ? 7.0 : 16.0);
  // 光:叶团朝太阳的那面亮,背面透一点光(次表面),夜里只剩月光
  vec3 N = normalize(aN);
  float ndl = max(dot(N, uSunDir), 0.0), back = max(dot(-N, uSunDir), 0.0);
  vec3 lit = uSky * (0.55 + 0.25 * N.y) + uSunCol * (ndl * 0.85 + back * 0.18 * float(leaf));
  lit = mix(lit, vec3(0.05, 0.055, 0.075) * (0.7 + 0.3 * N.y), uNight);
  vec3 c = col * lit;
  // 雪:朝上的叶团、枝上积一层
  c = mix(c, vec3(0.82, 0.86, 0.95) * mix(lit, vec3(1.0), 0.3), uSnowCov * smoothstep(0.2, 0.8, N.y) * (leaf ? 0.8 : 0.5));
  c = 1.0 - exp(-1.1 * c * uExposure);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  float s = pow(max(dot(normalize(p - cameraPosition), uSunDir), 0.0), 8.0);
  vC = mix(c, mix(uFogAway, uFogSun, s * (1.0 - uNight)), fd);
  vA = 1.0 - smoothstep(uFar2 * 0.9, uFar2, d);
  gl_Position = projectionMatrix * mv;
}`;
const NATURE_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25 || vA < 0.02) discard;
  gl_FragColor = vec4(vC * (0.86 + 0.14 * (1.0 - r2 * 4.0)), 1.0);
}`;

/* 烟:每根烟囱一串点,从口子升起来、散开、被风吹歪,8 秒一轮 */
const SMOKE_VS = `
attribute vec4 aInfo;   // 相位、随机数、这根烟囱的量、-
uniform float uTime, uPx, uSmoke, uWind, uNight;
uniform vec3 uWindDir, uSky, uFogAway;
varying float vA; varying vec3 vC;
void main(){
  float life = fract(aInfo.x + uTime / 8.0);
  vec3 p = position;
  float up = life * 7.0;
  p.y += up;
  p.xz += uWindDir.xz * (0.4 + uWind * 2.5) * life * life * 6.0;
  p.x += sin(uTime * 0.7 + aInfo.y * 20.0 + life * 5.0) * life * 0.8;
  p.z += cos(uTime * 0.5 + aInfo.y * 30.0 + life * 4.0) * life * 0.8;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp((0.35 + life * 2.2) * uPx / max(d, 0.2), 1.0, 90.0);
  vA = smoothstep(0.0, 0.08, life) * (1.0 - life) * 0.32 * uSmoke * aInfo.z * (1.0 - smoothstep(120.0, 240.0, d));
  vC = mix(mix(vec3(0.62, 0.62, 0.64), uFogAway, 0.4), vec3(0.09, 0.1, 0.13), uNight);
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FS = `
precision highp float;
varying float vA; varying vec3 vC;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vC, vA * (1.0 - r2 * 4.0));
}`;

/* 会转的、会飘的:风车叶片、水车、旗子、晾的布。aLocal 是在它自己平面里的坐标。 */
const SPIN_VS = `
attribute vec3 aLocal; attribute vec4 aAxis;   // aAxis.xz 朝向(平面的法线),w:0 转 1 飘
attribute vec3 aCol; attribute float aSpeed;
uniform float uTime, uPx, uNight, uFogA, uFogB, uExposure, uWind;
uniform vec3 uSunDir, uSunCol, uSky, uFogAway;
varying vec3 vC;
void main(){
  vec3 n = normalize(vec3(aAxis.x, 0.0, aAxis.z));
  vec3 r = vec3(n.z, 0.0, -n.x);
  vec3 p;
  if (aAxis.w < 0.5) {
    float a = uTime * aSpeed;
    float cs = cos(a), sn = sin(a);
    vec2 q = vec2(aLocal.x * cs - aLocal.y * sn, aLocal.x * sn + aLocal.y * cs);
    p = position + r * q.x + vec3(0.0, q.y, 0.0) + n * aLocal.z;
  } else {
    // 布:挂着的上沿不动,越往下飘得越多
    float hang = -aLocal.y;
    float wv = sin(uTime * (2.2 + uWind * 3.0) + aLocal.x * 3.0 + position.x) * (0.08 + uWind * 0.3) * hang;
    p = position + r * aLocal.x + vec3(0.0, aLocal.y, 0.0) + n * wv;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(0.16 * uPx / max(d, 0.1), 1.0, 30.0);
  vec3 lit = mix(uSky * 0.7 + uSunCol * 0.5 * max(uSunDir.y, 0.0), vec3(0.05, 0.055, 0.075), uNight);
  vec3 c = 1.0 - exp(-1.1 * aCol * lit * uExposure);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  vC = mix(c, uFogAway, fd);
  gl_Position = projectionMatrix * mv;
}`;

/**
 * @param U 小镇那套 uniform(光、雾、时间)
 * @param items { trees:[{x,z,kind,h}], smokes:[{x,y,z,k}], mills:[{kind,x,y,z,ax,az,r}], banners, cloths, hedges, flowers }
 * @param plan  town-plan 的图纸(林子、街道、公园都从这里来)
 */
export function createNature(U, plan, items, opts = {}) {
  const B = Math.max(0.25, Math.min(1, opts.budget || 1));
  let seedN = 1234567;
  const rnd = () => { seedN ^= seedN << 13; seedN >>>= 0; seedN ^= seedN >> 17; seedN ^= seedN << 5; seedN >>>= 0; return seedN / 4294967296; };
  const W = plan.world;
  const pos = [], nrm = [], info = [];
  const put = (x, y, z, nx, ny, nz, sp, hgt, size) => { pos.push(x, y, z); nrm.push(nx, ny, nz); info.push(sp, rnd(), hgt, size); };

  /* 一棵树:干 + 叶团。形状按树种:橡树宽圆、椴树卵圆、白杨细高、柏树尖塔、柳树垂、棕榈一把扇 */
  const tree = (x, z, kind, h, pts, size) => {
    const S = SPECIES[kind] != null ? SPECIES[kind] : 1;
    const lean = [(rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3];
    const trunkH = kind === 'palm' ? h * 0.9 : kind === 'cypress' || kind === 'yew' || kind === 'pine' ? h * 0.15 : h * 0.42;
    const nt = Math.max(6, Math.round(pts * 0.1));
    for (let i = 0; i < nt; i++) {
      const t = i / nt, a = rnd() * TAU, rr = (kind === 'palm' ? 0.12 : 0.18 + h * 0.012) * (1 - t * 0.4);
      put(x + lean[0] * t + Math.cos(a) * rr, t * trunkH, z + lean[1] * t + Math.sin(a) * rr, Math.cos(a), 0.2, Math.sin(a), 0, t * t, size * 0.7);
    }
    // 冬天看得见的枝:从干顶往外几根
    if (kind !== 'palm' && kind !== 'cypress' && kind !== 'yew' && kind !== 'pine') {
      for (let b = 0; b < 5; b++) {
        const a = rnd() * TAU, len = h * (0.25 + rnd() * 0.2), rise = h * (0.2 + rnd() * 0.25);
        for (let k = 0; k < 7; k++) {
          const t = (k + 1) / 7;
          put(x + lean[0] + Math.cos(a) * len * t, trunkH + rise * t, z + lean[1] + Math.sin(a) * len * t, Math.cos(a), 0.5, Math.sin(a), 0, 0.5 + 0.5 * t, size * 0.45);
        }
      }
    }
    const cx = x + lean[0], cz = z + lean[1];
    const nl = pts - nt;
    for (let i = 0; i < nl; i++) {
      let dx, dy, dz;
      if (kind === 'poplar' || kind === 'cypress') {
        const t = rnd(), rad = (kind === 'cypress' ? 0.9 : 1.2) * Math.sin(Math.PI * Math.pow(t, 0.8)) * (h / 9 + 0.3), a = rnd() * TAU;
        dx = Math.cos(a) * rad * Math.sqrt(rnd()); dz = Math.sin(a) * rad * Math.sqrt(rnd()); dy = trunkH + t * (h - trunkH);
      } else if (kind === 'pine' || kind === 'yew') {
        const t = rnd(), rad = (1 - t) * h * 0.28, a = rnd() * TAU;
        dx = Math.cos(a) * rad; dz = Math.sin(a) * rad; dy = trunkH + t * (h - trunkH);
      } else if (kind === 'willow') {
        const a = rnd() * TAU, rad = h * (0.25 + rnd() * 0.2);
        dx = Math.cos(a) * rad; dz = Math.sin(a) * rad; dy = h * 0.95 - rnd() * rnd() * h * 0.75;
      } else if (kind === 'palm') {
        const a = Math.floor(rnd() * 7) / 7 * TAU + rnd() * 0.2, t = rnd(), L = h * 0.35;
        dx = Math.cos(a) * L * t; dz = Math.sin(a) * L * t; dy = h - t * t * h * 0.22;
      } else {
        // 圆冠:几团叠起来的球(一团一团才像树,不是一个光溜溜的球)
        const lobe = Math.floor(rnd() * 5), la = lobe * 1.26 + x, lr = h * 0.22;
        const lc = lobe === 0 ? [0, 0] : [Math.cos(la) * lr, Math.sin(la) * lr];
        const R = h * (kind === 'oak' ? 0.34 : kind === 'apple' || kind === 'pear' || kind === 'maple' ? 0.3 : 0.28);
        const u = rnd() * 2 - 1, a = rnd() * TAU, s = Math.cbrt(0.35 + rnd() * 0.65) * R;
        dx = lc[0] + Math.sqrt(1 - u * u) * Math.cos(a) * s;
        dz = lc[1] + Math.sqrt(1 - u * u) * Math.sin(a) * s;
        dy = trunkH + R * 0.9 + u * s * 0.8 + (lobe === 0 ? R * 0.4 : 0);
      }
      const nx = dx, ny = dy - (trunkH + h) * 0.5, nz = dz, L = Math.hypot(nx, ny, nz) || 1;
      put(cx + dx, dy, cz + dz, nx / L, ny / L, nz / L, S, Math.min(1, dy / h), size);
    }
  };
  const near = items.trees.slice();
  // 公园、广场边、大道两旁的椴树
  for (const pk of plan.parks) {
    const n = Math.max(1, Math.round(Math.sqrt(pk.area) / 5));
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * Math.sqrt(pk.area) * 0.3;
      near.push({ x: pk.cx + Math.cos(a) * r, z: pk.cz + Math.sin(a) * r, kind: ['oak', 'linden', 'beech', 'maple', 'willow'][Math.floor(rnd() * 5)], h: 6 + rnd() * 5 });
    }
  }
  for (const t of near) tree(t.x, t.z, t.kind, t.h || 6, Math.round((t.kind === 'palm' ? 160 : 320) * B + 60), 0.42);
  // 河边的柳树
  if (W) for (let i = 2; i < W.stream.pts.length - 1; i += 2) {
    const a = W.stream.pts[i], b = W.stream.pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const s = rnd() < 0.5 ? 1 : -1;
    const x = a[0] - dz / L * s * (W.stream.w / 2 + 2.5), z = a[1] + dx / L * s * (W.stream.w / 2 + 2.5);
    tree(x, z, 'willow', 7 + rnd() * 3, Math.round(260 * B + 40), 0.45);
    items.trees.push({ x, z, kind: 'willow', h: 8 });
  }
  /* 林子:墙外最外一圈。远,点少、点大(一棵 40–70 颗) */
  const forestTrees = [];
  if (W) {
    const area = Math.PI * (W.forest.r1 * W.forest.r1 - W.forest.r0 * W.forest.r0);
    const n = Math.round(area / 55 * B);
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, r = W.forest.r0 + 4 + Math.sqrt(rnd()) * (W.forest.r1 - W.forest.r0);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (W.roads.some((rd) => segNear(x, z, rd.pts, rd.w / 2 + 2))) continue;
      if (segNear(x, z, W.stream.pts, W.stream.w / 2 + 3)) continue;
      const kind = rnd() < 0.35 ? 'pine' : rnd() < 0.5 ? 'beech' : 'oak';
      tree(x, z, kind, 9 + rnd() * 9, Math.round(46 + rnd() * 20), 1.15);
      forestTrees.push({ x, z, kind });
    }
    // 林子边缘的树(离得近,细一些)
    for (let i = 0; i < 160 * B; i++) {
      const a = rnd() * TAU, r = W.forest.r0 - 2 + rnd() * 6;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (W.roads.some((rd) => segNear(x, z, rd.pts, rd.w / 2 + 2)) || segNear(x, z, W.stream.pts, W.stream.w / 2 + 3)) continue;
      const kind = ['oak', 'beech', 'bush', 'pine'][Math.floor(rnd() * 4)];
      tree(x, z, kind, kind === 'bush' ? 2 : 8 + rnd() * 6, kind === 'bush' ? 60 : 150, kind === 'bush' ? 0.35 : 0.6);
      items.trees.push({ x, z, kind, h: 10, edge: true });
    }
  }
  /* 野花:城墙脚、路边、公园里一小丛一小丛 */
  const tuft = (x, z, n, r) => { for (let i = 0; i < n; i++) { const a = rnd() * TAU, d = Math.sqrt(rnd()) * r; put(x + Math.cos(a) * d, 0.05 + rnd() * 0.35, z + Math.sin(a) * d, 0, 1, 0, SPECIES.flower, rnd() * 0.5, 0.11); } };
  const flowerSpots = [];
  if (W) {
    for (let i = 0; i < 220 * B; i++) {
      const a = rnd() * TAU, r = W.wall.r + 2.2 + rnd() * 0.6;
      if (W.wall.gates.some((G0) => Math.abs(((a - G0.a + Math.PI * 3) % TAU) - Math.PI) < 0.08)) continue;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      tuft(x, z, 18, 0.6); flowerSpots.push({ x, y: 0.3, z });
    }
    for (const rd of W.roads) for (let k = 1; k < rd.pts.length; k++) for (const s of [-1, 1]) {
      const a = rd.pts[k - 1], b = rd.pts[k], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
      const x = a[0] - dz / L * s * (rd.w / 2 + 0.8), z = a[1] + dx / L * s * (rd.w / 2 + 0.8);
      tuft(x, z, 30, 1.2); flowerSpots.push({ x, y: 0.3, z });
      // 路边的灌木
      if (rnd() < 0.5) tree(x - dz / L * s * 1.5, z + dx / L * s * 1.5, 'bush', 1.6 + rnd(), 70, 0.35);
    }
  }
  for (const pk of plan.parks) for (let i = 0; i < 4; i++) { const x = pk.cx + (rnd() - 0.5) * 8, z = pk.cz + (rnd() - 0.5) * 8; tuft(x, z, 24, 1); flowerSpots.push({ x, y: 0.3, z }); }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aN', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  const pal = seasonPalette(1);
  const NU = {
    uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uFogA: U.uFogA, uFogB: U.uFogB, uExposure: U.uExposure,
    uSunDir: U.uSunDir, uSunCol: U.uSunCol, uSky: U.uSky, uFogAway: U.uFogAway, uFogSun: U.uFogSun,
    uSnowCov: U.uSnowCov, uWind: { value: 0.3 }, uFar2: { value: 900 },
    uSpA: { value: pal.A.map((c) => new THREE.Vector3(...c)) },
    uSpB: { value: pal.B.map((c) => new THREE.Vector3(...c)) },
    uSpK: { value: pal.K.slice() },
    uBlossom: { value: 0 }, uFruit: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: NU, vertexShader: NATURE_VS, fragmentShader: NATURE_FS });
  const trees = new THREE.Points(g, mat);
  trees.frustumCulled = false;
  const group = new THREE.Group();
  group.add(trees);

  /* 烟 */
  const sm = [];
  const smPos = [], smInfo = [];
  for (const c of items.smokes) {
    const n = Math.round(14 * (c.k || 1));
    for (let i = 0; i < n; i++) { smPos.push(c.x, c.y, c.z); smInfo.push(i / n + rnd() * 0.05, rnd(), c.k || 1, 0); }
    sm.push(c);
  }
  const SU = { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uSky: U.uSky, uFogAway: U.uFogAway, uSmoke: { value: 0.6 }, uWind: NU.uWind, uWindDir: { value: new THREE.Vector3(0.8, 0, 0.6) } };
  let smokeMat = null, smokeGeo = null;
  if (smPos.length) {
    smokeGeo = new THREE.BufferGeometry();
    smokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(smPos, 3));
    smokeGeo.setAttribute('aInfo', new THREE.Float32BufferAttribute(smInfo, 4));
    smokeMat = new THREE.ShaderMaterial({ uniforms: SU, vertexShader: SMOKE_VS, fragmentShader: SMOKE_FS, transparent: true, depthWrite: false });
    const smoke = new THREE.Points(smokeGeo, smokeMat);
    smoke.frustumCulled = false; smoke.renderOrder = 3;
    group.add(smoke);
  }

  /* 风车叶片、水车、旗子、布 */
  const spPos = [], spLoc = [], spAx = [], spCol = [], spSpd = [];
  const spin = (c, lx, ly, lz, ax, az, mode, col, speed) => { spPos.push(c[0], c[1], c[2]); spLoc.push(lx, ly, lz); spAx.push(ax, 0, az, mode); spCol.push(col[0], col[1], col[2]); spSpd.push(speed); };
  for (const m of items.mills) {
    const c = [m.x, m.y, m.z];
    if (m.kind === 'wind') {
      // 四片叶:每片是一格木框 + 帆布
      for (let b = 0; b < 4; b++) {
        const a = b / 4 * TAU;
        for (let s = 0.6; s < m.r; s += 0.16) {
          for (let w = 0; w < 1.6; w += 0.16) {
            const cloth = w > 0.15 && s > 1.5;
            if (!cloth && rnd() < 0.3) continue;
            const lx = Math.cos(a) * s - Math.sin(a) * w, ly = Math.sin(a) * s + Math.cos(a) * w;
            spin(c, lx, ly, 0, m.ax, m.az, 0, cloth ? [0.62, 0.56, 0.46] : [0.3, 0.22, 0.14], 0.35);
          }
        }
      }
      for (let k = 0; k < 20; k++) spin(c, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4, -0.3 * rnd(), m.ax, m.az, 0, [0.25, 0.18, 0.12], 0.35);
    } else {
      // 水车:两圈轮缘 + 一根根桨板
      for (const zz of [-0.45, 0.45]) for (let k = 0; k < 90; k++) { const a = k / 90 * TAU; spin(c, Math.cos(a) * m.r, Math.sin(a) * m.r, zz, m.az, -m.ax, 0, [0.3, 0.22, 0.14], -0.5); }
      for (let p = 0; p < 16; p++) {
        const a = p / 16 * TAU;
        for (let rr = m.r * 0.2; rr <= m.r; rr += 0.18) for (const zz of [-0.4, 0, 0.4]) {
          const pad = rr > m.r * 0.72;
          if (!pad && zz !== 0) continue;
          spin(c, Math.cos(a) * rr, Math.sin(a) * rr, zz, m.az, -m.ax, 0, pad ? [0.34, 0.25, 0.16] : [0.28, 0.2, 0.13], -0.5);
        }
      }
    }
  }
  for (const bn of items.banners) {
    if (bn.sign) continue;
    for (let u = 0; u < 1.4; u += 0.12) for (let v = 0; v < 2.2; v += 0.12) {
      spin([bn.x, bn.y + 0.8, bn.z], u - 0.7, -v, 0, bn.dz, -bn.dx, 1, (Math.floor(v / 0.55) % 2 ? bn.col : bn.col.map((q) => q * 0.6)), 0);
    }
  }
  for (const cl of items.cloths) {
    for (let u = -cl.w / 2; u < cl.w / 2; u += 0.08) for (let v = 0; v < cl.h; v += 0.08) spin([cl.x, cl.y, cl.z], u, -v, 0, -cl.dz, cl.dx, 1, cl.col, 0);
  }
  let spinMat = null, spinGeo = null;
  if (spPos.length) {
    spinGeo = new THREE.BufferGeometry();
    spinGeo.setAttribute('position', new THREE.Float32BufferAttribute(spPos, 3));
    spinGeo.setAttribute('aLocal', new THREE.Float32BufferAttribute(spLoc, 3));
    spinGeo.setAttribute('aAxis', new THREE.Float32BufferAttribute(spAx, 4));
    spinGeo.setAttribute('aCol', new THREE.Float32BufferAttribute(spCol, 3));
    spinGeo.setAttribute('aSpeed', new THREE.Float32BufferAttribute(spSpd, 1));
    spinMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uFogA: U.uFogA, uFogB: U.uFogB, uExposure: U.uExposure,
        uSunDir: U.uSunDir, uSunCol: U.uSunCol, uSky: U.uSky, uFogAway: U.uFogAway, uWind: NU.uWind },
      vertexShader: SPIN_VS, fragmentShader: NATURE_FS.replace('varying vec3 vC; varying float vA;', 'varying vec3 vC; float vA = 1.0;'),
    });
    const sp = new THREE.Points(spinGeo, spinMat);
    sp.frustumCulled = false;
    group.add(sp);
  }

  let seasonNow = -1;
  return {
    group,
    count: pos.length / 3 + smPos.length / 3 + spPos.length / 3,
    flowers: flowerSpots,
    forest: forestTrees,
    /** 天变了:季节(0..4 连续)、风、烟有多浓、开花/结果 */
    setEnv(env) {
      const si = { spring: 0, summer: 1, autumn: 2, winter: 3 }[env.season] || 0;
      if (si !== seasonNow) {
        seasonNow = si;
        const p = seasonPalette(si);
        p.A.forEach((c, i) => NU.uSpA.value[i].set(...c));
        p.B.forEach((c, i) => NU.uSpB.value[i].set(...c));
        p.K.forEach((k, i) => { NU.uSpK.value[i] = k; });
        NU.uBlossom.value = si === 0 ? 1 : 0;
        NU.uFruit.value = si === 1 ? 0.7 : si === 2 ? 1 : 0;
      }
      NU.uWind.value = env.fx.wind || 0.2;
      // 烟:清早和傍晚做饭时浓,冬天全天都有,夏天正午几乎没有
      const h = env.hour;
      const meal = Math.max(Math.exp(-Math.pow((h - 7) / 1.6, 2)), Math.exp(-Math.pow((h - 18.5) / 1.8, 2)), 0.25 * Math.exp(-Math.pow((h - 12) / 1.2, 2)));
      SU.uSmoke.value = Math.min(1, 0.15 + meal * 0.85 + (si === 3 ? 0.55 : si === 2 ? 0.2 : 0) - (si === 1 ? 0.1 : 0)) * (env.fx.rain > 0.5 ? 0.7 : 1);
      const wa = (env.seed ? env.seed.length : 3) * 0.7 + env.hour * 0.05;
      SU.uWindDir.value.set(Math.cos(wa), 0, Math.sin(wa));
    },
    dispose() {
      g.dispose(); mat.dispose();
      if (smokeGeo) { smokeGeo.dispose(); smokeMat.dispose(); }
      if (spinGeo) { spinGeo.dispose(); spinMat.dispose(); }
    },
  };
}

function segNear(x, z, pts, r) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
    let t = ((x - a[0]) * ex + (z - a[1]) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t) < r) return true;
  }
  return false;
}
