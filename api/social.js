/**
 * social.js — Terse 的「Agent 社交卡片」。一个 Facebook,但填表的那一步是你的
 * agent 替你做的。
 *
 * THE ONE IDEA. A human pastes one prompt into the agent they already run. The
 * agent reads what it already knows about them — the repos on this machine, the
 * languages, what they have been building — writes a first draft of the card,
 * and posts it here. Nothing is public yet: a draft has no code and is in no
 * directory. The human opens Terse, fixes the three things the agent got wrong,
 * and presses publish. THAT is the moment a card gets an agent code and becomes
 * findable. 把审核放在发布之前,而不是发布之后 —— 这是这个模块最重要的一条线。
 *
 * WHY A DRAFT IS A REAL ROW AND NOT A CLIENT-SIDE SCRATCHPAD. The agent writes
 * it in one process and the human reviews it in another — a different window,
 * often a different moment, sometimes a different device on the same install.
 * Keeping the draft only in the agent's head would mean the review had to happen
 * in the terminal, which is exactly the experience this feature exists to avoid.
 *
 * WHY THERE ARE TWO IDENTIFIERS.
 *   identity  — sha256 of the install secret. The CREDENTIAL. Never leaves the
 *               server, never appears in any response.
 *   code      — tac_…, the PUBLIC half. Safe in a README, a QR, a tweet. All it
 *               can do is ask to open a channel. Rotating it is one column.
 * Handing out the identity would be handing out the key; that is why the card a
 * stranger reads is assembled by publicCard() and cannot accidentally carry one.
 *
 * WHY OPENING A CHANNEL IS NOT THE SAME AS BEING FRIENDS. Presenting a code
 * creates a PENDING edge and one line of text. Messages only flow on an accepted
 * one. So the worst a stranger with your code can do is put a single line in
 * front of you — and if you turned auto_accept on, that was your decision, made
 * in the app, not a default. 被动加好友是开关,不是默认值。
 *
 * Mounted at /api/cloud/social. The parser limit is raised where it is mounted
 * (server.js) because a card carries inline images; see MAX_* below for the
 * ceilings that actually decide the bill.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

/* ── Ceilings ──────────────────────────────────────────────────────────────
   Every one of these is a bill, not a style preference. Images are stored
   INLINE (like a plaza capsule) so a card renders with one request and no
   third-party fetch — which means the size cap is the entire cost model. */
const MAX_AVATAR_BYTES = 96 * 1024;    // one square, ~256px, jpeg/webp
const MAX_PHOTO_BYTES = 220 * 1024;    // one of the few photos on the card
const MAX_PHOTOS = 6;
const MAX_CARD_BYTES = 1.4 * 1024 * 1024;
const MAX_SKILLS = 12;
const MAX_LINKS = 6;
const MAX_STACK = 10;
/* Opening a channel is the one action a stranger can aim at you, so it is the
   one with a ceiling. 30/hour is far above any honest use and far below what a
   scraper needs to walk a code space. */
const CONNECT_PER_HOUR = 30;
const MESSAGES_PER_HOUR = 120;
/* A phone hand-off is meant to be walked across the room, not left open. */
const PHOTO_SESSION_TTL = '+20 minutes';

const uuid = () => crypto.randomUUID();
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const nowIso = () => new Date().toISOString();

/* Unambiguous alphabet: no 0/O/1/I/l. A code gets read aloud, photographed and
   retyped — every pair that looks alike is a support ticket. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function mintCode() {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'tac_' + out;
}

/** Handles people should not be able to take: they read as Terse itself. */
const RESERVED_HANDLES = new Set([
  'terse', 'admin', 'root', 'support', 'help', 'api', 'www', 'official',
  'staff', 'system', 'agent', 'agents', 'security', 'billing', 'team',
]);

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const multiline = (v, n) => (typeof v === 'string' ? v.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n) : '');
const bool01 = (v) => (v === undefined || v === null ? null : (v ? 1 : 0));

/** Inline images only — a remote URL turns "show me a card" into a request to
 *  somebody else's server, and that image changes under you. */
function dataUrl(v, maxBytes) {
  const s = typeof v === 'string' ? v : '';
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return '';
  return s.length <= maxBytes ? s : '';
}

/** Links are rendered as anchors on someone else's screen. http(s) only: a
 *  javascript: or data: href in a profile is a stored XSS with a nice label. */
function safeLink(l) {
  if (!l || typeof l !== 'object') return null;
  const url = str(l.url, 300);
  if (!/^https?:\/\/[^\s<>"']+$/i.test(url)) return null;
  return { label: str(l.label, 24) || new URL(url).hostname.replace(/^www\./, ''), url };
}

function parseJson(s, fallback) {
  if (!s) return fallback;
  try { const v = JSON.parse(s); return v === null ? fallback : v; } catch { return fallback; }
}

/**
 * Who is calling. Same credential as rooms, friends and the plaza: the install
 * secret, hashed here and never stored raw. No account, no sign-in — because
 * requiring one would break the very first step of "one prompt and you're in".
 */
function requireIdentity(req, res, next) {
  const raw = req.headers['x-terse-identity'] || req.query.identity;
  if (!raw) return res.status(401).json({ error: 'Missing identity. Send x-terse-identity.' });
  req.idHash = sha(raw.toString());
  next();
}

/** Optional identity — the directory is for browsing, signed in or not. */
function optionalIdentity(req, _res, next) {
  const raw = req.headers['x-terse-identity'] || req.query.identity;
  req.idHash = raw ? sha(raw.toString()) : null;
  next();
}

/* ── Shaping ──────────────────────────────────────────────────────────────── */

/** Everything a card's OWNER may see, including the parts nobody else may. */
function ownerCard(row) {
  if (!row) return null;
  return {
    handle: row.handle || null,
    code: row.code || null,
    display_name: row.display_name || null,
    headline: row.headline || null,
    bio: row.bio || null,
    location: row.location || null,
    skills: parseJson(row.skills, []),
    stack: parseJson(row.stack, []),
    links: parseJson(row.links, []),
    agent_kind: row.agent_kind || null,
    agent_name: row.agent_name || null,
    avatar: row.avatar || null,
    photos: parseJson(row.photos, []),
    status: row.status,
    auto_accept: !!row.auto_accept,
    discoverable: !!row.discoverable,
    drafted_by: row.drafted_by,
    views: row.views,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
  };
}

/**
 * What a STRANGER sees. Assembled field by field rather than deleting keys off
 * the row — a new column added to the table must not become public by default,
 * and with a denylist that is exactly what would happen.
 */
function publicCard(row) {
  if (!row) return null;
  return {
    handle: row.handle || null,
    code: row.code || null,
    display_name: row.display_name || null,
    headline: row.headline || null,
    bio: row.bio || null,
    location: row.location || null,
    skills: parseJson(row.skills, []),
    stack: parseJson(row.stack, []),
    links: parseJson(row.links, []),
    agent_kind: row.agent_kind || null,
    agent_name: row.agent_name || null,
    avatar: row.avatar || null,
    photos: parseJson(row.photos, []),
    views: row.views,
    published_at: row.published_at,
  };
}

/** A connection from the caller's point of view, with the other card attached. */
function shapeConnection(edge, me) {
  const outgoing = edge.a_identity === me;
  const peerIdentity = outgoing ? edge.b_identity : edge.a_identity;
  const peer = db.getAgentProfile.get(peerIdentity);
  return {
    id: edge.id,
    status: edge.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    opened_via: edge.opened_via,
    note: edge.note || null,
    created_at: edge.created_at,
    responded_at: edge.responded_at,
    peer: peer ? publicCard(peer) : null,
  };
}

/**
 * The fields an agent or a human may write, clipped one by one. Returns the
 * shape the prepared statements take. `partial` is what a human edit sends: only
 * the keys present are written, so touching the headline does not blank the bio.
 */
function sanitizeCard(body, { partial = false } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const pick = (k, fn) => (partial && !has(k) ? null : fn(body[k]));

  const skills = pick('skills', (v) => JSON.stringify(
    (Array.isArray(v) ? v : []).slice(0, MAX_SKILLS).map((s) => str(s, 28)).filter(Boolean)));
  const stack = pick('stack', (v) => JSON.stringify(
    (Array.isArray(v) ? v : []).slice(0, MAX_STACK).map((s) => str(s, 24)).filter(Boolean)));
  const links = pick('links', (v) => JSON.stringify(
    (Array.isArray(v) ? v : []).slice(0, MAX_LINKS).map(safeLink).filter(Boolean)));
  const photos = pick('photos', (v) => JSON.stringify(
    (Array.isArray(v) ? v : []).slice(0, MAX_PHOTOS).map((p) => dataUrl(p, MAX_PHOTO_BYTES)).filter(Boolean)));

  return {
    display_name: pick('display_name', (v) => str(v, 48) || null),
    headline: pick('headline', (v) => str(v, 120) || null),
    bio: pick('bio', (v) => multiline(v, 1200) || null),
    location: pick('location', (v) => str(v, 48) || null),
    skills, stack, links, photos,
    agent_kind: pick('agent_kind', (v) => str(v, 24).toLowerCase() || null),
    agent_name: pick('agent_name', (v) => str(v, 32) || null),
    avatar: pick('avatar', (v) => dataUrl(v, MAX_AVATAR_BYTES) || null),
  };
}

/** A handle is what humans type at each other. Normalised once, here. */
function normaliseHandle(v) {
  const h = (typeof v === 'string' ? v : '').trim().toLowerCase().replace(/^@/, '');
  if (!h) return { handle: null };
  if (!/^[a-z0-9_]{3,24}$/.test(h)) {
    return { error: 'A handle is 3–24 characters: a–z, 0–9 and _' };
  }
  if (RESERVED_HANDLES.has(h)) return { error: `@${h} is reserved` };
  return { handle: h };
}

/** Cheap total-size gate. The per-field caps bound this already; this is the
 *  second door, because the per-field caps are many and this one is one. */
function tooBig(card) {
  let n = 0;
  for (const v of Object.values(card)) if (typeof v === 'string') n += v.length;
  return n > MAX_CARD_BYTES;
}

/* ── The card ─────────────────────────────────────────────────────────────── */

/**
 * POST /api/cloud/social/profile/draft
 * The agent's move. Body is the whole card it drafted. Always lands as a DRAFT —
 * there is no argument that makes this publish, on purpose: an agent may write
 * your profile, it may not decide to show it to the world.
 */
router.post('/profile/draft', requireIdentity, (req, res) => {
  const body = req.body || {};
  const { handle, error } = normaliseHandle(body.handle);
  if (error) return res.status(400).json({ error });

  const existing = db.getAgentProfile.get(req.idHash);
  if (handle) {
    const taken = db.getAgentProfileByHandle.get(handle);
    if (taken && taken.identity !== req.idHash) return res.status(409).json({ error: `@${handle} is taken` });
  }

  const card = sanitizeCard(body);
  if (!card.display_name) return res.status(400).json({ error: 'display_name is required' });
  if (tooBig(card)) return res.status(413).json({ error: 'Card too large', max: MAX_CARD_BYTES });

  db.upsertAgentProfile.run({
    identity: req.idHash,
    handle: handle || (existing ? existing.handle : null),
    ...card,
    drafted_by: 'agent',
  });
  const row = db.getAgentProfile.get(req.idHash);
  res.json({
    ok: true,
    profile: ownerCard(row),
    /* The agent's job ends here. What it should tell the human is a review step,
       not "you are live" — so the response says so in words the agent can repeat. */
    next: 'Open Terse → Agent Card to review and publish. Nothing is public until you do.',
    review_url: 'terse://social/review',
  });
});

/** GET /api/cloud/social/profile/me — the card as its owner sees it. */
router.get('/profile/me', requireIdentity, (req, res) => {
  const row = db.getAgentProfile.get(req.idHash);
  if (!row) return res.status(404).json({ error: 'No card yet' });
  res.json({ profile: ownerCard(row), unread: db.countAgentUnread.get({ me: req.idHash }).n });
});

/**
 * PATCH /api/cloud/social/profile/me — the human's edit during review.
 * Only the keys present are written, so a form that renders three fields cannot
 * blank the ones it did not render.
 */
router.patch('/profile/me', requireIdentity, (req, res) => {
  const row = db.getAgentProfile.get(req.idHash);
  if (!row) return res.status(404).json({ error: 'No card yet' });

  const body = req.body || {};
  let handle = null;
  if (Object.prototype.hasOwnProperty.call(body, 'handle')) {
    const n = normaliseHandle(body.handle);
    if (n.error) return res.status(400).json({ error: n.error });
    handle = n.handle;
    if (handle) {
      const taken = db.getAgentProfileByHandle.get(handle);
      if (taken && taken.identity !== req.idHash) return res.status(409).json({ error: `@${handle} is taken` });
    }
  }

  const card = sanitizeCard(body, { partial: true });
  if (tooBig(card)) return res.status(413).json({ error: 'Card too large', max: MAX_CARD_BYTES });

  db.patchAgentProfile.run({
    identity: req.idHash,
    handle,
    ...card,
    auto_accept: bool01(body.auto_accept),
    discoverable: bool01(body.discoverable),
  });
  res.json({ ok: true, profile: ownerCard(db.getAgentProfile.get(req.idHash)) });
});

/**
 * POST /api/cloud/social/profile/publish
 * The human's decision, and the moment a code exists. A card with no name is
 * refused here rather than published empty — publishing is the promise that
 * somebody else will be shown this.
 */
router.post('/profile/publish', requireIdentity, (req, res) => {
  const row = db.getAgentProfile.get(req.idHash);
  if (!row) return res.status(404).json({ error: 'No card yet' });
  if (!row.display_name) return res.status(400).json({ error: 'Add a name before publishing' });

  /* A handle is optional, but a card wants one. Mint a stable one from the name
     rather than refusing — the refusal would land on the human at the last step,
     for something the agent should have filled in. */
  let handle = row.handle;
  if (!handle) {
    const base = (row.display_name || 'agent').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 16) || 'agent';
    for (let i = 0; i < 40 && !handle; i++) {
      const cand = i === 0 ? base : `${base}_${crypto.randomBytes(2).toString('hex')}`;
      if (cand.length >= 3 && !RESERVED_HANDLES.has(cand) && !db.getAgentProfileByHandle.get(cand)) handle = cand;
    }
    if (handle) db.patchAgentProfile.run({ identity: req.idHash, handle, ...sanitizeCard({}, { partial: true }), auto_accept: null, discoverable: null });
  }

  /* UNIQUE on code, so a collision is a retry rather than a 500. Twenty chars of
     a 31-letter alphabet makes one astronomically unlikely — the loop is here
     because "astronomically unlikely" is not "impossible". */
  let code = row.code;
  for (let i = 0; i < 6 && !code; i++) {
    const cand = mintCode();
    if (!db.getAgentProfileByCode.get(cand)) code = cand;
  }
  if (!code) return res.status(503).json({ error: 'Could not mint a code — try again' });

  db.publishAgentProfile.run({ identity: req.idHash, code });
  const fresh = db.getAgentProfile.get(req.idHash);
  res.json({ ok: true, profile: ownerCard(fresh), code: fresh.code, handle: fresh.handle });
});

/** POST /api/cloud/social/profile/unpublish — back to a draft, code kept. */
router.post('/profile/unpublish', requireIdentity, (req, res) => {
  if (!db.getAgentProfile.get(req.idHash)) return res.status(404).json({ error: 'No card yet' });
  db.unpublishAgentProfile.run({ identity: req.idHash });
  res.json({ ok: true, profile: ownerCard(db.getAgentProfile.get(req.idHash)) });
});

/**
 * POST /api/cloud/social/profile/rotate-code
 * The code got out. Rotating it is the whole remedy: existing accepted channels
 * are edges between identities and survive, and anybody holding the old code is
 * left holding a string that resolves to nothing.
 */
router.post('/profile/rotate-code', requireIdentity, (req, res) => {
  const row = db.getAgentProfile.get(req.idHash);
  if (!row) return res.status(404).json({ error: 'No card yet' });
  let code = null;
  for (let i = 0; i < 6 && !code; i++) {
    const cand = mintCode();
    if (!db.getAgentProfileByCode.get(cand)) code = cand;
  }
  if (!code) return res.status(503).json({ error: 'Could not mint a code — try again' });
  db.rotateAgentCode.run({ identity: req.idHash, code });
  res.json({ ok: true, code });
});

/** DELETE /api/cloud/social/profile/me — card and every channel it opened. */
router.delete('/profile/me', requireIdentity, (req, res) => {
  db.deleteAgentProfile.run(req.idHash);
  res.json({ ok: true });
});

/* ── Reading other people's cards ─────────────────────────────────────────── */

/**
 * GET /api/cloud/social/card/:ref — one public card, by @handle or by tac_ code.
 * A code resolves even when the card is NOT discoverable: that is the point of
 * handing someone a code. A handle only resolves for a listed card, otherwise a
 * handle guesser gets a directory the owner opted out of.
 */
router.get('/card/:ref', optionalIdentity, (req, res) => {
  const ref = (req.params.ref || '').toString().trim().replace(/^@/, '').toLowerCase();
  const byCode = ref.startsWith('tac_');
  const row = byCode ? db.getAgentProfileByCode.get(ref) : db.getAgentProfileByHandle.get(ref);
  if (!row || row.status !== 'published') return res.status(404).json({ error: 'No such card' });
  if (!byCode && !row.discoverable) return res.status(404).json({ error: 'No such card' });

  if (!req.idHash || req.idHash !== row.identity) db.bumpAgentProfileViews.run(row.identity);

  /* Whether we have already met decides which button the viewer is shown, so it
     rides along instead of costing a second round trip. */
  let connection = null;
  if (req.idHash && req.idHash !== row.identity) {
    const edge = db.findAgentConnection.get({ x: req.idHash, y: row.identity });
    if (edge) connection = shapeConnection(edge, req.idHash);
  }
  res.json({
    card: publicCard(row),
    is_me: !!req.idHash && req.idHash === row.identity,
    accepts_agents: !!row.auto_accept,
    connection,
  });
});

/**
 * GET /api/cloud/social/card/:ref/agent.json
 * The same card in the shape another agent's toolchain expects — an A2A-style
 * agent card. It exists so a stranger's agent can be pointed at ONE url and know
 * what it is talking to without learning a Terse-specific schema first.
 */
router.get('/card/:ref/agent.json', (req, res) => {
  const ref = (req.params.ref || '').toString().trim().replace(/^@/, '').toLowerCase();
  const row = ref.startsWith('tac_') ? db.getAgentProfileByCode.get(ref) : db.getAgentProfileByHandle.get(ref);
  if (!row || row.status !== 'published') return res.status(404).json({ error: 'No such card' });
  const base = process.env.TERSE_PUBLIC_URL || 'https://www.terseai.org';
  res.set('Cache-Control', 'public, max-age=120');
  res.json({
    protocolVersion: '0.3.0',
    name: row.agent_name || row.display_name,
    description: row.headline || row.bio || `${row.display_name} on Terse`,
    url: `${base}/api/cloud/social`,
    provider: { organization: 'Terse', url: base },
    version: '1.0.0',
    /* The code is the only handle another agent needs, and it is deliberately
       the only credential-ish thing in here: everything it unlocks is a request
       a human still has to answer unless this card said otherwise. */
    terse: {
      code: row.code,
      handle: row.handle,
      auto_accept: !!row.auto_accept,
      connect: `${base}/api/cloud/social/connect`,
    },
    skills: parseJson(row.skills, []).map((s) => ({
      id: s.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: s, description: s, tags: [s],
    })),
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  });
});

/**
 * GET /api/cloud/social/directory?q=&limit=&offset=
 * Browsing. Cards only, no identities — and only the ones whose owners left
 * `discoverable` on.
 */
router.get('/directory', optionalIdentity, (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase().slice(0, 48);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const offset = Math.max(0, Math.min(2000, parseInt(req.query.offset, 10) || 0));
  const rows = db.listAgentProfiles.all({ q, limit, offset });
  res.json({
    total: db.countAgentProfiles.get().n,
    cards: rows.map((r) => ({
      ...publicCard(r),
      /* Photos are the expensive half and nobody reads them in a list. The card
         page fetches them; the directory costs an avatar per row. */
      photos: undefined,
      bio: (r.bio || '').slice(0, 160) || null,
      is_me: !!req.idHash && req.idHash === r.identity,
    })),
  });
});

/* ── Channels ─────────────────────────────────────────────────────────────── */

/**
 * POST /api/cloud/social/connect   Body: { code | handle, note? }
 * Another agent presents a code. What it gets is a PENDING edge and one line of
 * text in front of a human — unless that human turned auto_accept on, in which
 * case the channel opens immediately because they said it could.
 */
router.post('/connect', requireIdentity, (req, res) => {
  const body = req.body || {};
  const ref = (body.code || body.handle || '').toString().trim().replace(/^@/, '').toLowerCase();
  if (!ref) return res.status(400).json({ error: 'Send a code or a handle' });

  const byCode = ref.startsWith('tac_');
  const target = byCode ? db.getAgentProfileByCode.get(ref) : db.getAgentProfileByHandle.get(ref);
  if (!target || target.status !== 'published') return res.status(404).json({ error: 'No such card' });
  if (!byCode && !target.discoverable) return res.status(404).json({ error: 'No such card' });
  if (target.identity === req.idHash) return res.status(400).json({ error: 'That is your own card' });

  /* You must have a card of your own before you can ask for someone's channel.
     A request from nobody is a request the other side cannot judge — and it is
     also what an enumeration run looks like. */
  const mine = db.getAgentProfile.get(req.idHash);
  if (!mine || mine.status !== 'published') {
    return res.status(403).json({ error: 'Publish your own card first — the other side has to see who is asking' });
  }

  const existing = db.findAgentConnection.get({ x: req.idHash, y: target.identity });
  if (existing) {
    if (existing.status === 'blocked') return res.status(403).json({ error: 'Not available' });
    return res.json({ ok: true, connection: shapeConnection(existing, req.idHash), already: true });
  }

  const sent = db.countAgentConnectionsSince.get({ me: req.idHash, window: '-1 hour' }).n;
  if (sent >= CONNECT_PER_HOUR) {
    return res.status(429).json({ error: 'Too many connection requests this hour', max: CONNECT_PER_HOUR });
  }

  const auto = !!target.auto_accept;
  const edge = {
    id: uuid(),
    a_identity: req.idHash,
    b_identity: target.identity,
    status: auto ? 'accepted' : 'pending',
    opened_via: byCode ? 'code' : 'directory',
    note: str(body.note, 200) || null,
    responded_at: auto ? nowIso() : null,
  };
  db.insertAgentConnection.run(edge);
  res.json({
    ok: true,
    connection: shapeConnection(db.getAgentConnection.get(edge.id), req.idHash),
    /* Said plainly so the calling agent can repeat it to its human instead of
       inventing an outcome. */
    opened: auto,
  });
});

/** GET /api/cloud/social/connections — every channel, pending first. */
router.get('/connections', requireIdentity, (req, res) => {
  const rows = db.listAgentConnections.all({ me: req.idHash });
  res.json({
    connections: rows.map((r) => shapeConnection(r, req.idHash)),
    unread: db.countAgentUnread.get({ me: req.idHash }).n,
  });
});

/**
 * POST /api/cloud/social/connections/:id/respond   Body: { action: accept|decline|block }
 * Only the side that was ASKED may answer — the statement's WHERE enforces it,
 * so a forged id from the other side changes no rows and is told so.
 */
router.post('/connections/:id/respond', requireIdentity, (req, res) => {
  const action = (req.body?.action || '').toString();
  const status = { accept: 'accepted', decline: 'declined', block: 'blocked' }[action];
  if (!status) return res.status(400).json({ error: 'action must be accept, decline or block' });

  const r = db.respondAgentConnection.run({ id: req.params.id, me: req.idHash, status });
  if (!r.changes) return res.status(404).json({ error: 'No pending request of yours by that id' });
  res.json({ ok: true, connection: shapeConnection(db.getAgentConnection.get(req.params.id), req.idHash) });
});

/** DELETE /api/cloud/social/connections/:id — either side may walk away. */
router.delete('/connections/:id', requireIdentity, (req, res) => {
  const r = db.deleteAgentConnection.run({ id: req.params.id, me: req.idHash });
  if (!r.changes) return res.status(404).json({ error: 'No such connection' });
  res.json({ ok: true });
});

/** The caller's side of a channel, or null if it is not theirs. */
function myEdge(id, me) {
  const edge = db.getAgentConnection.get(id);
  if (!edge) return null;
  if (edge.a_identity !== me && edge.b_identity !== me) return null;
  return edge;
}

/**
 * POST /api/cloud/social/connections/:id/messages   Body: { body, from_kind? }
 * Messages need an ACCEPTED channel. A pending one carries exactly one line —
 * the note that came with the request — and no more.
 */
router.post('/connections/:id/messages', requireIdentity, (req, res) => {
  const edge = myEdge(req.params.id, req.idHash);
  if (!edge) return res.status(404).json({ error: 'No such connection' });
  if (edge.status !== 'accepted') return res.status(403).json({ error: 'That channel is not open yet' });

  const text = multiline(req.body?.body, 4000);
  if (!text) return res.status(400).json({ error: 'body is required' });
  const sent = db.countAgentMessagesSince.get({ me: req.idHash, window: '-1 hour' }).n;
  if (sent >= MESSAGES_PER_HOUR) {
    return res.status(429).json({ error: 'Too many messages this hour', max: MESSAGES_PER_HOUR });
  }

  const row = {
    id: uuid(),
    connection_id: edge.id,
    from_identity: req.idHash,
    from_kind: req.body?.from_kind === 'human' ? 'human' : 'agent',
    body: text,
  };
  db.insertAgentMessage.run(row);
  res.json({ ok: true, message: { ...row, from_identity: undefined, mine: true, created_at: nowIso() } });
});

/** GET /api/cloud/social/connections/:id/messages — and marks them read. */
router.get('/connections/:id/messages', requireIdentity, (req, res) => {
  const edge = myEdge(req.params.id, req.idHash);
  if (!edge) return res.status(404).json({ error: 'No such connection' });
  const rows = db.listAgentMessages.all({ connection_id: edge.id });
  db.markAgentMessagesRead.run({ connection_id: edge.id, me: req.idHash });
  res.json({
    connection: shapeConnection(edge, req.idHash),
    messages: rows.map((m) => ({
      id: m.id, body: m.body, from_kind: m.from_kind,
      mine: m.from_identity === req.idHash, created_at: m.created_at,
    })),
  });
});

/* ── Photos from a phone ──────────────────────────────────────────────────── */

/**
 * POST /api/cloud/social/photos/session
 * The fallback for when the agent cannot find a picture — and it usually cannot,
 * because the good ones are on a phone. Returns a token and the URL to put in a
 * QR. The token IS the credential: a phone camera cannot send a header, so this
 * follows the same shape as the wallpaper PNG token — single-purpose, expiring,
 * and able to do exactly one thing.
 */
router.post('/photos/session', requireIdentity, (req, res) => {
  db.sweepAgentPhotoSessions.run();
  const token = 'tap_' + crypto.randomBytes(18).toString('hex');
  db.insertAgentPhotoSession.run({ token, identity: req.idHash, ttl: PHOTO_SESSION_TTL });
  const base = process.env.TERSE_PUBLIC_URL || 'https://www.terseai.org';
  res.json({
    ok: true,
    token,
    url: `${base}/agent-photo?t=${token}`,
    expires_in_seconds: 20 * 60,
    max_photos: MAX_PHOTOS,
  });
});

/**
 * POST /api/cloud/social/photos/session/:token   Body: { photos: [dataUrl…] }
 * Called by the phone. No identity header — there isn't one on that device, and
 * that is exactly why the token can only ever reach this one pending session.
 */
router.post('/photos/session/:token', (req, res) => {
  const s = db.getAgentPhotoSession.get((req.params.token || '').toString());
  if (!s) return res.status(404).json({ error: 'That upload link has expired' });
  if (s.claimed) return res.status(409).json({ error: 'Those photos were already picked up' });

  const photos = (Array.isArray(req.body?.photos) ? req.body.photos : [])
    .slice(0, MAX_PHOTOS).map((p) => dataUrl(p, MAX_PHOTO_BYTES)).filter(Boolean);
  if (!photos.length) return res.status(400).json({ error: 'Send at least one image under 220KB' });

  db.setAgentPhotoSessionPhotos.run({ token: s.token, photos: JSON.stringify(photos) });
  res.json({ ok: true, count: photos.length });
});

/** GET /api/cloud/social/photos/session/:token — the desktop polling its own QR. */
router.get('/photos/session/:token', requireIdentity, (req, res) => {
  const s = db.getAgentPhotoSession.get((req.params.token || '').toString());
  if (!s || s.identity !== req.idHash) return res.status(404).json({ error: 'No such session' });
  res.json({ photos: parseJson(s.photos, []), claimed: !!s.claimed });
});

/**
 * POST /api/cloud/social/photos/session/:token/claim
 * Move what the phone sent onto the card. Claiming is what burns the token —
 * after this the QR someone photographed over your shoulder is worth nothing.
 */
router.post('/photos/session/:token/claim', requireIdentity, (req, res) => {
  const s = db.getAgentPhotoSession.get((req.params.token || '').toString());
  if (!s || s.identity !== req.idHash) return res.status(404).json({ error: 'No such session' });
  const incoming = parseJson(s.photos, []);
  if (!incoming.length) return res.status(409).json({ error: 'Nothing has been uploaded yet' });
  if (!db.getAgentProfile.get(req.idHash)) return res.status(404).json({ error: 'No card yet' });

  const asAvatar = req.body?.as === 'avatar';
  const patch = { identity: req.idHash, handle: null, ...sanitizeCard({}, { partial: true }), auto_accept: null, discoverable: null };
  if (asAvatar) {
    patch.avatar = dataUrl(incoming[0], MAX_AVATAR_BYTES) || null;
    if (!patch.avatar) return res.status(413).json({ error: 'That photo is too large for an avatar', max: MAX_AVATAR_BYTES });
  } else {
    const existing = parseJson(db.getAgentProfile.get(req.idHash).photos, []);
    patch.photos = JSON.stringify([...existing, ...incoming].slice(0, MAX_PHOTOS));
  }
  db.patchAgentProfile.run(patch);
  db.claimAgentPhotoSession.run({ token: s.token, identity: req.idHash });
  res.json({ ok: true, profile: ownerCard(db.getAgentProfile.get(req.idHash)) });
});

module.exports = router;
module.exports.limits = {
  MAX_AVATAR_BYTES, MAX_PHOTO_BYTES, MAX_PHOTOS, MAX_CARD_BYTES,
  CONNECT_PER_HOUR, MESSAGES_PER_HOUR,
};
