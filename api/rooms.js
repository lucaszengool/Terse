/**
 * Terse Rooms — the shared wallpaper session.
 *
 * WHY A ROOM IS NOT A TEAM. A team is who you work for: long-lived, tied to
 * billing and to an email you were invited by. A room is who you are on the
 * wallpaper WITH, right now. Conflating them would force a stranger to join your
 * organisation just to appear on your desktop for an afternoon, and would make
 * leaving expensive. So a room is its own thing: created by anyone, entered with
 * a short code, left by closing the app. Joining a room implies no friendship
 * and no team membership — friends are a separate list you can pull FROM.
 *
 * Transport is SSE + POST, reusing the cowork bus. Server→client (roster, agent
 * logs, chat) is pure push, and client→server is a handful of low-rate posts, so
 * a socket would buy nothing over what already runs on Railway.
 *
 * Mounted at /api/cloud/rooms.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

// Bus channels are shared with cowork's team streams, so room ids are namespaced.
const chan = (roomId) => `room:${roomId}`;

// Anyone who stops heartbeating for this long is shown as offline. A closed
// laptop never sends "goodbye", so presence has to decay rather than be told.
const PRESENCE_STALE = '-45 seconds';

const uuid = () => crypto.randomUUID();
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);

// A closed set. Free-text categories fragment a directory into one-room
// categories, and then browsing is worse than not having it.
const CATEGORIES = ['coding', 'study', 'work', 'gaming', 'chat', 'other'];
const category = (v) => (CATEGORIES.includes((v || '').toString()) ? v.toString() : null);
const visibility = (v) => (v === 'public' ? 'public' : 'private');

/** Ambiguity-free share code: no 0/O, 1/I/L — these get read aloud and retyped. */
function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of crypto.randomBytes(7)) out += A[b % A.length];
  return out;
}

function roster(roomId) {
  db.ageOutRoomMembers.run(PRESENCE_STALE);
  // identity_hash is what a friendship is keyed by, so it stays server-side: the
  // roster goes to everyone in the room, and a friend request names a member id.
  return db.getRoomMembers.all(roomId).map(({ identity_hash, ...m }) => m);
}

/* Who owns this room. The creation key still counts — an owner who never sent
   an identity (or created the room before identities existed) must not be locked
   out of their own room — but the identity is what actually persists. */
function isOwner(req) {
  if (req.room.owner_key_hash === hash(req.rawKey)) return true;
  const secret = req.headers['x-terse-identity'] || req.query.identity;
  return !!(secret && req.room.owner_identity && req.room.owner_identity === hash(secret.toString()));
}

/* One room at a time. Entering a room makes you go quiet in every other room you
   belong to — it does NOT remove you from them. A room outlives everybody
   leaving it (only its owner can close it), so revoking membership to enforce
   "one at a time" would quietly destroy the way back in, including for an owner
   whose own key is a membership. Going offline is reversible; being deleted is
   not. */
function makeActiveRoom(identityHash, roomId) {
  if (!identityHash) return;
  const others = db.roomsIdleFor.all(identityHash, roomId).map((r) => r.room_id);
  if (!others.length) return;
  db.goOfflineElsewhere.run({ identity: identityHash, room_id: roomId });
  // Everyone still watching those rooms should see the person go quiet.
  for (const id of others) bus.emit(chan(id), { type: 'roster', members: roster(id) });
}

function publicRoom(room) {
  return {
    id: room.id, code: room.code, name: room.name || null,
    visibility: room.visibility || 'private', category: room.category || null,
    created_at: room.created_at,
  };
}

// ── Auth: the room key handed out at create/join ──
// EventSource cannot set headers, so ?key= is accepted as well as the header.
function requireMember(req, res, next) {
  const raw = req.headers['x-terse-room-key'] || req.query.key;
  if (!raw) return res.status(401).json({ error: 'Missing room key' });
  const member = db.findRoomMemberByKey.get(hash(raw));
  if (!member) return res.status(401).json({ error: 'Invalid room key' });
  const room = db.getRoomById.get(member.room_id);
  if (!room) return res.status(404).json({ error: 'Room closed' });
  // A key is bound to ONE room. Without this check a valid key for room A would
  // authenticate against room B's stream.
  if (req.params.id && req.params.id !== room.id) {
    return res.status(403).json({ error: 'Key is for a different room' });
  }
  req.room = room;
  req.member = member;
  req.rawKey = raw;
  next();
}

// ════════════════════════════════════════
//  Lifecycle
// ════════════════════════════════════════

// POST /api/cloud/rooms   Body: { name?, member_name?, email?, identity? }
router.post('/', (req, res) => {
  const b = req.body || {};
  const key = crypto.randomBytes(24).toString('base64url');
  const room = {
    id: uuid(),
    code: makeCode(),
    name: clip((b.name || '').toString().trim(), 60) || null,
    owner_key_hash: hash(key),
  };
  db.createRoom.run(room);
  // Private unless asked otherwise — being found by strangers is a decision.
  db.setRoomListing.run(visibility(b.visibility), category(b.category), room.id);
  if (b.identity) db.setRoomOwnerIdentity.run(hash(b.identity.toString()), room.id);
  db.addRoomMember.run({
    room_id: room.id,
    key_hash: hash(key),
    member_id: uuid(),
    name: clip((b.member_name || '').toString().trim(), 40) || null,
    // Email is optional and only ever a label. What makes a member addable as a
    // friend is the install identity, whose hash is all the server keeps.
    user_email: (b.email || '').toString().trim().toLowerCase() || null,
    identity_hash: b.identity ? hash(b.identity.toString()) : null,
  });
  makeActiveRoom(b.identity ? hash(b.identity.toString()) : null, room.id);
  res.json({ ok: true, room: publicRoom(db.getRoomById.get(room.id)), key, owner: true });
});

// POST /api/cloud/rooms/join   Body: { code, name?, email?, identity? }
// Deliberately unauthenticated: a code IS the credential, which is what lets
// someone join without an account, an invite, or becoming anyone's friend.
router.post('/join', (req, res) => {
  const b = req.body || {};
  const code = (b.code || '').toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Missing code' });
  const room = db.getRoomByCode.get(code);
  if (!room) return res.status(404).json({ error: 'No such room' });

  const key = crypto.randomBytes(24).toString('base64url');
  const member = {
    room_id: room.id,
    key_hash: hash(key),
    member_id: uuid(),
    name: clip((b.name || '').toString().trim(), 40) || null,
    user_email: (b.email || '').toString().trim().toLowerCase() || null,
    identity_hash: b.identity ? hash(b.identity.toString()) : null,
  };
  db.addRoomMember.run(member);
  makeActiveRoom(member.identity_hash, room.id);
  const list = roster(room.id);
  bus.emit(chan(room.id), { type: 'roster', members: list });
  res.json({ ok: true, room: publicRoom(room), key, member_id: member.member_id, members: list });
});

// POST /api/cloud/rooms/:id/leave
router.post('/:id/leave', requireMember, (req, res) => {
  db.removeRoomMember.run(req.room.id, hash(req.rawKey));
  bus.emit(chan(req.room.id), { type: 'roster', members: roster(req.room.id) });
  res.json({ ok: true });
});

// POST /api/cloud/rooms/:id/close   (owner only)
// The ONLY way a room ends. It has no idle timeout and no expiry: a room is a
// place, and a place does not vanish because everyone went home.
router.post('/:id/close', requireMember, (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({ error: 'Only the room owner can close it' });
  }
  db.closeRoom.run(req.room.id);
  bus.emit(chan(req.room.id), { type: 'closed' });
  res.json({ ok: true });
});

// ════════════════════════════════════════
//  广场 · the plaza — public rooms
// ════════════════════════════════════════

// GET /api/cloud/rooms/public?category=&limit=
// Unauthenticated on purpose: browsing is what a plaza is for. It lists only
// rooms whose owners opted in, and only ones with somebody actually online —
// a directory full of dead rooms is worse than an empty one.
router.get('/public', (req, res) => {
  const rows = db.listPublicRooms.all({
    category: category(req.query.category),
    limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50)),
  });
  res.json({
    ok: true,
    categories: CATEGORIES,
    // The CODE is deliberately withheld: a public listing that handed out the
    // credential would make "ask to join" meaningless.
    rooms: rows.map((r) => ({
      id: r.id, name: r.name || null, category: r.category || null,
      members: r.members, online: r.online, created_at: r.created_at,
    })),
  });
});

// POST /api/cloud/rooms/:id/listing   Body: { visibility?, category? }   (owner)
router.post('/:id/listing', requireMember, (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({ error: 'Only the room owner can change the listing' });
  }
  const b = req.body || {};
  db.setRoomListing.run(
    visibility(b.visibility === undefined ? req.room.visibility : b.visibility),
    category(b.category === undefined ? req.room.category : b.category),
    req.room.id,
  );
  res.json({ ok: true, room: publicRoom(db.getRoomById.get(req.room.id)) });
});

// ════════════════════════════════════════
//  Knocking — asking to enter, owner decides
// ════════════════════════════════════════

const idHash = (req) => {
  const secret = req.headers['x-terse-identity'] || req.query.identity;
  return secret ? hash(secret.toString()) : null;
};

// POST /api/cloud/rooms/:id/knock   Body: { name? }   (identity, no room key)
router.post('/:id/knock', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const room = db.getRoomById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.visibility !== 'public') {
    // A private room is not merely unlisted; it cannot be knocked on either, or
    // "private" would only mean "harder to find".
    return res.status(403).json({ error: 'That room is private — you need its code' });
  }
  const existing = db.getKnockFor.get(room.id, me);
  if (existing && existing.status === 'denied') {
    return res.status(403).json({ error: 'The owner declined your request' });
  }
  const knock = { id: existing?.id || uuid(), room_id: room.id, identity_hash: me,
                  name: clip((req.body?.name || '').toString().trim(), 40) || null };
  db.addKnock.run(knock);
  const stored = db.getKnockFor.get(room.id, me);
  // The owner is in the room, so the room channel is where this belongs.
  bus.emit(chan(room.id), { type: 'knock', knock: { id: stored.id, name: stored.name, status: stored.status } });
  res.json({ ok: true, knock: { id: stored.id, status: stored.status } });
});

// GET /api/cloud/rooms/knock/:kid  — the asker polls for a verdict, and CLAIMS
// their key here. The key is minted at claim time, so no live credential is ever
// parked in the database waiting to be read.
router.get('/knock/:kid', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const knock = db.getKnock.get(req.params.kid);
  if (!knock || knock.identity_hash !== me) return res.status(404).json({ error: 'No such request' });
  if (knock.status !== 'approved') return res.json({ ok: true, status: knock.status });

  const room = db.getRoomById.get(knock.room_id);
  if (!room) return res.status(404).json({ error: 'Room closed' });
  const key = crypto.randomBytes(24).toString('base64url');
  const member = { room_id: room.id, key_hash: hash(key), member_id: uuid(),
                   name: knock.name, user_email: null, identity_hash: me };
  db.addRoomMember.run(member);
  makeActiveRoom(me, room.id);
  db.setKnockStatus.run('claimed', knock.id);
  bus.emit(chan(room.id), { type: 'roster', members: roster(room.id) });
  res.json({ ok: true, status: 'approved', room: publicRoom(room), key, member_id: member.member_id });
});

// GET /api/cloud/rooms/:id/knocks   (owner) — who is waiting
router.get('/:id/knocks', requireMember, (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({ error: 'Only the room owner sees requests' });
  }
  res.json({ ok: true, knocks: db.listKnocks.all(req.room.id)
    .map((k) => ({ id: k.id, name: k.name, created_at: k.created_at })) });
});

// POST /api/cloud/rooms/:id/knocks/:kid   Body: { accept }   (owner)
router.post('/:id/knocks/:kid', requireMember, (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({ error: 'Only the room owner can answer requests' });
  }
  const knock = db.getKnock.get(req.params.kid);
  if (!knock || knock.room_id !== req.room.id) return res.status(404).json({ error: 'No such request' });
  db.setKnockStatus.run(req.body?.accept === false ? 'denied' : 'approved', knock.id);
  res.json({ ok: true, status: req.body?.accept === false ? 'denied' : 'approved' });
});

// GET /api/cloud/rooms/:id   — roster + recent chat, for a cold client
router.get('/:id', requireMember, (req, res) => {
  res.json({
    ok: true,
    room: publicRoom(req.room),
    you: req.member.member_id,
    owner: isOwner(req),
    members: roster(req.room.id),
    messages: db.getRoomMessages.all(req.room.id, 50).reverse(),
  });
});

// ════════════════════════════════════════
//  Live channel
// ════════════════════════════════════════

// GET /api/cloud/rooms/:id/stream?key=…
router.get('/:id/stream', requireMember, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({
    type: 'snapshot',
    room: publicRoom(req.room),
    you: req.member.member_id,
    members: roster(req.room.id),
    messages: db.getRoomMessages.all(req.room.id, 50).reverse(),
  })}\n\n`);

  const unsubscribe = bus.subscribe(chan(req.room.id), res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
});

// POST /api/cloud/rooms/:id/presence   Body: { status? }
router.post('/:id/presence', requireMember, (req, res) => {
  const status = ['online', 'away', 'offline'].includes(req.body?.status) ? req.body.status : 'online';
  db.touchRoomMember.run(status, req.room.id, hash(req.rawKey));
  // A heartbeat says where you ARE, so it also settles where you are not.
  if (status === 'online' && req.member.identity_hash) {
    makeActiveRoom(req.member.identity_hash, req.room.id);
  }
  bus.emit(chan(req.room.id), { type: 'roster', members: roster(req.room.id) });
  res.json({ ok: true });
});

// POST /api/cloud/rooms/:id/log   Body: { text, kind? }
// One agent log line. It is NOT persisted: the wallpaper renders what is
// happening now, and a room that replayed an hour of someone else's log on join
// would be unreadable. Presence and chat persist; the log stream does not.
router.post('/:id/log', requireMember, (req, res) => {
  const text = clip((req.body?.text || '').toString().trim(), 300);
  if (!text) return res.status(400).json({ error: 'Missing text' });
  db.touchRoomMember.run('online', req.room.id, hash(req.rawKey));
  bus.emit(chan(req.room.id), {
    type: 'log',
    member_id: req.member.member_id,
    name: req.member.name || null,
    kind: clip((req.body?.kind || 'log').toString(), 24),
    text,
  });
  res.json({ ok: true });
});

// POST /api/cloud/rooms/:id/messages   Body: { body?, image_url? }
// Chat. Emoji need no special handling — the column is TEXT and the transport is
// JSON, so they are just characters. Arbitrary file relay is deliberately absent:
// an image may be attached by URL, anything else travels as a link in the body.
router.post('/:id/messages', requireMember, (req, res) => {
  const body = clip((req.body?.body || '').toString().trim(), 2000);
  const image = clip((req.body?.image_url || '').toString().trim(), 500) || null;
  if (!body && !image) return res.status(400).json({ error: 'Empty message' });
  if (image && !/^https:\/\//i.test(image)) {
    return res.status(400).json({ error: 'image_url must be https' });
  }
  const msg = {
    id: uuid(),
    room_id: req.room.id,
    member_id: req.member.member_id,
    name: req.member.name || null,
    body: body || null,
    image_url: image,
  };
  db.addRoomMessage.run(msg);
  db.touchRoomMember.run('online', req.room.id, hash(req.rawKey));
  const stored = db.getRoomMessage.get(msg.id);
  bus.emit(chan(req.room.id), { type: 'message', message: stored });
  res.json({ ok: true, message: stored });
});

module.exports = router;
