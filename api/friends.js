/**
 * Friends — the durable link between two people who met in a room.
 *
 * WHY IT IS KEYED BY AN INSTALL IDENTITY, NOT AN EMAIL. A room needs no account:
 * the code is the credential, anyone can join, and that is the point. Demanding
 * an email the moment you want to KEEP someone would contradict that — and it is
 * not even necessary. What a friendship needs is something durable to point at,
 * and a room member id is not it (those die with the room). So each install
 * generates a secret once and keeps it; the server only ever stores its hash,
 * exactly like a room key. No sign-in, no account, nothing to enumerate.
 *
 * An email is recorded when there happens to be one, purely so the other person
 * sees a friendlier label than a random name.
 *
 * WHY IT IS ROOM-MEDIATED. A request names a member of a room you are both in,
 * never a raw identity. You cannot enumerate or spam strangers: you can only ask
 * someone standing in the same room, and the room key you already hold is the
 * proof. The other person's identity hash is resolved server-side and never
 * leaves it.
 *
 * Mounted at /api/cloud/friends.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

const chan = (roomId) => `room:${roomId}`;
const uuid = () => crypto.randomUUID();
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const lc = (s) => ((s || '').toString().trim().toLowerCase() || null);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);

/**
 * Who is calling. Two credentials, because two surfaces call this: the wallpaper
 * and the app both hold the install secret, and the room key is accepted as a
 * shorthand when the caller is already in a room. Either way the answer is an
 * identity HASH — never an account.
 */
function requireIdentity(req, res, next) {
  const secret = req.headers['x-terse-identity'] || req.query.identity;
  if (secret) {
    req.idHash = hash(secret.toString());
    req.roomKey = req.headers['x-terse-room-key'] || req.query.key;
    if (req.roomKey) {
      const m = db.findRoomMemberByKey.get(hash(req.roomKey.toString()));
      if (m) { req.roomMember = m; req.name = m.name || null; req.email = lc(m.user_email); }
    }
    return next();
  }

  // Falling back to the room key alone: usable only if the member registered an
  // identity when they joined. An older client that never sent one cannot make
  // friendships — and is told so, rather than failing vaguely.
  const roomKey = req.headers['x-terse-room-key'] || req.query.key;
  if (roomKey) {
    const m = db.findRoomMemberByKey.get(hash(roomKey.toString()));
    if (m) {
      if (!m.identity_hash) {
        return res.status(403).json({ error: 'This copy of Terse is too old to keep friends — update it' });
      }
      req.idHash = m.identity_hash;
      req.roomMember = m;
      req.name = m.name || null;
      req.email = lc(m.user_email);
      return next();
    }
  }
  return res.status(401).json({ error: 'Missing identity' });
}

/** The other person's side of a link, from the caller's point of view.
 *
 * `peer` is the other person's identity hash TRUNCATED TO 32 — which is exactly
 * the id the plaza and the DM router use, because all three derive from the same
 * sha256 and the short one is the long one's prefix. It is here so that a friend
 * can be MESSAGED: without it the friends list holds a name and nothing you can
 * address, and "add a friend, then chat" is impossible.
 *
 * The full 64-char hash stays in. It is what a friendship is keyed by, and it
 * still never leaves the server — see publicEdge for the room channel, which
 * carries neither. */
function shape(edge, meHash) {
  const outgoing = edge.a_hash === meHash;
  return {
    id: edge.id,
    status: edge.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    name: (outgoing ? edge.b_name : edge.a_name) || null,
    email: (outgoing ? edge.b_email : edge.a_email) || null,
    peer: String(outgoing ? edge.b_hash : edge.a_hash).slice(0, 32),
    room_id: edge.room_id || null,
    created_at: edge.created_at,
  };
}

// POST /api/cloud/friends/request   Body: { room_id, to_member_id }
router.post('/request', requireIdentity, (req, res) => {
  const roomId = (req.body?.room_id || '').toString();
  const toId = (req.body?.to_member_id || '').toString();
  if (!roomId || !toId) return res.status(400).json({ error: 'Missing room_id or to_member_id' });

  // The caller must be in the room they are asking through — otherwise one
  // room's key would let you reach into another room's roster.
  if (req.roomMember && req.roomMember.room_id !== roomId) {
    return res.status(403).json({ error: 'Key is for a different room' });
  }
  const room = db.getRoomById.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const target = db.getRoomMembers.all(roomId).find((m) => m.member_id === toId);
  if (!target) return res.status(404).json({ error: 'That person is not in this room' });
  if (!target.identity_hash) {
    return res.status(409).json({ error: 'That person is on an older Terse that cannot keep friends yet' });
  }
  const them = target.identity_hash;
  if (them === req.idHash) return res.status(400).json({ error: 'You cannot add yourself' });

  const existing = db.getFriendEdge.get({ x: req.idHash, y: them });
  if (existing) {
    // Both sides asking is agreement, so it is honoured as one: the second
    // request accepts the first instead of creating a mirror-image pending row
    // that neither person could resolve.
    if (existing.status === 'pending' && existing.b_hash === req.idHash) {
      db.respondFriend.run('accepted', existing.id);
      const now = db.getFriendById.get(existing.id);
      bus.emit(chan(roomId), { type: 'friend', edge: publicEdge(now) });
      return res.json({ ok: true, friendship: shape(now, req.idHash), accepted: true });
    }
    return res.json({ ok: true, friendship: shape(existing, req.idHash), existing: true });
  }

  const edge = {
    id: uuid(),
    a_hash: req.idHash,
    b_hash: them,
    a_name: clip(req.name, 40),
    b_name: clip(target.name, 40),
    a_email: req.email || null,
    b_email: lc(target.user_email),
    room_id: roomId,
  };
  db.addFriendRequest.run(edge);
  const stored = db.getFriendById.get(edge.id);
  // Fanned out on the ROOM channel: both people are already listening there, so
  // it lands live without inventing a second delivery mechanism.
  bus.emit(chan(roomId), { type: 'friend', edge: publicEdge(stored) });
  res.json({ ok: true, friendship: shape(stored, req.idHash) });
});

/** What may leave the server. Identity hashes are secrets-adjacent: they are
    what a friendship is keyed by, so they never go out over the room channel. */
function publicEdge(e) {
  return { id: e.id, status: e.status, a_name: e.a_name, b_name: e.b_name, room_id: e.room_id };
}

// ════════════════════════════════════════
//  Friend links — no room required
// ════════════════════════════════════════

// POST /api/cloud/friends/link   → { url, token }
// A link you can paste anywhere. Possession IS the consent: whoever opens it is
// befriended immediately, with no request to approve, because the person who
// generated it already decided by sending it. That is the difference from a
// knock, where the decision belongs to whoever is being asked.
//
// It is a token rather than a bare identity because a token can be revoked and
// counted; an identity in a URL is forever and tells you nothing.
router.post('/link', requireIdentity, (req, res) => {
  const existing = db.getFriendInviteByOwner.get(req.idHash);
  if (existing) {
    return res.json({ ok: true, token: existing.token, url: linkUrl(existing.token), reused: true });
  }
  const token = crypto.randomBytes(12).toString('base64url');
  db.addFriendInvite.run({
    token, owner_hash: req.idHash,
    owner_name: clip(req.name, 40) || null,
    owner_email: req.email || null,
  });
  res.json({ ok: true, token, url: linkUrl(token) });
});

const linkUrl = (t) => `https://www.terseai.org/join?friend=${encodeURIComponent(t)}`;

// DELETE /api/cloud/friends/link/:token — revoke it; existing friendships stay.
router.delete('/link/:token', requireIdentity, (req, res) => {
  const inv = db.getFriendInvite.get(req.params.token);
  if (!inv) return res.status(404).json({ error: 'No such link' });
  if (inv.owner_hash !== req.idHash) return res.status(403).json({ error: 'Not your link' });
  db.deleteFriendInvite.run(inv.token);
  res.json({ ok: true });
});

// POST /api/cloud/friends/link/:token/accept — open the link, become friends.
router.post('/link/:token/accept', requireIdentity, (req, res) => {
  const inv = db.getFriendInvite.get(req.params.token);
  if (!inv) return res.status(404).json({ error: 'That link is no longer valid' });
  if (inv.owner_hash === req.idHash) {
    return res.status(400).json({ error: 'That is your own link' });
  }
  const existing = db.getFriendEdge.get({ x: req.idHash, y: inv.owner_hash });
  if (existing) {
    // A pending request between the two is settled by the link, not duplicated:
    // the link is consent, so it can only move things forward.
    if (existing.status !== 'accepted') db.respondFriend.run('accepted', existing.id);
    return res.json({ ok: true, friendship: shape(db.getFriendById.get(existing.id), req.idHash), existing: true });
  }
  const edge = {
    id: uuid(),
    a_hash: inv.owner_hash, b_hash: req.idHash,
    a_name: inv.owner_name, b_name: clip(req.body?.name || req.name, 40) || null,
    a_email: inv.owner_email, b_email: req.email || null,
    room_id: null,
  };
  db.addFriendRequest.run(edge);
  db.respondFriend.run('accepted', edge.id);   // no approval step — see above
  db.bumpFriendInvite.run(inv.token);
  res.json({ ok: true, friendship: shape(db.getFriendById.get(edge.id), req.idHash) });
});

// POST /api/cloud/friends/:id/respond   Body: { accept: true|false }
router.post('/:id/respond', requireIdentity, (req, res) => {
  const edge = db.getFriendById.get(req.params.id);
  if (!edge) return res.status(404).json({ error: 'No such request' });
  // Only the person who was ASKED may answer, or the requester could accept on
  // the other person's behalf.
  if (edge.b_hash !== req.idHash) {
    return res.status(403).json({ error: 'Only the person who was asked can answer' });
  }
  if (edge.status !== 'pending') {
    return res.status(409).json({ error: 'That request was already answered' });
  }
  db.respondFriend.run(req.body?.accept === false ? 'declined' : 'accepted', edge.id);
  const now = db.getFriendById.get(edge.id);
  if (now.room_id) bus.emit(chan(now.room_id), { type: 'friend', edge: publicEdge(now) });
  res.json({ ok: true, friendship: shape(now, req.idHash) });
});

// GET /api/cloud/friends  → { friends, incoming, outgoing }
// Works anywhere, room or no room: the install secret is the credential.
router.get('/', requireIdentity, (req, res) => {
  const edges = db.listFriendEdges.all(req.idHash, req.idHash).map((e) => shape(e, req.idHash));
  res.json({
    ok: true,
    friends: edges.filter((e) => e.status === 'accepted'),
    incoming: edges.filter((e) => e.status === 'pending' && e.direction === 'incoming'),
    outgoing: edges.filter((e) => e.status === 'pending' && e.direction === 'outgoing'),
  });
});

// DELETE /api/cloud/friends/:id — unfriend, or withdraw a request. Either side.
router.delete('/:id', requireIdentity, (req, res) => {
  const edge = db.getFriendById.get(req.params.id);
  if (!edge) return res.status(404).json({ error: 'No such friendship' });
  if (edge.a_hash !== req.idHash && edge.b_hash !== req.idHash) {
    return res.status(403).json({ error: 'Not yours to remove' });
  }
  db.deleteFriend.run(edge.id);
  res.json({ ok: true });
});

module.exports = router;
