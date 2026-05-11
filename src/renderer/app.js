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
      $('#licenseTier').textContent = tierLabel;
      $('#licenseUsage').textContent = 'Trial active';
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
T.on('ax-status', d => {
  if (d && !d.trusted) {
    toast('⚠ Accessibility permission reset by macOS — go to System Settings → Privacy → Accessibility and re-enable Terse', true);
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

  $('#palsBalance').textContent = `Coins: ${balance.toLocaleString()} 🪙 · Skins: ${skinCost} 🪙 each · Pets: $1 each`;

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
    <div style="font-size:11px;font-weight:700;color:var(--t1);margin-bottom:4px">Pet behavior</div>
    ${row('idleAnimation', 'Idle animation', 'Continuous breathing/bob')}
    ${row('eatAnimation', 'Eat on token save', 'Chomp + crumb when prompts get optimized')}
    ${row('milestoneAnimation', 'Milestone celebration', 'Happy bounce + sparkles every 1,000 tokens')}
    ${row('showBubbles', 'Speech bubbles', 'Show "+N tokens 🍪" / unlock messages')}
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
      ? '<span style="font-size:9px;font-weight:700;padding:2px 8px;background:var(--btn);color:var(--btn-t);border-radius:8px">EQUIPPED</span>'
      : (isOwned
        ? `<button class="pals-equip-btn" data-pet="${pal.id}" style="border:none;background:var(--btn);color:var(--btn-t);font-size:9px;font-weight:700;padding:3px 9px;border-radius:8px;cursor:pointer">EQUIP</button>`
        : `<button class="pals-buy-btn" data-pet="${pal.id}" style="border:none;background:#22a559;color:#fff;font-size:9px;font-weight:700;padding:3px 9px;border-radius:8px;cursor:pointer">Buy $1 💳</button>`);

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
        const subLabel = sEquipped ? 'Equipped' : (sOwned ? 'Tap to preview' : `🔒 ${skinCost} 🪙`);
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
          <div style="font-size:10px;font-weight:700;color:var(--t2);margin-bottom:6px">Skins (${skinCost} 🪙 each · click to preview)</div>
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
      ? `<button id="skinPreviewEquip" style="border:none;background:var(--btn,#4a7cff);color:#fff;font-size:12px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer">Equip</button>`
      : (canAfford
        ? `<button id="skinPreviewUnlock" style="border:none;background:var(--btn,#4a7cff);color:#fff;font-size:12px;font-weight:700;padding:8px 18px;border-radius:10px;cursor:pointer">Unlock · ${skinCost} 🪙</button>`
        : `<span style="font-size:11px;color:var(--t3,#888);padding:8px 12px">🔒 Need ${(skinCost - balance).toLocaleString()} more 🪙</span>`));

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
