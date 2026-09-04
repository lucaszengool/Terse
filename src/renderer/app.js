const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const T = window.terse;

let prevView = 'sessions';
const views = { msgs: $('#msgsView'), sessions: $('#sessionsView'), pick: $('#pickOverlay'), manual: $('#manualResult'), settings: $('#settingsPanel'), cleanup: $('#cleanupView'), boost: $('#boostView'), prompts: $('#promptsView'), observe: $('#observeView'), mcp: $('#mcpView'), rules: $('#rulesView'), connection: $('#connectionView'), island: $('#islandView'), friends: $('#friendsView'), room: $('#roomView'), plaza: $('#plazaView') };
function show(name) {
  Object.values(views).forEach(v => v && v.classList.add('hidden'));
  views[name].classList.remove('hidden');
  if (name !== 'settings') prevView = name;
  // keep the sidebar highlight in sync with the visible page
  const page = ['cleanup', 'settings', 'boost', 'prompts', 'observe', 'mcp', 'rules', 'connection', 'island', 'friends', 'room', 'plaza', 'msgs'].includes(name) ? name : 'overview';
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
            $('#licenseTier').textContent = TT('trial_preview_tier');
            $('#licenseUsage').textContent = mins + ' ' + TT('trial_min_left');
            startTrialCountdown();
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
// ── Freemium model ──────────────────────────────────────────────────────────
// Monitoring is FREE forever (Dynamic Island, agent activity, Stats, Doctor scan,
// Wallpaper, Prompts, Farm). The paywall is never a wall anymore — it's an
// on-demand upgrade sheet opened when a free user attempts a Pro action (live
// optimization / auto-replace, Doctor auto-fix, Cleanup, Team, multi-repo graph)
// or taps Upgrade. So checkPaywall() only keeps the sheet closed + refreshes CTAs.
async function checkPaywall() {
  const gate = $('#paywallGate');
  if (gate && !gate.dataset.userOpened) { gate.classList.add('hidden'); gate.style.display = 'none'; }
  refreshUpgradeCta();
}

/* ── 试用倒计时 ──────────────────────────────────────────────────────────────
   横幅原本只在 updateLicenseBanner() 被调用时才刷新一次,所以"还剩 12 分钟"
   会一直挂在那儿不动,而 Pro 到点就没了。失去感只有在你知道自己拥有什么、
   还剩多久的时候才成立,所以这里让它真的走字,并在最后阶段提醒一次。 */
let _trialTick = null, _trialWarned = {};
function startTrialCountdown() {
  if (_trialTick) return;
  _trialTick = setInterval(async () => {
    try {
      if (!T.trialGraceStatus) return;
      const g = await T.trialGraceStatus();
      if (!g || !g.inGrace || g.hasPlan) {
        clearInterval(_trialTick); _trialTick = null;
        return;
      }
      const secs = Math.max(0, g.remainingSecs | 0);
      const mins = Math.ceil(secs / 60);
      const usage = $('#licenseUsage');
      if (usage) {
        usage.textContent = (secs > 90)
          ? mins + ' ' + TT('trial_min_left')
          : secs + ' ' + TT('trial_sec_left');
      }
      // 提前打招呼,别让 Pro 无声消失 —— 到期那一下才不会显得是被坑了。
      for (const at of [300, 60]) {
        if (secs <= at && !_trialWarned[at]) {
          _trialWarned[at] = true;
          toast(TT(at === 300 ? 'trial_warn_5m' : 'trial_warn_1m'));
        }
      }
    } catch {}
  }, 1000);
}

/** 免费层的价值计量条。
 *
 *  免费层要先自己站得住:让人看见 Terse 这周确实替他省下了东西,再谈升级。
 *  条子的比例是"已省 / 本可省" —— 后者按 Pro 的自动优化覆盖全部消息估算,
 *  所以缺口本身就是升级的理由,而且是他自己的数字,不是我们编的。
 *  取不到数据就整条不显示,绝不显示 0 充数。 */
async function refreshFreeValueMeter() {
  const box = $('#freeValueMeter');
  if (!box) return;
  try {
    const st = await (T.getStats ? T.getStats('week') : null);
    const sum = st && st.summary;
    const saved = (sum && +sum.tokensSaved) || 0;
    const total = (sum && +sum.messagesTotal) || 0;
    const opt   = (sum && +sum.messagesOptimized) || 0;
    if (!saved && !total) { box.classList.add('hidden'); return; }

    const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
                     : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n | 0);
    $('#fvmSaved').textContent = fmt(saved);
    $('#fvmSavedL').textContent = TT('fvm_saved_label');

    // 覆盖率:已优化 / 总消息。Pro 的自动优化把它推到 100%。
    const pct = total > 0 ? Math.min(100, Math.round((opt / total) * 100)) : 0;
    setTimeout(() => { const b = $('#fvmBar'); if (b) b.style.width = Math.max(3, pct) + '%'; }, 30);
    $('#fvmSub').textContent = total > 0
      ? TT('fvm_sub_a') + ' ' + pct + '% ' + TT('fvm_sub_b')
      : TT('fvm_sub_none');
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

async function refreshUpgradeCta() {
  try {
    if (!T.getLicense) return;
    const lic = await T.getLicense();
    let pro = !!(lic && lic.isPro);
    // The first 15 min after sign-in is a reverse-trial: full access, no upsell.
    // When it elapses the free-tier UI (hero, PRO locks, Upgrade CTA) appears —
    // this is the "after 15 minutes" state the user should clearly see.
    if (!pro && T.trialGraceStatus) {
      try { const g = await T.trialGraceStatus(); if (g && g.inGrace && !g.hasPlan) pro = true; } catch {}
    }
    document.body.classList.toggle('is-free', !pro);
    const cta = $('#sbUpgrade');
    if (cta) cta.style.display = pro ? 'none' : '';
    if (!pro) refreshFreeValueMeter(); else $('#freeValueMeter')?.classList.add('hidden');
  } catch {}
}

/* ── 试用期用了什么 ──────────────────────────────────────────────────────────
   逆向试用之所以有效,靠的是"失去"比"得到"更有分量 —— 但前提是用户知道自己
   失去了什么。试用结束时弹一句泛泛的"升级吧"等于什么都没说;把他这 15 分钟
   里真正用过的东西列出来,才有东西可失去。
   只记功能名和一个时间戳,存在本地,不上传。 */
const TRIAL_USED_KEY = 'terse.trialUsed';
const TRIAL_FEATURE_NAMES = {
  boost:      ['trial_f_boost',   'Speed Up'],
  cleanup:    ['trial_f_cleanup', 'Cleanup'],
  connection: ['trial_f_conn',    'Connection Doctor'],
  stats:      ['trial_f_stats',   'Statistics'],
  team:       ['trial_f_team',    'Team'],
  wallpaper:  ['trial_f_wall',    'Live Wallpaper'],
  doctor:     ['trial_f_doctor',  'Checkup'],
  graph:      ['trial_f_graph',   'Knowledge Graph'],
};
function markTrialFeatureUsed(key) {
  if (!TRIAL_FEATURE_NAMES[key]) return;
  try {
    const used = JSON.parse(localStorage.getItem(TRIAL_USED_KEY) || '{}');
    if (used[key]) return;                       // 首次即可,不必累计
    used[key] = Date.now();
    localStorage.setItem(TRIAL_USED_KEY, JSON.stringify(used));
  } catch {}
}
function trialFeaturesUsed() {
  try {
    const used = JSON.parse(localStorage.getItem(TRIAL_USED_KEY) || '{}');
    return Object.keys(used).filter(k => TRIAL_FEATURE_NAMES[k]);
  } catch { return []; }
}

/** 试用到期时的"挽留时刻"。
 *
 *  研究里把这一刻称作逆向试用中唯一最重要的一个设计点:降级本身应该是一次
 *  被设计过的体验,而不是功能悄悄消失。所以这里不再弹那句通用文案,而是
 *  拿他自己刚刚产生的事实说话 —— 用过哪几个功能、这段时间省下多少 token。 */
async function openTrialEndedSheet() {
  const feats = trialFeaturesUsed();
  let saved = 0;
  try {
    const st = await (T.getStats ? T.getStats('day') : null);
    saved = (st && st.summary && +st.summary.tokensSaved) || 0;
  } catch {}

  const lines = [];
  if (feats.length) {
    const names = feats.map(k => TT(TRIAL_FEATURE_NAMES[k][0]) || TRIAL_FEATURE_NAMES[k][1]);
    lines.push(TT('trial_end_used') + ' ' + names.join(' · '));
  }
  if (saved > 0) {
    const n = saved >= 1e6 ? (saved / 1e6).toFixed(2) + 'M'
            : saved >= 1e3 ? (saved / 1e3).toFixed(1) + 'K' : String(saved | 0);
    lines.push(TT('trial_end_saved_a') + ' ' + n + ' ' + TT('trial_end_saved_b'));
  }
  // 一个功能都没碰过、也没省下东西 —— 那就没有"失去"可讲,别硬编一个故事。
  openPaywall(lines.length ? lines.join('\n') : TT('pro_gate_optimize'));
  const t = $('#paywallTitle');
  if (t && lines.length) t.textContent = TT('trial_end_title');
}

function openPaywall(reason) {
  const gate = $('#paywallGate'); if (!gate) return;
  gate.dataset.userOpened = '1';
  gate.classList.remove('hidden'); gate.style.display = 'flex';
  if (reason) { const sub = $('#paywallSubtitle'); if (sub) sub.textContent = reason; }
}
function closePaywall() {
  const gate = $('#paywallGate'); if (!gate) return;
  delete gate.dataset.userOpened;
  gate.classList.add('hidden'); gate.style.display = 'none';
}
window.__terseOpenPaywall = openPaywall;

async function isPro() { try { const l = await T.getLicense(); return !!(l && l.isPro); } catch { return false; } }
// Gate a Pro action: returns true if allowed, else opens the upgrade sheet.
async function ensurePro(reason) { if (await isPro()) return true; openPaywall(reason || 'This is a Pro feature. Upgrade to unlock it.'); return false; }
window.__terseEnsurePro = ensurePro;

// Banner CTA + whole-banner click → open the trial sheet for free users.
$('#btnUpgrade')?.addEventListener('click', (e) => { e.stopPropagation(); openPaywall(); });
$('#licenseBanner')?.addEventListener('click', () => { if (document.body.classList.contains('is-free')) openPaywall(); });
// Free-tier hero CTA in the Overview.
$('#freeHeroBtn')?.addEventListener('click', () => openPaywall());

// A Pro-gated sub-page (Doctor/Stats) sends the user back here with #upgrade so
// the paywall opens on top of the app rather than being lost on navigation.
if (location.hash && location.hash.toLowerCase().indexOf('upgrade') >= 0) {
  try { history.replaceState(null, '', location.pathname); } catch {}
  setTimeout(() => openPaywall(TT('pro_gate_optimize')), 250);
}

// Guard for a Pro action outside the sidebar: opens the trial sheet when free.
async function proGuard(reasonKey, run) {
  if (document.body.classList.contains('is-free') && !(await isPro())) { openPaywall(TT(reasonKey)); return; }
  run();
}

// Dismiss controls (the sheet is now a modal, not a wall).
$('#paywallClose')?.addEventListener('click', closePaywall);
$('#paywallLaterBtn')?.addEventListener('click', closePaywall);
$('#paywallInviteBtn')?.addEventListener('click', () => { closePaywall(); openInvite(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const g = $('#paywallGate'); if (g && !g.classList.contains('hidden')) closePaywall();
    const inv = $('#inviteModal'); if (inv && !inv.classList.contains('hidden')) closeInvite();
  }
});

// ── Invite / referral sheet ──────────────────────────────────────────────────
let _referral = null;
function closeInvite() { const m = $('#inviteModal'); if (m) { m.classList.add('hidden'); m.style.display = 'none'; } }
async function openInvite() {
  const m = $('#inviteModal'); if (!m) return;
  m.classList.remove('hidden'); m.style.display = 'flex';
  $('#inviteMsg').textContent = '';
  try {
    _referral = await T.getReferralInfo();
  } catch { _referral = null; }
  const r = _referral || {};
  if (r.signedIn === false) {
    $('#inviteCode').textContent = 'sign in';
    $('#inviteMsg').textContent = 'Sign in to get your invite code.';
    renderInviteQr('');
    return;
  }
  $('#inviteCode').textContent = r.code || '······';
  $('#inviteSent').textContent = r.invited || 0;
  $('#inviteConv').textContent = r.converted || 0;
  $('#inviteDays').textContent = r.proDaysEarned || 0;
  // Credited on redemption, not on a later subscription — the old copy ("when a
  // friend starts Pro") described behaviour that left referrers on 0 days
  // forever. But the reward is for bringing someone NEW to Terse: the server
  // owns that rule, and the app must not restate it more generously than it is.
  if (r.rewardText) $('#inviteReward').innerHTML = esc(r.rewardText) +
    '. Your days land when a new user signs up with your code — you <b style="color:var(--t1)">both</b> win.';
  if (r.pending) $('#inviteMsg').textContent = 'Referral rewards are rolling out — your code is ready to share.';
  renderInviteQr(referralShareUrl());
  renderLifetimeProgress(r);
}

/* The referral link, from the server when it sends one and derived from the
   code when it doesn't. Single source for the Copy button and the QR, so the
   square and the clipboard can never carry different links. */
function referralShareUrl() {
  const code = ($('#inviteCode')?.textContent || '').trim();
  if (!code || code === 'sign in' || code === '······') return '';
  return (_referral && _referral.shareUrl) || ('https://www.terseai.org/?ref=' + code);
}

function renderInviteQr(url) {
  const box = $('#inviteQr');
  if (!box) return;
  box.innerHTML = '';
  if (!url || !window.TerseQR) return;
  try {
    box.innerHTML = window.TerseQR.svg(url, { size: 104, quiet: 2 }) +
      `<div style="font-size:10px;color:var(--t3);line-height:1.55">
         <div>Scan the code with any phone camera</div>
         <div style="opacity:.8;margin-top:3px">It opens your invite — they get Pro free, and so do you.</div>
       </div>`;
  } catch (e) { /* only throws when the payload is too long for any version */ }
}
// 10 successful invites → permanent 买断 (all features, all future updates).
// Driven by lifetimeGoal/lifetimeRemaining from /api/referral; an older server
// omits them, in which case the row stays hidden rather than showing a fake 0/10.
function renderLifetimeProgress(r) {
  const box = $('#inviteLifetime');
  if (!box) return;
  const goal = Number(r.lifetimeGoal) || 0;
  if (!goal) { box.style.display = 'none'; return; }
  box.style.display = '';
  const invited = Number(r.invited) || 0;
  const done = !!r.lifetime;
  const remaining = done ? 0 : Math.max(0, Number(r.lifetimeRemaining ?? (goal - invited)));
  const pct = done ? 100 : Math.min(100, Math.round((invited / goal) * 100));
  $('#inviteLifetimeFill').style.width = pct + '%';
  $('#inviteLifetimeCount').textContent = done ? '✓' : invited + '/' + goal;
  $('#inviteLifetimeLabel').textContent = done
    ? 'Lifetime unlocked — yours forever'
    : (r.lifetimeText || ('Invite ' + goal + ' friends → Terse free forever'))
      + (remaining ? ' · ' + remaining + ' to go' : '');
}

window.__terseOpenInvite = openInvite;

$('#inviteClose')?.addEventListener('click', closeInvite);
$('#inviteCopy')?.addEventListener('click', async () => {
  const url = referralShareUrl();
  if (!url) return;
  try { await navigator.clipboard.writeText(url); } catch { try { await T.applyToClipboard(url); } catch {} }
  $('#inviteMsg').textContent = 'Share link copied ✓';
});
$('#inviteRedeemBtn')?.addEventListener('click', async () => {
  const code = ($('#inviteRedeemInput').value || '').trim().toUpperCase();
  if (!code) { $('#inviteMsg').textContent = 'Enter a code.'; return; }
  $('#inviteMsg').textContent = 'Redeeming…';
  try {
    const res = await T.redeemReferralCode(code);
    if (res && res.granted) {
      // A TERSE-… gift code grants lifetime outright; a friend's invite code
      // grants days and also pays the friend immediately.
      $('#inviteMsg').textContent = (res.lifetime ? '🎉 ' : '🎉 ') + (res.message || '14 days of Pro unlocked!');
      updateLicenseBanner(); refreshUpgradeCta();
      openInvite(); // re-fetch so the counters and lifetime bar reflect the grant
    } else {
      $('#inviteMsg').textContent = (res && res.message) || 'That code could not be redeemed.';
    }
  } catch (e) { $('#inviteMsg').textContent = String(e); }
});

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

// Currently selected plan tier (set by the plan cards via window.__terseSelectPlan).
// Payment-method buttons below act on whichever plan is selected.
const selectedTier = () => window.__terseTier || 'pro';

// ── Trial gate: card gives the monthly plan a free trial; weekly/quarterly and all
// WeChat/Alipay payments charge immediately (backend gates the trial to tier==='pro'). ──
if ($('#paywallCardBtn')) {
  $('#paywallCardBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const t = selectedTier();
    // Weekly (7-day) and monthly (30-day) start as a $0 trial on card; quarterly charges now.
    startTrialCheckout(t, t !== 'pro' && t !== 'pro_weekly');
  });
}
if ($('#paywallWechatBtn')) {
  $('#paywallWechatBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout(selectedTier(), true, 'wechat_pay'); });
}
if ($('#paywallAlipayBtn')) {
  $('#paywallAlipayBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout(selectedTier(), true, 'alipay'); });
}
if ($('#paywallPremiumBtn')) {
  $('#paywallPremiumBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('premium'); });
}

// ── Subscribe gate (after trial_already_used): no trial on any plan/method. ──
if ($('#paywallSubscribeProBtn')) {
  $('#paywallSubscribeProBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout(selectedTier(), true); });
}
if ($('#paywallSubscribePremiumBtn')) {
  $('#paywallSubscribePremiumBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout('premium', true); });
}
if ($('#paywallSubscribeWechatBtn')) {
  $('#paywallSubscribeWechatBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout(selectedTier(), true, 'wechat_pay'); });
}
if ($('#paywallSubscribeAlipayBtn')) {
  $('#paywallSubscribeAlipayBtn').addEventListener('click', (e) => { e.stopPropagation(); startTrialCheckout(selectedTier(), true, 'alipay'); });
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
    // Monitoring stays free — no disconnects. Surface the upgrade sheet for the
    // Pro-only optimization the user just tried.
    const msg = (event && event.payload && event.payload.message) || 'Live optimization is a Pro feature.';
    openPaywall(msg);
  });
  // On-demand upgrade sheet requested (from the floating popup / anywhere).
  window.__TAURI__.event.listen('open-paywall', (event) => {
    openPaywall((event && event.payload && event.payload.reason) || null);
  });
  window.__TAURI__.event.listen('license-updated', () => { updateLicenseBanner(); refreshUpgradeCta(); });
  // 15-minute "try it first" window ended with no plan → reveal the paywall.
  window.__TAURI__.event.listen('trial-grace-expired', () => {
    updateLicenseBanner();
    refreshUpgradeCta();                 // 立刻切到免费界面,再讲失去了什么
    openTrialEndedSheet();
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

    updateKpis(agentSessions);
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

// ── Anomaly banner — one urgent issue, one click to act ──────────────────
function updateAnomaly(busy){
  const b = $('#anomalyBanner'); if (!b) return;
  let an = null; // {sev, ic, tx, action}
  if (busy){
    const ctx = busy.contextFill||0, burn = busy.burnRate||0, cache = busy.cacheEfficiency;
    const dup = busy.toolCachePotential && busy.toolCachePotential.duplicateCalls || 0;
    if (ctx >= 90) an = { sev:'red', ic:'⚠', tx:`Context ${ctx}% full — quality is dropping. Run /compact now.`, action:'doctor' };
    else if (burn >= 80000) an = { sev:'amber', ic:'🔥', tx:`Burn rate ${fmtNum(burn)}/min — you'll hit your limit fast.`, action:'doctor' };
    else if (busy.turns >= 3 && cache != null && cache < 40) an = { sev:'amber', ic:'💸', tx:`Cache only ${cache}% — you're re-paying for context every turn.`, action:'doctor' };
    else if (dup >= 3) an = { sev:'amber', ic:'🔁', tx:`${dup} duplicate tool calls — the agent may be looping.`, action:'doctor' };
  }
  if (!an){ b.classList.add('hidden'); return; }
  b.className = 'anomaly ' + an.sev;
  $('#anIc').textContent = an.ic; $('#anTx').textContent = an.tx;
  b._action = an.action;
}
$('#anomalyBanner')?.addEventListener('click', ()=>{ const a = $('#anomalyBanner')._action; if (a==='doctor') $('#btnDoctor')?.click(); });

// ── Overview KPI hero — decision-critical numbers (F-pattern, top-left) ──
let _kpiSavedCache = null;
function fmtNum(n){ return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(Math.round(n)); }
function updateKpis(agentSessions){
  // Live metrics from the busiest connected session.
  const busy = (agentSessions||[]).slice().sort((a,b)=>(b.totalInputTokens||0)-(a.totalInputTokens||0))[0];
  const spend = (agentSessions||[]).reduce((s,a)=>s+(a.estimatedCost||0),0);
  $('#kpiSpend').querySelector('.kpi-v').textContent = '$'+spend.toFixed(2);
  if (busy){
    const burn = busy.burnRate||0;
    const eta = busy.limitEtaMinutes || busy.etaMinutes;
    $('#kpiBurn').querySelector('.kpi-v').textContent = fmtNum(burn)+'/min';
    $('#kpiBurn').querySelector('.kpi-l').textContent = eta ? `Burn · ~${eta}m left` : 'Burn rate';
    const ctx = busy.contextFill||0;
    const ctxEl = $('#kpiCtx').querySelector('.kpi-v');
    ctxEl.textContent = ctx+'%';
    ctxEl.style.color = ctx>=90 ? 'var(--red,#ff6b6b)' : ctx>=75 ? 'var(--warn,#ffb648)' : '';
  } else {
    $('#kpiBurn').querySelector('.kpi-v').textContent = '–';
    $('#kpiCtx').querySelector('.kpi-v').textContent = '–';
  }
  // Anomaly banner — the single most urgent thing right now.
  updateAnomaly(busy);
  // Saved today from stats (cached briefly to avoid hammering).
  const now = Date.now();
  if (!_kpiSavedCache || now - _kpiSavedCache.t > 4000){
    _kpiSavedCache = { t: now };
    (T.getStats ? T.getStats('day') : Promise.resolve(null)).then(st=>{
      const saved = st && st.summary ? (st.summary.tokensSaved||0) : 0;
      $('#kpiSaved').querySelector('.kpi-v').textContent = fmtNum(saved);
    }).catch(()=>{});
  }
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
$('#btnStats').addEventListener('click', () => proGuard('pro_gate_stats', () => T.navigateToStats()));
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
      // After sign-in: run the first-run onboarding once, then the pet picker.
      maybeRunOnboarding();
    } else {
      $('#signedOutUI').classList.remove('hidden');
      $('#signedInUI').classList.add('hidden');
      // ── Value-first: before asking anyone to sign in, run a live agent-detection +
      // Doctor 体检 scan so they see their REAL agents, health score and savings first,
      // then prompt account creation. Biggest lever against the "signup wall" drop-off.
      try {
        const ob = window.TERSE_ONBOARDING;
        if (ob && ob.startPreview && !ob.hasPreviewed()) {
          if (gate) gate.style.display = 'none';
          ob.startPreview(function () { if (gate) gate.style.display = 'flex'; doAuth('signup'); });
          return;
        }
      } catch (e) { console.warn('[onboarding] preview failed', e); }
      if (gate) gate.style.display = 'flex';
    }
  } catch {}
}

// ── First-run onboarding ──
// If the user already saw the pre-signin value preview (agents + Doctor), skip the
// full onboarding and go straight to the pet picker. Otherwise run it once.
function maybeRunOnboarding() {
  try {
    const ob = window.TERSE_ONBOARDING;
    if (ob && ob.hasPreviewed && ob.hasPreviewed()) { maybeShowPetPicker(); return; }
    if (ob && !ob.hasOnboarded()) { ob.start(() => maybeShowPetPicker()); return; }
  } catch (e) { console.warn('[onboarding] start failed', e); }
  maybeShowPetPicker();
}

// ── Pet picker overlay ──────────────────────────────────────────────
async function maybeShowPetPicker() {
  if (!T.getPetState || !window.TERSE_PALS) { maybeStartTour(); return; }
  let state;
  try { state = await T.getPetState(); } catch { maybeStartTour(); return; }
  if (!state || state.data.starterPicked) { maybeStartTour(); return; }
  renderPetPickerGrid(state);
  const overlay = $('#petPicker');
  if (overlay) overlay.style.display = 'flex';
}

// ── Guided sidebar tour ──
// Runs once, the first time the user actually lands on the shell — so it never
// competes with the onboarding flow, the pet picker or the paywall for attention.
function maybeStartTour() {
  const tour = window.TERSE_TOUR;
  if (!tour || tour.hasSeen()) return;
  const blocked = () =>
    $('#petPicker')?.style.display === 'flex' ||
    document.querySelector('#onbFlow.show') ||
    !$('#paywallGate')?.classList.contains('hidden');
  let tries = 0;
  (function wait() {
    if (tries++ > 40) return;
    if (blocked()) return setTimeout(wait, 500);
    setTimeout(() => { if (!blocked()) tour.start(); }, 700);
  })();
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
        maybeStartTour();
      } catch (e) { console.warn('[pet-picker] pick failed:', e); }
    });
    grid.appendChild(card);
  });
}

// Load auth state on startup
// Re-verify the licence whenever the window regains focus.
//
// Checkout happens in the BROWSER: the user clicks Upgrade, pays, then comes
// back to the app. Until now the licence was only fetched on launch, so the app
// still showed everything locked until they quit and reopened it — which is
// indistinguishable from the isPro bug we just fixed, and would have produced
// the same "我买了但用不了" reports for every future purchase.
//
// Throttled to once per 5s so alt-tabbing doesn't hammer the endpoint.
(function reverifyOnFocus() {
  let last = 0;
  window.addEventListener('focus', async () => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    try {
      if (!T.getAuth || !T.verifyLicense) return;
      const auth = await T.getAuth();
      if (!auth || !auth.signedIn || !auth.clerkUserId) return;
      await T.verifyLicense(auth.clerkUserId);
      updateLicenseBanner();
      refreshUpgradeCta();
      if (typeof checkPaywall === 'function') checkPaywall();
    } catch (e) { /* offline — keep whatever the cached licence says */ }
  });
})();

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
const THEME_NAMES = ['horizon','azure','lime','lavender','coral','teal','midnight','rose','sage','sand'];
function setAggrLevel(level) { $(`.toggle-btn[data-level="${level}"]`)?.click(); }
const CMD_DEFS = [
  { ic: '📊', label: 'Open Statistics', key: 'cmd_open_stats', run: () => proGuard('pro_gate_stats', () => T.navigateToStats()) },
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
/* ── Pro 预览横幅 ─────────────────────────────────────────────────────────────
   免费用户进入一个 Pro 页面时,告诉他这一页开了 Pro 会多做什么。
   研究里最稳的一条:有上下文的付费提示比一句泛泛的"升级"有效得多,而
   "刚看见自己有 3.2G 可清理"正是那个有上下文的时刻。 */
let proPreviewPage = null;
const PRO_PREVIEW_COPY = {
  boost:      ['#boostView',      'pro_gate_boost'],
  cleanup:    ['#cleanupView',    'pro_gate_cleanup'],
  connection: ['#connectionView', 'pro_gate_connection'],
};
function renderProPreviewBanner() {
  let el = document.getElementById('proPreviewBar');
  if (!proPreviewPage || !document.body.classList.contains('is-free')) {
    if (el) el.remove();
    return;
  }
  const copy = PRO_PREVIEW_COPY[proPreviewPage];
  if (!copy) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'proPreviewBar';
    el.innerHTML = '<span class="ppb-dot"></span><span class="ppb-t"></span>'
                 + '<button class="ppb-btn"></button>';
    el.querySelector('.ppb-btn').addEventListener('click', () => {
      const c = PRO_PREVIEW_COPY[proPreviewPage];
      openPaywall(c ? TT(c[1]) : undefined);
    });
  }
  el.querySelector('.ppb-t').textContent = TT(copy[1]);
  el.querySelector('.ppb-btn').textContent = TT('pro_prev_cta');
  const host = document.querySelector(copy[0]);
  if (!host) return;
  if (el.parentElement !== host) host.insertBefore(el, host.firstChild);
}

/* ══════════════ 消息中心 ══════════════
   壁纸上的大字只是预览;这里是全部。同一个数据源(通知中心),按 app 分类,
   每条都能就地回复。回复走的是各 app 自己的 UI 自动化,只对验证过的 app 开放
   —— 详见 messages.rs 里那段说明:发错人是收不回来的。 */
let msgsAll = [], msgsFilter = '*', msgsTimer = null;

function msgFmtTime(ts) {
  const d = new Date((ts || 0) * 1000), n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  return d.toDateString() === n.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

function msgsRenderTabs() {
  const host = $('#msgsTabs');
  if (!host) return;
  const counts = new Map();
  msgsAll.forEach(m => counts.set(m.app_name, (counts.get(m.app_name) || 0) + 1));
  const tabs = [['*', '全部', msgsAll.length]]
    .concat([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => [n, n, c]));
  host.innerHTML = tabs.map(([key, label, n]) =>
    `<div class="msgs-tab${key === msgsFilter ? ' on' : ''}" data-k="${String(key).replace(/"/g, '&quot;')}">`
    + `${label}<span class="mt-n">${n}</span></div>`).join('');
  host.querySelectorAll('.msgs-tab').forEach(t => t.addEventListener('click', () => {
    msgsFilter = t.dataset.k; msgsRenderTabs(); msgsRenderList();
  }));
}

/** 哪些 app 能直接回复 —— 和 messages.rs 里的配方表一一对应。
 *  提前告诉人,而不是等他打完一段字、按了发送才说"不支持"。 */
const REPLYABLE = ['com.tencent.xinwechat', 'com.tencent.weworkmac',
                   'com.bytedance.lark', 'com.electron.lark'];
const canReply = (id) => REPLYABLE.includes(String(id || '').toLowerCase());

function msgsRenderList() {
  const host = $('#msgsList');
  if (!host) return;
  const list = msgsAll.filter(m => msgsFilter === '*' || m.app_name === msgsFilter);
  $('#msgsEmpty')?.classList.toggle('hidden', list.length > 0);
  const esc = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  host.innerHTML = list.map((m, i) => `
    <div class="mrow" data-i="${i}">
      <div class="mrow-top">
        <span class="mrow-app">${esc(m.app_name)}</span>
        ${m.group ? `<span class="mrow-room">${esc(m.group)}</span>` : ''}
        <span class="mrow-time">${msgFmtTime(m.ts)}</span>
      </div>
      <div class="mrow-sender">${esc(m.sender)}</div>
      <div class="mrow-body">${esc(m.body)}</div>
      <div class="mrow-actions">
        <input type="text" placeholder="${canReply(m.app_id) ? ('回复 ' + esc(m.group || m.sender) + '…') : (esc(m.app_name) + ' 暂不支持直接回复')}"
               autocomplete="off"${canReply(m.app_id) ? '' : ' disabled'}>
        <button${canReply(m.app_id) ? '' : ' disabled'}>发送</button>
      </div>
      <div class="mrow-note">${canReply(m.app_id) ? '' : '只有查证过搜索入口的 app 才开放回复,免得发错人。'}</div>
    </div>`).join('');

  host.querySelectorAll('.mrow').forEach(row => {
    const m = list[+row.dataset.i];
    const inp = row.querySelector('input'), btn = row.querySelector('button');
    const note = row.querySelector('.mrow-note');
    if (!canReply(m.app_id)) return;
    // 两步:先打开会话让人看,确认了再发。
    // 微信 4.1.11 不向 Accessibility 暴露任何界面,程序无法确认搜索打开的是谁 ——
    // 所以确认这一步交给人眼,而不是假装机器验过了。
    let armed = false;
    const reset = () => { armed = false; btn.textContent = '打开会话'; };
    reset();
    const step = async () => {
      const text = (inp.value || '').trim();
      if (!text) { note.textContent = '先写点内容'; return; }
      btn.disabled = true;
      try {
        if (!armed) {
          note.textContent = '正在打开会话…';
          const r = await T.messagesOpenChat(m.app_id, m.group || m.sender);
          if (r && r.ok) {
            armed = true;
            btn.textContent = '确认发送';
            note.textContent = '已在 ' + m.app_name + ' 打开会话 —— 请先看一眼是不是「'
                             + (m.group || m.sender) + '」,确认无误再点发送。';
          } else {
            note.textContent = '打不开会话 — ' + ((r && r.error) || '未知原因');
          }
        } else {
          note.textContent = '发送中…';
          const r = await T.messagesSendOpen(m.app_id, text);
          note.textContent = (r && r.ok) ? '已发送' : ('未发送 — ' + ((r && r.error) || '未知原因'));
          if (r && r.ok) inp.value = '';
          reset();
        }
      } catch (e) { note.textContent = '出错 — ' + (e && e.message ? e.message : e); reset(); }
      btn.disabled = false;
    };
    btn.addEventListener('click', step);
    // 回车只走第一步,不直接发 —— 手一滑就发出去正是要避免的事
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !armed) step(); });
    inp.addEventListener('input', () => { if (armed) reset(); });
  });
}

/** 社媒面板:检测到的 app + 每个的壁纸开关。 */
async function msgsRenderApps() {
  const host = $('#msgsApps');
  if (!host) return;
  let apps = [];
  try { apps = await (T.messagesDetectedApps ? T.messagesDetectedApps() : []); } catch (e) { apps = []; }
  if (!Array.isArray(apps) || !apps.length) {
    host.innerHTML = '<div class="msgs-apps-empty">还没识别到社交 app。收到消息后会自动出现在这里。</div>';
    return;
  }
  const esc = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  host.innerHTML = apps.map((a, i) => `
    <div class="mapp${a.on_wallpaper ? '' : ' off'}" data-i="${i}">
      <span class="mapp-n" title="${esc(a.app_id)}">${esc(a.app_name)}</span>
      <span class="mapp-c">${a.count}</span>
      <span class="mapp-sw${a.on_wallpaper ? ' on' : ''}"></span>
    </div>`).join('');

  host.querySelectorAll('.mapp').forEach(el => {
    const a = apps[+el.dataset.i];
    const sw = el.querySelector('.mapp-sw');
    sw.addEventListener('click', async () => {
      const next = !sw.classList.contains('on');
      // 先动 UI 再写盘 —— 开关必须立刻有反应
      sw.classList.toggle('on', next);
      el.classList.toggle('off', !next);
      try { await T.messagesSetAppOnWallpaper(a.app_id, next); }
      catch (e) {                       // 写失败就把开关退回去,别让界面撒谎
        sw.classList.toggle('on', !next);
        el.classList.toggle('off', next);
      }
    });
  });
}

/** 权限清单。能真检测的只报真状态(完全磁盘访问、辅助功能);
 *  微信通知样式那一项检测不可靠,所以标成"建议",给深链让人自己看一眼,
 *  而不是给一个可能是错的"已开启"。 */
async function msgsRenderPerms(report) {
  const host = $('#msgsPermList');
  if (!host) return;
  const rows = [
    { key: 'fulldisk', dot: report.fullDiskAccess ? 'ok' : 'bad',
      name: '完全磁盘访问权限',
      desc: report.fullDiskAccess ? '已就绪 — 能读到通知' : '没有它,系统不让任何 app 读通知中心(包括 Terse)',
      done: report.fullDiskAccess },
    { key: 'accessibility', dot: report.accessibility ? 'ok' : 'bad',
      name: '辅助功能',
      desc: report.accessibility ? '已就绪 — 能代你打开会话并回复' : '回复需要它:靠它把会话切出来、把字打进去',
      done: report.accessibility },
  ];
  // 每个聊天 app 的通知样式:样式=提醒 才留得住、读得到;横幅会自动消失。
  // 这一段是真检测,不是泛泛提示 —— 直接点名哪个 app 设错了。
  let notif = [];
  try { notif = await (T.messagesNotificationSettings ? T.messagesNotificationSettings() : []); } catch (e) {}
  // 只有一个能站得住的判断:这个 app 的通知我们**确实**读到过没有(它有没有
  // 在 record 表里出现过)。macOS 不给可靠的"横幅/提醒"样式位,所以不谎报 ——
  // 读到过=绿;没读到过=黄色提示"若收不到就把样式设成提醒",绝不红着脸冤枉人。
  notif.forEach(n => {
    const ok = n.persists;
    rows.push({
      key: 'notifications', app_id: n.app_id, dot: ok ? 'ok' : (n.allowed ? 'info' : 'bad'),
      name: n.app_name + ' 消息读取',
      desc: ok ? '已确认 — 它的通知能被读到并显示'
          : (n.allowed
              ? '还没读到它的消息。如果它有新消息却没出现在这里,把 系统设置→通知→' + n.app_name + ' 的样式设成「提醒」(横幅会自动消失、留不住)'
              : '通知没开。先在 系统设置→通知 里允许它,再把样式设成「提醒」'),
      done: ok });
  });
  const esc = (x) => String(x).replace(/</g,'&lt;');
  host.innerHTML = rows.map(r => `
    <div class="perm-row">
      <span class="perm-dot ${r.dot === 'ok' ? 'ok' : (r.dot === 'info' ? 'info' : '')}"></span>
      <div class="perm-txt"><div class="perm-name">${esc(r.name)}</div>
        <div class="perm-desc">${esc(r.desc)}</div></div>
      <button class="perm-btn ${r.done ? 'done' : ''}" data-k="${r.key}">${r.done ? '已就绪' : '去设置'}</button>
    </div>`).join('');
  host.querySelectorAll('.perm-btn').forEach(b => {
    if (b.classList.contains('done')) return;
    b.addEventListener('click', () => {
      try { T.messagesOpenSettings && T.messagesOpenSettings(b.dataset.k); } catch (e) {}
    });
  });
}

async function msgsRefresh() {
  try {
    let report = { fullDiskAccess: false, accessibility: false };
    try { report = await (T.messagesPermissionReport ? T.messagesPermissionReport() : report); } catch (e) {}
    const st = await (T.messagesStatus ? T.messagesStatus() : null);
    // 通知样式不算"缺权限":读不到某个 app 可能只是它最近没消息。
    // 面板始终显示清单,但只有真缺 FDA/辅助功能时才当成"必须处理"。
    const needPerm = !report.fullDiskAccess || !report.accessibility
                  || (st && st.available === false && st.reason !== 'no_database');
    $('#msgsPerm')?.classList.remove('hidden');   // 清单常驻:随时能看状态、去设置
    msgsRenderPerms(report);
    if (st && !st.available) { msgsAll = []; msgsRenderTabs(); msgsRenderList(); msgsRenderApps(); return; }
    const list = await T.messagesRecent(120, true);
    msgsAll = Array.isArray(list) ? list : [];
    msgsRenderTabs(); msgsRenderList(); msgsRenderApps();
    const b = $('#sbMsgBadge');
    if (b) { b.textContent = String(msgsAll.length); b.classList.toggle('hidden', !msgsAll.length); }
  } catch (e) { /* 读不到就保持空,不编内容 */ }
}

let msgsWired = false;
function msgsInit() {
  if (!msgsWired) {
    msgsWired = true;
    $('#msgsRefresh')?.addEventListener('click', msgsRefresh);
    $('#msgsPermRefresh')?.addEventListener('click', msgsRefresh);
  }
  msgsRefresh();
  clearInterval(msgsTimer);
  msgsTimer = setInterval(msgsRefresh, 10000);
}

const SB_ACTIONS = {
  overview: () => show('sessions'),
  cleanup:  () => { show('cleanup'); if (!clState.scanned) clScan(); },
  alerts:   () => T.navigateToAlerts && T.navigateToAlerts(),
  settings: () => show('settings'),
  doctor:   () => $('#btnDoctor').click(),
  stats:    () => T.navigateToStats(),
  history:  () => T.navigateToHistory && T.navigateToHistory(),
  wallpaper:() => T.navigateToWallpaper && T.navigateToWallpaper(),
  projects: () => T.navigateToProjects && T.navigateToProjects(),
  team:     () => T.navigateToCowork && T.navigateToCowork(),
  farm:     () => T.navigateToFarm ? T.navigateToFarm() : (T.showFarmWindow && T.showFarmWindow()),
  graph:    () => T.navigateToGraph && T.navigateToGraph(),
  boost:    () => { show('boost'); refreshBoost(); },
  prompts:  () => { show('prompts'); promptsInit(); },
  observe:  () => { show('observe'); observeInit(); },
  msgs:     () => { show('msgs'); msgsInit(); },
  mcp:      () => { show('mcp'); mcpInit(); },
  rules:    () => { show('rules'); rulesInit(); },
  connection: () => { show('connection'); connInit(); },
  island:   () => { show('island'); islPermInit(); },
  friends:  () => { show('friends'); friendsInit(); },
  room:     () => { show('room'); roomInit(); },
  plaza:    () => { show('plaza'); plazaInit(); },
  pals:     () => $('#btnPalsTitle')?.click(),
};
// Pro-only destinations. Clicking one on the free tier is the strongest upsell
// moment ("hitting a wall") — we open the trial sheet framed by that feature's
// benefit instead of navigating. `is-free` is kept current by refreshUpgradeCta().
// 两类 Pro 页面,区别在于"让人看见"会不会等于"把功能送出去"。
//
// PREVIEW:扫描/诊断本身就是免费该给的价值 —— 让人看见自己有 3.2G 可清理、
//   哪个 agent 连不上,正是最有说服力的一刻;真正的动作(执行清理、一键修复、
//   开加速)各自带了闸门,所以放人进来看是安全的。
// BLOCKED:统计和团队这两页,"看" 本身就是那个功能。开放浏览等于白送,
//   所以仍然拦下来,只是把文案换成针对这一个功能的说明。
const PRO_PREVIEW_PAGES = {
  boost:      'pro_gate_boost',
  cleanup:    'pro_gate_cleanup',
  connection: 'pro_gate_connection',
};
const PRO_BLOCKED_PAGES = {
  team:       'pro_gate_team',
  stats:      'pro_gate_stats',
};
$$('.sb-item').forEach(b => b.addEventListener('click', () => {
  const page = b.dataset.page;
  // 免费用户点 Pro 页:让他进去看。
  //
  // 以前这里直接弹付费墙、根本不导航 —— 于是"这个功能到底给我什么"永远没有
  // 答案,只剩一堵墙。现在页面照常打开,顶部挂一条说明这一页 Pro 会做什么的
  // 横幅;真正的动作(开加速、执行清理、一键修复)各自有自己的闸门,所以
  // 放人进来看不等于把功能送出去。
  const free = document.body.classList.contains('is-free');
  if (free && PRO_BLOCKED_PAGES[page]) { openPaywall(TT(PRO_BLOCKED_PAGES[page])); return; }
  proPreviewPage = (free && PRO_PREVIEW_PAGES[page]) ? page : null;
  // 试用期里(此时 is-free 还没挂上)真正打开过的 Pro 页面 —— 到期时用得上
  if (!free) markTrialFeatureUsed(page);
  // Same-frame feedback: highlight instantly; for cross-page navigations also
  // dim the pane so the click visibly registered before the new page loads.
  if (page !== 'pals') $$('.sb-item').forEach(x => x.classList.toggle('active', x === b));
  if (['doctor', 'stats', 'team', 'alerts', 'history', 'farm', 'wallpaper', 'graph'].includes(page)) document.body.classList.add('navigating');
  SB_ACTIONS[page]?.();
  // 页面切换是同步的,等一帧让新页可见再挂横幅
  setTimeout(renderProPreviewBanner, 0);
}));

// Entry point for out-of-window callers (alert toasts) — routes through the same
// sidebar handler so Pro gating and the active-item highlight stay consistent.
window.__terseOpenPage = (page) => {
  const btn = document.querySelector(`.sb-item[data-page="${page}"]`);
  if (btn) btn.click(); else SB_ACTIONS[page]?.();
};

// Small i18n helper that falls back to English text if the key/dict is missing.
function TT(key) {
  const map = {
    pro_gate_boost:      'Speed Up is a Pro feature. Start your free trial to cut your agent bill.',
    pro_prev_cta:        'Unlock',
    trial_preview_tier:  'Free preview',
    trial_min_left:      'min left · enjoy Terse',
    trial_sec_left:      'sec left · Pro ends shortly',
    trial_warn_5m:       '5 minutes left of your free Pro preview',
    trial_warn_1m:       '1 minute left — Pro features are about to lock',
    trial_end_title:     'Your Pro preview ended',
    trial_end_used:      'You just used:',
    trial_end_saved_a:   'and saved',
    trial_end_saved_b:   'tokens today.',
    trial_f_boost:       'Speed Up',
    trial_f_cleanup:     'Cleanup',
    trial_f_conn:        'Connection Doctor',
    trial_f_stats:       'Statistics',
    trial_f_team:        'Team',
    trial_f_wall:        'Live Wallpaper',
    trial_f_doctor:      'Checkup',
    trial_f_graph:       'Knowledge Graph',
    fvm_saved_label:     'tokens saved this week',
    fvm_sub_a:           'Terse trimmed',
    fvm_sub_b:           'of your prompts. Pro auto-trims every one.',
    fvm_sub_none:        'Pro auto-trims every prompt before it is sent.',
    pro_gate_cleanup:    'Cleanup is a Pro feature. Start your free trial to reclaim wasted tokens & disk.',
    pro_gate_team:       'Team is a Pro feature. Start your free trial to watch every agent together.',
    pro_gate_optimize:   'Live optimization is Pro. Start your free trial to auto-trim every prompt.',
    pro_gate_stats:      'Stats is a Pro feature. Start your free trial to see where your tokens go.',
    pro_gate_connection: 'Connection Doctor is a Pro feature. Start your free trial to auto-fix agent connectivity.',
    pro_gate_autoapprove: 'Auto-approve is a Pro feature. Start your free trial to let Terse answer permission prompts for you.',
    pro_gate_island_perm: 'Island permission control is a Pro feature. Start your free trial to answer Claude\'s prompts from the Dynamic Island.',
    // Friends / invite — toasts and status lines, which never sit in the DOM
    // long enough for the English-text matcher to catch them.
    fr_copied: 'Invite link copied',
    fr_join_empty: 'Paste a code first.',
    fr_joining: 'Joining…',
    fr_joined: 'Joined ✓',
    fr_wall_on: 'Friends will show on your wallpaper',
    fr_wall_off: 'Wallpaper is back to just you',
    rm_created: 'Room created — share the code',
    rm_joined: 'You are in the room',
    rm_left: 'You left the room',
    rm_copied: 'Room link copied',
    rm_need_code: 'Enter a room code first.',
    rm_sent_hint: 'Link copied — paste it to your friend in any chat.',
    // Recent rooms + Plaza. These are built in JS, so the English-text matcher
    // in i18n never sees them sitting in the DOM long enough to swap them.
    rm_rejoin: 'Rejoin', rm_you_here: 'You are here', rm_untitled: 'Untitled room',
    rm_yours: 'yours', rm_member_of: 'you are a member',
    rm_online_n: '{n} online', rm_members_n: '{n} members', rm_member_1: '1 member',
    rm_room_closed: 'That room has been closed by its owner',
    rm_nick_saved: 'Nickname saved — everyone in the room sees it now',
    rm_listed_no: 'This room is private — only people you send the code to can get in.',
    rm_listed_yes: 'Listed on the Plaza — anyone can find it and ask to join, and you decide who comes in.',
    rm_publish: 'Publish to the Plaza', rm_unpublish: 'Remove from the Plaza',
    rm_published: 'Listed on the Plaza — people can now ask to join.',
    rm_unpublished: 'Unlisted. Only the code gets people in now.',
    pz_cat_all: 'all', pz_cat_coding: 'coding', pz_cat_study: 'study', pz_cat_work: 'work',
    pz_cat_gaming: 'gaming', pz_cat_chat: 'chat', pz_cat_other: 'other',
    pz_ask: 'Ask to join', pz_open_yours: 'Open yours',
    pz_looking: 'Looking…', pz_asked: 'Asked',
    pz_offline: 'Could not reach the Plaza. Check your connection and refresh.',
    pz_waiting: 'Waiting for the owner to let you in…',
    pz_nobody_home: 'Asked — but nobody is in that room right now. Only its owner can let you in, so this stays pending until they are back.',
    pz_denied: 'The owner declined.', pz_entering: 'You are in — opening the room.',
    pz_empty: 'No public rooms yet.', pz_empty_cat: 'No public rooms in this category yet.',
    pz_empty_hint: 'A room is private until its owner lists it —',
    pz_empty_cta: 'start one', pz_empty_tail: 'and tick “List it on the Plaza”.',
    pz_knock_queue: '{n} waiting to join your room — answer on the Room page.',
  };
  const en = map[key] || key;
  try { return (window.i18n && window.i18n.t) ? (window.i18n.t(key) !== key ? window.i18n.t(key) : en) : en; }
  catch { return en; }
}
/** TT with numbers in it. Word order differs per language, so the count is a
    placeholder inside the translated string rather than glued onto its end. */
function TTn(key, n) { return TT(key).replace('{n}', n); }

// ── Prompt Library (提示词) — in-shell panel, same store as the ⌘⇧K palette ──
const PL = { prompts: [], filtered: [], sel: 0, current: null, view: 'list', wired: false };
function plEsc(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function plParseVar(raw){ const name=raw.split(/[=|]/)[0].trim();
  const def = raw.includes('=') ? raw.slice(raw.indexOf('=')+1).trim() : ''; return { name, def }; }
function plFill(body, vals){ return String(body||'').replace(/\{\{([^}]+)\}\}/g,(_,r)=>{ const {name,def}=plParseVar(r); const v=vals[name]; return (v!==undefined&&v!=='')?v:def; }); }
function plPreview(body, vals){ return plEsc(body).replace(/\{\{([^}]+)\}\}/g,(_,r)=>{ const {name,def}=plParseVar(r); const v=vals[name]; const o=(v!==undefined&&v!=='')?v:def; return o?`<mark>${plEsc(o)}</mark>`:`<mark>{{${plEsc(name)}}}</mark>`; }); }
function plShow(v){ PL.view=v; $('#plList').classList.toggle('hidden', v!=='list'); $('#plVars').classList.toggle('hidden', v!=='vars'); $('#plEdit').classList.toggle('hidden', v!=='edit'); }
function plApplyFilter(){
  const term = ($('#plQ').value||'').trim().toLowerCase();
  PL.filtered = !term ? PL.prompts.slice() : PL.prompts.filter(p =>
    (p.title||'').toLowerCase().includes(term) || (p.body||'').toLowerCase().includes(term) ||
    (p.tags||[]).some(t=>t.toLowerCase().includes(term)));
  if (PL.sel >= PL.filtered.length) PL.sel = Math.max(0, PL.filtered.length-1);
  plRender();
}
function plRender(){
  const el = $('#plRows');
  if (!PL.filtered.length){
    el.innerHTML = PL.prompts.length
      ? `<div class="pl-empty">No prompts match.</div>`
      : `<div class="pl-empty">Your prompt library is empty.<br>Press <b>＋ New prompt</b> to save your first reusable prompt.</div>`;
    return;
  }
  el.innerHTML = PL.filtered.map((p,i)=>{
    const nv=(p.variables||[]).length;
    const snip=(p.body||'').replace(/\s+/g,' ').slice(0,72);
    return `<div class="pl-row ${i===PL.sel?'sel':''}" data-i="${i}">
      <div class="pl-ic">📝</div>
      <div class="pl-tx"><div class="pl-rt">${plEsc(p.title||'Untitled')}</div><div class="pl-rs">${plEsc(snip)}</div></div>
      <div class="pl-meta">${nv?`<span class="pl-vtag">${nv} field${nv>1?'s':''}</span>`:''}
        <button class="pl-editb" data-edit="${p.id}" title="Edit">✎</button>
        <button class="pl-del" data-del="${p.id}" title="Delete">✕</button></div>
    </div>`;
  }).join('');
  el.querySelectorAll('.pl-row').forEach(r=>r.addEventListener('click',e=>{
    if(e.target.closest('.pl-del')||e.target.closest('.pl-editb')) return; PL.sel=+r.dataset.i; plChoose(); }));
  el.querySelectorAll('.pl-editb').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation();
    plOpenEdit(PL.prompts.find(p=>p.id===b.dataset.edit)||null); }));
  el.querySelectorAll('.pl-del').forEach(b=>b.addEventListener('click',async e=>{
    e.stopPropagation(); await T.deletePrompt(b.dataset.del); await plLoad(); }));
}
function plChoose(){ PL.current = PL.filtered[PL.sel]; if(!PL.current) return;
  if ((PL.current.variables||[]).length) plOpenVars(); else plUse(PL.current.body); }
function plOpenVars(){
  const c=PL.current, vals={};
  $('#plVarsStage').innerHTML = `<h2>${plEsc(c.title)}</h2><div class="pl-sub">Fill in the fields, then Use.</div>
    ${c.variables.map((n,i)=>`<div class="pl-fld"><label>${plEsc(n)}</label><input class="pl-vin" data-name="${plEsc(n)}" type="text" ${i===0?'autofocus':''} placeholder="${plEsc(n)}"></div>`).join('')}
    <div class="pl-fld"><label>Preview</label><div class="pl-prev" id="plPrev"></div></div>`;
  plShow('vars');
  const inputs=[...document.querySelectorAll('.pl-vin')];
  const upd=()=>{ inputs.forEach(i=>vals[i.dataset.name]=i.value); $('#plPrev').innerHTML=plPreview(c.body,vals); };
  inputs.forEach(i=>i.addEventListener('input',upd)); upd(); inputs[0]?.focus();
  $('#plVarsUse').onclick=()=>{ inputs.forEach(i=>vals[i.dataset.name]=i.value); plUse(plFill(c.body,vals)); };
  $('#plVarsBack').onclick=()=>{ plShow('list'); $('#plQ').focus(); };
}
// "Use" in the main window: drop the (filled) prompt into the optimizer input,
// copy it to the clipboard, and switch to Overview so it's one click to optimize.
async function plUse(text){
  if (PL.current?.id && T.recordPromptUse) T.recordPromptUse(PL.current.id);
  try { await navigator.clipboard.writeText(text); } catch(_){}
  const box = $('#manualInput');
  if (box){ box.value = text; }
  show('sessions');
  if (box){ box.focus(); box.scrollIntoView({block:'center'}); box.classList.add('pl-flash'); setTimeout(()=>box.classList.remove('pl-flash'),700); }
}
function plOpenEdit(p){
  PL.current = p || null;
  $('#plEditTitle').textContent = p ? 'Edit prompt' : 'New prompt';
  $('#plETitle').value = p?.title || ''; $('#plEBody').value = p?.body || '';
  $('#plETags').value = (p?.tags||[]).join(', ');
  $('#plEditDelete').classList.toggle('hidden', !p);
  plShow('edit'); setTimeout(()=>$('#plETitle').focus(),20);
}
async function plLoad(){ const r = await T.listPrompts().catch(()=>({prompts:[]})); PL.prompts = r.prompts||[]; PL.sel=0; plApplyFilter(); }
function promptsInit(){
  plShow('list');
  if (!PL.wired){
    PL.wired = true;
    $('#plQ').addEventListener('input',()=>{ PL.sel=0; plApplyFilter(); });
    $('#plNew').addEventListener('click',()=>plOpenEdit(null));
    $('#plVarsBack')?.addEventListener('click',()=>{ plShow('list'); $('#plQ').focus(); });
    $('#plEditBack').addEventListener('click',()=>{ plShow('list'); $('#plQ').focus(); });
    $('#plEditSave').addEventListener('click',async()=>{
      const body=$('#plEBody').value; if(!body.trim() && !$('#plETitle').value.trim()){ plShow('list'); return; }
      await T.savePrompt({ id: PL.current?.id||'', title:$('#plETitle').value, body,
        tags:$('#plETags').value.split(',').map(t=>t.trim()).filter(Boolean) });
      await plLoad(); plShow('list'); $('#plQ').focus();
    });
    $('#plEditDelete').addEventListener('click',async()=>{ if(PL.current?.id){ await T.deletePrompt(PL.current.id); await plLoad(); } plShow('list'); $('#plQ').focus(); });
    // keyboard nav while the list is visible
    $('#promptsView').addEventListener('keydown',e=>{
      if (PL.view!=='list') return;
      if (e.key==='ArrowDown'){ e.preventDefault(); PL.sel=Math.min(PL.filtered.length-1,PL.sel+1); plRender(); }
      else if (e.key==='ArrowUp'){ e.preventDefault(); PL.sel=Math.max(0,PL.sel-1); plRender(); }
      else if (e.key==='Enter'){ e.preventDefault(); plChoose(); }
    });
  }
  plLoad().then(()=>$('#plQ').focus());
}

// Re-run the i18n DOM walk so freshly-rendered (JS-generated) leaf text in the
// new panels gets translated too — the initial page-load pass can't see it.
function applyI18n(){ try { window.i18n && window.i18n.applyTranslations && window.i18n.applyTranslations(); } catch(e){} }

// ── Observe · Session Timeline + replay ──────────────────────────────────
const roleGlyph = { user: '🧑', assistant: '🤖', tool: '⚙' };
let obWired = false;
async function observeInit(){
  if (!obWired){
    obWired = true;
    $('#obSearch').addEventListener('input', e => obRenderSteps(e.target.value));
    $('#obRefresh').addEventListener('click', observeInit);
    $('#obExport').addEventListener('click', async ()=>{
      const btn = $('#obExport'); const old = btn.textContent; btn.textContent = 'Exporting…'; btn.disabled = true;
      try { const p = await T.exportSessionReplay(); btn.textContent = '✓ Saved to Downloads';
        setTimeout(()=>{ btn.textContent = old; btn.disabled = false; }, 2200); }
      catch(e){ btn.textContent = 'No session'; setTimeout(()=>{ btn.textContent = old; btn.disabled = false; }, 1800); }
    });
  }
  const box = $('#obSteps');
  box.innerHTML = '<div class="ob-empty">Loading timeline…</div>';
  let tl; try { tl = await T.getSessionTimeline(); } catch(e){ tl = null; }
  const steps = (tl && tl.steps) || [];
  if (!steps.length){
    box.innerHTML = '<div class="ob-empty">No active session. Start Claude Code, Cursor, Codex, or DeepSeek Harness and its every step shows up here — with per-step token cost.</div>';
    $('#obSub').textContent = 'Live step-by-step trace of your agent';
    applyI18n();
    return;
  }
  $('#obTitle').textContent = (tl.agentName || 'Session') + (tl.project ? ' · ' + tl.project : '');
  $('#obSub').textContent = `${tl.totalSteps} steps · ${(tl.totalTokens||0).toLocaleString()} tokens${tl.model ? ' · '+tl.model : ''}`;
  // Per-session quality flags (Control) — reuse loop/dup/cache detection.
  const q = tl.quality || {}; const flags = [];
  if (q.looping) flags.push(['red','🔁 looping — '+q.duplicateCalls+' duplicate calls']);
  else if (q.duplicateCalls) flags.push(['amber','🔁 '+q.duplicateCalls+' duplicate calls']);
  if (q.lowCache) flags.push(['amber','💸 cache '+q.cacheEfficiency+'%']);
  if (q.redundantReads) flags.push(['amber','📄 '+q.redundantReads+' re-read files']);
  if (!flags.length) flags.push(['ok','✓ no loops or waste detected']);
  const qbar = document.getElementById('obQuality') || (()=>{ const d=document.createElement('div'); d.id='obQuality'; d.className='ob-quality'; $('#obSearch').before(d); return d; })();
  qbar.innerHTML = flags.map(([s,t])=>`<span class="obq ${s}">${plEsc(t)}</span>`).join('');
  // Diff attribution — which files this session touched (from Edit/Write tool calls).
  obAllSteps = steps;
  const EDIT_TOOLS = /edit|write|create|update|notebook/i;
  const pathRe = /(?:file_path|path|filename)["'\s:=]+["']?([\/~][^\s"'`,)]+)/i;
  const touched = {};
  steps.forEach(s=>{ if (s.toolName && EDIT_TOOLS.test(s.toolName)){ const m = (s.text||'').match(pathRe); if (m){ const f = m[1].split('/').pop(); touched[f] = (touched[f]||0)+1; } } });
  const files = Object.entries(touched).sort((a,b)=>b[1]-a[1]);
  $('#obFiles').innerHTML = files.length ? '<span class="obf-lbl">Files touched:</span>' + files.map(([f,n])=>`<span class="obf">${plEsc(f)}${n>1?` ·${n}`:''}</span>`).join('') : '';
  obRenderSteps($('#obSearch').value || '');
  box.scrollTop = box.scrollHeight;
}
let obAllSteps = [];
function obRenderSteps(filter){
  const box = $('#obSteps'); const f = (filter||'').trim().toLowerCase();
  const rows = obAllSteps.filter(s => !f || (s.text||'').toLowerCase().includes(f) || (s.toolName||'').toLowerCase().includes(f) || (s.role||'').includes(f));
  if (!rows.length){ box.innerHTML = '<div class="ob-empty">No steps match "'+plEsc(filter)+'".</div>'; return; }
  box.innerHTML = rows.map(s=>{
    const label = s.toolName ? `${s.role} · ${s.toolName}` : (s.type ? `${s.role} · ${s.type}` : s.role);
    return `<div class="ob-step ${plEsc(s.role)}">
      <div class="ob-gutter">${roleGlyph[s.role]||'•'}</div>
      <div class="ob-body">
        <div class="ob-meta"><span class="ob-role">${plEsc(label)}</span>
          <span class="ob-cost">${(s.tokens||0).toLocaleString()} tok · $${(s.cost||0).toFixed(3)}</span></div>
        <div class="ob-text">${plEsc((s.text||'').slice(0,600))}</div>
      </div></div>`;
  }).join('');
  applyI18n();
}

// ── MCP Manager · discover + risk-score tool servers ─────────────────────
let mcpWired = false;
function riskColor(lvl){ return lvl==='high' ? '#ff6b6b' : lvl==='medium' ? '#ffb648' : '#8ad06a'; }
async function mcpInit(){
  if (!mcpWired){ mcpWired = true; $('#mcpRefresh').addEventListener('click', mcpInit); }
  const list = $('#mcpList'); list.innerHTML = '<div class="ob-empty">Scanning MCP configs…</div>';
  let data; try { data = await T.mcpList(); } catch(e){ data = null; }
  const servers = (data && data.servers) || [], sum = (data && data.summary) || {};
  const pill = $('#sbMcpPill');
  if (pill){ if (sum.high){ pill.textContent = sum.high; pill.classList.remove('hidden'); } else pill.classList.add('hidden'); }
  $('#mcpSub').textContent = servers.length
    ? `${sum.total} servers · ${sum.remote} remote · ${sum.withSecrets} hold secrets`
    : 'Audit every configured tool server';
  $('#mcpSummary').innerHTML = servers.length ? `
    <div class="mcp-stat"><b style="color:#ff6b6b">${sum.high||0}</b><span>high risk</span></div>
    <div class="mcp-stat"><b style="color:#ffb648">${sum.medium||0}</b><span>medium</span></div>
    <div class="mcp-stat"><b style="color:#8ad06a">${sum.low||0}</b><span>low</span></div>
    <div class="mcp-stat"><b>${sum.enabled||0}</b><span>enabled</span></div>` : '';
  if (!servers.length){
    list.innerHTML = '<div class="ob-empty">No MCP servers found in Claude Code, Cursor, or Windsurf configs. When you add tool servers, Terse audits their permissions and flags risky ones here.</div>';
    applyI18n();
    return;
  }
  list.innerHTML = servers.map(s=>`
    <div class="mcp-row ${s.enabled?'':'off'}">
      <div class="mcp-dot" style="background:${riskColor(s.riskLevel)}"></div>
      <div class="mcp-main">
        <div class="mcp-name">${plEsc(s.name)} <span class="mcp-src">${plEsc(s.source)}</span>
          ${s.transport!=='stdio'?`<span class="mcp-tag">${plEsc(s.transport)}</span>`:''}
          ${s.envKeys && s.envKeys.length?`<span class="mcp-tag secret">🔑 ${s.envKeys.length}</span>`:''}</div>
        <div class="mcp-cmd">${plEsc((s.command||'').slice(0,90))}</div>
        <div class="mcp-reasons">${(s.reasons||[]).slice(0,3).map(r=>`<div>• ${plEsc(r)}</div>`).join('')}</div>
      </div>
      <div class="mcp-right">
        <div class="mcp-risk" style="color:${riskColor(s.riskLevel)}">${s.risk}<span>/100</span></div>
        <label class="mcp-toggle"><input type="checkbox" ${s.enabled?'checked':''}
          data-sp="${plEsc(s.sourcePath)}" data-nm="${plEsc(s.name)}"><span></span></label>
      </div>
    </div>`).join('');
  list.querySelectorAll('.mcp-toggle input').forEach(cb=>cb.addEventListener('change', async e=>{
    const t = e.target; t.disabled = true;
    try { await T.mcpSetEnabled(t.dataset.sp, t.dataset.nm, t.checked); t.closest('.mcp-row').classList.toggle('off', !t.checked); }
    catch(err){ t.checked = !t.checked; }
    t.disabled = false; mcpInit();
  }));
  applyI18n();
}

// ── Rules / Memory Manager · edit + compress CLAUDE.md ───────────────────
let rulesWired = false, rulesCur = null;
function rulesTokens(s){ return Math.round((s||'').length / 4); }
async function rulesInit(){
  if (!rulesWired){
    rulesWired = true;
    $('#rulesRefresh').addEventListener('click', rulesInit);
    $('#rulesClose').addEventListener('click', ()=>{ $('#rulesEditor').classList.add('hidden'); });
    $('#rulesSave').addEventListener('click', async ()=>{
      if (!rulesCur) return; const btn = $('#rulesSave'); btn.textContent='Saving…'; btn.disabled=true;
      try { await T.claudeMdWrite(rulesCur, $('#rulesEdText').value); btn.textContent='✓ Saved'; }
      catch(e){ btn.textContent='Failed'; }
      setTimeout(()=>{ btn.textContent='Save'; btn.disabled=false; rulesInit(); }, 1200);
    });
    $('#rulesCompress').addEventListener('click', async ()=>{
      const ta = $('#rulesEdText'); const btn = $('#rulesCompress'); const before = ta.value;
      if (!before.trim() || !T.optimizeText) return;
      btn.textContent='⚡ Compressing…'; btn.disabled=true;
      try {
        const r = await T.optimizeText(before);
        const out = (r && (r.optimized || r.text)) || (typeof r === 'string' ? r : before);
        ta.value = out;
        const saved = rulesTokens(before) - rulesTokens(out);
        $('#rulesEdStat').textContent = `${rulesTokens(out)} tokens · saved ~${Math.max(0,saved)}`;
        btn.textContent = saved>0 ? `⚡ −${saved} tok (review & Save)` : '⚡ Compress';
      } catch(e){ btn.textContent='⚡ Compress'; }
      btn.disabled=false;
      setTimeout(()=>{ btn.textContent='⚡ Compress'; }, 2600);
    });
    $('#rulesEdText').addEventListener('input', ()=>{ $('#rulesEdStat').textContent = `${rulesTokens($('#rulesEdText').value)} tokens`; });
  }
  const box = $('#rulesFiles');
  box.innerHTML = '<div class="ob-empty">Scanning CLAUDE.md files…</div>';
  let data; try { data = await T.claudeMdList(); } catch(e){ data = null; }
  const files = (data && data.files) || [];
  if (!files.length){ box.innerHTML = '<div class="ob-empty">No CLAUDE.md files found. Create one in a project (or ~/.claude/CLAUDE.md) to give your agents persistent rules — Terse audits their always-on token cost here.</div>'; applyI18n(); return; }
  const totalTok = files.reduce((s,f)=>s+(f.tokens||0),0);
  $('#rulesSub').textContent = `${files.length} files · ~${fmtNum(totalTok)} always-on tokens every turn`;
  box.innerHTML = files.map(f=>`
    <div class="rules-row" data-path="${plEsc(f.path)}">
      <div class="rules-main">
        <div class="rules-name">${plEsc(f.name||'CLAUDE.md')} <span class="mcp-src">${plEsc(f.scope)}</span></div>
        <div class="mcp-cmd">${plEsc(f.path)}</div>
      </div>
      <div class="rules-tok ${f.tokens>2000?'heavy':''}">${fmtNum(f.tokens||0)}<span>tok</span></div>
    </div>`).join('');
  applyI18n();
  box.querySelectorAll('.rules-row').forEach(r=>r.addEventListener('click', async ()=>{
    rulesCur = r.dataset.path;
    let txt=''; try { txt = await T.claudeMdRead(rulesCur); } catch(e){ txt=''; }
    $('#rulesEdPath').textContent = rulesCur;
    $('#rulesEdText').value = txt;
    $('#rulesEdStat').textContent = `${rulesTokens(txt)} tokens`;
    $('#rulesEditor').classList.remove('hidden');
    $('#rulesEditor').scrollIntoView({ behavior:'smooth', block:'nearest' });
  }));
}

// ── Connection Doctor · detect + auto-fix agent connectivity ─────────────
let connWired = false;
const connIcon = { ok: '✓', warn: '!', fail: '✕' };
function connRender(data){
  const list = $('#connList');
  const checks = (data && data.checks) || [];
  $('#connSub').textContent = data && data.status === 'ok'
    ? 'All connection checks passed'
    : `${data.fails||0} failing · ${data.warns||0} warnings${data.fixable?` · ${data.fixable} auto-fixable`:''}`;
  const pill = $('#sbConnPill');
  if (pill){ if (data && (data.fails||0) > 0){ pill.classList.remove('hidden'); } else pill.classList.add('hidden'); }
  $('#connFixAll').style.display = (data && data.fixable > 0) ? '' : 'none';
  list.innerHTML = checks.map(c=>`
    <div class="conn-row ${plEsc(c.status)}">
      <div class="conn-ic ${plEsc(c.status)}">${connIcon[c.status]||'•'}</div>
      <div class="conn-main">
        <div class="conn-label">${plEsc(c.label)}</div>
        <div class="conn-detail">${plEsc(c.detail)}</div>
        ${c.suggestion ? `<div class="conn-sugg">💡 ${plEsc(c.suggestion)}</div>` : ''}
      </div>
      ${c.fixable && c.status!=='ok' ? '<div class="conn-tag">auto-fixable</div>' : ''}
    </div>`).join('');
  applyI18n();
}
async function connInit(){
  if (!connWired){
    connWired = true;
    $('#connRescan').addEventListener('click', connInit);
    $('#connFixAll').addEventListener('click', async ()=>{
      // 诊断免费,修复是 Pro —— 看得见问题正是最有说服力的一刻。
      if (!(await ensurePro(TT('pro_gate_connection')))) return;
      const btn = $('#connFixAll'); const old = btn.textContent; btn.textContent = '🛠 Fixing…'; btn.disabled = true;
      $('#connBanner').classList.add('hidden');
      let r; try { r = await T.connectivityFixAll(); } catch(e){ r = null; }
      btn.disabled = false; btn.textContent = old;
      if (r){
        const banner = $('#connBanner');
        const acts = (r.actions||[]);
        const remaining = (r.remaining||[]).filter(c=>c.status!=='ok');
        banner.classList.remove('hidden');
        banner.className = 'conn-banner ' + (remaining.some(c=>c.status==='fail') ? 'warn' : 'ok');
        banner.innerHTML = `<b>${(r.fixed||[]).length ? '✓ Fixed: '+r.fixed.join(', ') : 'Ran repairs'}</b>` +
          (acts.length ? '<div>'+acts.map(a=>'• '+a).join('<br>')+'</div>' : '') +
          (remaining.length ? `<div style="margin-top:6px;opacity:.85">Still needs you: ${remaining.map(c=>c.label).join(', ')} — see suggestions below.</div>` : '<div style="margin-top:6px">Connection restored. Relaunch your agent if it was stuck.</div>');
        connRender({ checks: r.checks, fails: remaining.filter(c=>c.status==='fail').length, warns: remaining.filter(c=>c.status==='warn').length, fixable: remaining.filter(c=>c.fixable).length, status: remaining.length?'warn':'ok' });
      }
    });
  }
  $('#connList').innerHTML = '<div class="ob-empty">Checking connection…</div>';
  $('#connBanner').classList.add('hidden');
  let data; try { data = await T.connectivityScan(); } catch(e){ data = null; }
  if (!data){ $('#connList').innerHTML = '<div class="ob-empty">Could not run connection checks.</div>'; return; }
  connRender(data);
}

// ── Alerts sidebar badge — reflects unread count from the Alert Center ──
async function refreshAlertBadge() {
  const pill = $('#sbAlertPill');
  if (!pill || !T.getRecentAlerts) return;
  try {
    const r = await T.getRecentAlerts();
    const n = (r && r.unread) || 0;
    pill.textContent = n > 99 ? '99+' : String(n);
    pill.classList.toggle('hidden', n === 0);
  } catch (e) { /* non-fatal */ }
}
refreshAlertBadge();
// A newly dispatched alert bumps the badge without a poll.
T.on && T.on('alert', () => refreshAlertBadge());
// ⌘⇧K (or the menu-bar item) opens the Prompt Library panel in this window.
T.on && T.on('open-prompts', () => { show('prompts'); promptsInit(); });

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
  // 扫描免费(先让他们看见自己有多少可回收的东西),真正删除是 Pro。
  if (!(await ensurePro(TT('pro_gate_cleanup')))) return;
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
  // 打开是 Pro 动作。以前这里没有任何检查 —— 唯一的保护是免费用户进不了这一页,
  // 现在页面开放预览了,闸门必须落在这里。关掉永远放行:不能把人锁在开着的状态。
  if (on && !(await ensurePro(TT('pro_gate_boost')))) { e.target.checked = false; return; }
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

/* ── 灵动岛授权 · Island permission control page ────────────────────────────
   One controller for the whole page: the switch, what the gate has learned, the
   auto-approve modes and the recent log. Previously this lived in two places —
   a sidebar chip and a Settings row — which duplicated the enable/disable logic
   and still had nowhere to show what the feature was actually doing.

   Default OFF, and lib.rs forces it off on every launch: enabling installs a
   PreToolUse hook into ~/.claude/settings.json, which sits in the agent's
   critical path, and that must never be inherited from a click weeks ago. */
let islPermWired = false;
async function islPermInit() {
  const T2 = window.__TAURI__;
  if (!T2) return;
  const invoke = T2.core.invoke;
  const toggle = $('#islPermToggle');
  const tag    = $('#sbIslandPermState');

  const paintTag = (on) => {
    if (!tag) return;
    tag.textContent = on ? 'ON' : 'OFF';
    tag.style.background = on ? 'var(--btn)' : 'var(--sf)';
    tag.style.color = on ? 'var(--btn-t)' : 'var(--t3)';
  };

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  async function refresh() {
    let on = false;
    try { on = await invoke('permission_control_status'); } catch {}
    if (toggle) toggle.checked = !!on;
    paintTag(!!on);

    // What the gate has actually learned. This is the page's real content: it
    // is the only honest answer to "why did/didn't the island ask me?".
    let learned = [];
    try { learned = await invoke('permission_learned') || []; } catch {}
    const box = $('#islPermLearned');
    const cnt = $('#islPermCount');
    if (cnt) cnt.textContent = learned.length ? `(${learned.length})` : '';
    if (box) {
      box.innerHTML = learned.length
        ? learned.slice().reverse().map(k =>
            `<div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:5px 8px">
               <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--t1)">${esc(k)}</span>
             </div>`).join('')
        : `<p style="font-size:11px;color:var(--t3);margin:4px 0 0">
             Nothing yet. The next time Claude Code asks you to approve a command in the terminal,
             it will be listed here — and from then on that command comes to the island.
           </p>`;
    }

    let log = [];
    try { log = await invoke('permission_recent_log') || []; } catch {}
    const lg = $('#islPermLog');
    if (lg) {
      lg.innerHTML = log.length
        ? log.slice(-14).reverse().map(l => `<div style="padding:2px 8px;color:var(--t3)">${esc(l)}</div>`).join('')
        : `<p style="font-size:11px;color:var(--t3);margin:4px 0 0">No activity yet.</p>`;
    }
  }

  if (!islPermWired) {
    islPermWired = true;
    toggle?.addEventListener('change', async () => {
      // Pro gate. Answering prompts from the island installs a PreToolUse hook
      // into every Claude Code session on the machine, which is the paid
      // capability — so it goes through the same openPaywall path as every other
      // Pro destination rather than being a free switch.
      if (document.body.classList.contains('is-free')) {
        toggle.checked = false;              // never leave a Pro state selected
        openPaywall(TT('pro_gate_island_perm'));
        return;
      }
      const want = toggle.checked;
      try {
        await invoke('set_permission_control', { enabled: want });
        paintTag(want);
        // The backend clears auto-approve when the island is switched on; mirror
        // that here so the page never shows a stale "Always allow".
        window.__islPaintAutoState?.();
        window.showToast?.(want
          ? '灵动岛授权已开启 — 对所有正在运行的 Claude Code 会话立即生效'
          : '灵动岛授权已关闭 — 已从所有会话中移除');
        refresh();
      } catch (e) {
        toggle.checked = !want;
        window.showToast?.(String(e));
      }
    });
    $('#islPermRefresh')?.addEventListener('click', refresh);
    $('#islPermForget')?.addEventListener('click', async () => {
      if (!(await tconfirm('清除已学会的命令？', '下次它们会先回到终端询问一次。', 'Clear'))) return;
      try { await invoke('permission_forget_learned'); } catch (e) { window.showToast?.(String(e)); }
      refresh();
    });

    // ── Auto-approve — Pro, and mutually exclusive with the island switch ────
    // Pressing the button for the user is the same reach as bypass mode, so it
    // sits behind the same gate as every other Pro destination rather than being
    // a free switch buried in a page.
    const c = $('#autoClaude'), x = $('#autoCodex');
    if (c && x) {
      invoke('get_permission_auto').then((m) => {
        c.value = (m && m.claude) || '';
        x.value = (m && m.codex) || '';
        paintAutoState();
      }).catch(() => {});

      const isFree = () => document.body.classList.contains('is-free');
      // Both on is incoherent: the island asks you to look and decide, auto
      // presses the button anyway. The island wins, so auto is disabled while it
      // is on — shown, not silently ignored, so the state is legible.
      function paintAutoState() {
        const on = $('#islPermToggle')?.checked;
        [c, x].forEach(sel => {
          sel.disabled = !!on;
          sel.style.opacity = on ? '.45' : '';
          sel.title = on ? '灵动岛授权开启时不可用 — 两者互斥' : '';
        });
        const note = $('#islPermAutoNote');
        if (note) note.style.display = on ? 'block' : 'none';
      }
      window.__islPaintAutoState = paintAutoState;

      const save = (sel) => {
        if (isFree()) {
          sel.value = '';                      // never leave a Pro value selected
          openPaywall(TT('pro_gate_autoapprove'));
          return;
        }
        invoke('set_permission_auto', { claude: c.value, codex: x.value })
          .then(() => window.showToast?.('已保存'))
          .catch((e) => window.showToast?.(String(e)));
      };
      c.addEventListener('change', () => save(c));
      x.addEventListener('change', () => save(x));
      // A disabled <select> fires no events, so catch the intent on the wrapper.
      [c, x].forEach(sel => sel.addEventListener('mousedown', (e) => {
        if (isFree()) { e.preventDefault(); openPaywall(TT('pro_gate_autoapprove')); }
      }));
    }
  }
  refresh().then?.(() => window.__islPaintAutoState?.()) ?? window.__islPaintAutoState?.();
}

// Keep the rail's ON/OFF pill honest even before the page is first opened.
(function () {
  if (!window.__TAURI__) return;
  window.__TAURI__.core.invoke('permission_control_status').then((on) => {
    const tag = $('#sbIslandPermState');
    if (!tag) return;
    tag.textContent = on ? 'ON' : 'OFF';
    tag.style.background = on ? 'var(--btn)' : 'var(--sf)';
    tag.style.color = on ? 'var(--btn-t)' : 'var(--t3)';
  }).catch(() => {});
})();

/* ── Liquid glass: real refraction behind the main window ──────────────────
   See liquid-glass.js for why this is not CSS. `html.lg-on` is set only once
   the GL context and a real backdrop are both up, because that class strips the
   existing frosted glass — turning it on speculatively would leave a flat
   transparent shell on a machine without WebGL. */

/* ── Pause decorative animation while the window is unfocused ───────────────
   Pairs with the `body:not(.win-focused)` rule in styles.css. A transparent
   window recomposites continuously (tauri#15471), so an app full of `infinite`
   animations never lets the GPU idle even when it is behind another window and
   nobody can see it. Focus is the honest signal: blurred means unwatched.

   Cheap by construction — two listeners and a class toggle, no polling. */
(function pauseWhenUnfocused() {
  const set = (on) => document.body.classList.toggle('win-focused', on);
  set(document.hasFocus());
  window.addEventListener('focus', () => set(true));
  window.addEventListener('blur', () => set(false));
  // A minimised or fully-occluded window fires neither, so cover it too.
  document.addEventListener('visibilitychange', () => set(!document.hidden && document.hasFocus()));
})();



/* ── Room · the shared wallpaper session ─────────────────────────────────────
   A room is NOT a team and NOT the friends list. It is who you are on the
   wallpaper with right now: created by anyone, entered with a code, left at no
   cost. That is why this page can hand the code to a stranger without any of
   the machinery an invite needs — the code IS the credential.

   The wallpaper owns the live stream (one EventSource per machine, see
   rooms.js); this page reads the cheap REST snapshot when it is open, which is
   also why leaving here takes effect there: both read the same localStorage. */
let roomWired = false;
async function roomInit() {
  const R = window.TerseRooms;
  if (!R) return;
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  /* Every room this install can walk back into. It is drawn whether or not we
     are in one — that is the point of it — and the server is asked as well as
     localStorage, because membership outlives both presence and this browser
     store: a reinstall must not be what destroys the way back into a room you
     own. Rooms you LEFT stay here too; leaving gives up the seat, not the room. */
  async function drawRecent() {
    const box = $('#rmRecent');
    if (!box) return;
    try { await R.mine(); } catch (e) { /* offline: the local list still stands */ }
    const active = R.state() || {};
    const all = Object.values(R.rooms() || {})
      .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
    $('#rmRecentGroup').style.display = all.length ? '' : 'none';
    $('#rmRecentCount').textContent = all.length ? `(${all.length})` : '';
    box.innerHTML = all.map(r => {
      const here = r.id === active.id;
      const bits = [
        r.owner ? TT('rm_yours') : null,
        typeof r.online === 'number' ? TTn('rm_online_n', r.online) : null,
        r.code ? esc(r.code) : null,
      ].filter(Boolean).join(' · ');
      return `
        <div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:7px 8px">
          <span style="width:8px;height:8px;border-radius:50%;background:${r.online ? 'var(--btn)' : 'var(--t3)'}"></span>
          <span>
            <div>${esc(r.name || TT('rm_untitled'))}</div>
            <div style="font-size:10.5px;color:var(--t3)">${bits}</div>
          </span>
          ${here
            ? `<span style="margin-left:auto;font-size:10.5px;color:var(--t3)">${TT('rm_you_here')}</span>`
            : `<button class="ob-btn" style="margin-left:auto;font-size:10.5px;padding:3px 11px"
                       data-enter="${esc(r.id)}">${TT('rm_rejoin')}</button>`}
        </div>`;
    }).join('');
  }

  async function refresh() {
    const inRoom = R.inRoom();
    $('#rmOut')?.classList.toggle('hidden', inRoom);
    $('#rmIn')?.classList.toggle('hidden', !inRoom);
    drawRecent();
    if (!inRoom) return;

    const st = R.state() || {};
    const url = R.inviteUrl();
    const link = $('#rmLink'); if (link) link.value = url;

    const qr = $('#rmQr');
    if (qr) {
      qr.innerHTML = '';
      if (url && window.TerseQR) {
        try {
          qr.innerHTML = window.TerseQR.svg(url, { size: 132, quiet: 2 }) +
            `<div style="font-size:11px;color:var(--t3);line-height:1.6">
               <div style="font:700 17px ui-monospace,Menlo,monospace;color:var(--t1);letter-spacing:2px">${esc(st.code || '')}</div>
               <div style="margin-top:4px">Scan the code with any phone camera</div>
             </div>`;
        } catch (e) {}
      }
    }

    // Ownership and listing are answered by the SERVER. The local copy is a
    // guess that goes stale the moment you rejoin with a fresh key — which is
    // how an owner ends up looking at their own room with no Close button and a
    // listing toggle showing the wrong state.
    let snap = null;
    try { snap = await R.snapshot(); } catch (e) {
      // The room is gone (closed by its owner, or the server forgot it). Drop
      // the stale local membership rather than showing a room nobody is in.
      if (String(e.message).includes('404') || /closed|No such/i.test(e.message)) {
        await R.leave().catch(() => {});
        return refresh();
      }
      $('#rmMsg').textContent = String(e.message || e);
      return;
    }
    const owner = !!snap.owner;
    const listed = (snap.room || {}).visibility === 'public';
    if (st.owner !== owner || st.visibility !== (snap.room || {}).visibility) {
      R.remember?.({ id: st.id, owner, visibility: (snap.room || {}).visibility,
                     category: (snap.room || {}).category, name: (snap.room || {}).name });
    }

    $('#rmClose').style.display = owner ? '' : 'none';
    $('#rmListingGroup').style.display = owner ? '' : 'none';
    if (owner) {
      // State first, verb second. A checkbox could only say "on"; this has to
      // say what being on MEANS, because listing a room is what exposes it to
      // strangers and that should never be a switch someone flips by accident.
      $('#rmListingState').textContent = listed ? TT('rm_listed_yes') : TT('rm_listed_no');
      $('#rmListToggle').textContent = listed ? TT('rm_unpublish') : TT('rm_publish');
      $('#rmListToggle').dataset.listed = listed ? '1' : '';
      const cat = $('#rmListCategory');
      if (cat) cat.value = (snap.room || {}).category || 'other';
    }

    // Only the owner can see or answer these, so only the owner asks for them.
    if (owner) {
      try {
        const k = await R.knocks();
        const list = k.knocks || [];
        $('#rmKnockGroup').style.display = list.length ? '' : 'none';
        $('#rmKnocks').innerHTML = list.map(x => `
          <div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:6px 8px">
            <span>${esc(x.name || 'someone')}</span>
            <span style="margin-left:auto;display:flex;gap:6px">
              <button class="ob-btn" style="font-size:10.5px;padding:2px 10px" data-knock-yes="${esc(x.id)}">Let in</button>
              <button class="ob-btn ghost" style="font-size:10.5px;padding:2px 10px" data-knock-no="${esc(x.id)}">Decline</button>
            </span>
          </div>`).join('');
      } catch (e) { $('#rmKnockGroup').style.display = 'none'; }
    } else {
      $('#rmKnockGroup').style.display = 'none';
    }

    const members = snap.members || [];
    $('#rmCount').textContent = members.length ? `(${members.length})` : '';
    $('#rmRoster').innerHTML = members.map(m => `
      <div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:6px 8px">
        <span style="width:8px;height:8px;border-radius:50%;background:${m.status === 'online' ? 'var(--btn)' : 'var(--t3)'}"></span>
        <span>${esc(m.name || m.user_email || 'someone')}${m.member_id === snap.you ? ' <span style="color:var(--t3)">(you)</span>' : ''}</span>
        <span style="margin-left:auto;color:var(--t3);font-size:10.5px">${esc(m.status || '')}</span>
      </div>`).join('');

    // Friends who are not already here — the one-click "pull them in" path.
    let cfg = null;
    try { cfg = await T.getCoworkConfig?.(); } catch (e) {}
    const here = new Set(members.map(m => (m.user_email || '').toLowerCase()).filter(Boolean));
    const friends = (Array.isArray(cfg?.members) ? cfg.members : [])
      .filter(f => !here.has((f.user_email || '').toLowerCase()));
    $('#rmFriends').innerHTML = friends.length
      ? friends.map(f => `
          <div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:6px 8px">
            <span>${esc(f.name || f.user_email || '—')}</span>
            <button class="ob-btn ghost" style="margin-left:auto;font-size:10.5px;padding:2px 10px"
                    data-invite="${esc(f.user_email || '')}">Send code</button>
          </div>`).join('')
      : `<p style="font-size:11px;color:var(--t3);margin:4px 0 0">Everyone on your friends list is already here.</p>`;
  }

  if (!roomWired) {
    roomWired = true;

    $('#rmCreate')?.addEventListener('click', async () => {
      const msg = $('#rmOutMsg');
      msg.textContent = 'Creating…';
      try {
        await R.create(($('#rmName')?.value || '').trim(), await displayName(), await currentEmail(),
                       { visibility: $('#rmPublic')?.checked ? 'public' : 'private',
                         category: $('#rmCategory')?.value });
        msg.textContent = '';
        refresh();
        // Being in a room means being in the conversation, so the window that
        // holds it opens with it rather than waiting to be found.
        T.showRoomWindow?.();
        window.showToast?.(TT('rm_created'));
      } catch (e) { msg.textContent = String(e.message || e); }
    });

    $('#rmJoin')?.addEventListener('click', async () => {
      const msg = $('#rmOutMsg');
      const code = ($('#rmCode')?.value || '').trim().toUpperCase();
      if (!code) { msg.textContent = TT('rm_need_code'); return; }
      msg.textContent = 'Joining…';
      try {
        await R.join(code, await displayName(), await currentEmail());
        msg.textContent = '';
        refresh();
        T.showRoomWindow?.();
        window.showToast?.(TT('rm_joined'));
      } catch (e) { msg.textContent = String(e.message || e); }
    });
    $('#rmCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#rmJoin')?.click(); });

    $('#rmCopy')?.addEventListener('click', async () => {
      const v = $('#rmLink')?.value || '';
      if (!v) return;
      try { await navigator.clipboard.writeText(v); window.showToast?.(TT('rm_copied')); }
      catch (e) { window.showToast?.(String(e)); }
    });

    $('#rmLeave')?.addEventListener('click', async () => {
      await R.leave();
      refresh();
      window.showToast?.(TT('rm_left'));
    });

    $('#rmClose')?.addEventListener('click', async () => {
      try { await R.close(); } catch (e) { $('#rmMsg').textContent = String(e.message || e); }
      refresh();
    });

    $('#rmKnocks')?.addEventListener('click', async e => {
      const yes = e.target.closest('[data-knock-yes]'), no = e.target.closest('[data-knock-no]');
      const btn = yes || no;
      if (!btn) return;
      btn.disabled = true;
      try {
        await R.answerKnock(yes ? yes.dataset.knockYes : no.dataset.knockNo, !!yes);
        refresh();
      } catch (err) { btn.disabled = false; $('#rmMsg').textContent = String(err.message || err); }
    });

    $('#rmListToggle')?.addEventListener('click', async e => {
      const b = e.currentTarget;
      const publish = !b.dataset.listed;
      b.disabled = true;
      try {
        // The category goes WITH it. Sending null is not "leave it alone", it is
        // "clear it" — which quietly dropped every listed room into the
        // uncategorised pile the first time its owner touched this control.
        await R.setListing(publish ? 'public' : 'private', $('#rmListCategory')?.value);
        $('#rmMsg').textContent = publish ? TT('rm_published') : TT('rm_unpublished');
      } catch (err) { $('#rmMsg').textContent = String(err.message || err); }
      b.disabled = false;
      refresh();
    });

    // Re-categorising only means something once the room is listed; while it is
    // private this just records where it will appear when it is published.
    $('#rmListCategory')?.addEventListener('change', async e => {
      const st = R.state() || {};
      if (st.visibility !== 'public') return;
      try {
        await R.setListing('public', e.target.value);
        $('#rmMsg').textContent = TT('rm_published');
      } catch (err) { $('#rmMsg').textContent = String(err.message || err); }
    });

    /* Walking back into a room you already belong to. No code to retype and no
       knock to wait on — you are a member; this is a door, not a request. If the
       seat was given up on the way out, rooms.js mints a new one from the code,
       which is why leaving keeps it. */
    const nick = $('#rmNick');
    if (nick) nick.value = R.nickname();
    async function saveNick() {
      const v = ($('#rmNick')?.value || '').trim();
      if (!v) return;
      await R.setNickname(v);
      window.showToast?.(TT('rm_nick_saved'));
      refresh();
    }
    $('#rmNickSave')?.addEventListener('click', saveNick);
    $('#rmNick')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) saveNick(); });

    $('#rmOpenChat')?.addEventListener('click', () => T.showRoomWindow?.());

    $('#rmRecent')?.addEventListener('click', async e => {
      const b = e.target.closest('[data-enter]');
      if (!b) return;
      const label = b.textContent;
      b.disabled = true; b.textContent = '…';
      try {
        await R.rejoin(b.dataset.enter, await displayName(), await currentEmail());
        window.showToast?.(TT('rm_joined'));
        T.showRoomWindow?.();
        refresh();
      } catch (err) {
        b.disabled = false; b.textContent = label;
        $('#rmMsg').textContent = String(err.message || err);
        drawRecent();
      }
    });

    $('#rmRefresh')?.addEventListener('click', refresh);

    $('#rmFriends')?.addEventListener('click', async e => {
      const b = e.target.closest('[data-invite]');
      if (!b) return;
      // Sending is the invite page's job; here it is a copy plus a nudge, so a
      // friend gets the code through whatever channel they actually read.
      try { await navigator.clipboard.writeText(R.inviteUrl()); } catch (err) {}
      b.textContent = 'Copied ✓';
      $('#rmMsg').textContent = TT('rm_sent_hint');
    });


  }

  refresh();
}

/** The signed-in email, or null. A room member without one is anonymous: they
    can be seen and chatted with, but not added as a friend, because there is
    nothing durable to attach the friendship to. */
async function currentEmail() {
  try {
    const a = await T.getAuthState?.();
    return a?.email || null;
  } catch (e) { return null; }
}

/** Whatever name the room should show for us.
    The nickname wins over the email: it is the only one the person actually
    chose, and "someone" — the old last resort — is what a roster full of
    strangers looked like. */
async function displayName() {
  const nick = window.TerseRooms?.nickname?.();
  if (nick) return nick;
  try {
    const a = await T.getAuthState?.();
    if (a?.email) return String(a.email).split('@')[0];
  } catch (e) {}
  return 'someone';
}

/* ── 广场 · Plaza ────────────────────────────────────────────────────────────
   Browsing is not joining. The listing deliberately does NOT carry room codes —
   if it did, "ask to join" would be theatre, since anyone could simply use the
   code. So the only way in from here is to knock and wait for the owner. */
let plazaWired = false, plazaCat = null, knockPoll = null, plazaAsked = {};
async function plazaInit() {
  const R = window.TerseRooms;
  if (!R) return;
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  async function refresh() {
    let data;
    if (!$('#pzList').innerHTML) $('#pzList').innerHTML =
      `<p style="font-size:11px;color:var(--t3);margin:4px 0 0">${TT('pz_looking')}</p>`;
    try { data = await R.plaza(plazaCat); }
    catch (e) {
      // A dead plaza used to look exactly like an empty one. It is not the same
      // thing, and the difference is the only thing worth saying here.
      $('#pzList').innerHTML =
        `<p style="font-size:11px;color:var(--t3);margin:4px 0 0">${TT('pz_offline')}</p>`;
      $('#pzMsg').textContent = String(e.message || e);
      return;
    }
    $('#pzMsg').textContent = '';

    // The chip's VALUE is the server's enum; only its label is translated.
    $('#pzCats').innerHTML = ['all', ...(data.categories || [])].map(c => {
      const on = (c === 'all' && !plazaCat) || c === plazaCat;
      return `<button class="ob-btn ${on ? '' : 'ghost'}" style="font-size:11px;padding:3px 11px"
                data-cat="${c}">${TT('pz_cat_' + c)}</button>`;
    }).join('');

    const active = R.state() || {};
    const rooms = data.rooms || [];
    $('#pzList').innerHTML = rooms.length
      ? rooms.map(r => {
          /* Three different buttons, because they are three different acts.
             Offering "ask to join" for a room you own is a button that can never
             do anything — the knock arrives, and the only person who could
             answer it is the one who pressed it. */
          const here = r.id === active.id;
          const mine = r.joined || r.owner;
          const asked = plazaAsked[r.id];
          const action = here
            ? `<span style="margin-left:auto;font-size:10.5px;color:var(--t3)">${TT('rm_you_here')}</span>`
            : mine
              ? `<button class="ob-btn" style="margin-left:auto;font-size:10.5px;padding:3px 11px"
                         data-enter="${esc(r.id)}">${r.owner ? TT('pz_open_yours') : TT('rm_rejoin')}</button>`
              : `<button class="ob-btn" style="margin-left:auto;font-size:10.5px;padding:3px 11px"
                         data-knock="${esc(r.id)}" data-online="${r.online}"
                         ${asked ? 'disabled' : ''}>${asked ? TT('pz_asked') : TT('pz_ask')}</button>`;
          const bits = [
            TT('pz_cat_' + (r.category || 'other')),
            TTn('rm_online_n', r.online),
            r.members === 1 ? TT('rm_member_1') : TTn('rm_members_n', r.members),
            r.owner ? TT('rm_yours') : (r.joined ? TT('rm_member_of') : null),
          ].filter(Boolean).join(' · ');
          return `
            <div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:8px">
              <span style="width:8px;height:8px;border-radius:50%;background:${r.online ? 'var(--btn)' : 'var(--t3)'}"></span>
              <span>
                <div>${esc(r.name || TT('rm_untitled'))}</div>
                <div style="font-size:10.5px;color:var(--t3)">${bits}</div>
              </span>
              ${action}
            </div>`;
        }).join('')
      : `<p style="font-size:11px;color:var(--t3);margin:4px 0 0;line-height:1.7">
           ${plazaCat ? TT('pz_empty_cat') : TT('pz_empty')} ${TT('pz_empty_hint')}
           <a href="#" data-go-room="1" style="color:var(--t1)">${TT('pz_empty_cta')}</a>
           ${TT('pz_empty_tail')}</p>`;

    // Someone who owns a listed room is the person who answers its knocks, so
    // being told there is a queue belongs here as much as on the Room page.
    if (active.id && rooms.some(r => r.id === active.id && r.owner)) {
      try {
        const k = await R.knocks();
        if ((k.knocks || []).length) {
          $('#pzMsg').textContent = TTn('pz_knock_queue', k.knocks.length);
        }
      } catch (e) { /* not fatal: the Room page is the real queue */ }
    }
  }

  if (!plazaWired) {
    plazaWired = true;
    $('#pzRefresh')?.addEventListener('click', refresh);
    $('#pzCats')?.addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      plazaCat = b.dataset.cat === 'all' ? null : b.dataset.cat;
      refresh();
    });
    $('#pzList')?.addEventListener('click', async e => {
      const go = e.target.closest('[data-go-room]');
      if (go) { e.preventDefault(); window.__terseOpenPage?.('room'); return; }

      // A room you already belong to opens; it does not get knocked on.
      const open = e.target.closest('[data-enter]');
      if (open) {
        open.disabled = true; open.textContent = '…';
        try {
          await R.rejoin(open.dataset.enter, await displayName(), await currentEmail());
          T.showRoomWindow?.();
          window.__terseOpenPage?.('room');
        } catch (err) {
          open.disabled = false; open.textContent = TT('rm_rejoin');
          $('#pzMsg').textContent = String(err.message || err);
        }
        return;
      }

      const b = e.target.closest('[data-knock]');
      if (!b) return;
      b.disabled = true; b.textContent = TT('pz_asked');
      try {
        const k = await R.knock(b.dataset.knock, await displayName());
        plazaAsked[b.dataset.knock] = k.knock.id;
        // Only the owner can answer a knock. Saying "waiting…" at an empty room
        // is how a working feature comes across as a dead button.
        $('#pzMsg').textContent = b.dataset.online === '0' ? TT('pz_nobody_home') : TT('pz_waiting');
        // Poll for the verdict. The same call hands over the key on approval,
        // so a yes puts us straight into the room.
        clearInterval(knockPoll);
        knockPoll = setInterval(async () => {
          try {
            const st = await R.knockStatus(k.knock.id);
            if (st.status === 'approved') {
              clearInterval(knockPoll);
              delete plazaAsked[b.dataset.knock];
              $('#pzMsg').textContent = TT('pz_entering');
              T.showRoomWindow?.();
              window.__terseOpenPage?.('room');
            } else if (st.status === 'denied') {
              clearInterval(knockPoll);
              delete plazaAsked[b.dataset.knock];
              $('#pzMsg').textContent = TT('pz_denied');
              b.disabled = false; b.textContent = TT('pz_ask');
            }
          } catch (err) { clearInterval(knockPoll); }
        }, 3000);
      } catch (err) {
        b.disabled = false; b.textContent = TT('pz_ask');
        delete plazaAsked[b.dataset.knock];
        $('#pzMsg').textContent = String(err.message || err);
      }
    });
  }
  refresh();
}

/* Incoming friend requests. They arrive from the room and are answered here,
   because accepting is a durable decision and the wallpaper is not the place to
   make one — it is glanceable by design. */
function renderFriendRequests(incoming) {
  const box = $('#frRequests');
  if (!box) return;
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  box.innerHTML = incoming.length
    ? incoming.map(r => `
        <div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:6px 8px">
          <span>${esc(r.name || r.email)}</span>
          <span style="margin-left:auto;display:flex;gap:6px">
            <button class="ob-btn" style="font-size:10.5px;padding:2px 10px" data-accept="${esc(r.id)}">Accept</button>
            <button class="ob-btn ghost" style="font-size:10.5px;padding:2px 10px" data-decline="${esc(r.id)}">Decline</button>
          </span>
        </div>`).join('')
    : '';
  box.parentElement.style.display = incoming.length ? '' : 'none';
}

/* ── 好友 · Friends ─────────────────────────────────────────────────────────
   The social surface. Four jobs: hand out an invite, show who is in, switch
   teammates on or off the wallpaper, and take a pasted code from someone whose
   link never worked.

   The invite USED to be a `terse://` deep link, because the app already handles
   those (handle_connect_url resolves the token, saves it, opens Cowork). It was
   the wrong artifact to hand out: invites travel through WeChat and Douyin, and
   their in-app browsers block custom schemes AND ignore Universal Links, so the
   link was guaranteed to be dead in the one place it gets sent. What ships now
   is the https page, which those webviews can always open; the deep link still
   exists, it just moved behind the page. The QR encodes that same https string —
   one artifact, three ways to send it (paste, scan, or forward in WeChat). */
const INVITE_BASE = 'https://www.terseai.org/join';
let friendsWired = false;
async function friendsInit() {
  const inv = window.__TAURI__?.core?.invoke;
  let cfg = null;
  if (!inv) return;
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  async function refresh() {
    // Use the accessors that actually exist — cowork.js has always read the
    // config through T.getCoworkConfig(); I had invented a command name.
    // Assigns the OUTER cfg on purpose: a local `let cfg` here shadowed it, so
    // the wallpaper switch below always read null and published an empty roster,
    // i.e. switching peers on quietly did nothing.
    try { cfg = await T.getCoworkConfig?.(); } catch (e) {}
    const token = cfg?.token || cfg?.teamToken || '';
    const link = token ? `${INVITE_BASE}?c=${encodeURIComponent(token)}` : '';
    const el = $('#frLink');
    if (el) el.value = link || 'No team yet — create one on the Team page';

    // The QR is the whole point of the https switch: a WeChat or Douyin camera
    // can scan it. Drawn from the same string in the box, so the two can never
    // disagree, and cleared entirely when there is no team yet — an inviting
    // square that resolves to nothing would be worse than no square.
    const qr = $('#frQr');
    if (qr) {
      qr.innerHTML = '';
      if (link && window.TerseQR) {
        try {
          // 132px for a ~37-module code is roughly 0.9mm per module on a normal
          // display — comfortably above what a phone camera resolves at reading
          // distance. Smaller looked tidier and scanned worse.
          // Text goes in as ENGLISH, never bilingual: i18n.js translates by
          // matching English leaf text, so a hardcoded 中文/English pair is
          // invisible to it and stays wrong in all ten languages.
          qr.innerHTML = window.TerseQR.svg(link, { size: 132, quiet: 2 }) +
            `<div style="font-size:11px;color:var(--t3);line-height:1.6">
               <div>Scan the code with any phone camera</div>
               <div style="opacity:.8;margin-top:4px">They do not need Terse to scan it — the page has the download and the code.</div>
             </div>`;
        } catch (e) { /* payload too long is the only throw; leave the box empty */ }
      }
    }

    // Roster
    // The roster comes from the team feed the app already fetches; there is no
    // members command, and inventing one would just be a second source of
    // truth. Presence arrives over the shared stream instead.
    // Real friendships, when the room key can prove who we are. The team member
    // list is the fallback for anyone who has never been in a room — it is what
    // this page showed before friendships existed at all.
    let members = Array.isArray(cfg?.members) ? cfg.members : [];
    try {
      // No room needed: the install identity is the credential, so friends and
      // pending requests are readable whether or not you are in a room today.
      const R = window.TerseRooms;
      if (R && R.listFriends) {
        const f = await R.listFriends();
        members = (f.friends || []).map(x => ({ name: x.name || x.email || 'friend', user_email: x.email, online: false }));
        renderFriendRequests(f.incoming || []);
      }
    } catch (e) { /* offline, or nothing yet — fall back to the team list */ }
    const box = $('#frRoster'), cnt = $('#frCount');
    if (cnt) cnt.textContent = members.length ? `(${members.length})` : '';
    if (box) {
      box.innerHTML = members.length
        ? members.map(m => `<div class="mcp-row" style="display:flex;gap:8px;align-items:center;padding:6px 8px">
             <span style="width:8px;height:8px;border-radius:50%;background:${m.online ? 'var(--btn)' : 'var(--t3)'}"></span>
             <span>${esc(m.name || m.user_email || m.device || '—')}</span>
             <span style="margin-left:auto;color:var(--t3);font-size:10.5px">${esc(m.status || '')}</span>
           </div>`).join('')
        : `<p style="font-size:11px;color:var(--t3);margin:4px 0 0">
             ${TT('fr_empty')}</p>`;
    }
  }

  if (!friendsWired) {
    friendsWired = true;
    $('#frCopy')?.addEventListener('click', async () => {
      const v = $('#frLink')?.value || '';
      // Guard on the invite prefix, not on a scheme — the link is https now, and
      // the box also holds the "no team yet" sentence, which must not be copied.
      if (!v.startsWith(INVITE_BASE)) return;
      try { await navigator.clipboard.writeText(v); window.showToast?.(TT('fr_copied')); }
      catch (e) { window.showToast?.(String(e)); }
    });

    // Join with a pasted code. Accepts the bare token or the whole invite URL,
    // because people paste whatever they were sent.
    $('#frJoin')?.addEventListener('click', async () => {
      const msg = $('#frJoinMsg');
      let raw = ($('#frJoinCode')?.value || '').trim();
      // A friend link is the common case now, so it is checked first — pasting
      // one into the "join" box is what people will actually do.
      const friend = raw.match(/[?&]friend=([^&\s]+)/);
      if (friend) {
        if (msg) msg.textContent = TT('fr_joining');
        try {
          await window.TerseRooms.acceptFriendLink(decodeURIComponent(friend[1]), await displayName());
          if (msg) msg.textContent = TT('fr_joined');
          refresh();
        } catch (e) { if (msg) msg.textContent = String(e?.message || e); }
        return;
      }
      const m = raw.match(/[?&]c=([^&\s]+)/);
      if (m) raw = decodeURIComponent(m[1]);
      raw = raw.replace(/^terse:\/\/\?token=/, '');
      if (!raw) { if (msg) msg.textContent = TT('fr_join_empty'); return; }
      if (msg) msg.textContent = TT('fr_joining');
      try {
        await T.setCoworkToken(raw);
        if (msg) msg.textContent = TT('fr_joined');
        refresh();
      } catch (e) {
        if (msg) msg.textContent = String(e?.message || e);
      }
    });
    $('#frJoinCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#frJoin')?.click(); });

    $('#frRequests')?.addEventListener('click', async e => {
      const yes = e.target.closest('[data-accept]'), no = e.target.closest('[data-decline]');
      const btn = yes || no;
      if (!btn) return;
      btn.disabled = true;
      try {
        await window.TerseRooms.respondFriend(yes ? yes.dataset.accept : no.dataset.decline, !!yes);
        refresh();
      } catch (err) { btn.disabled = false; window.showToast?.(String(err.message || err)); }
    });

    $('#frLinkBtn')?.addEventListener('click', async () => {
      const out = $('#frLinkOut'), qr = $('#frLinkQr');
      try {
        const j = await window.TerseRooms.friendLink();
        out.value = j.url;
        try { await navigator.clipboard.writeText(j.url); window.showToast?.(TT('fr_copied')); } catch (e) {}
        if (qr && window.TerseQR) {
          qr.innerHTML = window.TerseQR.svg(j.url, { size: 132, quiet: 2 }) +
            `<div style="font-size:11px;color:var(--t3);line-height:1.6">
               <div>Scan the code with any phone camera</div>
               <div style="opacity:.8;margin-top:4px">Whoever opens it is added — no approval needed.</div>
             </div>`;
        }
      } catch (e) { out.value = ''; window.showToast?.(String(e.message || e)); }
    });

    $('#frRefresh')?.addEventListener('click', refresh);
    // The wallpaper switch is purely local: it decides whether THIS machine
    // renders peers. It never changes what the team publishes, so turning it
    // off cannot affect anyone else.
    const wt = $('#frWallpaper');
    if (wt) {
      wt.checked = localStorage.getItem('terse-wallpaper-peers') === '1';
      wt.addEventListener('change', () => {
        localStorage.setItem('terse-wallpaper-peers', wt.checked ? '1' : '0');
        // Local-only switch: tell the wallpaper directly rather than adding a
        // native command for a preference that never leaves this machine.
        try { window.__TAURI__?.event?.emit('cowork-session',
              { members: wt.checked ? (cfg?.members || []) : [] }); } catch (e) {}
        window.showToast?.(wt.checked ? TT('fr_wall_on')
                                     : TT('fr_wall_off'));
      });
    }
  }
  refresh();
}

/* ── Link phone ───────────────────────────────────────────────────────────────
   The pairing sheet in Settings. The QR is drawn locally with TerseQR — this
   webview has no network guarantee, and "link my phone" failing because a CDN is
   unreachable would be the worst possible moment for it.

   Polling only runs while the sheet is open. A background poll would keep a
   request going every few seconds for a screen nobody is looking at, forever.
   ---------------------------------------------------------------------------- */
(function initPhoneLink() {
  var pairBtn = document.getElementById('btnPhonePair');
  if (!pairBtn) return;                       // not the main window

  var idle = document.getElementById('phoneIdle');
  var sheet = document.getElementById('phonePairing');
  var statusEl = document.getElementById('phoneStatus');
  var unlinkBtn = document.getElementById('btnPhoneUnlink');
  var cancelBtn = document.getElementById('btnPhoneCancel');
  var shareRow = document.getElementById('phoneShareRow');
  var shareBox = document.getElementById('phoneShare');
  var codeEl = document.getElementById('phoneCode');
  var qrCanvas = document.getElementById('phoneQr');
  var poll = null;

  var PT = function (key, fallback) {
    var v = (window.i18n && window.i18n.t) ? window.i18n.t(key) : null;
    return (v && v !== key) ? v : fallback;
  };

  function render(st) {
    st = st || {};
    var linked = !!st.linked;
    statusEl.textContent = linked
      ? PT('phone_linked', 'Linked to your phone')
      : PT('phone_not_linked', 'Not linked');
    unlinkBtn.classList.toggle('hidden', !st.paired);
    shareRow.classList.toggle('hidden', !linked);
    shareBox.checked = !!st.share;
    pairBtn.textContent = st.paired
      ? PT('phone_relink', 'Link another phone')
      : PT('phone_link', 'Link phone');
  }

  function stopPolling() {
    if (poll) { clearInterval(poll); poll = null; }
  }

  function closeSheet() {
    stopPolling();
    sheet.classList.add('hidden');
    idle.classList.remove('hidden');
  }

  /* Draw the QR at a size a phone camera can actually resolve from a normal
     desk distance, snapped to whole device pixels — a fractional module size
     makes some rows a pixel wider than others, and that blur is what a scanner
     fails on. */
  function drawQR(url) {
    var mod = window.TerseQR.matrix(url, 'M');
    var quiet = 4;                            // the standard's margin; without it many scanners never see the code
    var total = mod.length + quiet * 2;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var scale = Math.max(1, Math.floor((150 * dpr) / total));
    var px = total * scale;
    qrCanvas.width = px;
    qrCanvas.height = px;
    qrCanvas.style.width = qrCanvas.style.height = (px / dpr) + 'px';
    var ctx = qrCanvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#0b0b0d';
    for (var y = 0; y < mod.length; y++) {
      for (var x = 0; x < mod.length; x++) {
        if (mod[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  pairBtn.addEventListener('click', function () {
    pairBtn.disabled = true;
    T.phonePair().then(function (r) {
      drawQR(r.url);
      codeEl.textContent = r.code;
      idle.classList.add('hidden');
      sheet.classList.remove('hidden');

      // Watch for the phone claiming it. The code expires in ten minutes, and
      // polling past that would ask forever about a link that can never form.
      var until = Date.now() + (r.expiresIn || 600) * 1000;
      stopPolling();
      poll = setInterval(function () {
        if (Date.now() > until) { closeSheet(); refreshStatus(); return; }
        T.phoneStatus().then(function (st) {
          if (!st.linked) return;
          closeSheet();
          render(st);
          // Sharing is off by default, but a person who just scanned a code
          // plainly wants it on — leaving them to find a second switch would
          // make the pairing look broken.
          return T.phoneSetShare(true).then(render);
        }).catch(function () {});
      }, 2000);
    }).catch(function (e) {
      window.showToast?.(e.message || String(e));
    }).then(function () { pairBtn.disabled = false; });
  });

  cancelBtn.addEventListener('click', function () { closeSheet(); refreshStatus(); });
  unlinkBtn.addEventListener('click', function () { T.phoneUnlink().then(render); });
  shareBox.addEventListener('change', function () { T.phoneSetShare(shareBox.checked).then(render); });

  function refreshStatus() {
    if (!T.phoneStatus) return;
    T.phoneStatus().then(render).catch(function () {});
  }

  // The sheet is inside Settings, so its state only needs to be current when
  // Settings is opened — not on a timer for the life of the app.
  var settingsBtn = document.getElementById('btnSettings');
  if (settingsBtn) settingsBtn.addEventListener('click', refreshStatus);
  refreshStatus();
})();
