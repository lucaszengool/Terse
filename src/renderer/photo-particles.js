/**
 * photo-particles.js — 把**用户自己的桌面壁纸**变成一块 3D 粒子板,浮在全黑的空间里。
 *
 * 这一层是**独立的**,不属于任何一个引擎:
 *   · 它自己一块 canvas,垫在引擎那块的**后面**(z-index 更低);
 *   · 所以它和 mineradio / 星轨炸环 / 声之形 / 音域回响 **都能搭**,
 *     引擎那边一行都不用改;
 *   · 关掉它 = 销毁这块 canvas,于是露出底下原来那张壁纸图 ——
 *     画面就回到"原壁纸 + 引擎的粒子",和从来没有过这个功能一样。
 *
 * ── 长成什么样:照 Mineradio 的封面板 ────────────────────────────────────
 * 参照的是 Mineradio 自己那块**专辑封面粒子板**(原文件就在仓库里:
 * `remotion-macdemo/.mineradio-src/00-pointer-cover-particles.js`):
 *
 *   · 封面是一块 `PLANE_SIZE = 4.8` 的方板,摆在原点,**背景全黑** —— 它只占
 *     屏幕中间一块,不铺满;歌词和其它粒子在它**前面**(见 `03-lyrics-star-river.js`)。
 *     (我们这一版的前一稿把图铺满了整屏,那就不是"一块浮在黑里的板"了。)
 *   · 点是**软圆点**,大小按深度衰减:原项目 `depthSize = 36 / max(0.5, -mvPos.z)`,
 *     再 clamp 到 1.05~4.95(00-pointer-cover-particles.js:831)。这里同一条 1/z 律。
 *   · 辉光不是后期 bloom,是**同一份几何再画一遍**:点更大、加性混合、压低亮度
 *     (原项目 uBloomSize 那一趟)。所以黑底上的粒子是"发着光的",不是硬点。
 *
 * 和封面唯一的不同:专辑封面是方的,桌面壁纸不是 —— 所以板子按**壁纸自己的比例**
 * 裁出来,装进一个"最多占多宽 / 多高"的框里(FILL_W / FILL_H),而不是拉成方板。
 *
 * ── 三条不能破的规矩 ──────────────────────────────────────────────────
 *   · 板子里就是那张壁纸:构图、颜色、亮度都不许动 —— 只是换成粒子的形态。
 *     (压暗过一版 0.52,整块板沉一档;"压暗"还会藏在采样率里 —— 点不够大就
 *      露黑缝,平均亮度照样掉。判据用**板内平均亮度**对比原图,别靠眼睛。)
 *   · 3D 来自粒子自己 + 相机:每颗按明暗浮起/沉下,整片荡 Gerstner 波,
 *     相机极缓慢地绕着板子飘(Mineradio 的"电影镜头"就是这一条)。
 *   · 位移要小。亮度是照片自己的,山脊那种**跳变**处两边粒子被推向相反方向,
 *     推大了中间就裂一条黑缝。
 */

/* 行波:三列方向互不平行,否则退化成单轴来回,看着像剪切。陡度之和 ≤ 1。 */
const WAVE = `
struct Swell { vec2 disp; float h; float jac; };
Swell swell(vec2 p, float t) {
  Swell s;
  s.disp = vec2(0.0); s.h = 0.0; s.jac = 1.0;
  vec2 dir[3];  float lam[3];  float Q[3];  float spd[3];
  dir[0] = normalize(vec2( 1.00,  0.22));  lam[0] = 0.95;  Q[0] = 0.42;  spd[0] = 2.30;
  dir[1] = normalize(vec2( 0.28,  1.00));  lam[1] = 0.58;  Q[1] = 0.26;  spd[1] = 3.10;
  dir[2] = normalize(vec2( 0.80, -0.62));  lam[2] = 1.45;  Q[2] = 0.30;  spd[2] = 1.65;
  for (int i = 0; i < 3; i++) {
    float k = 6.2831853 / lam[i];
    float f = k * dot(dir[i], p) - spd[i] * t;
    s.disp += dir[i] * (Q[i] / k * cos(f));   // cos ⇒ 椭圆轨道,不是来回直线
    s.h    += (Q[i] / k) * sin(f);
    s.jac  *= (1.0 - Q[i] * sin(f));
  }
  return s;
}`;

const VS = `#version 300 es
precision highp float;
uniform sampler2D uPhoto;
uniform vec2 uViewport;             // 画布像素
uniform float uHalfW, uHalfH;       // 板子的半宽/半高(世界单位)
uniform float uF, uD, uYaw, uPitch; // 焦距(像素)、相机距离、缓慢飘动的机位
uniform float uTime, uAlive, uPtPx, uRelief, uBloomSize;
/* uLayer 0 = 板身(那张壁纸),1 = **浮在它前面的点云**(见下面 GLINT 那一段)。 */
uniform float uLayer, uSpread, uCloudCut;
uniform int uGrid;
out vec2 vUv;
out float vShade;
out float vGlint;
uint uhash(uint x){ x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
${WAVE}

void main(){
  int id = gl_VertexID;
  int gx = id % uGrid, gy = id / uGrid;
  /* 每颗在自己的格子里抖一点 —— 不抖的话规则网格会在壁纸上织出摩尔纹。 */
  uint hh = uhash(uint(id) * 2654435761u);
  vec2 jit = (vec2(float(hh & 0xffffu), float((hh >> 16) & 0xffffu)) / 65535.0 - 0.5);
  vec2 g = (vec2(float(gx), float(gy)) + 0.5 + jit) / float(uGrid);   // 0..1 铺在板上

  /* 纹理是按默认(不翻 Y)传上去的,v=0 就是图的第一行 = 板子的上边。
     板子的本地 y 朝上,所以 y 和 v 是反的。 */
  vUv = g;
  vec3 c = textureLod(uPhoto, g, 0.0).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));

  float ar = uHalfW / uHalfH;
  Swell w = swell(vec2(g.x * ar, g.y) * 3.2, uTime);

  /* ── 浮在板子前面的那层点云(GLINT)───────────────────────────────────
     这是「和视频一样」的那一层。片子里(remotion-flash 的壁纸版,wshots.ts 第①幕)
     壁纸本身是**床**,亮点是**另一层**加性的点云浮在它前面 —— 所以推近看不是贴图、
     换个角度看是一团。这里同一个做法:同一份几何再画一遍,选出一部分粒子,
     往相机方向浮起来一层,加性叠上去。

     哪些粒子会亮:**边缘**和**亮部**。原项目也是这么挑的(mineradio-shaders.js 的
     edgeBoost:边缘上的粒子 +0.20 再乘 1.3)—— 云的边、山的脊会先闪起来,
     平坦的地方几乎不参与,于是点云是贴着画面结构长的,不是撒在上面的一层雪。 */
  vec2 tx = 1.0 / vec2(textureSize(uPhoto, 0));
  float lx = dot(textureLod(uPhoto, g + vec2(tx.x, 0.0), 0.0).rgb, vec3(0.2126, 0.7152, 0.0722))
           - dot(textureLod(uPhoto, g - vec2(tx.x, 0.0), 0.0).rgb, vec3(0.2126, 0.7152, 0.0722));
  float ly = dot(textureLod(uPhoto, g + vec2(0.0, tx.y), 0.0).rgb, vec3(0.2126, 0.7152, 0.0722))
           - dot(textureLod(uPhoto, g - vec2(0.0, tx.y), 0.0).rgb, vec3(0.2126, 0.7152, 0.0722));
  float edge = clamp(length(vec2(lx, ly)) * 6.0, 0.0, 1.0);
  float r1 = float(uhash(uint(id) * 917u) & 0xffffu) / 65535.0;
  float r2 = float(uhash(uint(id) * 2311u) & 0xffffu) / 65535.0;
  /* 闪:每颗自己的周期,所以是"点在呼吸",不是整片一起亮一下。 */
  float tw = 0.45 + 0.55 * sin(uTime * (0.7 + 1.7 * r1) + r2 * 6.2831);
  float pick = step(uCloudCut, r1);                       // 只有一部分粒子参与
  /* 只按**边缘**挑,而且越亮的地方给得越少。
     先写成"边缘 + 亮部"试过:天空本来就接近白,再加性叠一层就糊成一片白雾,
     云的层次全没了 —— 和前面两次踩的是同一个坑(加性叠加要看底下已经多亮)。 */
  /* 再乘一条**缓慢扫过**的浪峰。片子里那层亮点不是均匀撒在整张图上的,
     是一带一带地翻涌过去(云那一条金色的带子就是这么来的)。只按边缘挑的话,
     一片树林处处是边缘,整块板会均匀地起一层白毛 —— 那是"加了噪点",不是点云。 */
  float band = smoothstep(0.35, 0.92, 0.5 + 0.5 * sin(g.x * 3.1 + g.y * 1.7 - uTime * 0.33));
  vGlint = (uLayer > 0.5)
         ? pick * clamp(edge * edge * 3.4, 0.0, 1.2) * band * (0.30 + 0.70 * tw)
           * (1.0 - smoothstep(0.55, 0.95, lum))
         : 0.0;
  /* 点云往相机方向浮起来一层 —— 有厚度才有视差,视差才是"立体"的来源。
     每颗浮多高由它自己的随机数定,所以是一层**云**,不是一块贴在前面的板。 */
  float cloudZ = (uLayer > 0.5) ? (0.15 + 0.85 * r2) * uSpread * uHalfH : 0.0;

  /* 高度 = 壁纸自己的明暗(亮处浮起来)+ 这一拍的浪。板不动,是**面**在起伏。 */
  float z = ((lum - 0.45) * uRelief + w.h * 0.55 * uAlive) * uHalfH * 0.30 + cloudZ;

  vec3 p = vec3((g.x - 0.5) * 2.0 * uHalfW + w.disp.x * uHalfH * 0.035 * uAlive,
                (0.5 - g.y) * 2.0 * uHalfH + w.disp.y * uHalfH * 0.035 * uAlive,
                z);
  /* 相机极缓慢地绕着板子飘 —— 这是 Mineradio 那股"电影镜头"的来源。
     幅度很小(几度),它要的是"这块板是立体的",不是把图转走。 */
  float cy = cos(uYaw), sy = sin(uYaw);
  p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  float cp = cos(uPitch), sp = sin(uPitch);
  p = vec3(p.x, cp * p.y - sp * p.z, sp * p.y + cp * p.z);

  float zc = max(uD + p.z, 0.25);
  float invz = 1.0 / zc;
  vec2 scr = vec2(uViewport.x * 0.5 + uF * p.x * invz,
                  uViewport.y * 0.5 - uF * p.y * invz);
  gl_Position = vec4(scr.x / uViewport.x * 2.0 - 1.0, 1.0 - scr.y / uViewport.y * 2.0, 0.0, 1.0);
  /* 点大小按深度衰减 —— Mineradio 的 1/z 律(00-pointer-cover-particles.js:831)。
     uPtPx 是板子正对相机时一颗该有的像素大小,由格距算出来(见 _layout)。 */
  /* 点云那一层的点稍大、更软 —— 片子里那些亮点比床上的粒子明显大一圈。 */
  gl_PointSize = clamp(uPtPx * uD * invz, 0.8, 9.0) * uBloomSize * (uLayer > 0.5 ? 2.2 : 1.0);

  /* 明暗:①浪把粒子挤到一起的地方亮一点 ②浮起来的高一点点更亮 ③每颗自己的抖动。
     三项均值都在 1 附近:板里要和原图一样亮。
     ①的幅度按**实际用了多少位移**折算 —— 满幅着色的话平滑的天空会浮出波纹扇贝。 */
  float jacShade = clamp(1.0 + (1.0 / max(w.jac, 0.5) - 1.0) * 0.22, 0.93, 1.09);
  vShade = jacShade
         * (1.0 + z / max(uHalfH, 0.001) * 0.30)
         * (0.88 + 0.24 * float(uhash(uint(id) * 40503u) & 0xffffu) / 65535.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uPhoto;
uniform float uDim, uBloomAmt, uGlowGate, uLayer;
in vec2 vUv;
in float vShade;
in float vGlint;
out vec4 o;
void main(){
  /* 软圆点(Mineradio 的 dotTexture 是一张 64×64 的径向渐变,这里直接算)。
     硬方点在黑底上会显出网格,软点才会连成一块"由粒子组成的板"。 */
  float d = length(gl_PointCoord - 0.5);
  /* 边要软到看不出方点,又不能软到中间都不实 —— 软过头的话一个像素上压着两三颗
     也凑不满 1,整块板就比原图暗一档(量过 0.16:暗了 15%)。
     点云那一层反过来:要的就是一颗一颗的光点,所以给它更软的边。 */
  float a = (uLayer > 0.5) ? smoothstep(0.5, 0.05, d) : smoothstep(0.5, 0.30, d);
  if (a <= 0.003) discard;
  if (uLayer > 0.5) {
    if (vGlint <= 0.004) discard;
    /* 颜色取自壁纸本身(和床同一个像素),所以点云是"这张图自己的光",
       不是撒上去的白点 —— 云上是暖白,山脊上是金绿。 */
    vec3 gc = texture(uPhoto, vUv).rgb;
    gc = mix(gc, gc * 1.25 + vec3(0.06), 0.55);          // 边缘那一档提亮(原项目 edgeBoost)
    o = vec4(gc * uDim, a * vGlint * uBloomAmt);
    return;
  }
  vec3 raw = texture(uPhoto, vUv).rgb;
  /* 颗粒感要**让着高光**。天空本来就 0.93 上下,再乘一个 ±12% 的抖动必然出界,
     出界之后无论硬截还是等比压,云的层次都会被抹平(量过:板内 5% 的像素变成纯白,
     而原图一个都没有)。所以越亮的地方抖得越轻 —— 暗部和中间调照常有颗粒。 */
  float lum = dot(raw, vec3(0.2126, 0.7152, 0.0722));
  float shade = 1.0 + (vShade - 1.0) * mix(1.0, 0.30, smoothstep(0.55, 0.95, lum));
  vec3 c = raw * shade * uDim;
  // 还是出界的话按最大通道等比压回去 —— 色相不变。
  float mx = max(c.r, max(c.g, c.b));
  c /= 1.0 + max(0.0, mx - 1.0);
  float alpha = a * uBloomAmt;
  /* 辉光那一趟只许**亮的地方**发光。加性叠加是按"有多少颗盖住这个像素"算的,
     这里一个像素上压着十几颗 —— 不设门槛的话整块板会被抬亮四成,天空直接烧成白纸
     (量过:板内平均亮度 101 vs 原图 72)。有门槛之后只有高光周围晕开一点。 */
  if (uGlowGate > 0.5) alpha *= smoothstep(0.62, 1.0, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  o = vec4(c, alpha);
}`;

export default class PhotoParticles {
  /**
   * @param host 引擎 canvas 的父元素 —— 这一层会插在引擎 canvas **前面**
   *             (DOM 里在前 = 画在后,再配 z-index)。
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.GRID = opts.grid || 620;          // 约 38 万颗,铺在板子上
    this.DIM = opts.dim ?? 1.0;            // 不压暗:板里就是那张壁纸
    this.RELIEF = opts.relief ?? 0.85;     // 明暗 → 起伏
    /* 板子最多占多宽/多高(比例)。Mineradio 的方封面大约占屏幕高的一半;
       壁纸是宽的,所以两个方向各给一个上限,按壁纸自己的比例装进去。 */
    this.FILL_W = opts.fillWidth ?? 0.62;
    this.FILL_H = opts.fillHeight ?? 0.52;
    /** 'contain' = 整块板都看得见(封面板);'cover' = 铺满、超出的裁掉(窗口背景)。 */
    this.FIT = opts.fit || 'contain';
    this.DIST = opts.dist || 3.4;          // 相机到板子的距离(世界单位)
    /* ── 出场:先是你原本那张壁纸,再化开成粒子封面 ──────────────────────
       和宣传片里那一版**同一个做法**(remotion-flash 的 `WallReveal`,
       `src/flash/Flash.tsx`;节拍 `REVEAL = REVEAL_FADE = 30` 帧 = 各一秒):
       原壁纸**原地铺满**放一秒 —— 不缩成中间一块 —— 然后用一条平滑的 S 曲线
       化开成同一张图的粒子,粒子再自己收成封面板。
       用户 2026-09-29:「先展示它原本在 mac 桌面壁纸原本长啥样一秒钟,
       然后变成封面粒子的接上去,让用户更清晰可见。」 */
    this.REVEAL = opts.reveal !== false;
    this.HOLD = opts.hold ?? 1.0;          // 原壁纸不动的那一秒(片子里是 30 帧)
    this.DISSOLVE = opts.dissolve ?? 1.0;  // 化开(片子里也是 30 帧)
    this.MORPH = opts.morph ?? 1.4;        // 从"铺满"收成"封面板"
    /* 点云那一层(见着色器里的 GLINT):多少比例的粒子参与、浮多厚、多亮。 */
    /* 少而亮,不是多而匀:片子里那是一颗颗看得清的光点,不是一层白毛。
       参与的粒子只有 6%,但每颗更大更亮 —— 整块板的平均亮度因此没被抬起来。 */
    this.CLOUD = opts.cloud ?? 0.06;
    this.SPREAD = opts.spread ?? 0.55;
    this.GLINT = opts.glint ?? 1.25;
    this.DRIFT = opts.drift ?? 1.0;        // 机位飘动幅度(0 = 钉死正对)
    this.raf = 0; this.t = 0; this.last = 0;
    this.hasPhoto = false;
    this.photoAspect = 16 / 9;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'photo-particles';
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      display: 'block', zIndex: '0', pointerEvents: 'none',
    });
    host.insertBefore(this.canvas, host.firstChild);
    this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!this.gl) throw new Error('photo-particles needs WebGL2');
    /* 上下文丢了就**把这一层拆掉**,而不是留在那儿。
       这块画布是不透明的(alpha:false ——"没粒子的地方是黑"就是靠它),
       所以上下文一丢,留下的不是"效果没了",是**一块黑板盖住整张壁纸**。
       宁可回到原壁纸 + 引擎的粒子,也不能给人一块黑的。
       (不是假想:调试时反复重建这一层,浏览器到了上下文上限就直接回收最老的那个,
        gl.getError() 报 CONTEXT_LOST_WEBGL,画面全黑。) */
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      try { console.warn('[photo-particles] WebGL 上下文丢了,拆掉这一层'); } catch (e2) {}
      this.dispose();
    });
    this._init();
  }

  _init() {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p; this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); this.u[info.name] = gl.getUniformLocation(p, info.name); }
    this.vao = gl.createVertexArray();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._size();
  }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(2, Math.round((r.width || this.host.clientWidth || 1280) * dpr));
    this.H = Math.max(2, Math.round((r.height || this.host.clientHeight || 720) * dpr));
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.DPR = dpr;
    this._layout();
  }

  /** 板子多大、焦距多少、一颗点多少像素 —— 换了屏幕或换了壁纸都要重算。 */
  _layout() {
    this.halfW = 1.0;
    this.halfH = 1.0 / Math.max(0.2, this.photoAspect);
    /* 焦距按"最多占多宽 / 多高"两个上限定,板子的比例不变。
       'contain'(默认)取更紧的那个 —— 整块板都看得见,这是封面板要的。
       'cover' 取更松的那个 —— 板子铺满、超出的裁掉,窗口背景要的是这个:
       16:9 的壁纸装进 4:3 的窗口,contain 会在上下留两条黑边。 */
    const fW = (this.FILL_W * this.W * 0.5) * this.DIST / this.halfW;
    const fH = (this.FILL_H * this.H * 0.5) * this.DIST / this.halfH;
    this.F_END = this.FIT === 'cover' ? Math.max(fW, fH) : Math.min(fW, fH);
    /* 出场那一刻的焦距:**铺满整屏**(和桌面上那张壁纸逐像素同一个取景),
       于是"化开"的第一帧和原壁纸是重合的,看着才是同一张图长出了颗粒,
       而不是另一块板突然出现。之后再插值收到 F_END。 */
    const cW = (this.W * 0.5) * this.DIST / this.halfW;
    const cH = (this.H * 0.5) * this.DIST / this.halfH;
    this.F_START = Math.max(cW, cH);
    this.F = this.F_END;
    this._ptFor(this.F);
  }

  /** 一颗点该有多大 —— 跟着**当前**焦距走:板子在出场时铺满整屏、之后收小,
   *  点不跟着收的话,收到一半就开始互相盖,板子会比原图亮一截。
   *  系数 2.0 是量出来的:1.55 时板内平均亮度 67 / 原图 72(盖不满,缝里露黑)。 */
  _ptFor(F) {
    const platePx = 2 * F * this.halfW / this.DIST;
    this.ptPx = (platePx / this.GRID) * 2.0;
  }

  /** 图源和 mineradio 引擎同一个,所以两边在用户眼里是同一张桌面图。 */
  async loadPhoto(src) {
    let url = src;
    if (!url && typeof window !== 'undefined' && window.terse && window.terse.getDesktopPicture) {
      try { url = await window.terse.getDesktopPicture(); } catch (e) {}
    }
    if (!url) return false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 板子按**壁纸自己的比例**裁出来,不拉成方板。
    this.photoAspect = (img.naturalWidth || img.width || 16) / (img.naturalHeight || img.height || 9);
    this.hasPhoto = true;
    this._layout();
    return true;
  }
  setPhoto(src) { return this.loadPhoto(src); }

  /** 会话越忙,荡得越活 —— 可选,不接也能跑。 */
  setActivity(a) { this.act = Math.max(0, Math.min(1, +a || 0)); }
  setDim(v) { this.DIM = Math.max(0, Math.min(2, +v)); }

  _pass(bloomSize, bloomAmt, glowGate, layer) {
    const gl = this.gl;
    gl.uniform1f(this.u.uBloomSize, bloomSize);
    gl.uniform1f(this.u.uBloomAmt, bloomAmt);
    gl.uniform1f(this.u.uGlowGate, glowGate ? 1 : 0);
    gl.uniform1f(this.u.uLayer, layer ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.GRID * this.GRID);
  }

  /** 出场进度。返回 [fade(这层的不透明度), u(铺满→封面板 的形变进度)]。 */
  _reveal() {
    if (!this.REVEAL) return [1, 1];
    const S = (t) => t * t * (3 - 2 * t);          // 和片子里那条 S 曲线一样(不是 expo:
                                                   // expo 前几帧就掉掉一大半,读起来还是"切")
    const a = (this.t - this.HOLD) / this.DISSOLVE;
    const fade = a <= 0 ? 0 : (a >= 1 ? 1 : S(a));
    // 化开到一半就开始收 —— 两段完全排队的话中间会有一个"停住"的顿点
    const b = (this.t - this.HOLD - this.DISSOLVE * 0.5) / this.MORPH;
    const u = b <= 0 ? 0 : (b >= 1 ? 1 : S(b));
    return [fade, u];
  }

  draw() {
    const gl = this.gl;
    const [fade, u] = this._reveal();
    /* 这一层的淡入用 **CSS 不透明度**,不是在着色器里乘一个 alpha:
       画布是 alpha:false 的(要的就是"没粒子的地方是黑"),在里面调 alpha
       只会把粒子调暗,底下那张真壁纸照样被黑底盖着 —— 化开就无从谈起。 */
    if (this._fade !== fade) { this.canvas.style.opacity = String(fade); this._fade = fade; }
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);   // 全黑的空间
    if (!this.hasPhoto || fade <= 0) return;      // 没图就是一块黑,和没有这层一样
    // 铺满 → 封面板:两套焦距之间插值。粒子于是各自飞过去,整块板是**收**过去的。
    this.F = this.F_START + (this.F_END - this.F_START) * u;
    this._ptFor(this.F);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uPhoto, 0);
    gl.uniform2f(this.u.uViewport, this.W, this.H);
    gl.uniform1f(this.u.uHalfW, this.halfW);
    gl.uniform1f(this.u.uHalfH, this.halfH);
    gl.uniform1f(this.u.uF, this.F);
    gl.uniform1f(this.u.uD, this.DIST);
    /* 机位:两条不同周期的正弦,所以永远不会回到同一个姿势 —— 不是在"来回摇"。 */
    const d = this.DRIFT * u;
    gl.uniform1f(this.u.uYaw,   0.085 * d * Math.sin(this.t * 0.071));
    gl.uniform1f(this.u.uPitch, 0.045 * d * Math.sin(this.t * 0.053 + 1.7));
    gl.uniform1f(this.u.uTime, this.t);
    gl.uniform1f(this.u.uAlive, (this.opts.alive ?? 1.0) * (0.7 + 0.5 * (this.act || 0)));
    gl.uniform1f(this.u.uPtPx, this.ptPx);
    gl.uniform1f(this.u.uRelief, this.RELIEF * u);
    gl.uniform1i(this.u.uGrid, this.GRID);
    gl.uniform1f(this.u.uDim, this.DIM);
    gl.uniform1f(this.u.uSpread, this.SPREAD);
    gl.uniform1f(this.u.uCloudCut, 1.0 - this.CLOUD);
    gl.bindVertexArray(this.vao);
    // ① 板子本身(= 片子里的"床")
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._pass(1.0, 1.0, false, false);
    // ② 辉光:同一份几何再画一遍,点更大、加性、压低亮度(Mineradio 的做法)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    this._pass(2.6, 0.006, true, false);
    // ③ 浮在板子前面的点云 —— 片子里那层加性亮点。它有厚度,所以镜头一动就有视差。
    /* 化开的那一下让点云**炸亮一档**,过去之后落回常态。
       用户对片子的原话是「要亮、视觉震撼」——但常态不能亮:那会破坏"板里就是那张壁纸"。
       所以把劲儿全放在这一两秒的转场上,一个走过就散的驼峰。 */
    const burst = Math.max(0, 1 - Math.abs(u - 0.45) / 0.45);
    this._pass(1.0, this.GLINT * u * (1 + 1.7 * burst), false, true);
    gl.disable(gl.BLEND);
  }

  start(photo) {
    if (this.raf) return;
    // 隐藏一次再回来会再走一遍 start() —— 图已经在纹理里了,不必再取一次。
    if (!this.hasPhoto) this.loadPhoto(photo || this.opts.photo || null).catch(() => {});
    this.last = performance.now();
    const loop = (now) => {
      /* dt 钳到非负:rAF 的时间戳是**这一帧开始**的时刻,可能早于刚刚在这一帧里
         调的 performance.now(),那样第一帧的 dt 是负的 —— 荡漾会先往回走一段。 */
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000)); this.last = now;
      this.t += dt;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  resize() { this._size(); }
  /** 关掉 = 把这块 canvas 拆掉,底下原来那张壁纸就露出来了。 */
  dispose() {
    this.stop();
    try { this.canvas.remove(); } catch (e) {}
    const lose = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (lose) try { lose.loseContext(); } catch (e) {}
  }
}
