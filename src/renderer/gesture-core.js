/* gesture-core.js —— 手 → 手势。所有粒子窗口共用(会话栏、壁纸、手势预览)。
 *
 * 输入:terse-hands(Apple Vision)每帧的两只手、各 21 个关节,0..1、左上原点、已镜像,
 *       经 Rust 以 `hand-frame` 事件广播过来。浏览器里测试时可以直接 feed() 假数据。
 * 输出:平滑后的光标(屏幕坐标)+ 离散的手势事件。**没有手的时候什么都不发** ——
 *       所有粒子功能照旧,和没有这个功能时一模一样。
 *
 * 手势(设计照着 visionOS / Ultraleap 的准则:捏合是"点击",危险操作永远要显式捏合,
 * 不靠"停留"触发 —— 避免 Midas touch:看一眼 / 指一下就误操作):
 *   · 光标 = 拇指尖和食指尖的中点。用中点而不是食指尖:捏合时食指会动,光标会跳;中点不跳。
 *   · 捏一下        → tap(点击:允许按钮、打开卡片)
 *   · 捏住拖        → drag(滚动、拖动)
 *   · 两只手都捏住、拉开/合拢 → zoom(放大缩小)
 *   · 张开手掌停住 0.7 秒 → freeze(定格 / 解除定格)
 *   · 握拳、像拧旋钮一样转手腕 → speed(粒子播放速度 0.1× – 4×)
 *   · 张开手掌快速横挥 → swipe(左 / 右)
 *   · 指着一处停 0.6 秒 → dwell(选中、放大那一条 —— 只做"看",不做"改")
 *
 * 平滑:1€ filter(Casiez 2012)—— 手不动时强滤波去抖,手快速移动时几乎不滤,不拖尾。
 * 再往前外推半帧抵消摄像头 + 识别的延迟("灵敏"的来源)。 */

export class OneEuro {
  /* 参数按**屏幕像素**调:beta 是"每 px/s 速度加多少 Hz 截止频率"。
     第一版 beta=6 是按 0..1 坐标想的,放到像素上等于滤波没开(实测静止手抖 14px,和原始一样) */
  // beta 0.004 → 0.007:移动时滞后更小(静止时的去抖由 minCutoff 决定,不受影响)
  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; this.t = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

// MediaPipe / Vision 共用的关节下标
const J = { wrist: 0, thumbTip: 4, thumbIP: 3, indexMCP: 5, indexPIP: 6, indexTip: 8, middleMCP: 9, middlePIP: 10, middleTip: 12, ringPIP: 14, ringTip: 16, littleMCP: 17, littlePIP: 18, littleTip: 20 };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function parseHand(h) {
  const p = [];
  for (let i = 0; i < 21; i++) p.push([h.p[i * 3], h.p[i * 3 + 1], h.p[i * 3 + 2]]);
  return { side: h.c, score: h.s, p };
}
/** 一只手的姿态 */
function pose(hand) {
  const p = hand.p, ok = (i) => p[i][2] > 0.1;
  if (!ok(J.wrist) || !ok(J.middleMCP)) return null;
  // 手掌大小:远近不同,阈值都按它归一。两种量法取大 —— 手侧过来时腕到中指根会变短,
  // 掌宽(食指根到小指根)会变窄,单用一种会让阈值忽大忽小
  const scale = Math.max(0.02, dist(p[J.wrist], p[J.middleMCP]), ok(J.indexMCP) && ok(J.littleMCP) ? dist(p[J.indexMCP], p[J.littleMCP]) * 1.35 : 0);
  /* 手指伸直 / 弯曲按**关节角度**判(MCP–PIP–TIP 的夹角),不是只比到手腕的距离。
     距离法在手斜着、离得远、指向镜头时会误判 —— 用户说的"握拳认不出来""不灵敏"大多来自这里。
     伸直:夹角 > 145° 且指尖比 PIP 离手腕远;弯曲:夹角 < 110° 或指尖比 PIP 离手腕近。中间地带两者都不算。 */
  const ang = (a, b, c) => {
    const v1x = p[a][0] - p[b][0], v1y = p[a][1] - p[b][1], v2x = p[c][0] - p[b][0], v2y = p[c][1] - p[b][1];
    const dd = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / dd))) * 180 / Math.PI;
  };
  const F4 = [[J.indexMCP, J.indexPIP, J.indexTip], [J.middleMCP, J.middlePIP, J.middleTip], [13, J.ringPIP, J.ringTip], [J.littleMCP, J.littlePIP, J.littleTip]];
  const okF = (f) => ok(f[0]) && ok(f[1]) && ok(f[2]);
  const fingers = F4.map((f) => okF(f) && ang(f[0], f[1], f[2]) > 145 && dist(p[f[2]], p[J.wrist]) > dist(p[f[1]], p[J.wrist]));
  const curls = F4.map((f) => okF(f) && (ang(f[0], f[1], f[2]) < 110 || dist(p[f[2]], p[J.wrist]) < dist(p[f[1]], p[J.wrist])));
  const nExt = fingers.filter(Boolean).length, nCurl = curls.filter(Boolean).length;
  const pinchD = ok(J.thumbTip) && ok(J.indexTip) ? dist(p[J.thumbTip], p[J.indexTip]) / scale : 9;
  const mid = ok(J.thumbTip) && ok(J.indexTip) ? [(p[J.thumbTip][0] + p[J.indexTip][0]) / 2, (p[J.thumbTip][1] + p[J.indexTip][1]) / 2] : p[J.indexMCP];
  // 手腕转角(拧旋钮):食指根 → 小指根 这条线的角度
  const roll = ok(J.indexMCP) && ok(J.littleMCP) ? Math.atan2(p[J.littleMCP][1] - p[J.indexMCP][1], p[J.littleMCP][0] - p[J.indexMCP][0]) : 0;
  return { scale, fingers, nExt, nCurl, pinchD, mid, roll, palm: p[J.middleMCP] };
}

export class GestureEngine {
  /** opts: { screen:[w,h], onEvent(ev) } */
  constructor(opts = {}) {
    this.screen = opts.screen || [window.screen.width, window.screen.height];
    this.onEvent = opts.onEvent || (() => {});
    // 交互框:摄像头画面中间这一块映射到整个屏幕 —— 手不用伸到画面边缘就能够到屏幕角落
    this.box = { x0: 0.18, x1: 0.82, y0: 0.14, y1: 0.78 };
    this.sensitivity = 1;         // 用户可调:越大越灵敏(抖动也越明显)
    this.accel = opts.accel !== false;   // 加速曲线(默认开)
    this.swipeK = opts.swipeK || 1.6;    // 挥手要多快才算(屏宽/秒);粒子光标层用 0.9,换目标更轻松
    this.prevAbs = null; this.cur0 = null; this.prevT = 0;
    this.fx = new OneEuro(); this.fy = new OneEuro();
    this.present = false; this.lastSeen = 0;
    this.pinching = false; this.pinchStart = null; this.pinchT = 0; this.moved = 0;
    this.two = null;              // 双手缩放 { d0 }
    this.palmHold = null;         // { t0, x, y }
    this.fistRoll = null;         // { r0, rate0 }
    this.rate = 1; this.frozen = false;
    this.dwell = null;            // { t0, x, y }
    this.swipeHist = []; this.swipeCool = 0;
    this.cursor = null; this.v = [0, 0];
  }
  toScreen(pt) {
    const b = this.box;
    const nx = Math.min(1, Math.max(0, (pt[0] - b.x0) / (b.x1 - b.x0))), ny = Math.min(1, Math.max(0, (pt[1] - b.y0) / (b.y1 - b.y0)));
    return [nx * this.screen[0], ny * this.screen[1]];
  }
  emit(type, data = {}) { this.onEvent({ type, ...data }); }

  /** 每一帧 terse-hands 的输出 */
  feed(frame) {
    const t = (frame.t || performance.now()) / 1000;
    const hands = (frame.h || []).map(parseHand).map((h) => ({ ...h, q: pose(h) })).filter((h) => h.q);
    if (!hands.length) {
      if (this.present && t - this.lastSeen > 0.35) {   // 短暂丢一两帧不算离开(识别偶尔会漏)
        this.present = false; this.fx.reset(); this.fy.reset();
        if (this.pinching) { this.pinching = false; this.emit('pinchend', { x: this.cursor?.[0], y: this.cursor?.[1], tap: false }); }
        // 两只手缩放到一半手离开了:也要说一声"缩放结束",否则画面会一直停在放大的样子(实测)
        if (this.two) this.emit('zoomend');
        if (this.two) { this.two = null; this.emit('zoomend'); }
        this.palmHold = null; this.fistRoll = null; this.dwell = null;
        this.prevAbs = null; this.cur0 = null;
        this.emit('lost');
      }
      return;
    }
    this.lastSeen = t;
    // 主手:右手优先(镜像后用户的右手),没有就取置信度高的
    hands.sort((a, b) => (b.side === 'r') - (a.side === 'r') || b.score - a.score);
    const h = hands[0], q = h.q;
    // 光标:加速曲线 → 1€ 平滑 → 往前外推半帧(抵消摄像头 + 识别的延迟)
    /* 加速曲线(和 macOS 鼠标一样的道理):手慢慢动 → 光标只走 0.45 倍,能精确地停在一个小按钮上;
       手快速挥 → 最多 1.6 倍,一下就到屏幕另一头。只在手**快**的时候把光标慢慢拉回"手在哪、光标
       就在哪"(拉回的力度随速度增大),手停住时光标不会自己漂 —— 第一版纯绝对映射,手的一点抖动
       被放大成光标的抖动,又因为滤得狠显得跟不上,用户说"不灵敏"。 */
    const abs = this.toScreen(q.mid);
    let raw = abs;
    if (this.accel && this.prevAbs && this.cur0) {
      const dx = abs[0] - this.prevAbs[0], dy = abs[1] - this.prevAbs[1], dt = Math.max(1 / 90, t - this.prevT);
      const v = Math.hypot(dx, dy) / dt;                                     // px/s(绝对映射下)
      const g = (0.45 + 1.15 / (1 + Math.exp(-(v - 700) / 220))) * this.sensitivity;
      let nx = this.cur0[0] + dx * g, ny = this.cur0[1] + dy * g;
      const k = Math.min(0.25, v / 5000);                                    // 越快拉回得越多;静止为 0
      nx += (abs[0] - nx) * k; ny += (abs[1] - ny) * k;
      raw = [Math.min(this.screen[0], Math.max(0, nx)), Math.min(this.screen[1], Math.max(0, ny))];
    }
    this.prevAbs = abs; this.prevT = t; this.cur0 = raw;
    const fcut = 1.0 / this.sensitivity;
    this.fx.minCutoff = fcut; this.fy.minCutoff = fcut;
    let x = this.fx.filter(raw[0], t), y = this.fy.filter(raw[1], t);
    this.v = [this.fx.dx, this.fy.dx];
    x += this.v[0] * 0.016 * this.sensitivity; y += this.v[1] * 0.016 * this.sensitivity;
    const prev = this.cursor; this.cursor = [x, y];
    if (!this.present) { this.present = true; this.emit('found', { x, y }); }

    // ── 双手捏合 → 缩放 ──
    const both = hands.length > 1 && hands[0].q.pinchD < 0.4 && hands[1].q.pinchD < 0.4;
    if (both) {
      const a = this.toScreen(hands[0].q.mid), b = this.toScreen(hands[1].q.mid), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (!this.two) { this.two = { d0: d }; this.emit('zoomstart', { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }); }
      this.emit('zoom', { scale: Math.max(0.3, Math.min(5, d / this.two.d0)), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 });
      this.emit('hand', { x, y, pose: 'zoom', pinch: true, two: true });
      return;
    } else if (this.two) { this.two = null; this.emit('zoomend'); }

    // ── 捏合(带迟滞:进 0.33,出 0.48 —— 不会在临界点来回抖)──
    // 握拳时拇指扣在食指上,拇指尖离食指尖也很近 —— 四指全蜷 = 拳,优先于捏合,否则拳永远被当成捏
    // 拳:至少三根手指弯着、没有一根伸直(第四根在镜头里常常看不清,不强求)
    const fistLike = q.nCurl >= 3 && q.nExt === 0;
    const wasPinch = this.pinching;
    // 捏合进 0.36 / 出 0.50(比第一版 0.33 / 0.48 宽一点:远处关节点抖,太严捏不上)
    if (!this.pinching && q.pinchD < 0.36 && !fistLike) this.pinching = true;
    else if (this.pinching && (q.pinchD > 0.50 || fistLike)) this.pinching = false;
    if (this.pinching && !wasPinch) { this.pinchStart = [x, y]; this.pinchT = t; this.moved = 0; this.emit('pinchstart', { x, y }); }
    else if (this.pinching && prev) { this.moved += Math.hypot(x - prev[0], y - prev[1]); this.emit('drag', { x, y, dx: x - prev[0], dy: y - prev[1] }); }
    else if (!this.pinching && wasPinch) {
      // 捏一下:短(<350ms)且几乎没动(<48px)= 点击。捏的那一下手指合拢,光标本身会晃一点 ——
      // 28px 太严,合拢时的晃动就足以让点击失效
      this.emit('pinchend', { x, y, tap: t - this.pinchT < 0.35 && this.moved < 48 });
    }

    // 姿态
    const open = !this.pinching && q.nExt >= 4, fist = fistLike, point = q.fingers[0] && q.nExt === 1;
    const kind = this.pinching ? 'pinch' : open ? 'open' : fist ? 'fist' : point ? 'point' : 'other';
    const speed = prev ? Math.hypot(x - prev[0], y - prev[1]) : 0;

    // ── 张开手掌停住 → 定格(进度 0..1 给界面画一圈)──
    if (open && speed < 6) {
      if (!this.palmHold) this.palmHold = { t0: t };
      const k = (t - this.palmHold.t0) / 0.7;
      this.emit('hold', { kind: 'freeze', progress: Math.min(1, k), x, y });
      if (k >= 1 && !this.palmHold.fired) { this.palmHold.fired = true; this.frozen = !this.frozen; this.emit('freeze', { frozen: this.frozen }); }
    } else if (this.palmHold) { this.palmHold = null; this.emit('hold', { kind: 'freeze', progress: 0 }); }

    // ── 握拳 + 拧 → 播放速度 ──
    if (fist) {
      if (!this.fistRoll) this.fistRoll = { r0: q.roll, rate0: this.rate };
      let dr = q.roll - this.fistRoll.r0; if (dr > Math.PI) dr -= 2 * Math.PI; if (dr < -Math.PI) dr += 2 * Math.PI;
      // 转 60° = 速度 ×4 或 ÷4(对数刻度,两个方向对称)
      const r = Math.max(0.1, Math.min(4, this.fistRoll.rate0 * Math.pow(4, dr / (Math.PI / 3))));
      if (Math.abs(r - this.rate) > 0.01) { this.rate = r; this.emit('speed', { rate: r }); }
    } else this.fistRoll = null;

    // ── 张开手掌横挥 → swipe ──
    this.swipeHist.push([t, x]); while (this.swipeHist.length && t - this.swipeHist[0][0] > 0.18) this.swipeHist.shift();
    if ((open || point) && t > this.swipeCool && this.swipeHist.length > 2) {
      const vx = (x - this.swipeHist[0][1]) / Math.max(0.05, t - this.swipeHist[0][0]);
      if (Math.abs(vx) > this.screen[0] * this.swipeK) { this.swipeCool = t + 0.6; this.emit('swipe', { dir: vx > 0 ? 'right' : 'left' }); this.palmHold = null; }
    }

    // ── 指着停留 → dwell(只用来"看":选中、放大)──
    if (point && speed < 4) {
      if (!this.dwell || Math.hypot(x - this.dwell.x, y - this.dwell.y) > 22) this.dwell = { t0: t, x, y };
      const k = (t - this.dwell.t0) / 0.5;   // 0.6 → 0.5 秒:指着停住更快出放大
      this.emit('hold', { kind: 'dwell', progress: Math.min(1, k), x, y });
      if (k >= 1 && !this.dwell.fired) { this.dwell.fired = true; this.emit('dwell', { x, y }); }
    } else if (this.dwell) { this.dwell = null; this.emit('hold', { kind: 'dwell', progress: 0 }); }

    this.emit('hand', { x, y, pose: kind, pinch: this.pinching, pinchStrength: Math.max(0, Math.min(1, (0.6 - q.pinchD) / 0.3)), rate: this.rate, frozen: this.frozen, side: h.side });
  }
}

/** 订阅 Rust 广播的手部帧,转成手势事件。没开手势功能 / 没有手 → 一个事件都不会来。 */
/** 其它窗口:不自己从原始帧算光标,直接收光标层(desk-cursor.js)算好的那一份。
 *  第一版每个窗口各算各的 —— 加速曲线和 1€ 滤波都带状态,几个窗口算出来的光标不在同一个位置:
 *  屏幕上看到的光标在这儿,会话栏却按另一个位置在响应。现在全屏只有一个光标、一套事件。 */
export function listenGestures(listen, onEvent) {
  return listen('gesture-evt', (e) => { const ev = e && e.payload; if (ev && ev.type) onEvent(ev); });
}

export function attachGestures(listen, onEvent, opts = {}) {
  const g = new GestureEngine({ ...opts, onEvent });
  // 灵敏度:主界面「手势控制」页的滑块存在 localStorage(各窗口同源共享),改了立刻生效
  const readSens = () => { try { g.sensitivity = +(localStorage.getItem('terse-gesture-sens') || 1) || 1; } catch (e) {} };
  readSens();
  try { window.addEventListener('storage', (e) => { if (e.key === 'terse-gesture-sens') readSens(); }); } catch (e) {}
  listen('hand-frame', (e) => {
    const fr = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
    if (fr && fr.h) { g.feed(fr); if (opts.onFrame) opts.onFrame(fr, g); }
  });
  return g;
}
