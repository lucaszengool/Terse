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
  checkPaywall();
})();

// ── License ──
async function updateLicenseBanner() {
  if (!T.getLicense) return;
  try {
    const lic = await T.getLicense();
    const banner = $('#licenseBanner');
    if (!banner) return;
    banner.classList.remove('hidden');
    banner.classList.remove('limit-warning');

    const tier = (lic.tier || '').toLowerCase();
    const status = (lic.status || '').toLowerCase();
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    const noActivePlan = !tier || tier === 'expired' || tier === 'free' || status === 'cancelled' || status === 'none';

    if (noActivePlan) {
      // No active subscription — must start a trial
      $('#licenseTier').textContent = 'No Plan';
      $('#licenseUsage').textContent = 'Start a free trial to use Terse';
      banner.classList.add('limit-warning');
      $('#btnUpgrade').textContent = 'Start Free Trial';
      return;
    }

    if (status === 'trialing') {
      // Show trial info with days remaining
      const trialEnd = lic.trialEnd ? new Date(lic.trialEnd) : null;
      const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd - Date.now()) / 86400000)) : '?';
      $('#licenseTier').textContent = tierLabel + ' (Trial)';
      $('#licenseUsage').textContent = daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' left in trial';
      if (daysLeft <= 3) banner.classList.add('limit-warning');
      $('#btnUpgrade').textContent = 'Manage';
      return;
    }

    // Active paid subscription
    $('#licenseTier').textContent = tierLabel;
    if (lic.limits?.optimizationsPerWeek > 0 && lic.remaining >= 0) {
      $('#licenseUsage').textContent = lic.remaining + '/' + lic.limits.optimizationsPerWeek + ' left this week';
      if (lic.remaining <= 10) banner.classList.add('limit-warning');
    } else {
      $('#licenseUsage').textContent = 'Unlimited';
    }
    $('#btnUpgrade').textContent = 'Manage';
  } catch {}
}
// ── Paywall Gate — blocks app until user starts a free trial ──
async function checkPaywall() {
  if (!T.getLicense || !T.getAuth) return;
  try {
    const auth = await T.getAuth();
    if (!auth.signedIn) return; // auth gate handles this
    const lic = await T.getLicense();
    const gate = $('#paywallGate');
    if (!gate) return;
    const tier = (lic.tier || '').toLowerCase();
    const status = (lic.status || '').toLowerCase();
    const noActivePlan = !tier || tier === 'expired' || tier === 'free' || status === 'cancelled' || status === 'none';
    if (noActivePlan) {
      gate.classList.remove('hidden');
      gate.style.display = 'flex';
    } else {
      gate.classList.add('hidden');
      gate.style.display = 'none';
    }
  } catch {}
}

async function startTrialCheckout(tier) {
  const auth = await T.getAuth();
  if (!auth.signedIn || !auth.clerkUserId) return;
  const API_BASE = 'https://www.terseai.org';
  try {
    const res = await fetch(`${API_BASE}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, clerkUserId: auth.clerkUserId, clerkUserEmail: auth.email }),
    });
    const data = await res.json();
    if (data.url) {
      try { const { open } = window.__TAURI__.shell; open(data.url); }
      catch { window.open(data.url, '_blank'); }
    } else {
      toast('Error: ' + (data.error || 'Failed'), true);
    }
  } catch (e) { toast('Network error — check your connection', true); }
}

if ($('#paywallProBtn')) {
  $('#paywallProBtn').addEventListener('click', () => startTrialCheckout('pro'));
}
if ($('#paywallPremiumBtn')) {
  $('#paywallPremiumBtn').addEventListener('click', () => startTrialCheckout('premium'));
}
if ($('#paywallSwitchBtn')) {
  $('#paywallSwitchBtn').addEventListener('click', async () => {
    // Sign out current account, show auth gate to sign in with different account
    if (T.signOut) await T.signOut();
    const gate = $('#paywallGate');
    if (gate) { gate.classList.add('hidden'); gate.style.display = 'none'; }
    const authGate = $('#authGate');
    if (authGate) authGate.style.display = 'flex';
    updateAuthUI();
  });
}

// Refresh license every 30s
setInterval(() => { updateLicenseBanner(); checkPaywall(); }, 30000);

// Refresh immediately when quota changes (optimization performed)
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('quota-updated', () => updateLicenseBanner());
  window.__TAURI__.event.listen('quota-exhausted', (event) => {
    updateLicenseBanner();
    // Show exhausted banner in main window
    const banner = document.getElementById('licenseBanner');
    if (banner) {
      banner.classList.add('limit-warning');
      const usage = document.getElementById('licenseUsage');
      if (usage) usage.textContent = 'No active plan — start a free trial';
    }
    // Disconnect all sessions in UI
    if (T.getAgentSessions) {
      T.getAgentSessions().then(sessions => {
        // Sessions already disconnected server-side; refresh UI
        if (typeof renderSessions === 'function') renderSessions();
      }).catch(() => {});
    }
  });
}

// Also refresh when window gets focus (user returns from browser after payment)
// Debounced to avoid spamming server
let _lastLicenseCheck = 0;
window.addEventListener('focus', () => {
  const now = Date.now();
  if (now - _lastLicenseCheck < 10000) return; // skip if checked <10s ago
  _lastLicenseCheck = now;
  updateLicenseBanner();
  checkPaywall();
  // Also verify with backend if signed in
  if (T.getAuth && T.verifyLicense) {
    T.getAuth().then(auth => {
      if (auth.signedIn && auth.clerkUserId) {
        T.verifyLicense(auth.clerkUserId).then(() => { updateLicenseBanner(); checkPaywall(); });
      }
    });
  }
});

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
      // Click session to activate and show popup
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        if (T.activateSession) T.activateSession(null, a.agentType);
      });
      list.appendChild(item);
    });

    // Show manual sessions (cap at 20 to prevent DOM bloat)
    const maxSessions = 20;
    sessions.slice(0, maxSessions).forEach(s => {
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
      // Click session to activate and show popup
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        if (T.activateSession) T.activateSession(s.id, null);
      });
      list.appendChild(item);
    });
    if (sessions.length > maxSessions) {
      const more = document.createElement('div');
      more.className = 'session-item';
      more.style.cssText = 'text-align:center;font-size:10px;color:var(--t3);padding:6px';
      more.textContent = '+ ' + (sessions.length - maxSessions) + ' more sessions';
      list.appendChild(more);
    }
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
  if (text.length < 5) { toast('Text too short — need at least 5 characters'); return; }
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

// Upgrade / Start Trial / Manage button — open in system browser
$('#btnUpgrade').addEventListener('click', async () => {
  const API_BASE = 'https://www.terseai.org';
  const openUrl = (url) => {
    try { window.__TAURI__.shell.open(url); } catch { window.open(url, '_blank'); }
  };

  try {
    const lic = await T.getLicense();
    const auth = await T.getAuth();
    const userId = auth.clerkUserId || lic.clerkUserId;
    const tier = (lic.tier || '').toLowerCase();
    const status = (lic.status || '').toLowerCase();
    const noActivePlan = !tier || tier === 'expired' || tier === 'free' || status === 'cancelled' || status === 'none';

    if (!userId) {
      openUrl(`${API_BASE}/#pricing`);
      return;
    }

    if (noActivePlan) {
      // No plan — go to checkout for free trial
      try {
        const res = await fetch(`${API_BASE}/api/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: 'pro', clerkUserId: userId, clerkUserEmail: auth.email }),
        });
        const data = await res.json();
        if (data.url) { openUrl(data.url); return; }
      } catch {}
      openUrl(`${API_BASE}/#pricing`);
      return;
    }

    // Has active plan — open Stripe billing portal
    openUrl(`${API_BASE}/api/portal/redirect?uid=${encodeURIComponent(userId)}`);
  } catch {
    window.open(`${API_BASE}/#pricing`, '_blank');
  }
});

// ── Auth ──
$('#btnSignIn').addEventListener('click', () => doAuth('signin'));
$('#btnSignUp').addEventListener('click', () => doAuth('signup'));
$('#gateSignIn').addEventListener('click', () => doAuth('signin'));
$('#gateSignUp').addEventListener('click', () => doAuth('signup'));
$('#btnSignOut').addEventListener('click', async () => {
  if (T.signOut) await T.signOut();
  updateAuthUI();
  updateLicenseBanner();
});

async function doAuth(action) {
  if (!T.openAuthInBrowser) return;
  const btn = action === 'signup' ? $('#btnSignUp') : $('#btnSignIn');
  const gateBtn = action === 'signup' ? $('#gateSignUp') : $('#gateSignIn');
  btn.textContent = 'Opening browser...';
  btn.disabled = true;
  if (gateBtn) { gateBtn.textContent = 'Opening browser...'; gateBtn.disabled = true; }
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
  if (gateBtn) { gateBtn.textContent = action === 'signup' ? 'Create Account' : 'Sign In'; gateBtn.disabled = false; }
}

async function updateAuthUI() {
  if (!T.getAuth) return;
  try {
    const auth = await T.getAuth();
    const gate = $('#authGate');
    if (auth.signedIn) {
      if (gate) gate.style.display = 'none';
      $('#signedOutUI').classList.add('hidden');
      $('#signedInUI').classList.remove('hidden');
      $('#accountName').textContent = auth.firstName || 'User';
      $('#accountEmail').textContent = auth.email || '';
      if (auth.imageUrl) {
        $('#accountAvatar').src = auth.imageUrl;
        $('#accountAvatar').style.display = 'block';
      }
    } else {
      if (gate) gate.style.display = 'flex';
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
      T.verifyLicense(auth.clerkUserId).then(() => { updateLicenseBanner(); checkPaywall(); });
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
