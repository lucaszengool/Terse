/**
 * account.js — "Delete account" in the Me tab.
 *
 * Google Play (and the App Store) require that an account made in the app can
 * be deleted from inside it. It sits right under Sign out and shows only when
 * Sign out does. The work is server-side (api/account.js); this file only asks,
 * sends the session token, and cleans up after itself.
 *
 * The confirmation is an in-page sheet, not confirm(): the Android WebView shows
 * no JS dialogs unless the activity installs a WebChromeClient that handles
 * them, and a confirm() that silently returns false is a button that does
 * nothing.
 */
(function () {
  'use strict';

  var zh = /^zh/i.test(document.documentElement.lang || '');
  var S = zh ? {
    btn: '删除账号',
    title: '删除你的 Terse 账号？',
    body: '账号以及你的帖子、评论、私信、房间消息、好友和壁纸都会从服务器上永久删除，所有设备同时生效，无法恢复。在网站上订阅的会立即取消；在 Google Play 或 App Store 订阅的请到对应商店里取消。',
    confirm: '永久删除',
    cancel: '取消',
    busy: '正在删除…',
    failed: '没删成，请重试，或发邮件到 privacy@terseai.org',
    signin: '登录已过期，请重新登录后再试',
    done: '账号已删除',
  } : {
    btn: 'Delete account',
    title: 'Delete your Terse account?',
    body: 'Your account and your posts, comments, messages, room chat, friends and wallpapers are permanently deleted from our servers, on every device. This can\'t be undone. A website subscription is cancelled now; one bought in Google Play or the App Store must be cancelled there.',
    confirm: 'Delete permanently',
    cancel: 'Cancel',
    busy: 'Deleting…',
    failed: 'That didn\'t finish. Try again, or email privacy@terseai.org',
    signin: 'Your session expired — sign in again first',
    done: 'Account deleted',
  };

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function note(text) {
    var n = document.createElement('div');
    n.textContent = text;
    n.style.cssText = 'position:fixed;left:50%;bottom:calc(var(--safe-b,0px) + 90px);transform:translateX(-50%);'
      + 'background:#222;color:#fff;padding:10px 16px;border-radius:12px;z-index:9999;font-size:14px;max-width:88vw;text-align:center';
    document.body.appendChild(n);
    setTimeout(function () { n.remove(); }, 3500);
  }

  function sheet() {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center';
    var card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'width:100%;max-width:520px;margin:0;border-radius:18px 18px 0 0;padding:22px 20px calc(var(--safe-b,0px) + 22px)';
    var h = document.createElement('h2'); h.textContent = S.title;
    var p = document.createElement('p'); p.className = 'tiny'; p.textContent = S.body; p.style.margin = '8px 0 18px';
    var go = document.createElement('button');
    go.type = 'button'; go.className = 'btn wide'; go.textContent = S.confirm;
    go.style.cssText = 'background:#ff6b6b;color:#2a0606;margin-bottom:10px';
    var no = document.createElement('button');
    no.type = 'button'; no.className = 'btn ghost wide'; no.textContent = S.cancel;
    card.appendChild(h); card.appendChild(p); card.appendChild(go); card.appendChild(no);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    function close() { wrap.remove(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    no.onclick = close;
    go.onclick = function () {
      go.disabled = no.disabled = true;
      go.textContent = S.busy;
      run().then(function () {
        close();
        note(S.done);
        setTimeout(function () { location.reload(); }, 900);
      }, function (e) {
        go.disabled = no.disabled = false;
        go.textContent = S.confirm;
        note(e && e.message === 'signin' ? S.signin : S.failed);
      });
    };
  }

  function run() {
    var C = window.Clerk;
    if (!C || !C.session) return Promise.reject(new Error('signin'));
    return C.session.getToken().then(function (tok) {
      if (!tok) throw new Error('signin');
      // Install secrets this device holds reach anything posted before sign-in.
      var ids = [ls('terse-identity'), ls('terse-identity-legacy')].filter(Boolean);
      return fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ identities: ids }),
      });
    }).then(function (r) {
      if (r.status === 401) throw new Error('signin');
      if (!r.ok) throw new Error('failed');
      try {
        localStorage.removeItem('terse-identity');
        localStorage.removeItem('terse-identity-legacy');
      } catch (e) {}
      // The keyboard and wallpaper read the account out of the app's own prefs.
      try { if (window.TerseAndroid && window.TerseAndroid.signOut) window.TerseAndroid.signOut(); } catch (e) {}
      return C.signOut().catch(function () {});
    });
  }

  function mount() {
    var out = document.getElementById('signOutBtn');
    if (!out || document.getElementById('deleteAcctBtn')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'deleteAcctBtn';
    b.className = 'btn ghost wide';
    b.textContent = S.btn;
    b.style.cssText = 'color:#ff6b6b;margin-top:10px';
    b.onclick = sheet;
    out.parentNode.insertBefore(b, out.nextSibling);
    // Visible exactly when Sign out is: app.js toggles .hide on it with the user.
    var sync = function () { b.classList.toggle('hide', out.classList.contains('hide')); };
    sync();
    new MutationObserver(sync).observe(out, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
