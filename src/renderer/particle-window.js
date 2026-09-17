/**
 * particle-window.js —— 把 agent 窗口的每一帧,重画成一团粒子。
 *
 * 这一层和壁纸那边的粒子不是同一种东西,别把它们混起来看:
 * 壁纸画的是**一张固定的图**,可以慢慢采样、慢慢聚拢;这里画的是**每秒十二帧的直播**,
 * 每一帧都要重新决定"哪些像素配得上一颗粒子",而且必须在两三毫秒内决定完。
 *
 * ── 为什么不是均匀采样 ──
 * 一个 480×300 的窗口有 14 万个像素,而我们只有 ~9 万颗粒子。均匀撒下去,大片空白的
 * 背景会吃掉一大半配额,而**字**——这个窗口里唯一有信息的东西——只分到零星几颗,
 * 糊成一片。所以配额是按**梯度**给的:一个像素和它邻居差得越多(也就是越像笔画的边),
 * 越值得给粒子。整片同色的背景几乎不占配额。
 *
 * 这和封面那一层的教训是同一条:`sampleImage` 里之所以要"按扫描顺序等距取"而不是散列,
 * 是因为**结构**比覆盖率重要。这里更进一步:连"取哪些"都由结构说了算。
 */
import * as THREE from 'three';
import { listenGestures } from './gesture-core.js';

/* 事件桥。**故意写成可缺省的**:这一页要能在普通浏览器里单独打开来调 ——
   粒子采样(哪些像素配得上一颗粒子)是这个功能里最容易出错、也最需要肉眼看的一段,
   而它和 Tauri 没有半点关系。整页锁死在 __TAURI__ 上,就只能靠打包一次看一眼。 */
const listen = window.__TAURI__?.event?.listen || (async () => () => {});

/** 粒子数。
 *  13 万不是随便挑的:一块 720×520 的面板里,真正有笔画的像素大约两三万,而一个
 *  笔画要**至少两三颗粒子**才不会断。配额是按梯度给的,所以这 13 万里绝大部分都
 *  落在字上 —— 9 万的时候细笔画会断续,读起来费劲。 */
const N = 130000;
/** 采样画布的长边。和抓帧那边(LONG_EDGE=480)对齐,免得再缩一次。 */
const SAMPLE_MAX = 480;

const VS = `
precision highp float;
attribute vec3 aTarget;
attribute vec3 aColor;
attribute float aRand;
uniform float uTime, uPixel, uForm;
// 手势(Pro):没有手的时候 uHandP.z = 0、uZoomP.x = 1,下面两段一行都不起作用
uniform vec3 uHandP;   // 手的位置(相机坐标)+ 强度
uniform vec3 uZoomP;   // 缩放倍数 + 中心
uniform vec4 uLensP;   // 放大镜:x, y, 半径, 倍数(1 = 关)—— 指着一处停住,那一块字放大
varying vec3 vColor;
varying float vA;
void main(){
  // 落位之外再加一点点呼吸。完全静止的点阵会显出规则网格,而这一层每帧都在换内容,
  // 一点微动让它看起来是"活的",而不是一张抖动的截图。
  float amt = 1.0 - uForm;
  vec3 pos = aTarget + vec3(
    sin(uTime * 1.7 + aRand * 31.0) * 0.0018,
    cos(uTime * 1.9 + aRand * 17.0) * 0.0018,
    0.0) + vec3(0.0, 0.0, amt * (aRand - 0.5) * 0.6);
  // 张开手掌:手周围的粒子被推开,手移走就弹回原位
  if (uHandP.z > 0.0) {
    vec2 d = pos.xy - uHandP.xy; float r = length(d) + 1e-4;
    float k = 1.0 - smoothstep(0.0, 0.22, r);
    pos.xy += d / r * k * k * 0.12 * uHandP.z;
  }
  // 两只手捏住拉开:以两手中点为中心放大
  float zs = uZoomP.x;
  if (zs != 1.0) pos.xy = uZoomP.yz + (pos.xy - uZoomP.yz) * zs;
  float lf = 1.0;
  if (uLensP.w > 1.001) {
    vec2 ld = pos.xy - uLensP.xy; float lr = length(ld);
    lf = mix(uLensP.w, 1.0, smoothstep(uLensP.z * 0.35, uLensP.z, lr));
    pos.xy = uLensP.xy + ld * lf;
  }
  vColor = aColor;
  // 闪烁压到很轻。"粒子感"是靠动,可**字是拿来读的** —— 一直在明灭的字,眼睛
  // 会一直重新对焦,读两行就累。留一点点呼吸就够了。
  vA = uForm * (0.94 + 0.06 * sin(uTime * 2.3 + aRand * 41.0));
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  // 点要**盖住笔画**。比间距小一点点是给图片用的(免得糊),但字反过来:
  // 一条 2px 宽的笔画上如果点比像素还小,它就是一串断开的珠子,不是一横。
  gl_PointSize = (1.55 + 0.35 * aRand) * uPixel * max(1.0, zs) * lf;
  gl_Position = projectionMatrix * mv;
}`;

const FS = `
precision highp float;
varying vec3 vColor;
varying float vA;
void main(){
  // 硬边圆点,不是光晕。几万颗光晕叠在一起会把字糊掉 —— 封面那一层踩过这个坑,
  // 这里直接用它的结论。
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  float a = 1.0 - smoothstep(0.40, 0.5, r);
  if (a < 0.02) discard;
  /* 提亮 1.7 倍。粒子之间是**黑的**,所以同一个颜色画成粒子,眼睛收到的总光量
     比实心字少一大截 —— 不补回来,屏幕上就是"看得见但读着费劲"。
     1.7 是量出来的:再高,亮部就糊成一片白,笔画之间的缝反而没了。 */
  gl_FragColor = vec4(min(vec3(1.0), vColor * 1.7), a * vA);
}`;

const cv = document.getElementById('gl');
const boot = document.getElementById('boot');
const renderer = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: false });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
camera.position.z = 2;

const geo = new THREE.BufferGeometry();
const target = new Float32Array(N * 3);
const color = new Float32Array(N * 3);
const rand = new Float32Array(N);
for (let i = 0; i < N; i++) rand[i] = Math.random();
geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
geo.setAttribute('aTarget', new THREE.BufferAttribute(target, 3));
geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
const uni = {
  uTime: { value: 0 }, uPixel: { value: 1 }, uForm: { value: 0 },
  uHandP: { value: new THREE.Vector3(0, 0, 0) }, uZoomP: { value: new THREE.Vector3(1, 0, 0) },
  uLensP: { value: new THREE.Vector4(0, 0, 1, 1) },
};
const mat = new THREE.ShaderMaterial({
  uniforms: uni, vertexShader: VS, fragmentShader: FS,
  transparent: true, depthWrite: false, depthTest: false,
  // 加性混合。这一层画在**透明背景**上,叠加正是要的:亮的地方越叠越亮,
  // 暗处保持透明 —— 这就是"荧幕悬在桌面上"的那种观感。
  blending: THREE.AdditiveBlending,
});
const points = new THREE.Points(geo, mat);
points.frustumCulled = false;
scene.add(points);

/* ── 采样 ─────────────────────────────────────────────────────────────── */
const sc = document.createElement('canvas');
const sctx = sc.getContext('2d', { willReadFrequently: true });
let cdf = null;          // 梯度的前缀和,决定粒子往哪儿落
let lum = null;

/** 把一帧画到采样画布上,按梯度给粒子配额。
 *
 *  `native = true` 表示**别缩**。SAMPLE_MAX 那道限制是给抓屏用的 —— 帧要过 IPC,
 *  所以先缩到 480 再传。可直连这条路上的字是我们自己在本地排的,一个字节都不用过
 *  网络,再缩一次纯粹是把笔画糊掉:900 宽的排版压到 480,13px 的字就只剩 7px,
 *  横竖笔画在采样格子里合并成一团。 */
function sample(img, native) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return false;
  const k = native ? 1 : Math.min(1, SAMPLE_MAX / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  if (sc.width !== w || sc.height !== h) {
    sc.width = w; sc.height = h;
    cdf = new Float32Array(w * h);
    lum = new Float32Array(w * h);
  }
  sctx.drawImage(img, 0, 0, w, h);
  let d;
  try { d = sctx.getImageData(0, 0, w, h).data; } catch (e) { return false; }

  // ① 亮度
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
  }
  // ② 梯度 → 权重 → 前缀和。
  //    权重里保留一点点亮度本身:纯梯度会把大块的纯色面板(比如代码块的底色)
  //    完全抹掉,而那些面板是这个窗口的骨架,人靠它认出"这是哪个 app"。
  let acc = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const l = lum[p];
      const gx = Math.abs(lum[p + (x + 1 < w ? 1 : 0)] - lum[p - (x > 0 ? 1 : 0)]);
      const gy = Math.abs(lum[p + (y + 1 < h ? w : 0)] - lum[p - (y > 0 ? w : 0)]);
      const wgt = (gx + gy) * 3.0 + l * 0.22 + 0.004;
      acc += wgt;
      cdf[p] = acc;
    }
  }
  if (acc <= 0) return false;

  // ③ 按 CDF **等距**取样(不是随机):等距保住结构,随机会成团 —— 和封面那一层
  //    "按扫描顺序等距取"是同一条道理,只不过这里的"顺序"是按权重排的。
  const T = geo.attributes.aTarget.array;
  const C = geo.attributes.aColor.array;
  /* 铺满整块画布,不是居中放一张小图。
     相机的左右边界已经是 ±(窗口宽高比) 了,所以这里**只能**按相机的宽高比铺 ——
     再乘一次图片自己的宽高比,等于把同一个比例算了两遍,画面就缩在中间一小块。
     覆盖层和被抓的窗口是同一个尺寸,所以铺满 = 严丝合缝对上原窗口。 */
  const camA = Math.max(0.01, window.innerWidth / Math.max(1, window.innerHeight));
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const want = (i + 0.5) * acc / N;
    while (cursor < w * h - 1 && cdf[cursor] < want) cursor++;
    const px = cursor % w, py = (cursor / w) | 0;
    const o = i * 3, s = cursor * 4;
    // 抖动一格,免得同一个像素上的几颗粒子叠成一个点
    const jx = (Math.random() - 0.5), jy = (Math.random() - 0.5);
    T[o]     = ((px + 0.5 + jx) / w - 0.5) * 2 * camA;
    T[o + 1] = (0.5 - (py + 0.5 + jy) / h) * 2;
    T[o + 2] = 0;
    C[o] = d[s] / 255; C[o + 1] = d[s + 1] / 255; C[o + 2] = d[s + 2] / 255;
  }
  geo.attributes.aTarget.needsUpdate = true;
  geo.attributes.aColor.needsUpdate = true;
  return true;
}

/* ── 直连:把 agent 自己写的那份 transcript 排出来,再采成粒子 ─────────────
   这是这一层真正的数据源,不是截屏。

   Claude Code / Codex / dsh 每说一句话都会往自己的 JSONL 里追加一行,而 Terse 的
   agent_monitor 早就在盯着那些文件了 —— 也就是说**内容本来就在手上**,一个字节都
   不用再去屏幕上抠。这条路比抓帧好在三处:
     · 不要屏幕录制授权(那道闸是纯 TCC,给不给全看用户,而且 app 一换版本就失效);
     · 是**语义**不是像素 —— 谁说的、是不是工具调用、花了多少 token,全都还在;
     · agent 一写进去这边就动,不用等下一帧,所以是"流"而不是"每秒十二张照片"。 */
/* 角色配色。**亮度拉开**,因为粒子之间是黑的:同一个颜色画成粒子,看上去总比
   实心字暗一档,所以这里每一档都比"正常界面"该有的更亮一点。
   字重全部 600 起 —— 细笔画在粒子里是最先消失的东西。 */
const ROLE = {
  user:      { css: '#9FC4FF', px: 15, weight: 700, prefix: '› ' },
  assistant: { css: '#F2F5F9', px: 14, weight: 600, prefix: '' },
  tool:      { css: '#A8F5D0', px: 13, weight: 700, prefix: '⚙ ' },
  system:    { css: '#939BAC', px: 12, weight: 600, prefix: '' },
};

const tcv = document.createElement('canvas');
const tctx = tcv.getContext('2d', { willReadFrequently: true });

/** 把消息排成一屏字。**从最新的往回排** —— 一个还在跑的 agent,最后几句才是人要看的。 */
function layoutTranscript(msgs, W, H, dpr) {
  // 画布换成物理像素之后,字号也得跟着乘 —— 不然 14px 的字在 1520 宽的画布上
  // 只有原来一半大,行数翻倍、每个字反而更难认。
  const K = Math.max(1, dpr || 1);
  tcv.width = W; tcv.height = H;
  tctx.fillStyle = '#000'; tctx.fillRect(0, 0, W, H);
  tctx.textBaseline = 'top';
  const pad = Math.round(16 * K), maxW = W - pad * 2;
  // 先量出每条要占几行,再从底往上画,画满就停
  const lines = [];
  for (let i = msgs.length - 1; i >= 0 && lines.length < 200; i--) {
    const m = msgs[i] || {};
    const kind = m.type === 'tool' || m.toolName ? 'tool' : (m.role || 'assistant');
    const st = ROLE[kind] || ROLE.assistant;
    tctx.font = `${st.weight} ${Math.round(st.px * K)}px ui-monospace, Menlo, "SF Mono", monospace`;
    const head = st.prefix + (m.toolName ? m.toolName + ' ' : '');
    const body = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (!body && !m.toolName) continue;
    // 折行
    const words = (head + body).split(' ');
    let cur = '';
    const wrapped = [];
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (tctx.measureText(t).width > maxW && cur) { wrapped.push(cur); cur = w; }
      else cur = t;
      if (wrapped.length > 12) break;             // 单条最多 12 行,免得一条长输出吃掉整屏
    }
    if (cur) wrapped.push(cur);
    for (let k = wrapped.length - 1; k >= 0; k--) lines.push({ text: wrapped[k], st });
    lines.push({ text: '', st });                  // 段间距
  }
  // 从底往上画。**先给 composer 留出位置** —— 它是这一页唯一"你能动"的东西,
  // 被 transcript 挤出画面的话,人根本不知道自己可以打字。
  let y = H - pad;
  if (linkTarget.interactive) {
    const cpx = Math.round(15 * K), clh = Math.round(cpx * 1.7);
    y -= clh;
    tctx.font = `700 ${cpx}px ui-monospace, Menlo, "SF Mono", monospace`;
    const prompt = sending ? '⋯ ' : '❯ ';
    tctx.fillStyle = sending ? '#8A93A6' : '#C9F03D';
    tctx.fillText(prompt, pad, y);
    const px0 = pad + tctx.measureText(prompt).width;
    tctx.fillStyle = '#F2F5F9';
    // 只显示尾巴:一句长指令要让人看见**光标附近**在打什么,而不是开头那几个字
    let shown = draft;
    while (tctx.measureText(shown).width > maxW - (px0 - pad) - 14 && shown.length > 1) {
      shown = shown.slice(1);
    }
    tctx.fillText(shown, px0, y);
    if (lastSentTo && !draft) {
      tctx.fillStyle = '#7A8194';
      tctx.fillText(lastSentTo, W - pad - tctx.measureText(lastSentTo).width, y);
    }
    if (caretOn && !sending) {
      tctx.fillStyle = '#C9F03D';
      tctx.fillRect(px0 + tctx.measureText(shown).width + 2 * K, y, Math.round(9 * K), cpx);
    }
    y -= Math.round(8 * K);
  }
  for (const ln of lines) {
    const lh = Math.round(ln.st.px * K * 1.5);
    y -= lh;
    if (y < pad) break;
    if (!ln.text) continue;
    tctx.font = `${ln.st.weight} ${Math.round(ln.st.px * K)}px ui-monospace, Menlo, "SF Mono", monospace`;
    tctx.fillStyle = ln.st.css;
    tctx.fillText(ln.text, pad, y);
  }
  return tcv;
}

let lastSig = '', reLayout = 0;

/* ── 说话这一头 ────────────────────────────────────────────────────────────
   面板底下那一行是**真的能打字的**。字不画成 HTML 浮在粒子上面 —— 那样它就是
   贴在玻璃上的一张纸,和背后那团粒子不是一个世界。它和 transcript 排在同一张
   画布上,一起被采样,所以打出来的每个字也是粒子。

   回车之后走 `pl_send`:激活 agent 那个窗口 → 清空输入 → 粘贴 → 回车。
   发的是**用户自己那个已经登录的会话**,不新起进程、不花额外用量。 */
let linkTarget = { pid: 0, label: '', interactive: false };
let draft = '', sending = false, caretOn = true;

/** ⚠ **主动去问一次**。pm_overlay 在建完窗口的下一行就 emit 了 `pm-target`,
 *  而那时候这一页还没加载完、listener 还不存在 —— 第一次打开时那条事件必然掉。
 *  掉了的后果不是报错,是 `interactive` 一直 false:底下那行 ❯ 根本不画,
 *  面板看起来就是"不能交互的"。 */
(async () => {
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    const t = await invoke('pl_target');
    if (t && (t.interactive || t.pid)) {
      linkTarget = Object.assign({ pid: 0, label: '', interactive: false }, t);
      if (linkTarget.interactive) hidden.focus();
      redraw();
    }
  } catch (e) {}
})();

listen('pm-target', (ev) => {
  linkTarget = Object.assign({ pid: 0, label: '', interactive: false }, ev.payload || {});
  if (linkTarget.interactive) hidden.focus();
  redraw();
});

// 真正接键盘的是一个**看不见的 input**:自己解析 keydown 拼字符串,中文输入法
// 那一关是过不去的(拼音的候选、组合、退格全在输入法里发生)。交给原生 input,
// 我们只读它的 value。
const hidden = document.createElement('input');
hidden.setAttribute('autocomplete', 'off');
hidden.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;border:0;padding:0;background:transparent;color:transparent;outline:none';
document.body.appendChild(hidden);
hidden.addEventListener('input', () => { draft = hidden.value; redraw(); });
hidden.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;   // 输入法组合中的回车是"选词",不是"发送"
  e.preventDefault();
  const text = draft.trim();
  if (!text || sending || !linkTarget.pid) return;
  sending = true; redraw();
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    // 发到哪儿了要**说出来**:Claude Desktop 同时开着好几段对话,这句话进的是它
    // 此刻有焦点的那一段 —— 人得看得见它去了哪个 app。
    const to = invoke ? await invoke('pl_send', { pid: linkTarget.pid, text }) : '';
    draft = ''; hidden.value = '';
    lastSentTo = to ? '→ ' + to : '';
  } catch (err) {
    draft = '⚠ ' + String(err && err.message || err).slice(0, 80);
  }
  sending = false;
  // 窗口本身由 Rust 那边重新激活(pl_send 末尾);这里只把光标放回输入框。
  setTimeout(() => { try { hidden.focus(); } catch (e2) {} }, 60);
  redraw();
});
document.addEventListener('mousedown', () => { if (linkTarget.interactive) hidden.focus(); });
setInterval(() => { caretOn = !caretOn; if (linkTarget.interactive) redraw(); }, 560);

let lastMsgs = [];
let lastSentTo = '';
function redraw() {
  clearTimeout(reLayout);
  reLayout = setTimeout(() => {
    const W = Math.max(420, Math.round(window.innerWidth));
    const H = Math.max(300, Math.round(window.innerHeight));
    const cvs = layoutTranscript(lastMsgs, W, H);
    if (sample(cvs, true)) { haveFrame = true; boot.classList.add('gone'); }
  }, 30);
}

/** 收到 agent 的新消息就重排一次。**节流** —— 一次工具调用会连着写好几行,
 *  每行都重排等于每秒重采十几次,那是白烧 CPU,而屏幕上看不出差别。 */
/** agent-update 只当**"有动静了"的信号**用,不当内容用。
 *
 *  快照里那份 `recentMessages` 把 assistant 截到 120 字 —— 那是喂仪表盘的一行摘要。
 *  这块面板是拿来读的,所以收到信号之后再去拉一次完整的 transcript(pl_transcript,
 *  1200 字 / 80 条)。多一次 IPC,换回来的是**能读的句子**而不是省略号。 */
async function onSession(sess) {
  const at = sess && sess.agentType;
  let msgs = (sess && (sess.recentMessages || sess.messages)) || [];
  if (at) {
    try {
      const invoke = window.__TAURI__?.core?.invoke;
      if (invoke) {
        const full = await invoke('pl_transcript', { agentType: at });
        if (full && full.length) msgs = full;
      }
    } catch (e) {}
  }
  if (!msgs.length) return;
  const last = msgs[msgs.length - 1] || {};
  const sig = msgs.length + '|' + String(last.text || '').slice(-64);
  if (sig === lastSig) return;
  lastSig = sig;
  lastMsgs = msgs;
  clearTimeout(reLayout);
  reLayout = setTimeout(() => {
    /* 按**这块面板真实的像素**排版,然后原分辨率采样。
       字号是照着这个尺寸挑的,所以每一笔都落在真实像素上,不会先被排版缩一次、
       再被采样缩一次 —— 那两次缩放叠起来,正是"能看见但读不清"的来源。 */
    /* ⚠ 按**物理像素**排版,不是 CSS 像素。
       这是"看得见但糊"的真因:面板宽 760 CSS px,在 Retina 上渲染目标是 1520 物理 px。
       照 760 排版再采样,等于把整块字**放大两倍**贴上去 —— 每一笔都软掉,而且带重影。
       之前那次是"缩两次",这次是"放大一次",病根是同一个:排版的尺度必须等于
       最终落像素的尺度。 */
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(420, Math.round(window.innerWidth * dpr));
    const H = Math.max(300, Math.round(window.innerHeight * dpr));
    const cvs = layoutTranscript(msgs, W, H, dpr);
    if (sample(cvs, true)) { haveFrame = true; boot.classList.add('gone'); }
  }, 120);
}

/** 调试入口:直接喂一份会话,和真的 agent-update 走同一条路。 */
window.__pmSession = onSession;
/** 调试入口:直接塞一段草稿,好看看 ❯ 那一行画出来没有。 */
window.__pmDraft = (t) => { draft = String(t || ''); redraw(); };
/** 调试入口:模拟 Rust 发来的 pm-target。 */
window.__pmTarget = (t) => {
  linkTarget = Object.assign({ pid: 0, label: '', interactive: false }, t || {});
  if (linkTarget.interactive) hidden.focus();
  redraw();
};

listen('agent-update', (ev) => onSession(ev.payload && ev.payload.session));
listen('agent-connected', (ev) => onSession(ev.payload && ev.payload.session));

/** 开场先把当前会话拉一次,不然要等 agent 下一次说话才有东西看 —— 一个安静的
 *  agent 可能好几分钟不吭声,那几分钟里这块面板会是空的,看着就像坏了。
 *
 *  ⚠ 这一页**没有加载 tauri-bridge.js**,所以 `window.terse` 在这儿是不存在的。
 *  直接用全局的 invoke(withGlobalTauri: true)。写成 `window.terse?.…` 的话它会
 *  安安静静地什么都不做,而那正是最难发现的一类空白。 */
(async () => {
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    const list = invoke ? await invoke('get_agent_sessions') : [];
    const live = (list || []).find((s) => s && (s.recentMessages || []).length);
    if (live) onSession(live);
  } catch (e) {}
})();

/* ── 帧(截屏那条路,留着但不是主路)────────────────────────────────────── */
let pending = null, decoding = false, haveFrame = false, lastFrame = null;

function pump() {
  if (decoding || !pending) return;
  const b64 = pending; pending = null; decoding = true; lastFrame = b64;
  const img = new Image();
  img.onload = () => {
    if (sample(img)) {
      haveFrame = true;
      boot.classList.add('gone');
    }
    decoding = false;
    pump();                       // 解码期间可能又来了新的一帧,别让它排队变卡顿
  };
  img.onerror = () => { decoding = false; pump(); };
  img.src = 'data:image/jpeg;base64,' + b64;
}

listen('pm-frame', (ev) => {
  const p = ev.payload || {};
  if (!p.jpeg) return;
  // **只留最新的一帧**。抓帧比渲染快的时候,排队等于让画面越拖越旧 ——
  // 一个落后两秒的"实时"画面,比掉帧难受得多。
  pending = p.jpeg;
  pump();
});

/** 调试入口:直接喂一帧 base64 JPEG,和真的抓帧走同一条路。 */
window.__pmFeed = (b64) => { pending = b64; pump(); };

listen('pm-lost', () => { haveFrame = false; boot.classList.remove('gone'); boot.textContent = 'WINDOW GONE'; });

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  const a = w / h;
  camera.left = -a; camera.right = a; camera.top = 1; camera.bottom = -1;
  camera.updateProjectionMatrix();
  uni.uPixel.value = dpr * Math.max(1, Math.min(2.2, h / 420));
}
window.addEventListener('resize', () => { resize(); if (lastFrame) { pending = lastFrame; pump(); } });
resize();

/* 时间按倍率累计(手势:握拳拧 = 变速,张掌停住 = 定格)。没有手势时 rate = 1,和原来一样 */
const gs = { rate: 1, frozen: false, vt: 0, last: performance.now() };
(function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  /* 只有**开着手势控制**时才降到 30fps —— 摄像头 + 识别 + 手势都在吃算力,这一层几乎全屏,
     每一帧都让 WindowServer 重新合成整片区域。手势关着:照旧 60fps,和原来一模一样。
     (内容本身按抓帧更新,"呼吸"只有 0.0018 的幅度,30fps 看不出差别。) */
  if (gs.gestureOn && now - (gs.lastDraw || 0) < 1000 / 31) return;
  const fdt = Math.min(0.1, (now - (gs.lastDraw || now)) / 1000);
  gs.lastDraw = now;
  if (!gs.frozen) gs.vt += (now - gs.last) / 1000 * gs.rate;
  gs.last = now;
  uni.uTime.value = gs.vt;
  // 出场:第一帧到了之后粒子从散开聚拢。开场那一下是这个功能的"通电"瞬间。
  const want = haveFrame ? 1 : 0;
  // 按时间算(等价于原来 60fps 下每帧 0.08),帧率变了聚拢的快慢不变
  uni.uForm.value += (want - uni.uForm.value) * (1 - Math.pow(1 - 0.08, fdt * 60));
  renderer.render(scene, camera);
})();

/* ── 手势(Pro)──────────────────────────────────────────────────────────
   这一层是鼠标穿透的(点下去的还是原来那个窗口),所以只接"看"的手势:
   张开手掌 → 粒子被推开;握拳拧 → 变速;张掌停住 → 定格;两只手捏住拉开 → 放大。
   没打开手势控制 / 摄像头里没有手 → 一个事件都不来。 */
function toCam(sx, sy) {
  const w = window.innerWidth, h = window.innerHeight, a = w / h;
  const lx = sx - (window.screenX || 0), ly = sy - (window.screenY || 0);
  return [(lx / w * 2 - 1) * a, 1 - ly / h * 2];
}
// 手势控制开没开(决定帧率上限):启动时问一次,开关一拨就广播 hand-enabled
// (这个文件顶层没有 invoke —— 它只在几个函数里各自取;这里直接取 Tauri 的)
try { window.__TAURI__?.core?.invoke?.('hands_get_enabled')?.then((on) => { gs.gestureOn = !!on; }).catch(() => {}); } catch (e) {}
listen('hand-enabled', (e) => { gs.gestureOn = !!(e && e.payload); });
// 光标层算好的那一份(全屏同一个光标)
listenGestures(listen, (e) => {
  switch (e.type) {
    case 'hand': {
      const [x, y] = toCam(e.x, e.y); uni.uHandP.value.set(x, y, e.pose === 'open' ? 1 : 0); gs.hand = true;
      // 放大镜开着、手挪开了 → 收起
      const L = uni.uLensP.value; if (L.w > 1 && Math.hypot(L.x - x, L.y - y) > 0.18) L.set(0, 0, 1, 1);
      break;
    }
    case 'lost': uni.uHandP.value.set(0, 0, 0); uni.uZoomP.value.set(1, 0, 0); uni.uLensP.value.set(0, 0, 1, 1); gs.hand = false; break;
    // 指着 agent 日志的某一处停 0.6 秒 → 那一块放大 2.2 倍(看清一行字)
    case 'dwell': { const [x, y] = toCam(e.x, e.y); uni.uLensP.value.set(x, y, 0.3, 2.2); break; }
    case 'freeze': gs.frozen = e.frozen; break;
    case 'speed': gs.rate = e.rate; break;
    case 'zoom': { const [cx, cy] = toCam(e.cx, e.cy); uni.uZoomP.value.set(Math.max(0.5, Math.min(2.5, e.scale)), cx, cy); break; }
    case 'zoomend': uni.uZoomP.value.set(1, 0, 0); break;
  }
});
