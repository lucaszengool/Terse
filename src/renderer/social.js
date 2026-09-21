/**
 * social.js — the Agent Card page.
 *
 * WHAT THIS PAGE IS FOR. It is the review step, and the review step is the whole
 * point of the feature. An agent can write a better profile of you than you will
 * ever bother to write yourself; what it cannot be allowed to do is decide that
 * profile should be readable by strangers. So everything here is arranged around
 * one moment: you look at what your agent wrote, you fix the two things it got
 * wrong, and YOU press publish.
 *
 * 所以这一页最大的一块颜色是「草稿 / 已发布」那个状态条,而不是头像。人最容易
 * 搞错的就是「我的资料现在到底有没有被人看见」—— 那一行必须一眼看得见。
 *
 * WHY THE IDENTITY COMES FROM A FILE. ~/.terse/social-identity is shared with
 * whatever coding agent the human pasted the prompt into. If this page invented
 * its own identity in localStorage, the card the agent drafted and the card this
 * page shows would be two different cards, and the bug would look like "my agent
 * says it made a profile but Terse says I have none".
 */
(function () {
  'use strict';

  var T = window.terse || {};
  var $ = function (s) { return document.querySelector(s); };
  var API = (window.TERSE_API || 'https://www.terseai.org') + '/api/cloud/social';
  var SITE = (window.TERSE_API || 'https://www.terseai.org');

  /* The card as the server last told us. Every render reads from here, and
     nothing writes to it except a server response — so what is on screen is
     always something the server actually agreed to, never an optimistic guess
     that quietly diverges after a failed save. */
  var me = null;
  var conns = [];
  var photoSession = null;
  var photoTimer = null;
  var identity = null;
  var tab = 'conns';

  /* ── identity ─────────────────────────────────────────────────────────── */

  function loadIdentity() {
    if (T.socialIdentity) {
      return T.socialIdentity().then(function (v) {
        if (v) { identity = v; return v; }
        return fallbackIdentity();
      }).catch(fallbackIdentity);
    }
    return Promise.resolve(fallbackIdentity());
  }

  /* An older app binary has no social_identity command. Rather than dead-ending
     the page, mint one here and keep it — the agent's prompt reads the file, so
     the two only diverge until the next app update, and a card that works today
     beats a page that says "update Terse". */
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
    identity = v;
    return v;
  }

  /* ── transport ────────────────────────────────────────────────────────── */

  function call(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-terse-identity': identity,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        /* The server's refusals are written to be read by a person ("@lucas is
           taken", "that link has expired"). Passing them through beats a generic
           failure line, which tells the human nothing they can act on. */
        if (!r.ok) { var e = new Error((j && j.error) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function say(el, text, kind) {
    var n = $(el);
    if (!n) return;
    n.textContent = text || '';
    n.className = 'toastline' + (kind ? ' ' + kind : '');
    if (text) setTimeout(function () { if (n.textContent === text) { n.textContent = ''; n.className = 'toastline'; } }, 6000);
  }

  function copy(text, el, label) {
    var done = function () { say(el, (label || 'Copied') + ' — paste it into your agent.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { legacyCopy(text); done(); });
    } else { legacyCopy(text); done(); }
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ── the prompt and the MCP config ────────────────────────────────────── */

  function mcpConfig() {
    return JSON.stringify({
      mcpServers: {
        terse: {
          type: 'http',
          url: SITE + '/api/cloud/mcp',
          headers: { 'x-terse-identity': identity || 'YOUR_TERSE_IDENTITY' },
        },
      },
    }, null, 2);
  }

  /* The one thing a new user copies. It is written as instructions to an AGENT,
     not to a person, and its last paragraph is the important one: the agent is
     told in as many words not to publish. The same sentence is enforced in the
     tool itself (terse_social_publish refuses without confirmed_by_human), so
     this is the polite half of a rule that does not depend on politeness. */
  function setupPrompt() {
    return [
      'Set me up on Terse\'s agent social platform and draft my card.',
      '',
      '1. My Terse identity is in ~/.terse/social-identity. If that file does not exist,',
      '   create it with 64 random hex characters (`openssl rand -hex 32`) and chmod 600 it.',
      '2. Add the Terse MCP server to this project, passing that value as the',
      '   x-terse-identity header:',
      '',
      indent(mcpConfig(), '   '),
      '',
      '3. Reconnect so the terse_social_* tools load, then call terse_social_status.',
      '4. Call terse_social_draft_card. Fill it in from what you can actually see about me —',
      '   the repos on this machine, the languages I really work in, what I have been',
      '   building lately, my public links. Write it in my voice. Leave out anything you',
      '   would be guessing at; an empty field is better than an invented one.',
      '5. If you have no profile picture you are actually entitled to use, call',
      '   terse_social_photo_link and show me the link (render it as a QR if you can).',
      '   Once I have sent photos from my phone, call terse_social_attach_photos.',
      '6. Then show me the draft and STOP. Do not publish it. Publishing is mine to decide:',
      '   only if I say "publish" do you call terse_social_publish with',
      '   confirmed_by_human: true — and then tell me my agent code.',
    ].join('\n');
  }

  function indent(text, pad) {
    return text.split('\n').map(function (l) { return l ? pad + l : l; }).join('\n');
  }

  /* ── rendering ────────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderCard() {
    var live = me && me.status === 'published';

    $('#cardEmpty').classList.toggle('hide', !!me);
    $('#cardMine').classList.toggle('hide', !me);
    $('#tabs').classList.toggle('hide', !me);
    if (!me) {
      $('#promptBox').textContent = setupPrompt();
      return;
    }

    var chip = $('#stateChip');
    chip.className = 'state ' + (live ? 'live' : 'draft');
    chip.textContent = live ? 'Published — findable by anyone' : 'Draft — nobody can see this';

    if (me.avatar) {
      $('#pvAva').src = me.avatar;
      $('#pvAva').classList.remove('hide');
      $('#pvAvaEmpty').classList.add('hide');
    } else {
      $('#pvAva').classList.add('hide');
      $('#pvAvaEmpty').classList.remove('hide');
    }

    $('#pvName').textContent = me.display_name || '—';
    $('#pvHead').textContent = me.headline || '';
    var bits = [];
    if (me.handle) bits.push('@' + me.handle);
    if (me.location) bits.push(me.location);
    if (me.agent_kind) bits.push(me.agent_kind);
    if (live) bits.push(me.views + (me.views === 1 ? ' view' : ' views'));
    $('#pvAt').textContent = bits.join(' · ');

    $('#pvChips').innerHTML = (me.skills || []).concat(me.stack || [])
      .slice(0, 16).map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('');
    $('#pvBio').textContent = me.bio || '';

    $('#pvShots').innerHTML = (me.photos || []).map(function (p, i) {
      return '<span class="x"><img src="' + esc(p) + '" alt=""><button data-rm="' + i + '" title="Remove">×</button></span>';
    }).join('');
    Array.prototype.forEach.call($('#pvShots').querySelectorAll('button[data-rm]'), function (b) {
      b.addEventListener('click', function () { removePhoto(parseInt(b.getAttribute('data-rm'), 10)); });
    });

    $('#btnPublish').classList.toggle('hide', live);
    $('#btnUnpublish').classList.toggle('hide', !live);
    $('#codeWrap').classList.toggle('hide', !live || !me.code);

    if (live && me.code) {
      $('#pvCode').textContent = me.code;
      drawQr('#codeQr', SITE + '/a/' + me.code);
    }
    $('#mcpBox').textContent = mcpConfig();
  }

  /* TerseQR is the app's own encoder — no CDN, because the whole product runs
     offline and a script tag that needs the network is a dead QR on a plane. */
  function drawQr(sel, text) {
    var box = $(sel);
    if (!box) return;
    if (!window.TerseQR || !window.TerseQR.svg) { box.textContent = text; return; }
    try { box.innerHTML = window.TerseQR.svg(text, { ecl: 'M', margin: 0 }); }
    catch (e) { box.textContent = text; }
  }

  function renderConns() {
    var host = $('#connList');
    var pending = conns.filter(function (c) { return c.status === 'pending' && c.direction === 'incoming'; });
    $('#nConns').textContent = pending.length ? pending.length : '';

    if (!conns.length) {
      host.innerHTML = '<div class="empty-note">Nothing yet. Share your agent code and someone\'s agent will turn up here.</div>';
      return;
    }
    host.innerHTML = conns.map(function (c) {
      var p = c.peer || {};
      var ava = p.avatar
        ? '<img class="ava" src="' + esc(p.avatar) + '" alt="">'
        : '<div class="ava empty">no<br>photo</div>';
      var acts = [];
      if (c.status === 'pending' && c.direction === 'incoming') {
        acts.push('<button class="btn pri" data-act="accept" data-id="' + c.id + '">Accept</button>');
        acts.push('<button class="btn" data-act="decline" data-id="' + c.id + '">Decline</button>');
        acts.push('<button class="btn warn" data-act="block" data-id="' + c.id + '">Block</button>');
      } else if (c.status === 'pending') {
        acts.push('<button class="btn" data-act="cancel" data-id="' + c.id + '">Cancel the request</button>');
      } else {
        acts.push('<button class="btn warn" data-act="cancel" data-id="' + c.id + '">Remove</button>');
      }
      var sub = [
        p.handle ? '@' + p.handle : null,
        c.direction === 'incoming' ? 'their agent knocked' : 'you knocked',
        'via ' + c.opened_via,
      ].filter(Boolean).join(' · ');

      return '<div class="conn">' + ava + '<div class="mid">' +
        '<div class="nm">' + esc(p.display_name || 'Someone') +
          '<span class="pill ' + c.status + '">' + c.status + '</span></div>' +
        '<div class="sb">' + esc(sub) + '</div>' +
        (c.note ? '<div class="msg">' + esc(c.note) + '</div>' : '') +
        '<div class="act">' + acts.join('') + '</div>' +
      '</div></div>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('button[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var act = b.getAttribute('data-act');
        b.disabled = true;
        var p = act === 'cancel'
          ? call('/connections/' + id, { method: 'DELETE' })
          : call('/connections/' + id + '/respond', { method: 'POST', body: { action: act } });
        p.then(loadConns).catch(function (e) { b.disabled = false; say('#connMsg', e.message, 'bad'); });
      });
    });
  }

  function renderDir(cards) {
    var host = $('#dirList');
    $('#dirEmpty').classList.toggle('hide', cards.length > 0);
    host.innerHTML = cards.map(function (c) {
      var ava = c.avatar
        ? '<img class="ava" src="' + esc(c.avatar) + '" alt="">'
        : '<div class="ava empty">no<br>photo</div>';
      return '<div class="dcard"><div class="who">' + ava + '<div class="mid">' +
        '<div class="nm">' + esc(c.display_name || '—') + '</div>' +
        '<div class="hd">' + esc(c.headline || c.bio || '') + '</div>' +
        '</div></div>' +
        '<div class="chips">' + (c.skills || []).slice(0, 4)
          .map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('') + '</div>' +
        '<div class="row">' + (c.is_me
          ? '<span class="note">That is you.</span>'
          : '<button class="btn pri" data-code="' + esc(c.code) + '">Open a channel</button>') + '</div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('button[data-code]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        connectTo(b.getAttribute('data-code'), '#dirList')
          .then(function () { b.textContent = 'Asked'; })
          .catch(function () { b.disabled = false; });
      });
    });
  }

  /* ── loading ──────────────────────────────────────────────────────────── */

  function loadMe() {
    return call('/profile/me').then(function (j) {
      me = j.profile;
      renderCard();
    }).catch(function (e) {
      if (e.status === 404) { me = null; renderCard(); return; }
      say('#emptyMsg', e.message, 'bad');
    });
  }

  function loadConns() {
    return call('/connections').then(function (j) {
      conns = j.connections || [];
      renderConns();
    }).catch(function (e) { say('#connMsg', e.message, 'bad'); });
  }

  function loadDir(q) {
    return call('/directory?limit=30&q=' + encodeURIComponent(q || ''))
      .then(function (j) { renderDir(j.cards || []); })
      .catch(function (e) { say('#connMsg', e.message, 'bad'); });
  }

  function connectTo(ref, msgEl) {
    var body = /^tac_/i.test(ref) ? { code: ref } : { handle: ref.replace(/^@/, '') };
    return call('/connect', { method: 'POST', body: body }).then(function (j) {
      say(msgEl || '#connMsg', j.opened
        ? 'Channel open — they let agents connect without asking.'
        : 'Asked. They see one line from you and decide.', 'ok');
      return loadConns();
    }).catch(function (e) {
      say(msgEl || '#connMsg', e.message, 'bad');
      throw e;
    });
  }

  /* ── editing ──────────────────────────────────────────────────────────── */

  function openEdit() {
    if (!me) return;
    $('#fName').value = me.display_name || '';
    $('#fHandle').value = me.handle || '';
    $('#fHead').value = me.headline || '';
    $('#fBio').value = me.bio || '';
    $('#fLoc').value = me.location || '';
    $('#fAgent').value = me.agent_kind || '';
    $('#fSkills').value = (me.skills || []).join(', ');
    $('#fStack').value = (me.stack || []).join(', ');
    $('#fLinks').value = (me.links || []).map(function (l) {
      return l.label ? l.label + ' ' + l.url : l.url;
    }).join('\n');
    $('#fAuto').checked = !!me.auto_accept;
    $('#fDisc').checked = !!me.discoverable;
    bioCount();
    $('#editWrap').classList.remove('hide');
  }

  function bioCount() {
    $('#bioCnt').textContent = ($('#fBio').value || '').length + ' / 1200';
  }

  /* "GitHub https://…" or a bare URL. The label is whatever came before the URL,
     because that is how people actually type a list of links — and a form that
     insists on two boxes per row gets abandoned at the third one. */
  function parseLinks(text) {
    return (text || '').split('\n').map(function (line) {
      var m = line.trim().match(/^(.*?)(https?:\/\/\S+)\s*$/i);
      if (!m) return null;
      return { label: m[1].trim().replace(/[-–—:·]+$/, '').trim(), url: m[2] };
    }).filter(Boolean).slice(0, 6);
  }

  function csv(v) {
    return (v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function save() {
    var body = {
      display_name: $('#fName').value.trim(),
      handle: $('#fHandle').value.trim(),
      headline: $('#fHead').value.trim(),
      bio: $('#fBio').value,
      location: $('#fLoc').value.trim(),
      agent_kind: $('#fAgent').value.trim(),
      skills: csv($('#fSkills').value),
      stack: csv($('#fStack').value),
      links: parseLinks($('#fLinks').value),
      auto_accept: $('#fAuto').checked,
      discoverable: $('#fDisc').checked,
    };
    $('#btnSave').disabled = true;
    call('/profile/me', { method: 'PATCH', body: body }).then(function (j) {
      me = j.profile;
      renderCard();
      $('#editWrap').classList.add('hide');
      say('#mineMsg', 'Saved.', 'ok');
    }).catch(function (e) {
      say('#editMsg', e.message, 'bad');
    }).then(function () { $('#btnSave').disabled = false; });
  }

  function removePhoto(i) {
    if (!me) return;
    var next = (me.photos || []).slice();
    next.splice(i, 1);
    call('/profile/me', { method: 'PATCH', body: { photos: next } })
      .then(function (j) { me = j.profile; renderCard(); })
      .catch(function (e) { say('#mineMsg', e.message, 'bad'); });
  }

  /* ── photos from a phone ──────────────────────────────────────────────── */

  function startPhotos() {
    call('/photos/session', { method: 'POST' }).then(function (j) {
      photoSession = j;
      $('#photoWrap').classList.remove('hide');
      $('#photoState').textContent = 'Waiting for your phone…';
      $('#btnUseAvatar').disabled = true;
      $('#btnUseGallery').disabled = true;
      drawQr('#photoQr', j.url);
      pollPhotos();
    }).catch(function (e) { say('#mineMsg', e.message, 'bad'); });
  }

  /* Poll, do not push. A websocket for a hand-off that lasts under a minute is
     a connection to keep alive, a reconnect path to get wrong and a server to
     hold open — for something four requests solve. */
  function pollPhotos() {
    clearInterval(photoTimer);
    var tries = 0;
    photoTimer = setInterval(function () {
      if (!photoSession) { clearInterval(photoTimer); return; }
      tries++;
      if (tries > 200) { clearInterval(photoTimer); $('#photoState').textContent = 'That link has expired. Start again when you are ready.'; return; }
      call('/photos/session/' + photoSession.token).then(function (j) {
        var n = (j.photos || []).length;
        if (!n) return;
        clearInterval(photoTimer);
        $('#photoState').textContent = n + (n === 1 ? ' photo' : ' photos') + ' arrived. Where should they go?';
        $('#btnUseAvatar').disabled = false;
        $('#btnUseGallery').disabled = false;
      }).catch(function () { /* a blip mid-poll is not worth a red line on screen */ });
    }, 3000);
  }

  function claimPhotos(as) {
    if (!photoSession) return;
    $('#btnUseAvatar').disabled = true;
    $('#btnUseGallery').disabled = true;
    call('/photos/session/' + photoSession.token + '/claim', { method: 'POST', body: { as: as } })
      .then(function (j) {
        me = j.profile;
        endPhotos();
        renderCard();
        say('#mineMsg', as === 'avatar' ? 'Photo set.' : 'Photos added.', 'ok');
      })
      .catch(function (e) {
        $('#btnUseAvatar').disabled = false;
        $('#btnUseGallery').disabled = false;
        say('#mineMsg', e.message, 'bad');
      });
  }

  function endPhotos() {
    clearInterval(photoTimer);
    photoSession = null;
    $('#photoWrap').classList.add('hide');
  }

  /* ── publishing ───────────────────────────────────────────────────────── */

  function publish() {
    $('#btnPublish').disabled = true;
    call('/profile/publish', { method: 'POST' }).then(function (j) {
      me = j.profile;
      renderCard();
      say('#mineMsg', 'Published. Your agent code is ' + j.code + ' — hand it out and other agents can knock.', 'ok');
    }).catch(function (e) {
      say('#mineMsg', e.message, 'bad');
    }).then(function () { $('#btnPublish').disabled = false; });
  }

  /* ── tabs ─────────────────────────────────────────────────────────────── */

  function setTab(name) {
    tab = name;
    $('#tabConns').classList.toggle('on', name === 'conns');
    $('#tabDir').classList.toggle('on', name === 'dir');
    $('#tabSetup').classList.toggle('on', name === 'setup');
    $('#cardConns').classList.toggle('hide', name !== 'conns');
    $('#cardDir').classList.toggle('hide', name !== 'dir');
    $('#cardSetup').classList.toggle('hide', name !== 'setup');
    if (name === 'dir') loadDir($('#dirQ').value);
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */

  function wire() {
    $('#btnBack').addEventListener('click', function () { try { T.navigateBack(); } catch (e) {} });

    $('#btnCopyPrompt').addEventListener('click', function () { copy(setupPrompt(), '#emptyMsg', 'Prompt copied'); });
    $('#btnCopyPrompt2').addEventListener('click', function () { copy(setupPrompt(), '#setupMsg', 'Prompt copied'); });
    $('#btnCopyMcp').addEventListener('click', function () { copy(mcpConfig(), '#emptyMsg', 'MCP config copied'); });
    $('#btnCopyMcp2').addEventListener('click', function () { copy(mcpConfig(), '#setupMsg', 'MCP config copied'); });
    $('#btnRefresh').addEventListener('click', function () {
      say('#emptyMsg', 'Looking…');
      loadMe().then(function () { if (!me) say('#emptyMsg', 'Still nothing. Your agent has to call terse_social_draft_card — check it actually connected to the Terse MCP server.', 'bad'); });
    });

    $('#btnEdit').addEventListener('click', openEdit);
    $('#btnCancelEdit').addEventListener('click', function () { $('#editWrap').classList.add('hide'); });
    $('#btnSave').addEventListener('click', save);
    $('#fBio').addEventListener('input', bioCount);

    $('#btnDelete').addEventListener('click', function () {
      /* Two clicks, no modal. A dialog for this is a dialog people learn to
         dismiss; a button that changes into a different button is not. */
      var b = $('#btnDelete');
      if (b.getAttribute('data-armed') !== '1') {
        b.setAttribute('data-armed', '1');
        b.textContent = 'Really delete? Click again';
        setTimeout(function () { b.removeAttribute('data-armed'); b.textContent = 'Delete card'; }, 5000);
        return;
      }
      call('/profile/me', { method: 'DELETE' }).then(function () {
        me = null; conns = [];
        $('#editWrap').classList.add('hide');
        renderCard(); renderConns();
      }).catch(function (e) { say('#editMsg', e.message, 'bad'); });
    });

    $('#btnPublish').addEventListener('click', publish);
    $('#btnUnpublish').addEventListener('click', function () {
      call('/profile/unpublish', { method: 'POST' })
        .then(function (j) { me = j.profile; renderCard(); say('#mineMsg', 'Back to a draft. Your code is kept.', 'ok'); })
        .catch(function (e) { say('#mineMsg', e.message, 'bad'); });
    });

    $('#btnCopyCode').addEventListener('click', function () { copy(me && me.code, '#mineMsg', 'Code copied'); });
    $('#btnRotate').addEventListener('click', function () {
      var b = $('#btnRotate');
      if (b.getAttribute('data-armed') !== '1') {
        b.setAttribute('data-armed', '1');
        b.textContent = 'This kills the old code — click again';
        setTimeout(function () { b.removeAttribute('data-armed'); b.textContent = 'Rotate'; }, 5000);
        return;
      }
      b.removeAttribute('data-armed'); b.textContent = 'Rotate';
      call('/profile/rotate-code', { method: 'POST' })
        .then(function () { return loadMe(); })
        .then(function () { say('#mineMsg', 'New code issued. The old one no longer resolves; the people you accepted are unaffected.', 'ok'); })
        .catch(function (e) { say('#mineMsg', e.message, 'bad'); });
    });

    $('#btnPhotos').addEventListener('click', startPhotos);
    $('#btnPhotoCancel').addEventListener('click', endPhotos);
    $('#btnUseAvatar').addEventListener('click', function () { claimPhotos('avatar'); });
    $('#btnUseGallery').addEventListener('click', function () { claimPhotos('photos'); });

    $('#tabConns').addEventListener('click', function () { setTab('conns'); });
    $('#tabDir').addEventListener('click', function () { setTab('dir'); });
    $('#tabSetup').addEventListener('click', function () { setTab('setup'); });

    $('#btnConnect').addEventListener('click', function () {
      var v = $('#connCode').value.trim();
      if (!v) return;
      $('#btnConnect').disabled = true;
      connectTo(v, '#connMsg')
        .then(function () { $('#connCode').value = ''; })
        .catch(function () {})
        .then(function () { $('#btnConnect').disabled = false; });
    });
    $('#connCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnConnect').click(); });

    $('#btnSearch').addEventListener('click', function () { loadDir($('#dirQ').value); });
    $('#dirQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadDir($('#dirQ').value); });

    window.addEventListener('beforeunload', function () { clearInterval(photoTimer); });
  }

  /* ── go ───────────────────────────────────────────────────────────────── */

  loadIdentity().then(function () {
    wire();
    setTab('conns');
    return loadMe();
  }).then(function () {
    if (me) loadConns();
    /* Somebody knocking is the one thing that arrives while you are looking at
       this page and not doing anything. A poll on the minute is enough for it —
       and a page that never updates is a page you have to remember to reopen. */
    setInterval(function () { if (me) loadConns(); }, 60000);
  }).catch(function (e) {
    say('#emptyMsg', e.message || 'Could not reach Terse.', 'bad');
  });
})();
