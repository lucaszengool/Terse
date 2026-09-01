/**
 * Push route tests — subscribing, listing, removing, and the desktop's ability
 * to ask for a notification.
 *
 *   node api/push.test.js
 *
 * The CRYPTO is verified separately, against RFC 8291's own example, in
 * webpush.test.js. This file is about the surface around it: who may subscribe,
 * what a malformed subscription does, and whether a dead device is cleaned up
 * rather than retried forever.
 *
 * Nothing here reaches a real push service. The sender is stubbed, because the
 * question is what this code does with each answer, not whether Google's
 * endpoint is up.
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');
const linkRouter = require('./link');
const webpush = require('./webpush');

process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || webpush.generateVAPIDKeys().publicKey;
process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || webpush.generateVAPIDKeys().privateKey;
const pushRouter = require('./push');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

linkRouter.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);

// The stub stands in for the push service. Each endpoint decides its own answer,
// so one subscription can succeed while another reports itself gone.
const outbox = [];
let responder = () => ({ ok: true, status: 201, gone: false });
webpush.send = async (sub, payload) => {
  outbox.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return responder(sub);
};

const app = express();
app.use(express.json());
app.use('/push', pushRouter);
app.use('/link', linkRouter);
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

/** A subscription shaped exactly like the browser's PushSubscription.toJSON(). */
function subscription(tag) {
  const ec = crypto.createECDH('prime256v1');
  ec.generateKeys();
  return {
    endpoint: `https://push.example.com/send/${tag}`,
    keys: {
      p256dh: ec.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

const USER = 'user_push_test';
const OTHER = 'user_push_other';

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\nPush\n');

  // ── The public key ──
  const key = await req('GET', '/push/key');
  eq('the key route is public', key.status, 200);
  eq('and reports enabled', key.json.enabled, true);
  ok('serving a 65-byte P-256 point', Buffer.from(key.json.publicKey, 'base64url').length === 65);

  // ── Auth ──
  eq('subscribing without a session is 401', (await req('POST', '/push/subscribe', { body: subscription('a') })).status, 401);
  eq('a bad session is 401', (await req('POST', '/push/subscribe', { user: 'bad', body: subscription('a') })).status, 401);

  // ── Validation ──
  // A malformed subscription stored now is a notification that silently never
  // arrives weeks later, so it is rejected at the door rather than at send time.
  eq('a missing endpoint is refused',
    (await req('POST', '/push/subscribe', { user: USER, body: { keys: { p256dh: 'x', auth: 'y' } } })).status, 400);
  eq('a non-https endpoint is refused',
    (await req('POST', '/push/subscribe', { user: USER, body: { endpoint: 'http://x/y', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  const badKeys = subscription('bad');
  badKeys.keys.p256dh = Buffer.alloc(65).toString('base64url');   // not a curve point
  const rejected = await req('POST', '/push/subscribe', { user: USER, body: badKeys });
  eq('unusable keys are refused', rejected.status, 400);
  ok('and say why', /P-256/.test(rejected.json.error || ''));

  // ── Subscribing ──
  const s1 = subscription('one');
  const sub1 = await req('POST', '/push/subscribe', { user: USER, body: s1 });
  eq('subscribing works', sub1.status, 200);
  eq('and counts the device', sub1.json.devices, 1);

  // Re-subscribing the same endpoint must not create a second row — browsers
  // re-send the same subscription on every launch.
  eq('re-subscribing the same device is idempotent',
    (await req('POST', '/push/subscribe', { user: USER, body: s1 })).json.devices, 1);

  const s2 = subscription('two');
  eq('a second device is added', (await req('POST', '/push/subscribe', { user: USER, body: s2 })).json.devices, 2);

  const list = await req('GET', '/push', { user: USER });
  eq('both are listed', list.json.devices.length, 2);
  ok('and the endpoint itself is not handed back',
    !JSON.stringify(list.json).includes('push.example.com'));

  // ── Isolation ──
  await req('POST', '/push/subscribe', { user: OTHER, body: subscription('other') });
  eq('another account sees only its own', (await req('GET', '/push', { user: OTHER })).json.devices.length, 1);

  // ── Sending ──
  outbox.length = 0;
  const test = await req('POST', '/push/test', { user: USER });
  eq('a test reaches both devices', test.json.sent, 2);
  eq('and nothing else', outbox.length, 2);
  eq('the payload carries a title', outbox[0].payload.title, 'Terse');
  ok('and a url to open', !!outbox[0].payload.url);

  // ── A device the push service says is gone ──
  // 404/410 means it will never work again. Keeping it would mean retrying a
  // dead endpoint on every notification, forever.
  responder = (sub) => sub.endpoint.endsWith('one')
    ? { ok: false, status: 410, gone: true }
    : { ok: true, status: 201, gone: false };
  const afterGone = await req('POST', '/push/test', { user: USER });
  eq('the live device still receives', afterGone.json.sent, 1);
  eq('the dead one is reported gone', afterGone.json.gone, 1);
  eq('and is deleted, not retried', (await req('GET', '/push', { user: USER })).json.devices.length, 1);

  // A transient failure must NOT delete the device — a push service having a bad
  // minute is not the same as a device that no longer exists.
  responder = () => ({ ok: false, status: 500, gone: false });
  const failed = await req('POST', '/push/test', { user: USER });
  eq('a 500 counts as failed', failed.json.failed, 1);
  eq('but the device survives', (await req('GET', '/push', { user: USER })).json.devices.length, 1);
  responder = () => ({ ok: true, status: 201, gone: false });

  // ── The desktop asking ──
  const pair = await req('POST', '/link/pair', { body: { device: 'mac', name: 'Test Mac' } });
  const secret = pair.json.secret;
  eq('an unlinked desktop cannot notify',
    (await req('POST', '/link/notify', { device: secret, body: { body: 'hi' } })).status, 409);
  await req('POST', '/link/claim', { user: USER, body: { code: pair.json.code } });

  eq('a notification with no body is refused',
    (await req('POST', '/link/notify', { device: secret, body: { title: 'x' } })).status, 400);
  eq('without a device secret it is 401',
    (await req('POST', '/link/notify', { body: { body: 'hi' } })).status, 401);

  outbox.length = 0;
  const note = await req('POST', '/link/notify', {
    device: secret,
    body: { title: 'Claude', body: 'is waiting for approval', tag: 'approval' },
  });
  eq('the desktop can notify its phone', note.status, 200);
  eq('and it is delivered', note.json.sent, 1);
  eq("with the desktop own title", outbox[0].payload.title, 'Claude');
  eq('and its tag, so a repeat replaces rather than stacks', outbox[0].payload.tag, 'approval');

  // Overlong text is clipped rather than refused: a notification is a glance.
  outbox.length = 0;
  await req('POST', '/link/notify', { device: secret, body: { title: 'T'.repeat(200), body: 'B'.repeat(400) } });
  ok('a long title is clipped', outbox[0].payload.title.length <= 60);
  ok('and a long body too', outbox[0].payload.body.length <= 160);

  // ── Unsubscribing ──
  eq('removing all devices works', (await req('DELETE', '/push/subscribe', { user: USER })).json.devices, 0);
  const quiet = await req('POST', '/push/test', { user: USER });
  eq('and then nothing is sent', quiet.json.sent, 0);

  // ── Cleanup ──
  for (const u of [USER, OTHER]) { try { db.deletePushSubsForUser.run(u); } catch { /* gone */ } }
  try { db.deleteDeviceLink.run(pair.json.id); } catch { /* gone */ }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
