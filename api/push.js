/**
 * Push notifications for the phone web app.
 *
 * ⚠ INERT UNTIL KEYS EXIST. Without VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY the
 * /key route reports disabled, the app never asks for permission, and nothing
 * here can be called by accident. Generate a pair once with:
 *
 *     node scripts/generate-vapid-keys.js
 *
 * WHAT IS WORTH INTERRUPTING SOMEONE FOR. Deliberately not "an agent did a
 * thing": a phone that buzzes for routine work gets its notifications turned
 * off within a day, and then the one that mattered never arrives either. Only
 * two things send:
 *
 *   · the DESKTOP asking, through /api/cloud/link/notify. It already knows when
 *     an agent is blocked on approval or a budget is about to break — that logic
 *     lives in circuit.rs and approvals.rs and is not worth re-deriving here
 *     from a snapshot.
 *   · somebody knocking on your room, which is a person waiting on you.
 *
 * iOS delivers push ONLY to a web app installed on the Home Screen, never from
 * a Safari tab. That is why the app asks for permission from its settings screen
 * rather than on first load, where most iPhones would refuse it silently.
 */
const express = require('express');
const db = require('./db');
const webpush = require('./webpush');
const link = require('./link');

const router = express.Router();

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@terseai.org';

const enabled = () => !!(PUBLIC_KEY && PRIVATE_KEY);

/** How many devices one account may register. A person has a phone and maybe a
 *  tablet; anything past this is a subscription that was never cleaned up. */
const MAX_DEVICES = 8;

async function requireUser(req, res, next) {
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!raw) return res.status(401).json({ error: 'Sign in first' });
  try {
    req.userId = await link.verifyUser(raw);
    if (!req.userId) throw new Error('no subject');
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — sign in again' });
  }
}

// GET /api/cloud/push/key — the public key the browser needs to subscribe, and
// whether this deployment can push at all.
router.get('/key', (req, res) => {
  res.json({ enabled: enabled(), publicKey: enabled() ? PUBLIC_KEY : null });
});

// POST /api/cloud/push/subscribe   Body: the PushSubscription, plus standalone
router.post('/subscribe', requireUser, (req, res) => {
  if (!enabled()) return res.status(503).json({ error: 'Push is not configured on this server' });

  const sub = req.body || {};
  const endpoint = (sub.endpoint || '').toString();
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return res.status(400).json({ error: 'Not a usable subscription' });
  }
  // Validated here rather than at send time: a malformed key stored now is a
  // notification that silently never arrives weeks later.
  try {
    webpush.encrypt('probe', p256dh, auth);
  } catch (e) {
    return res.status(400).json({ error: 'Subscription keys are unusable: ' + e.message });
  }

  const existing = db.getPushSubs.all(req.userId);
  if (existing.length >= MAX_DEVICES && !existing.some((s) => s.endpoint === endpoint)) {
    // Oldest first — the one most likely to be a device they no longer use.
    db.deletePushSub.run(existing.sort((a, b) => a.created_at.localeCompare(b.created_at))[0].endpoint);
  }

  db.addPushSub.run({
    endpoint,
    clerk_user_id: req.userId,
    p256dh: String(p256dh),
    auth: String(auth),
    ua: (req.headers['user-agent'] || '').slice(0, 200),
    standalone: sub.standalone ? 1 : 0,
  });
  res.json({ ok: true, devices: db.getPushSubs.all(req.userId).length });
});

// DELETE /api/cloud/push/subscribe   Body: { endpoint } — or all of them.
router.delete('/subscribe', requireUser, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) {
    const mine = db.getPushSubs.all(req.userId).find((s) => s.endpoint === endpoint);
    if (!mine) return res.status(404).json({ error: 'No such device' });
    db.deletePushSub.run(endpoint);
  } else {
    db.deletePushSubsForUser.run(req.userId);
  }
  res.json({ ok: true, devices: db.getPushSubs.all(req.userId).length });
});

// GET /api/cloud/push — what this account has registered.
router.get('/', requireUser, (req, res) => {
  res.json({
    enabled: enabled(),
    devices: db.getPushSubs.all(req.userId).map((s) => ({
      // The endpoint is a bearer capability for that device; a stable short id
      // is enough for a UI that only ever needs to list and remove.
      id: s.endpoint.slice(-12),
      standalone: !!s.standalone,
      created_at: s.created_at,
      last_sent_at: s.last_sent_at,
    })),
  });
});

// POST /api/cloud/push/test — prove the whole chain to the person setting it up.
router.post('/test', requireUser, async (req, res) => {
  const sent = await notify(req.userId, {
    title: 'Terse',
    body: 'Notifications are working.',
    tag: 'terse-test',
    url: '/m',
  });
  res.json({ ok: sent.sent > 0, ...sent });
});

/**
 * Send to every device an account has registered.
 *
 * Never throws and never rejects: this is called from request handlers whose own
 * job must still succeed. A knock is recorded whether or not the owner's phone
 * could be reached.
 */
async function notify(userId, message) {
  if (!enabled()) return { sent: 0, skipped: 'not configured' };
  const subs = db.getPushSubs.all(userId);
  if (!subs.length) return { sent: 0, skipped: 'no devices' };

  const payload = JSON.stringify({
    title: message.title || 'Terse',
    body: message.body || '',
    tag: message.tag || 'terse',
    url: message.url || '/m',
  });

  let sent = 0, gone = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await webpush.send(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: SUBJECT },
      );
      if (r.ok) { sent++; db.touchPushSub.run(s.endpoint); return; }
      // 404/410 is the push service telling us this device is gone for good.
      // Keeping it would mean retrying a dead endpoint forever.
      if (r.gone) { gone++; db.deletePushSub.run(s.endpoint); return; }
      failed++;
      db.failPushSub.run(s.endpoint);
    } catch (e) {
      failed++;
      try { db.failPushSub.run(s.endpoint); } catch { /* not worth cascading */ }
    }
  }));

  return { sent, gone, failed };
}

module.exports = router;
module.exports.notify = notify;
module.exports.enabled = enabled;
module.exports.MAX_DEVICES = MAX_DEVICES;
