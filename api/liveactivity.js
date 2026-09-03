/**
 * liveactivity.js — the Dynamic Island, without shipping an iOS app.
 *
 * WHY THIS EXISTS. A Live Activity can only be created by ActivityKit, which is
 * a native framework: the web app cannot start one, and no amount of work on
 * our side changes that. The only ways to get agent activity into the Island
 * are to ship a native app, or to send it to somebody else's app that has
 * already done the ActivityKit work and exposes it over HTTP.
 *
 * This is the second one. The user installs a relay app once, pastes a key, and
 * from then on THIS SERVER pushes straight to their Island — no App Store
 * submission on our side, no review, no waiting.
 *
 * WHAT IT COSTS THE USER, said plainly because it is somebody else's product:
 * the relay is a third-party app with its own free tier and its own paid plans,
 * and the Live Activity carries the relay's branding, not ours. Nothing here
 * runs unless a key is pasted, and every other route works exactly as before
 * without one — same rule as pushcut.js next door.
 *
 * ⚠ THE KEY IS THE CREDENTIAL. Stored whole because it must be replayed
 * verbatim, never returned to a client; only a masked form is.
 */
const express = require('express');
const db = require('./db');
const link = require('./link');

const router = express.Router();

/**
 * The relays, and the exact shape each one wants.
 *
 * An allow-list rather than a URL the user pastes. "Give us a URL and we will
 * POST your agent data to it" is server-side request forgery with a text field
 * in front — the same reason pushcut.js pins its host.
 */
const PROVIDERS = {
  activitysmith: {
    label: 'ActivitySmith',
    /* PUT to a stable stream key both creates and updates: the relay keeps the
       activity's identity, so this server does not have to remember whether one
       is already running. Which matters — the alternative is a create/update
       state machine that gets out of step the first time a request is lost. */
    url: (streamKey) => `https://activitysmith.com/api/live-activity/stream/${encodeURIComponent(streamKey)}`,
    method: 'PUT',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: (frame) => ({
      type: 'stats',
      title: 'Terse',
      metrics: metricsFor(frame),
    }),
    endUrl: (streamKey) => `https://activitysmith.com/api/live-activity/stream/${encodeURIComponent(streamKey)}`,
    endMethod: 'DELETE',
  },
};

/** The floor between two pushes.
 *
 *  The desktop sends a frame every three seconds while an agent works. iOS
 *  animates every Live Activity update, and pushing faster than the animation
 *  cycle drops frames and makes the pill jitter — and a relay's free tier is
 *  metered in updates per month, so relaying each frame would exhaust it in an
 *  afternoon. Ten seconds still reads as live. */
const MIN_GAP_MS = 10 * 1000;

/** The three numbers worth a glance, from the same snapshot the wallpaper uses.
 *  Kept to three because the Island shows that many before it starts eliding. */
function metricsFor(frame) {
  const s = (frame && frame.stats) || {};
  const sessions = (frame && frame.sessions) || [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const short = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v)));
  const running = sessions.filter((x) => x && x.connected !== false).length;
  return [
    { label: 'Agents', value: String(running) },
    { label: 'Today', value: short(n(s.tokens_today)) },
    { label: 'Saved', value: short(n(s.tokens_saved)) },
  ];
}

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
  if (!row) return { configured: false, providers: Object.keys(PROVIDERS) };
  return {
    configured: true,
    enabled: !!row.enabled,
    provider: row.provider,
    label: (PROVIDERS[row.provider] || {}).label || row.provider,
    hint: '…' + String(row.api_key).slice(-4),
    last_pushed_at: row.last_pushed_at,
    push_count: row.push_count || 0,
    last_error: row.last_error || null,
    providers: Object.keys(PROVIDERS),
  };
}

router.get('/', requireUser, (req, res) => {
  res.json(shape(db.getLiveActivity.get(req.userId)));
});

router.put('/', requireUser, (req, res) => {
  const provider = (req.body?.provider || 'activitysmith').toString();
  if (!PROVIDERS[provider]) {
    return res.status(400).json({ error: 'Unknown provider', providers: Object.keys(PROVIDERS) });
  }
  const apiKey = (req.body?.api_key || '').toString().trim();
  // Short enough to be a typo, long enough to be a key. Checking here turns
  // "the Island never appears" later into a mistake caught where it was made.
  if (apiKey.length < 12 || apiKey.length > 512) {
    return res.status(400).json({ error: 'That does not look like an API key' });
  }
  /* The stream key is derived, not chosen. It identifies THIS user's one
     activity at the relay: a per-user constant means a second Terse device
     updates the same pill instead of stacking up a second one. */
  const streamKey = 'terse-' + require('crypto')
    .createHash('sha256').update(String(req.userId)).digest('hex').slice(0, 16);
  db.setLiveActivity.run({
    clerk_user_id: req.userId, provider, api_key: apiKey, stream_key: streamKey,
  });
  res.json(shape(db.getLiveActivity.get(req.userId)));
});

router.delete('/', requireUser, async (req, res) => {
  // Dismiss the pill before forgetting how to reach it, or it sits on the
  // user's Lock Screen with no way left to take it down.
  await end(req.userId).catch(() => {});
  db.deleteLiveActivity.run(req.userId);
  res.json({ configured: false, providers: Object.keys(PROVIDERS) });
});

// Pushes now, ignoring the rate limit, so somebody setting this up gets an
// answer instead of a wait.
router.post('/test', requireUser, async (req, res) => {
  res.json(await push(req.userId, {
    stats: { tokens_today: 12400, tokens_saved: 3100 },
    sessions: [{ name: 'test', connected: true }],
  }, { force: true }));
});

/**
 * Send the current frame to the user's Island.
 *
 * Never throws: this is called from the desktop's push handler, whose own job
 * must still succeed. A frame is stored whether or not a phone could be
 * reached — the wallpaper does not depend on somebody else's server being up.
 */
async function push(userId, frame, opts = {}) {
  const row = db.getLiveActivity.get(userId);
  if (!row || !row.enabled) return { pushed: false, reason: 'not configured' };
  const p = PROVIDERS[row.provider];
  if (!p) return { pushed: false, reason: 'unknown provider' };

  if (!opts.force && row.last_pushed_at) {
    const last = Date.parse(row.last_pushed_at.replace(' ', 'T') + 'Z');
    if (last && Date.now() - last < MIN_GAP_MS) return { pushed: false, reason: 'too soon' };
  }

  try {
    const res = await fetch(p.url(row.stream_key), {
      method: p.method,
      headers: p.headers(row.api_key),
      body: JSON.stringify(p.body(frame)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = `HTTP ${res.status}`;
      db.failLiveActivity.run(detail, userId);
      return { pushed: false, reason: detail };
    }
    db.pushedLiveActivity.run(userId);
    return { pushed: true };
  } catch (e) {
    const detail = (e && e.message) ? e.message.slice(0, 120) : 'unreachable';
    try { db.failLiveActivity.run(detail, userId); } catch { /* not worth cascading */ }
    return { pushed: false, reason: detail };
  }
}

/** Take the pill down. Used when the user disconnects the relay. */
async function end(userId) {
  const row = db.getLiveActivity.get(userId);
  if (!row) return { ended: false, reason: 'not configured' };
  const p = PROVIDERS[row.provider];
  if (!p || !p.endUrl) return { ended: false, reason: 'unsupported' };
  const res = await fetch(p.endUrl(row.stream_key), {
    method: p.endMethod,
    headers: p.headers(row.api_key),
    signal: AbortSignal.timeout(8000),
  });
  return { ended: res.ok };
}

module.exports = router;
module.exports.push = push;
module.exports.end = end;
module.exports.MIN_GAP_MS = MIN_GAP_MS;
module.exports.PROVIDERS = PROVIDERS;
