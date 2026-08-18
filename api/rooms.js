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

/** Ambiguity-free share code: no 0/O, 1/I/L — these get read aloud and retyped. */
function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of crypto.randomBytes(7)) out += A[b % A.length];
  return out;
}

function roster(roomId) {
  db.ageOutRoomMembers.run(PRESENCE_STALE);
  return db.getRoomMembers.all(roomId);
}

function publicRoom(room) {
  return { id: room.id, code: room.code, name: room.name || null, created_at: room.created_at };
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

// POST /api/cloud/rooms   Body: { name?, member_name?, email? }
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
  db.addRoomMember.run({
    room_id: room.id,
    key_hash: hash(key),
    member_id: uuid(),
    name: clip((b.member_name || '').toString().trim(), 40) || null,
    // The creator gets an email for the same reason a joiner does: without one
    // they are anonymous, and an anonymous member cannot be added as a friend.
    user_email: (b.email || '').toString().trim().toLowerCase() || null,
  });
  res.json({ ok: true, room: publicRoom(room), key, owner: true });
});

// POST /api/cloud/rooms/join   Body: { code, name?, email? }
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
  };
  db.addRoomMember.run(member);
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
router.post('/:id/close', requireMember, (req, res) => {
  if (req.room.owner_key_hash !== hash(req.rawKey)) {
    return res.status(403).json({ error: 'Only the room owner can close it' });
  }
  db.closeRoom.run(req.room.id);
  bus.emit(chan(req.room.id), { type: 'closed' });
  res.json({ ok: true });
});

// GET /api/cloud/rooms/:id   — roster + recent chat, for a cold client
router.get('/:id', requireMember, (req, res) => {
  res.json({
    ok: true,
    room: publicRoom(req.room),
    you: req.member.member_id,
    owner: req.room.owner_key_hash === hash(req.rawKey),
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
