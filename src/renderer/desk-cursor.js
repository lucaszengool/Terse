/* desk-cursor.js —— 全屏光标层(手势控制打开就在;没有手时整个窗口从屏幕上拿走)。三件事:
 *
 * 1. **全屏唯一算手势的地方**。原始手部帧只进这里(和主界面预览);算好的光标和手势事件
 *    用 emitTo 发给会话栏 / 壁纸 / 粒子模式 —— 所有窗口用**同一个光标**。第一版每个窗口各算各的,
 *    加速曲线和滤波都带状态,屏幕上的光标在这儿,会话栏却按另一个位置在响应。
 * 2. **粒子手**:识别到手的每一帧,在光标处画一只跟你的手一模一样动的粒子手(21 个关节 + 骨骼,
 *    指尖拖出火花;颜色表示认出的手势,旁边的小图标说是哪一个;停留 / 定格有进度圈;
 *    手快出摄像头画面时渐隐 —— Ultraleap 的虚拟手准则 + "丢失前预警"的研究)。
 *    它画在一张跟手移动的小画布上(CSS transform),从不重画全屏。
 * 3. **粒子光标控制桌面**(Pro,开关单独):握拳抓窗口 → 自动预锁定最近的按钮 → 左右挥换 →
 *    捏一下按下 → 再握拳松开;标题栏捏住拖 = 移窗口。 */
import { ParticleField, raster } from './pdock-engine.js';
import { attachGestures } from './gesture-core.js';

const T = window.__TAURI__;
const invoke = (c, a) => T.core.invoke(c, a);
const dlog = (m) => invoke('debug_log', { msg: '[desk] ' + m }).catch(() => {});
window.addEventListener('error', (e) => dlog('error ' + e.message + ' @' + e.lineno));
window.addEventListener('unhandledrejection', (e) => dlog('rejection ' + String(e.reason).slice(0, 200)));
const call = (cmd) => invoke('desk_call', { cmd }).catch((e) => ({ ok: false, error: String(e) }));

const SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif';
const K = { lime: '#C9F03D', amber: '#FFC24B', blue: '#7FB2FF', white: '#FFFFFF', red: '#FF6B6B' };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

const f = new ParticleField(document.getElementById('gl'));
addEventListener('resize', () => f.resize());

/* 粒子光标控制桌面开着没有(抓窗口只在开着时生效;粒子手和光标一直都有) */
let deskOn = false;
invoke('desk_get_enabled').then((v) => { deskOn = !!v; }).catch(() => {});
T.event.listen('desk-enabled', (e) => { deskOn = !!(e && e.payload); if (!deskOn && S.mode !== 'idle') release(); });

const MAGNET = 220, HYST = 12;
const S = {
  mode: 'idle', hover: null, win: null, els: [], target: null, lock: null,
  x: -1, y: -1, cx: -1, cy: -1, pose: '', side: 'r',
  lastQuery: 0, qx: -1, qy: -1, fistAt: 0, fistFired: false, drag: null, lostAt: 0,
  hold: 0, holdKind: '', frozen: false, rate: 1,
};

/* ── 统一光标:算好的事件分发给其它窗口 ──────────────────────────────── */
const TARGETS = ['sessions-dock', 'wallpaper', 'particles'];
const emitTo = T.event.emitTo;
function forward(e) {
  if (!emitTo) return;
  for (const t of TARGETS) { try { emitTo(t, 'gesture-evt', e).catch(() => {}); } catch (err) {} }
}

/* ── 粒子手 ─────────────────────────────────────────────────────────────── */
// 页面里没有这张画布(旧页面 / 测试页)就自己建一张 —— 少一个元素不该让整个光标层崩掉
const gcv = document.getElementById('ghost') || (() => {
  const c = document.createElement('canvas'); c.id = 'ghost';
  c.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;will-change:transform;opacity:0';
  document.body.appendChild(c); return c;
})();
const gx = gcv.getContext('2d');
const GW = 460, GH = 460, AX = 230, AY = 170;          // 小画布大小;光标点在画布里的位置
const DPR = Math.min(2, window.devicePixelRatio || 1);
gcv.width = GW * DPR; gcv.height = GH * DPR; gcv.style.width = GW + 'px'; gcv.style.height = GH + 'px';
gx.setTransform(DPR, 0, 0, DPR, 0, 0);
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const TIPS = [4, 8, 12, 16, 20];
const POSE_COL = { open: K.blue, pinch: K.lime, fist: K.amber, point: K.white, zoom: K.lime, other: '#BFD4FF' };
const POSE_ICON = { open: '✋', pinch: '🤏', fist: '✊', point: '☝️', zoom: '🤏↔🤏', other: '' };
const sprites = new Map();
function sprite(col, r) {       // 一颗发光粒子:预先画好,每帧只 drawImage
  const key = col + r; let c = sprites.get(key);
  if (!c) {
    c = document.createElement('canvas'); const s = Math.ceil(r * 4) * DPR; c.width = c.height = s;
    const g = c.getContext('2d'), m = s / 2, grd = g.createRadialGradient(m, m, 0, m, m, m);
    grd.addColorStop(0, '#FFFFFF'); grd.addColorStop(0.18, col); grd.addColorStop(0.45, col + '88'); grd.addColorStop(1, col + '00');
    g.fillStyle = grd; g.fillRect(0, 0, s, s); sprites.set(key, c);
  }
  return c;
}
const ghost = { frame: null, vis: 0, target: 0, sparks: [], raf: 0, last: 0, lastDraw: 0, edge: 0 };
function onFrame(fr) {
  ghost.frame = fr.h && fr.h.length ? fr : null;
  ghost.target = ghost.frame ? 1 : 0;
  if (!ghost.raf) ghost.raf = requestAnimationFrame(drawGhost);
}
function handPoints(h) {
  const P = []; for (let i = 0; i < 21; i++) P.push(h.p[i * 3 + 2] > 0.1 ? [h.p[i * 3], h.p[i * 3 + 1]] : null);
  return P;
}
function drawGhost(ts) {
  ghost.raf = 0;
  // 手的数据 30fps 来,画 30fps 就够;火花在两帧之间自己飞(按时间算)
  if (ts - ghost.lastDraw < 30 && ghost.target) { ghost.raf = requestAnimationFrame(drawGhost); return; }
  const dt = Math.min(0.06, (ts - (ghost.last || ts)) / 1000); ghost.last = ts; ghost.lastDraw = ts;
  ghost.vis += (ghost.target - ghost.vis) * Math.min(1, dt * 12);
  gx.clearRect(0, 0, GW, GH);
  const ox = (S.cx >= 0 ? S.cx : S.x) - AX, oy = (S.cy >= 0 ? S.cy : S.y) - AY;
  gcv.style.transform = `translate(${Math.round(ox)}px, ${Math.round(oy)}px)`;
  const fr = ghost.frame;
  const col = POSE_COL[S.pose] || POSE_COL.other;
  if (fr && S.x >= 0) {
    const hs = fr.h.slice().sort((a, b) => (b.c === 'r') - (a.c === 'r') || b.s - a.s);
    const P0 = handPoints(hs[0]);
    // 手的锚点 = 拇指尖和食指尖的中点(和光标是同一个点)
    const mid = P0[4] && P0[8] ? [(P0[4][0] + P0[8][0]) / 2, (P0[4][1] + P0[8][1]) / 2] : (P0[9] || P0[0]);
    if (mid) {
      const KPX = 1050;                                   // 摄像头归一化坐标 → 屏幕像素(手离得近就大,和照镜子一样)
      // 快出画面(关节贴近摄像头边缘)→ 渐隐 + 偏琥珀色,提醒"手要出去了"
      let edge = 0;
      for (const p of P0) if (p) edge = Math.max(edge, Math.max(0.06 - p[0], p[0] - 0.94, 0.06 - p[1], p[1] - 0.94) / 0.06);
      ghost.edge += (Math.max(0, Math.min(1, edge)) - ghost.edge) * 0.4;
      const a = ghost.vis * (1 - ghost.edge * 0.6);
      const hc = ghost.edge > 0.4 ? K.amber : col;
      for (const h of hs) {
        const P = handPoints(h).map((p) => p && [AX + (p[0] - mid[0]) * KPX, AY + (p[1] - mid[1]) * KPX]);
        gx.globalAlpha = a * 0.9;
        const dot = sprite(hc, 1.6);
        for (const [i, j] of BONES) {                     // 骨骼:沿着骨头每 7px 一颗粒子
          const p = P[i], q = P[j]; if (!p || !q) continue;
          const n = Math.max(2, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / 7));
          for (let k = 0; k <= n; k++) { const x = p[0] + (q[0] - p[0]) * k / n, y = p[1] + (q[1] - p[1]) * k / n; gx.drawImage(dot, x - 3.2, y - 3.2, 6.4, 6.4); }
        }
        gx.globalAlpha = a;
        const jd = sprite(hc, 3.2), td = sprite(K.white, 4);
        P.forEach((p, i) => { if (!p) return; const tip = TIPS.includes(i), s = tip ? 16 : 12; gx.drawImage(tip ? td : jd, p[0] - s / 2, p[1] - s / 2, s, s); });
        // 指尖拖出火花(屏幕坐标里记,画的时候换回小画布坐标 —— 手移开了火花留在原地慢慢散)
        for (const i of TIPS) { const p = P[i]; if (!p || Math.random() > 0.55) continue;
          ghost.sparks.push({ x: p[0] + ox, y: p[1] + oy, vx: (Math.random() - 0.5) * 40, vy: -10 - Math.random() * 30, life: 0.5 + Math.random() * 0.3, c: hc }); }
      }
      // 认出的手势 + 停留 / 定格进度圈(画在光标点上)
      gx.globalAlpha = a;
      if (S.hold > 0) { gx.strokeStyle = S.holdKind === 'freeze' ? K.blue : K.lime; gx.lineWidth = 3; gx.beginPath(); gx.arc(AX, AY, 20, -Math.PI / 2, -Math.PI / 2 + S.hold * Math.PI * 2); gx.stroke(); }
      gx.strokeStyle = S.target ? K.lime : col; gx.lineWidth = S.pose === 'pinch' ? 3 : 1.6; gx.beginPath(); gx.arc(AX, AY, S.pose === 'pinch' ? 6 : 10, 0, 7); gx.stroke();
      const icon = (POSE_ICON[S.pose] || '') + (S.frozen ? ' ❚❚' : '') + (Math.abs(S.rate - 1) > 0.05 ? ` ${S.rate.toFixed(1)}×` : '');
      if (icon) { gx.font = `700 13px ${SANS}`; gx.fillStyle = K.white; gx.shadowColor = 'rgba(0,0,0,.8)'; gx.shadowBlur = 4; gx.fillText(icon, AX + 16, AY - 16); gx.shadowBlur = 0; }
    }
  }
  // 火花
  gx.globalAlpha = 1;
  ghost.sparks = ghost.sparks.filter((s) => (s.life -= dt) > 0);
  if (ghost.sparks.length > 160) ghost.sparks.splice(0, ghost.sparks.length - 160);
  for (const s of ghost.sparks) {
    s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 20 * dt;
    gx.globalAlpha = Math.min(1, s.life * 2) * 0.8 * Math.max(0.2, ghost.vis);
    gx.drawImage(sprite(s.c, 1.4), s.x - ox - 3, s.y - oy - 3, 6, 6);
  }
  gx.globalAlpha = 1;
  const alive = ghost.vis > 0.02 || ghost.sparks.length;
  gcv.style.opacity = alive ? '1' : '0';
  if (alive) ghost.raf = requestAnimationFrame(drawGhost);
}

/* ── 抓窗口(粒子光标控制桌面,Pro)───────────────────────────────────── */
const cache = new Map();
function cached(key, make) { let b = cache.get(key); if (!b) { b = make(); if (cache.size > 120) cache.clear(); cache.set(key, b); } return b; }
function outlineBmp(w, h, col, width, alpha, corners) {
  return raster(w + 12, h + 12, (g) => {
    g.globalAlpha = alpha; g.strokeStyle = col; g.lineWidth = width;
    rr(g, 6, 6, w, h, 12); g.stroke();
    if (corners) {
      g.globalAlpha = 1; g.lineWidth = width + 2; const L = Math.min(34, w / 5, h / 5);
      for (const [x, y, sx, sy] of [[6, 6, 1, 1], [6 + w, 6, -1, 1], [6, 6 + h, 1, -1], [6 + w, 6 + h, -1, -1]]) {
        g.beginPath(); g.moveTo(x, y + sy * L); g.lineTo(x, y); g.lineTo(x + sx * L, y); g.stroke();
      }
    }
  }, { halo: false });
}
function roleName(e) {
  if (e.sub === 'AXCloseButton') return 'Close'; if (e.sub === 'AXMinimizeButton') return 'Minimize';
  if (e.sub === 'AXFullScreenButton' || e.sub === 'AXZoomButton') return 'Zoom';
  if (e.kind === 'input') return e.sub === 'AXSearchField' ? 'Search' : 'Text field';
  return (e.role || '').replace('AX', '');
}
function targetBmp(e) {
  const pad = 5, w = Math.max(8, e.w) + pad * 2, h = Math.max(8, e.h) + pad * 2;
  const label = (e.title || roleName(e)).slice(0, 36);
  return raster(Math.max(w, 60) + 4, h + 28, (g) => {
    g.strokeStyle = K.lime; g.lineWidth = 2.2; rr(g, 2, 2, w, h, Math.min(10, h / 2)); g.stroke();
    g.fillStyle = 'rgba(201,240,61,.12)'; rr(g, 2, 2, w, h, Math.min(10, h / 2)); g.fill();
    g.font = `700 11px ${SANS}`; g.fillStyle = K.lime; g.textBaseline = 'top';
    g.fillText(label, 4, h + 9);
  });
}
function dotsBmp(win, els) {
  return raster(win.w, win.h, (g) => {
    g.fillStyle = 'rgba(201,240,61,.55)';
    for (const e of els) { g.beginPath(); g.arc(e.x - win.x + e.w / 2, e.y - win.y + e.h / 2, 2, 0, 7); g.fill(); }
  }, { halo: false });
}
/** 光标显示位置:预锁定时被目标轻轻吸过去 35%(弱磁力 —— 看得出吸住了,又知道手真正在哪) */
function updateCursorPos() {
  let x = S.x, y = S.y;
  if (S.target) { const cx = S.target.x + S.target.w / 2, cy = S.target.y + S.target.h / 2; x += (cx - x) * 0.35; y += (cy - y) * 0.35; }
  S.cx = x; S.cy = y;
}
function drawHover() {
  const w = S.mode === 'idle' && deskOn ? S.hover : null;
  const key = w ? `${w.wid}|${w.x}|${w.y}|${w.w}|${w.h}` : '';
  if (key === S._hoverKey) return;
  S._hoverKey = key;
  if (f.has('hover')) f.exit('hover', { mode: 'dust', dur: 0.35 });
  if (w) f.set('hover', outlineBmp(w.w, w.h, K.white, 1.4, 0.55, false), { x: w.x - 6, y: w.y - 6, z: 2, noHand: true, enter: { mode: 'scatter', dur: 0.35, sweep: 0.1 } });
}
function drawCaptured(enter) {
  const w = S.win; if (!w) return;
  f.set('win', outlineBmp(w.w, w.h, K.lime, 2, 0.9, true), { x: w.x - 6, y: w.y - 6, z: 3, noHand: true,
    enter: enter ? { mode: 'point', from: [S.x, S.y], dur: 0.55, sweep: 0.25, tint: rgb(K.lime) } : null });
  if (S.els.length) f.set('dots', dotsBmp(w, S.els), { x: w.x, y: w.y, z: 3, noHand: true, enter: enter ? { mode: 'scatter', dur: 0.5, sweep: 0.3 } : null });
}
let targetKey = '';
function drawTarget() {
  const e = S.target;
  const key = e ? `${e.id}|${e.x}|${e.y}` : '';
  if (key === targetKey) return;
  targetKey = key;
  if (f.has('target')) f.exit('target', { mode: 'dust', dur: 0.25 });
  if (e) f.set('target', targetBmp(e), { x: e.x - 7, y: e.y - 7, z: 5, noHand: true, enter: { mode: 'assemble', dur: 0.3, sweep: 0.15, tint: rgb(K.lime) } });
}
function clearCaptured(mode = 'dust') {
  for (const id of ['win', 'dots', 'target']) if (f.has(id)) f.exit(id, { mode, dur: 0.45 });
  targetKey = ''; S._hoverKey = '';
}
const rectDist = (e, x, y) => Math.hypot(Math.max(e.x - x, 0, x - (e.x + e.w)), Math.max(e.y - y, 0, y - (e.y + e.h)));
function pickTarget() {
  if (S.mode !== 'captured' || !S.els.length) { S.target = null; return; }
  if (S.lock && Math.hypot(S.x - S.lock.x, S.y - S.lock.y) < 70) { S.target = S.lock.e; return; }
  S.lock = null;
  let best = null, bd = Infinity;
  for (const e of S.els) { const d = rectDist(e, S.x, S.y); if (d < bd) { bd = d; best = e; } }
  if (bd > MAGNET) { S.target = null; return; }
  if (S.target && S.target !== best && rectDist(S.target, S.x, S.y) <= bd + HYST) return;
  S.target = best;
}
function cycle(dir) {
  const cur = S.target; if (!cur) return;
  const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2, sgn = dir === 'right' ? 1 : -1;
  let best = null, bs = Infinity;
  for (const e of S.els) {
    if (e === cur) continue;
    const ex = e.x + e.w / 2, ey = e.y + e.h / 2, dx = (ex - cx) * sgn, dy = Math.abs(ey - cy);
    if (dx <= 2) continue;
    const s = dx + dy * 2.5;
    if (s < bs) { bs = s; best = e; }
  }
  if (best) { S.target = best; S.lock = { e: best, x: S.x, y: S.y }; drawTarget(); dlog('cycle ' + dir + ' -> ' + (best.title || best.role)); }
}
async function capture() {
  const w = S.hover; if (!w || S.mode !== 'idle' || !deskOn) return;
  S.mode = 'scanning'; S.win = w; drawHover(); drawCaptured(true);
  await call({ cmd: 'raise', pid: w.pid });
  const r = await call({ cmd: 'scan', pid: w.pid, x: w.x, y: w.y, w: w.w, h: w.h });
  dlog(`scan ${w.owner}: ok=${r.ok} n=${r.count} ${r.ms}ms visited=${r.visited}${r.truncated ? ' (truncated)' : ''} ${r.error || ''}`);
  if (S.mode !== 'scanning') return;
  if (!r.ok) { S.mode = 'idle'; S.win = null; clearCaptured(); if (r.error === 'not_trusted') call({ cmd: 'trust', prompt: true }); return; }
  S.els = r.elements || []; S.mode = 'captured';
  drawCaptured(false); pickTarget(); drawTarget();
}
async function release() {
  S.mode = 'idle'; S.win = null; S.els = []; S.target = null; S.lock = null;
  clearCaptured(); await call({ cmd: 'release' });
}
async function activate() {
  const e = S.target; if (!e) return;
  f.exit('target', { mode: 'absorb', to: [e.x + e.w / 2, e.y + e.h / 2], dur: 0.35, tint: rgb(K.lime) }); targetKey = '';
  const r = await call({ cmd: e.kind === 'input' ? 'focus' : 'press', id: e.id });
  dlog(`${e.kind === 'input' ? 'focus' : 'press'} ${roleName(e)} "${e.title}" -> ${r.ok ? r.via || 'ok' : r.error}`);
  setTimeout(async () => {
    if (S.mode !== 'captured' || !S.win) return;
    const w = await call({ cmd: 'windowAt', x: S.win.x + S.win.w / 2, y: S.win.y + 12 });
    const win = w && w.window;
    if (!win || win.pid !== S.win.pid) { release(); return; }
    S.win = win;
    const r2 = await call({ cmd: 'scan', pid: win.pid, x: win.x, y: win.y, w: win.w, h: win.h });
    if (r2.ok && S.mode === 'captured') { S.els = r2.elements || []; drawCaptured(false); S.target = null; pickTarget(); drawTarget(); }
  }, 450);
}
async function queryHover() {
  const now = performance.now();
  if (!deskOn || S.mode !== 'idle' || now - S.lastQuery < 140 || Math.hypot(S.x - S.qx, S.y - S.qy) < 6) return;
  S.lastQuery = now; S.qx = S.x; S.qy = S.y;
  const r = await call({ cmd: 'windowAt', x: Math.round(S.x), y: Math.round(S.y) });
  if (S.mode === 'idle') { S.hover = (r && r.window) || null; drawHover(); }
}

/* ── 显示 / 藏起光标层窗口 ─────────────────────────────────────────────── */
let shown = true, hideT = 0;
function setShown(v) {
  if (v === shown) return;
  shown = v; invoke('desk_overlay_visible', { show: v }).catch(() => {});
}
setTimeout(() => { if (S.x < 0 && S.mode === 'idle') setShown(false); }, 800);

/* ── 手势(全屏唯一算手势的地方)──────────────────────────────────────── */
attachGestures(T.event.listen, (e) => {
  forward(e);                                             // 同一份事件给其它窗口
  if (e.type === 'found' || e.type === 'hand') { clearTimeout(hideT); if (!shown) setShown(true); }
  switch (e.type) {
    case 'hand': {
      S.x = e.x; S.y = e.y; S.pose = e.pose; S.lostAt = 0;
      if (typeof e.rate === 'number') S.rate = e.rate;
      if (typeof e.frozen === 'boolean') S.frozen = e.frozen;
      if (e.pose === 'fist') {
        if (!S.fistAt) S.fistAt = performance.now();
        if (!S.fistFired && performance.now() - S.fistAt > 120) { S.fistFired = true; if (deskOn) { if (S.mode === 'captured') release(); else if (S.mode === 'idle') capture(); } }
      } else { S.fistAt = 0; S.fistFired = false; }
      if (S.mode === 'idle') queryHover(); else pickTarget();
      drawTarget(); updateCursorPos();
      break;
    }
    case 'hold': S.hold = e.progress; S.holdKind = e.kind; break;
    case 'freeze': S.frozen = e.frozen; break;
    case 'speed': S.rate = e.rate; break;
    case 'lost':
      S.lostAt = performance.now(); S.x = -1; S.cx = -1; S.hold = 0;
      if (S.mode === 'idle') { S.hover = null; drawHover(); }
      setTimeout(() => { if (S.lostAt && performance.now() - S.lostAt > 7900 && S.mode === 'captured') release().then(() => setShown(false)); }, 8000);
      clearTimeout(hideT);
      hideT = setTimeout(() => { if (S.x < 0 && S.mode === 'idle' && !ghost.sparks.length) setShown(false); }, 1200);
      break;
    case 'pinchstart':
      if (S.mode === 'captured' && S.win && e.y >= S.win.y && e.y <= S.win.y + 36 && e.x >= S.win.x && e.x <= S.win.x + S.win.w) S.drag = { dx: 0, dy: 0, t: 0 };
      break;
    case 'drag':
      if (S.drag) {
        S.drag.dx += e.dx; S.drag.dy += e.dy;
        const now = performance.now();
        if (now - S.drag.t > 50 && (Math.abs(S.drag.dx) + Math.abs(S.drag.dy)) >= 1) {
          const dx = Math.round(S.drag.dx), dy = Math.round(S.drag.dy); S.drag.dx -= dx; S.drag.dy -= dy; S.drag.t = now;
          call({ cmd: 'move', dx, dy }).then((r) => { if (r.ok && S.win) { const ox = r.x - S.win.x, oy = r.y - S.win.y; S.win = { ...S.win, x: r.x, y: r.y };
            S.els = S.els.map((el) => ({ ...el, x: el.x + ox, y: el.y + oy })); f.move('win', S.win.x - 6, S.win.y - 6, 0); f.move('dots', S.win.x, S.win.y, 0); } });
        }
      }
      break;
    case 'pinchend':
      if (S.drag) { S.drag = null; break; }
      if (e.tap && S.mode === 'captured') activate();
      break;
    case 'swipe':
      if (S.mode === 'captured') cycle(e.dir);
      break;
  }
}, { screen: [window.screen.width, window.screen.height], swipeK: 0.9, onFrame });

/** 调试入口(浏览器里没有手、没有 terse-desk:用它们喂假的窗口和元素) */
window.__desk = { S, pickTarget, cycle, capture, release, activate, drawCaptured, drawTarget, drawHover, onFrame, ghost,
  setDesk: (v) => { deskOn = !!v; }, updateCursorPos, stats: () => f.stats() };
dlog('overlay ready ' + innerWidth + 'x' + innerHeight);
