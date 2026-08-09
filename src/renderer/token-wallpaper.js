/*
 * token-wallpaper.js — Live desktop wallpaper visual engine for Terse (Tauri / WKWebView, macOS)
 * ---------------------------------------------------------------------------------------------
 * Recreates the "音域回响 / Audio Spectrum Echo" look: an angled 3D field of glowing cylindrical
 * columns (an equalizer grid seen from a tilted top-down angle) that rise and fall. Instead of
 * audio, it is driven by TOKEN CONSUMPTION via pulse(strength).
 *
 * Pure vanilla JS + Canvas2D. No external libraries, no imports, no network. Renders onto a
 * <canvas> the caller supplies. Touches nothing but that canvas.
 *
 * USAGE:
 *   const w = new TokenWallpaper(canvas, { theme: 'neon', quality: 56, angle: 55 });
 *   w.start();          // begin the RAF loop
 *   w.pulse(0.4);       // small pulse -> ripple; large (>~0.6) -> meteor + burst
 *   w.setTheme('ocean');
 *   w.setQuality(48);
 *   w.setAngle(60);
 *   w.setIntensity(1.2);
 *   w.stop();
 *
 * Behaviors: perspective-projected GxG column field (painter's algorithm back-to-front),
 * idle "breathing" sine wave, concentric ripples from pulses, meteors + particle bursts from
 * big pulses, and additive neon bloom for caps / streaks / particles.
 */
(function () {
  'use strict';

  // ----------------------------------------------------------------------------------------
  // Theme palette. Each theme: colors are [r,g,b] triplets so we can build gradients cheaply.
  //   base  = column base (dark, at the ground)
  //   mid   = column body mid tone
  //   top   = bright column top / accent
  //   glow  = the neon glow color used for caps, meteors and particles
  //   bg    = background radial gradient [innerColor, outerColor], each [r,g,b]
  // ----------------------------------------------------------------------------------------
  var THEMES = {
    indigo: {
      base: [40, 30, 90], mid: [88, 70, 200], top: [150, 140, 255], glow: [130, 120, 255],
      bg: [[26, 20, 55], [6, 4, 18]]
    },
    ocean: {
      base: [8, 40, 70], mid: [20, 110, 170], top: [90, 200, 240], glow: [60, 180, 235],
      bg: [[8, 30, 58], [2, 8, 20]]
    },
    ice: {
      base: [40, 70, 95], mid: [120, 180, 215], top: [205, 240, 255], glow: [170, 225, 255],
      bg: [[26, 44, 66], [6, 12, 22]]
    },
    emerald: {
      base: [8, 55, 40], mid: [24, 150, 105], top: [120, 245, 190], glow: [70, 220, 150],
      bg: [[8, 40, 32], [2, 12, 10]]
    },
    gold: {
      base: [70, 50, 12], mid: [190, 150, 40], top: [255, 225, 130], glow: [255, 200, 90],
      bg: [[46, 34, 12], [16, 10, 2]]
    },
    amber: {
      base: [75, 40, 8], mid: [215, 120, 30], top: [255, 195, 110], glow: [255, 150, 60],
      bg: [[46, 24, 8], [16, 7, 2]]
    },
    blood: {
      base: [70, 10, 12], mid: [180, 30, 40], top: [255, 110, 100], glow: [235, 55, 55],
      bg: [[44, 8, 12], [14, 2, 4]]
    },
    coral: {
      base: [80, 30, 45], mid: [230, 100, 120], top: [255, 180, 190], glow: [255, 120, 140],
      bg: [[50, 22, 34], [16, 6, 12]]
    },
    neon: {
      base: [45, 12, 70], mid: [175, 40, 200], top: [255, 130, 240], glow: [225, 70, 235],
      bg: [[34, 10, 52], [8, 2, 16]]
    },
    mono: {
      base: [30, 30, 34], mid: [130, 130, 140], top: [245, 245, 250], glow: [220, 220, 230],
      bg: [[24, 24, 28], [4, 4, 6]]
    }
  };

  // Small helpers ---------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  // Linear interpolation between two [r,g,b] colors.
  function lerpColor(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  // ========================================================================================
  // TokenWallpaper
  // ========================================================================================
  function TokenWallpaper(canvasEl, opts) {
    if (!canvasEl) throw new Error('TokenWallpaper: a canvas element is required');
    opts = opts || {};

    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');

    // Configurable state -------------------------------------------------------------------
    this.themeName = (opts.theme && THEMES[opts.theme]) ? opts.theme : 'neon';
    this.theme = THEMES[this.themeName];
    this.G = clamp(opts.quality || 56, 32, 96) | 0;   // grid size (GxG)
    this.angleDeg = clamp(opts.angle || 55, 35, 75);   // camera tilt
    this.intensity = clamp(opts.intensity || 1, 0.3, 2);

    // Runtime state ------------------------------------------------------------------------
    this.dpr = 1;
    this.W = 0; this.H = 0;              // backing-store pixel size
    this.running = false;
    this._raf = 0;
    this._lastT = 0;
    this._time = 0;                      // seconds since start (for breathing)

    // Per-cell amplitude fields (flat Float32 arrays, length G*G).
    //   amp    = current visible height factor (0..~1.5)
    //   target = height the cell is easing toward (breathing + energy)
    //   energy = transient energy injected by ripples/meteors, decays over time
    this._alloc();

    // Effect pools -------------------------------------------------------------------------
    this.ripples = [];    // {cx, cy, radius, speed, strength, life}
    this.meteors = [];     // {x, y, tx, ty, sx, sy, life, strength}
    this.particles = [];   // {x, y, vx, vy, life, maxLife, size}
    this._MAX_PARTICLES = 260;

    // Bind loop once so we can add/remove listeners cleanly.
    this._tick = this._tick.bind(this);
    this._onResize = this.resize.bind(this);

    this.resize();
  }

  // Allocate the amplitude field arrays for the current grid size.
  TokenWallpaper.prototype._alloc = function () {
    var n = this.G * this.G;
    this.amp = new Float32Array(n);
    this.target = new Float32Array(n);
    this.energy = new Float32Array(n);
  };

  // ------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------

  TokenWallpaper.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this._lastT = 0;
    window.addEventListener('resize', this._onResize);
    this._raf = requestAnimationFrame(this._tick);
  };

  TokenWallpaper.prototype.stop = function () {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    window.removeEventListener('resize', this._onResize);
  };

  // Read the CSS size, apply DPR scaling to the backing store. Guards against zero-size.
  TokenWallpaper.prototype.resize = function () {
    var cssW = this.canvas.clientWidth || this.canvas.width || 0;
    var cssH = this.canvas.clientHeight || this.canvas.height || 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR at 2 for perf
    var w = Math.max(1, Math.round(cssW * this.dpr));
    var h = Math.max(1, Math.round(cssH * this.dpr));
    if (w !== this.canvas.width) this.canvas.width = w;
    if (h !== this.canvas.height) this.canvas.height = h;
    this.W = w;
    this.H = h;
    this._computeProjection();
  };

  // Inject a token-consumption pulse. strength ~0..1 typical; can exceed 1 for big spikes.
  //   small  -> ripple that raises columns as a ring expands
  //   large (>~0.6) -> meteor streak that falls and impacts with a burst + strong ripple
  TokenWallpaper.prototype.pulse = function (strength) {
    strength = (typeof strength === 'number' && isFinite(strength)) ? strength : 0.3;
    strength = clamp(strength, 0, 4);

    var G = this.G;
    // Random-ish target cell, biased toward the center so effects read well.
    var cx = (0.5 + (Math.random() - 0.5) * 0.7) * (G - 1);
    var cy = (0.5 + (Math.random() - 0.5) * 0.7) * (G - 1);

    if (strength > 0.6) {
      // Big spike -> meteor. It will spawn a ripple + burst on impact.
      this._spawnMeteor(cx, cy, strength);
    } else {
      // Bulk / low-energy -> ripple.
      this._spawnRipple(cx, cy, strength);
    }

    // Also give the whole field a tiny global lift so consumption "feels" felt everywhere.
    var lift = 0.04 * strength * this.intensity;
    var energy = this.energy;
    for (var i = 0; i < energy.length; i++) energy[i] += lift;
  };

  TokenWallpaper.prototype.setTheme = function (name) {
    if (THEMES[name]) {
      this.themeName = name;
      this.theme = THEMES[name];
      this._bgCache = null; // invalidate cached background gradient
    }
  };

  TokenWallpaper.prototype.setQuality = function (n) {
    n = clamp(n | 0, 32, 96);
    if (n === this.G) return;
    this.G = n;
    this._alloc();
    this._computeProjection();
  };

  TokenWallpaper.prototype.setAngle = function (deg) {
    this.angleDeg = clamp(deg, 35, 75);
    this._computeProjection();
  };

  TokenWallpaper.prototype.setIntensity = function (x) {
    this.intensity = clamp(x, 0.3, 2);
  };

  // Expose available theme names for callers/UI.
  TokenWallpaper.prototype.getThemes = function () {
    return Object.keys(THEMES);
  };

  // ------------------------------------------------------------------------------------------
  // Effect spawners
  // ------------------------------------------------------------------------------------------

  TokenWallpaper.prototype._spawnRipple = function (cx, cy, strength) {
    if (this.ripples.length > 24) this.ripples.shift();
    this.ripples.push({
      cx: cx, cy: cy,
      radius: 0,
      speed: 9 + strength * 6,           // cells per second
      strength: (0.6 + strength) * this.intensity,
      life: 1                             // 1 -> 0
    });
  };

  TokenWallpaper.prototype._spawnMeteor = function (cx, cy, strength) {
    if (this.meteors.length > 8) this.meteors.shift();
    // Project the target cell to screen so the meteor can aim at it.
    var p = this._project(cx, cy, 0);
    // Start above the top of the screen, offset a bit horizontally for a diagonal streak.
    var startX = p.x + (Math.random() - 0.5) * this.W * 0.25;
    var startY = -this.H * 0.15;
    this.meteors.push({
      x: startX, y: startY,
      tx: p.x, ty: p.y,
      cx: cx, cy: cy,
      progress: 0,
      speed: 1.3 + Math.random() * 0.4,  // progress per second
      strength: strength,
      trail: []
    });
  };

  // Spawn a burst of glowing screen-space particles at (x, y).
  TokenWallpaper.prototype._spawnBurst = function (x, y, strength) {
    var count = Math.min(50, Math.round(18 + strength * 26));
    for (var i = 0; i < count; i++) {
      if (this.particles.length >= this._MAX_PARTICLES) break;
      var ang = Math.random() * Math.PI * 2;
      var spd = (60 + Math.random() * 180) * (0.6 + strength * 0.6);
      this.particles.push({
        x: x, y: y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 60,     // slight upward bias
        life: 1,
        maxLife: 0.6 + Math.random() * 0.7,
        size: (1.2 + Math.random() * 2.4) * this.dpr
      });
    }
  };

  // ------------------------------------------------------------------------------------------
  // Projection: tilted pseudo-3D. Grid cell (gx, gy) + height -> screen (x, y) and scale.
  //   gy=0 is the far row (top of screen, smaller); gy=G-1 is near (bottom, larger).
  // ------------------------------------------------------------------------------------------
  TokenWallpaper.prototype._computeProjection = function () {
    var W = this.W, H = this.H, G = this.G;
    // 'tilt' 0..1: how flat the field lies. Larger angle -> more top-down -> more depth spread.
    var t = (this.angleDeg - 35) / (75 - 35); // 0..1
    this._tilt = 0.35 + t * 0.5;              // vertical compression of far rows
    this._depthScale = 0.45 + (1 - t) * 0.35; // how much far rows shrink

    // Field footprint on screen.
    this._fieldTop = H * (0.16 + t * 0.10);
    this._fieldBottom = H * 0.94;
    this._fieldH = this._fieldBottom - this._fieldTop;
    this._cx = W * 0.5;

    // Column visual sizing (in screen px at the NEAR row).
    this._nearColW = (W / G) * 0.72;
    // Vertical unit for a full-amplitude column at the near row.
    this._colUnit = H * 0.16;
    this._bgCache = null;
  };

  // Project a grid coordinate (fractional allowed) + height factor to screen space.
  TokenWallpaper.prototype._project = function (gx, gy, height) {
    var G = this.G;
    // Depth 0 (far) .. 1 (near).
    var d = gy / (G - 1);
    // Perspective: rows bunch up toward the far edge. Use an eased depth.
    var ed = Math.pow(d, this._tilt);          // eased depth for vertical placement
    var y = this._fieldTop + ed * this._fieldH;
    // Scale: far rows smaller.
    var scale = this._depthScale + (1 - this._depthScale) * d;
    // Horizontal: center-out, wider as we come near.
    var spanFrac = ((gx / (G - 1)) - 0.5);
    var rowWidth = this.W * (0.5 + 0.5 * d);   // near rows span wider
    var x = this._cx + spanFrac * rowWidth;
    // Column top rises upward (screen -y) by height.
    var topY = y - height * this._colUnit * scale;
    return { x: x, y: y, topY: topY, scale: scale, d: d };
  };

  // ------------------------------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------------------------------
  TokenWallpaper.prototype._tick = function (now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);
    // Idle while hidden, and cap to ~40fps — an ambient background needs no more.
    if (document.hidden) { this._lastT = now; return; }
    if (this._lastRender && (now - this._lastRender) < 24) return;
    this._lastRender = now;
    if (!this._lastT) this._lastT = now;
    var dt = (now - this._lastT) / 1000;
    this._lastT = now;
    // Clamp dt to avoid huge jumps after a tab stall.
    if (dt > 0.05) dt = 0.05;
    this._time += dt;

    // Guard against zero-size canvas (e.g., hidden window).
    if (this.W > 1 && this.H > 1) {
      this._update(dt);
      this._render();
    }
  };

  // Advance simulation by dt seconds.
  TokenWallpaper.prototype._update = function (dt) {
    var G = this.G;
    var amp = this.amp, target = this.target, energy = this.energy;

    // 1) Idle breathing wave + decay energy into targets.
    var tm = this._time;
    var breathAmp = 0.14 * this.intensity;
    for (var gy = 0; gy < G; gy++) {
      for (var gx = 0; gx < G; gx++) {
        var i = gy * G + gx;
        // Two crossing sine waves make an organic breathing surface.
        var wave = Math.sin(gx * 0.35 + tm * 1.1) * Math.cos(gy * 0.32 - tm * 0.9);
        var breathe = 0.16 + breathAmp * (0.5 + 0.5 * wave);
        target[i] = breathe + energy[i];
        // Decay transient energy.
        energy[i] *= (1 - Math.min(1, dt * 2.2));
        if (energy[i] < 0.0008) energy[i] = 0;
      }
    }

    // 2) Ripples: expand and inject energy into cells the ring is passing through.
    for (var r = this.ripples.length - 1; r >= 0; r--) {
      var rp = this.ripples[r];
      rp.radius += rp.speed * dt;
      rp.life -= dt * 0.6;
      if (rp.life <= 0 || rp.radius > G * 1.6) { this.ripples.splice(r, 1); continue; }
      var ringW = 1.6;                // ring thickness in cells
      var ampF = rp.strength * rp.life;
      // Only scan a band around the ring for perf.
      var rad = rp.radius;
      for (var yy = 0; yy < G; yy++) {
        var dy = yy - rp.cy;
        for (var xx = 0; xx < G; xx++) {
          var dx = xx - rp.cx;
          var dist = Math.sqrt(dx * dx + dy * dy);
          var off = Math.abs(dist - rad);
          if (off < ringW) {
            var falloff = (1 - off / ringW);
            // Fade with radius so far reaches are gentler.
            var rf = Math.max(0, 1 - rad / (G * 0.9));
            energy[yy * G + xx] += ampF * falloff * rf * 0.9 * dt * 12;
          }
        }
      }
    }

    // 3) Meteors: advance toward target; on impact spawn ripple + burst.
    for (var m = this.meteors.length - 1; m >= 0; m--) {
      var mt = this.meteors[m];
      mt.progress += mt.speed * dt;
      var p = clamp(mt.progress, 0, 1);
      // Ease-in for an accelerating fall.
      var e = p * p;
      mt.x = mt.x + (mt.tx - mt.x) * Math.min(1, dt * 6);
      var curX = mt.x;
      var curY = mt.startY == null ? (mt.y) : 0;
      // Interpolate straight from start to target using eased progress.
      // (recompute using stored linear endpoints)
      // We store trail of recent points for the streak.
      var px = mt._sx == null ? (mt._sx = mt.x, mt._sy = mt.y, mt.x) : mt.x;
      // position along path:
      var posX = mt._sx + (mt.tx - mt._sx) * e;
      var posY = mt._sy + (mt.ty - mt._sy) * e;
      mt.x = posX; mt.y = posY;
      mt.trail.push({ x: posX, y: posY });
      if (mt.trail.length > 14) mt.trail.shift();
      if (p >= 1) {
        // Impact!
        this._spawnRipple(mt.cx, mt.cy, mt.strength + 0.4);
        this._spawnBurst(mt.tx, mt.ty, mt.strength);
        // Strong local energy stamp.
        var ci = Math.round(mt.cy) * G + Math.round(mt.cx);
        if (ci >= 0 && ci < energy.length) energy[ci] += mt.strength * 1.2;
        this.meteors.splice(m, 1);
      }
    }

    // 4) Ease visible amplitudes toward targets (springy but smooth).
    var ease = Math.min(1, dt * 9);
    for (var k = 0; k < amp.length; k++) {
      amp[k] += (target[k] - amp[k]) * ease;
    }

    // 5) Particles: gravity + fade.
    for (var q = this.particles.length - 1; q >= 0; q--) {
      var pt = this.particles[q];
      pt.life -= dt / pt.maxLife;
      if (pt.life <= 0) { this.particles.splice(q, 1); continue; }
      pt.vy += 260 * dt;                // gravity
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
    }
  };

  // ------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------
  TokenWallpaper.prototype._render = function () {
    var ctx = this.ctx, W = this.W, H = this.H, G = this.G, th = this.theme;

    // --- Background radial gradient (cached) ---
    if (!this._bgCache) {
      var g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
      g.addColorStop(0, rgb(th.bg[0]));
      g.addColorStop(1, rgb(th.bg[1]));
      this._bgCache = g;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this._bgCache;
    ctx.fillRect(0, 0, W, H);

    // --- Column field, painter's algorithm: far rows (gy=0) first, near rows last ---
    var amp = this.amp;
    var nearColW = this._nearColW;
    ctx.lineWidth = 0;
    for (var gy = 0; gy < G; gy++) {
      for (var gx = 0; gx < G; gx++) {
        var h = amp[gy * G + gx];
        if (h < 0.01) h = 0.01;
        var pr = this._project(gx, gy, h);
        var colW = nearColW * pr.scale;
        if (colW < 0.6) continue;         // too tiny to see; skip for perf
        this._drawColumn(ctx, pr, colW, h, th);
      }
    }

    // --- Additive bloom pass for caps already drawn happens inside _drawColumn's cap.
    //     Now draw meteors + particles additively on top. ---
    ctx.globalCompositeOperation = 'lighter';

    // Meteors (glowing streaks).
    for (var m = 0; m < this.meteors.length; m++) {
      this._drawMeteor(ctx, this.meteors[m], th);
    }

    // Particles.
    var glow = th.glow;
    for (var q = 0; q < this.particles.length; q++) {
      var pt = this.particles[q];
      var a = clamp(pt.life, 0, 1);
      ctx.beginPath();
      ctx.fillStyle = rgba(glow, a * 0.9);
      ctx.shadowColor = rgba(glow, a);
      ctx.shadowBlur = 10 * this.dpr;
      ctx.arc(pt.x, pt.y, pt.size * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }

    // Reset compositing state.
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  };

  // Draw a single cylindrical column: shaded side gradient + bright glowing top cap.
  TokenWallpaper.prototype._drawColumn = function (ctx, pr, colW, h, th) {
    var hw = colW * 0.5;
    var topY = pr.topY;
    var baseY = pr.y;
    var x = pr.x;

    // Height-driven brightness: taller columns glow brighter at the top.
    var lift = clamp(h, 0, 1.4);

    // Side body gradient: dark base -> brighter mid/top as it rises.
    var bodyGrad = ctx.createLinearGradient(0, baseY, 0, topY);
    bodyGrad.addColorStop(0, rgb(th.base));
    bodyGrad.addColorStop(0.55, rgb(lerpColor(th.base, th.mid, 0.8)));
    bodyGrad.addColorStop(1, rgb(lerpColor(th.mid, th.top, clamp(lift * 0.6, 0, 1))));

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = bodyGrad;
    // Column body as a simple rectangle (front face of the cylinder).
    ctx.fillRect(x - hw, topY, colW, baseY - topY);

    // Subtle rounded/elliptical cap for a cylindrical feel.
    var capH = Math.max(1, colW * 0.22);

    // Bright glowing top cap — additive so overlapping caps bloom.
    ctx.globalCompositeOperation = 'lighter';
    var capColor = lerpColor(th.top, th.glow, 0.4);
    ctx.beginPath();
    ctx.fillStyle = rgba(capColor, clamp(0.55 + lift * 0.35, 0, 1));
    ctx.shadowColor = rgba(th.glow, clamp(0.5 + lift * 0.4, 0, 1));
    ctx.shadowBlur = (6 + lift * 10) * this.dpr;
    ctx.ellipse(x, topY, hw, capH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  };

  // Draw a meteor: a tapered glowing streak from its trail, plus a bright head.
  TokenWallpaper.prototype._drawMeteor = function (ctx, mt, th) {
    var trail = mt.trail;
    if (trail.length < 2) return;
    var glow = th.glow, top = th.top;

    // Streak: draw the trail as a fading, widening line.
    for (var i = 1; i < trail.length; i++) {
      var a0 = i / trail.length;
      var p0 = trail[i - 1], p1 = trail[i];
      ctx.beginPath();
      ctx.strokeStyle = rgba(lerpColor(glow, top, a0), a0 * 0.9);
      ctx.lineWidth = (1 + a0 * 3.5) * this.dpr;
      ctx.shadowColor = rgba(glow, a0);
      ctx.shadowBlur = 14 * this.dpr;
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    // Bright head.
    var head = trail[trail.length - 1];
    ctx.beginPath();
    ctx.fillStyle = rgba(top, 1);
    ctx.shadowColor = rgba(glow, 1);
    ctx.shadowBlur = 22 * this.dpr;
    ctx.arc(head.x, head.y, 3.2 * this.dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  };

  // ----------------------------------------------------------------------------------------
  // Export
  // ----------------------------------------------------------------------------------------
  if (typeof window !== 'undefined') {
    window.TokenWallpaper = TokenWallpaper;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TokenWallpaper;
  }
})();
