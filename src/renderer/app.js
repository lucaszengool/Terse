const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const T = window.terse;

let prevView = 'sessions';
const views = { sessions: $('#sessionsView'), pick: $('#pickOverlay'), manual: $('#manualResult'), settings: $('#settingsPanel'), cleanup: $('#cleanupView'), boost: $('#boostView') };
function show(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
  if (name !== 'settings') prevView = name;
  // keep the sidebar highlight in sync with the visible page
  const page = ['cleanup', 'settings', 'boost'].includes(name) ? name : 'overview';
  $$('.sb-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
}

// Init
(async () => {
  // On cold launch, surface the Doctor (体检) report in this same window for
  // users who aren't signed in — it's the hook that shows what Terse finds.
  // Once signed in it never auto-opens (only reachable via the dock button).
  // The guard is sessionStorage, not localStorage: it persists across in-app
  // navigations (so navigating back from the Doctor doesn't bounce us straight
  // back into it), but resets on each app restart — so a still-signed-out user
  // sees it again next launch, exactly as asked.
  try {
    if (!sessionStorage.getItem('terse-doctor-autoshown') && T.getAuth) {
      sessionStorage.setItem('terse-doctor-autoshown', '1');
      const a = await T.getAuth().catch(() => null);
      if (!a || !a.signedIn) {
        if (T.navigateToDoctor) { T.navigateToDoctor(); return; }
      }
    }
  } catch (e) { /* non-fatal: fall through to the normal main view */ }

  const s = await T.getSettings();
  $$('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.level === s.aggressiveness));
  $$('.setting-row input').forEach(cb => { if (s[cb.dataset.key] !== undefined) cb.checked = s[cb.dataset.key]; });
  show('sessions');
  refreshSessions();
  updateLicenseBanner();
  checkPaywall();
})();

// ── License ──
// Format a weekly-quota reset timestamp as a short suffix, e.g. " · resets Mon"
// or " · resets today". Returns '' when the timestamp is missing/unparseable.
function fmtResetSuffix(iso) {
  if (!iso) return '';
  const reset = new Date(iso);
  if (isNaN(reset.getTime())) return '';
  const now = new Date();
  const dayMs = 86400000;
  const days = Math.round((reset - now) / dayMs);
  if (days <= 0) return ' · resets today';
  if (days === 1) return ' · resets tomorrow';
  if (days >= 7) return ' · resets Mon';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][reset.getDay()];
  return ' · resets ' + wd;
}

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
      // During the post-login grace window, present it as a free preview countdown
      // instead of the upsell — the user is meant to try Terse first.
      try {
        if (T.trialGraceStatus) {
          const g = await T.trialGraceStatus();
          if (g && g.inGrace && !g.hasPlan) {
            const mins = Math.max(1, Math.ceil((g.remainingSecs || 0) / 60));
            $('#licenseTier').textContent = 'Free preview';
            $('#licenseUsage').textContent = mins + ' min left · enjoy Terse';
            banner.classList.remove('limit-warning');
            $('#btnUpgrade').textContent = 'Start Free Trial';
            return;
          }
        }
      } catch {}
      // No active subscription — must start a trial
      $('#licenseTier').textContent = 'No Plan';
      $('#licenseUsage').textContent = 'Start a free trial to use Terse';
      banner.classList.add('limit-warning');
      $('#btnUpgrade').textContent = 'Start Free Trial';
      return;
    }

    if (status === 'trialing') {
      $('#licenseTier').textContent = tierLabel;
      $('#licenseUsage').textContent = 'Trial active';
      $('#btnUpgrade').textContent = 'Manage';
      return;
    }

    // Active paid subscription
    $('#licenseTier').textContent = tierLabel;
    if (lic.limits?.optimizationsPerWeek > 0 && lic.remaining >= 0) {
      $('#licenseUsage').textContent = lic.remaining + '/' + lic.limits.optimizationsPerWeek + ' left this week' + fmtResetSuffix(lic.resetsAt);
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
    // Grace window: for the first 15 minutes after login we let the user try Terse
    // without an active plan — keep the paywall hidden until the window elapses.
    try {
      if (T.trialGraceStatus) {
        const g = await T.trialGraceStatus();
        if (g && g.inGrace && !g.hasPlan) { gate.classList.add('hidden'); gate.style.display = 'none'; return; }
      }
    } catch {}
    const tier = (lic.tier || '').toLowerCase();
    const status = (lic.status || '').toLowerCase();
    const noActivePlan = !tier || tier === 'expired' || tier === 'free' || status === 'cancelled' || status === 'none';
    if (noActivePlan) {
      // Onboarding order: pick a starter pet BEFORE the paywall. The pet picker
      // and this gate share z-index:9998, and the gate is later in the DOM, so it
      // would otherwise paint on top of an unfinished pet selection. Defer until
      // the starter pet is picked (the pet-pick handler re-calls checkPaywall()).
      try {
        if (T.getPetState) {
          const pet = await T.getPetState();
          if (pet && pet.data && !pet.data.starterPicked) {
            gate.classList.add('hidden');
            gate.style.display = 'none';
            return;
          }
        }
      } catch {}
      gate.classList.remove('hidden');
      gate.style.display = 'flex';
    } else {
      gate.classList.add('hidden');
      gate.style.display = 'none';
    }
  } catch {}
}

async function startTrialCheckout(tier, noTrial = false, paymentMethod = null) {
  toast('Starting checkout…');
  let auth;
  try { auth = await T.getAuth(); } catch (e) { toast('Auth error: ' + e, true); return; }
  if (!auth.signedIn || !auth.clerkUserId) { toast('Not signed in (signedIn=' + auth.signedIn + ')', true); return; }
  toast('Fetching checkout URL…');
  const API_BASE = 'https://www.terseai.org';
  try {
    const body = { tier, clerkUserId: auth.clerkUserId, clerkUserEmail: auth.email };
    if (noTrial) body.noTrial = true;
    if (paymentMethod) body.paymentMethod = paymentMethod;
    const res = await fetch(`${API_BASE}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.url) {
      toast('Opening browser…');
      try {
        if (!window.__TAURI__?.shell) throw new Error('no shell');
        await window.__TAURI__.shell.open(data.url);
      } catch (e) {
        toast('shell.open failed: ' + e + ' — trying window.open', true);
        window.open(data.url, '_blank');
      }
    } else if (data.error === 'trial_already_used') {
      // Switch paywall gate to subscribe-directly mode
      const trialSection = $('#paywallTrialSection');
      const subscribeSection = $('#paywallSubscribeSection');
      if (trialSection) trialSection.style.display = 'none';
      if (subscribeSection) subscribeSection.style.display = 'flex';
    } else {
      toast('Error: ' + (data.error || 'Failed'), true);
    }
  } catch (e) { toast('Network error: ' + e, true); }
}

if ($('#paywallProBtn')) {
  $('#paywallProBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('pro'); });
}
if ($('#paywallPremiumBtn')) {
  $('#paywallPremiumBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('premium'); });
}
if ($('#paywallSubscribeProBtn')) {
  $('#paywallSubscribeProBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('pro', true); });
}
if ($('#paywallSubscribePremiumBtn')) {
  $('#paywallSubscribePremiumBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('premium', true); });
}
if ($('#paywallSubscribeWechatBtn')) {
  $('#paywallSubscribeWechatBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('pro', true, 'wechat_pay'); });
}
if ($('#paywallSubscribeAlipayBtn')) {
  $('#paywallSubscribeAlipayBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('pro', true, 'alipay'); });
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
  // 15-minute "try it first" window ended with no plan → reveal the paywall.
  window.__TAURI__.event.listen('trial-grace-expired', () => {
    updateLicenseBanner();
    checkPaywall();
    if (T.getAgentSessions && typeof renderSessions === 'function') {
      T.getAgentSessions().then(() => renderSessions()).catch(() => {});
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
        // Sync Stripe-purchased pets from server
        if (T.syncPetPurchases) T.syncPetPurchases();
      }
    });
  }
});

// ── Sessions ──
let _sessionsSig = '';
function refreshSessions() {
  Promise.all([T.getSessions(), T.getAgentSessions()]).then(([sessions, agentSessions]) => {
    // Agent events fire every few seconds; skip the rebuild when nothing
    // changed so hover states and animations never flicker mid-interaction.
    const sig = JSON.stringify([sessions, agentSessions]);
    if (sig === _sessionsSig) return;
    _sessionsSig = sig;
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
      // Click an agent (Claude) session to pull down the dynamic island onto it
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        if (T.focusIsland) T.focusIsland(a.agentType);
        else if (T.activateSession) T.activateSession(null, a.agentType);
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
T.on('ax-status', d => {
  if (d && !d.trusted) {
    console.warn('[terse] AX permission not granted');
  }
});

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
  // Record manual optimization stats
  if ((r.stats.originalTokens || 0) > 0) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) invoke('record_optimization', {
      source: 'manual',
      originalTokens: r.stats.originalTokens,
      optimizedTokens: r.stats.optimizedTokens,
    }).catch(() => {});
  }
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
$('#btnFarm').addEventListener('click', () => T.showFarmWindow());
$('#btnCowork')?.addEventListener('click', () => T.navigateToCowork());
$('#btnDoctor')?.addEventListener('click', () => {
  // Open the Doctor (体检) report inside this same window. Fall back to the
  // standalone window if in-window navigation isn't available.
  if (T.navigateToDoctor) T.navigateToDoctor();
  else if (T.showDoctorWindow) T.showDoctorWindow();
});
// The floating dashboard widgets now live inside the Dynamic Island hover card
// (see island.html / island.js) — the standalone launcher button was removed.
$('#btnCloseSettings').addEventListener('click', () => show(prevView));
$$('.toggle-btn').forEach(b => b.addEventListener('click', () => {
  $$('.toggle-btn').forEach(x => x.classList.remove('active')); b.classList.add('active');
  T.updateSettings({ aggressiveness: b.dataset.level });
}));
$$('.setting-row input').forEach(cb => cb.addEventListener('change', () => T.updateSettings({ [cb.dataset.key]: cb.checked })));

$('#btnMinimize').addEventListener('click', () => T.minimizeWindow());
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
        if (data.error === 'trial_already_used') {
          openUrl(`${API_BASE}/#pricing`);
          return;
        }
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
      // After sign-in, prompt user to pick a starter pet (once).
      maybeShowPetPicker();
    } else {
      if (gate) gate.style.display = 'flex';
      $('#signedOutUI').classList.remove('hidden');
      $('#signedInUI').classList.add('hidden');
    }
  } catch {}
}

// ── Pet picker overlay ──────────────────────────────────────────────
async function maybeShowPetPicker() {
  if (!T.getPetState || !window.TERSE_PALS) return;
  let state;
  try { state = await T.getPetState(); } catch { return; }
  if (!state || state.data.starterPicked) return;
  renderPetPickerGrid(state);
  const overlay = $('#petPicker');
  if (overlay) overlay.style.display = 'flex';
}

// ── Pals inventory (Phase 5) ─────────────────────────────────────
function openPalsPage() {
  const page = $('#palsPage');
  if (!page) return;
  page.style.display = 'flex';
  refreshPalsPage();
}
function closePalsPage() {
  const page = $('#palsPage');
  if (page) page.style.display = 'none';
}
async function refreshPalsPage() {
  if (!T.getPetState || !window.TERSE_PALS) return;
  const state = await T.getPetState();
  if (!state) return;
  const { KEKE, kekeSVG, SKINS, kekeSkinSVG } = window.TERSE_PALS;
  const owned = new Set(state.data.ownedPets || []);
  const equipped = state.data.equippedPet;
  const ownedSkins = state.data.ownedSkins || {};
  const equippedSkins = state.data.equippedSkins || {};
  const balance = state.spendableBalance || 0;
  const cost = state.unlockCostPet || 1000;
  const skinCost = state.unlockCostSkin || 1000;

  const pt = (key, p) => window.i18n ? window.i18n.t(key, p) : (p ? key : key);
  $('#palsBalance').textContent = pt('pals_balance', { coins: balance.toLocaleString(), skin_cost: skinCost });

  const scroll = $('#palsScroll');
  scroll.innerHTML = '';

  // ── Pet behavior settings card ──
  const s = state.data.settings || { showBubbles:true, eatAnimation:true, milestoneAnimation:true, idleAnimation:true };
  const settingsCard = document.createElement('div');
  settingsCard.style.cssText = 'background:var(--sf);border-radius:12px;padding:10px;margin-bottom:10px';
  const row = (key, label, sub) => `
    <label style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;cursor:pointer;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;color:var(--t1)">${label}</div>
        <div style="font-size:9px;color:var(--t3);margin-top:1px">${sub}</div>
      </div>
      <input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''} style="width:32px;height:18px;cursor:pointer;flex-shrink:0">
    </label>`;
  settingsCard.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:var(--t1);margin-bottom:4px">${pt('pet_behavior')}</div>
    ${row('idleAnimation', pt('idle_animation'), pt('idle_animation_desc'))}
    ${row('eatAnimation', pt('eat_on_save'), pt('eat_on_save_desc'))}
    ${row('milestoneAnimation', pt('milestone_celebration'), pt('milestone_celebration_desc'))}
    ${row('showBubbles', pt('speech_bubbles'), pt('speech_bubbles_desc'))}
  `;
  scroll.appendChild(settingsCard);
  settingsCard.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const next = {
        showBubbles: settingsCard.querySelector('[data-setting=showBubbles]').checked,
        eatAnimation: settingsCard.querySelector('[data-setting=eatAnimation]').checked,
        milestoneAnimation: settingsCard.querySelector('[data-setting=milestoneAnimation]').checked,
        idleAnimation: settingsCard.querySelector('[data-setting=idleAnimation]').checked,
      };
      try { await T.setPetSettings(next); } catch (e) { toast('Settings save failed: ' + e, true); }
    });
  });

  KEKE.forEach(pal => {
    const isOwned = owned.has(pal.id);
    const isEquipped = pal.id === equipped;
    const card = document.createElement('div');
    if (!isOwned) {
      card.className = 'pals-locked-card';
      card.dataset.pet = pal.id;
      card.style.cursor = 'pointer';
    }
    card.style.cssText += 'background:var(--sf);border-radius:12px;padding:8px;margin-bottom:8px;border:2px solid ' + (isEquipped ? 'var(--btn)' : 'transparent');
    const SIZE = 50;
    const equippedSkinId = equippedSkins[pal.id] || 'default';
    const equippedSkinOverlay = isOwned ? kekeSkinSVG(equippedSkinId, pal, SIZE) : '';
    const headerBtn = isEquipped
      ? `<span style="font-size:9px;font-weight:700;padding:2px 8px;background:var(--btn);color:var(--btn-t);border-radius:8px">${pt('equipped')}</span>`
      : (isOwned
        ? `<button class="pals-equip-btn" data-pet="${pal.id}" style="border:none;background:var(--btn);color:var(--btn-t);font-size:9px;font-weight:700;padding:3px 9px;border-radius:8px;cursor:pointer">${pt('equip')}</button>`
        : `<button class="pals-buy-btn" data-pet="${pal.id}" style="border:none;background:#22a559;color:#fff;font-size:9px;font-weight:700;padding:3px 9px;border-radius:8px;cursor:pointer">${pt('buy_pet')}</button>`);

    let skinsRow = '';
    if (isOwned) {
      const palOwnedSkins = new Set(ownedSkins[pal.id] || ['default']);
      const skinCells = SKINS.map(skin => {
        const sOwned = palOwnedSkins.has(skin.id);
        const sEquipped = equippedSkins[pal.id] === skin.id;
        const overlay = kekeSkinSVG(skin.id, pal, 40);
        const sCard = `<svg width="40" height="40" viewBox="-6 -6 52 52" style="display:block;margin:0 auto">${kekeSVG(pal, 40)}${overlay}</svg>`;
        const border = sEquipped ? 'var(--btn)' : (sOwned ? 'rgba(0,0,0,.08)' : 'rgba(0,0,0,.10)');
        const bg = sEquipped ? 'rgba(var(--btn-rgb,80,120,255),.10)' : 'var(--sf2,rgba(0,0,0,.03))';
        const opacity = sOwned ? 1 : 0.55;
        const subLabel = sEquipped ? pt('skin_equipped_label') : (sOwned ? pt('tap_to_preview') : `🔒 ${skinCost} 🪙`);
        const subColor = sEquipped ? 'var(--btn)' : 'var(--t3)';
        return `<div class="pals-skin-cell" data-action="preview-skin" data-pet="${pal.id}" data-skin="${skin.id}" title="${skin.name}" style="border:2px solid ${border};border-radius:10px;padding:6px 4px;cursor:pointer;opacity:${opacity};position:relative;background:${bg};text-align:center;transition:transform .12s,border-color .12s">
          ${sCard}
          <div style="font-size:9px;font-weight:700;color:var(--t1);margin-top:3px;line-height:1.1">${skin.emoji} ${skin.name}</div>
          <div style="font-size:8px;color:${subColor};margin-top:1px">${subLabel}</div>
          ${!sOwned ? '<div style="position:absolute;top:4px;right:4px;font-size:10px">🔒</div>' : ''}
        </div>`;
      }).join('');
      skinsRow = `
        <div style="margin-top:8px;padding-top:8px;border-top:1px dashed rgba(0,0,0,.10)">
          <div style="font-size:10px;font-weight:700;color:var(--t2);margin-bottom:6px">${pt('skins_header', { cost: skinCost })}</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">${skinCells}</div>
        </div>`;
    }

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:50px;height:50px;flex-shrink:0;opacity:${isOwned?1:0.45}">
          <svg width="${SIZE}" height="${SIZE}" viewBox="-8 -8 ${SIZE+16} ${SIZE+16}" style="display:block">${kekeSVG(pal, SIZE)}${equippedSkinOverlay}</svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:700;color:var(--t1)">${pal.name}</div>
          <div style="font-size:9px;color:var(--t3)">${pal.sub}</div>
        </div>
        ${headerBtn}
      </div>
      ${skinsRow}
    `;
    scroll.appendChild(card);
  });

  // Wire up unlock/equip buttons via delegation
  scroll.querySelectorAll('.pals-equip-btn').forEach(b => {
    b.addEventListener('click', async () => {
      try { await T.equipPet(b.dataset.pet); refreshPalsPage(); } catch (e) { console.warn(e); }
    });
  });
  // Buy pet via Stripe $1
  scroll.querySelectorAll('.pals-buy-btn').forEach(b => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const petId = b.dataset.pet;
      const pal = KEKE.find(p => p.id === petId);
      if (pal) { _showPetPreview(pal, cost, balance); return; }
      _startPetBuy(b, petId);
    });
  });
  // Skin cells → preview modal (animate + equip/unlock from there)
  scroll.querySelectorAll('.pals-skin-cell').forEach(c => {
    c.addEventListener('click', async () => {
      if (c.dataset.action !== 'preview-skin') return;
      const petId = c.dataset.pet;
      const skinId = c.dataset.skin;
      const state2 = await T.getPetState();
      const ownedSkins2 = state2?.data?.ownedSkins || {};
      const equippedSkins2 = state2?.data?.equippedSkins || {};
      const pal = KEKE.find(p => p.id === petId);
      const skin = SKINS.find(s => s.id === skinId);
      if (!pal || !skin) return;
      const sOwned = (ownedSkins2[petId] || []).includes(skinId);
      const sEquipped = equippedSkins2[petId] === skinId;
      const skinBal = state2.spendableBalance || 0;
      const sCost = state2.unlockCostSkin || 1000;
      _showSkinPreview(pal, skin, sOwned, sEquipped, skinBal, sCost);
    });
  });

  // Locked pet cards → preview modal on click
  scroll.querySelectorAll('.pals-locked-card').forEach(card => {
    card.addEventListener('click', () => {
      const petId = card.dataset.pet;
      const pal = KEKE.find(p => p.id === petId);
      if (!pal) return;
      _showPetPreview(pal, cost, balance);
    });
  });
}

async function _startPetBuy(btn, petId) {
  const orig = btn.textContent;
  btn.textContent = 'Opening…';
  btn.disabled = true;
  try {
    await T.buyPet(petId);
    refreshPalsPage();
    toast('Pet unlocked!');
  } catch (e) {
    toast('Purchase failed: ' + e, true);
    btn.textContent = orig;
    btn.disabled = false;
  }
}

function _showPetPreview(pal, cost, balance) {
  const { kekeSVG } = window.TERSE_PALS;
  const existing = document.getElementById('palPreviewOverlay');
  if (existing) existing.remove();
  const SIZE = 130;
  const W = SIZE + 32;
  const overlay = document.createElement('div');
  overlay.id = 'palPreviewOverlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center',
    'background:rgba(0,0,0,.45);backdrop-filter:blur(4px)',
    'animation:fadeIn .18s ease',
  ].join(';');

  overlay.innerHTML = `
    <style>
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @keyframes slideUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}
      @keyframes previewBob{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(-5px) scaleY(1.03)}}
      #palPreviewSheet{animation:slideUp .22s cubic-bezier(.34,1.56,.64,1)}
      #palPreviewPet svg{animation:${pal.anim || 'previewBob'} ${pal.spd || 2.4}s ease-in-out infinite;transform-origin:50% 100%}
    </style>
    <div id="palPreviewSheet" style="background:var(--bg,#fff);border-radius:20px 20px 0 0;padding:20px 20px 28px;width:100%;max-width:320px;text-align:center">
      <div style="width:32px;height:3px;background:rgba(0,0,0,.15);border-radius:2px;margin:0 auto 16px"></div>
      <div id="palPreviewPet" style="display:inline-block;margin-bottom:8px">
        <svg width="${W}" height="${W}" viewBox="-16 -16 ${SIZE+32} ${SIZE+32}" style="display:block;overflow:visible">${kekeSVG(pal, SIZE)}</svg>
      </div>
      <div style="font-size:16px;font-weight:800;color:var(--t1,#111)">${pal.name}</div>
      <div style="font-size:11px;color:var(--t3,#888);margin-top:3px">${pal.sub}</div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
        <button id="palPreviewClose" style="border:1px solid rgba(0,0,0,.12);background:var(--sf,#f5f5f5);color:var(--t2,#444);font-size:12px;font-weight:600;padding:8px 18px;border-radius:10px;cursor:pointer">Close</button>
        <button id="palPreviewBuy" data-pet="${pal.id}" style="border:none;background:#22a559;color:#fff;font-size:12px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer">Buy $1 💳</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#palPreviewClose').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const buyBtn = overlay.querySelector('#palPreviewBuy');
  buyBtn.addEventListener('click', async () => {
    buyBtn.textContent = 'Opening Stripe…';
    buyBtn.disabled = true;
    try {
      await T.buyPet(buyBtn.dataset.pet);
      overlay.remove();
      refreshPalsPage();
      toast('Pet unlocked!');
    } catch (e) {
      toast('Purchase failed: ' + e, true);
      buyBtn.textContent = 'Buy $1 💳';
      buyBtn.disabled = false;
    }
  });
}

function _showSkinPreview(pal, skin, sOwned, sEquipped, balance, skinCost) {
  const { kekeSVG, kekeSkinSVG } = window.TERSE_PALS;
  const existing = document.getElementById('skinPreviewOverlay');
  if (existing) existing.remove();
  const SIZE = 120;
  const W = SIZE + 32;
  const overlay = document.createElement('div');
  overlay.id = 'skinPreviewOverlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center',
    'background:rgba(0,0,0,.45);backdrop-filter:blur(4px)',
    'animation:fadeIn .18s ease',
  ].join(';');

  const canAfford = balance >= skinCost;
  const actionBtn = sEquipped
    ? `<span style="font-size:12px;font-weight:700;padding:8px 18px;background:var(--btn,#4a7cff);color:#fff;border-radius:10px;opacity:.6">Equipped</span>`
    : (sOwned
      ? `<button id="skinPreviewEquip" style="border:none;background:#4a7cff;color:#fff;font-size:12px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer">Equip</button>`
      : (canAfford
        ? `<button id="skinPreviewUnlock" style="border:none;background:#4a7cff;color:#fff;font-size:12px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer">Unlock · ${skinCost} 🪙</button>`
        : `<span style="font-size:11px;color:#888;padding:8px 12px;background:rgba(0,0,0,.06);border-radius:10px">🔒 Need ${(skinCost - balance).toLocaleString()} more 🪙</span>`));

  overlay.innerHTML = `
    <style>
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @keyframes slideUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}
      #skinPreviewSheet{animation:slideUp .22s cubic-bezier(.34,1.56,.64,1)}
      #skinPreviewPet svg{animation:${pal.anim || 'k-breathe'} ${pal.spd || 2.4}s ease-in-out infinite;transform-origin:50% 100%}
    </style>
    <div id="skinPreviewSheet" style="background:var(--bg,#fff);border-radius:20px 20px 0 0;padding:20px 20px 28px;width:100%;max-width:320px;text-align:center">
      <div style="width:32px;height:3px;background:rgba(0,0,0,.15);border-radius:2px;margin:0 auto 16px"></div>
      <div id="skinPreviewPet" style="display:inline-block;margin-bottom:8px">
        <svg width="${W}" height="${W}" viewBox="-16 -16 ${SIZE+32} ${SIZE+32}" style="display:block;overflow:visible">
          ${kekeSVG(pal, SIZE)}${kekeSkinSVG(skin.id, pal, SIZE)}
        </svg>
      </div>
      <div style="font-size:14px;font-weight:800;color:var(--t1,#111)">${skin.emoji} ${skin.name}</div>
      <div style="font-size:10px;color:var(--t3,#888);margin-top:2px">${pal.name} · ${pal.sub}</div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
        <button id="skinPreviewClose" style="border:1px solid rgba(0,0,0,.12);background:var(--sf,#f5f5f5);color:var(--t2,#444);font-size:12px;font-weight:600;padding:8px 18px;border-radius:10px;cursor:pointer">Close</button>
        ${actionBtn}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#skinPreviewClose').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const equipBtn = overlay.querySelector('#skinPreviewEquip');
  if (equipBtn) {
    equipBtn.addEventListener('click', async () => {
      try { await T.equipSkin(pal.id, skin.id); overlay.remove(); refreshPalsPage(); }
      catch (e) { toast('Equip failed: ' + e, true); }
    });
  }
  const unlockBtn = overlay.querySelector('#skinPreviewUnlock');
  if (unlockBtn) {
    unlockBtn.addEventListener('click', async () => {
      unlockBtn.textContent = 'Unlocking…';
      unlockBtn.disabled = true;
      try { await T.unlockSkin(pal.id, skin.id); overlay.remove(); refreshPalsPage(); }
      catch (e) { toast('Unlock failed: ' + e, true); unlockBtn.textContent = `Unlock · ${skinCost} 🪙`; unlockBtn.disabled = false; }
    });
  }
}
// Wire button + back button (idempotent — guard so this runs once)
(function _wirePalsButtons() {
  const tryWire = () => {
    const btn = document.getElementById('btnPals');
    const titleBtn = document.getElementById('btnPalsTitle');
    const back = document.getElementById('palsBackBtn');
    if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', openPalsPage); }
    if (titleBtn && !titleBtn._wired) { titleBtn._wired = true; titleBtn.addEventListener('click', openPalsPage); }
    if (back && !back._wired) { back._wired = true; back.addEventListener('click', closePalsPage); }
    if (!titleBtn || !back) setTimeout(tryWire, 200);
  };
  tryWire();
})();

function renderPetPickerGrid(state) {
  const { KEKE, kekeSVG } = window.TERSE_PALS;
  const grid = $('#petPickerGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const SIZE = 56;
  KEKE.forEach(pal => {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--sf);border-radius:12px;padding:6px 4px 4px;cursor:pointer;text-align:center;border:2px solid transparent;transition:transform .15s,border-color .15s';
    card.innerHTML = `
      <svg width="${SIZE}" height="${SIZE}" viewBox="-8 -8 ${SIZE+16} ${SIZE+16}" style="display:block;margin:0 auto">${kekeSVG(pal, SIZE)}</svg>
      <div style="font-size:9px;font-weight:700;color:var(--t1);margin-top:2px">${pal.name}</div>
      <div style="font-size:7.5px;color:var(--t3);line-height:1.1">${pal.sub}</div>
    `;
    card.addEventListener('mouseenter', () => { card.style.transform='translateY(-2px)'; card.style.borderColor='var(--btn)'; });
    card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.borderColor='transparent'; });
    card.addEventListener('click', async () => {
      try {
        await T.pickStarterPet(pal.id);
        const overlay = $('#petPicker');
        if (overlay) overlay.style.display = 'none';
        // Notify popup window so it can render the equipped pet
        if (window.__TAURI__?.event?.emit) {
          window.__TAURI__.event.emit('pet-equipped', { petId: pal.id });
        }
        // Starter pet picked — now the paywall may appear (it was deferred during onboarding).
        checkPaywall();
      } catch (e) { console.warn('[pet-picker] pick failed:', e); }
    });
    grid.appendChild(card);
  });
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

// ── Command palette (⌘K) + keyboard shortcuts ──
// Labels are English source strings; i18n's MutationObserver re-translates rendered
// items, and we also match the translated label (via i18n key) during fuzzy search.
const THEME_NAMES = ['azure','lime','lavender','coral','teal','midnight','rose','sage','sand'];
function setAggrLevel(level) { $(`.toggle-btn[data-level="${level}"]`)?.click(); }
const CMD_DEFS = [
  { ic: '📊', label: 'Open Statistics', key: 'cmd_open_stats', run: () => T.navigateToStats() },
  { ic: '🩺', label: 'Open Doctor', key: 'cmd_open_doctor', run: () => T.navigateToDoctor ? T.navigateToDoctor() : T.showDoctorWindow() },
  { ic: '👥', label: 'Open Team', key: 'cmd_open_team', run: () => T.navigateToCowork() },
  { ic: '🌾', label: 'Open Farm', key: 'cmd_open_farm', run: () => T.showFarmWindow() },
  { ic: '🐾', label: 'Open Pals', key: 'cmd_open_pals', run: () => $('#btnPalsTitle')?.click() },
  { ic: '＋', label: 'Connect a window', key: 'cmd_connect_window', kbd: '⌘N', run: () => $('#btnAddSession').click() },
  { ic: '⚙', label: 'Open Settings', key: 'cmd_open_settings', kbd: '⌘,', run: () => show('settings') },
  { ic: '✂', label: 'Optimize pasted text', key: 'cmd_optimize_text', kbd: '⌘↵', run: () => { show('sessions'); $('#manualInput').focus(); } },
  { ic: '🪶', label: 'Aggressiveness: Light', key: 'cmd_aggr_light', run: () => setAggrLevel('light') },
  { ic: '⚖', label: 'Aggressiveness: Balanced', key: 'cmd_aggr_balanced', run: () => setAggrLevel('balanced') },
  { ic: '🔥', label: 'Aggressiveness: Aggressive', key: 'cmd_aggr_aggressive', run: () => setAggrLevel('aggressive') },
  ...THEME_NAMES.map(name => ({
    ic: '🎨',
    label: 'Theme: ' + name.charAt(0).toUpperCase() + name.slice(1),
    key: 'cmd_theme_' + name,
    run: () => setTheme(name),
  })),
  { ic: '⌨', label: 'Keyboard Shortcuts', key: 'cmd_shortcuts', kbd: '⌘/', run: () => toggleSheet(true) },
  { ic: '💳', label: 'Manage subscription', key: 'cmd_manage_sub', run: () => $('#btnUpgrade').click() },
];

// Subsequence fuzzy score: word-start hits > consecutive hits > scattered hits. 0 = no match.
function fuzzyScore(q, s) {
  q = q.toLowerCase(); s = (s || '').toLowerCase();
  if (!q) return 1;
  let qi = 0, score = 0, prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      score += (i === 0 || s[i - 1] === ' ' || s[i - 1] === ':') ? 3 : (prev === i - 1 ? 2 : 1);
      prev = i; qi++;
    }
  }
  return qi === q.length ? score : 0;
}

let cmdSel = 0, cmdMatches = [];
function cmdDisplayLabel(def) {
  try { if (window.i18n) return window.i18n.t(def.key); } catch {}
  return def.label;
}
function renderCmds(query) {
  cmdMatches = CMD_DEFS
    .map(def => ({ def, score: Math.max(fuzzyScore(query, def.label), fuzzyScore(query, cmdDisplayLabel(def))) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(m => m.def);
  cmdSel = Math.min(cmdSel, Math.max(0, cmdMatches.length - 1));
  const list = $('#cmdList');
  list.innerHTML = '';
  if (!cmdMatches.length) {
    const d = document.createElement('div');
    d.className = 'cmd-empty';
    d.textContent = 'No matching commands';
    list.appendChild(d);
    return;
  }
  cmdMatches.forEach((def, i) => {
    const item = document.createElement('div');
    item.className = 'cmd-item' + (i === cmdSel ? ' sel' : '');
    item.innerHTML = `<span class="cmd-ic">${def.ic}</span><span class="cmd-label">${esc(def.label)}</span>${def.kbd ? `<kbd>${def.kbd}</kbd>` : ''}`;
    // mousedown (not click) so the input doesn't blur first
    item.addEventListener('mousedown', e => { e.preventDefault(); runCmd(def); });
    item.addEventListener('mousemove', () => {
      if (cmdSel !== i) { cmdSel = i; list.querySelectorAll('.cmd-item').forEach((el, j) => el.classList.toggle('sel', j === cmdSel)); }
    });
    list.appendChild(item);
  });
}
function runCmd(def) { closePalette(); try { def.run(); } catch (e) { console.warn('[cmd]', e); } }
function openPalette() {
  toggleSheet(false);
  $('#cmdPalette').classList.remove('hidden');
  const input = $('#cmdInput');
  input.value = ''; cmdSel = 0;
  renderCmds('');
  input.focus();
}
function closePalette() { $('#cmdPalette').classList.add('hidden'); }
function togglePalette() { $('#cmdPalette').classList.contains('hidden') ? openPalette() : closePalette(); }
function toggleSheet(force) {
  const sheet = $('#shortcutSheet');
  const open = force !== undefined ? force : sheet.classList.contains('hidden');
  if (open) closePalette();
  sheet.classList.toggle('hidden', !open);
}

$('#cmdInput').addEventListener('input', e => { cmdSel = 0; renderCmds(e.target.value.trim()); });
$('#cmdInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!cmdMatches.length) return;
    cmdSel = (cmdSel + (e.key === 'ArrowDown' ? 1 : cmdMatches.length - 1)) % cmdMatches.length;
    const items = $$('#cmdList .cmd-item');
    items.forEach((el, j) => el.classList.toggle('sel', j === cmdSel));
    items[cmdSel]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (cmdMatches[cmdSel]) runCmd(cmdMatches[cmdSel]);
  }
});
// Click on the dimmed backdrop closes
$('#cmdPalette').addEventListener('mousedown', e => { if (e.target === e.currentTarget) closePalette(); });
$('#shortcutSheet').addEventListener('mousedown', e => { if (e.target === e.currentTarget) toggleSheet(false); });

// Guided empty state → same flow as the + button
$('#btnEmptyConnect')?.addEventListener('click', () => $('#btnAddSession').click());

window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (mod && (k === 'k' || k === 'K')) { e.preventDefault(); togglePalette(); return; }
  if (mod && k === ',') { e.preventDefault(); show('settings'); return; }
  if (mod && k === '/') { e.preventDefault(); toggleSheet(); return; }
  if (mod && (k === 'n' || k === 'N')) { e.preventDefault(); $('#btnAddSession').click(); return; }
  if (k === 'Escape') {
    if (!$('#cmdPalette').classList.contains('hidden')) { closePalette(); return; }
    if (!$('#shortcutSheet').classList.contains('hidden')) { toggleSheet(false); return; }
    if (!views.settings.classList.contains('hidden')) { show(prevView); return; }
    if (!views.pick.classList.contains('hidden')) { $('#btnCancelPick').click(); return; }
    if (!views.manual.classList.contains('hidden')) { show('sessions'); return; }
  }
});

// ── Agent Health strip — surfaces the Doctor score on the home view ──
// Read-only scan (doctor_scan never mutates); refreshed every 30 minutes.
function hsBytes(b) {
  if (!b) return '';
  return b >= 1048576 ? (b / 1048576).toFixed(0) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}
function renderHealthStrip(rep) {
  const strip = $('#healthStrip');
  if (!strip || !rep || typeof rep.score !== 'number') return false;
  const s = rep.summary || {};
  $('#hsScore').textContent = rep.score;
  strip.classList.remove('ok', 'bad', 'loading', 'hidden');
  strip.dataset.loaded = '1';
  if (rep.score < 70) strip.classList.add('bad');
  else if (rep.score < 90) strip.classList.add('ok');
  const bits = [];
  if (s.agentsRunning) {
    let live = s.agentsRunning + ' agent' + (s.agentsRunning === 1 ? '' : 's') + ' active';
    if (s.agentsRssBytes) live += ' (' + hsBytes(s.agentsRssBytes) + ')';
    bits.push(live);
  }
  const issues = s.issues || 0;
  bits.push(issues === 0 ? 'all clear' : issues + (issues === 1 ? ' issue' : ' issues'));
  if (s.high) bits.push(s.high + ' need attention');
  if (s.recoverableUsd >= 0.01) bits.push('~$' + s.recoverableUsd + '/mo recoverable');
  if (s.junkBytes) bits.push(hsBytes(s.junkBytes) + ' cleanable');
  $('#hsSub').textContent = bits.join(' · ');
  return true;
}
async function refreshHealthStrip() {
  const strip = $('#healthStrip');
  if (!strip || !T.doctorScan) return;
  // Paint the last known result on the SAME frame (survives page navigations),
  // then refresh from a real scan in the background.
  if (!strip.dataset.loaded) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('terse-health-cache') || 'null'); } catch {}
    if (!renderHealthStrip(cached)) {
      strip.classList.add('loading');
      strip.classList.remove('hidden');
    }
  }
  try {
    const rep = await T.doctorScan('month');
    if (renderHealthStrip(rep)) {
      try {
        localStorage.setItem('terse-health-cache', JSON.stringify({ score: rep.score, summary: rep.summary }));
      } catch {}
    } else if (!strip.dataset.loaded) {
      strip.classList.add('hidden');
    }
  } catch (e) {
    if (!strip.dataset.loaded) strip.classList.add('hidden');
    console.warn('[terse] health strip:', e);
  }
}
$('#healthStrip')?.addEventListener('click', () => $('#btnDoctor').click());
refreshHealthStrip();
// Live enough to trust, cheap enough to forget: 5-minute cadence.
setInterval(refreshHealthStrip, 5 * 60 * 1000);

// ── Sidebar navigation (360-style shell) ──
const SB_ACTIONS = {
  overview: () => show('sessions'),
  cleanup:  () => { show('cleanup'); if (!clState.scanned) clScan(); },
  settings: () => show('settings'),
  doctor:   () => $('#btnDoctor').click(),
  stats:    () => T.navigateToStats(),
  team:     () => T.navigateToCowork && T.navigateToCowork(),
  farm:     () => T.showFarmWindow && T.showFarmWindow(),
  boost:    () => { show('boost'); refreshBoost(); },
  pals:     () => $('#btnPalsTitle')?.click(),
};
$$('.sb-item').forEach(b => b.addEventListener('click', () => {
  const page = b.dataset.page;
  // Same-frame feedback: highlight instantly; for cross-page navigations also
  // dim the pane so the click visibly registered before the new page loads.
  if (page !== 'pals') $$('.sb-item').forEach(x => x.classList.toggle('active', x === b));
  if (['doctor', 'stats', 'team'].includes(page)) document.body.classList.add('navigating');
  SB_ACTIONS[page]?.();
}));

// ── Cleanup (清理) page ──
const clState = { scanned: false, groups: [] };
function clFmtBytes(b) {
  if (!b) return '0 B';
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
function clSelected() {
  const out = { paths: [], bytes: 0, files: 0 };
  $$('#clGroups .cl-row').forEach((row, i) => {
    if (row.querySelector('input').checked && clState.groups[i]) {
      out.paths.push(...(clState.groups[i].paths || []));
      out.bytes += clState.groups[i].bytes || 0;
      out.files += (clState.groups[i].paths || []).length;
    }
  });
  return out;
}
function clUpdateFooter() {
  const sel = clSelected();
  $('#clTotal').textContent = clFmtBytes(sel.bytes);
  $('#clCount').textContent = sel.files + ' files selected';
  $('#btnClClean').disabled = sel.files === 0;
}
async function clScan() {
  const view = $('#cleanupView');
  view.classList.add('scanning');
  $('#clIdle').classList.remove('hidden');
  $('#clResults').classList.add('hidden');
  $('#clDone').classList.add('hidden');
  let res;
  try { res = await T.cleanupScan(); } catch (e) { view.classList.remove('scanning'); return; }
  view.classList.remove('scanning');
  clState.scanned = true;
  clState.groups = (res && res.groups) || [];
  if (!clState.groups.length) {
    $('#clIdle').classList.add('hidden');
    $('#clDoneMsg').textContent = 'All clean — nothing slowing your agents down';
    $('#clDone').classList.remove('hidden');
    return;
  }
  const box = $('#clGroups');
  box.innerHTML = '';
  clState.groups.forEach(g => {
    const row = document.createElement('label');
    row.className = 'cl-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', clUpdateFooter);
    const tx = document.createElement('div');
    tx.className = 'cl-row-tx';
    const t1 = document.createElement('div'); t1.className = 'cl-row-title'; t1.textContent = g.title;
    const t2 = document.createElement('div'); t2.className = 'cl-row-sub'; t2.textContent = g.detail;
    tx.appendChild(t1); tx.appendChild(t2);
    const sz = document.createElement('span');
    sz.className = 'cl-row-size'; sz.textContent = clFmtBytes(g.bytes);
    row.appendChild(cb); row.appendChild(tx); row.appendChild(sz);
    box.appendChild(row);
  });
  $('#clIdle').classList.add('hidden');
  $('#clResults').classList.remove('hidden');
  clUpdateFooter();
}
$('#btnClScan')?.addEventListener('click', clScan);
$('#btnClRescan')?.addEventListener('click', clScan);
$('#btnClScanAgain')?.addEventListener('click', clScan);
$('#btnClClean')?.addEventListener('click', async () => {
  const sel = clSelected();
  if (!sel.files) return;
  if (!(await tconfirm('Delete ' + sel.files + ' files (' + clFmtBytes(sel.bytes) + ')?', 'Stats, auth and recent sessions are never touched.', '一键清理 · Clean'))) return;
  const btn = $('#btnClClean');
  btn.disabled = true; btn.textContent = 'Cleaning…';
  try {
    const res = await T.cleanupClean(sel.paths);
    $('#clResults').classList.add('hidden');
    $('#clDoneMsg').textContent = (res && res.message) || 'Cleaned';
    $('#clDone').classList.remove('hidden');
    toast((res && res.message) || 'Cleaned');
    refreshHealthStrip();
  } catch (e) {
    toast('Cleanup failed — try again', true);
  }
  btn.disabled = false; btn.textContent = '一键清理 · Clean';
});

// ── Speed Up (加速) mode ──
async function refreshBoost() {
  if (!T.speedModeStatus) return;
  try {
    const st = await T.speedModeStatus();
    const on = !!(st && st.enabled);
    const tog = $('#boostToggle');
    if (tog) tog.checked = on;
    $('#sbBoostPill')?.classList.toggle('hidden', !on);
  } catch {}
}
$('#boostToggle')?.addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    await T.setSpeedMode(on);
    $('#sbBoostPill')?.classList.toggle('hidden', !on);
    toast(on ? '加速已开启 — agents will respond faster' : 'Speed Up off — full-detail mode');
  } catch {
    e.target.checked = !on;
    toast('Could not change Speed Up mode', true);
  }
});
refreshBoost();

// ── Sidebar pet icon — reflect the equipped skin's emoji when one is set ──
(async () => {
  try {
    if (!T.getPetState) return;
    const pet = await T.getPetState();
    const skins = (window.TERSE_PALS && window.TERSE_PALS.SKINS) || [];
    const skinId = pet && pet.data && pet.data.equippedSkins && pet.data.equippedSkins[pet.data.equippedPet];
    const skin = skins.find(s => s.id === skinId);
    if (skin && skin.emoji && skin.emoji !== '🐾') $('#sbPalIcon').textContent = skin.emoji;
  } catch {}
})();


// ── In-app confirm — WKWebView has no native window.confirm(), so a styled
//    promise-based modal stands in for it everywhere a destructive action asks.
function tconfirm(title, sub, okLabel) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'tc-overlay';
    ov.innerHTML =
      '<div class="tc-panel">' +
        '<div class="tc-title"></div>' +
        (sub ? '<div class="tc-sub"></div>' : '') +
        '<div class="tc-actions">' +
          '<button class="tc-cancel" type="button">Cancel</button>' +
          '<button class="tc-ok" type="button"></button>' +
        '</div>' +
      '</div>';
    ov.querySelector('.tc-title').textContent = title;
    if (sub) ov.querySelector('.tc-sub').textContent = sub;
    ov.querySelector('.tc-ok').textContent = okLabel || 'Confirm';
    const done = (val) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
    ov.querySelector('.tc-cancel').addEventListener('click', () => done(false));
    ov.querySelector('.tc-ok').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    ov.querySelector('.tc-ok').focus();
  });
}
