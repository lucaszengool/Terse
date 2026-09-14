/**
 * room-interior.js — 走进一座楼之后的**室内文法**。
 *
 * city-styles.js 管的是外面:一栋楼被拆成台基 × 楼身 × 外皮 × 楼冠 × 附件,风格
 * 决定每个槽位能用哪些件,种子从目录名算。这个文件是同一件事的**里面**:
 *
 *     地面 floor × 墙面 wall × 顶 ceiling × 灯具 light × 柱式 column × 陈列 display
 *
 * 为什么不是"一个风格一间样板房":那样同一个项目里四个目录会长得一模一样,只是
 * 大小不同 —— 那不叫装修,那叫复制粘贴。槽位一拆,persia 一个风格就能拼出几十种
 * 不重样的厅堂,而每一间仍然一眼看得出是波斯。
 *
 * ⚠ 三条规矩,和外面那套是同一条:
 *
 *   一,**风格跟着楼走**。走进一座蓝釉洋葱穹顶的楼,里面不能是北欧木构。风格 id
 *     直接取胶囊里那个,`styleOf` 兜底不认识的值。
 *   二,**种子取自目录名**,而且用的是 city-styles 导出的同一个 `seedOf` ——
 *     同一个目录每次进去必须是同一间屋子。各写一份哈希就会各自漂移。
 *   三,**颜色分两层**:房子的颜色来自风格调色板(砂岩、朱红、蓝釉),文件的颜色
 *     来自它的语言。前者是外观,后者是数据 —— 混在一起,颜色就不再说明任何事。
 */

import { styleOf, seedOf, picker } from './city-styles.js';
import { LANG_COLOR, LANG_FALLBACK, langOfFile, langRgb } from './lang-colors.js';
import { roleOfName } from './room-furniture.js';

/* ── 每个风格能用哪些件 ──────────────────────────────────────────────────────
   词汇表的差别就是风格的差别:唐宋拿得到斗拱和格栅,古希腊只拿得到凹槽柱和藻井,
   两边都拿不到对方的件。 */
export const INTERIOR = {
  modern: { floor: ['slab', 'grid'],      wall: ['fin', 'glass'],      ceil: ['flat', 'coffer'],   light: ['strip', 'chandelier'], col: ['plain', 'none'], disp: ['plinth', 'pillar'] },
  tang:   { floor: ['board', 'rosette'],  wall: ['lattice', 'timber'], ceil: ['beam', 'coffer'],   light: ['lantern'],             col: ['dougong'],       disp: ['pillar', 'shelf'] },
  edo:    { floor: ['tatami', 'board'],   wall: ['lattice', 'timber'], ceil: ['beam', 'flat'],     light: ['lantern', 'candle'],   col: ['plain'],         disp: ['plinth', 'shelf'] },
  giza:   { floor: ['band', 'slab'],      wall: ['glyph', 'fin'],      ceil: ['flat', 'corbel'],   light: ['brazier', 'oculus'],   col: ['lotus'],         disp: ['pillar', 'niche'] },
  hellas: { floor: ['mosaic', 'slab'],    wall: ['fin', 'glyph'],      ceil: ['dome', 'coffer'],   light: ['oculus', 'brazier'],   col: ['fluted'],        disp: ['plinth', 'pillar'] },
  maya:   { floor: ['band', 'mosaic'],    wall: ['glyph', 'fin'],      ceil: ['corbel', 'flat'],   light: ['brazier'],             col: ['plain', 'none'], disp: ['pillar', 'niche'] },
  persia: { floor: ['mosaic', 'rosette'], wall: ['mosaic', 'lattice'], ceil: ['onion', 'dome'],    light: ['chandelier', 'lantern'], col: ['slender'],     disp: ['niche', 'pillar'] },
  norse:  { floor: ['board'],             wall: ['timber', 'lattice'], ceil: ['beam', 'corbel'],   light: ['candle', 'brazier'],   col: ['stave'],         disp: ['shelf', 'pillar'] },
};
const FALLBACK = INTERIOR.modern;

/* ── 小工具 ── */
const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const mix = (a, b, t) => [cl(a[0] + (b[0] - a[0]) * t), cl(a[1] + (b[1] - a[1]) * t), cl(a[2] + (b[2] - a[2]) * t)];
/** 调色板里的颜色是**漆**,加色混合里要当**光**用,不提亮就一片灰。 */
export function asLight(rgb, k = 0.95) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
  return [cl(rgb[0] / mx * k), cl(rgb[1] / mx * k), cl(rgb[2] / mx * k)];
}

/**
 * 这个目录该装成什么样。纯函数,同样的入参永远同样的结果。
 * @param {string} styleId  胶囊里的风格 id(外面那座城市用的同一个)
 * @param {string} dirName  目录名 —— 种子
 */
export function interiorOf(styleId, dirName, sig) {
  const style = styleOf(styleId);
  const voc = INTERIOR[style.id] || FALLBACK;
  // 加一个盐:同一个目录的"外形"和"装修"不该被同一串随机数绑在一起。
  const p = picker(seedOf('interior:' + dirName + '@' + style.id));
  const out = {
    style,
    pal: style.pal,
    floor: p.of(voc.floor), wall: p.of(voc.wall), ceil: p.of(voc.ceil),
    light: p.of(voc.light), col: p.of(voc.col), disp: p.of(voc.disp),
    // disp 槽已经不用了(文件改由 room-furniture.js 摆成家具),但抽签照旧抽 ——
    // 删掉它,后面的 grain / bays 会整体错一位,每一间见过的屋子都会变样。
    // 一间屋子自己的两个小变量:纹样的疏密、柱子的根数。
    grain: p.int(6, 14), bays: p.int(2, 4), rnd: p,
    why: {}, tint: null, mood: null,
  };
  if (!sig || !sig.n) return out;
  /* 有代码可看的时候,每个槽位**按代码挑**(还是只在这个风格的词汇表里挑)。
     挑中了就记下理由 —— 走进屋子时屏幕上说的"为什么这间屋子长这样",就是这些。 */
  const pick = (slot, order, reason) => { const hit = order.find((o) => voc[slot].includes(o)); if (hit) { out[slot] = hit; out.why[slot] = reason; } };
  const R = sig.roles;
  if (R.test >= 0.3) pick('floor', ['grid', 'slab', 'tatami'], 'tests');
  else if (R.docs >= 0.3) pick('floor', ['board', 'tatami', 'rosette'], 'docs');
  else if (sig.ui >= 0.3) pick('floor', ['mosaic', 'rosette', 'grid'], 'ui');
  else if (sig.cfg >= 0.3) pick('floor', ['slab', 'band', 'board'], 'config');
  if (R.docs >= 0.3) pick('wall', ['timber', 'lattice'], 'docs');
  else if (sig.ui >= 0.3) pick('wall', ['glass', 'mosaic', 'lattice'], 'ui');
  else if (R.test >= 0.3) pick('wall', ['glass', 'fin'], 'tests');
  else if (sig.cfg >= 0.3) pick('wall', ['fin', 'glyph'], 'config');
  if (sig.cls >= 0.4) pick('ceil', ['coffer', 'dome', 'onion', 'corbel'], 'classes');
  else if (sig.fns >= 0.6) pick('ceil', ['beam', 'flat', 'corbel'], 'functions');
  else if (R.docs >= 0.3) pick('ceil', ['dome', 'onion', 'coffer', 'beam'], 'docs');
  if (sig.n >= 30) pick('light', ['chandelier', 'lantern', 'brazier', 'strip'], 'many');
  else if (sig.n <= 6) pick('light', ['candle', 'lantern', 'oculus'], 'few');
  out.bays = Math.max(1, Math.min(4, Math.round(Math.log2(1 + sig.n) / 1.5)));
  out.tint = sig.langRgb;
  out.mood = R.test >= 0.3 ? { col: [0.72, 0.84, 0.9], k: 0.18, why: 'tests' }
    : R.docs >= 0.3 ? { col: [0.96, 0.86, 0.66], k: 0.18, why: 'docs' }
    : sig.ui >= 0.3 ? { col: [0.98, 0.97, 0.95], k: 0.22, why: 'ui' }
    : sig.cfg >= 0.3 ? { col: [0.6, 0.66, 0.72], k: 0.2, why: 'config' } : null;
  return out;
}

/**
 * 一间屋子的代码长什么样:多少文件、各种用途各占几成、符号里类/类型和函数的比例、
 * 主语言、平均被引用多少次。interiorOf 按它挑装修 —— **同一座楼里的两间屋子,代码
 * 不一样,屋子就不一样。**
 * @param {Array} files layoutOf 整理过的文件(name, sub, bytes, lines, lang, role, sym, imp)
 */
export function signatureOf(files, dirLang = '') {
  const list = Array.isArray(files) ? files : [];
  const roles = {}, byLang = {};
  let bytes = 0, lines = 0, syms = 0, cls = 0, fns = 0, imp = 0;
  for (const f of list) {
    const role = f.role || roleOfName(f.name, f.sub);
    roles[role] = (roles[role] || 0) + 1;
    const l = langOfFile(f.name) || f.lang || dirLang;
    if (l) byLang[l] = (byLang[l] || 0) + Math.max(1, f.bytes || 0);
    bytes += f.bytes || 0; lines += f.lines || 0; imp += f.imp || 0;
    for (const s of f.sym || []) {
      syms++;
      if (s[1] === 'class' || s[1] === 'type') cls++;
      else if (s[1] === 'fn' || s[1] === 'hook') fns++;
    }
  }
  const n = list.length, fr = (k) => (n ? (roles[k] || 0) / n : 0);
  const lang = (Object.entries(byLang).sort((a, b) => b[1] - a[1])[0] || [dirLang])[0] || '';
  const R = {};
  for (const k of ['entry', 'component', 'hook', 'test', 'types', 'config', 'docs', 'style', 'asset', 'data', 'source']) R[k] = fr(k);
  return {
    n, bytes, lines, syms, lang, langRgb: lang ? langRgb(lang) : null, roles: R,
    ui: R.component + R.style + R.asset, cfg: R.config + R.data,
    cls: syms ? cls / syms : 0, fns: syms ? fns / syms : 0, imp: n ? imp / n : 0,
  };
}

/** 这套文法一共能拼出多少间不重样的屋子 —— 和 styleVariants 是同一个意思。 */
export function interiorVariants() {
  let n = 0;
  for (const v of Object.values(INTERIOR)) n += v.floor.length * v.wall.length * v.ceil.length * v.light.length * v.col.length * v.disp.length;
  return n;
}

/* ══ 平面图 ════════════════════════════════════════════════════════════════
   一个目录摆成一座厅:大厅在中间,最大的几个子目录是四面的房间。纯函数 ——
   room-scene.js 拿它盖房子,测试拿它对账,两边看到的是同一张图。 */
export const HALL_W = 18, HALL_D = 14, HALL_H = 6.2, ROOM_H = 3.6, DOOR_W = 2.4, PAD = 0.4;
/** 大厅四面各开一扇门。第五个子目录没有墙可以开门了 —— 它的文件留在大厅里,
 *  展品上照样写着它在哪个子目录下,而不是被丢掉。 */
const MAX_KID_ROOMS = 4;

const hex2rgb = (h) => { const n = parseInt(String(h).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

/** 一个文件的颜色:**它自己的**语言,认不出扩展名才退回目录的主语言。
 *  这是光的颜色,不是漆的颜色 —— 见 room-interior.js 的 asLight。 */
export function fileLight(name, dirLang) {
  const l = langOfFile(name) || dirLang || '';
  return asLight(hex2rgb(LANG_COLOR[l] || LANG_FALLBACK));
}

/** 外面那座楼是什么风格,里面就是什么格局:唐宋走进去是一座四合院,江户是一座
 *  庭院,其余是一座厅。风格跟着楼走,格局跟着风格走。 */
export function layoutFor(styleId) {
  return styleId === 'tang' ? 'siheyuan' : styleId === 'edo' ? 'garden' : 'hall';
}
export const LAYOUTS = ['hall', 'siheyuan', 'garden'];
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 一个文件,不管来自深扫(对象)还是胶囊的 leaves(三元组),都整理成同一个形状。
 *  sym 为 null 表示"不知道",[] 表示"扫过了,里面没有符号" —— 两者画法不同。 */
function fileOf(f, deep) {
  if (deep) {
    return {
      name: String(f.n || ''), path: String(f.p || ''), sub: String(f.sub || ''), bytes: +f.b || 0,
      lines: +f.l || 0, lang: String(f.lang || ''), role: f.role ? String(f.role) : '',
      sym: Array.isArray(f.sym) ? f.sym : [], imp: +f.imp || 0, out: +f.out || 0,
    };
  }
  return { name: String(f[0]), path: '', sub: String(f[2] || ''), bytes: +f[1] || 0, lines: 0, lang: '', role: '', sym: null, imp: 0, out: 0 };
}

/**
 * 胶囊里的一个目录 → 平面图。矩形既是几何也是碰撞。
 *
 * 大厅(或院子)在中间,最大的四个子目录各占一面。房间**多大由它装多少文件决定** ——
 * 固定尺寸的屋子,装三个文件是空旷的,装六十个就摆不下。
 *
 * @param {{name?:string, kids?:Array, leaves?:Array, detail?:object}} dir
 *   detail = 深扫结果(api/github-room.js):有它就用它的 files / kids,每个文件带符号
 * @param {{layout?:'hall'|'siheyuan'|'garden'}} [opts]
 */
export function layoutOf(dir, opts = {}) {
  const layout = LAYOUTS.includes(opts && opts.layout) ? opts.layout : 'hall';
  const open = layout !== 'hall';
  const name = String((dir && dir.name) || '/');
  const detail = dir && dir.detail && Array.isArray(dir.detail.files) ? dir.detail : null;
  const kidsSrc = detail && Array.isArray(detail.kids) ? detail.kids : (Array.isArray(dir && dir.kids) ? dir.kids : []);
  const kidsAll = kidsSrc
    .filter((k) => Array.isArray(k) && k[0])
    .map((k) => [String(k[0]), +k[1] || 0, +k[2] || 0]);
  // 最大的几个拿到房间。按字节排,和城市里"楼高是代码量"说的是同一件事。
  const kids = kidsAll.slice().sort((a, b) => b[2] - a[2]).slice(0, MAX_KID_ROOMS);

  /* 文件按它在哪个子目录下分进各个房间。对不上房间的(顶层文件、第五个以后的子目录)
     留在大厅。⚠ leaves 缺席和 leaves 为空是两回事:缺席是"胶囊在这个字段出现之前
     扫的",调用方要说一声;为空才是"这个目录里真没有文件"。 */
  const hasLeaves = !!detail || Array.isArray(dir && dir.leaves);
  const roomNames = new Set(kids.map((k) => k[0]));
  const byRoom = new Map();
  const src = detail ? detail.files : (Array.isArray(dir && dir.leaves) ? dir.leaves : []);
  for (const raw of src) {
    if (detail ? !(raw && raw.n) : !(Array.isArray(raw) && raw[0])) continue;
    const f = fileOf(raw, !!detail);
    f.i = src.indexOf(raw);                      // 深扫的 edges 用的是这个下标
    const into = roomNames.has(f.sub) ? f.sub : '';
    if (!byRoom.has(into)) byRoom.set(into, []);
    byRoom.get(into).push(f);
  }
  const count = (k) => (byRoom.get(k) || []).length;

  const nh = count('');
  const W = open ? clampN(14 + Math.sqrt(nh) * 1.2, 14, 24) : clampN(16 + Math.sqrt(nh) * 1.4, 16, 28);
  const D = Math.round(W * 0.78 * 10) / 10;
  // 厅有多高由这座楼有多少代码决定 —— 一个小工具目录不该住在八米高的殿里。
  let dirBytes = +(dir && dir.bytes) || 0;
  if (!dirBytes) for (const fs of byRoom.values()) for (const f of fs) dirBytes += f.bytes;
  const hallH = clampN(4.6 + Math.log10(1 + dirBytes / 20000) * 1.4, 4.8, 8);
  const hall = {
    x0: -W / 2, z0: -D / 2, x1: W / 2, z1: D / 2, name, files: +(dir && dir.files) || 0,
    h: open ? 3.4 : hallH, isHall: true, open,
    kind: layout === 'hall' ? 'hall' : layout === 'siheyuan' ? 'court' : 'garden',
  };
  const rooms = [hall];
  const doors = [];
  const avg = kids.reduce((a, k) => a + k[2], 0) / Math.max(1, kids.length);
  // 四合院的次序是 正房(北)→ 东厢 → 西厢 → 倒座(南);厅和庭院沿用 北东南西。
  const sides = layout === 'hall' ? ['N', 'E', 'S', 'W'] : ['N', 'E', 'W', 'S'];

  kids.forEach((k, i) => {
    const [kn, files, bytes] = k;
    const n = count(kn);
    const share = Math.max(0.55, Math.min(1.5, avg ? bytes / avg : 1));
    const side = sides[i];
    // along = 沿着共用那面墙的长度,deep = 往外伸多深
    let along = clampN(5.6 + Math.sqrt(n) * 1.0 + share * 1.2, 6, 13);
    let deep = clampN(4.8 + Math.sqrt(n) * 0.7 + share, 5, 10);
    let h = open ? 3.4 : clampN(3.2 + Math.log10(1 + bytes / 8000) * 0.9, 3.2, 5.2);
    if (layout === 'siheyuan') {
      // 正房最宽最深最高;厢房贴满院子整条边;倒座和院子一样宽。
      if (side === 'N') { along = W + 2; deep = Math.max(deep, 6.5); h = 4.8; }
      else if (side === 'S') { along = W; deep = 5; h = 4.0; }
      else { along = D; deep = clampN(deep, 5, 7); h = 4.2; }
    }
    let rect;
    if (side === 'N')      rect = { x0: -along / 2, z0: hall.z0 - deep, x1: along / 2, z1: hall.z0 };
    else if (side === 'S') rect = { x0: -along / 2, z0: hall.z1, x1: along / 2, z1: hall.z1 + deep };
    else if (side === 'E') rect = { x0: hall.x1, z0: -along / 2, x1: hall.x1 + deep, z1: along / 2 };
    else                   rect = { x0: hall.x0 - deep, z0: -along / 2, x1: hall.x0, z1: along / 2 };
    Object.assign(rect, { name: kn, files, bytes, side, h, isHall: false, open: false, kind: layout === 'hall' ? 'room' : layout === 'siheyuan' ? 'wing' : 'pavilion' });
    rooms.push(rect);
    if (side === 'N' || side === 'S') {
      const z = side === 'N' ? hall.z0 : hall.z1;
      doors.push({ x0: -DOOR_W / 2, z0: z - 0.8, x1: DOOR_W / 2, z1: z + 0.8, side, room: kn, cx: 0, cz: z });
    } else {
      const x = side === 'E' ? hall.x1 : hall.x0;
      doors.push({ x0: x - 0.8, z0: -DOOR_W / 2, x1: x + 0.8, z1: DOOR_W / 2, side, room: kn, cx: x, cz: 0 });
    }
  });

  return {
    layout, open, name, hall, rooms, doors, byRoom, hasLeaves,
    hasSymbols: !!detail, truncated: !!(detail && detail.truncated),
    // 谁 import 谁:[i, j] 是 files 里的下标,i 引用了 j。家具按它坐,地上的线按它连。
    edges: detail && Array.isArray(detail.edges) ? detail.edges.filter((e) => Array.isArray(e) && e.length >= 2) : [],
    extraKids: kidsAll.length - kids.length,
    start: { x: 0, z: D / 2 - 2.4, yaw: 0 },
    // 院子里走不过去的东西(树、鱼缸、池塘、石头)。装饰画完才知道在哪儿,由它们自己登记。
    blocks: [],
  };
}
