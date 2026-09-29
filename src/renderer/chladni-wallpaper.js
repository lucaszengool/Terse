/**
 * chladni-wallpaper.js — 壁纸引擎「声之形」。
 *
 * 和另外两个引擎(mineradio-wallpaper.js / token-wallpaper-3d.js)并列:
 * wallpaper.html 按配置里的 `engine` 三选一 new 出来,API 一致。
 *
 * 画的是一块**斜着看的方板**在振动,板上的粉末被颠到驻波的节线上,自己走成
 * 一张迷宫;每隔几拍,整盘粉聚成一行 agent 日志,再散回迷宫。
 *
 * 这一版的每一个常数都是**对着一段参考视频逐帧量出来的**,不是调出来的。
 * 底下几条是踩过坑才定下来的,改之前先读:
 *
 *   · 场必须是**实数**驻波的叠加。取复数的模 |W| 的话,零点集要同时满足
 *     实部=0 和虚部=0 两个条件 —— 在平面上交出来是**孤立的点**,不存在连续
 *     节线,脊会永远断成一段段的弧。实数场只有一个条件,交出来是连续曲线。
 *   · 快的运动必须来自**场本身改形**(模态系数自转),不能靠整片位移。
 *     位移是保形的,只会让画面像一个东西在膨胀收缩。
 *     (量过参考:它的帧间最佳平移量恒等于零 —— 是原地重组。)
 *   · 荡漾层(Gerstner)只能加在**顶点着色器里、不写回粒子状态**。
 *     写回去的话它会和结构的运动抢同一份状态,幅度一大就把脊磨平。
 *   · 节奏:参考音轨的 onset 间隔中位数 0.71s(≈84 BPM);
 *     帧间结构相关度(对齐后)0.912 —— 这个数是调变化快慢的标尺。
 *
 * 原型和全部推导过程:https://claude.ai/artifact/QNsPFSnm8AVm2fUmLjj1zy
 */
/* 声之形 · WebGL2 版
 *
 * 2D canvas 那一版卡在三十四万颗粉、二十帧 —— 脊里一格只摊得到一两颗,
 * 所以边永远是毛的、堆里永远有洞。这一版把整套搬到 GPU:
 *
 *   · 粒子状态放在两张 RGBA32F 纹理里(位置/高度/竖直速度 + 平面速度),
 *     一次 ping-pong 就是一帧的模拟。一百万颗粉,六十帧。
 *   · 场还是 CPU 算(一百个模态的受迫响应,可分离,两三毫秒),
 *     每帧传一张 192² 的 RGBA32F 上去:amp + 归一化梯度。
 *   · 板面的堆积密度用一次加法混合的点渲染得到(GPU 自己数自己)。
 *   · 出图三趟:点 → 全分辨率密度;降采样模糊 → 法线;合成 → 光。
 *
 * 一百万颗粉之后,脊里一格有十几二十颗 —— 边是硬的,堆是实的,
 * 这两件事不是调出来的,是数量堆出来的。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);

let _s = 2463534242 >>> 0;
const rnd01 = () => {
  _s ^= _s << 13; _s >>>= 0; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0;
  return _s / 4294967296;
};

/* ── 相机:斜着看一块方板(俯角和距离都是从参考帧量出来的) ── */
const THETA = 34 * Math.PI / 180;
const CAMD = 5.1;
const ST = Math.sin(THETA), CT = Math.cos(THETA);

/* ── 着色器 ────────────────────────────────────────────────────────── */

const VS_QUAD = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* 一步模拟。每帧在这里走 SUB 小步 —— 真板上粉一秒弹几百次,
   一大步跳得比脊还宽就永远捕不住。 */
const FS_SIM = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uA;        // x, y, z, vz
uniform sampler2D uB;        // vx, vy, -, -
uniform sampler2D uField;    // amp, gx, gy —— 驻波
uniform sampler2D uText;     // amp, gx, gy —— 那一行字
uniform sampler2D uDens;     // r = 板面堆积密度 / uDensMax
uniform float uMorphDur;     // 每颗粉用多长的一段窗口去迁移
uniform float uACrit, uStep, uFloor, uGlide, uPile, uSpread;
uniform float uBigP, uGrav, uDt, uShimmer, uDensMax, uW, uWShare;
uniform float uFlow, uFlowT;   // 沿脊流动的幅度 / 行波相位
uniform uint uFrame;
uniform int uSub;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

uint rs;
uint uhash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(){ rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return float(rs) * 2.3283064365e-10; }

/* 每颗粉自己的出发时刻:用一条**空间相干**的低频噪声定 —— 相邻的粉拿到
   相近的延迟,于是字是一团一团地聚起来的,不是全盘同时收拢。
   窗口只占整段的三成(uMorphDur),所以任何一瞬间都只有三分之一的粉在飞,
   其余的要么还是水波、要么已经是字 —— 这就是"过渡看不出接缝"的做法。
   用同一条噪声,聚和散的先后顺序互为逆序,来回就对称。 */
float stagger(vec2 p, float w){
  float coh = 0.5 + 0.5 * sin(p.x * 2.7 + 1.3) * cos(p.y * 2.1 - 0.7);
  float delay = (1.0 - uMorphDur) * coh;
  return smoothstep(delay, delay + uMorphDur, w);
}
vec3 fieldAt(vec2 p){
  vec3 fw = texture(uField, p * 0.5 + 0.5).rgb;
  if (uW <= 0.002) return fw;
  vec3 ft = texture(uText, p * 0.5 + 0.5).rgb;
  return mix(fw, ft, stagger(p, uW));
}
float densAt(vec2 p){ return texture(uDens, p * 0.5 + 0.5).r * uDensMax; }

void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uA, ip, 0);
  vec4 b = texelFetch(uB, ip, 0);
  float x = a.x, y = a.y, z = a.z, vz = a.w;
  float vx = b.x, vy = b.y;

  uint pid = uint(ip.x) | (uint(ip.y) << 12);
  rs = uhash(pid ^ (uFrame * 0x9e3779b9u));
  if (rs == 0u) rs = 1u;
  /* 每颗粉自己的\"躺下\"门槛差一点:脊的边缘才是毛的,不是一条数学等高线。 */
  float bias = 0.68 + 0.72 * float(uhash(pid * 2654435761u) & 0xffffu) / 65535.0;
  float ac = uACrit * bias;

  /* 字相里只有一部分粉去写字,其余的原地不动(画面上由渲染端淡出)。 */
  bool writer = float(uhash(pid * 2246822519u) & 0xffffu) / 65535.0 < uWShare;
  if (uW > 0.02 && !writer) { oA = a; oB = b; return; }

  if (z > 0.0) {
    vz -= uGrav * uDt;
    x += vx * uDt; y += vy * uDt; z += vz * uDt;
    if (z <= 0.0) { z = 0.0; vz = 0.0; vx *= 0.30; vy *= 0.30; }
  } else {
    for (int s = 0; s < uSub; s++) {
      vec3 f = fieldAt(vec2(x, y));
      float q0 = f.r - ac;
      if (q0 <= 0.0) {
        /* 落进节线那条带子了。堆得下就停住,只留一点点抖 —— 参考里脊面
           是一直在沸的,完全冻住会像一张贴图。堆满了就往旁边摊,
           摊出来的宽度就是脊宽。 */
        if (densAt(vec2(x, y)) < uPile * (0.80 + 0.40 * float(uhash(pid * 40503u) & 0xffffu) / 65535.0)) {
          /* 趴在脊上的粉不能是死的。给两样:
             ① 一点点各向同性的抖(脊面在沸);
             ② **沿着脊流动** —— 方向取梯度的垂线(也就是脊的走向),
                快慢由一列行波给,所以整条脊上的粉是一波一波往前淌的。
             切向的流不会把粉带离脊,所以画面一直在荡,而脊还是那条脊。 */
          vec2 tang = vec2(-f.b, f.g);
          float ph = (x * 2.3 + y * 1.7) - uFlowT;
          x += tang.x * uFlow * sin(ph);
          y += tang.y * uFlow * sin(ph);
          float th = rnd() * 6.2831853;
          x += cos(th) * uShimmer; y += sin(th) * uShimmer;
          break;
        }
        float th = rnd() * 6.2831853;
        x += cos(th) * uSpread; y += sin(th) * uSpread;
        continue;
      }
      float th = rnd() * 6.2831853;
      vec2 d = vec2(cos(th), sin(th));
      float len = uStep * (uFloor + q0);
      if (rnd() < uBigP * q0) {
        /* 被甩狠了的那一颗:走真的弹道 —— 参考里看得见的飞屑就是它。
           Grabec:水平位移 ≈ 弹跳高度的四分之一,按这条反推竖直初速。 */
        float dd = len * (2.0 + rnd() * 3.4);
        /* 越靠板沿,踢的方向越偏向"朝外",力也越大 —— 自由边本来就是
           把粉往外甩的那一条边。 */
        float rim = smoothstep(0.93, 1.03, max(abs(x), abs(y)));
        d = normalize(mix(d, normalize(vec2(x, y) + 1e-5), rim * 0.70));
        dd *= 1.0 + rim * 1.6;
        float v0 = sqrt(8.0 * uGrav * dd);
        float T = 2.0 * v0 / uGrav;
        vz = v0; vx = d.x * dd / T; vy = d.y * dd / T;
        z = 1e-5;
        break;
      }
      /* 漂移改成**恒定速度**。原来写成\"步长 × 梯度 × 漂移系数\",算下来一帧
         能走一个半板宽 —— 粉是瞬移到位的,所以聚字、散字、换图全都看不见
         过程,只看见结果在跳。\"不丝滑\"和\"粒子没动\"是同一个根。
         现在每小步只滑 uGlide,六小步一帧 ⇒ 横穿全板要一秒多,
         每一次汇聚和散开都是**看得见的一段流**。 */
      x -= f.g * uGlide;
      y -= f.b * uGlide;
      float step2 = len * (0.4 + rnd() * 1.2);
      x += d.x * step2;
      y += d.y * step2;
    }
  }

  /* 甩出板子的粉掉下去了,补一颗回来 —— 补在板面上随机一处,
     它会在几帧之内被漂移带回脊上。 */
  /* 飞出板子的粉:让它**飞得出去**(边界放到 1.5),在板外划完那一道弧、
     落地之后才消失,再从板内补一颗回来。之前边界卡在 1.06,粉刚出板沿就被
     收走了,所以外圈一片干净 —— 参考的板外是挂着一圈喷雾的。 */
  float ee = max(abs(x), abs(y));
  if (ee > 1.5 || (z <= 0.0 && ee > 1.04)) {
    /* 补回来的位置不能是**板面上随便一点**。均匀撒的话,这颗粉会落在某个
       黑格子的正中间,然后一路滑到最近的脊上 —— 一堆这样的粉横穿黑格子,
       画面就一直在闪(帧间翻转率从 6.9% 冲到 11.9%,参考只有 7.7%)。
       改成**抄另一颗粉的位置**:补在已经有粉的地方,它一出现就在脊上。 */
    ivec2 rp = ivec2(int(rnd() * float(textureSize(uA, 0).x)),
                     int(rnd() * float(textureSize(uA, 0).y)));
    vec2 src = texelFetch(uA, rp, 0).xy;
    x = src.x + (rnd() - 0.5) * 0.02;
    y = src.y + (rnd() - 0.5) * 0.02;
    z = 0.0; vx = 0.0; vy = 0.0; vz = 0.0;
  }
  oA = vec4(x, y, z, vz);
  oB = vec4(vx, vy, 0.0, 0.0);
}`;


/* 点渲染:一颗粉一个点。加法混合,所以每个像素上落了几颗粉就是几。 */
const VS_POINTS = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform int uTexW;
uniform vec2 uViewport;
uniform float uF, uCx, uCy;
uniform float uPointSize;
uniform float uPointSizeAir;   // 飞屑画得比躺着的粉小一半
uniform float uW, uWShare;
uniform int uPlateSpace;      // 1 = 画到板面坐标(算堆积密度用)
uniform vec2 uDrive;          // 驱动点(板面坐标)
uniform float uFront;         // 这一帧涟漪波前的半径
uniform float uTime;
uniform float uAlive;         // 荡漾的幅度
uniform float uMorphDur;
out float vAir;
out float vFade;
out float vTint;
out float vCaustic;

/* ── 荡漾层:只在**显示**的时候加,不写回状态 ───────────────────────────
   这是整件事的关键。之前把"活"的运动写进模拟里,它和"结构"的运动抢同一份
   状态 —— 幅度一大,脊就被磨平,所以我一路把它调到几乎看不见,画面于是是死的。
   拆开之后:模拟只管慢的那一半(落位、聚字、散开),荡漾每帧在这里现算、
   算完就扔,因此可以又大又快,而且**一颗粉都不会被带离节线**。

   用 Gerstner(余摆线)波:水平那一项是 cos,它让每颗粉走的是**椭圆**,
   不是来回直线 —— 轨道运动才是"水"的全部辨识度。方向取三个不平行的,
   否则在俯视的平面上退化成单轴来回,看着像剪切不像水。
   硬约束:陡度之和 ≤ 1,否则水面自交。 */
vec2 gerstner(vec2 p, out float jac) {
  vec2 disp = vec2(0.0);
  jac = 1.0;
  vec2 dir[3];  float lam[3];  float Q[3];  float spd[3];
  dir[0] = normalize(vec2( 1.00,  0.22));  lam[0] = 0.95;  Q[0] = 0.42;  spd[0] = 2.30;
  dir[1] = normalize(vec2( 0.28,  1.00));  lam[1] = 0.58;  Q[1] = 0.26;  spd[1] = 3.10;
  dir[2] = normalize(vec2( 0.80, -0.62));  lam[2] = 1.45;  Q[2] = 0.30;  spd[2] = 1.65;
  for (int i = 0; i < 3; i++) {
    float k = 6.2831853 / lam[i];
    float f = k * dot(dir[i], p) - spd[i] * uTime;
    disp += dir[i] * (Q[i] / k * cos(f));
    /* 面积的雅可比。波把粉挤到一起的地方要更亮 —— 这就是水面上那层
       会跟着波走的亮纹(焦散)。加法混合本来就在做光子累积,顺手就有了。 */
    jac *= (1.0 - Q[i] * sin(f));
  }
  return disp;
}
uint uhash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
void main(){
  int id = gl_VertexID;
  ivec2 p = ivec2(id % uTexW, id / uTexW);
  vec4 s = texelFetch(uA, p, 0);
  uint pid = uint(p.x) | (uint(p.y) << 12);
  bool writer = float(uhash(pid * 2246822519u) & 0xffffu) / 65535.0 < uWShare;
  /* 不写字的那些粉也要**一团一团地**淡出,用和迁移同一条相干噪声定先后 ——
     整盘一起淡就是一道横切,看得见接缝。 */
  float coh = 0.5 + 0.5 * sin(s.x * 2.7 + 1.3) * cos(s.y * 2.1 - 0.7);
  float wi = smoothstep((1.0 - uMorphDur) * coh, (1.0 - uMorphDur) * coh + uMorphDur, uW);
  vFade = writer ? 1.0 : (1.0 - wi * 0.92);
  vAir = s.z > 0.0008 ? 1.0 : 0.0;
  /* 离涟漪波前有多近 —— 合成时用它把这一圈染上这一拍的颜色。
     颜色不是整屏调色,是**跟着那一圈波走**的,所以每一次波动都有自己的色。 */
  float dr = length(s.xy - uDrive) - uFront;
  vTint = exp(-dr * dr * 3.2);
  if (uPlateSpace == 1) {
    /* 算堆积密度用的那一趟不要加荡漾 —— 堆积是结构,荡漾只是显示。 */
    gl_Position = vec4(s.x, s.y, 0.0, 1.0);
    gl_PointSize = 1.0;
    vCaustic = 1.0;
    return;
  }
  float jac;
  vec2 q = s.xy + gerstner(s.xy, jac) * uAlive;
  vCaustic = clamp(1.0 / max(jac, 0.25), 0.55, 2.10);
  float sc = uF / (q.y * ${CT.toFixed(8)} - s.z * ${ST.toFixed(8)} + ${CAMD.toFixed(4)});
  float sx = uCx + q.x * sc;
  float sy = uCy - (q.y * ${ST.toFixed(8)} + s.z * ${CT.toFixed(8)}) * sc;
  gl_Position = vec4(sx / uViewport.x * 2.0 - 1.0, 1.0 - sy / uViewport.y * 2.0, 0.0, 1.0);
  /* 参考放大了看:脊上**密密麻麻站着一粒一粒**的白点,比脊本身还亮 ——
     那是正在跳的粉。画成和躺着的粉一样大的话,它们互相糊成一团,脊就成了
     一块光滑的实心色块,这正是我和参考最大的一处观感差。
     画小一半再提亮,它们才是"一粒一粒"。 */
  gl_PointSize = vAir > 0.5 ? uPointSizeAir : uPointSize;
}`;

const FS_POINTS = `#version 300 es
precision highp float;
in float vAir;
in float vFade;
in float vTint;
in float vCaustic;
uniform float uUnit;
out vec4 o;
void main(){
  if (vFade < 0.02) discard;
  // 焦散:波挤到一起的地方更亮,而且这层亮纹是**跟着波走**的
  float c = uUnit * vFade * vCaustic;
  o = vAir > 0.5 ? vec4(0.0, c, c * vTint, 0.0) : vec4(c, 0.0, c * vTint, 0.0);
}`;

/* 降采样 + 模糊:只给法线用。光要柔,颗粒不能柔。 */
const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  float a = 0.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++)
      a += texture(uSrc, uv + vec2(float(i), float(j)) * uTexel).r;
  o = vec4(a / 25.0, 0.0, 0.0, 1.0);
}`;

/* 合成。参考的直方图峰在 186 灰 —— 哑光的奶白粉,不是发光的点。
   边界不做渐变:有粉就是粉,没粉就是黑。 */
const FS_COMP = `#version 300 es
precision highp float;
uniform sampler2D uDens;     // 全分辨率:r = 躺着的, g = 飞着的
uniform sampler2D uBlur;     // 半分辨率、模糊过的,只拿来算法线
uniform vec2 uTexelFull, uTexelHalf;
uniform float uUnitInv;      // 一个单位 = 几颗粉
uniform vec3 uCream;         // 粉本来的奶白
uniform vec3 uAccent;        // 这一拍涟漪的颜色
uniform float uBloom, uGain;
uniform float uTintBase;   // 整片粉的底色染多深(字相里会拉高)
out vec4 o;
void main(){
  vec2 uvF = gl_FragCoord.xy * uTexelFull;
  vec2 uvH = gl_FragCoord.xy * uTexelFull;   // 同一归一化坐标
  vec4 s = texture(uDens, uvF);
  float d = s.r * uUnitInv;
  float fly = s.g * uUnitInv;
  float bloom = texture(uBlur, uvF).r * uUnitInv;
  /* 空处 = **全零**,alpha 也是零。写 alpha=1 的话(原来就是)整张画布是不透明的
     黑板 —— 板外那一圈会把身后的壁纸粒子层整个盖掉,粉末看着像浮在黑底上,
     而这一层的意义正是"粉末浮在你自己的壁纸前面"。 */
  if (d < 0.02 && fly < 0.02 && bloom < 0.05) { o = vec4(0.0); return; }
  /* 这一格的粉里有多少是"正在被波前扫过"的 —— 拿它在奶白和这一拍的
     颜色之间插值。低饱和、只染一圈,所以是有颜色而不是彩色。 */
  float tint = clamp(s.b / max(s.r + s.g, 1e-4), 0.0, 1.0);

  float v = 0.0;
  if (d >= 0.02) {
    float l = texture(uBlur, uvH - vec2(uTexelHalf.x, 0.0)).r * uUnitInv;
    float r = texture(uBlur, uvH + vec2(uTexelHalf.x, 0.0)).r * uUnitInv;
    float b = texture(uBlur, uvH - vec2(0.0, uTexelHalf.y)).r * uUnitInv;
    float t = texture(uBlur, uvH + vec2(0.0, uTexelHalf.y)).r * uUnitInv;
    // 厚度饱和之后再求梯度 —— 不然厚的地方法线全被拉平
    float sl = 1.0 - exp(-l * 0.16), sr = 1.0 - exp(-r * 0.16);
    float sb = 1.0 - exp(-b * 0.16), st = 1.0 - exp(-t * 0.16);
    vec3 n = normalize(vec3((sl - sr) * 3.0, (st - sb) * 3.0, 1.0));
    float dif = max(dot(n, normalize(vec3(-0.46, 0.62, 0.64))), 0.0);
    /* 覆盖度爬得快(两三颗就满),所以白到黑只有一两个像素 —— 硬边。
       堆的厚度另算,厚的地方才亮得起来,薄处留下暗缝。 */
    float cov = min(d * 0.42, 1.0);          // 单颗粉就看得见,但别亮到糊成一层灰
    float pile = min(d * 0.026, 1.0);
    float lam = min(0.44 + 0.60 * dif, 1.0);
    v = cov * (0.58 + 0.42 * pile) * lam;
    float g = pow(dif, 14.0);
    v += g * 0.30 * pile;                     // 脊顶偶尔的一点锐白
  }
  v += fly * 0.72;
  v *= uGain;
  /* 辉光:模糊那一张本来就在,顺手加一点点 —— 高光周围有一层很淡的晕,
     整体会"贵"一档。 */
  float gl2 = min(bloom * 0.09, 1.0) * uBloom;
  vec3 col = mix(uCream, uAccent, clamp(uTintBase + 0.62 * tint, 0.0, 1.0));
  vec3 rgb = col * min(v, 1.0) + mix(uCream, uAccent, 0.6) * gl2;
  /* alpha = 这一点有多少粉。没粉 ⇒ 透明 ⇒ 底下那层(壁纸粒子)露出来。
     预乘 alpha + 加法混合,所以 rgb 已经是"乘过"的,直接给就对。 */
  o = vec4(rgb, clamp(max(max(rgb.r, rgb.g), rgb.b), 0.0, 1.0));
}`;

/* ── 引擎 ──────────────────────────────────────────────────────────── */

export class ChladniPlate {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, antialias: false, depth: false, premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserve,
    });
    if (!gl) throw new Error('need WebGL2');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('need EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    this.c = canvas;
    /* 按设备像素渲染:2x 屏上画布固定 1280 宽的话,最后会被浏览器拉大一倍,
       再怎么调渲染也是软的 —— 糊在最后那一步插值上。 */
    this.DPR = Math.min(opts.dpr || (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1), 2);
    this.W = Math.round(opts.w || canvas.clientWidth) || 1280;
    this.H = Math.round(opts.h || canvas.clientHeight) || 720;
    this.W = Math.round(this.W * this.DPR); this.H = Math.round(this.H * this.DPR);
    canvas.width = this.W; canvas.height = this.H;

    /* 一百万颗粉 = 1024×1024 的状态纹理。 */
    this.TW = opts.texw || 1024;
    this.TH = opts.texh || 1024;
    this.N = this.TW * this.TH;

    this.F = Math.min(0.42 * this.W * (CAMD - CT),
                      0.74 * this.H * (CAMD * CAMD - CT * CT) / (ST * 2 * CAMD));
    this.cx = this.W / 2; this.cy = this.H / 2;

    /* 一颗粉在加法缓冲里加多少。1/40 ⇒ 四十颗一格就饱和,
       低端还分得出一颗两颗(1/40 ≈ 6/255)。 */
    this.UNIT = 1 / 40;

    this.initField(opts);
    this.initGLObjects(opts);
    this.initParticles();

    this.t = 0; this.ft = 0; this.env = 1; this.w = 0; this.ck = -1; this.kick = 0; this.front = 0; this.dx0 = 0; this.dy0 = 0; this.phase = 'wave'; this.frame = 0;
    this.BEAT = opts.beat || 0.695;   // 音轨 onset 中位数 0.71 / 画面自相关 0.67
    this.CYCLE = opts.cycle || (this.BEAT * 6);   // 六拍一轮 —— 字跟着拍子来
    this.PH = { gather: 0.50, hold: 0.66, release: 0.90 };  // 波3拍/聚1拍/停1.5拍/散0.5拍
    this.WSHARE = opts.share || 0.52;
    /* 每一次波动的颜色。低饱和 —— 要的是"有颜色",不是彩色。
       冰蓝 / 琥珀 / 淡紫 / 薄荷,四个轮着来,一拍一个。 */
    this.PALETTE = opts.palette || [
      [0.38, 0.72, 1.00],   // 冰蓝
      [1.00, 0.62, 0.26],   // 琥珀
      [0.66, 0.44, 1.00],   // 紫
      [0.30, 1.00, 0.74],   // 薄荷
      [1.00, 0.42, 0.62],   // 玫红
    ];
    this.GAIN = opts.gain || 1.06;      // 提亮主要靠底色和单颗粉的起亮,不靠这里
    this.BLOOM = opts.bloom || 0.55;
    this.lines = opts.lines || ['+2,148 tok', 'cache 61%', '41 passed', 'build ok'];
    this.li = 0;
    this.buildText(this.lines[0]);
    this.field();
    this.seed();
  }

  /* ── CPU 侧:场 ─────────────────────────────────────────────────── */
  initField(opts) {
    const G = this.FG = opts.grid || 192, G2 = G * G;
    this.amp = new Float32Array(G2);
    this.fbuf = new Float32Array(G2);
    this.fbufQ = new Float32Array(G2);
    this.fieldTex = new Float32Array(G2 * 4);
    this.ampA = new Float32Array(G2);
    this.ampB = new Float32Array(G2);
    this.gr = new Float32Array(G2);
    this.gth = new Float32Array(G2);
    this.gtap = new Float32Array(G2);
    this.gedge = new Float32Array(G2);
    for (let j = 0; j < G; j++) {
      const v = (j / (G - 1)) * 2 - 1;
      for (let i = 0; i < G; i++) {
        const u = (i / (G - 1)) * 2 - 1, k = j * G + i;
        const rr = Math.hypot(u, v);
        this.gr[k] = Math.PI * rr;
        this.gth[k] = Math.atan2(v, u);
        this.gtap[k] = Math.min(1, rr / 0.22) / Math.sqrt(0.30 + rr) * 0.70;
        const au = Math.abs(u), av = Math.abs(v);
        const e = Math.pow(au ** 4 + av ** 4, 0.25);
        this.gedge[k] = e > 0.90 ? smooth(Math.min(1, (e - 0.90) / 0.15)) : 0;
      }
    }
    this.NM = opts.nm || 14;
    /* 驱动频率扫过的范围(∝ k²)。逐帧量参考:主体是一行 8–10 个格子,
       对应 n,m ≈ 9–12,也就是 n²+m² 在 80–230 之间。这一段里本征值已经很密,
       而且简并成堆(65=1+64=16+49,85=4+81=36+49,…)—— 多个模态叠在一起,
       节线自然成一张有机的迷宫,而不是横平竖直的网格。 */
    this.F0 = opts.f0 || 70;
    this.F1 = opts.f1 || 235;
    /* 参与叠加的窗宽:n²+m² 落在 K±BW 之内的模态都算进来。
       窄了只剩一个模态 ⇒ 图形是横平竖直的规整网格;
       宽了太多不同的 |k| 混在一起 ⇒ 尺度不统一、脊粗细不匀。
       参考那张迷宫的脊宽是**处处一样**的,所以窗要窄而不独。 */
    this.BW = opts.bw || 26;
    this.WARP = opts.warp ?? 0.014;      // 行波扭曲的幅度(板宽的百分之三)
    /* 荡漾的幅度。这里踩过一个量纲上的坑:Gerstner 的位移是 Q/k,本身就很小
       (三列加起来才 0.157 个板宽),再乘一个 0.1 量级的系数,实际只挪了板宽的
       千分之四 —— 等于没动。量了才发现:参考相邻帧之间有 7.7% 的像素在
       "有粉/没粉"之间翻掉,要达到这个数,位移得有板宽的百分之五左右。
       现在 1.25,量出来翻转率 7.2%,和参考基本齐平。
       波长(0.58–1.45)远大于脊宽(约 0.02),所以脊是**整条平移**的,不会被抹糊。 */
    this.ALIVE = opts.alive ?? 0.38;
    this.BIGP = opts.bigp ?? 0.00060;   // 每小步、每颗被甩成飞屑的概率
    this.textTex = new Float32Array(G2 * 4);
    this.ampW = new Float32Array(G2);
    this.peak = 1;
    this.ca = [];
    for (let n = 0; n <= this.NM; n++) {
      const a = new Float32Array(G);
      for (let i = 0; i < G; i++) a[i] = Math.cos(n * Math.PI * (i / (G - 1)));
      this.ca.push(a);
    }
    this.R = [];
    for (let n = 0; n <= this.NM; n++) this.R.push(new Float32Array(G));
    const NC = (this.NM + 1) ** 2;
    this.cmn = new Float32Array(NC);
    /* 每个模态一条自己的慢转相位 —— 整片场因此永远在缓慢重新配比,
       迷宫就一直在扭,而且没有任何一个\"换图\"的瞬间。 */
    this.ph = new Float32Array(NC);
    this.om = new Float32Array(NC);
    for (let i = 0; i < NC; i++) {
      this.ph[i] = rnd01() * Math.PI * 2;
      /* 每个模态的自转速度。量过参考:相邻帧之间有 7.7% 的像素会在"有粉/没粉"
         之间翻掉 —— 图形重排得相当快,半秒左右整张迷宫就换了一遍。
         原来这里是 0.055–0.155,只给得出 3.0%,慢了两倍半。 */
      /* 模态系数自转的快慢 —— 它决定**图形本身改不改形**(脊会不会断开、
         并拢、长出新的格子)。之前 0.26–0.68,两三秒才重组一遍;
         而荡漾那一层是 2–3 rad/s 的大幅位移,快的运动全是整块平移,
         形状一点没变 —— 看着就是同一个东西在膨胀收缩。
         提到 0.9–2.5:一拍之内脊就会真的并拢、断开、重连。 */
      /* 定这个数的办法:相邻帧做互相关,看**对齐之后还剩多少相关度** ——
         这个量只管"结构变了多少",不受飞屑闪烁的干扰(翻转率会被飞屑带偏)。
         参考量出来是 0.912。我 1×=0.949(变化偏小)、3.2×=0.854(变化过头),
         2.1× 正好落在 0.917。
         顺带确认了一件事:参考的图案**平移量恒为零** —— 它是原地重组的,
         不是一片在走。所以位移那一层只能当配角,不能当主角。 */
      this.om[i] = (3.25 + rnd01() * 5.15) * (opts.oms ?? 1);
    }
    this.TG = 256; this.tf = null;
  }

  buildText(text) {
    const G = this.TG;
    const c = document.createElement('canvas'); c.width = G; c.height = G;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, G, G);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const fit = (px) => {
      g.font = `700 ${px}px ui-monospace, "SF Mono", Menlo, monospace`;
      return g.measureText(text).width;
    };
    let size = Math.round(G * 0.30);
    if (fit(size) > G * 0.86) size = Math.max(10, Math.floor(size * G * 0.86 / fit(size)));
    fit(size);
    g.fillText(text, G / 2, G / 2);
    const d = g.getImageData(0, 0, G, G).data;
    const INF = 1e6, f = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) f[i] = d[i * 4] > 110 ? 0 : INF;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const i = y * G + x;
      if (x > 0) f[i] = Math.min(f[i], f[i - 1] + 1);
      if (y > 0) f[i] = Math.min(f[i], f[i - G] + 1);
      if (x > 0 && y > 0) f[i] = Math.min(f[i], f[i - G - 1] + 1.41);
      if (x < G - 1 && y > 0) f[i] = Math.min(f[i], f[i - G + 1] + 1.41);
    }
    for (let y = G - 1; y >= 0; y--) for (let x = G - 1; x >= 0; x--) {
      const i = y * G + x;
      if (x < G - 1) f[i] = Math.min(f[i], f[i + 1] + 1);
      if (y < G - 1) f[i] = Math.min(f[i], f[i + G] + 1);
      if (x < G - 1 && y < G - 1) f[i] = Math.min(f[i], f[i + G + 1] + 1.41);
      if (x > 0 && y < G - 1) f[i] = Math.min(f[i], f[i + G - 1] + 1.41);
    }
    this.tf = f;

    /* 字的场也做成一张和驻波场一样的纹理(振幅 + 归一化梯度),单独传上去。
       为什么要单独一张:聚字要**一团一团地先后出发**才丝滑,
       所以混合的比例必须是**每颗粉自己的**,不能在 CPU 上先混好再传 ——
       先混好的话全盘粉是同一个节拍,看着就是整块板一起跳。 */
    const FG = this.FG, T4 = this.textTex, ta = this.ampW;
    for (let j = 0; j < FG; j++) {
      const sy = Math.min(G - 1, ((FG - 1 - j) / (FG - 1) * (G - 1)) | 0) * G;
      for (let i = 0; i < FG; i++) {
        const sx = Math.min(G - 1, (i / (FG - 1) * (G - 1)) | 0);
        ta[j * FG + i] = Math.pow(clamp(f[sy + sx] / 150, 0, 1), 0.34);
      }
    }
    for (let j = 0; j < FG; j++) {
      const r = j * FG, up = j > 0 ? r - FG : r, dn = j < FG - 1 ? r + FG : r;
      for (let i = 0; i < FG; i++) {
        const k = r + i;
        const aa = ta[k + (i < FG - 1 ? 1 : 0)] - ta[k - (i > 0 ? 1 : 0)];
        const bb = ta[dn + i] - ta[up + i];
        const l = Math.sqrt(aa * aa + bb * bb) + 1e-6;
        T4[k * 4] = ta[k]; T4[k * 4 + 1] = aa / l; T4[k * 4 + 2] = bb / l; T4[k * 4 + 3] = 0;
      }
    }
    if (this.gl && this.texText) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texText);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FG, FG, gl.RGBA, gl.FLOAT, T4);
    }
  }

  addRect(M, out, w) { /* 保留给将来的方板模态;当前走受迫响应 */ }

  /* ── 场:一列**实数**驻波的叠加 ─────────────────────────────────────
     这里踩过一个大坑。之前把驱动的受迫响应算成复数,再取模 |W| —— 结果脊
     永远断成一段段的弧,怎么调都连不起来。原因是数学上的:复数场要同时
     满足实部=0、虚部=0 两个条件,在二维平面上交出来的是**孤立的点**,
     根本不存在连续的节线。而真板子上的驻波是**实**的,一个条件,交出来
     的是一族连续的**曲线** —— 参考里那张一笔到底的迷宫就是这么来的。

     所以改成:挑一撮 n²+m² 落在 K 附近的模态(窗宽 BW),每个配一个实系数,
     系数各自以很慢的速度漂。于是
       · 场是实的 ⇒ 零点集是连续曲线 ⇒ 脊连得起来;
       · 同一个 |k| 上有很多模态一起叠 ⇒ 弯曲的迷宫,不是横平竖直的网格;
       · 系数连续地漂 ⇒ 迷宫连续地扭动,没有任何一个\"换图\"的瞬间。 */
  response(K, a0, b0, out, R1) {
    const G = this.FG, NM = this.NM, t = this.ft;
    const cmn = this.cmn, BW = this.BW;
    for (let n = 0; n <= NM; n++) {
      const pn = Math.cos(n * Math.PI * a0);
      for (let m = 0; m <= NM; m++) {
        const k2 = n * (NM + 1) + m;
        if (!n && !m) { cmn[k2] = 0; continue; }
        const d = ((n * n + m * m) - K) / BW;
        if (d < -2.6 || d > 2.6) { cmn[k2] = 0; continue; }
        /* 窗内的权重 × 驱动点的选择性 × 一条很慢的自转相位。
           相位互不相同(按 n,m 散开),所以整片场永远在缓慢地重新配比。 */
        const ph = this.ph[k2];
        cmn[k2] = Math.exp(-d * d) * pn * Math.cos(m * Math.PI * b0)
                  * Math.cos(t * this.om[k2] + ph);
      }
    }
    const P = out;
    P.fill(0);
    for (let n = 0; n <= NM; n++) {
      const Rn = R1[n], base = n * (NM + 1);
      Rn.fill(0);
      for (let m = 0; m <= NM; m++) {
        const c = cmn[base + m]; if (c === 0) continue;
        const cb = this.ca[m];
        for (let j = 0; j < G; j++) Rn[j] += c * cb[j];
      }
    }
    for (let n = 0; n <= NM; n++) {
      const ca = this.ca[n], Rn = R1[n];
      for (let j = 0; j < G; j++) {
        const rj = Rn[j]; if (rj === 0) continue;
        const r = j * G;
        for (let i = 0; i < G; i++) P[r + i] += ca[i] * rj;
      }
    }
    // 实数场 ⇒ 取绝对值,零点集是连续的曲线
    for (let k = 0, n = G * G; k < n; k++) { const v = P[k]; P[k] = v < 0 ? -v : v; }
  }

  field(dtField = 1 / 60) {
    const G = this.FG, amp = this.amp, t = this.t;
    /* ── 拍子 ──────────────────────────────────────────────────────
       参考的音轨做 onset:间隔中位数 0.71 秒(≈84 BPM);画面的帧间运动量
       自相关落在 0.63–0.70,1.30 秒上还有个更强的峰 —— 两拍一个乐句。 */
    const BEAT = this.BEAT;
    const bu = (t / BEAT) % 1;

    /* ── 涌落的形状:必须是**周期上光滑**的 ──────────────────────────────
       上一版用 e^(−t/τ) 做"快起慢落",形状是对的,但它在拍子的交界处
       从 0.43 直接跳到 3.13 —— **一帧之内跳了七倍**。每 0.7 秒愣一下,
       就是"一愣一愣"的来源。包络本身没错,错在它不连续。

       换成三角多项式:基频给涌落,二次谐波(负号)把峰往前推 ——
       上升占 40%、下降占 60%,快起慢落;而且作为三角多项式它在整个周期上
       任意阶可导,交界处严丝合缝(0.400 → 0.400)。 */
    const ph = 6.2831853 * bu;
    let raw = 0.5 - 0.5 * Math.cos(ph) - 0.30 * Math.sin(2 * ph);
    if (raw < 0) raw = 0;
    /* 指数也不能太高。量过:三次方的时候涌起来那一下太陡 —— 曲线虽然连续,
       但二阶差分(加加速度)是参考的一倍半,看着还是一顿一顿的。
       降到 1.8 次方、峰谷从八倍收到四倍,升降就都化开了。 */
    const swell = Math.pow(raw / 1.27, 1.8);           // 0..1,峰在四成拍处
    this.kick = swell;

    /* ── 海浪的包络 ────────────────────────────────────────────────────
       量参考的运动能量曲线才看明白:它**不是匀速在动**的。把能量按 ±0.3 秒
       平滑之后,最低 1.9、最高 19.5 —— 一涌一落差了**十倍**。
       形状是"快起慢落":一记涌上来,然后几百毫秒里缓缓退下去,接着下一记。
       而且一组一组的(四拍一组,有大浪也有小浪)—— 这就是海浪的感觉。
       我之前是恒定幅度,所以看着是机械的搅动,不是浪。

       这条包络不只管荡漾的幅度,**连场自己往前走的快慢也归它管**:
       涌的时候图形变得快,落的时候几乎停住。所以下面用的是 ft(场的时间),
       它按 env 累积,而不是墙上时间。 */
    const set = 0.78 + 0.44 * (0.5 - 0.5 * Math.cos(6.2831853 * t / (BEAT * 4)));
    this.env = (0.55 + 1.75 * swell) * set;            // 均值≈1.0,峰谷≈4 倍
    this.ft += dtField * this.env;

    /* ── 驱动频率:**连续**地走,不再在共振点之间跳 ──────────────────
       之前是"停在共振点 → 跳到下一个",所以每两拍图形要重排一次 ——
       不管怎么过渡都有一道坎,那就是"不丝滑"的根。
       逐帧看参考才看明白:它的图形是**一刻不停地缓慢扭动**的,从头到尾
       没有换过图,只是同一张迷宫在慢慢流变。高模态区的本征值很密,
       F 连续地漂过去,图形就自己连续地变形。
       而且**要漂得慢**:一秒只挪几个单位。试过一段里横扫一百六十多个单位,
       图形每三秒整个重排一次 —— 粉永远在追新位置,格子里就永远有一层灰,
       看着还是"一段一段"的。参考那张迷宫是**几秒都保持同一个拓扑、
       只在缓慢扭动**的,所以这里用三个很慢的正弦叠出一条漂移线。 */
    const F = 150 + 55 * Math.sin(t * 0.185) + 22 * Math.sin(t * 0.095 + 1.3)
                  + 9 * Math.sin(t * 0.360 + 2.1);
    const a0 = 0.5 + 0.26 * Math.sin(t * 0.041), b0 = 0.5 + 0.21 * Math.cos(t * 0.033 + 1.1);
    const dx0 = a0 * 2 - 1, dy0 = b0 * 2 - 1;

    this.response(F, a0, b0, amp, this.R);

    /* 归一化 + 板边 + 每一拍荡出去的那一圈涟漪。
       涟漪现在只是一圈**扰动**(经过的地方粉被掀起来),图形本身不靠它换 ——
       所以它给的是水波的样子和颜色,不再是过渡的手段。 */
    let mx = 0;
    for (let k = 0, n = G * G; k < n; k += 7) if (amp[k] > mx) mx = amp[k];
    this.peak += (mx - this.peak) * 0.14;
    const inv = 1 / (this.peak + 1e-6);
    const front = -0.3 + bu * 3.2;
    /* 这一圈的强度在拍子两端都要是**零**,否则拍首会凭空冒出一圈 ——
       又是一处一愣。sin² 在 0 和 1 处值和导数都为零,进出都是化开的。 */
    const sb = Math.sin(Math.PI * bu);
    const ringAmp = 0.24 * sb * sb;
    const gedge = this.gedge;
    for (let j = 0; j < G; j++) {
      const v = (j / (G - 1)) * 2 - 1, r = j * G;
      for (let i = 0; i < G; i++) {
        const u = (i / (G - 1)) * 2 - 1, k = r + i;
        let q = amp[k] * inv;
        const du = u - dx0, dv = v - dy0;
        const dist = Math.sqrt(du * du + dv * dv);
        const ring = (dist - front) / 0.14;
        if (ring > -3 && ring < 3) q += Math.exp(-ring * ring) * ringAmp;
        const tt = gedge[k];
        if (tt > 0) q += (1 - q) * tt;                 // 自由边 = 波腹
        amp[k] = q > 1 ? 1 : q;
      }
    }
    this.front = front; this.dx0 = dx0; this.dy0 = dy0;

    /* 字不在这里混了 —— 它单独走一张纹理,由每颗粉自己按各自的时刻去混。
       在这里混的话整盘粉是同一个节拍,聚字就成了"整块板一起跳"。 */
    /* ── 荡漾:把整张场做一个**行波扭曲** ──────────────────────────────
       模态的系数慢慢漂,给的是"图形在变";但粉本身是不动的 —— 它到了节线上
       就趴着,画面是活的、粉是死的。真板上那层粉一刻不停在晃。
       所以这里把采样坐标按几列行波错开:整张迷宫像一块水面一样在荡,
       节线一直在小幅度地摆,趴着的粉就被带着一起摆。
       幅度只有板宽的百分之二三 —— 图形认得出是同一张,但它一直在动。 */
    const wA = this.WARP, wk = 3.1, wt = this.ft * 1.35;
    const ampW = this.ampW;
    for (let j = 0; j < G; j++) {
      const v = (j / (G - 1)) * 2 - 1;
      for (let i = 0; i < G; i++) {
        const u = (i / (G - 1)) * 2 - 1;
        const ou = wA * (Math.sin(wk * v + wt) + 0.6 * Math.sin(wk * 1.7 * v - wt * 0.8 + 2.1));
        const ov = wA * (Math.sin(wk * u + wt * 1.1 + 1.7) + 0.6 * Math.sin(wk * 1.4 * u - wt * 0.7));
        // 双线性取样(坐标已归一到格子)
        let fx = (u + ou + 1) * 0.5 * (G - 1), fy = (v + ov + 1) * 0.5 * (G - 1);
        if (fx < 0) fx = 0; else if (fx > G - 1.001) fx = G - 1.001;
        if (fy < 0) fy = 0; else if (fy > G - 1.001) fy = G - 1.001;
        const ii = fx | 0, jj = fy | 0, uu = fx - ii, vv = fy - jj, kk = jj * G + ii;
        ampW[j * G + i] = amp[kk] * (1 - uu) * (1 - vv) + amp[kk + 1] * uu * (1 - vv) +
                          amp[kk + G] * (1 - uu) * vv + amp[kk + G + 1] * uu * vv;
      }
    }
    amp.set(ampW);

    const F4 = this.fieldTex;
    for (let j = 0; j < G; j++) {
      const r = j * G, up = j > 0 ? r - G : r, dn = j < G - 1 ? r + G : r;
      for (let i = 0; i < G; i++) {
        const k = r + i;
        const aa = amp[k + (i < G - 1 ? 1 : 0)] - amp[k - (i > 0 ? 1 : 0)];
        const bb = amp[dn + i] - amp[up + i];
        const l = Math.sqrt(aa * aa + bb * bb) + 1e-6;
        F4[k * 4] = amp[k]; F4[k * 4 + 1] = aa / l; F4[k * 4 + 2] = bb / l; F4[k * 4 + 3] = 0;
      }
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texField);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, G, G, gl.RGBA, gl.FLOAT, F4);
  }

  /* ── GL 对象 ────────────────────────────────────────────────────── */
  prog(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  tex(w, h, internal, format, type, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  fbo(...texs) {
    const gl = this.gl;
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    if (texs.length > 1) gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    return f;
  }

  initGLObjects(opts = {}) {
    const gl = this.gl, TW = this.TW, TH = this.TH, G = this.FG;
    this.pSim = this.prog(VS_QUAD, FS_SIM);
    this.pPoints = this.prog(VS_POINTS, FS_POINTS);
    this.pBlur = this.prog(VS_QUAD, FS_BLUR);
    this.pComp = this.prog(VS_QUAD, FS_COMP);
    this.vao = gl.createVertexArray();

    const F = gl.NEAREST, L = gl.LINEAR;
    this.stateA = [this.tex(TW, TH, gl.RGBA32F, gl.RGBA, gl.FLOAT, F), this.tex(TW, TH, gl.RGBA32F, gl.RGBA, gl.FLOAT, F)];
    this.stateB = [this.tex(TW, TH, gl.RGBA32F, gl.RGBA, gl.FLOAT, F), this.tex(TW, TH, gl.RGBA32F, gl.RGBA, gl.FLOAT, F)];
    this.simFbo = [this.fbo(this.stateA[0], this.stateB[0]), this.fbo(this.stateA[1], this.stateB[1])];
    this.cur = 0;

    this.texField = this.tex(G, G, gl.RGBA32F, gl.RGBA, gl.FLOAT, L);
    this.texText = this.tex(G, G, gl.RGBA32F, gl.RGBA, gl.FLOAT, L);
    this.texDens = this.tex(G, G, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, L);
    this.densFbo = this.fbo(this.texDens);

    this.texFull = this.tex(this.W, this.H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, L);
    this.fullFbo = this.fbo(this.texFull);
    this.hw = Math.max(1, this.W >> 1); this.hh = Math.max(1, this.H >> 1);
    this.texBlur = this.tex(this.hw, this.hh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, L);
    this.blurFbo = this.fbo(this.texBlur);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  initParticles() {
    const gl = this.gl, TW = this.TW, TH = this.TH;
    const a = new Float32Array(TW * TH * 4), b = new Float32Array(TW * TH * 4);
    for (let i = 0; i < TW * TH; i++) {
      a[i * 4] = rnd01() * 2 - 1; a[i * 4 + 1] = rnd01() * 2 - 1;
    }
    for (const [tex, data] of [[this.stateA[0], a], [this.stateB[0], b], [this.stateA[1], a], [this.stateB[1], b]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, TH, gl.RGBA, gl.FLOAT, data);
    }
  }

  /* 一上来就把粉撒在节线上 —— 否则开场十几秒是一团散沙,
     那是参考里从来没有的画面。 */
  seed() {
    const gl = this.gl, TW = this.TW, TH = this.TH, G = this.FG, amp = this.amp;
    const a = new Float32Array(TW * TH * 4);
    const AC = 0.21;
    for (let i = 0; i < TW * TH; i++) {
      let x = 0, y = 0;
      for (let k = 0; k < 20; k++) {
        x = rnd01() * 2 - 1; y = rnd01() * 2 - 1;
        const gi = Math.min(G - 1, ((x + 1) * 0.5 * G) | 0);
        const gj = Math.min(G - 1, ((y + 1) * 0.5 * G) | 0);
        if (amp[gj * G + gi] < AC * (0.68 + rnd01() * 0.72)) break;
      }
      a[i * 4] = x; a[i * 4 + 1] = y;
    }
    for (const tex of [this.stateA[0], this.stateA[1]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, TH, gl.RGBA, gl.FLOAT, a);
    }
  }

  /* ── 一帧 ───────────────────────────────────────────────────────── */
  drawPoints(fboTarget, vw, vh, plateSpace, pointSize) {
    const gl = this.gl, P = this.pPoints;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTarget);
    gl.viewport(0, 0, vw, vh);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.stateA[this.cur]);
    gl.uniform1i(P.u.uA, 0);
    gl.uniform1i(P.u.uTexW, this.TW);
    gl.uniform2f(P.u.uViewport, this.W, this.H);
    gl.uniform1f(P.u.uF, this.F);
    gl.uniform1f(P.u.uCx, this.cx); gl.uniform1f(P.u.uCy, this.cy);
    gl.uniform1f(P.u.uPointSize, pointSize);
    gl.uniform1f(P.u.uPointSizeAir, Math.max(1, pointSize * 0.72));
    gl.uniform1f(P.u.uW, this.w); gl.uniform1f(P.u.uWShare, this.WSHARE);
    gl.uniform1i(P.u.uPlateSpace, plateSpace);
    gl.uniform2f(P.u.uDrive, this.dx0, this.dy0);
    gl.uniform1f(P.u.uFront, this.front);
    gl.uniform1f(P.u.uTime, this.ft);
    /* 荡漾的总幅度。经验值:压在脊宽的一半以下 —— 再大脊就读不出来了,
       小于两成又看着是静的。字相里收到三成,笔画才立得住。 */
    gl.uniform1f(P.u.uAlive, this.ALIVE * (1 - this.w * 0.7) * this.env);
    gl.uniform1f(P.u.uMorphDur, 0.34);
    gl.uniform1f(P.u.uUnit, plateSpace ? 1 / 255 : this.UNIT);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.N);
    gl.disable(gl.BLEND);
  }

  step(dt) {
    const gl = this.gl;
    this.t += dt;
    const cy = this.t / this.CYCLE, ck = Math.floor(cy), cu = cy - ck;
    if (ck !== this.ck) { this.ck = ck; this.buildText(this.lines[this.li++ % this.lines.length]); }
    const P = this.PH;
    if (cu < P.gather) { this.phase = 'wave'; this.w = 0; }
    else if (cu < P.hold) { this.phase = 'gather'; this.w = smooth((cu - P.gather) / (P.hold - P.gather)); }
    else if (cu < P.release) { this.phase = 'hold'; this.w = 1; }
    else { this.phase = 'release'; this.w = 1 - smooth((cu - P.release) / (1 - P.release)); }

    this.field(dt);
    // 板面堆积密度:GPU 自己数自己
    this.drawPoints(this.densFbo, this.FG, this.FG, 1, 1);

    const S = this.pSim, w = this.w;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[1 - this.cur]);
    gl.viewport(0, 0, this.TW, this.TH);
    gl.useProgram(S.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.stateA[this.cur]); gl.uniform1i(S.u.uA, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.stateB[this.cur]); gl.uniform1i(S.u.uB, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texField); gl.uniform1i(S.u.uField, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.texDens); gl.uniform1i(S.u.uDens, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.texText); gl.uniform1i(S.u.uText, 4);
    gl.uniform1f(S.u.uMorphDur, 0.34);
    /* 一百万颗粉足够把整条带子填满,所以现在"带子有多宽,脊就有多宽"。
       参考量出来脊约等于格子的六分之一,所以门槛要从 0.21 收到 0.13。 */
    const kick = this.kick;
    /* 卡点的那一下:临界值掉下去 ⇒ 本来躺着的粉也被掀起来,
       随后在一百毫秒里落回节线 —— 看着就是"踩在拍子上弹了一下"。 */
    /* 参考的脊大约是格子的六分之一,我这边一度做到三分之一 —— 带子太宽。
       收窄带子的同时必须把堆量抬上去:同样一百万颗粉要挤进更窄的带子,
       只能往高里堆;不抬的话粉挤不下,又会漫回格子里变成灰。 */
    /* 白的面积要对得上:参考一格里白占三成(直方图 64% 是纯黑),
       这个门槛定 0.18 时我这边白占了五成五 —— 脊和格子一样宽了。
       收到 0.115。收窄之后带子装不下那么多粉,所以粉的总量也要跟着减半
       (见 gl.html 的 texh)—— 单位面积的密度不变,脊照样是实的。 */
    gl.uniform1f(S.u.uACrit, (0.205 - w * 0.065) * (1.0 - 0.22 * kick));
    /* 随机游走那一份也跟着收小 —— 它现在只负责脊边缘的毛和沸,不负责迁移。 */
    gl.uniform1f(S.u.uStep, 0.013 * (1 - w * 0.30) * (1 + 0.45 * kick));
    gl.uniform1f(S.u.uFloor, 0.16);
    /* 每小步滑这么远;六小步一帧、一秒五十帧 ⇒ 约 1.5 板宽/秒。
       慢到看得见一段流,又快到粉跟得上图形的扭动。 */
    gl.uniform1f(S.u.uGlide, 0.0090 * (0.45 + 0.85 * this.env));
    /* 一格能堆多少。节线带约占板面两成,所以带子摊匀时一格是平均密度的五倍;
       堆量定在略高于它 —— 带子填满、刚好不外溢。定低了(试过 3.7)每一格都
       "堆不下",粉就一直往外摊,脊胀成一团一团的疙瘩,网就断了。 */
    gl.uniform1f(S.u.uPile, (12.0 + w * 34) * this.N / (this.FG * this.FG));
    gl.uniform1f(S.u.uSpread, 0.014);
    gl.uniform1f(S.u.uBigP, this.BIGP * (1 - w * 0.6) * (1 + 2.6 * kick));
    gl.uniform1f(S.u.uGrav, 26.0);
    gl.uniform1f(S.u.uDt, dt);
    /* 躺下的粉也留一点点抖:参考里脊面是一直在沸的,完全冻住像一张贴图。 */
    gl.uniform1f(S.u.uShimmer, 0.0009);
    /* 沿脊淌的那一股。字相里收一半 —— 笔画要立得住。 */
    gl.uniform1f(S.u.uFlow, 0.0065 * (1 - w * 0.5) * this.env);
    gl.uniform1f(S.u.uFlowT, this.t * 2.1);
    gl.uniform1f(S.u.uDensMax, 255);
    gl.uniform1f(S.u.uW, w); gl.uniform1f(S.u.uWShare, this.WSHARE);
    gl.uniform1ui(S.u.uFrame, this.frame >>> 0);
    gl.uniform1i(S.u.uSub, 6);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
    this.frame++;
  }

  draw() {
    const gl = this.gl;
    // ① 点 → 全分辨率密度
    this.drawPoints(this.fullFbo, this.W, this.H, 0, 2.0 * this.DPR);
    // ② 降采样 + 模糊(只给法线)
    const B = this.pBlur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFbo);
    gl.viewport(0, 0, this.hw, this.hh);
    gl.useProgram(B.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texFull);
    gl.uniform1i(B.u.uSrc, 0);
    gl.uniform2f(B.u.uTexel, 1 / this.hw, 1 / this.hh);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // ③ 合成
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    /* ② 粉末**加法叠**在上面。原来这一趟是不透明的(没粉的地方写纯黑),
       那样会把背景整片抹掉;改成加法之后,黑的地方就是没有粉,
       背景自然透出来 —— 粉末是浮在壁纸前面的一层,不是盖住它的一张图。 */
    const C = this.pComp;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(C.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texFull); gl.uniform1i(C.u.uDens, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texBlur); gl.uniform1i(C.u.uBlur, 1);
    gl.uniform2f(C.u.uTexelFull, 1 / this.W, 1 / this.H);
    gl.uniform2f(C.u.uTexelHalf, 1 / this.hw, 1 / this.hh);
    gl.uniform1f(C.u.uUnitInv, 1 / this.UNIT);
    gl.uniform3f(C.u.uCream, 252 / 255, 250 / 255, 242 / 255);
    const pal = this.PALETTE, cy2 = this.t / this.CYCLE;
    /* 取模要**先绕回正数**:JS 的 % 对负数给负数,pal[-1] 是 undefined,
       下一行就会抛,而这一行跑在每一帧里 —— 抛一次整条 rAF 链就断了。 */
    const i0 = ((Math.floor(cy2) % pal.length) + pal.length) % pal.length, i1 = (i0 + 1) % pal.length;
    const f2 = smooth(Math.min(1, (cy2 - Math.floor(cy2)) * 1.6));
    gl.uniform3f(C.u.uAccent,
      pal[i0][0] + (pal[i1][0] - pal[i0][0]) * f2,
      pal[i0][1] + (pal[i1][1] - pal[i0][1]) * f2,
      pal[i0][2] + (pal[i1][2] - pal[i0][2]) * f2);
    /* 字相里把底色拉到 0.82:那一行字是**整条彩的**,不是白字。 */
    gl.uniform1f(C.u.uTintBase, 0.30 + 0.52 * this.w);
    gl.uniform1f(C.u.uBloom, this.BLOOM);
    gl.uniform1f(C.u.uGain, this.GAIN);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  frameStep(dt) { this.step(dt); this.draw(); }
}


/* ══════════════════════════════════════════════════════════════════════════
   引擎适配层 —— 把上面这块模拟接到 wallpaper.html 的引擎接口上。

   wallpaper.html 对三个引擎是**一视同仁**调的,而且不少调用没有做存在性判断
   (wp.setAgents / wp.pulse / wp.setActivity …)。少一个方法 = 壁纸当场抛错、
   用户桌面变成一张空窗。所以下面把整个接口**一个不落**地实现:
   有意义的接上去,没意义的留成空实现,绝不省。
   ══════════════════════════════════════════════════════════════════════════ */
export default class ChladniWallpaper {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.plate = null;
    this.raf = 0;
    this.last = 0;
    /* 板上写什么:agent 日志优先,没有就用 token 统计。和另外两个引擎一样,
       这些是**外面推进来**的,引擎自己不去查数据。 */
    this.lines = ['terse', 'agent idle'];
    this.intensity = 1;
  }

  /* ── 生命周期 ───────────────────────────────────────────────────────── */
  start() {
    /* 判的是**循环**,不是板子。原来这里判 this.plate,而 stop() 只取消 rAF、
       把板子留着 —— 于是窗口隐藏一次(wallpaper.html 的 visibilitychange 会
       stop/start)之后,start() 看见板子还在就直接 return,画面从此再也不动。
       板子留着是对的(重建要几十毫秒),要重来的只是循环。 */
    if (this.raf) return;
    if (!this.plate) {
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(320, Math.round(r.width) || this.canvas.clientWidth || 1280);
      this.plate = new ChladniPlate(this.canvas, {
        w, h: Math.round(w * 9 / 16),
        /* 粒子数按画面给。窄屏减半:节线带子装得下的粉是有限的,
           给多了会漫出带子变成一层灰(见 uPile 那一段)。 */
        texw: 1024, texh: w > 900 ? 512 : 256,
        lines: this.lines,
      });
    }
    this.last = performance.now();
    const loop = (now) => {
      /* dt 不能是负的。rAF 的时间戳是**这一帧开始**的时刻,可能早于刚刚在这一帧里
         调的 performance.now() —— 那样第一帧的 dt 就是负的,板上的时间会往回走,
         调色板下标跟着变成负数,draw() 一个 undefined[0] 把整条循环打死。
         看到的就是一张冻住的壁纸。 */
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.plate.frameStep(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  dispose() { this.stop(); this.plate = null; }
  resize() { const p = this.plate; this.dispose(); if (p) this.start(); }

  /* ── 板上那一行字 ───────────────────────────────────────────────────── */
  _setLines(list) {
    const clean = (list || []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 6);
    if (!clean.length) return;
    this.lines = clean;
    if (this.plate) this.plate.lines = clean;
  }
  setAgentLog(groups) {
    if (!groups) return;
    const out = [];
    for (const g of [].concat(groups)) {
      if (typeof g === 'string') out.push(g);
      else if (g && g.lines) out.push(...[].concat(g.lines).map(l => (l && l.text) || l));
      else if (g && g.text) out.push(g.text);
    }
    this._setLines(out);
  }
  feedLine(text) { if (text) this._setLines([text, ...this.lines].slice(0, 6)); }
  roomLine(text) { this.feedLine(text); }
  peerLog(text) { this.feedLine(text); }
  floatToken(n, kind) {
    if (!Number.isFinite(+n) || !+n) return;
    this.feedLine((kind === 'saved' ? '-' : '+') + Math.abs(+n).toLocaleString() + ' tok');
  }
  clearHeadline() {}

  /* ── 驱动:token 活动 → 板子被敲得多重 ──────────────────────────────── */
  pulse(strength) {
    /* 一次 token 事件 = 板上多一记重音。加在 ft 上,所以它推的是**图形改形**,
       不是把画面整体挪一下 —— 后者看着是鼓胀,不是浪。 */
    if (this.plate) this.plate.ft += Math.min(0.5, Math.max(0, +strength || 0) * 0.25);
  }
  setActivity(a) {
    /* 会话越忙,场走得越快;闲下来整块板慢下来。 */
    const v = Math.max(0, Math.min(1, +a || 0));
    this.intensity = 0.65 + v * 0.8;
  }

  /* ── 下面这些对这个引擎没有意义,但**必须存在** ─────────────────────── */
  setStyle() {}
  setTheme() {}
  setQuality() {}
  setAngle() {}
  setIntensity(v) { this.intensity = +v || 1; }
  setOverlay() {}
  setAgents() {}
  setStageItems() {}
  setPeers() {}
  setHover() {}
  showProject() {}
  hitTest() { return null; }
  setView() {}
  getView() { return { on: false }; }
  setView3D() {}
  getView3D() { return { on: false }; }
  isOrbiting() { return false; }
  attachOrbit() {}
  detachOrbit() {}
}
