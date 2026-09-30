/**
 * broadcast.js —— 全员广播:服务端发一条,这台机器**看到一次**,关掉就不再出现。
 *
 * 平时什么都不画 —— 接口没有公告时返回 `{items:[]}`,这里直接返回,界面上一个像素都不多。
 *
 * 几条刻意的取舍(和服务端 api/broadcast.js 顶上那段对着看):
 *   · **"关过了"按 `id@rev` 记**,不是只按 id。公告发出去之后我改了文案,rev 会 +1,
 *     于是关掉过的人会再看到一次新版本 —— 只按 id 记的话,改过的字永远送不到已经关掉的人。
 *   · **启动拉一次 + 六小时一次心跳**,不做秒级轮询。公告不是实时消息,
 *     为它常驻一条连接是拿所有用户的电池换一件没人等着看的事。
 *   · 任何一步失败都**安静地当没有公告**:启动路径上的东西不许因为公告服务抽风而出声。
 *   · 一次只显示一条(服务端也只发一条)。同时挂三条横幅的界面没人看。
 */

const BASE = (() => {
  try { return localStorage.getItem('terse.bc.base') || 'https://www.terseai.org'; }
  catch (e) { return 'https://www.terseai.org'; }
})();
const KEY = 'terse.bc.dismissed';
const EVERY = 6 * 60 * 60 * 1000;

function dismissed() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
}
function remember(tag) {
  try {
    const all = dismissed();
    if (!all.includes(tag)) all.push(tag);
    // 只留最近 50 条:这个列表是"我关过什么",不需要长成一部编年史
    localStorage.setItem(KEY, JSON.stringify(all.slice(-50)));
  } catch (e) {}
}

function platform() {
  try { return /Windows/i.test(navigator.userAgent) ? 'windows' : 'mac'; } catch (e) { return null; }
}

function openLink(url) {
  try {
    if (window.terse && window.terse.openExternal) { window.terse.openExternal(url); return; }
  } catch (e) {}
  try { window.open(url, '_blank', 'noopener'); } catch (e) {}
}

function show(item) {
  const tag = `${item.id}@${item.rev || 1}`;
  if (dismissed().includes(tag)) return;
  if (document.getElementById('bcCard')) return;      // 一次只挂一条

  const card = document.createElement('div');
  card.id = 'bcCard';
  card.className = 'bc-card bc-' + (item.level || 'info');
  card.setAttribute('role', 'status');

  const h = document.createElement('div');
  h.className = 'bc-title';
  h.textContent = item.title || '';
  card.appendChild(h);

  if (item.body) {
    const p = document.createElement('div');
    p.className = 'bc-body';
    // 刻意 textContent:这条字是从服务端来的,不给它一个往界面里塞标签的机会
    p.textContent = item.body;
    card.appendChild(p);
  }

  const row = document.createElement('div');
  row.className = 'bc-row';
  if (item.ctaUrl) {
    const a = document.createElement('button');
    a.className = 'bc-cta';
    a.textContent = item.ctaLabel || '查看';
    a.addEventListener('click', () => { openLink(item.ctaUrl); });
    row.appendChild(a);
  }
  const x = document.createElement('button');
  x.className = 'bc-close';
  x.textContent = (window.i18n && window.i18n.t) ? (window.i18n.t('bc_dismiss') || '知道了') : '知道了';
  x.addEventListener('click', () => { remember(tag); card.remove(); });
  row.appendChild(x);
  card.appendChild(row);

  document.body.appendChild(card);
}

async function poll() {
  try {
    const url = `${BASE}/api/broadcast?platform=${encodeURIComponent(platform() || '')}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);   // 公告不值得让人等
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return;
    const data = await res.json();
    const item = (data && data.items && data.items[0]) || null;
    if (item && item.id && item.title) show(item);
  } catch (e) { /* 安静地当没有公告 */ }
}

export function initBroadcast() {
  // 启动那一下不和首屏抢带宽,等界面安顿下来再问
  setTimeout(poll, 4000);
  setInterval(poll, EVERY);
}

initBroadcast();
