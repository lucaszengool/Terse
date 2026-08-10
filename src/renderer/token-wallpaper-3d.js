/*
 * token-wallpaper-3d.js — Premium live-wallpaper visual engine for Terse (Tauri / WKWebView, macOS)
 * ------------------------------------------------------------------------------------------------
 * A faithful vanilla-Three.js port of the "Sonic Topography" 3D audio-terrain visualizer (the ref1
 * project). Instead of audio it is driven by TOKEN CONSUMPTION + live AGENT ACTIVITY.
 *
 * The look is a real GPU-displaced landscape: a dense grid of thousands of small glowing blocks
 * whose heights are computed entirely in a vertex shader from simplex-noise "ocean" + frequency-band
 * regions (sub-bass hills at the centre, bass clusters, mid river-currents, scattered high spikes),
 * with radiating ripples, a rich fragment shader (warm/cool colour zones, edge glow, twinkles,
 * sparkles, aerial fog), orbiting floating crystal blocks, falling meteors with particle bursts, and
 * a slowly rotating platter. On top of the reference we add UnrealBloom + a cinematic grade pass so
 * the hot caps/meteors genuinely bloom — Steam-Wallpaper-Engine grade.
 *
 * Because Terse has no audio, the shader's frequency bands are synthesised from REAL agent activity:
 *   - setActivity(0..1)  (aggregate agent burn rate)  → overall "loudness": calm when idle, dancing
 *                                                        hard when agents burn tokens. Never random.
 *   - pulse(strength)    (token deltas)               → a decaying kick + a radiating ripple; big
 *                                                        deltas add a meteor + white shock ripple.
 *
 * Public API (identical to the previous engine so callers don't change):
 *   const w = new TokenWallpaper3D(canvas, { theme:'neon', quality:44, angle:42, intensity:1 });
 *   w.start(); w.stop(); w.resize();
 *   w.pulse(0.4);
 *   w.setTheme('ocean'); w.setQuality(80); w.setAngle(60); w.setIntensity(1.2); w.setActivity(0.7);
 *   w.floatToken(1200,'consume'); w.setAgents([...]); w.setStageItems([...]);
 *   w.getThemes(); w.dispose();
 *
 * The host HTML provides an import map for the bare specifiers below — do NOT change them.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ==================================================================================================
// Terrain shader (ported verbatim from ref1 CustomShaderMaterial.ts, with one added uniform
// `uIdleAmp` so the resting ocean can be calmed right down when no agents are working — that keeps
// the 律动 honest: gentle life at idle, real motion only under activity).
// ==================================================================================================
const TERRAIN_VERT = `
  uniform float uTime;

  // Frequency envelopes (synthesised from agent activity on the CPU)
  uniform float uSubBass;
  uniform float uBass;
  uniform float uLowMid;
  uniform float uMid;
  uniform float uHighMid;

  // Timbral
  uniform float uSmoothness;
  uniform float uDensity;
  uniform float uEnergy;
  uniform float uAmplitude;
  uniform float uIdleAmp;

  struct Ripple {
    vec2 pos;
    float time;
    float strength;
    float isActive;
    float rippleType;
  };
  uniform Ripple uRipples[10];

  varying vec2 vUv;
  varying float vElevation;
  varying float vDistance;
  varying vec2 vRippleAnim; // x for normal, y for white
  varying vec3 vNormal;
  varying float vRelativeY;
  varying vec2 vInstancePos;
  varying float vInstanceRandom;

  // Simplex noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187,  0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy) );
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1; i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m ; m = m*m ;
    vec3 x = 2.0 * fract(p * C.www) - 1.0; vec3 h = abs(x) - 0.5; vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox; m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
    vec3 g; g.x  = a0.x  * x0.x  + h.x  * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  void main() {
    vUv = uv;
    vNormal = normal;

    vec4 instancePos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 pos2D = instancePos.xz;
    vInstancePos = pos2D;

    float centerDist = length(pos2D);
    vDistance = centerDist;

    float rnd = random(pos2D);
    vInstanceRandom = rnd;

    // 1. Idle Background state (smooth, ocean-like)
    vec2 movingPos = pos2D * 0.05 + vec2(uTime * 0.1, uTime * 0.05);
    float baseNoise = (snoise(movingPos) + 1.0) * 0.5;
    float wave = sin(pos2D.x * 0.15 + pos2D.y * 0.1 - uTime * 0.6) * 0.5 + 0.5;

    float globalFalloff = smoothstep(60.0, 30.0, centerDist);
    float idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.8 * globalFalloff * uIdleAmp;

    // 2. Frequency Regions & Displacements

    // Sub-Bass: Center heavy, ultra slow rolling hills, massive block lifts
    float subRegion = smoothstep(25.0, 0.0, centerDist);
    float subLift = uSubBass * subRegion * 5.0;

    // Bass: Chunk-based lifts, less rigid than sub, but still clustered
    float bassNoise = snoise(pos2D * 0.1 - vec2(0.0, uTime * 0.2));
    float bassRegion = smoothstep(35.0, 5.0, centerDist + bassNoise * 5.0);
    float bassLift = uBass * bassRegion * (smoothstep(0.0, 1.0, rnd + uDensity * 0.5)) * 4.0;

    // Low Mid: Flowing waves across the whole map slowly
    float lowMidNoise = snoise(pos2D * 0.05 + vec2(uTime * 0.1, 0.0));
    float lowMidLift = uLowMid * (lowMidNoise * 0.5 + 0.5) * 2.5;

    // Mid: River-like current. Strong diagonal flow.
    float riverFlow = sin(pos2D.x * 0.2 + pos2D.y * 0.2 + snoise(pos2D * 0.1) * 2.0 - uTime * 2.0);
    float midLift = uMid * max(0.0, riverFlow) * 3.0;

    // High Mid: Individual scattered spikes, highly dependent on column random
    float highMidRegion = smoothstep(10.0, 45.0, centerDist);
    float highMidLift = 0.0;
    if (fract(rnd * 13.3) > 0.8) {
        highMidLift = uHighMid * highMidRegion * fract(rnd * 7.7) * 2.5;
    }

    // Combine
    float audioElevation = subLift + bassLift + lowMidLift + midLift + highMidLift;

    // Energy Spike
    if (rnd > 0.99) {
        audioElevation += uEnergy * 5.0;
    }

    audioElevation *= globalFalloff;

    // NOISE GATE: keep near-silence perfectly flat at 0
    audioElevation = max(0.0, audioElevation - 0.2);

    // Apply overall amplitude scaling
    audioElevation *= uAmplitude;

    float elevation = idleElevation + audioElevation;

    // Ripples
    float rippleElevation = 0.0;
    float rippleIntensityNormal = 0.0;
    float rippleIntensityWhite = 0.0;
    float speed = 15.0;
    float width = 3.0;

    for(int i = 0; i < 10; i++) {
      if(uRipples[i].isActive > 0.0) {
         float dist = length(pos2D - uRipples[i].pos);
         float timeSince = uTime - uRipples[i].time;

         float curSpeed = speed;
         float curWidth = width;
         float curFadeDist = 15.0;
         float elevationScale = 4.0;

         if (uRipples[i].rippleType > 0.5) {
             curSpeed = 20.0;
             curWidth = 1.0;
             curFadeDist = 8.0;
             elevationScale = 1.0;
         }

         float waveRadius = timeSince * curSpeed;
         float d = dist - waveRadius;
         float rippleWave = exp(-d*d / curWidth);
         float fade = exp(-waveRadius / curFadeDist);
         float rPulse = rippleWave * fade * uRipples[i].strength;

         rippleElevation += rPulse * elevationScale;
         if (uRipples[i].rippleType > 0.5) {
             rippleIntensityWhite += rPulse;
         } else {
             rippleIntensityNormal += rPulse;
         }
      }
    }

    elevation += rippleElevation;
    vRippleAnim = vec2(clamp(rippleIntensityNormal, 0.0, 1.0), clamp(rippleIntensityWhite, 0.0, 1.0));
    vElevation = elevation;

    float yPos = position.y + 0.5; // 0 to 1
    vRelativeY = yPos;

    float totalHeight = 1.0 + elevation;
    vec3 pos = position;
    pos.y = -0.5 + yPos * totalHeight; // Anchor bottom to local -0.5

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const TERRAIN_FRAG = `
  uniform float uTime;

  // High frequency & timbral uniforms for color
  uniform float uPresence;
  uniform float uBrilliance;
  uniform float uAir;

  uniform float uWarmth;
  uniform float uBrightness;
  uniform float uSharpness;

  // Theme Uniforms
  uniform vec3 uBaseColor1;
  uniform vec3 uBaseColor2;
  uniform vec3 uFogColor;
  uniform vec3 uCoolCore;
  uniform vec3 uCoolEdge;
  uniform vec3 uWarmCore;
  uniform vec3 uWarmEdge;
  uniform vec3 uRippleColor;
  uniform float uGlowIntensity;

  varying vec2 vUv;
  varying float vElevation;
  varying float vDistance;
  varying vec2 vRippleAnim;
  varying vec3 vNormal;
  varying float vRelativeY;
  varying vec2 vInstancePos;
  varying float vInstanceRandom;

  float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  void main() {
    bool isTop = vNormal.y > 0.5;
    float distFromTop = 1.0 - vRelativeY;

    float rnd = vInstanceRandom;
    float centerDist = length(vInstancePos);

    float normElevation = clamp(vElevation / 8.0, 0.0, 1.0);

    vec3 cBase1 = uBaseColor1;
    vec3 cBase2 = uBaseColor2;

    vec3 coolCore = uCoolCore;
    vec3 coolEdge = uCoolEdge;

    vec3 warmCore = uWarmCore;
    vec3 warmEdge = uWarmEdge;

    float warmBlend = smoothstep(0.0, 1.0, uWarmth * 1.5 + (0.5 - centerDist/80.0));

    vec3 zoneCore = mix(coolCore, warmCore, warmBlend);
    vec3 zoneEdge = mix(coolEdge, warmEdge, warmBlend);

    vec3 targetGlow = mix(zoneCore, zoneEdge, fract(rnd * 11.0));

    float distFade = 1.0 - smoothstep(40.0, 75.0, centerDist);

    vec3 brightCool = mix(coolCore, vec3(1.0), 0.24);
    targetGlow = mix(targetGlow, brightCool, uBrightness * 0.6);

    vec3 currentGlow = mix(cBase2, targetGlow, normElevation) * uGlowIntensity * distFade;

    currentGlow = mix(currentGlow, uRippleColor, vRippleAnim.x);
    currentGlow = mix(currentGlow, vec3(1.0, 1.0, 1.0), vRippleAnim.y);

    vec3 bodyColor = mix(cBase1, cBase2, vRelativeY * distFade);
    vec3 finalColor;

    if (isTop) {
       float topIntensity = smoothstep(0.0, 0.4, normElevation);

       float twinkleDistFalloff = smoothstep(60.0, 30.0, centerDist);
       float twinkleMultiplier = mix(twinkleDistFalloff, 1.0, smoothstep(0.01, 0.1, normElevation));

       bool isSparkleTarget = fract(rnd * 31.0) > 0.95;
       if (isSparkleTarget && normElevation < 0.1) {
          topIntensity += uAir * 2.0 * twinkleMultiplier;
       }

       finalColor = mix(cBase2, currentGlow, topIntensity);

       float edgeX = smoothstep(0.05, 0.01, vUv.x) + smoothstep(0.95, 0.99, vUv.x);
       float edgeY = smoothstep(0.05, 0.01, vUv.y) + smoothstep(0.95, 0.99, vUv.y);
       float edge = min(edgeX + edgeY, 1.0);
       finalColor += currentGlow * edge * 0.8 * (topIntensity + 0.3);

       float flashChance = smoothstep(0.3, 1.0, uPresence);
       if (fract(rnd * 53.0) > 0.98 - flashChance * 0.1) {
           float flashSync = sin(uTime * 40.0 + rnd * 100.0) * 0.5 + 0.5;
           finalColor += mix(vec3(1.0), vec3(0.5, 1.0, 1.0), rnd) * flashSync * uPresence * (1.0 + uSharpness * 2.0) * twinkleMultiplier;
       }

       if (edge > 0.5 && fract(rnd * 89.0 + uTime * 2.0) > 0.98) {
           finalColor += vec3(1.0) * uBrilliance * 3.0 * twinkleMultiplier;
       }

    } else {
       float verticalFalloff = mix(1.0, 3.0, uSharpness);
       float sideGlow = smoothstep(0.5 / verticalFalloff, 0.0, distFromTop) * normElevation;

       if (normElevation < 0.02) sideGlow = 0.0;

       finalColor = mix(bodyColor, currentGlow, sideGlow * 1.5);

       float rimGlow = smoothstep(0.03, 0.0, distFromTop) * normElevation;
       finalColor += currentGlow * rimGlow;
    }

    finalColor += uRippleColor * vRippleAnim.x * 0.6;
    finalColor += vec3(1.0, 1.0, 1.0) * vRippleAnim.y * 1.2;

    float aerialFog = smoothstep(30.0, 65.0, vDistance);
    vec3 atmosphericColor = mix(cBase1, cBase2, 0.4);
    finalColor = mix(finalColor, atmosphericColor, aerialFog * 0.35);

    // OPAQUE terrain (perf): far blocks fully dissolve into the near-black backdrop instead of using
    // real alpha blending — this lets the depth buffer early-reject hidden fragments (no transparency
    // overdraw across ~thousands of blocks), the single biggest smoothness win on WKWebView.
    float alphaFade = 1.0 - smoothstep(55.0, 78.0, vDistance);
    vec3 backdropColor = uFogColor;
    finalColor = mix(finalColor, backdropColor, 1.0 - alphaFade);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// Floating-block shaders (ported verbatim from ref1). Glowing crystal cubes that orbit + pulse.
const FLOAT_VERT = `
  uniform float uTime;
  uniform float uPulse;

  varying vec2 vUv;
  varying float vElevation;
  varying float vDistance;
  varying vec2 vRippleAnim;
  varying vec3 vNormal;
  varying float vRelativeY;
  varying vec2 vInstancePos;

  void main() {
    vUv = uv;
    vNormal = normal;

    vec4 instancePos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 pos2D = instancePos.xz;
    vInstancePos = pos2D;
    vDistance = length(pos2D);

    vRippleAnim = vec2(uPulse * 0.8, uPulse * 0.3);
    vElevation = uPulse * 20.0;

    vRelativeY = position.y + 0.5;

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FLOAT_FRAG = `
  uniform float uTime;

  uniform float uPresence;
  uniform float uBrilliance;
  uniform float uAir;

  uniform float uWarmth;
  uniform float uBrightness;
  uniform float uSharpness;

  uniform vec3 uBaseColor1;
  uniform vec3 uBaseColor2;
  uniform vec3 uFogColor;
  uniform vec3 uCoolCore;
  uniform vec3 uCoolEdge;
  uniform vec3 uWarmCore;
  uniform vec3 uWarmEdge;
  uniform vec3 uRippleColor;
  uniform float uGlowIntensity;

  varying vec2 vUv;
  varying float vElevation;
  varying float vDistance;
  varying vec2 vRippleAnim;
  varying vec3 vNormal;
  varying float vRelativeY;
  varying vec2 vInstancePos;

  float random(vec2 st) {
    return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  void main() {
    float rnd = random(vInstancePos);
    float centerDist = length(vInstancePos);

    float normElevation = clamp(vElevation / 8.0, 0.0, 1.0);

    vec3 cBase1 = uBaseColor1;
    vec3 cBase2 = uBaseColor2;

    vec3 coolCore = uCoolCore;
    vec3 coolEdge = uCoolEdge;
    vec3 warmCore = uWarmCore;
    vec3 warmEdge = uWarmEdge;

    float warmBlend = smoothstep(0.0, 1.0, uWarmth * 1.5 + (0.5 - centerDist/80.0));
    vec3 zoneCore = mix(coolCore, warmCore, warmBlend);
    vec3 zoneEdge = mix(coolEdge, warmEdge, warmBlend);

    vec3 targetGlow = mix(zoneCore, zoneEdge, fract(rnd * 11.0));

    float distFade = 1.0 - smoothstep(40.0, 75.0, centerDist);
    vec3 brightCool = mix(coolCore, vec3(1.0), 0.24);
    targetGlow = mix(targetGlow, brightCool, uBrightness * 0.6);

    vec3 currentGlow = mix(cBase2, targetGlow, normElevation) * uGlowIntensity * distFade;

    currentGlow = mix(currentGlow, uRippleColor, vRippleAnim.x);
    currentGlow = mix(currentGlow, vec3(1.0, 1.0, 1.0), vRippleAnim.y);

    float topIntensity = smoothstep(0.0, 0.4, normElevation);
    float twinkleDistFalloff = smoothstep(60.0, 30.0, centerDist);
    float twinkleMultiplier = mix(twinkleDistFalloff, 1.0, smoothstep(0.01, 0.1, normElevation));

    vec3 finalColor = mix(cBase2, currentGlow, topIntensity);

    float edgeX = smoothstep(0.05, 0.01, vUv.x) + smoothstep(0.95, 0.99, vUv.x);
    float edgeY = smoothstep(0.05, 0.01, vUv.y) + smoothstep(0.95, 0.99, vUv.y);
    float edge = min(edgeX + edgeY, 1.0);
    finalColor += currentGlow * edge * 0.8 * (topIntensity + 0.3);

    float flashChance = smoothstep(0.3, 1.0, uPresence);
    if (fract(rnd * 53.0) > 0.98 - flashChance * 0.1) {
        float flashSync = sin(uTime * 40.0 + rnd * 100.0) * 0.5 + 0.5;
        finalColor += mix(vec3(1.0), vec3(0.5, 1.0, 1.0), rnd) * flashSync * uPresence * (1.0 + uSharpness * 2.0) * twinkleMultiplier;
    }

    if (edge > 0.5 && fract(rnd * 89.0 + uTime * 2.0) > 0.98) {
        finalColor += vec3(1.0) * uBrilliance * 3.0 * twinkleMultiplier;
    }

    finalColor += uRippleColor * vRippleAnim.x * 0.6;
    finalColor += vec3(1.0, 1.0, 1.0) * vRippleAnim.y * 1.2;

    float aerialFog = smoothstep(30.0, 65.0, vDistance);
    vec3 atmosphericColor = mix(cBase1, cBase2, 0.4);
    finalColor = mix(finalColor, atmosphericColor, aerialFog * 0.35);

    float alphaFade = 1.0 - smoothstep(55.0, 78.0, vDistance);
    float alphaBlend = 1.0 - alphaFade;
    vec3 backdropColor = uFogColor;
    finalColor = mix(finalColor, backdropColor, alphaBlend * 0.45);

    gl_FragColor = vec4(finalColor, alphaFade);
  }
`;

// Cinematic grade applied AFTER tone-mapping (vignette + film grain + edge chromatic aberration).
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime:    { value: 0 },
    uVignette:{ value: 0.55 },
    uGrain:   { value: 0.045 },
    uAberr:   { value: 0.0015 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberr;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
    void main(){
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * uAberr * (0.4 + r2 * 3.0);
      float cr = texture2D(tDiffuse, uv + off).r;
      vec4  cg = texture2D(tDiffuse, uv);
      float cb = texture2D(tDiffuse, uv - off).b;
      vec3 col = vec3(cr, cg.g, cb);
      float vig = smoothstep(0.9, 0.28, r2 * (1.4 + uVignette));
      col *= mix(1.0, vig, uVignette);
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5;
      col += g * uGrain;
      gl_FragColor = vec4(col, cg.a);
    }
  `,
};

// ==================================================================================================
// Theme palette. We keep the existing Terse theme NAMES (so the control UI + saved config are
// unchanged) but express each as the reference engine's ThemeColors so the ported shader can drive
// its warm/cool zones, ripple accent and glow. Values are sRGB [r,g,b] 0..255.
//   bgDark = deep backdrop/fog  bgMid = lighter base  cool = cool zone core  warm = warm zone core
//   accent = ripple/HUD accent  glowIntensity = overall emissive strength
// ==================================================================================================
const THEME_DEFS = {
  neon:    { bgDark:[4,1,9],   bgMid:[16,5,26],  cool:[255,60,220], warm:[120,255,235], accent:[255,120,240], glow:1.45 },
  indigo:  { bgDark:[3,2,10],  bgMid:[13,10,28], cool:[120,110,255],warm:[190,150,255], accent:[150,140,255], glow:1.25 },
  ocean:   { bgDark:[1,4,11],  bgMid:[4,15,30],  cool:[40,180,255], warm:[120,235,235], accent:[90,200,240],  glow:1.30 },
  ice:     { bgDark:[4,8,15],  bgMid:[14,24,36], cool:[150,220,255],warm:[220,245,255], accent:[190,230,255], glow:1.05 },
  emerald: { bgDark:[1,6,5],   bgMid:[4,20,16],  cool:[60,230,150], warm:[200,255,90],  accent:[120,245,190], glow:1.30 },
  gold:    { bgDark:[9,6,1],   bgMid:[24,18,6],  cool:[255,210,120],warm:[255,150,50],  accent:[255,215,120], glow:1.15 },
  amber:   { bgDark:[9,4,1],   bgMid:[24,12,4],  cool:[255,190,110],warm:[255,120,40],  accent:[255,160,70],  glow:1.20 },
  blood:   { bgDark:[8,1,2],   bgMid:[24,4,7],   cool:[255,110,100],warm:[255,60,60],   accent:[240,70,70],   glow:1.25 },
  coral:   { bgDark:[9,3,7],   bgMid:[26,12,18], cool:[95,205,210], warm:[255,110,110], accent:[255,150,150], glow:1.15 },
  mono:    { bgDark:[3,3,4],   bgMid:[14,14,17], cool:[230,230,235],warm:[255,255,255], accent:[235,235,240], glow:0.90 },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Compact token formatter for floating labels: 1234 -> "1.2K", 2_500_000 -> "2.5M".
function fmtNum(n) {
  n = Math.round(+n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Linear-space THREE.Color from an sRGB 0..255 triplet, treated as direct working values (matching
// how the reference constructs its vivid theme colours — no sRGB→linear darkening).
function lin(c) { return new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255); }

// Escape agent-produced log text before it hits innerHTML (it's untrusted data, may contain markup).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Build the reference-style ThemeColors object for a Terse theme def.
function buildTheme(d) {
  const base = lin(d.bgDark);
  const cool = lin(d.cool);
  const warm = lin(d.warm);
  const white = new THREE.Color(1, 1, 1);
  return {
    uBaseColor1: base.clone(),
    uBaseColor2: lin(d.bgMid),
    // Fog / backdrop / renderer-clear: a near-black version of the base so the empty surround recedes
    // to moody dark instead of a flat mid-tone wash (sRGB gamma otherwise lifts even a "dark" base).
    uFogColor: base.clone().multiplyScalar(0.12),
    uCoolCore: cool.clone(),
    uCoolEdge: cool.clone().lerp(base, 0.35),
    uWarmCore: warm.clone(),
    uWarmEdge: warm.clone().lerp(white, 0.15),
    uRippleColor: lin(d.accent),
    uGlowIntensity: d.glow,
    accentHex: '#' + lin(d.accent).getHexString(),
  };
}

// Inject the CSS for the in-scene floating labels / centre stage once per document.
function ensureLabelStyles() {
  if (document.getElementById('tw3d-label-css')) return;
  const s = document.createElement('style');
  s.id = 'tw3d-label-css';
  s.textContent = `
    .tw-lay{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2}
    .tw-lab{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;pointer-events:none;white-space:nowrap;will-change:transform,opacity}
    .tw-float{font-size:23px;font-weight:850;letter-spacing:-.02em;font-variant-numeric:tabular-nums;
      text-shadow:0 0 18px currentColor,0 2px 10px rgba(0,0,0,.55)}
    .tw-tag{display:flex;align-items:center;gap:7px;padding:5px 11px 5px 9px;border-radius:9999px;
      background:rgba(10,12,20,.34);backdrop-filter:blur(14px) saturate(1.25);-webkit-backdrop-filter:blur(14px) saturate(1.25);
      border:1px solid rgba(255,255,255,.15);box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 10px 30px rgba(0,0,0,.42);
      color:#fff;font-size:11px;font-weight:700;transition:opacity .35s ease}
    .tw-tag .dot{width:6px;height:6px;border-radius:50%;background:#6ee7a0;box-shadow:0 0 8px #6ee7a0;flex-shrink:0;animation:twblink 1.8s ease-in-out infinite}
    .tw-tag .ic{font-size:13px;line-height:1}
    .tw-tag .rt{font-weight:850;font-variant-numeric:tabular-nums;color:var(--tw-accent,#e146eb)}
    @keyframes twblink{0%,100%{opacity:1}50%{opacity:.4}}
    .tw-stage{text-align:center;transition:opacity .5s ease}
    .tw-stage::before{content:'';position:absolute;left:50%;top:52%;width:560px;height:300px;
      transform:translate(-50%,-50%);border-radius:50%;z-index:-1;pointer-events:none;
      background:radial-gradient(closest-side, color-mix(in srgb, var(--tw-accent,#e146eb) 24%, transparent), transparent 74%);
      filter:blur(22px);animation:twspot 3.4s ease-in-out infinite}
    .tw-stage.saved::before{background:radial-gradient(closest-side, color-mix(in srgb,#34d375 26%, transparent), transparent 74%)}
    .tw-stage-in{transform-origin:center center;will-change:transform,filter,opacity}
    .tw-stage-pulse{transform-origin:center center;will-change:transform}
    .tw-stage-k{font-size:11px;font-weight:800;letter-spacing:.26em;text-transform:uppercase;
      color:rgba(255,255,255,.66);margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:8px}
    .tw-stage-k .ic{font-size:15px}
    /* stat value: accent-tinted gradient text (matches the wallpaper theme) with a slow moving shine
       and an accent glow via drop-shadow (works on background-clip text, unlike text-shadow). */
    .tw-stage-v{font-size:58px;font-weight:860;letter-spacing:-.03em;line-height:.95;
      font-variant-numeric:tabular-nums;
      background:linear-gradient(100deg,#fff 0%,var(--tw-accent,#e146eb) 52%,#fff 108%);
      background-size:220% 100%;-webkit-background-clip:text;background-clip:text;
      color:transparent;-webkit-text-fill-color:transparent;
      filter:drop-shadow(0 0 24px color-mix(in srgb,var(--tw-accent,#e146eb) 62%,transparent)) drop-shadow(0 3px 14px rgba(0,0,0,.5));
      animation:twshine 5s linear infinite}
    .tw-stage-v .u{-webkit-text-fill-color:rgba(255,255,255,.62);color:rgba(255,255,255,.62);
      font-size:20px;font-weight:800;margin-left:8px;letter-spacing:0;filter:none}
    .tw-stage.saved .tw-stage-v{background:linear-gradient(100deg,#fff 0%,#34d375 52%,#fff 108%);background-size:220% 100%;
      -webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;
      filter:drop-shadow(0 0 24px rgba(52,211,117,.6)) drop-shadow(0 3px 14px rgba(0,0,0,.5))}
    @keyframes twshine{0%{background-position:0 0}100%{background-position:220% 0}}
    /* live agent-log panel — a glass terminal of the busiest agent's recent steps (more detailed than
       the Dynamic Island ticker). Screen-anchored (not a CSS2DObject) so it stays readable. */
    .tw-log{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);
      width:min(74vw,540px);padding:12px 15px;border-radius:16px;
      background:linear-gradient(180deg,rgba(14,16,26,.52),rgba(9,11,19,.36));
      backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);
      border:1px solid rgba(255,255,255,.12);overflow:hidden;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 22px 64px rgba(0,0,0,.5);
      opacity:0;transform-origin:bottom center;transition:opacity .5s ease}
    .tw-log.on{opacity:1;animation:twlogpop .55s cubic-bezier(.2,.9,.25,1)}
    .tw-log::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
      background:linear-gradient(180deg,var(--tw-accent,#e146eb),transparent)}
    .tw-log-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-left:5px}
    .tw-log-hd .ic{font-size:15px}
    .tw-log-hd .nm{font-size:12px;font-weight:800;color:#fff;letter-spacing:.02em}
    .tw-log-hd .pj{font-size:11px;font-weight:600;color:rgba(255,255,255,.4);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
    .tw-log-hd .lv{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:10px;font-weight:800;
      letter-spacing:.14em;text-transform:uppercase;color:var(--tw-accent,#e146eb)}
    .tw-log-hd .lv b{width:6px;height:6px;border-radius:50%;background:var(--tw-accent,#e146eb);
      box-shadow:0 0 8px var(--tw-accent,#e146eb);animation:twblink 1.6s ease-in-out infinite}
    .tw-log-grp + .tw-log-grp{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.09)}
    .tw-log-rows{display:flex;flex-direction:column;gap:3px}
    .tw-log-row{display:flex;align-items:center;gap:9px;font-size:11.5px;line-height:1.55;
      font-family:'SF Mono',ui-monospace,Menlo,'Cascadia Code','Cascadia Mono',Consolas,'Microsoft YaHei Mono',monospace;color:rgba(255,255,255,.82);
      animation:twlogin .45s cubic-bezier(.2,.85,.25,1) both}
    .tw-log-row .k{flex-shrink:0;width:15px;text-align:center;font-size:12px}
    .tw-log-row .k.tool{color:var(--tw-accent,#e146eb)}
    .tw-log-row .k.result{color:#6ee7a0}
    .tw-log-row .k.asst{color:#8fd0ff}
    .tw-log-row .k.user{color:rgba(255,255,255,.55)}
    .tw-log-row .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tw-log-row .n{flex-shrink:0;font-variant-numeric:tabular-nums;font-size:10.5px;font-weight:800;
      color:var(--tw-accent,#e146eb);opacity:.92}
    @keyframes twlogin{0%{opacity:0;transform:translateY(7px)}100%{opacity:1;transform:translateY(0)}}
    @keyframes twlogpop{0%{opacity:0;transform:translateX(-50%) translateY(14px) scale(.97)}
      100%{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
    .tw-lyric{animation:twlyric 1s cubic-bezier(.16,.86,.26,1) both}
    @keyframes twlyric{
      0%{opacity:0;filter:blur(16px);transform:perspective(900px) translateZ(-700px) translateY(30px) rotateX(30deg)}
      55%{opacity:1;filter:blur(0)}
      100%{opacity:1;filter:blur(0);transform:perspective(900px) translateZ(0) translateY(0) rotateX(5deg)}}
    .tw-stage-beat{animation:twbeat .5s cubic-bezier(.2,.8,.2,1)}
    @keyframes twbeat{0%{transform:scale(1)}22%{transform:scale(1.07)}100%{transform:scale(1)}}
    @keyframes twglow{0%,100%{text-shadow:0 0 30px var(--tw-accent,#e146eb),0 4px 22px rgba(0,0,0,.5)}
      50%{text-shadow:0 0 52px var(--tw-accent,#e146eb),0 4px 22px rgba(0,0,0,.5)}}
    @keyframes twglowsaved{0%,100%{text-shadow:0 0 30px #34d375,0 4px 22px rgba(0,0,0,.5)}
      50%{text-shadow:0 0 52px #34d375,0 4px 22px rgba(0,0,0,.5)}}
    @keyframes twspot{0%,100%{opacity:.7;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}}
  `;
  document.head.appendChild(s);
}

// World-space constants (matching the reference terrain footprint).
const TERRAIN_SIZE = 168;      // full field width in world units
const FLOAT_BLOCK_COUNT = 80;

// ==================================================================================================
// TokenWallpaper3D
// ==================================================================================================
export default class TokenWallpaper3D {
  constructor(canvasEl, opts = {}) {
    if (!canvasEl) throw new Error('TokenWallpaper3D: a canvas element is required');
    this.canvas = canvasEl;

    // ---- Configurable state ----
    this.themeName = THEME_DEFS[opts.theme] ? opts.theme : 'neon';
    this.theme = buildTheme(THEME_DEFS[this.themeName]);
    this.quality = clamp(opts.quality | 0 || 44, 24, 110);
    this.gridSize = this._qualityToGrid(this.quality);   // N×N terrain blocks
    this.angleDeg = clamp(opts.angle || 42, 28, 75);     // camera elevation
    this.intensity = clamp(opts.intensity || 1, 0.3, 2);

    // ---- Runtime state ----
    this.running = false;
    this._raf = 0;
    this._lastT = 0;
    this._time = 0;
    this.W = 0; this.H = 0;

    // Agent-activity level [0..1] drives the synthesised spectrum. Eased so it ramps smoothly.
    this._activity = 0;
    this._activityTarget = 0;
    // Kick envelope: jumps on pulse(), decays — feeds sub/bass + presence like a drum hit.
    this._kick = 0;
    this._platterRot = 0;
    // Adaptive performance: effective DPR = _dprBase × _dprScale. Downshifts if frame time stays high.
    this._dprScale = 1;
    this._emaDt = 0;
    this._perfT = 0;

    // Ripple ring buffer (10) — passed straight to the shader.
    this._RIPPLES = 10;
    this._ripples = new Array(this._RIPPLES).fill(null).map(() => ({
      pos: new THREE.Vector2(), time: -100, strength: 0, isActive: 0, rippleType: 0,
    }));
    this._rippleIdx = 0;
    this._meteorCooldown = 0;

    // Meteor + particle pools.
    this._MAX_METEORS = 8;
    this._MAX_PARTICLES = 420;

    // In-scene labels (CSS2D).
    this._floaters = [];
    this._MAX_FLOATERS = 18;
    this._agentTags = new Map();
    this._stageItems = [];
    this._stageIdx = 0;
    this._stageT = 0;
    this._STAGE_PERIOD = 3.6;

    // Reusable scratch.
    this._dummy = new THREE.Object3D();
    this._v3 = new THREE.Vector3();
    this._onResize = () => this.resize();

    this._initThree();
    this._buildField();
    this._buildFloatingBlocks();
    this._buildParticles();
    this._buildMeteorPool();
    this._initLabels();
    this._applyThemeToScene();
    this.resize();
  }

  // Map the 24..110 quality dial to a terrain grid size (denser = finer, more "liquid" landscape,
  // like the 160×160 original). Safe to push high now that the terrain is opaque: density adds cheap
  // vertex work, not fragment overdraw. Adaptive DPR still protects weak GPUs.
  _qualityToGrid(q) {
    return Math.round(clamp(72 + ((q - 24) / (110 - 24)) * (160 - 72), 72, 160));
  }

  // ------------------------------------------------------------------------------------------------
  // Scene / renderer / post-processing
  // ------------------------------------------------------------------------------------------------
  _initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.setClearColor(this.theme.uFogColor, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(this.theme.uFogColor.getHex(), 30, 95);

    // Slowly rotating platter holds the terrain + floating blocks + meteors + particles.
    this.platter = new THREE.Group();
    this.scene.add(this.platter);

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.5, 2000);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(10, 20, 10);
    this.scene.add(dir);

    // Post: RenderPass → UnrealBloom → OutputPass (tonemap+sRGB) → cinematic grade.
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    // Subtle bloom: only genuinely hot crests / ripple shocks / meteors cross the threshold — keeps
    // the field dark & moody (the pervasive edge-glow must NOT bloom into a lavender haze).
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.4, 0.85);
    this.outputPass = new OutputPass();
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.gradePass);
  }

  // Shared uniform block for terrain + floating blocks (colours/timbre are common).
  _makeUniforms(extra) {
    const t = this.theme;
    const u = {
      uTime: { value: 0 },
      uSubBass: { value: 0 }, uBass: { value: 0 }, uLowMid: { value: 0 },
      uMid: { value: 0 }, uHighMid: { value: 0 },
      uPresence: { value: 0 }, uBrilliance: { value: 0 }, uAir: { value: 0 },
      uWarmth: { value: 0 }, uBrightness: { value: 0 }, uSharpness: { value: 0 },
      uSmoothness: { value: 0.5 }, uDensity: { value: 0.4 }, uEnergy: { value: 0 },
      uAmplitude: { value: this.intensity }, uIdleAmp: { value: 0.4 },
      uBaseColor1: { value: t.uBaseColor1.clone() },
      uBaseColor2: { value: t.uBaseColor2.clone() },
      uFogColor: { value: t.uFogColor.clone() },
      uCoolCore: { value: t.uCoolCore.clone() },
      uCoolEdge: { value: t.uCoolEdge.clone() },
      uWarmCore: { value: t.uWarmCore.clone() },
      uWarmEdge: { value: t.uWarmEdge.clone() },
      uRippleColor: { value: t.uRippleColor.clone() },
      uGlowIntensity: { value: t.uGlowIntensity },
    };
    return Object.assign(u, extra || {});
  }

  // Build the GPU-displaced terrain: an InstancedMesh of small boxes, positions baked ONCE (the
  // shader does all the per-frame height work — no CPU matrix churn even at ~35k instances).
  _buildField() {
    const G = this.gridSize;
    const spacing = TERRAIN_SIZE / G;
    const boxW = spacing * (0.9 / 1.05);
    this._spacing = spacing;

    this._terrainUniforms = this._makeUniforms({
      uRipples: { value: this._ripples },
    });
    this._colGeo = new THREE.BoxGeometry(boxW, 1, boxW);
    this._colMat = new THREE.ShaderMaterial({
      uniforms: this._terrainUniforms,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      transparent: false,   // opaque → depth cull kills hidden-fragment overdraw (perf)
      depthWrite: true,
      fog: false,
    });

    this.field = new THREE.InstancedMesh(this._colGeo, this._colMat, G * G);
    this.field.frustumCulled = false;
    const m = new THREE.Matrix4();
    const offset = (G * spacing) / 2;
    let i = 0;
    for (let x = 0; x < G; x++) {
      for (let z = 0; z < G; z++) {
        m.makeTranslation(x * spacing - offset, 0.5, z * spacing - offset);
        this.field.setMatrixAt(i++, m);
      }
    }
    this.field.instanceMatrix.needsUpdate = true;
    this.platter.add(this.field);
  }

  // Orbiting glowing crystal cubes (ref FloatingBlocks). ~80 instances, CPU-updated per frame.
  _buildFloatingBlocks() {
    const count = FLOAT_BLOCK_COUNT;
    this._floatBlocks = Array.from({ length: count }, (_, index) => {
      const ring = index / count;
      const angle = ring * Math.PI * 2 * 5.0 + Math.sin(index * 12.9898) * 0.7;
      const radius = 14 + ((index * 37) % 62);
      const height = 6 + ((index * 17) % 19);
      return {
        x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, y: height,
        baseScale: 0.75 + ((index * 11) % 9) * 0.05,
        phase: index * 0.73,
        rotationSpeed: 0.18 + ((index * 7) % 10) * 0.035,
      };
    });
    this._floatUniforms = this._makeUniforms({ uPulse: { value: 0 } });
    this._floatGeo = new THREE.BoxGeometry(1, 1, 1);
    this._floatMat = new THREE.ShaderMaterial({
      uniforms: this._floatUniforms,
      vertexShader: FLOAT_VERT,
      fragmentShader: FLOAT_FRAG,
      transparent: true,
      fog: false,
    });
    this.floatMesh = new THREE.InstancedMesh(this._floatGeo, this._floatMat, count);
    this.floatMesh.frustumCulled = false;
    this._floatPulse = 0;
    this.platter.add(this.floatMesh);
    // Reusable compose scratch.
    this._fPos = new THREE.Vector3();
    this._fQuat = new THREE.Quaternion();
    this._fEuler = new THREE.Euler();
    this._fScale = new THREE.Vector3();
    this._fMat = new THREE.Matrix4();
  }

  // Additive Points cloud for meteor-impact particle bursts.
  _buildParticles() {
    const N = this._MAX_PARTICLES;
    this._pPos = new Float32Array(N * 3);
    this._pCol = new Float32Array(N * 3);
    this._particles = new Array(N);
    for (let i = 0; i < N; i++) {
      this._particles[i] = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, r: 1, g: 1, b: 1 };
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this._pCol, 3));
    geo.setDrawRange(0, 0);
    this._particleGeo = geo;
    this._particleMat = new THREE.PointsMaterial({
      size: 0.8, sizeAttenuation: true, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.particlePoints = new THREE.Points(geo, this._particleMat);
    this.particlePoints.frustumCulled = false;
    this.platter.add(this.particlePoints);
  }

  // Pre-allocate meteors: a bright HDR head + an additive fading trail.
  _buildMeteorPool() {
    this._meteorPool = [];
    this.meteors = [];
    this._meteorSphereGeo = new THREE.SphereGeometry(0.9, 12, 12);
    const TRAIL = 16;
    for (let i = 0; i < this._MAX_METEORS; i++) {
      const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
      const head = new THREE.Mesh(this._meteorSphereGeo, headMat);
      head.visible = false;
      this.platter.add(head);

      const trailPos = new Float32Array(TRAIL * 3);
      const trailCol = new Float32Array(TRAIL * 3);
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
      trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
      trailGeo.setDrawRange(0, 0);
      const trailMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const trail = new THREE.Line(trailGeo, trailMat);
      trail.frustumCulled = false;
      trail.visible = false;
      this.platter.add(trail);

      this._meteorPool.push({ inUse: false, head, headMat, trail, trailGeo, trailMat, trailPos, trailCol, TRAIL, path: [] });
    }
  }

  // ------------------------------------------------------------------------------------------------
  // In-scene labels (CSS2D)
  // ------------------------------------------------------------------------------------------------
  _initLabels() {
    ensureLabelStyles();
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'tw-lay';
    const host = this.canvas.parentElement || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(this.labelRenderer.domElement);

    const el = document.createElement('div');
    el.className = 'tw-lab tw-stage';
    el.style.opacity = '0';
    el.innerHTML = `<div class="tw-stage-in"><div class="tw-stage-pulse"><div class="tw-stage-k"></div><div class="tw-stage-v"></div></div></div>`;
    this._stageEl = el;
    this._stageIn = el.querySelector('.tw-stage-in');
    this._stagePulse = el.querySelector('.tw-stage-pulse');
    this._stageObj = new CSS2DObject(el);
    // Float high above the centre of the landscape (world scale ~168 wide).
    this._stageObj.position.set(0, 46, -6);
    this.scene.add(this._stageObj);

    // Live agent-log panel — screen-anchored (a plain child of the overlay, not a CSS2DObject).
    // Filled by setAgentLog(): one headed group per active agent.
    const log = document.createElement('div');
    log.className = 'tw-log';
    this._logEl = log;
    this._logSig = '';
    this.labelRenderer.domElement.appendChild(log);
  }

  // Feed the live agent-log panel. `groups` = an array of agents, each
  //   { name, icon, project, lines:[{ico,label,kind,tok}] }
  // rendered as its OWN headline (icon · name · project · LIVE) + recent steps. Accepts a single
  // object too. Pass null/empty to hide. Only re-renders (re-animates) when the content changes.
  setAgentLog(groups) {
    if (!this._logEl) return;
    let list = Array.isArray(groups) ? groups : (groups && groups.lines ? [groups] : []);
    list = list.filter((g) => g && Array.isArray(g.lines) && g.lines.length);
    if (!list.length) { this._logEl.classList.remove('on'); this._logSig = ''; return; }
    // Fewer rows each when several agents share the panel, so it stays compact.
    const per = list.length > 2 ? 2 : list.length > 1 ? 3 : 5;
    const sig = list.map((g) => (g.name || '') + '#' +
      g.lines.slice(-per).map((l) => l.kind + ':' + l.label + ':' + (l.tok || 0)).join('|')).join('~~');
    this._logEl.classList.add('on');
    if (sig === this._logSig) return;
    this._logSig = sig;
    this._logEl.innerHTML = list.map((g) => {
      const lines = g.lines.slice(-per);
      const rows = lines.map((l) => (
        `<div class="tw-log-row"><span class="k ${l.kind || ''}">${escapeHtml(l.ico || '•')}</span>` +
        `<span class="t">${escapeHtml(l.label || '')}</span>` +
        (l.tok ? `<span class="n">${fmtNum(l.tok)}</span>` : '') + `</div>`
      )).join('');
      return `<div class="tw-log-grp"><div class="tw-log-hd">` +
        `<span class="ic">${escapeHtml(g.icon || '🤖')}</span>` +
        `<span class="nm">${escapeHtml(g.name || 'Agent')}</span>` +
        (g.project ? `<span class="pj">· ${escapeHtml(g.project)}</span>` : '') +
        `<span class="lv"><b></b>live</span></div>` +
        `<div class="tw-log-rows">${rows}</div></div>`;
    }).join('');
  }

  // Spawn a rising "+N" (consume) / "−N" (saved) number above the field.
  floatToken(delta, kind = 'consume') {
    delta = Math.round(+delta || 0);
    if (delta <= 0 || !this.labelRenderer) return;
    if (this._floaters.length >= this._MAX_FLOATERS) this._retireFloater(0);
    const saved = kind === 'saved';
    const el = document.createElement('div');
    el.className = 'tw-lab tw-float';
    el.textContent = (saved ? '−' : '+') + fmtNum(delta);
    el.style.color = saved ? '#6ee7a0' : (this.theme.accentHex || '#e146eb');
    const obj = new CSS2DObject(el);
    const x = (Math.random() - 0.5) * 70;
    const z = (Math.random() - 0.5) * 70;
    const y = 14 + Math.random() * 8;
    obj.position.set(x, y, z);
    this.scene.add(obj);
    this._floaters.push({ obj, el, x, y, z, vy: 9 + Math.random() * 5, life: 1, maxLife: 1.5 + Math.random() * 0.4 });
  }

  _retireFloater(i) {
    const f = this._floaters[i];
    if (!f) return;
    this.scene.remove(f.obj);
    if (f.el && f.el.parentNode) f.el.parentNode.removeChild(f.el);
    this._floaters.splice(i, 1);
  }

  setAgents(agents) {
    if (!this.labelRenderer) return;
    const list = Array.isArray(agents) ? agents.slice(0, 5) : [];
    const seen = new Set();
    list.forEach((a, i) => {
      const key = a.key || a.name || ('agent' + i);
      seen.add(key);
      let tag = this._agentTags.get(key);
      if (!tag) {
        const el = document.createElement('div');
        el.className = 'tw-lab tw-tag';
        const obj = new CSS2DObject(el);
        this.scene.add(obj);
        tag = { obj, el, phase: Math.random() * Math.PI * 2, x: 0, z: 0 };
        this._agentTags.set(key, tag);
      }
      const frac = list.length > 1 ? i / (list.length - 1) : 0.5;
      tag.x = (frac - 0.5) * 120;
      tag.z = ((i % 2) - 0.5) * 40;
      tag.el.style.setProperty('--tw-accent', this.theme.accentHex || '#e146eb');
      tag.el.innerHTML = `<span class="dot"></span><span class="ic">${a.icon || '🤖'}</span>` +
        `<span class="nm">${a.name || 'Agent'}</span>` +
        (a.rate != null ? `<span class="rt">${fmtNum(a.rate)}/min</span>` : '');
    });
    for (const [key, tag] of this._agentTags) {
      if (!seen.has(key)) {
        this.scene.remove(tag.obj);
        if (tag.el && tag.el.parentNode) tag.el.parentNode.removeChild(tag.el);
        this._agentTags.delete(key);
      }
    }
  }

  setStageItems(items) {
    this._stageItems = Array.isArray(items) ? items.filter(Boolean) : [];
    if (this._stageItems.length) this._renderStage();
    else if (this._stageEl) this._stageEl.style.opacity = '0';
  }

  _renderStage() {
    if (!this._stageEl || !this._stageItems.length) return;
    this._stageIdx = this._stageIdx % this._stageItems.length;
    const it = this._stageItems[this._stageIdx];
    const k = this._stageEl.querySelector('.tw-stage-k');
    const v = this._stageEl.querySelector('.tw-stage-v');
    k.innerHTML = (it.ic ? `<span class="ic">${it.ic}</span>` : '') + (it.k || '');
    v.innerHTML = (it.v != null ? String(it.v) : '') + (it.u ? `<span class="u">${it.u}</span>` : '');
    this._stageEl.classList.toggle('saved', !!it.saved);
    this._stageEl.style.opacity = '1';
    const inr = this._stageIn;
    inr.classList.remove('tw-lyric'); void inr.offsetWidth;
    inr.classList.add('tw-lyric');
  }

  _beatStage() {
    if (!this._stageEl || this._stageEl.style.opacity === '0' || !this._stagePulse) return;
    const p = this._stagePulse;
    p.classList.remove('tw-stage-beat'); void p.offsetWidth;
    p.classList.add('tw-stage-beat');
  }

  // ------------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this._lastT = 0;
    window.addEventListener('resize', this._onResize);
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    window.removeEventListener('resize', this._onResize);
  }

  resize() {
    const cssW = this.canvas.clientWidth || 0;
    const cssH = this.canvas.clientHeight || 0;
    if (cssW < 1 || cssH < 1) return;
    this.W = cssW; this.H = cssH;
    // Base DPR capped for WKWebView; an adaptive scale (_dprScale, ≤1) trims it further on slow GPUs.
    this._dprBase = Math.min(window.devicePixelRatio || 1, 1.35);
    this.renderer.setSize(cssW, cssH, false);
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(cssW, cssH);
    this._applyPixelRatio();
    if (this.labelRenderer) this.labelRenderer.setSize(cssW, cssH);
    this._placeCamera();
  }

  // Apply the effective pixel ratio (base × adaptive scale) to renderer + composer.
  _applyPixelRatio() {
    const dpr = (this._dprBase || 1) * (this._dprScale || 1);
    this.renderer.setPixelRatio(dpr);
    this.composer.setPixelRatio(dpr);
  }

  // Inject a token-consumption pulse. small → colored ripple ; big → meteor + white shock ripple.
  // Also drives the kick envelope that briefly swells the sub/bass terrain.
  pulse(strength) {
    strength = (typeof strength === 'number' && isFinite(strength)) ? strength : 0.3;
    strength = clamp(strength, 0, 4);
    this._kick = Math.min(1.5, this._kick + 0.35 + strength * 0.45);

    // Spawn in terrain-local space (biased toward the busy centre so effects read cleanly).
    const R = TERRAIN_SIZE * 0.42;
    const ang = Math.random() * Math.PI * 2;
    const dist = Math.random() * (strength > 0.9 ? 22 : 30);
    const rx = Math.cos(ang) * dist, rz = Math.sin(ang) * dist;

    if (strength > 0.9 && this._meteorCooldown <= 0) {
      this._spawnMeteor(rx, rz, strength);
      this._meteorCooldown = 0.25;
    } else {
      this._addRipple(rx, rz, Math.min(0.8 + strength * 1.4, 3.0), false);
    }
    this._beatStage();
  }

  setTheme(name) {
    if (!THEME_DEFS[name]) return;
    this.themeName = name;
    this.theme = buildTheme(THEME_DEFS[name]);
    this._applyThemeToScene();
    // Live-update every shader's colour uniforms.
    [this._terrainUniforms, this._floatUniforms].forEach((u) => {
      if (!u) return;
      u.uBaseColor1.value.copy(this.theme.uBaseColor1);
      u.uBaseColor2.value.copy(this.theme.uBaseColor2);
      u.uFogColor.value.copy(this.theme.uFogColor);
      u.uCoolCore.value.copy(this.theme.uCoolCore);
      u.uCoolEdge.value.copy(this.theme.uCoolEdge);
      u.uWarmCore.value.copy(this.theme.uWarmCore);
      u.uWarmEdge.value.copy(this.theme.uWarmEdge);
      u.uRippleColor.value.copy(this.theme.uRippleColor);
      u.uGlowIntensity.value = this.theme.uGlowIntensity;
    });
  }

  setQuality(n) {
    n = clamp(n | 0, 24, 110);
    const g = this._qualityToGrid(n);
    this.quality = n;
    if (g === this.gridSize) return;
    this.gridSize = g;
    // Rebuild the terrain InstancedMesh at the new density.
    this.platter.remove(this.field);
    this.field.dispose();
    this._colGeo.dispose();
    this._colMat.dispose();
    this._buildField();
    this._placeCamera();
  }

  setAngle(deg) {
    this.angleDeg = clamp(deg, 28, 75);
    this._placeCamera();
  }

  setIntensity(x) {
    this.intensity = clamp(x, 0.3, 2);
  }

  // How hard the terrain dances, [0..1], from real agent activity. 0 → calm ocean; 1 → full swells.
  setActivity(level) {
    this._activityTarget = clamp((typeof level === 'number' && isFinite(level)) ? level : 0, 0, 1);
  }

  getThemes() { return Object.keys(THEME_DEFS); }

  // ------------------------------------------------------------------------------------------------
  // Theme / camera
  // ------------------------------------------------------------------------------------------------
  _applyThemeToScene() {
    this.renderer.setClearColor(this.theme.uFogColor, 1);
    if (this.scene.fog) this.scene.fog.color.copy(this.theme.uFogColor);
    if (this.labelRenderer) this.labelRenderer.domElement.style.setProperty('--tw-accent', this.theme.accentHex);
  }

  // Frame the landscape: low-ish ¾ aerial that shows the terrain edge-on for depth (ref feel).
  _placeCamera() {
    // Map angle 28..75 → elevation 12..46°, keep a fixed off-axis azimuth for a cinematic ¾ read.
    const elDeg = 11 + ((this.angleDeg - 28) / (75 - 28)) * 30;
    const el = (elDeg * Math.PI) / 180;
    const az = -0.387; // radians off the +Z axis (matches the reference's ¾ read)
    const dist = 100;
    const horiz = dist * Math.cos(el);
    this.camera.position.set(Math.sin(az) * horiz, dist * Math.sin(el) + 4, Math.cos(az) * horiz);
    this.camera.lookAt(0, 3, 0);
    if (this.scene.fog) { this.scene.fog.near = 34; this.scene.fog.far = 120; }
  }

  // ------------------------------------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------------------------------------
  _addRipple(x, z, strength, isWhite) {
    const idx = this._rippleIdx;
    const r = this._ripples[idx];
    r.pos.set(x, z);
    r.time = this._time;
    r.strength = strength;
    r.isActive = 1;
    r.rippleType = isWhite ? 1 : 0;
    this._rippleIdx = (idx + 1) % this._RIPPLES;
  }

  _spawnMeteor(lx, lz, strength) {
    let slot = null;
    for (let i = 0; i < this._meteorPool.length; i++) {
      if (!this._meteorPool[i].inUse) { slot = this._meteorPool[i]; break; }
    }
    if (!slot) { this._addRipple(lx, lz, Math.min(strength * 2, 3), false); return; }
    slot.inUse = true;
    slot.lx = lx; slot.lz = lz;
    slot.strength = strength;
    slot.y = 34 + Math.random() * 12;
    slot.speed = 1.0 + Math.random() * 0.5 + strength * 1.4; // world units per frame-second * 60
    slot.path.length = 0;
    slot.headMat.color.copy(this.theme.uRippleColor).multiplyScalar(2.6);
    slot.head.visible = true;
    slot.head.position.set(lx, slot.y, lz);
    slot.head.scale.setScalar(0.9 + strength * 0.5);
    slot.trail.visible = true;
    this.meteors.push(slot);
  }

  _spawnBurst(x, y, z, strength) {
    const count = Math.min(30, Math.round(16 + strength * 14));
    const glow = new THREE.Color().copy(this.theme.uRippleColor).multiplyScalar(2.4);
    let emitted = 0;
    for (let i = 0; i < this._particles.length && emitted < count; i++) {
      const p = this._particles[i];
      if (p.active) continue;
      const ang = Math.random() * Math.PI * 2;
      const spd = (6 + Math.random() * 12) * (0.7 + strength * 0.5);
      p.active = true;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(ang) * spd;
      p.vz = Math.sin(ang) * spd;
      p.vy = (0.4 + Math.random() * 0.9) * spd;
      p.life = 1;
      p.maxLife = 0.5 + Math.random() * 0.6;
      p.r = glow.r; p.g = glow.g; p.b = glow.b;
      emitted++;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------------------------------------
  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);
    // Ambient wallpaper — no need to burn the GPU:
    //  • fully idle while the page is hidden (occluded / other Space / minimized),
    //  • cap to ~36fps (a slowly rotating platter looks identical, ~40% less GPU).
    if (document.hidden) { this._lastT = now; return; }
    if (this._lastRender && (now - this._lastRender) < 27) return;
    this._lastRender = now;
    if (!this._lastT) this._lastT = now;
    let dt = (now - this._lastT) / 1000;
    this._lastT = now;
    if (dt > 0.05) dt = 0.05;
    this._time += dt;

    if (this.W > 1 && this.H > 1) {
      this._update(dt);
      if (this.gradePass) this.gradePass.uniforms.uTime.value = this._time;
      // Measure the ACTUAL render cost (not the capped frame interval) so the
      // adaptive downscaler reacts to real GPU load, not to the fps cap.
      const _w0 = performance.now();
      this.composer.render();
      this._updateLabels(dt);
      if (this.labelRenderer) this.labelRenderer.render(this.scene, this.camera);
      const work = (performance.now() - _w0) / 1000;
      this._emaDt = this._emaDt ? this._emaDt * 0.9 + work * 0.1 : work;
      this._perfT += dt;
      if (this._perfT > 1.3) {
        this._perfT = 0;
        // If a rendered frame costs >18ms of real work, trim internal resolution.
        if (this._emaDt > 0.018 && this._dprScale > 0.5) {
          this._dprScale = Math.max(0.5, this._dprScale - 0.16);
          this._applyPixelRatio();
        }
      }
    }
  }

  // Advance the whole simulation: synthesise the spectrum from agent activity, feed the shaders,
  // step ripples/meteors/particles, rotate the platter.
  _update(dt) {
    // --- Activity + kick envelopes ---
    this._activity += (this._activityTarget - this._activity) * Math.min(1, dt * 1.6);
    this._kick *= Math.exp(-dt * 3.2);
    if (this._meteorCooldown > 0) this._meteorCooldown -= dt;
    const act = this._activity;
    const kick = this._kick;
    const t = this._time;

    // --- Synthesise the "audio" spectrum from activity (deterministic, phase-shifted LFOs so
    //     different terrain regions swell independently). No agents → near-zero → calm ocean. ---
    const subBass = clamp(act * (0.45 + 0.35 * Math.sin(t * 0.6)) + kick * 0.9, 0, 1.2);
    const bass = clamp(act * (0.40 + 0.30 * Math.sin(t * 0.9 + 1.0)) + kick * 0.7, 0, 1.15);
    const lowMid = clamp(act * (0.40 + 0.35 * Math.sin(t * 0.7 + 2.0)), 0, 1);
    const mid = clamp(act * (0.45 + 0.40 * Math.sin(t * 1.3 + 0.5)), 0, 1);
    const highMid = clamp(act * (0.40 + 0.45 * Math.sin(t * 1.9 + 3.0)), 0, 1);
    const presence = clamp(act * (0.30 + 0.50 * Math.max(0, Math.sin(t * 2.6))) + kick * 0.4, 0, 1);
    const brilliance = clamp(act * (0.25 + 0.50 * Math.max(0, Math.sin(t * 3.3 + 1.5))), 0, 1);
    const air = clamp(0.12 + 0.10 * act + 0.18 * Math.max(0, Math.sin(t * 0.4)), 0, 1);
    const denom = subBass + bass + lowMid + mid + presence + brilliance + air + 0.001;
    const warmth = clamp((subBass + bass + lowMid + mid) / denom, 0, 1);
    const brightness = clamp((presence + brilliance + air) / denom, 0, 1);
    const sharpness = clamp(0.2 + 0.5 * kick + 0.3 * act, 0, 1);
    const smoothness = clamp(0.7 - 0.4 * act, 0, 1);
    const density = clamp(0.3 + 0.5 * act, 0, 1);
    const energy = clamp(act * 0.7 + kick * 0.6, 0, 1);

    // --- Feed terrain shader ---
    const U = this._terrainUniforms;
    U.uTime.value = t;
    U.uSubBass.value = subBass; U.uBass.value = bass; U.uLowMid.value = lowMid;
    U.uMid.value = mid; U.uHighMid.value = highMid;
    U.uPresence.value = presence; U.uBrilliance.value = brilliance; U.uAir.value = air;
    U.uWarmth.value = warmth; U.uBrightness.value = brightness; U.uSharpness.value = sharpness;
    U.uSmoothness.value = smoothness; U.uDensity.value = density; U.uEnergy.value = energy;
    U.uAmplitude.value = this.intensity;
    U.uIdleAmp.value = 0.35 + 0.45 * act; // calmer ocean when idle, fuller under load
    U.uRipples.value = this._ripples;

    // --- Feed floating-block shader (shares timbre; pulse follows the kick) ---
    this._floatPulse += ((kick > this._floatPulse ? kick : 0) - this._floatPulse) * Math.min(1, dt * 8);
    const FU = this._floatUniforms;
    FU.uTime.value = t;
    FU.uPulse.value = clamp(this._floatPulse * (0.5 + act), 0, 1);
    FU.uWarmth.value = warmth; FU.uBrightness.value = brightness; FU.uSharpness.value = sharpness;
    FU.uPresence.value = presence; FU.uBrilliance.value = brilliance; FU.uAir.value = air;

    // --- Update floating-block instance matrices (only 80 — cheap CPU work) ---
    if (this.floatMesh) {
      const pulse = FU.uPulse.value;
      const enabled = act > 0.001 || pulse > 0.02 ? 1 : 0.55; // never fully vanish; calm at idle
      const sizeMix = clamp(pulse * (0.5 + 0.9), 0, 1);
      const pulseScale = THREE.MathUtils.lerp(0.35, 1.6, sizeMix);
      for (let i = 0; i < this._floatBlocks.length; i++) {
        const b = this._floatBlocks[i];
        const bob = Math.sin(t * (0.55 + b.rotationSpeed) + b.phase) * 0.45;
        this._fPos.set(b.x, b.y + bob + pulse * 1.4, b.z);
        this._fEuler.set(t * b.rotationSpeed + b.phase, t * b.rotationSpeed * 0.7 + b.phase, t * b.rotationSpeed * 0.45);
        this._fQuat.setFromEuler(this._fEuler);
        const s = b.baseScale * pulseScale * enabled;
        this._fScale.set(s, s, s);
        this._fMat.compose(this._fPos, this._fQuat, this._fScale);
        this.floatMesh.setMatrixAt(i, this._fMat);
      }
      this.floatMesh.instanceMatrix.needsUpdate = true;
    }

    // --- Meteors: fall, trail, impact ---
    for (let m = this.meteors.length - 1; m >= 0; m--) {
      const mt = this.meteors[m];
      mt.y -= mt.speed * 60 * dt;
      const y = Math.max(0, mt.y);
      mt.head.position.set(mt.lx, y, mt.lz);
      mt.path.push(mt.lx, y, mt.lz);
      const maxLen = mt.TRAIL * 3;
      while (mt.path.length > maxLen) mt.path.splice(0, 3);
      this._writeTrail(mt);
      if (mt.y <= 0) {
        this._addRipple(mt.lx, mt.lz, Math.min(mt.strength * 1.2, 1.4), true);
        this._addRipple(mt.lx, mt.lz, Math.min(0.8 + mt.strength, 2.4), false);
        this._spawnBurst(mt.lx, 1.0, mt.lz, mt.strength);
        mt.head.visible = false; mt.trail.visible = false; mt.inUse = false;
        this.meteors.splice(m, 1);
      } else if (Math.random() > 0.3) {
        this._spawnBurst(mt.lx, y, mt.lz, mt.strength * 0.06);
      }
    }

    // --- Particles: gravity + fade ---
    for (let i = 0; i < this._particles.length; i++) {
      const q = this._particles[i];
      if (!q.active) continue;
      q.life -= dt / q.maxLife;
      if (q.life <= 0) { q.active = false; continue; }
      q.vy -= 22 * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < 0) { q.y = 0; q.vy *= -0.3; }
    }
    // Sync particle buffers.
    const pos = this._pPos, col = this._pCol;
    let w = 0;
    for (let i = 0; i < this._particles.length; i++) {
      const q = this._particles[i];
      if (!q.active) continue;
      const a = clamp(q.life, 0, 1);
      pos[w * 3] = q.x; pos[w * 3 + 1] = q.y; pos[w * 3 + 2] = q.z;
      col[w * 3] = q.r * a; col[w * 3 + 1] = q.g * a; col[w * 3 + 2] = q.b * a;
      w++;
    }
    this._particleGeo.attributes.position.needsUpdate = true;
    this._particleGeo.attributes.color.needsUpdate = true;
    this._particleGeo.setDrawRange(0, w);

    // --- Slow platter rotation (cinematic ambient drift, not the 律动) ---
    this._platterRot += dt * 0.05;
    this.platter.rotation.y = this._platterRot;
  }

  _writeTrail(mt) {
    const path = mt.path;
    const n = path.length / 3;
    if (n < 2) { mt.trailGeo.setDrawRange(0, 0); return; }
    const pos = mt.trailPos, col = mt.trailCol, glow = this.theme.uRippleColor;
    for (let i = 0; i < n; i++) {
      const a = i / (n - 1);
      pos[i * 3] = path[i * 3]; pos[i * 3 + 1] = path[i * 3 + 1]; pos[i * 3 + 2] = path[i * 3 + 2];
      const b = a * a * 2.4;
      col[i * 3] = glow.r * b; col[i * 3 + 1] = glow.g * b; col[i * 3 + 2] = glow.b * b;
    }
    mt.trailGeo.attributes.position.needsUpdate = true;
    mt.trailGeo.attributes.color.needsUpdate = true;
    mt.trailGeo.setDrawRange(0, n);
  }

  _updateLabels(dt) {
    for (let i = this._floaters.length - 1; i >= 0; i--) {
      const f = this._floaters[i];
      f.life -= dt / f.maxLife;
      if (f.life <= 0) { this._retireFloater(i); continue; }
      f.y += f.vy * dt;
      f.vy *= (1 - dt * 0.6);
      f.obj.position.set(f.x, f.y, f.z);
      const a = clamp(f.life, 0, 1);
      f.el.style.opacity = (a < 0.5 ? a * 2 : 1).toFixed(3);
    }
    for (const tag of this._agentTags.values()) {
      tag.phase += dt * 1.3;
      const bob = Math.sin(tag.phase) * 1.2;
      tag.obj.position.set(tag.x, 16 + bob, tag.z);
    }
    if (this._stageItems.length > 1) {
      this._stageT += dt;
      if (this._stageT >= this._STAGE_PERIOD) {
        this._stageT = 0;
        this._stageIdx = (this._stageIdx + 1) % this._stageItems.length;
        this._renderStage();
      }
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Teardown
  // ------------------------------------------------------------------------------------------------
  dispose() {
    this.stop();
    if (this.field) { this.platter.remove(this.field); this.field.dispose(); }
    if (this._colGeo) this._colGeo.dispose();
    if (this._colMat) this._colMat.dispose();
    if (this.floatMesh) { this.platter.remove(this.floatMesh); this.floatMesh.dispose(); }
    if (this._floatGeo) this._floatGeo.dispose();
    if (this._floatMat) this._floatMat.dispose();
    if (this.particlePoints) {
      this.platter.remove(this.particlePoints);
      this._particleGeo.dispose(); this._particleMat.dispose();
    }
    if (this._meteorPool) {
      for (const s of this._meteorPool) {
        this.platter.remove(s.head); this.platter.remove(s.trail);
        s.headMat.dispose(); s.trailGeo.dispose(); s.trailMat.dispose();
      }
      if (this._meteorSphereGeo) this._meteorSphereGeo.dispose();
    }
    while (this._floaters && this._floaters.length) this._retireFloater(0);
    if (this._agentTags) {
      for (const tag of this._agentTags.values()) {
        this.scene.remove(tag.obj);
        if (tag.el && tag.el.parentNode) tag.el.parentNode.removeChild(tag.el);
      }
      this._agentTags.clear();
    }
    if (this._stageObj) this.scene.remove(this._stageObj);
    if (this.labelRenderer && this.labelRenderer.domElement.parentNode) {
      this.labelRenderer.domElement.parentNode.removeChild(this.labelRenderer.domElement);
    }
    if (this.composer) this.composer.dispose();
    if (this.bloomPass) this.bloomPass.dispose();
    if (this.renderer) this.renderer.dispose();
    this.meteors = [];
  }
}
