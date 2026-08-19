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

  var Rooms = {
    state: readState,
    inRoom: function () { var s = readState(); return !!(s && s.key && s.id); },

    create: function (name, memberName, email, opts) {
      return call('', { method: 'POST',
        body: { name: name, member_name: memberName, email: email, identity: identity(),
                visibility: opts && opts.visibility, category: opts && opts.category } })
        .then(function (j) {
          writeState({ id: j.room.id, code: j.room.code, name: j.room.name,
                       key: j.key, memberId: null, owner: true, left: false,
                       visibility: j.room.visibility, category: j.room.category });
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
                       visibility: j.room.visibility, category: j.room.category });
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
      return call('/' + st.id + '/messages' + q);
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

    sendMessage: function (body, imageUrl) {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return call('/' + st.id + '/messages', { method: 'POST',
        body: { body: body, image_url: imageUrl } });
    },

    publishLog: function (text, kind) {
      var st = readState();
      if (!st) return Promise.resolve();
      return call('/' + st.id + '/log', { method: 'POST', body: { text: text, kind: kind } })
        .catch(function () {});   // a dropped log line is not worth an error path
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
                       visibility: j.room.visibility, category: j.room.category });
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
      es.onmessage = function (e) {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'snapshot') {
          // The snapshot is also how a creator learns its own member id.
          if (m.you) { var s2 = readState(); if (s2 && s2.memberId !== m.you) { s2.memberId = m.you; writeState(s2); } }
          h.onSnapshot && h.onSnapshot(m);
        } else if (m.type === 'roster') h.onRoster && h.onRoster(m.members || []);
        else if (m.type === 'log') h.onLog && h.onLog(m);
        else if (m.type === 'message') h.onMessage && h.onMessage(m.message);
        else if (m.type === 'friend') h.onFriend && h.onFriend(m.edge);
        else if (m.type === 'closed') { writeState(null); h.onClosed && h.onClosed(); }
      };
      var beat = setInterval(function () {
        call('/' + st.id + '/presence', { method: 'POST', body: { status: 'online' } })
          .catch(function () {});
      }, HEARTBEAT_MS);
      return function stop() { clearInterval(beat); try { es.close(); } catch (e) {} };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Rooms;
  root.TerseRooms = Rooms;
})(typeof window !== 'undefined' ? window : globalThis);
