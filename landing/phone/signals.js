/**
 * signals.js — what the field has to say before anything is linked.
 *
 * THE PROBLEM. The field is driven by agent activity, and before you sign in
 * and pair a machine there is none — so the first thing a new visitor saw was
 * a nearly-still field with nothing written in it. That is the worst possible
 * first impression of a thing whose entire pitch is "your agents, alive".
 *
 * ⚠ AND THE PHONE CANNOT FILL THE GAP. Every "read the device" answer is
 * describing Chrome: navigator.getBattery, navigator.connection and
 * deviceMemory are Chrome-only and absent from iOS Safari, which is the browser
 * this app actually runs in. Measured, not assumed. What Safari does expose is
 * static — cores, screen, language, timezone, colour scheme — and static facts
 * cannot animate anything.
 *
 * SO THE VISITOR DRIVES IT. Touch, scroll and dwell are real, immediate, need
 * no permission, and exist on every browser. The field answers the person
 * looking at it until it has agents to answer instead. That is honest: it is
 * not pretending to know something about the phone that it cannot know.
 *
 * Everything here is progressive. A capability that exists is used; one that
 * does not is skipped, never faked.
 */
(function (root) {
  'use strict';

  var started = Date.now();
  var touches = 0;          // deliberate interactions
  var motion = 0;           // accumulated pointer travel, decaying
  var lastMove = 0;

  /* Decay, so the field settles when the person stops. Without this the first
     scroll would pin it at full energy for the rest of the session. */
  function energy() {
    var idleMs = Date.now() - lastMove;
    var decay = Math.exp(-idleMs / 4200);
    return Math.max(0, Math.min(1, motion / 2600)) * decay;
  }

  function bind() {
    var seen = {};
    function moved(dx, dy) {
      motion = Math.min(4000, motion + Math.abs(dx) + Math.abs(dy));
      lastMove = Date.now();
    }
    root.addEventListener('pointermove', function (e) {
      var p = seen[e.pointerId];
      if (p) moved(e.clientX - p.x, e.clientY - p.y);
      seen[e.pointerId] = { x: e.clientX, y: e.clientY };
    }, { passive: true });
    root.addEventListener('pointerdown', function (e) {
      touches++; lastMove = Date.now();
      seen[e.pointerId] = { x: e.clientX, y: e.clientY };
    }, { passive: true });
    root.addEventListener('pointerup', function (e) { delete seen[e.pointerId]; }, { passive: true });
    // Scrolling is interaction too, and on a phone it is most of it.
    root.addEventListener('scroll', function () { moved(0, 26); }, { passive: true, capture: true });
  }

  /** Static facts, each behind a check. Absent capabilities are omitted rather
   *  than reported as zero — a "0 GB" reads as broken, a missing line reads as
   *  nothing at all, which is the truth. */
  function facts(tr) {
    var t = tr || function (_k, fb) { return fb; };
    var out = [];
    /* Labels stay SHORT on purpose. The engine only draws a metric's name when
       name and value together fit inside twenty characters — past that the
       glyph renders small and stretched — so "screen" earns its place and
       "screen resolution" would silently lose the label it came for. */
    try {
      var w = (root.screen && root.screen.width) || 0;
      var h = (root.screen && root.screen.height) || 0;
      var dpr = Math.round(root.devicePixelRatio || 1);
      if (w && h) out.push({ k: t('sig_screen', 'screen'), v: (w * dpr) + '×' + (h * dpr), u: '' });
    } catch (e) { /* ignore */ }

    var cores = navigator.hardwareConcurrency;
    if (cores) out.push({ k: t('sig_cores', 'cores'), v: String(cores), u: '' });

    // Every one of these is checked, never assumed: the ones Chrome has and
    // Safari does not simply do not appear on an iPhone.
    if (typeof navigator.deviceMemory === 'number') {
      out.push({ k: t('sig_memory', 'memory'), v: String(navigator.deviceMemory), u: 'GB' });
    }
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Just the city — "Asia/Shanghai" does not fit and the region adds nothing.
      if (tz && tz.indexOf('/') > 0) out.push({ k: t('sig_zone', 'zone'), v: tz.split('/').pop().replace(/_/g, ' '), u: '' });
    } catch (e) { /* ignore */ }

    var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
    out.push({ k: t('sig_day', 'day'), v: t('sig_day_' + day.toLowerCase(), day), u: '' });

    // Real and free: how long this page has been rendering, which is the one
    // number that is genuinely about the field itself.
    try {
      var up = Math.round(performance.now() / 1000);
      if (up > 3) out.push({ k: t('sig_open', 'open'), v: up < 90 ? up + 's' : Math.round(up / 60) + 'm', u: '' });
    } catch (e) { /* ignore */ }

    if (root.matchMedia) {
      if (root.matchMedia('(display-mode: standalone)').matches) {
        out.push({ k: 'Terse', v: t('sig_installed', 'installed'), u: '' });
      }
    }
    return out;
  }

  /** The hour, as a number the field can spell. Not a fact about the phone —
   *  a fact about now, which is the one thing always true and always changing. */
  function clock() {
    var d = new Date();
    return { k: 'now', v: String(d.getHours()).padStart(2, '0') + ':'
      + String(d.getMinutes()).padStart(2, '0'), u: '' };
  }

  /**
   * Overlays in the exact shape buildOverlays() produces, so the field cannot
   * tell the difference between this and a real snapshot — and neither engine
   * nor capture needs a branch for "not signed in yet".
   */
  function overlays(t) {
    var tr = t || function (_k, fb) { return fb; };
    var e = energy();
    var mins = Math.floor((Date.now() - started) / 60000);
    var stage = [clock()];
    facts(tr).forEach(function (f) { stage.push(f); });
    if (touches) stage.push({ k: tr('sig_touch', 'touches'), v: String(touches), u: '' });
    if (mins) stage.push({ k: tr('sig_here', 'here'), v: String(mins), u: 'min' });
    return {
      /* A floor, so the field is never dead on arrival, and a ceiling below
         full so a real linked machine still visibly outranks a visitor waving
         at the screen. */
      activity: Math.max(0.42, Math.min(0.85, 0.42 + e * 0.43)),
      agents: [],
      stage: stage,
      logGroups: [],
    };
  }

  bind();

  root.TerseSignals = {
    overlays: overlays,
    energy: energy,
    facts: facts,
    /** Whether there is anything worth showing at all. Always true — the clock
     *  alone qualifies — but stated so callers read as intent, not habit. */
    any: function () { return true; },
  };
})(window);
