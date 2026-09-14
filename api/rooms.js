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
const fs = require('fs');
const path = require('path');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

/* ── Agent channel limits ───────────────────────────────────────────────────
   Every loop incident on record (OpenClaw bot-to-bot storms, the nine-day relay
   in "Agents of Chaos") happened because nothing OUTSIDE the agents stopped
   them. So the stop lives here, in the relay, not in a prompt: after RUN_CAP
   agent messages with no person speaking, agent posts are refused until a
   human says anything at all. Public rooms get a shorter leash. */
const RUN_CAP_PRIVATE = 8;
const RUN_CAP_PUBLIC = 4;
const runCap = (room) => (room.visibility === 'public' ? RUN_CAP_PUBLIC : RUN_CAP_PRIVATE);
const AGENT_PER_MIN = 6;
const AGENT_BODY_MAX = 8000;
const FILE_MAX = 20 * 1024 * 1024;          // per file
const ROOM_FILES_MAX = 200 * 1024 * 1024;   // live bytes per room
const FILES_DIR = path.join(db.DATA_DIR, 'room-files');

/* Characters a person cannot see but a model reads: zero-widths, bidi
   overrides, and the Unicode TAG block (U+E0000–E007F, a surrogate pair in
   UTF-16) that "ASCII smuggling" hides instructions in. Stripped from anything
   an agent will read, which in a room with agents is every message. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u180E]|\uDB40[\uDC00-\uDC7F]/g;
const scrub = (s) => (typeof s === 'string' ? s.replace(INVISIBLE, '') : s);
const parseJSON = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
/** A stored row as clients see it: meta parsed, role defaulted for old rows. */
const shape = (row) => {
  if (!row) return row;
  const { meta, ...m } = row;
  return { ...m, role: m.role || 'human', meta: parseJSON(meta) };
};

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

/* A PURE read. Ageing-out used to happen here, which meant whichever request
   happened to read next performed the transition — and if that request had no
   reason to broadcast, everyone already connected simply never found out the
   person had gone. Reads are now reads; sweepPresence() below owns the change. */
function roster(roomId) {
  // identity_hash is what a friendship is keyed by, so it stays server-side: the
  // roster goes to everyone in the room, and a friend request names a member id.
  return db.getRoomMembers.all(roomId)
    .map(({ identity_hash, agent, keyed, ...m }) => ({ ...m, agent: parseJSON(agent), keyed: !!keyed }));
}

/* Who owns this room. The creation key still counts — an owner who never sent
   an identity (or created the room before identities existed) must not be locked
   out of their own room — but the identity is what actually persists: a key is
   replaced every time you walk back in, an install identity is not. */
function ownsRoom(room, identityHash) {
  return !!(identityHash && room.owner_identity && room.owner_identity === identityHash);
}
function isOwner(req) {
  if (req.room.owner_key_hash === hash(req.rawKey)) return true;
  return ownsRoom(req.room, idHash(req));
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

/** This caller's install identity, hashed. Headers for POSTs, query for SSE. */
const idHash = (req) => {
  const secret = req.headers['x-terse-identity'] || req.query.identity;
  return secret ? hash(secret.toString()) : null;
};

/* What a client would actually SEE of the roster. Presence heartbeats are the
   most frequent call in the product and almost never change this, so it is the
   right thing to compare before deciding to wake everyone up. */
function sigOf(members) {
  // Sorted: this compares WHO IS HERE and how, not the order a query happened to
  // return them in. Without the sort, two people who joined in the same second
  // tie on joined_at and can come back either way round, which reads as a change
  // and broadcasts to everyone — the exact storm this is meant to prevent.
  // The agent is part of what a client SEES (the 🤖 badge), so connecting one
  // is a roster change. Raw rows carry it as the stored JSON string, parsed rows
  // as an object; stringifying the object reproduces the stored text exactly.
  const ag = (a) => (!a ? '' : typeof a === 'string' ? a : JSON.stringify(a));
  return members.map((m) => m.member_id + '|' + (m.name || '') + '|' + m.status + '|' + ag(m.agent) +
    '|' + (m.pubkey || '') + '|' + (m.keyed ? 1 : 0))
    .sort().join('~');
}
/* Deliberately WITHOUT ageing anybody out. roster() ages out as a side effect,
   so using it for the "before" snapshot hides the very transition this is meant
   to detect: the member who closed their laptop would be marked offline while
   computing the baseline, and then compare equal to themselves. */
const rosterSigRaw = (roomId) => sigOf(db.getRoomMembers.all(roomId));

function publicRoom(room) {
  return {
    id: room.id, code: room.code, name: room.name || null,
    visibility: room.visibility || 'private', category: room.category || null,
    agents_allowed: room.agents_allowed !== 0,
    e2e: !!room.e2e, key_id: room.key_id || null,
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
  if (b.agents === false) db.setRoomAgentsAllowed.run(0, room.id);
  // End-to-end encryption is for rooms you hand the code to. The creator's
  // device makes the key; this only records that the room expects ciphertext.
  if (b.e2e === true && visibility(b.visibility) === 'private') db.setRoomE2E.run(1, room.id);
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
  const identity = b.identity ? hash(b.identity.toString()) : null;
  const member = {
    room_id: room.id,
    key_hash: hash(key),
    member_id: uuid(),
    name: clip((b.name || '').toString().trim(), 40) || null,
    user_email: (b.email || '').toString().trim().toLowerCase() || null,
    identity_hash: identity,
  };
  /* Coming back is RE-entering, not arriving. Every join mints a fresh key, so
     without replacing the old seat the same person accumulates rows: a roster
     full of their own offline ghosts and a member count that only ever grows.
     The member id is carried over so their past messages stay theirs. */
  const prior = identity ? db.findRoomMemberByIdentity.get(room.id, identity) : null;
  if (prior) {
    member.member_id = prior.member_id;
    db.removeRoomMembersByIdentity.run(room.id, identity);
  }
  db.addRoomMember.run(member);
  makeActiveRoom(identity, room.id);
  const list = roster(room.id);
  bus.emit(chan(room.id), { type: 'roster', members: list });
  res.json({ ok: true, room: publicRoom(room), key, member_id: member.member_id,
             owner: ownsRoom(room, identity), members: list });
});

// POST /api/cloud/rooms/:id/leave
// Gives up your SEAT, not the room. The owner leaving is the interesting case:
// the room stays open, everybody still in it keeps talking, the code still
// works, and the owner walks back in later as the owner — ownership lives on
// the room's identity, not on the key that happened to be sitting in a browser.
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
  // A closed room's files have no one left to fetch them. The rows go with the
  // next sweep; the bytes go now.
  fs.rm(path.join(FILES_DIR, req.room.id), { recursive: true, force: true }, () => {});
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
  const me = idHash(req);
  const rows = db.listPublicRooms.all({
    identity: me,
    category: category(req.query.category),
    limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50)),
  });
  res.json({
    ok: true,
    categories: CATEGORIES,
    rooms: rows.map((r) => ({
      id: r.id, name: r.name || null, category: r.category || null,
      members: r.members, online: r.online, created_at: r.created_at,
      agents_allowed: r.agents_allowed !== 0, agents: r.agents || 0,
      // Whether the browser is already inside. Offering "ask to join" for a room
      // you own is a button that can never do anything: the knock arrives, and
      // the only person who could answer it is the one who pressed it.
      joined: !!r.joined, owner: !!r.owner,
      // The CODE is withheld from strangers — a listing that handed out the
      // credential would make "ask to join" theatre — but not from people who
      // already hold it. Returning it to them is what makes walking back into
      // your own room survive a cleared browser store.
      code: (r.joined || r.owner) ? r.code : undefined,
    })),
  });
});

// GET /api/cloud/rooms/mine   (identity, no room key)
// Every room this install can walk back into: the ones it joined and the ones it
// owns, present in them or not. This is server-side on purpose — membership
// outlives presence, so the way back into a room must not be a browser store
// that a reinstall wipes.
router.get('/mine', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const rows = db.listRoomsForIdentity.all({
    identity: me,
    limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20)),
  });
  res.json({
    ok: true,
    rooms: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name || null,
      category: r.category || null, visibility: r.visibility || 'private',
      members: r.members, online: r.online,
      owner: !!r.owner, joined: !!r.joined,
      last_seen_at: r.last_seen_at || null, created_at: r.created_at,
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
  if (typeof b.agents === 'boolean') db.setRoomAgentsAllowed.run(b.agents ? 1 : 0, req.room.id);
  // A listed room is walked into by strangers, and the key would be handed to
  // each of them automatically — encryption would only be theatre. Listing turns
  // it off, and the room is told.
  if (req.room.e2e && visibility(b.visibility) === 'public') setE2E(req.room, false);
  res.json({ ok: true, room: publicRoom(db.getRoomById.get(req.room.id)) });
});

// ════════════════════════════════════════
//  Knocking — asking to enter, owner decides
// ════════════════════════════════════════

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
    messages: db.getRoomMessages.all(req.room.id, 50).reverse().map(shape),
    keyshares: db.keysharesFor.all(req.room.id, req.member.member_id),
  });
});

// GET /api/cloud/rooms/:id/messages?before=<created_at>&before_id=<id>&limit=
// Older pages, for a chat window scrolling up. Returned oldest-first so the
// caller can prepend the block as-is.
router.get('/:id/messages', requireMember, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const before = parseInt(req.query.before, 10);
  const rows = Number.isFinite(before)
    ? db.getRoomMessagesBefore.all(req.room.id, before, limit)
    : db.getRoomMessages.all(req.room.id, limit);
  res.json({ ok: true, messages: rows.reverse().map(shape), more: rows.length === limit });
});

// GET /api/cloud/rooms/:id/projects
/* 房间里每个人的代码城市。
 *
 * ⚠ 这是**服务端才能做的连接**。名册发给客户端时 identity_hash 是被摘掉的
 * (见 roster()),这是对的 —— 好友关系就是按它记的,不该发给同屋的每个人。
 * 可是"这个成员发布过什么"恰恰要拿它去广场里查,所以这一步只能在这里做:
 * 手机拿到的是**已经配好对的**成员和胶囊,自始至终没见过任何人的身份串。
 *
 * ⚠ 短身份是长身份的前缀,不是另一串。房间存 64 位,广场存前 32 位;这里截一刀
 * 就对上了,截错了就是"所有人都没有项目",而且不会报错 —— 只会安安静静地空着。
 *
 * 一人一座城,不是一人一串城:房间是一屋子人,轮播的单位是人。谁最近发布的那颗
 * 就代表谁 —— 他自己最后一次选择展示的东西,而不是他最出名的那个。
 *
 * 没有发布过的人不占位置(filter),但**留在名册里** —— 名册说的是谁在屋里,
 * 这里说的是屋里有什么可看的,两件事。
 */
router.get('/:id/projects', requireMember, (req, res) => {
  const out = [];
  for (const m of db.getRoomMembers.all(req.room.id)) {
    if (!m.identity_hash) continue;          // 没有身份的老成员:没有广场地址
    const short = String(m.identity_hash).slice(0, 32);
    const rows = db.wallProjectsByIdentity.all({ identity: short, limit: 1 });
    if (!rows.length) continue;
    const r = rows[0];
    let capsule = null;
    try { capsule = JSON.parse(r.capsule); } catch (e) { /* 坏胶囊 = 这个人没有城 */ }
    if (!capsule) continue;
    out.push({
      member_id: m.member_id,
      name: m.name || null,
      status: m.status || 'offline',
      project: { id: r.id, title: r.title, published_at: r.published_at, capsule },
    });
  }
  res.json({ ok: true, projects: out });
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
    messages: db.getRoomMessages.all(req.room.id, 50).reverse().map(shape),
    keyshares: db.keysharesFor.all(req.room.id, req.member.member_id),
  })}\n\n`);

  const unsubscribe = bus.subscribe(chan(req.room.id), res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
});

// POST /api/cloud/rooms/:id/name   Body: { name }
// Your nickname — what everyone else sees in the roster. It is applied to every
// room this install sits in, not just this one: a name is who you are, and
// having to rename yourself once per room is how people end up as "someone".
router.post('/:id/name', requireMember, (req, res) => {
  const name = clip((req.body?.name || '').toString().trim(), 40) || null;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (req.member.identity_hash) {
    db.renameRoomMemberEverywhere.run(name, req.member.identity_hash);
  } else {
    db.renameRoomMember.run(name, req.room.id, hash(req.rawKey));
  }
  bus.emit(chan(req.room.id), { type: 'roster', members: roster(req.room.id) });
  res.json({ ok: true, name });
});

// POST /api/cloud/rooms/:id/presence   Body: { status? }
// A heartbeat is the most frequent call in the product and almost never changes
// anything: it refreshes last_seen_at on somebody who was already online. If it
// broadcast the roster regardless, N people in a room would generate N² roster
// deliveries every heartbeat interval, and every one of them makes every client
// re-render a list that is identical to the list it already has. That is felt as
// stutter while typing, and it gets worse as the room fills — the opposite of
// what a room is for. So the roster only goes out when it actually changed.
router.post('/:id/presence', requireMember, (req, res) => {
  const status = ['online', 'away', 'offline'].includes(req.body?.status) ? req.body.status : 'online';
  // Compare the roster around the write rather than just checking my own status.
  // Ageing-out happens inside roster(), and it used to reach clients only because
  // every heartbeat broadcast; with that removed, a member who closed their
  // laptop would silently stay "online" forever unless the comparison notices.
  const before = rosterSigRaw(req.room.id);
  db.touchRoomMember.run(status, req.room.id, hash(req.rawKey));
  // A heartbeat says where you ARE, so it also settles where you are not. That
  // one DOES change other rooms, and makeActiveRoom broadcasts to them itself.
  if (status === 'online' && req.member.identity_hash) {
    makeActiveRoom(req.member.identity_hash, req.room.id);
  }
  const after = roster(req.room.id);
  const changed = before !== sigOf(after);
  if (changed) bus.emit(chan(req.room.id), { type: 'roster', members: after });
  res.json({ ok: true, changed });
});

// POST /api/cloud/rooms/:id/log   Body: { text, kind? }
// One agent log line. It is NOT persisted: the wallpaper renders what is
// happening now, and a room that replayed an hour of someone else's log on join
// would be unreadable. Presence and chat persist; the log stream does not.
router.post('/:id/log', requireMember, (req, res) => {
  const raw = (req.body?.text || '').toString().trim();
  const text = raw.startsWith('e1:') ? raw.slice(0, 2000) : clip(raw, 300);
  if (!text) return res.status(400).json({ error: 'Missing text' });
  const bad = sealing(req.room, text);
  if (bad) return res.status(400).json({ error: bad });
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

// POST /api/cloud/rooms/:id/messages   Body: { body?, image_url?, to_agents?, file? }
// Chat. Emoji need no special handling — the column is TEXT and the transport is
// JSON, so they are just characters. `to_agents` marks a line as addressed to
// the agents in the room (each owner's Terse decides whether to hand it to its
// agent); `file` attaches something already uploaded to /files.
router.post('/:id/messages', requireMember, (req, res) => {
  const body = bodyOf(req.body?.body, 2000, 12000);
  const image = clip((req.body?.image_url || '').toString().trim(), 500) || null;
  const bad = sealing(req.room, body);
  if (bad) return res.status(400).json({ error: bad });
  // A link in an encrypted room would be the one thing the relay can read.
  if (image && req.room.e2e) return res.status(400).json({ error: 'Images by link are not allowed in an encrypted room' });
  const file = attachedFile(req, req.body?.file);
  if (file && file.error) return res.status(400).json({ error: file.error });
  if (!body && !image && !file) return res.status(400).json({ error: 'Empty message' });
  if (image && !/^https:\/\//i.test(image)) {
    return res.status(400).json({ error: 'image_url must be https' });
  }
  const meta = {};
  if (req.body?.to_agents === true) meta.to_agents = true;
  if (file) meta.file = file;
  const msg = {
    id: uuid(),
    room_id: req.room.id,
    member_id: req.member.member_id,
    name: req.member.name || null,
    body: body || null,
    image_url: image,
    role: 'human',
    meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
  };
  db.addRoomMessageEx.run(msg);
  db.touchRoomMember.run('online', req.room.id, hash(req.rawKey));
  const stored = shape(db.getRoomMessage.get(msg.id));
  bus.emit(chan(req.room.id), { type: 'message', message: stored });
  res.json({ ok: true, message: stored });
});

// ════════════════════════════════════════
//  Agent channel
// ════════════════════════════════════════
/* A member can connect ONE local agent. What connects is decided on the
   member's own Mac: which session, whether peer messages reach it on their own,
   what is allowed out. The relay's job is narrower and it does it without
   trusting either side — it stamps who spoke (a client cannot pass an agent's
   words off as a person's, or the reverse), it enforces the loop breaker, and
   it carries files as opaque blobs it never opens. */

/** A room-scoped system line (joins, pauses). Stored so late joiners see why
    the agents went quiet. */
function systemLine(room, text, meta) {
  const msg = { id: uuid(), room_id: room.id, member_id: 'system', name: null, body: text,
                image_url: null, role: 'system', meta: meta ? JSON.stringify(meta) : null };
  db.addRoomMessageEx.run(msg);
  const stored = shape(db.getRoomMessage.get(msg.id));
  bus.emit(chan(room.id), { type: 'message', message: stored });
  return stored;
}

/** Resolve `file` (an id) to the attachment a message may carry — only a live
    file in THIS room that the sender uploaded themselves. */
function attachedFile(req, id) {
  if (!id) return null;
  const f = db.getRoomFile.get(String(id));
  if (!f || f.room_id !== req.room.id) return { error: 'No such file' };
  if (f.member_id !== req.member.member_id) return { error: 'You can only attach your own upload' };
  return { id: f.id, name: f.name, size: f.size, sha256: f.sha256 };
}

// POST /api/cloud/rooms/:id/agent   Body: { on, kind?, label? }
// Connect or disconnect my agent. Everyone sees the badge change, and the room
// gets a line saying so — an agent arriving in a conversation is not something
// that should happen silently.
router.post('/:id/agent', requireMember, (req, res) => {
  const on = req.body?.on !== false;
  if (on && req.room.agents_allowed === 0) {
    return res.status(403).json({ error: 'The owner has turned agents off in this room' });
  }
  const was = parseJSON(req.member.agent);
  const agent = on ? {
    kind: clip((req.body?.kind || 'agent').toString().replace(/[^\w.-]/g, ''), 24) || 'agent',
    label: scrub(clip((req.body?.label || '').toString().trim(), 40)) || null,
    since: was?.since || Date.now(),
  } : null;
  db.setRoomMemberAgent.run(agent ? JSON.stringify(agent) : null, req.room.id, hash(req.rawKey));
  const who = req.member.name || 'someone';
  if (!!was !== !!agent) {
    systemLine(req.room, agent ? `${who} connected their agent (${agent.kind})`
                               : `${who} disconnected their agent`,
               { event: agent ? 'agent_on' : 'agent_off', member_id: req.member.member_id,
                 name: who, kind: (agent || was || {}).kind || null });
  }
  bus.emit(chan(req.room.id), { type: 'roster', members: roster(req.room.id) });
  res.json({ ok: true, agent, run_cap: runCap(req.room) });
});

// POST /api/cloud/rooms/:id/agent/messages   Body: { body, to?, in_reply_to?, file? }
// What an agent says. Posted by the member's own Terse (never by the agent
// directly — the agent reaches this only through its owner's machine, which
// scans for secrets first). Refused, with a reason the agent can act on, when
// the room has had enough agent talk without a person in it.
router.post('/:id/agent/messages', requireMember, (req, res) => {
  const agent = parseJSON(req.member.agent);
  if (!agent) return res.status(409).json({ error: 'Connect your agent to the room first' });
  if (req.room.agents_allowed === 0) {
    return res.status(403).json({ error: 'The owner has turned agents off in this room' });
  }
  const body = bodyOf(req.body?.body, AGENT_BODY_MAX, AGENT_BODY_MAX * 5);
  const bad = sealing(req.room, body);
  if (bad) return res.status(400).json({ error: bad });
  const file = attachedFile(req, req.body?.file);
  if (file && file.error) return res.status(400).json({ error: file.error });
  if (!body && !file) return res.status(400).json({ error: 'Empty message' });

  // The loop breaker. Counted from the database, so any human line resets it.
  const cap = runCap(req.room);
  const run = db.agentRunSinceHuman.get({ room_id: req.room.id }).n;
  if (run >= cap) {
    const last = shape(db.lastRoomMessage.get(req.room.id));
    if (!(last && last.role === 'system' && last.meta?.event === 'paused')) {
      systemLine(req.room, `Agents paused after ${cap} messages in a row. Any person saying anything resumes them.`,
                 { event: 'paused', cap });
    }
    return res.status(429).json({ error: 'paused', paused: true, cap,
      hint: 'The room paused agents until a person speaks. Wait for your owner or the other people.' });
  }
  const recent = db.recentAgentMessagesBy.all(req.room.id, req.member.member_id);
  const lastMinute = recent.filter((r) => Date.parse(r.created_at.replace(' ', 'T') + 'Z') > Date.now() - 60000);
  if (lastMinute.length >= AGENT_PER_MIN) {
    return res.status(429).json({ error: 'Too fast', hint: `At most ${AGENT_PER_MIN} agent messages a minute.` });
  }
  // Saying the same thing twice is the signature of a loop, not of a point.
  if (body && recent.some((r) => r.body === body)) {
    return res.json({ ok: true, dropped: 'duplicate' });
  }

  let to = null;
  if (req.body?.to) {
    to = String(req.body.to);
    if (!db.getRoomMembers.all(req.room.id).some((m) => m.member_id === to)) {
      return res.status(400).json({ error: 'No such member in this room' });
    }
  }
  const meta = { agent: { kind: agent.kind, label: agent.label } };
  if (to) meta.to = to;
  if (req.body?.in_reply_to) meta.in_reply_to = clip(String(req.body.in_reply_to), 64);
  if (file) meta.file = file;
  const msg = {
    id: uuid(), room_id: req.room.id, member_id: req.member.member_id,
    name: req.member.name || null, body: body || null, image_url: null,
    role: 'agent', meta: JSON.stringify(meta),
  };
  db.addRoomMessageEx.run(msg);
  db.touchRoomMember.run('online', req.room.id, hash(req.rawKey));
  const stored = shape(db.getRoomMessage.get(msg.id));
  bus.emit(chan(req.room.id), { type: 'message', message: stored });
  res.json({ ok: true, message: stored, run: run + 1, cap });
});

// POST /api/cloud/rooms/:id/files   raw body; headers x-file-name, x-file-sha256?
// Upload a blob; attach it to a message afterwards by id. Private rooms only —
// in a public room anyone can walk in, and a stranger handing your agent a file
// is the attack, not the feature. The relay never opens what it stores.
router.post('/:id/files', requireMember,
  express.raw({ type: () => true, limit: FILE_MAX + 1024 }), (req, res) => {
  if (req.room.visibility === 'public') {
    return res.status(403).json({ error: 'Files are off in public rooms' });
  }
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > FILE_MAX) return res.status(413).json({ error: 'File is larger than 20 MB' });
  if (db.roomFilesBytes.get(req.room.id).n + buf.length > ROOM_FILES_MAX) {
    return res.status(413).json({ error: 'This room has 200 MB of files already; older ones expire after 7 days' });
  }
  let name = '';
  try { name = decodeURIComponent((req.headers['x-file-name'] || '').toString()); } catch { name = ''; }
  // A name, never a path: the receiver writes it into a folder on their disk.
  if (req.room.e2e) {
    // The name is ciphertext too; the receiver decrypts it and reduces it to a
    // basename on their side. Base64url has no path separators to worry about.
    if (!E1.test(name) || name.length > 800) return res.status(400).json({ error: 'This room is end-to-end encrypted — update Terse' });
  } else {
    name = scrub(path.basename(name.replace(/\\/g, '/'))).replace(/[\x00-\x1f]/g, '').slice(0, 120).trim();
    if (!name || name === '.' || name === '..') name = 'file';
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const claimed = (req.headers['x-file-sha256'] || '').toString().toLowerCase();
  if (claimed && claimed !== sha256) return res.status(400).json({ error: 'Checksum mismatch' });

  const id = uuid();
  const dir = path.join(FILES_DIR, req.room.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id), buf);
  db.addRoomFile.run({ id, room_id: req.room.id, member_id: req.member.member_id,
                       name, size: buf.length, sha256 });
  res.json({ ok: true, file: { id, name, size: buf.length, sha256 } });
});

// GET /api/cloud/rooms/:id/files/:fid  — members only; always a download, never
// rendered: served as opaque bytes so no browser will sniff and run it.
router.get('/:id/files/:fid', requireMember, (req, res) => {
  const f = db.getRoomFile.get(req.params.fid);
  if (!f || f.room_id !== req.room.id) return res.status(404).json({ error: 'File expired or not found' });
  const p = path.join(FILES_DIR, f.room_id, f.id);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File expired or not found' });
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'X-File-Sha256': f.sha256,
    'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(p).pipe(res);
});

/* ── End-to-end encryption ──────────────────────────────────────────────────
   In an e2e room every body the relay stores is "e1:" + base64url(iv|AES-GCM
   ciphertext), sealed with a key only the members' devices hold. The relay's
   part is to refuse plaintext (a client that forgot to encrypt must fail, not
   leak) and to carry sealed key-shares between devices it cannot open. */
const E1 = /^e1:[A-Za-z0-9_-]{16,}$/;
/** Clip a body — generously if it is ciphertext, which is ~1.4× its text. */
function bodyOf(v, plainMax, sealedMax) {
  const raw = (v || '').toString().trim();
  return raw.startsWith('e1:') ? raw.slice(0, sealedMax) : scrub(clip(raw, plainMax));
}
/** Why this body cannot go into this room, or null. */
function sealing(room, body) {
  if (!body) return null;
  const sealed = body.startsWith('e1:');
  if (room.e2e && !E1.test(body)) return 'This room is end-to-end encrypted — update Terse to talk in it';
  if (!room.e2e && sealed) return 'This room is not encrypted';
  return null;
}
function setE2E(room, on) {
  db.setRoomE2E.run(on ? 1 : 0, room.id);
  // A new key means nobody holds it yet; old shares are for a key that is gone.
  db.unkeyRoom.run(room.id);
  db.clearRoomKeyshares.run(room.id);
  const fresh = db.getRoomById.get(room.id);
  bus.emit(chan(room.id), { type: 'room', room: publicRoom(fresh) });
  bus.emit(chan(room.id), { type: 'roster', members: roster(room.id) });
  systemLine(fresh, on
    ? '🔒 Messages, agent messages and files in this room are now end-to-end encrypted. Earlier messages stay as they were.'
    : '🔓 End-to-end encryption is off — the relay can read new messages.', { event: on ? 'e2e_on' : 'e2e_off' });
}

// POST /api/cloud/rooms/:id/e2e   Body: { on }   (owner; private rooms only)
router.post('/:id/e2e', requireMember, (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the room owner can change encryption' });
  const on = req.body?.on !== false;
  if (on && req.room.visibility === 'public') {
    return res.status(409).json({ error: 'Remove the room from the Plaza first — a listed room hands its key to anyone who walks in' });
  }
  if (!!req.room.e2e !== on) setE2E(req.room, on);
  res.json({ ok: true, room: publicRoom(db.getRoomById.get(req.room.id)) });
});

// POST /api/cloud/rooms/:id/pubkey   Body: { pubkey }  — this device's public key.
// A changed key (reinstall, new device on the same seat) means the old shares
// were sealed for a key this device no longer has.
router.post('/:id/pubkey', requireMember, (req, res) => {
  const pubkey = (req.body?.pubkey || '').toString();
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(pubkey)) return res.status(400).json({ error: 'Bad public key' });
  const changed = req.member.pubkey !== pubkey;
  db.setMemberPubkey.run({ pubkey, keyed: changed ? 0 : (req.member.keyed || 0),
                           room_id: req.room.id, key_hash: hash(req.rawKey) });
  if (changed) {
    db.clearKeysharesFor.run(req.room.id, req.member.member_id);
    bus.emit(chan(req.room.id), { type: 'roster', members: roster(req.room.id) });
  }
  res.json({ ok: true, changed });
});

// POST /api/cloud/rooms/:id/keyed   Body: { key_id }  — "I hold the room key."
// The first device to say so names the key (its hash, never the key). Anyone
// later must hold the SAME key: a device that raced to make a second one is
// told 409 and drops it, and waits for a share of the real one instead.
router.post('/:id/keyed', requireMember, (req, res) => {
  if (!req.room.e2e) return res.status(409).json({ error: 'This room is not encrypted' });
  const keyId = (req.body?.key_id || '').toString();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(keyId)) return res.status(400).json({ error: 'Bad key id' });
  if (!req.room.key_id) {
    db.setRoomKeyId.run(keyId, req.room.id);
    const fresh = db.getRoomById.get(req.room.id);
    if (fresh.key_id !== keyId) return res.status(409).json({ error: 'stale key', key_id: fresh.key_id });
    bus.emit(chan(req.room.id), { type: 'room', room: publicRoom(fresh) });
  } else if (req.room.key_id !== keyId) {
    return res.status(409).json({ error: 'stale key', key_id: req.room.key_id });
  }
  if (!req.member.keyed) {
    db.setMemberKeyed.run(req.room.id, hash(req.rawKey));
    bus.emit(chan(req.room.id), { type: 'roster', members: roster(req.room.id) });
  }
  res.json({ ok: true, key_id: keyId });
});

// POST /api/cloud/rooms/:id/keyshares   Body: { to, from_pub, blob }
// A member who holds the key hands it to one who doesn't — sealed to the
// recipient's public key. Only keyed members may hand it on, so a stranger in
// the room cannot flood others with shares of a key they invented.
router.post('/:id/keyshares', requireMember, (req, res) => {
  if (!req.room.e2e) return res.status(409).json({ error: 'This room is not encrypted' });
  if (!req.member.keyed) return res.status(403).json({ error: 'Only someone who holds the key can hand it on' });
  const to = (req.body?.to || '').toString();
  const blob = (req.body?.blob || '').toString();
  const fromPub = (req.body?.from_pub || '').toString();
  if (!/^[A-Za-z0-9_-]{40,400}$/.test(blob) || !/^[A-Za-z0-9_-]{40,200}$/.test(fromPub)) {
    return res.status(400).json({ error: 'Bad key share' });
  }
  if (fromPub !== req.member.pubkey) return res.status(400).json({ error: 'Publish your public key first' });
  const target = db.getRoomMembers.all(req.room.id).find((m) => m.member_id === to);
  if (!target || to === req.member.member_id) return res.status(404).json({ error: 'No such member' });
  db.upsertKeyshare.run({ room_id: req.room.id, to_member: to, from_member: req.member.member_id,
                          from_pub: fromPub, blob });
  // Only the recipient needs to act; everyone else ignores it.
  bus.emit(chan(req.room.id), { type: 'keyshare', to });
  res.json({ ok: true });
});

// GET /api/cloud/rooms/:id/keyshares — the sealed shares addressed to me.
router.get('/:id/keyshares', requireMember, (req, res) => {
  res.json({ ok: true, keyshares: db.keysharesFor.all(req.room.id, req.member.member_id) });
});

/* Expired files and files of closed rooms. Hourly is plenty — expiry is a disk
   budget, not a promise to the minute. */
function sweepFiles() {
  for (const f of db.expiredRoomFiles.all()) {
    fs.rm(path.join(FILES_DIR, f.room_id, f.id), { force: true }, () => {});
    db.deleteRoomFile.run(f.id);
  }
}
setInterval(sweepFiles, 60 * 60 * 1000).unref();

/* Age out anyone who stopped heartbeating, and TELL the rooms they were in.
   Runs on a timer rather than off the back of a read, so the transition happens
   once, at a predictable moment, and always reaches the people watching. Paired
   with server.js, which calls this well inside the staleness window. */
router.sweepPresence = function sweepPresence() {
  const affected = db.roomsWithStaleMembers.all(PRESENCE_STALE).map((r) => r.room_id);
  if (!affected.length) return 0;
  db.ageOutRoomMembers.run(PRESENCE_STALE);
  for (const id of affected) bus.emit(chan(id), { type: 'roster', members: roster(id) });
  return affected.length;
};

module.exports = router;
