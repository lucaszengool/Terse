/**
 * QR encoder conformance test for src/renderer/qr.js.
 *
 *   node src/renderer/qr.test.mjs        (needs: pip3 install qrcode)
 *
 * WHY THIS EXISTS. qr.js is a hand-written implementation of a dense standard,
 * and a QR code that is subtly wrong still LOOKS like a QR code — it renders, it
 * has finders, it fills the square — while the only symptom is a camera that
 * never locks on. Eyeballing one proves nothing. It now carries the phone
 * pairing code as well as room invites, so every module is compared against the
 * reference `qrcode` Python package, an independent implementation of the same
 * standard.
 *
 * Byte mode and the mask are forced on BOTH sides:
 *   · python-qrcode picks the most COMPACT mode for the data, so an
 *     all-uppercase payload comes out in alphanumeric mode — a different and
 *     equally valid encoding that a byte-mode encoder will never match.
 *   · The two disagree about the mask tie-break, because python-qrcode scores
 *     its candidates with the format modules blanked while the standard scores
 *     the complete symbol. Both symbols are valid and scannable; they are simply
 *     not identical bitmaps.
 * Neither is a bug in either implementation, and comparing default output would
 * drown a real bug in that noise.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));

const here = path.dirname(fileURLToPath(import.meta.url));

// qr.js is a browser IIFE that hangs itself off `window`; give it one.
const globalsShim = { };
// eslint-disable-next-line no-new-func
new Function('window', fs.readFileSync(path.join(here, 'qr.js'), 'utf8'))(globalsShim);
const TerseQR = globalsShim.TerseQR;

const CASES = [
  'K7QM4P',                                                 // a bare pair code
  'https://www.terseai.org/m/pair?c=K7QM4P',                 // what the pairing QR carries
  'https://www.terseai.org/join?room=ABC123',                // what a room invite carries
  'T',
  'x'.repeat(17), 'x'.repeat(32), 'x'.repeat(53), 'x'.repeat(78),
  'x'.repeat(106), 'x'.repeat(120), 'x'.repeat(134), 'x'.repeat(154),
  'x'.repeat(192), 'x'.repeat(213), 'x'.repeat(300), 'x'.repeat(700),
  '把 Terse 装进手机',                                        // multi-byte UTF-8
];
const MASKS = [0, 1, 2, 3, 4, 5, 6, 7];
const LEVELS = ['L', 'M', 'Q', 'H'];

let reference;
try {
  reference = JSON.parse(execFileSync('python3', [path.join(here, '..', '..', 'scripts', 'qr_reference.py')], {
    input: JSON.stringify({ cases: CASES, masks: MASKS, levels: LEVELS }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }));
} catch (e) {
  console.error('\nCould not run the reference encoder — install it with:\n'
    + '  pip3 install qrcode\n\n' + (e.stderr || e.message));
  process.exit(1);
}

console.log('\nqr.js vs. the reference implementation\n');

const seenVersions = new Set();
for (const text of CASES) {
  const label = text.length > 22 ? `${text.slice(0, 19)}… (${text.length}B)` : text;
  for (const ecl of LEVELS) {
    const entry = reference[text][ecl];
    seenVersions.add(entry.version);
    let bad = null;
    for (const mask of MASKS) {
      const want = entry.masks[String(mask)];
      const got = TerseQR.matrix(text, ecl, mask);
      if (!got || got.length !== want.length) { bad = `mask ${mask}: size ${got && got.length} ≠ ${want.length}`; break; }
      let diffs = 0, first = null;
      for (let r = 0; r < got.length; r++) {
        for (let c = 0; c < got.length; c++) {
          if (!!got[r][c] !== want[r][c]) { diffs++; if (!first) first = `${r},${c}`; }
        }
      }
      if (diffs) { bad = `mask ${mask}: ${diffs} modules differ, first at ${first}`; break; }
    }
    ok(`${ecl} v${entry.version} · ${label}${bad ? ` — ${bad}` : ''}`, !bad);
  }
}

// Versions 7+ carry a version-information block that 1–6 do not, and versions
// 2+ carry alignment patterns that version 1 does not. A suite that only ever
// reached version 3 would leave both of those code paths unverified.
ok(`spans small, mid and large versions (saw ${Math.min(...seenVersions)}–${Math.max(...seenVersions)})`,
  Math.min(...seenVersions) <= 2 && Math.max(...seenVersions) >= 15);

// The default path — no mask given — is what the app actually calls.
{
  const PAYLOAD = 'https://www.terseai.org/m/pair?c=K7QM4P';
  const auto = TerseQR.matrix(PAYLOAD, 'M');
  const size = auto.length;
  let bits = 0;
  for (let c = 0; c <= 5; c++) if (auto[8][c]) bits |= 1 << (14 - c);
  if (auto[8][7]) bits |= 1 << 8;
  if (auto[8][8]) bits |= 1 << 7;
  if (auto[7][8]) bits |= 1 << 6;
  for (let r = 0; r <= 5; r++) if (auto[r][8]) bits |= 1 << r;
  const data = (bits ^ 0b101010000010010) >> 10;
  ok('the default path declares the level it was asked for (M)', ((data >> 3) & 3) === 0b00);
  ok('the default path records the mask it used',
    JSON.stringify(auto) === JSON.stringify(TerseQR.matrix(PAYLOAD, 'M', data & 7)));
  ok('the dark module is set', !!auto[size - 8][8]);
}

let threw = false;
try { TerseQR.matrix('x'.repeat(4000), 'H'); } catch { threw = true; }
ok('refuses a payload that does not fit any version', threw);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
