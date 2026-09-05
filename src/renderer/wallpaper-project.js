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

/** 一个项目缩影用多少颗粒子。24k 在 96px 封面上等于每个像素约 2.6 颗 —— 足够密到
 *  看得出是那张图,又不至于让常驻的壁纸多背一个几十万点的负担。 */
export const PROJECT_POINTS = 48000;
/** 采样画布。**必须比封面细**:采样格子比像素粗,图就糊成一片色块(第一版 128 配
 *  96px 封面就是这个下场 —— 一团绿,认不出是什么)。 */
const SAMPLE_W = 224, SAMPLE_H = 224;
/** 太暗的像素不占粒子:深色背景是图片里最不值钱的部分,把粒子让给有内容的地方。 */
const LUMA_FLOOR = 0.06;

export const PROJ_VS = `
precision highp float;
attribute vec3 aTarget;     // 落位(平面坐标)
attribute vec3 aColor;      // 这颗粒子那个像素的颜色
attribute float aRand;
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
  gl_PointSize = (1.15 + uForm * 0.75) * uPixel * uPointScale;
  gl_Position = projectionMatrix * mv;
}
`;

export const PROJ_FS = `
precision highp float;
uniform sampler2D uDotTex;
uniform float uAlpha;
varying vec3 vColor;
varying float vA;
void main(){
  vec4 t = texture2D(uDotTex, gl_PointCoord);
  if (t.a < 0.02) discard;
  gl_FragColor = vec4(vColor, t.a * vA * uAlpha);
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
 * 项目缩影层:一张由粒子构成的图,带自己的出场/退场包络。
 *
 * 生命周期是**一段有头有尾的演出**,不是一个开关:浮现(in)→ 停住(hold)→ 散去(out)。
 * 广场上点一下别人的项目,你的壁纸上就演这么一段,然后回到原来的样子。
 */
export class ProjectLayer {
  /** @param {THREE.Texture} dotTex 和其余粒子共用的那张 soft-dot 精灵 */
  constructor(dotTex, n = PROJECT_POINTS) {
    this.n = n;
    const geo = new THREE.BufferGeometry();
    const rnd = new Float32Array(n);
    for (let i = 0; i < n; i++) rnd[i] = Math.random();
    // position 必须有,three 要用它算包围球;真正的落点在 aTarget 里。
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    this.geo = geo;
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
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    /** 这一段演出:{ t0, life, inMs, outMs } */
    this.show = null;
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
  }

  stop() { this.show = null; this.u.uVis.value = 0; this.u.uForm.value = 0; }

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
    }
    this.u.uForm.value = form;
    this.u.uVis.value = vis;
    return true;
  }

  dispose() {
    try { this.geo.dispose(); this.mat.dispose(); } catch (e) {}
  }
}
