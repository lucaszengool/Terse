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
  var GW = 256, GH = 64;

  /* the app's cinematic timing (wallpaper-styles.js DEFAULT) */
  var T_IN = 460, T_HOLD = 1450, T_OUT = 720, FILL_GAP = 560;
  var G_LIFE = T_IN + T_HOLD + T_OUT;

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
  ].join('\n');

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
    '    c = spaceColor(p, uTime);',
    '  }',
    '  float s = starLayer(p, 16.0, 0.80, uTime) * 0.85',
    '          + starLayer(p, 34.0, 0.86, uTime) * 0.52',
    '          + starLayer(p, 68.0, 0.90, uTime) * 0.34',
    '          + starLayer(p, 130.0, 0.93, uTime) * 0.20;',
    /* star density follows the band, the way it does in a real sky */
    '  float ang2 = -0.46;',
    '  float by2 = p.x * sin(ang2) + p.y * cos(ang2);',
    '  s *= 0.55 + 0.85 * exp(-by2 * by2 * 1.2);',
    '  c += vec3(0.82, 0.88, 1.0) * s * mix(1.0, 0.38, uHasCover);',
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

    '  gl_Position = vec4((p + disp) / uAspect, 0.0, 1.0);',

    '  float tw = pow(0.5 + 0.5 * sin(t * (0.9 + s2 * 1.7) + s1 * 17.0), 5.0);',
    /* density banks so the field drifts in clouds, never an even speckle */
    '  float cloud = 0.5 + 0.5 * sin(p.x * 1.05 + t * 0.10) * cos(p.y * 1.35 - t * 0.08);',
    '  cloud = 0.18 + 0.82 * smoothstep(0.10, 0.94, cloud);',

    /* colour from the wallpaper, lifted — a galaxy is dark, so the particles
       need the gain the app gets from uColorBoost */
    '  vec3 bed = spaceColor(aHome * uAspect, t);',
    '  bed = pow(max(bed * 3.1, 0.0), vec3(1.0 / 1.65));',
    '  bed = max(bed, vec3(0.055, 0.075, 0.125));',
    '  vec3 cov = pow(max(aColor * 1.90 * uExposure, 0.0), vec3(1.0 / 1.45));',
    '  cov = max(cov, vec3(0.075, 0.090, 0.135));',
    '  bed = mix(bed, cov, uHasCover);',
    '  vColor = mix(bed, vec3(0.86, 0.93, 1.0), tw * 0.30) * (0.85 + tw * 0.55 + ripAmp * 0.9);',
    '  vAlpha = (0.075 + tw * 0.24 + ripAmp * 0.38) * cloud;',
    '  gl_PointSize = (1.2 + tw * 1.3) * uDpr * uBloom;',
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
    'uniform float uForm, uVis, uOut, uInMode, uOutMode, uStagger, uTime, uBloom, uDpr;',
    'uniform vec2 uCenter, uSize, uDrift, uAspect;',
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
    '  gl_Position = vec4(target + d, 0.0, 1.0);',
    '  vColor = uTint;',
    /* twinkle deeper than the field's so the text reads as ALIVE, not printed;
       the (1 - u) term means scattered particles are dim and only the ones that
       have landed on a stroke burn — that is what makes it snap into focus */
    '  vA = aOn * uVis * (0.55 + 0.45 * sin(uTime * 3.4 + aRand * 21.0)) * (1.0 - u * 0.55);',
    '  gl_PointSize = (2.3 + uForm * 2.0) * uDpr * uBloom;',
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
  var GLYPH_FS = PT_FS.replace(/vAlpha/g, 'vA');

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

    this.uBed = u(gl, this.bedProg, ['time', 'aspect', 'hasCover', 'coverScale', 'coverDrift', 'cover', 'exposure', 'soften']);
    this.uFld = u(gl, this.fldProg, ['time', 'bloom', 'dpr', 'aspect', 'ripples', 'alphaScale', 'hasCover', 'exposure',
                                     'danceAmt', 'danceMode', 'danceT', 'danceCenter', 'danceDir']);
    this.uGly = u(gl, this.glyProg, ['form', 'vis', 'out', 'inMode', 'outMode', 'stagger', 'time',
                                     'bloom', 'dpr', 'center', 'size', 'drift', 'aspect', 'tint', 'alphaScale']);

    this.aBedPos = gl.getAttribLocation(this.bedProg, 'aPos');
    this.aHome = gl.getAttribLocation(this.fldProg, 'aHome');
    this.aSeed = gl.getAttribLocation(this.fldProg, 'aSeed');
    this.aColor = gl.getAttribLocation(this.fldProg, 'aColor');
    this.aUv = gl.getAttribLocation(this.glyProg, 'aUv');
    this.aRand = gl.getAttribLocation(this.glyProg, 'aRand');
    this.aOn = gl.getAttribLocation(this.glyProg, 'aOn');

    this._buildGlyphLattice();

    this.rip = new Float32Array(MAX_RIPPLES * 3);
    this.ripples = [];
    this.dance = { amt: 0, mode: 7, t: 0, cx: 0, cy: 0, dx: 1, dy: 0 };
    this.logRot = 0; this.statRot = 0;
    this.glyphIdx = 0; this.glyphSide = 1;
    this.nextFillAt = 0;
    this.t = 0; this.raf = 0;

    this.off = document.createElement('canvas');
    this.off.width = GW * 2; this.off.height = GH * 2;
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
    this.exposure = 1; this.bedLum = 0; this.bedVar = 0; this.soften = 0;
    this.samp = document.createElement('canvas');
    this.sctx = this.samp.getContext('2d', { willReadFrequently: true });
    this.bedPix = null;

    this.ok = true;
    this.resize();
  }

  /* One lattice, shared by all four slots — only the stroke mask differs. */
  Field.prototype._buildGlyphLattice = function () {
    var gl = this.gl, n = GW * GH;
    var uv = new Float32Array(n * 2), rnd = new Float32Array(n);
    var i = 0;
    for (var y = 0; y < GH; y++) {
      for (var x = 0; x < GW; x++) {
        uv[i * 2] = (x + 0.5) / GW;
        uv[i * 2 + 1] = 1.0 - (y + 0.5) / GH;
        rnd[i] = Math.random();
        i++;
      }
    }
    this.glyphN = n;
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
        tint: TINTS.tool, driftX: 0, driftY: 0
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
    var want = Math.min(26000, Math.round((this.w * this.h) / 64));
    var cols = Math.max(2, Math.round(Math.sqrt(want * (this.w / this.h))));
    var rows = Math.max(2, Math.round(want / cols));
    var n = cols * rows; this.n = n;
    var home = new Float32Array(n * 2), seed = new Float32Array(n * 2), i = 0;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        home[i * 2] = ((x + 0.5 + (Math.random() - 0.5) * 0.92) / cols) * 2 - 1;
        home[i * 2 + 1] = 1 - ((y + 0.5 + (Math.random() - 0.5) * 0.92) / rows) * 2;
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
    var SW = 384, SH = Math.max(1, Math.round(SW * this.h / this.w));
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
    this.soften = Math.min(1, Math.max(0, (this.bedVar - 0.003) / 0.011));

    var e = Math.pow(0.11 / Math.max(this.bedLum, 0.012), 0.32);
    this.exposure = Math.min(1.55, Math.max(0.45, e));
    this._sampleColors();
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
    if (this.vid) { try { this.vid.pause(); } catch (e) {} this.vid = null; }
    if (!url) { this.hasCover = 0; this.bedPix = null; this.img = null; this.draw(); return; }

    var isVideo = /\.(mp4|webm)$/i.test(url);
    var stillUrl = isVideo ? url.replace(/\.(mp4|webm)$/i, '.jpg') : url;

    var img = new Image();
    img.onload = function () {
      gl.bindTexture(gl.TEXTURE_2D, self.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      self.img = img;
      self.coverAspect = img.width / img.height;
      self.hasCover = 1;
      self._rasterBed(img);
      self.draw();
    };
    img.onerror = function () { if (!self.vid) { self.hasCover = 0; self.bedPix = null; } };
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
    /* fit the line to the box so every slot renders at the same on-screen size */
    var size = Math.round(H * 0.58);
    o.font = '700 ' + size + "px 'JetBrains Mono','SF Mono',Menlo,monospace";
    var mw = o.measureText(text).width;
    if (mw > W * 0.96) {
      size = Math.max(8, Math.floor(size * (W * 0.96) / mw));
      o.font = '700 ' + size + "px 'JetBrains Mono','SF Mono',Menlo,monospace";
      mw = o.measureText(text).width;
    }
    o.fillText(text, W / 2, H / 2);

    var d = o.getImageData(0, 0, W, H).data;
    var mask = slot.mask, lit = 0, i = 0;
    for (var y = 0; y < GH; y++) {
      for (var x = 0; x < GW; x++) {
        /* the lattice is GWxGH, the canvas is 2x that — sample the centre */
        var sx = x * 2 + 1, sy = y * 2 + 1;
        var on = d[(sy * W + sx) * 4 + 3] > 115 ? 1 : 0;
        mask[i] = on; lit += on;
        i++;
      }
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
    var F = Math.max(22, Math.min(52, this.h * 0.052));   /* on-screen px */
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

  Field.prototype._fire = function (slot, text, tint) {
    if (!this._drawGlyph(slot, text, tint)) return false;
    this._place(slot);
    slot.inMode = (Math.random() * 9) | 0;
    slot.outMode = (Math.random() * 9) | 0;
    slot.stagger = Math.random() < 0.75 ? 0.30 + Math.random() * 0.5 : 0;
    var a = Math.random() * 6.2831;
    slot.driftX = Math.cos(a); slot.driftY = Math.sin(a);
    slot.live = { t: 0 };
    return true;
  };

  Field.prototype.pulse = function (x, y, s) {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({ x: x, y: y, t: 0, s: s == null ? 1 : s });
  };

  Field.prototype.step = function (dt) {
    if (!this.ready) { this.resize(); if (!this.ready) return; }
    this.t += dt;
    var now = this.t;

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
    gl.uniform1f(this.uFld.time, t);
    gl.uniform1f(this.uFld.dpr, this.dpr);
    gl.uniform2fv(this.uFld.aspect, this.aspect);
    gl.uniform3fv(this.uFld.ripples, this.rip);
    gl.uniform1f(this.uFld.danceAmt, this.dance.amt);
    gl.uniform1f(this.uFld.danceMode, this.dance.mode);
    gl.uniform1f(this.uFld.danceT, this.dance.t);
    gl.uniform2f(this.uFld.danceCenter, this.dance.cx, this.dance.cy);
    gl.uniform2f(this.uFld.danceDir, this.dance.dx, this.dance.dy);

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

    /* ── 3. the four glyph slots ── */
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
      gl.uniform1f(this.uGly.bloom, 1.0);
      gl.uniform1f(this.uGly.alphaScale, 1.35 * g);
      gl.drawArrays(gl.POINTS, 0, this.glyphN);
      gl.uniform1f(this.uGly.bloom, 3.6);
      gl.uniform1f(this.uGly.alphaScale, 0.34 * g);
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

    /* Override per page with <script src="/terse-field.js" data-bed="/other.jpg">;
       data-bed="" falls back to the procedural galaxy. A .mp4 here works too and
       plays as a live wallpaper, at the cost of its download. */
    var tag = document.querySelector('script[src*="terse-field"]');
    var bed = tag && tag.hasAttribute('data-bed') ? tag.getAttribute('data-bed') : '/bg-cyber1.jpg';
    if (bed) field.setBed(bed);

    function sync() {
      field.resize();
      if (!field.ready) { field.start(); return; }          /* still measuring */
      if (REDUCE || field.w < MINW) { field.stop(); field.step(16); field.draw(); }
      else field.start();
    }
    sync();

    var rt;
    function debounced() { clearTimeout(rt); rt = setTimeout(sync, 180); }
    window.addEventListener('resize', debounced);
    window.addEventListener('load', debounced);
    if (window.ResizeObserver) new ResizeObserver(debounced).observe(document.documentElement);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) field.stop();
      else if (!REDUCE && field.w >= MINW) field.start();
    });

    cv.addEventListener('webglcontextlost', function (e) {
      e.preventDefault(); field.stop(); cv.style.display = 'none';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
