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
// The desktop path passes nil ON PURPOSE. AppKit calls backgroundColor
// non-nullable and I "corrected" it to blackColor on that basis; the resulting
// build was visibly wrong and the nil build was right. The assertion therefore
// pins the observed-good behaviour, not the documented one — and this comment
// exists so the next person does not re-fix it from the docs.
ok('desktop keeps the nil background that actually renders correctly', /setBackgroundColor: nil/.test(fn));
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
  // The gate is deliberately ASYMMETRIC: it blocks turning the overlay ON and
  // always lets it be turned OFF. Both directions used to go through the gate,
  // which meant a slow or offline licence check locked the user inside a layer
  // covering their whole screen — the worst possible thing to put behind a
  // paywall. These assertions pin that asymmetry so it cannot be "tidied" back.
  ok('it gates turning it ON behind the live licence check', /if \(on && !\(await proApplyLive\(\)\)\)/.test(w));
  ok('and reverts the checkbox when refused', /e\.target\.checked = false/.test(w));
  ok('but never gates turning it OFF', !/if \(!\(await proApplyLive\(\)\)\)/.test(w));
  ok('it never writes cfg before the gate', w.indexOf('cfg.overlay') > w.indexOf('proApplyLive()'));
}

// ── Windows must answer the same questions Mac does ──
//
// The shared page asks Rust for the effective state at boot and then listens for
// changes; Windows had neither the command nor the event, so the page fell back
// to its own guess and the two halves could disagree about whether a lifted
// window should paint a background. Level and paint must come from ONE answer on
// both platforms, so the Windows half is asserted here too.
{
  const win = readFileSync(R + '../../windows-app/src-tauri/src/lib.rs', 'utf8');
  ok('windows has one function that decides it', /fn overlay_allowed\(cfg: &serde_json::Value\) -> bool/.test(win));
  ok('windows checks the engine veto', /matches!\(engine, "mineradio" \| "cinematic"\)/.test(win));
  ok('windows checks entitlement in Rust, not only in the UI', /License::load\(\)\.is_pro\(\)/.test(win));
  ok('windows exposes the effective state to the page', /fn wallpaper_overlay_effective\(\) -> bool/.test(win));
  ok('windows can re-level without persisting', /fn relevel_wallpaper_window\(on: bool/.test(win));
  ok('both commands are registered', /wallpaper_overlay_effective,[\s\S]{0,80}relevel_wallpaper_window,/.test(win));
  ok('windows announces the answer to the page', /emit\("wallpaper-overlay"/.test(win));
  ok('the windows wallpaper window is built transparent', /"wallpaper"[\s\S]{0,1400}\.transparent\(true\)/.test(win));
  // WS_EX_LAYERED replaces DWM's per-pixel alpha with one uniform alpha, so every
  // pixel the page leaves transparent composites as BLACK. It was added as
  // insurance and destroyed the thing it was insuring.
  ok('the overlay never re-adds WS_EX_LAYERED', !/add = \([\s\S]{0,120}WS_EX_LAYERED\.0/.test(win));
  ok('and clears it if an older build left it on', /& !\(WS_EX_LAYERED\.0 as isize\)/.test(win));
}

// ── a page that never boots must not be able to cover the screen ──
//
// The module needs a WebGL context. Where it cannot get one, `new E(...)` throws
// and boot() dies before it ever applies the overlay class - so the page keeps
// painting `html{background:#05060a}` and the native half faithfully lifts that
// to the top of the z-order. CI measured exactly this: twenty frames sampled
// over time, byte-identical, on three different commits.
ok('the dead-man\'s switch is a classic script, so a module failure still reports',
   page.indexOf('wallpaperDeadMansSwitch') < page.indexOf('<script type="module">'));
ok('a page that never boots drops its background', /__terseWallpaperBooted[\s\S]{0,400}classList\.add\('overlay'\)/.test(page));
ok('and asks Rust to put it back on the desktop layer', /__terseWallpaperBooted[\s\S]{0,600}relevelWallpaperWindow\(false\)/.test(page));
ok('boot decides the background BEFORE mounting the engine',
   (() => { const b = page.slice(page.indexOf('async function boot()'));
            return b.indexOf('applyOverlay(overlayOK())') < b.indexOf('mountEngine()'); })());
ok('and a throwing engine cannot skip the rest of boot', /try \{\s*mountEngine\(\);\s*\} catch/.test(page));

// ── no await in boot may be unbounded ──
//
// This is the real Windows failure, reproduced in a browser with a bridge whose
// every call never settles: boot() stalled on its FIRST line and the page froze
// before it could apply the overlay class. It looked fine on a Mac dev machine
// for the worst possible reason - with no `window.terse` the same call throws
// instantly instead of hanging, so the bug was invisible exactly where it was
// being looked for.
ok('boot bounds the calls that can hang', /function settle\(p, ms, tag\)/.test(page));
['getWallpaperConfig', 'refreshEntitlement', 'wallpaperOverlayEffective'].forEach(c =>
  ok(`${c} is bounded`, new RegExp("settle\\([^)]*" + c + "[\\s\\S]{0,80}?\\d{3,4},\\s*'" + c + "'").test(page)
                        || new RegExp("settle\\(" + c + "\\(\\), \\d+, '" + c + "'").test(page)));
ok('a call that never answers is named in the log', /DID NOT ANSWER in/.test(page));

// "We could not find out" is not "the overlay is off", and only one of those is
// safe to paint a background for.
ok('an unsure boot goes transparent', /bootUnsure[\s\S]{0,500}classList\.add\('overlay'\)/.test(page));
ok('an unsure boot drops to the desktop layer', /bootUnsure[\s\S]{0,700}relevelWallpaperWindow\(false\)/.test(page));

// ── the page reports what it actually painted ──
//
// Four diagnoses of this feature were wrong because a black screenshot was the
// only evidence, and a black screenshot cannot tell "the page painted its own
// background" from "the page went transparent and the compositor painted black".
ok('the page logs its computed background', /htmlBg=' \+ cs\.backgroundColor/.test(page));
ok('and whether the class actually landed', /class=' \+ document\.documentElement\.classList\.contains\('overlay'\)/.test(page));
ok('the bridge exposes the command', /setWallpaperOverlay: \(on\) => invoke\('set_wallpaper_overlay'/.test(bridge));
ok('the command is registered in Rust', /set_wallpaper_overlay,/.test(rs));
ok('the mode is persisted, not just applied', /o\.insert\("overlay"\.into\(\)/.test(rs));
ok('and read back when the wallpaper is shown', /get\("overlay"\)\.and_then\(\|v\| v\.as_bool\(\)\)/.test(rs));

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
