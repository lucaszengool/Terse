/**
 * social.js — 广场的社交层,在手机上。点赞 / 收藏 / 评论 / 好友 / 私信。
 *
 * ⚠ 这个文件存在的**第一个理由是身份**,不是省几行 fetch。
 *
 * 这个后端上本来有两套身份,都走 `x-terse-identity` 这一个头,但取的哈希不一样:
 *
 *   · 广场和私信:`sha256(值).slice(0,32)`,值是 **Clerk 用户 id**(Mac 上一直如此)。
 *   · 房间和好友:`sha256(值)` 完整 64 位,值是 rooms.js 生成的**本机随机密钥**。
 *
 * 于是同一个人在服务端是两个人:他在 Mac 上发布的项目,和他在手机上加的好友,
 * 彼此看不见。"加个好友然后聊天"在这上面根本不成立。
 *
 * 手机这一端统一成**一个**:登录后把 Clerk 用户 id 写进 rooms.js 读的那个键
 * (`terse-identity`),于是房间、好友、广场、私信全部落在同一串哈希上,
 * 而短的那串正好是长的那串的前缀 —— 服务端就是靠这一点把好友和私信对上的
 * (见 api/dm.js 的 friendedByShortHash)。
 *
 * ⚠ **不改 rooms.js**。那个文件是 Mac 和手机共用的同一份(`/app-assets`),
 * 改它的 identity() 会一并改掉 Mac 上已经存在的房间和好友。这里只是**喂给它**
 * 一个值,它照常读它自己的键。
 *
 * ⚠ 换掉之前那串随机密钥会**丢掉用它建立的好友**,所以旧值留在
 * `terse-identity-legacy` 里,不是删掉 —— 这一步是不可逆的,别做成不可查的。
 */
(function (root) {
  'use strict';

  var LS_ID = 'terse-identity';            // rooms.js 读的那个键
  var LS_LEGACY = 'terse-identity-legacy'; // 换掉之前那串,留个底

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function setLs(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /** 登录后把身份统一到 Clerk 用户 id。返回是否动过。 */
  function adopt(clerkUserId) {
    var id = String(clerkUserId || '').trim();
    if (!id) return false;
    var cur = ls(LS_ID);
    if (cur === id) return false;
    if (cur && !ls(LS_LEGACY)) setLs(LS_LEGACY, cur);
    setLs(LS_ID, id);
    return true;
  }

  /** 现在这台机器用什么身份说话。没登录时就是 rooms.js 那串随机密钥 ——
   *  广场可以匿名逛,所以这里返回空也不能让调用方崩掉。 */
  function identity() { return ls(LS_ID) || ''; }

  function headers(withBody) {
    var h = { Accept: 'application/json' };
    var id = identity();
    if (id) h['x-terse-identity'] = id;
    if (withBody) h['Content-Type'] = 'application/json';
    return h;
  }

  function call(path, opts) {
    opts = opts || {};
    var body = opts.body ? JSON.stringify(opts.body) : undefined;
    return fetch('/api/cloud' + path, {
      method: opts.method || 'GET',
      headers: headers(!!body),
      body: body,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        // 服务端的话原样往上抛。"发不出去"这件事,人需要知道**为什么** ——
        // 尤其是私信那道闸,一句通用的失败会让他反复去按同一个按钮。
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var Social = {
    adopt: adopt,
    identity: identity,

    /* ── 广场 ───────────────────────────────────────────────────────────── */
    // 带身份取列表:`liked`/`faved` 只有带了身份才是真的,否则每颗心都是空的。
    projects: function (limit, q) {
      // 搜索交给服务端:手机手上只有最新的一页,而人问的是"广场上有没有"。
      return call('/projects/public?limit=' + (limit || 40)
                  + (q ? '&q=' + encodeURIComponent(q) : ''));
    },
    like: function (id) { return call('/projects/' + encodeURIComponent(id) + '/like', { method: 'POST' }); },
    fav: function (id) { return call('/projects/' + encodeURIComponent(id) + '/fav', { method: 'POST' }); },
    comments: function (id) { return call('/projects/' + encodeURIComponent(id) + '/comments'); },
    // 预览计数。故意做成"尽力而为" —— 数不准也没关系,但它是作者唯一能看到的反馈。
    view: function (id) { return call('/projects/' + encodeURIComponent(id) + '/view', { method: 'POST' }); },
    comment: function (id, body, parentId) {
      return call('/projects/' + encodeURIComponent(id) + '/comments', {
        method: 'POST', body: { body: body, parentId: parentId || null },
      });
    },
    likeComment: function (cid) {
      return call('/projects/comments/' + encodeURIComponent(cid) + '/like', { method: 'POST' });
    },
    deleteComment: function (cid) {
      return call('/projects/comments/' + encodeURIComponent(cid), { method: 'DELETE' });
    },

    /* ── 好友 ───────────────────────────────────────────────────────────── */
    // 我的邀请码。服务端对同一个人**复用**同一个,所以这可以当作"我的 id"来给人 ——
    // 而它是一串随机 token,不是身份哈希:能撤销,也没法拿去遍历别人。
    // 名字必须**传上去**。服务端只有在调用方带着房间钥匙时才知道你叫什么,
    // 而手机上没有房间钥匙 —— 不传的话,加你的人永远看到的是"某人"。
    myCode: function (name) { return call('/friends/link', { method: 'POST', body: { name: name || null } }); },
    addByCode: function (code, name) {
      // 加人的时候也报上名字:对方的好友列表里那一行才有人,而不是一个问号。
      return call('/friends/link/' + encodeURIComponent(String(code).trim()) + '/accept',
                  { method: 'POST', body: { name: name || null } });
    },
    // 先看是谁,再决定加不加。粘错一个码就直接成了好友,是没有给人留下"看一眼"
    // 的那一步 —— 而这一步正是搜索和添加的区别。
    lookup: function (code) {
      return call('/friends/lookup/' + encodeURIComponent(String(code).trim()));
    },
    friends: function () { return call('/friends'); },
    respondFriend: function (id, accept) {
      return call('/friends/' + encodeURIComponent(id) + '/respond', { method: 'POST', body: { accept: !!accept } });
    },
    unfriend: function (id) { return call('/friends/' + encodeURIComponent(id), { method: 'DELETE' }); },

    /* ── 私信 ───────────────────────────────────────────────────────────── */
    inbox: function () { return call('/dm'); },
    thread: function (peer) { return call('/dm/' + encodeURIComponent(peer)); },
    send: function (peer, body, opts) {
      opts = opts || {};
      return call('/dm/' + encodeURIComponent(peer), {
        method: 'POST',
        body: { body: body, author: opts.author || null, projectId: opts.projectId || null },
      });
    },
  };

  /** 一串邀请码可能是整条链接贴进来的。取最后一段,并把查询串切掉 ——
   *  人从聊天窗口复制的十有八九是 `https://…/join?friend=TOKEN`,让他自己去截
   *  是把我们的实现细节当成了他的工作。 */
  Social.codeFrom = function (raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var m = s.match(/[?&]friend=([^&#\s]+)/);
    if (m) return decodeURIComponent(m[1]);
    if (s.indexOf('/') >= 0) s = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
    return s;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Social;
  root.TerseSocial = Social;
}(typeof window !== 'undefined' ? window : globalThis));
