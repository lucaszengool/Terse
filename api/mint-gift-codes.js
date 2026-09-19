#!/usr/bin/env node
/**
 * mint-gift-codes.js — pre-mint single-use gift codes.
 *
 *   node api/mint-gift-codes.js [count] [batch] [kind]
 *   node api/mint-gift-codes.js 500 launch-2026            # lifetime (default)
 *   node api/mint-gift-codes.js 1000 week-2026 week         # 1 week of Pro
 *
 * kind: lifetime | week | month | year. Timed kinds extend users.bonus_pro_until
 * (stacking on any Pro time already there); see GIFT_PERIODS in server.js.
 *
 * Writes the codes into the gift_codes table AND to a plain-text file you can
 * hand out from. Redeeming one (in the app's invite box, or POST
 * /api/referral/redeem) sets users.lifetime_at — the same flag a paid lifetime
 * purchase sets — so the holder gets every feature and every future update,
 * permanently. Each code works exactly once; the claim is an atomic conditional
 * UPDATE in the database, not a check-then-write, so it cannot be double-spent.
 *
 * Codes are random, not derived from anything — there is no algorithm to forge
 * one, and an unminted code is simply not in the table.
 *
 * Re-running is safe: INSERT OR IGNORE means an accidental collision with an
 * existing code is skipped rather than resetting its redeemed state.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// No 0/O/1/I/L — these are read aloud and typed by hand off a screenshot.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LEN = 4;
const KINDS = ['lifetime', 'week', 'month', 'year'];
const KIND_TEXT = {
  lifetime: ['lifetime (买断)', 'Each code unlocks Terse permanently: every feature, every future update.'],
  week:     ['1-week Pro (周卡)', 'Each code gives 1 week of Terse Pro from the moment it is redeemed.'],
  month:    ['1-month Pro (月卡)', 'Each code gives 1 month of Terse Pro from the moment it is redeemed.'],
  year:     ['1-year Pro (年卡)', 'Each code gives 1 year of Terse Pro from the moment it is redeemed.'],
};

function mintCode() {
  const bytes = crypto.randomBytes(GROUPS * GROUP_LEN);
  let out = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = '';
    for (let i = 0; i < GROUP_LEN; i++) {
      s += ALPHABET[bytes[g * GROUP_LEN + i] % ALPHABET.length];
    }
    out.push(s);
  }
  // The TERSE- prefix is what the redeem endpoint uses to tell a gift code from
  // a 6-char friend invite code, so it must not be dropped.
  return 'TERSE-' + out.join('-');
}

// ── import mode ──
// The database lives at <repo>/data/terse.db, so minting on your laptop does
// NOT create codes the deployed server knows about. Generate the file locally,
// then run this on the server to make the SAME codes live:
//   node api/mint-gift-codes.js --import docs/gift-codes-<batch>.txt
if (process.argv[2] === '--import') {
  const file = process.argv[3];
  if (!file) { console.error('usage: --import <file>'); process.exit(1); }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l.startsWith('TERSE-'));
  const b = process.argv[4] || path.basename(file).replace(/^gift-codes-|\.txt$/g, '');
  // Kind comes from the file's own "kind:" header line (files minted before
  // timed codes existed have none and are lifetime).
  const hdr = fs.readFileSync(file, 'utf8').match(/^kind:\s*(\w+)/m);
  const k = process.argv[5] || (hdr ? hdr[1] : 'lifetime');
  if (!KINDS.includes(k)) { console.error(`unknown kind "${k}"`); process.exit(1); }
  let added = 0;
  for (const c of lines) {
    // INSERT OR IGNORE: re-importing never resets an already-redeemed code.
    if (db.addGiftCode.run(c, b, k).changes === 1) added++;
  }
  const s = db.countGiftCodes.get(b);
  console.log(`imported ${added} new ${k} code(s) from ${file} into batch "${b}"`);
  console.log(`batch now: ${s.total} total, ${s.used || 0} used`);
  process.exit(0);
}

const count = parseInt(process.argv[2] || '500', 10);
const batch = process.argv[3] || 'gift-' + new Date().toISOString().slice(0, 10);
const kind = process.argv[4] || 'lifetime';
if (!KINDS.includes(kind)) {
  console.error(`kind must be one of: ${KINDS.join(', ')}`);
  process.exit(1);
}

if (!Number.isFinite(count) || count < 1 || count > 100000) {
  console.error('count must be between 1 and 100000');
  process.exit(1);
}

const codes = [];
const seen = new Set();
while (codes.length < count) {
  const c = mintCode();
  if (seen.has(c)) continue;          // in-run duplicate
  if (db.getGiftCode.get(c)) continue; // already minted in an earlier batch
  seen.add(c);
  const r = db.addGiftCode.run(c, batch, kind);
  if (r.changes === 1) codes.push(c);
}

const outDir = path.join(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `gift-codes-${batch}.txt`);

const header = [
  `Terse — ${KIND_TEXT[kind][0]} gift codes`,
  `batch: ${batch}`,
  `kind: ${kind}`,
  `count: ${codes.length}`,
  `minted: ${new Date().toISOString()}`,
  ``,
  KIND_TEXT[kind][1],
  `Redeem in the app: 邀请 / Invite panel → "Have a friend's code?" → paste → Redeem.`,
  ``,
  `EACH CODE WORKS ONCE. Treat this file like cash — anyone holding a code can`,
  `spend it, and it is spent by whoever redeems it first.`,
  ``,
  '-'.repeat(40),
  ``,
].join('\n');

fs.writeFileSync(outFile, header + codes.join('\n') + '\n', 'utf8');

const stat = db.countGiftCodes.get(batch);
console.log(`minted ${codes.length} ${kind} codes into batch "${batch}"`);
console.log(`batch now: ${stat.total} total, ${stat.used || 0} used`);
console.log(`file: ${outFile}`);
