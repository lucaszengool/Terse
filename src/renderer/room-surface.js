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
  stars: 25, bands4: 26, caihua: 27, goldleaf: 28, meander: 29, travertine: 30, girih: 31, interlace: 32,
  herringbone: 33, cofferstar: 34, gridcoffer: 35, carpet: 36, tile40: 37, slab12: 38, triglyph: 39, earth: 40,
  baoxiang: 41, lianzhu: 42, fusuma: 43, pond: 44, kheker: 45, pebble: 46, masonry: 47, fresco: 48, mirror: 49,
  tapestry: 50, colorfield: 51,
  // 小镇的外墙和屋顶
  halftimber: 52, thatch: 53, turf: 54, wattle: 55, shingle: 56,
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
uniform float uKeyK;
uniform vec4 uL[24]; uniform vec3 uLC[24]; uniform int uNL;
uniform vec4 uR[8]; uniform vec4 uRH[8]; uniform int uNR;
uniform vec4 uF[32]; uniform int uNF;   // ⚠ 顶点 uniform 总数要留在 iPhone 的上限(≈256 个 vec4)以内,见 setScene
uniform vec4 uCourt; uniform float uCourtH, uCourtOn;
uniform sampler2D uShadow; uniform mat4 uShadowVP; uniform float uShadowOn, uShadowTexel;
// 朝阳的窗:o.xyz 角点 + w 窗型;U.xyz 宽边 + w 所在房间(uR 的下标);V.xyz 高边
uniform vec4 uWinO[8], uWinU[8], uWinV[8]; uniform int uNWin;
// 光遇的空气与暗部:雾(朝太阳 / 背太阳两色)、暗部的颜色、主案那盏白天的焦点光、色调
uniform vec3 cameraPosition;
uniform vec3 uFogSun, uFogAway, uShadowTint, uLiftCol, uFocalC; uniform vec4 uFocal;
uniform float uFogA, uFogB, uSat, uLift;
uniform vec4 uPick;   // 点了一件家具:(x, z, 点下去的时刻, 强度) —— 一圈光从那里扫开
uniform float uForm;  // 进门那一刻 0 → 1:粒子从四处聚拢成这间屋子
uniform vec4 uStep;   // 最近一步落在哪:(x, z, 时刻, 强度) —— 脚下荡开一圈

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
    // 墙角只轻轻暗一点:光遇的角落是有颜色的柔影,不是脏黑
    ao *= mix(0.68, 1.0, smoothstep(0.0, 0.95, dx)) * mix(0.68, 1.0, smoothstep(0.0, 0.95, dz))
        * mix(0.74, 1.0, smoothstep(0.0, 0.7, d0)) * mix(0.82, 1.0, smoothstep(0.0, 0.9, d1));
    break;
  }
  // 家具脚下:地面上离家具越近越暗 —— 家具才是"放在"地上,不是飘在上面
  if (N.y > 0.5 && P.y < 0.12) {
    for (int i = 0; i < 32; i++) {
      if (i >= uNF) break;
      vec2 q = abs(P.xz - uF[i].xy) - uF[i].zw;
      float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      ao *= mix(0.6, 1.0, smoothstep(-0.04, 0.5, sd));
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
/* 阳光能不能照到这一点:查从太阳那边看过来的深度图(建好时渲染一次,场景不会动)。
   五点取样,影子边是软的。沿法线挪一点再查,免得面自己把自己挡住。 */
float gSunVis = 0.0;
float shadowAt(vec3 P, vec3 N){
  vec4 l = uShadowVP * vec4(P + N * 0.05, 1.0);
  vec3 c = l.xyz / l.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float z = c.z - 0.0009, t = uShadowTexel * 1.5, s = 0.0;
  s += z > texture2D(uShadow, c.xy).r ? 0.0 : 1.0;
  s += z > texture2D(uShadow, c.xy + vec2(t, 0.0)).r ? 0.0 : 1.0;
  s += z > texture2D(uShadow, c.xy - vec2(t, 0.0)).r ? 0.0 : 1.0;
  s += z > texture2D(uShadow, c.xy + vec2(0.0, t)).r ? 0.0 : 1.0;
  s += z > texture2D(uShadow, c.xy - vec2(0.0, t)).r ? 0.0 : 1.0;
  return s / 5.0;
}
/* 屋里的阳光只从窗进来:从这一点朝太阳看,看得见哪扇窗,就被那扇窗照着。
   窗格是算出来的 —— 唐宋格扇、波斯星格、埃及石条、北欧风眼的十字、天眼的圆 ——
   地上的光斑就是那扇窗的样子;离窗越远边越软(太阳有半度大)。 */
float barM(float x, float per, float w, float soft){
  float d = abs(fract(x / per + 0.5) - 0.5) * per;
  return smoothstep(w * 0.5 - soft, w * 0.5 + soft, d);
}
float winVis(vec3 P){
  float v = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uNWin) break;
    vec3 o = uWinO[i].xyz, U = uWinU[i].xyz, V = uWinV[i].xyz;
    float ty = uWinO[i].w, ri = uWinU[i].w;
    // 只照自己那间屋子:别的屋子的点隔着墙,不该被这扇窗照到
    vec4 rr = vec4(-1e4, -1e4, 1e4, 1e4);
    for (int k = 0; k < 8; k++) { if (float(k) == ri) rr = uR[k]; }
    if (P.x < rr.x - 0.1 || P.x > rr.z + 0.1 || P.z < rr.y - 0.1 || P.z > rr.w + 0.1) continue;
    float lu = length(U), lv = length(V);
    vec3 nn = normalize(cross(U, V));
    float dn = dot(uSunDir, nn);
    if (abs(dn) < 1e-3) continue;
    float t = dot(o - P, nn) / dn;
    if (t < 0.03 || t > 18.0) continue;
    vec3 X = P + uSunDir * t - o;
    float au = dot(X, U) / lu, bv = dot(X, V) / lv;
    float soft = 0.01 + t * 0.009;
    float m;
    if (ty > 7.5 && ty < 8.5) {                                            // 天眼:圆
      m = 1.0 - smoothstep(lu * 0.5 - soft, lu * 0.5 + soft, length(vec2(au - lu * 0.5, bv - lv * 0.5)));
    } else {
      m = smoothstep(-soft, soft, au) * smoothstep(-soft, soft, lu - au) * smoothstep(-soft, soft, bv) * smoothstep(-soft, soft, lv - bv);
      if (ty < 1.5) m *= barM(au - 0.12, 0.28, 0.1, soft);                              // 古埃及石条
      else if (ty < 2.5) m *= barM(au - 0.12, 0.12, 0.024, soft) * barM(bv - 0.16, 0.16, 0.024, soft);   // 唐宋格扇
      else if (ty > 3.5 && ty < 4.5) m *= barM(au - 0.14, 0.14, 0.028, soft) * barM(bv - 0.14, 0.14, 0.028, soft) * barM(au - bv, 0.28, 0.024, soft);   // 波斯星格
      else if (ty > 4.5 && ty < 5.5) {                                                    // 北欧风眼:圆洞 + 十字
        m = (1.0 - smoothstep(lu * 0.5 - 0.05 - soft, lu * 0.5 - 0.05 + soft, length(vec2(au - lu * 0.5, bv - lv * 0.5))))
          * barM(au - lu * 0.5, 99.0, 0.05, soft) * barM(bv - lv * 0.5, 99.0, 0.05, soft);
      }
      else if (ty > 6.5 && ty < 7.5) m *= barM(au, 1.3, 0.035, soft);                    // 现代:玻璃竖梃
    }
    v = max(v, m);
  }
  return v;
}
vec3 lightAt(vec3 P, vec3 N, float indoor, float ao){
  vec3 hemi = mix(uGround, uSky, N.y * 0.5 + 0.5);
  float ndl = max(dot(N, uSunDir), 0.0);
  // 有阴影图时,屋里也照得到太阳 —— 只照得到从窗和门进来的那几块
  // 屋里:只看窗(见 winVis);露天:查阴影图,没有阴影图就用院墙的近似
  float vis = ndl > 0.0 ? (indoor > 0.5 ? winVis(P) : (uShadowOn > 0.5 ? shadowAt(P, N) : sunShadow(P))) : 0.0;
  float sun = ndl * vis;
  gSunVis = vis;
  /* 室内白天没有直射光,只有天光 —— 每个面一样亮,形体就没了。补一道从门口方向来的
     柔和"主光":朝门的面亮一点,背着的暗一点,柜子、柱子才立得起来。 */
  // 暗部是有颜色的(每个风格自己的冷色),不是往灰黑里压
  vec3 aoC = mix(uShadowTint, vec3(1.0), ao);
  // 包裹的主光:背着门的面也还有一点光,形体是柔的
  float key = clamp((dot(N, normalize(vec3(0.25, 0.55, 0.8))) + 0.5) / 1.5, 0.0, 1.0) * indoor;
  vec3 day = hemi * aoC * mix(1.0, 0.72, indoor) + uSunCol * (sun * mix(0.9, 1.0, ao) + key * uKeyK * aoC);
  // 焦点:主案一带是全屋最亮的地方(光遇:最亮的光、最强的对比永远给焦点)
  vec3 Lf = uFocal.xyz - P; float df = length(Lf), wf = max(0.0, 1.0 - df / max(uFocal.w, 1e-3));
  day += uFocalC * wf * wf * (0.4 + 0.6 * max(dot(N, Lf / max(df, 1e-3)), 0.0));
  // 夜里是蓝紫色的世界,不是黑的;屋里的月光底色留一半
  // 夜里暗处是蓝紫色的(和暖灯一冷一暖),不是一片黑、也不是全被灯染成金色
  vec3 night = uMoon * aoC * (0.55 + 0.45 * max(N.y, 0.0)) * mix(1.0, 0.75, indoor);
  night += uMoon * 5.0 * sun;                  // 月光从同一个方向进来:地上一块冷蓝的窗影
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
/* 色调:柔和的肩(不用 ACES —— 它把暗部压得又浓又黑、亮部色相跑偏),亮处往粉彩走,
   最暗的地方抬到这个风格的暗部色上,像蒙了一层奶雾。 */
vec3 tone(vec3 x){
  x *= uExposure;
  x = 1.0 - exp(-1.1 * x);
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  x = mix(vec3(l), x, uSat);
  x = pow(max(x, 0.0), vec3(1.0 / 2.2));
  x = mix(x, x * x * (3.0 - 2.0 * x), 0.3);     // 一点 S 形:柔,但不发灰
  return mix(x, uLiftCol, uLift * (1.0 - x));
}
/* 高度雾(Quilez 的解析式):贴地浓、往上淡;看向太阳的那一边雾是暖的。返回雾的遮挡量,
   fc 是这条视线上雾的颜色(显示空间,片元里直接混)。 */
float fogOf(vec3 P, out vec3 fc){
  vec3 ro = cameraPosition, rd = P - ro; float t = length(rd); rd /= max(t, 1e-4);
  float k = abs(rd.y) < 1e-3 ? t : (1.0 - exp(-uFogB * t * rd.y)) / (uFogB * rd.y);
  float od = uFogA * exp(-uFogB * ro.y) * k;
  float s = pow(max(dot(rd, uSunDir), 0.0), 8.0);
  fc = mix(uFogAway, uFogSun, s * (1.0 - uNight));
  return 1.0 - exp(-od);
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
uniform vec4 uRocks[4]; uniform int uNRocks;
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
    // 2:1 的席一行一行错开半张铺 —— 永远不会出现四张席角对角的"十"字缝
    float row = floor(pc.y / 0.9);
    vec2 q = vec2((pc.x + mod(row, 2.0) * 0.9) / 1.8, pc.y / 0.9), f = fract(q), id = floor(q);
    float heri = lineF(f.y, 0.11, fw, 0.9);                     // 长边的黑布边(约 5cm)
    float end = lineF(f.x, 0.012, fw, 1.8);
    vec3 straw = c1 * mix(0.9 + 0.1 * sin(pc.y * 628.0), 0.95, fadeF(fw, 0.012)) * (0.94 + 0.08 * h21(id + seed));
    return mix(mix(straw, straw * 0.7, end), c2 * 0.4, heri);
  } else if (m < 7.5) {                // 白砂:细颗粒 + 耙纹
    float ring = 99.0;
    for (int i = 0; i < 4; i++) { if (i >= uNRocks) break; ring = min(ring, length(P.xz - uRocks[i].xy) - uRocks[i].z); }
    float coord = ring < 1.3 ? ring : pc.y + sin(pc.x * 0.45) * 0.1;
    float r = mix(0.5 + 0.5 * sin(coord * 6.2832 / 0.07), 0.5, fadeF(fw, 0.07));
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
    // 玻璃外面是天:白天一片淡蓝;夜里是深蓝的夜,远处零星几点暖色的城市灯火
    float city = step(0.982, h21(floor(pc * vec2(7.0, 11.0)) + seed)) * (1.0 - smoothstep(1.2, 2.6, pc.y));
    glow = mix(vec3(0.35, 0.45, 0.6) * 0.25, vec3(0.006, 0.009, 0.02) + vec3(1.0, 0.72, 0.42) * city * 0.45, uNight) * (1.0 - mull);
    g *= mix(1.0, 0.35, uNight);
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
    float fl = mix(0.5 + 0.5 * cos(pc.x * TAU_ / 0.16), 0.5, fadeF(fw, 0.16));
    return c1 * (0.72 + 0.3 * fl) * (0.95 + 0.05 * vn(pc * 14.0));
  } else if (m < 22.5) {               // 藻井:一格一格,格心深、格边描色
    vec2 f = fract(pc / 1.1);
    float rim = max(lineF(f.x, 0.16, fw, 1.1), lineF(f.y, 0.16, fw, 1.1));
    float d = max(abs(f.x - 0.5), abs(f.y - 0.5));
    return mix(c1 * (0.55 + 0.45 * d * 2.0), c2, rim * 0.8);
  } else if (m < 23.5) {               // 叶子 / 花瓣:一簇里颜色跳
    return mix(c1, c2, h21(floor(pc * 14.0) + seed)) * (0.8 + 0.3 * vn(pc * 9.0));
  }
  if (m < 24.5) {                      // 刻字的石头(古埃及、玛雅、古希腊的檐壁):一行一行刻进去的记号
    float row = floor(pc.y / 0.34), fy = fract(pc.y / 0.34);
    float mark = step(0.45, h21(vec2(floor(pc.x / 0.13), row) + seed)) * step(0.18, fy) * step(fy, 0.82);
    float cut = mark * step(0.25, fract(pc.x / 0.13)) * step(fract(pc.x / 0.13), 0.8) * (1.0 - fadeF(fw, 0.1));
    vec3 s = c1 * (0.84 + 0.16 * sin(P.y * 8.0 + fbm(pc * 1.6) * 2.5));
    // 墨色的刻痕(古埃及、玛雅)填彩:蓝、红、绿、墨轮着来 —— 浮雕原本就是上了色的
    float mh = h21(vec2(floor(pc.x / 0.13), row) + seed * 1.3);
    vec3 mc = dot(c2, vec3(1.0)) < 0.3 ? (mh < 0.25 ? vec3(0.048, 0.159, 0.434) : (mh < 0.5 ? vec3(0.39, 0.032, 0.013) : (mh < 0.75 ? vec3(0.047, 0.262, 0.144) : c2 * 0.55))) : c2 * 0.55;
    return mix(s, mc, cut * 0.8);
  } else if (m < 25.5) {               // 星空顶(古埃及):深蓝底,每 35cm 一颗 8cm 金色五角星,错行
    vec2 q = pc / 0.35; q.x += mod(floor(q.y), 2.0) * 0.5;
    vec2 cc = (fract(q) - 0.5) * 0.35;
    float a = atan(cc.y, cc.x) + 1.5708, seg = 1.2566, t = abs(mod(a, seg) - seg * 0.5) / (seg * 0.5);
    float rr = mix(0.04, 0.016, t);
    float st = (1.0 - smoothstep(rr * 0.8, rr, length(cc))) * (1.0 - fadeF(fw, 0.05));
    glow = c2 * st * 0.8;
    return mix(c1 * (0.86 + 0.14 * fbm(pc * 1.3 + seed)), c2, st);
  } else if (m < 26.5) {               // 彩带:蓝、绿、红、赭四色一轮,每条 4cm,中间一道墨线
    // 史料是 4cm 一条,可点云里隔几米就糊成一片蓝;放宽到 10cm,四色在远处也分得清
    float k = floor(pc.y / 0.1), i = mod(k, 4.0);
    vec3 cc = i < 0.5 ? c1 : (i < 1.5 ? c2 : (i < 2.5 ? vec3(0.4, 0.035, 0.012) : vec3(0.58, 0.3, 0.05)));
    cc = mix(cc, (c1 + c2) * 0.5, fadeF(fw, 0.1));
    return mix(cc, vec3(0.012, 0.01, 0.009), lineF(fract(pc.y / 0.1), 0.08, fw, 0.1) * 0.7);
  } else if (m < 27.5) {               // 叠晕彩画(唐宋):青绿相间,每段由边到心三晕,墨线勾边
    float seg = 0.6, f = fract(pc.x / seg), id = floor(pc.x / seg);
    vec3 cc = mod(id, 2.0) < 0.5 ? c1 : c2;
    float dd = min(f, 1.0 - f) * seg;
    vec3 col = dd < 0.07 ? mix(cc, vec3(0.8, 0.77, 0.68), 0.55) : (dd < 0.15 ? mix(cc, vec3(0.8, 0.77, 0.68), 0.25) : cc * 0.8);
    col = mix(col, cc * 0.9, fadeF(fw, 0.08));
    float ink = (1.0 - smoothstep(0.012, 0.02, dd)) * (1.0 - fadeF(fw, 0.03));
    return mix(col, vec3(0.022, 0.018, 0.016), ink);
  } else if (m < 28.5) {               // 金箔(江户障壁):10cm 一方,每方深浅略异,方与方之间一线暗缝
    vec2 q = pc / 0.1, id = floor(q), f = fract(q);
    float seam = max(lineF(f.x, 0.05, fw, 0.1), lineF(f.y, 0.05, fw, 0.1));
    return mix(c1 * mix(0.8 + 0.34 * h21(id + seed), 0.97, fadeF(fw, 0.1)), c1 * 0.55, seam * 0.6);
  } else if (m < 29.5) {               // 回纹(古希腊檐壁):3cm 一格的方折纹
    vec2 q = pc / 0.03; float ix = mod(floor(q.x), 6.0), iy = floor(mod(q.y, 6.0));
    float row = iy < 0.5 ? 63.0 : (iy < 1.5 ? 33.0 : (iy < 2.5 ? 45.0 : (iy < 3.5 ? 41.0 : (iy < 4.5 ? 57.0 : 0.0))));
    float bit = mod(floor(row / pow(2.0, ix)), 2.0);
    return mix(c1, c2, mix(bit, 0.45, fadeF(fw, 0.03)));
  } else if (m < 30.5) {               // 洞石(现代):0.6×1.2 的板,横向拉长的纹,几个小孔
    vec2 q = vec2(pc.x / 1.2, pc.y / 0.6), f = fract(q), id = floor(q);
    float seam = max(lineF(f.x, 0.006, fw, 1.2), lineF(f.y, 0.012, fw, 0.6));
    float streak = smoothstep(0.45, 0.75, fbm(vec2(pc.x * 0.9, pc.y * 3.6) + id * 3.1 + seed));
    float pore = step(0.992, h21(floor(pc * 70.0))) * (1.0 - fadeF(fw, 0.02));
    vec3 t = c1 * (0.9 + 0.12 * streak) * (1.0 - pore * 0.35) * (0.97 + 0.05 * h21(id));
    return mix(t, c1 * 0.7, seam * 0.5);
  } else if (m < 31.5) {               // 星形花砖(波斯 girih):五组方向叠出来的十重对称,白色压带
    float s = 0.0;
    for (int k = 0; k < 5; k++) { float an = float(k) * 0.6283; s += cos(dot(pc, vec2(cos(an), sin(an))) * 8.976); }
    vec3 f0 = s > 1.0 ? c2 : (s < -1.0 ? vec3(0.009, 0.022, 0.1) : c1);
    if (s > 3.3) f0 = vec3(0.66, 0.43, 0.08);
    float strap = max(1.0 - smoothstep(0.12, 0.28, abs(s - 1.0)), 1.0 - smoothstep(0.12, 0.28, abs(s + 1.0))) * (1.0 - fadeF(fw, 0.04));
    return mix(f0 * (0.92 + 0.08 * vn(pc * 20.0)), vec3(0.85, 0.8, 0.7), strap);
  } else if (m < 32.5) {               // 交织纹(北欧):两条带子上下穿插
    float v = fract(pc.y / 0.15), ph = pc.x * 6.2832 / 0.3;
    float y1 = 0.5 + 0.32 * sin(ph), y2 = 0.5 - 0.32 * sin(ph);
    float r1 = 1.0 - smoothstep(0.08, 0.12, abs(v - y1)), r2 = 1.0 - smoothstep(0.08, 0.12, abs(v - y2));
    float edge = max(smoothstep(0.05, 0.09, abs(v - y1)) * r1, smoothstep(0.05, 0.09, abs(v - y2)) * r2);
    vec3 col = mix(c1 * 0.8, c2 * (0.85 + 0.15 * step(0.0, cos(ph))), max(r1, r2));
    return mix(col, c1 * 0.35, edge * 0.6 * (1.0 - fadeF(fw, 0.03)));
  } else if (m < 33.5) {               // 人字砖(波斯地面):20×5cm 的砖斜着交错
    vec2 r = vec2(pc.x + pc.y, pc.x - pc.y) * 0.7071;
    float band = floor(r.y / 0.2);
    vec2 b = mod(band, 2.0) < 0.5 ? r : r.yx;
    vec2 f = fract(vec2(b.x / 0.2, b.y / 0.05));
    float gr = max(lineF(f.x, 0.05, fw, 0.2), lineF(f.y, 0.15, fw, 0.05));
    vec3 br = c1 * mix(0.82 + 0.3 * h21(floor(vec2(b.x / 0.2, b.y / 0.05)) + seed), 0.95, fadeF(fw, 0.1));
    return mix(br, c1 * 0.55, gr);
  } else if (m < 34.5) {               // 星藻井(古希腊):60cm 一格,两级退进,蓝底中心一颗金星
    vec2 f = fract(pc / 0.6), cc = (f - 0.5) * 0.6;
    float d = max(abs(f.x - 0.5), abs(f.y - 0.5));
    float a = atan(cc.y, cc.x) + 1.5708, seg = 1.2566, t = abs(mod(a, seg) - seg * 0.5) / (seg * 0.5);
    float rr = mix(0.06, 0.024, t);
    float st = (1.0 - smoothstep(rr * 0.8, rr, length(cc))) * (1.0 - fadeF(fw, 0.06));
    vec3 col = d > 0.42 ? vec3(0.75, 0.7, 0.6) : (d > 0.33 ? c2 * 0.8 : c1 * (0.7 + 0.6 * d));
    col = mix(col, mix(c1, vec3(0.75, 0.7, 0.6), 0.3), fadeF(fw, 0.3));
    glow = c2 * st * 0.45;
    return mix(col, c2, st);
  } else if (m < 35.5) {               // 平棊(唐宋):40cm 一格,红格条,交点一粒金,格心一朵
    vec2 f = fract(pc / 0.4);
    float bar = max(lineF(f.x, 0.125, fw, 0.4), lineF(f.y, 0.125, fw, 0.4));
    vec2 cr = min(f, 1.0 - f) * 0.4, cc = (f - 0.5) * 0.4;
    float node = (1.0 - smoothstep(0.025, 0.035, length(cr))) * (1.0 - fadeF(fw, 0.05));
    float ros = (1.0 - smoothstep(0.05, 0.07, length(cc))) * (1.0 - fadeF(fw, 0.08));
    vec3 col = mix(c1 * (0.85 + 0.15 * vn(pc * 9.0)), vec3(0.38, 0.03, 0.013), bar);
    glow = c2 * node * 0.25;
    return mix(col, c2, max(node, ros * 0.75));
  } else if (m < 36.5) {               // 地毯(波斯):中心一朵大团花,四周花边,流苏
    vec2 p = pc / vec2(4.0, 5.0);   // 8×10 米的一张大毯,几乎铺满主殿
    float bd = max(abs(p.x), abs(p.y));
    float r = length(p * vec2(1.0, 1.4)), pet = 0.5 + 0.5 * cos(atan(p.y, p.x) * 8.0);
    float med = 1.0 - smoothstep(0.34 + 0.06 * pet, 0.38 + 0.06 * pet, r);
    float motif = step(0.6, h21(floor(pc * 5.0) + seed)) * 0.5 + 0.5 * step(0.5, fract((pc.x + pc.y) * 3.0));
    vec3 col = mix(c1 * (0.82 + 0.18 * motif * (1.0 - fadeF(fw, 0.15))), c2, med);
    col = mix(col, vec3(0.78, 0.64, 0.36), med * (1.0 - smoothstep(0.1, 0.14, r)));
    col = mix(col, c2 * 0.8, step(0.84, bd) * step(bd, 0.97));
    return mix(col, vec3(0.76, 0.62, 0.38), step(0.97, bd));
  } else if (m < 37.5) {               // 方砖(唐宋、四合院):40cm 见方,灰缝比砖深
    vec2 q = pc / 0.4, f = fract(q), id = floor(q);
    float gr = max(lineF(f.x, 0.025, fw, 0.4), lineF(f.y, 0.025, fw, 0.4));
    return mix(c1 * mix(0.86 + 0.22 * h21(id + seed), 0.97, fadeF(fw, 0.4)) * (0.95 + 0.05 * fbm(pc * 5.0)), c1 * 0.5, gr);
  } else if (m < 38.5) {               // 大石板(古埃及):1×2 米的砂岩,错缝
    vec2 q = vec2(pc.x / 2.0 + mod(floor(pc.y), 2.0) * 0.5, pc.y), f = fract(q), id = floor(q);
    float gr = max(lineF(f.x, 0.01, fw, 2.0), lineF(f.y, 0.02, fw, 1.0));
    vec3 t = c1 * mix(0.86 + 0.2 * h21(id + seed), 0.95, fadeF(fw, 1.0)) * (0.9 + 0.1 * fbm(pc * 2.0 + id));
    return mix(t, c1 * 0.6, gr);
  } else if (m < 39.5) {               // 三陇板与间板(古希腊檐壁):蓝色三道竖槽,红色方板
    float u = fract(pc.x / 0.75) * 0.75;
    if (u < 0.3) { float g = fract(u / 0.1); float groove = (1.0 - smoothstep(0.0, 0.25, abs(g - 0.5) - 0.2)) * (1.0 - fadeF(fw, 0.1)); return c1 * (0.8 + 0.2 * (1.0 - groove)); }
    return c2 * (0.9 + 0.1 * fbm(pc * 4.0));
  }
  // 夯土地(北欧长屋):斑驳的土,几根灯芯草
  if (m < 40.5) return c1 * (0.75 + 0.35 * fbm(pc * 1.7 + seed)) * (0.9 + 0.1 * h21(floor(pc * 30.0)) * (1.0 - fadeF(fw, 0.03)));
  if (m < 41.5) {                      // 宝相花(唐):1.2m 一团 —— 八瓣外圈、十六瓣内圈、花心,每层由边到心退晕;四角补半朵
    vec2 q = fract(pc / 1.2) - 0.5; float r = length(q) * 1.2, a = atan(q.y, q.x);
    vec3 col = c1;
    float o = 0.40 + 0.07 * (0.5 + 0.5 * cos(a * 8.0)) - r;
    col = mix(col, mix(vec3(0.8, 0.745, 0.6), vec3(0.014, 0.076, 0.195), clamp(o / 0.12, 0.0, 1.0)), step(0.0, o));
    float mi = 0.25 + 0.05 * (0.5 + 0.5 * cos(a * 16.0 + 0.4)) - r;
    col = mix(col, mix(vec3(0.85, 0.45, 0.35), vec3(0.39, 0.032, 0.014), clamp(mi / 0.1, 0.0, 1.0)), step(0.0, mi));
    float co = 0.1 - r;
    col = mix(col, mix(c2, vec3(0.028, 0.205, 0.138), clamp(co / 0.06, 0.0, 1.0)), step(0.0, co));
    vec2 qc = (abs(q) - 0.5) * 1.2; float cr = 0.2 + 0.04 * cos(atan(qc.y, qc.x) * 6.0) - length(qc);
    col = mix(col, mix(vec3(0.8, 0.745, 0.6), vec3(0.028, 0.205, 0.138), clamp(cr / 0.08, 0.0, 1.0)), step(0.0, cr));
    float edge = (1.0 - smoothstep(0.0, 0.012, abs(o))) + (1.0 - smoothstep(0.0, 0.01, abs(mi)));
    col = mix(col, c2, clamp(edge, 0.0, 1.0) * 0.8 * (1.0 - fadeF(fw, 0.03)));
    return mix(col, mix(c1, vec3(0.3, 0.12, 0.08), 0.4), fadeF(fw, 0.25));
  }
  if (m < 42.5) {                      // 联珠团窠(唐锦):一圈珍珠围一个团花,0.5m 一个,团心青绿相间
    vec2 id = floor(pc / 0.5), q = (fract(pc / 0.5) - 0.5) * 0.5;
    float r = length(q), a = atan(q.y, q.x);
    float pearl = (1.0 - smoothstep(0.016, 0.022, abs(r - 0.19))) * step(0.25, 0.5 + 0.5 * cos(a * 18.0));
    vec3 inner = mod(id.x + id.y, 2.0) < 0.5 ? vec3(0.014, 0.076, 0.195) : vec3(0.028, 0.205, 0.138);
    vec3 col = mix(c1, inner, step(r, 0.165));
    col = mix(col, vec3(0.39, 0.032, 0.014), step(r, 0.05 + 0.06 * abs(cos(a * 2.0))));
    col = mix(col, c2, step(r, 0.03));
    col = mix(col, vec3(0.85, 0.8, 0.66), pearl);
    return mix(col, mix(c1, inner, 0.4), fadeF(fw, 0.06));
  }
  if (m < 43.5) {                      // 襖绘(江户,狩野派):金箔方块做底,一棵老松 —— 弯的干、横出的枝、墨绿的针叶团、金色云霞
    vec2 q = pc / 0.1, id = floor(q), f = fract(q);
    float seam = max(lineF(f.x, 0.05, fw, 0.1), lineF(f.y, 0.05, fw, 0.1));
    vec3 col = mix(c1 * mix(0.8 + 0.34 * h21(id + seed), 0.97, fadeF(fw, 0.1)), c1 * 0.55, seam * 0.6);
    float cloud = smoothstep(0.52, 0.6, fbm(vec2(pc.x * 0.5, pc.y * 2.2) + seed * 3.0)) * smoothstep(0.9, 1.4, pc.y);
    col = mix(col, c1 * 1.25 + vec3(0.05, 0.04, 0.0), cloud * 0.7);
    float xx = mod(pc.x + seed * 1.7, 3.8) - 1.9 + 0.35 * sin(pc.y * 1.4 + seed);
    float trunk = (1.0 - smoothstep(0.05, 0.09, abs(xx))) * step(pc.y, 1.3);
    float br = (1.0 - smoothstep(0.03, 0.05, abs(pc.y - 1.05 - 0.25 * sin(pc.x * 1.1 + seed)))) * step(abs(xx), 1.3);
    col = mix(col, vec3(0.06, 0.035, 0.02), max(trunk, br * 0.9));
    float nd = fbm(pc * vec2(2.2, 3.4) + seed * 5.0);
    float clump = smoothstep(0.58, 0.64, nd) * step(abs(xx), 1.6) * smoothstep(0.7, 1.0, pc.y) * step(pc.y, 1.75);
    return mix(col, mix(vec3(0.012, 0.06, 0.025), vec3(0.05, 0.16, 0.06), smoothstep(0.62, 0.75, nd)), clump);
  }
  if (m < 44.5) {                      // 彩绘地面(阿玛纳大宫):一池蓝水 —— 折线的水纹、莲叶、睡莲、鱼
    vec3 col = vec3(0.04, 0.14, 0.36) * (0.85 + 0.15 * sin(pc.x * 3.0 + pc.y * 2.0));
    float zz = abs(fract(pc.x * 3.0 + abs(fract(pc.y * 6.0) - 0.5)) - 0.5);
    col = mix(col, vec3(0.2, 0.4, 0.7), (1.0 - smoothstep(0.03, 0.06, zz)) * 0.5 * (1.0 - fadeF(fw, 0.05)));
    vec2 id = floor(pc / 0.7), f = fract(pc / 0.7) - 0.5; float hh = h21(id + seed);
    vec2 cc = f - (vec2(h21(id * 1.7), h21(id * 2.3)) - 0.5) * 0.4;
    col = mix(col, vec3(0.047, 0.262, 0.1), step(length(cc * 0.7), 0.11) * step(0.35, hh) * step(0.15, abs(atan(cc.y, cc.x) - 0.6)));
    col = mix(col, vec3(0.8, 0.7, 0.75), step(length(cc * 0.7 - vec2(0.09, 0.05)), 0.04) * step(0.7, hh));
    vec2 id2 = floor(pc / 1.1), f2 = fract(pc / 1.1) - 0.5;
    col = mix(col, vec3(0.62, 0.2, 0.03), step(length(f2 * vec2(1.0, 2.6) - vec2(0.1, 0.0)), 0.13) * step(0.55, h21(id2 + seed * 2.0)));
    return mix(col, vec3(0.06, 0.18, 0.35), fadeF(fw, 0.2));
  }
  if (m < 45.5) {                      // 纸莎草束楣(埃及 kheker,0.5m 高):一束束立着,顶上圆头,腰间扎两道;红蓝绿黄轮换
    float k = mod(floor(pc.x / 0.14), 4.0), u = fract(pc.x / 0.14) - 0.5, v = pc.y;
    vec3 cc = k < 0.5 ? vec3(0.39, 0.032, 0.013) : (k < 1.5 ? vec3(0.048, 0.159, 0.434) : (k < 2.5 ? vec3(0.047, 0.262, 0.144) : vec3(0.578, 0.296, 0.048)));
    float stem = step(abs(u), 0.3) * step(v, 0.34);
    float dome = step(length(vec2(u * 1.1, (v - 0.36) * 1.6)), 0.36) * step(0.33, v);
    float knot = step(abs(v - 0.3), 0.025) + step(abs(v - 0.24), 0.015);
    vec3 col = mix(c1, cc, max(stem, dome));
    col = mix(col, c2, clamp(knot, 0.0, 1.0) * step(abs(u), 0.34));
    col = mix(col, vec3(0.02), (1.0 - smoothstep(0.0, 0.02, abs(abs(u) - 0.3))) * stem * 0.6 * (1.0 - fadeF(fw, 0.02)));
    return mix(col, mix(c1, vec3(0.2, 0.12, 0.08), 0.5), fadeF(fw, 0.12));
  }
  if (m < 46.5) {                      // 卵石镶嵌(佩拉):黑底上白、赭、红的卵石拼出卷草,每颗石子一点色差
    float pb = h21(floor(pc / 0.02) + seed);
    float s = sin(pc.x * 3.2 + sin(pc.y * 2.1) * 2.0) * cos(pc.y * 3.0 + sin(pc.x * 1.7));
    float tend = 1.0 - smoothstep(0.06, 0.12, abs(s - 0.2));
    float leaf = step(0.72, fbm(pc * 1.5 + seed));
    vec3 col = vec3(0.018, 0.016, 0.015);
    col = mix(col, vec3(0.75, 0.72, 0.64), tend);
    col = mix(col, vec3(0.42, 0.22, 0.06), leaf * (1.0 - tend));
    col = mix(col, vec3(0.3, 0.035, 0.02), step(0.9, pb) * tend);
    col *= mix(0.8 + 0.35 * pb, 1.0, fadeF(fw, 0.02));
    return mix(col, vec3(0.2, 0.18, 0.15), fadeF(fw, 0.15));
  }
  if (m < 47.5) {                      // 仿石块彩色灰泥(希腊"第一风格"):一块一种颜色 —— 红赭、黄、黑、绿、仿大理石,块边留一道浅框
    vec2 q = vec2(pc.x / 1.2 + mod(floor(pc.y / 0.6), 2.0) * 0.5, pc.y / 0.6), id = floor(q), f = fract(q);
    float k = floor(h21(id + seed) * 5.0);
    vec3 cc = k < 0.5 ? vec3(0.39, 0.06, 0.03) : (k < 1.5 ? vec3(0.58, 0.36, 0.08) : (k < 2.5 ? vec3(0.03, 0.03, 0.035) : (k < 3.5 ? vec3(0.06, 0.2, 0.12) : c1)));
    float v = fbm(pc * 1.3 + id * 3.0); cc *= 0.85 + 0.3 * v;
    cc = mix(cc, cc + vec3(0.25), pow(1.0 - abs(sin(pc.x * 2.0 + pc.y + v * 8.0)), 18.0) * 0.5 * (1.0 - fadeF(fw, 0.05)));
    return mix(cc, c1 * 1.05, max(lineF(f.x, 0.04, fw, 1.2), lineF(f.y, 0.08, fw, 0.6)) * 0.8);
  }
  if (m < 48.5) {                      // 壁画(伯南帕克):玛雅蓝底,一排排人像 —— 羽冠、赭红的脸、白/玉绿/红的衣;每层之间一道红带
    vec2 f = vec2(fract(pc.x / 0.6), fract(pc.y / 1.3)), id = vec2(floor(pc.x / 0.6), floor(pc.y / 1.3));
    float hh = h21(id + seed), on = step(0.25, hh);
    vec3 col = c1 * (0.9 + 0.1 * fbm(pc * 2.0));
    vec3 cloth = hh < 0.5 ? vec3(0.8, 0.75, 0.62) : (hh < 0.75 ? vec3(0.076, 0.254, 0.11) : vec3(0.325, 0.027, 0.016));
    float body = step(abs(f.x - 0.5), 0.13 - (f.y - 0.1) * 0.05) * step(0.1, f.y) * step(f.y, 0.6);
    float head = step(length((f - vec2(0.5, 0.67)) * vec2(1.0, 2.2)), 0.07);
    float plume = step(abs(f.x - 0.5 - (f.y - 0.72) * (hh - 0.5)), 0.09 + (f.y - 0.72) * 0.6) * step(0.72, f.y) * step(f.y, 0.9);
    col = mix(col, cloth, body * on);
    col = mix(col, vec3(0.33, 0.09, 0.03), head * on);
    col = mix(col, mix(vec3(0.076, 0.254, 0.11), vec3(0.584, 0.323, 0.045), step(0.5, fract(hh * 7.0))), plume * on);
    col = mix(col, vec3(0.325, 0.027, 0.016), step(f.y, 0.035));
    col = mix(col, vec3(0.02), (1.0 - smoothstep(0.0, 0.01, abs(f.y - 0.035))) * (1.0 - fadeF(fw, 0.02)));
    return mix(col, c1 * 0.85 + vec3(0.03, 0.01, 0.0), fadeF(fw, 0.2));
  }
  if (m < 49.5) {                      // 镜面镶嵌(波斯 ayeneh-kari):斜着拼的小镜片,星花压在上面;每片映一种颜色的光,闪
    vec2 rr = vec2(pc.x + pc.y, pc.x - pc.y) * 0.7071 / 0.045, id = floor(rr), f = fract(rr) - 0.5;
    float hh = h21(id + seed);
    vec3 tint = mix(vec3(0.7, 0.72, 0.78), 0.5 + 0.5 * cos(6.2831 * (hh + vec3(0.0, 0.33, 0.67))), 0.35);
    float facet = 1.0 - smoothstep(0.38, 0.48, max(abs(f.x), abs(f.y)));
    float s = 0.0;
    for (int k = 0; k < 4; k++) { float an = float(k) * 0.7854; s += cos(dot(pc, vec2(cos(an), sin(an))) * 10.0); }
    vec3 col = mix(c2 * 0.4, tint * mix(0.55, 1.0, smoothstep(1.2, 2.0, s)), facet);
    glow = tint * facet * pow(hh, 8.0) * 0.9 * (0.6 + 0.4 * sin(uTime * 1.3 + hh * 40.0));
    return mix(col, vec3(0.45, 0.46, 0.5), fadeF(fw, 0.05));
  }
  if (m < 50.5) {                      // 挂毯(奥塞贝格,0.6m 高):红底一队人马往前走,上下两道黄蓝格边
    float v = fract(pc.y / 0.6), u = pc.x;
    float edge = clamp(step(v, 0.1) + step(0.9, v), 0.0, 1.0);
    vec3 chk = mod(floor(u / 0.05) + floor(pc.y / 0.05), 2.0) < 0.5 ? vec3(0.58, 0.4, 0.06) : vec3(0.03, 0.08, 0.2);
    vec3 col = mix(c1, chk, edge);
    vec2 f = vec2(fract(u / 0.7) - 0.5, (v - 0.1) / 0.8); float hh = h21(vec2(floor(u / 0.7), seed));
    float leg = step(0.1, f.y) * step(f.y, 0.42);
    float horse = step(length((f - vec2(0.0, 0.42)) * vec2(1.0, 2.2)), 0.22) + step(abs(f.x + 0.18), 0.03) * leg + step(abs(f.x - 0.16), 0.03) * leg + step(length(f - vec2(0.26, 0.62)), 0.08);
    float rider = step(abs(f.x + 0.02), 0.05) * step(0.5, f.y) * step(f.y, 0.85) + step(length(f - vec2(-0.02, 0.9)), 0.05);
    col = mix(col, hh < 0.5 ? vec3(0.03, 0.08, 0.2) : vec3(0.58, 0.4, 0.06), clamp(horse, 0.0, 1.0) * (1.0 - edge));
    col = mix(col, vec3(0.75, 0.7, 0.6), clamp(rider, 0.0, 1.0) * (1.0 - edge));
    return mix(col, mix(c1, vec3(0.2, 0.15, 0.1), 0.3), fadeF(fw, 0.1));
  }
  if (m > 51.5 && m < 52.5) {          // 木骨泥墙(Fachwerk):白灰墙上一根根深色木 —— 立柱 1.2 米一根,每层上下两道横梁,有的开间斜撑
    float bay = floor(pc.x / 1.2), sto = floor(pc.y / 2.8);
    vec2 f = vec2(fract(pc.x / 1.2), fract(pc.y / 2.8));
    float post = lineF(f.x, 0.13, fw, 1.2);
    float rail = max(lineF(f.y, 0.07, fw, 2.8), lineF(fract(pc.y / 2.8 + 0.55), 0.05, fw, 2.8));
    float hb = h21(vec2(bay, sto) + seed);
    // 斜撑:这个开间从左下到右上(或反过来),两种都有才像手搭的
    float dg = hb < 0.3 ? abs(f.x - f.y) : (hb < 0.5 ? abs(1.0 - f.x - f.y) : (hb < 0.62 ? min(abs(f.x - f.y), abs(1.0 - f.x - f.y)) : 1.0));
    float brace = 1.0 - smoothstep(0.05, 0.05 + max(fw / 1.2, 0.02), dg);
    float wood = max(max(post, rail), brace * (1.0 - fadeF(fw, 0.3)));
    vec3 lime = c1 * (0.9 + 0.1 * fbm(pc * 2.2 + seed)) * (0.94 + 0.06 * hb);
    vec3 oak = c2 * (0.8 + 0.3 * fbm(vec2(pc.x * 9.0, pc.y * 0.8) + seed));
    return mix(lime, oak, mix(wood, 0.24, fadeF(fw, 0.35)));
  }
  if (m > 52.5 && m < 53.5) {          // 茅草:顺着坡的一缕缕草,一层层压着;背阴的地方长青苔
    float course = lineF(fract(pc.y / 0.34), 0.1, fw, 0.34);
    float streak = mix(0.5 + 0.5 * sin(pc.x * 190.0 + fbm(pc * vec2(4.0, 0.6)) * 9.0), 0.5, fadeF(fw, 0.03));
    float moss = smoothstep(0.55, 0.8, fbm(pc * 0.35 + seed));
    vec3 straw = c1 * (0.78 + 0.3 * streak) * (0.9 + 0.12 * fbm(pc * 1.3 + seed));
    return mix(mix(straw, straw * 0.62, course), c2, moss * 0.7);
  }
  if (m > 53.5 && m < 54.5) {          // 草皮屋顶(北欧):一块块草皮,草色里夹着土色和小花
    float v = fbm(pc * 0.8 + seed);
    vec3 g = mix(c1, c2, smoothstep(0.35, 0.75, v));
    float tuft = mix(h21(floor(pc * 18.0) + seed), 0.5, fadeF(fw, 0.06));
    float flower = step(0.985, h21(floor(pc * 7.0) + seed * 3.0)) * (1.0 - fadeF(fw, 0.14));
    return mix(g * (0.8 + 0.4 * tuft), vec3(0.85, 0.8, 0.45), flower);
  }
  if (m > 54.5 && m < 55.5) {          // 编篱(wattle):竖桩 0.45 米一根,枝条上下穿过去
    float stake = lineF(fract(pc.x / 0.45), 0.12, fw, 0.45);
    float row = floor(pc.y / 0.07);
    float over = 0.5 + 0.5 * sin((pc.x / 0.45 + mod(row, 2.0)) * 3.14159);
    float gap = lineF(fract(pc.y / 0.07), 0.2, fw, 0.07);
    vec3 twig = c1 * mix(0.6 + 0.5 * over, 0.85, fadeF(fw, 0.2)) * (0.9 + 0.2 * h21(vec2(row, seed)));
    return mix(mix(twig, twig * 0.4, gap), c2, stake);
  }
  if (m > 55.5 && m < 56.5) {          // 木瓦:一排排错缝的小木片,每片色调不同,风吹日晒成银灰
    float row = floor(pc.y / 0.2);
    vec2 q = vec2((pc.x + mod(row, 2.0) * 0.08) / 0.16, pc.y / 0.2), id = floor(q), f = fract(q);
    float edge = max(lineF(f.x, 0.08, fw, 0.16), lineF(f.y, 0.1, fw, 0.2));
    vec3 t = mix(c1, c2, h21(id + seed)) * mix(0.8 + 0.3 * h21(id * 1.7 + seed), 0.95, fadeF(fw, 0.2));
    return mix(t, t * 0.45, edge * (1.0 - fadeF(fw, 0.16)));
  }
  // 色域画(现代):上下两块柔边的大色块(罗斯科那样);每幅的配色由它自己的 c1 定
  float hc = fract(dot(c1, vec3(3.1, 5.7, 7.3)) + seed * 0.13);
  vec3 a1 = 0.5 + 0.45 * cos(6.2831 * (hc + vec3(0.0, 0.33, 0.67)));
  vec3 a2 = 0.5 + 0.45 * cos(6.2831 * (hc + 0.4 + vec3(0.0, 0.33, 0.67)));
  float band = smoothstep(0.42, 0.5, fract(pc.y / 1.6) + 0.04 * fbm(pc * 3.0));
  return mix(a1 * a1, a2 * a2, band) * (0.85 + 0.15 * fbm(pc * 2.5 + seed));
}
`;

/* 一片上的一颗点在哪、朝哪 —— 主着色器和投影着色器必须算得一模一样,否则影子和实物错位。 */
const POS_BLOCK = `
  float shape = iS.x, m = iS.y, seed = iS.z, fl = iS.w;
  float indoor = mod(fl, 2.0), glowF = mod(floor(fl / 2.0), 2.0), flip = mod(floor(fl / 4.0), 2.0);
  // 格点抖一抖:整整齐齐的网格远看会起摩尔纹
  vec2 j = vec2(h21(position.xy * 91.7 + seed), h21(position.yx * 53.3 + seed * 1.7)) - 0.5;
  // 抖得太多会在点之间开出小洞(夜里墙上一粒粒黑点就是这个)
  // 壁纸的粒子是散的:每颗在自己那一格里随机落位(几乎一整格),不留规则网格 ——
  // 网格会织出一层半调网点,静止时特别难看(壁纸那边踩过)。点间不规则的黑缝正是粒子感
  vec2 uv = clamp(position.xy + j * 0.95 / uN, 0.0, 1.0);
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
`;

const PATCH_VS = `
precision highp float;
#define TAU_ 6.28318530718
attribute vec3 position;            // (u, v, 抖动种子) —— n×n 的格点
attribute vec3 iO; attribute vec3 iA; attribute vec3 iB; attribute vec4 iS; attribute vec4 iT;
attribute vec3 iC1; attribute vec3 iC2;
uniform mat4 modelViewMatrix, projectionMatrix;
uniform float uN, uPx, uFogK, uDayGlow, uSootY, uDetailFw, uWashH, uGlitter, uGlitterDen;
uniform float uDotK, uDotMax, uBreath, uSparkle, uBackCull, uSnowCov; uniform vec2 uCull;
uniform vec3 uLod, uRim, uRimNight;
varying vec3 vCol, vFogCol; varying float vFog;
${NOISE_GLSL}
${LIGHT_GLSL}
${MATERIAL_GLSL}
void main(){
${POS_BLOCK}  /* 入场:粒子从四面八方聚拢成这间屋子(和壁纸的字一样聚出来),离人近的先到。
     光照和材质仍按落定的位置 P 算,只有画在哪儿(Pd)在飞。 */
  // 近处那份细的 / 远处那份粗的:各画各的一半(见 uCull)
  if (uCull.x != 0.0) {
    float dc = length(P.xz - cameraPosition.xz);
    if ((uCull.x > 0.0 && dc < uCull.y) || (uCull.x < 0.0 && dc > uCull.y)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
    }
  }
  if (uBreath > 0.0) {
    float bt = uTime * 0.22;
    P += vec3(sin(P.z * 0.31 + bt) + sin(P.y * 0.63 - bt * 1.3) * 0.6,
              sin(P.x * 0.37 + bt * 1.1) * 0.8,
              cos(P.x * 0.29 - bt) + cos(P.y * 0.55 + bt * 0.9) * 0.6) * uBreath;
  }
  float fm = clamp(uForm * 1.6 - length(P - cameraPosition) / 30.0, 0.0, 1.0);
  vec3 rv = vec3(h21(position.xy * 17.3 + seed) - 0.5, h21(position.yx * 29.1 + seed), h21(position.xy * 7.7 - seed) - 0.5);
  vec3 Pd = P + (rv * vec3(16.0, 10.0, 16.0) + vec3(0.0, 2.0, 0.0)) * pow(1.0 - fm, 3.0);
  /* 还在飞的点只留一部分,落定一颗补一颗:聚拢 / 散开的那一两秒里,几百万颗点飞到镜头跟前、
     每颗画成 64 像素,GPU 一帧要填几十亿个像素 —— 换楼、进门就卡在那里(真机上一样)。 */
  if (fm < 0.999 && h21(position.xy * 53.1 + seed) > 0.25 + 0.75 * fm) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
  }
  vec4 mv = modelViewMatrix * vec4(Pd, 1.0);
  vec4 clip = projectionMatrix * mv;
  float d = -mv.z;
  /* 看不见的点先扔掉,再算材质和光 —— 任何时候都有一半的点在身后。 */
  if (d < 0.05 || abs(clip.x) > clip.w * 1.2 || abs(clip.y) > clip.w * 1.2) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
  }
  /* 背面的点扔掉(小镇用):点盖不满一面墙,缝里透出来的是房子另一面的背面 —— 没光、全黑,
     和正面的亮点混在一起,一面墙就是一片黑白芝麻。屋里是 0:人在里面,四面都要。 */
  if (uBackCull > 0.0 && dot(N, cameraPosition - P) < 0.0) {
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
  // 这颗点盖住多宽的地;比 uDetailFw 还细的纹理(灰缝、木纹、席纹、小孔)一律画平均色 —— 大形,不要碎
  float fw = max(max(iT.z, iT.w) / uN * stride, uDetailFw);
  vec3 alb = albedo(m, pc, P, N, iC1, iC2, seed, fw, glow);
  // 纹样和颜色原样保留(各风格的颜色就是它的样子);只加一米上下很淡的一层柔晕
  alb *= 0.97 + 0.06 * vn(P.xz * 0.8 + P.y * 0.5);
  // 北欧长屋:上三分之一被烟熏暗(暗成烟紫,不是焦黑)
  if (uSootY > 0.0 && indoor > 0.5) alb *= mix(1.0, 0.72, smoothstep(uSootY * 0.62, uSootY, P.y));
  float ao = aoOf(P, N);
  vec3 lit = lightAt(P, N, indoor, ao);
  vec3 col = alb * lit + glow * mix(uDayGlow, 1.0, uNight);
  vec3 V = normalize(cameraPosition - P);
  // 釉面、漆、金箔、金属:太阳下有一点高光 —— 砖"亮"起来靠的就是这一点
  float gloss = (m > 4.5 && m < 5.5) || (m > 30.5 && m < 31.5) || (m > 11.5 && m < 12.5) || (m > 27.5 && m < 28.5) ? 1.0 : ((m > 10.5 && m < 11.5) ? 0.6 : 0.0);
  if (gloss > 0.0) col += uSunCol * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 40.0) * gloss * 0.35 * gSunVis * (1.0 - uNight);
  // 逆光的边:迎着太阳看时轮廓亮起一圈 —— 光遇的剪影是亮的,不是描黑
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  vec3 rimD = mix(uRim, uSunCol * 0.45, back) * (0.22 + 0.6 * back);
  col += mix(rimD, uRimNight, uNight) * fres * mix(0.7, 1.0, ao);
  // 闪光(风之旅人的沙):金、描金、釉面,和这个风格的地面上,零星几颗点朝太阳一闪;走动时自己会闪
  float gm = (m > 10.5 && m < 11.5) || (m > 27.5 && m < 28.5) ? 0.8 : ((m > 4.5 && m < 5.5) || (m > 30.5 && m < 31.5) ? 0.4 : 0.0);
  float gl = max(gm, N.y > 0.5 ? uGlitter : 0.0), den = gm > 0.0 ? 0.05 : uGlitterDen;
  if (gl > 0.0 && h21(position.xy * 91.7 + seed) > 1.0 - den) {
    vec3 jn = normalize(N + (vec3(h21(position.xy * 13.1 + seed), h21(position.yx * 7.7 + seed), h21(position.xy * 3.3 - seed)) - 0.5) * 0.9);
    col += uSunCol * pow(max(dot(reflect(-uSunDir, jn), V), 0.0), 60.0) * gl * (0.3 + 0.7 * gSunVis) * (1.0 - uNight);
  }
  // 雪:露天朝上的面积一层白(小镇冬天的屋顶、台阶、墙头)
  if (uSnowCov > 0.0 && indoor < 0.5) col = mix(col, vec3(0.86, 0.9, 0.98) * mix(lit, vec3(1.0), 0.25), uSnowCov * smoothstep(0.35, 0.75, N.y) * (0.75 + 0.25 * h21(position.xy * 17.0 + seed)));
  vec3 fc; vFog = 1.0 - fogOf(P, fc); vFogCol = fc;
  // 每颗点自己一点明暗(点彩):一片面是许多颗粒子,不是一张塑料皮
  // 每颗自己一点明暗,再自己慢慢闪(壁纸字形粒子的 twinkle,幅度收小):一片面是许多颗活的粒子
  float pr = h21(position.xy * 71.3 + seed * 5.1);
  // 明暗像壁纸:多数颗偏暗、少数颗亮;再有零星几颗隔一阵亮一下(pow 的闪,和壁纸 twinkle 同一个形)
  float spark = pow(0.5 + 0.5 * sin(uTime * (0.3 + pr * 0.8) + pr * 40.0), 6.0);
  // ×1.3:点变小、点间留黑以后,每颗要更亮才像是在发光(平均亮度大致不变)
  // 每颗粒子的色相微微偏一点(±10°,YIQ 里转):一片颜色是许多颗略不同的彩色粒子,绚丽,不是一块色
  vec3 tc = tone(col);
  float hA = (pr - 0.5) * 0.35, hcs = cos(hA), hsn = sin(hA);
  vec3 yiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * tc;
  yiq.yz = mat2(hcs, hsn, -hsn, hcs) * yiq.yz;
  tc = max(mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * yiq, 0.0);
  // 每颗点自己的明暗:屋里要这个颗粒感,镇上收到三成 —— 不然一面墙就是一片椒盐
  vCol = tc * 1.25 * mix(1.0, 0.72 + 0.55 * pr * pr + 0.45 * spark * step(0.7, fract(pr * 13.7)), uSparkle);
  // 光的涟漪:每隔十来秒一圈亮光从主案出发,扫过整座粒子建筑,扫到的粒子亮一下(壁纸的涟漪)
  float rw = length(P.xz - uFocal.xz) + P.y * 0.3, ph = mod(uTime * 2.6, 34.0) - 4.0;
  vCol *= 1.0 + 0.55 * exp(-(rw - ph) * (rw - ph) * 0.6);
  // 点一件家具:一圈光从它那里扫开,4 秒里由强到淡(发光点那边同一圈,沿数据流一起走)
  float pk = uTime - uPick.z, rp = length(P.xz - uPick.xy) - pk * 6.0;
  vCol *= 1.0 + 0.9 * uPick.w * exp(-rp * rp * 0.8) * max(0.0, 1.0 - pk / 4.0);
  // 光跟着人走(teamLab):站的地方,脚下和身边柔柔地亮一圈
  vec2 dq = P.xz - cameraPosition.xz;
  vCol *= 1.0 + 0.3 * exp(-dot(dq, dq) * 0.3) * (1.0 - smoothstep(0.0, 1.6, P.y));
  // 走一步,地上荡开一圈
  float sk = uTime - uStep.z, rs = length(P.xz - uStep.xy) - sk * 2.2;
  vCol *= 1.0 + 0.7 * uStep.w * exp(-rs * rs * 16.0) * max(0.0, 1.0 - sk / 1.3) * step(P.y, 0.12);
  /* 点的直径:按这一片上**较疏那一向**的点距取,盖得严;但不许超过这一片窄边的一大半 ——
     一本 3cm 宽的书脊,用 3cm 的点去画,边就成了一圈花边。 */
  float sL = max(iT.z, iT.w) / uN, mn = min(iT.z, iT.w);
  // 1.75 倍点距:两颗相邻的点各自抖开,中间也不会漏出底色(墙上的黑斑)
  // 点比点距略大一点点:柔光点的芯挨着芯,边上露出黑 —— 看得出一颗颗粒子
  float diam = min(sL * 0.75, max(mn * 0.5, sL * 0.6));
  diam *= 0.9 + 0.2 * h21(position.xy * 37.1 + seed * 3.3);   // 点略有大小:没有网格感,边也不毛
  gl_PointSize = clamp(diam * stride * uDotK * uPx / max(d, 0.05), 1.0, uDotMax) * clamp((d - 0.25) / 0.6, 0.0, 1.0) * mix(0.35, 1.0, fm);
  gl_Position = clip;
}`;

/* 投影:从太阳那边看,只写深度。玻璃和自己发光的东西(纸灯、灯罩)不挡光。 */
const SHADOW_VS = `
precision highp float;
#define TAU_ 6.28318530718
attribute vec3 position;
attribute vec3 iO; attribute vec3 iA; attribute vec3 iB; attribute vec4 iS; attribute vec4 iT;
uniform mat4 uShadowVP; uniform float uN, uShadowPx;
${NOISE_GLSL}
void main(){
${POS_BLOCK}
  if ((m > 9.5 && m < 10.5) || glowF > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float sL = max(iT.z, iT.w) / uN, mn = min(iT.z, iT.w);
  float diam = min(sL * 1.75, max(mn * 0.55, sL * 0.9));
  gl_Position = uShadowVP * vec4(P, 1.0);
  gl_PointSize = clamp(diam * uShadowPx * 1.6, 1.0, 48.0);
}`;
const SHADOW_LOOSE_VS = `
precision highp float;
attribute vec3 position; attribute float aS;
uniform mat4 uShadowVP; uniform float uShadowPx;
void main(){ gl_Position = uShadowVP * vec4(position, 1.0); gl_PointSize = clamp(aS * uShadowPx * 1.3, 1.0, 48.0); }`;
const SHADOW_FS = `
precision highp float;
void main(){ vec2 d = gl_PointCoord - vec2(0.5); if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vec3(gl_FragCoord.z), 1.0); }`;

const DOT_FS = `
precision highp float;
uniform vec3 uFog;
uniform float uSoft, uFlat, uGrain;
varying vec3 vCol, vFogCol; varying float vFog;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  /* 和 Terse 壁纸(mineradio-wallpaper.js)同一颗粒子:makeDotTexture 那张 64×64 径向渐变
     (0.96 → 0.78 → 0.22 → 0),往外渐隐进点与点之间的黑里;再加 Mineradio 的"可读边" ——
     亮粒子的边略压暗、暗粒子的边略提亮,每一颗都看得清。 */
  float r = sqrt(r2) * 2.0;
  float a = r < 0.42 ? mix(0.96, 0.78, r / 0.42) : (r < 0.72 ? mix(0.78, 0.22, (r - 0.42) / 0.3) : mix(0.22, 0.0, (r - 0.72) / 0.28));
  if (a < 0.2) discard;
  float lum = dot(vCol, vec3(0.299, 0.587, 0.114));
  float rim = smoothstep(0.44, 0.94, r) * (1.0 - smoothstep(0.94, 1.08, r)) * (1.0 - uSoft);
  vec3 c = mix(vCol, vec3(0.0), rim * smoothstep(0.5, 0.82, lum) * 0.38);
  c = mix(c, vec3(1.0), rim * (1.0 - smoothstep(0.2, 0.5, lum)) * 0.2);
  // 细腻模式:一颗点就是一小团柔和的光晕,中间实、边上化开,没有"球"的明暗
  a = mix(a, exp(-r * r * 2.6) * 0.96, uSoft);
  /* 实心的片(小镇):屋里的点往边上暗进黑里,背景就是黑,看着是发光的粒子;到了室外,
     背后是天,每颗点就成了一颗黑边的珠子,一面墙像一面筛子。这里边上只暗一点点。 */
  c *= mix(a / 0.96, 0.8 + 0.2 * a / 0.96, uFlat);
  /* 颗粒边(小镇):这条管线不透明、不混合,一颗点的边只能"有"或"没有" —— 远看每颗都是
     一颗硬边的塑料珠子。这里按离中心的远近**按概率**丢掉边上的像素(每个像素的阈值固定,
     不闪),一颗点就成了一小团往外化开的细沙;点再略放大一点,补回盖住率。 */
  if (uGrain > 0.0) {
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (n > mix(1.0, smoothstep(1.0, 0.3, r), uGrain)) discard;
  }
  gl_FragColor = vec4(mix(vFogCol, c, vFog), 1.0);
}`;

/* 零散的点(树冠、花、苔、鱼……):位置、法线、颜色、大小都是 CPU 给的,光照和小片同一套。 */
const LOOSE_VS = `
precision highp float;
#define TAU_ 6.28318530718
attribute vec3 position; attribute vec3 aN; attribute vec3 aC; attribute float aS;
uniform mat4 modelViewMatrix, projectionMatrix;
uniform float uPx, uFogK, uDotK, uDotMax, uBreath; uniform vec2 uCull;
varying vec3 vCol, vFogCol; varying float vFog;
${NOISE_GLSL}
${LIGHT_GLSL}
void main(){
  vec3 N = normalize(aN);
  if (uCull.x != 0.0) {
    float dc = length(position.xz - cameraPosition.xz);
    if ((uCull.x > 0.0 && dc < uCull.y) || (uCull.x < 0.0 && dc > uCull.y)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
    }
  }
  float ao = aoOf(position, N);
  vCol = tone(aC * lightAt(position, N, 0.0, ao));
  // 入场聚拢(和小片那边同一条曲线)
  float fm = clamp(uForm * 1.6 - length(position - cameraPosition) / 30.0, 0.0, 1.0);
  vec3 rv = vec3(h21(position.xz * 17.3) - 0.5, h21(position.zx * 29.1), h21(position.xz * 7.7) - 0.5);
  // 飞着的点只留一部分、画小一点(和小片那边同一个理由)
  if (fm < 0.999 && h21(position.xz * 53.1 + 0.7) > 0.25 + 0.75 * fm) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vFog = 0.0; return;
  }
  vec4 mv = modelViewMatrix * vec4(position + (rv * vec3(16.0, 10.0, 16.0) + vec3(0.0, 2.0, 0.0)) * pow(1.0 - fm, 3.0), 1.0);
  float d = -mv.z;
  vec3 fc; vFog = 1.0 - fogOf(position, fc); vFogCol = fc;
  gl_PointSize = clamp(aS * uDotK * uPx / max(d, 0.05), 1.0, uDotMax) * clamp((d - 0.25) / 0.6, 0.0, 1.0) * mix(0.35, 1.0, fm);
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
    uMoon: { value: new THREE.Vector3(0.055, 0.065, 0.13) },
    uL: { value: v4(24) }, uLC: { value: v3(24) }, uNL: { value: 0 },
    uR: { value: v4(8) }, uRH: { value: v4(8) }, uNR: { value: 0 },
    uF: { value: v4(32) }, uNF: { value: 0 },
    uCourt: { value: new THREE.Vector4() }, uCourtH: { value: 3.6 }, uCourtOn: { value: 0 },
    uPx: { value: 800 }, uFogK: { value: 0.0003 }, uFog: { value: new THREE.Color(0, 0, 0) },
    // 抽稀的三档距离(米):这之内全密度,之外依次 1/4、1/16、1/64
    uLod: { value: new THREE.Vector3(7, 14, 28) },
    uShadow: { value: null }, uShadowVP: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 },
    uShadowTexel: { value: 1 / 2048 }, uShadowPx: { value: 40 },
    uDayGlow: { value: 0.15 }, uKeyK: { value: 0.22 }, uRim: { value: new THREE.Vector3(0.2, 0.18, 0.15) }, uSootY: { value: 0 },
    uRocks: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uNRocks: { value: 0 },
    uWinO: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uWinU: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uWinV: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uNWin: { value: 0 },
    uFogSun: { value: new THREE.Vector3(0.9, 0.85, 0.8) }, uFogAway: { value: new THREE.Vector3(0.7, 0.72, 0.8) },
    uFogA: { value: 0.03 }, uFogB: { value: 0.25 }, uShadowTint: { value: new THREE.Vector3(0.8, 0.82, 1) },
    uSat: { value: 0.92 }, uLift: { value: 0.07 }, uLiftCol: { value: new THREE.Vector3(0.4, 0.42, 0.55) },
    uFocal: { value: new THREE.Vector4(0, 1.6, 0, 0) }, uFocalC: { value: new THREE.Vector3() },
    uRimNight: { value: new THREE.Vector3() }, uDetailFw: { value: 0.045 }, uWashH: { value: 6 },
    uGlitter: { value: 0 }, uGlitterDen: { value: 0 },
    /* 一颗点画多大、最大几个像素、边缘怎么收。屋里 (1, 64, 0):点挨着点,盖成实的面。
       小镇 (0.6, 13, 1):点很小很细,而且不带那圈"球面"的明暗 —— 大点 + 边缘反差 =
       一颗颗塑料珠子,近看就露馅。 */
    uDotK: { value: 1 }, uDotMax: { value: 64 }, uSoft: { value: 0 },
    /* 小镇用:同一座镇建两份 —— 远处一份很粗的(所有房子),近处一份很细的(最近那十几栋)。
       uCull.x > 0 只画离人 uCull.y 以外的,< 0 只画以内的;= 0 全画(屋里就是 0)。 */
    uCull: { value: new THREE.Vector2(0, 0) },
    /* 每颗点极慢地飘几厘米(一个平滑的流场)。屋里是 0;小镇 3–4 厘米 —— 静止的点云
       看着像标本,轻轻一动就"活"了,而且几乎不要钱。 */
    uBreath: { value: 0 },
    /* 每颗点自己闪一下的幅度。屋里 1(一片墙是许多颗活的粒子);小镇 0.3 —— 几百万颗
       同时闪就不是"活",是电视雪花。 */
    uSparkle: { value: 1 },
    uBackCull: { value: 0 },
    uFlat: { value: 0 },
    uGrain: { value: 0 },
    uSnowCov: { value: 0 },
    uPick: { value: new THREE.Vector4(0, 0, -99, 0) },
    uForm: { value: 1 }, uStep: { value: new THREE.Vector4(0, 0, -99, 0) },
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
    const group = new THREE.Group(), shadow = new THREE.Group();
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
      const smat = new THREE.RawShaderMaterial({ uniforms: Object.assign({}, uniforms, { uN: { value: n } }), vertexShader: SHADOW_VS, fragmentShader: SHADOW_FS });
      mats.push(smat);
      const sp = new THREE.Points(g, smat);
      sp.frustumCulled = false;
      shadow.add(sp);
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
      const smat = new THREE.RawShaderMaterial({ uniforms, vertexShader: SHADOW_LOOSE_VS, fragmentShader: SHADOW_FS });
      mats.push(smat);
      const sp = new THREE.Points(g, smat);
      sp.frustumCulled = false;
      shadow.add(sp);
    }
    group.userData.shadow = shadow;
    group.userData.dispose = () => {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      mats.forEach((m) => m.dispose());
    };
    group.userData.points = this.count + L.s.length;
    return group;
  }
}

/** 把灯、房间、家具脚印、院子写进 uniform。 */
const WIN_TYPE = { slats: 1, lattice: 2, shoji: 3, jali: 4, porthole: 5, slots: 6, glass: 7, oculus: 8, smokehole: 9 };
export function setScene(U, { lights = [], rooms = [], feet = [], court = null, rocks = [], windows = [] }) {
  // 朝阳的窗(障子不算:江户是纸透进来的柔光,没有硬光斑),大的先上,最多 16 扇
  const sd = U.uSunDir.value;
  const wins = windows.filter((w) => w.type !== 'shoji' && -(sd.x * w.n[0] + sd.y * w.n[1] + sd.z * w.n[2]) > 0.05)
    .map((w) => ({ w, area: Math.hypot(...w.U) * Math.hypot(...w.V) })).sort((a, b) => b.area - a.area).slice(0, 8);
  U.uNWin.value = wins.length;
  wins.forEach(({ w }, i) => {
    const ri = w.r ? rooms.slice(0, 8).findIndex((o) => Math.abs(o.x0 - w.r.x0) < 1e-3 && Math.abs(o.z0 - w.r.z0) < 1e-3) : -1;
    U.uWinO.value[i].set(w.o[0], w.o[1], w.o[2], WIN_TYPE[w.type] || 6);
    U.uWinU.value[i].set(w.U[0], w.U[1], w.U[2], ri);
    U.uWinV.value[i].set(w.V[0], w.V[1], w.V[2], 0);
  });
  U.uNRocks.value = Math.min(4, rocks.length);
  rocks.slice(0, 4).forEach((r, i) => U.uRocks.value[i].set(r.x, r.z, r.r, 0));
  U.uNL.value = Math.min(24, lights.length);
  lights.slice(0, 24).forEach((l, i) => {
    U.uL.value[i].set(l.x, l.y, l.z, l.r);
    const c = lin(l.col), k = l.k == null ? 1.6 : l.k;
    U.uLC.value[i].set(c[0] * k, c[1] * k, c[2] * k);
  });
  U.uNR.value = Math.min(8, rooms.length);
  rooms.slice(0, 8).forEach((r, i) => { U.uR.value[i].set(r.x0, r.z0, r.x1, r.z1); U.uRH.value[i].set(r.h, r.open ? 1 : 0, 0, 0); });
  /* ⚠ iPhone 上顶点着色器只有约 256 个 vec4 的 uniform。灯 24+24、房间 8+8、家具脚印 32、
     窗 8×3、砂纹石头 4,加上矩阵和零散的标量,要一直留在这条线以下 —— 超了不报错,
     只是整间屋子一个点都不画(桌面上限高得多,本地根本测不出来)。 */
  U.uNF.value = Math.min(32, feet.length);
  feet.slice(0, 32).forEach((f, i) => U.uF.value[i].set(f.x, f.z, f.hw, f.hd));
  if (court) { U.uCourt.value.set(court.x0, court.z0, court.x1, court.z1); U.uCourtH.value = court.h; U.uCourtOn.value = 1; }
  else U.uCourtOn.value = 0;
}

/**
 * 从太阳那边把整座楼画一张深度图,交给光照去查"这一点晒不晒得到"。
 * 场景是静止的,所以建好之后只画一次;换昼夜只改 uNight,不重画。
 * @param b 要罩住的范围 {x0, z0, x1, z1, y1}
 * @returns 释放函数
 */
export function renderShadowMap(renderer, U, group, b, res = 2048) {
  const sd = U.uSunDir.value.clone().normalize();
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, H = b.y1 || 8, cy = H / 2;
  const R = Math.hypot(b.x1 - b.x0, b.z1 - b.z0, H) / 2 + 2;
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, R * 4);
  cam.position.set(cx + sd.x * R * 2, cy + sd.y * R * 2, cz + sd.z * R * 2);
  cam.lookAt(cx, cy, cz);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const rt = new THREE.WebGLRenderTarget(res, res);
  rt.depthTexture = new THREE.DepthTexture(res, res);
  rt.depthTexture.type = THREE.UnsignedIntType;
  U.uShadowVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  U.uShadowPx.value = res / (2 * R);
  const sc = new THREE.Scene();
  sc.add(group.userData.shadow);
  const prevRT = renderer.getRenderTarget(), prevC = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear(true, true, true);
  renderer.render(sc, cam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevC, prevA);
  sc.remove(group.userData.shadow);
  U.uShadow.value = rt.depthTexture;
  U.uShadowTexel.value = 1 / res;
  U.uShadowOn.value = 1;
  return () => { try { rt.dispose(); } catch (e) {} };
}
