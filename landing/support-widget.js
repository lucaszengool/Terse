/**
 * Terse Support / QA widget
 * Self-contained floating "Help" button + panel. Drop on any page with:
 *   <script src="/support-widget.js" defer></script>
 *
 * Posts user questions to Slack via the server-side /api/support proxy
 * (the webhook URL stays secret in the backend's SLACK_QA_WEBHOOK_URL).
 * The "Join our Slack" button appears only when SLACK_INVITE_URL is set.
 */
(function () {
  if (window.__terseSupportWidget) return; // guard against double-inject
  window.__terseSupportWidget = true;

  var API_BASE = window.location.origin;

  var css = '' +
    '.tsw-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
      'padding:12px 18px;border:none;border-radius:99px;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,sans-serif;' +
      'font-size:14px;font-weight:700;color:#0b0d17;background:linear-gradient(135deg,#6ee7b7,#34d399);' +
      'box-shadow:0 8px 30px rgba(110,231,183,.35),0 2px 8px rgba(0,0,0,.4);transition:transform .15s,box-shadow .2s;}' +
    '.tsw-fab:hover{transform:translateY(-2px);box-shadow:0 12px 38px rgba(110,231,183,.45);}' +
    '.tsw-fab svg{flex-shrink:0;}' +
    '.tsw-panel{position:fixed;right:20px;bottom:84px;z-index:2147483000;width:340px;max-width:calc(100vw - 40px);' +
      'background:#14162a;border:1px solid rgba(255,255,255,.1);border-radius:18px;overflow:hidden;display:none;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.5);font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,sans-serif;}' +
    '.tsw-panel.tsw-open{display:block;animation:tsw-pop .18s ease;}' +
    '@keyframes tsw-pop{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}' +
    '.tsw-head{padding:18px 20px 14px;background:linear-gradient(135deg,rgba(110,231,183,.1),transparent);border-bottom:1px solid rgba(255,255,255,.07);}' +
    '.tsw-head h3{margin:0;font-size:16px;font-weight:800;color:#fff;}' +
    '.tsw-head p{margin:4px 0 0;font-size:12.5px;color:rgba(255,255,255,.5);line-height:1.5;}' +
    '.tsw-close{position:absolute;top:14px;right:16px;background:none;border:none;color:rgba(255,255,255,.4);' +
      'font-size:20px;cursor:pointer;line-height:1;padding:2px;}' +
    '.tsw-close:hover{color:#fff;}' +
    '.tsw-body{padding:16px 20px 20px;}' +
    '.tsw-body label{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;color:rgba(255,255,255,.45);margin:0 0 6px;}' +
    '.tsw-input,.tsw-textarea{width:100%;background:#0f1120;border:1px solid rgba(255,255,255,.1);border-radius:10px;' +
      'color:#fff;font-size:13.5px;font-family:inherit;padding:10px 12px;margin-bottom:12px;resize:vertical;}' +
    '.tsw-input:focus,.tsw-textarea:focus{outline:none;border-color:rgba(110,231,183,.5);}' +
    '.tsw-textarea{min-height:90px;}' +
    '.tsw-send{width:100%;padding:11px;border:none;border-radius:10px;cursor:pointer;font-family:inherit;' +
      'font-size:14px;font-weight:700;color:#0b0d17;background:linear-gradient(135deg,#6ee7b7,#34d399);transition:opacity .15s;}' +
    '.tsw-send:hover{opacity:.92;}' +
    '.tsw-send:disabled{opacity:.55;cursor:not-allowed;}' +
    '.tsw-status{font-size:12.5px;text-align:center;margin-top:10px;line-height:1.5;min-height:16px;}' +
    '.tsw-status.ok{color:#6ee7b7;}.tsw-status.err{color:#fca5a5;}' +
    '.tsw-divider{display:flex;align-items:center;gap:10px;margin:16px 0 12px;color:rgba(255,255,255,.3);font-size:11px;}' +
    '.tsw-divider::before,.tsw-divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08);}' +
    '.tsw-join{display:none;align-items:center;justify-content:center;gap:8px;width:100%;padding:11px;text-decoration:none;' +
      'border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;font-size:13.5px;font-weight:600;transition:border-color .15s,background .15s;}' +
    '.tsw-join:hover{border-color:rgba(110,231,183,.5);background:rgba(110,231,183,.06);}';

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function init() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var fab = el('<button class="tsw-fab" aria-label="Ask us a question">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
      '<span>Help</span></button>');

    var panel = el('<div class="tsw-panel" role="dialog" aria-label="Support">' +
      '<button class="tsw-close" aria-label="Close">&times;</button>' +
      '<div class="tsw-head"><h3>Ask us anything</h3><p>Questions about Terse? Send us a message and our team will get back to you.</p></div>' +
      '<div class="tsw-body">' +
        '<label for="tsw-email">YOUR EMAIL (so we can reply)</label>' +
        '<input id="tsw-email" class="tsw-input" type="email" placeholder="you@example.com" autocomplete="email">' +
        '<label for="tsw-msg">YOUR QUESTION</label>' +
        '<textarea id="tsw-msg" class="tsw-textarea" placeholder="How can we help?"></textarea>' +
        '<button class="tsw-send">Send to our team</button>' +
        '<div class="tsw-status"></div>' +
        '<div class="tsw-divider">or</div>' +
        '<a class="tsw-join" target="_blank" rel="noopener">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 15a2 2 0 1 1-2-2h2v2zm1 0a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0v-5zM9 6a2 2 0 1 1 2-2v2H9zm0 1a2 2 0 0 1 0 4H4a2 2 0 0 1 0-4h5zm9 2a2 2 0 1 1 2 2h-2V9zm-1 0a2 2 0 0 1-4 0V4a2 2 0 0 1 4 0v5zm-2 9a2 2 0 1 1-2 2v-2h2zm0-1a2 2 0 0 1 0-4h5a2 2 0 0 1 0 4h-5z"/></svg>' +
          'Join our Slack community</a>' +
      '</div></div>');

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    var emailInput = panel.querySelector('#tsw-email');
    var msgInput = panel.querySelector('#tsw-msg');
    var sendBtn = panel.querySelector('.tsw-send');
    var status = panel.querySelector('.tsw-status');
    var joinBtn = panel.querySelector('.tsw-join');

    function open() { panel.classList.add('tsw-open'); msgInput.focus(); }
    function close() { panel.classList.remove('tsw-open'); }

    // Exposed so footer links / other buttons can open the panel:
    //   <a href="#" onclick="terseSupport.open();return false">Questions?</a>
    window.terseSupport = { open: open, close: close };

    fab.addEventListener('click', function () {
      panel.classList.contains('tsw-open') ? close() : open();
    });
    panel.querySelector('.tsw-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // Load the Slack invite link from the backend (only shows the button if set).
    fetch(API_BASE + '/api/support/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (cfg && cfg.inviteUrl) {
          joinBtn.href = cfg.inviteUrl;
          joinBtn.style.display = 'flex';
        }
      })
      .catch(function () {});

    sendBtn.addEventListener('click', function () {
      var message = msgInput.value.trim();
      var email = emailInput.value.trim();
      status.className = 'tsw-status';
      if (!message) { status.className = 'tsw-status err'; status.textContent = 'Please type your question first.'; return; }

      sendBtn.disabled = true;
      var original = sendBtn.textContent;
      sendBtn.textContent = 'Sending…';

      fetch(API_BASE + '/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, message: message, page: location.pathname }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d.ok) {
            status.className = 'tsw-status ok';
            status.textContent = 'Thanks! We got your message and will reply soon.';
            msgInput.value = '';
            setTimeout(close, 2200);
          } else {
            status.className = 'tsw-status err';
            status.textContent = res.d && res.d.error === 'support_unavailable'
              ? 'Support is being set up — please email support@terseai.org for now.'
              : 'Could not send. Please try again, or email support@terseai.org.';
          }
        })
        .catch(function () {
          status.className = 'tsw-status err';
          status.textContent = 'Network error. Please try again, or email support@terseai.org.';
        })
        .finally(function () { sendBtn.disabled = false; sendBtn.textContent = original; });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
