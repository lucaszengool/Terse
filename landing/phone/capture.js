/**
 * capture.js — taking a still of the REAL particle field, at wallpaper size, so
 * it can become the iPhone's actual Home Screen wallpaper.
 *
 * WHY THE PHONE DOES THIS AND NOT THE SERVER. What has to land on the Home
 * Screen is *this user's* field: their style, their photo, their Pro
 * entitlement, their agents' names in the glyph text. Re-drawing that on a
 * server means a second implementation of a WebGL scene that would drift from
 * the engine within a release, rendered without any of those settings. The
 * device that already renders it correctly is the phone.
 *
 * THE READBACK TRICK. A WebGL canvas is unreadable after compositing unless its
 * context was created with `preserveDrawingBuffer`, and the engine creates its
 * own renderer without it. But `getContext` returns the EXISTING context and
 * ignores the attributes when one is already present — so creating the context
 * first, with the flag, and then handing the canvas to the engine gives a
 * readable buffer without touching the engine at all.
 *
 * WHY IT CAPTURES SEVERAL FRAMES. The glyph text — the whole point — is a timed
 * animation: it assembles, holds, then scatters. Grabbing one frame at a fixed
 * delay lands on an empty field about as often as not. So it samples across the
 * hold window and keeps the busiest frame, measured rather than guessed.
 */
(function (root) {
  'use strict';

  /* Match the panel, capped. iOS scales anything bigger down anyway, and past
     roughly this size a phone GPU starts failing the capture outright rather
     than returning a smaller image. */
  /* THE ENGINE NEEDS THE BUILD STAMP TOO.
     The phone scripts are stamped and the engines deliberately were not — and
     that decision means an engine fix does not reach anybody. Cloudflare
     caches by file extension and overrides our headers: measured on a
     .js served with max-age=300, the edge answered HIT at age 387 with the old
     file, so a fix that shipped was invisible until the edge felt like it. The
     stamp changes with the content, so a fixed engine is a URL the edge has
     never seen. Same mechanism the phone scripts already use. */
  function engineUrl(o) {
    if (o && o.engineUrl) return o.engineUrl;
    var b = root.__TERSE_BUILD;
    return '/app-assets/mineradio-wallpaper.js' + (b ? '?v=' + encodeURIComponent(b) : '');
  }

  function targetSize() {
    var dpr = Math.min(root.devicePixelRatio || 1, 3);
    var w = Math.round((root.screen && root.screen.width ? root.screen.width : 390) * dpr);
    var h = Math.round((root.screen && root.screen.height ? root.screen.height : 844) * dpr);
    var cap = 3200;
    if (Math.max(w, h) > cap) {
      var k = cap / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    return { w: w, h: h };
  }

  /** The grid density to capture at.
   *
   *  Mirrors app.js's live tier off the CSS box, plus a small bump: a still is
   *  looked at all day and can carry a little more than a field that has to
   *  hold 60fps. Phones land at 34-46, desktops at 56 — the old constant. */
  function captureQuality(w, h) {
    var px = Math.min(root.devicePixelRatio || 1, 2);
    var area = w * h * px * px;
    if (area > 3.2e6) return 38;
    if (area > 2.2e6) return 42;
    if (area > 1.0e6) return 46;
    return 56;
  }

  /** How much is going on in a frame. Mean luminance over a coarse grid: an
   *  empty field is nearly black, a frame mid-glyph is not. Cheap enough to run
   *  on every candidate. */
  function liveliness(canvas) {
    var s = 96;
    var probe = document.createElement('canvas');
    probe.width = s; probe.height = s;
    var ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, s, s);
    var d = ctx.getImageData(0, 0, s, s).data;
    var sum = 0;
    for (var i = 0; i < d.length; i += 4) {
      sum += (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) * (d[i + 3] / 255);
    }
    return sum / (s * s);
  }

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* A frame boundary, but never a wait that cannot end.
     requestAnimationFrame does not fire at all while the page is hidden, so a
     bare `await raf()` hangs forever the moment someone switches apps
     mid-capture — the button sticks on "Rendering…" and never comes back.
     The timeout is the escape hatch; `stalled` tells the caller to give up
     rather than capture a frame the engine never drew. */
  function raf(limitMs) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ stalled: true }); } }, limitMs || 400);
      requestAnimationFrame(function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve({ stalled: false });
      });
    });
  }

  var visible = function () { return document.visibilityState === 'visible'; };

  /* The backdrop the particles take their colour from — and, for a still, the
     thing actually painted behind them.

     On the Mac this is the user's real desktop picture, showing through a
     transparent window. A phone has none, so Terse ships its own (beds.js) and
     the user picks one; a photo of their own overrides it. Either way the engine
     is handed the same image it is composited over, so the particle colours
     match what is behind them. */
  function bedImage(o, w, h) {
    if (o && o.photo) return o.photo;
    if (root.TerseBeds) return root.TerseBeds.render((o && o.bedId) || root.TerseBeds.DEFAULT_ID, w, h);
    return null;
  }

  /**
   * Render and capture. Returns a PNG Blob.
   *
   *   opts.engineUrl  module to import for the engine
   *   opts.style      style id, opts.pro   entitlement
   *   opts.overlays   { activity, agents, stage, logGroups } from wallpaper-hud
   *   opts.bedId      which shipped backdrop to use (beds.js); opts.photo wins
   *   opts.transparent  return the field alone, with alpha, for Overlay Images
   *   opts.count      how many distinct frames to bring back (1..8)
   *   opts.texts      one glyph line per frame, cycled
   *   opts.onStep     progress callback (0..1, label)
   *
   * Returns { blobs[], blob, width, height, score }.
   */
  async function capture(opts) {
    var o = opts || {};
    var step = o.onStep || function () {};

    /* Refused rather than attempted while hidden. This is not defensiveness
       about the timing above — a hidden page's engine is not rendering either,
       so the only thing there is to capture is the black it was left on. */
    if (!visible()) {
      var e = new Error('hidden');
      e.code = 'hidden';
      throw e;
    }

    var size = targetSize();

    /* THE CSS BOX IS THE SCREEN, NOT THE WALLPAPER.
       The field is drawn from point sprites whose size is set in PIXELS, so it
       does not scale with the drawing buffer: render the same scene into a
       buffer three times wider and every particle covers a ninth of the frame
       it used to. Measured on the live engine, mean luminance falls from
       0.0067 at a 393x852 box to 0.00095 at 1290x2796 — a seven-fold drop, and
       that is the whole difference between the field somebody sees in the app
       and the near-empty picture that used to come out of here.

       So the engine is given the same CSS box it has when it is on screen, and
       renders at the same resolution it renders at live. compose() scales the
       result up to the wallpaper size, which is what iOS would do to it in any
       case. */
    var cssW = Math.max(16, (root.screen && root.screen.width) || 390);
    var cssH = Math.max(16, (root.screen && root.screen.height) || 844);
    if ((size.w > size.h) !== (cssW > cssH)) { var sw = cssW; cssW = cssH; cssH = sw; }

    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    // Off-screen but LAID OUT: the engine measures clientWidth/clientHeight and
    // falls back to the window size when they are zero, so a `display:none`
    // canvas would silently render at the wrong aspect ratio.
    canvas.style.cssText = 'position:fixed;left:-99999px;top:0;width:' +
      cssW + 'px;height:' + cssH + 'px;pointer-events:none';
    document.body.appendChild(canvas);

    // Must happen BEFORE the engine attaches — see the header.
    canvas.getContext('webgl2', {
      preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: true, antialias: false,
    }) || canvas.getContext('webgl', {
      preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: true, antialias: false,
    });

    var wp = null;
    try {
      step(0.1, 'engine');
      var mod = await import(engineUrl(o));
      var Engine = mod.default;

      /* Quality follows the LIVE tier rather than sitting above it.
         The old flat 56 was chosen when this rendered into a full-resolution
         wallpaper buffer, where a denser grid was the only way to fill the
         frame. It now renders at the live buffer size and is scaled up in
         compose(), so 56 buys roughly double the grid rows of the field the
         phone already draws — for detail that the upscale throws away, at
         twice the GPU cost, on the one code path where being slow is not
         merely unpleasant: a capture that overruns gets its page backgrounded
         and dies with `hidden`, losing the whole run. */
      wp = new Engine(canvas, {
        theme: o.theme || 'neon',
        quality: o.quality || captureQuality(cssW, cssH),
        angle: 42,
        // A still is looked at all day and never animates, so it can carry more
        // than the live field does without costing anything.
        intensity: 1.15,
        style: o.style || 'cinematic',
        pro: !!o.pro,
        // Not a live field: see _paced in the engine.
        capture: true,
        // Explicit, so the engine never falls through to getDesktopPicture() —
        // which on a phone answers with the user's chosen photo or nothing.
        photo: bedImage(o, size.w, size.h),
      });
      /* The engine sizes its OWN drawing buffer: it measures the canvas's CSS box
         and multiplies by min(1.5, devicePixelRatio). So canvas.width is
         overwritten, and the field ends up filling only part of the bitmap —
         about three quarters of the width on a 2x phone, with the rest left
         black. Pinning the ratio to 1 and re-setting the size makes the buffer
         exactly the wallpaper we asked for.

         The CSS box is set to the full pixel size for the same reason: resize()
         re-measures it, so a half-size box would undo this on the first
         ResizeObserver tick. */
      /* Left to size itself. It measures the CSS box above and multiplies by
         min(1.5, devicePixelRatio) — the same buffer it uses live, which is the
         point. Forcing the buffer to the full wallpaper resolution here is what
         made the field vanish. */
      wp.start();

      // Feed it the same overlays the live field gets, so the capture contains
      // the real glyph text and not a blank field with nothing to say.
      var ov = o.overlays || {};
      /* A FLOOR, because a still is not a live field.
         activity is how hard the field dances, and it is derived from real
         burn rate — an account with nothing running lands at 0.08. The live
         wallpaper SHOULD go quiet then: it is on screen, and calm is honest.
         A capture is not. It is looked at all day, and at 0.08 the field never
         gathers enough to form the glyph text at all — measured on an iPhone,
         0.08 gave sparse dots and no text, 0.9 gave the numbers. So a captured
         frame is asked to dance whatever the account is doing; what it SAYS is
         still the real numbers. */
      if (wp.setActivity) wp.setActivity(Math.max(0.55, typeof ov.activity === 'number' ? ov.activity : 0.35));
      if (wp.setAgents && ov.agents) wp.setAgents(ov.agents);
      if (wp.setAgentLog && ov.logGroups && ov.logGroups.length) wp.setAgentLog(ov.logGroups);

      step(0.25, 'settling');
      // The photo bed and the edge/depth maps load asynchronously; capturing
      // before they land gives a field with no colour in it.
      await wait(900);

      // Ask for a glyph, then sample across its hold window. setStageItems
      // rate-limits itself to one glyph every 12 seconds, so this is the one
      // request that matters and its timing is what the sampling is aligned to.
      if (wp.setStageItems && ov.stage && ov.stage.length) wp.setStageItems(ov.stage);

      /* The bed has to be PAINTED, not just sampled.
         On the Mac the wallpaper window is transparent and the real desktop
         picture shows through it — the engine only reads the image to colour its
         particles, it never draws it. A capture of the canvas alone is therefore
         particles on nothing, which is why the first version came out almost
         black. Compositing the bed underneath here is what the transparent
         window does on the desktop. */
      var bed = await new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = bedImage(o, size.w, size.h);
      });

      function compose(src) {
        var out = document.createElement('canvas');
        out.width = size.w; out.height = size.h;
        var x = out.getContext('2d');

        /* TRANSPARENT MODE — the layer that goes on the user's OWN wallpaper.
           iOS exposes no way to read the wallpaper somebody already has, but
           Shortcuts' Overlay Images action can lay this on top of a photo they
           pick. So this returns the field alone, on nothing: the engine already
           renders with alpha, and drawImage from its canvas preserves it.

           The bed is still LOADED (it tints the particles, and the tint should
           match whatever this ends up sitting on) — it is simply not painted. */
        if (o.transparent) {
          x.drawImage(src, 0, 0, size.w, size.h);
          return out;
        }

        x.fillStyle = '#05060a';
        x.fillRect(0, 0, size.w, size.h);
        if (bed) {
          // Cover, not stretch: a portrait wallpaper from a landscape photo must
          // crop rather than distort.
          var k = Math.max(size.w / bed.width, size.h / bed.height);
          var dw = bed.width * k, dh = bed.height * k;
          x.drawImage(bed, (size.w - dw) / 2, (size.h - dh) / 2, dw, dh);
          // Held back so the particles and the glyph stay the subject, and so
          // Home Screen icons and their labels stay readable on top.
          x.fillStyle = 'rgba(5,6,10,0.42)';
          x.fillRect(0, 0, size.w, size.h);
        }
        x.drawImage(src, 0, 0, size.w, size.h);
        return out;
      }

      /* One engine spin-up, several frames.
         Capturing N times would mean N cold starts — the photo bed, the edge and
         depth maps and the geometry rebuilt each time, for the better part of a
         minute. Sampling one running field is both faster and more honest: these
         really are different moments of the same wallpaper.

         Each frame gets its OWN glyph text, which is what makes an album of them
         worth shuffling. setStageItems throttles itself to one glyph per twelve
         seconds, so it is used once, for the first; setAgentLog carries the rest,
         since it only suppresses a line it is already showing. */
      var lines = (o.texts && o.texts.length) ? o.texts : [null];
      var want = Math.max(1, Math.min(o.count || 1, 12));
      var frames = [];

      for (var f = 0; f < want; f++) {
        if (f === 0) {
          if (wp.setStageItems && ov.stage && ov.stage.length) wp.setStageItems(ov.stage);
        } else if (wp.setAgentLog) {
          var line = lines[f % lines.length];
          if (line) wp.setAgentLog([{ name: '', icon: '', lines: [{ label: line }] }]);
        }

        // Sample across the glyph's hold window and keep the liveliest moment.
        // A fixed delay lands on an empty field about as often as not.
        var best = null, bestScore = -1;
        var offsets = [650, 1000, 1350, 1700];
        var prev = 0;
        for (var i = 0; i < offsets.length; i++) {
          await wait(offsets[i] - prev);
          prev = offsets[i];
          var tick = await raf(400);
          // Backgrounded mid-capture. Keep whatever is already good and stop —
          // but never hand back nothing without saying why.
          /* STALLED IS NOT HIDDEN, and conflating them told people to do the
             one thing that cannot help. raf() gives up after 400ms, which a
             slow phone exceeds all by itself — so a device that was merely
             struggling was reported as "keep Terse on screen while it
             captures", with the page in front the whole time.
             Only an actually backgrounded page is fatal; a slow one just
             samples a moment later than asked. */
          if (!visible()) {
            if (!frames.length && !best) { var h = new Error('hidden'); h.code = 'hidden'; throw h; }
            f = want; break;
          }
          var score = liveliness(canvas);
          if (score > bestScore) {
            bestScore = score;
            // Composed immediately: the next frame overwrites the buffer, and a
            // reference to the live canvas would capture whatever is there at
            // the end rather than the moment that actually scored best.
            best = { canvas: compose(canvas), score: score };
          }
        }
        if (best) frames.push(best);
        step(0.25 + 0.55 * ((f + 1) / want), 'frame ' + (f + 1) + '/' + want);
      }

      if (!frames.length) frames.push({ canvas: compose(canvas), score: 0 });

      step(0.85, 'encoding');
      var blobs = [];
      for (var b = 0; b < frames.length; b++) {
        blobs.push(await new Promise(function (resolve) {
          /* JPEG, not PNG, and this is the difference between the feature
             working and not. Measured on a real 1290x2796 frame: 1.78 MB as
             PNG, 578 KB as JPEG at 0.92 — 3.1x. Twelve of them is 20.3 MB
             against 6.6 MB, and 20 MB uploaded serially from a phone is what
             left the button stuck on "12/12" with not a single frame landed.

             Nothing is lost: this is a wallpaper, it has no alpha to preserve,
             and at 0.92 the particles and the glyph text are indistinguishable.
             The transparent overlay stays PNG — it is the one output that
             genuinely needs an alpha channel. */
          frames[b].canvas.toBlob(function (x) { resolve(x); },
            o.transparent ? 'image/png' : 'image/jpeg', 0.92);
        }));
      }

      step(1, 'done');
      return {
        blobs: blobs,
        // The single-frame shape is kept so a caller that only wants one still
        // reads naturally.
        blob: blobs[0],
        width: size.w,
        height: size.h,
        score: frames[0] ? frames[0].score : 0,
        /* EVERY frame's score, not just the first.
           liveliness() has always been computed and then thrown away, and that
           is how a capture of nothing shipped: the bytes were fine, the upload
           was fine, the ring was fine, and every frame was an empty gradient.
           The caller cannot notice that without these. */
        scores: frames.map(function (f) { return f.score; }),
      };
    } finally {
      // Always: a leaked WebGL context is one of the few ways a phone browser
      // tab gets killed outright, and this runs on demand from a button.
      if (wp) { try { wp.dispose(); } catch (e) {} }
      try { canvas.remove(); } catch (e) {}
    }
  }

  /* ── Video, for a Live Photo ────────────────────────────────────────────────
     The still above lands on the Home Screen but does not move. A Live Photo
     DOES move — it plays on the Lock Screen when the phone wakes — and Shortcuts
     has a native "Make Live Photo" action that takes a video. So this records
     the real field to an .mp4, and the phone's own Shortcut turns it into the
     animated wallpaper.

     WebCodecs, not MediaRecorder. canvas.captureStream() + MediaRecorder is the
     obvious route and is broken on iOS Safari: the video track carries no valid
     data and the stop event often never fires, so the recording simply never
     ends. VideoEncoder has shipped in Safari since 16.4 and is fully supported
     as of Safari 26, and it hands back frames we drive ourselves rather than a
     stream we have to hope about. */

  function canEncodeVideo() {
    return typeof root.VideoEncoder === 'function' && typeof root.VideoFrame === 'function';
  }

  /** Live Photos are short by nature — iOS plays about 1.5s of one — and a
   *  4-second source is what "Make Live Photo" wants to work from. */
  var VIDEO_FPS = 24;
  var VIDEO_SECONDS = 4;

  async function captureVideo(opts) {
    var o = opts || {};
    var step = o.onStep || function () {};
    if (!canEncodeVideo()) {
      var u = new Error('no-webcodecs'); u.code = 'no-webcodecs'; throw u;
    }
    if (!visible()) { var e = new Error('hidden'); e.code = 'hidden'; throw e; }

    /* Encoded at half the still's resolution, capped. H.264 wants even
       dimensions, a phone encoding 1290x2796 in real time is asking for a
       dropped frame every few, and a Live Photo is displayed scaled anyway. */
    var full = targetSize();
    var scale = Math.min(1, 720 / Math.min(full.w, full.h));
    var size = {
      w: Math.round(full.w * scale / 2) * 2,
      h: Math.round(full.h * scale / 2) * 2,
    };

    var canvas = document.createElement('canvas');
    canvas.width = size.w; canvas.height = size.h;
    canvas.style.cssText = 'position:fixed;left:-99999px;top:0;width:' +
      size.w + 'px;height:' + size.h + 'px;pointer-events:none';
    document.body.appendChild(canvas);
    canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: true })
      || canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: true });

    var wp = null, encoder = null;
    try {
      step(0.05, 'engine');
      var mod = await import(engineUrl(o));
      wp = new mod.default(canvas, {
        theme: o.theme || 'neon', quality: 44, angle: 42, intensity: 1.15,
        style: o.style || 'cinematic', pro: !!o.pro,
        photo: bedImage(o, size.w, size.h),
      });
      if (wp.renderer) { wp.renderer.setPixelRatio(1); wp.renderer.setSize(size.w, size.h, false); }
      wp.start();

      var ov = o.overlays || {};
      // Same floor as the stills — see there.
      if (wp.setActivity) wp.setActivity(Math.max(0.55, typeof ov.activity === 'number' ? ov.activity : 0.45));
      if (wp.setAgents && ov.agents) wp.setAgents(ov.agents);

      // The bed, composited under every frame — same reason as the still: the
      // engine samples the image but never draws it.
      var bed = await new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = bedImage(o, size.w, size.h);
      });
      var out = document.createElement('canvas');
      out.width = size.w; out.height = size.h;
      var octx = out.getContext('2d');

      function composite() {
        octx.fillStyle = '#05060a';
        octx.fillRect(0, 0, size.w, size.h);
        if (bed) {
          var k = Math.max(size.w / bed.width, size.h / bed.height);
          var dw = bed.width * k, dh = bed.height * k;
          octx.drawImage(bed, (size.w - dw) / 2, (size.h - dh) / 2, dw, dh);
          octx.fillStyle = 'rgba(5,6,10,0.42)';
          octx.fillRect(0, 0, size.w, size.h);
        }
        octx.drawImage(canvas, 0, 0, size.w, size.h);
      }

      step(0.12, 'settling');
      await wait(800);
      if (wp.setStageItems && ov.stage && ov.stage.length) wp.setStageItems(ov.stage);

      // ── Encode ──
      var chunks = [];
      var description = null;
      var encoderError = null;
      encoder = new root.VideoEncoder({
        output: function (chunk, meta) {
          if (meta && meta.decoderConfig && meta.decoderConfig.description && !description) {
            description = new Uint8Array(meta.decoderConfig.description);
          }
          var buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          chunks.push({ data: buf, isKey: chunk.type === 'key', duration: 90000 / VIDEO_FPS });
        },
        // Kept, not swallowed. A no-op here turns any encoder failure into
        // "Cannot call encode on a closed codec" thirty frames later, with the
        // real reason gone.
        error: function (err) { encoderError = err; },
      });

      /* The codec string carries a LEVEL, and the level caps the frame size.
         A phone-shaped 720x1560 is about 1.1M pixels, which is already past
         level 3.1's ~920k ceiling — so a hardcoded avc1.42001f fails to
         configure on the one aspect ratio this feature exists for. Ask the
         browser which of these it will actually take, largest capability last
         so the first match is the most compatible one that fits. */
      var base = {
        width: size.w, height: size.h,
        framerate: VIDEO_FPS,
        bitrate: 6_000_000,
        avc: { format: 'avc' },          // AVCC, which is what the muxer expects
        latencyMode: 'quality',
      };
      var candidates = ['avc1.42e028', 'avc1.42e02a', 'avc1.4d0028', 'avc1.640028', 'avc1.42001f'];
      var chosen = null;
      for (var ci = 0; ci < candidates.length; ci++) {
        var cfg = Object.assign({}, base, { codec: candidates[ci] });
        try {
          var sup = await root.VideoEncoder.isConfigSupported(cfg);
          if (sup && sup.supported) { chosen = cfg; break; }
        } catch (e) { /* try the next */ }
      }
      if (!chosen) { var nc = new Error('no-codec'); nc.code = 'no-codec'; throw nc; }
      step(0.14, 'codec ' + chosen.codec);
      encoder.configure(chosen);
      if (encoderError) throw encoderError;
      step(0.15, 'recording');

      /* The float-over-other-apps loop wants a longer take than a Live Photo
         does: a Live Photo plays about 1.5s and stops, while a Picture in
         Picture window runs until it is dismissed, and a four-second loop
         repeating for minutes reads as a stutter rather than a field. */
      var totalFrames = VIDEO_FPS * Math.max(1, Math.min(20, o.seconds || VIDEO_SECONDS));
      var frameDurUs = Math.round(1e6 / VIDEO_FPS);
      var lines = (o.texts && o.texts.length) ? o.texts : [];
      var nextLineAt = Math.round(totalFrames / Math.max(1, lines.length + 1));

      for (var i = 0; i < totalFrames; i++) {
        // Same reason as the stills above: a missed 400ms deadline is a slow
        // GPU, not a backgrounded page, and only the second one is fatal. A
        // late frame is encoded late, which is what a dropped frame looks like
        // in any recording.
        await raf(400);
        if (!visible()) {
          if (i < VIDEO_FPS) { var h = new Error('hidden'); h.code = 'hidden'; throw h; }
          break;                        // enough recorded to still be worth having
        }
        // Rotate the glyph text through the clip so it says more than one thing.
        if (lines.length && i > 0 && i % nextLineAt === 0 && wp.setAgentLog) {
          wp.setAgentLog([{ name: '', icon: '', lines: [{ label: lines[(i / nextLineAt) % lines.length | 0] }] }]);
        }
        composite();
        var frame = new root.VideoFrame(out, { timestamp: i * frameDurUs, duration: frameDurUs });
        // A keyframe every second: Photos seeks into these, and a single one at
        // the start makes scrubbing behave badly.
        encoder.encode(frame, { keyFrame: i % VIDEO_FPS === 0 });
        frame.close();
        if (encoderError) throw encoderError;
        if (i % 8 === 0) step(0.15 + 0.7 * (i / totalFrames), 'frame ' + i + '/' + totalFrames);
      }

      step(0.9, 'encoding');
      await encoder.flush();
      if (encoderError) throw encoderError;
      if (!chunks.length || !description) throw new Error('encoder produced nothing');

      var bytes = root.TerseMP4.mux({
        samples: chunks, description: description,
        width: size.w, height: size.h, timescale: 90000,
      });
      step(1, 'done');
      return { blob: new Blob([bytes], { type: 'video/mp4' }), width: size.w, height: size.h, frames: chunks.length };
    } finally {
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) {}
      if (wp) { try { wp.dispose(); } catch (e) {} }
      try { canvas.remove(); } catch (e) {}
    }
  }

  root.TerseCapture = {
    capture: capture, captureVideo: captureVideo, canEncodeVideo: canEncodeVideo,
    targetSize: targetSize,
    // Shared with the LIVE field, which needs exactly the same backdrop for
    // exactly the same reason — see app.js.
    bedImage: bedImage,
  };
})(window);
