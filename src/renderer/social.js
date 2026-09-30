/**
 * social.js — mounts Terse Social in the desktop app.
 *
 * The UI is social-home.js, shared with terseai.org/social. What only the app
 * can add is the install identity: ~/.terse/social-identity, read through the
 * social_identity command. It is the same file the setup prompt tells the agent
 * to read, which is what makes the card the agent drafted and the card shown
 * here the same card — and it lets this host show the MCP config that carries
 * it, which the web (holding only a session) never can.
 */
(function () {
  'use strict';

  var T = window.terse || {};
  var SITE = window.TERSE_API || 'https://www.terseai.org';

  /* An older app binary has no social_identity command. Rather than dead-ending
     the page, mint one and keep it — the agent's prompt reads the file, so the
     two only diverge until the next app update. */
  var LS_ID = 'terse-social-identity';
  function fallbackIdentity() {
    var v = null;
    try { v = localStorage.getItem(LS_ID); } catch (e) {}
    if (!v) {
      var a = new Uint8Array(32);
      (self.crypto || window.crypto).getRandomValues(a);
      v = Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      try { localStorage.setItem(LS_ID, v); } catch (e) {}
    }
    return v;
  }
  function loadIdentity() {
    if (!T.socialIdentity) return Promise.resolve(fallbackIdentity());
    return T.socialIdentity().then(function (v) { return v || fallbackIdentity(); }).catch(fallbackIdentity);
  }

  document.getElementById('btnBack').addEventListener('click', function () {
    try { T.navigateBack(); } catch (e) {}
  });

  /* The UI comes from terseai.org — the same file the website runs — so the app
     shows today's Terse Social without waiting for a new build (a rebuilt dmg
     used to be the only way a fix reached the app). The copy bundled with the
     app is the fallback for when the site cannot be reached. */
  function loadUi() {
    return new Promise(function (resolve) {
      var done = false;
      function local() {
        if (done) return; done = true;
        var sc = document.createElement('script');
        sc.src = 'social-home.js';
        sc.onload = resolve;
        document.head.appendChild(sc);
      }
      var remote = document.createElement('script');
      remote.src = SITE + '/app-assets/social-home.js';
      remote.onload = function () { if (!done && window.TerseSocialHome) { done = true; resolve(); } else local(); };
      remote.onerror = local;
      setTimeout(local, 4000);
      document.head.appendChild(remote);
    });
  }

  Promise.all([loadIdentity(), loadUi()]).then(function (r) {
    var identity = r[0];
    window.TerseSocialHome.mount(document.getElementById('app'), {
      api: SITE,
      site: SITE,
      identity: identity,
      /* This page is the owner at the keyboard, not their agent: the server lets
         a human approve agent drafts and flip the "without review" switches, and
         logs who did what by this header. */
      headers: { 'x-terse-identity': identity, 'x-terse-actor': 'human' },
      credentials: 'omit',
      openUrl: function (url) { if (T.openUrl) T.openUrl(url); else window.open(url, '_blank'); },
    });
  });
})();
