/**
 * dm.js — 私信。挂在 /api/cloud/dm。
 *
 * **为什么这里可以给陌生人发,而好友申请必须在同一个房间里(见 friends.js)。**
 * 房间那条规矩是对的:一个房间码就是凭证,不该有人能拿身份哈希去遍历陌生人。
 * 但发布到广场是**另一件事** —— 你把项目摆出来给人看,本身就是在说"可以来找我
 * 聊这个"。所以这里放开两道很窄的口子,一条线只要满足其一就通:
 *
 *   · 第一条搭讪挂在对方**真的发布过的一个项目**上(projectId 会被核对)。
 *     它既是上下文("我是为这个来的"),也是闸门 —— 没有由头就发不出去,
 *     于是也没法拿一串哈希去骚扰人。
 *   · 或者两个人**已经是好友**。同意加好友就是同意被说话;还要求挂个项目,
 *     等于把同一件事问两遍,而且好友之间常常根本没有项目可挂。
 *   · 对方在这条线上回过一次,线就通了,之后两样都不用。
 *   · 每人每小时有条数上限。免费的私信如果没有闸,广场第一天就会变成小广告墙。
 *
 * 一对人**只有一条线**:thread = 两个身份排序后用竖线拼起来。所以"我发给他"和
 * "他发给我"天然落在同一条线上 —— 不需要两张表,也不需要 join 去把两半拼回去。
 *
 * ⚠ 这里的身份是 `sha256(x-terse-identity).slice(0,32)`,和广场同一套;好友那边
 * 用的是**同一个哈希的完整 64 位**。短的是长的前缀,`db.friendedByShortHash` 就是
 * 靠这一点把两边对上的 —— 两套 id 之间没有映射表,别去造一张。
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

const MAX_BODY = 2000;
const PER_HOUR = 40;          // 同一个人一小时最多发这么多条
const uuid = () => crypto.randomUUID();
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

/** 一对人的线。排序过,所以两个方向算出来是同一条。 */
const threadOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
/** 这条线上的另一个人。 */
const peerOf = (thread, me) => {
  const parts = String(thread).split('|');
  return parts[0] === me ? parts[1] : parts[0];
};

/** 谁在打这个电话。和广场用的是同一个头 —— 身份是客户端那串 id 的哈希。 */
function idHash(req) {
  const raw = String(req.get('x-terse-identity') || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
const requireMe = (req, res) => {
  const me = idHash(req);
  if (!me) { res.status(401).json({ error: 'Missing identity' }); return null; }
  return me;
};

const shape = (m, me) => ({
  id: m.id,
  mine: m.from_id === me,
  author: m.from_name || null,
  body: m.body,
  projectId: m.project_id || null,
  at: m.created_at,
  read: !!m.read_at,
});

// GET /api/cloud/dm — 收件箱:一条线一行(最后一句 + 未读数)。
router.get('/', (req, res) => {
  const me = requireMe(req, res); if (!me) return;
  const rows = db.dmInbox.all({ me });
  const threads = rows.map((r) => {
    const last = db.dmLast.get({ thread: r.thread });
    return {
      peer: peerOf(r.thread, me),
      // 对方叫什么:用**他自己最近一次发言时报的名字**。名字是会改的,而每条消息
      // 都记了当时那个名字 —— 拿最新的一条,列表里就永远是他现在的名字。
      name: last && last.from_id !== me ? (last.from_name || null) : null,
      last: last ? shape(last, me) : null,
      unread: r.unread || 0,
      count: r.n || 0,
      at: r.last_at,
    };
  });
  res.json({ ok: true, threads, unread: (db.dmUnreadTotal.get({ me }) || {}).n || 0 });
});

// GET /api/cloud/dm/:peer — 一条线的全部,顺手标已读。
router.get('/:peer', (req, res) => {
  const me = requireMe(req, res); if (!me) return;
  const peer = clip(req.params.peer, 64);
  if (!peer || peer === me) return res.status(400).json({ error: 'Bad peer' });
  const thread = threadOf(me, peer);
  const msgs = db.dmThread.all({ thread }).map((m) => shape(m, me));
  // 打开就算读过 —— 这是"看过了"最诚实的定义,不需要前端再报一次。
  db.dmMarkRead.run({ thread, me });
  res.json({
    ok: true,
    peer,
    messages: msgs,
    // 这条线现在要不要由头。前端据此决定是直接给输入框,还是先要一个项目 ——
    // 让人打完一段话再告诉他"发不出去",是最糟的一种拒绝。
    open: isOpen(thread, me, peer),
  });
});

/** 这条线通了没有:对方回过话,或者两个人已经是好友。 */
function isOpen(thread, me, peer) {
  if (((db.dmRepliedBy.get({ thread, peer }) || {}).n || 0) > 0) return true;
  return !!(db.friendedByShortHash.get({ x: me, y: peer }) || {}).yes;
}

// POST /api/cloud/dm/:peer  { body, author?, projectId? }
router.post('/:peer', (req, res) => {
  const me = requireMe(req, res); if (!me) return;
  const peer = clip(req.params.peer, 64);
  if (!peer || peer === me) return res.status(400).json({ error: 'Bad peer' });

  const b = req.body || {};
  const body = clip(String(b.body || '').trim(), MAX_BODY);
  if (!body) return res.status(400).json({ error: 'Empty message' });
  const author = clip(String(b.author || '').trim(), 40) || null;

  const hour = (db.dmSentSince.get({ me, window: '-1 hours' }) || {}).n || 0;
  if (hour >= PER_HOUR) return res.status(429).json({ error: 'Too many messages', retryAfter: 3600 });

  const thread = threadOf(me, peer);
  let projectId = null;
  if (!isOpen(thread, me, peer)) {
    projectId = clip(String(b.projectId || ''), 64);
    const owner = projectId ? db.wallProjectOwner.get(projectId) : null;
    // 第一条必须挂在**对方自己发布的**项目上。挂别人的项目不算 —— 那就等于
    // 随便找个由头,闸门也就不成其为闸门了。
    if (!owner || owner.identity !== peer) {
      return res.status(403).json({
        error: 'First message must reference a project this person published',
      });
    }
  }

  const id = uuid();
  db.sendDm.run({ id, thread, from_id: me, to_id: peer, from_name: author, project_id: projectId, body });
  res.json({ ok: true, id });
});

module.exports = router;
