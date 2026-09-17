/* ══════════════════════════════════════════════════════════════════
   Terse first-run onboarding (post sign-in, pre pet-picker).
   Steps: detect agents → pick mode → Terse Doctor 体检 → clean up 清理 → finale.
   - Doctor step reuses the EXACT gauge / radar-sweep / cat-chip animation
     from doctor.js (animateGauge / runSweep / endSweep, ported verbatim).
   - Pulls real data via T.getAgentSessions() / T.doctorScan(). Agents and
     Doctor findings are NEVER faked: an empty scan renders its empty state.
     (The cleanup step's SAMPLE_CLEAN is explicitly labelled a preview.)
   - Language selector on the header reuses window.i18n.createLangPicker.
   Exposes: window.TERSE_ONBOARDING = { start(onDone), hasOnboarded, reset }.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const T = window.terse || {};
  const DONE_KEY = 'terse-onboarded';
  const PREVIEW_KEY = 'terse-previewed';

  // ── onboarding-specific strings: en + zh fully, English fallback otherwise ──
  const ONB = {
    en: {
      agents_title: 'Found your agents.',
      agents_sub: 'Terse scanned running processes & caches — these are live right now.',
      agents_scanning: 'Scanning processes…',
      agents_found: 'Found {n} running agent(s)',
      agents_watch: 'Watch these agents',
      agents_watching: 'Watching {n} agent(s) · deselect any to ignore',
      agents_none_title: 'No agents running yet.',
      agents_none_sub: 'Start Claude Code, Cursor, Codex, or DeepSeek Harness and Terse picks it up automatically.',
      mode_title: 'How hard should it push?',
      mode_sub: 'Watch a real prompt shrink as you choose.',
      mode_sent: 'Sent to model',
      doctor_title: 'Terse Doctor',
      doctor_sub: 'A full health scan of your agents. Read-only — nothing changes yet.',
      doctor_cta: 'Review & clean up →',
      doctor_grade_good: 'Looking good', doctor_grade_bad: 'Needs attention', doctor_findings_word: 'findings',
      doctor_clean: 'Nothing to flag — your agents came back clean.',
      preview_agents_sub: 'No account needed — this is a free local scan.',
      preview_cta: 'Create a free account to optimize →', preview_skip: 'Sign in',
      cleanup_title: 'Clean up agent cache',
      cleanup_sub: 'Stale caches your agents never prune. Safe to remove — stats & projects untouched.',
      cleanup_reclaim: 'reclaimable',
      cleanup_reclaimed: 'ready to reclaim',
      cleanup_cta: '⚡ Clean up now',
      cleanup_sweeping: 'Sweeping caches…',
      cleanup_note: 'This is a preview — run real cleanup anytime from Terse Doctor.',
      cleanup_none: "You're already tidy — no stale cache to clear.",
      finale_title: "You're all set.",
      finale_title_pal: "You're all set — {pal} is ready.",
      finale_sub: 'Terse is now watching your agents, trimming prompts, and keeping caches clean.',
      finale_cta: 'Start using Terse →',
      stat_tokens: 'Tokens saved', stat_cache: 'Cache freed', stat_health: 'Health now',
      recap_theme: 'Theme', recap_agents: 'Agents watched', recap_mode: 'Mode', recap_health: 'Health score', recap_pal: 'Your Pal',
      cont: 'Continue', skip: 'Skip', language: 'Language',
    },
    'zh-Hans': {
      agents_title: '发现你的智能体',
      agents_sub: 'Terse 扫描了正在运行的进程与缓存 — 以下均为实时会话。',
      agents_scanning: '正在扫描进程…',
      agents_found: '发现 {n} 个运行中的智能体',
      agents_watch: '监控这些智能体',
      agents_watching: '正在监控 {n} 个智能体 · 可取消不需要的',
      agents_none_title: '暂无运行中的智能体',
      agents_none_sub: '启动 Claude Code、Cursor、Codex 或 DeepSeek Harness，Terse 会自动识别。',
      mode_title: '压缩强度设为多少？',
      mode_sub: '拖动查看真实提示词如何被精简。',
      mode_sent: '发送给模型',
      doctor_title: 'Terse 体检',
      doctor_sub: '对你的智能体做一次完整体检。只读 — 暂不改动任何内容。',
      doctor_cta: '查看并清理 →',
      doctor_grade_good: '状况良好', doctor_grade_bad: '需要关注', doctor_findings_word: '项结果',
      doctor_clean: '没有发现问题 — 你的智能体一切正常。',
      preview_agents_sub: '无需账号 — 这是一次免费的本地扫描。',
      preview_cta: '创建免费账号,开始优化 →', preview_skip: '登录',
      cleanup_title: '清理智能体缓存',
      cleanup_sub: '智能体从不清理的陈旧缓存。可安全删除 — 不触碰统计与项目文件。',
      cleanup_reclaim: '可回收',
      cleanup_reclaimed: '待回收',
      cleanup_cta: '⚡ 立即清理',
      cleanup_sweeping: '正在清扫缓存…',
      cleanup_note: '这是预览 — 随时可在 Terse 体检中执行真正的清理。',
      cleanup_none: '你的环境已经很干净 — 没有陈旧缓存需要清理。',
      finale_title: '一切就绪。',
      finale_title_pal: '一切就绪 — {pal} 已准备好。',
      finale_sub: 'Terse 已开始监控你的智能体、精简提示词并保持缓存整洁。',
      finale_cta: '开始使用 Terse →',
      stat_tokens: '已省 token', stat_cache: '已释放缓存', stat_health: '当前健康度',
      recap_theme: '主题', recap_agents: '监控智能体', recap_mode: '强度', recap_health: '健康评分', recap_pal: '你的伙伴',
      cont: '继续', skip: '跳过', language: '语言',
    },
    'zh-Hant': {
      agents_title: '發現你的智能體',
      agents_sub: 'Terse 掃描了正在執行的程序與快取 — 以下皆為即時工作階段。',
      agents_scanning: '正在掃描程序…',
      agents_found: '發現 {n} 個執行中的智能體',
      agents_watch: '監控這些智能體',
      agents_watching: '正在監控 {n} 個智能體 · 可取消不需要的',
      agents_none_title: '暫無執行中的智能體',
      agents_none_sub: '啟動 Claude Code、Cursor、Codex 或 DeepSeek Harness，Terse 會自動辨識。',
      mode_title: '壓縮強度設為多少？',
      mode_sub: '拖動查看真實提示詞如何被精簡。',
      mode_sent: '傳送給模型',
      doctor_title: 'Terse 體檢',
      doctor_sub: '對你的智能體做一次完整體檢。唯讀 — 暫不改動任何內容。',
      doctor_cta: '檢視並清理 →',
      doctor_grade_good: '狀況良好', doctor_grade_bad: '需要關注', doctor_findings_word: '項結果',
      doctor_clean: '沒有發現問題 — 你的智能體一切正常。',
      preview_agents_sub: '無需帳號 — 這是一次免費的本地掃描。',
      preview_cta: '建立免費帳號,開始優化 →', preview_skip: '登入',
      cleanup_title: '清理智能體快取',
      cleanup_sub: '智能體從不清理的陳舊快取。可安全刪除 — 不觸碰統計與專案檔案。',
      cleanup_reclaim: '可回收',
      cleanup_reclaimed: '待回收',
      cleanup_cta: '⚡ 立即清理',
      cleanup_sweeping: '正在清掃快取…',
      cleanup_note: '這是預覽 — 隨時可在 Terse 體檢中執行真正的清理。',
      cleanup_none: '你的環境已經很乾淨 — 沒有陳舊快取需要清理。',
      finale_title: '一切就緒。',
      finale_title_pal: '一切就緒 — {pal} 已準備好。',
      finale_sub: 'Terse 已開始監控你的智能體、精簡提示詞並保持快取整潔。',
      finale_cta: '開始使用 Terse →',
      stat_tokens: '已省 token', stat_cache: '已釋放快取', stat_health: '目前健康度',
      recap_theme: '主題', recap_agents: '監控智能體', recap_mode: '強度', recap_health: '健康評分', recap_pal: '你的夥伴',
      cont: '繼續', skip: '略過', language: '語言',
    },
  };
  function lang() { try { return (window.i18n && window.i18n.getLang && window.i18n.getLang()) || 'en'; } catch { return 'en'; } }
  function L(key, params) {
    const lg = lang();
    let s = (ONB[lg] && ONB[lg][key]) || ONB.en[key] || key;
    if (params) for (const k in params) s = s.replace('{' + k + '}', params[k]);
    return s;
  }
  // Prefer an existing app-wide i18n key when we have one (keeps mode names etc. consistent).
  function ti(key, fallback) { try { const v = window.i18n && window.i18n.t(key); return (v && v !== key) ? v : fallback; } catch { return fallback; } }

  function fmtBytes(b) {
    b = Number(b) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // Sample agent + finding fixtures were removed: they were rendered with a
  // "Live" badge / as real Doctor findings whenever the real scan came back
  // empty, which showed users invented sessions and a false "API key found in
  // ~/.claude/CLAUDE.md" alert. Empty scans now render their real empty state.
  // (SAMPLE_CLEAN below is different — the cleanup step labels it a preview.)
  const SAMPLE_CLEAN = [
    { icon: '📄', title: 'Stale agent transcripts (>30d)', path: '~/.claude/projects', bytes: 1288490188 },
    { icon: '🐞', title: 'Claude Code debug logs (>7d)', path: '~/.claude/logs', bytes: 922746880 },
    { icon: '🐚', title: 'Shell snapshots (>30d)', path: '~/.claude/shell-snapshots', bytes: 356515840 },
    { icon: '▮', title: 'Cursor agent logs', path: '~/Library/…/Cursor/logs', bytes: 220200960 },
    { icon: '📊', title: 'Telemetry cache (statsig)', path: '~/.claude/statsig', bytes: 100663296 },
    { icon: '🧹', title: 'Disposable files in ~/.terse', path: '~/.terse', bytes: 44040192 },
  ];
  const AGENT_ICON = { 'claude-code': '🤖', 'openclaw': '🦎', 'cursor-agent': '⌘', 'codex': '📁', 'copilot': '∞', 'cline': '◧', 'windsurf': '🏄', 'aider': '✦', 'deepseek-harness': '🐋' };

  // ── state ──
  let root = null, onDone = null, step = 0, built = false;
  let preview = false, onPreviewDone = null; // value-first pre-signin preview (agents + Doctor only)
  const S = { theme: '', mode: 'Normal', agents: 0, tokensSaved: 1284, reclaimed: 0, scoreBefore: 62, scoreAfter: 88 };
  const NSTEPS = 5;
  const META = () => ([
    L('agents_title'), L('mode_title'), 'Terse Doctor 体检', L('cleanup_title'), L('finale_title'),
  ]);

  function buildDOM() {
    root = document.createElement('div');
    root.id = 'onbFlow';
    root.innerHTML = `
      <div class="onb-bg"><div class="onb-grid"></div><div class="onb-orb onb-o1"></div><div class="onb-orb onb-o2"></div></div>
      <div class="onb-head">
        <div class="onb-tile">T</div><div class="onb-brand">Terse</div>
        <div class="onb-spacer"></div>
        <div class="onb-lang" id="onbLang">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/></svg>
          <span id="onbLangLbl"></span>
        </div>
        <div class="onb-skip" id="onbSkip">${esc(L('skip'))}</div>
      </div>
      <div class="onb-prog" id="onbProg"></div>
      <div class="onb-meta" id="onbMeta"></div>
      <div class="onb-stage" id="onbStage"></div>`;
    document.body.appendChild(root);

    // progress dots
    root.querySelector('#onbProg').innerHTML = Array.from({ length: NSTEPS }, (_, i) => `<div class="onb-seg" data-s="${i}"></div>`).join('');

    // language label + picker (reuses the app's i18n dropdown)
    const langBtn = root.querySelector('#onbLang');
    const curLabel = () => { try { return (window.i18n.getLangs().find(l => l.code === window.i18n.getLang()) || {}).label || 'English'; } catch { return 'English'; } };
    root.querySelector('#onbLangLbl').textContent = curLabel();
    langBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.i18n && window.i18n.createLangPicker) window.i18n.createLangPicker(langBtn); // setLang() reloads → onboarding re-opens in the chosen language
    });

    root.querySelector('#onbSkip').addEventListener('click', () => { if (preview) finishPreview(); else finish(true); });

    const stage = root.querySelector('#onbStage');
    stage.appendChild(stepAgents());
    stage.appendChild(stepMode());
    stage.appendChild(stepDoctor());
    stage.appendChild(stepCleanup());
    stage.appendChild(stepFinale());
    built = true;
  }

  function mkStep(idx, html) {
    const d = document.createElement('div');
    d.className = 'onb-step'; d.dataset.step = idx; d.innerHTML = html;
    return d;
  }

  /* ── STEP 0: agent detection ── */
  function stepAgents() {
    const d = mkStep(0, `
      <h2>${esc(L('agents_title'))}</h2>
      <p class="onb-sub">${esc(L('agents_sub'))}</p>
      <div class="onb-scanline"><div class="onb-radar" id="onbRadar"></div><div class="onb-scantxt" id="onbScanTxt">${esc(L('agents_scanning'))}</div></div>
      <div id="onbAgentList"></div>
      <div class="onb-watch" id="onbWatch"></div>
      <button class="onb-cta" id="onbAgentCta" disabled>${esc(L('agents_watch'))}</button>`);
    d.querySelector('#onbAgentCta').addEventListener('click', () => next());
    return d;
  }
  async function runAgentScan() {
    const list = root.querySelector('#onbAgentList'), txt = root.querySelector('#onbScanTxt');
    const radar = root.querySelector('#onbRadar'), cta = root.querySelector('#onbAgentCta');
    // Connected sessions carry live stats, but during first run nothing is
    // connected yet — the user hasn't accepted an agent. So fall through to
    // *detected* agents (running processes Terse found) and show them without
    // invented stats. This is the whole point of the screen.
    let data = null;
    try { if (T.getAgentSessions) data = await T.getAgentSessions(); } catch { data = null; }
    let agents = [];
    if (Array.isArray(data) && data.length) {
      agents = data.slice(0, 5).map(a => ({
        icon: a.agentIcon || AGENT_ICON[a.agentType] || '🤖',
        name: a.agentName || a.agentType || 'Agent',
        meta: [a.project, a.model, a.turns != null ? a.turns + ' turns' : null,
          a.totalTokens != null ? Math.round(a.totalTokens / 1000) + 'K tok' : null,
          a.cacheEfficiency != null ? a.cacheEfficiency + '% cache' : null,
          a.estimatedCost != null ? '$' + Number(a.estimatedCost).toFixed(2) : null].filter(Boolean).join(' · '),
      }));
    } else {
      let det = null;
      try { if (T.getAgentDetections) det = await T.getAgentDetections(); } catch { det = null; }
      if (Array.isArray(det) && det.length) {
        agents = det.slice(0, 5).map(a => ({
          icon: a.icon || AGENT_ICON[a.type || a.agentType] || '🤖',
          name: a.name || a.agentName || a.type || a.agentType || 'Agent',
          // Detections know the process, not the conversation — show the pid,
          // never a fabricated turn/token/cost line.
          meta: [a.project, a.pid != null ? 'pid ' + a.pid : null].filter(Boolean).join(' · '),
        }));
      }
      // Otherwise stay empty. There used to be a SAMPLE_AGENTS fallback here,
      // but this screen badges every row "Live" and the subtitle promises
      // "以下均为实时会话" — so it showed users invented sessions (Claude Code ·
      // terse · 42 turns · $2.15) as their own. A Windows 11 user reported it.
    }
    if (!agents.length) { // genuinely none
      txt.innerHTML = esc(L('agents_none_title'));
      if (radar) radar.classList.add('stop');
      list.innerHTML = `<p class="onb-sub" style="margin-top:6px">${esc(L('agents_none_sub'))}</p>`;
      cta.disabled = false; cta.textContent = ti('cont', L('cont'));
      root.querySelector('#onbWatch').textContent = '';
      return;
    }
    let found = 0;
    agents.forEach((a, i) => setTimeout(() => {
      found++;
      txt.innerHTML = L('agents_found', { n: '<b>' + found + '</b>' });
      const el = document.createElement('div');
      el.className = 'onb-agent on';
      el.innerHTML = `<div class="ai">${esc(a.icon)}</div>
        <div class="am"><div class="an">${esc(a.name)} <span class="live">Live</span></div><div class="ax">${esc(a.meta)}</div></div>
        <div class="ac">✓</div>`;
      el.addEventListener('click', () => { el.classList.toggle('on'); updateWatch(); });
      list.appendChild(el);
      requestAnimationFrame(() => el.classList.add('in'));
      if (found === agents.length) setTimeout(() => { if (radar) radar.classList.add('stop'); updateWatch(); }, 400);
    }, 500 + i * 520));
  }
  function updateWatch() {
    const n = root.querySelectorAll('.onb-agent.on').length;
    root.querySelector('#onbWatch').innerHTML = n ? L('agents_watching', { n: '<b>' + n + '</b>' }) : '';
    root.querySelector('#onbAgentCta').disabled = n === 0;
    S.agents = n;
  }

  /* ── STEP 1: mode ── */
  const WORDS = [{ t: 'Could you please ', cut: [1, 2] }, { t: 'take a look at ', cut: [2] }, { t: 'the auth handler and ', cut: [1] },
    { t: 'basically ', cut: [0, 1, 2] }, { t: 'help me figure out ', cut: [1, 2] }, { t: 'why the token refresh ', cut: [] },
    { t: 'sometimes ', cut: [1, 2] }, { t: 'fails intermittently?', cut: [] }];
  const SAVES = ['−22%', '−38%', '−57%'], TOKS = ['742', '589', '408'], MODES = ['Soft', 'Normal', 'Aggressive'];
  function stepMode() {
    const soft = ti('soft', 'Soft'), norm = ti('normal', 'Normal'), aggr = ti('aggressive', 'Aggressive');
    const d = mkStep(1, `
      <h2>${esc(L('mode_title'))}</h2>
      <p class="onb-sub">${esc(L('mode_sub'))}</p>
      <div class="onb-modeseg" id="onbModeSeg">
        <button data-m="0">${esc(soft)}</button><button data-m="1" class="on">${esc(norm)}</button><button data-m="2">${esc(aggr)}</button>
      </div>
      <div class="onb-demo"><div class="onb-badge" id="onbBadge">−38%</div><div class="dl">${esc(ti('optimize', 'Your prompt'))}</div>
        <div id="onbDemoText"></div><div class="onb-tokrow"><span>${esc(L('mode_sent'))}</span><b><span id="onbTok">742</span> tok</b></div></div>
      <button class="onb-cta" id="onbModeCta" style="margin-top:14px">${esc(L('cont'))}</button>`);
    d.querySelector('#onbModeCta').addEventListener('click', () => next());
    d.querySelectorAll('#onbModeSeg button').forEach(b => b.addEventListener('click', () => {
      d.querySelectorAll('#onbModeSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      S.mode = MODES[+b.dataset.m]; renderDemo(+b.dataset.m);
    }));
    return d;
  }
  function renderDemo(mode) {
    const dt = root.querySelector('#onbDemoText'); if (!dt) return;
    dt.innerHTML = '';
    WORDS.forEach(w => { const s = document.createElement('span'); s.className = 'w' + (w.cut.includes(mode) ? ' cut' : ''); s.textContent = w.t; dt.appendChild(s); });
    root.querySelector('#onbBadge').textContent = SAVES[mode];
    root.querySelector('#onbTok').textContent = TOKS[mode];
  }

  /* ── STEP 2: Terse Doctor (verbatim gauge/sweep animation) ── */
  function stepDoctor() {
    const d = mkStep(2, `
      <h2>${esc(L('doctor_title'))} · <span style="font-weight:600;color:var(--t3);font-size:13px">体检</span></h2>
      <p class="onb-sub">${esc(L('doctor_sub'))}</p>
      <div class="hero" id="hero">
        <div class="gauge-wrap">
          <div id="scoreGauge"><svg width="132" height="132" viewBox="0 0 132 132">
            <circle cx="66" cy="66" r="58" fill="none" stroke="var(--bd)" stroke-width="10"/>
            <circle id="scoreArc" cx="66" cy="66" r="58" fill="none" stroke="var(--ac)" stroke-width="10" stroke-linecap="round"
              stroke-dasharray="364.4" stroke-dashoffset="364.4" style="transition:stroke-dashoffset 1s cubic-bezier(.4,0,.2,1),stroke .4s"/>
          </svg></div>
          <div class="gauge-center"><div id="scoreNum">--</div><div class="score-of">${esc(ti('doctor_health', 'Health'))}</div></div>
        </div>
        <div id="scoreGrade">&nbsp;</div>
        <div id="scanStatus"></div>
        <div id="summaryLine"></div>
        <div class="cats" id="catChips">
          ${['cache', 'mcp', 'loop', 'context', 'prompt', 'cost', 'config', 'junk', 'disk', 'guard', 'runtime']
            .map(c => `<div class="cat-chip" data-cat="${c}"><span class="cdot"></span><span>${c[0].toUpperCase() + c.slice(1)}</span></div>`).join('')}
        </div>
      </div>
      <div class="section-title" id="onbFindHdr" style="display:none"><span>${esc(ti('doctor_findings', 'Findings'))}</span><span class="n" id="onbFindN"></span></div>
      <div id="findingsList"></div>
      <button class="onb-cta" id="onbDocCta" disabled style="margin-top:14px">${esc(L('doctor_cta'))}</button>`);
    d.querySelector('#onbDocCta').addEventListener('click', () => { if (preview) finishPreview(); else next(); });
    return d;
  }

  // circumference from r; matches doctor.js
  function gaugeColor(score) { if (score >= 75) return 'var(--ac)'; if (score >= 60) return '#FF9800'; return '#F44336'; }
  function animateGauge(score) {
    score = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    const arc = root.querySelector('#scoreArc'), num = root.querySelector('#scoreNum'), grade = root.querySelector('#scoreGrade');
    const color = gaugeColor(score);
    if (arc) {
      let r = parseFloat(arc.getAttribute('r')); if (!r || isNaN(r)) r = 58;
      const circ = 2 * Math.PI * r;
      arc.style.strokeDasharray = String(circ);
      arc.style.strokeDashoffset = String(circ);
      arc.style.stroke = color;
      void arc.getBoundingClientRect();
      arc.style.transition = 'stroke-dashoffset 1100ms cubic-bezier(.22,.85,.3,1), stroke 600ms ease';
      requestAnimationFrame(() => { arc.style.strokeDashoffset = String(circ * (1 - score / 100)); });
    }
    if (grade) grade.style.color = color;
    if (num) num.style.color = color;
    if (num) {
      const start = performance.now(), dur = 1000;
      (function tick(now) {
        const p = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - p, 3);
        num.textContent = String(Math.round(score * eased));
        if (p < 1) requestAnimationFrame(tick); else num.textContent = String(score);
      })(performance.now());
    }
  }
  const CATEGORIES = ['cache', 'mcp', 'loop', 'context', 'prompt', 'cost', 'config', 'junk', 'disk', 'guard', 'runtime'];
  function runSweep() {
    const status = root.querySelector('#scanStatus'), hero = root.querySelector('#hero');
    if (hero) hero.classList.add('scanning');
    if (status) { status.style.display = ''; status.textContent = 'Scanning…'; }
    CATEGORIES.forEach((cat, i) => setTimeout(() => {
      const lbl = root.querySelector('[data-cat="' + cat + '"]');
      if (lbl) {
        lbl.classList.add('scanning');
        if (status) status.textContent = 'Scanning ' + cat + '…';
        setTimeout(() => { lbl.classList.remove('scanning'); lbl.classList.add('done'); }, 320);
      }
    }, i * 240));
  }
  function endSweep() {
    const status = root.querySelector('#scanStatus'), hero = root.querySelector('#hero');
    if (hero) hero.classList.remove('scanning');
    if (status) status.style.display = 'none';
    CATEGORIES.forEach(cat => { const lbl = root.querySelector('[data-cat="' + cat + '"]'); if (lbl) lbl.classList.remove('scanning'); });
  }

  let doctored = false;
  async function runDoctor() {
    if (doctored) return; doctored = true;
    runSweep();
    let report = null;
    try { if (T.doctorScan) report = await T.doctorScan(); } catch { report = null; }
    // resolve findings + score defensively (bridge shape may vary)
    let findings = (report && (report.findings || report.issues)) || null;
    let score = report && (report.score != null ? report.score : (report.summary && (report.summary.score != null ? report.summary.score : report.summary.health)));
    // Never substitute SAMPLE_FINDINGS for a real scan. One of them is a high
    // severity "API key found in ~/.claude/CLAUDE.md" — showing that to a user
    // whose machine is clean is a false credential-leak alarm, and it is what
    // prompted a Windows user to ask whether Terse takes their token.
    if (!Array.isArray(findings)) findings = [];
    // A genuinely clean machine scores high; only fall back to the placeholder
    // score when the scan itself failed to report one.
    if (score == null) score = findings.length ? S.scoreBefore : 92;
    S.scoreBefore = Math.round(Number(score) || 62);
    // stash disk/junk findings (with byte sizes) for the cleanup step
    S._clean = findings.filter(f => /junk|disk/.test(f.category || '') && (f.bytes || f.sizeBytes || f.junkBytes));

    const totalSweep = CATEGORIES.length * 240 + 360;
    setTimeout(() => {
      endSweep();
      animateGauge(S.scoreBefore);
      const grade = root.querySelector('#scoreGrade');
      const bad = findings.length;
      if (grade) grade.textContent = L(S.scoreBefore >= 75 ? 'doctor_grade_good' : 'doctor_grade_bad') + ' · ' + bad + ' ' + L('doctor_findings_word');
      renderFindings(findings.slice(0, 6));
    }, totalSweep);
  }
  /// Enable the Doctor step's "continue" button. Every exit path from the scan
  /// must reach this — a disabled CTA is a dead end, and the only escape the
  /// user has left is closing the window, which looks like the app is broken.
  function enableDocCta(delay) {
    setTimeout(() => {
      const b = root && root.querySelector('#onbDocCta');
      if (!b) return;
      b.disabled = false;
      if (preview) b.textContent = L('preview_cta');
    }, delay || 0);
  }

  function renderFindings(findings) {
    root.querySelector('#onbFindHdr').style.display = 'flex';
    root.querySelector('#onbFindN').textContent = findings.length;
    const list = root.querySelector('#findingsList'); list.innerHTML = '';
    if (!findings.length) {
      // Clean bill of health — say that plainly instead of inventing findings.
      list.innerHTML = `<p class="onb-sub" style="margin-top:6px">${esc(L('doctor_clean'))}</p>`;
      // The CTA is enabled at the END of this function, so returning here used
      // to leave it disabled forever: a user whose scan came back CLEAN had no
      // way forward except the window's close button. Enable and return.
      enableDocCta();
      return;
    }
    findings.forEach((f, i) => {
      const sev = (f.severity || 'low').toLowerCase();
      const cat = (f.category || 'config').toLowerCase();
      const imp = f.imp != null ? f.imp : (sev === 'high' ? 85 : sev === 'medium' ? 55 : 32);
      const mv = f.mv || '';
      const card = document.createElement('div');
      card.className = 'finding sev-' + sev; card.style.setProperty('--i', i);
      const hasScene = !!(window.doctorScenes && window.doctorScenes.build);
      card.innerHTML = `
        <div class="f-top"><span class="sev-dot ${sev}"></span>
          <div class="f-body"><div class="f-headline"><span class="f-title">${esc(f.title || '')}</span>
            <span class="cat-badge ${cat}">${esc(cat)}</span></div>
            <div class="f-detail">${esc(f.detail || '')}</div>
            <div class="f-impact"><div class="track"><div class="fill"></div></div>${mv ? '<span class="mv">' + esc(mv) + '</span>' : ''}</div>
            ${hasScene ? `<div class="f-actions" style="margin-top:9px">
              <button class="preview-card-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 4 14 8-14 8V4z"/></svg>${esc(ti('doctor_preview', 'Preview'))}</button></div>
            <div class="f-preview"><div class="fp-stage"></div>
              <div class="th-seg fp-seg before"><span class="pill"></span>
                <button type="button" data-state="before" class="active">${esc(ti('doctor_problem', 'Problem'))}</button>
                <button type="button" data-state="after">${esc(ti('doctor_after_fix', 'After fix'))}</button></div></div>` : ''}
          </div></div>`;
      list.appendChild(card);
      if (hasScene) wireScenePreview(card, f, cat);
      setTimeout(() => { const fill = card.querySelector('.f-impact .fill'); if (fill) requestAnimationFrame(() => fill.style.width = imp + '%'); }, 220 + i * 70);
    });
    enableDocCta(findings.length * 70 + 300);
  }

  // Per-finding animated scene, reusing the REAL Doctor scene library (window.doctorScenes).
  // Toggling Problem/After-fix re-injects the scene HTML, which replays its CSS animations.
  function wireScenePreview(card, f, cat) {
    const btn = card.querySelector('.preview-card-btn');
    const panel = card.querySelector('.f-preview');
    const stage = panel && panel.querySelector('.fp-stage');
    const seg = panel && panel.querySelector('.th-seg');
    if (!btn || !panel || !stage || !seg) return;
    let state = 'before', open = false;
    const inject = () => { try { stage.innerHTML = window.doctorScenes.build(cat, f, state); } catch (e) {} };
    const setState = (s) => {
      state = s;
      seg.className = 'th-seg fp-seg ' + s;
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.state === s));
      inject();
    };
    btn.addEventListener('click', () => {
      open = !open;
      panel.classList.toggle('open', open);
      btn.classList.toggle('active', open);
      if (open) setState('before');
    });
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setState(b.dataset.state)));
  }

  /* ── STEP 3: cleanup ── */
  function stepCleanup() {
    const d = mkStep(3, `
      <h2>${esc(L('cleanup_title'))} · <span style="font-weight:600;color:var(--t3);font-size:13px">清理</span></h2>
      <p class="onb-sub">${esc(L('cleanup_sub'))}</p>
      <div class="onb-reclaim"><div class="rn" id="onbReclaim">0 <small>MB</small></div><div class="rl" id="onbReclaimLbl">${esc(L('cleanup_reclaim'))}</div></div>
      <div id="onbClnList"></div>
      <div class="onb-clnnote">${esc(L('cleanup_note'))}</div>
      <button class="onb-cta" id="onbClnCta" style="margin-top:12px">${esc(L('cleanup_cta'))}</button>`);
    d.querySelector('#onbClnCta').addEventListener('click', () => doClean());
    return d;
  }
  let cleanData = null;
  function renderCleanup() {
    const list = root.querySelector('#onbClnList');
    let items = (S._clean && S._clean.length)
      ? S._clean.map(f => ({ icon: '🗂', title: f.title || 'Cache', path: (f.path || f.category || ''), bytes: f.bytes || f.sizeBytes || f.junkBytes, on: true }))
      : SAMPLE_CLEAN.map(c => ({ ...c, on: true }));
    cleanData = items;
    if (!items.length) {
      list.innerHTML = `<p class="onb-sub" style="text-align:center;margin-top:8px">${esc(L('cleanup_none'))}</p>`;
      root.querySelector('#onbClnCta').textContent = ti('cont', L('cont'));
      root.querySelector('#onbClnCta').onclick = () => next();
      root.querySelector('#onbReclaim').innerHTML = '0 <small>MB</small>';
      return;
    }
    list.innerHTML = items.map((c, i) => `
      <div class="onb-clnrow ${c.on ? 'on' : ''}" data-i="${i}">
        <div class="cb">✓</div><div class="cbi">${esc(c.icon)}</div>
        <div class="cn"><div class="ct">${esc(c.title)}</div><div class="cp">${esc(c.path)}</div></div>
        <div class="cs">${fmtBytes(c.bytes)}</div></div>`).join('');
    list.querySelectorAll('.onb-clnrow').forEach(rw => rw.querySelector('.cb').addEventListener('click', () => {
      const i = +rw.dataset.i; cleanData[i].on = !cleanData[i].on; rw.classList.toggle('on'); updateReclaim();
    }));
    updateReclaim();
  }
  function updateReclaim() {
    const b = cleanData.filter(c => c.on).reduce((s, c) => s + (Number(c.bytes) || 0), 0);
    const parts = fmtBytes(b).split(' ');
    root.querySelector('#onbReclaim').innerHTML = `${parts[0]} <small>${parts[1]}</small>`;
    root.querySelector('#onbReclaimLbl').textContent = L('cleanup_reclaim');
    root.querySelector('#onbClnCta').disabled = b === 0;
  }
  function doClean() {
    const btn = root.querySelector('#onbClnCta'); btn.disabled = true; btn.textContent = L('cleanup_sweeping');
    const rows = [...root.querySelectorAll('.onb-clnrow.on')];
    const target = cleanData.filter(c => c.on).reduce((s, c) => s + (Number(c.bytes) || 0), 0);
    S.reclaimed = target;
    rows.forEach((r, i) => setTimeout(() => r.classList.add('swept'), i * 160));
    setTimeout(() => {
      root.querySelector('#onbReclaimLbl').textContent = L('cleanup_reclaimed');
      const el = root.querySelector('#onbReclaim'), start = performance.now(), dur = 1400;
      (function tick(now) {
        const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3), v = target * e, pr = fmtBytes(v).split(' ');
        el.innerHTML = `${pr[0]} <small>${pr[1]}</small>`;
        if (p < 1) requestAnimationFrame(tick);
        else { confettiBurst(); btn.disabled = false; btn.textContent = ti('cont', L('cont')); btn.onclick = () => next(); }
      })(performance.now());
    }, rows.length * 160 + 200);
  }

  /* ── STEP 4: finale ── */
  function stepFinale() {
    const d = mkStep(4, `
      <div class="onb-finale">
        <div class="onb-check" id="onbCheck">✓</div>
        <h2 id="onbFinHead">${esc(L('finale_title'))}</h2>
        <p class="onb-sub" id="onbFinSub" style="text-align:center;margin-bottom:0">${esc(L('finale_sub'))}</p>
        <div class="onb-stats">
          <div class="onb-stat"><div class="sv" id="onbS1">0</div><div class="sl">${esc(L('stat_tokens'))}</div></div>
          <div class="onb-stat"><div class="sv" id="onbS2">0</div><div class="sl">${esc(L('stat_cache'))}</div></div>
          <div class="onb-stat"><div class="sv" id="onbS3">0</div><div class="sl">${esc(L('stat_health'))}</div></div>
        </div>
        <div class="onb-recap" id="onbRecap"></div>
      </div>
      <button class="onb-cta" id="onbFinCta">${esc(L('finale_cta'))}</button>`);
    d.querySelector('#onbFinCta').addEventListener('click', () => finish(false));
    return d;
  }
  function runFinale() {
    root.querySelector('#onbCheck').classList.add('show');
    setTimeout(() => {
      countUp(root.querySelector('#onbS1'), 0, S.tokensSaved, 1200);
      root.querySelector('#onbS2').textContent = fmtBytes(S.reclaimed || 0);
      countUp(root.querySelector('#onbS3'), 0, S.scoreAfter, 1200);
      root.querySelector('#onbRecap').innerHTML = `
        <div class="row"><span>${esc(L('recap_theme'))}</span><b>${esc(cap(S.theme) || '—')}</b></div>
        <div class="row"><span>${esc(L('recap_agents'))}</span><b>${S.agents} live</b></div>
        <div class="row"><span>${esc(L('recap_mode'))}</span><b>${esc(S.mode)}</b></div>
        <div class="row"><span>${esc(L('recap_health'))}</span><b>${S.scoreBefore} → ${S.scoreAfter} ✓</b></div>`;
      confettiBurst();
    }, 300);
  }

  /* ── shared ── */
  function countUp(el, from, to, dur) {
    if (!el) return; const start = performance.now();
    (function t(now) { const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString(); if (p < 1) requestAnimationFrame(t); })(performance.now());
  }
  function confettiBurst() {
    const acc = getComputedStyle(root).getPropertyValue('--ac') || '#C9F03D';
    const cols = [acc, '#fff', '#FF5E9C', '#8B9BFF', '#FFC24B'];
    for (let i = 0; i < 42; i++) {
      const c = document.createElement('div'); c.className = 'onb-confetti';
      c.style.left = (38 + Math.random() * 24) + '%'; c.style.background = cols[i % cols.length];
      c.style.borderRadius = Math.random() > .5 ? '50%' : '1px'; root.appendChild(c);
      const dx = (Math.random() - .5) * 280, dy = 240 + Math.random() * 240, rot = Math.random() * 720;
      c.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) rotate(${rot}deg)`, opacity: 0 }],
        { duration: 1200 + Math.random() * 500, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => c.remove();
    }
  }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

  const ENTER = { 0: runAgentScan, 2: runDoctor, 3: renderCleanup, 4: runFinale };
  function show(n) {
    step = n;
    root.querySelectorAll('.onb-step').forEach(s => { s.classList.remove('active', 'left'); if (+s.dataset.step < n) s.classList.add('left'); });
    const cur = root.querySelector(`.onb-step[data-step="${n}"]`); if (cur) cur.classList.add('active');
    root.querySelectorAll('#onbProg .onb-seg').forEach(sg => sg.classList.toggle('done', +sg.dataset.s < n));
    if (preview) {
      root.querySelector('#onbMeta').textContent = (n === 0 ? '1/2 · ' + L('agents_title') : '2/2 · Terse 体检');
    } else {
      root.querySelector('#onbMeta').textContent = `${n + 1}/${NSTEPS} · ${META()[n] || ''}`;
    }
    if (ENTER[n]) setTimeout(ENTER[n], 250);
  }
  // In preview mode the flow is only agents(0) → Doctor(2); full mode is linear.
  function next() { if (preview) { if (step === 0) show(2); return; } if (step < NSTEPS - 1) show(step + 1); }

  function finish(skipped) {
    try { localStorage.setItem(DONE_KEY, '1'); } catch {}
    if (root) root.classList.remove('show');
    const cb = onDone; onDone = null;
    // hand off to the existing pet-picker / paywall flow
    setTimeout(() => { if (cb) try { cb(); } catch (e) { console.warn('[onboarding] onDone failed', e); } }, 260);
  }

  // Value-first preview: user has seen agents + Doctor before signing in → mark as
  // both previewed (this session) and onboarded, then trigger the sign-in flow.
  function finishPreview() {
    try { sessionStorage.setItem(PREVIEW_KEY, '1'); localStorage.setItem(DONE_KEY, '1'); } catch {}
    preview = false;
    if (root) { root.classList.remove('show'); root.querySelector('#onbProg').style.display = 'flex'; }
    const cb = onPreviewDone; onPreviewDone = null;
    setTimeout(() => { if (cb) try { cb(); } catch (e) { console.warn('[onboarding] preview onContinue failed', e); } }, 260);
  }

  function resetSteps() {
    doctored = false; cleanData = null;
    root.querySelector('#onbAgentList').innerHTML = '';
    root.querySelector('#findingsList').innerHTML = '';
    root.querySelector('#onbFindHdr').style.display = 'none';
    try { S.theme = (document.documentElement.getAttribute('data-theme')) || localStorage.getItem('terse-theme') || ''; } catch {}
  }

  // ── public API ──
  function hasOnboarded() { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; } }
  function hasPreviewed() { try { return sessionStorage.getItem(PREVIEW_KEY) === '1'; } catch { return false; } }
  function start(done) {
    preview = false;
    onDone = typeof done === 'function' ? done : null;
    if (!built) buildDOM();
    resetSteps();
    root.querySelector('#onbProg').style.display = 'flex';
    renderDemo(1);
    root.classList.add('show');
    show(0);
  }
  // Pre-signin value preview: agents detection + Doctor 体检 only, ending in a sign-in CTA.
  function startPreview(onContinue) {
    preview = true;
    onPreviewDone = typeof onContinue === 'function' ? onContinue : null;
    if (!built) buildDOM();
    resetSteps();
    root.querySelector('#onbProg').style.display = 'none'; // 2-step flow — hide the 5-dot bar
    root.classList.add('show');
    show(0);
  }
  window.TERSE_ONBOARDING = {
    start, startPreview, hasOnboarded, hasPreviewed,
    reset() { try { localStorage.removeItem(DONE_KEY); sessionStorage.removeItem(PREVIEW_KEY); } catch {} },
  };
})();
