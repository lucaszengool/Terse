/* pdock-engine.js —— 会话栏的粒子引擎。**所有的字、图、按钮都是粒子。**
 *
 * 清晰的规则只有一条:粒子停下来的时候,一颗 = 一个物理像素,落在像素中心,
 * 颜色和透明度 = 那个像素本来的颜色和覆盖率。这样静止时和系统直接画出来的字
 * **逐像素相同**(对照实测:旧的随机撒法和系统字差 45.6%,这种 0.0%)。动起来的时候
 * 它们才是自由的粒子。
 *
 * 为什么不卡:
 *   - 每个"元素"(一张卡片、一行命令、一张图)自己一组 GPU 缓冲区。内容变了只重新
 *     光栅化这一个元素(一张小画布),不像旧版每次把整个窗口 getImageData 再重撒。
 *   - 粒子怎么飞完全在顶点着色器里算(起点、延迟、缓动、重力、吸入都是公式),
 *     CPU 每帧只改几个 uniform。
 *   - 没有任何东西在动的时候渲染循环停下(requestAnimationFrame 不再请求)。
 *   - 大块底色、图片、字的暗色光晕按 2×2 一颗撒,静止时点大 2 正好盖满一格:
 *     看起来是实心的,粒子数是 1/4。
 *
 * 用法:
 *   const f = new ParticleField(canvas);
 *   f.set('card1', raster(w, h, (g) => { ...Canvas2D 画... }), { x, y, enter: { mode: 'point', from: [bx, by] } });
 *   f.exit('card1', { mode: 'absorb', to: [x, y] });
 *   f.move('card1', x, y, 0.35);
 */

export const ENTER = { none: 0, scatter: 1, point: 2, rain: 3, assemble: 4 };
export const EXIT = { none: 0, absorb: 1, shatter: 2, dust: 3 };

const VS = `#version 300 es
precision highp float;
in vec2 aPos;      // 元素内的落点(物理像素;1×1 粒子是 x.5,2×2 粒子是格子中心)
in vec4 aColor;    // 那个像素本来的颜色(非预乘)
in float aSeed;    // 0..1 随机数(按坐标定);**负数 = 2×2 粒子**(光晕、底色),静止点大 2
in float aOrder;   // 0..1 阅读顺序(从左到右、从上到下)—— 扫入、逐字落下都靠它
uniform vec2 uView;              // 画布物理像素尺寸
uniform vec2 uOrigin;            // 元素左上角(物理像素,整数)
uniform float uTime;
uniform vec4 uEnter;             // mode, t0, dur, sweep(阅读顺序带来的额外延迟)
uniform vec2 uFrom;              // point 模式的起点 / rain 的落差
uniform vec4 uExit;              // mode, t0, dur, -
uniform vec2 uTo;                // absorb 的终点
uniform vec3 uTint;              // 入场/退场时的染色
uniform float uGlow;             // 1 = 本色;>1 提亮(hover / 新到)
uniform float uAlpha;            // 整体透明度
uniform vec4 uShimmer;           // 在跑:沿 x 走的一道亮带(速度, 宽度, 强度, 开关)
uniform float uStep;             // 整个元素的静止点大(稀疏元素 = 2)
uniform vec4 uFlow;              // 流动:开关, 速度, 弧度(物理像素), - —— 粒子从 uFrom 循环流向 uTo(氛围)
// ── 手势(没有手的时候全是"关",着色器走的路径和以前一模一样)──
uniform vec4 uHand;              // 手的力场:x, y, 半径, 强度(物理像素;强度 0 = 关)—— 粒子被手推开再弹回
uniform vec4 uLens;              // 放大镜:x, y, 半径, 倍数(1 = 关)
uniform vec3 uZoom;              // 整体缩放:倍数(1 = 关), 中心 x, y
uniform float uNoHand;           // 1 = 这个元素不受手影响(手的光标本身)
out vec4 vColor;

float h1(float n){ return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
float easeOut(float k){ return 1.0 - pow(1.0 - k, 3.0); }
float easeIn(float k){ return k * k * k; }

void main(){
  float sd = abs(aSeed);
  float rest = aSeed < 0.0 ? max(2.0, uStep) : uStep;
  vec2 target = uOrigin + aPos;
  vec2 pos = target;
  vec4 col = aColor;
  float size = rest;
  float a = 1.0;

  // ── 入场 ──
  float em = uEnter.x;
  if (em > 0.5) {
    float delay = aOrder * uEnter.w + sd * 0.12;
    float k = clamp((uTime - uEnter.y - delay) / uEnter.z, 0.0, 1.0);
    float e = easeOut(k);
    vec2 from = target;
    if (em < 1.5) {                       // scatter:从四周散开处聚回
      float ang = sd * 6.2831 * 13.0, r = 40.0 + h1(sd) * 160.0;
      from = target + vec2(cos(ang), sin(ang)) * r;
      pos = mix(from, target, e);
    } else if (em < 2.5) {                // point:从一个点(珠子)炸开成这个元素,走弧线
      float ang = sd * 6.2831 * 7.0, r = h1(sd * 3.1) * 6.0;
      from = uFrom + vec2(cos(ang), sin(ang)) * r;
      vec2 d = target - from;
      pos = mix(from, target, e) + vec2(-d.y, d.x) * (e * (1.0 - e)) * (sd - 0.5) * 0.7;
    } else if (em < 3.5) {                // rain:逐字从上方落下,带一点回弹
      from = target + vec2((h1(sd) - 0.5) * 24.0, -uFrom.y - h1(sd * 5.3) * uFrom.y);
      float b = k < 1.0 ? 1.0 - pow(2.0, -9.0 * k) * cos(k * 10.0) : 1.0;
      pos = mix(from, target, b);
    } else {                              // assemble:从右侧飞来聚成(新增的行)
      from = target + vec2(40.0 + h1(sd) * 120.0, (h1(sd * 2.7) - 0.5) * 60.0);
      pos = mix(from, target, e);
    }
    col.rgb = mix(uTint, col.rgb, smoothstep(0.55, 1.0, k));
    col.a = mix(max(col.a, 0.55), col.a, k);   // 飞行中的粒子都看得见
    size = mix(max(2.2, rest), rest, e);
    a *= smoothstep(0.0, 0.08, k);
  }

  // ── 退场 ──
  float xm = uExit.x;
  if (xm > 0.5) {
    float delay = aOrder * 0.18 + sd * 0.1;
    float k = clamp((uTime - uExit.y - delay) / uExit.z, 0.0, 1.0);
    if (xm < 1.5) {                       // absorb:被吸进某一点(允许 → 命令飞进会话)
      float e = easeIn(k);
      vec2 d = uTo - target;
      pos = mix(target, uTo, e) + vec2(-d.y, d.x) * sin(e * 3.1416) * (sd - 0.5) * 0.25;
      col.rgb = mix(col.rgb, uTint, k);
      size = mix(rest, max(2.0, rest), sin(k * 3.1416));
      a *= 1.0 - smoothstep(0.82, 1.0, k);
    } else if (xm < 2.5) {                // shatter:碎开往下掉(删掉的行 / 拒绝)
      float t = k * uExit.z;
      vec2 v = vec2((h1(sd) - 0.5) * 140.0, -60.0 - h1(sd * 1.7) * 90.0);
      pos = target + v * t + vec2(0.0, 900.0) * t * t;
      col.rgb = mix(col.rgb, uTint, min(1.0, k * 3.0));
      size = mix(rest, max(1.8, rest), min(1.0, k * 4.0));
      a *= 1.0 - smoothstep(0.35, 1.0, k);
    } else {                              // dust:原地风化飘散(完成 60 秒后 / 过滤掉)
      pos = target + vec2((h1(sd) - 0.3) * 50.0, -(20.0 + h1(sd * 4.1) * 40.0)) * easeOut(k);
      a *= 1.0 - k;
    }
  }

  // 在跑:一道亮带沿 x 扫过 —— 只改亮度,位置不动,所以字始终是清楚的
  if (uShimmer.w > 0.5) {
    float band = fract(uTime * uShimmer.x) * (uView.x * 0.5 + uShimmer.y * 2.0) - uShimmer.y;
    float d = abs(aPos.x - band) / uShimmer.y;
    col.rgb = mix(col.rgb, min(vec3(1.0), col.rgb * 1.6 + 0.1), uShimmer.z * max(0.0, 1.0 - d));
  }

  // ── 流动(氛围):一股粒子从 A 流到 B,走弧线,两头淡出 —— "这个会话正往燃料条里烧 token"
  if (uFlow.x > 0.5) {
    float ph = fract(sd * 7.31 + uTime * uFlow.y);
    vec2 dir = uTo - uFrom;
    vec2 nrm = normalize(vec2(-dir.y, dir.x) + vec2(1e-5));
    pos = mix(uFrom, uTo, ph) + nrm * sin(ph * 3.1416) * uFlow.z * (0.6 + 0.8 * h1(sd * 9.1));
    a *= sin(ph * 3.1416);
    size = 1.6 + h1(sd * 2.3);
  }

  // ── 手 ──
  if (uNoHand < 0.5) {
    if (uHand.w != 0.0) {           // 力场:手指周围的粒子被推开(强度为负 = 吸过来),离开后弹回原位
      vec2 d = pos - uHand.xy; float r = length(d) + 1e-3;
      float k = 1.0 - smoothstep(0.0, uHand.z, r);
      pos += d / r * k * k * uHand.z * 0.55 * uHand.w;
      col.rgb = mix(col.rgb, min(vec3(1.0), col.rgb * 1.5 + 0.12), k * 0.6);
    }
    if (uLens.w > 1.001) {          // 放大镜:中心放大、边缘平滑过渡;点跟着变大把空隙填上
      vec2 d = pos - uLens.xy; float r = length(d);
      float f = mix(uLens.w, 1.0, smoothstep(uLens.z * 0.35, uLens.z, r));
      pos = uLens.xy + d * f; size *= f;
    }
    if (uZoom.x != 1.0) { pos = uZoom.yz + (pos - uZoom.yz) * uZoom.x; size *= uZoom.x; }
  }

  col.rgb = min(vec3(1.0), col.rgb * uGlow);
  vColor = vec4(col.rgb, col.a * a * uAlpha);
  gl_PointSize = size;
  // 像素中心 → 裁剪空间。静止时 pos 恰好落在像素(或 2×2 格)中心,一颗粒子正好盖住它
  gl_Position = vec4(pos.x / uView.x * 2.0 - 1.0, 1.0 - pos.y / uView.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 o;
void main(){
  if (vColor.a < 0.004) discard;
  o = vec4(vColor.rgb * vColor.a, vColor.a);   // 预乘输出,配 ONE, ONE_MINUS_SRC_ALPHA
}`;

/** 用 Canvas2D 画一张"物理像素"的位图,返回 { w, h, data }。draw(g, dpr) 里按逻辑像素画即可。
 *
 * halo(默认开):给画出来的每一笔垫一圈暗色光晕。窗口的玻璃做得很透,背后可能是任何颜色
 * 的壁纸 —— 字的可读性不能指望玻璃,要字自己带着。做法:内容先画在一张画布上,再把它的
 * **影子**叠两遍(本体画到画布外,只留影子),最后把内容本体盖上去。光晕的像素也会变成
 * 粒子(2×2 一颗),和字一起飞、一起停。大块底色和图片传 { halo: false }。 */
export function raster(wCss, hCss, draw, opts = {}) {
  const dpr = opts.dpr || Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.ceil(wCss * dpr)), H = Math.max(1, Math.ceil(hCss * dpr));
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  // 两张画布都用 CPU 画布(willReadFrequently)。第一版 c1 是 GPU 加速画布,drawImage 到
  // CPU 画布 c 时要**同步把 GPU 内容读回 CPU** —— 每光栅化一次主线程就等一次 GPU。
  // 字都是 CoreGraphics 画的,CPU / GPU 画布画出来的像素一样。
  const c1 = mk(), g1 = c1.getContext('2d', { willReadFrequently: true });
  g1.scale(dpr, dpr); g1.textBaseline = 'top';
  draw(g1, dpr);
  const c = mk(), g = c.getContext('2d', { willReadFrequently: true });
  if (opts.halo !== false) {
    g.shadowColor = 'rgba(0,0,0,0.82)'; g.shadowBlur = 3.5 * dpr; g.shadowOffsetX = W; g.shadowOffsetY = 0.5 * dpr;
    g.drawImage(c1, -W, 0); g.drawImage(c1, -W, 0);
    g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
  }
  g.drawImage(c1, 0, 0);
  return { w: W, h: H, data: g.getImageData(0, 0, W, H).data, dpr };
}

/** 位图 → 粒子。两遍:先是"暗像素"(光晕 / 深色底)按 2×2 一颗,再是其余(字、线、亮色)
 * 按 step 一颗。暗的排在前面画,亮的字后画盖在上面 —— 光晕粒子的大点不会压暗字的边。
 * density < 1 时整张位图都按 2×2(大块底色、图片)。 */
let SCR = { cap: 0 };
function scratch(n) {
  if (n > SCR.cap) {
    const c = Math.max(4096, Math.ceil(n * 1.25));
    SCR = { cap: c, pos: new Float32Array(c * 2), col: new Uint8Array(c * 4), seed: new Float32Array(c), ord: new Float32Array(c) };
  }
  return SCR;
}
function toParticles(bmp, density) {
  const { w, h, data } = bmp;
  const step = density >= 1 ? 1 : Math.round(1 / Math.sqrt(density));
  const dark = (o) => data[o] < 48 && data[o + 1] < 48 && data[o + 2] < 48;
  let n = 0;
  for (let a = 3, end = w * h * 4; a < end; a += 4) if (data[a] > 6) n++;
  /* 复用同一套临时数组(只增不减),不再每次 new 四个 —— 悬停重画、光标、骨架都会频繁调到这里,
     每次几 MB 的新数组会触发周期性 GC 卡顿。返回的是视图,set() 里 bufferData 当场拷进 GPU,
     下一次调用再覆盖也没关系。 */
  const S = scratch(n), pos = S.pos, col = S.col, seed = S.seed, ord = S.ord;
  let i = 0;
  const push = (x, y, o, cell) => {
    pos[i * 2] = x + cell / 2; pos[i * 2 + 1] = y + cell / 2;
    col[i * 4] = data[o]; col[i * 4 + 1] = data[o + 1]; col[i * 4 + 2] = data[o + 2]; col[i * 4 + 3] = data[o + 3];
    // 随机数按坐标定:同一个像素每次都是同一颗粒子的"性格",重画不闪
    const s = Math.sin((x * 12.9898 + y * 78.233)) * 43758.5453, r = Math.max(1e-4, s - Math.floor(s));
    seed[i] = cell > 1 && step === 1 ? -r : r;       // 负号 = 这颗是 2×2 的
    ord[i] = (y / h) * 0.35 + (x / w) * 0.65;
    i++;
  };
  // 第一遍:暗像素(光晕),2×2 一颗
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = (y * w + x) * 4;
    if (data[o + 3] > 6 && dark(o)) push(x, y, o, 2);
  }
  // 第二遍:其余像素,step 一颗(稀疏元素里暗像素也走这一遍,统一 step)
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = (y * w + x) * 4;
    if (data[o + 3] <= 6 || (step === 1 && dark(o))) continue;
    if (step > 1 && dark(o) && x % 2 === 0 && y % 2 === 0) continue;   // 第一遍已经放过
    push(x, y, o, step);
  }
  return { n: i, step, pos: pos.subarray(0, i * 2), col: col.subarray(0, i * 4), seed: seed.subarray(0, i), ord: ord.subarray(0, i) };
}

export class ParticleField {
  constructor(canvas) {
    this.cv = canvas;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.prog = this._program(VS, FS);
    this.loc = {};
    for (const u of ['uView', 'uOrigin', 'uTime', 'uEnter', 'uFrom', 'uExit', 'uTo', 'uTint', 'uGlow', 'uAlpha', 'uShimmer', 'uStep', 'uFlow', 'uHand', 'uLens', 'uZoom', 'uNoHand']) this.loc[u] = gl.getUniformLocation(this.prog, u);
    /* 手势状态(逻辑像素)。全关 = 和没有手势功能时完全一样 */
    this.hand = null;      // { x, y, r, s }
    this.lens = null;      // { x, y, r, m }
    this.zoom = null;      // { s, x, y }
    /* 虚拟时钟:rate 调播放速度,frozen 定格。所有动效的时间都从这里来 */
    this.rate = 1; this.frozen = false; this._vt = 0; this._lr = performance.now();
    this.attr = { aPos: gl.getAttribLocation(this.prog, 'aPos'), aColor: gl.getAttribLocation(this.prog, 'aColor'), aSeed: gl.getAttribLocation(this.prog, 'aSeed'), aOrder: gl.getAttribLocation(this.prog, 'aOrder') };
    this.els = new Map();          // id → element
    this.order = [];               // 画的顺序(后画的在上面)
    this.t0 = performance.now();
    this.running = false;
    this.onFrame = null;           // 每帧回调(页面用来推进自己的动画)
    this.keepAlive = 0;            // 外部要求"这之前一直画"的时刻(秒)
    this.resize();
  }
  /** 虚拟时间(秒):按 rate 走,定格时停住 —— 粒子的入场、流动、亮带都跟着变速 / 停下 */
  now() {
    const r = performance.now();
    if (!this.frozen) this._vt += (r - this._lr) / 1000 * this.rate;
    this._lr = r;
    return this._vt;
  }
  setRate(r) { this.now(); this.rate = Math.max(0.05, Math.min(4, r)); this.wake(); }
  setFrozen(b) { this.now(); this.frozen = !!b; this.wake(); }
  /** 手势:null = 关 */
  setHand(h) { this.hand = h; this.wake(); }
  setLens(l) { this.lens = l; this.wake(); }
  setZoom(z) { this.zoom = z; this.wake(); }
  get dpr() { return Math.min(2, window.devicePixelRatio || 1); }

  resize() {
    const d = this.dpr, w = Math.round(this.cv.clientWidth * d), h = Math.round(this.cv.clientHeight * d);
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.wake();
  }

  /** 放一个元素(已有同 id 的就换内容)。opts: x, y(逻辑像素), enter:{mode, from:[x,y], dur, sweep, tint, delay, drop}, glow, alpha, shimmer, density, z */
  set(id, bmp, opts = {}) {
    const gl = this.gl, d = this.dpr;
    let el = this.els.get(id);
    if (!el) {
      el = { id, vao: gl.createVertexArray(), bufs: [gl.createBuffer(), gl.createBuffer(), gl.createBuffer(), gl.createBuffer()] };
      this.els.set(id, el); this.order.push(id);
    }
    const p = toParticles(bmp, opts.density ?? 1);
    gl.bindVertexArray(el.vao);
    const put = (i, arr, loc, size, type, norm) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, el.bufs[i]); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
    };
    put(0, p.pos, this.attr.aPos, 2, gl.FLOAT, false);
    put(1, p.col, this.attr.aColor, 4, gl.UNSIGNED_BYTE, true);
    put(2, p.seed, this.attr.aSeed, 1, gl.FLOAT, false);
    put(3, p.ord, this.attr.aOrder, 1, gl.FLOAT, false);
    gl.bindVertexArray(null);
    const t = this.now();
    Object.assign(el, {
      n: p.n, step: p.step, w: bmp.w / d, h: bmp.h / d,
      x: opts.x ?? el.x ?? 0, y: opts.y ?? el.y ?? 0,
      glow: opts.glow ?? 1, alpha: opts.alpha ?? 1, shimmer: opts.shimmer || null, z: opts.z ?? el.z ?? 0,
      flow: opts.flow || null,   // { from:[x,y], to:[x,y], speed, bow }(逻辑像素)
      noHand: !!opts.noHand,     // 手的光标本身不被手推开
      // 同一个 id 刚退场又被放回来(比如允许之后这张卡换成"在跑"):把"到点删除"清掉,
      // 否则新内容刚出现就会被旧的删除时刻带走
      exit: null, mv: null, dead: false, killAt: 0,
      enter: opts.enter ? { mode: ENTER[opts.enter.mode] || 0, t0: t + (opts.enter.delay || 0), dur: opts.enter.dur ?? 0.6, sweep: opts.enter.sweep ?? 0.25,
        from: (opts.enter.from || [0, 0]).map((v) => v * d), tint: opts.enter.tint || [1, 1, 1] } : null,
    });
    if (el.enter && el.enter.mode === ENTER.rain) el.enter.from = [0, (opts.enter.drop ?? 60) * d];
    this.order.sort((a, b) => (this.els.get(a).z || 0) - (this.els.get(b).z || 0));
    this.wake();
    return el;
  }
  has(id) { return this.els.has(id) && !this.els.get(id).dead; }
  get(id) { return this.els.get(id); }

  /** 退场:absorb(吸进 to)/ shatter(碎落)/ dust(风化)。结束后自动删掉。 */
  exit(id, { mode = 'dust', to = [0, 0], dur = 0.7, tint = [1, 1, 1], delay = 0 } = {}) {
    const el = this.els.get(id); if (!el || el.dead) return 0;
    const d = this.dpr;
    el.exit = { mode: EXIT[mode] || 3, t0: this.now() + delay, dur, to: to.map((v) => v * d), tint };
    el.dead = true;
    el.killAt = el.exit.t0 + dur + 0.35;
    this.wake();
    return el.killAt;
  }
  remove(id) {
    const el = this.els.get(id); if (!el) return;
    const gl = this.gl; gl.deleteVertexArray(el.vao); el.bufs.forEach((b) => gl.deleteBuffer(b));
    this.els.delete(id); this.order = this.order.filter((x) => x !== id);
  }
  /** 平移(整体,位置补间;停下时落在整数物理像素上,所以字依然清楚) */
  move(id, x, y, dur = 0.35) {
    const el = this.els.get(id); if (!el) return;
    if (dur <= 0) { el.x = x; el.y = y; el.mv = null; this.wake(); return; }
    el.mv = { x0: el.x, y0: el.y, x1: x, y1: y, t0: this.now(), dur };
    this.wake();
  }
  style(id, o) { const el = this.els.get(id); if (el) { Object.assign(el, o); this.wake(); } }
  /** 某段时间内保持渲染(页面自己的动画用) */
  holdUntil(t) { this.keepAlive = Math.max(this.keepAlive, t); this.wake(); }

  wake() { if (!this.running) { this.running = true; requestAnimationFrame((ts) => this._tick(ts)); } }

  _tick() {
    const t = this.now();
    if (this.onFrame) this.onFrame(t);
    // 两种"在动":过渡(入场/退场/平移)要 60fps 才顺;只剩氛围(在跑的亮带、珠子呼吸)
    // 就用 setTimeout 按 ambientFps 画 —— rAF 空转每秒 60 次,每一帧都把整个 app 进程
    // 叫醒一次(实测 terse 进程 497 次唤醒/秒,被系统点名,随后被强制退出)
    let trans = false, ambient = t < this.keepAlive;
    const gl = this.gl, d = this.dpr;
    gl.viewport(0, 0, this.cv.width, this.cv.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.uView, this.cv.width, this.cv.height);
    gl.uniform1f(this.loc.uTime, t);
    // 手的力场 / 放大镜 / 缩放:按"氛围"节奏画(会话栏展开时 30fps)。手的数据本来就是
    // 30fps 来的,60fps 重画只是把同一帧画两遍 —— 第一版这样,整块会话栏白白多烧一倍 GPU。
    const hd = this.hand, ln = this.lens, zm = this.zoom;
    gl.uniform4f(this.loc.uHand, hd ? hd.x * d : 0, hd ? hd.y * d : 0, hd ? (hd.r ?? 70) * d : 1, hd ? (hd.s ?? 1) : 0);
    gl.uniform4f(this.loc.uLens, ln ? ln.x * d : 0, ln ? ln.y * d : 0, ln ? (ln.r ?? 120) * d : 1, ln ? ln.m : 1);
    gl.uniform3f(this.loc.uZoom, zm ? zm.s : 1, zm ? zm.x * d : 0, zm ? zm.y * d : 0);
    if (hd || ln || (zm && zm.s !== 1)) ambient = true;
    for (const id of [...this.order]) {
      const el = this.els.get(id);
      if (el.killAt && t > el.killAt) { this.remove(id); continue; }
      if (el.mv) {
        const k = Math.min(1, (t - el.mv.t0) / el.mv.dur), e = 1 - Math.pow(1 - k, 3);
        el.x = el.mv.x0 + (el.mv.x1 - el.mv.x0) * e; el.y = el.mv.y0 + (el.mv.y1 - el.mv.y0) * e;
        if (k >= 1) el.mv = null; else trans = true;
      }
      // 静止时原点取整到物理像素(2×2 元素取整到偶数)—— 清晰的前提
      const snap = (v) => { const q = el.step > 1 ? 2 : 1; return Math.round(v * d / q) * q; };
      const ox = el.mv ? el.x * d : snap(el.x), oy = el.mv ? el.y * d : snap(el.y);
      gl.uniform2f(this.loc.uOrigin, ox, oy);
      const en = el.enter;
      if (en) {
        gl.uniform4f(this.loc.uEnter, en.mode, en.t0, en.dur, en.sweep);
        gl.uniform2f(this.loc.uFrom, en.from[0], en.from[1]);
        gl.uniform3f(this.loc.uTint, ...en.tint);
        if (t < en.t0 + en.dur + en.sweep + 0.15) trans = true; else el.enter = null;
      } else gl.uniform4f(this.loc.uEnter, 0, 0, 1, 0);
      const ex = el.exit;
      if (ex) {
        gl.uniform4f(this.loc.uExit, ex.mode, ex.t0, ex.dur, 0);
        gl.uniform2f(this.loc.uTo, ex.to[0], ex.to[1]);
        gl.uniform3f(this.loc.uTint, ...ex.tint);
        trans = true;
      } else gl.uniform4f(this.loc.uExit, 0, 0, 1, 0);
      const fl = el.flow;
      if (fl && !ex) {
        gl.uniform4f(this.loc.uFlow, 1, fl.speed ?? 0.6, (fl.bow ?? 18) * d, 0);
        gl.uniform2f(this.loc.uFrom, fl.from[0] * d, fl.from[1] * d);
        gl.uniform2f(this.loc.uTo, fl.to[0] * d, fl.to[1] * d);
        ambient = true;
      } else gl.uniform4f(this.loc.uFlow, 0, 0, 0, 0);
      gl.uniform1f(this.loc.uNoHand, el.noHand ? 1 : 0);
      gl.uniform1f(this.loc.uStep, el.step || 1);
      gl.uniform1f(this.loc.uGlow, el.glow);
      gl.uniform1f(this.loc.uAlpha, el.alpha);
      const sh = el.shimmer;
      if (sh) { gl.uniform4f(this.loc.uShimmer, sh.speed ?? 0.5, (sh.width ?? 60) * d, sh.strength ?? 0.5, 1); ambient = true; }
      else gl.uniform4f(this.loc.uShimmer, 0, 1, 0, 0);
      gl.bindVertexArray(el.vao);
      gl.drawArrays(gl.POINTS, 0, el.n);
    }
    gl.bindVertexArray(null);
    if (trans) requestAnimationFrame((ts) => this._tick(ts));
    else if (ambient) setTimeout(() => this._tick(), 1000 / (this.ambientFps || 30));
    else this.running = false;
  }

  /** 统计(调试 / 验证用) */
  stats() { let n = 0; for (const el of this.els.values()) n += el.n; return { elements: this.els.size, particles: n, running: this.running }; }

  _program(vs, fs) {
    const gl = this.gl, mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
}
