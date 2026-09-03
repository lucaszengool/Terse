/**
 * Every file the renderer imports must actually be in the repository.
 *
 * This exists because one file was not. `wallpaper-styles.js` was written but
 * never `git add`ed, so it sat on the author's disk and in no checkout anywhere
 * else. `mineradio-wallpaper.js` imports it, which made the Windows build's
 * wallpaper page fail at module instantiation — and a static import that fails
 * takes the whole inline module with it, so the page never ran a line, never
 * applied its overlay class, and sat over the screen as an opaque black sheet.
 *
 * From the outside that looked like a compositing bug, and it was chased as one
 * across three commits and several rounds of native z-order and transparency
 * work. The screenshots even agreed with each other, because a dead page renders
 * deterministically. Nothing about it looked like a missing file.
 *
 * Run in CI, where the checkout contains only what is committed, this is the
 * cheapest possible statement of the thing that was wrong: an import with
 * nothing behind it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + msg); } };

// This file quotes example specifiers in its own comments and regexes, so it
// would otherwise flag itself.
const SELF = 'renderer-deps.test.mjs';
const files = readdirSync(DIR).filter(f => /\.(js|mjs|html)$/.test(f) && f !== SELF);

for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8');
  const deps = new Set();

  // ES imports and re-exports: from './x.js', import('./x.js')
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) deps.add(m[1]);
  // Classic script tags, which are relative to the page
  for (const m of src.matchAll(/<script[^>]+src=["']([^"':]+\.m?js)["']/g)) deps.add(m[1]);

  for (const d of deps) {
    const target = resolve(DIR, d.startsWith('.') ? d : './' + d);
    ok(`${f} imports ${d}, which must exist in the repo`, existsSync(target));
  }
}

// The specific one that broke Windows, named so a regression is unmistakable.
ok('wallpaper-styles.js ships (mineradio-wallpaper.js and wallpaper-control.html import it)',
   existsSync(join(DIR, 'wallpaper-styles.js')));

// The same failure one level up: a native window pointing at a page that is not
// in the repository.
//
// `WebviewUrl::App("x.html")` is resolved at runtime, so a missing file is not a
// build error — the window simply opens on nothing, which looks like "the button
// does nothing" rather than like a missing file. Exactly how wallpaper-styles.js
// presented, and exactly as hard to see.
for (const rs of ['../../src-tauri/src/lib.rs', '../../windows-app/src-tauri/src/lib.rs']) {
  const path = resolve(DIR, rs);
  if (!existsSync(path)) continue;
  const src = readFileSync(path, 'utf8');
  const pages = new Set();
  for (const m of src.matchAll(/WebviewUrl::App\(\s*"([^"?]+\.html)/g)) pages.add(m[1]);
  for (const page of pages) {
    ok(`${rs.split('/').slice(-3).join('/')} opens ${page}, which must exist in the repo`,
       existsSync(join(DIR, page)));
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
