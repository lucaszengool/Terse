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

// An event the Mac backend emits and the Windows one never does.
//
// This is the gap nothing else here could see. wallpaper-hover was emitted on
// macOS and nowhere on Windows, and it is the event that opens the message card
// — the full text and the reply box. Both halves of that feature compiled, were
// registered, and passed their tests; the card simply never opened, which from
// the outside is indistinguishable from a feature that was never built. A
// command that is missing shows up as a rejected invoke. A missing EVENT shows
// up as nothing at all.
{
  const read = (p) => { const f = resolve(DIR, p); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  const events = (src) => new Set(
    [...src.matchAll(/\.emit(?:_to)?\(\s*(?:"[a-z0-9_-]+",\s*)?"([a-z0-9:_-]+)"/g)].map(m => m[1]));
  const mac = events(read('../../src-tauri/src/lib.rs'));
  const win = events(read('../../windows-app/src-tauri/src/lib.rs'));
  // Genuinely platform-bound, with the reason, so the list cannot quietly grow.
  const MAC_ONLY = new Map([
    ['ax-status', 'macOS Accessibility authorisation; Windows has no equivalent state'],
  ]);
  // Not platform-bound — just not ported yet, and part of a family the command
  // guard below already defers (pm_*, still changing on macOS). Same reason,
  // same rule: the moment Windows emits one, its entry FAILS and has to go.
  const EVENT_GAPS = new Map([
    ['pm-target', 'pm_* is new on macOS and still in flux'],
  ]);
  if (mac.size && win.size) {
    for (const e of [...mac].sort()) {
      if (MAC_ONLY.has(e) || EVENT_GAPS.has(e)) continue;
      ok(`event "${e}" is emitted on Windows too, not just macOS`, win.has(e));
    }
    for (const [e, why] of EVENT_GAPS) {
      ok(`EVENT_GAPS entry "${e}" (${why}) is still actually missing on Windows`, !win.has(e));
    }
  }
}

// A command the shared bridge invokes that only one backend registers.
//
// The companion to the event check above, and needed because the two fail in
// different ways. A missing command surfaces as a rejected invoke — the feature
// is simply dead on that platform. A missing event surfaces as nothing at all.
// Neither check sees the other's gap: `cowork-peer` was already emitted on
// Windows from another path while the command the UI actually calls was absent,
// so the event check was green over a dead feature.
//
// This is the check that would have found all twenty-two at once, instead of a
// hand audit finding them one platform release later.
{
  const read = (p) => { const f = resolve(DIR, p); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  const registered = (dir) => {
    const out = new Set();
    for (const f of ['lib.rs','notifications.rs','messages.rs','projects.rs','permission.rs','phone.rs','doctor.rs','cowork.rs']) {
      const src = read(`${dir}/${f}`);
      for (const m of src.matchAll(/#\[tauri::command\][^\n]*\n\s*(?:pub )?(?:async )?fn ([a-z0-9_]+)/g)) out.add(m[1]);
    }
    return out;
  };
  const bridge = read('tauri-bridge.js');
  const invoked = new Set([...bridge.matchAll(/invoke\(\s*'([a-z0-9_]+)'/g)].map(m => m[1]));
  const mac = registered('../../src-tauri/src');
  const win = registered('../../windows-app/src-tauri/src');

  // Still to port, each with why. The list may only ever shrink — a new name
  // here needs a reason, which is the point.
  const KNOWN_GAPS = new Map([
    ['app_icon', 'needs a Windows rewrite: NSWorkspace icon extraction → SHGetFileInfo'],
    ['messages_detected_apps', 'messages settings page, not yet ported'],
    ['messages_notification_settings', 'messages settings page, not yet ported'],
    ['messages_open_settings', 'messages settings page, not yet ported'],
    ['messages_permission_report', 'messages settings page, not yet ported'],
    // The pm_* family appeared on macOS while this branch was being written and
    // is still uncommitted there. Porting code that is still moving means
    // porting it twice; it goes in once it settles.
    ['pm_start', 'pm_* is new on macOS and still in flux'],
    ['pm_stop', 'pm_* is new on macOS and still in flux'],
    ['pm_status', 'pm_* is new on macOS and still in flux'],
    ['pm_windows', 'pm_* is new on macOS and still in flux'],
    ['pm_window_rect', 'pm_* is new on macOS and still in flux'],
    ['pm_overlay', 'pm_* is new on macOS and still in flux'],
    ['pm_overlay_hide', 'pm_* is new on macOS and still in flux'],
    ['pm_has_permission', 'pm_* is new on macOS and still in flux'],
    ['pm_request_permission', 'pm_* is new on macOS and still in flux'],
  ]);
  if (mac.size && win.size) {
    for (const c of [...invoked].sort()) {
      if (!mac.has(c)) continue;              // not a parity question
      if (KNOWN_GAPS.has(c)) continue;
      ok(`command "${c}" is registered on Windows too, not just macOS`, win.has(c));
    }
    // A gap that has been closed must leave the list, or it rots into a lie.
    for (const [c, why] of KNOWN_GAPS) {
      ok(`KNOWN_GAPS entry "${c}" (${why}) is still actually missing`, !win.has(c));
    }
  }
}

// A window that is BUILT but not listed in its backend's capability file.
//
// Tauri only checks capabilities for app commands when the app ships an ACL
// manifest, and neither app does — so such a window's clicks still reach Rust
// and it looks fine. But every PLUGIN call is refused, events included. The
// round 3D button shipped to Windows exactly like that: its click worked, its
// listen('wallpaper-adjust') was silently refused, and so its light could never
// go out when Esc, the watchdog or a lapsed licence ended the mode — the "lit
// button, finished mode" state its own comment calls worse than no button.
{
  const built = (dir) => {
    const d = resolve(DIR, dir);
    if (!existsSync(d)) return [];
    const out = new Set();
    for (const f of readdirSync(d).filter((n) => n.endsWith('.rs'))) {
      const src = readFileSync(join(d, f), 'utf8');
      for (const m of src.matchAll(/WebviewWindowBuilder::new\(\s*&?[a-z_]+,\s*"([a-z0-9_-]+)"/g)) out.add(m[1]);
    }
    return [...out];
  };
  const listed = (file) => {
    const f = resolve(DIR, file);
    try { return JSON.parse(readFileSync(f, 'utf8')).windows || null; } catch (e) { return null; }
  };
  const covers = (label, pats) => pats.some((p) => p === label || (p.endsWith('*') && label.startsWith(p.slice(0, -1))));
  for (const [name, dir, cap] of [
    ['macOS', '../../src-tauri/src', '../../src-tauri/capabilities/default.json'],
    ['Windows', '../../windows-app/src-tauri/src', '../../windows-app/src-tauri/capabilities/default.json'],
  ]) {
    const pats = listed(cap);
    if (!pats) continue;
    for (const label of built(dir).sort()) {
      ok(`${name} builds window "${label}", which must be in its capabilities or its events are refused`, covers(label, pats));
    }
  }
}

// The raw hand-frame target list must be the same on both backends.
//
// macOS changed it — five windows down to two, when gesture computation moved
// into the desk overlay — while the Windows port was being written against the
// old list. Nothing failed. The wallpaper would simply have kept being woken 30
// times a second for frames it had stopped reading. (Only checked where both
// files exist: the macOS hands.rs is not committed yet.)
{
  const list = (p) => {
    const f = resolve(DIR, p);
    if (!existsSync(f)) return null;
    const m = readFileSync(f, 'utf8').match(/const HAND_WINDOWS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/);
    return m ? (m[1].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)).sort().join(',') : null;
  };
  const mac = list('../../src-tauri/src/hands.rs');
  const win = list('../../windows-app/src-tauri/src/hands.rs');
  if (mac && win) ok(`HAND_WINDOWS matches macOS (macOS: ${mac} | Windows: ${win})`, mac === win);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
