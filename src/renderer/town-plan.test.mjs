/**
 * town-plan.js —— 小镇的图纸(纯函数那一半)。
 *
 *   node src/renderer/town-plan.test.mjs
 *
 * 钉住的是走得到、不打架、认得出来这几件:每栋房子都能从出生点走到,房子之间不重叠,
 * 大项目在镇中心,同一份列表永远是同一座镇。
 */
import { planTown, polyArea, polyInset, polyCentroid, plotSlot, validPlot, PLOT_SLOTS } from './town-plan.js';

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const mk = (n, f = () => ({})) => Array.from({ length: n }, (_, i) => Object.assign({
  id: 'p' + i, title: 'proj-' + i, lang: ['ts', 'rust', 'python', 'go'][i % 4],
  bytes: 5000 + (i % 17) * 40000, files: 5 + (i % 23),
}, f(i)));

/* ── 图纸长出来了 ── */
{
  const T = planTown(mk(60));
  ok(`sixty projects get sixty plots (${T.plots.length})`, T.plots.length >= 55);
  ok('every plot keeps its project', T.plots.every((p) => p.project && p.id === p.project.id));
  ok(`the town is a few hundred metres across (${Math.round(T.radius * 2)} m)`, T.radius * 2 > 200 && T.radius * 2 < 800);
  ok('there are streets, squares and parks', T.streets.length > 50 && T.plazas.length >= 1 && T.parks.length >= 1);
  ok('you start on a square', Math.hypot(T.spawn.x - T.plazas[0].cx, T.spawn.z - T.plazas[0].cz) < 6);
  ok('streets come in three widths', new Set(T.streets.map((s) => s.rank)).size === 3);
  ok('the busiest streets are the widest', Math.max(...T.streets.filter((s) => s.rank === 'avenue').map((s) => s.use))
    >= Math.max(...T.streets.filter((s) => s.rank === 'lane').map((s) => s.use)));
}

/* ── 走得到:街道图是连通的(最小生成树保证的) ── */
{
  const T = planTown(mk(80));
  const adj = new Map();
  for (const s of T.streets) {
    if (!adj.has(s.a)) adj.set(s.a, []); if (!adj.has(s.b)) adj.set(s.b, []);
    adj.get(s.a).push(s.b); adj.get(s.b).push(s.a);
  }
  const seen = new Set([0]), q = [0];
  for (let h = 0; h < q.length; h++) for (const w of adj.get(q[h]) || []) if (!seen.has(w)) { seen.add(w); q.push(w); }
  ok(`every corner of the town is reachable on foot (${seen.size}/${T.nodes.length})`, seen.size === T.nodes.length);
  ok('and there are loops, so you never have to walk back the way you came', T.streets.length > T.nodes.length - 1);
}

/* ── 镇子以外、镇子中间:城墙、城门、集市、教堂、墙外的地 ── */
{
  const T = planTown(mk(60));
  const W = T.world;
  ok('there is a town wall outside every house', W && T.plots.every((p) => Math.hypot(p.cx, p.cz) < W.wall.r - 2));
  ok(`with three or four gates (${W.wall.gates.length})`, W.wall.gates.length >= 3);
  ok('and every gate is reachable by street', W.wall.gates.every((G) => T.streets.some((s) => s.b === G.inner || s.a === G.inner)));
  ok('the moat is outside the wall', W.moat.r0 > W.wall.r);
  ok(`a market with stalls (${W.market && W.market.stalls.length})`, W.market && W.market.stalls.length >= 3);
  ok('you start on the market square', Math.hypot(T.spawn.x - W.market.x, T.spawn.z - W.market.z) < 6);
  ok('a parish church with a tower', W.church && W.church.tower.h > 15 && W.church.tower.spire > 10);
  ok(`fields, pastures and orchards outside (${W.fields.length}/${W.pastures.length}/${W.orchards.length})`, W.fields.length > 2 && W.pastures.length > 1 && W.orchards.length > 0);
  ok('every pasture has a barn', W.pastures.every((p) => Number.isFinite(p.barn.x)));
  ok('a windmill, a watermill on the stream', !!W.windmill && !!W.watermill && W.stream.pts.length > 10);
  ok('the forest is the outer ring', W.forest.r0 > W.moat.r1 + 100);
  ok(`back gardens behind some houses (${W.yards.length})`, W.yards.length > 3);
  ok('some houses are shops and taverns', T.plots.some((p) => p.trade === 'tavern') && T.plots.some((p) => p.trade === 'home'));
  const again = planTown(mk(60));
  ok('the same projects always build the same world', JSON.stringify(again.world.wall.gates) === JSON.stringify(W.wall.gates));
}

/* ── 别墅外面多大,照它里面的平面图 ── */
{
  const T = planTown(mk(40, (i) => ({ fw: 12 + (i % 5), fd: 9 + (i % 4) })));
  const rect = T.plots.filter((p) => p.rect);
  ok(`houses are rectangles facing their street (${rect.length}/${T.plots.length})`, rect.length >= T.plots.length * 0.8);
  const fits = rect.filter((p) => Math.abs(p.w / p.d - p.project.fw / p.project.fd) < 0.05 || p.w < p.project.fw);
  ok('and keep the shape of the plan inside', fits.length >= rect.length * 0.8);
}

/* ── 房子不打架 ── */
{
  const T = planTown(mk(70));
  /* 凸多边形碰没碰上:分离轴 —— 只要找得到一条边的法线,把两块地投影上去分得开,
     它们就没挨着。⚠ 别拿外接矩形判:斜对角的两块地,矩形永远是重叠的。 */
  const hit = (A, B) => {
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const nx = q[1] - p[1], nz = -(q[0] - p[0]);
        const proj = (P) => P.reduce((r, v) => { const d = nx * v[0] + nz * v[1]; return [Math.min(r[0], d), Math.max(r[1], d)]; }, [1e18, -1e18]);
        const a = proj(A), b = proj(B);
        if (a[1] <= b[0] + 1e-6 || b[1] <= a[0] + 1e-6) return false;
      }
    }
    return true;
  };
  let overlap = 0;
  for (let i = 0; i < T.plots.length; i++) for (let j = i + 1; j < T.plots.length; j++) {
    if (Math.hypot(T.plots[i].cx - T.plots[j].cx, T.plots[i].cz - T.plots[j].cz) > 90) continue;
    if (hit(T.plots[i].poly, T.plots[j].poly)) overlap++;
  }
  ok(`no two buildings stand on the same ground (${overlap} clashes)`, overlap === 0);
  ok('every building has room to stand in', T.plots.every((p) => p.area > 20));
  ok('and a door that faces its street', T.plots.every((p) => Number.isFinite(p.door.x) && Number.isFinite(p.door.yaw)));
}

/* ── 认得出来:同一份列表 = 同一座镇 ── */
{
  const a = planTown(mk(40)), b = planTown(mk(40));
  const sig = (T) => T.plots.map((p) => p.id + ':' + p.cx.toFixed(3) + ',' + p.cz.toFixed(3)).join('|');
  ok('the same projects always build the same town', sig(a) === sig(b));
  const c = planTown(mk(40), { seed: 'other' });
  ok('a different seed is a different town', sig(a) !== sig(c));
}

/* ── 大项目在镇中心 ── */
{
  const T = planTown(mk(60, (i) => ({ bytes: i < 6 ? 9000000 : 20000, files: i < 6 ? 900 : 10 })));
  const big = T.plots.filter((p) => +p.project.bytes > 1000000);
  const small = T.plots.filter((p) => +p.project.bytes <= 1000000);
  const mid = (ps) => ps.reduce((a, p) => a + Math.hypot(p.cx, p.cz), 0) / (ps.length || 1);
  ok(`the biggest projects are downtown (${Math.round(mid(big))} m vs ${Math.round(mid(small))} m)`, mid(big) < mid(small));
  ok('and they are the tallest', Math.max(...big.map((p) => p.h)) > Math.max(...small.map((p) => p.h)));
}

/* ── 同一个城市的住一块儿 ── */
{
  const T = planTown(mk(60, (i) => ({ city: ['Shanghai', 'Berlin', 'Tokyo'][i % 3], country: 'XX' })));
  ok('three cities, three districts', T.districts.length === 3 && T.districts.every((d) => d.n > 10));
  const spread = (key) => {
    const ps = T.plots.filter((p) => p.district === key);
    const cx = ps.reduce((a, p) => a + p.cx, 0) / ps.length, cz = ps.reduce((a, p) => a + p.cz, 0) / ps.length;
    return ps.reduce((a, p) => a + Math.hypot(p.cx - cx, p.cz - cz), 0) / ps.length;
  };
  const own = spread(T.districts[0].key);
  const whole = T.plots.reduce((a, p) => a + Math.hypot(p.cx, p.cz), 0) / T.plots.length;
  ok(`neighbours from one city stay together (${Math.round(own)} m vs the whole town ${Math.round(whole)} m)`, own < whole);
  const noCity = planTown(mk(30, () => ({})));
  ok('no city, so the districts fall back to language', noCity.districts.length === 4);
}

/* ── 边界:空列表、一个项目、很多项目 ── */
{
  ok('an empty plaza is an empty town, not a crash', planTown([]).plots.length === 0);
  const one = planTown(mk(1));
  ok('one project still gets a house and somewhere to stand', one.plots.length === 1 && Number.isFinite(one.spawn.x));
  const many = planTown(mk(200));
  ok(`two hundred projects still fit (${many.plots.length} plots, ${Math.round(many.radius * 2)} m across)`,
    many.plots.length > 180 && many.radius * 2 < 1200);
}

/* ── 自己挑的地:别人发不发布,你的别墅都在那儿 ── */
{
  const withPins = (n) => mk(n, (i) => (i < 6 ? { plot: [0, 5, 17, 40, 77, 119][i] } : {}));
  const at = (T, id) => T.plots.find((p) => p.id === id);
  const near = (T, i, k) => { const p = at(T, 'p' + i), q = plotSlot(k); return p && Math.hypot(p.cx - q.x, p.cz - q.z) < 16; };
  const small = planTown(withPins(20)), big = planTown(withPins(150));
  const K = [0, 5, 17, 40, 77, 119];
  ok('a chosen plot is where the villa stands', K.every((k, i) => near(small, i, k)));
  ok('and it stays there when the town grows sevenfold', K.every((k, i) => near(big, i, k)));
  const moved = K.map((k, i) => Math.hypot(at(small, 'p' + i).cx - at(big, 'p' + i).cx, at(small, 'p' + i).cz - at(big, 'p' + i).cz));
  ok(`(moved at most ${Math.round(Math.max(...moved))} m inside its own plot)`, Math.max(...moved) < 16);
  ok('the outermost plot is still inside the town', big.radius > plotSlot(119).r && small.radius > plotSlot(119).r);
  ok('plots are fixed in metres, not in town size', JSON.stringify(plotSlot(40)) === JSON.stringify(plotSlot(40)) && plotSlot(0).r < plotSlot(119).r);
  ok(`there are ${PLOT_SLOTS} plots and only those`, validPlot(0) && validPlot(PLOT_SLOTS - 1) && !validPlot(PLOT_SLOTS) && !validPlot(-1) && !validPlot(1.5) && !validPlot('3'));
  // 相邻的两块地至少隔着一栋房子的宽度
  let tight = Infinity;
  for (let a = 0; a < PLOT_SLOTS; a++) for (let b = a + 1; b < PLOT_SLOTS; b++) {
    const p = plotSlot(a), q = plotSlot(b);
    tight = Math.min(tight, Math.hypot(p.x - q.x, p.z - q.z));
  }
  ok(`neighbouring plots are at least 25 m apart (${tight.toFixed(1)} m)`, tight >= 25);
  // 两个人抢同一块:只给列表里第一个,第二个照常自动排
  const clash = planTown(mk(30, (i) => (i < 2 ? { plot: 9 } : {})));
  ok('one plot, one villa', near(clash, 0, 9) && !near(clash, 1, 9) && !!at(clash, 'p1'));
  ok('a nonsense plot is simply ignored', !!at(planTown(mk(10, (i) => (i === 0 ? { plot: 'abc' } : i === 1 ? { plot: 999 } : {}))), 'p1'));
  // 所有的地都挑满了也不打架、每栋都盖得下
  const full = planTown(mk(PLOT_SLOTS + 20, (i) => (i < PLOT_SLOTS ? { plot: i } : {})), { spacing: 28 });
  ok(`a town with every plot taken still builds every house (${full.plots.length}/${PLOT_SLOTS + 20})`, full.plots.length >= (PLOT_SLOTS + 20) * 0.95);
  const hit = (A, B) => {
    for (const poly of [A, B]) for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], nx = q[1] - p[1], nz = -(q[0] - p[0]);
      const proj = (P) => P.reduce((r, v) => { const d = nx * v[0] + nz * v[1]; return [Math.min(r[0], d), Math.max(r[1], d)]; }, [1e18, -1e18]);
      const a = proj(A), b = proj(B);
      if (a[1] <= b[0] + 1e-6 || b[1] <= a[0] + 1e-6) return false;
    }
    return true;
  };
  let clashes = 0;
  for (const T of [big, full]) for (let i = 0; i < T.plots.length; i++) for (let j = i + 1; j < T.plots.length; j++) {
    if (Math.hypot(T.plots[i].cx - T.plots[j].cx, T.plots[i].cz - T.plots[j].cz) > 90) continue;
    if (hit(T.plots[i].poly, T.plots[j].poly)) clashes++;
  }
  ok(`chosen plots never make two houses overlap (${clashes} clashes)`, clashes === 0);
  const nopin = planTown(mk(40)), same = planTown(mk(40, () => ({ plot: undefined })));
  const sig = (T) => T.plots.map((p) => p.id + ':' + p.cx.toFixed(3) + ',' + p.cz.toFixed(3)).join('|');
  ok('a town where nobody chose a plot is exactly the town it was before', sig(nopin) === sig(same));
}

/* ── 多边形那几个小工具 ── */
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  ok('area of a 10×10 square is 100', Math.abs(polyArea(sq) - 100) < 1e-6);
  ok('its middle is (5, 5)', polyCentroid(sq).every((v) => Math.abs(v - 5) < 1e-6));
  ok('inset by 2 leaves a 6×6', Math.abs(polyArea(polyInset(sq, 2)) - 36) < 1e-6);
  ok('inset past the middle leaves nothing', polyInset(sq, 6) === null);
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
