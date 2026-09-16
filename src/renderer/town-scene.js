/**
 * town-scene.js — 广场就是一座小镇,第一人称走进去。
 *
 *   town-plan.js   图纸:谁住哪儿、街怎么走、广场和公园在哪(纯函数,可测)
 *   town-build.js  把图纸盖成粒子:地、路、房子、树、灯
 *   room-atmos.js  天:蓝天白云、日出日落、雨雪雾、星星和月亮(和别墅里是同一套)
 *   room-surface.js 面在 GPU 上长成细点 —— 和屋子、和城市是同一种笔触
 *
 * 一栋房子 = 一个项目,走到门口按一下就进它的别墅(room-scene.js)。镇上别的人是一个个
 * 粒子小人,头顶挂着昵称。
 *
 * ⚠ 不自己开 WebGL:借引擎那一个(iOS 只给一页一个全屏上下文),接口和屋子一样
 * update / render / resize / dispose,引擎分不出来谁是谁。
 *
 * 走路那套按的是 FPS 游戏的老规矩:固定步长积分(1/120 秒),胶囊贴着墙滑,
 * 看和走分开 —— 视角不吃走路的加速度,走路不吃视角的抖动。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { makeUniforms, setScene } from './room-surface.js';
import { planTown } from './town-plan.js';
import { buildTown, nearestLights } from './town-build.js';
import { bakeGroundMap, createGround } from './town-ground.js';
import { createAtmosphere } from './room-atmos.js';
import { envAt } from './room-sky.js';
import { kelvin } from './room-styles.js';

const D2R = Math.PI / 180;
const EYE = 1.65, R_BODY = 0.35;
const WALK = 4.3, SPRINT = 6.5, GRAV = 28, JUMP_V = 8.4;
const STEP = 1 / 120;

/* 发光点:窗、灯、门幕、光尘。和屋里那一层同一个形状的柔光点,只是种类少。
   kind 1 夜里才亮 · 2 一直亮 · 4 飘着的光尘 */
const GLOW_VS = `
attribute vec3 aColor; attribute float aSize, aPhase, aTwk, aKind;
uniform float uTime, uPx, uNight, uFogA, uFogB;
uniform vec3 uFogAway;
varying vec3 vC; varying float vA;
void main(){
  vec3 p = position;
  float tw = aTwk, fade = 1.0;
  if (aKind > 3.5) {                       // 光尘:慢慢往上飘,一轮 90 秒
    float u = fract(aPhase * 7.13 + uTime * 0.011);
    p.y += u * aTwk;
    p.x += sin(uTime * 0.23 + aPhase * 40.0) * 0.3;
    p.z += cos(uTime * 0.19 + aPhase * 31.0) * 0.3;
    fade = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.75, 1.0, u));
    tw = 0.5;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(aSize * uPx / max(0.2, d), 1.0, 48.0);
  float on = aKind < 1.5 ? uNight : aKind < 2.5 ? mix(0.45, 1.0, uNight) : mix(0.7, 1.0, uNight);
  vA = on * fade * mix(1.0, 0.72 + 0.28 * sin(uTime * 1.9 + aPhase * 19.0), tw);
  // 远处的光被空气吃掉一点(和面那边同一条雾)
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  vA *= (1.0 - 0.6 * fd) * smoothstep(0.5, 2.0, d);
  vC = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float core = exp(-r2 * 48.0), halo = exp(-r2 * 8.0) * 0.4;
  gl_FragColor = vec4(vC * (core + halo) * (1.0 - smoothstep(0.15, 0.25, r2)) * 0.62 * vA, 1.0);
}`;

/* 镇上的人:一个人 48 颗点摆成的小人,走路的摆动全在顶点着色器里算 —— 一次 draw call
   画完所有人。aOff 是这颗点在小人身上的位置,aPart 说它属于哪个部位(腿会甩,头不会)。 */
const PEER_VS = `
attribute vec3 aOff; attribute float aPart, aIdx;
uniform float uTime, uPx;
uniform vec4 uPeer[24];        // x, z, yaw, 走多快
uniform vec3 uPeerC[24];
varying vec3 vC; varying float vA;
void main(){
  int i = int(aIdx);
  vec4 P = uPeer[0]; vec3 C = uPeerC[0];
  for (int k = 0; k < 24; k++) if (k == i) { P = uPeer[k]; C = uPeerC[k]; }
  if (P.w < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  vec3 o = aOff;
  float ph = uTime * (1.6 + P.w * 0.7);
  float sw = sin(ph) * min(1.0, P.w / 3.0);
  if (aPart > 2.5) o.z += sw * 0.34 * sign(o.x + 0.001);        // 腿
  else if (aPart > 1.5) o.z -= sw * 0.28 * sign(o.x + 0.001);   // 手臂
  o.y += sin(ph * 2.0) * 0.02 * min(1.0, P.w / 3.0);            // 上下颠
  float cs = cos(P.z), sn = sin(P.z);
  vec3 w = vec3(P.x + o.x * cs - o.z * sn, o.y, P.y + o.x * sn + o.z * cs);
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(0.085 * uPx / max(0.3, d), 1.0, 28.0);
  vA = smoothstep(0.6, 2.0, d) * (1.0 - smoothstep(90.0, 120.0, d));
  vC = C;
  gl_Position = projectionMatrix * mv;
}`;

/* 空气:几千颗很大很淡的点,在人周围一个盒子里循环。加色、几乎透明 —— 远处的灯和墙
   因此"隔着空气"看,这是最便宜的体积感(研究里排第一的那条:带太阳色的雾)。 */
const HAZE_VS = `
attribute float aI;
uniform float uPx, uTime, uNight;
uniform vec3 uCam, uFogAway, uFogSun, uSunDir;
varying vec3 vC; varying float vA;
float h1f(float i, float k){ return fract(sin(i * k) * 43758.5453); }
void main(){
  float a = h1f(aI, 12.9898), b = h1f(aI, 78.233), c = h1f(aI, 37.719);
  vec3 box = vec3(170.0, 26.0, 170.0);
  vec3 p;
  p.x = mod(a * box.x + uTime * 0.35 - uCam.x + box.x * 0.5, box.x) - box.x * 0.5 + uCam.x;
  p.z = mod(c * box.z + uTime * 0.12 - uCam.z + box.z * 0.5, box.z) - box.z * 0.5 + uCam.z;
  p.y = 0.8 + b * b * box.y;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp((3.0 + a * 5.0) * uPx / max(1.0, d), 2.0, 150.0);
  vA = (0.03 + 0.028 * b) * smoothstep(6.0, 30.0, d) * (1.0 - smoothstep(120.0, 175.0, d));
  float s = pow(max(dot(normalize(p - uCam), uSunDir), 0.0), 6.0);
  vC = mix(uFogAway, uFogSun, s) * mix(0.55, 0.4, uNight);
  gl_Position = projectionMatrix * mv;
}`;
const HAZE_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vC * exp(-r2 * 7.0) * vA, 1.0);
}`;

/* 最后一道:暗角 + 一点点抖动。抖动是给渐变用的 —— 天空和雾在 8 位色里会出现一圈圈色阶。 */
const GRADE = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.55 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 q = vUv - 0.5;
      c *= 1.0 - clamp(dot(q, q) * uVig, 0.0, 0.55);
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      c += (1.0 / 255.0) * n - (0.5 / 255.0);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

const CSS = `
.town-lbl{position:absolute;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;z-index:2;
  font:650 12px/1.25 -apple-system,BlinkMacSystemFont,sans-serif;color:#eaf4ff;text-shadow:0 2px 10px rgba(0,0,0,.8)}
.town-lbl small{display:block;font-weight:500;font-size:10px;opacity:.6}
.town-name{position:absolute;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;z-index:3;
  font:650 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;background:rgba(10,14,22,.62);
  border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:2px 9px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.town-door{position:absolute;left:50%;bottom:calc(86px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:5;
  font:650 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#0b0f14;background:#c9f03d;border:0;border-radius:999px;
  padding:10px 16px;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer}
.town-joy{position:absolute;left:22px;bottom:calc(22px + env(safe-area-inset-bottom,0px));width:112px;height:112px;border-radius:50%;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);touch-action:none;z-index:4}
.town-joy i{position:absolute;left:36px;top:36px;width:40px;height:40px;border-radius:50%;background:rgba(201,240,61,.5)}
.town-cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;
  background:rgba(255,255,255,.55);pointer-events:none;z-index:4}
.town-hint{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:4;pointer-events:none;
  font:500 11px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;color:rgba(235,245,255,.72);text-shadow:0 1px 6px rgba(0,0,0,.7)}`;
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('town-scene-css')) return;
  const s = document.createElement('style');
  s.id = 'town-scene-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/** 一个小人的 48 颗点:头 8、身子 16、两条胳膊各 6、两条腿各 6。 */
function peerPoints() {
  const P = [];
  const put = (x, y, z, part) => P.push([x, y, z, part]);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; put(Math.cos(a) * 0.1, 1.62 + Math.sin(a) * 0.08, Math.sin(a) * 0.08, 0); }
  for (let i = 0; i < 16; i++) { const t = i / 16; put((i % 2 ? 0.12 : -0.12), 0.95 + t * 0.55, 0, 1); }
  for (const s of [-1, 1]) for (let i = 0; i < 6; i++) { const t = i / 6; put(s * (0.2 + t * 0.06), 1.42 - t * 0.5, 0, 2); }
  for (const s of [-1, 1]) for (let i = 0; i < 6; i++) { const t = i / 6; put(s * 0.09, 0.92 - t * 0.82, 0, 3); }
  return P;
}

/**
 * 盖起小镇,交回一个能走的场景。
 *
 * @param {THREE.WebGLRenderer} renderer 借来的
 * @param {Array} projects 广场上的项目(每个是镇上的一栋房子)
 * @param {object} [opts]
 *   host / input   标签和摇杆挂在哪、手势听谁(默认 body / 画布)
 *   budget 0.25–1 · seed · hour/weather/season(外面是什么天,见 room-sky.js)
 *   onEnter(project)  走进了一栋房子的门
 *   onNear(project|null) 站到了谁的门口(宿主拿去显示提示)
 *   onMove(x, z, yaw)   人走了(拿去广播给镇上其他人)
 *   words 翻好的词
 */
export function createTown(renderer, projects, opts = {}) {
  injectCss();
  const B = Math.max(0.25, Math.min(1, +opts.budget || 1));
  const host = opts.host || document.body;
  const input = opts.input || renderer.domElement;
  const w = Object.assign({ town_enter: 'Enter', town_hint: 'drag to look · WASD to walk · tap a door to go in' }, opts.words || {});
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const plan = planTown(projects || [], { seed: opts.seed || 'terse-town' });
  const U = makeUniforms();
  U.uForm.value = 0;
  /* 小镇的点要**小、细、柔**:屋里一颗点几乎盖住点距(墙是实的),镇上是几百米的尺度,
     照屋里那样画,近处一颗点就是一颗塑料珠子。这里把点缩到点距的六成、最多 13 个像素,
     并且去掉那圈"球面"的明暗 —— 一颗点是一小团化开的光,不是一颗珠子。
     ⚠ 盖住多少 = (点/点距)²,和远近无关:0.6 只盖住三成半,墙就是透的(房子成了一团雾);
     0.85 盖住七成,是"看得见颗粒的实面"。近处靠像素上限收住,于是近看是细沙,不是珠子。 */
  U.uDotK.value = 0.85; U.uDotMax.value = 15; U.uSoft.value = 1;
  U.uBreath.value = 0.035;    // 整座镇子极慢地呼吸(几厘米)
  /* ⚠ 抽稀的三档距离本来是给屋子定的(7/14/28 米):在小镇上,过了第二栋房子就只剩
     六十四分之一的点 —— 整座镇子于是"看上去是空的"。镇子的尺度要按镇子来。 */
  U.uLod.value.set(45, 100, 200);

  /* 发光点:盖房子的时候一颗颗攒起来 */
  const MAXL = Math.round(150000 * B) + 20000;
  const gPos = new Float32Array(MAXL * 3), gCol = new Float32Array(MAXL * 3), gSiz = new Float32Array(MAXL);
  const gPha = new Float32Array(MAXL), gTwk = new Float32Array(MAXL), gKnd = new Float32Array(MAXL);
  let NG = 0;
  const G = (x, y, z, c, size, tw, kind) => {
    if (NG >= MAXL) return;
    const i = NG++;
    gPos[i * 3] = x; gPos[i * 3 + 1] = y; gPos[i * 3 + 2] = z;
    gCol[i * 3] = c[0]; gCol[i * 3 + 1] = c[1]; gCol[i * 3 + 2] = c[2];
    gSiz[i] = size; gPha[i] = (Math.imul(i, 2654435761) >>> 0) / 4294967296; gTwk[i] = tw; gKnd[i] = kind;
  };

  /* 两份镇子:远处那份很粗(所有房子、广场、公园、路灯),近处那份很细(最近十几栋)。
     一份画不出来 —— 全镇都按近处的细度是四千万颗点(实测 29M 就掉到 6 fps),
     全按远处的粗度,走到跟前一颗点半米宽。uCull 让两份各画各的一半。 */
  /* ⚠ 真正的限制不是总点数,是**近处画出来的点数**:远处那些被片级抽稀早早扔掉了,
     近处这些每一颗都要走完整个顶点着色器、还要填像素。实测近处 5M 颗 = 19 fps,
     1M 颗 = 60 fps。所以细的那份只给最近的十来栋,半径也收在二十几米。 */
  /* ⚠ 瓶颈是**每帧跑过的顶点数**,不是像素:把画布缩到一半,帧率纹丝不动(9 → 12),
     因为每一颗点都要走一遍顶点着色器,哪怕它随后就被抽稀、被 uCull 扔掉。
     所以远处那份要尽量少 —— 它反正也只是远景。 */
  const R_FINE = 22;
  const FINE_SP = opts.fineSpacing || (B >= 0.9 ? 0.15 : B >= 0.6 ? 0.18 : 0.22);
  const FINE_N = B >= 0.9 ? 6 : 5;
  const built = buildTown(plan, { budget: B, uniforms: U, G, seed: opts.seed || '', spacing: opts.spacing || (B >= 0.9 ? 0.3 : 0.4) });
  const { S, lights, blocks, doors, labels } = built;
  U.uCull.value.set(1, R_FINE);            // 粗的那份:只画 30 米以外

  /* ── 天、太阳、雾 ── */
  let timeMode = opts.time === 'day' || opts.time === 'night' ? opts.time : 'auto';
  const envNow = () => envAt(new Date(), {
    seed: opts.seed || '', weather: opts.weather, season: opts.season,
    hour: timeMode === 'day' ? 12.5 : timeMode === 'night' ? 22.5 : opts.hour,
  });
  let env = envNow();
  const sunDir = new THREE.Vector3();
  function applyEnv() {
    const fx = env.fx;
    // 露天:太阳就按真实的高度和方位走(屋里那边才需要把光摆到主案那一侧)
    const el = Math.max(2, env.sunEl) * D2R, az = env.sunAz * D2R;
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    U.uSunDir.value.copy(sunDir);
    const sk = kelvin(5200 + (2400 - 5200) * env.golden), sI = 2.1 * (1 - 0.72 * fx.cover) * (1 - 0.2 * env.golden);
    U.uSunCol.value.set(sk[0] * sI, sk[1] * sI, sk[2] * sI);
    const lin = (c) => c.map((v) => Math.pow(v, 2.2));
    const zen = lin(env.zen), hor = lin(env.hor);
    const f = 2.6 * (1 + 0.3 * fx.cover);         // 天光:白天房子要和天有得比,不然只剩剪影
    U.uSky.value.set(zen[0] * f, zen[1] * f, zen[2] * f);
    U.uGround.value.set(hor[0] * 0.55, hor[1] * 0.55, hor[2] * 0.55);
    U.uFogAway.value.set(env.hor[0] * 0.72, env.hor[1] * 0.72, env.hor[2] * 0.72);
    U.uFogSun.value.set(env.glow[0] * 0.95, env.glow[1] * 0.95, env.glow[2] * 0.95);
    // 小镇比屋子大一个量级:雾要淡得多,不然一百米外全白
    U.uFogA.value = 0.0013 * (1 + 5.5 * fx.fog) * (1 + 0.7 * fx.cover);
    U.uFogB.value = 0.045;
    U.uNight.value = env.night;
    U.uExposure.value = 1.75 - 0.55 * env.night;   // 白天要压得住天:房子暗、天亮,看过去就只剩一片麻点
    U.uSat.value = 1.25;
    U.uRim.value.set(env.glow[0] * 0.95, env.glow[1] * 0.95, env.glow[2] * 0.95);
    U.uRimNight.value.set(0.16, 0.18, 0.28);
    U.uMoon.value.set(0.1, 0.115, 0.2);   // 夜里房子还看得出轮廓,不是全黑
    U.uShadowTint.value.set(0.78, 0.82, 1);
    U.uKeyK.value = 0.26;
    U.uDayGlow.value = 0.35;
    // 白天 0.35/1.0、黄昏 0.65/0.75、夜里 0.9/0.55 —— 亮的那一小撮才该晕开
    // 黄昏最容易糊:阈值抬高、强度收住,只有真正最亮的那一小撮晕开
    bloom.strength = 0.3 + 0.12 * env.golden + 0.5 * env.night;
    bloom.threshold = 1.0 - 0.1 * env.golden - 0.42 * env.night;
    scene.background.setRGB(env.hor[0] * 0.55, env.hor[1] * 0.55, env.hor[2] * 0.55);
  }

  /* ── 场景 ── */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  const camera = new THREE.PerspectiveCamera(72, 1, 0.08, 900);
  const group = S.build(U);
  scene.add(group);
  /* 地面:一圈跟着人走的点,查一张烤好的俯视图(街、广场、公园、房子底下)。
     脚下永远是细的,远处自己疏掉 —— 固定的地面几何在小镇这个尺度上是几千万颗点。 */
  const ground = createGround(U, bakeGroundMap(plan), { budget: B, count: 170000, far: Math.max(240, plan.radius * 1.9) });
  scene.add(ground.points);

  /* 近处那十几栋的细版本:走远了就换一批(哪几栋变了才重建 —— 不然每走一步都在盖房子) */
  let fine = null, fineAt = null;
  function refreshFine(x, z) {
    const ids = plan.plots
      .map((p) => ({ id: p.id, d: Math.hypot(p.cx - x, p.cz - z) }))
      .sort((a, b) => a.d - b.d).slice(0, FINE_N).filter((q) => q.d < R_FINE + 40).map((q) => q.id);
    const key = ids.join(',');
    if (fine && fine.key === key) return;
    const Uf = Object.assign({}, U, { uCull: { value: new THREE.Vector2(-1, R_FINE) } });
    const b = buildTown(plan, { budget: B, uniforms: Uf, G: () => {}, seed: opts.seed || '', spacing: FINE_SP, only: ids, props: false });
    const g = b.S.build(Uf);
    g.renderOrder = 1;
    scene.add(g);
    if (fine) { scene.remove(fine.group); try { fine.group.userData.dispose(); } catch (e) {} }
    fine = { group: g, key, points: g.userData.points };
  }
  refreshFine(plan.spawn.x, plan.spawn.z);
  fineAt = [plan.spawn.x, plan.spawn.z];

  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute('position', new THREE.BufferAttribute(gPos.subarray(0, NG * 3), 3));
  gGeo.setAttribute('aColor', new THREE.BufferAttribute(gCol.subarray(0, NG * 3), 3));
  gGeo.setAttribute('aSize', new THREE.BufferAttribute(gSiz.subarray(0, NG), 1));
  gGeo.setAttribute('aPhase', new THREE.BufferAttribute(gPha.subarray(0, NG), 1));
  gGeo.setAttribute('aTwk', new THREE.BufferAttribute(gTwk.subarray(0, NG), 1));
  gGeo.setAttribute('aKind', new THREE.BufferAttribute(gKnd.subarray(0, NG), 1));
  const gMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const glow = new THREE.Points(gGeo, gMat);
  glow.frustumCulled = false; glow.renderOrder = 2;
  scene.add(glow);

  const atmos = createAtmosphere({ open: true, windows: [], roofs: [], budget: B, uPx: U.uPx, reduceMotion });
  scene.add(atmos.group);

  const hazeU = { uPx: U.uPx, uTime: U.uTime, uNight: U.uNight, uCam: { value: new THREE.Vector3() },
    uFogAway: U.uFogAway, uFogSun: U.uFogSun, uSunDir: U.uSunDir };
  let haze = null;
  {
    const n = Math.round(2600 * B), idx = new Float32Array(n), pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) idx[i] = i;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aI', new THREE.BufferAttribute(idx, 1));
    const m = new THREE.ShaderMaterial({ uniforms: hazeU, vertexShader: HAZE_VS, fragmentShader: HAZE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    haze = new THREE.Points(g, m);
    haze.frustumCulled = false; haze.renderOrder = 4;
    scene.add(haze);
  }

  /* ── 镇上的人 ── */
  const MAXP = 24;
  const PU = {
    uTime: U.uTime, uPx: U.uPx,
    uPeer: { value: Array.from({ length: MAXP }, () => new THREE.Vector4(0, 0, 0, -1)) },
    uPeerC: { value: Array.from({ length: MAXP }, () => new THREE.Vector3(0.7, 0.9, 1)) },
  };
  const body = peerPoints();
  {
    const n = body.length * MAXP;
    const off = new Float32Array(n * 3), part = new Float32Array(n), idx = new Float32Array(n), pos = new Float32Array(n * 3);
    for (let p = 0; p < MAXP; p++) for (let k = 0; k < body.length; k++) {
      const i = p * body.length + k;
      off[i * 3] = body[k][0]; off[i * 3 + 1] = body[k][1]; off[i * 3 + 2] = body[k][2];
      part[i] = body[k][3]; idx[i] = p;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aOff', new THREE.BufferAttribute(off, 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    g.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
    const m = new THREE.ShaderMaterial({ uniforms: PU, vertexShader: PEER_VS, fragmentShader: GLOW_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false; pts.renderOrder = 3;
    scene.add(pts);
    var peerMat = m, peerGeo = g;
  }
  let peers = [];
  /** 镇上其他人:[{id, name, x, z, yaw, v}]。位置由外面喂进来(见 town 的多人那一半)。 */
  function setPeers(list) {
    peers = (list || []).slice(0, MAXP);
    for (let i = 0; i < MAXP; i++) {
      const p = peers[i];
      if (!p) { PU.uPeer.value[i].set(0, 0, 0, -1); continue; }
      PU.uPeer.value[i].set(p.x, p.z, p.yaw || 0, Math.max(0, p.v || 0));
      const c = p.rgb || [0.62, 0.92, 1];
      PU.uPeerC.value[i].set(c[0], c[1], c[2]);
    }
  }

  /* ── 后期 ── */
  const prevPR = renderer.getPixelRatio(), prevAuto = renderer.autoClear;
  const wantPR = opts.pixelRatio || Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const size0 = renderer.getSize(new THREE.Vector2());
  let W = size0.x || 1, H = size0.y || 1;
  if (wantPR !== prevPR) { renderer.setPixelRatio(wantPR); renderer.setSize(W, H, false); }
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(
    Math.max(1, W * renderer.getPixelRatio()), Math.max(1, H * renderer.getPixelRatio()), { type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.6, 0.6, 0.8);
  composer.addPass(bloom);
  const grade = new ShaderPass(GRADE);
  grade.renderToScreen = true;
  composer.addPass(grade);
  applyEnv();

  /* ── 碰撞:圆(树、灯、长椅)和凸多边形(房子) ───────────────────────────
     格子里放一份索引,走一步只看身边那几个 —— 一百栋房子挨个算是每帧几千次。 */
  const CELL = 16;
  const grid = new Map();
  const key = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
  for (const b of blocks) {
    const r = b.poly ? b.r : b.r;
    for (let x = b.x - r; x <= b.x + r + CELL; x += CELL) for (let z = b.z - r; z <= b.z + r + CELL; z += CELL) {
      const k = key(x, z);
      if (!grid.has(k)) grid.set(k, []);
      if (!grid.get(k).includes(b)) grid.get(k).push(b);
    }
  }
  const near = (x, z) => {
    const out = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = grid.get(Math.floor(x / CELL) + i + ',' + (Math.floor(z / CELL) + j));
      if (l) for (const b of l) if (!out.includes(b)) out.push(b);
    }
    return out;
  };
  /** 点到凸多边形:在里面就推到最近的边上,在外面就看离边有多远。 */
  function pushOutPoly(x, z, poly, r) {
    let inside = true, bestD = 1e9, bx = 0, bz = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
      let t = ((x - a[0]) * ex + (z - a[1]) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a[0] + ex * t, pz = a[1] + ez * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) { bestD = d; bx = px; bz = pz; }
      if ((x - a[0]) * ez - (z - a[1]) * ex > 0) inside = false;     // 逆时针:外侧
    }
    if (!inside && bestD >= r) return null;
    const dx = x - bx, dz = z - bz, L = Math.hypot(dx, dz) || 1;
    const s = inside ? 1 : 1;
    return { x: bx + (dx / L) * r * s, z: bz + (dz / L) * r * s };
  }
  function resolve(x, z) {
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const b of near(x, z)) {
        if (b.poly) {
          const hit = pushOutPoly(x, z, b.poly, R_BODY);
          if (hit) { x = hit.x; z = hit.z; moved = true; }
        } else {
          const dx = x - b.x, dz = z - b.z, d = Math.hypot(dx, dz), rr = b.r + R_BODY;
          if (d < rr) { const L = d || 1; x = b.x + dx / L * rr; z = b.z + dz / L * rr; moved = true; }
        }
      }
      if (!moved) break;
    }
    // 镇子外面走不出去
    const rad = Math.hypot(x, z), lim = plan.radius * 1.5;
    if (rad > lim) { x = x / rad * lim; z = z / rad * lim; }
    return { x, z };
  }

  /* ── 走 ── */
  let px = plan.spawn.x, pz = plan.spawn.z, py = 0, vy = 0, yaw = plan.spawn.yaw || 0, pitch = -0.02;
  let moveX = 0, moveZ = 0, sprint = false, grounded = true, coyote = 0, jumpBuf = 0;
  let t = 0, acc = 0, lastMoveSent = 0, speed = 0;
  const keys = new Set();
  const offs = [];
  const on = (el, ty, fn, o) => { el.addEventListener(ty, fn, o); offs.push(() => el.removeEventListener(ty, fn, o)); };
  const els = [];
  const el = (tag, cls, parent) => { const x = document.createElement(tag); if (cls) x.className = cls; (parent || host).appendChild(x); if (!parent) els.push(x); return x; };

  /* 看:桌面按住拖(点一下锁指针),手机右半边拖 */
  let look = null;
  const LOOK_PX = 0.0022, TOUCH_YAW = 0.20 * D2R, TOUCH_PITCH = 0.14 * D2R;
  on(input, 'pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest('button, .town-joy')) return;
    const r = input.getBoundingClientRect();
    if (e.pointerType === 'touch' && e.clientX - r.left < r.width * 0.45 && e.clientY - r.top > r.height * 0.45) return; // 左下是摇杆
    look = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    try { input.setPointerCapture(e.pointerId); } catch (err) {}
  });
  on(window, 'pointermove', (e) => {
    if (!look || e.pointerId !== look.id) return;
    const dx = e.clientX - look.x, dy = e.clientY - look.y;
    look.x = e.clientX; look.y = e.clientY; look.moved += Math.abs(dx) + Math.abs(dy);
    const ky = e.pointerType === 'touch' ? TOUCH_YAW : LOOK_PX * 57.3 * D2R;
    const kp = e.pointerType === 'touch' ? TOUCH_PITCH : LOOK_PX * 57.3 * D2R;
    yaw -= dx * ky;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * kp));
  });
  const endLook = (e) => { if (look && e.pointerId === look.id) look = null; };
  on(window, 'pointerup', endLook);
  on(window, 'pointercancel', endLook);
  // 桌面:指针锁定(不锁也能玩,按住拖就是)
  on(input, 'click', () => { if (!('ontouchstart' in window) && input.requestPointerLock && document.pointerLockElement !== input) { try { input.requestPointerLock(); } catch (e) {} } });
  on(document, 'mousemove', (e) => {
    if (document.pointerLockElement !== input) return;
    yaw -= (e.movementX || 0) * LOOK_PX;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - (e.movementY || 0) * LOOK_PX));
  });
  const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  on(window, 'keydown', (e) => {
    if (typing(e)) return;
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === ' ') { jumpBuf = 0.13; e.preventDefault(); }
    if (k === 'e' || k === 'enter') tryEnter();
  });
  on(window, 'keyup', (e) => keys.delete(e.key.toLowerCase()));
  on(window, 'blur', () => { keys.clear(); look = null; });

  /* 摇杆(手机) */
  if (opts.joystick !== false && (typeof window !== 'undefined' && ('ontouchstart' in window || opts.joystick))) {
    const joy = el('div', 'town-joy');
    const stick = el('i', '', joy);
    let jid = null;
    on(joy, 'pointerdown', (e) => { jid = e.pointerId; joy.setPointerCapture(e.pointerId); e.preventDefault(); });
    on(joy, 'pointermove', (e) => {
      if (e.pointerId !== jid) return;
      const b = joy.getBoundingClientRect();
      const jx = Math.max(-1, Math.min(1, (e.clientX - (b.left + b.width / 2)) / (b.width / 2)));
      const jy = Math.max(-1, Math.min(1, (e.clientY - (b.top + b.height / 2)) / (b.height / 2)));
      const m = Math.hypot(jx, jy), dead = 0.15;
      const k = m < dead ? 0 : Math.min(1, (m - dead) / (0.9 - dead)) / (m || 1);
      moveX = jx * k; moveZ = jy * k;
      sprint = m > 0.92;
      stick.style.left = 36 + jx * 26 + 'px'; stick.style.top = 36 + jy * 26 + 'px';
    });
    const off = (e) => { if (e.pointerId === jid) { jid = null; moveX = moveZ = 0; sprint = false; stick.style.left = stick.style.top = '36px'; } };
    on(joy, 'pointerup', off); on(joy, 'pointercancel', off);
  }
  el('div', 'town-cross');
  const hint = el('div', 'town-hint');
  hint.textContent = w.town_hint;
  setTimeout(() => { hint.style.transition = 'opacity .6s'; hint.style.opacity = '0'; }, 6000);

  /* 门口那个按钮 */
  const doorBtn = el('button', 'town-door');
  doorBtn.type = 'button';
  doorBtn.style.display = 'none';
  let nearDoor = null;
  on(doorBtn, 'click', (e) => { e.stopPropagation(); tryEnter(); });
  function tryEnter() {
    if (nearDoor && opts.onEnter) { try { opts.onEnter(nearDoor.project); } catch (err) {} }
  }

  /* 房子的门牌、人的昵称:DOM,只给近处的几个 */
  const layer = el('div', '');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  const lblEls = labels.map(() => { const d = document.createElement('div'); d.className = 'town-lbl'; d.style.display = 'none'; layer.appendChild(d); return d; });
  const nameEls = Array.from({ length: MAXP }, () => { const d = document.createElement('div'); d.className = 'town-name'; d.style.display = 'none'; layer.appendChild(d); return d; });

  const tmp = new THREE.Vector3();
  const rectOf = () => { try { return renderer.domElement.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0, width: W, height: H }; } };
  const hostRect = () => { try { return host.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0 }; } };
  function project(x, y, z) {
    tmp.set(x, y, z).project(camera);
    const r = rectOf(), h = hostRect();
    return { x: r.left - h.left + (tmp.x * 0.5 + 0.5) * (r.width || W), y: r.top - h.top + (-tmp.y * 0.5 + 0.5) * (r.height || H), behind: tmp.z > 1 };
  }

  /* ── 每帧 ── */
  function stepOnce(dt) {
    // 看向哪儿就往哪儿走(看和走分开:视角不吃走路的加速度)
    const kf = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const kr = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const fwd = kf - moveZ, side = kr + moveX;
    const run = sprint || keys.has('shift');
    const want = Math.min(1, Math.hypot(fwd, side));
    const sp = want * (run ? SPRINT : WALK);
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    let dx = 0, dz = 0;
    if (want > 0.001) {
      const nx = (-sin * fwd + cos * side) / (Math.hypot(fwd, side) || 1);
      const nz = (-cos * fwd - sin * side) / (Math.hypot(fwd, side) || 1);
      dx = nx * sp * dt; dz = nz * sp * dt;
    }
    speed += (sp - speed) * (1 - Math.exp(-dt / 0.07));
    const got = resolve(px + dx, pz + dz);
    px = got.x; pz = got.z;
    // 跳:落地前一点按下也算(jump buffer),刚走下台阶也还能跳(coyote)
    jumpBuf = Math.max(0, jumpBuf - dt);
    coyote = grounded ? 0.12 : Math.max(0, coyote - dt);
    if (jumpBuf > 0 && (grounded || coyote > 0)) { vy = JUMP_V; grounded = false; coyote = 0; jumpBuf = 0; }
    vy -= GRAV * dt;
    py += vy * dt;
    if (py <= 0) { py = 0; vy = 0; grounded = true; }
  }

  function update(dt) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    t += dt;
    U.uTime.value = t;
    U.uForm.value = Math.min(1, U.uForm.value + dt / 2.6);
    U.uPx.value = (H * renderer.getPixelRatio() / 2) / Math.tan(camera.fov * Math.PI / 360);
    // 固定步长:跳多高、走多快不许跟着帧率变
    acc = Math.min(0.25, acc + dt);
    while (acc >= STEP) { stepOnce(STEP); acc -= STEP; }
    camera.position.set(px, EYE + py, pz);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    ground.update(camera);
    hazeU.uCam.value.copy(camera.position);
    // 走出十二米就看一眼:近处该细的是不是换了几栋
    if (!fineAt || Math.hypot(px - fineAt[0], pz - fineAt[1]) > 12) { fineAt = [px, pz]; refreshFine(px, pz); }
    atmos.update(dt, t, camera);

    // 身边那 24 盏灯进 uniform(表里放得下的就这么多)
    if (!update._lit || Math.hypot(px - update._lit[0], pz - update._lit[1]) > 8) {
      update._lit = [px, pz];
      setScene(U, { lights: nearestLights(lights, px, pz, 24), rooms: [], feet: [], court: null, rocks: [], windows: [] });
    }
    // 跟着钟走:一分钟看一眼外面
    if (timeMode === 'auto' && opts.hour == null && t - (update._env || 0) > 60) { update._env = t; env = envNow(); applyEnv(); atmos.setEnv(env, sunDir); }

    /* 门口:最近的那扇门 2.6 米以内就可以进去 */
    let best = null, bd = 2.6;
    for (const d of doors) {
      const dd = Math.hypot(px - d.x, pz - d.z);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (best !== nearDoor) {
      nearDoor = best;
      doorBtn.style.display = best ? 'block' : 'none';
      if (best) doorBtn.textContent = w.town_enter + ' ' + (best.title || '');
      if (opts.onNear) { try { opts.onNear(best ? best.project : null); } catch (e) {} }
    }
    /* 走了就告诉外面(10 Hz,没动就不发) */
    if (opts.onMove && t - lastMoveSent > 0.1) {
      lastMoveSent = t;
      if (!update._last || Math.hypot(px - update._last[0], pz - update._last[1]) > 0.02 || Math.abs(yaw - update._last[2]) > 0.035) {
        update._last = [px, pz, yaw];
        try { opts.onMove(px, pz, yaw, speed); } catch (e) {}
      }
    }

    /* 门牌:近处十几块 */
    const r = rectOf();
    let shown = 0;
    labels.forEach((L, i) => {
      const d = Math.hypot(px - L.x, pz - L.z);
      const e = lblEls[i];
      if (d > 85 || shown > 14) { e.style.display = 'none'; return; }
      const s = project(L.x, L.y, L.z);
      if (s.behind || s.x < -80 || s.x > (r.width || W) + 80) { e.style.display = 'none'; return; }
      shown++;
      if (e.dataset.t !== L.text) { e.dataset.t = L.text; e.innerHTML = ''; e.append(L.text); const sm = document.createElement('small'); sm.textContent = L.sub || ''; e.appendChild(sm); }
      e.style.display = 'block';
      e.style.left = s.x + 'px'; e.style.top = s.y + 'px';
      e.style.opacity = String(Math.max(0.25, 1 - d / 95));
    });
    /* 别人头顶的昵称 */
    for (let i = 0; i < MAXP; i++) {
      const p = peers[i], e = nameEls[i];
      if (!p) { e.style.display = 'none'; continue; }
      const s = project(p.x, 1.95, p.z);
      const d = Math.hypot(px - p.x, pz - p.z);
      if (s.behind || d > 60) { e.style.display = 'none'; continue; }
      if (e.textContent !== (p.name || '')) e.textContent = p.name || '';
      e.style.display = 'block';
      e.style.left = s.x + 'px'; e.style.top = s.y + 'px';
      e.style.opacity = String(Math.max(0.3, 1 - d / 70));
    }
  }
  function render() { composer.render(); }
  function resize(w2, h2) {
    W = Math.max(1, w2 | 0); H = Math.max(1, h2 | 0);
    camera.aspect = W / H;
    // 竖屏按横向视野算,不然手机上像从门缝里看
    const hFov = 80 * D2R;
    camera.fov = W < H ? 2 * Math.atan(Math.tan(hFov / 2) / camera.aspect) / D2R : 72;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
  }

  let dead = false;
  function dispose() {
    if (dead) return;
    dead = true;
    for (const f of offs) { try { f(); } catch (e) {} }
    for (const x of els) { try { x.remove(); } catch (e) {} }
    try { layer.remove(); } catch (e) {}
    try { if (document.pointerLockElement === input) document.exitPointerLock(); } catch (e) {}
    try { group.userData.dispose(); if (fine) fine.group.userData.dispose(); gGeo.dispose(); gMat.dispose(); peerGeo.dispose(); peerMat.dispose(); ground.dispose(); } catch (e) {}
    try { atmos.dispose(); bloom.dispose(); grade.dispose(); composer.dispose(); if (haze) { haze.geometry.dispose(); haze.material.dispose(); } } catch (e) {}
    try {
      renderer.setRenderTarget(null); renderer.autoClear = prevAuto;
      if (renderer.getPixelRatio() !== prevPR) { renderer.setPixelRatio(prevPR); renderer.setSize(W, H, false); }
    } catch (e) {}
  }

  atmos.setEnv(env, sunDir);
  resize(W, H);

  return {
    update, render, resize, dispose, setPeers,
    plan, doors, labels, uniforms: U, atmos, bloom, composer,
    env: () => env,
    setTime(mode) { timeMode = mode === 'day' || mode === 'night' ? mode : 'auto'; env = envNow(); applyEnv(); atmos.setEnv(env, sunDir); },
    at(x, z, y, p) { px = x; pz = z; if (y != null) yaw = y; if (p != null) pitch = p; },
    where() { return { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), speed: +speed.toFixed(2) }; },
    near: () => (nearDoor ? nearDoor.project : null),
    particles: () => group.userData.points + NG,
    renderNow() { U.uForm.value = 1; update(0); render(); },
    diag() {
      const gl = renderer.getContext(), bad = [];
      for (const p of renderer.info.programs || []) { const d = p.diagnostics; if (d && !d.runnable) bad.push((p.name || '?') + ': ' + ((d.programLog) || '')); }
      let maxVU = null, gpu = '';
      try { maxVU = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS); gpu = String(gl.getParameter(gl.RENDERER) || ''); } catch (e) {}
      return { bad: bad.join(' | ').slice(0, 500), points: group.userData.points + (fine ? fine.points : 0), coarse: group.userData.points, fine: fine ? fine.points : 0, glow: NG, plots: plan.plots.length, calls: renderer.info.render.calls, maxVU, gpu };
    },
  };
}
