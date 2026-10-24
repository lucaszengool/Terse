/**
 * girlfriend-avatar.js —— 壁纸里的「AI 女友」(数字人形象版)。
 *
 * 用户 10-17 原话:"我不需要粒子女友,我需要和那个 github repo 一模一样的女友形象;
 * 一样的数字人形象;可以外表不同,但是一样的 style 和质感的"。
 *
 * 所以这一版不是粒子剪影,而是**数字人**:默认一张手搓的 chibi 风 SVG 半身像
 * (呼吸、眨眼、嘴型都是分图层做的,能被 TTS 嘴型驱动)—— 开机就能看到一个人,
 * 不等任何素材下载。想换成自己的,点侧栏的「换成我的角色」挑一段 idle 视频 +
 * 一段 speaking 视频,壁纸就播它们;架构和 dsh-voice-ai-girlfriend 那边一致。
 *
 * 另外两件事(dsh 那个 repo 没做,是 Terse 的加法):
 *   ① agent 粒子字出现时,**她的手会伸到那块位置、顺着手的轨迹把字"画"出来**。
 *      这需要身体和手是可以分开摆的 —— 视频做不到,所以 SVG 默认版有一只独立的
 *      右手 <g>,JS 直接改它的 transform;视频版则覆一层 SVG 手在上面当"投影"。
 *   ② 当 agent 活动时("在想"、"在打字"、"输出完了"),整个人换成相应的姿势 ——
 *      SVG 版靠换 pose 关键帧,视频版靠换素材片段。
 *
 * ⚠ 这是 2D canvas 的事(不是 WebGL):壁纸窗口已经有引擎、壁纸粒子板、音乐歌词、
 *   粒子光标四个 WebGL 上下文,再加一个 Chromium 会撞上限,而撞上掉的是整张壁纸。
 */

const CHARACTER_SVG_W = 300;   // 内部 viewBox 宽
const CHARACTER_SVG_H = 420;   // 内部 viewBox 高

/** 默认占位 —— **故意不画卡通人物**。
 *  用户 10-17 原话:"我需要一个真人 AI 美女数字人,不是卡通"。
 *  那个 GitHub repo 的 README 也写明"形象素材不随仓库分发(属个人素材)" —— 没有
 *  能直接送的默认角色。我们能做的最诚实的事:给一个中性剪影 + 一句"换成你自己的照片/
 *  视频"的大字,把"真人数字人"的来源明明白白交给用户 —— 他们可以塞一张自己的照片、
 *  AI 生成图、DUIX 导出的视频,任何一种,全局就立刻变成那个人。
 *  还是分图层做:身子一层、头一层、嘴一层(amplitude 驱动开合)、右手一层(可以伸),
 *  这样"手去画 agent 字"这条动作在占位版上也看得出来。 */
function defaultPlaceholderSVG(tint) {
  const t = tint || '#9db7ff';
  const bodyA = t;
  const bodyB = shadeHex(t, -0.42);
  const faint = 'rgba(255,255,255,0.18)';
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHARACTER_SVG_W} ${CHARACTER_SVG_H}" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="glow" cx="50%" cy="38%" r="62%">
      <stop offset="0%"  stop-color="${t}" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="${t}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${t}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bodyG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="${bodyA}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${bodyB}" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <!-- 柔光环 -->
  <circle cx="150" cy="170" r="190" fill="url(#glow)"/>
  <!-- 身子:一个很干净的半身剪影,没有五官,不是任何具体的人 -->
  <g id="gf-body">
    <path d="M50,415
             C56,330 95,275 150,275
             C205,275 244,330 250,415
             L250,420 L50,420 Z" fill="url(#bodyG)"/>
  </g>
  <!-- 右手:仍然做出来,给"伸手画字"用;可以藏起来再出 -->
  <g id="gf-arm-right" style="transform-origin:92px 290px; transform-box:fill-box">
    <path d="M88,278 Q68,320 65,380 L85,382 Q92,320 95,280 Z" fill="url(#bodyG)" opacity="0.85"/>
    <g id="gf-hand-right" style="transform-origin:75px 388px; transform-box:fill-box">
      <circle cx="75" cy="388" r="10" fill="${bodyA}" opacity="0.9"/>
    </g>
  </g>
  <!-- 左手(屏幕右边),静止 -->
  <g id="gf-arm-left" style="transform-origin:208px 290px; transform-box:fill-box">
    <path d="M212,278 Q232,320 235,380 L215,382 Q208,320 205,280 Z" fill="url(#bodyG)" opacity="0.85"/>
  </g>
  <!-- 头:椭圆剪影,占位,不画五官 -->
  <g id="gf-head" style="transform-origin:150px 160px; transform-box:fill-box">
    <ellipse id="gf-face" cx="150" cy="160" rx="64" ry="78" fill="url(#bodyG)"/>
    <!-- 眼睛(两条小横线,仅示意) -->
    <g id="gf-eye-l" style="transform-origin:128px 162px; transform-box:fill-box">
      <rect x="118" y="160" width="20" height="3.6" rx="1.8" fill="${faint}"/>
    </g>
    <g id="gf-eye-r" style="transform-origin:172px 162px; transform-box:fill-box">
      <rect x="162" y="160" width="20" height="3.6" rx="1.8" fill="${faint}"/>
    </g>
    <!-- 嘴(id gf-mouth 用 scaleY 开合) -->
    <g id="gf-mouth" style="transform-origin:150px 196px; transform-box:fill-box">
      <rect x="134" y="194" width="32" height="3.4" rx="1.7" fill="${faint}"/>
    </g>
  </g>
  <!-- 上来一句"添加你自己的照片 / 视频" -->
  <g font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif" fill="rgba(255,255,255,0.78)" text-anchor="middle">
    <text x="150" y="256" font-size="13" font-weight="700" letter-spacing="0.08em">ADD YOUR CHARACTER</text>
    <text x="150" y="276" font-size="10" opacity="0.72">photo · video · AI-generated — any</text>
  </g>
</svg>`;
}

/** 用户塞了一张照片时的 overlay:只画嘴型 + 右手(供 agent-text 伸手用)。
 *  嘴的位置是**相对照片**的归一化坐标(0..1),用户在侧栏可调(默认 0.5, 0.72:下半脸)。 */
function photoOverlaySVG(tint, mx, my) {
  const t = tint || '#ffffff';
  const mX = CHARACTER_SVG_W * mx;
  const mY = CHARACTER_SVG_H * my;
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHARACTER_SVG_W} ${CHARACTER_SVG_H}" preserveAspectRatio="xMidYMid meet">
  <!-- 嘴型:一条短横,TTS 时 scaleY 跟 amplitude 动。阴影 + 柔光让它贴在照片上没那么假 -->
  <g id="gf-mouth" style="transform-origin:${mX}px ${mY}px; transform-box:fill-box">
    <ellipse cx="${mX}" cy="${mY}" rx="22" ry="2.6" fill="rgba(0,0,0,0.55)"/>
    <ellipse cx="${mX}" cy="${mY}" rx="18" ry="1.8" fill="${t}" opacity="0.42"/>
  </g>
  <!-- 右手(屏幕左边,SVG 坐标系中 x 小的那边):伸出来画 agent 字用 -->
  <g id="gf-arm-right" style="transform-origin:60px 410px; transform-box:fill-box">
    <g id="gf-hand-right" style="transform-origin:55px 410px; transform-box:fill-box">
      <circle cx="55" cy="410" r="7" fill="${t}" opacity="0.0"/>
    </g>
  </g>
</svg>`;
}

function hexA(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#b58df0');
  if (!m) return `rgba(181,141,240,${a})`;
  const [r, g, b] = [m[1], m[2], m[3]].map(c => parseInt(c, 16));
  return `rgba(${r},${g},${b},${a})`;
}

function shadeHex(hex, k) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#b58df0');
  if (!m) return hex || '#b58df0';
  const to = (c) => Math.max(0, Math.min(255, Math.round(parseInt(c, 16) * (1 + k)))).toString(16).padStart(2, '0');
  return '#' + to(m[1]) + to(m[2]) + to(m[3]);
}

/* ────────────────────────────────────────────────────────────────────────── */

const L_has = (self) => !!(self._live && self._live.q && self._live.q.length);   // anything queued for her to say

/* 10-22: which of her gestures bring out which line (clip-name stems; Mia: point_c1 points up-left, point_c2 presents with both
   palms, point_c3 taps, point_c4 flicks, write_c1 writes in the air; the patch gestures — point_sprinkle scatters from an
   opening hand, point_sweep wipes an open palm left, point_flick2 flicks her fingertips open twice, point_release opens cupped
   hands up-left, point_count counts on her fingers, point_piano ripples her fingers like piano keys) */
const GESTURES_FOR = {
  log: ['point_c1', 'point_c2'],
  stat: ['point_c3', 'point_c4'], saved: ['point_c3', 'point_c4'], spent: ['point_c4', 'point_c3'], cache: ['point_c3', 'point_c4'],
  agents: ['point_c2', 'write_c1'], peer: ['write_c1', 'point_c2'],
  // one motion that paints a whole patch of small numbers (user 10-22: "能每次画出一片小粒子的手势")
  batch: ['point_sprinkle', 'point_sweep', 'point_flick2', 'point_release', 'point_count', 'point_piano', 'point_c4'],
};

export default class GirlfriendAvatar {
  constructor(host, opts = {}) {
    this.host = host || document.body;
    this.opts = Object.assign({
      zIndex: 3, x: 0.78, y: 0.72, scale: 1.0, tint: '#b58df0',
      idleSrc: null, speakingSrc: null,     // 用户塞进来的视频;给了就播视频
    }, opts);
    // 外层容器:绝对定位,不吃点击,放在壁纸其它层之间
    this.root = document.createElement('div');
    const r = this.root.style;
    r.position = 'fixed'; r.pointerEvents = 'none';
    r.zIndex = String(this.opts.zIndex);
    r.transformOrigin = 'center';
    r.willChange = 'transform';
    r.width = CHARACTER_SVG_W + 'px';
    r.height = CHARACTER_SVG_H + 'px';
    // 出场 / 退场都淡入淡出(切实时模式、换角色时整层重建 —— 不能"啪"一下换人)
    r.opacity = '0'; r.transition = 'opacity .7s ease';
    this.host.appendChild(this.root);
    /* 粒子手 / 轨迹 overlay —— 整个屏幕一张 canvas,画在角色之上。
       视频 / 照片角色没办法真的动她本人的手,所以我们在她身上 **叠一道柔光的粒子臂** ——
       从她胸口射出,划到 agent 字即将出现的位置,顺着把字"写"出来。效果和 Terse 其它
       粒子一个语言,放在任何角色视频上都读得出"是她在伸手"。 */
    this.trail = document.createElement('canvas');
    const tc = this.trail.style;
    tc.position = 'fixed'; tc.inset = '0';
    tc.width = '100vw'; tc.height = '100vh';
    tc.pointerEvents = 'none';
    tc.zIndex = String((this.opts.zIndex | 0) + 1);
    tc.mixBlendMode = 'screen';
    this.host.appendChild(this.trail);
    this.tctx = this.trail.getContext('2d');
    this._trailDots = [];     // 活着的拖尾粒子;_tick 里更新
    this._buildCharacter();
    this.resize();
    this._pose = 'idle';
    this._mouth = 0;
    this._armReach = null;    // { x, y, until } 屏幕像素
    this._writePath = null;   // { pts, start, duration }
    this._gesture = null;     // 当前姿势(wave / think / nod / point / write);靠粒子手 overlay 演
    this._raf = 0; this._running = false; this._t0 = performance.now();
    this._eyeBlinkT = 0;
    // 10-21 (user: "完成所有预热后才显示AI女友在壁纸上"): hold = built and loading, but not shown and not directing anything
    // until release() — the wallpaper releases her once her engine reports every part warm
    this._held = !!this.opts.hold; this._startWanted = false;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  dispose() {
    this.disableLive();
    window.removeEventListener('resize', this._onResize);
    // 淡出再拆:新的那一层同时在淡入,两者交叉,不会闪一下空屏
    const root = this.root, trail = this.trail, bleed = this._bleed, grain = this._grain, gt = this._grainTimer;
    root.style.opacity = '0';
    if (bleed) bleed.style.opacity = '0';
    if (grain) grain.style.opacity = '0';
    setTimeout(() => {
      if (bleed) { try { bleed.remove(); } catch (e) {} }
      if (grain) { clearInterval(gt); try { grain.remove(); } catch (e) {} }
      this.stop();
      for (const v of root.querySelectorAll('video')) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
      try { this.host.removeChild(root); } catch (e) {}
      try { this.host.removeChild(trail); } catch (e) {}
    }, 750);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this._W = w; this._H = h;
    const scale = this.opts.scale || 1;
    let cx = w * this.opts.x, cy = h * this.opts.y;
    const r = this.root.style;
    /* 视频 / 照片按脸摆位(见下);占位 SVG 底边中点锚到 (x, y),小一点 —— 它只是"在这里放你的角色"的提示。 */
    const media = !!(this._clipVideos || this._vidIdle || this._photoImg);
    let bw, bh, left, top;
    if (media) {
      /* 用户 10-17:"底下都截掉,让数字人更大、脸占屏幕更多,更有女友沉浸感"。
         以**脸**为锚点摆位:片子放大到屏幕高的 1.55 倍(× 大小滑杆),脸的中心落在
         (fx, fy);屏幕下沿自然把她截在胸口 —— 和参考视频里一样。脸大约占屏幕高的 30%。 */
      const zoom = +this.opts.zoom || 1;
      bh = h * 1.55 * zoom;
      bw = bh * (this._aspect || 0.75);
      const face = this.opts.faceUV || [0.679, 0.22];     // clip_1 第一帧里脸的中心(片子归一化坐标)
      const fx = this.opts.fx != null ? +this.opts.fx : 0.72;
      const fy = this.opts.fy != null ? +this.opts.fy : 0.34;
      left = w * fx - face[0] * bw;
      top  = h * fy - face[1] * bh;
      if (this.opts.fullFrame && this.opts.fit === 'cover') {
        /* 横版直播构图(manifest fit:"cover",用户 10-18:"类似直播的视角对着你说话,上半身占据整个半边屏幕"):
           片子铺满整块屏幕、右侧对齐 —— 她在右半屏,左边是她房间里的暗墙(粒子字落在那里)。
           zoom > 1 再放大一点(仍然右对齐、上下以脸为准夹在屏幕里)。 */
        const aspect = this._aspect || 16 / 9;
        bw = Math.max(w, h * aspect) * Math.max(1, zoom); bh = bw / aspect;
        /* keepU(manifest):片子左边这一条必须留在屏幕里 —— 她向左指 / 摊手时指尖伸到片子左缘 2–3%,
           16:10 的屏幕按右对齐会把左边切掉 10%,指尖就出屏了;那就少切左边、多切右边(她右侧的头发 / 肩)。 */
        const keepU = Math.max(0, +this.opts.keepU || 0);
        left = Math.min(0, Math.max(w - bw, -keepU * bw));
        top = Math.min(0, Math.max(h - bh, h * (fy) - face[1] * bh));
      } else if (this.opts.fullFrame) {
        /* 整幅原片当壁纸(教程「小雅」:网页背景就是数字人,人物不抠):片子的右边、上边、下边必须盖满屏幕 ——
           她被屏幕边截断,而不是露出画框。左边露出来的那块由 _bleed 接上片子自己的背景。
           多留一点点:动作片段有各自的对齐变换(manifest align),会挪动 / 缩放 1% 左右。 */
        left = Math.max(left, w * 1.006 - bw);
        top = Math.min(top, -h * 0.012);
        if (top + bh < h * 1.01) top = h * 1.01 - bh;
      }
    } else {
      bh = h * 0.62 * scale; bw = bh * (CHARACTER_SVG_W / CHARACTER_SVG_H);
      left = cx - bw / 2; top = cy - bh;
    }
    this._boxW = bw; this._boxH = bh;
    r.left = left + 'px';
    r.top  = top + 'px';
    r.width  = bw + 'px';
    r.height = bh + 'px';
    cx = left + bw / 2; cy = top + bh;
    // trail canvas:全屏 DPR 像素
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.trail.width = Math.round(w * dpr); this.trail.height = Math.round(h * dpr);
    this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 胸口的屏幕位置(没有逐段标注时,粒子手从这里"伸"出来):框里 (0.45, 0.42)
    this._shoulder = { x: (cx - bw / 2) + bw * 0.45, y: (cy - bh) + bh * 0.42 };
    this._applyFeather();     // 底边淡出跟着"屏幕下沿落在片子哪里"走,框一变就要重算
    this._drawBleed();
  }

  /** 整幅原片模式:片子左边以外的屏幕,用**片子自己的背景**接上(取 idle 第一帧最左一列的颜色,逐行横向延伸,
      越往屏幕左边越暗 —— 教程构图里左边那一大片近乎纯黑的暗部)。只采样一次 idle:背景是固定机位不动的,
      而动作片段里她的手会伸到画面左缘,采到手就会拖出一道肤色。 */
  _drawBleed() {
    const cv = this._bleed;
    if (!cv || !this._clipVideos) return;
    if (!this._bleedCol) {
      const v = this._clipVideos[this._idlePool()[0] || 0];
      if (!v || v.readyState < 2 || !v.videoWidth) {
        if (v && !this._bleedWait) { this._bleedWait = true; v.addEventListener('loadeddata', () => { this._bleedWait = false; this._drawBleed(); }, { once: true }); }
        return;
      }
      const SH = 96, s = document.createElement('canvas'); s.width = 8; s.height = SH;
      const sc = s.getContext('2d', { willReadFrequently: true });
      sc.drawImage(v, 0, 0, Math.max(1, v.videoWidth * 0.02), v.videoHeight, 0, 0, 8, SH);   // 最左 2% 那一条
      const d = sc.getImageData(0, 0, 8, SH).data, col = [];
      for (let y = 0; y < SH; y++) {                     // 每行 8 个像素取平均,再上下各 3 行平滑(压编码噪点)
        const c = [0, 0, 0];
        for (let yy = Math.max(0, y - 3); yy <= Math.min(SH - 1, y + 3); yy++)
          for (let x = 0; x < 8; x++) { const o = (yy * 8 + x) * 4; c[0] += d[o]; c[1] += d[o + 1]; c[2] += d[o + 2]; }
        const n = 8 * (Math.min(SH - 1, y + 3) - Math.max(0, y - 3) + 1);
        col.push([c[0] / n, c[1] / n, c[2] / n]);
      }
      this._bleedCol = col;
    }
    const W = this._W || innerWidth, H = this._H || innerHeight, k = 8;
    const ow = Math.max(8, Math.ceil(W / k)), oh = Math.max(8, Math.ceil(H / k));
    if (cv.width !== ow || cv.height !== oh) { cv.width = ow; cv.height = oh; }
    const ctx = cv.getContext('2d'), img = ctx.createImageData(ow, oh), px = img.data, col = this._bleedCol;
    const L = parseFloat(this.root.style.left) || 0, T = parseFloat(this.root.style.top) || 0, BH = this._boxH || H;
    for (let y = 0; y < oh; y++) {
      const v = Math.max(0, Math.min(1, ((y + 0.5) * k - T) / BH));
      const c = col[Math.min(col.length - 1, Math.round(v * (col.length - 1)))];
      for (let x = 0; x < ow; x++) {
        const dist = Math.max(0, L - (x + 0.5) * k) / W;           // 离片子左缘多远(屏宽的比例)
        const t = Math.min(1, dist / 0.45), f = 1 - 0.62 * t * t * (3 - 2 * t);
        const o = (y * ow + x) * 4;
        px[o] = c[0] * f; px[o + 1] = c[1] * f; px[o + 2] = c[2] * f; px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** 片子里的归一化坐标 (u, v) → 屏幕像素。u/v 可以超出 0..1(她指向框外的地方)。 */
  _clipToScreen(u, v) {
    const r = this.root.getBoundingClientRect();
    return [r.left + u * r.width, r.top + v * r.height];
  }

  /** 每段动作片段的标注:什么时候手到位(impact 秒)、指尖在哪(tip)、字该出现在哪(aim)。
      manifest.json 里有就用它的,没有就用按动作类型的默认值。坐标是片子里的归一化 (u, v)。 */
  _gestureMeta(k) {
    const meta = (this._clipMetaArr && this._clipMetaArr[k]) || (this.opts.clipMeta && this.opts.clipMeta[k]) || {};
    const tag = (this._clipTags && this._clipTags[k]) || 'idle';
    const def = {
      point: { impact: 1.2, tip: [0.10, 0.34], aim: [-0.55, 0.32] },
      write: { impact: 1.6, tip: [0.40, 0.38], aim: [-0.50, 0.38] },
    }[tag] || { impact: 1.0, tip: [0.45, 0.40], aim: [-0.5, 0.35] };
    return { impact: meta.impact != null ? +meta.impact : def.impact,
             tip: Array.isArray(meta.tip) ? meta.tip : def.tip,
             aim: Array.isArray(meta.aim) ? meta.aim : def.aim,
             // textAt:这段动作的字中心(片子归一化坐标)—— 她指 / 托着的那块空处
             textAt: Array.isArray(meta.textAt) ? meta.textAt : null };
  }

  /** 引擎的"导演"回调:一句大字(agent 日志)准备出现之前调这里。
      她先做动作(写 / 指),返回 { delayMs, screen } —— 引擎压住这句字,
      到 delayMs 那一刻才在 screen 这个点(她手指的地方)让字聚出来。 */
  /* ── 无缝模式(manifest "seamless": true)──────────────────────────────
     这个角色的每一段(几段短 idle + 每个动作)都是从**同一帧**起、回到**同一帧**止
     (Wan 2.2 首尾帧生成)。那么换段只在段与段的交界处做,而且是**直接切**:
     交界两边是同一帧,切了也看不出来 —— 没有交叉淡化,就没有"两个人叠在一起"的重影。
     动作请求进来时,等当前 idle 段播到头(最多一段的长度,所以 idle 段做得短),
     到头那一帧切进动作片段;动作片段播完回到同一帧,再切进下一段 idle。 */
  _seamless() { return !!(this.opts.seamless && this._clipVideos && this._clipVideos.length > 1); }

  /** 无缝模式:当前段还要多久播到头(毫秒)。 */
  _msToBoundary() {
    const v = this._curClip();
    if (!v || !(v.duration > 0)) return 0;
    return Math.max(0, (v.duration - v.currentTime) * 1000 / (v.playbackRate || 1));
  }

  /** 无缝模式:立刻(在同一帧上)切到第 k 段,从头播。新段先解出第一帧再换上来,不闪。 */
  _cutTo(k) {
    const vids = this._clipVideos; if (!vids) return;
    const cur = vids[this._clipIndex], next = vids[k];
    if (!next || next === cur) { try { cur.currentTime = 0; cur.play(); } catch (e) {} return; }
    for (const v of vids) v.style.transition = 'none';
    this._fadeGen = (this._fadeGen || 0) + 1;
    try { next.currentTime = 0; } catch (e) {}
    const swap = () => {
      next.style.opacity = '1'; next.style.zIndex = '2';
      cur.style.opacity = '0'; cur.style.zIndex = '1';
      try { cur.pause(); } catch (e) {}
      this._clipIndex = k;
    };
    const p = next.play();
    if (next.requestVideoFrameCallback) next.requestVideoFrameCallback(swap);
    else if (p && p.then) p.then(swap).catch(swap); else swap();
  }

  /** 用户 10-19:"动作不要有,只有比如 30-40 秒一次动作导出 agent 粒子 text"。两次带字的手势之间至少隔 30–40 秒
      (每次随机);冷却期间来的大字直接丢 —— 下一句来的时候正好是"此刻在发生什么"。 */
  _textSlotOpen(now) {
    if (this._nextTextAt == null) this._nextTextAt = 0;
    if (now < this._nextTextAt) return false;
    this._textSpaced(now);
    return true;
  }

  /** 10-22 (user: "更多不同的手势控制所有的别的粒子 text 的出现"): the statistics come out of her hands too — a sweep paints a
      patch of them; never within 6 s after an agent line's gesture, and not when an agent line is about due (it keeps its
      40–60 s rhythm) */
  _calloutSlotOpen(now) {
    // more often than the agent lines (user 10-22: "周围小粒子的女友的手势要更频繁"): a patch every ~12–18 s while she is idle
    const base = this.opts.textEveryMs > 0 ? this.opts.textEveryMs / 4 : 12000;
    if (now < (this._nextCalloutAt || 0)) return false;
    if (now - (this._lastBigGestureAt || -1e9) < 6000) return false;
    const due = this._nextTextAt || 0;
    if (due > now && due - now < 6000) return false;
    this._nextCalloutAt = now + base + Math.random() * base / 2;
    return true;
  }

  /** 用户 10-21:"手势导出不要太频繁,40–60 秒一次" —— counted from when she actually brings a line out (a gesture that waited
      through a reply plays late; the next one still keeps its distance) */
  _textSpaced(now) {
    const base = this.opts.textEveryMs > 0 ? this.opts.textEveryMs : 40000;
    this._nextTextAt = Math.max(this._nextTextAt || 0, now + base + Math.random() * base / 2);
  }

  directGlyph(info) {
    if (this._held) return { drop: true };                   // not on screen yet: no gesture, no line
    // one agent line waits for her at a time (10-21: lines queued while she was busy played back to back afterwards, 9 s apart)
    if ((this._blowQ || []).some(b => b.kind === 'gesture' && !b.life && !b.released)) return { drop: true };
    const big = !info || !info.size || info.size === 'big';            // an agent line, or a statistic (10-22)
    if (big ? !this._textSlotOpen(performance.now()) : !(this._live && this._live.alive && this._calloutSlotOpen(performance.now())))
      return { drop: true };
    /* 用户 10-18:"把所有手势动作先去掉,只保留静止的有口型的 … 用嘴型吹起,每次吹气吐出来 agent 粒子 text"。
       实时模式(有引擎):每条大字排进吹气队列 —— 等她说完话、你没在说话、离上一口气够久,
       引擎生成一口"呼"(圆唇 + 气声,走同一条口型管线,和说话一样顺),嘴最圆的那一帧放行:
       字的粒子从她嘴里流出来,飘到左边暗处写成一行(壁纸引擎 in-mode 12,from = 嘴)。 */
    if (this._live && this._live.alive) {
      /* 用户 10-18 又改回来:"还是得用动作去划出或者点出 agent text"。动作走动作图路径(manifest livePath,
         TANGO 式:每一跳都是真正对得上的两帧 → 硬切,没有交叉淡化的重影)。没有可无缝进出的动作 → 吹气。 */
      // 字由"指 / 摊手 / 划 / 看过去"出来:point_* / write_* + manifest 里标了 textGesture 的片段(比如她往左边瞟的待机变体)
      const paths = this._livePaths(['point', 'write'])
        .concat(this._livePaths(null).filter(p => ((this._clipMetaArr || [])[p.k] || {}).textGesture &&
                                                  !['point', 'write'].includes((this._clipTags || [])[p.k])));
      if (paths.length) {
        /* 随机挑,但按"多久没用过"挑(用户 10-18:"展示 agent log 的手势太单一了";10-21 查到的做法:少量素材靠组合和不规律
           的轮换降低重复感,而不是纯随机 —— 纯随机常常连着两三次同一段):最久没用的那一半里随机,刚用过的两段不选 */
        /* which gestures fit which line (10-22, user: "更多不同的手势"): an agent line — her big point / present; the token
           numbers — the small tap / flick; agents and peers — present / write. A character without those clips uses whatever
           text gestures it has */
        const stem = (p) => String((this._clipNames || [])[p.k] || '').replace(/\.[^.]+$/, '');
        const prefer = big ? GESTURES_FOR.log : GESTURES_FOR[info.kind] || GESTURES_FOR.stat;
        const fit = paths.filter(p => prefer.some(st => stem(p).startsWith(st)));
        const cand = fit.length ? fit : paths;
        const use = this._textUse || (this._textUse = new Map());
        const byAge = cand.slice().sort((a, b) => (use.get(a.k) || 0) - (use.get(b.k) || 0));
        const pool = byAge.slice(0, Math.max(1, Math.ceil(byAge.length / 2)));
        const pick = pool[(Math.random() * pool.length) | 0], m = this._gestureMeta(pick.k);
        use.set(pick.k, performance.now()); this._lastTextK = pick.k;
        const W = this._W || innerWidth, H = this._H || innerHeight;
        const tip = this._clipToScreen(m.tip[0], m.tip[1]);          // her fingertip / palm at the impact frame (tips.py)
        /* 字待的带(用户 10-21:"手势导出的位置和 agent 粒子 text 要 match"):屏幕左缘到她脸左边(DUIX 的脸框)之前。字的粒子从
           指尖流出来,在她手边这块空处成形 —— 长句在带里缩小,不再整句往右推到她脸上 */
        const band = [W * 0.015, Math.max(W * 0.30, Math.min(W * 0.52, this._faceLeftScreen() - W * 0.03))];
        let aim;
        if (m.textAt) {
          // 片子里标好的那块空处(她手指 / 掌心旁边)
          const t = this._clipToScreen(m.textAt[0], m.textAt[1]);
          aim = [Math.max(band[0], Math.min(t[0], band[1])), Math.max(H * 0.08, Math.min(t[1], H * 0.60))];
        } else {
          aim = [Math.max(band[0], Math.min(tip[0] + W * 0.04, band[1])), Math.max(H * 0.10, tip[1] - H * 0.10)];
        }
        const b = { kind: 'gesture', path: pick, impact: m.impact, released: false, requested: false, t0: performance.now(), small: !big,
                    wait: big ? 45000 : 20000 };
        (this._blowQ || (this._blowQ = [])).push(b);
        if (big) this._lastBigGestureAt = performance.now();
        /* 数字人 mode: tell the engine this gesture is waiting — if she starts a reply before performing it, the reply's video
           opens on it, lip-synced, and the line leaves her fingertip mid-sentence (_dhsOpen / _dhsStart). Only agent lines: a
           statistic is a quiet gesture between her replies */
        if (this._live.dh && this._live.engine && big) {
          b.hid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const stem = String((this._clipNames || [])[pick.k] || '').replace(/\.[^.]+$/, '');
          fetch(this._live.engine + '/gesture', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: stem, id: b.hid }) }).catch(() => {});
        }
        this._pumpBlows();
        return { ready: () => b.released, dropped: () => !!b.dropped, screen: aim, from: tip, region: band, maxWaitMs: b.wait, dropOnTimeout: true,
                 timing: big ? { in: 1100, hold: 2600, out: 1000 } : { in: 800, hold: 1900, out: 800 } };
      }
      /* 10-21(用户:"big middle 的 agent text log 在 AI 女友开启的时候只能被女友手势导出控制出现,其他时候不要出现"):
         没有能导出字的手势(素材还没装好)就不出这句 —— 不吹气、不自己冒出来 */
      return { drop: true };
    }
    const tags = this._clipTags || [];
    const have = (t) => tags.some((x, k) => x === t);
    // 写 / 指 轮流来(只有一种就一直用那种),同一句话不会每次一模一样
    let tag = null;
    if (have('write') && have('point')) tag = (this._lastDirect === 'write') ? 'point' : 'write';
    else if (have('write')) tag = 'write';
    else if (have('point')) tag = 'point';
    this._lastDirect = tag;

    // 进动作片段用短淡化(两段取景差一点时,长淡化会露出"两个她"叠在一起)
    const fade = Math.min(this._fadeMs(), 320);
    let k = -1;
    if (tag) {
      const idx = []; tags.forEach((t, i) => { if (t === tag) idx.push(i); });
      k = idx[(Math.random() * idx.length) | 0];
      this._lastReact = performance.now();
      const m = this._gestureMeta(k);
      let delayMs;
      const busy = this._liveBusyMs();
      if (busy > 0) {
        /* 她正在说话(实时模式):动作排到这句话说完之后 —— 还是"先指,字再出现在她指的地方" */
        setTimeout(() => {
          if (this._fading) { this._pendingGestureIdx = k; this._pendingGestureFade = fade; }
          else this._crossfadeTo(k, true, fade);
        }, busy);
        delayMs = busy + (this._fadeMs() / 2) + fade * 0.5 + m.impact * 1000;
      } else if (this._seamless()) {
        // 等当前段到头,在交界那一帧直接切进动作片段
        const wait = this._msToBoundary();
        this._queuedCut = k;
        delayMs = wait + m.impact * 1000;
      } else {
        const wasFading = this._fading;
        this._pendingReact = false;                      // 别让之前排队的"换一段"把这个动作打断
        if (wasFading) { this._pendingGestureIdx = k; this._pendingGestureFade = fade; }   // 淡完立刻接上
        else this._crossfadeTo(k, true, fade);
        // 正在淡的那一下还剩多久(不是整段淡化时长 —— 那样字会早于手到位)
        const left = wasFading ? Math.max(0, (this._fadeEndsAt || 0) - performance.now()) + 30 : 0;
        delayMs = left + fade * 0.5 + m.impact * 1000;
      }
      /* 字落在指尖的左上方(屏幕坐标)。她现在很大,手臂伸出去也只到屏幕左边四分之一处,
         字要是放在手指"前方"就会压在她胳膊上;放在指尖上方偏左,读起来就是"她指着这句话"。 */
      const tip0 = this._clipToScreen(m.tip[0], m.tip[1]);
      const aim = [Math.max(this._W * 0.16, tip0[0] - this._W * 0.10), Math.max(this._H * 0.12, tip0[1] - this._H * 0.13)];
      /* 不自己画粒子:字就是壁纸引擎那句大字本身 —— 引擎在手到位的那一刻,让这句字的粒子从
         指尖(from)流出来、从左往右写到 aim(用户 10-17:"直接用壁纸功能的粒子 text,
         开启 AI 女友的时候 big middle agent log 只能被 AI 女友控制生成")。
         指尖在 delayMs 那一刻的屏幕位置:按那时的框算(片子有对齐变换,_clipToScreen 读的是 root 的框)。 */
      return { delayMs, screen: aim, from: tip0 };
    }
    // 这个角色还没有写 / 指的片段:这句不出(她开着时大字只由她的手势带出来,用户 10-21)
    return { drop: true };
  }

  /* ── 实时模式(教程「小雅」同款):引擎(gf-live/engine.py)推来一句句话,这里按帧贴上模型生成的嘴 ──
   * 说话只在 idle 往返循环上进行(引擎为它预计算好了每一帧的编码特征);动作片段播放时,下一句等它
   * 回到 idle 再开口。音频用 WebAudio,在补丁第 0 帧真正上屏的那一刻起声;之后每一帧按"idle 视频
   * 现在播到第几帧"取补丁 —— 视频是主时钟,嘴不会和脸错位。 */
  enableLive(engine, idleIdx) {
    this.disableLive();
    const L = this._live = { engine, idle: idleIdx, q: [], cur: null, genFps: 18, kU: 0, lastK: -1, loops: 0, n: 0, fps: 25, alive: true,
                             spk: idleIdx, lo: 0, curN: 0, bases: {}, ranges: new Map() };
    // idle 里"几乎静止、不在眨眼"的那几帧(manifest idle_live.turns,原片帧号):安静时在这里随机掉头
    const im = (this._clipMetaArr || [])[idleIdx];
    L.turns = im && Array.isArray(im.turns) && im.turns.length ? new Set(im.turns) : null;
    /* 10-21(用户:"idle 的时候尽量无明显表情(笑、嘴动、头晃),更真实,DUIX 在头部固定时效果更好"):idle 只在最平静的一段里来回
       (manifest calm = [起, 止],原片前半段的帧号:闭嘴、眼睛自然、头几乎不动),折返点每次随机一点,看不出循环;
       种子帧(每段说话底片的第 0 帧)就在这段里 —— 开口也更快。闲时的小动作 / 表情片段都不放。 */
    L.calm = im && Array.isArray(im.calm) && im.calm.length === 2 ? im.calm : null; L.calmB = null;
    /* 10-21(用户:"嘴形很扭曲、想的时候画面一卡一卡重复同一帧";查到的做法:LiveTalking / MuseTalk / DUIX-Mobile 都是一段正脸、头稳的
       底片,待机和说话是同一段,只重画嘴附近,不切片、不等帧):calmTalk = 她就在平静的 idle 上说话 —— 嘴按声音时钟走、贴在当前帧
       (跟着脸框),底片照常来回,永远不停、不切换;DUIX 在正脸稳头上也最好。情绪底片模式留着(opts.expressiveTalk)。 */
    L.calmTalk = !!L.calm && !this.opts.expressiveTalk;
    /* 入场过桥(manifest idle_live.enterBridge,TANGO 那样的过渡帧):过桥片段里第 i 段 = idle 原片第 anchors[i] 帧
       → 光流插出来的 7 帧 → 种子帧(每段动作的第 0 帧)。动作不用再等 idle 走回第 0 帧(最多 8s),
       下一个锚点最多 ~0.8s 就到。 */
    const eb = im && im.enterBridge, ebk = eb ? (this._clipNames || []).indexOf(eb.clip) : -1;
    L.eb = ebk >= 0 ? { k: ebk, L: eb.L || 8, seg: eb.seg || 12, anchors: eb.anchors || [] } : null;
    try { L.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    const v = this._clipVideos && this._clipVideos[idleIdx];
    if (!v) return;
    // 回调里出任何错都不能让这条帧循环断掉(断了她就永远不开口)
    v._gfRearm = () => {
      const gen = v._gfGen = (v._gfGen || 0) + 1;
      const tick = (now, meta) => {
        if (!L.alive || v._gfGen !== gen) return;
        try { this._liveFrame(meta, idleIdx); } catch (e) { if (!L.err) { L.err = true; console.error('[gf-live] frame', e); } }
        L.vfc = v.requestVideoFrameCallback(tick);
      };
      L.vfc = v.requestVideoFrameCallback(tick);
    };
    v._gfRearm();
    const connect = () => {
      if (!L.alive) return;
      let ws; try { ws = new WebSocket(engine.replace(/^http/, 'ws') + '/events'); } catch (e) { setTimeout(connect, 2000); return; }
      L.ev = ws;
      /* back after a drop = the engine restarted (crash, update, Terse relaunching it): it has forgotten her avatar and would
         answer in silence — the owner registers it again (onReconnect: the wallpaper re-POSTs /avatar) */
      ws.onopen = () => { if (L.wasOpen && L.onReconnect) { try { L.onReconnect(); } catch (err) {} } L.wasOpen = true; };
      ws.onmessage = (e) => { try { this._liveEvent(JSON.parse(e.data)); } catch (err) {} };
      ws.onclose = () => { if (L.alive) setTimeout(connect, 1500); };
    };
    /* no engine yet (10-22, user: "点击启用后,AI女友就应该在壁纸里控制 agent 粒子…只是不能对话没有声音"): she is shown on her calm
       idle and her gestures bring out the lines — the frame clock above is all that needs; voice + mouth come with the engine,
       when the wallpaper enables live mode again with its address */
    if (engine) connect();
  }

  disableLive() {
    const L = this._live; if (!L) return;
    L.alive = false;
    try { L.ev && L.ev.close(); } catch (e) {}
    this._liveStopCur();
    try { L.ac && L.ac.close(); } catch (e) {}
    this._live = null;
  }

  /** 引擎的 avatar 信息(帧数 / 帧率)—— wallpaper 在 POST /avatar 之后告诉这里。 */
  setLiveAvatar(info, order) {
    const L = this._live; if (!L || !info) return;
    L.fps = info.fps; L.boxes = info.boxes || null; L.vw = info.w; L.vh = info.h;
    L.dh = !!info.dh;                                  // replies are the engine's 数字人 video stream (no mouth patches)
    if (info.hd_fps > 0) L.hdFps = info.hd_fps;     // 引擎最近的出嘴速度:第一句就按真实速度排开口帧(否则按 5 张/秒猜,排得太晚)
    /* 10-21(用户:"DUIX 有时模糊、扭曲"):每段底片 DUIX 重画的区域(下半脸,64² 平均权重)。HD 补丁只透过它贴 —— 眼睛以上永远是
       正在播的原片(清楚、不会因为补丁比画面晚一两帧而错位),只有嘴和下巴来自 DUIX。 */
    L.hdMasks = new Map();
    const ms = info.hd_mask_size || 64;
    (info.hd_mask || []).forEach((b64, i) => {
      const ci = (order || [L.idle])[i]; if (ci == null || !b64) return;
      const raw = atob(b64), cv = document.createElement('canvas'); cv.width = cv.height = ms;
      const g = cv.getContext('2d'), img = g.createImageData(ms, ms);
      for (let q = 0; q < ms * ms; q++) { const a = raw.charCodeAt(q); img.data[q * 4] = img.data[q * 4 + 1] = img.data[q * 4 + 2] = 255; img.data[q * 4 + 3] = a; }
      g.putImageData(img, 0, 0); L.hdMasks.set(ci, cv);
    });
    L.hdSubs = new Map();                              // per clip: the patch rectangle (lips) in face-box coordinates
    (info.hd_sub || []).forEach((r, i) => { const ci = (order || [L.idle])[i]; if (ci != null && r && r.length === 4) L.hdSubs.set(ci, r); });
    /* 10-21(用户:"还是 distortion 和重影"):per clip, per frame her face's own motion from frame 0 (dx, dy, sub-pixel). The
       landmark face boxes jitter ±3 px on a still clip, so mouths placed by the box slid against her real lips; patch boxes now
       come in frame 0's coordinates and are drawn at + track[frame on screen]. */
    L.hdTracks = new Map();
    (info.hd_track || []).forEach((t, i) => { const ci = (order || [L.idle])[i]; if (ci != null && t && t.length) L.hdTracks.set(ci, Float32Array.from(t)); });
    this._setupBlink(L);
    /* 引擎把 idle + 几段表情底片(talk_*:撒娇 / 傲娇 / 害羞…)放在同一个帧空间里:ranges[i] = [起始帧, 帧数],
       顺序和 order(这边的片段下标)一致。她说哪句话,就在那句情绪的底片上生成嘴。 */
    const ranges = info.ranges || [[0, info.n]], ord = order || [L.idle];
    L.ranges = new Map(); L.bases = {};
    ord.forEach((ci, i) => { if (ranges[i]) L.ranges.set(ci, ranges[i]); });
    L.n = (L.ranges.get(L.idle) || [0, info.n])[1]; L.curN = L.n; L.lo = 0; L.spk = L.idle;
    ord.slice(1).forEach(ci => {
      const m = (this._clipMetaArr || [])[ci], v = this._clipVideos && this._clipVideos[ci];
      if (!m || !m.emo || !v || !L.ranges.has(ci)) return;
      L.bases[m.emo] = ci;
      if (!v._gfTick) {                                   // 底片自己的帧时钟:只有它在屏幕上时才驱动嘴
        v._gfTick = true;
        v._gfRearm = () => {                              // 解码出错重载后重新挂(旧的回调随解码器一起没了)
          const gen = v._gfGen = (v._gfGen || 0) + 1;
          const f = (now, meta) => { if (!L.alive || v._gfGen !== gen) return; try { this._liveFrame(meta, ci); } catch (e) {} v.requestVideoFrameCallback(f); };
          v.requestVideoFrameCallback(f);
        };
        v._gfRearm();
      }
    });
  }

  /** 这个角色在实时模式下能无缝进出 idle_live 的动作(manifest 里带 livePath 的那几段)。 */
  _livePaths(kinds) {
    if (!this._clipVideos || !this._live) return [];
    const out = [];
    (this._clipMetaArr || []).forEach((m, k) => {
      const p = m && m.livePath; if (!p || k === this._live.idle) return;
      if (kinds && !kinds.includes((this._clipTags || [])[k])) return;
      const bk = p.bridge ? (this._clipNames || []).indexOf(p.bridge.clip) : -1;
      if (p.bridge && bk < 0) return;
      out.push({ k, p, bk });
    });
    return out;
  }

  /** 自发的小动作(用户 10-17:"让手势能自发生成不同的随机的动作"):安静 14–28s 之后,随机挑一段
      能无缝进出的"闲时动作"(挥手 / 托腮 / 想一想…),走同一套动作图路径;不连续重复同一段。
      她在说话、你在说话、有字在排队、有动作在进行时都不动。 */
  _idleLife(now) {
    const L = this._live; if (!L || !L.alive) return;
    if (L.calm) return;                                 // calm idle: no idle gestures / mood clips (no smiles, no head turns)
    if (this._nextLifeAt == null) { this._nextLifeAt = now + 6000 + Math.random() * 6000; return; }
    if (now < this._nextLifeAt) return;
    if (L.cur || L.q.length || this._pathArm || this._pathActive || this._holdTag === 'listen') return;
    if ((this._blowQ || []).some(b => !b.released)) return;
    // 正在聊天(10s 内说过话):不插闲时动作 —— 她的下一句回答不能被一段 5 秒的动作挡住
    if (now - (this._lastSpeechEnd || 0) < 10000) { this._nextLifeAt = now + 3000; return; }
    /* 待机时也要多变(用户 10-18:"自然状态下无特定表情的时候变化也要多一点"):闲时小动作 + 中性待机变体(life_*)
       + 温和的情绪底片(害羞 / 开心 / 调皮,manifest life:true)不出声地演一遍。 */
    /* 用户 10-19:"idle 的时候一直重复挥手太假了,保持无动作的姿势,可以有随机不同的小变化,但动作不要有"。
       待机只放中性的待机变体(life_*);挥手 / 想 / 点头这些动作只在带出 agent 大字时出现(directGlyph,30–40 秒一次)。 */
    const pool = this._livePaths(['life']);
    if (!pool.length) { this._nextLifeAt = now + 60000; return; }
    const recent = this._lifeRecent || (this._lifeRecent = []);
    const fresh = pool.filter(p => !recent.includes(p.k));
    const from = fresh.length ? fresh : pool;
    const pick = from[(Math.random() * from.length) | 0];
    recent.push(pick.k); while (recent.length > Math.min(3, pool.length - 1)) recent.shift();
    const b = { kind: 'gesture', life: true, path: pick, impact: 1e9, released: false, requested: false, t0: now };
    (this._blowQ || (this._blowQ = [])).push(b);
    this._nextLifeAt = now + 1e9;                     // re-armed when this one is home (_pathHome)
    this._pumpBlows();
  }

  /** 备好路径:动作片段和过桥片段先定位到起始帧(解码好、暂停着),等 idle 播到入口窗口里的那一帧再切。 */
  _armPath(b) {
    const { k, p, bk } = b.path, vids = this._clipVideos, fps = this._live.fps || 24;
    try { vids[k].pause(); vids[k].currentTime = (p.g0 || 0) / fps; } catch (e) {}
    if (bk >= 0) { try { vids[bk].pause(); vids[bk].currentTime = p.bridge.from / fps; } catch (e) {} }
    // 从种子帧起的动作(g0 = 0)都能走入场过桥
    const eb = (this._live.eb && !(p.g0 > 0)) ? this._live.eb : null;
    this._pathArm = { b, k, p, bk, eb, target: null, enter: new Set(p.enter || [0]), t0: performance.now() };
  }

  /** 当前方向上、至少 4 帧之后的下一个过桥锚点(给过桥片段留出 seek 的时间)。往返循环:前半段原片帧号在涨,后半段在降。 */
  _anchorAhead(a, k) {
    const L = this._live, fwd = k <= (L.n - 1) / 2, f = fwd ? k : L.n - 1 - k;
    let best = null;
    a.eb.anchors.forEach((x, i) => {
      const d = fwd ? x - f : f - x;
      if (d >= 4 && (!best || d < best.d)) best = { f: x, i, d };
    });
    return best;
  }

  _startEnterBridge(a) {
    a.stage = 'enter';
    const vids = this._clipVideos, L = this._live, br = vids[a.eb.k], fps = L.fps || 24;
    const s0 = a.target.i * a.eb.seg, last = s0 + a.eb.L - 1;      // 段里最后一帧插值帧;之后几帧都是种子帧
    this._pathActive = a; a.stage = 'enter'; a.watch = br;
    this._swapTo(a.eb.k, 0, () => { try { vids[L.idle].pause(); } catch (e) {} });
    const tick = (now, meta) => {
      if (this._pathActive !== a) return;
      if (meta.mediaTime * fps >= last - 0.5 || br.ended) { this._startPath(a); return; }
      br.requestVideoFrameCallback(tick);
    };
    br.requestVideoFrameCallback(tick);
  }

  _startPath(a) {
    if (a.b && a.b.kind === 'talk') {
      // 临时入场走到了种子帧,情绪还没来:停在这一帧等它(或第一句话)—— 不先切进一段错的底片
      if (a.provisional && !a.moodSet && !L_has(this) && performance.now() - a.t0 < 2500) {
        this._pathActive = a; a.stage = 'wait';
        try { this._clipVideos[this._clipIndex].pause(); } catch (e) {}
        if (!a.waitIv) a.waitIv = setInterval(() => {
          const L = this._live, u0 = L && L.q[0];
          if (u0 && u0.hdBase != null && !a.moodSet && u0.hdBase !== a.k) { const v = this._clipVideos[u0.hdBase]; try { v.pause(); v.currentTime = 0; } catch (e) {} a.k = u0.hdBase; a.b.path.k = a.k; }
          if (a.moodSet || u0 || performance.now() - a.t0 >= 2500 || this._pathActive !== a) {
            clearInterval(a.waitIv); a.waitIv = null;
            if (this._pathActive === a) this._startTalk(a);
          }
        }, 25);
        return;
      }
      this._startTalk(a); return;
    }
    const vids = this._clipVideos, L = this._live, idle = vids[L.idle], g = vids[a.k], fps = L.fps || 24;
    this._pathActive = a; a.stage = 'path'; a.watch = g;
    const prev = vids[this._clipIndex];                  // idle,或者入场过桥
    this._swapTo(a.k, 0, () => { try { prev.pause(); } catch (e) {} if (prev !== idle) { try { idle.pause(); } catch (e) {} } });
    const tick = (now, meta) => {
      if (this._pathActive !== a) return;
      if (!a.b.released && meta.mediaTime >= (a.b.impact || 1)) {                        // 指尖到位 → 字从这里出来
        a.b.released = true; if (!a.b.life && !a.b.small) this._textSpaced(performance.now());   // a statistic keeps its own rhythm
      }
      if (meta.mediaTime * fps >= a.p.out - 0.5 || g.ended) { this._pathBridge(a); return; }
      g.requestVideoFrameCallback(tick);
    };
    g.requestVideoFrameCallback(tick);
  }

  _pathBridge(a) {
    const vids = this._clipVideos, L = this._live, idle = vids[L.idle], g = vids[a.k], fps = L.fps || 24;
    try { idle.currentTime = (a.p.back || 0) / fps; } catch (e) {}       // idle 先等在回来的那一帧上
    if (a.bk < 0) { this._pathHome(a); return; }
    const br = vids[a.bk];
    a.stage = 'bridge'; a.watch = br;
    this._swapTo(a.bk, (a.p.bridge.blend || 0) * 1000 / fps, () => { try { g.pause(); } catch (e) {} });
    const tick = (now, meta) => {
      if (this._pathActive !== a) return;
      if (meta.mediaTime * fps >= a.p.bridge.to - 1.5 || br.ended) { this._pathHome(a); return; }
      br.requestVideoFrameCallback(tick);
    };
    br.requestVideoFrameCallback(tick);
  }

  /** 硬件解码偶尔出错(10-21 实测:GPU 正忙时 Chrome 的 HEVC 硬解在 talk_kaixin 第 114 帧报 MEDIA_ERR_DECODE,文件本身没问题)——
      片子停在那一帧、帧回调不再来,她定格,排队的话永远等不到开口帧。重新加载这一段,回到出错的那一帧接着放,帧循环重新挂上。 */
  _clipError(v) {
    if (!v.error || v._gfRecovering) return;
    v._gfRecovering = true;
    const t = v.currentTime || 0, wasOn = !v.paused || v.style.opacity === '1';
    console.warn('[gf] video decode error, reloading', (v.currentSrc || '').split('/').pop(), 'at', t.toFixed(2));
    const done = () => {
      if (!v._gfRecovering) return;
      v.removeEventListener('loadeddata', done); v._gfRecovering = false;
      try { v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || t + 1) - 0.05)); } catch (e) {}
      if (wasOn) v.play().catch(() => {});
      if (v._gfRearm) v._gfRearm();
      const a = this._pathActive;                       // 正在过桥 / 做动作的那段:直接走下一步(它的帧回调也没了)
      if (a && a.watch === v) {
        if (a.stage === 'enter') this._startPath(a); else if (a.stage === 'path') this._pathBridge(a); else if (a.stage === 'bridge') this._pathHome(a);
      }
    };
    v.addEventListener('loadeddata', done);
    setTimeout(() => { if (v._gfRecovering) done(); }, 3000);
    try { v.load(); } catch (e) { v._gfRecovering = false; }
  }

  /** 动作路径的兜底(10-19 实测:页面在后台时 requestVideoFrameCallback 不触发,动作片段一路播到结尾没被接走,
      回到前台也再没有帧回调 → 她定格在动作最后一帧,排队的回答永远等不到)。片段已经播完就直接走下一步。 */
  _pathRecover() {
    const a = this._pathActive;
    if (!a || !a.watch || !a.watch.ended) return;
    if (a.stage === 'enter') this._startPath(a);
    else if (a.stage === 'path') this._pathBridge(a);
    else if (a.stage === 'bridge') this._pathHome(a);
  }

  _pathHome(a) {
    const vids = this._clipVideos, L = this._live, cur = vids[this._clipIndex];
    this._swapTo(L.idle, 0, () => { if (cur !== vids[L.idle]) { try { cur.pause(); } catch (e) {} } });
    this._pathActive = null; this._lastBlowAt = performance.now();
    if (!a.b.released) a.b.released = true;
    this._nextLifeAt = performance.now() + 8000 + Math.random() * 10000;    // 下一次自发小动作(8–18s)
  }

  /** 换到情绪底片上说话(撒娇 / 傲娇 / 害羞…):底片第 0 帧 = 种子帧 = 过桥的最后一帧 → 硬切。之后嘴按底片自己的帧生成;
      底片首尾同帧,话长就自然循环。说完了等底片走到最后一帧(又是种子帧)再硬切回 idle 第 0 帧。 */
  _startTalk(a) {
    const vids = this._clipVideos, L = this._live, idle = vids[L.idle], base = vids[a.k];
    this._pathActive = a;
    const prev = vids[this._clipIndex];
    const r = L.ranges.get(a.k) || [0, 1];
    base.loop = true; base.playbackRate = 1;
    this._swapTo(a.k, 0, () => { try { prev.pause(); } catch (e) {} if (prev !== idle) { try { idle.pause(); } catch (e) {} } });
    L.spk = a.k; L.lo = r[0]; L.curN = r[1]; L.loops = 0; L.lastK = -1; L.kU = 0; L.talkSince = performance.now(); L.planEnd = null;
  }

  _endTalk() {
    const vids = this._clipVideos, L = this._live, idle = vids[L.idle], base = vids[L.spk];
    try { idle.currentTime = 0.5 / (L.fps || 24); } catch (e) {}
    L.spk = L.idle; L.lo = 0; L.curN = L.n; L.loops = 0; L.lastK = -1; L.kU = 0; L.planEnd = null;
    if (this._holdIv) { clearInterval(this._holdIv); this._holdIv = null; }
    this._swapTo(L.idle, 0, () => { try { base.pause(); base.playbackRate = 1; base.currentTime = 0; } catch (e) {} });
    this._pathActive = null; this._lastBlowAt = performance.now();
    this._nextLifeAt = performance.now() + 8000 + Math.random() * 10000;
  }

  /** 帧级切换:新的那段先 play,真出了第一帧才换上来;blendMs = 0 是硬切(两边是同一帧),>0 是几帧的微淡化。 */
  _swapTo(k, blendMs, after) {
    const vids = this._clipVideos, cur = vids[this._clipIndex], next = vids[k];
    if (!next || next === cur) { if (after) after(); return; }
    let done = false;
    const go = () => {
      if (done) return; done = true;
      const ms = Math.max(0, blendMs | 0);
      for (const v of [cur, next]) v.style.transition = ms ? `opacity ${ms}ms linear` : 'none';
      next.style.zIndex = '2'; cur.style.zIndex = '1';
      next.style.opacity = '1'; cur.style.opacity = '0';
      this._clipIndex = k;
      setTimeout(() => { if (after) after(); }, ms + 20);
    };
    const pr = next.play();
    if (next.requestVideoFrameCallback) next.requestVideoFrameCallback(go);
    else if (pr && pr.then) pr.then(go).catch(go); else go();
    setTimeout(go, 400);                                   // 解码卡住也照样换过去
  }

  /** 她脸的左边在屏幕上的 x(引擎给的 idle 脸框,片子像素);没有脸框就按 manifest 的脸位置估 */
  _faceLeftScreen() {
    const L = this._live, v = this._clipVideos && this._clipVideos[L ? L.idle : 0];
    const W = this._W || innerWidth;
    if (!L || !L.boxes || !L.boxes.length || !v) return W * 0.55;
    const r = v.getBoundingClientRect(), vw = L.vw || v.videoWidth || 1;
    return r.left + L.boxes[0][0] / vw * r.width;
  }

  /** 她嘴的屏幕位置:引擎给的这一帧脸框(片子像素)里,wav2lip 画嘴的那一点(框宽中点、框高 0.70)。 */
  _mouthScreen() {
    const L = this._live, v = this._clipVideos && this._clipVideos[L ? L.spk : 0];
    const W = this._W || innerWidth, H = this._H || innerHeight;
    if (!L || !L.boxes || !v) return [W * 0.70, H * 0.42];
    const b = L.boxes[(L.lo + Math.max(0, L.lastK)) % L.boxes.length];
    const r = v.getBoundingClientRect(), vw = L.vw || v.videoWidth || 1, vh = L.vh || v.videoHeight || 1;
    return [r.left + ((b[0] + b[2]) / 2) / vw * r.width, r.top + (b[1] + (b[3] - b[1]) * 0.70) / vh * r.height];
  }

  /** 吹气的节奏:一次只吹一口;不在她说话 / 你说话的时候吹;说完话先缓一口气(0.45s);两口气之间至少 2.8s。 */
  _pumpBlows() {
    const L = this._live, Q = this._blowQ;
    if (!L || !L.alive || !Q || !Q.length) return;
    const now = performance.now();
    while (Q.length && (Q[0].released || Q[0].dropped)) Q.shift();
    const b = Q[0]; if (!b || b.requested) return;
    if (this._pathActive || this._pathArm) return;
    if (this._dhBusy()) return;                          // a 数字人 reply is coming / playing: it would cover the gesture
    if (b.kind === 'gesture' && b.hid && L.thinkUntil > now) return;     // held for the reply she is composing
    const speaking = (L.cur && !L.cur.blow) || L.q.some(u => !u.blow);
    if (speaking || L.cur || L.q.length || this._holdTag === 'listen') return;
    if (now - (this._lastSpeechEnd || 0) < 450 || now - (this._lastBlowAt || 0) < 2800) return;
    /* the wallpaper waits only b.wait for her hand: a gesture that waited behind others (a reply, an agent line's gesture) and
       would reach its impact after that would bring nothing out — skip it (≤ 4.5 s to reach an entry frame of the idle) and say
       so, the wallpaper drops the line(s) now instead of at its deadline */
    if (b.kind === 'gesture' && b.wait && now + 4500 + (b.impact || 0) * 1000 > b.t0 + b.wait) {
      b.dropped = true; Q.shift();
      if (b.hid) fetch(L.engine + '/gesture', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: b.hid }) }).catch(() => {});
      return;
    }
    b.requested = true;
    if (b.kind === 'gesture') {
      if (b.hid) fetch(L.engine + '/gesture', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: b.hid }) }).catch(() => {});                // performed silently: no reply opens on it
      this._armPath(b); return;
    }
    fetch(L.engine + '/blow', { method: 'POST' }).then(r => r.json()).then(m => {
      if (m && m.id) b.id = m.id; else b.released = true;
    }).catch(() => { b.released = true; });
  }

  /** 还要说多久(毫秒):正在说的这句剩下的 + 排队的。directGlyph 用它把动作排到说完之后。 */
  _liveBusyMs() {
    const L = this._live; if (!L) return 0;
    let ms = 0;
    if (L.cur) ms += Math.max(0, L.cur.endsAt ? L.cur.endsAt - performance.now() : L.cur.duration * 1000 + 600);
    for (const u of L.q) ms += u.duration * 1000 + 300;
    return ms;
  }

  async _liveEvent(ev) {
    const L = this._live; if (!L) return;
    if (ev.type === 'dh') { this._dhEnqueue(ev); return; }
    if (ev.type === 'dh_stream') { this._dhsOpen(ev); return; }
    if (ev.type === 'dh_go') { this._dhsGo(ev); return; }
    if (ev.type === 'stop') {
      L.thinkUntil = 0;                                  // no reply coming: held gestures may go
      this._dhStop();
      for (const u of L.q) if (u.hdWs) { try { u.hdWs.onmessage = u.hdWs.onerror = u.hdWs.onclose = null; u.hdWs.close(); } catch (e) {} }
      L.q = []; this._liveStopCur();
      for (const b of this._blowQ || []) if (!b.released) { b.requested = false; b.id = null; }   // 被打断的那口气稍后重吹
      return;
    }
    if (ev.type === 'renderer') {                     // engine switched who draws her mouth (auto: full DUIX ↔ small DUIX)
      if (ev.boxes) L.boxes = ev.boxes; if (ev.hd_fps) L.hdFps = ev.hd_fps; L.firstMouthS = 0;
      if (L.onRenderer) L.onRenderer(ev);
      return;
    }
    if (L.calmTalk && (ev.type === 'thinking' || ev.type === 'mood')) {
      if (ev.emo) L.lastEmo = ev.emo;
      // she is composing a reply: an agent line's gesture waiting now is held for it — the reply's video opens on it (/gesture)
      // until her reply's stream opens (_dhsOpen clears it) — the brain's first sentence took 20 s once under load (10-21)
      if (ev.type === 'thinking' && L.dh) L.thinkUntil = performance.now() + 90000;
      return;
    }
    if (ev.type === 'stop' || ev.type === 'error') L.thinkUntil = 0;
    if (ev.type === 'thinking') {
      /* 10-21(用户:"everything 丝滑 0 卡顿"):一发出去她就开始走向说话的姿势 —— 入场过桥对所有情绪底片都一样(都落在种子帧),
         只有最后切进哪段底片要等 brain 写出情绪。走到种子帧时情绪还没来,就停在种子帧上等(最多 2.5 s)。 */
      if (!L.cur && !L.q.length && L.spk === L.idle && !this._pathActive) {
        this._dropArm();
        const bk = this._hdBase(L.lastEmo);
        if (!this._pathArm && bk != null) {
          this._armPath({ kind: 'talk', path: { k: bk, p: { enter: [L.n - 3, L.n - 2, L.n - 1, 0, 1, 2], g0: 0, back: 0 }, bk: -1 },
                          released: true, requested: true, t0: performance.now() });
          if (this._pathArm) { this._pathArm.provisional = true; this._pathArm.t0 = performance.now(); }
        }
      }
      L.expectUntil = performance.now() + 15000;
      return;
    }
    if (ev.type === 'mood') {
      /* brain 刚写出这句的情绪(第一个 token 后 ~0.3 s):现在就切到这段情绪底片,声音和嘴好了就直接开口,不用再等切换 */
      const bk = this._hdBase(ev.emo);
      if (bk == null) return;
      L.lastEmo = ev.emo;
      L.expectUntil = performance.now() + 15000;
      const pa = this._pathArm || this._pathActive;                 // 已经在走的临时入场:改成这段情绪底片
      if (pa && pa.provisional && !pa.moodSet && pa.b && pa.b.kind === 'talk' && L.spk === L.idle) {
        pa.moodSet = true;
        if (pa.k !== bk) { const v = this._clipVideos[bk]; try { v.pause(); v.currentTime = 0; } catch (e) {} pa.k = bk; pa.b.path.k = bk; }
        return;
      }
      if (!L.cur && !L.q.length && L.spk === L.idle && !this._pathActive) {
        this._dropArm();
        if (!this._pathArm) this._armPath({ kind: 'talk', path: { k: bk, p: { enter: [L.n - 3, L.n - 2, L.n - 1, 0, 1, 2], g0: 0, back: 0 }, bk: -1 },
                                            released: true, requested: true, t0: performance.now() });
      }
      return;
    }
    if (ev.type !== 'utt') return;
    const u = { ...ev, ready: false };
    /* 用户 10-20:"一定要确保每次说话都有 match 的口型和面部表情,voice 可以稍微等一点,等 DUIX 好"。
       所以 HD(DUIX)走"先备好嘴、再开口":_collectHd 按这一句实测的出图速度算,剩下的嘴保证在播到之前到齐
       才开口(嘴从不在句中卡住);表情 = 这句情绪对应的底片。下一句的嘴在这一句播放时就开始渲染。
       (边生成边说的 u.duix 那条路留着,但不再用 —— 天热时 DUIX 会跟不上,嘴就停住了。) */
    if (u.hd) {
      // 即时反应在她正在的那段情绪底片上播(引擎每段底片都预先渲染了嘴);不在任何有嘴的底片上才去 开心 那段
      const curLo = (L.ranges.get(L.spk) || [])[0];
      /* 她已经在一段情绪底片上(上一轮还没回 idle):这轮就接着在这段底片上说 —— 换底片要等它转回种子帧(最多一圈 ~8 s),
         10-20 实测第二轮因此等了 20 s。回到 idle 以后的新一轮才按新情绪换底片。 */
      const onTalk = L.spk !== L.idle && Object.values(L.bases || {}).includes(L.spk);
      u.hdBase = L.calmTalk ? L.idle : onTalk ? L.spk : (u.filler && L.spk !== L.idle && (u.filler_los || []).includes(curLo)) ? L.spk : this._hdBase(u.emo);
      if (u.hdBase == null) u.hd = false;
    }
    L.q.push(u);
    /* HD 回复(用户 10-19:"她等一下、再用 DUIX 的脸说话"):这句话的每一帧嘴(DUIX,在 Radeon 上渲染)都到齐了才算 ready,
       她这段时间照常待机;到齐后进这句情绪的底片、从第 hd_k0 帧开口 —— 嘴和底片逐帧对齐。 */
    /* DUIX 出错或卡住(> 8 s 没新嘴)时这句不丢:改走普通实时口型(wav2lip,在她当前的底片上),照样有对得上的嘴 */
    /* 10-20(用户:"大幅度优化 DUIX","要稳定 5 s 以内"):嘴按她**真正会在的那几帧**渲染 —— 她已经在这句的情绪底片上,
       就从「当前帧 + 刚好够嘴跟上的提前量」开口;不在,就先切过去,到了再按当时的帧排。以前每句都只能从底片一圈里固定的
       第 3 帧开口:第一句要等转到那一帧,句子之间也要等底片转一整圈(几秒)。 */
    if (u.hd && L.calmTalk) {
      u.calm = true; u.hdBase = L.idle;
      const k = Math.max(0, L.lastK), f = k <= (L.n - 1) / 2 ? k : L.n - 1 - k;     // where the idle is now (forward-half frame)
      u.k0Rel = Math.max(L.calm[0], Math.min(L.calm[1], f));
      u.hdPromise = new Promise((res, rej) => { u._hdRes = res; u._hdRej = rej; });
      this._collectHd(u).then(u._hdRes, u._hdRej);
    } else if (u.hd) { u.hdPromise = new Promise((res, rej) => { u._hdRes = res; u._hdRej = rej; }); this._planHd(u); }
    const hdDone = u.hd ? u.hdPromise.catch((e) => {
      console.warn('[gf] DUIX failed for this line, using the normal lip-sync:', e && e.message);
      try { u.hdWs && u.hdWs.close(); } catch (x) {}
      for (const p of (u.patches || new Map()).values()) try { p.bmp.close(); } catch (x) {}
      u.hd = false; u.patches = null; u.gotHd = 0;
    }) : Promise.resolve();
    try {
      const buf = await (await fetch(`${L.engine}/audio/${ev.id}.wav`)).arrayBuffer();
      u.audio = await L.ac.decodeAudioData(buf);
      await hdDone;
      u.ready = true;
    } catch (e) { L.q = L.q.filter(x => x !== u); }
  }

  /** 备好但还没开始的手势 / 待机小动作让路给说话:小动作丢掉、8–18 s 后再来;带 agent 字的手势放回队列,说完再演。 */
  _dropArm() {
    const a = this._pathArm; if (!a || a.b.kind === 'talk') return;
    const b = a.b; this._pathArm = null;
    if (b.life) {
      const Q = this._blowQ || [], i = Q.indexOf(b); if (i >= 0) Q.splice(i, 1);
      this._nextLifeAt = performance.now() + 8000 + Math.random() * 10000;
    } else if (!b.released) { b.requested = false; b.id = null; }
  }

  /** 给一句 HD 回复排开口帧:她正在这句的底片上 → 当前帧 + 提前量(按实测出嘴速度算,刚好够 90% 速度下嘴不落后),
      且不早于上一句的结尾;不在 → 记下,等她切过去(帧循环里再排)。 */
  _planHd(u) {
    const L = this._live;
    if (!(this._clipIndex === L.spk && !this._fading && L.spk === u.hdBase && L.spk !== L.idle)) { u.hdDeferred = true; return; }
    u.hdDeferred = false;
    const fps = L.fps || 24, N = L.curN || L.n, r = Math.max(1, L.hdFps || 5);
    const hf = L.hdFps || 0, need = fps * 0.85;
    // 嘴的更新步长:DUIX 跟得上的最小步长(最大 3 = 8 fps 的嘴;再低嘴就一顿一顿的,不自然)
    u.hdStride = !hf ? 2 : hf >= need ? 1 : hf * 2 >= need ? 2 : 3;      // ≥ 8 fps mouth always (user 10-21: 自然、丝滑)
    const st = u.hdStride, total = Math.ceil((u.frames || 0) / st), cons = fps / st;
    const needN = Math.max(4, Math.ceil(total * Math.max(0.1, 1 - 0.9 * r / cons)));
    // 第一张嘴要多久(实测,上一次请求的 EMA;默认 0.45 s)+ 先到的那批嘴 + 余量
    const leadS = Math.max(0.35, (L.firstMouthS || 0.45) + needN / r + 0.15);
    const curEnd = L.cur && !L.cur.blow && L.cur.k0U != null ? L.cur.k0U + (L.cur.frames || 0) : -1e9;
    const after = Math.max(L.planEnd != null ? L.planEnd : -1e9, curEnd) + 2;   // 紧接上一句,不重叠
    u.k0Abs = Math.max(L.kU + Math.ceil(leadS * fps), after);
    L.planEnd = u.k0Abs + (u.frames || 0);
    u.k0Rel = ((u.k0Abs % N) + N) % N;
    this._collectHd(u).then(u._hdRes, u._hdRej);
  }

  /** 停在开口帧前一帧等嘴:片子暂停时没有帧回调,所以自己盯着,嘴一到齐(或这句没了)就接着放。 */
  _holdBase(v, u) {
    if (this._holdIv) return;
    try { v.pause(); } catch (e) {}
    this._holdIv = setInterval(() => {
      const L = this._live;
      if (!L || u.ready || !L.q.includes(u) || L.spk !== u.hdBase) {
        clearInterval(this._holdIv); this._holdIv = null;
        v.playbackRate = 1; v.play().catch(() => {});
      }
    }, 40);
  }

  /** 把底片倒到第 kAbs 帧(她这段底片里的绝对帧号),帧计数跟着改,不当成转了一圈。 */
  _seekBase(v, kAbs) {
    const L = this._live, N = L.curN || L.n, k = ((kAbs % N) + N) % N;
    L.loops = Math.floor(kAbs / N); L.lastK = k; L.kU = kAbs;
    try { v.currentTime = (k + 0.5) / L.fps; } catch (e) {}
  }

  /** 这句和它后面已经排好的句子一起重排(后面的嘴是接着这句画的,不能让这句插到它们后面)。 */
  _replanFrom(u) {
    const L = this._live, i = L.q.indexOf(u); if (i < 0) return;
    L.planEnd = null;
    for (const x of L.q.slice(i)) if (x.hd && x.k0Abs != null) { this._replanHd(x, true); x.hdDeferred = true; }
  }

  /** 排好的开口帧已经过去了(页面在后台没走帧之类):这句重新排一次,按这次实际的出嘴速度排。 */
  _replanHd(u, later) {
    const L0 = this._live, el = (performance.now() - (u.hdT0 || 0)) / 1000;
    if (u.gotHd >= 2 && el > 1) L0.hdFps = Math.min(L0.hdFps || 1e9, u.gotHd / el);
    clearInterval(u.hdDog);                                       // the old request must never fail this line later
    if (u.hdWs) { const h = u.hdWs.onclose; u.hdWs.onmessage = u.hdWs.onerror = u.hdWs.onclose = null; try { u.hdWs.close(); } catch (x) {}
      if (h) L0.hdOpen = Math.max(0, (L0.hdOpen || 1) - 1); }
    for (const p of (u.patches || new Map()).values()) try { p.bmp.close(); } catch (x) {}
    const L = this._live; if (L.planEnd === u.k0Abs + (u.frames || 0)) L.planEnd = null;
    u.ready = false; u.hdEarly = false;
    u.hdPromise = new Promise((res, rej) => { u._hdRes = res; u._hdRej = rej; });
    u.hdPromise.then(() => { if (u.audio) u.ready = true; }, () => { u.hd = false; if (u.audio) u.ready = true; });
    u.k0Abs = null;
    if (!later) this._planHd(u);
  }

  /** HD 回复用哪段底片:这句的情绪有底片就用它,没有(温柔 / 不带标签)就用一段温和的底片 —— idle 不行(帧对不齐)。 */
  _hdBase(emo) {
    const L = this._live, b = L.bases || {};
    if (emo && b[emo] != null) return b[emo];
    for (const e of ['温柔', '开心', '害羞', '调皮', '撒娇']) if (b[e] != null) return b[e];
    const any = Object.values(b); return any.length ? any[0] : null;
  }

  /** 收齐一句 HD 回复的全部 DUIX 补丁(引擎渲染完会发 done)。 */
  _collectHd(u) {
    const L = this._live, r = L.ranges.get(u.hdBase) || [0, L.n], k0 = r[0] + (u.k0Rel != null ? u.k0Rel : (u.hd_k0 || 3));
    u.patches = new Map(); u.gotHd = 0;
    /* 半帧率(用户 10-19:"实时 DUIX,照那个 repo 的做法" —— repo 把形象视频转成 15 fps 少算 37% 帧):DUIX 每两帧出一张嘴,
       这张嘴保持两帧。只有 DUIX 自己就快到接近实时(L.hdFps = 每秒出几张,Apple 芯片)才每帧都算。 */
    // 嘴的更新步长:挑 DUIX 跟得上的最小步长(每帧 / 隔一帧 / 隔两帧)—— 跟得上就不用等,句子之间也不停顿(用户 10-20:"real time all");
    // 快速 DUIX 冷机 ~12 张/秒 → 隔一帧(12 fps 的嘴),天热 ~8 张/秒 → 隔两帧(8 fps 的嘴,脸照常 24 帧)
    const hf = L.hdFps || 0, need = (L.fps || 24) * 0.85;
    /* 10-21(用户:"一两句话之后就卡"):电池限功率(CPU_Speed_Limit 20)时 DUIX 只有 ~4–5 张/秒,步长 3 要 8 张/秒 —— 嘴越落越远,
       一直停在最后到的那张(张着嘴不动)。步长跟着实测出图速度走(最多 6:一张嘴管 6 帧,~4 张/秒,和音节差不多快),永远跟得上。 */
    if (u.hdStride == null) u.hdStride = u.filler ? 2 : !hf ? 2 : Math.min(6, Math.max(1, Math.ceil(need / hf)));   // (calm lines too)
    return new Promise((resolve, reject) => {
      let pending = 0, done = false;
      const fin = () => { if (done && !pending) resolve(); };
      /* 不必等全部到齐:按实测出图速度(打 7 折),剩下的嘴保证在播到它之前到 —— 就可以开口了(和 wav2lip 那条路一个思路)。
         最后一张最紧:(total − got) / rate ≤ (K0 + (total − 1)·stride) / fps。 */
      const t0 = u.hdT0 = performance.now();
      /* fill(10-21):她的嘴是她自己的唇按开合度变形出来的 —— 引擎每一帧都画(DINet 只在关键帧上跑),这边就按每帧取嘴;
         引擎在流的开头发 {fill:1} 说明。没有 fill 时按步长:一张嘴管 stride 帧。 */
      let st = u.hdStride, total = Math.ceil((u.frames || 0) / st);
      const alone = !(L.hdOpen > 0); L.hdOpen = (L.hdOpen || 0) + 1;    // queued behind another line → its first-mouth wait isn't latency
      let closed = false; const close1 = () => { if (!closed) { closed = true; L.hdOpen = Math.max(0, (L.hdOpen || 1) - 1); } };
      const early = () => {
        // 用户 10-20:"口型必须等 voice 好之后再出现,voice 也一定要等口型" + "DUIX 安全系数放宽到 90%,变得更快" ——
        // 声音一出来,这一句后面的嘴按实测出图速度的 90% 算都来得及才开口(DUIX 中途慢 10% 以内嘴不会落后),
        // 且至少先到 10% 的嘴(≥ 4 张)
        if (u.hdEarly || !total || u.gotHd < Math.max(4, Math.ceil(total * 0.1))) return;
        const el = (performance.now() - t0) / 1000; if (el < 0.2) return;
        const rate = 0.9 * u.gotHd / el;
        const lead = u.calm ? 0 : u.k0Abs != null ? Math.max(0, u.k0Abs - L.kU) : (u.hd_k0 || 3);      // 离开口还有几帧
        if (u.gotHd >= total - rate * (lead + (total - 1) * st) / (L.fps || 24)) { u.hdEarly = true; resolve(); }
      };
      const bounce = u.calm && L.calm ? `&bounce=${L.calm[0]},${L.calm[1]}` : '';
      const ws = u.hdWs = new WebSocket(`${L.engine.replace(/^http/, 'ws')}/patches?id=${u.id}&k0=${k0}&lo=${r[0]}&n=${r[1]}&stride=${u.hdStride}&hd=1&fill=1${bounce}`);
      /* 10-21(用户:"永远不会卡"):calm 句子最多等 3 s 的嘴 —— 电池限功率、GPU 出错的时候 DUIX 可能只有 0.3 张/秒,
         那时宁可她按时开口、嘴在已经到的几张之间保持,也不能一直不说话。嘴照样继续到,到了就用。 */
      if (u.calm) setTimeout(() => { if (!u.hdEarly && !done && u.gotHd > 0) { u.hdEarly = true; resolve(); } }, this.opts.hdMaxWaitMs || 3000);
      if (u.calm) setTimeout(() => { if (!u.hdEarly && !done) { u.hdEarly = true; resolve(); } }, (this.opts.hdMaxWaitMs || 3000) + 3000);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = async (ev) => {
        if (typeof ev.data === 'string') {
          let m = {}; try { m = JSON.parse(ev.data); } catch (e) {}
          if (m.fill) { u.hdFill = true; st = 1; total = u.frames || 0; return; }   // every frame comes (her lips, DINet keyframes)
          if (m.skip != null) { u.hdTick = (u.hdTick || 0) + 1; return; }       // a garbled frame the engine skipped: progress
          // a silent frame (before / after her words, pauses): no DUIX mouth — her own closed lips from the video show
          if (m.bare != null) { u.patches.set(m.bare, { bare: true }); u.gotHd++; early(); fin(); return; }
          if (m.error) { close1(); reject(new Error(m.error)); return; }
          if (m.fps) L.hdFps = m.fps;
          done = true; close1(); fin(); return;
        }
        pending++;
        if (!u.gotHd && !u.firstAt) { u.firstAt = performance.now(); const f = (u.firstAt - t0) / 1000;      // 第一张嘴的实测延迟
          if (alone) L.firstMouthS = L.firstMouthS ? 0.6 * L.firstMouthS + 0.4 * f : f; }
        const dv = new DataView(ev.data), j = dv.getUint32(8, true);
        // GFP2 (10-21): her lips on their frame's own pixel grid — sub-pixel position, alpha complete (drawn once, as is)
        const exact = dv.getUint8(3) === 0x32, h0 = exact ? 24 : 20;
        const box = exact ? [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getInt16(20, true), dv.getInt16(22, true)]
                          : [dv.getInt16(12, true), dv.getInt16(14, true), dv.getInt16(16, true), dv.getInt16(18, true)];
        // JPEG, or WebP with alpha (her lips in fill mode: opaque only where they move — the skin around stays the live video)
        const b0 = new Uint8Array(ev.data, h0, 4), webp = b0[0] === 0x52 && b0[1] === 0x49 && b0[2] === 0x46 && b0[3] === 0x46;
        try { u.patches.set(j, { bmp: await createImageBitmap(new Blob([ev.data.slice(h0)], { type: webp ? 'image/webp' : 'image/jpeg' })), box, exact }); u.gotHd++; } catch (e) {}
        pending--; early(); fin();
      };
      let last = performance.now(), seen = 0;
      const dog = u.hdDog = setInterval(() => {
        if (done || u.hdEarly) { clearInterval(dog); return; }
        if (u.gotHd + (u.hdTick || 0) !== seen) { seen = u.gotHd + (u.hdTick || 0); last = performance.now(); return; }
        // 还没出第一张嘴时可能在排队(前面几句先渲染):给 40 s;出了嘴以后 8 s 没新的才算卡住
        if (performance.now() - last > (u.gotHd ? 8000 : 40000)) { clearInterval(dog); reject(new Error('hd patches stalled')); }
      }, 500);
      ws.onerror = () => { clearInterval(dog); close1(); reject(new Error('hd patches socket')); };
      ws.onclose = () => { clearInterval(dog); close1(); if (!done) reject(new Error('hd patches closed')); };
    });
  }

  _liveStopCur() {
    const L = this._live; if (!L || !L.cur) return;
    const c = L.cur; L.cur = null;
    // this line is over: its remaining mouths are useless — let the engine stop rendering them (10-21: leftover DUIX work
    // after an early start kept the GPU + CPU busy into the next turn, starving the brain)
    if (c.hd && c.hdWs) { try { c.hdWs.onmessage = c.hdWs.onerror = c.hdWs.onclose = null; c.hdWs.close(); } catch (e) {} }
    if (c.blow) this._lastBlowAt = performance.now(); else this._lastSpeechEnd = performance.now();
    try { c.ws && c.ws.close(); } catch (e) {}
    try { c.src && c.src.stop(); } catch (e) {}
    for (const p of c.patches.values()) try { p.bmp.close(); } catch (e) {}
    if (this._mouthCtx) this._mouthCtx.clearRect(0, 0, this._mouthCv.width, this._mouthCv.height);
    if (!c.blow && !L.q.some(u => !u.blow)) { this.setSpeaking(false); if (L.onSpeaking) L.onSpeaking(false); }
  }

  _liveStart(u) {
    const L = this._live;
    const fps = L.fps;
    if (u.hd) {
      const K = u.hd_k0 || 3, N = L.curN || L.n;
      const k0U = u.k0Abs != null ? u.k0Abs : L.kU <= K - 2 ? K : (Math.floor(L.kU / N) + 1) * N + K;   // 排好的开口帧
      L.expectUntil = 0;
      L.cur = { ...u, k0U: u.calm ? null : k0U, stride: u.hdFill ? 1 : (u.hdStride || 1), patches: u.patches, got: u.gotHd, started: false, t0: performance.now(), spk: L.spk };
      return;                                     // "speaking" starts with her voice, at the planned frame (_liveFrame)
    }
    // 引擎随每句话报它最近的出帧速度:先按它定步长和缓冲,这句话从头到尾都不会断嘴
    let g, stride;
    if (u.duix) {
      // DUIX 流式:L.hdFps = 每秒出几张 DUIX 嘴。步长挑到"生成至少跟上实时的 60%"(最多 6 帧一张),剩下靠开头的缓冲
      if (u.gen_fps > 0) L.hdFps = L.hdFps ? Math.min(L.hdFps, u.gen_fps) * 0.5 + u.gen_fps * 0.5 : u.gen_fps;
      g = Math.max(1, L.hdFps || 4);
      stride = [1, 2, 3, 4, 6].find(s => g * s >= fps * 0.6) || 6;
    } else {
      if (u.gen_fps > 0) L.genFps = Math.min(L.genFps, u.gen_fps) * 0.5 + u.gen_fps * 0.5;
      g = Math.max(2, L.genFps);
      // Mac 很热、生成跟不上:嘴降到 1/2、1/3 帧率(脸照常 24 帧),也比卡住或闭着嘴说话好
      stride = g >= fps * 0.8 ? 1 : g >= fps * 0.4 ? 2 : 3;
    }
    const need = Math.max(0, 1 - (g * stride) / fps);
    const lead = Math.max(6, Math.ceil(u.frames * need * 1.1) + 4);
    const c = L.cur = { ...u, k0U: L.kU + lead, stride, patches: new Map(), got: 0, started: false, t0: performance.now(), hd: !!u.duix };
    c.spk = L.spk;
    const ws = c.ws = new WebSocket(`${L.engine.replace(/^http/, 'ws')}/patches?id=${u.id}&k0=${L.lo + c.k0U % L.curN}&lo=${L.lo}&n=${L.curN}&stride=${stride}${u.duix ? '&hd=1' : ''}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = async (ev) => {
      if (typeof ev.data === 'string') {
        try { const m = JSON.parse(ev.data); if (u.duix) { if (m.fps) L.hdFps = m.fps; } else if (m.raw_fps) L.genFps = m.raw_fps * stride; } catch (e) {}
        return;
      }
      const dv = new DataView(ev.data);
      const j = dv.getUint32(8, true);
      const box = [dv.getInt16(12, true), dv.getInt16(14, true), dv.getInt16(16, true), dv.getInt16(18, true)];
      let bmp; try { bmp = await createImageBitmap(new Blob([ev.data.slice(20)], { type: 'image/jpeg' })); } catch (e) { return; }
      if (L.cur !== c) { bmp.close(); return; }
      c.patches.set(j, { bmp, box }); c.got++;
      if (c.got >= 8) {
        const rate = c.got / ((performance.now() - c.t0) / 1000);
        if (u.duix) L.hdFps = rate; else L.genFps = Math.max(4, rate * stride);
      }
    };
    if (!u.blow) { this.setSpeaking(true); if (L.onSpeaking) L.onSpeaking(true); }
  }

  /* 自然眨眼(用户 10-21:"idle 完全没眨眼了,真实感不够,要恢复自然眨眼"):平静底片那一段里她不眨眼(之后她就开始笑),所以眼睛这一
     小块换成同一条片子里她真的一次眨眼(manifest blink:竖排精灵图 + 帧 0 坐标里的矩形),按人眨眼的节奏随机来:2–9 s 一次、偶尔连眨
     两下,说话时也眨。位置跟着片子自己的运动(hd_track),只动眼睛,其余永远是原片。 */
  /* 流式数字人 (beiyege-01/dsh-voice-ai-girlfriend §八, user 10-21: "严格按照一样的步骤"): every reply segment comes as ONE
     DUIX face2face video of her avatar with her voice muxed in (event 'dh') — lips and voice are one file, in step by
     construction. Like the repo's companion window: it fades in over her idle (0.8 s), the segments play back to back in
     one <video>, and after the last one she fades back to the idle. A newer reply drops the older one's unplayed segments. */
  _dhEnqueue(ev) {
    const D = this._dh || (this._dh = { q: [], vs: [], cur: -1, playing: false, turn: -1 });
    if (ev.turn > D.turn) { D.q = []; D.turn = ev.turn; }
    else if (ev.turn < D.turn) return;
    D.q.push(ev); D.q.sort((a, b) => a.i - b.i);
    if (!D.playing) this._dhNext(); else this._dhPreload();
  }

  /* two <video>s in her idle video's box (_mkVideo), above everything in it: one plays, the other already holds the next
     segment — the swap at the end of a segment is instant (one element reloading its src flashed between segments) */
  _dhVideos() {
    const D = this._dh;
    if (D.vs.length === 2 && D.vs[0].parentNode === this.root) return D.vs;
    D.vs = [0, 1].map(() => {
      const v = document.createElement('video');
      v.playsInline = true; v.preload = 'auto'; v.muted = false; v.volume = this._volume();
      const s = v.style;
      s.width = '100%'; s.height = '100%'; s.objectFit = 'contain'; s.position = 'absolute'; s.inset = '0';
      s.opacity = '0'; s.zIndex = '6'; s.pointerEvents = 'none';
      v.addEventListener('ended', () => { if (this._dh.vs[this._dh.cur] === v) this._dhNext(); });
      v.addEventListener('error', () => { if (this._dh.vs[this._dh.cur] === v) this._dhNext(); });
      this.root.appendChild(v);
      return v;
    });
    return D.vs;
  }

  _dhPreload() {                                         // the next segment into the hidden element
    const D = this._dh, L = this._live, vs = this._dhVideos(), nx = vs[(D.cur + 1) % 2], ev = D.q[0];
    if (!ev) return;
    const url = `${L.engine}${ev.url}`;
    if (nx.dataset.url !== url) { nx.dataset.url = url; nx.src = url; nx.load(); }
  }

  _dhNext() {
    const D = this._dh, L = this._live, vs = this._dhVideos();
    const prev = D.cur >= 0 ? vs[D.cur] : null, ev = D.q.shift();
    if (!ev) {                                           // the reply is over: back to her idle
      D.playing = false;
      if (prev) { prev.style.transition = 'opacity 0.8s ease'; prev.style.opacity = '0'; }
      setTimeout(() => { if (!D.playing) { for (const v of vs) { try { v.pause(); } catch (e) {} } if (this._eyeCv) this._eyeCv.style.visibility = ''; } }, 850);
      this.setSpeaking(false); if (L && L.onSpeaking) L.onSpeaking(false);
      return;
    }
    const first = !D.playing; D.playing = true;
    D.cur = (D.cur + 1) % 2; const v = vs[D.cur];
    const url = `${L.engine}${ev.url}`;
    if (v.dataset.url !== url) { v.dataset.url = url; v.src = url; v.load(); }
    const go = () => {
      v.removeEventListener('canplay', go);
      if (!D.playing || vs[D.cur] !== v) return;
      if (this._eyeCv) this._eyeCv.style.visibility = 'hidden';   // her blinks are the avatar's own while it plays
      v.style.transition = first ? 'opacity 0.8s ease' : 'none'; v.style.opacity = '1';
      const p = v.play(); if (p) p.catch(() => { v.muted = true; v.play().catch(() => {}); });
      // the previous segment leaves only once this one shows its first frame (no gap, no flash)
      const hide = () => { if (prev && prev !== v) { prev.style.transition = 'none'; prev.style.opacity = '0'; try { prev.pause(); } catch (e) {} } };
      if (prev && prev !== v) { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => hide()); else v.addEventListener('playing', hide, { once: true }); }
      this.setSpeaking(true); if (L.onSpeaking) L.onSpeaking(true);
      this._dhPreload();
    };
    if (v.readyState >= 3) go(); else v.addEventListener('canplay', go);
  }

  /* 10-21 (user: "as fast as possible … 丝滑 … 不会卡顿"): one reply = ONE continuous fragmented-MP4 stream (event dh_stream),
     appended to a MediaSource as the engine renders it; "dh_go" comes once the rest is sure to render before playback gets
     there — she starts while it is still being made and never stalls. No MSE: the finished file, the same video. */
  _dhsOpen(ev) {
    const L = this._live, D = this._dh || (this._dh = { q: [], vs: [], cur: -1, playing: false, turn: -1 });
    if (ev.turn < D.turn) return;
    D.turn = ev.turn; D.q = []; L.thinkUntil = 0;
    const old = D.s; if (old) { old.dead = true; this._dhsUngesture(old); this._dhsIdleBack(old); try { old.ws && old.ws.close(); } catch (e) {} }
    const vs = this._dhVideos(), v = vs[(D.cur + 1) % 2];
    const S = D.s = { turn: ev.turn, v, chunks: [], ended: false, go: false, dead: false, url: null, file: ev.file, t0: performance.now() };
    if (this._duplex) { S.duplex = true; this.opts.voiceCmd(`play ${ev.turn} ${L.engine}/dha/${ev.turn}`); }   // fetched now, heard at go
    // the reply opens on the gesture an agent line was waiting for: that line now leaves her fingertip inside this video
    if (ev.gesture && ev.gesture.id) {
      const b = (this._blowQ || []).find(x => x.hid === ev.gesture.id && !x.released);
      if (b) {
        if (this._pathArm && this._pathArm.b === b) this._pathArm = null;
        b.requested = true; b.viaDh = S; S.gesture = { b, impact: +ev.gesture.impact || 0 };
      }
    }
    const mse = window.MediaSource && MediaSource.isTypeSupported(ev.mime);
    if (!mse) { S.fallback = true; return; }
    const ms = S.ms = new MediaSource();
    S.url = URL.createObjectURL(ms); v.dataset.url = S.url; v.src = S.url;
    ms.addEventListener('sourceopen', () => {
      if (S.dead) return;
      try { S.sb = ms.addSourceBuffer(ev.mime); } catch (e) { S.fallback = true; return; }
      S.sb.addEventListener('updateend', () => this._dhsPump(S));
      const ws = S.ws = new WebSocket(`${L.engine.replace(/^http/, 'ws')}${ev.url}`); ws.binaryType = 'arraybuffer';
      ws.onmessage = (m) => { if (!S.dead) { S.chunks.push(m.data); this._dhsPump(S); } };
      ws.onclose = () => { S.ended = true; this._dhsPump(S); };
      ws.onerror = () => {};
    }, { once: true });
  }

  _dhsPump(S) {
    if (S.dead || !S.sb || S.sb.updating) return;
    if (S.chunks.length) { try { S.sb.appendBuffer(S.chunks.shift()); } catch (e) { S.fallback = true; } return; }
    if (S.ended && S.ms.readyState === 'open') { try { S.ms.endOfStream(); } catch (e) {} }
  }

  _dhsGo(ev) {
    const D = this._dh, S = D && D.s, L = this._live;
    if (!S || S.turn !== ev.turn || S.dead || S.go) return;
    S.go = true;
    if (S.fallback) {                                  // no MSE: the finished file once it is complete
      const tryFile = () => { if (S.dead) return; const v = S.v; v.dataset.url = L.engine + S.file; v.src = L.engine + S.file; this._dhsStart(S); };
      if (S.ended) tryFile(); else { const t = setInterval(() => { if (S.ended || S.dead) { clearInterval(t); tryFile(); } }, 300); }
      return;
    }
    this._dhsStart(S);
  }

  /** a 数字人 reply is on its way (stream open, not yet over) or playing */
  _dhBusy() {
    const D = this._dh, S = D && D.s;
    // 300 s: under the battery cap + a busy GPU one reply took 105 s to render (10-21) — a 60 s guard let gestures start meanwhile
    return !!(D && (D.playing || (S && !S.dead && !S.finished && (S.go || performance.now() - S.t0 < 300000))));
  }

  _dhsStart(S) {
    /* a gesture on screen: the reply waits until she is home on the calm idle (a fade from mid-gesture shows two of her at
       once); one that is only armed gives way (a text gesture goes back in the queue and comes after the reply) */
    if (this._pathArm) this._dropArm();
    if (this._pathActive) {
      if (!S.waitIv) S.waitIv = setInterval(() => {
        if (S.dead) { clearInterval(S.waitIv); S.waitIv = null; return; }
        if (!this._pathActive) { clearInterval(S.waitIv); S.waitIv = null; this._dhsStart(S); }
      }, 40);
      return;
    }
    const D = this._dh, L = this._live, vs = this._dhVideos(), v = S.v, prev = D.cur >= 0 ? vs[D.cur] : null;
    D.cur = vs.indexOf(v); D.playing = true;
    const go = () => {
      v.removeEventListener('canplay', go);
      if (S.dead) return;
      if (this._eyeCv) this._eyeCv.style.visibility = 'hidden';
      /* 10-21 (user: "DUIX重影还是很严重"): the reply opens on her idle's own frame (the engine starts it on frame 0) and the
         idle barely moves (≤ ~2 px at 1080p), so a quick fade reads as one picture; the old 0.8 s fade ran over 12 frames of
         the talking clip moving away from the idle — two of her, half-transparent */
      v.style.transition = 'opacity 0.25s ease'; v.style.opacity = '1';
      if (prev && prev !== v) { prev.style.transition = 'opacity 0.25s ease'; prev.style.opacity = '0'; }
      v.playbackRate = 1;                                 // a reused element: no speed left over from an earlier reply
      if (S.duplex) {
        v.muted = true; this.opts.voiceCmd(`go ${S.turn}`);
        // no clock from the helper in 1.5 s (it never got her voice): the video speaks for itself — a reply is never silent
        setTimeout(() => { if (D.s === S && !S.gotPos && !S.dead) { S.duplex = false; v.muted = false; v.playbackRate = 1; this.opts.voiceCmd('halt'); } }, 1500);
      } else v.muted = false;
      const p = v.play(); if (p) p.catch(() => { v.muted = true; v.play().catch(() => {}); });
      this.setSpeaking(true); if (L.onSpeaking) L.onSpeaking(true);
      /* once the reply's video fully covers her idle, the 4K idle stops decoding underneath (10-21: two videos decoding + the
         screen compositing both took GPU from DUIX rendering the next reply); it resumes before the fade back (_dhsIdleBack) */
      // covered: the idle stops decoding underneath, parked on its first frame — the one the reply's video ends on (the engine
      // walks her home to frame 0), so the hand back at the end is the same picture on both sides
      const idleV = this._clipVideos && this._clipVideos[L.idle];
      setTimeout(() => {
        if (D.s === S && D.playing && !S.dead && idleV) { try { idleV.pause(); idleV.currentTime = 0; } catch (e) {} S.idlePaused = idleV; }
      }, 350);
      const G = S.gesture;                               // the agent line leaves her fingertip when the video gets there
      if (G && !G.b.released) {
        const watch = () => {
          if (S.dead || G.b.released) return;
          if (v.currentTime >= G.impact) { G.b.released = true; this._textSpaced(performance.now()); return; }
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(watch); else setTimeout(watch, 40);
        };
        watch();
      }
    };
    // a stall anyway (the Mac slowed down more than the engine planned for): pause once and go on with 2 s buffered — one
    // pause instead of a stutter every few frames
    v.onwaiting = () => {
      if (D.s !== S || S.ended || S.held) return;
      S.held = true; try { v.pause(); } catch (e) {}
      if (S.duplex) this.opts.voiceCmd('pause');
      const t = setInterval(() => {
        const ahead = v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
        if (D.s !== S || S.dead) { clearInterval(t); return; }
        if (ahead >= 2 || S.ended) { clearInterval(t); S.held = false; v.play().catch(() => {}); if (S.duplex) this.opts.voiceCmd('resume'); }
      }, 100);
    };
    v.onended = () => {
      if (D.s !== S) return;
      if (S.duplex) this.opts.voiceCmd('halt');
      S.finished = true; this._dhsUngesture(S); this._dhsIdleBack(S);
      // her last frame = the idle's first (the engine's walk home), the idle resumes from there: a short fade, one picture
      D.playing = false; v.style.transition = 'opacity 0.3s ease'; v.style.opacity = '0';
      setTimeout(() => { if (!D.playing) { if (this._eyeCv) this._eyeCv.style.visibility = ''; if (S.url) { try { URL.revokeObjectURL(S.url); } catch (e) {} } } }, 900);
      this.setSpeaking(false); if (L.onSpeaking) L.onSpeaking(false);
    };
    if (v.readyState >= 3) go(); else v.addEventListener('canplay', go);
  }

  /** her idle, paused under the reply's video, plays again before the reply fades out */
  _dhsIdleBack(S) {
    const v = S && S.idlePaused; if (!v) return;
    S.idlePaused = null; v.play().catch(() => {});
  }

  /** a reply that was to carry an agent line's gesture ends before the line came out: the line goes back in the queue */
  _dhsUngesture(S) {
    const G = S && S.gesture;
    if (G && !G.b.released && G.b.viaDh === S) { G.b.viaDh = null; G.b.requested = false; G.b.hid = null; }
  }

  _dhStop() {
    const D = this._dh; if (!D) return;
    if (D.s) { if (D.s.duplex) this.opts.voiceCmd('halt'); D.s.dead = true; this._dhsUngesture(D.s); this._dhsIdleBack(D.s); try { D.s.ws && D.s.ws.close(); } catch (e) {} }
    D.q = []; D.playing = false;
    // cut off mid-sentence she is wherever the talking clip was (no walk home): a near-cut, too short to read as two of her
    for (const v of D.vs) { try { v.pause(); } catch (e) {} v.style.transition = 'opacity 0.12s linear'; v.style.opacity = '0'; }
    if (this._eyeCv) this._eyeCv.style.visibility = '';
  }

  _setupBlink(L) {
    const im = (this._clipMetaArr || [])[L.idle], b = im && im.blink, v = this._clipVideos && this._clipVideos[L.idle];
    L.blink = null;
    if (!b || !b.sprite || !(b.n > 0) || !Array.isArray(b.rect0) || !v || !this.root) return;
    const img = new Image();
    img.onload = () => {
      if (this._live !== L) return;
      const cv = this._eyeCv || (this._eyeCv = document.createElement('canvas'));
      cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transform-origin:0 0;z-index:5';
      if (cv.parentNode !== this.root) this.root.appendChild(cv);
      const S = 64, m = document.createElement('canvas'); m.width = m.height = S;      // soft rectangle: brows / cheeks fade out
      const g = m.getContext('2d'), id = g.createImageData(S, S), ss = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, w = (y + 0.5) / S;
        id.data[(y * S + x) * 4 + 3] = Math.round(255 * ss(u / 0.14) * ss((1 - u) / 0.14) * ss(w / 0.3) * ss((1 - w) / 0.3));
      }
      g.putImageData(id, 0, 0);
      L.blink = { img, n: b.n, fps: b.fps || L.fps || 24, rect: b.rect0, res: Array.isArray(b.rectRes) ? b.rectRes : null, alpha: b.alpha || [], fh: img.naturalHeight / b.n, fw: img.naturalWidth,
                  mask: m, t0: 0, next: performance.now() + 1200 + Math.random() * 2500, drawn: false };
    };
    img.src = b.spriteUrl || (v.currentSrc || v.src || '').replace(/[^/]*$/, '') + b.sprite;   // spriteUrl: the wallpaper resolved it (blob: clips)
  }

  _blinkFrame(meta, k, onIdle) {
    const L = this._live, B = L.blink, cv = this._eyeCv; if (!B || !cv) return;
    const now = performance.now(), at = meta.expectedDisplayTime || now;
    const clear = () => { if (B.drawn) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); B.drawn = false; } };
    if (!onIdle) { B.t0 = 0; clear(); return; }                        // a gesture / bridge clip on screen: its own eyes
    if (!B.t0) { if (now < B.next) { clear(); return; } B.t0 = at; }
    const i = Math.floor((at - B.t0) / 1000 * B.fps);
    if (i >= B.n) {                                                     // done: the next one like a person — sometimes right away
      B.t0 = 0; clear();
      B.next = now + (Math.random() < 0.12 ? 90 : 1800 + Math.min(7000, -Math.log(1 - Math.random()) * 2600));
      return;
    }
    const v = this._clipVideos[L.idle], vw = v.videoWidth || L.vw || 1, vh = v.videoHeight || L.vh || 1;
    const W = Math.max(1, Math.round(this._boxW * Math.min(2, devicePixelRatio || 1)));
    const H = Math.max(1, Math.round(this._boxH * Math.min(2, devicePixelRatio || 1)));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    if (cv.style.transform !== v.style.transform) cv.style.transform = v.style.transform;
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H);
    const T = L.hdTracks && L.hdTracks.get(L.idle), tx = T && 2 * k + 1 < T.length ? T[2 * k] : 0, ty = T && 2 * k + 1 < T.length ? T[2 * k + 1] : 0;
    // rect0 in the pixels of the clip it was measured on (rectRes: the 4K master); the idle may play at 1080p (settings 画质)
    const rs = B.res ? vw / B.res[0] : 1, rsy = B.res ? vh / B.res[1] : 1;
    const rx = B.rect[0] * rs, ry = B.rect[1] * rsy, rw = B.rect[2] * rs, rh = B.rect[3] * rsy;
    const dw = Math.max(1, Math.round(rw / vw * W)), dh = Math.max(1, Math.round(rh / vh * H));
    const t = B.tmp || (B.tmp = document.createElement('canvas'));
    if (t.width !== dw || t.height !== dh) { t.width = dw; t.height = dh; }
    const tc = t.getContext('2d');
    tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, dw, dh);
    tc.drawImage(B.img, 0, i * B.fh, B.fw, B.fh, 0, 0, dw, dh);
    tc.globalCompositeOperation = 'destination-in'; tc.drawImage(B.mask, 0, 0, dw, dh);
    ctx.globalAlpha = B.alpha[i] != null ? B.alpha[i] : 1;
    ctx.drawImage(t, (rx + tx) / vw * W, (ry + ty) / vh * H); ctx.globalAlpha = 1;
    B.drawn = true;
  }

  _liveFrame(meta, vi) {
    const L = this._live; if (!L || !L.n) return;
    if (vi != null && vi !== L.spk) return;              // 只有正在说话的那段(idle 或情绪底片)驱动嘴
    const N = L.curN || L.n;
    const k = Math.round(meta.mediaTime * L.fps) % N;
    const wrapped = L.lastK >= 0 && k < L.lastK - N / 2;
    if (wrapped) L.loops++;
    L.lastK = k; L.kU = L.loops * N + k;
    const onSpk = this._clipIndex === L.spk && !this._fading;
    const onIdle = onSpk && L.spk === L.idle;
    if (L.blink) this._blinkFrame(meta, k, onIdle);
    if (onSpk && L.spk !== L.idle) {
      // 情绪底片上:说完了、没有排队的话 → 等它走到最后一帧(种子帧)再回 idle
      const nextHere = L.q.length && !(L.q[0].hd && L.q[0].hdBase !== L.spk);
      if (!L.cur && !nextHere && !(L.expectUntil > performance.now()) && (k >= N - 3 || wrapped) && performance.now() - (L.talkSince || 0) > 1200) { this._endTalk(); return; }
    }
    if (this._pathArm && onIdle && !L.cur && (!L.q.length || this._pathArm.b.kind === 'talk')) {
      const a = this._pathArm;
      if (a.enter.has(k)) { this._pathArm = null; this._startPath(a); return; }
      if (a.eb) {
        const fwd = k <= (L.n - 1) / 2, f = fwd ? k : L.n - 1 - k;
        if (a.target && f === a.target.f) { this._pathArm = null; this._startEnterBridge(a); return; }
        // 还没选锚点 / 锚点已经在身后(往返掉头了):挑下一个,过桥片段先 seek 到那一段的开头等着
        if (!a.target || (fwd ? a.target.f < f : a.target.f > f)) {
          a.target = this._anchorAhead(a, k);
          if (a.target) { const br = this._clipVideos[a.eb.k]; try { br.pause(); br.currentTime = (a.target.i * a.eb.seg + 0.5) / L.fps; } catch (e) {} }
        }
        a.mirrored = true;                               // 有过桥就不用镜像跳
      }
      /* 往返循环(idle_live = clip_1 正放 + 倒放):第 n-1-k 帧和第 k 帧是同一张画面。她正往外走(前半段)时,
         跳到镜像帧接着播 = 画面一模一样、直接往回走,最多 ~4s 就回到动作入口(不用等满 8s 的一圈)。 */
      if (!a.mirrored && L.n && k > 6 && k < L.n / 2 - 1) {
        a.mirrored = true;
        const v = this._clipVideos[L.idle];
        try { v.currentTime = (L.n - 1 - k + 0.5) / L.fps; } catch (e) {}
      }
    }
    /* 待机不循环(用户 10-18:"让人感觉不出来是 predetermined 的 asset"):video textures(Schödl 2000)那样随机游走 ——
       往返循环里第 k 帧和第 n-1-k 帧是同一张画面,在"几乎静止"的帧上跳到镜像帧 = 画面不变、接着往回走。
       她的呼吸 / 眨眼 / 晃动每一轮长短都不一样,看不出 8 秒一圈。只在安静时:说话的补丁按线性帧号生成,不能跳。 */
    else if (L.calm && onIdle && !this._pathActive && (L.calmTalk ? (!L.cur || L.cur.calm) : (!L.cur && !L.q.length))) {
      const fwd = k <= (L.n - 1) / 2, f = fwd ? k : L.n - 1 - k;
      if (L.calmB == null) L.calmB = Math.round(L.calm[0] + (L.calm[1] - L.calm[0]) * (0.6 + 0.4 * Math.random()));
      if (fwd && f >= L.calmB) {                       // 往外走到折返点:跳到镜像帧(同一张画面)往回走,回到种子帧再出来
        L.calmB = null; L.turnAt = performance.now();
        try { this._clipVideos[L.idle].currentTime = (L.n - 1 - k + 0.5) / L.fps; } catch (e) {}
      }
    }
    else if (L.turns && onIdle && !L.cur && !L.q.length && !this._pathActive) {
      const f = k <= (L.n - 1) / 2 ? k : L.n - 1 - k, now = performance.now();
      if (L.turns.has(f) && now - (L.turnAt || 0) > 1400 && Math.random() < 0.34) {
        L.turnAt = now;
        try { this._clipVideos[L.idle].currentTime = (L.n - 1 - k + 0.5) / L.fps; } catch (e) {}
      }
    }
    this._pumpBlows();
    this._idleLife(performance.now());
    // 开口:前一句说完、下一句音频已解码、她正停在 idle 上
    const u0 = L.q[0];
    /* 说话优先(用户 10-20:"回答必须实时"):备好但还没开始的手势 / 待机小动作,只在没话要说时才会放行;
       话一备好它就该让路 —— 否则两边互相等(手势等队列空,说话等手势走),她就一直不开口。
       待机小动作直接丢掉、8–18 s 后再来一个;带 agent 字的手势放回队列,说完再演。 */
    if (!L.cur && u0 && (u0.ready || (u0.hd && u0.hdDeferred)) && this._pathArm && this._pathArm.b.kind !== 'talk' && !this._pathActive) this._dropArm();
    // 排开口帧:她已经在句子的底片上了,按队列顺序给还没排的句子排(上一句没排,后面的先不排)
    for (const u of L.q) { if (!u.hdDeferred) continue; if (onSpk && L.spk === u.hdBase) this._planHd(u); break; }
    /* 嘴还没到齐、排好的开口帧快到了:底片放慢,到那一帧就停住等嘴 —— 已经渲染好的嘴一张不丢(10-20 实测:以前过了开口帧就丢掉
       重排,DUIX 慢的时候一直重排、她一直不开口)。嘴一到齐马上恢复原速开口。真的已经错过(比如页面在后台)才重排。 */
    if (!L.cur && u0 && u0.hd && u0.k0Abs != null && !u0.hdDeferred && onSpk && L.spk === u0.hdBase) {
      const bv = this._clipVideos[L.spk], left = u0.k0Abs - 1 - L.kU;
      if (left < 0 && left > -48) {                 // 上一句的声音收尾晚了几帧、已经走过开口帧:倒回开口帧前一帧(嘴是按那几帧画的)
        this._seekBase(bv, u0.k0Abs - 2);
        if (!u0.ready) this._holdBase(bv, u0);
        return;
      }
      if (left <= -48) this._replanFrom(u0);
      else if (u0.ready) { if (bv.playbackRate !== 1) bv.playbackRate = 1; }
      else if (left <= 1) this._holdBase(bv, u0);
      else if (left <= 18) bv.playbackRate = Math.max(0.25, left / 18);
    }
    if (!L.cur && onIdle && u0 && !u0.calm && (u0.ready || (u0.hd && u0.hdDeferred)) && !u0.blow && (u0.hd ? u0.hdBase != null : (u0.emo && L.bases[u0.emo] != null)) && !this._pathArm && !this._pathActive) {
      const bk = u0.hd ? u0.hdBase : L.bases[u0.emo];
      this._armPath({ kind: 'talk', path: { k: bk, p: { enter: [L.n - 3, L.n - 2, L.n - 1, 0, 1, 2], g0: 0, back: 0 }, bk: -1 },
                      released: true, requested: true, t0: performance.now() });
    } else if (!L.cur && onSpk && L.q.length && L.q[0].ready && (!L.q[0].hd || L.spk === L.q[0].hdBase) && !(onIdle && this._pathArm && this._pathArm.b.kind === 'talk')) {
      this._liveStart(L.q.shift());
    }
    const c = L.cur;
    const ctx = this._mouthCtx, mc = this._mouthCv;
    if (!c || !ctx) return;
    if (!c.started && (c.calm || L.kU >= c.k0U - 1)) {
      const delay = c.calm ? Math.max(0, meta.expectedDisplayTime - performance.now()) : L.kU >= c.k0U ? 0 : Math.max(0, (meta.expectedDisplayTime + 1000 / L.fps) - performance.now());
      // her voice reaches the ears after the audio pipeline's own latency (≈ 30 ms built-in speakers, 150–250 ms Bluetooth):
      // the calm mouth follows the sound heard, not the sound scheduled (10-21, user: "嘴唇…没 match voice 的节奏")
      const outLat = ((L.ac.outputLatency || 0) + (L.ac.baseLatency || 0)) * 1000;
      c.audioAt = performance.now() + delay + (c.calm && outLat < 400 ? outLat : 0);
      try {
        const src = c.src = L.ac.createBufferSource();
        src.buffer = c.audio; src.connect(this._liveGain(L));
        if (L.ac.state === 'suspended') L.ac.resume();
        src.start(L.ac.currentTime + delay / 1000);
        src.onended = () => { const lag = c.calm && outLat < 400 ? outLat : 0; setTimeout(() => { if (L.cur === c) this._liveStopCur(); }, lag); };
      } catch (e) {}
      c.started = true;
      c.endsAt = performance.now() + delay + c.audio.duration * 1000;
      if (c.hd && !c.blow) setTimeout(() => { if (L.cur === c) { this.setSpeaking(true); if (L.onSpeaking) L.onSpeaking(true); } }, delay);
    }
    // 画布和 idle 片子同一个对齐变换、同一个像素网格
    const v = this._clipVideos[L.spk];
    const W = Math.max(1, Math.round(this._boxW * Math.min(2, devicePixelRatio || 1)));
    const H = Math.max(1, Math.round(this._boxH * Math.min(2, devicePixelRatio || 1)));
    if (mc.width !== W || mc.height !== H) { mc.width = W; mc.height = H; }
    if (mc.style.transform !== v.style.transform) mc.style.transform = v.style.transform;
    ctx.clearRect(0, 0, W, H);
    // calm 句子:第几张嘴按声音时钟算(底片在 idle 里来回跳镜像帧,帧号不连续);情绪底片模式按底片帧号
    const j = c.calm ? (c.started ? Math.floor((meta.expectedDisplayTime - c.audioAt) / 1000 * L.fps) : -1) : L.kU - c.k0U;
    // 吹气:嘴最圆的那一帧放行这口气对应的那条字(粒子从嘴里出来)
    if (c.blow && j >= (c.peak || 0)) {
      const b = (this._blowQ || []).find(x => x.id === c.id);
      if (b && !b.released) b.released = true;
    }
    if (j < 0 || j >= c.frames || !onSpk || c.spk !== L.spk) return;
    const jj = j - (j % c.stride);
    let p = c.patches.get(jj);
    for (let q = jj - c.stride; !p && q >= Math.max(0, jj - 6 * c.stride); q -= c.stride) p = c.patches.get(q);
    if (!p || p.bare) return;                           // bare = she is silent here: the video's own mouth
    // 只回收**回退窗口之外**的旧补丁(上面最多往回找 6 个步长);先画,再回收
    const keepFrom = jj - 7 * c.stride;
    const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
    const [x, y, w, h] = p.box;
    const sx = x / vw * W, sy = y / vh * H, sw = w / vw * W, sh = h / vh * H;
    if (!this._mouthMask) this._mouthMask = this._makeMouthMask(256);
    const t = this._mouthTmp || (this._mouthTmp = document.createElement('canvas'));
    const tw = Math.max(1, Math.round(sw)), th = Math.max(1, Math.round(sh));
    if (t.width !== tw || t.height !== th) { t.width = tw; t.height = th; }
    const tc = t.getContext('2d');
    if (c.hd) {
      /* HD(DUIX)补丁:引擎已经按 DUIX 的下半脸遮罩把生成的脸和原片融好了,整块框贴上即可;框边羽化 6%,
         浏览器解出来的原片和引擎解出来的有一两级色差,框边不能露。不做 wav2lip 那套平滑 / 锐化 / 下巴。 */
      if (!this._hdMask) {
        const S = 256, m = this._hdMask = document.createElement('canvas'); m.width = m.height = S;
        const g = m.getContext('2d'), img = g.createImageData(S, S), d = img.data, f = 0.06;
        const ss = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
        for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
          const u = (xx + 0.5) / S, v = (yy + 0.5) / S;
          d[(yy * S + xx) * 4 + 3] = Math.round(255 * ss(u / f) * ss((1 - u) / f) * ss(v / f) * ss((1 - v) / f));
        }
        g.putImageData(img, 0, 0);
      }
      // no fade-in / fade-out at the line's ends (10-21: a half-transparent DUIX mouth over her own = two mouths, "重影"); the
      // engine sends her silent frames as bare — her own lips — so the mouth starts and stops with the sound
      const fade = 1;
      const mask = (L.hdMasks && L.hdMasks.get(c.spk)) || this._hdMask;      // her mouth only (box feather if no mask)
      /* 嘴跟着这一帧的头走(10-21:隔帧出嘴时,一张嘴保持 2–3 帧,以前一直贴在它自己那一帧的位置 → 头一动嘴就滑开、像变形):
         按当前帧的脸框画 —— 脸框随关键点逐帧走,嘴在框里的位置是稳定的 */
      const cb = L.boxes && L.boxes[(L.lo + Math.max(0, L.lastK)) % L.boxes.length];
      const sr = L.hdSubs && L.hdSubs.get(c.spk);          // the patch covers only her lips: place that rectangle in this frame's box
      const tr = c.calm && L.hdTracks && L.hdTracks.get(c.spk), tk = Math.max(0, L.lastK) * 2;
      let [px, py, pw, ph] = p.box;
      if (tr && tk + 1 < tr.length) { px += tr[tk]; py += tr[tk + 1]; }   // frame-0 box + the motion of the frame on screen
      if (p.exact && tr) {
        /* 10-21 (user: "张嘴说话的时候周围有阴影…看上去只有嘴唇动的丝滑"): her lips on their frame's own pixels, alpha complete —
           one drawImage at the exact (sub-pixel) place and size, the same single scaling the video itself gets. The old way
           (scale into a rounded temp canvas, mask, draw at a fractional spot) resampled her skin twice more: a soft ring. */
        ctx.globalAlpha = fade; ctx.drawImage(p.bmp, px / vw * W, py / vh * H, pw / vw * W, ph / vh * H); ctx.globalAlpha = 1;
        for (const [q, pp] of c.patches) if (q < keepFrom && pp !== p) { try { pp.bmp.close(); } catch (e) {} c.patches.delete(q); }
        return;
      }
      if (!(tr && tk + 1 < tr.length) && cb && cb[2] > cb[0]) {
        const bw = cb[2] - cb[0], bh = cb[3] - cb[1];
        [px, py, pw, ph] = sr ? [cb[0] + sr[0] * bw, cb[1] + sr[1] * bh, sr[2] * bw, sr[3] * bh] : [cb[0], cb[1], bw, bh];
      }
      const qx = px / vw * W, qy = py / vh * H;
      const qw = Math.max(1, Math.round(pw / vw * W)), qh = Math.max(1, Math.round(ph / vh * H));
      if (t.width !== qw || t.height !== qh) { t.width = qw; t.height = qh; }
      tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, qw, qh);
      tc.drawImage(p.bmp, 0, 0, qw, qh);
      tc.globalCompositeOperation = 'destination-in'; tc.drawImage(mask, 0, 0, qw, qh);
      // 不再在两张嘴之间淡入淡出(10-21:两张不同的嘴叠在一起 = 糊、重影);隔帧出嘴时一张嘴保持到下一张
      ctx.globalAlpha = fade; ctx.drawImage(t, qx, qy); ctx.globalAlpha = 1;
      for (const [q, pp] of c.patches) if (q < keepFrom && pp !== p) { try { pp.bmp.close(); } catch (e) {} c.patches.delete(q); }
      return;
    }
    /* 口型自然度(用户 10-18:"对嘴型说话的时候还是不够自然"):在补丁原尺寸上做两件事,只在换了新补丁时做一次 ——
       1) 时间平滑:上一帧补丁垫底、这一帧 72% 盖上去,wav2lip 每帧独立生成的唇 / 牙齿闪动被抹平;
       2) 轻锐化:256px 生成的嘴放大后比皮肤 / 眼睛糊,补一点锐度和脸对齐。 */
    if (c.curP !== p) { c.prevP = c.curP; c.curP = p; this._mouthSrcFor = null; }
    const src = this._mouthSrc || (this._mouthSrc = document.createElement('canvas'));
    if (this._mouthSrcFor !== p) {
      const bw0 = p.bmp.width || tw, bh0 = p.bmp.height || th;
      if (src.width !== bw0 || src.height !== bh0) { src.width = bw0; src.height = bh0; }
      const sc = src.getContext('2d', { willReadFrequently: true });
      sc.globalAlpha = 1; sc.clearRect(0, 0, bw0, bh0);
      let under = false;
      if (c.prevP && c.prevP.bmp) { try { sc.drawImage(c.prevP.bmp, 0, 0, bw0, bh0); under = true; } catch (e) {} }   // closed bitmap → skip
      sc.globalAlpha = under ? 0.72 : 1; sc.drawImage(p.bmp, 0, 0, bw0, bh0); sc.globalAlpha = 1;
      const o = this._sharpen(sc, bw0, bh0, 0.6);
      if (p.open == null) { p.open = o.open; p.gap = o.gap; }
      this._mouthSrcFor = p;
    }
    tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, tw, th);
    tc.drawImage(src, 0, 0, tw, th);
    tc.globalCompositeOperation = 'destination-in'; tc.drawImage(this._mouthMask, 0, 0, tw, th);
    // 每句话头尾 3 帧淡入淡出:生成的嘴和原片的嘴在开口 / 收口那一下不会"跳"
    const fade = Math.max(0, Math.min(1, (j + 1) / 3, (c.frames - j) / 3));
    ctx.globalAlpha = fade;
    ctx.drawImage(t, sx, sy);
    ctx.globalAlpha = 1;
    /* 下巴跟着说话动(用户 10-19 TODO:"the mouth corners and jaw moving with the speech"):模型只改嘴唇,下巴轮廓还是
       原片那个不动的,看着像"只动嘴皮子"。按这一帧嘴张开多少(补丁里口腔暗区 + 牙齿的高度)把嘴唇以下到下巴这一段往下
       拉一点,脖子那头再收回来;张口快、合口慢,像真的下颌。 */
    const tgt = Math.max(0, Math.min(1, ((p.open || 0) - 0.010) / 0.022)) * fade;
    c.jaw = (c.jaw || 0) + (tgt - (c.jaw || 0)) * (tgt > (c.jaw || 0) ? 0.6 : 0.35);
    if (p.gap) c.gap = c.gap ? [c.gap[0] + (p.gap[0] - c.gap[0]) * 0.5, c.gap[1] + (p.gap[1] - c.gap[1]) * 0.5] : p.gap.slice();
    // 下颌下移量 ≤ 1.2 × 嘴缝高:拉伸只在缝里,斜率有上限,不会把一行像素拖成一条
    // jawBoost:在模型自己画出的下颌之外再多张一点(默认 0 = 教程原样;0.5 = 用户对比片里的 C)
    const boost = Math.max(0, +this.opts.jawBoost || 0);
    const drop = c.gap && boost ? boost * Math.min(c.jaw * 0.028 * sh, 1.2 * (c.gap[1] - c.gap[0]) * sh) : 0;
    if (drop > 0.4) this._jawWarp(ctx, v, vw, vh, W, H, t, sx, sy, sw, sh, fade, drop, c.gap);
    for (const [q, pp] of c.patches) if (q < keepFrom && pp !== p) { try { pp.bmp.close(); } catch (e) {} c.patches.delete(q); }
  }

  /** 轻锐化(4 邻域拉普拉斯 = 半径很小的 unsharp mask),在补丁原尺寸上做,一张 ~357px 补丁几毫秒。
   *  顺手量嘴张开多少(同一份像素,不多读一次):嘴中间那几列里口腔暗区 + 牙齿的平均高度 / 补丁高,闭嘴 ≈ 0.01,大张 ≈ 0.035。 */
  _sharpen(ctx, w, h, amt) {
    if (!amt || w < 3 || h < 3) return { open: 0, gap: null };
    let img; try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return { open: 0, gap: null }; }
    const d = img.data, s = new Uint8ClampedArray(d), W4 = w * 4;
    const lum = i => 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
    const x0 = Math.round(w * 0.40), x1 = Math.round(w * 0.56), y0 = Math.round(h * 0.66), y1 = Math.round(h * 0.90);
    const ref = [];
    for (let y = Math.round(h * 0.62); y < h * 0.92; y += 3) for (let x = Math.round(w * 0.30); x < w * 0.66; x += 3) ref.push(lum(y * W4 + x * 4));
    ref.sort((a, b) => a - b);
    const med = ref[ref.length >> 1] || 128;
    let cnt = 0;
    const rows = new Float32Array(y1 - y0);
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * W4 + x0 * 4; x < x1; x++, i += 4) {
        const L = lum(i), mx = Math.max(s[i], s[i + 1], s[i + 2]), mn = Math.min(s[i], s[i + 1], s[i + 2]);
        if (L < 0.45 * med || (L > 0.9 * med && (mx - mn) < 0.18 * mx)) { cnt++; rows[y - y0]++; }   // 口腔暗区 / 牙齿(亮、不饱和)
      }
    }
    // 嘴缝 = 计数最多的那一行往上下扩,直到不足它的 30%(鼻孔 / 下巴阴影这些零星暗点不算进来)
    let core = 0; for (let r = 1; r < rows.length; r++) if (rows[r] > rows[core]) core = r;
    let top = core, bot = core; const lim = rows[core] * 0.3;
    while (top > 0 && rows[top - 1] >= lim) top--;
    while (bot < rows.length - 1 && rows[bot + 1] >= lim) bot++;    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, i = y * W4 + 4; x < w - 1; x++, i += 4) {
        for (let k = i; k < i + 3; k++) d[k] = s[k] + amt * (4 * s[k] - s[k - 4] - s[k + 4] - s[k - W4] - s[k + W4]) * 0.25;
      }
    }
    ctx.putImageData(img, 0, 0);
    const n = cnt / Math.max(1, x1 - x0);
    return n >= 5 && rows[core] >= (x1 - x0) * 0.25 ? { open: n / h, gap: [(y0 + top) / h, (y0 + bot + 1) / h] }   // gap:嘴缝上下沿(补丁高的比例)
                                                      : { open: n / h, gap: null };
  }

  /** 下颌随嘴张开往下走 drop 像素:把"原片 + 刚贴上的嘴"这块(框高 0.66 → 1.32)按行重排 ——
   *  上唇不动(长在上颌上);拉伸只发生在嘴缝里(gap = 上沿 → 下沿 + drop),下唇 + 下巴整块跟着下颌平移 drop
   *  (10-19 v1 从唇下开始拉,下唇被拉厚;v2 以缝中心 ±0.023 拉,上唇也被拉厚);1.00 → 1.30(脖子)再收回 0。 */
  _jawWarp(ctx, v, vw, vh, W, H, t, sx, sy, sw, sh, fade, drop, gap) {
    const rx = Math.round(sx - sw * 0.04), rw = Math.round(sw * 1.08);
    const ry = Math.round(sy + sh * 0.66), rh = Math.round(sh * 0.66);
    if (rw < 8 || rh < 8) return;
    const J = this._jawA || (this._jawA = document.createElement('canvas'));
    const K = this._jawB || (this._jawB = document.createElement('canvas'));
    for (const cv of [J, K]) if (cv.width !== rw || cv.height !== rh) { cv.width = rw; cv.height = rh; }
    const jc = J.getContext('2d'), kc = K.getContext('2d');
    jc.globalCompositeOperation = 'source-over'; jc.clearRect(0, 0, rw, rh);
    try { jc.drawImage(v, rx * vw / W, ry * vh / H, rw * vw / W, rh * vh / H, 0, 0, rw, rh); } catch (e) { return; }
    jc.globalAlpha = fade; jc.drawImage(t, sx - rx, sy - ry); jc.globalAlpha = 1;
    const ss = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    const g0 = gap[0], g1 = gap[1] + drop / sh;
    const dy = y => {                                  // y:J 里的行 → 位移(像素)
      const u = (ry - sy + y) / sh;
      return drop * (u < 1.0 ? ss((u - g0) / (g1 - g0)) : 1 - ss((u - 1.0) / 0.30));
    };
    kc.globalCompositeOperation = 'source-over'; kc.clearRect(0, 0, rw, rh);
    const band = 2;
    for (let y = 0; y < rh; y += band) {
      const src = Math.max(0, Math.min(rh - band, y - dy(y + band / 2)));
      kc.drawImage(J, 0, src, rw, band, 0, y, rw, band);
    }
    if (!this._jawMask || this._jawMask.width !== rw || this._jawMask.height !== rh) {
      const m = this._jawMask = document.createElement('canvas'); m.width = rw; m.height = rh;
      const g = m.getContext('2d'), gr = g.createLinearGradient(0, 0, rw, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.16, 'rgba(0,0,0,1)'); gr.addColorStop(0.84, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, rw, rh);
    }
    kc.globalCompositeOperation = 'destination-in'; kc.drawImage(this._jawMask, 0, 0);
    ctx.drawImage(K, rx, ry);
  }

  /** 教程同款(LiveTalking wav2lip256 把整块生成的脸贴回去):模型生成的是裁剪框的下半张脸 —— 嘴、下颌、脸颊、下巴
   *  跟着话一起动(10-19 前只贴嘴唇一小块椭圆,下颌和脸颊是原片不动的,看着像"只动嘴皮子")。
   *  这里贴框高 0.50 以下的整块:0.50 → 0.60 淡入(眼睛、额头仍是原片的清晰像素),左右 2–10%、底部 94–100% 羽化,框边不露。 */
  _makeMouthMask(S) {
    const m = document.createElement('canvas'); m.width = m.height = S;
    const g = m.getContext('2d'), img = g.createImageData(S, S), d = img.data;
    const ss = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    for (let y = 0; y < S; y++) {
      const v = (y + 0.5) / S, ay = ss((v - 0.50) / 0.10) * (1 - ss((v - 0.94) / 0.06));
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, a = ay * ss((u - 0.02) / 0.08) * ss((1 - u - 0.02) / 0.08);
        d[(y * S + x) * 4 + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return m;
  }

  /** 一道从 a 到 b 的粒子流(指尖 → 字)。比 _emitTrail 密,带一点弧度。 */
  _emitStreak(a, b) {
    const now = performance.now();
    const n = 26;
    const mx = (a[0] + b[0]) / 2, my = Math.min(a[1], b[1]) - Math.abs(b[0] - a[0]) * 0.08;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // 二次贝塞尔,微微上拱
      const x = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * mx + t * t * b[0];
      const y = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * my + t * t * b[1];
      this._trailDots.push({ x: x + (Math.random() - 0.5) * 5, y: y + (Math.random() - 0.5) * 5,
        t0: now + t * 260, life: 800 + Math.random() * 500, size: 2.6 + Math.random() * 3.6 + (t > 0.9 ? 4 : 0) });
    }
  }

  /** her voice volume, 0–1 (settings: 她的音量) — the 数字人 stream's videos and the live clips' audio */
  _volume() { const v = +this.opts.volume; return isFinite(v) && v >= 0 ? Math.min(1, v) : 1; }
  _liveGain(L) {
    if (!L.gain) { L.gain = L.ac.createGain(); L.gain.connect(L.ac.destination); }
    L.gain.gain.value = this._volume();
    return L.gain;
  }

  setConfig(cfg) {
    const sig = () => [this.opts.idleSrc, this.opts.speakingSrc, this.opts.photoSrc,
                       (this.opts.clipUrls || []).join(','), this.opts.tint].join('|');
    const prev = sig();
    Object.assign(this.opts, cfg || {});
    const vol = this._volume();
    if (this._dh && this._dh.vs) for (const v of this._dh.vs) v.volume = vol;
    if (this._live && this._live.gain) this._live.gain.gain.value = vol;
    this.resize();
    if (prev !== sig()) this._buildCharacter();
    else {
      this._applyFeather();
      if (this._clipVideos) for (const v of this._clipVideos) v.style.transition = `opacity ${this._fadeMs()}ms ease-in-out`;
    }
  }

  /** 10-22: the app's mic helper is in duplex (her voice + the mic in one echo-cancelling engine): from the next reply on, her
   *  voice plays there — the reply's video plays muted and follows the helper's clock (opts.voiceCmd sends it commands) */
  setDuplex(on) { this._duplex = !!on && typeof this.opts.voiceCmd === 'function'; }

  /** the helper's clock for the reply it plays ({pos, turn}, ~10 a second): the video stays with the voice */
  onVoicePos(p) {
    const D = this._dh, S = D && D.s; if (!S || !S.duplex || !p || p.turn !== S.turn || !D.playing || S.held) return;
    S.gotPos = true;
    const v = S.v, heard = p.pos - 0.03;                 // what is heard now ≈ what the helper renders minus its output latency
    if (heard < 0) return;
    const drift = v.currentTime - heard;
    if (Math.abs(drift) > 0.25) { try { v.currentTime = heard; } catch (e) {} v.playbackRate = 1; }
    else v.playbackRate = Math.abs(drift) > 0.04 ? 1 - Math.max(-0.08, Math.min(0.08, drift)) : 1;
  }

  /** her engine is warm: show her now (a start() asked for while held happens here) */
  release() {
    if (!this._held) return;
    this._held = false;
    if (this._startWanted) { this._startWanted = false; this.start(); }
  }

  start() {
    if (this._held) { this._startWanted = true; return; }
    if (this._running) return;
    this._running = true;
    const cur = this._curClip ? this._curClip() : null;
    if (cur) cur.play().catch(() => {});
    else if (this._vidIdle) this._vidIdle.play().catch(() => {});
    // 第一帧真的解出来再淡入(不然淡入的是一个还没画面的框)
    const show = () => {
      this.root.style.opacity = '1';
      if (this._bleed) { this._drawBleed(); this._bleed.style.opacity = '1'; }
      if (this._grain) this._grain.style.opacity = String(this.opts.grain != null ? +this.opts.grain : 0.07);
    };
    const v = cur || this._vidIdle;
    if (v && v.requestVideoFrameCallback && v.readyState < 2) v.requestVideoFrameCallback(show);
    else requestAnimationFrame(show);
    setTimeout(show, 1500);
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._tick();
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    // 视频也停一下,别在后台白烧
    if (this._clipVideos) for (const v of this._clipVideos) { try { v.pause(); } catch (e) {} }
    if (this._vidIdle) try { this._vidIdle.pause(); } catch (e) {}
    if (this._vidSpeak) try { this._vidSpeak.pause(); } catch (e) {}
  }

  setPose(name) {
    if (!name || name === this._pose) return;
    this._pose = name;
    this._switchVideo();
  }
  setMouthOpen(v) { this._mouth = Math.max(0, Math.min(1, +v || 0)); }

  /** 伸手指向屏幕某点(agent 字出现的地方)。右手。 */
  pointTo(sx, sy, lifeMs = 2600) {
    this._armReach = { x: sx, y: sy, until: performance.now() + lifeMs, started: performance.now() };
    this._writePath = null;
    if (!this._playGestureClip('point') && this._clipVideos && this._clipVideos.length > 1) this._react();
    this.setPose('point');
    this._emitTrail(sx, sy, 'point');
  }

  /** 顺着一条屏幕路径划手 —— "画"字的那条动作。 */
  writePath(pts, durationMs = 1800) {
    if (!pts || !pts.length) return;
    this._writePath = { pts: pts.slice(), start: performance.now(), duration: durationMs };
    this._armReach = null;
    if (!this._playGestureClip('write') && this._clipVideos && this._clipVideos.length > 1) this._react();
    this.setPose('writing');
  }

  /** 其它动作:'wave' | 'think' | 'nod' | 'greet'。
   *  视频 / 照片角色不能真的动,所以这些动作在**粒子手 overlay** 上演 —— 一道柔光粒子
   *  从她胸口伸出来挥 / 想 / 点头,放在角色之上。和 Terse 其它粒子同一个语言。 */
  gesture(name, durationMs = 1600) {
    this._gesture = { name, start: performance.now(), duration: durationMs };
    // 先找这个角色有没有这个**真动作**的片段(wave_*.mp4 …);有就播它。
    // 没有就退一步:换到另一段 idle 姿势 + 粒子手 overlay 演方向。
    if (!this._playGestureClip(name) && this._clipVideos && this._clipVideos.length > 1) this._react();
    this.setPose(name === 'nod' ? 'idle' : 'speaking');
  }

  /* ── 内部 ────────────────────────────────────────────────────────────── */

  _buildCharacter() {
    // 清空
    this.root.innerHTML = '';
    this._vidIdle = this._vidSpeak = null;
    this._photoImg = null; this._aspect = null;
    /* 传进来的 idleSrc / speakingSrc / photoSrc 都已经是壁纸窗口能直接用的 URL
       (wallpaper.html 的 applyGirlfriendLayer 用 gf_read_asset → blob 转过一次)。
       这一层只负责画,不碰路径解析。 */
    this.disableLive();
    this._clipVideos = null; this._mouthCv = null; this._mouthCtx = null;
    this.root.style.webkitMaskImage = this.root.style.maskImage = '';
    const clipUrls = Array.isArray(this.opts.clipUrls) ? this.opts.clipUrls.filter(Boolean) : [];
    if (clipUrls.length >= 1) {
      /* **多姿态角色**(用户 10-17:"数字人真的做不同的动作 … 很顺很自然")。
         视频没有骨骼,不能摆姿势;能做的是同一个人的 N 段 clip 之间**交叉淡化**:
           · 只有当前那段在解码播放,其余暂停待命(以前 15 段同时 autoplay,白烧 15 个解码器)
           · 每段播到尾巴前 0.8s 自动淡到下一段 —— 不再在循环接缝处"跳一下",她一直在动
           · agent 事件来了就立刻淡到另一段(限频,见 _react),看起来是她在回应
           · 洗牌顺序、不连续重复同一段 */
      /* 只有一段的角色(Pixabay 那几位):同一段建两个 <video>,互相交叉淡化到
         **这段的不同时刻** —— 每次反应落在另一个表情 / 另一个角度,而不是从头循环。 */
      // still:实时模式只有 idle_live 一段 —— 一个 <video> 原生循环,永远不交叉淡化(淡化 = 两个她叠在一起,
      // 而且实时口型是按"这段片子现在第几帧"贴的,不能被换走)
      this._single = clipUrls.length === 1 && !this.opts.still;
      const urls = this._single ? [clipUrls[0], clipUrls[0]] : clipUrls;
      const tags = Array.isArray(this.opts.clipTags) ? this.opts.clipTags : [];
      this._clipTags = this._single ? [tags[0] || 'idle', tags[0] || 'idle'] : urls.map((_, i) => tags[i] || 'idle');
      const names = Array.isArray(this.opts.clipNames) ? this.opts.clipNames : [];
      this._clipNames = this._single ? [names[0] || '', names[0] || ''] : urls.map((_, i) => names[i] || '');
      const metas = Array.isArray(this.opts.clipMeta) ? this.opts.clipMeta : [];
      this._clipMetaArr = this._single ? [metas[0] || null, metas[0] || null] : urls.map((_, i) => metas[i] || null);
      this._clipVideos = urls.map((u, i) => {
        const v = this._mkVideo(u, false);
        /* 脸部对齐:生成模型每段的取景会漂一点(有的近一点、有的偏一点),
           manifest 里每段一个 [s, tx, ty] —— 把这段的脸挪到和 clip_1 同一个位置、同样大小,
           淡化 / 切换的时候她就不会跳一下或者"两个人"叠在一起。 */
        const al = this._clipMetaArr[i] && this._clipMetaArr[i].align;
        if (Array.isArray(al) && al.length === 3) {
          v.style.transformOrigin = '0 0';
          v.style.transform = `translate(${(al[1] * 100).toFixed(2)}%, ${(al[2] * 100).toFixed(2)}%) scale(${al[0]})`;
        }
        v.style.opacity = i === 0 ? '1' : '0';
        v.style.transition = `opacity ${this._fadeMs()}ms ease-in-out`;
        if (i !== 0) { try { v.pause(); } catch (e) {} }
        v.addEventListener('timeupdate', () => this._onClipTime(v));
        v.addEventListener('ended', () => this._onClipEnded(v));
        v.addEventListener('error', () => this._clipError(v));
        this.root.appendChild(v);
        return v;
      });
      // 起手一定是 idle 段(不能一开机就在挥手)
      const first = this._idlePool()[0] || 0;
      if (first !== 0) {
        this._clipVideos[0].style.opacity = '0'; try { this._clipVideos[0].pause(); } catch (e) {}
        this._clipVideos[first].style.opacity = '1'; this._clipVideos[first].play().catch(() => {});
      }
      this._clipIndex = first;
      this._fading = false;
      this._lastReact = 0;
      this._vidIdle = this._clipVideos[first];
      // 只有一段 idle(实时模式的往返循环 idle_live):它自己原生循环,播放列表永远不需要"切走再切回"
      const idles = this._idlePool();
      if (idles.length === 1 && !this._single) this._clipVideos[idles[0]].loop = true;
      // 实时口型:模型生成的嘴画在这块 canvas 上,它在 root 里面 —— 跟着呼吸摆动和每段的脸部对齐一起动
      const mc = this._mouthCv = document.createElement('canvas');
      /* z-index 5(用户 10-20:"我没看到任何口型"):换片子时正在播的视频被设成 z-index 2 / 1,这块画布原来是 auto(第 0 层),
         嘴每一帧都画了,却被压在视频下面 —— 必须永远在所有片子之上 */
      mc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transform-origin:0 0;z-index:5';
      this.root.appendChild(mc);
      this._mouthCtx = mc.getContext('2d');
      this._applyFeather();
      if (this.opts.fullFrame) {
        // gf-full:壁纸被抬到图标 / 窗口之上时(置顶、调整模式、小镇接文件)wallpaper.html 把这几层整块藏掉 ——
        // 她是不透明的整幅画面,抬上去就会盖住桌面文件和图标(用户 10-18:"不要覆盖看不到那些文件和图标")
        this.root.classList.add('gf-full');
        if (!this._bleed) {
          const b = this._bleed = document.createElement('canvas');
          b.className = 'gf-full';
          b.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:${this.opts.zIndex | 0};` +
            'opacity:0;transition:opacity .7s ease';
          this.host.insertBefore(b, this.root);
        }
        this._bleedCol = null; this._drawBleed();
        /* 胶片颗粒(教程底图提示词:「柔和胶片颗粒,低对比暗调」):一层很淡的动态噪点盖在她和背景上 ——
           片子、左边接出来的背景、实时生成的嘴三者的质感统一成一台摄像机拍的,编码色块和嘴部贴片的边也被吃掉。
           4 张预先生成的噪点图轮换,只换 background-image,全在合成器里做,几乎不花 CPU。 */
        if (!this._grain) {
          const tiles = [];
          for (let t = 0; t < 4; t++) {
            const c = document.createElement('canvas'); c.width = c.height = 160;
            const x = c.getContext('2d'), im = x.createImageData(160, 160), d = im.data;
            for (let i = 0; i < d.length; i += 4) { const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 90; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
            x.putImageData(im, 0, 0); tiles.push(`url(${c.toDataURL()})`);
          }
          const gr = this._grain = document.createElement('div');
          gr.className = 'gf-full';
          gr.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${this.opts.zIndex | 0};` +
            'mix-blend-mode:overlay;opacity:0;transition:opacity .7s ease;background-size:160px 160px';
          gr.style.backgroundImage = tiles[0];
          this.root.after(gr);
          let k = 0;
          this._grainTimer = setInterval(() => { k = (k + 1) % 4; gr.style.backgroundImage = tiles[k]; gr.style.backgroundPosition = `${(Math.random() * 160) | 0}px ${(Math.random() * 160) | 0}px`; }, 84);
        }
      } else {
        this.root.classList.remove('gf-full');
        if (this._bleed) { try { this._bleed.remove(); } catch (e) {} this._bleed = null; }
        if (this._grain) { clearInterval(this._grainTimer); try { this._grain.remove(); } catch (e) {} this._grain = null; }
      }
    } else if (this.opts.idleSrc) {
      // 用户只给了 idle(+ 可选 speaking)视频
      const idle = this._mkVideo(this.opts.idleSrc, true);
      this.root.appendChild(idle); this._vidIdle = idle;
      if (this.opts.speakingSrc) {
        const sp = this._mkVideo(this.opts.speakingSrc, false);
        sp.style.display = 'none';
        this.root.appendChild(sp); this._vidSpeak = sp;
      }
    } else if (this.opts.photoSrc) {
      // 用户塞了一张**静态照片**(真人 / AI 生成):把它当身体,SVG 嘴 overlay 做 lip-sync
      const img = document.createElement('img');
      img.src = this.opts.photoSrc;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;position:absolute;inset:0';
      img.draggable = false;
      this.root.appendChild(img);
      this._photoImg = img;
      // 一层仅嘴型 + 右手 overlay(SVG),放在照片之上
      const over = document.createElement('div');
      over.style.cssText = 'width:100%;height:100%;position:absolute;inset:0;pointer-events:none';
      over.innerHTML = photoOverlaySVG(this.opts.tint, this.opts.mouthX || 0.5, this.opts.mouthY || 0.72);
      this.root.appendChild(over);
      this._svg = over.querySelector('svg');
      this._svgParts = {
        head: null, armL: null,
        armR: this._svg.querySelector('#gf-arm-right'),
        hand: this._svg.querySelector('#gf-hand-right'),
        eyeL: null, eyeR: null,
        mouth: this._svg.querySelector('#gf-mouth'),
        body: null,
      };
    } else {
      // 中性占位 —— 用户还没塞自己的素材的时候显示
      const d = document.createElement('div');
      d.style.cssText = 'width:100%;height:100%';
      d.innerHTML = defaultPlaceholderSVG(this.opts.tint);
      this.root.appendChild(d);
      this._svg = d.querySelector('svg');
      this._svgParts = {
        head: this._svg.querySelector('#gf-head'),
        armL: this._svg.querySelector('#gf-arm-left'),
        armR: this._svg.querySelector('#gf-arm-right'),
        hand: this._svg.querySelector('#gf-hand-right'),
        eyeL: this._svg.querySelector('#gf-eye-l'),
        eyeR: this._svg.querySelector('#gf-eye-r'),
        mouth: this._svg.querySelector('#gf-mouth'),
        body: this._svg.querySelector('#gf-body'),
      };
    }
  }

  _mkVideo(src, loop) {
    const v = document.createElement('video');
    v.src = src; v.loop = !!loop; v.muted = true;
    v.playsInline = true; v.preload = 'auto';
    const s = v.style;
    s.width = '100%'; s.height = '100%';
    s.objectFit = 'contain';         // 不裁:框的比例会跟着片子走(见 resize),整个半身都在
    s.position = 'absolute'; s.inset = '0';
    // 拿到片子的真实宽高比后,框改成同样比例 —— 不再把半身像塞进窄框裁成一张脸
    v.addEventListener('loadedmetadata', () => {
      if (v.videoWidth > 0 && v.videoHeight > 0 && !this._aspect) {
        this._aspect = v.videoWidth / v.videoHeight;
        this.resize();
      }
    });
    v.play().catch(() => {});
    return v;
  }

  _fadeMs() { return Math.max(200, Math.min(2000, +this.opts.fadeMs || 750)); }

  /** 边缘羽化:只软化四条边,身体完整保留(用户 10-17:"不要只有一个头,至少半身")。
      上一版是椭圆遮罩,把半身像裁成了一张脸。现在是两条线性渐变取交集:
      上 / 左 / 右轻轻淡,**底部淡得最多** —— 腰以下融进壁纸,不是被一刀切掉。 */
  _applyFeather() {
    const f = this.opts.feather == null ? 0.6 : Math.max(0, Math.min(1, +this.opts.feather));
    const st = this.root.style;
    if (this.opts.fullFrame && this.opts.fit === 'cover') { st.webkitMaskImage = st.maskImage = ''; return; }   // 铺满屏幕:没有边要化
    if (this.opts.fullFrame) {
      // 整幅原片:只有左缘要化进 _bleed(同一个背景色),上 / 右 / 下都在屏幕外,不淡
      const m = 'linear-gradient(to right, transparent 0%, #000 6%, #000 100%)';
      st.webkitMaskImage = st.maskImage = m; st.webkitMaskComposite = st.maskComposite = '';
      return;
    }
    if (f <= 0.01) { st.webkitMaskImage = st.maskImage = ''; return; }
    // 抠过像的片子(带透明通道):背景已经没了,只需要把被画框切断的腰部往下淡掉
    const alpha = !!this.opts.alpha;
    const top = alpha ? 0 : Math.round(f * 12), side = alpha ? 0 : Math.round(f * 16), bottom = Math.round(f * (alpha ? 26 : 34));
    /* 框比屏幕高(按脸放大后,下半截在屏幕外):淡出要落在**屏幕下沿**,不是框的下沿 ——
       否则她在屏幕底边被硬切一刀。end = 屏幕下沿在框里的百分比。 */
    const H = this._H || window.innerHeight, boxTop = parseFloat(this.root.style.top) || 0, boxH = this._boxH || H;
    const end = Math.max(30, Math.min(100, ((H - boxTop) / boxH) * 100));
    const fade = alpha ? Math.min(end - 10, f * 18 * end / 100) : bottom;   // 羽化 0.6 → 屏幕高的 ~11%
    const v = alpha
      ? `linear-gradient(to bottom, #000 0%, #000 ${(end - fade).toFixed(1)}%, transparent ${end.toFixed(1)}%, transparent 100%)`
      : `linear-gradient(to bottom, transparent 0%, #000 ${top}%, #000 ${100 - bottom}%, transparent 100%)`;
    const h = `linear-gradient(to right, transparent 0%, #000 ${side}%, #000 ${100 - side}%, transparent 100%)`;
    st.webkitMaskImage = `${v}, ${h}`; st.maskImage = `${v}, ${h}`;
    st.webkitMaskComposite = 'source-in'; st.maskComposite = 'intersect';
  }

  _curClip() { return this._clipVideos ? this._clipVideos[this._clipIndex] : null; }

  /** 下一段从哪儿开始播。单段角色:随机落在片子里任何一处(留够淡化 + 2s 的尾巴);
      多段角色:前 30% 里随机一点,同一段再出场时也不会每次都是同一帧起手。 */
  _startOffset(v) {
    const d = v && v.duration;
    if (!(d > 0)) return 0;
    const tail = this._fadeMs() / 1000 + 2.0;
    if (this._single) return Math.random() * Math.max(0, d - tail);
    return Math.random() * Math.min(1.5, Math.max(0, d * 0.3), Math.max(0, d - tail));
  }

  /** idle 池:没有动作标签的那些段。自动播放列表只在这里面转,不会自己跑去挥手。 */
  _idlePool() {
    const n = this._clipVideos ? this._clipVideos.length : 0;
    const tags = this._clipTags || [];
    const pool = [...Array(n).keys()].filter(k => (tags[k] || 'idle') === 'idle');
    return pool.length ? pool : [...Array(n).keys()];
  }

  /** 说话期间一直停在 talk 段(TTS 可能比一段 4s 的片子长);说完放开,回 idle 池。 */
  setSpeaking(on) { this._setHold('talk', on); }
  /** 用户按住麦克风说话时,她停在 listen 段(侧耳倾听);松手放开。 */
  setListening(on) {
    if (on && this.opts.still && this._live) this._listenNod();
    this._setHold('listen', on);
  }

  /** you start talking: she nods twice, listening (a nod_* / listen_* clip sealed onto the calm seed), at most every ~20 s,
      never while she talks or gestures */
  _listenNod() {
    const now = performance.now();
    if (now - (this._lastNodAt || -1e9) < 20000) return;
    if (this._pathActive || this._pathArm || this._dhBusy()) return;
    const pool = this._livePaths(['nod', 'listen']);
    if (!pool.length) return;
    this._lastNodAt = now;
    const pick = pool[(Math.random() * pool.length) | 0];
    this._armPath({ kind: 'gesture', life: true, path: pick, impact: 1e9, released: false, requested: true, t0: now });
  }

  _setHold(tag, on) {
    const had = this._holdTag;
    if (on) this._holdTag = tag; else if (had === tag) this._holdTag = null; else return;
    // 实时模式:片段只由动作图 / 情绪底片的路径来换(talk_* 是情绪底片,不是"说话时循环的那段")
    if (this.opts.still && this._live) return;
    // hold 段期间循环(只有一段时不会冻在最后一帧),放开就不再循环
    if (this._clipVideos && this._clipTags) {
      this._clipVideos.forEach((v, k) => { if (this._clipTags[k] === tag) v.loop = !!on; });
    }
    /* 她正在演一个真动作(回答里挑的 [point] / [wave]…,或者正淡进去 / 排着队):别打断 ——
       有 hold 时动作结尾不走 exit,_pickNext 直接接 hold 段,动作演完自然转成说话。 */
    const k = this._fading && this._fadingTo != null ? this._fadingTo : this._clipIndex;
    const curTag = this._clipTags && this._clipTags[k];
    const busy = (curTag && !['idle', 'talk', 'listen'].includes(curTag))
      || this._pendingGestureIdx != null || !!this._pendingGesture;
    if (on && had !== tag && !busy) this.gesture(tag === 'talk' ? 'speaking' : tag, 1200);
    // 放开时还停在 hold 段 → 立刻淡回 idle,不用等这段播完
    if (!on && curTag === tag) {
      if (this._fading) this._pendingReact = true; else this._crossfadeTo(this._pickNext());
    }
  }

  /** 洗牌发下一段 idle,不连续重复。说话中且有 talk 段 → 只在 talk 段里转。 */
  _pickNext() {
    const n = this._clipVideos ? this._clipVideos.length : 0;
    if (n < 2) return this._clipIndex || 0;
    if (this._holdTag && this._clipTags) {
      const hold = [...Array(n).keys()].filter(k => this._clipTags[k] === this._holdTag);
      if (hold.length) {
        const others = hold.filter(k => k !== this._clipIndex);
        return others.length ? others[(Math.random() * others.length) | 0] : hold[0];
      }
    }
    const pool = this._idlePool().filter(k => k !== this._clipIndex);
    if (!pool.length) return this._clipIndex;
    const sig = pool.join(',');
    if (!this._bag || !this._bag.length || this._bagSig !== sig) {
      this._bag = pool.slice(); this._bagSig = sig;
      for (let i = this._bag.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [this._bag[i], this._bag[j]] = [this._bag[j], this._bag[i]]; }
    }
    let k = this._bag.pop();
    if (k === this._clipIndex && this._bag.length) k = this._bag.pop();
    return k;
  }

  /** agent 事件名 → 角色目录里的动作片段标签。 */
  _tagFor(name) {
    return ({ wave: 'wave', greet: 'wave', point: 'point', writing: 'write', write: 'write',
              think: 'think', nod: 'nod', speaking: 'talk', speak: 'talk', listen: 'listen' })[name] || null;
  }

  /** 这个角色有这个真动作的片段吗?有就淡过去播一遍(播完自动淡回 idle 池),返回 true。 */
  _playGestureClip(name) {
    if (this.opts.still) return false;          // 实时模式:动作只走导演的动作图路径
    const tag = this._tagFor(name);
    if (!tag || !this._clipVideos || !this._clipTags) return false;
    const idx = [];
    this._clipTags.forEach((t, k) => { if (t === tag && k !== this._clipIndex) idx.push(k); });
    if (!idx.length) return false;
    const k = idx[(Math.random() * idx.length) | 0];
    if (this._seamless()) { this._queuedCut = k; this._lastReact = performance.now(); return true; }
    if (this._fading) { this._pendingGesture = name; return true; }
    this._gestureClip = true;
    this._pendingReact = false;
    this._lastReact = performance.now();
    this._crossfadeTo(k, /*fromStart*/ true);
    return true;
  }

  /** 播到尾巴之前就开始淡到下一段 —— 消灭循环接缝那一下"跳"。 */
  _onClipEnded(v) {
    if (this.opts.still) return;
    if (v !== this._curClip()) return;
    if (this._seamless()) {
      // 交界那一帧:有排队的动作就切进动作,否则切下一段 idle(两边都是同一帧,看不出切)
      const k = this._queuedCut != null ? this._queuedCut : this._pickNext();
      this._queuedCut = null;
      this._cutTo(k);
      return;
    }
    this._advance();
  }

  _onClipTime(v) {
    if (this.opts.still) return;
    if (this._seamless()) return;       // 无缝模式只在段尾切,不提前淡
    if (v !== this._curClip() || this._fading || !this._clipVideos || this._clipVideos.length < 2) return;
    const d = v.duration;
    if (!(d > 0)) return;
    if (d - v.currentTime < this._fadeMs() / 1000 + 0.05) this._advance();
  }

  /** 这一段快播完了:动作片段 → 回到 manifest 里配好的那一帧 idle(动作匹配,最像动作结尾的那一帧);
      idle → 洗牌下一段。 */
  _advance() {
    const meta = this._clipMetaArr && this._clipMetaArr[this._clipIndex];
    const ex = meta && meta.exit;
    if (ex && ex.to && !this._holdTag) {
      const k = (this._clipNames || []).indexOf(ex.to);
      if (k >= 0 && k !== this._clipIndex) { this._crossfadeTo(k, false, null, +ex.t || 0); return; }
    }
    this._crossfadeTo(this._pickNext());
  }

  /** 交叉淡化到第 i 段。等新的那段真的出了第一帧才开始淡,不会闪黑。 */
  _crossfadeTo(i, fromStart, msOverride, startAt) {
    const vids = this._clipVideos;
    if (!vids || vids.length < 2) return;
    const n = vids.length;
    i = ((i % n) + n) % n;
    if (i === this._clipIndex || this._fading) return;
    const cur = vids[this._clipIndex], next = vids[i];
    this._fading = true; this._fadingTo = i;
    const ms = msOverride || this._fadeMs();
    /* 每次淡化一个编号。旧淡化的兜底定时器 / 收尾定时器晚到时一律作废 —— 以前它们会在新的淡化
       进行中再跑一遍旧的换段,把**当前**这段 pause 掉,她就定格在一帧上(10-17 harness 实测)。 */
    const gen = this._fadeGen = (this._fadeGen || 0) + 1;
    let begun = false;
    this._fadeEndsAt = performance.now() + ms + 1200;      // 先按最坏情况估,真开始淡时改准
    cur.style.transition = next.style.transition = `opacity ${ms}ms ease-in-out`;
    // 真动作片段从头播(挥手要看到完整一下);idle 段随机起点,不每次同一帧
    try { next.currentTime = startAt != null ? startAt : (fromStart ? 0 : this._startOffset(next)); } catch (e) {}
    const begin = () => {
      if (begun || gen !== this._fadeGen) return;
      begun = true;
      // 新的在上面淡入,旧的同时淡出
      next.style.zIndex = '2'; cur.style.zIndex = '1';
      next.style.opacity = '1'; cur.style.opacity = '0';
      this._clipIndex = i;
      this._fadeEndsAt = performance.now() + ms;
      setTimeout(() => {
        if (gen !== this._fadeGen) return;
        if (cur !== vids[this._clipIndex]) { try { cur.pause(); } catch (e) {} }
        this._fading = false;
        // 淡化途中来的反应 / 动作不丢:淡完立刻补上(导演指定的那一段最优先)
        if (this._pendingGestureIdx != null) {
          const k = this._pendingGestureIdx, f = this._pendingGestureFade;
          this._pendingGestureIdx = null; this._pendingGestureFade = null;
          this._crossfadeTo(k, true, f);
        }
        else if (this._pendingGesture) { const g = this._pendingGesture; this._pendingGesture = null; if (!this._playGestureClip(g)) this._react(); }
        else if (this._pendingReact) { this._pendingReact = false; this._react(); }
      }, ms + 30);
    };
    const p = next.play();
    if (next.requestVideoFrameCallback) {
      next.requestVideoFrameCallback(() => begin());
    } else if (p && p.then) {
      p.then(() => requestAnimationFrame(begin)).catch(() => { if (gen === this._fadeGen) this._fading = false; });
    } else begin();
    // 兜底:解码卡住 1.2s 也照样淡过去,不让状态卡死(只兜**这一次**淡化)
    setTimeout(() => { if (!begun && gen === this._fadeGen) begin(); }, 1200);
  }

  /** agent 事件 → 立刻换一段(限频:1.8s 内只换一次,事件扎堆时不会疯狂闪)。 */
  _react() {
    if (this.opts.still) return;
    if (!this._clipVideos || this._clipVideos.length < 2) return;
    // 正在演一个真动作(写 / 指 / 挥手…):让它演完,它自己会按 exit 回到 idle
    const tag = this._clipTags && this._clipTags[this._clipIndex];
    if (tag && !['idle', 'talk', 'listen'].includes(tag) && !this._fading) return;
    if (this._fading) { this._pendingReact = true; return; }
    const now = performance.now();
    if (now - (this._lastReact || 0) < 1800) return;
    this._lastReact = now;
    this._crossfadeTo(this._pickNext());
  }

  _switchVideo() {
    if (this._clipVideos && this._clipVideos.length) {
      // 多姿态:任何"在做事"的姿势都触发一次反应换段;回到 idle 不强制切(播放列表自己走)
      if (this._pose && this._pose !== 'idle') this._react();
      return;
    }
    if (!this._vidIdle) return;
    const speaking = this._pose && this._pose !== 'idle';
    if (this._vidSpeak) {
      this._vidSpeak.style.transition = this._vidIdle.style.transition = `opacity ${this._fadeMs()}ms ease-in-out`;
      this._vidSpeak.style.display = this._vidIdle.style.display = '';
      this._vidSpeak.style.opacity = speaking ? '1' : '0';
      this._vidIdle.style.opacity  = speaking ? '0' : '1';
      if (speaking) { try { this._vidSpeak.currentTime = 0; this._vidSpeak.play(); } catch (e) {} }
    }
  }
  // 旧名字保留给内部调用点
  _cycleClip() { this._react(); }
  _showClip(i) { this._crossfadeTo(i); }

  /* ── 粒子手 overlay ──────────────────────────────────────────────────────
     一道柔光粒子臂,从她胸口 (_shoulder) 伸出 / 划 / 挥。所有视觉就是一堆软光点:
     沿着当前动作的手腕路径 spawn 粒子,每粒自己 fade。放在 mix-blend-mode:screen 的
     canvas 上,加性混合,和 agent 粒子字、壁纸粒子板一个语言。 */
  _emitTrail(hx, hy, kind) {
    if (this._clipVideos) return;      // 真人视频角色:不在她身上叠假的粒子手(只有 SVG 占位角色用)
    const now = performance.now();
    const sh = this._shoulder || { x: hx, y: hy };
    // 沿着从肩到手的直线丢几颗粒子;头部密度高、尾巴稀
    const segs = kind === 'write' ? 14 : 10;
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const x = sh.x * (1 - t) + hx * t + (Math.random() - 0.5) * 6;
      const y = sh.y * (1 - t) + hy * t + (Math.random() - 0.5) * 6;
      const life = 700 + Math.random() * 500;                         // 拖尾停留久一点,"写"的笔画看得清
      const size = 3.4 + Math.random() * 5.0 + (t > 0.75 ? 3.5 : 0);  // 手腕处放大
      this._trailDots.push({ x, y, t0: now, life, size });
    }
  }

  _drawTrail(now) {
    const ctx = this.tctx;
    ctx.clearRect(0, 0, this._W, this._H);
    const alive = [];
    for (const d of this._trailDots) {
      if (now < d.t0) { alive.push(d); continue; }   // 错峰的粒子还没轮到
      const age = (now - d.t0) / d.life;
      if (age >= 1) continue;
      const a = (1 - age) * 0.9;
      const r = d.size * (0.6 + 0.4 * (1 - age));
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r * 3);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.4, `${hexA(this.opts.tint || '#b58df0', a * 0.75)}`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(d.x, d.y, r * 3, 0, Math.PI * 2); ctx.fill();
      alive.push(d);
    }
    this._trailDots = alive;
  }

  _tick() {
    const now = performance.now();
    const t = (now - this._t0) / 1000;
    // 看门狗:当前这段不在淡化中却停住了(解码卡顿 / 系统省电暂停 / 任何漏网的状态)→ 接着播,
    // 已经播完没被接走 → 往下走。她永远不该定格。
    if (this._clipVideos && !this._fading && now - (this._lastWatch || 0) > 500) {
      this._lastWatch = now;
      const v = this._curClip();
      if (this._live) this._pathRecover();
      if (v && this._running) {
        if (v.ended) this._onClipEnded(v);
        else if (v.paused) { try { v.play(); } catch (e) {} }
      }
    }
    // 1) 呼吸 + 轻微左右摆
    // 整幅原片(她带着自己的房间)不加:片子里她本来就在呼吸,再整体缩放会让墙和桌子跟着"呼吸",铺满时还会露边
    if (this.opts.fullFrame && this._clipVideos) {
      if (this.root.style.transform) this.root.style.transform = '';
    } else {
      const breath = Math.sin(t * 1.6) * 0.015;
      const sway = Math.sin(t * 0.55) * 1.6;    // deg
      this.root.style.transform = `translateX(${sway}px) scaleY(${1 + breath})`;
    }

    // 粒子手:writePath 每帧沿着当前路径位置丢几颗 → 看起来是手指在"写"
    if (this._writePath) {
      const u = (now - this._writePath.start) / this._writePath.duration;
      if (u >= 1) { this._writePath = null; if (this._pose === 'writing') this.setPose('idle'); }
      else {
        const n = this._writePath.pts.length;
        const i0 = Math.min(n - 1, Math.floor(u * (n - 1)));
        const i1 = Math.min(n - 1, i0 + 1);
        const tt = u * (n - 1) - i0;
        const p0 = this._writePath.pts[i0], p1 = this._writePath.pts[i1];
        this._emitTrail(p0.x * (1 - tt) + p1.x * tt, p0.y * (1 - tt) + p1.y * tt, 'write');
      }
    }
    // 其它手势:每帧按动作类型 spawn 一道粒子轨迹
    if (this._gesture) {
      const u = (now - this._gesture.start) / this._gesture.duration;
      if (u >= 1) { this._gesture = null; if (this._pose !== 'idle') this.setPose('idle'); }
      else if (this._shoulder) {
        const sh = this._shoulder;
        if (this._gesture.name === 'wave') {
          // 一只手左右摆
          const ang = Math.sin(u * Math.PI * 4) * 0.9;        // 弧度
          const r = 90 * this.opts.scale;
          this._emitTrail(sh.x + Math.cos(-Math.PI/2 + ang) * r, sh.y + Math.sin(-Math.PI/2 + ang) * r, 'wave');
        } else if (this._gesture.name === 'think') {
          // 一只手举到下巴 —— 一个固定点,小幅颤动
          const chin = { x: sh.x + 50 * this.opts.scale, y: sh.y - 100 * this.opts.scale };
          this._emitTrail(chin.x + Math.sin(u * 20) * 3, chin.y + Math.cos(u * 23) * 3, 'think');
        } else if (this._gesture.name === 'nod') {
          // 身子微微上下点一下(整个 root 做轻微 Y 位移)
          this.root.style.transform = `translateY(${Math.sin(u * Math.PI * 2) * 6}px)`;
        } else if (this._gesture.name === 'greet' || this._gesture.name === 'speaking') {
          // 开口说话:手微举,配合说话
          const r = 60 * this.opts.scale;
          this._emitTrail(sh.x + r * 0.9, sh.y + r * 0.2 * Math.sin(u * 10), 'speak');
        }
      }
    }
    this._drawTrail(now);

    if (this._svgParts) {
      // 2) 眨眼(每 3-6s 一下,100ms 完成)
      if (now - this._eyeBlinkT > 3200 + Math.random() * 2800) {
        this._eyeBlinkT = now;
      }
      const dt = now - this._eyeBlinkT;
      const closed = dt < 160 ? Math.min(1, dt < 80 ? dt / 80 : (160 - dt) / 80) : 0;
      const open = 1 - closed;
      for (const e of [this._svgParts.eyeL, this._svgParts.eyeR]) {
        if (e) e.setAttribute('transform', `scale(1 ${0.1 + 0.9 * open})`);
      }
      // 3) 嘴型(amplitude 驱动)
      if (this._svgParts.mouth) {
        const mo = 0.6 + this._mouth * 3.2;
        this._svgParts.mouth.setAttribute('transform', `scale(1 ${mo})`);
      }
      // 4) 右手动作:reach / write / idle
      this._updateArm(now);
    } else if (this._vidIdle) {
      // 视频版:暂没有分离手,只做身体呼吸(scaleY 已经在 root 上做了)
    }
  }

  _updateArm(now) {
    const armR = this._svgParts.armR;
    if (!armR) return;
    // 目标屏幕点
    let targetScreen = null;
    if (this._writePath) {
      const u = (now - this._writePath.start) / this._writePath.duration;
      if (u >= 1) { this._writePath = null; this.setPose('idle'); }
      else {
        const n = this._writePath.pts.length;
        const i0 = Math.min(n - 1, Math.floor(u * (n - 1)));
        const i1 = Math.min(n - 1, i0 + 1);
        const tt = u * (n - 1) - i0;
        const p0 = this._writePath.pts[i0], p1 = this._writePath.pts[i1];
        targetScreen = { x: p0.x * (1 - tt) + p1.x * tt, y: p0.y * (1 - tt) + p1.y * tt };
      }
    } else if (this._armReach) {
      const dur = 2600;
      const u = Math.min(1, (now - this._armReach.started) / 400);
      targetScreen = { x: this._armReach.x, y: this._armReach.y };
      // 到期后回收
      if (now > this._armReach.until) this._armReach = null;
      // 简单 easeOut 用来算到位度(没显式用 u,但保留以后插值)
      void u;
    }
    if (!targetScreen) {
      // 回到自然位置
      armR.setAttribute('transform', 'rotate(0)');
      if (this._svgParts.hand) this._svgParts.hand.setAttribute('transform', 'rotate(0)');
      return;
    }
    // 把屏幕点换成"相对肩膀的局部角度"(肩膀在 SVG 的 85,285;整个 SVG 已经被缩放+摆位了)
    const rect = this.root.getBoundingClientRect();
    const scale = this.opts.scale || 1;
    const sx = rect.left + 85 * scale, sy = rect.top + 285 * scale;
    const dx = targetScreen.x - sx, dy = targetScreen.y - sy;
    // 自然朝向(手垂下 90° = PI/2)。目标角度 = atan2;画出"伸出来"的位置
    const ang = Math.atan2(dy, dx);
    // 把目标角换成相对自然位的旋转度:SVG 里 arm 自然朝向约 90°(往下)
    const deg = (ang * 180 / Math.PI) - 90;
    const clamped = Math.max(-85, Math.min(85, deg));
    armR.setAttribute('transform', `rotate(${clamped})`);
    // 手指再对一下目标朝向(以手腕为枢纽)
    if (this._svgParts.hand) {
      this._svgParts.hand.setAttribute('transform', `rotate(${clamped * 0.4})`);
    }
  }
}
