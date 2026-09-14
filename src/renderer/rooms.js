/* ── Room client ─────────────────────────────────────────────────────────────
   Talks to /api/cloud/rooms. Used by BOTH the main window (the Rooms page) and
   the wallpaper, which is why membership lives in localStorage rather than in
   either window: every Terse window is the same origin, so one write is visible
   to all of them, and a window that opens later inherits the room without
   asking anyone for it.

   Membership is a key, not an account. Anyone with the code can join, joining
   implies no friendship, and leaving is a single DELETE of local state — the
   properties a room needs and a team must not have.

   Only the WALLPAPER opens the event stream. That is deliberate: browsers cap
   HTTP/1.1 connections per host at six, and Terse can have a dozen windows up,
   so a stream per window fails silently for whoever is unlucky. The wallpaper is
   the one surface that renders the room live; everything else polls the cheap
   REST snapshot when it happens to be open.
   ---------------------------------------------------------------------------- */
(function (root) {
  'use strict';

  var API = 'https://www.terseai.org/api/cloud/rooms';
  var FRIENDS = 'https://www.terseai.org/api/cloud/friends';
  var LS = 'terse-room';           // the ACTIVE room: { id, code, key, memberId, … }
  var LS_ROOMS = 'terse-rooms';    // every room this install belongs to, by id
  var LS_ID = 'terse-identity';    // this install's secret — never leaves as-is
  var LS_ID_LEGACY = 'terse-identity-legacy';   // the random secret, kept after adopting an account id
  var LS_ID_MERGE = 'terse-identity-merge-pending';
  var LS_MUTE = 'terse-room-mute-log';  // "don't put MY agent log in the room"
  var LS_NAME = 'terse-nickname';  // what the roster calls you, everywhere
  var HEARTBEAT_MS = 20000;        // server ages a member out at 45s

  function readState() {
    try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; }
  }
  /* Rooms you belong to are remembered separately from the one you are IN.
     You can only be active in one room at a time, but a room you joined stays
     joined — it exists until its owner deletes it — so switching must not throw
     away the key that gets you back. */
  function knownRooms() {
    try { return JSON.parse(localStorage.getItem(LS_ROOMS) || '{}') || {}; } catch (e) { return {}; }
  }
  /* MERGE, never replace. A record here is the way back into a room, and the
     thing that gets you back is the CODE — so a later write that happens not to
     carry one (a presence ping, a listing change) must not erase it. */
  function remember(st) {
    if (!st || !st.id) return;
    var all = knownRooms();
    var prev = all[st.id] || {};
    var next = {};
    Object.keys(prev).forEach(function (k) { next[k] = prev[k]; });
    Object.keys(st).forEach(function (k) { if (st[k] !== undefined) next[k] = st[k]; });
    next.id = st.id;
    next.seenAt = Date.now();
    all[st.id] = next;
    try { localStorage.setItem(LS_ROOMS, JSON.stringify(all)); } catch (e) {}
  }
  function forget(id) {
    var all = knownRooms();
    delete all[id];
    try { localStorage.setItem(LS_ROOMS, JSON.stringify(all)); } catch (e) {}
  }

  function writeState(s) {
    try {
      if (s) { localStorage.setItem(LS, JSON.stringify(s)); remember(s); }
      else localStorage.removeItem(LS);
    } catch (e) {}
  }

  /* This install's identity. Generated once, kept forever, and the ONLY thing a
     friendship is keyed by — which is why adding someone needs no account, no
     email and no sign-in, exactly like joining a room needs none. The server
     stores only its hash. */
  function identity() {
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

  /* The identity rides along on EVERY room call, not just the ones that need a
     key. Ownership is keyed by identity — a key is minted fresh each time you
     walk back into a room, the identity is not — so an owner who rejoined with
     a new key is only recognised as the owner if this header is there. */
  function call(path, opts) {
    opts = opts || {};
    var st = readState();
    var headers = { 'Content-Type': 'application/json', 'x-terse-identity': identity() };
    if (opts.key) headers['x-terse-room-key'] = opts.key;
    else if (st && st.key) headers['x-terse-room-key'] = st.key;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* Friends live at their own base but take the SAME room key: a friendship is
     asked for through a room, so the room key is the proof you were standing
     next to the person. */
  function friendCall(path, opts) {
    opts = opts || {};
    var st = readState();
    var headers = { 'Content-Type': 'application/json' };
    if (st && st.key) headers['x-terse-room-key'] = st.key;
    headers['x-terse-identity'] = identity();
    return fetch(FRIENDS + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* Knocking happens BEFORE you have a room key — that is the whole point — so
     these calls carry only the identity. */
  function idCall(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'x-terse-identity': identity() },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* ── End-to-end encryption ─────────────────────────────────────────────────
     A private room's messages, agent messages, log lines and files are sealed
     with a 32-byte room key that exists only on members' devices. The relay
     stores "e1:" + base64url(iv | AES-GCM ciphertext), with the room id bound in
     as associated data so a message cannot be replayed into another room.

     Getting the key to a new member without the relay seeing it: every device
     has an ECDH P-256 pair; a member who holds the key seals it to the newcomer's
     public key (ECDH → HKDF bound to the room) and the relay carries only that
     blob. The room records which key is current by its hash (`key_id`), so a
     share of any other key is refused by the receiver. Same safety code on every
     screen = nobody slipped a key of their own into the middle. */
  var LS_KEYS = 'terse-room-keys';      // room id → base64url(room key). Never sent anywhere in the clear.
  var LS_KP = 'terse-room-keypair';     // this device's ECDH pair: JWK private, raw public
  var subtle = (root.crypto && root.crypto.subtle) || null;
  var ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  function te(s) { return new TextEncoder().encode(s); }
  function b64u(bytes) {
    var a = new Uint8Array(bytes), bin = '';
    for (var i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function cat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function secrets() { try { return JSON.parse(localStorage.getItem(LS_KEYS) || '{}') || {}; } catch (e) { return {}; } }
  function secretOf(id) { return (id && secrets()[id]) || null; }
  function setSecret(id, k) {
    var all = secrets();
    if (k) all[id] = k; else delete all[id];
    try { localStorage.setItem(LS_KEYS, JSON.stringify(all)); } catch (e) {}
  }
  function newSecret() { return b64u(root.crypto.getRandomValues(new Uint8Array(32))); }
  function keyIdOf(k) {
    return subtle.digest('SHA-256', unb64u(k)).then(function (h) { return b64u(h).slice(0, 16); });
  }
  var aesCache = {};
  function aesKey(id) {
    var s = secretOf(id);
    if (!s || !subtle) return Promise.resolve(null);
    var c = aesCache[id];
    if (c && c.s === s) return c.p;
    var p = subtle.importKey('raw', unb64u(s), 'AES-GCM', false, ['encrypt', 'decrypt']);
    aesCache[id] = { s: s, p: p };
    return p;
  }
  function seal(id, text) {
    return aesKey(id).then(function (k) {
      if (!k) throw new Error("🔒 You don't have this room's key yet — someone in the room hands it over automatically");
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      return subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: te(id) }, k, te(String(text)))
        .then(function (ct) { return 'e1:' + b64u(cat(iv, new Uint8Array(ct))); });
    });
  }
  /** Plaintext for anything; null for ciphertext this device cannot open. */
  function unseal(id, s) {
    if (typeof s !== 'string' || s.slice(0, 3) !== 'e1:') return Promise.resolve(s);
    return aesKey(id).then(function (k) {
      if (!k) return null;
      var b = unb64u(s.slice(3));
      return subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: te(id) }, k, b.slice(12))
        .then(function (pt) { return new TextDecoder().decode(pt); }, function () { return null; });
    }, function () { return null; });
  }
  /** A message as a person should see it. `locked` = sealed with a key this
      device does not have (yet, or from before the key changed). */
  function openMessage(id, m) {
    if (!m || m.role === 'system') return Promise.resolve(m);
    var f = m.meta && m.meta.file;
    return Promise.all([unseal(id, m.body), f ? unseal(id, f.name) : null]).then(function (r) {
      var out = {};
      Object.keys(m).forEach(function (k) { out[k] = m[k]; });
      if (m.body && r[0] === null) { out.locked = true; out.body = ''; } else out.body = r[0];
      if (f) {
        out.meta = JSON.parse(JSON.stringify(m.meta));
        if (r[1] === null) { out.locked = true; out.meta.file.name = 'file'; } else out.meta.file.name = r[1];
      }
      return out;
    });
  }

  var kpPromise = null;
  function keypair() {
    if (kpPromise) return kpPromise;
    if (!subtle) return Promise.reject(new Error('No WebCrypto here'));
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(LS_KP) || 'null'); } catch (e) {}
    kpPromise = (stored && stored.pub && stored.priv)
      ? subtle.importKey('jwk', stored.priv, ECDH, false, ['deriveBits'])
          .then(function (priv) { return { pub: stored.pub, priv: priv }; })
      : subtle.generateKey(ECDH, true, ['deriveBits']).then(function (pair) {
          return Promise.all([subtle.exportKey('jwk', pair.privateKey), subtle.exportKey('raw', pair.publicKey)])
            .then(function (x) {
              var rec = { priv: x[0], pub: b64u(x[1]) };
              try { localStorage.setItem(LS_KP, JSON.stringify(rec)); } catch (e) {}
              return { pub: rec.pub, priv: pair.privateKey };
            });
        });
    kpPromise.catch(function () { kpPromise = null; });
    return kpPromise;
  }
  /** The one-off AES key two devices share for handing a room key across. */
  function pairKey(roomId, theirPub) {
    return Promise.all([keypair(), subtle.importKey('raw', unb64u(theirPub), ECDH, false, [])])
      .then(function (x) { return subtle.deriveBits({ name: 'ECDH', public: x[1] }, x[0].priv, 256); })
      .then(function (bits) { return subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']); })
      .then(function (hk) {
        return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te(roomId), info: te('terse-room-key-v1') },
          hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function wrapFor(roomId, theirPub) {
    var k = secretOf(roomId);
    if (!k) return Promise.reject(new Error('no key'));
    return pairKey(roomId, theirPub).then(function (wk) {
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, wk, unb64u(k))
        .then(function (ct) { return b64u(cat(iv, new Uint8Array(ct))); });
    });
  }
  function unwrapFrom(roomId, fromPub, blob) {
    return pairKey(roomId, fromPub).then(function (wk) {
      var b = unb64u(blob);
      return subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, wk, b.slice(12));
    }).then(function (raw) { return b64u(raw); });
  }

  /* The key duties, run by ONE window (the room window asks for them with
     keyAgent): publish this device's public key, make the room key if the room
     has none yet, pick up a share addressed to me, and hand the key to anyone
     who has published a key but does not hold the room's. */
  var handed = {};
  function keyDuty(members, keyshares, h) {
    var st = readState();
    if (!subtle || !st || !st.id) return Promise.resolve();
    var id = st.id;
    var me = (members || []).filter(function (m) { return String(m.member_id) === String(st.memberId); })[0];
    function keyed(k) {
      return keyIdOf(k).then(function (kid) {
        return call('/' + id + '/keyed', { method: 'POST', body: { key_id: kid } }).then(function () { return true; },
          function (e) {
            // Somebody else's key won the race: mine is not the room's. Drop it
            // and wait for a share of theirs.
            if (/stale key/.test(String(e && e.message))) { setSecret(id, null); return false; }
            return false;
          });
      });
    }
    return keypair().then(function (kp) {
      var pub = (!me || me.pubkey !== kp.pub)
        ? call('/' + id + '/pubkey', { method: 'POST', body: { pubkey: kp.pub } }).catch(function () {})
        : Promise.resolve();
      if (!st.e2e) return pub;
      return pub.then(function () {
        var have = secretOf(id);
        return (have ? keyIdOf(have) : Promise.resolve(null)).then(function (kid) {
          if (have && st.keyId && kid !== st.keyId) { setSecret(id, null); have = null; }
          if (!have && !st.keyId) {            // nobody has made one: make it
            setSecret(id, newSecret());
            return keyed(secretOf(id)).then(function (ok) { if (ok && h.onKey) h.onKey(); return ok; });
          }
          if (!have) {                          // pick up a share addressed to me
            var got = keyshares ? Promise.resolve({ keyshares: keyshares }) : call('/' + id + '/keyshares');
            return got.then(function (j) {
              var list = (j && j.keyshares) || [];
              var next = function (i) {
                if (i >= list.length) return Promise.resolve(false);
                return unwrapFrom(id, list[i].from_pub, list[i].blob).then(function (k) {
                  return keyIdOf(k).then(function (kid2) {
                    if (kid2 !== st.keyId) return next(i + 1);   // not the room's key: refuse it
                    setSecret(id, k);
                    return keyed(k).then(function () { if (h.onKey) h.onKey(); return true; });
                  });
                }, function () { return next(i + 1); });
              };
              return next(0);
            });
          }
          var pre = (me && !me.keyed) ? keyed(have) : Promise.resolve(true);
          return pre.then(function (ok) {
            if (!ok) return;
            return Promise.all((members || []).map(function (m) {
              if (String(m.member_id) === String(st.memberId) || !m.pubkey || m.keyed) return null;
              var sig = id + '|' + m.member_id + '|' + m.pubkey + '|' + st.keyId;
              if (handed[sig]) return null;
              handed[sig] = true;
              return wrapFor(id, m.pubkey).then(function (blob) {
                return call('/' + id + '/keyshares', { method: 'POST', body: { to: m.member_id, from_pub: kp.pub, blob: blob } });
              }).catch(function () { delete handed[sig]; });
            }));
          });
        });
      });
    }).catch(function () {});
  }

  var Rooms = {
    state: readState,

    // ── encryption, for the room window and the Rust side of the agent channel ──
    secret: secretOf,
    openMessage: openMessage,
    /** Turn end-to-end encryption on or off (owner). A new key is made by the
        first device that notices the room has none. */
    setE2E: function (on) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      setSecret(st.id, null);
      return call('/' + st.id + '/e2e', { method: 'POST', body: { on: !!on } }).then(function (j) {
        var s2 = readState();
        if (s2) { s2.e2e = !!j.room.e2e; s2.keyId = j.room.key_id || null; writeState(s2); }
        return j.room;
      });
    },
    /** Same digits on every member's screen = same key, same people. */
    safetyCode: function (members) {
      var st = readState(), k = st && secretOf(st.id);
      if (!k || !subtle) return Promise.resolve(null);
      var pubs = (members || []).filter(function (m) { return m.pubkey && m.keyed; })
        .map(function (m) { return m.pubkey; }).sort();
      return subtle.digest('SHA-256', cat(unb64u(k), te(pubs.join('.')))).then(function (h) {
        var a = new Uint8Array(h), out = [];
        for (var i = 0; i < 10; i += 2) out.push(('000' + (((a[i] << 8) | a[i + 1]) % 10000)).slice(-4));
        return out.join(' ');
      });
    },
    inRoom: function () { var s = readState(); return !!(s && s.key && s.id); },

    create: function (name, memberName, email, opts) {
      return call('', { method: 'POST',
        body: { name: name, member_name: memberName, email: email, identity: identity(),
                visibility: opts && opts.visibility, category: opts && opts.category,
                agents: opts && opts.agents === false ? false : undefined,
                // Private rooms are end-to-end encrypted unless asked otherwise.
                e2e: !(opts && opts.e2e === false) && !(opts && opts.visibility === 'public') } })
        .then(function (j) {
          writeState({ id: j.room.id, code: j.room.code, name: j.room.name,
                       key: j.key, memberId: null, owner: true, left: false,
                       visibility: j.room.visibility, category: j.room.category,
                       e2e: !!j.room.e2e, keyId: j.room.key_id || null });
          // The member id comes from the snapshot, but the room already EXISTS
          // by now — so a failed snapshot must not report failure and strand an
          // orphan room. The stream teaches us the id again on connect.
          return Rooms.snapshot().then(function (s) {
            var st = readState(); if (st) { st.memberId = s.you; writeState(st); }
            return j.room;
          }, function () { return j.room; });
        });
    },

    join: function (code, memberName, email) {
      return call('/join', { method: 'POST',
        body: { code: String(code || '').trim().toUpperCase(), name: memberName,
                email: email, identity: identity() } })
        .then(function (j) {
          // The server decides who owns the room, because it is the only side
          // that knows: an owner who rejoins by code arrives with a new key and
          // would otherwise demote themselves to a guest in their own room.
          writeState({ id: j.room.id, code: j.room.code, name: j.room.name,
                       key: j.key, memberId: j.member_id, owner: !!j.owner, left: false,
                       visibility: j.room.visibility, category: j.room.category,
                       e2e: !!j.room.e2e, keyId: j.room.key_id || null });
          return j.room;
        });
    },

    /** Leave locally even if the server call fails — being stuck in a room you
        asked to leave is worse than a stale row the server ages out anyway.

        Leaving gives up the SEAT, not the room. The room keeps running for
        everyone still in it, so the record stays here with its code: that is
        what puts it in "recent rooms" and lets one click walk back in. The KEY
        is dropped, because the server spends it on the way out. */
    leave: function () {
      var st = readState();
      if (!st) return Promise.resolve();
      return call('/' + st.id + '/leave', { method: 'POST' })
        .catch(function () {})
        .then(function () {
          remember({ id: st.id, code: st.code, name: st.name, owner: st.owner,
                     visibility: st.visibility, category: st.category,
                     key: null, memberId: null, left: true });
          writeState(null);
        });
    },

    /** End the room for everyone. The only destructive verb here, and the only
        one that drops the record — there is nothing left to come back to. */
    close: function () {
      var st = readState();
      if (!st) return Promise.resolve();
      return call('/' + st.id + '/close', { method: 'POST' })
        .then(function () { forget(st.id); writeState(null); });
    },

    snapshot: function () {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return call('/' + st.id);
    },

    /** Older chat, for a window scrolling up. `beforeSeq` is the seq of the
        oldest line already on screen; omit it for the newest page. */
    history: function (beforeSeq, limit) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      var q = '?limit=' + (limit || 50) + (beforeSeq ? '&before=' + encodeURIComponent(beforeSeq) : '');
      return call('/' + st.id + '/messages' + q).then(function (j) {
        return Promise.all((j.messages || []).map(function (m) { return openMessage(st.id, m); }))
          .then(function (list) { j.messages = list; return j; });
      });
    },

    /* Your nickname. Kept locally because it is asked for BEFORE there is a room
       to send it to — creating and joining both carry it — and pushed to the
       server whenever you are in one, so the roster updates for everybody. */
    nickname: function () {
      try { return localStorage.getItem(LS_NAME) || ''; } catch (e) { return ''; }
    },
    setNickname: function (name) {
      var n = String(name || '').trim().slice(0, 40);
      try { localStorage.setItem(LS_NAME, n); } catch (e) {}
      var st = readState();
      if (!st || !n) return Promise.resolve(n);
      return call('/' + st.id + '/name', { method: 'POST', body: { name: n } })
        .then(function () { return n; }, function () { return n; });
    },

    /* Whether this machine puts its agent log into the room. Local by design:
       it is a decision about what you broadcast, it should apply the moment it
       is made, and it must survive being offline. The wallpaper reads it at
       publish time, so the room window can flip it for the whole install. */
    logMuted: function () {
      try { return localStorage.getItem(LS_MUTE) === '1'; } catch (e) { return false; }
    },
    muteLog: function (on) {
      try { localStorage.setItem(LS_MUTE, on ? '1' : '0'); } catch (e) {}
      return !!on;
    },

    /** opts.toAgents: address the line to the agents in the room (each owner's
        Terse decides whether it reaches their agent). */
    sendMessage: function (body, imageUrl, opts) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      var sealed = (st.e2e && body) ? seal(st.id, body) : Promise.resolve(body);
      return sealed.then(function (b) {
        return call('/' + st.id + '/messages', { method: 'POST',
          body: { body: b, image_url: imageUrl, to_agents: !!(opts && opts.toAgents) } });
      });
    },

    /* ── Agent channel ──
       Only the badge and the room's say-so live on the server. Which session is
       connected, whether peer messages reach it on their own, and every file
       going in or out are decided on this Mac (room_link.rs). */
    setAgent: function (on, kind, label) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return call('/' + st.id + '/agent', { method: 'POST',
        body: { on: !!on, kind: kind, label: label } });
    },

    publishLog: function (text, kind) {
      var st = readState();
      if (!st) return Promise.resolve();
      // In an encrypted room a log line is sealed like everything else — or not
      // sent at all while this device is still waiting for the key.
      var sealed = st.e2e ? (secretOf(st.id) ? seal(st.id, text) : Promise.reject(new Error('no key')))
                          : Promise.resolve(text);
      return sealed.then(function (t) {
        return call('/' + st.id + '/log', { method: 'POST', body: { text: t, kind: kind } });
      }).catch(function () {});   // a dropped log line is not worth an error path
    },

    /** Ask to add a room member. Fails loudly — the caller shows the reason,
        which is usually "they are not signed in", not a bug. */
    requestFriend: function (memberId) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return friendCall('/request', { method: 'POST',
        body: { room_id: st.id, to_member_id: memberId } });
    },
    listFriends: function () { return friendCall('/'); },
    respondFriend: function (id, accept) {
      return friendCall('/' + id + '/respond', { method: 'POST', body: { accept: !!accept } });
    },
    removeFriend: function (id) { return friendCall('/' + id, { method: 'DELETE' }); },

    rooms: knownRooms,
    forget: forget,
    remember: remember,

    /** Ask the SERVER which rooms this install can walk back into, and fold the
        answer into the local list. Membership outlives presence and outlives
        this browser store, so the way back into a room you own must not be a
        localStorage entry that a reinstall wipes. */
    mine: function () {
      return idCall('/mine').then(function (j) {
        (j.rooms || []).forEach(function (r) {
          remember({ id: r.id, code: r.code, name: r.name, owner: !!r.owner,
                     visibility: r.visibility, category: r.category,
                     members: r.members, online: r.online,
                     lastSeenAt: r.last_seen_at, createdAt: r.created_at });
        });
        /* Deliberately NOT a prune. A room you walked out of is absent from
           this answer — you gave up the seat — but it is still open, you still
           have its code, and it is exactly the room "recent" exists for. A dead
           room is discovered the honest way instead: by the door not opening
           (see rejoin), which is the only signal that means closed.

           Its COUNTS are dropped though: the server only reports on rooms you
           are in, so "3 online" left over from the day you walked out is not
           stale data, it is a wrong answer. Unknown is displayed as nothing. */
        var live = {};
        (j.rooms || []).forEach(function (r) { live[r.id] = true; });
        var all = knownRooms();
        Object.keys(all).forEach(function (id) {
          if (!live[id]) remember({ id: id, online: null, members: null });
        });
        return j.rooms || [];
      });
    },

    /** Re-enter a room you already belong to. No code typed, no knock — you are
        already a member. A live key just needs a presence ping; a spent one (you
        left, or the server aged the seat out) is re-minted from the code, which
        is why leaving keeps the code. */
    rejoin: function (id, memberName, email) {
      var st = knownRooms()[id];
      if (!st) return Promise.reject(new Error('You are not in that room'));
      function byCode() {
        if (!st.code) return Promise.reject(new Error('That room needs its code again'));
        return Rooms.join(st.code, memberName, email).catch(function (e) {
          // The door not opening is the ONLY thing that means the room is gone.
          // Absence from any list is not: you are absent from rooms you left.
          if (/No such room|Room closed|404/i.test(String(e && e.message || e))) {
            forget(id);
            throw new Error('That room has been closed by its owner');
          }
          throw e;
        });
      }
      if (!st.key || st.left) return byCode();
      writeState(st);
      return call('/' + id + '/presence', { method: 'POST', body: { status: 'online' } })
        .then(function () { return st; }, function (e) {
          // 401/404 means the seat is gone, not that the room is: walk in again.
          return byCode();
        });
    },
    /** Kept for callers that only ever want the presence ping. */
    activate: function (id) { return Rooms.rejoin(id); },

    // ── 广场 ──
    // Sent WITH the identity so the listing can say which of these rooms are
    // already yours — a plaza that offers "ask to join" for your own room is a
    // button whose knock only you could answer.
    plaza: function (category) {
      return idCall('/public' + (category ? '?category=' + encodeURIComponent(category) : ''));
    },
    setListing: function (visibility, category) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return call('/' + st.id + '/listing', { method: 'POST',
        body: { visibility: visibility, category: category } })
        .then(function (j) {
          var s2 = readState();
          if (s2) { s2.visibility = j.room.visibility; s2.category = j.room.category; writeState(s2); }
          return j.room;
        });
    },

    // ── knocking ──
    knock: function (roomId, name) {
      return idCall('/' + roomId + '/knock', { method: 'POST', body: { name: name } });
    },
    /** Poll a verdict. When approved, this is also where the key is handed over —
        so a successful call puts you IN the room. */
    knockStatus: function (knockId) {
      return idCall('/knock/' + knockId).then(function (j) {
        if (j.status === 'approved' && j.key) {
          writeState({ id: j.room.id, code: j.room.code, name: j.room.name,
                       key: j.key, memberId: j.member_id, owner: false,
                       visibility: j.room.visibility, category: j.room.category,
                       e2e: !!j.room.e2e, keyId: j.room.key_id || null });
        }
        return j;
      });
    },
    knocks: function () {
      var st = readState();
      if (!st) return Promise.resolve({ knocks: [] });
      return call('/' + st.id + '/knocks');
    },
    answerKnock: function (knockId, accept) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return call('/' + st.id + '/knocks/' + knockId, { method: 'POST', body: { accept: !!accept } });
    },

    // ── friend links ──
    friendLink: function () { return friendCall('/link', { method: 'POST' }); },
    acceptFriendLink: function (token, name) {
      return friendCall('/link/' + encodeURIComponent(token) + '/accept', { method: 'POST', body: { name: name } });
    },
    revokeFriendLink: function (token) {
      return friendCall('/link/' + encodeURIComponent(token), { method: 'DELETE' });
    },

    /** Fire `cb(state)` whenever the ACTIVE room changes — joined, switched, or
        left — including when the change was made in another window.

        Every Terse window is the same origin, so `storage` carries the news
        between them; the poll is for the window that made the change itself (it
        gets no storage event) and for a store that fails silently. Rooms are
        joined from the main window and rendered by the wallpaper, so without
        this the wallpaper only ever shows the room it happened to be launched
        into — which looked exactly like "the chat box is missing". */
    watch: function (cb) {
      var last = null;
      function tick() {
        var st = readState();
        var sig = st ? (st.id + '|' + (st.key || '')) : '';
        if (sig === last) return;
        last = sig;
        try { cb(st); } catch (e) {}
      }
      tick();
      var timer = setInterval(tick, 2000);
      var onStorage = function (e) { if (!e || !e.key || e.key === LS) tick(); };
      root.addEventListener && root.addEventListener('storage', onStorage);
      return function stopWatching() {
        clearInterval(timer);
        root.removeEventListener && root.removeEventListener('storage', onStorage);
      };
    },

    inviteUrl: function () {
      var st = readState();
      return st ? 'https://www.terseai.org/join?room=' + encodeURIComponent(st.code) : '';
    },

    /**
     * Open the live stream. Returns a stop() function. Handlers:
     *   onSnapshot({ room, you, members, messages })
     *   onRoster(members), onLog(evt), onMessage(msg), onFriend(edge), onClosed()
     * Reconnection is EventSource's own job; the heartbeat is ours.
     */
    connect: function (h) {
      h = h || {};
      var st = readState();
      if (!st) return function () {};
      var url = API + '/' + st.id + '/stream?key=' + encodeURIComponent(st.key);
      var es = new EventSource(url);
      var chain = Promise.resolve(), members = [];
      function roomInfo(r) {
        var s2 = readState();
        if (!r || !s2 || s2.id !== r.id) return;
        if (s2.e2e !== !!r.e2e || (s2.keyId || null) !== (r.key_id || null)) {
          s2.e2e = !!r.e2e; s2.keyId = r.key_id || null; writeState(s2);
        }
      }
      function duty(keyshares) { return h.keyAgent ? keyDuty(members, keyshares, h) : Promise.resolve(); }
      function copy(m) { var c = {}; Object.keys(m).forEach(function (k) { c[k] = m[k]; }); return c; }
      function handle(m) {
        var id = st.id;
        if (m.type === 'snapshot') {
          // The snapshot is also how a creator learns its own member id.
          var s2 = readState();
          if (m.you && s2 && s2.memberId !== m.you) { s2.memberId = m.you; writeState(s2); }
          roomInfo(m.room);
          members = m.members || [];
          // Key first (one may be waiting for me), then open the history with it.
          return duty(m.keyshares).then(function () {
            return Promise.all((m.messages || []).map(function (x) { return openMessage(id, x); }));
          }).then(function (list) { var c = copy(m); c.messages = list; h.onSnapshot && h.onSnapshot(c); });
        }
        if (m.type === 'roster') { members = m.members || []; h.onRoster && h.onRoster(members); duty(); return null; }
        if (m.type === 'room') { roomInfo(m.room); h.onRoom && h.onRoom(m.room); duty(); return null; }
        if (m.type === 'keyshare') {
          if (String(m.to) === String((readState() || {}).memberId)) duty();
          return null;
        }
        if (m.type === 'log') {
          return unseal(id, m.text).then(function (t) {
            if (t === null) return;               // sealed, and no key here yet
            var c = copy(m); c.text = t; h.onLog && h.onLog(c);
          });
        }
        if (m.type === 'message') return openMessage(id, m.message).then(function (x) { h.onMessage && h.onMessage(x); });
        if (m.type === 'friend') h.onFriend && h.onFriend(m.edge);
        else if (m.type === 'closed') { writeState(null); h.onClosed && h.onClosed(); }
        return null;
      }
      es.onmessage = function (e) {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        // One at a time: opening a sealed line is async, and a reply must never
        // be shown before the line it answers.
        chain = chain.then(function () { return handle(m); }).catch(function () {});
      };
      var beat = setInterval(function () {
        call('/' + st.id + '/presence', { method: 'POST', body: { status: 'online' } })
          .catch(function () {});
      }, HEARTBEAT_MS);
      return function stop() { clearInterval(beat); try { es.close(); } catch (e) {} };
    },

    /* ── One person, one identity ──
       A signed-in device sends the person's account id instead of its random
       install secret, so rooms, friends, the Plaza and DMs all see the same
       person — on the Mac and on the phone. What this install made under its old
       secret (friendships, room seats, rooms it owns) is moved onto the account
       once; the old secret is kept, never deleted, in case that has to be redone. */
    adoptIdentity: function (accountId) {
      accountId = String(accountId || '').trim();
      if (!accountId) return Promise.resolve(false);
      var cur = identity(), pending = null;
      try { pending = localStorage.getItem(LS_ID_MERGE); } catch (e) {}
      if (cur !== accountId) {
        try {
          if (!localStorage.getItem(LS_ID_LEGACY)) localStorage.setItem(LS_ID_LEGACY, cur);
          localStorage.setItem(LS_ID_MERGE, cur);
          localStorage.setItem(LS_ID, accountId);
        } catch (e) { return Promise.resolve(false); }
        pending = cur;
      }
      if (!pending || pending === accountId) return Promise.resolve(false);
      return fetch(FRIENDS + '/identity/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-terse-identity': accountId },
        body: JSON.stringify({ legacy: pending }),
      }).then(function (r) {
        // Pending until the server has actually done it: offline today means
        // retried on the next launch, not lost.
        if (r.ok) { try { localStorage.removeItem(LS_ID_MERGE); } catch (e) {} }
        return r.ok;
      }, function () { return false; });
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Rooms;
  root.TerseRooms = Rooms;
})(typeof window !== 'undefined' ? window : globalThis);
