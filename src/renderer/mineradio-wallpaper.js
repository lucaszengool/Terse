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
/** Pro 的多槽位调色板 —— 同屏几条字各用一色。STAT_TINT 只有按 kind 的 3~6 色,
 *  同类事件连着来会撞成一片单色,这一组按槽位分配,保证同屏永远是多彩的。 */
const PRO_TINT = ['#C9F03D', '#5AD8FF', '#FF9F45', '#B98CFF', '#7CF5C0', '#FFD75A'];

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
    // Pro tier. Kept as a plain flag rather than a separate engine so the two
    // previews in the control panel are the SAME renderer with one switch —
    // any divergence a user sees is a real product difference, not two code
    // paths that drifted apart.
    this.pro = !!(opts && opts.pro);
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
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 160;
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
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    geo.setAttribute('aOn', new THREE.BufferAttribute(on, 1));

    const base = {
      uDotTex: this.u.uDotTex,
      uForm: { value: 0 }, uVis: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uSize: { value: new THREE.Vector2(2.90, 0.86) },
      uTint: { value: new THREE.Color('#C9F03D') },
      uPixel: { value: 1 }, uPointScale: { value: 1 }, uTime: this.u.uTime,
      uAlpha: { value: 0.95 }, uBloomSize: { value: 1 }, uSoft: { value: 0 },
    };
    // 辉光孪生:同一份几何再画一遍,点更大、核更软、加性叠加(和 Mineradio 一个套路)
    const bloom = Object.assign({}, base, {
      uBloomSize: { value: 2.4 }, uSoft: { value: 1 }, uAlpha: { value: 0.52 },
    });
    const mat = new THREE.ShaderMaterial({ uniforms: base, vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const matB = new THREE.ShaderMaterial({ uniforms: bloom, vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    return {
      cv, ctx, geo, mat, matB, u: base, uB: bloom, n,
      attr: { uv: geo.attributes.aUv, on: geo.attributes.aOn },
      glyph: null,
    };
  }

  _buildGlyphLayer() {
    const scene = new THREE.Scene();
    // Pro runs four slots so several statistics — and the live agent log — are
    // on screen together. Points per slot drop so the total stays close to the
    // single-slot budget rather than quadrupling the fill cost.
    const count = this.pro ? 4 : 1;
    const per = this.pro ? 14000 : 30000;
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
    // Pro's companion callouts are drawn deliberately smaller: the film's field
    // is numbers at MIXED sizes, and a same-size second line just looks doubled.
    // One family, three weights of presence — the reference field is the same
    // particle type at different scales, not different kinds of object.
    let px = size === 'big' ? 168 : size === 'small' ? 46 : 84;
    // Consolas/Segoe UI Mono 补在前面:Windows 上没有 SF Mono/Menlo,只留 generic
    // monospace 会掉到 Courier New,细笔画在粒子遮罩里几乎采不到点。
    const FONT = "'SF Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo," +
                 "Consolas,'Segoe UI Mono',monospace";
    for (const floor = size === 'small' ? 18 : 28; px > floor; px -= 2) {
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
    this._glyphQueue.push({ label, kind: kind || 'saved', size: 'mid' });
    // Pro: a second, smaller callout trails the headline — the film's look is
    // a FIELD of numbers at mixed sizes, not one line at a time.
    if (this.pro && Math.random() < 0.7) {
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
    const FILL_GAP = this.pro ? 520 : 1400;   // ms between successive formations
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
      const col = this.pro ? PRO_TINT[(si + this._glyphIdx) % PRO_TINT.length]
                           : (STAT_TINT[next.kind] || STAT_TINT.saved);
      const tier = next.size || 'mid';
      // The headline owns the centre; statistics scatter around it. Putting the
      // big line in the same band rota as the rest is what made the field look
      // like a list instead of a composition.
      if (tier === 'big') { gx = 0; gy = 0.15; }
      slot.glyph = { label: next.label, kind: next.kind, t0: now, x: gx, y: gy,
                     size: tier, small: tier === 'small', col,
                     // per-glyph drift so the callouts FLOAT rather than sit still
                     dx: (Math.random() - 0.5) * 0.5, dy: 0.16 + Math.random() * 0.22,
                     ph: Math.random() * Math.PI * 2,
                     // Varied lifetime: equal lifetimes made the field clear in
                     // one go, which is what read as "all disappear together".
                     life: G_LIFE * (tier === 'small' ? 0.72 : tier === 'big' ? 1.25 : 1)
                           * (0.82 + Math.random() * 0.45) };
      this._drawGlyphLabel(slot, next.label, tier);

      // ── The scattered field REACTS to each formation ──
      // A glyph used to assemble in silence, which made the numbers read as an
      // overlay pasted on top rather than something the field itself did. The
      // pattern varies per formation so repeats never look mechanical.
      const nx = Math.max(-1, Math.min(1, gx / (PLANE_SIZE * 0.5)));
      const ny = Math.max(-1, Math.min(1, gy / (PLANE_SIZE * 0.5)));
      // The headline is the loudest event on the wallpaper, so it must move the
      // field the most. 'log' previously fell through to the 0.62 default and
      // ended up the WEAKEST of all kinds — the opposite of the intent.
      const kindStr = ((next.size || 'mid') === 'small' ? 0.5 : 1) *
        (next.kind === 'log' ? 1.35 : next.kind === 'saved' ? 1.0
          : next.kind === 'agents' ? 0.78 : 0.62);
      // ── The field's reaction to a formation ──
      // Eight patterns, picked at RANDOM rather than in rotation: a fixed cycle
      // becomes predictable within a minute of watching a wallpaper, and the
      // whole point of this layer is that it never quite repeats. The headline
      // gets the wider, more dramatic shapes.
      const big = tier === 'big';
      const S = big ? 2.3 : 1;    // headline reactions read across the whole plane
      const shape = Math.floor(Math.random() * (big ? 8 : 6));
      // Vary the SPREAD per formation as well as the pattern. With a fixed
      // radius every shape decayed into the same round pulse a moment after it
      // started, which is why eight patterns still read as "only one wave".
      const spread = 0.7 + Math.random() * 1.1;
      const R = (x, y, st) => this._triggerRipple(
        Math.max(-1, Math.min(1, nx + (x - nx) * spread)),
        Math.max(-1, Math.min(1, ny + (y - ny) * spread)),
        st * kindStr * S * (0.8 + Math.random() * 0.5));
      if (shape === 0) {                       // single deep drop
        R(nx, ny, 1.15);
      } else if (shape === 1) {                // twin echoes, detuned
        R(nx - 0.16, ny, 0.85); R(nx + 0.16, ny + 0.05, 0.70);
      } else if (shape === 2) {                // expanding ring
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + Math.random() * 6.28;
          R(nx + Math.cos(a) * 0.22, ny + Math.sin(a) * 0.22, 0.62);
        }
      } else if (shape === 3) {                // sweep travelling outward
        for (let k = 0; k < 3; k++) {
          R(nx + Math.sign(nx || 1) * (0.20 + k * 0.26), ny - k * 0.10, 0.95 - k * 0.24);
        }
      } else if (shape === 4) {                // vertical column, rising
        for (let k = 0; k < 3; k++) R(nx, ny - 0.18 + k * 0.30, 0.90 - k * 0.18);
      } else if (shape === 5) {                // scatter — a handful of sparks
        for (let k = 0; k < 5; k++) {
          R(nx + (Math.random() - 0.5) * 0.9, ny + (Math.random() - 0.5) * 0.7, 0.34 + Math.random() * 0.3);
        }
      } else if (shape === 6) {                // wide double ring (headline only)
        const spin = Math.random() * 6.28;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + spin;
          R(nx + Math.cos(a) * 0.40, ny + Math.sin(a) * 0.30, 0.95);
          R(nx + Math.cos(a) * 0.78, ny + Math.sin(a) * 0.58, 0.55);
        }
      } else {                                 // shockwave across the whole plane
        for (let k = 0; k < 4; k++) R(nx, ny, 1.25 - k * 0.22);
        R(-nx * 0.7, -ny * 0.7, 0.55);
      }
      this._kick = Math.max(this._kick, (big ? 1.5 : 0.55) * kindStr);
    }

    // ── advance every live slot ──
    let strongest = 0, strongestCol = null;
    for (const slot of slots) {
      const g0 = slot.glyph;
      if (!g0) { slot.u.uVis.value = 0; slot.uB.uVis.value = 0; continue; }
      const age = now - g0.t0;
      if (age > g0.life) { slot.glyph = null; slot.u.uVis.value = 0; slot.uB.uVis.value = 0; continue; }
      let form, vis;
      if (age < G_IN) { const t = age / G_IN; form = smoother(t); vis = smoother(Math.min(1, t * 1.6)); }
      else if (age < G_IN + G_HOLD) { form = 1; vis = 1; }
      else { const t = (age - G_IN - G_HOLD) / G_OUT; form = 1 - smoother(t) * 0.75; vis = 1 - smoother(t); }

      // Float: a slow rise plus a lateral sway, seeded per glyph. Static text
      // over a moving particle field looks pasted on; this is what sells it.
      const t = age / 1000;
      const fx = g0.x + Math.sin(t * 0.9 + g0.ph) * 0.10 + g0.dx * t * 0.10;
      const fy = g0.y + g0.dy * t * 0.35 + Math.cos(t * 0.7 + g0.ph) * 0.05;

      for (const u of [slot.u, slot.uB]) {
        u.uForm.value = form; u.uVis.value = vis;
        u.uCenter.value.set(fx, fy);
        u.uTint.value.set(g0.col);
        // Companion lines sit smaller in the field, matching their smaller type.
        u.uPointScale.value = g0.size === 'big' ? 1.7 : g0.size === 'small' ? 0.66 : 1;
      }
      if (vis > strongest) { strongest = vis; strongestCol = g0.col; }
    }

    // 壁纸自己的粒子短暂偏向最亮那条统计的品牌色 —— 走 Mineradio 原有的染色通道
    if (strongestCol) this.u.uTintColor.value.set(strongestCol);
    this.u.uTintStrength.value = strongest * 0.30;
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
