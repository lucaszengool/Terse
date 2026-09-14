/**
 * room-surface.js — 走进楼之后的"实物":墙、地、顶、柱、家具,**全部在 GPU 上长出来的粒子**。
 *
 * 上一版每一颗点都是 JS 里算好、塞进缓冲的:五六十万颗已经是内存和建造时间的上限,
 * 所以点只能 6–10cm 一颗 —— 远看是面,走近是一池小球。清晰度的天花板不在显卡,在 CPU。
 *
 * 这里反过来:CPU 只描述**面**(一块平面、一段圆柱、一片球面、一个圆盘,各带材质),
 * 每个面切成若干"小片",一片是 n×n 颗点;点的位置、法线、颜色全在顶点着色器里按片的
 * 参数算出来。于是:
 *
 *   · 点可以 2–3cm 一颗、几百万颗,CPU 只写几千条小片记录,建造几乎不花时间;
 *   · 每颗点有**法线**,能被灯正确照亮(朝着灯的一面亮、背着的一面暗),形体就出来了;
 *   · 颜色是**程序材质**:木纹、带灰缝的地砖、大理石纹、青砖、榻榻米、耙过的白砂、
 *     筒瓦、糊纸的格栅……按米为单位的坐标算,相邻小片的纹理严丝合缝;
 *   · 墙角、地脚、家具脚下的**环境光遮蔽**,院子里墙投下的**日影**,都在着色器里解析算;
 *   · 最后过一道 ACES 色调映射 —— 亮处不会一片死白,暗处不会一片死黑。
 *
 * 一切仍然是点:片里的点带抖动、是圆的,只是够密、够准,看起来是"质感",不是"颗粒"。
 */

import * as THREE from 'three';

export const MAT = {
  plaster: 0, wood: 1, tile: 2, marble: 3, brick: 4, mosaic: 5, tatami: 6, gravel: 7, rooftile: 8,
  lattice: 9, glass: 10, metal: 11, lacquer: 12, water: 13, moss: 14, sandstone: 15, canvas: 16,
  paper: 17, stone: 18, bark: 19, gridglow: 20, fluted: 21, coffer: 22, leaf: 23, glyph: 24,
};
/** 标志位:1 室内(没有直射日光)、2 夜里自己发光(纸、灯罩)、4 法线反过来(从里面看的穹顶)。 */
export const F = { indoor: 1, glow: 2, flip: 4 };

const TAU = Math.PI * 2;
const BUCKETS = [4, 8, 16, 32];
const lin = (c) => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ══ 着色器 ═══════════════════════════════════════════════════════════════
   光照那一段两种点共用:GPU 长出来的小片,和 CPU 撒的零散点(树冠、花、火盆边上的东西)。 */
const LIGHT_GLSL = `
uniform float uNight, uExposure, uTime;
uniform vec3 uSunDir, uSunCol, uSky, uGround, uMoon;
uniform vec4 uL[24]; uniform vec3 uLC[24]; uniform int uNL;
uniform vec4 uR[8]; uniform vec4 uRH[8]; uniform int uNR;
uniform vec4 uF[64]; uniform int uNF;
uniform vec4 uCourt; uniform float uCourtH, uCourtOn;

float aoOf(vec3 P, vec3 N){
  float ao = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uNR) break;
    vec4 r = uR[i];
    if (P.x < r.x - 0.06 || P.x > r.z + 0.06 || P.z < r.y - 0.06 || P.z > r.w + 0.06) continue;
    float h = uRH[i].x, open = uRH[i].y;
    float dx = abs(N.x) > 0.5 ? 9.0 : min(P.x - r.x, r.z - P.x);
    float dz = abs(N.z) > 0.5 ? 9.0 : min(P.z - r.y, r.w - P.z);
    float d0 = N.y > 0.5 ? 9.0 : max(P.y, 0.0);
    float d1 = (N.y < -0.5 || open > 0.5) ? 9.0 : max(h - P.y, 0.0);
    ao *= mix(0.42, 1.0, smoothstep(0.0, 0.95, dx)) * mix(0.42, 1.0, smoothstep(0.0, 0.95, dz))
        * mix(0.5, 1.0, smoothstep(0.0, 0.7, d0)) * mix(0.62, 1.0, smoothstep(0.0, 0.9, d1));
    break;
  }
  // 家具脚下:地面上离家具越近越暗 —— 家具才是"放在"地上,不是飘在上面
  if (N.y > 0.5 && P.y < 0.12) {
    for (int i = 0; i < 64; i++) {
      if (i >= uNF) break;
      vec2 q = abs(P.xz - uF[i].xy) - uF[i].zw;
      float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      ao *= mix(0.3, 1.0, smoothstep(-0.04, 0.5, sd));
    }
  }
  return ao;
}
// 院子里的日影:往太阳那边走,先碰到院墙(比墙矮)就是在影子里
float sunShadow(vec3 P){
  if (uCourtOn < 0.5) return 1.0;
  vec4 c = uCourt;
  if (P.x < c.x || P.x > c.z || P.z < c.y || P.z > c.w) return 1.0;
  vec2 d = normalize(uSunDir.xz + vec2(1e-5));
  float tanE = uSunDir.y / max(length(uSunDir.xz), 1e-3);
  float reach = max(uCourtH - P.y, 0.0) / max(tanE, 0.05);
  float tx = d.x > 1e-4 ? (c.z - P.x) / d.x : (d.x < -1e-4 ? (c.x - P.x) / d.x : 1e3);
  float tz = d.y > 1e-4 ? (c.w - P.z) / d.y : (d.y < -1e-4 ? (c.y - P.z) / d.y : 1e3);
  return smoothstep(reach - 0.35, reach + 0.35, min(tx, tz));
}
vec3 lightAt(vec3 P, vec3 N, float indoor, float ao){
  vec3 hemi = mix(uGround, uSky, N.y * 0.5 + 0.5);
  float sun = max(dot(N, uSunDir), 0.0) * sunShadow(P) * (1.0 - indoor);
  /* 室内白天没有直射光,只有天光 —— 每个面一样亮,形体就没了。补一道从门口方向来的
     柔和"主光":朝门的面亮一点,背着的暗一点,柜子、柱子才立得起来。 */
  float key = max(dot(N, normalize(vec3(0.25, 0.55, 0.8))), 0.0) * indoor;
  vec3 day = hemi * ao * mix(1.0, 0.5, indoor) + uSunCol * (sun * mix(0.85, 1.0, ao) + key * 0.22 * ao);
  vec3 night = uMoon * ao * (0.55 + 0.45 * max(N.y, 0.0));
  for (int i = 0; i < 24; i++) {
    if (i >= uNL) break;
    vec3 Lv = uL[i].xyz - P;
    float d = length(Lv);
    // 距离平方衰减 × 一个到半径处归零的窗 —— 灯下亮、远处自然地暗下去,而不是一整片白
    float win = max(0.0, 1.0 - d / uL[i].w);
    float att = win * win / (1.0 + d * d * 0.35);
    float lam = max(dot(N, Lv / max(d, 1e-3)), 0.0) * 0.85 + 0.15;
    night += uLC[i] * att * lam * mix(0.55, 1.0, ao);
  }
  return mix(day, night, uNight);
}
vec3 tone(vec3 x){
  x *= uExposure;
  x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2));
}
`;

const NOISE_GLSL = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
// 三层就够:第四层细到一颗点里看不出来,却是每颗点上最贵的那几次哈希
float fbm(vec2 p){ return (vn(p) * 0.5 + vn(p * 2.03) * 0.25 + vn(p * 4.1) * 0.125) / 0.875; }
float lineAA(float f, float w){ float g = min(f, 1.0 - f); return 1.0 - smoothstep(w * 0.5, w, g); }
`;

/* 程序材质。pc = 这块面上以米计的坐标(相邻小片接得上),P / N 世界位置与法线。
   返回 albedo(线性色),glow 写进自发光。 */
const MATERIAL_GLSL = `
/* 一颗点盖住的地面有多宽(fw,米)。线和小格比它还细的时候,画"平均颜色",不画那一小片 ——
   否则远处的灰缝、马赛克会随机取到亮或暗,地上就成了一片摩尔纹格子。 */
float lineF(float f, float w, float fw, float per){
  float r = fw / per;
  return mix(lineAA(f, max(w, r)), w, smoothstep(0.25, 0.7, r));
}
float fadeF(float fw, float feat){ return smoothstep(0.35, 0.9, fw / feat); }
vec3 albedo(float m, vec2 pc, vec3 P, vec3 N, vec3 c1, vec3 c2, float seed, float fw, out vec3 glow){
  glow = vec3(0.0);
  if (m < 0.5) {                       // 抹灰
    return c1 * (0.9 + 0.1 * fbm(pc * 2.5 + seed)) * (0.97 + 0.03 * vn(pc * 40.0) * (1.0 - fadeF(fw, 0.03)));
  } else if (m < 1.5) {                // 木:一条条板,每条色调不同,顺着板有纹
    float k = floor(pc.y / 0.16);
    float tint = mix(0.8 + 0.34 * h21(vec2(k, seed)), 0.97, fadeF(fw, 0.16));
    float grain = mix(0.5 + 0.5 * sin(pc.x * 34.0 + fbm(vec2(pc.x * 1.7, k * 3.1)) * 7.0), 0.5, fadeF(fw, 0.05));
    float seam = lineF(fract(pc.y / 0.16), 0.08, fw, 0.16);
    float joint = lineF(fract((pc.x + h21(vec2(k, 7.0)) * 3.0) / 2.2), 0.012, fw, 2.2);
    return c1 * tint * (0.84 + 0.16 * grain) * (1.0 - 0.55 * max(seam, joint));
  } else if (m < 2.5) {                // 地砖:60cm 一块,灰缝,每块一点点色差
    vec2 q = pc / 0.6, f = fract(q), id = floor(q);
    float gr = max(lineF(f.x, 0.03, fw, 0.6), lineF(f.y, 0.03, fw, 0.6));
    vec3 t = c1 * mix(0.86 + 0.22 * h21(id + seed), 0.97, fadeF(fw, 0.6)) * (0.95 + 0.05 * fbm(pc * 5.0));
    return mix(t, c2 * 0.55, gr);
  } else if (m < 3.5) {                // 大理石:两层噪声扭出来的纹
    float v = fbm(pc * 0.9 + fbm(pc * 0.45 + seed) * 2.2);
    float vein = pow(1.0 - abs(sin(pc.x * 1.3 + pc.y * 0.6 + v * 9.0)), 22.0) * (1.0 - 0.6 * fadeF(fw, 0.08));
    return mix(c1 * (0.94 + 0.06 * vn(pc * 12.0)), c2 * 0.55, vein * 0.75);
  } else if (m < 4.5) {                // 青砖:错缝砌,白灰缝
    float row = floor(pc.y / 0.075);
    float bx = (pc.x + mod(row, 2.0) * 0.12) / 0.24;
    float mortar = max(lineF(fract(pc.y / 0.075), 0.16, fw, 0.075), lineF(fract(bx), 0.05, fw, 0.24));
    vec3 b = c1 * mix(0.78 + 0.34 * h21(vec2(floor(bx), row) + seed), 0.95, fadeF(fw, 0.12));
    return mix(b, c2, mortar * 0.85);
  } else if (m < 5.5) {                // 马赛克:10cm 小砖,按星形图案在两色和白之间取
    vec2 q = pc / 0.1, id = floor(q), f = fract(q);
    float s = abs(sin(id.x * 0.52) + sin(id.y * 0.52)) + 0.35 * abs(sin((id.x + id.y) * 0.26));
    vec3 t = s > 1.25 ? c2 : (s > 0.7 ? c1 : mix(c1, vec3(0.9, 0.88, 0.82), 0.6));
    t *= 0.92 + 0.14 * h21(id);
    t = mix(t, mix(c1, c2, 0.35), fadeF(fw, 0.1));
    return mix(t, t * 0.45, max(lineF(f.x, 0.1, fw, 0.1), lineF(f.y, 0.1, fw, 0.1)));
  } else if (m < 6.5) {                // 榻榻米:0.9×1.8 一张,黑边,席纹沿长边
    vec2 q = vec2(pc.x / 0.9, pc.y / 1.8), id = floor(q), f = fract(q);
    bool rot = mod(id.x + id.y, 2.0) > 0.5;
    float along = rot ? pc.x : pc.y;
    float edge = max(lineF(f.x, 0.09, fw, 0.9), rot ? 0.0 : lineF(f.y, 0.045, fw, 1.8));
    vec3 straw = c1 * mix(0.9 + 0.1 * sin(along * 260.0), 0.95, fadeF(fw, 0.02)) * (0.92 + 0.08 * vn(pc * 4.0));
    return mix(straw, c2 * 0.4, edge);
  } else if (m < 7.5) {                // 白砂:细颗粒 + 耙纹
    float r = mix(0.5 + 0.5 * sin(pc.y * 26.0 + sin(pc.x * 0.45) * 2.2), 0.5, fadeF(fw, 0.12));
    return c1 * mix(0.84 + 0.22 * h21(floor(pc * 55.0)), 0.95, fadeF(fw, 0.02)) * (0.84 + 0.16 * r);
  } else if (m < 8.5) {                // 筒瓦:一垄一垄,垄沟深
    float s = mix(0.5 + 0.5 * sin(pc.x * TAU_ / 0.24), 0.5, fadeF(fw, 0.24));
    float row = lineF(fract(pc.y / 0.3), 0.1, fw, 0.3);
    return c1 * (0.55 + 0.5 * s) * (1.0 - 0.3 * row) * (0.93 + 0.07 * vn(pc * 9.0));
  } else if (m < 9.5) {                // 格栅糊纸:木格 + 纸,夜里纸透出屋里的暖光
    vec2 f = fract(vec2(pc.x / 0.42, pc.y / 0.3));
    float bar = max(lineF(f.x, 0.1, fw, 0.42), lineF(f.y, 0.12, fw, 0.3));
    vec3 paper = c1 * (0.95 + 0.05 * vn(pc * 20.0));
    glow = mix(vec3(1.0, 0.7, 0.38) * 0.55, vec3(0.0), bar);
    return mix(paper, c2 * 0.8, bar);
  } else if (m < 10.5) {               // 玻璃:竖向渐变 + 一道斜反光 + 窗棂
    vec2 f = fract(vec2(pc.x / 1.3, pc.y / 1.1));
    float mull = max(lineF(f.x, 0.05, fw, 1.3), lineF(f.y, 0.05, fw, 1.1));
    float streak = pow(max(0.0, sin((pc.x + pc.y) * 1.6 + seed)), 12.0);
    vec3 g = c1 * (0.55 + 0.35 * clamp(pc.y / 4.0, 0.0, 1.0)) + vec3(0.35) * streak;
    glow = vec3(0.35, 0.45, 0.6) * 0.25 * (1.0 - mull);
    return mix(g, c2 * 0.6, mull);
  } else if (m < 11.5) {               // 金属 / 描金:细碎的闪
    return c1 * (0.72 + 0.5 * mix(pow(vn(pc * 26.0 + seed), 3.0), 0.2, fadeF(fw, 0.04)));
  } else if (m < 12.5) {               // 漆面:几乎是纯色,一点点起伏
    return c1 * (0.9 + 0.1 * vn(pc * 7.0 + seed));
  } else if (m < 13.5) {               // 水:深色,波光随时间走
    float w = pow(max(0.0, sin(pc.x * 7.0 + uTime * 0.9 + sin(pc.y * 5.0 + uTime * 0.6) * 1.4)), 16.0);
    glow = vec3(0.6, 0.75, 0.85) * w * 0.25;
    return c1 * (0.8 + 0.2 * vn(pc * 3.0 + uTime * 0.1)) + vec3(0.2, 0.25, 0.3) * w;
  } else if (m < 14.5) {               // 苔
    return mix(c1, c1 * 0.55, fbm(pc * 5.0 + seed));
  } else if (m < 15.5) {               // 砂岩:一层层的横纹
    return c1 * (0.82 + 0.18 * sin(P.y * 8.0 + fbm(pc * 1.6) * 2.5)) * (0.95 + 0.05 * vn(pc * 25.0));
  } else if (m < 16.5) {               // 画布:一幅画
    float a = fbm(pc * 2.2 + seed), b = fbm(pc * 3.7 - seed);
    return mix(mix(c1, c2, smoothstep(0.35, 0.65, a)), vec3(0.95, 0.92, 0.84), smoothstep(0.6, 0.8, b) * 0.6);
  } else if (m < 17.5) {               // 纸(灯笼、屏风):夜里自己亮
    glow = c1 * 0.9;
    return c1 * (0.94 + 0.06 * vn(pc * 16.0));
  } else if (m < 18.5) {               // 石头:块状起伏
    return c1 * (0.68 + 0.42 * fbm(pc * 3.2 + seed));
  } else if (m < 19.5) {               // 树皮
    return c1 * (0.62 + 0.38 * (0.5 + 0.5 * sin(pc.y * 26.0 + fbm(pc * 7.0) * 5.0)));
  } else if (m < 20.5) {               // 发光网格地砖(现代):缝是亮的
    vec2 f = fract(pc / 1.2);
    float gr = max(lineF(f.x, 0.022, fw, 1.2), lineF(f.y, 0.022, fw, 1.2));
    glow = c2 * gr * 1.2;
    return mix(c1 * (0.9 + 0.1 * h21(floor(pc / 1.2) + seed)), c2, gr * 0.6);
  } else if (m < 21.5) {               // 凹槽柱身:沿圆周一条条凹槽(pc.x 是弧长)
    float fl = mix(0.5 + 0.5 * cos(pc.x * TAU_ / 0.09), 0.5, fadeF(fw, 0.09));
    return c1 * (0.72 + 0.3 * fl) * (0.95 + 0.05 * vn(pc * 14.0));
  } else if (m < 22.5) {               // 藻井:一格一格,格心深、格边描色
    vec2 f = fract(pc / 1.1);
    float rim = max(lineF(f.x, 0.16, fw, 1.1), lineF(f.y, 0.16, fw, 1.1));
    float d = max(abs(f.x - 0.5), abs(f.y - 0.5));
    return mix(c1 * (0.55 + 0.45 * d * 2.0), c2, rim * 0.8);
  } else if (m < 23.5) {               // 叶子 / 花瓣:一簇里颜色跳
    return mix(c1, c2, h21(floor(pc * 14.0) + seed)) * (0.8 + 0.3 * vn(pc * 9.0));
  }
  // 刻字的石头(古埃及、玛雅、古希腊的檐壁):一行一行刻进去的记号
  float row = floor(pc.y / 0.34), fy = fract(pc.y / 0.34);
  float mark = step(0.45, h21(vec2(floor(pc.x / 0.13), row) + seed)) * step(0.18, fy) * step(fy, 0.82);
  float cut = mark * step(0.25, fract(pc.x / 0.13)) * step(fract(pc.x / 0.13), 0.8) * (1.0 - fadeF(fw, 0.1));
  vec3 s = c1 * (0.84 + 0.16 * sin(P.y * 8.0 + fbm(pc * 1.6) * 2.5));
  return mix(s, c2 * 0.55, cut * 0.7);
}
`;

const PATCH_VS = `
precision highp float;
#define TAU_ 6.28318530718
attribute vec3 position;            // (u, v, 抖动种子) —— n×n 的格点
attribute vec3 iO; attribute vec3 iA; attribute vec3 iB; attribute vec4 iS; attribute vec4 iT;
attribute vec3 iC1; attribute vec3 iC2;
uniform mat4 modelViewMatrix, projectionMatrix;
uniform float uN, uPx, uFogK;
uniform vec3 uLod;
varying vec3 vCol; varying float vFog;
${NOISE_GLSL}
${LIGHT_GLSL}
${MATERIAL_GLSL}
void main(){
  float shape = iS.x, m = iS.y, seed = iS.z, fl = iS.w;
  float indoor = mod(fl, 2.0), glowF = mod(floor(fl / 2.0), 2.0), flip = mod(floor(fl / 4.0), 2.0);
  // 格点抖一抖:整整齐齐的网格远看会起摩尔纹
  vec2 j = vec2(h21(position.xy * 91.7 + seed), h21(position.yx * 53.3 + seed * 1.7)) - 0.5;
  // 抖得太多会在点之间开出小洞(夜里墙上一粒粒黑点就是这个)
  vec2 uv = clamp(position.xy + j * 0.3 / uN, 0.0, 1.0);
  vec3 P, N;
  if (shape < 0.5) {
    P = iO + iA * uv.x + iB * uv.y; N = normalize(cross(iA, iB));
  } else if (shape < 1.5) {           // 圆柱面:iA = (r, a0, a1)  iB = (y0, y1, -)
    float a = mix(iA.y, iA.z, uv.x);
    P = iO + vec3(cos(a) * iA.x, mix(iB.x, iB.y, uv.y), sin(a) * iA.x); N = vec3(cos(a), 0.0, sin(a));
  } else if (shape < 2.5) {           // 球面:iA = (R, 方位0, 方位1)  iB = (仰角0, 仰角1, 竖向压扁)
    float a = mix(iA.y, iA.z, uv.x), e = mix(iB.x, iB.y, uv.y);
    vec3 d = vec3(cos(e) * cos(a), sin(e), cos(e) * sin(a));
    P = iO + d * iA.x * vec3(1.0, iB.z, 1.0); N = normalize(d * vec3(1.0, 1.0 / max(iB.z, 0.05), 1.0));
  } else if (shape < 3.5) {           // 圆盘:iA = (r0, r1, a0)  iB = (a1, 朝下?, -)
    float a = mix(iA.z, iB.x, uv.x), r = mix(iA.x, iA.y, sqrt(uv.y));
    P = iO + vec3(cos(a) * r, 0.0, sin(a) * r); N = vec3(0.0, iB.y > 0.5 ? -1.0 : 1.0, 0.0);
  } else {                            // 任意朝向的管子:iA = 径向轴 × 半径,iB = 管轴(整段)
    vec3 e1 = iA, e2 = normalize(cross(normalize(iB), normalize(e1))) * length(e1);
    float a = uv.x * TAU_;
    P = iO + e1 * cos(a) + e2 * sin(a) + iB * uv.y; N = normalize(e1 * cos(a) + e2 * sin(a));
  }
  if (flip > 0.5) N = -N;
  vec4 mv = modelViewMatrix * vec4(P, 1.0);
  vec4 clip = projectionMatrix * mv;
  float d = -mv.z;
  /* 看不见的点先扔掉,再算材质和光 —— 任何时候都有一半的点在身后。 */
  if (d < 0.05 || abs(clip.x) > clip.w * 1.2 || abs(clip.y) > clip.w * 1.2) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
  }
  /* 远处的小片抽稀:整片取同一档(按片中心算距离),片与片之间不会出洞;
     留下来的点按步长放大,远处看起来一样满,顶点却少了 4 到 64 倍。 */
  vec3 ctr = shape < 0.5 ? iO + (iA + iB) * 0.5 : iO;
  float dc = length((modelViewMatrix * vec4(ctr, 1.0)).xyz);
  float stride = dc < uLod.x ? 1.0 : (dc < uLod.y ? 2.0 : (dc < uLod.z ? 4.0 : 8.0));
  stride = min(stride, uN);
  vec2 gi = floor(position.xy * uN);
  if (mod(gi.x, stride) > 0.5 || mod(gi.y, stride) > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
  }
  vec2 pc = iT.xy + uv * iT.zw;
  vec3 glow;
  float fw = max(iT.z, iT.w) / uN * stride;   // 这颗点盖住多宽的地
  vec3 alb = albedo(m, pc, P, N, iC1, iC2, seed, fw, glow);
  float ao = aoOf(P, N);
  vec3 lit = lightAt(P, N, indoor, ao);
  vec3 col = alb * lit + glow * uNight * (glowF > 0.5 || m > 19.5 && m < 20.5 || m > 8.5 && m < 9.5 || m > 16.5 && m < 17.5 ? 1.0 : 0.0);
  vFog = exp(-d * d * uFogK);
  vCol = tone(col);
  /* 点的直径:按这一片上**较疏那一向**的点距取,盖得严;但不许超过这一片窄边的一大半 ——
     一本 3cm 宽的书脊,用 3cm 的点去画,边就成了一圈花边。 */
  float sL = max(iT.z, iT.w) / uN, mn = min(iT.z, iT.w);
  // 1.75 倍点距:两颗相邻的点各自抖开,中间也不会漏出底色(墙上的黑斑)
  float diam = min(sL * 1.75, max(mn * 0.55, sL * 0.9));
  gl_PointSize = clamp(diam * stride * uPx / max(d, 0.05), 1.0, 64.0) * clamp((d - 0.25) / 0.6, 0.0, 1.0);
  gl_Position = clip;
}`;

const DOT_FS = `
precision highp float;
uniform vec3 uFog;
varying vec3 vCol; varying float vFog;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(mix(uFog, vCol, vFog), 1.0);
}`;

/* 零散的点(树冠、花、苔、鱼……):位置、法线、颜色、大小都是 CPU 给的,光照和小片同一套。 */
const LOOSE_VS = `
precision highp float;
#define TAU_ 6.28318530718
attribute vec3 position; attribute vec3 aN; attribute vec3 aC; attribute float aS;
uniform mat4 modelViewMatrix, projectionMatrix;
uniform float uPx, uFogK;
varying vec3 vCol; varying float vFog;
${NOISE_GLSL}
${LIGHT_GLSL}
void main(){
  vec3 N = normalize(aN);
  float ao = aoOf(position, N);
  vCol = tone(aC * lightAt(position, N, 0.0, ao));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  vFog = exp(-d * d * uFogK);
  gl_PointSize = clamp(aS * uPx / max(d, 0.05), 1.0, 64.0) * clamp((d - 0.25) / 0.6, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

/** 共用的 uniform:两种点、所有小片一份,昼夜只改这里。 */
export function makeUniforms() {
  const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4());
  const v3 = (n) => Array.from({ length: n }, () => new THREE.Vector3());
  return {
    uNight: { value: 0 }, uExposure: { value: 1 }, uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.7, 0.3).normalize() }, uSunCol: { value: new THREE.Vector3(2.2, 2.0, 1.7) },
    uSky: { value: new THREE.Vector3(0.5, 0.58, 0.72) }, uGround: { value: new THREE.Vector3(0.3, 0.26, 0.22) },
    uMoon: { value: new THREE.Vector3(0.05, 0.065, 0.11) },
    uL: { value: v4(24) }, uLC: { value: v3(24) }, uNL: { value: 0 },
    uR: { value: v4(8) }, uRH: { value: v4(8) }, uNR: { value: 0 },
    uF: { value: v4(64) }, uNF: { value: 0 },
    uCourt: { value: new THREE.Vector4() }, uCourtH: { value: 3.6 }, uCourtOn: { value: 0 },
    uPx: { value: 800 }, uFogK: { value: 0.0003 }, uFog: { value: new THREE.Color(0, 0, 0) },
    // 抽稀的三档距离(米):这之内全密度,之外依次 1/4、1/16、1/64
    uLod: { value: new THREE.Vector3(7, 14, 28) },
  };
}

/**
 * 描述面,切成小片,最后交出 THREE 对象。
 * @param {number} spacing 目标点距(米)。桌面 0.025,手机 0.04 左右。
 */
export class Surfaces {
  constructor(spacing = 0.03) {
    this.s = spacing;
    this.b = new Map(BUCKETS.map((n) => [n, []]));
    this.loose = { p: [], n: [], c: [], s: [] };
    this.count = 0;
  }
  _bucket(m) { return m <= 4.5 ? 4 : m <= 8.5 ? 8 : m <= 16.5 ? 16 : 32; }
  _push(n, rec) { this.b.get(n).push(rec); this.count += n * n; }
  _spec(spec) {
    return { m: spec.mat || 0, c1: lin(spec.c1 || [0.8, 0.8, 0.8]), c2: lin(spec.c2 || spec.c1 || [0.5, 0.5, 0.5]),
             f: spec.flags || 0, seed: spec.seed == null ? Math.random() * 10 : spec.seed, uv0: spec.uv0 || [0, 0] };
  }

  /** 一块平面:corner + U + V(整块的两条边)。法线朝 want 那一边(给了的话)。 */
  quad(corner, U, V, spec, want) {
    // 法线反了就把 V 翻过来(从另一头量),而不是交换 U/V —— 交换会把纹理转 90°:
    // 竖着的木板变成横的。
    if (want && dot(cross(U, V), want) < 0) { corner = add(corner, V); V = mul(V, -1); }
    const S = this._spec(spec);
    const lu = len(U), lv = len(V);
    if (lu < 1e-4 || lv < 1e-4) return;
    // 小片尽量方:细长的面(书脊、踢脚线)沿长边多切几片,而不是一片里点挤成横条
    const T = 32 * this.s, side = Math.min(T, Math.max(Math.min(lu, lv), 2 * this.s));
    const ku = Math.max(1, Math.ceil(lu / side - 1e-6)), kv = Math.max(1, Math.ceil(lv / side - 1e-6));
    const du = lu / ku, dv = lv / kv, n = this._bucket(Math.max(du, dv) / this.s);
    const A = mul(U, 1 / ku), B = mul(V, 1 / kv);
    for (let i = 0; i < ku; i++) for (let j = 0; j < kv; j++) {
      this._push(n, { o: add(add(corner, mul(A, i)), mul(B, j)), a: A, b: B, s: [0, S.m, S.seed, S.f],
                      t: [S.uv0[0] + i * du, S.uv0[1] + j * dv, du, dv], c1: S.c1, c2: S.c2 });
    }
  }
  /** 方盒。base = 底面中心,r / f = 右、前两个水平单位向量,w×h×d。faces 不要的面写 false。 */
  box(base, r, f, w, h, d, spec, faces = {}) {
    const up = [0, 1, 0];
    const c = (u, y, v) => add(add(add(base, mul(r, u)), mul(up, y)), mul(f, v));
    const F = Object.assign({ top: true, bottom: false, front: true, back: true, left: true, right: true }, faces);
    const sp = (k) => (spec[k] ? Object.assign({}, spec, spec[k]) : spec);
    if (F.top) this.quad(c(-w / 2, h, -d / 2), mul(r, w), mul(f, d), sp('top'), up);
    if (F.bottom) this.quad(c(-w / 2, 0, -d / 2), mul(r, w), mul(f, d), sp('bottom'), [0, -1, 0]);
    if (F.front) this.quad(c(-w / 2, 0, d / 2), mul(r, w), mul(up, h), sp('front'), f);
    if (F.back) this.quad(c(-w / 2, 0, -d / 2), mul(r, w), mul(up, h), sp('back'), mul(f, -1));
    if (F.left) this.quad(c(-w / 2, 0, -d / 2), mul(f, d), mul(up, h), sp('side'), mul(r, -1));
    if (F.right) this.quad(c(w / 2, 0, -d / 2), mul(f, d), mul(up, h), sp('side'), r);
  }
  /** 轴对齐的方盒,x0..x1 × y0..y1 × z0..z1 —— 墙、梁、台阶用得最多。 */
  aabb(x0, y0, z0, x1, y1, z1, spec, faces) {
    this.box([(x0 + x1) / 2, y0, (z0 + z1) / 2], [1, 0, 0], [0, 0, 1], x1 - x0, y1 - y0, z1 - z0, spec, faces);
  }
  /** 圆柱面(侧面),a0..a1 是方位角。inside 时法线朝里。 */
  cyl(base, r, h, spec, a0 = 0, a1 = TAU, y0 = 0) {
    const S = this._spec(spec);
    const C = r * (a1 - a0), T = 32 * this.s;
    const side = Math.min(T, Math.max(Math.min(C, h), 4 * this.s));
    const ka = Math.max(1, Math.ceil(C / side)), kh = Math.max(1, Math.ceil(h / side));
    const da = (a1 - a0) / ka, dh = h / kh, n = this._bucket(Math.max(r * da, dh) / this.s);
    for (let i = 0; i < ka; i++) for (let j = 0; j < kh; j++) {
      this._push(n, { o: base, a: [r, a0 + i * da, a0 + (i + 1) * da], b: [y0 + j * dh, y0 + (j + 1) * dh, 0], s: [1, S.m, S.seed, S.f],
                      t: [S.uv0[0] + r * i * da, S.uv0[1] + j * dh, r * da, dh], c1: S.c1, c2: S.c2 });
    }
  }
  /** 球面的一片:方位 a0..a1,仰角 e0..e1,squash 是竖向压扁。 */
  sphere(center, R, spec, a0 = 0, a1 = TAU, e0 = -Math.PI / 2, e1 = Math.PI / 2, squash = 1) {
    const S = this._spec(spec);
    const T = 32 * this.s;
    const eqC = R * (a1 - a0), mer = R * (e1 - e0);
    const side = Math.min(T, Math.max(Math.min(eqC, mer), 4 * this.s));
    const ka = Math.max(1, Math.ceil(eqC / side)), ke = Math.max(1, Math.ceil(mer / side));
    const da = (a1 - a0) / ka, de = (e1 - e0) / ke;
    for (let j = 0; j < ke; j++) {
      // 越靠近极点,一圈越短 —— 那几片用小一号的格子,不然极点上点挤成一团
      const em = e0 + (j + 0.5) * de, ring = Math.max(0.15, Math.cos(em));
      for (let i = 0; i < ka; i++) {
        const n = this._bucket(Math.max(R * da * ring, R * de) / this.s);
        this._push(n, { o: center, a: [R, a0 + i * da, a0 + (i + 1) * da], b: [e0 + j * de, e0 + (j + 1) * de, squash], s: [2, S.m, S.seed, S.f],
                        t: [S.uv0[0] + R * i * da, S.uv0[1] + R * j * de, R * da * ring, R * de], c1: S.c1, c2: S.c2 });
      }
    }
  }
  /** 圆盘(或圆环 r0..r1),水平;down 时朝下。 */
  disc(center, r0, r1, spec, down = false, a0 = 0, a1 = TAU) {
    const S = this._spec(spec);
    const T = 32 * this.s;
    const C = r1 * (a1 - a0), dr = r1 - r0;
    const side = Math.min(T, Math.max(Math.min(C, dr), 4 * this.s));
    const ka = Math.max(1, Math.ceil(C / side)), kr = Math.max(1, Math.ceil(dr / side));
    const da = (a1 - a0) / ka, drr = dr / kr;
    for (let j = 0; j < kr; j++) for (let i = 0; i < ka; i++) {
      const ra = r0 + j * drr, rb = ra + drr;
      const n = this._bucket(Math.max(rb * da, drr) / this.s);
      this._push(n, { o: center, a: [ra, rb, a0 + i * da], b: [a0 + (i + 1) * da, down ? 1 : 0, 0], s: [3, S.m, S.seed, S.f],
                      t: [S.uv0[0] + rb * i * da + center[0], S.uv0[1] + ra + center[2], rb * da, drr], c1: S.c1, c2: S.c2 });
    }
  }
  /** 任意朝向的一根管子(书卷、画架腿、桥栏、树枝):从 a 到 b,半径 r。 */
  tube(a, b, r, spec) {
    const S = this._spec(spec);
    const ax = sub(b, a), L = len(ax);
    if (L < 1e-4 || r <= 0) return;
    // 任取一条和管轴垂直的方向当径向轴
    const t = Math.abs(ax[1]) < 0.9 * L ? [0, 1, 0] : [1, 0, 0];
    let e1 = cross(ax, t); e1 = mul(e1, r / len(e1));
    const C = TAU * r, T = 32 * this.s;
    const k = Math.max(1, Math.ceil(L / Math.min(T, Math.max(C, 4 * this.s))));
    const n = this._bucket(Math.max(C, L / k) / this.s);
    for (let i = 0; i < k; i++) {
      this._push(n, { o: add(a, mul(ax, i / k)), a: e1, b: mul(ax, 1 / k), s: [4, S.m, S.seed, S.f],
                      t: [S.uv0[0], S.uv0[1] + i * L / k, C, L / k], c1: S.c1, c2: S.c2 });
    }
  }
  /** 一颗零散的点。n = 法线,size = 世界直径(米)。 */
  dot(p, n, c, size) {
    const L = this.loose;
    L.p.push(p[0], p[1], p[2]); L.n.push(n[0], n[1], n[2]);
    const q = lin(c); L.c.push(q[0], q[1], q[2]); L.s.push(size);
  }

  /** 交出一个 Group:每种格子大小一个实例化的 Points,外加零散点。 */
  build(uniforms) {
    const group = new THREE.Group();
    const matP = new THREE.RawShaderMaterial({ uniforms, vertexShader: PATCH_VS, fragmentShader: DOT_FS });
    const mats = [];
    for (const [n, recs] of this.b) {
      if (!recs.length) continue;
      const g = new THREE.InstancedBufferGeometry();
      const grid = new Float32Array(n * n * 3);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const k = (i * n + j) * 3;
        grid[k] = (i + 0.5) / n; grid[k + 1] = (j + 0.5) / n; grid[k + 2] = 0;
      }
      g.setAttribute('position', new THREE.BufferAttribute(grid, 3));
      const N = recs.length;
      const A = (k) => new Float32Array(N * k);
      const iO = A(3), iA = A(3), iB = A(3), iS = A(4), iT = A(4), iC1 = A(3), iC2 = A(3);
      recs.forEach((r, i) => {
        iO.set(r.o, i * 3); iA.set(r.a, i * 3); iB.set(r.b, i * 3); iS.set(r.s, i * 4); iT.set(r.t, i * 4);
        iC1.set(r.c1, i * 3); iC2.set(r.c2, i * 3);
      });
      const I = (arr, k) => new THREE.InstancedBufferAttribute(arr, k);
      g.setAttribute('iO', I(iO, 3)); g.setAttribute('iA', I(iA, 3)); g.setAttribute('iB', I(iB, 3));
      g.setAttribute('iS', I(iS, 4)); g.setAttribute('iT', I(iT, 4));
      g.setAttribute('iC1', I(iC1, 3)); g.setAttribute('iC2', I(iC2, 3));
      g.instanceCount = N;
      const mat = matP.clone();
      mat.uniforms = Object.assign({}, uniforms, { uN: { value: n } });
      mats.push(mat);
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      group.add(pts);
    }
    matP.dispose();
    const L = this.loose;
    if (L.s.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(L.p), 3));
      g.setAttribute('aN', new THREE.BufferAttribute(new Float32Array(L.n), 3));
      g.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(L.c), 3));
      g.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(L.s), 1));
      const mat = new THREE.RawShaderMaterial({ uniforms, vertexShader: LOOSE_VS, fragmentShader: DOT_FS });
      mats.push(mat);
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      group.add(pts);
    }
    group.userData.dispose = () => {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      mats.forEach((m) => m.dispose());
    };
    group.userData.points = this.count + L.s.length;
    return group;
  }
}

/** 把灯、房间、家具脚印、院子写进 uniform。 */
export function setScene(U, { lights = [], rooms = [], feet = [], court = null }) {
  U.uNL.value = Math.min(24, lights.length);
  lights.slice(0, 24).forEach((l, i) => {
    U.uL.value[i].set(l.x, l.y, l.z, l.r);
    const c = lin(l.col), k = l.k == null ? 1.6 : l.k;
    U.uLC.value[i].set(c[0] * k, c[1] * k, c[2] * k);
  });
  U.uNR.value = Math.min(8, rooms.length);
  rooms.slice(0, 8).forEach((r, i) => { U.uR.value[i].set(r.x0, r.z0, r.x1, r.z1); U.uRH.value[i].set(r.h, r.open ? 1 : 0, 0, 0); });
  U.uNF.value = Math.min(64, feet.length);
  feet.slice(0, 64).forEach((f, i) => U.uF.value[i].set(f.x, f.z, f.hw, f.hd));
  if (court) { U.uCourt.value.set(court.x0, court.z0, court.x1, court.z1); U.uCourtH.value = court.h; U.uCourtOn.value = 1; }
  else U.uCourtOn.value = 0;
}
