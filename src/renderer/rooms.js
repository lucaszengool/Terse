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
  var LS = 'terse-room';           // { id, code, name, key, memberId, owner }
  var HEARTBEAT_MS = 20000;        // server ages a member out at 45s

  function readState() {
    try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; }
  }
  function writeState(s) {
    try {
      if (s) localStorage.setItem(LS, JSON.stringify(s));
      else localStorage.removeItem(LS);
    } catch (e) {}
  }

  function call(path, opts) {
    opts = opts || {};
    var st = readState();
    var headers = { 'Content-Type': 'application/json' };
    if (st && st.key) headers['x-terse-room-key'] = st.key;
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

  var Rooms = {
    state: readState,
    inRoom: function () { var s = readState(); return !!(s && s.key && s.id); },

    create: function (name, memberName) {
      return call('', { method: 'POST', body: { name: name, member_name: memberName } })
        .then(function (j) {
          writeState({ id: j.room.id, code: j.room.code, name: j.room.name,
                       key: j.key, memberId: null, owner: true });
          // The creator's member id only comes back from the snapshot, and the
          // wallpaper needs it to know which glyphs are its own.
          return Rooms.snapshot().then(function (s) {
            var st = readState(); st.memberId = s.you; writeState(st);
            return j.room;
          });
        });
    },

    join: function (code, memberName, email) {
      return call('/join', { method: 'POST',
        body: { code: String(code || '').trim().toUpperCase(), name: memberName, email: email } })
        .then(function (j) {
          writeState({ id: j.room.id, code: j.room.code, name: j.room.name,
                       key: j.key, memberId: j.member_id, owner: false });
          return j.room;
        });
    },

    /** Leave locally even if the server call fails — being stuck in a room you
        asked to leave is worse than a stale row the server ages out anyway. */
    leave: function () {
      var st = readState();
      if (!st) return Promise.resolve();
      return call('/' + st.id + '/leave', { method: 'POST' })
        .catch(function () {})
        .then(function () { writeState(null); });
    },

    close: function () {
      var st = readState();
      if (!st) return Promise.resolve();
      return call('/' + st.id + '/close', { method: 'POST' })
        .then(function () { writeState(null); });
    },

    snapshot: function () {
      var st = readState();
      if (!st) return Promise.reject(new Error('Not in a room'));
      return call('/' + st.id);
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
