/**
 * town-play.mjs — 小镇里"能玩的"那一半里不需要画面的部分:每天的告示、每日谜题、
 * 河里的虫子图鉴、护照印章、等级、奖励表。
 *
 * ⚠ 和 town-folk.mjs 一样:纯函数、确定性、不 import 任何东西。浏览器和服务端
 * (api/play.js 用 `await import()`)共用这一份 —— 今天的告示、今天的谜题答案、
 * 钓上来的是什么,两边算出来必须一模一样,服务端才验得了账。
 *
 * 核心概念是"代码":镇上每栋房子是一个真实的项目。所以
 *   · 告示上的差事是"去拜访一栋 Rust 房子""和一位铁匠聊聊""在护城河里钓三只 bug"
 *   · 每日谜题是"猜猜今天是哪一栋房子"—— 线索全是它真实的数据(语言、目录、最热的文件、提交次数)
 *   · 河里钓上来的是 bug:差一错误鳗、空指针梭子鱼、竞态鲤鱼、海森堡虫(只在夜里)……
 *   · 护照上的印章是语言和风格:集齐二十种语言、八种风格
 *
 *   node src/renderer/town-play.test.mjs
 */

/* ── 随机数(和 town-folk 同一套) ─────────────────────────────────────── */
export function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function rngOf(seed) {
  let a = (typeof seed === 'number' ? seed : hashStr(seed)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const shuffle = (r, arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** 今天是第几天(UTC)。告示、谜题、卷轴按这个换。 */
export function dayIndex(t = Date.now()) { return Math.floor(t / 86400000); }
/** 这周是第几周(周一开始) —— 节日、周榜按这个换。 */
export function weekIndex(t = Date.now()) { return Math.floor((dayIndex(t) + 3) / 7); }

/* ── 等级:经验 → 头衔(开发者的一生) ──────────────────────────────────── */
export const TITLES = [
  { xp: 0, en: 'Newcomer', zh: '新来的' },
  { xp: 60, en: 'Intern', zh: '实习生' },
  { xp: 180, en: 'Contributor', zh: '贡献者' },
  { xp: 400, en: 'Committer', zh: '提交者' },
  { xp: 800, en: 'Reviewer', zh: '审阅人' },
  { xp: 1400, en: 'Maintainer', zh: '维护者' },
  { xp: 2400, en: 'Core Dev', zh: '核心开发者' },
  { xp: 4000, en: 'Architect', zh: '架构师' },
  { xp: 6500, en: 'Guildmaster', zh: '行会长' },
  { xp: 10000, en: 'BDFL', zh: '终身仁慈独裁者' },
];
export function levelOf(xp) {
  xp = Math.max(0, +xp || 0);
  let i = 0;
  while (i + 1 < TITLES.length && xp >= TITLES[i + 1].xp) i++;
  const cur = TITLES[i], next = TITLES[i + 1];
  return { level: i + 1, title: cur, next: next || null, into: xp - cur.xp, need: next ? next.xp - cur.xp : 0 };
}

/* ── 奖励表(服务端按它发,客户端按它显示) ───────────────────────────────
   货币叫"光点"(Glim)。研究里的几条规矩:
   · 每天有上限(约 150),到了就说"今天够了 🌙" —— 之后照样能玩,只是不再给
   · 连续打卡不罚:任意 7 个"做完差事的日子"开一次宝箱,断了不扣任何东西
   · **不为点赞发奖励**(GitHub 连胜计数器的教训):敲门给的是房主,不是敲门的人
   · 经验 = 挣过的光点总数;等级只看在镇上玩了什么,从不看项目自己的星和提交 */
export const REWARD = {
  quest: [10, 15, 20],                  // 三件差事:易、中、社交
  chest: 100,                           // 任意 7 个做完差事的日子
  riddle: 15, riddleFast: 5,            // 猜中;三次以内再加
  scroll: 3,
  stampNew: 10,
  pageDone: 150,                        // 护照一页集满
  fish: (bug) => Math.max(2, Math.min(10, Math.round(bug.price / 6) + 1)),
  water: 2,
  knockOwner: 3,                        // 有人敲你的门:给你(房主)
  festival: 2,                          // 节日当天对应的事:奖励 ×2
};
export const COST = { tree: 60, decor: { banner: 120, lanterns: 100, flowers: 80, fireflies: 250 } };
export const CAPS = { perDay: 150, fish: 40, scrolls: 8, waters: 6, knockOwner: 30, casts: 60, treesPerVilla: 5 };

/* ── 每日告示:三件差事 ───────────────────────────────────────────────────
   每一件都是"去镇上某处做某件和代码有关的事"。目标从今天镇上真实存在的房子里挑,
   保证做得成。进度由事件累加(visit/talk/fish/scroll/knock/water/riddle/lantern/enter)。 */
// 三档:易(走走看看)、中(小游戏)、社交(和人、和房子打交道)。每档挑一件。
// ⚠ 只浇水的差事不放:镇上还没人种树的时候它做不成
const QUEST_TIERS = [['visit_lang', 'visit_style', 'enter', 'scrolls'], ['fish', 'riddle', 'visit_busy'], ['talk_trade', 'lantern', 'plant']];
const STYLE_NAMES = { tang: ['Tang courtyard', '唐宋四合院'], edo: ['Edo garden', '江户庭院'], giza: ['Egyptian temple', '埃及神殿'], hellas: ['Greek colonnade', '希腊柱廊'],
  maya: ['Maya pyramid', '玛雅金字塔'], persia: ['Persian dome', '波斯穹顶'], norse: ['Norse longhouse', '北欧长屋'], modern: ['modern villa', '现代别墅'] };
export function styleName(id, lang) { const s = STYLE_NAMES[id]; return s ? (lang === 'zh' ? s[1] : s[0]) : id; }

/**
 * @param day   dayIndex()
 * @param town  { houses: [{id, lang, style, trade, busy}] } —— 镇上现在有哪些房子(客户端、服务端各自从项目表里算)
 * @returns [{id, kind, target, n, text: {en, zh}}]
 */
export function dailyQuests(day, town) {
  const houses = (town && town.houses) || [];
  const r = rngOf('quests|' + day);
  const langs = [...new Set(houses.map((h) => h.lang).filter(Boolean))];
  const styles = [...new Set(houses.map((h) => h.style).filter(Boolean))];
  const trades = [...new Set(houses.map((h) => h.trade).filter(Boolean))];
  const out = [];
  for (let tier = 0; tier < 3; tier++) for (const kind of shuffle(r, QUEST_TIERS[tier])) {
    if (out.length > tier) break;
    let q = null;
    if (kind === 'visit_lang' && langs.length) {
      const l = pick(r, langs), n = houses.filter((h) => h.lang === l).length >= 2 ? 2 : 1;
      q = { kind, target: l, n, text: { en: `Visit ${n} ${langLabel(l)} house${n > 1 ? 's' : ''}`, zh: `拜访 ${n} 栋 ${langLabel(l)} 房子` } };
    } else if (kind === 'visit_style' && styles.length > 1) {
      const s = pick(r, styles);
      q = { kind, target: s, n: 1, text: { en: `Find a ${styleName(s, 'en')}`, zh: `找到一座${styleName(s, 'zh')}` } };
    } else if (kind === 'visit_busy' && houses.some((h) => h.busy)) {
      q = { kind, target: '', n: 1, text: { en: 'Visit a busy workshop (✨ recent commits)', zh: '去一间正忙的工坊(✨ 最近有提交)' } };
    } else if (kind === 'talk_trade' && trades.length) {
      const t = pick(r, trades);
      q = { kind, target: t, n: 1, text: { en: `Talk to a ${t}`, zh: `和一位${tradeZh(t)}聊聊` } };
    } else if (kind === 'fish') {
      const n = 2 + Math.floor(r() * 3);
      q = { kind, target: '', n, text: { en: `Catch ${n} bugs in the moat`, zh: `在护城河里钓 ${n} 只 bug` } };
    } else if (kind === 'scrolls') {
      const n = 2 + Math.floor(r() * 2);
      q = { kind, target: '', n, text: { en: `Find ${n} code scrolls`, zh: `找到 ${n} 卷代码卷轴` } };
    } else if (kind === 'plant') {
      q = { kind, target: '', n: 1, text: { en: "Plant or water a tree at someone's villa", zh: '在别人家门口种一棵树,或浇一次水' } };
    } else if (kind === 'water') {
      q = { kind, target: '', n: 1, text: { en: 'Water a tree someone planted', zh: '给别人种的树浇一次水' } };
    } else if (kind === 'riddle') {
      q = { kind, target: '', n: 1, text: { en: "Solve today's house riddle", zh: '解开今天的房子谜题' } };
    } else if (kind === 'enter') {
      q = { kind, target: '', n: 1, text: { en: 'Step inside a villa and look around', zh: '走进一栋别墅看看' } };
    } else if (kind === 'lantern') {
      q = { kind, target: '', n: 1, text: { en: 'Light a lantern in town', zh: '在镇上点一盏灯' } };
    }
    if (q) out.push(Object.assign({ id: day + ':' + out.length + ':' + kind, tier, reward: REWARD.quest[tier] }, q));
  }
  return out;
}
/** 一个事件算不算这件差事的一步。 */
export function questMatches(q, ev) {
  if (!q || !ev) return false;
  switch (q.kind) {
    case 'visit_lang': return ev.type === 'visit' && ev.lang === q.target;
    case 'visit_style': return ev.type === 'visit' && ev.style === q.target;
    case 'visit_busy': return ev.type === 'visit' && !!ev.busy;
    case 'talk_trade': return ev.type === 'talk' && ev.trade === q.target;
    case 'fish': return ev.type === 'fish';
    case 'scrolls': return ev.type === 'scroll';
    case 'water': return ev.type === 'water';
    case 'plant': return ev.type === 'water' || ev.type === 'plant';
    case 'riddle': return ev.type === 'riddle';
    case 'enter': return ev.type === 'enter';
    case 'lantern': return ev.type === 'lantern';
    default: return false;
  }
}

const LANG_LABEL = { ts: 'TypeScript', js: 'JavaScript', py: 'Python', python: 'Python', rust: 'Rust', go: 'Go', swift: 'Swift', kotlin: 'Kotlin',
  java: 'Java', 'c++': 'C++', cpp: 'C++', c: 'C', 'c#': 'C#', ruby: 'Ruby', php: 'PHP', html: 'HTML', css: 'CSS', shell: 'Shell', sql: 'SQL',
  dart: 'Dart', lua: 'Lua', zig: 'Zig', elixir: 'Elixir', haskell: 'Haskell', scala: 'Scala', md: 'Markdown', markdown: 'Markdown', vue: 'Vue', svelte: 'Svelte' };
export function langLabel(l) { const k = String(l || '').toLowerCase(); return LANG_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1) : '?'); }
const TRADE_ZH = { tavernkeeper: '酒馆老板', herald: '传令官', blacksmith: '铁匠', scribe: '抄写员', cooper: '箍桶匠', glassblower: '吹玻璃匠', miller: '磨坊主',
  mason: '石匠', jeweller: '珠宝匠', innkeeper: '客栈掌柜', weaver: '织工', dyer: '染匠', lamplighter: '点灯人', astrologer: '占星师', bookbinder: '装订匠',
  toymaker: '玩具匠', baker: '面包师', carpenter: '木匠', apothecary: '药剂师', cartographer: '制图师', beekeeper: '养蜂人', potter: '陶匠' };
export function tradeZh(t) { return TRADE_ZH[t] || t; }

/* ── 每日谜题:今天是哪一栋房子? ─────────────────────────────────────────
   像 Wordle:全镇同一道题,最多猜六次,每猜错一次多揭开一条线索。线索全是这栋房子
   **真实的**数据。猜完可以分享一行格子(不剧透答案)。 */
export function riddleOf(day, projects) {
  const list = (projects || []).filter((p) => p && p.id && p.facts && (p.facts.langs.length || p.facts.dirs.length));
  if (!list.length) return null;
  const r = rngOf('riddle|' + day);
  // 答案:按天轮着挑,跳过线索太少的
  const ans = list.slice().sort((a, b) => (hashStr(a.id + day) - hashStr(b.id + day)))[0];
  const f = ans.facts, x = ans.extra || {};
  const clues = [];
  if (f.langs.length) clues.push({ k: 'langs', en: `Built mostly of ${f.langs.join(', ')}`, zh: `主要用 ${f.langs.join('、')} 盖的` });
  if (f.files) clues.push({ k: 'size', en: `${f.files} files${f.sizeText ? ' · ' + f.sizeText : ''}`, zh: `${f.files} 个文件${f.sizeText ? ' · ' + f.sizeText : ''}` });
  if (f.dirs.length) clues.push({ k: 'dirs', en: `Rooms named ${f.dirs.slice(0, 3).join(', ')}`, zh: `屋子叫 ${f.dirs.slice(0, 3).join('、')}` });
  if (x.hot) clues.push({ k: 'hot', en: `Its busiest file is “${x.hot}”`, zh: `改得最多的文件是「${x.hot}」` });
  if (f.commitsYear) clues.push({ k: 'commits', en: `${f.commitsYear} commits in the last year`, zh: `过去一年 ${f.commitsYear} 次提交` });
  if (x.people) clues.push({ k: 'people', en: `${x.people} people have worked on it`, zh: `${x.people} 个人参与过` });
  if (f.style) clues.push({ k: 'style', en: `It looks like a ${styleName(f.style, 'en')}`, zh: `它看起来像一座${styleName(f.style, 'zh')}` });
  if (f.subtitle) clues.push({ k: 'subtitle', en: `Its sign reads: “${f.subtitle}”`, zh: `门牌上写着:「${f.subtitle}」` });
  // 从最难的开始揭:语言放后面,门牌放最后
  const order = ['size', 'dirs', 'hot', 'commits', 'people', 'langs', 'style', 'subtitle'];
  clues.sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k));
  // 目录、最热文件常常就叫项目名(ironclad/、ironclad.rs):除了最后那条门牌,线索里不许出现标题和 id
  const t = String(f.title || '').toLowerCase().trim(), idl = String(ans.id).toLowerCase();
  const leaks = (c) => { const s = (c.en + ' ' + c.zh).toLowerCase(); return (t.length >= 3 && s.includes(t)) || s.includes(idl); };
  const kept = clues.filter((c) => c.k === 'subtitle' ? !String(c.en + c.zh).toLowerCase().includes(idl) : !leaks(c));
  return { day, answer: ans.id, title: f.title, clues: kept.slice(0, 7), max: 6, salt: Math.floor(r() * 1e6) };
}
/** 分享那一行:🟥🟥🟩⬜⬜⬜(不写答案) */
export function riddleShare(day, guesses, solved, lang) {
  const cells = [];
  for (let i = 0; i < 6; i++) cells.push(i < guesses - (solved ? 1 : 0) ? '🟥' : i === guesses - 1 && solved ? '🟩' : '⬜');
  const head = lang === 'zh' ? `Terse 小镇谜题 #${day % 10000}` : `Terse Town Riddle #${day % 10000}`;
  return `${head} ${solved ? guesses : 'X'}/6\n${cells.join('')}`;
}

/* ── 河里的 bug:图鉴 ──────────────────────────────────────────────────────
   Animal Crossing 的鱼:什么时候、什么天、哪片水里有什么,稀有度不一样。
   where: moat 护城河 / stream 小河 / any。time: day/night/any。weather: any/rain/storm/fog/snow。 */
export const BUGS = [
  { id: 'offbyone', en: 'Off-by-one Eel', zh: '差一错误鳗', rare: 1, where: 'any', time: 'any', weather: 'any', price: 4, len: [30, 60], col: [0.35, 0.55, 0.4] },
  { id: 'typo', en: 'Typo Minnow', zh: '笔误小鲦', rare: 1, where: 'any', time: 'any', weather: 'any', price: 2, len: [4, 9], col: [0.7, 0.7, 0.6] },
  { id: 'nullptr', en: 'Null Pointer Pike', zh: '空指针梭子鱼', rare: 2, where: 'moat', time: 'any', weather: 'any', price: 9, len: [40, 90], col: [0.3, 0.35, 0.45] },
  { id: 'deadlock', en: 'Deadlock Catfish', zh: '死锁鲶鱼', rare: 2, where: 'moat', time: 'night', weather: 'any', price: 12, len: [35, 80], col: [0.25, 0.22, 0.2] },
  { id: 'race', en: 'Race Condition Carp', zh: '竞态鲤鱼', rare: 2, where: 'stream', time: 'day', weather: 'any', price: 10, len: [25, 60], col: [0.8, 0.5, 0.2] },
  { id: 'leak', en: 'Memory Leak Lamprey', zh: '内存泄漏七鳃鳗', rare: 3, where: 'moat', time: 'any', weather: 'rain', price: 18, len: [50, 100], col: [0.4, 0.3, 0.45] },
  { id: 'regex', en: 'Regex Hydra', zh: '正则九头蛇', rare: 3, where: 'stream', time: 'any', weather: 'any', price: 16, len: [20, 45], col: [0.3, 0.6, 0.6] },
  { id: 'flaky', en: 'Flaky Test Trout', zh: '时好时坏鳟', rare: 2, where: 'stream', time: 'any', weather: 'fog', price: 11, len: [25, 55], col: [0.6, 0.6, 0.7] },
  { id: 'timezone', en: 'Timezone Tuna', zh: '时区金枪鱼', rare: 3, where: 'moat', time: 'dawn', weather: 'any', price: 20, len: [60, 140], col: [0.3, 0.4, 0.7] },
  { id: 'unicode', en: 'Unicode Angler', zh: 'Unicode 鮟鱇', rare: 3, where: 'any', time: 'night', weather: 'any', price: 17, len: [20, 50], col: [0.5, 0.3, 0.6] },
  { id: 'cache', en: 'Stale Cache Cod', zh: '缓存过期鳕', rare: 2, where: 'moat', time: 'any', weather: 'snow', price: 13, len: [40, 80], col: [0.7, 0.75, 0.8] },
  { id: 'heisenbug', en: 'Heisenbug', zh: '海森堡虫', rare: 4, where: 'any', time: 'night', weather: 'any', price: 45, len: [5, 15], col: [0.6, 0.9, 1.0] },
  { id: 'segfault', en: 'Segfault Shark', zh: '段错误鲨', rare: 4, where: 'moat', time: 'any', weather: 'storm', price: 60, len: [120, 260], col: [0.35, 0.36, 0.4] },
  { id: 'y2k', en: 'Y2K Coelacanth', zh: '千年虫腔棘鱼', rare: 5, where: 'stream', time: 'dawn', weather: 'any', price: 120, len: [100, 180], col: [0.35, 0.45, 0.55] },
  { id: 'leftpad', en: 'Left-pad Guppy', zh: 'left-pad 孔雀鱼', rare: 1, where: 'stream', time: 'any', weather: 'any', price: 3, len: [3, 6], col: [0.9, 0.5, 0.6] },
  // 语言虫:只在那种语言的房子附近的水里(钓鱼时身边 30 米内有这种语言的房子)
  { id: 'indent', en: 'IndentationError Eel', zh: '缩进错误鳗', rare: 1, where: 'any', time: 'any', weather: 'any', price: 6, len: [30, 70], col: [0.3, 0.5, 0.7], lang: 'python' },
  { id: 'undefined', en: 'Undefined Carp', zh: 'undefined 鲤', rare: 1, where: 'any', time: 'any', weather: 'any', price: 6, len: [25, 55], col: [0.9, 0.8, 0.3], lang: 'js' },
  { id: 'anytype', en: 'Any-type Axolotl', zh: 'any 类型蝾螈', rare: 2, where: 'any', time: 'any', weather: 'any', price: 9, len: [15, 30], col: [0.4, 0.6, 0.9], lang: 'ts' },
  { id: 'borrow', en: 'Borrow Checker Crab', zh: '借用检查蟹', rare: 2, where: 'any', time: 'any', weather: 'any', price: 11, len: [10, 25], col: [0.8, 0.35, 0.2], lang: 'rust' },
  { id: 'nilpanic', en: 'Nil Panic Newt', zh: 'nil panic 蝾螈', rare: 2, where: 'any', time: 'any', weather: 'any', price: 9, len: [12, 28], col: [0.4, 0.75, 0.85], lang: 'go' },
  { id: 'npe', en: 'NullPointerException Perch', zh: '空指针异常鲈', rare: 1, where: 'any', time: 'any', weather: 'any', price: 7, len: [20, 45], col: [0.8, 0.45, 0.25], lang: 'java' },
  { id: 'ub', en: 'Undefined Behavior Squid', zh: '未定义行为乌贼', rare: 3, where: 'any', time: 'night', weather: 'any', price: 22, len: [30, 90], col: [0.35, 0.4, 0.6], lang: 'c++' },
  { id: 'optional', en: 'Force-unwrap Flounder', zh: '强制解包比目鱼', rare: 2, where: 'any', time: 'any', weather: 'any', price: 9, len: [25, 50], col: [0.9, 0.5, 0.3], lang: 'swift' },
  { id: 'boot', en: 'Old Boot (legacy code)', zh: '旧靴子(遗留代码)', rare: 0, where: 'any', time: 'any', weather: 'any', price: 1, len: [28, 30], col: [0.3, 0.22, 0.15] },
];
const RARE_W = [18, 30, 12, 5, 1.6, 0.35];
export function normLang(l) {
  const k = String(l || '').toLowerCase();
  return k === 'python' || k === 'py' ? 'python' : k === 'javascript' || k === 'js' || k === 'jsx' ? 'js' : k === 'typescript' || k === 'ts' || k === 'tsx' ? 'ts'
    : k === 'c' || k === 'c++' || k === 'cpp' ? 'c++' : k === 'kotlin' ? 'java' : k;
}
function timeTag(hour) { return hour >= 4.5 && hour < 7.5 ? 'dawn' : hour >= 7.5 && hour < 19 ? 'day' : 'night'; }
/** 这会儿在这片水里能钓到哪些。 */
export function bugsAvailable(where, hour, weather, langs) {
  const tt = timeTag(hour);
  const near = new Set((langs || []).map((l) => normLang(l)));
  return BUGS.filter((b) => (!b.lang || near.has(b.lang)) && (b.where === 'any' || b.where === where) &&
    (b.time === 'any' || b.time === tt || (b.time === 'night' && tt === 'dawn' && hour < 5.5)) &&
    (b.weather === 'any' || b.weather === weather || (b.weather === 'rain' && weather === 'storm')));
}
/**
 * 一竿。seed 由服务端给(一个人一天第几竿),两边算得一样。
 * @returns {{bug, len, bite: 秒(咬钩前等多久), window: 秒(咬住多久不松)}}
 */
export function castResult(seed, where, hour, weather, langs) {
  const r = rngOf('cast|' + seed);
  const pool = bugsAvailable(where, hour, weather, langs);
  let sum = 0;
  for (const b of pool) sum += RARE_W[b.rare];
  let x = r() * sum, bug = pool[0];
  for (const b of pool) { x -= RARE_W[b.rare]; if (x <= 0) { bug = b; break; } }
  const len = Math.round(bug.len[0] + r() * (bug.len[1] - bug.len[0]));
  return { bug, len, bite: 1.6 + r() * 4.2, window: Math.max(0.35, 1.0 - bug.rare * 0.13) };
}

/* ── 护照 ─────────────────────────────────────────────────────────────── */
/** 走到一栋房子门口:盖哪几个章(语言章、风格章)。 */
export function stampsFor(house) {
  const out = [];
  if (house && house.lang) out.push('lang:' + String(house.lang).toLowerCase());
  if (house && house.style) out.push('style:' + house.style);
  return out;
}
export const PASSPORT_GOALS = { lang: 20, style: 8 };

/* ── 代码卷轴:每天散在镇上的几卷 ────────────────────────────────────────
   每卷写着某栋房子里一个真实的"最热文件"—— 捡起来进你的法典(codex)。位置在那栋房子门口附近。 */
export function scrollsOf(day, villas, n = 8) {
  // 只按 id 挑(服务端不知道房子在镇上哪儿);位置由客户端放在那栋房子门口附近
  const cand = (villas || []).filter((v) => v && v.id && v.hot)
    .sort((a, b) => hashStr('scroll|' + day + '|' + a.id) - hashStr('scroll|' + day + '|' + b.id));
  return cand.slice(0, n).map((v, i) => ({ id: day + ':' + v.id, villa: v.id, file: v.hot, angle: (hashStr(v.id + day) % 628) / 100, dist: 2.5 + (hashStr(day + v.id) % 30) / 10 }));
}
/** 一颗胶囊里"改得最多的那个文件"(卷轴、谜题线索用)。 */
export function hotFileOf(capsule) {
  const hot = capsule && Array.isArray(capsule.hot) ? capsule.hot.filter((h) => h && h.name) : [];
  if (!hot.length) return '';
  const top = hot.slice().sort((a, b) => (+b.churn || 0) - (+a.churn || 0))[0];
  return String(top.name).slice(0, 80);
}
/** 最近两周有没有提交(✨ 忙碌的工坊)。 */
export function busyOf(capsule) {
  const c = capsule && Array.isArray(capsule.commits) ? capsule.commits : [];
  return c.slice(-14).reduce((a, n) => a + (+n || 0), 0) >= 5;
}

/* ── 周末节日 ─────────────────────────────────────────────────────────── */
const FESTIVALS = [
  { id: 'lantern', en: 'Lantern Night', zh: '灯笼夜', perk: 'lantern' },
  { id: 'fishing', en: 'Bug Hunt Derby', zh: '捉虫大赛', perk: 'fish' },
  { id: 'market', en: 'Open Source Fair', zh: '开源集市', perk: 'knock' },
  { id: 'harvest', en: 'Refactor Harvest', zh: '重构丰收节', perk: 'water' },
];
const FEATURED = ['python', 'js', 'ts', 'rust', 'go', 'java', 'swift', 'c++'];
/** 周六、周日是节日;那两天对应的事奖励翻倍,还有一门"本周语言"(它的房子发光、印章双倍、语言虫多)。 */
export function festivalOn(t = Date.now()) {
  const d = new Date(t);
  const wd = d.getUTCDay();
  if (wd !== 0 && wd !== 6) return null;
  const w = weekIndex(t);
  return Object.assign({ lang: FEATURED[w % FEATURED.length] }, FESTIVALS[w % FESTIVALS.length]);
}

/** 这棵树长到第几阶(0 苗 .. 4 大树):不同的日子浇过几次水。 */
export function treeStage(waterDays) { return Math.max(0, Math.min(4, Math.floor((+waterDays || 0) / 2))); }
