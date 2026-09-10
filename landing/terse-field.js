/* ═══════════════════════════════════════════════════════════════════════════
   terse-field.js — the live agent-log particle wallpaper, for the website.

   A WebGL port of what the Tauri app actually runs on the desktop
   (src/renderer/mineradio-wallpaper.js + mineradio-shaders.js). The structure
   below mirrors the app's, because the app's structure IS the look:

     · BED — the wallpaper. On the desktop it is the user's own desktop
       picture (uCoverTex). Here it is a deep-space galaxy computed in GLSL:
       domain-warped fbm nebula, a Milky Way band with dust-lane subtraction
       and core brightening, and three parallax star layers.

     · FIELD — ~20k particles that take their colour FROM THE BED, which is
       the app's `vColor = mix(defaultColor, coverColor, uHasCover)`. The
       particles are the wallpaper dissolved into light, never a grey speckle.
       They run danceAt() — all ten choreographies, ported from
       mineradio-shaders.js:130 — centred on whatever line is forming, plus
       ripples that radiate from where it landed.

     · GLYPH — FOUR INDEPENDENT SLOTS, exactly like the app's Pro tier
       (mineradio-wallpaper.js:541). Each slot is its OWN dense lattice of
       points over its own text box — `target = uCenter + (aUv - 0.5) * uSize`
       with aOn as the stroke mask — which is why the text reads dense, bright
       and sharp instead of as a dusting of dots. Slot 0 is reserved for the
       agent-log headline so the statistics can never starve it; slots 1-3 take
       metrics. Formations are STAGGERED, never batched: filling every free
       slot on one frame turns the stream into a pulse.

     · dispAt() — the nine scatter handwritings (BURST / ABOVE / VORTEX /
       SIDE / DIFFUSE / RING / SHATTER / DRIFT / BELOW), ported from
       mineradio-wallpaper.js:206. In and out are independent, so a line can
       fall in from above and shatter downward.

   Timing is the app's cinematic style: in 400 / hold 1000 / out 667, fillGap
   520 (wallpaper-styles.js:47,77).

   PURELY ADDITIVE. Creates its own two elements, touches nothing else on the
   page, exposes only window.TerseField, makes no network calls. No WebGL, a
   phone, or prefers-reduced-motion all fall back to the CSS gradient bed.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.TerseField) return;

  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var MINW = 760;
  var MAX_RIPPLES = 6;
  var SLOTS = 4;

  /* text lattice per slot — 256 x 64 = 16,384 points, the web-scale version of
     the app's 60,000 per line. Dense enough that strokes read as solid. */
  /* Glyph particles per slot. The app's number (mineradio-wallpaper.js:539),
     and the reason its text is dense and bright instead of a dusting of dots.
     These are unlit, depth-less, additive points — the cheapest thing a GPU
     draws — but the mask is sampled on the CPU once per line, so this also sets
     how long a re-form takes. MW is the mask canvas: the app uses 1024×128 and
     notes that spreading the same strokes over a TALLER canvas made the letters
     read soft, because the sampled mask comes back thinner. */
  var GLYPH_N = 60000, MW = 1024, MH = 128;
  /* Phones get a smaller cloud, not no cloud. A phone screen is roughly a fifth
     of a desktop's pixels and the text sits smaller on it, so the same particle
     count would be spent packing a far denser stroke than anyone can see, while
     costing a weaker GPU the full fill. Measured at mount, not on resize —
     rebuilding the buffers mid-rotation would blink the text out. */
  if (window.innerWidth < MINW) GLYPH_N = 26000;

  /* the app's cinematic timing (wallpaper-styles.js DEFAULT) */
  var T_IN = 460, T_HOLD = 1450, T_OUT = 720, FILL_GAP = 560;
  var G_LIFE = T_IN + T_HOLD + T_OUT;

  /* ── The code city ────────────────────────────────────────────────────────
     A second, slower rhythm running underneath the log lines: the repository
     itself, built out of particles as a skyline. Height is code volume, the
     footprint is file count, the colour bands are the language mix and the lit
     windows are "has anyone touched this lately" — the mapping is fixed, and
     only the ARCHITECTURE changes between styles. That is the whole point of
     the eight civilisations: a style is a skin, never a different reading. If
     switching to Maya made the towers shorter, a visitor would think the
     project had changed.

     Much slower than the text — a city takes a beat to read, and one arriving
     every few seconds would be noise. It builds, holds, and disperses. */
  var CITY_IN = 1700, CITY_HOLD = 7200, CITY_OUT = 2000, CITY_GAP = 6500;
  var CITY_LIFE = CITY_IN + CITY_HOLD + CITY_OUT;
  var CITY_N = 30000;
  if (window.innerWidth < MINW) CITY_N = 13000;   /* same reasoning as GLYPH_N */

  /* The repository, measured — not invented. Produced by
     scripts/build-landing-citydata.mjs from `git ls-files` plus git log, so a
     tower's height really is that directory's code volume and a dark tower
     really has not been touched in months. The universe is what is COMMITTED:
     a disk walk dragged in build artifacts, Pods and six never-committed
     remotion-* video scratch projects, which stood in the skyline as tall dead
     towers — wrong, and dull. Regenerate when the shape of the repo changes. */
  var CITY_DIRS = [
    { name:"api",               kind:"source",   files:   70, bytes: 8279529, churn: 124, age_days:   0, depth:1,
      lang:"JSON", langs:[["JSON",0.886],["JavaScript",0.114]] },
    { name:"landing",           kind:"source",   files:  277, bytes: 6143807, churn: 266, age_days:   1, depth:1,
      lang:"HTML", langs:[["HTML",0.833],["JavaScript",0.155],["CSS",0.005],["Markdown",0.004]] },
    { name:"src",               kind:"source",   files:  297, bytes: 5046276, churn:  65, age_days:   0, depth:1,
      lang:"JavaScript", langs:[["JavaScript",0.72],["HTML",0.2],["CSS",0.063],["Shell",0.009]] },
    { name:"android-app",       kind:"source",   files:  851, bytes: 4357650, churn:   1, age_days: 118, depth:1,
      lang:"XML", langs:[["XML",0.566],["JSON",0.368],["Kotlin",0.036],["HTML",0.03]] },
    { name:"src-tauri",         kind:"source",   files:   27, bytes: 1376942, churn:  38, age_days:   8, depth:1,
      lang:"JSON", langs:[["JSON",0.709],["Rust",0.29],["TOML",0.001]] },
    { name:"chrome-extension",  kind:"source",   files:   23, bytes: 1273740, churn:   2, age_days:  53, depth:1,
      lang:"JavaScript", langs:[["JavaScript",0.97],["HTML",0.013],["CSS",0.012],["Markdown",0.004]] },
    { name:"docs",              kind:"docs",     files:   11, bytes:  509192, churn:   9, age_days:   8, depth:1,
      lang:"HTML", langs:[["HTML",0.956],["Markdown",0.044]] },
    { name:"ml",                kind:"source",   files:    1, bytes:  464650, churn:   1, age_days: 132, depth:1,
      lang:"JSON", langs:[["JSON",1]] },
    { name:"ios-app",           kind:"source",   files:  105, bytes:  289673, churn:   4, age_days: 118, depth:1,
      lang:"Swift", langs:[["Swift",0.952],["JSON",0.031],["Markdown",0.017]] },
    { name:"windows-app",       kind:"source",   files:   31, bytes:  281151, churn:   9, age_days: 130, depth:1,
      lang:"Rust", langs:[["Rust",0.86],["C#",0.103],["TypeScript",0.014],["JSON",0.012]] },
    { name:"_t",                kind:"assets",   files:   37, bytes:   17705, churn:   2, age_days:   5, depth:1,
      lang:"JavaScript", langs:[["JavaScript",0.899],["JSON",0.101]] },
    { name:"vscode-extension",  kind:"source",   files:    6, bytes:   69532, churn:   4, age_days:  53, depth:1,
      lang:"JavaScript", langs:[["JavaScript",0.92],["JSON",0.08]] },
    { name:"scripts",           kind:"config",   files:   11, bytes:   37586, churn:   9, age_days:   8, depth:1,
      lang:"JavaScript", langs:[["JavaScript",0.519],["Python",0.26],["Shell",0.192],["JSON",0.03]] },
    { name:".github",           kind:"config",   files:    3, bytes:    7313, churn:  11, age_days:  11, depth:1,
      lang:"YAML", langs:[["YAML",1]] },
    { name:".claude",           kind:"source",   files:    1, bytes:     363, churn:   1, age_days:   3, depth:1,
      lang:"JavaScript", langs:[["JavaScript",1]] }
  ];

  /* Glyph tints — the app's Pro palette, biased to Terse's mint. */
  var TINTS = {
    tool:   [0.43, 0.90, 0.72],
    metric: [0.79, 0.94, 0.24],
    info:   [0.49, 0.83, 0.99],
    good:   [0.20, 0.83, 0.60],
    warm:   [1.00, 0.62, 0.27]
  };

  /* Slot 0's stream: the live agent log — what a real session prints. */
  var LOG = [
    'claude code · Read src/optimizer.js',
    'claude code · Edit island.css',
    'cursor · 3 dup reads pruned',
    'codex · Bash npm test',
    'doctor · 25 scans clean',
    'mcp · 6 servers ok',
    'aider · commit b6c8e70',
    'copilot · Grep agent_monitor.rs',
    'cline · Write stats_store.rs',
    'windsurf · 2 redundant reads',
    'budget breaker armed',
    'claude code · Bash cargo build'
  ];

  /* Slots 1-3: the statistics panel, same size as the log line. */
  var STATS = [
    ['+1,204 tok',        'metric'],
    ['cache hit 91%',     'info'],
    ['$0.0043 / turn',    'metric'],
    ['saved 68%',         'metric'],
    ['burn 2.1k tok/min', 'info'],
    ['context 46%',       'info'],
    ['312,480 saved',     'metric'],
    ['4 agents live',     'good'],
    ['−38% context',      'good'],
    ['$4.18 today',       'metric'],
    ['turn 27',           'info'],
    ['91% cached',        'good'],
    ['2 tools deduped',   'good'],
    ['1.2M tok month',    'metric'],
    ['opus → sonnet',     'warm']
  ];



  /* The wallpaper set. Sky-and-meadow plates at 3840x2160, downscaled to 1920
     and re-encoded for the web — 114-518 KB each, and only the current one is
     ever fetched, so a page load costs one image rather than sixteen.

     These are stills. The engine takes a .mp4 here just as happily and plays it
     as a live wallpaper, which is what the desktop app does; swapping any entry
     for its video is a one-word change once the videos are on disk. */
  /* Twenty LIVE wallpapers — the same sky-and-meadow set, as video rather
     than stills. Source is 1920x1080/30fps/30s at 12 Mbps, which is 43 MB a
     piece and unusable on the web; re-encoded to 1280x720/24fps/12s at CRF
     32 they average 0.55 MB, a 96% cut, and the plate spends its life
     blurred and dimmed behind glass anyway. Each has a poster frame beside
     it: the engine shows that immediately and hands over to the decoded
     video once it can actually play, so a click never opens onto black. */
  var WALLS = [
    'SK0_horizon-wanderer', 'SK1_horizon-gateway',
    'SK2_horizon-tree', 'SK3_horizon-cello',
    'SK4_torii-sky', 'SK5_sunny-horizon',
    'SK6_green-meadow', 'SK7_moonlit-meadow',
    'SK8_meadow-evening', 'SK9_rolling-hills',
    'SL0_hilltop-serenity', 'SL1_summer-hillside',
    'SL2_dreaming-clouds', 'SL3_reading-clouds',
    'SL4_mountains-hills', 'SL5_house-hills',
    'SL6_windmill-field', 'SL7_bliss-winxp',
    'SL8_girl-cat-clouds', 'SL9_pink-clouds'
  ];
  var wallIdx = -1;

  /* Sky palettes for the procedural bed. Weighted toward dusk, storm and blue
     hour on purpose: the page sets white type at 0.72 alpha, and a noon-bright
     sky cannot carry it. The exposure pass measures whatever comes out and
     corrects regardless, but starting close costs nothing. */
  var SKIES = [
    { n: 'dusk',       top: [0.10, 0.13, 0.34], haze: [0.86, 0.36, 0.42], sun: [1.00, 0.55, 0.38] },
    { n: 'blue hour',  top: [0.04, 0.09, 0.26], haze: [0.24, 0.36, 0.62], sun: [0.55, 0.70, 1.00] },
    { n: 'storm',      top: [0.09, 0.11, 0.16], haze: [0.30, 0.33, 0.40], sun: [0.72, 0.76, 0.84] },
    { n: 'ember',      top: [0.13, 0.08, 0.19], haze: [0.68, 0.22, 0.18], sun: [1.00, 0.60, 0.26] },
    { n: 'aurora sky', top: [0.03, 0.09, 0.21], haze: [0.09, 0.38, 0.42], sun: [0.42, 1.00, 0.70] },
    { n: 'alpenglow',  top: [0.08, 0.11, 0.30], haze: [0.74, 0.44, 0.56], sun: [1.00, 0.72, 0.62] },
    { n: 'monsoon',    top: [0.07, 0.12, 0.22], haze: [0.36, 0.45, 0.52], sun: [0.86, 0.90, 0.94] },
    { n: 'deep field', top: [0.05, 0.07, 0.18], haze: [0.16, 0.20, 0.38], sun: [0.70, 0.78, 1.00] }
  ];

  /* ═══════════════════════════════════════════════════════════════════════
     BED — deep space. Shared by the bed's fragment shader and the field's
     vertex shader, so the particles are literally the wallpaper.
     ═══════════════════════════════════════════════════════════════════════ */
  var SPACE_GLSL = [
    'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = h21(i), b = h21(i + vec2(1.0,0.0)), c = h21(i + vec2(0.0,1.0)), d = h21(i + vec2(1.0,1.0));',
    '  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);',
    '}',
    /* four octaves, each doubling frequency and halving amplitude */
    'float fbm(vec2 p){',
    '  float v = 0.0, a = 0.5;',
    '  for (int i = 0; i < 4; i++){ v += a * vnoise(p); p *= 2.03; a *= 0.5; }',
    '  return v;',
    '}',
    'vec3 spaceColor(vec2 p, float t){',
    '  vec2 q = p * 0.78 + vec2(t * 0.0075, t * 0.0042);',
    /* domain warp — the step that turns noise into gas */
    '  vec2 w = vec2(fbm(q * 0.92), fbm(q * 0.92 + 5.2));',
    '  float n = fbm(q * 1.45 + w * 1.55);',
    /* Milky Way band, tilted, with dust lanes subtracted out of it */
    '  float ang = -0.46;',
    '  float by = p.x * sin(ang) + p.y * cos(ang);',
    '  float band = exp(-by * by * 1.75);',
    '  float dust = smoothstep(0.34, 0.78, fbm(q * 2.35 + w * 0.8));',
    '  float lit = band * (1.0 - dust * 0.74);',
    /* deep space is not black — it is a very dark cold blue */
    '  vec3 c = vec3(0.0055, 0.0075, 0.0165);',
    '  c += vec3(0.310, 0.090, 0.470) * pow(n, 1.95) * 1.55;',                       /* violet gas   */
    '  c += vec3(0.020, 0.260, 0.365) * pow(fbm(q * 1.12 + 3.7), 2.05) * 1.30;',     /* teal gas     */
    '  c += vec3(0.470, 0.085, 0.265) * pow(max(n - 0.44, 0.0), 1.40) * 2.10;',      /* hot filament */
    /* a second, much larger warp gives the gas a sense of scale — without it
       the nebula reads as texture rather than as something enormous */
    '  float big = fbm(q * 0.42 + w * 0.6);',
    '  c += vec3(0.140, 0.060, 0.300) * pow(big, 2.4) * 1.20;',
    '  c *= 0.30 + band * 1.15;',
    '  c += vec3(0.600, 0.570, 0.680) * lit * 0.175;',                               /* the band     */
    /* Sagittarius-style core brightening, off to one side */
    '  vec2 k = p - vec2(0.42, -0.12);',
    '  c += vec3(0.640, 0.510, 0.380) * exp(-dot(k, k) * 0.85) * lit * 0.34;',
    '  return c;',
    '}'
  ].join('\n') + `
/* ── Cinematic sky ────────────────────────────────────────────────────────
   A horizon-facing sky: graded dome, sun glow with its own scattering, two
   octave-stacked cloud layers that are domain-warped so they billow rather
   than tile, lit from the sun so their tops catch light and their undersides
   stay heavy, and a haze band that thickens toward the horizon.

   The palette arrives as uniforms rather than being baked in, so a new sky is
   a uniform write — no shader recompile, which is what makes rolling one on
   every click cheap. */
uniform float uSkyMode, uSkySeed;
uniform vec3 uSkyTop, uSkyHaze, uSkySun;
uniform vec2 uSunPos;

vec3 skyColor(vec2 p, float t){
  float h = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uSkyHaze, uSkyTop, pow(h, 0.82));

  vec2 sun = uSunPos;
  float sd = length((p - sun) * vec2(0.72, 1.0));
  sky += uSkySun * exp(-sd * 2.1) * 0.85;          /* the disc's near glow    */
  sky += uSkySun * exp(-sd * 0.55) * 0.18;         /* the wide scatter around */

  /* Clouds. The warp is what stops fbm reading as noise: it drags the field
     through itself, so edges pile up into billows. */
  /* The seed must stay SMALL. h21 hashes with fract(sin(dot(p,k))*43758.5),
     and sin() loses its low bits well before p reaches the hundreds — pushing
     the sample point out by seed*23 collapsed the hash to a near-constant, fbm
     returned a flat value, and the clouds vanished entirely: the measured
     horizontal spread across the frame was 2-7 out of 255 while the vertical
     gradient was fine. Rotating by the seed and nudging by a couple of units
     decorrelates the field just as well and keeps the coordinates in range. */
  float sa = uSkySeed * 2.399;
  mat2 sr = mat2(cos(sa), -sin(sa), sin(sa), cos(sa));
  vec2 q = sr * (p * 1.05) + vec2(t * 0.0095, t * 0.0035) + vec2(uSkySeed * 1.7, uSkySeed * -1.1);
  vec2 w = vec2(fbm(q * 0.78), fbm(q * 0.78 + 4.7));
  float base   = fbm(q * 1.25 + w * 1.35);
  float detail = fbm(q * 3.30 + w * 1.90);
  float cloud  = smoothstep(0.34, 0.74, base * 0.80 + detail * 0.36);

  /* cumulus sit above the horizon and thin out as they recede into it */
  cloud *= smoothstep(-0.72, 0.02, p.y);

  /* Cloud lighting. The first version tied brightness to distance from the sun
     alone, which put dark grey cumulus on a dark sky and made them invisible —
     the whole field read as a flat gradient. Clouds need an ambient floor as
     well as a key light: the top of a cumulus is bright even facing away. */
  float lit = clamp(1.0 - sd * 0.20, 0.18, 1.0);
  float up  = smoothstep(-0.2, 0.7, p.y);                 /* tops catch more   */
  vec3 body = mix(vec3(0.40, 0.42, 0.50), vec3(1.0, 0.965, 0.93),
                  pow(lit, 1.35) * (0.45 + up * 0.55));
  body = mix(body, uSkySun, exp(-sd * 1.15) * 0.62);      /* rim near the sun  */

  vec3 c = mix(sky, body, cloud);
  c = mix(c, uSkyHaze * 1.10, smoothstep(0.16, -0.45, p.y) * 0.55);

  /* A sky lit for a photograph is far brighter than a page of white type can
     sit on. The exposure pass corrects, but it clamps at 0.45, so a sky that
     starts at .5 luminance cannot reach the .11 target. Bring it down here and
     let exposure do the fine work. */
  return c * 0.52;
}

/* One entry point for whichever procedural bed is active, so the field's
   vertex shader and the bed's fragment shader can never disagree. */
vec3 procColor(vec2 p, float t){
  return uSkyMode > 0.5 ? skyColor(p, t) : spaceColor(p, t);
}
`;

  var BED_VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var BED_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform float uTime, uHasCover, uExposure, uSoften;',
    'uniform vec2 uAspect, uCoverScale, uCoverDrift;',
    'uniform sampler2D uCover;',
    SPACE_GLSL,
    /* three parallax star layers — the cheap grid-cell trick */
    'float starLayer(vec2 p, float cells, float thin, float t){',
    '  vec2 g = p * cells;',
    '  vec2 id = floor(g), f = fract(g) - 0.5;',
    '  float r = h21(id);',
    '  if (r < thin) return 0.0;',
    '  vec2 off = (vec2(h21(id + 1.7), h21(id + 4.3)) - 0.5) * 0.7;',
    '  float d = length(f - off);',
    '  float tw = 0.62 + 0.38 * sin(t * (0.8 + r * 2.4) + r * 31.0);',
    '  return smoothstep(0.055, 0.0, d) * (0.35 + r * 0.65) * tw;',
    '}',
    'void main(){',
    '  vec2 p = vUv * uAspect;',
    /* A real wallpaper is cover-fitted and given a slow ken-burns drift, so the
       bed is never a dead still. uCoverScale < 1 samples a sub-rectangle of the
       image, which IS the crop; the drift then walks inside the margin it left. */
    '  vec3 c;',
    '  if (uHasCover > 0.5){',
    '    vec2 uv = (vUv * 0.5 + 0.5 - 0.5) * uCoverScale + 0.5 + uCoverDrift;',
    /* A busy photographic plate — neon signs, wet asphalt, shop fronts — fights
       every glyph on the page, and average luminance does not predict it: this
       street scene measures .10, darker than most gradients here, and is still
       the least readable plate in the set. What actually competes with type is
       LOCAL CONTRAST, so uSoften is driven by the plate's measured variance and
       defocuses it, exactly the way macOS defocuses the desktop behind a
       window. A smooth gradient gets none of this. */
    '    vec2 rad = vec2(0.0115, 0.0115 * uAspect.x / max(uAspect.y, 0.001)) * uSoften;',
    '    c = texture2D(uCover, clamp(uv, 0.002, 0.998)).rgb * 0.28;',
    '    c += texture2D(uCover, clamp(uv + vec2( rad.x, 0.0), 0.002, 0.998)).rgb * 0.12;',
    '    c += texture2D(uCover, clamp(uv + vec2(-rad.x, 0.0), 0.002, 0.998)).rgb * 0.12;',
    '    c += texture2D(uCover, clamp(uv + vec2(0.0,  rad.y), 0.002, 0.998)).rgb * 0.12;',
    '    c += texture2D(uCover, clamp(uv + vec2(0.0, -rad.y), 0.002, 0.998)).rgb * 0.12;',
    '    c += texture2D(uCover, clamp(uv + rad * 0.72, 0.002, 0.998)).rgb * 0.085;',
    '    c += texture2D(uCover, clamp(uv - rad * 0.72, 0.002, 0.998)).rgb * 0.085;',
    '    c += texture2D(uCover, clamp(uv + vec2(rad.x, -rad.y) * 0.72, 0.002, 0.998)).rgb * 0.085;',
    '    c += texture2D(uCover, clamp(uv + vec2(-rad.x, rad.y) * 0.72, 0.002, 0.998)).rgb * 0.085;',
    /* then pull the remaining contrast toward the plate mean */
    '    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '    c = mix(c, mix(vec3(lum), c, 0.72) * 0.86 + 0.012, uSoften * 0.85);',
    /* Exposure is MEASURED from the plate, not hard-coded. A constant tuned for
       the galactic horizon (luminance .04) blows out the black-hole plate (.41)
       and vice versa — and the picker offers 21 of them. See _rasterBed. */
    '    c = pow(max(c, 0.0), vec3(0.94)) * uExposure;',
    '  } else {',
    '    c = procColor(p, uTime);',
    '  }',
    '  float s = starLayer(p, 16.0, 0.80, uTime) * 0.85',
    '          + starLayer(p, 34.0, 0.86, uTime) * 0.52',
    '          + starLayer(p, 68.0, 0.90, uTime) * 0.34',
    '          + starLayer(p, 130.0, 0.93, uTime) * 0.20;',
    /* star density follows the band, the way it does in a real sky */
    '  float ang2 = -0.46;',
    '  float by2 = p.x * sin(ang2) + p.y * cos(ang2);',
    '  s *= 0.55 + 0.85 * exp(-by2 * by2 * 1.2);',
    '  c += vec3(0.82, 0.88, 1.0) * s * mix(1.0, 0.38, uHasCover) * (1.0 - uSkyMode);',
    /* Deep space is mostly dark — the drama is the CONTRAST between the voids
       and the hot filaments, not the average level. Pulling the whole frame
       down keeps the nebula structure while letting page copy sit on top of it
       without a scrim. */
    '  c *= mix(0.72, 1.0, uHasCover);',
    '  c *= 1.0 - mix(0.38, mix(0.46, 0.22, clamp(uExposure - 0.45, 0.0, 1.0)), uHasCover) * dot(vUv, vUv);',
    '  c += (h21(gl_FragCoord.xy) - 0.5) * 0.010;',       /* anti-banding */
    '  gl_FragColor = vec4(max(c, 0.0), 1.0);',
    '}'
  ].join('\n');

  /* ═══════════════════════════════════════════════════════════════════════
     FIELD — the wallpaper dissolved. danceAt() is ported whole.
     ═══════════════════════════════════════════════════════════════════════ */
  var FIELD_VS = [
    'precision highp float;',
    'attribute vec2 aHome;',
    'attribute vec2 aSeed;',
    /* The app reads the wallpaper in the vertex shader (uCoverTex). On the web
       that is a vertex texture fetch, and its own comments warn those units can
       be 0 under ANGLE software rendering — every particle would come back
       black. Sampling the image once on the CPU into this attribute is exact,
       free per frame, and works everywhere. */
    'attribute vec3 aColor;',
    'uniform float uTime, uBloom, uDpr, uHasCover, uExposure;',
    'uniform vec2 uAspect;',
    'uniform mat4 uViewProj;',
    'uniform float uCamR, uDepth, uSlab;',
    'uniform vec3 uRipples[' + MAX_RIPPLES + '];',
    'uniform float uDanceAmt, uDanceMode, uDanceT;',
    'uniform vec2 uDanceCenter, uDanceDir;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    SPACE_GLSL,

    /* ── danceAt — mineradio-shaders.js:130, all ten modes ── */
    'vec3 danceAt(vec2 p, float rnd){',
    '  if (uDanceAmt < 0.001) return vec3(0.0);',
    '  vec2 d = p - uDanceCenter;',
    '  float dist = length(d);',
    '  float t = uDanceT;',
    '  float reach = exp(-dist * dist / 1.55);',
    '  vec3 o = vec3(0.0);',
    '  float m = uDanceMode;',
    '  if (m < 0.5){',                                    /* 0 行云 */
    '    float ph = dot(p, uDanceDir) * 2.6 - t * 1.15;',
    '    o.z = sin(ph) * 0.44; o.xy = uDanceDir * cos(ph) * 0.035;',
    '  } else if (m < 1.5){',                             /* 1 回旋 */
    '    float a = 0.42 * reach * sin(t * 0.85);',
    '    float c = cos(a), s = sin(a);',
    '    o.xy = mat2(c, -s, s, c) * d - d;',
    '    o.z = reach * sin(t * 1.25 + dist * 1.3) * 0.30;',
    '  } else if (m < 2.5){',                             /* 2 呼吸 */
    '    float b = sin(t * 1.05) * reach;',
    '    o.xy = d / max(dist, 0.001) * b * 0.115; o.z = b * 0.38;',
    '  } else if (m < 3.5){',                             /* 3 摇曳 */
    '    float sway = sin(t * 0.95 + p.y * 1.6 + rnd * 1.3);',
    '    o.x = sway * (0.035 + abs(p.y) * 0.022); o.z = sway * 0.20 * (0.35 + reach);',
    '  } else if (m < 4.5){',                             /* 4 星落 */
    '    float ph = t * 1.45 + rnd * 6.2831;',
    '    o.z = sin(ph) * 0.32 * (0.40 + reach);',
    '    o.xy = vec2(cos(ph * 0.7), sin(ph * 0.5)) * 0.018;',
    '  } else if (m < 5.5){',                             /* 5 涟纹 */
    '    float ph = dot(p, uDanceDir) * 5.6 + sin(t * 0.55) * 1.5;',
    '    o.z = sin(ph) * cos(dist * 1.45 - t * 0.75) * 0.38;',
    '    o.xy = uDanceDir * sin(ph) * 0.021;',
    '  } else if (m < 6.5){',                             /* 6 星涡 */
    '    float a = 0.52 * reach * sin(t * 0.62) + dist * 0.48 * sin(t * 0.30);',
    '    float c = cos(a), s = sin(a);',
    '    o.xy = mat2(c, -s, s, c) * d - d;',
    '    o.z = sin(dist * 2.9 - t * 1.10) * 0.30 * (0.35 + reach);',
    '  } else if (m < 7.5){',                             /* 7 潮汐 */
    '    float ph = p.y * 1.35 + t * 0.42;',
    '    o.z = sin(ph) * 0.30 + sin(p.x * 0.84 - t * 0.31) * 0.22;',
    '    o.xy = vec2(sin(t * 0.36 + p.y * 0.70) * 0.032, cos(t * 0.28) * 0.019);',
    '  } else if (m < 8.5){',                             /* 8 心跳 */
    '    float bt = fract(t * 0.46);',
    '    float env = exp(-bt * 3.2) + 0.62 * exp(-fract(bt + 0.72) * 3.6);',
    '    float ring = sin(dist * 7.7 - t * 3.0);',
    '    o.z = ring * env * 0.46 * (0.30 + reach);',
    '    o.xy = d / max(dist, 0.001) * ring * env * 0.032;',
    '  } else {',                                         /* 9 落雪 */
    '    float ph = fract(t * 0.10 + rnd);',
    '    float win = sin(ph * 3.14159);',
    '    o.y = -ph * 0.30 * win;',
    '    o.x = sin(t * 0.7 + rnd * 12.0) * 0.026 * win;',
    '    o.z = win * 0.16;',
    '  }',
    '  return o * uDanceAmt;',
    '}',

    'void main(){',
    '  vec2 p = aHome * uAspect;',
    '  float t = uTime, s1 = aSeed.x, s2 = aSeed.y;',

    /* base drift — the resting current under the choreography */
    '  float ph = s1 * 6.2831;',
    '  vec2 disp = vec2(',
    '    sin(t * (0.22 + s2 * 0.28) + ph + p.y * 1.5),',
    '    cos(t * (0.17 + s1 * 0.24) + ph * 1.7 - p.x * 1.3)',
    '  ) * (0.009 + s2 * 0.014);',

    '  vec3 dnc = danceAt(p, s1);',
    '  disp += dnc.xy;',

    '  float ripAmp = abs(dnc.z) * 0.55;',
    '  for (int i = 0; i < ' + MAX_RIPPLES + '; i++){',
    '    vec3 r = uRipples[i];',
    '    if (r.z <= 0.0 || r.z >= 1.0) continue;',
    '    vec2 d = p - r.xy * uAspect;',
    '    float dist = max(length(d), 0.0001);',
    '    float ring = exp(-pow((dist - r.z * 1.55) / 0.16, 2.0)) * (1.0 - r.z);',
    '    disp += (d / dist) * ring * 0.085;',
    '    ripAmp = max(ripAmp, ring);',
    '  }',

    /* ── into three dimensions ──────────────────────────────────────────
       danceAt() has always returned a real o.z — all ten modes displace in
       depth — and this line used to read `vec4((p+disp)/uAspect, 0.0, 1.0)`,
       which threw every one of them away. The field was a 3D choreography
       being watched through a flattening lens.

       uSlab is the other half, and it is the half that makes the field read
       as a volume rather than as a sheet with a wobble: a fixed per-particle
       depth, so the cloud has real thickness even at rest, when the dance
       envelope is down at 0.16 and every particle would otherwise be within a
       hair of the same plane. The hash decorrelates it from aSeed's other
       jobs (drift phase, twinkle rate) — reusing s2 directly would tie a
       particle's depth to how fast it blinks. */
    '  float dz = fract(sin(dot(aSeed, vec2(41.73, 289.31))) * 43758.5453) - 0.5;',
    '  vec3 world = vec3(p + disp, dnc.z * uDepth + dz * uSlab);',
    '  vec4 clip = uViewProj * vec4(world, 1.0);',
    '  gl_Position = clip;',
    /* Perspective size falloff. At the resting pose clip.w == uCamR exactly,
       so this term is 1.0 and the point sizes are the ones the flat field
       drew. */
    '  float persp = uCamR / max(clip.w, 0.35);',

    '  float tw = pow(0.5 + 0.5 * sin(t * (0.9 + s2 * 1.7) + s1 * 17.0), 5.0);',
    /* density banks so the field drifts in clouds, never an even speckle */
    '  float cloud = 0.5 + 0.5 * sin(p.x * 1.05 + t * 0.10) * cos(p.y * 1.35 - t * 0.08);',
    '  cloud = 0.18 + 0.82 * smoothstep(0.10, 0.94, cloud);',

    /* colour from the wallpaper, lifted — a galaxy is dark, so the particles
       need the gain the app gets from uColorBoost */
    '  vec3 bed = procColor(aHome * uAspect, t);',
    '  bed = pow(max(bed * 3.1, 0.0), vec3(1.0 / 1.65));',
    '  bed = max(bed, vec3(0.055, 0.075, 0.125));',
    '  vec3 cov = pow(max(aColor * 1.90 * uExposure, 0.0), vec3(1.0 / 1.45));',
    '  cov = max(cov, vec3(0.075, 0.090, 0.135));',
    '  bed = mix(bed, cov, uHasCover);',
    '  vColor = mix(bed, vec3(0.86, 0.93, 1.0), tw * 0.30) * (0.85 + tw * 0.55 + ripAmp * 0.9);',
    /* Aerial perspective: the back of the slab sits back. Without this the
       far particles stay as bright as the near ones and the volume reads
       flat again no matter how much parallax the camera gives it. */
    '  vAlpha = (0.075 + tw * 0.24 + ripAmp * 0.38) * cloud * clamp(0.34 + persp * 0.72, 0.30, 1.35);',
    '  gl_PointSize = (1.2 + tw * 1.3) * uDpr * uBloom * clamp(persp, 0.45, 2.6);',
    '}'
  ].join('\n');

  /* ═══════════════════════════════════════════════════════════════════════
     GLYPH — one dense lattice per slot. dispAt() ported whole.
     ═══════════════════════════════════════════════════════════════════════ */
  var GLYPH_VS = [
    'precision highp float;',
    'attribute vec2 aUv;',
    'attribute float aRand;',
    'attribute float aOn;',
    'uniform float uForm, uVis, uOut, uInMode, uOutMode, uStagger, uTime, uBloom, uDpr, uPtPx;',
    'uniform vec2 uCenter, uSize, uDrift, uAspect;',
    'uniform mat4 uViewProj;',
    'uniform float uCamR;',
    'uniform vec3 uTint;',
    'varying vec3 vColor;',
    'varying float vA;',

    /* ── dispAt — mineradio-wallpaper.js:206, all nine handwritings ── */
    'vec2 dispAt(float mode, float u, vec2 rel){',
    '  float a = aRand * 6.2831;',
    '  if (mode < 0.5) return vec2(cos(a), sin(a)) * (0.16 + aRand * 0.40) * u;',
    '  else if (mode < 1.5) return vec2(sin(aRand * 31.0) * 0.10, 0.32 + aRand * 0.62) * u;',
    '  else if (mode < 2.5){',
    '    float ang = u * 2.6 * (0.55 + aRand * 0.90);',
    '    float c = cos(ang), s = sin(ang);',
    '    return mat2(c, -s, s, c) * rel * (1.0 + u * 1.15) - rel;',
    '  }',
    '  else if (mode < 3.5) return vec2(-0.86 * u, sin(aRand * 17.0) * 0.065 * u);',
    '  else if (mode < 4.5) return vec2(cos(a), sin(a)) * (0.02 + aRand * 0.09) * u * u;',
    '  else if (mode < 5.5){',
    '    float ang = a + u * 2.6;',
    '    return vec2(cos(ang), sin(ang)) * (0.70 * u);',
    '  }',
    '  else if (mode < 6.5){',
    '    vec2 dir = rel / max(length(rel), 0.001);',
    '    return dir * (u * (0.34 + aRand * 0.68)) + vec2(cos(a), sin(a)) * u * 0.13;',
    '  }',
    '  else if (mode < 7.5) return uDrift * (u * 0.95) + vec2(0.0, sin(aRand * 23.0) * 0.09 * u);',
    '  return vec2(sin(aRand * 19.0) * 0.085, -(0.28 + aRand * 0.52)) * u;',
    '}',

    'void main(){',
    '  vec2 target = uCenter + (aUv - vec2(0.5)) * uSize;',
    '  vec2 rel = target - uCenter;',
    '  float amt = 1.0 - uForm;',
    '  float mode = uOut > 0.0 ? uOutMode : uInMode;',
    '  float ord = fract(aRand * 7.13);',
    '  float u = clamp((amt - ord * uStagger) / max(1e-3, 1.0 - uStagger), 0.0, 1.0);',
    '  vec2 d = dispAt(mode, u, rel);',
    /* ── the line rides the camera, but never turns with it ─────────────
       The glyph plane is BILLBOARDED: only the line's CENTRE goes through the
       camera, and the letterform is then laid out flat around wherever that
       centre landed. The app slerps 0.85 toward the camera rather than 1.0,
       keeping a little tilt, because there the text is decoration on your own
       desktop. Here it is copy on a marketing page that a visitor is actually
       reading — a sheared "1.2M tok month" is a rendering fault, not depth —
       so it is a full billboard.

       What the camera still gives it is the two things that sell the volume:
       PARALLAX (the line slides against the particles as the view swings,
       because it sits at z=0 inside a slab that spans ±uSlab/2) and SCALE
       (uCamR/w shrinks it as the camera pulls back). At the resting pose
       cc.w == uCamR exactly, so this reduces to `target + d` — the flat
       formula it replaces, bit for bit. */
    '  vec4 cc = uViewProj * vec4(uCenter * uAspect, 0.0, 1.0);',
    '  float w = max(cc.w, 0.35);',
    '  float persp = uCamR / w;',
    '  gl_Position = vec4(cc.xy / w + (target - uCenter + d) * persp, 0.0, 1.0);',
    '  vColor = uTint;',
    /* twinkle deeper than the field's so the text reads as ALIVE, not printed;
       the (1 - u) term means scattered particles are dim and only the ones that
       have landed on a stroke burn — that is what makes it snap into focus */
    /* Twinkle amplitude falls away as the line forms. While the particles are
       still flying, a deep flicker is what makes them read as embers; once they
       have LANDED on a stroke, that same flicker is just noise chewing holes in
       the letterforms, so a formed line sits almost steady. */
    '  float amp = mix(0.45, 0.13, uForm);',
    '  vA = aOn * uVis * ((1.0 - amp) + amp * sin(uTime * 3.4 + aRand * 21.0)) * (1.0 - u * 0.55);',
    /* uPtPx is one lattice cell measured in device pixels, computed on the CPU
       where the on-screen size of the box is actually known. It used to be a
       constant 2.3-4.3 CSS px scaled by dpr — up to 8.6 device px per particle,
       against a cell that is only 1.2-2.8 device px wide. Every dot was three to
       seven times its own cell, so neighbouring dots buried each other and the
       strokes fused into a smear. Sizing to the lattice is what makes the text
       legible; the small uForm term keeps a little swell as it lands. */
    '  gl_PointSize = max(1.0, uPtPx * (0.90 + 0.10 * uForm) * clamp(persp, 0.5, 2.2)) * uBloom;',
    '}'
  ].join('\n');

  /* Shared point fragment shader — makeDotTexture()'s 64px radial ramp,
     evaluated instead of sampled (0.96 / 0.78 / 0.22 / 0). */
  var PT_FS = [
    'precision highp float;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'uniform float uAlphaScale;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5) * 2.0;',
    '  if (d > 1.0) discard;',
    '  float f = d < 0.42 ? mix(0.96, 0.78, d / 0.42)',
    '          : d < 0.72 ? mix(0.78, 0.22, (d - 0.42) / 0.30)',
    '                     : mix(0.22, 0.00, (d - 0.72) / 0.28);',
    '  gl_FragColor = vec4(vColor * f, 1.0) * vAlpha * uAlphaScale;',
    '}'
  ].join('\n');
  /* The glyph sprite is NOT the field's sprite. PT_FS starts falling off at the
     very centre (0.96 at d=0, 0.78 by d=0.42), which is right for a star — it
     has no edge — and wrong for a letter, which is nothing but edges. Held flat
     across the core and dropped hard at the rim, the dots tile into a stroke
     instead of dissolving into one another. */
  var GLYPH_FS = [
    'precision highp float;',
    'varying vec3 vColor;',
    'varying float vA;',
    'uniform float uAlphaScale, uMode;',
    'uniform vec3 uHalo;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5) * 2.0;',
    '  if (d > 1.0) discard;',
    /* uMode 0 = the dot itself; 1 = its halo. Both are PREMULTIPLIED, and the
       caller picks the blend: OVER for halo and body, ADD only for the bloom.
       The old shader wrote colour with alpha pinned to 1 under ONE,ONE — so a
       particle could only ever ADD to the plate. Over a white cloud there is
       nothing left to add to, which is exactly where users could not read it. */
    '  float f = 1.0 - smoothstep(0.55, 1.0, d);',
    '  if (uMode > 0.5) {',
    '    float h = (1.0 - smoothstep(0.15, 1.0, d)) * vA * uAlphaScale;',
    '    h = clamp(h, 0.0, 1.0);',
    '    gl_FragColor = vec4(uHalo * h, h);',
    '  } else {',
    '    float c = clamp(f * vA * uAlphaScale, 0.0, 1.0);',
    '    gl_FragColor = vec4(vColor * c, c);',
    '  }',
    '}'
  ].join('\n');

  /* ── The code city ────────────────────────────────────────────────────────
     sampleCity() (terse-city.js, generated from the app) hands back real 3D
     positions in a roughly ±1.6 cube, plus a colour and a per-particle size
     class — ground, wall, window and label all want different dots, and a name
     drawn with wall-sized dots is a solid bar rather than a word.

     This is the one layer that is genuinely three-dimensional. The field is a
     slab and the text is billboarded flat, but a skyline has to be a skyline:
     it goes through uViewProj unmodified, so the same orbit that parallaxes
     the field also walks the camera around the city. */
  var CITY_VS = [
    'precision highp float;',
    'attribute vec3 aCPos;',
    'attribute vec3 aCCol;',
    'attribute float aCScl;',
    'uniform mat4 uViewProj;',
    'uniform float uCamR, uPtPx, uForm, uVis, uScale, uTime, uSat, uGain;',
    'uniform vec3 uOrigin;',
    'varying vec3 vColor;',
    'varying float vA;',

    'float h11(float p){ return fract(sin(p * 127.1 + 311.7) * 43758.5453); }',

    'void main(){',
    /* One hash per particle, off its own resting position — no extra attribute
       buffer for something that is a pure function of where it belongs. */
    '  float r = h11(dot(aCPos, vec3(12.9898, 78.233, 37.719)));',
    '  float amt = 1.0 - uForm;',
    /* Staggered like the glyph layer: without it the whole city snaps in as
       one rigid block instead of assembling. */
    '  float u = clamp((amt - fract(r * 7.13) * 0.55) / 0.45, 0.0, 1.0);',
    /* A city should GROW, not fly in. Particles start sunk below the ground
       plane and spread outward on the horizontal, so the skyline rises out of
       the terrain rather than converging from the sky like the text does. */
    '  float a = r * 6.2831;',
    '  vec3 disp = vec3(cos(a), 0.0, sin(a)) * (0.30 + r * 0.55) * u',
    '            + vec3(0.0, -1.15 * u, 0.0);',
    '  vec3 world = uOrigin + (aCPos + disp) * uScale;',
    '  vec4 clip = uViewProj * vec4(world, 1.0);',
    '  gl_Position = clip;',
    /* Same perspective falloff the field uses, so a tower at the back of the
       city genuinely reads as further away. */
    '  float persp = uCamR / max(clip.w, 0.35);',
    '  gl_PointSize = max(1.0, uPtPx * persp * aCScl);',
    /* A slow shimmer on the windows only (the bright end of the scale range),
       so the lit ones look alive while the masonry stays still. */
    '  float tw = 0.86 + 0.14 * sin(uTime * 2.1 + r * 21.0);',
    /* Per-wallpaper saturation and gain, never hue: the colour bands ARE the
       language reading, so a wallpaper may make them deeper or brighter but
       must never turn Rust into something else. */
    '  float lm = dot(aCCol, vec3(0.2126, 0.7152, 0.0722));',
    '  vec3 cc = clamp(mix(vec3(lm), aCCol, uSat) * uGain, 0.0, 1.0);',
    '  vColor = cc * mix(1.0, tw, step(0.9, aCScl));',
    '  vA = uVis * (1.0 - u * 0.72);',
    '}'
  ].join('\n');

  /* ── Colour that fits the wallpaper ───────────────────────────────────────
     Measured, not guessed: on all 20 shipped wallpapers the mint accent had a
     bare contrast of 1.01-1.84 against the bright part of the hero band on 18
     of them, white copy cleared 3:1 on only two, and additive particle text fell
     to 1.35-2.8 on every bright sky. The plates also sit almost entirely at
     177-229 degrees — sky blue — which is exactly where mint and sky-blue live,
     so nothing looked vivid even where it was technically legible.

     So colour is chosen per wallpaper, from the part of the plate that is
     actually on screen (the same image differs a lot between a desktop crop and
     a portrait one), and per LINE for the particle text, from the pixels under
     where that line landed. WCAG relative luminance throughout. */
  var PALETTE = [
    [0.431, 0.906, 0.718],   /* mint — the brand, preferred when it reads */
    [0.788, 0.941, 0.239],   /* lime   */
    [0.984, 0.749, 0.141],   /* amber  */
    [0.984, 0.443, 0.522],   /* coral  */
    [0.957, 0.447, 0.714],   /* pink   */
    [0.769, 0.710, 0.992],   /* violet */
    [0.490, 0.827, 0.988],   /* sky    */
    [0.133, 0.827, 0.933]    /* cyan   */
  ];
  var MINT = PALETTE[0];
  /* Colour carries MEANING on this page, so not every colour may go everywhere.
     The accent paints 152 elements on the home page, and 36 of them are good
     news: the check column of the comparison table, the savings percentages
     (-64%, -99%), "token 账单减少约 70%", NEW and LIVE. Coral or pink on "-64%
     saved" reads as a LOSS. So the red family is never the page accent, and on
     particle lines it is reserved for the cost lines, where red-ish is the
     right meaning. Amber is allowed for neutral lines but not for good news. */
  var POSITIVE = [PALETTE[0], PALETTE[1], PALETTE[6], PALETTE[7], PALETTE[5]];            /* mint lime sky cyan violet */
  var NEUTRAL  = [PALETTE[0], PALETTE[1], PALETTE[2], PALETTE[5], PALETTE[6], PALETTE[7]]; /* + amber, no coral/pink */
  function lin1(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function relLum(c) { return 0.2126 * lin1(c[0]) + 0.7152 * lin1(c[1]) + 0.0722 * lin1(c[2]); }
  /* sRGB byte -> linear, precomputed: the colour map reads every pixel of the
     plate, and lin1's Math.pow per channel is most of that cost. */
  var LIN = []; for (var li = 0; li < 256; li++) LIN.push(lin1(li / 255));
  function contrast(a, b) { var hi = a > b ? a : b, lo = a > b ? b : a; return (hi + 0.05) / (lo + 0.05); }
  function hueSat(c) {
    var r = c[0], g = c[1], b = c[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0];
  }
  function hslRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [r + m, g + m, b + m];
  }
  /** Pick the colour for a patch of plate.
   *
   *  Legibility is a FLOOR, not a term in a sum. The first version scored
   *  0.55 x hue-distance + 0.45 x contrast, and the audit over all 20 plates
   *  showed what that does: it chose coral and pink for their distance from
   *  the blue sky, and they are far darker than mint, so the accent got WORSE
   *  on 8 wallpapers (moonlit meadow 6.2 -> 2.1). Now every candidate is
   *  measured the way the page actually shows it — against the bright end of
   *  the patch as darkened by the halo ring — and only colours at 4.5:1 or
   *  better are eligible. Among those the most vivid wins (hue distance,
   *  weighted by how saturated the plate is), with a bonus for the preferred
   *  colour so the brand mint stays wherever it genuinely reads. If nothing
   *  clears 4.5, the most legible candidate wins outright. */
  function pickTint(p, preferred, haloL, haloA, pool) {
    var bgL = p.p90 * (1 - haloA) + haloL * haloA;
    var base = pool || PALETTE;
    var cands = preferred ? base.concat([preferred]) : base;
    var best = null, bestS = -1, top = cands[0], topC = 0;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], cr = contrast(relLum(c), bgL);
      if (cr > topC) { topC = cr; top = c; }
      if (cr < 4.5) continue;
      var hs = hueSat(c), dh = Math.abs(hs[0] - p.hue); if (dh > 180) dh = 360 - dh;
      var sc = (dh / 180) * (0.35 + 0.65 * Math.min(1, p.sat * 2))
             + (c === preferred ? 0.18 : 0) + Math.min(0.15, (cr - 4.5) * 0.03);
      if (sc > bestS) { bestS = sc; best = c; }
    }
    return best || top;
  }

  /* ── GL helpers ─────────────────────────────────────────────────────────── */
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      if (window.console) console.warn('[terse-field]', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  function program(gl, v, f) {
    var vs = compile(gl, gl.VERTEX_SHADER, v), fs = compile(gl, gl.FRAGMENT_SHADER, f);
    if (!vs || !fs) return null;
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (window.console) console.warn('[terse-field]', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }
  function u(gl, p, names) {
    var o = {}; for (var i = 0; i < names.length; i++) o[names[i]] = gl.getUniformLocation(p, 'u' + names[i][0].toUpperCase() + names[i].slice(1));
    return o;
  }
  function ease(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }

  /* ═══════════════════════════════════════════════════════════════════════
     THE CAMERA — a port of src/renderer/wallpaper-view3d.js (the app's Pro
     「3D 自由视角」). Same spherical model, same sensitivities, same exactness
     rule; only the LIMITS differ, and deliberately so. In the app this field
     IS the screen and the user is holding it, so it opens to 66°. Here it is
     the background behind a page of copy — swing it that far and the reader
     is on a boat. The ranges below are the widest that still read as "someone
     is flying this" without the text appearing to move.

     Everything the choreography already computes in 3D is finally used: the
     ten danceAt() modes each return a real o.z, and every one of them was
     being thrown away by `gl_Position = vec4(..., 0.0, 1.0)`.
     ═══════════════════════════════════════════════════════════════════════ */

  /* Reference distance — and the strength of the whole effect. It is the only
     number here that decides how three-dimensional the field looks, because it
     sets the field of view: the slab is a fixed depth, so a nearer camera sees
     more difference between its front and its back. At 3.0 a front particle was
     23% bigger than a back one and it read as a flat field with a wobble. At
     2.35 it is 44%, and the cloud has an inside.

     Lower still starts to fish-eye the corners on a wide monitor. sx/sy are
     derived from THIS, never from the live radius, which is what leaves dist
     free to zoom instead of cancelling itself out. */
  var CAM_R = 2.35;

  var VIEW_AZ_MAX = 0.30, VIEW_EL_MAX = 0.185;
  /* Mostly zoom IN. Pulling back shrinks the particle sheet away from the
     screen edge, and past the overscan below that reads as the field ending;
     pushing in only ever crops. */
  var VIEW_DIST_MIN = 0.74, VIEW_DIST_MAX = 1.07;
  /* Seed the sheet wider than the screen so a rotated or pulled-back field
     never shows its own edge. 1.07 dist insets 6.5%, 0.30rad az insets 4.5%,
     and the back of the slab now pulls in 15% of its own accord as it recedes.
     24% covers all three; below that the far particles thin out along the edges
     and you can see where the sheet stops. */
  var FIELD_OVERSCAN = 1.24;

  /* The app's numbers: one screen-width of drag ≈ half a turn. */
  var ORBIT_AZ_PER_PX = 0.0062, ORBIT_EL_PER_PX = 0.0048;

  /* az=el=0, dist=1 must give EXACTLY (0,0,r) — not 1e-17 off it. Everything
     below (reduced-motion, the pre-first-gesture frames, the resting pose the
     demo returns to) has to render bit-identically to the flat field this
     replaced, and a camera a hair off axis moves every particle a hair. */
  function orbitPosition(r, az, el) {
    var ce = Math.cos(el), se = Math.sin(el);
    return { x: r * ce * Math.sin(az), y: r * se, z: r * ce * Math.cos(az) };
  }

  /* Shortest way round. Handing back from a drag that wrapped past ±180°
     should travel 2°, not 358°. */
  function shortestArc(from, to) {
    var d = to - from, TAU = Math.PI * 2;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  /* view-projection, column-major for uniformMatrix4fv.

     The projection is deliberately degenerate in Z (row 2 is all zeros, so
     gl_Position.z is always 0). There is no depth buffer here — the context is
     created with depth:false and the blend is additive, so ordering is free —
     and a zeroed clip z can never fall outside [-w, w]. A conventional
     near/far would start clipping particles out of the slab for no gain. */
  function viewProj(out, az, el, dist, aspectX, aspectY) {
    var r = CAM_R * dist;
    var eye = orbitPosition(r, az, el);
    /* forward = normalize(origin - eye) = -eye/r */
    var fx = -eye.x / r, fy = -eye.y / r, fz = -eye.z / r;
    /* s = normalize(cross(f, up)) with up = +Y, which expands to (-f.z, 0, f.x).
       |el| <= 0.185 so this never degenerates. */
    var sx0 = -fz, sy0 = 0, sz0 = fx;
    var sl = Math.sqrt(sx0 * sx0 + sz0 * sz0) || 1;
    sx0 /= sl; sz0 /= sl;
    /* u = cross(s, f) */
    var ux = sy0 * fz - sz0 * fy, uy = sz0 * fx - sx0 * fz, uz = sx0 * fy - sy0 * fx;
    var ds = sx0 * eye.x + sy0 * eye.y + sz0 * eye.z;
    var du = ux * eye.x + uy * eye.y + uz * eye.z;
    var df = fx * eye.x + fy * eye.y + fz * eye.z;
    /* At z=0 this reproduces the old `p / uAspect` exactly. */
    var px = CAM_R / aspectX, py = CAM_R / aspectY;
    /* rows: [px*s, py*u, 0, f] → transposed into columns */
    out[0] = px * sx0; out[4] = px * sy0; out[8]  = px * sz0; out[12] = px * -ds;
    out[1] = py * ux;  out[5] = py * uy;  out[9]  = py * uz;  out[13] = py * -du;
    out[2] = 0;        out[6] = 0;        out[10] = 0;        out[14] = 0;
    out[3] = fx;       out[7] = fy;       out[11] = fz;       out[15] = -df;
    return out;
  }
  /* Ask every source, because there are real situations — a webview still
     laying out, a background-restored tab, an offscreen iframe — where the
     first two report 0. Returning 0 is the honest answer; the caller must wait
     rather than clamp, because clamping 0 to 1 silently poisons every ratio
     computed from it. */
  function vw() {
    /* clientWidth, not max(innerWidth, clientWidth). If anything on the page
       overflows horizontally, innerWidth follows it and the canvas sizes itself
       to the overflow — which then keeps the document wide on its own. Taking
       the smaller of the two makes the field a passenger rather than a cause. */
    var c = (document.documentElement && document.documentElement.clientWidth) || 0;
    return c || window.innerWidth || 0;
  }
  function vh() {
    /* documentElement.clientHeight only — NOT document.body.clientHeight, which
       is the height of the whole document (68,000px on this page), not of the
       viewport. Folding it in here would size the canvas to the scroll height. */
    return Math.max(window.innerHeight || 0,
                    (document.documentElement && document.documentElement.clientHeight) || 0);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Field
     ═══════════════════════════════════════════════════════════════════════ */
  function Field(canvas) {
    this.c = canvas; this.ok = false;
    var opts = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
    var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) return;
    this.gl = gl;

    this.bedProg = program(gl, BED_VS, BED_FS);
    this.fldProg = program(gl, FIELD_VS, PT_FS);
    this.glyProg = program(gl, GLYPH_VS, GLYPH_FS);
    if (!this.bedProg || !this.fldProg || !this.glyProg) return;

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.bHome = gl.createBuffer();
    this.bSeed = gl.createBuffer();
    this.bColor = gl.createBuffer();

    this.uBed = u(gl, this.bedProg, ['time', 'aspect', 'hasCover', 'coverScale', 'coverDrift', 'cover', 'exposure', 'soften',
                                     'skyMode', 'skySeed', 'skyTop', 'skyHaze', 'skySun', 'sunPos']);
    this.uFld = u(gl, this.fldProg, ['time', 'bloom', 'dpr', 'aspect', 'ripples', 'alphaScale', 'hasCover', 'exposure',
                                     'skyMode', 'skySeed', 'skyTop', 'skyHaze', 'skySun', 'sunPos',
                                     'danceAmt', 'danceMode', 'danceT', 'danceCenter', 'danceDir',
                                     'viewProj', 'camR', 'depth', 'slab']);
    this.uGly = u(gl, this.glyProg, ['form', 'vis', 'out', 'inMode', 'outMode', 'stagger', 'time',
                                     'bloom', 'dpr', 'ptPx', 'center', 'size', 'drift', 'aspect', 'tint', 'alphaScale',
                                     'viewProj', 'camR', 'mode', 'halo']);

    this.aBedPos = gl.getAttribLocation(this.bedProg, 'aPos');
    this.aHome = gl.getAttribLocation(this.fldProg, 'aHome');
    this.aSeed = gl.getAttribLocation(this.fldProg, 'aSeed');
    this.aColor = gl.getAttribLocation(this.fldProg, 'aColor');
    this.aUv = gl.getAttribLocation(this.glyProg, 'aUv');
    this.aRand = gl.getAttribLocation(this.glyProg, 'aRand');
    this.aOn = gl.getAttribLocation(this.glyProg, 'aOn');

    /* ── city layer ──────────────────────────────────────────────────────────
       Optional on purpose: terse-city.js is a separate 60KB script, and if a
       page does not load it (or it fails), the field and the text must carry on
       exactly as before. Everything below is guarded on this.cityProg. */
    if (window.TerseCity) {
      this.cityProg = program(gl, CITY_VS, GLYPH_FS);
      if (this.cityProg) {
        this.uCity = u(gl, this.cityProg, ['viewProj', 'camR', 'ptPx', 'form', 'vis',
                                           'scale', 'time', 'origin', 'alphaScale', 'mode', 'halo', 'sat', 'gain']);
        this.aCPos = gl.getAttribLocation(this.cityProg, 'aCPos');
        this.aCCol = gl.getAttribLocation(this.cityProg, 'aCCol');
        this.aCScl = gl.getAttribLocation(this.cityProg, 'aCScl');
        this.bCPos = gl.createBuffer();
        this.bCCol = gl.createBuffer();
        this.bCScl = gl.createBuffer();
        /* used = 0 until the first city is built; nextCityAt staggers the first
           one so the page does not open with a skyline already growing. */
        this.city = { used: 0, live: null, form: 0, vis: 0, style: '', styleRot: (Math.random() * 8) | 0 };
        this.nextCityAt = 2200;
      }
    }

    this._buildGlyphLattice();

    this.rip = new Float32Array(MAX_RIPPLES * 3);
    this.ripples = [];
    this.dance = { amt: 0, mode: 7, t: 0, cx: 0, cy: 0, dx: 1, dy: 0 };
    this.logRot = 0; this.statRot = 0;
    this.glyphIdx = 0; this.glyphSide = 1;
    this.nextFillAt = 0;
    this.t = 0; this.raf = 0;

    /* The camera, and the hand on it. `az/el/dist` are what gets rendered;
       `to*` is where the current gesture is taking them. `grab` is a real
       pointer holding it, which outranks the demo. */
    this.view = {
      az: 0, el: 0, dist: 1,
      fromAz: 0, fromEl: 0, fromDist: 1,
      toAz: 0, toEl: 0, toDist: 1,
      t: 0, dur: 0, hold: 1400, kind: 'rest',
      grab: null, vAz: 0, vEl: 0, idle: 0, on: !REDUCE
    };
    this.vp = new Float32Array(16);

    this.off = document.createElement('canvas');
    this.off.width = MW; this.off.height = MH;
    this.octx = this.off.getContext('2d', { willReadFrequently: true });

    /* wallpaper bed state */
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([8, 9, 16]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.hasCover = 0; this.coverAspect = 1; this.bedName = null;
    this.skyMode = 0; this.sky = SKIES[0]; this.skySeed = 0;
    this.sunPos = [0.35, -0.05]; this.skyName = null;
    this.exposure = 1; this.bedLum = 0; this.bedVar = 0; this.soften = 0;
    /* Colour theme, re-derived from the plate every time the wallpaper changes
       (_theme). These defaults are the dark-galaxy values: a faint halo, full
       bloom, city colours untouched. */
    this.haloRGB = [0.106, 0.048, 0.252];
    this.cityTheme = { haloK: 0.35, sat: 1.0, gain: 1.0 };
    this.samp = document.createElement('canvas');
    this.sctx = this.samp.getContext('2d', { willReadFrequently: true });
    this.bedPix = null;

    this.ok = true;
    this.resize();
  }

  /* One point cloud, shared by all four slots — only the stroke mask differs.
   *
   * This used to be a rigid GW×GH lattice: one particle per mask texel, on a
   * perfect grid. That is what made the text look like a screen door rather
   * than like the app's. Two things go wrong with a grid, and no amount of
   * point-size tuning fixes either:
   *
   *   · a regular grid beats against the pixel grid it is drawn onto, so the
   *     strokes shimmer and alias instead of reading as solid;
   *   · density is capped by the LATTICE, not by the particle budget — every
   *     stroke is exactly one particle per cell, so letters can never get
   *     denser or brighter than the grid allows.
   *
   * The real wallpaper engine (src/renderer/mineradio-wallpaper.js:471) does it
   * the other way round: every particle keeps a fixed RANDOM uv it was born
   * with, and simply asks the mask "am I on a stroke?". No grid to alias, and
   * density is set by how many particles you spend. Its budget is 60000 per
   * line, with the comment that this is "the whole reason the text reads as
   * dense, bright and sharp rather than as a dusting of dots" — against the
   * 16384 a 256×64 lattice allowed here. Same model, same number. */
  Field.prototype._buildGlyphLattice = function () {
    var gl = this.gl, n = GLYPH_N;
    var uv = new Float32Array(n * 2), rnd = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      uv[i * 2] = Math.random();
      uv[i * 2 + 1] = Math.random();
      rnd[i] = Math.random();
    }
    this.glyphN = n;
    /* kept on the CPU too — the mask is now sampled at each particle's own uv */
    this.glyphUv = uv;
    this.bUv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bUv); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    this.bRand = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bRand); gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);

    this.slots = [];
    for (var s = 0; s < SLOTS; s++) {
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(n), gl.DYNAMIC_DRAW);
      this.slots.push({
        onBuf: buf, mask: new Float32Array(n),
        live: null, form: 0, vis: 0, out: 0,
        inMode: 0, outMode: 0, stagger: 0,
        cx: 0, cy: 0, sx: 0.6, sy: 0.15,
        tint: TINTS.tool, driftX: 0, driftY: 0, haloK: 0.4, bloomK: 1
      });
    }
  };

  Field.prototype.resize = function () {
    var gl = this.gl, self = this;
    var mw = vw(), mh = vh();

    /* A viewport that measures 0 is NOT a 1px viewport. Clamping it to 1 is what
       produced glyph boxes 200x the size of the screen: every ratio here divides
       by this.h. Wait for a real measurement instead. */
    if (mw < 2 || mh < 2) {
      this.ready = false;
      /* setTimeout, not requestAnimationFrame: rAF is suspended in a hidden or
         background tab, which is exactly when a page is most likely to lay out
         at zero. Timers are throttled there but they still fire, so the field
         recovers the moment the viewport becomes real. */
      if (!this._retry) {
        this._retry = setTimeout(function () { self._retry = 0; self.resize(); }, 100);
      }
      return;
    }

    var changed = (mw !== this.w || mh !== this.h);
    this.ready = true;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = mw; this.h = mh;
    /* Anything already on screen was measured against the old viewport — let it
       go rather than leaving stretched text mid-flight. */
    if (changed && this.slots) {
      for (var s = 0; s < SLOTS; s++) { this.slots[s].live = null; this.slots[s].vis = 0; }
      this.nextFillAt = 0;
    }
    this.c.width = Math.round(this.w * this.dpr);
    this.c.height = Math.round(this.h * this.dpr);
    this.c.style.width = this.w + 'px';
    this.c.style.height = this.h + 'px';
    gl.viewport(0, 0, this.c.width, this.c.height);
    var a = this.w / this.h;
    this.aspect = a >= 1 ? [a, 1] : [1, 1 / a];
    this.seed();
    if (this.img) this._rasterBed(this.img);
  };

  Field.prototype.seed = function () {
    var gl = this.gl;
    /* Overscanning without paying for it would simply spread the same dots
       over a bigger sheet and thin the field out everywhere. Buy the area
       back, but keep the same ceiling so the top end is unchanged. */
    var want = Math.min(26000, Math.round((this.w * this.h) / 64 * FIELD_OVERSCAN * FIELD_OVERSCAN));
    var cols = Math.max(2, Math.round(Math.sqrt(want * (this.w / this.h))));
    var rows = Math.max(2, Math.round(want / cols));
    var n = cols * rows; this.n = n;
    var home = new Float32Array(n * 2), seed = new Float32Array(n * 2), i = 0;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        home[i * 2] = (((x + 0.5 + (Math.random() - 0.5) * 0.92) / cols) * 2 - 1) * FIELD_OVERSCAN;
        home[i * 2 + 1] = (1 - ((y + 0.5 + (Math.random() - 0.5) * 0.92) / rows) * 2) * FIELD_OVERSCAN;
        seed[i * 2] = Math.random(); seed[i * 2 + 1] = Math.random();
        i++;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bHome); gl.bufferData(gl.ARRAY_BUFFER, home, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bSeed); gl.bufferData(gl.ARRAY_BUFFER, seed, gl.STATIC_DRAW);
    this.home = home;
    this.color = new Float32Array(n * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bColor);
    gl.bufferData(gl.ARRAY_BUFFER, this.color, gl.DYNAMIC_DRAW);
    if (this.bedPix) this._sampleColors();
  };

  /* Read the wallpaper at every particle's home position. Runs once per bed and
     once per resize — never per frame. */
  Field.prototype._sampleColors = function () {
    var px = this.bedPix; if (!px || !this.home) return;
    var d = px.data, W = px.w, H = px.h, col = this.color, home = this.home, n = this.n;
    for (var i = 0; i < n; i++) {
      var x = (home[i * 2] * 0.5 + 0.5) * W;
      var y = (0.5 - home[i * 2 + 1] * 0.5) * H;
      var xi = x < 0 ? 0 : x >= W ? W - 1 : x | 0;
      var yi = y < 0 ? 0 : y >= H ? H - 1 : y | 0;
      var o = (yi * W + xi) * 4;
      col[i * 3] = d[o] / 255; col[i * 3 + 1] = d[o + 1] / 255; col[i * 3 + 2] = d[o + 2] / 255;
    }
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bColor);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, col);
  };

  /* Cover-fit the loaded image into the sampling canvas, matching what the bed
     shader crops, so particle colours line up with the pixels behind them. */
  Field.prototype._rasterBed = function (img) {
    /* this.w is 0 while the tab is hidden or not yet laid out, and SW*h/0 made
       getImageData throw "Value is not of type 'long'" — which silently skipped
       the whole measurement, so the page never got a theme at all. 16:9 until
       the real size is known. */
    var SW = 384, SH = Math.max(1, Math.round(SW * (this.h || 9) / (this.w || 16)));
    this.samp.width = SW; this.samp.height = SH;
    var c = this.sctx, iw = img.width, ih = img.height;
    var sc = Math.max(SW / iw, SH / ih) / 0.94;      /* 0.94 = the ken-burns margin */
    var dw = iw * sc, dh = ih * sc;
    c.clearRect(0, 0, SW, SH);
    c.drawImage(img, (SW - dw) / 2, (SH - dh) / 2, dw, dh);
    var px = c.getImageData(0, 0, SW, SH).data;
    this.bedPix = { data: px, w: SW, h: SH };

    /* Mean luminance of the plate, then the exposure that brings it to TARGET.
       The 0.32 exponent deliberately under-corrects: a wallpaper should still
       read as dark or bright, it just must not be so far off that the glass
       either goes black or stops being readable. */
    var sum = 0, n = SW * SH;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    }
    this.bedLum = (sum / n) / 255;

    /* Second pass measures BUSYNESS, as mean neighbour-to-neighbour gradient.
       Global standard deviation does not work here: a smooth two-colour ramp and
       a neon street can share a spread, and downsampling averages the street's
       detail away. Gradient separates them cleanly — smooth plates land at
       .001-.003, photographic ones at .014-.026 — which is what decides whether
       page copy survives on top. */
    var gsum = 0, gN = 0;
    for (var y = 0; y < SH; y++) {
      for (var x = 0; x < SW; x++) {
        var q = (y * SW + x) * 4;
        var L = (0.2126 * px[q] + 0.7152 * px[q + 1] + 0.0722 * px[q + 2]) / 255;
        if (x + 1 < SW) {
          var q2 = q + 4;
          gsum += Math.abs(L - (0.2126 * px[q2] + 0.7152 * px[q2 + 1] + 0.0722 * px[q2 + 2]) / 255);
          gN++;
        }
        if (y + 1 < SH) {
          var q3 = q + SW * 4;
          gsum += Math.abs(L - (0.2126 * px[q3] + 0.7152 * px[q3 + 1] + 0.0722 * px[q3 + 2]) / 255);
          gN++;
        }
      }
    }
    this.bedVar = gN ? gsum / gN : 0;
    /* The wallpaper is shown exactly as it was authored — no defocus, no
       exposure, no tint. Earlier passes measured the plate and corrected it so
       page copy would survive on top; that is the wrong trade for a site whose
       whole point is the wallpaper. Readability is the glass panels' job now:
       brightness() inside their backdrop-filter darkens what sits BEHIND each
       panel, leaving the plate itself untouched everywhere else. */
    this.soften = 0;

    var e = Math.pow(0.11 / Math.max(this.bedLum, 0.012), 0.32);
    this.exposure = 1;
    this._sampleColors();
    this._theme();
  };



  /* Roll a new wallpaper. Never repeats the one already showing, so a click
     always visibly does something. Falls back to a procedural sky if the image
     cannot be fetched, which also covers the case of the set not being
     deployed yet. */
  Field.prototype.rollWall = function () {
    if (!WALLS.length) return this.rollSky();
    var i = (Math.random() * WALLS.length) | 0;
    if (i === wallIdx) i = (i + 1 + ((Math.random() * (WALLS.length - 1)) | 0)) % WALLS.length;
    wallIdx = i;
    var name = WALLS[i];
    this.skyName = name.replace(/^S[KL]\d+_/, '').replace(/-/g, ' ');
    this.setBed('/wpv/' + name + '.mp4');
    return this.skyName;
  };

  /* Roll a new sky. The palette, the cloud seed and the sun's position all
     move, so this is an unbounded set rather than a rotation through N files —
     which is the whole reason it is a shader and not a folder of downloads. */
  Field.prototype.rollSky = function (i) {
    if (this.vid) { try { this.vid.pause(); } catch (e) {} this.vid = null; }
    var prev = this.sky;
    var pick = SKIES[(i == null ? (Math.random() * SKIES.length) | 0 : i) % SKIES.length];
    if (SKIES.length > 1 && pick === prev && i == null) {
      pick = SKIES[(SKIES.indexOf(prev) + 1 + ((Math.random() * (SKIES.length - 1)) | 0)) % SKIES.length];
    }
    this.sky = pick;
    this.skyName = pick.n;
    this.skySeed = Math.random() * 3.4;
    /* the sun stays low — this is a horizon, not a noon sky */
    this.sunPos = [(Math.random() * 1.6 - 0.8), -0.30 + Math.random() * 0.34];
    this.skyMode = 1;
    this.hasCover = 0;
    this.bedName = 'sky:' + pick.n;
    this.bedPix = null;
    this.img = null;
    this.exposure = 1; this.soften = 0;
    this.draw();
    this._measureDrawn();
    this.draw();
    return pick.n;
  };

  /* Exposure for a procedural bed. Photographs are measured off an offscreen
     raster in _rasterBed; a shader has no such raster, so this reads back the
     frame that was just drawn. One block from the middle rather than the whole
     canvas — a full readPixels at devicePixelRatio is megabytes, and the mean
     of a centre block is within a percent of the mean of the frame. */
  Field.prototype._measureDrawn = function () {
    var gl = this.gl;
    var W = Math.min(256, this.c.width), H = Math.min(144, this.c.height);
    var x = Math.max(0, ((this.c.width - W) / 2) | 0), y = Math.max(0, ((this.c.height - H) / 2) | 0);
    var px = new Uint8Array(W * H * 4);
    try { gl.readPixels(x, y, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    catch (e) { return; }
    var sum = 0, n = W * H;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    }
    this.bedLum = (sum / n) / 255;
    var e = Math.pow(0.11 / Math.max(this.bedLum, 0.012), 0.32);
    this.exposure = Math.min(1.55, Math.max(0.45, e));
    this._theme();
  };

  /* Swap the wallpaper. Pass null for the procedural galaxy, a .jpg/.png for a
     still, or a .mp4 for a LIVE wallpaper — the same thing the Tauri app plays
     on the desktop. A video bed shows its poster still first (instant, and it
     is also what the particles take their colour from) and hands over to the
     decoded frames once the video can actually play, so there is never a black
     hole while it buffers. */
  Field.prototype.setBed = function (url) {
    var self = this, gl = this.gl;
    this.bedName = url;
    this.skyMode = 0;
    if (this.vid) { try { this.vid.pause(); } catch (e) {} this.vid = null; }
    if (!url) { this.hasCover = 0; this.bedPix = null; this.img = null; this.draw(); return; }

    var isVideo = /\.(mp4|webm)$/i.test(url);
    var stillUrl = isVideo ? url.replace(/\.(mp4|webm)$/i, '.jpg') : url;

    var img = new Image();
    img.onload = function () {
      gl.bindTexture(gl.TEXTURE_2D, self.tex);
      /* WebGL's texture origin is bottom-left, an image's is top-left, so an
         unflipped upload samples upside down. It went unnoticed while the beds
         were a galaxy and an abstract night street — neither has an obvious up.
         A meadow under a sky does: the grass was at the top. */
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      self.img = img;
      self.coverAspect = img.width / img.height;
      self.hasCover = 1;
      self._rasterBed(img);
      self.draw();
    };
    img.onerror = function () {
      /* a missing plate must not leave a black page */
      if (self.skyMode !== 1) { self.rollSky(); return; } if (!self.vid) { self.hasCover = 0; self.bedPix = null; } };
    img.src = stillUrl;

    if (!isVideo || REDUCE) return;

    var v = document.createElement('video');
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.oncanplay = function () {
      self.coverAspect = (v.videoWidth || 16) / (v.videoHeight || 9);
      self.hasCover = 1;
      self.vid = v;
      /* Only start decoding if the field is actually running. Without this a
         video that finishes buffering while the tab is hidden plays on into a
         backgrounded page, which is exactly the battery drain the
         visibilitychange handler exists to prevent. */
      if (self.raf) {
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () { /* autoplay blocked — the poster stands in */ });
      }
    };
    v.onerror = function () { self.vid = null; };
    v.src = url;
  };

  /* Rasterise one line into a slot's stroke mask. */
  Field.prototype._drawGlyph = function (slot, text, tint) {
    var o = this.octx, W = this.off.width, H = this.off.height;
    o.clearRect(0, 0, W, H);
    o.fillStyle = '#fff';
    o.textAlign = 'center'; o.textBaseline = 'middle';
    /* 800, and stepped down 78 → 28, exactly as the app's atlas does it
       (mineradio-wallpaper.js:566). Weight matters more than it looks: a 700
       stroke is thin enough that the mask samples too few pixels across it, and
       a letter built from a one-particle-wide stroke can only ever read as a
       hairline. The floor is a floor for the same reason — below it the mask
       starves and the glyph stops being legible at any particle count. */
    var FONT = "'JetBrains Mono','SF Mono',ui-monospace,SFMono-Regular,Menlo," +
               "Consolas,'Segoe UI Mono',monospace";
    var size = 78;
    for (; size > 28; size -= 2) {
      o.font = '800 ' + size + 'px ' + FONT;
      if (o.measureText(text).width < W * 0.92) break;
    }
    o.font = '800 ' + size + 'px ' + FONT;
    var mw = o.measureText(text).width;
    o.fillText(text, W / 2, H / 2);

    /* Per-particle mask lookup, not a per-texel one. Each particle keeps the
       fixed random uv it was born with and asks whether it happens to be on a
       stroke — the app's model (mineradio-wallpaper.js:_sampleGlyphMask), and
       the reason its letters have no grid in them. Same clamps it uses, which
       keep particles off the very edge of the atlas where the glyph never
       reaches. */
    var d = o.getImageData(0, 0, W, H).data;
    var mask = slot.mask, uv = this.glyphUv, lit = 0;
    for (var i = 0; i < this.glyphN; i++) {
      var ux = Math.min(0.998, Math.max(0.002, uv[i * 2]));
      var uy = Math.min(0.94, Math.max(0.06, uv[i * 2 + 1]));
      var x = Math.min(W - 1, (ux * W) | 0);
      /* canvas y runs down, uv y runs up */
      var y = Math.min(H - 1, ((1 - uy) * H) | 0);
      var on = d[(y * W + x) * 4 + 3] > 115 ? 1 : 0;
      mask[i] = on; lit += on;
    }
    if (lit < 12) return false;

    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.onBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, mask);

    slot.tint = tint;

    /* EVERY line must land at the same on-screen size. The font auto-fits the
       mask canvas so the lattice is always fully used (that is what keeps the
       strokes dense), which means a 35-character log line rasterises at a much
       smaller in-canvas size than a 7-character metric. Scaling the clip box by
       the INVERSE of that in-canvas size cancels it out, so both arrive at the
       same F pixels tall on screen. Getting this backwards is what made short
       metrics three times the size of the log line. */
    /* Height alone is the wrong budget in PORTRAIT. On a phone the height is
       generous and the width is not, and this line only ever consulted the
       height: a 35-character log line came out 922px wide on a 390px screen —
       2.4x the display, which the +-0.98 clamp in _place cannot rescue, so it
       simply sat mostly off-screen. Landscape hid it because width was never
       the scarce axis there.

       The text is F tall and mw/size wide per unit of height, so the widest F
       that still fits is (w * 0.82) / (mw / size). Take whichever budget binds.
       On desktop the height budget still binds for every line, so nothing about
       the wide layout changes; in portrait a long log line now shrinks to fit
       while a short metric keeps its full size. */
    var ratio = mw / size;                                /* width per 1px of height */
    var F = Math.max(22, Math.min(52, this.h * 0.052));   /* on-screen px */
    F = Math.min(F, (this.w * 0.82) / ratio);
    /* below this it stops reading as text at all, at which point it is better
       to let the line run a little wider than the budget */
    F = Math.max(11, F);
    slot.sy = 2 * F * H / (size * this.h);
    slot.sx = slot.sy * (W / H) * (this.h / this.w);
    /* the strokes only occupy mw of the W-wide box — clamp against what is
       actually drawn, not the empty frame around it */
    slot.visW = slot.sx * (mw / W);
    return true;
  };

  Field.prototype._place = function (slot) {
    /* alternate sides and walk vertically — the app avoids the screen centre,
       where windows and icons live. Here the centre is where the page copy is. */
    this.glyphSide *= -1;
    this.glyphIdx++;
    var gy = (((this.glyphIdx * 0.61) % 1) - 0.5) * 1.62;
    /* Bigger text needs to sit further out. The app pushes lines away from the
       screen centre because that is where windows are; here it is where the
       page copy and the buttons are, and a 60%-wide log line landing on the CTA
       row makes both unreadable. */
    var gx = this.glyphSide * (0.40 + ((this.glyphIdx * 0.37) % 1) * 0.34);
    /* keep the whole run on screen */
    var half = (slot.visW || slot.sx) * 0.5;
    if (gx - half < -0.98) gx = -0.98 + half;
    if (gx + half > 0.98) gx = 0.98 - half;
    slot.cx = gx; slot.cy = gy;
  };

  /** Stats for a rectangle of the measured plate, in 0..1 fractions of the
   *  frame. Strided so even a full-frame patch reads at most ~2000 pixels. */
  Field.prototype._patch = function (x0, x1, y0, y1) {
    var px = this.bedPix; if (!px) return null;
    var d = px.data, W = px.w, H = px.h;
    var xa = Math.max(0, (x0 * W) | 0), xb = Math.min(W, Math.ceil(x1 * W));
    var ya = Math.max(0, (y0 * H) | 0), yb = Math.min(H, Math.ceil(y1 * H));
    if (xb - xa < 1 || yb - ya < 1) return null;
    var st = Math.max(1, Math.round(Math.sqrt(((xb - xa) * (yb - ya)) / 2000)));
    var Ls = [], R = 0, G = 0, B = 0, hx = 0, hy = 0, sw = 0, n = 0;
    for (var y = ya; y < yb; y += st) for (var x = xa; x < xb; x += st) {
      var o = (y * W + x) * 4, c = [d[o] / 255, d[o + 1] / 255, d[o + 2] / 255];
      var hs = hueSat(c), w = hs[1] * Math.max(c[0], c[1], c[2]);
      Ls.push(relLum(c)); R += c[0]; G += c[1]; B += c[2]; n++;
      hx += Math.cos(hs[0] * Math.PI / 180) * w; hy += Math.sin(hs[0] * Math.PI / 180) * w; sw += w;
    }
    Ls.sort(function (a, b) { return a - b; });
    return { rgb: [R / n, G / n, B / n], p50: Ls[(Ls.length * 0.5) | 0], p90: Ls[(Ls.length * 0.9) | 0],
             hue: (Math.atan2(hy, hx) * 180 / Math.PI + 360) % 360, sat: sw / n };
  };

  /** A coarse colour map of the plate, so page copy can ask "what is behind
   *  me?" on every scroll frame without re-reading pixels. Per cell: the bright
   *  end (p90), the summed colour, and the hue as a saturation-weighted vector
   *  so neighbouring cells merge correctly. Rebuilt with the theme — a new
   *  wallpaper, a resize, a rotation (resize re-rasters the plate). */
  Field.prototype._buildGrid = function () {
    var px = this.bedPix;
    if (!px) { this.grid = null; return; }
    var d = px.data, W = px.w, H = px.h, cols = 24;
    var rows = Math.max(8, Math.min(48, Math.round(cols * H / W))), cells = new Array(cols * rows);
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      var xa = (c * W / cols) | 0, xb = Math.max(xa + 1, ((c + 1) * W / cols) | 0);
      var ya = (r * H / rows) | 0, yb = Math.max(ya + 1, ((r + 1) * H / rows) | 0);
      var Ls = [], R = 0, G = 0, B = 0, hx = 0, hy = 0, sw = 0, n = 0;
      for (var y = ya; y < yb; y += 2) for (var x = xa; x < xb; x += 2) {
        var o = (y * W + x) * 4, r8 = d[o], g8 = d[o + 1], b8 = d[o + 2];
        var mx = Math.max(r8, g8, b8), mn = Math.min(r8, g8, b8), dd = mx - mn, h = 0;
        if (dd) { h = mx === r8 ? ((g8 - b8) / dd) % 6 : mx === g8 ? (b8 - r8) / dd + 2 : (r8 - g8) / dd + 4; h *= 60; if (h < 0) h += 360; }
        var w = mx ? (dd / mx) * (mx / 255) : 0;
        Ls.push(0.2126 * LIN[r8] + 0.7152 * LIN[g8] + 0.0722 * LIN[b8]);
        R += r8; G += g8; B += b8; n++;
        hx += Math.cos(h * 0.0174533) * w; hy += Math.sin(h * 0.0174533) * w; sw += w;
      }
      Ls.sort(function (a, b) { return a - b; });
      cells[r * cols + c] = { p90: Ls[(Ls.length * 0.9) | 0], R: R / 255, G: G / 255, B: B / 255, hx: hx, hy: hy, sw: sw, n: n };
    }
    this.grid = { cols: cols, rows: rows, cells: cells };
  };

  /** What is behind a rectangle of the viewport (fractions 0..1)? The BRIGHTEST
   *  cell decides p90 — a paragraph spanning cloud and sky must survive the
   *  cloud — and the hue is the weighted mean of everything it covers. */
  Field.prototype._region = function (x0, x1, y0, y1) {
    var g = this.grid;
    if (!g) return this.themeP || null;
    var ca = Math.max(0, Math.floor(x0 * g.cols)), cb = Math.min(g.cols - 1, Math.floor(x1 * g.cols));
    var ra = Math.max(0, Math.floor(y0 * g.rows)), rb = Math.min(g.rows - 1, Math.floor(y1 * g.rows));
    if (cb < ca || rb < ra) return null;
    var p90 = 0, R = 0, G = 0, B = 0, hx = 0, hy = 0, sw = 0, n = 0;
    for (var r = ra; r <= rb; r++) for (var c = ca; c <= cb; c++) {
      var e = g.cells[r * g.cols + c];
      if (e.p90 > p90) p90 = e.p90;
      R += e.R; G += e.G; B += e.B; hx += e.hx; hy += e.hy; sw += e.sw; n += e.n;
    }
    return { rgb: [R / n, G / n, B / n], p90: p90, hue: (Math.atan2(hy, hx) * 180 / Math.PI + 360) % 360,
             sat: sw / n, key: ca + ',' + cb + ',' + ra + ',' + rb };
  };

  /** Derive the page's colours from the wallpaper that just landed: the halo
   *  colour and strength (shared by page copy, particle text and the city), the
   *  accent the page copy uses, and the city's saturation and gain. */
  Field.prototype._theme = function () {
    var hero = this._patch(0.15, 0.85, 0.12, 0.62);
    var cityP = this._patch(0.25, 0.75, 0.45, 1.0);
    var p = hero;
    if (!p) {
      /* a procedural sky has no raster — its own palette says what colour it is */
      var top = (this.sky && this.sky.top) || [0.1, 0.1, 0.2], hs0 = hueSat(top);
      var L0 = Math.min(1, (this.bedLum || 0.05) * 1.6);
      p = { rgb: top, p50: L0, p90: L0, hue: hs0[0], sat: hs0[1] };
    }
    /* The halo is a SHADOW tinted with the scene's own colour — deep navy under
       a blue sky, deep forest under a meadow, plum under pink cloud — instead of
       one fixed indigo on every plate. Grey plates keep the indigo. */
    this.themeP = p;
    this.themeVer = (this.themeVer || 0) + 1;
    var grey = p.sat < 0.12;
    var hh = grey ? 257 : p.hue, hsat = grey ? 0.68 : 0.62, hl = 0.10;
    this.haloRGB = hslRgb(hh, hsat, hl);
    /* Tinted like the scene, but never LIGHTER than the indigo it replaced.
       Green and teal carry most of their weight in luminance (G is 0.7152 of
       it), so at the same HSL lightness a meadow-green shadow is brighter than
       indigo — the sweep caught it costing the two dark green plates contrast
       (moonlit meadow 8.41 -> 7.85, summer hillside 11.73 -> 10.77). Scale the
       colour down to indigo's luminance; sRGB ~ linear^(1/2.2). */
    var capL = relLum([0.106, 0.048, 0.252]), hL = relLum(this.haloRGB), hlOut = hl;
    if (hL > capL) {
      /* Bisect on the real luminance rather than assume sRGB ~ linear^(1/2.2):
         these halos live in sRGB's linear toe (channels under 0.04), where the
         power law is wrong, and the closed-form scale left dark green plates
         ~1% short of indigo (moonlit meadow 8.41 -> 8.31). */
      var lo = 0, hi = 1, base = this.haloRGB, sc = 1;
      for (var it = 0; it < 24; it++) {
        var mid = (lo + hi) / 2;
        if (relLum([base[0] * mid, base[1] * mid, base[2] * mid]) > capL) hi = mid; else lo = mid;
      }
      sc = lo;
      this.haloRGB = [base[0] * sc, base[1] * sc, base[2] * sc];
      /* The page copy's halo is built from --halo-h/s/l, not from this RGB, so
         the cap must reach the CSS too or the text keeps the lighter shadow
         while the particles get the dark one. Below 50% lightness hslRgb is
         linear in L at fixed h and s, so scaling the RGB by sc IS scaling the
         lightness by sc — hue and saturation are untouched. */
      hlOut = hl * sc;
    }
    /* Halo strength follows the bright end of the hero band, but is NEVER
       weaker than the halo the page shipped with (k=1). The first calibration
       let dark plates drop to 0.75 to look cleaner, and the audit showed it cost
       them real contrast (moonlit meadow 8.4 -> 5.1). Lightness 0.10, not 0.13,
       for the same reason: a scene-tinted shadow must be as dark as the indigo. */
    var k = Math.max(1.0, Math.min(1.45, 1.0 + 0.95 * (p.p90 - 0.45)));

    var ac = pickTint(p, MINT, relLum(this.haloRGB), Math.min(1, 0.85 * k), POSITIVE);
    var r = Math.round(ac[0] * 255), g = Math.round(ac[1] * 255), b = Math.round(ac[2] * 255);
    var r3 = Math.round(r + (255 - r) * 0.45), g3 = Math.round(g + (255 - g) * 0.45), b3 = Math.round(b + (255 - b) * 0.45);
    var rd = Math.round(r * 0.78), gd = Math.round(g * 0.78), bd = Math.round(b * 0.78);
    var st = document.documentElement.style;
    st.setProperty('--halo-h', String(Math.round(hh)));
    st.setProperty('--halo-s', Math.round(hsat * 100) + '%');
    st.setProperty('--halo-l', (hlOut * 100).toFixed(1) + '%');
    st.setProperty('--halo-k', k.toFixed(2));
    st.setProperty('--ac', 'rgb(' + r + ',' + g + ',' + b + ')');
    st.setProperty('--ac3', 'rgb(' + r3 + ',' + g3 + ',' + b3 + ')');
    st.setProperty('--acd', 'rgba(' + r + ',' + g + ',' + b + ',0.10)');
    st.setProperty('--acm', 'rgba(' + r + ',' + g + ',' + b + ',0.20)');
    st.setProperty('--gradient', 'linear-gradient(135deg,rgb(' + r + ',' + g + ',' + b + ') 0%,rgb(' + rd + ',' + gd + ',' + bd + ') 100%)');
    this.accent = ac;

    /* City: never the hue (that is the language), only how deep and how bright.
       On a bright plate the bands go more saturated so they read as COLOUR
       rather than pastel, with a stronger silhouette under them. */
    var c90 = cityP ? cityP.p90 : p.p90;
    this.cityTheme = {
      haloK: Math.max(0.25, Math.min(0.9, 0.25 + 0.8 * c90)),
      sat: 1.1 + 0.4 * c90,
      gain: c90 > 0.5 ? 0.92 : 1.1
    };
    /* page copy re-colours itself from this map (textTint) */
    this._buildGrid();
    try { window.dispatchEvent(new Event('terse-theme')); } catch (e) { /* old browsers: no live recolour */ }
  };

  /** Colour one particle line for the plate directly under where it landed. */
  Field.prototype._adaptSlot = function (slot, tint) {
    var fx = slot.cx * 0.5 + 0.5, fy = 0.5 - slot.cy * 0.5;
    var hw = (slot.visW || slot.sx) * 0.25, hh = slot.sy * 0.25;
    var p = this._patch(fx - hw, fx + hw, fy - hh, fy + hh), L;
    L = p ? p.p90 : Math.min(1, (this.bedLum || 0.05) * 1.6);
    /* bright plate under the line -> strong halo, little bloom; dark -> the reverse.
       The halo is decided FIRST because the tint is judged against the plate as
       the halo leaves it, not against the raw plate. */
    slot.haloK = Math.max(0.30, Math.min(0.95, 0.30 + 0.9 * L));
    slot.bloomK = Math.max(0.15, Math.min(1.0, 1.25 - 1.3 * L));
    /* The category decides which colours are allowed, because the colour is
       read as a verdict. Savings are NOT only in 'good': "saved 68%" and
       "312,480 saved" are 'metric' lines, so metric gets the positive pool too —
       amber on a savings number reads as a caution. Only 'warm' (a cost or a
       downgrade) may go red. */
    var pool = tint === TINTS.warm ? PALETTE
             : (tint === TINTS.good || tint === TINTS.metric) ? POSITIVE : NEUTRAL;
    slot.tint = p ? pickTint(p, tint, relLum(this.haloRGB), slot.haloK, pool) : tint;
  };

  Field.prototype._fire = function (slot, text, tint) {
    if (!this._drawGlyph(slot, text, tint)) return false;
    this._place(slot);
    this._adaptSlot(slot, tint);
    slot.inMode = (Math.random() * 9) | 0;
    slot.outMode = (Math.random() * 9) | 0;
    slot.stagger = Math.random() < 0.75 ? 0.30 + Math.random() * 0.5 : 0;
    var a = Math.random() * 6.2831;
    slot.driftX = Math.cos(a); slot.driftY = Math.sin(a);
    slot.live = { t: 0 };
    return true;
  };

  /** Build one city and start it growing. Every appearance picks a different
   *  civilisation — the eight are ROTATED with a random start, not sampled
   *  independently, because independent draws repeat: at 8 styles a fair coin
   *  shows you the same city twice in a row about one time in eight, which
   *  reads as a bug rather than as chance. The rotation guarantees all eight
   *  before any repeat, which is what "all the styles show up" should mean. */
  /** Lay out the next city AHEAD of the moment it is needed.
   *
   *  sampleCity is real main-thread work — measured on the live site at 19-46ms
   *  for the 13000-point phone budget, so 60-105ms at the desktop's 30000. Run
   *  from inside step(), that is up to six dropped frames every time a city
   *  arrives, and it arrives every ~16s while the camera is orbiting: a visible
   *  hitch on a page whose whole job is to look smooth.
   *
   *  It cannot go in a Worker as it stands — sampleLabel rasterises directory
   *  names through document.createElement('canvas') — so instead it moves off
   *  the FRAME path: requestIdleCallback runs it in whatever gap the browser
   *  has, well before the city is due, and the fire itself becomes three
   *  buffer uploads. The timeout means a permanently busy page still gets its
   *  city rather than silently losing the layer. */
  Field.prototype._prepCity = function () {
    var C = window.TerseCity;
    if (!C || !this.cityProg || this.cityPending || this.cityPrepping) return;
    var self = this;
    var st = C.CITY_STYLES[this.city.styleRot % C.CITY_STYLES.length];
    this.city.styleRot++;
    this.cityPrepping = true;

    var build = function () {
      self.cityPrepping = false;
      var r;
      /* If the repo data ever makes this throw, the city must fail alone and
         leave the wallpaper running. */
      try { r = C.sampleCity(CITY_DIRS, CITY_N, st.id, null, null); }
      catch (e) { if (window.console) console.warn('[terse-field] city', e); self.cityProg = null; return; }
      if (r && r.used) { r.styleId = st.id; self.cityPending = r; }
    };
    if (window.requestIdleCallback) window.requestIdleCallback(build, { timeout: 1200 });
    else setTimeout(build, 0);
  };

  Field.prototype._fireCity = function () {
    var C = window.TerseCity;
    if (!C || !this.cityProg) return false;

    /* Normally the layout is already done and this is just an upload. The
       synchronous path is the fallback for the very first city, or if idle time
       never came. */
    var r = this.cityPending;
    this.cityPending = null;
    if (!r) {
      var st = C.CITY_STYLES[this.city.styleRot % C.CITY_STYLES.length];
      this.city.styleRot++;
      try { r = C.sampleCity(CITY_DIRS, CITY_N, st.id, null, null); }
      catch (e) { if (window.console) console.warn('[terse-field] city', e); this.cityProg = null; return false; }
      if (r) r.styleId = st.id;
    }
    if (!r || !r.used) return false;

    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCPos); gl.bufferData(gl.ARRAY_BUFFER, r.target, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCCol); gl.bufferData(gl.ARRAY_BUFFER, r.color, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCScl); gl.bufferData(gl.ARRAY_BUFFER, r.scale, gl.DYNAMIC_DRAW);

    this.city.used = r.used;
    this.city.style = r.styleId;
    this.city.live = { t: 0 };
    this.city.form = 0; this.city.vis = 0;
    return true;
  };

  Field.prototype.pulse = function (x, y, s) {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({ x: x, y: y, t: 0, s: s == null ? 1 : s });
  };

  /* ═══════════════════════════════════════════════════════════════════════
     THE HAND — a simulated user flying the camera.

     The brief was "simulate a real user dragging and zooming", and the thing
     that separates that from a screensaver is not the path, it is the TIMING.
     A camera on a sine wave reads as an animation within about two seconds:
     constant speed, no destination, perfectly periodic. A person moves in
     discrete gestures — reach, ease out, STOP, look, reach again — at
     unpredictable intervals, and never quite holds still while they do it.

     So: a queue of one gesture at a time (drag / zoom / dwell), each with its
     own eased ramp and its own dwell afterwards, all durations randomised, and
     a continuous low-frequency tremor underneath so no pose is ever perfectly
     static. The tremor is what stops the dwells from looking like the tab
     froze.
     ═══════════════════════════════════════════════════════════════════════ */
  Field.prototype._pickGesture = function () {
    var v = this.view, R = Math.random();
    v.fromAz = v.az; v.fromEl = v.el; v.fromDist = v.dist;
    v.t = 0;
    if (R < 0.50) {
      /* A drag. Aim somewhere genuinely else, not a nudge — but bias away from
         wherever it already is, so it does not shuffle around one spot. */
      v.kind = 'drag';
      var wantAz = (Math.random() * 2 - 1) * VIEW_AZ_MAX;
      var wantEl = (Math.random() * 2 - 1) * VIEW_EL_MAX;
      if (Math.abs(wantAz - v.az) < VIEW_AZ_MAX * 0.55) wantAz = -wantAz * 0.85;
      v.toAz = clamp(wantAz, -VIEW_AZ_MAX, VIEW_AZ_MAX);
      v.toEl = clamp(wantEl, -VIEW_EL_MAX, VIEW_EL_MAX);
      v.toDist = v.dist;
      /* 1.1s is a flick, 3.4s is a slow considered swing. Both happen. */
      v.dur = 1100 + Math.random() * 2300;
      v.hold = 420 + Math.random() * 1500;
    } else if (R < 0.78) {
      /* A zoom. Nobody zooms on a perfectly straight axis, so it carries a
         small azimuth drift with it. */
      v.kind = 'zoom';
      v.toDist = VIEW_DIST_MIN + Math.random() * (VIEW_DIST_MAX - VIEW_DIST_MIN);
      if (Math.abs(v.toDist - v.dist) < 0.10) v.toDist = v.dist > 0.9 ? VIEW_DIST_MIN : VIEW_DIST_MAX;
      v.toAz = clamp(v.az + (Math.random() * 2 - 1) * 0.10, -VIEW_AZ_MAX, VIEW_AZ_MAX);
      v.toEl = clamp(v.el + (Math.random() * 2 - 1) * 0.05, -VIEW_EL_MAX, VIEW_EL_MAX);
      v.dur = 1600 + Math.random() * 1900;
      v.hold = 600 + Math.random() * 1700;
    } else {
      /* Stop and look at it. */
      v.kind = 'dwell';
      v.toAz = v.az; v.toEl = v.el; v.toDist = v.dist;
      v.dur = 300;
      v.hold = 900 + Math.random() * 2000;
    }
  };

  Field.prototype._stepView = function (dt) {
    var v = this.view;
    if (!v.on) { v.az = 0; v.el = 0; v.dist = 1; return; }

    if (v.grab) {
      /* A real pointer outranks the demo entirely. */
      v.idle = 0;
      return;
    }

    /* Just let go: coast on the flick, then hand back to the demo. */
    if (v.vAz || v.vEl) {
      v.az = clamp(v.az + v.vAz * dt, -VIEW_AZ_MAX * 1.9, VIEW_AZ_MAX * 1.9);
      v.el = clamp(v.el + v.vEl * dt, -VIEW_EL_MAX * 1.9, VIEW_EL_MAX * 1.9);
      var damp = Math.pow(0.0016, dt / 1000);
      v.vAz *= damp; v.vEl *= damp;
      if (Math.abs(v.vAz) < 1e-6 && Math.abs(v.vEl) < 1e-6) { v.vAz = 0; v.vEl = 0; }
    }

    v.idle += dt;
    /* Two and a half seconds of stillness before the demo takes the controls
       back. Any less and it feels like the page is wrestling the user for the
       mouse the moment they pause mid-drag. */
    if (v.idle < 2500) return;

    v.t += dt;
    if (v.t >= v.dur + v.hold) this._pickGesture();

    var u = v.dur > 0 ? clamp(v.t / v.dur, 0, 1) : 1;
    var k = easeInOut(u);
    /* A hand overshoots a little and settles back; a tween does not. Only on
       the drags, and only on the tail, where a real arm actually does it. */
    if (v.kind === 'drag' && u > 0.55) k += Math.sin((u - 0.55) / 0.45 * Math.PI) * 0.055;

    v.az = v.fromAz + shortestArc(v.fromAz, v.toAz) * k;
    v.el = v.fromEl + (v.toEl - v.fromEl) * k;
    v.dist = v.fromDist + (v.toDist - v.fromDist) * easeInOut(u);

    /* The tremor. Three incommensurate periods so it never repeats inside a
       visit, at an amplitude you read rather than see. */
    var ts = this.t * 0.001;
    v.az += Math.sin(ts * 0.27) * 0.0075 + Math.sin(ts * 0.61 + 1.7) * 0.0034;
    v.el += Math.cos(ts * 0.23 + 0.9) * 0.0052 + Math.sin(ts * 0.49) * 0.0021;

    v.az = clamp(v.az, -VIEW_AZ_MAX * 1.15, VIEW_AZ_MAX * 1.15);
    v.el = clamp(v.el, -VIEW_EL_MAX * 1.15, VIEW_EL_MAX * 1.15);
    v.dist = clamp(v.dist, VIEW_DIST_MIN, VIEW_DIST_MAX);
  };

  Field.prototype.step = function (dt) {
    if (!this.ready) { this.resize(); if (!this.ready) return; }
    this.t += dt;
    var now = this.t;
    this._stepView(dt);

    /* ── advance every live slot ── */
    for (var i = 0; i < SLOTS; i++) {
      var s = this.slots[i];
      if (!s.live) { s.vis = 0; continue; }
      s.live.t += dt;
      var tt = s.live.t;
      if (tt < T_IN) { s.form = ease(tt / T_IN); s.out = 0; s.vis = Math.min(1, tt / (T_IN * 0.6)); }
      else if (tt < T_IN + T_HOLD) { s.form = 1; s.out = 0; s.vis = 1; }
      else if (tt < G_LIFE) {
        var k = (tt - T_IN - T_HOLD) / T_OUT;
        s.form = 1 - ease(k) * 0.75;                 /* outDepth 0.75, the app's */
        s.out = 1; s.vis = 1 - ease(k);
      } else { s.live = null; s.vis = 0; s.form = 0; }

      /* the ripple fires the instant the line lands, like the app */
      if (s.live && tt >= T_IN && tt < T_IN + dt + 1) {
        this.pulse(s.cx, s.cy, 1);
        this.dance.mode = (Math.random() * 10) | 0;
        this.dance.cx = s.cx * this.aspect[0];
        this.dance.cy = s.cy * this.aspect[1];
        var da = Math.random() * 6.2831;
        this.dance.dx = Math.cos(da); this.dance.dy = Math.sin(da);
      }
    }

    /* ── the city runs on its own clock, underneath the text ── */
    if (this.city) {
      var c = this.city;
      if (c.live) {
        c.live.t += dt;
        var ct = c.live.t;
        if (ct < CITY_IN) { c.form = ease(ct / CITY_IN); c.vis = Math.min(1, ct / (CITY_IN * 0.5)); }
        else if (ct < CITY_IN + CITY_HOLD) { c.form = 1; c.vis = 1; }
        else if (ct < CITY_LIFE) {
          var ck = (ct - CITY_IN - CITY_HOLD) / CITY_OUT;
          /* Unlike the text, the city does not scatter back out to 0.25 — it
             sinks back into the ground it grew from, so form only relaxes a
             little while the alpha carries the exit. */
          c.form = 1 - ease(ck) * 0.55;
          c.vis = 1 - ease(ck);
        } else {
          c.live = null; c.vis = 0; c.form = 0;
          this.nextCityAt = now + CITY_GAP;
        }
      } else if (now >= this.nextCityAt) {
        if (!this._fireCity()) this.nextCityAt = now + CITY_GAP;
      } else if (now >= this.nextCityAt - 2500) {
        /* Lay the next one out during the gap, so the frame that actually
           shows it only has to upload three buffers. 2.5s is comfortably
           longer than the worst measured layout (~105ms) plus however long the
           browser takes to hand out an idle slice. */
        this._prepCity();
      }
    }

    /* ── fill free slots, STAGGERED. Slot 0 is the agent log. ── */
    for (var si = 0; this.ready && si < SLOTS; si++) {
      var sl = this.slots[si];
      if (sl.live) continue;
      if (now < this.nextFillAt) break;
      if (si === 0) {
        if (this._fire(sl, LOG[this.logRot % LOG.length], TINTS.tool)) {
          this.logRot++; this.nextFillAt = now + FILL_GAP;
        }
      } else {
        var st = STATS[this.statRot % STATS.length];
        if (this._fire(sl, st[0], TINTS[st[1]])) {
          this.statRot++; this.nextFillAt = now + FILL_GAP;
        }
      }
    }

    /* ── dance envelope: alive while anything is forming, idle sway otherwise ── */
    var anyLive = 0;
    for (var q = 0; q < SLOTS; q++) if (this.slots[q].live) anyLive = Math.max(anyLive, this.slots[q].vis);
    var wantAmt = 0.16 + anyLive * 0.84;
    this.dance.amt += (wantAmt - this.dance.amt) * Math.min(1, dt / 420);
    this.dance.t = this.t * 0.001;

    /* ── ripples age out ── */
    for (var r = this.ripples.length - 1; r >= 0; r--) {
      this.ripples[r].t += dt;
      if (this.ripples[r].t > 2000) this.ripples.splice(r, 1);
    }
    for (var z = 0; z < this.rip.length; z++) this.rip[z] = 0;
    for (var j = 0; j < this.ripples.length; j++) {
      this.rip[j * 3] = this.ripples[j].x;
      this.rip[j * 3 + 1] = this.ripples[j].y;
      this.rip[j * 3 + 2] = this.ripples[j].t / 2000;
    }
  };

  Field.prototype.draw = function () {
    if (!this.ready) return;
    var gl = this.gl, t = this.t * 0.001;
    gl.disable(gl.DEPTH_TEST);
    /* One matrix per frame, shared by the field and the glyphs — they have
       to agree exactly or the text drifts off the particles it belongs to.
       The BED is deliberately left out of it: it stays a flat full-screen
       pass. Rotating the plate as well would swing its edges into view, and
       there is nothing behind it to show. Keeping it fixed is also what
       makes the parallax legible — the particles move against something. */
    var vv = this.view;
    viewProj(this.vp, vv.az, vv.el, vv.dist, this.aspect[0], this.aspect[1]);

    /* ── 1. the galaxy ── */
    gl.useProgram(this.bedProg);
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.aBedPos);
    gl.vertexAttribPointer(this.aBedPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.uBed.time, t);
    gl.uniform2fv(this.uBed.aspect, this.aspect);
    gl.uniform1f(this.uBed.hasCover, this.hasCover);
    gl.uniform1f(this.uBed.exposure, this.exposure);
    gl.uniform1f(this.uBed.soften, this.soften);
    gl.uniform1f(this.uBed.skyMode, this.skyMode);
    gl.uniform1f(this.uBed.skySeed, this.skySeed);
    gl.uniform3fv(this.uBed.skyTop, this.sky.top);
    gl.uniform3fv(this.uBed.skyHaze, this.sky.haze);
    gl.uniform3fv(this.uBed.skySun, this.sky.sun);
    gl.uniform2fv(this.uBed.sunPos, this.sunPos);
    /* cover-fit: crop the long axis, then leave a 6% margin for the drift */
    var va = this.w / this.h, ia = this.coverAspect;
    var csx = ia > va ? (va / ia) : 1, csy = ia > va ? 1 : (ia / va);
    gl.uniform2f(this.uBed.coverScale, csx * 0.94, csy * 0.94);
    var m = 0.03;
    gl.uniform2f(this.uBed.coverDrift, Math.sin(t * 0.026) * m, Math.cos(t * 0.019) * m * 0.7);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.vid && this.vid.readyState >= 2 && !this.vid.paused) {
      this._vtick = (this._vtick || 0) + 1;
      if (this._vtick % 2 === 0) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.vid); }
        catch (e) { this.vid = null; }
      }
    }
    gl.uniform1i(this.uBed.cover, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(this.aBedPos);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);           /* additive, the app's twin-layer blend */

    /* ── 2. the field, sharp then bloom ── */
    gl.useProgram(this.fldProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bHome);
    gl.enableVertexAttribArray(this.aHome);
    gl.vertexAttribPointer(this.aHome, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bSeed);
    gl.enableVertexAttribArray(this.aSeed);
    gl.vertexAttribPointer(this.aSeed, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bColor);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0);

    gl.uniform1f(this.uFld.hasCover, this.hasCover);
    gl.uniform1f(this.uFld.exposure, this.exposure);
    gl.uniform1f(this.uFld.skyMode, this.skyMode);
    gl.uniform1f(this.uFld.skySeed, this.skySeed);
    gl.uniform3fv(this.uFld.skyTop, this.sky.top);
    gl.uniform3fv(this.uFld.skyHaze, this.sky.haze);
    gl.uniform3fv(this.uFld.skySun, this.sky.sun);
    gl.uniform2fv(this.uFld.sunPos, this.sunPos);
    gl.uniform1f(this.uFld.time, t);
    gl.uniform1f(this.uFld.dpr, this.dpr);
    gl.uniform2fv(this.uFld.aspect, this.aspect);
    gl.uniform3fv(this.uFld.ripples, this.rip);
    gl.uniform1f(this.uFld.danceAmt, this.dance.amt);
    gl.uniform1f(this.uFld.danceMode, this.dance.mode);
    gl.uniform1f(this.uFld.danceT, this.dance.t);
    gl.uniform2f(this.uFld.danceCenter, this.dance.cx, this.dance.cy);
    gl.uniform2f(this.uFld.danceDir, this.dance.dx, this.dance.dy);
    gl.uniformMatrix4fv(this.uFld.viewProj, false, this.vp);
    gl.uniform1f(this.uFld.camR, CAM_R);
    /* How hard the choreography pushes in depth, and how thick the resting
       slab is. Both are in the same units as the sheet (which spans ±aspect),
       so 0.85 is a slab about as deep as the screen is tall — the field is a
       volume of stars rather than a curtain of them. */
    gl.uniform1f(this.uFld.depth, 1.30);
    gl.uniform1f(this.uFld.slab, 0.85);

    var fg = Math.min(1.15, Math.max(0.55, this.exposure));
    gl.uniform1f(this.uFld.bloom, 1.0);
    gl.uniform1f(this.uFld.alphaScale, 0.95 * fg);
    gl.drawArrays(gl.POINTS, 0, this.n);
    gl.uniform1f(this.uFld.bloom, 2.65);
    gl.uniform1f(this.uFld.alphaScale, 0.15 * fg);
    gl.drawArrays(gl.POINTS, 0, this.n);

    gl.disableVertexAttribArray(this.aHome);
    gl.disableVertexAttribArray(this.aSeed);
    gl.disableVertexAttribArray(this.aColor);

    /* ── 3. the code city ──────────────────────────────────────────────────
       Between the field and the text on purpose. It is a solid object and the
       log lines are the foreground copy: drawn after the text, a skyline would
       wash straight through the words it is supposed to sit behind. */
    if (this.city && this.city.live && this.city.vis > 0.001 && this.city.used) {
      gl.useProgram(this.cityProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bCPos);
      gl.enableVertexAttribArray(this.aCPos);
      gl.vertexAttribPointer(this.aCPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bCCol);
      gl.enableVertexAttribArray(this.aCCol);
      gl.vertexAttribPointer(this.aCCol, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bCScl);
      gl.enableVertexAttribArray(this.aCScl);
      gl.vertexAttribPointer(this.aCScl, 1, gl.FLOAT, false, 0, 0);

      gl.uniformMatrix4fv(this.uCity.viewProj, false, this.vp);
      gl.uniform1f(this.uCity.camR, CAM_R);
      gl.uniform1f(this.uCity.time, t);
      gl.uniform1f(this.uCity.form, this.city.form);
      gl.uniform1f(this.uCity.vis, this.city.vis);
      /* Fit the ±1.6 cube into the narrower of the two screen axes, so the
         skyline is never wider than the viewport on a phone held upright —
         the same width-vs-height trap the log lines fell into. */
      var cs = 0.60 * Math.min(this.aspect[0], this.aspect[1]);
      gl.uniform1f(this.uCity.scale, cs);
      /* Sat low, on the horizon. Centred it read as a blob behind the hero
         copy and the download buttons; a skyline wants to be along the bottom
         edge, under the text rather than through it. */
      gl.uniform3f(this.uCity.origin, 0, -0.40 * this.aspect[1], 0);
      /* Same density rule as the text: mean spacing of a cloud of this many
         points over the box it occupies, in device pixels. */
      var cw = cs * this.w, ch = cs * this.h;
      var cgap = Math.sqrt((cw * ch) / this.city.used);
      gl.uniform1f(this.uCity.ptPx, Math.max(1.0, cgap * this.dpr * 1.15));

      /* Much lower than the text's 1.45. The whole layer is additive, and a
         city is a SOLID object with thousands of overlapping dots rather than a
         thin stroke — at the text's gain every tower saturated to white and the
         language bands (the entire point of the colour) disappeared. Keeping it
         dim is what lets JSON read as yellow and Rust as rust. */
      var cg = Math.min(1.2, Math.max(0.5, this.exposure));
      /* Same halo / body split as the text. Over the plate instead of added to
         it, so JSON really reads yellow and Rust really reads rust on a bright
         sky — at additive, lowering the gain was the only lever and it made the
         city faint everywhere to stop it burning white somewhere. */
      var ct = this.cityTheme;
      gl.uniform1f(this.uCity.sat, ct.sat);
      gl.uniform1f(this.uCity.gain, ct.gain);
      gl.uniform3fv(this.uCity.halo, this.haloRGB);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(this.uCity.mode, 1);
      gl.uniform1f(this.uCity.ptPx, Math.max(1.0, cgap * this.dpr * 1.15) * 2.2);
      gl.uniform1f(this.uCity.alphaScale, ct.haloK);
      gl.drawArrays(gl.POINTS, 0, this.city.used);
      gl.uniform1f(this.uCity.mode, 0);
      gl.uniform1f(this.uCity.ptPx, Math.max(1.0, cgap * this.dpr * 1.15));
      gl.uniform1f(this.uCity.alphaScale, 0.95 * cg);
      gl.drawArrays(gl.POINTS, 0, this.city.used);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.disableVertexAttribArray(this.aCPos);
      gl.disableVertexAttribArray(this.aCCol);
      gl.disableVertexAttribArray(this.aCScl);
    }

    /* ── 4. the four glyph slots ── */
    gl.useProgram(this.glyProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bUv);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bRand);
    gl.enableVertexAttribArray(this.aRand);
    gl.vertexAttribPointer(this.aRand, 1, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this.aOn);
    gl.uniform1f(this.uGly.time, t);
    gl.uniform1f(this.uGly.dpr, this.dpr);
    gl.uniform2fv(this.uGly.aspect, this.aspect);
    gl.uniformMatrix4fv(this.uGly.viewProj, false, this.vp);
    gl.uniform1f(this.uGly.camR, CAM_R);

    for (var i = 0; i < SLOTS; i++) {
      var s = this.slots[i];
      if (!s.live || s.vis <= 0.001) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.onBuf);
      gl.vertexAttribPointer(this.aOn, 1, gl.FLOAT, false, 0, 0);
      gl.uniform1f(this.uGly.form, s.form);
      gl.uniform1f(this.uGly.vis, s.vis);
      gl.uniform1f(this.uGly.out, s.out);
      gl.uniform1f(this.uGly.inMode, s.inMode);
      gl.uniform1f(this.uGly.outMode, s.outMode);
      gl.uniform1f(this.uGly.stagger, s.stagger);
      gl.uniform2f(this.uGly.center, s.cx, s.cy);
      gl.uniform2f(this.uGly.size, s.sx, s.sy);
      gl.uniform2f(this.uGly.drift, s.driftX, s.driftY);
      gl.uniform3fv(this.uGly.tint, s.tint);

      /* Additive blending clips to white over a bright plate, which is what
         turned the mint and lime tints into flat white on the black-hole
         wallpaper. Ride the glyph gain on the measured exposure so the text
         keeps its colour on a bright bed and still burns on a dark one. */
      var g = Math.min(1.2, Math.max(0.5, this.exposure));

      /* Mean spacing between neighbouring particles, in device pixels. With the
         cloud scattered uniformly over the box, that is sqrt(area / count) —
         and it is the same over a stroke as over the whole box, since both the
         area and the particle share scale together, so stroke coverage drops
         out of it. uSize is the box in clip space, where 2.0 spans the canvas,
         so (sx/2)*w and (sy/2)*h are its CSS pixel dimensions. 1.35 is a little
         deliberate overlap: enough that the dots fuse into a continuous stroke,
         not so much that the stroke swells past its own outline. */
      var boxW = s.sx * 0.5 * this.w, boxH = s.sy * 0.5 * this.h;
      var gap = Math.sqrt((boxW * boxH) / this.glyphN);
      gl.uniform1f(this.uGly.ptPx, Math.max(1.0, gap * this.dpr * 1.35));

      /* Three passes, and the order is the design:
           1. HALO, composited OVER the plate: a soft dark disc per particle, so
              the line carries its own ground — the particle version of the
              text-shadow the page copy already has. Its strength comes from how
              bright the plate is UNDER THIS LINE (slot.haloK, _adaptSlot).
           2. BODY, composited OVER: the tint as itself. This is what the app
              does (NormalBlending on the glyph, additive only on the glow twin);
              the port had the body additive too, so on a bright sky the colour
              could only push toward white.
           3. BLOOM, additive — but scaled by slot.bloomK, which falls as the
              plate brightens: glow on a noon sky only washes the letters out. */
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(this.uGly.mode, 1);
      gl.uniform3fv(this.uGly.halo, this.haloRGB);
      gl.uniform1f(this.uGly.bloom, 2.1);
      gl.uniform1f(this.uGly.alphaScale, s.haloK);
      gl.drawArrays(gl.POINTS, 0, this.glyphN);

      gl.uniform1f(this.uGly.mode, 0);
      gl.uniform1f(this.uGly.bloom, 1.0);
      gl.uniform1f(this.uGly.alphaScale, 1.15);
      gl.drawArrays(gl.POINTS, 0, this.glyphN);

      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(this.uGly.bloom, 1.9);
      gl.uniform1f(this.uGly.alphaScale, 0.20 * g * s.bloomK);
      gl.drawArrays(gl.POINTS, 0, this.glyphN);
    }

    gl.disableVertexAttribArray(this.aUv);
    gl.disableVertexAttribArray(this.aRand);
    gl.disableVertexAttribArray(this.aOn);
  };

  Field.prototype.start = function () {
    if (this.raf || !this.ok) return;
    if (this.vid && this.vid.paused) { try { this.vid.play(); } catch (e) {} }
    var self = this, last = performance.now(), acc = 0, FRAME = 1000 / 40;
    function loop(now) {
      self.raf = requestAnimationFrame(loop);
      var dt = now - last; last = now;
      if (dt > 140) dt = 140;
      acc += dt;
      if (acc < FRAME) return;
      self.step(acc); self.draw(); acc = 0;
    }
    this.raf = requestAnimationFrame(loop);
  };

  Field.prototype.stop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.vid) { try { this.vid.pause(); } catch (e) {} }
  };

  /* ── Mount ──────────────────────────────────────────────────────────────── */
  function mount() {
    if (document.getElementById('terse-field')) return;
    var desk = document.createElement('div');
    desk.id = 'terse-desk';
    var cv = document.createElement('canvas');
    cv.id = 'terse-field';
    cv.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(cv, document.body.firstChild);
    document.body.insertBefore(desk, document.body.firstChild);

    var field = new Field(cv);
    if (!field.ok) { cv.style.display = 'none'; return; }
    window.TerseField = field;
    /* ...and the page copy takes its colour from the part of it behind each line */
    textTint(field);

    /* Override per page with <script src="/terse-field.js" data-bed="/other.jpg">;
       data-bed="" falls back to the procedural galaxy. A .mp4 here works too and
       plays as a live wallpaper, at the cost of its download. */
    var tag = document.querySelector('script[src*="terse-field"]');
    var bed = tag && tag.hasAttribute('data-bed') ? tag.getAttribute('data-bed') : null;
    if (bed) field.setBed(bed);

    /* ── A click rolls a new sky ───────────────────────────────────────────
       Only when the page is showing a procedural sky: a page that pinned its
       own plate with data-bed asked for that plate, and should keep it.

       Ignored on anything the visitor might actually be trying to use — a
       link, a button, a form control, a summary, anything with its own click
       handler behind [role] or [onclick] — and on a drag, because selecting a
       paragraph ends in a click event and having the wallpaper change under a
       selection is startling rather than delightful. */
    var CLICKABLE = 'a,button,input,select,textarea,label,summary,details,[role="button"],[onclick],[contenteditable]';
    var downX = 0, downY = 0;
    document.addEventListener('pointerdown', function (e) { downX = e.clientX; downY = e.clientY; }, true);

    /* ── The visitor can fly it too ────────────────────────────────────────
       The demo above is the default state; a real drag takes over from it and
       hands back 2.5s after release.

       Three rules keep a background from behaving like a foreground:

       · MOUSE ONLY. On a touch screen a drag IS the scroll gesture, and there
         is no way to know which one was meant until the page has already
         failed to move. Phones get the demo and nothing else.

       · BLANK SPACE ONLY. Not a link, not a control — and not on top of live
         text either, which is the case the CLICKABLE list misses: dragging
         across a paragraph is how you select it. The test is whether the
         element under the press owns a non-empty text node of its own, which
         is true of a <p> and false of the section padding around it.

       · THE WHEEL IS NOT OURS. This page is a hundred screens tall; a
         background that swallowed wheel events to zoom would break the only
         gesture that matters on it. Zoom is something the demo does.

       Selection is suppressed only for the duration of a drag that already
       started on blank space, and restored on release. The existing
       click-rolls-a-new-sky handler needs no change — it already ignores any
       pointer that moved more than 6px, so an orbit never also rolls the sky. */
    var HAS_TEXT = function (el) {
      if (!el || !el.childNodes) return false;
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && n.textContent && n.textContent.trim()) return true;
      }
      return false;
    };
    var prevSel = '';
    function endGrab() {
      var v = field.view;
      if (!v.grab) return;
      /* Carry the flick. Sampled over the last move rather than the whole
         drag, so a slow reposition ending in a stop coasts nowhere. */
      v.vAz = clamp(v.grab.vAz, -0.0022, 0.0022);
      v.vEl = clamp(v.grab.vEl, -0.0018, 0.0018);
      v.grab = null; v.idle = 0;
      document.body.style.userSelect = prevSel;
      document.body.style.webkitUserSelect = prevSel;
    }
    document.addEventListener('pointerdown', function (e) {
      if (!field.ok || REDUCE || !field.view.on) return;
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest(CLICKABLE)) return;
      if (HAS_TEXT(e.target)) return;
      field.view.grab = { x: e.clientX, y: e.clientY, vAz: 0, vEl: 0, moved: false };
      field.view.vAz = 0; field.view.vEl = 0;
    });
    document.addEventListener('pointermove', function (e) {
      var v = field.view, g = v.grab;
      if (!g) return;
      var dx = e.clientX - g.x, dy = e.clientY - g.y;
      g.x = e.clientX; g.y = e.clientY;
      if (!g.moved && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) < 4) return;
      if (!g.moved) {
        g.moved = true;
        prevSel = document.body.style.userSelect || '';
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
      }
      /* Wider than the demo's own range — a hand that pulls should get further
         than the demo goes — but still bounded, and it springs back once the
         demo resumes. */
      v.az = clamp(v.az + dx * ORBIT_AZ_PER_PX, -VIEW_AZ_MAX * 1.9, VIEW_AZ_MAX * 1.9);
      v.el = clamp(v.el - dy * ORBIT_EL_PER_PX, -VIEW_EL_MAX * 1.9, VIEW_EL_MAX * 1.9);
      g.vAz = dx * ORBIT_AZ_PER_PX / 16;
      g.vEl = -dy * ORBIT_EL_PER_PX / 16;
    });
    document.addEventListener('pointerup', endGrab);
    document.addEventListener('pointercancel', endGrab);
    window.addEventListener('blur', endGrab);
    document.addEventListener('click', function (e) {
      if (!field.ok) return;
      if (tag && tag.hasAttribute('data-bed')) return;   /* the page pinned its own */
      if (e.target.closest && e.target.closest(CLICKABLE)) return;
      if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) return;
      if (String(window.getSelection())) return;
      rollWithFade();
    });

    var rolling = false;
    function rollWithFade() {
      if (rolling) return;
      rolling = true;
      if (REDUCE) { field.rollWall(); announce(); rolling = false; return; }
      cv.style.transition = 'opacity .26s ease';
      desk.style.transition = 'opacity .26s ease';
      cv.style.opacity = '0';
      setTimeout(function () {
        field.rollWall();
        setTimeout(announce, 60);
        cv.style.opacity = '';
        setTimeout(function () { rolling = false; }, 280);
      }, 260);
    }

    /* A one-line label so the change reads as deliberate rather than as a
       glitch, and so the palette has a name the visitor can ask for. */
    var badge = null, badgeT = 0;
    function announce() {
      if (!field.skyName) return;
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'terse-sky-name';
        badge.setAttribute('aria-live', 'polite');
        document.body.appendChild(badge);
      }
      badge.textContent = field.skyName;
      badge.classList.add('on');
      clearTimeout(badgeT);
      badgeT = setTimeout(function () { badge.classList.remove('on'); }, 1900);
    }

    function sync() {
      field.resize();
      if (!field.ready) { field.start(); return; }          /* still measuring */
      /* Narrow screens used to be frozen here alongside prefers-reduced-motion:
         one static step(16) frame and no loop, which meant a phone never saw
         the agent-log text at all — it only ever cycles while the loop runs.
         The wallpaper is the product on this page, so phones animate too, on a
         smaller particle budget (GLYPH_N above) and the same 40fps cap.
         prefers-reduced-motion still freezes, which is the whole point of it. */
      if (REDUCE) { field.stop(); field.step(16); field.draw(); }
      else field.start();
    }
    sync();
    /* Roll the first sky only once the canvas has a size. readPixels on a 0x0
       drawing buffer returns nothing, the measured luminance comes back 0, and
       the exposure correction then runs the wrong way — it brightens a sky that
       needed darkening. */
    if (!bed) { field.rollWall(); }

    var rt;
    function debounced() { clearTimeout(rt); rt = setTimeout(sync, 180); }
    window.addEventListener('resize', debounced);
    window.addEventListener('load', debounced);
    if (window.ResizeObserver) new ResizeObserver(debounced).observe(document.documentElement);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) field.stop();
      else if (!REDUCE) field.start();
    });

    cv.addEventListener('webglcontextlost', function (e) {
      e.preventDefault(); field.stop(); cv.style.display = 'none';
    });
  }

  /* ── Page copy coloured by the wallpaper behind it ───────────────────────
     The halo and the accent already adapted per wallpaper, but ordinary copy
     stayed WHITE everywhere — exactly what vanishes on a noon sky, and the
     least interesting thing on a dusk one. So every block of copy that sits
     directly on the wallpaper is coloured for the part of the plate behind IT,
     and re-coloured while the page scrolls: the plate is fixed, the copy moves
     across it, so the ground under a paragraph changes as you read.

     The rules are the ones the contrast sweep established:
       - legibility is a floor (4.5:1 against the plate as its halo leaves it),
         vividness only chooses among colours that clear it;
       - the halo it was judged against is guaranteed ([data-tc] in
         terse-glass.css), with a strength taken from that same patch;
       - never red: copy is not a verdict, and red reads as an error.
     Big type takes the most vivid colour, mid-size type the runner-up, body
     copy a lighter tint of the first so long paragraphs stay easy to read.

     Only copy that is currently near-white is touched. Anything with its own
     colour (the accent, a warning, the savings column) keeps it, and anything
     on a ground of its own (buttons, code, pills, price cards) is skipped —
     its colour was never judged against the wallpaper.

     Culling uses cached page offsets, so a scroll frame reads rects only for
     the few dozen blocks near the viewport, never for all of them. */
  function textTint(field) {
    var SKIP_TAG = { PRE: 1, CODE: 1, KBD: 1, SAMP: 1, SVG: 1, CANVAS: 1, VIDEO: 1, IMG: 1, INPUT: 1,
                     TEXTAREA: 1, SELECT: 1, OPTION: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, BUTTON: 1 };
    var OWN_GROUND = 'pre,code,kbd,samp,button,.term-line,.btn-primary,.nav-cta,.badge,.pill,.win-badge,' +
                     '.post-cat,.verdict,.oc-msg,.tc-demo,.cost-row,.price-card,.ams,#clerk-modal,#lang-menu';
    /* Good news keeps to the positive pool — the rule the accent already
       follows. Amber on "✓ 30-day free trial" reads as a caution. */
    var GOOD_RE = /✓|✔|sav(e|ed|es|ing)\b|省|减少|免费|free\b/i;
    var cands = [], cache = {}, pending = false, lastFull = 0;
    var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function rgba(str) {
      var m = str && str.match(/[\d.]+/g);
      return m && m.length >= 3 ? [m[0] / 255, m[1] / 255, m[2] / 255, m.length > 3 ? +m[3] : 1] : null;
    }
    function ownText(el) {
      for (var nd = el.firstChild; nd; nd = nd.nextSibling) if (nd.nodeType === 3 && /\S/.test(nd.nodeValue)) return true;
      return false;
    }
    function grounded(el) {
      if (el.closest && el.closest(OWN_GROUND)) return true;
      for (var a = el, i = 0; a && a !== document.body && i < 10; a = a.parentElement, i++) {
        var cs = getComputedStyle(a), bg = rgba(cs.backgroundColor);
        if (bg && bg[3] >= 0.35) return true;
        /* a gradient ground on a SMALL box is a control (pill, CTA); on a whole
           section it is decoration and the copy still sits on the wallpaper */
        if (a !== el && cs.backgroundImage !== 'none' && a.getBoundingClientRect().height < 120) return true;
      }
      return false;
    }
    function fixedIn(el) {
      for (var a = el; a && a !== document.body; a = a.parentElement)
        if (getComputedStyle(a).position === 'fixed') return true;
      return false;
    }
    function roleOf(el, cs) {
      var fs = parseFloat(cs.fontSize) || 16, t = el.tagName;
      if (t === 'H1' || t === 'H2' || fs >= 26) return 0;
      if (/^H[3-6]$/.test(t) || t === 'STRONG' || t === 'B' || t === 'A' || t === 'LABEL' || fs >= 18) return 1;
      return 2;
    }
    function measure() {
      var sy = window.pageYOffset || 0, keep = [];
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (!el.isConnected) continue;
        var r = el.getBoundingClientRect();
        el.__tcT = el.__tcFixed ? r.top : r.top + sy;
        el.__tcB = el.__tcFixed ? r.bottom : r.bottom + sy;
        keep.push(el);
      }
      cands = keep;
      lastFull = Date.now();
    }
    function scan() {
      var all = document.body.getElementsByTagName('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.__tc || el.__tcNo) continue;
        /* no text yet is NOT a verdict — i18n may fill it in later */
        if (SKIP_TAG[el.tagName] || el.id === 'terse-field' || !ownText(el)) continue;
        var cs = getComputedStyle(el), c = rgba(cs.color);
        if (!c || c[3] < 0.5) { el.__tcNo = 1; continue; }
        var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
        if (mn < 0.55 || mx - mn > 0.18) { el.__tcNo = 1; continue; }      /* has a colour of its own */
        var fill = rgba(cs.webkitTextFillColor);
        if (fill && fill[3] < 0.05) { el.__tcNo = 1; continue; }            /* gradient text: --gradient owns it */
        if (grounded(el)) { el.__tcNo = 1; continue; }
        el.__tc = 1;
        el.__tcRole = roleOf(el, cs);
        el.__tcGood = GOOD_RE.test(el.textContent);
        el.__tcFixed = fixedIn(el);
        el.setAttribute('data-tc', '');
        if (!reduce && cs.transitionDuration === '0s') el.style.transition = 'color .5s ease, -webkit-text-fill-color .5s ease';
        cands.push(el);
      }
      measure();
    }
    function colourFor(reg, role, good) {
      var k = Math.max(1.0, Math.min(1.45, 1.0 + 0.95 * (reg.p90 - 0.45)));
      var a = Math.min(1, 0.85 * k), hL = relLum(field.haloRGB);
      var pool = good ? POSITIVE : NEUTRAL;
      var best = pickTint(reg, null, hL, a, pool), c = best;
      if (role === 1) {
        var rest = [];
        for (var i = 0; i < pool.length; i++) if (pool[i] !== best) rest.push(pool[i]);
        c = pickTint(reg, null, hL, a, rest);
      } else if (role === 2) {
        c = [best[0] + (1 - best[0]) * 0.35, best[1] + (1 - best[1]) * 0.35, best[2] + (1 - best[2]) * 0.35];
      }
      return { css: 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')',
               k: k.toFixed(2) };
    }
    function update() {
      pending = false;
      if (!field.grid && !field.themeP) return;
      if (Date.now() - lastFull > 2500) measure();
      var W = window.innerWidth, H = window.innerHeight, sy = window.pageYOffset || 0, hits = [], rects = [], i;
      for (i = 0; i < cands.length; i++) {
        var e = cands[i], t = e.__tcFixed ? e.__tcT : e.__tcT - sy, b = e.__tcFixed ? e.__tcB : e.__tcB - sy;
        if (b > -H * 0.25 && t < H * 1.25) hits.push(e);
      }
      for (i = 0; i < hits.length; i++) rects.push(hits[i].getBoundingClientRect());   /* all reads, then all writes */
      for (i = 0; i < hits.length; i++) {
        var el = hits[i], r = rects[i];
        if (!r.width || !r.height || r.bottom < 0 || r.top > H) continue;
        var reg = field._region(Math.max(0, r.left / W), Math.min(1, r.right / W),
                                Math.max(0, r.top / H), Math.min(1, r.bottom / H));
        if (!reg) continue;
        var key = (reg.key || 'sky') + '|' + el.__tcRole + (el.__tcGood ? 'g' : '') + '|' + field.themeVer;
        var res = cache[key] || (cache[key] = colourFor(reg, el.__tcRole, el.__tcGood));
        if (el.__tcTag === res.css + res.k) continue;
        el.__tcTag = res.css + res.k;
        el.style.setProperty('color', res.css, 'important');
        el.style.setProperty('-webkit-text-fill-color', res.css, 'important');
        el.style.setProperty('--halo-k', res.k);
      }
    }
    function schedule() {
      if (pending) return;
      pending = true;
      if (window.requestAnimationFrame) window.requestAnimationFrame(update); else setTimeout(update, 16);
    }
    /* capture on document: the window's scroll AND any scrolling container's */
    document.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', function () { measure(); schedule(); });
    window.addEventListener('load', function () { measure(); schedule(); });
    window.addEventListener('terse-theme', function () { cache = {}; schedule(); });
    var mt = 0;
    if (window.MutationObserver) new MutationObserver(function () {
      clearTimeout(mt); mt = setTimeout(function () { scan(); schedule(); }, 700);
    }).observe(document.body, { childList: true, subtree: true });
    var boot = function () { scan(); schedule(); };
    if (window.requestIdleCallback) window.requestIdleCallback(boot, { timeout: 1500 }); else setTimeout(boot, 500);
    field._tt = { scan: scan, measure: measure, update: update, list: function () { return cands; } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
