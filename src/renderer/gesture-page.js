/* gesture-page.js —— 主界面「手势控制」页的预览(Pro)。
 *
 * 和壁纸页的预览同一个做法:引擎直接画在这一页的 canvas 上(不是 iframe)。
 *   · 底下一层:Pro 粒子壁纸(MineradioWallpaper,pro:true)
 *   · 上面一层:粒子字(pdock-engine)—— 几张 agent 日志卡、一个大标题、你的手(粒子骨架)
 * 摄像头画面**不显示**:只有手的 21 个关节被画成粒子。隐私上干净,也更像"用手在粒子里动"。
 *
 * 预览里所有手势都能试:
 *   张开手掌移动 → 壁纸粒子和字都被手推开          握拳 → 壁纸粒子向中心收拢
 *   握拳拧手腕 → 两层一起变速                      张开手掌停住 → 两层一起定格
 *   两只手捏住拉开 → 壁纸拉近、字放大              捏住拖 → 转壁纸的视角
 *   指着一张卡停住 → 这张卡放大重画(清楚的字)     捏一下卡 → 展开成一个大窗口(再捏一下收回)
 *   张开手掌横挥 → 换一张卡当焦点
 * 没有手的时候:壁纸自己慢慢转,字安安静静 —— 和没有手势功能时一样。 */
import MineradioWallpaper from './mineradio-wallpaper.js';
import { ParticleField, raster } from './pdock-engine.js';
import { GestureEngine } from './gesture-core.js';

const SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif';
const MONO = '"SF Mono",Menlo,ui-monospace,monospace';
const F = (px, w = 600, mono) => `${w} ${px}px ${mono ? MONO : SANS}`;
const K = { lime: '#C9F03D', amber: '#FFC24B', blue: '#7FB2FF', red: '#FF6B6B', t1: '#F4F6FA', t2: '#D6DBE4', sub: '#AEB5C2' };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

const CARDS = [
  { title: 'Particle effects and list rendering bugs', tool: 'Bash', arg: 'cargo tauri build', lines: ['Compiling terse v1.3.3', '   Finished release in 4m 12s', 'Bundling Terse.app', 'dmg 26.1 MB · signed (ad-hoc)'] },
  { title: 'Landing page redesign', tool: 'Edit', arg: 'landing/index.html', lines: ['- <h1>Save tokens</h1>', '+ <h1>Particles that listen</h1>', 'Railway deploy queued', '3 files changed'] },
  { title: 'QQQ data audit and retry fix', tool: 'Bash', arg: 'pytest -q', lines: ['62 passed in 8.41s', 'retry: exponential backoff', '14 missing days backfilled', 'no new gaps'] },
];

export function mount(root, api) {
  const stage = root.querySelector('#gsStage'), wallCv = root.querySelector('#gsWall'), fxCv = root.querySelector('#gsFx');
  const hud = root.querySelector('#gsHud');
  let wall = null, f = null, g = null, unlisten = null, unStatus = null, running = false;
  let W = 0, H = 0, focus = 0, openCard = -1, zoomed = -1;
  const cardPos = [];
  const base = { az: 0.42, el: 0.3, dist: 1.15 };
  let view = { ...base }, orbit = null, zoom0 = null, grip = 0, gripTarget = 0;

  function size() { const r = stage.getBoundingClientRect(); W = r.width; H = r.height; }

  function cardBmp(c, i, scale = 1, open = false) {
    const w = 250 * scale, lines = open ? c.lines : c.lines.slice(0, 2), h = (58 + lines.length * 17) * scale;
    const s = scale;
    return raster(w, h, (x) => {
      x.fillStyle = 'rgba(10,12,18,.5)'; rr(x, 1, 1, w - 2, h - 2, 12 * s); x.fill();
      x.strokeStyle = i === focus ? 'rgba(201,240,61,.7)' : 'rgba(255,255,255,.16)'; x.lineWidth = 1; rr(x, 0.5, 0.5, w - 1, h - 1, 12 * s); x.stroke();
      x.fillStyle = K.lime; x.beginPath(); x.arc(16 * s, 18 * s, 4 * s, 0, 7); x.fill();
      x.font = F(12.5 * s, 650); x.fillStyle = K.t1; x.fillText(c.title.length > 30 && s < 1.3 ? c.title.slice(0, 29) + '…' : c.title, 28 * s, 10 * s);
      x.font = F(11 * s, 700, true); x.fillStyle = K.lime; x.fillText(c.tool, 16 * s, 32 * s);
      x.font = F(11 * s, 600, true); x.fillStyle = K.t2; x.fillText(c.arg, 16 * s + x.measureText(c.tool + '  ').width, 32 * s);
      x.font = F(10.5 * s, 500, true); x.fillStyle = K.sub; lines.forEach((l, j) => x.fillText(l, 16 * s, (52 + j * 17) * s));
    });
  }
  function layoutCards(enter) {
    CARDS.forEach((c, i) => {
      const sc = i === zoomed ? 1.6 : 1, open = i === openCard;
      const x = 22 + i * 16, y = 70 + i * 92;
      cardPos[i] = { x, y, w: 250 * sc, h: (58 + (open ? c.lines.length : 2) * 17) * sc };
      f.set('card' + i, cardBmp(c, i, sc, open), { x, y, z: i === zoomed || open ? 5 : 2, enter });
    });
  }
  function title() {
    f.set('title', raster(W, 60, (x) => { x.font = F(34, 800); x.fillStyle = K.t1; x.textAlign = 'right'; x.fillText('Terse', W - 26, 12); x.font = F(12, 600); x.fillStyle = K.sub; x.fillText(api.t('gs_hint', 'Hold your hand 40–70 cm from the camera'), W - 28, 44); }), { x: 0, y: H - 76, z: 1 });
  }
  function hudText(s) { if (hud) hud.textContent = s; }

  /* 手画成粒子:21 个关节 + 骨头 */
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  let lastSkel = 0;
  function drawSkeleton(frame) {
    const now = performance.now(); if (now - lastSkel < 30) return; lastSkel = now;
    const hs = frame.h || [];
    if (!hs.length) { if (f.has('skel')) f.remove('skel'); return; }
    const box = g.box, map = (x, y) => [(x - box.x0) / (box.x1 - box.x0) * W, (y - box.y0) / (box.y1 - box.y0) * H];
    const hands = hs.map((h) => { const P = []; for (let i = 0; i < 21; i++) P.push(h.p[i * 3 + 2] > 0.1 ? map(h.p[i * 3], h.p[i * 3 + 1]) : null); return P; });
    /* 只光栅化手所在的那一块(外扩几像素)。第一版每 30ms 光栅化**整个舞台**再逐像素扫一遍
       (1500×850 在 2x 屏上是 510 万像素)—— 主线程被它吃满,整个界面都卡。画出来的点和线一模一样,
       只是画布从整个舞台缩到手的包围盒,位置用元素的 x/y 放回去。 */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of hands) for (const p of P) if (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (!(x1 >= x0)) { if (f.has('skel')) f.remove('skel'); return; }
    const pad = 4, bx = Math.floor(x0 - pad), by = Math.floor(y0 - pad), bw = Math.ceil(x1 - x0 + pad * 2) + 1, bh = Math.ceil(y1 - y0 + pad * 2) + 1;
    f.set('skel', raster(bw, bh, (x) => {
      x.translate(-bx, -by);
      for (const P of hands) {
        x.strokeStyle = 'rgba(127,178,255,.55)'; x.lineWidth = 1.4;
        for (const [a, b] of BONES) if (P[a] && P[b]) { x.beginPath(); x.moveTo(P[a][0], P[a][1]); x.lineTo(P[b][0], P[b][1]); x.stroke(); }
        x.fillStyle = K.blue; for (const p of P) if (p) { x.beginPath(); x.arc(p[0], p[1], 2.6, 0, 7); x.fill(); }
      }
    }, { halo: false }), { x: bx, y: by, z: 8, noHand: true, density: 0.25 });
  }
  /* 光标:同一个样子(姿态 + 停留进度的一小格)只光栅化一次,之后只挪位置。
     第一版每一帧手部数据都重画一次光标位图并重传 GPU。看起来完全一样。 */
  const curCache = new Map();
  let curSig = '';
  function cursor(e) {
    const c = e.pose === 'pinch' ? K.lime : e.pose === 'open' ? K.blue : e.pose === 'fist' ? K.amber : '#FFFFFF';
    const step = hold.p > 0 ? Math.round(hold.p * 24) : 0;
    const sig = e.pose + '|' + step + '|' + hold.k;
    if (sig === curSig && f.has('cur')) { f.move('cur', e.x - 22, e.y - 22, 0); return; }
    curSig = sig;
    let bmp = curCache.get(sig);
    if (!bmp) {
      const p = step / 24;
      bmp = raster(44, 44, (x) => {
        x.strokeStyle = c; x.lineWidth = e.pose === 'pinch' ? 3 : 1.6; x.beginPath(); x.arc(22, 22, e.pose === 'pinch' ? 7 : 11, 0, 7); x.stroke();
        if (p > 0) { x.strokeStyle = hold.k === 'freeze' ? K.blue : K.lime; x.lineWidth = 3; x.beginPath(); x.arc(22, 22, 17, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); x.stroke(); }
      }, { halo: false });
      if (curCache.size > 200) curCache.clear();
      curCache.set(sig, bmp);
    }
    f.set('cur', bmp, { x: e.x - 22, y: e.y - 22, z: 9, noHand: true });
  }
  const hold = { p: 0, k: '' };
  const cardAt = (x, y) => cardPos.findIndex((c) => c && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
  const label = (e) => ({ pinch: 'pinch', open: 'open palm', fist: 'fist', point: 'point', zoom: 'two-hand zoom' }[e.pose] || e.pose);

  function onGesture(e) {
    switch (e.type) {
      case 'hand': {
        cursor(e);
        // 张开手掌:两层粒子都被推开;握拳:壁纸粒子收拢
        f.setHand(e.pose === 'open' ? { x: e.x, y: e.y, r: 80, s: 1 } : null);
        wall.setHandScreen(e.pose === 'fist' ? null : e.x, e.y);
        gripTarget = e.pose === 'fist' ? 1 : 0;
        hudText(`${label(e)} · ${f.rate.toFixed(2)}× ${f.frozen ? '· ❚❚' : ''}`);
        break;
      }
      case 'lost': f.setHand(null); f.setLens(null); f.setZoom(null); zoom0 = null; orbit = null; wall.setHandScreen(null); gripTarget = 0; if (f.has('cur')) f.remove('cur'); if (f.has('skel')) f.remove('skel'); hudText(api.t('gs_hint', 'Hold your hand 40–70 cm from the camera')); break;
      case 'hold': hold.p = e.progress; hold.k = e.kind; break;
      case 'freeze': f.setFrozen(e.frozen); wall.setFrozen(e.frozen); break;
      case 'speed': f.setRate(e.rate); wall.setRate(e.rate); break;
      case 'zoomstart': zoom0 = { dist: view.dist }; break;
      case 'zoom':
        f.setZoom({ s: Math.max(0.5, Math.min(2.5, e.scale)), x: e.cx, y: e.cy });   // 字层放大有上限,不然卡片全被推出画面
        view = { ...view, dist: Math.max(0.55, Math.min(2.6, (zoom0 ? zoom0.dist : view.dist) / e.scale)) };
        wall.setView3D && wall.setView3D({ on: true, ...view });
        break;
      case 'zoomend': f.setZoom(null); zoom0 = null; break;
      case 'pinchstart': orbit = cardAt(e.x, e.y) < 0 ? { x: e.x, y: e.y, az: view.az, el: view.el } : null; break;
      case 'drag':
        if (orbit) { view = { ...view, az: orbit.az + (e.x - orbit.x) / W * 2.2, el: Math.max(-1.1, Math.min(1.1, orbit.el + (e.y - orbit.y) / H * 1.6)) }; wall.setView3D && wall.setView3D({ on: true, ...view }); }
        break;
      case 'pinchend': {
        orbit = null;
        if (!e.tap) break;
        const i = cardAt(e.x, e.y);
        if (i >= 0) { openCard = openCard === i ? -1 : i; focus = i; layoutCards({ mode: 'point', from: [e.x, e.y], dur: 0.6, sweep: 0.3, tint: rgb(K.lime) }); }
        break;
      }
      case 'dwell': {
        const i = cardAt(e.x, e.y);
        if (i >= 0 && i !== zoomed) { zoomed = i; focus = i; layoutCards(null); f.set('card' + i, cardBmp(CARDS[i], i, 1.6, openCard === i), { x: cardPos[i].x, y: cardPos[i].y, z: 5, enter: { mode: 'assemble', dur: 0.55, sweep: 0.3, tint: rgb(K.lime) } }); }
        else if (i < 0) f.setLens({ x: e.x, y: e.y, r: 110, m: 2.2 });
        break;
      }
      case 'swipe': focus = (focus + (e.dir === 'right' ? 1 : CARDS.length - 1)) % CARDS.length; zoomed = -1; layoutCards({ mode: 'scatter', dur: 0.5, sweep: 0.2 }); break;
    }
  }

  async function start() {
    if (running) return;
    size();
    wall = new MineradioWallpaper(wallCv, { theme: 'aurora', quality: 36, pro: true, view3d: { on: true, ...base } });
    wall.start(); wall.setActivity && wall.setActivity(0.7);
    f = new ParticleField(fxCv);
    g = new GestureEngine({ screen: [W, H], onEvent: onGesture });
    try { g.sensitivity = +(localStorage.getItem('terse-gesture-sens') || 1); } catch (e) {}
    layoutCards({ mode: 'scatter', dur: 0.8, sweep: 0.4 }); title();
    // 握拳的"收拢"平滑进出
    const gi = setInterval(() => { grip += (gripTarget - grip) * 0.25; wall && wall.setGrip && wall.setGrip(grip); }, 33);
    unlisten = await api.listen('hand-frame', (ev) => { const fr = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload; if (!fr) return; drawSkeleton(fr); g.feed(fr); });
    unStatus = await api.listen('hand-status', (ev) => api.onStatus && api.onStatus(ev.payload || {}));
    running = { gi };
    hudText(api.t('gs_hint', 'Hold your hand 40–70 cm from the camera'));
  }
  function stop() {
    if (!running) return;
    clearInterval(running.gi);
    try { unlisten && unlisten(); unStatus && unStatus(); } catch (e) {}
    try { wall && wall.dispose(); } catch (e) {}
    for (const id of [...(f ? f.els.keys() : [])]) f.remove(id);
    wall = null; f = null; g = null; running = false;
  }
  addEventListener('resize', () => { if (running && g) { size(); g.screen = [W, H]; f.resize(); layoutCards(null); title(); } });
  /** 浏览器里测试:没有摄像头时用假帧驱动(和 terse-hands 的输出同一格式) */
  function feed(frame) { if (g) { drawSkeleton(frame); g.feed(frame); } }
  return { start, stop, feed, get running() { return !!running; }, state: () => ({ running: !!running, rate: f && f.rate, frozen: f && f.frozen, zoomed, openCard, view, stats: f && f.stats() }) };
}
