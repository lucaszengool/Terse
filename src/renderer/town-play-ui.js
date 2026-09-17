/**
 * town-play-ui.js — 小镇里能玩的那些事,画面和按钮这一半。规则和账在 town-play.mjs / api/play.js。
 *
 *   左上角     ✦ 光点 · 等级 · 今天的差事 2/3 · 📖 护照 · 🧩 谜题
 *   集市告示牌 今天的三件差事、节日、七日宝箱、你家房子今天来了多少人
 *   每日谜题   猜今天是哪一栋房子(线索全是它真实的数据),猜中了给你指路,分享一行格子
 *   护城河、小河  🎣 钓 bug:抛竿、等浮标一沉、在窗口里收竿;图鉴按语言、时间、天气来
 *   代码卷轴   每天散在几栋房子门口,捡起来进法典(那栋房子改得最多的那个文件)
 *   门口       🔔 敲门(给这个项目点赞,奖励给房主)· 🌱 种一棵树 · 💧 浇水 · 🎨 装饰自己的房子
 *   护照       语言章、风格章、bug 图鉴、卷轴法典、头衔
 *
 * 研究里的几条规矩照着做:一次只弹一条提示;每天到顶就说"今天够了";断了不罚;
 * 排行榜和连胜不放在主界面。
 */
import * as THREE from 'three';
import { dailyQuests, levelOf, BUGS, bugsAvailable, riddleShare, langLabel, styleName, PASSPORT_GOALS, normLang, treeStage, COST, festivalOn, scrollsOf, dayIndex } from './town-play.mjs';

const TAU = Math.PI * 2;
const RARE_STARS = ['', '★', '★★', '★★★', '★★★★', '★★★★★'];
const LANGS20 = ['ts', 'js', 'python', 'rust', 'go', 'java', 'kotlin', 'swift', 'c++', 'c', 'c#', 'ruby', 'php', 'html', 'css', 'shell', 'sql', 'dart', 'lua', 'zig'];
const STYLES8 = ['tang', 'edo', 'giza', 'hellas', 'maya', 'persia', 'norse', 'modern'];
const DECOR = ['banner', 'lanterns', 'flowers', 'fireflies'];
const PALETTE = [[0.85, 0.2, 0.2], [0.95, 0.65, 0.15], [0.95, 0.9, 0.3], [0.3, 0.8, 0.4], [0.25, 0.6, 0.95], [0.6, 0.35, 0.9], [0.95, 0.5, 0.75], [0.95, 0.95, 0.95]];

const T = {
  en: {
    glim: 'Glim', board: 'Notice board', quests: "Today's errands", riddle: 'House riddle', passport: 'Passport', fish: 'Fish', reel: 'Reel in!',
    knock: 'Knock', plant: 'Plant a tree', water: 'Water', decorate: 'Decorate', close: 'Close', guess: 'Which house is it?', send: 'Guess',
    wrong: 'Not that one — another clue:', solved: 'You found it!', failed: 'Out of guesses. It was', share: 'Share', showWay: 'Show me the way',
    capped: "That's enough glim for today 🌙 — play on, it's just for fun now", chest: 'Open chest', chestHint: 'quest-days until the chest',
    festival: 'Festival', featured: 'Language of the week', digest: 'Your villas today', visits: 'visits', knocks: 'knocks', waters: 'waterings', plants: 'new trees',
    stamps: 'Stamps', bugs: 'Bugdex', codex: 'Codex', langs: 'Languages', styles: 'Styles', unknown: 'not caught yet', best: 'best',
    signin: 'Sign in to play', waiting: 'Waiting for a bite…', gotAway: 'It got away!', caught: 'Caught', newSp: 'New!', noWater: 'Walk to the moat or the stream to fish',
    scroll: 'Code scroll', planted: 'planted by', stage: ['Seedling', 'Sprout', 'Sapling', 'Young tree', 'Grown tree'], cost: 'cost', color: 'colour',
    welcome1: 'Every house here is someone’s real project.', welcome2: 'Check the notice board in the market for today’s errands.',
    knocked: 'You knocked — the owner gets a little glim.', done: 'done', solvedToday: 'Solved', left: 'left',
    decor: { banner: 'Banners', lanterns: 'Lantern string', flowers: 'Flower bed', fireflies: 'Fireflies' },
  },
  zh: {
    glim: '光点', board: '告示牌', quests: '今天的差事', riddle: '房子谜题', passport: '护照', fish: '钓鱼', reel: '收竿!',
    knock: '敲门', plant: '种一棵树', water: '浇水', decorate: '装饰', close: '关闭', guess: '是哪一栋?', send: '猜',
    wrong: '不是这栋 —— 再给一条线索:', solved: '找到了!', failed: '次数用完了,答案是', share: '分享', showWay: '给我指路',
    capped: '今天的光点够了 🌙 —— 接着玩,只是不再给了', chest: '打开宝箱', chestHint: '个做完差事的日子后开宝箱',
    festival: '节日', featured: '本周语言', digest: '你的房子今天', visits: '次来访', knocks: '次敲门', waters: '次浇水', plants: '棵新树',
    stamps: '印章', bugs: 'bug 图鉴', codex: '法典', langs: '语言', styles: '风格', unknown: '还没钓到', best: '最长',
    signin: '登录后才能玩', waiting: '等鱼咬钩…', gotAway: '跑了!', caught: '钓到了', newSp: '新!', noWater: '走到护城河或小河边才能钓',
    scroll: '代码卷轴', planted: '种树的人:', stage: ['种子', '嫩芽', '小树苗', '小树', '大树'], cost: '价格', color: '颜色',
    welcome1: '镇上的每一栋房子,都是某个人真实的项目。', welcome2: '去集市的告示牌看看今天的差事。',
    knocked: '你敲了门 —— 房主会收到一点光点。', done: '完成', solvedToday: '已解开', left: '剩',
    decor: { banner: '门口的旗', lanterns: '一串灯笼', flowers: '花坛', fireflies: '萤火虫' },
  },
};

const CSS = `
.tp-hud{position:absolute;left:10px;top:10px;z-index:6;display:flex;gap:6px;align-items:center;flex-wrap:wrap;max-width:calc(100% - 20px)}
.tp-pill{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(20,14,9,.72);border:1px solid rgba(255,214,150,.3);
  color:#fff1d8;font:650 12px/1.1 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);cursor:pointer}
.tp-pill .bar{width:46px;height:4px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden}
.tp-pill .bar i{display:block;height:100%;background:#e9b25a}
.tp-fest{background:rgba(120,40,90,.7);border-color:rgba(255,160,220,.45)}
.tp-ctx{position:absolute;left:50%;bottom:calc(182px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:5;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:92%}
.tp-ctx button{border:1px solid rgba(255,214,150,.45);background:rgba(40,26,14,.84);color:#fff6e4;border-radius:999px;padding:9px 14px;
  font:650 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4)}
.tp-ctx button.big{background:#e9b25a;color:#1c130a;font-size:16px;padding:12px 22px;animation:tpPulse .5s ease-in-out infinite alternate}
@keyframes tpPulse{to{transform:scale(1.08)}}
.tp-toast{position:absolute;left:50%;top:54px;transform:translateX(-50%);z-index:9;max-width:88%;padding:9px 14px;border-radius:14px;background:rgba(20,14,9,.88);
  border:1px solid rgba(255,214,150,.35);color:#fff1d8;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;pointer-events:none;
  transition:opacity .35s, transform .35s}
.tp-panel{position:absolute;left:10px;right:10px;bottom:calc(14px + env(safe-area-inset-bottom,0px));top:auto;max-height:72%;z-index:8;max-width:480px;margin:0 auto;
  display:flex;flex-direction:column;background:rgba(22,16,11,.94);border:1px solid rgba(255,214,150,.3);border-radius:18px;color:#f4ead8;
  font:500 14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 12px 44px rgba(0,0,0,.55);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.tp-panel header{display:flex;align-items:center;gap:8px;padding:12px 14px 6px}
.tp-panel header b{font-size:16px}
.tp-panel header button{margin-left:auto;background:none;border:0;color:#f4ead8;font-size:22px;cursor:pointer;opacity:.7}
.tp-panel .tabs{display:flex;gap:6px;padding:0 14px 6px}
.tp-panel .tabs button{border:1px solid rgba(255,214,150,.25);background:none;color:#f4ead8;border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer}
.tp-panel .tabs button.on{background:#e9b25a;color:#1c130a}
.tp-body{overflow-y:auto;padding:4px 14px 14px}
.tp-q{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.07)}
.tp-q .ck{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,214,150,.5);flex:none;display:flex;align-items:center;justify-content:center;font-size:13px}
.tp-q.done .ck{background:#7fbf5a;border-color:#7fbf5a;color:#10180c}
.tp-q small{display:block;opacity:.65;font-size:11px}
.tp-q .rw{margin-left:auto;color:#e9b25a;font-weight:700;white-space:nowrap}
.tp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px;margin:6px 0 10px}
.tp-cell{border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:7px 6px;text-align:center;font-size:11px;line-height:1.25;opacity:.45}
.tp-cell.on{opacity:1;border-color:rgba(233,178,90,.6);background:rgba(233,178,90,.1)}
.tp-cell i{display:block;font-style:normal;font-size:18px;margin-bottom:2px}
.tp-clue{padding:6px 10px;margin:5px 0;border-radius:10px;background:rgba(255,226,170,.08)}
.tp-row{display:flex;gap:6px;margin-top:8px}
.tp-row input{flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:999px;color:#fff;padding:9px 12px;font:500 15px/1.2 -apple-system,sans-serif;outline:0}
.tp-btn{border:0;border-radius:999px;background:#e9b25a;color:#1c130a;font-weight:700;padding:8px 14px;cursor:pointer;font-size:13px}
.tp-btn.ghost{background:none;color:#f4ead8;border:1px solid rgba(255,214,150,.35)}
.tp-sug{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.tp-sug button{border:1px solid rgba(255,214,150,.25);background:rgba(255,214,150,.06);color:#f4ead8;border-radius:999px;padding:4px 9px;font-size:12px;cursor:pointer}
.tp-card{text-align:center;padding:10px 0}
.tp-card .big{font-size:40px;line-height:1.1}
.tp-card b{display:block;font-size:17px;margin-top:4px}
.tp-sw{display:inline-block;width:22px;height:22px;border-radius:50%;margin:3px;border:2px solid transparent;cursor:pointer}
.tp-sw.on{border-color:#fff}
`;

const PLAY_VS = `
attribute vec3 aCol; attribute vec3 aInfo;   // 大小、种类(0 实心 1 飘着发光 2 光柱)、相位
uniform float uTime, uPx, uNight, uExposure;
uniform vec3 uSky, uSunCol, uSunDir;
varying vec3 vC; varying float vA; varying float vK;
void main(){
  vec3 p = position;
  float k = aInfo.y;
  if (k > 0.5 && k < 1.5) p.y += sin(uTime * 2.0 + aInfo.z * 6.28) * 0.12;
  if (k > 1.5) p.y += fract(uTime * 0.25 + aInfo.z) * 1.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  gl_PointSize = clamp(aInfo.x * uPx / max(d, 0.2), 1.0, k > 0.5 ? 40.0 : 16.0);
  if (k < 0.5) {
    vec3 lit = mix(uSky * 0.7 + uSunCol * 0.45 * max(uSunDir.y, 0.0), vec3(0.08, 0.09, 0.12), uNight);
    vec3 c = 1.0 - exp(-1.15 * aCol * lit * uExposure);
    vC = pow(max(c, 0.0), vec3(1.0 / 2.2));
    vA = 1.0;
  } else {
    vC = aCol * (0.7 + 0.3 * sin(uTime * 3.0 + aInfo.z * 20.0));
    vA = k > 1.5 ? 1.0 - fract(uTime * 0.25 + aInfo.z) : 1.0;
  }
  vK = k;
  gl_Position = projectionMatrix * mv;
}`;
const PLAY_FS = `
precision highp float;
varying vec3 vC; varying float vA; varying float vK;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  if (vK < 0.5) { gl_FragColor = vec4(vC, 1.0); return; }
  gl_FragColor = vec4(vC * exp(-r2 * 12.0) * vA, 1.0);
}`;

/**
 * @param ctx { scene, U, host, el, on, project, plan, built, people, lang, words, api, player(), env(), speak(f, text), guide(villaId) }
 *   api: { state(), event(ev), riddle(guess), cast(p), reel(p), scroll(id), plant(villa), water(id), decor(villa,item,value), chest(), knock(villa) }
 *        每个返回 Promise;没给 api 就整个关掉(原型页用本地的假账)
 */
export function createPlay(ctx) {
  const { scene, U, host, el, on, project, plan, built, people } = ctx;
  const api = ctx.api;
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const t = Object.assign({}, T[lang], (ctx.words && ctx.words.play) || {});
  const W = plan.world || null;
  if (!document.getElementById('town-play-css')) { const s = document.createElement('style'); s.id = 'town-play-css'; s.textContent = CSS; document.head.appendChild(s); }

  let S = null;              // 服务器给的状态
  let busy = false;
  const villaById = new Map(built.villas.map((v) => [String(v.id), v]));
  const folkById = new Map(people.folk.map((f) => [f.id, f]));
  const houseOf = (id) => { const f = folkById.get(String(id)); return f ? { id: f.id, title: f.facts.title, lang: f.facts.lang, style: villaById.get(f.id) ? villaById.get(f.id).style : '', trade: f.persona.trade } : null; };

  /* ── HUD ── */
  const hud = el('div', 'tp-hud');
  const pGlim = el('div', 'tp-pill', hud);
  const pQuest = el('div', 'tp-pill', hud);
  const pPass = el('div', 'tp-pill', hud);
  const pRiddle = el('div', 'tp-pill', hud);
  const pFest = el('div', 'tp-pill tp-fest', hud);
  pFest.style.display = 'none';
  pPass.textContent = '📖 ' + t.passport;
  on(pGlim, 'click', (e) => { e.stopPropagation(); openPassport('stamps'); });
  on(pQuest, 'click', (e) => { e.stopPropagation(); openBoard(); });
  on(pPass, 'click', (e) => { e.stopPropagation(); openPassport('stamps'); });
  on(pRiddle, 'click', (e) => { e.stopPropagation(); openRiddle(); });
  on(pFest, 'click', (e) => { e.stopPropagation(); openBoard(); });
  const ctxRow = el('div', 'tp-ctx');
  const toastEl = el('div', 'tp-toast');
  toastEl.style.opacity = '0';
  const toasts = [];
  let toastT = 0;
  function toast(msg, secs = 3.2) { if (msg) toasts.push({ msg, secs }); }

  function renderHud() {
    if (!S) { pGlim.textContent = '✦ —'; pQuest.textContent = '📜 ' + t.board; pRiddle.textContent = '🧩 ' + t.riddle; return; }
    const P = S.profile;
    if (P) {
      const lv = P.level || levelOf(P.xp);
      pGlim.innerHTML = '';
      pGlim.append('✦ ' + P.glim + '  ·  Lv' + lv.level + ' ' + (lang === 'zh' ? lv.title.zh : lv.title.en));
      const bar = document.createElement('span'); bar.className = 'bar';
      const fill = document.createElement('i'); fill.style.width = (lv.need ? Math.round(100 * lv.into / lv.need) : 100) + '%';
      bar.appendChild(fill); pGlim.appendChild(bar);
    } else pGlim.textContent = '✦ ' + t.signin;
    const qs = S.quests || [];
    pQuest.textContent = '📜 ' + qs.filter((q) => q.done).length + '/' + qs.length + (P && P.chestReady ? ' 🎁' : '');
    const R = S.riddle || {};
    pRiddle.textContent = '🧩 ' + (R.solved ? '✓' : R.failed ? '✗' : (R.max || 6) - (R.guesses || 0) + ' ' + t.left);
    const F = S.festival;
    pFest.style.display = F ? 'flex' : 'none';
    if (F) pFest.textContent = '🎪 ' + (lang === 'zh' ? F.zh : F.en) + ' · ' + langLabel(F.lang);
  }
  function applyState(st) {
    if (!st || !st.ok) return;
    const prev = S;
    S = Object.assign({}, S || {}, st);
    if (prev && prev.profile && S.profile && S.profile.level && prev.profile.level && S.profile.level.level > prev.profile.level.level) {
      toast('⬆ Lv' + S.profile.level.level + ' · ' + (lang === 'zh' ? S.profile.level.title.zh : S.profile.level.title.en), 4);
    }
    renderHud();
    rebuildWorld();
  }
  function refresh() { if (!api) return Promise.resolve(); return Promise.resolve(api.state()).then(applyState).catch(() => {}); }
  // 服务器的回应里带了什么,就更新什么;有奖励就提示
  function took(r, label) {
    if (!r) return r;
    if (r.error) { toast(/sign in/i.test(r.error) ? t.signin : r.error); return r; }
    if (r.gained > 0) toast((label ? label + '  ' : '') + '+' + r.gained + ' ✦');
    else if (r.gained === 0 && r.capped) toast(t.capped, 4);
    if (r.stamps && r.stamps.length) for (const k of r.stamps) toast('📖 ' + stampLabel(k) + ' ✓');
    const patch = {};
    for (const k of ['profile', 'quests', 'riddle', 'codex', 'trees', 'decor', 'scrolls', 'castsLeft']) if (r[k] !== undefined) patch[k] = r[k];
    // r.stamps 是这一次新盖的章,不是整本护照
    if (r.stamps && r.stamps.length) patch.stamps = [...new Set(((S && S.stamps) || []).concat(r.stamps))];
    // 谜题:有的回应把那一块摊在最外层
    if (!r.riddle && r.clues) patch.riddle = { clues: r.clues, guesses: r.guesses, solved: r.solved, failed: r.failed, max: r.max, answer: r.answer, title: r.title, share: r.share };
    // 捡到的卷轴、钓到的虫:图鉴里先记上,等下一次刷新再对齐
    if (r.codex === undefined && r.caught && r.bug && S) {
      const bugs = Object.assign({}, (S.codex && S.codex.bugs) || {});
      const b0 = bugs[r.bug.id] || { n: 0, best: 0 };
      bugs[r.bug.id] = { n: b0.n + 1, best: Math.max(b0.best, r.len || 0) };
      patch.codex = Object.assign({}, S.codex || {}, { bugs });
    }
    if (Object.keys(patch).length) applyState(Object.assign({ ok: true }, patch));
    if (r.quests && S && S.quests) {
      for (const q of r.quests) if (q.done && q.justDone) toast('📜 ' + (lang === 'zh' ? q.text.zh : q.text.en) + ' — ' + t.done + ' +' + q.reward + ' ✦', 3.6);
    }
    return r;
  }
  const stampLabel = (k) => (k.startsWith('lang:') ? langLabel(k.slice(5)) : k.startsWith('style:') ? styleName(k.slice(6), lang) : k);
  function send(ev) { if (!api) return Promise.resolve(null); return Promise.resolve(api.event(ev)).then((r) => took(r)).catch(() => null); }

  /* ── 面板 ── */
  let panel = null;
  function openPanel(title, tabs, draw) {
    closePanel();
    const box = el('div', 'tp-panel');
    const head = el('header', '', box);
    const b = el('b', '', head); b.textContent = title;
    const x = el('button', '', head); x.type = 'button'; x.textContent = '×';
    on(x, 'click', (e) => { e.stopPropagation(); closePanel(); });
    on(box, 'pointerdown', (e) => e.stopPropagation());
    on(box, 'keydown', (e) => e.stopPropagation());
    let tabRow = null, cur = tabs ? tabs[0][0] : null;
    const body = el('div', 'tp-body', box);
    const paint = () => { body.textContent = ''; draw(body, cur); };
    if (tabs) {
      tabRow = el('div', 'tabs', box);
      box.insertBefore(tabRow, body);
      for (const [k, label] of tabs) {
        const tb = el('button', k === cur ? 'on' : '', tabRow); tb.type = 'button'; tb.textContent = label;
        on(tb, 'click', (e) => { e.stopPropagation(); cur = k; [...tabRow.children].forEach((c) => c.classList.toggle('on', c === tb)); paint(); });
      }
    }
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    panel = { box, paint, setTab: (k) => { cur = k; if (tabRow) [...tabRow.children].forEach((c, i) => c.classList.toggle('on', tabs[i][0] === k)); paint(); } };
    paint();
    return panel;
  }
  function closePanel() { if (panel) { try { panel.box.remove(); } catch (e) {} panel = null; } }
  const div = (parent, cls, text) => { const d = el('div', cls || '', parent); if (text != null) d.textContent = text; return d; };

  /* 告示牌:三件差事 + 节日 + 宝箱 + 你家今天 */
  function openBoard() {
    refresh().then(() => { if (panel && panel.kind === 'board') panel.paint(); });
    const p = openPanel('📜 ' + t.board, null, (body) => {
      const F = S && S.festival;
      if (F) div(body, 'tp-clue', `🎪 ${t.festival}: ${lang === 'zh' ? F.zh : F.en} · ${t.featured}: ${langLabel(F.lang)}`);
      div(body, '', t.quests).style.cssText = 'font-weight:700;margin:6px 0 2px';
      const qs = (S && S.quests) || localQuests();
      for (const q of qs) {
        const row = div(body, 'tp-q' + (q.done ? ' done' : ''));
        div(row, 'ck', q.done ? '✓' : '');
        const tx = div(row, '');
        tx.append(lang === 'zh' ? q.text.zh : q.text.en);
        const sm = document.createElement('small'); sm.textContent = (q.progress || 0) + ' / ' + q.n; tx.appendChild(sm);
        div(row, 'rw', '+' + q.reward + ' ✦');
      }
      const P = S && S.profile;
      if (P) {
        const row = div(body, 'tp-row');
        row.style.alignItems = 'center';
        const left = div(row, '', `🎁 ${Math.min(7, P.questDays)}/7 — ${Math.max(0, 7 - P.questDays)} ${t.chestHint}`);
        left.style.flex = '1';
        if (P.chestReady) {
          const b = el('button', 'tp-btn', row); b.type = 'button'; b.textContent = t.chest;
          on(b, 'click', (e) => { e.stopPropagation(); Promise.resolve(api.chest()).then((r) => { took(r, '🎁'); p.paint(); }); });
        }
        div(body, '', `✦ ${P.earnedToday} / ${P.cap}`).style.cssText = 'opacity:.6;font-size:12px;margin-top:8px';
      } else div(body, 'tp-clue', t.signin);
      const D = S && S.digest;
      if (D && S.mine && S.mine.length) div(body, 'tp-clue', `🏠 ${t.digest}: ${D.visits} ${t.visits} · ${D.knocks} ${t.knocks} · ${D.waters} ${t.waters} · ${D.plants} ${t.plants}`);
    });
    p.kind = 'board';
  }
  function localQuests() {
    const houses = people.folk.map((f) => ({ id: f.id, lang: f.facts.lang, style: (villaById.get(f.id) || {}).style, trade: f.persona.trade }));
    return dailyQuests(dayIndex(), { houses }).map((q) => Object.assign({ progress: 0, done: false }, q));
  }

  /* 每日谜题 */
  function openRiddle() {
    refresh().then(() => { if (panel && panel.kind === 'riddle') panel.paint(); });
    const titles = people.folk.map((f) => ({ id: f.id, title: f.facts.title || f.id }));
    const p = openPanel('🧩 ' + t.riddle, null, (body) => {
      const R = (S && S.riddle) || null;
      if (!R) { div(body, 'tp-clue', '…'); return; }
      (R.clues || []).forEach((c, i) => div(body, 'tp-clue', (i + 1) + '. ' + (lang === 'zh' ? c.zh : c.en)));
      const done = R.solved || R.failed;
      if (done) {
        div(body, 'tp-card', '').innerHTML = '';
        const card = div(body, 'tp-card');
        div(card, 'big', R.solved ? '🎉' : '🌙');
        const b = el('b', '', card); b.textContent = (R.solved ? t.solved : t.failed) + ' ' + (R.title || '');
        const row = div(body, 'tp-row'); row.style.justifyContent = 'center';
        const way = el('button', 'tp-btn', row); way.type = 'button'; way.textContent = '🧭 ' + t.showWay;
        on(way, 'click', (e) => { e.stopPropagation(); guideTo(R.answer); closePanel(); });
        const sh = el('button', 'tp-btn ghost', row); sh.type = 'button'; sh.textContent = '↗ ' + t.share;
        on(sh, 'click', (e) => {
          e.stopPropagation();
          const text = (R.share || riddleShare(dayIndex(), R.guesses, R.solved, lang)) + '\nterseai.org/m';
          try { if (navigator.share) navigator.share({ text }); else navigator.clipboard.writeText(text).then(() => toast('✓')); } catch (err) {}
        });
        return;
      }
      div(body, '', `${t.guess} (${(R.max || 6) - (R.guesses || 0)} ${t.left})`).style.cssText = 'margin-top:8px;font-weight:700';
      const row = div(body, 'tp-row');
      const inp = el('input', '', row); inp.placeholder = '…'; inp.autocomplete = 'off';
      const sug = div(body, 'tp-sug');
      const paintSug = () => {
        sug.textContent = '';
        const q = inp.value.trim().toLowerCase();
        const list = titles.filter((x) => !q || x.title.toLowerCase().includes(q)).slice(0, 12);
        for (const x of list) {
          const b = el('button', '', sug); b.type = 'button'; b.textContent = x.title;
          on(b, 'click', (e) => { e.stopPropagation(); guess(x.id); });
        }
      };
      on(inp, 'input', paintSug);
      on(inp, 'keydown', (e) => e.stopPropagation());
      paintSug();
      const guess = (id) => {
        if (!api || busy) return;
        busy = true;
        Promise.resolve(api.riddle(id)).then((r) => {
          busy = false;
          took(r, '🧩');
          if (r && r.ok && !r.correct && !((r.riddle || r).failed)) toast(t.wrong);
          p.paint();
        }).catch(() => { busy = false; });
      };
    });
    p.kind = 'riddle';
  }

  /* 护照 */
  function openPassport(tab) {
    refresh().then(() => { if (panel && panel.kind === 'passport') panel.paint(); });
    const p = openPanel('📖 ' + t.passport, [['stamps', t.stamps], ['bugs', t.bugs], ['codex', t.codex]], (body, cur) => {
      const have = new Set((S && S.stamps) || []);
      if (cur === 'stamps') {
        const P = S && S.profile;
        if (P) { const lv = P.level || levelOf(P.xp); div(body, 'tp-clue', `Lv${lv.level} ${lang === 'zh' ? lv.title.zh : lv.title.en} · ✦ ${P.glim}` + (lv.next ? ` · → ${lang === 'zh' ? lv.next.zh : lv.next.en} ${lv.into}/${lv.need}` : '')); }
        const nl = [...have].filter((k) => k.startsWith('lang:')).length, ns = [...have].filter((k) => k.startsWith('style:')).length;
        div(body, '', `${t.langs} ${nl}/${PASSPORT_GOALS.lang}`).style.fontWeight = '700';
        const g1 = div(body, 'tp-grid');
        const extra = [...have].filter((k) => k.startsWith('lang:') && !LANGS20.includes(k.slice(5))).map((k) => k.slice(5));
        for (const l of LANGS20.concat(extra)) { const c = div(g1, 'tp-cell' + (have.has('lang:' + l) ? ' on' : '')); div(c, '', have.has('lang:' + l) ? '🔖' : '·').style.fontSize = '18px'; c.append(langLabel(l)); }
        div(body, '', `${t.styles} ${ns}/${PASSPORT_GOALS.style}`).style.fontWeight = '700';
        const g2 = div(body, 'tp-grid');
        for (const s of STYLES8) { const c = div(g2, 'tp-cell' + (have.has('style:' + s) ? ' on' : '')); div(c, '', have.has('style:' + s) ? '🏛' : '·').style.fontSize = '18px'; c.append(styleName(s, lang)); }
      } else if (cur === 'bugs') {
        const bugs = (S && S.codex && S.codex.bugs) || {};
        const n = Object.keys(bugs).length;
        div(body, '', `${n}/${BUGS.length}`).style.fontWeight = '700';
        const g = div(body, 'tp-grid');
        for (const b of BUGS) {
          const got = bugs[b.id];
          const c = div(g, 'tp-cell' + (got ? ' on' : ''));
          div(c, '', got ? '🐛' : '？').style.fontSize = '18px';
          c.append(got ? (lang === 'zh' ? b.zh : b.en) : t.unknown);
          const sm = document.createElement('small'); sm.style.display = 'block'; sm.style.opacity = '.7';
          sm.textContent = RARE_STARS[b.rare] + (got ? ` ×${got.n} · ${t.best} ${got.best}cm` : (b.lang ? ' · ' + langLabel(b.lang) : ''));
          c.appendChild(sm);
        }
      } else {
        const sc = (S && S.codex && S.codex.scrolls) || [];
        if (!sc.length) div(body, 'tp-clue', '📜 …');
        for (const x of sc.slice().reverse()) {
          const h = houseOf(x.villa);
          div(body, 'tp-clue', `📜 ${x.file}  —  ${h ? h.title : x.villa}`);
        }
      }
    });
    p.kind = 'passport';
    if (tab) p.setTab(tab);
  }

  /* ── 镇上的东西:卷轴、种的树、装饰、指路的光柱、浮标 ── */
  let dyn = null;
  const dynMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uPx: U.uPx, uNight: U.uNight, uExposure: U.uExposure, uSky: U.uSky, uSunCol: U.uSunCol, uSunDir: U.uSunDir },
    vertexShader: PLAY_VS, fragmentShader: PLAY_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const solidMat = new THREE.ShaderMaterial({
    uniforms: dynMat.uniforms, vertexShader: PLAY_VS, fragmentShader: PLAY_FS,
  });
  let solid = null;
  let scrollSpots = [], treeSpots = [], guide = null, bobber = null;
  function villaPoint(v, ang, dist) {
    const fx = v.fx, fz = v.fz, rx = fz, rz = -fx;
    const dx = v.door.x, dz = v.door.z;
    return { x: dx + (Math.cos(ang) * rx + Math.sin(ang) * fx) * dist, z: dz + (Math.cos(ang) * rz + Math.sin(ang) * fz) * dist };
  }
  function treeSlot(v, slot) {
    // 门的两边各两棵、正前方一棵,离门 3–5 米
    const side = [[-1, 0.4], [1, 0.4], [-1, 2.2], [1, 2.2], [0, 4.2]][slot % 5];
    const rx = v.fz, rz = -v.fx;
    return { x: v.door.x + rx * side[0] * (v.w / 2 + 1.2) + v.fx * side[1], z: v.door.z + rz * side[0] * (v.w / 2 + 1.2) + v.fz * side[1] };
  }
  function rebuildWorld() {
    const pos = [], col = [], inf = [];
    const sp = [], sc = [], si = [];
    const glow = (x, y, z, c, size, kind, ph) => { pos.push(x, y, z); col.push(c[0], c[1], c[2]); inf.push(size, kind, ph); };
    const dot = (x, y, z, c, size) => { sp.push(x, y, z); sc.push(c[0], c[1], c[2]); si.push(size, 0, 0); };
    // 卷轴:门口附近,一卷发光的纸
    scrollSpots = [];
    for (const s of (S && S.scrolls) || []) {
      if (s.taken) continue;
      const v = villaById.get(String(s.villa));
      if (!v) continue;
      const q = villaPoint(v, s.angle || 0, s.dist || 3);
      scrollSpots.push(Object.assign({ x: q.x, z: q.z }, s));
      for (let k = 0; k < 26; k++) glow(q.x + Math.cos(k) * 0.18 * ((k % 3) / 3), 1.05 + (k % 7) * 0.04, q.z + Math.sin(k) * 0.05, [1, 0.85, 0.45], 0.14, 1, 0.3);
      for (let k = 0; k < 18; k++) glow(q.x, 0.3 + k * 0.2, q.z, [1, 0.8, 0.4], 0.12, 2, k / 18);
    }
    // 种的树:按阶段长高
    treeSpots = [];
    for (const tr of (S && S.trees) || []) {
      const v = villaById.get(String(tr.villa));
      if (!v) continue;
      const q = treeSlot(v, tr.slot || 0);
      const st = tr.stage != null ? tr.stage : treeStage(tr.waterDays);
      treeSpots.push(Object.assign({ x: q.x, z: q.z }, tr));
      const h = 0.5 + st * 0.9, R = 0.25 + st * 0.35;
      for (let k = 0; k < 8 + st * 4; k++) dot(q.x, k / (8 + st * 4) * h * 0.55, q.z, [0.32, 0.22, 0.14], 0.09);
      const n = 30 + st * 45;
      for (let k = 0; k < n; k++) {
        const u = (k / n) * 2 - 1, a = k * 2.39996, rr = Math.sqrt(1 - u * u) * R;
        const blossom = st >= 3 && k % 9 === 0;
        dot(q.x + Math.cos(a) * rr, h * 0.55 + R + u * R * 0.85, q.z + Math.sin(a) * rr, blossom ? [0.95, 0.7, 0.8] : [0.25 + 0.1 * (k % 3), 0.5 + 0.08 * (k % 2), 0.2], 0.16);
      }
      if (!tr.wateredToday && st < 4) for (let k = 0; k < 6; k++) glow(q.x, h + R * 2 + 0.3 + k * 0.08, q.z, [0.45, 0.75, 1], 0.1, 1, k / 6);
    }
    // 房主的装饰
    for (const [vid, items] of Object.entries((S && S.decor) || {})) {
      const v = villaById.get(String(vid));
      if (!v) continue;
      for (const it of Object.keys(items)) {
        const c = PALETTE[(+items[it] || 0) % PALETTE.length];
        if (it === 'lanterns') for (let k = -3; k <= 3; k++) { const q = villaPoint(v, 0, 0); const rx = v.fz, rz = -v.fx; for (let m = 0; m < 6; m++) glow(q.x + rx * k * 1.4 + (m - 3) * 0.02, 2.6 + (k % 2) * 0.2, q.z + rz * k * 1.4, c, 0.14, 1, (k + 3) / 7); }
        if (it === 'fireflies') for (let k = 0; k < 40; k++) { const q = villaPoint(v, k * 0.7, 2 + (k % 5)); glow(q.x, 0.6 + (k % 4) * 0.4, q.z, c, 0.08, 1, k / 40); }
        if (it === 'flowers') for (let k = 0; k < 90; k++) { const q = villaPoint(v, Math.PI / 2 + (k % 2 ? 0.08 : -0.08) * (k % 13), 1 + (k % 15) * 0.25); dot(q.x + ((k * 7) % 5 - 2) * 0.12, 0.1 + (k % 3) * 0.06, q.z, k % 4 ? c : [0.2, 0.45, 0.2], 0.12); }
        if (it === 'banner') { const rx = v.fz, rz = -v.fx; for (const s of [-1, 1]) { const q = { x: v.door.x + rx * s * 1.6, z: v.door.z + rz * s * 1.6 }; for (let k = 0; k < 16; k++) dot(q.x, k * 0.2, q.z, [0.3, 0.22, 0.14], 0.07); for (let a = 0; a < 5; a++) for (let b = 0; b < 8; b++) dot(q.x + rx * (a - 2) * 0.1, 3.1 - b * 0.14, q.z + rz * (a - 2) * 0.1, b % 3 ? c : c.map((x) => x * 0.6), 0.13); } }
      }
    }
    // 指路的光柱
    if (guide) { const v = villaById.get(String(guide)); if (v) for (let k = 0; k < 60; k++) glow(v.door.x + Math.cos(k) * 0.3, 0.2 + k * 0.4, v.door.z + Math.sin(k) * 0.3, [0.9, 0.95, 0.5], 0.3, 2, k / 60); }
    if (bobber) { for (let k = 0; k < 10; k++) glow(bobber.x, 0.02 + k * 0.012, bobber.z, bobber.bite ? [1, 0.35, 0.3] : [1, 0.95, 0.8], 0.12, 1, 0); }
    swap('dyn', pos, col, inf, dynMat, 6);
    swap('solid', sp, sc, si, solidMat, 1);
  }
  function swap(which, pos, col, inf, mat, order) {
    const old = which === 'dyn' ? dyn : solid;
    if (old) { scene.remove(old); old.geometry.dispose(); }
    let pts = null;
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aInfo', new THREE.Float32BufferAttribute(inf, 3));
      pts = new THREE.Points(g, mat);
      pts.frustumCulled = false; pts.renderOrder = order;
      scene.add(pts);
    }
    if (which === 'dyn') dyn = pts; else solid = pts;
  }
  function guideTo(id) {
    guide = String(id);
    rebuildWorld();
    const f = folkById.get(guide);
    if (f && ctx.guide) ctx.guide(f);
    toast('🧭 ' + ((houseOf(guide) || {}).title || ''));
  }

  /* ── 钓鱼 ── */
  let fishing = null;
  function waterNear(x, z) {
    if (!W) return null;
    const r = Math.hypot(x, z);
    if (r > W.moat.r0 - 4.5 && r < W.moat.r1 + 4.5) {
      const mid = (W.moat.r0 + W.moat.r1) / 2;
      return { where: 'moat', x: x / r * mid, z: z / r * mid };
    }
    let best = null, bd = W.stream.w / 2 + 5;
    for (let i = 0; i + 1 < W.stream.pts.length; i++) {
      const a = W.stream.pts[i], b = W.stream.pts[i + 1];
      const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
      let u = ((x - a[0]) * ex + (z - a[1]) * ez) / L2; u = Math.max(0, Math.min(1, u));
      const qx = a[0] + ex * u, qz = a[1] + ez * u, d = Math.hypot(x - qx, z - qz);
      if (d < bd) { bd = d; best = { where: 'stream', x: qx, z: qz }; }
    }
    return best;
  }
  function startFishing(wat) {
    if (!api) return;
    if (fishing) return;
    const e = ctx.env();
    const me = ctx.player();
    const langs = [...new Set(people.folk.filter((f) => Math.hypot(f.villa.x - me.x, f.villa.z - me.z) < 45).map((f) => normLang(f.facts.lang)).filter(Boolean))].slice(0, 3);
    fishing = { state: 'cast', wat };
    Promise.resolve(api.cast({ where: wat.where, hour: e.hour, weather: e.weather, langs })).then((r) => {
      if (!r || !r.ok || !r.cast) { fishing = null; took(r); return; }
      fishing = { state: 'wait', wat, cast: r.cast, t0: 0, left: r.castsLeft };
      bobber = { x: wat.x, z: wat.z, bite: false };
      rebuildWorld();
      toast('🎣 ' + t.waiting, 2);
    }).catch(() => { fishing = null; });
  }
  function reel() {
    if (!fishing || fishing.state !== 'bite') {
      if (fishing && fishing.state === 'wait') { endFish(t.gotAway); }
      return;
    }
    const f = fishing;
    f.state = 'reeling';
    Promise.resolve(api.reel({ n: f.cast.n, ok: true })).then((r) => {
      endFish(null);
      if (!r || !r.ok) { took(r); return; }
      if (!r.caught) { toast(t.gotAway); return; }
      took(Object.assign({}, r, { gained: 0 }));
      const b = r.bug || f.cast.bug;
      const card = openPanel('🎣 ' + t.caught, null, (body) => {
        const c = div(body, 'tp-card');
        div(c, 'big', b.rare >= 4 ? '🌟' : b.rare === 0 ? '🥾' : '🐛');
        const nm = el('b', '', c); nm.textContent = (lang === 'zh' ? b.zh : b.en) + (r.newSpecies ? '  · ' + t.newSp : '');
        div(c, '', `${RARE_STARS[b.rare] || ''}  ${r.len || f.cast.len} cm` + (r.gained ? `  ·  +${r.gained} ✦` : '')).style.opacity = '.8';
        const row = div(body, 'tp-row'); row.style.justifyContent = 'center';
        const again = el('button', 'tp-btn', row); again.type = 'button'; again.textContent = '🎣 ' + t.fish;
        on(again, 'click', (e) => { e.stopPropagation(); closePanel(); const w2 = waterNear(ctx.player().x, ctx.player().z); if (w2) startFishing(w2); });
        const dex = el('button', 'tp-btn ghost', row); dex.type = 'button'; dex.textContent = '📖 ' + t.bugs;
        on(dex, 'click', (e) => { e.stopPropagation(); openPassport('bugs'); });
      });
      card.kind = 'catch';
      if (r.gained) toast('+' + r.gained + ' ✦');
      try { navigator.vibrate && navigator.vibrate(30); } catch (e) {}
    }).catch(() => endFish(null));
  }
  function endFish(msg) {
    if (fishing && fishing.state !== 'reeling' && fishing.cast && api) Promise.resolve(api.reel({ n: fishing.cast.n, ok: false })).catch(() => {});
    fishing = null; bobber = null; rebuildWorld();
    if (msg) toast(msg);
  }

  /* ── 门口、树下、水边:按钮 ── */
  let ctxKey = '';
  const visited = new Set();
  let dwell = { id: null, t: 0 };
  function setCtx(buttons) {
    const key = buttons.map((b) => b[0]).join('|');
    if (key === ctxKey) return;
    ctxKey = key;
    ctxRow.textContent = '';
    for (const [label, fn, big] of buttons) {
      const b = el('button', big ? 'big' : '', ctxRow); b.type = 'button'; b.textContent = label;
      on(b, 'click', (e) => { e.stopPropagation(); fn(); });
    }
  }
  const knockedToday = new Set();

  let first = true, clock = 0, lastRefresh = 0;
  function update(dt, time, nearDoor) {
    clock = time;
    if (first) {
      first = false;
      renderHud();
      refresh();
      try {
        if (!localStorage.getItem('terse-town-welcome')) { localStorage.setItem('terse-town-welcome', '1'); toast('🏘 ' + t.welcome1, 4.5); toast('📜 ' + t.welcome2, 4.5); }
      } catch (e) {}
      rebuildWorld();
    }
    if (api && time - lastRefresh > 90) { lastRefresh = time; refresh(); }
    // 提示
    toastT -= dt;
    if (toastT <= 0) {
      if (toasts.length) { const q = toasts.shift(); toastEl.textContent = q.msg; toastEl.style.opacity = '1'; toastEl.style.transform = 'translateX(-50%) translateY(0)'; toastT = q.secs; }
      else if (toastEl.style.opacity !== '0') toastEl.style.opacity = '0';
    }
    const me = ctx.player();
    const buttons = [];
    // 钓鱼
    if (fishing) {
      if (fishing.state === 'wait') {
        fishing.t0 += dt;
        if (fishing.t0 > fishing.cast.bite) { fishing.state = 'bite'; fishing.tb = 0; bobber.bite = true; rebuildWorld(); try { navigator.vibrate && navigator.vibrate([40, 30, 40]); } catch (e) {} }
      } else if (fishing.state === 'bite') {
        fishing.tb += dt;
        if (fishing.tb > fishing.cast.window + 0.25) endFish(t.gotAway);
      }
      if (fishing && Math.hypot(me.x - fishing.wat.x, me.z - fishing.wat.z) > 14) endFish(null);
      if (fishing) buttons.push([fishing.state === 'bite' ? '❗ ' + t.reel : '🎣 …', reel, fishing.state === 'bite']);
    }
    // 卷轴:走到跟前自动捡
    for (const s of scrollSpots) {
      if (Math.hypot(me.x - s.x, me.z - s.z) < 1.8 && !s.pending && api) {
        s.pending = true;
        Promise.resolve(api.scroll(s.id)).then((r) => { took(r, '📜 ' + s.file); if (r && r.ok) { s.taken = true; rebuildWorld(); } }).catch(() => { s.pending = false; });
      }
    }
    // 在一栋房子门口待 4 秒 = 拜访(盖章、差事)
    const nd = nearDoor && nearDoor.project ? String(nearDoor.project.id) : null;
    if (nd !== dwell.id) dwell = { id: nd, t: 0 };
    else if (nd && !visited.has(nd)) { dwell.t += dt; if (dwell.t > 4) { visited.add(nd); send({ type: 'visit', villa: nd }); } }
    if (nd && !fishing && api) {
      const mine = S && (S.mine || []).includes(nd);
      if (mine) buttons.push(['🎨 ' + t.decorate, () => openDecor(nd)]);
      else {
        if (!knockedToday.has(nd)) buttons.push(['🔔 ' + t.knock, () => doKnock(nd)]);
        const trees = ((S && S.trees) || []).filter((x) => String(x.villa) === nd);
        if (trees.length < 5) buttons.push([`🌱 ${t.plant} (${COST.tree}✦)`, () => doPlant(nd)]);
      }
    }
    // 树下
    for (const tr of treeSpots) {
      if (Math.hypot(me.x - tr.x, me.z - tr.z) < 2.6 && !tr.wateredToday && api && !fishing) {
        buttons.push([`💧 ${t.water} · ${t.stage[tr.stage || 0]}`, () => doWater(tr)]);
        break;
      }
    }
    // 水边
    if (!fishing && !nd) { const wat = waterNear(me.x, me.z); if (wat && api) buttons.push(['🎣 ' + t.fish + (S && S.castsLeft != null ? ` (${S.castsLeft})` : ''), () => startFishing(wat)]); }
    // 集市告示牌
    const B = built.board;
    if (B && Math.hypot(me.x - B.x, me.z - B.z) < 4 && !fishing) buttons.push(['📜 ' + t.board, openBoard]);
    setCtx(buttons);
    // 指路:走到了就收起光柱
    if (guide) { const v = villaById.get(guide); if (v && Math.hypot(me.x - v.door.x, me.z - v.door.z) < 4) { guide = null; rebuildWorld(); } }
  }
  function doKnock(id) {
    knockedToday.add(id);
    ctxKey = '';
    const f = folkById.get(id);
    if (f && ctx.speak) ctx.speak(f, lang === 'zh' ? '来啦来啦!' : 'Coming!');
    if (api.knock) Promise.resolve(api.knock(id)).catch(() => {});
    send({ type: 'knock', villa: id }).then(() => toast('🔔 ' + t.knocked));
  }
  function doPlant(id) {
    Promise.resolve(api.plant(id)).then((r) => { took(r, '🌱'); if (r && r.ok) refresh(); }).catch(() => {});
  }
  function doWater(tr) {
    tr.wateredToday = true;
    ctxKey = '';
    Promise.resolve(api.water(tr.id)).then((r) => { took(r, '💧'); if (r && r.ok) refresh(); }).catch(() => {});
  }
  function openDecor(id) {
    const p = openPanel('🎨 ' + t.decorate, null, (body) => {
      const cur = (S && S.decor && S.decor[id]) || {};
      for (const it of DECOR) {
        const row = div(body, 'tp-q');
        div(row, 'ck', cur[it] != null ? '✓' : '');
        const tx = div(row, '');
        tx.append({ banner: '🚩', lanterns: '🏮', flowers: '🌷', fireflies: '✨' }[it] + ' ' + (t.decor[it] || it));
        const sm = document.createElement('small'); sm.textContent = cur[it] != null ? t.color : `${t.cost} ${COST.decor[it]} ✦`; tx.appendChild(sm);
        const sw = div(row, ''); sw.style.marginLeft = 'auto';
        PALETTE.forEach((c, k) => {
          const s = el('span', 'tp-sw' + (+cur[it] === k ? ' on' : ''), sw);
          s.style.background = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
          on(s, 'click', (e) => { e.stopPropagation(); Promise.resolve(api.decor(id, it, k)).then((r) => { took(r, '🎨'); p.paint(); }); });
        });
      }
    });
    p.kind = 'decor';
  }

  return {
    update,
    event: (ev) => send(ev),
    openBoard, openRiddle, openPassport,
    busy: () => !!panel,
    dispose() {
      closePanel();
      for (const o of [dyn, solid]) if (o) { scene.remove(o); o.geometry.dispose(); }
      dynMat.dispose(); solidMat.dispose();
    },
  };
}
