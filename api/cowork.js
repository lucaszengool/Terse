/**
 * Terse Cowork — collaborative multi-agent office.
 *
 * Team members' coding agents publish their live working state + logs here; every
 * teammate (and every teammate's agent, via the MCP server in mcp.js) can read them
 * in real time. Visibility is open-office: any team member sees all sessions.
 *
 * Auth: a team token (x-terse-team-token, used by desktop clients / agents / API) OR
 * a Clerk session JWT for a member (used by the browser dashboard). Both are accepted
 * by requireTeamAccess; publish/presence are token-only.
 *
 * Mounted at /api/cloud (shares the prefix with cloud.js; paths are distinct).
 */
const express = require('express');
const crypto = require('crypto');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

const CLERK_JWKS = createRemoteJWKSet(new URL('https://clerk.terseai.org/.well-known/jwks.json'));
const CLERK_ISSUER = 'https://clerk.terseai.org';

function uuid() { return crypto.randomUUID(); }
function hashToken(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function clip(s, n) { return typeof s === 'string' ? s.slice(0, n) : s; }
function lc(s) { return (s || '').toString().toLowerCase() || null; }
function intval(v) { return Math.max(0, parseInt(v ?? 0, 10) || 0); }

function teamFromToken(raw) {
  if (!raw) return null;
  const team = db.findTeamByToken.get(hashToken(raw));
  if (team) db.touchTeamToken.run(hashToken(raw));
  return team || null;
}

// ── Auth: team token only (publish / presence) ──
function requireTeamToken(req, res, next) {
  const raw = req.headers['x-terse-team-token'] || (req.query.token);
  const team = teamFromToken(raw);
  if (!team) return res.status(401).json({ error: 'Missing or invalid team token' });
  req.team = team;
  next();
}

// ── Auth: team token OR Clerk member (read / messages). Team id from :id param. ──
async function requireTeamAccess(req, res, next) {
  const teamId = req.params.id;
  const team = db.getTeamById.get(teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // 1) Team token (header or ?token= for EventSource which can't set headers)
  const raw = req.headers['x-terse-team-token'] || req.query.token;
  if (raw) {
    const t = db.findTeamByToken.get(hashToken(raw));
    if (t && t.id === team.id) {
      db.touchTeamToken.run(hashToken(raw));
      req.team = team;
      return next();
    }
  }

  // 2) Clerk session JWT → must be owner or member of this team
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(authHeader.slice(7), CLERK_JWKS, { issuer: CLERK_ISSUER });
      const clerkUserId = payload.sub;
      const email = lc(req.query.email || payload.email);
      const isOwner = clerkUserId === team.owner_user_id;
      let member = null;
      if (!isOwner) {
        const members = db.getTeamMembers.all(team.id);
        member = members.find(m => m.user_id === clerkUserId)
          || (email && members.find(m => m.user_email === email));
        if (!member) return res.status(403).json({ error: 'Not a member of this team' });
      }
      req.team = team;
      req.clerkUserId = clerkUserId;
      req.userEmail = isOwner ? lc(payload.email || email) : member.user_email;
      return next();
    } catch { /* fall through */ }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

// ════════════════════════════════════════
//  PUBLISH — agent sessions + working logs
// ════════════════════════════════════════

// POST /api/cloud/agent-sessions  (team token)
// Body: { session: {...}, log?: [{ role, kind, tool, text, tokens, seq? }] }
router.post('/agent-sessions', requireTeamToken, (req, res) => {
  const team = req.team;
  const s = req.body?.session || {};
  const userEmail = lc(s.user_email || s.userEmail);
  const device = clip(s.device || 'mac', 16);
  const agentType = clip(s.agent_type || s.agentType || 'agent', 40);
  const project = clip(s.project || '', 200) || '';

  // Find/derive a stable session id for this (team,member,device,agent,project).
  const existing = db.getCoworkSessionByKey.get(team.id, userEmail, device, agentType, project);
  const id = existing?.id || uuid();
  let seq = existing?.seq || 0;

  const session = {
    id,
    team_id: team.id,
    user_email: userEmail,
    device,
    agent_type: agentType,
    agent_name: clip(s.agent_name || s.agentName || agentType, 60),
    project,
    model: clip(s.model || '', 80),
    status: ['active', 'idle', 'ended'].includes(s.status) ? s.status : 'active',
    task: clip(s.task || '', 280),
    context_window: intval(s.context_window ?? s.contextWindow),
    context_used: intval(s.context_used ?? s.contextUsed),
    tokens_in: intval(s.tokens_in ?? s.tokensIn),
    tokens_out: intval(s.tokens_out ?? s.tokensOut),
    tokens_saved: intval(s.tokens_saved ?? s.tokensSaved),
    tool_calls: intval(s.tool_calls ?? s.toolCalls),
    turns: intval(s.turns),
    seq,
  };

  const entries = Array.isArray(req.body?.log) ? req.body.log : [];
  const emittedLog = [];
  try {
    // Upsert the session first so log rows satisfy the foreign key.
    db.upsertCoworkSession.run(session);
    for (const e of entries) {
      seq += 1;
      const row = {
        id: uuid(),
        session_id: id,
        team_id: team.id,
        seq,
        role: clip(e.role || 'assistant', 16),
        kind: clip(e.kind || 'message', 24),
        tool: clip(e.tool || null, 60),
        text: clip(e.text || '', 2048),
        tokens: intval(e.tokens),
      };
      db.addCoworkLog.run(row);
      emittedLog.push(row);
    }
    if (entries.length) db.bumpCoworkSessionSeq.run(seq, id);
  } catch (err) {
    console.error('[cowork] publish error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const stored = db.getCoworkSession.get(id);
  bus.emit(team.id, { type: 'session', session: stored });
  for (const row of emittedLog) bus.emit(team.id, { type: 'log', entry: row });

  // Touch presence for the publishing member.
  if (userEmail) {
    db.upsertCoworkPresence.run({ team_id: team.id, user_email: userEmail, status: 'online', device });
    bus.emit(team.id, { type: 'presence', presence: { user_email: userEmail, status: 'online', device } });
  }

  res.json({ ok: true, session_id: id, seq });
});

// ════════════════════════════════════════
//  READ — sessions, logs, feed
// ════════════════════════════════════════

// GET /api/cloud/teams/:id/agent-sessions
router.get('/teams/:id/agent-sessions', requireTeamAccess, (req, res) => {
  const sessions = db.getCoworkSessions.all(req.team.id);
  const presence = db.getCoworkPresence.all(req.team.id);
  res.json({ sessions, presence });
});

// GET /api/cloud/teams/:id/sessions/:sid/log?since=<seq>
router.get('/teams/:id/sessions/:sid/log', requireTeamAccess, (req, res) => {
  const session = db.getCoworkSession.get(req.params.sid);
  if (!session || session.team_id !== req.team.id) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const since = intval(req.query.since);
  const entries = db.getCoworkLog.all(req.params.sid, since);
  res.json({ session, entries });
});

// GET /api/cloud/teams/:id/feed?since=<iso>
router.get('/teams/:id/feed', requireTeamAccess, (req, res) => {
  const since = req.query.since || '1970-01-01';
  const log = db.getCoworkFeed.all(req.team.id, since);
  const messages = db.getCoworkMessages.all(req.team.id, since);
  res.json({ log, messages });
});

// GET /api/cloud/teams/:id/inbox?email=<me>
router.get('/teams/:id/inbox', requireTeamAccess, (req, res) => {
  const email = lc(req.query.email || req.userEmail);
  if (!email) return res.json({ inbox: [] });
  res.json({ inbox: db.getCoworkInbox.all(req.team.id, email) });
});

// ════════════════════════════════════════
//  STREAM — Server-Sent Events
// ════════════════════════════════════════

// GET /api/cloud/teams/:id/stream?token=<tct_…>   (or Clerk auth)
router.get('/teams/:id/stream', requireTeamAccess, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Initial snapshot so a fresh client renders immediately.
  res.write(`data: ${JSON.stringify({
    type: 'snapshot',
    sessions: db.getCoworkSessions.all(req.team.id),
    presence: db.getCoworkPresence.all(req.team.id),
  })}\n\n`);

  const unsubscribe = bus.subscribe(req.team.id, res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ════════════════════════════════════════
//  MESSAGES — chat / @mention / handoff
// ════════════════════════════════════════

// POST /api/cloud/teams/:id/messages
// Body: { from_email?, to_email?, kind?, body, session_id? }
router.post('/teams/:id/messages', requireTeamAccess, (req, res) => {
  const b = req.body || {};
  const body = clip((b.body || '').toString().trim(), 4000);
  if (!body) return res.status(400).json({ error: 'Missing body' });
  const msg = {
    id: uuid(),
    team_id: req.team.id,
    from_email: lc(b.from_email || req.userEmail),
    to_email: lc(b.to_email),
    session_id: b.session_id || null,
    kind: ['chat', 'mention', 'handoff', 'ask'].includes(b.kind) ? b.kind : 'chat',
    body,
    status: 'open',
  };
  db.addCoworkMessage.run(msg);
  const stored = db.getCoworkMessage.get(msg.id);
  bus.emit(req.team.id, { type: 'message', message: stored });
  res.json({ ok: true, message: stored });
});

// POST /api/cloud/teams/:id/messages/:mid/resolve  Body: { status?: 'ack'|'done' }
router.post('/teams/:id/messages/:mid/resolve', requireTeamAccess, (req, res) => {
  const status = ['ack', 'done'].includes(req.body?.status) ? req.body.status : 'done';
  db.resolveCoworkMessage.run(status, req.params.mid, req.team.id);
  const stored = db.getCoworkMessage.get(req.params.mid);
  if (stored) bus.emit(req.team.id, { type: 'message', message: stored });
  res.json({ ok: true, message: stored });
});

// ════════════════════════════════════════
//  PRESENCE — heartbeat
// ════════════════════════════════════════

// POST /api/cloud/presence  (team token)  Body: { user_email, status?, device? }
router.post('/presence', requireTeamToken, (req, res) => {
  const userEmail = lc(req.body?.user_email || req.body?.userEmail);
  if (!userEmail) return res.status(400).json({ error: 'Missing user_email' });
  const status = ['online', 'away', 'offline'].includes(req.body?.status) ? req.body.status : 'online';
  const device = clip(req.body?.device || 'mac', 16);
  db.upsertCoworkPresence.run({ team_id: req.team.id, user_email: userEmail, status, device });
  bus.emit(req.team.id, { type: 'presence', presence: { user_email: userEmail, status, device } });
  res.json({ ok: true });
});

// ── Stale sweep (called on an interval from server.js) ──
// Transitions sessions active→idle (90s) and →ended (5m), and presence
// online→away (2m) and →offline (10m), broadcasting each change over SSE so
// live dashboards update without waiting for a reconnect.
function sweepStale() {
  try {
    // Sessions: mark freshly-idle and broadcast.
    for (const s of db.getFreshlyIdleSessions.all('-90 seconds')) {
      bus.emit(s.team_id, { type: 'session', session: { ...s, status: 'idle' } });
    }
    db.idleStaleCoworkSessions.run('-90 seconds');

    // Sessions: end the long-silent ones and broadcast removal.
    const ending = db.getStaleActiveSessions.all('-5 minutes');
    db.endStaleCoworkSessions.run('-5 minutes');
    for (const s of ending) {
      bus.emit(s.team_id, { type: 'session', session: { ...s, status: 'ended' } });
    }

    // Presence: online→away, away→offline.
    for (const p of db.getStalePresence.all('online', '-2 minutes')) {
      db.setPresenceStatus.run('away', p.team_id, p.user_email);
      bus.emit(p.team_id, { type: 'presence', presence: { ...p, status: 'away' } });
    }
    for (const p of db.getStalePresence.all('away', '-10 minutes')) {
      db.setPresenceStatus.run('offline', p.team_id, p.user_email);
      bus.emit(p.team_id, { type: 'presence', presence: { ...p, status: 'offline' } });
    }
  } catch (e) {
    console.error('[cowork] sweep error:', e.message);
  }
}

module.exports = router;
module.exports.sweepStale = sweepStale;
