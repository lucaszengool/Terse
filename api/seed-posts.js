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
const TUTORIAL = [
  ['第一句需求怎么提', '别说"帮我做个待办 App"。说"做一个单页面待办,数据存 localStorage,只要新增、勾选、删除三个功能,先不要样式"。范围越窄,它一次做对的概率越高 —— 我现在第一句一定写清楚"先不要做什么"。'],
  ['上下文满了就重开', '一个会话超过大概三十轮,它开始忘掉你前面定的规矩。与其反复提醒,不如让它先写一份 README 说明现在的架构,然后开新会话把 README 贴进去。省下来的 token 比你想的多。'],
  ['让它先说计划再动手', '"先别写代码,列出你打算改哪几个文件、每个文件改什么"。看完再说"开始"。这一步大概花你三十秒,能省掉一次整个方向做歪了的返工。'],
  ['报错就把整段贴回去', '不要转述报错。整段贴,包括堆栈。我见过太多人把 "有个错误说找不到模块" 贴进去,然后两个人一起猜了二十分钟。'],
  ['一次只改一件事', '让它同时"加个登录、顺便把样式调好、再修那个 bug",出来的东西你没法验。改一件,跑一次,提交一次。这条规矩比任何提示词技巧都管用。'],
  ['给它看你的代码风格', '把项目里已有的一个文件贴给它,说"照这个风格写"。比在提示词里描述十条规范有效得多 —— 它模仿得比你以为的准。'],
  ['写测试比写需求快', '与其描述"这个函数应该怎样",不如直接写出你要的三个断言,让它去实现。你验收的时候只要跑一遍。'],
  ['不要接受你读不懂的代码', '它给的东西看不懂就问,不要先跑。跑通了再回头读,你会发现自己在维护一个自己没写过、也不理解的项目。'],
];
const SHIPPED = [
  ['做了个记和弦的小工具', '学吉他老记不住和弦转换,一晚上做了个能随机出题的页面。功能少得可怜,但我真的每天在用 —— 这大概就是自己给自己写软件的意义。'],
  ['给猫做了个自动剪片器', '摄像头拍到猫动了就录十秒,一天下来自动拼成一条。代码丑得不能看,但它每天早上给我一条猫片。'],
  ['一个只有一个按钮的记账', '点一下记一笔,长按改金额。删掉了分类、预算、图表 —— 全删掉之后我反而每天都记了。'],
  ['把家里的水电表拍成表格', '手机拍一张,OCR 出数字,追加到一个 CSV。做了两个小时,省下我以后每个月十分钟。'],
  ['做了个崇祯模拟器', '每回合给你几个选项,看你能不能撑过十七年。历史数据是让 AI 查的,平衡性是我自己调了三晚上的。'],
  ['给老婆做了个购物清单', '两个人的手机同步,划掉的自动排到最后。市面上有一百个这种 App,但没有一个只做这两件事。'],
  ['一个盯着我的番茄钟', '摄像头看到我离开桌子就暂停。做完才发现这功能有点吓人,但确实有效。'],
  ['把公司的排班表做成了日历', '本来是每周一张截图发群里。现在是一个链接,谁都能订阅。做了一下午,同事以为我加了一周班。'],
  ['给自己写了个读书笔记', '划线的句子自动聚成一页,月底生成一张图。没有云、没有账号,就一个本地文件。'],
  ['一个把长文变成三句话的按钮', '浏览器插件,选中文字点一下。它偶尔会漏掉重点,但我读的东西多了三倍。'],
];
const FAILED = [
  ['它把我的数据库删了', '我说"清理一下测试数据",它写了个 DELETE 没带 WHERE。备份是三天前的。现在我给所有会动数据的操作都加了一句"先给我看 SQL,不要执行"。'],
  ['连着改了六个文件,一个都没跑通', '我一次提了六个需求,它一次全做了。回滚花的时间比重做还长。现在我一次只让它碰一个文件。'],
  ['它编了一个不存在的 API', '写得非常像真的,参数、返回值、错误码都齐全。我照着接了一下午,才发现那个方法根本没有。现在我会让它先贴文档链接。'],
  ['上下文一满它就换了个人', '前三十轮说好用 TypeScript,第四十轮开始给我写 JS,还振振有词。开新会话,把规矩写进文件里。'],
  ['我把 key 贴进提示词里了', '当场撤销重发。现在密钥一律走环境变量,连本地都不例外 —— 这种事只要犯一次就够了。'],
  ['做了一个月才发现没人要', '我先写了三千行,才想起来问一句"有人需要这个吗"。下次先做那个最丑的版本,拿出去给人看。'],
];
const NUMBERS = [
  ['一个月的 token 账单', '三十天,四百万 token,大概两百块。最贵的一天是我让它读整个仓库那天 —— 一次七十万。现在我只贴用得着的文件。'],
  ['压缩提示词到底省多少', '同样的活,原来一轮三万 token,裁掉重复的上下文之后是一万一。省下来的不只是钱,响应也快了一半。'],
  ['我一天说多少句话', '统计了一周,平均一天给 AI 发四十七条消息。其中十九条是"不对,重来"。这个比例我想把它降下去。'],
  ['缓存命中率从 12% 到 68%', '把不变的部分放在最前面,变的放最后。就这一条,首字延迟差了一倍。'],
];

/* ── 图片帖和动图帖 ─────────────────────────────────────────────────────
   都是算出来的画面。动图的每一帧是同一个函数在不同的 t 上取值 —— 于是"动"是
   连续的,不是十二张不相干的图拼起来。 */
const MOTIONS = {
  // 进度条:一格一格填过去,做完最后闪一下。
  bar: (t, u, v, C) => {
    const inBar = v > 0.44 && v < 0.56 && u > 0.08 && u < 0.92;
    if (!inBar) return C.bg;
    const p = (u - 0.08) / 0.84;
    return p < t ? C.a : C.dim;
  },
  // 光标在打字:一段一段变长,然后重来。
  caret: (t, u, v, C) => {
    if (v < 0.46 || v > 0.54) return C.bg;
    const w = 0.1 + t * 0.7;
    if (u < 0.1) return C.bg;
    if (u < w) return C.a;
    if (u < w + 0.02) return (t * 12 | 0) % 2 ? C.b : C.bg;   // 闪动的光标
    return C.bg;
  },
  // 波:一条正弦从左边推过去。
  wave: (t, u, v, C) => {
    const y = 0.5 + Math.sin((u * 3 + t) * Math.PI * 2) * 0.22;
    return Math.abs(v - y) < 0.05 ? C.a : (Math.abs(v - y) < 0.11 ? C.dim : C.bg);
  },
  // 转圈的点。
  spin: (t, u, v, C) => {
    const cx = u - 0.5, cy = v - 0.5;
    const d = Math.hypot(cx, cy);
    if (d < 0.18 || d > 0.34) return C.bg;
    let th = Math.atan2(cy, cx) / (Math.PI * 2) + 0.5;
    th = (th - t + 1) % 1;
    return th < 0.30 ? C.a : (th < 0.5 ? C.dim : C.bg);
  },
  // 方块一个个亮起来,像编译在跑。
  build: (t, u, v, C) => {
    const gx = Math.floor(u * 6), gy = Math.floor(v * 6);
    const i = (gy * 6 + gx) / 36;
    return i < t ? (i > t - 0.09 ? C.b : C.a) : C.dim;
  },
  // 一团东西聚起来再散开 —— 这个 app 自己的动作。
  gather: (t, u, v, C) => {
    const k = Math.sin(t * Math.PI);              // 0 → 1 → 0
    const d = Math.hypot(u - 0.5, v - 0.5);
    const r = 0.42 - k * 0.28;
    return Math.abs(d - r) < 0.06 + k * 0.05 ? C.a : (d < r ? C.dim : C.bg);
  },
};
const MOTION_IDS = Object.keys(MOTIONS);

const PALETTES = [
  { a: [110, 231, 183], b: [240, 253, 244], dim: [24, 48, 42], bg: [8, 12, 14] },
  { a: [125, 211, 252], b: [237, 250, 255], dim: [22, 44, 60], bg: [8, 11, 16] },
  { a: [244, 114, 182], b: [255, 240, 248], dim: [58, 24, 44], bg: [14, 8, 12] },
  { a: [253, 224, 71], b: [255, 252, 232], dim: [58, 50, 16], bg: [14, 13, 8] },
  { a: [167, 139, 250], b: [245, 243, 255], dim: [40, 32, 66], bg: [11, 9, 16] },
  { a: [251, 146, 60], b: [255, 247, 237], dim: [60, 34, 14], bg: [15, 10, 7] },
];

function frame(motion, t, pal) {
  const fn = MOTIONS[motion];
  return png(112, 84, (u, v) => fn(t, u, v, pal));
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
  const kind = i % 5 === 4 ? 'image' : (i % 5 === 3 ? 'gif' : 'text');
  /* 曲子先走一遍,每绕回同一首时调号已经变了 —— 12 首 × 12 个调,相邻两条一定
     不是同一首。见 tunes.js 里为什么移调就够了。

     ⚠ 偏移 50。城市那五十座用的是同一个公式的 0–49,不偏的话第 7 条帖子和第 7 座
     城市会是同一段音乐 —— 各自那一组里都不重复,合在一起每种却正好出现两次。
     实测这个公式在 0–99 上是无碰撞的,所以两组一共一百条,条条不同。 */
  const mi = i + 50;
  const tune = TUNES[mi % TUNES.length];
  const key = (Math.floor(mi / TUNES.length) * 5 + mi) % 12;
  const base = { id: 'post_' + i, tune, key };

  if (kind === 'text') {
    const bucket = pick(r, [TUTORIAL, TUTORIAL, SHIPPED, SHIPPED, FAILED, NUMBERS]);
    const [title, body] = pick(r, bucket);
    return Object.assign(base, { kind: 'text', title, desc: body });
  }

  const pal = pick(r, PALETTES);
  if (kind === 'image') {
    const [title, desc] = pick(r, PIC_CAPTIONS);
    const m = pick(r, MOTION_IDS);
    return Object.assign(base, {
      kind: 'image', title, desc,
      cover: url(frame(m, 0.62, pal)),          // 定格在动作中间,那一帧最好看
    });
  }

  const [title, desc] = pick(r, GIF_CAPTIONS);
  const m = pick(r, MOTION_IDS);
  const n = 12;
  const frames = [];
  for (let f = 0; f < n; f++) frames.push(url(frame(m, f / n, pal)));
  return Object.assign(base, {
    kind: 'image', title, desc,
    cover: frames[Math.floor(n * 0.6)],
    frames, fps: int(r, 8, 14),
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

main().catch((e) => { console.error(e); process.exit(1); });
