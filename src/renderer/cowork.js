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
