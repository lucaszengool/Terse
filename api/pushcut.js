/**
 * pushcut.js — the one way this server can change a wallpaper itself.
 *
 * WHAT IT SOLVES. Every other route here waits for the user: a Shortcuts
 * automation fires when they open an app or unlock the phone, because iOS has
 * no periodic background trigger and no API any server can call. So the
 * wallpaper is fresh when they pick the phone up, and stale in between.
 *
 * Pushcut's Automation Server runs a shortcut in response to an HTTPS request.
 * That inverts it: Terse can refresh the wallpaper the moment an agent starts
 * burning tokens, rather than the next time somebody happens to unlock. It is
 * the closest thing to a push channel for wallpaper that exists on iOS.
 *
 * WHY IT IS OPTIONAL AND STAYS THAT WAY. Pushcut is a third-party paid app, and
 * its Automation Server only runs while its app is open or the device is
 * charging. Making it a dependency would mean the headline feature of Terse
 * required buying somebody else's app. Nothing here runs unless the user pastes
 * a URL, and every other route works exactly as before without it.
 *
 * THE URL IS THE CREDENTIAL. It is of the form
 *     https://api.pushcut.io/<secret>/execute?shortcut=<name>
 * — the path IS the secret. Stored whole because it must be replayed verbatim,
 * and never returned to a client; only a masked form is.
 */
const express = require('express');
const db = require('./db');
const link = require('./link');

const router = express.Router();

/** Pushcut's own host, and nothing else. Without this, "paste a URL and we will
 *  call it" is a server-side request forgery hole with a text field in front. */
const HOST = /^https:\/\/(api\.)?pushcut\.io\//i;

/** The floor between two fires. The desktop pushes a frame every few seconds
 *  while an agent works; relaying each one would hammer Pushcut, drain the
 *  phone, and make the wallpaper flicker. A minute feels live and stays cheap. */
const MIN_GAP_MS = 60 * 1000;

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

/** Enough to know it is set and working, never enough to replay it. */
function shape(row) {
  if (!row) return { configured: false };
  let name = null;
  try { name = new URL(row.url).searchParams.get('shortcut'); } catch { /* ignore */ }
  return {
    configured: true,
    enabled: !!row.enabled,
    shortcut: name,
    hint: '…' + row.url.slice(-6),
    last_fired_at: row.last_fired_at,
    fire_count: row.fire_count || 0,
    last_error: row.last_error || null,
  };
}

router.get('/', requireUser, (req, res) => {
  res.json(shape(db.getPushcut.get(req.userId)));
});

router.put('/', requireUser, (req, res) => {
  const url = (req.body?.url || '').toString().trim();
  if (!HOST.test(url)) {
    return res.status(400).json({ error: 'That is not a Pushcut URL. It should start with https://api.pushcut.io/' });
  }
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'That is not a valid URL' }); }
  // The execute path is the only one worth calling, and checking it here turns
  // "nothing happens" later into a mistake caught where it was made.
  if (!/\/execute$/i.test(parsed.pathname)) {
    return res.status(400).json({ error: 'Use the “execute” URL from Pushcut’s Automation Server' });
  }
  db.setPushcut.run({ clerk_user_id: req.userId, url });
  res.json(shape(db.getPushcut.get(req.userId)));
});

router.delete('/', requireUser, (req, res) => {
  db.deletePushcut.run(req.userId);
  res.json({ configured: false });
});

// Fires now, ignoring the rate limit, so somebody setting this up gets an
// answer instead of a wait.
router.post('/test', requireUser, async (req, res) => {
  res.json(await fire(req.userId, { force: true }));
});

/**
 * Call the user's Pushcut server action.
 *
 * Never throws: this is called from the desktop's push handler, whose own job
 * must still succeed. A frame is stored whether or not a phone could be poked.
 */
async function fire(userId, opts = {}) {
  const row = db.getPushcut.get(userId);
  if (!row || !row.enabled) return { fired: false, reason: 'not configured' };

  if (!opts.force && row.last_fired_at) {
    const last = Date.parse(row.last_fired_at.replace(' ', 'T') + 'Z');
    if (last && Date.now() - last < MIN_GAP_MS) return { fired: false, reason: 'too soon' };
  }

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The shortcut on the phone fetches images and sets a wallpaper, which
      // takes seconds; this call is made from inside a request that must not
      // wait for any of it.
      body: JSON.stringify({ nowait: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = `HTTP ${res.status}`;
      db.failPushcut.run(detail, userId);
      return { fired: false, reason: detail };
    }
    db.firePushcut.run(userId);
    return { fired: true };
  } catch (e) {
    // Commonest cause by far is the Automation Server not running, which is
    // worth surfacing verbatim: it is the user's to fix, and the app shows it.
    const detail = (e && e.message) ? e.message.slice(0, 120) : 'unreachable';
    try { db.failPushcut.run(detail, userId); } catch { /* not worth cascading */ }
    return { fired: false, reason: detail };
  }
}

module.exports = router;
module.exports.fire = fire;
module.exports.MIN_GAP_MS = MIN_GAP_MS;
