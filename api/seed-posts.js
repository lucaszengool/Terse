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

const TUNES = ['pulse', 'drift', 'arp', 'neon', 'lofi', 'rush',
               'glass', 'deep', 'chime', 'dust', 'march', 'bloom'];

/* ── 文字帖 ───────────────────────────────────────────────────────────────
   四类,按抖音上真实的分布来写:教程最多,战报次之,翻车和数字各占一点。 */
/* 每条都标了该配哪个场景 —— 讲提问的配聊天,讲改代码的配编辑器。 */
const TUTORIAL = [
  ['第一句需求怎么提', '别说"帮我做个待办 App"。说"做一个单页面待办,数据存 localStorage,只要新增、勾选、删除三个功能,先不要样式"。范围越窄,它一次做对的概率越高 —— 我现在第一句一定写清楚"先不要做什么"。', 'chat'],
  ['上下文满了就重开', '一个会话超过大概三十轮,它开始忘掉你前面定的规矩。与其反复提醒,不如让它先写一份 README 说明现在的架构,然后开新会话把 README 贴进去。省下来的 token 比你想的多。', 'editor'],
  ['让它先说计划再动手', '"先别写代码,列出你打算改哪几个文件、每个文件改什么"。看完再说"开始"。这一步大概花你三十秒,能省掉一次整个方向做歪了的返工。', 'chat'],
  ['报错就把整段贴回去', '不要转述报错。整段贴,包括堆栈。我见过太多人把 "有个错误说找不到模块" 贴进去,然后两个人一起猜了二十分钟。', 'terminal'],
  ['一次只改一件事', '让它同时"加个登录、顺便把样式调好、再修那个 bug",出来的东西你没法验。改一件,跑一次,提交一次。这条规矩比任何提示词技巧都管用。', 'diff'],
  ['给它看你的代码风格', '把项目里已有的一个文件贴给它,说"照这个风格写"。比在提示词里描述十条规范有效得多 —— 它模仿得比你以为的准。', 'editor'],
  ['写测试比写需求快', '与其描述"这个函数应该怎样",不如直接写出你要的三个断言,让它去实现。你验收的时候只要跑一遍。', 'editor'],
  ['不要接受你读不懂的代码', '它给的东西看不懂就问,不要先跑。跑通了再回头读,你会发现自己在维护一个自己没写过、也不理解的项目。', 'editor'],
];
const SHIPPED = [
  ['做了个记和弦的小工具', '学吉他老记不住和弦转换,一晚上做了个能随机出题的页面。功能少得可怜,但我真的每天在用 —— 这大概就是自己给自己写软件的意义。', 'app'],
  ['给猫做了个自动剪片器', '摄像头拍到猫动了就录十秒,一天下来自动拼成一条。代码丑得不能看,但它每天早上给我一条猫片。', 'app'],
  ['一个只有一个按钮的记账', '点一下记一笔,长按改金额。删掉了分类、预算、图表 —— 全删掉之后我反而每天都记了。', 'app'],
  ['把家里的水电表拍成表格', '手机拍一张,OCR 出数字,追加到一个 CSV。做了两个小时,省下我以后每个月十分钟。', 'app'],
  ['做了个崇祯模拟器', '每回合给你几个选项,看你能不能撑过十七年。历史数据是让 AI 查的,平衡性是我自己调了三晚上的。', 'app'],
  ['给老婆做了个购物清单', '两个人的手机同步,划掉的自动排到最后。市面上有一百个这种 App,但没有一个只做这两件事。', 'app'],
  ['一个盯着我的番茄钟', '摄像头看到我离开桌子就暂停。做完才发现这功能有点吓人,但确实有效。', 'app'],
  ['把公司的排班表做成了日历', '本来是每周一张截图发群里。现在是一个链接,谁都能订阅。做了一下午,同事以为我加了一周班。', 'app'],
  ['给自己写了个读书笔记', '划线的句子自动聚成一页,月底生成一张图。没有云、没有账号,就一个本地文件。', 'app'],
  ['一个把长文变成三句话的按钮', '浏览器插件,选中文字点一下。它偶尔会漏掉重点,但我读的东西多了三倍。', 'app'],
];
const FAILED = [
  ['它把我的数据库删了', '我说"清理一下测试数据",它写了个 DELETE 没带 WHERE。备份是三天前的。现在我给所有会动数据的操作都加了一句"先给我看 SQL,不要执行"。', 'terminal'],
  ['连着改了六个文件,一个都没跑通', '我一次提了六个需求,它一次全做了。回滚花的时间比重做还长。现在我一次只让它碰一个文件。', 'diff'],
  ['它编了一个不存在的 API', '写得非常像真的,参数、返回值、错误码都齐全。我照着接了一下午,才发现那个方法根本没有。现在我会让它先贴文档链接。', 'chat'],
  ['上下文一满它就换了个人', '前三十轮说好用 TypeScript,第四十轮开始给我写 JS,还振振有词。开新会话,把规矩写进文件里。', 'editor'],
  ['我把 key 贴进提示词里了', '当场撤销重发。现在密钥一律走环境变量,连本地都不例外 —— 这种事只要犯一次就够了。', 'terminal'],
  ['做了一个月才发现没人要', '我先写了三千行,才想起来问一句"有人需要这个吗"。下次先做那个最丑的版本,拿出去给人看。', 'app'],
];
const NUMBERS = [
  ['一个月的 token 账单', '三十天,四百万 token,大概两百块。最贵的一天是我让它读整个仓库那天 —— 一次七十万。现在我只贴用得着的文件。', 'chart'],
  ['压缩提示词到底省多少', '同样的活,原来一轮三万 token,裁掉重复的上下文之后是一万一。省下来的不只是钱,响应也快了一半。', 'chart'],
  ['我一天说多少句话', '统计了一周,平均一天给 AI 发四十七条消息。其中十九条是"不对,重来"。这个比例我想把它降下去。', 'chart'],
  ['缓存命中率从 12% 到 68%', '把不变的部分放在最前面,变的放最后。就这一条,首字延迟差了一倍。', 'chart'],
];

/* ── 画面 ─────────────────────────────────────────────────────────────────
   每条帖子配的图要**和它讲的事对得上**,而且要像真人随手截的一张图。

   ⚠ 不画字,画**字的形状**。这个写入器写不了字形,但它也不需要:这些图最终是被
   采成几万颗粒子的,112×84 已经比粒子网格细。真截图缩到这个尺寸,本来就只剩
   长短不一的色条 —— 所以用色条去排一段代码、一行终端输出、一串聊天气泡,
   在粒子里读起来就是"一张截图",而不是"一张抽象画"。

   所以做的是**版式**:窗口标题栏和三个圆点、侧边栏、缩进、语法色、光标、
   坐标轴。像不像真的,靠的是比例和颜色对不对,不是字认不认得出来。 */

/** 一张深色 IDE/终端的配色。真实感大半来自这里。 */
const UI = {
  bg: [13, 17, 23], panel: [22, 27, 34], bar: [30, 36, 44], line: [48, 54, 61],
  dim: [86, 96, 106], text: [173, 186, 199], white: [230, 237, 243],
  green: [126, 231, 135], red: [248, 113, 113], amber: [251, 191, 36],
  blue: [125, 211, 252], purple: [196, 181, 253], accent: [110, 231, 183],
};
const box = (u, v, x0, y0, x1, y1) => u >= x0 && u <= x1 && v >= y0 && v <= y1;

/** 一排"文字":从 x0 开始,长度 w,粗细 h。 */
const textLine = (u, v, x0, y, w, h) => box(u, v, x0, y - h / 2, x0 + w, y + h / 2);

/** 窗口外壳:标题栏 + 三个圆点。每一张都从它开始,所以每一张都像一个窗口。 */
function shell(u, v, C) {
  if (!box(u, v, 0.04, 0.06, 0.96, 0.94)) return null;          // 窗口外面
  if (box(u, v, 0.04, 0.06, 0.96, 0.16)) {                       // 标题栏
    const dots = [0.075, 0.115, 0.155];
    for (let i = 0; i < 3; i++) {
      if (Math.hypot((u - dots[i]) * 1.33, v - 0.11) < 0.018) {
        return [C.red, C.amber, C.green][i];
      }
    }
    return C.bar;
  }
  return C.panel;
}

const SCENES = {
  /* 终端:一行行输出往下堆,最后一行是红的。翻车那类帖子用它。 */
  terminal: (t, u, v, C, opt) => {
    const base = shell(u, v, C);
    if (base === null) return C.bg;
    if (base !== C.panel) return base;
    const rows = 7, top = 0.22, gap = 0.095;
    const shown = Math.ceil(t * rows);
    for (let i = 0; i < rows; i++) {
      const y = top + i * gap;
      if (i >= shown) break;
      // 提示符
      if (textLine(u, v, 0.08, y, 0.022, 0.028)) return C.green;
      const w = [0.34, 0.52, 0.28, 0.44, 0.6, 0.31, 0.47][i % 7];
      const isErr = opt.error && i === shown - 1 && i >= rows - 3;
      if (textLine(u, v, 0.115, y, w, 0.028)) return isErr ? C.red : C.text;
    }
    // 光标
    const cy = top + (shown - 1) * gap;
    if (shown <= rows && textLine(u, v, 0.115, cy + gap, 0.016, 0.03)) {
      return (t * 10 | 0) % 2 ? C.white : C.panel;
    }
    return C.panel;
  },

  /* 编辑器:左边文件列表,右边带缩进和语法色的代码,光标一格格往前走。
     教程那类帖子用它。 */
  editor: (t, u, v, C) => {
    const base = shell(u, v, C);
    if (base === null) return C.bg;
    if (base !== C.panel) return base;
    if (u < 0.26) {                                   // 侧边栏
      if (box(u, v, 0.04, 0.16, 0.26, 0.94)) {
        for (let i = 0; i < 6; i++) {
          const y = 0.24 + i * 0.1;
          if (textLine(u, v, 0.075, y, [0.11, 0.14, 0.09, 0.13, 0.10, 0.12][i], 0.024)) {
            return i === 2 ? C.accent : C.dim;        // 打开的那个文件
          }
        }
        return C.bar;
      }
    }
    const rows = 7, top = 0.22, gap = 0.098;
    const caretRow = Math.floor(t * rows) % rows;
    for (let i = 0; i < rows; i++) {
      const y = top + i * gap;
      const indent = [0, 0.03, 0.06, 0.06, 0.03, 0, 0.03][i];
      let x = 0.30 + indent;
      // 关键字 / 名字 / 字符串,三段,像一行真的代码
      const segs = [[0.06, C.purple], [0.10, C.text], [0.13, C.green]];
      for (const [w, col] of segs) {
        if (textLine(u, v, x, y, w, 0.026)) return col;
        x += w + 0.022;
      }
      if (i === caretRow && textLine(u, v, x, y, 0.012, 0.03)) return C.white;
    }
    return C.panel;
  },

  /* 聊天:右边是我说的,左边是它答的,一条条冒出来。提问技巧那类用它。 */
  chat: (t, u, v, C) => {
    const base = shell(u, v, C);
    if (base === null) return C.bg;
    if (base !== C.panel) return base;
    const bubbles = [
      { x0: 0.44, x1: 0.92, y0: 0.20, y1: 0.32, me: true },
      { x0: 0.08, x1: 0.66, y0: 0.36, y1: 0.54, me: false },
      { x0: 0.52, x1: 0.92, y0: 0.58, y1: 0.68, me: true },
      { x0: 0.08, x1: 0.72, y0: 0.72, y1: 0.90, me: false },
    ];
    const shown = Math.ceil(t * bubbles.length);
    for (let i = 0; i < Math.min(shown, bubbles.length); i++) {
      const b = bubbles[i];
      if (box(u, v, b.x0, b.y0, b.x1, b.y1)) {
        // 气泡里的行
        const lines = Math.max(1, Math.round((b.y1 - b.y0) / 0.06));
        for (let L = 0; L < lines; L++) {
          const y = b.y0 + 0.03 + L * 0.055;
          const w = (b.x1 - b.x0 - 0.06) * [0.9, 0.7, 0.82][L % 3];
          if (textLine(u, v, b.x0 + 0.03, y, w, 0.022)) return b.me ? C.bg : C.text;
        }
        return b.me ? C.accent : C.bar;
      }
    }
    return C.panel;
  },

  /* 柱状图:一根根长起来,有一根特别高。账单和数字那类用它。 */
  chart: (t, u, v, C) => {
    const base = shell(u, v, C);
    if (base === null) return C.bg;
    if (base !== C.panel) return base;
    if (box(u, v, 0.09, 0.855, 0.93, 0.865)) return C.line;        // 坐标轴
    const hs = [0.22, 0.35, 0.28, 0.44, 0.30, 0.86, 0.33, 0.25, 0.40, 0.29];
    const n = hs.length, w = 0.062, gap = 0.021;
    for (let i = 0; i < n; i++) {
      const x0 = 0.10 + i * (w + gap);
      const h = hs[i] * Math.min(1, t * 1.35);
      if (box(u, v, x0, 0.85 - h, x0 + w, 0.85)) {
        return hs[i] > 0.7 ? C.amber : C.accent;                    // 最贵的那天
      }
    }
    if (textLine(u, v, 0.09, 0.21, 0.30, 0.03)) return C.white;     // 标题
    return C.panel;
  },

  /* 手机里的一个小 App:标题、几行、一个大按钮,按下去有一圈涟漪。
     "我做了个东西"那类用它。 */
  app: (t, u, v, C) => {
    if (!box(u, v, 0.30, 0.05, 0.70, 0.95)) return C.bg;            // 机身
    if (!box(u, v, 0.325, 0.10, 0.675, 0.90)) return C.line;        // 边框
    if (box(u, v, 0.325, 0.10, 0.675, 0.19)) {                      // 顶栏
      if (textLine(u, v, 0.35, 0.145, 0.14, 0.026)) return C.white;
      return C.bar;
    }
    for (let i = 0; i < 4; i++) {                                    // 列表
      const y = 0.25 + i * 0.09;
      if (textLine(u, v, 0.35, y, [0.22, 0.28, 0.18, 0.25][i], 0.024)) return C.text;
      if (Math.hypot((u - 0.345) * 1.33, v - y) < 0.014) return C.dim;
    }
    const bx0 = 0.36, bx1 = 0.64, by0 = 0.66, by1 = 0.76;
    if (box(u, v, bx0, by0, bx1, by1)) {                             // 按钮
      const c = Math.hypot((u - 0.5) * 1.33, v - 0.71);
      const ring = t * 0.22;
      if (Math.abs(c - ring) < 0.02 && t < 0.85) return C.white;     // 涟漪
      return C.accent;
    }
    return C.panel;
  },

  /* diff:一片绿加几行红,像一次提交。"改了六个文件"那类用它。 */
  diff: (t, u, v, C) => {
    const base = shell(u, v, C);
    if (base === null) return C.bg;
    if (base !== C.panel) return base;
    const rows = 8, top = 0.21, gap = 0.088;
    const kinds = ['+', '+', '-', ' ', '+', '-', '+', ' '];
    const shown = Math.ceil(t * rows);
    for (let i = 0; i < Math.min(shown, rows); i++) {
      const y = top + i * gap;
      const k = kinds[i];
      if (box(u, v, 0.06, y - 0.042, 0.94, y + 0.042)) {
        if (textLine(u, v, 0.10, y, [0.42, 0.55, 0.31, 0.48, 0.6, 0.29, 0.5, 0.36][i], 0.026)) {
          return k === '+' ? C.green : (k === '-' ? C.red : C.text);
        }
        if (textLine(u, v, 0.075, y, 0.014, 0.026)) return k === '+' ? C.green : (k === '-' ? C.red : C.dim);
        return k === '+' ? [18, 42, 28] : (k === '-' ? [48, 22, 26] : C.panel);
      }
    }
    return C.panel;
  },
};
const SCENE_IDS = Object.keys(SCENES);

const PALETTES = [UI];

function frame(scene, t, opt) {
  const fn = SCENES[scene] || SCENES.terminal;
  return png(160, 120, (u, v) => fn(t, u, v, UI, opt || {}));
}
const url = (buf) => 'data:image/png;base64,' + buf.toString('base64');

const PIC_CAPTIONS = [
  ['今天的编译瀑布', '一个下午的构建记录。绿的是过了的,暗的是还没跑到的。'],
  ['第一次跑通的那一刻', '截了张图。功能只有一个按钮,但它是我从零说出来的。'],
  ['上下文用量曲线', '横轴是轮数,纵轴是这一轮塞进去多少。第三十轮那个尖峰是我让它读整个目录。'],
  ['我的提示词长什么样', '前面是不变的规矩,后面才是这次要做的事。顺序反过来,缓存就全废了。'],
  ['凌晨三点的终端', '不是加班,是停不下来。这种感觉大概就是为什么大家管它叫 vibe coding。'],
];
const GIF_CAPTIONS = [
  ['构建跑起来的样子', '录了一段。每一格是一个文件过了检查。'],
  ['粒子聚成字的那一下', '这个效果我调了两天,就为了让数字浮出来的时候不那么突兀。'],
  ['一个需求变成代码', '左边打字,右边出东西。中间那三秒是它在想。'],
  ['加载动画做了七版', '这是第七版。前六版要么太快看不见,要么慢得让人想关掉。'],
  ['我的 token 在烧', '每跳一格是一千。看着它跳,你会开始心疼自己写的提示词。'],
  ['终于不再闪了', '之前每次刷新都白一下。改成先画背景再挂数据,就没了。'],
];

function makePost(i) {
  const r = rng(SALT + ':' + i);
  /* 曲子先走一遍,每绕回同一首时调号已经变了 —— 12 首 × 12 个调,相邻两条一定
     不是同一首。见 tunes.js 里为什么移调就够了。

     ⚠ 偏移 50。城市那五十座用的是同一个公式的 0–49,不偏的话第 7 条帖子和第 7 座
     城市会是同一段音乐 —— 各自那一组里都不重复,合在一起每种却正好出现两次。
     实测这个公式在 0–99 上是无碰撞的,所以两组一共一百条,条条不同。 */
  const mi = i + 50;
  const tune = TUNES[mi % TUNES.length];
  const key = (Math.floor(mi / TUNES.length) * 5 + mi) % 12;

  /* ⚠ 一条帖子**没有"纯文字"这一种**。广场是刷着看的,一屏没有画面就是一屏
     被划过去 —— 而且这个 app 的整个卖点就是"东西会长成画面"。所以每条都带图,
     标题和正文退回它本来的位置:**配文**。

     图不是随便配的,是按这条讲的事选的:讲怎么提问的配聊天窗口,讲代码的配
     编辑器,翻车的配一屏红色报错,算账的配柱状图。 */
  const pool = [].concat(
    TUTORIAL.map((x) => ['tutorial'].concat(x)),
    TUTORIAL.map((x) => ['tutorial'].concat(x)),
    SHIPPED.map((x) => ['shipped'].concat(x)),
    SHIPPED.map((x) => ['shipped'].concat(x)),
    FAILED.map((x) => ['failed'].concat(x)),
    NUMBERS.map((x) => ['numbers'].concat(x))
  );
  const [cat, title, body, scene] = pool[i % pool.length];

  /* 五分之三会动。全都动起来,刷十条会累;一条不动,又不像一个 2026 年的信息流。
     动的挑那些**动起来才说得清**的:进度、打字、柱子长上来。 */
  const animated = i % 5 !== 0 && i % 5 !== 3;
  const opt = { error: cat === 'failed' };

  const base = { id: 'post_' + i, tune, key, kind: 'image', title, desc: body };
  if (!animated) {
    // 定格在动作快完成的时候 —— 那一帧信息最多。
    return Object.assign(base, { cover: url(frame(scene, 0.82, opt)) });
  }
  const n = 12;
  const frames = [];
  for (let f = 0; f < n; f++) frames.push(url(frame(scene, f / n, opt)));
  return Object.assign(base, {
    cover: frames[Math.floor(n * 0.8)],
    frames,
    fps: int(r, 7, 11),
  });
}

async function main() {
  const posts = [];
  for (let i = 0; i < COUNT; i++) posts.push(makePost(i));
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
module.exports = { frame, SCENES, SCENE_IDS, makePost };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
