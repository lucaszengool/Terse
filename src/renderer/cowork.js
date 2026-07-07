/* Terse Cowork — Team window. Talks to /api/cloud cowork endpoints, live via SSE. */
(function () {
  const T = window.terse || window.T || {};
  const $ = (s) => document.querySelector(s);

  let API = 'https://www.terseai.org';
  let token = null, teamId = null, myEmail = null;
  let es = null;                         // EventSource
  const sessions = new Map();            // id → session
  const presence = new Map();            // email → presence
  let messages = [];                     // inbox/all messages
  let openLogSessionId = null;           // session currently shown in log viewer
  const logEntries = [];                 // entries for the open log session

  const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const short = (e) => (e ? e.split('@')[0] : 'unknown');

  function timeAgo(iso) {
    if (!iso) return '';
    const t = Date.parse(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  async function api(path, opts) {
    const r = await fetch(`${API}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-terse-team-token': token, ...(opts && opts.headers) },
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  }

  // ── Boot ──
  async function boot() {
    let cfg = {};
    try { cfg = await T.getCoworkConfig(); } catch {}
    API = cfg.apiBase || API;
    myEmail = cfg.userEmail || null;

    if (!cfg.connected || !cfg.teamToken || !cfg.teamId) {
      $('#joinView').style.display = 'flex';
      return;
    }
    token = cfg.teamToken; teamId = cfg.teamId;
    $('#shareToggle').checked = cfg.shareLogs !== false;
    $('#statsToggle').checked = cfg.shareStats !== false;
    if (cfg.teamName) { const p = $('#teamPill'); p.textContent = cfg.teamName; p.style.display = ''; }
    $('#mainView').style.display = 'block';

    await Promise.all([loadSessions(), loadFeed(), loadInbox()]);
    connectStream();
  }

  // ── Join flow ──
  $('#btnJoin').addEventListener('click', async () => {
    const t = $('#tokenInput').value.trim();
    if (!t) return;
    $('#btnJoin').disabled = true; $('#joinErr').textContent = '';
    try {
      await T.setCoworkToken(t);
      location.reload();
    } catch (e) {
      $('#joinErr').textContent = (e && e.toString()) || 'Could not join — check the token.';
      $('#btnJoin').disabled = false;
    }
  });
  $('#tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
  $('#btnCreate').addEventListener('click', () => { try { T.openCloudTeams(); } catch {} });

  // ── Loaders ──
  async function loadSessions() {
    try {
      const d = await api(`/api/cloud/teams/${teamId}/agent-sessions`);
      sessions.clear();
      (d.sessions || []).forEach((s) => sessions.set(s.id, s));
      presence.clear();
      (d.presence || []).forEach((p) => presence.set(p.user_email, p));
      renderPresence(); renderSessions();
    } catch {}
  }
  async function loadFeed() {
    try {
      const d = await api(`/api/cloud/teams/${teamId}/feed`);
      renderFeed(d.log || []);
      messages = d.messages || [];
      renderInbox();
    } catch {}
  }
  async function loadInbox() {
    if (!myEmail) return;
    try {
      const d = await api(`/api/cloud/teams/${teamId}/inbox?email=${encodeURIComponent(myEmail)}`);
      mergeMessages(d.inbox || []);
      renderInbox();
    } catch {}
  }

  // ── SSE stream ──
  function connectStream() {
    if (es) es.close();
    es = new EventSource(`${API}/api/cloud/teams/${teamId}/stream?token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'snapshot') {
        sessions.clear(); (m.sessions || []).forEach((s) => sessions.set(s.id, s));
        presence.clear(); (m.presence || []).forEach((p) => presence.set(p.user_email, p));
        renderPresence(); renderSessions();
      } else if (m.type === 'session') {
        if (m.session.status === 'ended') sessions.delete(m.session.id);
        else sessions.set(m.session.id, m.session);
        renderSessions();
      } else if (m.type === 'log') {
        if (m.entry.session_id === openLogSessionId) { logEntries.push(m.entry); renderLog(); }
        prependFeed(m.entry);
      } else if (m.type === 'presence') {
        presence.set(m.presence.user_email, { ...presence.get(m.presence.user_email), ...m.presence });
        renderPresence();
      } else if (m.type === 'message') {
        mergeMessages([m.message]); renderInbox();
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }

  // ── Render: presence ──
  function renderPresence() {
    const el = $('#presence');
    const people = [...presence.values()].filter((p) => p.status !== 'offline');
    if (!people.length) { el.innerHTML = '<span class="muted">No one online</span>'; return; }
    el.innerHTML = people.map((p) =>
      `<span class="person"><span class="dot ${esc(p.status)}"></span>${esc(short(p.user_email))}</span>`).join('');
  }

  // ── Render: sessions ──
  function renderSessions() {
    const el = $('#sessions');
    const list = [...sessions.values()].sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''));
    if (!list.length) {
      el.innerHTML = '<div class="empty">No active sessions yet. When a teammate\'s agent starts working, it shows up here.</div>';
      return;
    }
    el.innerHTML = list.map((s) => {
      const fill = s.context_window ? Math.min(100, Math.round((s.context_used / s.context_window) * 100)) : 0;
      const mine = s.user_email === myEmail;
      return `<div class="card" data-id="${esc(s.id)}">
        <div class="row">
          <span class="dot ${s.status === 'active' ? 'online' : s.status === 'idle' ? 'away' : 'ended'}"></span>
          <span class="who">${esc(short(s.user_email))}${mine ? ' (you)' : ''}</span>
          <span class="agent">${esc(s.agent_name || s.agent_type)}</span>
        </div>
        <div class="task">${esc(s.task || '…')}</div>
        ${s.context_window ? `<div class="bar"><span style="width:${fill}%"></span></div>` : ''}
        <div class="meta">
          ${s.project ? `<span>📁 ${esc(s.project)}</span>` : ''}
          ${s.model ? `<span>${esc(s.model)}</span>` : ''}
          ${s.context_window ? `<span>${fill}% ctx</span>` : ''}
          <span>${(s.tokens_in || 0).toLocaleString()} in</span>
          <span>${s.tool_calls || 0} tools</span>
          <span>${timeAgo(s.last_seen_at)}</span>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('.card').forEach((c) =>
      c.addEventListener('click', () => openLog(c.dataset.id)));
  }

  // ── Render: feed ──
  const feedItems = [];
  function renderFeed(initial) {
    if (initial) { feedItems.length = 0; initial.forEach((e) => feedItems.push(e)); }
    const el = $('#feed');
    if (!feedItems.length) { el.innerHTML = '<div class="empty">No recent activity.</div>'; return; }
    el.innerHTML = feedItems.slice(0, 80).map((e) =>
      `<div class="feed-item"><div class="src">${esc(short(e.user_email))} · ${esc(e.agent_name || e.agent_type || 'agent')} · ${esc(e.kind || '')} ${e.tool ? '· ' + esc(e.tool) : ''} · ${timeAgo(e.occurred_at)}</div>${esc((e.text || '').slice(0, 200))}</div>`).join('');
  }
  function prependFeed(entry) {
    // entry from stream lacks denormalized author fields; enrich from its session.
    const s = sessions.get(entry.session_id);
    feedItems.unshift({ ...entry, user_email: s && s.user_email, agent_name: s && s.agent_name });
    if (feedItems.length > 200) feedItems.length = 200;
    if ($('#tab-feed').style.display !== 'none') renderFeed();
  }

  // ── Render: inbox ──
  function mergeMessages(arr) {
    const byId = new Map(messages.map((m) => [m.id, m]));
    arr.forEach((m) => byId.set(m.id, m));
    messages = [...byId.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
  function unresolvedForMe() {
    return messages.filter((m) => m.status !== 'done' &&
      (!m.to_email || m.to_email === myEmail) && m.from_email !== myEmail);
  }
  function renderInbox() {
    const el = $('#inbox');
    const visible = messages.filter((m) => m.status !== 'done');
    const badge = $('#inboxBadge');
    const n = unresolvedForMe().length;
    badge.style.display = n ? '' : 'none'; badge.textContent = n;
    if (!visible.length) { el.innerHTML = '<div class="empty">No messages. Mentions, handoffs and asks land here.</div>'; return; }
    el.innerHTML = visible.slice(0, 60).map((m) => {
      const actionable = m.kind === 'handoff' || m.kind === 'ask' || m.kind === 'mention';
      return `<div class="msg ${esc(m.kind)}">
        <div><span class="from">${esc(short(m.from_email))}</span>
          <span class="muted">→ ${m.to_email ? esc(short(m.to_email)) : 'everyone'} · ${esc(m.kind)} · ${timeAgo(m.created_at)}</span></div>
        <div>${esc(m.body)}</div>
        ${actionable ? `<div class="actions"><button class="mini-btn" data-done="${esc(m.id)}">Mark done</button></div>` : ''}
      </div>`;
    }).join('');
    el.querySelectorAll('[data-done]').forEach((b) =>
      b.addEventListener('click', () => resolveMsg(b.dataset.done)));
  }
  async function resolveMsg(id) {
    try { await api(`/api/cloud/teams/${teamId}/messages/${id}/resolve`, { method: 'POST', body: JSON.stringify({ status: 'done' }) }); } catch {}
  }

  // ── Compose ──
  $('#btnSend').addEventListener('click', async () => {
    const body = $('#msgBody').value.trim();
    if (!body) return;
    const payload = {
      from_email: myEmail,
      to_email: $('#msgTo').value.trim() || null,
      kind: $('#msgKind').value,
      body,
    };
    $('#btnSend').disabled = true;
    try {
      await api(`/api/cloud/teams/${teamId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
      $('#msgBody').value = '';
    } catch (e) { /* ignore */ }
    $('#btnSend').disabled = false;
  });

  // ── Log viewer ──
  async function openLog(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    openLogSessionId = sid; logEntries.length = 0;
    $('#mainView').style.display = 'none';
    $('#logView').style.display = 'block';
    $('#logTitle').textContent = `${short(s.user_email)} · ${s.agent_name || s.agent_type}`;
    $('#logBody').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const d = await api(`/api/cloud/teams/${teamId}/sessions/${sid}/log?since=0`);
      (d.entries || []).forEach((e) => logEntries.push(e));
    } catch {}
    renderLog();
  }
  function renderLog() {
    const el = $('#logBody');
    if (!logEntries.length) { el.innerHTML = '<div class="empty">No log entries yet.</div>'; return; }
    el.innerHTML = logEntries.map((e) =>
      `<div class="logline"><span class="lr ${esc(e.role)}">${esc(e.role)}</span>${e.tool ? `<span class="tool-tag">${esc(e.tool)}</span>` : ''}<div class="logtext">${esc(e.text || '')}</div></div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  $('#logBack').addEventListener('click', () => {
    openLogSessionId = null;
    $('#logView').style.display = 'none';
    $('#mainView').style.display = 'block';
  });

  // ── Local stats: pricing + cost helpers (same keys as stats.html) ─────────
  const DEFAULT_RATES = {
    agent:   { in: 3.0, out: 15.0 },
    browser: { in: 2.5, out: 10.0 },
    editor:  { in: 3.0, out: 15.0 },
    manual:  { in: 3.0, out: 15.0 },
  };
  const SOURCE_META = {
    browser: { name: 'Browser', color: '#4A9EFF' },
    agent:   { name: 'Agent',   color: '#4CAF50' },
    editor:  { name: 'Editor',  color: '#9C27B0' },
    manual:  { name: 'Manual',  color: '#FF9800' },
  };
  function loadRates() {
    try { const r = JSON.parse(localStorage.getItem('terse-rates') || 'null'); if (r && r.agent) return r; } catch {}
    return JSON.parse(JSON.stringify(DEFAULT_RATES));
  }
  let RATES = loadRates();
  const CACHE_READ_MULT = 0.1, CACHE_WRITE_MULT = 1.25;
  function costOf(src, s) {
    s = s || {};
    const r = RATES[src] || DEFAULT_RATES[src] || { in: 3, out: 15 };
    const cr = s.cacheReadTokens || 0, cw = s.cacheCreationTokens || 0;
    const fresh = Math.max(0, (s.tokensIn || 0) - cr - cw);
    return (fresh * r.in + cr * r.in * CACHE_READ_MULT + cw * r.in * CACHE_WRITE_MULT) / 1e6
      + (s.tokensOut || 0) / 1e6 * r.out;
  }
  function savedUsd(src, tokensSaved) {
    return (tokensSaved || 0) / 1e6 * (RATES[src] || DEFAULT_RATES[src] || { in: 3 }).in;
  }
  function fmtUSD(n) {
    if (!n) return '$0';
    if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
    if (n >= 100) return '$' + n.toFixed(0);
    if (n >= 1) return '$' + n.toFixed(2);
    return '$' + n.toFixed(3);
  }
  function shortModel(m) {
    if (!m || m === 'unknown') return 'Unknown';
    return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  }

  // ── Local budget helpers (shared localStorage with stats.html) ───────────
  function loadBudget() {
    const v = parseFloat(localStorage.getItem('terse-budget-usd') || '');
    return isFinite(v) && v > 0 ? v : null;
  }
  function saveBudgetLocal(v) {
    if (isFinite(v) && v > 0) localStorage.setItem('terse-budget-usd', String(v));
    else localStorage.removeItem('terse-budget-usd');
  }
  function daysInMonth() {
    const n = new Date(); return new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
  }

  // ── Slack helpers (same keys as stats.html) ──────────────────────────────
  const LVL_RANK = { ok: 0, warn: 1, near: 2, over: 3 };
  function slackWebhook() { return (localStorage.getItem('terse-slack-webhook') || '').trim(); }
  function slackEnabled() { return localStorage.getItem('terse-slack-enabled') === '1' && !!slackWebhook(); }
  function refreshTeamSlackUI() {
    const hook = slackWebhook(), en = slackEnabled();
    const inp = $('#teamSlackWebhook');
    if (document.activeElement !== inp) inp.value = hook;
    $('#teamSlackEnabled').checked = en;
    const badge = $('#teamSlackBadge');
    badge.textContent = en ? 'On' : (hook ? 'Paused' : 'Off');
    badge.className = 'slack-badge ' + (en ? 'on' : 'off');
  }
  function maybeTeamSlackAlert(lvl, spent, budget, forecast, pct) {
    if (!slackEnabled() || LVL_RANK[lvl] < 1) return;
    const ym = new Date().toISOString().slice(0, 7);
    let last; try { last = JSON.parse(localStorage.getItem('terse-slack-last') || '{}'); } catch { last = {}; }
    const lastRank = last.month === ym ? (last.rank || 0) : 0;
    if (LVL_RANK[lvl] <= lastRank) return;
    const emoji = lvl === 'over' ? '🚨' : '⚠️';
    const text = emoji + ' *Terse budget alert* — ' + fmtUSD(spent) + ' of ' + fmtUSD(budget) +
      ' used this month (' + pct + '%). Forecast ' + fmtUSD(forecast) + ' by month-end.';
    T.sendSlackAlert(slackWebhook(), text)
      .then(() => { localStorage.setItem('terse-slack-last', JSON.stringify({ month: ym, rank: LVL_RANK[lvl] })); })
      .catch(() => {});
  }

  // ── Render local stats overlay ───────────────────────────────────────────
  async function renderLocalStats() {
    const period = statsPeriod === 'day' ? 'day' : statsPeriod === 'month' ? 'month' : 'week';
    let localData, attrData;
    try { localData = await T.getStats(period); } catch {}
    try { attrData = await T.getAttribution(period); } catch {}

    // ── Budget + cost ──
    const budget = loadBudget();
    const inp = $('#teamBudgetInput');
    if (document.activeElement !== inp) inp.value = budget || '';

    const hero = $('#teamBudgetHero');
    if (localData && budget) {
      hero.style.display = 'block';
      const bySource = localData.bySource || {};
      let totalCost = 0;
      for (const [k, s] of Object.entries(bySource)) totalCost += costOf(k, s);
      const pct = Math.min(999, Math.round((totalCost / budget) * 100));
      const dom = new Date().getDate(), dim = daysInMonth();
      const daily = dom > 0 ? totalCost / dom : totalCost;
      const forecast = daily * dim;
      const daysLeft = Math.max(0, dim - dom);

      $('#tbSpent').textContent = fmtUSD(totalCost);
      $('#tbBudget').textContent = fmtUSD(budget);
      $('#tbPct').textContent = pct + '%';
      $('#tbDaily').textContent = fmtUSD(daily);
      $('#tbForecast').textContent = fmtUSD(forecast);
      $('#tbDaysLeft').textContent = daysLeft;

      const fill = $('#tbFill');
      fill.style.width = Math.min(100, pct) + '%';
      let lvl = pct >= 100 ? 'over' : pct >= 90 ? 'near' : pct >= 75 ? 'warn' : 'ok';
      fill.className = 'burn-fill burn-' + lvl;
      const alert = $('#tbAlert');
      alert.className = 'budget-alert-sm alert-' + lvl;
      const fOver = forecast > budget;
      const icons = { ok:'✓', warn:'⚠', near:'⚠', over:'✕' };
      $('#tbAlertIcon').textContent = icons[lvl];
      const msgs = {
        over: `Over budget — ${fmtUSD(totalCost - budget)} above the ${fmtUSD(budget)} cap.`,
        near: `${pct}% used. ${fOver ? 'Forecast ' + fmtUSD(forecast) + ' will exceed cap.' : 'Slow down to stay under.'}`,
        warn: `75% used. ${fOver ? 'On pace for ' + fmtUSD(forecast) + ' — over budget.' : 'Tracking ' + fmtUSD(forecast) + '.'}`,
        ok:   fOver ? 'Pace projects ' + fmtUSD(forecast) + ' — watch it.' : 'On track. Projected ' + fmtUSD(forecast) + '.',
      };
      $('#tbAlertText').textContent = msgs[lvl];
      maybeTeamSlackAlert(lvl, totalCost, budget, forecast, pct);
    } else {
      hero.style.display = 'none';
    }

    // ── Cost by source ──
    if (localData) {
      const bySource = localData.bySource || {};
      const rows = Object.entries(SOURCE_META)
        .map(([k, m]) => ({ k, m, c: costOf(k, bySource[k] || {}) }))
        .filter(r => r.c > 0).sort((a, b) => b.c - a.c);
      const costSec = $('#localCostSection');
      const wrap = $('#teamCostSrc');
      wrap.innerHTML = '';
      if (rows.length) {
        costSec.style.display = 'block';
        const max = Math.max(...rows.map(r => r.c), 0.0001);
        rows.forEach(r => {
          const el = document.createElement('div');
          el.className = 'cost-src-row';
          el.innerHTML =
            '<div class="top"><span class="nm">' + esc(r.m.name) + '</span><span class="v">' + fmtUSD(r.c) + '</span></div>' +
            '<div class="pct-bar"><div class="pct-bar-fill" style="width:' + Math.round(r.c / max * 100) + '%;background:' + r.m.color + '"></div></div>';
          wrap.appendChild(el);
        });
      } else { costSec.style.display = 'none'; }
    }

    // ── Attribution: by model ──
    const mSec = $('#localModelSection'), mWrap = $('#teamAttrModels');
    mWrap.innerHTML = '';
    const models = (attrData || {}).byModel || [];
    if (models.length) {
      mSec.style.display = 'block';
      const max = Math.max(...models.map(m => m.costUsd || 0), 0.0001);
      models.forEach(m => {
        const el = document.createElement('div');
        el.className = 'attr-item';
        el.innerHTML =
          '<span class="nm">' + esc(shortModel(m.name)) + '</span>' +
          '<span class="ct">' + fmtUSD(m.costUsd || 0) + ' <small>· ' + kfmt((m.tokensIn||0)+(m.tokensOut||0)) + '</small></span>';
        mWrap.appendChild(el);
      });
    } else { mSec.style.display = 'none'; }

    // ── Attribution: MCP servers ──
    const mcpSec = $('#localMcpSection'), mcpWrap = $('#teamAttrMcp');
    mcpWrap.innerHTML = '';
    const mcps = (attrData || {}).byMcpServer || [];
    if (mcps.length) {
      mcpSec.style.display = 'block';
      mcps.forEach(s => {
        const el = document.createElement('div');
        el.className = 'attr-item';
        el.innerHTML = '<span class="nm">' + esc(s.name) + '</span><span class="ct">' + kfmt(s.toolCalls || 0) + ' <small>calls</small></span>';
        mcpWrap.appendChild(el);
      });
    } else { mcpSec.style.display = 'none'; }

    // ── Attribution: top tools ──
    const tSec = $('#localToolSection'), tWrap = $('#teamAttrTools');
    tWrap.innerHTML = '';
    const tools = (attrData || {}).byTool || [];
    if (tools.length) {
      tSec.style.display = 'block';
      tools.forEach(t => {
        const el = document.createElement('div');
        el.className = 'attr-item';
        el.innerHTML = '<span class="nm">' + esc(t.name) + '</span><span class="ct">' + kfmt(t.count || 0) + ' <small>calls</small></span>';
        tWrap.appendChild(el);
      });
    } else { tSec.style.display = 'none'; }

    refreshTeamSlackUI();
  }

  // ── CSV export (local) ───────────────────────────────────────────────────
  async function exportTeamCsv() {
    let data; try { data = await T.getStats(statsPeriod); } catch { return; }
    const lines = ['Terse team export — period: ' + statsPeriod, ''];
    lines.push(['date','tokens_in','tokens_out','tokens_saved','tool_calls','est_cost_usd'].join(','));
    for (const d of (data.byDay || [])) {
      const c = (d.tokensIn||0)/1e6*DEFAULT_RATES.agent.in + (d.tokensOut||0)/1e6*DEFAULT_RATES.agent.out;
      lines.push([d.date, d.tokensIn||0, d.tokensOut||0, d.tokensSaved||0, d.toolCalls||0, c.toFixed(4)].join(','));
    }
    lines.push('');
    lines.push(['source','tokens_in','tokens_out','tokens_saved','est_cost_usd','est_saved_usd'].join(','));
    for (const [k, s] of Object.entries(data.bySource || {}))
      lines.push([k, s.tokensIn||0, s.tokensOut||0, s.tokensSaved||0,
        costOf(k, s).toFixed(4), savedUsd(k, s.tokensSaved).toFixed(4)].join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'terse-team-usage-' + statsPeriod + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── Stats ──
  let statsPeriod = 'week';
  let statsLoaded = false;
  const kfmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  };
  function bars(title, rows, labelKey, valKey, labelFmt) {
    rows = (rows || []).filter((r) => (Number(r[valKey]) || 0) > 0).slice(0, 6);
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => Number(r[valKey]) || 0)) || 1;
    const body = rows.map((r) => {
      const v = Number(r[valKey]) || 0;
      const w = Math.max(3, Math.round((v / max) * 100));
      const label = labelFmt ? labelFmt(r[labelKey]) : (r[labelKey] || '—');
      return `<div class="barrow"><span class="bl" title="${esc(label)}">${esc(label)}</span>` +
        `<span class="bt"><span class="bf" style="width:${w}%"></span></span>` +
        `<span class="bv">${kfmt(v)}</span></div>`;
    }).join('');
    return `<div class="cls-group"><div class="cls-title">${esc(title)}</div>${body}</div>`;
  }
  function sparkline(daily) {
    daily = daily || [];
    if (daily.length < 2) return '';
    const vals = daily.map((x) => Number(x.tokens_saved) || 0);
    const max = Math.max(...vals) || 1;
    const W = 280, H = 40, n = vals.length;
    const pts = vals.map((v, i) =>
      `${((i / (n - 1)) * W).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`).join(' ');
    return `<div class="section-title">Daily tokens saved</div>` +
      `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<polyline points="${pts}" fill="none" stroke="var(--btn)" stroke-width="2" ` +
      `stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  async function loadStats() {
    const el = $('#statsBody');
    statsLoaded = true;
    // Local stats always load (independent of cloud).
    renderLocalStats();
    try {
      const q = `period=${statsPeriod}` + (myEmail ? `&email=${encodeURIComponent(myEmail)}` : '');
      const d = await api(`/api/cloud/teams/${teamId}/stats?${q}`);
      renderStats(d);
    } catch (e) {
      el.innerHTML = '<div class="empty">Couldn\'t load team stats.</div>';
    }
  }
  function renderStats(d) {
    const s = d.summary || {};
    const inTok = s.total_tokens_in || 0, saved = s.total_tokens_saved || 0;
    const rate = inTok > 0 ? ((saved / inTok) * 100).toFixed(1) : '0.0';
    const kpis = [
      ['Tokens saved', kfmt(saved)],
      ['Saved', '$' + (s.dollars_saved != null ? s.dollars_saved : 0)],
      ['Save rate', rate + '%'],
      ['Developers', s.active_developers || 0],
      ['Events', (s.total_events || 0).toLocaleString()],
      ['Tokens in', kfmt(inTok)],
    ];
    const roleNote = d.role === 'member'
      ? '<div class="role-note">Showing your own usage. Team owners see everyone’s.</div>' : '';
    const cls =
      bars('By coding agent', d.by_agent, 'agent_type', 'tokens_in') +
      bars('By tool / device', d.by_tool, 'tool', 'tokens_in') +
      bars('By model', d.by_model, 'model', 'tokens_in') +
      bars('By optimization mode', d.by_mode, 'mode', 'tokens_in');
    const devBars = bars('Tokens saved', d.by_developer, 'user_email', 'tokens_saved', short);
    $('#statsBody').innerHTML =
      roleNote +
      `<div class="statgrid">${kpis.map((k) =>
        `<div class="statcard"><div class="sv">${esc(k[1])}</div><div class="sl">${esc(k[0])}</div></div>`).join('')}</div>` +
      '<div class="section-title">Classification</div>' +
      (cls || '<div class="empty">No usage yet. Turn on “Share usage stats”, then optimize or run an agent.</div>') +
      '<div class="section-title">By developer</div>' +
      (devBars || '<div class="empty">No savings recorded yet.</div>') +
      sparkline(d.daily);
  }
  document.querySelectorAll('.period-btn').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      statsPeriod = b.dataset.p;
      loadStats();
    }));

  // ── Tabs ──
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const name = t.dataset.tab;
      $('#tab-live').style.display = name === 'live' ? 'block' : 'none';
      $('#tab-feed').style.display = name === 'feed' ? 'block' : 'none';
      $('#tab-stats').style.display = name === 'stats' ? 'block' : 'none';
      $('#tab-inbox').style.display = name === 'inbox' ? 'block' : 'none';
      if (name === 'feed') renderFeed();
      if (name === 'stats') loadStats();
    }));

  // ── Local stats controls ─────────────────────────────────────────────────
  $('#btnSetTeamBudget').addEventListener('click', () => {
    const v = parseFloat($('#teamBudgetInput').value);
    saveBudgetLocal(v);
    renderLocalStats();
  });
  $('#teamBudgetInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnSetTeamBudget').click();
  });
  $('#btnExportTeamCsv').addEventListener('click', exportTeamCsv);

  // Slack buttons
  $('#tbtnOpenSlack').addEventListener('click', () => { try { T.openUrl('https://app.slack.com/client'); } catch {} });
  $('#tbtnSlackHook').addEventListener('click', () => { try { T.openUrl('https://api.slack.com/messaging/webhooks'); } catch {} });
  $('#tbtnSaveSlack').addEventListener('click', () => {
    const v = $('#teamSlackWebhook').value.trim();
    if (v && !v.startsWith('https://hooks.slack.com/')) return;
    if (v) localStorage.setItem('terse-slack-webhook', v); else localStorage.removeItem('terse-slack-webhook');
    if (!v) localStorage.setItem('terse-slack-enabled', '0');
    refreshTeamSlackUI();
  });
  $('#teamSlackEnabled').addEventListener('change', (e) => {
    if (e.target.checked && !slackWebhook()) { e.target.checked = false; return; }
    localStorage.setItem('terse-slack-enabled', e.target.checked ? '1' : '0');
    refreshTeamSlackUI();
  });
  $('#tbtnTestSlack').addEventListener('click', () => {
    const hook = $('#teamSlackWebhook').value.trim() || slackWebhook();
    if (!hook.startsWith('https://hooks.slack.com/')) return;
    try { T.sendSlackAlert(hook, '✅ Terse Team is connected — budget alerts will arrive here.').catch(() => {}); } catch {}
  });

  // ── Footer controls ──
  $('#shareToggle').addEventListener('change', (e) => {
    try { T.setCoworkShareLogs(e.target.checked); } catch {}
  });
  $('#statsToggle').addEventListener('change', (e) => {
    try { T.setCoworkShareStats(e.target.checked); } catch {}
  });
  $('#btnCloud').addEventListener('click', () => { try { T.openCloudTeams(); } catch {} });
  $('#btnLeave').addEventListener('click', async () => {
    if (es) es.close();
    try { await T.clearCoworkToken(); } catch {}
    location.reload();
  });

  // ── Nav ──
  $('#btnBack').addEventListener('click', () => T.navigateBack());

  boot();
})();
