/**
 * The phone wallpaper — getting the real particle field onto the actual iPhone
 * Home Screen, not just inside the app.
 *
 * WHY IT WORKS THIS WAY, AND WHY IT CANNOT WORK ANY BETTER. There is no web API
 * for setting an iPhone's wallpaper, and there is no public API for a native app
 * either — even wallpaper apps on the App Store save to Photos and ask the user
 * to pick the file by hand. The one route that puts a picture on the Home Screen
 * without a person tapping through Settings is an iOS **Shortcuts automation**:
 * `Get Contents of URL` → `Set Wallpaper`. Shortcuts sends no headers and can
 * sign nothing, so the URL itself has to be the credential — hence a per-account
 * token, rotatable, separate from the account id.
 *
 * And iOS will only take a STILL image that way. Live wallpapers are Live
 * Photos, they animate on the Lock Screen only (the Home Screen always shows a
 * frozen frame), and Shortcuts cannot set one.
 *
 * ⚠ AND A BUILT LIVE PHOTO MAY NOT ANIMATE AT ALL. An Apple DTS engineer, on
 * Live Photos created through PHLivePhoto rather than captured by the camera:
 * they show "Motion not available" and can only be set as a still, there are
 * "undocumented requirements", and the advice is not to reverse-engineer it
 * (developer.apple.com/forums/thread/798044). That applies to native apps too,
 * so the mp4 route here is offered with that stated rather than promised.
 *
 * WHAT IS ACHIEVABLE, AND IS WHAT THIS DOES: the frames are captured BY THE
 * PHONE out of the live engine — real particles, real glyph text, the user's own
 * style and photo and Pro entitlement — and re-set on whatever schedule the
 * automation runs. Rendering them here on the server instead would mean a
 * second, drifting implementation of a WebGL scene, drawn without any of the
 * user's settings.
 *
 * SEVERAL FRAMES, NOT ONE, because of the one route that does produce movement.
 * Photo Shuffle can cycle a whole ALBUM on every lock or tap. So a Shortcut that
 * loops "fetch, save to album" a handful of times ends up with an album of
 * different moments of the field, and iOS animates it for free — a wallpaper
 * that actually changes as the phone is used. That is why every fetch of the
 * public URL returns the NEXT frame rather than the same one: the Shortcut does
 * not have to know how many there are, or ask for them by number.
 *
 * Mounted at /api/cloud/wallpaper, plus the public /w/:token.png.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

/** Generous enough for a 3x Pro Max panel, small enough that one bad client
 *  cannot fill the disk. A composed 1290x2796 PNG lands around 2-4 MB. */
const MAX_BYTES = 8 * 1024 * 1024;

/** iOS scales anything larger down anyway, and past this a phone GPU starts
 *  failing the capture outright rather than returning something smaller. */
const MAX_EDGE = 3200;

/** How many moments of the field to keep.
 *
 *  Sized for the BURST LOOP, which is the closest iOS gets to a live wallpaper.
 *  A background shortcut is allowed roughly 30-60 seconds before the system
 *  stops it, so an automation running
 *
 *      Repeat 20 × [ Get Contents of URL → Set Wallpaper → Wait 2 seconds ]
 *
 *  produces about forty seconds of genuine two-second updates every time it
 *  fires. Each fetch returns the NEXT frame, so the ring has to be long enough
 *  that a burst does not visibly loop — six meant seeing the same frame three
 *  times in one run.
 *
 *  Not raised further because these are full-resolution wallpapers: at twelve
 *  an account is roughly twenty megabytes, and the capture that produces them
 *  already takes long enough to feel slow on a phone. */
const SLOTS = 12;

/* A ready-made Shortcut, so the user taps a link instead of building one.
 *
 * This CANNOT be generated. Since iOS 15 shortcuts must be signed, signing
 * cannot be done on-device or on a server, and unsigned .shortcut import was
 * removed — the only distributable form is an iCloud share link, which is
 * produced by sharing a shortcut FROM an Apple device.
 *
 * So it is built once, by hand, on an iPhone, and its link goes in the
 * environment. Empty is a supported state: the app falls back to the written
 * steps, which is what every user got before this existed. See
 * docs/phone-shortcut-setup.md.
 */
const SHORTCUT_URL = process.env.TERSE_SHORTCUT_URL || '';

/** A four-second 720-wide H.264 clip lands around 2-5 MB. */
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;

const newToken = () => crypto.randomBytes(18).toString('base64url');

function publicUrl(req, token) {
  const host = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
  return `${host}/w/${token}.png`;
}

/** Reuse link.js's Clerk verification rather than keeping a second copy of the
 *  JWKS and the issuer — one definition of "who is this" for the phone. */
const link = require('./link');

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

/** The link row, created on first ask so the setup instructions can show a real
 *  URL before any frame has been captured. */
function ensureLink(userId) {
  let row = db.getWallLink.get(userId);
  if (!row) {
    db.createWallLink.run(userId, newToken());
    row = db.getWallLink.get(userId);
  }
  return row;
}

function shape(req, userId) {
  const row = ensureLink(userId);
  const slots = db.listWallSlots.all(userId);
  const video = db.getWallVideoMeta.get(userId);
  const overlay = db.getWallOverlayMeta.get(userId);
  return {
    url: publicUrl(req, row.token),
    // The animated one. Same token, different extension — a Live Photo needs a
    // video, and Shortcuts fetches it by URL exactly like the still.
    video_url: publicUrl(req, row.token).replace(/\.png$/, '.mp4'),
    video: video ? { bytes: video.bytes, updated_at: video.updated_at } : null,
    // The transparent layer, for the Overlay Images route — the one that keeps
    // the user's own wallpaper and only adds the writing.
    overlay_url: publicUrl(req, row.token).replace(/\.png$/, '.overlay.png'),
    overlay: overlay ? { bytes: overlay.bytes, updated_at: overlay.updated_at } : null,
    slots: SLOTS,
    frames: slots.length,
    ready: slots.length > 0,
    updated_at: slots.length ? slots.map((s) => s.updated_at).sort().pop() : null,
    fetched_at: row.fetched_at,
    fetch_count: row.fetch_count || 0,
    // Only ever an icloud.com/shortcuts link — anything else here would be an
    // arbitrary URL the app invites people to tap.
    shortcut_url: /^https:\/\/(www\.)?icloud\.com\/shortcuts\//.test(SHORTCUT_URL) ? SHORTCUT_URL : null,
  };
}

// GET /api/cloud/wallpaper — the URL for the Shortcut, and how many frames exist.
router.get('/', requireUser, (req, res) => res.json(shape(req, req.userId)));

// POST /api/cloud/wallpaper?slot=N — one captured frame, as a raw PNG body.
// Raw rather than base64 in JSON: base64 inflates a 3 MB frame by a third, on a
// connection that is often cellular, for no gain.
router.post('/', requireUser, express.raw({ type: 'image/png', limit: MAX_BYTES }), (req, res) => {
  const png = req.body;
  if (!Buffer.isBuffer(png) || !png.length) {
    return res.status(400).json({ error: 'Expected a PNG body' });
  }
  // Verified rather than trusted: this buffer is served straight back to a
  // device that will treat it as an image, so the client's content type is not
  // good enough on its own.
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(SIG)) {
    return res.status(400).json({ error: 'That is not a PNG' });
  }
  // Dimensions come out of the IHDR chunk rather than a query parameter, so what
  // is reported is what was actually stored.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE) {
    return res.status(400).json({ error: 'Unusable image dimensions' });
  }

  const slot = Math.min(SLOTS - 1, Math.max(0, parseInt(req.query.slot, 10) || 0));
  ensureLink(req.userId);
  db.putWallFrame.run({
    clerk_user_id: req.userId, slot, png, width, height, bytes: png.length,
  });
  res.json(shape(req, req.userId));
});

// POST /api/cloud/wallpaper/video — the mp4 the phone encoded of its own field,
// which Shortcuts turns into a Live Photo. Raw body, same reasoning as the PNG.
router.post('/video', requireUser, express.raw({ type: 'video/mp4', limit: MAX_VIDEO_BYTES }), (req, res) => {
  const mp4 = req.body;
  if (!Buffer.isBuffer(mp4) || mp4.length < 32) {
    return res.status(400).json({ error: 'Expected an MP4 body' });
  }
  // Sniffed, not trusted: bytes 4..8 of an MP4 are the 'ftyp' box type. This is
  // served back to a device that will hand it to Photos.
  if (mp4.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return res.status(400).json({ error: 'That is not an MP4' });
  }
  ensureLink(req.userId);
  db.putWallVideo.run({
    clerk_user_id: req.userId, mp4,
    width: parseInt(req.query.w, 10) || null,
    height: parseInt(req.query.h, 10) || null,
    bytes: mp4.length,
  });
  res.json(shape(req, req.userId));
});

// POST /api/cloud/wallpaper/overlay — the transparent layer, as a raw PNG.
// Same validation as a frame; it is served back to a device that hands it to
// Shortcuts' Overlay Images action.
router.post('/overlay', requireUser, express.raw({ type: 'image/png', limit: MAX_BYTES }), (req, res) => {
  const png = req.body;
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(SIG)) {
    return res.status(400).json({ error: 'That is not a PNG' });
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE) {
    return res.status(400).json({ error: 'Unusable image dimensions' });
  }
  // Colour type 6 is RGBA. A layer meant to be composited MUST carry an alpha
  // channel — an opaque one would hide the wallpaper it is supposed to sit on,
  // and that failure only shows up on the phone, at the end of the setup.
  const colourType = png.readUInt8(25);
  if (colourType !== 6 && colourType !== 4) {
    return res.status(400).json({ error: 'The overlay has no transparency' });
  }
  ensureLink(req.userId);
  db.putWallOverlay.run({ clerk_user_id: req.userId, png, width, height, bytes: png.length });
  res.json(shape(req, req.userId));
});

// POST /api/cloud/wallpaper/rotate — new URL, old one dead immediately. The URL
// is the only credential, so burning it is the only revocation there is: it may
// have been pasted into a shared Shortcut or read off a screen.
router.post('/rotate', requireUser, (req, res) => {
  ensureLink(req.userId);
  db.rotateWallToken.run(newToken(), req.userId);
  res.json(shape(req, req.userId));
});

// DELETE /api/cloud/wallpaper — stop serving it at all.
router.delete('/', requireUser, (req, res) => {
  db.deleteWallFrames.run(req.userId);
  db.deleteWallVideo.run(req.userId);
  db.deleteWallOverlay.run(req.userId);
  db.deleteWallLink.run(req.userId);
  res.json({ ok: true, ready: false, frames: 0 });
});

/**
 * The public endpoint, mounted at /w/:token.png by server.js.
 *
 * Unauthenticated by necessity — an iOS Shortcut sends no headers and cannot
 * sign anything, so the URL is the credential. It is therefore deliberately
 * boring: one image or a 404, nothing about the account, and a wrong token is
 * indistinguishable from an account with no frames yet.
 *
 * Each fetch returns the NEXT frame. A Shortcut looping "fetch, save to album"
 * therefore collects different moments without knowing how many exist, and a
 * plain "fetch, set wallpaper" automation gets a different one each run.
 */
function serveFrame(req, res) {
  const raw = String(req.params.token || '');
  const wantsVideo = /\.mp4$/i.test(raw);
  // Checked BEFORE the plain .png suffix is stripped, since ".overlay.png" ends
  // in .png too and would otherwise be served as an ordinary frame.
  const wantsOverlay = /\.overlay\.png$/i.test(raw);
  const token = raw.replace(/\.overlay\.png$/i, '').replace(/\.(png|mp4)$/i, '');
  const row = token && db.getWallLinkByToken.get(token);
  if (!row) return res.status(404).type('text/plain').send('Not found');

  // The animated one. Served whole rather than by range: Shortcuts downloads it
  // in one go to hand to "Make Live Photo", and it is a few megabytes.
  if (wantsVideo) {
    const v = db.getWallVideo.get(row.clerk_user_id);
    if (!v || !v.mp4) return res.status(404).type('text/plain').send('Not found');
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': String(v.mp4.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': 'inline; filename="terse-wallpaper.mp4"',
    });
    return res.send(v.mp4);
  }

  if (wantsOverlay) {
    const o = db.getWallOverlay.get(row.clerk_user_id);
    if (!o || !o.png) return res.status(404).type('text/plain').send('Not found');
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(o.png.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': 'inline; filename="terse-overlay.png"',
    });
    return res.send(o.png);
  }

  const slots = db.listWallSlots.all(row.clerk_user_id);
  if (!slots.length) return res.status(404).type('text/plain').send('Not found');

  // The cursor is stored, not derived from the request, so repeated fetches
  // advance even though the URL never changes.
  const pick = slots[(row.cursor || 0) % slots.length];
  const frame = db.getWallFrame.get(row.clerk_user_id, pick.slot);
  if (!frame || !frame.png) return res.status(404).type('text/plain').send('Not found');

  res.set({
    'Content-Type': 'image/png',
    'Content-Length': String(frame.png.length),
    // Shortcuts runs on a schedule and must never be handed a cached copy: a
    // wallpaper that silently stops changing is indistinguishable from one that
    // broke, and iOS is aggressive about reusing image responses.
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    // The URL is a bearer credential; keep it out of referrers and search.
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Disposition': 'inline; filename="terse-wallpaper.png"',
  });
  // Recorded so the app can honestly say whether the automation is running —
  // "last collected 12 minutes ago" is the only feedback the user gets, since
  // the Shortcut runs invisibly.
  try { db.advanceWallCursor.run(slots.length, row.clerk_user_id); } catch { /* never fail the image */ }
  res.send(frame.png);
}

module.exports = router;
module.exports.serveFrame = serveFrame;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.SLOTS = SLOTS;
