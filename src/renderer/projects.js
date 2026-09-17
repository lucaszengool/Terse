/**
 * projects.js — 项目粒子这一页的逻辑。
 *
 * 一个项目在这里只有三个动作:**预览**(在自己的壁纸上演一段)、**编辑**(标题、简介、
 * 封面 —— 改过的字段以后重扫不会被覆盖)、**发到广场**(把胶囊传上去)。
 *
 * 广场那半边刻意做得很轻:列表拿到的就是一颗颗胶囊,点预览时**不再请求服务器** ——
 * 粒子是在本机由胶囊生成的。服务器从头到尾只做一件事:存 JSON、发 JSON。
 */
import { LANG_COLOR, LANG_FALLBACK } from './lang-colors.js';
import { CITY_STYLES, DEFAULT_STYLE, styleNeedsPro, styleVariants } from './city-styles.js';

const T = window.terse;
const $ = (s) => document.querySelector(s);

/** 广场的地址。和 app.js 里其它云功能同一个来源。 */
// ⚠ 必须是 www。`api.terseai.org` **不解析** —— 第一版写的就是它,于是每一次
// 广场请求都在 DNS 那一步就失败了,而 catch 把它咽了下去:用户看到的是"点了
// 发送到广场没反应"。app 里其余的云功能(rooms/friends)一直用的都是 www。
const API = (window.TERSE_API || 'https://www.terseai.org') + '/api/cloud/projects';
/* ⚠️ 和 DM 同一个 host。这个文件当初就是写成 api.terseai.org 才出的
   "点发送到广场没反应" —— 那个域名根本不解析,而 catch 把错咽了。 */
const FRIENDS_API = (window.TERSE_API || 'https://www.terseai.org') + '/api/cloud/friends';

const TT = (k, f) => {
  const v = (window.i18n && window.i18n.t && k) ? window.i18n.t(k) : null;
  return (v && v !== k) ? v : (f || '');
};

let mine = [];
let plaza = [];
let editing = null;

/* ── 预览 ─────────────────────────────────────────────────────────────────
   一段 20 秒的演出。壁纸那边收到胶囊就地生成粒子 —— 自己的项目和广场上别人的项目
   走的是同一条路,因为它们本来就是同一种东西:一颗胶囊。 */
async function preview(cap) {
  try { await T.projectPreview(cap, 20000); } catch (e) {}
}

/** 这个项目在广场上收到的评论(如果广场已经逛过了)。
 *
 *  自己的项目在"我的"列表里预览时也该看到别人说了什么 —— 而列表接口早就把它们
 *  连着胶囊一起发过来了,所以这里是**零次请求**:在已经拿到的广场数据里按胶囊 id
 *  认领一下就够了。 */
function withComments(cap) {
  const hit = plaza.find((p) => p.capsule && p.capsule.id === cap.id);
  const cs = (hit && hit.topComments) || [];
  return cs.length ? Object.assign({}, cap, { comments: cs }) : cap;
}

/** 评论署名用的名字。
 *
 *  昵称优先(房间里用的是同一个,存在 localStorage),没有就用邮箱前缀。
 *  **不退回 "someone"**:壁纸上一行 “……” — someone 比干脆不署名更糟 —— 它看起来
 *  像是有个叫 someone 的人说的。 */
async function myName() {
  try {
    const nick = (localStorage.getItem('terse-nickname') || '').trim();
    if (nick) return nick.slice(0, 24);
  } catch (e) {}
  try {
    const a = await (T.getAuth ? T.getAuth() : null);
    if (a && a.firstName) return String(a.firstName).trim().slice(0, 24);
    if (a && a.email) return String(a.email).split('@')[0].slice(0, 24);
  } catch (e) {}
  return null;
}

function coverEl(cap) {
  if (cap.cover) {
    const img = document.createElement('img');
    img.className = 'cv';
    img.src = cap.cover;
    return img;
  }
  const d = document.createElement('div');
  d.className = 'cv empty';
  d.textContent = TT('pj_no_cover', 'no image');
  return d;
}

function row(cap, opts) {
  const el = document.createElement('div');
  el.className = 'proj';
  el.appendChild(coverEl(cap));

  const mid = document.createElement('div');
  mid.className = 'mid';
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = cap.title || '(untitled)';
  const sb = document.createElement('div');
  sb.className = 'sb';
  sb.textContent = cap.subtitle || '';
  const ln = document.createElement('div');
  ln.className = 'ln';
  ln.textContent = (cap.lines || []).join('   ·   ');
  mid.appendChild(nm); mid.appendChild(sb); if (ln.textContent) mid.appendChild(ln);
  const bar = langBar(cap.langs);
  if (bar) { mid.appendChild(bar.bar); mid.appendChild(bar.key); }

  const act = document.createElement('div');
  act.className = 'act';
  for (const [label, cls, fn] of opts.actions) {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', fn);
    act.appendChild(b);
  }
  mid.appendChild(act);
  el.appendChild(mid);
  return el;
}

/** 语言用的颜色。照着 GitHub Linguist 那几个大家已经认得的颜色来 —— 一个人看到
 *  橙色就知道是 Rust,不需要再读一遍图例。 */

/** GitHub 那样的语言条。比"rust 62% · js 30%"一行字好读得多:比例是看出来的,
 *  不是算出来的。 */
function langBar(langs) {
  if (!Array.isArray(langs) || !langs.length) return null;
  const bar = document.createElement('div');
  bar.className = 'langbar';
  const key = document.createElement('div');
  key.className = 'langkey';
  for (const pair of langs) {
    const name = pair && pair[0];
    const frac = Math.max(0, Math.min(1, +(pair && pair[1]) || 0));
    if (!name || frac <= 0.005) continue;
    const c = LANG_COLOR[name] || LANG_FALLBACK;
    const seg = document.createElement('i');
    seg.style.width = (frac * 100).toFixed(1) + '%';
    seg.style.background = c;
    bar.appendChild(seg);
    const k = document.createElement('span');
    const dot = document.createElement('b');
    dot.style.background = c;
    k.appendChild(dot);
    k.appendChild(document.createTextNode(`${name} ${(frac * 100).toFixed(1)}%`));
    key.appendChild(k);
  }
  return bar.children.length ? { bar, key } : null;
}

/* ── 我的项目 ─────────────────────────────────────────────────────────── */

/** 这颗胶囊有没有代码城市可演。
 *
 *  没有的时候**要说出来**。之前是静悄悄的:点预览只出图和字,和这个功能没做一模一样,
 *  而人完全没有理由知道该去按「重新扫描」。一个功能缺料的时候,界面得自己讲。 */
function cityNote(cap) {
  if (Array.isArray(cap.dirs) && cap.dirs.length) return null;
  const d = document.createElement('div');
  d.className = 'citywarn';
  // 权限被拒和"还没扫过"是**两件完全不同的事**,给的下一步也不一样:
  // 一个要去系统设置里放行,一个按一下重新扫描就好。混成一句"还没有城市",
  // 人只会一遍遍按那个永远不会成功的按钮。
  if (cap.scan_error === 'perm') {
    d.classList.add('perm');
    d.textContent = TT('pj_city_perm',
      'macOS is blocking Terse from listing this folder. Open System Settings → Privacy & Security → Files and Folders (or Full Disk Access) and re-enable Terse — an unsigned app loses that permission every time it is updated. Then press Rescan.');
  } else {
    d.textContent = TT('pj_no_city', 'No code city yet — press Rescan to build one.');
  }
  return d;
}

function renderMine() {
  const host = $('#mineList');
  host.innerHTML = '';
  $('#mineEmpty').style.display = mine.length ? 'none' : '';
  for (const cap of mine) {
    const el = row(cap, {
      actions: [
        [TT('pj_preview', 'Preview'), 'pri', () => preview(withComments(cap))],
        [TT('pj_edit', 'Edit'), '', () => { editing = editing === cap.id ? null : cap.id; renderMine(); }],
        [cap.published ? TT('pj_published', 'In the plaza') : TT('pj_publish', 'Publish'),
         cap.published ? 'on' : '', () => publish(cap)],
        ...(cap.published ? [[plotLabel(cap), '', () => movePlot(cap)]] : []),
        [TT('pj_rescan', 'Rescan'), '', () => add(cap.path)],
        [TT('pj_remove', 'Remove'), '', () => remove(cap)],
      ],
    });
    const warn = cityNote(cap);
    if (warn) el.appendChild(warn);
    host.appendChild(el);
    if (editing === cap.id) host.appendChild(editor(cap));
  }
}

/** 就地编辑。改过的字段会被记进 `edited`,以后重扫不覆盖 —— 被 rescan 冲掉一次
 *  自己写的标题,人就再也不会用这个功能了。 */
function editor(cap) {
  const box = document.createElement('div');
  box.className = 'edit';
  box.innerHTML = `
    <label>${TT('pj_f_title', 'Title')}</label>
    <input type="text" id="eTitle" maxlength="48">
    <label>${TT('pj_f_sub', 'One line about it')}</label>
    <input type="text" id="eSub" maxlength="140">
    <!-- 介绍。副标题是卡片上那一行,这一段是广场里点「展开」才看得全的部分 ——
         和发视频时的标题与文案是同一组关系。扫描扫不出它:一个项目**为什么**
         值得看只有作者知道,所以它默认空着,由人自己写。 -->
    <label>${TT('pj_f_desc', 'Description — shown when someone taps “more”')}</label>
    <textarea id="eDesc" maxlength="600" rows="4"
      placeholder="${TT('pj_f_desc_ph', 'What is it, why you made it, what it is good at.')}"></textarea>
    <div class="size" id="eDescN"></div>
    <label>${TT('pj_f_lines', 'Lines that become particles (comma separated)')}</label>
    <input type="text" id="eLines" maxlength="120">
    <label>${TT('pj_f_style', 'Code-city style')}</label>
    <div class="styles" id="eStyles"></div>
    <div class="styhint" id="eStyleHint"></div>
    <label>${TT('pj_f_images', 'Images (up to 5 — the first one is the cover)')}</label>
    <div class="shots" id="eShots"></div>
    <div class="row">
      <button class="btn" id="eAdd">${TT('pj_f_add_img', 'Add image…')}</button>
      <button class="btn pri" id="eSave">${TT('pj_f_save', 'Save')}</button>
      <span class="size" id="eSize"></span>
    </div>`;
  box.querySelector('#eTitle').value = cap.title || '';
  box.querySelector('#eSub').value = cap.subtitle || '';
  const eDesc = box.querySelector('#eDesc');
  eDesc.value = cap.desc || '';
  /* A live count, because 600 is a real limit and finding it by having your
     sentence cut off is the wrong way to learn it. */
  const countDesc = () => {
    box.querySelector('#eDescN').textContent = eDesc.value.length + ' / 600';
  };
  eDesc.addEventListener('input', countDesc);
  countDesc();
  box.querySelector('#eLines').value = (cap.lines || []).join(', ');

  // 胶囊有多大 = 这个功能的服务器成本。让人看得见,而不是藏起来。
  T.projectCapsule(cap.id)
    .then((r) => { box.querySelector('#eSize').textContent = (r.bytes / 1024).toFixed(1) + ' KB'; })
    .catch(() => {});

  /** 图片条:封面 + 附图,最多五张,每张右上角一个删除。
   *  预览时它们会轮流出现 —— 所以顺序就是播放顺序,第一张是封面。 */
  const paintShots = () => {
    const host = box.querySelector('#eShots');
    host.innerHTML = '';
    const all = [cap.cover, ...(cap.shots || [])].filter(Boolean);
    all.forEach((url, i) => {
      const w = document.createElement('div');
      w.className = 'shot';
      const im = document.createElement('img');
      im.src = url;
      w.appendChild(im);
      if (i === 0) {
        const tag = document.createElement('b');
        tag.textContent = TT('pj_f_cover_tag', 'cover');
        w.appendChild(tag);
      }
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = TT('pj_f_drop', 'Remove this image');
      x.addEventListener('click', async () => {
        try {
          const next = await T.projectRemoveImage(cap.id, i);
          Object.assign(cap, next); paintShots(); renderMine();
        } catch (e) { alert(String(e)); }
      });
      w.appendChild(x);
      host.appendChild(w);
    });
    const left = 5 - all.length;
    box.querySelector('#eAdd').disabled = left <= 0;
    box.querySelector('#eAdd').textContent = left > 0
      ? TT('pj_f_add_img', 'Add image…') + ' (' + left + ')'
      : TT('pj_f_img_full', 'Five is the limit');
  };
  paintShots();

  /** 风格芯片。**锁着的也能点** —— 挑一种、预览一遍、看它长什么样,全是免费的;
   *  只有发布到广场那一步才要 Pro。反过来做(点都点不动)的话,人根本不知道自己
   *  错过了什么,那不是一道闸,那是一堵墙。 */
  const paintStyles = () => {
    const host = box.querySelector('#eStyles');
    const hint = box.querySelector('#eStyleHint');
    host.innerHTML = '';
    const cur = cap.style || DEFAULT_STYLE;
    const zh = (window.i18n && window.i18n.lang && String(window.i18n.lang()).startsWith('zh'));
    for (const st of CITY_STYLES) {
      const b = document.createElement('button');
      b.className = 'sty' + (st.id === cur ? ' on' : '');
      // 悬停时告诉人这套词汇表能拼出多少种楼 —— 那是这个风格真正的分量,
      // 而"八种风格"听起来只有八个样子。
      b.title = ((zh ? st.blurb.zh : st.blurb.en) || '')
        + ' · ' + styleVariants(st.id).toLocaleString() + (zh ? ' 种组合' : ' variants');
      b.innerHTML = (zh ? st.zh : st.en) + (st.free ? '' : '<i>PRO</i>');
      b.addEventListener('click', async () => {
        try {
          const next = await T.projectUpdate(cap.id, { style: st.id });
          Object.assign(cap, next);
          const i = mine.findIndex((c) => c.id === cap.id);
          if (i >= 0) mine[i] = next;
          paintStyles();
          preview(withComments(cap));      // 换了就立刻演一遍 —— 挑风格是看出来的,不是读出来的
        } catch (e) { alert(String(e && e.message ? e.message : e)); }
      });
      host.appendChild(b);
    }
    hint.textContent = styleNeedsPro(cur)
      ? TT('pj_style_pro', 'Preview any style for free. Publishing this one to the plaza needs Pro.')
      : TT('pj_style_free', 'Modern is free everywhere. The other styles preview free; publishing them needs Pro.');
  };
  paintStyles();

  box.querySelector('#eAdd').addEventListener('click', async () => {
    try {
      const next = await T.projectAddImage(cap.id);
      if (next && next.cancelled) return;
      Object.assign(cap, next);
      paintShots(); renderMine();
      T.projectCapsule(cap.id)
        .then((r) => { box.querySelector('#eSize').textContent = (r.bytes / 1024).toFixed(1) + ' KB'; })
        .catch(() => {});
    } catch (e) { alert(String(e && e.message ? e.message : e)); }
  });
  box.querySelector('#eSave').addEventListener('click', async () => {
    const patch = {
      title: box.querySelector('#eTitle').value.trim(),
      subtitle: box.querySelector('#eSub').value.trim(),
      desc: box.querySelector('#eDesc').value.trim(),
      lines: box.querySelector('#eLines').value.split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      const next = await T.projectUpdate(cap.id, patch);
      const i = mine.findIndex((c) => c.id === cap.id);
      if (i >= 0) mine[i] = next;
      editing = null;
      renderMine();
    } catch (e) {}
  });
  return box;
}

/** 换封面。在**本机**缩到 96px 再存 —— 胶囊要小,而小正是它能被当参数传的原因。 */
function pickCover(cap) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = async () => {
        const S = 224;   // 和扫描出来的封面同一个尺寸(96 太小,粒子聚出来是一团色块)
        const cv = document.createElement('canvas');
        const a = img.width / img.height;
        cv.width = a >= 1 ? S : Math.round(S * a);
        cv.height = a >= 1 ? Math.round(S / a) : S;
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        const url = cv.toDataURL('image/jpeg', 0.82);
        try {
          const next = await T.projectUpdate(cap.id, { cover: url });
          const i = mine.findIndex((c) => c.id === cap.id);
          if (i >= 0) mine[i] = next;
          renderMine();
        } catch (e) {}
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
  });
  inp.click();
}

async function add(path) {
  if (!path) return;
  try {
    const cap = await T.projectAdd(path);
    const i = mine.findIndex((c) => c.id === cap.id);
    if (i >= 0) mine[i] = cap; else mine.unshift(cap);
    renderMine();
    await loadLive();
    preview(cap);            // 加完立刻演一段:看得见才知道加对了没有
  } catch (e) {}
}

async function remove(cap) {
  try { await T.projectRemove(cap.id); } catch (e) {}
  mine = mine.filter((c) => c.id !== cap.id);
  renderMine();
}

/* ── 广场 ─────────────────────────────────────────────────────────────── */

async function publish(cap) {
  try {
    if (cap.published) {
      await fetch(API + '/' + encodeURIComponent(cap.id), {
        method: 'DELETE', headers: await authHeaders(),
      });
      const next = await T.projectUpdate(cap.id, { published: false });
      Object.assign(cap, next);
    } else {
      // 发布这一步才拦 Pro,而且**只拦非默认风格**。预览随便看 —— 一个人得先在自己
      // 的壁纸上看见那座唐塔,才会想把它发出去。
      if (styleNeedsPro(cap.style || DEFAULT_STYLE) && !(await proNow())) {
        alert(TT('pj_style_pro_gate',
          'That code-city style is a Pro style. You can keep previewing it for free — publishing it to the plaza needs Pro. Switch back to Modern to publish now.'));
        return;
      }
      // 代码小镇上挑一块地(也可以交给小镇自己排)。取消 = 这次不发。
      const pick = await pickPlot(cap);
      if (!pick) return;
      const id = await sendCapsule(cap, pick.plot);
      if (!id) return;
      const next = await T.projectUpdate(cap.id, { published: true });
      Object.assign(cap, next);
      renderMine();
      await showMyVilla(id);
      return;
    }
    renderMine();
  } catch (e) {
    // 把**真正的原因**说出来。第一版这里只弹一句"连不上广场",而那次的真因是
    // 域名不解析 —— 一句笼统的话让这个 bug 活了整整一轮。
    const why = (e && e.message) ? String(e.message).slice(0, 180) : String(e);
    alert(TT('pj_pub_fail', 'Could not reach the plaza just now.') + '\n\n' + why);
    console.error('[projects] publish failed:', e);
  }
}

/** 这台机器现在是不是 Pro。**每次现问**,不缓存:订阅是会变的,而缓存下来的
 *  "不是 Pro" 会在人刚付完钱的那一刻正好挡住他 —— 那是最糟的一次拦截。 */
async function proNow() {
  try { const l = await T.getLicense(); return !!(l && l.isPro); } catch (e) { return false; }
}

/** 身份用的是本机的 Clerk 用户 id,和别的云功能同一套。 */
async function authHeaders() {
  try {
    const lic = await (T.getLicense ? T.getLicense() : null);
    const id = (lic && lic.clerkUserId) || '';
    return id ? { 'x-terse-identity': id } : {};
  } catch (e) { return {}; }
}

async function loadPlaza() {
  const host = $('#plazaList');
  host.innerHTML = '<div class="empty-note">…</div>';
  try {
    const r = await fetch(API + '/public?limit=60');
    const j = await r.json();
    plaza = (j && j.projects) || [];
  } catch (e) { plaza = []; }
  host.innerHTML = '';
  if (!plaza.length) {
    host.innerHTML = `<div class="empty-note">${TT('pj_plaza_empty', 'Nothing published yet.')}</div>`;
    return;
  }
  for (const p of plaza) {
    // 列表里已经带着整颗胶囊,所以点预览**不再请求服务器**:粒子在本机生成。
    const card = row(p.capsule || p, {
      actions: [[TT('pj_preview', 'Preview'), 'pri', () => {
        // 预览时把**评论连同署名**一起交给壁纸 —— 列表接口已经带回来了,所以
        // 这里不需要再请求一次。整条传过去(body + author):在这里拍扁成字符串,
        // 名字就在这一步丢了,壁纸上剩下的是几句没有主人的话。
        preview(Object.assign({}, p.capsule || p, { comments: p.topComments || [] }));
        // 尽力而为的计数:数不准没关系,但这是作者唯一能看到的反馈。
        fetch(API + '/' + encodeURIComponent(p.id) + '/view', { method: 'POST' }).catch(() => {});
      }]],
    });
    card.appendChild(socialBar(p, card));
    host.appendChild(card);
  }
}

/* ── 点赞 · 收藏 · 评论 ───────────────────────────────────────────────── */

/** 一次点击 = 一次切换。界面**先动**,请求再去追:广场上的赞是个手感问题,
 *  等一次往返再变色,人会以为没点上而去点第二下(那就变成了取消)。
 *  请求失败再把界面改回来。 */
async function toggle(url, el, state) {
  const before = { on: state.on, n: state.n };
  state.on = !state.on;
  state.n = Math.max(0, state.n + (state.on ? 1 : -1));
  el.classList.toggle('on', state.on);
  el.querySelector('i').textContent = state.n || '';
  try {
    const r = await fetch(url, { method: 'POST', headers: await authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (typeof j.count === 'number') { state.n = j.count; state.on = !!j.on; }
    else if (typeof j.likes === 'number') { state.n = j.likes; state.on = !!j.on; }
    el.classList.toggle('on', state.on);
    el.querySelector('i').textContent = state.n || '';
  } catch (e) {
    state.on = before.on; state.n = before.n;
    el.classList.toggle('on', state.on);
    el.querySelector('i').textContent = state.n || '';
    console.error('[projects] reaction failed:', e);
  }
}

function pill(glyph, count, on, title) {
  const b = document.createElement('button');
  b.className = 'pill' + (on ? ' on' : '');
  b.title = title || '';
  b.innerHTML = '<s>' + glyph + '</s><i>' + (count || '') + '</i>';
  return b;
}

function socialBar(p, card) {
  const bar = document.createElement('div');
  bar.className = 'social';

  const like = pill('♥', p.likes, p.liked, TT('pj_like', 'Like'));
  const likeState = { on: !!p.liked, n: p.likes || 0 };
  like.addEventListener('click', () => toggle(API + '/' + encodeURIComponent(p.id) + '/like', like, likeState));

  const fav = pill('★', p.favs, p.faved, TT('pj_fav', 'Save'));
  const favState = { on: !!p.faved, n: p.favs || 0 };
  fav.addEventListener('click', () => toggle(API + '/' + encodeURIComponent(p.id) + '/fav', fav, favState));

  const talk = pill('💬', p.comments, false, TT('pj_comments', 'Comments'));
  let panel = null;
  talk.addEventListener('click', async () => {
    if (panel) { panel.remove(); panel = null; talk.classList.remove('on'); return; }
    talk.classList.add('on');
    panel = document.createElement('div');
    panel.className = 'thread';
    panel.innerHTML = '<div class="empty-note">…</div>';
    card.appendChild(panel);
    await loadThread(p, panel);
  });

  bar.appendChild(like); bar.appendChild(fav); bar.appendChild(talk);

  // **是谁做的** —— 广场上最缺的一条。一个项目没有作者,它就只是一张图片;
  // 有了作者,它才是某个人做的东西,而你可以去找他。
  if (p.author || p.authorId) {
    const who = document.createElement('span');
    who.className = 'byline';
    who.textContent = TT('pj_by', 'by {n}').replace('{n}', p.author || TT('pj_anon', 'someone'));
    bar.appendChild(who);
  }
  if (p.authorId && !p.mine) {
    const dm = pill('✉', '', false, TT('pj_dm', 'Message the author'));
    let box = null;
    dm.addEventListener('click', () => {
      if (box) { box.remove(); box = null; dm.classList.remove('on'); return; }
      dm.classList.add('on');
      box = dmPanel(p);
      card.appendChild(box);
    });
    bar.appendChild(dm);

    /* ── 加好友 ────────────────────────────────────────────────────────
       ⚠️ 走的是 /friends/**from-project**,不是 /friends/request:后者要
          room_id + to_member_id(只能在房间里加),广场上没有房间。
       ⚠️ 而且**故意**不是"按身份哈希加人":那样广场上的哈希就成了一份
          可以逐个骚扰的名单。这条路由的目标是**从项目反推**出来的 ——
          想加谁,就得先找到那个人自己放到广场上的东西。和私信同一道闸。 */
    const addf = pill('＋', '', false, TT('pj_addfriend', 'Add friend'));
    addf.addEventListener('click', async () => {
      if (addf.classList.contains('on') || addf.dataset.busy) return;
      addf.dataset.busy = '1';
      try {
        const r = await fetch(FRIENDS_API + '/from-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
          body: JSON.stringify({ project_id: p.id, author: await myName() }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          /* ⚠️ 把服务端的真话显示出来,不要一句笼统的"失败"。
             这个文件上一个 bug(域名不解析)之所以活了一整轮,就是因为
             错误被 catch 咽掉、界面上只说"没反应"。 */
          addf.title = j.error || ('HTTP ' + r.status);
          addf.classList.add('err');
          return;
        }
        const st = j.friendship && j.friendship.status;
        addf.classList.add('on');
        addf.querySelector('s').textContent = st === 'accepted' ? '✓' : '…';
        addf.title = st === 'accepted'
          ? TT('pj_friend_ok', 'You are friends')
          : TT('pj_friend_sent', 'Request sent');
      } catch (e) {
        addf.title = String((e && e.message) || e);
        addf.classList.add('err');
      } finally { delete addf.dataset.busy; }
    });
    bar.appendChild(addf);
  }
  if (p.views) {
    const v = document.createElement('span');
    v.className = 'views';
    v.textContent = TT('pj_views', '{n} previews').replace('{n}', p.views);
    bar.appendChild(v);
  }
  return bar;
}

/* ── 私信 ─────────────────────────────────────────────────────────────────
   给作者发一句话。**第一条必须挂在这个项目上**(服务端会核对,见 api/dm.js)——
   这既是上下文,也是这个功能敢对陌生人开口的全部理由:没有由头就发不出去,
   于是广场上的身份哈希也就不是一份可以逐个骚扰的名单。 */

const DM_API = (window.TERSE_API || 'https://www.terseai.org') + '/api/cloud/dm';

function dmPanel(p) {
  const wrap = document.createElement('div');
  wrap.className = 'thread dm';
  const log = document.createElement('div');
  log.className = 'dmlog';
  log.innerHTML = `<div class="empty-note">…</div>`;
  wrap.appendChild(log);

  const paint = async () => {
    let msgs = [];
    try {
      const r = await fetch(DM_API + '/' + encodeURIComponent(p.authorId), { headers: await authHeaders() });
      msgs = ((await r.json()) || {}).messages || [];
    } catch (e) { msgs = []; }
    log.innerHTML = '';
    if (!msgs.length) {
      const e = document.createElement('div');
      e.className = 'empty-note';
      e.textContent = TT('pj_dm_first', 'Say hello about this project — they will see it came from here.');
      log.appendChild(e);
    }
    for (const m of msgs) {
      const el = document.createElement('div');
      el.className = 'dmm' + (m.mine ? ' me' : '');
      el.textContent = m.body;
      log.appendChild(el);
    }
    log.scrollTop = log.scrollHeight;
  };
  paint();

  const row = document.createElement('div');
  row.className = 'rbox top';
  const ta = document.createElement('input');
  ta.type = 'text';
  ta.maxLength = 2000;
  ta.placeholder = TT('pj_dm_ph', 'Message the author…');
  const go = document.createElement('button');
  go.className = 'btn pri';
  go.textContent = TT('pj_send', 'Send');
  const send = async () => {
    const body = ta.value.trim();
    if (!body) return;
    ta.value = '';
    try {
      const r = await fetch(DM_API + '/' + encodeURIComponent(p.authorId), {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, await authHeaders()),
        // projectId 每次都带上。第一条服务端要拿它核对,之后它被忽略 —— 与其在
        // 客户端猜"这条算不算第一条",不如永远带着,判断留给唯一知道真相的那一端。
        body: JSON.stringify({ body, author: await myName(), projectId: p.id }),
      });
      if (!r.ok) throw new Error((await r.text()) || ('HTTP ' + r.status));
      await paint();
    } catch (e) {
      ta.value = body;
      alert(TT('pj_dm_fail', 'Could not send that message.') + '\n\n' + (e && e.message || e));
    }
  };
  go.addEventListener('click', send);
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });
  row.appendChild(ta); row.appendChild(go);
  wrap.appendChild(row);
  return wrap;
}

/** 整条线程一次取回来(顶层按赞排,回复按时间排),在这里画。
 *  只有两层 —— 回复的回复会被服务端挂回同一条线程,所以界面永远不会缩成一条
 *  看不懂的细线。 */
async function loadThread(p, panel) {
  let tree = [];
  try {
    const r = await fetch(API + '/' + encodeURIComponent(p.id) + '/comments', { headers: await authHeaders() });
    tree = (await r.json()).comments || [];
  } catch (e) { tree = []; }
  panel.innerHTML = '';

  const post = async (body, parentId, box) => {
    if (!body.trim()) return;
    try {
      const r = await fetch(API + '/' + encodeURIComponent(p.id) + '/comments', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, await authHeaders()),
        // 署名跟着评论一起发。身份头是一串 hash(用来判断"是不是你写的"),
        // **人看的名字得单独给** —— 不给的话服务端存下的 author 就是空的,
        // 壁纸上那一行也就没有名字。
        body: JSON.stringify({ body, parentId: parentId || null, author: await myName() }),
      });
      if (!r.ok) throw new Error(await r.text());
      if (box) box.value = '';
      await loadThread(p, panel);
    } catch (e) {
      alert(TT('pj_comment_fail', 'Could not post that comment.') + '\n\n' + (e && e.message || e));
    }
  };

  const draw = (c, depth) => {
    const el = document.createElement('div');
    el.className = 'cmt' + (depth ? ' reply' : '');
    const body = document.createElement('div');
    body.className = 'cb';
    body.textContent = c.body;
    el.appendChild(body);

    const meta = document.createElement('div');
    meta.className = 'cm';
    const lk = pill('♥', c.likes, c.liked, TT('pj_like', 'Like'));
    lk.className += ' mini';
    const st = { on: !!c.liked, n: c.likes || 0 };
    lk.addEventListener('click', () => toggle(API + '/comments/' + encodeURIComponent(c.id) + '/like', lk, st));
    meta.appendChild(lk);
    if (c.author) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = c.author;
      meta.appendChild(who);
    }
    // 回复只挂在顶层评论上 —— 这是刻意的两层边界,不是没做完
    if (!depth) {
      const rp = document.createElement('button');
      rp.className = 'lnk';
      rp.textContent = TT('pj_reply', 'Reply');
      rp.addEventListener('click', () => {
        if (el.querySelector('.rbox')) return;
        const box = document.createElement('div');
        box.className = 'rbox';
        const ta = document.createElement('input');
        ta.type = 'text';
        ta.maxLength = 600;
        ta.placeholder = TT('pj_reply_ph', 'Reply…');
        const go = document.createElement('button');
        go.className = 'btn pri';
        go.textContent = TT('pj_send', 'Send');
        go.addEventListener('click', () => post(ta.value, c.id, ta));
        ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') post(ta.value, c.id, ta); });
        box.appendChild(ta); box.appendChild(go);
        el.appendChild(box);
        ta.focus();
      });
      meta.appendChild(rp);
    }
    if (c.mine) {
      const del = document.createElement('button');
      del.className = 'lnk';
      del.textContent = TT('pj_delete', 'Delete');
      del.addEventListener('click', async () => {
        try {
          await fetch(API + '/comments/' + encodeURIComponent(c.id), {
            method: 'DELETE', headers: await authHeaders(),
          });
          await loadThread(p, panel);
        } catch (e) {}
      });
      meta.appendChild(del);
    }
    el.appendChild(meta);
    for (const r of (c.replies || [])) el.appendChild(draw(r, 1));
    return el;
  };

  // 预览用的那几条就地跟上:刚发出来的评论还没有人点赞,等下一次刷广场才出现在
  // 壁纸上是说不通的 —— 你刚说完的话,应该马上就能在自己的粒子里看到。
  // 九条,和列表接口一个数:壁纸上一屏三条,翻三屏。
  p.topComments = tree.slice(0, 9).map((c) => ({ body: c.body, author: c.author || null, likes: c.likes || 0 }));

  for (const c of tree) panel.appendChild(draw(c, 0));
  if (!tree.length) {
    const e = document.createElement('div');
    e.className = 'empty-note';
    e.textContent = TT('pj_no_comments', 'No comments yet — say the first thing.');
    panel.appendChild(e);
  }

  const box = document.createElement('div');
  box.className = 'rbox top';
  const ta = document.createElement('input');
  ta.type = 'text';
  ta.maxLength = 600;
  ta.placeholder = TT('pj_comment_ph', 'Add a comment…');
  const go = document.createElement('button');
  go.className = 'btn pri';
  go.textContent = TT('pj_send', 'Send');
  go.addEventListener('click', () => post(ta.value, null, ta));
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') post(ta.value, null, ta); });
  box.appendChild(ta); box.appendChild(go);
  panel.appendChild(box);
}

/* ── 正在干活的项目 ───────────────────────────────────────────────────── */

async function loadLive() {
  let cands = [];
  try { cands = await T.projectCandidates(); } catch (e) {}
  const card = $('#cardLive');
  const host = $('#liveList');
  host.innerHTML = '';
  card.style.display = cands.length ? '' : 'none';
  for (const c of cands) {
    host.appendChild(row(
      { title: c.name, subtitle: c.path, lines: [] },
      { actions: [[TT('pj_add_this', 'Add'), 'pri', () => add(c.path)]] },
    ));
  }
}

/* ── 代码小镇 ──────────────────────────────────────────────────────────────
   广场那座第一人称的粒子小镇(和手机、网页同一座,页面在 https://www.terseai.org/town-wall)
   开成桌面壁纸。壁纸窗口用 iframe 嵌着它(wallpaper.html 的「代码小镇」一段);这里只管:
     · 开 / 关 —— 写 wallpaper.json 的 town.on
     · 进去逛 —— wallpaper_town_walk:壁纸铺满屏幕、接管键鼠,Esc 还回来
     · 发布时挑一块地 —— POST /api/cloud/projects 带 plot(服务端保证一块地一个项目) */
const TOWN = { on: false, walking: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function townRefresh() {
  try {
    const c = await T.getWallpaperConfig();
    TOWN.on = !!(c && c.enabled !== false && c.town && c.town.on);
  } catch (e) {}
  paintTown();
}

function paintTown() {
  const on = $('#btnTown'), walk = $('#btnWalk'), st = $('#townState');
  if (!on) return;
  on.textContent = TOWN.on ? TT('tw_off', 'Turn off') : TT('tw_on', 'Turn on');
  on.className = 'btn' + (TOWN.on ? '' : ' pri');
  walk.textContent = TOWN.walking ? TT('tw_walking', 'Walking — press Esc to stop') : TT('tw_walk', 'Walk in');
  walk.className = 'btn' + (TOWN.walking ? ' on' : TOWN.on ? ' pri' : '');
  st.textContent = TOWN.walking ? TT('tw_st_walk', '● walking') : TOWN.on ? TT('tw_st_on', '● on your wallpaper') : TT('tw_st_off', 'off');
  st.className = 'state' + (TOWN.on ? ' live' : '');
}

async function setTownOn(on) {
  let c = {};
  try { c = (await T.getWallpaperConfig()) || {}; } catch (e) {}
  c = Object.assign({}, c);
  c.town = Object.assign({ budget: 0.8 }, c.town || {}, { on: !!on });
  if (on) c.enabled = true;
  if (!on && TOWN.walking) { try { await T.wallpaperTownWalk(false); } catch (e) {} }
  try { await T.setWallpaperConfig(c); } catch (e) {}
  // 壁纸本来关着的:开小镇就是要它出来
  if (on && T.setWallpaperEnabled) { try { await T.setWallpaperEnabled(true); } catch (e) {} }
  TOWN.on = !!on;
  paintTown();
  // 开小镇 = 默认就进去逛(灵动岛旁边的「操控小镇」按钮随时关)
  if (on && !TOWN.walking) { await sleep(3000); await walkTown(true); }
}

/** 进去逛。小镇还没开就先开,等它盖起来(页面加载 + 粒子聚拢要一两秒)。 */
async function walkTown(on) {
  if (on && !TOWN.on) { await setTownOn(true); return; }   // setTownOn 开完会自己进去
  let r = null;
  try { r = await T.wallpaperTownWalk(!!on); } catch (e) { r = null; }
  if (on && !(r && r.ok)) alert(TT('tw_walk_fail', 'The wallpaper window is not up yet — turn the wallpaper on in Wallpaper settings, then try again.'));
  else if (on && r && r.keys === false && r.trusted === false) axShow();
}

if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('wallpaper-town-walk', (e) => { TOWN.walking = !!e.payload; paintTown(); });
  window.__TAURI__.event.listen('wallpaper-config', (e) => {
    const c = e.payload || {};
    TOWN.on = !!(c.enabled !== false && c.town && c.town.on);
    paintTown();
  });
}

/* ── 辅助功能授权引导 ──────────────────────────────────────────────────────
   「操控小镇」要在系统层接管键盘和桌面上的拖动,这要辅助功能授权。Terse 没签名,
   每装一次新版,原来的授权就静静作废(系统设置里的勾看上去还是勾着的),而系统自己的
   授权框在列表里已有旧条目时根本不弹 —— 用户只会看到"按了没反应"。所以缺授权时
   Rust 把主窗口带到这一页、发 town-need-ax,这里弹出一步一步的引导,并每秒问一次状态:
   授权一到(Rust 那边会自动接上)就变绿、自己关掉、让出桌面。 */
let axTimer = 0;
function axShow() {
  const back = $('#axBack');
  if (!back || !back.hidden) return;
  back.hidden = false;
  axPaint(false);
  clearInterval(axTimer);
  axTimer = setInterval(async () => {
    let st = null;
    try { st = await window.__TAURI__.core.invoke('town_control_state'); } catch (e) {}
    if (st && st.keys) axDone();
  }, 1000);
}
function axPaint(ok) {
  $('#axSt').classList.toggle('ok', ok);
  $('#axStT').textContent = ok ? TT('ax_ok', 'Done — the town has the keyboard now. Enjoy the walk!')
                               : TT('ax_wait', 'Waiting for permission…');
}
function axHide() {
  clearInterval(axTimer);
  const back = $('#axBack');
  if (back) back.hidden = true;
}
function axDone() {
  clearInterval(axTimer);
  axPaint(true);
  setTimeout(async () => {
    axHide();
    // 主窗口让出桌面,人直接去逛
    try { await window.__TAURI__.window.getCurrentWindow().hide(); } catch (e) {}
  }, 1400);
}
if (window.__TAURI__ && window.__TAURI__.event) {
  window.__TAURI__.event.listen('town-need-ax', () => axShow());
  window.__TAURI__.event.listen('town-control', (e) => {
    const p = e.payload || {};
    if (p.on && p.keys && !$('#axBack').hidden) axDone();
    if (p.on && !p.keys && p.trusted === false) axShow();
    if (!p.on) axHide();
  });
}

/* 地块:和 town-plan.js(main 分支,小镇的图纸)的 plotSlot 同一个公式 —— 地图上画的就是
   别墅真正会站的位置。编号越小越靠镇中心(集市)。 */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
function plotSlot(k) {
  const r = 40 + 18 * Math.sqrt(k + 0.5), a = k * GOLDEN;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r };
}
/* 本机记住每个项目挑的那块地:重新发布时预先选好,「换地方」按钮上也写着 */
const LS_PLOTS = 'terse-town-plots';
function plotMap() { try { return JSON.parse(localStorage.getItem(LS_PLOTS) || '{}') || {}; } catch (e) { return {}; } }
function savedPlot(id) { const k = plotMap()[id]; return Number.isInteger(k) ? k : null; }
function rememberPlot(id, k) {
  const m = plotMap();
  if (k == null) delete m[id]; else m[id] = k;
  try { localStorage.setItem(LS_PLOTS, JSON.stringify(m)); } catch (e) {}
}
function plotLabel(cap) {
  const k = savedPlot(cap.id);
  return k == null ? TT('tw_move_auto', '📍 Choose a plot') : TT('tw_move', '📍 Plot #{n}').replace('{n}', k);
}

/** 发到广场,带上地块。成功 = 服务端的项目 id;地被抢了就再挑一次;取消 = null。 */
async function sendCapsule(cap, plot) {
  const { capsule } = await T.projectCapsule(cap.id);
  const body = { capsule, author: await myName() };
  if (plot != null) body.plot = plot;
  const r = await fetch(API, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, await authHeaders()),
    // 报上名字。广场上要看得见"这是谁做的" —— 身份头是一串哈希,人看的名字
    // 得单独给,和发评论同一个来源。
    body: JSON.stringify(body),
  });
  if (r.status === 409) {
    alert(TT('tw_taken', 'Somebody just built on plot #{n}. Pick another one.').replace('{n}', plot));
    const again = await pickPlot(cap);
    return again ? sendCapsule(cap, again.plot) : null;
  }
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json().catch(() => ({}));
  rememberPlot(cap.id, plot);
  return j.id || null;
}

/** 已经在广场上的项目换一块地(重新发布一次,内容不变,地换了)。 */
async function movePlot(cap) {
  try {
    const pick = await pickPlot(cap);
    if (!pick) return;
    const id = await sendCapsule(cap, pick.plot);
    renderMine();
    if (id) await showMyVilla(id);
  } catch (e) {
    const why = (e && e.message) ? String(e.message).slice(0, 180) : String(e);
    alert(TT('pj_pub_fail', 'Could not reach the plaza just now.') + '\n\n' + why);
  }
}

/** 发完了:带人去看自己的别墅(小镇开着就直接去;没开就问一声)。 */
async function showMyVilla(id) {
  if (!TOWN.on) {
    if (!confirm(TT('tw_go_on', 'Your villa is up. Turn on Code Town and walk over to it?'))) return;
    await setTownOn(true);
    await sleep(3500);
  } else if (!confirm(TT('tw_go', 'Your villa is up. Walk over to it now?'))) {
    try { await window.__TAURI__.event.emit('town-goto', { id }); } catch (e) {}
    return;
  }
  try { await window.__TAURI__.event.emit('town-goto', { id }); } catch (e) {}
  await walkTown(true);
}

/**
 * 挑一块地。画的是小镇的真实布局:中间是集市,地块按编号螺旋往外。
 * @returns {Promise<{plot:number|null}|null>} null = 取消;plot:null = 交给小镇自己排
 */
function pickPlot(cap) {
  return new Promise(async (resolve) => {
    const back = $('#pkBack'), cv = $('#pkMap'), info = $('#pkInfo'), okB = $('#pkOk');
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height, C = W / 2;
    let slots = 120, taken = [], err = '';
    try {
      const r = await fetch(API + '/plots', { headers: await authHeaders() });
      const j = await r.json();
      if (j && j.ok) { slots = j.slots || 120; taken = j.taken || []; } else err = 'plots';
    } catch (e) { err = String((e && e.message) || e); }
    const mineK = savedPlot(cap.id);
    const byPlot = new Map(taken.map((t) => [t.plot, t]));
    // 自己这个项目原来的那块地:对它来说是空的
    const isFree = (k) => !byPlot.has(k) || (k === mineK && byPlot.get(k).mine);
    const maxR = plotSlot(slots - 1).r + 34;
    const S = (C - 24) / maxR;
    const at = (k) => { const q = plotSlot(k); return [C + q.x * S, C + q.z * S]; };
    let sel = mineK != null && isFree(mineK) ? mineK : null;
    let hover = null;

    $('#pkTitle').textContent = TT('tw_pick_t', 'Pick a plot for your villa');
    $('#pkNote').textContent = TT('tw_pick_d', 'Each dot is a plot in Code Town — the closer to the middle, the closer to the market square. Grey rings are free; coloured dots already have a villa. Your plot stays yours: it does not move when other people publish.');
    $('#pkCancel').textContent = TT('tw_cancel', 'Cancel');
    $('#pkAuto').textContent = TT('tw_auto', 'Let the town place it');
    okB.textContent = TT('tw_build', 'Build here');

    function draw() {
      g.clearRect(0, 0, W, H);
      // 城墙外一圈暗绿(田),里面石板色
      g.fillStyle = '#0b120d'; g.beginPath(); g.arc(C, C, C - 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#10141c'; g.beginPath(); g.arc(C, C, (maxR - 10) * S, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(200,190,160,.35)'; g.lineWidth = 6;
      g.beginPath(); g.arc(C, C, (maxR - 10) * S, 0, Math.PI * 2); g.stroke();
      // 集市
      g.fillStyle = 'rgba(232,181,74,.22)'; g.beginPath(); g.arc(C, C, 26 * S, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(232,181,74,.9)'; g.font = '600 22px -apple-system, sans-serif'; g.textAlign = 'center';
      g.fillText(TT('tw_market', 'Market'), C, C + 8);
      for (let k = 0; k < slots; k++) {
        const [x, y] = at(k), t = byPlot.get(k);
        const free = isFree(k);
        if (!free && t) {
          g.fillStyle = LANG_COLOR[t.lang] || LANG_FALLBACK;
          g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
          if (t.mine) { g.strokeStyle = 'rgba(201,240,61,.9)'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke(); }
        } else {
          g.strokeStyle = k === hover ? 'rgba(201,240,61,.95)' : 'rgba(170,180,200,.42)';
          g.lineWidth = k === hover ? 3 : 2;
          g.beginPath(); g.arc(x, y, k === hover ? 11 : 8, 0, Math.PI * 2); g.stroke();
        }
        if (k === sel) {
          g.fillStyle = '#C9F03D'; g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#0B0D10'; g.font = '800 14px -apple-system, sans-serif'; g.fillText('★', x, y + 5);
        }
      }
      okB.disabled = sel == null;
    }
    function describe(k) {
      if (k == null) {
        info.innerHTML = err ? TT('tw_pick_err', 'Could not load the town map — you can still let the town place it.')
          : TT('tw_pick_hint', 'Hover a plot to see who lives there, click a free one to choose it.');
        return;
      }
      const q = plotSlot(k), t = byPlot.get(k), m = Math.round(q.r);
      const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      if (isFree(k)) info.innerHTML = TT('tw_pick_free', '<b>Plot #{n}</b> · free · {m} m from the market').replace('{n}', k).replace('{m}', m);
      else info.innerHTML = TT('tw_pick_taken', 'Plot #{n} · {title}{lang} · {m} m from the market')
        .replace('{n}', k).replace('{title}', esc(t.title) + (t.mine ? ' ★' : '')).replace('{lang}', t.lang ? ' (' + esc(t.lang) + ')' : '').replace('{m}', m);
    }
    function nearest(ev) {
      const rc = cv.getBoundingClientRect();
      const px = (ev.clientX - rc.left) * (W / rc.width), py = (ev.clientY - rc.top) * (H / rc.height);
      let best = null, bd = 26;
      for (let k = 0; k < slots; k++) {
        const [x, y] = at(k), d = Math.hypot(px - x, py - y);
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    }
    cv.onmousemove = (ev) => { const k = nearest(ev); if (k !== hover) { hover = k; draw(); describe(k != null ? k : sel); } };
    cv.onmouseleave = () => { hover = null; draw(); describe(sel); };
    cv.onclick = (ev) => { const k = nearest(ev); if (k != null && isFree(k)) { sel = k; draw(); describe(k); } };
    const done = (v) => {
      back.hidden = true;
      cv.onmousemove = cv.onmouseleave = cv.onclick = null;
      $('#pkOk').onclick = $('#pkAuto').onclick = $('#pkCancel').onclick = back.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    $('#pkOk').onclick = () => { if (sel != null) done({ plot: sel }); };
    $('#pkAuto').onclick = () => done({ plot: null });
    $('#pkCancel').onclick = () => done(null);
    back.onclick = (e) => { if (e.target === back) done(null); };
    document.addEventListener('keydown', onKey, true);
    back.hidden = false;
    draw();
    describe(sel);
  });
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

function tab(which) {
  $('#tabMine').classList.toggle('on', which === 'mine');
  $('#tabPlaza').classList.toggle('on', which === 'plaza');
  $('#cardMine').style.display = which === 'mine' ? '' : 'none';
  $('#cardLive').style.display = (which === 'mine' && $('#liveList').children.length) ? '' : 'none';
  $('#cardPlaza').style.display = which === 'plaza' ? '' : 'none';
  if (which === 'plaza' && !plaza.length) loadPlaza();
}

(async () => {
  $('#btnBack').addEventListener('click', () => { try { T.navigateBack(); } catch (e) {} });
  $('#tabMine').addEventListener('click', () => tab('mine'));
  $('#tabPlaza').addEventListener('click', () => tab('plaza'));
  $('#btnReload').addEventListener('click', loadPlaza);
  $('#btnTown').addEventListener('click', () => setTownOn(!TOWN.on));
  $('#axOpen').addEventListener('click', () => {
    try { window.__TAURI__.core.invoke('messages_open_settings', { which: 'accessibility' }); } catch (e) {}
  });
  $('#axLater').addEventListener('click', () => {
    axHide();
    walkTown(false);
  });
  // 刚被带到这一页(或自己打开的):操控开着却没接管到键盘 → 直接弹引导
  (async () => {
    try {
      const st = await window.__TAURI__.core.invoke('town_control_state');
      if (st && st.on && !st.keys && st.trusted === false) axShow();
    } catch (e) {}
  })();
  $('#btnWalk').addEventListener('click', () => walkTown(!TOWN.walking));
  townRefresh();
  $('#btnAdd').addEventListener('click', async () => {
    // 系统的文件夹选择器。走 Rust 那条已经在用的命令(知识图谱也用它),
    // 而不是 window.__TAURI__.dialog —— 后者要 withGlobalTauri 把插件 JS 也打进去。
    try {
      const p = await T.pickFolder();
      if (p) add(p);
    } catch (e) {}
  });

  try { mine = await T.projectList(); } catch (e) { mine = []; }
  renderMine();
  await loadLive();
  tab('mine');
})();
