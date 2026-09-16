/* town-net.js — 把镇上的人接起来。
 *
 * 一条 SSE 听镇上的动静(api/town.js,5 Hz),走动时往回发 POST(最多 8 Hz,没动就不发)。
 * 只有登录的人能走:没登录的人照样看得见别人在走,只是自己不在名单里。
 *
 * ⚠ 这一页同时只该有一条 EventSource 家族的连接在镇上 —— 浏览器对同一个域的
 *   HTTP/1.1 连接只有六条,房间那条已经占了一条(src/renderer/rooms.js 的注释)。
 */
(function () {
  var NOTES = [], ES = null, town = null, me = null, lastSent = 0, lastPos = null, joined = false, emote = 0, lastE = 0, marks = [];

  function identity() {
    try { return (window.Social && window.Social.identity && window.Social.identity()) || ''; } catch (e) { return ''; }
  }
  function myName() {
    try {
      var n = localStorage.getItem('terse-name');
      if (n) return n;
    } catch (e) { /* 无痕模式 */ }
    return 'someone';
  }
  function post(path, body) {
    try {
      return fetch('/api/cloud/town/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-terse-identity': identity() },
        body: JSON.stringify(body || {}),
        keepalive: path === 'leave',
      }).then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
    } catch (e) { return Promise.resolve({}); }
  }

  /** 别人的小人:颜色按 id 定(同一个人每次都是同一种颜色)。 */
  function tint(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    var a = (h % 360) / 360;
    return [0.55 + 0.45 * Math.cos(6.283 * a), 0.55 + 0.45 * Math.cos(6.283 * (a + 0.33)), 0.55 + 0.45 * Math.cos(6.283 * (a + 0.66))];
  }

  window.Town = {
    /** 进镇:开一条 SSE,把自己报上去。 */
    join: function (t) {
      town = t;
      var id = identity();
      if (ES) { try { ES.close(); } catch (e) {} ES = null; }
      try {
        ES = new EventSource('/api/cloud/town/stream' + (id ? '?identity=' + encodeURIComponent(id) : ''));
        ES.onmessage = function (e) {
          var d = null;
          try { d = JSON.parse(e.data); } catch (err) { return; }
          if (!town) return;
          if (d.type === 'hello') me = d.you || null;
          if (d.type === 'say') { try { town.says(d.id, d.text); } catch (err) {} return; }
          if (d.type === 'mark' && d.mark) {
            marks = [d.mark].concat(marks.filter(function (m) { return m.id !== d.mark.id; })).slice(0, 400);
            try { town.setMarks(marks); } catch (err) {}
            return;
          }
          if (d.type === 'unmark') {
            marks = marks.filter(function (m) { return m.id !== d.id; });
            try { town.setMarks(marks); } catch (err) {}
            return;
          }
          if (!d.peers) return;
          var list = [];
          for (var i = 0; i < d.peers.length; i++) {
            var p = d.peers[i];
            if (me && p.id === me) continue;              // 自己不画给自己看
            list.push({ id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, v: p.v, e: p.e || 0, rgb: tint(p.id) });
          }
          try { town.setPeers(list); } catch (err) {}
          var el = document.getElementById('townCount');
          if (el && window.T) el.textContent = '';
        };
      } catch (e) { ES = null; }
      // 镇上留下的灯和字条:进来先取一份,之后跟着 SSE 增减
      try {
        fetch('/api/cloud/town/marks').then(function (r) { return r.json(); }).then(function (r) {
          if (!town || !r || !r.ok) return;
          marks = r.marks || [];
          if (Array.isArray(r.notes)) NOTES = r.notes;
          try { town.setMarks(marks); } catch (err) {}
        }).catch(function () {});
      } catch (e) {}
      if (!id) return;                                     // 没登录:只看,不走
      post('join', { name: myName() }).then(function (r) { joined = !!(r && r.ok); });
    },

    /** 走了一步。最多 8 Hz,而且只在真的动了的时候发。 */
    move: function (x, z, yaw, v) {
      if (!joined) return;
      var now = Date.now();
      if (now - lastSent < 125) return;
      if (emote === lastE && lastPos && Math.abs(x - lastPos[0]) < 0.05 && Math.abs(z - lastPos[1]) < 0.05 && Math.abs(yaw - lastPos[2]) < 0.05) return;
      lastSent = now; lastPos = [x, z, yaw]; lastE = emote;
      post('move', { x: x, z: z, yaw: yaw, v: v || 0, e: emote });
    },

    /** 表情变了:下一次 move 带上(站着不动也发一次)。 */
    emote: function (n) {
      emote = n | 0;
      if (lastPos) { lastSent = 0; this.move(lastPos[0], lastPos[1], lastPos[2], 0); }
    },

    /** 说一句话:自己头顶马上出来,不等服务器转回来。 */
    say: function (text) {
      if (!joined) return Promise.resolve({ error: 'signin' });
      return post('say', { text: text });
    },

    /** 点一盏灯 / 留一张字条(字条给的是模板的下标)。 */
    mark: function (kind, x, z, note) {
      if (!joined) return Promise.resolve({ error: 'signin' });
      return post('mark', { kind: kind, x: x, z: z, note: note });
    },

    signedIn: function () { return joined; },

    /* ── 镇上的人(每栋别墅的主人):打招呼、说话、道别。见 api/npc.js ── */
    npcHello: function (id, ctx, lang) {
      var q = '?lang=' + encodeURIComponent(lang || 'en') + '&hour=' + encodeURIComponent(ctx && ctx.hour != null ? ctx.hour : '') +
        '&weather=' + encodeURIComponent((ctx && ctx.weather) || '') + '&season=' + encodeURIComponent((ctx && ctx.season) || '');
      try {
        return fetch('/api/cloud/town/npc/' + encodeURIComponent(id) + '/hello' + q, { headers: { 'x-terse-identity': identity() } })
          .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
      } catch (e) { return Promise.resolve({}); }
    },
    npcSay: function (id, text, ctx, lang) {
      if (!identity()) return Promise.resolve({ error: 'signin' });
      return post('npc/' + encodeURIComponent(id) + '/say', { text: text, lang: lang || 'en', ctx: ctx || {} });
    },
    npcBye: function (id, lang) {
      if (!identity()) return Promise.resolve({});
      return post('npc/' + encodeURIComponent(id) + '/bye', { lang: lang || 'en' });
    },
    notes: function () { return NOTES; },

    /** 走出小镇:断开,并且告诉别人我走了(不然要等 45 秒才消失)。 */
    leave: function () {
      town = null;
      if (ES) { try { ES.close(); } catch (e) {} ES = null; }
      if (joined) { joined = false; post('leave', {}); }
    },
  };

  // 关掉页面也算走了
  window.addEventListener('pagehide', function () { try { window.Town.leave(); } catch (e) {} });
}());
