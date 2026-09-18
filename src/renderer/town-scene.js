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
import { buildTown, nearestLights, villaMassing } from './town-build.js';
import { bakeGroundMap, createGround } from './town-ground.js';
import { createAtmosphere } from './room-atmos.js';
import { envAt } from './room-sky.js';
import { kelvin } from './room-styles.js';
import { createNature } from './town-nature.js';
import { createLife } from './town-life.js';
import { createPeople } from './town-people.js';
import { createPets } from './town-pets.js';
import { createPlay } from './town-play-ui.js';

const D2R = Math.PI / 180;
const TOWN_FORM = 60;   // uForm 到这里,1.8 公里以内的点都落定了
const EYE = 1.65, R_BODY = 0.35;
const WALK = 4.3, SPRINT = 6.5, GRAV = 28, JUMP_V = 8.4;
const STEP = 1 / 120;

/* 发光点:窗、灯、门幕、光尘。和屋里那一层同一个形状的柔光点,只是种类少。
   kind 1 夜里才亮 · 2 一直亮 · 4 飘着的光尘 */
const GLOW_VS = `
attribute vec3 aColor; attribute float aSize, aPhase, aTwk, aKind;
uniform float uTime, uPx, uNight, uFogA, uFogB, uLit;
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
  // 夜里窗和灯的光晕大一圈:暖光要"溢"出窗框,才有夜里的氛围
  gl_PointSize = clamp(aSize * (1.0 + 0.45 * uNight) * uPx / max(0.2, d), 1.0, 60.0);
  float on = aKind < 1.5 ? uNight * step(aPhase, uLit) : aKind < 2.5 ? mix(0.45, 1.0, uNight) : mix(0.7, 1.0, uNight);
  vA = on * fade * mix(1.0, 0.72 + 0.28 * sin(uTime * 1.9 + aPhase * 19.0), tw);
  // 远处的光被空气吃掉一点(和面那边同一条雾)
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  // 贴着镜头的灯不画成一大团光斑:近处 4 米内淡出
  vA *= (1.0 - 0.6 * fd) * smoothstep(1.2, 4.0, d);
  vC = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FS = `
precision highp float;
uniform float uNight;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float core = exp(-r2 * 48.0), halo = exp(-r2 * 8.0) * (0.4 + 0.25 * uNight);
  gl_FragColor = vec4(vC * (core + halo) * (1.0 - smoothstep(0.15, 0.25, r2)) * (0.62 + 0.3 * uNight) * vA, 1.0);
}`;

/* 镇上的人:一个人 48 颗点摆成的小人,走路的摆动全在顶点着色器里算 —— 一次 draw call
   画完所有人。aOff 是这颗点在小人身上的位置,aPart 说它属于哪个部位(腿会甩,头不会)。 */
const PEER_VS = `
attribute vec3 aOff; attribute float aPart, aIdx;
uniform float uTime, uPx;
uniform vec4 uPeer[24];        // x, z, yaw, 走多快
uniform vec3 uPeerC[24];
uniform float uPeerE[24];      // 表情:0 没有 · 1 招手 · 2 欢呼 · 3 坐下
varying vec3 vC; varying float vA;
void main(){
  int i = int(aIdx);
  vec4 P = uPeer[0]; vec3 C = uPeerC[0]; float E = uPeerE[0];
  for (int k = 0; k < 24; k++) if (k == i) { P = uPeer[k]; C = uPeerC[k]; E = uPeerE[k]; }
  if (P.w < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  vec3 o = aOff;
  float ph = uTime * (1.6 + P.w * 0.7);
  float sw = sin(ph) * min(1.0, P.w / 3.0);
  if (aPart > 2.5) o.z += sw * 0.34 * sign(o.x + 0.001);        // 腿
  else if (aPart > 1.5) o.z -= sw * 0.28 * sign(o.x + 0.001);   // 手臂
  o.y += sin(ph * 2.0) * 0.02 * min(1.0, P.w / 3.0);            // 上下颠
  /* 表情:招手(右手举起来摇)、欢呼(两只手举起来)、坐下(整个人矮一截) */
  if (E > 0.5 && aPart > 1.5 && aPart < 2.5) {
    if (E < 1.5 && o.x > 0.0) { o.y += 0.42; o.x += 0.12 + sin(uTime * 7.0) * 0.12; }
    else if (E < 2.5) { o.y += 0.46; o.x *= 1.35; }
  }
  if (E > 2.5) { o.y *= 0.62; o.z += 0.12; }
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
  vA = (0.03 + 0.028 * b) * (1.0 + 0.5 * uNight) * smoothstep(6.0, 30.0, d) * (1.0 - smoothstep(120.0, 175.0, d));
  float s = pow(max(dot(normalize(p - uCam), uSunDir), 0.0), 6.0);
  // 夜里空气里带一点月光的蓝紫:远处"隔着夜色"看,而不是一片死黑
  vC = mix(uFogAway, uFogSun, s) * mix(0.55, 0.4, uNight) + vec3(0.05, 0.06, 0.12) * uNight;
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

/* 萤火:夜里才有。人身边一个盒子里几百颗暖色的小光点,各自慢慢绕、一明一灭 ——
   夜里的氛围感大半来自"空气里有东西在发光"。白天整层不画。 */
const FLY_VS = `
attribute float aI;
uniform float uPx, uTime, uNight;
uniform vec3 uCam;
varying vec3 vC; varying float vA;
float h1f(float i, float k){ return fract(sin(i * k) * 43758.5453); }
void main(){
  if (uNight < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  float a = h1f(aI, 12.9898), b = h1f(aI, 78.233), c = h1f(aI, 37.719), e = h1f(aI, 91.17);
  vec3 box = vec3(90.0, 7.0, 90.0);
  float t = uTime * (0.08 + 0.12 * e);
  vec3 p;
  p.x = mod(a * box.x + sin(t + a * 20.0) * 3.0 - uCam.x + box.x * 0.5, box.x) - box.x * 0.5 + uCam.x;
  p.z = mod(c * box.z + cos(t * 0.8 + c * 20.0) * 3.0 - uCam.z + box.z * 0.5, box.z) - box.z * 0.5 + uCam.z;
  p.y = 0.4 + b * box.y + sin(t * 1.7 + e * 30.0) * 0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(0.11 * uPx / max(0.5, d), 1.5, 7.0);
  float blink = pow(0.5 + 0.5 * sin(uTime * (0.6 + e) + a * 50.0), 3.0);
  vA = uNight * blink * smoothstep(2.5, 7.0, d) * (1.0 - smoothstep(35.0, 48.0, d));
  vC = mix(vec3(1.0, 0.78, 0.38), vec3(0.75, 1.0, 0.55), step(0.7, e));
  gl_Position = projectionMatrix * mv;
}`;
const FLY_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vC * (exp(-r2 * 60.0) * 1.1 + exp(-r2 * 10.0) * 0.3) * vA, 1.0);
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
.town-acts{position:absolute;right:12px;bottom:calc(26px + env(safe-area-inset-bottom,0px));z-index:5;display:flex;flex-direction:column;gap:8px}
.town-acts button{width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.16);background:rgba(8,12,18,.62);
  color:#eaf4ff;font-size:19px;line-height:1;cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.town-acts button:active{background:rgba(201,240,61,.28)}
.town-bub{position:absolute;transform:translate(-50%,-100%);pointer-events:none;z-index:4;max-width:200px;white-space:normal;
  font:600 12px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;color:#0b0f14;background:#e8f6ff;border-radius:12px;padding:5px 10px;
  box-shadow:0 4px 14px rgba(0,0,0,.45)}
.town-mine{left:50%;top:auto;bottom:calc(150px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:5}
.town-note{position:absolute;transform:translate(-50%,-100%);pointer-events:none;z-index:3;white-space:nowrap;
  font:600 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#bff4ff;text-shadow:0 2px 8px rgba(0,0,0,.8)}
.town-sheet{position:absolute;right:66px;left:12px;bottom:calc(26px + env(safe-area-inset-bottom,0px));z-index:6;max-width:420px;margin-left:auto}
.town-say{display:flex;gap:6px;background:rgba(8,12,18,.78);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:5px;
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.town-say input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#eaf4ff;font:500 15px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 10px}
.town-say button{width:34px;height:34px;border-radius:50%;border:0;background:#c9f03d;color:#0b0f14;font-weight:700;cursor:pointer}
.town-notes{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.town-notes button{border:1px solid rgba(191,244,255,.3);background:rgba(8,12,18,.78);color:#bff4ff;border-radius:999px;padding:7px 12px;
  font:600 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.town-folk{position:absolute;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;z-index:3;text-align:center;
  font:650 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff6e4;text-shadow:0 1px 6px rgba(0,0,0,.85)}
.town-folk small{display:block;font-weight:500;font-size:10px;opacity:.72}
.town-talk{position:absolute;left:50%;bottom:calc(132px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:5;
  font:650 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff6e4;background:rgba(40,26,14,.82);border:1px solid rgba(255,214,150,.45);
  border-radius:999px;padding:9px 16px;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer}
.town-chat{position:absolute;left:12px;right:12px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:7;max-width:460px;margin:0 auto;
  background:rgba(20,15,11,.9);border:1px solid rgba(255,214,150,.28);border-radius:18px;padding:12px;color:#f4ead8;
  font:500 14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 10px 40px rgba(0,0,0,.5)}
.town-chat header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.town-chat header i{width:30px;height:30px;border-radius:50%;flex:none;box-shadow:0 0 14px currentColor}
.town-chat header b{display:block;font-size:15px}
.town-chat header small{display:block;opacity:.7;font-size:11px}
.town-chat header button{margin-left:auto;background:none;border:0;color:#f4ead8;font-size:20px;cursor:pointer;opacity:.7}
.town-chat .log{max-height:34vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.town-chat .log p{margin:0;padding:7px 11px;border-radius:14px;max-width:86%;white-space:pre-wrap;word-break:break-word}
.town-chat .log .npc{background:rgba(255,226,170,.12);align-self:flex-start}
.town-chat .log .me{background:rgba(201,240,61,.22);align-self:flex-end}
.town-chat .log .sys{opacity:.6;font-size:12px;align-self:center;background:none}
.town-chat form{display:flex;gap:6px}
.town-chat input{flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:999px;color:#fff;
  font:500 15px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;padding:9px 12px;outline:0}
.town-chat form button{border:0;border-radius:999px;background:#e9b25a;color:#1c130a;font-weight:700;padding:0 14px;cursor:pointer}
.town-chat .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.town-chat .chips button{border:1px solid rgba(255,214,150,.3);background:rgba(255,214,150,.08);color:#f4ead8;border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer}
.town-hint{position:absolute;left:50%;top:48px;transform:translateX(-50%);z-index:4;pointer-events:none;
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
  const w = Object.assign({ town_enter: 'Enter', town_hint: 'drag to look · WASD to walk · tap a door to go in',
    town_wave: 'wave', town_cheer: 'cheer', town_sit: 'sit', town_say: 'say something',
    town_lantern: 'light a lantern', town_note: 'leave a note',
    town_talk: 'Talk to', town_ask_house: 'Tell me about your house', town_ask_day: 'What are you doing today?', town_ask_who: 'Who should I meet?',
    town_placeholder: 'Say something…', town_offline: '(they are thinking — try again in a moment)', town_follow: 'Follow me!', town_gift: 'You received' }, opts.words || {});
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 每栋别墅外面多大,由它里面的平面图定(town-build 的 villaMassing):先算好,图纸才知道每块地要多大 */
  const houses = (projects || []).slice(0, 400).map((p) => {
    const m = villaMassing(p);
    return Object.assign({}, p, { massing: m, fw: m.bw, fd: m.bd });
  });
  const feet = houses.map((h) => Math.max(h.fw, h.fd)).sort((a, b) => a - b);
  const spacing = Math.max(20, Math.min(36, (feet[feet.length >> 1] || 16) * 1.15 + 9));
  const plan = planTown(houses, { seed: opts.seed || 'terse-town', spacing });
  const WORLD = plan.world;
  const U = makeUniforms();
  U.uForm.value = 0;
  U.uLit = { value: 1 };          // 窗里的灯亮着几成(按钟)
  let ground = null, nature = null, gridReady = false, atmos = null;
  /* 小镇的点要**小、细、柔**:屋里一颗点几乎盖住点距(墙是实的),镇上是几百米的尺度,
     照屋里那样画,近处一颗点就是一颗塑料珠子。这里把点缩到点距的六成、最多 13 个像素,
     并且去掉那圈"球面"的明暗 —— 一颗点是一小团化开的光,不是一颗珠子。
     ⚠ 盖住多少 = (点/点距)²,和远近无关:0.6 只盖住三成半,墙就是透的(房子成了一团雾);
     0.85 盖住七成,是"看得见颗粒的实面"。近处靠像素上限收住,于是近看是细沙,不是珠子。 */
  /* 盖住多少 = (点/点距)²,和远近无关。远处那份点距粗,就让点铺满(0.8 的盖住率:
     一栋房子是一团实的体块);近处那份点距细,点小一点,看得见颗粒。 */
  U.uDotK.value = 1.85; U.uDotMax.value = 22; U.uSoft.value = 1; U.uFlat.value = 1;
  U.uGrain.value = 1;         // 边上化开的细沙,不是硬边珠子(见 room-surface 的 DOT_FS)
  U.uBreath.value = 0.035;    // 整座镇子极慢地呼吸(几厘米)
  U.uSparkle.value = 0.3;     // 闪得收敛些:几百万颗一起闪是雪花屏
  U.uBackCull.value = 1;      // 人在房子外面:背面的点只会从缝里透出黑来
  /* ⚠ 比这更细的纹样一律画平均色。屋里是 4.5 厘米(砖缝、席纹要看得见);镇上点距
     是它的两三倍,材质自带的细麻点比点还密 —— 每颗点随机采到一个亮或暗,整面墙就是
     一片椒盐。 */
  U.uDetailFw.value = 0.6;
  U.uGlitter.value = 0; U.uGlitterDen.value = 0;
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
  const R_FINE = 15;
  const FINE_SP = opts.fineSpacing || (B >= 0.9 ? 0.08 : B >= 0.6 ? 0.11 : 0.15);
  const FINE_N = B >= 0.9 ? 4 : 3;
  const built = buildTown(plan, { budget: B, uniforms: U, G, seed: opts.seed || '', spacing: opts.spacing || (B >= 0.9 ? 0.3 : 0.4) });
  const { S, lights, blocks, doors, labels } = built;
  const flowers = built.flowers.slice();
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
    /* ⚠ 天光要**去饱和**再用:天顶的蓝在线性空间里蓝通道能到红的五十倍,直接拿来当环境光,
       整座镇子(连地带墙)都是蓝的 —— 白天看上去就是"一片蓝雾里几点白"。 */
    const f = 1.7 * (1 + 0.3 * fx.cover);
    const lum = zen[0] * 0.3 + zen[1] * 0.6 + zen[2] * 0.1;
    U.uSky.value.set((zen[0] * 0.4 + lum * 0.6) * f, (zen[1] * 0.4 + lum * 0.6) * f, (zen[2] * 0.4 + lum * 0.6) * f);
    U.uGround.value.set(hor[0] * 0.55, hor[1] * 0.55, hor[2] * 0.55);
    U.uFogAway.value.set(env.hor[0] * 0.72, env.hor[1] * 0.72, env.hor[2] * 0.72);
    U.uFogSun.value.set(env.glow[0] * 0.95, env.glow[1] * 0.95, env.glow[2] * 0.95);
    // 小镇比屋子大一个量级:雾要淡得多,不然一百米外全白
    U.uFogA.value = 0.0013 * (1 + 5.5 * fx.fog) * (1 + 0.7 * fx.cover);
    U.uFogB.value = 0.045;
    U.uNight.value = env.night;
    /* 白天压住高光。夜里不再往上提:墙是实心的片以后,提起来整座镇子是一片发亮的淡紫,
       窗反倒成了黑洞 —— 夜里该亮的只有窗、灯、门。 */
    U.uExposure.value = 0.9 - 0.03 * env.night;
    U.uSat.value = 1.25;
    /* 轮廓光只在太阳低的时候强:正午打满,整栋房子的边都是粉白的一圈,颜色全被吃掉 */
    const rk = 0.95 * (0.22 + 0.78 * Math.max(0, Math.min(1, (22 - env.sunEl) / 22)));
    U.uRim.value.set(env.glow[0] * rk, env.glow[1] * rk, env.glow[2] * rk);
    /* 夜里:月光把房子的轮廓勾出来(蓝白的边),墙是暗蓝的面 —— 看得清街,又是夜。
       月光本身仍然低于辉光的门槛(0.7),亮起来的只有窗、灯、萤火。 */
    U.uRimNight.value.set(0.12, 0.14, 0.26);
    U.uMoon.value.set(0.085, 0.095, 0.17);
    /* 夜里仍看得出建筑白天的颜色:一层偏暖的中性底光;再加每栋楼都有的"屋里透出来的光"
       (贴着下面几层、往上淡,一块块明暗不同)。远处的房子也亮 —— 不靠最近那 24 盏灯。 */
    U.uNightFill.value.set(0.12, 0.108, 0.095);
    U.uSpill.value.set(0.44, 0.26, 0.11);
    U.uShadowTint.value.set(0.78, 0.82, 1);
    U.uKeyK.value = 0.26;
    U.uDayGlow.value = 0.35;
    // 白天 0.35/1.0、黄昏 0.65/0.75、夜里 0.9/0.55 —— 亮的那一小撮才该晕开
    // 黄昏最容易糊:阈值抬高、强度收住,只有真正最亮的那一小撮晕开
    bloom.strength = 0.3 + 0.12 * env.golden + 0.5 * env.night;
    bloom.threshold = 1.0 - 0.1 * env.golden - 0.3 * env.night;
    scene.background.setRGB(env.hor[0] * 0.55, env.hor[1] * 0.55, env.hor[2] * 0.55);
    /* 季节和天气落到地上、房上、树上:雪积在朝上的面,雨把街打湿,庄稼跟着季节长 */
    const snowing = env.weather === 'snow' ? 1 : 0;
    const snowCov = snowing ? 0.9 : env.season === 'winter' ? 0.35 : 0;
    U.uSnowCov.value = snowCov;
    if (ground) {
      const GU = ground.uniforms;
      GU.uSnowG.value = snowCov;
      GU.uWet.value = fx.rain > 0.3 ? 0.85 : env.weather === 'fog' || env.weather === 'overcast' ? 0.2 : 0;
      GU.uCrop.value = { spring: 0.35, summer: 1, autumn: 0.6, winter: 0.05 }[env.season] || 0.8;
      GU.uWind.value = fx.wind || 0.2;
      GU.uZen.value.set(zen[0], zen[1], zen[2]);
      if (ground.season !== env.season) { ground.season = env.season; ground.setMap(bakeGroundMap(plan, 0, env.season)); }
    }
    if (nature) nature.setEnv(env);
    // 天穹:院子里压到四成(怕盖过屋子),镇上白天要亮 —— 正午的天是 #8FC3EA,不是深蓝
    // 夜里天穹不压那么狠:星星、银河、月亮要看得见
    if (atmos) atmos.uniforms.uGain.value = 0.42 + 0.46 * (1 - env.night) * (1 - 0.35 * fx.cover) + 0.3 * env.night * (1 - fx.cover);
    /* 窗里的灯:天黑以后亮,夜深了一盏盏熄 —— 22 点以后只剩一小半,凌晨两点只剩几盏 */
    const hh = env.hour;
    U.uLit.value = hh >= 22 || hh < 5 ? (hh >= 22 ? 1 - (hh - 22) * 0.2 : hh < 2 ? 0.55 - hh * 0.15 : 0.12 + (hh - 2) * 0.03) : 1;
  }

  /* ── 场景 ── */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  const camera = new THREE.PerspectiveCamera(72, 1, 0.08, 900);
  const group = S.build(U);
  scene.add(group);
  // 城墙、城门、集市、老房子:一直画(不分远近那两份)
  const landU = Object.assign({}, U, { uCull: { value: new THREE.Vector2(0, 0) }, uDotK: { value: 1.6 }, uDotMax: { value: 26 } });
  const landGroup = built.SL ? built.SL.build(landU) : null;
  if (landGroup) scene.add(landGroup);
  /* 地面:一圈跟着人走的点,查一张烤好的俯视图(街、广场、公园、房子底下)。
     脚下永远是细的,远处自己疏掉 —— 固定的地面几何在小镇这个尺度上是几千万颗点。 */
  const env0 = envNow();
  ground = createGround(U, bakeGroundMap(plan, 0, env0.season), { budget: B, count: 190000, far: WORLD ? WORLD.forest.r1 + 20 : Math.max(240, plan.radius * 1.9) });
  ground.season = env0.season;
  scene.add(ground.points);

  /* 近处那十几栋的细版本:走远了就换一批(哪几栋变了才重建 —— 不然每走一步都在盖房子) */
  let fine = null, fineAt = null;
  function refreshFine(x, z) {
    const ids = plan.plots
      .map((p) => ({ id: p.id, d: Math.hypot(p.cx - x, p.cz - z) }))
      .sort((a, b) => a.d - b.d).slice(0, FINE_N).filter((q) => q.d < R_FINE + 40).map((q) => q.id);
    const key = ids.join(',');
    if (fine && fine.key === key) return;
    // 近处那份:点距只有八厘米,点比点距小 —— 贴着墙走是细沙,不是一颗颗珠子
    const Uf = Object.assign({}, U, {
      uCull: { value: new THREE.Vector2(-1, R_FINE) },
      uDotK: { value: 1.6 }, uDotMax: { value: 26 },
    });
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

  const NFLY = Math.round(700 * B);
  const flyGeo = new THREE.BufferGeometry();
  const flyI = new Float32Array(NFLY);
  for (let i = 0; i < NFLY; i++) flyI[i] = i + 1;
  flyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NFLY * 3), 3));
  flyGeo.setAttribute('aI', new THREE.BufferAttribute(flyI, 1));
  const flyMat = new THREE.ShaderMaterial({ uniforms: { uPx: U.uPx, uTime: U.uTime, uNight: U.uNight, uCam: { value: new THREE.Vector3() } },
    vertexShader: FLY_VS, fragmentShader: FLY_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const flies = new THREE.Points(flyGeo, flyMat);
  flies.frustumCulled = false; flies.renderOrder = 3;
  scene.add(flies);

  atmos = createAtmosphere({ open: true, windows: [], roofs: [], budget: B, uPx: U.uPx, reduceMotion, cloudDot: 0.3 });
  scene.add(atmos.group);

  /* 树、烟、风车水车、旗子和晾的布 */
  nature = createNature(U, plan, built, { budget: B });
  scene.add(nature.group);
  for (const f of nature.flowers) flowers.push(f);
  /* 动物:牛羊鸡鸭、猫狗、鸟、蜂蝶、蝙蝠、狐狸兔子…… */
  const life = createLife(plan, U, { budget: B, seed: opts.seed || 'terse-town', perches: built.perches, lamps: built.lamps, flowers,
    resolve: (x, z, r) => (gridReady ? resolve(x, z, r) : { x, z }) });
  scene.add(life.group);
  /* 人:每栋别墅的主人,和别的玩家 */
  const people = createPeople(U, plan, built, houses, { budget: B, lang: opts.lang, resolve: (x, z, r) => (gridReady ? resolve(x, z, r) : { x, z }) });
  scene.add(people.group);
  /* agent 的小伙伴:自己一只,在场的每个人各一只(长相由身份哈希推出来,不走网络) */
  const pets = createPets(U, { identity: opts.identity || 'me', budget: B, onMine: opts.onPetInfo,
    resolve: (x, z, r) => (gridReady ? resolve(x, z, r) : { x, z }) });
  scene.add(pets.group);

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
    uPeerE: { value: new Array(MAXP).fill(0) },
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
    // 老的 48 颗点小人不再画:别的玩家和镇上的人用同一个模板(town-people),也一样泛着光
    var peerMat = m, peerGeo = g;
  }
  /* 镇上留下的东西:一盏灯、一张字条(api/town.js 存着,谁都看得见)。
     没人在线的时候,镇子靠这些不空 —— 走过一条街,看得出有人来过。 */
  let marks = [], markPts = null;
  function setMarks(list) {
    marks = (list || []).slice(0, 400);
    if (markPts) { scene.remove(markPts); markPts.geometry.dispose(); markPts.material.dispose(); markPts = null; }
    if (!marks.length) return;
    const pos = [], col = [], siz = [], pha = [], twk = [], knd = [];
    const push = (x, y, z, c, sz, tw, k) => {
      pos.push(x, y, z); col.push(c[0], c[1], c[2]); siz.push(sz);
      pha.push((Math.imul(pos.length, 2654435761) >>> 0) / 4294967296); twk.push(tw); knd.push(k);
    };
    for (const m of marks) {
      const x = +m.x, z = +m.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (m.kind === 'note') {
        // 字条:地上一小片淡青的光,走近了才看得清写的是什么(DOM 标签)
        for (let i = 0; i < 26; i++) {
          const a = i / 26 * Math.PI * 2;
          push(x + Math.cos(a) * 0.32, 0.06 + (i % 3) * 0.02, z + Math.sin(a) * 0.32, [0.55, 0.9, 0.95], 0.07, 0.6, 2);
        }
      } else {
        // 灯:一根细杆 + 顶上一团暖光
        for (let i = 0; i < 10; i++) push(x, 0.1 + i * 0.09, z, [0.5, 0.42, 0.3], 0.05, 0.2, 2);
        for (let i = 0; i < 26; i++) {
          push(x + (Math.random() - 0.5) * 0.22, 1.05 + (Math.random() - 0.5) * 0.2, z + (Math.random() - 0.5) * 0.22,
            [1, 0.82, 0.5], 0.1, 0.5, 2);
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(siz, 1));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(pha, 1));
    g.setAttribute('aTwk', new THREE.Float32BufferAttribute(twk, 1));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(knd, 1));
    const m2 = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    markPts = new THREE.Points(g, m2);
    markPts.frustumCulled = false; markPts.renderOrder = 2;
    scene.add(markPts);
  }

  let peers = [];
  /** 镇上其他人:[{id, name, x, z, yaw, v}]。位置由外面喂进来(见 town 的多人那一半)。 */
  function setPeers(list) {
    peers = (list || []).slice(0, MAXP);
    people.setPeers(peers);
    pets.setPeers(peers);
    for (let i = 0; i < MAXP; i++) {
      const p = peers[i];
      if (!p) { PU.uPeer.value[i].set(0, 0, 0, -1); continue; }
      PU.uPeer.value[i].set(p.x, p.z, p.yaw || 0, Math.max(0, p.v || 0));
      const c = p.rgb || [0.62, 0.92, 1];
      PU.uPeerC.value[i].set(c[0], c[1], c[2]);
      PU.uPeerE.value[i] = +p.e || 0;
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
  gridReady = true;
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
  function resolve(x, z, rb = R_BODY) {
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const b of near(x, z)) {
        if (b.poly) {
          const hit = pushOutPoly(x, z, b.poly, rb);
          if (hit) { x = hit.x; z = hit.z; moved = true; }
        } else {
          const dx = x - b.x, dz = z - b.z, d = Math.hypot(dx, dz), rr = b.r + rb;
          if (d < rr) { const L = d || 1; x = b.x + dx / L * rr; z = b.z + dz / L * rr; moved = true; }
        }
      }
      if (!moved) break;
    }
    /* 护城河:只有桥上走得过去(门的中线两边 3.4 米) */
    if (WORLD) {
      const rr0 = Math.hypot(x, z);
      if (rr0 > WORLD.moat.r0 - 0.2 && rr0 < WORLD.moat.r1 + 0.2) {
        const onBridge = WORLD.wall.gates.some((G0) => {
          const ux = Math.cos(G0.a), uz = Math.sin(G0.a);
          return x * ux + z * uz > 0 && Math.abs(-x * uz + z * ux) < 2.6;
        });
        if (!onBridge) {
          const mid = (WORLD.moat.r0 + WORLD.moat.r1) / 2, to = rr0 < mid ? WORLD.moat.r0 - 0.25 : WORLD.moat.r1 + 0.25;
          x = x / rr0 * to; z = z / rr0 * to;
        }
      }
    }
    // 镇子外面走不出去(林子深处)
    const rad = Math.hypot(x, z), lim = WORLD ? WORLD.forest.r0 + 45 : plan.radius * 1.5;
    if (rad > lim) { x = x / rad * lim; z = z / rad * lim; }
    return { x, z };
  }

  /* ── 走 ── */
  let px = plan.spawn.x, pz = plan.spawn.z, py = 0, vy = 0, yaw = plan.spawn.yaw || 0, pitch = -0.02;
  let moveX = 0, moveZ = 0, sprint = false, grounded = true, coyote = 0, jumpBuf = 0;
  let t = 0, acc = 0, lastMoveSent = 0, speed = 0;
  const keys = new Set();
  const noteText = (n) => (opts.noteWords && opts.noteWords[n]) || n;
  const offs = [];
  const on = (el, ty, fn, o) => { el.addEventListener(ty, fn, o); offs.push(() => el.removeEventListener(ty, fn, o)); };
  const els = [];
  const el = (tag, cls, parent) => { const x = document.createElement(tag); if (cls) x.className = cls; (parent || host).appendChild(x); if (!parent) els.push(x); return x; };

  /* 看:桌面按住拖(点一下锁指针),手机右半边拖 */
  let look = null;
  const LOOK_PX = 0.0022, TOUCH_YAW = 0.20 * D2R, TOUCH_PITCH = 0.14 * D2R;
  on(input, 'pointerdown', (e) => {
    if (e.target && e.target.closest && e.target.closest('button, .town-joy, .town-sheet')) return;
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
  on(input, 'click', (e) => { if (e.target && e.target.closest && e.target.closest('button, .town-sheet')) return; if (!('ontouchstart' in window) && input.requestPointerLock && document.pointerLockElement !== input) { try { input.requestPointerLock(); } catch (e) {} } });
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
    if (k === 't' && !e.repeat) petTalk();
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
    if (nearDoor) { try { play.event({ type: 'enter', villa: String(nearDoor.project.id) }); } catch (err) {} }
    if (nearDoor && opts.onEnter) { try { opts.onEnter(nearDoor.project); } catch (err) {} }
  }

  /* ── agent 小伙伴:按 T ──
     自己那只在身边 → 跟它说话(宿主开对话窗;⚠ 对话内容不进这一页,这一页只知道"要说话了")。
     别人的那只在身边 → 让两只认识(宿主去发邀请、开一个两人的房间)。 */
  const PET_REACH = 3.5;
  const PET_BODY_Y = 0.45;   // 小伙伴身子中间多高:拖文件对准的是这里,报给宿主的位置也是这里(两处不一样,丢的时候就会挑错)
  /** 伸手够得着的那一只:看着谁、离谁近就是谁。⚠ 不能"自己那只优先" —— 它永远跟在你身后
      1.8 米,在够得着的范围里,那样走到别人的小伙伴跟前按 T 永远只会叫到自己那只。
      自己那只在身后(不加分),回头看它才轮到它。 */
  function petInReach() {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let best = null, bs = Infinity;
    for (const q of pets.all()) {
      const dx = q.x - px, dz = q.z - pz, d = Math.hypot(dx, dz);
      if (d >= PET_REACH) continue;
      const facing = d > 0.01 ? Math.max(0, (dx * fx + dz * fz) / d) : 0;
      const score = d - 1.6 * facing;
      if (score < bs) { bs = score; best = q; }
    }
    return best;
  }
  function petTalk() {
    const q = petInReach(), mine = pets.mine();
    if (!q) return;
    if (q === mine) {
      if (opts.onPetTalk) { try { opts.onPetTalk({ name: mine.name, breed: mine.breed }); } catch (err) {} }
      return;
    }
    if (opts.onPetMeet) {
      const owner = peers.find((p) => p.id === q.key);
      try { opts.onPetMeet({ id: q.key, pet: q.name, breed: q.breed, owner: owner ? owner.name : '' }); } catch (err) {}
    }
  }
  /** 屏幕上这一点下面是谁(拖文件进来时用):自己的小伙伴、别人的小伙伴、别的人。
      按屏幕距离挑最近的(70 像素内) —— 点云没有实心,射线打不中一只兔子。 */
  function pick(sx, sy) {
    const cand = [];
    const mine = pets.mine();
    for (const q of pets.all()) cand.push({ kind: 'pet', id: q.key, name: q.name, mine: q === mine, x: q.x, y: PET_BODY_Y, z: q.z });
    for (const p of peers) cand.push({ kind: 'person', id: p.id, name: p.name || '', mine: false, x: p.x, y: 1.3, z: p.z });
    let best = null, bd = 70;
    for (const c of cand) {
      if (Math.hypot(c.x - px, c.z - pz) > 40) continue;
      const s2 = project(c.x, c.y, c.z);
      if (s2.behind) continue;
      const d = Math.hypot(s2.x - sx, s2.y - sy);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return null;
    const { x, y, z, ...hit } = best;
    return hit;
  }
  /* 自己那只头顶的提示:走近了告诉你按 T */
  const petTip = el('div', 'town-pet-tip');
  petTip.style.cssText = 'position:absolute;display:none;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;' +
    'font:500 12px/1.2 system-ui,-apple-system,sans-serif;color:#fff;background:rgba(20,22,30,.55);padding:3px 8px;border-radius:999px;backdrop-filter:blur(6px)';

  /* 房子的门牌、人的昵称:DOM,只给近处的几个 */
  const layer = el('div', '');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  const lblEls = labels.map(() => { const d = document.createElement('div'); d.className = 'town-lbl'; d.style.display = 'none'; layer.appendChild(d); return d; });
  const nameEls = Array.from({ length: MAXP }, () => { const d = document.createElement('div'); d.className = 'town-name'; d.style.display = 'none'; layer.appendChild(d); return d; });

  /* 头顶的气泡:说的话飘六秒,不存下来 —— 镇上是路过的闲聊。 */
  const bubbles = new Map();
  const bubEls = Array.from({ length: MAXP }, () => { const d = document.createElement('div'); d.className = 'town-bub'; d.style.display = 'none'; layer.appendChild(d); return d; });
  /* 镇上的人:头顶的名字、气泡;走近了"和他说话" */
  const folkEls = Array.from({ length: 10 }, () => { const d = document.createElement('div'); d.className = 'town-folk'; d.style.display = 'none'; layer.appendChild(d); return d; });
  const folkBub = Array.from({ length: 6 }, () => { const d = document.createElement('div'); d.className = 'town-bub'; d.style.display = 'none'; layer.appendChild(d); return d; });
  const npcSaid = new Map();       // id → {text, until}
  const greeted = new Set();
  const talkBtn = el('button', 'town-talk');
  talkBtn.type = 'button'; talkBtn.style.display = 'none';
  let nearFolk = null, chat = null, nextBark = 8;
  const L = (f) => (opts.lang === 'zh' ? (f.persona.nameZh || f.persona.name) : f.persona.name);
  const tradeOf = (f) => (opts.lang === 'zh' ? f.persona.tradeZh : (f.persona.tradeEn || f.persona.trade));
  const envCtx = () => ({ hour: env.hour, weather: env.weather, season: env.season, day: Math.floor(Date.now() / 86400000) });
  const sayOver = (f, text, secs = 6) => npcSaid.set(f.id, { text: String(text || '').slice(0, 160), until: t + secs });
  on(talkBtn, 'click', (e) => { e.stopPropagation(); if (nearFolk) openChat(nearFolk); });
  function openChat(f) {
    closeChat();
    people.talkTo(f);
    const box = el('div', 'town-chat');
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    const head = el('header', '', box);
    const dot = el('i', '', head);
    const gc = f.persona.look.glow || [1, 1, 1];
    dot.style.color = `rgb(${gc.map((v) => Math.round(v * 255)).join(',')})`;
    dot.style.background = `radial-gradient(circle, rgb(${gc.map((v) => Math.round(v * 255)).join(',')}) 0%, transparent 70%)`;
    const who = el('div', '', head);
    const nb = el('b', '', who); nb.textContent = L(f);
    const sm = el('small', '', who);
    const traits = opts.lang === 'zh' ? (f.persona.traitsZh || f.persona.traits) : f.persona.traits;
    sm.textContent = tradeOf(f) + ' · ' + (f.facts.title || '') + ' · ' + (traits || []).join(opts.lang === 'zh' ? '、' : ', ');
    const x = el('button', '', head); x.type = 'button'; x.textContent = '×';
    on(x, 'click', (e) => { e.stopPropagation(); closeChat(); });
    const log = el('div', 'log', box);
    const chips = el('div', 'chips', box);
    const form = el('form', '', box);
    const inp = el('input', '', form);
    inp.maxLength = 300; inp.placeholder = w.town_placeholder; inp.autocomplete = 'off'; inp.enterKeyHint = 'send';
    const go = el('button', '', form); go.type = 'submit'; go.textContent = '↑';
    const add = (cls, text) => { const q = el('p', cls, log); q.textContent = text; log.scrollTop = log.scrollHeight; return q; };
    chat = { f, box, log, add, busy: false, turns: 0 };
    // 打招呼:先用本地的模板说一句,服务器记得你的话再换成记得你的那一句
    play.event({ type: 'talk', villa: f.id });
    const first = add('npc', people.greetingFor(f, null, envCtx()));
    sayOver(f, first.textContent);
    people.emote(f, 'wave', 2, t);
    if (opts.onNpcHello) {
      Promise.resolve(opts.onNpcHello(f.id, envCtx())).then((r) => {
        if (!chat || chat.f !== f || !r || !r.greeting) return;
        first.textContent = r.greeting;
        sayOver(f, r.greeting);
      }).catch(() => {});
    }
    const send = (text) => {
      text = String(text || '').trim().slice(0, 300);
      if (!text || chat.busy) return;
      add('me', text);
      chat.turns++;
      // 没有服务器(原型页、离线):问房子就照事实介绍,别的随口回一句
      if (!opts.onNpcSay) { const q = add('npc', text === w.town_ask_house ? people.introFor(f) : people.barkFor(f, envCtx())); sayOver(f, q.textContent); return; }
      chat.busy = true;
      const wait = add('npc', '…');
      Promise.resolve(opts.onNpcSay(f.id, text, Object.assign(envCtx(), { place: f.place }))).then((r) => {
        chat && (chat.busy = false);
        if (!r || !r.reply) { wait.textContent = (r && r.error) || w.town_offline; wait.className = 'sys'; return; }
        wait.textContent = r.reply;
        sayOver(f, r.reply, 8);
        for (const tg of r.tags || []) {
          if (tg.type === 'emote') people.emote(f, tg.value, 2.5, t);
          if (tg.type === 'gift') add('sys', w.town_gift + ' ' + tg.value);
          if (tg.type === 'guide') {
            const o = people.guide(f, tg.value);
            if (o) { add('sys', w.town_follow + ' → ' + L(o)); sayOver(f, w.town_follow, 5); }
          }
        }
      }).catch(() => { if (chat) { chat.busy = false; wait.textContent = w.town_offline; wait.className = 'sys'; } });
    };
    for (const q of [w.town_ask_house, w.town_ask_day, w.town_ask_who]) {
      const b = el('button', '', chips); b.type = 'button'; b.textContent = q;
      on(b, 'click', (e) => { e.stopPropagation(); send(q); });
    }
    on(form, 'submit', (e) => { e.preventDefault(); send(inp.value); inp.value = ''; });
    on(inp, 'keydown', (e) => { if (e.key === 'Escape') closeChat(); e.stopPropagation(); });
    on(box, 'pointerdown', (e) => e.stopPropagation());
    talkBtn.style.display = 'none';
  }
  function closeChat() {
    if (!chat) return;
    const c = chat;
    chat = null;
    people.talkTo(null);
    try { c.box.remove(); } catch (e) {}
    if (c.turns && opts.onNpcBye) { try { opts.onNpcBye(c.f.id); } catch (e) {} }
  }
  /** 每帧:谁在附近、谁说话、谁该打招呼 */
  function npcTick(dt) {
    const nf = chat ? null : people.nearest(px, pz, 3.2);
    if (nf !== nearFolk) {
      nearFolk = nf;
      talkBtn.style.display = nf && !chat ? 'block' : 'none';
      if (nf) talkBtn.textContent = w.town_talk + ' ' + L(nf);
      // 头一回走到跟前:他先开口
      if (nf && !greeted.has(nf.id)) { greeted.add(nf.id); sayOver(nf, people.greetingFor(nf, null, envCtx()), 5); people.emote(nf, 'wave', 1.8, t); }
    }
    if (chat && Math.hypot(chat.f.x - px, chat.f.z - pz) > 7) closeChat();
    // 闲聊:隔一会儿,附近随便一个人自言自语一句
    nextBark -= dt;
    if (nextBark < 0) {
      nextBark = 10 + Math.random() * 14;
      const cand = people.folk.filter((f) => f.pose !== 0 && (!chat || chat.f !== f) && Math.hypot(f.x - px, f.z - pz) < 18);
      if (cand.length) { const f = cand[Math.floor(Math.random() * cand.length)]; sayOver(f, people.barkFor(f, envCtx()), 5); }
    }
    // 名字和气泡:最近的几个
    const vis = people.folk.filter((f) => f.pose !== 0).map((f) => ({ f, d: Math.hypot(f.x - px, f.z - pz) }))
      .filter((q) => q.d < 16).sort((a, b) => a.d - b.d);
    let ni = 0, bi = 0;
    for (const { f, d } of vis) {
      const hp = people.headAt(f);
      const sc = project(hp.x, hp.y, hp.z);
      if (sc.behind) continue;
      if (ni < folkEls.length) {
        const e = folkEls[ni++];
        const key = L(f) + '|' + tradeOf(f);
        if (e.dataset.k !== key) { e.dataset.k = key; e.textContent = L(f); const q = document.createElement('small'); q.textContent = tradeOf(f); e.appendChild(q); }
        e.style.display = 'block'; e.style.left = sc.x + 'px'; e.style.top = sc.y + 'px';
        e.style.opacity = String(Math.max(0.35, 1 - d / 16));
      }
      const said = npcSaid.get(f.id);
      if (said && t < said.until && bi < folkBub.length) {
        const sb = project(hp.x, hp.y + 0.45, hp.z);
        const e = folkBub[bi++];
        e.textContent = said.text;
        e.style.display = 'block'; e.style.left = sb.x + 'px'; e.style.top = sb.y + 'px';
      }
    }
    for (let i = ni; i < folkEls.length; i++) folkEls[i].style.display = 'none';
    for (let i = bi; i < folkBub.length; i++) folkBub[i].style.display = 'none';
  }
  /* 能玩的:告示、谜题、钓 bug、卷轴、敲门种树、护照(见 town-play-ui.js) */
  const play = createPlay({
    scene, U, host, el, on, project, plan, built, people, lang: opts.lang, words: opts.words, api: opts.play || null,
    player: () => ({ x: px, z: pz, yaw }),
    env: () => ({ hour: env.hour, weather: env.weather, season: env.season }),
    speak: (f, text) => sayOver(f, text, 3),
    guide: (f) => { greeted.add(f.id); },
  });
  const noteEls = Array.from({ length: 12 }, () => { const d = document.createElement('div'); d.className = 'town-note'; d.style.display = 'none'; layer.appendChild(d); return d; });

  /* 右边一列:招手、欢呼、坐下、说一句、点一盏灯、留一张字条。 */
  let emote = 0, emoteUntil = 0;
  {
    const acts = el('div', 'town-acts');
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      acts.appendChild(b);
      on(b, 'click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    const doEmote = (n) => { emote = n; emoteUntil = n === 3 ? Infinity : t + 3.5; if (n === 1 || n === 2) for (const f of people.folk) if (f.pose !== 0 && Math.hypot(f.x - px, f.z - pz) < 10) people.emote(f, n === 1 ? 'wave' : 'cheer', 2.2, t + Math.random() * 0.6); if (opts.onEmote) { try { opts.onEmote(n); } catch (err) {} } };
    mk('👋', w.town_wave, () => doEmote(1));
    mk('🎉', w.town_cheer, () => doEmote(2));
    mk('🪑', w.town_sit, () => doEmote(emote === 3 ? 0 : 3));
    /* 说一句 / 留字条:页内的一小块面板,不用 prompt() —— 手机的 webview 里它要么不弹,要么弹得很丑。 */
    const sheet = el('div', 'town-sheet');
    sheet.style.display = 'none';
    const closeSheet = () => { sheet.style.display = 'none'; sheet.textContent = ''; };
    const openSay = () => {
      sheet.textContent = '';
      const f = el('form', 'town-say', sheet);
      const inp = el('input', '', f);
      inp.maxLength = 120; inp.placeholder = w.town_say; inp.enterKeyHint = 'send'; inp.autocomplete = 'off';
      const go = el('button', '', f); go.type = 'submit'; go.textContent = '↑';
      on(f, 'submit', (e) => {
        e.preventDefault();
        const text = inp.value.trim().slice(0, 120);
        if (text && opts.onSay) { try { opts.onSay(text); } catch (err) {} showMine(text); }
        closeSheet();
      });
      on(inp, 'keydown', (e) => { if (e.key === 'Escape') closeSheet(); e.stopPropagation(); });
      sheet.style.display = 'block';
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
      setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
    };
    // 自己说的话:第一人称看不见自己的头顶,就在屏幕下方飘一会儿
    const mine = el('div', 'town-bub town-mine');
    mine.style.display = 'none';
    let mineTimer = 0;
    const showMine = (text) => {
      mine.textContent = text; mine.style.display = 'block';
      clearTimeout(mineTimer); mineTimer = setTimeout(() => { mine.style.display = 'none'; }, 5000);
      offs.push(() => clearTimeout(mineTimer));
    };
    const openNotes = () => {
      const list = (typeof opts.notes === 'function' ? opts.notes() : opts.notes) || [];
      if (!list.length) return;
      sheet.textContent = '';
      const box = el('div', 'town-notes', sheet);
      list.forEach((n, i) => {
        const b = el('button', '', box); b.type = 'button'; b.textContent = noteText(n);
        on(b, 'click', (e) => { e.stopPropagation(); if (opts.onMark) { try { opts.onMark('note', px, pz, i); } catch (err) {} } closeSheet(); });
      });
      sheet.style.display = 'block';
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    };
    const toggle = (fn) => () => { if (sheet.style.display !== 'none') closeSheet(); else fn(); };
    if (opts.onSay) mk('💬', w.town_say, toggle(openSay));
    if (opts.onMark) {
      mk('🏮', w.town_lantern, () => { try { opts.onMark('lantern', px, pz, 0); play.event({ type: 'lantern' }); } catch (err) {} });
      mk('📝', w.town_note, toggle(openNotes));
    }
  }

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
    /* ⚠ 聚拢的进度是按距离算的(fm = uForm·1.6 − 距离/30,屋子的尺度):停在 1 的话,
       18 米以外的点永远是飞着的、四分之三被扔掉 —— 远处的房子是一片筛子,天上飘着点。
       聚拢完了就一直往上加,直到整座镇子都落定。 */
    U.uForm.value = Math.min(TOWN_FORM, U.uForm.value + (dt / 2.6) * (U.uForm.value < 1 ? 1 : 25));
    U.uPx.value = (H * renderer.getPixelRatio() / 2) / Math.tan(camera.fov * Math.PI / 360);
    // 固定步长:跳多高、走多快不许跟着帧率变
    acc = Math.min(0.25, acc + dt);
    while (acc >= STEP) { stepOnce(STEP); acc -= STEP; }
    camera.position.set(px, EYE + py, pz);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    ground.update(camera);
    hazeU.uCam.value.copy(camera.position);
    flyMat.uniforms.uCam.value.copy(camera.position);
    // 走出十二米就看一眼:近处该细的是不是换了几栋
    if (!fineAt || Math.hypot(px - fineAt[0], pz - fineAt[1]) > 12) { fineAt = [px, pz]; refreshFine(px, pz); }
    atmos.update(dt, t, camera);
    life.update(dt, t, camera.position, env);
    people.update(dt, t, camera.position, env);
    pets.update(dt, t, { x: px, z: pz, yaw }, env);
    // 整点敲钟:鸽子从塔上飞起来一圈
    const hourNow = Math.floor(env.hour + (timeMode === 'auto' && opts.hour == null ? 0 : t / 3600));
    if (update._bell !== undefined && hourNow !== update._bell) { try { life.ring(); } catch (e) {} if (opts.onBell) { try { opts.onBell(hourNow); } catch (e) {} } }
    update._bell = hourNow;
    npcTick(dt);
    play.update(dt, t, nearDoor);

    // 身边那 24 盏灯进 uniform(表里放得下的就这么多)
    if (!update._lit || Math.hypot(px - update._lit[0], pz - update._lit[1]) > 8) {
      update._lit = [px, pz];
      const near24 = nearestLights(lights, px, pz, 24);
      setScene(U, { lights: near24, rooms: [], feet: [], court: null, rocks: [], windows: [] });
      // 地上的灯影:最近的 8 盏
      const GU = ground.uniforms;
      for (let i = 0; i < 8; i++) {
        const l = near24[i];
        if (!l) { GU.uGL.value[i].set(0, -99, 0, 0); continue; }
        GU.uGL.value[i].set(l.x, l.y, l.z, l.r * 0.9);
        const k = (l.k || 1) * 0.55;
        GU.uGLC.value[i].set(l.col[0] * k, l.col[1] * k, l.col[2] * k);
      }
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
    if (emote && t > emoteUntil) { emote = 0; if (opts.onEmote) { try { opts.onEmote(0); } catch (e) {} } }
    /* 字条:走近了才看得清写的是什么 */
    {
      let n = 0;
      const near2 = marks.filter((m) => m.kind === 'note' && Math.hypot(px - m.x, pz - m.z) < 16)
        .sort((a, b) => Math.hypot(px - a.x, pz - a.z) - Math.hypot(px - b.x, pz - b.z));
      for (const m of near2) {
        if (n >= noteEls.length) break;
        const sc = project(+m.x, 1.1, +m.z);
        const e = noteEls[n];
        if (sc.behind) { e.style.display = 'none'; continue; }
        e.textContent = '“' + noteText(m.text || '') + '” — ' + (m.name || 'someone');
        e.style.display = 'block'; e.style.left = sc.x + 'px'; e.style.top = sc.y + 'px';
        n++;
      }
      for (let i = n; i < noteEls.length; i++) noteEls[i].style.display = 'none';
    }
    /* 别人头顶的昵称 */
    /* agent 小伙伴:走近了提示按 T;自己那只的头在屏幕哪儿(宿主在那儿画回复的气泡 ——
       回复的字不进这一页,只有位置出去) */
    {
      const zh = opts.lang === 'zh', mine = pets.mine(), at = petInReach();
      const tip = !at ? '' : at === mine ? (zh ? 'T  跟 ' + mine.name + ' 说话' : 'T  talk to ' + mine.name)
        : zh ? 'T  让 ' + (mine ? mine.name : '你的') + ' 认识 ' + at.name : 'T  introduce ' + (mine ? mine.name : 'yours') + ' to ' + at.name;
      const s0 = at ? project(at.x, 0.95, at.z) : null;
      if (at && !s0.behind) {
        if (petTip.textContent !== tip) petTip.textContent = tip;
        petTip.style.display = 'block'; petTip.style.left = s0.x + 'px'; petTip.style.top = s0.y + 'px';
      } else petTip.style.display = 'none';
      if (opts.onPetScreen && mine && t - (update._petAt || 0) > 0.1) {
        update._petAt = t;
        const sh = project(mine.x, PET_BODY_Y, mine.z);
        try { opts.onPetScreen({ x: Math.round(sh.x), y: Math.round(sh.y), on: !sh.behind && Math.hypot(mine.x - px, mine.z - pz) < 30 }); } catch (err) {}
      }
    }

    for (let i = 0; i < MAXP; i++) {
      const p = peers[i], e = nameEls[i];
      if (!p) { e.style.display = 'none'; continue; }
      const ph = people.peerHead(p.id) || { x: p.x, y: 1.95, z: p.z };
      const s = project(ph.x, ph.y + 0.35, ph.z);
      const d = Math.hypot(px - p.x, pz - p.z);
      if (s.behind || d > 60) { e.style.display = 'none'; continue; }
      if (e.textContent !== (p.name || '')) e.textContent = p.name || '';
      e.style.display = 'block';
      e.style.left = s.x + 'px'; e.style.top = s.y + 'px';
      e.style.opacity = String(Math.max(0.3, 1 - d / 70));
      // 说的话:昵称上面那一格
      const b = bubbles.get(p.id), be = bubEls[i];
      if (b && t < b.until && d < 45) {
        const sb = project(p.x, 2.35, p.z);
        be.textContent = b.text;
        be.style.display = 'block'; be.style.left = sb.x + 'px'; be.style.top = sb.y + 'px';
      } else { be.style.display = 'none'; if (b && t >= b.until) bubbles.delete(p.id); }
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
    try { closeChat(); } catch (e) {}
    try { play.dispose(); } catch (e) {}
    try { nature.dispose(); life.dispose(); people.dispose(); pets.dispose(); } catch (e) {}
    try { if (markPts) { markPts.geometry.dispose(); markPts.material.dispose(); } group.userData.dispose(); if (landGroup) landGroup.userData.dispose(); if (fine) fine.group.userData.dispose(); gGeo.dispose(); gMat.dispose(); flyGeo.dispose(); flyMat.dispose(); peerGeo.dispose(); peerMat.dispose(); ground.dispose(); } catch (e) {}
    try { atmos.dispose(); bloom.dispose(); grade.dispose(); composer.dispose(); if (haze) { haze.geometry.dispose(); haze.material.dispose(); } } catch (e) {}
    try {
      renderer.setRenderTarget(null); renderer.autoClear = prevAuto;
      if (renderer.getPixelRatio() !== prevPR) { renderer.setPixelRatio(prevPR); renderer.setSize(W, H, false); }
    } catch (e) {}
  }

  atmos.setEnv(env, sunDir);
  resize(W, H);

  return {
    update, render, resize, dispose, setPeers, setMarks,
    /** 谁说了一句话:头顶飘六秒。 */
    says(id, text) { bubbles.set(id, { text: String(text || '').slice(0, 120), until: t + 6 }); },
    /** 自己此刻的表情(发给别人的那个数)。 */
    emote: () => emote,
    plan, doors, labels, uniforms: U, atmos, bloom, composer, people, life, nature, play,
    /** 站到某个人面前,和他说话(调试、带路) */
    talk(id) { const f = people.folk.find((q) => q.id === String(id)); if (f) { px = f.x + 1.6; pz = f.z + 1.6; openChat(f); } return !!f; },
    env: () => env,
    setTime(mode) { timeMode = mode === 'day' || mode === 'night' ? mode : 'auto'; env = envNow(); applyEnv(); atmos.setEnv(env, sunDir); },
    at(x, z, y, p) { px = x; pz = z; if (y != null) yaw = y; if (p != null) pitch = p; },
    /** 转头(弧度):不碰位置 —— 宿主拿它做按键转向、光标靠边转向(桌面壁纸上收不到拖动)。 */
    turn(dy, dp) { yaw += +dy || 0; if (dp) pitch = Math.max(-1.45, Math.min(1.45, pitch + dp)); },
    where() { return { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), speed: +speed.toFixed(2) }; },
    near: () => (nearDoor ? nearDoor.project : null),
    pets,
    /** 屏幕点(页面坐标)下面是哪只小伙伴 / 哪个人:{kind:'pet'|'person', id, name, mine} | null */
    pick,
    petTalk,
    particles: () => group.userData.points + (landGroup ? landGroup.userData.points : 0) + NG,
    renderNow() { U.uForm.value = TOWN_FORM; update(0); render(); },
    diag() {
      const gl = renderer.getContext(), bad = [];
      for (const p of renderer.info.programs || []) { const d = p.diagnostics; if (d && !d.runnable) bad.push((p.name || '?') + ': ' + ((d.programLog) || '')); }
      let maxVU = null, gpu = '';
      try { maxVU = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS); gpu = String(gl.getParameter(gl.RENDERER) || ''); } catch (e) {}
      return { bad: bad.join(' | ').slice(0, 500), land: landGroup ? landGroup.userData.points : 0, points: group.userData.points + (landGroup ? landGroup.userData.points : 0) + (fine ? fine.points : 0), coarse: group.userData.points, fine: fine ? fine.points : 0, glow: NG, plots: plan.plots.length, calls: renderer.info.render.calls, maxVU, gpu };
    },
  };
}
