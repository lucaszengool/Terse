/**
 * Device links — the bridge between a desktop Terse and the phone web app.
 *
 * WHY IT IS NOT THE TEAM CHANNEL. The desktop already ships agent snapshots to
 * the cloud, but every one of those calls is gated on a configured TEAM token
 * (cowork.rs `is_active()`), and a person putting their own wallpaper on their
 * own phone has no team. Reusing that path would have meant inventing a team of
 * one, with a dashboard and members and an owner, for a feature that is really
 * "this Mac, that phone".
 *
 * THE TWO CREDENTIALS ARE DELIBERATELY DIFFERENT.
 *   · The DESKTOP holds a secret, stored hashed, exactly like a room key or a
 *     team token. It never signs in; it is a machine.
 *   · The PHONE is identified by its Clerk account, because the phone app
 *     requires sign-in anyway and an account is the only thing that survives a
 *     cleared Safari. Keying the phone by a localStorage secret would have made
 *     "clear website data" silently unpair every device.
 *
 * NOTHING IS PERSISTED BUT THE LATEST FRAME. Same rule as the room log: the
 * wallpaper renders what is happening NOW. A desktop that has been shut for a
 * week must show as idle, not replay a week-old field, so the snapshot is a
 * single column that gets overwritten and carries its own timestamp.
 *
 * Mounted at /api/cloud/link.
 */
const express = require('express');
const crypto = require('crypto');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const db = require('./db');
const bus = require('./cowork-bus');

const router = express.Router();

const CLERK_JWKS = createRemoteJWKSet(new URL('https://clerk.terseai.org/.well-known/jwks.json'));
const CLERK_ISSUER = 'https://clerk.terseai.org';

const uuid = () => crypto.randomUUID();
const hash = (raw) => crypto.createHash('sha256').update(raw.toString()).digest('hex');
const chan = (linkId) => `link:${linkId}`;
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

/** How long a scannable code stays scannable. Short on purpose: it is six
 *  characters, so its safety is its lifetime, not its entropy. */
const PAIR_TTL_MS = 10 * 60 * 1000;

/** A snapshot older than this is stale — the desktop pushes every few seconds,
 *  so anything past a minute means the app is closed or the machine is asleep.
 *  The phone uses this to say "connected" versus "sleeping" honestly. */
const FRESH_MS = 90 * 1000;

/** Code alphabet with no O/0/I/1: these get read off a screen and typed by hand. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  const b = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[b[i] % ALPHABET.length];
  return out;
}

// ── Credentials ────────────────────────────────────────────────────────────

/** Resolve a Clerk session token to a user id. Split out as its own function so
 *  the integration test can swap it — every other route in here is worth testing
 *  and none of it is reachable without a signature only Clerk can produce. */
async function verifyUser(raw) {
  const { payload } = await jwtVerify(raw.toString(), CLERK_JWKS, { issuer: CLERK_ISSUER });
  return payload.sub;
}

/** The phone. Requires a real Clerk session — the app is sign-in gated. */
async function requireUser(req, res, next) {
  const header = req.headers.authorization;
  // EventSource cannot set headers, so the stream route passes it as a query
  // parameter; every other route uses the Authorization header.
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!raw) return res.status(401).json({ error: 'Sign in to link a device' });
  try {
    req.userId = await module.exports.verifyUser(raw);
    if (!req.userId) throw new Error('no subject');
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — sign in again' });
  }
}

/** The desktop. Its secret arrives in a header of its own so it can never be
 *  confused with a room key or a team token by a misconfigured client. */
function requireDevice(req, res, next) {
  const secret = req.headers['x-terse-device'] || req.query.device;
  if (!secret) return res.status(401).json({ error: 'Missing device secret' });
  const link = db.findLinkBySecret.get(hash(secret));
  if (!link) return res.status(401).json({ error: 'Unknown device' });
  req.link = link;
  next();
}

function publicLink(link) {
  const at = link.snapshot_at ? Date.parse(link.snapshot_at + 'Z') : 0;
  return {
    id: link.id,
    device: link.device || 'mac',
    name: link.device_name || null,
    linked_at: link.linked_at || null,
    // "Linked" is a fact about pairing; "live" is a fact about right now. The
    // phone shows a different thing for each, so both travel.
    live: !!at && (Date.now() - at) < FRESH_MS,
    snapshot_at: link.snapshot_at || null,
  };
}

function parseSnapshot(link) {
  if (!link.snapshot) return null;
  try { return JSON.parse(link.snapshot); } catch { return null; }
}

// ── Desktop side ───────────────────────────────────────────────────────────

// POST /api/cloud/link/pair   Body: { device?, name? }
// Called by the desktop. Returns the secret it keeps forever and the short code
// it renders as a QR. Sweeping happens here because this is the only route that
// creates litter, and it is called rarely.
router.post('/pair', (req, res) => {
  try { db.sweepPairCodes.run(); } catch { /* best effort */ }

  const device = ['mac', 'windows'].includes(req.body?.device) ? req.body.device : 'mac';
  const secret = crypto.randomBytes(32).toString('hex');
  const id = uuid();

  // A collision on a 32-character alphabet is vanishingly unlikely, but the
  // column is UNIQUE and an INSERT that throws would surface as a 500 on the
  // one action that must never look broken. Retrying is two lines.
  let code = null;
  for (let i = 0; i < 5 && !code; i++) {
    const attempt = makeCode();
    try {
      db.createDeviceLink.run({
        id,
        secret_hash: hash(secret),
        pair_code: attempt,
        pair_expires_at: new Date(Date.now() + PAIR_TTL_MS).toISOString().replace('T', ' ').slice(0, 19),
        device,
        device_name: clip((req.body?.name || '').toString().trim(), 60) || null,
      });
      code = attempt;
    } catch (e) {
      if (i === 4) return res.status(500).json({ error: 'Could not create a pair code' });
    }
  }

  res.json({
    id,
    code,
    secret,
    expires_in: Math.round(PAIR_TTL_MS / 1000),
    // Handed back rather than assembled on the desktop so the QR payload and
    // the page that redeems it can never drift apart.
    url: `https://www.terseai.org/m/pair?c=${code}`,
  });
});

// GET /api/cloud/link/status   Header: x-terse-device
// The desktop polls this while showing the QR, and afterwards to render "Linked
// to iPhone" in its own settings.
router.get('/status', requireDevice, (req, res) => {
  res.json({
    linked: !!req.link.clerk_user_id,
    id: req.link.id,
    device: req.link.device,
    name: req.link.device_name || null,
    linked_at: req.link.linked_at || null,
    // Whether anyone is actually looking. The desktop uses this to stop pushing
    // to a phone that is not open — there is no point burning a request every
    // few seconds for a screen nobody is holding.
    watching: bus.subscriberCount(chan(req.link.id)) > 0,
  });
});

// POST /api/cloud/link/push   Header: x-terse-device   Body: { stats, sessions }
// One live frame. The shapes are exactly what the wallpaper's own pollMeta()
// consumes, so the phone can render it with the same code the desktop uses.
router.post('/push', requireDevice, (req, res) => {
  if (!req.link.clerk_user_id) return res.status(409).json({ error: 'Device is not linked to a phone yet' });

  const sessions = Array.isArray(req.body?.sessions) ? req.body.sessions.slice(0, 12) : [];
  const frame = {
    stats: req.body?.stats && typeof req.body.stats === 'object' ? req.body.stats : {},
    sessions,
    device: req.link.device,
    name: req.link.device_name || null,
    at: Date.now(),
  };

  const json = JSON.stringify(frame);
  // A frame is a dozen agents and their last few log lines — kilobytes. This
  // limit sits deliberately UNDER the global express.json() ceiling of 100kb so
  // that an oversized push fails HERE, with a JSON error a client can read,
  // rather than as body-parser's HTML error page. Raising the parser's limit
  // without raising this one would make this check unreachable again.
  if (json.length > 64 * 1024) return res.status(413).json({ error: 'Frame too large' });

  db.setLinkSnapshot.run({ id: req.link.id, snapshot: json });
  bus.emit(chan(req.link.id), { type: 'frame', ...frame });
  res.json({ ok: true, watching: bus.subscriberCount(chan(req.link.id)) > 0 });

  /* Poke the phone's wallpaper, if the user set Pushcut up.
   *
   * The only path by which a wallpaper changes without the user doing something
   * first — everywhere else waits for them to unlock or open an app. Fired
   * AFTER the response and never awaited: the frame is stored whether or not a
   * phone could be reached, and the desktop must not wait on a round-trip to
   * somebody else's server.
   *
   * Only when an agent is actually working. An idle machine pushes frames too,
   * and refreshing the wallpaper to show the same zeroes would spend the rate
   * limit that a real burst of activity needs. */
  try {
    const busy = sessions.some((s) => s && s.connected !== false && (+s.burnRate || 0) > 0);
    if (busy) require('./pushcut').fire(req.link.clerk_user_id).catch(() => {});
  } catch { /* a frame must never fail because of a notification */ }
});

// POST /api/cloud/link/notify   Header: x-terse-device   Body: { title, body, tag, url }
// The desktop asking for the phone to be interrupted.
//
// The DESKTOP decides, not this server. It already knows when an agent is
// blocked on approval or a budget is about to break — that logic lives in
// circuit.rs and approvals.rs, and re-deriving it here from a snapshot would be
// a second, worse copy of it that disagrees at the edges.
router.post('/notify', requireDevice, async (req, res) => {
  if (!req.link.clerk_user_id) return res.status(409).json({ error: 'Device is not linked to a phone yet' });
  const push = require('./push');
  const clip2 = (v, n) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
  const title = clip2(req.body?.title, 60) || 'Terse';
  const body = clip2(req.body?.body, 160);
  if (!body) return res.status(400).json({ error: 'Nothing to say' });

  const result = await push.notify(req.link.clerk_user_id, {
    title,
    body,
    // Tagged by kind so a second budget warning REPLACES the first on the lock
    // screen instead of stacking up behind it.
    tag: clip2(req.body?.tag, 40) || 'terse-agent',
    url: '/m',
  });
  res.json({ ok: true, ...result });
});

// ── Phone side ─────────────────────────────────────────────────────────────

// POST /api/cloud/link/claim   Body: { code }
// The phone redeems a scanned code. The UPDATE is conditional on the row still
// being unclaimed, so two phones scanning the same screen cannot both win.
router.post('/claim', requireUser, (req, res) => {
  const code = (req.body?.code || '').toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const link = db.findLinkByCode.get(code);
  if (!link) return res.status(404).json({ error: 'That code has expired or was already used' });

  const r = db.claimDeviceLink.run({ id: link.id, clerk_user_id: req.userId });
  if (!r.changes) return res.status(409).json({ error: 'That code was just used on another phone' });

  res.json({ ok: true, link: publicLink(db.findLinkBySecret.get(link.secret_hash)) });
});

// GET /api/cloud/link   →  every desktop this account has paired, plus the
// newest frame among them. The phone calls this on open and on resume.
router.get('/', requireUser, (req, res) => {
  const links = db.listLinksForUser.all(req.userId);
  // Newest frame wins when someone pairs both a Mac and a PC: the wallpaper
  // shows one field, and the machine that is actually working is the one with
  // the most recent push.
  let best = null;
  for (const l of links) {
    const at = l.snapshot_at ? Date.parse(l.snapshot_at + 'Z') : 0;
    if (at && (!best || at > best.at)) best = { at, link: l };
  }
  res.json({
    linked: links.length > 0,
    devices: links.map(publicLink),
    frame: best ? parseSnapshot(best.link) : null,
  });
});

// GET /api/cloud/link/stream?token=<clerk jwt>
// EventSource cannot set headers, hence the query token — the same shape the
// cowork stream already uses.
router.get('/stream', requireUser, (req, res) => {
  const links = db.listLinksForUser.all(req.userId);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let best = null;
  for (const l of links) {
    const at = l.snapshot_at ? Date.parse(l.snapshot_at + 'Z') : 0;
    if (at && (!best || at > best.at)) best = { at, link: l };
  }
  res.write(`data: ${JSON.stringify({
    type: 'snapshot',
    devices: links.map(publicLink),
    frame: best ? parseSnapshot(best.link) : null,
  })}\n\n`);

  // Subscribing to every paired desktop rather than one: which machine is busy
  // is not the phone's business, and a person with a Mac and a PC should see
  // whichever is running without picking one.
  const offs = links.map((l) => bus.subscribe(chan(l.id), res));
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); offs.forEach((off) => off()); });
});

// DELETE /api/cloud/link/:id — unpair from the phone. The desktop's secret dies
// with the row, so a machine you no longer own cannot keep pushing to you.
router.delete('/:id', requireUser, (req, res) => {
  const mine = db.listLinksForUser.all(req.userId).find((l) => l.id === req.params.id);
  if (!mine) return res.status(404).json({ error: 'No such device' });
  db.deleteDeviceLink.run(mine.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.FRESH_MS = FRESH_MS;
module.exports.verifyUser = verifyUser;
