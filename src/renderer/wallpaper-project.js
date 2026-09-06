/**
 * wallpaper-project.js — 把一个项目**变成粒子**:它的图片和它的名字,都由粒子聚成。
 *
 * 这一层的做法和字形层是同一套(mineradio-wallpaper.js 里的 GLYPH_VS):在 CPU 上把
 * 目标图案采成每颗粒子的落点,再在顶点着色器里从"散开"插值到"落位"。区别只有一个 ——
 * 字形层采的是黑白遮罩(在不在笔画上),这一层采的是**颜色**:每颗粒子记住自己那个
 * 像素的 RGB,于是聚起来的不是一句话,而是那张图本身。
 *
 * 为什么不直接把图贴上去:贴图是一张图片,粒子是这个产品的语言。项目缩影要和壁纸上
 * 其余的东西(极光、统计数字)长在同一个世界里,它就必须由同样的粒子构成 —— 而且
 * 因为它是真的粒子,3D 自由视角一转,它跟着一起转。
 *
 * **它也是"上传参数、本地生成"的那一半**:胶囊里只有一张 96px 的封面和几行字,
 * 收到的人在自己机器上采样、生成、渲染。服务器不渲染、不转码,只存那颗 JSON 胶囊。
 */
import * as THREE from 'three';
import { langRgb } from './lang-colors.js';
import { styleOf, DEFAULT_STYLE } from './city-styles.js';

/** 一个项目缩影用多少颗粒子。24k 在 96px 封面上等于每个像素约 2.6 颗 —— 足够密到
 *  看得出是那张图,又不至于让常驻的壁纸多背一个几十万点的负担。 */
export const PROJECT_POINTS = 48000;
/** 城市自己的粒子预算。**不从图和字里扣**:扣了就等于"加了城市之后字变糊了",
 *  而那正是这一层踩过两次的坑。城市只在演出的那 20 秒里存在(不演的时候整个对象
 *  是 visible=false 的),所以它是一笔按次付的账,不是常驻开销。 */
export const CITY_POINTS = 56000;

/** 社区配色。星座按"这几块是一伙的"上色 —— 社区是图谱自己聚出来的,不是语言。
 *  刻意和语言色分开:同一个屏幕上两套颜色说两件事,混用一套人就分不清在看什么。 */
const COMMUNITY_RGB = [
  [0.42, 0.72, 1.00], [1.00, 0.62, 0.36], [0.58, 0.90, 0.52], [0.94, 0.52, 0.78],
  [0.98, 0.86, 0.42], [0.60, 0.58, 1.00], [0.42, 0.90, 0.84], [0.92, 0.44, 0.42],
];
/** 没有社区的节点。灰白 —— 在场,但不假装属于谁。 */
const COMMUNITY_NONE = [0.62, 0.66, 0.74];
/** 采样画布。**必须比封面细**:采样格子比像素粗,图就糊成一片色块(第一版 128 配
 *  96px 封面就是这个下场 —— 一团绿,认不出是什么)。 */
const SAMPLE_W = 224, SAMPLE_H = 224;
/** 稳定的伪随机:同一颗胶囊每次都得长出同一座城,不能每次重聚都换个样。 */
function hash01c(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
/** 太暗的像素不占粒子:深色背景是图片里最不值钱的部分,把粒子让给有内容的地方。 */
const LUMA_FLOOR = 0.06;

export const PROJ_VS = `
precision highp float;
attribute vec3 aTarget;     // 落位(平面坐标)
attribute vec3 aColor;      // 这颗粒子那个像素的颜色
attribute float aRand;
// 这颗粒子该画多大。图和字混在同一层里,但它们要的点大小**不一样**:
// 一行 25px 高的字,笔画只有 3–4px 宽,拿画图那种点去画就是一条糊掉的色块
// (第一版就是这样:六行字全成了实心方块)。字用小点。
attribute float aScale;
uniform float uForm;        // 1 = 完全落位,0 = 完全散开
uniform float uVis, uPixel, uPointScale, uTime, uSize;
varying vec3 vColor;
varying float vA;

void main(){
  float amt = 1.0 - uForm;
  float a = aRand * 6.2831;
  // 散开的方式和字形层同一支:朝自己的方向炸开 + 一点前后错落,所以图和字是
  // 同一种"聚拢/散去",不会看起来像两个系统拼在一起。
  vec3 d = vec3(vec2(cos(a), sin(a)) * (0.55 + aRand * 1.35) * amt,
                amt * (aRand - 0.5) * 1.6);
  vec3 pos = aTarget * uSize + d;
  vColor = aColor;
  // 轻微闪烁:静止的点阵会显出规则网格,一点随机呼吸就把它化开
  // 落位之后几乎不闪:闪烁是"粒子感",但它同时也在糊掉图。散开时闪得多一点,
  // 聚拢之后交给图本身。
  vA = uVis * (0.80 + 0.20 * sin(uTime * 1.6 + aRand * 21.0) * (1.0 - uForm));
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  // 点要**小于**粒子间距,否则相邻的点糊成一片,细节全没了 —— 用户报的"都是虚的"
  // 就是这个。小点 + 更多点 = 看得清的图。
  gl_PointSize = (1.15 + uForm * 0.75) * uPixel * uPointScale * aScale;
  gl_Position = projectionMatrix * mv;
}
`;

export const PROJ_FS = `
precision highp float;
uniform float uAlpha;
varying vec3 vColor;
varying float vA;
void main(){
  // **不用那张 soft-dot 精灵**。它是一圈从中心淡到透明的径向渐变 —— 壁纸上其余的
  // 粒子要的正是那种光晕,但一张图由几万颗光晕拼起来,每一颗都在把邻居糊掉,
  // 整幅图就是"虚的"(用户原话)。这里自己算一个**边缘干净**的圆点:中间实,
  // 只在最外面半个像素做抗锯齿。同样的粒子数,图一下子就清楚了。
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  float a = 1.0 - smoothstep(0.36, 0.5, r);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vA * uAlpha);
}
`;

/**
 * 把一张图采成 N 颗粒子的落点和颜色。
 *
 * 分层取样(每颗粒子在自己的格子里随机取一点)而不是纯随机:纯随机会成团,格子化
 * 之后覆盖是均匀的,同样的粒子数看起来密得多。
 *
 * @param {HTMLImageElement|HTMLCanvasElement} img
 * @param {number} n
 * @returns {{target:Float32Array, color:Float32Array, aspect:number, used:number}}
 */
export function sampleImage(img, n) {
  const cv = document.createElement('canvas');
  cv.width = SAMPLE_W; cv.height = SAMPLE_H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const aspect = iw / ih;
  // 图按自己的比例画进方形画布,空出来的地方是透明的 —— 那些像素不会分到粒子,
  // 所以缩影保持原图的形状,而不是被拉成正方形。
  let dw = SAMPLE_W, dh = SAMPLE_H;
  if (aspect > 1) dh = Math.max(1, Math.round(SAMPLE_W / aspect));
  else dw = Math.max(1, Math.round(SAMPLE_H * aspect));
  ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
  ctx.drawImage(img, (SAMPLE_W - dw) / 2, (SAMPLE_H - dh) / 2, dw, dh);

  let data;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  } catch (e) {
    // 画布被污染(跨域图)。胶囊里的封面是 data URL,不会走到这里 —— 但远程图会。
    return { target: new Float32Array(n * 3), color: new Float32Array(n * 3), aspect, used: 0 };
  }

  // 先收集"值得给粒子"的像素,再把 n 颗粒子摊到它们身上。这样一张主体很小的图
  // 也会把粒子集中在主体上,而不是均匀地撒在一片空白里。
  const lit = [];
  for (let y = 0; y < SAMPLE_H; y++) {
    for (let x = 0; x < SAMPLE_W; x++) {
      const i = (y * SAMPLE_W + x) * 4;
      if (data[i + 3] < 24) continue;
      const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      if (luma < LUMA_FLOOR) continue;
      lit.push(i);
    }
  }
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  if (!lit.length) return { target, color, aspect, used: 0 };

  for (let p = 0; p < n; p++) {
    // **按扫描顺序等距取**,不是散列。第一版用 (p * 2654435761) % len 打散,结果是
    // 相邻粒子落在图上毫不相干的位置 —— 覆盖是均匀的,但**结构没了**:看到的是一片
    // 正确颜色的噪声,不是那张图。等距取样保住了图的骨架。
    const i = lit[Math.floor(p * lit.length / n)];
    const px = (i / 4) % SAMPLE_W;
    const py = Math.floor((i / 4) / SAMPLE_W);
    // 抖动只是为了打散格点感,不能大到把边缘糊掉
    const jx = (Math.random() - 0.5) * 0.5;
    const jy = (Math.random() - 0.5) * 0.5;
    target[p * 3]     = ((px + 0.5 + jx) / SAMPLE_W - 0.5) * 2;   // −1..1
    target[p * 3 + 1] = (0.5 - (py + 0.5 + jy) / SAMPLE_H) * 2;
    target[p * 3 + 2] = 0;
    color[p * 3]     = data[i] / 255;
    color[p * 3 + 1] = data[i + 1] / 255;
    color[p * 3 + 2] = data[i + 2] / 255;
  }
  return { target, color, aspect, used: lit.length };
}

/**
 * 把一段文字画成粒子的落点。
 *
 * 和图片走同一条路(画到画布 → 采亮像素 → 每颗粒子记住一个落点),所以标题和图
 * 是**同一种东西**:一起浮现、一起散去、一起被 3D 相机转过去。
 *
 * 为什么标题不走壁纸原有的字形队列:那条队列有节流、有配额、还要等空槽位,而且
 * 槽位数量随 Pro 变 —— 结果就是用户看到"只有图,没有字"。项目自己的字属于项目
 * 自己这一层,不该去排别人的队。
 */
export function sampleBlock(rows, n) {
  // 一整块排版,而不是一行一个画布。
  //
  // 逐行采样时每一行都按自己的宽高比缩放,于是"812 files"和一句 30 字的评论会被
  // 拉成同样的宽度、不同的字号 —— 屏幕上看到的就是几条糊掉的色带(试过,不行)。
  // 排在同一张画布上,行距、字号、居中都由排版决定,采样只负责把它变成粒子。
  const W = 1024;
  const pad = 10;
  const fontOf = (px, weight) => `${weight || 700} ${px}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif`;
  let H = pad;
  for (const r of rows) H += Math.round(r.px * 1.42);
  H += pad;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = Math.max(8, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, cv.height);
  // 一行由**几段**组成(评论正文 + 署名),所以是左对齐后自己算居中:段与段之间
  // 要接得上,center 对齐做不到。
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let y = pad;
  for (const r of rows) {
    const lh = Math.round(r.px * 1.42);
    // 署名**不另起一行**:多一行就把整块字压矮一截,而这块字是按总高缩放的 ——
    // 三条评论各多一行,每一行都跟着细三成,又回到"字糊掉"那个老问题上。
    // 同一行、小一号、暗一点,已经足够让人看出"这是谁说的"。
    const parts = (r.parts || [{ text: r.text }]).map((p) => ({
      text: String(p.text == null ? '' : p.text),
      tail: p.tail || '',
      css: p.css || r.css || '#fff',
      font: fontOf(p.px || r.px, p.weight || r.weight),
    })).filter((p) => p.text || p.tail);
    if (!parts.length) { y += lh; continue; }
    const widthOf = () => parts.reduce((sum, p) => {
      ctx.font = p.font;
      return sum + ctx.measureText(p.text + p.tail).width;
    }, 0);
    // 太长就截断:一行字被压到只剩几像素高是没人读得了的,不如少几个字。
    // 截的**只有第一段**(正文)—— 署名是这一行存在的一半理由,把名字截掉等于
    // 把一句有主的话变回匿名的。
    let cut = false;
    while (widthOf() > W - pad * 2 && parts[0].text.length > 4) {
      parts[0].text = parts[0].text.slice(0, -2);
      cut = true;
    }
    if (cut) parts[0].text = parts[0].text.slice(0, -1).replace(/\s+$/, '') + '…';
    let x = Math.max(pad, (W - widthOf()) / 2);
    for (const p of parts) {
      ctx.font = p.font;
      ctx.fillStyle = p.css;
      const t = p.text + p.tail;
      ctx.fillText(t, x, y + lh / 2);
      x += ctx.measureText(t).width;
    }
    y += lh;
  }

  const d = ctx.getImageData(0, 0, W, cv.height).data;
  const lit = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 90 || d[i + 1] > 90 || d[i + 2] > 90) lit.push(i);
  }
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  if (!lit.length) return { target, color, aspect: W / cv.height, used: 0 };
  for (let p = 0; p < n; p++) {
    const i = lit[Math.floor(p * lit.length / n)];
    const px = (i / 4) % W;
    const py = Math.floor((i / 4) / W);
    target[p * 3]     = ((px + 0.5) / W - 0.5) * 2;
    target[p * 3 + 1] = (0.5 - (py + 0.5) / cv.height) * 2;
    target[p * 3 + 2] = 0;
    color[p * 3] = d[i] / 255; color[p * 3 + 1] = d[i + 1] / 255; color[p * 3 + 2] = d[i + 2] / 255;
  }
  return { target, color, aspect: W / cv.height, used: lit.length };
}

/* ══════════════ 代码城市 ══════════════

   一个顶层目录一座塔:**占地 = 文件数,楼高 = 代码量,楼色 = 主语言**。

   为什么是城市而不是又一张图:封面是作者挑给你看的一面,城市是这个仓库**本来的
   形状** —— 哪块厚、哪块薄、是一门语言还是五门,一眼就看出来了。而且它是真的有
   体积:自由视角一转,后面那排塔才露出来。这是这一层里第一样"转起来才看得全"的
   东西 —— 在它之前,图和字都只是会跟着转的平面。

   城市的全部输入就是胶囊里那十几个数字(见 projects.rs 的 DirStat)。服务器不渲染,
   传的还是参数。

   ⚠ 塔是**采表面**,不是填实心。同样的粒子数,填实心的话表面只分到很少几颗,
   看起来是一团糊的雾;只采表面(四个立面 + 顶面 + 四条竖棱)才有干净的轮廓。 */

/**
 * 把一个目录名画成一小块标签的落点。
 *
 * 返回的是 −0.5..0.5 的**归一化**坐标 + 这块字的宽高比 —— 具体摆多大由调用方按
 * 那一格的宽度决定。这里只负责"这几个字长什么样"。
 *
 * 名字太长就**先截字再缩号**:一直缩下去的话,"android-app" 会变成一条 3 像素高的
 * 灰线 —— 那既不是名字也不是装饰,只是脏。宁可写 "android-a…",它至少还认得出来。
 */
function sampleLabel(name, n, maxAspect) {
  const H = 44, PAD = 4;
  const probe = document.createElement('canvas').getContext('2d');
  const font = `700 ${H}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif`;
  probe.font = font;
  let t = String(name || '').trim();
  if (!t) return null;
  while (t.length > 3 && probe.measureText(t).width / H > maxAspect) t = t.slice(0, -1);
  if (t !== String(name).trim()) t = t.slice(0, -1) + '…';
  const w = Math.max(8, Math.ceil(probe.measureText(t).width) + PAD * 2);

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = H + PAD * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(t, cv.width / 2, cv.height / 2);

  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const lit = [];
  for (let i = 0; i < d.length; i += 4) if (d[i] > 90) lit.push(i);
  if (!lit.length) return null;
  const pts = new Float32Array(n * 2);
  for (let p = 0; p < n; p++) {
    // 和图、字同一套:按扫描顺序等距取,不散列 —— 散列取样保不住字的骨架。
    const i = lit[Math.floor(p * lit.length / n)];
    const px = (i / 4) % cv.width, py = Math.floor((i / 4) / cv.width);
    pts[p * 2] = (px + 0.5) / cv.width - 0.5;
    pts[p * 2 + 1] = 0.5 - (py + 0.5) / cv.height;
  }
  return { pts, aspect: cv.width / cv.height };
}

/** 1_850_000 → "1.8MB"。楼上的读数是给人扫一眼的,不是给人算的。 */
function human(bytes) {
  const b = +bytes || 0;
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'GB';
  if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + 'MB';
  if (b >= 1e3) return Math.round(b / 1e3) + 'KB';
  return b + 'B';
}

/** 距今多久。"3d" 比 "2026-09-02" 有用得多 —— 人想知道的是"还热着吗"。 */
function since(days) {
  const d = +days;
  if (!Number.isFinite(d) || d >= 9999) return '';
  if (d <= 0) return 'today';
  if (d < 7) return d + 'd';
  if (d < 60) return Math.round(d / 7) + 'w';
  if (d < 730) return Math.round(d / 30) + 'mo';
  return Math.round(d / 365) + 'y';
}

/** 城市在自己的坐标系里是躺着的(x 右、z 进深、y 向上),而壁纸默认那台相机是**正对**
 *  着看的 —— 正对着一座城市,看到的是一排贴在一起的立面和一条edge-on 的地面,那叫
 *  柱状图,不叫城市。所以把一个俯角 + 一点偏航**烘进落点里**:不管相机在哪,这座城
 *  一出场就是斜俯视的。自由视角再转,是在这个基础上转。 */
const CITY_PITCH = 26 * Math.PI / 180;
const CITY_YAW = -22 * Math.PI / 180;

/** 没有语言可依的区(素材、文档、配置)也得有自己的颜色。
 *  一律画成灰的话,一座仓库里"不是代码的那一半"就变成了背景板 —— 而它恰恰是
 *  这座城市比一张语言饼图多说出来的东西。 */
const KIND_RGB = {
  assets: [0.83, 0.66, 0.38],   // 砂黄:粮仓
  docs:   [0.42, 0.68, 0.46],   // 草绿:公园
  config: [0.48, 0.55, 0.68],   // 石板蓝:工棚
  test:   [0.62, 0.55, 0.72],   // 淡紫:厂房
  source: [0.54, 0.54, 0.56],
};

/**
 * 把一组目录统计摆成一座城,采成 n 颗粒子。
 *
 * @param {{name:string, files:number, bytes:number, lang:string}[]} dirs
 * @param {number} n
 * @returns {{target:Float32Array, color:Float32Array, used:number}} 落点在 −1..1 的立方体里
 */
export function sampleCity(dirs, n, styleId, links, commits) {
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  // 每颗粒子画多大。楼身、地面、窗、标签要的点各不一样 —— 一个 40px 高的名字拿画
  // 楼那种点去画就是一条实心色带。
  const scale = new Float32Array(n); scale.fill(0.82);
  const list = (dirs || []).filter((d) => d && (d.files > 0 || d.bytes > 0)).slice(0, 16);
  if (!list.length || n <= 0) return { target, color, scale, used: 0 };

  // 体量:代码字节为主,没有代码的目录(文档、素材)按文件数折算 —— 否则一座
  // 两百张图的素材库高度是 0,城市里就少了这一块。
  const massOf = (d) => Math.max(+d.bytes || 0, (+d.files || 0) * 2000);
  const maxM = Math.max(1, ...list.map(massOf));
  /* ⚠ HEIGHT IS LOGARITHMIC, and it has to be.
     Every real repository has one directory that dwarfs the rest — a landing
     folder full of images, a build output, a vendored dependency. Measured on
     this project: `landing` is 115MB and the next building is 2.9MB, a spread
     of forty to one. Against a linear scale that is one skyscraper standing on
     a plain of stubs a few pixels high, and on a phone, where the whole city is
     scaled down to fit, those stubs read as a flat dotted haze — which is
     exactly how "the code city does not render" was reported.

     A log scale is the standard answer for data spanning three orders of
     magnitude, and this file already uses ln(bytes) for hotspot heat. Order is
     preserved — the biggest is still the tallest — but every building keeps a
     height you can compare. */
  const minM = Math.max(1, Math.min(...list.map(massOf)));
  const lgMin = Math.log(1 + minM), lgMax = Math.log(1 + maxM);
  const lgSpan = Math.max(1e-6, lgMax - lgMin);
  // All one size (a repo of equal folders) → everything at mid height rather
  // than a divide-by-nothing that puts the whole city at zero.
  const heightOf = (d) => (lgMax - lgMin < 1e-6
    ? 0.6
    : (Math.log(1 + massOf(d)) - lgMin) / lgSpan);
  const maxF = Math.max(1, ...list.map((d) => +d.files || 0));
  const maxChurn = Math.max(0, ...list.map((d) => +d.churn || 0));
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows = Math.ceil(list.length / cols);
  const cell = 2 / cols;

  /* 座次:**耦合强的排在一起**。
     关系这件事最好的表达不是画一根线,是**位置** —— 位置是所有视觉通道里最强的
     一个(Bertin),而且它不占任何额外的笔墨:两块代码来往密,它们的楼就是邻居,
     这件事不需要标注,看一眼就在那儿。
     贪心排:先放最大的那座,之后每次挑"和已经放下的那些牵连最深"的一座接上去。
     没有图谱时退回按体量排 —— 城市照样有重心。 */
  const link = (Array.isArray(links) ? links : [])
    .map((l) => [l[0] | 0, l[1] | 0, Math.max(1, l[2] | 0)])
    .filter((l) => l[0] !== l[1] && l[0] < list.length && l[1] < list.length);
  const bond = (a, b) => { let w = 0; for (const l of link) if ((l[0] === a && l[1] === b) || (l[0] === b && l[1] === a)) w += l[2]; return w; };
  let order = list.map((_, i) => i);
  if (link.length) {
    const left = new Set(order);
    const seat = [];
    let cur = 0;                                   // list 已按体量排好,0 就是主楼
    left.delete(cur); seat.push(cur);
    while (left.size) {
      let best = -1, bw = -1;
      for (const c of left) {
        let w = 0;
        for (const placed of seat) w += bond(c, placed);
        // 平手时按体量(list 的原顺序)—— 否则同一颗胶囊每次扫出来的城市都在换位置
        if (w > bw || (w === bw && best >= 0 && c < best)) { bw = w; best = c; }
      }
      left.delete(best); seat.push(best);
    }
    order = seat;
  }
  const seatOf = new Array(list.length);
  order.forEach((li, pos) => { seatOf[li] = pos; });

  const towers = list.map((d, i) => {
    const kind = String(d.kind || 'source');
    const seat = seatOf[i];
    const cx = (seat % cols + 0.5) * cell - 1;
    const cz = (Math.floor(seat / cols) + 0.5) * (2 / rows) - 1;
    // 占地 ∝ √文件数(面积才是文件数,边长要开方),留出街道
    const foot = cell * (0.30 + 0.46 * Math.sqrt((+d.files || 0) / maxF));
    // 楼高压过一道 0.6 次幂:一个仓库里最大的目录常常比第二大的多一个数量级,
    // 线性画的话除了它以外全是地板。
    // 0.30 floor rather than 0.14: the smallest building is still a building,
    // and at a phone's scale anything under that is not a shape, it is a smudge.
    let h = 0.30 + 1.00 * heightOf(d);
    // 形状决定体量的读法:厂房是趴着的,公园是平的,圆仓是矮胖的。
    if (kind === 'test') h *= 0.42;
    if (kind === 'docs') h *= 0.10;
    if (kind === 'assets') h *= 0.55;
    if (kind === 'config') h *= 0.30;
    // 语言色带:底下是第一语言,往上依次换。一座 60% Rust / 40% TS 的楼看得出是混的。
    const mix = (Array.isArray(d.langs) ? d.langs : [])
      .map((x) => [String((x && x[0]) || ''), Math.max(0, +(x && x[1]) || 0)])
      .filter((x) => x[0] && x[1] > 0.02);
    const msum = mix.reduce((a, x) => a + x[1], 0) || 1;
    let acc = 0;
    const bands = mix.map(([l, f]) => { acc += f / msum; return { rgb: langRgb(l), upto: acc }; });
    if (bands.length) bands[bands.length - 1].upto = 1.001;
    // 退台:目录埋得越深,塔收得越多层。这是"这块结构有多深"唯一能看见的地方,
    // 也是这座城市天际线不至于全是一样方盒子的原因。
    const tiers = kind === 'source' ? Math.max(1, Math.min(3, (+d.depth || 1) - 1)) : 1;
    const age = +d.age_days;
    return {
      kind, cx, cz, foot, h, bands: bands.length ? bands : [{ rgb: KIND_RGB[kind] || langRgb(''), upto: 1.001 }],
      tiers, name: d.name,
      files: +d.files || 0,
      bytesRaw: +d.bytes || 0,
      age: Number.isFinite(age) ? age : 9999,
      churn: +d.churn || 0,
      rgb: d.lang ? langRgb(d.lang) : (KIND_RGB[kind] || langRgb('')),
      w: Math.sqrt(Math.max(1, massOf(d))),
    };
  });

  const wSum = towers.reduce((a, t) => a + t.w, 0) || 1;
  const nGround = Math.round(n * 0.05);
  const nLabels = Math.min(3, towers.length);
  const nLabelPts = nLabels ? Math.round(n * 0.09) : 0;
  // 提交天际线:53 周 × 7 天,摆在城市**后面**的一条带子。城市有结构、有材料、
  // 有关系,唯独没有时间;这条带子就是时间,而且过去理应在身后。
  const days = Array.isArray(commits) ? commits : [];
  const nSkyPts = days.some((v) => v > 0) ? Math.round(n * 0.09) : 0;
  // 屋顶牌:**每一座**都要有名字。街上那三块是"这个仓库主要是什么",屋顶牌是
  // "我现在看的这座是什么" —— 一座认不出名字的楼,再好看也只是装饰。
  const nTags = Math.min(12, towers.length);
  const nTagPts = Math.round(n * 0.10);
  // 地脉:关系那一层。**不是线** —— 是两块街区之间被踩出来的一片低低的、不匀的光。
  const paths = link.filter((l) => towers[l[0]] && towers[l[1]]);
  const nPathPts = paths.length ? Math.round(n * 0.11) : 0;
  const nTowers = n - nGround - nLabelPts - nTagPts - nPathPts - nSkyPts;
  const floorShare = Math.floor(nTowers / (towers.length * 4));
  let p = 0;

  const cp = Math.cos(CITY_PITCH), sp = Math.sin(CITY_PITCH);
  const cy_ = Math.cos(CITY_YAW), sy = Math.sin(CITY_YAW);
  const put = (x, y, z, r, g, b, sc) => {
    const x1 = x * cy_ + z * sy;
    const z1 = -x * sy + z * cy_;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const o = p * 3;
    target[o] = x1; target[o + 1] = y2; target[o + 2] = z2;
    color[o] = r; color[o + 1] = g; color[o + 2] = b;
    if (sc) scale[p] = sc;
    p++;
  };

  const BASE = -0.55;

  /* ── ① 地面:街道,不是一片噪点 ──
     第一版地面是随机撒的灰点,读起来像"楼下面有灰尘"。改成**街网 + 每栋楼的地台**:
     同样的粒子数,城市一下子就站住了,而且街网还顺带把网格布局说清楚了。 */
  {
    const g0 = 0.20, g1 = 0.26, g2 = 0.34;
    const half = nGround >> 1;
    for (let k = 0; k < half && p < nGround; k++) {
      // 街:沿格子边界的两组线
      const along = Math.random() * 2 - 1;
      const line = Math.floor(Math.random() * (cols + 1)) * cell - 1;
      const jitter = (Math.random() - 0.5) * 0.012;
      if (k & 1) put(line + jitter, BASE - 0.004, along, g0, g1, g2, 0.62);
      else put(along, BASE - 0.004, line + jitter, g0, g1, g2, 0.62);
    }
    // 地台:每栋楼脚下一圈亮一点的方框,把建筑和街面分开
    while (p < nGround) {
      const t = towers[(Math.random() * towers.length) | 0];
      const r = t.foot / 2 + 0.022;
      const u = (Math.random() - 0.5) * 2 * r;
      const e = Math.random() < 0.5;
      const [br, bg, bb] = t.rgb;
      put(t.cx + (e ? u : (Math.random() < 0.5 ? -r : r)),
          BASE - 0.002,
          t.cz + (e ? (Math.random() < 0.5 ? -r : r) : u),
          br * 0.30 + 0.10, bg * 0.30 + 0.10, bb * 0.30 + 0.10, 0.66);
    }
  }

  /* ── ② 建筑 ──
     一座全是方盒子的城市只能看出"大小",而形状能多说一件事:**这块是干什么的**。
     测试是趴着的厂房、文档是一片带树的公园、素材是圆仓、配置是一堆小屋、源码是塔。
     形状这一层是免费的信息 —— 它不占胶囊里任何一个额外的字节,只是把 kind 画出来。 */

  /** 这个高度上该是什么颜色:语言色带 + 越高越亮。 */
  const wallAt = (t, fy) => {
    let rgb = t.bands.length ? t.bands[t.bands.length - 1].rgb : t.rgb;
    for (const b of t.bands) if (fy <= b.upto) { rgb = b.rgb; break; }
    const lift = 0.52 + 0.42 * fy;
    return [Math.min(1, rgb[0] * lift), Math.min(1, rgb[1] * lift), Math.min(1, rgb[2] * lift)];
  };

  /** 窗户亮着的比例。**这是"这块代码还活着吗"在屏幕上的样子** ——
   *  昨天动过的楼灯火通明,两年没碰的黑着。城市里最会讲故事的一层。 */
  const litRatio = (age) => (age <= 7 ? 0.72 : age <= 45 ? 0.44 : age <= 200 ? 0.22 : age <= 800 ? 0.09 : 0.03);

  /* 建筑本身交给**风格**去长(见 city-styles.js)。这里只负责:分多少颗粒子给谁、
     那个高度该是什么颜色、窗该亮几成 —— 也就是**所有风格共用的那部分事实**。
     形状换了,读数不能跟着换:高度永远是代码量,灯永远是"最近动过没有"。 */
  const style = styleOf(styleId || DEFAULT_STYLE);
  const ctx = { BASE, wallAt, lit: (t) => litRatio(t.age) };

  const towerEnd = nGround + nTowers;
  // 建筑往里吐粒子的口子。**配额在这里挡**,不在每个原型里挡 —— 原型只管形状,
  // 一个写漏了边界检查的原型不该能把整个缓冲区写爆。
  const emit = (x, y, z, r, g, b, sc) => { if (p < towerEnd) put(x, y, z, r, g, b, sc); };
  for (let i = 0; i < towers.length && p < towerEnd; i++) {
    const t = towers[i];
    const share = Math.max(floorShare, Math.round(nTowers * t.w / wSum));
    const take = Math.min(share, towerEnd - p);
    const build = style.build[t.kind] || style.build.source;
    build(t, take, emit, ctx);
    // 信标:改动最勤的那座楼顶上立一根,尖是热的。城市里"现在正在动的是这一块"。
    // 它**不属于任何风格** —— 唐塔和金字塔上都该看得出哪一块正在被改。
    if (t.churn > 0 && t.churn === maxChurn && maxChurn >= 3 && p < towerEnd) {
      const mast = Math.min(200, towerEnd - p);
      for (let k = 0; k < mast; k++) {
        const u = k / mast;
        const hot = u > 0.82;
        put(t.cx + (Math.random() - 0.5) * 0.004, BASE + t.h + u * t.h * 0.30, t.cz + (Math.random() - 0.5) * 0.004,
            hot ? 1.0 : 0.95, hot ? 0.42 : 0.78, hot ? 0.30 : 0.55, hot ? 0.9 : 0.5);
      }
    }
  }

  /* ── ③ 提交天际线 ──
     53 周 × 7 天,一天一根小柱子,高度 = 那天的提交数。GitHub 贡献图立起来。

     摆在城市**背后**:这是这座城是怎么盖起来的,过去理应在身后。摆前面就得和
     名字那一排抢位置,而且会把"现在"挡在"过去"后面。 */
  if (nSkyPts > 0) {
    const skyEnd = p + nSkyPts;
    const COLS = 53, ROWS = 7;
    const maxDay = Math.max(1, ...days);
    const x0 = -1.02, x1 = 1.02, z0 = -1.22, z1 = -1.70;
    const cw = (x1 - x0) / COLS, cd = (z1 - z0) / ROWS;
    const total = days.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) || 1;
    const per = Math.max(2, Math.floor(nSkyPts / total));
    for (let i = 0; i < days.length && p < skyEnd; i++) {
      const v = days[i] | 0;
      if (v <= 0) continue;
      const col = Math.floor(i / ROWS), row = i % ROWS;
      if (col >= COLS) continue;
      const cx = x0 + (col + 0.5) * cw, cz = z0 + (row + 0.5) * cd;
      // 高度压过一道根号:一天二十次提交的日子不该把其余 364 天压成一条平线
      const hh = 0.02 + 0.30 * Math.sqrt(v / maxDay);
      // GitHub 那套绿:越勤越亮。亮度是**数量**,而颜色是"这是提交" —— 两件事分开。
      const t = Math.min(1, v / Math.max(2, maxDay * 0.6));
      const c = [0.09 + 0.16 * t, 0.20 + 0.62 * t, 0.14 + 0.22 * t];
      const take = Math.min(per, skyEnd - p);
      for (let k = 0; k < take; k++) {
        const f = (k + 0.5) / take;
        put(cx + (hash01c(k * 3.1 + i) - 0.5) * cw * 0.62,
            BASE + f * hh,
            cz + (hash01c(k * 7.3 + i) - 0.5) * cd * 0.62,
            c[0], c[1], c[2], 0.62);
      }
    }
    while (p < skyEnd) put((hash01c(p * 13) - 0.5) * 2.1, BASE - 0.004, z0 + hash01c(p * 17) * (z1 - z0), 0.10, 0.16, 0.13, 0.55);
  }

  /* ── ③b 地脉 ──
     两块街区之间来往越密,它们中间的地面就被踩得越亮。

     **刻意不画成线。** 第一版是从楼顶拉到楼顶的粒子弧 —— 规整、显眼、像是从别的
     软件贴上来的一层示意图,而不是这座城市自己长出来的东西。改成地面上一片**不匀
     的、中间宽两头收的低雾**:近看是散点,退一步才看出"这两块之间有条路"。关系这
     件事,主要交给**座次**去说(耦合强的本来就排成了邻居);这一层只是把它坐实,
     不该抢眼。 */
  if (nPathPts > 0) {
    const pathEnd = p + nPathPts;
    const maxW = Math.max(...paths.map((l) => l[2]));
    const wsum = paths.reduce((a, x) => a + Math.sqrt(x[2]), 0) || 1;
    for (const [ai, bi, w] of paths) {
      if (p >= pathEnd) break;
      const A = towers[ai], B = towers[bi];
      const share = Math.min(Math.round(nPathPts * Math.sqrt(w) / wsum), pathEnd - p);
      const strength = w / maxW;
      for (let k = 0; k < share; k++) {
        // 沿路不均匀:一段密一段疏,像是被走出来的,不是被画出来的
        let u = hash01c(k * 1.31 + ai * 17 + bi * 7);
        u = u + (hash01c(k * 5.7 + ai) - 0.5) * 0.22;
        u = Math.max(0, Math.min(1, u));
        if (hash01c(k * 9.1 + bi) > 0.35 + 0.65 * strength) continue;   // 稀的地方就是稀
        // 中间胖两头收:两端要收进楼底下,不然会看到两个突兀的端点
        const lens = Math.pow(Math.sin(Math.PI * u), 0.55);
        const spread = (A.foot + B.foot) * 0.28 * lens;
        const nx = -(B.cz - A.cz), nz = (B.cx - A.cx);
        const nl = Math.hypot(nx, nz) || 1;
        const off = (hash01c(k * 3.3 + ai * 5) + hash01c(k * 7.9 + bi * 3) - 1) * spread;
        const c = [
          A.rgb[0] + (B.rgb[0] - A.rgb[0]) * u,
          A.rgb[1] + (B.rgb[1] - A.rgb[1]) * u,
          A.rgb[2] + (B.rgb[2] - A.rgb[2]) * u,
        ];
        const glow = 0.16 + 0.30 * strength * lens;
        put(A.cx + (B.cx - A.cx) * u + nx / nl * off,
            BASE + 0.002 + hash01c(k * 11.3) * 0.010,
            A.cz + (B.cz - A.cz) * u + nz / nl * off,
            c[0] * glow + 0.05, c[1] * glow + 0.06, c[2] * glow + 0.08, 0.6);
      }
    }
    // 没用完的配额撒回街面 —— **绝不能塞到地底下**:整座城市按落点包围盒缩放,
    // 一颗埋在 y=−9 的隐形粒子会把城市在屏幕上压成一个小点(实测踩过)。
    while (p < pathEnd) put((hash01c(p) - 0.5) * 2.1, BASE - 0.004, (hash01c(p * 3) - 0.5) * 2.1, 0.20, 0.26, 0.34, 0.62);
  }

  /* ── ④ 标签 ── 位置在城市里,朝向对着屏幕。 */
  const unbake = (u, v) => {
    const y1 = v * cp, z1 = -v * sp;
    return [u * cy_ - z1 * sy, y1, u * sy + z1 * cy_];
  };

  /* 屋顶牌:每座楼头顶一块小牌子,写它叫什么。天空是空的,牌子放在自己屋顶正上方
     不会挡住别人 —— 而挂在楼身上会被这座楼自己的窗和色带吃掉。 */
  if (nTagPts > 0 && nTags > 0) {
    const tagEnd = p + nTagPts;
    const per = Math.floor(nTagPts / nTags);
    for (let i = 0; i < nTags && p < tagEnd; i++) {
      const t = towers[i];
      const h = 0.072, maxAspect = Math.max(3.2, (cell * 1.5) / h);
      const lab = sampleLabel(t.name, Math.min(per, tagEnd - p), maxAspect);
      if (!lab) continue;
      const w = h * lab.aspect;
      const ay = BASE + t.h + 0.07 + (t.churn === maxChurn && maxChurn >= 3 ? t.h * 0.32 : 0);
      const [lr, lg, lb] = [t.rgb[0] * 0.35 + 0.62, t.rgb[1] * 0.35 + 0.62, t.rgb[2] * 0.35 + 0.62];
      const take = Math.min(per, tagEnd - p);
      for (let k = 0; k < take; k++) {
        const [dx, dy, dz] = unbake(lab.pts[k * 2] * w, lab.pts[k * 2 + 1] * h);
        put(t.cx + dx, ay + dy, t.cz + dz, lr, lg, lb, 0.42);
      }
    }
    while (p < tagEnd) put((hash01c(p * 5) - 0.5) * 2.1, BASE - 0.004, (hash01c(p * 7) - 0.5) * 2.1, 0.20, 0.26, 0.34, 0.62);
  }
  if (nLabelPts > 0) {
    const LEADER = 110;
    const per = Math.floor(nLabelPts / nLabels);
    const boxW = (2 / nLabels) * 0.94;
    // 名字得**在真实大小下读得出来**才算数。放大到 2× 才看得清的标签等于没有 ——
    // 壁纸没有 hover,这一眼看不清就永远看不清了。
    const minH = 0.125;
    // 名字要站在**城外**。z 只推到 1.12 时,前排建筑被俯角压下来的投影正好盖在
    // 名字上 —— 城市越高压得越远,所以这条街得留够。
    const ROW_Y = BASE - 0.34, ROW_Z = 1.52;
    for (let i = 0; i < nLabels && p < n; i++) {
      const t = towers[i];
      const room = Math.min(per, n - p);
      const nMetric = Math.floor((room - LEADER) * 0.34);
      const lab = sampleLabel(t.name, Math.max(1, room - LEADER - nMetric), boxW / minH);
      if (!lab) continue;
      // **字高是固定的,宽度跟着名字走** —— 反过来(钉死宽度、由宽高比推字高)会让
      // "src" 这种短名字撑成巨无霸,而 "src-tauri" 缩成一行小字:同一排标签,
      // 字号差三倍。一排名字必须是同一个字号,那是"它们是同一类东西"的唯一提示。
      const h = minH, w = h * lab.aspect;
      const ax = -1 + (i + 0.5) * (2 / nLabels), ay = ROW_Y, az = ROW_Z;
      const [r0, g0, b0] = t.rgb;
      const lr = r0 * 0.45 + 0.55, lg = g0 * 0.45 + 0.55, lb = b0 * 0.45 + 0.55;
      const nPts = Math.max(1, room - LEADER - nMetric);
      for (let k = 0; k < nPts && p < n; k++) {
        const [dx, dy, dz] = unbake(lab.pts[k * 2] * w, lab.pts[k * 2 + 1] * h);
        put(ax + dx, ay + dy, az + dz, lr, lg, lb, 0.46);
      }
      // 名字下面一行读数:**几个文件、多大、多久没动**。名字说"这是什么",
      // 读数说"它在这个项目里有多重" —— 少了后半句,一座楼再高也只是好看。
      const facts = [t.files ? t.files + ' files' : '', human(t.bytesRaw), since(t.age)]
        .filter(Boolean).join(' · ');
      if (facts && nMetric > 8) {
        const mh = h * 0.52;
        const ml = sampleLabel(facts, Math.min(nMetric, n - p), boxW / mh);
        if (ml) {
          const mw = mh * ml.aspect;
          const take2 = Math.min(nMetric, n - p);
          for (let k = 0; k < take2 && p < n; k++) {
            const [dx, dy, dz] = unbake(ml.pts[k * 2] * mw, ml.pts[k * 2 + 1] * mh - h * 0.86);
            put(ax + dx, ay + dy, az + dz, lr * 0.72, lg * 0.74, lb * 0.80, 0.40);
          }
        }
      }
      const tx = t.cx, ty = BASE + 0.01, tz = t.cz + t.foot / 2;
      const [hx, hy, hz] = unbake(0, h * 0.62);
      const sx = ax + hx, syy = ay + hy, sz = az + hz;
      for (let k = 0; k < LEADER && p < n; k++) {
        const u = (k + 0.5) / LEADER;
        if (Math.floor(u * 26) % 2) continue;
        put(sx + (tx - sx) * u, syy + (ty - syy) * u, sz + (tz - sz) * u,
            r0 * 0.5 + 0.18, g0 * 0.5 + 0.18, b0 * 0.5 + 0.18, 0.5);
      }
    }
  }

  // 取整总会差几十颗,补在街上
  while (p < n) {
    put((Math.random() - 0.5) * 2.1, BASE - 0.004, (Math.random() - 0.5) * 2.1, 0.20, 0.26, 0.34, 0.62);
  }
  return { target, color, scale, used: p };
}

/**
 * **依赖星座**:这个仓库真正的代码图,摆成一团三维的星。
 *
 * 这是那台自由视角相机第一次真正有用的地方 —— 一张关系图平着看永远是一团线,
 * 只有转起来才看得出哪几块是抱团的。城市回答"这个仓库由什么组成",星座回答
 * "它们之间是怎么牵起来的"。
 *
 * 落点是 −1..1 的单位球,摆哪儿、多大由调用方决定。
 *
 * @param {{n:number[][], e:number[][]}} g 发布者机器上算好的定点坐标
 * @returns {{target:Float32Array, color:Float32Array, scale:Float32Array, used:number}}
 */
export function sampleConstellation(g, n) {
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const scale = new Float32Array(n); scale.fill(0.5);
  const nodes = (g && Array.isArray(g.n)) ? g.n : [];
  const edges = (g && Array.isArray(g.e)) ? g.e : [];
  if (nodes.length < 4 || !edges.length || n <= 0) return { target, color, scale, used: 0 };

  let p = 0;
  const put = (x, y, z, r, gg, b, sc) => {
    const o = p * 3;
    target[o] = x; target[o + 1] = y; target[o + 2] = z;
    color[o] = r; color[o + 1] = gg; color[o + 2] = b;
    scale[p] = sc; p++;
  };
  const px = (i) => (nodes[i][0] || 0) / 1000;
  const py = (i) => (nodes[i][1] || 0) / 1000;
  const pz = (i) => (nodes[i][2] || 0) / 1000;
  const degOf = (i) => Math.max(1, nodes[i][3] | 0);
  const rgbOf = (i) => (nodes[i][4] >= 0 ? COMMUNITY_RGB[nodes[i][4] % COMMUNITY_RGB.length] : COMMUNITY_NONE);
  const maxDeg = Math.max(...nodes.map((_, i) => degOf(i)));

  // 七成半给点、两成半给丝。丝再多一点就又变回"一张画出来的关系图"了 ——
  // 而这一层要的是"看得出抱团",不是"数得清有几条边"。
  const nNodePts = Math.round(n * 0.76);
  const wsum = nodes.reduce((a, _, i) => a + Math.sqrt(degOf(i)), 0) || 1;
  for (let i = 0; i < nodes.length && p < nNodePts; i++) {
    const deg = degOf(i), c = rgbOf(i);
    const share = Math.max(3, Math.round(nNodePts * Math.sqrt(deg) / wsum));
    // **枢纽更大更亮** —— 度数是这团星里唯一的量,别的都是类别(社区=颜色)。
    const rad = 0.012 + 0.042 * Math.pow(deg / maxDeg, 0.5);
    const glow = 0.52 + 0.48 * Math.pow(deg / maxDeg, 0.4);
    const take = Math.min(share, nNodePts - p);
    for (let k = 0; k < take; k++) {
      // 球**内**均匀要开立方根;直接取随机半径会让点全挤在表面上,看着像个空壳
      const u = hash01c(k * 1.7 + i * 31), v = hash01c(k * 3.3 + i * 17), w = hash01c(k * 5.9 + i * 7);
      const r = rad * Math.cbrt(u);
      const th = v * Math.PI * 2, ph = Math.acos(2 * w - 1);
      put(px(i) + r * Math.sin(ph) * Math.cos(th),
          py(i) + r * Math.cos(ph),
          pz(i) + r * Math.sin(ph) * Math.sin(th),
          Math.min(1, c[0] * glow), Math.min(1, c[1] * glow), Math.min(1, c[2] * glow),
          0.44 + 0.26 * (deg / maxDeg));
    }
  }

  /* 丝。**刻意不画成链** —— 城市里那种从楼顶拉到楼顶的规整粒子弧已经被否掉一次了
     (太像从别的软件贴过来的示意图),这里同一个道理:只留一层很淡、很不匀的丝,
     两端亮中间几乎没有,密的地方自然结成团。结构主要靠**位置**说 —— 力导向早就
     把有来往的点拉到一起了,丝只是把那句话坐实。 */
  while (p < n) {
    const k = p;
    const e = edges[k % edges.length];
    const a = e[0] | 0, b = e[1] | 0;
    if (!nodes[a] || !nodes[b]) { put(0, 0, 0, 0, 0, 0, 0.4); continue; }
    let u = hash01c(k * 2.11 + a * 13 + b);
    u = Math.max(0, Math.min(1, u + (hash01c(k * 9.7) - 0.5) * 0.34));
    const ca = rgbOf(a), cb = rgbOf(b);
    // 中段几乎全暗、只在两头亮一点:看到的是"这两颗星之间有点什么",
    // 而不是一根从 A 连到 B 的线。抖动也放大 —— 规整是这一层最要命的毛病。
    const fade = 0.03 + 0.30 * Math.pow(Math.abs(u - 0.5) * 2, 2.6);
    const j = 0.030;
    put(px(a) + (px(b) - px(a)) * u + (hash01c(k * 4.3) - 0.5) * j,
        py(a) + (py(b) - py(a)) * u + (hash01c(k * 6.1) - 0.5) * j,
        pz(a) + (pz(b) - pz(a)) * u + (hash01c(k * 8.9) - 0.5) * j,
        (ca[0] + cb[0]) * 0.5 * fade + 0.05,
        (ca[1] + cb[1]) * 0.5 * fade + 0.06,
        (ca[2] + cb[2]) * 0.5 * fade + 0.08, 0.40);
  }
  return { target, color, scale, used: p };
}

/* ══════════════ 右手边那一格:四种读法 ══════════════
   城市回答"这个仓库由什么组成"。但一个仓库还有另外三个问题,而它们**没有一个**
   能画进城市里 —— 硬塞进去只会把城市也一起弄糊:

     · 星座 —— 它们之间怎么牵着(sampleConstellation,在上面)
     · 年轮 —— 它的目录树有多深(sampleSunburst)
     · 热点 —— 现在到底在烧哪儿(sampleHotspots)
     · 人   —— 是谁写的(samplePeople)

   所以它们**轮流**占右边那一格:城市是主语,右边这一格是不断换的谓语。
   四个都用同一套约定:落点在 −1..1 的单位空间里,摆哪儿、多大由调用方决定。 */

/** 放射年轮:目录树摊成同心圆,内圈是顶层目录,外圈是它们的二级目录。
 *
 *  **要立起来**:一个平的旭日图在这套粒子里就是一块彩色圆饼,转过去只剩一条线。
 *  所以每一瓣按代码量往前**挤出厚度** —— 转起来的时候,厚的那几瓣自己会站出来。 */
export function sampleSunburst(dirs, n) {
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const scale = new Float32Array(n); scale.fill(0.62);
  const list = (Array.isArray(dirs) ? dirs : []).filter((d) => d && (d.files > 0 || d.bytes > 0));
  if (!list.length || n <= 0) return { target, color, scale, used: 0 };

  let p = 0;
  const put = (x, y, z, r, g, b, sc) => {
    if (p >= n) return;
    const o = p * 3;
    target[o] = x; target[o + 1] = y; target[o + 2] = z;
    color[o] = r; color[o + 1] = g; color[o + 2] = b;
    scale[p] = sc; p++;
  };
  const weight = (d) => Math.max(+d.bytes || 0, (+d.files || 0) * 2000);
  const total = list.reduce((a, d) => a + weight(d), 0) || 1;
  // 厚度压一道 log:一个 2MB 的目录不该把其余几瓣压成纸片
  const thick = (w) => 0.05 + 0.30 * Math.log10(1 + w / 1000) / Math.log10(1 + total / 1000);

  const R0 = 0.30, R1 = 0.60, R2 = 0.64, R3 = 0.95;
  const ringPts = Math.round(n * 0.52);          // 内圈:顶层目录
  let a0 = -Math.PI / 2;                          // 从正上方开始,顺时针
  for (const d of list) {
    const frac = weight(d) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const rgb = langRgb(d.lang);
    const dz = thick(weight(d));
    const take = Math.max(6, Math.round(ringPts * frac));
    for (let k = 0; k < take && p < ringPts; k++) {
      const u = hash01c(k * 1.7 + a0 * 31), v = hash01c(k * 3.1 + a0 * 17);
      const a = a0 + (a1 - a0) * u;
      const r = R0 + (R1 - R0) * Math.sqrt(v);
      // 侧壁比顶面亮一点:全一个亮度的挤出体看起来还是平的
      const face = hash01c(k * 5.3 + a0) < 0.72;
      const z = face ? dz : dz * hash01c(k * 7.9 + a0);
      const sh = face ? 1.0 : 0.66;
      put(Math.cos(a) * r, Math.sin(a) * r, z, rgb[0] * sh, rgb[1] * sh, rgb[2] * sh, 0.6);
    }
    // 外圈:这座楼底下的二级目录。没有子目录的就留一圈薄薄的底色 —— 空着比错着好,
    // 但**全空**会让人以为外圈坏了,所以留一道暗环把这一瓣的角度交代清楚。
    const kids = Array.isArray(d.kids) ? d.kids : [];
    const kidTot = kids.reduce((s, k) => s + Math.max(+k[2] || 0, (+k[1] || 0) * 2000), 0);
    let b0 = a0;
    const outerShare = Math.max(4, Math.round((n - ringPts) * frac));
    if (kids.length && kidTot > 0) {
      for (const kd of kids) {
        const kw = Math.max(+kd[2] || 0, (+kd[1] || 0) * 2000);
        const b1 = b0 + (a1 - a0) * (kw / kidTot);
        const kn = Math.max(3, Math.round(outerShare * (kw / kidTot)));
        const kz = thick(kw) * 0.7;
        for (let k = 0; k < kn && p < n; k++) {
          const u = hash01c(k * 2.3 + b0 * 41), v = hash01c(k * 4.7 + b0 * 13);
          const a = b0 + (b1 - b0) * u;
          const r = R2 + (R3 - R2) * Math.sqrt(v);
          // 外圈用同一族颜色但更淡:它是内圈的**细分**,不是另一件事
          const g = 0.55 + 0.30 * v;
          put(Math.cos(a) * r, Math.sin(a) * r, kz,
              rgb[0] * g, rgb[1] * g, rgb[2] * g, 0.52);
        }
        b0 = b1;
      }
    } else {
      for (let k = 0; k < outerShare && p < n; k++) {
        const a = a0 + (a1 - a0) * hash01c(k * 2.9 + a0 * 7);
        const r = R2 + (R3 - R2) * 0.12 * hash01c(k * 6.1);
        put(Math.cos(a) * r, Math.sin(a) * r, 0.01, rgb[0] * 0.26, rgb[1] * 0.26, rgb[2] * 0.26, 0.45);
      }
    }
    a0 = a1;
  }
  return { target, color, scale, used: p };
}

/** 热点:改得最勤 × 体量最大的那几个文件,烧成一团团光。
 *
 *  这是唯一用**温标**的一层(暗红 → 橙 → 白热)。语言色说"是什么",社区色说
 *  "跟谁一伙",而这里说的是"多烫" —— 一个连续的量,本来就该用一条渐变去说。 */
export function sampleHotspots(hot, n) {
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const scale = new Float32Array(n); scale.fill(0.55);
  const list = (Array.isArray(hot) ? hot : []).filter((h) => h && h.churn > 0 && h.bytes > 0);
  if (!list.length || n <= 0) return { target, color, scale, used: 0 };

  let p = 0;
  const put = (x, y, z, r, g, b, sc) => {
    if (p >= n) return;
    const o = p * 3;
    target[o] = x; target[o + 1] = y; target[o + 2] = z;
    color[o] = r; color[o + 1] = g; color[o + 2] = b;
    scale[p] = sc; p++;
  };
  const heat = (h) => h.churn * Math.log(Math.max(2, h.bytes));
  const hs = list.slice().sort((a, b) => heat(b) - heat(a));
  const maxHeat = heat(hs[0]) || 1;
  const wsum = hs.reduce((a, h) => a + Math.sqrt(heat(h)), 0) || 1;

  /** 温标。暗红是"动过",白热是"这儿一直在改" —— 中间不经过绿或蓝,
   *  因为一条穿过色相环的渐变会让人以为中段是另一个类别。 */
  const ramp = (t) => {
    const u = Math.max(0, Math.min(1, t));
    if (u < 0.5) { const k = u / 0.5; return [0.38 + 0.56 * k, 0.08 + 0.34 * k, 0.10 + 0.04 * k]; }
    const k = (u - 0.5) / 0.5;
    return [0.94 + 0.06 * k, 0.42 + 0.52 * k, 0.14 + 0.72 * k];
  };

  // 最烫的在中间,越外圈越凉 —— 用黄金角螺旋铺开,不成行也不成团
  for (let i = 0; i < hs.length && p < n; i++) {
    const h = hs[i];
    const t = heat(h) / maxHeat;
    const ang = i * 2.399963;                       // 黄金角
    const rr = 0.14 + 0.80 * Math.sqrt(i / Math.max(1, hs.length - 1));
    const cx = Math.cos(ang) * rr, cy = Math.sin(ang) * rr * 0.86;
    const rad = 0.030 + 0.085 * Math.pow(t, 0.6);
    const c = ramp(t);
    const take = Math.max(4, Math.round(n * Math.sqrt(heat(h)) / wsum));
    for (let k = 0; k < take && p < n; k++) {
      // 中间实、边缘散:一团有核的光才像在烧,均匀的圆盘只是个色块
      const u = hash01c(k * 1.9 + i * 29), v = hash01c(k * 3.7 + i * 11), w = hash01c(k * 6.3 + i * 5);
      const r = rad * Math.pow(u, 0.75);
      const th = v * Math.PI * 2, ph = Math.acos(2 * w - 1);
      const core = 1 - r / rad;                     // 越靠核越亮
      const g = 0.55 + 0.65 * core * core;
      put(cx + r * Math.sin(ph) * Math.cos(th),
          cy + r * Math.cos(ph),
          r * Math.sin(ph) * Math.sin(th) * 0.7,
          Math.min(1, c[0] * g), Math.min(1, c[1] * g), Math.min(1, c[2] * g),
          0.44 + 0.30 * core);
    }
  }
  return { target, color, scale, used: p };
}

/** 贡献者:一个人一颗星,大小按提交数,**名字就写在星旁边**。
 *
 *  这一层是那三个"结构"读法里唯一有人的。一个仓库不是自己长出来的,而城市、年轮、
 *  热点全都把人省掉了 —— 它们讲的是代码,不是写代码的人。 */
export function samplePeople(people, n) {
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const scale = new Float32Array(n); scale.fill(0.5);
  const list = (Array.isArray(people) ? people : [])
    .filter((x) => x && x[0] && (+x[1] || 0) > 0).slice(0, 10);
  if (!list.length || n <= 0) return { target, color, scale, used: 0 };

  let p = 0;
  const put = (x, y, z, r, g, b, sc) => {
    if (p >= n) return;
    const o = p * 3;
    target[o] = x; target[o + 1] = y; target[o + 2] = z;
    color[o] = r; color[o + 1] = g; color[o + 2] = b;
    scale[p] = sc; p++;
  };
  const maxC = Math.max(...list.map((x) => +x[1] || 0)) || 1;
  const wsum = list.reduce((a, x) => a + Math.sqrt(+x[1] || 0), 0) || 1;
  // 名字要占地方,所以星按**行**排,不按环排 —— 环形排布的名字会互相压
  const rows = list.length;
  for (let i = 0; i < rows && p < n; i++) {
    const [name, commits] = list[i];
    const t = (+commits || 0) / maxC;
    const y = 0.86 - (i / Math.max(1, rows - 1 || 1)) * 1.72 * (rows > 1 ? 1 : 0);
    const starX = -0.78;
    const share = Math.round(n * Math.sqrt(+commits || 0) / wsum);
    const nStar = Math.max(6, Math.round(share * 0.34));
    const nName = Math.max(10, share - nStar);
    // 星:提交越多越大越白;少的偏冷蓝 —— 一条从"来过"到"扛着"的渐变
    const rad = 0.022 + 0.062 * Math.pow(t, 0.55);
    const c = [0.52 + 0.48 * t, 0.66 + 0.32 * t, 0.86 + 0.14 * t];
    for (let k = 0; k < nStar && p < n; k++) {
      const u = hash01c(k * 2.1 + i * 37), v = hash01c(k * 4.3 + i * 19), w = hash01c(k * 7.1 + i * 3);
      const r = rad * Math.cbrt(u);
      const th = v * Math.PI * 2, ph = Math.acos(2 * w - 1);
      const core = 1 - r / rad;
      const g = 0.6 + 0.6 * core;
      put(starX + r * Math.sin(ph) * Math.cos(th), y + r * Math.cos(ph),
          r * Math.sin(ph) * Math.sin(th),
          Math.min(1, c[0] * g), Math.min(1, c[1] * g), Math.min(1, c[2] * g), 0.5);
    }
    // 名字:紧贴着星的右边。字比星小一号 —— 它是标注,不是主角。
    const lab = sampleLabel(name, nName, 9);
    if (lab) {
      const h = 0.115, w2 = h * lab.aspect;
      const x0 = starX + rad + 0.06;
      for (let k = 0; k < nName && p < n; k++) {
        const lx = lab.pts[k * 2], ly = lab.pts[k * 2 + 1];
        const dim = 0.62 + 0.38 * t;
        put(x0 + (lx + 0.5) * w2, y + ly * h, 0,
            0.80 * dim, 0.85 * dim, 0.95 * dim, 0.3);
      }
    }
  }
  return { target, color, scale, used: p };
}

/**
 * 项目缩影层:一张由粒子构成的图,带自己的出场/退场包络。
 *
 * 生命周期是**一段有头有尾的演出**,不是一个开关:浮现(in)→ 停住(hold)→ 散去(out)。
 * 广场上点一下别人的项目,你的壁纸上就演这么一段,然后回到原来的样子。
 */
export class ProjectLayer {
  /** @param {THREE.Texture} dotTex 和其余粒子共用的那张 soft-dot 精灵 */
  constructor(dotTex, n = PROJECT_POINTS, nCity = CITY_POINTS) {
    this.n = n;
    this.nCity = nCity;
    this.u = {
      uForm: { value: 0 }, uVis: { value: 0 }, uAlpha: { value: 1 },
      uPixel: { value: 1 }, uPointScale: { value: 1.6 }, uTime: { value: 0 },
      uSize: { value: 1.25 }, uDotTex: { value: dotTex },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: PROJ_VS, fragmentShader: PROJ_FS,
      transparent: true, depthWrite: false, depthTest: false,
      // **不能用加性混合**。壁纸上其余的粒子是"光",叠得越多越亮正是要的效果;
      // 但这一层是**一张图**,24000 颗点叠在一块巴掌大的矩形上,加性混合会直接烧成
      // 一片纯白 —— 图没了,只剩一个白方块(实测)。正常混合才能把颜色画对。
      blending: THREE.NormalBlending,
    });

    this.geo = this._mkGeo(n);
    this.cityGeo = this._mkGeo(nCity);
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    // 城市是**另一个对象**,而且挂法不一样(见 mineradio 的 showProject):
    // 图和字挂在会朝相机转正的那个 Group 里 —— 字是拿来读的,转到 70° 就只剩一条
    // 亮线。城市恰恰相反:**转得到才有意义**,不转的城市就是一张斜着的图。
    // 两种相反的处理,只能是两个对象。材质和 uniform 是同一份,所以它们仍旧
    // 一起浮现、一起散去。
    this.cityPoints = new THREE.Points(this.cityGeo, this.mat);
    this.cityPoints.frustumCulled = false;
    this.cityPoints.renderOrder = 3;      // 画在最后 = 在最前面
    this.points.visible = false;
    this.cityPoints.visible = false;
    /** 右边那一格现在有几种读法可轮(由 `_setCity` 算出来,轮播的拍数要用)。 */
    this.sceneCount = 0;
    /** 这一段演出:{ t0, life, inMs, outMs } */
    this.show = null;
  }

  _mkGeo(n) {
    const geo = new THREE.BufferGeometry();
    const rnd = new Float32Array(n);
    for (let i = 0; i < n; i++) rnd[i] = Math.random();
    // position 必须有,three 要用它算包围球;真正的落点在 aTarget 里。
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    const sc = new Float32Array(n); sc.fill(1);
    geo.setAttribute('aScale', new THREE.BufferAttribute(sc, 1));
    return geo;
  }

  /**
   * 摆好这一段要演的全部内容:图在上,标题在下,信息再往下。
   *
   * 粒子预算是**分开给**的(图 70%、标题 20%、信息 10%),不是把所有亮像素混在一起
   * 平摊 —— 混在一起的话,一张大图会把标题的笔画摊到只剩几十颗粒子,字就消失了。
   *
   * @param {HTMLImageElement|null} img
   * @param {{title?:string, lines?:string[]}} text
   */
  setShow(img, text, sizeUnits) {
    const T = this.geo.attributes.aTarget.array;
    const C = this.geo.attributes.aColor.array;
    const S = this.geo.attributes.aScale.array;
    T.fill(0); C.fill(0); S.fill(1);

    // 一块字里放什么:标题、项目自己的信息、以及广场上最有人气的几条评论。
    // 评论用偏冷的白 —— 那是"别人说的",不该和项目自己的品牌色抢。
    const rows = [];
    if (text && text.title) rows.push({ text: String(text.title).slice(0, 26), px: 96, weight: 800, css: '#F2F7FF' });
    for (const l of ((text && text.lines) || []).filter(Boolean).slice(0, 2)) {
      rows.push({ text: String(l).slice(0, 40), px: 58, weight: 700, css: '#C9F03D' });
    }
    // 语言图例:**哪个颜色是哪门语言**。
    //
    // 整座城市的颜色都在按语言编码 —— 塔身的色带、地脉的渐变、屋顶牌的底色。
    // 没有图例的话,那是一堆好看的颜色;有了图例,同一堆颜色才变成一句话。
    // 一行搞定:每门语言一个小方块 + 名字 + 占比,方块就是那门语言的颜色本身。
    const legend = (Array.isArray(text && text.langs) ? text.langs : [])
      .map((x) => [String((x && x[0]) || ''), Math.max(0, +(x && x[1]) || 0)])
      .filter((x) => x[0] && x[1] >= 0.02)
      .slice(0, 4);
    if (legend.length) {
      const parts = [];
      for (const [lang, frac] of legend) {
        const rgb = langRgb(lang);
        const css = `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
        // 方块用那门语言的真颜色,名字用偏白的同色系 —— 方块负责"是哪个颜色",
        // 名字负责"读得出来"。名字也染成纯语言色的话,深色语言(java 那种褐)在
        // 黑底上就没了。
        parts.push({ text: (parts.length ? '   ' : '') + '■ ', css, px: 34 });
        parts.push({ text: lang + ' ' + Math.round(frac * 100) + '%', px: 40,
                     css: `rgb(${Math.round(rgb[0] * 140 + 110)},${Math.round(rgb[1] * 140 + 110)},${Math.round(rgb[2] * 140 + 110)})` });
      }
      rows.push({ px: 44, weight: 700, css: '#C9D4E6', parts });
    }

    // 评论 = 一句话 + **说这句话的人**。只画话不画名字,壁纸上就是几行来路不明的
    // 字;广场上"有人在看你的项目"这件事,是靠那个名字成立的。
    // 名字小一号、暗一点、跟在破折号后面 —— 它是署名,不该和话本身抢。
    for (const c of ((text && text.comments) || [])) {
      const body = String((c && typeof c === 'object' ? c.body : c) || '').trim();
      if (!body) continue;
      const who = String((c && typeof c === 'object' && (c.author || c.name)) || '').trim();
      // 硬上限只是**兜底**(别让一条几百字的评论把整块排版拖垮),真正决定截到哪里的
      // 是下面按宽度截的那一步 —— 它会补上省略号,也会把署名留住。
      const short = body.length > 60 ? body.slice(0, 60).replace(/\s+$/, '') + '…' : body;
      const parts = [{ text: '“' + short, tail: '”' }];
      if (who) parts.push({ text: '  — ' + who.slice(0, 18), px: 38, weight: 700, css: '#7C93BC' });
      rows.push({ px: 50, weight: 600, css: '#9FB4D6', parts });
      if (rows.length >= 6) break;   // 标题 + 两行信息 + 三条评论
    }

    const hasImg = !!img;
    const hasText = rows.length > 0;
    // 代码城市。它有**自己的一块粒子**,所以加上城市之后图和字一颗也没少。
    const hasCity = this._setCity((text && text.dirs) || [], text && text.style, text && text.links,
      text && text.commits, text && text.graph,
      { hot: text && text.hot, people: text && text.people, narrow: text && text.narrow,
        noImage: !img },
      (text && text.scene) | 0);
    // 字要**看得清**才有意义,所以粒子分配偏向字:图靠密度成形,字靠笔画成形,
    // 而笔画细得多。没有图的时候全部给字。
    // 背景板铺满整个取景框,面积是原来那条小带子的十几倍 —— 粒子得跟上,
    // 否则它不是一张背景,是一层沙。字只有六行,让出一点也还看得清。
    const nImg = hasImg ? Math.round(this.n * (hasText ? (hasCity ? 0.72 : 0.62) : 1)) : 0;
    const nText = this.n - nImg;

    /**
     * 把一份采样摆到画面上。
     *
     * ⚠ `pre`:这份采样**自己已经带着比例了**。
     * `sampleImage` 是把图按原比例画进一张方画布再采的(空的地方不给粒子),所以它
     * 吐出来的点本身就是原图的形状;而 `sampleBlock` 是把整块字**拉满**到 −1..1,
     * 比例只在 `aspect` 里。两者不分开处理的话,图会被**再乘一次比例** ——
     * 一张 16:9 的封面最后画成 3.2:1,又扁又长。那就是"比例不对"的来源。
     */
    const place = (s, from, count, cy, half, dot, opt) => {
      if (!s.used || count <= 0) return false;
      const o2 = opt || {};
      const a = s.aspect || 1;
      const dim = o2.dim == null ? 1 : o2.dim;
      const z = o2.z || 0;
      for (let i = 0; i < count; i++) {
        const o = (from + i) * 3, k = i * 3;
        let x = s.target[k], y = s.target[k + 1];
        let scale = half;
        if (!o2.pre) {                       // 字:比例还没进坐标,在这儿补
          if (a >= 1) y /= a; else x *= a;
          scale = a >= 1 ? half * a : half;
        }
        T[o] = x * scale + (o2.cx || 0);
        T[o + 1] = y * scale + cy;
        T[o + 2] = z;
        C[o] = s.color[k] * dim; C[o + 1] = s.color[k + 1] * dim; C[o + 2] = s.color[k + 2] * dim;
        S[from + i] = dot || 1;
      }
      return true;
    };

    let any = hasCity;
    /* 有城市的时候,图**不是画面上的一块**,而是这座城市的背景板。
       原来它是顶上一条 0.20 高的小带子 —— 又小,又和城市各说各的。现在它铺满整个
       取景框、退到城市**后面**去(z 负 = 远离相机),城市站在它前面。
       两件事让它读起来像"贴在后面的一张背景",而不是"另一张图":
         · **压暗**:背景板比主体亮,人眼会先看背景。压到四成半,城市自己就站出来了。
         · **点更大**:同样的粒子摊到大得多的面积上,点小了就成了一层稀疏的沙。 */
    const imgCy = hasCity ? 0.10 : (hasText ? 0.62 : 0.10);
    const imgHalf = hasCity ? 1.04 : (hasText ? 0.40 : 0.62);
    const txtCy = hasCity ? -0.83 : (hasImg ? -0.42 : 0);
    const txtHalf = hasCity ? 0.19 : (hasImg ? 0.30 : 0.52);
    if (hasImg) {
      const s = sampleImage(img, nImg);
      if (place(s, 0, nImg, imgCy, imgHalf, hasCity ? 1.7 : 1,
                { pre: true, dim: hasCity ? 0.45 : 1, z: hasCity ? -0.55 : 0 })) any = true;
    }
    if (hasText && nText > 0) {
      const s = sampleBlock(rows, nText);
      // 字的点比图的点小:一行 20 多像素高的字,拿画图那种点去画就是一条糊掉的
      // 色块(第一版六行字全成了实心方块)。
      if (place(s, nImg, nText, txtCy, txtHalf, 0.5)) any = true;
    }
    this.geo.attributes.aTarget.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aScale.needsUpdate = true;
    this.u.uSize.value = sizeUnits || 1.6;
    return any;
  }

  /**
   * 把目录统计摆进城市那块粒子里。返回这一屏到底有没有城市。
   *
   * 缩放是**按实际包围盒算的**,不是照着摆城市时那套坐标猜的:俯角和偏航已经把
   * 那套坐标转过一遍了,转完之后城市占多大,只有量一遍才知道。写死一个系数,
   * 换个塔数就会顶出画面或者缩成一小撮。
   */
  /* `extras.narrow` says the frame is a portrait phone rather than a wallpaper.
     16:9 has empty space either side, which is why the city stands centre-left
     with a reading beside it. A phone held upright has no such space: side by
     side there makes both halves too small to read AND slices the city at the
     edge. So on a narrow frame the two take TURNS at full width instead of
     sharing one — each gets the whole frame, and the rotation already exists to
     carry them. */
  _setCity(dirs, styleId, links, commits, graph, extras, scene) {
    const T = this.cityGeo.attributes.aTarget.array;
    const C = this.cityGeo.attributes.aColor.array;
    const S = this.cityGeo.attributes.aScale.array;
    T.fill(0); C.fill(0); S.fill(1);
    const mark = () => {
      this.cityGeo.attributes.aTarget.needsUpdate = true;
      this.cityGeo.attributes.aColor.needsUpdate = true;
      this.cityGeo.attributes.aScale.needsUpdate = true;
    };
    const list = Array.isArray(dirs) ? dirs : [];
    const gph = (graph && Array.isArray(graph.n) && graph.n.length >= 4
                 && Array.isArray(graph.e) && graph.e.length) ? graph : null;
    const ex = extras || {};
    /* 右边那一格现在有四种读法,**手上有哪几种就轮哪几种** —— 不是每个仓库都有
       知识图谱,也不是每个都是 git 仓库。凑不齐就少轮几幕,而不是留一格空白:
       一格空白看起来像坏了,少一幕没人看得出来。 */
    const scenes = [];
    if (gph) scenes.push({ k: 'graph' });
    if (list.some((d) => Array.isArray(d.kids) && d.kids.length)) scenes.push({ k: 'rings' });
    if (Array.isArray(ex.hot) && ex.hot.length >= 3) scenes.push({ k: 'hot' });
    if (Array.isArray(ex.people) && ex.people.length >= 2) scenes.push({ k: 'people' });
    this.sceneCount = scenes.length;
    const pick = scenes.length ? scenes[((scene | 0) % scenes.length + scenes.length) % scenes.length] : null;
    if (!list.length && !pick) { this.cityPoints.visible = false; mark(); return false; }

    // 星座**不和城市共用一个包围盒**。摞在城市头顶试过:两个都被压扁,而且这一格
    // 本来就只有一条一米宽的横带。16:9 的两侧是空的 —— 城市在中间偏左,星座站到
    // 右边去,两块各自按自己的尺度缩放,谁也不挤谁。
    const narrow = !!(ex && ex.narrow);
    /* ⚠ NO SIDE READING ON A PHONE. AT ALL.
       16:9 has empty space beside the city, which is what that panel is for. A
       phone has none, and two attempts to make it fit both failed in ways worth
       recording:

         · side by side made each half too small to read AND sliced the towers
           at the screen edge;
         · taking turns did not work either, because the city is drawn from the
           SAME point budget — handing the reading 55% of it left the city
           standing in the other 45% underneath, so what you got was a hotspot
           disc smothering a city rather than replacing it. Measured on screen:
           the city was perfect at 1.6s and buried under an orange disc at 3.6s.

       The city is what somebody opened the project to see. On a frame this
       narrow it gets the whole of it, and the readings stay what they were
       built for — a wallpaper. */
    if (narrow) this.sceneCount = 1;

    /* ⚠ NOT every point. Handing a reading the city's whole budget looked like
       a smear: sampleHotspots and friends size their dots for a quarter of the
       points in a small panel, so four times as many at nearly twice the radius
       is one solid cloud with no shape in it. A little over half is enough to
       read at full width. */
    const nStar = (pick && !narrow) ? Math.round(this.nCity * 0.26) : 0;
    const nCityPts = this.nCity - nStar;
    const s = sampleCity(list, nCityPts, styleId, links, commits);
    if (!s.used && !nStar) { this.cityPoints.visible = false; mark(); return false; }

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < s.used; i++) {
      const x = s.target[i * 3], y = s.target[i * 3 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // 城市现在是这一屏的主角,给它整条中间带。图退到顶上、字退到底下,
    // 三块正好接上不打架(图底 0.56 / 城市 ±0.56 / 字顶 −0.56)。
    // 有星座的时候城市让出右边那块,自己往左挪。
    // Sharing the frame is the only reason to shrink and shift; alternating
    // means the city always gets the middle and all of the width.
    const sharing = nStar > 0 && !narrow;
    const HALF_W = sharing ? 0.82 : 1.00;
    /* The top band belongs to the cover image. A capsule with no cover — every
       capsule a scan produces for a repo with no screenshots — leaves it empty,
       and on a tall phone that is a third of the screen of nothing above a small
       city. When there is no image to make room for, the city takes the room. */
    const roomy = narrow && !!(ex && ex.noImage);
    const HALF_H = roomy ? 0.78 : 0.56;
    const CITY_CX = sharing ? -0.46 : 0;
    // 整块往上抬一点:城市底下还挂着一排名字,不抬的话它们正好压在标题上。
    const CITY_CY = roomy ? 0.20 : 0.07;
    // 一个目录都没有、只有图谱的项目是可能的(比如一个只有几个源文件的小仓库)。
    // 那时候包围盒是 ±Infinity,k 会算成 NaN,整块粒子静静地全落在原点 —— 屏幕上
    // 是一个亮点,而不是一个报错。这种"安静地错"最难查,所以在这儿挡掉。
    const k = s.used
      ? Math.min(HALF_W / Math.max(1e-4, (x1 - x0) / 2), HALF_H / Math.max(1e-4, (y1 - y0) / 2))
      : 1;
    const mx = s.used ? (x0 + x1) / 2 : 0, my = s.used ? (y0 + y1) / 2 : 0;
    // 城市**往前站**。z 是往相机方向的,所以它压在图和字前面 —— 这一层的
    // depthTest 是关掉的,所以真正决定谁挡谁的是画的先后(renderOrder),
    // 而这个 z 决定的是**转起来的时候**它在图和字前面多远。
    const Z_FRONT = 0.30;
    for (let i = 0; i < nCityPts; i++) {
      const o = i * 3;
      if (i < s.used) {
        T[o] = (s.target[o] - mx) * k + CITY_CX;
        T[o + 1] = (s.target[o + 1] - my) * k + CITY_CY;
        T[o + 2] = s.target[o + 2] * k + Z_FRONT;
        C[o] = s.color[o]; C[o + 1] = s.color[o + 1]; C[o + 2] = s.color[o + 2];
      }
      // 大小由 sampleCity 决定:地面、塔身、标签要的点各不一样(标签最小 —— 一个
      // 40px 高的名字拿画塔那种点去画就是一条实心色带)。
      S[i] = s.scale[i] || 0.82;
    }

    // 右边那一格。半径按**自己**的尺度定,和城市多大无关 —— 一个只有三座楼的小
    // 项目,它的关系图不该跟着缩成一粒沙。
    if (nStar && pick) {
      const st = pick.k === 'graph' ? sampleConstellation(gph, nStar)
        : pick.k === 'rings' ? sampleSunburst(list, nStar)
        : pick.k === 'hot' ? sampleHotspots(ex.hot, nStar)
        : samplePeople(ex.people, nStar);
      // Beside the city on a wallpaper; dead centre and much bigger when it has
      // the frame to itself.
      // Beside the city — the only place it is ever drawn now, and only on a
      // frame wide enough to have a beside.
      const SR = 0.52, SCX = 1.16, SCY = 0.10, SCZ = 0.22;
      for (let i = 0; i < nStar; i++) {
        const o = (nCityPts + i) * 3;
        if (i < st.used) {
          T[o] = st.target[i * 3] * SR + SCX;
          T[o + 1] = st.target[i * 3 + 1] * SR + SCY;
          T[o + 2] = st.target[i * 3 + 2] * SR + SCZ;
          C[o] = st.color[i * 3]; C[o + 1] = st.color[i * 3 + 1]; C[o + 2] = st.color[i * 3 + 2];
          S[nCityPts + i] = st.scale[i] || 0.5;
        }
      }
    }
    mark();
    this.cityPoints.visible = true;
    return true;
  }

  /** 换一张图。返回是否采到了内容 —— 没采到就别演,空着比错着好。 */
  setImage(img, sizeUnits) {
    const s = sampleImage(img, this.n);
    if (!s.used) return false;
    // 按图的比例摆:横图更宽、竖图更高,而不是一律撑成方的
    const a = s.aspect || 1;
    const t = s.target;
    for (let i = 0; i < this.n; i++) {
      if (a >= 1) t[i * 3 + 1] /= a; else t[i * 3] *= a;
    }
    this.geo.attributes.aTarget.array.set(t);
    this.geo.attributes.aTarget.needsUpdate = true;
    this.geo.attributes.aColor.array.set(s.color);
    this.geo.attributes.aColor.needsUpdate = true;
    this.u.uSize.value = sizeUnits || 1.6;
    return true;
  }

  /** 开演。life 是整段时长(毫秒),含进场和退场。 */
  play(life = 20000, inMs = 1400, outMs = 1200) {
    this.show = { t0: performance.now(), life, inMs, outMs };
    // 不演的时候整个对象是隐形的。以前是把 uVis 归零 —— 点还是每帧都在画,只是
    // 全透明。壁纸是常驻的:一天里 99% 的时间在为一段没在放的演出画七万个点。
    this.points.visible = true;
  }

  /** 换了图之后再聚一次:粒子先散开一点再排成新的一张,换图才看得出来是**换**,
   *  而不是画面忽然跳了一下。 */
  reform() {
    if (!this.show) return;
    this.show.reformAt = performance.now();
  }

  stop() {
    this.show = null;
    this.u.uVis.value = 0;
    this.u.uForm.value = 0;
    this.points.visible = false;
    this.cityPoints.visible = false;
  }

  /** 每帧推进包络。返回 true 表示这一层还要画。 */
  update(timeSec) {
    this.u.uTime.value = timeSec;
    if (!this.show) { this.u.uVis.value = 0; return false; }
    const age = performance.now() - this.show.t0;
    const { life, inMs, outMs } = this.show;
    if (age >= life) { this.stop(); return false; }
    const smooth = (u) => u * u * u * (u * (u * 6 - 15) + 10);
    let form, vis;
    if (age < inMs) {
      const t = age / inMs;
      form = smooth(t); vis = Math.min(1, t * 1.6);
    } else if (age > life - outMs) {
      const t = (age - (life - outMs)) / outMs;
      form = 1 - smooth(t); vis = 1 - smooth(t);
    } else {
      form = 1; vis = 1;
      // 刚换过图:短暂地散开再聚回来
      if (this.show.reformAt) {
        const r = (performance.now() - this.show.reformAt) / 700;
        if (r < 1) form = 0.35 + 0.65 * smooth(Math.max(0, Math.min(1, r)));
        else this.show.reformAt = 0;
      }
    }
    this.u.uForm.value = form;
    this.u.uVis.value = vis;
    return true;
  }

  dispose() {
    try { this.geo.dispose(); this.cityGeo.dispose(); this.mat.dispose(); } catch (e) {}
  }
}
