/**
 * room-travel.js — 从一座楼走到另一座:穿过门框去隔壁那座楼,走进传送门去广场上随便哪个项目。
 *
 * 为什么不是"门里就能看见下一间":那要两间屋子同时建好、同时画。一间屋子在桌面上建
 * 0.3 秒、第一帧再 0.5–1 秒,几百万颗点;iPhone 慢好几倍,门口一站就卡。所以换成
 * 另一种手法 —— 看不见的换场:
 *
 *   0      穿过门框:这间屋子的粒子往四处散开(和进门时的聚拢反着走),一层带着那座楼
 *          颜色的光从中间亮起来;传送门再加一下视角拉宽
 *   ~0.45s 光铺满了屏幕:这时候才拆掉旧的、盖新的(卡的那一下藏在光里)
 *   之后   新屋子的粒子从四处聚拢,光退掉 —— 人站在通回来的那座门框前,背对着它,
 *          就像刚从门里走出来
 *
 * 数据是提前取的:一进门就把隔壁几座楼的深扫、下一个随机项目取好,穿门时不用等。
 * 系统开了"减少动态效果"的人:不散开、不拉宽,只是淡出淡入。
 *
 * 交回的东西和 createRoom 一样(update / render / resize / dispose / diag …),引擎分不出来。
 *
 * @param opts  createRoom 的那些,外加 travel:
 *   links(name)  → [{name, files, lang}]  这座楼隔壁有哪几座(同一个项目的别的顶层目录)
 *   load(name)   → Promise<dir>           那座楼(带深扫 detail)
 *   random()     → Promise<{title, style, lang, rgb?, dir, …}|null>  下一个随机项目的主楼
 *   arrived(info)  {kind:'link', name} | {kind:'portal', target}  —— 走到了
 */
import { createRoom } from './room-scene.js';
import { langRgb } from './lang-colors.js';
import { asLight } from './room-interior.js';

export function createWalk(renderer, dir, opts = {}) {
  const T = opts.travel || {};
  const base = Object.assign({}, opts);
  delete base.travel; delete base.arrive;
  const host = opts.host || document.body;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const veil = document.createElement('div');
  veil.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;z-index:6';
  host.appendChild(veil);

  let W = 0, H = 0, style = opts.style, cur = null, curDir = dir || {}, curLinks = [];
  let pre = new Map(), target = null, targetP = null, tr = null, dead = false;
  const rgbOf = (l) => asLight(langRgb((l && l.lang) || ''));
  const load = (name) => {
    if (!pre.has(name)) pre.set(name, Promise.resolve().then(() => (typeof T.load === 'function' ? T.load(name) : null)).catch(() => null));
    return pre.get(name);
  };
  /** 隔壁几座;走过来的那座一定在里面(通回去的门)。 */
  function linksFor(name, back) {
    let ls = ((typeof T.links === 'function' ? T.links(name) : null) || []).filter((l) => l && l.name && l.name !== name);
    if (back && !ls.some((l) => l.name === back.name)) ls = [back].concat(ls);
    return ls.slice(0, 3);
  }
  function make(d, back, formIn) {
    curLinks = linksFor(d.name, back);
    const r = createRoom(renderer, d, Object.assign({}, base, {
      style, links: curLinks, arrive: back ? back.name : null, portal: typeof T.random === 'function', formIn,
      onLink: (l) => go('link', l), onPortal: () => go('portal'),
    }));
    if (W) r.resize(W, H);
    if (target) r.setPortal(target);
    for (const l of curLinks) load(l.name);          // 隔壁几座楼的深扫先取着
    return r;
  }
  function pickNext() {
    if (typeof T.random !== 'function') return;
    target = null;
    targetP = Promise.resolve().then(() => T.random()).then((t) => {
      if (dead || !t || !t.dir) return null;
      if (!t.rgb) t.rgb = rgbOf(t);
      target = t;
      if (cur) cur.setPortal(t);
      return t;
    }).catch(() => null);
  }

  cur = make(curDir, opts.arrive ? { name: opts.arrive } : null);
  pickNext();

  function go(kind, link) {
    if (tr || dead) return;
    const dirP = kind === 'link' ? load(link.name) : (targetP || Promise.resolve(null)).then((t) => (t && t.dir) || null);
    const col = kind === 'link' ? rgbOf(link) : (target && target.rgb) || [0.78, 0.62, 1];
    tr = { kind, link, t: 0, phase: 'out', ready: undefined, tgt: kind === 'portal' ? target : null, fov0: cur.camera.fov };
    const me = tr;
    dirP.then((d) => { if (tr === me) me.ready = d || null; });
    cur.lock(true);
    cur.dissolve(true, kind === 'portal' ? 0.5 : 0.4);
    const c = col.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',');
    veil.style.background = reduce ? '#05060a'
      : `radial-gradient(circle at 50% 55%, rgba(255,255,255,.96) 0%, rgba(${c},.9) 38%, rgba(5,6,12,.97) 100%)`;
  }
  function cancel() {
    // 那座楼没取到(断网、仓库没了):光退掉,人还在原来的屋子里
    cur.dissolve(false); cur.lock(false);
    if (tr.kind === 'portal') { cur.camera.fov = tr.fov0; cur.camera.updateProjectionMatrix(); pickNext(); }
    tr.phase = 'in'; tr.t = 0;
  }
  function swap() {
    const d = tr.ready, kind = tr.kind;
    const back = { name: curDir.name, files: +curDir.files || 0, lang: curDir.lang || '' };
    try { cur.dispose(); } catch (e) { /* 旧的拆不干净也要往前走 */ }
    if (kind === 'portal') {
      style = (tr.tgt && tr.tgt.style) || style;
      pre = new Map();                                  // 另一个项目:目录名会重,缓存不能共用
      try { if (T.arrived) T.arrived({ kind: 'portal', target: tr.tgt }); } catch (e) {}
      curDir = d; cur = make(d, null, 1.3);
      pickNext();
    } else {
      curDir = d; cur = make(d, back, 1.1);
      try { if (T.arrived) T.arrived({ kind: 'link', name: d.name }); } catch (e) {}
    }
    tr.phase = 'in'; tr.t = 0;
  }

  const ease = (k) => k * k * (3 - 2 * k);
  function update(dt) {
    if (tr) {
      tr.t += dt || 0;
      if (tr.phase === 'out') {
        const D = reduce ? 0.2 : tr.kind === 'portal' ? 0.55 : 0.42, k = Math.min(1, tr.t / D);
        veil.style.opacity = String(ease(k));
        if (tr.kind === 'portal' && !reduce) { cur.camera.fov = tr.fov0 + 24 * k * k; cur.camera.updateProjectionMatrix(); }
        if (k >= 1 && tr.ready !== undefined) { if (tr.ready) swap(); else cancel(); }
        else if (tr.t > 12) cancel();
      } else {
        const k = Math.min(1, tr.t / (reduce ? 0.25 : 0.75));
        veil.style.opacity = String(1 - ease(k));
        if (k >= 1) { tr = null; veil.style.opacity = '0'; }
      }
    }
    cur.update(dt);
  }

  const api = {
    update,
    render() { cur.render(); },
    resize(w, h) { W = w; H = h; cur.resize(w, h); },
    dispose() {
      if (dead) return;
      dead = true;
      try { cur.dispose(); } catch (e) {}
      try { veil.remove(); } catch (e) {}
    },
    /** 正在换楼吗('link' / 'portal' / null)。 */
    traveling: () => (tr ? tr.kind : null),
    /** 调试、原型页:直接穿过第 i 座门框 / 走进传送门。 */
    goLink(i) { if (curLinks[i]) go('link', curLinks[i]); },
    goPortal() { go('portal'); },
    links: () => curLinks.slice(),
    portalTarget: () => target,
  };
  // 其余的(diag、hasLeaves、env、frames、at …)都是当前那间屋子的
  return new Proxy(api, {
    get(o, k) {
      if (k in o) return o[k];
      const v = cur ? cur[k] : undefined;
      return typeof v === 'function' ? v.bind(cur) : v;
    },
  });
}
