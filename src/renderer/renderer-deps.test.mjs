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

// Command and event parity between the two backends, across EVERY module.
//
// The first version of this read only lib.rs, and only commands the shared
// bridge invokes. macOS then grew eight modules — session dock, room link,
// particle mode, desk control, feeds — and 63 commands and 12 events went
// missing on Windows without one assertion firing. The gap was found by hand,
// which is exactly what a guard is supposed to make unnecessary.
//
// DEFERRED is the ledger of what is knowingly not ported, each with the reason.
// Every entry is also held to "still actually missing", so porting one FAILS
// here until its line is deleted: the list can only shrink by someone doing the
// work. It can never grow quietly, because a NEW gap is not in the list and
// fails immediately.
{
  const RS = (dir) => {
    const d = resolve(DIR, dir);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((n) => n.endsWith('.rs')).map((n) => readFileSync(join(d, n), 'utf8'));
  };
  const names = (srcs, re) => {
    const s = new Set();
    for (const src of srcs) for (const m of src.matchAll(re)) s.add(m[1]);
    return s;
  };
  const CMD = /#\[tauri::command[^\]]*\]\s*(?:pub )?(?:async )?fn ([a-z0-9_]+)/g;
  const EVT = /\.emit(?:_to|_filter)?\(\s*(?:"[a-z0-9_-]+",\s*)?"([a-z0-9:_-]+)"/g;
  const macSrc = RS('../../src-tauri/src'), winSrc = RS('../../windows-app/src-tauri/src');
  const macCmd = names(macSrc, CMD), winCmd = names(winSrc, CMD);
  const macEvt = names(macSrc, EVT), winEvt = names(winSrc, EVT);

  // Genuinely platform-bound: no Windows equivalent exists to port.
  const PLATFORM_ONLY = new Map([
    ['ax-status', 'macOS Accessibility authorisation; Windows has no equivalent state'],
  ]);
  const DEFERRED_CMDS = new Map([
    ["app_icon", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["desk_call", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["desk_get_enabled", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["desk_open_ax_settings", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["desk_overlay_visible", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["desk_set_enabled", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["desk_trust", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["messages_detected_apps", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["messages_notification_settings", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["messages_open_permission_settings", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["messages_open_settings", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["messages_permission_report", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["pl_send", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pl_target", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["pl_transcript", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["pm_has_permission", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm_overlay", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["pm_overlay_hide", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["pm_request_permission", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm_start", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm_status", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm_stop", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm_window_rect", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm_windows", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["sd_alert", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_codex_open", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_diff", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_dock", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_dock_hide", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_dock_open", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_focus_input", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_git", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_image", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_jump", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_open_claude", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_send", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_stop", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_transcript", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd_usage", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
  ]);
  const DEFERRED_EVENTS = new Map([
    ["desk-enabled", "desk gesture control (\u684c\u9762\u624b\u52bf) \u2014 macOS Accessibility"],
    ["pm-frame", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm-lost", "particle mode (\u7c92\u5b50\u6a21\u5f0f) \u2014 macOS window capture"],
    ["pm-target", "assorted: app_icon (NSWorkspace), messages settings page"],
    ["sd-mouse", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["sd-state", "session dock (\u4f1a\u8bdd\u680f) \u2014 macOS AX/window APIs, frontend untracked"],
    ["terse-approval", "approvals \u2014 macOS Accessibility"],
    ["terse-approval-cleared", "approvals \u2014 macOS Accessibility"],
    ["town-need-ax", "Code Town Accessibility guide \u2014 macOS only"],
  ]);

  if (macCmd.size && winCmd.size) {
    for (const c of [...macCmd].sort()) {
      if (DEFERRED_CMDS.has(c)) continue;
      ok(`command "${c}" exists on Windows too, not just macOS`, winCmd.has(c));
    }
    for (const [c, why] of DEFERRED_CMDS) {
      ok(`DEFERRED command "${c}" (${why}) is still actually missing`, !winCmd.has(c));
    }
  }
  if (macEvt.size && winEvt.size) {
    for (const e of [...macEvt].sort()) {
      if (PLATFORM_ONLY.has(e) || DEFERRED_EVENTS.has(e)) continue;
      ok(`event "${e}" is emitted on Windows too, not just macOS`, winEvt.has(e));
    }
    for (const [e, why] of DEFERRED_EVENTS) {
      ok(`DEFERRED event "${e}" (${why}) is still actually missing`, !winEvt.has(e));
    }
  }

  // A bridge entry naming a command NEITHER backend registers is a typo or a
  // leftover — at runtime it is "command not found".
  //
  // EITHER backend, not macOS specifically: the first cut asked macOS, and CI
  // failed on diag_note, which exists only on Windows. A command living on one
  // side is the parity question above; this one is only about names that exist
  // nowhere.
  const bridge = readFileSync(resolve(DIR, 'tauri-bridge.js'), 'utf8');
  for (const m of [...bridge.matchAll(/invoke\(\s*'([a-z0-9_]+)'/g)].map((x) => x[1]).sort()) {
    if (!macCmd.size && !winCmd.size) break;
    ok(`bridge calls "${m}", which at least one backend registers`, macCmd.has(m) || winCmd.has(m));
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

// Two functions with the same name in one Rust file.
//
// messages.rs already had a status(); a port added a second one with a
// different return type and the crate stopped compiling. Nothing here caught
// it, because that module cannot be type-checked on macOS — its bundled SQLite
// will not cross-compile — so feeds.rs was checked against a STUB of it, and
// the stub had only the new function. A textual check is the one thing that
// could have seen it early, and it costs nothing.
//
// cfg-guarded definitions are skipped: a pair like
// #[cfg(windows)] fn x() / #[cfg(not(windows))] fn x() is the normal way to
// write a platform split, not a mistake.
{
  // Top-level only (no leading whitespace). Methods live inside impl blocks and
  // are indented, and Rust is happy for two impls to define the same method
  // name — counting those flagged `fn default` in every file with more than one
  // impl Default. The bug this is for was two TOP-LEVEL functions.
  const RS_FN = /^(?:pub(?:\([a-z:]+\))? )?(?:async )?(?:unsafe )?(?:extern "[A-Za-z-]+" )?fn ([a-z0-9_]+)\s*[(<]/;
  for (const [name, dir] of [['macOS', '../../src-tauri/src'], ['Windows', '../../windows-app/src-tauri/src']]) {
    const d = resolve(DIR, dir);
    if (!existsSync(d)) continue;
    for (const file of readdirSync(d).filter((n) => n.endsWith('.rs'))) {
      const lines = readFileSync(join(d, file), 'utf8').split('\n');
      const counts = new Map();
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(RS_FN);
        if (!m) continue;
        // Walk back over attributes; a cfg on this definition means it is one
        // arm of a platform split.
        let cfgd = false;
        for (let k = i - 1; k >= 0 && (lines[k].trim().startsWith('#[') || lines[k].trim().startsWith('///') || lines[k].trim() === ''); k--) {
          if (lines[k].includes('#[cfg(')) { cfgd = true; break; }
        }
        if (cfgd) continue;
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      }
      for (const [fn, n] of counts) {
        if (n > 1) ok(`${name}/${file}: fn ${fn} is defined once, not ${n} times`, false);
      }
    }
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
