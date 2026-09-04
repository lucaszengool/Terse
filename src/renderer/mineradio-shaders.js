/**
 * mineradio-shaders.js — Mineradio 的粒子 GLSL,**逐字**抽取,未作任何改动。
 *
 * 来源:XxHuberrr/Mineradio → js/00-pointer-cover-particles.js(v7.1)
 *   · MR_VS       顶点着色器(6 个 preset:SILK / TUNNEL / ORBIT / VOID / VINYL / WALLPAPER PULSE)
 *   · MR_FS       片元着色器(soft-dot + 可读性描边)
 *   · MR_BLOOM_FS 辉光孪生层的片元着色器
 *   · MR_BLOOM_VS 由 MR_VS 按原项目的两处 replace 派生(点大小 ×uBloomSize)
 *
 * 机械抽取生成 —— 不要手改,要改就改上游再重新抽取。
 * 例外是标了 (Terse) 的两段:danceAt / uSpace。它们不在上游,重新抽取之后要补回来。
 */

export const MR_VS = `
precision highp float;
uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;
uniform float uPreset, uIntensity, uDepth, uPointScale, uSpeed, uTwist;
uniform float uVinylSpin;
uniform float uColorBoost, uScatter, uCoverRes, uBgFade;
uniform float uHasCover, uHasDepth, uEdgeEnabled, uAiBoost;
uniform float uMouseActive, uPixel, uColorMixT, uLoading;
uniform sampler2D uCoverTex, uPrevCoverTex, uEdgeTex, uRippleTex;
uniform int uRippleCount;
uniform vec2 uMouseXY, uHandXY;
uniform float uHandActive, uGestureGrip;
uniform vec3 uTintColor;
uniform float uTintStrength;
// ── Terse 加的,不是 Mineradio 的 ───────────────────────────────────────────
// 中间那句 big text 出现时,粒子"轻轻起舞"用的编舞参数。见下面 danceAt()。
uniform float uDanceAmt, uDanceMode, uDanceT;
uniform vec2 uDanceCenter, uDanceDir;
// PULSE 层的取景比 SILK 大得多(半高 11.5 对 2.4),两层坐标不是一个尺度。
// uDanceScale = PULSE_HALF_H / (PLANE_SIZE/2),用来把字的位置和动作幅度换算过去。
uniform float uDanceScale;
// ── 3D 自由视角 (Terse) ─────────────────────────────────────────────────────
// 0 = 原来那张平的丝绸(逐位不变),1 = 把深度图撑成真正的浮雕。相机绕着它转的时候
// 前后景要分得开,否则转到侧面只剩一条线 —— 这个 uniform 就是"这幅画有多厚"。
uniform float uSpace;
attribute vec2 aUv;
attribute float aRand;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

#define PI 3.14159265359

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

vec2 safeCoverUv(vec2 uv) {
  return clamp(uv, vec2(0.0012), vec2(0.9988));
}

vec3 sampleNewCoverColor(vec2 uv) {
  return texture2D(uCoverTex, safeCoverUv(uv)).rgb;
}

vec3 samplePrevCoverColor(vec2 uv) {
  return texture2D(uPrevCoverTex, safeCoverUv(uv)).rgb;
}

vec4 sampleEdgeColor(vec2 uv) {
  return texture2D(uEdgeTex, safeCoverUv(uv));
}

float rippleSumAt(vec2 p, out float maxAmp) {
  float sum = 0.0; maxAmp = 0.0;
  for (int ri = 0; ri < 12; ri++) {
if (ri >= uRippleCount) break;
float vCoord = (float(ri) + 0.5) / 12.0;
vec4 rd = texture2D(uRippleTex, vec2(0.5, vCoord));
float age = rd.z; float str = rd.w;
if (str < 0.005 || age < 0.0 || age > 2.0) continue;
float dx = p.x - rd.x, dy = p.y - rd.y;
float dist = sqrt(dx*dx + dy*dy);
float lifeN = age / 2.0;
float fadeIn  = smoothstep(0.0, 0.06, age);
float fadeOut = 1.0 - smoothstep(0.7, 1.0, lifeN);
float env = fadeIn * fadeOut;
// v7.1: 把幅度放大 — 中心凸起更高更宽
float bulgeW = 0.55 + age * 0.80;
float bulge  = exp(-dist*dist / (2.0 * bulgeW * bulgeW)) * (1.0 - smoothstep(0.0, 0.55, lifeN));
float waveR  = age * 2.10;
float ringW  = 0.40 + age * 0.22;
float ring   = exp(-pow((dist - waveR) / ringW, 2.0));
// v7.1: 提升整体幅度 ×2
float local  = (bulge * 2.4 + ring * 1.30) * env * str;
sum += local;
maxAmp = max(maxAmp, abs(local));
  }
  return sum;
}

// ── 轻轻起舞 (Terse) ────────────────────────────────────────────────────────
// rippleSumAt 只会做一种运动:从一个点向外扩散的圆环。八种"图案"其实都是同一个
// 圆环在不同位置重复,所以看久了永远是"一圈一圈往外推"。这里给的是十段真正不同
// 的编舞 —— 平移波、旋绕、呼吸、摇曳、闪烁、涟纹 —— 每段都是**持续而轻柔**的,
// 靠 uDanceAmt 的包络随中间那句 big text 一起浮起、落下,而不是砸一下就没了。
//
// 返回 .xy = 平面内的漂移,.z = 起伏。uDanceAmt 为 0 时整段直接短路,不进入的
// 分支 GPU 也不会执行,静止时没有任何代价。
vec3 danceAt(vec2 p, float rnd) {
  if (uDanceAmt < 0.001) return vec3(0.0);
  vec2 d = p - uDanceCenter;
  float dist = length(d);
  float t = uDanceT;
  // 以那句话为中心的柔和衰减:动作从字里长出来,又够得到画面边上
  float reach = exp(-dist * dist / 14.0);
  vec3 o = vec3(0.0);
  float m = uDanceMode;

  if (m < 0.5) {
// 0 行云 —— 一道缓慢的隆起横穿画面
float ph = dot(p, uDanceDir) * 0.80 - t * 1.15;
o.z = sin(ph) * 0.44;
o.xy = uDanceDir * cos(ph) * 0.11;
  } else if (m < 1.5) {
// 1 回旋 —— 整片粒子绕着那句话轻轻转
float a = 0.42 * reach * sin(t * 0.85);
float c = cos(a), s = sin(a);
o.xy = mat2(c, -s, s, c) * d - d;
o.z = reach * sin(t * 1.25 + dist * 0.4) * 0.30;
  } else if (m < 2.5) {
// 2 呼吸 —— 向字靠拢又散开
float b = sin(t * 1.05) * reach;
o.xy = d / max(dist, 0.001) * b * 0.36;
o.z = b * 0.38;
  } else if (m < 3.5) {
// 3 摇曳 —— 像风里的草,越往外摆得越开
float sway = sin(t * 0.95 + p.y * 0.50 + rnd * 1.3);
o.x = sway * (0.11 + abs(p.y) * 0.070);
o.z = sway * 0.20 * (0.35 + reach);
  } else if (m < 4.5) {
// 4 星落 —— 每颗粒子按自己的相位起落,是闪烁不是波
float ph = t * 1.45 + rnd * 6.2831;
o.z = sin(ph) * 0.32 * (0.40 + reach);
o.xy = vec2(cos(ph * 0.7), sin(ph * 0.5)) * 0.055;
  } else if (m < 5.5) {
// 5 涟纹 —— 会漂移的驻波脊,像水下的沙纹
float ph = dot(p, uDanceDir) * 1.75 + sin(t * 0.55) * 1.5;
o.z = sin(ph) * cos(dist * 0.45 - t * 0.75) * 0.38;
o.xy = uDanceDir * sin(ph) * 0.065;
  } else if (m < 6.5) {
// 6 星涡 —— 星系式的剪切旋转:越远的粒子转得越"落后",整片粒子拧成旋臂
float a = 0.52 * reach * sin(t * 0.62) + dist * 0.15 * sin(t * 0.30);
float c = cos(a), s = sin(a);
o.xy = mat2(c, -s, s, c) * d - d;
o.z = sin(dist * 0.90 - t * 1.10) * 0.30 * (0.35 + reach);
  } else if (m < 7.5) {
// 7 潮汐 —— 唯一一段**不以字为中心**的编舞:整幅画面一起缓慢起落,
//    所以它在没有字的时候也成立(静水风格拿它当底噪就是为了这个)
float ph = p.y * 0.42 + t * 0.42;
o.z = sin(ph) * 0.30 + sin(p.x * 0.26 - t * 0.31) * 0.22;
o.xy = vec2(sin(t * 0.36 + p.y * 0.22) * 0.10, cos(t * 0.28) * 0.06);
  } else if (m < 8.5) {
// 8 心跳 —— 从字里推出去的同心环,一次强一次弱(收缩压/舒张压那种双拍)
float bt = fract(t * 0.46);
float env = exp(-bt * 3.2) + 0.62 * exp(-fract(bt + 0.72) * 3.6);
float ring = sin(dist * 2.4 - t * 3.0);
o.z = ring * env * 0.46 * (0.30 + reach);
o.xy = d / max(dist, 0.001) * ring * env * 0.10;
  } else {
// 9 落雪 —— 每颗粒子按自己的相位慢慢往下飘,边飘边摆。
//    w 这个窗函数是关键:相位绕回 0 的那一刻位移必须也是 0,否则粒子会瞬移一下。
float f = fract(t * 0.16 + rnd);
float w = sin(f * 3.14159265);
o.y = (0.5 - f) * 0.40 * w;
o.x = sin(t * 0.70 + rnd * 6.2831) * 0.09 * w;
o.z = sin(t * 0.50 + rnd * 12.0) * 0.22 * (0.35 + reach);
  }
  return o * uDanceAmt;
}

void main(){
  float t = uTime * uSpeed;
  vec3 pos;
  vec2 sampleUv = safeCoverUv(aUv);
  // 切歌颜色渐变: 在新旧封面间 mix
  vec3 newCol = sampleNewCoverColor(sampleUv);
  vec3 prevCol = samplePrevCoverColor(sampleUv);
  vec3 coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
  vec4 edge = sampleEdgeColor(sampleUv);
  float depthVal = edge.r;
  float edgeVal  = edge.g;
  float fgMask   = edge.b;
  float lumVal   = edge.a;
  float maxRippleAmp = 0.0;
  float rippleZ = 0.0;

  vec3 defaultColor = mix(
vec3(0.36, 0.28, 0.72),
mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), aUv.x),
aUv.y
  );
  vColor = mix(defaultColor, coverColor, uHasCover);
  vAlpha = 1.0;

  // 律动强度的真实倍数 (放大 intensity 滑块的影响)
  float K = uIntensity * 1.6;   // 滑块 1.0 → K=1.6, 滑块 1.6 → K=2.56

  // ====================================================
  //  Preset 0: SILK — 丝绸 (xy 平面, z 涟漪)
  //  v7.1: 全部位移 ×2.5
  // ====================================================
  if (uPreset < 0.5) {
pos = position;
rippleZ = rippleSumAt(pos.xy, maxRippleAmp);

float midN = snoise(vec3(pos.x*1.4, pos.y*1.4, t*0.55)) * 0.6
           + snoise(vec3(pos.x*2.8+5.0, pos.y*2.8-3.0, t*0.85)) * 0.4;
float midMask = 0.55 + 0.45 * snoise(vec3(pos.x*0.4, pos.y*0.4, t*0.18));
float midDisp = midN * uMid * 0.55 * midMask * K;       // 0.20 → 0.55

float trebleJ = snoise(vec3(pos.x*6.5, pos.y*6.5, t*3.5 + aRand*4.0)) * uTreble * 0.18 * K;  // 0.06→0.18
float bassBreath = snoise(vec3(pos.x*0.35, pos.y*0.35, t*0.4)) * uBass * 0.42 * K;          // 0.14→0.42

// AI 深度: 显著强化 (0.85 → 1.4)
float depthZ = (depthVal - 0.5) * uAiBoost * uDepth * 1.40 * uHasDepth;

pos.z = rippleZ * 1.30 + midDisp + trebleJ + bassBreath + depthZ;

// 3D 自由视角:平面 → 体积。深度图负责前后景的分层,噪声负责起伏 —— 没有深度图的
// 机器(uHasDepth=0)也得有东西可看。uSpace=0 时整段短路,静止画面不受影响。
if (uSpace > 0.001) {
  // 幅度是量出来的:平面半高 2.4,总位移超过 ±1.5 就不再是"一张有起伏的面",
  // 而是一团厚度和画面一样高的云 —— 转到侧面只看得到噪声,看不到自己的壁纸。
  float relief = (depthVal - 0.5) * 1.70 * uHasDepth;
  float swell  = snoise(vec3(pos.x * 0.42, pos.y * 0.42, 17.0)) * 0.42
               + snoise(vec3(pos.x * 1.10, pos.y * 1.10, 31.0)) * 0.17;
  pos.z += (relief + swell + (aRand - 0.5) * 0.16) * uSpace;
}

// 编舞叠在最后 —— SILK 就是那层会起伏的粒子平面,舞台在这儿
vec3 dnc = danceAt(pos.xy, aRand);
pos.xy += dnc.xy;
pos.z += dnc.z;
maxRippleAmp = max(maxRippleAmp, abs(dnc.z) * 0.55);
  }

  // ====================================================
  //  Preset 1: TUNNEL — 隧道 + 自旋
  // ====================================================
  else if (uPreset < 1.5) {
// v7.1: 整体自旋 — 整管缓慢绕 Z 轴
float spin = t * 0.12;
float angle = aUv.x * 2.0 * PI + spin;
float flow = aUv.y - t * 0.08 * (1.0 + uBass * 0.55);
flow = fract(flow);
float zPos = (flow - 0.5) * 9.0;
float baseR = 2.0 - uBass * 0.28 * K;                  // bass 收缩更明显
float ripG  = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (uMid + uTreble) * K;   // 0.04→0.10
float r = baseR + ripG;
pos.x = cos(angle) * r;
pos.y = sin(angle) * r;
pos.z = zPos;

sampleUv = vec2(aUv.x, flow);
sampleUv = safeCoverUv(sampleUv);
newCol = sampleNewCoverColor(sampleUv);
prevCol = samplePrevCoverColor(sampleUv);
coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
vColor = mix(defaultColor, coverColor, uHasCover);

float depthFade = smoothstep(-4.5, 4.5, zPos);
vColor *= 0.4 + depthFade * 0.7;
  }

  // ====================================================
  //  Preset 2: ORBIT — 星球 (保留自转)
  //  v7.1: 律动幅度加大
  // ====================================================
  else if (uPreset < 2.5) {
float theta = aUv.x * 2.0 * PI;
float phi   = (aUv.y - 0.5) * PI;
float baseR = 2.2;
float trebFlare = snoise(vec3(theta * 1.5, phi * 1.5, t * 0.7)) * uTreble * 0.85 * K;   // 0.40→0.85
float bassExpand = uBass * 0.35 * K;                                                      // 0.18→0.35
float r = baseR * (1.0 + bassExpand) + trebFlare;

pos.x = r * cos(phi) * cos(theta);
pos.y = r * sin(phi);
pos.z = r * cos(phi) * sin(theta);

float yaw = t * 0.18;
float cy = cos(yaw), sy = sin(yaw);
pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;
  }

  // ====================================================
  //  Preset 3: VOID — 虚空 (无粒子, 适合自定义背景)
  // ====================================================
  else if (uPreset < 3.5) {
pos = vec3((aUv.x - 0.5) * 0.01, (aUv.y - 0.5) * 0.01, -90.0);
vAlpha = 0.0;
vColor = vec3(0.0);
maxRippleAmp = 0.0;
  }

  // ====================================================
  //  Preset 4: VINYL RECORD
  //  A real record layout: circular album cover in the center, black vinyl
  //  grooves outside, and a complete white particle rim.
  // ====================================================
  else if (uPreset < 4.5) {
float bassDrive = smoothstep(0.08, 0.78, uBass + uBeat * 0.82);
float highDrive = smoothstep(0.05, 0.46, uTreble);
float hiResGuard = smoothstep(1.08, 1.55, uCoverRes);
float edgeGuard = mix(1.0, 0.38, hiResGuard);
float depthGuard = mix(1.0, 0.44, hiResGuard);
float grooveGuard = mix(1.0, 0.48, hiResGuard);
float beatGuard = mix(1.0, 0.36, hiResGuard);

vec2 p = (aUv - 0.5) * 5.12;
float spin = uVinylSpin;
float cs = cos(spin), sn = sin(spin);
vec2 rp = mat2(cs, -sn, sn, cs) * p;
float d = length(p);
float angle0 = atan(p.y, p.x);
float recordR = 2.46;
float coverR = 1.18;
float recordAlpha = 1.0 - smoothstep(recordR - 0.02, recordR + 0.05, d);
float coverMask = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
float border = exp(-pow((d - coverR) / 0.064, 2.0)) * edgeGuard;
float outerRim = exp(-pow((d - (recordR - 0.050)) / 0.055, 2.0)) * edgeGuard;
float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);

pos = vec3(rp * (1.0 + bassDrive * 0.012 * beatGuard + uBeat * 0.026 * beatGuard), 0.0);
vAlpha = recordAlpha;

if (coverMask > 0.02) {
  vec2 coverUv = p / (coverR * 2.0) + 0.5;
  newCol = sampleNewCoverColor(coverUv);
  prevCol = samplePrevCoverColor(coverUv);
  coverColor = mix(prevCol, newCol, clamp(uColorMixT, 0.0, 1.0));
  if (hiResGuard > 0.001) {
    vec2 sx = vec2(0.0026, 0.0);
    vec2 sy = vec2(0.0, 0.0026);
    vec3 softNew = (sampleNewCoverColor(coverUv + sx) + sampleNewCoverColor(coverUv - sx) + sampleNewCoverColor(coverUv + sy) + sampleNewCoverColor(coverUv - sy)) * 0.25;
    vec3 softPrev = (samplePrevCoverColor(coverUv + sx) + samplePrevCoverColor(coverUv - sx) + samplePrevCoverColor(coverUv + sy) + samplePrevCoverColor(coverUv - sy)) * 0.25;
    coverColor = mix(coverColor, mix(softPrev, softNew, clamp(uColorMixT, 0.0, 1.0)), hiResGuard * 0.42);
  }
  vColor = mix(defaultColor, coverColor, uHasCover);
  float coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR, d));
  vColor *= coverShade;
  vColor = mix(vColor, vec3(1.0), border * 0.54);
  pos.z = 0.040 + border * 0.026 * depthGuard + uBeat * 0.018 * beatGuard;
  maxRippleAmp = max(maxRippleAmp, border * 0.30 + bassDrive * 0.075 * beatGuard + uBeat * 0.075 * beatGuard);
} else {
  float groove = 0.5 + 0.5 * sin((d - coverR) * mix(98.0, 58.0, hiResGuard));
  float fineGroove = 0.5 + 0.5 * sin((d - coverR) * mix(170.0, 92.0, hiResGuard) + aRand * 3.0);
  float tick = smoothstep(0.82, 0.995, hash11(floor((angle0 + PI) * 38.0) + floor(d * 72.0) * 2.1));
  vec3 vinyl = vec3(0.052, 0.054, 0.058) + vec3(0.052 * grooveGuard) * groove + vec3(0.026 * grooveGuard) * fineGroove;
  vinyl = mix(vinyl, coverColor * 0.32, 0.18 * (1.0 - vinylN));
  float whiteRing = max(border * 0.92, outerRim * 0.26);
  vColor = mix(vinyl, vec3(0.92, 0.94, 0.94), whiteRing);
  vColor = mix(vColor, vec3(1.0), tick * highDrive * (0.06 + border * 0.12) * grooveGuard);
  pos.z = groove * 0.010 * grooveGuard + border * 0.024 * depthGuard + bassDrive * vinylN * 0.016 * K * beatGuard + tick * highDrive * 0.010 * grooveGuard;
  maxRippleAmp = max(maxRippleAmp, border * 0.32 + outerRim * 0.12 + bassDrive * vinylN * 0.11 * beatGuard + tick * highDrive * 0.10 * grooveGuard + uBeat * vinylN * 0.08 * beatGuard);
}
  }

  // ====================================================
  //  Preset 5: WALLPAPER PULSE
  //  Layered music-particle wallpaper: aurora ribbons, depth sparks,
  //  and cover-colored audio flow.
  // ====================================================
  else {
float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;
float midGlow = smoothstep(0.07, 0.62, uMid) * 0.42;
float highGlow = smoothstep(0.04, 0.46, uTreble) * 0.46;
float lane = aUv.y;
float transition = clamp(uBurstAmt, 0.0, 1.0);

if (lane < 0.80) {
  float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;
  float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
  float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
  float band = floor(bandCoord);
  float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);
  float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
  float seed = hash11(band * 19.17 + aRand * 31.0);
  float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);
  float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);
  float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);
  float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;
  float x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5);
  float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;
  float broadWave = sin(ribbonPhase) * 0.92;
  float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;
  float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92;
  float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;
  float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));
  float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
  float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;
  float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;

  pos.x = x + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;
  pos.y = yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);
  pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;

  float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);
  vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);
  aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);
  vAlpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);
  vColor = mix(coverColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);
  maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + midGlow * 0.05) + pulseLine * highGlow * 0.045 + bassGlow * 0.030);
} else {
  float q = (lane - 0.80) / 0.20;
  float seed = hash11(aRand * 917.0 + floor(q * 130.0));
  float depth = mix(-32.0, 18.0, seed);
  float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);
  float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));
  float x = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;
  float y = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;
  float z = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;
  float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);
  float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));

  pos = vec3(x, y, z);
  vAlpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);
  vColor = mix(coverColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);
  maxRippleAmp = max(maxRippleAmp, twinkle * highGlow * 0.055 + dust * bassGlow * 0.030);
}

if (transition > 0.001) {
  float bloom = smoothstep(0.0, 1.0, transition);
  vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;
  vec2 burstDir = burstVec / max(length(burstVec), 0.001);
  pos.xy += burstDir * bloom * 0.026;
  pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;
  pos.xy *= 1.0 + bloom * 0.014;
  pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;
  vAlpha *= 0.86 + bloom * 0.22;
  maxRippleAmp = max(maxRippleAmp, bloom * 0.10);
}

// ── 那团 blur 的粒子也起舞 ──────────────────────────────────────────────
// 就是屏幕中间那一团(极光带 + 星尘),外加它的辉光孪生层,所以看起来是"糊"的。
// 之前这里只有一句通用的摇摆,幅度 0.55 —— 这层可视半高是 11.5 个世界单位,
// 0.55 只有 5%,等于没动。现在换成和 SILK 同一套编舞(十段),并且:
//   · 中心换算过来(× uDanceScale),动作是从那句话所在的位置长出来的;
//   · 幅度按取景比例放大,再乘 1.5 —— 「幅度大一点」。
if (uDanceAmt > 0.001) {
  float t5 = uDanceT;
  float m5 = uDanceMode;
  // 字在 SILK 平面上的位置换算到这一层的取景里
  vec2 c5 = uDanceCenter * uDanceScale;
  vec2 d5 = pos.xy - c5;
  float dist5 = length(d5);
  // 衰减半径也跟着取景放大,否则一团粒子里只有正中间几颗会动
  float reach5 = exp(-dist5 * dist5 / (14.0 * uDanceScale * uDanceScale));
  // 基准幅度:SILK 用的是 ~0.4,这里按取景比放大再 ×1.5
  float A = uDanceAmt * uDanceScale * 1.5;
  vec3 o5 = vec3(0.0);

  if (m5 < 0.5) {
// 0 行云
float ph = dot(pos.xy, uDanceDir) * (0.80 / uDanceScale) - t5 * 1.15;
o5.z = sin(ph) * 0.44;
o5.xy = uDanceDir * cos(ph) * 0.32;      // 这层看 z 不明显,横向给足
  } else if (m5 < 1.5) {
// 1 回旋
float a = 0.42 * reach5 * sin(t5 * 0.85);
float c = cos(a), s = sin(a);
o5.xy = (mat2(c, -s, s, c) * d5 - d5) / uDanceScale;   // 旋转本身已经带尺度
o5.z = reach5 * sin(t5 * 1.25 + dist5 * (0.4 / uDanceScale)) * 0.30;
  } else if (m5 < 2.5) {
// 2 呼吸
float b = sin(t5 * 1.05) * reach5;
o5.xy = d5 / max(dist5, 0.001) * b * 0.36;
o5.z = b * 0.38;
  } else if (m5 < 3.5) {
// 3 摇曳
float sway = sin(t5 * 0.95 + pos.y * (0.50 / uDanceScale) + aRand * 1.3);
o5.x = sway * (0.11 + abs(pos.y / uDanceScale) * 0.070);
o5.z = sway * 0.20 * (0.35 + reach5);
  } else if (m5 < 4.5) {
// 4 星落 —— 这层本来就是一颗颗独立的星尘,这段最贴它
float ph = t5 * 1.45 + aRand * 6.2831;
o5.z = sin(ph) * 0.32 * (0.40 + reach5);
o5.xy = vec2(cos(ph * 0.7), sin(ph * 0.5)) * 0.16;
  } else if (m5 < 5.5) {
// 5 涟纹
float ph = dot(pos.xy, uDanceDir) * (1.75 / uDanceScale) + sin(t5 * 0.55) * 1.5;
o5.z = sin(ph) * cos(dist5 * (0.45 / uDanceScale) - t5 * 0.75) * 0.38;
o5.xy = uDanceDir * sin(ph) * 0.22;
  } else if (m5 < 6.5) {
// 6 星涡
float a = 0.52 * reach5 * sin(t5 * 0.62) + dist5 * (0.15 / uDanceScale) * sin(t5 * 0.30);
float c = cos(a), s = sin(a);
o5.xy = (mat2(c, -s, s, c) * d5 - d5) / uDanceScale;   // 旋转本身已经带尺度
o5.z = sin(dist5 * (0.90 / uDanceScale) - t5 * 1.10) * 0.30 * (0.35 + reach5);
  } else if (m5 < 7.5) {
// 7 潮汐
float ph = pos.y * (0.42 / uDanceScale) + t5 * 0.42;
o5.z = sin(ph) * 0.30 + sin(pos.x * (0.26 / uDanceScale) - t5 * 0.31) * 0.22;
o5.xy = vec2(sin(t5 * 0.36 + pos.y * (0.22 / uDanceScale)) * 0.30, cos(t5 * 0.28) * 0.18);
  } else if (m5 < 8.5) {
// 8 心跳
float bt = fract(t5 * 0.46);
float env = exp(-bt * 3.2) + 0.62 * exp(-fract(bt + 0.72) * 3.6);
float ring = sin(dist5 * (2.4 / uDanceScale) - t5 * 3.0);
o5.z = ring * env * 0.46 * (0.30 + reach5);
o5.xy = d5 / max(dist5, 0.001) * ring * env * (0.10 / uDanceScale);
  } else {
// 9 落雪
float f = fract(t5 * 0.16 + aRand);
float w = sin(f * 3.14159265);
o5.y = (0.5 - f) * 0.40 * w;
o5.x = sin(t5 * 0.70 + aRand * 6.2831) * 0.26 * w;
o5.z = sin(t5 * 0.50 + aRand * 12.0) * 0.22 * (0.35 + reach5);
  }

  pos.xy += o5.xy * A;
  pos.z  += o5.z * A;
  // 动起来的时候稍微亮一点,让这团粒子在字出现时"活"过来
  vAlpha *= 1.0 + uDanceAmt * 0.18;
}
  }

  // ====================================================
  //  鼠标交互 (仅 SILK)
  // ====================================================
  if (uMouseActive > 0.5 && uPreset < 0.5) {
float mdx = pos.x - uMouseXY.x;
float mdy = pos.y - uMouseXY.y;
float md = sqrt(mdx*mdx + mdy*mdy);
if (md < 1.0) {
  float push = (1.0 - md) * (1.0 - md);
  pos.z += push * 0.55;
}
  }

  // ====================================================
  //  v8 手势遮挡 — uHandActive 是 0..1 平滑过渡, 大半径推开
  // ====================================================
  if (uHandActive > 0.01) {
float hdx = pos.x - uHandXY.x;
float hdy = pos.y - uHandXY.y;
float hd = sqrt(hdx*hdx + hdy*hdy);
float rad = 1.55;
if (hd < rad) {
  float push = (rad - hd) / rad;
  push = push * push * uHandActive;
  pos.z += push * 1.10;
  vec2 outDir = vec2(hdx, hdy) / max(0.001, hd);
  pos.xy += outDir * push * 0.28;
}
  }
  if (uGestureGrip > 0.001) {
float grip = clamp(uGestureGrip, 0.0, 1.0);
float gripWave = 0.5 + 0.5 * sin(uTime * 2.2 + aRand * 6.2831);
pos.xy *= mix(1.0, 0.66 + gripWave * 0.035, grip);
pos.z += grip * (0.18 + uBass * 0.22 + gripWave * 0.10);
  }

  // ====================================================
  //  通用: 离散感 / 扭曲
  // ====================================================
  if (uScatter > 0.001) {
vec2 jdir = vec2(cos(aRand * 6.2831), sin(aRand * 6.2831));
pos.xy += jdir * uScatter * (0.05 + uTreble * 0.10);
  }
  if (uTwist > 0.001 && uPreset < 0.5) {
float ta = uTwist * pos.z * 0.6;
float cs = cos(ta), sn = sin(ta);
pos.xy = mat2(cs, -sn, sn, cs) * pos.xy;
  }

  // 颜色
  float vinylHiResGuard = smoothstep(1.08, 1.55, uCoverRes) * step(3.5, uPreset) * (1.0 - step(4.5, uPreset));
  float edgeBoost = uEdgeEnabled * edgeVal * mix(1.0, 0.42, vinylHiResGuard);
  vSourceLum = dot(max(vColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));
  float blackParticleGuard = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  vEdgeBoost = edgeBoost * (uPreset > 3.5 ? 0.22 : 1.0) * (1.0 - blackParticleGuard);
  vColor = pow(max(vColor, vec3(0.0)), vec3(1.0 / max(0.35, uColorBoost)));
  float edgeColorMix = edgeBoost * (uPreset > 3.5 ? 0.20 : 0.50) * (1.0 - blackParticleGuard);
  vColor = mix(vColor, vColor + vec3(0.20), edgeColorMix);
  float tintLum = max(max(vColor.r, vColor.g), vColor.b);
  vec3 tintedColor = uTintColor * max(0.24, tintLum * 1.12);
  vColor = mix(vColor, tintedColor, clamp(uTintStrength, 0.0, 1.0) * (1.0 - blackParticleGuard));

  vBright = 0.82 + maxRippleAmp * 0.55 + uBass * 0.10 + edgeBoost * 0.30 + uEnergy * 0.05 + uBurstAmt * 0.40;
  if (uPreset > 4.5) {
vBright = 0.94 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025;
  } else if (uPreset > 3.5) {
vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08 + edgeBoost * 0.12 + uEnergy * 0.05 + uBeat * 0.16 + uBurstAmt * 0.16;
  }
  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);

  if (uHasDepth > 0.5 && uPreset < 0.5) {
float bgMul = mix(1.0, 0.55, uBgFade * (1.0 - fgMask));
vBright *= bgMul;
  }
  vBright += uGestureGrip * 0.22;
  float loadingMistSize = 1.0;

  // 加载形态: 雾状微尘流，避免廉价旋转圆环
  if (uLoading > 0.001) {
float mistSeed = hash11(aRand * 931.7);
float mistLayer = floor(mistSeed * 4.0);
float layerN = (mistLayer + 0.5) / 4.0;
float mistAngle = aRand * 6.2831 + uTime * (0.16 + mistSeed * 0.18) + snoise(vec3(aRand * 2.1, uTime * 0.24, 2.0)) * 1.85;
float mistR = mix(1.35, 3.15, sqrt(hash11(aRand * 127.3))) * (1.0 + sin(uTime * 0.42 + aRand * 7.0) * 0.13);
vec2 mistCurl = vec2(
  snoise(vec3(aRand * 4.1, uTime * 0.32, 3.0)),
  snoise(vec3(aRand * 4.7, uTime * 0.30, 8.0))
);
float mistBreath = 0.5 + 0.5 * sin(uTime * (0.82 + mistSeed * 0.55) + aRand * 17.0);
float mistRibbon = sin(mistAngle * (1.35 + layerN * 0.55) + uTime * 0.34 + mistSeed * 4.0);
float glowPick = smoothstep(0.88, 0.997, hash11(aRand * 1501.0 + mistLayer * 17.0));
float dustPick = 0.34 + glowPick * 0.66;
vec3 mistPos = vec3(
  cos(mistAngle) * mistR * (1.24 + mistCurl.x * 0.16) + mistCurl.x * 0.72,
  sin(mistAngle * 0.82 + mistRibbon * 0.25) * mistR * (0.56 + layerN * 0.10) + mistCurl.y * 0.62,
  (layerN - 0.5) * 4.85 + mistCurl.x * 0.56 + mistBreath * 0.36 + mistRibbon * 0.24
);
vec3 mistCol = mix(vec3(0.62, 0.86, 0.84), vec3(0.36, 0.46, 0.78), mistSeed);
mistCol = mix(mistCol, vec3(0.94, 1.0, 0.97), glowPick * (0.45 + mistBreath * 0.35));
vColor = mix(vColor, mistCol, uLoading * 0.78);
vBright = mix(vBright, 0.20 + mistBreath * 0.18 + abs(mistCurl.x) * 0.06 + glowPick * (0.72 + abs(mistRibbon) * 0.24), uLoading);
vAlpha = mix(vAlpha, 0.08 + mistBreath * 0.11 + dustPick * 0.11 + glowPick * 0.30, uLoading);
pos = mix(pos, mistPos, uLoading);
loadingMistSize = 1.26 + mistBreath * 0.24 + abs(mistRibbon) * 0.14 + glowPick * 0.78;
  }

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.5, -mvPos.z);
  float audioBoost = 1.0 + maxRippleAmp * 0.7 + edgeBoost * 0.55 + uBeat * 0.30 + uBurstAmt * 0.5;
  float sz = clamp(depthSize * audioBoost, 1.05, 4.95);
  if (uPreset > 4.5) {
float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060 + uBurstAmt * 0.090 + uBeat * 0.055;
sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
  } else if (uPreset > 3.5) {
float ringDrive = uBass * 0.30 + uMid * 0.18 + uTreble * 0.22 + uBeat * 0.30;
sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
  }
  // 加载态下粒子稍大
  sz = mix(sz, sz * loadingMistSize, uLoading);
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

export const MR_FS = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uPreset, uParticleDim;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = vColor * vBright;
  col = mix(col, col * 1.3 + vec3(0.05), vEdgeBoost * 0.35);
  col = mix(col, col * 1.2, vRipple * 0.4);
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float nonBlack = 1.0 - keepBlack;
  float dotDist = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float readableRim = smoothstep(0.44, 0.94, dotDist) * (1.0 - smoothstep(0.94, 1.08, dotDist)) * tex.a;
  float outLum = dot(col, vec3(0.299, 0.587, 0.114));
  float lightParticle = smoothstep(0.50, 0.82, outLum) * nonBlack;
  float darkParticle = (1.0 - smoothstep(0.20, 0.50, outLum)) * nonBlack;
  col = mix(col, vec3(0.0), readableRim * lightParticle * 0.38);
  col = mix(col, vec3(1.0), readableRim * darkParticle * 0.20);
  col = clamp(col, vec3(0.0), vec3(1.6));
  gl_FragColor = vec4(col, tex.a * uAlpha * uParticleDim * vAlpha);
}
`;

export const MR_BLOOM_FS = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uBloomStrength, uPreset, uParticleDim;
varying vec3 vColor;
varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;

void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.01) discard;
  float soft = tex.a * tex.a;
  vec3 col = vColor * (0.55 + vBright * 0.62);
  col = mix(col, col + vec3(0.22, 0.18, 0.10), vEdgeBoost * 0.35);
  col = clamp(col, vec3(0.0), vec3(1.8));
  float pulse = 1.0 + vRipple * 0.65;
  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);
  float bloomKeep = 1.0 - keepBlack * 0.92;
  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * uParticleDim * pulse * 0.55 * vAlpha * bloomKeep);
}
`;

/** 原项目 00-pointer-cover-particles.js:881-883 的两处 replace,逐字照搬 */
export const MR_BLOOM_VS = MR_VS
  .replace('uniform float uMouseActive, uPixel, uColorMixT, uLoading;', 'uniform float uMouseActive, uPixel, uColorMixT, uLoading, uBloomSize;')
  .replace('gl_PointSize = sz * uPixel * uPointScale;', 'gl_PointSize = sz * uPixel * uPointScale * uBloomSize;');
