/**
 * Live Activity, end to end through the real routes.
 *
 *   node api/liveactivity.e2e.test.js
 *
 * The unit tests next door stub global.fetch, which proves what the module does
 * with an answer but not that the pieces are connected. This one runs the real
 * pair → claim → configure → push chain over HTTP and points the relay at a
 * local recorder, so what gets asserted is the actual request that would reach
 * ActivitySmith: method, path, headers, body.
 *
 * WHAT THIS CANNOT COVER, stated so nobody reads a green run as more than it
 * is: whether ActivitySmith accepts this payload and renders a pill. That needs
 * their account and a real iPhone. Everything up to their front door is here.
 */
const express = require('express');
const http = require('http');
const db = require('./db');
const linkRouter = require('./link');
const la = require('./liveactivity');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

const USER = 'user_la_e2e';
linkRouter.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);

// ── The relay, recorded ────────────────────────────────────────────────────
const got = [];
const relay = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    got.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

// ── The real app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/cloud/link', linkRouter);
app.use('/api/cloud/liveactivity', la);
const server = http.createServer(app);

function req(method, path, { user, device, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.address().port}`;
  la.PROVIDERS.activitysmith.url = (k) => `${base}/api/live-activity/stream/${encodeURIComponent(k)}`;
  la.PROVIDERS.activitysmith.endUrl = la.PROVIDERS.activitysmith.url;

  console.log('\nLive Activity — end to end\n');
  try { db.deleteLiveActivity.run(USER); } catch { /* first run */ }

  // ── 1. the Mac mints a pair code, the phone claims it ──
  const pair = await req('POST', '/api/cloud/link/pair', { body: { device: 'mac', name: 'E2E Mac' } });
  eq('the Mac gets a pair code', pair.status, 200);
  ok('and a QR url carrying it', /\/m\/pair\?c=/.test(pair.json.url || ''));
  const secret = pair.json.secret;

  const claim = await req('POST', '/api/cloud/link/claim', { user: USER, body: { code: pair.json.code } });
  eq('the phone claims it', claim.status, 200);

  // ── 2. nothing is pushed while no relay is configured ──
  got.length = 0;
  await req('POST', '/api/cloud/link/push', {
    device: secret, body: { stats: { tokens_today: 1 }, sessions: [] },
  });
  await wait(150);
  eq('an unconfigured account causes no outbound call', got.length, 0);

  // ── 3. configure the relay ──
  const KEY = 'as_live_e2e_abcdefghijklmnop';
  const put = await req('PUT', '/api/cloud/liveactivity', {
    user: USER, body: { provider: 'activitysmith', api_key: KEY },
  });
  eq('the relay is configured', put.json.configured, true);
  ok('and the key never comes back', JSON.stringify(put.json).indexOf(KEY) === -1);

  // ── 4. THE ONE THAT MATTERS: a desktop frame reaches the relay ──
  got.length = 0;
  const push = await req('POST', '/api/cloud/link/push', {
    device: secret,
    body: {
      stats: { tokens_today: 184320, tokens_saved: 41230 },
      sessions: [{ name: 'claude-opus', connected: true, burnRate: 12 },
                 { name: 'sweep', connected: true, burnRate: 4 },
                 { name: 'idle', connected: false }],
    },
  });
  eq('the desktop push succeeds', push.status, 200);
  // Fired after the response and never awaited, so give it a moment.
  await wait(300);
  eq('exactly one call reached the relay', got.length, 1);

  const call = got[0];
  eq('as a PUT', call.method, 'PUT');
  ok('to the stream endpoint', /^\/api\/live-activity\/stream\/terse-[0-9a-f]{16}$/.test(call.url));
  eq('with the key as a bearer token', call.auth, `Bearer ${KEY}`);

  const body = JSON.parse(call.body);
  eq('a stats activity', body.type, 'stats');
  eq('titled Terse', body.title, 'Terse');
  eq('with three metrics', body.metrics.length, 3);
  eq('connected agents only', body.metrics[0].value, '2');
  eq('today shortened', body.metrics[1].value, '184.3k');
  eq('saved shortened', body.metrics[2].value, '41.2k');

  // ── 5. the floor holds on the real path ──
  got.length = 0;
  await req('POST', '/api/cloud/link/push', {
    device: secret, body: { stats: { tokens_today: 2 }, sessions: [] },
  });
  await wait(300);
  eq('a second frame inside the floor does not reach the relay', got.length, 0);

  // ── 6. the Test button pushes immediately, floor or not ──
  got.length = 0;
  const test = await req('POST', '/api/cloud/liveactivity/test', { user: USER });
  eq('Test returns pushed', test.json.pushed, true);
  eq('and really called out', got.length, 1);

  // ── 7. removing it dismisses the pill first ──
  got.length = 0;
  await req('DELETE', '/api/cloud/liveactivity', { user: USER });
  ok('delete dismisses the activity at the relay', got.some((c) => c.method === 'DELETE'));
  eq('and the account is clean', (await req('GET', '/api/cloud/liveactivity', { user: USER })).json.configured, false);

  got.length = 0;
  await req('POST', '/api/cloud/link/push', {
    device: secret, body: { stats: { tokens_today: 3 }, sessions: [] },
  });
  await wait(200);
  eq('and nothing is pushed after removal', got.length, 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close(); relay.close();
  process.exit(fail ? 1 : 0);
})();
