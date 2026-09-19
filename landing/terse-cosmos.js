/* ═══════════════════════════════════════════════════════════════════════════
   terse-cosmos.js — the 3D particle stage behind every landing page.

   A port, not an imitation, of the black-mode particle section of the Terse
   promo (remotion-flash, TerseFlashBlack, 0:46–1:05). Every number below comes
   from that project's source, and the file it came from is named beside it:

     · THE VOLUME is Mineradio's PULSE layer (preset 5, lib/mineradio-shaders.ts):
       aurora ribbon bands swept along spiral arcs from z −23.5 to 15.5, plus a
       lane of star dust. In the black cut the flat SILK grid is all but switched
       off (silkAlpha 0.03 — "画面交给体积状的 PULSE"), so this is the layer that
       carries the whole picture, and it is the only one ported.
     · TWO CAMERAS on one orbit (lib/mrwallpaper.tsx): PULSE at z 62 with a
       11.5-unit half-height frame, the text plane at z 12 with 2.4. Both sit on
       a sphere by the same yaw/pitch and look at the origin, so the text tilts
       WITH the volume — it lives in the space, it is not a sticker on the glass.
     · THE MOVES (lib/flashcam.ts): flat → a hard 18-frame push to 0.70 → a drag
       that swings +42° and back through to −42° → settle → the black-cut show
       sweeps −68° ↔ +68° (outExpo) → slow push-ins onto the text (smooth).
     · THE RHYTHM (lib/tokenbeat.ts): smootherstep-attack × exponential-decay
       impacts, summed into bass/mid/treble/beat/energy exactly as the renderer
       drives them, with a burst every 50 frames.
     · THE TEXT (lib/tokenstats.ts, lib/statlyrics.tsx): the hero lines every 46
       frames at scale 1.55, small stats every 34 at 0.58, the six kind colours,
       glyph box 3.05 × 0.52, in 12 / hold 30 / out 20 frames. English only.

   The video's cloud was sampled from a code-graph cosmos. That picture is never
   shown here — the page is black — it only lends the particles their colour, so
   it ships as a 256×144 still (cosmos-src.jpg, ~9KB), not the 239MB video.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.TerseCosmos) return;

  var REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var MOBILE = (window.innerWidth || 1024) < 760;

  /* ── the video's numbers ─────────────────────────────────────────────────── */
  var FPS = 30;
  var PULSE_CAM_Z = 62, PULSE_HALF_H = 11.5;          /* mrwallpaper.tsx:70 */
  var SILK_CAM_Z = 12, SILK_HALF_H = 2.4;             /* PLANE_SIZE 4.8 / 2 */
  var PULSE_GRID_Y = MOBILE ? 110 : 150;              /* pulseGridY = 150 */
  var PULSE_ALPHA = 0.95, PULSE_POINT = 2.6;          /* black cut: pulsePointScale 2.6 */
  var BLOOM_SIZE = 2.65, BLOOM_STRENGTH = 0.62;
  var COLOR_BOOST = 1.1;
  var GLYPH_N = MOBILE ? 26000 : 60000;               /* glyphCount = 60000 */
  var GLYPH_W = 3.05, GLYPH_H = 0.52, GLYPH_ALPHA = 0.95;
  var G_IN = 12, G_HOLD = 30, G_OUT = 20, G_LIFE = G_IN + G_HOLD + G_OUT;
  var HERO_FROM = 20, HERO_EVERY = 46, HERO_SCALE = 1.55;
  var SMALL_FROM = 90, SMALL_EVERY = 34, SMALL_SCALE = 0.58;
  var ACTIVITY = 0.66, SWELL = 0.16, SWELL_SEC = 9, BURST_EVERY = 50, BURST_GAIN = 2.4;
  var RIPPLE_LIFE = 2.0;                              /* MR_RIPPLE_LIFE */

  var TINT = {                                        /* tokenstats.ts STAT_TINT */
    saved: '#C9F03D', spent: '#FF9F45', cache: '#5AD8FF',
    compact: '#B98CFF', cost: '#FFD75A', agents: '#7CF5C0'
  };
  var TINT_RGB = {}, WHITE_RGB = [1, 1, 1];            /* parsed once, not per line per frame */
  for (var tk in TINT) TINT_RGB[tk] = hex(TINT[tk]);
  /* statlyrics.tsx LINES — the English column */
  var LINES = [
    ['agents', '3 agents in one room'], ['spent', '336.6M tokens in'], ['cache', 'end-to-end encrypted'],
    ['saved', '7/7 tests passed'], ['compact', 'handoff → inbox'], ['cost', '$0.71 / $3 cap'],
    ['agents', "Lin's agent: on it"], ['cache', 'cache 61%'], ['spent', 'Read(api/rate-limiter.js)'],
    ['saved', '+12,962 tok'], ['compact', 'Mia joined the room'], ['spent', 'Bash(node --test)']
  ];
  /* tokenstats.ts CYCLE */
  var CYCLE = [
    ['saved', '+1,284 tok'], ['agents', '3 agents live'], ['cache', '4827 1906 3355 7042'], ['spent', '336.6M in'],
    ['compact', 'file → quarantine'], ['cost', '$0.29'], ['agents', 'Mia\'s agent: fixed'], ['cache', 'prefix ↺ 61%'],
    ['saved', '7/7 passed'], ['compact', 'agents paused · 8 in a row'], ['spent', 'ctx 47%'], ['agents', 'handoff → James']
  ];

  /* ── tokenbeat.ts: the impact envelope ──────────────────────────────────── */
  var ATK = 0.22, DEC = 0.62;
  function smoother(u) { return u * u * u * (u * (u * 6 - 15) + 10); }
  function envRaw(dt) { return smoother(Math.min(1, dt / ATK)) * Math.exp(-dt / DEC); }
  var ENV_PEAK = (function () { var m = 0; for (var i = 0; i <= 400; i++) m = Math.max(m, envRaw(i * 0.005)); return m; })();
  function env(dt) { return dt <= 0 ? 0 : envRaw(dt) / ENV_PEAK; }
  function h1(n) { var s = Math.sin(n * 127.1 + 3.71) * 43758.5453123; return s - Math.floor(s); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { var x = clamp01(t); return x * x * (3 - 2 * x); }
  function outExpo(t) { var x = clamp01(t); return 1 - Math.pow(2, -9 * x); }
  function settleE(t) { var x = clamp01(t); return 1 - Math.pow(2, -7 * x) * Math.cos(x * Math.PI * 2.2); }
  function seg(f, a, b) { return clamp01((f - a) / (b - a)); }
  function hex(c) { return [parseInt(c.substr(1, 2), 16) / 255, parseInt(c.substr(3, 2), 16) / 255, parseInt(c.substr(5, 2), 16) / 255]; }

  /* ── shaders ────────────────────────────────────────────────────────────── */
  var NOISE = [
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}',
    'vec4 tis(vec4 r){return 1.79284291400159-0.85373472095314*r;}',
    'float snoise(vec3 v){',
    '  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);',
    '  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);',
    '  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;',
    '  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);',
    '  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;',
    '  i=mod289(i);',
    '  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));',
    '  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;',
    '  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);',
    '  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);',
    '  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);',
    '  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 nm=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3))); p0*=nm.x; p1*=nm.y; p2*=nm.z; p3*=nm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}',
    'float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }'
  ].join('\n');

  /* mineradio-shaders.ts MR_VS, preset 5 (WALLPAPER PULSE) and the common tail */
  var PULSE_VS = [
    'precision highp float;',
    'attribute vec2 aUv;',
    'attribute float aRand;',
    'uniform mat4 uView, uProj;',
    'uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uBurstAmt;',
    'uniform float uPixel, uPointScale, uBloomSize, uMaxPt, uColorBoost, uHasCover;',
    'uniform sampler2D uCoverTex;',
    /* the film's hand (mineradio-shaders.ts): open palm pushes a hole, a fist winds
       the field into a vortex, a pinch is a black hole at the fingertip. All zero = off. */
    'uniform vec2 uHandXY;',
    'uniform float uHandActive, uHandRad, uVortexK, uVortexAng, uHole;',
    'varying vec3 vColor;',
    'varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;',
    '#define PI 3.14159265359',
    NOISE,
    'void main(){',
    '  float t = uTime;',
    '  vec3 pos;',
    '  vec3 coverColor = texture2D(uCoverTex, vec2(clamp(aUv.x, 0.002, 0.998), clamp(aUv.y, 0.002, 0.998))).rgb;',
    '  vec3 defaultColor = mix(vec3(0.36, 0.28, 0.72), mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), aUv.x), aUv.y);',
    '  coverColor = mix(defaultColor, coverColor, uHasCover);',
    '  vColor = coverColor; vAlpha = 1.0;',
    '  float maxRippleAmp = 0.0;',
    '  float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;',
    '  float midGlow = smoothstep(0.07, 0.62, uMid) * 0.42;',
    '  float highGlow = smoothstep(0.04, 0.46, uTreble) * 0.46;',
    '  float lane = aUv.y;',
    '  float transition = clamp(uBurstAmt, 0.0, 1.0);',
    '  if (lane < 0.80) {',
    '    float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;',
    '    float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);',
    '    float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;',
    '    float band = floor(bandCoord);',
    '    float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);',
    '    float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);',
    '    float seed = hash11(band * 19.17 + aRand * 31.0);',
    '    float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);',
    '    float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);',
    '    float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);',
    '    float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;',
    '    float x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5);',
    '    float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;',
    '    float broadWave = sin(ribbonPhase) * 0.92;',
    '    float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;',
    '    float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92;',
    '    float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;',
    '    float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));',
    '    float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));',
    '    float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;',
    '    float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;',
    '    pos.x = x + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;',
    '    pos.y = yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);',
    '    pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;',
    '    float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);',
    '    vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);',
    '    aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);',
    '    vAlpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);',
    '    vColor = mix(coverColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);',
    '    maxRippleAmp = max(maxRippleAmp, ridge * (0.12 + midGlow * 0.05) + pulseLine * highGlow * 0.045 + bassGlow * 0.030);',
    '  } else {',
    '    float q = (lane - 0.80) / 0.20;',
    '    float seed = hash11(aRand * 917.0 + floor(q * 130.0));',
    '    float depth = mix(-32.0, 18.0, seed);',
    '    float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);',
    '    float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));',
    '    float x = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;',
    '    float y = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;',
    '    float z = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;',
    '    float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);',
    '    float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));',
    '    pos = vec3(x, y, z);',
    '    vAlpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);',
    '    vColor = mix(coverColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);',
    '    maxRippleAmp = max(maxRippleAmp, twinkle * highGlow * 0.055 + dust * bassGlow * 0.030);',
    '  }',
    '  if (transition > 0.001) {',
    '    float bloom = smoothstep(0.0, 1.0, transition);',
    '    vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;',
    '    vec2 burstDir = burstVec / max(length(burstVec), 0.001);',
    '    pos.xy += burstDir * bloom * 0.026;',
    '    pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;',
    '    pos.xy *= 1.0 + bloom * 0.014;',
    '    pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;',
    '    vAlpha *= 0.86 + bloom * 0.22;',
    '    maxRippleAmp = max(maxRippleAmp, bloom * 0.10);',
    '  }',
    /* mineradio-shaders.ts 562-596, verbatim */
    '  if (uHandActive > 0.01) {',
    '    float hdx = pos.x - uHandXY.x, hdy = pos.y - uHandXY.y;',
    '    float hd = sqrt(hdx * hdx + hdy * hdy);',
    '    float hr = max(1.0, uHandRad), rad = 1.55 * hr;',
    '    if (hd < rad) {',
    '      float push = (rad - hd) / rad; push = push * push * uHandActive;',
    '      pos.z += push * 1.10 * hr;',
    '      pos.xy += vec2(hdx, hdy) / max(0.001, hd) * push * 0.28 * (hr > 1.0 ? hr * 1.7 : 1.0);',
    '    }',
    '  }',
    '  if (uVortexK > 0.001 || uHole > 0.001) {',
    '    vec2 dv = pos.xy - uHandXY; float dd = length(dv), vr = max(1.0, uHandRad);',
    '    if (uVortexK > 0.001) {',
    '      float ang = uVortexAng * (0.35 + 2.2 / (1.0 + dd / (2.2 * vr))) * uVortexK;',
    '      float cs = cos(ang), sn = sin(ang);',
    '      vec2 rv = mat2(cs, -sn, sn, cs) * dv;',
    '      rv *= mix(1.0, 0.62 + 0.38 * smoothstep(0.0, 6.0 * vr, dd), uVortexK);',
    '      pos.xy = uHandXY + rv;',
    '      pos.z += uVortexK * 1.4 * vr * exp(-dd / (3.0 * vr));',
    '    }',
    '    if (uHole > 0.001) {',
    '      float pull = uHole * exp(-dd / (4.0 * vr));',
    '      pos.xy = mix(pos.xy, uHandXY + (dv / max(dd, 1e-4)) * 0.2 * vr, pull);',
    '      pos.z += pull * 2.0 * vr;',
    '    }',
    '  }',
    /* common tail — colour, brightness, size */
    '  vSourceLum = dot(max(vColor, vec3(0.0)), vec3(0.299, 0.587, 0.114));',
    '  vEdgeBoost = 0.0;',
    '  vColor = pow(max(vColor, vec3(0.0)), vec3(1.0 / max(0.35, uColorBoost)));',
    '  vBright = 0.94 + maxRippleAmp * 0.34 + uBass * 0.020 + uEnergy * 0.026 + uBurstAmt * 0.025;',
    '  vRipple = clamp(maxRippleAmp * 1.5, 0.0, 1.0);',
    '  vec4 mvPos = uView * vec4(pos, 1.0);',
    '  float depthSize = 36.0 / max(0.5, -mvPos.z);',
    '  float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060 + uBurstAmt * 0.090 + uBeat * 0.055;',
    '  float sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);',
    '  gl_PointSize = min(uMaxPt, sz * uPixel * uPointScale * uBloomSize);',
    '  gl_Position = uProj * mvPos;',
    /* Alpha EXACTLY zero — the dust lane where smoothstep returns 0 (22%+ of it)
       and the ribbons' bottom edge — used to rasterise a full point in both
       passes and change nothing: with source alpha 0, the normal blend and the
       additive blend both leave the framebuffer bit-for-bit as it was. Park it
       outside the clip volume so it is never rasterised. Same pixels, less work. */
    '  if (vAlpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '}'
  ].join('\n');

  var PULSE_FS = [                                    /* MR_FS */
    'precision highp float;',
    'uniform sampler2D uDotTex;',
    'uniform float uAlpha;',
    'varying vec3 vColor;',
    'varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;',
    'void main(){',
    '  vec4 tex = texture2D(uDotTex, gl_PointCoord);',
    '  if (tex.a < 0.02) discard;',
    '  vec3 col = vColor * vBright;',
    '  col = mix(col, col * 1.3 + vec3(0.05), vEdgeBoost * 0.35);',
    '  col = mix(col, col * 1.2, vRipple * 0.4);',
    '  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);',
    '  float nonBlack = 1.0 - keepBlack;',
    '  float dotDist = length(gl_PointCoord - vec2(0.5)) * 2.0;',
    '  float readableRim = smoothstep(0.44, 0.94, dotDist) * (1.0 - smoothstep(0.94, 1.08, dotDist)) * tex.a;',
    '  float outLum = dot(col, vec3(0.299, 0.587, 0.114));',
    '  float lightParticle = smoothstep(0.50, 0.82, outLum) * nonBlack;',
    '  float darkParticle = (1.0 - smoothstep(0.20, 0.50, outLum)) * nonBlack;',
    '  col = mix(col, vec3(0.0), readableRim * lightParticle * 0.38);',
    '  col = mix(col, vec3(1.0), readableRim * darkParticle * 0.20);',
    '  col = clamp(col, vec3(0.0), vec3(1.6));',
    '  gl_FragColor = vec4(col, tex.a * uAlpha * vAlpha);',
    '}'
  ].join('\n');

  var PULSE_BLOOM_FS = [                              /* MR_BLOOM_FS */
    'precision highp float;',
    'uniform sampler2D uDotTex;',
    'uniform float uAlpha, uBloomStrength;',
    'varying vec3 vColor;',
    'varying float vBright, vRipple, vEdgeBoost, vAlpha, vSourceLum;',
    'void main(){',
    '  vec4 tex = texture2D(uDotTex, gl_PointCoord);',
    '  if (tex.a < 0.01) discard;',
    '  float soft = tex.a * tex.a;',
    '  vec3 col = vColor * (0.55 + vBright * 0.62);',
    '  col = mix(col, col + vec3(0.22, 0.18, 0.10), vEdgeBoost * 0.35);',
    '  col = clamp(col, vec3(0.0), vec3(1.8));',
    '  float pulse = 1.0 + vRipple * 0.65;',
    '  float keepBlack = 1.0 - smoothstep(0.025, 0.115, vSourceLum);',
    '  float bloomKeep = 1.0 - keepBlack * 0.92;',
    '  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * pulse * 0.55 * vAlpha * bloomKeep);',
    '}'
  ].join('\n');

  /* mrwallpaper.tsx GLYPH_VS — the text lives ON the plane, in the orbit */
  var GLYPH_VS = [
    'precision highp float;',
    'attribute vec2 aUv;',
    'attribute float aRand;',
    'uniform mat4 uView, uProj;',
    'uniform float uForm, uVis, uPixel, uTime, uBloomSize, uOut, uInMode, uOutMode, uMaxPt;',
    'uniform vec2 uCenter, uSize;',
    'uniform vec3 uTint;',
    'varying vec3 vColor;',
    'varying float vA;',
    'vec3 dispAt(float mode, float u, vec2 rel){',
    '  float a = aRand * 6.2831;',
    '  if (mode < 0.5) return vec3(vec2(cos(a), sin(a)) * (0.55 + aRand * 1.35) * u, u * (aRand - 0.5) * 1.6);',
    '  else if (mode < 1.5) return vec3(vec2(sin(aRand * 31.0) * 0.34, 1.05 + aRand * 2.10) * u, u * (aRand - 0.5) * 0.7);',
    '  else if (mode < 2.5) { float ang = u * 3.2 * (0.55 + aRand * 0.90); float c = cos(ang), s = sin(ang);',
    '    return vec3(mat2(c, -s, s, c) * rel * (1.0 + u * 1.15) - rel, u * (aRand - 0.5) * 1.2); }',
    '  else if (mode < 3.5) return vec3(vec2(-2.90 * u, sin(aRand * 17.0) * 0.22 * u), u * (aRand - 0.5) * 0.5);',
    '  vec2 dir = rel / max(length(rel), 0.001);',
    '  return vec3(dir * (u * (1.15 + aRand * 2.30)) + vec2(cos(a), sin(a)) * u * 0.45, u * (aRand - 0.5) * 3.0);',
    '}',
    'void main(){',
    '  vec2 target = uCenter + (aUv - 0.5) * uSize;',
    '  vec2 rel = target - uCenter;',
    '  float u = clamp(1.0 - uForm, 0.0, 1.0);',
    '  vec3 d = dispAt(uOut > 0.0 ? uOutMode : uInMode, u, rel);',
    '  vColor = uTint;',
    '  vA = uVis * (0.62 + 0.38 * sin(uTime * 2.6 + aRand * 21.0));',
    '  vec4 mv = uView * vec4(target + d.xy, d.z, 1.0);',
    '  gl_PointSize = min(uMaxPt, (2.5 + uForm * 1.5) * uPixel * uBloomSize);',
    '  gl_Position = uProj * mv;',
    '}'
  ].join('\n');

  var GLYPH_FS = [
    'precision highp float;',
    'uniform sampler2D uDotTex;',
    'uniform float uAlpha, uSoft;',
    'varying vec3 vColor;',
    'varying float vA;',
    'void main(){',
    '  vec4 t = texture2D(uDotTex, gl_PointCoord);',
    '  if (t.a < 0.02) discard;',
    '  float a = mix(t.a, t.a * t.a, uSoft);',
    '  gl_FragColor = vec4(vColor, a * vA * uAlpha);',
    '}'
  ].join('\n');

  /* ── the console (remotion-flash S20_AgentConsole.tsx) ──────────────────
     The film computes every console particle on the CPU, per frame, as a pure
     function of the frame number. Same model here, but on the GPU: each line is
     rasterised ONCE into static attributes, and this shader runs the film's
     entry / exit / hand math from a single frame uniform. Nothing per frame on
     the CPU but a handful of uniforms.
       a0 = panel x, panel y, alpha, dark-halo flag
       a1 = rnd, rnd2, reading order (stream: arc), line alpha
       a2 = born, die, entry + 8 * exit, sweep (stream: speed)
       a3 = from.xy (flow / stream start), to.xy (absorb / stream end)
     entry: 0 fade, 1 flow, 2 rain, 3 assemble, 7 stream · exit: 0 none, 1 dust, 2 absorb, 3 shatter */
  var CON_VS = [
    'precision highp float;',
    'attribute vec4 a0, a1, a2, a3;',
    'attribute vec3 aCol, aTint;',
    'uniform mat4 uView, uProj;',
    'uniform float uF, uPx, uMaxPt, uU, uVis, uRefZ;',
    'uniform vec2 uWH;',
    'uniform vec3 uOrigin;',
    'uniform vec4 uHand;',
    'uniform vec2 uVortex;',
    'varying vec3 vC;',
    'varying float vA;',
    'float cl(float t){ return clamp(t, 0.0, 1.0); }',
    'float sm(float t){ float x = cl(t); return x * x * (3.0 - 2.0 * x); }',
    'void main(){',
    '  float x = a0.x, y = a0.y, z = 0.0, a = a0.z * a1.w, sz = 1.0, fresh = 0.0, xmix = 0.0, heat = 0.0;',
    '  float r = a1.x, r2 = a1.y, order = a1.z;',
    '  float ent = mod(a2.z, 8.0), ex = floor(a2.z / 8.0 + 0.001), sweep = a2.w;',
    '  float age = uF - a2.x, exK = uF - a2.y;',
    '  if (age < 0.0 || exK > 64.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec3(0.0); vA = 0.0; return; }',
    '  if (ent > 6.5) {',
    '    float ph = fract(r * 7.31 + uF * sweep / 30.0);',
    '    vec2 d = a3.zw - a3.xy; vec2 nrm = vec2(-d.y, d.x) / max(length(d), 1.0);',
    '    vec2 p = a3.xy + d * ph + nrm * sin(ph * 3.14159) * order * (0.6 + 0.8 * r2);',
    '    x = p.x; y = p.y; a = sin(ph * 3.14159) * sm(age / 12.0) * a1.w; sz = 1.1 + r;',
    '  } else if (ent > 0.5 && ent < 1.5) {',
    '    float k = (age - r * 3.6) / 18.0;',
    '    if (k <= 0.0) a = 0.0;',
    '    else if (k < 1.0) {',
    '      float e = 1.0 - pow(1.0 - k, 3.0), ang = r * 43.98;',
    '      vec2 f = a3.xy + vec2(cos(ang), sin(ang)) * r2 * 6.0, dd = vec2(x, y) - f;',
    '      float sw = e * (1.0 - e) * (r - 0.5) * 0.7;',
    '      x = f.x + dd.x * e - dd.y * sw; y = f.y + dd.y * e + dd.x * sw; z += (r2 - 0.5) * 200.0 * (1.0 - e); sz = 1.0 + (1.0 - e) * 1.2;',
    '    }',
    '    fresh = (1.0 - sm((k - 0.55) / 0.45)) * 0.7;',
    '  } else if (ent > 1.5 && ent < 2.5) {',
    '    float k = (age - order * sweep - r * 3.0) / 16.0;',
    '    if (k <= 0.0) a = 0.0;',
    '    else {',
    '      if (k < 1.0) { float fx = x + (r - 0.5) * 24.0, fy = y - 26.0 - r2 * 26.0, b = 1.0 - pow(2.0, -9.0 * k) * cos(k * 10.0);',
    '        x = fx + (x - fx) * b; y = fy + (y - fy) * b; sz = 1.0 + (1.0 - k) * 0.8; }',
    '      a *= sm(k / 0.08); fresh = 1.0 - sm((k - 0.55) / 0.45);',
    '    }',
    '  } else if (ent > 2.5 && ent < 3.5) {',
    '    float k = (age - order * sweep - r * 4.0) / 18.0;',
    '    if (k <= 0.0) a = 0.0;',
    '    else {',
    '      if (k < 1.0) { float e = 1.0 - pow(1.0 - k, 3.0), fx = x + 40.0 + r * 120.0, fy = y + (r2 - 0.5) * 60.0;',
    '        x = fx + (x - fx) * e; y = fy + (y - fy) * e; sz = 1.0 + (1.0 - e) * 1.1; }',
    '      a *= sm(k / 0.08); fresh = 1.0 - sm((k - 0.55) / 0.45);',
    '    }',
    '  } else a *= cl(age / 8.0);',
    '  if (exK >= 0.0 && ex > 0.5) {',
    '    if (ex < 1.5) { float k = exK / 14.0;',
    '      x += (fract(sin(r * 91.7 + r2 * 13.1) * 43758.5) - 0.3) * 50.0 * k; y -= (20.0 + r * 40.0) * (1.0 - pow(1.0 - cl(k), 3.0)); z += r * 160.0 * k; a *= 1.0 - cl(k); }',
    '    else if (ex < 2.5) { float k = cl((exK - order * 5.0 - r * 3.0) / 14.0), e = k * k * k;',
    '      vec2 dd = a3.zw - vec2(x, y); float bow = sin(e * 3.14159) * (r - 0.5) * 0.25;',
    '      x += dd.x * e - dd.y * bow; y += dd.y * e + dd.x * bow; xmix = k; sz *= 1.0 + sin(k * 3.14159) * 0.8; a *= 1.0 - sm((k - 0.82) / 0.18); }',
    '    else { float t = max(0.0, exK - order * 4.0) / 30.0, k = cl((exK - order * 4.0) / 28.0);',
    '      x += (r - 0.5) * 140.0 * t; y += (-60.0 - r2 * 90.0) * t + 900.0 * t * t; z += (r - 0.5) * 120.0 * t;',
    '      xmix = min(1.0, k * 3.0); sz *= 1.0 + min(1.0, k * 4.0) * 0.5; a *= 1.0 - sm((k - 0.35) / 0.65); }',
    '  }',
    /* the hand, in panel pixels — S20 lines 488-512 */
    '  if (uHand.z > 0.01 || uHand.w > 0.01 || uVortex.x > 0.01) {',
    '    vec2 dv = vec2(x, y) - uHand.xy; float d = length(dv) + 1e-3;',
    '    if (uHand.z > 0.01 && d < 130.0) { float k = 1.0 - d / 130.0, kk = k * k * uHand.z;',
    '      x += dv.x / d * kk * 117.0; y += dv.y / d * kk * 117.0; z += kk * 180.0; sz *= 1.0 + kk * 0.5; }',
    '    if (uVortex.x > 0.01) { float ang = uVortex.y * (0.3 + 2.4 / (1.0 + d / 160.0)) * uVortex.x, cs = cos(ang), sn = sin(ang);',
    '      float s2 = 1.0 + (0.6 + 0.4 * min(1.0, d / 700.0) - 1.0) * uVortex.x;',
    '      vec2 rv = mat2(cs, sn, -sn, cs) * dv * s2;',
    '      x = uHand.x + rv.x; y = uHand.y + rv.y; z += uVortex.x * 160.0 * exp(-d / 300.0); heat = max(heat, uVortex.x * exp(-d / 320.0)); }',
    '    if (uHand.w > 0.01) { float pull = uHand.w * exp(-d / 260.0);',
    '      x += (uHand.x - x) * pull; y += (uHand.y - y) * pull; z += pull * 120.0; heat = max(heat, pull); }',
    '  }',
    '  x += sin(uF * 0.23 + r * 40.0) * 0.2; y += cos(uF * 0.19 + r2 * 23.0) * 0.2;',
    '  vec3 c = aCol;',
    '  if (a0.w < 0.5) {',
    '    c = mix(c, aTint, fresh * 0.85);',
    '    c = mix(c, ex > 2.5 ? vec3(1.0, 0.557, 0.557) : vec3(0.788, 0.941, 0.239), xmix);',
    '    if (heat > 0.01) c = mix(c, vec3(1.0, 0.66, 0.24), heat * 0.6);',
    '  }',
    '  vC = c; vA = a * uVis;',
    '  vec4 mv = uView * vec4(uOrigin + vec3((x - uWH.x * 0.5) * uU, -(y - uWH.y * 0.5) * uU, z * uU), 1.0);',
    '  gl_PointSize = min(uMaxPt, max(1.0, (a0.w > 0.5 ? 2.0 : 1.25) * sz * uPx * uRefZ / max(0.5, -mv.z)));',
    '  gl_Position = uProj * mv;',
    '  if (vA <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
    '}'
  ].join('\n');
  var CON_FS = [
    'precision highp float;',
    'varying vec3 vC;',
    'varying float vA;',
    'void main(){',
    '  float a = (1.0 - smoothstep(0.38, 0.5, length(gl_PointCoord - vec2(0.5)))) * vA;',
    '  if (a < 0.01) discard;',
    '  gl_FragColor = vec4(vC, a);',
    '}'
  ].join('\n');

  /* screen-space sprites — the hand's particle skeleton (hand.tsx Skeleton), in device pixels */
  var SPR_VS = [
    'precision highp float;',
    'attribute vec4 aP;',
    'attribute vec3 aC;',
    'uniform vec2 uRes;',
    'varying vec3 vC;',
    'varying float vA;',
    'void main(){',
    '  vC = aC; vA = aP.w;',
    '  gl_PointSize = aP.z;',
    '  gl_Position = vec4(aP.x / uRes.x * 2.0 - 1.0, 1.0 - aP.y / uRes.y * 2.0, 0.0, 1.0);',
    '}'
  ].join('\n');
  var SPR_FS = [
    'precision highp float;',
    'uniform sampler2D uDotTex;',
    'varying vec3 vC;',
    'varying float vA;',
    'void main(){',
    '  vec4 t = texture2D(uDotTex, gl_PointCoord);',
    '  if (t.a < 0.02) discard;',
    '  gl_FragColor = vec4(vC, t.a * vA);',
    '}'
  ].join('\n');

  /* ── console bake: each line rasterised ONCE (S20 rasterLine, ported) ────
     Drawn in its true colour with a dark halo (the shadow drawn twice), because
     the panel is 100% transparent and the field behind it can be any brightness.
     Bright pixels are one particle each; dark (halo) pixels take every other
     cell and draw 2x2. Dark INK (on the amber / lime pills) skips the halo path,
     or its strokes get smeared into a blot. */
  var C_SANS = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  var C_MONO = "'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, 'PingFang SC', monospace";
  var ENTRY = { fade: 0, flow: 1, rain: 2, assemble: 3, stream: 7 }, EXIT = { dust: 1, absorb: 2, shatter: 3 };
  function hexRgb(h) { var n = parseInt(h.slice(1, 7), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  function h2(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }
  function fontOf(L, K) { return (L.weight || 600) + ' ' + Math.round((L.px || 13) * K) + 'px ' + (L.mono ? C_MONO : C_SANS); }
  var PROBE = null;
  function rasterLine(L, K) {
    var rgb = hexRgb(L.color), i, x, y;
    if (L.stream) {
      var sn = L.stream.n, sgc = new Float32Array(sn * 3);
      for (i = 0; i < sn; i++) { sgc[i * 3] = rgb[0]; sgc[i * 3 + 1] = rgb[1]; sgc[i * 3 + 2] = rgb[2]; }
      return { gx: new Float32Array(sn), gy: new Float32Array(sn), ga: new Float32Array(sn), gc: sgc, big: new Uint8Array(sn), n: sn, w: 0 };
    }
    var inkDark = !L.rect && 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 0.3, halo = !L.rect && !inkDark;
    var PAD = halo ? Math.ceil(5 * K) : 2, w, h, tw = 0;
    if (!PROBE) PROBE = mkCanvas(1, 1).getContext('2d');
    if (L.rect) { w = Math.ceil(L.rect[0] * K) + PAD * 2; h = Math.ceil(L.rect[1] * K) + PAD * 2; }
    else { PROBE.font = fontOf(L, K); tw = PROBE.measureText(L.text).width / K; w = Math.ceil(tw * K) + PAD * 2 + 2; h = Math.ceil((L.px || 13) * K * 1.45) + PAD * 2; }
    var c1 = mkCanvas(w, h), g1 = c1.getContext('2d');
    g1.fillStyle = L.color; g1.strokeStyle = L.color;
    if (L.rect) {
      var x0 = PAD, y0 = PAD, x1 = PAD + L.rect[0] * K, y1 = PAD + L.rect[1] * K, r = Math.min(L.rect[2] * K, (x1 - x0) / 2, (y1 - y0) / 2);
      g1.beginPath();
      g1.moveTo(x0 + r, y0); g1.lineTo(x1 - r, y0); g1.quadraticCurveTo(x1, y0, x1, y0 + r);
      g1.lineTo(x1, y1 - r); g1.quadraticCurveTo(x1, y1, x1 - r, y1);
      g1.lineTo(x0 + r, y1); g1.quadraticCurveTo(x0, y1, x0, y1 - r);
      g1.lineTo(x0, y0 + r); g1.quadraticCurveTo(x0, y0, x0 + r, y0);
      if (L.rect[3]) { g1.lineWidth = 1.2 * K; g1.stroke(); } else g1.fill();
    } else { g1.font = fontOf(L, K); g1.textBaseline = 'top'; g1.fillText(L.text, PAD, PAD + (L.px || 13) * K * 0.1); }
    var c = mkCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
    if (halo) {
      g.shadowColor = 'rgba(0,0,0,0.82)'; g.shadowBlur = 3.5 * K; g.shadowOffsetX = w; g.shadowOffsetY = 0.5 * K;
      g.drawImage(c1, -w, 0); g.drawImage(c1, -w, 0);
      g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
    }
    g.drawImage(c1, 0, 0);
    var d = g.getImageData(0, 0, w, h).data, n = 0;
    var dark = function (q) { return !inkDark && d[q] + d[q + 1] + d[q + 2] < 90; };
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = (y * w + x) * 4; if (d[i + 3] < 16) continue;
      if (dark(i)) { if ((x & 1) === 0 && (y & 1) === 0) n++; } else if (d[i + 3] > 30) n++;
    }
    var off = L.align === 'right' ? -tw : L.align === 'center' ? -tw / 2 : 0;
    var o = { gx: new Float32Array(n), gy: new Float32Array(n), ga: new Float32Array(n), gc: new Float32Array(n * 3), big: new Uint8Array(n), n: n, w: L.rect ? L.rect[0] : tw }, k = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = (y * w + x) * 4; if (d[i + 3] < 16) continue;
      var dk = dark(i);
      if (dk ? ((x & 1) !== 0 || (y & 1) !== 0) : d[i + 3] <= 30) continue;
      o.gx[k] = L.x + off + (x + (dk ? 0.5 : 0) - PAD) / K; o.gy[k] = L.y + (y + (dk ? 0.5 : 0) - PAD) / K;
      o.ga[k] = d[i + 3] / 255;
      o.gc[k * 3] = d[i] / 255; o.gc[k * 3 + 1] = d[i + 1] / 255; o.gc[k * 3 + 2] = d[i + 2] / 255;
      o.big[k] = dk ? 1 : 0; k++;
    }
    return o;
  }
  /* all lines → six static attribute arrays (layout documented at CON_VS) */
  function packConsole(L, G) {
    var N = 0, li, i;
    for (li = 0; li < G.length; li++) N += G[li].n;
    var A0 = new Float32Array(N * 4), A1 = new Float32Array(N * 4), A2 = new Float32Array(N * 4), A3 = new Float32Array(N * 4);
    var COL = new Float32Array(N * 3), TIN = new Float32Array(N * 3), p = 0;
    for (li = 0; li < L.length; li++) {
      var l = L[li], g = G[li], tn = hexRgb(l.tint || CC.lime), st = l.stream;
      var lead = l.align === 'right' ? -g.w : l.align === 'center' ? -g.w / 2 : 0;
      var mode = ENTRY[l.entry] + 8 * (l.exit ? EXIT[l.exit] : 0);
      var sweep = st ? st.speed : l.sweep !== undefined ? l.sweep : l.entry === 'rain' ? 14 : l.entry === 'assemble' ? 8 : 0;
      var fr = st ? st.from : l.from || [l.x, l.y], to = st ? st.to : l.to || [l.x, l.y];
      for (i = 0; i < g.n; i++, p++) {
        A0[p * 4] = g.gx[i]; A0[p * 4 + 1] = g.gy[i]; A0[p * 4 + 2] = st ? 1 : g.ga[i]; A0[p * 4 + 3] = g.big[i];
        A1[p * 4] = h2(p * 1.618 + 0.3); A1[p * 4 + 1] = h2(p * 7.31 + 2.1);
        A1[p * 4 + 2] = st ? st.arc : g.w > 0 ? clamp01((g.gx[i] - l.x - lead) / g.w) : 0;
        A1[p * 4 + 3] = l.alpha === undefined ? 1 : l.alpha;
        A2[p * 4] = l.born; A2[p * 4 + 1] = l.die; A2[p * 4 + 2] = mode; A2[p * 4 + 3] = sweep;
        A3[p * 4] = fr[0]; A3[p * 4 + 1] = fr[1]; A3[p * 4 + 2] = to[0]; A3[p * 4 + 3] = to[1];
        COL[p * 3] = g.gc[i * 3]; COL[p * 3 + 1] = g.gc[i * 3 + 1]; COL[p * 3 + 2] = g.gc[i * 3 + 2];
        TIN[p * 3] = tn[0]; TIN[p * 3 + 1] = tn[1]; TIN[p * 3 + 2] = tn[2];
      }
    }
    return { n: N, a0: A0, a1: A1, a2: A2, a3: A3, aCol: COL, aTint: TIN };
  }

  /* ── GL helpers ─────────────────────────────────────────────────────────── */
  /* Compiling and linking are fire-and-forget; ASKING whether they finished is
     what blocks. Measured on the live page, the six compile-status checks alone
     held the main thread 618-673 ms (plus 67-86 ms of link checks) — and this
     script runs inside the parser, so the whole page waited on the GPU before it
     could paint. So: start the work in link(), let the driver compile in the
     background (KHR_parallel_shader_compile, polled once a frame without
     blocking), and only then query everything in program(). */
  function shader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  }
  function link(gl, vs, fs) {
    var v = shader(gl, gl.VERTEX_SHADER, vs), f = shader(gl, gl.FRAGMENT_SHADER, fs), p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    return { p: p, v: v, f: f };
  }
  function program(gl, pl) {
    var p = pl.p;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (window.console) console.warn('[terse-cosmos]', gl.getShaderInfoLog(pl.v) || gl.getShaderInfoLog(pl.f) || gl.getProgramInfoLog(p));
      return null;
    }
    var info = { p: p, u: {}, a: {} };
    var nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES), i;
    for (i = 0; i < nu; i++) { var un = gl.getActiveUniform(p, i).name; info.u[un] = gl.getUniformLocation(p, un); }
    for (i = 0; i < na; i++) { var an = gl.getActiveAttrib(p, i).name; info.a[an] = gl.getAttribLocation(p, an); }
    return info;
  }
  /* lib/mrwallpaper.tsx makeDotTexture — the exact radial ramp */
  function dotTexture(gl) {
    var cv = document.createElement('canvas'); cv.width = cv.height = 64;
    var ctx = cv.getContext('2d'), g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0.00, 'rgba(255,255,255,0.96)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function perspective(out, fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    return out;
  }
  /* camera on a sphere by yaw/pitch, looking at the origin (mrwallpaper.tsx orbit) */
  function orbitView(out, d, yawDeg, pitDeg) {
    var ya = yawDeg * Math.PI / 180, pa = pitDeg * Math.PI / 180;
    var ex = d * Math.sin(ya) * Math.cos(pa), ey = d * Math.sin(pa), ez = d * Math.cos(ya) * Math.cos(pa);
    var zx = ex, zy = ey, zz = ez, zl = Math.sqrt(zx * zx + zy * zy + zz * zz); zx /= zl; zy /= zl; zz /= zl;
    var xx = zz, xy = 0, xz = -zx, xl = Math.sqrt(xx * xx + xz * xz) || 1; xx /= xl; xz /= xl;   /* up × z */
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zx * ex + zy * ey + zz * ez);
    out[15] = 1;
    return out;
  }

  /* ── the moves: lib/flashcam.ts, laid end to end as one loop ─────────────
     A: the wallpaper act — flat, a hard push, the grab-and-swing, settle.
     B: the black-cut show — two big sweeps through zero, then push-ins.
     C: "drag to a new view" four times (alternating sides, 26…38°).
     D: glide home to flat and go again. */
  var A0 = 60, A_PUSH = A0 + 18, A_SWING = A_PUSH + 45, A_ORBIT = A_SWING + 72, A_SETTLE = A_ORBIT + 22, A_BACK = A_SETTLE + 38, A_END = A_BACK + 30;
  var NEAR = 0.70, REST = 0.92, YAW_PRE = 42, YAW_MAX = -42, PITCH_MAX = 16;
  var SHOW = [
    { at: 0, yaw: -16, pitch: 6, zoom: 0.88 }, { at: 40, yaw: -68, pitch: 14, zoom: 0.94 },
    { at: 80, yaw: 68, pitch: -12, zoom: 0.94 }, { at: 135, yaw: 24, pitch: 8, zoom: 0.74 },
    { at: 180, yaw: -34, pitch: -6, zoom: 0.72 }, { at: 225, yaw: 18, pitch: 10, zoom: 0.76 },
    { at: 270, yaw: -16, pitch: 6, zoom: 0.88 }
  ];
  var B0 = A_END, B_END = B0 + 270;
  var C0 = B_END, C_EACH = 90, C_N = 4, C_END = C0 + C_EACH * C_N;
  var D_END = C_END + 50, LOOP = D_END;
  function viewYaw(i) { var side = i % 2 === 0 ? -1 : 1; return side * (26 + ((i * 13) % 13)); }
  function viewPitch(i) { return 8 + ((i * 7) % 8); }

  /* Writes into `out` rather than returning a fresh object. This runs every
     frame, and per-frame garbage is exactly what makes the collector stop the
     page mid-animation. The arithmetic is the previous camAt's, expression for
     expression, so the pose — and every pixel — is unchanged. */
  function camAt(fr, out) {
    var f = fr % LOOP, t;
    if (f < A0) { out.yaw = 0; out.pitch = 0; out.zoom = 1; return out; }
    if (f < A_PUSH) { out.yaw = 0; out.pitch = 0; out.zoom = lerp(1, NEAR, outExpo(seg(f, A0, A_PUSH))); return out; }
    if (f < A_SWING) { t = outExpo(seg(f, A_PUSH, A_SWING)); out.yaw = YAW_PRE * t; out.pitch = -PITCH_MAX * 0.55 * t; out.zoom = NEAR; return out; }
    if (f < A_ORBIT) { t = smooth(seg(f, A_SWING, A_ORBIT)); out.yaw = lerp(YAW_PRE, YAW_MAX, t); out.pitch = lerp(-PITCH_MAX * 0.55, PITCH_MAX, t); out.zoom = NEAR; return out; }
    if (f < A_SETTLE) { t = settleE(seg(f, A_ORBIT, A_SETTLE)); out.yaw = lerp(YAW_MAX, YAW_MAX * 0.68, t); out.pitch = lerp(PITCH_MAX, PITCH_MAX * 0.68, t); out.zoom = NEAR; return out; }
    if (f < A_BACK) { t = smooth(seg(f, A_SETTLE, A_BACK)); out.yaw = lerp(YAW_MAX * 0.68, -16, t); out.pitch = lerp(PITCH_MAX * 0.68, 6, t); out.zoom = lerp(NEAR, 0.88, t); return out; }
    if (f < B0) { out.yaw = -16; out.pitch = 6; out.zoom = 0.88; return out; }
    if (f < B_END) {
      var k = f - B0, i = 0;
      while (i < SHOW.length - 2 && k >= SHOW[i + 1].at) i++;
      var a = SHOW[i], b = SHOW[i + 1];
      t = i < 2 ? outExpo(seg(k, a.at, b.at)) : smooth(seg(k, a.at, b.at));
      out.yaw = lerp(a.yaw, b.yaw, t); out.pitch = lerp(a.pitch, b.pitch, t); out.zoom = lerp(a.zoom, b.zoom, t); return out;
    }
    if (f < C_END) {
      var j = Math.floor((f - C0) / C_EACH), local = (f - C0) - j * C_EACH;
      var fy = j === 0 ? -16 : viewYaw(j - 1), fp = j === 0 ? 6 : viewPitch(j - 1);
      t = outExpo(seg(local, 0, 24));
      var energy = local < 24 ? Math.sin(Math.PI * seg(local, 0, 24)) : 0;
      out.yaw = lerp(fy, viewYaw(j), t); out.pitch = lerp(fp, viewPitch(j), t); out.zoom = REST - 0.06 * energy; return out;
    }
    t = smooth(seg(f, C_END, D_END));
    out.yaw = lerp(viewYaw(C_N - 1), 0, t); out.pitch = lerp(viewPitch(C_N - 1), 0, t); out.zoom = lerp(REST, 1, t); return out;
  }

  /* flashcam.ts pulse(): the volume SWELLS while the camera moves — alpha +10%,
     point size +55% at full energy. It ramps up across the push-and-orbit, eases
     off through the settle, and pops again on every drag. This is most of why
     the film's cloud reads dense and bright during the orbit (0:47–0:55) and
     thinner when the view holds still.
     One deliberate change: the film drops from 0.5 straight to 0 where its
     ease-back ends — a one-frame pop in point size. Here it eases down to 0. */
  function boostAt(fr) {
    var f = fr % LOOP;
    if (f >= A0 && f < A_BACK) {
      if (f < A_ORBIT) return smooth(seg(f, A0, A_ORBIT));
      if (f < A_SETTLE) return 1;
      return 1 - smooth(seg(f, A_SETTLE, A_BACK));
    }
    if (f >= B0 && f < B0 + 80) return Math.sin(Math.PI * clamp01((f - B0) / 80));   /* the two big sweeps */
    if (f >= C0 && f < C_END) {                                                       /* each drag */
      var local = (f - C0) % C_EACH;
      return local < 24 ? smooth(local / 24) : local < 48 ? 1 - smooth((local - 24) / 24) : 0;
    }
    return 0;
  }

  /* ── the hand (remotion-flash src/flash/hand.tsx, ported) ───────────────
     21 joints by forward kinematics — three bends per finger — so poses blend
     (open → pinch → fist) without fingers passing through each other. Palm
     coordinates: wrist at the origin, fingers up (−y), unit = palm length. */
  var H_FINGERS = [
    { b: [-0.30, -0.16], a: -58, l: [0.34, 0.30, 0.26] }, { b: [-0.22, -0.92], a: -9, l: [0.46, 0.27, 0.22] },
    { b: [-0.03, -0.98], a: -1, l: [0.50, 0.30, 0.23] }, { b: [0.16, -0.93], a: 8, l: [0.46, 0.28, 0.22] },
    { b: [0.33, -0.81], a: 18, l: [0.36, 0.22, 0.19] }
  ];
  var H_POSES = {
    open: [[0, 0.1, 0.1], [0.05, 0.08, 0.05], [0.04, 0.06, 0.04], [0.05, 0.08, 0.05], [0.08, 0.1, 0.06]],
    relax: [[0.2, 0.2, 0.15], [0.3, 0.4, 0.28], [0.28, 0.38, 0.26], [0.34, 0.44, 0.3], [0.4, 0.5, 0.34]],
    point: [[0.9, 0.5, 0.3], [0.02, 0.03, 0.02], [1.55, 1.7, 1.2], [1.55, 1.7, 1.2], [1.5, 1.6, 1.1]],
    fist: [[1.0, 0.6, 0.4], [1.55, 1.7, 1.2], [1.55, 1.7, 1.2], [1.55, 1.7, 1.2], [1.5, 1.6, 1.1]],
    pinch: [[0, 0, 0], [0.5, 0.6, 0.38], [0.36, 0.46, 0.3], [0.46, 0.56, 0.36], [0.52, 0.62, 0.4]]
  };
  function hSolve(pose) {
    var out = [[0, 0, 0]];
    for (var fi = 0; fi < 5; fi++) {
      var F = H_FINGERS[fi], bends = H_POSES[pose][fi], i0 = fi === 0 ? 1 : fi * 4 + 1;
      var x = F.b[0], y = F.b[1], z = 0, a0 = F.a * Math.PI / 180, acc = 0;
      out[i0] = [x, y, 0];
      for (var j = 0; j < 3; j++) {
        acc += bends[j];
        if (fi === 0) { var a = a0 + acc * 0.9; x += Math.sin(a) * F.l[j]; y += -Math.cos(a) * F.l[j]; }
        else { var along = Math.cos(acc) * F.l[j]; x += Math.sin(a0) * along; y += -Math.cos(a0) * along; z += Math.sin(acc) * F.l[j]; }
        out[i0 + j + 1] = [x, y, z];
      }
    }
    if (pose === 'pinch') {       /* the thumb tip meets the index tip, joints on an outward arc */
      var c = out[1], tip = out[8], T = [tip[0] - 0.02, tip[1] + 0.03, tip[2]];
      var nx = -(T[1] - c[1]), ny = T[0] - c[0], nl = Math.sqrt(nx * nx + ny * ny) || 1;
      var bulge = function (k, b) { return [c[0] + (T[0] - c[0]) * k - nx / nl * b, c[1] + (T[1] - c[1]) * k - ny / nl * b, T[2] * k]; };
      out[2] = bulge(0.38, 0.12); out[3] = bulge(0.72, 0.08); out[4] = T;
    }
    return out;
  }
  var H_SOLVED = { open: hSolve('open'), relax: hSolve('relax'), point: hSolve('point'), fist: hSolve('fist'), pinch: hSolve('pinch') };
  var H_BONES = [0, 1, 1, 2, 2, 3, 3, 4, 0, 5, 5, 6, 6, 7, 7, 8, 5, 9, 9, 10, 10, 11, 11, 12, 9, 13, 13, 14, 14, 15, 15, 16, 13, 17, 17, 18, 18, 19, 19, 20, 0, 17];
  /* the app's cursor-ring colours: pinch lime, open blue, fist amber, point white */
  var H_RGB = { pinch: [0.79, 0.94, 0.24], open: [0.50, 0.70, 1.0], fist: [1.0, 0.76, 0.29], point: [0.93, 0.95, 0.98], relax: [0.50, 0.70, 1.0] };

  /* 21 screen points for hand h into out (Float32Array 63): the cursor — the
     midpoint of thumb tip and index tip — lands exactly on (h.x, h.y). */
  function handPoints(h, out) {
    var A = H_SOLVED[h.a], B = H_SOLVED[h.b], t = h.t, i;
    var cx = (A[4][0] + (B[4][0] - A[4][0]) * t + A[8][0] + (B[8][0] - A[8][0]) * t) / 2;
    var cy = (A[4][1] + (B[4][1] - A[4][1]) * t + A[8][1] + (B[8][1] - A[8][1]) * t) / 2;
    var cr = Math.cos(h.roll), sr = Math.sin(h.roll);
    for (i = 0; i < 21; i++) {
      var lx = A[i][0] + (B[i][0] - A[i][0]) * t - cx, ly = A[i][1] + (B[i][1] - A[i][1]) * t - cy;
      out[i * 3] = h.x + (lx * cr - ly * sr) * h.s;
      out[i * 3 + 1] = h.y + (lx * sr + ly * cr) * h.s;
      out[i * 3 + 2] = A[i][2] + (B[i][2] - A[i][2]) * t;
    }
    return out;
  }

  /* Key track: each key holds until the next one; a key with mv > 0 is
     "flung into place" — outExpo over min(gap, 14) frames, then pinned (the
     film's track.ts feel). The pose blends on the same curve. Writes into h. */
  function handTrack(keys, f, h) {
    var k = 0;
    while (k < keys.length - 1 && f >= keys[k + 1].at) k++;
    /* A key means "be here AT its frame": hold the previous one, then fling in
       over the last min(gap, 14) frames — or glide across the whole gap. */
    var A = keys[k], B = keys[Math.min(keys.length - 1, k + 1)];
    var gap = Math.max(1, B.at - A.at), dur = Math.min(gap, 14), e;
    if (B === A) e = 0;
    else if (B.glide) e = smooth(clamp01((f - A.at) / gap));
    else e = 1 - Math.pow(2, -9 * clamp01((f - (B.at - dur)) / dur));
    if (B !== A && !B.glide && f < B.at - dur) e = 0;
    h.x = lerp(A.x, B.x, e); h.y = lerp(A.y, B.y, e);
    h.vis = lerp(A.vis === undefined ? 1 : A.vis, B.vis === undefined ? 1 : B.vis, e);
    h.roll = lerp(A.roll || 0, B.roll || 0, e);
    h.a = A.pose; h.b = B.pose; h.t = e;
    h.push = ((A.pose === 'open' ? 1 - e : 0) + (B.pose === 'open' ? e : 0)) * h.vis;
    h.pinch = ((A.pose === 'pinch' ? 1 - e : 0) + (B.pose === 'pinch' ? e : 0)) * h.vis;
    h.hole = lerp(A.hole || 0, B.hole || 0, e);
    h.label = (e < 0.5 ? A.label : B.label) || '';
    return h;
  }

  /* ── the console's script: the film's mini console, on this page's loop ──
     Panel pixels, 960×520, the film's layout (session-dock.js sizes: card column
     at 14 / 372 wide, preview from 422, 512 wide) and colours (session-dock.js
     DEF + K). Every line lives [born, die) on the loop's clock and leaves by its
     exit; at T_END everything weathers away and the loop builds it again. */
  var CON_W = 960, CON_H = 520, CX0 = 14, CW = 372, PVX = 422, PVW = 512;
  var CC = { title: '#FFFFFF', list: '#F4F6FA', sub: '#AEB5C2', user: '#DCE8FF', assistant: '#EEF1F6', tool: '#A8F5D0',
    lime: '#C9F03D', amber: '#FFC24B', blue: '#7FB2FF', add: '#7EE2A8', del: '#FF8E8E', t2: '#D6DBE4', white: '#FFFFFF',
    idle: '#5A606C', ink: '#101400', inkAmber: '#1a1300', glass: '#B9D4F0' };
  var CB = 16, T_BURST = 60, T_DIFF = 140, T_ALLOW = 212, T_OUT = 262, T_AWAY = 330, T_COMPACT = 400, T_END = 905;
  var V_S = 600, V_O = 624, V_R = 654;             /* grab → spin · open → freeze · let go → return */
  /* The console now replays an agent ROOM — the Cowork film (remotion-flash src/cowork,
     actRoom / actAgents / actE2E): three people, each with their own agent, splitting one
     evening's work. Left: the room, a file one agent wants to send (the hand pinches
     "Send"), a teammate's agent running the tests, the security code. Right: the chat.
     Names, tasks and file names are the film's demo cast, not real users.
     picked at bake time, not here: this script runs before i18n.js sets <html lang> */
  var S, S_ZH = {
    room: '今晚一起写 Terse', e2e: '端到端加密', you: 'James(你)', lin: 'Lin', mia: 'Mia',
    a: 'Mia 的 agent 要发一个文件', need: '等你点头', a2: 'rate-limiter.test.js · 已进隔离区',
    b: 'Lin 的 agent · 两边的测试', c: '安全码', done: '一致',
    sec: '每台设备上都一样 —— 没人在中间。', away: '读了 Mia 的 log · 给 James 发了交接',
    pause: '连续 8 条 agent 消息 · 已暂停,有人说话就继续', fail: '6 过 1 挂', pass: '✓ 7/7 通过',
    allow: '发到房间 ↵', deny: '不发', pvSub: '房间 K7QX29 · 3 个人 · 3 个 agent', stNeed: '● 有文件等你', stRun: '● 3 个 agent 在干活',
    u1: '@agents 首屏 + 限流今晚一起弄完,各认领一块',
    nJ: 'James 的 agent', nM: 'Mia 的 agent', nL: 'Lin 的 agent',
    a1: '认领首屏:改 landing/index.html,不碰 api/。', m1: '认领 api/rate-limiter.js:加 429 和 Retry-After。',
    l1: '两边的测试我来写,你们推上来我就跑。', l2: '6 过 1 挂:Retry-After 少了单位。', m2: '已修:改成秒,重推了。', l3: '7/7 通过。',
    h1: '👍 继续,把手机端也看一眼',
    hPoint: '指向左边缘 · 房间展开', hOpen: '张开手掌 · 推开粒子', hWatch: '看:agent 们自己分工', hAim: '对准「发到房间」',
    hPinch: '捏一下 = 同意发文件', hGrab: '握拳拧 · 变速', hFreeze: '张掌停住 · 定格', hLet: '松开 · 继续', hHole: '捏住拖 · 拖动视角'
  }, S_EN = {
    room: 'Tonight: build Terse together', e2e: 'End-to-end encrypted', you: 'James (you)', lin: 'Lin', mia: 'Mia',
    a: "Mia's agent wants to send a file", need: 'needs you', a2: 'rate-limiter.test.js · in quarantine',
    b: "Lin's agent · tests for both", c: 'Security code', done: 'matches',
    sec: 'The same on every device — nobody in the middle.', away: "Read Mia's log · posted a handoff to James",
    pause: 'Agents paused after 8 in a row · anyone speaking resumes them', fail: '6 passed · 1 failed', pass: '✓ 7/7 passed',
    allow: 'Send to room ↵', deny: "Don't send", pvSub: 'Room K7QX29 · 3 people · 3 agents', stNeed: '● a file is waiting', stRun: '● 3 agents working',
    u1: '@agents hero + rate limiter tonight — claim a piece each',
    nJ: "James's agent", nM: "Mia's agent", nL: "Lin's agent",
    a1: "I'll take landing/index.html — not touching api/.", m1: 'api/rate-limiter.js — adding 429 and Retry-After.',
    l1: "I'll write the tests for both and run what you push.", l2: '6 passed, 1 failed: Retry-After has no unit.', m2: 'Fixed — seconds now. Re-pushed.', l3: '7/7 passed.',
    h1: '👍 keep going, check mobile too',
    hPoint: 'Point at the edge · the room opens', hOpen: 'Open palm · push the particles', hWatch: 'Watch: the agents split the work',
    hAim: 'Aim at Send', hPinch: 'Pinch = send the file', hGrab: 'Fist + twist · change the speed', hFreeze: 'Hold an open palm · freeze',
    hLet: 'Let go · it plays on', hHole: 'Pinch & drag · pull the view'
  };

  /* The console's words come from the page's language mechanism (i18n.js, keys
     bg.cw.*, loaded with the language), so every language the switcher offers gets
     them; the film's English / Chinese are the fallback for a key not there yet.
     (New prefix on purpose: the old bg.* keys still hold the previous console's words.) */
  function pickS() {
    var I = window.i18n, lang = (I && I.lang) || document.documentElement.lang || 'en', o = {};
    var base = /^zh(-hans|-cn)?$/i.test(lang) ? S_ZH : S_EN;
    for (var k in S_EN) { var v = I && I.t ? I.t('bg.cw.' + k) : null; o[k] = v && v !== 'bg.cw.' + k ? v : base[k]; }
    return o;
  }
  function ext(a, b) { for (var k in b) if (b[k] !== undefined) a[k] = b[k]; return a; }
  function textW(t, px, weight, mono) {
    if (!PROBE) PROBE = mkCanvas(1, 1).getContext('2d');
    PROBE.font = fontOf({ px: px, weight: weight, mono: mono }, 1);
    return PROBE.measureText(t).width;
  }
  function conScript() {
    var L = [], A = 118, B = 324, C = 418, dotA = [CX0 + 19, A + 20], dotB = [CX0 + 19, B + 20], mem = [60, 84];
    var bead = function (i) { return [6, 154 + i * 22]; };
    var P = function (o) { if (o.die === undefined) { o.die = T_END; o.exit = 'dust'; } L.push(o); };
    var shell = function (y, h, st, title, meta, born, from, entry, die, exit) {
      var dot = st === 'need' ? CC.amber : st === 'done' ? CC.white : CC.lime;
      var b = { born: born, entry: entry || 'flow', from: from, die: die, exit: exit };
      P(ext({ rect: [CW, h, 13, 1], x: CX0, y: y, color: st === 'need' ? CC.amber : '#FFFFFF', alpha: st === 'need' ? 0.55 : 0.16 }, b));
      P(ext({ rect: [8, 8, 4], x: CX0 + 15, y: y + 16, color: dot }, b));
      P(ext({ text: title, x: CX0 + 32, y: y + 11, px: 13.5, weight: 650, color: CC.list }, b));
      P(ext({ text: meta, x: CX0 + CW - 13, y: y + 13, px: 11, weight: 600, color: st === 'need' ? CC.amber : CC.sub, align: 'right' }, b));
    };
    var band = function (y, k, born, die, exit, to) {           /* spend cap: >0.85 red, >0.65 amber */
      var w = CW - 26, col = k > 0.85 ? '#FF6B6B' : k > 0.65 ? CC.amber : CC.lime;
      P({ rect: [w, 3, 1.5], x: CX0 + 13, y: y, color: '#FFFFFF', alpha: 0.10, born: born, entry: 'fade', die: die, exit: exit, to: to });
      P({ rect: [Math.max(3, w * k), 3, 1.5], x: CX0 + 13, y: y, color: col, born: born + 2, entry: 'assemble', sweep: 10, die: die, exit: exit, to: to });
    };
    var mono = function (t, x, y, col, born, entry, o) { P(ext({ text: t, x: x, y: y, px: 12, weight: 700, mono: true, color: col, born: born, entry: entry }, o || {})); };

    /* glass: a bright front edge only — 100% transparent, as the film insists */
    P({ rect: [CON_W + 12, CON_H + 12, 20, 1], x: -6, y: -6, color: CC.glass, alpha: 0.55, born: CB, entry: 'fade' });
    /* the status-bead rail, before it bursts into the room */
    [CC.amber, CC.lime, CC.lime, CC.white, CC.idle].forEach(function (c, i) {
      P({ rect: [8, 8, 4], x: 2, y: 150 + i * 22, color: c, born: CB + 4 + i * 2, entry: 'fade', die: T_BURST + i * 4, exit: 'dust' });
    });
    /* header: the room, its lock, who is in it (each with an agent) */
    P({ text: S.room, x: 18, y: 16, px: 15, weight: 700, color: CC.title, born: T_BURST, entry: 'assemble', sweep: 6 });
    var ew = textW(S.e2e, 11, 700) + 22;
    P({ rect: [ew, 20, 10], x: 18, y: 44, color: CC.lime, alpha: 0.2, born: T_BURST + 4, entry: 'fade' });
    P({ rect: [ew, 20, 10, 1], x: 18, y: 44, color: CC.lime, alpha: 0.7, born: T_BURST + 4, entry: 'fade' });
    P({ text: S.e2e, x: 29, y: 47, px: 11, weight: 700, color: CC.lime, born: T_BURST + 5, entry: 'fade' });
    var mx = 18;
    [[S.you, 'Claude Code'], [S.lin, 'Claude Code'], [S.mia, 'Codex']].forEach(function (m, i) {
      var born = T_BURST + 8 + i * 3, lw = textW(m[0], 11.5, 700), aw = textW(m[1], 10.5, 600);
      P({ rect: [7, 7, 3.5], x: mx, y: 82, color: i === 2 ? CC.amber : CC.lime, born: born, entry: 'fade', die: i === 2 ? T_DIFF : undefined, exit: i === 2 ? 'dust' : undefined });
      if (i === 2) P({ rect: [7, 7, 3.5], x: mx, y: 82, color: CC.lime, born: T_DIFF + 2, entry: 'fade' });
      P({ text: m[0], x: mx + 12, y: 78, px: 11.5, weight: 700, color: CC.list, born: born, entry: 'rain' });
      P({ text: m[1], x: mx + 12, y: 94, px: 10.5, weight: 600, color: CC.sub, born: born + 1, entry: 'rain' });
      mx += Math.max(lw, aw) + 30;
    });

    /* card A — an agent wants to send a file: you see it before it lands */
    shell(A, 196, 'need', S.a, S.need, T_BURST, bead(0), 'flow', T_ALLOW + 4, 'dust');
    mono('File', CX0 + 24, A + 38, CC.amber, T_BURST + 6, 'flow', { from: bead(0), die: T_ALLOW, exit: 'absorb', to: dotA });
    mono('rate-limiter.test.js · 4.2 KB', CX0 + 64, A + 38, '#E9EDF5', T_BURST + 6, 'flow', { weight: 600, from: bead(0), die: T_ALLOW, exit: 'absorb', to: dotA });
    P({ rect: [CW - 26, 88, 9, 1], x: CX0 + 13, y: A + 60, color: '#FFFFFF', alpha: 0.14, born: T_BURST + 8, entry: 'fade', die: T_ALLOW + 2, exit: 'dust' });
    mono("+ test('429 when over the limit')", CX0 + 26, A + 70, CC.add, T_BURST + 8, 'flow', { weight: 600, tint: CC.add, from: bead(0), die: T_ALLOW + 1, exit: 'absorb', to: dotA, sweep: 10 });
    mono("+ test('Retry-After in seconds')", CX0 + 26, A + 92, CC.add, T_DIFF + 8, 'assemble', { weight: 600, tint: CC.add, sweep: 10, die: T_ALLOW + 2, exit: 'absorb', to: dotA });
    mono("+ test('resets after the window')", CX0 + 26, A + 114, CC.add, T_DIFF + 16, 'assemble', { weight: 600, tint: CC.add, sweep: 10, die: T_ALLOW + 3, exit: 'absorb', to: dotA });
    P({ rect: [120, 30, 9], x: CX0 + 13, y: A + 152, color: CC.lime, born: T_BURST + 12, entry: 'fade', die: T_ALLOW + 2, exit: 'dust' });
    P({ text: S.allow, x: CX0 + 73, y: A + 159, px: 12, weight: 700, color: CC.ink, align: 'center', born: T_BURST + 13, entry: 'fade', die: T_ALLOW + 2, exit: 'dust' });
    P({ rect: [96, 30, 9], x: CX0 + 143, y: A + 152, color: '#FFFFFF', alpha: 0.12, born: T_BURST + 12, entry: 'fade', die: T_ALLOW + 2, exit: 'dust' });
    P({ text: S.deny, x: CX0 + 191, y: A + 159, px: 12, weight: 700, color: CC.t2, align: 'center', born: T_BURST + 13, entry: 'fade', die: T_ALLOW + 2, exit: 'dust' });
    band(A + 186, 0.11, T_BURST + 10, T_ALLOW + 4, 'dust');
    /* sent: the file sits in quarantine, and the agents get to work on it — every beat a new step */
    shell(A, 196, 'work', S.a2, '0:04', T_ALLOW + 6, null, 'fade');
    [['Read', 'api/rate-limiter.js', T_ALLOW + 14, T_OUT], ['Bash', 'node --test', T_OUT, T_OUT + 60],
     ['Edit', 'api/rate-limiter.js', T_OUT + 60, T_COMPACT + 40], ['Bash', 'git push', T_COMPACT + 40, T_END]].forEach(function (s) {
      var o = s[3] < T_END ? { die: s[3], exit: 'absorb', to: dotA, sweep: 6 } : { sweep: 6 };
      mono(s[0], CX0 + 32, A + 38, CC.lime, s[2], 'rain', o);
      mono(s[1], CX0 + 32 + s[0].length * 7.4 + 8, A + 38, CC.t2, s[2] + 1, 'rain', ext({ weight: 600 }, ext({}, o, { sweep: 10 })));
    });
    mono(S.fail, CX0 + 15, A + 64, CC.del, T_OUT + 34, 'rain', { tint: CC.del, die: T_COMPACT + 60, exit: 'shatter' });
    mono(S.pass, CX0 + 15, A + 64, CC.add, T_COMPACT + 64, 'rain', { tint: CC.add });
    band(A + 186, 0.22, T_ALLOW + 8, T_COMPACT, 'absorb', [CX0 + 13, A + 187]);
    band(A + 186, 0.31, T_COMPACT + 20);
    P({ text: S.pause, x: CX0 + 15, y: A + 160, px: 11, weight: 600, color: CC.amber, born: T_COMPACT + 18, entry: 'rain', tint: CC.amber });
    P({ stream: { from: dotA, to: mem, n: 90, speed: 1.1, arc: -22 }, x: 0, y: 0, color: CC.lime, born: T_ALLOW + 10, entry: 'stream' });

    /* card B — a teammate's agent, running the tests and reading the others' logs */
    shell(B, 84, 'work', S.b, '2:41', T_BURST + 4, bead(1));
    mono('Bash', CX0 + 32, B + 38, CC.lime, T_BURST + 10, 'flow', { from: bead(1) });
    mono('node --test landing api', CX0 + 72, B + 38, CC.t2, T_BURST + 10, 'flow', { weight: 600, from: bead(1) });
    P({ text: S.away, x: CX0 + 15, y: B + 58, px: 11.5, weight: 600, color: CC.lime, born: T_AWAY, entry: 'rain' });
    band(B + 76, 0.47, T_BURST + 12);
    P({ stream: { from: dotB, to: [150, 84], n: 70, speed: 0.9, arc: 26 }, x: 0, y: 0, color: CC.lime, born: T_BURST + 20, entry: 'stream' });

    /* card C — the private room's security code */
    shell(C, 84, 'done', S.c, S.done, T_BURST + 8, bead(3));
    P({ text: '4827 1906 3355 7042', x: CX0 + 15, y: C + 32, px: 16, weight: 800, mono: true, color: CC.lime, born: T_BURST + 14, entry: 'assemble', sweep: 8, tint: CC.lime });
    P({ text: S.sec, x: CX0 + 15, y: C + 56, px: 11.5, weight: 500, color: CC.t2, born: T_BURST + 15, entry: 'flow', from: bead(3) });

    /* the right side: the room's conversation */
    P({ text: S.room, x: PVX, y: 18, px: 16, weight: 700, color: CC.title, born: T_BURST + 20, entry: 'flow', from: dotA });
    P({ text: S.pvSub, x: PVX, y: 42, px: 11.5, weight: 600, color: CC.sub, born: T_BURST + 21, entry: 'flow', from: dotA });
    P({ text: S.stNeed, x: PVX + PVW, y: 42, px: 11.5, weight: 600, color: CC.amber, align: 'right', born: T_BURST + 22, entry: 'flow', from: dotA, die: T_ALLOW + 4, exit: 'absorb', to: dotA });
    P({ text: S.stRun, x: PVX + PVW, y: 42, px: 11.5, weight: 600, color: CC.lime, align: 'right', born: T_ALLOW + 12, entry: 'rain' });
    var bw = PVW * 0.86, bx = PVX + PVW - bw;
    P({ text: 'Lin', x: bx, y: 66, px: 11, weight: 700, color: CC.sub, born: T_BURST + 26, entry: 'fade' });
    P({ rect: [bw, 34, 13], x: bx, y: 82, color: '#284682', alpha: 0.42, born: T_BURST + 26, entry: 'fade' });
    P({ rect: [bw, 34, 13, 1], x: bx, y: 82, color: CC.blue, alpha: 0.38, born: T_BURST + 26, entry: 'fade' });
    P({ text: S.u1, x: bx + 13, y: 91, px: 13, weight: 600, color: CC.user, born: T_BURST + 27, entry: 'rain', sweep: 12 });
    [[S.nJ, S.a1, T_BURST + 40, 134, CC.assistant], [S.nM, S.m1, T_BURST + 56, 160, CC.assistant], [S.nL, S.l1, T_DIFF, 186, CC.assistant],
     [S.nL, S.l2, T_OUT + 34, 212, CC.del], [S.nM, S.m2, T_OUT + 70, 238, CC.assistant], [S.nL, S.l3, T_COMPACT + 64, 264, CC.add]].forEach(function (s) {
      var nw = textW(s[0], 12, 700, true);
      P({ text: s[0], x: PVX, y: s[3], px: 12, weight: 700, mono: true, color: CC.tool, born: s[2], entry: 'rain', sweep: 6 });
      P({ text: s[1], x: PVX + nw + 10, y: s[3], px: 12.5, weight: 550, color: s[4], born: s[2] + 1, entry: 'rain', sweep: 12, tint: s[4] });
    });
    P({ text: S.pause, x: PVX, y: 292, px: 11.5, weight: 600, color: CC.amber, born: T_COMPACT + 80, entry: 'rain', tint: CC.amber });
    P({ text: 'Lin', x: PVX, y: 318, px: 11, weight: 700, color: CC.sub, born: T_COMPACT + 130, entry: 'fade' });
    P({ text: S.h1, x: PVX + 30, y: 317, px: 13, weight: 600, color: CC.user, born: T_COMPACT + 131, entry: 'rain', sweep: 12 });
    return L;
  }

  /* The hand's keys. sx/sy = fraction of the viewport; px/py = a point on the
     console panel, projected every frame (so "aim at Allow" follows the panel
     through the orbit). s = palm length as a fraction of the viewport height. */
  function handKeys() {
    var A = 118, bx = CX0 + 73, by = A + 167;
    return [
      { at: 0, sx: 0.96, sy: 1.18, pose: 'relax', vis: 0 },
      { at: 34, sx: 0.80, sy: 0.82, pose: 'open', label: S.hOpen },
      { at: 50, px: 22, py: 196, pose: 'point', label: S.hPoint },
      { at: 60, px: 6, py: 190, pose: 'point', label: S.hPoint },
      { at: 98, px: 190, py: 150, pose: 'open', label: S.hOpen },
      { at: 132, px: 270, py: 250, pose: 'relax', label: S.hWatch },
      { at: 188, px: bx + 30, py: by + 30, pose: 'point', label: S.hAim },
      { at: 202, px: bx, py: by, pose: 'point', label: S.hAim },
      { at: T_ALLOW, px: bx, py: by, pose: 'pinch', label: S.hPinch },
      { at: T_ALLOW + 14, px: bx + 20, py: by + 10, pose: 'open', label: S.hPinch },
      { at: 250, sx: 0.44, sy: 0.64, pose: 'open', label: S.hOpen },
      { at: 330, sx: 0.16, sy: 0.46, pose: 'open', label: S.hOpen, glide: 1 },
      { at: 420, sx: 0.30, sy: 0.70, pose: 'open', label: S.hOpen, glide: 1 },
      { at: V_S - 20, sx: 0.62, sy: 0.60, pose: 'open', label: S.hOpen, glide: 1 },
      { at: V_S, sx: 0.62, sy: 0.60, pose: 'fist', label: S.hGrab },
      { at: V_O, sx: 0.62, sy: 0.60, pose: 'open', label: S.hFreeze },
      { at: V_R, sx: 0.62, sy: 0.60, pose: 'relax', label: S.hLet },
      { at: 700, sx: 0.24, sy: 0.64, pose: 'pinch', label: S.hHole, hole: 0.6 },
      { at: 780, sx: 0.46, sy: 0.40, pose: 'pinch', label: S.hHole, hole: 0.6, glide: 1 },
      { at: 800, sx: 0.46, sy: 0.40, pose: 'open', label: S.hOpen },
      { at: 880, sx: 0.62, sy: 1.18, pose: 'relax', vis: 0, glide: 1 },
      { at: LOOP, sx: 0.96, sy: 1.18, pose: 'relax', vis: 0 }
    ];
  }

  /* The film's vortex event (hand.tsx vortexAt / vortexClocks), on the loop.
     Spinning runs every clock ×2.25, the freeze holds it at ×0 — the 30 frames
     gained are exactly the 30 frozen, so after it the clock is the loop frame
     again and nothing downstream drifts. Integrated once, up front. */
  var VORTEX_W = 0.30, VCL = new Float32Array(LOOP + 1), VANG = new Float32Array(LOOP + 1);
  function smooth01(t) { var x = clamp01(t); return x * x * (3 - 2 * x); }
  function vortexAt(f, out) {
    out.K = 0; out.w = 0; out.ring = -1;
    if (f >= V_S && f < V_O) { out.K = smooth01((f - V_S) / 10); out.w = VORTEX_W * smooth01((f - V_S) / 16); }
    else if (f >= V_O && f < V_R) { out.K = 1; if (f - V_O < 16) out.ring = (f - V_O) / 16; }
    else if (f >= V_R && f < V_R + 24) out.K = 1 - smooth01((f - V_R) / 24);
    return out;
  }
  (function () {
    var v = { K: 0, w: 0, ring: -1 };
    for (var i = 1; i <= LOOP; i++) {
      var r = i - 1 >= V_S && i - 1 < V_O ? 2.25 : i - 1 >= V_O && i - 1 < V_R ? 0 : 1;
      VCL[i] = VCL[i - 1] + r; VANG[i] = VANG[i - 1] + vortexAt(i - 1, v).w;
    }
  })();
  function tab(T, f) { var n = Math.floor(f); if (n >= LOOP) return T[LOOP]; return T[n] + (T[n + 1] - T[n]) * (f - n); }

  /* ── the stage ──────────────────────────────────────────────────────────── */
  /* done(stage) is called once the shaders are linked — on the same call when the
     driver has no parallel compile, a few frames later when it does. */
  function Cosmos(canvas, done) {
    this.cv = canvas;
    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false,
                                          premultipliedAlpha: false, powerPreference: 'high-performance' })
          || canvas.getContext('experimental-webgl');
    if (!gl) { this.ok = false; done(this); return; }
    this.gl = gl;
    var self = this, par = gl.getExtension('KHR_parallel_shader_compile');
    var pend = [link(gl, PULSE_VS, PULSE_FS), link(gl, PULSE_VS, PULSE_BLOOM_FS), link(gl, GLYPH_VS, GLYPH_FS)];
    if (FEAT) pend.push(link(gl, CON_VS, CON_FS), link(gl, SPR_VS, SPR_FS));
    var check = function () {
      if (par && !gl.isContextLost()) for (var i = 0; i < pend.length; i++) {
        if (!gl.getProgramParameter(pend[i].p, par.COMPLETION_STATUS_KHR)) { window.requestAnimationFrame(check); return; }
      }
      self._init(pend, done);
    };
    check();
  }

  Cosmos.prototype._init = function (pend, done) {
    var gl = this.gl;
    this.pBody = program(gl, pend[0]);
    this.pBloom = program(gl, pend[1]);
    this.pGlyph = program(gl, pend[2]);
    if (!this.pBody || !this.pBloom || !this.pGlyph) { this.ok = false; done(this); return; }
    this.ok = true;
    /* the console and the hand are extras: if either fails to link, the stage runs as before */
    this.pCon = pend[3] ? program(gl, pend[3]) : null;
    this.pSpr = pend[4] ? program(gl, pend[4]) : null;
    this.hand = { x: 0, y: 0, roll: 0, vis: 0, a: 'relax', b: 'relax', t: 0, push: 0, pinch: 0, hole: 0, label: '',
                  vortex: 0, vang: 0, ring: -1, cx: 0, cy: 0 };
    this.hdraw = { x: 0, y: 0, s: 1, roll: 0, a: 'relax', b: 'relax', t: 0 };
    this.vx = { K: 0, w: 0, ring: -1 }; this.hp = [0, 0]; this.hc = [0, 0]; this.hpts = new Float32Array(63);
    this.cview = new Float32Array(16); this.cproj = new Float32Array(16); this.conVis = 0;
    if (this.pSpr) {
      this.spr = new Float32Array(SPR_MAX * 7); this.bSpr = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bSpr); gl.bufferData(gl.ARRAY_BUFFER, this.spr.byteLength, gl.DYNAMIC_DRAW);
    }
    if (this.pCon && this.pSpr) this._conBake();
    this.maxPt = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 64])[1];
    this.dot = dotTexture(gl);
    this.cover = gl.createTexture(); this.hasCover = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.cover);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.view = new Float32Array(16); this.proj = new Float32Array(16);
    this.t0 = 0; this.frame = 0; this.par = { x: 0, y: 0, tx: 0, ty: 0 };
    this.labels = {};
    /* per-frame state lives here and is overwritten in place — see camAt */
    this.cam = { yaw: 0, pitch: 0, zoom: 1 };
    this.pose = { yaw: 0, pitch: 0, zoom: 1, boost: 0 };
    this.dr = { t: 0, bass: 0, mid: 0, treble: 0, beat: 0, energy: 0, burst: 0 };
    this._pool = []; this._alv = [];
    this.passes = [[this.pBloom, BLOOM_SIZE, 'add'], [this.pBody, 1, 'normal']];
    this._glyphGeo();
    this._prewarm();
    this.resize();
    this._loadCover();
    done(this);
  };

  Cosmos.prototype._loadCover = function () {
    var self = this, img = new Image();
    img.onload = function () {
      var gl = self.gl;
      gl.bindTexture(gl.TEXTURE_2D, self.cover);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);          /* aUv.y runs up, an image's y runs down */
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      self.hasCover = 1;
    };
    img.src = '/cosmos-src.jpg';
  };

  /* The PULSE grid only supplies aUv/aRand — every position is computed in the
     shader — so the grid's job is density. Portrait gets at least a square grid,
     or a phone would draw a sparse fraction of the same volume. */
  Cosmos.prototype._pulseGeo = function () {
    var gl = this.gl, gy = PULSE_GRID_Y, gx = Math.max(Math.round(gy * this.aspect), gy);
    if (this.pulseN === gx * gy) return;
    var n = gx * gy, uv = new Float32Array(n * 2), rnd = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i % gx, y = (i / gx) | 0;
      uv[i * 2] = (x + 0.5) / gx; uv[i * 2 + 1] = (y + 0.5) / gy;
      rnd[i] = h1(i * 1.618 + 0.37);
    }
    if (!this.bPulseUv) { this.bPulseUv = gl.createBuffer(); this.bPulseRnd = gl.createBuffer(); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPulseUv); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPulseRnd); gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);
    this.pulseN = n;
  };

  /* Each glyph particle keeps a fixed random uv for life and asks the mask "am I
     on a stroke?" — the app's model, and why its letters carry no grid. */
  Cosmos.prototype._glyphGeo = function () {
    var gl = this.gl, n = GLYPH_N, uv = new Float32Array(n * 2), rnd = new Float32Array(n);
    for (var i = 0; i < n; i++) { uv[i * 2] = h1(i * 0.7071 + 1.3); uv[i * 2 + 1] = h1(i * 1.3137 + 7.9); rnd[i] = h1(i * 2.2361 + 4.1); }
    this.glyphUv = uv; this.glyphRnd = rnd;
    this.atlas = document.createElement('canvas'); this.atlas.width = 1024; this.atlas.height = 128;
    this.actx = this.atlas.getContext('2d', { willReadFrequently: true });
  };

  /* One mask per LABEL, kept: the same dozen lines recur for as long as the page
     is open. A label is now stored as ONLY its lit particles, in their original
     order. Every line used to draw all 60000 points in both passes, and the ones
     off the strokes (most of them) ran the fragment shader to add exactly zero —
     alpha 0 under an additive blend is a bit-for-bit no-op. Drawing just the lit
     ones, in the same order, gives the same framebuffer for a fraction of the
     fill. That matters most on Windows, where ANGLE emulates sized points. */
  Cosmos.prototype._mask = function (text) {
    var hit = this.labels[text];
    if (hit) return hit;
    var o = this.actx, W = 1024, H = 128;
    o.clearRect(0, 0, W, H); o.fillStyle = '#fff'; o.textAlign = 'center'; o.textBaseline = 'middle';
    var FONT = "'JetBrains Mono','SF Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Segoe UI Mono',monospace";
    var size = 78;
    for (; size > 28; size -= 2) { o.font = '800 ' + size + 'px ' + FONT; if (o.measureText(text).width < W * 0.92) break; }
    o.font = '800 ' + size + 'px ' + FONT;
    o.fillText(text, W / 2, H / 2);
    var d = o.getImageData(0, 0, W, H).data, uv = this.glyphUv, rn = this.glyphRnd, idx = [];
    for (var i = 0; i < GLYPH_N; i++) {
      var ux = Math.min(0.998, Math.max(0.002, uv[i * 2])), uy = Math.min(0.94, Math.max(0.06, uv[i * 2 + 1]));
      var x = Math.min(W - 1, (ux * W) | 0), y = Math.min(H - 1, ((1 - uy) * H) | 0);
      if (d[(y * W + x) * 4 + 3] > 115) idx.push(i);
    }
    var n = idx.length, cu = new Float32Array(n * 2), cr = new Float32Array(n);
    for (var j = 0; j < n; j++) { var q = idx[j]; cu[j * 2] = uv[q * 2]; cu[j * 2 + 1] = uv[q * 2 + 1]; cr[j] = rn[q]; }
    var gl = this.gl, bu = gl.createBuffer(), br = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bu); gl.bufferData(gl.ARRAY_BUFFER, cu, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, br); gl.bufferData(gl.ARRAY_BUFFER, cr, gl.STATIC_DRAW);
    return (this.labels[text] = { uv: bu, rnd: br, n: n });
  };

  /* Build every label's mask during idle time, up front. Built on first use, a
     mask (a canvas raster plus 60000 lookups) landed on the very frame its line
     appeared — a hitch at each new line through the whole first loop. Waits for
     document.fonts so no mask is ever baked in a fallback face; _mask still
     builds synchronously for anything the pre-build has not reached yet. */
  Cosmos.prototype._prewarm = function () {
    var self = this, todo = [], seen = {}, i;
    for (i = 0; i < LINES.length; i++) if (!seen[LINES[i][1]]) { seen[LINES[i][1]] = 1; todo.push(LINES[i][1]); }
    for (i = 0; i < CYCLE.length; i++) if (!seen[CYCLE[i][1]]) { seen[CYCLE[i][1]] = 1; todo.push(CYCLE[i][1]); }
    this._prewarmLeft = todo.length;
    var ric = window.requestIdleCallback ? function (fn) { window.requestIdleCallback(fn, { timeout: 400 }); }
                                          : function (fn) { setTimeout(function () { fn(null); }, 16); };
    var step = function (dl) {
      do { var tx = todo.shift(); if (tx) self._mask(tx); } while (todo.length && dl && dl.timeRemaining() > 6);
      self._prewarmLeft = todo.length;
      if (todo.length) ric(step);
    };
    var go = function () { ric(step); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go); else go();
  };

  Cosmos.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, window.innerWidth || 1280), h = Math.max(1, window.innerHeight || 720);
    this.w = w; this.h = h; this.aspect = w / h;
    var W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    /* the video is 1080 tall; every point size was tuned there */
    this.pixel = H / 1080;
    this._panel();
    this._pulseGeo();
  };

  /* token rhythm: hero-line and stat arrivals are the pulses, plus a burst every 50 */
  Cosmos.prototype._drive = function (gf) {
    var t = gf / FPS, beat = 0, big = 0, lo = gf - RIPPLE_LIFE * FPS, k, f, a;
    for (k = Math.max(0, Math.floor((lo - HERO_FROM) / HERO_EVERY)); (f = HERO_FROM + k * HERO_EVERY) <= gf; k++) {
      if (f > lo) { beat += env(t - f / FPS) + env(t - (f + 3) / FPS); }
    }
    for (k = Math.max(0, Math.floor((lo - SMALL_FROM) / SMALL_EVERY)); (f = SMALL_FROM + k * SMALL_EVERY) <= gf; k++) {
      if (f > lo) beat += env(t - f / FPS);
    }
    for (k = Math.max(0, Math.ceil(lo / BURST_EVERY)); (f = k * BURST_EVERY) <= gf; k++) {
      if (f > lo) { a = env(t - f / FPS); beat += a * BURST_GAIN * 0.55; if (a > big) big = a; }
    }
    beat = Math.min(2.2, beat);
    var act = clamp01(ACTIVITY + SWELL * Math.sin((t / SWELL_SEC) * Math.PI * 2));
    var o = this.dr;
    o.t = t;
    o.bass = Math.min(1.6, 0.14 + act * 0.30 + beat * 0.42);
    o.mid = Math.min(1.4, 0.12 + act * 0.26 + 0.04 * Math.sin(t * 0.55) + beat * 0.30);
    o.treble = Math.min(1.0, 0.05 + act * 0.10 + beat * 0.20);
    o.beat = Math.min(1.2, beat * 0.55);
    o.energy = clamp01(0.12 + act * 0.34 + beat * 0.50);
    o.burst = clamp01(big);
    return o;
  };

  function glyphAt(age, g) {
    if (age < 0 || age > G_LIFE) return false;
    if (age < G_IN) { var u = age / G_IN; g.form = smoother(u); g.vis = smoother(Math.min(1, u * 1.6)); g.out = 0; return true; }
    if (age < G_IN + G_HOLD) { g.form = 1; g.vis = 1; g.out = 0; return true; }
    var v = (age - G_IN - G_HOLD) / G_OUT;
    g.form = 1 - smoother(v) * 0.75; g.vis = 1 - smoother(v); g.out = 1; return true;
  }
  function bySc(a, b) { return a.sc - b.sc; }

  Cosmos.prototype._ev = function (n) {
    return this._pool[n] || (this._pool[n] = { text: '', kind: '', x: 0, y: 0, sc: 0, mode: 0, g: { form: 0, vis: 0, out: 0 } });
  };

  /* everything alive at frame gf: hero lines (centred, big) and small stats (sides).
     Pooled records, one reused array — same values, same order, no garbage. */
  Cosmos.prototype._alive = function (gf) {
    var out = this._alv, n = 0, k, f, e, halfW = SILK_HALF_H * this.aspect;
    out.length = 0;
    /* the hero line is 3.05 × 1.55 = 4.7 units wide; a phone's frame is ~2.2 */
    var heroSc = Math.min(HERO_SCALE, (halfW * 2 * 0.94) / GLYPH_W);
    var xFit = Math.min(1, this.aspect / (16 / 9));
    for (k = Math.max(0, Math.floor((gf - G_LIFE - HERO_FROM) / HERO_EVERY)); (f = HERO_FROM + k * HERO_EVERY) <= gf; k++) {
      e = this._ev(n);
      if (glyphAt(gf - f, e.g)) {
        var L = LINES[k % LINES.length];
        e.text = L[1]; e.kind = L[0]; e.x = 0; e.y = 0.35; e.sc = heroSc; e.mode = (k * 5) % 5 === 0 ? 0 : (k % 4);
        out.push(e); n++;
      }
    }
    for (k = Math.max(0, Math.floor((gf - G_LIFE - SMALL_FROM) / SMALL_EVERY)); (f = SMALL_FROM + k * SMALL_EVERY) <= gf; k++) {
      e = this._ev(n);
      if (glyphAt(gf - f, e.g)) {
        var C = CYCLE[k % CYCLE.length], side = k % 2 === 0 ? -1 : 1;
        var x = side * (1.95 + ((k * 0.37) % 1) * 1.60) + (((k * 0.83) % 1) - 0.5) * 0.5;
        var y = (((k * 0.41) % 1) - 0.5) * 4.2;
        /* On a phone a 0.58 label is wider than half the frame, and the desktop
           side offsets only scale by aspect — "−38% filler" ran off the left edge
           and read as "filler". Cap a small label at ~62% of the frame width and
           keep its whole box inside the frame. Desktop is unchanged: the cap is
           2.8 there and the clamp never binds. */
        var ssc = Math.min(SMALL_SCALE, (halfW * 2 * 0.62) / GLYPH_W);
        var lim = Math.max(0, halfW - GLYPH_W * ssc * 0.5 - 0.04);
        e.text = C[1]; e.kind = C[0]; e.x = Math.max(-lim, Math.min(lim, x * xFit)); e.y = y; e.sc = ssc; e.mode = 0;
        out.push(e); n++;
      }
    }
    /* small ones first, the hero line last — it sits on top */
    return out.sort(bySc);
  };

  Cosmos.prototype.draw = function (gf) {
    /* the loop frame drives the camera; the VIRTUAL frame (the grab's ×2.25 then
       freeze) drives the field, the text and the console — so "open = freeze"
       stops everything but the camera, as in the film */
    var gl = this.gl, lf = gf % LOOP, vlf = tab(VCL, lf), vgf = gf - lf + vlf, dr = this._drive(vgf);
    if (this.con) this.conVis = clamp01((performance.now() - this.con.at) / 900);
    var cam = camAt(gf, this.cam), p = this.par;
    p.x += (p.tx - p.x) * 0.06; p.y += (p.ty - p.y) * 0.06;
    var yaw = cam.yaw + p.x * 10, pitch = cam.pitch - p.y * 6, zoom = cam.zoom;
    var boost = boostAt(gf);
    var pAlpha = Math.min(1, PULSE_ALPHA * (1 + 0.10 * boost)), pScale = PULSE_POINT * (1 + 0.55 * boost);
    var ps = this.pose; ps.yaw = yaw; ps.pitch = pitch; ps.zoom = zoom; ps.boost = boost;
    var H = this._handFrame(lf, yaw, pitch, zoom);

    gl.viewport(0, 0, this.cv.width, this.cv.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    /* ── PULSE: bloom twin first (renderOrder 0), then the body (1) ── */
    perspective(this.proj, 2 * Math.atan(PULSE_HALF_H / PULSE_CAM_Z), this.aspect, 0.1, 400);
    orbitView(this.view, PULSE_CAM_Z * zoom, yaw, pitch);
    var passes = this.passes;
    for (var pi = 0; pi < 2; pi++) {
      var P = passes[pi][0];
      gl.useProgram(P.p);
      if (passes[pi][2] === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(P.u.uView, false, this.view);
      gl.uniformMatrix4fv(P.u.uProj, false, this.proj);
      gl.uniform1f(P.u.uTime, dr.t);
      gl.uniform1f(P.u.uBass, dr.bass); gl.uniform1f(P.u.uMid, dr.mid); gl.uniform1f(P.u.uTreble, dr.treble);
      gl.uniform1f(P.u.uBeat, dr.beat); gl.uniform1f(P.u.uEnergy, dr.energy); gl.uniform1f(P.u.uBurstAmt, dr.burst);
      gl.uniform1f(P.u.uPixel, this.pixel); gl.uniform1f(P.u.uPointScale, pScale);
      gl.uniform1f(P.u.uBloomSize, passes[pi][1]); gl.uniform1f(P.u.uMaxPt, this.maxPt);
      gl.uniform1f(P.u.uColorBoost, COLOR_BOOST); gl.uniform1f(P.u.uHasCover, this.hasCover);
      gl.uniform1f(P.u.uAlpha, pAlpha);
      gl.uniform2f(P.u.uHandXY, this.hp[0], this.hp[1]);
      gl.uniform1f(P.u.uHandActive, H.push * H.vis); gl.uniform1f(P.u.uHandRad, HAND_RAD);
      gl.uniform1f(P.u.uVortexK, H.vortex); gl.uniform1f(P.u.uVortexAng, H.vang); gl.uniform1f(P.u.uHole, H.hole * H.vis);
      if (P.u.uBloomStrength) gl.uniform1f(P.u.uBloomStrength, BLOOM_STRENGTH);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dot); gl.uniform1i(P.u.uDotTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.cover); gl.uniform1i(P.u.uCoverTex, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bPulseUv); gl.enableVertexAttribArray(P.a.aUv); gl.vertexAttribPointer(P.a.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bPulseRnd); gl.enableVertexAttribArray(P.a.aRand); gl.vertexAttribPointer(P.a.aRand, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.pulseN);
      gl.disableVertexAttribArray(P.a.aUv); gl.disableVertexAttribArray(P.a.aRand);
    }

    /* ── text: same orbit, the text plane's own camera, both passes additive ── */
    perspective(this.proj, 2 * Math.atan(SILK_HALF_H / SILK_CAM_Z), this.aspect, 0.1, 400);
    orbitView(this.view, SILK_CAM_Z * zoom, yaw, pitch);
    var G = this.pGlyph, alive = this._alive(vgf);
    gl.useProgram(G.p);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.uniformMatrix4fv(G.u.uView, false, this.view);
    gl.uniformMatrix4fv(G.u.uProj, false, this.proj);
    gl.uniform1f(G.u.uTime, dr.t); gl.uniform1f(G.u.uPixel, this.pixel); gl.uniform1f(G.u.uMaxPt, this.maxPt);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dot); gl.uniform1i(G.u.uDotTex, 0);
    gl.enableVertexAttribArray(G.a.aUv); gl.enableVertexAttribArray(G.a.aRand);
    for (var i = 0; i < alive.length; i++) {
      var e = alive[i], m = this._mask(e.text);
      if (!m.n) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.uv); gl.vertexAttribPointer(G.a.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.rnd); gl.vertexAttribPointer(G.a.aRand, 1, gl.FLOAT, false, 0, 0);
      var tint = TINT_RGB[e.kind] || WHITE_RGB;
      gl.uniform2f(G.u.uCenter, e.x, e.y);
      gl.uniform2f(G.u.uSize, GLYPH_W * e.sc, GLYPH_H * e.sc);
      gl.uniform3f(G.u.uTint, tint[0], tint[1], tint[2]);
      gl.uniform1f(G.u.uForm, e.g.form); gl.uniform1f(G.u.uVis, e.g.vis); gl.uniform1f(G.u.uOut, e.g.out);
      gl.uniform1f(G.u.uInMode, e.mode); gl.uniform1f(G.u.uOutMode, (e.mode + 2) % 5);
      /* glow twin (2.4x, soft core, 0.55 of the alpha), then the sharp pass */
      gl.uniform1f(G.u.uBloomSize, 2.4); gl.uniform1f(G.u.uSoft, 1); gl.uniform1f(G.u.uAlpha, GLYPH_ALPHA * 0.55);
      gl.drawArrays(gl.POINTS, 0, m.n);
      gl.uniform1f(G.u.uBloomSize, 1); gl.uniform1f(G.u.uSoft, 0); gl.uniform1f(G.u.uAlpha, GLYPH_ALPHA);
      gl.drawArrays(gl.POINTS, 0, m.n);
    }
    gl.disableVertexAttribArray(G.a.aUv); gl.disableVertexAttribArray(G.a.aRand);
    this.lastAlive = alive.length;
    this._drawOverlay(lf, vlf);
  };

  /* ── console + hand, per frame ─────────────────────────────────────────
     Wide screens only (a 960×520 panel is unreadable on a phone) and never under
     reduced motion. */
  var FEAT = !REDUCE && (window.innerWidth || 0) >= 900;
  var CON_DAMP = 0.35;     /* the panel follows the orbit at 35% — it moves with the stage and stays readable */
  var HAND_RAD = 5.2;      /* the film: the PULSE volume needs ~5.2× the radius before a hole reads */
  var SPR_MAX = 1400, CON_ATTR = ['a0', 'a1', 'a2', 'a3', 'aCol', 'aTint'], TIPS = { 4: 1, 8: 1, 12: 1, 16: 1, 20: 1 };

  /* screen fraction (sx, sy) → the point on the world z = 0 plane under it, for an
     orbit camera (orbitView's basis; up × z has no y component) */
  function rayZ0(yaw, pitch, d, halfH, camZ, aspect, sx, sy, out) {
    var ya = yaw * Math.PI / 180, pa = pitch * Math.PI / 180;
    var ex = d * Math.sin(ya) * Math.cos(pa), ey = d * Math.sin(pa), ez = d * Math.cos(ya) * Math.cos(pa);
    var zl = Math.sqrt(ex * ex + ey * ey + ez * ez), zx = ex / zl, zy = ey / zl, zz = ez / zl;
    var xl = Math.sqrt(zz * zz + zx * zx) || 1, xx = zz / xl, xz = -zx / xl;
    var yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
    var th = halfH / camZ, nx = sx * 2 - 1, ny = 1 - sy * 2;
    var dx = -zx + xx * nx * th * aspect + yx * ny * th, dy = -zy + yy * ny * th, dz = -zz + xz * nx * th * aspect + yz * ny * th;
    var t = Math.abs(dz) > 1e-6 ? -ez / dz : 0;
    out[0] = ex + dx * t; out[1] = ey + dy * t;
    return out;
  }
  /* world point on z = 0 → screen fraction (our perspective: w = −z_view) */
  function toScreen(view, proj, wx, wy, out) {
    var vx = view[0] * wx + view[4] * wy + view[12], vy = view[1] * wx + view[5] * wy + view[13], vz = view[2] * wx + view[6] * wy + view[14];
    var w = Math.max(1e-4, -vz);
    out[0] = (proj[0] * vx / w + 1) / 2; out[1] = (1 - proj[5] * vy / w) / 2;
    return out;
  }
  function sp(o, n, x, y, size, a, r, g, b) {
    if (n >= SPR_MAX) return n;
    var j = n * 7; o[j] = x; o[j + 1] = y; o[j + 2] = size; o[j + 3] = a; o[j + 4] = r; o[j + 5] = g; o[j + 6] = b;
    return n + 1;
  }

  /* the panel: 36% of the frame's width (55% of its height at most), low on the
     right — clear of the hero's headline, as far as a centred hero allows */
  Cosmos.prototype._panel = function () {
    var halfW = SILK_HALF_H * this.aspect;
    var U = Math.min(halfW * 2 * 0.36 / CON_W, SILK_HALF_H * 2 * 0.55 / CON_H);
    this.pan = { U: U, ox: halfW - CON_W * U / 2 - halfW * 0.03, oy: -0.42 };
  };

  /* rasterise the script a few lines per idle slice, after the fonts, then upload once */
  /* Also runs again on every language switch: the old console keeps playing until
     the new one is baked, then the buffers swap (no second fade-in); a newer bake
     cancels an older one mid-way. */
  Cosmos.prototype._conBake = function () {
    var self = this, L, G = [], i = 0, gen = self._bakeGen = (self._bakeGen || 0) + 1;
    var ric = window.requestIdleCallback ? function (fn) { window.requestIdleCallback(fn, { timeout: 500 }); }
                                          : function (fn) { setTimeout(function () { fn(null); }, 16); };
    var step = function (dl) {
      if (gen !== self._bakeGen || self.gl.isContextLost()) return;
      if (!L) { S = pickS(); L = conScript(); }
      do { G.push(rasterLine(L[i], 1)); i++; } while (i < L.length && dl && dl.timeRemaining() > 4);
      if (i < L.length) { ric(step); return; }
      var pk = packConsole(L, G), gl = self.gl, b = {}, old = self.con;
      for (var k = 0; k < CON_ATTR.length; k++) {
        b[CON_ATTR[k]] = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b[CON_ATTR[k]]);
        gl.bufferData(gl.ARRAY_BUFFER, pk[CON_ATTR[k]], gl.STATIC_DRAW);
      }
      self.hkeys = handKeys();
      self.con = { n: pk.n, b: b, at: old ? old.at : performance.now(), lang: (window.i18n && window.i18n.lang) || 'en' };
      if (old) for (var ob in old.b) gl.deleteBuffer(old.b[ob]);
    };
    var go = function () { ric(step); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go); else go();
  };

  /* this frame's hand: keys aimed at panel points are projected first, then the
     track, the vortex, and where the hand falls on the volume and on the panel */
  Cosmos.prototype._handFrame = function (lf, yaw, pitch, zoom) {
    var H = this.hand, keys = this.hkeys, pan = this.pan, q = this.hc, i, k;
    perspective(this.cproj, 2 * Math.atan(SILK_HALF_H / SILK_CAM_Z), this.aspect, 0.1, 400);
    orbitView(this.cview, SILK_CAM_Z * zoom, yaw * CON_DAMP, pitch * CON_DAMP);
    if (!keys) { H.vis = 0; H.push = 0; H.hole = 0; H.vortex = 0; return H; }
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (k.px !== undefined) {
        toScreen(this.cview, this.cproj, pan.ox + (k.px - CON_W / 2) * pan.U, pan.oy - (k.py - CON_H / 2) * pan.U, q);
        k.x = q[0]; k.y = q[1];
      } else { k.x = k.sx; k.y = k.sy; }
    }
    handTrack(keys, lf, H);
    H.vis *= this.conVis;
    vortexAt(lf, this.vx);
    H.vortex = this.vx.K * this.conVis; H.vang = tab(VANG, lf); H.ring = this.vx.ring;
    if (H.vortex > 0.01) H.push = 0;
    rayZ0(yaw, pitch, PULSE_CAM_Z * zoom, PULSE_HALF_H, PULSE_CAM_Z, this.aspect, H.x, H.y, this.hp);
    rayZ0(yaw * CON_DAMP, pitch * CON_DAMP, SILK_CAM_Z * zoom, SILK_HALF_H, SILK_CAM_Z, this.aspect, H.x, H.y, q);
    H.cx = (q[0] - pan.ox) / pan.U + CON_W / 2; H.cy = CON_H / 2 - (q[1] - pan.oy) / pan.U;
    return H;
  };

  /* hand.tsx Skeleton as sprites: glow + core along every bone, dust that
     shimmers along it, joints (white tips), the cursor ring, the three energy
     arcs of a grab, the blue freeze ring. Sizes follow the palm length. */
  Cosmos.prototype._fillHand = function (f) {
    var H = this.hand, o = this.spr, n = 0, W = this.cv.width, Hh = this.cv.height, mx = this.maxPt;
    var s = Hh * 0.2, k = s / 150, kd = Hh / 1080, v = H.vis, d = this.hdraw, i, q, j;
    d.x = H.x * W; d.y = H.y * Hh; d.s = s; d.roll = H.roll; d.a = H.a; d.b = H.b; d.t = H.t;
    var P = handPoints(d, this.hpts), A = H_RGB[H.a], B = H_RGB[H.b];
    var cr = A[0] + (B[0] - A[0]) * H.t, cg = A[1] + (B[1] - A[1]) * H.t, cb = A[2] + (B[2] - A[2]) * H.t;
    for (i = 0; i < 21; i++) {
      var a0 = H_BONES[i * 2] * 3, b0 = H_BONES[i * 2 + 1] * 3, ax = P[a0], ay = P[a0 + 1], bx = P[b0], by = P[b0 + 1];
      for (q = 0; q < 6; q++) { var tg = (q + 0.5) / 6; n = sp(o, n, ax + (bx - ax) * tg, ay + (by - ay) * tg, Math.min(mx, 13 * k * 2.4), 0.09 * v, cr, cg, cb); }
      for (q = 0; q < 10; q++) { var tc = (q + 0.5) / 10; n = sp(o, n, ax + (bx - ax) * tc, ay + (by - ay) * tc, Math.min(mx, 3.6 * k * 1.8), 0.75 * v, cr + (1 - cr) * 0.3, cg + (1 - cg) * 0.3, cb + (1 - cb) * 0.3); }
      for (q = 0; q < 10; q++) {
        var r = h2(i * 13.1 + q * 3.7 + 1), td = (q + 0.5 + Math.sin(f * 0.21 + r * 9) * 0.4) / 10;
        n = sp(o, n, ax + (bx - ax) * td + Math.sin(f * 0.17 + r * 31) * 3.2 * k, ay + (by - ay) * td + Math.cos(f * 0.19 + r * 17) * 3.2 * k,
               Math.min(mx, (1.3 + r * 1.6) * k * 2.2), (0.6 + r * 0.4) * v, cr, cg, cb);
      }
    }
    for (i = 0; i < 21; i++) {
      var tip = TIPS[i] === 1, z = P[i * 3 + 2];
      if (tip) n = sp(o, n, P[i * 3], P[i * 3 + 1], Math.min(mx, 8 * k * 3), 0.25 * v, cr, cg, cb);
      n = sp(o, n, P[i * 3], P[i * 3 + 1], Math.min(mx, (tip ? 7.4 : 5.2) * k * 2.4 * (1 + z * 0.25)), v, tip ? 1 : cr, tip ? 1 : cg, tip ? 1 : cb);
    }
    var R = (11 - H.pinch * 4) * 1.6 * kd;
    for (q = 0; q < 28; q++) { var ang = q / 28 * Math.PI * 2; n = sp(o, n, d.x + Math.cos(ang) * R, d.y + Math.sin(ang) * R, Math.min(mx, (1.8 + H.pinch * 1.6) * 2.2 * kd), 0.9 * v, cr, cg, cb); }
    if (H.vortex > 0.01) for (j = 0; j < 3; j++) {
      var RA = s * (0.78 + j * 0.26), st = H.vang * (1.6 - j * 0.35) + j * 2.1, white = j === 1;
      for (q = 0; q < 18; q++) { var aa = st + q / 17 * 1.9;
        n = sp(o, n, d.x + RA * Math.cos(aa), d.y + RA * Math.sin(aa), Math.min(mx, (5 - j * 1.2) * k * 2.2), H.vortex * (0.9 - j * 0.2) * v, white ? 1 : cr, white ? 1 : cg, white ? 1 : cb); }
    }
    if (H.ring >= 0 && H.ring < 1) {
      var RR = s * 0.3 + H.ring * s * 3.2;
      for (q = 0; q < 64; q++) { var ar = q / 64 * Math.PI * 2;
        n = sp(o, n, d.x + RR * Math.cos(ar), d.y + RR * Math.sin(ar), Math.min(mx, (7 * (1 - H.ring) + 1.5) * k * 2.2), (1 - H.ring) * v, 0.5, 0.7, 1); }
    }
    return n;
  };

  /* after the text: the console (normal blend — additive whitens dense strokes,
     and its dark halo must darken), then the hand (additive glow) */
  Cosmos.prototype._drawOverlay = function (lf, vlf) {
    var gl = this.gl, H = this.hand, C = this.pCon, c = this.con, pan = this.pan, i;
    if (c && C && this.conVis > 0.001) {
      gl.useProgram(C.p);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(C.u.uView, false, this.cview); gl.uniformMatrix4fv(C.u.uProj, false, this.cproj);
      gl.uniform1f(C.u.uF, vlf); gl.uniform1f(C.u.uPx, this.cv.height / (2 * SILK_HALF_H) * pan.U);
      gl.uniform1f(C.u.uMaxPt, this.maxPt); gl.uniform1f(C.u.uU, pan.U); gl.uniform1f(C.u.uVis, this.conVis);
      gl.uniform1f(C.u.uRefZ, SILK_CAM_Z); gl.uniform2f(C.u.uWH, CON_W, CON_H); gl.uniform3f(C.u.uOrigin, pan.ox, pan.oy, 0);
      /* the console joins the grab at 45%: in the film the hand was ON the panel;
         here it grabs beside it, and full strength flung the text across the hero */
      gl.uniform4f(C.u.uHand, H.cx, H.cy, H.push * H.vis, H.hole * H.vis); gl.uniform2f(C.u.uVortex, H.vortex * 0.45, H.vang);
      for (i = 0; i < CON_ATTR.length; i++) {
        var loc = C.a[CON_ATTR[i]]; if (loc === undefined || loc < 0) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, c.b[CON_ATTR[i]]); gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, i < 4 ? 4 : 3, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.POINTS, 0, c.n);
      for (i = 0; i < CON_ATTR.length; i++) { var l2 = C.a[CON_ATTR[i]]; if (l2 !== undefined && l2 >= 0) gl.disableVertexAttribArray(l2); }
    }
    if (this.pSpr && H.vis > 0.01) {
      var n = this._fillHand(lf), Q = this.pSpr;
      gl.useProgram(Q.p); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bSpr); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.spr);
      gl.enableVertexAttribArray(Q.a.aP); gl.vertexAttribPointer(Q.a.aP, 4, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(Q.a.aC); gl.vertexAttribPointer(Q.a.aC, 3, gl.FLOAT, false, 28, 16);
      gl.uniform2f(Q.u.uRes, this.cv.width, this.cv.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dot); gl.uniform1i(Q.u.uDotTex, 0);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.disableVertexAttribArray(Q.a.aP); gl.disableVertexAttribArray(Q.a.aC);
    }
    this._label();
  };

  /* the gesture pill beside the hand — the film has no voice-over, the pill says
     what the hand is doing. One element behind the page; transform + opacity only. */
  Cosmos.prototype._label = function () {
    var el = this.lab, H = this.hand;
    if (!el) return;
    if (!(H.vis > 0.02 && H.label)) { if (el.style.opacity !== '0') el.style.opacity = '0'; return; }
    if (el._t !== H.label) { el._t = H.label; el.lastChild.textContent = H.label; }
    var pose = H.t < 0.5 ? H.a : H.b;
    if (el._p !== pose) {
      el._p = pose; var c = H_RGB[pose], rgb = Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255);
      el.style.borderColor = 'rgba(' + rgb + ',0.55)'; el.style.boxShadow = '0 0 18px rgba(' + rgb + ',0.35)';
      el.firstChild.style.background = 'rgb(' + rgb + ')'; el.firstChild.style.boxShadow = '0 0 10px rgb(' + rgb + ')';
    }
    var s = window.innerHeight * 0.2;
    el.style.opacity = H.vis.toFixed(3);
    el.style.transform = 'translate3d(' + (H.x * window.innerWidth + s * 0.42).toFixed(1) + 'px,' + (H.y * window.innerHeight - s * 0.62).toFixed(1) + 'px,0)';
  };

  Cosmos.prototype.start = function () {
    if (this.raf || REDUCE) return;
    var self = this, last = 0;
    var loop = function (now) {
      self.raf = window.requestAnimationFrame(loop);
      if (!last) last = now;
      var dt = Math.min(100, now - last); last = now;
      self.clock = (self.clock || 0) + dt;
      self.draw(self.clock / 1000 * FPS);
    };
    this.raf = window.requestAnimationFrame(loop);
  };
  Cosmos.prototype.stop = function () { if (this.raf) { window.cancelAnimationFrame(this.raf); this.raf = 0; } };

  function mount() {
    if (document.getElementById('terse-cosmos')) return;
    var cv = document.createElement('canvas');
    cv.id = 'terse-cosmos';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;background:#000;display:block';
    document.body.insertBefore(cv, document.body.firstChild);
    /* the gesture pill (hand.tsx HandOverlay label): behind the page, above the canvas */
    var lab = null;
    if (FEAT) {
      lab = document.createElement('div');
      lab.setAttribute('aria-hidden', 'true');
      lab.setAttribute('data-no-i18n', '');          /* its words come from pickS(); the page translator must leave it */
      lab.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;pointer-events:none;opacity:0;will-change:transform,opacity;' +
        'white-space:nowrap;display:flex;align-items:center;gap:9px;padding:7px 14px 7px 11px;border-radius:999px;' +
        'background:rgba(8,10,14,0.66);border:1.5px solid rgba(127,178,255,0.55);' +
        'font:800 15px -apple-system,BlinkMacSystemFont,"Inter","PingFang SC",sans-serif;color:#F4F6FA';
      lab.innerHTML = '<span style="width:9px;height:9px;border-radius:99px;flex:none"></span><span></span>';
      cv.parentNode.insertBefore(lab, cv.nextSibling);
    }
    document.documentElement.style.background = '#000';

    /* Build the stage after the page's first paint, not inside the parser: this
       script is deferred, so it runs before DOMContentLoaded, and creating the
       context plus waiting on the GPU used to hold the whole page blank. The black
       canvas is already in place, so the first paint looks the same minus the
       particles, which arrive a few frames later. */
    var c;
    window.requestAnimationFrame(function () { setTimeout(function () { new Cosmos(cv, ready); }, 0); });

    function ready(stage) {
    c = stage;
    if (!c.ok) { cv.style.background = '#000'; return; }
    window.TerseCosmos = c;
    c.lab = lab;
    /* the language switcher changed the page: bake the console again in that language */
    document.addEventListener('terse:lang', function () {
      if (c && c.pCon && c.pSpr && !(c.con && c.con.lang === (window.i18n && window.i18n.lang))) c._conBake();
    });

    /* A still for reduced motion: a readable pose, a hero line fully formed. */
    if (REDUCE) { c.draw(HERO_FROM + G_IN + 10 + (B0 + 135)); return; }

    /* The film DRAGS the view; on a page that would fight text selection and
       links, so the visitor's pointer adds a gentle parallax on top of the loop
       instead (±10° yaw, ±6° pitch, eased). */
    window.addEventListener('pointermove', function (ev) {
      c.par.tx = (ev.clientX / (window.innerWidth || 1)) * 2 - 1;
      c.par.ty = (ev.clientY / (window.innerHeight || 1)) * 2 - 1;
    }, { passive: true });
    var rt = 0;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { c.resize(); }, 150); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) c.stop(); else c.start(); });
    /* A lost context used to stop the stage for good — every program, buffer and
       texture died with it and nothing rebuilt them, so the particles froze until
       a reload. macOS drops WebGL contexts on GPU switches, after sleep, and when
       another app leans on the GPU: exactly "the longer it's open, the more it
       sticks". On restore, build the stage again on the same canvas and carry the
       clock and the parallax over, so the film resumes where it froze. */
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); c.stop(); });
    cv.addEventListener('webglcontextrestored', function () {
      new Cosmos(cv, function (n) {
        if (!n.ok) return;
        n.clock = c.clock; n.par = c.par; n.lab = c.lab;
        c = window.TerseCosmos = n;
        if (!document.hidden) c.start();
      });
    });
    c.start();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

/* ── Off-screen motion is not free ─────────────────────────────────────────
   The landing page runs ~26 infinite CSS animations — the pets, the trust
   marquee, the CTA and wallpaper pulses. Measured on the live page: on first
   load EVERY one of them is off-screen, and the browser still ticks each of
   them every frame for as long as the tab is open. One (wpPulse) animates
   box-shadow, which is a main-thread repaint per frame. That is steady load on
   a machine that is also drawing the particle stage — on a laptop, the kind
   that heats it until it throttles, which reads as "slower the longer it's open".

   Nobody can see an animation that is off-screen, so it is paused there and
   resumed just before it scrolls into view (200px early). On screen nothing
   changes. It works on the animations themselves (getAnimations), which covers
   pseudo-elements and anything the demo scenes start later — a light rescan
   every 4s picks those up, and drops cancelled ones so nothing accumulates. */
(function () {
  'use strict';
  if (!document.getAnimations || !window.IntersectionObserver || typeof Map === 'undefined') return;
  var byEl = new Map(), onScreen = new Map(), known = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  if (!known) return;
  function apply(a, on) { try { if (on) { if (a.playState === 'paused') a.play(); } else if (a.playState === 'running') a.pause(); } catch (e) { /* a finished or detached animation */ } }
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].target, on = entries[i].isIntersecting, list = byEl.get(el);
      onScreen.set(el, on);
      if (list) for (var j = 0; j < list.length; j++) apply(list[j], on);
    }
  }, { rootMargin: '200px 0px' });
  function scan() {
    var anims = document.getAnimations();
    for (var i = 0; i < anims.length; i++) {
      var a = anims[i];
      if (known.has(a)) continue;
      var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
      var el = a.effect && a.effect.target;
      if (!t || t.iterations !== Infinity || !el || el.nodeType !== 1) continue;
      known.add(a);
      var list = byEl.get(el);
      if (!list) { byEl.set(el, list = []); io.observe(el); }
      list.push(a);
      if (onScreen.has(el)) apply(a, onScreen.get(el));
    }
    /* Also decide from geometry on every rescan, not only from the observer.
       IntersectionObserver delivers with rendering updates, so a late or
       missed callback would leave an off-screen animation running for good;
       a rect check on ~26 elements every 4s costs nothing and guarantees the
       state converges. The observer still gives the instant response on scroll. */
    var H = window.innerHeight || 0;
    byEl.forEach(function (list, el) {
      for (var k = list.length - 1; k >= 0; k--) if (list[k].playState === 'idle') list.splice(k, 1);
      if (!list.length || !el.isConnected) { byEl.delete(el); onScreen.delete(el); io.unobserve(el); return; }
      var r = el.getBoundingClientRect(), on = r.width > 0 && r.bottom > -200 && r.top < H + 200;
      onScreen.set(el, on);
      for (var q = 0; q < list.length; q++) apply(list[q], on);
    });
  }
  function start() { scan(); setInterval(scan, 4000); }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
