/**
 * Terse Docs — Google-style collaborative documents (REST + SSE).
 *
 * A doc is a standalone, shareable file (document | sheet | slides) that humans
 * AND multiple people's agents co-edit live. The server holds the authoritative
 * JSON snapshot (doc-model.js); every edit is an op applied in arrival order and
 * fanned out over SSE (cowork-bus, keyed by "doc:<id>"). Agents reach the same
 * ops via the MCP server (mcp.js). True .docx/.xlsx/.pptx export via ooxml.js.
 *
 * Auth, per request:
 *   • Clerk session JWT (Authorization: Bearer …) → identifies the signed-in user
 *     (owner / invited collaborator). Required to create & list docs.
 *   • Per-doc share token (?t=<tok> or x-terse-doc-token) → grants the doc's
 *     share_role (editor|viewer) to anyone with the link, incl. agents.
 *
 * Mounted at /api/docs.
 */
const express = require('express');
const crypto = require('crypto');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const db = require('./db');
const bus = require('./cowork-bus');
const model = require('./doc-model');
const ooxml = require('./ooxml');

const router = express.Router();

const CLERK_JWKS = createRemoteJWKSet(new URL('https://clerk.terseai.org/.well-known/jwks.json'));
const CLERK_ISSUER = 'https://clerk.terseai.org';

const uuid = () => crypto.randomUUID();
const lc = s => (s || '').toString().toLowerCase() || null;
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);
const chan = id => `doc:${id}`;
const KINDS = ['document', 'sheet', 'slides'];

function newShareToken() { return 'dtk_' + crypto.randomBytes(18).toString('hex'); }

async function verifyClerk(req) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  // A doc share token can ride in the Authorization header too (agents/MCP style).
  if (h.slice(7).startsWith('dtk_')) return null;
  try {
    const { payload } = await jwtVerify(h.slice(7), CLERK_JWKS, { issuer: CLERK_ISSUER });
    return { clerkUserId: payload.sub, email: lc(payload.email || req.query.email) };
  } catch { return null; }
}

// Resolve the caller's role on a doc → 'owner' | 'editor' | 'viewer' | null
async function resolveAccess(req, doc) {
  let role = null;
  let identity = { email: null, name: clip(req.query.name, 60) || null, kind: 'human' };

  // 1) Share token (query, header, or Authorization: Bearer dtk_…)
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const tok = req.query.t || req.headers['x-terse-doc-token'] || (bearer?.startsWith('dtk_') ? bearer : null);
  if (tok && doc.share_token && tok === doc.share_token) {
    role = doc.share_role === 'viewer' ? 'viewer' : 'editor';
    if (req.headers['x-terse-doc-token'] || bearer?.startsWith('dtk_')) identity.kind = 'agent';
  }

  // 2) Clerk identity (owner / invited collaborator) — wins if higher
  const clerk = await verifyClerk(req);
  if (clerk) {
    identity.email = clerk.email;
    if (clerk.clerkUserId && clerk.clerkUserId === doc.owner_user_id) role = 'owner';
    else {
      const collab = clerk.email && db.getDocCollaborator.get(doc.id, clerk.email);
      if (collab) role = rankRole(role, collab.role);
    }
  }
  return { role, identity };
}
function rankRole(a, b) {
  const order = { viewer: 1, editor: 2, owner: 3 };
  return (order[b] || 0) > (order[a] || 0) ? b : a;
}
const canEdit = role => role === 'owner' || role === 'editor';

// Middleware: load doc + access. Attaches req.doc / req.role / req.identity.
async function loadDoc(req, res, next) {
  const doc = db.getDoc.get(req.params.id);
  if (!doc || doc.is_trashed) return res.status(404).json({ error: 'Doc not found' });
  const { role, identity } = await resolveAccess(req, doc);
  if (!role) return res.status(403).json({ error: 'No access to this doc' });
  req.doc = doc; req.role = role; req.identity = identity;
  next();
}

// Middleware: require a signed-in Clerk user (create / list).
async function requireUser(req, res, next) {
  const clerk = await verifyClerk(req);
  if (!clerk?.clerkUserId) return res.status(401).json({ error: 'Sign in required' });
  req.clerkUserId = clerk.clerkUserId;
  req.userEmail = clerk.email;
  next();
}

function publicDoc(doc, role) {
  return {
    id: doc.id, kind: doc.kind, title: doc.title,
    content: JSON.parse(doc.content), version: doc.version,
    owner_email: doc.owner_email, share_role: doc.share_role,
    share_token: role === 'owner' ? doc.share_token : undefined,
    agents_paused: !!doc.agents_paused, my_role: role,
    updated_at: doc.updated_at,
  };
}

// ════════════════════════════════════════  CREATE / LIST  ════════════════
router.post('/', requireUser, (req, res) => {
  const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'document';
  const title = clip((req.body?.title || '').trim(), 200) || defaultTitle(kind);
  const doc = {
    id: uuid(), kind, title,
    owner_user_id: req.clerkUserId, owner_email: req.userEmail,
    content: JSON.stringify(model.blankContent(kind)),
    share_token: newShareToken(),
    share_role: req.body?.share_role === 'viewer' ? 'viewer' : 'editor',
  };
  db.createDoc.run(doc);
  res.json({ ok: true, doc: { id: doc.id, kind, title, share_token: doc.share_token } });
});

function defaultTitle(kind) {
  return kind === 'sheet' ? 'Untitled spreadsheet' : kind === 'slides' ? 'Untitled presentation' : 'Untitled document';
}

router.get('/', requireUser, (req, res) => {
  const owned = db.getDocsByOwner.all(req.clerkUserId);
  const shared = req.userEmail ? db.getDocsSharedWith.all(req.userEmail, req.clerkUserId) : [];
  res.json({ owned, shared });
});

// ════════════════════════════════════════  READ ONE  ════════════════════
router.get('/:id', loadDoc, (req, res) => {
  res.json({
    doc: publicDoc(req.doc, req.role),
    collaborators: db.getDocCollaborators.all(req.doc.id),
    presence: db.getDocPresence.all(req.doc.id),
    comments: db.getDocComments.all(req.doc.id),
  });
});

// ════════════════════════════════════════  APPLY OPS  ════════════════════
// Body: { ops: [op,…], actor?, actor_kind?, actor_id? }
router.post('/:id/ops', loadDoc, (req, res) => {
  if (!canEdit(req.role)) return res.status(403).json({ error: 'View-only access' });
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : (req.body?.op ? [req.body.op] : []);
  if (!ops.length) return res.status(400).json({ error: 'No ops' });

  const actorKind = req.body?.actor_kind === 'agent' || req.identity.kind === 'agent' ? 'agent' : 'human';
  const actor = clip(req.body?.actor || req.identity.email || req.identity.name || 'anonymous', 80);

  // An agent that a human has paused (per-agent or globally) may not write.
  if (actorKind === 'agent') {
    if (req.doc.agents_paused) return res.status(423).json({ error: 'paused', message: 'A human paused all agents on this doc.' });
    const ap = req.body?.actor_id && db.getDocPresenceActor.get(req.doc.id, req.body.actor_id);
    if (ap?.paused) return res.status(423).json({ error: 'paused', message: 'A human paused this agent.' });
  }

  let content = JSON.parse(req.doc.content);
  let version = req.doc.version;
  const applied = [];
  for (const op of ops.slice(0, 200)) {
    const r = model.applyOp(content, op, req.doc.kind);
    if (!r.ok) continue;
    content = r.content;
    version += 1;
    // sheet.snapshot payloads are MBs — persist/broadcast only a marker; the
    // snapshot itself lives in doc.content and clients already applied the
    // underlying mutations live.
    const wireOp = op.t === 'sheet.snapshot' ? { t: 'sheet.snapshot' } : op;
    const row = { id: uuid(), doc_id: req.doc.id, version, actor, actor_kind: actorKind, op: JSON.stringify(wireOp) };
    db.addDocOp.run(row);
    applied.push({ version, op: wireOp, actor, actor_kind: actorKind });
  }
  if (!applied.length) return res.json({ ok: true, version, applied: 0 });

  db.updateDocContent.run({ id: req.doc.id, content: JSON.stringify(content), version });
  for (const a of applied) bus.emit(chan(req.doc.id), { type: 'op', ...a });
  res.json({ ok: true, version, applied: applied.length });
});

// Full snapshot (for resync after a version gap)
router.get('/:id/snapshot', loadDoc, (req, res) => {
  res.json({ content: JSON.parse(req.doc.content), version: req.doc.version });
});

// ════════════════════════════════════════  STREAM (SSE)  ═════════════════
router.get('/:id/stream', loadDoc, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({
    type: 'snapshot',
    content: JSON.parse(req.doc.content),
    version: req.doc.version,
    presence: db.getDocPresence.all(req.doc.id),
    agents_paused: !!req.doc.agents_paused,
  })}\n\n`);

  const unsubscribe = bus.subscribe(chan(req.doc.id), res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
});

// ════════════════════════════════════════  PRESENCE  ════════════════════
// Body: { actor_id, name?, kind?, color?, cursor?, status? }
router.post('/:id/presence', loadDoc, (req, res) => {
  const actorId = clip(req.body?.actor_id, 80);
  if (!actorId) return res.status(400).json({ error: 'Missing actor_id' });
  const kind = req.body?.kind === 'agent' || req.identity.kind === 'agent' ? 'agent' : 'human';
  const row = {
    doc_id: req.doc.id, actor_id: actorId,
    name: clip(req.body?.name || req.identity.name || req.identity.email || 'Guest', 60),
    kind, color: clip(req.body?.color || colorFor(actorId), 12),
    cursor: req.body?.cursor ? JSON.stringify(req.body.cursor).slice(0, 400) : null,
    status: ['online', 'away', 'offline'].includes(req.body?.status) ? req.body.status : 'online',
  };
  db.upsertDocPresence.run(row);
  const stored = db.getDocPresenceActor.get(req.doc.id, actorId);
  bus.emit(chan(req.doc.id), { type: 'presence', presence: stored });
  res.json({ ok: true, presence: stored });
});

function colorFor(seed) {
  const colors = ['#4285f4', '#ea4335', '#34a853', '#fbbc04', '#a142f4', '#ff6d01', '#46bdc6', '#7baaf7'];
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

// ════════════════════════════════════════  META: rename / share / invite  ═
router.post('/:id/rename', loadDoc, (req, res) => {
  if (!canEdit(req.role)) return res.status(403).json({ error: 'View-only' });
  const title = clip((req.body?.title || '').trim(), 200);
  if (!title) return res.status(400).json({ error: 'Empty title' });
  db.renameDoc.run(title, req.doc.id);
  bus.emit(chan(req.doc.id), { type: 'meta', title });
  res.json({ ok: true });
});

router.post('/:id/share', loadDoc, (req, res) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change sharing' });
  const role = req.body?.share_role === 'viewer' ? 'viewer' : 'editor';
  db.setDocShareRole.run(role, req.doc.id);
  res.json({ ok: true, share_role: role, share_token: req.doc.share_token });
});

router.post('/:id/invite', loadDoc, (req, res) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can invite' });
  const email = lc(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const role = ['editor', 'viewer'].includes(req.body?.role) ? req.body.role : 'editor';
  db.addDocCollaborator.run({ id: uuid(), doc_id: req.doc.id, email, user_id: null, role, invited_by: req.identity.email });
  bus.emit(chan(req.doc.id), { type: 'collaborators', collaborators: db.getDocCollaborators.all(req.doc.id) });
  res.json({ ok: true, collaborators: db.getDocCollaborators.all(req.doc.id) });
});

router.delete('/:id/collaborators/:email', loadDoc, (req, res) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove people' });
  db.removeDocCollaborator.run(req.doc.id, lc(req.params.email));
  bus.emit(chan(req.doc.id), { type: 'collaborators', collaborators: db.getDocCollaborators.all(req.doc.id) });
  res.json({ ok: true });
});

router.post('/:id/trash', loadDoc, (req, res) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete' });
  db.trashDoc.run(req.doc.id, req.doc.owner_user_id);
  res.json({ ok: true });
});

// ════════════════════════════════════════  AGENT CONTROL  ════════════════
// Body: { actor_id?, paused }  — pause one agent (actor_id) or ALL agents (omit).
router.post('/:id/agents/pause', loadDoc, (req, res) => {
  if (!canEdit(req.role)) return res.status(403).json({ error: 'View-only' });
  const paused = req.body?.paused ? 1 : 0;
  if (req.body?.actor_id) {
    db.setDocPresencePaused.run(paused, req.doc.id, req.body.actor_id);
    bus.emit(chan(req.doc.id), { type: 'agent_control', actor_id: req.body.actor_id, paused: !!paused });
  } else {
    db.setDocAgentsPaused.run(paused, req.doc.id);
    db.setDocAgentsPausedPresence.run(paused, req.doc.id);
    bus.emit(chan(req.doc.id), { type: 'agent_control', all: true, paused: !!paused });
  }
  res.json({ ok: true, paused: !!paused });
});

// ════════════════════════════════════════  COMMENTS  ═════════════════════
router.post('/:id/comments', loadDoc, (req, res) => {
  const body = clip((req.body?.body || '').trim(), 4000);
  if (!body) return res.status(400).json({ error: 'Empty comment' });
  const row = {
    id: uuid(), doc_id: req.doc.id, anchor: clip(req.body?.anchor || '', 120) || null,
    author: clip(req.body?.author || req.identity.email || req.identity.name || 'anonymous', 80),
    author_kind: req.body?.author_kind === 'agent' || req.identity.kind === 'agent' ? 'agent' : 'human',
    body,
  };
  db.addDocComment.run(row);
  bus.emit(chan(req.doc.id), { type: 'comment', comment: { ...row, resolved: 0, created_at: new Date().toISOString() } });
  res.json({ ok: true });
});

router.post('/:id/comments/:cid/resolve', loadDoc, (req, res) => {
  db.resolveDocComment.run(req.params.cid, req.doc.id);
  bus.emit(chan(req.doc.id), { type: 'comment_resolved', id: req.params.cid });
  res.json({ ok: true });
});

// ════════════════════════════════════════  EXPORT (.docx/.xlsx/.pptx)  ═══
router.get('/:id/export', loadDoc, (req, res) => {
  try {
    const doc = { kind: req.doc.kind, title: req.doc.title, content: JSON.parse(req.doc.content) };
    const { buffer, ext, mime } = ooxml.exportDoc(doc);
    const safe = (req.doc.title || 'document').replace(/[^\w.\- ]+/g, '').slice(0, 80) || 'document';
    res.set({
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${safe}.${ext}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (e) {
    console.error('[docs] export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
