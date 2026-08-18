/* ══════════════════════════════════════════════════════════════════
   Terse desktop alert toasts.
   A frameless always-on-top window pinned top-right that renders the
   alert layer's notifications in Terse's own theme (replacing the OS
   notification banner, which we could neither theme nor translate).
   The window resizes to the card stack and hides itself when empty.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const LIFE_MS = 9000;
  const MAX_CARDS = 4;
  const stack = document.getElementById('stack');

  // ── strings (en + zh fully; other languages fall back to English) ──
  const STR = {
    en: {
      k_doctor: 'Doctor', k_cleanup: 'Cleanup', k_budget: 'Budget', k_cache: 'Cache',
      k_routing: 'Routing', k_context: 'Context', k_agent: 'Agent', k_summary: 'Summary', k_digest: 'Digest',
      a_doctor: 'Open Doctor', a_cleanup: 'Clean up', a_stats: 'Open Stats', a_budget: 'Open Budget',
      a_alerts: 'Open Alerts', a_team: 'Open Team', a_open: 'Open',
      snooze: 'Snooze 1h', dismiss: 'Dismiss',
    },
    'zh-Hans': {
      k_doctor: '体检', k_cleanup: '清理', k_budget: '预算', k_cache: '缓存',
      k_routing: '模型路由', k_context: '上下文', k_agent: '智能体', k_summary: '会话总结', k_digest: '周报',
      a_doctor: '打开体检', a_cleanup: '立即清理', a_stats: '查看统计', a_budget: '查看预算',
      a_alerts: '查看提醒', a_team: '打开团队', a_open: '打开',
      snooze: '静音 1 小时', dismiss: '忽略',
    },
    'zh-Hant': {
      k_doctor: '體檢', k_cleanup: '清理', k_budget: '預算', k_cache: '快取',
      k_routing: '模型路由', k_context: '上下文', k_agent: '智能體', k_summary: '工作階段總結', k_digest: '週報',
      a_doctor: '開啟體檢', a_cleanup: '立即清理', a_stats: '檢視統計', a_budget: '檢視預算',
      a_alerts: '檢視提醒', a_team: '開啟團隊', a_open: '開啟',
      snooze: '靜音 1 小時', dismiss: '忽略',
    },
  };
  function lang() { try { return (window.i18n && window.i18n.getLang()) || 'en'; } catch { return 'en'; } }
  function L(k) { const d = STR[lang()] || STR.en; return d[k] || STR.en[k] || k; }

  const KIND_ICON = {
    doctor: '🩺', cleanup: '🧹', budget: '💰', cache: '⚡', routing: '🔀',
    context: '🪟', agent: '🤖', summary: '📋', digest: '📨',
  };
  const ACTION_LABEL = {
    'open-doctor': 'a_doctor', 'open-cleanup': 'a_cleanup', 'open-stats': 'a_stats',
    'open-budget': 'a_budget', 'open-alerts': 'a_alerts', 'open-team': 'a_team',
  };

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // Rust shows the window and emits in the same breath, so the webview can
  // still be hidden for a frame — and a missed rAF would leave the card
  // un-animated in a window that never resized to fit it.
  function nextFrame(fn) {
    if (document.hidden) setTimeout(fn, 0);
    else requestAnimationFrame(fn);
  }

  // Window is sized to the card stack so the rest of the screen stays clickable.
  function syncSize() {
    const cards = stack.querySelectorAll('.tt');
    if (!cards.length) { invoke('toast_hide').catch(() => {}); return; }
    const h = Math.ceil(stack.getBoundingClientRect().height) + 8;
    invoke('toast_resize', { h }).catch(() => {});
  }

  function dismiss(card) {
    if (card.dataset.gone) return;
    card.dataset.gone = '1';
    clearTimeout(+card.dataset.timer);
    card.classList.remove('in');
    card.classList.add('out');
    setTimeout(() => { card.remove(); syncSize(); }, 320);
  }

  function render(a) {
    const kind = String(a.kind || 'doctor');
    const sev = String(a.severity || 'low').toLowerCase();
    const card = document.createElement('div');
    card.className = 'tt sev-' + sev;

    const actKey = ACTION_LABEL[a.action];
    card.innerHTML = `
      <div class="tt-top">
        <div class="tt-ic">${esc(KIND_ICON[kind] || '🔔')}</div>
        <span class="tt-kind">${esc(L('k_' + kind))}</span>
        <span class="tt-sp"></span>
        <button class="tt-x" type="button" title="${esc(L('dismiss'))}">✕</button>
      </div>
      <div class="tt-title">${esc(a.title || '')}</div>
      ${a.body ? `<div class="tt-body">${esc(a.body)}</div>` : ''}
      <div class="tt-acts">
        ${actKey ? `<button class="tt-btn" type="button" data-act="${esc(a.action)}">${esc(L(actKey))}</button>` : ''}
        <button class="tt-btn ghost" type="button" data-snooze="${esc(kind)}">${esc(L('snooze'))}</button>
      </div>
      <div class="tt-life"><i></i></div>`;

    card.querySelector('.tt-x').addEventListener('click', () => dismiss(card));
    const go = card.querySelector('[data-act]');
    if (go) go.addEventListener('click', () => {
      invoke('toast_action', { action: go.dataset.act }).catch(() => {});
      dismiss(card);
    });
    card.querySelector('[data-snooze]').addEventListener('click', (e) => {
      invoke('snooze_alert_kind', { kind: e.currentTarget.dataset.snooze, minutes: 60 }).catch(() => {});
      dismiss(card);
    });

    // Hovering the card pauses its life bar so a user reading it isn't cut off.
    const life = card.querySelector('.tt-life > i');
    life.style.animation = `ttDrain ${LIFE_MS}ms linear forwards`;
    card.addEventListener('mouseenter', () => {
      life.style.animationPlayState = 'paused';
      clearTimeout(+card.dataset.timer);
    });
    card.addEventListener('mouseleave', () => {
      life.style.animationPlayState = 'running';
      card.dataset.timer = String(setTimeout(() => dismiss(card), LIFE_MS / 2));
    });

    stack.appendChild(card);
    while (stack.children.length > MAX_CARDS) dismiss(stack.firstElementChild);
    nextFrame(() => { card.classList.add('in'); syncSize(); });
    card.dataset.timer = String(setTimeout(() => dismiss(card), LIFE_MS));
  }

  listen('terse-toast', (e) => { if (e && e.payload) render(e.payload); });
  window.addEventListener('resize', syncSize);
})();
