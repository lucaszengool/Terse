/**
 * wallpaper-styles.js — Pro 粒子壁纸的**风格库**。
 *
 * Pro 一直只有一种长相:六段编舞 + 一种"炸开/聚拢"的字。这个文件把那一种拆成
 * 一张表,再往表里加了七种。每一种风格改的是四件事,而不是换个配色了事:
 *
 *   1. `tints`     —— 同屏几条字各用一色的调色板(风格的第一眼)
 *   2. `dance`     —— 这套风格允许的编舞编号(mineradio-shaders.js 的 danceAt(),
 *                     0..9)。周围那一整片粒子怎么动,由这里决定。
 *   3. `in`/`out`  —— **字自己**怎么聚出来、怎么散掉(GLYPH_VS 的 dispAt(),0..8)。
 *                     两个是分开的:可以从上面落下来、往下面碎掉。
 *   4. `field`     —— 场的手感:丝绸层的开度、涟漪轻重、闪烁快慢、出字节奏。
 *
 * `in`/`out`/`dance` 都是**数组**,每次成型从洗好的牌里摸一张(engine 的 _bagPick),
 * 所以同一种风格里,连着两条字的出现方式也不会重样 —— 这正是"每一帧都不同"的来源。
 *
 * ⚠ `cinematic` 是**老的那一个,一个数都不许动**。它的每个字段都等于代码里原来的
 * 硬编码常量,DEFAULT 也是照它填的;新风格只覆盖自己要改的那几项。任何"顺手统一
 * 一下"的改动都会改掉已经在用户桌面上跑着的那张壁纸。
 */

/** 字的出现/消散手法编号 —— 和 GLYPH_VS 里的 dispAt() 一一对应 */
export const GLYPH_MOVE = {
  BURST: 0,    // 向四面八方炸开/聚拢(原版)
  ABOVE: 1,    // 从上方落下 / 往上方飞散
  VORTEX: 2,   // 绕着字心旋进 / 旋出
  SIDE: 3,     // 从一侧扫过来 / 扫走(配 staggerUv 就是打字机)
  DIFFUSE: 4,  // 几乎不位移,靠逐粒子渐显 —— 水墨在水里晕开
  RING: 5,     // 从一圈公共的环上收拢 / 摊回环上
  SHATTER: 6,  // 沿着"离字心的方向"崩开 —— 字在原地裂开
  DRIFT: 7,    // 整句朝同一个随机方向流走(每次成型换向)
  BELOW: 8,    // 从下方升起 / 往下方沉落
};

/** 编舞编号 —— danceAt() 里的分支(0..5 是原有六段,6..9 是这次加的) */
export const DANCE = {
  CLOUD: 0, SWIRL: 1, BREATHE: 2, SWAY: 3, STARFALL: 4, RIPPLE: 5,
  SPIRAL: 6, TIDE: 7, HEARTBEAT: 8, SNOW: 9,
};

/** 每个字段的兜底值 = 改造前代码里的硬编码常量。 */
const DEFAULT = {
  tints: ['#C9F03D', '#5AD8FF', '#FF9F45', '#B98CFF', '#7CF5C0', '#FFD75A'],
  dance: [0, 1, 2, 3, 4, 5],
  in: [GLYPH_MOVE.BURST],
  out: [GLYPH_MOVE.BURST],
  timing: { in: 400, hold: 1000, out: 667 },
  glyph: {
    /** 消散时位移到"完整散开距离"的几分之几。原版 uForm 掉到 0.25,即 0.75。 */
    outDepth: 0.75,
    /** 逐粒子错峰 0..0.9:0 = 全体同时,大 = 一颗颗先后到位 */
    stagger: 0,
    /** 错峰的排序依据:0 = 每颗粒子自己的随机数,1 = 它在字里的横向位置(打字机) */
    staggerUv: 0,
    /** 散开的粒子有多透明。0 = 和原版一样全程等亮(字是飞进来的);
     *  接近 1 = 只在落位时才亮(字是"显影"出来的) */
    dispFade: 0,
    /** 每颗粒子的呼吸频率 */
    twinkle: 2.6,
    /** 旋进/环收这类手法的旋转量(弧度) */
    swirl: 2.6,
    bloomSize: 2.4,
  },
  field: {
    /** 丝绸层(会起伏的那层粒子平面)最大开度 */
    silkAlpha: 0.20,
    /** 字浮现时整片粒子外扩多少 */
    burst: 0.55,
    /** 字落位那一发涟漪的强度;0 = 完全不推涟漪 */
    ripple: 0.55,
    /** 整片粒子被字的品牌色染走多少 */
    tint: 0.30,
    /** 待机底噪:固定的一段慢编舞 + 它的幅度 */
    idleDance: DANCE.SWAY,
    idleAmt: 0.16,
    /** 两条字之间隔多久(ms) */
    fillGap: 520,
    /** headline 后面跟一条小字的概率 */
    trail: 0.7,
  },
};

const merge = (s) => ({
  ...DEFAULT, ...s,
  timing: { ...DEFAULT.timing, ...(s.timing || {}) },
  glyph: { ...DEFAULT.glyph, ...(s.glyph || {}) },
  field: { ...DEFAULT.field, ...(s.field || {}) },
});

const M = GLYPH_MOVE, D = DANCE;

export const PRO_STYLES = [
  /* ── 0. 原版。改这一条 = 改所有已经在用户桌面上跑着的 Pro 壁纸 ── */
  merge({
    id: 'cinematic',
    name: '电影级 · 粒子聚合', en: 'Cinematic',
    desc: '片头式的粒子聚字,六段编舞轮换。Pro 的原始质感。',
    swatch: ['#C9F03D', '#5AD8FF'],
  }),

  /* ── 1. 极光丝绸:横向流动的缎带,字顺着流向来、顺着流向走 ── */
  merge({
    id: 'aurora',
    name: '极光 · 丝绸流', en: 'Aurora Silk',
    desc: '一整片缎带般的横流。字从流的上游被带出来,再顺着同一道流散走 —— 全程没有一次爆炸。',
    swatch: ['#7CF5C0', '#5AD8FF'],
    tints: ['#7CF5C0', '#5AD8FF', '#8B6BFF', '#B0FFE4', '#69E0FF', '#A9E8FF'],
    dance: [D.CLOUD, D.RIPPLE, D.SWAY, D.TIDE],
    in: [M.SIDE, M.DRIFT],
    out: [M.DRIFT, M.SIDE],
    timing: { in: 700, hold: 1500, out: 1000 },
    glyph: { outDepth: 1.0, stagger: 0.55, staggerUv: 1, dispFade: 0.45, twinkle: 1.6, bloomSize: 2.9 },
    field: { silkAlpha: 0.26, burst: 0.44, ripple: 0.30, tint: 0.36,
             idleDance: D.CLOUD, idleAmt: 0.20, fillGap: 780, trail: 0.55 },
  }),

  /* ── 2. 星陨:字从上面砸下来,散的时候继续往下掉 ── */
  merge({
    id: 'starfall',
    name: '星陨 · 陨星雨', en: 'Starfall',
    desc: '字从画面上方坠入、砸出涟漪,散时继续往下掉。周围粒子跟着一颗颗闪。',
    swatch: ['#FFD75A', '#FF9F45'],
    tints: ['#FFD75A', '#FF9F45', '#FFF3C4', '#FF6B4A', '#FFC26B', '#FFE9A8'],
    dance: [D.STARFALL, D.BREATHE, D.SNOW, D.HEARTBEAT],
    in: [M.ABOVE, M.ABOVE, M.BURST],
    out: [M.BELOW, M.BELOW, M.SHATTER],
    timing: { in: 430, hold: 1100, out: 760 },
    glyph: { outDepth: 1.0, stagger: 0.62, dispFade: 0.30, twinkle: 3.4, bloomSize: 3.1 },
    field: { silkAlpha: 0.22, burst: 0.70, ripple: 0.90, tint: 0.34,
             idleDance: D.SNOW, idleAmt: 0.18, fillGap: 460, trail: 0.75 },
  }),

  /* ── 3. 水墨:字几乎不移动,是在原地"显影"和"化开"的 ── */
  merge({
    id: 'ink',
    name: '水墨 · 晕染', en: 'Ink Wash',
    desc: '粒子几乎不飞 —— 字像墨滴进水里,一点点显影,又一点点化开。最安静的一种。',
    swatch: ['#E8ECF4', '#7E93A8'],
    tints: ['#E8ECF4', '#9FB4C7', '#C9D8E8', '#7E93A8', '#FFFFFF', '#B8C9DA'],
    dance: [D.BREATHE, D.SWAY, D.TIDE],
    in: [M.DIFFUSE],
    out: [M.DIFFUSE],
    timing: { in: 900, hold: 1900, out: 1200 },
    glyph: { outDepth: 1.0, stagger: 0.78, dispFade: 0.94, twinkle: 1.0, bloomSize: 3.4 },
    field: { silkAlpha: 0.15, burst: 0.30, ripple: 0.18, tint: 0.20,
             idleDance: D.BREATHE, idleAmt: 0.13, fillGap: 1200, trail: 0.35 },
  }),

  /* ── 4. 赛博霓虹:最快最硬的一种,字是"打"上去、"炸"掉的 ── */
  merge({
    id: 'neon',
    name: '霓虹 · 赛博', en: 'Neon Cyber',
    desc: '字一列列被打上屏幕,停一下,再原地崩裂。节奏最快,闪烁最密。',
    swatch: ['#FF3DCB', '#00F0FF'],
    tints: ['#FF3DCB', '#00F0FF', '#B14CFF', '#FFE14D', '#3DFF9E', '#FF5A8A'],
    dance: [D.SPIRAL, D.HEARTBEAT, D.RIPPLE, D.SWIRL],
    in: [M.SIDE, M.RING, M.SIDE],
    out: [M.SHATTER, M.BURST, M.SHATTER],
    timing: { in: 270, hold: 780, out: 480 },
    glyph: { outDepth: 1.0, stagger: 0.70, staggerUv: 1, dispFade: 0.55, twinkle: 5.4,
             swirl: 4.2, bloomSize: 2.2 },
    field: { silkAlpha: 0.24, burst: 0.78, ripple: 0.95, tint: 0.42,
             idleDance: D.SPIRAL, idleAmt: 0.19, fillGap: 340, trail: 0.85 },
  }),

  /* ── 5. 星涡:一切都绕着字心转 —— 字旋进来,再被旋出去 ── */
  merge({
    id: 'vortex',
    name: '星涡 · 引力', en: 'Gravity Vortex',
    desc: '整片粒子绕着那句话缓缓公转;字沿着螺线旋进画面,再被同一道引力甩散。',
    swatch: ['#B98CFF', '#5A3DFF'],
    tints: ['#B98CFF', '#6C7CFF', '#E36BFF', '#8FD0FF', '#5A3DFF', '#C7A8FF'],
    dance: [D.SWIRL, D.SPIRAL, D.BREATHE],
    in: [M.VORTEX, M.RING],
    out: [M.VORTEX, M.RING],
    timing: { in: 640, hold: 1200, out: 860 },
    glyph: { outDepth: 1.0, stagger: 0.40, dispFade: 0.35, twinkle: 2.1, swirl: 3.4, bloomSize: 2.7 },
    field: { silkAlpha: 0.23, burst: 0.60, ripple: 0.48, tint: 0.34,
             idleDance: D.SWIRL, idleAmt: 0.17, fillGap: 700, trail: 0.6 },
  }),

  /* ── 6. 花火:向内收成字,再像烟花一样整句炸开 ── */
  merge({
    id: 'bloom',
    name: '花火 · 绽放', en: 'Fireworks',
    desc: '粒子从一圈环上收拢成字,停住,然后整句沿着自己的中心炸开 —— 一次一朵。',
    swatch: ['#FF7A9C', '#FFB35A'],
    tints: ['#FF7A9C', '#FFB35A', '#FF5A5A', '#FFE08A', '#FF9ED8', '#FFC9A8'],
    dance: [D.HEARTBEAT, D.BREATHE, D.STARFALL, D.SWIRL],
    in: [M.RING, M.VORTEX],
    out: [M.SHATTER],
    timing: { in: 540, hold: 950, out: 820 },
    glyph: { outDepth: 1.0, stagger: 0.30, dispFade: 0.40, twinkle: 2.9, swirl: 3.0, bloomSize: 3.2 },
    field: { silkAlpha: 0.25, burst: 0.82, ripple: 1.0, tint: 0.38,
             idleDance: D.BREATHE, idleAmt: 0.16, fillGap: 620, trail: 0.7 },
  }),

  /* ── 7. 静水:最慢的一种。字从下面浮上来,再蒸发掉 ── */
  merge({
    id: 'zen',
    name: '静水 · 呼吸', en: 'Still Water',
    desc: '字从画面下方缓缓浮起,停很久,再像水汽一样向上蒸发。几乎不推涟漪。',
    swatch: ['#BFE9FF', '#DFF6EC'],
    tints: ['#BFE9FF', '#DFF6EC', '#A8D8F0', '#EAF6FF', '#9FC8E8', '#CFE9F5'],
    dance: [D.TIDE, D.BREATHE, D.SWAY],
    in: [M.BELOW],
    out: [M.ABOVE],
    timing: { in: 950, hold: 2000, out: 1200 },
    glyph: { outDepth: 1.0, stagger: 0.66, dispFade: 0.60, twinkle: 0.9, bloomSize: 3.0 },
    field: { silkAlpha: 0.17, burst: 0.34, ripple: 0.12, tint: 0.22,
             idleDance: D.TIDE, idleAmt: 0.14, fillGap: 1400, trail: 0.3 },
  }),
];

export const DEFAULT_STYLE_ID = 'cinematic';

/** 找一种风格;认不出来的 id 一律退回原版(配置文件被手改过也不至于黑屏)。 */
export function getProStyle(id) {
  return PRO_STYLES.find(s => s.id === id) || PRO_STYLES[0];
}

/* ── 自定义 · Custom ─────────────────────────────────────────────────────────
   八种风格是八个**预设**,不是八个上限。这一段让用户从任意一种出发,把每一个参数
   都改成自己的。

   两个决定值得写下来:

   1. 自定义存的是**差量**,不是整张表。用户改的是"在 zen 的基础上再慢一点",
      不是"我要一整套新参数"—— 存差量,以后调了预设的兜底值,用户那份还跟着走;
      存整份就永远停在改的那天。

   2. 下面这张 SCHEMA 是 UI 的**唯一来源**。控件是照着它生成的,不是一个一个手写的,
      所以"每个参数都能改"是结构上成立的:往 DEFAULT 里加一个字段、在这里描述一行,
      面板上就多一个控件。手写的面板迟早会漏掉某一项,而漏掉的那一项没人会发现。 */

/** 一个参数的可编辑描述。type 决定控件,min/max/step 决定手感。 */
export const STYLE_SCHEMA = [
  { group: '节奏 · Timing', key: 'timing.in',   label: '聚合', unit: 'ms', type: 'range', min: 120, max: 2400, step: 10,
    hint: '字从散粒聚成形要多久' },
  { group: '节奏 · Timing', key: 'timing.hold', label: '停留', unit: 'ms', type: 'range', min: 200, max: 6000, step: 10,
    hint: '成形后停多久才开始散' },
  { group: '节奏 · Timing', key: 'timing.out',  label: '消散', unit: 'ms', type: 'range', min: 120, max: 3000, step: 1,
    hint: '散回粒子要多久' },
  { group: '节奏 · Timing', key: 'field.fillGap', label: '间隔', unit: 'ms', type: 'range', min: 0, max: 4000, step: 10,
    hint: '两条字之间空多久' },
  { group: '节奏 · Timing', key: 'field.trail', label: '跟一条小字', type: 'range', min: 0, max: 1, step: 0.01,
    hint: '大字后面跟一条小字的概率' },

  { group: '字 · Glyph', key: 'glyph.outDepth',  label: '散开距离', type: 'range', min: 0, max: 1.5, step: 0.01,
    hint: '消散时飞多远。1 以上会飞出画面' },
  { group: '字 · Glyph', key: 'glyph.stagger',   label: '逐粒错峰', type: 'range', min: 0, max: 0.95, step: 0.01,
    hint: '0 = 所有粒子同时到位;大 = 一颗颗先后落位' },
  { group: '字 · Glyph', key: 'glyph.staggerUv', label: '打字机', type: 'range', min: 0, max: 1, step: 0.01,
    hint: '错峰按横向位置排序 —— 配合错峰就是从左往右打出来' },
  { group: '字 · Glyph', key: 'glyph.dispFade',  label: '显影感', type: 'range', min: 0, max: 1, step: 0.01,
    hint: '0 = 字是飞进来的;接近 1 = 字是在原地显影出来的' },
  { group: '字 · Glyph', key: 'glyph.twinkle',   label: '呼吸频率', type: 'range', min: 0, max: 8, step: 0.1,
    hint: '每颗粒子明暗起伏的快慢' },
  { group: '字 · Glyph', key: 'glyph.swirl',     label: '旋转量', unit: 'rad', type: 'range', min: 0, max: 8, step: 0.1,
    hint: '旋进 / 环收这类手法转多少' },
  { group: '字 · Glyph', key: 'glyph.bloomSize', label: '光晕', type: 'range', min: 0.5, max: 6, step: 0.1,
    hint: '每颗粒子的大小与辉光' },

  { group: '场 · Field', key: 'field.silkAlpha', label: '丝绸层', type: 'range', min: 0, max: 0.6, step: 0.01,
    hint: '背景那层起伏粒子的可见度' },
  { group: '场 · Field', key: 'field.burst',     label: '外扩', type: 'range', min: 0, max: 1.5, step: 0.01,
    hint: '字浮现时整片粒子被推开多少' },
  { group: '场 · Field', key: 'field.ripple',    label: '涟漪', type: 'range', min: 0, max: 1.5, step: 0.01,
    hint: '字落位那一下的冲击波强度' },
  { group: '场 · Field', key: 'field.tint',      label: '染色', type: 'range', min: 0, max: 1, step: 0.01,
    hint: '整片粒子被字的颜色染走多少' },
  { group: '场 · Field', key: 'field.idleAmt',   label: '待机幅度', type: 'range', min: 0, max: 0.6, step: 0.01,
    hint: '没有字的时候,粒子自己动多大' },
  { group: '场 · Field', key: 'field.idleDance', label: '待机编舞', type: 'enum', options: DANCE,
    hint: '没有字的时候跳哪一段' },

  { group: '编舞 · Motion', key: 'dance', label: '编舞池', type: 'multi', options: DANCE,
    hint: '周围粒子会跳的段落 —— 每次成型从里面摸一张,所以选得越多越不重样' },
  { group: '编舞 · Motion', key: 'in',    label: '聚合手法', type: 'multi', options: GLYPH_MOVE,
    hint: '字怎么聚出来' },
  { group: '编舞 · Motion', key: 'out',   label: '消散手法', type: 'multi', options: GLYPH_MOVE,
    hint: '字怎么散掉' },

  { group: '配色 · Colour', key: 'tints', label: '调色板', type: 'colors',
    hint: '同屏几条字各用一色 —— 一次一条,按顺序取' },
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 深合并:数组整段替换(选中的编舞就是"这几段",不是"再加几段")。 */
function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v === undefined || v === null) continue;
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 读/写点号路径('glyph.stagger'),给通用控件用。 */
export function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function writePath(obj, path, value) {
  const ks = path.split('.');
  const last = ks.pop();
  let cur = obj;
  for (const k of ks) { if (!isObj(cur[k])) cur[k] = {}; cur = cur[k]; }
  cur[last] = value;
  return obj;
}

/**
 * 最终生效的风格 = 预设 + 用户差量。
 *
 * `custom` 认不出来或者是空的,结果就**逐字节等于** getProStyle(id) —— 没开自定义
 * 的用户看到的东西一个像素都不会变。
 */
export function resolveStyle(id, custom) {
  const base = getProStyle(id);
  if (!isObj(custom) || !Object.keys(custom).length) return base;
  return deepMerge(base, custom);
}

export default PRO_STYLES;
