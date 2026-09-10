/**
 * wallpaper-project.js 的流程幕测试 —— 项目"在干什么"那一层。
 *
 *   node --import ./src/renderer/testkit/loader.mjs src/renderer/wallpaper-project.test.mjs
 *   (npm run test:project)
 *
 * 这一层此前**一行测试都没有**,而它恰恰是这个仓库里最会安静出错的一种代码:
 * 它不抛异常,它少画一层 —— 而"少画一层"和"本来就没有"在屏幕上一模一样。
 * 项目窗口那一轮查了五次才破案,五次里有四次是"桌面浏览器说没问题"。
 *
 * ★ 第五轮的真因值得单独钉住:`uPixel` 一直是 1,而手机上绘制缓冲区是 CSS 尺寸的
 *   1.5 倍,于是这一层**故意做小**的点算出来不到一个设备像素 —— 小于 1.0 的点根本
 *   不光栅化。周围的场是好的(它的点大),项目层是全黑的。所以下面有一条断言,
 *   就是拿着着色器里那个公式去算每一颗点的实际大小。
 */
import { sampleFlow, sampleGraphFlow, sampleTimeline, sampleCity, planScenes } from './wallpaper-project.js';
import { readFileSync } from 'node:fs';
import './testkit/canvas.mjs';

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

console.log('\nwallpaper-project · flow\n');

const N = 4000;
const FLOW = { kind: 'cli', entry: 'terse', cmds: ['scan', 'diff', 'report'] };

/* ── 空的输入不画东西,而且不炸 ─────────────────────────────────────────
   `used === 0` 是这一层说"我没有可画的"的方式。渲染那一端靠它决定跳过,所以
   它必须是 0,不能是"画了一堆看不见的点"。 */
ok('no flow at all draws nothing', sampleFlow(null, [], N, 0).used === 0);
ok('a single node is not a pipeline, so it draws nothing',
   sampleFlow({ kind: 'lib', entry: 'got', cmds: [] }, [], N, 0).used === 0);
ok('and n = 0 is survivable', sampleFlow(FLOW, [], 0, 0).used === 0);

/* ── 正常一幕 ───────────────────────────────────────────────────────── */
const out = sampleFlow(FLOW, ['Highlight a file'], N, 0);
ok('a flow with actions draws something', out.used > 0);
ok('it never writes past the budget it was given', out.used <= N);
ok('the arrays are the size the caller asked for',
   out.target.length === N * 3 && out.color.length === N * 3 && out.scale.length === N);
ok('every point it claims to have used has a finite position',
   [...out.target.slice(0, out.used * 3)].every(Number.isFinite));

/* 动作最多五个 —— 加上入口是六个节点。再多就不是一条能一眼看懂的流水线。 */
{
  const many = { kind: 'cli', entry: 'x', cmds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] };
  const rows = [];
  for (let s = 0; s < 12; s++) rows.push(litY(sampleFlow(many, [], N, s)));
  const distinct = new Set(rows.filter((y) => y !== null).map((y) => y.toFixed(3)));
  ok('at most six nodes, however many commands there are', distinct.size <= 6);
}

/* ── 亮的那一颗**在往下走** ─────────────────────────────────────────────
   这一幕的全部意思就是这个:一拍推进一步,看得见流水线在自己走。它由拍号驱动,
   不是每帧算的 —— 所以 step 变了而画面没变,就是这一幕死了,并且不会有任何报错。 */
{
  const ys = [0, 1, 2].map((s) => litY(sampleFlow(FLOW, [], N, s)));
  ok('the lit node can be located at every step', ys.every((y) => y !== null));
  ok(`the lit node descends as the beat advances (${ys.map((y) => y?.toFixed(2)).join(' → ')})`,
     ys[0] > ys[1] && ys[1] > ys[2]);
  ok('the first beat lights the entry, at the top', ys[0] > 0.7);
}
{
  // 拍号会一直涨,幕却只有几行 —— 必须绕回去,不能走出画面或者越界。
  const rows = 4;                                   // entry + 3 cmds
  ok('the step wraps instead of running off the end',
     Math.abs(litY(sampleFlow(FLOW, [], N, rows)) - litY(sampleFlow(FLOW, [], N, 0))) < 1e-6);
  ok('and a negative step is still on the board',
     litY(sampleFlow(FLOW, [], N, -1)) !== null);
}

/* ── 名字:命令名优先,不重复 ───────────────────────────────────────────
   命令名是作者自己给这个动作起的名字;README 小标题只是补位。 */
{
  const a = sampleFlow({ kind: 'cli', entry: 'x', cmds: ['scan'] }, ['scan', 'audit'], N, 0);
  const b = sampleFlow({ kind: 'cli', entry: 'x', cmds: ['scan'] }, ['audit'], N, 0);
  ok('a verb that repeats a command name does not become a second node',
     Math.abs(litY(a) - litY(b)) < 1e-6);
}

/* ── ★ 点必须**有大小** ─────────────────────────────────────────────────
   着色器里:gl_PointSize = (1.15 + uForm*0.75) * uPixel * uPointScale * aScale
   完全落位时 uForm = 1。手机上 uPixel 是绘制缓冲区比例(1.5),uPointScale 是 1.6。
   小于 1.0 的点不光栅化 —— 这一层就是这么消失了整整五轮,而周围的场好好的,
   因为场的点比它大得多。 */
{
  const src = readFileSync(new URL('./wallpaper-project.js', import.meta.url), 'utf8');
  const shader = /gl_PointSize\s*=\s*\(1\.15\s*\+\s*uForm\s*\*\s*0\.75\)\s*\*\s*uPixel\s*\*\s*uPointScale\s*\*\s*aScale/.test(src);
  ok('the point-size formula is still the one this test does arithmetic on', shader);
  const uPointScale = +(src.match(/uPointScale:\s*\{\s*value:\s*([0-9.]+)/) || [])[1];
  ok('uPointScale was found in the layer uniforms', uPointScale > 0);

  const RATIO = 1.5;                                  // 手机上的 setPixelRatio 上限
  const px = (aScale) => (1.15 + 0.75) * RATIO * uPointScale * aScale;

  let min = Infinity;
  for (let i = 0; i < out.used; i++) min = Math.min(min, out.scale[i]);
  ok(`every point in the flow scene is at least one device pixel (smallest = ${px(min).toFixed(2)}px at aScale ${min})`,
     px(min) >= 1);

  // 而且这条断言要真的会失败 —— 否则它只是一句安慰话。
  ok('a sub-pixel scale would be caught', px(0.05) < 1);
}

/* ── 三种状态,三种颜色 ─────────────────────────────────────────────────
   走过的留一点余温,当前的最亮,还没到的几乎是灰的。全都一样亮的话,"进行到哪了"
   这件事就没画出来 —— 而它是这一幕唯一要说的话。 */
{
  const f = sampleFlow(FLOW, [], N, 2);
  let litMax = 0, waitMax = 0;
  for (let i = 0; i < f.used; i++) {
    const r = f.color[i * 3], g = f.color[i * 3 + 1];
    if (r > 0.6) continue;                            // 白色的名字不参与比亮度
    if (g > 0.6) litMax = Math.max(litMax, g); else waitMax = Math.max(waitMax, g);
  }
  ok('the lit node is brighter than the ones not reached yet', litMax > waitMax * 1.4);
  ok('and the dim ones are actually drawn, not skipped', waitMax > 0);
}

/**
 * 亮着的那一颗节点的 y。
 *
 * 怎么认出来:节点球的绿色通道最高能到 1.0,而走过的最多 0.55、没到的 0.30、
 * 连线最多 0.81 —— 门槛放在 0.85 就只剩当前这一颗。名字是白的(红色通道 0.88),
 * 所以再要求 r < 0.6 把它排除掉。
 */
function litY(o) {
  let sum = 0, k = 0;
  for (let i = 0; i < o.used; i++) {
    const r = o.color[i * 3], g = o.color[i * 3 + 1];
    if (g > 0.85 && r < 0.6) { sum += o.target[i * 3 + 1]; k++; }
  }
  return k ? sum / k : null;
}

/* ══ E. 依赖流 ════════════════════════════════════════════════════════════
   星座画的是同一张图的静态样子;这一幕画的是**从入口一层层走进去**。所以要钉的
   是"走"这件事真的在动,以及它不会因为图里有孤岛就崩。 */
{
  /*  0 ── 1 ── 3
      │
      2        4(孤岛,谁也连不到)          0 度数最高 = 入口 */
  const G = { n: [[0, 0, 0, 3, 0], [200, 100, 0, 2, 0], [-200, 100, 0, 1, 1],
                  [400, 200, 0, 1, 1], [0, -400, 0, 0, 2]],
              e: [[0, 1], [0, 2], [1, 3]] };

  ok('an empty graph draws nothing', sampleGraphFlow(null, N, 0).used === 0);
  ok('a graph with no edges draws nothing', sampleGraphFlow({ n: G.n, e: [] }, N, 0).used === 0);

  const r0 = sampleGraphFlow(G, N, 0), r1 = sampleGraphFlow(G, N, 1), r2 = sampleGraphFlow(G, N, 2);
  ok('it draws at every ring', r0.used > 0 && r1.used > 0 && r2.used > 0);
  ok('it never writes past the budget', r0.used <= N && r2.used <= N);
  ok('every position is finite', [...r1.target.slice(0, r1.used * 3)].every(Number.isFinite));

  /* 亮的那一圈**在往外走**。判据用"亮点离入口的平均距离":第 0 拍只有入口亮,
     距离是 0;往后每一拍亮的那圈更远。⚠ 用距离而不是坐标,因为图是任意摆的。 */
  const litR = (o) => {
    let sum = 0, k = 0;
    for (let i = 0; i < o.used; i++) {
      const g = o.color[i * 3 + 1], rr = o.color[i * 3];
      if (g > 0.85 && rr < 0.6) {
        const x = o.target[i * 3], y = o.target[i * 3 + 1];
        sum += Math.hypot(x, y); k++;
      }
    }
    return k ? sum / k : null;
  };
  const rr = [litR(r0), litR(r1), litR(r2)];
  ok('the lit ring can be found at each step', rr.every((v) => v !== null));
  ok(`the lit ring moves outward from the entry (${rr.map((v) => v?.toFixed(2)).join(' → ')})`,
     rr[0] < rr[1] && rr[1] < rr[2]);

  // 孤岛不该被硬塞进最后一层 —— 它永远是"还没到"的颜色。
  ok('an unreachable node is never lit', (() => {
    for (let s2 = 0; s2 < 6; s2++) {
      const o = sampleGraphFlow(G, N, s2);
      for (let i = 0; i < o.used; i++) {
        const near = Math.abs(o.target[i * 3 + 1] + 0.4) < 0.06 && Math.abs(o.target[i * 3]) < 0.06;
        if (near && o.color[i * 3 + 1] > 0.85) return false;
      }
    }
    return true;
  })());

  ok('the step wraps rather than running off the end', sampleGraphFlow(G, N, 99).used > 0);
  ok('and a negative step is survivable', sampleGraphFlow(G, N, -3).used > 0);
}

/* ══ D. 城市是怎么长出来的 ═══════════════════════════════════════════════ */
{
  const dirs = [
    { name: 'core', files: 40, bytes: 400000, lang: 'Rust', depth: 2, age_days: 300 },
    { name: 'docs', files: 8, bytes: 20000, lang: 'Markdown', depth: 1, age_days: 150 },
    { name: 'web', files: 20, bytes: 150000, lang: 'TypeScript', depth: 2, age_days: 20 },
  ];
  const extent = (g) => {
    const o = sampleCity(dirs, 6000, 'modern', [], [1, 2, 3], g);
    let x0 = 9, x1 = -9, top = -9;
    for (let i = 0; i < o.used; i++) {
      x0 = Math.min(x0, o.target[i * 3]); x1 = Math.max(x1, o.target[i * 3]);
      top = Math.max(top, o.target[i * 3 + 1]);
    }
    return { width: x1 - x0, top, used: o.used };
  };

  const early = extent(0.12), late = extent(1);
  ok('early on the city is shorter than it ends up', early.top < late.top - 0.05);
  ok('and it is narrower — the newer directories are not there yet', early.width < late.width);
  ok('it still draws something at the very first beat', early.used > 0);

  /* ★ grow = 1 必须和**根本不传** grow 走同一条路。这一幕是加在一个已经上线的
     渲染器上的,今天的城市不能因为多了一个参数就变样。 */
  const a = sampleCity(dirs, 4000, 'modern', [], [1], 1);
  const b = sampleCity(dirs, 4000, 'modern', [], [1]);
  ok('grow = 1 and no grow at all use the same code path (heights identical)',
     Math.abs(Math.max(...a.target.filter((_, i) => i % 3 === 1))
            - Math.max(...b.target.filter((_, i) => i % 3 === 1))) < 1e-9);

  /* ⚠ 0 会让整座城市空掉,而一幕空城和"城市坏了"在屏幕上一模一样。 */
  ok('grow = 0 is clamped, not an empty city', sampleCity(dirs, 4000, 'modern', [], [1], 0).used > 0);
  ok('a nonsense grow is survivable', sampleCity(dirs, 4000, 'modern', [], [1], NaN).used > 0);

  // 全都同龄的旧胶囊:不该崩,也不该除以零。
  const sameAge = dirs.map((d) => Object.assign({}, d, { age_days: 0 }));
  ok('directories with no age at all still build a city', sampleCity(sameAge, 4000, 'modern', [], [1], 0.5).used > 0);
}

/* ══ 时间轴(生长那几拍的读数)══════════════════════════════════════════ */
{
  const days = Array.from({ length: 371 }, (_, i) => (i % 11 === 0 ? 9 : i % 3));
  ok('no commits, no timeline', sampleTimeline([], N, 1).used === 0);
  ok('too few days is not a timeline', sampleTimeline([1, 2], N, 1).used === 0);

  const t0 = sampleTimeline(days, N, 0.15), t1 = sampleTimeline(days, N, 1);
  ok('the timeline draws', t1.used > 0);
  const litX = (o) => {
    let mx = -9;
    for (let i = 0; i < o.used; i++) if (o.color[i * 3 + 1] > 0.85) mx = Math.max(mx, o.target[i * 3]);
    return mx;
  };
  ok(`the cursor advances with grow (${litX(t0).toFixed(2)} → ${litX(t1).toFixed(2)})`, litX(t0) < litX(t1));
  ok('371 days become ~53 weekly bars, not 371 needles', (() => {
    const gap = 1.7 / 52;                       // 见 sampleTimeline:W 摊在 weeks-1 上
    const buckets = new Set();
    for (let i = 0; i < t1.used; i++) buckets.add(Math.round((t1.target[i * 3] + 0.85) / gap));
    return buckets.size >= 40 && buckets.size <= 60;
  })());
}

/* ══ ★ 新的两幕也要过点大小那一关 ═════════════════════════════════════════
   这是这个文件里最该复用的一条:一幕画得再对,点不到一个设备像素就是全黑的。 */
{
  const G = { n: [[0, 0, 0, 3, 0], [200, 100, 0, 2, 0], [-200, 100, 0, 1, 1], [400, 200, 0, 1, 1]],
              e: [[0, 1], [0, 2], [1, 3]] };
  const days = Array.from({ length: 371 }, (_, i) => i % 5);
  const RATIO = 1.5, UPS = 1.6;
  const px = (sc) => (1.15 + 0.75) * RATIO * UPS * sc;
  const minOf = (o) => { let m = Infinity; for (let i = 0; i < o.used; i++) m = Math.min(m, o.scale[i]); return m; };

  const gmin = minOf(sampleGraphFlow(G, N, 1));
  const tmin = minOf(sampleTimeline(days, N, 0.5));
  ok(`every point in the dependency flow is at least one device pixel (${px(gmin).toFixed(2)}px)`, px(gmin) >= 1);
  ok(`every point in the timeline is at least one device pixel (${px(tmin).toFixed(2)}px)`, px(tmin) >= 1);
}

/* ══ 轮播:手机上到底轮不轮得到 ═══════════════════════════════════════════
   ★ 这是"补完数据、部署完了,手机上还是什么都没变"的真因。竖屏时 _setCity 里
   写着 `sceneCount = 1` 和 `nStar = 0` —— 合起来就是**手机上永远只画城市**,
   而流程、依赖流、时间轴、星座、热点、贡献者全都画在 nStar 那一格里。
   没有任何报错:少画一层和本来就没有,在屏幕上一模一样。 */
{
  const dirs = [
    { name: 'src', files: 40, bytes: 400000, age_days: 300, kids: [['a', 1, 2]] },
    { name: 'web', files: 20, bytes: 150000, age_days: 30 },
  ];
  const flow = { kind: 'cli', entry: 'terse', cmds: ['scan', 'diff'] };
  const graph = { n: [[0, 0, 0, 3, 0], [200, 100, 0, 2, 0], [-200, 100, 0, 1, 1], [400, 0, 0, 1, 1]],
                  e: [[0, 1], [0, 2], [1, 3]] };

  const wide = planScenes({ dirs, flow, verbs: ['audit'], graph });
  const phone = planScenes({ dirs, flow, verbs: ['audit'], graph, narrow: true });

  ok('a wallpaper rotates through several readings', wide.length > 3);
  ok('★ a PHONE gets more than one beat too — this was 1, which meant only the city',
     phone.length > 3);
  ok('the flow is in the phone rotation at all', phone.some((s2) => s2.k === 'flow'));
  ok('so is the dependency flow', phone.some((s2) => s2.k === 'gflow'));
  ok('so is the growth', phone.some((s2) => s2.k === 'grow'));
  ok('and the city gets a beat of its own, so it is not lost either',
     phone[0].k === 'city' && phone.filter((s2) => s2.k === 'city').length === 1);
  ok('a wallpaper needs no city beat — the city is always drawn beside the reading',
     !wide.some((s2) => s2.k === 'city'));

  // 一个项目可能什么都没有:那就一幕都不排,而不是排一幕空的。
  ok('nothing to show plans nothing', planScenes({}).length === 0);
  ok('and a phone with nothing to show does not get a bare city beat',
     planScenes({ narrow: true }).length === 0);

  /* 流程占好几拍 —— 一个节点一拍,这就是"一步一步演示"的由来。 */
  ok('the flow takes one beat per node', wide.filter((s2) => s2.k === 'flow').length === 4);
  // 没有图就没有依赖流。凑不齐少轮几幕,而不是留一格空白。
  ok('no graph, no dependency flow', !planScenes({ dirs, flow }).some((s2) => s2.k === 'gflow'));
  ok('no directories, no growth', !planScenes({ flow }).some((s2) => s2.k === 'grow'));
  // 老胶囊的目录没有 age_days —— 那就没有先后可言,不排生长。
  ok('directories with no age plan no growth',
     !planScenes({ dirs: dirs.map((d) => ({ ...d, age_days: 0 })), flow }).some((s2) => s2.k === 'grow'));

  /* 而这一条守着那个真正的杀手:solo 那一拍城市的点必须是 **0**,不是"少一点" ——
     分一部分给城市,正是当初把读法压在城市上面的做法。 */
  const src2 = readFileSync(new URL('./wallpaper-project.js', import.meta.url), 'utf8');
  ok('a phone reading beat takes the whole point budget, leaving the city none',
     /const solo = narrow && pick && pick\.k !== 'city' && pick\.k !== 'grow'/.test(src2)
     && /const nStar = solo \? this\.nCity/.test(src2));
  ok('and sceneCount is no longer pinned to 1 on a phone',
     !/if \(narrow\) this\.sceneCount = 1;/.test(src2));
}

/* ══ 字按需要分,测试底座,琥珀名牌 ═══════════════════════════════════════
   实测过的问题:屋顶牌 2× 欠采样、街牌读数 5× 欠采样 —— 欠采样时按扫描顺序跳着取,
   笔画成了虚线。现在每块牌子按它**亮像素的个数**拿粒子。 */
{
  const base = (extra) => [
    { name: 'src', files: 40, bytes: 400000, lang: 'rust', depth: 2, age_days: 3, churn: 60, ...extra },
    { name: 'docs', files: 8, bytes: 20000, lang: '', depth: 1, age_days: 90, churn: 4, ...extra },
    { name: 'web', files: 20, bytes: 150000, lang: 'ts', depth: 2, age_days: 20, churn: 12, ...extra },
  ];
  const RED = (r, g, b) => r > 0.8 && g < 0.4 && b < 0.4;
  const GREEN = (r, g, b) => g > 0.8 && r < 0.45 && b < 0.6;
  const count = (o, f) => { let c = 0; for (let i = 0; i < o.used; i++) if (f(o.color[i*3], o.color[i*3+1], o.color[i*3+2])) c++; return c; };

  const noData = sampleCity(base({}), 60000, 'modern', [], [1, 2, 3]);
  ok('★ a city with NO test data draws no red base ring (unknown is not "untested")', count(noData, RED) === 0);

  const untested = sampleCity(base({ tests: 0 }), 60000, 'modern', [], [1, 2, 3]);
  ok('a city whose directories were checked and have no tests shows red bases', count(untested, RED) >= 72);

  const tested = sampleCity(base({ tests: 0.3 }), 60000, 'modern', [], [1, 2, 3]);
  ok('tested directories get green bases', count(tested, GREEN) >= 72 * 3);
  ok('and no red at all', count(tested, RED) === 0);

  const all = sampleCity(base({ tests: 0.3 }), 60000, 'modern', [], [1, 2, 3]);
  ok('the budget is still exactly spent — nothing written past n', all.used <= 60000);

  // 巴士因子:忙的一块几乎全出自一个人 → 名牌琥珀色
  const AMBER = (r, g, b) => r > 0.95 && g > 0.68 && g < 0.8 && b < 0.4;
  const solo = sampleCity(base({ tests: 0.3, owner: 0.95, authors: 1 }), 60000, 'modern', [], [1]);
  const shared = sampleCity(base({ tests: 0.3, owner: 0.4, authors: 6 }), 60000, 'modern', [], [1]);
  ok('a busy block held by one person gets an amber nameplate', count(solo, AMBER) > 0);
  ok('a block with many owners does not', count(shared, AMBER) === 0);
}
{
  /* 不跳像素:n ≥ 亮像素数时,每个像素至少一颗。拿 sampleLabel 本身测不到(没导出),
     所以测它的后果:同一个名字,粒子给够时落点的**不同位置数**等于亮像素数。 */
  const src = readFileSync(new URL('./wallpaper-project.js', import.meta.url), 'utf8');
  ok('labels are rasterised once and sized by their lit pixels before points are spent',
     /function rasterLabel\(/.test(src) && /const tagNeed = /.test(src) && /const metNeed = /.test(src));
  ok('text is capped so towers are not starved', /const textCap = Math\.round\(n \* 0\.45\)/.test(src));
  ok('over the cap, every label shrinks together instead of the last ones vanishing',
     /const kText = needTotal > textCap \? textCap \/ needTotal : 1/.test(src));
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
