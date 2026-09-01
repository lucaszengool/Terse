/**
 * Phone wallpaper integration tests — capture upload, the frame ring, the public
 * image endpoint, and rotation.
 *
 *   node api/wallpaper.test.js
 *
 * Clerk verification is stubbed (the token IS the user id). Everything else is
 * the real code path, including the PNG sniffing and the server-side cursor —
 * which is the part that has to be right, because an iOS Shortcut cannot ask for
 * a frame by number and relies entirely on each fetch returning the next one.
 */
const express = require('express');
const http = require('http');
const zlib = require('zlib');
const db = require('./db');
const linkRouter = require('./link');
const wallpaperRouter = require('./wallpaper');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

linkRouter.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);

const app = express();
app.use(express.json());
app.use('/api/cloud/wallpaper', wallpaperRouter);
app.get('/w/:token', wallpaperRouter.serveFrame);
const server = http.createServer(app);

/** A real, minimal PNG. Hand-built rather than pulled from a fixture so the
 *  dimensions the endpoint reads out of IHDR are known exactly. */
function png(w, h, tag, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  const ch = rgba ? 4 : 3;
  ihdr[8] = 8; ihdr[9] = rgba ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * ch));
  // A per-frame tint, so a test can tell one stored frame from another.
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * ch);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * ch] = tag & 0xff;
      if (rgba) raw[off + 1 + x * ch + 3] = 0x80;   // half-transparent
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function req(method, path, { user, body, type } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': type || 'application/json', 'Content-Length': data.length } : {}),
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
      },
    }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(bufs);
        resolve({
          status: res.statusCode, headers: res.headers, buf,
          json: (() => { try { return JSON.parse(buf.toString()); } catch { return null; } })(),
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const USER = 'user_wall_test';
const OTHER = 'user_wall_other';

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\nPhone wallpaper\n');

  // ── Auth ──
  eq('reading without a session is 401', (await req('GET', '/api/cloud/wallpaper')).status, 401);
  eq('a bad session is 401', (await req('GET', '/api/cloud/wallpaper', { user: 'bad' })).status, 401);

  // ── The URL exists before any frame does ──
  // The setup steps have to show a real link, or the user cannot build the
  // Shortcut until after a capture they have no reason to run yet.
  const first = await req('GET', '/api/cloud/wallpaper', { user: USER });
  eq('first read succeeds', first.status, 200);
  eq('and is not ready yet', first.json.ready, false);
  eq('with no frames', first.json.frames, 0);
  ok('but already has a URL', /\/w\/[A-Za-z0-9_-]{20,}\.png$/.test(first.json.url || ''));
  const url = new URL(first.json.url).pathname;

  // Nothing to serve yet — and it must not leak that the account exists.
  const early = await req('GET', url);
  eq('the public URL 404s before any capture', early.status, 404);

  // ── Uploading a burst ──
  eq('a non-PNG body is refused',
    (await req('POST', '/api/cloud/wallpaper', { user: USER, body: Buffer.from('hello'), type: 'image/png' })).status, 400);
  eq('an empty body is refused',
    (await req('POST', '/api/cloud/wallpaper', { user: USER, body: Buffer.alloc(0), type: 'image/png' })).status, 400);

  for (let i = 0; i < 3; i++) {
    const up = await req('POST', `/api/cloud/wallpaper?slot=${i}`, { user: USER, body: png(4, 8, 10 + i), type: 'image/png' });
    eq(`frame ${i} uploads`, up.status, 200);
    eq(`and the count reaches ${i + 1}`, up.json.frames, i + 1);
  }
  const after = await req('GET', '/api/cloud/wallpaper', { user: USER });
  eq('the account is ready', after.json.ready, true);

  // Dimensions are read out of IHDR, not taken from the client.
  const slots = db.listWallSlots.all(USER);
  eq('stored width comes from the image itself', slots[0].width, 4);
  eq('stored height comes from the image itself', slots[0].height, 8);

  // Out-of-range slots are clamped rather than rejected — a client that sends
  // slot=99 should overwrite the last one, not fill the disk.
  await req('POST', '/api/cloud/wallpaper?slot=99', { user: USER, body: png(4, 8, 99), type: 'image/png' });
  eq('an out-of-range slot is clamped, not appended',
    db.countWallFrames.get(USER).n, 4);

  // ── The ring: this is what Photo Shuffle depends on ──
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const r = await req('GET', url);
    eq(`fetch ${i + 1} returns an image`, r.status, 200);
    eq('served as a PNG', r.headers['content-type'], 'image/png');
    seen.push(r.buf.toString('base64'));
  }
  ok('consecutive fetches return DIFFERENT frames', new Set(seen).size === 4);
  const again = await req('GET', url);
  ok('and the ring wraps back round', again.buf.toString('base64') === seen[0]);

  // A Shortcut on a schedule must never be handed a cached copy: a wallpaper
  // that silently stops changing looks identical to one that broke.
  ok('caching is refused', /no-store/.test(again.headers['cache-control'] || ''));
  ok('and it is kept out of search', /noindex/.test(again.headers['x-robots-tag'] || ''));

  const counted = await req('GET', '/api/cloud/wallpaper', { user: USER });
  eq('fetches are counted so the app can show the automation is alive', counted.json.fetch_count, 5);
  ok('and timestamped', !!counted.json.fetched_at);

  // ── Isolation ──
  const stranger = await req('GET', '/api/cloud/wallpaper', { user: OTHER });
  eq('another account starts empty', stranger.json.frames, 0);
  ok('and gets a different URL', stranger.json.url !== counted.json.url);
  eq('a made-up token 404s', (await req('GET', '/w/not-a-real-token.png')).status, 404);

  // ── The video, which is what actually animates ──
  // A minimal but structurally real MP4: ftyp is what the endpoint sniffs for,
  // and sniffing rather than trusting the content type is the point.
  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'),
    Buffer.from('isom', 'ascii'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomavc1', 'ascii'),
    Buffer.from([0, 0, 0, 8]), Buffer.from('free', 'ascii'),
  ]);
  eq('a non-MP4 body is refused',
    (await req('POST', '/api/cloud/wallpaper/video', { user: USER, body: Buffer.alloc(64), type: 'video/mp4' })).status, 400);
  const vup = await req('POST', '/api/cloud/wallpaper/video?w=720&h=1560', { user: USER, body: mp4, type: 'video/mp4' });
  eq('the video uploads', vup.status, 200);
  ok('and is reported', !!vup.json.video);
  ok('with an .mp4 URL beside the .png one', /\.mp4$/.test(vup.json.video_url || ''));

  const vurl = new URL(vup.json.video_url).pathname;
  const got = await req('GET', vurl);
  eq('the public .mp4 serves', got.status, 200);
  eq('as video/mp4', got.headers['content-type'], 'video/mp4');
  ok('byte-identical to what was uploaded', got.buf.equals(mp4));
  ok('and uncacheable, like the still', /no-store/.test(got.headers['cache-control'] || ''));

  // The two extensions share one token but are different resources; asking for
  // the video must never fall through to a still.
  const strangerVideo = await req('GET', `/w/${new URL(stranger.json.url).pathname.split('/').pop().replace('.png', '.mp4')}`);
  eq('an account with no video 404s on .mp4', strangerVideo.status, 404);

  // ── The transparent layer, for Overlay Images ──
  // This is the route that keeps the user's OWN wallpaper: iOS exposes no way to
  // read the one they already have, so Shortcuts composites this on top of a
  // photo they pick.
  const opaque = await req('POST', '/api/cloud/wallpaper/overlay', { user: USER, body: png(4, 8, 7), type: 'image/png' });
  eq('an opaque overlay is refused', opaque.status, 400);
  ok('and says why', /transparency/.test(opaque.json.error || ''));

  const oup = await req('POST', '/api/cloud/wallpaper/overlay', { user: USER, body: png(4, 8, 9, true), type: 'image/png' });
  eq('a transparent overlay uploads', oup.status, 200);
  ok('and is reported', !!oup.json.overlay);
  ok('with its own URL', /\.overlay\.png$/.test(oup.json.overlay_url || ''));

  const opath = new URL(oup.json.overlay_url).pathname;
  const ogot = await req('GET', opath);
  eq('the overlay serves', ogot.status, 200);
  eq('as a PNG', ogot.headers['content-type'], 'image/png');
  ok('byte-identical', ogot.buf.equals(png(4, 8, 9, true)));

  // ".overlay.png" also ends in ".png", so a naive suffix strip would serve it
  // as an ordinary frame — the two must not be confusable.
  const plain = await req('GET', new URL(oup.json.url).pathname);
  ok('a plain .png is still a frame, not the overlay', !plain.buf.equals(ogot.buf));

  // ── Rotation: the URL is the only credential, so burning it is the only revocation ──
  const rotated = await req('POST', '/api/cloud/wallpaper/rotate', { user: USER });
  ok('rotating changes the URL', rotated.json.url !== counted.json.url);
  eq('the old URL stops working immediately', (await req('GET', url)).status, 404);
  eq('the new one works', (await req('GET', new URL(rotated.json.url).pathname)).status, 200);
  eq('and the frames survived rotation', rotated.json.frames, 4);

  // ── Deleting ──
  eq('delete succeeds', (await req('DELETE', '/api/cloud/wallpaper', { user: USER })).status, 200);
  eq('the image is gone', (await req('GET', new URL(rotated.json.url).pathname)).status, 404);
  eq('the video is gone too', (await req('GET', new URL(rotated.json.video_url).pathname)).status, 404);
  eq('and the overlay', (await req('GET', new URL(rotated.json.overlay_url).pathname)).status, 404);
  eq('and so are the frames', db.countWallFrames.get(USER).n, 0);

  for (const u of [USER, OTHER]) {
    try { db.deleteWallFrames.run(u); db.deleteWallVideo.run(u); db.deleteWallOverlay.run(u); db.deleteWallLink.run(u); } catch { /* already gone */ }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
