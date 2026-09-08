/**
 * spam.js — 什么算垃圾帖。**一份定义,两个地方用**:发布时挡下来,以及把已经
 * 灌进去的清出去。两处各写一份规则,迟早会对不上,然后"挡住了"和"清掉了"
 * 说的就不是同一批东西。
 *
 * ⚠ 这次是被打了才写的。攻击者在帖子正文里把手法写得清清楚楚:
 * 「由伪造身份注入(零鉴权零注册门禁零限流)」—— 三句话说的是同一个洞:
 *
 *   · 身份是**客户端随便给的一个字符串**,服务端只对它做哈希。想要几个有几个。
 *   · 于是"每个身份最多 24 条"形同虚设:一百条垃圾来自**九十九个身份**,
 *     每个一到两条,一次都没碰到那道闸。
 *   · 而 /api/cloud 那道限流是 600 次/分钟 —— 那是给遥测上报定的,不是给发帖定的。
 *
 * 所以真正的闸门不能建在身份上,得建在**内容**和**来源 IP** 上。这个文件管内容。
 */

/* 联系方式广告。这类帖子的目的就是留一个能找到人的号码,所以号码本身就是特征。
   ⚠ 数字位数卡得紧一点:QQ 号 5–12 位,手机号 11 位。写成 \d+ 会把
   "★ 2,874" 这种正常的数字也算进去。 */
const CONTACT = [
  /qq\s*[:：]?\s*\d{5,12}/i,
  /微\s*信|weixin|wechat\s*[:：]?\s*[a-z0-9_-]{4,}/i,
  /加\s*[vV微]\s*[:：]?\s*[a-z0-9_-]{4,}/i,
  /\b1[3-9]\d{9}\b/,                       // 手机号
  /(telegram|飞机|电报)\s*[:：@]/i,
];

/* 灌水本身的样子:同一个标题后面挂个编号,一条一条排着来。
   `教主牛逼QQ160319672-113` 就是这个形状。 */
const NUMBERED_FLOOD = /^(.{4,40}?)[-_#]\s*\d{1,4}$/;

/* 明着说自己在打洞的。真实用户不会这么写。 */
const BRAGGING = [
  /零鉴权|零注册|零限流|伪造身份|注入/,
  /统一天下|光辉永照/,
];

/** 这颗胶囊是不是垃圾。返回一个原因字符串,或者 null。
 *  ⚠ 只看**人写的那几个字段**。封面是别人机器上生成的图,规则伸不进去也不该伸。 */
function spamReason(cap) {
  if (!cap || typeof cap !== 'object') return null;
  const text = [cap.title, cap.subtitle, cap.desc]
    .concat(Array.isArray(cap.tags) ? cap.tags : [])
    .filter((v) => typeof v === 'string').join(' \n ');
  if (!text.trim()) return null;

  for (const re of CONTACT) if (re.test(text)) return 'contact-ad';
  for (const re of BRAGGING) if (re.test(text)) return 'defacement';

  const title = String(cap.title || '').trim();
  // 带编号的标题本身不算垃圾(`v2`、`-2024` 都正常),要和别的信号一起看。
  if (NUMBERED_FLOOD.test(title) && /[0-9]{5,}/.test(title)) return 'numbered-flood';
  return null;
}

/** 把已经进来的清出去。`rows` 是 db.allWallProjects.all() 的结果。
 *  返回 [{id, title, reason}] —— **返回而不是直接删**,好让调用方决定是不是真删,
 *  也好让日志里能看到到底清掉了什么。 */
function findSpam(rows) {
  const out = [];
  for (const r of rows || []) {
    let cap = null;
    try { cap = JSON.parse(r.capsule); } catch (e) { continue; }
    const reason = spamReason(cap);
    if (reason) out.push({ id: r.id, title: (cap.title || '').slice(0, 48), reason });
  }
  return out;
}


/* ── 违法与不当内容 ────────────────────────────────────────────────────────
   ⚠ 这一组和上面那组不是一回事。上面挡的是**灌水**(留个号码、刷屏),这一组挡的
   是**内容本身不能出现在这里**的东西:毒品枪支、伪造证件、色情、赌博、洗钱刷单、
   盗号盗卡、以及威胁伤害。灌水删掉就完了,这类东西留在一个公开的墙上是另一种性质
   的问题。

   ⚠ 中英文都要写。这个广场两种语言都在用,而只写英文规则等于只挡住一半的人。

   ⚠ 每一条都尽量**贴着实物或交易**来写,不写宽泛的词。"毒"、"枪"、"药"这种字
   单独出现在正常句子里太常见了(消毒、枪版、药丸表情),一旦误伤,被挡住的人
   既看不到原因也没处申诉。 */
const ILLEGAL = [
  // 毒品交易
  [/(冰毒|海洛因|大麻|摇头丸|麻古|依托咪酯|上头电子烟)/, 'drugs'],
  [/\b(cocaine|heroin|meth(amphetamine)?|mdma|ketamine)\b.{0,20}\b(sale|sell|buy|order|ship)\b/i, 'drugs'],
  // 枪支武器
  [/(仿真枪|军火|气枪|射钉枪|枪支.{0,6}(出售|购买|货源))/, 'weapons'],
  [/\b(gun|firearm|ammo)\b.{0,20}\b(for sale|no ffl|untraceable)\b/i, 'weapons'],
  // 伪造证件与身份
  [/(办证|假证|代开发票|身份证.{0,6}(出售|办理)|高仿.{0,4}证件|驾照.{0,4}代办)/, 'forgery'],
  [/\b(fake|forged|novelty)\b.{0,16}\b(passport|id card|driver'?s? licen[sc]e|diploma)\b/i, 'forgery'],
  // 色情
  [/(约炮|裸聊|色情|成人影片|情色资源|三级片|au片|萝莉资源)/, 'adult'],
  [/\b(porn|nudes|escort|onlyfans)\b.{0,20}\b(add|contact|dm|link|free)\b/i, 'adult'],
  // 赌博
  [/(博彩|赌场|六合彩|时时彩|棋牌.{0,4}(代理|上分)|包网|菠菜平台)/, 'gambling'],
  [/\b(casino|betting|gambling)\b.{0,20}\b(bonus|agent|join|register)\b/i, 'gambling'],
  // 洗钱、刷单、跑分
  [/(洗钱|跑分|刷单|刷流水|四件套|银行卡.{0,6}(出租|出售)|接码平台)/, 'money-laundering'],
  [/\b(money laundering|cash ?out service|carding)\b/i, 'money-laundering'],
  // 盗号盗卡与黑产工具
  [/(社工库|开房记录|查档|盗号|撞库|黑客.{0,4}(接单|服务)|渗透.{0,4}接单)/, 'hacking-service'],
  [/\b(cc dumps|fullz|rdp shop|botnet for (hire|rent)|ddos for hire)\b/i, 'hacking-service'],
  // 威胁与伤害
  [/(人肉|寻仇|买凶|上门.{0,4}(报复|教训))/, 'violence'],
  [/\b(hit ?man|kill (him|her|them) for)\b/i, 'violence'],
];

/* 短链。它的用途就是**把目的地藏起来**,而一个不能被看见的目的地在这里没有理由
   存在 —— 正经项目贴的是它自己的仓库或者站点。 */
const SHORTENERS = /\b(bit\.ly|t\.cn|dwz\.cn|suo\.im|tinyurl\.com|goo\.gl|is\.gd|cutt\.ly|rebrand\.ly|s\.id|url\.cn)\b/i;

/** 违法/不当内容。和 spamReason 分开,因为**处置不一样**:灌水是删掉,
 *  这一类还应该留一条记录。 */
function illegalReason(cap) {
  if (!cap || typeof cap !== 'object') return null;
  const text = [cap.title, cap.subtitle, cap.desc]
    .concat(Array.isArray(cap.tags) ? cap.tags : [])
    .filter((v) => typeof v === 'string').join(' \n ');
  if (!text.trim()) return null;
  for (const [re, why] of ILLEGAL) if (re.test(text)) return why;
  if (SHORTENERS.test(text) || SHORTENERS.test(String(cap.link || ''))) return 'link-hiding';
  return null;
}

/** 内容指纹。查重用的不是"标题一模一样",而是**归一化之后**的正文:
 *  编号、空白、标点、大小写全抹掉 —— 灌水的下一招就是把 `-113` 换成 `#113`。 */
function fingerprint(cap) {
  const raw = [cap && cap.title, cap && cap.desc].filter((v) => typeof v === 'string').join(' ');
  return raw
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')      // 链接不参与
    .replace(/[0-9]+/g, '#')              // 所有数字归一 —— 编号灌水就是这么破的
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
    .slice(0, 160);
}

module.exports = { spamReason, findSpam, illegalReason, fingerprint };
