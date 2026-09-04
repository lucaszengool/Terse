/**
 * projects.js — 项目粒子这一页的逻辑。
 *
 * 一个项目在这里只有三个动作:**预览**(在自己的壁纸上演一段)、**编辑**(标题、简介、
 * 封面 —— 改过的字段以后重扫不会被覆盖)、**发到广场**(把胶囊传上去)。
 *
 * 广场那半边刻意做得很轻:列表拿到的就是一颗颗胶囊,点预览时**不再请求服务器** ——
 * 粒子是在本机由胶囊生成的。服务器从头到尾只做一件事:存 JSON、发 JSON。
 */
const T = window.terse;
const $ = (s) => document.querySelector(s);

/** 广场的地址。和 app.js 里其它云功能同一个来源。 */
const API = (window.TERSE_API || 'https://api.terseai.org') + '/api/cloud/projects';

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
const LANG_COLOR = {
  rust: '#dea584', ts: '#3178c6', js: '#f1e05a', python: '#3572A5', go: '#00ADD8',
  swift: '#F05138', kotlin: '#A97BFF', java: '#b07219', c: '#555555', 'c++': '#f34b7d',
  ruby: '#701516', php: '#4F5D95', 'c#': '#178600', html: '#e34c26', css: '#563d7c',
  shell: '#89e051', sql: '#e38c00',
};

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
    const c = LANG_COLOR[name] || '#8A8A90';
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

function renderMine() {
  const host = $('#mineList');
  host.innerHTML = '';
  $('#mineEmpty').style.display = mine.length ? 'none' : '';
  for (const cap of mine) {
    const el = row(cap, {
      actions: [
        [TT('pj_preview', 'Preview'), 'pri', () => preview(cap)],
        [TT('pj_edit', 'Edit'), '', () => { editing = editing === cap.id ? null : cap.id; renderMine(); }],
        [cap.published ? TT('pj_published', 'In the plaza') : TT('pj_publish', 'Publish'),
         cap.published ? 'on' : '', () => publish(cap)],
        [TT('pj_rescan', 'Rescan'), '', () => add(cap.path)],
        [TT('pj_remove', 'Remove'), '', () => remove(cap)],
      ],
    });
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
    <label>${TT('pj_f_lines', 'Lines that become particles (comma separated)')}</label>
    <input type="text" id="eLines" maxlength="120">
    <div class="row">
      <button class="btn" id="eCover">${TT('pj_f_cover', 'Replace image…')}</button>
      <button class="btn pri" id="eSave">${TT('pj_f_save', 'Save')}</button>
      <span class="size" id="eSize"></span>
    </div>`;
  box.querySelector('#eTitle').value = cap.title || '';
  box.querySelector('#eSub').value = cap.subtitle || '';
  box.querySelector('#eLines').value = (cap.lines || []).join(', ');

  // 胶囊有多大 = 这个功能的服务器成本。让人看得见,而不是藏起来。
  T.projectCapsule(cap.id)
    .then((r) => { box.querySelector('#eSize').textContent = (r.bytes / 1024).toFixed(1) + ' KB'; })
    .catch(() => {});

  box.querySelector('#eCover').addEventListener('click', () => pickCover(cap));
  box.querySelector('#eSave').addEventListener('click', async () => {
    const patch = {
      title: box.querySelector('#eTitle').value.trim(),
      subtitle: box.querySelector('#eSub').value.trim(),
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
      const { capsule } = await T.projectCapsule(cap.id);
      const r = await fetch(API, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, await authHeaders()),
        body: JSON.stringify({ capsule }),
      });
      if (!r.ok) throw new Error(await r.text());
      const next = await T.projectUpdate(cap.id, { published: true });
      Object.assign(cap, next);
    }
    renderMine();
  } catch (e) {
    alert(TT('pj_pub_fail', 'Could not reach the plaza just now.'));
  }
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
    host.appendChild(row(p.capsule || p, {
      actions: [[TT('pj_preview', 'Preview'), 'pri', () => {
        preview(p.capsule || p);
        // 尽力而为的计数:数不准没关系,但这是作者唯一能看到的反馈。
        fetch(API + '/' + encodeURIComponent(p.id) + '/view', { method: 'POST' }).catch(() => {});
      }]],
    }));
  }
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
