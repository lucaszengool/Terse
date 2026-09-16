/**
 * safety.js — 举报和拉黑。私信、评论、房间聊天共用的那一半。
 *
 * 不是路由。各个路由(dm.js / projects.js / rooms.js)自己知道"这条东西是谁说的",
 * 这里只管两件事:谁拉黑了谁,和一份给人看的举报记录。
 *
 * ⚠ 身份一律存**32 位短哈希**。私信和广场本来就是短的;房间和好友是完整 64 位,
 *   截前 32 位就是同一个人(见 dm.js 顶部)。存成一种,三个地方才对得上。
 *
 * ⚠ 拉黑是**单向**的,也是**看的人自己的事**:被拉黑的人不会收到任何通知,
 *   他那边一切照旧 —— 只是他的私信发不过来,他说的话在你这里不再出现。
 *
 * ⚠ 举报要**到人手里**。表是底账;配了 SLACK_QA_WEBHOOK_URL(客服表单用的同一个)
 *   就顺手往那里报一行。报不出去不影响举报本身 —— 表里已经有了。
 */
const crypto = require('crypto');
const db = require('./db');

/** 同一条东西被这么多**不同的人**举报,就先不出现。和帖子同一个阈值。 */
const REPORT_HIDE_AT = 3;
const KINDS = ['dm', 'comment', 'room', 'post'];
const REASONS = ['spam', 'abuse', 'sexual', 'violence', 'other'];

const short = (h) => String(h || '').slice(0, 32);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

/** 我拉黑了哪些人。列表接口拿它去滤,一次查完。 */
function blockedBy(me) {
  const out = new Set();
  if (!me) return out;
  for (const r of db.blockedIdsBy.all({ me: short(me) })) out.add(r.blocked);
  return out;
}

/** a 有没有拉黑 b。 */
function hasBlocked(a, b) {
  if (!a || !b) return false;
  return !!db.isBlockedBy.get({ a: short(a), b: short(b) });
}

/** 拉黑。name 只是给"已拉黑"那张列表看的 —— 不存就只剩一串认不出的哈希。 */
function block(me, target, name, kind) {
  const a = short(me), b = short(target);
  if (!a || !b || a === b) return null;
  db.addBlock.run({ id: 'bk_' + crypto.randomBytes(8).toString('hex'), blocker: a, blocked: b,
                    name: clip(name || '', 40) || null, kind: KINDS.indexOf(kind) >= 0 ? kind : null });
  return db.getBlock.get({ a, b });
}

function unblock(me, id) { db.removeBlock.run({ id: String(id || ''), me: short(me) }); }

/** 给看的人自己的列表。⚠ 不带被拉黑那个人的身份哈希:从评论或房间里拉黑的人,
 *  原本就没见过那串 —— 取消靠这一行自己的 id。 */
function listBlocks(me) {
  return db.blocksBy.all({ me: short(me) })
    .map((r) => ({ id: r.id, name: r.name || null, kind: r.kind || null, at: r.created_at }));
}

/** 记一条举报。一人一票:同一个人对同一条东西再报,还是一票。 */
function report({ kind, targetId, targetIdentity, reporter, reason, excerpt }) {
  const k = KINDS.indexOf(kind) >= 0 ? kind : 'other';
  const r = REASONS.indexOf(reason) >= 0 ? reason : (clip(String(reason || ''), 40) || 'other');
  const ex = clip(String(excerpt || ''), 1000);
  const fresh = db.addSafetyReport.run({
    kind: k, target_id: clip(String(targetId || ''), 128), target_identity: short(targetIdentity) || null,
    reporter: short(reporter), reason: r, excerpt: ex || null,
  }).changes > 0;
  const n = (db.countSafetyReports.get({ kind: k, target_id: String(targetId || '') }) || {}).n || 0;
  if (fresh) alert(k, targetId, r, ex, n);
  return { reports: n, hidden: n >= REPORT_HIDE_AT, fresh };
}

/** 被举报够多次、该先藏起来的那些。 */
function hiddenIds(kind) {
  return new Set(db.reportedTargets.all({ kind, threshold: REPORT_HIDE_AT }).map((r) => r.target_id));
}

/** 往 Slack 报一行。尽力而为:没配、网络断了,都只是少一声提醒,举报已经在表里。 */
function alert(kind, targetId, reason, excerpt, n) {
  const hook = process.env.SLACK_QA_WEBHOOK_URL;
  if (!hook || typeof fetch !== 'function') return;
  // 和客服表单一样先转义,别让被举报的那段话在 Slack 里变成格式或链接。
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const line = `🚩 Report · ${kind} ${esc(String(targetId).slice(0, 64))} · ${esc(reason)} · ${n} reporter${n === 1 ? '' : 's'}`
    + (n >= REPORT_HIDE_AT && kind !== 'dm' ? ' · auto-hidden' : '')
    + (excerpt ? `\n> ${esc(excerpt.slice(0, 280)).replace(/\n/g, ' ')}` : '');
  fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: line }) })
    .then((r) => { if (!r.ok) console.warn('[safety] slack', r.status); })
    .catch((e) => console.warn('[safety] slack', e.message));
}

module.exports = { REPORT_HIDE_AT, short, blockedBy, hasBlocked, block, unblock, listBlocks, report, hiddenIds };
