const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const T = window.terse;

let prevView = 'sessions';
const views = { sessions: $('#sessionsView'), pick: $('#pickOverlay'), manual: $('#manualResult'), settings: $('#settingsPanel') };
function show(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
  if (name !== 'settings') prevView = name;
}

// Init
(async () => {
  const s = await T.getSettings();
  $$('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.level === s.aggressiveness));
  $$('.setting-row input').forEach(cb => { if (s[cb.dataset.key] !== undefined) cb.checked = s[cb.dataset.key]; });
  show('sessions');
  refreshSessions();
})();

// ── Sessions ──
function refreshSessions() {
  Promise.all([T.getSessions(), T.getAgentSessions()]).then(([sessions, agentSessions]) => {
    const list = $('#sessionsList');
    const empty = $('#emptyState');
    list.innerHTML = '';

    const total = sessions.length + agentSessions.length;
    if (total === 0) {
      empty.classList.remove('hidden');
      $('#statusDot').className = 'status-dot';
      $('#trackingLabel').textContent = '';
      return;
    }
    empty.classList.add('hidden');
    $('#statusDot').className = 'status-dot live';
    $('#trackingLabel').textContent = total + ' session' + (total > 1 ? 's' : '');

    // Show agent sessions first
    agentSessions.forEach(a => {
      const item = document.createElement('div');
      item.className = 'session-item active';
      const fmtTok = n => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : n;
      item.innerHTML = `
        <div class="session-dot live"></div>
        <div class="session-info">
          <div class="session-name">${esc(a.agentIcon || '')} ${esc(a.agentName)}</div>
          <div class="session-meta">${a.turns} turns · ${fmtTok(a.totalInputTokens)} in · $${a.estimatedCost.toFixed(2)}</div>
        </div>
        <button class="session-remove agent-disconnect" data-type="${esc(a.agentType)}" title="Disconnect">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.2"/><line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      `;
      item.querySelector('.agent-disconnect').addEventListener('click', (e) => {
        e.stopPropagation();
        T.disconnectAgent(e.currentTarget.dataset.type);
        refreshSessions();
      });
      list.appendChild(item);
    });

    // Show manual sessions
    sessions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.active ? ' active' : '');
      item.innerHTML = `
        <div class="session-dot ${s.active ? 'live' : ''}"></div>
        <div class="session-info">
          <div class="session-name">${esc(s.name)}</div>
          <div class="session-meta">${esc(s.title || s.bundleId || '')}</div>
        </div>
        <button class="session-remove" data-id="${s.id}" title="Remove">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.2"/><line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      `;
      item.querySelector('.session-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        T.removeSession(s.id);
      });
      list.appendChild(item);
    });
  });
}

T.on('sessions-updated', () => refreshSessions());
T.on('agent-connected', () => refreshSessions());
T.on('agent-disconnected', () => refreshSessions());
T.on('agent-update', () => refreshSessions());

// ── Add connection ──
$('#btnAddSession').addEventListener('click', () => {
  show('pick');
  $('#statusDot').className = 'status-dot picking';
  T.enterPickMode();
});
$('#btnCancelPick').addEventListener('click', () => {
  show('sessions');
  $('#statusDot').className = 'status-dot';
});

T.on('pick-mode', a => {
  if (a) { show('pick'); $('#statusDot').className = 'status-dot picking'; }
});

T.on('session-added', () => {
  show('sessions');
  refreshSessions();
});

T.on('toast', d => toast(d.msg, d.error));

// ── Manual optimize ──
$('#btnManualOpt').addEventListener('click', async () => {
  const text = $('#manualInput').value.trim();
  if (text.length < 5) return;
  const r = await T.optimizeText(text);
  show('manual');
  $('#manStatBefore').textContent = r.stats.originalTokens.toLocaleString();
  $('#manStatAfter').textContent = r.stats.optimizedTokens.toLocaleString();
  const pct = r.stats.percentSaved;
  $('#manStatPct').textContent = pct > 0 ? '−' + pct + '%' : '';
  $('#manStatPct').className = 'stat-pct' + (pct > 0 ? ' good' : '');
  $('#manText').value = r.optimized;
  const tc = $('#manTechniques'); tc.innerHTML = '';
  r.stats.techniquesApplied.forEach(t => {
    const s = document.createElement('span'); s.className = 'technique-tag'; s.textContent = t; tc.appendChild(s);
  });
});
$('#manualInput').addEventListener('keydown', e => {
  if (e.metaKey && e.key === 'Enter') { e.preventDefault(); $('#btnManualOpt').click(); }
});

$('#btnBackToSessions').addEventListener('click', () => show('sessions'));
$('#btnManCopy').addEventListener('click', async () => {
  const text = $('#manText').value;
  if (!text) return;
  await T.applyToClipboard(text);
  toast('Copied!');
});

// ── Settings ──
$('#btnSettings').addEventListener('click', () => {
  $('#settingsPanel').classList.contains('hidden') ? show('settings') : show(prevView);
});
$('#btnCloseSettings').addEventListener('click', () => show(prevView));
$$('.toggle-btn').forEach(b => b.addEventListener('click', () => {
  $$('.toggle-btn').forEach(x => x.classList.remove('active')); b.classList.add('active');
  T.updateSettings({ aggressiveness: b.dataset.level });
}));
$$('.setting-row input').forEach(cb => cb.addEventListener('change', () => T.updateSettings({ [cb.dataset.key]: cb.checked })));

$('#btnClose').addEventListener('click', () => T.closeWindow());

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

let tt;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'toast error' : 'toast';
  clearTimeout(tt); tt = setTimeout(() => t.classList.add('hidden'), 2500);
}
