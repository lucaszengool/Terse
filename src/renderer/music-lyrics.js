/**
 * music-lyrics.js —— 壁纸上的**粒子歌词**(音乐模式)。
 *
 * 和 agent 那条粒子字是**两条独立的通道**:各自一块画布、各自开关,可以同时开。
 *
 * ── 为什么推翻了 2D canvas 那一版 ───────────────────────────────────────
 * 第一版用 2D canvas 一颗颗 `arc()` 画,一句词最多 5200 颗 —— 用户的评价是
 * "质感不够、不够密集",对。引擎里那条 agent 粒子字**每句 6 万颗**
 * (mineradio-wallpaper.js 的 `_buildGlyphLayer`:`per = 60000`,注释原话:
 * "这就是它读起来密、亮、锐利而不是一撮点的原因")。6 万次 `arc()` 画不动,
 * 所以这一版改成 WebGL 点渲染,并且**照抄引擎的做法**:
 *
 *   · 每颗粒子有一个**固定的随机 uv**,在顶点着色器里采这一句词的遮罩图;
 *     采到笔画上就留下、采不到就隐形 —— 换一句词只是换一张遮罩纹理,
 *     CPU 一帧都不用重算位置(第一版每换一句都要在 JS 里重采几千个点)。
 *   · soft-dot:径向衰减的圆点(引擎是一张 64×64 的径向渐变贴图,这里直接算)。
 *   · **辉光孪生层**:同一份几何再画一遍,点更大、加性、压暗 —— 引擎也是这么做的。
 *
 * ⚠ 这是壁纸窗口里第三个 WebGL 上下文(引擎、壁纸粒子板、这一层)。
 *   所以和粒子板一样留了两道保险:`webglcontextlost` 直接拆掉这一层;
 *   画出来是空的(上下文"活着但不画")也拆掉 —— 它是透明画布,拆掉只是少一层,
 *   不会在屏幕上留黑块。
 */

import { resolveMusicStyle } from './music-style.js';

const ATLAS_W = 2048, ATLAS_H = 256;   // 一句词的遮罩图
const BASE_COUNT = 60000;              // 密度 1 = 和 agent 粒子字同一档

const VS = `#version 300 es
precision highp float;
in vec2 aUv;          // 这颗粒子在遮罩图里的固定位置
in float aRand;
uniform sampler2D uMask;
uniform vec2 uViewport;
uniform vec4 uBand;    // 字在屏幕上的矩形:cx, cy, w, h
uniform float uTime, uForm, uDot, uBreath, uBloom, uPixel;
out float vRand, vU, vOn;
void main(){
  float m = textureLod(uMask, aUv, 0.0).a;
  vOn = step(0.5, m);
  vRand = aRand; vU = aUv.x;
  // 目标点:遮罩图的 uv 映射到屏幕上那块矩形
  vec2 tgt = vec2(uBand.x + (aUv.x - 0.5) * uBand.z,
                  uBand.y + (aUv.y - 0.5) * uBand.w);
  /* 入场:每颗从两侧飞进来,起飞时刻按 aRand 错开 —— 字是**长出来**的,
     不是整块平移过来。uForm 0→1 是这一句的成型进度。 */
  float stagger = clamp((uForm - aRand * 0.45) / 0.55, 0.0, 1.0);
  float e = stagger * stagger * (3.0 - 2.0 * stagger);
  vec2 from = vec2(aRand < 0.5 ? -uViewport.x * 0.12 : uViewport.x * 1.12,
                   tgt.y + (aRand - 0.5) * uViewport.y * 0.25);
  vec2 p = mix(from, tgt, e);
  // 到位之后在目标点附近呼吸(幅度小:歌词是拿来读的)
  float ph = aRand * 6.2831;
  p += vec2(cos(uTime * 0.8 + ph), sin(uTime * 1.1 + ph)) * uBreath * e * uPixel;
  gl_Position = vec4(p.x / uViewport.x * 2.0 - 1.0, 1.0 - p.y / uViewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = max(1.0, uDot * uPixel * uBloom) * (vOn > 0.5 ? 1.0 : 0.0);
}`;

const FS = `#version 300 es
precision highp float;
in float vRand, vU, vOn;
uniform vec3 uColor, uHighlight;
uniform float uSweep, uAlpha, uFade, uGlowAmt;
uniform vec2 uTextU;        // 字在遮罩图里的左右边界(u 坐标)
out vec4 o;
void main(){
  if (vOn < 0.5) discard;
  float d = length(gl_PointCoord - 0.5);
  // soft dot:中间实、边上化开(引擎那张 64×64 径向渐变贴图的等价物)
  float a = smoothstep(0.5, 0.08, d);
  if (a <= 0.004) discard;
  /* 跟着唱:已经唱过的那半截用高亮色、亮一档。±5% 的软边 ——
     硬切那道线像一把刀扫过去,软边才像声音正走到这儿。 */
  /* ⚠ 要按**字的实际范围**归一化,不是按整张遮罩图。短句只占图中间一小条,
     按整图算的话那道光会先在空白里扫半天才碰到第一个字。 */
  float tu = clamp((vU - uTextU.x) / max(0.001, uTextU.y - uTextU.x), 0.0, 1.0);
  float sung = clamp((uSweep - tu) / 0.05 + 0.5, 0.0, 1.0);
  vec3 c = mix(uColor, uHighlight, sung);
  // 边缘渐隐:长句顶到屏幕边上时不硬切
  float edge = uFade > 0.001
    ? smoothstep(0.0, uFade, tu) * (1.0 - smoothstep(1.0 - uFade, 1.0, tu)) : 1.0;
  float bright = (0.55 + 0.45 * sung) * (0.75 + 0.5 * vRand);
  o = vec4(c * bright * uGlowAmt, a * uAlpha * edge);
}`;

/* ── 星河(歌词光粒):绕着字横着流过去的一条 ── */
const SVS = `#version 300 es
precision highp float;
in float aSeed;
uniform vec2 uViewport;
uniform vec4 uBand;
uniform float uTime, uFlow, uPixel, uBeat;
out float vA;
float hash(float n){ return fract(sin(n) * 43758.5453123); }
void main(){
  float speed = 0.030 + hash(aSeed * 1.71) * 0.055;      // 原项目的量级
  float flow = fract(hash(aSeed * 2.13) + uTime * speed * uFlow);
  float lane = floor(hash(aSeed * 5.1) * 5.0);
  float curve = sin(flow * 6.2831853 * (0.92 + hash(aSeed * 4.0) * 0.46) + aSeed * 0.071 + uTime * 0.34);
  float x = flow * (uViewport.x + 160.0) - 80.0;
  float y = uBand.y + (lane - 2.0) * uBand.w * 0.22 + curve * uBand.w * 0.30;
  // 两头淡进淡出 —— 不然星星会在画面边上"啪"地出现
  float edge = smoothstep(0.0, 0.18, flow) * (1.0 - smoothstep(0.82, 1.0, flow));
  vA = edge * (0.35 + 0.65 * hash(aSeed * 8.0)) * (0.6 + 0.4 * uBeat);
  gl_Position = vec4(x / uViewport.x * 2.0 - 1.0, 1.0 - y / uViewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = (1.0 + hash(aSeed * 3.3) * 2.2) * uPixel * (1.0 + uBeat * 0.5);
}`;
const SFS = `#version 300 es
precision highp float;
in float vA;
uniform vec3 uColor;
out vec4 o;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d) * vA;
  if (a <= 0.004) discard;
  o = vec4(uColor, a);
}`;

export default class MusicLyrics {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.style = resolveMusicStyle(opts.style);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'music-lyrics';
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      display: 'block', zIndex: String(opts.zIndex ?? 2), pointerEvents: 'none',
    });
    host.appendChild(this.canvas);        // 歌词在最前面:引擎的粒子在它后面
    // ⚠ alpha 必须 true:这一层压在引擎前面,不透明的话会把引擎整个盖掉
    this.gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, premultipliedAlpha: true });
    if (!this.gl) throw new Error('music-lyrics needs WebGL2');
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.dispose(); });
    this.state = null; this.lineIdx = -1; this.formT = 0;
    this.t = 0; this.last = 0; this.raf = 0; this._checked = 0;
    this.audio = { bass: 0, beat: 0 };
    this._atlas = document.createElement('canvas');
    this._atlas.width = ATLAS_W; this._atlas.height = ATLAS_H;
    this._actx = this._atlas.getContext('2d', { willReadFrequently: false });
    this._init();
    this._onResize = () => this._size();
    window.addEventListener('resize', this._onResize);
  }

  _prog(vs, fs) {
    const gl = this.gl;
    const mk = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
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

  _init() {
    const gl = this.gl;
    this.pGlyph = this._prog(VS, FS);
    this.pStar = this._prog(SVS, SFS);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._buildBuffers();
    this._size();
  }

  /** 粒子的随机 uv / 种子。密度一改就重建(只在改设置时发生,不是每帧)。 */
  _buildBuffers() {
    const gl = this.gl;
    const n = this.count = Math.max(2000, Math.round(BASE_COUNT * (this.style.density || 1)));
    const uv = new Float32Array(n * 2), rnd = new Float32Array(n);
    for (let i = 0; i < n; i++) { uv[i*2] = Math.random(); uv[i*2+1] = Math.random(); rnd[i] = Math.random(); }
    this.vaoG = this.vaoG || gl.createVertexArray();
    gl.bindVertexArray(this.vaoG);
    this.bufUv = this.bufUv || gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUv); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.bufRnd = this.bufRnd || gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRnd); gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);

    const sn = this.starCount = Math.max(0, Math.round(this.style.stars || 0));
    if (sn > 0) {
      const seeds = new Float32Array(sn);
      for (let i = 0; i < sn; i++) seeds[i] = Math.random() * 1000;
      this.vaoS = this.vaoS || gl.createVertexArray();
      gl.bindVertexArray(this.vaoS);
      this.bufSeed = this.bufSeed || gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSeed); gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
  }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = this.canvas.width = Math.max(2, Math.round((r.width || this.host.clientWidth || 1440) * dpr));
    this.H = this.canvas.height = Math.max(2, Math.round((r.height || this.host.clientHeight || 900) * dpr));
    this.DPR = dpr;
    if (this._text) this._bake(this._text);
  }

  setStyle(custom) {
    const prev = this.style;
    this.style = resolveMusicStyle(custom);
    // 粒子数/星河数变了才重建缓冲区 —— 拖别的滑块不该每帧重建几十万个随机数
    if (prev.density !== this.style.density || prev.stars !== this.style.stars) this._buildBuffers();
    if (this._text) this._bake(this._text);
  }

  /* ── 这一句词 ─────────────────────────────────────────────────────── */

  /** 把一句话画进遮罩图,并算出它在屏幕上该占多大一块。 */
  _bake(text) {
    const o = this._actx, S = this.style;
    o.clearRect(0, 0, ATLAS_W, ATLAS_H);
    o.fillStyle = '#fff'; o.textAlign = 'center'; o.textBaseline = 'middle';
    const FONT = (px) => `${S.weight} ${Math.round(px)}px -apple-system,BlinkMacSystemFont,'SF Pro Display','PingFang SC','Segoe UI',system-ui,sans-serif`;
    let fs = ATLAS_H * 0.62;
    o.font = FONT(fs);
    if (S.tracking) { try { o.letterSpacing = `${(S.tracking * fs).toFixed(1)}px`; } catch (e) {} }
    // 遮罩图是固定大小的,长句先在**图里**缩到装得下,屏幕上的大小另算
    const w0 = o.measureText(text).width || 1;
    const maxW = ATLAS_W * 0.96;
    if (w0 > maxW) { fs = Math.max(ATLAS_H * 0.22, fs * (maxW / w0)); o.font = FONT(fs);
                     if (S.tracking) { try { o.letterSpacing = `${(S.tracking * fs).toFixed(1)}px`; } catch (e) {} } }
    o.fillText(text, ATLAS_W / 2, ATLAS_H / 2);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this._atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    /* 屏幕上这块矩形多大。
       ⚠ 不能拿"遮罩图的比例"直接推宽度:图是 2048×256 的固定画布,字只占中间一条。
       正确的算法是先定**字**在屏幕上多高,换算出缩放比,再把整张图按这个比例铺开;
       然后看**字**(不是图)有没有超出屏宽,超了再整体缩。
       第一版少了这一步,长句两头被切在屏幕外面。 */
    const textW = Math.min(w0, maxW);                 // 字在图里的实际宽度(px)
    let scale = (this.H * 0.085 * (S.size || 1)) / Math.max(1, fs);
    const maxOnScreen = this.W * 0.92;
    if (textW * scale > maxOnScreen) scale = maxOnScreen / textW;
    this.band = [ this.W * (0.5 + (S.x || 0)), this.H * (S.y || 0.72),
                  ATLAS_W * scale, ATLAS_H * scale ];
    // 字在图里的 u 范围 —— 扫光和边缘渐隐都按它算
    this.textU = [ 0.5 - (textW / 2) / ATLAS_W, 0.5 + (textW / 2) / ATLAS_W ];
  }

  setState(st) {
    const sameTrack = this.state && st && this.state.title === st.title && this.state.artist === st.artist;
    this.state = st && st.title ? st : null;
    if (!sameTrack) { this.lineIdx = -1; this._clock = null; }
    if (this.state && this.state.self_clock) {
      const e = this.state.elapsed || 0;
      if (!this._clock || Math.abs(this._clock.base - e) > 1.2) this._clock = { base: e, at: Date.now() / 1000 };
    } else this._clock = null;
  }

  setAudio(a) { if (a) { this.audio.bass = +a.bass || 0; this.audio.beat = +a.beat || 0; } }

  position() {
    const s = this.state;
    if (!s) return 0;
    if ((s.rate || 0) > 0 && s.ts) return Math.max(0, (s.elapsed || 0) + ((Date.now() / 1000) - s.ts) * s.rate);
    if (s.self_clock && this._clock) return Math.max(0, this._clock.base + ((Date.now() / 1000) - this._clock.at));
    return Math.max(0, s.elapsed || 0);
  }

  _lineAt(pos) {
    const L = this.state && this.state.lines;
    if (!L || !L.length) return -1;
    let lo = 0, hi = L.length - 1, hit = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= pos) { hit = m; lo = m + 1; } else hi = m - 1; }
    return hit;
  }

  /* ── 每帧 ─────────────────────────────────────────────────────────── */

  draw(dt) {
    const gl = this.gl, S = this.style;
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);   // 透明:底下是引擎
    if (!this.state) return;

    const pos = this.position();
    const idx = this._lineAt(pos);
    if (idx !== this.lineIdx) {
      this.lineIdx = idx;
      const L = this.state.lines || [];
      this._text = (L[idx] && L[idx].text) || '';
      this.formT = 0;
      if (this._text) this._bake(this._text);
    }
    if (!this._text || !this.band) return;
    this.formT += dt;

    // 成型进度 + 这一句的扫光位置
    const form = Math.min(1, this.formT / 0.9);
    const L = this.state.lines || [];
    let sweep = 1;
    if (idx >= 0 && idx < L.length) {
      const a = L[idx].t, b = (idx + 1 < L.length) ? L[idx + 1].t : a + 4;
      sweep = Math.max(0, Math.min(1, (pos - a) / Math.max(0.4, b - a)));
    }
    // 鼓点:接上真音频就用它,没有就退回"每句出现时鼓一下"
    const beat = (this.audio.bass > 0.001) ? this.audio.beat
               : Math.max(0, 1 - this.formT / 0.55);
    const hex = (h, d) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
      if (!m) return d;
      const v = parseInt(m[1], 16);
      return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    };
    const col = hex(S.color, [0.91, 0.96, 1]), hl = hex(S.highlight, [0.79, 0.94, 0.24]);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);          // 加性:和引擎的粒子同一种合成

    // ① 星河(歌词光粒)
    if (this.starCount > 0) {
      const { p, u } = this.pStar;
      gl.useProgram(p); gl.bindVertexArray(this.vaoS);
      gl.uniform2f(u.uViewport, this.W, this.H);
      gl.uniform4f(u.uBand, this.band[0], this.band[1], this.band[2], this.band[3]);
      gl.uniform1f(u.uTime, this.t); gl.uniform1f(u.uFlow, S.flow || 1);
      gl.uniform1f(u.uPixel, this.DPR); gl.uniform1f(u.uBeat, beat * (S.beatGlow || 0));
      gl.uniform3f(u.uColor, col[0], col[1], col[2]);
      gl.drawArrays(gl.POINTS, 0, this.starCount);
    }

    // ② 字:辉光孪生层先画(大、暗),字本体后画(小、亮)—— 和引擎同一个顺序
    const { p, u } = this.pGlyph;
    gl.useProgram(p); gl.bindVertexArray(this.vaoG);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.uMask, 0);
    gl.uniform2f(u.uViewport, this.W, this.H);
    gl.uniform4f(u.uBand, this.band[0], this.band[1], this.band[2], this.band[3]);
    gl.uniform1f(u.uTime, this.t);
    gl.uniform1f(u.uForm, form);
    gl.uniform1f(u.uBreath, (S.breath || 0) * (1 + beat * 0.8));
    gl.uniform1f(u.uPixel, this.DPR);
    gl.uniform1f(u.uSweep, sweep);
    gl.uniform1f(u.uFade, S.fade || 0);
    gl.uniform2f(u.uTextU, this.textU ? this.textU[0] : 0, this.textU ? this.textU[1] : 1);
    gl.uniform3f(u.uColor, col[0], col[1], col[2]);
    gl.uniform3f(u.uHighlight, hl[0], hl[1], hl[2]);

    const glow = (S.glow || 0) * (1 + beat * (S.beatGlow || 0) * 0.6);
    if (glow > 0.01) {
      gl.uniform1f(u.uDot, (S.dot || 1) * 2.0);
      gl.uniform1f(u.uBloom, 2.4);
      gl.uniform1f(u.uAlpha, 0.10 * glow);
      gl.uniform1f(u.uGlowAmt, 1.0);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
    gl.uniform1f(u.uDot, (S.dot || 1) * 1.6);
    gl.uniform1f(u.uBloom, 1.0);
    gl.uniform1f(u.uAlpha, 0.85);
    gl.uniform1f(u.uGlowAmt, 1.0);
    gl.drawArrays(gl.POINTS, 0, this.count);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    this._health();
  }

  /** 上下文"活着但什么都不画"的那种僵死状态,webglcontextlost 接不住(壁纸粒子板踩过)。 */
  _health() {
    if (this._checked > 3) return;
    this._checked++;
    const gl = this.gl, px = new Uint8Array(4);
    try { gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) { return; }
    // 透明画布:清屏色是全 0,所以这里只能检出"读都读不了"的情况
    if (gl.isContextLost()) this.dispose();
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now; this.t += dt;
      this.draw(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  resize() { this._size(); }
  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    try { this.canvas.remove(); } catch (e) {}
    const lose = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (lose) try { lose.loseContext(); } catch (e) {}
  }
}
