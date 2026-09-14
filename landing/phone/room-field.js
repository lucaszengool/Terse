/**
 * room-field.js — 房间里的代码城市。
 *
 * 广场放的是陌生人的项目(plaza-field.js),这里放的是**同屋这几个人**的。同一台
 * 引擎、同一颗胶囊、同一个 showProject —— 区别只有一个:名单是谁。
 *
 * ⚠ 为什么名单只能从服务端拿。名册发到手机上时,每个人的 identity_hash 是被摘掉
 * 的(api/rooms.js 的 roster()),而"这个人在广场上发过什么"恰恰要拿那串去查。
 * 所以配对在服务端做,手机收到的是**已经配好的**成员和胶囊;它自始至终没有见过
 * 屋里任何人的身份串,这一点和摘掉它的理由是同一个。
 *
 * ⚠ 胶囊一律走 TersePlazaField.toCapsule()。那是胶囊进入引擎的唯一入口,代码城市
 * 当初就是死在漏掉字段的一行上;这里再写一份"差不多的"转换,就是把那个坑重挖
 * 一遍,而且两份会各自漂移。
 *
 * ⚠ 只在**房间这一屏开着**的时候放。壁纸那一屏是这个人自己的 agent 在说话,把
 * 室友的城盖上去,和让陌生人的项目盖住实时数字是同一种错。进房间这件事是他自己
 * 做的,所以在房间屏里放室友的城不需要再问;走出这一屏就还回去。
 */
(function (root) {
  'use strict';

  var API = '/api/cloud/rooms';

  /** 一座城占多久。和广场一致 —— 两边对"一次预览"的理解不该不一样。 */
  var PLAY_MS = 20000;
  /** 散场后的空档。比广场短:屋里就这么几个人,停太久像是没了。 */
  var GAP_MS = 6000;

  var pool = [];        // [{ member_id, name, status, project:{ id, title, capsule } }]
  var order = [];
  var timer = null;
  var stopped = true;
  var playing = null;   // 正在放的那一条,给"现在是谁"用
  var onPlay = null;

  function st() {
    var R = root.TerseRooms;
    return (R && R.state && R.state()) || null;
  }

  /* 洗一次牌然后走完,不是每次随机挑。随机会重复,而屋里只有三五个人的时候,
     连着两次放同一个人就像轮播坏了。在线的人排在前面:他此刻就在屋里,他的城
     被看见是有人会接话的。 */
  function reshuffle() {
    var on = [], off = [];
    for (var i = 0; i < pool.length; i++) (pool[i].status === 'online' ? on : off).push(i);
    function shuffle(a) {
      for (var j = a.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1)), t = a[j]; a[j] = a[k]; a[k] = t;
      }
      return a;
    }
    order = shuffle(on).concat(shuffle(off));
  }

  function capsuleOf(entry) {
    var P = root.TersePlazaField;
    if (!P || !P.toCapsule) return null;
    // toCapsule 认的是广场那一条的形状:{ capsule, title, topComments }。
    // 房间这条就是它少了社交计数,缺的字段那边全都做了存在性判断。
    return P.toCapsule({ capsule: entry.project.capsule, title: entry.project.title });
  }

  function play(wp, entry) {
    var cap = capsuleOf(entry);
    // 没有标题也没有封面 = 没有东西可看。跳过,而不是空放二十秒。
    if (!cap || (!cap.title && !cap.cover)) return false;
    try { wp.showProject(cap, PLAY_MS); } catch (e) { return false; }
    playing = entry;
    if (onPlay) { try { onPlay(entry); } catch (e) {} }
    return true;
  }

  function playNext(wp) {
    if (stopped || !wp || typeof wp.showProject !== 'function') return;
    if (!pool.length) return;
    if (!order.length) reshuffle();
    var entry = pool[order.shift()];
    if (!entry) { schedule(wp, 0); return; }
    if (!play(wp, entry)) { schedule(wp, 0); return; }
    schedule(wp, PLAY_MS + GAP_MS);
  }

  function schedule(wp, ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { playNext(wp); }, Math.max(200, ms));
  }

  /** 屋里有几个人有城可放。名册是"谁在屋里",这个数是"屋里有什么可看的"。 */
  function count() { return pool.length; }

  /** 正在放谁。没在放就是 null。 */
  function now() { return playing; }

  /**
   * 把名单取回来。进房间时取一次,名册变了再取一次 —— 有人刚进来,他的城
   * 应该跟着他一起到。
   * @returns {Promise<number>} 有城可放的人数
   */
  function load() {
    var s = st();
    if (!s || !s.id || !s.key) { pool = []; order = []; return Promise.resolve(0); }
    return fetch(API + '/' + s.id + '/projects', {
      headers: { Accept: 'application/json', 'x-terse-room-key': s.key },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        pool = (j && Array.isArray(j.projects)) ? j.projects : [];
        order = [];
        return pool.length;
      })
      .catch(function () { pool = []; order = []; return 0; });   // 取不到 = 屋里没有城,不是报错
  }

  /**
   * @param {object} wp     跑着的引擎
   * @param {object} [opts] { onPlay: fn(entry) } —— 换人时通知一声,屋里那行
   *        "现在是谁的城"靠它,而不是靠外面自己再算一遍时间。
   */
  function start(wp, opts) {
    stopped = false;
    onPlay = (opts && opts.onPlay) || null;
    return load().then(function (n) {
      if (stopped || !n) return n;
      playNext(wp);
      return n;
    });
  }

  /** 名册变了。已经在放的那座城**不打断** —— 有人进屋不该把正在看的东西掐掉;
   *  新名单在下一轮生效。 */
  function refresh(wp) {
    if (stopped) return Promise.resolve(0);
    return load().then(function (n) {
      if (!stopped && n && !timer) playNext(wp);
      return n;
    });
  }

  /** 直接放某一个人的城 —— 名册里点一下就是这个。放完照常接着轮。 */
  function playMember(wp, memberId) {
    if (!wp) return false;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].member_id !== memberId) continue;
      stopped = false;
      if (!play(wp, pool[i])) return false;
      schedule(wp, PLAY_MS + GAP_MS);
      return true;
    }
    return false;
  }

  /** 谁有城 —— 名册渲染时用,决定那一行点得动还是点不动。 */
  function has(memberId) {
    for (var i = 0; i < pool.length; i++) if (pool[i].member_id === memberId) return true;
    return false;
  }

  function stop(wp) {
    stopped = true;
    playing = null;
    clearTimeout(timer);
    timer = null;
    try { if (wp && wp.hideProject) wp.hideProject(); } catch (e) {}
  }

  /** 离开房间:连名单一起扔掉。留着的话,下一个房间会先闪一下上一个房间的人。 */
  function clear(wp) {
    stop(wp);
    pool = [];
    order = [];
  }

  root.TerseRoomField = {
    start: start, stop: stop, clear: clear, refresh: refresh,
    playMember: playMember, has: has, count: count, now: now,
    PLAY_MS: PLAY_MS,
  };
})(window);
