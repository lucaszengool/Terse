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
    ['agents', '4 agents running'], ['spent', '336.6M tokens in'], ['compact', '−38% filler'],
    ['cache', 'cache 61%'], ['compact', 'ctx 100% → 47%'], ['cost', '$1.40 a day'],
    ['saved', '+12,962 tok'], ['spent', 'Read(src/auth.ts)'], ['spent', 'Grep("verifyToken")'],
    ['compact', 'Glob("**/*.test.ts")'], ['spent', 'Bash(npm test)'], ['cache', 'Edit(src/auth.ts)']
  ];
  /* tokenstats.ts CYCLE */
  var CYCLE = [
    ['saved', '+1,284 tok'], ['cache', 'cache 61%'], ['compact', '−38% filler'], ['spent', '336.6M in'],
    ['saved', '+2,148 tok'], ['cost', '$0.29'], ['compact', 'auto-compact −53%'], ['cache', 'prefix ↺ 61%'],
    ['agents', '4 agents live'], ['saved', '+12,962 tok'], ['spent', 'ctx 47%'], ['cost', '$1.11']
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

  /* ── GL helpers ─────────────────────────────────────────────────────────── */
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      if (window.console) console.warn('[terse-cosmos]', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  function program(gl, vs, fs) {
    var v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    var p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { if (window.console) console.warn('[terse-cosmos]', gl.getProgramInfoLog(p)); return null; }
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

  /* ── the stage ──────────────────────────────────────────────────────────── */
  function Cosmos(canvas) {
    this.cv = canvas;
    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false,
                                          premultipliedAlpha: false, powerPreference: 'high-performance' })
          || canvas.getContext('experimental-webgl');
    if (!gl) { this.ok = false; return; }
    this.gl = gl;
    this.pBody = program(gl, PULSE_VS, PULSE_FS);
    this.pBloom = program(gl, PULSE_VS, PULSE_BLOOM_FS);
    this.pGlyph = program(gl, GLYPH_VS, GLYPH_FS);
    if (!this.pBody || !this.pBloom || !this.pGlyph) { this.ok = false; return; }
    this.ok = true;
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
  }

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
    var gl = this.gl, dr = this._drive(gf);
    var cam = camAt(gf, this.cam), p = this.par;
    p.x += (p.tx - p.x) * 0.06; p.y += (p.ty - p.y) * 0.06;
    var yaw = cam.yaw + p.x * 10, pitch = cam.pitch - p.y * 6, zoom = cam.zoom;
    var boost = boostAt(gf);
    var pAlpha = Math.min(1, PULSE_ALPHA * (1 + 0.10 * boost)), pScale = PULSE_POINT * (1 + 0.55 * boost);
    var ps = this.pose; ps.yaw = yaw; ps.pitch = pitch; ps.zoom = zoom; ps.boost = boost;

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
    var G = this.pGlyph, alive = this._alive(gf);
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
    document.documentElement.style.background = '#000';

    var c = new Cosmos(cv);
    if (!c.ok) { cv.style.background = '#000'; return; }
    window.TerseCosmos = c;

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
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); c.stop(); });
    c.start();
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
