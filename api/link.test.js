/**
 * Device link integration tests — pairing, pushing, streaming, unpairing, end to
 * end against a real SQLite-backed Express app.
 *
 *   node api/link.test.js
 *
 * Clerk verification is swapped for a stub: the token IS the user id. Everything
 * else — the conditional claim, the expiry window, the SSE fan-out — is the real
 * code path, because those are the parts that can actually be wrong.
 *
 * Self-contained: deletes every link it creates. Exits non-zero on any failure.
 */
const express = require('express');
const http = require('http');
const db = require('./db');
const linkRouter = require('./link');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// The token is the user id. Anything falsy still fails, so the 401 paths stay real.
linkRouter.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);

const app = express();
app.use('/link/push', express.json({ limit: '4mb' }));
app.use(express.json());
app.use('/link', linkRouter);
const server = http.createServer(app);

function req(method, path, { user, device, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(device ? { 'x-terse-device': device } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** Open the SSE stream and collect frames until `want` have arrived. */
function stream(user, want) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({
      host: '127.0.0.1', port: server.address().port,
      path: `/link/stream?token=${encodeURIComponent(user)}`, method: 'GET',
    }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;   // ping
          try { events.push(JSON.parse(chunk.slice(6))); } catch { /* ignore */ }
          if (events.length >= want) { r.destroy(); resolve(events); }
        }
      });
    });
    r.on('error', (e) => { if (events.length >= want) return; reject(e); });
    r.end();
    setTimeout(() => { r.destroy(); resolve(events); }, 4000);
  });
}

const created = [];

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\nDevice links\n');

  // ── Pairing ──
  const pair = await req('POST', '/link/pair', { body: { device: 'mac', name: "James's MacBook" } });
  created.push(pair.json?.id);
  eq('pair returns 200', pair.status, 200);
  ok('pair returns a secret', typeof pair.json?.secret === 'string' && pair.json.secret.length === 64);
  ok('pair returns a 6-char code', /^[A-HJ-NP-Z2-9]{6}$/.test(pair.json?.code || ''));
  ok('code avoids O/0/I/1', !/[O0I1]/.test(pair.json?.code || ''));
  ok('pair url embeds the code', (pair.json?.url || '').endsWith(pair.json?.code));

  const secret = pair.json.secret;
  const code = pair.json.code;

  // ── Status before the phone shows up ──
  const pre = await req('GET', '/link/status', { device: secret });
  eq('status before claim is unlinked', pre.json?.linked, false);
  eq('status carries the device kind', pre.json?.device, 'mac');
  eq('nobody is watching yet', pre.json?.watching, false);

  // Pushing before a phone exists is a conflict, not a silent success — a
  // desktop that quietly posts into the void is the hardest bug to notice.
  const early = await req('POST', '/link/push', { device: secret, body: { stats: {}, sessions: [] } });
  eq('push before claim is refused', early.status, 409);

  // ── Auth ──
  eq('claim without a session is 401', (await req('POST', '/link/claim', { body: { code } })).status, 401);
  eq('claim with a bad session is 401', (await req('POST', '/link/claim', { user: 'bad', body: { code } })).status, 401);
  eq('push without a device secret is 401', (await req('POST', '/link/push', { body: {} })).status, 401);
  eq('push with an unknown secret is 401', (await req('POST', '/link/push', { device: 'nope', body: {} })).status, 401);

  // ── Claiming ──
  const claim = await req('POST', '/link/claim', { user: 'user_phone', body: { code } });
  eq('claim returns 200', claim.status, 200);
  eq('claimed link reports the device', claim.json?.link?.device, 'mac');
  eq('claimed link is not live yet', claim.json?.link?.live, false);

  // The conditional UPDATE is the whole point: two phones scanning the same
  // screen must not both end up paired.
  const second = await req('POST', '/link/claim', { user: 'user_other', body: { code } });
  eq('the same code cannot be claimed twice', second.status, 404);
  eq('a nonsense code is 404', (await req('POST', '/link/claim', { user: 'user_phone', body: { code: 'ZZZZZZ' } })).status, 404);

  const post = await req('GET', '/link/status', { device: secret });
  eq('status after claim is linked', post.json?.linked, true);

  // ── Pushing a frame ──
  const frame = {
    stats: { tokensSaved: 1234, tokensIn: 10000, percentSaved: 12 },
    sessions: [{ agentType: 'claude-code', agentName: 'Claude', burnRate: 900, connected: true }],
  };
  const push = await req('POST', '/link/push', { device: secret, body: frame });
  eq('push returns 200', push.status, 200);

  const list = await req('GET', '/link', { user: 'user_phone' });
  eq('phone sees one device', list.json?.devices?.length, 1);
  eq('phone sees the pushed stats', list.json?.frame?.stats?.tokensSaved, 1234);
  eq('phone sees the agent', list.json?.frame?.sessions?.[0]?.agentType, 'claude-code');
  eq('a fresh push reads as live', list.json?.devices?.[0]?.live, true);

  // Another account must not see this device at all.
  const stranger = await req('GET', '/link', { user: 'user_other' });
  eq('a stranger sees no devices', stranger.json?.devices?.length, 0);
  eq('a stranger sees no frame', stranger.json?.frame, null);

  // ── Streaming ──
  // The snapshot arrives immediately; the second event is the live push, which
  // is only emitted because the subscription is keyed by the paired link id.
  const events = stream('user_phone', 2);
  await new Promise((r) => setTimeout(r, 250));
  await req('POST', '/link/push', {
    device: secret,
    body: { stats: { tokensSaved: 9999 }, sessions: [] },
  });
  const got = await events;
  eq('stream opens with a snapshot', got[0]?.type, 'snapshot');
  eq('snapshot replays the last frame', got[0]?.frame?.stats?.tokensSaved, 1234);
  eq('stream delivers the live frame', got[1]?.type, 'frame');
  eq('live frame carries the new number', got[1]?.stats?.tokensSaved, 9999);

  /* ── Fat frames are TRIMMED, not refused ────────────────────────────────
     This used to assert that a big frame came back 413, which is what the
     handler did — and it is why a linked phone never showed an agent log. A
     real session snapshot carries thirty messages with user prompts kept whole
     (the desktop's optimizer needs them locally), so ANY Mac with history
     pushed a frame over the old 64KB limit, was refused, and said nothing: the
     desktop reads only `watching` off the reply.

     So the contract is the other way round now. The frame is cut down to what
     the phone draws, and the prompts — which the cloud has no use for — do not
     get stored at all. */
  const fat = {
    stats: { tokensSaved: 4242 },
    sessions: Array.from({ length: 8 }, (_, i) => ({
      id: 'agent-' + i, agentType: 'claude', agentName: 'Claude ' + i, agentIcon: '🤖',
      connected: true, project: '/Users/someone/work/thing', burnRate: 100 - i,
      turns: 12, totalTokens: 90000,
      recentMessages: Array.from({ length: 30 }, (_, k) => ({
        role: k % 2 ? 'user' : 'assistant', type: 'text', toolName: '',
        // What a real prompt looks like on the wire: kept whole, up to 2000.
        text: 'SECRETPROMPT ' + 'p'.repeat(1900) + ' ' + k,
        tokens: 40,
      })),
    })),
  };
  const raw = JSON.stringify(fat).length;
  ok('the frame a real Mac sends is far over the old limit', raw > 64 * 1024);
  const fatRes = await req('POST', '/link/push', { device: secret, body: fat });
  eq('and it is accepted now', fatRes.status, 200);

  const afterFat = await req('GET', '/link', { user: 'user_phone' });
  const fr = afterFat.json?.frame;
  eq('the frame lands', fr?.stats?.tokensSaved, 4242);
  eq('with every agent', fr?.sessions?.length, 8);
  ok('and each keeps the log the field draws', (fr?.sessions?.[0]?.recentMessages || []).length > 0);
  ok('trimmed to the last few', fr.sessions[0].recentMessages.length <= 8);
  ok('the keys msgToLine reads survive',
     ['role', 'type', 'toolName', 'text', 'tokens'].every((k) => k in fr.sessions[0].recentMessages[0]));
  ok('so does what the HUD sorts on', typeof fr.sessions[0].burnRate === 'number');
  // The point of trimming, not just a side effect of it.
  ok('a whole prompt is NOT stored in the cloud',
     fr.sessions[0].recentMessages.every((m) => m.text.length <= 140));
  ok('and the stored frame is small', JSON.stringify(fr).length < 64 * 1024);

  // The backstop is still a backstop.
  const absurd = await req('POST', '/link/push', {
    device: secret,
    body: { stats: { blob: 'x'.repeat(300 * 1024) }, sessions: [] },
  });
  eq('something genuinely malformed is still refused', absurd.status, 413);
  eq('with a readable error', absurd.json?.error, 'Frame too large');
  eq('and it did not overwrite the good frame',
     (await req('GET', '/link', { user: 'user_phone' })).json?.frame?.stats?.tokensSaved, 4242);

  // ── Unpairing ──
  const id = list.json.devices[0].id;
  eq('a stranger cannot unpair my device', (await req('DELETE', `/link/${id}`, { user: 'user_other' })).status, 404);
  eq('unpair returns 200', (await req('DELETE', `/link/${id}`, { user: 'user_phone' })).status, 200);
  eq('the device is gone', (await req('GET', '/link', { user: 'user_phone' })).json?.devices?.length, 0);
  // The secret dies with the row, so a machine you gave away cannot keep pushing.
  eq('the old secret no longer authenticates', (await req('GET', '/link/status', { device: secret })).status, 401);

  // ── Expiry ──
  const stale = await req('POST', '/link/pair', { body: { device: 'windows' } });
  created.push(stale.json?.id);
  db.db.prepare("UPDATE device_links SET pair_expires_at = datetime('now','-1 minute') WHERE id = ?")
    .run(stale.json.id);
  eq('an expired code cannot be claimed',
    (await req('POST', '/link/claim', { user: 'user_phone', body: { code: stale.json.code } })).status, 404);

  // ── Cleanup ──
  for (const id2 of created) { if (id2) try { db.deleteDeviceLink.run(id2); } catch { /* already gone */ } }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
