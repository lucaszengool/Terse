/**
 * Terse Cloud — team-level token analytics + savings dashboard.
 * Clients (Mac/Windows Tauri, Chrome ext, VS Code ext) POST events
 * authenticated with a team token. Owners view dashboards via /teams/:id.
 */
const express = require('express');
const crypto = require('crypto');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const db = require('./db');

const router = express.Router();

// Clerk JWKS — derived from publishable key (pk_live_Y2xlcmsudGVyc2VhaS5vcmck → clerk.terseai.org)
const CLERK_JWKS = createRemoteJWKSet(new URL('https://clerk.terseai.org/.well-known/jwks.json'));
const CLERK_ISSUER = 'https://clerk.terseai.org';

async function requireClerkAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), CLERK_JWKS, { issuer: CLERK_ISSUER });
    req.auth = { userId: payload.sub };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
}

function uuid() { return crypto.randomUUID(); }
function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'team';
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
function generateTeamToken() {
  return 'tct_' + crypto.randomBytes(24).toString('base64url');
}
function ensureUniqueSlug(base) {
  let slug = base;
  let i = 1;
  while (db.getTeamBySlug.get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function periodStart(period) {
  const days = period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : period === 'year' ? 365 : 30;
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ── Create a team ──
router.post('/teams', requireClerkAuth, (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    const { ownerEmail, name, company } = req.body || {};
    if (!ownerEmail || !name) {
      return res.status(400).json({ error: 'Missing ownerEmail or name' });
    }
    db.ensureUser(clerkUserId, ownerEmail);

    const teamId = uuid();
    const slug = ensureUniqueSlug(slugify(name));
    db.createTeam.run({
      id: teamId,
      name,
      slug,
      owner_user_id: clerkUserId,
      plan: 'team',
      seats: 5,
      company: company || null,
    });

    // Owner is automatically a member with role=owner
    db.addTeamMember.run({
      id: uuid(),
      team_id: teamId,
      user_email: ownerEmail.toLowerCase(),
      user_id: clerkUserId,
      role: 'owner',
    });

    // Mint the first team token
    const raw = generateTeamToken();
    db.addTeamToken.run({
      id: uuid(),
      team_id: teamId,
      token_hash: hashToken(raw),
      label: 'default',
    });

    res.json({
      team: db.getTeamById.get(teamId),
      token: raw, // only returned once on creation
    });
  } catch (err) {
    console.error('[cloud] create team error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── List all teams the user belongs to (owned + member) ──
router.get('/teams', requireClerkAuth, (req, res) => {
  const clerkUserId = req.auth.userId;
  const { email } = req.query; // optional — used to backfill member rows by email

  // Link this clerk ID to any member rows with matching email (lazy back-fill)
  if (email) db.setMemberUserId.run(clerkUserId, email.toLowerCase());

  const owned = db.getTeamsByOwner.all(clerkUserId);
  const memberByUid = db.getTeamsByMemberUserId.all(clerkUserId);
  const memberByEmail = email ? db.getTeamsByMemberEmail.all(email.toLowerCase()) : [];

  // Merge, deduplicate by team id
  const seen = new Set();
  const teams = [];
  for (const t of [...owned, ...memberByUid, ...memberByEmail]) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      teams.push({ ...t, is_owner: t.owner_user_id === clerkUserId });
    }
  }
  res.json({ teams });
});

// ── Get team detail ──
router.get('/teams/:id', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  const { email } = req.query;
  const isOwner = clerkUserId === team.owner_user_id;
  let member = null;
  if (!isOwner && clerkUserId) {
    member = db.getTeamMembers.all(team.id).find(m => m.user_id === clerkUserId);
    if (!member && email) member = db.getTeamMembers.all(team.id).find(m => m.user_email === email.toLowerCase());
    if (!member) return res.status(403).json({ error: 'Not authorized' });
  }
  const members = db.getTeamMembers.all(team.id);
  const tokens = isOwner ? db.getTeamTokens.all(team.id) : [];
  res.json({ team, members, tokens, is_owner: isOwner, role: isOwner ? 'owner' : (member?.role || 'member') });
});

// ── Update team (name / company / seats) — owner only ──
router.patch('/teams/:id', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  const { name, company, seats } = req.body || {};
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });
  db.updateTeam.run({
    id: team.id,
    name: name ?? team.name,
    company: company ?? team.company,
    seats: seats ? Math.max(1, parseInt(seats, 10)) : team.seats,
  });
  res.json({ team: db.getTeamById.get(team.id) });
});

// ── Delete team — owner only ──
router.delete('/teams/:id', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });
  db.deleteTeam.run(team.id, clerkUserId);
  res.json({ ok: true });
});

// ── Add a member to a team (by email) ──
router.post('/teams/:id/members', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  const { email, role } = req.body || {};
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });
  if (!email) return res.status(400).json({ error: 'Missing email' });
  db.addTeamMember.run({
    id: uuid(),
    team_id: team.id,
    user_email: email.toLowerCase(),
    user_id: null,
    role: role || 'member',
  });
  res.json({ members: db.getTeamMembers.all(team.id) });
});

// ── Remove a member ──
router.delete('/teams/:id/members/:memberId', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });
  db.removeTeamMember.run(req.params.memberId, team.id);
  res.json({ members: db.getTeamMembers.all(team.id) });
});

// ── Mint a new team token ──
router.post('/teams/:id/tokens', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  const { label } = req.body || {};
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });
  const raw = generateTeamToken();
  db.addTeamToken.run({
    id: uuid(),
    team_id: team.id,
    token_hash: hashToken(raw),
    label: label || 'token',
  });
  res.json({ token: raw, tokens: db.getTeamTokens.all(team.id) });
});

// ── Revoke a team token ──
router.delete('/teams/:id/tokens/:tokenId', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });
  db.deleteTeamToken.run(req.params.tokenId, team.id);
  res.json({ tokens: db.getTeamTokens.all(team.id) });
});

// ── Telemetry ingest from clients ──
// header: x-terse-team-token: <raw token>
// body:   { user_email, tool, source, project, model, optimization_mode, tokens_in, tokens_out, tokens_saved }
router.post('/events', (req, res) => {
  const raw = req.headers['x-terse-team-token'];
  if (!raw) return res.status(401).json({ error: 'Missing x-terse-team-token' });
  const team = db.findTeamByToken.get(hashToken(raw));
  if (!team) return res.status(401).json({ error: 'Invalid team token' });
  db.touchTeamToken.run(hashToken(raw));

  const evts = Array.isArray(req.body?.events) ? req.body.events : [req.body || {}];
  const inserted = [];
  for (const e of evts) {
    const id = uuid();
    db.addCloudEvent.run({
      id,
      team_id: team.id,
      user_email: (e.user_email || e.userEmail || '').toLowerCase() || null,
      tool: e.tool || null,
      source: e.source || null,
      project: e.project || null,
      model: e.model || null,
      optimization_mode: e.optimization_mode || e.optimizationMode || null,
      tokens_in: Math.max(0, parseInt(e.tokens_in ?? e.tokensIn ?? 0, 10) || 0),
      tokens_out: Math.max(0, parseInt(e.tokens_out ?? e.tokensOut ?? 0, 10) || 0),
      tokens_saved: Math.max(0, parseInt(e.tokens_saved ?? e.tokensSaved ?? 0, 10) || 0),
    });
    inserted.push(id);
  }
  res.json({ ok: true, accepted: inserted.length });
});

// ── Dashboard aggregates ──
// Supports both Clerk session auth (browser) and team token auth (direct API / legacy)
router.get('/teams/:id/stats', async (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const rawToken = req.headers['x-terse-team-token'];
  const authHeader = req.headers.authorization;
  const { email, period } = req.query;

  let clerkUserId = null;
  let authorized = false;

  // Try Clerk JWT first (browser)
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(authHeader.slice(7), CLERK_JWKS, { issuer: CLERK_ISSUER });
      clerkUserId = payload.sub;
      authorized = true;
    } catch { /* fall through to team token */ }
  }

  // Fall back to team token (Tauri/extension/legacy)
  if (!authorized && rawToken && db.findTeamByToken.get(hashToken(rawToken))?.id === team.id) {
    authorized = true;
  }

  if (!authorized) return res.status(401).json({ error: 'Authentication required' });

  const isOwner = clerkUserId === team.owner_user_id;
  let member = null;
  if (clerkUserId && !isOwner) {
    const members = db.getTeamMembers.all(team.id);
    member = members.find(m => m.user_id === clerkUserId);
    if (!member && email) member = members.find(m => m.user_email === email.toLowerCase());
    if (!member) return res.status(403).json({ error: 'Not a member of this team' });
  }

  const start = periodStart(period || 'month');

  // Non-owner members only see their own stats
  if (!isOwner && member) {
    const memberEmail = member.user_email;
    const memberSummary = db.db.prepare(`
      SELECT COUNT(*) as total_events,
        COALESCE(SUM(tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(tokens_out), 0) as total_tokens_out,
        COALESCE(SUM(tokens_saved), 0) as total_tokens_saved,
        1 as active_developers
      FROM cloud_events
      WHERE team_id = ? AND user_email = ? AND occurred_at >= ?
    `).get(team.id, memberEmail, start);
    const memberByTool = db.db.prepare(`
      SELECT tool, COUNT(*) as events, COALESCE(SUM(tokens_in),0) as tokens_in, COALESCE(SUM(tokens_saved),0) as tokens_saved
      FROM cloud_events WHERE team_id = ? AND user_email = ? AND occurred_at >= ?
      GROUP BY tool ORDER BY tokens_saved DESC
    `).all(team.id, memberEmail, start);
    const memberByProject = db.db.prepare(`
      SELECT project, COUNT(*) as events, COALESCE(SUM(tokens_in),0) as tokens_in, COALESCE(SUM(tokens_saved),0) as tokens_saved
      FROM cloud_events WHERE team_id = ? AND user_email = ? AND occurred_at >= ? AND project IS NOT NULL AND project != ''
      GROUP BY project ORDER BY tokens_saved DESC
    `).all(team.id, memberEmail, start);
    const memberDaily = db.db.prepare(`
      SELECT substr(occurred_at,1,10) as date, COUNT(*) as events,
        COALESCE(SUM(tokens_in),0) as tokens_in, COALESCE(SUM(tokens_saved),0) as tokens_saved
      FROM cloud_events WHERE team_id = ? AND user_email = ? AND occurred_at >= ?
      GROUP BY substr(occurred_at,1,10) ORDER BY date ASC
    `).all(team.id, memberEmail, start);
    const dollarsSaved = (memberSummary.total_tokens_saved / 1_000_000) * 3;
    return res.json({
      team: { id: team.id, name: team.name, slug: team.slug, company: team.company, seats: team.seats },
      period: period || 'month',
      role: 'member',
      summary: { ...memberSummary, dollars_saved: Math.round(dollarsSaved * 100) / 100 },
      by_developer: [{ user_email: memberEmail, events: memberSummary.total_events, tokens_in: memberSummary.total_tokens_in, tokens_saved: memberSummary.total_tokens_saved }],
      by_tool: memberByTool,
      by_project: memberByProject,
      daily: memberDaily,
    });
  }

  // Owner / token auth sees full team data
  const summary = db.getTeamSummary.get(team.id, start);
  const byDev = db.getTeamByDeveloper.all(team.id, start);
  const byTool = db.getTeamByTool.all(team.id, start);
  const byProject = db.getTeamByProject.all(team.id, start);
  const byModel = db.getTeamByModel.all(team.id, start);
  const byMode = db.getTeamByMode.all(team.id, start);
  const daily = db.getTeamDaily.all(team.id, start);
  const dollarsSaved = (summary.total_tokens_saved / 1_000_000) * 3;
  const totalMembers = db.getTeamMembers.all(team.id).length;

  res.json({
    team: { id: team.id, name: team.name, slug: team.slug, company: team.company, seats: team.seats },
    period: period || 'month',
    role: 'owner',
    summary: { ...summary, dollars_saved: Math.round(dollarsSaved * 100) / 100, total_members: totalMembers },
    by_developer: byDev,
    by_tool: byTool,
    by_project: byProject,
    by_model: byModel,
    by_mode: byMode,
    daily,
  });
});

// ── Rate-limit alert check (smart notifications) ──
router.get('/teams/:id/alerts', requireClerkAuth, (req, res) => {
  const team = db.getTeamById.get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const clerkUserId = req.auth.userId;
  if (clerkUserId !== team.owner_user_id) return res.status(403).json({ error: 'Not authorized' });

  const start = periodStart('day');
  const byDev = db.getTeamByDeveloper.all(team.id, start);
  // Heuristic: any developer > 2M input tokens/day = "heavy usage"
  const alerts = byDev
    .filter(d => d.tokens_in > 2_000_000)
    .map(d => ({
      type: 'high_usage',
      developer: d.user_email,
      tokens_in_today: d.tokens_in,
      message: `${d.user_email} used ${(d.tokens_in / 1_000_000).toFixed(1)}M input tokens today`,
    }));
  res.json({ alerts });
});

// ── Public token validity check (for clients to confirm setup) ──
router.get('/whoami', (req, res) => {
  const raw = req.headers['x-terse-team-token'];
  if (!raw) return res.status(401).json({ error: 'Missing token' });
  const team = db.findTeamByToken.get(hashToken(raw));
  if (!team) return res.status(401).json({ error: 'Invalid token' });
  res.json({
    team_id: team.id,
    team_slug: team.slug,
    team_name: team.name,
  });
});

module.exports = router;
