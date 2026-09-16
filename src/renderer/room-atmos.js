/**
 * room-atmos.js — 屋子外面的天和天气:天穹、云、星、月、彩虹、闪电,雨、雪、花瓣、落叶、萤火。
 *
 * 天是什么样由 room-sky.js 算(几点、什么季节、什么天气);这里只管把它画出来。
 *
 *   露天的格局(四合院、庭院):一整个天穹罩在头上,雨雪花叶是真的三维粒子,在人身边落。
 *   屋里:天只从窗里看得见 —— 每扇窗外面贴一块"天"的面片,着色器按视线方向画天,
 *         窗里的雨丝、雪也是天的着色器画的。点与点之间留着缝的墙后面不放任何亮的东西,
 *         否则一面墙会被后面的蓝天透成一片蓝点。
 *
 * 云也是粒子:天空的着色器按网格采云的浓度,每格画一颗柔光点,越浓点越大 —— 一朵朵
 * 由许多颗光点组成的云,和屋子、城市是同一种笔触。
 *
 * ⚠ 自己的着色器、自己的 uniform,不碰屋子那张快满了的顶点 uniform 表(iPhone ≈256 个 vec4)。
 */
import * as THREE from 'three';

const NOISE = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ return (vn(p) * 0.5 + vn(p * 2.03) * 0.25 + vn(p * 4.1) * 0.125) / 0.875; }
`;

const SKY_VS = `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const SKY_FS = `
precision highp float;
uniform vec3 uZen, uHor, uGlow, uSunDir, uSunC;
uniform float uNight, uCover, uTime, uRain, uSnow, uFog, uBow, uFlash, uMoon, uWind, uStorm, uGolden, uGain, uWin;
varying vec3 vW;
${NOISE}
vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
void main(){
  vec3 d = normalize(vW - cameraPosition);
  float up = d.y, day = 1.0 - uNight;
  float mu = max(dot(d, uSunDir), 0.0);
  // 天顶到地平线的渐变;地平线以下是一层暗下去的地气
  vec3 c = mix(uHor, uZen, pow(clamp(up, 0.0, 1.0), 0.55));
  // 从窗里平着看出去全是地平线那一圈(发白):往天顶的蓝里拉一些,窗里才是"蓝天"
  c = mix(c, uZen, 0.4 * uWin * (1.0 - smoothstep(0.3, 0.8, up)));
  if (up < 0.0) c = mix(uHor, uHor * 0.3, smoothstep(0.0, -0.4, up));
  // 太阳那一侧的光晕和太阳本身(阴天被云吃掉)
  c += uGlow * (0.28 * pow(mu, 6.0) + 0.12 * pow(mu, 1.5) * uGolden) * (1.0 - uCover * 0.7);
  c += uSunC * smoothstep(0.99935, 0.99965, mu) * day * (1.0 - uCover * 0.92) * step(-0.02, up) * 2.5;

  if (up > 0.0 && uNight > 0.01) {
    // 星:方向切成小格,少数格子里一颗会闪的星
    vec2 sp = vec2(atan(d.z, d.x) * 70.0, asin(clamp(up, -1.0, 1.0)) * 70.0);
    vec2 cell = floor(sp), f = fract(sp) - 0.5;
    float h = h21(cell);
    if (h > 0.962) {
      vec2 o = vec2(h21(cell + 3.1), h21(cell + 7.7)) - 0.5;
      float tw = 0.6 + 0.4 * sin(uTime * (1.5 + h * 4.0) + h * 60.0);
      c += vec3(0.85, 0.9, 1.0) * smoothstep(0.2, 0.0, length(f - o * 0.55)) * tw * (0.5 + (h - 0.962) * 16.0) * uNight * (1.0 - uCover);
    }
    // 银河:斜着的一条淡带
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.55, -0.78))), 2.0) * 16.0);
    c += vec3(0.22, 0.24, 0.36) * band * fbm(sp * 0.06) * 0.4 * uNight * (1.0 - uCover);
    // 月亮:和太阳大致相对的高处;按月相亮一部分
    vec3 md = normalize(vec3(-uSunDir.x, abs(uSunDir.y) * 0.4 + 0.5, -uSunDir.z));
    float mm = dot(d, md);
    vec3 side = normalize(cross(md, vec3(0.0, 1.0, 0.0)));
    float x = dot(d - md * mm, side) / 0.028, k = cos(uMoon * 6.2831853);
    float lit = uMoon < 0.5 ? smoothstep(k - 0.15, k + 0.15, x) : smoothstep(k - 0.15, k + 0.15, -x);
    float disk = smoothstep(0.99955, 0.9997, mm);
    c += vec3(0.95, 0.93, 0.84) * disk * mix(0.05, 1.0, lit) * uNight * (1.0 - uCover * 0.85);
    c += vec3(0.45, 0.5, 0.66) * pow(max(mm, 0.0), 260.0) * 0.3 * uNight * (1.0 - uCover * 0.6);
  }

  // 云:一格一颗柔光点,越浓点越大;底下垫一层很淡的连续云,厚云不会只剩一片点
  if (up > 0.0) {
    vec2 uv = d.xz / (up + 0.12) * 2.0 + vec2(uTime * 0.01 * (0.3 + uWind), uTime * 0.0035);
    float gs = 22.0;
    vec2 g = uv * gs, cc = floor(g) + 0.5, f = g - cc, cu = cc / gs;
    float dens = fbm(cu * 0.8) * 0.65 + fbm(cu * 2.2 + 5.0) * 0.35;
    float thr = 1.0 - uCover;
    float cl = smoothstep(thr - 0.14, thr + 0.2, dens);
    float soft = smoothstep(thr - 0.14, thr + 0.2, fbm(uv * 0.8) * 0.65 + fbm(uv * 2.2 + 5.0) * 0.35);
    float rr = mix(0.12, 0.62, cl);
    float dotm = smoothstep(rr, rr - 0.14, length(f)) * step(0.03, cl);
    float fade = smoothstep(0.0, 0.2, up);
    vec3 top = mix(vec3(0.74, 0.8, 0.9), vec3(1.0), 0.55 + 0.45 * mu);
    top = mix(top, uGlow * 1.05 + vec3(0.08, 0.02, 0.1), uGolden * 0.75);   // 黄昏:云被染成粉金
    top *= mix(1.0, 0.42, uStorm);
    top = mix(top, vec3(0.08, 0.1, 0.16) + uHor * 0.25, uNight * 0.92);
    float a = clamp(soft * 0.5 + dotm * 0.55, 0.0, 1.0) * fade * (0.55 + 0.45 * uCover);
    c = mix(c, top * (0.92 + 0.12 * dotm), a);
  }

  // 彩虹:背着太阳 40–42.5°,红在外圈
  if (uBow > 0.0 && up > 0.0) {
    float th = degrees(acos(clamp(dot(d, -uSunDir), -1.0, 1.0)));
    float t = (th - 40.0) / 2.6;
    if (t > 0.0 && t < 1.0) c += hue((1.0 - t) * 0.8) * 0.3 * uBow * sin(t * 3.14159) * smoothstep(0.0, 0.12, up) * day;
  }
  // 雾:地平线附近白茫茫一片
  c = mix(c, uHor * 0.92 + 0.06, uFog * 0.8 * (1.0 - smoothstep(0.0, 0.55, abs(up))));

  // 窗里看出去的雨丝和雪(露天时这些是真粒子,这里只画远处那一层)
  float ax = atan(d.x, d.z);
  if (uRain > 0.0) {
    float cx = ax * 140.0, cid = floor(cx), fx = fract(cx) - 0.5, h = h21(vec2(cid, 1.3));
    float yy = up * 5.0 + uTime * (2.4 + h * 1.2) + h * 10.0;
    float on = step(0.45, h21(vec2(cid, floor(yy))));
    float s = smoothstep(0.12, 0.0, abs(fx + fract(yy) * uWind * 0.4)) * smoothstep(0.0, 0.05, fract(yy)) * smoothstep(0.35, 0.05, fract(yy)) * on;
    c = mix(c, mix(uHor, vec3(0.85, 0.9, 1.0), 0.5), s * 0.35 * uRain * (0.4 + 0.6 * uWin));
  }
  if (uSnow > 0.0) {
    vec2 sg = vec2(ax * 60.0 + sin(uTime * 0.6 + up * 9.0) * 0.8, up * 40.0 + uTime * 1.4);
    vec2 sc = floor(sg), sf = fract(sg) - 0.5;
    float h = h21(sc);
    c = mix(c, vec3(0.96, 0.97, 1.0) * mix(1.0, 0.5, uNight), smoothstep(0.22, 0.05, length(sf - (vec2(h21(sc + 2.0), h) - 0.5) * 0.5)) * step(0.55, h) * uSnow * 0.8);
  }
  c += vec3(0.8, 0.85, 1.0) * uFlash * 0.9;          // 闪电
  gl_FragColor = vec4(c * uGain, 1.0);
}`;

/* 雨、雪、花瓣、落叶、萤火:在人身边一个会跟着走的盒子里循环,位置全在着色器里算 */
const WX_VS = `
precision highp float;
attribute vec4 aSeed; attribute float aKind;
uniform vec3 uBox; uniform float uTime, uPx, uWind, uFlies, uLit;
uniform vec4 uAmt;                       // 雨、雪、花瓣、落叶各多少(0..1)
uniform vec4 uRoof[4]; uniform int uNRoof;
uniform vec3 uRainC;
varying vec3 vC; varying float vA, vK, vRot, vFlip;
#define HIDE { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
void main(){
  float k = aKind; vK = k;
  float amt = k < 0.5 ? uAmt.x : k < 1.5 ? uAmt.y : k < 2.5 ? uAmt.z : k < 3.5 ? uAmt.w : uFlies;
  if (aSeed.w >= amt) HIDE
  float H = uBox.y;
  float fall = k < 0.5 ? 9.0 : k < 1.5 ? 0.85 : k < 2.5 ? 0.6 : k < 3.5 ? 1.0 : 0.0;
  vec3 p;
  p.y = mod(aSeed.y * H - uTime * fall * (0.8 + aSeed.x * 0.4), H);
  vec2 xz = aSeed.xz * uBox.xz + vec2(uWind * (k < 0.5 ? 2.2 : 1.1), uWind * 0.35) * uTime * (0.6 + aSeed.y * 0.4);
  if (k > 0.5 && k < 3.5) xz += vec2(sin(uTime * (0.7 + aSeed.x) + aSeed.z * 20.0), cos(uTime * (0.5 + aSeed.z) + aSeed.x * 17.0)) * (k < 1.5 ? 0.35 : 0.9);
  if (k > 3.5) {
    p.y = 0.35 + aSeed.y * 2.4 + sin(uTime * 0.7 + aSeed.x * 30.0) * 0.3;
    xz = aSeed.xz * uBox.xz + vec2(sin(uTime * 0.3 + aSeed.y * 40.0), cos(uTime * 0.27 + aSeed.x * 33.0)) * 1.2;
  }
  xz = mod(xz - cameraPosition.xz + uBox.xz * 0.5, uBox.xz) - uBox.xz * 0.5 + cameraPosition.xz;
  p.xz = xz;
  // 有顶的屋子里不下雨
  for (int i = 0; i < 4; i++) { if (i >= uNRoof) break; vec4 r = uRoof[i]; if (p.x > r.x && p.x < r.z && p.z > r.y && p.z < r.w) HIDE }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  if (d < 0.2) HIDE
  float size = k < 0.5 ? 0.38 : k < 1.5 ? 0.055 : k < 2.5 ? 0.08 : k < 3.5 ? 0.1 : 0.07;
  gl_PointSize = clamp(size * uPx / d, 1.0, 56.0);
  vA = smoothstep(0.3, 1.4, d) * (1.0 - smoothstep(uBox.x * 0.36, uBox.x * 0.5, length(p.xz - cameraPosition.xz)));
  vRot = aSeed.x * 6.2831 + uTime * (0.8 + aSeed.z * 1.6);
  vFlip = abs(cos(uTime * (1.4 + aSeed.y * 2.0) + aSeed.z * 9.0));
  if (k < 0.5) { vC = uRainC; vA *= 0.55; vRot = uWind * 0.35; }
  else if (k < 1.5) { vC = vec3(0.97, 0.98, 1.0) * uLit; vA *= 0.9; }
  else if (k < 2.5) { vC = mix(vec3(1.0, 0.76, 0.85), vec3(1.0, 0.92, 0.95), aSeed.x) * uLit; }
  else if (k < 3.5) { vC = (aSeed.x < 0.33 ? vec3(0.85, 0.47, 0.17) : aSeed.x < 0.66 ? vec3(0.71, 0.26, 0.16) : vec3(0.89, 0.69, 0.29)) * uLit; }
  else { vC = vec3(0.78, 1.0, 0.45); vA *= pow(max(sin(uTime * (1.2 + aSeed.z * 1.5) + aSeed.x * 40.0), 0.0), 6.0) * 1.6; }
  gl_Position = projectionMatrix * mv;
}`;
const WX_FS = `
precision highp float;
varying vec3 vC; varying float vA, vK, vRot, vFlip;
void main(){
  vec2 q = gl_PointCoord - 0.5;
  float a;
  if (vK < 0.5) a = smoothstep(0.05, 0.0, abs(q.x + q.y * vRot)) * smoothstep(0.5, -0.2, q.y);
  else if (vK < 1.5) a = smoothstep(0.5, 0.12, length(q));
  else {
    float cs = cos(vRot), sn = sin(vRot);
    vec2 r = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
    r.x /= max(0.2, vFlip);
    a = vK < 2.5 ? 1.0 - smoothstep(0.8, 1.0, length(r / vec2(0.24, 0.4))) : 1.0 - smoothstep(0.8, 1.0, length(r / vec2(0.18, 0.46)));
  }
  if (a * vA < 0.02) discard;
  gl_FragColor = vec4(vC, a * vA);
}`;
const FLY_FS = `
precision highp float;
varying vec3 vC; varying float vA, vK, vRot, vFlip;
void main(){ vec2 q = gl_PointCoord - 0.5; float a = exp(-dot(q, q) * 26.0); gl_FragColor = vec4(vC * a * vA, 1.0); }`;

const hash = (i) => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;

/**
 * @param {object} o
 *   open     露天的格局:画天穹和三维天气;否则只在窗里画天
 *   windows  room-arch 收集的窗 {o, U, V, n, type}(n 朝屋里)
 *   roofs    露天格局里有顶的屋子 [{x0,z0,x1,z1}](不在里面下雨)
 *   budget   0.25–1
 *   uPx      屋子那边"一弧度多少像素"的 uniform(共用同一个对象)
 */
export function createAtmosphere(o) {
  const B = Math.max(0.25, Math.min(1, o.budget || 1));
  const group = new THREE.Group();
  const disposables = [];
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const SU = {
    uZen: { value: v3([0.1, 0.3, 0.8]) }, uHor: { value: v3([0.7, 0.85, 1]) }, uGlow: { value: v3([1, 0.9, 0.8]) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunC: { value: v3([1, 0.96, 0.88]) },
    uNight: { value: 0 }, uCover: { value: 0 }, uTime: { value: 0 }, uRain: { value: 0 }, uSnow: { value: 0 }, uFog: { value: 0 },
    uBow: { value: 0 }, uFlash: { value: 0 }, uMoon: { value: 0.5 }, uWind: { value: 0.2 }, uStorm: { value: 0 }, uGolden: { value: 0 },
    // 亮度:都压在泛光阈值下面(露天 0.82、屋里 0.55),只有太阳会晕开 —— 不然窗是一块白、地平线是一道白光
    uGain: { value: o.open ? 0.86 : 0.62 }, uWin: { value: o.open ? 0 : 1 },
  };
  const skyMat = new THREE.ShaderMaterial({ uniforms: SU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.DoubleSide, depthWrite: false });
  disposables.push(skyMat);

  let dome = null;
  if (o.open) {
    const g = new THREE.SphereGeometry(150, 48, 24);
    dome = new THREE.Mesh(g, skyMat);
    dome.renderOrder = -10; dome.frustumCulled = false;
    group.add(dome); disposables.push(g);
  } else {
    /* 每扇窗外面 25 厘米贴一块天,四边各放大一点,窗框的缝里也是天。纸窗(障子)不透。 */
    const pos = [];
    for (const w of o.windows || []) {
      if (w.type === 'shoji') continue;
      const out = [-w.n[0] * 0.25, -w.n[1] * 0.25, -w.n[2] * 0.25];
      const lu = Math.hypot(...w.U), lv = Math.hypot(...w.V), m = 0.12;
      const eu = w.U.map((x) => x / lu * m), ev = w.V.map((x) => x / lv * m);
      const P = (a, b) => [0, 1, 2].map((k) => w.o[k] + out[k] + w.U[k] * a + w.V[k] * b + eu[k] * (a * 2 - 1) + ev[k] * (b * 2 - 1));
      const p00 = P(0, 0), p10 = P(1, 0), p11 = P(1, 1), p01 = P(0, 1);
      pos.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, skyMat);
      m.renderOrder = -10; m.frustumCulled = false;
      group.add(m); disposables.push(g);
    }
  }

  /* ── 三维天气(只在露天) ── */
  const WU = {
    uBox: { value: new THREE.Vector3(26, 14, 26) }, uTime: SU.uTime, uPx: o.uPx || { value: 800 }, uWind: SU.uWind,
    uFlies: { value: 0 }, uLit: { value: 1 }, uAmt: { value: new THREE.Vector4() },
    uRoof: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uNRoof: { value: 0 },
    uRainC: { value: new THREE.Vector3(0.7, 0.76, 0.86) },
  };
  if (o.open) {
    (o.roofs || []).slice(0, 4).forEach((r, i) => WU.uRoof.value[i].set(r.x0, r.z0, r.x1, r.z1));
    WU.uNRoof.value = Math.min(4, (o.roofs || []).length);
    const mk = (counts, fs, blend, order) => {
      const n = counts.reduce((a, c) => a + c[1], 0);
      const seed = new Float32Array(n * 4), kind = new Float32Array(n), pos = new Float32Array(n * 3);
      let i = 0;
      for (const [k, c] of counts) for (let j = 0; j < c; j++, i++) {
        seed[i * 4] = hash(i * 4); seed[i * 4 + 1] = hash(i * 4 + 1); seed[i * 4 + 2] = hash(i * 4 + 2); seed[i * 4 + 3] = hash(i * 4 + 3) * 0.999;
        kind[i] = k;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
      g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
      const m = new THREE.ShaderMaterial({ uniforms: WU, vertexShader: WX_VS, fragmentShader: fs, transparent: true, depthWrite: false, blending: blend });
      const p = new THREE.Points(g, m);
      p.frustumCulled = false; p.renderOrder = order;
      group.add(p); disposables.push(g, m);
    };
    mk([[0, Math.round(5500 * B)], [1, Math.round(3200 * B)], [2, Math.round(650 * B)], [3, Math.round(450 * B)]], WX_FS, THREE.NormalBlending, 5);
    mk([[4, 150]], FLY_FS, THREE.AdditiveBlending, 6);
  }

  /* ── 天气换了:所有量在一两秒里慢慢过去,不跳 ── */
  const cur = {}, tgt = {};
  const KEYS = ['uNight', 'uCover', 'uRain', 'uSnow', 'uFog', 'uBow', 'uMoon', 'uWind', 'uStorm', 'uGolden'];
  const COLS = ['uZen', 'uHor', 'uGlow'];
  let bolt = 0, nextBolt = 4, flash = 0, flashT = -1;
  let first = true;
  function setEnv(env, sunDir) {
    const fx = env.fx;
    Object.assign(tgt, {
      uNight: env.night, uCover: fx.cover, uRain: fx.rain, uSnow: fx.snow, uFog: fx.fog, uBow: fx.bow, uMoon: env.moon,
      uWind: fx.wind, uStorm: fx.bolt, uGolden: env.golden,
      uZen: env.zen, uHor: env.hor, uGlow: env.glow,
      rain: fx.rain, snow: fx.snow, petals: fx.petals, leaves: fx.leaves, flies: fx.flies,
    });
    bolt = fx.bolt;
    if (sunDir) SU.uSunDir.value.copy(sunDir).normalize();
    if (first) { Object.assign(cur, JSON.parse(JSON.stringify(tgt))); first = false; apply(); }
  }
  function apply() {
    for (const k of KEYS) SU[k].value = cur[k];
    for (const k of COLS) SU[k].value.set(cur[k][0], cur[k][1], cur[k][2]);
    WU.uAmt.value.set(cur.rain, cur.snow * 0.9, cur.petals * 0.8, cur.leaves * 0.7);
    WU.uFlies.value = cur.flies;
    WU.uLit.value = (1 - 0.65 * cur.uNight) * (1 - 0.2 * cur.uCover);
    const h = cur.uHor;
    WU.uRainC.value.set(...[0, 1, 2].map((i) => (h[i] * 0.5 + 0.45) * (1 - 0.6 * cur.uNight)));
  }

  function update(dt, t, camera) {
    SU.uTime.value = t;
    if (dome && camera) dome.position.copy(camera.position);
    const k = 1 - Math.exp(-dt * 1.4);
    if (!first) {
      for (const key of Object.keys(tgt)) {
        if (Array.isArray(tgt[key])) cur[key] = cur[key].map((v, i) => v + (tgt[key][i] - v) * k);
        else if (key === 'uMoon') cur[key] = tgt[key];
        else cur[key] += (tgt[key] - cur[key]) * k;
      }
      apply();
    }
    // 闪电:几秒一次,两三下一闪一闪
    if (bolt > 0.5) {
      nextBolt -= dt;
      if (nextBolt <= 0) { flashT = 0; nextBolt = 5 + Math.random() * 10; }
    }
    if (flashT >= 0) {
      flashT += dt;
      const pulses = [[0, 0.07, 1], [0.12, 0.2, 0.45], [0.26, 0.42, 0.8]];
      flash = 0;
      for (const [a, b, v] of pulses) if (flashT >= a && flashT < b) flash = v * (1 - (flashT - a) / (b - a) * 0.6);
      if (flashT > 0.45) { flashT = -1; flash = 0; }
    }
    SU.uFlash.value = flash * (o.reduceMotion ? 0.25 : 1);
  }
  function dispose() { for (const d of disposables) { try { d.dispose(); } catch (e) {} } }
  return { group, setEnv, update, dispose, get flash() { return SU.uFlash.value; }, uniforms: SU };
}
