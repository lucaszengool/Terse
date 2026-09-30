/**
 * window-glass.js —— 主窗口变成「一块粒子板 + 浮在它前面的界面」。
 *
 * 和壁纸那一层(photo-particles.js)是**同一个类**:你桌面上那张图被采样成粒子,
 * 铺在窗口背后;现在这套 UI 变成一张半透明的卡片浮在它前面 —— Mineradio 的
 * 封面 + 歌词是同一个结构,只是这次前面那层是 Terse 的界面。
 *
 * ⚠ 默认**关着**。要两个条件同时成立才会开:
 *     ~/.terse/wallpaper.json 里 `enabled`(壁纸本身开着)+ `windowGlass`。
 *   后者默认 false —— 新装 Terse 的人第一次打开看到的还是原来那扇窗,
 *   一个像素都没变(用户 2026-09-28:「不要变化 SOP 对新用户的」)。
 *
 * 配套的还有 `windowDock`(窗口收到屏幕右边,鼠标一碰再出来),那一半在
 * Rust 的 main_dock.rs 里 —— hover 判断必须在原生那边做,非焦点窗口里的
 * WKWebView 收不到鼠标移动事件(会话栏踩过这个坑)。
 */

let layer = null;      // PhotoParticles 实例
let Klass = null;      // 动态 import 回来的类
let bed = null, card = null;

/** 这一条现在该开着吗 */
function wantOn(cfg) {
  if (!cfg) return false;
  return cfg.enabled !== false && cfg.windowGlass === true;
}

async function mount() {
  if (layer) return;
  if (!Klass) {
    // 动态 import:这一层加载失败只该少一层背景,不能把主界面拖下水。
    try { Klass = (await import('./photo-particles.js')).default; }
    catch (e) { console.warn('[glass] photo-particles 没加载起来', e); return; }
  }
  document.documentElement.classList.add('glass3d');
  if (!bed) {
    bed = document.createElement('div');
    bed.id = 'glassBed';
    document.body.insertBefore(bed, document.body.firstChild);
  }
  if (!card) {
    card = document.createElement('div');
    card.id = 'glassCard';
    // 卡片本身就是一块可以拖的地方 —— 边上那一圈粒子露出来的地方按下去就能挪窗口。
    card.setAttribute('data-tauri-drag-region', '');
    document.body.insertBefore(card, bed.nextSibling);
  }
  try {
    layer = new Klass(bed, {
      /* 窗口里这一块要**铺满**,不是浮在黑里的一块小板 —— 板就是窗口本身。
         fit:'cover' = 和桌面壁纸同一套裁法(铺满、超出的裁掉);用默认的 contain
         的话,16:9 的壁纸装进偏方的窗口会在上下留两条黑边。
         再稍微铺出边界一点(1.04):起伏会把边上的粒子往里挪,正好铺满会露黑边。 */
      fit: 'cover', fillWidth: 1.04, fillHeight: 1.04,
      drift: 0,          // 窗口是拿来用的,不是拿来看的:机位不飘
      relief: 0.6,       // 起伏收一半,免得界面背后一直在动
      cloud: 0.05, glint: 0.8,
      /* 窗口这一块也走"先原样、再化开"那一套(和桌面封面同一个手法),
         但节拍收短:窗口是拿来用的,开个 app 等两秒看动画会烦。 */
      hold: 0.35, dissolve: 0.8, morph: 0.9,
    });
    layer.start();
    layer.setActivity(0.35);
    window.__glassLayer = layer;   // dev aid:和壁纸页的 window.wp 同一个用处
  } catch (e) {
    console.warn('[glass] 建不起来', e);
    layer = null;
    document.documentElement.classList.remove('glass3d');
  }
}

function unmount() {
  document.documentElement.classList.remove('glass3d');
  if (layer) { try { layer.dispose(); } catch (e) {} layer = null; }
  if (card) { card.remove(); card = null; }
  if (bed) { bed.remove(); bed = null; }
}

async function apply(cfg) {
  if (wantOn(cfg)) await mount(); else unmount();
}

/** 换了桌面壁纸 / 改了配置都要跟着走。 */
export async function initWindowGlass() {
  const T = window.terse;
  let cfg = null;
  try { cfg = T && T.getWallpaperConfig ? await T.getWallpaperConfig() : null; } catch (e) {}
  await apply(cfg);
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('wallpaper-config', (ev) => { apply(ev.payload || {}); });
    }
  } catch (e) {}
  window.addEventListener('resize', () => { if (layer) layer.resize(); });
}

/* ⚠ 不能直接调 —— `window.terse` 是**后加载**的。
   index.html 里 tauri-bridge.js 走的是一条运行时的脚本链(先等 window.__TAURI__,
   再一个一个 append),而这个模块是 <script type="module">,加载完立刻就跑。
   两者相遇的结果:第一版在这里读 `terse.getWallpaperConfig` 时 T 还是 undefined,
   catch 吞掉,cfg=null → 什么都不做,而且**再也不会重试** ——
   开关明明存进了 wallpaper.json,界面上一点变化都没有(用户 2026-09-28 反馈的就是这个)。 */
(function waitForBridge(tries) {
  if (window.terse && window.terse.getWallpaperConfig) { initWindowGlass(); return; }
  if (tries > 400) return;                       // 20 秒还没有就算了,别无限轮询
  setTimeout(() => waitForBridge(tries + 1), 50);
})(0);
