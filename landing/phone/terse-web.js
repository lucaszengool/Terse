/**
 * terse-web.js — the browser implementation of `window.terse`.
 *
 * WHY THIS FILE IS THE WHOLE PORT. The wallpaper engines never depended on
 * Tauri: mineradio-wallpaper.js, token-wallpaper-3d.js and wallpaper-styles.js
 * contain no `invoke()` and no `__TAURI__`. They are vanilla JS and Three.js
 * drawing on a canvas. What the desktop wallpaper page DOES depend on is a
 * global called `window.terse` — and it uses barely any of it. The live field is
 * driven by exactly three calls:
 *
 *     T.getTokenPulse()      → a cumulative token count; the page diffs it
 *     T.getStats('day')      → { summary: { tokensSaved, tokensIn, … } }
 *     T.getAgentSessions()   → [ { agentType, agentName, burnRate, … } ]
 *
 * So the phone does not reimplement the wallpaper. It reimplements those three
 * functions on top of the device-link stream, and the real engine renders.
 *
 * THE UNLINKED CASE IS A FIRST-CLASS ONE, not a degraded one. Someone who never
 * pairs a Mac still gets the field, the rooms and the plaza; they simply get a
 * calm field instead of one driven by their agents. Every getter below therefore
 * answers honestly with nothing rather than throwing, and the caller cannot tell
 * the difference between "not linked" and "linked but idle" — because visually
 * there is none.
 */
(function (root) {
  'use strict';

  var API = (root.TERSE_API_BASE || 'https://www.terseai.org');
  var LINK = API + '/api/cloud/link';

  /* The phone's own copy of the last frame the desktop pushed. One object, kept
     current by the stream, read synchronously by the pollers. Everything below
     is a view onto this. */
  var frame = null;        // { stats, sessions, device, name, at }
  var devices = [];        // every desktop paired to this account
  var listeners = [];      // page code that wants to know when either changed

  // ── Clerk ────────────────────────────────────────────────────────────────
  // The phone app is sign-in gated, exactly like the desktop, and it uses the
  // same Clerk instance so an account works on both without a second signup.

  function clerk() { return root.Clerk || null; }

  /** The bearer token for our own API. Re-read on every call rather than cached:
      Clerk rotates these, and a phone that has been in a pocket for an hour will
      otherwise wake up and 401 on its first request. */
  function token() {
    var C = clerk();
    if (!C || !C.session) return Promise.resolve(null);
    return C.session.getToken().catch(function () { return null; });
  }

  function user() {
    var C = clerk();
    return (C && C.user) || null;
  }

  function api(path, opts) {
    return token().then(function (t) {
      if (!t) return Promise.reject(new Error('signed out'));
      var o = opts || {};
      return fetch(LINK + path, {
        method: o.method || 'GET',
        headers: Object.assign(
          { Authorization: 'Bearer ' + t },
          o.body ? { 'Content-Type': 'application/json' } : {}
        ),
        body: o.body ? JSON.stringify(o.body) : undefined,
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      });
    });
  }

  function fire() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ frame: frame, devices: devices }); } catch (e) {}
    }
  }

  function adopt(payload) {
    if (!payload) return;
    if (payload.devices) devices = payload.devices;
    if (payload.type === 'frame') frame = payload;
    else if ('frame' in payload) frame = payload.frame;
    fire();
  }

  // ── The link ─────────────────────────────────────────────────────────────

  var es = null;
  var reconnectAt = 0;

  /** Open the live stream.
   *
   *  THE RECONNECT IS NOT OPTIONAL AND CANNOT BE EVENT-DRIVEN. Since iOS 18, a
   *  backgrounded web app's EventSource is closed by the system but keeps
   *  reporting readyState === OPEN, and no `error` event ever fires — so the
   *  usual "reconnect on error" never runs and the wallpaper silently freezes on
   *  the frame it had when you locked the phone. The only reliable signal is
   *  visibilitychange, and the only safe assumption on resume is that the socket
   *  is dead regardless of what it claims. Hence: tear down and rebuild, every
   *  time the app comes back. */
  function openStream() {
    closeStream();
    return token().then(function (t) {
      if (!t) return;
      es = new EventSource(LINK + '/stream?token=' + encodeURIComponent(t));
      es.onmessage = function (ev) {
        try { adopt(JSON.parse(ev.data)); } catch (e) {}
      };
      es.onerror = function () {
        // Fires reliably on desktop and on a genuine network drop; on iOS it is
        // simply a bonus. Backoff is crude on purpose — the visibility handler
        // is the real recovery path.
        var now = Date.now();
        if (now - reconnectAt < 4000) return;
        reconnectAt = now;
        setTimeout(function () { if (document.visibilityState === 'visible') openStream(); }, 3000);
      };
    });
  }

  function closeStream() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
  }

  function refresh() {
    return api('/').then(function (d) {
      devices = d.devices || [];
      frame = d.frame || null;
      fire();
      return d;
    }).catch(function () { return null; });
  }

  var Link = {
    /** Everything the UI needs to say "connected to your Mac" or "not linked". */
    state: function () {
      var live = devices.some(function (d) { return d.live; });
      return {
        signedIn: !!user(),
        linked: devices.length > 0,
        live: live,
        devices: devices,
        // A frame from a machine that stopped pushing is history, not status.
        // Reporting it as current is how a shut laptop looks busy forever.
        frame: live ? frame : null,
      };
    },
    devices: function () { return devices; },
    refresh: refresh,
    open: openStream,
    close: closeStream,
    onChange: function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (f) { return f !== cb; }); }; },
    claim: function (code) {
      return api('/claim', { method: 'POST', body: { code: String(code || '').trim().toUpperCase() } })
        .then(function (d) { return refresh().then(function () { return d; }); });
    },
    unlink: function (id) {
      return api('/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () { return refresh(); });
    },
  };

  // ── The user's own backdrop ──────────────────────────────────────────────
  // On the desktop the mineradio engine lays its particles over the user's REAL
  // desktop picture, read through a Tauri command. A phone has no desktop
  // picture, so the equivalent is a photo the user picks once. Kept as a data
  // URL in localStorage: it is theirs, it never leaves the phone, and it has to
  // survive a cold launch or the wallpaper looks different every time.

  var LS_PHOTO = 'terse-phone-photo';

  function photo() {
    try { return localStorage.getItem(LS_PHOTO) || null; } catch (e) { return null; }
  }
  function setPhoto(dataUrl) {
    try {
      if (dataUrl) localStorage.setItem(LS_PHOTO, dataUrl);
      else localStorage.removeItem(LS_PHOTO);
      return true;
    } catch (e) {
      // Quota. A 4MB photo in a 5MB store is the likely cause, and silently
      // keeping the old one would look like the picker is broken.
      return false;
    }
  }

  // ── Entitlement ──────────────────────────────────────────────────────────

  var licence = null;

  /** Same shape and same rule as the desktop: an active or trialing
   *  subscription on a tier that is neither empty nor 'expired'. The engine is
   *  handed `pro` from this, so the phone and the Mac cannot disagree about what
   *  a paying user is. */
  function getLicense() {
    var u = user();
    if (!u) return Promise.resolve(null);
    return fetch(API + '/api/license/' + encodeURIComponent(u.id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { licence = j; return j; })
      .catch(function () { return licence; });   // offline → last known answer
  }

  function isPro() {
    if (!licence) return false;
    var tier = (licence.tier || '').toLowerCase();
    var st = (licence.status || '').toLowerCase();
    return (st === 'active' || st === 'trialing') && tier !== '' && tier !== 'expired';
  }

  // ── window.terse ─────────────────────────────────────────────────────────

  /** Cumulative tokens, monotonic. The wallpaper page diffs consecutive reads to
   *  decide how hard to pulse, so this must never go DOWN: a decrease would be
   *  read as a delta of zero forever after. Frames can legitimately arrive out
   *  of order or reset at midnight, hence the max(). */
  var pulseTotal = 0;
  function tokenTotal() {
    var s = (frame && frame.stats) || {};
    var total = (+s.tokensIn || 0) + (+s.tokensOut || 0);
    if (!total && frame && frame.sessions) {
      // Older desktops push sessions without a stats block. Their token counts
      // still add up to something worth pulsing on.
      total = frame.sessions.reduce(function (a, x) { return a + (+x.tokens || 0); }, 0);
    }
    pulseTotal = Math.max(pulseTotal, total);
    return pulseTotal;
  }

  var T = {
    // ── what the wallpaper actually uses ──
    getTokenPulse: function () { return Promise.resolve(tokenTotal()); },
    getStats: function () {
      var s = (frame && frame.stats) || {};
      return Promise.resolve({ summary: s });
    },
    getAgentSessions: function () {
      return Promise.resolve((frame && frame.sessions) || []);
    },
    getLicense: function () { return Promise.resolve(licence); },
    getDesktopPicture: function () { return Promise.resolve(photo()); },

    // ── phone-only additions ──
    link: Link,
    isPro: isPro,
    refreshLicense: getLicense,
    setPhoto: setPhoto,
    photo: photo,
    signedIn: function () { return !!user(); },
    user: user,
    authToken: token,

    /** Desktop-only commands the shared code may call. They exist so a call site
     *  does not have to know which host it is on; they answer "nothing" rather
     *  than throwing, because a rejected promise here would abort the caller's
     *  whole poll and take the visible parts down with it. */
    getBudget: function () { return Promise.resolve(null); },
    getAgentAnalytics: function () { return Promise.resolve(null); },
    getAgentPlanInfo: function () { return Promise.resolve(null); },
  };

  // ── Resume handling ──────────────────────────────────────────────────────
  // Everything that must happen when the app comes back to the foreground, in
  // one place: the socket is presumed dead (see openStream), and the REST
  // snapshot fills the gap while the new stream is opening.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { closeStream(); return; }
    if (!user()) return;
    refresh();
    openStream();
  });

  T.start = function () {
    if (!user()) return Promise.resolve(null);
    return getLicense().then(refresh).then(function () { return openStream(); });
  };

  root.terse = T;
  root.TerseLink = Link;
})(window);
