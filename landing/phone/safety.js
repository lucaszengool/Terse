/**
 * safety.js — 举报和拉黑,在手机上。私信、评论、房间聊天各一对,外加"已拉黑"名单。
 *
 * 身份和 social.js 同一个头(x-terse-identity);房间那一对还要带房间钥匙,
 * 和 rooms.js 发聊天用的是同一把 —— 服务端靠它确认你真的在这间屋里。
 *
 * ⚠ 从评论和房间里拉黑,传的是**评论 id / 成员 id**,不是对方的身份。
 *   对方是谁由服务端去查,手机从头到尾不需要见到那串哈希。
 */
(function (root) {
  'use strict';

  function identity() {
    var S = root.TerseSocial;
    return (S && S.identity && S.identity()) || '';
  }
  function room() {
    var R = root.TerseRooms;
    return (R && R.state && R.state()) || null;
  }

  function call(path, opts) {
    opts = opts || {};
    var h = { Accept: 'application/json' };
    var id = identity();
    if (id) h['x-terse-identity'] = id;
    if (opts.key) h['x-terse-room-key'] = opts.key;
    var body = opts.body ? JSON.stringify(opts.body) : undefined;
    if (body) h['Content-Type'] = 'application/json';
    return fetch('/api/cloud' + path, { method: opts.method || 'GET', headers: h, body: body })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
      });
  }
  function roomCall(path, body) {
    var st = room();
    if (!st || !st.id || !st.key) return Promise.reject(new Error('Not in a room'));
    return call('/rooms/' + encodeURIComponent(st.id) + path, { method: 'POST', key: st.key, body: body || {} });
  }
  var enc = encodeURIComponent;

  var Safety = {
    /* 私信:按对方的短身份。 */
    reportDm: function (peer, reason) { return call('/dm/' + enc(peer) + '/report', { method: 'POST', body: { reason: reason } }); },
    blockDm: function (peer, name) { return call('/dm/' + enc(peer) + '/block', { method: 'POST', body: { name: name || null } }); },
    /* 评论:按评论 id。 */
    reportComment: function (cid, reason) {
      return call('/projects/comments/' + enc(cid) + '/report', { method: 'POST', body: { reason: reason } });
    },
    blockComment: function (cid) { return call('/projects/comments/' + enc(cid) + '/block', { method: 'POST' }); },
    /* 房间:加密房间里服务端只有密文,所以把我看到的那段话一起交上去当证据。 */
    reportRoomMsg: function (mid, reason, excerpt) {
      return roomCall('/messages/' + enc(mid) + '/report', { reason: reason, excerpt: excerpt || '' });
    },
    blockRoomMember: function (memberId) { return roomCall('/members/' + enc(memberId) + '/block'); },
    /* 名单。挂在 /dm 下面,但从哪里拉黑的人都在里面。 */
    blocks: function () { return call('/dm/blocks'); },
    unblock: function (id) { return call('/dm/blocks/' + enc(id), { method: 'DELETE' }); },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Safety;
  root.TerseSafety = Safety;
}(typeof window !== 'undefined' ? window : globalThis));
