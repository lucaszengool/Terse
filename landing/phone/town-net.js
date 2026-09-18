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
  /* 自己的小伙伴接的是哪种 agent(只是种类,给别人看头顶光点的颜色;说了什么永远不经过这里)。
     onPet:狗和狗之间的邀请 / 回复,交给页面转给宿主。 */
  var agentKind = '', lastA = '', onPet = null;

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
          if (d.type === 'hello') {
            me = d.you || null;
            // 服务器给别人的是这个 id(身份的哈希)—— 自己那只也按它长,你看见的和别人看见的才是同一只
            if (me && town.pets && town.pets.setIdentity) { try { town.pets.setIdentity(me); } catch (err) {} }
          }
          if (d.type === 'petInvite' || d.type === 'petReply') { if (onPet) { try { onPet(d); } catch (err) {} } return; }
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
            list.push({ id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, v: p.v, e: p.e || 0, a: p.a || '', rgb: tint(p.id) });
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
      post('join', { name: myName() }).then(function (r) {
        joined = !!(r && r.ok);
        // 小伙伴的 agent 种类可能比进镇先到(那一下 move 被挡掉了):进镇了再报一次
        if (joined && agentKind) window.Town.setAgent(agentKind);
      });
    },

    /** 走了一步。最多 8 Hz,而且只在真的动了的时候发。 */
    move: function (x, z, yaw, v) {
      if (!joined) return;
      var now = Date.now();
      if (now - lastSent < 125) return;
      if (emote === lastE && agentKind === lastA && lastPos && Math.abs(x - lastPos[0]) < 0.05 && Math.abs(z - lastPos[1]) < 0.05 && Math.abs(yaw - lastPos[2]) < 0.05) return;
      lastSent = now; lastPos = [x, z, yaw]; lastE = emote; lastA = agentKind;
      post('move', { x: x, z: z, yaw: yaw, v: v || 0, e: emote, a: agentKind });
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
    me: function () { return me; },

    /* ── agent 小伙伴 ── */
    /** 自己那只接上了哪种 agent:下一步就带出去,别人头顶的光点跟着变色 */
    setAgent: function (kind) {
      agentKind = String(kind || '');
      // 进镇后一直站着没动的话,还没发过位置(lastPos 是空的)—— 问小镇自己站在哪,照样报一次
      var p = lastPos;
      if (!p && town && town.where) { try { var w = town.where(); p = [w.x, w.z, w.yaw]; } catch (e) {} }
      if (p) { lastSent = 0; this.move(p[0], p[1], p[2], 0); }
    },
    onPet: function (cb) { onPet = cb; },
    /** 邀请对方的小伙伴认识:code 是两人房间的加入码。服务器只转给 to 那一个人。 */
    petInvite: function (to, code, pet) {
      if (!joined) return Promise.resolve({ error: 'signin' });
      return post('pet/invite', { to: to, code: code, pet: pet || '' });
    },
    petReply: function (to, ok) {
      if (!joined) return Promise.resolve({ error: 'signin' });
      return post('pet/reply', { to: to, ok: !!ok });
    },

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
    /* ── 能玩的(api/play.js):告示、谜题、钓鱼、卷轴、种树、装饰 ── */
    play: {
      state: function () {
        return fetch('/api/cloud/town/play/state', { headers: { 'x-terse-identity': identity() } })
          .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
      },
      event: function (ev) { return identity() ? post('play/event', ev) : Promise.resolve({}); },
      riddle: function (guess) { return post('play/riddle', { guess: guess }); },
      cast: function (p) { return post('play/cast', p); },
      reel: function (p) { return post('play/reel', p); },
      scroll: function (id) { return post('play/scroll', { id: id }); },
      plant: function (villa) { return post('play/tree', { villa: villa }); },
      water: function (id) { return post('play/tree/' + encodeURIComponent(id) + '/water', {}); },
      decor: function (villa, item, value) { return post('play/decor', { villa: villa, item: item, value: value }); },
      chest: function () { return post('play/chest', {}); },
      /* 敲门 = 给这个项目点赞(只点亮,不取消 —— 再敲一次不该把赞收回去) */
      knock: function (villa) {
        if (!identity()) return Promise.resolve({});
        var url = '/api/cloud/projects/' + encodeURIComponent(villa) + '/like';
        var hdr = { method: 'POST', headers: { 'x-terse-identity': identity() } };
        return fetch(url, hdr).then(function (r) { return r.json(); }).then(function (r) {
          // 点赞接口是切换的:原来就点过,这一下把它取消了 —— 再点一次点回来
          if (r && r.on === false) return fetch(url, hdr);
        }).catch(function () {});
      },
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
