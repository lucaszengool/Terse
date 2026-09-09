/* Assembles landing/terse-city.js from the APP's own sources, so the site's
 * code city IS the app's city rather than a hand-copy that drifts.
 *
 * Two things here are deliberate, both learned the hard way:
 *   · extraction is BY NAME with brace matching, never by line number;
 *   · the result is checked for CLOSURE before it is written.
 * Re-run after changing the app-side city:  node scripts/build-landing-city.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const R = 'src/renderer/';
const read = (f) => readFileSync(R + f, 'utf8');

/* Names that are legal to call without being defined in the bundle. */
const GLOBALS = new Set([
  'if', 'for', 'of', 'in', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'else', 'do',
  'case', 'await', 'yield', 'delete', 'void', 'throw', 'instanceof', 'function', 'require',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURIComponent', 'encodeURIComponent',
]);

/** Strip comments and string literals — prose like "ln(bytes)" in a comment is
 *  not a function call, and reporting it as a missing helper is noise. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^\\`]|\\.)*`/g, "''")
    .replace(/"(?:[^\\"]|\\.)*"/g, "''")
    .replace(/'(?:[^\\']|\\.)*'/g, "''");
}

/** Pull one top-level declaration out of a module, whole, by brace matching.
 *  Throws rather than emitting half a function: a silently truncated bundle is
 *  far worse than a build error. */
function extract(src, name) {
  const m = new RegExp(`^(?:export\\s+)?(?:function|const|let|var)\\s+${name}\\b`, 'm').exec(src);
  if (!m) throw new Error(`build-landing-city: ${name} not found in wallpaper-project.js`);
  const start = m.index;
  let i = src.indexOf('{', start);
  const semi = src.indexOf(';', start);
  // `const X = 26 * Math.PI / 180;` has no brace before its semicolon.
  if (i === -1 || (semi !== -1 && semi < i)) return src.slice(start, semi + 1).replace(/^export\s+/, '');

  // Comments MUST be skipped, not just strings: the first version tracked only
  // quotes, so one apostrophe in a // comment ("don't") put the scanner into
  // string mode permanently and sampleCity came out as 61KB of the rest of the
  // file instead of 15KB.
  let depth = 0, inS = null, prev = '';
  for (; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (inS) { if (c === inS && prev !== '\\') inS = null; prev = c; continue; }
    if (c === '/' && d === '/') { i = src.indexOf('\n', i); if (i < 0) break; prev = ''; continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; prev = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; prev = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { i++; break; } }
    prev = c;
  }
  if (depth !== 0) throw new Error(`build-landing-city: ${name} never closed — refusing to emit a truncated copy`);
  return src.slice(start, src[i] === ';' ? i + 1 : i).replace(/^export\s+/, '');
}

const styles = read('city-styles.js').replace(/^export /gm, '');
const lang   = read('lang-colors.js').replace(/^export /gm, '');
const wp     = read('wallpaper-project.js');

const NEEDED = ['hash01c', 'sampleLabel', 'human', 'since',
                'CITY_PITCH', 'CITY_YAW', 'KIND_RGB', 'sampleCity'];
const parts = NEEDED.map((n) => extract(wp, n));

const out = `/* ═══════════════════════════════════════════════════════════════════════════
   terse-city.js — the code city, for the website.

   GENERATED — do not hand-edit. Assembled from the app's own sources by
   scripts/build-landing-city.mjs, so the site's city is literally the app's
   city rather than a copy that drifts away from it:

     src/renderer/city-styles.js       — the 8 civilisations, whole
     src/renderer/lang-colors.js       — language -> colour, whole
     src/renderer/wallpaper-project.js — ${NEEDED.join(', ')}

   Exposed as window.TerseCity, because terse-field.js is a plain IIFE that the
   landing pages load with a bare <script> — there are no modules here.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

/* ── lang-colors.js ──────────────────────────────────────────────────────── */
${lang}

/* ── city-styles.js ──────────────────────────────────────────────────────── */
${styles}

/* ── wallpaper-project.js: only what sampleCity needs ────────────────────── */
${parts.join('\n\n')}

  root.TerseCity = {
    sampleCity: sampleCity,
    CITY_STYLES: CITY_STYLES,
    styleOf: styleOf,
    DEFAULT_STYLE: DEFAULT_STYLE,
    PITCH: CITY_PITCH,
    YAW: CITY_YAW
  };
})(window);
`;

/* Prove the bundle is CLOSED before writing it. A missing helper does not fail
   at build time — it fails as a ReferenceError deep inside sampleCity, at
   runtime, only on whichever style reaches that branch. `human` and `since`
   were both found that way, one page reload at a time. */
{
  const code = codeOnly(out);
  const declared = new Set([...code.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  // Object-method shorthand (`odds(p) { ... }`, called as P.odds()) declares a
  // name too, or the check reports its own definition as missing.
  for (const m of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declared.add(m[1]);
  const missing = new Set();
  for (const m of code.matchAll(/(?:^|[^.\w$])([a-z][\w$]*)\s*\(/g)) {
    const id = m[1];
    if (!declared.has(id) && !GLOBALS.has(id)) missing.add(id);
  }
  if (missing.size) {
    throw new Error(`build-landing-city: called but never defined — add to NEEDED: ${[...missing].join(', ')}`);
  }
}

writeFileSync('landing/terse-city.js', out);
console.log(`wrote landing/terse-city.js  ${(out.length / 1024).toFixed(1)}KB  ` +
            `(${NEEDED.length} helpers + 2 whole modules, closure checked)`);
