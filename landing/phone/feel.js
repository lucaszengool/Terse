/**
 * feel.js — how the app answers a finger.
 *
 * One file because these three things are the same decision made three ways:
 * how long a motion takes, how hard it pushes back, and whether the phone
 * buzzes. Scattered across call sites they drift, and an app whose transitions
 * disagree with each other reads as cheap however good each one is alone.
 *
 * ⚠ HAPTICS ON iOS SAFARI ARE NOT `navigator.vibrate`. WebKit does not
 * implement the Vibration API at all — every "haptics on iOS web" answer that
 * calls vibrate() is describing Android. What DOES fire the Taptic Engine from
 * a web page is a `<label>` bound to a `<select>`'s switch: Safari plays the
 * system selection tick when the picker opens. That trick is used here, kept
 * off-screen, and it is the only reason this works on an iPhone at all.
 *
 * It must therefore be treated as a bonus, never as a signal: it is silent when
 * the user has haptics off, silent in Low Power Mode, and silent on every
 * browser but Safari. Nothing in the app may depend on the buzz to be
 * understood — Apple's own guidance is that good haptics are felt, not noticed,
 * and never the only channel.
 */
(function (root) {
  'use strict';

  /* ── Motion ────────────────────────────────────────────────────────────────
     Two curves, not twelve. Everything that moves under a finger uses SNAP;
     everything that arrives or leaves on its own uses GLIDE. The numbers are
     spring-derived rather than eased so that an interrupted motion continues
     from where it was instead of jumping — which is what separates a native
     feel from a CSS transition. */
  var SNAP = 'cubic-bezier(.32,.72,0,1)';      // finger-driven: fast out, settles
  var GLIDE = 'cubic-bezier(.4,0,.2,1)';       // system-driven
  var D_FAST = 180, D_BASE = 280, D_SLOW = 420;

  /** Respect the setting, and mean it: reduced motion gets zero duration, not a
   *  shorter animation. A user who asked for no motion is often asking because
   *  motion makes them ill. */
  function reduced() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function ms(v) { return reduced() ? 0 : v; }

  /* ── Haptics ───────────────────────────────────────────────────────────── */

  var tapEl = null;
  function hapticNode() {
    if (tapEl) return tapEl;
    /* A real <select> with a <label>, off-screen. Safari plays the selection
       tick when a label bound to a switch-like control is activated. Built once
       and reused: creating it per tap is a layout thrash for a 10ms effect. */
    var wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
    wrap.innerHTML = '<label id="terse-hap-l" for="terse-hap-s"></label>' +
                     '<select id="terse-hap-s"><option>1</option><option>2</option></select>';
    document.body.appendChild(wrap);
    tapEl = wrap.querySelector('label');
    return tapEl;
  }

  var lastTap = 0;
  /**
   * A tick. `kind` is advisory — iOS web gives one texture, so this exists to
   * keep call sites honest about intent and to let the rate limit differ.
   *
   * Rate limited because a drag handler that ticks per frame turns the Taptic
   * Engine into a buzz, which is the single most common way haptics go from
   * "premium" to "broken phone".
   */
  function tap(kind) {
    if (reduced()) return;
    var now = Date.now();
    var gap = kind === 'drag' ? 90 : 30;
    if (now - lastTap < gap) return;
    lastTap = now;
    try { hapticNode().click(); } catch (e) { /* never let feedback throw */ }
    // Android and desktop Chrome do have the Vibration API; use it where real.
    try {
      if (root.navigator && typeof root.navigator.vibrate === 'function') {
        root.navigator.vibrate(kind === 'heavy' ? 18 : kind === 'drag' ? 4 : 8);
      }
    } catch (e) { /* ignore */ }
  }

  /* ── Gestures ──────────────────────────────────────────────────────────────
     One recogniser, because the field needs drag AND pinch AND double-tap on
     the same surface, and three independent listeners fight over the same
     touches — the bug being that a second finger landing mid-drag is a pinch,
     not a jump. */

  /**
   * @param {Element} el
   * @param {{onStart?:Function, onMove?:Function, onEnd?:Function,
   *          onPinch?:Function, onDouble?:Function}} h
   */
  function gestures(el, h) {
    if (!el) return function () {};
    var pts = {};                 // pointerId -> {x, y}
    var pinch0 = 0, lastTapAt = 0, moved = 0;

    function list() { return Object.keys(pts).map(function (k) { return pts[k]; }); }
    function spread() {
      var p = list();
      if (p.length < 2) return 0;
      return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    }

    function down(e) {
      // Ignore anything that started on a control: the field is the background,
      // and swallowing taps meant for a button is how a gesture layer breaks an
      // app rather than improving it.
      if (e.target.closest && e.target.closest('button,a,input,label,select,textarea')) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(pts).length === 1) {
        moved = 0;
        if (h.onStart) h.onStart(e);
      } else {
        pinch0 = spread();
      }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    function move(e) {
      var p = pts[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      var n = Object.keys(pts).length;
      if (n >= 2) {
        var s = spread();
        if (pinch0 && s && h.onPinch) h.onPinch(s / pinch0, e);
        pinch0 = s;
      } else if (h.onMove) {
        h.onMove(dx, dy, e);
      }
      // Only once the gesture is real: preventing default on every touch kills
      // scrolling everywhere else on the page.
      if (moved > 8 && e.cancelable) e.preventDefault();
    }

    function up(e) {
      delete pts[e.pointerId];
      if (Object.keys(pts).length < 2) pinch0 = 0;
      if (Object.keys(pts).length) return;
      if (moved < 10) {
        var now = Date.now();
        if (now - lastTapAt < 300 && h.onDouble) { h.onDouble(e); lastTapAt = 0; }
        else lastTapAt = now;
      }
      if (h.onEnd) h.onEnd(e);
    }

    el.addEventListener('pointerdown', down, { passive: true });
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up, { passive: true });
    el.addEventListener('pointercancel', up, { passive: true });

    return function off() {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }

  /** Inertia, so letting go of the field does not stop it dead. Returns a
   *  cancel function; the caller owns the loop's effect. */
  function glide(vx, vy, step) {
    var raf = 0, x = vx, y = vy;
    function frame() {
      x *= 0.94; y *= 0.94;
      if (Math.abs(x) < 0.02 && Math.abs(y) < 0.02) return;
      step(x, y);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return function () { cancelAnimationFrame(raf); };
  }

  root.TerseFeel = {
    SNAP: SNAP, GLIDE: GLIDE,
    D_FAST: D_FAST, D_BASE: D_BASE, D_SLOW: D_SLOW,
    ms: ms, reduced: reduced,
    tap: tap, gestures: gestures, glide: glide,
  };
})(window);
