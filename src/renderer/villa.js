/**
 * villa.js — 代码**别墅**漫游器。
 *
 * 先在屋外看外观(轨道绕行),点正门 → 相机飞进门厅 → 第一人称自由漫游。
 * 漫游用的是"看房 App"那种 **点哪走哪**:点地面任意一处,人就走过去;拖拽转头,
 * WASD 也能走。整座房子是 Spark 的**程序化高斯泼溅**(villa-gen.js 撒的点),
 * 房间就是仓库的目录树 —— 走进哪个房间,就是走进哪个目录。
 *
 * 这个文件只管"渲染 + 相机 + 交互";房子长什么样、结构怎么映射代码,全在 villa-gen.js。
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh, PackedSplats } from '@sparkjsdev/spark';
import { buildVilla, paintExterior, paintInterior } from './villa-gen.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

export function startVilla(capsule, opts = {}) {
  const mount = opts.mount || document.body;
  const hud = opts.hud || null;
  const model = buildVilla(capsule);

  /* ── three + Spark 基座 ─────────────────────────────────────────────── */
  const W = () => mount.clientWidth || window.innerWidth || 1280;
  const H = () => mount.clientHeight || window.innerHeight || 720;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W(), H());
  renderer.setClearColor(0x05060a, 1);
  mount.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.012);
  const camera = new THREE.PerspectiveCamera(64, W() / H(), 0.03, 500);

  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  // 一点星尘/地平,免得屋外一片死黑
  addGround(scene, model);

  /* ── 把别墅撒成高斯点 ───────────────────────────────────────────────── */
  const exteriorPacked = new PackedSplats();
  const interiorPacked = new PackedSplats();
  const c = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion(), col = new THREE.Color();
  const mkEmit = (packed) => (x, y, z, r, g, b, sc, op) => {
    c.set(x, y, z); s.set(sc, sc, sc); q.identity(); col.setRGB(r, g, b);
    packed.pushSplat(c, s, q, op == null ? 1 : op, col);
  };
  const iDensity = opts.density ?? 0.85;
  paintExterior(model, mkEmit(exteriorPacked), { density: 0.85 });
  paintInterior(model, mkEmit(interiorPacked), { density: iDensity });

  const exterior = new SplatMesh({ packedSplats: exteriorPacked });
  const interior = new SplatMesh({ packedSplats: interiorPacked });
  exterior.frustumCulled = false;
  interior.frustumCulled = false;
  scene.add(exterior);
  scene.add(interior);
  interior.opacity = 0;         // 一开始只见外观
  interior.visible = false;

  /* ── 点哪走哪:每层一块隐形地面用来投射点击 ─────────────────────────── */
  const floorPlanes = [];
  for (let f = 0; f < model.bounds.floors; f++) {
    const g = new THREE.PlaneGeometry(400, 400);
    const m = new THREE.MeshBasicMaterial({ visible: false });
    const pl = new THREE.Mesh(g, m);
    pl.rotation.x = -Math.PI / 2;
    pl.position.y = f * model.bounds.floorH + 0.02;
    pl.userData.floor = f;
    scene.add(pl);
    floorPlanes.push(pl);
  }
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /* ── 相机状态机 ─────────────────────────────────────────────────────── */
  const state = {
    mode: 'exterior',          // exterior | entering | inside
    yaw: Math.PI,              // 朝 -z(看向房子)
    pitch: -0.05,
    pos: new THREE.Vector3(),  // 眼睛位置
    target: null,              // 点哪走哪的目标(XZ);null 表示不在走
    floor: 0,
    orbit: 0,                  // 外观自转角
    tween: null,               // 进门/上楼的插值 {from,to,t,dur,onEnd,lookFrom,lookTo}
  };
  const eyeY = () => state.floor * model.bounds.floorH + model.eye;
  // 外观初始机位:退到屋外斜前方
  const span = Math.max(model.bounds.x1 - model.bounds.x0, model.bounds.z1 - model.bounds.z0);
  state.pos.set(span * 0.55, span * 0.42, model.bounds.z0 - span * 0.7);

  /* ── 输入 ───────────────────────────────────────────────────────────── */
  const el = renderer.domElement;
  const keys = new Set();
  let dragging = false, moved = false, lastX = 0, lastY = 0, downX = 0, downY = 0;

  el.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; lastX = downX = e.clientX; lastY = downY = e.clientY;
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) moved = true;
    if (state.mode === 'inside') {
      state.yaw -= dx * 0.004;
      state.pitch = clamp(state.pitch - dy * 0.004, -1.2, 1.2);
    } else if (state.mode === 'exterior') {
      state.orbitManual = (state.orbitManual || 0) - dx * 0.005;
      state.orbitPitch = clamp((state.orbitPitch ?? 0.42) - dy * 0.003, 0.05, 1.2);
    }
  });
  const endDrag = (e) => {
    if (dragging && !moved) onClick(e);
    dragging = false;
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', () => { dragging = false; });
  window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  el.addEventListener('wheel', (e) => {
    if (state.mode === 'inside') {
      const fwd = forward();
      state.pos.addScaledVector(fwd, -Math.sign(e.deltaY) * 0.8);
      state.target = null;
    } else if (state.mode === 'exterior') {
      state.orbitDist = clamp((state.orbitDist || span * 0.9) + Math.sign(e.deltaY) * span * 0.06, span * 0.4, span * 2.2);
    }
    e.preventDefault();
  }, { passive: false });

  function forward() {
    return new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw)).normalize();
  }

  function onClick(e) {
    const rect = el.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    if (state.mode === 'exterior') {
      enter();                              // 屋外点一下 = 进门
      return;
    }
    // 屋内:点地面 → 走过去
    const hit = raycaster.intersectObject(floorPlanes[state.floor], false)[0];
    if (hit) {
      const p = hit.point;
      const t = new THREE.Vector3(
        clamp(p.x, model.bounds.x0 + 0.4, model.bounds.x1 - 0.4),
        eyeY(),
        clamp(p.z, model.bounds.z0 + 0.4, model.bounds.z1 - 0.4),
      );
      state.target = t;
      pingLabel(e.clientX, e.clientY);
    }
  }

  /* ── 进门 / 出门 / 上下楼 ───────────────────────────────────────────── */
  function enter() {
    state.mode = 'entering';
    const foyer = new THREE.Vector3(model.foyer.x, model.eye, model.foyer.z);
    const doorway = new THREE.Vector3(model.entrance.x, model.eye, model.bounds.z0 + 0.6);
    // 两段:先冲到门口,再进门厅
    tweenTo(doorway, 0.9, () => {
      state.mode = 'inside'; state.floor = 0; state.yaw = Math.PI; state.pitch = -0.03;
      tweenTo(foyer, 1.0, () => { setHud(); });
      // 进门后把外壳的屋顶/前墙化掉,让人看得进去(整壳淡出即可)
      fade(exterior, 0, 0.8);
      interior.visible = true; fade(interior, 1, 0.8);
    });
    setHud('进入中…');
  }
  function exit() {
    state.mode = 'exterior';
    interior.visible = true; fade(interior, 0.0, 0.8, () => { interior.visible = false; });
    exterior.visible = true; fade(exterior, 1, 0.8);
    state.orbitDist = span * 0.9; state.orbitManual = 0; state.orbitPitch = 0.42;
    setHud();
  }
  function gotoFloor(f) {
    f = clamp(f, 0, model.bounds.floors - 1);
    if (f === state.floor) return;
    state.floor = f;
    const dest = new THREE.Vector3(0, eyeY(), model.corridor.len * 0.5);
    tweenTo(dest, 0.8);
  }

  function tweenTo(to, dur, onEnd) {
    state.tween = { from: state.pos.clone(), to: to.clone(), t: 0, dur, onEnd };
    state.target = null;
  }
  const fades = [];
  function fade(mesh, to, dur, onEnd) {
    fades.push({ mesh, from: mesh.opacity ?? 1, to, t: 0, dur, onEnd });
  }

  /* ── 房间标签(投影 HTML,不引 CSS2D 依赖)──────────────────────────── */
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
  mount.appendChild(labelLayer);
  const labels = model.rooms.map((r) => {
    const d = document.createElement('div');
    d.className = 'villa-label';
    d.style.cssText = 'position:absolute;transform:translate(-50%,-100%);white-space:nowrap;padding:3px 8px;border-radius:8px;font-size:12px;font-weight:600;color:#fff;background:rgba(10,12,20,.62);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px);transition:opacity .2s;will-change:transform,opacity';
    const kindZh = { source: '源码', docs: '文档', assets: '资产', test: '测试', config: '配置' }[r.kind] || r.kind;
    d.innerHTML = `<span style="color:rgb(${r.color.map((x) => Math.round(x * 255)).join(',')})">●</span> ${escapeHtml(r.name)} <span style="opacity:.6;font-weight:400">· ${kindZh} · ${r.files} files</span>`;
    labelLayer.appendChild(d);
    return { el: d, room: r };
  });
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

  const _v = new THREE.Vector3();
  function updateLabels() {
    const show = state.mode === 'inside' || state.mode === 'entering';
    for (const l of labels) {
      if (!show) { l.el.style.opacity = '0'; continue; }
      _v.set(l.room.cx, l.room.y0 + model.bounds.wallH - 0.5, l.room.cz).project(camera);
      const inFront = _v.z < 1;
      const onFloor = l.room.floor === state.floor;
      if (!inFront || !onFloor) { l.el.style.opacity = '0'; continue; }
      const x = (_v.x * 0.5 + 0.5) * W(), y = (-_v.y * 0.5 + 0.5) * H();
      l.el.style.left = x + 'px'; l.el.style.top = y + 'px';
      const dist = camera.position.distanceTo(_v.set(l.room.cx, eyeY(), l.room.cz));
      l.el.style.opacity = String(clamp(1.4 - dist / 22, 0.12, 1));
    }
  }

  // 点击落点的一圈涟漪反馈
  let ping;
  function pingLabel(x, y) {
    if (!ping) { ping = document.createElement('div'); ping.style.cssText = 'position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border:2px solid #7fd7ff;border-radius:50%;pointer-events:none'; labelLayer.appendChild(ping); }
    ping.style.left = x + 'px'; ping.style.top = y + 'px'; ping.style.opacity = '1'; ping.style.transform = 'scale(.4)';
    ping.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 480, easing: 'ease-out' });
  }

  /* ── 主循环 ─────────────────────────────────────────────────────────── */
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;

    // 淡入淡出
    for (let i = fades.length - 1; i >= 0; i--) {
      const fdo = fades[i]; fdo.t += dt / fdo.dur;
      const k = clamp(fdo.t, 0, 1);
      fdo.mesh.opacity = fdo.from + (fdo.to - fdo.from) * k;
      if (k >= 1) { fdo.onEnd && fdo.onEnd(); fades.splice(i, 1); }
    }

    if (state.tween) {
      const tw = state.tween; tw.t += dt / tw.dur;
      const k = easeInOut(clamp(tw.t, 0, 1));
      state.pos.lerpVectors(tw.from, tw.to, k);
      if (tw.t >= 1) { state.tween = null; tw.onEnd && tw.onEnd(); }
    }

    if (state.mode === 'exterior') {
      // 缓慢自转 + 手动轨道
      state.orbit += dt * 0.12;
      const az = state.orbit + (state.orbitManual || 0);
      const pit = state.orbitPitch ?? 0.42;
      const dist = state.orbitDist || span * 0.9;
      const cx = (model.bounds.x0 + model.bounds.x1) / 2;
      const cz = (model.bounds.z0 + model.bounds.z1) / 2;
      const cy = model.bounds.floors * model.bounds.floorH * 0.5;
      camera.position.set(
        cx + Math.sin(az) * dist * Math.cos(pit),
        cy + Math.sin(pit) * dist,
        cz + Math.cos(az) * dist * Math.cos(pit),
      );
      camera.lookAt(cx, cy * 0.9, cz);
    } else {
      // 屋内:WASD + 点哪走哪
      if (!state.tween) {
        const sp = (keys.has('shift') ? 6 : 3) * dt;
        const fwd = forward(), right = new THREE.Vector3(fwd.z, 0, -fwd.x);
        let moveInput = false;
        if (keys.has('w') || keys.has('arrowup')) { state.pos.addScaledVector(fwd, sp); moveInput = true; }
        if (keys.has('s') || keys.has('arrowdown')) { state.pos.addScaledVector(fwd, -sp); moveInput = true; }
        if (keys.has('a') || keys.has('arrowleft')) { state.pos.addScaledVector(right, -sp); moveInput = true; }
        if (keys.has('d') || keys.has('arrowright')) { state.pos.addScaledVector(right, sp); moveInput = true; }
        if (moveInput) state.target = null;
        if (state.target) {
          const to = state.target;
          const flat = new THREE.Vector3(to.x - state.pos.x, 0, to.z - state.pos.z);
          const d = flat.length();
          if (d < 0.15) state.target = null;
          else {
            flat.normalize();
            const step = Math.min(d, Math.max(4, d * 2.2) * dt);
            state.pos.x += flat.x * step; state.pos.z += flat.z * step;
            // 走的时候把头转向前进方向(轻微)
            const wantYaw = Math.atan2(flat.x, flat.z);
            state.yaw = dampAngle(state.yaw, wantYaw, 4, dt);
          }
        }
        // 软约束在别墅范围内
        state.pos.x = clamp(state.pos.x, model.bounds.x0 + 0.35, model.bounds.x1 - 0.35);
        state.pos.z = clamp(state.pos.z, model.bounds.z0 + 0.35, model.bounds.z1 - 0.35);
        state.pos.y = eyeY();
      }
      camera.position.copy(state.pos);
      const dir = new THREE.Vector3(
        Math.sin(state.yaw) * Math.cos(state.pitch),
        Math.sin(state.pitch),
        Math.cos(state.yaw) * Math.cos(state.pitch),
      );
      camera.lookAt(camera.position.clone().add(dir));
    }

    updateLabels();
    // Spark 在某些 webview 里不会自动把排序结果的实例数写回几何体(instanceCount 卡在 0,
    // 于是一个点都不画)。这里每帧兜底成"活跃 splat 数",它本来就该是这个值 —— 会自动
    // 更新的环境里等价、不会更新的环境里救命。必须在 render 之前设。
    if (spark.geometry && spark.activeSplats) spark.geometry.instanceCount = spark.activeSplats;
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H());
  });

  function setHud(msg) {
    if (!hud) return;
    if (msg) { hud.textContent = msg; return; }
    if (state.mode === 'exterior') hud.innerHTML = `<b>${escapeHtml(model.title)}</b> · ${model.rooms.length} 个房间 / ${model.files} 文件 · <span style="opacity:.7">点击房子进入 · 拖拽环视 · 滚轮远近</span>`;
    else hud.innerHTML = `<b>${escapeHtml(model.title)}</b> · 楼层 ${state.floor + 1}/${model.bounds.floors} · <span style="opacity:.7">点地面走过去 · 拖拽转头 · WASD · 滚轮前后</span>`;
  }
  setHud();

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function dampAngle(a, b, lambda, dt) {
    let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * (1 - Math.exp(-lambda * dt));
  }

  return {
    model, scene, camera, renderer, spark,
    enter, exit, gotoFloor,
    dispose() { renderer.setAnimationLoop(null); renderer.dispose(); el.remove(); labelLayer.remove(); },
    numSplats: () => interiorPacked.numSplats + exteriorPacked.numSplats,
    _state: state,
  };
}

/* 屋外的地平 + 一层薄雾星尘,别让外观飘在纯黑里。 */
function addGround(scene, model) {
  const g = new THREE.CircleGeometry(300, 48);
  const m = new THREE.MeshBasicMaterial({ color: 0x0a0d14 });
  const ground = new THREE.Mesh(g, m);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
  scene.add(ground);
  // 网格微光
  const grid = new THREE.GridHelper(240, 60, 0x1a2438, 0x111826);
  grid.position.y = -0.04; grid.material.opacity = 0.5; grid.material.transparent = true;
  scene.add(grid);
}
