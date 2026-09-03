/**
 * wallstamp.js — the live numbers, drawn onto a frame the phone captured.
 *
 * WHY THIS EXISTS. The ring holds stills, so the numbers on somebody's Home
 * Screen are only as fresh as their last capture — and the only moment the web
 * app can capture is while it is open. An agent that started an hour ago was
 * not on the wallpaper until they next opened Terse.
 *
 * WHY NOT RE-RENDER THE FIELD HERE. That was tried and removed. The field is
 * WebGL, a server has no GPU, and under software rendering it is not close:
 * measured at 144 seconds for twelve frames. Chromium also adds ~400MB to the
 * image, which is why nixpacks.toml omits puppeteer on purpose.
 *
 * So the expensive half and the changing half are split. The particle field —
 * the part that is slow, and the part that carries the user's own style, bed
 * and Pro entitlement — is captured once by the phone. The numbers are drawn
 * over it here. Measured on a real 1290x2796 frame: 676ms the first time,
 * almost all of it re-encoding the JPEG, and 0.5ms once cached — so a burst of
 * twenty fetches walks twelve frames and pays for twelve renders, once.
 *
 * ⚠ WHAT THIS COSTS, said plainly: the stamped numbers are TYPE, not particles.
 * The glyph text the engine forms out of the field is still there from the
 * capture; this sits alongside it and is unmistakably drawn. That is the trade
 * for numbers that are never stale.
 */
'use strict';

/* Loaded lazily and tolerated when missing. sharp is a native module, and a
 * deploy where it failed to build must still serve wallpapers — an unstamped
 * frame is the old behaviour, which was fine. A hard require at the top would
 * turn a broken optional dependency into a dead endpoint. */
let sharp = null;
let sharpTried = false;
function getSharp() {
  if (!sharpTried) {
    sharpTried = true;
    try { sharp = require('sharp'); } catch { sharp = null; }
  }
  return sharp;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function short(v) {
  const n = Number(v) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

/**
 * What to say. Empty when there is nothing worth saying — an account with no
 * linked desktop gets its frame untouched rather than a row of zeroes, because
 * a wallpaper that permanently reads "0 tokens · 0 agents" is worse than one
 * that simply does not mention it.
 */
function lineFor(frame) {
  if (!frame) return null;
  const s = frame.stats || {};
  const sessions = Array.isArray(frame.sessions) ? frame.sessions : [];
  const live = sessions.filter((a) => a && a.connected !== false);
  const today = Number(s.tokens_today) || Number(s.tokensIn) || 0;
  const saved = Number(s.tokens_saved) || Number(s.tokensSaved) || 0;
  if (!live.length && !today && !saved) return null;

  const bits = [];
  if (live.length) bits.push(live.length + (live.length === 1 ? ' agent' : ' agents'));
  if (today) bits.push(short(today) + ' today');
  if (saved) bits.push(short(saved) + ' saved');
  return bits.join('  ·  ');
}

/** How stale the snapshot is, in words, so a dead link cannot look live. */
function agoFor(frame) {
  const at = frame && frame.at ? Number(frame.at) : 0;
  if (!at) return '';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.floor(mins / 60);
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

/**
 * The overlay, as SVG.
 *
 * ⚠ FONTS ARE NOT GUARANTEED. sharp renders SVG through resvg, which resolves
 * families against the fonts installed in the container — and a slim Node image
 * ships none, in which case text renders as nothing at all. The family list
 * ends in the generic `sans-serif` so that whatever single font is installed is
 * used, and nixpacks installs one explicitly. Absent that, this draws a blank
 * layer over the frame, which is why the caller checks that a font is present
 * before compositing at all.
 */
function svgFor(w, h, line, ago) {
  // Sized from the frame, not fixed: these are captured at whatever the
  // phone's screen is, from an SE to a Pro Max.
  const pad = Math.round(w * 0.07);
  const size = Math.max(20, Math.round(w * 0.042));
  const small = Math.round(size * 0.62);
  /* Above the dock and below the last row of icons. The engine places its own
     glyphs away from the centre and towards the upper half, so this sits low
     to avoid landing on top of them. */
  const y = Math.round(h * 0.775);
  const fam = '-apple-system, BlinkMacSystemFont, &quot;Helvetica Neue&quot;, Helvetica, Arial, sans-serif';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <filter id="s" x="-30%" y="-60%" width="160%" height="220%">
      <feDropShadow dx="0" dy="0" stdDeviation="${Math.round(size * 0.5)}"
                    flood-color="#000" flood-opacity="0.75"/>
    </filter>
  </defs>
  <g filter="url(#s)" font-family="${fam}">
    <text x="${pad}" y="${y}" fill="#F2F5F4" font-size="${size}"
          font-weight="600" letter-spacing="${(size * 0.01).toFixed(2)}">${esc(line)}</text>
    ${ago ? `<text x="${pad}" y="${y + Math.round(size * 1.35)}" fill="#9FB3AC"
          font-size="${small}" font-weight="500">${esc(ago)}</text>` : ''}
  </g>
</svg>`, 'utf8');
}

/* CAN THIS CONTAINER DRAW TEXT AT ALL?
 *
 * resvg silently renders nothing when no font resolves, so a container without
 * fonts would re-encode every frame to paint an invisible layer — slower, and
 * indistinguishable from the feature being off. Asked once, by rendering a
 * glyph on a black square and looking for a lit pixel. */
let canText = null;
async function fontsWork() {
  if (canText != null) return canText;
  const s = getSharp();
  if (!s) return (canText = false);
  try {
    const probe = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">' +
      '<text x="2" y="40" font-size="44" font-family="sans-serif" fill="#fff">8</text></svg>', 'utf8');
    const raw = await s({ create: { width: 48, height: 48, channels: 3, background: '#000' } })
      .composite([{ input: probe, top: 0, left: 0 }]).raw().toBuffer();
    let lit = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 96) lit++;
    canText = lit > 20;                       // a drawn "8" is far more than this
  } catch { canText = false; }
  return canText;
}

/**
 * Draw the current numbers onto a captured frame.
 *
 * Never throws and never returns nothing: every failure path hands back the
 * original bytes. A wallpaper that is one capture out of date is a small
 * problem; a wallpaper that 500s is the feature not working.
 */
/* Composited results, keyed by the frame's bytes and the words drawn on them.
 *
 * ⚠ THE ENCODE IS THE COST, AND IT IS NOT SMALL. Measured on a real captured
 * frame: 1.4 seconds, almost all of it re-encoding the JPEG — not the tens of
 * milliseconds compositing suggests. The burst loop fetches every two seconds
 * for forty, so stamping per request would keep a core busy for most of a
 * burst, per phone.
 *
 * The words only change when the desktop's numbers do, so the same frame and
 * the same line composite to the same bytes and are worth keeping. A burst of
 * twenty fetches walks twelve frames and pays for twelve renders, once. */
const CACHE = new Map();
const CACHE_MAX = 64;                 // ~12 frames each for a handful of accounts

function cacheKey(imageBuf, line, ago) {
  return require('crypto').createHash('sha1')
    .update(imageBuf).update('\u0000').update(line).update('\u0000').update(ago || '')
    .digest('base64');
}

async function stamp(imageBuf, frame) {
  const s = getSharp();
  if (!s || !Buffer.isBuffer(imageBuf) || !imageBuf.length) return imageBuf;
  const line = lineFor(frame);
  if (!line) return imageBuf;

  if (!(await fontsWork())) return imageBuf;

  const ago = agoFor(frame);
  const key = cacheKey(imageBuf, line, ago);
  const hit = CACHE.get(key);
  if (hit) {
    // Re-inserted so the map stays in least-recently-used order.
    CACHE.delete(key); CACHE.set(key, hit);
    return hit;
  }

  try {
    const meta = await s(imageBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return imageBuf;

    const out = await s(imageBuf)
      .composite([{ input: svgFor(w, h, line, agoFor(frame)), top: 0, left: 0 }])
      // Re-encoded as JPEG at the quality the phone already uses: the frames
      // are JPEG, a wallpaper has no alpha to keep, and PNG here would triple
      // the bytes over a cellular connection for nothing.
      /* mozjpeg off on purpose: it is meaningfully slower for a few percent of
         size, and this runs on a request a phone is waiting on. */
      .jpeg({ quality: 90, mozjpeg: false })
      .toBuffer();

    CACHE.set(key, out);
    if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    return out;
  } catch {
    return imageBuf;
  }
}

module.exports = { stamp, lineFor, agoFor, svgFor };
module.exports.available = () => !!getSharp();
module.exports.fontsWork = fontsWork;
