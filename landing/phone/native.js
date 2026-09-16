/**
 * native.js — the Android app's half of the web app.
 *
 * Terse for Android does not reimplement this UI; it hosts this exact page in a
 * WebView (android-app/.../web/TerseWebActivity.kt). Three things the page
 * cannot do on its own are injected by the app as `window.TerseAndroid`:
 *
 *   · binding the real live wallpaper service
 *   · enabling the Terse system keyboard
 *   · taking money through Play Billing
 *
 * Loaded last and additive by design: with no bridge present (every browser,
 * the PWA, the desktop renderer) every branch below is skipped and the page is
 * byte-for-byte what it was.
 */
(function () {
  'use strict';

  var N = window.TerseAndroid;
  if (!N || typeof N.platform !== 'function') return;

  document.documentElement.setAttribute('data-native', 'android');

  function $(id) { return document.getElementById(id); }

  // Guard every bridge call. An older APK against a newer page is the normal
  // state of affairs — the page ships continuously, the APK ships through
  // review — so a missing method must degrade, never throw.
  function call(name) {
    var args = [].slice.call(arguments, 1);
    try {
      return typeof N[name] === 'function' ? N[name].apply(N, args) : undefined;
    } catch (e) { return undefined; }
  }

  // ── Play Billing ─────────────────────────────────────────────────────────
  // Google Play requires a digital subscription bought inside the app to go
  // through Play Billing. This page sells through Stripe, which is precisely
  // what gets an app removed, so every road to checkout is cut here.
  //
  // TWO LAYERS ON PURPOSE, because one is not safe:
  //
  //  1. The buttons. There are four openers today (#upgradeBtn, #proSheetCta,
  //     #psCta, #psCtaMe) and the plan buttons inside the sheet. Catching them
  //     in the CAPTURE phase runs before the page's own handler, and
  //     stopPropagation keeps it from ever reaching it. Going straight to Play
  //     also skips the multi-tier sheet, which would otherwise offer plans that
  //     have no Play SKU behind them.
  //
  //  2. fetch(). A fifth opener added next month would silently reopen the
  //     hole, so the actual money request — POST /api/checkout — is blocked at
  //     the source. This is the guarantee; the button list is only for UX.
  var CHECKOUT_OPENERS = ['#upgradeBtn', '#proSheetCta', '#psCta', '#psCtaMe'];

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var hit = e.target.closest(CHECKOUT_OPENERS.join(',') + ', #planList .plan');
    if (!hit) return;
    if (!call('canPurchase')) return;
    // A subscription needs an account to land on. Signed out, let the page's own
    // flow run — it asks for sign-in first — and the checkout it ends in is
    // caught by the fetch guard below.
    var u = null;
    try { u = window.terse && window.terse.user && window.terse.user(); } catch (err) {}
    if (!u) return;
    e.preventDefault();
    e.stopPropagation();
    // The plans sheet may already be open behind the tap; close it so the Play
    // dialog is not stacked on a price list it does not correspond to.
    var sheet = $('planSheet'); if (sheet) sheet.classList.add('hide');
    var pro = $('proSheet'); if (pro) pro.classList.add('hide');
    call('haptic');
    call('purchasePro');
  }, true);

  if (window.fetch) {
    var realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; }
      catch (e) { url = ''; }
      if (url.indexOf('/api/checkout') !== -1 && call('canPurchase')) {
        call('purchasePro');
        // Resolve rather than reject: the caller renders "could not start
        // checkout" on a rejection, and nothing went wrong — the purchase just
        // moved to Play.
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'handled-by-play-billing' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      return realFetch(input, init);
    };
  }

  // ── Install card ─────────────────────────────────────────────────────────
  // "Add to Home Screen" inside an installed app is nonsense.
  var install = $('installCard');
  if (install) install.classList.add('hide');

  // ── Native controls ──────────────────────────────────────────────────────
  function nativeCard() {
    var host = $('v-me');
    if (!host || $('nativeCard')) return;

    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'nativeCard';

    var h = document.createElement('h2');
    h.textContent = 'This phone';
    card.appendChild(h);

    card.appendChild(row(
      'Live wallpaper',
      function () { return call('isWallpaperActive') ? 'Active' : 'Not set'; },
      'Set',
      function () { call('setLiveWallpaper'); }
    ));

    card.appendChild(row(
      'Terse keyboard',
      function () { return call('isKeyboardEnabled') ? 'Enabled' : 'Off'; },
      'Enable',
      function () { call('openKeyboardSettings'); }
    ));

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn ghost wide';
    restore.textContent = 'Restore purchases';
    restore.onclick = function () { call('restorePurchases'); };
    card.appendChild(restore);

    // #wpCard is the iPhone-only wallpaper-link card and does not exist on
    // every version of this page; fall back to the install card, then to the
    // end of the tab.
    var before = $('wpCard') || $('installCard');
    if (before && before.parentNode === host) host.insertBefore(card, before);
    else host.appendChild(card);
  }

  function row(label, statusFn, action, onClick) {
    // .item, not .row: the page styles `.item b` as display:block, which is
    // what stacks the label over its status line. On .row they run together.
    var r = document.createElement('div');
    r.className = 'item';

    var g = document.createElement('span');
    g.className = 'grow';
    var b = document.createElement('b');
    b.className = 'ell';
    b.textContent = label;
    var sub = document.createElement('span');
    sub.className = 'tiny';
    sub.textContent = statusFn();
    g.appendChild(b);
    g.appendChild(sub);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost';
    btn.textContent = action;
    btn.onclick = onClick;

    r.appendChild(g);
    r.appendChild(btn);

    // Both states are changed outside the app, in system Settings, so the only
    // moment they can be trusted is when the user comes back to us.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') sub.textContent = statusFn();
    });
    return r;
  }

  // ── Identity handoff ─────────────────────────────────────────────────────
  // The keyboard and the wallpaper are separate processes with no WebView and
  // no cookies; they read tier out of SharedPreferences. Push it down whenever
  // the page's idea of the user changes, so the keyboard is not stuck on the
  // free quota for someone who is paying.
  var lastPushed = null;
  function pushAuth() {
    var u = null;
    try { u = window.terse && window.terse.user && window.terse.user(); } catch (e) {}
    var payload = JSON.stringify({
      clerkUserId: (u && u.id) || '',
      email: (u && u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || '',
      tier: (window.terse && window.terse.isPro && window.terse.isPro()) ? 'pro' : 'free'
    });
    if (payload === lastPushed) return;
    lastPushed = payload;
    call('setAuth', payload);
  }

  // Clerk resolves well after this file runs and there is no ready event to
  // hook, so settle for a bounded poll and then the lifecycle.
  var tries = 0;
  var poll = setInterval(function () {
    pushAuth();
    if (++tries > 40) clearInterval(poll);   // 40 × 500ms ≈ 20s
  }, 500);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pushAuth();
  });

  window.addEventListener('terse-native-auth', function (e) {
    if (!e.detail || !e.detail.clerkUserId) return;
    try { localStorage.setItem('terse_native_user', e.detail.clerkUserId); } catch (err) {}
  });

  // ── Haptics ──────────────────────────────────────────────────────────────
  // The page has its own haptics module (TerseFeel); only add ours when it is
  // absent, or every tap buzzes twice.
  if (!window.TerseFeel) {
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.btn, nav button')) call('haptic');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', nativeCard);
  } else {
    nativeCard();
  }
})();
