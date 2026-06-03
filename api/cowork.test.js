/**
 * Terse Cowork integration tests — exercises the cowork REST + SSE router and the
 * MCP server end to end against a real (temp) SQLite-backed Express app.
 *
 *   node api/cowork.test.js
 *
 * Self-contained: seeds its own team + token, asserts behavior, then deletes the
 * team (cascade cleans sessions/log/messages). Exits non-zero on any failure.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const coworkRouter = require('./cowork');
const mcpRouter = require('./mcp');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));

// ── Seed team + token ──
const teamId = 'test-team-' + crypto.randomBytes(3).toString('hex');
const rawToken = 'tct_test_' + crypto.randomBytes(8).toString('base64url');
const badToken = 'tct_bad_' + crypto.randomBytes(8).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const owner = 'owner@test.dev', dev2 = 'dev2@test.dev';

function seed() {
  db.createTeam.run({ id: teamId, name: 'Test Team', slug: 'test-' + crypto.randomBytes(3).toString('hex'), owner_user_id: 'u_test', plan: 'team', seats: 5, company: null });
  db.addTeamMember.run({ id: crypto.randomUUID(), team_id: teamId, user_email: owner, user_id: 'u_test', role: 'owner' });
  db.addTeamMember.run({ id: crypto.randomUUID(), team_id: teamId, user_email: dev2, user_id: null, role: 'member' });
  db.addTeamToken.run({ id: crypto.randomUUID(), team_id: teamId, token_hash: hash(rawToken), label: 'test' });
}
function cleanup() { db.db.prepare('DELETE FROM cloud_teams WHERE id = ?').run(teamId); }

const sessionBody = (over = {}) => ({
  session: {
    user_email: owner, device: 'mac', agent_type: 'claude-code', agent_name: 'Claude Code',
    project: 'terse', model: 'claude-opus-4', task: 'building cowork', context_window: 200000,
    context_used: 50000, tokens_in: 1000, tokens_out: 200, tool_calls: 3, turns: 2, ...over,
  },
  log: over.log || [],
});

(async () => {
  seed();
  const app = express();
  app.use(express.json());
  app.use('/api/cloud/mcp', mcpRouter);
  app.use('/api/cloud', coworkRouter);
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const H = { 'Content-Type': 'application/json', 'x-terse-team-token': rawToken };
  const j = (r) => r.json();

  try {
    // ── SSE: open a stream and collect frames ──
    const events = [];
    const ac = new AbortController();
    const ssePromise = (async () => {
      const r = await fetch(`${base}/api/cloud/teams/${teamId}/stream?token=${rawToken}`, { signal: ac.signal });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {}
    })();
    await new Promise((r) => setTimeout(r, 150));

    // ── Publish ──
    let r = await fetch(`${base}/api/cloud/agent-sessions`, { method: 'POST', headers: H,
      body: JSON.stringify(sessionBody({ log: [
        { role: 'user', kind: 'message', text: 'add cowork' },
        { role: 'assistant', kind: 'tool_call', tool: 'Edit', text: 'editing cowork.js' },
      ] })) });
    let d = await j(r);
    ok('publish ok, seq=2', d.ok && d.seq === 2);
    const sid = d.session_id;

    // ── List ──
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/agent-sessions`, { headers: H }));
    ok('one active session with project', d.sessions.length === 1 && d.sessions[0].project === 'terse');
    ok('presence recorded', d.presence.some((p) => p.user_email === owner && p.status === 'online'));

    // ── Read log incrementally ──
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/sessions/${sid}/log?since=0`, { headers: H }));
    ok('log has 2 entries ordered', d.entries.length === 2 && d.entries[0].seq === 1 && d.entries[1].tool === 'Edit');
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/sessions/${sid}/log?since=1`, { headers: H }));
    ok('log since=1 returns only newer', d.entries.length === 1 && d.entries[0].seq === 2);

    // ── Incremental publish (full snapshot, +1 log) ──
    d = await j(await fetch(`${base}/api/cloud/agent-sessions`, { method: 'POST', headers: H,
      body: JSON.stringify(sessionBody({ task: 'done', log: [{ role: 'assistant', kind: 'message', text: 'finished' }] })) }));
    ok('incremental seq=3', d.seq === 3);
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/agent-sessions`, { headers: H }));
    ok('still one session (upsert, not dup)', d.sessions.length === 1 && d.sessions[0].task === 'done');

    // ── A second member's session keeps separate row ──
    await fetch(`${base}/api/cloud/agent-sessions`, { method: 'POST', headers: H,
      body: JSON.stringify(sessionBody({ user_email: dev2, project: 'api', task: 'writing tests' })) });
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/agent-sessions`, { headers: H }));
    ok('two sessions across members', d.sessions.length === 2);

    // ── Messages: handoff to dev2 ──
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/messages`, { method: 'POST', headers: H,
      body: JSON.stringify({ from_email: owner, to_email: dev2, kind: 'handoff', body: 'please review', session_id: sid }) }));
    ok('handoff posted', d.ok && d.message.kind === 'handoff' && d.message.status === 'open');
    const mid = d.message.id;

    // broadcast chat (no to_email)
    await fetch(`${base}/api/cloud/teams/${teamId}/messages`, { method: 'POST', headers: H,
      body: JSON.stringify({ from_email: owner, kind: 'chat', body: 'standup in 5' }) });

    // ── Inbox: dev2 sees handoff + broadcast; owner-only-to messages excluded ──
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/inbox?email=${dev2}`, { headers: H }));
    ok('dev2 inbox has handoff + broadcast', d.inbox.length === 2);

    // ── Resolve ──
    await fetch(`${base}/api/cloud/teams/${teamId}/messages/${mid}/resolve`, { method: 'POST', headers: H, body: JSON.stringify({ status: 'done' }) });
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/inbox?email=${dev2}`, { headers: H }));
    ok('resolved handoff leaves inbox', d.inbox.length === 1 && d.inbox[0].kind === 'chat');

    // ── Feed ──
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/feed`, { headers: H }));
    ok('feed has log + messages', d.log.length >= 2 && d.messages.length >= 1);

    // ── Presence heartbeat endpoint ──
    r = await fetch(`${base}/api/cloud/presence`, { method: 'POST', headers: H, body: JSON.stringify({ user_email: dev2, status: 'online', device: 'mac' }) });
    ok('presence heartbeat ok', (await j(r)).ok === true);

    // ── Auth failures ──
    ok('publish without token → 401', (await fetch(`${base}/api/cloud/agent-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
    ok('list with bad token → 401', (await fetch(`${base}/api/cloud/teams/${teamId}/agent-sessions`, { headers: { 'x-terse-team-token': badToken } })).status === 401);
    ok('list unknown team → 404', (await fetch(`${base}/api/cloud/teams/does-not-exist/agent-sessions`, { headers: H })).status === 404);
    ok('cross-team log read blocked', (await fetch(`${base}/api/cloud/teams/${teamId}/sessions/nope/log`, { headers: H })).status === 404);

    // ── MCP: handshake + tools ──
    const mcp = (msg, hdr) => fetch(`${base}/api/cloud/mcp`, { method: 'POST', headers: { ...H, 'x-terse-user-email': dev2, ...hdr }, body: JSON.stringify(msg) }).then((x) => x.status === 202 ? null : x.json());
    d = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    ok('MCP initialize returns serverInfo', d.result?.serverInfo?.name === 'terse-cowork' && !!d.result.capabilities.tools);
    ok('MCP notifications/initialized → 202 no body', (await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })) === null);
    d = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    ok('MCP lists 6 tools', d.result?.tools?.length === 6);
    d = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terse_list_sessions', arguments: {} } });
    const sessPayload = JSON.parse(d.result.content[0].text);
    ok('MCP list_sessions has ctx fill', sessPayload.sessions.length === 2 && sessPayload.sessions.some((s) => s.context_fill === '25%'));
    d = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'terse_read_log', arguments: { session_id: sid } } });
    ok('MCP read_log returns entries', JSON.parse(d.result.content[0].text).entries.length === 3);
    d = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'terse_inbox', arguments: {} } });
    ok('MCP inbox for dev2', JSON.parse(d.result.content[0].text).inbox.length === 1);
    d = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'terse_post_message', arguments: { to: owner, kind: 'ask', body: 'q?' } } });
    ok('MCP post_message ok', JSON.parse(d.result.content[0].text).ok === true);
    d = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'terse_list_teammates', arguments: {} } });
    ok('MCP teammates lists 2 members', JSON.parse(d.result.content[0].text).members.length === 2);
    d = await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    ok('MCP unknown tool → error', !!d.error && d.error.code === -32602);
    d = await mcp({ jsonrpc: '2.0', id: 9, method: 'bogus/method' });
    ok('MCP unknown method → -32601', d.error?.code === -32601);
    ok('MCP without token → 401', (await fetch(`${base}/api/cloud/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
    // batch
    d = await mcp([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]);
    ok('MCP batch returns 2 results', Array.isArray(d) && d.length === 2);

    // ── Sweep: force a stale session + presence and confirm transitions ──
    db.db.prepare("UPDATE cowork_sessions SET last_seen_at = datetime('now','-10 minutes') WHERE team_id=? AND user_email=?").run(teamId, dev2);
    db.db.prepare("UPDATE cowork_presence SET last_seen_at = datetime('now','-15 minutes'), status='away' WHERE team_id=? AND user_email=?").run(teamId, dev2);
    const before = events.length;
    coworkRouter.sweepStale();
    await new Promise((r) => setTimeout(r, 80));
    d = await j(await fetch(`${base}/api/cloud/teams/${teamId}/agent-sessions`, { headers: H }));
    ok('sweep ended stale session', d.sessions.length === 1);
    ok('sweep broadcast ended + offline events', events.slice(before).some((e) => e.type === 'session' && e.session.status === 'ended')
      && events.slice(before).some((e) => e.type === 'presence' && e.presence.status === 'offline'));

    // ── SSE assertions ──
    await new Promise((r) => setTimeout(r, 60));
    ok('SSE snapshot first', events[0]?.type === 'snapshot');
    ok('SSE streamed session events', events.some((e) => e.type === 'session'));
    ok('SSE streamed >=3 log events', events.filter((e) => e.type === 'log').length >= 3);
    ok('SSE streamed message events', events.filter((e) => e.type === 'message').length >= 1);
    ok('SSE streamed presence events', events.some((e) => e.type === 'presence'));

    ac.abort();
    await ssePromise.catch(() => {});
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
