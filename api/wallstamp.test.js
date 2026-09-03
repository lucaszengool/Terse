/**
 * wallstamp tests — the live numbers drawn onto a captured frame.
 *
 *   node api/wallstamp.test.js
 *
 * The thing worth guarding here is not the drawing, it is every path that must
 * hand back the ORIGINAL bytes instead of failing. This runs on the one request
 * a phone's wallpaper depends on, so a thrown error or an empty buffer is the
 * feature breaking, while an unstamped frame is merely the old behaviour.
 */
const assert = require('assert');
const stamp = require('./wallstamp');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

const busy = {
  stats: { tokens_today: 184320, tokens_saved: 41230 },
  sessions: [{ name: 'a', connected: true }, { name: 'b', connected: true }, { name: 'c', connected: false }],
  at: Date.now() - 7 * 60 * 1000,
};

(async function run() {
  console.log('\nwallstamp\n');

  // ── What it says ──
  eq('only CONNECTED agents are counted', stamp.lineFor(busy).split('  ·  ')[0], '2 agents');
  ok('big numbers are shortened', /184\.3k today/.test(stamp.lineFor(busy)));
  ok('and so is what was saved', /41\.2k saved/.test(stamp.lineFor(busy)));
  eq('one agent is singular', stamp.lineFor({ stats: {}, sessions: [{ connected: true }] }), '1 agent');

  /* An account with nothing linked must get its frame untouched. A wallpaper
     that permanently reads "0 agents · 0 today" is worse than one that does not
     mention it at all. */
  eq('an empty account says nothing', stamp.lineFor({ stats: {}, sessions: [] }), null);
  eq('and so does a missing frame', stamp.lineFor(null), null);
  ok('but tokens alone are worth saying',
    stamp.lineFor({ stats: { tokens_today: 500 }, sessions: [] }) === '500 today');

  // ── How stale ──
  eq('fresh reads as just now', stamp.agoFor({ at: Date.now() - 5000 }), 'just now');
  eq('minutes', stamp.agoFor({ at: Date.now() - 7 * 60000 }), '7m ago');
  eq('hours', stamp.agoFor({ at: Date.now() - 3 * 3600000 }), '3h ago');
  eq('days', stamp.agoFor({ at: Date.now() - 50 * 3600000 }), '2d ago');
  eq('no timestamp says nothing rather than lying', stamp.agoFor({}), '');

  // ── The SVG is well formed and escaped ──
  const svg = stamp.svgFor(1290, 2796, 'a & b <c>', '1m ago').toString('utf8');
  ok('the layer is frame-sized', /width="1290" height="2796"/.test(svg));
  ok('markup in the numbers cannot break the document', svg.indexOf('<c>') === -1 && /&lt;c&gt;/.test(svg));
  ok('and neither can an ampersand', /a &amp; b/.test(svg));

  if (!stamp.available()) {
    console.log('\n  (sharp not installed — the compositing half is skipped)\n');
    console.log(`${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  }

  const sharp = require('sharp');
  const frame = await sharp({ create: { width: 300, height: 650, channels: 3, background: '#101018' } })
    .jpeg().toBuffer();

  // ── Every failure path returns the ORIGINAL bytes ──
  ok('a frame with nothing to say passes through byte-identical',
    (await stamp.stamp(frame, { stats: {}, sessions: [] })).equals(frame));
  ok('a null snapshot passes through', (await stamp.stamp(frame, null)).equals(frame));
  ok('an empty buffer is handed straight back',
    (await stamp.stamp(Buffer.alloc(0), busy)).length === 0);
  ok('bytes that are not an image do not throw',
    Buffer.isBuffer(await stamp.stamp(Buffer.from('not an image at all'), busy)));

  // ── And the real path actually draws ──
  const fonts = await stamp.fontsWork();
  ok('this machine can render text at all (else the rest is meaningless)', fonts);

  if (fonts) {
    const out = await stamp.stamp(frame, busy);
    ok('a busy account gets a different image', !out.equals(frame));
    ok('which is still a JPEG', out[0] === 0xFF && out[1] === 0xD8);

    // The drawing must be visible, not a no-op re-encode: the flat backdrop is
    // #101018, so any pixel far brighter than that is drawn type.
    const raw = await sharp(out).raw().toBuffer();
    let lit = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 170) lit++;
    ok('and the numbers are actually lit pixels, not an invisible layer', lit > 200);

    // ── Cached, because the encode is 676ms and the burst loop is every 2s ──
    const t0 = Date.now();
    await stamp.stamp(frame, busy);
    const warm = Date.now() - t0;
    ok(`a repeat is served from cache (${warm}ms)`, warm < 60);
    ok('and is byte-identical to the first', (await stamp.stamp(frame, busy)).equals(out));

    // Different numbers must NOT reuse the cached image.
    const other = await stamp.stamp(frame, { ...busy, stats: { tokens_today: 999 } });
    ok('different numbers are a different image', !other.equals(out));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
