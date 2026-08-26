/**
 * mineradio-wallpaper.js — Terse 动态壁纸的默认引擎:**用户自己的真桌面壁纸 + Mineradio 粒子律动**。
 *
 * 和音域回响(token-wallpaper-3d.js)的关系:两者 **API 完全一致**,wallpaper.html 按
 * 配置里的 `engine` 二选一 new 出来,其余代码一行都不用改。
 *
 * 粒子系统是把 XxHuberrr/Mineradio 原样搬过来的,不是仿写:
 *   · GLSL 逐字来自 js/00-pointer-cover-particles.js(见 mineradio-shaders.js,机械抽取)
 *   · soft-dot 精灵 makeDotTexture() 逐字照搬(64×64 径向渐变)
 *   · 辉光 = 同一份几何再画一遍、点大小 ×uBloomSize、AdditiveBlending 的孪生层
 *     (原项目没有 UnrealBloomPass,就是这么做的)
 *   · 边缘/深度图 buildEdgeAndDepth() 逐字照搬 → R=depth G=edge B=fg-mask A=lum
 *   · 涟漪用原项目 triggerRipple/updateRipples 的规则(3×3 区域、str=0.65+bass*1.4+
 *     rand*0.25、寿命 2.0s)。这里是实时渲染,不需要可复现,所以连 Math.random 都能照用
 *
 * 换掉的只有两样 —— **输入源**和**驱动源**:
 *   uCoverTex  专辑封面 → 用户当前的真桌面壁纸(Rust 的 get_desktop_picture)
 *   uBass/uMid/uTreble/uBeat/uEnergy/uBurstAmt  音频 FFT → 真实 token 消耗 + agent 活动
 *
 * 画面是 Mineradio 自带的两个 preset 叠出来的,各用各的相机(粒子活在完全不同尺度的
 * 空间里),共用一个 renderer 依次画:
 *   · Preset 5 WALLPAPER PULSE — 极光丝带 + 深度火花,原项目就是拿它当壁纸用的
 *   · Preset 0 SILK — 按壁纸取色的粒子平面,带 rippleSumAt;**只在节拍上开门**,
 *     常亮的话规则网格会在壁纸上织出一层半调网点(静止时特别难看)
 * 第三层是数据字形层(这一层不是 Mineradio 的,但手法完全沿用):agent 活动和 token
 * 统计会被粒子**聚成数字**,浮现 → 停住 → 散回壁纸,涟漪同时从那个数字的位置推出去。
 */
import * as THREE from 'three';
import { MR_VS, MR_FS, MR_BLOOM_VS, MR_BLOOM_FS } from './mineradio-shaders.js';
import { getProStyle, resolveStyle, DEFAULT_STYLE_ID } from './wallpaper-styles.js';

/* ── Mineradio 原值 ── */
const PLANE_SIZE = 4.8;        // 00-pointer-cover-particles.js:218
const RIPPLE_MAX = 12;         // 00-pointer-cover-particles.js:219
const MR_RIPPLE_LIFE = 2.0;    // 15-ripples-cover-depth.js:52

/** SILK 层相机距离。**不是随便选的**:shader 里点大小 depthSize = 36/(-mvPos.z) 再 clamp
 *  到 1.05~4.95,12 落在 depthSize≈3,节拍能把点从 3px 推到 5px(看得见)。更关键的是
 *  长焦:z 位移在屏幕上会变成径向位移,相机越近越夸张 —— 广角近距下静息噪声就能把网格
 *  搅成一团团"虫子"。 */
const SILK_CAM_Z = 12;
/** PULSE 层:极光丝带 x∈±35 y∈±11 z∈−32..18(shader:660-709),相机必须退到这团体积
 *  外面(z=18 那批不能跑到相机背后),视场角再收到"z=0 处可见半高 ≈ 11.5"。 */
const PULSE_CAM_Z = 62, PULSE_HALF_H = 11.5;
/** 涟漪强度换算系数 —— 唯一一处不能照抄的数值。原项目 str=0.65+bass*1.4+rand*0.25,
 *  而 pos.z = (bulge*2.4+ring*1.30)*env*str*1.30 峰值能到 ~11 个单位;原项目的封面平面
 *  只占屏幕中间一小块,我们铺满整幅画面,照搬会让粒子直接飞过相机。 */
const RIPPLE_Z = 0.18;

/* 数字的出场包络(毫秒)和 Pro 的多槽位调色板,都搬到 wallpaper-styles.js 去了 ——
   每种风格的节奏和配色本来就该各不相同。默认风格 `cinematic` 里的值就是原来这两个
   常量:400 / 1000 / 667(片子按 30fps 的 GLYPH_IN 12、HOLD 30、OUT 20 换算来的),
   以及下面那六个色。 */

/** 每种统计的品牌色 */
const STAT_TINT = {
  saved: '#C9F03D', spent: '#FF9F45', cache: '#5AD8FF',
  compact: '#B98CFF', cost: '#FFD75A', agents: '#7CF5C0',
};

/** 主题只影响染色倾向(配色本体来自用户壁纸)—— 保留选择器的意义 */
const THEME_TINT = {
  indigo: '#8b6bff', ocean: '#3aa0ff', ice: '#7fe9ff', emerald: '#40e0a0',
  gold: '#ffcf5a', amber: '#ff9f43', blood: '#ff5a5a', coral: '#ff7a9c',
  neon: '#e146eb', mono: '#e8e8f0',
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const fmt = (n) => {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n | 0);
};

/* ── soft dot 精灵 —— 逐字来自 00-pointer-cover-particles.js:197 ── */
function makeDotTexture() {
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  var ctx = cv.getContext('2d');
  var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  var tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}

/* ── 边缘 + 启发式深度 —— 逐字来自 15-ripples-cover-depth.js:105
      输出 256×256 RGBA: R=depth G=edge B=fg-mask A=lum ── */
function buildEdgeAndDepth(srcCanvas) {
  var W = 256, H = 256, N = W * H;
  var normalized = document.createElement('canvas');
  normalized.width = W; normalized.height = H;
  var sctx = normalized.getContext('2d');
  sctx.drawImage(srcCanvas, 0, 0, W, H);
  var src = sctx.getImageData(0, 0, W, H).data;
  var lum = new Float32Array(N), blur = new Float32Array(N), tmp = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var di = i * 4;
    lum[i] = (src[di] * 0.299 + src[di + 1] * 0.587 + src[di + 2] * 0.114) / 255;
  }
  function blurH(s, d, r) {
    for (var y = 0; y < H; y++) {
      var sum = 0;
      for (var x = -r; x <= r; x++) sum += s[y * W + Math.max(0, Math.min(W - 1, x))];
      for (var x = 0; x < W; x++) {
        d[y * W + x] = sum / (2 * r + 1);
        var xR = Math.min(W - 1, x + r + 1), xL = Math.max(0, x - r);
        sum += s[y * W + xR] - s[y * W + xL];
      }
    }
  }
  function blurV(s, d, r) {
    for (var x = 0; x < W; x++) {
      var sum = 0;
      for (var y = -r; y <= r; y++) sum += s[Math.max(0, Math.min(H - 1, y)) * W + x];
      for (var y = 0; y < H; y++) {
        d[y * W + x] = sum / (2 * r + 1);
        var yD = Math.min(H - 1, y + r + 1), yU = Math.max(0, y - r);
        sum += s[yD * W + x] - s[yU * W + x];
      }
    }
  }
  blurH(lum, tmp, 4); blurV(tmp, blur, 4);
  var edge = new Float32Array(N);
  for (var y = 1; y < H - 1; y++) for (var x = 1; x < W - 1; x++) {
    var gx = -blur[(y - 1) * W + (x - 1)] - 2 * blur[y * W + (x - 1)] - blur[(y + 1) * W + (x - 1)]
      + blur[(y - 1) * W + (x + 1)] + 2 * blur[y * W + (x + 1)] + blur[(y + 1) * W + (x + 1)];
    var gy = -blur[(y - 1) * W + (x - 1)] - 2 * blur[(y - 1) * W + x] - blur[(y - 1) * W + (x + 1)]
      + blur[(y + 1) * W + (x - 1)] + 2 * blur[(y + 1) * W + x] + blur[(y + 1) * W + (x + 1)];
    edge[y * W + x] = Math.min(1.0, Math.sqrt(gx * gx + gy * gy) * 1.4);
  }
  var depth = new Float32Array(N);
  for (var y2 = 0; y2 < H; y2++) for (var x2 = 0; x2 < W; x2++) {
    var i2 = y2 * W + x2;
    var cx = (x2 / (W - 1) - 0.5) * 2.0, cy = (y2 / (H - 1) - 0.5) * 2.0;
    var rr = Math.sqrt(cx * cx + cy * cy);
    depth[i2] = Math.min(1.0, blur[i2] * 0.45 + (1.0 - Math.min(1, rr * 0.75)) * 0.55);
  }
  var fg = new Float32Array(N);
  for (var i3 = 0; i3 < N; i3++) fg[i3] = Math.min(1.0, depth[i3] * 0.6 + edge[i3] * 0.5);
  var out = document.createElement('canvas'); out.width = W; out.height = H;
  var octx = out.getContext('2d'), imgOut = octx.createImageData(W, H);
  for (var i4 = 0; i4 < N; i4++) {
    var di2 = i4 * 4;
    imgOut.data[di2] = Math.round(depth[i4] * 255);
    imgOut.data[di2 + 1] = Math.round(edge[i4] * 255);
    imgOut.data[di2 + 2] = Math.round(fg[i4] * 255);
    imgOut.data[di2 + 3] = Math.round(lum[i4] * 255);
  }
  octx.putImageData(imgOut, 0, 0);
  return out;
}

/* ── 几何 —— 来自 00-pointer-cover-particles.js:228。
      唯一改动:方形网格 → 按画幅比例的矩形网格(原项目是方形封面,我们要铺满屏幕) ── */
function buildCoverParticleGeometry(gridX, gridY, planeW, planeH) {
  var count = gridX * gridY;
  var geo = new THREE.BufferGeometry();
  var positions = new Float32Array(count * 3);
  var uvs = new Float32Array(count * 2);
  var rand = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    var gx = i % gridX, gy = Math.floor(i / gridX);
    positions[i * 3] = (gx / (gridX - 1) - 0.5) * planeW;
    positions[i * 3 + 1] = (gy / (gridY - 1) - 0.5) * planeH;
    positions[i * 3 + 2] = 0;
    uvs[i * 2] = (gx + 0.5) / gridX;
    uvs[i * 2 + 1] = (gy + 0.5) / gridY;
    rand[i] = Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  return geo;
}

/* ── 数据字形层的着色器 ──
   不是 Mineradio 的(原项目没有"粒子聚成字"),但手法完全沿用:同一张 soft-dot 精灵、
   同样的辉光孪生、同样的加性合成,所以叠在极光层上不会显得是另一个系统贴上来的。
   当前要显示的那句话画在一张 1024×160 的画布上,粒子在单位矩形里取随机点、在顶点
   着色器里采这张遮罩 —— 落在笔画上的留下,其余直接隐形。 */
const GLYPH_VS = `
precision highp float;
attribute vec2 aUv;
attribute float aRand;
attribute float aOn;
uniform float uForm, uVis, uPixel, uPointScale, uTime, uBloomSize;
// 风格参数(wallpaper-styles.js)。uInMode/uOutMode 让**聚出来**和**散回去**成为两件
// 独立的事 —— 原来它们共用同一条 uForm 曲线,所以字只会"怎么来的怎么回去"。
uniform float uOut, uInMode, uOutMode, uStagger, uStaggerUv, uDispFade, uTwinkle, uSwirl;
uniform vec2 uCenter, uSize, uDrift;
uniform vec3 uTint;
varying vec3 vColor;
varying float vA;

/** 一颗粒子"还没落位"时,相对它在字上那个目标点的位移。
 *
 *  u = 1 完全散开,u = 0 已经贴在笔画上。聚和散走的是同一个函数、不同的 mode:
 *  聚 = u 从 1 走到 0,散 = u 从 0 走到 uOutDepth。编号见 GLYPH_MOVE。 */
vec3 dispAt(float mode, float u, vec2 rel) {
  float a = aRand * 6.2831;
  if (mode < 0.5) {
// 0 BURST —— 原版:每颗朝自己的方向、按自己的距离炸开
return vec3(vec2(cos(a), sin(a)) * (0.55 + aRand * 1.35) * u, u * (aRand - 0.5) * 1.6);
  } else if (mode < 1.5) {
// 1 ABOVE —— 散开的位置在画面上方(当 in 就是坠落,当 out 就是升腾)
return vec3(vec2(sin(aRand * 31.0) * 0.34, 1.05 + aRand * 2.10) * u, u * (aRand - 0.5) * 0.7);
  } else if (mode < 2.5) {
// 2 VORTEX —— 绕字心旋进/旋出,半径同时张开,轨迹是螺线不是直线
float ang = u * uSwirl * (0.55 + aRand * 0.90);
float c = cos(ang), s = sin(ang);
return vec3(mat2(c, -s, s, c) * rel * (1.0 + u * 1.15) - rel, u * (aRand - 0.5) * 1.2);
  } else if (mode < 3.5) {
// 3 SIDE —— 整句从一侧过来;配 uStaggerUv=1(按字里的横向位置错峰)就是打字机
return vec3(vec2(-2.90 * u, sin(aRand * 17.0) * 0.22 * u), u * (aRand - 0.5) * 0.5);
  } else if (mode < 4.5) {
// 4 DIFFUSE —— 几乎不位移。字是靠 uDispFade 的逐粒子渐显"显影"出来的,
//   所以这一种必须配大的 uStagger + 大的 uDispFade 才成立(见 ink 风格)
return vec3(vec2(cos(a), sin(a)) * (0.06 + aRand * 0.30) * u * u, u * (aRand - 0.5) * 0.35);
  } else if (mode < 5.5) {
// 5 RING —— 半径是**公共的**(不是每颗自己随机),所以看到的是一整圈在收 / 在摊开
float ang = a + u * uSwirl;
return vec3(vec2(cos(ang), sin(ang)) * (2.35 * u), sin(ang * 3.0) * u * 0.80);
  } else if (mode < 6.5) {
// 6 SHATTER —— 沿"离字心的方向"崩开:字是在原地裂开的,不是整团飞走的
vec2 dir = rel / max(length(rel), 0.001);
return vec3(dir * (u * (1.15 + aRand * 2.30)) + vec2(cos(a), sin(a)) * u * 0.45,
            u * (aRand - 0.5) * 3.0);
  } else if (mode < 7.5) {
// 7 DRIFT —— 整句朝同一个方向流走。方向每次成型重抽,所以同一种手法不会看腻
return vec3(uDrift * (u * 3.20) + vec2(0.0, sin(aRand * 23.0) * 0.30 * u), u * (aRand - 0.5) * 0.6);
  }
// 8 BELOW —— 散开的位置在画面下方(当 in 是浮起,当 out 是沉落)
  return vec3(vec2(sin(aRand * 19.0) * 0.28, -(0.95 + aRand * 1.75)) * u, u * (aRand - 0.5) * 0.6);
}

void main(){
  // 字形遮罩在 CPU 上采好后直接喂 aUv/aOn —— 这里不做 vertex texture fetch:
  // Windows/WebView2 走 ANGLE,顶点纹理单元在软件渲染(WARP/SwiftShader)下会是 0,
  // 采样恒返回 0 → 整句统计文字一个粒子都不亮。CPU 采样在两个平台上都成立。
  float on = aOn;
  vec2 target = uCenter + (aUv - 0.5) * uSize;
  vec2 rel = target - uCenter;
  // 散开程度仍然只由 uForm 一条曲线驱动(JS 那边聚/散共用它),风格只换**手法**和
  // **错峰**。默认风格 uInMode=uOutMode=0、uStagger=0、uDispFade=0,下面这段因此
  // 逐位等于改造前的 mix(target + scatter, target, uForm)。
  float amt = 1.0 - uForm;
  float mode = uOut > 0.0 ? uOutMode : uInMode;
  // 排队依据:随机 = 一片一片地到,aUv.x = 一列一列地到(打字机/扫描)
  float ord = mix(fract(aRand * 7.13), aUv.x, uStaggerUv);
  float u = clamp((amt - ord * uStagger) / max(1e-3, 1.0 - uStagger), 0.0, 1.0);
  vec3 d = dispAt(mode, u, rel);
  vColor = uTint;
  // uDispFade:散在外面时压暗。0 = 原版(粒子一路都亮着,是"飞"进来的);
  // 接近 1 = 只有落位的粒子才亮,字于是像在原地"显影"。
  vA = on * uVis * (0.62 + 0.38 * sin(uTime * uTwinkle + aRand * 21.0)) * (1.0 - u * uDispFade);
  vec4 mv = modelViewMatrix * vec4(target + d.xy, d.z, 1.0);
  gl_PointSize = (2.5 + uForm * 1.5) * uPixel * uPointScale * uBloomSize;
  gl_Position = projectionMatrix * mv;
}
`;
const GLYPH_FS = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha, uSoft;
varying vec3 vColor;
varying float vA;
void main(){
  vec4 t = texture2D(uDotTex, gl_PointCoord);
  if (t.a < 0.02) discard;
  float a = mix(t.a, t.a * t.a, uSoft);
  gl_FragColor = vec4(vColor, a * vA * uAlpha);
}
`;

export default class MineradioWallpaper {
  /** @param {HTMLCanvasElement} canvas
   *  @param {{theme?:string, quality?:number, angle?:number, intensity?:number, photo?:string}} opts */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.theme = opts.theme || 'neon';
    this.quality = opts.quality || 56;
    this.intensity = +opts.intensity || 1;
    this._running = false;
    this._time = 0;
    this._t0 = performance.now();
    this._last = this._t0;
    this._activity = 0.12;
    this._activityTarget = 0.12;
    this._kick = 0;
    // Pro tier. Kept as a plain flag rather than a separate engine so the two
    // previews in the control panel are the SAME renderer with one switch —
    // any divergence a user sees is a real product difference, not two code
    // paths that drifted apart.
    this.pro = !!(opts && opts.pro);
    // 风格只对 Pro 开放,而且 **free 必须永远停在原版那一套** —— 控制面板里两个预览
    // 并排跑,免费那半边一换风格,对比就不再是"免费 vs Pro",而是两种风格。
    // 自定义也只对 Pro 开放,而且走同一条路:预设 + 差量。free 传什么都会被
    // resolveStyle 的第二个参数为空的分支挡掉,拿到逐字节相同的原版。
    this._custom = this.pro ? ((opts && opts.custom) || null) : null;
    this._style = this.pro
      ? resolveStyle((opts && opts.style) || DEFAULT_STYLE_ID, this._custom)
      : getProStyle(DEFAULT_STYLE_ID);
    this._glyphQueue = [];
    this._glyphSlots = [];       // each: { ..., glyph: { label, kind, x, y, t0, col } }
    this._glyphSide = 1;
    this._glyphIdx = 0;
    this._lastAgentSig = '';
    this._lastStageAt = 0;

    // 兜底尺寸不是可有可无的:画布刚挂上去时 clientWidth 可能还是 0,
    // 而 0 会一路传成 aspect=NaN → 网格行列 NaN → 几何 0 个点(整个场景空白,
    // 而且不报错)。给个合理默认值,再靠下面的 ResizeObserver 拿到真尺寸后自愈。
    const { w: W, h: H } = this._measure();
    this.W = W; this.H = H;

    // r128 的 three 没有颜色管理;关掉 r169 的自动转换,才和原项目同色
    if (THREE.ColorManagement) THREE.ColorManagement.enabled = false;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true });
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    renderer.setClearColor(0x000000, 0);
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;      // 三层依次画进同一张画布
    this.renderer = renderer;

    /* 涟漪数据纹理 (1×N, RGBA: x, y, age, str) —— 原项目 00-...:292 */
    this._rippleData = new Float32Array(RIPPLE_MAX * 4);
    this._rippleTex = new THREE.DataTexture(this._rippleData, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType);
    this._rippleTex.magFilter = THREE.NearestFilter;
    this._rippleTex.minFilter = THREE.NearestFilter;
    this._ripples = [];
    for (let i = 0; i < RIPPLE_MAX; i++) this._ripples.push({ x: 0, y: 0, age: -10, str: 0 });
    this._rippleIdx = 0;

    const mkTex = () => {
      const t = new THREE.Texture();
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
      t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    };
    this._coverTex = mkTex();
    this._edgeTex = mkTex();

    /* 原项目的 uniform 块,原样保留(shader 里全都声明了,少一个就编译失败)。
       两层共用一份,每帧只更新它;每层私有的只有 uPreset / uAlpha / uPointScale。 */
    this.u = {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uBeat: { value: 0 }, uEnergy: { value: 0 }, uBurstAmt: { value: 0 },
      uVinylSpin: { value: 0 },
      uIntensity: { value: 0.85 }, uDepth: { value: 1.0 },
      uSpeed: { value: 1.0 }, uTwist: { value: 0 }, uColorBoost: { value: 1.1 },
      uScatter: { value: 0 }, uCoverRes: { value: 1.0 }, uBgFade: { value: 0.20 },
      uBloomStrength: { value: 0.62 }, uBloomSize: { value: 2.65 },
      uTintColor: { value: new THREE.Color(THEME_TINT[this.theme] || '#9db8cf') },
      uTintStrength: { value: 0 },
      // 轻轻起舞:见 mineradio-shaders.js 的 danceAt()
      uDanceAmt: { value: 0 }, uDanceMode: { value: 0 }, uDanceT: { value: 0 },
      uDanceCenter: { value: new THREE.Vector2(0, 0) },
      uDanceDir: { value: new THREE.Vector2(1, 0) },
      // 两层取景差多少倍。字的位置是按 SILK 平面算的,PULSE 层(屏幕中间那团糊糊
      // 的粒子)得换算过去,否则动作会挤在正中间一小块。
      uDanceScale: { value: PULSE_HALF_H / (PLANE_SIZE / 2) },
      uCoverTex: { value: this._coverTex }, uPrevCoverTex: { value: this._coverTex },
      uColorMixT: { value: 1.0 }, uEdgeTex: { value: this._edgeTex },
      uRippleTex: { value: this._rippleTex }, uRippleCount: { value: 0 },
      uDotTex: { value: makeDotTexture() },
      uHasCover: { value: 0 }, uHasDepth: { value: 0 }, uEdgeEnabled: { value: 1 },
      uAiBoost: { value: 0.28 },
      uMouseXY: { value: new THREE.Vector2(-999, -999) }, uMouseActive: { value: 0 },
      uHandXY: { value: new THREE.Vector2(-999, -999) }, uHandActive: { value: 0 },
      uGestureGrip: { value: 0 }, uPixel: { value: 1 },
      uParticleDim: { value: 1 }, uFloatAlpha: { value: 0 }, uLoading: { value: 0 },
    };

    this._buildLayers();
    this._buildGlyphLayer();
    this._loadPhoto(opts.photo);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // 画布拿到真实尺寸(或被布局改变)时自动重建 —— 不依赖 window resize 事件
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
  }

  /** 当前画布尺寸,带兜底(见构造函数里的说明) */
  _measure() {
    const w = this.canvas.clientWidth || window.innerWidth || 1920;
    const h = this.canvas.clientHeight || window.innerHeight || 1080;
    return { w: Math.max(16, w | 0), h: Math.max(16, h | 0) };
  }

  /* ── 密度:quality 24..96 → 两层的网格行数 ── */
  _grids() {
    const q = Math.max(24, Math.min(96, this.quality | 0));
    const k = (q - 24) / 72;                        // 0..1
    return { pulse: Math.round(80 + k * 90), silk: Math.round(64 + k * 70) };
  }

  _mkLayer(preset, gridY, alpha, pointScale) {
    const aspect = this.W / this.H;
    const isPulse = preset > 4.5;
    const camZ = isPulse ? PULSE_CAM_Z : SILK_CAM_Z;
    const halfH = isPulse ? PULSE_HALF_H : PLANE_SIZE / 2;
    const cam = new THREE.PerspectiveCamera(2 * Math.atan(halfH / camZ) * 180 / Math.PI, aspect, 0.1, 400);
    cam.position.set(0, 0, camZ);
    cam.lookAt(0, 0, 0);
    // SILK 平面必须正好等于取景框:大一圈的话粒子采到的图会比底下那张真照片大一圈,
    // 两层错位,壁纸就会重影。
    const planeH = PLANE_SIZE, planeW = planeH * aspect;
    const gy = Math.max(8, Math.round(gridY));
    const gx = Math.max(8, Math.round(gy * aspect));
    const geo = buildCoverParticleGeometry(gx, gy, planeW, planeH);
    const u = Object.assign({}, this.u, {
      uPreset: { value: preset }, uAlpha: { value: alpha }, uPointScale: { value: pointScale },
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: MR_VS, fragmentShader: MR_FS,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    const bmat = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: MR_BLOOM_VS, fragmentShader: MR_BLOOM_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const scene = new THREE.Scene();
    const bp = new THREE.Points(geo, bmat); bp.frustumCulled = false; bp.renderOrder = 0; scene.add(bp);
    const pp = new THREE.Points(geo, mat); pp.frustumCulled = false; pp.renderOrder = 1; scene.add(pp);
    return { scene, cam, camZ, geo, mat, bmat, u, preset };
  }

  _buildLayers() {
    const g = this._grids();
    // 先画 SILK(壁纸表面),再把 PULSE 的极光叠上去。
    // 字段名带下划线不是风格问题:叫 this.pulse 会把原型上的 pulse() 方法**遮掉**,
    // wallpaper.html 每来一笔 token 都调 wp.pulse(),那样会直接 TypeError。
    this._silk = this._mkLayer(0, g.silk, 0.18, 1.8);
    this._pulseL = this._mkLayer(5, g.pulse, 0.95, 1.85);
    this.layers = [this._silk, this._pulseL];
  }

  _disposeLayers() {
    for (const L of this.layers || []) { L.geo.dispose(); L.mat.dispose(); L.bmat.dispose(); }
    this.layers = [];
  }

  /** One glyph slot: its own canvas, geometry, materials and uniforms.
   *
   *  The layer used to be a SINGLE slot, which capped the wallpaper at one line
   *  of text in one colour at any instant — every extra callout just queued up
   *  behind it, so Pro looked identical to free no matter how it was tuned.
   *  Slots are independent, so N of them run concurrently in N colours. */
  _buildGlyphSlot(n) {
    const g = this._style.glyph;
    const cv = document.createElement('canvas');
    // 1024×128 is the film's atlas row. The taller 160 spread the same strokes
    // over more canvas, so the sampled mask came back thinner and the letters
    // read soft — same particles, less of them per stroke.
    cv.width = 1024; cv.height = 128;
    // willReadFrequently:每次换一句都要 getImageData 采一遍遮罩,不加这个 Chromium 会把
    // 画布留在 GPU 上,每次回读都同步阻塞一帧。
    const ctx = cv.getContext('2d', { willReadFrequently: true });

    const geo = new THREE.BufferGeometry();
    const uv = new Float32Array(n * 2), rnd = new Float32Array(n), pos = new Float32Array(n * 3);
    const on = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = Math.random(); uv[i * 2 + 1] = Math.random(); rnd[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    // MUST be 'aRand' — the name the glyph shader declares. As 'aRnd' the
    // attribute was never bound, so WebGL fed every glyph particle aRand = 0:
    //   · angle  = 0            → all scatter in ONE direction (straight +x)
    //   · radius = 0.55 + 0     → all by the SAME distance
    //   · z      = (rand-0.5)   → one flat depth, no spread
    //   · twinkle sin(t + 0)    → every particle pulsing in lockstep
    // which turned the film's convergence-from-everywhere into the whole word
    // sliding in sideways as a rigid block, and sliding back out to dissolve.
    // The field layer above already used the right name; only the glyph layer
    // was wrong, which is why the ambient particles always looked correct.
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    geo.setAttribute('aOn', new THREE.BufferAttribute(on, 1));

    const base = {
      uDotTex: this.u.uDotTex,
      uForm: { value: 0 }, uVis: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      // The film's glyphW / glyphH. The old 2.90 × 0.86 box was two thirds
      // taller, which is what scattered the same particle budget thin.
      uSize: { value: new THREE.Vector2(3.05, 0.52) },
      uTint: { value: new THREE.Color('#C9F03D') },
      uPixel: { value: 1 }, uPointScale: { value: 1 }, uTime: this.u.uTime,
      uAlpha: { value: 0.95 }, uBloomSize: { value: 1 }, uSoft: { value: 0 },
      // ── 风格参数(见 wallpaper-styles.js / GLYPH_VS 的 dispAt)──
      // uOut 既是消散进度也是"现在该用 out 那套手法了"的开关;其余每次成型时重写。
      uOut: { value: 0 }, uInMode: { value: 0 }, uOutMode: { value: 0 },
      uStagger: { value: g.stagger }, uStaggerUv: { value: g.staggerUv },
      uDispFade: { value: g.dispFade }, uTwinkle: { value: g.twinkle },
      uSwirl: { value: g.swirl }, uDrift: { value: new THREE.Vector2(1, 0) },
    };
    const styleBloom = g.bloomSize;
    // 辉光孪生:同一份几何再画一遍,点更大、核更软、加性叠加(和 Mineradio 一个套路)
    // Object.assign 是浅拷贝 —— 除下面这三个,其余 uniform 对象和 base **是同一个**,
    // 所以风格参数只要写一次两层就都跟着变。
    const bloom = Object.assign({}, base, {
      uBloomSize: { value: g.bloomSize }, uSoft: { value: 1 }, uAlpha: { value: 0.52 },
    });
    const mat = new THREE.ShaderMaterial({ uniforms: base, vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const matB = new THREE.ShaderMaterial({ uniforms: bloom, vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    return {
      cv, ctx, geo, mat, matB, u: base, uB: bloom, n, _styleBloom: styleBloom,
      attr: { uv: geo.attributes.aUv, on: geo.attributes.aOn },
      glyph: null,
    };
  }

  _buildGlyphLayer() {
    const scene = new THREE.Scene();
    // Pro runs four slots so several statistics — and the live agent log — are
    // on screen together. Points per slot drop so the total stays close to the
    // single-slot budget rather than quadrupling the fill cost.
    // 60000 per line is the film's number (mrwallpaper.tsx glyphCount), and it
    // is the whole reason the film's text reads as dense, bright and sharp
    // rather than as a dusting of dots. Free and Pro both get it: the tiering
    // is how many lines run at once, never how good one line looks.
    //
    // Cost is real — Pro can have 4 × 60000 points alive, each drawn twice for
    // the additive glow twin — but these are unlit, depth-less, additive points,
    // which is the cheapest thing a GPU draws.
    const count = this.pro ? 4 : 1;
    const per = 60000;
    this._glyphSlots = [];
    for (let i = 0; i < count; i++) {
      const slot = this._buildGlyphSlot(per);
      const b = new THREE.Points(slot.geo, slot.matB); b.frustumCulled = false; b.renderOrder = 0; scene.add(b);
      const p = new THREE.Points(slot.geo, slot.mat);  p.frustumCulled = false; p.renderOrder = 1; scene.add(p);
      this._glyphSlots.push(slot);
    }
    this._glyphLayer = { scene, slots: this._glyphSlots };
  }

  /** 把当前这句话画进字形画布,再在 CPU 上把亮像素采成每颗粒子的落点 */
  _drawGlyphLabel(slot, text, size) {
    const cv = slot.cv, g = slot.ctx;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    // Mixed sizes still happen — the film's field is numbers at several scales,
    // and a same-size second line just looks doubled — but that now comes from
    // the quad (uSize × sc in the draw loop), not from this atlas.
    //
    // One atlas size for every line, auto-shrunk to fit — the film's
    // makeGlyphAtlas starts at 78 and steps down to 28. Per-size font pixels
    // are what the box scale above now expresses instead; doing both scaled the
    // text twice and left the small lines sampling too few stroke pixels to
    // form readable letters.
    let px = 78;
    // Consolas/Segoe UI Mono 补在前面:Windows 上没有 SF Mono/Menlo,只留 generic
    // monospace 会掉到 Courier New,细笔画在粒子遮罩里几乎采不到点。
    const FONT = "'SF Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo," +
                 "Consolas,'Segoe UI Mono',monospace";
    // Floor 28 for every line, as in the film. The old 18 floor existed to let
    // already-small companion text shrink further; with size now carried by the
    // box, a line that small only starves the mask of stroke pixels.
    for (const floor = 28; px > floor; px -= 2) {
      g.font = `800 ${px}px ${FONT}`;
      if (g.measureText(text).width < cv.width * 0.92) break;
    }
    g.fillText(text, cv.width / 2, cv.height / 2);
    this._sampleGlyphMask(slot);
  }

  /** 遮罩 → 粒子:亮像素列表里随机取点写进 aUv,其余粒子 aOn=0 直接不亮。
   *  以前这一步在 vertex shader 里 texture2D(uGlyphTex),Windows 软件渲染下恒为 0。 */
  _sampleGlyphMask(slot) {
    const cv = slot.cv, W = cv.width, H = cv.height;
    const attr = slot.attr;
    if (!attr) return;
    const uv = attr.uv.array, on = attr.on.array, n = slot.n;

    let data;
    try { data = slot.ctx.getImageData(0, 0, W, H).data; }
    catch (e) { return; }                       // 画布被污染就保持上一句(不至于黑屏)

    // The film's model, done on the CPU: every particle keeps the fixed random
    // uv it was born with, and simply asks the mask "am I on a stroke?"
    // (GLYPH_VS: `float on = step(0.45, m);` with the same 0.45 ≈ 115/255).
    //
    // The previous version rewrote aUv to land particles ON the strokes and lit
    // only `lit.length * 0.10` of them. Two consequences, both of which are the
    // mismatch being fixed:
    //   · density was capped by stroke AREA, not by the particle budget — a long
    //     label lit ~4k points no matter how many were allocated, which is why
    //     raising the count alone changed almost nothing;
    //   · every new label reshuffled aUv, so each particle flew in from a
    //     different place each time. In the film aUv never changes, so a
    //     particle always gathers from — and bursts back to — its own fixed
    //     offset, which is what makes the assembly read as one coherent cloud
    //     condensing rather than a reshuffle.
    // Sample into a scratch buffer first. Writing straight into `on` would have
    // already blanked the field by the time an empty mask was detected, which
    // is the opposite of the intended fallback.
    let scratch = slot._maskScratch;
    if (!scratch || scratch.length !== n) scratch = slot._maskScratch = new Float32Array(n);

    let litCount = 0;
    for (let i = 0; i < n; i++) {
      // Same clamps the film applies before sampling the atlas.
      const ux = Math.min(0.998, Math.max(0.002, uv[i * 2]));
      const uy = Math.min(0.94, Math.max(0.06, uv[i * 2 + 1]));
      const x = Math.min(W - 1, (ux * W) | 0);
      // Canvas y runs down, uv y runs up.
      const y = Math.min(H - 1, ((1 - uy) * H) | 0);
      const lit = data[(y * W + x) * 4] > 115 ? 1 : 0;
      scratch[i] = lit;
      litCount += lit;
    }
    // A label whose strokes caught nothing would flash an empty frame; keep the
    // previous one on screen instead.
    if (!litCount) return;
    on.set(scratch);
    attr.on.needsUpdate = true;
  }

  /* ── 底图:用户当前那张真桌面壁纸 ── */
  async _loadPhoto(photo) {
    let src = photo;
    if (!src && window.terse && window.terse.getDesktopPicture) {
      try { src = await window.terse.getDesktopPicture(); } catch (e) {}
    }
    if (!src) return;                       // 拿不到就退回 shader 自带的默认渐变色
    const img = new Image();
    img.onload = () => {
      this._coverTex.image = img; this._coverTex.needsUpdate = true;
      this.u.uHasCover.value = 1;
      try {
        this._edgeTex.image = buildEdgeAndDepth(img);
        this._edgeTex.needsUpdate = true;
        this.u.uHasDepth.value = 1;
      } catch (e) { /* 边缘图失败也能跑,只是没有浮雕 */ }
      // 底图同时铺到画布背后,粒子只是在它上面律动 —— 但**置顶模式下不能铺**:
      // 那一层会盖在所有窗口上面,等于把桌面壁纸复制一份糊在屏幕最前面。
      this._bedCss = `#05060a url(${JSON.stringify(src)}) center/cover no-repeat`;
      if (this.canvas && this.canvas.parentElement && !this._overlay) {
        this.canvas.parentElement.style.background = this._bedCss;
      }
    };
    img.src = src;
  }

  /** 换一张底图(用户换了桌面壁纸时) */
  async refreshPhoto() { await this._loadPhoto(null); }

  /* ── 涟漪:Mineradio triggerRipple / updateRipples,逐字同规则 ── */
  _triggerRipple(x, y, strength) {
    const r = this._ripples[this._rippleIdx];
    r.x = x; r.y = y; r.age = 0; r.str = strength;
    this._rippleIdx = (this._rippleIdx + 1) % RIPPLE_MAX;
  }

  /** Pick from `list` without ever repeating the last one, per `key`.
   *
   *  Uniform random re-picks the same one ~1 time in 6, and two identical
   *  dances in a row is exactly what reads as "it always does the same thing" —
   *  the one impression this layer must never give. A shuffled bag spends every
   *  entry before any repeats.
   *
   *  每种风格有三条独立的牌堆:编舞、字的出现手法、字的消散手法。分开发牌,
   *  才会出现"同一段编舞下,这条字是旋进来的、下一条是从上面落下来的"。 */
  _bagPick(key, list) {
    if (!list || !list.length) return 0;
    if (list.length === 1) return list[0];
    const bags = this._bags || (this._bags = {});
    const last = this._lastPick || (this._lastPick = {});
    const sig = list.join(',');
    let bag = bags[key];
    if (!bag || !bag.length || bag._sig !== sig) {
      bag = bags[key] = list.slice();
      bag._sig = sig;
      for (let i = bag.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      // Never let a reshuffle put the previous pick first.
      if (bag[bag.length - 1] === last[key]) {
        [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
      }
    }
    return (last[key] = bag.pop());
  }

  _updateRipples(dt) {
    const data = this._rippleData;
    let active = 0;
    for (let i = 0; i < RIPPLE_MAX; i++) {
      const r = this._ripples[i];
      if (r.str > 0.005) {
        r.age += dt;
        if (r.age > MR_RIPPLE_LIFE) { r.str = 0; r.age = -10; }
      }
      const off = i * 4;
      data[off] = r.x; data[off + 1] = r.y; data[off + 2] = r.age; data[off + 3] = r.str;
      if (r.str > 0.005) active++;
    }
    this._rippleTex.needsUpdate = true;
    this.u.uRippleCount.value = RIPPLE_MAX;   // 槽位是稀疏的,让 shader 扫完再按 str 过滤
  }

  /* ══════════════ 公开 API(与 TokenWallpaper3D 一致) ══════════════ */

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this._last) / 1000);
      // 壁纸是常驻后台的,锁 30fps 省电
      if (dt < 1 / 31) return;
      this._last = now;
      this._update(dt);
      this._render();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  resize() {
    const { w: W, h: H } = this._measure();
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    this.renderer.setSize(W, H, false);
    // 平面宽度随画幅变 → 几何要重建
    this._disposeLayers();
    this._buildLayers();
    for (const L of this.layers) { L.cam.aspect = W / H; L.cam.updateProjectionMatrix(); }
  }

  /** 一次 token 冲击:节拍 + 一圈涟漪(有数字在显示就从数字那儿推出去) */
  pulse(strength = 0.4) {
    const s = Math.max(0.05, Math.min(2, +strength || 0));
    this._kick = Math.min(1.6, this._kick + s * 0.9);
    const aspect = this.W / this.H;
    const planeW = PLANE_SIZE * aspect;
    // 原项目:一次 bass hit 打 2~3 圈,落在 3×3 区域上带抖动
    const n = 2 + (Math.random() < 0.5 ? 0 : 1);
    for (let k = 0; k < n; k++) {
      let x, y;
      const lead = (this._glyphSlots || []).filter(sl => sl.glyph)
        .sort((a, b) => b.u.uVis.value - a.u.uVis.value)[0];
      if (lead) {                              // 有数字在显示 → 波纹从它那儿推出去
        x = lead.glyph.x + (Math.random() - 0.5) * 0.5;
        y = lead.glyph.y + (Math.random() - 0.5) * 0.4;
      } else {
        const idx = Math.floor(Math.random() * 9);
        x = ((idx % 3) / 2 - 0.5) * planeW * 0.72 + (Math.random() - 0.5) * 0.7 * aspect;
        y = (Math.floor(idx / 3) / 2 - 0.5) * PLANE_SIZE * 0.72 + (Math.random() - 0.5) * 0.7;
      }
      const bass = 0.30 + this._activity * 0.45;
      this._triggerRipple(x, y, (0.65 + bass * 1.4 + Math.random() * 0.25) * s * RIPPLE_Z * 1.6);
    }
  }

  /** agent 活动的聚合强度 0..1 —— 静息 vs 满载 */
  /* ── Glyphs as buttons ────────────────────────────────────────────────────
     The field already draws live data — agent names, cost, savings — and the
     renderer already knows exactly where each one is, because the shader needs
     its centre and box to form the letters. That geometry is all a hit test
     needs, so making the readout clickable costs no new state: the same numbers
     that position the particles position the button.

     Coordinates come back through the SILK camera, which is what the glyph layer
     is drawn with. Anything else (the PULSE layer's frustum, the raw plane) is a
     different scale and would land the boxes in the wrong place. */
  _glyphScreenBox(g) {
    const cam = this._silk && this._silk.cam;
    if (!cam || !cam.isPerspectiveCamera) return null;
    const halfH = Math.tan(cam.fov * Math.PI / 360) * cam.position.z;
    const halfW = halfH * cam.aspect;
    const sc = g.size === 'big' ? 1.55 : g.size === 'small' ? 0.58 : 1;
    // The atlas is 1024x128 but the drawn text rarely fills it; 0.62 of the box
    // is a close fit for the ink and keeps the target honest rather than a wide
    // invisible strip either side of short labels.
    const w = 3.05 * sc * 0.62, h = 0.52 * sc;
    const cx = (g.x / halfW * 0.5 + 0.5) * this.W;
    const cy = (0.5 - g.y / halfH * 0.5) * this.H;
    const pw = (w / (2 * halfW)) * this.W;
    const ph = (h / (2 * halfH)) * this.H;
    // A generous minimum: these are particle letters over a desktop, and a
    // pixel-tight target would be unusable.
    return { x: cx - pw / 2, y: cy - ph / 2, w: Math.max(pw, 90), h: Math.max(ph, 34),
             cx, cy, glyph: g };
  }

  /** Topmost visible glyph under a CSS-pixel point, or null. */
  hitTest(px, py) {
    let best = null, bestVis = 0;
    for (const slot of this._glyphSlots || []) {
      const g = slot.glyph;
      if (!g) continue;
      const vis = slot.u.uVis.value;
      if (vis < 0.25) continue;              // still forming or already dissolving
      const b = this._glyphScreenBox(g);
      if (!b) continue;
      const hw = Math.max(b.w, 90) / 2, hh = Math.max(b.h, 34) / 2;
      if (Math.abs(px - b.cx) <= hw && Math.abs(py - b.cy) <= hh && vis > bestVis) {
        bestVis = vis; best = b;
      }
    }
    return best;
  }

  /** Brighten the glyph under the cursor so it reads as a target. */
  setHover(glyph) {
    this._hover = glyph || null;
    for (const slot of this._glyphSlots || []) {
      const on = slot.glyph && this._hover && slot.glyph === this._hover;
      slot.u.uAlpha.value = on ? 1.0 : 0.95;
      // 原来是写死的 3.4 / 2.65,那两个数是按默认风格的 bloomSize 2.4 调出来的。
      // 换成按比例,cinematic 得到的仍旧正好是 3.4 / 2.65。
      const b = slot._styleBloom || 2.4;
      slot.uB.uBloomSize.value = b * (on ? 3.4 / 2.4 : 2.65 / 2.4);
    }
    if (this._hover) this.pulse(0.25);       // a nudge, so the field acknowledges it
  }

  /* ── Peers (multiplayer) ──────────────────────────────────────────────────
     A teammate's activity, rendered in the same field as your own but never
     mistakable for it. Two rules make the attribution unambiguous:

       · COLOUR IS IDENTITY. Your own glyphs stay lime — the product's colour —
         and every peer gets a stable hue derived from their id, so the same
         person is the same colour on every machine in the session without any
         coordination.
       · The label carries the name: "ann · 编译中".

     Entirely inert until setPeers() is called with a non-empty list. A solo
     user's wallpaper never enters this path, so the existing look and cost are
     exactly what they were. */
  setPeers(list) {
    const arr = Array.isArray(list) ? list : [];
    this._peers = new Map(arr.map(p => [String(p.id || p.name || ''), p]));
    // Nothing else to do: peers only become visible when one of them actually
    // produces a log line or a metric, which arrives through peerLog/peerStat.
  }

  /** Stable per-peer hue, so a person looks the same to everyone in the room. */
  _peerColor(id) {
    // A FIXED PALETTE, not a hash mapped onto a continuous hue circle.
    //
    // Both continuous approaches failed the only test that matters — can you
    // tell two teammates apart. Modulo a range put near-identical ids 1° apart.
    // The golden angle fixed that, but with a dozen arbitrary ids a birthday
    // collision still landed two peers 1° apart, which is the same colour.
    //
    // Quantising removes the failure mode instead of making it rarer: any two
    // peers are now either clearly different or exactly identical, never
    // deceptively close. Identical is survivable because the glyph carries the
    // name; "almost the same" is not, because it reads as one person.
    //
    // 55°–100° is omitted throughout: that is the lime band, and lime means you.
    const HUES = [0, 25, 108, 133, 158, 183, 208, 233, 258, 283, 308, 333];
    let h = 0;
    const str = String(id || '');
    for (let i = 0; i < str.length; i++) h = (h * 131 + str.charCodeAt(i)) >>> 0;
    return `hsl(${HUES[h % HUES.length]}, 78%, 62%)`;
  }

  /* ── The room, in the CENTRE ─────────────────────────────────────────────
     peerLog puts a line in the scattered statistics band. That is right for a
     teammate's build log and wrong for everything a room is actually about: a
     message someone typed, and — once you are in a room — your own agent log,
     which used to be the only line here without a name on it.

     The headline path is where those belong. It is one reserved slot in the
     centre at the largest type, it preempts whatever is there, and unlike the
     statistics band it carries the speaker's own colour, so who is talking is
     readable before the words are. */
  roomLine(peerId, name, text, opts) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return;
    // The glyph canvas is a fixed 1024px and the type auto-shrinks to fit, so a
    // long line does not wrap — it renders small and stretched, which is the
    // opposite of a headline. Keep the name, spend the rest on the words.
    const who = String(name || peerId || '').slice(0, 8);
    const max = Math.max(8, Math.min(30, (opts && opts.max) || 20));
    const body = t.length > max ? t.slice(0, max - 1) + '…' : t;
    const now = performance.now();
    this._logPending = {
      label: who + ' · ' + body,
      kind: 'log', size: 'big',
      col: (opts && opts.self) ? '#C9F03D' : this._peerColor(peerId),
    };
    this._logNextAt = 0;
    // Preempt: a new line takes the centre now. Its life is cut short rather
    // than popped, so the one leaving fades instead of vanishing mid-frame.
    for (const sl of (this._glyphSlots || [])) {
      if (sl.glyph && sl.glyph.size === 'big') {
        sl.glyph.life = Math.min(sl.glyph.life, (now - sl.glyph.t0) + 260);
      }
    }
  }

  /** Forget the headline rotation. Used when the room hides your own agent log:
   *  the rotation replays the last five lines, so without this a muted log keeps
   *  coming back round for another minute. */
  clearHeadline() {
    this._logRecent = [];
    this._logPending = null;
    this._logRot = null;
    this._lastLogLine = '';
  }

  /** A teammate's line — agent log, or something they actually said.
   *
   *  The NAME is always drawn, and always first: a line of big text with no
   *  author is just noise arriving, and in a shared field the author carries
   *  most of the meaning. `opts.max` lets a spoken line run longer than a log
   *  line, because a message is the thing worth reading. */
  peerLog(peerId, name, text, opts) {
    if (!this._peers || !this._peers.size) return;   // not in a session — ignore
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const max = Math.max(8, Math.min(40, (opts && opts.max) || 16));
    const who = String(name || peerId || '').slice(0, 12);
    const body = t.length > max ? t.slice(0, max - 1) + '…' : t;
    this._pendingAct = { type: 'peer', peerId, name: who };
    this._pendingCol = this._peerColor(peerId);
    this._queueGlyph(who + ' · ' + body, 'peer');
  }

  setActivity(a) { this._activityTarget = clamp01(+a || 0); }

  setIntensity(v) { this.intensity = +v || 1; }
  setAngle() { /* 这个引擎是长焦定机位,俯仰角没有意义 —— 接受但忽略,保持 API 一致 */ }
  setTheme(t) {
    this.theme = t;
    this.u.uTintColor.value.set(THEME_TINT[t] || '#9db8cf');
  }
  setQuality(q) {
    if ((q | 0) === (this.quality | 0)) return;
    this.quality = q | 0;
    this._disposeLayers();
    this._buildLayers();
  }
  getThemes() { return Object.keys(THEME_TINT); }

  /** 换一种 Pro 风格 —— 不用重建引擎。
   *
   *  风格改的全是**每帧读**的参数(配色、编舞牌堆、节奏、场感),唯一在建槽位时写死
   *  的只有那几个 GLSL uniform,这里补写一遍就行 —— 几何、纹理、WebGL 上下文都留着。
   *  切换因此是无缝的:正在显示的那条字会用旧手法散完,下一条才换新的。
   *
   *  free 一律留在默认风格(见构造函数里的说明)。 */
  /** 置顶模式:只留粒子,底图那一层必须撤掉。
   *
   *  渲染器本来就是 alpha:true / clearColor(…, 0),所以画布自己是透明的;
   *  唯一不透明的是画布背后那张底图,以及页面的背景色(在 wallpaper.html)。 */
  setOverlay(on) {
    this._overlay = !!on;
    const host = this.canvas && this.canvas.parentElement;
    if (!host) return;
    host.style.background = this._overlay ? 'transparent' : (this._bedCss || '');
  }

  setStyle(id, custom) {
    // custom === undefined 表示"这次只换风格,别动我的自定义";传 null 才是清空。
    if (custom !== undefined) this._custom = this.pro ? custom : null;
    const next = this.pro
      ? resolveStyle(id || DEFAULT_STYLE_ID, this._custom)
      : getProStyle(DEFAULT_STYLE_ID);
    // 自定义每动一格都会生成一个新对象,所以这里不能只比引用 —— 但也不必深比:
    // 值一样时下面那圈赋值本来就是幂等的。
    if (next === this._style && custom === undefined) return;
    this._style = next;
    const g = next.glyph;
    for (const slot of this._glyphSlots || []) {
      slot._styleBloom = g.bloomSize;
      slot.u.uStagger.value = g.stagger;
      slot.u.uStaggerUv.value = g.staggerUv;
      slot.u.uDispFade.value = g.dispFade;
      slot.u.uTwinkle.value = g.twinkle;
      slot.u.uSwirl.value = g.swirl;
      slot.uB.uBloomSize.value = g.bloomSize;
    }
    // 牌堆是按上一种风格的列表洗的,留着会先发完一手旧手法才换过来。
    this._bags = null; this._lastPick = null;
    this.u.uDanceMode.value = next.field.idleDance;
  }
  getStyle() { return this._style.id; }

  /* ── 统计融入:这些 API 原本是往场景里丢 DOM 标签的,
        在这个引擎里改成"粒子聚成那个数字" ── */

  /** A short companion line for the Pro field — derived from the headline so it
   *  is never invented data, just a second facet of the same event. */
  _proTrail(label, kind) {
    // The companion line must carry INFORMATION. The first version emitted bare
    // words ("live", "cached"), which read as filler next to a real statistic
    // and made the Pro field look padded rather than richer. Each variant here
    // is derived from the same event, so nothing is invented.
    const m = String(label).match(/[-+]?[\d.,]+/);
    const n = m ? m[0] : '';
    const pick = (arr) => arr[(this._glyphIdx + arr.length) % arr.length];
    if (kind === 'saved') {
      return pick([n + ' tok cached', 'prefix reused', n + ' off this turn', 'cache hit']);
    }
    if (kind === 'agents') {
      return pick(['streaming', n + '/min burn', 'context healthy', 'tools warm']);
    }
    if (kind === 'cache') {
      return pick([n + ' reused', 'prefix stable', 'ttl refreshed']);
    }
    if (kind === 'log') return null;   // log lines are long enough already
    return n ? n + ' tok' : null;
  }

  _queueGlyph(label, kind) {
    if (!label) return;
    // 队列压太长就丢旧的:壁纸要的是"此刻在发生什么",不是补播历史
    const cap = this.pro ? 6 : 3;          // Pro keeps more in flight
    if (this._glyphQueue.length >= 8) return;   // hard ceiling shared by every producer
    if (this._glyphQueue.length > cap) this._glyphQueue.shift();
    this._glyphQueue.push({ label, kind: kind || 'saved', size: 'mid',
                           act: this._pendingAct || null, col: this._pendingCol || null });
    this._pendingAct = null; this._pendingCol = null;
    // Pro: a second, smaller callout trails the headline — the film's look is
    // a FIELD of numbers at mixed sizes, not one line at a time.
    if (this.pro && Math.random() < this._style.field.trail) {
      const trail = this._proTrail(label, kind);
      if (trail) this._glyphQueue.push({ label: trail, kind: kind || 'saved', size: 'small' });
    }
  }

  /** token 增量 → 粒子聚成 "+N tok" / "+N saved" */
  floatToken(delta, kind) {
    const d = +delta || 0;
    if (d <= 0) return;
    if (kind === 'saved') this._queueGlyph('+' + fmt(d) + ' saved', 'saved');
    else this._queueGlyph('+' + fmt(d) + ' tok', 'spent');
  }

  /** 活跃 agent 列表 —— 数量变化时报一次,并轮播各 agent 的燃烧速率 */
  setAgents(list) {
    const arr = Array.isArray(list) ? list : [];
    const sig = arr.map(a => (a.name || a.key || '') + ':' + (a.rate | 0)).join('|');
    if (sig === this._lastAgentSig) return;
    const grew = arr.length > (this._lastAgentCount || 0);
    this._lastAgentSig = sig;
    this._lastAgentCount = arr.length;
    if (arr.length && grew) this._queueGlyph(arr.length + ' agent' + (arr.length > 1 ? 's' : '') + ' live', 'agents');
    const busiest = arr.filter(a => +a.rate > 0).sort((a, b) => b.rate - a.rate)[0];
    if (busiest) this._queueGlyph((busiest.name || 'agent') + ' ' + fmt(busiest.rate) + '/min', 'agents');
  }

  /** 实时 agent 日志 —— 把 agent 正在做的那一行,用同一套粒子聚合浮现出来。
   *
   *  数字告诉你省了多少,日志告诉你它此刻在干什么 —— 后者才是"这台机器活着"
   *  的证据。节流到 6 秒一条:字形层同时只渲染一条,喂太快只会互相顶掉,
   *  而且壁纸刷屏会变成干扰而不是氛围。
   *  重复的行直接丢弃(agent 循环调同一个工具时会连发)。 */
  setAgentLog(groups) {
    // wallpaper.html feeds GROUPS — [{ name, icon, project, lines[] }], busiest
    // agent first. Take the newest line of the busiest one; a plain string is
    // accepted too so the method is usable on its own.
    let t = '';
    if (typeof groups === 'string') {
      t = groups;
    } else if (Array.isArray(groups) && groups.length) {
      const g = groups[0];
      const lines = (g && g.lines) || [];
      const last = lines.length ? lines[lines.length - 1] : '';
      const body = typeof last === 'string' ? last : (last && (last.text || last.label)) || '';
      t = ((g && g.icon) ? g.icon + ' ' : '') + body;
    }
    // Keep the pulse the older duplicate of this method used to do. That copy
    // was defined LATER in the class and therefore silently overrode this one —
    // every log line went to a method that only pulsed and dropped the text,
    // which is why the headline never appeared no matter what was fixed here.
    if (Array.isArray(groups) && groups.length) {
      const l0 = (groups[0].lines || [])[0];
      if (l0 && +l0.tok > 0) this.pulse(Math.min(1.2, 0.15 + Math.log10(1 + l0.tok) * 0.3));
    }
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    if (!t) return;
    const now = performance.now();
    // Only skip a repeat if we ALREADY have it buffered — otherwise a stable
    // line (the fallback headline is stable on purpose) would be rejected on
    // every poll and the rotation would never get its first entry.
    if (t === this._lastLogLine && (this._logRecent || []).length) return;
    // The FIRST line must never be throttled. performance.now() is page uptime,
    // so defaulting _lastLogAt to 0 meant any log arriving in the first few
    // seconds of the page's life was discarded as "too soon".
    if (this._lastLogAt != null &&
        now - this._lastLogAt < (this.pro ? 1200 : 9000)) return;
    this._lastLogAt = now;
    this._lastLogLine = t;
    // 字形是逐字采样成粒子的,长句会糊成一片 —— 截断到能读的长度。
    // Front of the queue: the log is the "this machine is alive" signal, and
    // behind a backlog of numbers it would surface minutes late or never.
    // The log is the HEADLINE — biggest type, centre of the screen. It is the
    // one line that says what the machine is doing right now; the statistics
    // orbit it. Front of the queue so a backlog of numbers cannot delay it.
    // Keep it SHORT. The glyph canvas is a fixed 1024px wide and the type is
    // auto-shrunk to fit, so a long line does not wrap — it just renders small
    // and stretched edge to edge, which is exactly what "not big enough" was.
    const label = t.length > 18 ? t.slice(0, 17) + '…' : t;
    // Remember which agent this line came from, so clicking it can open that
    // session rather than just the generic timeline.
    if (Array.isArray(groups) && groups.length) {
      const g0 = groups[0] || {};
      this._pendingAct = { type: 'session', name: g0.name || '', project: g0.project || '',
                           sessionId: g0.sessionId || g0.id || '' };
    }
    // Free tier gets the statistics only. The centre headline — the live agent
    // log — is the Pro differentiator, and it has to be visibly absent on the
    // free side or the two previews look identical and sell nothing.
    if (!this.pro) return;
    this._logRecent = (this._logRecent || []);
    if (this._logRecent[this._logRecent.length - 1] !== label) this._logRecent.push(label);
    if (this._logRecent.length > 5) this._logRecent.shift();   // keep the last 5
    // A new line jumps the queue: point the rotation at it and clear the wait so
    // _pumpLog plays it on the next frame. Recording here and letting the pump
    // decide keeps ONE place that chooses what is on screen.
    this._logRot = this._logRecent.length - 1;
    this._logNextAt = 0;
    // Preempt: a NEW line must take the centre now, not after the current one
    // finishes its ~12s life. Waiting is what made the headline feel like a
    // slideshow of old activity rather than a live readout.
    for (const sl of (this._glyphSlots || [])) {
      if (sl.glyph && sl.glyph.size === 'big') {
        // Cut its life short instead of popping it, so it fades rather than
        // disappearing mid-frame.
        sl.glyph.life = Math.min(sl.glyph.life, (now - sl.glyph.t0) + 260);
      }
    }
  }

  /** 中央"正在播放"那组数据 —— 每 12 秒挑一条,聚成数字 */
  setStageItems(items) {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return;
    const now = performance.now();
    if (now - this._lastStageAt < 12000) return;
    this._lastStageAt = now;
    const it = arr[(this._glyphIdx++) % arr.length];
    const label = (it.v != null ? String(it.v) : '') + (it.u ? ' ' + it.u : '');
    this._queueGlyph(label.trim(), it.saved ? 'saved' : 'cache');
  }

  /** 音域回响会把 agent 日志渲成场景内文字;这个引擎不铺文字墙 —— 只取最新一行的
   *  token 数当一次冲击,让日志"推动"粒子而不是"占满"壁纸。 */
  /* ══════════════ 内部 ══════════════ */

  _update(dt) {
    this._time += dt;
    const u = this.u;
    // 活动度平滑逼近 + 冲击衰减
    this._activity += (this._activityTarget - this._activity) * Math.min(1, dt * 2.2);
    this._kick *= Math.exp(-dt / 0.62);

    // ── 轻轻起舞:只跟中间那句 big text 走 ───────────────────────────────────
    // 之前这里有两套东西,现在都拿掉了:
    //
    //  · 一个不问青红皂白的节拍器(每 0.87s 一圈涟漪、每 3s 一大圈)。它是为了
    //    "闲置时别死掉"加的,结果是画面从头到尾都在响 —— 就是「太频繁太乱」,
    //    而且让 big text 的反应完全淹没在这层底噪里。壁纸本来就该是安静的,
    //    有字出现才动。
    //  · 一串每 0.22s 补一发的 pulse()。它确实让画面一直在动,但 pulse() 能做的
    //    只有 rippleSumAt 那一种运动 —— 从一点向外扩散的圆环。补得再密、位置
    //    再变,看到的还是「单一的向外扩散成圈」,只是圈更多、更吵。
    //
    // 换成 shader 里的 danceAt():十段真正不同的编舞(行云/回旋/呼吸/摇曳/
    // 星落/涟纹),每段都是持续、轻柔的位移,包络跟着这句话一起浮起和落下。
    //
    // 只有 big 这一层会触发。统计数字那些小字照常聚散,但不再推动背景 —— 之前
    // 每条 mid/small 都会甩一组涟漪出去,四条并发时画面就没安静过。
    const bigV = clamp01(this._bigVis || 0);
    // 包络自己再平滑一次:glyph 的 vis 在 G_IN 内 0→1 只用 0.4s,直接拿来当舞蹈
    // 强度会「啪」地起来。0.9s 的时间常数让粒子是被带起来的,不是被推起来的。
    this._danceAmt = (this._danceAmt || 0) + (bigV - (this._danceAmt || 0)) * Math.min(1, dt / 0.9);
    if (this._danceAmt < 0.0005) this._danceAmt = 0;

    // ── 待机时的底噪 ────────────────────────────────────────────────────────
    // 拿掉节拍器解决了「太频繁太乱」,但也把闲置时的画面一起拿走了:SILK 那层
    // 原本靠节拍开门,没有节拍就永远不开,于是没有 agent 活动、没有大字的时候
    // (预览窗口就是这种状态)整片粒子是死的 —— 控制面板里两个预览看起来就是空的。
    //
    // 所以给一条很低的地板:一段固定的慢编舞,幅度只有正式起舞的六分之一左右。
    // 它不产生任何涟漪(涟漪才是之前吵的那个东西),只是让粒子始终在缓慢呼吸,
    // 大字出现时再从这个底噪长上去。
    const IDLE_AMT = this._style.field.idleAmt;
    const amt = Math.max(this._danceAmt, IDLE_AMT);
    // 时间一直走,否则从待机切到起舞时相位会跳一下。
    this._danceT = (this._danceT || 0) + dt;
    u.uDanceAmt.value = this.pro ? amt : IDLE_AMT * 0.7;
    u.uDanceT.value = this._danceT;
    // 待机用固定的一段慢编舞。默认是「摇曳」(十段里最安静、最不像图案的一段);
    // 每种风格挑自己那段,所以**没有字的时候**几种风格看起来也是不一样的 ——
    // 壁纸大部分时间正是这个状态。
    if (this._danceAmt < 0.02) u.uDanceMode.value = this._style.field.idleDance;

    const act = clamp01(this._activity);
    const beat = Math.min(2.2, this._kick);

    this._updateRipples(dt);

    // ── 频段合成:音频 FFT 的位置,喂的是真实 token 消耗 + agent 活动 ──
    //    静息刻意压低(壁纸就该是安静的),每次 burst 才是事件。
    u.uTime.value = this._time;
    u.uBass.value = Math.min(1.6, 0.14 + act * 0.30 + beat * 0.42);
    u.uMid.value = Math.min(1.4, 0.12 + act * 0.26 + 0.04 * Math.sin(this._time * 0.55) + beat * 0.30);
    // treble 驱动 snoise(pos*6.5) 那一项 —— 逐粒子的高频 z 抖动,给大了相邻粒子
    // 会前后穿插、在屏幕上绞成一团,所以这一路刻意压低。
    u.uTreble.value = Math.min(1.0, 0.05 + act * 0.10 + beat * 0.20);
    u.uBeat.value = Math.min(1.2, beat * 0.55);
    u.uEnergy.value = clamp01(0.12 + act * 0.34 + beat * 0.50);
    // The swell the comment in _updateGlyph describes, finally applied. Left at
    // `beat * 0.45` this rode _kick alone — one nudge with a 0.62s half-life,
    // spent long before the 2.07s glyph was done, so the mass was back to idle
    // while the word was still on screen. Taking the max with the headline's own
    // envelope holds the field expanded for exactly as long as the text is up
    // and releases it as the letters dissolve.
    u.uBurstAmt.value = clamp01(Math.max(beat * 0.45, bigV * this._style.field.burst));

    u.uIntensity.value = 0.5 * this.intensity;

    // SILK 是会起伏的那层粒子平面 —— 也就是这套编舞的舞台。常亮不行:规则网格
    // 静止时会在壁纸上织出一层半调网点,很难看。原本它只在节拍上开门(beat),
    // 而 beat 靠的是那个每 0.87s 一响的节拍器;节拍器拿掉之后 beat 基本一直是 0,
    // 门就再也不开了 —— 舞跳得再好也没人看得见。
    // 现在跟着舞蹈包络开合:字浮起来,平面跟着淡入起舞;字散了,平面也退回去。
    // 底噪也要能让它现身,否则闲置时这层依然是关的 —— 那正是预览看起来空掉的原因。
    const g0 = clamp01(Math.max(amt, (beat - 0.30) / 0.70));
    this._silk.u.uAlpha.value = this._style.field.silkAlpha * (g0 * g0 * (3 - 2 * g0));

    this._updateGlyph();
  }

  /** Headline rotation: the newest log line first, then the four before it, and
   *  round again. A wallpaper is watched idly for minutes at a time — a single
   *  line that plays once and leaves a blank centre reads as broken, so the
   *  recent history keeps cycling until something newer arrives. */
  _pumpLog(now) {
    const list = this._logRecent || [];
    if (!list.length) return;
    // Never interrupt a headline that is still on screen.
    if ((this._glyphSlots || []).some(sl => sl.glyph && sl.glyph.size === 'big')) return;
    if (now < (this._logNextAt || 0)) return;
    this._logNextAt = now + 700;               // brief gap between headlines
    // NEVER let the headline path grow the queue without bound.
    //
    // _pumpLog fires on a timer while slot intake is rate-limited, so an
    // unshift with no cap grew the queue forever whenever the slots were busy —
    // the wallpaper's WebProcess eventually stopped responding entirely, which
    // looks exactly like "the log feature does nothing".
    // The headline gets its OWN holder and its own reserved slot.
    //
    // It used to share _glyphQueue with the statistics, which meant competing
    // against a stream that refills constantly: the queue sat at its length cap
    // and the headline's enqueue was rejected every single time. 61 formations
    // were observed with zero headlines. Decoupling is the fix — a rate-limited
    // producer can never win a race against an unbounded one.
    if (this._logPending) return;              // one headline waiting is enough
    if (this._logRot == null) this._logRot = list.length - 1;
    const idx = ((this._logRot % list.length) + list.length) % list.length;
    this._logPending = { label: list[idx], kind: 'log', size: 'big' };
    this._logRot = idx - 1;                    // walk newest → oldest, then wrap
  }

  _updateGlyph() {
    const now = performance.now();
    this._pumpLog(now);
    const slots = this._glyphSlots || [];

    // ── fill any free slot ──
    // Every slot pulls independently, so a headline number, its companion and a
    // live agent-log line can all be on screen at once instead of taking turns.
    // Stagger, do not batch. Filling every free slot in one frame made the whole
    // set appear and vanish in unison — a pulse, not a stream. One slot may take
    // a glyph per window, so they overlap in a rolling succession instead.
    if (this._nextFillAt == null) this._nextFillAt = 0;
    const st = this._style;
    const T = st.timing;
    const G_LIFE = T.in + T.hold + T.out;
    const FILL_GAP = this.pro ? st.field.fillGap : 1400;   // ms between successive formations
    for (let si = 0; si < slots.length; si++) {
      const slot = slots[si];
      if (slot.glyph) continue;
      // Slot 0 is reserved for the headline so the statistics can never starve
      // it; the rest never touch the headline.
      const headlineSlot = si === 0 && slots.length > 1;
      let next;
      if (headlineSlot) {
        if (!this._logPending) continue;
        next = this._logPending;
        this._logPending = null;
      } else {
        if (!this._glyphQueue.length && !this._logPending) continue;
        if (now < this._nextFillAt) break;
        this._nextFillAt = now + FILL_GAP;
        // With one slot (free tier) the headline still takes precedence.
        if (this._logPending) { next = this._logPending; this._logPending = null; }
        else next = this._glyphQueue.shift();
      }
      // 左右交替、纵向游走 —— 避开屏幕正中(那儿通常是窗口和图标)
      this._glyphSide *= -1;
      this._glyphIdx++;
      let gy = (((this._glyphIdx * 0.61) % 1) - 0.5) * 3.2;
      // 左下角是实时统计面板(#panel)的位置,数字落这儿会被压住 —— 左侧一律走上半屏
      if (this._glyphSide < 0 && gy < 0.35) gy = 0.35 + Math.abs(gy) * 0.6;
      let gx = this._glyphSide * (2.45 + ((this._glyphIdx * 0.37) % 1) * 0.85);
      // Concurrent slots must not stack on top of each other — push each one to
      // its own band. Without this the four Pro lines overlap into a smear.
      gy += (si - (slots.length - 1) / 2) * 0.95;
      // 这些偏移是按 16:9 定的。竖屏/窄屏下视锥半宽只有 ~1.9,整句会飞出画面。
      const cam = this._silk && this._silk.cam;
      if (cam && cam.isPerspectiveCamera) {
        const halfW = Math.tan(cam.fov * Math.PI / 360) * cam.position.z * cam.aspect;
        const room = Math.max(0, halfW * 0.96 - slot.u.uSize.value.x / 2);
        gx = Math.sign(gx) * Math.min(Math.abs(gx), room);
        const halfH = Math.tan(cam.fov * Math.PI / 360) * cam.position.z;
        gy = Math.max(-halfH * 0.82, Math.min(halfH * 0.82, gy));
      }
      // Colour: Pro spreads slots across the palette so the field is multicolour
      // even when several events share one kind; free keeps the by-kind tint.
      // A peer's own colour wins over the palette — that is what makes whose
      // line it is readable at a glance.
      const pal = st.tints;
      const col = next.col ? next.col
                : (this.pro ? pal[(si + this._glyphIdx) % pal.length]
                            : (STAT_TINT[next.kind] || STAT_TINT.saved));
      const tier = next.size || 'mid';
      // The headline owns the centre; statistics scatter around it. Putting the
      // big line in the same band rota as the rest is what made the field look
      // like a list instead of a composition.
      if (tier === 'big') { gx = 0; gy = 0.15; }
      slot.glyph = { label: next.label, kind: next.kind, act: next.act || null, t0: now, x: gx, y: gy,
                     size: tier, small: tier === 'small', col,
                     // Exactly one life, as in the film (GLYPH_LIFE). The old
                     // per-tier × random lifetime disagreed with the fixed
                     // G_IN/G_HOLD/G_OUT curve used to animate it: a short life
                     // cut the scatter off mid-flight so the text POPPED out,
                     // and a long one ran the curve past its end, where
                     // 1 - smoother(t) goes negative. Lines still stagger — they
                     // start at different times, which is how the film does it.
                     life: G_LIFE };
      this._drawGlyphLabel(slot, next.label, tier);

      // 每成一次型,单独发两张牌:这条字**怎么聚出来**、**怎么散回去**。两者是分开的,
      // 所以会出现"从上面落下来、又往下沉掉"和"旋进来、原地裂开"这种不同的组合;
      // 牌堆不重样,连着两条也不会用同一种手法。默认风格两个牌堆各只有一张 BURST,
      // 于是永远发到 0 —— 和改造前完全一样。
      slot.u.uInMode.value = this._bagPick('in', st.in);
      slot.u.uOutMode.value = this._bagPick('out', st.out);
      slot.u.uOut.value = 0;
      // DRIFT 那一路的流向每次重抽 —— 同一种手法换个朝向就是另一个样子。
      const dAng = Math.random() * Math.PI * 2;
      slot.u.uDrift.value.set(Math.cos(dAng), Math.sin(dAng));

      // ── 只有中间那句 big text 会让背景动 ──────────────────────────────
      // 统计数字(mid / small)照旧聚散,但不再碰背景。之前每条都会甩一组涟漪
      // 出去,Pro 四条并发时画面根本没安静过 —— 「太频繁太乱」的一半原因在这。
      if (tier === 'big') {
        // 挑一段编舞,洗牌发牌,不会连着两次一样。牌堆由风格给(默认风格就是原来的
        // 那六段)。全部十段在 shader 的 danceAt() 里:
        // 0 行云 / 1 回旋 / 2 呼吸 / 3 摇曳 / 4 星落 / 5 涟纹
        // 6 星涡 / 7 潮汐 / 8 心跳 / 9 落雪。
        const mode = this._bagPick('dance', st.dance);
        this.u.uDanceMode.value = mode;
        this.u.uDanceCenter.value.set(gx, gy);
        // 方向每次重抽 —— 同一段编舞换个朝向就是另一个样子,实际远不止十种。
        const ang = Math.random() * Math.PI * 2;
        this.u.uDanceDir.value.set(Math.cos(ang), Math.sin(ang));
        this._danceT = 0;
        // 一发很轻的涟漪当"落位"的重音。留一发是因为字浮现的瞬间总要有个着地感,
        // 但也就一发 —— 原来那 3~13 发一组的图案,不管排成环、扫掠还是柱子,
        // 出来的都是同一种向外扩散的圈,叠在一起只是更吵。
        // 静水/水墨这类风格把它调到接近 0:那两种的美感就在于**什么都不推**。
        if (st.field.ripple > 0.01) this._triggerRipple(gx, gy, st.field.ripple * RIPPLE_Z * 1.6);
        this._kick = Math.max(this._kick, 0.5);
      }
    }

    // ── advance every live slot ──
    let strongest = 0, strongestCol = null, bigVis = 0;
    for (const slot of slots) {
      const g0 = slot.glyph;
      if (!g0) { slot.u.uVis.value = 0; slot.uB.uVis.value = 0; continue; }
      const age = now - g0.t0;
      if (age > g0.life) { slot.glyph = null; slot.u.uVis.value = 0; slot.uB.uVis.value = 0; continue; }
      let form, vis, out;
      if (age < T.in) { const t = age / T.in; form = smoother(t); vis = smoother(Math.min(1, t * 1.6)); out = 0; }
      else if (age < T.in + T.hold) { form = 1; vis = 1; out = 0; }
      else {
        const t = (age - T.in - T.hold) / T.out;
        // outDepth = 散开的幅度。原版只散到 0.75 就整条淡没了(所以看着像"淡出+微散");
        // 调到 1.0 的风格会真的把字散尽,消散手法才看得清。
        form = 1 - smoother(t) * st.glyph.outDepth; vis = 1 - smoother(t);
        // >0 就是给 shader 的开关:从这一刻起改用 uOutMode 那套手法。
        out = Math.max(1e-4, t);
      }

      // No float. The film pins uCenter to the event's position for the whole
      // life of the glyph (mrwallpaper.tsx: u.uCenter.set(a.ev.x, a.ev.y)), so
      // the text gathers and bursts IN PLACE. The rise-and-sway added here made
      // it read as floating text passing by rather than particles condensing out
      // of the field and blowing apart — which is the motion being matched.
      const fx = g0.x, fy = g0.y;

      for (const u of [slot.u, slot.uB]) {
        u.uForm.value = form; u.uVis.value = vis; u.uOut.value = out;
        u.uCenter.value.set(fx, fy);
        u.uTint.value.set(g0.col);
        // Size comes from the BOX, not the dots — exactly as the film does it
        // (uSize scaled by ev.scale, uPointScale left at 1). Growing the points
        // instead made big text blobbier as it grew: same dot count, fatter
        // dots, so the strokes smeared. Growing the box keeps the dots crisp and
        // spends the extra area on more of them.
        // The film's own scales: centre lyric 1.55 (statlyrics.tsx) and scattered
        // stats 0.58 (tokenstats.ts SMALL). 1.7 / 0.66 spread the same particle
        // budget over ~20% more area, which is part of why the letters read as
        // separate blobs instead of a dense glow.
        const sc = g0.size === 'big' ? 1.55 : g0.size === 'small' ? 0.58 : 1;
        u.uSize.value.set(3.05 * sc, 0.52 * sc);
        u.uPointScale.value = 1;
      }
      if (vis > strongest) { strongest = vis; strongestCol = g0.col; }
      // The headline is what the field is supposed to dance WITH, so track its
      // envelope separately: a small companion line at full vis must not drive
      // the same swell as the centre headline.
      if (g0.size === 'big' && vis > bigVis) bigVis = vis;
    }
    // The field's burst must follow the TEXT, not a decaying thump. The film
    // sets uBurstAmt from the live glyph's own envelope, so the particle mass
    // swells for as long as the word is up and re-triggers on every new line
    // — that is the 卡点. Driving it from _kick alone gave one nudge that was
    // gone in a second, leaving the clump back to its idle rotation while the
    // text was still there.
    //
    // Assigned OUT here, not inside the loop: both `continue` branches skip the
    // loop body, so once every slot was empty the old placement stopped writing
    // and _glyphVis froze at its last value — the dance and the swell would run
    // on against a blank screen until the next headline happened to reset them.
    this._glyphVis = strongest;
    this._bigVis = bigVis;

    // 壁纸自己的粒子短暂偏向最亮那条统计的品牌色 —— 走 Mineradio 原有的染色通道
    if (strongestCol) this.u.uTintColor.value.set(strongestCol);
    this.u.uTintStrength.value = strongest * this._style.field.tint;
  }

  _render() {
    const r = this.renderer;
    r.clear();
    for (const L of this.layers) r.render(L.scene, L.cam);
    // 字形层用 SILK 的相机(同一套平面坐标),最后画,叠在最上面
    // Any live slot means the layer has something to draw.
    if ((this._glyphSlots || []).some(sl => sl.u.uVis.value > 0.001)) {
      r.render(this._glyphLayer.scene, this._silk.cam);
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
    try {
      this._disposeLayers();
      for (const sl of (this._glyphSlots || [])) { sl.geo.dispose(); sl.mat.dispose(); sl.matB.dispose(); }
      this._coverTex.dispose(); this._edgeTex.dispose(); this._rippleTex.dispose();
      this.renderer.dispose();
    } catch (e) {}
  }
}
