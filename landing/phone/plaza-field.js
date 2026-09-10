/**
 * plaza-field.js — other people's projects, playing in the field.
 *
 * The app opens as a black room with particles in it, and before anything is
 * linked those particles have only the visitor to talk about. This gives them
 * something worth watching: the projects other people have published, gathering
 * out of the field one at a time.
 *
 * ⚠ THE COVER IS PARTICLES, NOT A PICTURE. The capsule carries a small JPEG and
 * a few lines; the engine samples that image on THIS device and gives every
 * particle the colour of its pixel, so the thumbnail is made of the same stuff
 * as everything else on screen — and it turns when the 3D view turns. Pasting
 * the texture would be easier and would look like a photo stuck on a wallpaper.
 * The server never renders: it stores the capsule and hands it over.
 *
 * ⚠ AND IT ONLY RUNS WHEN NOTHING IS LINKED. Once a machine is paired the field
 * belongs to that person's agents; strangers' projects drifting through would
 * be showing somebody else's work over their own live numbers.
 */
(function (root) {
  'use strict';

  /** How long one project holds the field. Matches the desktop's plaza preview
   *  so the two do not disagree about what "a preview" is. */
  var PLAY_MS = 20000;
  /** And the gap after it scatters, so the field is its own thing in between
   *  rather than a slideshow with no pauses. */
  var GAP_MS = 9000;
  /** Fetched once per session. The plaza changes over hours, not seconds, and
   *  re-fetching on every cycle would be a request per twenty seconds per
   *  visitor for a list that is almost always identical. */
  var FEED = '/api/cloud/projects/public?limit=24';

  var pool = [];
  var order = [];
  var timer = null;
  var stopped = false;

  /** Shuffled once, then walked — not random per pick. Random repeats, and a
   *  visitor who sees the same project twice in a row assumes it is the only
   *  one there is. */
  function reshuffle() {
    order = pool.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }

  /** The capsule, in the shape the engine's showProject() wants.
   *
   *  ⚠ THE FIELD NAMES WERE NOT WHAT I ASSUMED, and real data said so on the
   *  first call: `comments` is a COUNT, not a list — the list is `topComments`
   *  — and the capsule already carries its own `lines`, because the desktop
   *  builds them when it publishes. Synthesising lines here would have been a
   *  second, worse copy of that.
   *
   *  Nothing extra is fetched: the list brings the capsule, the top comments
   *  and the counts down together, on the same reasoning the API states for
   *  itself — a preview should cost zero further round trips. */
  /* 城市图例的词。⚠ 翻译不在这儿做,也不在渲染器里做 —— 渲染器是 Mac 和手机共用的,
     两边各有各的 i18n。app.js 启动时把翻好的一份交过来,`toCapsule` 挂上去,于是
     **每一条**通往 showProject 的路都带着它:广场里刷到的、点开的、以及场自己在
     轮播的那一条。漏掉任何一条,图例就会在某个入口神秘消失 —— 而那正是这个文件
     顶上那句"新字段必须在这里加一遍"说的事。 */
  var WORDS = null;
  function setWords(w) { WORDS = w || null; }

  function toCapsule(p) {
    var c = (p && p.capsule) || {};
    var lines = [];

    // What the author wrote, as the desktop composed it.
    if (Array.isArray(c.lines)) {
      c.lines.forEach(function (l) {
        var s = String(l == null ? '' : l).replace(/\s+/g, ' ').trim();
        if (s) lines.push(s);
      });
    }
    // Then what people said about it — the plaza's own voice, and the reason
    // somebody else's project is worth looking at at all.
    if (lines.length < 3 && Array.isArray(p.topComments)) {
      p.topComments.forEach(function (m) {
        if (lines.length >= 3) return;
        var body = String((m && (m.body || m.text)) || '').replace(/\s+/g, ' ').trim();
        if (body) lines.push(body);
      });
    }
    if (!lines.length && Array.isArray(c.tags) && c.tags.length) lines.push(c.tags.join(' · '));

    /* ⚠ EVERYTHING THE ENGINE CAN DRAW HAS TO COME THROUGH HERE. This used to
       return four fields — title, subtitle, cover, lines — and the code city
       died right at this line even when the server sent it. A capsule is
       PARAMETERS, and dropping them here is dropping the picture.

       The comments are handed over as objects rather than folded into `lines`:
       the engine pages them three at a time and draws the speaker's name with
       each one, which it cannot do with a flattened string. `lines` keeps its
       fallback copies for the ambient rotation, where three lines is the whole
       show. */
    return {
      title: c.title || p.title || '',
      subtitle: c.subtitle || '',
      desc: c.desc || '',
      /* ⚠ 新字段必须在这里加一遍,否则引擎永远看不到它 —— 这个函数是胶囊进入
         渲染那一端的**唯一**入口,代码城市当初就是死在这一行没加上。
         kind 缺省算 project:这个字段出现之前发布的每一颗都是项目。 */
      kind: c.kind || 'project',
      frames: Array.isArray(c.frames) ? c.frames : [],
      fps: c.fps || 12,
      tune: c.tune || '',
      link: c.link || '',
      // 它在干什么 —— 城市说的是"由什么组成",这两样说的是"做什么"。
      words: WORDS,
      flow: c.flow || null,
      verbs: Array.isArray(c.verbs) ? c.verbs : [],
      key: c.key || 0,
      cover: c.cover || '',
      lines: lines.slice(0, 3),
      shots: Array.isArray(c.shots) ? c.shots : [],
      langs: Array.isArray(c.langs) ? c.langs : [],
      files: c.files || 0,
      // 代码城市 —— 数字,不是画面。城市在看的人自己的机器上摆出来。
      dirs: Array.isArray(c.dirs) ? c.dirs : [],
      style: c.style || '',
      links: Array.isArray(c.links) ? c.links : [],
      commits: Array.isArray(c.commits) ? c.commits : [],
      graph: c.graph || null,
      hot: Array.isArray(c.hot) ? c.hot : [],
      people: Array.isArray(c.people) ? c.people : [],
      comments: Array.isArray(p.topComments) ? p.topComments : [],
    };
  }

  function playNext(wp) {
    if (stopped || !wp || typeof wp.showProject !== 'function') return;
    if (!pool.length) return;
    if (!order.length) reshuffle();
    var p = pool[order.shift()];
    var cap = toCapsule(p);
    // A capsule with no title and no cover has nothing to show; skip rather
    // than play twenty seconds of nothing.
    if (!cap.title && !cap.cover) { schedule(wp, 0); return; }
    try { wp.showProject(cap, PLAY_MS); } catch (e) { /* never break the field */ }
    schedule(wp, PLAY_MS + GAP_MS);
  }

  function schedule(wp, ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { playNext(wp); }, Math.max(200, ms));
  }

  /**
   * @param {object} wp   the running engine
   * @param {function():boolean} isFree  true while nothing is linked — asked
   *        again every cycle, because pairing can happen mid-session and the
   *        field must hand itself back the moment it does.
   */
  function start(wp, isFree) {
    stopped = false;
    fetch(FEED, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        pool = (j && Array.isArray(j.projects)) ? j.projects : [];
        if (!pool.length) return;
        reshuffle();
        (function tick() {
          if (stopped) return;
          if (isFree && !isFree()) {
            // Paired mid-session: stand down, and stop asking.
            stop(wp);
            return;
          }
          playNext(wp);
        })();
      })
      .catch(function () { /* no plaza, no preview — the field is fine alone */ });
  }

  function stop(wp) {
    stopped = true;
    clearTimeout(timer);
    try { if (wp && wp.hideProject) wp.hideProject(); } catch (e) {}
  }

  root.TersePlazaField = { start: start, stop: stop, toCapsule: toCapsule, setWords: setWords, PLAY_MS: PLAY_MS };
})(window);
