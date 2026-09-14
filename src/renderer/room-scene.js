/**
 * room-scene.js — 点一座楼,走进去。
 *
 * 这里是**把房子盖起来、点上灯、让人走**:
 *
 *   room-interior.js  平面图(哪几间屋子、多大多高、门在哪)和装修文法(按代码挑件)
 *   room-arch.js      建筑:地、墙、顶、柱、灯具、院子、屋顶、天
 *   room-furniture.js 陈设:一个文件一件家具,一个符号一件东西
 *   room-surface.js   把上面这些"面"在 GPU 上长成几百万颗细点,带法线、材质、光照
 *
 * 一切仍是粒子。实物是 GPU 上长出来的细点(不透明、互相遮挡、会被灯照亮);灯、火、
 * 星、数据光、import 连线是发光点(加色 + bloom),和外面那座城是同一种光。
 *
 * 每间屋子**因代码而不同**:风格来自整座楼,但地、墙、顶、灯挑哪一件、染什么颜色、
 * 多高、家具怎么坐,都来自这个目录自己的文件(signatureOf)—— 谁 import 谁,谁就坐在
 * 谁旁边,地上一道淡淡的光把它们连起来。
 *
 * ⚠ 不自己开 WebGL。`createRoom` 借调用方的 renderer —— 手机上那就是引擎自己的那一个
 * (iOS Safari 只肯给一页有限几个活的 WebGL 上下文)。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { interiorOf, interiorVariants, signatureOf, mix, layoutOf, layoutFor, fileLight, DOOR_W, PAD } from './room-interior.js';
import { Surfaces, makeUniforms, setScene } from './room-surface.js';
import { buildArchitecture, coloursOf, sky } from './room-arch.js';
import { FURN, ROLE, ROLE_ICON, ITEM_ICON, WORDS_EN, roleOfName, furnSize } from './room-furniture.js';

const TAU = Math.PI * 2;
/** 一间屋子最多单独摆出几件家具;其余的成捆放上储物架(见 FURN.archive)。 */
const CAP_HALL = 48, CAP_ROOM = 22;

/* 地图和图例里每种家具的颜色。只在界面上用 —— 场景里家具的颜色是房子的料。 */
export const ROLE_COLOR = {
  entry: '#ffd166', component: '#7dd3fc', hook: '#c4b5fd', test: '#86efac', types: '#93c5fd',
  config: '#fca5a5', docs: '#fde68a', style: '#f0abfc', asset: '#fdba74', data: '#a5f3fc',
  source: '#e5e7eb', archive: '#6b7280',
};

/** 界面上的词。英文兜底,宿主传 opts.words 覆盖(和 WORDS_EN 同一个对象)。 */
export const UI_EN = {
  ui_files: '{n} files', ui_lines: '{n} lines', ui_used_by: 'used by {n} files', ui_uses: 'uses {n} files',
  ui_defines: 'defines {n}', ui_more: '+{n} smaller files',
  ui_room_is: 'a room is a directory', ui_court_is: 'the courtyard is the directory itself',
  ui_no_symbols: 'Furniture only — this building has not been deep-scanned, so nothing is on the shelves yet.',
  ui_truncated: 'The biggest files are furnished; the rest are on the archive racks.',
  ui_uses_list: 'Uses', ui_used_by_list: 'Used by',
  ui_day: 'Day', ui_night: 'Night', ui_legend: 'Legend',
  why_tests: 'tiled and cool — mostly tests', why_docs: 'wood and warm — mostly docs',
  why_ui: 'bright like a gallery — mostly UI', why_config: 'plain and slate — mostly config',
  why_classes: 'coffered ceiling — lots of classes and types', why_functions: 'open beams — mostly loose functions',
  why_many: 'a big chandelier — many files', why_few: 'candlelight — only a few files',
  lg_title: 'How to read this building',
  lg_room: 'Room = a directory · doorway = its sub-directory',
  lg_furn: 'Furniture = a file · the kind of furniture says what the file does',
  lg_item: 'Things on the furniture = what the file defines',
  lg_size: 'Taller furniture = more code · colour of the things = language',
  lg_threads: 'Glowing threads on the floor = one file imports the other',
  lg_roles: 'Furniture', lg_items: 'On the shelves',
};

const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
const fill = (s, n) => String(s).replace('{n}', n);

/* 样式跟着模块走:宿主可能是原型页、手机 app、Mac 壁纸,各有各的样式表。只注入一次。 */
const CSS = `
.room-label{position:fixed;transform:translate(-50%,-100%);color:#eef4f2;font:600 11px/1.25 -apple-system,BlinkMacSystemFont,sans-serif;
  background:rgba(6,8,12,.72);padding:3px 8px 4px;border-radius:7px;pointer-events:none;white-space:nowrap;z-index:2;
  border:1px solid rgba(255,255,255,.14);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.room-label i{font-style:normal;margin-right:4px}.room-label small{display:block;font-weight:500;opacity:.62;font-size:10px}
.room-label.sel{border-color:#6ee7b7;box-shadow:0 0 0 1px #6ee7b7}
.room-plaque{position:fixed;transform:translate(-50%,-100%);pointer-events:none;z-index:2;text-align:center;white-space:nowrap;
  font:700 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#1a1206;background:linear-gradient(#f7e2a8,#d9b766);
  padding:5px 12px 6px;border-radius:4px;border:2px solid #7a5a22;box-shadow:0 4px 14px rgba(0,0,0,.45)}
.room-plaque small{display:block;font-weight:600;font-size:10px;opacity:.72}
.room-item{position:fixed;transform:translate(-50%,-110%);pointer-events:none;z-index:3;white-space:nowrap;
  font:600 10.5px/1.2 ui-monospace,SFMono-Regular,monospace;color:#0b0f0d;background:#c9f03d;padding:2px 6px;border-radius:5px}
.room-toast{position:absolute;left:50%;top:13%;transform:translate(-50%,-50%);pointer-events:none;z-index:4;text-align:center;
  font:700 18px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;text-shadow:0 2px 16px rgba(0,0,0,.8);transition:opacity .5s}
.room-toast small{display:block;font-size:12px;font-weight:600;opacity:.8;margin-top:4px}
.room-side{position:absolute;right:12px;top:calc(64px + env(safe-area-inset-top,0px));z-index:4;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.room-map{position:static!important;inset:auto!important;width:150px!important;height:150px!important;border-radius:12px;background:rgba(6,8,12,.62);border:1px solid rgba(255,255,255,.12)}
.room-btns{display:flex;gap:6px}
.room-btn{font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;color:#eef4f2;background:rgba(6,8,12,.66);cursor:pointer;
  border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:6px 11px}
.room-legend{width:min(300px,calc(100vw - 24px));max-height:52vh;overflow:auto;background:rgba(6,8,12,.86);color:#e8eeec;border-radius:12px;
  border:1px solid rgba(255,255,255,.12);padding:12px 14px;font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
.room-legend b{display:block;font-size:13px;margin:0 0 6px}.room-legend h4{margin:10px 0 4px;font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:.04em}
.room-legend p{margin:0 0 3px}.room-legend .row{display:flex;gap:8px;align-items:center;margin:2px 0}
.room-legend .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
@media (max-width:520px){.room-map{width:112px!important;height:112px!important}.room-toast{font-size:15px}}
.room-joy{position:absolute;left:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));width:110px;height:110px;border-radius:50%;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);touch-action:none;z-index:3}
.room-joy i{position:absolute;left:35px;top:35px;width:40px;height:40px;border-radius:50%;background:rgba(110,231,183,.5)}`;
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('room-scene-css')) return;
  const s = document.createElement('style');
  s.id = 'room-scene-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/** 现在该是白天还是夜里:看的人自己那边的钟。7 点到 18 点是白天。 */
export function autoTime(now = new Date()) { const h = now.getHours(); return h >= 7 && h < 18 ? 'day' : 'night'; }

/* 发光点的着色器:点的大小按世界尺寸(米),种类决定什么时候亮。 */
const GLOW_VS = `
precision highp float;
attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aTwk; attribute float aKind;
uniform float uTime, uPx, uNight, uFogK;
varying vec3 vColor; varying float vA;
void main(){
  vec3 p = position;
  p.y += sin(uTime * 0.8 + aPhase * 6.2831) * 0.01 * aTwk;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(aSize * uPx / max(0.2, d), 1.0, 48.0);
  // 1 灯:夜里才亮;3 天光:白天才有;2 数据光:一直亮,白天淡一点
  float on = aKind < 1.5 ? uNight : aKind < 2.5 ? mix(0.4, 1.0, uNight) : 1.0 - uNight;
  float tw = 0.75 + 0.25 * sin(uTime * 1.9 + aPhase * 19.0);
  vA = on * mix(1.0, tw, aTwk) * exp(-d * d * uFogK * 0.3);
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FS = `
precision highp float;
varying vec3 vColor; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vColor * exp(-r2 * 12.0) * 0.55 * vA, 1.0);
}`;

/**
 * 盖好一座楼的里面,交回一个能走的场景。
 *
 * @param {THREE.WebGLRenderer} renderer 借来的 —— 不 dispose 它,只在走的时候用它画
 * @param {object} dir  胶囊里的一个目录:{ name, files, bytes, lang, kids, leaves, detail? }
 * @param {object} [opts]
 *   style   外面那座城的风格 id(胶囊的 `style`)。格局跟着它走(唐宋 → 四合院,江户 → 庭院)
 *   layout  强制格局:'hall' | 'siheyuan' | 'garden'
 *   time    'day' | 'night' | 'auto'(默认 auto:看的人那边的钟)
 *   host    标签、地图、图例挂在哪个元素里(默认 body)
 *   input   拖动视角 / 点家具听哪个元素(默认 renderer 的画布)
 *   budget  0.25–1。决定点有多密(1 ≈ 2.8cm 一颗,手机上 0.55 ≈ 4cm)
 *   pixelRatio  走的时候用的像素比(默认 min(2, dpr));走出来还原
 *   words   翻好的词(WORDS_EN + UI_EN 的键)
 *   onHere(info)  走进了另一间屋子
 *   onPick(prop, desc)  点了一件家具;desc 是 describe(prop) 的结果
 */
export function createRoom(renderer, dir, opts = {}) {
  injectCss();
  dir = dir || {};
  const B = Math.max(0.25, Math.min(1, +opts.budget || 1));
  const styleId = opts.style || dir.style || 'modern';
  const layout = opts.layout || layoutFor(styleId);
  const L = layoutOf(dir, { layout });
  const { hall, rooms, doors } = L;
  const dirLang = dir.lang || '';
  const host = opts.host || document.body;
  const input = opts.input || renderer.domElement;
  const w = Object.assign({}, WORDS_EN, UI_EN, opts.words || {});
  const spacing = opts.spacing || (B >= 0.9 ? 0.028 : B >= 0.6 ? 0.036 : 0.045);
  const S = new Surfaces(spacing);
  const U = makeUniforms();

  /* ── 发光点 ── */
  const MAXL = Math.round(180000 * B) + 30000;
  const lPos = new Float32Array(MAXL * 3), lCol = new Float32Array(MAXL * 3), lSiz = new Float32Array(MAXL);
  const lPha = new Float32Array(MAXL), lTwk = new Float32Array(MAXL), lKind = new Float32Array(MAXL);
  let NL = 0;
  /** 一颗发光点。size 是世界直径(米);kind 1 夜里亮的灯、2 数据光、3 白天的光。 */
  const G = (x, y, z, c, size, tw = 0.5, kind = 2) => {
    if (NL >= MAXL) return;
    const i = NL++;
    lPos[i * 3] = x; lPos[i * 3 + 1] = y; lPos[i * 3 + 2] = z;
    lCol[i * 3] = c[0]; lCol[i * 3 + 1] = c[1]; lCol[i * 3 + 2] = c[2];
    // 闪烁相位按下标哈希,不用 Math.random —— 这个仓库里的城市一律可复现。
    lSiz[i] = size; lPha[i] = (Math.imul(i, 2654435761) >>> 0) / 4294967296; lTwk[i] = tw; lKind[i] = kind;
  };

  const lights = [], feet = [];
  const blocks = L.blocks;
  const block = (x, z, rx, rz) => blocks.push({ x, z, rx, rz: rz || rx });
  const lit = (x, y, z, r, col, k) => lights.push({ x, y, z, r, col, k });

  /* ── 盖起来:每间屋子先读自己的代码,再按代码装修 ───────────────────────── */
  const keyOf = (r) => (r.isHall ? '\0hall' : r.name);
  const decor = new Map(), sigs = new Map(), cols = new Map();
  for (const r of rooms) {
    const files = L.byRoom.get(r.isHall ? '' : r.name) || [];
    const sig = signatureOf(files, dirLang);
    const ip = interiorOf(styleId, r.name, sig);
    decor.set(keyOf(r), ip); sigs.set(keyOf(r), sig);
    const rnd = () => ip.rnd.f();
    cols.set(keyOf(r), buildArchitecture(S, G, {
      r, ip, doors, isHall: !!r.isHall, lit, block, rnd, seed: ip.rnd.f() * 10,
      roof: !r.isHall && L.open, frames: !!r.isHall,
    }));
  }
  const kitOf = (r) => decor.get(keyOf(r));
  if (L.open) { const ip = kitOf(hall); sky(G, () => ip.rnd.f()); }

  /* ── 陈设:一个文件一件家具 ──────────────────────────────────────────────
     靠墙的(柜、书架、画、抽屉)沿墙一排,朝屋里;站在中间的(实验台、展柜、绘图桌)
     排成几行,朝着进门的方向;入口文件是尽头正中那座主案。**坐次按 import**:先摆最
     重要的那个,之后每次挑和已经摆下的牵连最深的 —— 互相引用的文件就是邻座。 */
  const props = [];
  const byIdx = new Map();
  const adj = new Map();
  for (const [i, j] of L.edges) {
    if (!adj.has(i)) adj.set(i, new Set()); if (!adj.has(j)) adj.set(j, new Set());
    adj.get(i).add(j); adj.get(j).add(i);
  }
  function slotsFor(r) {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const inSide = r.isHall ? 'S' : ({ N: 'S', S: 'N', E: 'W', W: 'E' })[r.side];
    const back = ({ S: 'N', N: 'S', E: 'W', W: 'E' })[inSide];
    const faceIn = { N: [0, 1], S: [0, -1], E: [-1, 0], W: [1, 0] };
    const inset = r.open ? (r.kind === 'garden' ? 1.1 : 1.6) : 0.72;
    const wallSlots = [], floorSlots = [];
    let center = null;
    // 沿墙一圈,顺时针 —— 相邻的位子就是墙上相邻的家具
    for (const s of ['N', 'E', 'S', 'W']) {
      const horiz = s === 'N' || s === 'S';
      const lo = horiz ? r.x0 : r.z0, hi = horiz ? r.x1 : r.z1, len = hi - lo;
      const n = Math.floor((len - 2.4) / 1.9);
      const us = [];
      for (let i = 0; i <= n; i++) us.push(lo + 1.2 + (n ? i * (len - 2.4) / n : (len - 2.4) / 2));
      if (s === 'S' || s === 'W') us.reverse();
      for (const u of us) {
        const X = horiz ? u : (s === 'W' ? r.x0 + inset : r.x1 - inset);
        const Z = horiz ? (s === 'N' ? r.z0 + inset : r.z1 - inset) : u;
        if (doors.some((d) => Math.hypot(d.cx - X, d.cz - Z) < 2.0)) continue;
        if (blocks.some((b) => Math.hypot(b.x - X, b.z - Z) < Math.max(b.rx, b.rz) + 0.8)) continue;
        const [fx, fz] = faceIn[s];
        const slot = { X, Z, fx, fz, wall: s };
        if (s === back && !center && Math.abs(u - (horiz ? cx : cz)) < 1.3) { center = Object.assign({}, slot, { X: horiz ? cx : X + fx * 1.3, Z: horiz ? Z + fz * 1.3 : cz, wall: null }); continue; }
        wallSlots.push(slot);
      }
    }
    if (!center) {
      const [fx, fz] = faceIn[back];
      center = { X: back === 'E' ? r.x1 - 2.2 : back === 'W' ? r.x0 + 2.2 : cx, Z: back === 'N' ? r.z0 + 2.2 : back === 'S' ? r.z1 - 2.2 : cz, fx, fz };
    }
    const fin = faceIn[back];
    const m = r.open ? 3.4 : 2.9;
    for (let z = r.z0 + m; z <= r.z1 - m + 0.01; z += 2.5) for (let x = r.x0 + m; x <= r.x1 - m + 0.01; x += 2.7) {
      const axial = (back === 'N' || back === 'S') ? Math.abs(x - cx) < 1.5 : Math.abs(z - cz) < 1.5;
      if (axial) continue;
      if (r.kind === 'court' && (Math.abs(x - cx) < 1.3 || Math.abs(z - cz) < 1.3)) continue;
      if (Math.hypot(x - center.X, z - center.Z) < 2.6) continue;
      if (blocks.some((b) => Math.hypot(b.x - x, b.z - z) < Math.max(b.rx, b.rz) + 1.1)) continue;
      floorSlots.push({ X: x, Z: z, fx: -fin[0], fz: -fin[1] });
    }
    return { center, wallSlots, floorSlots };
  }

  function placeFiles(r, files) {
    const ip = kitOf(r), C = cols.get(keyOf(r));
    const mat = { wood: C.timber, stone: C.stone, trim: C.accent };
    const cap = r.isHall ? CAP_HALL : CAP_ROOM;
    const imp = (f) => f.imp * 3 + Math.log2(1 + f.bytes);
    const ranked = files.map((f) => Object.assign({}, f, { role: f.role || roleOfName(f.name, f.sub) })).sort((a, b) => imp(b) - imp(a));
    const { center, wallSlots, floorSlots } = slotsFor(r);
    const room = Math.min(cap, wallSlots.length + floorSlots.length + 1);
    const hidden = ranked.length > room ? ranked.slice(room - 1) : [];
    let shown = hidden.length ? ranked.slice(0, room - 1) : ranked;
    // 坐次:互相 import 的挨着坐
    if (L.edges.length && shown.length > 2) {
      const left = new Set(shown.map((_, i) => i)), seat = [0];
      left.delete(0);
      while (left.size) {
        let best = -1, bw = -1;
        for (const c of left) {
          const nb = adj.get(shown[c].i);
          let wgt = 0;
          if (nb) for (const s of seat.slice(-4)) if (nb.has(shown[s].i)) wgt += 1 + seat.length / 100;
          if (wgt > bw || (wgt === bw && c < best)) { bw = wgt; best = c; }
        }
        left.delete(best); seat.push(best);
      }
      shown = seat.map((i) => shown[i]);
    }
    const take = (pool) => (pool.length ? pool.shift() : null);
    let usedCenter = false;
    const put = (f, slot) => {
      const lang = fileLight(f.name, f.lang || dirLang);
      const items = (f.sym || []).map((s) => ({ name: String(s[0] || ''), kind: ITEM_ICON[s[1]] ? s[1] : 'fn', line: +s[2] || 0, exported: !!s[3] }));
      const { h, w: wd } = furnSize({ lines: f.lines, bytes: f.bytes, items });
      const furn = FURN[(ROLE[f.role] || ROLE.source).furn] || FURN.cabinet;
      const res = furn({ X: slot.X, Z: slot.Z, fx: slot.fx, fz: slot.fz, w: wd, h, items, lang, mat, rnd: () => ip.rnd.f(),
                         indoor: !r.open, seed: ip.rnd.f() * 10, extra: f.extra }, S, G);
      const p = { x: slot.X, z: slot.Z, top: res.top, slots: res.slots, name: f.name, path: f.path, role: f.role, bytes: f.bytes,
                  lines: f.lines, lang: f.lang || '', langRgb: lang, sym: f.sym, imp: f.imp, out: f.out, dir: f.sub || L.name,
                  room: r.isHall ? '' : r.name, hiddenNames: f.hiddenNames || null, w: wd, i: f.i };
      props.push(p);
      if (f.i != null && f.i >= 0) byIdx.set(f.i, p);
      const onWall = !!slot.wall;
      const cx = slot.X - slot.fx * (onWall ? 0.2 : 0), cz = slot.Z - slot.fz * (onWall ? 0.2 : 0);
      const along = Math.max(0.45, wd * 0.5), deep = onWall ? 0.3 : along;
      block(cx, cz, Math.max(0.5, along), Math.max(0.5, along));
      feet.push({ x: cx, z: cz, hw: Math.abs(slot.fz) > 0.5 ? along : deep, hd: Math.abs(slot.fz) > 0.5 ? deep : along });
    };
    for (const f of shown) {
      const pref = (ROLE[f.role] || ROLE.source).place;
      let slot = null;
      if (pref === 'center' && !usedCenter) { slot = center; usedCenter = true; }
      else if (pref === 'wall') slot = take(wallSlots) || take(floorSlots);
      else slot = take(floorSlots) || take(wallSlots);
      if (!slot && !usedCenter) { slot = center; usedCenter = true; }
      if (!slot) break;
      put(f, slot);
    }
    if (hidden.length) {
      const slot = take(wallSlots) || take(floorSlots) || (!usedCenter ? center : null);
      if (slot) put({ name: fill(w.ui_more, hidden.length), role: 'archive', bytes: hidden.reduce((a, f) => a + f.bytes, 0), lines: 0, sym: [], imp: 0, out: 0,
                      extra: hidden.length, hiddenNames: hidden.map((f) => f.name), sub: r.isHall ? '' : r.name, lang: '', i: -1 }, slot);
    }
  }
  for (const [k, files] of L.byRoom) placeFiles(k ? rooms.find((r) => r.name === k && !r.isHall) || hall : hall, files);

  /* import 连线:地上一道淡淡的弧,从引用的一方到被引用的一方,颜色从一门语言过渡到
     另一门。一眼看过去,哪几件家具是一伙的就在地上。 */
  const thread = (a, b, bright, emit, col) => {
    const n = Math.max(10, Math.round(Math.hypot(a.x - b.x, a.z - b.z) * (bright ? 22 : 10)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const c = col || mix(a.langRgb || [1, 1, 1], b.langRgb || [1, 1, 1], t);
      emit(a.x + (b.x - a.x) * t, 0.03 + Math.sin(t * Math.PI) * (bright ? 0.5 : 0.18), a.z + (b.z - a.z) * t,
           bright ? c : [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55], bright ? 0.05 : 0.032, bright ? 0.4 : 0.2, 2);
    }
  };
  for (const [i, j] of L.edges) { const a = byIdx.get(i), b = byIdx.get(j); if (a && b) thread(a, b, false, G); }

  setScene(U, { lights, rooms: rooms.map((r) => ({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, h: r.h, open: r.open })), feet,
                court: L.open ? { x0: hall.x0, z0: hall.z0, x1: hall.x1, z1: hall.z1, h: 4.4 } : null });

  /* ── 渲染 ── */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
  const group = S.build(U);
  scene.add(group);

  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute('position', new THREE.BufferAttribute(lPos.subarray(0, NL * 3), 3));
  lGeo.setAttribute('aColor', new THREE.BufferAttribute(lCol.subarray(0, NL * 3), 3));
  lGeo.setAttribute('aSize', new THREE.BufferAttribute(lSiz.subarray(0, NL), 1));
  lGeo.setAttribute('aPhase', new THREE.BufferAttribute(lPha.subarray(0, NL), 1));
  lGeo.setAttribute('aTwk', new THREE.BufferAttribute(lTwk.subarray(0, NL), 1));
  lGeo.setAttribute('aKind', new THREE.BufferAttribute(lKind.subarray(0, NL), 1));
  const lMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending });
  const glow = new THREE.Points(lGeo, lMat);
  glow.frustumCulled = false; glow.renderOrder = 1;
  scene.add(glow);
  // 选中的那件家具:它用到的(绿)和用到它的(琥珀)连成亮线。选中时重建,一件家具最多几十条。
  let selGlow = null;
  const selMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  function highlight(p) {
    if (selGlow) { scene.remove(selGlow); selGlow.geometry.dispose(); selGlow = null; }
    if (!p || p.i == null || p.i < 0) return;
    const pts = [];
    const emit = (x, y, z, c, s, tw, k) => pts.push([x, y, z, c, s, tw, k]);
    for (const [i, j] of L.edges) {
      if (i === p.i && byIdx.get(j)) thread(p, byIdx.get(j), true, emit, [0.79, 0.94, 0.24]);
      else if (j === p.i && byIdx.get(i)) thread(byIdx.get(i), p, true, emit, [1, 0.72, 0.3]);
    }
    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    const f32 = (k, fn) => { const a = new Float32Array(pts.length * k); pts.forEach((q, n) => fn(a, n, q)); return a; };
    g.setAttribute('position', new THREE.BufferAttribute(f32(3, (a, n, q) => { a[n * 3] = q[0]; a[n * 3 + 1] = q[1]; a[n * 3 + 2] = q[2]; }), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(f32(3, (a, n, q) => { a[n * 3] = q[3][0]; a[n * 3 + 1] = q[3][1]; a[n * 3 + 2] = q[3][2]; }), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(f32(1, (a, n, q) => { a[n] = q[4]; }), 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(f32(1, (a, n) => { a[n] = n / pts.length; }), 1));
    g.setAttribute('aTwk', new THREE.BufferAttribute(f32(1, (a, n, q) => { a[n] = q[5]; }), 1));
    g.setAttribute('aKind', new THREE.BufferAttribute(f32(1, () => {}).fill(2), 1));
    selGlow = new THREE.Points(g, selMat);
    selGlow.frustumCulled = false; selGlow.renderOrder = 2;
    scene.add(selGlow);
  }

  const prevAutoClear = renderer.autoClear;
  const prevPR = renderer.getPixelRatio();
  const wantPR = opts.pixelRatio || Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const size0 = renderer.getSize(new THREE.Vector2());
  let W = size0.x || 1, H = size0.y || 1;
  if (wantPR !== prevPR) { renderer.setPixelRatio(wantPR); renderer.setSize(W, H, false); }
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.5, 0.45, 0.8);
  composer.addPass(bloom);

  /* ── 白天 / 夜里 ── */
  const SKY_DAY = new THREE.Color(0.58, 0.68, 0.8), SKY_NIGHT = new THREE.Color(0.012, 0.016, 0.03);
  const IN_DAY = new THREE.Color(0.2, 0.2, 0.22);
  scene.background = new THREE.Color();
  let timeMode = opts.time === 'day' || opts.time === 'night' ? opts.time : autoTime();
  let night = timeMode === 'night' ? 1 : 0;
  function applyTime() {
    U.uNight.value = night;
    scene.background.copy(L.open ? SKY_DAY : IN_DAY).lerp(SKY_NIGHT, night);
    U.uFog.value.copy(L.open ? scene.background : SKY_DAY.clone().lerp(SKY_NIGHT, night));
    U.uFogK.value = (L.open ? 0.00012 : 0.0003) * (1 - night) + 0.0005 * night;
    // 露天的院子白天整片是天光,曝光低一点,不然白砂和白墙一起烧成白的
    U.uExposure.value = (L.open ? 0.8 : 0.92) + night * (L.open ? 0.3 : 0.18);
    bloom.strength = 0.12 + night * 0.5;
    bloom.threshold = 0.9 - night * 0.3;
  }

  /* ── 走 ── */
  let yaw = L.start.yaw, pitch = -0.04, px = L.start.x, pz = L.start.z, t = 0;
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  const keys = new Set();
  const move = { x: 0, z: 0 };
  const offs = [];
  const on = (el, type, fn, o) => { el.addEventListener(type, fn, o); offs.push(() => el.removeEventListener(type, fn, o)); };
  const chrome = (e) => e.target && e.target.closest && e.target.closest('button, a, .room-joy, .room-side, .room-legend');

  const walkable = (x, z) => {
    let ok = false;
    for (const r of rooms) if (x > r.x0 + PAD && x < r.x1 - PAD && z > r.z0 + PAD && z < r.z1 - PAD) { ok = true; break; }
    if (!ok) for (const d of doors) if (x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1) { ok = true; break; }
    if (!ok) return false;
    for (const b of blocks) if (((x - b.x) / b.rx) ** 2 + ((z - b.z) / b.rz) ** 2 < 1) return false;
    return true;
  };
  const roomAt = (x, z) => rooms.find((r) => !r.isHall && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) || hall;

  on(input, 'pointerdown', (e) => {
    if (chrome(e)) return;
    dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY;
    try { input.setPointerCapture(e.pointerId); } catch (err) {}
  });
  const endDrag = () => { dragging = false; };
  on(window, 'pointerup', endDrag);
  on(window, 'pointercancel', endDrag);
  on(window, 'blur', () => { dragging = false; keys.clear(); });
  on(window, 'pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.0035;
    pitch = Math.max(-1.1, Math.min(1.1, pitch - (e.clientY - lastY) * 0.0035));
    lastX = e.clientX; lastY = e.clientY;
  });
  const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  on(window, 'keydown', (e) => { if (!typing(e)) keys.add(e.key.toLowerCase()); });
  on(window, 'keyup', (e) => keys.delete(e.key.toLowerCase()));

  const els = [];
  const el = (tag, cls, parent) => { const x = document.createElement(tag); if (cls) x.className = cls; (parent || host).appendChild(x); if (!parent) els.push(x); return x; };

  if (opts.joystick || (typeof window !== 'undefined' && 'ontouchstart' in window)) {
    const joy = el('div', 'room-joy');
    const stick = el('i', '', joy);
    let id = null;
    on(joy, 'touchstart', (e) => { id = e.changedTouches[0].identifier; e.preventDefault(); }, { passive: false });
    on(joy, 'touchmove', (e) => {
      for (const tt of e.changedTouches) {
        if (tt.identifier !== id) continue;
        const b = joy.getBoundingClientRect();
        const jx = Math.max(-1, Math.min(1, (tt.clientX - (b.left + b.width / 2)) / (b.width / 2)));
        const jy = Math.max(-1, Math.min(1, (tt.clientY - (b.top + b.height / 2)) / (b.height / 2)));
        stick.style.left = 35 + jx * 25 + 'px'; stick.style.top = 35 + jy * 25 + 'px';
        move.x = jx; move.z = jy; e.preventDefault();
      }
    }, { passive: false });
    const off = (e) => { for (const tt of e.changedTouches) if (tt.identifier === id) { id = null; move.x = move.z = 0; stick.style.left = stick.style.top = '35px'; } };
    on(joy, 'touchend', off); on(joy, 'touchcancel', off);
  }

  /* ── 读法:地图、图例、昼夜 ── */
  const side = el('div', 'room-side');
  const map = el('canvas', 'room-map', side);
  const btns = el('div', 'room-btns', side);
  const timeBtn = el('button', 'room-btn', btns);
  const legendBtn = el('button', 'room-btn', btns);
  timeBtn.type = legendBtn.type = 'button';
  legendBtn.textContent = '❔ ' + w.ui_legend;
  const legend = el('div', 'room-legend', side);
  legend.hidden = true;
  const usedRoles = [...new Set(props.map((p) => p.role))];
  const usedKinds = [...new Set(props.flatMap((p) => (p.sym || []).map((s) => (ITEM_ICON[s[1]] ? s[1] : 'fn'))))];
  legend.innerHTML = `<b>${w.lg_title}</b><p>🚪 ${w.lg_room}</p><p>🪑 ${w.lg_furn}</p><p>📕 ${w.lg_item}</p><p>📏 ${w.lg_size}</p>`
    + (L.edges.length ? `<p>✨ ${w.lg_threads}</p>` : '')
    + `<h4>${w.lg_roles}</h4>` + usedRoles.map((r) => `<div class="row"><span class="dot" style="background:${ROLE_COLOR[r]}"></span>${ROLE_ICON[r] || ''} <span><b style="display:inline;font-size:12px">${w['role_' + r] || r}</b> — ${w['furn_' + r] || ''}</span></div>`).join('')
    + (usedKinds.length ? `<h4>${w.lg_items}</h4>` + usedKinds.map((k) => `<div class="row">${ITEM_ICON[k]} <span>${w['shape_' + k]} = ${w['item_' + k]}</span></div>`).join('') : '')
    + (L.hasSymbols ? '' : `<p style="opacity:.7;margin-top:8px">${w.ui_no_symbols}</p>`)
    + (L.truncated ? `<p style="opacity:.7">${w.ui_truncated}</p>` : '');
  on(legendBtn, 'click', () => { legend.hidden = !legend.hidden; });
  const paintTimeBtn = () => { timeBtn.textContent = night > 0.5 ? '🌙 ' + w.ui_night : '☀️ ' + w.ui_day; };
  on(timeBtn, 'click', () => { setTime(night > 0.5 ? 'day' : 'night'); });

  const toast = el('div', 'room-toast');
  toast.style.opacity = '0';
  let toastUntil = 0;

  /* 门牌:每扇门上挂一块,写着门后是哪个子目录、有多少文件。 */
  const plaques = doors.map((d) => {
    const r = rooms.find((x) => x.name === d.room && !x.isHall);
    const p = el('div', 'room-plaque');
    p.innerHTML = `${d.room}/<small>${fill(w.ui_files, r ? r.files : 0)}</small>`;
    p.style.display = 'none';
    return { d, p, y: Math.min(3.0, (L.open ? 3.4 : hall.h) * 0.74) + 0.45 };
  });

  const rectOf = () => { try { return renderer.domElement.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0 }; } };
  const tmp = new THREE.Vector3();
  const toScreen = (x, y, z) => {
    tmp.set(x, y, z).project(camera);
    const rc = rectOf();
    return { x: rc.left + (tmp.x * 0.5 + 0.5) * W, y: rc.top + (-tmp.y * 0.5 + 0.5) * H, behind: tmp.z > 1 };
  };

  let selected = null;
  on(input, 'click', (e) => {
    if (chrome(e) || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    let best = null, bd = 90;
    for (const p of props) {
      const dist = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
      if (dist > 14) continue;
      const s = toScreen(p.x, (p.top[1] - 0.3) * 0.6, p.z);
      if (s.behind) continue;
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY) * (0.6 + dist / 20);
      if (d < bd) { bd = d; best = p; }
    }
    select(best);
    if (best && opts.onPick) { try { opts.onPick(best, describe(best)); } catch (err) {} }
  });
  function select(p) { selected = p || null; highlight(selected); }

  const labels = [], itemTags = [];
  const pool = (arr, cls) => (i) => { while (arr.length <= i) { const x = el('div', cls); x.style.display = 'none'; arr.push(x); } return arr[i]; };
  const labelAt = pool(labels, 'room-label'), itemAt = pool(itemTags, 'room-item');

  function step(dt, fwd, strafe) {
    const s = 3.4 * dt, sin = Math.sin(yaw), cos = Math.cos(yaw);
    const dx = (-sin * fwd + cos * strafe) * s, dz = (-cos * fwd - sin * strafe) * s;
    if (walkable(px + dx, pz)) px += dx;
    if (walkable(px, pz + dz)) pz += dz;
  }

  /** 这间屋子为什么长这样 —— 从装修挑件时记下的理由里拿,最多说两条。 */
  const whyOf = (r) => {
    const ip = kitOf(r);
    if (!ip) return [];
    const rs = [...new Set([ip.mood && ip.mood.why, ip.why.ceil, ip.why.light, ip.why.floor].filter(Boolean))];
    return rs.slice(0, 2).map((k) => w['why_' + k]).filter(Boolean);
  };
  const hereInfo = (r) => {
    const ip = kitOf(r);
    const base = L.name.replace(/\/?$/, '/');
    return { name: r.name, isHall: !!r.isHall, files: r.files, kind: r.kind, path: r.isHall ? base : base + r.name + '/', style: ip && ip.style.id, why: whyOf(r) };
  };
  let hereNow = null;

  /** 一件家具说的是什么 —— 卡片、图例都从这里拿词,宿主只管排版。 */
  function describe(p) {
    const stats = [];
    if (p.lines) stats.push(fill(w.ui_lines, p.lines));
    if (p.bytes) stats.push(fmtBytes(p.bytes));
    if (p.imp) stats.push(fill(w.ui_used_by, p.imp));
    if (p.out) stats.push(fill(w.ui_uses, p.out));
    const items = (p.sym || []).map((s) => {
      const kind = ITEM_ICON[s[1]] ? s[1] : 'fn';
      return { icon: ITEM_ICON[kind], name: String(s[0] || ''), kind: w['item_' + kind], shape: w['shape_' + kind], line: +s[2] || 0, exported: !!s[3] };
    });
    const uses = [], usedBy = [];
    if (p.i != null && p.i >= 0) for (const [i, j] of L.edges) {
      if (i === p.i && byIdx.get(j)) uses.push(byIdx.get(j).name);
      else if (j === p.i && byIdx.get(i)) usedBy.push(byIdx.get(i).name);
    }
    return {
      icon: ROLE_ICON[p.role] || '', color: ROLE_COLOR[p.role] || '#fff', title: p.name,
      path: p.path || (p.dir ? p.dir.replace(/\/?$/, '/') : '') + p.name,
      role: w['role_' + p.role] || p.role, furn: w['furn_' + p.role] || '',
      stats: stats.join(' · '), defines: items.length ? fill(w.ui_defines, items.length) : '',
      items, uses, usedBy, usesWord: w.ui_uses_list, usedByWord: w.ui_used_by_list,
      note: p.role === 'archive' ? (p.hiddenNames || []).slice(0, 40).join(', ') : (p.sym === null ? w.ui_no_symbols : ''),
    };
  }

  /* 地图:房间、门、家具(按用途上色)、你在哪儿、朝哪儿看。 */
  const mapCtx = map.getContext('2d');
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  map.width = 150 * dpr; map.height = 150 * dpr;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const r of rooms) { bx0 = Math.min(bx0, r.x0); bx1 = Math.max(bx1, r.x1); bz0 = Math.min(bz0, r.z0); bz1 = Math.max(bz1, r.z1); }
  const mk = Math.min((150 - 16) / (bx1 - bx0), (150 - 16) / (bz1 - bz0));
  const mx = (x) => (8 + (x - bx0) * mk + ((150 - 16) - (bx1 - bx0) * mk) / 2) * dpr;
  const mz = (z) => (8 + (z - bz0) * mk + ((150 - 16) - (bz1 - bz0) * mk) / 2) * dpr;
  function drawMap(here) {
    const c = mapCtx;
    c.clearRect(0, 0, map.width, map.height);
    for (const r of rooms) {
      c.fillStyle = r.open ? 'rgba(134,239,172,.10)' : 'rgba(255,255,255,.07)';
      c.strokeStyle = r === here ? '#6ee7b7' : 'rgba(255,255,255,.28)';
      c.lineWidth = (r === here ? 2 : 1) * dpr;
      c.fillRect(mx(r.x0), mz(r.z0), (r.x1 - r.x0) * mk * dpr, (r.z1 - r.z0) * mk * dpr);
      c.strokeRect(mx(r.x0), mz(r.z0), (r.x1 - r.x0) * mk * dpr, (r.z1 - r.z0) * mk * dpr);
    }
    c.strokeStyle = 'rgba(201,240,61,.25)'; c.lineWidth = 1 * dpr;
    for (const [i, j] of L.edges) { const a = byIdx.get(i), b = byIdx.get(j); if (a && b) { c.beginPath(); c.moveTo(mx(a.x), mz(a.z)); c.lineTo(mx(b.x), mz(b.z)); c.stroke(); } }
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.font = `${9 * dpr}px -apple-system,sans-serif`; c.textAlign = 'center';
    for (const r of rooms) if (!r.isHall) c.fillText(r.name.slice(0, 12), mx((r.x0 + r.x1) / 2), mz((r.z0 + r.z1) / 2) + 3 * dpr);
    for (const p of props) { c.fillStyle = ROLE_COLOR[p.role] || '#fff'; c.beginPath(); c.arc(mx(p.x), mz(p.z), (p === selected ? 3.2 : 2) * dpr, 0, TAU); c.fill(); }
    const X = mx(px), Z = mz(pz), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    c.fillStyle = '#6ee7b7';
    c.beginPath();
    c.moveTo(X + fx * 7 * dpr, Z + fz * 7 * dpr);
    c.lineTo(X - fx * 4 * dpr - fz * 4 * dpr, Z - fz * 4 * dpr + fx * 4 * dpr);
    c.lineTo(X - fx * 4 * dpr + fz * 4 * dpr, Z - fz * 4 * dpr - fx * 4 * dpr);
    c.fill();
  }

  let nightTarget = night;
  function setTime(mode) {
    timeMode = mode === 'auto' ? autoTime() : (mode === 'night' ? 'night' : 'day');
    nightTarget = timeMode === 'night' ? 1 : 0;
    paintTimeBtn();
  }

  function update(dt) {
    dt = Math.min(0.05, Math.max(0, dt || 0));
    t += dt;
    U.uTime.value = t;
    // 世界尺寸的点要知道"一弧度是多少像素"
    U.uPx.value = (H * renderer.getPixelRatio() / 2) / Math.tan(camera.fov * Math.PI / 360);
    if (night !== nightTarget) {
      night += Math.sign(nightTarget - night) * Math.min(Math.abs(nightTarget - night), dt / 1.2);
      applyTime();
      if (Math.abs(night - 0.5) < 0.05) paintTimeBtn();
    }

    const kf = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const kr = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const fwd = kf - move.z, strafe = kr + move.x;
    if (fwd || strafe) step(dt, fwd, strafe);
    camera.position.set(px, 1.62, pz);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();

    const here = roomAt(px, pz);
    if (here !== hereNow) {
      hereNow = here;
      const info = hereInfo(here);
      toast.innerHTML = `${info.path}<small>${fill(w.ui_files, here.files || 0)} · ${here.isHall ? (here.open ? w.ui_court_is : w.ui_room_is) : w.ui_room_is}</small>`
        + info.why.map((s) => `<small>${s}</small>`).join('');
      toast.style.opacity = '1'; toastUntil = t + 3.2;
      if (opts.onHere) { try { opts.onHere(info); } catch (e) {} }
    }
    if (toastUntil && t > toastUntil) { toast.style.opacity = '0'; toastUntil = 0; }

    const rc = rectOf();
    const inView = (s) => !s.behind && s.x > rc.left - 60 && s.x < rc.left + W + 60 && s.y > rc.top && s.y < rc.top + H;
    for (const pl of plaques) {
      const dist = Math.hypot(px - pl.d.cx, pz - pl.d.cz), s = toScreen(pl.d.cx, pl.y, pl.d.cz);
      if (dist > 28 || !inView(s)) { pl.p.style.display = 'none'; continue; }
      pl.p.style.display = 'block'; pl.p.style.left = s.x + 'px'; pl.p.style.top = s.y + 'px';
      pl.p.style.opacity = String(Math.max(0.35, 1 - dist / 30));
    }
    /* 家具的名牌:只给离得近的几件,而且**不许叠**。近的先占位置,和已经放下的
       撞上就不放 —— 十几块名牌压成一摞,一块也读不出来,远处的交给地图。 */
    const near = props.map((p) => ({ p, d: Math.hypot(px - p.x, pz - p.z) })).filter((q) => q.d < 9.5).sort((a, b) => a.d - b.d);
    const taken = [];
    let n = 0;
    for (const { p, d } of near) {
      if (n >= 9) break;
      const s = toScreen(p.top[0], p.top[1], p.top[2]);
      if (!inView(s)) continue;
      if (taken.some((b) => Math.abs(b.x - s.x) < 128 && Math.abs(b.y - s.y) < 34) && p !== selected) continue;
      taken.push(s);
      const lb = labelAt(n++);
      lb.style.display = 'block'; lb.style.left = s.x + 'px'; lb.style.top = s.y + 'px';
      lb.style.opacity = String(Math.max(0.3, 1 - d / 12));
      lb.className = 'room-label' + (p === selected ? ' sel' : '');
      const key = p.name + '|' + p.role;
      if (lb._k !== key) {
        lb._k = key;
        lb.innerHTML = `<i>${ROLE_ICON[p.role] || ''}</i>${p.name}<small>${w['role_' + p.role] || ''}${p.sym && p.sym.length ? ' · ' + fill(w.ui_defines, p.sym.length) : ''}</small>`;
      }
    }
    for (; n < labels.length; n++) labels[n].style.display = 'none';
    // 选中的那件:架子上每件东西标上它是哪个符号
    let m = 0;
    if (selected && Math.hypot(px - selected.x, pz - selected.z) < 9) {
      for (const sl of selected.slots.slice(0, 16)) {
        const s = toScreen(sl.at[0], sl.at[1] + 0.02, sl.at[2]);
        if (!inView(s)) continue;
        const tg = itemAt(m++);
        tg.style.display = 'block'; tg.style.left = s.x + 'px'; tg.style.top = s.y + 'px';
        tg.textContent = (ITEM_ICON[sl.sym.kind] || '') + ' ' + sl.sym.name;
      }
    }
    for (; m < itemTags.length; m++) itemTags[m].style.display = 'none';
    drawMap(here);
  }

  function render() { composer.render(); }

  function resize(w2, h2) {
    W = Math.max(1, w2 | 0); H = Math.max(1, h2 | 0);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
  }

  let dead = false;
  function dispose() {
    if (dead) return;
    dead = true;
    for (const f of offs) { try { f(); } catch (e) {} }
    for (const x of els.concat(labels, itemTags)) { try { x.remove(); } catch (e) {} }
    try { group.userData.dispose(); lGeo.dispose(); lMat.dispose(); selMat.dispose(); if (selGlow) selGlow.geometry.dispose(); } catch (e) {}
    try { bloom.dispose(); } catch (e) {}
    try { composer.dispose(); } catch (e) {}
    // 画布还给外面那片场,状态原样交回去 —— 像素比也还回去。
    try {
      renderer.setRenderTarget(null); renderer.autoClear = prevAutoClear;
      if (renderer.getPixelRatio() !== prevPR) { renderer.setPixelRatio(prevPR); renderer.setSize(W, H, false); }
    } catch (e) {}
  }

  applyTime();
  paintTimeBtn();
  resize(W, H);

  return {
    update, render, resize, dispose, step, setTime, describe, select,
    time: () => timeMode, layout: L.layout,
    renderNow() { update(0); render(); },
    at(x, z, y, p) { px = x; pz = z; if (y != null) yaw = y; if (p != null) pitch = p; },
    where() { return { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), room: roomAt(px, pz).name }; },
    here() { return hereInfo(roomAt(px, pz)); },
    particles: () => group.userData.points + NL, counts: () => ({ surface: group.userData.points, light: NL, lights: lights.length, edges: L.edges.length }),
    bloom, walkable, rooms, doors, props, camera, move, blocks,
    hasLeaves: L.hasLeaves, hasSymbols: L.hasSymbols, extraKids: L.extraKids,
    kit(name) {
      const r = name ? rooms.find((x) => x.name === name && !x.isHall) || hall : hall;
      const ip = kitOf(r);
      return ip && { style: ip.style.id, layout: L.layout, floor: ip.floor, wall: ip.wall, ceil: ip.ceil, light: ip.light, col: ip.col, why: ip.why };
    },
    kits() { return rooms.map((r) => { const ip = kitOf(r); return [r.name, ip.floor, ip.wall, ip.ceil, ip.light, ip.col]; }); },
    variants: interiorVariants,
  };
}
