/* ── Terse auth scrim ──
   Covers a floating window's content with a frosted blur layer until the user is
   signed in, so metrics can't be read clearly until login. Purely additive: it
   injects its own DOM + styles, polls auth via the bridge, and toggles itself.

   Include AFTER tauri-bridge.js. The scrim attaches to the first element it finds
   from SCRIM_TARGETS (the dashboard body) so it blurs the metrics while leaving the
   title bar's drag region + close button usable, and not the transparent margins. */
(function () {
  const SCRIM_TARGETS = ['[data-auth-gate]', '#dashBody', '#dashRoot'];

  let target = null;
  for (const sel of SCRIM_TARGETS) {
    const el = document.querySelector(sel);
    if (el) { target = el; break; }
  }
  if (!target) return; // nothing to gate in this window

  // Inject styles once.
  const style = document.createElement('style');
  style.textContent = `
    .auth-scrim {
      position: absolute; inset: 0; z-index: 9999;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; padding: 16px; text-align: center;
      border-radius: inherit;
      background: rgba(12, 14, 20, 0.55);
      -webkit-backdrop-filter: blur(14px) saturate(120%);
      backdrop-filter: blur(14px) saturate(120%);
      -webkit-app-region: no-drag;
      transition: opacity .18s ease;
    }
    .auth-scrim.hidden { opacity: 0; pointer-events: none; }
    .auth-scrim-lock {
      width: 34px; height: 34px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--ac, #4a9eff) 22%, transparent);
      color: var(--ac, #4a9eff);
    }
    .auth-scrim-msg {
      font-size: 12px; font-weight: 600; line-height: 1.35;
      color: var(--t1, #e8eaf0); max-width: 200px;
    }
    .auth-scrim-btn {
      margin-top: 2px; padding: 6px 16px; font-size: 12px; font-weight: 700;
      color: #fff; cursor: pointer;
      border: none; border-radius: 999px;
      background: var(--ac, #4a9eff);
      transition: filter .15s ease;
    }
    .auth-scrim-btn:hover { filter: brightness(1.1); }
  `;
  document.head.appendChild(style);

  // Build the scrim. Shown by default so content never flashes before the auth check.
  const scrim = document.createElement('div');
  scrim.className = 'auth-scrim';
  scrim.innerHTML = `
    <span class="auth-scrim-lock">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </span>
    <span class="auth-scrim-msg" id="authScrimMsg">Sign in to view your stats</span>
    <button class="auth-scrim-btn" id="authScrimBtn">Sign In</button>
  `;
  // Ensure the target can host an absolutely-positioned child.
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  target.appendChild(scrim);

  // i18n (optional — falls back to English).
  const tr = (key, fallback) =>
    (window.i18n && window.i18n.t && window.i18n.t(key) !== key) ? window.i18n.t(key) : fallback;
  scrim.querySelector('#authScrimBtn').textContent = tr('sign_in', 'Sign In');

  // Sign-in opens the main window, where the real auth gate / login flow lives.
  scrim.querySelector('#authScrimBtn').addEventListener('click', () => {
    const T = window.terse;
    if (T && T.showMainWindow) T.showMainWindow();
  });

  // ── Auth state polling ──
  let signedIn = false;
  function apply() { scrim.classList.toggle('hidden', signedIn); }
  apply(); // start locked

  async function check() {
    const T = window.terse;
    if (!T || !T.getAuth) return;
    try {
      const auth = await T.getAuth();
      const now = !!(auth && auth.signedIn);
      if (now !== signedIn) { signedIn = now; apply(); }
    } catch { /* keep current state */ }
  }

  // The window's renderer often replaces the target's innerHTML when it draws
  // content (e.g. dash.js does `dashBody.innerHTML = …` on every render/tab
  // switch). That wipes the scrim we appended as a child, blowing the gate open.
  // Re-attach it whenever the target's children change so the blur can't be lost.
  const mo = new MutationObserver(() => {
    if (!target.contains(scrim)) {
      mo.disconnect();
      target.appendChild(scrim);
      mo.observe(target, { childList: true });
    }
  });
  mo.observe(target, { childList: true });

  // Bridge may load slightly after this script; retry quickly until it answers.
  check();
  setInterval(check, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();
