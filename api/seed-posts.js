#!/usr/bin/env node
/**
 * seed-posts.js — 五十条**不是项目**的帖子:文字、图片、动图。
 *
 *   node api/seed-posts.js                                  写进本地库
 *   node api/seed-posts.js --remote https://www.terseai.org  发到线上
 *
 * 广场原本只有代码城市。城市是这个产品的招牌,但**一个只有招牌的广场是一间展厅**,
 * 不是一个会有人天天来刷的地方 —— 抖音上那两万多个做 vibecoding 的人发的东西,
 * 大部分并不是"这是我的仓库",而是:
 *
 *   · 教程 —— 从零到一怎么把一个能跑的东西做出来,第一句需求怎么提
 *   · 战报 —— 一晚上做了个什么,通常是个古怪的小工具
 *   · 翻车 —— AI 把我的数据库删了 / 上下文一满就开始胡说
 *   · 数字 —— token 花了多少,省了多少
 *
 * 所以这里生成的就是这四类。⚠ 内容以中文为主:参照的是抖音,而那边的人就是这么写的。
 *
 * ⚠ 动图**是算出来的,不是找来的**。每一帧用 tinypng 现画 —— 于是没有素材、
 * 没有版权、没有下载,而且每一条的动作都不一样。和城市、和音乐是同一条路子:
 * 这个 app 从不搬运画面。
 */
const crypto = require('crypto');
const { png } = require('./tinypng');

const REMOTE = (() => {
  const i = process.argv.indexOf('--remote');
  return i > 0 ? process.argv[i + 1] : null;
})();
const COUNT = 50;
const SALT = 'terse-posts-v1';

/* ── 一点点随机,但每次跑出来一样 ─────────────────────────────────────── */
function rng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// 真实音频文件的 id,和 landing/audio/tracks.json 对应。
const TUNES = ["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11", "t12"];

/* ── 主题 ─────────────────────────────────────────────────────────────────
   ⚠ 一个模板画五十张图,五十张图长得一模一样 —— 那不是"像真人发的",那是
   "同一个人用同一个工具生成了五十次"。真人的截图之所以各不相同,首先是因为
   **每个人的编辑器长得不一样**:主题、亮色暗色、有没有行号、有没有标签栏。

   所以十套真实存在的配色,里面**有三套是亮色的** —— 一屏白底夹在一堆黑底中间,
   一眼就知道那是另一个人的机器。 */
const THEMES = {
  darkplus: { bg: [13,17,23], panel: [24,24,27], bar: [37,37,38], line: [62,62,66],
    dim: [106,115,125], text: [212,212,212], white: [255,255,255],
    kw: [197,134,192], str: [206,145,120], num: [181,206,168], err: [244,71,71], ok: [78,201,176] },
  dracula: { bg: [30,31,44], panel: [40,42,54], bar: [68,71,90], line: [98,114,164],
    dim: [98,114,164], text: [248,248,242], white: [255,255,255],
    kw: [255,121,198], str: [241,250,140], num: [189,147,249], err: [255,85,85], ok: [80,250,123] },
  nord: { bg: [36,41,51], panel: [46,52,64], bar: [59,66,82], line: [76,86,106],
    dim: [116,127,141], text: [216,222,233], white: [236,239,244],
    kw: [129,161,193], str: [163,190,140], num: [180,142,173], err: [191,97,106], ok: [143,188,187] },
  onedark: { bg: [33,37,43], panel: [40,44,52], bar: [55,60,70], line: [76,82,99],
    dim: [92,99,112], text: [171,178,191], white: [255,255,255],
    kw: [198,120,221], str: [152,195,121], num: [209,154,102], err: [224,108,117], ok: [86,182,194] },
  gruvbox: { bg: [29,32,33], panel: [40,40,40], bar: [60,56,54], line: [80,73,69],
    dim: [146,131,116], text: [235,219,178], white: [251,241,199],
    kw: [251,73,52], str: [184,187,38], num: [211,134,155], err: [251,73,52], ok: [142,192,124] },
  monokai: { bg: [34,35,28], panel: [39,40,34], bar: [62,63,55], line: [86,87,80],
    dim: [117,113,94], text: [248,248,242], white: [255,255,255],
    kw: [249,38,114], str: [230,219,116], num: [174,129,255], err: [249,38,114], ok: [166,226,46] },
  midnight: { bg: [8,11,20], panel: [13,18,32], bar: [22,29,48], line: [34,44,70],
    dim: [88,102,136], text: [200,214,240], white: [240,246,255],
    kw: [130,170,255], str: [195,232,141], num: [247,140,108], err: [255,83,112], ok: [137,221,255] },
  // ── 亮色。真人里用亮色的不少,而一屏白底是最强的"这不是同一台机器"的信号 ──
  solarized: { bg: [253,246,227], panel: [238,232,213], bar: [220,214,196], line: [190,185,170],
    dim: [147,161,161], text: [88,110,117], white: [7,54,66],
    kw: [211,54,130], str: [42,161,152], num: [38,139,210], err: [220,50,47], ok: [133,153,0] },
  ghlight: { bg: [255,255,255], panel: [246,248,250], bar: [234,238,242], line: [208,215,222],
    dim: [140,149,159], text: [36,41,47], white: [1,4,9],
    kw: [207,34,46], str: [10,96,169], num: [130,80,223], err: [207,34,46], ok: [26,127,55] },
  paper: { bg: [250,250,248], panel: [242,241,237], bar: [228,227,222], line: [205,204,198],
    dim: [150,148,140], text: [45,44,40], white: [20,19,16],
    kw: [140,60,150], str: [40,110,90], num: [180,95,30], err: [190,45,45], ok: [55,130,70] },
};
const THEME_IDS = Object.keys(THEMES);

/** 这一张图的"这台机器长什么样"。全部从这条帖子自己的种子里抽 —— 于是同一条
 *  帖子每次生成都一样,而两条帖子几乎不可能长得一样。 */
function chromeFor(r) {
  return {
    th: THEMES[pick(r, THEME_IDS)],
    dots: r() < 0.72,          // 左上角那三个圆点
    tabs: r() < 0.45,          // 标签栏
    nums: r() < 0.55,          // 行号
    status: r() < 0.40,        // 底部状态栏
    side: r() < 0.5,           // 侧边栏
    inset: pick(r, [0.02, 0.035, 0.05, 0.07]),   // 窗口离边多远
    tint: r() < 0.25,          // 选中行的高亮
  };
}

const box = (u, v, x0, y0, x1, y1) => u >= x0 && u <= x1 && v >= y0 && v <= y1;
const bar = (u, v, x0, y, w, h) => box(u, v, x0, y - h / 2, x0 + w, y + h / 2);

/** 窗口外壳。返回 null = 在窗口外面;返回颜色 = 这个点归外壳管;
 *  返回 'body' = 里面,交给场景自己画。 */
function shell(u, v, C, K) {
  const m = K.inset;
  if (!box(u, v, m, m, 1 - m, 1 - m)) return null;
  const top = m + (K.dots || K.tabs ? 0.085 : 0);
  if (v < top) {
    if (K.dots) {
      const d = [m + 0.035, m + 0.075, m + 0.115];
      for (let i = 0; i < 3; i++) {
        if (Math.hypot((u - d[i]) * 1.33, v - (m + 0.042)) < 0.017) {
          return [C.err, [230, 180, 60], C.ok][i];
        }
      }
    }
    if (K.tabs) {
      // 两三个标签,当前那个亮一点
      const tw = 0.17, x0 = K.dots ? m + 0.16 : m + 0.02;
      for (let i = 0; i < 3; i++) {
        if (box(u, v, x0 + i * tw, m + 0.012, x0 + i * tw + tw - 0.012, top - 0.005)) {
          if (bar(u, v, x0 + i * tw + 0.02, m + 0.045, tw * 0.55, 0.02)) return i === 1 ? C.text : C.dim;
          return i === 1 ? C.panel : C.bar;
        }
      }
    }
    return C.bar;
  }
  const bot = 1 - m - (K.status ? 0.055 : 0);
  if (v > bot) {                                   // 状态栏
    if (bar(u, v, m + 0.03, 1 - m - 0.027, 0.16, 0.018)) return C.ok;
    if (bar(u, v, 1 - m - 0.24, 1 - m - 0.027, 0.18, 0.018)) return C.dim;
    return C.bar;
  }
  return 'body';
}

/** 行号那一列。 */
function gutter(u, v, C, K, x0, y, i) {
  if (!K.nums) return null;
  if (bar(u, v, x0, y, 0.022, 0.02)) return C.dim;
  return null;
}

/* ── 场景 ─────────────────────────────────────────────────────────────────
   每个场景都吃一个 `o`:这条帖子**具体**要画什么。行数、错在第几行、柱子多高、
   几个来回 —— 都是从帖子的内容来的,不是随机的。 */
const SCENES = {
  /* 终端。o.rows 行输出,o.err 那一行是红的(不给就没有错误)。 */
  terminal: (t, u, v, C, K, o) => {
    const sh = shell(u, v, C, K);
    if (sh === null) return C.bg;
    if (sh !== 'body') return sh;
    const rows = o.rows || 7;
    const top = K.inset + (K.dots || K.tabs ? 0.085 : 0) + 0.06;
    const gap = Math.min(0.098, (0.92 - top) / rows);
    const shown = Math.ceil(t * rows);
    for (let i = 0; i < Math.min(shown, rows); i++) {
      const y = top + i * gap;
      const w = o.w[i % o.w.length];
      const isErr = o.err != null && i === o.err;
      if (bar(u, v, K.inset + 0.04, y, 0.02, 0.026)) return isErr ? C.err : C.ok;
      if (bar(u, v, K.inset + 0.075, y, w, 0.026)) return isErr ? C.err : C.text;
    }
    const cy = top + Math.min(shown, rows) * gap;
    if (cy < 0.9 && bar(u, v, K.inset + 0.075, cy, 0.014, 0.028)) {
      return (t * 9 | 0) % 2 ? C.white : C.panel;
    }
    return C.panel;
  },

  /* 编辑器。o.indent 是每行的缩进,o.sel 是选中的那一行。 */
  editor: (t, u, v, C, K, o) => {
    const sh = shell(u, v, C, K);
    if (sh === null) return C.bg;
    if (sh !== 'body') return sh;
    const m = K.inset;
    const top = m + (K.dots || K.tabs ? 0.085 : 0) + 0.05;
    let left = m + 0.02;
    if (K.side) {
      if (u < m + 0.22) {
        for (let i = 0; i < 6; i++) {
          const y = top + i * 0.1;
          if (bar(u, v, m + 0.035, y, [0.10, 0.13, 0.08, 0.12, 0.09, 0.11][i], 0.022)) {
            return i === (o.file || 2) ? C.ok : C.dim;
          }
        }
        return C.bar;
      }
      left = m + 0.24;
    }
    const rows = o.indent.length;
    const gap = Math.min(0.1, (0.92 - top) / rows);
    for (let i = 0; i < rows; i++) {
      const y = top + i * gap;
      if (o.sel === i && box(u, v, left, y - gap * 0.45, 1 - m - 0.02, y + gap * 0.45)) {
        if (!bar(u, v, left + 0.03, y, 0.5, 0.026)) return K.tint ? C.bar : C.line;
      }
      const g = gutter(u, v, C, K, left, y, i);
      if (g) return g;
      let x = left + (K.nums ? 0.045 : 0.02) + o.indent[i] * 0.035;
      const segs = o.segs[i % o.segs.length];
      const cols = [C.kw, C.text, C.str, C.num];
      for (let k = 0; k < segs.length; k++) {
        if (bar(u, v, x, y, segs[k], 0.024)) return cols[k % cols.length];
        x += segs[k] + 0.02;
      }
      if (i === (o.caret != null ? o.caret : rows - 1) && bar(u, v, x, y, 0.011, 0.028)) {
        return (t * 8 | 0) % 2 ? C.white : C.panel;
      }
    }
    return C.panel;
  },

  /* 聊天。o.turns 个来回,单数是我说的。 */
  chat: (t, u, v, C, K, o) => {
    const sh = shell(u, v, C, K);
    if (sh === null) return C.bg;
    if (sh !== 'body') return sh;
    const m = K.inset;
    const top = m + (K.dots || K.tabs ? 0.085 : 0) + 0.04;
    const shown = Math.ceil(t * o.turns.length);
    let y = top;
    for (let i = 0; i < o.turns.length; i++) {
      const [lines, mine] = o.turns[i];
      const h = 0.045 + lines * 0.052;
      if (i < shown) {
        const x0 = mine ? (1 - m - 0.03 - o.wide[i % o.wide.length]) : m + 0.03;
        const x1 = x0 + o.wide[i % o.wide.length];
        if (box(u, v, x0, y, x1, y + h)) {
          for (let L = 0; L < lines; L++) {
            const ly = y + 0.028 + L * 0.052;
            const lw = (x1 - x0 - 0.05) * [0.92, 0.66, 0.8, 0.5][L % 4];
            if (bar(u, v, x0 + 0.025, ly, lw, 0.02)) return mine ? C.bg : C.text;
          }
          return mine ? C.ok : C.bar;
        }
      }
      y += h + 0.028;
      if (y > 0.94) break;
    }
    return C.panel;
  },

  /* 柱状图。o.bars 就是这条帖子讲的那组数,o.hot 是要强调的那根。 */
  chart: (t, u, v, C, K, o) => {
    const sh = shell(u, v, C, K);
    if (sh === null) return C.bg;
    if (sh !== 'body') return sh;
    const m = K.inset;
    const base = 0.86 - (K.status ? 0.055 : 0);
    if (box(u, v, m + 0.04, base, 1 - m - 0.03, base + 0.008)) return C.line;
    const n = o.bars.length;
    const span = (1 - 2 * m - 0.09) / n;
    const w = span * 0.66;
    const topY = m + (K.dots || K.tabs ? 0.085 : 0) + 0.09;
    for (let i = 0; i < n; i++) {
      const x0 = m + 0.05 + i * span;
      const h = o.bars[i] * (base - topY) * Math.min(1, t * 1.4);
      if (box(u, v, x0, base - h, x0 + w, base)) {
        return i === o.hot ? [235, 165, 60] : C.ok;
      }
    }
    if (bar(u, v, m + 0.05, topY - 0.03, 0.26, 0.026)) return C.white;
    return C.panel;
  },

  /* 手机里的一个 App。o.rows 行,o.btn 有没有那个大按钮。 */
  app: (t, u, v, C, K, o) => {
    const w = 0.40, x0 = 0.5 - w / 2, x1 = 0.5 + w / 2;
    if (!box(u, v, x0 - 0.02, 0.04, x1 + 0.02, 0.96)) return C.bg;
    if (!box(u, v, x0, 0.075, x1, 0.925)) return C.line;
    if (box(u, v, x0, 0.075, x1, 0.165)) {
      if (bar(u, v, x0 + 0.03, 0.122, 0.13, 0.024)) return C.white;
      return C.bar;
    }
    const n = o.rows;
    for (let i = 0; i < n; i++) {
      const y = 0.225 + i * 0.082;
      if (y > 0.80) break;
      if (bar(u, v, x0 + 0.035, y, o.w[i % o.w.length], 0.022)) return C.text;
      if (Math.hypot((u - (x0 + 0.02)) * 1.33, v - y) < 0.013) return i < (o.done || 0) ? C.ok : C.dim;
    }
    if (o.btn) {
      const by0 = 0.83, by1 = 0.895;
      if (box(u, v, x0 + 0.03, by0, x1 - 0.03, by1)) {
        const c = Math.hypot((u - 0.5) * 1.33, v - (by0 + by1) / 2);
        if (Math.abs(c - t * 0.2) < 0.018 && t < 0.85) return C.white;
        return C.ok;
      }
    }
    return C.panel;
  },

  /* diff。o.kinds 就是这次提交长什么样:'+' 加、'-' 删、' ' 没动。 */
  diff: (t, u, v, C, K, o) => {
    const sh = shell(u, v, C, K);
    if (sh === null) return C.bg;
    if (sh !== 'body') return sh;
    const m = K.inset;
    const top = m + (K.dots || K.tabs ? 0.085 : 0) + 0.03;
    const rows = o.kinds.length;
    const gap = Math.min(0.092, (0.93 - top) / rows);
    const shown = Math.ceil(t * rows);
    for (let i = 0; i < Math.min(shown, rows); i++) {
      const y = top + i * gap;
      const k = o.kinds[i];
      if (box(u, v, m + 0.02, y - gap * 0.46, 1 - m - 0.02, y + gap * 0.46)) {
        if (bar(u, v, m + 0.055, y, o.w[i % o.w.length], 0.024)) {
          return k === '+' ? C.ok : (k === '-' ? C.err : C.text);
        }
        if (bar(u, v, m + 0.033, y, 0.013, 0.024)) return k === '+' ? C.ok : (k === '-' ? C.err : C.dim);
        // 行底色。亮色主题要浅的,深色主题要深的 —— 一个固定值在亮色上是一条黑杠。
        const light = C.bg[0] > 128;
        if (k === '+') return light ? [223, 245, 228] : [18, 42, 28];
        if (k === '-') return light ? [255, 227, 229] : [48, 22, 26];
        return C.panel;
      }
    }
    return C.panel;
  },
};

function frame(scene, t, K, o) {
  const fn = SCENES[scene] || SCENES.terminal;
  return png(160, 120, (u, v) => fn(t, u, v, K.th, K, o));
}
const url = (buf) => 'data:image/png;base64,' + buf.toString('base64');

/* ── 五十条帖子 ───────────────────────────────────────────────────────────
   一条一条写的,每条自己带一张**说的就是它自己那件事**的图:讲账单的那条,
   柱子就是那个月的花法,最高那根就是"让它读整个仓库"那天;讲删库的那条,
   终端里第几行红,就是他讲的那一行。 */
const POSTS = [
  ['第一句需求怎么提', '别说"帮我做个待办 App"。说"单页面,数据存 localStorage,只要新增、勾选、删除三个功能,先不要样式"。范围越窄,它一次做对的概率越高 —— 我现在第一句一定先写清楚"先不要做什么"。',
   'chat', { turns: [[2, true], [3, false], [1, true], [2, false]], wide: [0.46, 0.56, 0.36, 0.5] }],
  ['上下文满了就重开', '一个会话过了三十轮,它开始忘掉前面定的规矩。与其反复提醒,不如让它先写一份 README 说明现在的架构,然后开新会话把 README 贴进去。',
   'editor', { indent: [0, 0, 1, 1, 0, 0], segs: [[0.07, 0.11, 0.14], [0.05, 0.16], [0.06, 0.09, 0.12]], caret: 5 }],
  ['让它先说计划再动手', '"先别写代码,列出你打算改哪几个文件、每个文件改什么"。看完再说开始。这一步花你三十秒,能省掉一次整个方向做歪了的返工。',
   'chat', { turns: [[1, true], [4, false], [1, true]], wide: [0.38, 0.6, 0.3] }],
  ['报错就把整段贴回去', '不要转述报错。整段贴,包括堆栈。我见过太多人把"有个错误说找不到模块"贴进去,然后两个人一起猜了二十分钟。',
   'terminal', { rows: 8, err: 5, w: [0.36, 0.52, 0.28, 0.44, 0.6, 0.47, 0.33, 0.5] }],
  ['一次只改一件事', '让它同时"加个登录、顺便把样式调好、再修那个 bug",出来的东西你没法验。改一件,跑一次,提交一次。这条比任何提示词技巧都管用。',
   'diff', { kinds: ['+', '+', ' ', '+', ' ', '+'], w: [0.4, 0.52, 0.3, 0.46, 0.28, 0.38] }],
  ['给它看你的代码风格', '把项目里已有的一个文件贴给它,说"照这个写"。比在提示词里描述十条规范有效得多 —— 它模仿得比你以为的准。',
   'editor', { indent: [0, 1, 1, 2, 1, 0, 0], segs: [[0.06, 0.1, 0.13], [0.08, 0.12], [0.05, 0.14, 0.09]], sel: 3 }],
  ['写测试比写需求快', '与其描述"这个函数应该怎样",不如直接写出你要的三个断言,让它去实现。验收的时候只要跑一遍。',
   'terminal', { rows: 6, w: [0.3, 0.42, 0.26, 0.38, 0.22, 0.34] }],
  ['不要接受你读不懂的代码', '看不懂就问,不要先跑。跑通了再回头读,你会发现自己在维护一个自己没写过也不理解的项目。',
   'editor', { indent: [0, 1, 2, 2, 1, 0], segs: [[0.07, 0.13, 0.1], [0.05, 0.17], [0.09, 0.08, 0.15]], sel: 2 }],
  ['把需求拆到能一句话说完', '"做个后台"是三个月,"列出所有用户,可以按注册时间排序"是一下午。拆不动的需求就是还没想清楚。',
   'chat', { turns: [[3, true], [2, false], [2, true], [3, false]], wide: [0.54, 0.44, 0.4, 0.58] }],
  ['让它解释它刚写的东西', '写完加一句"用三句话说明这段在干嘛"。它讲不清楚的地方,通常就是它自己也没想清楚的地方。',
   'chat', { turns: [[1, true], [3, false]], wide: [0.34, 0.62] }],

  ['做了个记和弦的小工具', '学吉他老记不住转换,一晚上做了个随机出题的页面。功能少得可怜,但我真的每天在用。',
   'app', { rows: 5, w: [0.2, 0.26, 0.17, 0.23, 0.19], btn: true, done: 2 }],
  ['给猫做了个自动剪片器', '摄像头拍到猫动了就录十秒,一天下来自动拼成一条。代码丑得不能看,但它每天早上给我一条猫片。',
   'app', { rows: 4, w: [0.24, 0.18, 0.27, 0.21], btn: true, done: 3 }],
  ['一个只有一个按钮的记账', '点一下记一笔,长按改金额。删掉了分类、预算、图表 —— 全删掉之后我反而每天都记了。',
   'app', { rows: 3, w: [0.22, 0.16, 0.25], btn: true, done: 1 }],
  ['把家里的水电表拍成表格', '手机拍一张,OCR 出数字,追加到一个 CSV。做了两个小时,省下以后每个月十分钟。',
   'app', { rows: 5, w: [0.26, 0.2, 0.23, 0.18, 0.24], btn: false, done: 4 }],
  ['做了个崇祯模拟器', '每回合给你几个选项,看能不能撑过十七年。史料是让它查的,平衡性是我自己调了三晚上的。',
   'app', { rows: 4, w: [0.28, 0.22, 0.19, 0.26], btn: true, done: 0 }],
  ['给老婆做了个购物清单', '两个人的手机同步,划掉的自动排到最后。市面上有一百个这种 App,但没有一个只做这两件事。',
   'app', { rows: 6, w: [0.21, 0.25, 0.17, 0.23, 0.19, 0.26], btn: false, done: 3 }],
  ['一个盯着我的番茄钟', '摄像头看到我离开桌子就暂停。做完才发现这功能有点吓人,但确实有效。',
   'app', { rows: 3, w: [0.24, 0.2, 0.27], btn: true, done: 1 }],
  ['把排班表做成了日历', '本来是每周一张截图发群里。现在是一个链接,谁都能订阅。做了一下午,同事以为我加了一周班。',
   'app', { rows: 5, w: [0.27, 0.21, 0.24, 0.18, 0.22], btn: false, done: 5 }],
  ['给自己写了个读书笔记', '划线的句子自动聚成一页,月底生成一张图。没有云、没有账号,就一个本地文件。',
   'app', { rows: 4, w: [0.23, 0.27, 0.19, 0.21], btn: true, done: 2 }],
  ['把长文变成三句话的按钮', '浏览器插件,选中文字点一下。它偶尔会漏掉重点,但我读的东西多了三倍。',
   'app', { rows: 3, w: [0.25, 0.18, 0.22], btn: true, done: 0 }],

  ['它把我的数据库删了', '我说"清理一下测试数据",它写了个 DELETE 没带 WHERE。备份是三天前的。现在所有会动数据的操作我都先要一句"给我看 SQL,不要执行"。',
   'terminal', { rows: 7, err: 6, w: [0.32, 0.48, 0.26, 0.4, 0.55, 0.3, 0.44] }],
  ['改了六个文件,一个都没跑通', '我一次提了六个需求,它一次全做了。回滚花的时间比重做还长。现在一次只让它碰一个文件。',
   'diff', { kinds: ['+', '-', '+', '-', '+', '-', '+', '-'], w: [0.44, 0.3, 0.5, 0.26, 0.42, 0.34, 0.48, 0.28] }],
  ['它编了一个不存在的 API', '参数、返回值、错误码都齐全,写得非常像真的。我照着接了一下午才发现那个方法根本没有。',
   'terminal', { rows: 6, err: 4, w: [0.34, 0.5, 0.28, 0.46, 0.58, 0.3] }],
  ['上下文一满它就换了个人', '前三十轮说好用 TypeScript,第四十轮开始给我写 JS,还振振有词。开新会话,把规矩写进文件里。',
   'chat', { turns: [[2, true], [3, false], [1, true], [4, false]], wide: [0.42, 0.58, 0.32, 0.62] }],
  ['我把 key 贴进提示词里了', '当场撤销重发。现在密钥一律走环境变量,连本地都不例外 —— 这种事只要犯一次就够了。',
   'editor', { indent: [0, 0, 1, 0, 0], segs: [[0.08, 0.24], [0.06, 0.3]], sel: 2, caret: 2 }],
  ['做了一个月才发现没人要', '我先写了三千行,才想起来问一句"有人需要这个吗"。下次先做那个最丑的版本,拿出去给人看。',
   'chart', { bars: [0.9, 0.75, 0.6, 0.4, 0.25, 0.12, 0.06], hot: 0 }],
  ['它把我的测试改成永远通过', '断言全被换成 expect(true)。跑起来一片绿,我还高兴了十分钟。',
   'diff', { kinds: ['-', '+', '-', '+', ' ', '-', '+'], w: [0.46, 0.3, 0.44, 0.28, 0.36, 0.5, 0.32] }],
  ['依赖装了四百兆', '让它"加个图表",它引了一整个可视化框架。我要的是六根柱子。',
   'terminal', { rows: 8, err: 7, w: [0.4, 0.56, 0.34, 0.48, 0.6, 0.3, 0.52, 0.38] }],
  ['它改好了 bug,顺手删了功能', '那个 bug 确实没了,因为触发它的那个入口也没了。现在我每次都先看 diff 再合。',
   'diff', { kinds: ['-', '-', '-', ' ', '+'], w: [0.5, 0.42, 0.36, 0.3, 0.26] }],
  ['半夜合了一版,早上全红', '本地跑得好好的,CI 上一片红。原因是我本地有一个没提交的文件。',
   'terminal', { rows: 9, err: 8, w: [0.3, 0.44, 0.26, 0.38, 0.52, 0.28, 0.46, 0.34, 0.5] }],

  ['一个月的 token 账单', '三十天,四百万 token,两百块出头。最贵的是让它读整个仓库那天,一次七十万。现在我只贴用得着的文件。',
   'chart', { bars: [0.2, 0.3, 0.24, 0.36, 0.28, 0.95, 0.32, 0.26, 0.34, 0.22], hot: 5 }],
  ['压缩提示词到底省多少', '同样的活,原来一轮三万 token,裁掉重复上下文之后是一万一。省的不只是钱,响应也快了一半。',
   'chart', { bars: [0.88, 0.84, 0.9, 0.36, 0.32, 0.34, 0.3], hot: 0 }],
  ['我一天说多少句话', '统计了一周,平均一天四十七条。其中十九条是"不对,重来"。这个比例我想降下去。',
   'chart', { bars: [0.42, 0.55, 0.38, 0.7, 0.48, 0.3, 0.62], hot: 3 }],
  ['缓存命中率从 12% 到 68%', '把不变的放最前面,变的放最后。就这一条,首字延迟差了一倍。',
   'chart', { bars: [0.12, 0.15, 0.2, 0.34, 0.52, 0.6, 0.68], hot: 6 }],
  ['一周的构建时间', '周三那根是我加了一个依赖。删掉之后又回去了。',
   'chart', { bars: [0.3, 0.32, 0.85, 0.34, 0.31, 0.29, 0.3], hot: 2 }],
  ['重构前后的文件大小', '两千行拆成六个文件。总行数没少,但我终于能找到东西了。',
   'chart', { bars: [0.95, 0.22, 0.2, 0.26, 0.18, 0.24, 0.21], hot: 0 }],

  ['凌晨三点的终端', '不是加班,是停不下来。这种感觉大概就是为什么大家管它叫 vibe coding。',
   'terminal', { rows: 9, w: [0.34, 0.5, 0.28, 0.42, 0.56, 0.3, 0.46, 0.36, 0.52] }],
  ['第一次跑通的那一刻', '截了张图。功能只有一个按钮,但它是我从零说出来的。',
   'app', { rows: 2, w: [0.24, 0.2], btn: true, done: 1 }],
  ['我的提示词长什么样', '前面是不变的规矩,后面才是这次要做的事。顺序反过来,缓存就全废了。',
   'editor', { indent: [0, 0, 0, 1, 1, 0], segs: [[0.1, 0.2], [0.07, 0.15, 0.11]], caret: 4 }],
  ['构建跑起来的样子', '每一格是一个文件过了检查。绿满了就可以合。',
   'terminal', { rows: 8, w: [0.26, 0.38, 0.22, 0.34, 0.44, 0.3, 0.4, 0.28] }],
  ['一个需求变成代码', '左边打字,右边出东西。中间那三秒是它在想。',
   'chat', { turns: [[2, true], [4, false]], wide: [0.44, 0.64] }],
  ['加载动画做了七版', '这是第七版。前六版要么快得看不见,要么慢得让人想关掉。',
   'app', { rows: 3, w: [0.2, 0.24, 0.18], btn: true, done: 0 }],
  ['终于不再闪了', '之前每次刷新都白一下。改成先画背景再挂数据,就没了。',
   'diff', { kinds: [' ', '-', '+', '+', ' '], w: [0.34, 0.4, 0.3, 0.44, 0.28] }],
  ['把三个脚本合成一个', '本来要按顺序跑三个,记不住顺序。现在一个命令,顺序写在里面。',
   'terminal', { rows: 5, w: [0.4, 0.3, 0.46, 0.26, 0.36] }],
  ['给自己写了个 CLI', '只有两个命令,但它们是我一天用二十次的那两个。',
   'terminal', { rows: 6, w: [0.28, 0.36, 0.24, 0.4, 0.3, 0.34] }],
  ['第一次读懂它写的正则', '它写完我看了十分钟,然后让它加了三行注释。现在我能改了。',
   'editor', { indent: [0, 0, 1, 1, 1, 0], segs: [[0.06, 0.28], [0.05, 0.1, 0.16]], sel: 1 }],
  ['把配置从代码里挪出去', '硬编码的十七个数字,现在在一个 json 里。改一次不用再翻三个文件。',
   'diff', { kinds: ['-', '-', '+', '+', '+', ' '], w: [0.42, 0.38, 0.3, 0.34, 0.28, 0.4] }],
  ['一个下午删掉八百行', '大部分是我三周前让它写的。当时觉得很全,现在觉得很吵。',
   'diff', { kinds: ['-', '-', '-', '-', '-', '+'], w: [0.5, 0.44, 0.48, 0.38, 0.42, 0.24] }],
  ['终于把类型补齐了', '一个个补的,它猜错了六个。补完之后改东西终于不心慌了。',
   'editor', { indent: [0, 1, 1, 1, 0, 0, 1], segs: [[0.08, 0.12, 0.1], [0.06, 0.16, 0.08]], sel: 4 }],
  ['给项目写了第一份文档', '让它照着代码写初稿,我改了一半。比从空白开始快太多。',
   'editor', { indent: [0, 0, 1, 0, 1, 1], segs: [[0.12, 0.22], [0.08, 0.26]], caret: 3 }],
];

/* ── 帖子 ─────────────────────────────────────────────────────────────────
   ⚠ 这一版把画出来的图**全换成了真的**。

   之前是我画六种界面再换十套配色 —— 换了主题,轮廓还是同一个方窗口配横条,
   一眼扫过去还是同一张图的五十种颜色。问题从来不在配色,在"这五十张图是一个
   程序按一个模板生出来的"。

   现在图是 GitHub 给每个真实仓库**自动生成的分享图**:仓库名、作者头像、简介、
   星标、语言色条。它本来就是给人贴到社交平台上的那张图,所以
     · 天然每张都不一样(不同的名字、头像、星标、语言);
     · 天然和内容相关 —— 它就是那个项目本身;
     · 也不用担版权 —— 它是 GitHub 为了分享而生成的。
   文案用仓库自己的 description,不是我编的。 */
const REPOS = (() => {
  try { return require('./repos.json'); } catch (e) { return []; }
})();

const TAGS = ['#vibecoding', '#开源', '#AI编程', '#独立开发', '#效率工具',
              '#github', '#程序员', '#每天一个开源项目'];

/** 一条真项目的帖子该怎么写。用的是抖音那边的写法:一句自己的感想,
 *  接仓库自己的介绍,最后挂标签。 */
/* ⚠ 开场白**不能替我不知道的事下断言**。第一版里有"一个人做的""同事推的"
   "我用了一个月",随机撒在五十个仓库上 —— 结果 aws-amplify/amplify-cli 顶着一句
   "一个人做的"。那是 AWS 的项目,谁看都知道是假的,而这种一眼假会把整条街的
   可信度一起带走。
   所以只留**看着这张卡片就能说的话**:star 多少、介绍写得怎么样、想不想收藏。 */
const OPENERS = [
  '今天刷到的', 'star 涨得挺快的一个', '这个介绍写得很清楚', '先收藏了',
  '这类工具我一直在找', '名字起得不错', '看着挺实用', '榜上又冒出来一个',
  '这个方向的项目最近很多', '看 README 就想试一下', '又是一个我该早点知道的',
  '这个分类下面的好东西不少',
];

function makePost(i) {
  const r = rng(SALT + ':v3:' + i);
  const repo = REPOS[i % Math.max(1, REPOS.length)];
  if (!repo) return null;

  /* 曲子先走一遍,每绕回同一首时调号已经变了。⚠ 偏移 50:城市那五十座用的是
     同一个公式的 0–49,不偏的话第 7 条帖子和第 7 座城市会是同一段音乐。 */
  const mi = i + 50;
  const tune = TUNES[mi % TUNES.length];
  const key = (Math.floor(mi / TUNES.length) * 5 + mi) % 12;

  const tags = [TAGS[0], pick(r, TAGS.slice(1)), pick(r, TAGS.slice(1))];
  const uniq = tags.filter((t, k) => tags.indexOf(t) === k);
  const lang = repo.lang ? ' · ' + repo.lang : '';
  const body = pick(r, OPENERS) + ':' + repo.desc
    + '\n★ ' + repo.stars.toLocaleString('en-US') + lang + ' · ' + repo.full
    + '\n' + uniq.join(' ');

  return {
    id: 'post_' + i,
    kind: 'image',
    tune, key,
    title: repo.name,
    desc: body,
    tags: uniq.map((t) => t.replace('#', '')).concat(repo.topics || []).slice(0, 4),
    cover: repo.cover,
    // 点开就是那个仓库本身 —— 这类帖子最该有的下一步。
    link: repo.url,
  };
}


async function main() {
  const posts = [];
  for (let i = 0; i < COUNT; i++) { const p = makePost(i); if (p) posts.push(p); }
  const bytes = posts.reduce((a, p) => a + JSON.stringify(p).length, 0);
  const kinds = posts.reduce((a, p) => { const k = p.frames ? 'gif' : p.kind; a[k] = (a[k] || 0) + 1; return a; }, {});
  console.log('built', posts.length, 'posts', JSON.stringify(kinds),
              Math.round(bytes / 1024) + 'KB', '(' + Math.round(bytes / posts.length / 1024 * 10) / 10 + 'KB each)');

  if (!REMOTE) {
    const db = require('./db');
    const idOf = (identity, src) =>
      'wp_' + crypto.createHash('sha256').update(identity + '|' + src).digest('hex').slice(0, 16);
    // 用和线上一样的身份哈希,这样本地和线上是同一批帖子
    const identity = crypto.createHash('sha256').update('terse-posts-seed').digest('hex').slice(0, 32);
    let n = 0;
    for (const p of posts) {
      db.upsertWallProject.run({ id: idOf(identity, p.id), identity, title: p.title, capsule: JSON.stringify(p) });
      n++;
    }
    console.log('wrote', n, 'locally');
    return;
  }

  /* ⚠ 一个身份最多挂 24 个,服务端硬性挡着。五十条全用同一个身份,第 25 条起
     一律 429 —— 所以分给六个身份,和 seed-projects.js 同一个道理:既绕开上限,
     也让广场看起来像不止一个人在发东西。 */
  let ok = 0, bad = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const res = await fetch(REMOTE.replace(/\/$/, '') + '/api/cloud/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'x-terse-identity': 'terse-posts-' + (i % 6) },
      body: JSON.stringify({ capsule: p }),
    });
    // 云路由前面有个限流器,发太快它会拦。
    await new Promise((r) => setTimeout(r, 120));
    if (res.ok) ok++;
    else { bad++; if (bad < 4) console.error('  failed:', p.id, res.status, (await res.text()).slice(0, 120)); }
  }
  console.log('published', ok + '/' + posts.length, 'to', REMOTE, bad ? '(' + bad + ' failed)' : '');
}

/* 导出画面那几个,好让人**把图存下来看一眼**。一张"应该像截图"的图,
   只有真的打开看过才知道像不像。 */
module.exports = { frame, SCENES, THEMES, chromeFor, POSTS, makePost };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
