/**
 * town-life-sim.js —— 镇上的活物(纯模拟那一半)。
 *
 *   node src/renderer/town-life.test.mjs
 *
 * 钉住的是"像活的、又不乱跑"这几件:同一个种子同一群羊;羊不出圈、人来了会跑;天黑回圈、
 * 天亮出来;鸡天黑上架;谁都不掉进河里、不跑进深林;敲钟鸽子飞起来;一千步够快。
 */
import { planTown } from './town-plan.js';
import { createSim, lifeFlags, ST } from './town-life-sim.js';

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'p' + i, title: 'proj-' + i, lang: ['ts', 'rust', 'python', 'go'][i % 4],
  bytes: 5000 + (i % 17) * 40000, files: 5 + (i % 23),
}));
const plan = planTown(mk(60));
const W = plan.world;
const env = (hour, o = {}) => ({
  hour, night: hour < 5.5 || hour > 20.5 ? 1 : hour < 6.5 || hour > 19.5 ? 0.5 : 0,
  season: o.season || 'summer', weather: o.weather || 'clear',
  fx: Object.assign({ rain: 0, snow: 0, wind: 0.1, fog: 0, cover: 0.1 }, o.fx),
});
const FAR = { x: 0, z: 0 };                      // 人站在镇中心:离牧场都远
const run = (sim, secs, e, player = FAR, t0 = 0, dt = 1 / 30) => {
  let t = t0;
  for (let i = 0, n = Math.round(secs / dt); i < n; i++) { t += dt; sim.step(dt, t, typeof player === 'function' ? player(t) : player, e); }
  return t;
};
const ground = (c) => !c.air && !c.hidden && c.role !== 'path';

/* ── 长出来了 ── */
{
  const sim = createSim(plan, { seed: 's1', budget: 1 });
  const n = sim.counts();
  console.log('  ·', JSON.stringify(n));
  ok('a town has sheep or cows, chickens, cats, dogs and birds',
    (n.sheep || 0) + (n.cow || 0) > 5 && n.chicken > 0 && n.cat > 0 && n.dog >= 2 && n.sparrow > 0 && n.pigeon > 0);
  ok(`the whole cast stays under a thousand (${sim.creatures.length})`, sim.creatures.length < 1000);
  const small = createSim(plan, { seed: 's1', budget: 0.25 });
  ok(`a small budget means fewer animals (${small.creatures.length} vs ${sim.creatures.length})`, small.creatures.length < sim.creatures.length * 0.6);
  ok('no world, no animals, no crash', createSim(planTown([]), {}).creatures.length === 0);
}

/* ── 同一个种子 = 同一群羊走同一条路 ── */
{
  const sig = (s) => s.creatures.map((c) => c.x.toFixed(3) + ',' + c.z.toFixed(3) + ':' + c.st).join('|');
  const a = createSim(plan, { seed: 'same' }), b = createSim(plan, { seed: 'same' });
  const walk = (t) => ({ x: Math.cos(t * 0.2) * 40, z: Math.sin(t * 0.2) * 40 });
  run(a, 20, env(10), walk); run(b, 20, env(10), walk);
  ok('the same seed gives the same animals doing the same things', sig(a) === sig(b));
  const c = createSim(plan, { seed: 'other' });
  run(c, 20, env(10), walk);
  ok('a different seed is a different flock', sig(a) !== sig(c));
}

/* ── 羊不出圈 ── */
{
  const sim = createSim(plan, { seed: 's2' });
  let worst = 0;
  let t = 0;
  for (let k = 0; k < 12; k++) {
    t = run(sim, 10, env(11), FAR, t);
    for (const H of sim.herds) if (H.pasture) for (const c of H.members) {
      if (c.hidden) continue;
      worst = Math.max(worst, Math.hypot(c.x - H.ring.x, c.z - H.ring.z) - H.ring.r);
    }
  }
  ok(`livestock stay inside their pasture for two minutes (worst ${worst.toFixed(2)} m past the fence)`, worst < 0.5);
  const moving = sim.creatures.filter((c) => c.role === 'herd' && (c.st === ST.GRAZE || c.st === ST.WANDER || c.st === ST.IDLE));
  ok('and they are grazing, wandering or standing about', moving.length > sim.creatures.filter((c) => c.role === 'herd').length * 0.8);
}

/* ── 人走过去,羊群会跑 ── */
{
  const sim = createSim(plan, { seed: 's3' });
  let t = run(sim, 5, env(10));
  const H = sim.herds.find((h) => h.pasture && h.members.length >= 3);
  const c0 = H.members[0];
  const me = { x: c0.x + 1.5, z: c0.z + 0.5 };
  const before = H.members.map((c) => Math.hypot(c.x - me.x, c.z - me.z));
  let fled = false;
  for (let i = 0; i < 20; i++) { t = run(sim, 0.1, env(10), me, t); if (H.members.some((c) => c.st === ST.FLEE)) fled = true; }
  const after = H.members.map((c) => Math.hypot(c.x - me.x, c.z - me.z));
  ok('a herd animal bolts when you walk up to it', fled);
  ok(`and it ends up further away (${before[0].toFixed(1)} → ${after[0].toFixed(1)} m)`, after[0] > before[0] + 1);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  ok('the herd as a whole moves away too', sum(after) > sum(before));

  const hens = createSim(plan, { seed: 's3' });
  let t2 = run(hens, 3, env(10));
  const hen = hens.creatures.find((c) => c.kind === 'chicken');
  const near = { x: hen.x + 0.8, z: hen.z };
  const d0 = Math.hypot(hen.x - near.x, hen.z - near.z);
  t2 = run(hens, 1.5, env(10), near, t2);
  ok('a chicken scatters when you step next to it', Math.hypot(hen.x - near.x, hen.z - near.z) > d0 + 0.5);
}

/* ── 天黑回圈,天亮出来 ── */
{
  const sim = createSim(plan, { seed: 's4' });
  let t = run(sim, 20, env(18));
  const herd = sim.creatures.filter((c) => c.role === 'herd');
  ok('in the late afternoon the livestock are out', herd.every((c) => !c.hidden));
  t = run(sim, 100, env(20.5), FAR, t, 1 / 20);
  ok(`at dusk they walk home and are shut in (${herd.filter((c) => !c.hidden).length} still out)`, herd.every((c) => c.hidden));
  ok('the chickens have gone to roost', sim.creatures.filter((c) => c.kind === 'chicken').every((c) => c.hidden));
  const pigs = sim.creatures.filter((c) => c.kind === 'pig');
  ok('the pigs are in their sty', pigs.every((c) => c.hidden));
  t = run(sim, 40, env(23), FAR, t, 1 / 20);
  ok('bats come out at night in summer', sim.creatures.some((c) => c.kind === 'bat' && !c.hidden));
  ok('swallows do not', sim.creatures.filter((c) => c.kind === 'swallow').every((c) => c.hidden));
  ok('the dogs are still about (asleep)', sim.creatures.filter((c) => c.kind === 'dog').every((c) => !c.hidden));
  t = run(sim, 40, env(8), FAR, t, 1 / 20);
  ok(`in the morning they are back out (${herd.filter((c) => c.hidden).length} still in)`, herd.every((c) => !c.hidden));
  ok('the chickens are back in the yard', sim.creatures.filter((c) => c.kind === 'chicken').every((c) => !c.hidden));
  ok('the bats have gone', sim.creatures.filter((c) => c.kind === 'bat').every((c) => c.hidden));

  const night = createSim(plan, { seed: 's4' });
  night.step(1 / 30, 1, FAR, env(2));
  ok('a town you walk into at 2am has its livestock already inside', night.creatures.filter((c) => c.role === 'herd').every((c) => c.hidden));
}

/* ── 谁都不掉进水里、不跑进深林 ── */
{
  const sim = createSim(plan, { seed: 's5' });
  let bad = 0, far = 0, wet = 0;
  const tour = (t) => ({ x: Math.cos(t * 0.05) * (W.forest.r0 - 20), z: Math.sin(t * 0.05) * (W.forest.r0 - 20) });
  let t = 0;
  for (let k = 0; k < 8; k++) {
    t = run(sim, 15, env(k % 2 ? 7.5 : 18.5), tour, t);
    for (const c of sim.creatures) {
      if (!ground(c)) continue;
      const w = sim.isWater(c.x, c.z);
      if (c.kind === 'duck') { if (!w) wet++; continue; }
      if (w) bad++;
      if (Math.hypot(c.x, c.z) > W.forest.r1) far++;
    }
  }
  ok(`no ground animal ends up in the water (${bad})`, bad === 0);
  ok(`and none wanders past the forest (${far})`, far === 0);
  ok(`ducks stay on the water (${wet} on land)`, wet === 0);
  const g = W.wall.gates, mr = (W.moat.r0 + W.moat.r1) / 2, ga = (g[0].a + g[1].a) / 2;
  ok('the moat is water, the bridge by the gate is not, the town square is not',
    sim.isWater(Math.cos(ga) * mr, Math.sin(ga) * mr) && !sim.isWater(Math.cos(g[0].a) * mr, Math.sin(g[0].a) * mr)
    && !sim.isWater(W.market ? W.market.x : 0, W.market ? W.market.z : 0));
}

/* ── 敲钟:鸽子一下全飞起来,绕一圈 ── */
{
  const sim = createSim(plan, { seed: 's6' });
  let t = run(sim, 15, env(12));
  const pig = sim.creatures.filter((c) => c.kind === 'pigeon' && !c.hidden);
  ok('pigeons are down on the ground before the bell', pig.filter((c) => !c.air).length > pig.length * 0.6);
  sim.ring();
  t = run(sim, 2.5, env(12), FAR, t);
  const up = pig.filter((c) => c.st === ST.CIRCLE && c.y > 2).length;
  ok(`the bell sends them up round the tower (${up}/${pig.length})`, up > pig.length * 0.7);
  t = run(sim, 60, env(12), FAR, t);
  ok('and they settle again afterwards', pig.filter((c) => c.st !== ST.CIRCLE).length > pig.length * 0.8);
}

/* ── 麻雀怕人,飞上房,过一会儿回来 ── */
{
  const sim = createSim(plan, { seed: 's7' });
  let t = run(sim, 5, env(12));
  const f = sim.flocks.find((q) => q.kind === 'sparrow');
  const b = f.members[0];
  const me = { x: b.x + 1, z: b.z };
  t = run(sim, 3, env(12), me, t);
  ok('sparrows take off when you walk into them', f.mode === 'up' && f.members.filter((m) => m.air).length > f.members.length * 0.7);
  t = run(sim, 25, env(12), FAR, t);
  ok('and come back down once you have gone', f.mode === 'ground' && f.members.filter((m) => !m.air).length > f.members.length * 0.6);
  const rain = createSim(plan, { seed: 's7' });
  run(rain, 20, env(12, { weather: 'rain', fx: { rain: 0.6 } }));
  ok('in the rain the sparrows sit it out on a roof', rain.flocks.filter((q) => q.kind === 'sparrow').every((q) => q.mode === 'up'));
}

/* ── 狗跟着人走 ── */
{
  const sim = createSim(plan, { seed: 's8' });
  const dog = sim.creatures.find((c) => c.follower);
  const path = (t) => ({ x: plan.spawn.x + Math.min(t, 20) * 0.6, z: plan.spawn.z });
  run(sim, 30, env(12), path);
  const me = path(30);
  ok(`the dog keeps close to you (${Math.hypot(dog.x - me.x, dog.z - me.z).toFixed(1)} m)`, Math.hypot(dog.x - me.x, dog.z - me.z) < 5);
}

/* ── 季节和天气 ── */
{
  const w = lifeFlags(env(12, { season: 'winter', weather: 'snow', fx: { snow: 1 } }));
  ok('winter: no bees, butterflies, swallows, storks or bats', !w.bees && !w.butterflies && !w.swallows && !w.storks && !w.bats);
  ok('but the sparrows are still about', w.birds);
  const s = lifeFlags(env(12, { season: 'summer' }));
  ok('a summer noon has bees and butterflies and storks', s.bees && s.butterflies && s.storks && s.swallows);
  const n = lifeFlags(env(23, { season: 'summer' }));
  ok('a summer night has moths, bats and the owl, but no bees', n.moths && n.bats && n.owl && !n.bees);
  const r = lifeFlags(env(12, { weather: 'rain', fx: { rain: 0.6 } }));
  ok('rain grounds the bees', !r.bees && !r.butterflies && r.wet);
  const wsim = createSim(plan, { seed: 's9' });
  run(wsim, 20, env(12, { season: 'winter', weather: 'snow', fx: { snow: 1 } }));
  ok('no storks in winter', wsim.creatures.filter((c) => c.kind === 'stork').every((c) => c.hidden));
}

/* ── 快 ── */
{
  const sim = createSim(plan, { seed: 'perf', budget: 1 });
  const walk = (t) => ({ x: plan.spawn.x + Math.sin(t * 0.3) * 30, z: plan.spawn.z + Math.cos(t * 0.2) * 30 });
  sim.step(1 / 60, 0, walk(0), env(17.8));
  const t0 = performance.now();
  for (let i = 1; i <= 1000; i++) sim.step(1 / 60, i / 60, walk(i / 60), env(17.8));
  const ms = performance.now() - t0;
  ok(`1000 steps of ${sim.creatures.length} animals take ${ms.toFixed(0)} ms (< 1500)`, ms < 1500);
  const n = sim.near(plan.spawn.x, plan.spawn.z, 30);
  ok('near() lists who is around', Array.isArray(n) && n.every((q) => q.kind && Number.isFinite(q.x)));
}

/* 镇上一个项目都没有(本地开发库、新部署):没有图纸,sim 提前 return。
   以前交出去的 step 读的是还在暂时性死区里的 t0,每帧抛 ReferenceError,整座镇子停在第一帧。 */
{
  const empty = createSim({ plots: [] }, { seed: 'empty' });
  let err = null;
  try { for (let i = 0; i < 10; i++) empty.step(1 / 30, i / 30, { x: 0, z: 0 }, { hour: 12 }); } catch (e) { err = e; }
  ok('empty town: step() runs without throwing', !err);
  ok('empty town: nobody lives there', empty.creatures.length === 0);
  ok('empty town: flags still follow the weather', empty.flags && typeof empty.flags.day === 'boolean');
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
