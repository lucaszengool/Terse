/* Always-on-top (Pro).

   Two mistakes would each turn this from a feature into an unusable screen, so
   both are asserted rather than reviewed:

     · an OPAQUE window at the screen-saver level is a black sheet over the whole
       display — the desktop path sets opaque YES, and copying that flag across
       is the obvious thing to get wrong;
     · a window at that level that ACCEPTS clicks swallows every click on the
       machine. Click-through has to hold in both modes.
*/
import { readFileSync } from 'node:fs';
const R = new URL('./', import.meta.url).pathname;
const rs = readFileSync(R + '../../src-tauri/src/lib.rs', 'utf8');
const page = readFileSync(R + 'wallpaper.html', 'utf8');
const eng = readFileSync(R + 'mineradio-wallpaper.js', 'utf8');
const ctl = readFileSync(R + 'wallpaper-control.html', 'utf8');
const bridge = readFileSync(R + 'tauri-bridge.js', 'utf8');

let pass = 0; const fails = [];
const ok = (l, c) => (c ? pass++ : fails.push(l));

const fn = rs.slice(rs.indexOf('fn pin_wallpaper_window(win'), rs.indexOf('#[cfg(not(target_os = "macos"))]\nfn pin_wallpaper_window'));

// ── the window level ──
ok('overlay uses the screen-saver level', /if overlay \{ 1_000 \}/.test(fn));
ok('desktop keeps kCGDesktopWindowLevel', /else \{ -2_147_483_623 \}/.test(fn));
ok('overlay adds fullScreenAuxiliary', /if overlay \{ behavior \|= 1 << 8; \}/.test(fn));

// ── the two mistakes ──
ok('overlay is NOT opaque', /if overlay \{[\s\S]{0,200}setOpaque: NO/.test(fn));
ok('desktop stays opaque', /\} else \{[\s\S]{0,200}setOpaque: YES/.test(fn));
ok('overlay gets a clear background', /clearColor[\s\S]{0,80}setBackgroundColor/.test(fn));
ok('click-through applies in BOTH modes (set before the branch)',
   fn.indexOf('setIgnoresMouseEvents: YES') < fn.indexOf('if overlay {\n                let _: () = msg_send![ns, setOpaque: NO]'));

// ── the window must be built transparent; it cannot be switched later ──
ok('the wallpaper window is built transparent', /"wallpaper"[\s\S]{0,900}\.transparent\(true\)/.test(rs));

// ── nothing but particles may be painted ──
ok('the page drops its background in overlay mode', /html\.overlay[^}]*background: transparent !important/.test(page));
ok('the engine can drop the desktop-picture bed', /setOverlay\(on\)/.test(eng));
ok('and remembers it so leaving overlay restores it', /_bedCss/.test(eng));
ok('the bed is not painted while overlaying', /&& !this\._overlay/.test(eng));

// ── it survives an engine swap (that branch returns early) ──
{
  const apply = page.slice(page.indexOf('function applyConfig'), page.indexOf('function pulseForDelta'));
  const remount = apply.slice(0, apply.indexOf('return; }'));
  ok('engine remount re-applies the mode', /applyOverlay/.test(remount));
  ok('and the normal path applies it too', (apply.match(/applyOverlay/g) || []).length >= 2);
}

// ── the toggle obeys the same Pro rule as the rest of the page ──
{
  const w = ctl.slice(ctl.indexOf('function wireTop'), ctl.indexOf('function wirePreviewOnly'));
  ok('it gates the write behind proApply()', /if \(!proApply\(\)\)/.test(w));
  ok('and reverts the checkbox when refused', /e\.target\.checked = !on/.test(w));
  ok('it never writes cfg before the gate', w.indexOf('cfg.overlay') > w.indexOf('proApply()'));
}
ok('the bridge exposes the command', /setWallpaperOverlay: \(on\) => invoke\('set_wallpaper_overlay'/.test(bridge));
ok('the command is registered in Rust', /set_wallpaper_overlay,/.test(rs));
ok('the mode is persisted, not just applied', /o\.insert\("overlay"\.into\(\)/.test(rs));
ok('and read back when the wallpaper is shown', /get\("overlay"\)\.and_then\(\|v\| v\.as_bool\(\)\)/.test(rs));

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
