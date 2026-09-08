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

module.exports = { spamReason, findSpam };
