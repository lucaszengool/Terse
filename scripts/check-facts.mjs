#!/usr/bin/env node
/**
 * Fail the build when the product facts drift, the way check-prices.mjs does
 * for money.
 *
 * Prices were not the only claim duplicated in a dozen places with nothing
 * keeping them in sync. The home page's SoftwareApplication node spent four
 * months saying operatingSystem "macOS" with no Windows at all, softwareVersion
 * 1.2.0 while the download button served v1.3.3, "20+ token reduction
 * techniques" against 35+ in the visible copy, and four detected agents against
 * eight. An essay's limitations table still listed Windows as unshipped and
 * "Windows UIA unreliable" long after the Windows app shipped on exactly that
 * API.
 *
 * Structured data is the first thing an answer engine trusts, so a stale claim
 * there is not a cosmetic problem — it is the version that gets repeated, with
 * the site's name attached.
 *
 * The checks are deliberately narrow. Pages legitimately discuss other tools
 * being macOS-only, and legitimately quote other versions, so this asserts on
 * the places that make a claim about Terse rather than grepping for a word.
 *
 *   node scripts/check-facts.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
const fail = [];
const warn = [];

/* ── the shipping version, taken from the download the button actually serves ── */
function shippingVersion() {
  const s = read('landing/index.html') || '';
  const m = s.match(/releases\/download\/v(\d+\.\d+\.\d+)\//);
  return m ? m[1] : null;
}

/* ── every JSON-LD block on a page ──────────────────────────────────────── */
function ldBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(m[1])); } catch { /* validity is another check's job */ }
  }
  return out;
}
function nodes(d) {
  if (Array.isArray(d)) return d.flatMap(nodes);
  if (d && typeof d === 'object') return d['@graph'] ? nodes(d['@graph']) : [d];
  return [];
}

/* ── 1. the SoftwareApplication node must match what the site ships ─────── */
function checkSoftwareApplication() {
  const ver = shippingVersion();
  if (!ver) return warn.push('landing/index.html — no release URL found, version check skipped');
  let seen = 0;
  for (const f of ['landing/index.html', 'landing/zh/index.html', 'landing/for-windows.html']) {
    const s = read(f);
    if (!s) continue;
    for (const app of ldBlocks(s).flatMap(nodes).filter((n) => n['@type'] === 'SoftwareApplication')) {
      seen++;
      const os = String(app.operatingSystem || '');
      if (!/windows/i.test(os)) {
        fail.push(`${f} — SoftwareApplication.operatingSystem is "${os}"; the site ships a Windows build and /for-windows exists`);
      }
      if (app.softwareVersion && app.softwareVersion !== ver) {
        fail.push(`${f} — SoftwareApplication.softwareVersion "${app.softwareVersion}" but the download serves v${ver}`);
      }
      const feats = (app.featureList || []).join(' ');
      const tech = feats.match(/(\d+)\+\s*(?:token\s*)?(?:reduction |optimization )?techniques/i);
      if (tech && Number(tech[1]) < 35) {
        fail.push(`${f} — featureList advertises ${tech[1]}+ techniques; the visible copy says 35+`);
      }
      const agents = feats.match(/(\d+)\s+coding agents/i);
      if (agents && Number(agents[1]) < 8) {
        fail.push(`${f} — featureList advertises ${agents[1]} agents; the site claims 8`);
      }
      if (app.aggregateRating) {
        fail.push(`${f} — aggregateRating is back. Google requires ratings to come from real users with the review content on the page; 4.8/47 was a placeholder and the markup was removed for that reason`);
      }
    }
  }
  if (!seen) warn.push('no SoftwareApplication node found on any home page');
}

/* ── 2. no page may describe Terse itself as macOS-only ─────────────────── */
function checkPlatformClaims() {
  const dir = join(root, 'landing');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
  const claim = /(Terse[^.]{0,60}(?:is |runs )?mac(?:OS)?[- ]only|mac(?:OS)?[- ]only[^.]{0,40}Terse|Windows UIA is unreliable|Windows[^.]{0,30}\broadmap\b)/i;
  for (const f of files) {
    const s = readFileSync(join(dir, f), 'utf8');
    // strip <script>/<style>, then look at prose only
    const text = s.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
    const m = text.match(claim);
    if (m) fail.push(`landing/${f} — still describes Terse as macOS-only: "${m[0].trim().slice(0, 90)}"`);
  }
}

/* ── 3. llms.txt is written to be quoted, so its facts must be current ──── */
function checkLlms() {
  for (const f of ['landing/llms.txt', 'landing/llms-full.txt']) {
    const s = read(f);
    if (!s) { warn.push(`${f} missing`); continue; }
    if (!/windows/i.test(s)) fail.push(`${f} — never mentions Windows, but the app ships on it`);
    const tech = s.match(/(\d+)\+\s*(?:token\s*)?(?:reduction |optimization )?techniques/i);
    if (tech && Number(tech[1]) < 35) fail.push(`${f} — says ${tech[1]}+ techniques; the site says 35+`);
  }
}

/* ── 4. the canonical host, since two hosts served the whole site once ──── */
function checkCanonicalHost() {
  const s = read('landing/sitemap.xml');
  if (!s) return warn.push('landing/sitemap.xml missing');
  const bad = [...s.matchAll(/<loc>(https:\/\/(?!www\.terseai\.org)[^<]+)<\/loc>/g)];
  if (bad.length) fail.push(`landing/sitemap.xml — ${bad.length} URL(s) not on the canonical host www.terseai.org, first: ${bad[0][1]}`);
}

checkSoftwareApplication();
checkPlatformClaims();
checkLlms();
checkCanonicalHost();

for (const w of warn) console.log(`⚠ ${w}`);
if (fail.length) {
  console.error(`\n✗ ${fail.length} product-fact problem(s):\n`);
  for (const f of fail) console.error(`  ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ product facts agree across schema, prose, llms.txt and the sitemap`);
