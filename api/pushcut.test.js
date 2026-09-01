/**
 * Pushcut tests — the one path by which the server can change a wallpaper.
 *
 *   node api/pushcut.test.js
 *
 * The outbound call is stubbed: the question is what this code does with each
 * answer, and whether it can be talked into calling somewhere it should not.
 * That last one is why this file exists — "paste a URL and we will call it" is
 * a server-side request forgery hole with a text field in front of it.
 */
const express = require('express');
const http = require('http');
const db = require('./db');
const linkRouter = require('./link');
const pushcut = require('./pushcut');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

linkRouter.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);

const calls = [];
let responder = () => ({ ok: true, status: 200 });
global.fetch = async (url, opts) => {
  calls.push({ url, body: opts && opts.body });
  const r = responder();
  if (r.throw) throw new Error(r.throw);
  return { ok: r.ok, status: r.status };
};

const app = express();
app.use(express.json());
app.use('/pc', pushcut);
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

const USER = 'user_pc_test';
const GOOD = 'https://api.pushcut.io/SECRET123/execute?shortcut=Terse%20Wallpaper';

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\nPushcut\n');

  eq('reading without a session is 401', (await req('GET', '/pc')).status, 401);
  eq('nothing is configured to begin with', (await req('GET', '/pc', { user: USER })).json.configured, false);

  // ── The URL is the whole attack surface ──
  const bad = [
    ['http://api.pushcut.io/x/execute', 'plain http'],
    ['https://evil.com/x/execute', 'another host'],
    ['https://api.pushcut.io.evil.com/x/execute', 'a lookalike host'],
    ['https://127.0.0.1/x/execute', 'localhost'],
    ['https://api.pushcut.io/x/notexecute', 'a non-execute path'],
    ['not a url at all', 'nonsense'],
    ['', 'nothing'],
  ];
  for (const [url, why] of bad) {
    eq(`refuses ${why}`, (await req('PUT', '/pc', { user: USER, body: { url } })).status, 400);
  }

  // ── Storing ──
  const put = await req('PUT', '/pc', { user: USER, body: { url: GOOD } });
  eq('accepts a real Pushcut execute URL', put.status, 200);
  eq('and reads the shortcut name out of it', put.json.shortcut, 'Terse Wallpaper');

  const got = await req('GET', '/pc', { user: USER });
  ok('never hands the URL back', !JSON.stringify(got.json).includes('SECRET123'));
  ok('but shows enough to recognise it', /^…/.test(got.json.hint || ''));

  // ── Firing ──
  calls.length = 0;
  const test = await req('POST', '/pc/test', { user: USER });
  eq('a test fires', test.json.fired, true);
  eq('and calls exactly once', calls.length, 1);
  eq('at the stored URL', calls[0].url, GOOD);
  ok('asking Pushcut not to wait', /nowait/.test(calls[0].body || ''));

  // ── The rate limit ──
  calls.length = 0;
  const soon = await pushcut.fire(USER);
  eq('a second fire straight away is skipped', soon.fired, false);
  eq('for the right reason', soon.reason, 'too soon');
  eq('and makes no call', calls.length, 0);

  // A test must ignore it, or setup means waiting a minute per attempt.
  calls.length = 0;
  eq('but an explicit test still fires', (await req('POST', '/pc/test', { user: USER })).json.fired, true);
  eq('and does call', calls.length, 1);

  // ── Failures ──
  responder = () => ({ ok: false, status: 503 });
  const failed = await pushcut.fire(USER, { force: true });
  eq('a failure is reported', failed.fired, false);
  eq('with the status', failed.reason, 'HTTP 503');
  ok('and remembered, so the app can show it', /503/.test((await req('GET', '/pc', { user: USER })).json.last_error || ''));

  responder = () => ({ throw: 'network down' });
  const threw = await pushcut.fire(USER, { force: true });
  eq('a thrown call does not escape', threw.fired, false);
  ok('and is reported', /network down/.test(threw.reason));
  responder = () => ({ ok: true, status: 200 });

  // ── Not configured ──
  eq('an account with no URL is a no-op', (await pushcut.fire('user_pc_nobody')).fired, false);
  calls.length = 0;
  await pushcut.fire('user_pc_nobody');
  eq('and makes no call', calls.length, 0);

  // ── Removing ──
  eq('delete works', (await req('DELETE', '/pc', { user: USER })).json.configured, false);
  calls.length = 0;
  eq('and then nothing fires', (await pushcut.fire(USER, { force: true })).fired, false);
  eq('with no call made', calls.length, 0);

  try { db.deletePushcut.run(USER); } catch { /* gone */ }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
