/**
 * town-life-sim.js — 镇上的活物:牛羊马、鸡鸭鹅、猪、猫狗、麻雀鸽子、乌鸦、鹳、猫头鹰、燕子、蝙蝠、
 * 鹿、野兔、狐狸。只算"谁在哪、在干嘛",不碰 WebGL —— node 里测得了。
 *
 * 做法是游戏里那一套(Reynolds 的 steering + 一个小状态机),砍到几百只能在手机上跑:
 *   · 行为(想干嘛)每秒 10 次、按种子错开;离人 80 米以外的每秒 1 次 —— 远处看不出区别
 *   · 位置每帧积分:速度往"想要的速度"靠,转身有上限,步子按走过的距离算(脚不打滑)
 *   · 空闲 ↔ 溜达 ↔ 吃草 → 警觉 → 逃 → 空闲;天黑回圈(HOME)→ 看不见(HIDDEN),天亮再出来
 *   · 鸟是一群一个状态(地上 / 飞上房 / 绕塔 / 盘旋),飞的时候最多看 7 个邻居(均匀网格)
 *
 * 没有 Math.random:同一个种子、同一串输入,永远是同一群羊走同一条路。
 */
import { hash01, wallRadiusAt } from './town-plan.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angTo = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const approach = (v, to, k) => (v < to ? Math.min(to, v + k) : Math.max(to, v - k));

/* 状态号也是着色器里的姿势号(town-life.js 按它摆腿、收翅、坐下)。飞的三个挨着:9..11。 */
export const ST = {
  IDLE: 0, WANDER: 1, GRAZE: 2, ALERT: 3, FLEE: 4, HOME: 5, HIDDEN: 6, SIT: 7, SLEEP: 8,
  FLY: 9, CIRCLE: 10, GLIDE: 11, PERCH: 12, SWIM: 13, FOLLOW: 14, STALK: 15, PECK: 16, GROOM: 17, POUNCE: 18, HOP: 19,
};

/* 走多快(米/秒)、跑多快、身子多宽、人多近就跑、一步多长、转身多快、加速多快、吃草低多少头 */
export const SPECIES = {
  sheep: { walk: 0.8, run: 3.6, r: 0.45, flee: 7, stride: 0.9, turn: 3, acc: 3, graze: 0.95 },
  cow: { walk: 0.8, run: 2.8, r: 0.8, flee: 5, stride: 1.5, turn: 1.8, acc: 2, graze: 1.1 },
  horse: { walk: 1.2, run: 6, r: 0.65, flee: 6, stride: 1.9, turn: 2.2, acc: 2.5, graze: 1.9 },
  goat: { walk: 0.9, run: 4, r: 0.35, flee: 6, stride: 0.8, turn: 4, acc: 4, graze: 1.0 },
  pig: { walk: 0.7, run: 2.4, r: 0.4, flee: 2.5, stride: 0.6, turn: 2.5, acc: 3, graze: 0.7 },
  chicken: { walk: 0.5, run: 2.8, r: 0.15, flee: 2.5, stride: 0.2, turn: 8, acc: 8, graze: 0.8 },
  duck: { walk: 0.45, run: 1.8, r: 0.2, flee: 4, stride: 0.25, turn: 3, acc: 2, graze: 0.5 },
  goose: { walk: 0.6, run: 2.2, r: 0.3, flee: 3, stride: 0.35, turn: 3, acc: 3, graze: 0.9 },
  dog: { walk: 1.3, run: 5, r: 0.3, flee: 0, stride: 0.75, turn: 5, acc: 5, graze: 0.5 },
  cat: { walk: 0.6, run: 4, r: 0.15, flee: 2, stride: 0.35, turn: 6, acc: 7, graze: 0.4 },
  deer: { walk: 1, run: 8, r: 0.4, flee: 15, stride: 1.4, turn: 3, acc: 4, graze: 1.2 },
  rabbit: { walk: 0.6, run: 6, r: 0.12, flee: 12, stride: 0.55, turn: 7, acc: 8, graze: 0.4 },
  fox: { walk: 1.1, run: 6.5, r: 0.25, flee: 12, stride: 0.75, turn: 5, acc: 5, graze: 0.6 },
  sparrow: { walk: 0.4, run: 1, fly: 6, r: 0.06, flee: 4, stride: 0.12, turn: 10, acc: 6, graze: 0.6 },
  pigeon: { walk: 0.5, run: 1.2, fly: 8, r: 0.12, flee: 4, stride: 0.2, turn: 6, acc: 3.5, graze: 0.6 },
  rook: { walk: 0.6, run: 1.4, fly: 9, r: 0.18, flee: 8, stride: 0.25, turn: 5, acc: 2.5, graze: 0.6 },
  stork: { walk: 0.5, run: 1, fly: 9, r: 0.3, flee: 15, stride: 0.6, turn: 2, acc: 1.5, graze: 0.8 },
  owl: { walk: 0.3, run: 1, fly: 7, r: 0.15, flee: 0, stride: 0.2, turn: 3, acc: 2, graze: 0 },
  swallow: { walk: 0, run: 10, fly: 10, r: 0.05, flee: 0, stride: 1, turn: 20, acc: 10, graze: 0 },
  bat: { walk: 0, run: 6, fly: 6, r: 0.05, flee: 0, stride: 1, turn: 20, acc: 10, graze: 0 },
};
const HERD_N = { sheep: [12, 25], cow: [5, 10], horse: [3, 6], goat: [4, 8] };
const HERD_SPREAD = { sheep: 5, cow: 9, horse: 11, goat: 7 };

function rng(seed) {
  let s = (hash01(seed) * 4294967296) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * 此刻谁该出来。env 是 room-sky 的 envAt(),缺字段就按正午晴天算(测试里少写几个)。
 */
export function lifeFlags(env = {}) {
  const fx = env.fx || {};
  const h = Number.isFinite(env.hour) ? env.hour : 12;
  const n = Number.isFinite(env.night) ? env.night : (h < 5.5 || h > 20.5 ? 1 : 0);
  const season = env.season || 'summer';
  const warm = season === 'spring' || season === 'summer', winter = season === 'winter';
  const rain = Math.max(fx.rain || 0, env.weather === 'storm' ? 1 : env.weather === 'rain' ? 0.6 : 0);
  const snow = Math.max(fx.snow || 0, env.weather === 'snow' ? 1 : 0) > 0.2;
  const dawn = h >= 4.5 && h < 9, dusk = h >= 17.5 && h < 22;
  return {
    hour: h, night: n, season, rain, snow, wet: rain > 0.3, dawn, dusk, winter, wind: fx.wind || 0,
    day: n < 0.6,
    livestock: h >= 6.5 && h < 19.5 && n <= 0.6,
    chickens: h >= 6 && h < 20 && n < 0.6 && rain < 0.6,       // 鸡天一黑就上架
    pigs: h >= 7 && h < 19.5 && n < 0.6,
    geese: n < 0.7,
    cats: rain < 0.5,                                           // 猫最怕淋
    birds: n < 0.7,
    wild: dawn || dusk,                                         // 鹿和兔子:晨昏才出林子
    fox: (h >= 17 || h < 7) && n > 0.3,
    owl: n > 0.6,
    bats: n >= 0.4 && (h >= 12 || h < 6) && !winter && !snow && rain < 0.4,  // 日落后二十几分钟
    storks: warm && n < 0.6 && !snow,
    swallows: warm && n < 0.3 && rain < 0.3 && !snow,
    rooksCircle: dawn || dusk || (winter && (h * 2) % 1 < 0.35),   // 冬天隔一阵绕一阵
    bees: warm && n < 0.25 && rain === 0 && !snow,
    butterflies: warm && n < 0.25 && rain === 0 && !snow && (fx.wind || 0) < 0.6,
    moths: n > 0.5 && !winter && !snow && rain < 0.3,
    fish: !(winter && snow),
  };
}

/**
 * @param plan  planTown() 的结果(要 plan.world)
 * @param opts  budget 0.25..1 · seed · perches [{x,y,z}] · lamps [{x,y,z}] · resolve(x,z,r) → {x,z}
 */
export function createSim(plan, opts = {}) {
  const B = clamp(Number.isFinite(+opts.budget) && +opts.budget > 0 ? +opts.budget : 1, 0.25, 1);
  const rand = rng(String(opts.seed || 'terse-town') + ':life');
  const W = plan && plan.world;
  const resolve = typeof opts.resolve === 'function' ? opts.resolve : null;
  const all = [], herds = [], flocks = [];
  const P = { x: 0, z: 0, hx: 0, hz: 1 };
  let started = false, bell = false, havePlayer = false;
  const sim = { creatures: all, herds, flocks, flags: lifeFlags({}), step, ring() { bell = true; }, near, counts,
    isWater: () => false, perches: [], anchors: { flowers: [], lamps: [], stream: [] } };
  if (!W) return sim;
  const count = (lo, hi) => Math.max(1, Math.round((lo + rand() * (hi - lo)) * B));

  /* ── 水:护城河(城门外是桥)和小河 ── */
  const moat = W.moat, stream = W.stream, gates = (W.wall && W.wall.gates) || [];
  const sp = stream.pts;
  const sb = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
  for (const p of sp) { sb.x0 = Math.min(sb.x0, p[0]); sb.x1 = Math.max(sb.x1, p[0]); sb.z0 = Math.min(sb.z0, p[1]); sb.z1 = Math.max(sb.z1, p[1]); }
  function streamDist(x, z) {
    let d2 = 1e18;
    for (let i = 0; i + 1 < sp.length; i++) {
      const ax = sp[i][0], az = sp[i][1], ex = sp[i + 1][0] - ax, ez = sp[i + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / L2, 0, 1);
      const dx = x - ax - ex * t, dz = z - az - ez * t, q = dx * dx + dz * dz;
      if (q < d2) d2 = q;
    }
    return Math.sqrt(d2);
  }
  /** m = 岸边再留多宽(撒点的时候别贴着水) */
  function isWater(x, z, m = 0) {
    const r = Math.hypot(x, z);
    if (r > moat.r0 - m && r < moat.r1 + m) {
      const a = Math.atan2(z, x);
      let bridge = false;
      for (const g of gates) if (Math.abs(angTo(a, g.a)) * r < g.w / 2 + 1.2) { bridge = true; break; }
      if (!bridge) return true;
    }
    const k = stream.w / 2 + m;
    if (x < sb.x0 - k || x > sb.x1 + k || z < sb.z0 - k || z > sb.z1 + k) return false;
    return streamDist(x, z) < k;
  }
  sim.isWater = (x, z) => isWater(x, z);
  const dry = (x, z) => !isWater(x, z, 1.5);
  const wallAt = (a) => wallRadiusAt(W, a);
  const capR = W.forest.r0 + 20;                     // 地上的动物不进深林
  const inDisc = (cx, cz, r, ok = dry, tries = 24) => {
    for (let i = 0; i < tries; i++) {
      const a = rand() * TAU, d = Math.sqrt(rand()) * r, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!ok || ok(x, z)) return { x, z };
    }
    return null;
  };
  const townFree = (x, z) => {
    if (Math.hypot(x, z) > wallAt(Math.atan2(z, x)) - 3) return false;
    if (!resolve) return true;
    const p = resolve(x, z, 0.25);
    return Math.abs(p.x - x) + Math.abs(p.z - z) < 0.01;
  };

  /* ── 能落脚的高处:屋脊、教堂、谷仓 ── */
  const roofs = (opts.perches && opts.perches.length ? opts.perches
    : plan.plots.map((p) => ({ x: p.cx, y: p.h + Math.min(p.w || 6, p.d || 6) * 0.35, z: p.cz })))
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).map((p) => ({ x: p.x, y: p.y, z: p.z }));
  const ch = W.church;
  const tower = ch ? { x: ch.tower.x, y: ch.tower.h + 0.3, z: ch.tower.z } : null;
  let churchPerch = null;
  if (ch) {
    for (const p of roofs) if (Math.hypot(p.x - ch.x, p.z - ch.z) < 14 && p.y <= ch.tower.h + 1 && (!churchPerch || p.y > churchPerch.y)) churchPerch = p;
    churchPerch = churchPerch || { x: ch.x + ch.fx * ch.d * 0.25, y: 10, z: ch.z + ch.fz * ch.d * 0.25 };
  }
  const barnPerches = W.pastures.map((pa) => ({ x: pa.barn.x, y: 4.2, z: pa.barn.z }));
  sim.perches = roofs;
  const nearestPerch = (x, z, maxD = 60, maxY = 1e9, list = roofs) => {
    let best = null, bd = maxD;
    for (const p of list) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd && p.y <= maxY) { bd = d; best = p; } }
    return best;
  };

  /* ── 造一只 ── */
  function mk(kind, x, z, extra) {
    const c = Object.assign({
      id: all.length, kind, sp: SPECIES[kind], role: kind, x, y: 0, z, yaw: rand() * TAU,
      vx: 0, vy: 0, vz: 0, dvx: 0, dvy: 0, dvz: 0, sx: 0, sy: 0, sz: 0,
      seek: false, tx: x, ty: 0, tz: z, max: 0, slow: 1, cruise: 0,
      speed: 0, phase: rand(), st: ST.IDLE, pitch: 0, face: null, hidden: false, air: false,
      seed: rand(), timer: 0, next: rand() * 0.1, stuck: 0, homeT: 0, wake: 0,
      ring: null, town: false, lap: 0, la: 0, cr: 0, ch: 0, cc: null, circ: false,
    }, extra);
    all.push(c);
    return c;
  }
  const goTo = (c, x, z, max, slow = 1, y) => {
    c.seek = true; c.tx = x; c.tz = z; c.max = max; c.slow = slow;
    if (y != null) { c.ty = y; c.cruise = Math.max(y, Math.min(c.y, y) + 3.5); }
  };
  const setVel = (c, vx, vz, vy = 0) => { c.seek = false; c.dvx = vx; c.dvz = vz; c.dvy = vy; };
  const stop = (c) => setVel(c, 0, 0, 0);
  const fleeFrom = (c, x, z, speed) => {
    const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz) || 1;
    setVel(c, dx / d * speed, dz / d * speed);
    c.face = null;
  };
  const faceTo = (c, x, z) => { c.face = Math.atan2(x - c.x, z - c.z); };
  function hide(c) {
    c.hidden = true; c.st = ST.HIDDEN; c.homeT = 0; c.wake = 0;
    c.vx = c.vy = c.vz = 0; stop(c); c.speed = 0; c.sx = c.sy = c.sz = 0;
  }
  const dist3 = (c, x, y, z) => Math.hypot(c.x - x, c.y - y, c.z - z);

  /* ═══ 牲口:牧场里一群一群 ═══ */
  for (const pa of W.pastures) {
    const [lo, hi] = HERD_N[pa.kind] || [4, 8];
    const ring = { x: pa.x, z: pa.z, r: Math.max(5, pa.r) };
    const H = { kind: pa.kind, pasture: pa, ring, members: [], cx: pa.x, cz: pa.z, alarm: 0, ax: 0, az: 0, spread: HERD_SPREAD[pa.kind] || 6 };
    const n = count(lo, hi);
    for (let i = 0; i < n; i++) {
      const p = inDisc(ring.x, ring.z, ring.r * 0.7) || inDisc(ring.x, ring.z, ring.r - 1);
      if (!p) continue;
      H.members.push(mk(pa.kind, p.x, p.z, { role: 'herd', herd: H, ring, st: ST.GRAZE }));
    }
    if (H.members.length) herds.push(H);
  }

  /* ═══ 鸡:有鸡窝的后院 ═══ */
  const coops = W.yards.filter((y) => y.coop).slice(0, Math.max(1, Math.round(10 * B)));
  for (const y of coops) {
    const ring = { x: y.x, z: y.z, r: clamp(Math.max(y.w || 4, y.d || 4) / 2 + 1, 2, 4) };
    const n = count(4, 8);
    for (let i = 0; i < n; i++) {
      const p = inDisc(ring.x, ring.z, ring.r * 0.8, null);
      mk('chicken', p.x, p.z, { role: 'chicken', ring, coop: { x: y.x, z: y.z }, town: true, st: ST.PECK });
    }
  }

  /* ═══ 鸭子在水上,鹅在岸上排成一串 ═══ */
  {
    const spots = [];
    // 小河出城那一段(太远的在林子里,看不见也不管)
    for (let k = 3; k < sp.length - 3; k++) if (Math.hypot(sp[k][0], sp[k][1]) < W.forest.r0 - 10) spots.push({ x: sp[k][0], z: sp[k][1] });
    const mr = (moat.r0 + moat.r1) / 2;
    for (let tries = 0; tries < 20; tries++) {
      const a = rand() * TAU, x = Math.cos(a) * mr, z = Math.sin(a) * mr;
      if (isWater(x, z) && isWater(x, z, -1.5)) { spots.unshift({ x, z }); break; }
    }
    const groups = Math.min(2, spots.length);
    for (let g = 0; g < groups; g++) {
      const home = g === 0 ? spots[0] : spots[1 + Math.floor(rand() * (spots.length - 1))];
      const n = count(3, 6);
      for (let i = 0; i < n; i++) {
        const p = inDisc(home.x, home.z, 3, (x, z) => isWater(x, z, -0.4)) || home;
        mk('duck', p.x, p.z, { role: 'duck', home, st: ST.SWIM });
      }
    }
    // 岸:河沿一侧往外 w/2 + 2.2 米,连成一条能走的线
    const bank = [];
    for (let k = 2; k < sp.length - 1; k++) {
      const a = sp[k - 1], b = sp[k + 1], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1;
      const x = sp[k][0] - ez / L * (stream.w / 2 + 2.2), z = sp[k][1] + ex / L * (stream.w / 2 + 2.2);
      if (Math.hypot(x, z) > W.forest.r0 - 5 || isWater(x, z, 0.6)) { if (bank.length > 3) break; bank.length = 0; continue; }
      bank.push({ x, z });
    }
    if (bank.length >= 3) {
      const n = count(3, 6);
      let prev = null;
      const k0 = Math.floor(rand() * (bank.length - 1));
      for (let i = 0; i < n; i++) {
        const b = bank[k0];
        prev = mk('goose', b.x - i * 0.3, b.z, { role: 'goose', bank, pi: k0, dir: 1, lead: prev, home: bank[0], st: ST.WANDER });
      }
    }
  }

  /* ═══ 镇里:猪、狗、猫 ═══ */
  const doors = plan.plots.map((p) => p.door).filter(Boolean);
  const townSpots = doors.concat((plan.plazas || []).map((q) => ({ x: q.cx, z: q.cz })));
  const pickTown = (x, z, within = 70) => {
    for (let i = 0; i < 8; i++) {
      const q = townSpots[Math.floor(rand() * townSpots.length)];
      if (Math.hypot(q.x - x, q.z - z) < within && townFree(q.x, q.z)) return q;
    }
    return townSpots.length ? townSpots[Math.floor(rand() * townSpots.length)] : { x, z };
  };
  if (doors.length) {
    for (let i = 0, n = count(1, 3); i < n; i++) {
      const d = doors[Math.floor(rand() * doors.length)];
      mk('pig', d.x, d.z, { role: 'pig', town: true, sty: { x: d.x, z: d.z }, st: ST.WANDER });
    }
    for (let i = 0, n = count(2, 4); i < n; i++) {
      const s = i === 0 ? plan.spawn : doors[Math.floor(rand() * doors.length)];
      mk('dog', s.x + 1.5, s.z - 1.5, { role: 'dog', town: true, follower: i === 0, st: ST.IDLE });
    }
    const nCat = Math.min(20, Math.round(plan.plots.length / 4 * B));
    for (let i = 0; i < nCat; i++) {
      const d = doors[Math.floor(rand() * doors.length)];
      mk('cat', d.x, d.z, { role: 'cat', town: true, den: d, st: ST.SIT, perch: null, climb: false, prey: null });
    }
  }

  /* ═══ 林子边:鹿、野兔、狐狸 ═══ */
  const wildAt = (avoid) => {
    for (let i = 0; i < 30; i++) {
      const a = rand() * TAU, r = W.forest.r0 - 14, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (streamDist(x, z) > 45 && avoid.every((q) => Math.hypot(q.x - x, q.z - z) > 60)) return { x, z, a };
    }
    return null;
  };
  const wz = wildAt([]);
  if (wz) {
    const ring = { x: wz.x, z: wz.z, r: 22 };
    const H = { kind: 'deer', ring, members: [], cx: wz.x, cz: wz.z, alarm: 0, ax: 0, az: 0, spread: 8,
      den: { x: Math.cos(wz.a) * (W.forest.r0 + 12), z: Math.sin(wz.a) * (W.forest.r0 + 12) } };
    for (let i = 0, n = count(2, 5); i < n; i++) {
      const p = inDisc(ring.x, ring.z, ring.r * 0.6);
      if (p) H.members.push(mk('deer', p.x, p.z, { role: 'deer', herd: H, ring, st: ST.GRAZE }));
    }
    if (H.members.length) herds.push(H);
  }
  const wr = wildAt(wz ? [wz] : []);
  if (wr) {
    const ring = { x: wr.x, z: wr.z, r: 16 };
    for (let i = 0, n = count(3, 10); i < n; i++) {
      const b = inDisc(ring.x, ring.z, 10);
      if (b) mk('rabbit', b.x, b.z, { role: 'rabbit', ring, burrow: b, burrowT: 0, st: ST.GRAZE });
    }
    const den = { x: Math.cos(wr.a + 0.08) * (W.forest.r0 + 10), z: Math.sin(wr.a + 0.08) * (W.forest.r0 + 10) };
    mk('fox', den.x, den.z, { role: 'fox', ring: { x: wr.x, z: wr.z, r: 34 }, den, st: ST.WANDER, chase: null, rest: 0 });
  }

  /* ═══ 鸟群 ═══ */
  function addFlock(kind, n, home, perch, extra = {}) {
    const f = Object.assign({ kind, home, perch, members: [], mode: 'ground', until: 0, next: 0, scared: 0 }, extra);
    for (let i = 0; i < n; i++) {
      const p = inDisc(home.x, home.z, home.r, home.town ? null : dry) || home;
      f.members.push(mk(kind, p.x, p.z, { role: 'bird', flock: f, ring: home, town: !!home.town,
        ox: (rand() - 0.5) * 3, oz: (rand() - 0.5) * 1.2, st: ST.PECK }));
    }
    flocks.push(f);
    return f;
  }
  const perchNear = (h, fallbackY = 6) => nearestPerch(h.x, h.z, 40, 14) || { x: h.x + 4, y: fallbackY, z: h.z + 4 };
  const mk_ = W.market;
  if (mk_) {
    const home = { x: mk_.x, z: mk_.z, r: Math.max(3, mk_.r * 0.6), town: true };
    addFlock('sparrow', count(5, 20), home, perchNear(home));
  }
  for (const y of W.yards.filter((q) => q.tree || q.coop).slice(0, 2)) {
    const home = { x: y.x, z: y.z, r: 2.5, town: true };
    addFlock('sparrow', count(5, 12), home, perchNear(home));
  }
  if (ch) {
    const home = { x: ch.x - ch.fx * (ch.d / 2 + 4), z: ch.z - ch.fz * (ch.d / 2 + 4), r: 3.5, town: true };
    addFlock('pigeon', count(6, 18), home, churchPerch, { circle: tower });
  }
  if (mk_) {
    const home = { x: mk_.x + 2, z: mk_.z - 2, r: Math.max(3, mk_.r * 0.5), town: true };
    addFlock('pigeon', count(4, 12), home, ch ? churchPerch : perchNear(home, 8), { circle: tower || { x: mk_.x, y: 12, z: mk_.z } });
  }
  // 乌鸦:林边的高树上,白天下到地里找吃的
  const rookAngles = W.pastures.length ? [W.pastures[0], W.pastures[Math.floor(W.pastures.length / 2)]] : [];
  for (const pa of rookAngles.slice(0, B < 0.5 ? 1 : 2)) {
    const a = Math.atan2(pa.z, pa.x);
    const tree = { x: Math.cos(a) * (W.forest.r0 + 4), y: 13, z: Math.sin(a) * (W.forest.r0 + 4) };
    let g = { x: Math.cos(a + 0.05) * (W.forest.r0 - 30), z: Math.sin(a + 0.05) * (W.forest.r0 - 30), r: 8 };
    if (!dry(g.x, g.z)) { const q = inDisc(g.x, g.z, 20); if (q) g = { x: q.x, z: q.z, r: 8 }; }
    addFlock('rook', count(20, 40), g, tree, { tree, mode: 'up' });
  }

  /* ═══ 一只一只的:鹳、猫头鹰、燕子、蝙蝠 ═══ */
  if (ch) {
    const nests = [churchPerch];
    const far = roofs.filter((p) => Math.hypot(p.x - ch.x, p.z - ch.z) > 30).sort((a, b) => b.y - a.y)[0];
    if (far && B >= 0.5) nests.push(far);
    for (const nest of nests) for (let i = 0; i < 2; i++) {
      mk('stork', nest.x + (i - 0.5) * 0.8, nest.z, { role: 'stork', nest: { x: nest.x + (i - 0.5) * 0.8, y: nest.y, z: nest.z }, air: true, y: nest.y, st: ST.PERCH, timer: 20 + rand() * 60 });
    }
  }
  {
    const list = [churchPerch, tower, ...barnPerches].filter(Boolean);
    if (list.length) mk('owl', list[0].x, list[0].z, { role: 'owl', perches: list, at: list[0], air: true, y: list[0].y, st: ST.PERCH });
  }
  const lamps = (opts.lamps || []).filter((l) => l && Number.isFinite(l.x));
  sim.anchors.lamps = lamps;
  sim.anchors.stream = sp.map((p) => ({ x: p[0], y: 0, z: p[1] }));
  sim.anchors.flowers = (opts.flowers || []).filter((f) => f && Number.isFinite(f.x));
  {
    const fly = [];
    for (let k = 7; k < Math.min(sp.length, 16); k++) fly.push({ x: sp[k][0], y: 1.6, z: sp[k][1] });
    for (const pa of W.pastures.slice(0, 3)) fly.push({ x: pa.x, y: 2, z: pa.z });
    for (let i = 0, n = count(8, 20); i < n && fly.length; i++) {
      const A = fly[Math.floor(rand() * fly.length)];
      mk('swallow', A.x, A.z, { role: 'path', A, w: 0.45 + rand() * 0.35, ax: 8 + rand() * 10, az: 4 + rand() * 6, rot: rand() * TAU, air: true, st: ST.FLY });
    }
    const batAt = lamps.slice(0, 24).map((l) => ({ x: l.x, y: (l.y || 3.6) + 2, z: l.z }));
    for (let k = 1; k < 5 && k < sp.length; k++) batAt.push({ x: sp[k][0], y: 3, z: sp[k][1] });
    if (mk_) batAt.push({ x: mk_.x, y: 5, z: mk_.z });
    for (let i = 0, n = count(6, 12); i < n && batAt.length; i++) {
      const A = batAt[Math.floor(rand() * batAt.length)];
      mk('bat', A.x, A.z, { role: 'path', A, w: 0.9 + rand() * 0.8, ax: 4 + rand() * 4, az: 0, rot: 0, air: true, st: ST.FLY });
    }
  }

  /* ═══ 行为 ═══ */
  const herdOn = (F) => F.livestock;
  const ROLES = {
    herd: {
      on: herdOn,
      home: (c) => ({ x: c.herd.pasture.barn.x + (c.seed - 0.5) * 2, z: c.herd.pasture.barn.z + (c.seed - 0.3) * 2 }),
      wake(c) {
        const b = ROLES.herd.home(c);
        c.x = b.x; c.z = b.z; c.ring = null;
        const p = inDisc(c.herd.ring.x, c.herd.ring.z, c.herd.ring.r * 0.6) || c.herd.ring;
        c.st = ST.WANDER; goTo(c, p.x, p.z, c.sp.walk); c.timer = 0;
      },
      think: thinkHerd,
    },
    deer: {
      on: (F) => F.wild,
      home: (c) => c.herd.den,
      wake(c) { c.x = c.herd.den.x; c.z = c.herd.den.z; c.ring = null; c.st = ST.WANDER; goTo(c, c.herd.cx, c.herd.cz, c.sp.walk); c.timer = 0; },
      think: thinkHerd,
    },
    chicken: {
      on: (F) => F.chickens,
      home: (c) => c.coop,
      wake(c) { c.x = c.coop.x; c.z = c.coop.z; c.st = ST.PECK; c.timer = 0; },
      think(c, t, F, dp) {
        if (dp < c.sp.flee) { c.st = ST.FLEE; fleeFrom(c, P.x, P.z, c.sp.run); c.pitch = 0; c.timer = t + 0.8 + c.seed; return; }
        if (t < c.timer) return;
        const r = rand();
        if (r < 0.55) { c.st = ST.PECK; stop(c); c.pitch = 0.4; c.timer = t + 1.5 + rand() * 3; }
        else {
          const p = inDisc(c.ring.x, c.ring.z, c.ring.r, null);
          const dash = r > 0.85;
          c.st = dash ? ST.FLEE : ST.WANDER; c.pitch = 0;
          goTo(c, p.x, p.z, dash ? c.sp.run * 0.7 : c.sp.walk, 0.4);
          c.timer = t + (dash ? 1.2 : 2 + rand() * 3);
        }
      },
    },
    duck: {
      on: () => true,
      think(c, t, F, dp) {
        c.pitch = 0;
        if (dp < c.sp.flee && F.day) { c.st = ST.SWIM; fleeFrom(c, P.x, P.z, c.sp.run); c.timer = t + 1.5; return; }
        if (t < c.timer) return;
        c.st = ST.SWIM;
        if (!F.day || rand() < 0.35) { stop(c); c.pitch = rand() < 0.5 ? 0.6 : 0; c.timer = t + 3 + rand() * 6; return; }  // 漂着、把头扎进水里
        const p = inDisc(c.home.x, c.home.z, 7, (x, z) => isWater(x, z, -0.4)) || c.home;
        goTo(c, p.x, p.z, c.sp.walk, 1.5);
        c.timer = t + 4 + rand() * 6;
      },
    },
    goose: {
      on: (F) => F.geese,
      home: (c) => c.home,
      wake(c) { c.x = c.home.x; c.z = c.home.z; c.pi = 0; c.dir = 1; c.timer = 0; },
      think(c, t, F, dp) {
        if (dp < c.sp.flee) { c.st = ST.ALERT; stop(c); faceTo(c, P.x, P.z); c.pitch = -0.4; c.timer = t + 1; return; }  // 鹅不跑,冲人伸脖子
        const L = c.lead;
        if (L && !L.hidden) {
          const bx = L.x - Math.sin(L.yaw) * 0.9, bz = L.z - Math.cos(L.yaw) * 0.9;
          const d = Math.hypot(bx - c.x, bz - c.z);
          c.face = null;
          if (d < 0.35) { stop(c); c.st = L.st === ST.GRAZE ? ST.GRAZE : ST.IDLE; c.pitch = L.st === ST.GRAZE ? c.sp.graze : 0; }
          else { c.st = ST.WANDER; c.pitch = 0; goTo(c, bx, bz, c.sp.walk * 1.6, 0.8); }
          return;
        }
        if (t < c.timer && c.st === ST.GRAZE) return;
        if (c.st === ST.GRAZE || rand() > 0.01) {
          const b = c.bank[c.pi];
          if (Math.hypot(b.x - c.x, b.z - c.z) < 1.2) {
            c.pi += c.dir;
            if (c.pi <= 0 || c.pi >= c.bank.length - 1) { c.pi = clamp(c.pi, 0, c.bank.length - 1); c.dir = -c.dir; }
          }
          const q = c.bank[c.pi];
          c.st = ST.WANDER; c.pitch = 0; c.face = null;
          goTo(c, q.x, q.z, c.sp.walk, 0.6);
        } else { c.st = ST.GRAZE; stop(c); c.pitch = c.sp.graze; c.timer = t + 3 + rand() * 5; }
      },
    },
    pig: {
      on: (F) => F.pigs,
      home: (c) => c.sty,
      wake(c) { c.x = c.sty.x; c.z = c.sty.z; c.timer = 0; },
      think(c, t, F, dp) {
        if (dp < c.sp.flee) { c.st = ST.FLEE; fleeFrom(c, P.x, P.z, c.sp.run); c.pitch = 0; c.timer = t + 1.5; return; }
        if (t < c.timer && c.stuck < 2) return;
        const r = rand();
        c.face = null; c.stuck = 0;
        if (r < 0.5) { const q = pickTown(c.x, c.z); c.st = ST.WANDER; c.pitch = 0.15; goTo(c, q.x, q.z, c.sp.walk, 1.5); c.timer = t + 10 + rand() * 15; }
        else if (r < 0.85) { c.st = ST.GRAZE; c.pitch = c.sp.graze; const a = c.yaw + (rand() - 0.5); setVel(c, Math.sin(a) * 0.12, Math.cos(a) * 0.12); c.timer = t + 4 + rand() * 8; }
        else { c.st = ST.IDLE; c.pitch = 0; stop(c); c.timer = t + 2 + rand() * 5; }
      },
    },
    dog: {
      on: () => true,
      think(c, t, F, dp) {
        const inTown = Math.hypot(P.x, P.z) < wallAt(Math.atan2(P.z, P.x)) - 2;
        if (c.follower && havePlayer && inTown && dp < 25) {
          const bx = P.x - P.hx * 2, bz = P.z - P.hz * 2;
          const d = Math.hypot(bx - c.x, bz - c.z);
          if (d > 1.2) { c.st = ST.FOLLOW; c.face = null; goTo(c, bx, bz, d > 6 ? c.sp.run * 0.8 : c.sp.walk * 1.3, 2.5); c.pitch = 0; c.timer = t + 4; }
          else { stop(c); faceTo(c, P.x, P.z); c.st = t > c.timer ? ST.SIT : ST.IDLE; c.pitch = -0.15; }
          return;
        }
        if (t < c.timer && c.stuck < 2) return;
        c.stuck = 0; c.face = null;
        if (!F.day) { stop(c); c.st = ST.SLEEP; c.pitch = 0.3; c.timer = t + 20 + rand() * 20; return; }
        const r = rand();
        if (r < 0.45) { const q = pickTown(c.x, c.z, 50); c.st = ST.WANDER; c.pitch = 0.25; goTo(c, q.x, q.z, c.sp.walk, 1.5); c.timer = t + 8 + rand() * 12; }
        else if (r < 0.75) { stop(c); c.st = ST.SIT; c.pitch = -0.1; c.timer = t + 4 + rand() * 8; }
        else if (r < 0.9) { stop(c); c.st = ST.SLEEP; c.pitch = 0.3; c.timer = t + 8 + rand() * 15; }
        else { stop(c); c.st = ST.IDLE; c.pitch = 0.4; c.timer = t + 2 + rand() * 3; }
      },
    },
    cat: {
      on: (F) => F.cats,
      home: (c) => c.den,
      wake(c) { c.x = c.den.x; c.z = c.den.z; c.y = 0; c.perch = null; c.climb = false; c.timer = 0; },
      think: thinkCat,
    },
    rabbit: {
      on: (F, c, t) => F.wild && t >= c.burrowT,
      home: (c) => c.burrow,
      wake(c) { c.x = c.burrow.x; c.z = c.burrow.z; c.st = ST.GRAZE; c.timer = 0; },
      think(c, t, F, dp) {
        const fox = foxOf;
        const fd = fox && !fox.hidden ? Math.hypot(fox.x - c.x, fox.z - c.z) : 1e9;
        if (dp < c.sp.flee || fd < 10 || c.st === ST.FLEE) {
          // 跑回洞里去,钻进去就看不见了(过一会儿再出来 —— 没有被吃掉这回事)
          c.st = ST.FLEE; c.pitch = 0; c.face = null;
          goTo(c, c.burrow.x, c.burrow.z, c.sp.run, 0.3);
          if (Math.hypot(c.burrow.x - c.x, c.burrow.z - c.z) < 0.6) { hide(c); c.burrowT = t + 30 + rand() * 60; }
          return;
        }
        if (dp < c.sp.flee * 1.6) { c.st = ST.ALERT; stop(c); faceTo(c, P.x, P.z); c.pitch = -0.3; return; }
        if (t < c.timer) return;
        c.face = null;
        if (rand() < 0.55) { c.st = ST.GRAZE; stop(c); c.pitch = c.sp.graze; c.timer = t + 2 + rand() * 5; }
        else { const p = inDisc(c.x, c.z, 2.5) || c; c.st = ST.HOP; c.pitch = 0; goTo(c, p.x, p.z, c.sp.walk * 2, 0.3); c.timer = t + 1.5 + rand() * 2; }
      },
    },
    fox: {
      on: (F) => F.fox,
      home: (c) => c.den,
      wake(c) { c.x = c.den.x; c.z = c.den.z; c.timer = 0; c.chase = null; },
      think(c, t, F, dp) {
        if (dp < c.sp.flee) { c.st = ST.FLEE; c.chase = null; c.pitch = 0; goTo(c, c.den.x, c.den.z, c.sp.run, 2); c.timer = t + 4; return; }
        if (c.st === ST.FLEE && t < c.timer) return;
        if (c.chase && (c.chase.hidden || t > c.rest)) { c.chase = null; c.rest = t + 25; }   // 钻洞了 / 追累了
        if (!c.chase && t > c.rest) {
          let best = null, bd = 30;
          for (const r of all) if (r.kind === 'rabbit' && !r.hidden) { const d = Math.hypot(r.x - c.x, r.z - c.z); if (d < bd) { bd = d; best = r; } }
          if (best) { c.chase = best; c.rest = t + 12; }
        }
        if (c.chase) {
          const d = Math.hypot(c.chase.x - c.x, c.chase.z - c.z);
          c.st = ST.STALK; c.pitch = 0.2; c.face = null;
          goTo(c, c.chase.x, c.chase.z, d > 8 ? c.sp.walk * 1.4 : c.sp.run * 0.85, 0.2);
          return;
        }
        if (t < c.timer) return;
        const p = inDisc(c.ring.x, c.ring.z, c.ring.r) || c.ring;
        if (rand() < 0.6) { c.st = ST.WANDER; c.pitch = 0.3; goTo(c, p.x, p.z, c.sp.walk, 1); c.timer = t + 6 + rand() * 8; }
        else { c.st = ST.SIT; stop(c); c.pitch = -0.1; c.timer = t + 3 + rand() * 6; }
      },
    },
    bird: {
      on: (F, c) => (c.kind === 'pigeon' ? true : c.kind === 'rook' ? F.birds || (F.rooksCircle && F.night < 0.85) : F.birds),
      home: (c) => ({ x: c.flock.perch.x + c.ox, y: c.flock.perch.y, z: c.flock.perch.z + c.oz }),
      wake(c) { const h = ROLES.bird.home(c); c.x = h.x; c.y = h.y; c.z = h.z; c.air = true; c.st = ST.PERCH; stop(c); },
      think: thinkBird,
    },
    stork: {
      on: (F) => F.storks,
      home: (c) => c.nest,
      wake(c) { Object.assign(c, { x: c.nest.x, y: c.nest.y, z: c.nest.z, air: true, st: ST.PERCH, timer: 0 }); stop(c); },
      think(c, t, F) {
        if (c.st === ST.PERCH) {
          stop(c); c.x = c.nest.x; c.y = c.nest.y; c.z = c.nest.z;
          c.pitch = Math.sin(t * 0.3 + c.seed * 9) > 0.8 ? -0.9 : 0.1;       // 仰头"打响板"
          if (t > c.timer && !F.wet) { c.st = ST.GLIDE; c.circ = true; c.cc = c.nest; c.cr = 28 + c.seed * 16; c.ch = c.nest.y + 12; c.lap = 0; c.la = Math.atan2(c.z - c.nest.z, c.x - c.nest.x); c.pitch = 0; }
          return;
        }
        if (c.st === ST.GLIDE && c.lap < TAU * 1.2 && !F.wet) return;
        c.st = ST.FLY; c.circ = false;
        goTo(c, c.nest.x, c.nest.z, c.sp.fly * 0.7, 4, c.nest.y);
        if (dist3(c, c.nest.x, c.nest.y, c.nest.z) < 0.4) { c.st = ST.PERCH; c.timer = t + 40 + rand() * 60; stop(c); }
      },
    },
    owl: {
      on: (F) => F.owl,
      home: (c) => c.at,
      wake(c) { Object.assign(c, { x: c.at.x, y: c.at.y, z: c.at.z, air: true, st: ST.PERCH, timer: t0 + 20 + c.seed * 30 }); stop(c); },
      think(c, t) {
        if (c.st === ST.PERCH) {
          stop(c);
          c.pitch = Math.sin(t * 0.2 + c.seed * 7) * 0.3;
          if (t > c.timer) {
            const opts2 = c.perches.filter((p) => p !== c.at && Math.hypot(p.x - c.x, p.z - c.z) < 90);
            if (opts2.length) { c.at = opts2[Math.floor(rand() * opts2.length)]; c.st = ST.GLIDE; c.circ = false; }
            else c.timer = t + 30;
          }
          return;
        }
        goTo(c, c.at.x, c.at.z, c.sp.fly, 4, c.at.y);
        if (dist3(c, c.at.x, c.at.y, c.at.z) < 0.4) { c.st = ST.PERCH; c.timer = t + 30 + rand() * 30; stop(c); }
      },
    },
  };
  let t0 = 0;
  const foxOf = all.find((c) => c.kind === 'fox') || null;

  function thinkHerd(c, t, F, dp) {
    const H = c.herd, s = c.sp, ring = H.ring;
    // 走进圈了才把圈套上(早上从谷仓出来,谷仓可能在圈外)
    const din = Math.hypot(c.x - ring.x, c.z - ring.z);
    if (!c.ring && din < ring.r - 0.5) c.ring = ring;
    if (dp < s.flee) { H.alarm = t + 3; H.ax = P.x; H.az = P.z; }
    // 一只惊了,一群都跑
    if (H.alarm > t && Math.hypot(c.x - H.ax, c.z - H.az) < s.flee * 2.2) {
      c.st = ST.FLEE; c.pitch = -0.15;
      fleeFrom(c, H.ax, H.az, s.run * (0.8 + 0.2 * c.seed));
      if (c.kind === 'deer') { const r = Math.hypot(c.x, c.z) || 1; c.dvx += c.x / r * s.run * 0.5; c.dvz += c.z / r * s.run * 0.5; }
      c.timer = t + 1 + c.seed * 2;
      social(c, H, F);
      return;
    }
    if (dp < s.flee * 1.7) { c.st = ST.ALERT; stop(c); faceTo(c, P.x, P.z); c.pitch = -0.25; c.timer = t + 1.5; social(c, H, F); return; }
    if (t >= c.timer || (c.seek && Math.hypot(c.tx - c.x, c.tz - c.z) < 0.4 && c.st === ST.WANDER)) {
      const r = rand();
      c.face = null;
      const grazeP = F.wet && c.kind === 'cow' ? 0.3 : 0.6;
      if (r < grazeP) {
        c.st = ST.GRAZE; c.pitch = s.graze;
        const a = c.yaw + (rand() - 0.5) * 1.2;
        setVel(c, Math.sin(a) * 0.12, Math.cos(a) * 0.12);
        c.timer = t + 5 + rand() * 12;
      } else if (r < grazeP + 0.25) {
        const p = inDisc(ring.x, ring.z, ring.r - 1) || ring;
        const tx = p.x + (H.cx - p.x) * 0.5, tz = p.z + (H.cz - p.z) * 0.5;
        c.st = ST.WANDER; c.pitch = 0.1;
        goTo(c, tx, tz, s.walk, 1.5);
        c.timer = t + 6 + rand() * 8;
      } else { c.st = ST.IDLE; c.pitch = 0; stop(c); c.timer = t + 2 + rand() * 5; }
    }
    social(c, H, F);
  }
  /* 别挤、别散、别出圈:算成一个"额外的速度",每帧加在想走的速度上 */
  function social(c, H, F) {
    const s = c.sp, minD = s.r * 2.6;
    let sx = 0, sz = 0;
    for (const o of H.members) {
      if (o === c || o.hidden) continue;
      const dx = c.x - o.x, dz = c.z - o.z, d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 1e-8) { const d = Math.sqrt(d2); sx += dx / d * (minD - d) / minD * 1.5; sz += dz / d * (minD - d) / minD * 1.5; }
    }
    const spread = H.spread * (F.wet && c.kind === 'cow' ? 0.3 : 1);      // 下雨牛挤成一堆
    const hx = H.cx - c.x, hz = H.cz - c.z, hd = Math.hypot(hx, hz);
    if (hd > spread) { const k = Math.min(1, (hd - spread) / spread) * (c.st === ST.FLEE ? 0.2 : 0.6); sx += hx / hd * k; sz += hz / hd * k; }
    const R = H.ring, rx = c.x - R.x, rz = c.z - R.z, rd = Math.hypot(rx, rz);
    if (c.ring && rd > R.r - 2.5) { const k = (rd - (R.r - 2.5)) * (c.st === ST.FLEE ? 1.2 : 0.5); sx -= rx / rd * k; sz -= rz / rd * k; }
    c.sx = sx * s.walk; c.sz = sz * s.walk;
  }

  function thinkCat(c, t, F, dp) {
    const s = c.sp;
    const act = F.dusk || F.night > 0.5 ? 1.7 : 1;                  // 黄昏猫最精神
    const up = c.y > 0.3;
    if (!up && dp < s.flee) { c.st = ST.FLEE; c.perch = null; c.climb = false; c.prey = null; fleeFrom(c, P.x, P.z, s.run); c.timer = t + 1; return; }
    if (c.st === ST.FLEE && t < c.timer) return;
    if (c.st === ST.POUNCE && t < c.timer) return;
    // 在房上:到了就坐下
    if (c.perch && c.climb && Math.abs(c.y - c.perch.y) < 0.05 && Math.hypot(c.perch.x - c.x, c.perch.z - c.z) < 0.35) {
      if (c.st === ST.WANDER) { c.st = ST.SIT; stop(c); c.timer = t + (6 + rand() * 12) / act; }
    }
    // 盯鸟:麻雀在地上啄的时候,慢慢摸过去,1.5 米内扑
    if (c.prey) {
      const b = c.prey;
      if (b.hidden || b.air || b.flock.mode !== 'ground') { c.prey = null; c.timer = 0; }
      else {
        const d = Math.hypot(b.x - c.x, b.z - c.z);
        if (d < 1.5) {
          c.st = ST.POUNCE; goTo(c, b.x, b.z, s.run, 0.1); c.timer = t + 0.5; c.prey = null;
          b.flock.scared = t + 6 + rand() * 4;
          return;
        }
        c.st = ST.STALK; c.pitch = 0.25; c.face = null;
        goTo(c, b.x, b.z, d > 5 ? 0.4 : 0.2, 0.5);
        return;
      }
    }
    if (!up && !c.perch && rand() < 0.04 * act) {
      for (const f of flocks) {
        if (f.kind !== 'sparrow' || f.mode !== 'ground') continue;
        for (const b of f.members) if (!b.hidden && !b.air && Math.hypot(b.x - c.x, b.z - c.z) < 10) { c.prey = b; return; }
      }
    }
    if (t < c.timer && c.stuck < 3) return;
    c.stuck = 0; c.face = null;
    const r = rand();
    if (up) {
      if (r < 0.5 / act) { c.st = r < 0.2 ? ST.SLEEP : r < 0.35 ? ST.GROOM : ST.SIT; stop(c); c.timer = t + (8 + rand() * 15) / act; return; }
      c.perch = null; c.climb = false;
      const q = pickTown(c.x, c.z, 25);
      c.st = ST.WANDER; c.pitch = 0; goTo(c, q.x, q.z, s.walk, 0.8); c.timer = t + 10;
      return;
    }
    if (r < 0.3 * act) {
      const pc = nearestPerch(c.x + (rand() - 0.5) * 30, c.z + (rand() - 0.5) * 30, 25, 14);
      if (pc) { c.perch = pc; c.climb = false; c.st = ST.WANDER; c.pitch = 0; goTo(c, pc.x, pc.z, s.walk, 0.4); c.timer = t + 25; return; }
    }
    if (r < 0.5) { c.st = ST.SIT; stop(c); c.pitch = -0.1; }
    else if (r < 0.65) { c.st = ST.GROOM; stop(c); c.pitch = 0.5; }
    else if (r < (act > 1 ? 0.72 : 0.85)) { c.st = ST.SLEEP; stop(c); c.pitch = 0.3; }
    else { const q = pickTown(c.x, c.z, 30); c.st = ST.WANDER; c.pitch = 0; goTo(c, q.x, q.z, s.walk * act, 1); }
    c.timer = t + (5 + rand() * 12) / act;
  }

  /* 鸟群:一群一个"心思",每只各自执行 */
  function flockStep(f, t, F) {
    if (t < f.next) return;
    f.next = t + 0.1;
    let near = 1e9, any = false;
    for (const m of f.members) if (!m.hidden) { any = true; if (!m.air) near = Math.min(near, Math.hypot(m.x - P.x, m.z - P.z)); }
    if (!any) return;
    const scare = f.kind === 'rook' ? 8 : 4;
    const shelter = F.wet || (f.kind === 'pigeon' && !F.day);
    if (f.mode === 'circle') {
      if (t > f.until || f.members.every((m) => m.hidden || m.lap > TAU)) { f.mode = 'up'; f.until = t + 4 + rand() * 4; }
      return;
    }
    if (f.kind === 'rook' && F.rooksCircle && !F.wet) { f.mode = 'orbit'; return; }
    if (f.mode === 'orbit') { f.mode = 'up'; f.until = t + 5; }
    const homeD = Math.hypot(f.home.x - P.x, f.home.z - P.z);
    if (f.mode === 'ground' && (near < scare || f.scared > t || shelter || !F.birds)) { f.mode = 'up'; f.until = t + 5 + rand() * 5; }
    else if (f.mode === 'up' && t > f.until && !shelter && F.birds && homeD > f.home.r + scare + 2 && f.scared <= t) f.mode = 'ground';
  }
  function thinkBird(c, t, F) {
    const f = c.flock, s = c.sp;
    if (f.mode === 'circle' || f.mode === 'orbit') {
      const C = f.mode === 'circle' ? f.circle : f.tree;
      // 敲钟那一圈只绕一次:绕完了(lap ≥ 2π)就别再进来
      if (c.st !== ST.CIRCLE && (f.mode === 'orbit' || c.lap === 0)) {
        c.st = ST.CIRCLE; c.air = true; c.lap = 0; c.cc = C; c.circ = true;
        c.la = Math.atan2(c.z - C.z, c.x - C.x);
        c.cr = (f.kind === 'rook' ? 18 : 9) * (0.8 + 0.5 * c.seed);
        c.ch = C.y + (f.kind === 'rook' ? 6 : 3) + c.seed * 6;
      }
      if (c.st === ST.CIRCLE && (f.mode === 'orbit' || c.lap < TAU)) return;
    }
    if (f.mode !== 'ground') {
      const px = f.perch.x + c.ox, py = f.perch.y, pz = f.perch.z + c.oz;
      if (c.st === ST.PERCH) { stop(c); if (rand() < 0.05) c.face = rand() * TAU; c.pitch = 0; return; }
      c.st = ST.FLY; c.air = true; c.circ = false; c.pitch = 0;
      goTo(c, px, pz, s.fly, 3, py);
      if (dist3(c, px, py, pz) < 0.35) { c.x = px; c.y = py; c.z = pz; c.st = ST.PERCH; stop(c); c.vx = c.vy = c.vz = 0; }
      return;
    }
    if (c.air) {
      if (c.gx == null || c.st !== ST.FLY) {
        const p = inDisc(f.home.x, f.home.z, f.home.r, f.home.town ? null : dry) || f.home;
        c.gx = p.x; c.gz = p.z;
      }
      c.st = ST.FLY; c.circ = false; c.pitch = 0;
      goTo(c, c.gx, c.gz, s.fly, 3, 0);
      if (dist3(c, c.gx, 0, c.gz) < 0.3) { c.air = false; c.y = 0; c.st = ST.PECK; stop(c); c.vx = c.vy = c.vz = 0; c.gx = null; c.timer = t + rand(); }
      return;
    }
    if (t < c.timer) return;
    c.face = null;
    if (rand() < 0.55) { c.st = ST.PECK; stop(c); c.pitch = 0.3; c.timer = t + 0.6 + rand() * 2; }
    else {
      const p = inDisc(c.x, c.z, 1, null);
      c.st = ST.HOP; c.pitch = 0;
      goTo(c, p.x, p.z, s.walk * 2.5, 0.2);
      c.timer = t + 0.3 + rand() * 0.6;
    }
  }

  /* 飞着的鸟看邻居:均匀网格,最多 7 个 */
  const grid = new Map();
  const CELL = 4;
  const gkey = (x, z) => ((Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096));
  function boids(c) {
    const s = c.sp;
    let n = 0, sx = 0, sy = 0, sz = 0, ax = 0, az = 0, cx = 0, cy = 0, cz = 0;
    const gx = Math.floor(c.x / CELL), gz = Math.floor(c.z / CELL);
    for (let i = -1; i <= 1 && n < 7; i++) for (let j = -1; j <= 1 && n < 7; j++) {
      const cellL = grid.get((gx + i + 4096) * 8192 + (gz + j + 4096));
      if (!cellL) continue;
      for (const o of cellL) {
        if (o === c) continue;
        const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 9 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        if (d < 1) { sx += dx / d * (1 - d); sy += dy / d * (1 - d); sz += dz / d * (1 - d); }
        ax += o.vx; az += o.vz; cx += o.x; cy += o.y; cz += o.z;
        if (++n >= 7) break;
      }
    }
    if (!n) { c.sx = c.sy = c.sz = 0; return; }
    c.sx = sx * s.fly * 0.6 + (ax / n - c.vx) * 0.15 + (cx / n - c.x) * 0.2;
    c.sy = sy * s.fly * 0.6 + (cy / n - c.y) * 0.2;
    c.sz = sz * s.fly * 0.6 + (az / n - c.vz) * 0.15 + (cz / n - c.z) * 0.2;
  }

  /* 燕子画 8 字,蝙蝠乱绕:位置直接按时间算 */
  function pathMove(c, dt, t, F) {
    const on = c.kind === 'bat' ? F.bats : F.swallows;
    if (!on) { if (!c.hidden) hide(c); return; }
    if (c.hidden) { c.hidden = false; c.st = ST.FLY; }
    const A = c.A, u = t * c.w + c.seed * 50;
    let x, y, z;
    if (c.kind === 'swallow') {
      const lx = Math.sin(u) * c.ax, lz = Math.sin(2 * u) * c.az;
      const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      x = A.x + lx * cs - lz * sn; z = A.z + lx * sn + lz * cs;
      y = A.y + Math.sin(u * 1.3 + c.seed * 9) * 0.8;
    } else {
      const r = c.ax;
      x = A.x + Math.sin(u) * r + Math.sin(u * 2.7 + c.seed * 20) * r * 0.4;
      z = A.z + Math.cos(u * 1.1) * r + Math.cos(u * 3.1 + c.seed * 11) * r * 0.35;
      y = A.y + Math.sin(u * 1.7) * 1.2;
    }
    const dx = x - c.x, dz = z - c.z;
    if (dt > 0) { c.vx = dx / dt; c.vy = (y - c.y) / dt; c.vz = dz / dt; }
    if (dx * dx + dz * dz > 1e-8) c.yaw = Math.atan2(dx, dz);
    c.x = x; c.y = y; c.z = z; c.speed = 1; c.st = c.vy < -0.5 && c.kind === 'swallow' ? ST.GLIDE : ST.FLY;
  }

  function move(c, dt, t) {
    const s = c.sp;
    if (c.air && c.st === ST.PERCH) { c.speed = 0; turn(c, dt, false); return; }
    // 绕圈:目标点一直在前面 0.6 弧度
    if (c.circ && (c.st === ST.CIRCLE || c.st === ST.GLIDE)) {
      const C = c.cc, a = Math.atan2(c.z - C.z, c.x - C.x);
      c.lap += Math.abs(angTo(c.la, a)); c.la = a;
      const ta = a + 0.6;
      c.seek = true; c.tx = C.x + Math.cos(ta) * c.cr; c.tz = C.z + Math.sin(ta) * c.cr;
      c.ty = c.cruise = c.ch + Math.sin(t * 0.5 + c.seed * 6) * 1.5;
      c.max = s.fly * (c.st === ST.GLIDE ? 0.6 : 0.8); c.slow = 0.5;
    }
    let dx, dy = 0, dz;
    if (c.seek) {
      const ex = c.tx - c.x, ez = c.tz - c.z;
      const hd = Math.hypot(ex, ez);
      const ey = c.air ? (hd > 3 ? c.cruise : c.ty) - c.y : 0;
      const d = Math.hypot(ex, ey, ez);
      const v = d < 1e-4 ? 0 : c.max * Math.min(1, d / c.slow);
      dx = d > 1e-4 ? ex / d * v : 0; dz = d > 1e-4 ? ez / d * v : 0;
      dy = d > 1e-4 ? clamp(ey / d * v * 1.5, -c.max * 0.7, c.max * 0.7) : 0;
    } else { dx = c.dvx; dy = c.dvy; dz = c.dvz; }
    dx += c.sx; dz += c.sz; if (c.air) dy += c.sy;
    const k = Math.min(1, dt * s.acc);
    c.vx += (dx - c.vx) * k; c.vz += (dz - c.vz) * k; c.vy = c.air ? c.vy + (dy - c.vy) * k : 0;
    const ox = c.x, oz = c.z;
    let nx = c.x + c.vx * dt, nz = c.z + c.vz * dt;
    if (c.air) {
      c.y = Math.max(0.05, c.y + c.vy * dt);
      c.x = nx; c.z = nz;
    } else {
      const duck = c.kind === 'duck';
      if (c.ring) {
        const rx = nx - c.ring.x, rz = nz - c.ring.z, rd = Math.hypot(rx, rz);
        if (rd > c.ring.r) { nx = c.ring.x + rx / rd * c.ring.r; nz = c.ring.z + rz / rd * c.ring.r; }
      }
      if (c.town) {
        const rr = Math.hypot(nx, nz), lim = wallAt(Math.atan2(nz, nx)) - 2;
        if (rr > lim) { nx *= lim / rr; nz *= lim / rr; }
        if (resolve && c.y < 0.3) { const p = resolve(nx, nz, s.r); nx = p.x; nz = p.z; }
      }
      const rr = Math.hypot(nx, nz);
      if (rr > capR) { nx *= capR / rr; nz *= capR / rr; }
      if (isWater(nx, nz) !== duck) {
        if (isWater(nx, c.z) === duck) nz = c.z;
        else if (isWater(c.x, nz) === duck) nx = c.x;
        else { nx = c.x; nz = c.z; }
      }
      c.x = nx; c.z = nz;
      if (c.kind === 'cat') catHeight(c, dt);
    }
    const moved = Math.hypot(c.x - ox, c.z - oz), want = Math.hypot(c.vx, c.vz) * dt;
    c.stuck = want > 0.002 && moved < want * 0.3 ? c.stuck + dt : Math.max(0, c.stuck - dt);
    c.phase = (c.phase + moved / s.stride) % 1;
    c.speed = Math.min(1, moved / Math.max(dt, 1e-4) / s.run);
    turn(c, dt, moved / Math.max(dt, 1e-4) > 0.06);
  }
  function turn(c, dt, moving) {
    let wy = null;
    if (moving) wy = Math.atan2(c.vx, c.vz);
    else if (c.face != null) wy = c.face;
    if (wy != null) c.yaw += clamp(angTo(c.yaw, wy), -c.sp.turn * dt, c.sp.turn * dt);
  }
  /* 猫上房:走到跟前(或者被墙挡住、离得不远)就往上爬;下来要等脚下是空地 */
  function catHeight(c, dt) {
    if (c.perch) {
      const hd = Math.hypot(c.perch.x - c.x, c.perch.z - c.z);
      if (!c.climb && (hd < 1 || (c.stuck > 0.8 && hd < 10))) c.climb = true;
      if (c.climb) c.y = approach(c.y, c.perch.y, 3 * dt);
    } else if (c.y > 0) {
      let free = true;
      if (resolve) { const p = resolve(c.x, c.z, c.sp.r); free = Math.abs(p.x - c.x) + Math.abs(p.z - c.z) < 0.01; }
      if (free) c.y = Math.max(0, c.y - 4 * dt);
    }
  }

  function think(c, t, F, dp) {
    const R = ROLES[c.role];
    if (!R.on(F, c, t)) {
      if (c.hidden) return;
      if (!R.home) return hide(c);
      const h = R.home(c);
      if (!c.homeT) c.homeT = t;
      const hy = h.y != null ? h.y : 0;
      const d = c.air || h.y != null ? dist3(c, h.x, hy, h.z) : Math.hypot(c.x - h.x, c.z - h.z);
      if (d < 1.5 || t - c.homeT > 90) return hide(c);
      c.st = ST.HOME; c.face = null; c.pitch = 0; c.ring = c.role === 'herd' || c.role === 'deer' ? null : c.ring;
      if (c.kind === 'cat') { c.perch = null; c.climb = false; }
      if (h.y != null) { c.air = true; c.circ = false; goTo(c, h.x, h.z, c.sp.fly || c.sp.walk, 3, hy); }
      else goTo(c, h.x, h.z, c.sp.walk * 1.4, 1);
      return;
    }
    c.homeT = 0;
    if (c.hidden) {
      if (!c.wake) c.wake = t + 1 + c.seed * 20;
      if (t < c.wake) return;
      c.hidden = false; c.wake = 0; c.st = ST.IDLE; c.timer = 0;
      if (R.wake) R.wake(c);
    }
    R.think(c, t, F, dp);
  }

  function step(dt, t, player, env) {
    dt = clamp(dt || 0, 0, 0.1);
    t0 = t;
    const F = sim.flags = lifeFlags(env);
    if (player && Number.isFinite(player.x)) {
      const mx = player.x - P.x, mz = player.z - P.z, m = Math.hypot(mx, mz);
      if (havePlayer && m > 0.05 && m < 10) { P.hx = mx / m; P.hz = mz / m; }
      if (!havePlayer || m > 0.05) { P.x = player.x; P.z = player.z; }
      havePlayer = true;
    }
    if (!started) {
      // 第一帧:该在圈里的就已经在圈里,不要当着人的面走回去
      started = true;
      for (const c of all) if (c.role !== 'path' && !ROLES[c.role].on(F, c, t)) hide(c);
    }
    for (const H of herds) {
      let x = 0, z = 0, n = 0;
      for (const m of H.members) if (!m.hidden) { x += m.x; z += m.z; n++; }
      if (n) { H.cx = x / n; H.cz = z / n; }
    }
    if (bell) {
      bell = false;
      for (const f of flocks) if (f.kind === 'pigeon' && f.circle) {
        f.mode = 'circle'; f.until = t + 30;
        for (const m of f.members) if (!m.hidden) { m.st = ST.IDLE; m.lap = 0; }
      }
    }
    for (const f of flocks) flockStep(f, t, F);
    grid.clear();
    for (const c of all) if (c.role === 'bird' && c.air && !c.hidden && c.st !== ST.PERCH) {
      const k = gkey(c.x, c.z);
      const l = grid.get(k);
      if (l) l.push(c); else grid.set(k, [c]);
    }
    for (const c of all) {
      if (c.role === 'path') { pathMove(c, dt, t, F); continue; }
      const dp = havePlayer ? Math.hypot(c.x - P.x, c.z - P.z) : 1e9;
      if (t >= c.next) {
        c.next = t + (dp > 80 ? 1 : 0.1) * (0.8 + 0.4 * c.seed);
        think(c, t, F, dp);
        // 快落地的时候不再管邻居,不然互相推着落不下来
        if (c.role === 'bird' && c.air && !c.hidden && (c.circ || (c.st === ST.FLY && Math.hypot(c.tx - c.x, c.tz - c.z) > 2))) boids(c);
        else if (c.role === 'bird') c.sx = c.sy = c.sz = 0;
      }
      if (!c.hidden) move(c, dt, t);
    }
  }

  function near(x, z, r) {
    const out = [];
    for (const c of all) if (!c.hidden && Math.abs(c.x - x) < r && Math.abs(c.z - z) < r && Math.hypot(c.x - x, c.z - z) < r) out.push({ kind: c.kind, x: c.x, z: c.z });
    return out;
  }
  function counts() {
    const o = {};
    for (const c of all) o[c.kind] = (o[c.kind] || 0) + 1;
    return o;
  }
  return sim;
}
