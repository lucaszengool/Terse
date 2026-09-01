/**
 * install.js — getting Terse onto the Home Screen.
 *
 * WHY THIS IS NOT ONE BUTTON EVERYWHERE. Android fires `beforeinstallprompt`,
 * which can be captured and replayed on a tap: a genuine one-tap install. iOS
 * fires nothing. There is no API, no permission, no prompt — Add to Home Screen
 * exists only in Safari's own Share menu, and no page can open it. Shipping a
 * button that silently did nothing on the platform this app is mostly for would
 * be worse than not having one.
 *
 * So the sheet says something different in each of the three situations, and
 * every one of them is actionable:
 *
 *   · Android / desktop Chrome  → a real Install button
 *   · iOS Safari                → the two taps, with the Share glyph drawn so
 *                                 there is nothing to hunt for
 *   · iOS, any other browser    → Chrome, Firefox and every in-app browser on
 *     iPhone CANNOT install a web app at all. The only useful thing to say is
 *     "open this in Safari", with the link ready to paste.
 *
 * It never appears once installed, and a dismissal is remembered — an install
 * prompt that returns on every launch is an advert.
 */
(function (root) {
  'use strict';

  var LS_DISMISSED = 'terse-install-dismissed';

  function standalone() {
    return (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches)
      || root.navigator.standalone === true;
  }

  var ua = root.navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/i.test(ua)
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    || (/Macintosh/.test(ua) && root.navigator.maxTouchPoints > 1);
  /* Every browser on iOS runs WebKit, so a user agent alone cannot tell Safari
     from the rest — they are identified by what they ADD to it. In-app browsers
     matter as much as the branded ones: a link opened from WeChat or Instagram
     lands in a webview that can never install anything. */
  var iOSOther = /CriOS|FxiOS|EdgiOS|OPiOS|mercury|FBAN|FBAV|Instagram|Line\/|MicroMessenger|QQ\/|Twitter/i.test(ua);
  var isSafariIOS = isIOS && !iOSOther;

  var deferred = null;   // Android's captured beforeinstallprompt

  function dismissed() {
    try { return localStorage.getItem(LS_DISMISSED) === '1'; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(LS_DISMISSED, '1'); } catch (e) {}
  }

  /* Safari's Share glyph, drawn rather than described. "Tap the Share button"
     is only useful if you already know which one that is — and on iPad it is at
     the TOP, which is why the copy says "in the toolbar" and this sits inline
     with the words instead of pointing at a fixed place on screen. */
  var SHARE_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" '
    + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
    + 'aria-hidden="true" focusable="false">'
    + '<path d="M12 15V3"/><path d="M8.5 6.5 12 3l3.5 3.5"/>'
    + '<path d="M6 12H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>';

  var PLUS_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" '
    + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false">'
    + '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>';

  /**
   * Show the sheet.
   *
   *   t      translator
   *   force  ignore a previous dismissal (the "how do I install this?" button)
   */
  function show(t, force) {
    if (standalone()) return false;             // already installed
    if (!force && dismissed()) return false;
    if (document.getElementById('installSheet')) return false;

    /* Only three of these are real. A desktop browser with no captured
       beforeinstallprompt has nothing to offer — showing an Install button there
       gives a tap that does nothing, which is worse than no sheet. */
    var mode = deferred ? 'prompt' : (isSafariIOS ? 'safari' : (isIOS ? 'other' : null));
    if (!mode) return false;

    var wrap = document.createElement('div');
    wrap.id = 'installSheet';
    wrap.className = 'insheet';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');

    var body = '';
    if (mode === 'prompt') {
      body = '<p>' + t('ins_body_prompt') + '</p>'
        + '<button class="btn primary wide" id="insGo" type="button">' + t('ins_install') + '</button>';
    } else if (mode === 'safari') {
      body = '<p>' + t('ins_body_safari') + '</p>'
        + '<ol class="insteps">'
        + '<li><span class="insico">' + SHARE_SVG + '</span><span>' + t('ins_step_share') + '</span></li>'
        + '<li><span class="insico">' + PLUS_SVG + '</span><span>' + t('ins_step_add') + '</span></li>'
        + '</ol>';
    } else {
      // Nothing to install with. The only move is to get them into Safari.
      body = '<p>' + t('ins_body_other') + '</p>'
        + '<button class="btn primary wide" id="insCopy" type="button">' + t('ins_copy') + '</button>';
    }

    wrap.innerHTML =
      '<div class="insheet-card">'
      + '<div class="insheet-head">'
      + '<span class="insheet-icon"><img src="/icon-192.png" alt="" width="38" height="38"></span>'
      + '<div class="insheet-title"><b>' + t('ins_title') + '</b><span>' + t('ins_sub') + '</span></div>'
      + '<button class="insheet-x" id="insClose" type="button" aria-label="' + t('ins_dismiss') + '">✕</button>'
      + '</div>'
      + body
      + '</div>';
    document.body.appendChild(wrap);
    // Added on the next frame so the transition has a start state to run from.
    requestAnimationFrame(function () { wrap.classList.add('on'); });

    function close(permanent) {
      wrap.classList.remove('on');
      if (permanent) remember();
      setTimeout(function () { wrap.remove(); }, 260);
    }

    document.getElementById('insClose').onclick = function () { close(true); };

    var go = document.getElementById('insGo');
    if (go) {
      go.onclick = function () {
        if (!deferred) { close(true); return; }
        deferred.prompt();
        deferred.userChoice.then(function () {
          // Either way the sheet has done its job: accepted installs, dismissed
          // means they were asked and said no.
          deferred = null;
          close(true);
        }).catch(function () { close(false); });
      };
    }

    var copy = document.getElementById('insCopy');
    if (copy) {
      copy.onclick = function () {
        var url = root.location.origin + '/m';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            copy.textContent = t('ins_copied');
          }, function () { copy.textContent = url; });
        } else {
          copy.textContent = url;
        }
      };
    }
    return true;
  }

  // Captured as early as possible: the event fires once, and a page that has not
  // called preventDefault by then loses the chance to replay it on a tap.
  root.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
  });

  // Nothing more to offer once it is on the Home Screen.
  root.addEventListener('appinstalled', function () {
    deferred = null;
    remember();
    var el = document.getElementById('installSheet');
    if (el) el.remove();
  });

  root.TerseInstall = {
    show: show,
    standalone: standalone,
    /** Whether there is anything useful to say on this device at all. */
    available: function () { return !standalone(); },
    canOneTap: function () { return !!deferred; },
    isSafariIOS: function () { return isSafariIOS; },
  };
})(window);
