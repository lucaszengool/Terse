/**
 * room-scene.js — 点一座楼,走进去。
 *
 * room-interior.js 是文法和平面图(一间屋子能用哪些件、房间怎么排),room-furniture.js
 * 是陈设(一个文件一件家具、一个符号一件东西),这里是**盖起来、点上灯、让人走**。
 *
 * 两层粒子,各管各的:
 *
 *   实物层 —— 墙、地、柱、家具、家具上的东西。**不透明、互相遮挡**的实心小点,点的大小
 *     按世界尺寸算(一颗 6cm 左右),所以离得近的是一颗颗清楚的颗粒,远的自然变密。
 *     旧版全是加色混合的光点:墙后面的东西透过墙叠上来,整间屋子糊成一片 —— 清晰度的
 *     头号问题不是点不够多,是**什么都挡不住什么**。
 *   光层 —— 灯、火、星、天光、家具上的数据光。加色 + bloom,和城市是同一种光。
 *
 * 白天和夜里是同一间屋子换一种光:白天是天光,灯灭着;夜里只剩灯照得到的地方是亮的,
 * 屋里的灯、廊下的灯笼、石灯笼一盏盏点起来。夜光是**建好时在 CPU 上算一次**的
 * (灯不会动),切换时只改一个 uniform,所以换昼夜不重建任何东西。
 *
 * ⚠ 不自己开 WebGL。`createRoom` 借调用方的 renderer —— 手机上那就是引擎自己的那一个。
 * iOS Safari 只肯给一页有限几个活的 WebGL 上下文(app.js 里项目窗口为这个黑过三次)。
 *
 * ⚠ 平面图(layoutOf)在 room-interior.js 里:它是纯函数,测试要加载它,而这个文件
 * 拉着 three/addons,测试里是加载不了的。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { interiorOf, interiorVariants, FLOOR, WALL, CEIL, LIGHT, COL, asLight, mix,
         layoutOf, layoutFor, fileLight, COURT, roofOf, skyOf, DOOR_W, PAD } from './room-interior.js';
import { FURN, ROLE, ROLE_ICON, ITEM_ICON, WORDS_EN, roleOfName, furnSize } from './room-furniture.js';

const TAU = Math.PI * 2;
/** 夜光的光源名额。灯不会动,夜光在建好时就逐颗算好 —— 这个数只决定建的时候多费几毫秒。 */
const MAX_LIGHTS = 32;
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
  ui_day: 'Day', ui_night: 'Night', ui_legend: 'Legend',
  lg_title: 'How to read this building',
  lg_room: 'Room = a directory · doorway = its sub-directory',
  lg_furn: 'Furniture = a file · the kind of furniture says what the file does',
  lg_item: 'Things on the furniture = what the file defines',
  lg_size: 'Taller furniture = more code · colour of the things = language',
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
.room-toast small{display:block;font-size:12px;font-weight:600;opacity:.75;margin-top:4px}
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
 *   budget  粒子预算比例 0.25–1。手机上给小一点
 *   pixelRatio  走的时候用的像素比(默认 min(2, dpr));走出来还原
 *   words   翻好的词(WORDS_EN + UI_EN 的键)
 *   onHere(info)  走进了另一间屋子
 *   onPick(prop, desc)  点了一件家具;desc 是 describe(prop) 的结果
 */
export function createRoom(renderer, dir, opts = {}) {
  injectCss();
  const B = Math.max(0.25, Math.min(1, +opts.budget || 1));
  const styleId = opts.style || (dir && dir.style) || 'modern';
  const layout = opts.layout || layoutFor(styleId);
  const L = layoutOf(dir || {}, { layout });
  const { hall, rooms, doors } = L;
  const dirLang = (dir && dir.lang) || '';
  const host = opts.host || document.body;
  const input = opts.input || renderer.domElement;
  const w = Object.assign({}, WORDS_EN, UI_EN, opts.words || {});

  /* ── 粒子缓冲:实物层 + 光层 ──────────────────────────────────────────── */
  const MAXM = Math.round(900000 * B), MAXL = Math.round(160000 * B);
  const mPos = new Float32Array(MAXM * 3), mCol = new Float32Array(MAXM * 3), mSiz = new Float32Array(MAXM);
  const lPos = new Float32Array(MAXL * 3), lCol = new Float32Array(MAXL * 3), lSiz = new Float32Array(MAXL);
  const lPha = new Float32Array(MAXL), lTwk = new Float32Array(MAXL), lKind = new Float32Array(MAXL);
  let NM = 0, NL = 0, limitM = MAXM;
  // 一颗实物点的直径随预算放大:预算小的时候点少,点就得大一点才盖得住墙。
  const DOT = 1 / Math.sqrt(B);
  /** kind: 0 实物、1 夜里亮的灯、2 数据光(一直亮)、3 白天才有的光。 */
  function emit(x, y, z, c, size, twinkle, kind) {
    if (kind === undefined) kind = (twinkle || 0) >= 0.75 ? 1 : 0;
    if (!kind) {
      if (NM >= limitM) return;
      const i = NM++;
      mPos[i * 3] = x; mPos[i * 3 + 1] = y; mPos[i * 3 + 2] = z;
      mCol[i * 3] = c[0]; mCol[i * 3 + 1] = c[1]; mCol[i * 3 + 2] = c[2];
      mSiz[i] = size * DOT;
      return;
    }
    if (NL >= MAXL) return;
    const i = NL++;
    lPos[i * 3] = x; lPos[i * 3 + 1] = y; lPos[i * 3 + 2] = z;
    lCol[i * 3] = c[0]; lCol[i * 3 + 1] = c[1]; lCol[i * 3 + 2] = c[2];
    // 闪烁相位按下标哈希,不用 Math.random —— 这个仓库里的城市一律可复现。
    lSiz[i] = size; lPha[i] = (Math.imul(i, 2654435761) >>> 0) / 4294967296;
    lTwk[i] = twinkle === undefined ? 0.5 : twinkle; lKind[i] = kind;
  }
  /** 建筑的件一律是实物,哪怕文法里给了很高的闪烁(檐口、穹顶心)。 */
  const archE = (x, y, z, c, s, tw) => emit(x, y, z, c, s, Math.min(0.3, tw || 0), 0);
  /** 灯具:亮的那部分进光层(夜里才亮),灯架灯链是实物。 */
  const lampE = (x, y, z, c, s, tw) => emit(x, y, z, c, s, tw, (tw || 0) >= 0.5 ? 1 : 0);
  /** 顶心采光是天光:白天才有。 */
  const skyE = (x, y, z, c, s, tw) => emit(x, y, z, c, s, tw, 3);

  const lights = [];
  const addLight = (x, y, z, r, col) => { if (lights.length < MAX_LIGHTS) lights.push({ x, y, z, r, col }); };
  const blocks = L.blocks;
  const block = (x, z, rx, rz) => blocks.push({ x, z, rx, rz: rz || rx });

  /* ── 墙皮:一层均匀的实心点 ─────────────────────────────────────────────
     纹样(文法里的 FLOOR/WALL/CEIL)是装饰,它按疏密画花样,本来就是稀的;实物要
     挡得住东西,底下得有一层均匀的面。抖动网格而不是纯随机:同样的点数,纯随机会
     结团、留洞,网格一格一颗就铺满了。 */
  const GRID = 0.085 / Math.sqrt(B);
  /* 墙皮点要比网格大一圈,才盖得严:盖不严的地方透出天色,白天整片地面就成了
     浮在蓝天上的一池小球。 */
  const COAT = 1.75;
  function coat(u0, u1, v0, v1, put, col, vary, rnd) {
    const nu = Math.max(1, Math.round((u1 - u0) / GRID)), nv = Math.max(1, Math.round((v1 - v0) / GRID));
    const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const u = u0 + (i + rnd()) * du, v = v0 + (j + rnd()) * dv;
      const k = 1 - vary + rnd() * vary;
      put(u, v, [col[0] * k, col[1] * k, col[2] * k]);
    }
  }
  const wallsOf = (r) => ['N', 'S', 'W', 'E'].map((s) => {
    const x0 = s === 'E' ? r.x1 : r.x0, x1 = s === 'W' ? r.x0 : r.x1;
    const z0 = s === 'S' ? r.z1 : r.z0, z1 = s === 'N' ? r.z0 : r.z1;
    const gap = doors.find((d) => (s === 'N' || s === 'S')
      ? Math.abs(d.cz - z0) < 0.9 && d.x0 > r.x0 - 0.5 && d.x1 < r.x1 + 0.5
      : Math.abs(d.cx - x0) < 0.9 && d.z0 > r.z0 - 0.5 && d.z1 < r.z1 + 0.5);
    return { s, x0, z0, x1, z1, gap };
  });

  /* ── 盖起来 ──────────────────────────────────────────────────────────────
     每个房间问一次 interiorOf:风格是**整个项目**的(跟着外面那座楼),槽位是**这个
     目录自己**的。于是同一个项目里的几个子目录同属一个风格,又各装各的。 */
  const decor = new Map();
  const kitOf = (r) => decor.get(r.isHall ? '\0hall' : r.name);
  const matOf = (ip) => ({
    wood: mix(asLight(ip.pal.timber || ip.pal.stone, 0.72), [0.2, 0.14, 0.1], 0.25),
    stone: asLight(ip.pal.stone, 0.8), trim: asLight(ip.pal.accent, 0.92),
  });

  function furnish(r) {
    const isHall = !!r.isHall;
    const ip = interiorOf(styleId, r.name);
    const rnd = () => ip.rnd.f();
    const c1 = asLight(ip.pal.stone, 0.88), c2 = asLight(ip.pal.accent, 1.0), cRoof = asLight(ip.pal.roof, 1.0);
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const R = Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2;
    const h = r.h, scale = (isHall ? 1 : 0.42) * B;
    decor.set(isHall ? '\0hall' : r.name, ip);

    // 底色:地、墙、顶。露天的院子没有顶,地是院子自己的(方砖、白砂)。
    const floorCol = r.kind === 'garden' ? [0.82, 0.81, 0.76] : r.kind === 'court' ? mix(c1, [0.35, 0.35, 0.36], 0.45) : mix(c1, [0.05, 0.05, 0.06], 0.42);
    coat(r.x0, r.x1, r.z0, r.z1, (x, z, c) => emit(x, -0.012, z, c, COAT, 0, 0), floorCol, 0.12, rnd);
    const woodWall = ip.wall === 'timber' || ip.wall === 'lattice';
    // 四合院是青砖墙:红的只是柱子、门窗格子(墙上的纹样),不是整面墙
    const wallCol = r.kind === 'pavilion' ? [0.9, 0.88, 0.8]
      : (r.kind === 'wing' || r.kind === 'court') ? [0.5, 0.51, 0.53]
      : woodWall ? mix(asLight(ip.pal.timber || ip.pal.stone, 0.7), [0.1, 0.08, 0.06], 0.3)
      : ip.wall === 'glass' ? [0.45, 0.55, 0.62] : ip.wall === 'mosaic' ? mix(c1, cRoof, 0.45) : mix(c1, [0.1, 0.1, 0.12], 0.25);
    for (const wl of wallsOf(r)) {
      const horiz = wl.s === 'N' || wl.s === 'S';
      const out = (wl.s === 'N' || wl.s === 'W') ? -0.04 : 0.04;           // 往墙外退一点,纹样浮在墙皮前面
      const lo = horiz ? Math.min(wl.x0, wl.x1) : Math.min(wl.z0, wl.z1), hi = horiz ? Math.max(wl.x0, wl.x1) : Math.max(wl.z0, wl.z1);
      const gp = wl.gap;
      coat(lo, hi, 0, h, (u, y, c) => {
        if (gp) {
          const gu0 = horiz ? gp.x0 : gp.z0, gu1 = horiz ? gp.x1 : gp.z1;
          const top = Math.min(h * 0.62, h - 0.2);
          if (u > gu0 + 0.8 - 0.8 && u < gu1 && y < (DOOR_W / 2 > 0 ? Math.sqrt(Math.max(0, 1 - ((u - (gu0 + gu1) / 2) / (DOOR_W / 2)) ** 2)) * (top - 1.5) + 1.5 : top)
              && Math.abs(u - (gu0 + gu1) / 2) < DOOR_W / 2) return;        // 门洞(和 arch 的券一个形状)
        }
        if (horiz) emit(u, y, wl.z0 + out, c, COAT, 0, 0); else emit(wl.x0 + out, y, u, c, COAT, 0, 0);
      }, wallCol, 0.1, rnd);
    }
    if (!r.open) {
      const ceilCol = mix(cRoof, [0.04, 0.04, 0.05], 0.5);
      if (ip.ceil === 'dome' || ip.ceil === 'onion') {
        /* 穹顶也要有一层面,不然白天从穹顶的肋之间看得见天 —— 厅成了露天的。
           圆顶外面那一圈是平顶;穹顶本身按高度均匀撒(半球上按高度均匀 = 按面积均匀)。 */
        const Rd = R * 0.95, y0 = h * 0.52, hg = h * 0.6;
        coat(r.x0, r.x1, r.z0, r.z1, (x, z, c) => { if (Math.hypot(x - cx, z - cz) > Rd) emit(x, h + 0.03, z, c, COAT, 0, 0); }, ceilCol, 0.1, rnd);
        const domeCol = mix(c1, cRoof, 0.5);
        const nD = Math.round((2 * Math.PI * Rd * Rd) / (GRID * GRID) * 1.1);
        for (let i = 0; i < nD; i++) {
          const a = rnd() * TAU, s = rnd(), q = Math.sqrt(1 - s * s) * (Rd + 0.05);
          const k = 0.9 + rnd() * 0.1;
          emit(cx + Math.cos(a) * q, y0 + s * hg + 0.04, cz + Math.sin(a) * q, [domeCol[0] * k, domeCol[1] * k, domeCol[2] * k], COAT, 0, 0);
        }
      } else {
        coat(r.x0, r.x1, r.z0, r.z1, (x, z, c) => emit(x, h + 0.03, z, c, COAT, 0, 0), ceilCol, 0.1, rnd);
      }
    }

    // 纹样:地、墙、顶的花样(露天的院子由 COURT 自己铺)
    if (!r.open) FLOOR[ip.floor]({ r, cx, cz, R, n: Math.round(26000 * scale), rnd, c1, c2, grain: ip.grain }, archE);
    for (const wl of wallsOf(r)) {
      WALL[ip.wall]({ x0: wl.x0, z0: wl.z0, x1: wl.x1, z1: wl.z1, h, n: Math.round(12000 * scale), rnd, c1, c2, gap: wl.gap }, archE);
    }
    if (!r.open) {
      CEIL[ip.ceil]({ r, cx, cz, R: R * 0.95, y: h * (ip.ceil === 'dome' || ip.ceil === 'onion' ? 0.52 : 1),
                      hgt: h * 0.6, n: Math.round(30000 * scale), rnd,
                      c1: mix(c1, cRoof, 0.45), c2: mix(cRoof, c2, 0.35), grain: ip.grain }, archE);
      const cy = h * (isHall ? 0.60 : 0.74);
      LIGHT[ip.light]({ cx, cy, cz, r, n: Math.round(8500 * scale), rnd, c1, c2 }, ip.light === 'oculus' ? skyE : lampE);
      lightsFor(ip, r, cx, cy, cz, isHall);
      if (ip.col !== 'none' && isHall) {
        const HW = (r.x1 - r.x0) / 2, HD = (r.z1 - r.z0) / 2;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let b = 0; b < ip.bays; b++) {
          const x = sx * (HW - 2.0 - b * 3.4), z = sz * (HD - 1.9);
          if (Math.abs(x) < 2.2) continue;
          COL[ip.col]({ x, z, h: h * 0.66, n: Math.round(2600 * B), rnd, c1, c2 }, archE);
          block(x, z, 0.45);
        }
      }
    }
    if (r.open) {
      const pal = { stone: c1, accent: c2, roof: cRoof, timber: asLight(ip.pal.timber || ip.pal.stone, 0.8) };
      (r.kind === 'garden' ? COURT.garden : COURT.siheyuan)({ r, rnd, pal, doors, lit: addLight, block, n: B }, emit);
    }
    // 院子四周那几间房,从院子里看得见它们的屋顶
    if (!isHall && L.open) {
      roofOf({ r, rnd, n: B, col: mix(cRoof, [0.1, 0.1, 0.1], 0.2), ridgeCol: r.kind === 'wing' ? mix(cRoof, [0, 0, 0], 0.4) : [0.18, 0.18, 0.2],
               steep: r.kind === 'pavilion' ? 0.62 : 0.42, over: r.kind === 'pavilion' ? 0.7 : 1.0 }, archE);
    }
    return { ip, rnd, c1, c2 };
  }

  /** 这间屋子的灯照得到哪儿 —— 夜光要用。子房间只登记一盏(名额有限),大厅逐盏登记。 */
  function lightsFor(ip, r, cx, cy, cz, isHall) {
    const R = Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2;
    const warm = [1, 0.74, 0.46];
    if (!isHall || ip.light === 'chandelier' || ip.light === 'candle' || ip.light === 'strip' || ip.light === 'oculus') {
      const col = ip.light === 'strip' ? [0.82, 0.88, 1] : ip.light === 'oculus' ? [0.5, 0.56, 0.72] : ip.light === 'brazier' ? [1, 0.6, 0.3] : warm;
      addLight(cx, cy - 0.6, cz, R * 2.1, col);
      return;
    }
    if (ip.light === 'lantern') for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.4; addLight(cx + Math.cos(a) * 1.5, cy - 0.35, cz + Math.sin(a) * 1.5, Math.max(5, R * 1.2), warm); }
    if (ip.light === 'brazier') {
      const Rb = Math.min(r.x1 - r.x0, r.z1 - r.z0) * 0.32;
      for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.7; addLight(cx + Math.cos(a) * Rb, 1.4, cz + Math.sin(a) * Rb, 6.5, [1, 0.6, 0.3]); block(cx + Math.cos(a) * Rb, cz + Math.sin(a) * Rb, 0.55); }
    }
  }

  /** 拱门:门洞上的券。风格不改它的做法,只改它的颜色 —— 门就是门。 */
  function arch(d, h, c1, c2, n, rnd) {
    const horiz = d.side === 'N' || d.side === 'S';
    const half = DOOR_W / 2, top = h * 0.62;
    for (let i = 0; i < n; i++) {
      const t = rnd() * Math.PI, j = (rnd() - 0.5) * 0.12;
      const u = Math.cos(t) * half, y = Math.sin(t) * (top - 1.5) + 1.5 + j;
      emit(d.cx + (horiz ? u : j), y, d.cz + (horiz ? j : u), mix(c2, c1, rnd() * 0.3), 1.1, 0.2, 0);
    }
    for (let i = 0; i < n / 2; i++) {
      const s = rnd() < 0.5 ? -1 : 1;
      emit(d.cx + (horiz ? s * half : (rnd() - 0.5) * 0.12), rnd() * 1.5, d.cz + (horiz ? (rnd() - 0.5) * 0.12 : s * half), mix(c2, c1, 0.4), 1.1, 0.2, 0);
    }
  }

  /* 家具要的位置先留出来:文件是这间屋子唯一的数据,墙再好看也只是布景。 */
  let nFiles = 0;
  for (const fs of L.byRoom.values()) nFiles += Math.min(fs.length, CAP_HALL);
  limitM = MAXM - Math.round(nFiles * 2600 * B);

  const hallKit = furnish(hall);
  for (const r of rooms) if (!r.isHall) furnish(r);
  for (const d of doors) arch(d, L.open ? 3.4 : hall.h, hallKit.c1, hallKit.c2, Math.round(2600 * B), hallKit.rnd);
  if (L.open) skyOf({ rnd: hallKit.rnd, n: B }, emit);
  limitM = MAXM;

  /* ── 陈设:一个文件一件家具 ──────────────────────────────────────────────
     靠墙的(柜、书架、画、抽屉)沿墙一排,朝屋里;站在中间的(实验台、展柜、绘图桌)
     排成几行,朝着进门的方向;入口文件是尽头正中那座主案。**重要的先摆**:被别的
     文件引用得多的、大的,排在前面。 */
  const props = [];
  const doorOf = (r) => doors.find((d) => d.room === r.name);
  function slotsFor(r) {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const door = r.isHall ? null : doorOf(r);
    // 进门的方向:大厅/院子从南边进(起点在南),子房间从通向大厅的那扇门进
    const inSide = r.isHall ? 'S' : ({ N: 'S', S: 'N', E: 'W', W: 'E' })[r.side];
    const back = ({ S: 'N', N: 'S', E: 'W', W: 'E' })[inSide];
    const faceIn = ({ N: [0, 1], S: [0, -1], E: [-1, 0], W: [1, 0] });      // 靠某面墙时,朝屋里的方向
    const inset = r.open ? (r.kind === 'garden' ? 1.1 : 1.35) : 0.75;
    const wallSlots = [], floorSlots = [];
    let center = null;
    for (const wl of wallsOf(r)) {
      const horiz = wl.s === 'N' || wl.s === 'S';
      const lo = horiz ? r.x0 : r.z0, hi = horiz ? r.x1 : r.z1, len = hi - lo;
      const n = Math.floor((len - 2.4) / 1.9);
      for (let i = 0; i <= n; i++) {
        const u = lo + 1.2 + (n ? i * (len - 2.4) / n : (len - 2.4) / 2);
        const X = horiz ? u : (wl.s === 'W' ? r.x0 + inset : r.x1 - inset);
        const Z = horiz ? (wl.s === 'N' ? r.z0 + inset : r.z1 - inset) : u;
        if (doors.some((d) => Math.hypot(d.cx - X, d.cz - Z) < 2.0)) continue;
        if (blocks.some((b) => Math.hypot(b.x - X, b.z - Z) < b.rx + 0.8)) continue;
        const [fx, fz] = faceIn[wl.s];
        const slot = { X, Z, fx, fz, wall: wl.s };
        if (wl.s === back && !center && Math.abs(u - (horiz ? cx : cz)) < 1.3) { center = Object.assign({}, slot, { X: horiz ? cx : X + fx * 1.2, Z: horiz ? Z + fz * 1.2 : cz }); continue; }
        wallSlots.push(slot);
      }
    }
    if (!center) {
      const [fx, fz] = faceIn[back];
      center = { X: back === 'E' ? r.x1 - 2.2 : back === 'W' ? r.x0 + 2.2 : cx, Z: back === 'N' ? r.z0 + 2.2 : back === 'S' ? r.z1 - 2.2 : cz, fx, fz };
    }
    // 屋子中间几行,朝着进门那一边;留出中轴一条路和院子的十字甬道
    const fin = faceIn[back];
    const m = r.open ? 3.4 : 2.9, sx = 2.7, sz = 2.5;
    for (let x = r.x0 + m; x <= r.x1 - m + 0.01; x += sx) for (let z = r.z0 + m; z <= r.z1 - m + 0.01; z += sz) {
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
    const ip = kitOf(r), mat = matOf(ip), rnd = () => ip.rnd.f();
    const cap = r.isHall ? CAP_HALL : CAP_ROOM;
    const ranked = files.map((f) => Object.assign({}, f, { role: f.role || roleOfName(f.name, f.sub) }))
      .sort((a, b) => (b.imp * 3 + Math.log2(1 + b.bytes)) - (a.imp * 3 + Math.log2(1 + a.bytes)));
    const { center, wallSlots, floorSlots } = slotsFor(r);
    const room = Math.min(cap, wallSlots.length + floorSlots.length + 1);
    const hidden = ranked.length > room ? ranked.slice(room - 1) : [];
    const shown = hidden.length ? ranked.slice(0, room - 1) : ranked;
    const take = (pool) => pool.length ? pool.shift() : null;
    let usedCenter = false;
    const put = (f, slot) => {
      const lang = fileLight(f.name, f.lang || dirLang);
      const items = (f.sym || []).map((s) => ({ name: String(s[0] || ''), kind: ITEM_ICON[s[1]] ? s[1] : 'fn', line: +s[2] || 0, exported: !!s[3] }));
      const { h, w: wd } = furnSize({ lines: f.lines, bytes: f.bytes, items });
      const furn = FURN[(ROLE[f.role] || ROLE.source).furn] || FURN.cabinet;
      const res = furn({ X: slot.X, Z: slot.Z, fx: slot.fx, fz: slot.fz, w: wd, h, items, lang, mat, rnd, dens: Math.round(620 * B), extra: f.extra }, emit);
      const p = { x: slot.X, z: slot.Z, top: res.top, slots: res.slots, name: f.name, path: f.path, role: f.role, bytes: f.bytes,
                  lines: f.lines, lang: f.lang || '', sym: f.sym, imp: f.imp, out: f.out, dir: f.sub || L.name, room: r.isHall ? '' : r.name,
                  hiddenNames: f.hiddenNames || null, w: wd };
      props.push(p);
      // 挡路:站在中间的家具按宽度挡一圈,靠墙的挡它前面那一块
      const onWall = !!slot.wall;
      block(slot.X - slot.fx * (onWall ? 0.2 : 0), slot.Z - slot.fz * (onWall ? 0.2 : 0), Math.max(0.5, wd * 0.5), Math.max(0.5, wd * 0.5));
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
                      extra: hidden.length, hiddenNames: hidden.map((f) => f.name), sub: r.isHall ? '' : r.name, lang: '' }, slot);
    }
  }
  for (const [k, files] of L.byRoom) placeFiles(k ? rooms.find((r) => r.name === k && !r.isHall) || hall : hall, files);

  /* ── 夜光:每一颗实物点离哪几盏灯多近。灯不会动,所以只算这一次。 ── */
  const mNight = new Float32Array(NM * 3);
  {
    const AMB = [0.055, 0.065, 0.1];
    for (let i = 0; i < NM; i++) {
      let r = AMB[0], g = AMB[1], b = AMB[2];
      const x = mPos[i * 3], y = mPos[i * 3 + 1], z = mPos[i * 3 + 2];
      for (let j = 0; j < lights.length; j++) {
        const Lt = lights[j], dx = Lt.x - x, dy = Lt.y - y, dz = Lt.z - z;
        const d2 = dx * dx + dy * dy + dz * dz, R2 = Lt.r * Lt.r;
        if (d2 >= R2) continue;
        const q = 1 - Math.sqrt(d2) / Lt.r, k = q * q * 1.3;
        r += Lt.col[0] * k; g += Lt.col[1] * k; b += Lt.col[2] * k;
      }
      // ⚠ 封顶:灯罩、石灯笼的石头就在光源旁边,不封的话它们自己被照成一团白,
      // 远看像一个发光的人站在院子里。
      mNight[i * 3] = Math.min(r, 1.15); mNight[i * 3 + 1] = Math.min(g, 1.05); mNight[i * 3 + 2] = Math.min(b, 0.95);
    }
  }

  /* ── 渲染 ── */
  const scene = new THREE.Scene();
  const SKY_DAY = new THREE.Color(0.6, 0.73, 0.87), SKY_NIGHT = new THREE.Color(0.012, 0.016, 0.03);
  scene.background = SKY_NIGHT.clone();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 260);
  const U = {
    uTime: { value: 0 }, uPx: { value: 800 }, uNight: { value: 1 },
    uDay: { value: new THREE.Vector3(0.8, 0.78, 0.74) }, uFog: { value: new THREE.Color() }, uFogK: { value: 0.0004 },
  };

  const mGeo = new THREE.BufferGeometry();
  mGeo.setAttribute('position', new THREE.BufferAttribute(mPos.subarray(0, NM * 3), 3));
  mGeo.setAttribute('aColor', new THREE.BufferAttribute(mCol.subarray(0, NM * 3), 3));
  mGeo.setAttribute('aSize', new THREE.BufferAttribute(mSiz.subarray(0, NM), 1));
  mGeo.setAttribute('aNight', new THREE.BufferAttribute(mNight, 3));
  const mMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: `
      precision highp float;
      attribute vec3 aColor; attribute float aSize; attribute vec3 aNight;
      uniform float uPx, uNight, uFogK; uniform vec3 uDay;
      varying vec3 vColor; varying float vFog;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        // 世界尺寸的点:一颗约 6cm。近处是一颗颗清楚的颗粒,远处自然变密 —— 不再是
        // "离得越近越糊成一团光"。上限防止贴脸时一颗点盖满半个屏幕。
        gl_PointSize = clamp(aSize * 0.062 * uPx / max(0.25, d), 1.0, 96.0);
        // 一米以内的点缩掉:擦着柱子走过去时,不该是满屏几颗大圆球
        gl_PointSize *= clamp((d - 0.3) / 0.9, 0.0, 1.0);
        vec3 light = mix(uDay, aNight, uNight);
        vec3 c = aColor * light;
        // 调色板是按"光"提亮过的,白天直接用会一片粉灰 —— 把饱和度和对比拉回来
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = max(vec3(0.0), vec3(l) + (c - vec3(l)) * mix(1.45, 1.1, uNight));
        c = mix(c, c * c * 1.25, 0.35 * (1.0 - uNight));
        vColor = c;
        vFog = exp(-d * d * uFogK);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision highp float;
      uniform vec3 uFog;
      varying vec3 vColor; varying float vFog;
      void main(){
        vec2 d = gl_PointCoord - vec2(0.5);
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        // 一点点明暗,只一点点:明暗重了,地面就成了一池小球
        vec3 c = vColor * (1.03 - r2 * 0.45);
        gl_FragColor = vec4(mix(uFog, c, vFog), 1.0);
      }`,
  });
  const matter = new THREE.Points(mGeo, mMat);
  matter.frustumCulled = false;
  scene.add(matter);

  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute('position', new THREE.BufferAttribute(lPos.subarray(0, NL * 3), 3));
  lGeo.setAttribute('aColor', new THREE.BufferAttribute(lCol.subarray(0, NL * 3), 3));
  lGeo.setAttribute('aSize', new THREE.BufferAttribute(lSiz.subarray(0, NL), 1));
  lGeo.setAttribute('aPhase', new THREE.BufferAttribute(lPha.subarray(0, NL), 1));
  lGeo.setAttribute('aTwk', new THREE.BufferAttribute(lTwk.subarray(0, NL), 1));
  lGeo.setAttribute('aKind', new THREE.BufferAttribute(lKind.subarray(0, NL), 1));
  const lMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: `
      precision highp float;
      attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aTwk; attribute float aKind;
      uniform float uTime, uPx, uNight, uFogK;
      varying vec3 vColor; varying float vA;
      void main(){
        vec3 p = position;
        p.y += sin(uTime * 0.8 + aPhase * 6.2831) * 0.012 * aTwk;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        gl_PointSize = clamp(aSize * 0.06 * uPx / max(0.25, d), 1.0, 32.0);
        // 1 灯:夜里才亮;3 天光:白天才有;2 数据光:一直亮,白天淡一点
        float on = aKind < 1.5 ? uNight : aKind < 2.5 ? mix(0.45, 1.0, uNight) : 1.0 - uNight;
        float tw = 0.75 + 0.25 * sin(uTime * 1.9 + aPhase * 19.0);
        vA = on * mix(1.0, tw, aTwk) * exp(-d * d * uFogK * 0.5);
        vColor = aColor;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec3 vColor; varying float vA;
      void main(){
        vec2 d = gl_PointCoord - vec2(0.5);
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        // 吊灯几百颗点挤在一起,每颗再亮一点,竖屏上半屏就是一团白
        float a = exp(-r2 * 12.0) * 0.3;
        gl_FragColor = vec4(vColor * a * vA, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Points(lGeo, lMat);
  glow.frustumCulled = false;
  glow.renderOrder = 1;
  scene.add(glow);

  const prevAutoClear = renderer.autoClear;
  const prevPR = renderer.getPixelRatio();
  const wantPR = opts.pixelRatio || Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const size0 = renderer.getSize(new THREE.Vector2());
  let W = size0.x || 1, H = size0.y || 1;
  if (wantPR !== prevPR) { renderer.setPixelRatio(wantPR); renderer.setSize(W, H, false); }
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.7, 0.5, 0.6);
  composer.addPass(bloom);

  /* ── 白天 / 夜里 ── */
  let timeMode = opts.time === 'day' || opts.time === 'night' ? opts.time : autoTime();
  let night = timeMode === 'night' ? 1 : 0;
  function applyTime() {
    U.uNight.value = night;
    scene.background.copy(SKY_DAY).lerp(SKY_NIGHT, night);
    U.uFog.value.copy(scene.background);
    U.uFogK.value = (L.open ? 0.00018 : 0.00032) * (1 - night) + 0.00045 * night;
    bloom.strength = 0.18 + night * 0.42;
    bloom.threshold = 0.86 - night * 0.3;
    bloom.radius = 0.45;
  }
  applyTime();

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
    + `<h4>${w.lg_roles}</h4>` + usedRoles.map((r) => `<div class="row"><span class="dot" style="background:${ROLE_COLOR[r]}"></span>${ROLE_ICON[r] || ''} <span><b style="display:inline;font-size:12px">${w['role_' + r] || r}</b> — ${w['furn_' + r] || ''}</span></div>`).join('')
    + (usedKinds.length ? `<h4>${w.lg_items}</h4>` + usedKinds.map((k) => `<div class="row">${ITEM_ICON[k]} <span>${w['shape_' + k]} = ${w['item_' + k]}</span></div>`).join('') : '')
    + (L.hasSymbols ? '' : `<p style="opacity:.7;margin-top:8px">${w.ui_no_symbols}</p>`)
    + (L.truncated ? `<p style="opacity:.7">${w.ui_truncated}</p>` : '');
  on(legendBtn, 'click', () => { legend.hidden = !legend.hidden; });
  const paintTimeBtn = () => { timeBtn.textContent = night > 0.5 ? '🌙 ' + w.ui_night : '☀️ ' + w.ui_day; };
  paintTimeBtn();
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
    return { d, p, y: (L.open ? 3.4 : hall.h) * 0.62 + 0.45 };
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
    // 家具没有网格可以打射线,就按屏幕距离挑最近的那一件(只算看得见、不太远的)
    let best = null, bd = 90;
    for (const p of props) {
      const dist = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
      if (dist > 14) continue;
      const s = toScreen(p.x, (p.top[1] - 0.3) * 0.6, p.z);
      if (s.behind) continue;
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY) * (0.6 + dist / 20);
      if (d < bd) { bd = d; best = p; }
    }
    selected = best;
    if (best && opts.onPick) { try { opts.onPick(best, describe(best)); } catch (err) {} }
  });

  const labels = [], itemTags = [];
  const pool = (arr, cls) => (i) => { while (arr.length <= i) { const x = el('div', cls); x.style.display = 'none'; arr.push(x); } return arr[i]; };
  const labelAt = pool(labels, 'room-label'), itemAt = pool(itemTags, 'room-item');

  function step(dt, fwd, strafe) {
    const s = 3.4 * dt, sin = Math.sin(yaw), cos = Math.cos(yaw);
    const dx = (-sin * fwd + cos * strafe) * s, dz = (-cos * fwd - sin * strafe) * s;
    if (walkable(px + dx, pz)) px += dx;
    if (walkable(px, pz + dz)) pz += dz;
  }

  const hereInfo = (r) => {
    const ip = kitOf(r);
    const base = L.name.replace(/\/?$/, '/');
    return { name: r.name, isHall: !!r.isHall, files: r.files, kind: r.kind, path: r.isHall ? base : base + r.name + '/', style: ip && ip.style.id };
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
    return {
      icon: ROLE_ICON[p.role] || '', color: ROLE_COLOR[p.role] || '#fff', title: p.name,
      path: p.path || (p.dir ? p.dir.replace(/\/?$/, '/') : '') + p.name,
      role: w['role_' + p.role] || p.role, furn: w['furn_' + p.role] || '',
      stats: stats.join(' · '), defines: items.length ? fill(w.ui_defines, items.length) : '',
      items, note: p.role === 'archive' ? (p.hiddenNames || []).slice(0, 40).join(', ') : (p.sym === null ? w.ui_no_symbols : ''),
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
      toast.innerHTML = `${info.path}<small>${fill(w.ui_files, here.files || 0)} · ${here.isHall ? (here.open ? w.ui_court_is : w.ui_room_is) : w.ui_room_is}</small>`;
      toast.style.opacity = '1'; toastUntil = t + 2.6;
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
  resize(W, H);

  let dead = false;
  function dispose() {
    if (dead) return;
    dead = true;
    for (const f of offs) { try { f(); } catch (e) {} }
    for (const x of els.concat(labels, itemTags)) { try { x.remove(); } catch (e) {} }
    try { mGeo.dispose(); mMat.dispose(); lGeo.dispose(); lMat.dispose(); } catch (e) {}
    try { bloom.dispose(); } catch (e) {}
    try { composer.dispose(); } catch (e) {}
    // 画布还给外面那片场,状态原样交回去 —— 像素比也还回去。
    try {
      renderer.setRenderTarget(null); renderer.autoClear = prevAutoClear;
      if (renderer.getPixelRatio() !== prevPR) { renderer.setPixelRatio(prevPR); renderer.setSize(W, H, false); }
    } catch (e) {}
  }

  return {
    update, render, resize, dispose, step, setTime, describe,
    time: () => timeMode, layout: L.layout,
    renderNow() { update(0); render(); },
    at(x, z, y, p) { px = x; pz = z; if (y != null) yaw = y; if (p != null) pitch = p; },
    where() { return { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), room: roomAt(px, pz).name }; },
    here() { return hereInfo(roomAt(px, pz)); },
    select(p) { selected = p || null; },
    particles: () => NM + NL, counts: () => ({ matter: NM, light: NL, lights: lights.length }),
    bloom, walkable, rooms, doors, props, camera, move, blocks,
    hasLeaves: L.hasLeaves, hasSymbols: L.hasSymbols, extraKids: L.extraKids,
    kit(name) {
      const r = name ? rooms.find((x) => x.name === name && !x.isHall) || hall : hall;
      const ip = kitOf(r);
      return ip && { style: ip.style.id, layout: L.layout, floor: ip.floor, wall: ip.wall, ceil: ip.ceil, light: ip.light, col: ip.col };
    },
    kits() { return rooms.map((r) => { const ip = kitOf(r); return [r.name, ip.floor, ip.wall, ip.ceil, ip.light, ip.col]; }); },
    variants: interiorVariants,
  };
}
