#!/usr/bin/env node
/**
 * Fail the build when advertised prices drift.
 *
 * The same price is duplicated across HTML copy, JSON-LD, i18n.js in eleven
 * languages, llms.txt and llms-full.txt, with nothing keeping them in sync.
 * That is how docs.html went on advertising Pro at $7.99 long after it became
 * $4.99, and how llms-full.txt kept saying $7.99 to answer engines for months.
 *
 * This checks the places that actually make a claim, rather than grepping every
 * dollar sign — the pages are full of legitimate money (token costs, model
 * pricing) that must not trip the check.
 *
 *   node scripts/check-prices.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'scripts/pricing.json'), 'utf8'));
const T = cfg.tiers;
const fail = [];
const warn = [];

const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
const money = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Any retired price appearing anywhere in landing/ is always a bug. */
function checkRetired() {
  const files = ['landing/index.html', 'landing/docs.html', 'landing/for-windows.html',
                 'landing/i18n.js', 'landing/llms.txt', 'landing/llms-full.txt',
                 'landing/zh/index.html'];
  for (const f of files) {
    const s = read(f);
    if (!s) continue;
    for (const dead of cfg.retired) {
      // match $7.99 / 7,99 $ / US$ 7.99 but not 17.99 or 7.995
      const re = new RegExp(`(?<![\\d.,])${money(dead).replace('.', '[.,]')}(?![\\d])`, 'g');
      const hits = [...s.matchAll(re)];
      if (hits.length) {
        const line = s.slice(0, hits[0].index).split('\n').length;
        fail.push(`${f}:${line} — retired price $${money(dead)} is still advertised (${hits.length}×)`);
      }
    }
  }
}

/** The i18n keys that state a price must state the current one. */
function checkI18n() {
  const s = read('landing/i18n.js');
  if (!s) return warn.push('landing/i18n.js missing — skipped');
  const keys = { 'pricing.proPrice': T.pro.usd, 'pricing.premiumPrice': T.premium.usd };
  for (const [key, want] of Object.entries(keys)) {
    const re = new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`, 'g');
    const found = [...s.matchAll(re)];
    if (!found.length) { warn.push(`i18n.js — no ${key} entries found`); continue; }
    found.forEach((m) => {
      const digits = m[1].replace(/[^\d.,]/g, '').replace(',', '.');
      if (parseFloat(digits) !== want) {
        const line = s.slice(0, m.index).split('\n').length;
        fail.push(`landing/i18n.js:${line} — ${key} is "${m[1]}", expected $${money(want)}`);
      }
    });
  }
}

/** The machine-readable fact rows and the LLM-facing files. */
function checkClaims() {
  const targets = [
    ['landing/index.html',     /<dt>Price<\/dt><dd>([^<]*)<\/dd>/g],
    ['landing/for-windows.html', /<dt>Price<\/dt><dd>([^<]*)<\/dd>/g],
    ['landing/llms.txt',       /^- Pricing:.*$/gm],
    ['landing/llms-full.txt',  /^\s*-\s+\*\*(?:Pro|Premium)[^\n]*$/gm],
  ];
  for (const [f, re] of targets) {
    const s = read(f);
    if (!s) { warn.push(`${f} missing — skipped`); continue; }
    const blocks = [...s.matchAll(re)].map((m) => m[1] ?? m[0]);
    if (!blocks.length) { warn.push(`${f} — no price claim matched; pattern may need updating`); continue; }
    const joined = blocks.join(' ');
    for (const tier of ['pro', 'premium']) {
      if (!joined.includes(money(T[tier].usd))) {
        fail.push(`${f} — price claim never mentions ${T[tier].label} $${money(T[tier].usd)}: "${joined.trim().slice(0, 120)}"`);
      }
    }
  }
}

/** Every tier in pricing.json must have its price id resolved by the server. */
function checkServerParity() {
  const s = read('api/server.js');
  if (!s) return warn.push('api/server.js missing — skipped');
  for (const [name, t] of Object.entries(T)) {
    if (!t.env) continue;
    if (!s.includes(t.env)) fail.push(`api/server.js — tier "${name}" declares ${t.env}, which the server never reads`);
  }
}

checkRetired();
checkI18n();
checkClaims();
checkServerParity();

for (const w of warn) console.warn(`warn  ${w}`);
if (fail.length) {
  console.error(`\n✗ ${fail.length} pricing inconsistenc${fail.length === 1 ? 'y' : 'ies'}:\n`);
  fail.forEach((f) => console.error(`  ${f}`));
  console.error(`\nAdvertised prices must match scripts/pricing.json. Update every surface, or update pricing.json if the price genuinely changed.\n`);
  process.exit(1);
}
console.log(`✓ pricing consistent across every surface (${Object.keys(T).length} tiers checked)`);
