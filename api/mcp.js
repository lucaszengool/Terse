/**
 * Terse MCP server — lets a coding agent (Claude Code, Cursor, …) read its
 * teammates' live agent logs and coordinate, directly as MCP tools.
 *
 * Streamable-HTTP MCP: a single POST endpoint speaking JSON-RPC 2.0. Hand-written
 * (no MCP SDK dependency) to match this repo's "no extra deps" convention — see
 * terse-api.js. Auth is a team token (x-terse-team-token, or Authorization: Bearer
 * tct_…). The caller's own email may be supplied via x-terse-user-email so inbox /
 * outgoing messages are attributed; otherwise messages are team broadcasts.
 *
 * Mounted at /api/cloud/mcp. Add to a client, e.g. .mcp.json:
 *   { "mcpServers": { "terse": {
 *       "type": "http",
 *       "url": "https://www.terseai.org/api/cloud/mcp",
 *       "headers": { "x-terse-team-token": "tct_…", "x-terse-user-email": "you@co.com" }
 *   } } }
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

const PROTOCOL_VERSION = '2025-06-18';
function hashToken(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function lc(s) { return (s || '').toString().toLowerCase() || null; }

// ── Tool definitions ──
const TOOLS = [
  {
    name: 'terse_list_teammates',
    description: "List the team's members, their presence (online/away/offline) and which coding agents they're currently running.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_list_sessions',
    description: 'List all active coding-agent sessions across the team — who, which agent, project, model, current task, context-window fill, and token usage. Use this to see what teammates and their agents are working on right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_read_log',
    description: "Read a teammate's agent working log (messages, tool calls, results) for a given session id. Use terse_list_sessions first to get a session_id. Pass `since` (a seq number) to page forward.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id from terse_list_sessions.' },
        since: { type: 'number', description: 'Return only log entries with seq greater than this (default 0).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'terse_team_feed',
    description: 'Recent cross-team activity — the latest working-log entries and messages from everyone on the team.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'ISO timestamp; only return activity after this.' } },
    },
  },
  {
    name: 'terse_post_message',
    description: 'Post a message to the team: a chat note, an @mention to a specific teammate, a "handoff" of work, or an "ask". Reaches teammates live in the Terse app and their agents via terse_inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The message text.' },
        to: { type: 'string', description: "A teammate's email to address it to. Omit to broadcast to the whole team." },
        kind: { type: 'string', enum: ['chat', 'mention', 'handoff', 'ask'], description: 'Message type (default chat).' },
        session_id: { type: 'string', description: 'Optionally attach to an agent session for context.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'terse_inbox',
    description: 'Messages addressed to you (and team broadcasts) that are still open — @mentions, handoffs and asks from teammates.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool implementations (scoped to req.team / req.userEmail) ──
function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

const HANDLERS = {
  terse_list_teammates(team) {
    const presence = db.getCoworkPresence.all(team.id);
    const sessions = db.getCoworkSessions.all(team.id);
    const members = db.getTeamMembers.all(team.id).map(m => {
      const p = presence.find(x => x.user_email === m.user_email);
      const agents = sessions.filter(s => s.user_email === m.user_email)
        .map(s => ({ agent: s.agent_name, project: s.project, status: s.status }));
      return { email: m.user_email, role: m.role, presence: p?.status || 'offline', agents };
    });
    return textResult({ members });
  },
  terse_list_sessions(team) {
    const sessions = db.getCoworkSessions.all(team.id).map(s => ({
      session_id: s.id,
      developer: s.user_email,
      agent: s.agent_name,
      agent_type: s.agent_type,
      project: s.project,
      model: s.model,
      status: s.status,
      task: s.task,
      context_fill: s.context_window ? Math.round((s.context_used / s.context_window) * 100) + '%' : null,
      tokens_in: s.tokens_in,
      tokens_out: s.tokens_out,
      tool_calls: s.tool_calls,
      last_seen_at: s.last_seen_at,
    }));
    return textResult({ sessions });
  },
  terse_read_log(team, _email, args) {
    const session = db.getCoworkSession.get(args.session_id);
    if (!session || session.team_id !== team.id) return textResult({ error: 'Session not found in your team.' });
    const entries = db.getCoworkLog.all(args.session_id, Math.max(0, parseInt(args.since, 10) || 0));
    return textResult({
      session: { developer: session.user_email, agent: session.agent_name, project: session.project, task: session.task },
      entries: entries.map(e => ({ seq: e.seq, role: e.role, kind: e.kind, tool: e.tool, text: e.text, at: e.occurred_at })),
    });
  },
  terse_team_feed(team, _email, args) {
    const since = args.since || '1970-01-01';
    return textResult({
      log: db.getCoworkFeed.all(team.id, since),
      messages: db.getCoworkMessages.all(team.id, since),
    });
  },
  terse_post_message(team, email, args) {
    const body = (args.body || '').toString().trim().slice(0, 4000);
    if (!body) return textResult({ error: 'body is required.' });
    const msg = {
      id: crypto.randomUUID(),
      team_id: team.id,
      from_email: email,
      to_email: lc(args.to),
      session_id: args.session_id || null,
      kind: ['chat', 'mention', 'handoff', 'ask'].includes(args.kind) ? args.kind : 'chat',
      body,
      status: 'open',
    };
    db.addCoworkMessage.run(msg);
    const stored = db.getCoworkMessage.get(msg.id);
    bus.emit(team.id, { type: 'message', message: stored });
    return textResult({ ok: true, message_id: msg.id });
  },
  terse_inbox(team, email) {
    if (!email) return textResult({ error: 'Set the x-terse-user-email header to read your inbox.', inbox: [] });
    return textResult({ inbox: db.getCoworkInbox.all(team.id, email) });
  },
};

// ── JSON-RPC dispatch ──
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function handleRpc(msg, team, userEmail) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'terse-cowork', version: '1.0.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no response
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        return rpcResult(id, handler(team, userEmail, params?.arguments || {}));
      } catch (err) {
        return rpcResult(id, { ...textResult({ error: err.message }), isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

router.post('/', express.json({ limit: '256kb' }), (req, res) => {
  const raw = req.headers['x-terse-team-token']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!raw) return res.status(401).json({ error: 'Missing team token (x-terse-team-token).' });
  const team = db.findTeamByToken.get(hashToken(raw));
  if (!team) return res.status(401).json({ error: 'Invalid team token.' });
  db.touchTeamToken.run(hashToken(raw));
  const userEmail = lc(req.headers['x-terse-user-email']);

  const body = req.body;
  // Support JSON-RPC batches and single messages.
  if (Array.isArray(body)) {
    const out = body.map(m => handleRpc(m, team, userEmail)).filter(Boolean);
    return res.json(out);
  }
  const result = handleRpc(body, team, userEmail);
  if (result === null) return res.status(202).end(); // notification
  res.json(result);
});

// A GET on the same path is sometimes probed by clients opening an SSE channel.
router.get('/', (req, res) => res.status(405).json({ error: 'Use POST for JSON-RPC.' }));

module.exports = router;
