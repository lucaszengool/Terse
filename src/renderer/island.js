/* ──────────────────────────────────────────────────────────────────────────
   Dynamic Island (灵动岛) controller.
   Loaded AFTER popup.js, so popup.js's render engine (updateAgentPanel / showAgentPanel
   / event handlers) already drives #agentPanel inside this window — the panel is
   therefore identical to the popup monitor. This file owns only the island shell:
     • show/hide the island window based on connected-agent count
     • render the collapsed pill
     • hover expand / collapse (resizes the native window via island commands)
     • a multi-agent selector that switches which agent's panel is shown
   popup.js's autoResizePopup() is guarded to call window.__islandResize() in this window.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  if (!document.body.classList.contains('island-mode')) return;
  const T = window.terse;
  if (!T) { console.warn('[island] bridge not ready'); return; }

  const root      = document.getElementById('islandRoot');
  const pill      = document.getElementById('islandPill');
  const expandedEl= document.getElementById('islandExpanded');
  const tabsEl    = document.getElementById('islandAgentTabs');
  const pillIcon  = document.getElementById('islandPillIcon');
  const pillName  = document.getElementById('islandPillName');
  const pillMid   = document.querySelector('.island-pill-mid');
  const pillAct   = document.getElementById('islandPillAction');
  const pillSave  = document.getElementById('islandPillSave');
  const pillSaveN = document.getElementById('islandPillSaveNum');
  const pillRing  = document.getElementById('islandPillRing');
  const pillRingP = document.getElementById('islandPillRingPct');
  const pillGlyph = document.getElementById('islandPillGlyph');
  // Hero (expanded)
  const heroIcon  = document.getElementById('islandHeroIcon');
  const heroName  = document.getElementById('islandHeroName');
  const heroStat  = document.querySelector('.island-hero-status');
  const heroStatTx= document.getElementById('islandHeroStatusText');
  const heroSaved = document.getElementById('islandHeroSaved');
  const heroRing  = document.getElementById('islandHeroRing');
  const heroRingP = document.getElementById('islandHeroRingPct');
  const flowEl    = document.getElementById('islandFlow');
  const heroEl    = document.querySelector('.island-hero');
  const heroReduce= document.getElementById('islandHeroReduce');
  const heroMetrics = document.getElementById('islandHeroMetrics');
  const heroFx    = document.getElementById('islandHeroFx');
  const metricState = {};     // metric key -> last rendered value (for bump-on-change)
  let saveWashTimer = null;

  // ── Focus / calm mode + density prefs (persisted, plus OS reduced-motion) ──
  (function initPrefs() {
    const B = document.body;
    try {
      if (localStorage.getItem('terse_calm') === '1') B.classList.add('calm');
      if (localStorage.getItem('terse_density') === 'compact') B.classList.add('compact');
    } catch {}
    const persist = () => {
      try {
        localStorage.setItem('terse_calm', B.classList.contains('calm') ? '1' : '0');
        localStorage.setItem('terse_density', B.classList.contains('compact') ? 'compact' : 'cozy');
      } catch {}
    };
    const mkBtn = (label, title, cls, onToggle) => {
      const b = document.createElement('button');
      b.className = 'island-pref-btn' + (B.classList.contains(cls) ? ' on' : '');
      b.textContent = label; b.title = title;
      b.addEventListener('click', () => {
        B.classList.toggle(cls);
        b.classList.toggle('on', B.classList.contains(cls));
        persist(); onToggle && onToggle();
      });
      return b;
    };
    const row = document.createElement('div');
    row.className = 'island-prefs';
    row.appendChild(mkBtn('☾ Calm', 'Focus mode — freeze animations', 'calm'));
    row.appendChild(mkBtn('⊟ Compact', 'Denser layout', 'compact'));
    if (expandedEl) expandedEl.appendChild(row);
    // Global hook so main-window settings could flip focus mode too.
    window.terseSetCalm = (on) => { B.classList.toggle('calm', !!on); persist(); };
  })();
  // Bento dashboard refs
  const bentoEl     = document.getElementById('islandBento');
  const btSavedNum  = document.getElementById('btSavedNum');
  const btSavedDelta= document.getElementById('btSavedDelta');
  const btSavedSpark= document.getElementById('btSavedSpark');
  const btCacheNum  = document.getElementById('btCacheNum');
  const btCacheBar  = document.getElementById('btCacheBar');
  const btCacheBadge= document.getElementById('btCacheBadge');
  const btCompRing  = document.getElementById('btCompRing');
  const btCompPct   = document.getElementById('btCompPct');
  const btCompDelta = document.getElementById('btCompDelta');
  const btAgentsNum = document.getElementById('btAgentsNum');
  const btAgentAv   = document.getElementById('btAgentAvatars');
  const btFocusRing = document.getElementById('btFocusRing');
  const btFocusPct  = document.getElementById('btFocusPct');
  const btFocusDelta= document.getElementById('btFocusDelta');
  const btMoneyNum  = document.getElementById('btMoneyNum');
  const btMoneyCents= document.getElementById('btMoneyCents');
  const btMoneyDelta= document.getElementById('btMoneyDelta');
  const btActFlow   = document.getElementById('btActFlow');
  const btActStatus = document.getElementById('btActStatus');
  const btActStatusTx = document.getElementById('btActStatusTx');
  let bentoSavedShown = 0;    // animated count state (bento Saved tile)
  let bentoMoneyShown = 0;    // animated count state (bento Savings tile, in cents)
  let lastSparkKey = '';
  let lastActFlowKey = '';
  const USD_PER_M = 3.0;      // blended $/1M tokens — mirrors dash.js savings widget

  const agents = {};          // agentType -> latest snapshot
  let activeType   = null;    // which agent the expanded panel is showing
  let expanded     = false;
  let windowShown  = false;
  let collapseTimer = null;
  let pinned       = false;    // true = boards locked open via click; hover-leave won't hide
  let dashHovered  = false;    // true = pointer is currently over a dashboard board window
  let glyphTimer    = null;
  let activityTimer = null;
  let lastActionKey = '';     // dedupe ticker swaps
  let lastFlowKey   = '';     // dedupe flow rebuilds
  let savedShownPill = 0;     // animated count state (pill)
  let savedShownHero = 0;     // animated count state (hero)

  const count = () => Object.keys(agents).length;

  const fmtTok = (n) => (typeof window.formatTokens === 'function')
    ? window.formatTokens(n)
    : (n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(Math.round(n)));

  // All-time savings for the idle trophy line (refreshed once a minute).
  let lifetimeSaved = 0;
  async function loadLifetime() {
    try {
      const st = await T.getStats('all');
      const n = st && st.summary && st.summary.tokensSaved;
      if (typeof n === 'number') lifetimeSaved = n;
    } catch {}
  }
  loadLifetime();
  setInterval(loadLifetime, 60000);

  // Best-effort "tokens saved/saveable" for a snapshot (mirrors popup.js's hero math).
  function savedTokensFor(s) {
    const hook = (window._terseHookStats && window._terseHookStats.totalSaved) || 0;
    const auto = (s.autoOptimized && s.autoOptimized.tokensSaved) || 0;
    const opt  = s.optimizationStats || {};
    const potential = (opt.potentialSavings || 0) + (s.rereadWaste || 0)
      + ((s.toolCachePotential || {}).tokensWasted || 0)
      + ((s.toolResultStats || {}).compressibleTokens || 0);
    return Math.max(0, Math.round(hook + auto + potential));
  }

  // The agent's most recent meaningful step → {ico, label, kind}.
  function latestAction(s) {
    const msgs = s.recentMessages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const name = (m.tool_name || m.toolName || '').toString();
      if (m.type === 'tool_use')    return { ico: '⚙', label: name || 'running tool', kind: 'tool' };
      if (m.type === 'tool_result') return { ico: '←', label: (name ? name + ' result' : 'tool result'), kind: 'result' };
      if (m.role === 'assistant')   return { ico: '◆', label: shortText(m.text) || 'responding', kind: 'asst' };
      if (m.role === 'user')        return { ico: '→', label: shortText(m.text) || 'prompt', kind: 'user' };
    }
    return null;
  }
  function shortText(t) { return (t || '').replace(/\s+/g, ' ').trim().slice(0, 34); }

  // Color a context ring element by fill level.
  function ringColor(pct) { return pct > 85 ? '#ff6161' : pct > 60 ? '#ffc533' : 'var(--ac)'; }
  function setRing(el, labelEl, pct) {
    if (!el) return;
    if (pct > 0) {
      el.dataset.ctx = pct;
      el.style.setProperty('--ring-p', Math.min(pct, 100));
      el.style.setProperty('--ring-col', ringColor(pct));
      if (labelEl) labelEl.textContent = pct + '%';
    } else {
      delete el.dataset.ctx;
      el.style.setProperty('--ring-p', 0);
      if (labelEl) labelEl.textContent = '';
    }
  }

  // Animate a number from its current shown value up to `target`.
  const countTimers = new WeakMap();
  function countUp(el, from, target, onTick) {
    if (countTimers.has(el)) cancelAnimationFrame(countTimers.get(el));
    if (target <= 0) { el.textContent = '0'; onTick && onTick(0); return; }
    const start = performance.now(), dur = 650, delta = target - from;
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(from + delta * eased);
      el.textContent = fmtTok(val);
      onTick && onTick(val);
      if (t < 1) countTimers.set(el, requestAnimationFrame(step));
    }
    countTimers.set(el, requestAnimationFrame(step));
  }

  // Pick the agent to feature: the user-selected one, else the richest by tokens+turns.
  function pickActive() {
    if (activeType && agents[activeType]) return activeType;
    let best = null, bestScore = -1;
    for (const t in agents) {
      const s = agents[t];
      const score = (s.totalInputTokens || 0) + (s.turns || 0) * 1000;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    activeType = best;
    return best;
  }

  // Live token-reduction rate (%) — prefer the hook's measured compression, else derive
  // from saved vs original. This is "how much Terse is shrinking the context right now".
  function reductionPct(s) {
    const hp = (window._terseHookStats && window._terseHookStats.percentSaved) || 0;
    if (hp > 0) return Math.round(hp);
    const saved = savedTokensFor(s);
    const inTok = s.totalInputTokens || 0;
    const base = saved + inTok;
    return base > 0 ? Math.round((saved / base) * 100) : 0;
  }

  // A working agent = its latest meaningful step is the model running a tool or replying.
  function isWorking(s) {
    const a = s && latestAction(s);
    return !!a && (a.kind === 'tool' || a.kind === 'asst');
  }

  // Live "quality" strip: Reduce (token cut) · Cache (cost/accuracy) · Context (health).
  // Each pill colour-codes its value and bumps when it changes — vivid but legible.
  function setMetric(key, label, val, col) {
    if (!heroMetrics) return;
    let el = heroMetrics.querySelector('[data-k="' + key + '"]');
    if (!el) {
      el = document.createElement('span');
      el.className = 'hero-metric'; el.dataset.k = key;
      el.innerHTML = '<span class="hm-dot"></span><span class="hm-label"></span><span class="hm-val"></span>';
      heroMetrics.appendChild(el);
    }
    el.style.setProperty('--hm-col', col);
    el.querySelector('.hm-label').textContent = label;
    if (metricState[key] !== val) {
      el.querySelector('.hm-val').textContent = val;
      if (metricState[key] !== undefined) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
      metricState[key] = val;
    }
  }
  function renderMetrics(s) {
    const red = reductionPct(s);
    const cache = s.cacheEfficiency || 0;
    const ctx = s.contextFill || 0;
    setMetric('red',  'Reduce',  red > 0 ? '−' + red + '%' : '0%', 'var(--ac)');
    setMetric('cache','Cache',   cache + '%', cache > 50 ? 'var(--ac)' : cache > 20 ? '#ffc533' : '#ff6161');
    setMetric('ctx',  'Context', ctx + '%',   ctx > 85 ? '#ff6161' : ctx > 60 ? '#ffc533' : 'var(--ac)');
  }

  // Floating "+N saved" gain that rises & fades — fires when savings tick up.
  function spawnHeroFloat(text) {
    if (!heroFx) return;
    const f = document.createElement('span');
    f.className = 'hero-float';
    f.textContent = text;
    heroFx.appendChild(f);
    setTimeout(() => { try { f.remove(); } catch (e) {} }, 1200);
  }

  // Aggregate live stats across EVERY connected agent — the bento shows the whole fleet,
  // not just the focused one (that's the "show all the boards" ask).
  function aggregate() {
    const list = Object.values(agents);
    let saved = 0, inTok = 0, cacheSum = 0, cacheN = 0, ctxMax = 0, tools = 0, working = false;
    let msgs = [];
    list.forEach((s) => {
      saved += savedTokensFor(s);
      inTok += s.totalInputTokens || 0;
      tools += s.toolCallCount || 0;
      if (s.cacheEfficiency != null) { cacheSum += s.cacheEfficiency; cacheN++; }
      ctxMax = Math.max(ctxMax, s.contextFill || 0);
      if (isWorking(s)) working = true;
      (s.recentMessages || []).slice(-4).forEach((m) => msgs.push({ ...m, _icon: s.agentIcon }));
    });
    const hp = (window._terseHookStats && window._terseHookStats.percentSaved) || 0;
    const red = hp > 0 ? Math.round(hp) : (saved + inTok > 0 ? Math.round(saved / (saved + inTok) * 100) : 0);
    const cache = cacheN ? Math.round(cacheSum / cacheN) : 0;
    return { list, saved, inTok, red, cache, ctxMax, tools, count: list.length,
             working, messages: msgs.slice(-9) };
  }

  // Build the Saved-tile sparkline from each agent's saved contribution (or a synthetic
  // ramp when there's a single agent) — purely a vivid "trend" signal.
  function renderSpark(a) {
    if (!btSavedSpark) return;
    let vals = a.list.map((s) => savedTokensFor(s)).filter((v) => v > 0);
    if (vals.length < 2) {
      // Single agent → show a gentle rising ramp seeded by the reduction rate
      const base = Math.max(a.red, 8);
      vals = [0.35, 0.5, 0.42, 0.66, 0.58, 0.8, 1].map((m) => m * base);
    }
    const key = vals.map((v) => Math.round(v)).join(',');
    if (key === lastSparkKey) return;
    lastSparkKey = key;
    const max = Math.max.apply(null, vals) || 1;
    btSavedSpark.innerHTML = '';
    vals.slice(-7).forEach((v) => {
      const bar = document.createElement('i');
      bar.style.height = Math.max(12, Math.round(v / max * 100)) + '%';
      btSavedSpark.appendChild(bar);
    });
  }

  // Populate the bento boards. animate=true replays the cascade reveal.
  function renderBento(animate) {
    if (!bentoEl) return;
    const a = aggregate();

    // Saved (count-up + reduction delta)
    if (btSavedNum) {
      if (a.saved !== bentoSavedShown) {
        const grew = a.saved > bentoSavedShown;
        countUp(btSavedNum, bentoSavedShown, a.saved);
        bentoSavedShown = a.saved;
        if (grew && a.saved > 0) { btSavedNum.classList.remove('bump'); void btSavedNum.offsetWidth; btSavedNum.classList.add('bump'); }
      } else {
        btSavedNum.textContent = fmtTok(a.saved);
      }
    }
    if (btSavedDelta) btSavedDelta.textContent = a.red > 0 ? '−' + a.red + '%' : '';
    renderSpark(a);

    // Cache (hit rate → "faster / cost down")
    if (btCacheNum) btCacheNum.textContent = a.cache + '%';
    if (btCacheBar) {
      btCacheBar.style.width = Math.min(a.cache, 100) + '%';
      btCacheBar.className = 'bt-bar-fill' + (a.cache > 50 ? '' : a.cache > 20 ? ' warn' : ' danger');
    }
    if (btCacheBadge) {
      btCacheBadge.className = 'bt-delta good' + (a.cache > 50 ? '' : a.cache > 20 ? ' warn' : ' bad');
      btCacheBadge.textContent = a.cache > 50 ? 'faster' : a.cache > 20 ? 'warming' : 'cold';
    }

    // Compression (token-reduction rate as a ring — the headline "how much smaller")
    if (btCompRing) {
      btCompRing.style.setProperty('--ring-p', Math.min(a.red, 100));
      btCompRing.style.setProperty('--ring-col', 'var(--ac)');
    }
    if (btCompPct) btCompPct.textContent = a.red + '%';
    if (btCompDelta) btCompDelta.textContent = a.red > 0 ? '−' + a.red + '%' : '';

    // Agents online (count + avatar stack + equalizer)
    if (btAgentsNum) btAgentsNum.innerHTML = a.count + '<span class="bt-num-unit"> online</span>';
    if (btAgentAv) {
      btAgentAv.innerHTML = '';
      a.list.slice(0, 4).forEach((s) => {
        const av = document.createElement('span');
        av.className = 'bt-av';
        av.textContent = s.agentIcon || '🤖';
        btAgentAv.appendChild(av);
      });
    }

    // Focus (context headroom = 100 − fill; higher is healthier → better accuracy)
    const headroom = Math.max(0, 100 - a.ctxMax);
    if (btFocusRing) {
      btFocusRing.style.setProperty('--ring-p', headroom);
      btFocusRing.style.setProperty('--ring-col', headroom < 15 ? '#ff6161' : headroom < 40 ? '#ffc533' : 'var(--ac)');
    }
    if (btFocusPct) btFocusPct.textContent = headroom + '%';
    if (btFocusDelta) btFocusDelta.textContent = headroom >= 60 ? 'healthy' : headroom >= 30 ? 'watch' : 'full';

    // Savings (estimated $ this session — whole dollars + cents, bumps when it grows).
    // fmtTok would mangle dollars ("1.5K"), so the money read-out is set as a plain int.
    const cents = Math.round(a.saved / 1e6 * USD_PER_M * 100);
    if (btMoneyNum) {
      btMoneyNum.textContent = String(Math.floor(cents / 100));
      if (cents > bentoMoneyShown && cents > 0) {
        btMoneyNum.classList.remove('bump'); void btMoneyNum.offsetWidth; btMoneyNum.classList.add('bump');
      }
      bentoMoneyShown = cents;
    }
    if (btMoneyCents) btMoneyCents.textContent = '.' + String(cents % 100).padStart(2, '0');
    if (btMoneyDelta) btMoneyDelta.textContent = a.red > 0 ? '−' + a.red + '%' : '';

    // Activity (live flow chips — replaces the old big monitor log)
    if (btActStatus) {
      btActStatus.className = 'bt-live' + (a.working ? ' working' : '');
      if (btActStatusTx) btActStatusTx.textContent = a.working ? 'working' : 'live';
    }
    renderActivityBoard(a.messages, animate);

    if (animate) {
      bentoEl.classList.remove('reveal'); void bentoEl.offsetWidth; bentoEl.classList.add('reveal');
      bentoSavedShown = 0; // so the count-up animates fresh on each open
      bentoMoneyShown = 0;
      lastSparkKey = '';
      lastActFlowKey = '';
      countUp(btSavedNum, 0, a.saved);
      bentoSavedShown = a.saved;
      renderSpark(a);
      renderActivityBoard(a.messages, true);
    }
  }

  // Vertical live flow for the Activity board (newest at the bottom). Mirrors dash.js.
  function renderActivityBoard(msgs, animate) {
    if (!btActFlow) return;
    const list = (msgs || []).slice(-9);
    const sig = list.map((m) => (m.type || m.role || '') + ':' +
      ((m.tool_name || m.toolName || m.text || '').slice(0, 14)) + ':' + (m.tokens || 0)).join('|');
    if (sig === lastActFlowKey && !animate) return;
    lastActFlowKey = sig;
    if (!list.length) {
      btActFlow.innerHTML = '<div class="bt-empty"><span>🛰️</span><span>Waiting for agent activity…</span></div>';
      return;
    }
    btActFlow.innerHTML = '';
    list.forEach((m, i) => {
      const name = (m.tool_name || m.toolName || '').toString();
      let kind, ico, label;
      if (m.type === 'tool_use')         { kind = 'tool';   ico = '⚙'; label = name || 'tool'; }
      else if (m.type === 'tool_result'){ kind = 'result'; ico = '←'; label = name ? name + ' result' : 'result'; }
      else if (m.role === 'assistant')  { kind = 'asst';   ico = '◆'; label = shortText(m.text) || 'responding'; }
      else                              { kind = 'user';   ico = '→'; label = shortText(m.text) || 'prompt'; }
      const chip = document.createElement('div');
      chip.className = 'bt-fchip ' + kind + (i === list.length - 1 ? ' fresh' : '');
      const tok = m.tokens ? '<span class="fc-tok">' + fmtTok(m.tokens) + '</span>' : '';
      chip.innerHTML = '<span class="fc-ico">' + ico + '</span><span class="fc-label">' + escHtml(label) + '</span>' + tok;
      btActFlow.appendChild(chip);
    });
    requestAnimationFrame(() => { btActFlow.scrollTop = btActFlow.scrollHeight; });
  }

  // ── Collapsed pill ── richer & live: icon · name/action ticker · ⚡savings · ctx ring
  function renderPill() {
    const n = count();
    const at = pickActive();
    const s = at ? agents[at] : null;
    if (!s) {
      pillIcon.textContent = '';
      pillName.textContent = 'Terse';
      // Idle flex: no live agent, so show the all-time savings as the ticker —
      // the island reads as a trophy instead of an empty shell.
      if (lifetimeSaved > 0) {
        pillMid.classList.add('has-action');
        if (lastActionKey !== 'lifetime') {
          pillAct.innerHTML = '<span class="act-ico">⚡</span>' + fmtTok(lifetimeSaved) + ' tokens saved all-time';
          pillAct.classList.remove('swap'); void pillAct.offsetWidth; pillAct.classList.add('swap');
          lastActionKey = 'lifetime';
        }
      } else {
        // Cold start: no agent, nothing saved yet. Teach instead of sitting blank.
        pillMid.classList.add('has-action');
        if (lastActionKey !== 'teach') {
          pillAct.innerHTML = '<span class="act-ico">✨</span>Start Claude Code — I light up automatically';
          pillAct.classList.remove('swap'); void pillAct.offsetWidth; pillAct.classList.add('swap');
          lastActionKey = 'teach';
        }
      }
      pillSave.classList.add('zero');
      setRing(pillRing, pillRingP, 0);
      return;
    }
    pillIcon.textContent = s.agentIcon || '🤖';
    pillName.textContent = n > 1 ? (n + ' agents') : (s.agentName || 'Agent');

    // Live action ticker — slide-swap when the current step changes
    const act = latestAction(s);
    // "working" = model is running a tool or replying → hotter pill treatment
    pill.classList.toggle('working', !!act && (act.kind === 'tool' || act.kind === 'asst'));
    const key = act ? (act.kind + '|' + act.label) : '';
    if (act) {
      pillMid.classList.add('has-action');
      if (key !== lastActionKey) {
        pillAct.innerHTML = '<span class="act-ico">' + act.ico + '</span>' + escHtml(act.label);
        pillAct.classList.remove('swap'); void pillAct.offsetWidth; pillAct.classList.add('swap');
      }
    } else {
      pillMid.classList.remove('has-action');
    }
    lastActionKey = key;

    // Savings chip with count-up + bump on increase
    const saved = savedTokensFor(s);
    if (saved > 0) {
      pillSave.classList.remove('zero');
      if (saved !== savedShownPill) {
        const grew = saved > savedShownPill;
        // Every 10K saved crossed = a milestone: the aurora rim blazes and the
        // pill pops — the visible payoff moment for the user.
        const crossed = Math.floor(saved / 10000) > Math.floor(savedShownPill / 10000);
        pillSave.classList.add('counting');
        countUp(pillSaveN, savedShownPill, saved);
        setTimeout(() => {
          pillSave.classList.remove('counting', 'landed');
          void pillSave.offsetWidth;
          pillSave.classList.add('landed');
        }, 680);
        savedShownPill = saved;
        if (grew) { pillSave.classList.remove('bump'); void pillSave.offsetWidth; pillSave.classList.add('bump'); }
        if (crossed) {
          pill.classList.remove('milestone'); void pill.offsetWidth;
          pill.classList.add('milestone');
          setTimeout(() => pill.classList.remove('milestone'), 950);
        }
      }
    } else {
      pillSave.classList.add('zero');
    }

    // Context ring
    const ctxNow = s.contextFill || 0;
    setRing(pillRing, pillRingP, ctxNow);
    // Pre-compaction states: amber at 75%, pulsing red at 90% — visible without expanding
    pill.classList.toggle('ctx-warn', ctxNow >= 75 && ctxNow < 90);
    pill.classList.toggle('ctx-danger', ctxNow >= 90);
  }

  // ── Expanded hero header ──
  // ── Savings ledger ────────────────────────────────────────────────────────
  // The island showed "tokens saved" with nothing to compare it against, so the
  // number meant little. This renders the counterfactual: what the session WOULD
  // have cost, what it actually cost, and the slice Terse removed.
  const ilg = {
    box:    document.getElementById('islandLedger'),
    fill:   document.getElementById('ilgFill'),
    cut:    document.getElementById('ilgCut'),
    cutLbl: document.getElementById('ilgCutLbl'),
    would:  document.getElementById('ilgWould'),
    actual: document.getElementById('ilgActual'),
    saved:  document.getElementById('ilgSaved'),
  };
  const ilgLast = {};
  function ilgSet(el, text) {
    if (!el || el.textContent === text) return;      // only animate real changes
    el.textContent = text;
    el.classList.remove('bump');
    void el.offsetWidth;                              // restart the tick
    el.classList.add('bump');
  }
  // Labels follow the app language like the rest of the island.
  const ILG_STR = {
    en:        { would: 'Would have used', actual: 'Actually used', saved: 'Terse saved' },
    'zh-Hans': { would: '原本消耗',        actual: '实际消耗',      saved: 'Terse 省下' },
    'zh-Hant': { would: '原本消耗',        actual: '實際消耗',      saved: 'Terse 省下' },
  };
  function ilgLang() {
    try {
      const l = window.i18n && window.i18n.getLang();
      if (l && ILG_STR[l]) return ILG_STR[l];
    } catch (e) {}
    return ILG_STR.en;
  }
  function renderLedgerLabels() {
    const d = ilgLang();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('ilgWouldK', d.would); set('ilgActualK', d.actual); set('ilgSavedK', d.saved);
  }
  renderLedgerLabels();
  window.addEventListener('terse-lang-changed', renderLedgerLabels);

  function renderLedger(s) {
    if (!ilg.box || !s) return;
    const actual = (s.totalInputTokens || 0) + (s.totalOutputTokens || 0);
    const saved  = savedTokensFor(s);
    const would  = actual + saved;                    // the bill that never arrived
    if (would <= 0) { ilg.box.style.display = 'none'; return; }
    ilg.box.style.display = '';

    const pct = Math.max(0, Math.min(100, Math.round((saved / would) * 100)));
    // Bar splits into what you paid vs what Terse cut.
    ilg.fill.style.width = (100 - pct) + '%';
    ilg.cut.style.width  = pct + '%';
    // Only show the label once the slice is wide enough to hold it legibly.
    ilg.cut.classList.toggle('wide', pct >= 12);
    ilg.cutLbl.textContent = '−' + pct + '%';

    ilgSet(ilg.would,  fmtTok(would));
    ilgSet(ilg.actual, fmtTok(actual));
    ilgSet(ilg.saved,  fmtTok(saved));
    ilgLast.pct = pct;
  }

  function renderHero(s) {
    if (!s) return;
    heroIcon.textContent = s.agentIcon || '🤖';
    heroName.textContent = s.agentName || 'Agent';
    renderLedger(s);

    // Working vs idle — fresh activity within the last few seconds reads as "working"
    const act = latestAction(s);
    if (act) {
      heroStat.classList.remove('idle');
      heroStatTx.textContent = act.kind === 'tool' ? ('Running ' + act.label)
        : act.kind === 'result' ? 'Reading result'
        : act.kind === 'asst' ? 'Responding' : 'Monitoring';
      heroStatTx.classList.toggle('working', act.kind === 'tool' || act.kind === 'asst');
    } else {
      heroStat.classList.add('idle');
      heroStatTx.classList.remove('working');
      heroStatTx.textContent = 'Monitoring';
    }

    // Count-up savings + vivid "gain" feedback when the number grows
    const saved = savedTokensFor(s);
    if (saved !== savedShownHero) {
      const prev = savedShownHero;
      const grew = saved > prev;
      countUp(heroSaved, prev, saved);
      savedShownHero = saved;
      if (grew && saved > 0) {
        heroSaved.classList.remove('bump'); void heroSaved.offsetWidth; heroSaved.classList.add('bump');
        if (prev > 0) {
          spawnHeroFloat('+' + fmtTok(saved - prev));
          if (heroEl) {
            heroEl.classList.remove('saving'); void heroEl.offsetWidth; heroEl.classList.add('saving');
            if (saveWashTimer) clearTimeout(saveWashTimer);
            saveWashTimer = setTimeout(() => heroEl.classList.remove('saving'), 950);
          }
        }
      }
    }

    // Live token-reduction badge beside the saved count
    const red = reductionPct(s);
    if (heroReduce) {
      if (red > 0) {
        heroReduce.classList.add('show');
        const txt = '−' + red + '%';
        if (heroReduce.textContent !== txt) {
          heroReduce.textContent = txt;
          heroReduce.classList.remove('bump'); void heroReduce.offsetWidth; heroReduce.classList.add('bump');
        }
      } else {
        heroReduce.classList.remove('show');
      }
    }

    renderMetrics(s);
    setRing(heroRing, heroRingP, s.contextFill || 0);
    renderFlow(s);
  }

  // ── Live agent-flow strip — recent steps as chips that flow in from the right ──
  function renderFlow(s) {
    if (!s) return;
    const msgs = (s.recentMessages || []).slice(-7);
    const sig = msgs.map(m => (m.type || m.role || '') + ':' + ((m.tool_name || m.toolName || m.text || '').slice(0, 14)) + ':' + (m.tokens || 0)).join('|');
    if (sig === lastFlowKey) return;
    lastFlowKey = sig;

    flowEl.innerHTML = '';
    msgs.forEach((m, i) => {
      if (i > 0) {
        const a = document.createElement('span'); a.className = 'flow-arrow'; a.textContent = '›'; flowEl.appendChild(a);
      }
      const name = (m.tool_name || m.toolName || '').toString();
      let kind, ico, label;
      if (m.type === 'tool_use')         { kind = 'tool';   ico = '⚙'; label = name || 'tool'; }
      else if (m.type === 'tool_result'){ kind = 'result'; ico = '←'; label = name || 'result'; }
      else if (m.role === 'assistant')  { kind = 'asst';   ico = '◆'; label = shortText(m.text) || 'reply'; }
      else                              { kind = 'user';   ico = '→'; label = shortText(m.text) || 'prompt'; }
      const chip = document.createElement('span');
      chip.className = 'flow-chip ' + kind + (i === msgs.length - 1 ? ' fresh' : '');
      const tok = m.tokens ? '<span class="fc-tok">' + fmtTok(m.tokens) + '</span>' : '';
      chip.innerHTML = '<span class="fc-ico">' + ico + '</span>' + escHtml(label.slice(0, 18)) + tok;
      flowEl.appendChild(chip);
    });
    requestAnimationFrame(() => { flowEl.scrollLeft = flowEl.scrollWidth; });
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Brief whole-pill flash + equalizer burst when a new step arrives.
  function flashActivity() {
    pill.classList.remove('activity'); void pill.offsetWidth; pill.classList.add('activity');
    pillGlyph.classList.add('active');
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => pillGlyph.classList.remove('active'), 1400);
  }

  // ── Multi-agent selector (expanded view) ──
  function renderTabs() {
    const types = Object.keys(agents);
    if (types.length <= 1) { tabsEl.classList.remove('show'); tabsEl.innerHTML = ''; return; }
    const at = pickActive();
    tabsEl.classList.add('show');
    tabsEl.innerHTML = '';
    for (const t of types) {
      const s = agents[t];
      const chip = document.createElement('button');
      chip.className = 'island-agent-chip' + (t === at ? ' active' : '');
      chip.innerHTML = '<span class="chip-ico">' + (s.agentIcon || '🤖') +
                       '</span><span class="chip-name"></span>';
      chip.querySelector('.chip-name').textContent = s.agentName || t;
      chip.addEventListener('click', () => {
        activeType = t;
        // Reset animated counters so the new agent's stats count up fresh
        savedShownPill = 0; savedShownHero = 0; lastActionKey = ''; lastFlowKey = '';
        if (typeof window.showAgentPanel === 'function') window.showAgentPanel(agents[t]);
        renderHero(agents[t]);
        renderTabs(); renderPill(); scheduleResize();
      });
      tabsEl.appendChild(chip);
    }
  }

  // Brief activity flash on the pill when a snapshot updates.
  function pulseGlyph() {
    pillGlyph.classList.add('tick');
    if (glyphTimer) clearTimeout(glyphTimer);
    glyphTimer = setTimeout(() => pillGlyph.classList.remove('tick'), 500);
  }

  // ── Window visibility follows connected-agent count ──
  function ensureWindow() {
    // Visibility depends only on whether any agent is connected — monitoring is
    // free forever, so there is no plan check here.
    const n = count();
    if (n > 0 && !windowShown) {
      windowShown = true;
      T.showIslandWindow();
    } else if (n === 0 && windowShown) {
      windowShown = false;
      collapse(true);
      T.hideIslandWindow();
    }
  }

  // ── Show / hide the dashboard constellation ────────────────────────────────
  function keepOpen() { if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; } }

  // While the island is showing something the user must click, the floating boards
  // are in the way — they cover the region directly under the pill, which is exactly
  // where the alert's buttons land. Suppress them for the duration.
  let dashSuppressed = false;

  function expand() {
    keepOpen();
    if (expanded || count() === 0 || dashSuppressed) return;
    expanded = true;
    pill.classList.add('peek');
    if (T.openDashboards) T.openDashboards();
  }

  // Called by the alert layer when it takes over the island (and again when it lets go).
  window.__islandSuppressDash = function (on) {
    dashSuppressed = !!on;
    if (on) collapse(true);   // force-close regardless of pin, so nothing overlaps the alert
  };

  // `now=true` force-collapses regardless of pin; `now=false` debounces + respects pin.
  function collapse(now) {
    if (!now && pinned) return;  // hover-leave is blocked while click-pinned
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    const doIt = () => {
      if (!expanded) return;
      pinned = false; expanded = false;
      pill.classList.remove('peek');
      if (T.hideDashboards) T.hideDashboards();
    };
    if (now) doIt(); else collapseTimer = setTimeout(doIt, 200);
  }

  // ── Click pill: primary show/hide trigger (safety guard for when hover is unreliable) ──
  // mousedown fires before click and works even if macOS accept_first_mouse is false,
  // ensuring the first tap on a previously-unfocused overlay window always registers.
  pill.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (!expanded) { pinned = true; expand(); }
  });
  // click handles the close toggle (mousedown only expands, click also collapses)
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (expanded) { collapse(true); }    // click while open → force-close + unpin
    else { pinned = true; expand(); }    // click while closed → pin + show
  });

  // ── Hover: pill-level mouseenter/leave + document-level mousemove as backup ──
  // pill mouseenter/leave is more reliable than document-mousemove over transparent areas.
  pill.addEventListener('mouseenter', () => { keepOpen(); if (!expanded) expand(); });
  pill.addEventListener('mouseleave', () => { if (!pinned) collapse(false); });
  // Document-level backup: any movement inside the window triggers expand.
  document.addEventListener('mousemove', () => { if (!expanded) expand(); else keepOpen(); });
  document.addEventListener('mouseleave', () => { if (!pinned) collapse(false); });

  // ── Click elsewhere: island loses focus → collapse (safety guard for click mode) ──
  // `dashHovered` guards against collapsing when focus moved to a board window.
  // Grace window is 500ms (matches collapse debounce) to handle IPC round-trip latency.
  window.addEventListener('blur', () => {
    if (!expanded || dashHovered) return;
    setTimeout(() => {
      if (expanded && !dashHovered) {
        pinned = false; expanded = false;
        pill.classList.remove('peek');
        if (T.hideDashboards) T.hideDashboards();
      }
    }, 500);
  });

  // ── Hover handshake with the separate dashboard board windows ──
  // Boards emit dash-hover-enter/leave (see dash.js) so the constellation behaves
  // like one hover region spanning multiple native windows. These keep *reveal*
  // snappy but are unreliable for *collapse* (leave events race/drop across the
  // gaps between transparent overlay windows).
  T.on('dash-hover-enter', () => { dashHovered = true; keepOpen(); });
  T.on('dash-hover-leave', () => { dashHovered = false; });

  // ── Authoritative collapse signal: global cursor poll (see lib.rs) ──
  // The backend polls the real pointer position against the union of the island
  // pill + every visible board and emits one consolidated inside/outside signal,
  // already grace-debounced. This is what actually makes "move off the windows →
  // collapse" reliable; a click-pin still keeps the set open until clicked again.
  T.on('dash-cursor-inside',  () => { dashHovered = true; keepOpen(); });
  T.on('dash-cursor-outside', () => { dashHovered = false; if (!pinned) collapse(true); });
  // Native hover-open: the Rust cursor poll fires this the instant the pointer
  // touches the pill — no reliance on webview mouseenter (which drops events
  // whenever the overlay window is unfocused).
  T.on('island-hover', () => { keepOpen(); if (!expanded) expand(); });

  // Cap the expanded card to the screen height (fixed px, not 100vh) so its content
  // can be measured uncapped-by-the-window and the card scrolls internally past the cap.
  function applyExpandedCap() {
    const avail = (window.screen && window.screen.availHeight) || 900;
    expandedEl.style.maxHeight = Math.max(360, avail - 16) + 'px';
  }
  applyExpandedCap();

  // ── Resize hook — popup.js autoResizePopup() delegates here when in island mode ──
  // The island is now ALWAYS a fixed-size pill (the detail lives in the separate
  // floating windows), so this is intentionally a no-op: popup.js must never grow
  // the pill window.
  function scheduleResize() { /* pill is fixed-size; dashboards are separate windows */ }
  window.__islandResize = scheduleResize;

  // ── Agent events (popup.js handles the panel; we handle the shell) ──
  T.on('agent-connected', (data) => {
    const s = data && data.session;
    if (!s || !s.agentType) return;
    agents[s.agentType] = s;
    ensureWindow();
    renderPill(); renderTabs();
    if (expanded) renderHero(agents[pickActive()]);
  });

  T.on('agent-update', (data) => {
    const s = data && data.session;
    if (!s || !s.agentType) return;
    agents[s.agentType] = s;
    pulseGlyph();
    // Flash the pill only when the *featured* agent advances to a new step
    const at = pickActive();
    if (at === s.agentType) {
      const act = latestAction(s);
      const key = act ? (act.kind + '|' + act.label) : '';
      if (key && key !== lastActionKey) flashActivity();
    }
    renderPill(); renderTabs();
    // The floating windows self-update from the same agent stream, so the island
    // only needs to keep its pill fresh here.
  });

  T.on('agent-lost', (data) => {
    const t = data && data.type;
    if (!t) return;
    delete agents[t];
    if (activeType === t) activeType = null;
    renderPill(); renderTabs(); ensureWindow(); scheduleResize();
  });

  T.on('agent-disconnected', (data) => {
    const t = data && data.type;
    if (t) { delete agents[t]; if (activeType === t) activeType = null; }
    renderPill(); renderTabs(); ensureWindow(); scheduleResize();
  });

  // ── Session summary: a subtle two-note chime marks the payoff moment.
  // Synthesized (no asset) and silenced in Calm/focus mode.
  T.on('agent-summary', () => {
    try {
      if (document.body.classList.contains('calm')) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      [660, 880].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(g); g.connect(ctx.destination);
        const t0 = ctx.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.start(t0); o.stop(t0 + 0.24);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 700);
    } catch {}
  });

  // ── Pull-down from the main window: focus an agent and expand the island ──
  T.on('island-focus', (data) => {
    const t = data && data.agentType;
    if (t && agents[t]) activeType = t;
    windowShown = true;            // the command already showed the native window
    renderPill(); renderTabs();
    if (count() > 0) expand();     // expand() switches the panel to pickActive()/activeType
  });

  // ── Grace window ended with no plan ──
  // The island is a MONITOR, and monitoring is free forever — so it keeps running
  // for free users. Pro gates the things that act on your tokens (optimization,
  // Speed Up, graph-for-agents), which are enforced at their own entry points.
  // Hiding the island here also silently killed the approval scanner, which only
  // runs while the island is visible — a blocked agent went unreported.
  T.on('trial-grace-expired', () => {
    // Collapse the floating dashboards (a Pro surface) but keep the pill alive.
    collapse(true);
    renderPill();
  });

  // ── Keep window._terseHookStats fresh independent of the (now hidden) popup panel ──
  // popup.js still pulls it, but the boards are the primary surface now, so the island
  // pulls on its own cadence too (mirrors dash.js) and re-renders when it changes.
  function pullHookStats() {
    if (!T.getHookStats) return;
    T.getHookStats().then((hs) => {
      if (!hs) return;
      window._terseHookStats = hs;
      renderPill();
      if (expanded) {
        const at = pickActive();
        if (at) renderHero(agents[at]);
        renderBento(false);
      }
    }).catch(() => {});
  }
  pullHookStats();
  setInterval(pullHookStats, 5000);

  // ── Seed from connected sessions on load, then keep self-healing ──
  // Re-pull periodically so a missed agent-connected/lost event can't leave the pill
  // stale (this is the same authoritative source the boards reseed from).
  function reseedSessions() {
    if (!T.getAgentSessions) return;
    T.getAgentSessions().then((sessions) => {
      const fresh = {};
      (sessions || []).forEach((s) => { if (s && s.agentType) fresh[s.agentType] = s; });
      Object.keys(agents).forEach((t) => { if (!fresh[t]) { delete agents[t]; if (activeType === t) activeType = null; } });
      Object.keys(fresh).forEach((t) => { agents[t] = fresh[t]; });
      renderPill(); renderTabs(); ensureWindow();
      if (expanded) renderHero(agents[pickActive()]);
    }).catch(() => {});
  }
  // ── Capture / Replace — optimize selected text in any app (folds in the popup) ──
  (function initCapture() {
    const btn = document.getElementById('icapBtn');
    const label = document.getElementById('icapLabel');
    const result = document.getElementById('icapResult');
    const outText = document.getElementById('icapText');
    const before = document.getElementById('icapBefore');
    const after = document.getElementById('icapAfter');
    const pct = document.getElementById('icapPct');
    const bReplace = document.getElementById('icapReplace');
    const bCopy = document.getElementById('icapCopy');
    const bUndo = document.getElementById('icapUndo');
    if (!btn) return;
    let original = '', optimized = '', busy = false;
    const reset = () => { busy = false; label.textContent = '优化选中文本 · Capture'; };

    async function doCapture() {
      if (busy) return;
      busy = true;
      label.textContent = '读取选中… · Reading…';
      try { await T.captureNow(); } catch (_) { reset(); return; }
      // captured-text arrives asynchronously; fall back so the label never sticks.
      setTimeout(() => { if (busy) reset(); }, 4000);
    }

    T.on && T.on('captured-text', async (d) => {
      if (!d || !d.text) return;
      original = d.text;
      let r = null;
      try { r = await T.optimizeText(d.text); } catch (_) {}
      if (!r) { reset(); return; }
      optimized = r.optimized || d.text;
      const s = r.stats || {};
      before.textContent = (s.originalTokens || 0).toLocaleString();
      after.textContent = (s.optimizedTokens || 0).toLocaleString();
      const p = s.percentSaved || 0;
      pct.textContent = p > 0 ? '−' + p + '%' : '';
      outText.value = optimized;
      result.classList.remove('hidden');
      bReplace.disabled = false;
      bUndo.classList.add('hidden');
      reset();
      if (window.__islandResize) window.__islandResize();
    });

    btn.addEventListener('click', doCapture);
    bReplace.addEventListener('click', async () => {
      if (!optimized) return;
      try { await T.replaceInTarget(optimized); bUndo.classList.remove('hidden'); } catch (_) {}
    });
    bUndo.addEventListener('click', async () => {
      if (!original) return;
      try { await T.replaceInTarget(original); bUndo.classList.add('hidden'); } catch (_) {}
    });
    bCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(optimized || outText.value);
        bCopy.textContent = 'Copied'; setTimeout(() => (bCopy.textContent = 'Copy'), 1200); } catch (_) {}
    });
  })();

  reseedSessions();
  setInterval(reseedSessions, 4000);
})();

/* ══════════════════════════════════════════════════════════════════════════
   Island alert layer.
   Notifications morph the pill into a banner instead of opening a separate
   toast window (Rust routes to whichever surface is on screen). Alerts queue,
   so a burst plays one at a time rather than fighting over the window.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (!document.body.classList.contains('island-mode')) return;
  const T = window.terse;
  if (!T || !T.on) return;

  const el = {
    root:   document.getElementById('islandRoot'),
    pill:   document.getElementById('islandPill'),
    alert:  document.getElementById('islandAlert'),
    ic:     document.getElementById('islandAlertIcon'),
    kind:   document.getElementById('islandAlertKind'),
    count:  document.getElementById('islandAlertCount'),
    title:  document.getElementById('islandAlertTitle'),
    body:   document.getElementById('islandAlertBody'),
    go:     document.getElementById('islandAlertGo'),
    snooze: document.getElementById('islandAlertSnooze'),
    close:  document.getElementById('islandAlertClose'),
    life:   document.getElementById('islandAlertLife'),
  };
  if (!el.alert) return;

  const W = 400;          // alert banner width (pill is 360, monitor card 440)
  const LIFE_MS = 8000;
  const MAX_QUEUE = 6;

  const STR = {
    en: {
      k_doctor:'Doctor', k_cleanup:'Cleanup', k_budget:'Budget', k_cache:'Cache', k_routing:'Routing',
      k_context:'Context', k_agent:'Agent', k_summary:'Summary', k_digest:'Digest',
      a_doctor:'Open Doctor', a_cleanup:'Clean up', a_stats:'Open Stats', a_budget:'Open Budget',
      a_alerts:'Open Alerts', a_team:'Open Team', a_open:'Open', snooze:'Snooze 1h', more:'+{n} more',
    },
    'zh-Hans': {
      k_doctor:'体检', k_cleanup:'清理', k_budget:'预算', k_cache:'缓存', k_routing:'模型路由',
      k_context:'上下文', k_agent:'智能体', k_summary:'会话总结', k_digest:'周报',
      a_doctor:'打开体检', a_cleanup:'立即清理', a_stats:'查看统计', a_budget:'查看预算',
      a_alerts:'查看提醒', a_team:'打开团队', a_open:'打开', snooze:'静音 1 小时', more:'还有 {n} 条',
    },
    'zh-Hant': {
      k_doctor:'體檢', k_cleanup:'清理', k_budget:'預算', k_cache:'快取', k_routing:'模型路由',
      k_context:'上下文', k_agent:'智能體', k_summary:'工作階段總結', k_digest:'週報',
      a_doctor:'開啟體檢', a_cleanup:'立即清理', a_stats:'檢視統計', a_budget:'檢視預算',
      a_alerts:'檢視提醒', a_team:'開啟團隊', a_open:'開啟', snooze:'靜音 1 小時', more:'還有 {n} 則',
    },
  };
  const lang = () => { try { return (window.i18n && window.i18n.getLang()) || 'en'; } catch { return 'en'; } };
  const L = (k, v) => {
    const d = STR[lang()] || STR.en;
    let s = d[k] || STR.en[k] || k;
    if (v) for (const p in v) s = s.replace('{' + p + '}', v[p]);
    return s;
  };

  const ICON = { doctor:'🩺', cleanup:'🧹', budget:'💰', cache:'⚡', routing:'🔀',
                 context:'🪟', agent:'🤖', summary:'📋', digest:'📨' };
  const ACT = { 'open-doctor':'a_doctor', 'open-cleanup':'a_cleanup', 'open-stats':'a_stats',
                'open-budget':'a_budget', 'open-alerts':'a_alerts', 'open-team':'a_team' };

  let queue = [];
  let active = null;
  let lifeTimer = null;
  let leaving = false;

  function clearLife() { if (lifeTimer) { clearTimeout(lifeTimer); lifeTimer = null; } }

  // Restore the pill and drain whatever queued up while this alert was on screen.
  function finish() {
    clearLife();
    if (!active) return;
    leaving = true;
    document.body.classList.add('ia-leaving');
    setTimeout(() => {
      document.body.classList.remove('alerting', 'ia-leaving');
      document.body.removeAttribute('data-sev');
      active = null; leaving = false;
      if (queue.length) {
        present(queue.shift());     // stays suppressed — another card is taking over
      } else {
        // Nothing left to click: give the floating boards back.
        if (window.__islandSuppressDash) window.__islandSuppressDash(false);
        if (T.islandSetExpanded) T.islandSetExpanded(false);
      }
    }, 300);
  }

  function present(a) {
    active = a;
    clearLife();
    // Clear the floating boards out of the way BEFORE the banner expands, so the
    // buttons never appear underneath a dashboard the user then has to fight.
    if (window.__islandSuppressDash) window.__islandSuppressDash(true);

    el.ic.textContent    = ICON[a.kind] || '🔔';
    el.kind.textContent  = L('k_' + a.kind);
    el.title.textContent = a.title || '';
    el.body.textContent  = a.body || '';
    el.body.style.display = a.body ? '' : 'none';
    el.count.textContent = queue.length ? L('more', { n: queue.length }) : '';

    const actKey = ACT[a.action];
    el.go.style.display = actKey ? '' : 'none';
    if (actKey) { el.go.textContent = L(actKey); el.go.dataset.act = a.action; }
    el.snooze.textContent = L('snooze');
    el.snooze.dataset.kind = a.kind;
    el.snooze.style.display = '';   // a preceding status morph may have hidden it

    document.body.setAttribute('data-sev', String(a.severity || 'low').toLowerCase());
    document.body.classList.add('alerting');

    // Size the window to the banner, then correct to the measured content height.
    // rAF never fires while the webview is hidden/occluded, which would strand the
    // banner at the 132px estimate — fall back to a timer in that case.
    if (T.islandAlertSize) {
      T.islandAlertSize(W, 132);
      const measure = () => {
        const h = Math.ceil(el.alert.scrollHeight) + 2;
        if (h > 60) T.islandAlertSize(W, h);
      };
      if (document.hidden) setTimeout(measure, 0);
      else requestAnimationFrame(measure);
    }

    // Restart the drain bar (re-trigger the animation by reflowing it).
    el.life.style.animation = 'none';
    void el.life.offsetWidth;
    el.life.style.animation = `iaDrain ${LIFE_MS}ms linear forwards`;
    lifeTimer = setTimeout(finish, LIFE_MS);
  }

  function enqueue(a) {
    if (!a || !a.title) return;
    if (active || leaving) {
      if (queue.length < MAX_QUEUE) {
        queue.push(a);
        if (active) el.count.textContent = L('more', { n: queue.length });
      }
      return;
    }
    // Knock the pill first so the morph reads as caused by the alert.
    el.pill.classList.add('ia-knock');
    setTimeout(() => el.pill.classList.remove('ia-knock'), 340);
    setTimeout(() => present(a), 140);
  }

  // Hovering holds the alert open (the CSS pauses the bar; clear the timer to match).
  el.alert.addEventListener('mouseenter', clearLife);
  el.alert.addEventListener('mouseleave', () => {
    if (active && !leaving && !lifeTimer) lifeTimer = setTimeout(finish, LIFE_MS / 2);
  });

  el.close.addEventListener('click', (e) => { e.stopPropagation(); finish(); });
  el.go.addEventListener('click', (e) => {
    e.stopPropagation();
    if (T.toastAction) T.toastAction(e.currentTarget.dataset.act);
    finish();
  });
  el.snooze.addEventListener('click', (e) => {
    e.stopPropagation();
    if (T.snoozeAlertKind) T.snoozeAlertKind(e.currentTarget.dataset.kind, 60);
    finish();
  });

  T.on('terse-toast', (payload) => enqueue(payload));

  // ── Agent approval prompts ────────────────────────────────────────────────
  // Rust watches Claude / Codex / Cursor (terminal AND app) for a blocked
  // permission prompt and emits it here. These differ from alerts in three ways:
  //   • N options, not one action — rendered as a row of buttons
  //   • no auto-dismiss: the agent is *blocked*, so the card stays until answered
  //   • cleared remotely — answering in the terminal fires terse-approval-cleared
  const APPROVAL_STR = {
    en:        { kind:'Needs you', deny:'Deny', always:'Always', wait:'waiting' },
    'zh-Hans': { kind:'待确认',    deny:'拒绝', always:'始终允许', wait:'等待中' },
    'zh-Hant': { kind:'待確認',    deny:'拒絕', always:'always',  wait:'等待中' },
  };
  const A = (k) => (APPROVAL_STR[lang()] || APPROVAL_STR.en)[k];
  const AGENT_ICON = { claude: '🤖', codex: '🧠', cursor: '🖱️' };

  function presentApproval(p) {
    active = { approval: p };
    clearLife();
    if (window.__islandSuppressDash) window.__islandSuppressDash(true);

    el.ic.textContent   = AGENT_ICON[p.agent] || '🔔';
    el.kind.textContent = A('kind');
    // "which window is asking" — the app + window title.
    el.count.textContent = [p.app, p.window].filter(Boolean).join(' · ').slice(0, 42);
    el.title.textContent = p.question || '';
    // "which step" — the command / diff being approved.
    el.body.textContent  = p.detail || '';
    el.body.style.display = p.detail ? '' : 'none';

    // Options replace the single action+snooze pair.
    el.go.style.display = 'none';
    el.snooze.style.display = 'none';
    let row = document.getElementById('islandApprovalOpts');
    if (!row) {
      row = document.createElement('div');
      row.id = 'islandApprovalOpts';
      row.className = 'ia-acts ia-opts';
      el.snooze.parentNode.appendChild(row);
    }
    row.innerHTML = '';
    row.style.display = '';
    (p.options || []).forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ia-btn' + (o.deny ? ' ghost' : '') + (o.sticky ? ' sticky' : '');
      b.textContent = (o.key ? o.key + ' · ' : '') + o.label;
      b.title = o.label;
      // We surface the prompt; the user answers in the agent's own window. Clicking
      // focuses that window rather than synthesising a keystroke — injecting keys
      // into someone's terminal is not something to do on a heuristic match.
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (T.focusApp) T.focusApp(p.app);
        finishApproval(p.id);
      });
      row.appendChild(b);
    });

    document.body.setAttribute('data-sev', 'high');
    document.body.classList.add('alerting', 'approving');

    if (T.islandAlertSize) {
      T.islandAlertSize(W, 150);
      const measure = () => {
        const h = Math.ceil(el.alert.scrollHeight) + 2;
        if (h > 60) T.islandAlertSize(W, h);
      };
      if (document.hidden) setTimeout(measure, 0); else requestAnimationFrame(measure);
    }
    // No life bar: the agent is blocked, so this must not time out.
    el.life.style.animation = 'none';
  }

  function finishApproval(id) {
    const row = document.getElementById('islandApprovalOpts');
    if (row) { row.innerHTML = ''; row.style.display = 'none'; }
    document.body.classList.remove('approving');
    el.snooze.style.display = '';
    if (active && active.approval && active.approval.id !== id) return; // newer one showing
    finish();
  }

  const approvalQueue = [];
  T.on('terse-approval', (p) => {
    if (!p || !p.question) return;
    // An approval outranks a passing alert — the agent is stuck.
    if (active && active.approval) {
      if (!approvalQueue.some(q => q.id === p.id)) approvalQueue.push(p);
      el.count.textContent = (active.approval.app || '') + ' · +' + approvalQueue.length;
      return;
    }
    if (active) { clearLife(); active = null; }   // drop a transient alert
    presentApproval(p);
  });
  T.on('terse-approval-cleared', (id) => {
    const i = approvalQueue.findIndex(q => q.id === id);
    if (i >= 0) approvalQueue.splice(i, 1);
    if (active && active.approval && active.approval.id === id) {
      const next = approvalQueue.shift();
      if (next) { finishApproval(id); setTimeout(() => presentApproval(next), 340); }
      else finishApproval(id);
    }
  });

  // ── Status morph ──────────────────────────────────────────────────────────
  // A lighter sibling of the alert: same expand-and-return motion, but no action
  // buttons and a short dwell. Used for moments worth *showing* rather than acting
  // on (an agent connecting), so the island visibly changes shape during normal use.
  const STATUS_MS = 2400;
  function showStatus(o) {
    if (active || leaving) return;          // never pre-empt a real alert
    active = { status: true };
    clearLife();
    if (window.__islandSuppressDash) window.__islandSuppressDash(true);

    el.ic.textContent    = o.icon || '•';
    el.kind.textContent  = o.kind || '';
    el.title.textContent = o.title || '';
    el.body.textContent  = o.body || '';
    el.body.style.display = o.body ? '' : 'none';
    el.count.textContent = '';
    el.go.style.display = 'none';
    el.snooze.style.display = 'none';

    document.body.setAttribute('data-sev', o.sev || 'low');
    document.body.classList.add('alerting');

    if (T.islandAlertSize) {
      T.islandAlertSize(W, 96);
      const measure = () => {
        const h = Math.ceil(el.alert.scrollHeight) + 2;
        if (h > 50) T.islandAlertSize(W, h);
      };
      if (document.hidden) setTimeout(measure, 0); else requestAnimationFrame(measure);
    }

    el.life.style.animation = 'none';
    void el.life.offsetWidth;
    el.life.style.animation = `iaDrain ${STATUS_MS}ms linear forwards`;
    lifeTimer = setTimeout(finish, STATUS_MS);
  }
  window.__islandStatus = showStatus;

  const S_STR = {
    en:        { connected: 'Connected', watching: 'Now watching this agent', gone: 'Disconnected' },
    'zh-Hans': { connected: '已连接',    watching: '开始监控这个智能体',      gone: '已断开' },
    'zh-Hant': { connected: '已連接',    watching: '開始監控這個智能體',      gone: '已斷開' },
  };
  const S = (k) => (S_STR[lang()] || S_STR.en)[k];

  T.on('agent-connected', (data) => {
    const s = data && data.session;
    if (!s || !s.agentType) return;
    showStatus({ icon: '🔗', kind: S('connected'), title: s.agentName || s.agentType, body: S('watching'), sev: 'low' });
  });
  T.on('agent-disconnected', (data) => {
    const s = data && data.session;
    if (!s || !s.agentType) return;
    showStatus({ icon: '🔌', kind: S('gone'), title: s.agentName || s.agentType, sev: 'low' });
  });
})();
