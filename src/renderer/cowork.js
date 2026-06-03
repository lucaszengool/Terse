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

  // ── Tabs ──
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const name = t.dataset.tab;
      $('#tab-live').style.display = name === 'live' ? 'block' : 'none';
      $('#tab-feed').style.display = name === 'feed' ? 'block' : 'none';
      $('#tab-inbox').style.display = name === 'inbox' ? 'block' : 'none';
      if (name === 'feed') renderFeed();
    }));

  // ── Footer controls ──
  $('#shareToggle').addEventListener('change', (e) => {
    try { T.setCoworkShareLogs(e.target.checked); } catch {}
  });
  $('#btnLeave').addEventListener('click', async () => {
    if (es) es.close();
    try { await T.clearCoworkToken(); } catch {}
    location.reload();
  });

  // ── Nav ──
  $('#btnBack').addEventListener('click', () => T.navigateBack());

  boot();
})();
