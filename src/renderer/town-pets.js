/**
 * town-pets.js — 每个人的 agent 在镇上的身子:一只跟着你走的小伙伴。
 *
 *   身子、步态、光雾全沿用 town-life.js 那一套(同样的模板点云 + 顶点着色器里甩腿),
 *   区别只有两点:它不归 sim 管(sim 里的猫狗是镇上的野物,数量和位置在开局就定死了),
 *   而它是**按人来的** —— 你一只,镇上每个活人各一只。
 *
 * ⚠ 长相完全由**身份哈希**推出来,一个字节都不用同步:
 *   品种、毛色、名字都是 hash(identity) 的函数,所以你看见别人的狗,
 *   和他自己看见的是同一只。加一个外观字段就要改服务器、改协议、改手机端 —— 不值得。
 *
 *   头顶那颗光点是**它接的是哪个 agent**(Claude 橙、Codex 灰绿、Cursor 蓝……),
 *   这个是要同步的,但别人的 agent 种类还没进在线状态里,所以现在一律是灰的。
 */
import * as THREE from 'three';
import { LIFE_SPECIES, bakeLifeTemplate, LIFE_VS, LIFE_FS } from './town-life.js';
import { SPECIES } from './town-life-sim.js';   // 走多快、步子多长、转身多快(身子在 LIFE_SPECIES,速度在这儿)
import { BREEDS, AGENT_COLOURS, petLook } from './town-pet-look.mjs';

export { AGENT_COLOURS, petLook };

/* 最多画几只:自己 1 + 在场的人 24(和 town-scene 的 MAXP 对齐) */
export const MAX_PETS = 25;

/* 头顶那颗光点:一只一个点,亮芯柔边,离得远了淡掉。 */
const ORB_VS = `
attribute vec3 aCol;
attribute float aPulse, aScale;   // 忙不忙 · 放大多少(拖文件悬停在它身上时变大)
uniform float uTime, uPx, uNight;
varying vec3 vC; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  if (position.y < -500.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  /* 呼吸:闲着慢,忙起来快 —— 不用看对话框也知道它在干活 */
  float pulse = 0.72 + 0.28 * sin(uTime * (1.2 + aPulse * 5.0));
  gl_PointSize = clamp(0.9 * aScale * uPx / max(d, 0.3), 5.0, 40.0 * aScale);   // 0.22 实测在 3 米外只剩一两个像素
  vC = aCol * (0.85 + 0.5 * uNight);
  vA = pulse * (1.0 - smoothstep(40.0, 90.0, d));
  gl_Position = projectionMatrix * mv;
}`;
const ORB_FS = `
precision highp float;
varying vec3 vC; varying float vA;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  /* 亮芯 + 一圈柔边。⚠ 不用加色混合:灰的"还没接 agent"加在灰天上等于没画(实测看不见) */
  float core = 1.0 - smoothstep(0.02, 0.09, r2);
  gl_FragColor = vec4(mix(vC, vec3(1.0), core * 0.55), vA * (0.35 + 0.65 * core) * (1.0 - r2 * 4.0));
}`;

/* 姿势号跟 town-life-sim 的 ST 对齐(着色器按它摆腿) */
const ST_IDLE = 0, ST_SIT = 7, ST_FOLLOW = 14;

/**
 * @param {object} U    小镇的公共 uniform(town-scene 的 makeUniforms)
 * @param {object} opts { identity, budget, resolve(x,z,r) }
 */
export function createPets(U, opts = {}) {
  const group = new THREE.Group();
  group.name = 'town-pets';
  const resolve = opts.resolve || ((x, z) => ({ x, z }));
  const detail = 0.55 + 0.45 * Math.max(0.25, Math.min(1, +opts.budget || 1));

  const shared = { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uFogA: U.uFogA, uFogB: U.uFogB,
    uFogAway: U.uFogAway, uSunDir: U.uSunDir, uSunCol: U.uSunCol, uSky: U.uSky, uExposure: U.uExposure };

  /* ── 一种身子一次 draw call,每种都留满 MAX_PETS 个位子(空位子 y = -1000,着色器直接丢掉) ── */
  const breeds = {};
  for (const kind of BREEDS) {
    const S = LIFE_SPECIES[kind];
    if (!S) continue;
    const t = S.build();
    if (S.legTint) for (const p of t.parts) if (p.part >= 2 && p.part <= 5) p.tint = true;
    // 比镇上的野物小一号:这是"你的"那只,不是路边那条
    const scale = S.s * 0.88;
    const T = bakeLifeTemplate(t.parts, Math.max(24, Math.round(S.n * detail)), scale);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(T.pos, 3));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(T.piv, 3));
    g.setAttribute('aNrm', new THREE.Float32BufferAttribute(T.nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(T.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(T.part, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(T.tint, 1));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(T.size, 1));
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PETS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PETS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PETS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const seed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PETS), 1).setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX_PETS; i++) pos.array[i * 4 + 1] = -1000;
    g.setAttribute('iPosYaw', pos);
    g.setAttribute('iAnim', anim);
    g.setAttribute('iTint', tint);
    g.setAttribute('iSeed', seed);
    g.instanceCount = MAX_PETS;
    const uniforms = Object.assign({}, shared, {
      uGait: { value: new THREE.Vector4(...S.gait) },
      uBody: { value: new THREE.Vector4((t.rear || 0) * scale, (t.leg || 0) * scale, 1, (S.sink || 0) * scale) },
      uWag: { value: new THREE.Vector2(...S.wag) },
    });
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader: LIFE_VS, fragmentShader: LIFE_FS,
      depthWrite: true, depthTest: true, transparent: false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.name = 'pet-' + kind;
    group.add(pts);
    breeds[kind] = { S, pos, anim, tint, seed, g, m, pts, used: 0 };
  }

  /* ── 头顶的光点 ── */
  const orbG = new THREE.BufferGeometry();
  const orbPos = new Float32Array(MAX_PETS * 3);
  const orbCol = new Float32Array(MAX_PETS * 3);
  const orbPulse = new Float32Array(MAX_PETS);
  const orbScale = new Float32Array(MAX_PETS).fill(1);
  for (let i = 0; i < MAX_PETS; i++) orbPos[i * 3 + 1] = -1000;
  orbG.setAttribute('position', new THREE.BufferAttribute(orbPos, 3).setUsage(THREE.DynamicDrawUsage));
  orbG.setAttribute('aCol', new THREE.BufferAttribute(orbCol, 3).setUsage(THREE.DynamicDrawUsage));
  orbG.setAttribute('aPulse', new THREE.BufferAttribute(orbPulse, 1).setUsage(THREE.DynamicDrawUsage));
  orbG.setAttribute('aScale', new THREE.BufferAttribute(orbScale, 1).setUsage(THREE.DynamicDrawUsage));
  const orbU = { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight };
  const orbM = new THREE.ShaderMaterial({ uniforms: orbU, vertexShader: ORB_VS, fragmentShader: ORB_FS,
    transparent: true, depthWrite: false });
  const orb = new THREE.Points(orbG, orbM);
  orb.frustumCulled = false;
  orb.name = 'pet-orbs';
  group.add(orb);

  /* ── 每只的状态 ── */
  const pets = new Map();          // key(身份) → pet
  let selfKey = opts.identity || 'me';
  let targetKey = null;            // 拖着的文件正悬在谁身上

  const tellMine = () => {
    if (!opts.onMine) return;
    const look = petLook(selfKey);
    try { opts.onMine({ id: selfKey, name: look.name, breed: look.breed }); } catch (e) {}
  };

  function makePet(key, owner) {
    const look = petLook(key);
    const p = {
      key, owner, look, breed: look.breed, name: look.name,
      x: owner.x, y: 0, z: owner.z, yaw: owner.yaw || 0,
      vx: 0, vz: 0, speed: 0, phase: look.seed, st: ST_IDLE, pitch: 0,
      sitAt: 0, agent: 'none', busy: 0, seen: 0,
    };
    pets.set(key, p);
    return p;
  }

  /* 主人的朝向:能给 yaw 就用 yaw,给不了就从走的方向推(和 sim 里对玩家的做法一样)。
     ⚠ 相机 yaw = 0 是看向 -z(three.js 的相机朝 -z),town-scene 的 stepOnce 往前走也是
     (-sin, -cos)。写成 (sin, cos) 狗就站到你**前面**去了,回头永远看不见它。 */
  function ownerHeading(o, p) {
    if (Number.isFinite(o.yaw)) return [-Math.sin(o.yaw), -Math.cos(o.yaw)];
    const dx = o.x - p.ox, dz = o.z - p.oz, d = Math.hypot(dx, dz);
    if (d > 0.05) { p.hx = dx / d; p.hz = dz / d; }
    return [p.hx || 0, p.hz || 1];
  }

  /* 跟人:站到主人身后 1.8 米。离远了跑,到了就坐下。 */
  function stepPet(p, dt, t) {
    p.lastT = t;
    const o = p.owner;
    const [hx, hz] = ownerHeading(o, p);
    p.ox = o.x; p.oz = o.z;
    let bx = o.x - hx * 1.8, bz = o.z - hz * 1.8;
    /* 要你(agent 在等你批准 / 回答):跑到你**面前**、冲你叫 —— 不用看屏幕角落的通知 */
    if (p.alert) { bx = o.x + hx * 1.6; bz = o.z + hz * 1.6; }
    /* 认识别的小伙伴:跑过去,挨着它站着(两个 agent 在房间里聊的时候) */
    const friend = p.meetKey && t < p.meetUntil ? pets.get(p.meetKey) : null;
    if (friend) { const a = Math.atan2(p.x - friend.x, p.z - friend.z); bx = friend.x + Math.sin(a) * 0.8; bz = friend.z + Math.cos(a) * 0.8; }
    else if (p.meetKey && t >= p.meetUntil) p.meetKey = null;
    const d = Math.hypot(bx - p.x, bz - p.z);
    const S = SPECIES[p.breed] || SPECIES.dog;
    const walk = S.walk, run = S.run;
    let tvx = 0, tvz = 0;
    /* 两道门槛:离位子 1.4 米才起身,走到 0.35 米以内才停 —— 只用一道的话,
       它会在门槛上来回抖;而门槛放宽到 1.1 米,又会停在离你快三米的地方。 */
    if (p.st === ST_FOLLOW ? d > 0.35 : d > 1.4) {
      // 太远了直接跑;快到了放慢(不然冲过头再掉头)
      const want = Math.min(d > 5 ? run * 0.8 : walk * 1.35, 0.6 + d * 1.6);
      tvx = (bx - p.x) / d * want; tvz = (bz - p.z) / d * want;
      p.st = ST_FOLLOW; p.pitch = 0; p.sitAt = t + 1.5;
    } else {
      // 到了:面朝主人,站一会儿就坐下
      p.st = p.alert || friend ? ST_IDLE : t > p.sitAt ? ST_SIT : ST_IDLE;
      // 叫:头一点一点;平时微微低头
      p.pitch = p.alert ? -0.35 + 0.3 * Math.max(0, Math.sin(t * 11)) : -0.12;
      const look = friend || o;
      const fx = look.x - p.x, fz = look.z - p.z, fd = Math.hypot(fx, fz);
      if (fd > 0.2) p.faceYaw = Math.atan2(fx, fz);
    }
    const k = Math.min(1, dt * 6);                       // 加速/刹车都软一点,不然是瞬移
    p.vx += (tvx - p.vx) * k; p.vz += (tvz - p.vz) * k;
    let nx = p.x + p.vx * dt, nz = p.z + p.vz * dt;
    const r = resolve(nx, nz, 0.3);                      // 别穿墙:和人走的是同一套碰撞
    nx = r.x; nz = r.z;
    let moved = Math.hypot(nx - p.x, nz - p.z);
    /* 卡住了就跳过去:它只会直线追,一口井、一个摊子就能把它钉在后面(实测:井边卡在 4.7 米外)。
       寻路要一整张导航网格;小伙伴本来就该"一下子蹿到你脚边",直接落到位子上更像它。
       两种情况:追了 1.5 秒几乎没挪窝,或者被甩开 14 米(主人瞬移、进出别墅)。 */
    if (p.st === ST_FOLLOW && dt > 0) {
      p.stuckT = moved < Math.hypot(tvx, tvz) * dt * 0.25 ? (p.stuckT || 0) + dt : 0;
      if (p.stuckT > 1.5 || d > 14) {
        const s = resolve(bx, bz, 0.3);
        nx = s.x; nz = s.z; p.vx = p.vz = 0; p.stuckT = 0; moved = 0;
        p.st = ST_IDLE; p.sitAt = t + 1.5;
      }
    }
    p.x = nx; p.z = nz;
    p.speed = dt > 0 ? moved / dt : 0;
    const stride = S.stride || 0.75;
    p.phase = (p.phase + moved / stride) % 1;            // 步子按走过的距离走,不按时间 —— 才不会原地划水
    const wantYaw = p.speed > 0.15 ? Math.atan2(p.vx, p.vz) : (p.faceYaw != null ? p.faceYaw : p.yaw);
    let dy = wantYaw - p.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    p.yaw += dy * Math.min(1, dt * (S.turn || 5));
  }

  /**
   * 镇上其他人:[{id, name, x, z, yaw}]。谁在场谁就有一只;人走了狗跟着消失。
   */
  function setPeers(list) {
    const now = (setPeers.tick = (setPeers.tick || 0) + 1);
    for (const q of list || []) {
      if (!q || q.id == null || q.id === selfKey) continue;
      let p = pets.get(q.id);
      if (!p) p = makePet(q.id, { x: q.x, z: q.z, yaw: q.yaw });
      p.owner.x = q.x; p.owner.z = q.z; p.owner.yaw = q.yaw;
      p.seen = now;
      p.agent = q.agent || q.a || 'none';
    }
    for (const [key, p] of pets) if (key !== selfKey && p.seen !== now) pets.delete(key);
  }

  /** 自己那只接的是哪个 agent(phase 2:接上了就不再是灰的) */
  function setAgent(kind, busy) {
    const p = pets.get(selfKey);
    if (!p) return;
    p.agent = kind || 'none';
    p.busy = Math.max(0, Math.min(1, +busy || 0));
  }

  function update(dt, t, self, env) {
    if (!(dt >= 0)) dt = 0;
    let me = pets.get(selfKey);
    if (!me) { me = makePet(selfKey, { x: self.x, z: self.z, yaw: self.yaw }); tellMine(); }
    me.owner.x = self.x; me.owner.z = self.z; me.owner.yaw = self.yaw;

    for (const B of Object.values(breeds)) B.used = 0;
    let n = 0;
    for (const p of pets.values()) {
      if (n >= MAX_PETS) break;
      stepPet(p, dt, t);
      const B = breeds[p.breed] || breeds.dog;
      if (!B || B.used >= MAX_PETS) continue;
      const i = B.used++, o = i * 4;
      const far = Math.hypot(p.x - self.x, p.z - self.z) > 160;
      B.pos.array[o] = p.x; B.pos.array[o + 1] = far ? -1000 : p.y; B.pos.array[o + 2] = p.z; B.pos.array[o + 3] = p.yaw;
      B.anim.array[o] = p.phase; B.anim.array[o + 1] = p.speed; B.anim.array[o + 2] = p.st; B.anim.array[o + 3] = p.pitch;
      B.tint.array[i * 3] = p.look.coat[0]; B.tint.array[i * 3 + 1] = p.look.coat[1]; B.tint.array[i * 3 + 2] = p.look.coat[2];
      B.seed.array[i] = p.look.seed;
      const c = AGENT_COLOURS[p.agent] || AGENT_COLOURS.none;
      orbPos[n * 3] = p.x; orbPos[n * 3 + 1] = far ? -1000 : p.y + 0.62; orbPos[n * 3 + 2] = p.z;
      orbCol[n * 3] = c[0]; orbCol[n * 3 + 1] = c[1]; orbCol[n * 3 + 2] = c[2];
      orbPulse[n] = p.alert ? 1 : p.busy;
      orbScale[n] = p.key === targetKey ? 2.2 : p.alert ? 1.5 : 1;
      n++;
    }
    // 没用到的位子推到天外
    for (const B of Object.values(breeds)) {
      for (let i = B.used; i < MAX_PETS; i++) B.pos.array[i * 4 + 1] = -1000;
      B.pos.needsUpdate = true; B.anim.needsUpdate = true; B.tint.needsUpdate = true; B.seed.needsUpdate = true;
    }
    for (let i = n; i < MAX_PETS; i++) orbPos[i * 3 + 1] = -1000;
    orbG.attributes.position.needsUpdate = true;
    orbG.attributes.aCol.needsUpdate = true;
    orbG.attributes.aPulse.needsUpdate = true;
    orbG.attributes.aScale.needsUpdate = true;
  }

  /** agent 要你了(提问 / 等批准):true 跑到面前叫,false 回到身后 */
  function setAlert(on) { const p = pets.get(selfKey); if (p) p.alert = !!on; }
  /** 让自己那只去挨着 key 那只待一会儿(秒) */
  function meet(key, secs = 20) {
    const p = pets.get(selfKey);
    if (!p || !pets.has(key)) return false;
    p.meetKey = key; p.meetUntil = (p.lastT || 0) + secs;
    return true;
  }
  /** 拖文件悬停:它的光点放大(null = 谁都不是) */
  function setTarget(key) { targetKey = key || null; }

  /** 离这儿最近的一只(给"跟它说话"用) */
  function nearest(x, z, r = 3) {
    let best = null, bd = r * r;
    for (const p of pets.values()) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function dispose() {
    for (const B of Object.values(breeds)) { B.g.dispose(); B.m.dispose(); }
    orbG.dispose(); orbM.dispose();
    group.clear();
    if (group.parent) group.parent.remove(group);
  }

  return {
    group, update, setPeers, setAgent, setAlert, meet, setTarget, nearest, dispose,
    mine: () => pets.get(selfKey) || null,
    all: () => Array.from(pets.values()),
    /** 换身份(服务器给的哈希 id 到了):自己那只换成那个 id 长的样子,并告诉外面(宿主的对话窗标题要跟着变) */
    setIdentity: (id) => {
      if (!id || id === selfKey) return;
      const me = pets.get(selfKey);
      pets.delete(selfKey); selfKey = id;
      if (me) { me.key = id; me.look = petLook(id); me.breed = me.look.breed; me.name = me.look.name; pets.set(id, me); }
      tellMine();
    },
  };
}
