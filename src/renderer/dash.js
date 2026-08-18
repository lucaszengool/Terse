/* ──────────────────────────────────────────────────────────────────────────
   dash.js — floating dashboard widget controller.

   Each Tauri "dash-<kind>" window loads dash.html + this file. The window LABEL
   selects which single metric this window renders. We subscribe to the very same
   agent-connected / agent-update / agent-lost events the Dynamic Island listens
   to, keep a small per-window registry of agent snapshots, and drive ONE rich,
   animated promo-styled widget. The full set of windows is revealed together on
   island hover (open_dashboards) and hidden on leave (hide_dashboards):

     session · saved · compression · cache · focus · tools · agents · savings · activity

   Between them they surface EVERYTHING the agent-monitor backend exposes —
   identity/model/project, turns/elapsed/burn/cost, token in·out·cache, role
   breakdown, cache efficiency, context headroom, tool usage/duplicates/top
   consumers, savings and the live agent flow.

   A header agent-switcher lets the user view the aggregate ("All", the default)
   or any single connected agent (Claude / Codex / Cursor …). The aggregation and
   savings math mirror island.js so numbers stay consistent across windows.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  if (!document.body.classList.contains('dash-mode')) return;
  const T = window.terse;
  if (!T) { console.warn('[dash] bridge not ready'); return; }

  // ── Which widget am I? (from the native window label "dash-<kind>") ──
  function currentLabel() {
    try { return window.__TAURI__.window.getCurrentWindow().label || ''; } catch (e) { return ''; }
  }
  const qp = new URLSearchParams(location.search).get('w');
  const KIND = (currentLabel().replace(/^dash-/, '') || qp || 'saved');

  const USD_PER_M = 3.0; // blended $/1M tokens — honest estimate for the savings widget

  const $ = (s) => document.querySelector(s);
  // i18n.js loads before this file (see dash.html); tr() falls back to the key's
  // English when i18n is unavailable, and t() itself falls back to English per-key.
  const tr = (k, p) => (window.i18n && window.i18n.t) ? window.i18n.t(k, p) : k;
  const bodyEl  = $('#dashBody');
  const tabsEl  = $('#dashTabs');
  const titleEl = $('#dashTitle');
  const closeEl = $('#dashClose');

  const agents = {};        // agentType -> latest snapshot
  let sel = 'all';          // 'all' or an agentType
  let lastFlowSig = '';
  let statsAll = null;      // persisted lifetime stats from get_stats('all') (backend fallback)

  const count = () => Object.keys(agents).length;

  // ── persisted-stats pricing (mirrors stats.html so dollar figures match) ──
  const DEFAULT_RATES = {
    agent:   { in: 3.0, out: 15.0 },
    browser: { in: 2.5, out: 10.0 },
    editor:  { in: 3.0, out: 15.0 },
    manual:  { in: 3.0, out: 15.0 },
  };
  function loadRates() {
    try { const r = JSON.parse(localStorage.getItem('terse-rates') || 'null'); if (r && r.agent) return r; } catch (e) {}
    return DEFAULT_RATES;
  }
  const CACHE_READ_MULT = 0.1, CACHE_WRITE_MULT = 1.25;
  function costOfSource(src, s) {
    s = s || {};
    const rates = loadRates();
    const r = rates[src] || DEFAULT_RATES[src] || { in: 3, out: 15 };
    const cr = s.cacheReadTokens || 0, cw = s.cacheCreationTokens || 0;
    const fresh = Math.max(0, (s.tokensIn || 0) - cr - cw);
    const inCost = (fresh * r.in + cr * r.in * CACHE_READ_MULT + cw * r.in * CACHE_WRITE_MULT) / 1e6;
    return inCost + (s.tokensOut || 0) / 1e6 * r.out;
  }

  // Build a metric bundle from the persisted backend stats (stats.json) so the
  // widgets show real lifetime numbers when no agent is currently connected —
  // this is the same data the big stats window surfaces.
  function statsBundle() {
    const d = statsAll;
    if (!d || !d.summary) return null;
    const sm = d.summary;
    const inTok = sm.tokensIn || 0, outTok = sm.tokensOut || 0, saved = sm.tokensSaved || 0;
    const cacheRead = sm.cacheReadTokens || 0, cacheCreate = sm.cacheCreationTokens || 0;
    if (!(inTok || outTok || saved || cacheRead || cacheCreate || (sm.toolCalls || 0))) return null;
    let cost = 0; const bs = d.bySource || {};
    Object.keys(bs).forEach((k) => { cost += costOfSource(k, bs[k]); });
    const cacheDen = cacheRead + cacheCreate;
    return {
      list: [], count: 0, persisted: true,
      saved, red: sm.percentSaved || 0,
      cache: cacheDen > 0 ? Math.round(cacheRead / cacheDen * 100) : 0,
      ctx: 0, headroom: 0, currentContext: 0, contextMax: 200000,
      tools: sm.toolCalls || 0,
      name: tr('dash_lifetime'), icon: '🛰️', model: '', project: '', watchedFiles: 0,
      inTok, outTok, cacheRead, cacheCreate, totalTok: inTok + outTok,
      turns: 0, elapsedMin: 0, burn: 0, cost, approx: true,
      breakdown: { user: inTok, assistant: outTok, tool: cacheRead },
      toolsUsed: {}, unusedTools: 0, overhead: 0,
      dupCalls: 0, dupTokens: 0, topConsumers: [], compressible: 0, rereadWaste: 0, redundantReads: [],
      messages: [], action: null, working: false,
    };
  }

  // ── formatters ──
  const fmtTok = (n) => {
    n = Math.round(n || 0);
    return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
         : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K'
         : String(n);
  };
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function shortText(t) { return (t || '').replace(/\s+/g, ' ').trim().slice(0, 30); }
  // A short, human model label ("claude-3-5-sonnet-20241022" → "Sonnet 3.5", etc.)
  function shortModel(m) {
    if (!m) return '';
    const l = m.toLowerCase();
    if (l.includes('opus'))  return 'Opus';
    if (l.includes('sonnet')) return 'Sonnet';
    if (l.includes('haiku')) return 'Haiku';
    if (l.includes('gpt-5')) return 'GPT-5';
    if (l.includes('gpt-4o')) return 'GPT-4o';
    if (l.includes('o3')) return 'o3';
    if (l.includes('o1')) return 'o1';
    return m.length > 16 ? m.slice(0, 16) + '…' : m;
  }
  function baseName(p) { return (p || '').replace(/\/+$/, '').split('/').pop() || ''; }
  function fmtMin(m) {
    m = Math.round(m || 0);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? h + 'h ' + r + 'm' : h + 'h';
  }
  function fmtUSD(v) {
    v = v || 0;
    return v >= 100 ? '$' + Math.round(v) : '$' + v.toFixed(2);
  }

  // ── metric math (mirrors island.js) ──
  function savedTokensFor(s) {
    const hook = (window._terseHookStats && window._terseHookStats.totalSaved) || 0;
    const auto = (s.autoOptimized && s.autoOptimized.tokensSaved) || 0;
    const opt  = s.optimizationStats || {};
    const potential = (opt.potentialSavings || 0) + (s.rereadWaste || 0)
      + ((s.toolCachePotential || {}).tokensWasted || 0)
      + ((s.toolResultStats || {}).compressibleTokens || 0);
    return Math.max(0, Math.round(hook + auto + potential));
  }
  function reductionPct(s) {
    const hp = (window._terseHookStats && window._terseHookStats.percentSaved) || 0;
    if (hp > 0) return Math.round(hp);
    const saved = savedTokensFor(s);
    const inTok = s.totalInputTokens || 0;
    const base = saved + inTok;
    return base > 0 ? Math.round((saved / base) * 100) : 0;
  }
  function latestAction(s) {
    const msgs = s.recentMessages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const name = (m.tool_name || m.toolName || '').toString();
      if (m.type === 'tool_use')    return { ico: '⚙', label: name || tr('dash_running_tool'), kind: 'tool' };
      if (m.type === 'tool_result') return { ico: '←', label: (name ? name + ' ' + tr('dash_result') : tr('dash_tool_result')), kind: 'result' };
      if (m.role === 'assistant')   return { ico: '◆', label: shortText(m.text) || tr('dash_responding'), kind: 'asst' };
      if (m.role === 'user')        return { ico: '→', label: shortText(m.text) || tr('dash_prompt'), kind: 'user' };
    }
    return null;
  }

  // Extract EVERY field the backend exposes for one agent snapshot into a flat bundle.
  function bundleOf(s) {
    const opt = s.optimizationStats || {};
    const tcp = s.toolCachePotential || {};
    const trs = s.toolResultStats || {};
    const tm  = s.toolManagement || {};
    const bd  = s.tokenBreakdown || {};
    const act = latestAction(s);
    return {
      list: [s], count: 1,
      saved: savedTokensFor(s), red: reductionPct(s),
      cache: s.cacheEfficiency || 0,
      ctx: s.contextFill || 0, headroom: Math.max(0, 100 - (s.contextFill || 0)),
      currentContext: s.currentContext || 0, contextMax: s.contextMax || 200000,
      tools: s.toolCallCount || 0,
      name: s.agentName || tr('agent'), icon: s.agentIcon || '🤖',
      model: s.model || '', project: s.project || '', watchedFiles: s.watchedFiles || 0,
      inTok: s.totalInputTokens || 0, outTok: s.totalOutputTokens || 0,
      cacheRead: s.totalCacheReadTokens || 0, cacheCreate: s.totalCacheCreateTokens || 0,
      totalTok: s.totalTokens || 0,
      turns: s.turns || 0, elapsedMin: s.elapsedMinutes || 0, burn: s.burnRate || 0,
      cost: s.estimatedCost || 0, approx: !!s.tokenCountApprox,
      breakdown: { user: bd.user || 0, assistant: bd.assistant || 0, tool: bd.tool || 0 },
      toolsUsed: tm.used || {}, unusedTools: tm.unusedEstimate || 0, overhead: tm.estimatedOverhead || 0,
      dupCalls: tcp.duplicateCalls || 0, dupTokens: tcp.duplicateCallTokens || tcp.tokensWasted || 0,
      topConsumers: trs.topConsumers || [], compressible: trs.compressibleTokens || 0,
      rereadWaste: s.rereadWaste || 0, redundantReads: s.redundantReads || [],
      messages: (s.recentMessages || []).map((m) => ({ ...m, _icon: s.agentIcon })),
      action: act, working: !!act && (act.kind === 'tool' || act.kind === 'asst'),
    };
  }

  // Normalise the active selection to a single metric bundle the renderers consume.
  function source() {
    const hp = (window._terseHookStats && window._terseHookStats.percentSaved) || 0;
    if (sel !== 'all' && agents[sel]) return bundleOf(agents[sel]);

    // Aggregate across the whole fleet.
    const list = Object.values(agents);
    if (!list.length) {
      // No live agent → surface the persisted backend metrics (lifetime stats.json)
      // so the boards mirror the big stats window instead of sitting empty.
      const sb = statsBundle();
      if (sb) return sb;
      return {
        list: [], count: 0, saved: 0, red: 0, cache: 0, ctx: 0, headroom: 0,
        currentContext: 0, contextMax: 200000, tools: 0, name: tr('dash_no_agents'), icon: '🛰️',
        model: '', project: '', watchedFiles: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheCreate: 0,
        totalTok: 0, turns: 0, elapsedMin: 0, burn: 0, cost: 0, approx: false,
        breakdown: { user: 0, assistant: 0, tool: 0 }, toolsUsed: {}, unusedTools: 0, overhead: 0,
        dupCalls: 0, dupTokens: 0, topConsumers: [], compressible: 0, rereadWaste: 0, redundantReads: [],
        messages: [], action: null, working: false,
      };
    }
    const A = {
      list, count: list.length, saved: 0, red: 0, cache: 0, ctx: 0, headroom: 0,
      currentContext: 0, contextMax: 0, tools: 0,
      name: list.length === 1 ? (list[0].agentName || tr('agent')) : tr('dash_all_agents'),
      icon: list.length === 1 ? (list[0].agentIcon || '🤖') : '🛰️',
      model: list.length === 1 ? (list[0].model || '') : '', project: '', watchedFiles: 0,
      inTok: 0, outTok: 0, cacheRead: 0, cacheCreate: 0, totalTok: 0,
      turns: 0, elapsedMin: 0, burn: 0, cost: 0, approx: false,
      breakdown: { user: 0, assistant: 0, tool: 0 }, toolsUsed: {}, unusedTools: 0, overhead: 0,
      dupCalls: 0, dupTokens: 0, topConsumers: [], compressible: 0, rereadWaste: 0, redundantReads: [],
      messages: [], action: null, working: false,
    };
    let cacheSum = 0, cacheN = 0, msgs = [];
    const consumerMap = {};
    list.forEach((s) => {
      const b = bundleOf(s);
      A.saved += b.saved; A.inTok += b.inTok; A.outTok += b.outTok;
      A.cacheRead += b.cacheRead; A.cacheCreate += b.cacheCreate; A.totalTok += b.totalTok;
      A.tools += b.tools; A.turns += b.turns; A.burn += b.burn; A.cost += b.cost;
      A.dupCalls += b.dupCalls; A.dupTokens += b.dupTokens; A.overhead += b.overhead;
      A.unusedTools += b.unusedTools; A.compressible += b.compressible; A.rereadWaste += b.rereadWaste;
      A.watchedFiles += b.watchedFiles;
      A.elapsedMin = Math.max(A.elapsedMin, b.elapsedMin);
      A.ctx = Math.max(A.ctx, b.ctx); A.currentContext = Math.max(A.currentContext, b.currentContext);
      A.contextMax = Math.max(A.contextMax, b.contextMax);
      A.breakdown.user += b.breakdown.user; A.breakdown.assistant += b.breakdown.assistant; A.breakdown.tool += b.breakdown.tool;
      if (b.approx) A.approx = true;
      if (s.cacheEfficiency != null) { cacheSum += s.cacheEfficiency; cacheN++; }
      if (b.working) A.working = true;
      Object.keys(b.toolsUsed).forEach((k) => { A.toolsUsed[k] = (A.toolsUsed[k] || 0) + b.toolsUsed[k]; });
      (b.redundantReads || []).forEach((r) => A.redundantReads.push(r));
      (b.topConsumers || []).forEach((c) => {
        const e = consumerMap[c.tool] || (consumerMap[c.tool] = { tool: c.tool, totalTokens: 0, callCount: 0 });
        e.totalTokens += c.totalTokens || 0; e.callCount += c.callCount || 0;
      });
      (s.recentMessages || []).forEach((m) => msgs.push({ ...m, _icon: s.agentIcon }));
    });
    A.cache = cacheN ? Math.round(cacheSum / cacheN) : 0;
    A.headroom = Math.max(0, 100 - A.ctx);
    A.red = hp > 0 ? Math.round(hp) : (A.saved + A.inTok > 0 ? Math.round(A.saved / (A.saved + A.inTok) * 100) : 0);
    A.topConsumers = Object.values(consumerMap).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);
    // Interleave the fleet's steps by time so the Activity board reads as one live
    // log (newest last); keep a deep tail so the full recent history is scrollable.
    msgs.sort((a, b) => (a.timestamp || 0) < (b.timestamp || 0) ? -1 : (a.timestamp || 0) > (b.timestamp || 0) ? 1 : 0);
    A.messages = msgs.slice(-60);
    if (!A.contextMax) A.contextMax = 200000;
    return A;
  }

  // ── animation primitives ──
  const _timers = new WeakMap();
  function flashBump(el) { if (!el) return; el.classList.remove('bump', 'glow'); void el.offsetWidth; el.classList.add('bump', 'glow'); setTimeout(() => el.classList.remove('glow'), 720); }
  function countUpRaw(el, from, target, fmt) {
    if (_timers.has(el)) cancelAnimationFrame(_timers.get(el));
    const start = performance.now(), dur = 700, delta = target - from;
    (function step(now) {
      const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + delta * e);
      if (t < 1) _timers.set(el, requestAnimationFrame(step));
    })(performance.now());
  }
  function animNum(el, target, animate, fmt) {
    if (!el) return;
    fmt = fmt || fmtTok;
    const prev = el._shown || 0;
    if (target === prev && !animate) { el.textContent = fmt(target); return; }
    countUpRaw(el, animate ? 0 : prev, target, fmt);
    if (target > prev && target > 0) flashBump(el);
    el._shown = target;
  }
  function ringTo(el, pctEl, target, color) {
    if (!el) return;
    el.style.setProperty('--ring-col', color);
    const from = el._ring || 0;
    if (_timers.has(el)) cancelAnimationFrame(_timers.get(el));
    const start = performance.now(), dur = 760, delta = target - from;
    (function step(now) {
      const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3), v = from + delta * e;
      el.style.setProperty('--ring-p', v.toFixed(1));
      if (pctEl) pctEl.textContent = Math.round(v) + '%';
      if (t < 1) _timers.set(el, requestAnimationFrame(step));
    })(performance.now());
    el._ring = target;
  }
  // A horizontal value bar that eases to a width (used in the stacked breakdown + meters).
  function barTo(el, pct) { if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%'; }

  // Resolve the theme accent to a concrete colour (inline-SVG stroke/stop-color is
  // more reliable with a literal than a CSS custom property).
  function accent() {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--ac').trim();
    return c || '#34c759';
  }

  // Glowing SVG area-chart sparkline (the promo's signature line).
  function buildSpark(el, vals) {
    if (!el) return;
    if (!vals || vals.length < 2) vals = [0.32, 0.46, 0.4, 0.62, 0.54, 0.8, 1];
    const ac = accent();
    const Wd = 100, Hd = 36, n = vals.length;
    const max = Math.max.apply(null, vals) || 1, min = Math.min.apply(null, vals);
    const rng = (max - min) || 1;
    const pts = vals.map((v, i) => [(i / (n - 1)) * Wd, Hd - 3 - ((v - min) / rng) * (Hd - 8)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ' L ' + Wd + ' ' + Hd + ' L 0 ' + Hd + ' Z';
    const last = pts[pts.length - 1];
    const gid = 'sg' + Math.abs(Math.round(max * 7 + min)) % 100000;
    el.innerHTML =
      '<svg viewBox="0 0 ' + Wd + ' ' + Hd + '" preserveAspectRatio="none">' +
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="' + ac + '" stop-opacity="0.34"/>' +
          '<stop offset="1" stop-color="' + ac + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
        '<path d="' + line + '" fill="none" stroke="' + ac + '" stroke-width="2" vector-effect="non-scaling-stroke" ' +
          'stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 3px ' + ac + ')"/>' +
        '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.4" fill="' + ac + '" vector-effect="non-scaling-stroke"/>' +
      '</svg>';
  }
  // Per-agent saved contributions, else a gentle rising ramp scaled by `scale`.
  function sparkVals(M, scale) {
    const vals = M.list.map((s) => savedTokensFor(s)).filter((v) => v > 0);
    if (vals.length >= 2) return vals;
    const base = Math.max(scale || 1, 1);
    return [0.35, 0.5, 0.42, 0.66, 0.58, 0.82, 1].map((m) => m * base);
  }
  const headroomColor = (h) => h < 15 ? '#ff6161' : h < 40 ? '#ffc533' : 'var(--ac)';

  // Small reusable building blocks ------------------------------------------------
  // A compact label/value stat cell for grids.
  function cell(label, value, accentVal) {
    return '<div class="w-cell"><span class="w-cell-l">' + escHtml(label) + '</span>' +
           '<span class="w-cell-v' + (accentVal ? ' ac' : '') + '">' + value + '</span></div>';
  }
  // A one-line "label … value" info row.
  function infoRow(label, value, cls) {
    return '<div class="w-info' + (cls ? ' ' + cls : '') + '"><span class="w-info-l">' + escHtml(label) +
           '</span><span class="w-info-v">' + value + '</span></div>';
  }

  // ── per-kind widget definitions: header title · body HTML · render(M, animate) ──
  const KINDS = {
    // ── Session: identity, model, project + the core counters + role breakdown ──
    session: {
      title: 'dash_session',
      html:
        '<div class="w-ident">' +
          '<span class="w-ident-ico" id="d_ico">\ud83e\udd16</span>' +
          '<div class="w-ident-id"><span class="w-ident-name" id="d_name">' + tr('agent') + '</span>' +
            '<span class="w-ident-meta"><span class="w-chip-mini" id="d_model">model</span>' +
            '<span class="w-ident-proj" id="d_proj"></span></span></div>' +
          '<span class="w-act-status" id="d_status"><i class="w-dot"></i><span id="d_statustx">' + tr('monitoring') + '</span></span>' +
        '</div>' +
        '<div class="w-grid">' +
          '<div class="w-cell"><span class="w-cell-l">' + tr('turns') + '</span><span class="w-cell-v" id="d_turns">0</span></div>' +
          '<div class="w-cell"><span class="w-cell-l">' + tr('dash_elapsed') + '</span><span class="w-cell-v" id="d_elapsed">0m</span></div>' +
          '<div class="w-cell"><span class="w-cell-l">' + tr('dash_burn') + '</span><span class="w-cell-v" id="d_burn">0</span></div>' +
          '<div class="w-cell"><span class="w-cell-l">' + tr('dash_est_cost') + '</span><span class="w-cell-v ac" id="d_cost">$0</span></div>' +
        '</div>' +
        // Row 2: efficiency vitals — context, cache hit, pace, spend rate
        '<div class="w-grid">' +
          '<div class="w-cell"><span class="w-cell-l">Ctx</span><span class="w-cell-v" id="d_ctx">0%</span></div>' +
          '<div class="w-cell"><span class="w-cell-l">Cache</span><span class="w-cell-v" id="d_cachehit">0%</span></div>' +
          '<div class="w-cell"><span class="w-cell-l">Avg/turn</span><span class="w-cell-v" id="d_avgturn">0</span></div>' +
          '<div class="w-cell"><span class="w-cell-l">$/hr</span><span class="w-cell-v" id="d_costhr">$0</span></div>' +
        '</div>' +
        // Compaction forecast — only shown once there is enough signal
        '<div class="w-eta" id="d_eta" style="display:none"><span class="w-eta-ico">\u23f3</span><span id="d_etatx"></span></div>' +
        // Top tools by call count — the "what is it actually doing" ranking
        '<div class="w-tools" id="d_tools" style="display:none">' +
          '<div class="w-tools-title">Top tools</div>' +
          '<div id="d_toolrows"></div>' +
        '</div>' +
        // Waste radar — dup calls / re-read / compressible chips (hidden at 0)
        '<div class="w-waste" id="d_waste" style="display:none"></div>' +
        '<div class="w-bd"><div class="w-bd-bar">' +
          '<i class="w-bd-seg user" id="d_bdu"></i><i class="w-bd-seg asst" id="d_bda"></i><i class="w-bd-seg tool" id="d_bdt"></i>' +
        '</div><div class="w-bd-legend">' +
          '<span><i class="lg user"></i>' + tr('dash_in') + ' <b id="d_lin">0</b></span>' +
          '<span><i class="lg asst"></i>' + tr('dash_out') + ' <b id="d_lout">0</b></span>' +
          '<span><i class="lg tool"></i>' + tr('cache') + ' <b id="d_lcache">0</b></span>' +
        '</div></div>',
      render(M, an) {
        $('#d_ico').textContent = M.icon;
        $('#d_name').textContent = M.name;
        const md = $('#d_model'); const mlabel = shortModel(M.model);
        if (mlabel) { md.style.display = ''; md.textContent = mlabel; } else { md.style.display = 'none'; }
        const proj = $('#d_proj'); const pn = M.count === 1 ? baseName(M.project) : tr('dash_projects', { n: M.count });
        proj.textContent = pn ? '\u00b7 ' + pn : '';
        const st = $('#d_status'), stx = $('#d_statustx');
        st.className = 'w-act-status' + (M.working ? ' working' : '');
        stx.textContent = M.persisted ? tr('dash_lifetime') : M.count === 0 ? tr('dash_idle') : M.working ? tr('dash_working') : tr('monitoring');
        animNum($('#d_turns'), M.turns, an, (n) => String(Math.round(n)));
        $('#d_elapsed').textContent = fmtMin(M.elapsedMin);
        $('#d_burn').innerHTML = fmtTok(M.burn) + '<span class="w-cell-u">/min</span>';
        animNum($('#d_cost'), Math.round(M.cost * 100), an, (n) => fmtUSD(n / 100));

        // ── Efficiency vitals ──
        const ctxEl = $('#d_ctx');
        ctxEl.textContent = Math.round(M.ctx) + '%';
        ctxEl.style.color = M.ctx >= 90 ? '#ff6161' : M.ctx >= 75 ? '#ffc533' : '';
        $('#d_cachehit').textContent = Math.round(M.cache) + '%';
        const avg = M.turns > 0 ? Math.round((M.inTok + M.outTok) / M.turns) : 0;
        $('#d_avgturn').textContent = fmtTok(avg);
        const hr = M.elapsedMin >= 1 ? M.cost / M.elapsedMin * 60 : 0;
        $('#d_costhr').textContent = hr > 0 ? fmtUSD(hr) : '\u2014';

        // ── Compaction forecast: linear ETA from context growth over elapsed time ──
        const eta = $('#d_eta'), etatx = $('#d_etatx');
        if (!M.persisted && M.ctx >= 25 && M.elapsedMin >= 2) {
          const rate = M.ctx / M.elapsedMin;             // %/min so far
          const mins = rate > 0 ? Math.round((100 - M.ctx) / rate) : 0;
          const tokLeft = Math.max(0, (M.contextMax || 0) - (M.currentContext || 0));
          if (mins > 0 && mins < 720) {
            eta.style.display = '';
            eta.className = 'w-eta' + (mins <= 10 ? ' hot' : mins <= 30 ? ' warm' : '');
            etatx.textContent = '~' + fmtMin(mins) + ' to compaction \u00b7 ' + fmtTok(tokLeft) + ' ctx left';
          } else eta.style.display = 'none';
        } else eta.style.display = 'none';

        // ── Top tools ranking (top 3 by calls) ──
        const toolsBox = $('#d_tools'), rows = $('#d_toolrows');
        const entries = Object.entries(M.toolsUsed || {}).map(([k, v]) => {
          const n = typeof v === 'number' ? v : (v && (v.calls || v.count)) || 0;
          return [k, n];
        }).filter((e) => e[1] > 0).sort((a2, b2) => b2[1] - a2[1]).slice(0, 3);
        if (entries.length) {
          toolsBox.style.display = '';
          const max = entries[0][1] || 1;
          rows.innerHTML = entries.map(([k, n]) =>
            '<div class="w-tool-row"><span class="w-tool-name">' + k.replace(/[<>&]/g, '') + '</span>' +
            '<span class="w-tool-bar"><i style="width:' + Math.round(n / max * 100) + '%"></i></span>' +
            '<span class="w-tool-n">' + n + '</span></div>'
          ).join('');
        } else toolsBox.style.display = 'none';

        // ── Waste radar chips ──
        const waste = $('#d_waste');
        const chips = [];
        if (M.dupCalls > 0) chips.push('<span class="w-chip warn">\ud83d\udd01 ' + M.dupCalls + ' dup calls' + (M.dupTokens ? ' \u00b7 ' + fmtTok(M.dupTokens) : '') + '</span>');
        if (M.rereadWaste > 0) chips.push('<span class="w-chip">\ud83d\udcc4 ' + fmtTok(M.rereadWaste) + ' re-read</span>');
        if (M.compressible > 0) chips.push('<span class="w-chip">\ud83d\udddc ' + fmtTok(M.compressible) + ' compressible</span>');
        if (chips.length) { waste.style.display = ''; waste.innerHTML = chips.join(''); }
        else waste.style.display = 'none';

        // role breakdown bar (input vs output vs cache-read \u2014 the real token mix)
        const u = M.inTok, a = M.outTok, t = M.cacheRead, tot = u + a + t || 1;
        barTo($('#d_bdu'), u / tot * 100); barTo($('#d_bda'), a / tot * 100); barTo($('#d_bdt'), t / tot * 100);
        $('#d_lin').textContent = fmtTok(u); $('#d_lout').textContent = fmtTok(a); $('#d_lcache').textContent = fmtTok(t);
      },
    },

    saved: {
      title: 'dash_saved',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('dash_saved') + '</span><span class="w-delta" id="d_red"></span></div>' +
        '<div class="w-big" id="d_num">0</div><div class="w-sub">' + tr('dash_tokens_trimmed') + '</div>' +
        '<div class="w-spark" id="d_spark"></div>' +
        '<div class="w-mini-rows">' +
          '<span class="w-mini"><i>♻︎</i>' + tr('dash_reread') + ' <b id="d_reread">0</b></span>' +
          '<span class="w-mini"><i>⧉</i>' + tr('dash_dup') + ' <b id="d_dup">0</b></span>' +
          '<span class="w-mini"><i>⊟</i>' + tr('dash_compress') + ' <b id="d_comp">0</b></span>' +
        '</div>',
      render(M, an) {
        animNum($('#d_num'), M.saved, an);
        $('#d_red').textContent = M.red > 0 ? '−' + M.red + '%' : '';
        buildSpark($('#d_spark'), sparkVals(M, Math.max(M.red, 8)));
        $('#d_reread').textContent = fmtTok(M.rereadWaste);
        $('#d_dup').textContent = fmtTok(M.dupTokens);
        $('#d_comp').textContent = fmtTok(M.compressible);
      },
    },

    cache: {
      title: 'cache',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('cache') + '</span><span class="w-pill" id="d_badge">' + tr('dash_faster') + '</span></div>' +
        '<div class="w-big" id="d_num">0%</div>' +
        '<div class="w-bar"><div class="w-bar-fill" id="d_bar"></div></div>' +
        '<div class="w-sub">' + tr('dash_hitrate') + '</div>' +
        '<div class="w-info-list">' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_cache_reads') + '</span><span class="w-info-v" id="d_read">0</span></div>' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_cache_writes') + '</span><span class="w-info-v" id="d_write">0</span></div>' +
        '</div>',
      render(M, an) {
        animNum($('#d_num'), M.cache, an, (n) => Math.round(n) + '%');
        const bar = $('#d_bar'), badge = $('#d_badge');
        bar.style.width = Math.min(M.cache, 100) + '%';
        bar.className = 'w-bar-fill' + (M.cache > 50 ? '' : M.cache > 20 ? ' warn' : ' danger');
        badge.className = 'w-pill' + (M.cache > 50 ? '' : M.cache > 20 ? ' warn' : ' bad');
        badge.textContent = M.cache > 50 ? tr('dash_faster') : M.cache > 20 ? tr('dash_warming') : tr('dash_cold');
        $('#d_read').textContent = fmtTok(M.cacheRead);
        $('#d_write').textContent = fmtTok(M.cacheCreate);
      },
    },

    focus: {
      title: 'dash_focus',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('dash_focus') + '</span><span class="w-pill" id="d_badge">—</span></div>' +
        '<div class="w-ringwrap"><div class="w-ring" id="d_ring" style="--ring-p:0">' +
          '<span class="w-ring-pct" id="d_pct">—</span><span class="w-ring-cap">' + tr('dash_headroom') + '</span></div></div>' +
        '<div class="w-info-list">' +
          '<div class="w-info"><span class="w-info-l">' + tr('context') + '</span><span class="w-info-v"><span id="d_ctxnow">0</span> / <span id="d_ctxmax">0</span></span></div>' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_burn_rate') + '</span><span class="w-info-v" id="d_burn">0/min</span></div>' +
        '</div>',
      render(M, an) {
        const h = M.count ? M.headroom : 0;
        ringTo($('#d_ring'), $('#d_pct'), h, headroomColor(h));
        const badge = $('#d_badge');
        badge.className = 'w-pill' + (h >= 60 ? '' : h >= 30 ? ' warn' : ' bad');
        badge.textContent = M.count === 0 ? tr('dash_b_idle') : h >= 60 ? tr('dash_healthy') : h >= 30 ? tr('dash_watch') : tr('dash_full');
        $('#d_ctxnow').textContent = fmtTok(M.currentContext);
        $('#d_ctxmax').textContent = fmtTok(M.contextMax);
        $('#d_burn').textContent = fmtTok(M.burn) + '/min';
      },
    },

    compression: {
      title: 'dash_compression',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('dash_compression') + '</span><span class="w-delta" id="d_delta"></span></div>' +
        '<div class="w-ringwrap big"><div class="w-ring big" id="d_ring" style="--ring-p:0">' +
          '<span class="w-ring-pct" id="d_pct">0%</span><span class="w-ring-cap" id="d_cap">' + tr('dash_reduced') + '</span></div></div>' +
        '<div class="w-info-list">' +
          '<div class="w-info"><span class="w-info-l">' + tr('input') + '</span><span class="w-info-v" id="d_in">0</span></div>' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_output') + '</span><span class="w-info-v" id="d_out">0</span></div>' +
        '</div>',
      render(M, an) {
        // Compute best available reduction rate:
        // 1. Live hook/optimization rate (M.red)
        // 2. Estimate from compressible content in snapshot (reread + dup + compressible tool results)
        // 3. Lifetime avg from persisted stats (statsAll)
        let red = M.red;
        let capLabel = tr('dash_reduced');
        if (red === 0 && M.inTok > 0) {
          const compressible = (M.rereadWaste || 0) + (M.dupTokens || 0) + (M.compressible || 0);
          if (compressible > 0) {
            red = Math.min(Math.round(compressible / (compressible + M.inTok) * 100), 99);
            capLabel = tr('saveable');
          }
        }
        if (red === 0 && statsAll && statsAll.summary) {
          const lifetimePct = statsAll.summary.percentSaved || 0;
          if (lifetimePct > 0) { red = lifetimePct; capLabel = tr('dash_avg_saved'); }
        }
        ringTo($('#d_ring'), $('#d_pct'), red, 'var(--ac)');
        const capEl = $('#d_cap'); if (capEl) capEl.textContent = capLabel;
        $('#d_delta').textContent = red > 0 ? '−' + red + '%' : '';
        $('#d_in').textContent = fmtTok(M.inTok);
        $('#d_out').textContent = fmtTok(M.outTok);
      },
    },

    // ── Tools: call volume, the actual tools used, duplicates + heavy consumers ──
    tools: {
      title: 'tools',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('dash_tool_calls') + '</span><span class="w-pill" id="d_dupbadge" style="display:none"></span></div>' +
        '<div class="w-big" id="d_num">0</div><div class="w-sub">' + tr('dash_invocations') + '</div>' +
        '<div class="w-chips" id="d_chips"></div>' +
        '<div class="w-info-list">' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_dup_calls') + '</span><span class="w-info-v" id="d_dup">0</span></div>' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_unused') + '</span><span class="w-info-v" id="d_unused">0</span></div>' +
        '</div>',
      render(M, an) {
        animNum($('#d_num'), M.tools, an, (n) => String(Math.round(n)));
        // top tools by call count
        const used = Object.entries(M.toolsUsed).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const chips = $('#d_chips'); chips.innerHTML = '';
        if (!used.length) {
          chips.innerHTML = '<span class="w-chip muted">' + tr('dash_no_tools') + '</span>';
        } else {
          used.forEach(([name, n]) => {
            const c = document.createElement('span');
            c.className = 'w-chip';
            c.innerHTML = escHtml(name) + '<b>' + n + '</b>';
            chips.appendChild(c);
          });
        }
        const dupBadge = $('#d_dupbadge');
        if (M.dupTokens > 0) { dupBadge.style.display = ''; dupBadge.className = 'w-pill warn'; dupBadge.textContent = tr('dash_wasted', { n: fmtTok(M.dupTokens) }); }
        else dupBadge.style.display = 'none';
        $('#d_dup').textContent = String(M.dupCalls);
        $('#d_unused').textContent = String(M.unusedTools);
      },
    },

    agents: {
      title: 'dash_agents',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('dash_agents') + '</span><span class="w-live"><i></i>' + tr('dash_live') + '</span></div>' +
        '<div class="w-big" id="d_num">0<span class="w-unit"> ' + tr('dash_online') + '</span></div>' +
        '<div class="w-avatars" id="d_av"></div>' +
        '<div class="w-agts" id="d_agts"></div>',
      render(M, an) {
        const num = $('#d_num');
        if (num._n !== M.count) {
          num.innerHTML = M.count + '<span class="w-unit"> ' + tr('dash_online') + '</span>';
          if (M.count > (num._n || 0)) flashBump(num);
          num._n = M.count;
        }
        const av = $('#d_av'); av.innerHTML = '';
        M.list.slice(0, 6).forEach((s) => {
          const a = document.createElement('span'); a.className = 'w-av';
          a.textContent = s.agentIcon || '🤖'; av.appendChild(a);
        });
        // per-agent mini list: icon · name · model · turns
        const al = $('#d_agts'); al.innerHTML = '';
        if (!M.list.length) { al.innerHTML = '<span class="w-chip muted">' + tr('dash_waiting') + '</span>'; return; }
        M.list.slice(0, 4).forEach((s) => {
          const a = latestAction(s);
          const working = !!a && (a.kind === 'tool' || a.kind === 'asst');
          const info = planInfo[s.agentType];
          const wrap = document.createElement('div');
          wrap.className = 'w-agt-wrap';
          const row = document.createElement('div');
          row.className = 'w-agt';
          row.innerHTML =
            '<span class="w-agt-ico">' + (s.agentIcon || '🤖') + '</span>' +
            '<span class="w-agt-name">' + escHtml((s.agentName || 'Agent')) + '</span>' +
            (shortModel(s.model) ? '<span class="w-agt-model">' + escHtml(shortModel(s.model)) + '</span>' : '') +
            '<span class="w-agt-turns">' + (s.turns || 0) + 't</span>' +
            '<i class="w-agt-dot' + (working ? ' on' : '') + '"></i>';
          wrap.appendChild(row);
          // Plan / quota line: badge · utilization meter · live "resets in …" countdown.
          if (info) {
            const up = planUtil(info), rt = planReset(info);
            const meter = up != null
              ? '<span class="w-agt-quota' + (up > 85 ? ' danger' : up > 60 ? ' warn' : '') + '">' +
                  '<i style="width:' + Math.min(up, 100) + '%"></i></span>' +
                '<span class="w-agt-util">' + up + '%</span>'
              : '';
            const plan = document.createElement('div');
            plan.className = 'w-agt-plan';
            plan.innerHTML =
              '<span class="w-agt-badge">' + escHtml(planLabel(info)) + '</span>' + meter +
              (rt ? '<span class="w-agt-reset">' + escHtml(rt) + '</span>' : '');
            wrap.appendChild(plan);
          }
          al.appendChild(wrap);
        });
      },
    },

    savings: {
      title: 'dash_savings',
      html:
        '<div class="w-row"><span class="w-kicker">' + tr('dash_savings') + '</span><span class="w-delta" id="d_red"></span></div>' +
        '<div class="w-money"><span class="w-cur">$</span><span class="w-big" id="d_num">0</span><span class="w-cents" id="d_cents">.00</span></div>' +
        '<div class="w-sub" id="d_sub">' + tr('dash_est_session') + '</div>' +
        '<div class="w-spark" id="d_spark"></div>' +
        '<div class="w-info-list">' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_spend_so_far') + '</span><span class="w-info-v" id="d_spend">$0</span></div>' +
          '<div class="w-info"><span class="w-info-l">' + tr('dash_saved_tokens') + '</span><span class="w-info-v" id="d_savtok">0</span></div>' +
        '</div>',
      render(M, an) {
        const dollars = M.saved / 1e6 * USD_PER_M;
        const whole = Math.floor(dollars);
        animNum($('#d_num'), whole, an, (n) => String(Math.round(n)));
        $('#d_cents').textContent = '.' + String(Math.round((dollars - whole) * 100)).padStart(2, '0');
        $('#d_red').textContent = M.red > 0 ? '−' + M.red + '%' : '';
        const sub = $('#d_sub'); if (sub) sub.textContent = M.persisted ? tr('dash_est_alltime') : tr('dash_est_session');
        buildSpark($('#d_spark'), sparkVals(M, Math.max(dollars * 100, 8)));
        $('#d_spend').textContent = fmtUSD(M.cost);
        $('#d_savtok').textContent = fmtTok(M.saved);
      },
    },

    activity: {
      title: 'dash_activity',
      html:
        '<div class="w-activity">' +
          '<div class="w-act-head"><span class="w-act-ico" id="d_ico">🛰️</span>' +
            '<span class="w-act-name" id="d_name">' + tr('agent') + '</span>' +
            '<span class="w-act-status" id="d_status"><i class="w-dot"></i><span id="d_statustx">' + tr('monitoring') + '</span></span></div>' +
          '<div class="w-act-counts">' +
            '<span class="w-count"><b id="d_turns">0</b>' + tr('dash_turns_lc') + '</span>' +
            '<span class="w-count"><b id="d_tools">0</b>' + tr('dash_tools_lc') + '</span>' +
            '<span class="w-count"><b id="d_msgs">0</b>' + tr('dash_steps') + '</span>' +
          '</div>' +
          '<div class="w-flow" id="d_flow"></div>' +
        '</div>',
      render(M, an) {
        $('#d_ico').textContent = M.icon;
        $('#d_name').textContent = M.name;
        const st = $('#d_status'), stx = $('#d_statustx');
        st.className = 'w-act-status' + (M.working ? ' working' : '');
        stx.textContent = M.working ? tr('dash_working') : tr('monitoring');
        $('#d_turns').textContent = M.turns;
        $('#d_tools').textContent = M.tools;
        $('#d_msgs').textContent = M.messages.length;
        renderFlow(M.messages, an, M);
      },
    },
  };

  // ── live agent-flow (vertical chips, newest at the bottom, fresh slides in) ──
  function renderFlow(msgs, animate, M) {
    const flow = $('#d_flow');
    if (!flow) return;
    const list = (msgs || []).slice(-60);
    const sig = list.map((m) => (m.type || m.role || '') + ':' + ((m.tool_name || m.toolName || m.text || '').slice(0, 14)) + ':' + (m.tokens || 0)).join('|');
    if (sig === lastFlowSig && !animate) return;
    lastFlowSig = sig;
    if (!list.length) {
      flow.innerHTML = '<div class="w-empty"><span class="we-ico">\ud83d\udef0\ufe0f</span><span class="we-txt">' + tr('dash_waiting_activity') + '</span></div>';
      return;
    }
    // Measured Terse reduction rates for the badges: hook compression governs
    // tool results; the session's prompt-reduction rate governs user prompts.
    // These are real averages of what Terse actually did — never invented per-row.
    const hookPct = Math.round((window._terseHookStats && window._terseHookStats.percentSaved) || 0);
    const promptPct = Math.round((M && M.red) || 0);
    flow.innerHTML = '';
    list.forEach((m, i) => {
      const name = (m.tool_name || m.toolName || '').toString();
      const raw = (m.text || '').toString();
      let kind, ico, label, prev = '', redPct = 0;
      if (m.type === 'tool_use') {
        kind = 'tool'; ico = '\u2699'; label = name || tr('dash_tool');
        prev = raw;                       // tool input: file path / command / query
      } else if (m.type === 'tool_result') {
        kind = 'result'; ico = '\u2190'; label = name ? name + ' ' + tr('dash_result') : tr('dash_result');
        prev = raw;                       // result head: what came back
        redPct = hookPct;                 // Terse hook compression rate
      } else if (m.role === 'assistant') {
        kind = 'asst'; ico = '\u25c6'; label = tr('dash_responding');
        prev = raw;
      } else {
        kind = 'user'; ico = '\u2192'; label = tr('dash_prompt');
        prev = raw;
        redPct = promptPct;               // prompt-optimization rate
      }
      prev = prev.replace(/\s+/g, ' ').trim().slice(0, 92);
      const chip = document.createElement('div');
      chip.className = 'w-fchip ' + kind + (prev ? ' has-prev' : '') + (i === list.length - 1 ? ' fresh' : '');
      chip.style.animationDelay = (animate ? Math.max(0, (i - Math.max(0, list.length - 12))) * 0.04
                                           : Math.max(0, (i - (list.length - 2)) * 0.05)) + 's';
      const tok = m.tokens ? '<span class="fc-tok">' + fmtTok(m.tokens) + '</span>' : '';
      const red = redPct > 0 ? '<span class="fc-red" title="Terse \u5e73\u5747\u538b\u7f29 \u00b7 avg reduction">\u2212' + redPct + '%</span>' : '';
      chip.innerHTML =
        '<div class="fc-row"><span class="fc-ico">' + ico + '</span><span class="fc-label">' + escHtml(label) + '</span>' + red + tok + '</div>' +
        (prev ? '<div class="fc-prev">' + escHtml(prev) + '</div>' : '');
      flow.appendChild(chip);
    });
    requestAnimationFrame(() => { flow.scrollTop = flow.scrollHeight; });
  }

  // ── header agent-switcher ──
  function renderTabs() {
    const types = Object.keys(agents);
    tabsEl.innerHTML = '';
    if (sel !== 'all' && !agents[sel]) sel = 'all';
    if (types.length <= 1) { tabsEl.classList.remove('show'); return; }
    const mk = (id, ico, name, active) => {
      const b = document.createElement('button');
      b.className = 'dash-tab' + (active ? ' active' : '');
      b.innerHTML = (ico ? '<span class="tab-ico">' + ico + '</span>' : '') + '<span>' + escHtml(name) + '</span>';
      b.addEventListener('click', () => { if (sel !== id) { sel = id; render(true); renderTabs(); } });
      tabsEl.appendChild(b);
    };
    mk('all', '', tr('dash_all'), sel === 'all');
    types.forEach((t) => mk(t, agents[t].agentIcon || '🤖', (agents[t].agentName || t).split(' ')[0], sel === t));
  }

  // ── render dispatch ──
  const def = KINDS[KIND] || KINDS.saved;
  function render(animate) {
    def.render(source(), animate);
  }

  // ── build the widget body once ──
  function build() {
    titleEl.textContent = def.title ? tr(def.title) : 'Terse';
    bodyEl.innerHTML = def.html;
    render(true);
    renderTabs();
  }

  // ── hook stats keep savedTokensFor() honest ──
  function pullHookStats() {
    if (T.getHookStats) T.getHookStats().then((hs) => { if (hs) window._terseHookStats = hs; render(false); }).catch(() => {});
  }

  // ── persisted backend stats (lifetime) — the no-agent fallback data source ──
  function pullStats() {
    if (T.getStats) T.getStats('all').then((d) => { if (d) { statsAll = d; render(false); } }).catch(() => {});
  }

  // ── live agent sessions — authoritative reseed ──────────────────────────────
  // These dash windows are created HIDDEN at launch, before any agent connects,
  // so dash.js boots with an empty registry and misses the early agent-connected
  // events (and a hidden webview may not see every later one either). Re-pull the
  // connected sessions on a short interval and the instant the window is revealed,
  // so the boards always mirror what the island already shows — no more "0 online".
  function pullSessions(animate) {
    if (!T.getAgentSessions) return;
    T.getAgentSessions().then((sessions) => {
      const fresh = {};
      (sessions || []).forEach((s) => { if (s && s.agentType) fresh[s.agentType] = s; });
      // Prune agents that are no longer connected, add/refresh the live ones.
      Object.keys(agents).forEach((t) => { if (!fresh[t]) delete agents[t]; });
      Object.keys(fresh).forEach((t) => { agents[t] = fresh[t]; });
      renderTabs(); render(!!animate);
      refreshPlans();
    }).catch(() => {});
  }

  // ── per-agent plan / quota (Claude Code · Cursor · …) for the Agents board ──
  // Mirrors the popup's renderPlanInfo: 5h/7d reset window + utilization. Only the
  // Agents widget fetches this (the backend caches 5 min, so it's cheap regardless).
  const planInfo = {};        // agentType -> AgentPlanInfo
  const planFetchedAt = {};   // agentType -> ts (also doubles as in-flight guard)
  const PLAN_TTL = 60000;
  function refreshPlans() {
    if (KIND !== 'agents' || !T.getAgentPlanInfo) return;
    const now = Date.now();
    Object.keys(agents).forEach((t) => {
      if (planFetchedAt[t] && (now - planFetchedAt[t]) < PLAN_TTL) return;
      planFetchedAt[t] = now;
      T.getAgentPlanInfo(t).then((info) => {
        if (info && info.plan && info.plan !== 'unknown') { planInfo[t] = info; render(false); }
      }).catch(() => {});
    });
  }
  function planLabel(info) {
    const p = (info.rateLimitTier || info.plan || '').toLowerCase();
    if (p.includes('max_20x') || p.includes('max20x')) return 'Max 20x';
    if (p.includes('max_5x') || p.includes('max5x')) return 'Max 5x';
    if (p.includes('max')) return 'Max';
    if (p.includes('pro')) return 'Pro';
    if (p.includes('free') || p.includes('hobby')) return 'Free';
    if (p.includes('business')) return 'Business';
    return info.plan || '';
  }
  // Live "resets in Xh Ym" countdown for the soonest window (5h preferred, else 7d).
  function planReset(info) {
    if (info.requestsUsed != null && info.requestsMax != null)
      return tr('reqs_count', { used: info.requestsUsed, max: info.requestsMax });
    const period = info.shortTerm || info.longTerm;
    const resetAt = period && period.resetsAt;
    if (!resetAt) return '';
    const delta = new Date(resetAt) - new Date();
    if (delta <= 0) return tr('dash_resets_now');
    const h = Math.floor(delta / 3600000), m = Math.floor((delta % 3600000) / 60000);
    const time = (h > 0 ? h + 'h ' : '') + m + 'm';
    return (period.label ? period.label + ' ' : '') + tr('resets_in', { time });
  }
  function planUtil(info) {
    const period = info.shortTerm || info.longTerm;
    return period ? Math.round(period.utilization) : null;
  }

  // ── close button hides this window (re-shown from the launcher) ──
  // Prefer the backend toggle (works regardless of the JS window API surface);
  // fall back to hiding the current window directly.
  closeEl.addEventListener('click', () => {
    if (T.toggleDashboard) { T.toggleDashboard(KIND); return; }
    try { window.__TAURI__.window.getCurrentWindow().hide(); } catch (e) {}
  });

  // ── agent events (same stream the island consumes) ──
  T.on('agent-connected', (data) => { const s = data && data.session; if (s && s.agentType) { agents[s.agentType] = s; renderTabs(); render(false); } });
  T.on('agent-update',    (data) => { const s = data && data.session; if (s && s.agentType) { agents[s.agentType] = s; renderTabs(); render(false); } });
  T.on('agent-lost',         (data) => { const t = data && data.type; if (t) { delete agents[t]; renderTabs(); render(false); } });
  T.on('agent-disconnected', (data) => { const t = data && data.type; if (t) { delete agents[t]; renderTabs(); render(false); } });

  // ── boot ──
  build();
  pullHookStats();
  pullStats();
  pullSessions(true);
  setInterval(pullHookStats, 5000);
  setInterval(pullStats, 7000);
  // Keep the live agent registry (and the reset countdowns) self-healing.
  setInterval(() => pullSessions(false), 3000);
  // Re-seed the moment this (long-hidden) window is revealed on island hover, so it
  // never lingers on a stale "0 online" / "waiting…" state.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullSessions(true); });
  window.addEventListener('focus', () => pullSessions(false));
  // Backend fires this the instant the island reveals the boards on hover.
  T.on('dashboards-shown', () => { pullSessions(true); playEnter(); });

  // ── Entrance choreography: spring-in with a per-widget stagger every time
  //    the set is revealed, so opening the island feels like a deck fanning out.
  const ENTER_ORDER = ['session', 'saved', 'compression', 'cache', 'focus', 'tools', 'agents', 'savings', 'activity'];
  function playEnter() {
    const rootEl = document.getElementById('dashRoot');
    if (!rootEl) return;
    const idx = Math.max(0, ENTER_ORDER.indexOf(KIND));
    rootEl.style.setProperty('--enter-delay', (idx * 55) + 'ms');
    rootEl.classList.remove('enter');
    void rootEl.offsetWidth; // restart the animation
    rootEl.classList.add('enter');
  }
  playEnter();

  // ── hover handshake with the island ──
  // The dashboards are separate windows, so moving the pointer from the island onto
  // a board makes the island lose hover. Tell the island we're hovered so it cancels
  // its hide; tell it we left so it can hide the set — keeps reveal/hide snappy but
  // jitter-free across the window gap.
  function emitHover(name) { try { window.__TAURI__.event.emit(name); } catch (e) {} }
  document.documentElement.addEventListener('mouseenter', () => emitHover('dash-hover-enter'));
  document.documentElement.addEventListener('mouseleave', () => emitHover('dash-hover-leave'));
})();
