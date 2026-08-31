/**
 * diag.js — why the field is not drawing.
 *
 * THE FAILURE THIS EXISTS FOR. A blank wallpaper on a phone has at least four
 * causes that look identical from the outside, and only one of them throws:
 *
 *   1. the engine module never loaded          → import() rejects
 *   2. WebGL is unavailable or the context died → constructor throws
 *   3. a SHADER FAILED TO COMPILE               → throws NOTHING. three.js logs
 *      to the console, the material silently draws nothing, and the canvas stays
 *      black. This is the common one on iOS, whose GLSL compiler is stricter
 *      than the desktop drivers everything gets developed against.
 *   4. everything works and the field is simply idle and dark
 *
 * The first version of this app caught (1) and (2) into an empty handler and had
 * no idea about (3) at all, so every one of them presented as "nothing happens"
 * with nothing to go on. That is what this fixes: console output is captured
 * across engine start-up, the renderer is asked whether it has actually drawn a
 * frame, and the answer is put on screen instead of in a log nobody can reach on
 * a phone.
 *
 * It is diagnostic only — it renders nothing itself and changes no behaviour.
 */
(function (root) {
  'use strict';

  var lines = [];
  var captured = [];
  var hooked = null;

  function note(k, v) { lines.push([k, String(v)]); }

  /** Take over console.error/warn for the length of engine start-up. three.js
   *  reports shader compile failures there and nowhere else — they are not
   *  exceptions, so there is nothing to catch. */
  function startCapture() {
    if (hooked) return;
    hooked = { error: console.error, warn: console.warn };
    ['error', 'warn'].forEach(function (level) {
      console[level] = function () {
        try {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            parts.push(typeof a === 'string' ? a : (a && a.message) ? a.message : String(a));
          }
          var text = parts.join(' ');
          // Shader logs are enormous — the whole program source is dumped. The
          // first lines carry the actual error; the rest is the listing.
          if (text.length > 600) text = text.slice(0, 600) + ' …';
          if (captured.length < 12) captured.push(level + ': ' + text);
        } catch (e) { /* never let logging break start-up */ }
        return hooked[level].apply(console, arguments);
      };
    });
  }

  function stopCapture() {
    if (!hooked) return;
    console.error = hooked.error;
    console.warn = hooked.warn;
    hooked = null;
  }

  /** What this device can actually do, asked directly rather than assumed. */
  function probe() {
    lines = [];
    note('ua', navigator.userAgent);
    note('display', root.matchMedia && root.matchMedia('(display-mode: standalone)').matches
      ? 'standalone (installed)' : 'browser tab');
    note('dpr', root.devicePixelRatio || 1);
    note('screen', (root.screen ? root.screen.width + 'x' + root.screen.height : '?')
      + ' · viewport ' + root.innerWidth + 'x' + root.innerHeight);
    // Import maps are what resolve the bare 'three' specifier the engine imports.
    // Without them the module fails to instantiate and nothing else matters.
    note('importmap', (HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')) ? 'yes' : 'NO');
    note('dynamic import', typeof root.__terseDynImport === 'undefined' ? 'untested' : root.__terseDynImport);

    var probeCanvas = document.createElement('canvas');
    var gl = null, which = 'none';
    try {
      gl = probeCanvas.getContext('webgl2');
      if (gl) which = 'webgl2';
      else { gl = probeCanvas.getContext('webgl') || probeCanvas.getContext('experimental-webgl'); if (gl) which = 'webgl1'; }
    } catch (e) { which = 'threw: ' + e.message; }
    note('webgl', which);

    if (gl) {
      try {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        note('gpu', dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(hidden)');
      } catch (e) { note('gpu', 'unavailable'); }
      note('max texture', gl.getParameter(gl.MAX_TEXTURE_SIZE));
      // The ripple texture is sampled in the VERTEX shader. A device reporting 0
      // here cannot run the field at all, and it is the kind of limit that
      // differs between desktop and phone.
      note('vertex tex units', gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS));
      note('float tex', (which === 'webgl2' || gl.getExtension('OES_texture_float')) ? 'yes' : 'NO');
      var hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      note('frag highp', hp && hp.precision > 0 ? 'yes' : 'NO');
    }
    return lines;
  }

  /**
   * Ask the engine whether it has actually put pixels on the screen.
   * three.js counts every frame it renders, so a count still at zero a couple of
   * seconds after start() means the loop is not running or every draw is being
   * discarded — which is exactly what a failed shader looks like.
   */
  function watchFrames(wp, afterMs) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var n = null;
        try { n = wp && wp.renderer && wp.renderer.info && wp.renderer.info.render.frame; } catch (e) {}
        resolve(n);
      }, afterMs || 2500);
    });
  }

  function report() {
    var out = probe().map(function (p) { return p[0] + ': ' + p[1]; });
    if (captured.length) out.push('', '— console during start-up —');
    return out.concat(captured).join('\n');
  }

  root.TerseDiag = {
    startCapture: startCapture,
    stopCapture: stopCapture,
    probe: probe,
    watchFrames: watchFrames,
    report: report,
    note: note,
    captured: function () { return captured.slice(); },
    push: function (msg) { if (captured.length < 12) captured.push(msg); },
  };
})(window);
