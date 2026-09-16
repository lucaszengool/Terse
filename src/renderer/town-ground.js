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

const GROUND_VS = `
attribute float aI;
uniform float uN, uFar, uPx, uTime, uNight, uFogA, uFogB;
uniform vec3 uCam, uSunCol, uSky, uFogAway, uFogSun, uSunDir;
uniform sampler2D uMap; uniform float uMapR;
varying vec3 vC; varying float vA;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main(){
  float t = (aI + 0.5) / uN;
  /* 半径按**指数**长(每一段 log 半径里点一样多),配上"点的大小正比于半径" ——
     屏幕上的颗粒于是处处一样细、一样疏。用 t 的幂来分布会让脚下几万颗点挤在几平米里,
     糊成一片珠子;这正是第一版的样子。 */
  float r = 0.5 * pow(uFar / 0.5, t);
  float a = aI * 2.39996323 + uCam.z * 0.0001;          // 黄金角,不成环也不成辐条
  vec2 w = uCam.xz + vec2(cos(a), sin(a)) * r;
  // 抖一点,免得看出是一圈圈的
  w += (vec2(h21(vec2(aI, 1.7)), h21(vec2(aI, 3.1))) - 0.5) * r * 0.75;   // 抖开:不抖就是一簇簇的草团
  vec2 uv = w / (uMapR * 2.0) + 0.5;
  vec4 m = texture2D(uMap, uv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) m = vec4(0.055, 0.06, 0.05, 0.0);
  vec3 p = vec3(w.x, m.a * 0.06, w.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  // 屏幕上每颗点大小大致不变:世界尺寸跟着半径长
  // 大小正比于半径(近处的点就该小):不设下限 —— 下限就是脚边那一圈珠子
  gl_PointSize = clamp(r * 0.023 * uPx / max(0.3, d), 1.0, 9.0);
  // 地是朝上的面:天光 + 太阳,不用法线
  vec3 lit = uSky * 0.55 + uSunCol * max(uSunDir.y, 0.0) * 0.5;
  vec3 col = m.rgb * mix(lit, vec3(0.05, 0.052, 0.062), uNight);   // 夜里的地是暗的,不是一片蓝
  // 每颗点自己深浅一点(但只是一点):按米取整会结成一坨坨的"土丘",地面看着像丘陵
  col *= 0.93 + 0.14 * h21(floor(w * 7.0));
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

/**
 * 把图纸烤成一张俯视图:草、街、广场、公园、房子底下的地。
 * @returns {{tex: THREE.DataTexture, R: number}} R = 这张图覆盖的半径(米)
 */
export function bakeGroundMap(plan, size = 512) {
  const R = Math.max(60, plan.radius * 1.35);
  const px = new Uint8Array(size * size * 4);
  const put = (ix, iy, c, h) => {
    if (ix < 0 || iy < 0 || ix >= size || iy >= size) return;
    const k = (iy * size + ix) * 4;
    px[k] = c[0] * 255; px[k + 1] = c[1] * 255; px[k + 2] = c[2] * 255; px[k + 3] = (h || 0) * 255;
  };
  const toPx = (x, z) => [Math.round((x / (R * 2) + 0.5) * size), Math.round((z / (R * 2) + 0.5) * size)];
  const mPerPx = (R * 2) / size;
  // 底:草
  for (let i = 0; i < size * size; i++) { const k = i * 4; px[k] = 34; px[k + 1] = 46; px[k + 2] = 32; px[k + 3] = 0; }
  // 一块多边形涂成一个颜色(扫描线,凸多边形)
  const fillPoly = (poly, c, h) => {
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
      for (let x = lo; x <= hi; x += mPerPx * 0.5) { const [ix, iy] = toPx(x, z); put(ix, iy, c, h); }
    }
  };
  // 一条带子(街)
  const fillSeg = (a, b, w, c) => {
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    if (L < 0.01) return;
    const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
    for (let s = -w / 2; s <= w / 2; s += mPerPx * 0.5) for (let u = -w * 0.5; u <= L + w * 0.5; u += mPerPx * 0.5) {
      const [ix, iy] = toPx(a.x + ux * u + nx * s, a.z + uz * u + nz * s);
      put(ix, iy, c, 0.06);
    }
  };
  for (const pk of plan.parks) fillPoly(pk.poly, [0.1, 0.19, 0.11], 0);
  for (const st of plan.streets) {
    const c = st.rank === 'avenue' ? [0.3, 0.3, 0.33] : st.rank === 'street' ? [0.26, 0.26, 0.29] : [0.22, 0.22, 0.25];
    fillSeg(plan.nodes[st.a], plan.nodes[st.b], st.w, c);
  }
  for (const pz of plan.plazas) fillPoly(pz.poly, [0.33, 0.33, 0.36], 0.1);
  // 房子底下:深色的地基,房子的轮廓因此在地上看得见
  for (const p of plan.plots) fillPoly(p.poly, [0.14, 0.14, 0.16], 0.2);
  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return { tex, R };
}

/**
 * 地面那一层点。每帧把人的位置喂给它(update),它自己跟着走。
 * @param {object} U 屋子那套 uniform(太阳、天光、雾、uPx…)—— 地和房子用的是同一片光
 */
export function createGround(U, map, opts = {}) {
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
    uMap: { value: map.tex }, uMapR: { value: map.R },
  };
  const m = new THREE.ShaderMaterial({ uniforms, vertexShader: GROUND_VS, fragmentShader: GROUND_FS, transparent: true, depthWrite: true });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -1;
  return {
    points: pts,
    update(cam) { uniforms.uCam.value.copy(cam.position); },
    dispose() { g.dispose(); m.dispose(); map.tex.dispose(); },
    count: N,
  };
}
