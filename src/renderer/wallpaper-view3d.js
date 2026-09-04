/**
 * wallpaper-view3d.js — 3D 自由视角的**纯数学**部分。
 *
 * 单独拆出来只有一个理由:它必须能被测到。引擎(mineradio-wallpaper.js)顶上就
 * `import * as THREE from 'three'`,而 three 是靠宿主页面的 import map 解析的裸
 * 说明符 —— node 里 import 不进来,于是整台引擎连同这几行相机数学一起测不了。
 * 这里没有任何 three、没有 DOM,进什么出什么。
 *
 * 机位是**绕原点的球坐标**:az 方位角、el 仰角(都是弧度),dist 是推拉倍数。
 * 半径不写在机位里,由每一层自己拿 camZ 乘上去 —— SILK 在 12、PULSE 在 62,
 * 那是两个尺度的取景,共用一个绝对距离会让极光那层直接飞出画面。
 */

/** 正对机位。az=el=0、dist=1 时相机正好落回 (0, 0, camZ) —— 也就是这个功能出现
 *  之前的那台相机。"关掉 3D" 就是插值回这里,不是另一套代码路径。 */
export const VIEW_DEFAULT = { on: false, az: 0, el: 0, dist: 1, dim: false };

/** 仰角上限 ~66°。这几个数是照着画面定的,不是随手写的:再高就接近垂直俯视,
 *  那张浮雕缩成一条,极光带占满整幅画 —— 让人能转到没有内容的角度,自由度就成了
 *  一个能把画面弄坏的开关。 */
export const VIEW_EL_MAX = 1.15;

/** 推拉范围。比 0.55 更近,相机就压到粒子网格上,规则的点阵会显出来(那正是 SILK
 *  平时不常亮的原因);比 2.6 更远,整片场景缩成中间一小团,四周全是黑的。 */
export const VIEW_DIST_MIN = 0.55;
export const VIEW_DIST_MAX = 2.6;

/** 拖动灵敏度:一屏宽 ≈ 转半圈。 */
export const ORBIT_AZ_PER_PX = 0.0062;
export const ORBIT_EL_PER_PX = 0.0048;

const TAU = Math.PI * 2;

/**
 * 外面进来的机位一律先过这里。
 *
 * 夹范围不是防御式编程:这几个值会被写进 ~/.terse/wallpaper.json,那是一个用户
 * 可以手改、也会被旧版本写过的普通文件。授权同样在这里与上 —— 一份 `"on": true`
 * 的配置(手改的,或者订阅到期前存下的)不该让免费用户进 3D。
 *
 * @param {{on?:boolean, az?:number, el?:number, dist?:number}|null} v
 * @param {boolean} pro
 */
export function sanitizeView(v, pro) {
  const s = Object.assign({}, VIEW_DEFAULT, (v && typeof v === 'object') ? v : null);
  const az = Number.isFinite(+s.az) ? +s.az : 0;
  const el = Number.isFinite(+s.el) ? +s.el : 0;
  const dist = Number.isFinite(+s.dist) && +s.dist !== 0 ? +s.dist : 1;
  return {
    on: !!pro && !!s.on,
    // 归一到 (−π, π]:拖过头一圈之后 az 会一直涨下去,存盘前收回来,
    // 否则"转了 400°"和"转了 40°"在配置里是两个数,读回来还得再走一段。
    // 已经在范围里的**原样返回**:每存一次都过一遍浮点取模,角度会慢慢漂。
    az: (az > -Math.PI && az <= Math.PI) ? az : ((az + Math.PI) % TAU + TAU) % TAU - Math.PI,
    el: Math.max(-VIEW_EL_MAX, Math.min(VIEW_EL_MAX, el)),
    dist: Math.max(VIEW_DIST_MIN, Math.min(VIEW_DIST_MAX, dist)),
    // 3D 里要不要把底下那张真壁纸压黑。**默认不压**:压黑好看,但代价是用户自己
    // 的桌面壁纸没了 —— 那是他选的图,不该由这个功能替他决定。想要"粒子浮在纯黑
    // 空间里"的人自己打开。(置顶模式下根本不画底图,这个开关也就没有意义。)
    dim: !!s.dim,
  };
}

/**
 * 球坐标 → 相机位置。r = 这一层的 camZ × dist。
 *
 * az=el=0 必须**精确**给出 (0, 0, r)(不是 1e−17 的近似):关掉 3D 之后画面要和
 * 从来没开过 3D 逐位相同,而相机位置差一点点,透视投影出来的每个点都会差一点点。
 */
export function orbitPosition(r, az, el) {
  const ce = Math.cos(el), se = Math.sin(el);
  return { x: r * ce * Math.sin(az), y: r * se, z: r * ce * Math.cos(az) };
}

/** 两个角之间的最短弧。从 +179° 拖到 −179° 应该是走 2°,不是绕回来 358°。 */
export function shortestArc(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}
