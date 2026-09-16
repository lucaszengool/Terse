/* town-net.js — 把镇上的人接起来。
 *
 * 一条 SSE 听镇上的动静(api/town.js,5 Hz),走动时往回发 POST(最多 8 Hz,没动就不发)。
 * 只有登录的人能走:没登录的人照样看得见别人在走,只是自己不在名单里。
 *
 * ⚠ 这一页同时只该有一条 EventSource 家族的连接在镇上 —— 浏览器对同一个域的
 *   HTTP/1.1 连接只有六条,房间那条已经占了一条(src/renderer/rooms.js 的注释)。
 */
(function () {
  var ES = null, town = null, me = null, lastSent = 0, lastPos = null, joined = false;

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
          if (!d.peers) return;
          var list = [];
          for (var i = 0; i < d.peers.length; i++) {
            var p = d.peers[i];
            if (me && p.id === me) continue;              // 自己不画给自己看
            list.push({ id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, v: p.v, rgb: tint(p.id) });
          }
          try { town.setPeers(list); } catch (err) {}
          var el = document.getElementById('townCount');
          if (el && window.T) el.textContent = '';
        };
      } catch (e) { ES = null; }
      if (!id) return;                                     // 没登录:只看,不走
      post('join', { name: myName() }).then(function (r) { joined = !!(r && r.ok); });
    },

    /** 走了一步。最多 8 Hz,而且只在真的动了的时候发。 */
    move: function (x, z, yaw, v) {
      if (!joined) return;
      var now = Date.now();
      if (now - lastSent < 125) return;
      if (lastPos && Math.abs(x - lastPos[0]) < 0.05 && Math.abs(z - lastPos[1]) < 0.05 && Math.abs(yaw - lastPos[2]) < 0.05) return;
      lastSent = now; lastPos = [x, z, yaw];
      post('move', { x: x, z: z, yaw: yaw, v: v || 0 });
    },

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
