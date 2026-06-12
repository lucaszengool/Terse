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
const model = require('./doc-model');

const router = express.Router();

const PROTOCOL_VERSION = '2025-06-18';
function hashToken(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function lc(s) { return (s || '').toString().toLowerCase() || null; }
function docChan(id) { return `doc:${id}`; }

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

// ── Doc tools (available when an x-terse-doc-token is supplied) ──
// These let an agent co-edit a shared Terse Doc/Sheet/Slides live alongside
// humans and other people's agents. Humans can pause this agent from the editor;
// terse_edit_doc then refuses until resumed.
const OP_HELP = [
  'Edit ops by document kind:',
  'document: {"t":"block.set","id":"<blockId>","html":"...","type":"p|h1|h2|h3|title|subtitle|ul|ol|check|quote|code","align":"left|center|right|justify (optional)","indent":0-8,"checked":0|1}',
  '          {"t":"block.insert","after":"<blockId>","blockType":"p","html":"..."}',
  '          {"t":"block.delete","id":"<blockId>"}',
  'sheet:    {"t":"cell.set","r":<row#0based>,"c":<col#0based>,"v":"value","f":"=A1*2 (optional)"}',
  '          {"t":"range.set","r":<topRow>,"c":<leftCol>,"cells":[[{"v":"a"},{"v":"b"}],[{"v":"1"},null]]}  (bulk write; null clears)',
  'slides:   16:9 canvas, 960x540 px. {"t":"slide.add","after":"<slideId>","layout":"title|body|blank"} | {"t":"slide.delete","id":"<slideId>"}',
  '          {"t":"slide.set","id":"<slideId>","bg":"#rrggbb","notes":"speaker notes"}',
  '          {"t":"block.set","slide":"<slideId>","id":"<blockId>","html":"...","type":"title|subtitle|body|bullet|text|shape|image","frame":{"x":50,"y":120,"w":860,"h":380},"style":{"fontSize":18,"color":"#222","bold":true,"align":"center","bg":"#4285f4 (shape fill)"},"shape":"rect|round|ellipse|triangle|diamond|arrow|line","src":"image url or data: URI"}',
  '          {"t":"block.insert","slide":"<slideId>","blockType":"text","html":"...","frame":{...}}',
  'Read the doc first with terse_read_doc to get current block/slide ids.',
].join('\n');

const DOC_TOOLS = [
  {
    name: 'terse_doc_info',
    description: 'Get the shared doc you are connected to: kind (document/sheet/slides), title, version, who is editing live right now (humans + agents, with presence), and whether agents are paused by a human.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_read_doc',
    description: 'Read the full current content of the shared doc as structured text — every block/cell/slide with its id, so you know exactly what to edit. Call this before terse_edit_doc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_edit_doc',
    description: 'Apply one or more edit ops to the shared doc. Changes appear live for every human and agent watching. ' + OP_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', items: { type: 'object' }, description: 'Array of edit ops (see the op reference in this tool description).' },
      },
      required: ['ops'],
    },
  },
  {
    name: 'terse_doc_changes',
    description: 'See what changed in the shared doc since a given version — useful to watch what a human or the other person\'s agent just edited and coordinate with them.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'number', description: 'Return ops with version greater than this (default 0).' } },
    },
  },
  {
    name: 'terse_comment_doc',
    description: 'Post a comment/note on the shared doc — e.g. to draft a plan together with the other agent or leave a note for the humans. Appears in the editor comment thread.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Comment text.' },
        anchor: { type: 'string', description: 'Optional block id / cell ref the comment is about.' },
      },
      required: ['body'],
    },
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

// ── Doc tool implementations (scoped to req.doc / agent email) ──
function agentActorId(email) { return 'agent:' + (email || 'anon'); }

function renderDocContent(doc) {
  const content = JSON.parse(doc.content);
  if (doc.kind === 'sheet') {
    const cells = content.cells || {};
    const rows = {};
    for (const k of Object.keys(cells)) {
      const [r, c] = k.split(',');
      (rows[r] = rows[r] || []).push({ cell: colLetter(+c) + (+r + 1), r: +r, c: +c, ...cells[k] });
    }
    return { kind: 'sheet', cells: Object.values(rows).flat().sort((a, b) => a.r - b.r || a.c - b.c) };
  }
  if (doc.kind === 'slides') {
    return { kind: 'slides', slides: (content.slides || []).map((s, i) => ({
      number: i + 1, id: s.id,
      ...(s.bg ? { bg: s.bg } : {}), ...(s.notes ? { notes: s.notes } : {}),
      blocks: (s.blocks || []).map(b => ({
        id: b.id, type: b.type, text: stripHtml(b.html),
        ...(b.frame ? { frame: b.frame } : {}), ...(b.shape ? { shape: b.shape } : {}),
        ...(b.style ? { style: b.style } : {}), ...(b.src ? { src: String(b.src).slice(0, 120) + (b.src.length > 120 ? '…' : '') } : {}),
      })),
    })) };
  }
  return { kind: 'document', blocks: (content.blocks || []).map(b => ({
    id: b.id, type: b.type, text: stripHtml(b.html),
    ...(b.align ? { align: b.align } : {}), ...(b.checked ? { checked: 1 } : {}),
  })) };
}
function stripHtml(h) { return (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }
function colLetter(n) { let s = ''; n += 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

const DOC_HANDLERS = {
  terse_doc_info(doc, email) {
    const fresh = db.getDoc.get(doc.id);
    return textResult({
      id: fresh.id, kind: fresh.kind, title: fresh.title, version: fresh.version,
      agents_paused: !!fresh.agents_paused,
      live: db.getDocPresence.all(fresh.id).map(p => ({ name: p.name, kind: p.kind, paused: !!p.paused, status: p.status })),
      collaborators: db.getDocCollaborators.all(fresh.id).map(c => ({ email: c.email, role: c.role })),
      you: { email, paused: !!db.getDocPresenceActor.get(fresh.id, agentActorId(email))?.paused },
      op_reference: OP_HELP,
    });
  },
  terse_read_doc(doc, email) {
    const fresh = db.getDoc.get(doc.id);
    // Register/refresh agent presence so humans see this agent in the editor.
    touchAgentPresence(fresh, email);
    return textResult({ version: fresh.version, ...renderDocContent(fresh) });
  },
  terse_edit_doc(doc, email, args) {
    let fresh = db.getDoc.get(doc.id);
    if (fresh.agents_paused) return textResult({ error: 'paused', message: 'A human has paused all agents on this doc. Stop editing until resumed.' });
    const presence = db.getDocPresenceActor.get(fresh.id, agentActorId(email));
    if (presence?.paused) return textResult({ error: 'paused', message: 'A human has paused you on this doc. Stop editing until resumed.' });

    const ops = Array.isArray(args.ops) ? args.ops : [];
    if (!ops.length) return textResult({ error: 'Provide an ops array. ' + OP_HELP });

    let content = JSON.parse(fresh.content);
    let version = fresh.version;
    const applied = [];
    for (const op of ops.slice(0, 200)) {
      const r = model.applyOp(content, op, fresh.kind);
      if (!r.ok) { applied.push({ op, error: r.error }); continue; }
      content = r.content; version += 1;
      db.addDocOp.run({ id: crypto.randomUUID(), doc_id: fresh.id, version, actor: email || 'agent', actor_kind: 'agent', op: JSON.stringify(op) });
      bus.emit(docChan(fresh.id), { type: 'op', version, op, actor: email || 'agent', actor_kind: 'agent' });
      applied.push({ op, version });
    }
    db.updateDocContent.run({ id: fresh.id, content: JSON.stringify(content), version });
    touchAgentPresence(db.getDoc.get(fresh.id), email);
    return textResult({ ok: true, version, applied });
  },
  terse_doc_changes(doc, _email, args) {
    const since = Math.max(0, parseInt(args.since, 10) || 0);
    const ops = db.getDocOps.all(doc.id, since).map(o => ({ version: o.version, actor: o.actor, actor_kind: o.actor_kind, op: JSON.parse(o.op), at: o.created_at }));
    return textResult({ since, changes: ops });
  },
  terse_comment_doc(doc, email, args) {
    const body = (args.body || '').toString().trim().slice(0, 4000);
    if (!body) return textResult({ error: 'body is required.' });
    const row = { id: crypto.randomUUID(), doc_id: doc.id, anchor: (args.anchor || '').slice(0, 120) || null, author: email || 'agent', author_kind: 'agent', body };
    db.addDocComment.run(row);
    bus.emit(docChan(doc.id), { type: 'comment', comment: { ...row, resolved: 0, created_at: new Date().toISOString() } });
    return textResult({ ok: true });
  },
};

function touchAgentPresence(doc, email) {
  const actorId = agentActorId(email);
  const colors = ['#a142f4', '#ff6d01', '#46bdc6', '#34a853'];
  let h = 0; for (let i = 0; i < actorId.length; i++) h = (h * 31 + actorId.charCodeAt(i)) >>> 0;
  db.upsertDocPresence.run({
    doc_id: doc.id, actor_id: actorId,
    name: (email || 'Agent') + ' (agent)', kind: 'agent',
    color: colors[h % colors.length], cursor: null, status: 'online',
  });
  bus.emit(docChan(doc.id), { type: 'presence', presence: db.getDocPresenceActor.get(doc.id, actorId) });
}

// ── JSON-RPC dispatch ──
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const { team, doc, userEmail } = ctx;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'terse-cowork', version: '1.1.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no response
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      const tools = [...(team ? TOOLS : []), ...(doc ? DOC_TOOLS : [])];
      return rpcResult(id, { tools });
    }
    case 'tools/call': {
      const name = params?.name;
      try {
        if (DOC_HANDLERS[name]) {
          if (!doc) return rpcError(id, -32602, 'No doc connected. Set x-terse-doc-token to a Terse Doc share token.');
          return rpcResult(id, DOC_HANDLERS[name](doc, userEmail, params?.arguments || {}));
        }
        if (HANDLERS[name]) {
          if (!team) return rpcError(id, -32602, 'No team connected. Set x-terse-team-token.');
          return rpcResult(id, HANDLERS[name](team, userEmail, params?.arguments || {}));
        }
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      } catch (err) {
        return rpcResult(id, { ...textResult({ error: err.message }), isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

router.post('/', express.json({ limit: '256kb' }), (req, res) => {
  // Two independent credentials may be present: a team token (cowork tools) and/or
  // a doc token (doc co-editing tools). At least one is required.
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const teamRaw = req.headers['x-terse-team-token'] || (bearer && !bearer.startsWith('dtk_') ? bearer : null);
  const docRaw = req.headers['x-terse-doc-token'] || (bearer && bearer.startsWith('dtk_') ? bearer : null);

  let team = null, doc = null;
  if (teamRaw) {
    team = db.findTeamByToken.get(hashToken(teamRaw));
    if (team) db.touchTeamToken.run(hashToken(teamRaw));
  }
  if (docRaw) doc = db.getDocByShareToken.get(docRaw) || null;
  if (doc && (doc.is_trashed || doc.share_role === 'viewer')) {
    // viewer-only link can still read; mark so edit tools refuse politely
    if (doc.is_trashed) doc = null;
  }

  if (!team && !doc) {
    return res.status(401).json({ error: 'Provide x-terse-team-token (team cowork) and/or x-terse-doc-token (a Terse Doc share token).' });
  }
  const userEmail = lc(req.headers['x-terse-user-email']);
  const ctx = { team, doc, userEmail };

  const body = req.body;
  if (Array.isArray(body)) {
    const out = body.map(m => handleRpc(m, ctx)).filter(Boolean);
    return res.json(out);
  }
  const result = handleRpc(body, ctx);
  if (result === null) return res.status(202).end(); // notification
  res.json(result);
});

// A GET on the same path is sometimes probed by clients opening an SSE channel.
router.get('/', (req, res) => res.status(405).json({ error: 'Use POST for JSON-RPC.' }));

module.exports = router;
