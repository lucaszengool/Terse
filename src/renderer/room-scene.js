/**
 * room-scene.js — 点一座楼,走进去。
 *
 * 这里是**把房子盖起来、点上灯、让人走**:
 *
 *   room-interior.js  平面图(哪几间屋子、多大多高、门在哪)和装修文法(按代码挑件)
 *   room-arch.js      建筑:地、墙、顶、柱、灯具、院子、屋顶、天
 *   room-furniture.js 陈设:一个文件一件家具,一个符号一件东西
 *   room-surface.js   把上面这些"面"在 GPU 上长成几百万颗细点,带法线、材质、光照
 *
 * 一切仍是粒子。实物是 GPU 上长出来的细点(不透明、互相遮挡、会被灯照亮);灯、火、
 * 星、数据光、import 连线是发光点(加色 + bloom),和外面那座城是同一种光。
 *
 * 每间屋子**因代码而不同**:风格来自整座楼,但地、墙、顶、灯挑哪一件、染什么颜色、
 * 多高、家具怎么坐,都来自这个目录自己的文件(signatureOf)—— 谁 import 谁,谁就坐在
 * 谁旁边,地上一道淡淡的光把它们连起来。
 *
 * ⚠ 不自己开 WebGL。`createRoom` 借调用方的 renderer —— 手机上那就是引擎自己的那一个
 * (iOS Safari 只肯给一页有限几个活的 WebGL 上下文)。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { interiorOf, interiorVariants, signatureOf, mix, asLight, layoutOf, layoutFor, linkSpots, fileLight, DOOR_W, PAD } from './room-interior.js';
import { Surfaces, makeUniforms, setScene, renderShadowMap, MAT, F } from './room-surface.js';
import { designOf, sunDirOf, heightOf, kelvin } from './room-styles.js';
import { buildArchitecture, coloursOf } from './room-arch.js';
import { envAt, WEATHERS, SEASONS, WEATHER_ICON, SEASON_ICON } from './room-sky.js';
import { createAtmosphere } from './room-atmos.js';
import { langRgb } from './lang-colors.js';
import { FURN, ROLE, ROLE_ICON, ITEM_ICON, WORDS_EN, roleOfName, furnSize } from './room-furniture.js';

const TAU = Math.PI * 2;
/** 一间屋子最多单独摆出几件家具;其余的成捆放上储物架(见 FURN.archive)。 */
const CAP_HALL = 48, CAP_ROOM = 22;

/* 地图和图例里每种家具的颜色。只在界面上用 —— 场景里家具的颜色是房子的料。 */
export const ROLE_COLOR = {
  entry: '#ffd166', component: '#7dd3fc', hook: '#c4b5fd', test: '#86efac', types: '#93c5fd',
  config: '#fca5a5', docs: '#fde68a', style: '#f0abfc', asset: '#fdba74', data: '#a5f3fc',
  source: '#e5e7eb', archive: '#6b7280',
};

/** 界面上的词。英文兜底,宿主传 opts.words 覆盖(和 WORDS_EN 同一个对象)。 */
export const UI_EN = {
  ui_files: '{n} files', ui_lines: '{n} lines', ui_used_by: 'used by {n} files', ui_uses: 'uses {n} files',
  ui_defines: 'defines {n}', ui_more: '+{n} smaller files',
  ui_room_is: 'a room is a directory', ui_court_is: 'the courtyard is the directory itself',
  ui_no_symbols: 'Furniture only — this building has not been deep-scanned, so nothing is on the shelves yet.',
  ui_truncated: 'The biggest files are furnished; the rest are on the archive racks.',
  ui_uses_list: 'Uses', ui_used_by_list: 'Used by',
  ui_day: 'Day', ui_night: 'Night', ui_legend: 'Legend',
  why_tests: 'tiled and cool — mostly tests', why_docs: 'wood and warm — mostly docs',
  why_ui: 'bright like a gallery — mostly UI', why_config: 'plain and slate — mostly config',
  why_classes: 'coffered ceiling — lots of classes and types', why_functions: 'open beams — mostly loose functions',
  why_many: 'a big chandelier — many files', why_few: 'candlelight — only a few files',
  lg_title: 'How to read this building',
  lg_room: 'Room = a directory · doorway = its sub-directory',
  lg_furn: 'Furniture = a file · the kind of furniture says what the file does',
  lg_item: 'Things on the furniture = what the file defines',
  lg_size: 'Taller furniture = more code · colour of the things = language',
  lg_threads: 'Glowing threads on the floor = one file imports the other',
  lg_roles: 'Furniture', lg_items: 'On the shelves',
  ui_link: '{n} files · next door', ui_portal: 'Random portal', ui_portal_sub: 'somewhere else on the plaza',
  lg_links: 'Glowing doorframes = the other buildings of this project · the swirl = a random project',
  wx_clear: 'Clear', wx_cloudy: 'Cloudy', wx_overcast: 'Overcast', wx_rain: 'Rain', wx_storm: 'Storm', wx_snow: 'Snow', wx_fog: 'Fog',
  season_spring: 'Spring', season_summer: 'Summer', season_autumn: 'Autumn', season_winter: 'Winter',
};

const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
const fill = (s, n) => String(s).replace('{n}', n);

/* 样式跟着模块走:宿主可能是原型页、手机 app、Mac 壁纸,各有各的样式表。只注入一次。 */
const CSS = `
.room-label{position:fixed;transform:translate(-50%,-100%);color:#eef4f2;font:600 11px/1.25 -apple-system,BlinkMacSystemFont,sans-serif;
  background:rgba(6,8,12,.72);padding:3px 8px 4px;border-radius:7px;pointer-events:none;white-space:nowrap;z-index:2;
  border:1px solid rgba(255,255,255,.14);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.room-label i{font-style:normal;margin-right:4px}.room-label small{display:block;font-weight:500;opacity:.62;font-size:10px}
.room-label.sel{border-color:#6ee7b7;box-shadow:0 0 0 1px #6ee7b7}
.room-plaque{position:fixed;transform:translate(-50%,-100%);pointer-events:none;z-index:2;text-align:center;white-space:nowrap;
  font:700 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#1a1206;background:linear-gradient(#f7e2a8,#d9b766);
  padding:5px 12px 6px;border-radius:4px;border:2px solid #7a5a22;box-shadow:0 4px 14px rgba(0,0,0,.45)}
.room-plaque small{display:block;font-weight:600;font-size:10px;opacity:.72}
.room-item{position:fixed;transform:translate(-50%,-110%);pointer-events:none;z-index:3;white-space:nowrap;
  font:600 10.5px/1.2 ui-monospace,SFMono-Regular,monospace;color:#0b0f0d;background:#c9f03d;padding:2px 6px;border-radius:5px}
.room-toast{position:absolute;left:50%;top:13%;transform:translate(-50%,-50%);pointer-events:none;z-index:4;text-align:center;
  font:700 18px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;text-shadow:0 2px 16px rgba(0,0,0,.8);transition:opacity .5s}
.room-toast small{display:block;font-size:12px;font-weight:600;opacity:.8;margin-top:4px}
.room-side{position:absolute;right:12px;top:calc(64px + env(safe-area-inset-top,0px));z-index:4;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.room-map{position:static!important;inset:auto!important;width:150px!important;height:150px!important;border-radius:12px;background:rgba(6,8,12,.62);border:1px solid rgba(255,255,255,.12)}
.room-btns{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:250px}
.room-btn{font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;color:#eef4f2;background:rgba(6,8,12,.66);cursor:pointer;
  border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:6px 11px}
.room-legend{width:min(300px,calc(100vw - 24px));max-height:52vh;overflow:auto;background:rgba(6,8,12,.86);color:#e8eeec;border-radius:12px;
  border:1px solid rgba(255,255,255,.12);padding:12px 14px;font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
.room-legend b{display:block;font-size:13px;margin:0 0 6px}.room-legend h4{margin:10px 0 4px;font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:.04em}
.room-legend p{margin:0 0 3px}.room-legend .row{display:flex;gap:8px;align-items:center;margin:2px 0}
.room-legend .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
@media (max-width:520px){.room-map{width:112px!important;height:112px!important}.room-toast{font-size:15px}}
.room-joy{position:absolute;left:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));width:110px;height:110px;border-radius:50%;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);touch-action:none;z-index:3}
.room-joy i{position:absolute;left:35px;top:35px;width:40px;height:40px;border-radius:50%;background:rgba(110,231,183,.5)}`;
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('room-scene-css')) return;
  const s = document.createElement('style');
  s.id = 'room-scene-css'; s.textContent = CSS;
  document.head.appendChild(s);
}


/* 发光点的着色器:点的大小按世界尺寸(米),种类决定什么时候亮。 */
const GLOW_VS = `
precision highp float;
attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aTwk; attribute float aKind;
uniform float uTime, uPx, uNight, uFogA, uFogB, uForm;
uniform vec3 uSunDir, uHaloC, uPortalC;
uniform float uSunVis, uSkyAur;
uniform vec4 uPick;
varying vec3 vColor; varying float vA;
void main(){
  // y < 0 的是地面倒影(teamLab 的镜面地):按本体算动画,最后翻到地下、压暗
  float mir = position.y < -0.005 ? 1.0 : 0.0;
  vec3 p = position; p.y = abs(p.y);
  float fade = 1.0, twk = aTwk;
  if (aKind > 10.5) {
    /* 11 传送门:永远正对着人的一圈旋涡。position 是圆心,aTwk 是半径,aPhase 是这颗点在哪条旋臂上。
       aTwk > 0.86 的是亮边,慢慢转;里面的顺着三条旋臂往中心流,越往里越亮,流到中心再从外面出来。 */
    vec3 Rx = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), Uy = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float r, an;
    if (aTwk > 0.86) { r = aTwk * (1.0 + 0.03 * sin(uTime * 3.0 + aPhase * 40.0)); an = aPhase * 6.2831 + uTime * 0.5; }
    else {
      float life = fract(aPhase * 7.31 + aTwk * 13.7 - uTime * 0.12);
      r = aTwk * (0.1 + 0.9 * life);
      an = aPhase * 6.2831 + (0.8 - r) * 4.0 + uTime * 0.8;
      fade = (0.35 + 1.1 * (1.0 - life)) * smoothstep(0.0, 0.08, life);
    }
    p = p + (Rx * cos(an) + Uy * sin(an)) * r;
    twk = 0.6;
  } else if (aKind > 8.5) {
    // 9 扫描光(测试多的屋子):一层绿光从地面扫到顶,再从头来 —— 一轮轮在跑的测试。aTwk = 扫多高
    float s = fract(uTime * 0.12);
    p.y = 0.05 + s * aTwk;
    fade = smoothstep(0.0, 0.06, s) * (1.0 - smoothstep(0.8, 1.0, s)) * 1.4;
    twk = 0.0;
  } else if (aKind > 7.5) {
    // 8 代码光环:这座楼里真实的函数、类名,绕大殿中轴慢慢转,轻轻上下浮
    float an = uTime * uHaloC.z, cs = cos(an), sn = sin(an);
    vec2 q = p.xz - uHaloC.xy;
    p.xz = uHaloC.xy + vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
    p.y += sin(uTime * 0.5 + aPhase * 6.2831) * 0.03;
    twk = 0.35;
  } else if (aKind > 6.5) {
    // 7 数据流:import 的那条线上,光一段段从引用方流向被引用的文件(aTwk = 这颗点在线上的位置)
    fade = 0.22 + 1.8 * pow(0.5 + 0.5 * sin((aTwk * 3.0 - uTime * 0.6) * 6.2831), 10.0);
    twk = 0.0;
  } else if (aKind > 5.5) {
    // 6 极光丝带(和壁纸 WALLPAPER PULSE 同一种):整条带子沿着自己慢慢起伏、飘动;aTwk 是这条带子的相位
    p.y += sin(p.x * 0.35 + uTime * 0.45 + aTwk) * 0.5 + sin(p.x * 0.9 - uTime * 0.7 + aTwk * 2.0) * 0.15;
    p.z += cos(p.x * 0.25 + uTime * 0.3 + aTwk) * 0.8;
    twk = 0.3;
  } else if (aKind > 3.5) {
    // 4、5 飘浮的光尘 / 火星:慢慢往上飘(aTwk 是飘多高,负的就是往下落,比如雪),一轮约 90 秒,两头淡入淡出
    float u = fract(aPhase * 7.13 + uTime * 0.011);
    p.y += u * aTwk;
    p.x += sin(uTime * 0.23 + aPhase * 40.0) * 0.3;
    p.z += cos(uTime * 0.19 + aPhase * 31.0) * 0.3;
    fade = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.75, 1.0, u));
    twk = 0.5;
  } else p.y += sin(uTime * 0.8 + aPhase * 6.2831) * 0.01 * aTwk;
  // 光尘被人轻轻推开(teamLab:空间回应人的存在)
  if (aKind > 3.5 && aKind < 5.5) { vec2 dq = p.xz - cameraPosition.xz; float dl = max(length(dq), 1e-3); p.xz += dq / dl * max(0.0, 1.6 - dl) * 0.7; }
  // 入场:发光点也从四处聚拢,和墙地同一条曲线
  float fm = clamp(uForm * 1.6 - length(p - cameraPosition) / 30.0, 0.0, 1.0);
  p += (vec3(sin(aPhase * 91.0), fract(aPhase * 37.0), cos(aPhase * 53.0)) * vec3(16.0, 10.0, 16.0) + vec3(0.0, 2.0, 0.0)) * pow(1.0 - fm, 3.0);
  if (mir > 0.5) p.y = -p.y;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(aSize * uPx / max(0.2, d), 1.0, 64.0) * mix(0.35, 1.0, fm);
  // 1 灯:夜里才亮;2 数据光:一直亮,白天淡一点;3 天光:白天才有;4 光尘:一直有;5 火星:夜里
  float on = aKind < 1.5 ? uNight : aKind < 2.5 ? mix(0.4, 1.0, uNight) : aKind < 3.5 ? 1.0 - uNight : aKind < 4.5 ? mix(0.7, 1.0, uNight) : aKind < 5.5 ? uNight : mix(0.6, 1.0, uNight);
  if (aKind > 10.5) on = 1.0;
  // 露天夜空里那三条极光:只有晴朗、该有极光的夜里才亮(见 room-sky.js 的 fx.aurora)
  if (aKind > 5.5 && aKind < 6.5 && abs(position.y) > 7.5) on *= uSkyAur;
  float tw = 0.75 + 0.25 * sin(uTime * 1.9 + aPhase * 19.0);
  vA = on * fade * mix(1.0, tw, twk);
  // 光柱:迎着太阳看时整道亮起来,背对太阳几乎看不见(前向散射)—— 光遇逆光的感觉;阴天几乎没有
  if (aKind > 2.5 && aKind < 3.5) vA *= (0.4 + 0.9 * pow(max(dot(normalize(p - cameraPosition), uSunDir), 0.0), 5.0)) * uSunVis;
  // 雾里,光比墙面更穿得透
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  vA *= 1.0 - 0.55 * fd;
  // 贴着镜头的发光点淡掉:否则一颗 7cm 的光点在半米外就是一大块光斑
  vA *= smoothstep(0.6, 2.0, d);
  vA *= mix(1.0, 0.3, mir);   // 倒影淡一些
  // 点了一件家具:和表面同一圈光扫过,光环、数据流、光尘被扫到的那一下亮起来
  float pk = uTime - uPick.z, rp = length(p.xz - uPick.xy) - pk * 6.0;
  vA *= 1.0 + 2.5 * uPick.w * exp(-rp * rp * 0.8) * max(0.0, 1.0 - pk / 4.0);
  vColor = aKind > 10.5 ? aColor * uPortalC : aColor;
  gl_Position = projectionMatrix * mv;
}`;
/* 一颗发光点:亮的芯 + 一圈柔的晕,边缘淡出 —— 蜡烛、灯、光尘在光遇里都是这样发光的 */
const GLOW_FS = `
precision highp float;
varying vec3 vColor; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float core = exp(-r2 * 48.0), halo = exp(-r2 * 8.0) * 0.4;
  float edge = 1.0 - smoothstep(0.15, 0.25, r2);
  gl_FragColor = vec4(vColor * (core + halo) * edge * 0.6 * vA, 1.0);
}`;

/* 粒子字(门牌、名牌、符号签):每颗点在字的平面上有自己的位置(position.xy,米)和大小(position.z);
   平面永远正对着人(uRight/uUp 是相机的两个轴);uForm 0→1 时从四周聚拢(壁纸字形的 BURST)。 */
const TEXT_VS = `
attribute vec3 aCol; attribute float aRand;
uniform vec3 uAnchor, uRight, uUp;
uniform float uScale, uPx, uTime, uAlpha, uForm, uK, uGlow;
varying vec3 vC; varying float vA;
void main(){
  float a = aRand * 6.2831, u = (1.0 - uForm) * (1.0 - uForm);
  vec2 off = position.xy * uScale + vec2(cos(a), sin(a)) * u * (0.5 + aRand * 1.8) * uScale;
  vec3 bk = normalize(cross(uRight, uUp));
  vec3 p = uAnchor + uRight * off.x + uUp * off.y + bk * u * (aRand - 0.5) * 1.2 * uScale;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(position.z * uScale * uGlow * uPx / max(0.2, -mv.z), 1.0, 28.0);
  vA = uAlpha * uK * uForm * (0.72 + 0.28 * sin(uTime * 2.3 + aRand * 21.0));
  vC = aCol;
  gl_Position = projectionMatrix * mv;
}`;
const TEXT_FS = `
uniform float uSoft;
varying vec3 vC; varying float vA;
void main(){
  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (r > 1.0) discard;
  float a = r < 0.42 ? mix(0.96, 0.78, r / 0.42) : (r < 0.72 ? mix(0.78, 0.22, (r - 0.42) / 0.3) : mix(0.22, 0.0, (r - 0.72) / 0.28));
  a = mix(a, a * a, uSoft);
  gl_FragColor = vec4(vC * 1.15, a * vA);
}`;

/* ── 后期:边缘加深(EDL)+ 按风格调色 + 远处轻微去饱和 + 暗角 + 胶片颗粒 ────────
   EDL 是点云查看器(Potree)的标准做法:深度突然跳开的地方压暗一圈,轮廓就清楚了。
   调色:暗部偏冷、亮部偏暖,强度按风格;颗粒只动亮度,1/255 的抖动去掉暗部色阶。 */
const GRADE_FS = `
precision highp float;
uniform sampler2D tDiffuse, tDepth;
uniform vec2 uRes; uniform float uNear, uFar, uTime, uK, uNight, uHaloK, uVig, uFlash;
uniform vec3 uSh, uHi, uHalo, uVigCol, uTop;
varying vec2 vUv;
float lz(float z){ return (2.0 * uNear * uFar) / (uFar + uNear - (z * 2.0 - 1.0) * (uFar - uNear)); }
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float z0 = texture2D(tDepth, vUv).r;
  float d0 = log2(lz(z0));
  vec2 px = 1.4 / uRes;
  float s = 0.0;
  s += max(0.0, d0 - log2(lz(texture2D(tDepth, vUv + vec2(px.x, 0.0)).r)));
  s += max(0.0, d0 - log2(lz(texture2D(tDepth, vUv - vec2(px.x, 0.0)).r)));
  s += max(0.0, d0 - log2(lz(texture2D(tDepth, vUv + vec2(0.0, px.y)).r)));
  s += max(0.0, d0 - log2(lz(texture2D(tDepth, vUv - vec2(0.0, px.y)).r)));
  s += max(0.0, d0 - log2(lz(texture2D(tDepth, vUv + px).r)));
  s += max(0.0, d0 - log2(lz(texture2D(tDepth, vUv - px).r)));
  // 轮廓不描黑:剪影后面那一侧往雾色提亮一圈,像逆光里的光晕(光遇给边加的是柔,不是线)
  c = mix(c, uHalo, (1.0 - exp(-s * 1.4)) * uHaloK);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  // 冷暗暖亮的分调
  c = mix(c, c * mix(uSh, uHi, smoothstep(0.1, 0.8, l)), uK);
  // 光从上面落下来:画面上方淡淡一层暖光
  c += uTop * 0.035 * smoothstep(0.4, 1.0, vUv.y) * (1.0 - 0.6 * uNight);
  // 闪电:整个画面白一下(外面的天由 room-atmos.js 闪,屋里跟着亮)
  c += vec3(0.75, 0.82, 1.0) * uFlash * 0.28;
  // 暗角带一点冷色,不压黑
  vec2 q = vUv - 0.5;
  c = mix(c, c * uVigCol, clamp(dot(q, q) * uVig, 0.0, 1.0));
  // 只留 1/255 的抖动去色阶,不要胶片颗粒
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(3.1, 7.7))) * 1e4) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;
class GradePass extends Pass {
  constructor(U, camera, grade) {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
        uNear: { value: camera.near }, uFar: { value: camera.far }, uTime: U.uTime, uNight: U.uNight,
        uK: { value: grade.k }, uSh: { value: new THREE.Vector3(...grade.sh) }, uHi: { value: new THREE.Vector3(...grade.hi) },
        uHaloK: { value: 0.22 }, uVig: { value: 0.5 }, uHalo: { value: new THREE.Vector3() },
        uVigCol: { value: new THREE.Vector3(0.86, 0.87, 1) }, uTop: { value: new THREE.Vector3() }, uFlash: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: GRADE_FS,
    });
    this.fsq = new FullScreenQuad(this.mat);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.mat.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture; u.uRes.value.set(readBuffer.width, readBuffer.height);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsq.render(renderer);
  }
  dispose() { this.mat.dispose(); this.fsq.dispose(); }
}

/**
 * 盖好一座楼的里面,交回一个能走的场景。
 *
 * @param {THREE.WebGLRenderer} renderer 借来的 —— 不 dispose 它,只在走的时候用它画
 * @param {object} dir  胶囊里的一个目录:{ name, files, bytes, lang, kids, leaves, detail? }
 * @param {object} [opts]
 *   style   外面那座城的风格 id(胶囊的 `style`)。格局跟着它走(唐宋 → 四合院,江户 → 庭院)
 *   layout  强制格局:'hall' | 'siheyuan' | 'garden'
 *   time    'day' | 'night' | 'auto'(默认 auto:看的人那边的钟)
 *   host    标签、地图、图例挂在哪个元素里(默认 body)
 *   input   拖动视角 / 点家具听哪个元素(默认 renderer 的画布)
 *   budget  0.25–1。决定点有多密(1 ≈ 2.8cm 一颗,手机上 0.55 ≈ 4cm)
 *   pixelRatio  走的时候用的像素比(默认 min(2, dpr));走出来还原
 *   words   翻好的词(WORDS_EN + UI_EN 的键)
 *   onHere(info)  走进了另一间屋子
 *   onPick(prop, desc)  点了一件家具;desc 是 describe(prop) 的结果
 *   hour / weather / season / seed / lat / lon  外面是什么天(见 room-sky.js);不给就按看的人的钟和当天的签
 *   links   隔壁的楼(同一个项目里别的顶层目录)[{name, files, lang}] —— 大厅里各立一座门框
 *   arrive  从哪座楼走过来的(links 里的 name):人站在那座门框前面,背对着它
 *   portal  立一座随机传送门(setPortal 告诉它通向哪)
 *   onLink(link) / onPortal(target)  人穿过了门框 / 走进了传送门(见 room-travel.js)
 *   formIn  进门时粒子聚拢用几秒(默认 2.4)
 */
export function createRoom(renderer, dir, opts = {}) {
  injectCss();
  dir = dir || {};
  const B = Math.max(0.25, Math.min(1, +opts.budget || 1));
  const styleId = opts.style || dir.style || 'modern';
  const layout = opts.layout || layoutFor(styleId);
  const L = layoutOf(dir, { layout });
  const { hall, rooms, doors } = L;
  const dirLang = dir.lang || '';
  const host = opts.host || document.body;
  const input = opts.input || renderer.domElement;
  const w = Object.assign({}, WORDS_EN, UI_EN, opts.words || {});
  const spacing = opts.spacing || (B >= 0.9 ? 0.028 : B >= 0.6 ? 0.036 : 0.045);
  const S = new Surfaces(spacing);
  const U = makeUniforms();
  U.uForm.value = 0;   // 进门:粒子从 0 聚到 1(update 里走,约 2.4 秒)
  U.uSunVis = { value: 1 }; U.uSkyAur = { value: 0 }; U.uPortalC = { value: new THREE.Vector3(0.78, 0.62, 1) };
  const formIn = Math.max(0.3, +opts.formIn || 2.4);
  let dissolving = false, dissolveT = 0.45, locked = false;
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* 外面是什么天:几点(看的人自己的钟)、什么季节、什么天气(room-sky.js)。
     时间按钮三档:跟着钟 / 白天 / 夜里;天气、季节按钮一档档换着看。 */
  let timeMode = opts.time === 'day' || opts.time === 'night' ? opts.time : 'auto';
  let wxPick = WEATHERS.includes(opts.weather) ? opts.weather : null, seasonPick = SEASONS.includes(opts.season) ? opts.season : null;
  const envNow = () => envAt(new Date(), {
    seed: opts.seed || '', lat: opts.lat, lon: opts.lon, weather: wxPick || undefined, season: seasonPick || undefined,
    hour: timeMode === 'day' ? 12.5 : timeMode === 'night' ? 22.5 : opts.hour,
  });
  let env = envNow();
  /* 设计单:这个风格的层高、太阳、补光、灯色(见 room-styles.js)。层高按风格定基准,
     代码量上下浮动 —— 江户的屋子矮,古埃及的殿高,北欧是低墙加一个两坡顶。 */
  const D = designOf(styleId);
  for (const r of rooms) r.h = heightOf(D, r);
  const Sk = D.sky, lin = (c) => c.map((v) => Math.pow(v, 2.2));
  const sunK = () => D.light.sunK + (2300 - D.light.sunK) * env.golden;
  /** 太阳和天光的颜色、强度:跟着钟(黄昏偏橙、低)和天气(阴天没有直射光,天光反而多一点)。
   *  换天气时直接改 uniform —— 太阳的方向和阴影图是进门时定的,不重画。 */
  function sunLight() {
    const fx = env.fx, f = D.light.fill * (1 + 0.35 * fx.cover);
    const sk = kelvin(sunK()), sI = D.light.sunI * (1 - 0.72 * fx.cover) * (1 - 0.2 * env.golden);
    U.uSunCol.value.set(sk[0] * sI, sk[1] * sI, sk[2] * sI);
    // 光遇:天光用这个风格自己的天色,再带三成外面真实的天色;地面反上来的光带着地的颜色
    const zen = lin(mix(Sk.zenith, env.zen, 0.3)), flo = lin(D.pal.floor);
    U.uSky.value.set(zen[0] * f * 0.75, zen[1] * f * 0.75, zen[2] * f * 0.75);
    U.uGround.value.set(flo[0] * sk[0] * sI * 0.3 * f, flo[1] * sk[1] * sI * 0.3 * f, flo[2] * sk[2] * sI * 0.3 * f);
    U.uSunVis.value = 1 - 0.85 * fx.cover;
    const mI = 0.5 - 0.5 * Math.cos(env.moon * Math.PI * 2);
    U.uMoon.value.set(0.055, 0.065, 0.13).multiplyScalar((0.55 + 0.7 * mI) * (1 - 0.45 * fx.cover));
    U.uSkyAur.value = fx.aurora ? 1 : 0.2;
  }
  {
    // 太阳的仰角:白天按钟(黄昏压低到 7°,光柱拉得长长的),但不高过设计单 —— 那是这个风格的光
    const elDesign = L.open ? D.light.sunEl : (D.light.sunElIn != null ? D.light.sunElIn : Math.min(D.light.sunEl, 40));
    const sd = sunDirOf(D, !L.open, env.night < 0.5 ? Math.max(7, Math.min(elDesign, env.sunEl)) : null), f = D.light.fill;
    U.uSunDir.value.set(sd[0], sd[1], sd[2]).normalize();
    sunLight();
    const lk = kelvin(D.light.lampK), lt = D.light.lampTint, rim = lin(Sk.rim);
    U.uRim.value.set(rim[0] * 0.5, rim[1] * 0.5, rim[2] * 0.5);
    U.uRimNight.value.set(lk[0] * lt[0] * 0.18, lk[1] * lt[1] * 0.18, lk[2] * lt[2] * 0.18);
    // 暗部的颜色:AO 往它上面染(归一到最亮的通道是 1),色调曲线把最暗处抬到它上面
    const shc = Sk.shadow, shm = Math.max(...shc);
    U.uShadowTint.value.set(shc[0] / shm, shc[1] / shm, shc[2] / shm);
    U.uLiftCol.value.set(shc[0], shc[1], shc[2]);
    U.uDetailFw.value = 0;          // 砖缝、花砖、席纹这些细纹样都画出来 —— 设计感就在这些纹样里
    U.uGlitter.value = (Sk.glitter || [0, 0])[0]; U.uGlitterDen.value = (Sk.glitter || [0, 0])[1];
    U.uDayGlow.value = D.light.dayGlow;
    // 门口那道柔和主光跟着补光比走:古埃及、玛雅、北欧白天是暗的,只有窗里那几道硬光
    U.uKeyK.value = 0.10 + 0.30 * f;
  }

  /* ── 发光点 ── */
  const MAXL = Math.round(180000 * B) + 30000;
  const lPos = new Float32Array(MAXL * 3), lCol = new Float32Array(MAXL * 3), lSiz = new Float32Array(MAXL);
  const lPha = new Float32Array(MAXL), lTwk = new Float32Array(MAXL), lKind = new Float32Array(MAXL);
  let NL = 0;
  /** 一颗发光点。size 是世界直径(米);kind 1 夜里亮的灯、2 数据光、3 白天的光。 */
  const G = (x, y, z, c, size, tw = 0.5, kind = 2) => {
    if (NL >= MAXL) return;
    const i = NL++;
    lPos[i * 3] = x; lPos[i * 3 + 1] = y; lPos[i * 3 + 2] = z;
    lCol[i * 3] = c[0]; lCol[i * 3 + 1] = c[1]; lCol[i * 3 + 2] = c[2];
    // 闪烁相位按下标哈希,不用 Math.random —— 这个仓库里的城市一律可复现。
    lSiz[i] = size; lPha[i] = (Math.imul(i, 2654435761) >>> 0) / 4294967296; lTwk[i] = tw; lKind[i] = kind;
  };

  const lights = [], feet = [];
  const blocks = L.blocks;
  const block = (x, z, rx, rz) => blocks.push({ x, z, rx, rz: rz || rx });
  const lit = (x, y, z, r, col, k, o) => lights.push({ x, y, z, r, col, k, flame: !!(o && o.flame) });
  const windows = [], rocks = [];

  /* ── 盖起来:每间屋子先读自己的代码,再按代码装修 ───────────────────────── */
  const keyOf = (r) => (r.isHall ? '\0hall' : r.name);
  const decor = new Map(), sigs = new Map(), cols = new Map();
  for (const r of rooms) {
    const files = L.byRoom.get(r.isHall ? '' : r.name) || [];
    const sig = signatureOf(files, dirLang);
    const ip = interiorOf(styleId, r.name, sig);
    decor.set(keyOf(r), ip); sigs.set(keyOf(r), sig);
    const rnd = () => ip.rnd.f();
    cols.set(keyOf(r), buildArchitecture(S, G, {
      r, ip, doors, rooms, isHall: !!r.isHall, lit, block, rnd, seed: ip.rnd.f() * 10,
      roof: !r.isHall && L.open, frames: !!r.isHall, windows, rocks,
    }));
  }
  const kitOf = (r) => decor.get(keyOf(r));
  if (D.light.soot) U.uSootY.value = Math.max(...rooms.map((r) => r.h)) + Math.min(hall.x1 - hall.x0, hall.z1 - hall.z0) * 0.45;

  /* 光柱:阳光从每一扇朝阳的窗(和天眼、烟孔)斜着进来,光里浮着尘。
     尘是白天才有的发光点,再加一层很淡的大点做出"光的体积";夜里换成一缕冷的月光。 */
  {
    const sd = U.uSunDir.value, d = [-sd.x, -sd.y, -sd.z], sk = kelvin(sunK());
    const rr = () => kitOf(hall).rnd.f();
    for (const win of windows) {
      const facing = d[0] * win.n[0] + d[1] * win.n[1] + d[2] * win.n[2];
      if (facing < 0.08 || win.type === 'shoji') continue;
      const area = Math.hypot(...win.U) * Math.hypot(...win.V);
      const nM = Math.min(420, Math.round(70 + area * 110)), nH = Math.min(260, Math.round(40 + area * 60));
      const pt = () => { const a = rr(), b = rr(); return [win.o[0] + win.U[0] * a + win.V[0] * b, win.o[1] + win.U[1] * a + win.V[1] * b, win.o[2] + win.U[2] * a + win.V[2] * b]; };
      for (let i = 0; i < nM + nH; i++) {
        const p = pt(), tMax = Math.min(14, p[1] / Math.max(0.05, -d[1]));
        const t = rr() * tMax, x = p[0] + d[0] * t, y = p[1] + d[1] * t, z = p[2] + d[2] * t;
        // 光尘 1.5–3.5cm,光柱的"体积"是一层很淡的大点 —— 逆光时才看得出一道道光
        if (i < nM) G(x, y, z, [sk[0], sk[1] * 0.93, sk[2] * 0.8], 0.015 + rr() * 0.02, 0.9, 3);
        else { const k = 0.045 * Math.pow(1 - t / Math.max(tMax, 0.01), 0.6); G(x, y, z, [sk[0] * k, sk[1] * k * 0.95, sk[2] * k * 0.85], 0.55 + rr() * 0.45, 0.05, 3); }
      }
    }
  }

  /* ── 隔壁的楼、随机传送门 ────────────────────────────────────────────────
     同一个项目里别的顶层目录是隔壁的楼:大厅里贴着墙各立一座门框,门洞里是一层那座楼
     主语言颜色的光幕,门楣上写着它叫什么。穿过门洞就走进那座楼(room-travel.js 换屋子,
     人站在那边通回来的门框前)。传送门是空地上一圈正对着人的旋涡,通向广场上随便哪个项目。 */
  const links = (Array.isArray(opts.links) ? opts.links : []).filter((l) => l && l.name).slice(0, 4);
  const frames = [], tempBlocks = [];
  let portal = null;
  {
    const spots = linkSpots(hall, doors, blocks, L.start, links.length, !!opts.portal);
    const C = cols.get(keyOf(hall)), fl = L.open ? 0 : F.indoor, rr = () => kitOf(hall).rnd.f(), seed = rr() * 10;
    const sp = (mat, c1, c2) => ({ mat, c1, c2: c2 || c1, flags: fl, seed });
    const OW = 1.0, OH = 2.7;
    spots.links.forEach((s, i) => {
      const l = links[i], rgb = asLight(langRgb(l.lang || ''));
      const t3 = [s.tx, 0, s.tz], n3 = [s.nx, 0, s.nz];
      const at = (u, y = 0, v = 0) => [s.x + s.tx * u + s.nx * v, y, s.z + s.tz * u + s.nz * v];
      for (const u of [-OW - 0.12, OW + 0.12]) {
        S.box(at(u), t3, n3, 0.24, OH + 0.2, 0.34, sp(MAT.lacquer, C.struct));
        blocks.push({ x: at(u)[0], z: at(u)[2], rx: 0.26, rz: 0.26 });
      }
      S.box(at(0, OH), t3, n3, OW * 2 + 0.7, 0.32, 0.4, sp(MAT.lacquer, C.struct), { bottom: true });
      S.box(at(0, OH + 0.32), t3, n3, OW * 2 + 0.9, 0.06, 0.46, sp(MAT.metal, C.gold || C.accent));
      S.box(at(0, 0), t3, n3, OW * 2 + 0.5, 0.05, 0.6, sp(MAT.stone, C.stone));
      // 光幕:门洞里一层光点,那座楼的主语言色。白天数据光只亮四成,所以这层要够密、够亮才看得出是一道门
      for (let k = 0, n = Math.round(2400 * B) + 400; k < n; k++) {
        const br = 0.7 + 1.1 * rr(), p = at((rr() * 2 - 1) * OW, 0.06 + rr() * (OH - 0.1), -0.02 - rr() * 0.06);
        G(p[0], p[1], p[2], [rgb[0] * br, rgb[1] * br, rgb[2] * br], 0.04 + rr() * 0.035, 0.9, 2);
      }
      // 门洞的边亮一圈;门洞里往屋里飘出来的光尘
      for (let k = 0; k <= 60; k++) {
        const q = k / 60;
        for (const p of [at(-OW, q * OH, -0.03), at(OW, q * OH, -0.03), at((q * 2 - 1) * OW, OH - 0.02, -0.03)]) G(p[0], p[1], p[2], rgb.map((v) => Math.min(1, v * 1.4)), 0.045, 0.4, 2);
      }
      for (let k = 0, n = Math.round(90 * B) + 20; k < n; k++) { const p = at((rr() * 2 - 1) * OW, 0.1, 0.1 + rr() * 1.2); G(p[0], p[1], p[2], rgb, 0.03, OH * (0.5 + rr() * 0.5), 4); }
      tempBlocks.push({ x: s.x + s.nx * 0.4, z: s.z + s.nz * 0.4, rx: 1.7, rz: 1.7 });
      frames.push(Object.assign({}, s, { link: l, rgb, OW, s0: 9, fired: false }));
    });
    if (spots.portal) {
      const P = spots.portal, cy = 1.45;
      // 旋涡:三条旋臂 + 一圈亮边(顶点着色器 kind 11 让它转、往里流、正对着人);颜色由 uPortalC 染
      for (let k = 0, n = Math.round(2600 * B) + 500; k < n; k++) {
        const rim = k % 6 === 0, r = rim ? 0.88 + rr() * 0.06 : 0.05 + Math.pow(rr(), 0.8) * 0.75;
        G(P.x, cy, P.z, rim ? [0.62, 0.62, 0.62] : [0.36, 0.36, 0.36], 0.025 + rr() * 0.03, r, 11);
        const ph = rim ? rr() : (k % 3) / 3 + (rr() - 0.5) * 0.05;
        lPha[NL - 1] = ph - Math.floor(ph);
      }
      for (let k = 0; k < 120; k++) { const a = k / 120 * TAU; G(P.x + Math.cos(a) * 1.05, 0.04, P.z + Math.sin(a) * 1.05, [0.5, 0.42, 0.9], 0.045, 0.4, 2); }
      lit(P.x, 1.5, P.z, 4.5, [0.72, 0.6, 1], 1.2);
      tempBlocks.push({ x: P.x, z: P.z, rx: 1.8, rz: 1.8 });
      portal = { x: P.x, z: P.z, y: cy, fired: false, target: null };
    }
  }
  // 家具躲开门框和传送门;摆完就撤,人要走得过去
  for (const b of tempBlocks) blocks.push(b);

  /* ── 陈设:一个文件一件家具 ──────────────────────────────────────────────
     靠墙的(柜、书架、画、抽屉)沿墙一排,朝屋里;站在中间的(实验台、展柜、绘图桌)
     排成几行,朝着进门的方向;入口文件是尽头正中那座主案。**坐次按 import**:先摆最
     重要的那个,之后每次挑和已经摆下的牵连最深的 —— 互相引用的文件就是邻座。 */
  const props = [];
  const byIdx = new Map();
  const adj = new Map();
  for (const [i, j] of L.edges) {
    if (!adj.has(i)) adj.set(i, new Set()); if (!adj.has(j)) adj.set(j, new Set());
    adj.get(i).add(j); adj.get(j).add(i);
  }
  function slotsFor(r) {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const inSide = r.isHall ? 'S' : ({ N: 'S', S: 'N', E: 'W', W: 'E' })[r.side];
    const back = ({ S: 'N', N: 'S', E: 'W', W: 'E' })[inSide];
    const faceIn = { N: [0, 1], S: [0, -1], E: [-1, 0], W: [1, 0] };
    const inset = r.open ? (r.kind === 'garden' ? 1.1 : 1.6) : 0.72;
    const wallSlots = [], floorSlots = [];
    let center = null;
    // 沿墙一圈,顺时针 —— 相邻的位子就是墙上相邻的家具
    for (const s of ['N', 'E', 'S', 'W']) {
      const horiz = s === 'N' || s === 'S';
      const lo = horiz ? r.x0 : r.z0, hi = horiz ? r.x1 : r.z1, len = hi - lo;
      const n = Math.floor((len - 2.4) / 1.9);
      const us = [];
      for (let i = 0; i <= n; i++) us.push(lo + 1.2 + (n ? i * (len - 2.4) / n : (len - 2.4) / 2));
      if (s === 'S' || s === 'W') us.reverse();
      for (const u of us) {
        const X = horiz ? u : (s === 'W' ? r.x0 + inset : r.x1 - inset);
        const Z = horiz ? (s === 'N' ? r.z0 + inset : r.z1 - inset) : u;
        if (doors.some((d) => Math.hypot(d.cx - X, d.cz - Z) < 2.0)) continue;
        if (blocks.some((b) => Math.hypot(b.x - X, b.z - Z) < Math.max(b.rx, b.rz) + 0.8)) continue;
        // 窗台低的窗前不放靠墙的柜子:书架挡在格扇窗前面,窗和光都没了
        if (windows.some((w) => w.o[1] < 2.2 && (horiz ? w.n[2] !== 0 && Math.abs(w.o[2] - Z) < 1.2 : w.n[0] !== 0 && Math.abs(w.o[0] - X) < 1.2)
          && u > Math.min(horiz ? w.o[0] : w.o[2], (horiz ? w.o[0] + w.U[0] : w.o[2] + w.U[2])) - 0.7
          && u < Math.max(horiz ? w.o[0] : w.o[2], (horiz ? w.o[0] + w.U[0] : w.o[2] + w.U[2])) + 0.7)) continue;
        const [fx, fz] = faceIn[s];
        const slot = { X, Z, fx, fz, wall: s };
        if (s === back && !center && Math.abs(u - (horiz ? cx : cz)) < 1.3) { center = Object.assign({}, slot, { X: horiz ? cx : X + fx * 1.3, Z: horiz ? Z + fz * 1.3 : cz, wall: null }); continue; }
        wallSlots.push(slot);
      }
    }
    if (!center) {
      const [fx, fz] = faceIn[back];
      center = { X: back === 'E' ? r.x1 - 2.2 : back === 'W' ? r.x0 + 2.2 : cx, Z: back === 'N' ? r.z0 + 2.2 : back === 'S' ? r.z1 - 2.2 : cz, fx, fz };
    }
    const fin = faceIn[back];
    const m = r.open ? 3.4 : 2.9;
    for (let z = r.z0 + m; z <= r.z1 - m + 0.01; z += 2.5) for (let x = r.x0 + m; x <= r.x1 - m + 0.01; x += 2.7) {
      const axial = (back === 'N' || back === 'S') ? Math.abs(x - cx) < 1.5 : Math.abs(z - cz) < 1.5;
      if (axial) continue;
      if (r.kind === 'court' && (Math.abs(x - cx) < 1.3 || Math.abs(z - cz) < 1.3)) continue;
      if (Math.hypot(x - center.X, z - center.Z) < 2.6) continue;
      if (blocks.some((b) => Math.hypot(b.x - x, b.z - z) < Math.max(b.rx, b.rz) + 1.1)) continue;
      floorSlots.push({ X: x, Z: z, fx: -fin[0], fz: -fin[1] });
    }
    return { center, wallSlots, floorSlots };
  }

  function placeFiles(r, files) {
    const ip = kitOf(r), C = cols.get(keyOf(r));
    const mat = { wood: C.timber, stone: C.stone, trim: C.gold || C.accent };
    const cap = r.isHall ? CAP_HALL : CAP_ROOM;
    const imp = (f) => f.imp * 3 + Math.log2(1 + f.bytes);
    const ranked = files.map((f) => Object.assign({}, f, { role: f.role || roleOfName(f.name, f.sub) })).sort((a, b) => imp(b) - imp(a));
    const { center, wallSlots, floorSlots } = slotsFor(r);
    const room = Math.min(cap, wallSlots.length + floorSlots.length + 1);
    const hidden = ranked.length > room ? ranked.slice(room - 1) : [];
    let shown = hidden.length ? ranked.slice(0, room - 1) : ranked;
    // 坐次:互相 import 的挨着坐
    if (L.edges.length && shown.length > 2) {
      const left = new Set(shown.map((_, i) => i)), seat = [0];
      left.delete(0);
      while (left.size) {
        let best = -1, bw = -1;
        for (const c of left) {
          const nb = adj.get(shown[c].i);
          let wgt = 0;
          if (nb) for (const s of seat.slice(-4)) if (nb.has(shown[s].i)) wgt += 1 + seat.length / 100;
          if (wgt > bw || (wgt === bw && c < best)) { bw = wgt; best = c; }
        }
        left.delete(best); seat.push(best);
      }
      shown = seat.map((i) => shown[i]);
    }
    const take = (pool) => (pool.length ? pool.shift() : null);
    let usedCenter = false;
    const put = (f, slot) => {
      const lang = fileLight(f.name, f.lang || dirLang);
      const items = (f.sym || []).map((s) => ({ name: String(s[0] || ''), kind: ITEM_ICON[s[1]] ? s[1] : 'fn', line: +s[2] || 0, exported: !!s[3] }));
      const { h, w: wd } = furnSize({ lines: f.lines, bytes: f.bytes, items });
      const furn = FURN[(ROLE[f.role] || ROLE.source).furn] || FURN.cabinet;
      const res = furn({ X: slot.X, Z: slot.Z, fx: slot.fx, fz: slot.fz, w: wd, h, items, lang, mat, rnd: () => ip.rnd.f(),
                         indoor: !r.open, seed: ip.rnd.f() * 10, extra: f.extra }, S, G);
      const p = { x: slot.X, z: slot.Z, top: res.top, slots: res.slots, name: f.name, path: f.path, role: f.role, bytes: f.bytes,
                  lines: f.lines, lang: f.lang || '', langRgb: lang, sym: f.sym, imp: f.imp, out: f.out, dir: f.sub || L.name,
                  room: r.isHall ? '' : r.name, hiddenNames: f.hiddenNames || null, w: wd, i: f.i };
      props.push(p);
      if (f.i != null && f.i >= 0) byIdx.set(f.i, p);
      const onWall = !!slot.wall;
      const cx = slot.X - slot.fx * (onWall ? 0.2 : 0), cz = slot.Z - slot.fz * (onWall ? 0.2 : 0);
      const along = Math.max(0.45, wd * 0.5), deep = onWall ? 0.3 : along;
      block(cx, cz, Math.max(0.5, along), Math.max(0.5, along));
      feet.push({ x: cx, z: cz, hw: Math.abs(slot.fz) > 0.5 ? along : deep, hd: Math.abs(slot.fz) > 0.5 ? deep : along });
    };
    for (const f of shown) {
      const pref = (ROLE[f.role] || ROLE.source).place;
      let slot = null;
      if (pref === 'center' && !usedCenter) { slot = center; usedCenter = true; }
      else if (pref === 'wall') slot = take(wallSlots) || take(floorSlots);
      else slot = take(floorSlots) || take(wallSlots);
      if (!slot && !usedCenter) { slot = center; usedCenter = true; }
      if (!slot) break;
      put(f, slot);
    }
    if (hidden.length) {
      const slot = take(wallSlots) || take(floorSlots) || (!usedCenter ? center : null);
      if (slot) put({ name: fill(w.ui_more, hidden.length), role: 'archive', bytes: hidden.reduce((a, f) => a + f.bytes, 0), lines: 0, sym: [], imp: 0, out: 0,
                      extra: hidden.length, hiddenNames: hidden.map((f) => f.name), sub: r.isHall ? '' : r.name, lang: '', i: -1 }, slot);
    }
  }
  for (const [k, files] of L.byRoom) placeFiles(k ? rooms.find((r) => r.name === k && !r.isHall) || hall : hall, files);
  for (const b of tempBlocks) { const i = blocks.indexOf(b); if (i >= 0) blocks.splice(i, 1); }

  /* import 连线:地上一道淡淡的弧,从引用的一方到被引用的一方,颜色从一门语言过渡到
     另一门。一眼看过去,哪几件家具是一伙的就在地上。 */
  const thread = (a, b, bright, emit, col) => {
    const n = Math.max(12, Math.round(Math.hypot(a.x - b.x, a.z - b.z) * (bright ? 22 : 16)));
    const off = ((a.i || 0) * 0.37) % 1;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const c = col || mix(a.langRgb || [1, 1, 1], b.langRgb || [1, 1, 1], t);
      // 平时是数据流(kind 7):光顺着 import 一段段流过去,tw 带着这颗点在线上的位置;选中时是常亮的高亮线
      emit(a.x + (b.x - a.x) * t, 0.03 + Math.sin(t * Math.PI) * (bright ? 0.5 : 0.35), a.z + (b.z - a.z) * t,
           bright ? c : [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8], bright ? 0.05 : 0.04, t + off, 7);
    }
  };
  for (const [i, j] of L.edges) { const a = byIdx.get(i), b = byIdx.get(j); if (a && b) thread(a, b, false, G); }

  /* 光遇的空气:满屋慢慢往上飘的光尘;每团灯火外面两层光晕,火盆火塘冒火星;各风格一样招牌的粒子。
     焦点:主案一带白天也有一盏看不见的暖光,是全屋最亮的地方。 */
  {
    const rr = () => kitOf(hall).rnd.f(), Sk = D.sky, den = Sk.moteDen != null ? Sk.moteDen : 1.2;
    // 由代码长出来的尺度:文件越多极光越密,代码越多光柱越盛
    const hsig = sigs.get(keyOf(hall)) || {};
    const kFiles = Math.max(0.7, Math.min(1.5, 0.7 + (hsig.n || 0) / 120));
    const kBytes = Math.max(0.6, Math.min(1.6, 0.6 + Math.log10(1 + (hsig.bytes || 0) / 5000) * 0.4));
    for (const r of rooms) {
      const n = Math.round((r.x1 - r.x0) * (r.z1 - r.z0) * den * B * (r.open ? 0.5 : 1));
      const top = r.open ? 4 : r.h * 0.85;
      // 每间屋子的光尘带着它主语言的颜色(ts 蓝、py 黄……):同一种风格,代码不同,空气就不同
      const sg = sigs.get(keyOf(r)), mc = sg && sg.langRgb ? mix(Sk.mote, sg.langRgb, 0.5) : Sk.mote;
      for (let i = 0; i < n; i++) G(r.x0 + rr() * (r.x1 - r.x0), 0.2 + rr() * 0.6, r.z0 + rr() * (r.z1 - r.z0), mc, 0.025 + rr() * 0.02, top, 4);
    }
    /* 屋子里是什么代码,空气里就有什么光(按这间屋子自己的代码签名,可以叠):
         测试多 → 一层绿光从地面扫到顶,一轮一轮,像在跑测试
         文档多 → 暖白的纸屑从顶上慢慢飘落
         配置/数据多 → 地上三圈琥珀色的轨道,光沿着圈走
         界面(组件、样式)多 → 彩虹色的光尘
         类型/类多 → 顶下一片紫色的晶格
       同一种风格的两座楼,代码不一样,走进去的光就不一样。 */
    for (const r of rooms) {
      if (r.open) continue;
      const sg = sigs.get(keyOf(r));
      if (!sg || !sg.n) continue;
      const Rl = sg.roles || {}, rw = r.x1 - r.x0, rd = r.z1 - r.z0, area = rw * rd, rcx = (r.x0 + r.x1) / 2, rcz = (r.z0 + r.z1) / 2;
      if ((Rl.test || 0) >= 0.25) {
        const st = 0.4 / Math.sqrt(Math.max(0.3, B));
        for (let x = r.x0 + 0.3; x < r.x1 - 0.2; x += st) for (let z = r.z0 + 0.3; z < r.z1 - 0.2; z += st)
          G(x + (rr() - 0.5) * 0.1, 0.05, z + (rr() - 0.5) * 0.1, [0.4, 1, 0.66], 0.03, r.h * 0.9, 9);
      }
      if ((Rl.docs || 0) >= 0.25) for (let i = 0; i < area * 2.2 * B; i++)
        G(r.x0 + rr() * rw, r.h - 0.3, r.z0 + rr() * rd, [1, 0.93, 0.8], 0.035 + rr() * 0.02, -(r.h - 0.4), 4);
      if ((sg.cfg || 0) >= 0.25) for (const [k, rad] of [[0, 0.9], [1, 1.5], [2, 2.1]]) {
        const Rg = Math.min(rad, Math.min(rw, rd) * 0.35), n = Math.round(Rg * 70);
        for (let i = 0; i < n; i++) { const a = i / n * 6.2832; G(rcx + Math.cos(a) * Rg, 0.06, rcz + Math.sin(a) * Rg, [1, 0.72, 0.3], 0.035, i / n + k * 0.3, 7); }
      }
      if ((sg.ui || 0) >= 0.3) for (let i = 0; i < area * 1.6 * B; i++) {
        const hh = rr(), c = [0.5 + 0.5 * Math.cos(6.2832 * hh), 0.5 + 0.5 * Math.cos(6.2832 * (hh + 0.33)), 0.5 + 0.5 * Math.cos(6.2832 * (hh + 0.67))];
        G(r.x0 + rr() * rw, 0.3 + rr() * 0.8, r.z0 + rr() * rd, c, 0.03 + rr() * 0.02, r.h * 0.8, 4);
      }
      if ((sg.cls || 0) >= 0.45 && r.h >= 3.2) for (let x = r.x0 + 0.8; x < r.x1 - 0.5; x += 1.2) for (let z = r.z0 + 0.8; z < r.z1 - 0.5; z += 1.2) for (let y = r.h - 1.6; y < r.h - 0.4; y += 0.6) {
        G(x, y, z, [0.72, 0.62, 1], 0.05, 0.8, 2);
        for (let q = 1; q < 5; q++) { G(x + q * 0.24, y, z, [0.36, 0.3, 0.55], 0.018, 0.2, 2); G(x, y, z + q * 0.24, [0.36, 0.3, 0.55], 0.018, 0.2, 2); }
      }
    }
    for (const l of lights.slice()) {
      G(l.x, l.y, l.z, l.col.map((v) => v * 0.45), 0.3, 0.3, 1);
      G(l.x, l.y, l.z, l.col.map((v) => v * 0.12), 1.1, 0.1, 1);
      // 每团火上一小柱火星,夜里一直往上飘(和主案那柱光一样的动法)
      if (l.flame) for (let i = 0; i < 70; i++) G(l.x + (rr() - 0.5) * 0.4, l.y - 0.2, l.z + (rr() - 0.5) * 0.4, rr() < 0.3 ? [1, 0.85, 0.5] : [1, 0.55, 0.22], 0.022 + rr() * 0.015, 3 + rr() * 3, 5);
    }
    const hx0 = (hall.x0 + hall.x1) / 2, hz0 = (hall.z0 + hall.z1) / 2, hw = Math.min(hall.x1 - hall.x0, hall.z1 - hall.z0);
    if (!L.open && styleId === 'persia') for (let i = 0; i < 150 * B; i++) {           // 穹顶下一圈慢慢闪的星点
      const a = rr() * 6.2832, q = Math.sqrt(rr()) * hw * 0.4;
      G(hx0 + Math.cos(a) * q, hall.h - 0.4 - rr() * 1.4, hz0 + Math.sin(a) * q, [0.9, 0.95, 1], 0.03, 1, 2);
    }
    if (!L.open && styleId === 'hellas') for (let i = 0; i < 18; i++) {                // 天眼光柱里慢慢绕的光团(云野的光蝶)
      const a = rr() * 6.2832, q = 0.5 + rr() * 1.8;
      G(hx0 + Math.cos(a) * q, 0.8 + rr() * 2, hz0 + Math.sin(a) * q, [0.94, 0.96, 1], 0.06, 3.5, 4);
    }
    if (!L.open && styleId === 'norse') for (let i = 0; i < 200 * B; i++)              // 从烟孔飘下来的雪
      G(hx0 + (rr() - 0.5) * 1.4, hall.h + 1.5, hz0 + (rr() - 0.5) * 1.4, [0.96, 0.97, 1], 0.025, -(hall.h + 1.3), 4);
    if (!L.open) {
      /* 极光丝带:大殿高处三条发光的粒子带,这个风格的点睛色、第二点睛色、金色各一条;
         下缘最亮、往上渐淡(真极光就是这样),顶点着色器让它们一直慢慢飘 */
      // 每种风格三条带子用它自己最有代表性的三种颜色(一冷一暖一金),不再一律青蓝
      const P = D.pal, AURS = {
        tang: [P.accent, P.struct, P.gold], edo: [P.accent, P.accent2, [0.55, 0.78, 0.62]], giza: [P.accent, P.accent2, P.gold],
        hellas: [P.accent, P.accent2, P.gold], maya: [P.accent, P.field, P.gold], persia: [P.accent2, P.accent, P.gold],
        norse: [P.accent2, P.accent, P.gold], modern: [P.gold, [0.92, 0.6, 0.52], [0.6, 0.72, 0.96]],
      };
      const AUR = AURS[styleId] || [P.accent, P.accent2, P.gold];
      for (let k = 0; k < 3; k++) {
        // 只放在大殿后面三分之二:离镜头远,整条带子都在画面里,也不会贴着脸飘过去
        const c = AUR[k], yb = hall.h * (0.58 + k * 0.08), n = Math.round(5200 * B * kFiles), zc = hz0 - hw * 0.25 + k * hw * 0.15;
        for (let i = 0; i < n; i++) {
          const t = rr(), v = rr(), x = hall.x0 + 1 + t * (hall.x1 - hall.x0 - 2);
          const y = yb + v * 1.2 * (0.6 + 0.4 * Math.sin(t * 9 + k)), z = zc + Math.sin(t * 8.2 + k * 2) * hw * 0.12;
          // 矮的屋子(江户、北欧、现代)极光就在头顶,亮度按层高打折,不然整间屋子被淹成白的
          const br = (0.3 + 0.7 * Math.pow(1 - v, 2)) * 2.6 * Math.max(0.35, Math.min(1, (hall.h - 3) / 4));
          G(x, y, z, [c[0] * br, c[1] * br, c[2] * br], 0.07 + rr() * 0.07, k * 2.1, 6);
        }
      }
      /* 光之泉:主案上一柱不停往上飘的金色粒子,直通屋顶 —— 全屋的中心 */
      const fz = hall.z0 + 2.05, fc = [0.9 * D.pal.gold[0] + 0.1, 0.9 * D.pal.gold[1] + 0.06, 0.9 * D.pal.gold[2]].map((v) => v * 1.1);
      for (let i = 0; i < 3000 * B * kBytes; i++) {
        const a = rr() * 6.2832, q = Math.sqrt(rr()) * 0.9;
        G(hx0 + Math.cos(a) * q, 0.3 + rr() * 0.5, fz + Math.sin(a) * q, fc.map((v) => v * 2), 0.06 + rr() * 0.05, hall.h * (0.7 + rr() * 0.3), 4);
      }
      // 光柱本身:沿柱子叠几层大而软的光晕,从地一直亮到顶
      for (let y = 0.4; y < hall.h; y += 0.6) G(hx0, y, fz, fc.map((v) => v * 0.3 * (1 - 0.6 * y / hall.h)), 1.7, 0.15, 2);
      /* 代码光环:这座楼里真实的函数、类名(导出的优先,每个文件最多两个),写成粒子字排成一圈,
         绕大殿中轴慢慢转;每个名字是它那个文件的语言色。代码不同,这一圈字就不同 ——
         这是这间屋子自己的铭文(Anadol:数据就是颜料,而且一直在流动)。 */
      const words = [];
      for (const pr of props) {
        const syms = (pr.sym || []).slice().sort((x, y) => (y[3] ? 1 : 0) - (x[3] ? 1 : 0));
        const picks = syms.length ? syms.slice(0, 2).map((s) => String(s[0] || '')) : [String(pr.name || '')];
        for (const w0 of picks) if (w0 && words.length < 28) words.push({ t: w0.slice(0, 22), c: pr.langRgb || [0.8, 0.9, 1] });
      }
      if (words.length && typeof document !== 'undefined') {
        const cv = document.createElement('canvas'), c2 = cv.getContext('2d', { willReadFrequently: true });
        const R = Math.min(hw * 0.34, 5.2), y0 = Math.max(2.4, Math.min(3.6, hall.h * 0.42)), M = 1 / 110, FNT = '600 34px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        // 从正对进门的那一侧(大殿里头)开始,角度往前走 —— 从门口、从圈里看,字都是正着读的
        let ang = -Math.PI / 2 - 0.6;
        for (const wd of words) {
          c2.font = FNT;
          const tw = Math.ceil(c2.measureText(wd.t).width) + 8, span = tw * M;
          if (ang + Math.PI / 2 + 0.6 + span / R > 6.1) break;
          cv.width = tw; cv.height = 44;
          c2.font = FNT; c2.fillStyle = '#fff'; c2.textBaseline = 'top'; c2.fillText(wd.t, 4, 4);
          const img = c2.getImageData(0, 0, tw, 44).data;
          for (let yy = 0; yy < 44; yy += 2) for (let xx = 0; xx < tw; xx += 2) {
            if (img[(yy * tw + xx) * 4 + 3] < 120) continue;
            const th = ang + (xx * M) / R;
            G(hx0 + Math.cos(th) * R, y0 + (44 - yy) * M, hz0 + Math.sin(th) * R, [wd.c[0] * 1.5, wd.c[1] * 1.5, wd.c[2] * 1.5], 0.028, 0.35, 8);
          }
          ang += span / R + 0.75 / R;
        }
      }
    }
    if (L.open) {
      // 露天:三条极光挂在院子北边的夜空里,横过整个院子(白天淡、夜里亮)
      const AUR2 = [D.pal.accent, D.pal.accent2, D.pal.gold];
      for (let k = 0; k < 3; k++) {
        const c = AUR2[k], n = Math.round(6000 * B);
        for (let i = 0; i < n; i++) {
          const t = rr(), v = rr(), x = -30 + t * 60, y = 8 + k * 1.8 + v * 2.5, z = -18 - k * 5 + Math.sin(t * 5 + k) * 6;
          const br = (0.3 + 0.7 * Math.pow(1 - v, 2)) * 2.6;
          G(x, y, z, [c[0] * br, c[1] * br, c[2] * br], 0.18 + rr() * 0.15, k * 2.1, 6);
        }
      }
    }
    // 代码光环绕着转的中轴(x, z)和转速(弧度/秒)
    U.uHaloC = { value: new THREE.Vector3(hx0, hz0, 0.05) };
    const sI = D.light.sunI, skc = kelvin(D.light.sunK);
    U.uFocal.value.set(hx0, 1.6, hall.z0 + 2.05, L.open ? 0 : 4.5);
    U.uFocalC.value.set(skc[0] * sI * 0.15, skc[1] * sI * 0.15, skc[2] * sI * 0.15);
    U.uWashH.value = Math.max(2.5, hall.h);
  }

  setScene(U, { lights, rooms: rooms.map((r) => ({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, h: r.h, open: r.open })), feet,
                court: L.open ? { x0: hall.x0, z0: hall.z0, x1: hall.x1, z1: hall.z1, h: 4.4 } : null, rocks, windows });
  const flames = lights.slice(0, 24).map((l, i) => (l.flame ? { i, base: U.uLC.value[i].clone() } : null)).filter(Boolean);

  /* ── 渲染 ── */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
  const group = S.build(U);
  scene.add(group);
  let freeShadow = null;
  try {
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity, by = 0;
    for (const r of rooms) { bx0 = Math.min(bx0, r.x0); bx1 = Math.max(bx1, r.x1); bz0 = Math.min(bz0, r.z0); bz1 = Math.max(bz1, r.z1); by = Math.max(by, r.h); }
    freeShadow = renderShadowMap(renderer, U, group, { x0: bx0 - 2, z0: bz0 - 2, x1: bx1 + 2, z1: bz1 + 2, y1: by + 6 }, B >= 0.9 ? 2048 : 1024);
  } catch (e) { U.uShadowOn.value = 0; }

  /* 地面倒影(teamLab 的镜面地):屋里每个高于地面的发光点 —— 灯、火、光柱、极光、光环、
     数据流 —— 在地下再放一颗,相位也一样,顶点着色器按 y < 0 认出它、同步动画、压暗。
     地面的粒子之间留着黑缝,倒影就从缝里透上来,像一层湿的石头。 */
  if (!L.open) {
    const n0 = NL;
    for (let i = 0; i < n0 && NL < MAXL; i++) {
      const y = lPos[i * 3 + 1];
      if (y < 0.15) continue;
      G(lPos[i * 3], -y, lPos[i * 3 + 2], [lCol[i * 3], lCol[i * 3 + 1], lCol[i * 3 + 2]], lSiz[i], lTwk[i], lKind[i]);
      lPha[NL - 1] = lPha[i];
    }
  }
  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute('position', new THREE.BufferAttribute(lPos.subarray(0, NL * 3), 3));
  lGeo.setAttribute('aColor', new THREE.BufferAttribute(lCol.subarray(0, NL * 3), 3));
  lGeo.setAttribute('aSize', new THREE.BufferAttribute(lSiz.subarray(0, NL), 1));
  lGeo.setAttribute('aPhase', new THREE.BufferAttribute(lPha.subarray(0, NL), 1));
  lGeo.setAttribute('aTwk', new THREE.BufferAttribute(lTwk.subarray(0, NL), 1));
  lGeo.setAttribute('aKind', new THREE.BufferAttribute(lKind.subarray(0, NL), 1));
  const lMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending });
  const glow = new THREE.Points(lGeo, lMat);
  glow.frustumCulled = false; glow.renderOrder = 1;
  scene.add(glow);
  // 选中的那件家具:它用到的(绿)和用到它的(琥珀)连成亮线。选中时重建,一件家具最多几十条。
  let selGlow = null;
  const selMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  function highlight(p) {
    if (selGlow) { scene.remove(selGlow); selGlow.geometry.dispose(); selGlow = null; }
    if (!p || p.i == null || p.i < 0) return;
    const pts = [];
    const emit = (x, y, z, c, s, tw, k) => pts.push([x, y, z, c, s, tw, k]);
    for (const [i, j] of L.edges) {
      if (i === p.i && byIdx.get(j)) thread(p, byIdx.get(j), true, emit, [0.79, 0.94, 0.24]);
      else if (j === p.i && byIdx.get(i)) thread(byIdx.get(i), p, true, emit, [1, 0.72, 0.3]);
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    const f32 = (k, fn) => { const a = new Float32Array(pts.length * k); pts.forEach((q, n) => fn(a, n, q)); return a; };
    g.setAttribute('position', new THREE.BufferAttribute(f32(3, (a, n, q) => { a[n * 3] = q[0]; a[n * 3 + 1] = q[1]; a[n * 3 + 2] = q[2]; }), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(f32(3, (a, n, q) => { a[n * 3] = q[3][0]; a[n * 3 + 1] = q[3][1]; a[n * 3 + 2] = q[3][2]; }), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(f32(1, (a, n, q) => { a[n] = q[4]; }), 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(f32(1, (a, n) => { a[n] = n / pts.length; }), 1));
    g.setAttribute('aTwk', new THREE.BufferAttribute(f32(1, (a, n, q) => { a[n] = q[5]; }), 1));
    // 选中的那件,它的 import 线也是数据流(kind 7):光从它流向它引用的文件、从引用它的文件流进来
    g.setAttribute('aKind', new THREE.BufferAttribute(f32(1, () => {}).fill(7), 1));
    selGlow = new THREE.Points(g, selMat);
    selGlow.frustumCulled = false; selGlow.renderOrder = 2;
    scene.add(selGlow);
  }

  const prevAutoClear = renderer.autoClear;
  const prevPR = renderer.getPixelRatio();
  const wantPR = opts.pixelRatio || Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const size0 = renderer.getSize(new THREE.Vector2());
  let W = size0.x || 1, H = size0.y || 1;
  if (wantPR !== prevPR) { renderer.setPixelRatio(wantPR); renderer.setSize(W, H, false); }
  const crt = new THREE.WebGLRenderTarget(Math.max(1, W * renderer.getPixelRatio()), Math.max(1, H * renderer.getPixelRatio()), { type: THREE.HalfFloatType });
  crt.depthTexture = new THREE.DepthTexture(crt.width, crt.height);
  const composer = new EffectComposer(renderer, crt);
  // 两块来回倒的画布各要一张自己的深度图:共用一张时,调色那一道一边读深度一边往带着
  // 同一张深度图的画布上写,WebGL 判成"反馈回路",整帧画不出来(全黑)
  composer.renderTarget2.depthTexture = new THREE.DepthTexture(crt.width, crt.height);
  composer.addPass(new RenderPass(scene, camera));
  const grade = new GradePass(U, camera, D.light.grade);
  composer.addPass(grade);
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.5, 0.85, 0.7);
  composer.addPass(bloom);

  /* ── 白天 / 夜里 / 天气 ──
     天(天穹、云、雨雪、闪电)由 room-atmos.js 画:露天是整片天,屋里只在窗外。 */
  scene.background = new THREE.Color();
  let night = env.night;
  const atmos = createAtmosphere({ open: L.open, windows, roofs: L.open ? rooms.filter((r) => !r.isHall) : [], budget: B, uPx: U.uPx, reduceMotion });
  scene.add(atmos.group);
  atmos.setEnv(env, U.uSunDir.value);
  function applyTime() {
    U.uNight.value = night;
    const mixc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const sc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
    let away, sun;
    if (L.open) {
      // 露天:远处融进外面那片天的地平线色,朝太阳那边是光晕的暖 —— 白天就是蓝天白云底下的院子
      away = mixc(mixc(env.hor, Sk.fogAway, 0.3), sc(Sk.fogNight, 0.3), night);
      sun = mixc(mixc(env.glow, Sk.fogSun, 0.4), sc(Sk.fogNight, 0.3), night);
    } else {
      /* 屋里仍是 Terse 壁纸的底:近黑,只带这个风格一点点色调。点与点之间露出来的是黑 ——
         粒子是在黑里发光的(底色一旦是"暗的主题色",sRGB 下会变成一整片灰紫)。天在窗里。 */
      away = mixc(sc(Sk.zenith, 0.07), sc(Sk.fogNight, 0.3), night); sun = mixc(sc(Sk.fogSun, 0.09), sc(Sk.fogNight, 0.3), night);
    }
    scene.background.setRGB(...away);
    U.uFogAway.value.set(...away); U.uFogSun.value.set(...sun);
    U.uFogA.value = Sk.fogA * (L.open ? 0.4 : 0.5) * (1 + 0.2 * night) * (1 + (L.open ? 2.5 : 0.8) * env.fx.fog); U.uFogB.value = Sk.fogB;
    // 露天的院子白天整片是天光,曝光低一点,不然白砂和白墙一起烧成白的
    const ex = D.light.exposure;
    // 大殿白天压暗两成:光柱、极光、光斑、灯才跳得出来(暗里发光才震撼)
    U.uExposure.value = (L.open ? 0.9 : ex[0] * 0.8) * (1 - night) + (L.open ? 1.2 : ex[1]) * night;
    U.uSat.value = 1.35 - 0.05 * night; U.uLift.value = 0.0;
    // 辉光:壁纸是同一份粒子再画一层大而软的加性孪生;这里用泛光做同一件事 —— 亮的粒子都晕开一点
    // 露天的白天整片是亮的天:阈值抬高,只有太阳和真正的光晕开;屋里照旧
    if (L.open) { bloom.strength = 0.55 + 0.6 * night; bloom.threshold = 0.82 - 0.39 * night; }
    else { bloom.strength = 0.85 + 0.3 * night; bloom.threshold = 0.55 - 0.12 * night; }
    bloom.radius = 0.6;
    const gu = grade.mat.uniforms, gd = D.light.grade;
    gu.uHalo.value.set(...away); gu.uHaloK.value = 0.0; gu.uVig.value = 0.7 + 0.3 * night;
    gu.uVigCol.value.set(...mixc([0.55, 0.56, 0.62], [0.45, 0.46, 0.55], night));
    gu.uTop.value.set(0, 0, 0);
    gu.uSh.value.set(...mixc(gd.sh, [0.9, 0.95, 1.12], night)); gu.uHi.value.set(...mixc(gd.hi, [1.08, 1.0, 0.9], night));
  }

  /* ── 走 ── */
  let yaw = L.start.yaw, pitch = -0.04, px = L.start.x, pz = L.start.z, t = 0;
  // 从隔壁那座楼走过来:站在通回去的那座门框前,背对着它
  {
    const f = opts.arrive && frames.find((x) => x.link.name === opts.arrive);
    if (f) { px = f.x + f.nx * 1.5; pz = f.z + f.nz * 1.5; yaw = Math.atan2(-f.nx, -f.nz); f.s0 = 1.5; }
  }
  let lastStepX = px, lastStepZ = pz;   // 脚步涟漪:上一步落在哪
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  const keys = new Set();
  const move = { x: 0, z: 0 };
  const offs = [];
  const on = (el, type, fn, o) => { el.addEventListener(type, fn, o); offs.push(() => el.removeEventListener(type, fn, o)); };
  const chrome = (e) => e.target && e.target.closest && e.target.closest('button, a, .room-joy, .room-side, .room-legend');

  const walkable = (x, z) => {
    let ok = false;
    for (const r of rooms) if (x > r.x0 + PAD && x < r.x1 - PAD && z > r.z0 + PAD && z < r.z1 - PAD) { ok = true; break; }
    if (!ok) for (const d of doors) if (x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1) { ok = true; break; }
    if (!ok) return false;
    for (const b of blocks) if (((x - b.x) / b.rx) ** 2 + ((z - b.z) / b.rz) ** 2 < 1) return false;
    return true;
  };
  const roomAt = (x, z) => rooms.find((r) => !r.isHall && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) || hall;

  on(input, 'pointerdown', (e) => {
    if (chrome(e)) return;
    dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY;
    try { input.setPointerCapture(e.pointerId); } catch (err) {}
  });
  const endDrag = () => { dragging = false; };
  on(window, 'pointerup', endDrag);
  on(window, 'pointercancel', endDrag);
  on(window, 'blur', () => { dragging = false; keys.clear(); });
  on(window, 'pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.0035;
    pitch = Math.max(-1.1, Math.min(1.1, pitch - (e.clientY - lastY) * 0.0035));
    lastX = e.clientX; lastY = e.clientY;
  });
  const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  on(window, 'keydown', (e) => { if (!typing(e)) keys.add(e.key.toLowerCase()); });
  on(window, 'keyup', (e) => keys.delete(e.key.toLowerCase()));

  const els = [];
  const el = (tag, cls, parent) => { const x = document.createElement(tag); if (cls) x.className = cls; (parent || host).appendChild(x); if (!parent) els.push(x); return x; };

  if (opts.joystick || (typeof window !== 'undefined' && 'ontouchstart' in window)) {
    const joy = el('div', 'room-joy');
    const stick = el('i', '', joy);
    let id = null;
    on(joy, 'touchstart', (e) => { id = e.changedTouches[0].identifier; e.preventDefault(); }, { passive: false });
    on(joy, 'touchmove', (e) => {
      for (const tt of e.changedTouches) {
        if (tt.identifier !== id) continue;
        const b = joy.getBoundingClientRect();
        const jx = Math.max(-1, Math.min(1, (tt.clientX - (b.left + b.width / 2)) / (b.width / 2)));
        const jy = Math.max(-1, Math.min(1, (tt.clientY - (b.top + b.height / 2)) / (b.height / 2)));
        stick.style.left = 35 + jx * 25 + 'px'; stick.style.top = 35 + jy * 25 + 'px';
        move.x = jx; move.z = jy; e.preventDefault();
      }
    }, { passive: false });
    const off = (e) => { for (const tt of e.changedTouches) if (tt.identifier === id) { id = null; move.x = move.z = 0; stick.style.left = stick.style.top = '35px'; } };
    on(joy, 'touchend', off); on(joy, 'touchcancel', off);
  }

  /* ── 读法:地图、图例、昼夜 ── */
  const side = el('div', 'room-side');
  const map = el('canvas', 'room-map', side);
  const btns = el('div', 'room-btns', side);
  const timeBtn = el('button', 'room-btn', btns);
  const wxBtn = el('button', 'room-btn', btns);
  const seasonBtn = el('button', 'room-btn', btns);
  const legendBtn = el('button', 'room-btn', btns);
  timeBtn.type = wxBtn.type = seasonBtn.type = legendBtn.type = 'button';
  legendBtn.textContent = '❔ ' + w.ui_legend;
  const legend = el('div', 'room-legend', side);
  legend.hidden = true;
  const usedRoles = [...new Set(props.map((p) => p.role))];
  const usedKinds = [...new Set(props.flatMap((p) => (p.sym || []).map((s) => (ITEM_ICON[s[1]] ? s[1] : 'fn'))))];
  legend.innerHTML = `<b>${w.lg_title}</b><p>🚪 ${w.lg_room}</p><p>🪑 ${w.lg_furn}</p><p>📕 ${w.lg_item}</p><p>📏 ${w.lg_size}</p>`
    + (frames.length || portal ? `<p>🌀 ${w.lg_links}</p>` : '')
    + (L.edges.length ? `<p>✨ ${w.lg_threads}</p>` : '')
    + `<h4>${w.lg_roles}</h4>` + usedRoles.map((r) => `<div class="row"><span class="dot" style="background:${ROLE_COLOR[r]}"></span>${ROLE_ICON[r] || ''} <span><b style="display:inline;font-size:12px">${w['role_' + r] || r}</b> — ${w['furn_' + r] || ''}</span></div>`).join('')
    + (usedKinds.length ? `<h4>${w.lg_items}</h4>` + usedKinds.map((k) => `<div class="row">${ITEM_ICON[k]} <span>${w['shape_' + k]} = ${w['item_' + k]}</span></div>`).join('') : '')
    + (L.hasSymbols ? '' : `<p style="opacity:.7;margin-top:8px">${w.ui_no_symbols}</p>`)
    + (L.truncated ? `<p style="opacity:.7">${w.ui_truncated}</p>` : '');
  on(legendBtn, 'click', () => { legend.hidden = !legend.hidden; });
  const paintTimeBtn = () => {
    const h = Math.floor(env.hour), m = Math.floor((env.hour - h) * 60);
    const icon = night > 0.5 ? '🌙 ' : env.phase === 'day' ? '☀️ ' : '🌅 ';
    timeBtn.textContent = timeMode === 'auto' ? icon + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
      : timeMode === 'night' ? '🌙 ' + w.ui_night : '☀️ ' + w.ui_day;
    wxBtn.textContent = (WEATHER_ICON[env.weather] || '') + ' ' + (w['wx_' + env.weather] || env.weather);
    seasonBtn.textContent = (SEASON_ICON[env.season] || '') + ' ' + (w['season_' + env.season] || env.season);
  };
  on(timeBtn, 'click', () => setTime(timeMode === 'auto' ? 'day' : timeMode === 'day' ? 'night' : 'auto'));
  on(wxBtn, 'click', () => { wxPick = WEATHERS[(WEATHERS.indexOf(env.weather) + 1) % WEATHERS.length]; refreshEnv(true); });
  on(seasonBtn, 'click', () => { seasonPick = SEASONS[(SEASONS.indexOf(env.season) + 1) % SEASONS.length]; refreshEnv(true); });

  const toast = el('div', 'room-toast');
  toast.style.opacity = '0';
  let toastUntil = 0;

  /* ── 文字也是粒子:门牌、家具名牌、选中件上每件东西的名字 ───────────────────
     和 Terse 壁纸的字形层同一手法:字先画在一张画布上,CPU 采出笔画上的像素,每个像素一颗
     柔光点(同一张径向渐变);点永远正对着人,各自慢慢闪;第一次出现时从四周聚拢;辉光是同一
     份点再画一遍,更大、更软、加性叠加。字浮在最上层,不参与遮挡。 */
  const camR = { value: new THREE.Vector3(1, 0, 0) }, camU = { value: new THREE.Vector3(0, 1, 0) };
  const textLayer = new THREE.Group();
  scene.add(textLayer);
  const textGeos = new Map(), textMats = [];
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const hr = (i) => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;   // 可复现的抖动,不用 Math.random
  function textGeo(key, lines) {
    let g = textGeos.get(key);
    if (g) return g;
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
    const PAD = 4, font = (l) => `${l.w || 600} ${l.px}px ${FONT}`;
    let wMax = 0, hSum = PAD * 2;
    for (const l of lines) { ctx.font = font(l); wMax = Math.max(wMax, ctx.measureText(l.t).width); hSum += l.px * 1.22; }
    cv.width = Math.max(2, Math.ceil(wMax + PAD * 2)); cv.height = Math.max(2, Math.ceil(hSum));
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    let y = PAD;
    for (const l of lines) { ctx.font = font(l); ctx.fillStyle = l.col; ctx.fillText(l.t, cv.width / 2, y); y += l.px * 1.22; }
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data, M = 1 / 64;
    const pos = [], col = [], rnd = [];
    let i = 0;
    for (let yy = 0; yy < cv.height; yy++) for (let xx = 0; xx < cv.width; xx++) {
      const k = (yy * cv.width + xx) * 4;
      if (img[k + 3] < 110) continue;
      // 抖一下,不排成像素格;底边在 y = 0(锚点是字的底边中点,和原来的名牌一样)
      pos.push((xx - cv.width / 2 + hr(i * 3) - 0.5) * M, (cv.height - yy + hr(i * 3 + 1) - 0.5) * M, M * 1.7);
      col.push(img[k] / 255, img[k + 1] / 255, img[k + 2] / 255);
      rnd.push(hr(i * 3 + 2)); i++;
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aRand', new THREE.Float32BufferAttribute(rnd, 1));
    textGeos.set(key, g);
    return g;
  }
  function textSlot() {
    const u = { uAnchor: { value: new THREE.Vector3() }, uRight: camR, uUp: camU, uScale: { value: 0.3 }, uPx: U.uPx, uTime: U.uTime,
                uAlpha: { value: 0 }, uForm: { value: 0 }, uK: { value: 1 }, uGlow: { value: 1 }, uSoft: { value: 0 } };
    const ub = Object.assign({}, u, { uK: { value: 0.4 }, uGlow: { value: 2.6 }, uSoft: { value: 1 } });
    const mk = (uu, add) => {
      const m = new THREE.ShaderMaterial({ uniforms: uu, vertexShader: TEXT_VS, fragmentShader: TEXT_FS, transparent: true,
        depthWrite: false, depthTest: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending });
      textMats.push(m); return m;
    };
    const blank = new THREE.BufferGeometry();
    const glow = new THREE.Points(blank, mk(ub, true)), core = new THREE.Points(blank, mk(u, false));
    glow.frustumCulled = core.frustumCulled = false; glow.renderOrder = 20; core.renderOrder = 21;
    glow.visible = core.visible = false;
    textLayer.add(glow, core);
    return {
      key: null,
      show(key, lines, at, scale, alpha, dt) {
        if (this.key !== key) { glow.geometry = core.geometry = textGeo(key, lines()); this.key = key; u.uForm.value = 0; }
        u.uForm.value = Math.min(1, u.uForm.value + dt * 2.4);
        u.uAnchor.value.set(at[0], at[1], at[2]); u.uScale.value = scale; u.uAlpha.value = alpha;
        glow.visible = core.visible = true;
      },
      hide() { glow.visible = core.visible = false; this.key = null; },
    };
  }
  /** 一组粒子字:按内容认槽位,同一块牌子每帧用同一个槽位(不会闪着重新聚);这一帧没用到的收回去。 */
  function textPool() {
    const free = [], live = new Map();
    let used = new Set();
    return {
      frame() { used = new Set(); },
      put(key, lines, at, scale, alpha, dt) {
        let s = live.get(key);
        if (!s) { s = free.pop() || textSlot(); live.set(key, s); }
        s.show(key, lines, at, scale, alpha, dt); used.add(key);
      },
      end() { for (const [k, s] of live) if (!used.has(k)) { s.hide(); live.delete(k); free.push(s); } },
    };
  }
  const plaquePool = textPool(), labelPool = textPool(), tagPool = textPool();

  /* 门牌:每扇门上挂一块,写着门后是哪个子目录、有多少文件 —— 金色的粒子字。 */
  const plaques = doors.map((d) => {
    const r = rooms.find((x) => x.name === d.room && !x.isHall);
    return { d, key: 'door:' + d.room + '|' + d.cx.toFixed(2) + '|' + d.cz.toFixed(2),
             lines: () => [{ t: d.room + '/', px: 44, w: 700, col: '#F6E3A6' }, { t: fill(w.ui_files, r ? r.files : 0), px: 28, w: 500, col: '#CDBB88' }],
             y: Math.min(3.0, (L.open ? 3.4 : hall.h) * 0.74) + 0.45 };
  });
  // 隔壁那座楼的门框:门楣上写它叫什么;传送门:写它通向哪个项目(setPortal 之前是"随机传送门")
  for (const f of frames) plaques.push({ d: { cx: f.x, cz: f.z }, key: 'link:' + f.link.name + '|' + f.x.toFixed(2) + '|' + f.z.toFixed(2),
    lines: () => [{ t: '→ ' + f.link.name + '/', px: 44, w: 700, col: '#DDF6FF' }, { t: fill(w.ui_link, f.link.files || 0), px: 28, w: 500, col: '#A9C9D6' }], y: 3.4 });
  if (portal) plaques.push({ d: { cx: portal.x, cz: portal.z }, get key() { return 'portal:' + (portal.target ? portal.target.title : ''); },
    lines: () => [{ t: '✦ ' + (portal.target ? portal.target.title : w.ui_portal), px: 42, w: 700, col: '#E9DDFF' },
                  { t: portal.target ? w.ui_portal : w.ui_portal_sub, px: 28, w: 500, col: '#B9A8E0' }], y: 2.65 });

  const rectOf = () => { try { return renderer.domElement.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0 }; } };
  const tmp = new THREE.Vector3();
  const toScreen = (x, y, z) => {
    tmp.set(x, y, z).project(camera);
    const rc = rectOf();
    return { x: rc.left + (tmp.x * 0.5 + 0.5) * W, y: rc.top + (-tmp.y * 0.5 + 0.5) * H, behind: tmp.z > 1 };
  };

  let selected = null;
  on(input, 'click', (e) => {
    if (chrome(e) || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    let best = null, bd = 90;
    for (const p of props) {
      const dist = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
      if (dist > 14) continue;
      const s = toScreen(p.x, (p.top[1] - 0.3) * 0.6, p.z);
      if (s.behind) continue;
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY) * (0.6 + dist / 20);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) {
      // 点在空处:一圈光从点到的那块地上荡开
      const rc = rectOf(), nx = ((e.clientX - rc.left) / W) * 2 - 1, ny = -((e.clientY - rc.top) / H) * 2 + 1;
      const v = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
      if (v.y < -0.02) { const k = -camera.position.y / v.y; U.uPick.value.set(camera.position.x + v.x * k, camera.position.z + v.z * k, U.uTime.value, 0.8); }
    }
    select(best);
    if (best && opts.onPick) { try { opts.onPick(best, describe(best)); } catch (err) {} }
  });
  function select(p) {
    selected = p || null; highlight(selected);
    // 一圈光从它那里扫开(表面和发光点两边的着色器都认 uPick)
    if (selected) U.uPick.value.set(selected.x, selected.z, U.uTime.value, 1);
  }

  const labels = [], itemTags = [];   // 名牌和符号签已经换成粒子字(textPool);空数组留给 dispose

  function step(dt, fwd, strafe) {
    const s = 3.4 * dt, sin = Math.sin(yaw), cos = Math.cos(yaw);
    const dx = (-sin * fwd + cos * strafe) * s, dz = (-cos * fwd - sin * strafe) * s;
    if (walkable(px + dx, pz)) px += dx;
    if (walkable(px, pz + dz)) pz += dz;
  }

  /** 这间屋子为什么长这样 —— 从装修挑件时记下的理由里拿,最多说两条。 */
  const whyOf = (r) => {
    const ip = kitOf(r);
    if (!ip) return [];
    const rs = [...new Set([ip.mood && ip.mood.why, ip.why.ceil, ip.why.light, ip.why.floor].filter(Boolean))];
    return rs.slice(0, 2).map((k) => w['why_' + k]).filter(Boolean);
  };
  const hereInfo = (r) => {
    const ip = kitOf(r);
    const base = L.name.replace(/\/?$/, '/');
    return { name: r.name, isHall: !!r.isHall, files: r.files, kind: r.kind, path: r.isHall ? base : base + r.name + '/', style: ip && ip.style.id, why: whyOf(r) };
  };
  let hereNow = null;

  /** 一件家具说的是什么 —— 卡片、图例都从这里拿词,宿主只管排版。 */
  function describe(p) {
    const stats = [];
    if (p.lines) stats.push(fill(w.ui_lines, p.lines));
    if (p.bytes) stats.push(fmtBytes(p.bytes));
    if (p.imp) stats.push(fill(w.ui_used_by, p.imp));
    if (p.out) stats.push(fill(w.ui_uses, p.out));
    const items = (p.sym || []).map((s) => {
      const kind = ITEM_ICON[s[1]] ? s[1] : 'fn';
      return { icon: ITEM_ICON[kind], name: String(s[0] || ''), kind: w['item_' + kind], shape: w['shape_' + kind], line: +s[2] || 0, exported: !!s[3] };
    });
    const uses = [], usedBy = [];
    if (p.i != null && p.i >= 0) for (const [i, j] of L.edges) {
      if (i === p.i && byIdx.get(j)) uses.push(byIdx.get(j).name);
      else if (j === p.i && byIdx.get(i)) usedBy.push(byIdx.get(i).name);
    }
    return {
      icon: ROLE_ICON[p.role] || '', color: ROLE_COLOR[p.role] || '#fff', title: p.name,
      path: p.path || (p.dir ? p.dir.replace(/\/?$/, '/') : '') + p.name,
      role: w['role_' + p.role] || p.role, furn: w['furn_' + p.role] || '',
      stats: stats.join(' · '), defines: items.length ? fill(w.ui_defines, items.length) : '',
      items, uses, usedBy, usesWord: w.ui_uses_list, usedByWord: w.ui_used_by_list,
      note: p.role === 'archive' ? (p.hiddenNames || []).slice(0, 40).join(', ') : (p.sym === null ? w.ui_no_symbols : ''),
    };
  }

  /* 地图:房间、门、家具(按用途上色)、你在哪儿、朝哪儿看。 */
  const mapCtx = map.getContext('2d');
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  map.width = 150 * dpr; map.height = 150 * dpr;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const r of rooms) { bx0 = Math.min(bx0, r.x0); bx1 = Math.max(bx1, r.x1); bz0 = Math.min(bz0, r.z0); bz1 = Math.max(bz1, r.z1); }
  const mk = Math.min((150 - 16) / (bx1 - bx0), (150 - 16) / (bz1 - bz0));
  const mx = (x) => (8 + (x - bx0) * mk + ((150 - 16) - (bx1 - bx0) * mk) / 2) * dpr;
  const mz = (z) => (8 + (z - bz0) * mk + ((150 - 16) - (bz1 - bz0) * mk) / 2) * dpr;
  function drawMap(here) {
    const c = mapCtx;
    c.clearRect(0, 0, map.width, map.height);
    for (const r of rooms) {
      c.fillStyle = r.open ? 'rgba(134,239,172,.10)' : 'rgba(255,255,255,.07)';
      c.strokeStyle = r === here ? '#6ee7b7' : 'rgba(255,255,255,.28)';
      c.lineWidth = (r === here ? 2 : 1) * dpr;
      c.fillRect(mx(r.x0), mz(r.z0), (r.x1 - r.x0) * mk * dpr, (r.z1 - r.z0) * mk * dpr);
      c.strokeRect(mx(r.x0), mz(r.z0), (r.x1 - r.x0) * mk * dpr, (r.z1 - r.z0) * mk * dpr);
    }
    c.strokeStyle = 'rgba(201,240,61,.25)'; c.lineWidth = 1 * dpr;
    for (const [i, j] of L.edges) { const a = byIdx.get(i), b = byIdx.get(j); if (a && b) { c.beginPath(); c.moveTo(mx(a.x), mz(a.z)); c.lineTo(mx(b.x), mz(b.z)); c.stroke(); } }
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.font = `${9 * dpr}px -apple-system,sans-serif`; c.textAlign = 'center';
    for (const r of rooms) if (!r.isHall) c.fillText(r.name.slice(0, 12), mx((r.x0 + r.x1) / 2), mz((r.z0 + r.z1) / 2) + 3 * dpr);
    for (const p of props) { c.fillStyle = ROLE_COLOR[p.role] || '#fff'; c.beginPath(); c.arc(mx(p.x), mz(p.z), (p === selected ? 3.2 : 2) * dpr, 0, TAU); c.fill(); }
    const X = mx(px), Z = mz(pz), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    c.fillStyle = '#6ee7b7';
    c.beginPath();
    c.moveTo(X + fx * 7 * dpr, Z + fz * 7 * dpr);
    c.lineTo(X - fx * 4 * dpr - fz * 4 * dpr, Z - fz * 4 * dpr + fx * 4 * dpr);
    c.lineTo(X - fx * 4 * dpr + fz * 4 * dpr, Z - fz * 4 * dpr - fx * 4 * dpr);
    c.fill();
  }

  let nightTarget = night, lastEnvT = 0;
  /** 重新看一眼外面:钟走了、换了天气或季节。颜色一两秒里过去,夜色 1.2 秒里过去。 */
  function refreshEnv(say) {
    env = envNow();
    sunLight();
    atmos.setEnv(env, U.uSunDir.value);
    nightTarget = env.night;
    applyTime(); paintTimeBtn();
    if (say) {
      toast.innerHTML = `${WEATHER_ICON[env.weather] || ''} ${w['wx_' + env.weather] || ''}<small>${SEASON_ICON[env.season] || ''} ${w['season_' + env.season] || ''}</small>`;
      toast.style.opacity = '1'; toastUntil = t + 2.2;
    }
  }
  function setTime(mode) { timeMode = mode === 'day' || mode === 'night' ? mode : 'auto'; refreshEnv(false); }

  function update(dt) {
    // 进门聚拢;换楼的时候反过来,散开(room-travel.js 叫 dissolve)
    if (dissolving) U.uForm.value = Math.max(0, U.uForm.value - Math.min(0.1, dt || 0) / dissolveT);
    else U.uForm.value = Math.min(1, U.uForm.value + Math.min(0.1, dt || 0) / formIn);
    // 每走 0.75 米,脚下荡开一圈
    if (Math.hypot(px - lastStepX, pz - lastStepZ) > 0.75) { lastStepX = px; lastStepZ = pz; U.uStep.value.set(px, pz, U.uTime.value, 1); }
    dt = Math.min(0.05, Math.max(0, dt || 0));
    t += dt;
    U.uTime.value = t;
    // 世界尺寸的点要知道"一弧度是多少像素"
    U.uPx.value = (H * renderer.getPixelRatio() / 2) / Math.tan(camera.fov * Math.PI / 360);
    // 火光:两层噪声叠出来的闪,±12%
    for (const f of flames) {
      const n = Math.sin(t * 5.3 + f.i * 1.7) * 0.6 + Math.sin(t * 11.7 + f.i * 3.1) * 0.4;
      U.uLC.value[f.i].copy(f.base).multiplyScalar(1 + 0.12 * n);
    }
    if (night !== nightTarget) {
      night += Math.sign(nightTarget - night) * Math.min(Math.abs(nightTarget - night), dt / 1.2);
      applyTime();
      if (Math.abs(night - 0.5) < 0.05) paintTimeBtn();
    }
    // 跟着钟的时候,一分钟看一眼外面(黄昏是慢慢来的)
    if (timeMode === 'auto' && opts.hour == null && t - lastEnvT > 60) { lastEnvT = t; refreshEnv(false); }

    const kf = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const kr = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const fwd = kf - move.z, strafe = kr + move.x;
    if ((fwd || strafe) && !locked) step(dt, fwd, strafe);
    camera.position.set(px, 1.62, pz);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    atmos.update(dt, t, camera);
    grade.mat.uniforms.uFlash.value = atmos.flash;

    /* 穿过门框(从大厅这边走到门框背后)= 去隔壁那座楼;走进旋涡中心 = 传送。各报一次,
       人退回来再走一遍才会再报。 */
    if (!locked) {
      for (const f of frames) {
        const s = (px - f.x) * f.nx + (pz - f.z) * f.nz, l = (px - f.x) * f.tx + (pz - f.z) * f.tz;
        if (!f.fired && Math.abs(l) < f.OW && f.s0 > 0.05 && s <= 0.05) { f.fired = true; if (opts.onLink) { try { opts.onLink(f.link); } catch (e) {} } }
        if (s > 0.6) f.fired = false;
        f.s0 = s;
      }
      if (portal) {
        const dd = Math.hypot(px - portal.x, pz - portal.z);
        if (!portal.fired && dd < 0.6) { portal.fired = true; if (opts.onPortal) { try { opts.onPortal(portal.target); } catch (e) {} } }
        if (dd > 1.5) portal.fired = false;
      }
    }

    const here = roomAt(px, pz);
    if (here !== hereNow) {
      hereNow = here;
      const info = hereInfo(here);
      toast.innerHTML = `${info.path}<small>${fill(w.ui_files, here.files || 0)} · ${here.isHall ? (here.open ? w.ui_court_is : w.ui_room_is) : w.ui_room_is}</small>`
        + info.why.map((s) => `<small>${s}</small>`).join('');
      toast.style.opacity = '1'; toastUntil = t + 3.2;
      if (opts.onHere) { try { opts.onHere(info); } catch (e) {} }
    }
    if (toastUntil && t > toastUntil) { toast.style.opacity = '0'; toastUntil = 0; }

    const rc = rectOf();
    const inView = (s) => !s.behind && s.x > rc.left - 60 && s.x < rc.left + W + 60 && s.y > rc.top && s.y < rc.top + H;
    // 粒子字正对着人:取相机这一帧的右、上两个轴。renderNow() 传 dt = 0 → 直接成形(截图用)
    camera.updateMatrixWorld();
    camR.value.setFromMatrixColumn(camera.matrixWorld, 0); camU.value.setFromMatrixColumn(camera.matrixWorld, 1);
    const dtc = dt > 0 ? Math.min(0.1, dt) : 1;
    plaquePool.frame();
    for (const pl of plaques) {
      const dist = Math.hypot(px - pl.d.cx, pz - pl.d.cz), s = toScreen(pl.d.cx, pl.y, pl.d.cz);
      if (dist > 28 || !inView(s)) continue;
      plaquePool.put(pl.key, pl.lines, [pl.d.cx, pl.y, pl.d.cz], 0.5 * (1 + Math.max(0, dist - 5) * 0.06), Math.max(0.35, 1 - dist / 30), dtc);
    }
    plaquePool.end();
    /* 家具的名牌:只给离得近的几件,而且**不许叠**。近的先占位置,和已经放下的
       撞上就不放 —— 十几块名牌压成一摞,一块也读不出来,远处的交给地图。 */
    const near = props.map((p) => ({ p, d: Math.hypot(px - p.x, pz - p.z) })).filter((q) => q.d < 9.5).sort((a, b) => a.d - b.d);
    const taken = [];
    let n = 0;
    labelPool.frame();
    for (const { p, d } of near) {
      if (n >= 9) break;
      const s = toScreen(p.top[0], p.top[1], p.top[2]);
      if (!inView(s)) continue;
      if (taken.some((b) => Math.abs(b.x - s.x) < 128 && Math.abs(b.y - s.y) < 34) && p !== selected) continue;
      taken.push(s); n++;
      const sel = p === selected;
      const sub = (w['role_' + p.role] || '') + (p.sym && p.sym.length ? ' · ' + fill(w.ui_defines, p.sym.length) : '');
      labelPool.put('p:' + p.name + '|' + p.x.toFixed(2) + '|' + p.z.toFixed(2) + (sel ? '|s' : ''),
        () => [{ t: (ROLE_ICON[p.role] ? ROLE_ICON[p.role] + ' ' : '') + p.name, px: 40, w: 650, col: sel ? '#7DF5C0' : '#EEF4F2' },
               { t: sub, px: 28, w: 500, col: sel ? '#9FE8C8' : '#A7B8B2' }],
        p.top, 0.3 * (1 + Math.max(0, d - 3) * 0.08), Math.max(0.3, 1 - d / 12), dtc);
    }
    labelPool.end();
    // 选中的那件:架子上每件东西标上它是哪个符号(小一号的粒子字)
    tagPool.frame();
    if (selected && Math.hypot(px - selected.x, pz - selected.z) < 9) {
      for (const sl of selected.slots.slice(0, 16)) {
        const s = toScreen(sl.at[0], sl.at[1] + 0.02, sl.at[2]);
        if (!inView(s)) continue;
        tagPool.put('i:' + sl.sym.name + '|' + sl.at.map((v) => v.toFixed(2)).join(','),
          () => [{ t: (ITEM_ICON[sl.sym.kind] ? ITEM_ICON[sl.sym.kind] + ' ' : '') + sl.sym.name, px: 34, w: 600, col: '#DDEBFF' }],
          [sl.at[0], sl.at[1] + 0.02, sl.at[2]], 0.18, 1, dtc);
      }
    }
    tagPool.end();
    drawMap(here);
  }

  function render() { composer.render(); }

  function resize(w2, h2) {
    W = Math.max(1, w2 | 0); H = Math.max(1, h2 | 0);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
  }

  let dead = false;
  function dispose() {
    if (dead) return;
    dead = true;
    for (const f of offs) { try { f(); } catch (e) {} }
    for (const x of els.concat(labels, itemTags)) { try { x.remove(); } catch (e) {} }
    try { for (const g of textGeos.values()) g.dispose(); textMats.forEach((m) => m.dispose()); } catch (e) {}
    try { group.userData.dispose(); lGeo.dispose(); lMat.dispose(); selMat.dispose(); if (selGlow) selGlow.geometry.dispose(); } catch (e) {}
    try { if (freeShadow) freeShadow(); grade.dispose(); crt.dispose(); } catch (e) {}
    try { bloom.dispose(); atmos.dispose(); } catch (e) {}
    try { composer.dispose(); } catch (e) {}
    // 画布还给外面那片场,状态原样交回去 —— 像素比也还回去。
    try {
      renderer.setRenderTarget(null); renderer.autoClear = prevAutoClear;
      if (renderer.getPixelRatio() !== prevPR) { renderer.setPixelRatio(prevPR); renderer.setSize(W, H, false); }
    } catch (e) {}
  }

  applyTime();
  paintTimeBtn();
  resize(W, H);

  return {
    update, render, resize, dispose, step, setTime, describe, select,
    time: () => timeMode, layout: L.layout,
    /** 此刻外面的天(room-sky.js 的 envAt)。 */
    env: () => env,
    setWeather(k) { wxPick = WEATHERS.includes(k) ? k : null; refreshEnv(false); },
    setSeason(s) { seasonPick = SEASONS.includes(s) ? s : null; refreshEnv(false); },
    /** 传送门通向哪:{title, rgb?}。标签换成那个项目的名字,旋涡换成它的颜色。 */
    setPortal(tg) {
      if (!portal) return;
      portal.target = tg || null;
      const c = tg && tg.rgb ? tg.rgb : [0.78, 0.62, 1];
      U.uPortalC.value.set(c[0] * 0.8 + 0.25, c[1] * 0.8 + 0.2, c[2] * 0.8 + 0.3);
    },
    /** 换楼时:粒子散开(on)/ 不许走(lock)。 */
    dissolve(on, secs) { dissolving = !!on; if (secs) dissolveT = secs; },
    lock(on) { locked = !!on; if (on) { move.x = move.z = 0; keys.clear(); } },
    frames, portal: () => portal,
    renderNow() { U.uForm.value = 1; update(0); render(); },
    /** 真机自检:哪些着色器没编译过(three 只记在 console,不抛)、这一帧画了多少、GPU 的 uniform 上限。 */
    diag() {
      const gl = renderer.getContext(), bad = [];
      for (const p of renderer.info.programs || []) {
        const d = p.diagnostics;
        if (d && !d.runnable) bad.push((p.name || '?') + ': ' + ((d.vertexShader && d.vertexShader.log) || '') + ' ' + ((d.fragmentShader && d.fragmentShader.log) || '') + ' ' + (d.programLog || ''));
      }
      let maxVU = null, gpu = '';
      try { maxVU = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS); gpu = String(gl.getParameter(gl.RENDERER) || ''); } catch (e) {}
      // lost:iOS 在 GPU 忙不过来时会直接把 WebGL 上下文收走 —— 屏幕同样是什么都没有
      let lost = null; try { lost = gl.isContextLost(); } catch (e) {}
      return { bad: bad.join(' | ').slice(0, 700), points: group.userData.points, calls: renderer.info.render.calls, drawn: renderer.info.render.points, maxVU, gpu, lost };
    },
    // 调试:把"太阳看到的深度"画到屏幕上(越亮越远)。窗洞里能看见地面的地方是亮斑。
    debugShadow() {
      const sc = new THREE.Scene(); sc.add(group.userData.shadow);
      renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true);
      renderer.render(sc, camera); sc.remove(group.userData.shadow);
    },
    at(x, z, y, p) { px = x; pz = z; if (y != null) yaw = y; if (p != null) pitch = p; },
    where() { return { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), room: roomAt(px, pz).name }; },
    here() { return hereInfo(roomAt(px, pz)); },
    particles: () => group.userData.points + NL, counts: () => ({ surface: group.userData.points, light: NL, lights: lights.length, edges: L.edges.length }),
    bloom, walkable, rooms, doors, props, camera, move, blocks, windows, uniforms: U,
    hasLeaves: L.hasLeaves, hasSymbols: L.hasSymbols, extraKids: L.extraKids,
    kit(name) {
      const r = name ? rooms.find((x) => x.name === name && !x.isHall) || hall : hall;
      const ip = kitOf(r);
      return ip && { style: ip.style.id, layout: L.layout, floor: ip.floor, wall: ip.wall, ceil: ip.ceil, light: ip.light, col: ip.col, why: ip.why };
    },
    kits() { return rooms.map((r) => { const ip = kitOf(r); return [r.name, ip.floor, ip.wall, ip.ceil, ip.light, ip.col]; }); },
    variants: interiorVariants,
  };
}
