/* ══════════════════════════════════════════════════════════════════
   Terse guided sidebar tour.
   Spotlights the left nav one group at a time and names every button in
   it — 6 short steps rather than 18 separate coach marks, which is the
   pattern that reads as thorough without stalling first use.
   Runs once after onboarding; the "?" in the sidebar replays it.
   Exposes: window.TERSE_TOUR = { start, hasSeen }.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const DONE_KEY = 'terse-tour-done';

  // ── strings (en + zh fully; other languages fall back to English) ──
  const STR = {
    en: {
      skip: 'Skip', back: 'Back', next: 'Next', done: 'Got it',
      step: 'Step {n} of {t}',
      s0_t: 'This is your control center',
      s0_s: 'Every Terse feature lives in this sidebar. Here is what each button does — 30 seconds, then you are on your own.',
      s1_t: 'Monitor — see what your agents cost',
      s1_s: 'Live visibility into every running agent.',
      s2_t: 'Optimize — cut the waste',
      s2_s: 'Find what is burning tokens, then fix it.',
      s3_t: 'Secure — stay in control',
      s3_s: 'Watch what your agents load and get told when something goes wrong.',
      s4_t: 'Library — your history & knowledge',
      s4_s: 'Everything Terse has recorded, plus your own reusable material.',
      s5_t: 'Tools & personalization',
      s5_s: 'The pinned row at the bottom of the sidebar.',
      s6_t: 'That is the whole app',
      s6_s: 'Start with Doctor — it scans your agents and tells you exactly what to fix first. Press ? in the sidebar to replay this guide anytime.',
      overview: 'Overview', overview_d: 'Today at a glance — tokens, spend and what needs attention.',
      observe: 'Observe', observe_d: 'Live feed of what each agent is sending and receiving.',
      stats: 'Stats', stats_d: 'Where your tokens actually go, by agent, model and day.',
      connection: 'Connection', connection_d: 'Checks your agents can reach their models, and fixes what cannot.',
      doctor: 'Doctor', doctor_d: 'Full health scan — ranked findings with a one-click fix for each.',
      cleanup: 'Cleanup', cleanup_d: 'Reclaims stale caches, logs and transcripts your agents never prune.',
      rules: 'Rules', rules_d: 'Your own optimization rules — words to always cut or never touch.',
      mcp: 'MCP', mcp_d: 'Every MCP server your agents load, and what each one costs you per request.',
      alerts: 'Alerts', alerts_d: 'Where alerts land, and which ones reach your desktop, Slack or phone.',
      prompts: 'Prompts', prompts_d: 'Save prompts that work and reuse them without retyping.',
      graph: 'Graph', graph_d: 'A live map of your codebase your agents read instead of grepping.',
      history: 'History', history_d: 'Past sessions with their tokens, cost and outcome.',
      team: 'Team', team_d: 'Your and your teammates’ agents working in one shared view.',
      farm: 'Farm', farm_d: 'A small farm that grows while your agents work.',
      boost: 'Speed Up', boost_d: 'Trims prompts harder so agents answer faster and cost less.',
      wallpaper: 'Wallpaper', wallpaper_d: 'Live desktop wallpaper that reacts to your token usage.',
      pals: 'Pals', pals_d: 'A desktop pet that reacts to your agents.',
      settings: 'Settings', settings_d: 'Modes, theme, language, hotkeys and your account.',
    },
    'zh-Hans': {
      skip: '跳过', back: '上一步', next: '下一步', done: '知道了',
      step: '第 {n} 步 / 共 {t} 步',
      s0_t: '这里是你的控制中心',
      s0_s: 'Terse 的所有功能都在左侧这一栏。下面逐个介绍每个按钮的作用 —— 只需 30 秒。',
      s1_t: '监控 —— 看清智能体的花费',
      s1_s: '实时掌握每个运行中的智能体。',
      s2_t: '优化 —— 削减浪费',
      s2_s: '找出正在烧 token 的地方，然后修好它。',
      s3_t: '安全 —— 始终掌控',
      s3_s: '看住智能体加载了什么，出问题时第一时间通知你。',
      s4_t: '资料库 —— 你的历史与知识',
      s4_s: 'Terse 记录的一切，加上你自己可复用的素材。',
      s5_t: '工具与个性化',
      s5_s: '固定在侧边栏底部的这一排。',
      s6_t: '这就是全部功能',
      s6_s: '建议从「体检」开始 —— 它会扫描你的智能体，直接告诉你先修哪一项。随时点击侧边栏的 ? 可重看本指南。',
      overview: '概览', overview_d: '今日全貌 —— token、花费，以及需要关注的问题。',
      observe: '观察', observe_d: '实时查看每个智能体正在收发什么内容。',
      stats: '统计', stats_d: '你的 token 到底花在哪：按智能体、模型和日期拆解。',
      connection: '连接', connection_d: '检查智能体能否连上模型，并修复连不上的情况。',
      doctor: '体检', doctor_d: '完整健康扫描 —— 按优先级排序的问题，每项都可一键修复。',
      cleanup: '清理', cleanup_d: '回收智能体从不清理的陈旧缓存、日志和会话记录。',
      rules: '规则', rules_d: '你自己的优化规则 —— 哪些词必删，哪些词绝不能动。',
      mcp: 'MCP', mcp_d: '智能体加载的每个 MCP 服务器，以及它们每次请求的开销。',
      alerts: '提醒', alerts_d: '提醒汇总于此，并决定哪些推送到桌面、Slack 或手机。',
      prompts: '提示词', prompts_d: '保存好用的提示词，下次直接复用，无需重写。',
      graph: '知识图谱', graph_d: '你代码库的实时地图，智能体读它就不必再全局搜索。',
      history: '历史', history_d: '过往会话及其 token、花费与结果。',
      team: '团队', team_d: '你和队友的智能体汇聚在同一个视图中。',
      farm: '农场', farm_d: '智能体工作时，你的小农场同步生长。',
      boost: '加速', boost_d: '更激进地精简提示词，让智能体回得更快、花得更少。',
      wallpaper: '壁纸', wallpaper_d: '随 token 用量实时变化的动态桌面壁纸。',
      pals: '伙伴', pals_d: '会对你的智能体做出反应的桌面宠物。',
      settings: '设置', settings_d: '模式、主题、语言、快捷键和你的账户。',
    },
    'zh-Hant': {
      skip: '略過', back: '上一步', next: '下一步', done: '知道了',
      step: '第 {n} 步 / 共 {t} 步',
      s0_t: '這裡是你的控制中心',
      s0_s: 'Terse 的所有功能都在左側這一欄。以下逐一介紹每個按鈕的作用 —— 只需 30 秒。',
      s1_t: '監控 —— 看清智能體的花費',
      s1_s: '即時掌握每個執行中的智能體。',
      s2_t: '最佳化 —— 削減浪費',
      s2_s: '找出正在燒 token 的地方，然後修好它。',
      s3_t: '安全 —— 始終掌控',
      s3_s: '看住智能體載入了什麼，出問題時第一時間通知你。',
      s4_t: '資料庫 —— 你的歷史與知識',
      s4_s: 'Terse 記錄的一切，加上你自己可重複使用的素材。',
      s5_t: '工具與個人化',
      s5_s: '固定在側邊欄底部的這一排。',
      s6_t: '這就是全部功能',
      s6_s: '建議從「體檢」開始 —— 它會掃描你的智能體，直接告訴你先修哪一項。隨時點側邊欄的 ? 可重看本指南。',
      overview: '總覽', overview_d: '今日全貌 —— token、花費，以及需要關注的問題。',
      observe: '觀察', observe_d: '即時檢視每個智能體正在收發什麼內容。',
      stats: '統計', stats_d: '你的 token 到底花在哪：依智能體、模型和日期拆解。',
      connection: '連線', connection_d: '檢查智能體能否連上模型，並修復連不上的情況。',
      doctor: '體檢', doctor_d: '完整健康掃描 —— 依優先順序排列的問題，每項都可一鍵修復。',
      cleanup: '清理', cleanup_d: '回收智能體從不清理的陳舊快取、日誌和工作階段記錄。',
      rules: '規則', rules_d: '你自己的最佳化規則 —— 哪些詞必刪，哪些詞絕不能動。',
      mcp: 'MCP', mcp_d: '智能體載入的每個 MCP 伺服器，以及它們每次請求的開銷。',
      alerts: '提醒', alerts_d: '提醒彙整於此，並決定哪些推送到桌面、Slack 或手機。',
      prompts: '提示詞', prompts_d: '儲存好用的提示詞，下次直接重用，無須重寫。',
      graph: '知識圖譜', graph_d: '你程式碼庫的即時地圖，智能體讀它就不必再全域搜尋。',
      history: '歷史', history_d: '過往工作階段及其 token、花費與結果。',
      team: '團隊', team_d: '你和隊友的智能體匯聚在同一個檢視中。',
      farm: '農場', farm_d: '智能體工作時，你的小農場同步生長。',
      boost: '加速', boost_d: '更積極地精簡提示詞，讓智能體回得更快、花得更少。',
      wallpaper: '桌布', wallpaper_d: '隨 token 用量即時變化的動態桌布。',
      pals: '夥伴', pals_d: '會對你的智能體做出反應的桌面寵物。',
      settings: '設定', settings_d: '模式、主題、語言、快速鍵和你的帳戶。',
    },
  };
  function lang() { try { return (window.i18n && window.i18n.getLang()) || 'en'; } catch { return 'en'; } }
  function L(k, p) {
    const d = STR[lang()] || STR.en;
    let s = d[k] != null ? d[k] : (STR.en[k] != null ? STR.en[k] : k);
    if (p) for (const x in p) s = s.replace('{' + x + '}', p[x]);
    return s;
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // Each step spotlights a run of sidebar buttons and names every one of them.
  // `pages` are data-page values; `sel` is used for the non-nav bottom items.
  const STEPS = [
    { key: 's0', target: '#sidebar', pages: [] },
    { key: 's1', pages: ['overview', 'observe', 'stats', 'connection'], icons: ['▦', '◉', '▮', '≋'] },
    { key: 's2', pages: ['doctor', 'cleanup', 'rules'], icons: ['🩺', '🧹', '📐'] },
    { key: 's3', pages: ['mcp', 'alerts'], icons: ['🛡', '🔔'] },
    { key: 's4', pages: ['prompts', 'graph', 'history', 'team', 'farm'], icons: ['💬', '🕸', '🕘', '👥', '🌾'] },
    { key: 's5', pages: ['boost', 'wallpaper', 'pals', 'settings'], icons: ['⚡', '🖼', '🐾', '⚙'] },
    { key: 's6', target: '#sidebar', pages: [] },
  ];
  const PRO = new Set(['stats', 'connection', 'cleanup', 'team', 'boost']);

  let root, hole, card, i = 0;

  // rAF never fires while the window is hidden or minimized, and the tour can
  // be kicked off from the onboarding hand-off before the window is on screen.
  // Falling back to a timer keeps it from rendering an empty card in that case.
  function nextFrame(fn) {
    if (document.hidden) setTimeout(fn, 0);
    else requestAnimationFrame(fn);
  }

  function build() {
    root = document.createElement('div');
    root.id = 'tourRoot';
    root.innerHTML = '<div class="tour-catch"></div><div class="tour-hole"></div><div class="tour-card"></div>';
    document.body.appendChild(root);
    hole = root.querySelector('.tour-hole');
    card = root.querySelector('.tour-card');
    root.querySelector('.tour-catch').addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => {
      if (!root.classList.contains('show')) return;
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    });
  }

  function targets(step) {
    if (step.target) return [document.querySelector(step.target)].filter(Boolean);
    return step.pages.map(p => document.querySelector(`.sb-item[data-page="${p}"]`)).filter(Boolean);
  }

  function go(n) {
    if (n < 0) return;
    if (n >= STEPS.length) return finish();
    const fwd = n >= i;               // capture direction before i moves
    i = n;
    const step = STEPS[i];
    const els = targets(step);
    // A group whose items are all hidden gets skipped in the travel direction;
    // stepping back here would trap Next in a loop between the two steps.
    if (!els.length) return go(fwd ? n + 1 : n - 1);

    // The nav scrolls internally, so bring the whole run into view before
    // measuring — otherwise a group below the fold spotlights empty space.
    const nav = els[0].closest('.sb-nav');
    if (nav) {
      const first = els[0], last = els[els.length - 1];
      const runTop = first.offsetTop, runH = last.offsetTop + last.offsetHeight - runTop;
      nav.scrollTop = Math.max(0, runTop - Math.max(0, (nav.clientHeight - runH) / 2));
    }

    const rows = step.pages.map((p, k) => `
      <div class="tour-row">
        <div class="tour-ic">${esc((step.icons && step.icons[k]) || '•')}</div>
        <div class="tour-rt">
          <div class="tour-rn">${esc(L(p))}${PRO.has(p) ? '<span class="pro">PRO</span>' : ''}</div>
          <div class="tour-rd">${esc(L(p + '_d'))}</div>
        </div>
      </div>`).join('');

    const last = i === STEPS.length - 1;
    card.innerHTML = `
      <button class="tour-skip" type="button">${esc(L('skip'))}</button>
      <div class="tour-step">${esc(L('step', { n: i + 1, t: STEPS.length }))}</div>
      <div class="tour-title">${esc(L(step.key + '_t'))}</div>
      <div class="tour-sub">${esc(L(step.key + '_s'))}</div>
      ${rows ? `<div class="tour-list">${rows}</div>` : ''}
      <div class="tour-foot">
        <div class="tour-dots">${STEPS.map((_, k) => `<div class="tour-dot${k === i ? ' on' : ''}"></div>`).join('')}</div>
        ${i > 0 ? `<button class="tour-btn ghost" data-go="back">${esc(L('back'))}</button>` : ''}
        <button class="tour-btn" data-go="next">${esc(last ? L('done') : L('next'))}</button>
      </div>`;
    card.querySelector('.tour-skip').addEventListener('click', finish);
    card.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click',
      () => go(b.dataset.go === 'back' ? i - 1 : i + 1)));

    nextFrame(() => place(els));
  }

  // Spotlight the union rect of the highlighted run and park the card beside it.
  function place(els) {
    const rs = els.map(e => e.getBoundingClientRect());
    const top = Math.min(...rs.map(r => r.top)) - 5;
    const left = Math.min(...rs.map(r => r.left)) - 5;
    const right = Math.max(...rs.map(r => r.right)) + 5;
    const bottom = Math.max(...rs.map(r => r.bottom)) + 5;
    hole.style.top = top + 'px';
    hole.style.left = left + 'px';
    hole.style.width = (right - left) + 'px';
    hole.style.height = (bottom - top) + 'px';

    const ch = card.getBoundingClientRect().height;
    const wantTop = top + (bottom - top) / 2 - ch / 2;
    const cardTop = Math.max(12, Math.min(window.innerHeight - ch - 12, wantTop));
    card.style.left = (right + 16) + 'px';
    card.style.top = cardTop + 'px';
    card.style.setProperty('--arrow', Math.max(14, Math.min(ch - 26, top + (bottom - top) / 2 - cardTop - 5)) + 'px');
  }

  function finish() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch {}
    if (root) root.classList.remove('show');
  }

  function start() {
    if (!root) build();
    i = 0;
    root.classList.add('show');
    nextFrame(() => go(0));
  }

  const replace = () => { if (root && root.classList.contains('show')) go(i); };
  window.addEventListener('resize', replace);
  // Anything measured while hidden was laid out against a stale viewport.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) replace(); });

  window.TERSE_TOUR = {
    start,
    hasSeen() { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; } },
    reset() { try { localStorage.removeItem(DONE_KEY); } catch {} },
  };

  document.getElementById('sbHelp')?.addEventListener('click', start);
})();
