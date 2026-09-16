/**
 * town-people.js — 镇上的人:每栋别墅的主人(一个项目一个),和别的玩家。
 *
 * 长相、性格、一天怎么过从 town-folk.mjs 来(纯函数,服务器也用同一份,所以你在镇上看到的
 * 铁匠和跟你说话的铁匠是同一个人)。这里只管三件事:
 *
 *   画   一个"人"的模板把所有发型、帽子、手里的东西都备着,每个人用实例属性挑自己那一套、
 *        上自己的颜色 —— 一百多个人一次 draw call。比例是四头身左右:头大一点,远处也认得出是谁;
 *        剪影靠帽子、发型、斗篷、围裙、手里的家伙(研究:先认轮廓,再认颜色)。
 *        每个人身上一层很淡的光晕(光遇、风之旅人那种),颜色是他那个项目的语言色。
 *   动   走路甩腿摆臂、站着呼吸、四处看、坐下、招手、说话时比划、干活时抡锤 —— 全在顶点着色器里。
 *   过日子 按 town-folk 排好的一天(几点在家、几点干活、几点去集市、教堂、酒馆),在镇上走来走去;
 *        人走近了会转过头来看你,打招呼;点一下就聊天。
 */
import * as THREE from 'three';
import { personaOf, projectFacts, relationsOf, blockAt, greeting, bark } from './town-folk.mjs';

const TAU = Math.PI * 2;
export const HAIRS = ['short', 'long', 'bun', 'braid', 'curly', 'bald'];
export const HATS = ['none', 'hood', 'coif', 'brim', 'cap', 'toque', 'pointed', 'wreath'];
export const PROPS = ['none', 'hammer', 'loaf', 'scroll', 'tankard', 'basket', 'lantern', 'spindle', 'book', 'staff'];
export const POSE = { hide: 0, stand: 1, walk: 2, sit: 3, wave: 4, talk: 5, work: 6, bow: 7, cheer: 8 };
/* 部位 */
const PT = { head: 0, eye: 1, hair: 2, hat: 3, torso: 4, belt: 5, apron: 6, cloak: 7, armL: 8, armR: 9, legL: 10, legR: 11, shoe: 12, beard: 13, prop: 14, hand: 15, collar: 16 };

/* ── 模板 ──────────────────────────────────────────────────────────────── */
function rngOf(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function personTemplate() {
  const r = rngOf(20260917);
  const P = [], part = [], vari = [], piv = [], size = [];
  const put = (x, y, z, pt, v, pv, sz) => { P.push(x, y, z); part.push(pt); vari.push(v); piv.push(pv[0], pv[1], pv[2]); size.push(sz); };
  // 椭球面上均匀撒点(斐波那契球)
  const ell = (cx, cy, cz, rx, ry, rz, n, pt, v, pv, sz, keep) => {
    for (let i = 0; i < n; i++) {
      const y = 1 - (i + 0.5) / n * 2, rr = Math.sqrt(1 - y * y), a = i * 2.39996323;
      const dx = Math.cos(a) * rr, dz = Math.sin(a) * rr;
      if (keep && !keep(dx, y, dz)) continue;
      put(cx + dx * rx, cy + y * ry, cz + dz * rz, pt, v, pv, sz);
    }
  };
  // 竖着的一段(胳膊、腿):从 a 到 b,半径 ra → rb
  const limb = (a, b, ra, rb, n, pt, v, pv, sz) => {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, ang = i * 2.39996323 * 3;
      const rad = ra + (rb - ra) * t;
      put(a[0] + (b[0] - a[0]) * t + Math.cos(ang) * rad, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + Math.sin(ang) * rad, pt, v, pv, sz);
    }
  };
  const O = [0, 0, 0];
  const HEAD_Y = 1.36, HR = 0.19;
  const neck = [0, 1.16, 0];
  // 头
  ell(0, HEAD_Y, 0.01, HR, HR * 1.06, HR * 0.98, 150, PT.head, -1, neck, 0.05);
  // 眼睛:两颗亮点,朝前
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) put(s * 0.065, HEAD_Y + 0.01 + k * 0.004, HR * 0.95, PT.eye, -1, neck, 0.035);
  // 发型
  const hairKeep = {
    short: (x, y, z) => y > -0.05 && z < 0.55,
    long: (x, y, z) => (y > -0.1 && z < 0.5) || (z < -0.1),
    bun: (x, y, z) => y > 0.0 && z < 0.5,
    braid: (x, y, z) => y > -0.05 && z < 0.5,
    curly: (x, y, z) => y > -0.15 && z < 0.6,
  };
  HAIRS.forEach((hs, v) => {
    if (hs === 'bald') return;
    const k = hairKeep[hs];
    const puff = hs === 'curly' ? 1.18 : 1.08;
    ell(0, HEAD_Y + 0.01, -0.005, HR * puff, HR * puff * 1.02, HR * puff, hs === 'curly' ? 170 : 130, PT.hair, v, neck, hs === 'curly' ? 0.065 : 0.05, k);
    if (hs === 'long') for (let i = 0; i < 70; i++) { const t = r(), a = Math.PI * (0.25 + r() * 0.5) + Math.PI; put(Math.cos(a) * 0.17, HEAD_Y - 0.05 - t * 0.38, Math.sin(a) * 0.1 - 0.06, PT.hair, v, neck, 0.05); }
    if (hs === 'bun') ell(0, HEAD_Y + 0.12, -0.16, 0.08, 0.08, 0.08, 34, PT.hair, v, neck, 0.05);
    if (hs === 'braid') for (let i = 0; i < 40; i++) { const t = i / 40; put(Math.sin(t * 18) * 0.02, HEAD_Y - 0.08 - t * 0.5, -0.18 - t * 0.04, PT.hair, v, neck, 0.05); }
  });
  // 帽子
  HATS.forEach((h, v) => {
    if (h === 'none') return;
    if (h === 'hood') { ell(0, HEAD_Y + 0.02, -0.02, HR * 1.25, HR * 1.25, HR * 1.25, 160, PT.hat, v, neck, 0.06, (x, y, z) => z < 0.45); limb([0, HEAD_Y - 0.15, -0.2], [0, 0.95, -0.24], 0.1, 0.05, 20, PT.hat, v, neck, 0.06); }
    if (h === 'coif') ell(0, HEAD_Y + 0.02, -0.01, HR * 1.12, HR * 1.12, HR * 1.12, 120, PT.hat, v, neck, 0.05, (x, y, z) => z < 0.5 && y > -0.35);
    if (h === 'brim') {
      for (let i = 0; i < 70; i++) { const a = i / 70 * TAU, rr = 0.2 + (i % 2) * 0.07; put(Math.cos(a) * rr, HEAD_Y + 0.12, Math.sin(a) * rr, PT.hat, v, neck, 0.055); }
      ell(0, HEAD_Y + 0.18, 0, 0.15, 0.1, 0.15, 60, PT.hat, v, neck, 0.05, (x, y) => y > -0.3);
    }
    if (h === 'cap') ell(0, HEAD_Y + 0.12, -0.01, HR * 1.05, 0.11, HR * 1.05, 80, PT.hat, v, neck, 0.05, (x, y) => y > 0);
    if (h === 'toque') { limb([0, HEAD_Y + 0.12, 0], [0, HEAD_Y + 0.36, 0], 0.17, 0.2, 70, PT.hat, v, neck, 0.055); ell(0, HEAD_Y + 0.38, 0, 0.22, 0.08, 0.22, 40, PT.hat, v, neck, 0.055); }
    if (h === 'pointed') { for (let i = 0; i < 110; i++) { const t = i / 110, a = i * 2.39996 * 5, rr = 0.24 * (1 - t); put(Math.cos(a) * rr + t * t * 0.08, HEAD_Y + 0.1 + t * 0.55, Math.sin(a) * rr - t * t * 0.06, PT.hat, v, neck, 0.05); }
      for (let i = 0; i < 40; i++) { const a = i / 40 * TAU; put(Math.cos(a) * 0.27, HEAD_Y + 0.1, Math.sin(a) * 0.27, PT.hat, v, neck, 0.05); } }
    if (h === 'wreath') for (let i = 0; i < 50; i++) { const a = i / 50 * TAU; put(Math.cos(a) * 0.19, HEAD_Y + 0.1 + Math.sin(a * 7) * 0.015, Math.sin(a) * 0.19, PT.hat, v, neck, 0.05); }
  });
  // 胡子
  ell(0, HEAD_Y - 0.12, 0.11, 0.12, 0.1, 0.07, 40, PT.beard, -1, neck, 0.05, (x, y, z) => z > 0.1);
  // 身子:上窄下宽的一段(长袍式),领口
  for (let i = 0; i < 190; i++) {
    const t = r(), a = r() * TAU;
    const rad = 0.17 + t * 0.1;
    put(Math.cos(a) * rad, 1.16 - t * 0.62, Math.sin(a) * rad * 0.72, PT.torso, -1, O, 0.06);
  }
  for (let i = 0; i < 26; i++) { const a = i / 26 * TAU; put(Math.cos(a) * 0.13, 1.16, Math.sin(a) * 0.1, PT.collar, -1, O, 0.045); }
  for (let i = 0; i < 30; i++) { const a = i / 30 * TAU; put(Math.cos(a) * 0.23, 0.82, Math.sin(a) * 0.165, PT.belt, -1, O, 0.045); }
  // 围裙:前面一块
  for (let i = 0; i < 50; i++) put((r() - 0.5) * 0.34, 0.5 + r() * 0.42, 0.19 + r() * 0.02, PT.apron, -1, O, 0.055);
  // 斗篷:背后一圈往下张开(走路时往后飘)
  for (let i = 0; i < 130; i++) {
    const t = r(), a = Math.PI * (1.1 + r() * 0.8);
    const rad = 0.2 + t * 0.2;
    put(Math.cos(a) * rad, 1.16 - t * 0.78, Math.sin(a) * rad * 0.85 - 0.03, PT.cloak, -1, [0, 1.16, 0], 0.065);
  }
  // 胳膊、手(肩是轴)
  for (const s of [-1, 1]) {
    const sh = [s * 0.22, 1.1, 0];
    limb(sh, [s * 0.27, 0.66, 0.02], 0.055, 0.045, 36, s < 0 ? PT.armL : PT.armR, -1, sh, 0.05);
    ell(s * 0.27, 0.62, 0.03, 0.045, 0.05, 0.045, 12, PT.hand, s, sh, 0.04);
  }
  // 腿、鞋(胯是轴)
  for (const s of [-1, 1]) {
    const hip = [s * 0.09, 0.56, 0];
    limb(hip, [s * 0.1, 0.07, 0], 0.07, 0.05, 36, s < 0 ? PT.legL : PT.legR, -1, hip, 0.055);
    ell(s * 0.1, 0.04, 0.05, 0.055, 0.04, 0.1, 14, PT.shoe, s, hip, 0.045);
  }
  // 手里的东西(右手)
  const hand = [0.27, 0.62, 0.03], shR = [0.22, 1.1, 0];
  PROPS.forEach((pp, v) => {
    if (pp === 'none') return;
    const at = (x, y, z, sz = 0.05) => put(hand[0] + x, hand[1] + y, hand[2] + z, PT.prop, v, shR, sz);
    if (pp === 'hammer') { for (let i = 0; i < 12; i++) at(0, -0.05 + i * 0.03, 0.05); for (let i = 0; i < 12; i++) at(-0.06 + (i % 4) * 0.04, 0.3 + (i >> 2) * 0.03, 0.05, 0.055); }
    if (pp === 'loaf') ell(hand[0], hand[1] + 0.05, hand[2] + 0.1, 0.12, 0.06, 0.07, 28, PT.prop, v, shR, 0.05);
    if (pp === 'scroll') for (let i = 0; i < 24; i++) { const a = i / 8 * TAU; at(Math.cos(a) * 0.03, 0.05 + (i % 8) * 0.0, 0.05 + (i / 24 - 0.5) * 0.3, 0.045); }
    if (pp === 'tankard') limb([hand[0], hand[1], hand[2] + 0.08], [hand[0], hand[1] + 0.16, hand[2] + 0.08], 0.05, 0.05, 20, PT.prop, v, shR, 0.045);
    if (pp === 'basket') { for (let i = 0; i < 30; i++) { const a = r() * TAU, y = r() * 0.14; at(Math.cos(a) * 0.12, -0.2 + y, Math.sin(a) * 0.1 + 0.08, 0.05); } for (let i = 0; i < 10; i++) at(Math.cos(i / 10 * Math.PI) * 0.12, -0.05 + Math.sin(i / 10 * Math.PI) * 0.15, 0.08, 0.035); }
    if (pp === 'lantern') { for (let i = 0; i < 8; i++) at(0, -0.02 - i * 0.02, 0.05, 0.03); ell(hand[0], hand[1] - 0.24, hand[2] + 0.05, 0.06, 0.08, 0.06, 18, PT.prop, v, shR, 0.05); }
    if (pp === 'spindle') { for (let i = 0; i < 14; i++) at(0, -0.1 + i * 0.03, 0.06, 0.03); ell(hand[0], hand[1] + 0.02, hand[2] + 0.06, 0.07, 0.03, 0.07, 14, PT.prop, v, shR, 0.04); }
    if (pp === 'book') for (let i = 0; i < 28; i++) at((r() - 0.5) * 0.04, (r() - 0.5) * 0.2, 0.08 + (r() - 0.5) * 0.14, 0.05);
    if (pp === 'staff') for (let i = 0; i < 34; i++) at(0.02, -0.6 + i * 0.05, 0.05, 0.04);
  });
  return { P, part, vari, piv, size, n: part.length };
}

const PEOPLE_VS = `
attribute float aPart, aVar, aSz; attribute vec3 aPivot;
attribute vec4 iPos, iAnim, iLook, iColA, iColB;   // 颜色压成一个数一种(8 位 × 3):顶点属性最多 16 个

uniform float uTime, uPx, uNight, uFogA, uFogB, uExposure, uGlowPass, uWind;
uniform vec3 uSunDir, uSunCol, uSky, uFogAway;
varying vec3 vC; varying float vA;
mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
vec3 unpackC(float f){ float r = floor(f / 65536.0); float g = floor((f - r * 65536.0) / 256.0); return vec3(r, g, f - r * 65536.0 - g * 256.0) / 255.0; }
void hide(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; }
void main(){
  float pose = iAnim.z;
  if (pose < 0.5) { hide(); return; }
  int part = int(aPart + 0.5);
  vec3 iSkin = unpackC(iColA.x), iHair = unpackC(iColA.y), iTunic = unpackC(iColA.z), iCloak = unpackC(iColA.w);
  vec3 iTrim = unpackC(iColB.x), iApronC = unpackC(iColB.y), iGlowC = unpackC(iColB.z);
  float tall = iColB.w, build = iPos.y;
  float v = aVar;
  float flags = iLook.z;
  // 这个人用的是哪一套发型 / 帽子 / 手里的东西
  if (part == 2 && abs(v - iLook.x) > 0.5) { hide(); return; }
  if (part == 3 && abs(v - iLook.y) > 0.5) { hide(); return; }
  if (part == 14 && abs(v - iLook.w) > 0.5) { hide(); return; }
  if (part == 6 && mod(flags, 2.0) < 0.5) { hide(); return; }
  if (part == 7 && mod(floor(flags / 2.0), 2.0) < 0.5) { hide(); return; }
  if (part == 13 && mod(floor(flags / 4.0), 2.0) < 0.5) { hide(); return; }
  // 戴帽子(兜帽、头巾、高帽)的人,头发只露一点
  if (part == 2 && (iLook.y > 0.5 && iLook.y < 2.5 || iLook.y > 4.5 && iLook.y < 5.5) && aPivot.y > 1.0 && position.y > 1.42) { hide(); return; }
  if (uGlowPass > 0.5 && fract(sin(dot(position, vec3(12.9898, 78.233, 37.719))) * 43758.5) > 0.35) { hide(); return; }

  vec3 p = position;
  float ph = iAnim.x * 6.2831853, spd = iAnim.y;
  float t = uTime + iPos.x * 0.37 + iPos.z * 0.21;
  // 呼吸:身子一呼一吸(每分钟十几次)
  if (part == 4 || part == 5 || part == 6 || part == 16) p.y = 0.56 + (p.y - 0.56) * (1.0 + 0.012 * sin(t * 1.7));
  bool walking = pose > 1.5 && pose < 2.5;
  if (walking) {
    if (part == 10 || part == 12 && v < 0.0) p = aPivot + rotX(0.55 * spd * sin(ph)) * (p - aPivot);
    if (part == 11 || part == 12 && v > 0.0) p = aPivot + rotX(-0.55 * spd * sin(ph)) * (p - aPivot);
    if (part == 8 || part == 15 && v < 0.0) p = aPivot + rotX(-0.45 * spd * sin(ph)) * (p - aPivot);
    if (part == 9 || part == 15 && v > 0.0 || part == 14) p = aPivot + rotX(0.45 * spd * sin(ph)) * (p - aPivot);
  } else if (pose > 2.5 && pose < 3.5) {
    // 坐:腿往前抬平,整个人矮下去
    if (part == 10 || part == 11 || part == 12) p = aPivot + rotX(-1.45) * (p - aPivot);
    p.y -= 0.42;
  } else if (pose > 3.5 && pose < 4.5 || pose > 7.5) {
    // 招手 / 欢呼:右手(欢呼是两只手)举起来摇
    bool up = part == 9 || part == 15 && v > 0.0 || part == 14 || (pose > 7.5 && (part == 8 || part == 15 && v < 0.0));
    float side = (part == 8 || part == 15 && v < 0.0) ? -1.0 : 1.0;
    if (up) p = aPivot + rotZ(side * (2.5 + 0.35 * sin(t * 9.0))) * (p - aPivot);
    if (pose > 7.5) p.y += abs(sin(t * 6.0)) * 0.12;
  } else if (pose > 4.5 && pose < 5.5) {
    // 说话:两只手比划,头轻轻点
    if (part == 8 || part == 15 && v < 0.0) p = aPivot + rotX(-0.5 - 0.3 * sin(t * 2.3)) * (p - aPivot);
    if (part == 9 || part == 15 && v > 0.0 || part == 14) p = aPivot + rotX(-0.7 - 0.35 * sin(t * 3.1 + 1.0)) * (p - aPivot);
  } else if (pose > 5.5 && pose < 6.5) {
    // 干活:右手一下一下抡
    if (part == 9 || part == 15 && v > 0.0 || part == 14) p = aPivot + rotX(-1.6 + 1.3 * max(0.0, sin(t * 4.0))) * (p - aPivot);
  } else if (pose > 6.5 && pose < 7.5) {
    // 鞠躬:上半身往前弯
    if (p.y > 0.56) p = vec3(0.0, 0.56, 0.0) + rotX(0.6) * (p - vec3(0.0, 0.56, 0.0));
  } else {
    // 站着:手自然垂,重心偶尔换一下
    p.x += sin(t * 0.35) * 0.015 * step(0.56, p.y);
  }
  // 头:转向要看的方向(iAnim.w,相对身子),走路时一颠一颠
  if (part <= 3 || part == 13) {
    float hy = iAnim.w;
    float c = cos(hy), s = sin(hy);
    vec3 q = p - vec3(0.0, 1.16, 0.0);
    p = vec3(0.0, 1.16, 0.0) + vec3(q.x * c + q.z * s, q.y, -q.x * s + q.z * c);
  }
  if (walking) p.y += abs(sin(ph)) * 0.035 * spd;
  // 斗篷:往后飘,越往下飘得越多
  if (part == 7) {
    float k = max(0.0, 1.16 - p.y);
    p.z -= k * k * (0.35 * spd + 0.12 * uWind) * (1.0 + 0.3 * sin(t * 3.0 + p.y * 6.0));
  }
  // 高矮胖瘦
  p.y *= tall;
  p.x *= build;
  // 朝向:本地 +z 是脸朝的方向
  float cy = cos(iPos.w), sy = sin(iPos.w);
  vec3 w = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy) + vec3(iPos.x, 0.0, iPos.z);
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float d = -mv.z;
  if (d > 160.0) { hide(); return; }
  // 颜色:哪个部位用哪种颜色
  vec3 col = iTunic;
  if (part == 0 || part == 15) col = iSkin;
  else if (part == 2 || part == 13) col = iHair;
  else if (part == 3) col = iTrim * 0.85;
  else if (part == 5 || part == 12) col = iApronC * 0.0 + vec3(0.16, 0.11, 0.08);
  else if (part == 6) col = iApronC;
  else if (part == 7) col = iCloak;
  else if (part == 10 || part == 11) col = iTrim * 0.55;
  else if (part == 16) col = iTrim;
  else if (part == 14) col = v < 1.5 ? vec3(0.35, 0.33, 0.33) : v < 2.5 ? vec3(0.72, 0.5, 0.24) : v < 3.5 ? vec3(0.86, 0.8, 0.62) : v < 4.5 ? vec3(0.45, 0.32, 0.2) : v < 5.5 ? vec3(0.6, 0.45, 0.25) : v < 6.5 ? vec3(1.0, 0.8, 0.45) : vec3(0.5, 0.36, 0.22);
  else if (part == 8 || part == 9) col = iTunic * 0.9;
  if (uGlowPass > 0.5) {
    // 光晕:大一点、淡一点,颜色是他项目的语言色;夜里更亮
    gl_PointSize = clamp(aSz * 3.2 * uPx / max(d, 0.2), 1.0, 60.0);
    vC = iGlowC * (0.10 + 0.14 * uNight) * (1.0 - smoothstep(40.0, 120.0, d));
    vA = 1.0;
    gl_Position = projectionMatrix * mv;
    return;
  }
  // 光:柔和的天光 + 太阳,背光的轮廓亮一点(光遇的边光)
  vec3 N = normalize(vec3(p.x, (p.y - 0.9) * 0.4, p.z) + 1e-4);
  vec3 Nw = vec3(N.x * cy + N.z * sy, N.y, -N.x * sy + N.z * cy);
  vec3 V = normalize(cameraPosition - w);
  float rim = pow(1.0 - max(dot(Nw, V), 0.0), 2.0);
  vec3 lit = uSky * 0.7 + uSunCol * (0.25 + 0.6 * max(dot(Nw, uSunDir), 0.0));
  lit = mix(lit, vec3(0.16, 0.17, 0.22), uNight);
  vec3 c = col * lit + iGlowC * rim * (0.25 + 0.35 * uNight);
  if (part == 1) c = vec3(1.4, 1.35, 1.2);                   // 眼睛是亮的
  if (part == 14 && v > 5.5 && v < 6.5) c = vec3(1.6, 1.1, 0.5) * (0.6 + uNight);   // 提着的灯
  c = 1.0 - exp(-1.2 * c * uExposure);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float fd = 1.0 - exp(-uFogA * exp(-uFogB * max(cameraPosition.y, 0.0)) * d);
  vC = mix(c, uFogAway, fd * 0.8);
  vA = 1.0;
  // 近看是细密的一颗颗,不是一串珠子
  gl_PointSize = clamp(aSz * (d < 6.0 ? 0.9 : 1.25) * uPx / max(d, 0.2), 1.0, 18.0);
  gl_Position = projectionMatrix * mv;
}`;
const PEOPLE_FS = `
precision highp float;
uniform float uGlowPass;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25 || vA < 0.01) discard;
  if (uGlowPass > 0.5) { gl_FragColor = vec4(vC * exp(-r2 * 14.0), 1.0); return; }
  gl_FragColor = vec4(vC * (0.9 + 0.1 * (1.0 - r2 * 4.0)), 1.0);
}`;

/* ── 实例属性:一个人的长相 → 数字 ───────────────────────────────────── */
function lookAttrs(look) {
  const L = look || {};
  const hair = Math.max(0, HAIRS.indexOf(L.hairStyle || 'short'));
  const hat = Math.max(0, HATS.indexOf(L.hat || 'none'));
  const prop = Math.max(0, PROPS.indexOf(L.prop || 'none'));
  const flags = (L.apron ? 1 : 0) + (L.cloak ? 2 : 0) + (L.beard ? 4 : 0);
  const pk = (c) => { const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255))); return q(c[0]) * 65536 + q(c[1]) * 256 + q(c[2]); };
  return {
    look: [hair, hat, flags, prop],
    colA: [pk(L.skin || [0.9, 0.75, 0.62]), pk(L.hair || [0.25, 0.17, 0.1]), pk(L.tunic || [0.4, 0.4, 0.45]), pk(L.cloak || [0.2, 0.2, 0.25])],
    colB: [pk(L.trim || [0.5, 0.4, 0.3]), pk(L.apronCol || [0.8, 0.76, 0.66]), pk(L.glow || [0.7, 0.8, 1]), L.height || 1],
    build: L.build || 1,
  };
}

/**
 * 镇上的人。
 * @param U      小镇的 uniform
 * @param plan   图纸
 * @param world  town-build 的结果(villas、stalls、benches、doors、bell……)
 * @param houses 项目 [{id, title, lang, bytes, files, project}]
 * @param opts   { budget, resolve(x,z,r), lang: 'zh'|'en', maxPeers }
 */
export function createPeople(U, plan, world, houses, opts = {}) {
  const lang = opts.lang === 'zh' ? 'zh' : 'en';
  const MAXPEER = opts.maxPeers || 24;
  const tpl = personTemplate();
  const byId = new Map(houses.map((h) => [String(h.id), h]));

  /* 一百个主人 */
  const villas = world.villas.slice(0, 100);
  const folk = villas.map((v, i) => {
    const h = byId.get(String(v.id)) || { id: v.id };
    const cap = (h.project && h.project.capsule) || { title: h.title, langs: h.lang ? [[h.lang, 1]] : [], dirs: [], style: h.style };
    const facts = projectFacts(String(v.id), cap);
    if (!facts.bytes && h.bytes) facts.bytes = +h.bytes;
    if (!facts.files && h.files) facts.files = +h.files;
    const persona = personaOf(String(v.id), facts);
    return { i, id: String(v.id), villa: v, facts, persona, house: h,
      x: v.door.x, z: v.door.z, yaw: Math.atan2(v.fx, v.fz), speed: 0, phase: Math.random(), pose: POSE.stand,
      target: null, path: [], place: '', lookYaw: 0, wait: 0, stuck: 0, lastX: 0, lastZ: 0, emote: 0, emoteUntil: 0, bubble: null };
  });
  const rel = relationsOf(folk.map((f) => ({ id: f.id, facts: f.facts, persona: f.persona, x: f.villa.x, z: f.villa.z })));
  for (const f of folk) f.friends = (rel.get(f.id) || []).map((q) => q.id);
  const folkById = new Map(folk.map((f) => [f.id, f]));

  /* 几何:一个模板 × (主人 + 玩家) 个实例 */
  const N = folk.length + MAXPEER;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tpl.P, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(tpl.part, 1));
  g.setAttribute('aVar', new THREE.Float32BufferAttribute(tpl.vari, 1));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(tpl.piv, 3));
  g.setAttribute('aSz', new THREE.Float32BufferAttribute(tpl.size, 1));
  const inst = (k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(N * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const A = { iPos: inst(4), iAnim: inst(4), iLook: inst(4), iColA: inst(4), iColB: inst(4) };
  for (const k in A) g.setAttribute(k, A[k]);
  g.instanceCount = N;
  const setLook = (slot, look) => {
    const q = lookAttrs(look);
    A.iLook.array.set(q.look, slot * 4);
    A.iColA.array.set(q.colA, slot * 4); A.iColB.array.set(q.colB, slot * 4);
    A.iPos.array[slot * 4 + 1] = q.build;
  };
  folk.forEach((f) => setLook(f.i, f.persona.look));
  for (const k of ['iLook', 'iColA', 'iColB']) A[k].needsUpdate = true;

  const baseU = { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uFogA: U.uFogA, uFogB: U.uFogB, uExposure: U.uExposure,
    uSunDir: U.uSunDir, uSunCol: U.uSunCol, uSky: U.uSky, uFogAway: U.uFogAway, uWind: { value: 0.3 } };
  const mat = new THREE.ShaderMaterial({ uniforms: Object.assign({ uGlowPass: { value: 0 } }, baseU), vertexShader: PEOPLE_VS, fragmentShader: PEOPLE_FS });
  const glowMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ uGlowPass: { value: 1 } }, baseU), vertexShader: PEOPLE_VS, fragmentShader: PEOPLE_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false;
  const halo = new THREE.Points(g, glowMat); halo.frustumCulled = false; halo.renderOrder = 5;
  const group = new THREE.Group();
  group.add(pts, halo);

  /* ── 去哪儿:一天里的每一段 → 镇上的一个点 ── */
  const W = plan.world || {};
  const M = W.market;
  const pick = (arr, k) => arr[Math.abs(Math.floor(k)) % arr.length];
  const taverns = world.villas.filter((v) => v.trade === 'tavern').map((v) => v.door);
  const churchDoor = W.church ? { x: W.church.x - W.church.fx * (W.church.d / 2 + 3), z: W.church.z - W.church.fz * (W.church.d / 2 + 3) } : null;
  const strollSpots = plan.nodes.filter((n) => !n.plot).map((n) => ({ x: n.x, z: n.z }));
  const yardOf = new Map((W.yards || []).map((y) => [String(y.plot), y]));
  const placeFor = (f, blk, day) => {
    const h = (f.i * 7 + day * 13) | 0;
    const v = f.villa;
    switch (blk.kind) {
      case 'sleep': return { kind: 'hide', x: v.door.x, z: v.door.z };
      case 'home': return (h % 3 === 0) ? { kind: 'sit', x: v.door.x + v.fx * 0.8 + v.fz * 1.4, z: v.door.z + v.fz * 0.8 - v.fx * 1.4, face: Math.atan2(v.fx, v.fz) } : { kind: 'hide', x: v.door.x, z: v.door.z };
      case 'work': {
        // 点灯人:天黑以后沿街一盏盏走过去
        if (f.persona.trade === 'lamplighter' && world.lamps.length) { const l = pick(world.lamps, h + Math.floor(Date.now() / 120000)); return { kind: 'stand', x: l.x + 0.8, z: l.z + 0.8 }; }
        if (f.persona.trade === 'tavernkeeper' || f.persona.trade === 'innkeeper') { const d = taverns.length ? pick(taverns, h) : v.door; return { kind: 'stand', x: d.x, z: d.z, face: null }; }
        return { kind: v.trade && v.trade !== 'home' ? 'work' : 'stand', x: v.door.x + v.fz * 1.2, z: v.door.z - v.fx * 1.2, face: Math.atan2(v.fx, v.fz) };
      }
      case 'market': {
        if (M && world.stalls.length) { const st = pick(world.stalls, h); return { kind: 'stand', x: st.x + st.fx * 1.8, z: st.z + st.fz * 1.8, face: Math.atan2(-st.fx, -st.fz) }; }
        if (M) return { kind: 'stand', x: M.x + Math.cos(h) * M.r * 0.5, z: M.z + Math.sin(h) * M.r * 0.5 };
        break;
      }
      case 'well': if (M) return { kind: 'stand', x: M.well.x + Math.cos(h) * 2, z: M.well.z + Math.sin(h) * 2, face: Math.atan2(M.well.x - (M.well.x + Math.cos(h) * 2), M.well.z - (M.well.z + Math.sin(h) * 2)) }; break;
      case 'church': if (churchDoor) return { kind: 'stand', x: churchDoor.x + (h % 5 - 2) * 0.9, z: churchDoor.z + ((h >> 3) % 5 - 2) * 0.9 }; break;
      case 'tavern': {
        if (world.benches.length && h % 2) { const b = pick(world.benches, h); return { kind: 'sit', x: b.x, z: b.z, face: b.yaw + Math.PI }; }
        const d = taverns.length ? pick(taverns, h) : (M ? { x: M.x, z: M.z } : v.door);
        return { kind: 'stand', x: d.x + Math.cos(h) * 2.5, z: d.z + Math.sin(h) * 2.5 };
      }
      case 'garden': { const y = yardOf.get(f.id); if (y) return { kind: 'work', x: y.x, z: y.z, face: Math.atan2(y.fx, y.fz) }; break; }
      case 'visit': { const o = folkById.get(String(blk.target)); if (o) return { kind: 'stand', x: o.villa.door.x + 1.4, z: o.villa.door.z + 1.4 }; break; }
      case 'stroll': default: if (strollSpots.length) { const s0 = pick(strollSpots, h + Math.floor(Date.now() / 600000)); return { kind: 'stand', x: s0.x, z: s0.z }; }
    }
    return { kind: 'stand', x: v.door.x, z: v.door.z };
  };

  /* ── 路:沿着街道图走(节点是路口和门口) ── */
  const nodePos = plan.nodes.map((n, i) => {
    if (!n.plot) return { x: n.x, z: n.z };
    const pl = plan.plots.find((p) => p.site === i);
    return pl ? { x: pl.door.x, z: pl.door.z } : { x: n.x, z: n.z };
  });
  const adj = plan.nodes.map(() => []);
  for (const st of plan.streets) { adj[st.a].push(st.b); adj[st.b].push(st.a); }
  const nearestNode = (x, z) => { let b = 0, bd = 1e18; nodePos.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; b = i; } }); return b; };
  const route = (fx, fz, tx, tz) => {
    const a = nearestNode(fx, fz), b = nearestNode(tx, tz);
    if (a === b) return [{ x: tx, z: tz }];
    const prev = new Map([[a, -1]]), q = [a];
    for (let h = 0; h < q.length && !prev.has(b); h++) for (const w of adj[q[h]]) if (!prev.has(w)) { prev.set(w, q[h]); q.push(w); }
    const out = [{ x: tx, z: tz }];
    if (!prev.has(b)) return out;
    for (let v = b; v !== -1 && v !== a; v = prev.get(v)) out.unshift(nodePos[v]);
    return out;
  };

  /* ── 玩家(别人):同一个模板,颜色按 id ── */
  const peers = new Map();
  let peerSlots = new Array(MAXPEER).fill(null);

  let day = 0, lastPlan = -1;
  const talk = { who: null };
  const res = opts.resolve || ((x, z) => ({ x, z }));

  function update(dt, t, cam, env) {
    const hour = env ? env.hour : 12;
    day = Math.floor(Date.now() / 86400000);
    baseU.uWind.value = env && env.fx ? env.fx.wind || 0.2 : 0.2;
    const replan = Math.floor(hour * 12) !== lastPlan;          // 五分钟想一次去哪儿
    if (replan) lastPlan = Math.floor(hour * 12);
    const px = cam.x, pz = cam.z;
    const rain = env && env.fx && env.fx.rain > 0.3 ? 'rain' : '';
    for (const f of folk) {
      if (replan || !f.target) {
        const blk = blockAt(f.persona, hour, day, rain, f.friends);
        const pl = placeFor(f, blk, day);
        f.place = blk.kind;
        if (!f.target) {
          // 刚进镇:每个人已经在他这会儿该在的地方了(不是全从自家门口一起出发)
          f.target = pl;
          f.x = pl.x + ((f.i * 37) % 7 - 3) * 0.25; f.z = pl.z + ((f.i * 53) % 7 - 3) * 0.25;
          if (pl.face != null) f.yaw = pl.face;
          f.path = [];
          continue;
        }
        if (Math.hypot(f.target.x - pl.x, f.target.z - pl.z) > 1) {
          f.target = pl;
          // 刚醒 / 刚回家:从自家门口出来、进去
          if (f.pose === POSE.hide && pl.kind !== 'hide') { f.x = f.villa.door.x; f.z = f.villa.door.z; }
          f.path = f.pose === POSE.hide ? [] : route(f.x, f.z, pl.x, pl.z);
          if (pl.kind === 'hide' && f.pose === POSE.hide) f.path = [];
        }
      }
      const talking = talk.who === f;
      const far = Math.hypot(f.x - px, f.z - pz);
      // 走
      let moving = false;
      if (!talking && f.path.length) {
        const wp = f.path[0];
        const dx = wp.x - f.x, dz = wp.z - f.z, d = Math.hypot(dx, dz);
        if (d < 0.6) { f.path.shift(); }
        else {
          const sp = 1.25 * (0.9 + (f.i % 5) * 0.05);
          const step = Math.min(d, sp * dt);
          let nx = f.x + dx / d * step, nz = f.z + dz / d * step;
          if (far < 90) { const r0 = res(nx, nz, 0.3); nx = r0.x; nz = r0.z; }
          const moved = Math.hypot(nx - f.x, nz - f.z);
          f.stuck = moved < step * 0.3 ? f.stuck + dt : 0;
          if (f.stuck > 1.5) { f.path.shift(); f.stuck = 0; if (!f.path.length) { f.x = wp.x; f.z = wp.z; } }
          f.x = nx; f.z = nz;
          const want = Math.atan2(dx, dz);
          f.yaw += angle(want - f.yaw) * Math.min(1, dt * 6);
          f.phase = (f.phase + moved / 1.3) % 1;
          f.speed += (1 - f.speed) * Math.min(1, dt * 4);
          moving = true;
        }
      }
      if (!moving) {
        f.speed += (0 - f.speed) * Math.min(1, dt * 5);
        const tg = f.target || {};
        if (!f.path.length && tg.face != null && !talking) f.yaw += angle(tg.face - f.yaw) * Math.min(1, dt * 3);
      }
      // 姿势
      let pose = moving ? POSE.walk : (f.target && !f.path.length ? (f.target.kind === 'hide' ? POSE.hide : f.target.kind === 'sit' ? POSE.sit : f.target.kind === 'work' ? POSE.work : POSE.stand) : POSE.stand);
      if (talking) pose = t < f.emoteUntil ? f.emote : POSE.talk;
      else if (t < f.emoteUntil) pose = f.emote;
      f.pose = pose;
      // 看人:玩家走近了,头转过来(身子不动);说话时整个人朝着你
      let look = 0;
      if (pose !== POSE.hide && far < 7) {
        const want = Math.atan2(px - f.x, pz - f.z);
        if (talking) f.yaw += angle(want - f.yaw) * Math.min(1, dt * 5);
        look = Math.max(-1.1, Math.min(1.1, angle(want - f.yaw)));
      } else look = Math.sin(t * 0.3 + f.i) * 0.5 * (pose === POSE.stand ? 1 : 0);
      f.lookYaw += (look - f.lookYaw) * Math.min(1, dt * 4);
      const o = f.i;
      A.iPos.array[o * 4] = f.x; A.iPos.array[o * 4 + 2] = f.z; A.iPos.array[o * 4 + 3] = f.yaw;
      A.iAnim.array[o * 4] = f.phase; A.iAnim.array[o * 4 + 1] = f.speed; A.iAnim.array[o * 4 + 2] = pose; A.iAnim.array[o * 4 + 3] = f.lookYaw;
    }
    // 别的玩家:位置由外面喂(setPeers),这里只平滑
    peerSlots.forEach((pp, k) => {
      const o = folk.length + k;
      if (!pp) { A.iAnim.array[o * 4 + 2] = POSE.hide; return; }
      const kx = Math.min(1, dt * 8);
      pp.sx += (pp.x - pp.sx) * kx; pp.sz += (pp.z - pp.sz) * kx;
      const moved = Math.hypot(pp.x - pp.sx, pp.z - pp.sz);
      pp.phase = (pp.phase + Math.max(moved, (pp.v || 0) * dt) / 1.3) % 1;
      A.iPos.array[o * 4] = pp.sx; A.iPos.array[o * 4 + 2] = pp.sz; A.iPos.array[o * 4 + 3] = pp.face;
      A.iAnim.array[o * 4] = pp.phase; A.iAnim.array[o * 4 + 1] = Math.min(1, (pp.v || 0) / 3);
      A.iAnim.array[o * 4 + 2] = pp.e === 1 ? POSE.wave : pp.e === 2 ? POSE.cheer : pp.e === 3 ? POSE.sit : (pp.v || 0) > 0.3 ? POSE.walk : POSE.stand;
      A.iAnim.array[o * 4 + 3] = 0;
    });
    A.iPos.needsUpdate = true; A.iAnim.needsUpdate = true;
  }

  return {
    group, folk,
    count: tpl.n * N,
    /** 别的玩家:[{id, name, x, z, yaw, v, e, rgb}] */
    setPeers(list) {
      const seen = new Set();
      for (const p of list || []) {
        seen.add(p.id);
        let pp = peers.get(p.id);
        if (!pp) {
          const k = peerSlots.indexOf(null);
          if (k < 0) continue;
          pp = { id: p.id, slot: k, sx: p.x, sz: p.z, phase: 0 };
          peers.set(p.id, pp); peerSlots[k] = pp;
          // 玩家的长相:按 id 定,颜色是他自己的那一种;光晕是亮的(一眼认得出是真人)
          const r = rngOf(hash(p.id));
          const c = p.rgb || [0.7, 0.9, 1];
          setLook(folk.length + k, {
            skin: [[0.95, 0.82, 0.7], [0.85, 0.66, 0.5], [0.6, 0.43, 0.3]][Math.floor(r() * 3)],
            hair: [[0.1, 0.08, 0.07], [0.35, 0.22, 0.12], [0.75, 0.6, 0.35]][Math.floor(r() * 3)],
            hairStyle: HAIRS[Math.floor(r() * 5)], hat: r() < 0.5 ? 'hood' : 'none', beard: false,
            tunic: c.map((v) => v * 0.8), cloak: c.map((v) => v * 0.45), apron: false, trim: c,
            height: 0.95 + r() * 0.1, build: 1, prop: 'none', glow: c.map((v) => Math.min(1, v * 1.4 + 0.2)),
          });
          for (const key of ['iLook', 'iColA', 'iColB']) A[key].needsUpdate = true;
        }
        Object.assign(pp, { x: p.x, z: p.z, v: p.v, e: p.e || 0, name: p.name });
        // 玩家的 yaw 是相机的(前方 = -sin, -cos);人的脸朝 +z 本地 → 换算
        pp.face = (p.yaw || 0) + Math.PI;
      }
      for (const [id, pp] of peers) if (!seen.has(id)) { peerSlots[pp.slot] = null; peers.delete(id); }
    },
    update,
    /** 离 (x,z) 最近、看得见的那个主人 */
    nearest(x, z, r = 3.2) {
      let best = null, bd = r;
      for (const f of folk) {
        if (f.pose === POSE.hide) continue;
        const d = Math.hypot(f.x - x, f.z - z);
        if (d < bd) { bd = d; best = f; }
      }
      return best;
    },
    /** 开始 / 结束和谁说话(说话的时候他站住、朝着你) */
    talkTo(f) { talk.who = f || null; if (f) f.path = []; },
    emote(f, name, secs = 2.5, t = 0) {
      const k = { wave: POSE.wave, bow: POSE.bow, laugh: POSE.cheer, nod: POSE.talk, shrug: POSE.talk, cheer: POSE.cheer }[name];
      if (k != null) { f.emote = k; f.emoteUntil = t + secs; }
    },
    /** 带路:这个人走到另一栋房子门口 */
    guide(f, targetId) {
      const o = folkById.get(String(targetId));
      if (!o) return null;
      f.target = { kind: 'stand', x: o.villa.door.x + 1.2, z: o.villa.door.z + 1.2 };
      f.path = route(f.x, f.z, f.target.x, f.target.z);
      talk.who = null;
      return o;
    },
    greetingFor(f, memory, env) { return greeting(f.persona, memory, env, lang); },
    barkFor(f, env) { return bark(f.persona, env, lang); },
    headAt(f) { return { x: f.x, y: 1.95 * (f.persona.look.height || 1), z: f.z }; },
    peerHead(id) { const pp = peers.get(id); return pp ? { x: pp.sx, y: 1.95, z: pp.sz } : null; },
    dispose() { g.dispose(); mat.dispose(); glowMat.dispose(); },
  };
}

function angle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
