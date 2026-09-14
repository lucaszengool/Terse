/**
 * room-scene.js — 点一座楼,走进去。
 *
 * room-interior.js 是文法(一间屋子能用哪些件),这里是**盖房子**:拿胶囊里的一个
 * 目录(name / kids / leaves)摆出平面图,每间屋子问一次文法,把件一颗颗吐进同一个
 * 粒子缓冲,然后让人在里面走。
 *
 * ⚠ 不自己开 WebGL。`createRoom` 借调用方的 renderer —— 在手机上那就是引擎自己的
 * 那一个。iOS Safari 只肯给一页有限几个活的 WebGL 上下文,第二个全屏粒子系统正是
 * 它会拒绝的请求(app.js 里项目窗口为这个黑过三次)。所以走进楼的时候外面那片场
 * **停下来让出画布**,走出来再接着画,自始至终只有一个上下文。
 *
 * ⚠ 平面图(layoutOf)不在这里,在 room-interior.js:它是纯函数,不碰 WebGL —— 引擎、
 * 原型页和测试拿到的是同一张图,而这个文件拉着 three/addons,测试里是加载不了的。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { langOfFile } from './lang-colors.js';
import { interiorOf, interiorVariants, FLOOR, WALL, CEIL, LIGHT, COL, DISP, asLight, mix,
         layoutOf, fileLight, HALL_W, HALL_D, HALL_H, DOOR_W, PAD } from './room-interior.js';

/* 标签和摇杆的样式。宿主页可能是原型页、手机 app、Mac 壁纸 —— 各有各的样式表,
   所以这几条跟着模块走,只注入一次。 */
const CSS = `
.room-label{position:fixed;transform:translate(-50%,-100%);color:#eef4f2;font:11px/1 ui-monospace,SFMono-Regular,monospace;
  background:rgba(3,4,7,.6);padding:3px 7px;border-radius:6px;pointer-events:none;white-space:nowrap;
  border:1px solid rgba(255,255,255,.12);text-shadow:0 0 12px rgba(110,231,183,.5);z-index:2}
.room-joy{position:absolute;left:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));width:110px;height:110px;border-radius:50%;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.11);touch-action:none;z-index:3}
.room-joy i{position:absolute;left:35px;top:35px;width:40px;height:40px;border-radius:50%;background:rgba(110,231,183,.45)}`;
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('room-scene-css')) return;
  const s = document.createElement('style');
  s.id = 'room-scene-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * 盖好一座楼的里面,交回一个能走的场景。
 *
 * @param {THREE.WebGLRenderer} renderer 借来的 —— 不 dispose 它,只在走的时候用它画
 * @param {object} dir     胶囊里的一个目录:{ name, files, bytes, lang, kids, leaves }
 * @param {object} [opts]
 *   style   外面那座城用的风格 id(胶囊的 `style`)
 *   host    标签和摇杆挂在哪个元素里(默认 body)
 *   input   拖动视角 / 点文件听哪个元素(默认 renderer 的画布)
 *   budget  粒子预算的比例 0.25–1。手机上给小一点:这是按次付的账,但也不该是桌面那一份
 *   onHere(info)  走进了另一间屋子
 *   onPick(file)  点了一个文件
 */
export function createRoom(renderer, dir, opts = {}) {
  injectCss();
  const B = Math.max(0.25, Math.min(1, +opts.budget || 1));
  const L = layoutOf(dir || {});
  const { hall, rooms, doors } = L;
  const styleId = opts.style || (dir && dir.style) || 'modern';
  const dirLang = (dir && dir.lang) || '';
  const host = opts.host || document.body;
  const input = opts.input || renderer.domElement;

  const walkable = (x, z) => {
    for (const r of rooms) if (x > r.x0 + PAD && x < r.x1 - PAD && z > r.z0 + PAD && z < r.z1 - PAD) return true;
    for (const d of doors) if (x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1) return true;
    return false;
  };
  const roomNamed = (n) => rooms.find((r) => r.name === n && !r.isHall) || hall;
  const roomAt = (x, z) => rooms.find((r) => !r.isHall && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) || hall;

  /* ── 粒子缓冲 ─────────────────────────────────────────────────────────────
     一切都是点。墙、地、穹顶、柱子、吊灯、文件 —— 同一个缓冲、同一支着色器,
     加色混合 + bloom。外面那座城市就是这么画的,走进来不该换一种材质语言。 */
  const MAX = Math.round(420000 * B);
  const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 3);
  const siz = new Float32Array(MAX), pha = new Float32Array(MAX), twk = new Float32Array(MAX);
  let N = 0;
  /* ⚠ 文件最后才摆,所以缓冲满了先丢的是它们 —— 而文件是这间屋子唯一的数据,
     墙再好看也只是布景。装修的时候给展品留出位置,装修自己撞上这条线就停。 */
  let nLeaves = 0;
  for (const fs of L.byRoom.values()) nLeaves += fs.length;
  let limit = MAX - Math.round(nLeaves * 2400 * B * 1.3);
  function emit(x, y, z, c, size, twinkle) {
    if (N >= limit) return;
    const i = N++;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    // 闪烁相位:按下标哈希,不用 Math.random —— 这个仓库里的城市一律可复现。
    siz[i] = size; pha[i] = (Math.imul(i, 2654435761) >>> 0) / 4294967296;
    twk[i] = twinkle === undefined ? 0.5 : twinkle;
  }

  /** 拱门:门洞上的券。风格不改它的做法,只改它的颜色 —— 门就是门。 */
  function arch(d, h, c1, c2, n, rnd) {
    const horiz = d.side === 'N' || d.side === 'S';
    const half = DOOR_W / 2, top = h * 0.62;
    for (let i = 0; i < n; i++) {
      const t = rnd() * Math.PI, j = (rnd() - 0.5) * 0.09;
      const u = Math.cos(t) * half, y = Math.sin(t) * (top - 1.5) + 1.5 + j;
      emit(d.cx + (horiz ? u : j), y, d.cz + (horiz ? j : u), mix(c2, c1, rnd() * 0.45), 1.1 + rnd() * 1.2, 0.6);
    }
    for (let i = 0; i < n / 3; i++) {
      const s = rnd() < 0.5 ? -1 : 1;
      emit(d.cx + (horiz ? s * half : 0), rnd() * 1.5, d.cz + (horiz ? 0 : s * half), mix(c2, c1, 0.5), 1.0, 0.5);
    }
  }

  /* ── 盖起来 ──────────────────────────────────────────────────────────────
     每个房间问一次 interiorOf:风格是**整个项目**的(跟着外面那座楼),槽位是
     **这个目录自己**的。于是同一个项目里四个子目录同属一个风格,又各装各的。 */
  const decor = new Map();
  const kitOf = (r) => decor.get(r.isHall ? '\0hall' : r.name);

  function furnish(r) {
    const isHall = !!r.isHall;
    const ip = interiorOf(styleId, r.name);
    const rnd = () => ip.rnd.f();
    const c1 = asLight(ip.pal.stone, 0.88);          // 石材
    const c2 = asLight(ip.pal.accent, 1.0);          // 强调色:金 / 朱红 / 蓝釉
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const R = Math.min(r.x1 - r.x0, r.z1 - r.z0) / 2;
    const h = r.h;
    const scale = (isHall ? 1 : 0.42) * B;           // 子房间用小一号的预算
    decor.set(isHall ? '\0hall' : r.name, ip);

    FLOOR[ip.floor]({ r, cx, cz, R, n: Math.round(32000 * scale), rnd, c1, c2, grain: ip.grain }, emit);

    for (const s of ['N', 'S', 'W', 'E']) {
      const x0 = s === 'E' ? r.x1 : r.x0, x1 = s === 'W' ? r.x0 : r.x1;
      const z0 = s === 'S' ? r.z1 : r.z0, z1 = s === 'N' ? r.z0 : r.z1;
      const gap = doors.find((d) => (s === 'N' || s === 'S')
        ? Math.abs(d.cz - z0) < 0.9 && d.x0 > r.x0 - 0.5 && d.x1 < r.x1 + 0.5
        : Math.abs(d.cx - x0) < 0.9 && d.z0 > r.z0 - 0.5 && d.z1 < r.z1 + 0.5);
      // 20000(三成半是墙皮):8500 的时候走近了墙是空的,见 room-interior.js 的 curtain
      WALL[ip.wall]({ x0, z0, x1, z1, h, n: Math.round(20000 * scale), rnd, c1, c2, gap }, emit);
    }

    /* 顶用的是**屋面色**,不是强调色。波斯的蓝釉、唐宋的青瓦就在 pal.roof 里 ——
       外面那座楼的顶是什么颜色,从里面抬头看就该是什么颜色。 */
    const cRoof = asLight(ip.pal.roof, 1.0);
    CEIL[ip.ceil]({ r, cx, cz, R: R * 0.95, y: h * (ip.ceil === 'dome' || ip.ceil === 'onion' ? 0.52 : 1),
                    hgt: h * 0.6, n: Math.round(30000 * scale), rnd,
                    c1: mix(c1, cRoof, 0.45), c2: mix(cRoof, c2, 0.35), grain: ip.grain }, emit);

    LIGHT[ip.light]({ cx, cy: h * (isHall ? 0.60 : 0.74), cz, r, n: Math.round(8500 * scale), rnd, c1, c2 }, emit);

    if (ip.col !== 'none' && isHall) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let b = 0; b < ip.bays; b++) {
        const x = sx * (HALL_W / 2 - 2.0 - b * 3.4), z = sz * (HALL_D / 2 - 1.9);
        if (Math.abs(x) < 2.2) continue;
        COL[ip.col]({ x, z, h: h * 0.66, n: Math.round(2600 * B), rnd, c1, c2 }, emit);
      }
    }
    return { ip, rnd, c1, c2 };
  }

  const hallKit = furnish(hall);
  for (const r of rooms) if (!r.isHall) furnish(r);
  for (const d of doors) arch(d, HALL_H, hallKit.c1, hallKit.c2, Math.round(2600 * B), hallKit.rnd);

  // 文件:陈列方式由那间屋子的 disp 槽决定,高度永远是字节数,颜色永远是它自己的语言。
  limit = MAX;
  const props = [];
  for (const [k, files] of L.byRoom) {
    const r = k ? roomNamed(k) : hall;
    const ip = kitOf(r);
    const rnd = () => ip.rnd.f();
    const c1 = asLight(ip.pal.stone, 0.88), c2 = asLight(ip.pal.accent, 1.0);
    const cols = Math.ceil(Math.sqrt(files.length)), rowsN = Math.ceil(files.length / cols);
    const m = k ? 1.6 : 3.0;
    files.forEach((f, i) => {
      const h = Math.min(2.6, 0.55 + Math.log2(1 + f.bytes / 350) * 0.24);
      const c0 = i % cols, r0 = Math.floor(i / cols);
      const x = cols === 1 ? (r.x0 + r.x1) / 2 : r.x0 + m + c0 * (r.x1 - r.x0 - m * 2) / (cols - 1);
      const z = rowsN === 1 ? (r.z0 + r.z1) / 2 : r.z0 + m + r0 * (r.z1 - r.z0 - m * 2) / (rowsN - 1);
      DISP[ip.disp]({ x, z, h, n: Math.round(2400 * B), rnd, lang: fileLight(f.name, dirLang), c1, c2 }, emit);
      props.push({ x, z, h, name: f.name, bytes: f.bytes, dir: f.sub || L.name, lang: langOfFile(f.name) || dirLang });
    });
  }

  /* ── 渲染 ── */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030407);
  const FOG = 0.021;
  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 220);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, N * 3), 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(col.subarray(0, N * 3), 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(siz.subarray(0, N), 1));
  geo.setAttribute('aPhase',   new THREE.BufferAttribute(pha.subarray(0, N), 1));
  geo.setAttribute('aTwk',     new THREE.BufferAttribute(twk.subarray(0, N), 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixel: { value: 1 } },
    vertexShader: `
      precision highp float;
      attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aTwk;
      uniform float uTime, uPixel;
      varying vec3 vColor; varying float vA; varying float vFog; varying float vNear;
      void main(){
        vec3 p = position;
        // 呼吸。厅堂不能是死的 —— 一点极慢的起伏就让整片粒子活过来。
        p.y += sin(uTime * 0.55 + aPhase * 6.2831) * 0.022 * (0.4 + aTwk);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        // ⚠ 分母的下限不能太小,否则脚边的点被放得巨大,地面看起来像一地泡沫。
        // 1.7 → 2.2:贴着墙站的时候,墙上的点也是这么被放大成一团团虚光的。
        gl_PointSize = aSize * uPixel * 12.0 / max(2.2, d);
        // 闪烁只给该闪的东西(吊灯、火、顶冠),石头不闪
        float tw = 0.72 + 0.28 * sin(uTime * 1.7 + aPhase * 19.0);
        vA = mix(1.0, tw, aTwk);
        vFog = exp(-d * d * ${(FOG * FOG).toFixed(8)});
        // 贴脸的点淡掉:一米以内它们不是"墙",是糊在镜头上的一团团虚光
        vNear = smoothstep(0.35, 1.3, d);
        vColor = aColor;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec3 vColor; varying float vA; varying float vFog; varying float vNear;
      void main(){
        vec2 d = gl_PointCoord - vec2(0.5);
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        /* ⚠ 系数要小。加色混合下几万颗点一叠就冲到 1.0,颜色全烧成白的 ——
           第一版的厅堂正是这么没的:金是白的,语言色也是白的。 */
        float a = exp(-r2 * 11.0) * 0.46;
        gl_FragColor = vec4(vColor * a * vA * vFog * vNear, 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  const prevAutoClear = renderer.autoClear;
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // strength / radius / threshold。阈值低了每一颗点都参与开花,厅堂就糊成一团白。
  const size0 = renderer.getSize(new THREE.Vector2());
  const bloom = new UnrealBloomPass(new THREE.Vector2(size0.x || 1, size0.y || 1), 0.55, 0.70, 0.42);
  composer.addPass(bloom);

  /* ── 走 ── */
  let W = size0.x || 1, H = size0.y || 1;
  let yaw = 0, pitch = -0.02, px = 0, pz = HALL_D / 2 - 2.4, t = 0;
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  const keys = new Set();
  const move = { x: 0, z: 0 };
  const offs = [];
  const on = (el, type, fn, o) => { el.addEventListener(type, fn, o); offs.push(() => el.removeEventListener(type, fn, o)); };
  // 按钮和摇杆上的按下不是"拖视角" —— 宿主把返回键放在同一个元素里是常事。
  const chrome = (e) => e.target && e.target.closest && e.target.closest('button, a, .room-joy');

  on(input, 'pointerdown', (e) => {
    if (chrome(e)) return;
    dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY;
    try { input.setPointerCapture(e.pointerId); } catch (err) {}
  });
  const endDrag = () => { dragging = false; };
  on(window, 'pointerup', endDrag);
  on(window, 'pointercancel', endDrag);
  on(window, 'blur', () => { dragging = false; keys.clear(); });
  on(window, 'pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.0035;
    pitch = Math.max(-1.1, Math.min(1.1, pitch - (e.clientY - lastY) * 0.0035));
    lastX = e.clientX; lastY = e.clientY;
  });
  const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  on(window, 'keydown', (e) => { if (!typing(e)) keys.add(e.key.toLowerCase()); });
  on(window, 'keyup', (e) => keys.delete(e.key.toLowerCase()));

  const els = [];
  if (opts.joystick || (typeof window !== 'undefined' && 'ontouchstart' in window)) {
    const joy = document.createElement('div'); joy.className = 'room-joy';
    const stick = document.createElement('i'); joy.appendChild(stick);
    host.appendChild(joy); els.push(joy);
    let id = null;
    on(joy, 'touchstart', (e) => { id = e.changedTouches[0].identifier; e.preventDefault(); }, { passive: false });
    on(joy, 'touchmove', (e) => {
      for (const tt of e.changedTouches) {
        if (tt.identifier !== id) continue;
        const b = joy.getBoundingClientRect();
        const jx = Math.max(-1, Math.min(1, (tt.clientX - (b.left + b.width / 2)) / (b.width / 2)));
        const jy = Math.max(-1, Math.min(1, (tt.clientY - (b.top + b.height / 2)) / (b.height / 2)));
        stick.style.left = 35 + jx * 25 + 'px'; stick.style.top = 35 + jy * 25 + 'px';
        move.x = jx; move.z = jy; e.preventDefault();
      }
    }, { passive: false });
    const off = (e) => { for (const tt of e.changedTouches) if (tt.identifier === id) { id = null; move.x = move.z = 0; stick.style.left = stick.style.top = '35px'; } };
    on(joy, 'touchend', off); on(joy, 'touchcancel', off);
  }

  const rectOf = () => { try { return renderer.domElement.getBoundingClientRect(); } catch (e) { return { left: 0, top: 0 }; } };
  const tmp = new THREE.Vector3();
  const toScreen = (x, y, z) => {
    tmp.set(x, y, z).project(camera);
    const rc = rectOf();
    return { x: rc.left + (tmp.x * 0.5 + 0.5) * W, y: rc.top + (-tmp.y * 0.5 + 0.5) * H, behind: tmp.z > 1 };
  };

  on(input, 'click', (e) => {
    if (chrome(e) || Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    // 光柱没有网格可以打射线,就按屏幕距离挑最近的那一根
    let best = null, bd = 60;
    for (const p of props) {
      const s = toScreen(p.x, p.h * 0.6, p.z);
      if (s.behind) continue;
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      if (d < bd) { bd = d; best = p; }
    }
    if (best && opts.onPick) { try { opts.onPick(best); } catch (err) {} }
  });

  const labels = [];
  const labelAt = (i) => {
    while (labels.length <= i) {
      const el = document.createElement('div'); el.className = 'room-label'; el.style.display = 'none';
      host.appendChild(el); labels.push(el); els.push(el);
    }
    return labels[i];
  };

  function step(dt, fwd, strafe) {
    const s = 3.6 * dt, sin = Math.sin(yaw), cos = Math.cos(yaw);
    const dx = (-sin * fwd + cos * strafe) * s, dz = (-cos * fwd - sin * strafe) * s;
    if (walkable(px + dx, pz)) px += dx;
    if (walkable(px, pz + dz)) pz += dz;
  }

  const hereInfo = (r) => {
    const ip = kitOf(r);
    return {
      name: r.name, isHall: !!r.isHall, files: r.files,
      path: r.isHall ? L.name.replace(/\/?$/, '/') : L.name.replace(/\/?$/, '/') + r.name + '/',
      style: ip && ip.style.id,
    };
  };
  let hereNow = null;

  function update(dt) {
    dt = Math.min(0.05, Math.max(0, dt || 0));
    t += dt;
    mat.uniforms.uTime.value = t;
    mat.uniforms.uPixel.value = renderer.getPixelRatio() * (H / 800);

    const kf = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const kr = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const fwd = kf - move.z, strafe = kr + move.x;
    if (fwd || strafe) step(dt, fwd, strafe);
    camera.position.set(px, 1.62, pz);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();

    const here = roomAt(px, pz);
    if (here !== hereNow) {
      hereNow = here;
      if (opts.onHere) { try { opts.onHere(hereInfo(here)); } catch (e) {} }
    }

    let n = 0;
    for (const p of props) {
      const el = labelAt(n++);
      const dist = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
      const s = toScreen(p.x, p.h + 0.55, p.z);
      const rc = rectOf();
      if (s.behind || dist > 16 || s.x < rc.left - 60 || s.x > rc.left + W + 60 || s.y < rc.top || s.y > rc.top + H) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
      el.style.opacity = String(Math.max(0.2, 1 - dist / 16));
      el.textContent = p.name;
    }
  }

  function render() { composer.render(); }

  function resize(w, h) {
    W = Math.max(1, w | 0); H = Math.max(1, h | 0);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    composer.setSize(W, H);
  }
  resize(W, H);

  let dead = false;
  function dispose() {
    if (dead) return;
    dead = true;
    for (const f of offs) { try { f(); } catch (e) {} }
    for (const el of els) { try { el.remove(); } catch (e) {} }
    try { geo.dispose(); mat.dispose(); } catch (e) {}
    try { bloom.dispose(); } catch (e) {}
    try { composer.dispose(); } catch (e) {}
    // 画布还给外面那片场,状态原样交回去。
    try { renderer.setRenderTarget(null); renderer.autoClear = prevAutoClear; } catch (e) {}
  }

  return {
    update, render, resize, dispose, step,
    renderNow() { update(0); render(); },
    at(x, z, y, p) { px = x; pz = z; if (y != null) yaw = y; if (p != null) pitch = p; },
    where() { return { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), room: roomAt(px, pz).name }; },
    here() { return hereInfo(roomAt(px, pz)); },
    particles: () => N, bloom, walkable, rooms, doors, props, camera, move,
    hasLeaves: L.hasLeaves, extraKids: L.extraKids,
    /** 这间厅堂抽到了哪几件 —— 看文法有没有真的在变。 */
    kit(name) {
      const ip = kitOf(name ? roomNamed(name) : hall);
      return ip && { style: ip.style.id, floor: ip.floor, wall: ip.wall, ceil: ip.ceil, light: ip.light, col: ip.col, disp: ip.disp };
    },
    kits() { return rooms.map((r) => { const ip = kitOf(r); return [r.name, ip.floor, ip.wall, ip.ceil, ip.light, ip.col, ip.disp]; }); },
    variants: interiorVariants,
  };
}
