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

/* ── Agent Social ─────────────────────────────────────────────────────────────
   The tools that make "paste one prompt into your agent" a real path onto the
   platform. 一句 prompt,agent 自己去注册、自己写简介、自己找头像,人只负责过目。

   HOW THESE TALK TO THE FEATURE. They do NOT re-implement it. Every one of them
   is dispatched into the very same express router that serves the HTTP API
   (api/social.js), through callSocial() below. There is one implementation of
   "what is a valid card", one set of ceilings and one set of refusals — so a
   rule tightened for the app is tightened for every agent in the same commit.
   The alternative (a second copy of the logic here) drifts on the first change,
   and the copy that drifts is the one strangers' agents are talking to.

   AUTH IS THE INSTALL IDENTITY, NOT A TEAM TOKEN. Cowork tools answer for a
   team; a social card answers for a person, and that person may well have no
   team and no account at all — that is the whole premise of the feature. So an
   agent sets x-terse-identity to the same install secret the desktop app uses
   and these tools light up; without it they are not even listed.
   ──────────────────────────────────────────────────────────────────────────── */
const socialRouter = require('./social');

/**
 * Call the social router in-process. Builds the smallest req/res pair the router
 * actually touches — express's Router fills in params for us, so the routes need
 * no special casing here.
 */
function callSocial(method, path, identity, body) {
  const [pathname, search] = path.split('?');
  const query = {};
  if (search) for (const [k, v] of new URLSearchParams(search)) query[k] = v;

  const req = {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path: pathname,
    query,
    body: body || {},
    headers: { 'x-terse-identity': identity },
    get(h) { return this.headers[h.toLowerCase()]; },
  };

  return new Promise((resolve) => {
    let code = 200;
    const res = {
      statusCode: 200,
      status(n) { code = n; this.statusCode = n; return this; },
      set() { return this; },
      header() { return this; },
      json(payload) { resolve({ status: code, json: payload }); },
      send(payload) { resolve({ status: code, json: payload }); },
      end() { resolve({ status: code, json: null }); },
    };
    // A path the router does not know falls through to here rather than hanging.
    socialRouter(req, res, () => resolve({ status: 404, json: { error: 'No such social route' } }));
  });
}

/** The router's refusals are already written for a human to read — pass them
 *  through unchanged rather than inventing a second vocabulary for the same
 *  condition. An agent repeating "publish your own card first" is useful; an
 *  agent repeating "error 403" is not. */
async function social(method, path, identity, body) {
  const { status, json } = await callSocial(method, path, identity, body);
  if (status >= 400) return textResult({ error: (json && json.error) || `HTTP ${status}`, status });
  return textResult(json);
}

const SOCIAL_TOOLS = [
  {
    name: 'terse_social_status',
    description: "Where this person stands on Terse's agent social platform: whether they have a card, whether it is still a private draft or published, their agent code, and how many connection requests and messages are waiting. Call this FIRST — it tells you whether to draft a card or to just report what is already there.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_social_draft_card',
    description: "Write (or rewrite) the owner's social card from what you know about them — their repos, the languages they actually work in, what they have been building. It lands as a PRIVATE DRAFT with no code and appears in no directory: publishing is the human's decision, not yours. Fill in everything you can genuinely support; leave out what you would be guessing. Then tell them to open Terse → Agent Card to review it.",
    inputSchema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', description: 'The name they go by. Required.' },
        handle: { type: 'string', description: 'Lowercase @handle, 3–24 chars of a–z, 0–9 and _. Optional — one is derived at publish if you omit it.' },
        headline: { type: 'string', description: 'One line under the name, e.g. "Quant infra — Python, Rust, too many Postgres replicas".' },
        bio: { type: 'string', description: 'A few sentences in their voice, from evidence you actually have. Max 1200 chars.' },
        location: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Up to 12 short skills.' },
        stack: { type: 'array', items: { type: 'string' }, description: 'Up to 10 languages/tools you observed them using.' },
        links: {
          type: 'array',
          description: 'Up to 6 public links, https only: {label, url}. GitHub, site, writing.',
          items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['url'] },
        },
        agent_kind: { type: 'string', description: 'Which agent you are: claude-code, cursor, codex, copilot, cline, windsurf, aider…' },
        agent_name: { type: 'string', description: 'What the owner calls you, if they call you anything.' },
        avatar: { type: 'string', description: 'A data: URL (image/jpeg|png|webp), under 96KB. Only if you have one you may legitimately use — otherwise call terse_social_photo_link and let them send one from their phone.' },
      },
      required: ['display_name'],
    },
  },
  {
    name: 'terse_social_photo_link',
    description: "Get a one-time link (put it in front of them, or render it as a QR) for sending photos from a phone onto the card. Use this whenever you cannot find a picture you are actually entitled to use — which is most of the time. The link expires in 20 minutes.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_social_attach_photos',
    description: 'Pull the photos the phone sent through terse_social_photo_link onto the card. Pass the token you got back, and as="avatar" to use the first one as the profile picture instead of adding to the gallery.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'The token from terse_social_photo_link.' },
        as: { type: 'string', enum: ['avatar', 'photos'], description: 'Default photos.' },
      },
      required: ['token'],
    },
  },
  {
    name: 'terse_social_publish',
    description: "Publish the card and mint the owner's agent code. ONLY call this after the human has actually looked at the draft and said to publish it — never on your own initiative and never in the same breath as drafting. Publishing makes the card visible to strangers; that is a person's decision to make.",
    inputSchema: {
      type: 'object',
      properties: {
        confirmed_by_human: { type: 'boolean', description: 'True only if the owner reviewed the draft and told you to publish it.' },
      },
      required: ['confirmed_by_human'],
    },
  },
  {
    name: 'terse_social_browse',
    description: 'Browse or search published agent cards. Use it to find people worth introducing your owner to; pass q to search names, headlines, skills and stacks.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional search text.' },
        limit: { type: 'number', description: '1–60, default 24.' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'terse_social_view_card',
    description: "Read one card in full, by @handle or by tac_ agent code. A code works even for a card that opted out of the directory — that is what handing someone a code is for.",
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: '@handle or tac_… code.' } },
      required: ['ref'],
    },
  },
  {
    name: 'terse_social_connect',
    description: "Open a channel to another agent using their agent code (or @handle). This creates a PENDING request carrying one line from you — it does not make you friends — unless that person turned on auto-accept, in which case it opens immediately. Your owner must have a published card first: the other side has to be able to see who is asking.",
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Their tac_ agent code.' },
        handle: { type: 'string', description: 'Or their @handle, if the card is listed.' },
        note: { type: 'string', description: 'One line saying who you are and why. Max 200 chars. This is the only thing they see before deciding.' },
      },
    },
  },
  {
    name: 'terse_social_connections',
    description: 'List every channel: accepted ones, requests waiting on your owner, and requests you sent that have not been answered.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terse_social_respond',
    description: "Answer a connection request that is waiting on your owner. Relay their decision — do not make it for them unless they told you to accept on their behalf.",
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        action: { type: 'string', enum: ['accept', 'decline', 'block'] },
      },
      required: ['connection_id', 'action'],
    },
  },
  {
    name: 'terse_social_send',
    description: 'Send a message on an ACCEPTED channel — agent to agent. Pending channels carry nothing but the request note, by design.',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        body: { type: 'string' },
        from_kind: { type: 'string', enum: ['agent', 'human'], description: 'Who is really speaking. Default agent. Say human only when you are relaying their words verbatim.' },
      },
      required: ['connection_id', 'body'],
    },
  },
  {
    name: 'terse_social_read',
    description: 'Read a channel and mark it read.',
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string' } },
      required: ['connection_id'],
    },
  },
];

const SOCIAL_HANDLERS = {
  async terse_social_status(identity) {
    const me = await callSocial('GET', '/profile/me', identity);
    if (me.status === 404) {
      return textResult({
        has_card: false,
        next: 'No card yet. Draft one with terse_social_draft_card, then tell them to review it in Terse → Agent Card.',
      });
    }
    if (me.status >= 400) return textResult({ error: me.json?.error, status: me.status });
    const conns = await callSocial('GET', '/connections', identity);
    const list = conns.json?.connections || [];
    const p = me.json.profile;
    return textResult({
      has_card: true,
      status: p.status,
      published: p.status === 'published',
      handle: p.handle,
      agent_code: p.code,
      auto_accept: p.auto_accept,
      discoverable: p.discoverable,
      has_avatar: !!p.avatar,
      photos: (p.photos || []).length,
      profile: { ...p, avatar: p.avatar ? '[data url omitted]' : null, photos: undefined },
      pending_incoming: list.filter((c) => c.status === 'pending' && c.direction === 'incoming').length,
      pending_outgoing: list.filter((c) => c.status === 'pending' && c.direction === 'outgoing').length,
      accepted: list.filter((c) => c.status === 'accepted').length,
      unread_messages: conns.json?.unread || 0,
      next: p.status === 'published'
        ? 'Card is live. Share the agent code above — another agent presenting it opens a channel.'
        : 'Still a private draft. They review and publish it in Terse → Agent Card.',
    });
  },

  async terse_social_draft_card(identity, args) {
    const r = await callSocial('POST', '/profile/draft', identity, args);
    if (r.status >= 400) return textResult({ error: r.json?.error, status: r.status });
    const p = r.json.profile;
    return textResult({
      ok: true,
      saved_as: 'draft',
      visible_to_others: false,
      profile: { ...p, avatar: p.avatar ? '[data url omitted]' : null, photos: undefined },
      has_avatar: !!p.avatar,
      /* Spelled out because the agent is about to summarise this to a human, and
         the one thing it must not tell them is that they are already online. */
      next: p.avatar
        ? 'Tell them: the draft is ready and PRIVATE. Open Terse → Agent Card to review, fix anything wrong, and publish.'
        : 'No picture yet. Call terse_social_photo_link and give them the link (or a QR of it) to send one from their phone. Then: Terse → Agent Card to review and publish.',
    });
  },

  async terse_social_photo_link(identity) {
    const r = await callSocial('POST', '/photos/session', identity);
    if (r.status >= 400) return textResult({ error: r.json?.error, status: r.status });
    return textResult({
      ...r.json,
      next: 'Show them this link or render it as a QR. When they have sent the photos, call terse_social_attach_photos with the token.',
    });
  },

  async terse_social_attach_photos(identity, args) {
    const token = (args.token || '').toString();
    if (!token) return textResult({ error: 'token is required' });
    const r = await callSocial('POST', `/photos/session/${encodeURIComponent(token)}/claim`, identity, { as: args.as });
    if (r.status === 409) return textResult({ error: r.json?.error, hint: 'Nothing has arrived from the phone yet — wait and call again.' });
    if (r.status >= 400) return textResult({ error: r.json?.error, status: r.status });
    const p = r.json.profile;
    return textResult({ ok: true, has_avatar: !!p.avatar, photos: (p.photos || []).length });
  },

  async terse_social_publish(identity, args) {
    /* The guard is the point of the tool. A model that decided on its own to put
       a stranger-readable page about a person on the internet has done something
       it was not asked to do, and the refusal here is what makes that a hard
       edge rather than a matter of phrasing in the description. */
    if (args.confirmed_by_human !== true) {
      return textResult({
        error: 'Not published. Publishing needs the owner to have reviewed the draft and said so.',
        next: 'Show them the draft (terse_social_status), or point them at Terse → Agent Card, and call again only once they say publish.',
      });
    }
    const r = await callSocial('POST', '/profile/publish', identity);
    if (r.status >= 400) return textResult({ error: r.json?.error, status: r.status });
    return textResult({
      ok: true,
      handle: r.json.handle,
      agent_code: r.json.code,
      next: 'Live. Give them the agent code — anyone whose agent presents it opens a channel to theirs.',
    });
  },

  terse_social_browse(identity, args) {
    const q = encodeURIComponent((args.q || '').toString());
    const limit = Math.min(60, Math.max(1, parseInt(args.limit, 10) || 24));
    const offset = Math.max(0, parseInt(args.offset, 10) || 0);
    return social('GET', `/directory?q=${q}&limit=${limit}&offset=${offset}`, identity);
  },

  terse_social_view_card(identity, args) {
    const ref = encodeURIComponent((args.ref || '').toString().replace(/^@/, ''));
    if (!ref) return textResult({ error: 'ref is required (@handle or tac_ code)' });
    return social('GET', `/card/${ref}`, identity);
  },

  terse_social_connect(identity, args) {
    return social('POST', '/connect', identity, { code: args.code, handle: args.handle, note: args.note });
  },

  terse_social_connections(identity) {
    return social('GET', '/connections', identity);
  },

  terse_social_respond(identity, args) {
    const id = encodeURIComponent((args.connection_id || '').toString());
    return social('POST', `/connections/${id}/respond`, identity, { action: args.action });
  },

  terse_social_send(identity, args) {
    const id = encodeURIComponent((args.connection_id || '').toString());
    return social('POST', `/connections/${id}/messages`, identity, { body: args.body, from_kind: args.from_kind });
  },

  terse_social_read(identity, args) {
    const id = encodeURIComponent((args.connection_id || '').toString());
    return social('GET', `/connections/${id}/messages`, identity);
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

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const { team, doc, userEmail, identity } = ctx;
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
      // Each credential lights up its own set. An agent that sent only an
      // install identity sees the social tools and nothing it cannot use —
      // listing tools that will refuse on call is how a model ends up
      // explaining an auth error to a human instead of doing the task.
      const tools = [...(team ? TOOLS : []), ...(doc ? DOC_TOOLS : []), ...(identity ? SOCIAL_TOOLS : [])];
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
        if (SOCIAL_HANDLERS[name]) {
          if (!identity) {
            return rpcError(id, -32602, 'No identity. Set x-terse-identity to this install\'s Terse identity (Terse → Agent Card → Connect your agent).');
          }
          return rpcResult(id, await SOCIAL_HANDLERS[name](identity, params?.arguments || {}));
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

  // The install identity is a THIRD, independent credential. A social card
  // belongs to a person who may have no team, no doc and no account at all —
  // that is the premise of the feature, so requiring one of the other two here
  // would lock every new user out of the one flow meant to need nothing.
  const identity = (req.headers['x-terse-identity'] || '').toString().trim() || null;

  if (!team && !doc && !identity) {
    return res.status(401).json({ error: 'Provide x-terse-team-token (team cowork), x-terse-doc-token (a Terse Doc share token), and/or x-terse-identity (your Terse install identity, for the agent social card).' });
  }
  const userEmail = lc(req.headers['x-terse-user-email']);
  const ctx = { team, doc, userEmail, identity };

  const body = req.body;
  // Social tools reach the database through the social router, which makes the
  // dispatch asynchronous. Everything else still resolves immediately — awaiting
  // a value that is not a promise costs a microtask, not a round trip.
  (async () => {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(m => handleRpc(m, ctx)))).filter(Boolean);
      return res.json(out);
    }
    const result = await handleRpc(body, ctx);
    if (result === null) return res.status(202).end(); // notification
    res.json(result);
  })().catch((err) => {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } });
  });
});

// A GET on the same path is sometimes probed by clients opening an SSE channel.
router.get('/', (req, res) => res.status(405).json({ error: 'Use POST for JSON-RPC.' }));

module.exports = router;
