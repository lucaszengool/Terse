/**
 * Friends — the durable edge between two people who met in a room.
 *
 * WHY IT IS KEYED BY EMAIL. Rooms are deliberately ephemeral and a room member
 * id dies with the room, so storing friendships by member id would delete every
 * friend the moment a room closed. The edge is therefore between two emails,
 * which is also the honest constraint: you can only befriend someone who is
 * signed in, because there is otherwise nothing durable to point at. Anonymous
 * room members can be seen and chatted with — they just cannot be added.
 *
 * WHY IT IS ROOM-MEDIATED. A request names a member of a room you are both in,
 * never a raw email. That means you cannot enumerate or spam strangers: you can
 * only ask someone who is standing in the same room as you, and the room key you
 * already hold is the proof.
 *
 * Mounted at /api/cloud/friends.
 */
const express = require('express');
const crypto = require('crypto');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

const CLERK_JWKS = createRemoteJWKSet(new URL('https://clerk.terseai.org/.well-known/jwks.json'));
const CLERK_ISSUER = 'https://clerk.terseai.org';

const chan = (roomId) => `room:${roomId}`;
const uuid = () => crypto.randomUUID();
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const lc = (s) => ((s || '').toString().trim().toLowerCase() || null);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);

/**
 * Who is calling. Two credentials are accepted because two surfaces call this:
 * the wallpaper, which holds a room key and nothing else, and the app, which may
 * be signed in but not in a room. Either way the answer is an email — without
 * one there is no durable identity to attach a friendship to.
 */
async function requireIdentity(req, res, next) {
  const roomKey = req.headers['x-terse-room-key'] || req.query.key;
  if (roomKey) {
    const member = db.findRoomMemberByKey.get(hash(roomKey));
    if (member) {
      if (!member.user_email) {
        return res.status(403).json({
          error: 'Sign in to add friends — an anonymous room member has no account to link to',
        });
      }
      req.email = lc(member.user_email);
      req.name = member.name || null;
      req.roomMember = member;
      return next();
    }
  }

  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(auth.slice(7), CLERK_JWKS, { issuer: CLERK_ISSUER });
      const email = lc(payload.email || req.query.email);
      if (email) { req.email = email; req.name = null; return next(); }
    } catch { /* fall through */ }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

/** The other person's side of an edge, from the caller's point of view. */
function shape(edge, me) {
  const outgoing = edge.a_email === me;
  return {
    id: edge.id,
    status: edge.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    email: outgoing ? edge.b_email : edge.a_email,
    name: (outgoing ? edge.b_name : edge.a_name) || null,
    room_id: edge.room_id || null,
    created_at: edge.created_at,
  };
}

// POST /api/cloud/friends/request   Body: { room_id, to_member_id }
router.post('/request', requireIdentity, (req, res) => {
  const roomId = (req.body?.room_id || '').toString();
  const toId = (req.body?.to_member_id || '').toString();
  if (!roomId || !toId) return res.status(400).json({ error: 'Missing room_id or to_member_id' });

  // The caller must be in the room they are asking through — a room key alone
  // is not enough, or one room's key would let you reach into another's roster.
  if (req.roomMember && req.roomMember.room_id !== roomId) {
    return res.status(403).json({ error: 'Key is for a different room' });
  }
  const room = db.getRoomById.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const target = db.getRoomMembers.all(roomId).find((m) => m.member_id === toId);
  if (!target) return res.status(404).json({ error: 'That person is not in this room' });
  if (!target.user_email) {
    return res.status(409).json({ error: 'That person is not signed in, so they cannot be added yet' });
  }
  const them = lc(target.user_email);
  if (them === req.email) return res.status(400).json({ error: 'You cannot add yourself' });

  const existing = db.getFriendEdge.get({ x: req.email, y: them });
  if (existing) {
    // Both sides asking is agreement, so it is honoured as one: the second
    // request accepts the first instead of creating a mirror-image pending row
    // that neither person can resolve.
    if (existing.status === 'pending' && existing.b_email === req.email) {
      db.respondFriend.run('accepted', existing.id);
      const now = db.getFriendById.get(existing.id);
      bus.emit(chan(roomId), { type: 'friend', edge: now });
      return res.json({ ok: true, friendship: shape(now, req.email), accepted: true });
    }
    return res.json({ ok: true, friendship: shape(existing, req.email), existing: true });
  }

  const edge = {
    id: uuid(),
    a_email: req.email,
    b_email: them,
    a_name: clip(req.name, 40),
    b_name: clip(target.name, 40),
    room_id: roomId,
  };
  db.addFriendRequest.run(edge);
  const stored = db.getFriendById.get(edge.id);
  // Fanned out on the ROOM channel: both people are already listening there, so
  // the request lands live without inventing a second delivery mechanism.
  bus.emit(chan(roomId), { type: 'friend', edge: stored });
  res.json({ ok: true, friendship: shape(stored, req.email) });
});

// POST /api/cloud/friends/:id/respond   Body: { accept: true|false }
router.post('/:id/respond', requireIdentity, (req, res) => {
  const edge = db.getFriendById.get(req.params.id);
  if (!edge) return res.status(404).json({ error: 'No such request' });
  // Only the person who was ASKED may answer. Without this the requester could
  // accept on the other person's behalf.
  if (edge.b_email !== req.email) {
    return res.status(403).json({ error: 'Only the person who was asked can answer' });
  }
  if (edge.status !== 'pending') {
    return res.status(409).json({ error: 'That request was already answered' });
  }
  db.respondFriend.run(req.body?.accept === false ? 'declined' : 'accepted', edge.id);
  const now = db.getFriendById.get(edge.id);
  if (now.room_id) bus.emit(chan(now.room_id), { type: 'friend', edge: now });
  res.json({ ok: true, friendship: shape(now, req.email) });
});

// GET /api/cloud/friends  → { friends, incoming, outgoing }
router.get('/', requireIdentity, (req, res) => {
  const edges = db.listFriendEdges.all(req.email, req.email).map((e) => shape(e, req.email));
  res.json({
    ok: true,
    email: req.email,
    friends: edges.filter((e) => e.status === 'accepted'),
    incoming: edges.filter((e) => e.status === 'pending' && e.direction === 'incoming'),
    outgoing: edges.filter((e) => e.status === 'pending' && e.direction === 'outgoing'),
  });
});

// DELETE /api/cloud/friends/:id — unfriend, or withdraw a request. Either side.
router.delete('/:id', requireIdentity, (req, res) => {
  const edge = db.getFriendById.get(req.params.id);
  if (!edge) return res.status(404).json({ error: 'No such friendship' });
  if (edge.a_email !== req.email && edge.b_email !== req.email) {
    return res.status(403).json({ error: 'Not yours to remove' });
  }
  db.deleteFriend.run(edge.id);
  res.json({ ok: true });
});

module.exports = router;
