/**
 * Live Activity relay tests — the Dynamic Island without an app of our own.
 *
 *   node api/liveactivity.test.js
 *
 * The outbound call is stubbed: the question is what this code does with each
 * answer, and whether it can be talked into calling somewhere it should not.
 *
 * The last case in this file is the one that earned it. The call from the
 * desktop's push route sits inside a try/catch whose whole job is to make sure
 * a notification cannot fail a frame — so the first version, which referenced a
 * variable that did not exist in that scope, threw a ReferenceError that the
 * catch swallowed. Every test still passed and the Island simply never updated.
 * A relay that silently does nothing is indistinguishable from one that is not
 * configured, so it is asserted here directly.
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

linkRouter.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);

const calls = [];
let responder = () => ({ ok: true, status: 200 });
global.fetch = async (url, opts) => {
  calls.push({ url, method: opts && opts.method, headers: (opts && opts.headers) || {}, body: opts && opts.body });
  const r = responder();
  if (r.throw) throw new Error(r.throw);
  return { ok: r.ok, status: r.status };
};

const app = express();
app.use(express.json());
app.use('/la', la);
const server = http.createServer(app);

function req(method, path, { user, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
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

const USER = 'user_la_test';
const KEY = 'as_live_abcdefghijklmnop';
const FRAME = { stats: { tokens_today: 184320, tokens_saved: 41230 },
                sessions: [{ name: 'a', connected: true }, { name: 'b', connected: true }, { name: 'c', connected: false }] };

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\nLive Activity relay\n');

  try { db.deleteLiveActivity.run(USER); } catch { /* first run */ }

  eq('reading without a session is 401', (await req('GET', '/la')).status, 401);
  eq('nothing is configured to begin with', (await req('GET', '/la', { user: USER })).json.configured, false);
  ok('the providers are advertised so a client need not hardcode them',
    (await req('GET', '/la', { user: USER })).json.providers.includes('activitysmith'));

  // ── An unknown relay is refused. The alternative — a URL the user pastes —
  //    is server-side request forgery with a text field in front of it. ──
  eq('an unknown provider is refused',
    (await req('PUT', '/la', { user: USER, body: { provider: 'evil.com', api_key: KEY } })).status, 400);
  eq('a key too short to be one is refused',
    (await req('PUT', '/la', { user: USER, body: { provider: 'activitysmith', api_key: 'abc' } })).status, 400);

  // ── Configure ──
  const put = await req('PUT', '/la', { user: USER, body: { provider: 'activitysmith', api_key: KEY } });
  eq('configuring returns 200', put.status, 200);
  eq('and reports it configured', put.json.configured, true);
  ok('the key is never handed back', JSON.stringify(put.json).indexOf(KEY) === -1);
  ok('only a masked hint is', put.json.hint === '…' + KEY.slice(-4));

  // ── Pushing ──
  calls.length = 0;
  const first = await la.push(USER, FRAME, { force: true });
  eq('a push is made', first.pushed, true);
  eq('exactly one call', calls.length, 1);
  ok('to the relay, on its own host', /^https:\/\/activitysmith\.com\/api\/live-activity\/stream\//.test(calls[0].url));
  eq('with PUT, so create and update are the same request', calls[0].method, 'PUT');
  ok('the key travels as a bearer token', calls[0].headers.Authorization === `Bearer ${KEY}`);

  const body = JSON.parse(calls[0].body);
  eq('the payload is a stats activity', body.type, 'stats');
  eq('titled Terse', body.title, 'Terse');
  eq('carrying three metrics', body.metrics.length, 3);
  eq('and only the CONNECTED agents are counted', body.metrics[0].value, '2');
  eq('big numbers are shortened for a narrow pill', body.metrics[1].value, '184.3k');

  // ── The stream key is derived, so a second device updates one pill ──
  const urlA = calls[0].url;
  calls.length = 0;
  await la.push(USER, FRAME, { force: true });
  eq('the stream key is stable across pushes', calls[0].url, urlA);

  // ── Throttling ──
  calls.length = 0;
  const soon = await la.push(USER, FRAME);
  eq('a push inside the floor is skipped', soon.pushed, false);
  eq('and makes no call', calls.length, 0);
  eq('the floor is ten seconds', la.MIN_GAP_MS, 10000);
  ok('force overrides it', (await la.push(USER, FRAME, { force: true })).pushed === true);

  // ── Failure is recorded rather than thrown ──
  calls.length = 0;
  responder = () => ({ ok: false, status: 402 });
  const failed = await la.push(USER, FRAME, { force: true });
  eq('a refused push is reported, not thrown', failed.pushed, false);
  eq('with the status', failed.reason, 'HTTP 402');
  eq('and remembered, so the app can show it',
    (await req('GET', '/la', { user: USER })).json.last_error, 'HTTP 402');

  responder = () => ({ throw: 'network down' });
  const threw = await la.push(USER, FRAME, { force: true });
  eq('a thrown call does not escape', threw.pushed, false);
  eq('and is reported', threw.reason, 'network down');
  responder = () => ({ ok: true, status: 200 });

  // ── An unconfigured account is a no-op, not an error ──
  eq('an account with no relay is a no-op', (await la.push('nobody_at_all', FRAME)).pushed, false);

  // ── THE ONE THAT EARNED THIS FILE ──
  // The desktop's push route calls this from inside a try/catch that exists to
  // stop a notification failing a frame. A ReferenceError in the argument is
  // swallowed there, so the only way to know the call is real is to make it.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'link.js'), 'utf8');
  const line = (src.split('\n').find((l) => l.includes("require('./liveactivity')")) || '');
  ok('the push route calls the relay at all', !!line);
  ok('and passes a value that exists in that scope — not a variable it invented',
    /\.push\(req\.link\.clerk_user_id,\s*frame\s*\)/.test(line));

  // ── Disconnecting takes the pill down before forgetting how to reach it ──
  calls.length = 0;
  const del = await req('DELETE', '/la', { user: USER });
  eq('delete returns 200', del.status, 200);
  ok('and dismisses the activity first', calls.some((c) => c.method === 'DELETE'));
  eq('then it is gone', (await req('GET', '/la', { user: USER })).json.configured, false);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
