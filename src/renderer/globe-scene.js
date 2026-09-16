/**
 * globe-scene.js — 广场的"星球":一颗粒子地球,每个发布的项目在它的位置上泛起荧光。
 *
 * 做法参考 GitHub 首页的地球(没有贴图:陆地是一颗颗点,背面一层光晕,数据点是升起的光柱
 * 和一圈向外荡开又淡掉的光环)和 Stripe 的点阵地球(斐波那契球面取点,两极不挤),画法是
 * Terse 壁纸的同一颗柔光粒子。
 *
 *   陆地   斐波那契球面上均匀的点,落在陆地上的亮(低纬偏青、高纬偏淡紫),海上只有稀疏的暗蓝
 *   球体   一个不透明的暗色球,挡住背面的点;边缘一圈菲涅尔的蓝
 *   大气   背面朝外的一个大球,只在地球边缘外面亮一圈
 *   项目   光柱(光一段段往上走,按主语言上色,高度按文件数)+ 顶上一颗亮点 + 底下荡开的光环
 *   弧线   同一种语言的项目之间一条弧,光顺着弧流过去
 *
 * 借用引擎的画布(iPhone 只给一个全屏 WebGL),接口和房间一样:update / render / resize / dispose。
 * 手势:拖动转(带惯性)、双指/滚轮缩放、双击一块地方飞过去放大、点一个光点俯冲过去走进它的别墅。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { isLand } from './earth-land.js';
import * as LC from './lang-colors.js';

const D2R = Math.PI / 180;
const MIN_D = 1.22, MAX_D = 4.4;
const hash = (i) => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
/** 经纬度 → 球面上的点(y 朝北极,经度 0 朝 +z)。 */
function vec(lat, lon, r = 1) {
  const la = lat * D2R, lo = lon * D2R;
  return [r * Math.cos(la) * Math.sin(lo), r * Math.sin(la), r * Math.cos(la) * Math.cos(lo)];
}

/* 同一颗柔光粒子(壁纸的 makeDotTexture:0.96 → 0.78 → 0.22 → 0) */
const DOT_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (r > 1.0) discard;
  float a = r < 0.42 ? mix(0.96, 0.78, r / 0.42) : (r < 0.72 ? mix(0.78, 0.22, (r - 0.42) / 0.3) : mix(0.22, 0.0, (r - 0.72) / 0.28));
  gl_FragColor = vec4(vC, a * vA);
}`;

/* 陆地、海、经纬网:进来时从外面一圈聚拢成地球;侧对着人的点暗、正对着的亮 */
const LAND_VS = `
attribute vec3 aCol; attribute float aSeed, aSz;
uniform float uTime, uPx, uForm;
varying vec3 vC; varying float vA;
void main(){
  float f = clamp(uForm * 1.3 - aSeed * 0.3, 0.0, 1.0), e = 1.0 - pow(1.0 - f, 3.0);
  vec3 p = position * mix(1.0 + 1.6 * aSeed, 1.0, e);
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  vec3 n = normalize(mat3(modelMatrix) * position);
  float facing = dot(n, normalize(cameraPosition - wp));
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_PointSize = clamp(aSz * uPx / max(0.05, -mv.z), 1.0, 14.0);
  float tw = 0.82 + 0.18 * sin(uTime * (0.5 + aSeed * 1.3) + aSeed * 40.0);
  vA = e * tw * smoothstep(-0.02, 0.3, facing);
  vC = aCol * (0.3 + 0.5 * max(facing, 0.0));
  gl_Position = projectionMatrix * mv;
}`;

/* 项目:0 光柱 / 1 顶上的亮点 / 2 荡开的光环 / 3 弧线 / 4 底座 */
const MARK_VS = `
attribute vec3 aOff, aCol; attribute float aKind, aPhase, aIdx, aT;
uniform float uTime, uPx, uForm, uSel;
varying vec3 vC; varying float vA;
void main(){
  vec3 p = position; float s = 0.012, a = 1.0;
  if (aKind > 3.5) { s = 0.02; a = 0.8; }
  else if (aKind > 2.5) { s = 0.006; a = 0.18 + 1.2 * pow(0.5 + 0.5 * sin((aT * 3.0 - uTime * 0.5 + aPhase) * 6.2831), 8.0); }
  // 光柱的点挨得很近,加色一叠就成白的:每颗都压暗,留住语言的颜色
  else if (aKind > 1.5) { float r = fract(uTime * 0.33 + aPhase); p += aOff * (0.006 + r * 0.07); s = 0.007; a = (1.0 - r) * 0.6; }
  else if (aKind > 0.5) { s = 0.026; a = 0.6 + 0.2 * sin(uTime * 2.6 + aPhase * 20.0); }
  else { s = 0.008; a = 0.12 + 0.55 * pow(0.5 + 0.5 * sin((aT * 1.6 - uTime * 1.1 + aPhase) * 6.2831), 6.0); }
  float sel = 1.0 - step(0.5, abs(aIdx - uSel));
  s *= 1.0 + 0.9 * sel; a *= 1.0 + 1.2 * sel;
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  vec3 n = normalize(mat3(modelMatrix) * normalize(position));
  a *= smoothstep(-0.12, 0.12, dot(n, normalize(cameraPosition - wp)));
  a *= clamp(uForm * 1.6 - 0.5, 0.0, 1.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_PointSize = clamp(s * uPx / max(0.05, -mv.z), 1.5, 48.0);
  vC = aCol; vA = a;
  gl_Position = projectionMatrix * mv;
}`;

const STAR_VS = `
attribute float aSeed;
uniform float uTime;
varying vec3 vC; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 1.0 + aSeed * 2.2;
  vA = (0.25 + 0.6 * aSeed) * (0.7 + 0.3 * sin(uTime * (0.4 + aSeed) + aSeed * 50.0));
  vC = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.8), fract(aSeed * 7.0));
  gl_Position = projectionMatrix * mv;
}`;

const BODY_VS = `
varying vec3 vN, vV;
void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BODY_FS = `
varying vec3 vN, vV;
void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 3.0); gl_FragColor = vec4(mix(vec3(0.004, 0.008, 0.02), vec3(0.06, 0.16, 0.38), f), 1.0); }`;
/* 大气:背面朝外的大球。看得见的是远半边,视线方向上法线越朝后越亮 —— 被地球挡住的中间看不见,
   露出来的就只有地球边缘外面那一圈,越往外越淡。 */
const HALO_VS = `
varying vec3 vN;
void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HALO_FS = `
varying vec3 vN;
void main(){ float i = pow(clamp(-vN.z / 0.6, 0.0, 1.0), 3.0); gl_FragColor = vec4(vec3(0.3, 0.62, 1.0) * i * 1.1, 1.0); }`;

/**
 * @param {THREE.WebGLRenderer} renderer 引擎的那一个
 * @param {Array} projects 广场列表的项目:{ id, title, capsule: { geo:{lat,lon,city,country}, langs, files, dirs } }
 * @param {{host?:HTMLElement, input?:HTMLElement, budget?:number, onPick?:Function, onStats?:Function}} [opts]
 */
export function createGlobe(renderer, projects, opts = {}) {
  const B = Math.max(0.3, Math.min(1, opts.budget || 1));
  const host = opts.host || document.body, input = opts.input || renderer.domElement;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020309);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 300);
  const world = new THREE.Group(), sky = new THREE.Group();
  scene.add(world, sky);
  const U = { uTime: { value: 0 }, uPx: { value: 800 }, uForm: { value: 0 }, uSel: { value: -1 } };
  const disposables = [];
  const points = (attrs, vs, blend, uniforms = U) => {
    const g = new THREE.BufferGeometry();
    for (const [k, arr, n] of attrs) g.setAttribute(k, new THREE.Float32BufferAttribute(arr, n));
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader: vs, fragmentShader: DOT_FS, transparent: true, depthWrite: false, blending: blend });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    disposables.push(g, m);
    return pts;
  };

  /* ── 陆地与海 ── */
  {
    const N = Math.round(110000 * B), GA = Math.PI * (3 - Math.sqrt(5));
    // 点要比点距小一截,点和点之间留缝 —— 挤满了就是一块白,不是点阵
    const gap = Math.sqrt(4 * Math.PI / N);
    const pos = [], col = [], seed = [], sz = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - y * y), ph = i * GA;
      const x = Math.cos(ph) * r, z = Math.sin(ph) * r, h = hash(i);
      const lat = Math.asin(y) / D2R, lon = Math.atan2(x, z) / D2R;
      if (isLand(lat, lon)) {
        const c = mix3([0.3, 0.95, 0.88], [0.62, 0.6, 1.0], Math.min(1, Math.abs(lat) / 70));
        pos.push(x, y, z); col.push(c[0] * (0.8 + 0.4 * h), c[1] * (0.8 + 0.4 * h), c[2] * (0.85 + 0.3 * h)); seed.push(h); sz.push(gap * (0.58 + 0.14 * h));
      } else if (i % 9 === 0) {
        pos.push(x, y, z); col.push(0.12, 0.22, 0.42); seed.push(h); sz.push(gap * 0.5);
      }
    }
    // 淡淡的经纬网:每 20 度一条,一度一颗点
    for (let la = -60; la <= 60; la += 20) for (let lo = -180; lo < 180; lo += 1) { const v = vec(la, lo, 1.001); pos.push(...v); col.push(0.1, 0.18, 0.34); seed.push(hash(la * 999 + lo)); sz.push(0.0045); }
    for (let lo = -180; lo < 180; lo += 20) for (let la = -80; la <= 80; la += 1) { const v = vec(la, lo, 1.001); pos.push(...v); col.push(0.1, 0.18, 0.34); seed.push(hash(lo * 777 + la)); sz.push(0.0045); }
    world.add(points([['position', pos, 3], ['aCol', col, 3], ['aSeed', seed, 1], ['aSz', sz, 1]], LAND_VS, THREE.NormalBlending));
  }

  /* ── 球体(挡住背面)与大气 ── */
  const bodyG = new THREE.SphereGeometry(0.985, 64, 48), bodyM = new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: BODY_FS });
  world.add(new THREE.Mesh(bodyG, bodyM));
  const haloG = new THREE.SphereGeometry(1.24, 64, 48), haloM = new THREE.ShaderMaterial({
    vertexShader: HALO_VS, fragmentShader: HALO_FS, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  scene.add(new THREE.Mesh(haloG, haloM));
  disposables.push(bodyG, bodyM, haloG, haloM);

  /* ── 星空 ── */
  {
    const pos = [], seed = [];
    for (let i = 0; i < 1800; i++) { const h = hash(i + 7), v = vec(Math.asin(2 * hash(i * 3) - 1) / D2R, hash(i * 5) * 360 - 180, 60); pos.push(...v); seed.push(h); }
    sky.add(points([['position', pos, 3], ['aSeed', seed, 1]], STAR_VS, THREE.AdditiveBlending));
  }

  /* ── 项目 ── */
  const LR = LC.langRgb || (() => null);
  const entries = [];
  for (const p of projects || []) {
    const cap = (p && p.capsule) || {}, g = cap.geo;
    if (!g || !Number.isFinite(+g.lat) || !Number.isFinite(+g.lon)) continue;
    const id = String(p.id || cap.title || '');
    // 同一座城里的几个项目别叠成一个点:按 id 散开到 ±0.6 度
    const lat = +g.lat + (strHash(id) - 0.5) * 1.2, lon = +g.lon + (strHash('x' + id) - 0.5) * 1.2;
    const lang = String((cap.langs && cap.langs[0] && cap.langs[0][0]) || '').toLowerCase();
    const c0 = (lang && LR(lang)) || [0.55, 0.95, 1.0];
    const files = +cap.files || (cap.dirs || []).reduce((s, d) => s + (+(d && d.files) || 0), 0) || 10;
    entries.push({ p, lat, lon, v: vec(lat, lon), c: c0.map((v) => Math.min(1, v * 1.25 + 0.08)), h: 0.05 + 0.14 * Math.min(1, Math.log10(1 + files) / 4),
      ph: strHash(id), title: String(cap.title || p.title || '—'), place: [g.city, g.country].filter(Boolean).join(' · '), lang: lang || '' });
  }
  {
    const P = [], O = [], C = [], K = [], PH = [], I = [], T = [];
    const add = (p, o, c, k, ph, idx, t) => { P.push(p[0], p[1], p[2]); O.push(o[0], o[1], o[2]); C.push(c[0], c[1], c[2]); K.push(k); PH.push(ph); I.push(idx); T.push(t); };
    const Z = [0, 0, 0];
    entries.forEach((e, idx) => {
      const n = e.v, sc = (r) => [n[0] * r, n[1] * r, n[2] * r];
      const t1 = norm(cross(Math.abs(n[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0], n)), t2 = cross(n, t1);
      for (let k = 0; k <= 26; k++) add(sc(1 + e.h * k / 26), Z, e.c, 0, e.ph, idx, k / 26);
      add(sc(1 + e.h), Z, e.c, 1, e.ph, idx, 1);
      add(sc(1.002), Z, e.c, 4, e.ph, idx, 0);
      for (let k = 0; k < 30; k++) {
        const a = k / 30 * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        add(sc(1.003), [t1[0] * ca + t2[0] * sa, t1[1] * ca + t2[1] * sa, t1[2] * ca + t2[2] * sa], e.c, 2, e.ph, idx, 0);
      }
    });
    // 同一种语言的项目,按经度排好相邻两两连一条弧,光顺着弧流过去
    const byLang = new Map();
    entries.forEach((e, i) => { if (!byLang.has(e.lang)) byLang.set(e.lang, []); byLang.get(e.lang).push(i); });
    let arcs = 0;
    for (const list of byLang.values()) {
      list.sort((a, b) => entries[a].lon - entries[b].lon);
      for (let j = 0; j + 1 < list.length && arcs < 70; j++) {
        const a = entries[list[j]], b = entries[list[j + 1]];
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(a.v, b.v))));
        if (ang < 0.03) continue;
        const n = Math.max(24, Math.round(ang * 90)), lift = Math.min(0.26, 0.04 + ang * 0.16), sn = Math.sin(ang);
        for (let k = 0; k <= n; k++) {
          const t = k / n, wa = Math.sin((1 - t) * ang) / sn, wb = Math.sin(t * ang) / sn, r = 1.004 + Math.sin(Math.PI * t) * lift;
          add([(a.v[0] * wa + b.v[0] * wb) * r, (a.v[1] * wa + b.v[1] * wb) * r, (a.v[2] * wa + b.v[2] * wb) * r], Z, mix3(a.c, b.c, t), 3, a.ph, -9, t);
        }
        arcs++;
      }
    }
    if (P.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('aOff', new THREE.Float32BufferAttribute(O, 3));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(C, 3));
      g.setAttribute('aKind', new THREE.Float32BufferAttribute(K, 1));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(PH, 1));
      g.setAttribute('aIdx', new THREE.Float32BufferAttribute(I, 1));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(T, 1));
      const m = new THREE.ShaderMaterial({ uniforms: U, vertexShader: MARK_VS, fragmentShader: DOT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const mk = new THREE.Points(g, m); mk.frustumCulled = false; mk.renderOrder = 3;
      world.add(mk); disposables.push(g, m);
    }
  }
  try { opts.onStats && opts.onStats(entries.length); } catch (e) {}

  /* ── 标签:放大到看得清时,离屏幕中间最近的几个项目挂上名字和城市 ── */
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  host.appendChild(layer);
  const labels = entries.map((e) => {
    const d = document.createElement('div');
    d.className = 'gl-label';
    d.textContent = e.title;
    if (e.place) { const s = document.createElement('small'); s.textContent = e.place; d.appendChild(s); }
    d.style.borderColor = `rgba(${e.c.map((v) => Math.round(v * 255)).join(',')},0.55)`;
    d.style.display = 'none';
    layer.appendChild(d);
    return d;
  });

  /* ── 相机与手势 ── */
  let lat = 20, lon = 100;
  if (entries.length) {
    const s = entries.reduce((a, e) => [a[0] + e.v[0], a[1] + e.v[1], a[2] + e.v[2]], [0, 0, 0]), n = norm(s);
    if (Math.hypot(s[0], s[1], s[2]) > 0.3) { lat = Math.asin(n[1]) / D2R; lon = Math.atan2(n[0], n[2]) / D2R; }
  }
  let dist = 4.4, tLat = lat, tLon = lon, tDist = 3.5, vLon = 0, vLat = 0, idle = 0, diving = false, t = 0;
  let W = 1, H = 1;
  const clampLat = (v) => Math.max(-72, Math.min(72, v));
  const clampD = (v) => Math.max(MIN_D, Math.min(MAX_D, v));
  const offs = [];
  const on = (el, ty, fn, o) => { el.addEventListener(ty, fn, o); offs.push(() => el.removeEventListener(ty, fn, o)); };
  const pts = new Map();
  let moved = 0, pinch0 = 0, dist0 = 0, lastTap = 0, lastX = 0, lastY = 0, pend = null;
  const degPerPx = () => 0.2 * Math.max(0.1, dist - 1.0);
  const rect = () => { try { return input.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0 }; } };
  const cvRect = () => { try { return renderer.domElement.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0, width: W, height: H }; } };

  on(input, 'pointerdown', (e) => {
    try { input.setPointerCapture(e.pointerId); } catch (err) {}
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0; idle = 0; vLon = vLat = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); dist0 = tDist; }
  });
  on(input, 'pointermove', (e) => {
    const q = pts.get(e.pointerId);
    if (!q || diving) return;
    const dx = e.clientX - q[0], dy = e.clientY - q[1];
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    idle = 0;
    if (pts.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      const k = degPerPx();
      tLon -= dx * k; tLat = clampLat(tLat + dy * k);
      vLon = -dx * k * 50; vLat = dy * k * 50;
    } else if (pts.size === 2) {
      moved += 20;
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0 > 0 && d > 0) tDist = clampD(dist0 * pinch0 / d);
    }
  });
  const release = (e) => {
    if (!pts.has(e.pointerId)) return;
    const multi = pts.size > 1;
    pts.delete(e.pointerId);
    if (multi || moved > 8 || diving || e.type === 'pointercancel') return;
    const now = performance.now(), x = e.clientX, y = e.clientY;
    if (now - lastTap < 320 && Math.hypot(x - lastX, y - lastY) < 40) {
      lastTap = 0; clearTimeout(pend); pend = null; zoomAt(x, y); return;
    }
    lastTap = now; lastX = x; lastY = y;
    clearTimeout(pend);
    pend = setTimeout(() => { pend = null; pickAt(x, y); }, 300);
  };
  on(input, 'pointerup', release);
  on(input, 'pointercancel', release);
  on(input, 'wheel', (e) => { e.preventDefault(); tDist = clampD(tDist * Math.exp(e.deltaY * 0.0012)); idle = 0; }, { passive: false });

  const ndc = (x, y) => { const r = cvRect(); return new THREE.Vector2(((x - r.left) / (r.width || W)) * 2 - 1, -((y - r.top) / (r.height || H)) * 2 + 1); };
  /** 双击:点到的那块地方转到正中间,拉近。 */
  function zoomAt(x, y) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc(x, y), camera);
    const hit = rc.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
    if (!hit) { tDist = clampD(tDist * 0.7); return; }
    world.updateMatrixWorld();
    const l = world.worldToLocal(hit.clone()).normalize();
    tLat = clampLat(Math.asin(l.y) / D2R); tLon = Math.atan2(l.x, l.z) / D2R;
    tDist = clampD(Math.max(MIN_D + 0.08, tDist * 0.55));
    vLon = vLat = 0; idle = 0;
  }
  const screenOf = (e, out) => {
    const v = new THREE.Vector3(e.v[0] * (1 + e.h), e.v[1] * (1 + e.h), e.v[2] * (1 + e.h)).applyMatrix4(world.matrixWorld);
    const nrm = new THREE.Vector3(e.v[0], e.v[1], e.v[2]).applyQuaternion(world.quaternion);
    const facing = nrm.dot(camera.position.clone().sub(v).normalize());
    v.project(camera);
    const r = cvRect();
    out.x = r.left + (v.x * 0.5 + 0.5) * (r.width || W); out.y = r.top + (-v.y * 0.5 + 0.5) * (r.height || H); out.facing = facing;
    return out;
  };
  /** 单击:最近的那个光点(正面、30 像素以内)—— 俯冲过去,然后走进它的别墅。 */
  function pickAt(x, y) {
    world.updateMatrixWorld();
    let best = -1, bd = 32;
    const s = {};
    entries.forEach((e, i) => {
      screenOf(e, s);
      if (s.facing < 0.15) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return;
    const e = entries[best];
    U.uSel.value = best;
    tLat = clampLat(e.lat); tLon = e.lon; tDist = clampD(Math.min(tDist, MIN_D + 0.2));
    diving = true;
    setTimeout(() => { diving = false; try { opts.onPick && opts.onPick(e.p); } catch (err) {} }, 780);
  }

  function labelsTick() {
    const show = dist < 2.35;
    const s = {}, cx = W / 2, cy = H / 2, cand = [];
    if (show) {
      entries.forEach((e, i) => { screenOf(e, s); if (s.facing > 0.3) cand.push({ i, x: s.x, y: s.y, d: Math.hypot(s.x - cx, s.y - cy) }); });
      cand.sort((a, b) => a.d - b.d);
    }
    const taken = [], on2 = new Set();
    for (const c of cand) {
      if (on2.size >= 12) break;
      if (taken.some((q) => Math.abs(q.x - c.x) < 110 && Math.abs(q.y - c.y) < 34)) continue;
      taken.push(c); on2.add(c.i);
      const r = rect(), d = labels[c.i];
      d.style.display = 'block';
      d.style.transform = `translate(${c.x - r.left}px, ${c.y - r.top}px) translate(-50%, -135%)`;
      d.style.opacity = String(Math.max(0.35, Math.min(1, (2.35 - dist) * 2)));
    }
    labels.forEach((d, i) => { if (!on2.has(i)) d.style.display = 'none'; });
  }

  /* ── 渲染 ── */
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
  renderer.autoClear = true;
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // 阈值压在陆地的亮度之上:泛光的只有项目的光柱、光点、光环和弧
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.5, 0.62);
  composer.addPass(bloom);

  function update(dt) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    t += dt; U.uTime.value = t;
    U.uForm.value = Math.min(1, U.uForm.value + dt / 2.2);
    idle += dt;
    if (!pts.size && !diving) {
      tLon += vLon * dt; tLat = clampLat(tLat + vLat * dt);
      vLon *= Math.exp(-dt * 2.5); vLat *= Math.exp(-dt * 2.5);
      if (idle > 4) tLon += dt * 3.5;                          // 没人碰的时候慢慢自转
    }
    const k = 1 - Math.exp(-dt * (diving ? 5 : 8));
    const dl = ((((tLon - lon) % 360) + 540) % 360) - 180;
    lat += (tLat - lat) * k; lon += dl * k; dist += (tDist - dist) * k;
    world.rotation.set(lat * D2R, -lon * D2R, 0);
    sky.rotation.set(lat * D2R * 0.15, -lon * D2R * 0.15, 0);
    camera.position.set(0, 0, dist); camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(); world.updateMatrixWorld();
    labelsTick();
  }
  function render() { composer.render(); }
  function resize(w, h) {
    W = Math.max(1, w | 0); H = Math.max(1, h | 0);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    composer.setSize(W, H);
    U.uPx.value = (H * renderer.getPixelRatio() / 2) / Math.tan(camera.fov * D2R / 2);
  }
  function dispose() {
    clearTimeout(pend);
    for (const f of offs) { try { f(); } catch (e) {} }
    try { layer.remove(); } catch (e) {}
    for (const d of disposables) { try { d.dispose(); } catch (e) {} }
    try { bloom.dispose(); composer.dispose(); } catch (e) {}
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
  }
  return {
    update, render, resize, dispose, count: entries.length,
    /** 测试用:直接摆到某个视角 */
    view(la, lo, d) { lat = tLat = la; lon = tLon = lo; dist = tDist = clampD(d); },
    renderNow() { U.uForm.value = 1; update(0); render(); },
    select(i) { U.uSel.value = i; },
  };
}
