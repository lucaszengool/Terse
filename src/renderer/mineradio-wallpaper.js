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

/** 数字的出场包络(毫秒) */
const G_IN = 420, G_HOLD = 1100, G_OUT = 700, G_LIFE = G_IN + G_HOLD + G_OUT;

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
uniform vec2 uCenter, uSize;
uniform vec3 uTint;
varying vec3 vColor;
varying float vA;
void main(){
  // 字形遮罩在 CPU 上采好后直接喂 aUv/aOn —— 这里不做 vertex texture fetch:
  // Windows/WebView2 走 ANGLE,顶点纹理单元在软件渲染(WARP/SwiftShader)下会是 0,
  // 采样恒返回 0 → 整句统计文字一个粒子都不亮。CPU 采样在两个平台上都成立。
  float on = aOn;
  vec2 target = uCenter + (aUv - 0.5) * uSize;
  float a = aRand * 6.2831;
  vec2 scatter = vec2(cos(a), sin(a)) * (0.55 + aRand * 1.35);
  vec2 p = mix(target + scatter, target, uForm);
  float z = (1.0 - uForm) * (aRand - 0.5) * 1.6;
  vColor = uTint;
  vA = on * uVis * (0.62 + 0.38 * sin(uTime * 2.6 + aRand * 21.0));
  vec4 mv = modelViewMatrix * vec4(p, z, 1.0);
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
    this._glyphQueue = [];
    this._glyph = null;          // { label, kind, x, y, t0 }
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

  _buildGlyphLayer() {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 160;
    this._glyphCanvas = cv;
    // willReadFrequently:每次换一句都要 getImageData 采一遍遮罩,不加这个 Chromium 会把
    // 画布留在 GPU 上,每次回读都同步阻塞一帧。
    this._glyphCtx = cv.getContext('2d', { willReadFrequently: true });

    const n = 30000;
    this._glyphN = n;
    const geo = new THREE.BufferGeometry();
    const uv = new Float32Array(n * 2), rnd = new Float32Array(n), pos = new Float32Array(n * 3);
    const on = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = Math.random(); uv[i * 2 + 1] = Math.random(); rnd[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    geo.setAttribute('aOn', new THREE.BufferAttribute(on, 1));
    this._glyphAttr = { uv: geo.attributes.aUv, on: geo.attributes.aOn };

    const base = {
      uDotTex: this.u.uDotTex,
      uForm: { value: 0 }, uVis: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uSize: { value: new THREE.Vector2(2.55, 0.44) },
      uTint: { value: new THREE.Color('#C9F03D') },
      uPixel: { value: 1 }, uPointScale: { value: 1 }, uTime: this.u.uTime,
      uAlpha: { value: 0.95 }, uBloomSize: { value: 1 }, uSoft: { value: 0 },
    };
    // 辉光孪生:同一份几何再画一遍,点更大、核更软、加性叠加(和 Mineradio 一个套路)
    const bloom = Object.assign({}, base, {
      uBloomSize: { value: 2.4 }, uSoft: { value: 1 }, uAlpha: { value: 0.52 },
    });
    this._gu = base; this._guB = bloom;
    const mat = new THREE.ShaderMaterial({ uniforms: base, vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const matB = new THREE.ShaderMaterial({ uniforms: bloom, vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const scene = new THREE.Scene();
    const b = new THREE.Points(geo, matB); b.frustumCulled = false; b.renderOrder = 0; scene.add(b);
    const p = new THREE.Points(geo, mat); p.frustumCulled = false; p.renderOrder = 1; scene.add(p);
    this._glyphLayer = { scene, geo, mat, matB };
  }

  /** 把当前这句话画进字形画布,再在 CPU 上把亮像素采成每颗粒子的落点 */
  _drawGlyphLabel(text) {
    const cv = this._glyphCanvas, g = this._glyphCtx;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    let px = 96;
    // Consolas/Segoe UI Mono 补在前面:Windows 上没有 SF Mono/Menlo,只留 generic
    // monospace 会掉到 Courier New,细笔画在粒子遮罩里几乎采不到点。
    const FONT = "'SF Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo," +
                 "Consolas,'Segoe UI Mono',monospace";
    for (; px > 30; px -= 2) {
      g.font = `800 ${px}px ${FONT}`;
      if (g.measureText(text).width < cv.width * 0.92) break;
    }
    g.fillText(text, cv.width / 2, cv.height / 2);
    this._sampleGlyphMask();
  }

  /** 遮罩 → 粒子:亮像素列表里随机取点写进 aUv,其余粒子 aOn=0 直接不亮。
   *  以前这一步在 vertex shader 里 texture2D(uGlyphTex),Windows 软件渲染下恒为 0。 */
  _sampleGlyphMask() {
    const cv = this._glyphCanvas, W = cv.width, H = cv.height;
    const attr = this._glyphAttr;
    if (!attr) return;
    const uv = attr.uv.array, on = attr.on.array, n = this._glyphN;

    let data;
    try { data = this._glyphCtx.getImageData(0, 0, W, H).data; }
    catch (e) { return; }                       // 画布被污染就保持上一句(不至于黑屏)

    // 亮像素索引表(步长 1,1024×160 一次扫完 ~0.5ms)
    const lit = [];
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        if (data[row + x * 4] > 115) lit.push(y * W + x);
      }
    }
    if (!lit.length) { on.fill(0); attr.on.needsUpdate = true; return; }

    // 点数跟着笔画面积走,长句不会稀、短句不会糊成一块实心
    const budget = Math.max(2500, Math.min(n, Math.round(lit.length * 0.10)));
    for (let i = 0; i < n; i++) {
      if (i < budget) {
        const p = lit[(Math.random() * lit.length) | 0];
        // 半像素抖动,免得粒子严格落在像素格上织出网点
        uv[i * 2]     = (((p % W) + Math.random()) / W);
        uv[i * 2 + 1] = 1 - (((p / W | 0) + Math.random()) / H);   // 画布 y 向下,uv y 向上
        on[i] = 1;
      } else {
        on[i] = 0;
      }
    }
    attr.uv.needsUpdate = true;
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
      // 底图同时铺到画布背后,粒子只是在它上面律动
      if (this.canvas && this.canvas.parentElement) {
        this.canvas.parentElement.style.background = `#05060a url(${JSON.stringify(src)}) center/cover no-repeat`;
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
      if (this._glyph) {                       // 有数字在显示 → 波纹从它那儿推出去
        x = this._glyph.x + (Math.random() - 0.5) * 0.5;
        y = this._glyph.y + (Math.random() - 0.5) * 0.4;
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

  /* ── 统计融入:这些 API 原本是往场景里丢 DOM 标签的,
        在这个引擎里改成"粒子聚成那个数字" ── */

  _queueGlyph(label, kind) {
    if (!label) return;
    // 队列压太长就丢旧的:壁纸要的是"此刻在发生什么",不是补播历史
    if (this._glyphQueue.length > 3) this._glyphQueue.shift();
    this._glyphQueue.push({ label, kind: kind || 'saved' });
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
  setAgentLog(groups) {
    if (!Array.isArray(groups) || !groups.length) return;
    const line = (groups[0].lines || [])[0];
    if (line && +line.tok > 0) this.pulse(Math.min(1.2, 0.15 + Math.log10(1 + line.tok) * 0.3));
  }

  /* ══════════════ 内部 ══════════════ */

  _update(dt) {
    this._time += dt;
    const u = this.u;
    // 活动度平滑逼近 + 冲击衰减
    this._activity += (this._activityTarget - this._activity) * Math.min(1, dt * 2.2);
    this._kick *= Math.exp(-dt / 0.62);
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
    u.uBurstAmt.value = clamp01(beat * 0.45);
    u.uIntensity.value = 0.5 * this.intensity;

    // SILK 只在节拍上现身 —— 常亮的话规则网格会在壁纸上织出半调网点
    const g0 = clamp01((beat - 0.30) / 0.70);
    this._silk.u.uAlpha.value = 0.18 * (g0 * g0 * (3 - 2 * g0));

    this._updateGlyph();
  }

  _updateGlyph() {
    const now = performance.now();
    if (!this._glyph && this._glyphQueue.length) {
      const next = this._glyphQueue.shift();
      // 左右交替、纵向游走 —— 避开屏幕正中(那儿通常是窗口和图标)
      this._glyphSide *= -1;
      this._glyphIdx++;
      let gy = (((this._glyphIdx * 0.61) % 1) - 0.5) * 3.2;
      // 左下角是实时统计面板(#panel)的位置,数字落这儿会被压住 —— 左侧一律走上半屏
      if (this._glyphSide < 0 && gy < 0.35) gy = 0.35 + Math.abs(gy) * 0.6;
      let gx = this._glyphSide * (2.45 + ((this._glyphIdx * 0.37) % 1) * 0.85);
      // 这些偏移是按 16:9 定的。竖屏/窄屏(竖着摆的显示器)下视锥半宽只有 ~1.9,
      // 整句会整个飞到画面外 —— 看起来就是"统计根本不出现"。按相机实际半宽夹一次。
      const cam = this._silk && this._silk.cam;
      if (cam && cam.isPerspectiveCamera) {
        const halfW = Math.tan(cam.fov * Math.PI / 360) * cam.position.z * cam.aspect;
        const room = Math.max(0, halfW * 0.96 - this._gu.uSize.value.x / 2);
        gx = Math.sign(gx) * Math.min(Math.abs(gx), room);
        const halfH = Math.tan(cam.fov * Math.PI / 360) * cam.position.z;
        gy = Math.max(-halfH * 0.82, Math.min(halfH * 0.82, gy));
      }
      this._glyph = { label: next.label, kind: next.kind, t0: now, x: gx, y: gy };
      this._drawGlyphLabel(next.label);
    }
    if (!this._glyph) {
      this._gu.uVis.value = 0; this._guB.uVis.value = 0;
      this.u.uTintStrength.value = 0;
      return;
    }
    const age = now - this._glyph.t0;
    if (age > G_LIFE) { this._glyph = null; this._gu.uVis.value = 0; this._guB.uVis.value = 0; return; }
    let form, vis;
    if (age < G_IN) { const t = age / G_IN; form = smoother(t); vis = smoother(Math.min(1, t * 1.6)); }
    else if (age < G_IN + G_HOLD) { form = 1; vis = 1; }
    else { const t = (age - G_IN - G_HOLD) / G_OUT; form = 1 - smoother(t) * 0.75; vis = 1 - smoother(t); }

    const col = STAT_TINT[this._glyph.kind] || STAT_TINT.saved;
    for (const g of [this._gu, this._guB]) {
      g.uForm.value = form; g.uVis.value = vis;
      g.uCenter.value.set(this._glyph.x, this._glyph.y);
      g.uTint.value.set(col);
    }
    // 壁纸自己的粒子也短暂偏向这条统计的品牌色 —— 走 Mineradio 原有的染色通道
    this.u.uTintColor.value.set(col);
    this.u.uTintStrength.value = vis * 0.30;
  }

  _render() {
    const r = this.renderer;
    r.clear();
    for (const L of this.layers) r.render(L.scene, L.cam);
    // 字形层用 SILK 的相机(同一套平面坐标),最后画,叠在最上面
    if (this._gu.uVis.value > 0.001) r.render(this._glyphLayer.scene, this._silk.cam);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
    try {
      this._disposeLayers();
      this._glyphLayer.geo.dispose(); this._glyphLayer.mat.dispose(); this._glyphLayer.matB.dispose();
      this._coverTex.dispose(); this._edgeTex.dispose(); this._rippleTex.dispose();
      this.renderer.dispose();
    } catch (e) {}
  }
}
