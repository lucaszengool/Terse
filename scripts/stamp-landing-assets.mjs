#!/usr/bin/env node
/**
 * stamp-landing-assets.mjs — put a content hash on the shared landing assets.
 *
 * Twice now a landing deploy has reached the origin and been invisible to
 * visitors, because Cloudflare kept serving a cached /terse-glass.css. The
 * origin sends max-age=300, but an edge cache rule overrides it, so the stale
 * copy can outlive the deploy by hours and the only cure is a manual purge.
 *
 * A hardcoded ?v=2 would fix it exactly once — then someone forgets to bump it
 * and the same silent failure returns. Hashing the file's own bytes means the
 * URL changes if and only if the file changed, so a stale cache can never mask
 * a shipped change and an unchanged file keeps its cache.
 *
 * Idempotent: run it after editing either asset, before committing.
 *   node scripts/stamp-landing-assets.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANDING = path.join(ROOT, 'landing');

const ASSETS = [
  { file: 'terse-glass.css', attr: 'href' },
  { file: 'terse-field.js', attr: 'src' },
];

const hashes = Object.fromEntries(
  ASSETS.map(({ file }) => [
    file,
    createHash('sha1').update(readFileSync(path.join(LANDING, file))).digest('hex').slice(0, 8),
  ])
);

function* htmlFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      yield* htmlFiles(p);
    } else if (e.endsWith('.html')) yield p;
  }
}

let touched = 0, rewrites = 0;
for (const f of htmlFiles(LANDING)) {
  const before = readFileSync(f, 'utf8');
  let after = before;
  for (const { file, attr } of ASSETS) {
    // matches the bare link and any previously stamped one, so reruns are safe
    const re = new RegExp(`${attr}="(/${file.replace('.', '\\.')})(\\?v=[0-9a-f]+)?"`, 'g');
    after = after.replace(re, (_m, p1) => `${attr}="${p1}?v=${hashes[file]}"`);
  }
  if (after !== before) {
    writeFileSync(f, after);
    touched++;
    rewrites += (after.match(/\?v=[0-9a-f]{8}"/g) || []).length;
  }
}

for (const [file, h] of Object.entries(hashes)) console.log(`  ${file} -> ?v=${h}`);
console.log(`stamped ${rewrites} link(s) across ${touched} file(s)`);
