/**
 * town-ground.js — 小镇的地面:一张俯视图 + 一圈圈跟着人走的点。
 *
 * 为什么不像屋子那样把地铺成固定的点:小镇有几十万平米。按屋里那个点距铺,是几千万颗点;
 * 按小镇的点距铺,脚底下那几颗就是半米大的球 —— 第一版就是这么糊的。
 *
 * 所以地面不是固定的几何:**每帧在人周围按极坐标摆一圈点,脚下密、远处疏**(半径按
 * 指数长,角度按黄金角),每颗点去查一张事先烤好的俯视图:这里是草、是街、是广场、
 * 还是房子底下。屏幕上每颗点的大小因此大致不变,总数固定,走到哪儿都一样细。
 *
 * 街道、广场、公园于是不用各自铺一遍 —— 它们就是那张图上的颜色。
 */
import * as THREE from 'three';

/* 俯视图的 alpha 存的是"这是什么地"(类别 × 16 / 255),颜色是烤的时候按季节算好的。
   ⚠ 纹理是线性过滤的:边上两类会混成一个中间值 —— 取整到最近的那一类,边上错一圈无所谓。 */
const CLASS_GLSL = `
float clsOf(float a){ return floor(a * 255.0 / 16.0 + 0.5); }
`;
/* 类别(和 bakeGroundMap 里的 CLS 同一张表) */
export const CLS = { grass: 0, street: 1, plaza: 2, plot: 3, field: 4, garden: 5, water: 6, pasture: 7, forest: 8, road: 9, yard: 10, orchard: 11, reed: 12 };

const GROUND_VS = `
attribute float aI;
uniform float uN, uFar, uPx, uTime, uNight, uFogA, uFogB, uWind, uCrop, uSnowG, uWet;
uniform vec4 uGL[8]; uniform vec3 uGLC[8];
uniform vec3 uCam, uSunCol, uSky, uFogAway, uFogSun, uSunDir, uZen;
uniform sampler2D uMap, uMapC; uniform float uMapR;
varying vec3 vC; varying float vA;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
${CLASS_GLSL}
void main(){
  float t = (aI + 0.5) / uN;
  /* 半径按**指数**长(每一段 log 半径里点一样多),配上"点的大小正比于半径" ——
     屏幕上的颗粒于是处处一样细、一样疏。用 t 的幂来分布会让脚下几万颗点挤在几平米里,
     糊成一片珠子;这正是第一版的样子。 */
  float r = 0.5 * pow(uFar / 0.5, t);
  float a = aI * 2.39996323 + uCam.z * 0.0001;          // 黄金角,不成环也不成辐条
  vec2 w = uCam.xz + vec2(cos(a), sin(a)) * r;
  w += (vec2(h21(vec2(aI, 1.7)), h21(vec2(aI, 3.1))) - 0.5) * r * 0.75;   // 抖开:不抖就是一簇簇的草团
  vec2 uv = w / (uMapR * 2.0) + 0.5;
  vec4 m = texture2D(uMap, uv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) m = vec4(0.05, 0.07, 0.05, 8.0 * 16.0 / 255.0);
  float cls = clsOf(texture2D(uMapC, uv).a), rr = h21(vec2(aI, 9.3));
  vec3 col = m.rgb;
  float y = 0.0, sz = 0.023;
  /* 地上长着的东西:近处把点抬起来 —— 麦子、牧草、菜畦就是"立着的点",风吹过去一浪一浪。
     远处不抬(看不出来,抬了反倒像一层雾)。 */
  float near = 1.0 - smoothstep(18.0, 40.0, r);
  float gust = sin(dot(w, vec2(0.13, 0.09)) - uTime * 1.4) * 0.5 + 0.5;
  gust *= 0.6 + 0.4 * sin(dot(w, vec2(0.37, -0.21)) - uTime * 2.3);
  if (cls > 3.5 && cls < 4.5) {                       // 庄稼:高度跟着季节(uCrop 0 刚出苗 .. 1 齐腰)
    y = (0.15 + 0.85 * rr) * mix(0.08, 0.9, uCrop) * near;
    col *= 0.85 + 0.3 * rr;
  } else if ((cls < 0.5 || cls > 6.5 && cls < 7.5 || cls > 10.5 && cls < 11.5 || cls > 11.5) && rr > 0.35) {
    y = rr * (cls > 11.5 ? 0.9 : 0.22) * near * (1.0 - uSnowG * 0.8);          // 草、牧草、芦苇
    col *= 0.8 + 0.45 * rr;
  } else if (cls > 4.5 && cls < 5.5) {                // 菜畦:一垄绿一垄土
    float row = step(0.5, fract(dot(w, vec2(0.62, 0.78)) * 1.25));
    y = row * (0.08 + 0.2 * rr) * near * uCrop;
    col = mix(col * 0.7, col * vec3(0.7, 1.35, 0.6), row * uCrop);
  }
  vec2 sway = vec2(0.8, 0.6) * (gust * uWind + 0.08 * sin(uTime * 2.0 + rr * 30.0)) * y * y;
  vec3 p = vec3(w.x + sway.x, y, w.y + sway.y);
  bool water = cls > 5.5 && cls < 6.5;
  if (water) {
    p.y = -0.12;
    // 水面:天光的倒影 + 一点涟漪的闪;风大时暗一些
    float rip = sin(w.x * 1.7 + uTime * 1.1) * sin(w.y * 1.3 - uTime * 0.9);
    col = mix(col, uZen * 0.55, 0.45) * (0.85 + 0.2 * rip);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  // 屏幕上每颗点大小大致不变:大小正比于半径(近处的点就该小)
  gl_PointSize = clamp(r * sz * uPx / max(0.3, d), 1.0, 9.0) * (y > 0.02 ? 0.75 : 1.0);
  vec3 lit = uSky * 0.75 + uSunCol * max(uSunDir.y, 0.0) * 0.7;
  // 夜里的地:月光下暗暗的蓝灰(看得清街和草地的分界),亮起来的只有灯下那一圈暖光
  col *= mix(lit, vec3(0.13, 0.13, 0.17), uNight);
  // 灯下一圈暖光(夜里才看得出来):最近的 8 盏
  if (uNight > 0.05 && r < 60.0) {
    vec3 gl = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      vec3 Lv = uGL[i].xyz - p;
      float dd = length(Lv), win = max(0.0, 1.0 - dd / max(uGL[i].w, 0.01));
      gl += uGLC[i] * win * win / (1.0 + dd * 0.12);
    }
    col += (m.rgb + 0.06) * gl * 3.4 * uNight;
  }
  // 雨:街和广场湿了,暗下去,反一点天光
  if (cls > 0.5 && cls < 3.5 || cls > 8.5 && cls < 9.5) col = mix(col, col * 0.55 + uZen * 0.12 * (1.0 - uNight), uWet);
  // 雪:水上不积,街上踩出来的地方薄一些
  if (!water) col = mix(col, vec3(0.82, 0.86, 0.95) * mix(lit, vec3(0.16, 0.18, 0.26), uNight), uSnowG * (cls > 0.5 && cls < 2.5 ? 0.6 : 0.95) * (0.85 + 0.15 * rr));
  if (water && uSnowG > 0.5) col = mix(col, vec3(0.6, 0.66, 0.74) * lit, 0.5);   // 冬天水面结了薄冰
  col *= 0.93 + 0.14 * h21(floor(w * 7.0));
  if (water) col += uSunCol * pow(max(0.0, h21(floor(w * 3.0) + floor(uTime * 3.0)) - 0.97), 1.0) * 6.0 * (1.0 - uNight);
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(uCam.y, 0.0)) * d);
  float s = pow(max(dot(normalize(vec3(w.x, 0.0, w.y) - uCam), uSunDir), 0.0), 8.0);
  vC = mix(col, mix(uFogAway, uFogSun, s * (1.0 - uNight)), fd);
  vA = smoothstep(0.35, 1.2, d) * (1.0 - smoothstep(uFar * 0.93, uFar, r));
  gl_Position = projectionMatrix * mv;
}`;
const GROUND_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = exp(-r2 * 9.0) * (1.0 - smoothstep(0.16, 0.25, r2));
  if (a * vA < 0.02) discard;
  gl_FragColor = vec4(vC, a * vA);
}`;

/* 点下面垫一张实的地:同一张俯视图、同一片光和雾,只是暗一些。没有它,点和点之间
   露出的是黑 —— 白天的地就成了"黑底上撒一把盐"。点负责颗粒,底负责"这是地"。 */
const BASE_VS = `
uniform vec3 uCam;
varying vec3 vW;
void main(){
  vec3 p = position + vec3(uCam.x, 0.0, uCam.z);
  vW = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const BASE_FS = `
precision highp float;
uniform float uNight, uFogA, uFogB, uFar, uSnowG, uWet, uTime;
uniform vec4 uGL[8]; uniform vec3 uGLC[8];
uniform vec3 uCam, uSunCol, uSky, uFogAway, uFogSun, uSunDir, uZen;
uniform sampler2D uMap, uMapC; uniform float uMapR;
varying vec3 vW;
${CLASS_GLSL}
void main(){
  vec2 uv = vW.xz / (uMapR * 2.0) + 0.5;
  vec4 mm = texture2D(uMap, uv);
  vec3 m = mm.rgb;
  float cls = clsOf(texture2D(uMapC, uv).a);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { m = vec3(0.05, 0.07, 0.05); cls = 8.0; }
  vec3 lit = uSky * 0.75 + uSunCol * max(uSunDir.y, 0.0) * 0.7;
  bool water = cls > 5.5 && cls < 6.5;
  if (water) m = mix(m, uZen * 0.5, 0.5) * (0.9 + 0.1 * sin(vW.x * 0.9 + uTime) * sin(vW.z * 0.7 - uTime * 0.8));
  vec3 col = m * mix(lit, vec3(0.13, 0.13, 0.17), uNight) * mix(0.62, 1.3, uNight) * (water ? 1.25 : 1.0);
  if (!water) col = mix(col, vec3(0.8, 0.84, 0.92) * mix(lit, vec3(0.16, 0.18, 0.26), uNight) * 0.8, uSnowG * 0.9);
  if (cls > 0.5 && cls < 3.5) col *= 1.0 - 0.3 * uWet;
  if (uNight > 0.05) {
    vec3 gl = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      vec3 Lv = uGL[i].xyz - vW;
      float dd = length(Lv), win = max(0.0, 1.0 - dd / max(uGL[i].w, 0.01));
      gl += uGLC[i] * win * win / (1.0 + dd * 0.12);
    }
    col += (m + 0.06) * gl * 2.7 * uNight;
  }
  float d = length(vW - uCam);
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(uCam.y, 0.0)) * d);
  float s = pow(max(dot(normalize(vW - uCam), uSunDir), 0.0), 8.0);
  col = mix(col, mix(uFogAway, uFogSun, s * (1.0 - uNight)), max(fd, smoothstep(uFar * 0.7, uFar, d)));
  gl_FragColor = vec4(col, 1.0);
}`;

/* 各季节的颜色(显示空间,已经压暗到和这台渲染器的曝光配得上)。研究笔记里的色板:
   春 #8DBF5A · 夏 #4E7A34 · 秋 麦茬 #C9B27A · 冬 枯草 #9C9270;土路 #6E5A44。 */
const dim = (h, k = 0.55) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255 * k, ((n >> 8) & 255) / 255 * k, (n & 255) / 255 * k]; };
const SEASON_COL = {
  spring: { grass: dim('#6E9E45'), pasture: dim('#7DAA4E'), forest: dim('#3E5A2E'), wheat: dim('#7FA84A'), rye: dim('#77A050'), barley: dim('#8DB25A'), flax: dim('#6F9A58'), cabbage: dim('#5E8A4A'), fallow: dim('#6E5A44'), garden: dim('#5A4632'), reed: dim('#6F9048') },
  summer: { grass: dim('#4E7A34'), pasture: dim('#5C8A3C'), forest: dim('#2F4A26'), wheat: dim('#D9B75A'), rye: dim('#C9AE62'), barley: dim('#E0C878'), flax: dim('#7C8FD0'), cabbage: dim('#4E8A48'), fallow: dim('#7A6A4A'), garden: dim('#4E3E2C'), reed: dim('#5E8040') },
  autumn: { grass: dim('#6E7040'), pasture: dim('#7A7A44'), forest: dim('#5A4428'), wheat: dim('#C9B27A'), rye: dim('#B8A270'), barley: dim('#CDBB86'), flax: dim('#8A7A58'), cabbage: dim('#5A7A40'), fallow: dim('#6E5A44'), garden: dim('#4A3A2A'), reed: dim('#9A8A50') },
  winter: { grass: dim('#7A7560'), pasture: dim('#86806A'), forest: dim('#3A3A30'), wheat: dim('#6E6048'), rye: dim('#6A5E48'), barley: dim('#72664E'), flax: dim('#665C48'), cabbage: dim('#4E5A40'), fallow: dim('#5E5040'), garden: dim('#3E3428'), reed: dim('#8A7E5A') },
};

/**
 * 把图纸烤成一张俯视图:这是什么地(alpha)、什么颜色(按季节)。
 * 墙外那一圈(田、牧场、果园、林子、河、护城河、出城的路)也在这张图上。
 * @returns {{tex: THREE.DataTexture, R: number}} R = 这张图覆盖的半径(米)
 */
export function bakeGroundMap(plan, sizeIn, season = 'summer') {
  const W = plan.world;
  const R = Math.max(60, W ? W.forest.r1 + 30 : plan.radius * 1.35);
  const size = sizeIn || (R > 260 ? 1024 : 512);
  const SC = SEASON_COL[season] || SEASON_COL.summer;
  // Clamped:颜色写超了自己夹住(不用每个像素调一次 Math.min)
  const px = new Uint8ClampedArray(size * size * 4);
  const mPerPx = (R * 2) / size;
  const put = (ix, iy, c, cls) => {
    if (ix < 0 || iy < 0 || ix >= size || iy >= size) return;
    const k = (iy * size + ix) * 4;
    px[k] = c[0] * 255; px[k + 1] = c[1] * 255; px[k + 2] = c[2] * 255; px[k + 3] = cls * 16;
  };
  const toPx = (x, z) => [Math.round((x / (R * 2) + 0.5) * size), Math.round((z / (R * 2) + 0.5) * size)];
  // 整数哈希(比 sin 的那种快得多,一百万个像素要调它一百万次)
  const jit = (x, z, k) => { let h = Math.imul((x * 7) | 0, 374761393) ^ Math.imul((z * 7) | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return 1 - k / 2 + k * ((h >>> 8) / 16777216); };

  /* 1 底:按离镇中心多远、朝哪个方向,一格格定下是什么地 */
  const soil = dim('#6E5A44', 0.5), cobble = [0.27, 0.26, 0.26], cobble2 = [0.31, 0.3, 0.29], water = [0.07, 0.12, 0.15];
  const wallFoot = dim('#5E5446', 0.45);
  const sectors = W ? [...W.fields.map((f) => ['field', f]), ...W.pastures.map((f) => ['pasture', f]), ...W.orchards.map((f) => ['orchard', f])] : [];
  const TAU2 = Math.PI * 2;

  const r0W = W ? W.wall.r - 3.5 : 1e9;
  for (let iy = 0; iy < size; iy++) {
    const z = (iy / size - 0.5) * 2 * R;
    for (let ix = 0; ix < size; ix++) {
      const x = (ix / size - 0.5) * 2 * R;
      const r = Math.sqrt(x * x + z * z);
      let c = SC.grass, cls = 0;
      if (r > r0W) {
        if (r < W.wall.r + 2.5) { c = wallFoot; cls = 9; }
        else if (r >= W.moat.r0 && r <= W.moat.r1) { c = water; cls = 6; }
        else if (r >= W.moat.r0 - 1.2 && r <= W.moat.r1 + 1.2) { c = SC.reed; cls = 12; }
        else {
          const a = Math.atan2(z, x);
          if (r > W.forest.r0 + 8 * Math.sin(a * 7)) { c = SC.forest; cls = 8; }
          else if (r > W.moat.r1 + 4) {
            for (let q = 0; q < sectors.length; q++) {
              const kind = sectors[q][0], sc = sectors[q][1];
              if (r < sc.r0 || r > sc.r1) continue;
              let t = a - sc.a0; if (t < 0) t += TAU2; if (t < 0) t += TAU2; if (t > TAU2) t -= TAU2;
              if (t > sc.a1 - sc.a0) continue;
              if (kind === 'pasture') { c = SC.pasture; cls = 7; }
              else if (kind === 'orchard') { c = SC.grass; cls = 11; }
              else {
                const crop = sc.crops[Math.min(sc.crops.length - 1, Math.floor(t / (sc.a1 - sc.a0) * sc.crops.length))];
                c = SC[crop] || SC.wheat; cls = crop === 'fallow' || crop === 'cabbage' ? 5 : 4;
              }
              break;
            }
          }
        }
      }
      const j = jit(x, z, 0.12), k = (iy * size + ix) * 4;
      px[k] = c[0] * j * 255; px[k + 1] = c[1] * j * 255; px[k + 2] = c[2] * j * 255; px[k + 3] = cls * 16;
    }
  }
  // 一块凸多边形涂成一种地(扫描线)
  const fillPoly = (poly, c, cls) => {
    let z0 = 1e9, z1 = -1e9;
    for (const p of poly) { z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    for (let z = z0; z <= z1; z += mPerPx * 0.5) {
      let lo = 1e9, hi = -1e9;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] <= z && b[1] >= z) || (b[1] <= z && a[1] >= z)) {
          const t = Math.abs(b[1] - a[1]) < 1e-9 ? 0 : (z - a[1]) / (b[1] - a[1]);
          const x = a[0] + (b[0] - a[0]) * t;
          lo = Math.min(lo, x); hi = Math.max(hi, x);
        }
      }
      if (hi < lo) continue;
      for (let x = lo; x <= hi; x += mPerPx * 0.5) { const [ix, iy] = toPx(x, z); const j = jit(x, z, 0.14); put(ix, iy, [c[0] * j, c[1] * j, c[2] * j], cls); }
    }
  };
  // 一条带子(街、路、河):石子路的颜色逐块变一点
  const fillSeg = (a, b, w, c, cls) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 0.01) return;
    const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
    for (let s = -w / 2; s <= w / 2; s += mPerPx * 0.5) for (let u = -w * 0.3; u <= L + w * 0.3; u += mPerPx * 0.5) {
      const x = a[0] + ux * u + nx * s, z = a[1] + uz * u + nz * s;
      const [ix, iy] = toPx(x, z);
      const j = jit(Math.floor(x * 1.5), Math.floor(z * 1.5), 0.3);
      put(ix, iy, [c[0] * j, c[1] * j, c[2] * j], cls);
    }
  };
  const fillLine = (pts, w, c, cls) => { for (let i = 0; i + 1 < pts.length; i++) fillSeg(pts[i], pts[i + 1], w, c, cls); };
  if (W) {
    // 小河和河边的芦苇(护城河在上面那一遍里)
    fillLine(W.stream.pts, W.stream.w + 3, SC.reed, 12);
    fillLine(W.stream.pts, W.stream.w, water, 6);
    // 出城的土路(从城墙里侧一直到林子)
    for (const rd of W.roads) fillLine(rd.pts, rd.w, soil, 9);
  }
  for (const pk of plan.parks) fillPoly(pk.poly, SC.grass, 0);
  if (W && W.church) fillPoly(W.church.yard, SC.grass, 10);
  for (const st of plan.streets) {
    const a = plan.nodes[st.a], b = plan.nodes[st.b];
    fillSeg([a.x, a.z], [b.x, b.z], st.w, st.rank === 'avenue' ? cobble2 : cobble, 1);
  }
  for (const pz of plan.plazas) fillPoly(pz.poly, cobble2, 2);
  if (W) for (const G of W.wall.gates) {
    // 门洞下面和桥头:路面接上
    fillSeg([Math.cos(G.a) * (W.wall.r - 6), Math.sin(G.a) * (W.wall.r - 6)], [Math.cos(G.a) * (W.moat.r1 + 3), Math.sin(G.a) * (W.moat.r1 + 3)], 5, cobble, 1);
  }
  // 后院:菜畦
  if (W) for (const y of W.yards) {
    const rx = y.fz, rz = -y.fx;
    const poly = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => [y.x + rx * u * y.w / 2 + y.fx * v * y.d / 2, y.z + rz * u * y.w / 2 + y.fz * v * y.d / 2]);
    fillPoly(poly, SC.garden, 5);
  }
  // 房子底下
  for (const p of plan.plots) fillPoly(p.poly, [0.14, 0.13, 0.13], 3);
  const data = new Uint8Array(px.buffer);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  /* 类别另用一张不插值的(同一份数据):线性插值会把"草 0 挨着路 9"插出一圈"水 6",
     路两边就多出两条蓝色的小河。 */
  const cls = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  cls.needsUpdate = true;
  cls.magFilter = THREE.NearestFilter; cls.minFilter = THREE.NearestFilter;
  cls.wrapS = cls.wrapT = THREE.ClampToEdgeWrapping;
  return { tex, cls, R, season };
}

/**
 * 地面那一层点。每帧把人的位置喂给它(update),它自己跟着走。
 * @param {object} U 屋子那套 uniform(太阳、天光、雾、uPx…)—— 地和房子用的是同一片光
 */
export function createGround(U, mapIn, opts = {}) {
  let map = mapIn;
  const N = Math.max(20000, Math.round((opts.count || 140000) * (opts.budget || 1)));
  const far = opts.far || 190;   // 地要一直铺到地平线,不然远处露出天,成一条白带
  const idx = new Float32Array(N), pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) idx[i] = i;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aI', new THREE.BufferAttribute(idx, 1));
  const uniforms = {
    uN: { value: N }, uFar: { value: far }, uPx: U.uPx, uTime: U.uTime, uNight: U.uNight,
    uFogA: U.uFogA, uFogB: U.uFogB, uFogAway: U.uFogAway, uFogSun: U.uFogSun,
    uCam: { value: new THREE.Vector3() }, uSunCol: U.uSunCol, uSky: U.uSky, uSunDir: U.uSunDir,
    uMap: { value: map.tex }, uMapC: { value: map.cls }, uMapR: { value: map.R },
    uWind: { value: 0.3 }, uCrop: { value: 0.8 }, uSnowG: { value: 0 }, uWet: { value: 0 },
    uZen: { value: new THREE.Vector3(0.3, 0.45, 0.7) },
    uGL: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -99, 0, 0)) },
    uGLC: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
  };
  const m = new THREE.ShaderMaterial({ uniforms, vertexShader: GROUND_VS, fragmentShader: GROUND_FS, transparent: true, depthWrite: true });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -1;
  const bg = new THREE.CircleGeometry(far, 64);
  bg.rotateX(-Math.PI / 2);
  bg.translate(0, -0.03, 0);
  const bm = new THREE.ShaderMaterial({ uniforms, vertexShader: BASE_VS, fragmentShader: BASE_FS });
  const base = new THREE.Mesh(bg, bm);
  base.frustumCulled = false;
  base.renderOrder = -2;
  pts.add(base);
  return {
    points: pts,
    uniforms,
    update(cam) { uniforms.uCam.value.copy(cam.position); },
    /** 换季:俯视图重烤一张(512² 到 1024²,几十毫秒)。 */
    setMap(next) { const old = map; uniforms.uMap.value = next.tex; uniforms.uMapC.value = next.cls; uniforms.uMapR.value = next.R; map = next; if (old && old !== next) { old.tex.dispose(); old.cls.dispose(); } },
    dispose() { g.dispose(); m.dispose(); bg.dispose(); bm.dispose(); map.tex.dispose(); map.cls.dispose(); },
    count: N,
  };
}
