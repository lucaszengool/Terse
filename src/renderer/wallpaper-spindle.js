/**
 * wallpaper-spindle.js — Pro 风格「星轨炸环 · Orbit Burst」的场景层。
 *
 * 照着一段参考视频逐帧还原的(抖音「python粒子运动发射代码」那一条)。逐帧看下来,
 * 它不是一个摆在那里的物体,而是一道**正在飞的粒子光束**:
 *
 *   · 光束的**尖头**从右往左一直在走,身后拖出来的就是那根"纺锤体" —— 越往后越粗,
 *     身上是一节一节的"铜钱/桶";
 *   · 圆环**永远在尖头炸开**:从尖头的粗细猛地张开、边张边折成 C 形 / 马鞍形,
 *     环上挂着星星、爱心、方块、圆圈、十字星;然后它**留在原地**,尖头继续往前走,
 *     所以看上去是这个环沿着光束往后退,慢慢摊平成一片竖着的法兰;
 *   · 视频开头那组"同心轨道",就是最近炸的几个环从正前方看过去叠在一起;
 *   · 流线是尖头的**尾迹**:在尖头汇成一点,向后张开、平行拉长,远端向外翘;
 *     线上漂着三角和音符,往后流;
 *   · 机位从几乎正对尖头,慢慢转到正侧面(尖头在左,光束横着)。
 *
 * 在 Terse 里:agent log 的那句大字就停在尖头上。每当尖头炸一个大环,那句字就
 * 沿着**同一个环的平面**炸开(GLYPH_MOVE.ORBIT,环的法线 = 光束方向,见 ringNormal)。
 *
 * 实现上"尖头在走"= 世界在往后流:每颗光束粒子在世界里是**不动的**(记着自己的世界
 * 坐标 aW),它离尖头的距离 d = mod(aW + 速度·t, L) 一直在长,长满一圈就从尖头重新
 * 出生 —— 所以尖头永远在同一个地方,一切都在从它那里流出来。全部在顶点着色器里算,
 * CPU 每帧只写几十个 uniform。和字形层共用 SILK 的相机,3D 自由视角一转它跟着转。
 */
import * as THREE from 'three';

/* ── 尺寸(SILK 平面坐标:取景半高 2.4,相机 z=12)── */
const TRAIL_LEN = 12.0;        // 光束全长(尖头到尾巴),尾巴远在画面外
const HEAD_X = -3.4;           // 尖头在 pivot 本地坐标里的位置;光束朝 +x 拖出去
const SPEED = 1.10;            // 尖头的飞行速度(= 世界往后流的速度),单位/秒
const COIN_SP = 0.30;          // 身上"铜钱"的间距(世界坐标)
const BODY_POINTS = 320000;   // 空间站的细节(桁架、舷窗、翼板网格)要点数撑着
/** 光束身上的分段周期(世界坐标)。视频里的光束不是一根光滑的管子,而是一节一节车床车出来的:
 *  鼓包 → 细颈 → 一摞铜钱 → 台阶,周而复始,整段随世界往后流。 */
const SEG = 2.6;
const RING_SLOTS = 17;

/* ── 炸环的配色(用户 2026-09-23:「星轨还有粒子 text 要有颜色变化,颜色要很炫酷」)──
   一拍一个颜色,**环和它那句字同色**:环从尖头炸出来时领一个色,之后它带着这个色
   一路漂回光束尾巴 —— 于是任一帧画面里,整条光束上是一串按时间排开的彩环,
   而不是整屏一起变色(那种"全局调色"看着像加了个滤镜,不像每一次爆炸各有各的能量)。
   ⚠️ 核心仍然烧到白:`vColor = mix(色, 白, hot)`。直接用纯色画会失掉"亮到过曝"的质感 ——
      参考片里最亮的地方永远是白的,颜色只出现在边缘和余晖里。
   ⚠️ 顺序是**排过的**,不是色轮均分:相邻两拍必须差得够远(青→品红→琥珀…),
      按色相均匀走一圈的话,连着两个环看起来是同一个颜色。 */
export const BURST_COLORS = [
  [0.25, 0.91, 1.00],   // 电光青
  [1.00, 0.31, 0.85],   // 品红
  [0.55, 0.42, 1.00],   // 紫罗兰
  [1.00, 0.69, 0.23],   // 琥珀
  [0.44, 1.00, 0.55],   // 青柠
  [0.36, 0.60, 1.00],   // 冰蓝
];
const RING_POINTS = 1500;   // 视频里的环是**虚线**:一颗颗看得清的点,不是一条实心亮带
const LINE_COUNT = 10;
const LINE_POINTS = 1400;
const LINE_MARKS = 8;
const DUST_POINTS = 500;
const RING_OPEN = 1.60;        // 环从出生张到最大用多久(秒)—— 慢慢舒展开,不是一下炸开(09-22)
/** 炸环的节拍。视频逐帧量出来的:尖头大约每 0.62–0.66 秒炸一次(0.2 / 0.8 / 1.45 / 2.05s…)。
 *  字的出现和炸开**只**落在这个节拍上 —— 引擎在拍子那一帧决定这一拍是小环还是"字拍"。 */
// 视频本身是 0.65 秒一拍;现在**每一拍都带一句字**,0.65 秒读不完一句,放慢到 0.8。
export const BEAT = 0.80;
/** 每一拍光束往前"顶"一格的距离。视频里不是匀速流:每炸一次,尖头后面冒出一片新的法兰,
 *  整根往后**一下子**推一格,然后几乎停住等下一拍 —— 这就是"一下下推进"。 */
const STEP = 0.80;
const PUSH = 0.30;             // 推一格用多久(秒);其余时间只剩一点点匀速爬行
const RING_LIFE = RING_SLOTS * BEAT;              // 槽位轮一圈的时间;这时它早已流到画面外

/* 图形图集:4×2 格,顺序和着色器里的编号一致 */
const SPR = { DOT: 0, STAR: 1, HEART: 2, SQUARE: 3, CIRCLE: 4, TRI: 5, NOTE: 6, GLINT: 7 };

/** 视频里的挂件全是**白色轮廓**(星星是实心的),所以图集是画出来的而不是字体字符:
 *  字体在 Windows/mac 上长得不一样,轮廓粗细也没法控。 */
function makeSpriteAtlas() {
  const C = 64, cv = document.createElement('canvas');
  cv.width = C * 4; cv.height = C * 2;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineJoin = 'round'; g.lineCap = 'round';
  const cell = (i, fn) => { g.save(); g.translate((i % 4) * C + C / 2, ((i / 4) | 0) * C + C / 2); fn(); g.restore(); };
  // 0 soft dot —— 和壁纸其余各层同一种径向渐变
  cell(0, () => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, C / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.28, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.62, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-C / 2, -C / 2, C, C);
  });
  // 1 五角星(实心)
  cell(1, () => {
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 9 : 22, a = -Math.PI / 2 + k * Math.PI / 5;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath(); g.fill();
  });
  g.lineWidth = 4.2;
  // 2 爱心(轮廓)
  cell(2, () => {
    g.beginPath(); g.moveTo(0, 17);
    g.bezierCurveTo(-26, 0, -14, -22, 0, -8);
    g.bezierCurveTo(14, -22, 26, 0, 0, 17);
    g.stroke();
  });
  // 3 圆角方块(轮廓)
  cell(3, () => { g.beginPath(); g.roundRect ? g.roundRect(-15, -15, 30, 30, 6) : g.rect(-15, -15, 30, 30); g.stroke(); });
  // 4 圆圈
  cell(4, () => { g.beginPath(); g.arc(0, 0, 15, 0, Math.PI * 2); g.stroke(); });
  // 5 三角
  cell(5, () => { g.beginPath(); g.moveTo(0, -17); g.lineTo(17, 13); g.lineTo(-17, 13); g.closePath(); g.stroke(); });
  // 6 音符
  cell(6, () => {
    g.beginPath(); g.ellipse(-6, 13, 8, 6, -0.4, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(1, 12); g.lineTo(1, -20); g.quadraticCurveTo(10, -12, 15, -6); g.stroke();
  });
  // 7 四角十字星闪光:两道细长的光芒 + 一个亮核
  cell(7, () => {
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath(); g.ellipse(0, 0, C / 2, 2.2, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(0, 0, 2.2, C / 2, 0, 0, Math.PI * 2); g.fill();
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 12);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-12, -12, 24, 24);
  });
  const t = new THREE.CanvasTexture(cv);
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/* 共用的 GLSL 片段:离尖头 d 处光束有多粗,以及字的"留白" */
const GLSL_COMMON = `
// 分段轮廓(世界坐标 w 上):鼓包 / 细颈 / 台阶。返回半径倍数。
float segR(float w) {
  float ph = fract(w / ${SEG.toFixed(3)});
  float bulb = smoothstep(0.02, 0.14, ph) * (1.0 - smoothstep(0.26, 0.38, ph));
  float neck = smoothstep(0.36, 0.42, ph) * (1.0 - smoothstep(0.46, 0.52, ph));
  float step1 = smoothstep(0.84, 0.88, ph);
  float blk = 0.05 * sin(w * 23.0);   // 细台阶;不能用 sign(),那会把轮廓抖成毛边
  return 0.95 + 0.42 * bulb * (0.8 + 0.2 * sin(ph * 60.0)) - 0.32 * neck + 0.12 * step1 + blk;
}
// 这一段是不是"一摞铜钱"
float inCoins(float w) { float ph = fract(w / ${SEG.toFixed(3)}); return step(0.52, ph) * step(ph, 0.84); }
// 光束的粗细:尖头是一个锐利的锥,之后是细颈,越往后越粗(尾迹在张开)
float beamR(float d) {
  // 和视频对过比例:侧面时光束粗约占画面高度的五分之一,是一整根实心的亮柱
  float cone = smoothstep(0.0, 1.05, d);
  return (0.08 + 0.40 * pow(cone, 0.65)) + 0.045 * max(0.0, d - 0.8);
}
// 字的"留白":光束从字后面穿过时,把字那一块让出来 —— 否则白字压在白点云上读不出来。
// uHole = (中心 NDC x, y, 半宽, 半高),uHoleAmt = 让多少。按裁剪空间算,3D 视角下也成立。
uniform vec4 uHole;
uniform float uHoleAmt;
float holeK(vec4 clip) {
  vec2 d = (clip.xy / clip.w - uHole.xy) / max(uHole.zw, vec2(1e-3));
  return 1.0 - uHoleAmt * (1.0 - smoothstep(0.55, 1.15, length(d)));
}
`;

/* ── 光束本体 = 一座"空间站"脊梁(09-22 用户:「星轨本身要像国际空间站那种非常精细、很多细节,然后往前进」)──
   逐帧看参考片:光束不是一根光滑的管子,而是一座**造出来的**塔 —— 尖顶、一层层半径不同的舱段(每段两头一圈亮边)、
   细颈、鼓出来的节点球、一摞铜钱、横在身上的法兰盘,远处更粗。这里在 CPU 上按一张"舱段表"把它造出来:
     HULL 舱段(壳面 + 两头亮边 + 纵向接缝 + 一排排舷窗)· TRUSS 桁架(四根主梁 + 每格 X 形斜撑)
     DISC 法兰盘(外沿 + 三圈内环 + 辐条)· NODE 节点球(球面 + 四个对接口)· COINS 一摞铜钱
     PANEL 太阳能翼(一对翼板,网格线 + 边框)· NECK 细颈 · BELL 喇叭段
   舱段表用固定种子生成 —— 每台机器、每次打开都是同一座站。粒子只记"它在站上的哪一点"(aW 沿轴、aYZ 截面、
   aN 法线、aL 亮度),流动 / 一拍一格的推进 / 自转 / 尖头的锥形收口全在顶点着色器里,和原来一样。 */
const mulberry = (seed) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

/** 舱段表:沿世界坐标 0..TRAIL_LEN 首尾相接。每段 = { t: 类型, w0, len, …参数 } */
function stationPlan() {
  const R = mulberry(20260922);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  // 节奏:大体是"细颈 → 舱段 → 法兰/节点 → 桁架带翼 → 铜钱 → 喇叭",但每一轮都重新抽
  const plan = [];
  let w = 0.05;
  const push = (m) => { m.w0 = w; plan.push(m); w += m.len; };
  while (w < TRAIL_LEN - 0.4) {
    push({ t: 'NECK', len: 0.10 + R() * 0.14, r: 0.30 + R() * 0.12 });
    push({ t: 'HULL', len: 0.34 + R() * 0.46, r: 0.82 + R() * 0.36, win: R() < 0.7 });
    const mid = pick(['DISC', 'NODE', 'DISC', 'COINS']);
    if (mid === 'DISC') push({ t: 'DISC', len: 0.05, r: 1.9 + R() * 0.7, spokes: 8 + Math.floor(R() * 6) });
    if (mid === 'NODE') push({ t: 'NODE', len: 0.0, r: 0.95 + R() * 0.25 });
    if (mid === 'COINS') push({ t: 'COINS', len: 0.0, n: 5 + Math.floor(R() * 4), r: 1.05 + R() * 0.3 });
    if (plan[plan.length - 1].t === 'NODE') { const m = plan[plan.length - 1]; m.len = m.r * 2 * 0.42; w = m.w0 + m.len; }
    if (plan[plan.length - 1].t === 'COINS') { const m = plan[plan.length - 1]; m.len = m.n * 0.055; w = m.w0 + m.len; }
    if (R() < 0.75) push({ t: 'TRUSS', len: 0.36 + R() * 0.40, h: 0.42 + R() * 0.12, panel: R() < 0.8,
                           span: 1.5 + R() * 0.9, ang: R() * Math.PI });
    push({ t: pick(['HULL', 'BELL', 'COINS']), len: 0.30 + R() * 0.35, r: 0.9 + R() * 0.3, r2: 1.2 + R() * 0.35,
           n: 4 + Math.floor(R() * 4), win: R() < 0.5 });
    const last = plan[plan.length - 1];
    if (last.t === 'COINS') { last.len = last.n * 0.055; w = last.w0 + last.len; }
  }
  return plan;
}
/** 每段分到多少粒子(相对权重)—— 细节多的给得多 */
const MOD_WEIGHT = { NECK: 0.25, HULL: 1.3, DISC: 1.0, NODE: 0.9, COINS: 0.7, TRUSS: 0.8, BELL: 1.0 };

/** 在一段上取一个点。返回 [x 沿轴(段内), y, z, nx, ny, nz, 亮度, 是否"线/边"(不吃轮廓光)] */
function sampleModule(m, R) {
  const TAU = Math.PI * 2, u = R(), a = R() * TAU;
  const ca = Math.cos(a), sa = Math.sin(a);
  switch (m.t) {
    case 'NECK': return [R() * m.len, ca * m.r, sa * m.r, 0, ca, sa, 0.9, 0];
    case 'HULL': case 'BELL': {
      const x = R() * m.len;
      const r = m.t === 'BELL' ? m.r + (m.r2 - m.r) * Math.pow(x / m.len, 1.6) : m.r;
      if (u < 0.16) { const xe = R() < 0.5 ? 0 : m.len; const re = m.t === 'BELL' ? (xe ? m.r2 : m.r) : m.r;   // 两头亮边
        return [xe, ca * re * 1.03, sa * re * 1.03, 0, ca, sa, 2.1, 1]; }
      if (u < 0.27) { const k = Math.floor(R() * 8), aa = k / 8 * TAU;                                      // 纵向接缝
        return [x, Math.cos(aa) * r * 1.01, Math.sin(aa) * r * 1.01, 0, Math.cos(aa), Math.sin(aa), 1.5, 1]; }
      if (u < 0.36 && m.win) { const rows = 5, cols = 18;                                                   // 舷窗
        const xi = (Math.floor(R() * rows) + 0.5) / rows * m.len, aa = (Math.floor(R() * cols) + 0.5) / cols * TAU;
        const rr = m.t === 'BELL' ? m.r + (m.r2 - m.r) * Math.pow(xi / m.len, 1.6) : m.r;
        return [xi, Math.cos(aa) * rr * 1.02, Math.sin(aa) * rr * 1.02, 0, Math.cos(aa), Math.sin(aa), 2.4, 1]; }
      if (u < 0.44) { const rr = Math.sqrt(R()) * r * 0.9; return [x, ca * rr, sa * rr, 0, ca, sa, 0.35, 0]; }   // 里面
      // 壳面:车床纹 —— 一圈圈细亮线
      const lathe = Math.pow(Math.abs(Math.sin(x * 70)), 8);
      return [x, ca * r, sa * r, 0, ca, sa, 0.85 + 0.9 * lathe, 0];
    }
    case 'DISC': {
      const x = (R() - 0.5) * m.len;
      if (u < 0.34) { const r = m.r * (1 + (R() - 0.5) * 0.012); return [m.len / 2 + x, ca * r, sa * r, 0, ca, sa, 2.3, 1]; }
      if (u < 0.60) { const r = m.r * [0.46, 0.64, 0.82][Math.floor(R() * 3)]; return [m.len / 2, ca * r, sa * r, 1, 0, 0, 1.7, 1]; }
      if (u < 0.84) { const k = Math.floor(R() * m.spokes), aa = k / m.spokes * TAU, r = 0.35 + R() * (m.r - 0.35);
        return [m.len / 2, Math.cos(aa) * r, Math.sin(aa) * r, 1, 0, 0, 1.5, 1]; }
      const r = Math.sqrt(R()) * m.r; return [m.len / 2 + x, ca * r, sa * r, 1, 0, 0, 0.4, 0];
    }
    case 'NODE': {
      const c = m.len / 2;
      if (u < 0.2) { // 四个对接口:朝 ±y / ±z 的小圆口,口面垂直于它朝的方向
        const k = Math.floor(R() * 4), sy = [1, -1, 0, 0][k], sz = [0, 0, 1, -1][k];
        const pr = 0.3 * m.r, t1 = R() * TAU, ex = Math.cos(t1) * pr, ey = Math.sin(t1) * pr;
        const out = m.r * 1.02;
        return sy ? [c + ex, sy * out, ey, 0, sy, 0, 2.2, 1] : [c + ex, ey, sz * out, 0, 0, sz, 2.2, 1];
      }
      const zz = R() * 2 - 1, s = Math.sqrt(1 - zz * zz);
      const nx = zz, ny = s * ca, nz = s * sa;
      return [c + nx * m.r * 0.42, ny * m.r, nz * m.r, nx, ny, nz, 1.0, 0];
    }
    case 'COINS': {
      const k = Math.floor(R() * m.n), x = (k + 0.5) * 0.055;
      const r = m.r * (0.92 + 0.16 * Math.sin(k * 2.3)) * (u < 0.65 ? 1 : 0.84);
      return [x + (R() - 0.5) * 0.006, ca * r, sa * r, 0, ca, sa, u < 0.65 ? 1.9 : 1.1, u < 0.65 ? 1 : 0];
    }
    case 'TRUSS': {
      const h = m.h, bays = Math.max(2, Math.round(m.len / 0.11));
      const C = [[h, h], [-h, h], [-h, -h], [h, -h]];
      if (m.panel && u < 0.46) {
        // 太阳能翼:一对翼板,板面在(轴, 径向 ang)平面里;网格线 + 边框,板心很淡
        const side = R() < 0.5 ? 1 : -1, ua = Math.cos(m.ang) * side, va = Math.sin(m.ang) * side;
        const r0 = h * 1.2, x = R() * m.len, s = r0 + R() * m.span, v = R();
        let lum = 0.45, line = 0, xx = x, ss = s;
        if (v < 0.35) { ss = r0 + Math.round((s - r0) / 0.16) * 0.16; lum = 1.5; line = 1; }        // 横格线
        else if (v < 0.6) { xx = Math.round(x / 0.09) * 0.09; lum = 1.5; line = 1; }                 // 竖格线
        else if (v < 0.75) { if (R() < 0.5) xx = R() < 0.5 ? 0 : m.len; else ss = R() < 0.5 ? r0 : r0 + m.span; lum = 2.2; line = 1; }
        xx = Math.min(m.len, Math.max(0, xx)); ss = Math.min(r0 + m.span, ss);
        return [xx, ua * ss, va * ss, 0, -va, ua, lum, line];
      }
      if (u < 0.72) { const c = C[Math.floor(R() * 4)]; return [R() * m.len, c[0], c[1], 0, c[0] / h, c[1] / h, 1.7, 1]; }  // 主梁
      const b = Math.floor(R() * bays), f = Math.floor(R() * 4), t = R();                       // 斜撑
      const A = C[f], B = C[(f + 1) % 4], flip = (b + f) % 2;
      const x = (b + t) / bays * m.len, P = flip ? [B[0] + (A[0] - B[0]) * t, B[1] + (A[1] - B[1]) * t]
                                                 : [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
      return [x, P[0], P[1], 0, P[0] / h, P[1] / h, 1.3, 1];
    }
  }
  return [0, 0, 0, 0, 1, 0, 0, 0];
}

function buildBody() {
  const n = BODY_POINTS;
  const w = new Float32Array(n), yz = new Float32Array(n * 2), nrm = new Float32Array(n * 3),
        lum = new Float32Array(n), r2 = new Float32Array(n);
  const plan = stationPlan();
  const cum = []; let tot = 0;
  for (const m of plan) { tot += MOD_WEIGHT[m.t] * (m.t === 'DISC' || m.t === 'NODE' || m.t === 'COINS' ? 0.5 : m.len) * (m.panel ? 1.8 : 1); cum.push(tot); }
  const R = mulberry(7);
  const TIP = Math.floor(n * 0.035);
  for (let i = 0; i < n; i++) {
    r2[i] = R();
    if (i < TIP) {
      // 尖顶:不随世界流动,永远钉在尖头。锐利的锥 + 三圈细环(塔尖上的"节")—— aW < 0 = 尖顶
      const d = Math.pow(R(), 0.8) * 0.95, a = R() * Math.PI * 2, ring = R() < 0.3;
      const dd = ring ? [0.22, 0.45, 0.7][Math.floor(R() * 3)] : d;
      w[i] = -Math.max(0.001, dd);
      yz[i * 2] = Math.cos(a); yz[i * 2 + 1] = Math.sin(a);
      nrm[i * 3 + 1] = Math.cos(a); nrm[i * 3 + 2] = Math.sin(a);
      lum[i] = ring ? -2.4 : -(0.9 + (1 - d) * 0.8);        // 负号 = 尖顶;绝对值 = 亮度
      continue;
    }
    const q = R() * tot;
    let k = 0; while (cum[k] < q) k++;
    const m = plan[k];
    const s = sampleModule(m, R);
    w[i] = (m.w0 + s[0]) % TRAIL_LEN;
    yz[i * 2] = s[1]; yz[i * 2 + 1] = s[2];
    nrm[i * 3] = s[3]; nrm[i * 3 + 1] = s[4]; nrm[i * 3 + 2] = s[5];
    lum[i] = s[6] + (s[7] ? 10 : 0);                       // +10 = 线/边:不吃轮廓光,永远亮
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aW', new THREE.BufferAttribute(w, 1));
  geo.setAttribute('aYZ', new THREE.BufferAttribute(yz, 2));
  geo.setAttribute('aN', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aL', new THREE.BufferAttribute(lum, 1));
  geo.setAttribute('aR2', new THREE.BufferAttribute(r2, 1));
  return geo;
}

const BODY_VS = `
precision highp float;
attribute float aW, aL, aR2;
attribute vec2 aYZ;
attribute vec3 aN;
uniform float uTime, uFlow, uSpin, uPixel, uVis, uBloom, uBlast;
uniform vec3 uHeadC;   // 此刻尖头的颜色(最近一次炸环领到的)
${GLSL_COMMON}
varying vec3 vColor;
varying float vA;
void main(){
  float L = ${TRAIL_LEN.toFixed(3)};
  bool tip = aL < 0.0;
  float base = abs(aL);
  bool edge = base > 5.0;
  if (edge) base -= 10.0;
  float d, sc;
  if (tip) {
    // 尖顶:钉在尖头,半径 = 锥的包络
    d = -aW;
    sc = beamR(d) * 0.95;
  } else {
    // 世界往后流(一拍一格,见 update 里的 _flow);舱段离开尖头一小段后才"长"到全尺寸
    d = mod(aW + uFlow, L);
    float grow = smoothstep(0.22, 1.05, d);
    sc = beamR(d) * mix(0.25, 1.0, grow);
    base *= grow;
  }
  // 自转:整座站绕轴慢慢转(翼板、桁架跟着一起转,所以是整体刚性的转,不是每颗粒子各转各的)
  float a = uSpin + d * 0.05;
  float c = cos(a), s = sin(a);
  vec2 q = mat2(c, s, -s, c) * aYZ;
  vec3 p = vec3(${HEAD_X.toFixed(3)} + d, q * sc);
  vec3 nl = vec3(aN.x, mat2(c, s, -s, c) * aN.yz);
  // 拍上那一下:整座站沿径向鼓一下(越靠近尖头越猛)
  // (09-22 用户:炸环时星轨不要任何晃动 / 闪动,一直平稳丝滑 —— 原来这里拍上整座站沿径向鼓一下,已去掉)
  // 细颗粒:吸到 ~2.5px 的细网格上 —— 一粒粒硬朗的亮点,不是雾;精细结构不能吸太粗
  p = floor(p * 44.0 + 0.5) / 44.0 + (vec3(aR2, fract(aR2 * 7.3), fract(aR2 * 13.1)) - 0.5) * 0.004;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float lum = base;
  if (!edge) {
    // 轮廓光:侧对镜头的面最亮;正面也留足底子(「很炫很亮」)
    vec3 nrm = normalize((modelViewMatrix * vec4(nl, 0.0)).xyz);
    float rim = 1.0 - abs(dot(nrm, normalize(-mv.xyz)));
    lum *= 0.75 + 1.50 * rim * rim;
  }
  lum *= 0.85 + 0.15 * sin(uTime * 2.4 + aR2 * 25.0);
  // 刚出尖头的一段更亮;尾巴在画面外淡掉
  lum *= 1.0 + 0.8 * exp(-d * 1.2);
  lum *= 1.0 - smoothstep(L * 0.62, L * 0.92, d);
  // 拍上的白闪:从尖头沿着站身往后烧一段
  // 闪点:站身上细碎的高光一直在跳
  float spark = step(0.978, aR2) * pow(0.5 + 0.5 * sin(uTime * 5.0 + aR2 * 900.0), 4.0);
  lum += spark * 2.6;
  /* 尖头那一段染上当拍的颜色,往尾巴渐回冷蓝 —— 于是每炸一次环,光束的头部整个换一次色,
     而身子还是那条稳定的冷色脊骨(用户 09-22 定过:炸环时星轨本身不许晃、不许闪)。 */
  /* ⚠️ 第一版把染色**只**给尖头 2.4 个单位、而且白的那一档不封顶 —— 结果整条光束
     还是白的:lum 在这具身体上大部分接近 1,mix 到白就吃掉了 0.75,颜色只剩 25%。
     现在:整条都染(颜色是这一拍的身份),**但把白封在 0.62** —— 高光仍然烧白,
     所以"像空间站那样精细发亮"没丢,底色却明确跟着每一拍换。 */
  vec3 cool = mix(vec3(0.42, 0.56, 1.0), uHeadC, 0.86);
  /* ⚠️ 0.62 还是太白:这一层是**加性**混合,320k 个点在身子上层层相叠,
     和值本来就冲到白 —— 再让 62% 直接混白,颜色就只剩一层薄薄的色偏(实测第 330 帧)。
     0.30 是"底色明确是这一拍的颜色、但棱和高光仍然发白"的那一档。 */
  vColor = mix(cool, vec3(0.97, 0.99, 1.0), clamp(lum * 0.30 + aR2 * 0.08, 0.0, 0.30));
  vA = lum * uVis * 1.35;
  float sz = (1.35 + aR2 * 1.0) * (edge ? 1.1 : 1.0) * (1.0 + spark * 1.8);
  gl_PointSize = sz * uPixel * uBloom * (13.0 / max(2.0, -mv.z));
  gl_Position = projectionMatrix * mv;
  vA *= holeK(gl_Position);
}
`;

/* ── 环 ──
   每颗粒子知道自己属于第几个环(aRing),环的状态整组写在 uniform 数组里:
   uRP[i] = (年龄, 强度, 最大半径, 种子);年龄 < 0 = 这个槽没在用。
   环在尖头出生,然后留在世界里 —— 离尖头的距离 = 速度 × 年龄。 */
function buildRings() {
  const n = RING_SLOTS * RING_POINTS;
  const ring = new Float32Array(n), ang = new Float32Array(n), rnd = new Float32Array(n), spr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ring[i] = Math.floor(i / RING_POINTS);
    ang[i] = Math.random() * Math.PI * 2;
    rnd[i] = Math.random();
    const q = Math.random();
    // 大部分是细点(构成那一圈"虚线"),少量挂件,极少量十字星
    // 视频里环上的挂件很密(一圈几十个星星/爱心/方块),点和挂件差不多是九比一
    spr[i] = q < 0.90 ? SPR.DOT
           : q < 0.945 ? SPR.STAR : q < 0.952 ? SPR.HEART : q < 0.972 ? SPR.SQUARE
           : q < 0.982 ? SPR.CIRCLE : q < 0.992 ? SPR.TRI : SPR.GLINT;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aRing', new THREE.BufferAttribute(ring, 1));
  geo.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('aSpr', new THREE.BufferAttribute(spr, 1));
  return geo;
}

const RING_VS = `
precision highp float;
attribute float aRing, aAng, aRand, aSpr;
uniform vec4 uRP[${RING_SLOTS}];
uniform float uRD[${RING_SLOTS}];   // 这个环离尖头多远(CPU 按一格一格的推进算好)
uniform vec3 uRC[${RING_SLOTS}];    // 这个环出生时领到的颜色(见 BURST_COLORS)
uniform float uTime, uPixel, uVis, uBloom;
${GLSL_COMMON}
varying float vA, vSpr, vRot;
varying vec3 vColor;
void main(){
  int ri = int(aRing + 0.5);
  vec4 P = vec4(-1.0); float D = 0.0; vec3 C = vec3(0.55, 0.64, 1.0);
  // WebGL1 不能用变量下标取 uniform 数组 —— 展开一个常量循环挑出来
  for (int k = 0; k < ${RING_SLOTS}; k++) { if (k == ri) { P = uRP[k]; D = uRD[k]; C = uRC[k]; } }
  if (P.x < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  float age = P.x, str = P.y, Rmax = P.z, seed = P.w;
  // 离尖头多远:环留在原地,尖头一格一格往前顶
  float d = D;
  // 张开:缓进缓出地舒展(09-22 用户:「不要有那种一下一下炸开的感觉」—— 原来是出膛式,第一帧就全速)
  float t = clamp(age / ${RING_OPEN.toFixed(3)}, 0.0, 1.0);
  float e = t * t * (3.0 - 2.0 * t);
  float r0 = beamR(0.25);
  // 厚度:刚炸开时是一圈细虚线,往后慢慢松成一片(视频里后面的法兰是"一盘"挂件)
  float spread = 0.006 + 0.022 * smoothstep(0.5, 4.0, age);
  // 张满之后还在慢慢变大 —— 挂在环上的字散开的时候,环也还在长
  float R = mix(r0, Rmax, e) * (1.0 + 0.10 * max(0.0, age - ${RING_OPEN.toFixed(3)})) * (1.0 + (aRand - 0.5) * spread * 2.0);
  // 旋:边张开边拧,之后慢慢转
  float a = aAng + e * (0.8 + seed * 0.9) + age * (0.10 + seed * 0.10) * (seed > 0.5 ? 1.0 : -1.0);
  // 折:张开时折成 C 形 / 马鞍形(边沿朝前后翻),流到后面慢慢摊平成竖着的一片
  float fold = (0.20 + 0.55 * e) * (1.0 - 0.96 * smoothstep(0.6, 2.2, age)) * (0.55 + seed * 0.9);
  float ax = sin(a * 2.0 + seed * 6.28) * fold * R * 0.42        // 马鞍
           - (1.0 - e) * 0.35                                     // 出生时略在尖头前面
           + (aRand - 0.5) * spread * 0.8;
  vec3 p = vec3(${HEAD_X.toFixed(3)} + d + ax, cos(a) * R, sin(a) * R);
  // 炸的那一瞬先是尖头上一团**亮雾**(视频里每一拍的第一帧),0.3 秒内才理成一个环
  float cloud = 0.0;   // 出生时不再有那一团亮雾(09-22:环从光束上舒展出来,不是炸出来)
  vec3 jit = vec3(fract(aRand * 17.3) - 0.5, fract(aRand * 29.1) - 0.5, fract(aRand * 41.7) - 0.5);
  p += jit * cloud * (0.10 + 0.14 * str);
  // 挂件往外甩得更远一点:同一个环上的形状和点分成两层
  if (aSpr > 0.5) p.yz *= 1.0 + 0.03 * aRand * e;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float fade = smoothstep(0.0, 0.45, age) * (1.0 - smoothstep(0.45, 1.0, d / ${(TRAIL_LEN * 0.55).toFixed(3)}));
  // 刚炸开的那一秒最亮,之后稳定下来
  float flash = 1.0;   // 出生不闪(09-22)
  float tw = 0.72 + 0.28 * sin(uTime * (3.0 + aRand * 4.0) + aRand * 40.0);
  vA = fade * flash * tw * uVis * (aSpr < 0.5 ? 0.75 : 1.15) * (0.75 + str * 0.40);
  vSpr = aSpr;
  vRot = aRand * 6.2831 + uTime * (aRand - 0.5) * 2.0;      // 挂件自己在翻
  // 亮的那一档烧到白,暗的一档留住环自己的颜色 —— 颜色出现在边缘和余晖里
  vColor = mix(C, vec3(1.0), 0.30 + 0.45 * aRand);
  float base = aSpr < 0.5 ? (1.5 + aRand * 1.0) : aSpr > 6.5 ? (6.0 + 13.0 * pow(tw, 6.0)) : (aSpr < 1.5 ? 13.0 : 7.5) + aRand * 2.0;
  gl_PointSize = base * uPixel * uBloom * (13.0 / max(2.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

/* 挂件共用的片元:按 vSpr 在 4×2 图集里取格子,再按 vRot 转一下 */
const SPR_FS = `
precision highp float;
uniform sampler2D uAtlas;
uniform float uSoft;
varying float vA, vSpr, vRot;
varying vec3 vColor;
void main(){
  vec2 pc = gl_PointCoord - 0.5;
  // 点和十字星不转(十字要保持正),其余挂件自己翻着走
  if (vSpr > 0.5 && vSpr < 6.5) { float c = cos(vRot), s = sin(vRot); pc = mat2(c, -s, s, c) * pc; }
  pc += 0.5;
  if (pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0) discard;
  float id = floor(vSpr + 0.5);
  vec2 cell = vec2(mod(id, 4.0), floor(id / 4.0));
  vec4 t = texture2D(uAtlas, (cell + vec2(pc.x, 1.0 - pc.y)) / vec2(4.0, 2.0));
  float a = mix(min(1.0, smoothstep(0.18, 0.75, t.a) * 1.25), t.a * t.a, uSoft);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vA);
}
`;
/* 光束本体只用圆点那一格 */
const DOT_FS = `
precision highp float;
uniform sampler2D uAtlas;
uniform float uSoft;
varying vec3 vColor;
varying float vA;
void main(){
  vec4 t = texture2D(uAtlas, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) / vec2(4.0, 2.0));
  // 实点是硬核的一颗颗亮粒(不是软雾);辉光孪生(uSoft=1)照旧软
  float a = mix(min(1.0, smoothstep(0.18, 0.75, t.a) * 1.25), t.a * t.a, uSoft);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vA);
}
`;

/* ── 尾迹流线 ──
   在尖头前面一点汇成一点,向后张开到各自的半径,平行拉长,远端向外翘;线绕着光束
   排一圈。线本身用密排的小点画(和其余各层同一种材质),不用 THREE.Line:WebGL 的
   线宽恒为 1,在 Retina 上细得像没有,也吃不到辉光。 */
function buildLines() {
  const nLine = LINE_COUNT * LINE_POINTS, nMark = LINE_COUNT * LINE_MARKS;
  const n = nLine + nMark;
  const line = new Float32Array(n), u = new Float32Array(n), rnd = new Float32Array(n), spr = new Float32Array(n);
  let i = 0;
  for (let l = 0; l < LINE_COUNT; l++) {
    for (let k = 0; k < LINE_POINTS; k++, i++) { line[i] = l; u[i] = k / (LINE_POINTS - 1); rnd[i] = Math.random(); spr[i] = 0; }
  }
  const MARKS = [SPR.TRI, SPR.NOTE, SPR.TRI, SPR.NOTE, SPR.DOT];
  for (let l = 0; l < LINE_COUNT; l++) {
    for (let k = 0; k < LINE_MARKS; k++, i++) {
      line[i] = l; u[i] = -1 - Math.random(); rnd[i] = Math.random();
      spr[i] = MARKS[(l + k) % MARKS.length];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aLine', new THREE.BufferAttribute(line, 1));
  geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('aSpr', new THREE.BufferAttribute(spr, 1));
  return geo;
}

const LINE_VS = `
precision highp float;
attribute float aLine, aU, aRand, aSpr;
uniform float uTime, uPixel, uVis, uBloom, uGrow;
uniform vec3 uHeadC;
${GLSL_COMMON}
varying float vA, vSpr, vRot;
varying vec3 vColor;
float h1(float x) { return fract(sin(x * 127.1 + 311.7) * 43758.5453); }
vec3 linePos(float l, float u) {
  // 绕光束一圈,角度带一点抖动;半径每条不同
  // 两排:光束上下各一排,像一面五线谱(视频侧面那几秒最清楚)
  float th = (mod(l, 2.0) < 0.5 ? 1.5708 : -1.5708) + (h1(l) - 0.5) * 0.25;
  float Rl = 1.05 + (floor(l / 2.0) / ${LINE_COUNT / 2 - 1}.0) * 1.7 + h1(l + 3.1) * 0.10;
  float len = ${(TRAIL_LEN * 0.60).toFixed(3)} * (0.75 + h1(l + 7.7) * 0.25);
  float d = -1.2 + u * len;
  // 在尖头前面汇成一点 → 张开 → 平行 → 远端外翘(像磁感线)
  float r = Rl * (1.0 - 0.18 * exp(-max(d + 1.2, 0.0) / 0.5));
  r += pow(smoothstep(0.80, 1.0, u), 1.5) * (0.5 + h1(l + 1.3) * 0.6);
  // th = ±90° → 光束的上方 / 下方(y);sin 才是 y 分量
  return vec3(${HEAD_X.toFixed(3)} + d, sin(th) * r, cos(th) * r);
}
void main(){
  bool mark = aU < -0.5;
  // 挂件顺着线往后流(比世界流得快一点 —— 它们是被尾迹吹走的)
  float u = mark ? fract(-aU + uTime * (0.045 + aRand * 0.03)) : aU;
  vec3 p = linePos(aLine, u);
  if (mark) p += vec3(0.0, sin(uTime * 1.7 + aRand * 20.0) * 0.10, cos(uTime * 1.3 + aRand * 14.0) * 0.10);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // 线是"画出来"的:每次大环炸开 uGrow 从 0 长到 1,线从尖头往后延伸出去
  float grow = smoothstep(u - 0.06, u, uGrow * 1.06);
  // 线的另一头有个亮点(视频里每条线端点那颗小圆点)
  float cap = mark ? 0.0 : exp(-(1.0 - aU) * 120.0) * 2.0;
  float taper = mark ? 1.0 : (0.25 + 0.75 * smoothstep(0.02, 0.18, u));
  float mk = mark ? (0.85 + 0.15 * sin(uTime * 4.0 + aRand * 9.0)) * smoothstep(0.05, 0.15, u) * (1.0 - smoothstep(0.85, 1.0, u)) : 1.0;
  vA = uVis * grow * (taper + cap) * mk;
  vSpr = aSpr; vRot = mark ? (aRand - 0.5) * 0.6 + sin(uTime + aRand * 6.0) * 0.4 : 0.0;
  vColor = mix(vec3(0.86, 0.90, 1.0), uHeadC, 0.45);
  float sz = mark ? 10.0 + aRand * 2.5 : (cap > 0.1 ? 4.2 : 1.6);
  gl_PointSize = sz * uPixel * uBloom * (13.0 / max(2.0, -mv.z));
  gl_Position = projectionMatrix * mv;
  vA *= holeK(gl_Position);
}
`;

/* ── 远处的星尘:几颗零散亮点,给黑底一点纵深 ── */
function buildDust() {
  const n = DUST_POINTS;
  const pos = new Float32Array(n * 3), rnd = new Float32Array(n), spr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 16; pos[i * 3 + 1] = (Math.random() - 0.5) * 9;
    pos[i * 3 + 2] = -2 - Math.random() * 10;
    rnd[i] = Math.random(); spr[i] = Math.random() < 0.012 ? SPR.GLINT : SPR.DOT;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('aSpr', new THREE.BufferAttribute(spr, 1));
  return geo;
}
const DUST_VS = `
precision highp float;
attribute float aRand, aSpr;
uniform float uTime, uPixel, uVis;
varying float vA, vSpr, vRot;
varying vec3 vColor;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.5 + 0.5 * sin(uTime * (0.6 + aRand * 1.8) + aRand * 50.0);
  vA = uVis * (aSpr > 0.5 ? 0.8 * pow(tw, 3.0) : 0.10 + 0.35 * tw * step(0.55, aRand));
  vSpr = aSpr; vRot = 0.0;
  vColor = vec3(0.80, 0.86, 1.0);
  gl_PointSize = (aSpr > 0.5 ? 9.0 : 1.2 + aRand) * uPixel;
  gl_Position = projectionMatrix * mv;
}
`;

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class SpindleLayer {
  /** @param {{pixel?:number}} opts */
  constructor(opts = {}) {
    this.scene = new THREE.Scene();
    this.atlas = makeSpriteAtlas();
    this._time = 0;
    this._vis = 0; this.target = 1;
    this._flow = 0;
    this._spin = 0;
    this._grow = 1;
    this._blast = 0;
    this._punch = 0;
    this._beatClock = 0;
    this._beatIdx = 0;
    this.beatPending = false;   // 这一拍还没人认领:引擎可以把它变成"字拍",否则下一帧自动炸小环
    this._ringNext = 0;

    // 整道光束挂在 pivot 下。pivot 的朝向就是"机位":视频里相机从几乎正对尖头慢慢转到
    // 正侧面 —— 这里反过来转物体,效果一样,而且不碰 SILK 的相机(字也用那台相机)。
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this._hole = new THREE.Vector4(0, 0, 0.3, 0.1);
    this._holeAmt = { value: 0 };
    const common = { uTime: { value: 0 }, uPixel: { value: opts.pixel || 1 },
                     uHole: { value: this._hole }, uHoleAmt: this._holeAmt,
                     uAtlas: { value: this.atlas } };
    // 每样东西画两遍:辉光孪生(点大、核软、暗)+ 实点。和字形层 / Mineradio 同一个套路。
    const mk = (geo, vs, fs, extra, bloom) => {
      const u = Object.assign({}, common, extra, {
        uVis: { value: 0 }, uBloom: { value: bloom ? 1.9 : 1 }, uSoft: { value: bloom ? 1 : 0 } });
      const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: vs, fragmentShader: fs,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      const p = new THREE.Points(geo, m); p.frustumCulled = false; p.renderOrder = bloom ? 0 : 1;
      return { m, p, u };
    };

    this._bodyGeo = buildBody();
    this._headC = new THREE.Vector3(0.55, 0.64, 1.0);
    const bodyU = { uFlow: { value: 0 }, uSpin: { value: 0 }, uBlast: { value: 0 }, uHeadC: { value: this._headC } };
    this.bodyB = mk(this._bodyGeo, BODY_VS, DOT_FS, bodyU, true);
    this.body = mk(this._bodyGeo, BODY_VS, DOT_FS, bodyU, false);

    this._ringGeo = buildRings();
    this._rp = [];
    for (let i = 0; i < RING_SLOTS; i++) this._rp.push(new THREE.Vector4(-1, 0, 0, 0));
    this._rd = new Array(RING_SLOTS).fill(0);
    /* 每个环出生时领到的颜色。初值给冷蓝 —— 第一帧还没有任何环炸过。 */
    this._rc = [];
    for (let i = 0; i < RING_SLOTS; i++) this._rc.push(new THREE.Vector3(0.55, 0.64, 1.0));
    this._colIdx = 0;
    this._rf = new Float64Array(RING_SLOTS);   // 每个环出生时光束推到了哪(世界坐标)
    const ringU = { uRP: { value: this._rp }, uRD: { value: this._rd }, uRC: { value: this._rc } };
    this.ringB = mk(this._ringGeo, RING_VS, SPR_FS, ringU, true);
    this.ring = mk(this._ringGeo, RING_VS, SPR_FS, ringU, false);

    this._lineGeo = buildLines();
    const lineU = { uGrow: { value: 1 }, uHeadC: { value: this._headC } };
    this.lineB = mk(this._lineGeo, LINE_VS, SPR_FS, lineU, true);
    this.line = mk(this._lineGeo, LINE_VS, SPR_FS, lineU, false);

    // 星尘不跟着光束转(它是远景)
    this._dustGeo = buildDust();
    this.dust = mk(this._dustGeo, DUST_VS, SPR_FS, {}, false);
    this.scene.add(this.dust.p);

    for (const o of [this.bodyB, this.ringB, this.lineB, this.body, this.ring, this.line]) this.pivot.add(o.p);
    this._all = [this.bodyB, this.body, this.ringB, this.ring, this.lineB, this.line, this.dust];

    // 开场先有几个"已经炸过"的环 —— 视频第一帧就是一组同心轨道,不是空的
    for (let k = 0; k < 4; k++) {
      const i = this.burst(0.5 + Math.random() * 0.3);
      this._rp[i].x = 0.9 + k * 1.8;
      this._rf[i] = this._flow - (0.9 + k * 1.8) * SPEED;
    }
    this._blast = 0; this._grow = 1;
    this._pose(0);
  }

  get visible() { return this._vis > 0.002; }

  setPixel(px) { for (const o of this._all) o.u.uPixel.value = px; }

  /** 字的留白:NDC 中心 + 半宽半高,amt 0..1。引擎每帧按那句大字的包络写进来。 */
  setHole(x, y, hw, hh, amt) { this._hole.set(x, y, hw, hh); this._holeAmt.value = amt; }

  /** "运镜":整道光束的朝向。一个约 70 秒的来回:从尖头几乎正对镜头(视频开头),
   *  慢慢转到正侧面、光束横着(视频结尾),再转回去。yaw > 0 把尖头转向镜头,
   *  roll < 0 让光束从左上斜向右下。 */
  _pose(t) {
    const k = 0.5 + 0.5 * Math.cos(t * (2 * Math.PI / 70));      // 1 = 正对(开场), 0 = 侧面
    const yaw = 0.06 + k * 1.12 + Math.sin(t * 0.21) * 0.03;
    const pitch = -0.08 - k * 0.10 + Math.sin(t * 0.13 + 1.3) * 0.03;
    const roll = -0.10 - k * 0.20;
    this.pivot.rotation.set(pitch, yaw, roll, 'YXZ');
    // 侧面时尖头在画面左侧三分之一,光束冲出右边;正对时尖头往中间靠
    this.pivot.position.set(1.2 - k * 0.6, 0.15 - k * 0.85, 0);
    // 拍子上的冲击:整道光束猛地放大一点再弹回(0.16s 衰减) —— 像镜头被撞了一下
    this.pivot.scale.setScalar(1);   // 拍上不冲击:星轨一直平稳(09-22)
    this.pivot.updateMatrixWorld(true);
  }

  /** 尖头在 SILK 平面(z=0)上的位置 —— 大字就停在这里。沿相机射线投到 z=0,
   *  所以尖头转到靠近镜头时,字依旧压在屏幕上尖头的那个位置。 */
  headPlane(cam) {
    _v.set(HEAD_X, 0, 0).applyMatrix4(this.pivot.matrixWorld);
    if (!cam) return { x: _v.x, y: _v.y };
    _w.copy(_v).sub(cam.position);
    const t = Math.abs(_w.z) > 1e-4 ? -cam.position.z / _w.z : 1;
    return { x: cam.position.x + _w.x * t, y: cam.position.y + _w.y * t };
  }

  /** 炸了 age 秒的那个环,它的中心此刻在 SILK 平面(z=0)上的哪里,以及透视缩放 k
   *  (离镜头越远越小)。挂在环上的那句字每帧用它来"跟着环走"。 */
  ringPlane(age, cam, ring) {
    const d = ring != null && ring >= 0 ? Math.max(0, this._flow - this._rf[ring]) : SPEED * Math.max(0, age);
    _v.set(HEAD_X + d, 0, 0).applyMatrix4(this.pivot.matrixWorld);
    if (!cam) return { x: _v.x, y: _v.y, k: 1 };
    _w.copy(_v).sub(cam.position);
    const t = Math.abs(_w.z) > 1e-4 ? -cam.position.z / _w.z : 1;
    // 相机沿 -z 看:深度就是 z 差。平面上那一点的深度 / 环心的深度 = 屏幕上的相对大小
    const k = Math.max(0.35, Math.min(1.6, Math.abs(cam.position.z) / Math.max(0.5, Math.abs(_w.z))));
    return { x: cam.position.x + _w.x * t, y: cam.position.y + _w.y * t, k };
  }

  /** 光束方向(世界坐标,单位向量)—— 字炸成的环要和尖头炸的环在同一个平面上 */
  ringNormal(out) {
    return (out || new THREE.Vector3()).set(1, 0, 0).transformDirection(this.pivot.matrixWorld);
  }

  /** 在尖头炸一个环。
   *  @param {number} strength 0..1.5 —— 大于 0.9 的是"字炸开"的那种大环
   *  @param {number=} radius 张开到多大(SILK 单位);省略就按强度随机 */
  burst(strength = 1, radius) {
    const i = this._ringNext;
    this._ringNext = (this._ringNext + 1) % RING_SLOTS;
    // 大小混着来:从正前方看,不同大小的环叠在一起才是视频开头那组同心轨道
    const R = radius || (Math.random() < 0.6 ? 0.72 + Math.random() * 0.35 : 1.2 + Math.random() * 0.55) + strength * 0.2;
    this._rp[i].set(0, Math.min(1.5, strength), R, Math.random());
    this._rf[i] = this._flow;
    /* 领一个颜色。⚠️ 按**顺序**发,不是随机挑 —— 随机会连着发到同一个色,
       而这一层要的正是"每一拍都明显换了个颜色"。字那边用 ringColor(i) 取同一个色。 */
    const c = BURST_COLORS[this._colIdx % BURST_COLORS.length];
    this._colIdx++;
    this._rc[i].set(c[0], c[1], c[2]);
    this._headCol = c;
    if (this._headC) this._headC.set(c[0], c[1], c[2]);
    if (strength > 0.9) {
      this._blast = Math.max(this._blast, strength);
      // 不再冲击镜头、不再重画尾迹流线 —— 炸环时星轨本身纹丝不动(09-22)
    }
    return i;
  }

  /** 第 i 个环的颜色(十六进制字符串)—— 引擎拿它给骑在这个环上的那句粒子字上色,
   *  于是"环和字同色"是字面为真,不是两边各调一次调像了。 */
  ringColor(i) {
    const v = this._rc[(i % RING_SLOTS + RING_SLOTS) % RING_SLOTS];
    const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
    return '#' + h(v.x) + h(v.y) + h(v.z);
  }
  /** 此刻尖头的颜色(最近一次炸环领到的) */
  headColor() { return this._headCol || [0.55, 0.64, 1.0]; }

  update(dt) {
    this._time += dt;
    const t = this._time;
    this._vis += (this.target - this._vis) * Math.min(1, dt * 1.6);
    if (this.target === 0 && this._vis < 0.002) this._vis = 0;
    // 匀速往后流(09-22 用户:「还是一愣一愣的,要很丝滑,包括速度」)—— 不再一格一格地推,
    // 平均速度和原来一样(每拍一格),只是没有了快慢。
    this._flow = STEP * (this._beatIdx + Math.min(1, this._beatClock / BEAT));
    this._spin += dt * 0.30;
    this._grow = Math.min(1, this._grow + dt * 0.8);
    this._blast *= Math.exp(-dt / 0.35);
    this._punch *= Math.exp(-dt / 0.16);
    // 上一拍引擎没认领 → 就是一个普通的小环。视频里画面从来没有停过。
    if (this.beatPending) { this.beatPending = false; this.burst(0.30 + Math.random() * 0.3); }
    // 打拍子:到点只**举手**,不立刻炸 —— 让引擎先决定这一拍要不要带字
    this._beatClock += dt;
    if (this._beatClock >= BEAT && this.target > 0) { this._beatClock -= BEAT; this._beatIdx++; this.beatPending = true; }
    for (let i = 0; i < RING_SLOTS; i++) {
      const P = this._rp[i];
      if (P.x < 0) continue;
      P.x += dt;
      if (P.x > RING_LIFE) P.x = -1;
      this._rd[i] = Math.max(0, this._flow - this._rf[i]);
    }
    this._pose(t);
    const v = this._vis;
    for (const o of this._all) o.u.uTime.value = t;
    this.body.u.uVis.value = v * 1.35; this.bodyB.u.uVis.value = v * 0.42;
    this.ring.u.uVis.value = v * 1.35; this.ringB.u.uVis.value = v * 0.22;
    this.line.u.uVis.value = v * 1.9; this.lineB.u.uVis.value = v * 0.14;
    this.dust.u.uVis.value = v;
    const bu = this.body.u;
    bu.uFlow.value = this._flow % TRAIL_LEN; bu.uSpin.value = this._spin; bu.uBlast.value = this._blast;
    this.line.u.uGrow.value = this._grow;
  }

  dispose() {
    for (const g of [this._bodyGeo, this._ringGeo, this._lineGeo, this._dustGeo]) g.dispose();
    for (const o of this._all) o.m.dispose();
    this.atlas.dispose();
  }
}

export const SPINDLE_INTERNALS = { TRAIL_LEN, HEAD_X, SPEED, RING_SLOTS, RING_OPEN, RING_LIFE };
