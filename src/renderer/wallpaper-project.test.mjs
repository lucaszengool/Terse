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
import { sampleFlow } from './wallpaper-project.js';
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

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
