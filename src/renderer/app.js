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
  updateLicenseBanner();
})();

// ── License ──
async function updateLicenseBanner() {
  if (!T.getLicense) return;
  try {
    const lic = await T.getLicense();
    const banner = $('#licenseBanner');
    if (!banner) return;
    banner.classList.remove('hidden');
    $('#licenseTier').textContent = lic.tier.charAt(0).toUpperCase() + lic.tier.slice(1);
    if (lic.remaining >= 0) {
      $('#licenseUsage').textContent = lic.remaining + '/' + lic.limits.optimizationsPerWeek + ' left this week';
      if (lic.remaining <= 10) banner.classList.add('limit-warning');
      else banner.classList.remove('limit-warning');
    } else {
      $('#licenseUsage').textContent = 'Unlimited';
      banner.classList.remove('limit-warning');
    }
    if (lic.tier !== 'free') {
      $('#btnUpgrade').textContent = 'Manage';
    }
  } catch {}
}
// Refresh license every 60s
setInterval(updateLicenseBanner, 60000);

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
$('#btnStats').addEventListener('click', () => T.navigateToStats());
$('#btnCloseSettings').addEventListener('click', () => show(prevView));
$$('.toggle-btn').forEach(b => b.addEventListener('click', () => {
  $$('.toggle-btn').forEach(x => x.classList.remove('active')); b.classList.add('active');
  T.updateSettings({ aggressiveness: b.dataset.level });
}));
$$('.setting-row input').forEach(cb => cb.addEventListener('change', () => T.updateSettings({ [cb.dataset.key]: cb.checked })));

$('#btnClose').addEventListener('click', () => T.closeWindow());

// Upgrade button — open in system browser
$('#btnUpgrade').addEventListener('click', () => {
  try {
    const { open } = window.__TAURI__.shell;
    open('https://www.terseai.org/#pricing');
  } catch { window.open('https://www.terseai.org/#pricing', '_blank'); }
});

// ── Auth ──
$('#btnSignIn').addEventListener('click', () => doAuth('signin'));
$('#btnSignUp').addEventListener('click', () => doAuth('signup'));
$('#btnSignOut').addEventListener('click', async () => {
  if (T.signOut) await T.signOut();
  updateAuthUI();
  updateLicenseBanner();
});

async function doAuth(action) {
  if (!T.openAuthInBrowser) return;
  const btn = action === 'signup' ? $('#btnSignUp') : $('#btnSignIn');
  btn.textContent = 'Opening browser...';
  btn.disabled = true;
  const result = await T.openAuthInBrowser(action);
  if (result) {
    updateAuthUI();
    updateLicenseBanner();
    // Verify license with backend
    if (T.verifyLicense && result.clerkUserId) {
      T.verifyLicense(result.clerkUserId).then(() => updateLicenseBanner());
    }
    toast('Signed in as ' + (result.email || result.firstName || 'user'));
  } else {
    toast('Sign-in cancelled or timed out', true);
  }
  btn.textContent = action === 'signup' ? 'Sign Up' : 'Sign In';
  btn.disabled = false;
}

async function updateAuthUI() {
  if (!T.getAuth) return;
  try {
    const auth = await T.getAuth();
    if (auth.signedIn) {
      $('#signedOutUI').classList.add('hidden');
      $('#signedInUI').classList.remove('hidden');
      $('#accountName').textContent = auth.firstName || 'User';
      $('#accountEmail').textContent = auth.email || '';
      if (auth.imageUrl) {
        $('#accountAvatar').src = auth.imageUrl;
        $('#accountAvatar').style.display = 'block';
      }
    } else {
      $('#signedOutUI').classList.remove('hidden');
      $('#signedInUI').classList.add('hidden');
    }
  } catch {}
}

// Load auth state on startup
updateAuthUI().then(() => {
  // Auto-verify license on launch if signed in
  T.getAuth && T.getAuth().then(auth => {
    if (auth.signedIn && auth.clerkUserId && T.verifyLicense) {
      T.verifyLicense(auth.clerkUserId).then(() => updateLicenseBanner());
    }
  });
});

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

let tt;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'toast error' : 'toast';
  clearTimeout(tt); tt = setTimeout(() => t.classList.add('hidden'), 2500);
}
