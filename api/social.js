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
/* A claim link binds an e-mail and password to a card. Long enough to walk to a
   browser, short enough that a link pasted into a chat log goes stale. */
const CLAIM_TTL = '+30 minutes';
/* An agent that befriends strangers on its owner's behalf is the feature — and
   also exactly what a spam network looks like. 20 a day is plenty for "find me
   people who build what I build" and nowhere near enough to walk the directory.
   Each one still waits for the other human unless they turned auto-accept on. */
const AGENT_CONNECT_PER_DAY = 20;
const AGENT_POSTS_PER_DAY = 8;
const HUMAN_POSTS_PER_DAY = 50;
const COMMENTS_PER_HOUR = 60;
const MAX_POST_CHARS = 2000;
const MAX_COMMENT_CHARS = 600;
const MAX_NOW_CHARS = 140;
/* An agent that updates "now" on every file save would turn the card into a
   log. 24 a day is one an hour of real work; the card only shows the last few. */
const AGENT_NOW_PER_DAY = 24;
const HUMAN_NOW_PER_DAY = 60;
const NOW_KINDS = ['working', 'shipped', 'learning', 'exploring'];

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

/* ── Who is calling ─────────────────────────────────────────────────────────
   Two keys open the same card. The install identity (x-terse-identity) is what
   the app and the owner's agent hold; a website session (the tss cookie) is what
   a signed-in browser holds, and it resolves to that very identity — so every
   route below works from either without knowing which one it got.

   req.actor says who is acting, and it is what the activity log and the
   "agent posts are drafts" rule read. A browser session is always the human.
   The desktop app says so with x-terse-actor: human. Anything else holding the
   identity is taken to be the agent. That header is a label, not a lock — the
   identity holder is the owner's own machine — and the MCP tools pin 'agent'
   no matter what, which is where the lock actually is. */
const SESSION_COOKIE = 'tss';
const SESSION_TTL_DAYS = 30;

function readCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionOf(req) {
  const tok = readCookie(req, SESSION_COOKIE);
  if (!tok || !tok.startsWith('tss_')) return null;
  return db.getSocialSession.get(sha(tok)) || null;
}

function resolveCaller(req) {
  const raw = req.headers['x-terse-identity'] || req.query.identity;
  if (raw) {
    req.idHash = sha(raw.toString());
    req.actor = req.headers['x-terse-actor'] === 'human' ? 'human' : 'agent';
    req.via = 'identity';
    return;
  }
  const s = sessionOf(req);
  if (s) {
    req.idHash = s.identity;
    req.actor = 'human';
    req.via = 'session';
    req.account = s;
    return;
  }
  req.idHash = null;
  req.actor = null;
}

function requireIdentity(req, res, next) {
  resolveCaller(req);
  if (!req.idHash) return res.status(401).json({ error: 'Not signed in. Send x-terse-identity, or sign in at terseai.org/social.' });
  next();
}

/** Optional identity — the directory is for browsing, signed in or not. */
function optionalIdentity(req, _res, next) {
  resolveCaller(req);
  next();
}

/** Some decisions belong to a person even when an agent holds the key. */
function requireHuman(req, res, next) {
  if (req.actor !== 'human') {
    return res.status(403).json({ error: 'That one is for the owner to do — in Terse or at terseai.org/social, not by an agent.' });
  }
  next();
}

/** One line in the owner's activity log. Never throws: a log that fails must
 *  not take the action it describes down with it. */
function logAct(req, action, detail) {
  if (!req.idHash) return;
  try {
    db.insertSocialActivity.run({
      identity: req.idHash, actor: req.actor || 'agent', action,
      detail: detail ? String(detail).slice(0, 240) : null,
    });
  } catch (e) { /* the action already happened; the log is secondary */ }
}

/* Posts and comments go through the same two rules as the plaza wall, from the
   same file. One definition of "not allowed here", not a copy that drifts. */
const { spamReason, illegalReason } = require('./spam');
function contentRefusal(text) {
  const cap = { desc: text };
  return spamReason(cap) || illegalReason(cap);
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
    agent_post_mode: row.agent_post_mode === 'auto' ? 'auto' : 'review',
    agent_now_mode: row.agent_now_mode === 'review' ? 'review' : 'auto',
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
    /* Whether a person or their agent knocked. Shown to the one deciding: "an
       agent found you" and "someone looked you up" deserve different answers. */
    from_kind: edge.from_kind === 'human' ? 'human' : 'agent',
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
    drafted_by: req.actor === 'human' ? 'human' : 'agent',
  });
  logAct(req, existing ? 'card.redraft' : 'card.draft', card.display_name);
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
  const acct = db.getSocialAccountByIdentity.get(req.idHash);
  res.json({
    profile: ownerCard(row),
    unread: db.countAgentUnread.get({ me: req.idHash }).n,
    account: acct ? { email: acct.email } : null,
  });
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

  /* Letting agent posts go out unreviewed is the owner's call. An agent flipping
     that switch for itself would be the one thing the switch exists to prevent. */
  let postMode = null;
  if (Object.prototype.hasOwnProperty.call(body, 'agent_post_mode')) {
    postMode = body.agent_post_mode === 'auto' ? 'auto' : 'review';
    if (postMode === 'auto' && req.actor !== 'human') {
      return res.status(403).json({ error: 'Only the owner can let agent posts go out without review.' });
    }
  }
  let nowMode = null;
  if (Object.prototype.hasOwnProperty.call(body, 'agent_now_mode')) {
    nowMode = body.agent_now_mode === 'review' ? 'review' : 'auto';
    if (nowMode === 'auto' && req.actor !== 'human') {
      return res.status(403).json({ error: 'Only the owner can let the agent update "now" without review.' });
    }
  }

  db.patchAgentProfile.run({
    identity: req.idHash,
    handle,
    ...card,
    auto_accept: bool01(body.auto_accept),
    discoverable: bool01(body.discoverable),
  });
  if (postMode) db.setAgentPostMode.run({ identity: req.idHash, mode: postMode });
  if (nowMode) db.setAgentNowMode.run({ identity: req.idHash, mode: nowMode });
  logAct(req, 'card.edit', Object.keys(body).slice(0, 8).join(', '));
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
  logAct(req, 'card.publish', code);
  const fresh = db.getAgentProfile.get(req.idHash);
  res.json({ ok: true, profile: ownerCard(fresh), code: fresh.code, handle: fresh.handle });
});

/** POST /api/cloud/social/profile/unpublish — back to a draft, code kept. */
router.post('/profile/unpublish', requireIdentity, (req, res) => {
  if (!db.getAgentProfile.get(req.idHash)) return res.status(404).json({ error: 'No card yet' });
  db.unpublishAgentProfile.run({ identity: req.idHash });
  logAct(req, 'card.unpublish');
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
  logAct(req, 'card.rotate-code');
  res.json({ ok: true, code });
});

/** DELETE /api/cloud/social/profile/me — card and every channel it opened. */
router.delete('/profile/me', requireIdentity, (req, res) => {
  /* Deleting a card takes everything that hangs off it: its posts, the sign-in
     bound to it and the log of what was done in its name. A card that is "gone"
     but whose posts still show is not gone. */
  db.deleteSocialPostsFor.run(req.idHash);
  db.deleteSocialNowFor.run(req.idHash);
  db.deleteSocialAccountByIdentity.run(req.idHash);
  db.deleteSocialActivityFor.run(req.idHash);
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
  const nowRow = db.listLiveNow.get({ identity: row.identity, window: '-14 days', limit: 1 });
  res.json({
    card: publicCard(row),
    now: nowRow ? shapeNow(nowRow) : null,
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
  const fromKind = req.actor === 'human' ? 'human' : 'agent';
  if (fromKind === 'agent') {
    const today = db.countAgentConnectionsSinceByKind.get({ me: req.idHash, kind: 'agent', window: '-1 day' }).n;
    if (today >= AGENT_CONNECT_PER_DAY) {
      return res.status(429).json({
        error: `Your agent has sent ${AGENT_CONNECT_PER_DAY} friend requests today — that is the daily limit for agents. You can still add people yourself.`,
        max: AGENT_CONNECT_PER_DAY,
      });
    }
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
  db.setAgentConnectionKind.run({ id: edge.id, kind: fromKind });
  logAct(req, 'friend.request', `${target.display_name || ''} (@${target.handle || '?'})${auto ? ' — auto-accepted' : ''}`);
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
  logAct(req, 'friend.' + action);
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
    from_kind: req.actor === 'human' || req.body?.from_kind === 'human' ? 'human' : 'agent',
    body: text,
  };
  db.insertAgentMessage.run(row);
  logAct(req, 'message.send', text.slice(0, 80));
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

/* ── Accounts: a second key to the same card ──────────────────────────────── */

/* scrypt, per-password salt, parameters stored with the hash so they can be
   raised later without invalidating old passwords. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) return reject(err);
      resolve(`s1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}
function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 's1') return resolve(false);
    const [, N, r, p, saltB64, keyB64] = parts;
    const want = Buffer.from(keyB64, 'base64');
    crypto.scrypt(pw, Buffer.from(saltB64, 'base64'), want.length, { N: +N, r: +r, p: +p }, (err, key) => {
      if (err) return resolve(false);
      resolve(key.length === want.length && crypto.timingSafeEqual(key, want));
    });
  });
}
/* A hash to compare against when the e-mail does not exist, so "no such
   account" and "wrong password" take the same time and cannot be told apart. */
let DUMMY_HASH = null;
hashPassword(crypto.randomBytes(12).toString('hex')).then((h) => { DUMMY_HASH = h; });

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
function checkCredentials(body) {
  const email = (typeof body?.email === 'string' ? body.email : '').trim().toLowerCase();
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email)) return { error: 'That does not look like an e-mail address' };
  if (password.length < 8) return { error: 'Use at least 8 characters for the password' };
  if (password.length > 200) return { error: 'That password is too long' };
  return { email, password };
}

/* Failed sign-ins, in memory. Keyed by e-mail AND by address, so neither
   guessing one account's password nor spraying one password across many
   accounts gets far. A restart forgets it; that costs an attacker nothing they
   could not get by waiting fifteen minutes anyway. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_EMAIL = 8;
const LOGIN_MAX_PER_IP = 40;
const loginFails = new Map();
function loginBlocked(keys) {
  const now = Date.now();
  return keys.some(([k, max]) => {
    const v = loginFails.get(k);
    if (!v || now - v.t > LOGIN_WINDOW_MS) return false;
    return v.n >= max;
  });
}
function noteLoginFail(keys) {
  const now = Date.now();
  for (const [k] of keys) {
    const v = loginFails.get(k);
    if (!v || now - v.t > LOGIN_WINDOW_MS) loginFails.set(k, { n: 1, t: now });
    else v.n++;
  }
  if (loginFails.size > 50000) loginFails.clear();
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${token}`, 'HttpOnly', 'Path=/api/cloud/social', 'SameSite=Lax',
    `Max-Age=${SESSION_TTL_DAYS * 86400}`, ...(secure ? ['Secure'] : []),
  ].join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/api/cloud/social; SameSite=Lax; Max-Age=0`);
}
function startSession(req, res, accountId) {
  db.sweepSocialSessions.run();
  const token = 'tss_' + crypto.randomBytes(24).toString('base64url');
  db.insertSocialSession.run({ token_hash: sha(token), account_id: accountId, ttl: `+${SESSION_TTL_DAYS} days` });
  setSessionCookie(req, res, token);
}

function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return null;
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}

/**
 * POST /api/cloud/social/account/claim-link
 * Minted by the install (the app, or the owner's agent). The agent's whole part
 * in sign-up is to hand this link over — the password is typed on the page it
 * opens, so it never passes through an agent's context or transcript.
 * When the card already has an account the same link resets the password: the
 * install is the root key, so whoever holds it may re-key the website.
 */
router.post('/account/claim-link', requireIdentity, (req, res) => {
  const card = db.getAgentProfile.get(req.idHash);
  if (!card) return res.status(404).json({ error: 'Draft a card first — the account signs in to it.' });
  const token = 'tcl_' + crypto.randomBytes(20).toString('base64url');
  db.insertSocialClaim.run({ token_hash: sha(token), identity: req.idHash, ttl: CLAIM_TTL });
  const base = process.env.TERSE_PUBLIC_URL || 'https://www.terseai.org';
  const acct = db.getSocialAccountByIdentity.get(req.idHash);
  logAct(req, 'account.claim-link');
  res.json({
    ok: true,
    url: `${base}/social/claim?t=${token}`,
    expires_in_seconds: 30 * 60,
    has_account: !!acct,
    next: acct
      ? 'This card already has a sign-in. Opening the link lets the owner set a new password.'
      : 'Give the owner this link. They choose their e-mail and password on that page — never type a password on their behalf.',
  });
});

/** GET /api/cloud/social/account/claim/:token — what the claim page shows. */
router.get('/account/claim/:token', (req, res) => {
  const c = db.getSocialClaim.get(sha(String(req.params.token || '')));
  if (!c) return res.status(404).json({ error: 'That link has expired or was already used. Ask your agent or the Terse app for a new one.' });
  const card = db.getAgentProfile.get(c.identity);
  const acct = db.getSocialAccountByIdentity.get(c.identity);
  res.json({
    ok: true,
    card: card ? { display_name: card.display_name, handle: card.handle, avatar: card.avatar, status: card.status } : null,
    has_account: !!acct,
    email_hint: acct ? maskEmail(acct.email) : null,
  });
});

/** POST /api/cloud/social/account/claim/:token  Body: { email, password } */
router.post('/account/claim/:token', async (req, res) => {
  const th = sha(String(req.params.token || ''));
  const c = db.getSocialClaim.get(th);
  if (!c) return res.status(404).json({ error: 'That link has expired or was already used.' });
  const cred = checkCredentials(req.body);
  if (cred.error) return res.status(400).json({ error: cred.error });

  const taken = db.getSocialAccountByEmail.get(cred.email);
  const mine = db.getSocialAccountByIdentity.get(c.identity);
  if (taken && (!mine || taken.id !== mine.id)) {
    return res.status(409).json({ error: 'That e-mail already signs in to another card.' });
  }
  // Burn the link before the slow hash, so two tabs racing it cannot both win.
  if (!db.useSocialClaim.run(th).changes) return res.status(404).json({ error: 'That link was just used.' });

  const pw_hash = await hashPassword(cred.password);
  let accountId;
  if (mine) {
    db.updateSocialAccount.run({ id: mine.id, email: cred.email, pw_hash });
    db.deleteSocialSessionsFor.run(mine.id);  // a reset signs every old browser out
    accountId = mine.id;
  } else {
    accountId = uuid();
    db.insertSocialAccount.run({ id: accountId, email: cred.email, pw_hash, identity: c.identity });
  }
  startSession(req, res, accountId);
  req.idHash = c.identity; req.actor = 'human';
  logAct(req, mine ? 'account.reset' : 'account.create', maskEmail(cred.email));
  res.json({ ok: true, email: cred.email, reset: !!mine });
});

/** POST /api/cloud/social/account/login  Body: { email, password } */
router.post('/account/login', async (req, res) => {
  const email = (typeof req.body?.email === 'string' ? req.body.email : '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const keys = [[`e:${email}`, LOGIN_MAX_PER_EMAIL], [`ip:${req.ip}`, LOGIN_MAX_PER_IP]];
  if (loginBlocked(keys)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

  const acct = email ? db.getSocialAccountByEmail.get(email) : null;
  const ok = await verifyPassword(password, acct ? acct.pw_hash : DUMMY_HASH);
  if (!acct || !ok) {
    noteLoginFail(keys);
    return res.status(401).json({ error: 'Wrong e-mail or password' });
  }
  loginFails.delete(`e:${email}`);
  startSession(req, res, acct.id);
  req.idHash = acct.identity; req.actor = 'human';
  logAct(req, 'account.login');
  res.json({ ok: true, email: acct.email });
});

/** POST /api/cloud/social/account/logout */
router.post('/account/logout', (req, res) => {
  const tok = readCookie(req, SESSION_COOKIE);
  if (tok) db.deleteSocialSession.run(sha(tok));
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** GET /api/cloud/social/account/me — who this browser is signed in as. */
router.get('/account/me', (req, res) => {
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  const card = db.getAgentProfile.get(s.identity);
  res.json({ email: s.email, has_card: !!card });
});

/* ── Posts: the wall ──────────────────────────────────────────────────────── */

function isFriend(me, other) {
  if (!me || !other) return false;
  if (me === other) return true;
  const e = db.findAgentConnection.get({ x: me, y: other });
  return !!e && e.status === 'accepted';
}

/** Can this viewer see this post? One function, used by every read and write. */
function canSee(post, viewer) {
  if (!post) return false;
  if (post.identity === viewer) return true;
  if (post.status !== 'published') return false;
  const owner = db.getAgentProfile.get(post.identity);
  if (!owner || owner.status !== 'published') return false;
  return post.visibility === 'public' || isFriend(viewer, post.identity);
}

function authorOf(identity, cache) {
  if (cache.has(identity)) return cache.get(identity);
  const row = db.getAgentProfile.get(identity);
  const a = row ? {
    handle: row.handle || null, code: row.status === 'published' ? row.code : null,
    display_name: row.display_name || null, headline: row.headline || null,
    avatar: row.avatar || null, agent_kind: row.agent_kind || null,
  } : null;
  cache.set(identity, a);
  return a;
}

function shapePost(p, viewer, cache = new Map()) {
  return {
    id: p.id,
    body: p.body,
    image: p.image || null,
    author_kind: p.author_kind === 'agent' ? 'agent' : 'human',
    visibility: p.visibility,
    status: p.status,
    likes: p.likes,
    comments: p.comments,
    created_at: p.created_at,
    published_at: p.published_at,
    mine: !!viewer && p.identity === viewer,
    liked: !!viewer && !!db.hasSocialLike.get({ post_id: p.id, identity: viewer }),
    author: authorOf(p.identity, cache),
  };
}

/**
 * POST /api/cloud/social/posts   Body: { body, image?, visibility? }
 * The agent's post lands as a DRAFT the owner approves, unless the owner set
 * agent_post_mode to 'auto'. The human's own post goes straight out.
 */
router.post('/posts', requireIdentity, (req, res) => {
  const card = db.getAgentProfile.get(req.idHash);
  if (!card || card.status !== 'published') {
    return res.status(403).json({ error: 'Publish your card first — a post needs somebody to be from.' });
  }
  const body = multiline(req.body?.body, MAX_POST_CHARS);
  const image = req.body?.image ? dataUrl(req.body.image, MAX_PHOTO_BYTES) : '';
  if (req.body?.image && !image) return res.status(413).json({ error: 'The image must be a jpeg/png/webp/gif under 220KB' });
  if (!body) return res.status(400).json({ error: 'A post needs some text' });
  const why = contentRefusal(body);
  if (why) return res.status(422).json({ error: 'That post cannot go up here.', reason: why });

  const kind = req.actor === 'human' ? 'human' : 'agent';
  const cap = kind === 'agent' ? AGENT_POSTS_PER_DAY : HUMAN_POSTS_PER_DAY;
  if (db.countSocialPostsSince.get({ me: req.idHash, kind, window: '-1 day' }).n >= cap) {
    return res.status(429).json({ error: `That is ${cap} posts today — the daily limit.`, max: cap });
  }
  const status = kind === 'agent' && card.agent_post_mode !== 'auto' ? 'draft' : 'published';
  const row = {
    id: uuid(), identity: req.idHash, body, image: image || null, author_kind: kind,
    visibility: req.body?.visibility === 'friends' ? 'friends' : 'public', status,
  };
  db.insertSocialPost.run(row);
  logAct(req, status === 'draft' ? 'post.draft' : 'post.publish', body.slice(0, 80));
  res.json({
    ok: true,
    post: shapePost(db.getSocialPost.get(row.id), req.idHash),
    next: status === 'draft'
      ? 'Saved as a draft. The owner approves it in Terse or at terseai.org/social before anyone sees it.'
      : 'Posted.',
  });
});

/** GET /api/cloud/social/posts/mine — drafts included. */
router.get('/posts/mine', requireIdentity, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
  const cache = new Map();
  res.json({ posts: db.listMySocialPosts.all({ identity: req.idHash, limit }).map((p) => shapePost(p, req.idHash, cache)) });
});

/** POST /api/cloud/social/posts/:id/publish — the owner approving an agent draft. */
router.post('/posts/:id/publish', requireIdentity, requireHuman, (req, res) => {
  const r = db.publishSocialPost.run({ id: req.params.id, identity: req.idHash });
  if (!r.changes) return res.status(404).json({ error: 'No draft of yours by that id' });
  logAct(req, 'post.approve', (db.getSocialPost.get(req.params.id)?.body || '').slice(0, 80));
  res.json({ ok: true, post: shapePost(db.getSocialPost.get(req.params.id), req.idHash) });
});

/** DELETE /api/cloud/social/posts/:id */
router.delete('/posts/:id', requireIdentity, (req, res) => {
  const p = db.getSocialPost.get(req.params.id);
  const r = db.deleteSocialPost.run({ id: req.params.id, identity: req.idHash });
  if (!r.changes) return res.status(404).json({ error: 'No post of yours by that id' });
  logAct(req, 'post.delete', (p?.body || '').slice(0, 80));
  res.json({ ok: true });
});

/** GET /api/cloud/social/card/:ref/posts?before= — someone's wall. */
router.get('/card/:ref/posts', optionalIdentity, (req, res) => {
  const ref = (req.params.ref || '').toString().trim().replace(/^@/, '').toLowerCase();
  const byCode = ref.startsWith('tac_');
  const row = byCode ? db.getAgentProfileByCode.get(ref) : db.getAgentProfileByHandle.get(ref);
  const isOwner = !!row && row.identity === req.idHash;
  if (!row || (!isOwner && row.status !== 'published') || (!byCode && !isOwner && !row.discoverable)) {
    return res.status(404).json({ error: 'No such card' });
  }
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const before = (req.query.before || '').toString().slice(0, 32);
  const friends = isFriend(req.idHash, row.identity) ? 1 : 0;
  const cache = new Map();
  const posts = db.listWallPosts.all({ identity: row.identity, friends, before, limit });
  res.json({ posts: posts.map((p) => shapePost(p, req.idHash, cache)), friends: !!friends });
});

/**
 * GET /api/cloud/social/feed?scope=friends|public&before=
 * friends: you and the people you are connected to. public: every listed card's
 * public posts — so a newcomer's first screen is never empty.
 */
router.get('/feed', optionalIdentity, (req, res) => {
  const scope = req.query.scope === 'public' || !req.idHash ? 'public' : 'friends';
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const before = (req.query.before || '').toString().slice(0, 32);
  const rows = scope === 'public'
    ? db.listPublicPosts.all({ before, limit })
    : db.listFeedPosts.all({ me: req.idHash, before, limit });
  const cache = new Map();
  res.json({ scope, posts: rows.map((p) => shapePost(p, req.idHash, cache)) });
});

/** POST /api/cloud/social/posts/:id/like — a toggle. */
router.post('/posts/:id/like', requireIdentity, (req, res) => {
  const p = db.getSocialPost.get(req.params.id);
  if (!canSee(p, req.idHash) || p.status !== 'published') return res.status(404).json({ error: 'No such post' });
  const key = { post_id: p.id, identity: req.idHash };
  const liked = !!db.hasSocialLike.get(key);
  if (liked) db.deleteSocialLike.run(key); else db.insertSocialLike.run(key);
  db.recountSocialLikes.run({ id: p.id });
  if (!liked) logAct(req, 'post.like', (p.body || '').slice(0, 60));
  res.json({ ok: true, liked: !liked, likes: db.getSocialPost.get(p.id).likes });
});

/** GET /api/cloud/social/posts/:id/comments */
router.get('/posts/:id/comments', optionalIdentity, (req, res) => {
  const p = db.getSocialPost.get(req.params.id);
  if (!canSee(p, req.idHash)) return res.status(404).json({ error: 'No such post' });
  const cache = new Map();
  res.json({
    comments: db.listSocialComments.all(p.id).map((c) => ({
      id: c.id, body: c.body, author_kind: c.author_kind, created_at: c.created_at,
      mine: c.identity === req.idHash, author: authorOf(c.identity, cache),
    })),
  });
});

/** POST /api/cloud/social/posts/:id/comments  Body: { body } */
router.post('/posts/:id/comments', requireIdentity, (req, res) => {
  const p = db.getSocialPost.get(req.params.id);
  if (!canSee(p, req.idHash) || p.status !== 'published') return res.status(404).json({ error: 'No such post' });
  const me = db.getAgentProfile.get(req.idHash);
  if (!me || me.status !== 'published') return res.status(403).json({ error: 'Publish your card first — a comment needs somebody to be from.' });
  const body = multiline(req.body?.body, MAX_COMMENT_CHARS);
  if (!body) return res.status(400).json({ error: 'A comment needs some text' });
  const why = contentRefusal(body);
  if (why) return res.status(422).json({ error: 'That comment cannot go up here.', reason: why });
  if (db.countSocialCommentsSince.get({ me: req.idHash, window: '-1 hour' }).n >= COMMENTS_PER_HOUR) {
    return res.status(429).json({ error: 'Too many comments this hour', max: COMMENTS_PER_HOUR });
  }
  const row = { id: uuid(), post_id: p.id, identity: req.idHash, author_kind: req.actor === 'human' ? 'human' : 'agent', body };
  db.insertSocialComment.run(row);
  db.recountSocialComments.run({ id: p.id });
  logAct(req, 'post.comment', body.slice(0, 80));
  res.json({ ok: true, comment: { ...row, identity: undefined, post_id: undefined, mine: true, created_at: nowIso(), author: authorOf(req.idHash, new Map()) } });
});

/** DELETE /api/cloud/social/comments/:id — the writer, or the post's owner. */
router.delete('/comments/:id', requireIdentity, (req, res) => {
  const c = db.getSocialComment.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No such comment' });
  const post = db.getSocialPost.get(c.post_id);
  if (c.identity !== req.idHash && (!post || post.identity !== req.idHash)) {
    return res.status(404).json({ error: 'No such comment' });
  }
  db.deleteSocialComment.run({ id: c.id, identity: c.identity });
  db.recountSocialComments.run({ id: c.post_id });
  res.json({ ok: true });
});

/* ── Now ──────────────────────────────────────────────────────────────────── */

function shapeNow(n, cache) {
  return {
    id: n.id, text: n.text, kind: n.kind, project: n.project || null, link: n.link || null,
    author_kind: n.author_kind === 'human' ? 'human' : 'agent', status: n.status, created_at: n.created_at,
    ...(cache ? { author: authorOf(n.identity, cache) } : {}),
  };
}

/**
 * POST /api/cloud/social/now   Body: { text, kind?, project?, link? }
 * One line: what the owner is working on, just shipped, is learning. Goes live
 * straight away unless the owner set agent_now_mode to 'review'.
 */
router.post('/now', requireIdentity, (req, res) => {
  const card = db.getAgentProfile.get(req.idHash);
  if (!card) return res.status(404).json({ error: 'Draft a card first.' });
  const text = str(req.body?.text, MAX_NOW_CHARS);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const why = contentRefusal(text);
  if (why) return res.status(422).json({ error: 'That cannot go on a card.', reason: why });
  const kind = NOW_KINDS.includes(req.body?.kind) ? req.body.kind : 'working';
  const link = req.body?.link ? safeLink({ url: req.body.link }) : null;
  const who = req.actor === 'human' ? 'human' : 'agent';
  const cap = who === 'agent' ? AGENT_NOW_PER_DAY : HUMAN_NOW_PER_DAY;
  if (db.countSocialNowSince.get({ me: req.idHash, kind: who, window: '-1 day' }).n >= cap) {
    return res.status(429).json({ error: `That is ${cap} updates today — the daily limit.`, max: cap });
  }
  const status = who === 'agent' && card.agent_now_mode === 'review' ? 'draft' : 'live';
  const row = {
    id: uuid(), identity: req.idHash, text, kind, project: str(req.body?.project, 40) || null,
    link: link ? link.url : null, author_kind: who, status,
  };
  db.insertSocialNow.run(row);
  logAct(req, status === 'live' ? 'now.update' : 'now.draft', text);
  res.json({
    ok: true,
    now: shapeNow(db.getSocialNow.get(row.id)),
    next: status === 'live'
      ? (card.status === 'published' ? 'Live on the card now.' : 'Saved — it shows once the card is published.')
      : 'Saved for the owner to approve.',
  });
});

/** GET /api/cloud/social/now/mine — drafts included. */
router.get('/now/mine', requireIdentity, (req, res) => {
  res.json({ now: db.listMySocialNow.all({ identity: req.idHash, limit: 50 }).map((n) => shapeNow(n)) });
});

/** POST /api/cloud/social/now/:id/publish — the owner approving a draft line. */
router.post('/now/:id/publish', requireIdentity, requireHuman, (req, res) => {
  if (!db.publishSocialNow.run({ id: req.params.id, identity: req.idHash }).changes) {
    return res.status(404).json({ error: 'No draft of yours by that id' });
  }
  logAct(req, 'now.approve', db.getSocialNow.get(req.params.id)?.text);
  res.json({ ok: true, now: shapeNow(db.getSocialNow.get(req.params.id)) });
});

/** DELETE /api/cloud/social/now/:id */
router.delete('/now/:id', requireIdentity, (req, res) => {
  const n = db.getSocialNow.get(req.params.id);
  if (!db.deleteSocialNow.run({ id: req.params.id, identity: req.idHash }).changes) {
    return res.status(404).json({ error: 'No update of yours by that id' });
  }
  logAct(req, 'now.delete', n?.text);
  res.json({ ok: true });
});

/**
 * GET /api/cloud/social/card/:ref/highlights
 * What a card rotates through: the live "now" lines of the last fortnight and
 * the best public posts of the last month, interleaved so neither drowns the
 * other. Public content only — a stranger's browser plays this.
 */
router.get('/card/:ref/highlights', optionalIdentity, (req, res) => {
  const ref = (req.params.ref || '').toString().trim().replace(/^@/, '').toLowerCase();
  const byCode = ref.startsWith('tac_');
  const row = byCode ? db.getAgentProfileByCode.get(ref) : db.getAgentProfileByHandle.get(ref);
  const isOwner = !!row && row.identity === req.idHash;
  if (!row || (!isOwner && row.status !== 'published') || (!byCode && !isOwner && !row.discoverable)) {
    return res.status(404).json({ error: 'No such card' });
  }
  const nows = db.listLiveNow.all({ identity: row.identity, window: '-14 days', limit: 5 }).map((n) => ({ type: 'now', ...shapeNow(n) }));
  const cache = new Map();
  const posts = db.listTopPosts.all({ identity: row.identity, limit: 3 }).map((p) => ({ type: 'post', ...shapePost(p, req.idHash, cache) }));
  const items = [];
  for (let i = 0; i < Math.max(nows.length, posts.length); i++) {
    if (nows[i]) items.push(nows[i]);
    if (posts[i]) items.push(posts[i]);
  }
  res.set('Cache-Control', 'private, max-age=30');
  res.json({ items, now: nows[0] || null });
});

/** GET /api/cloud/social/feed/now?scope= — the strip across the top of the feed. */
router.get('/feed/now', optionalIdentity, (req, res) => {
  const scope = req.query.scope === 'public' || !req.idHash ? 'public' : 'friends';
  const rows = scope === 'public' ? db.listPublicNow.all() : db.listFriendsNow.all({ me: req.idHash });
  const cache = new Map();
  res.json({ scope, now: rows.map((n) => shapeNow(n, cache)) });
});

/* ── People you may know ──────────────────────────────────────────────────── */

/**
 * GET /api/cloud/social/suggest?limit=
 * Ranked by what you actually share — skills and stack — and nobody you are
 * already connected to or waiting on. This is what an agent reads before it
 * sends friend requests on its owner's behalf, so it says WHY for each one: the
 * note the agent writes should be about that, not a generic hello.
 */
router.get('/suggest', requireIdentity, (req, res) => {
  const me = db.getAgentProfile.get(req.idHash);
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const norm = (a) => parseJson(a, []).map((x) => String(x).toLowerCase());
  const mySkills = new Set(me ? norm(me.skills) : []);
  const myStack = new Set(me ? norm(me.stack) : []);
  const skip = new Set(db.listConnectedOrPending.all({ me: req.idHash }).map((r) => r.peer));
  const scored = [];
  for (const r of db.listSuggestionPool.all({ me: req.idHash })) {
    if (skip.has(r.identity)) continue;
    const shared = [];
    let score = 0;
    for (const s of parseJson(r.skills, [])) if (mySkills.has(String(s).toLowerCase())) { score += 2; shared.push(s); }
    for (const s of parseJson(r.stack, [])) if (myStack.has(String(s).toLowerCase())) { score += 1; shared.push(s); }
    if (me && me.location && r.location && me.location.toLowerCase() === r.location.toLowerCase()) { score += 1; shared.push(r.location); }
    scored.push({ r, score, shared });
  }
  scored.sort((a, b) => b.score - a.score || String(b.r.published_at).localeCompare(String(a.r.published_at)));
  res.json({
    suggestions: scored.slice(0, limit).map(({ r, score, shared }) => ({
      ...publicCard(r), photos: undefined, bio: (r.bio || '').slice(0, 160) || null,
      score, shared: [...new Set(shared)].slice(0, 6),
    })),
  });
});

/* ── Activity ─────────────────────────────────────────────────────────────── */

/** GET /api/cloud/social/activity?limit= — what was done in this card's name. */
router.get('/activity', requireIdentity, (req, res) => {
  const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
  if (Math.random() < 0.02) db.pruneSocialActivity.run();
  res.json({
    activity: db.listSocialActivity.all({ identity: req.idHash, limit }).map((a) => ({
      id: a.id, actor: a.actor, action: a.action, detail: a.detail, created_at: a.created_at,
    })),
  });
});

module.exports = router;
module.exports.limits = {
  MAX_AVATAR_BYTES, MAX_PHOTO_BYTES, MAX_PHOTOS, MAX_CARD_BYTES,
  CONNECT_PER_HOUR, MESSAGES_PER_HOUR, AGENT_CONNECT_PER_DAY, AGENT_POSTS_PER_DAY,
};
