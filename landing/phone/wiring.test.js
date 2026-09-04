/**
 * Wiring contract test — the markup and the code that drives it.
 *
 *   node landing/phone/wiring.test.js
 *
 * This exists because the same failure happened FOUR times while building this
 * app, and none of the times produced an error:
 *
 *   · a button shipped with no handler at all, and silently did nothing
 *   · a render call left behind an early return, so a whole section only
 *     appeared if you happened to visit another tab first
 *   · a render call still driven from the tab a card used to live on, after
 *     the card moved to a different one
 *
 * Every one of those is a live element that looks fine and does nothing. Nothing
 * throws, nothing logs, and it takes a person tapping the exact control to
 * notice. So this asserts the two halves match: every id the code reaches for
 * exists in the markup, and every control in the markup is reached by the code.
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, '..', 'm.html'), 'utf8');
const js = ['app.js', 'install.js', 'diag.js', 'terse-web.js', 'capture.js', 'beds.js']
  .map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })
  .join('\n');

console.log('\nWiring\n');

// Every id that exists at runtime: the ones in the shell, plus the ones the
// code BUILDS. The install sheet is created and destroyed on demand and never
// appears in m.html, which is correct — it should not be in the markup when
// there is nothing to install.
const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) htmlIds.add(m[1]);
ok('the shell declares ids at all', htmlIds.size > 20);

const builtIds = new Set();
for (const m of js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) builtIds.add(m[1]);        // in template strings
for (const m of js.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)) builtIds.add(m[1]);  // assigned to an element
const knownIds = new Set([...htmlIds, ...builtIds]);

// Every id the code reaches for, via $('x') or getElementById('x').
const wanted = new Map();
for (const m of js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) wanted.set(m[1], '$()');
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) wanted.set(m[1], 'getElementById');

// ── Half one: the code must not reach for markup that is not there ──
// A typo or a removed element here is a silent null, and the very next property
// access throws inside whatever render pass touched it — taking the rest of that
// pass down with it.
for (const [id, how] of wanted) {
  const where = htmlIds.has(id) ? 'shell' : (builtIds.has(id) ? 'built at runtime' : null);
  ok(`${id} exists ${where || 'NOWHERE'} (used via ${how})`, !!where);
}

// ── Half two: every control in the markup must be driven ──
// A <button> with no handler is the failure that shipped: it looks live, it
// depresses when tapped, and nothing happens.
const buttons = [];
for (const m of html.matchAll(/<button[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>/g)) buttons.push(m[1]);
for (const m of html.matchAll(/<a[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>/g)) buttons.push(m[1]);
ok('the shell has controls to check', buttons.length > 5);

/* Controls whose behaviour is not a handler of their own, with the reason.
   Anything added here has to be justified — the point of the list is that it is
   short and every entry is deliberate. */
const DRIVEN_ELSEWHERE = {
  // Its href is assigned in renderWall; it is a link, not a button.
  wallShortcut: 'href set in renderWall',
  // A static href in the markup. It is only shown on iOS — checked below,
  // because shortcuts:// fails silently everywhere else and a link that does
  // nothing is the exact problem this file exists to catch.
  wallOpenShortcuts: 'static shortcuts:// href, gated to iOS',
};

for (const id of buttons) {
  if (DRIVEN_ELSEWHERE[id]) {
    ok(`${id} is driven elsewhere (${DRIVEN_ELSEWHERE[id]})`, wanted.has(id));
    continue;
  }
  // Bound either by the on($('x'), …) helper or a direct .onclick assignment.
  const bound = new RegExp(`on\\(\\$\\('${id}'\\)|\\$\\('${id}'\\)\\.onclick`).test(js);
  ok(`${id} has a handler`, bound);
}

// ── Half three: tab-scoped renders ──
// Cards moved between tabs twice, and their render stayed behind. Every render
// that draws into a tab must be reachable from the code that switches to it.
const appJs = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const show = appJs.slice(appJs.indexOf('function show(tab)'), appJs.indexOf('function show(tab)') + 1400);
for (const [tab, fn] of [['plaza', 'loadPlaza'], ['friends', 'loadFriends'], ['room', 'renderRoom'], ['me', 'renderMe'], ['wallpaper', 'renderWall']]) {
  ok(`switching to ${tab} calls ${fn}`, show.includes(fn));
}

/* A render that draws into a card must be called from the render that OWNS
   that card. Getting this wrong is invisible: the section is simply absent
   unless you first visit the tab it used to live on. It has happened five
   times in this file — renderBeds, renderWall itself and renderWallSteps.
   (renderPhoneChrome and the in-app phone preview were two more, and were
   removed with the wallpaper deployment UI rather than fixed again.) */
const renderWallFull = appJs.slice(appJs.indexOf('function renderWall()'),
  appJs.indexOf('function loadWall()'));
for (const fn of ['renderBeds()', 'renderWallSteps()']) {
  ok(`${fn} is called by renderWall, which owns that card`, renderWallFull.includes(fn));
}
const renderMeFull = appJs.slice(appJs.indexOf('function renderMe()'),
  appJs.indexOf('function renderMe()') + 2600);
ok('and renderMe no longer draws the wallpaper card',
  !renderMeFull.includes('renderWallSteps()') && !renderMeFull.includes('renderWall()'));

// The two that were left behind an early return. They draw local content and
// must not wait on an API round-trip that may never happen.
const renderWall = appJs.slice(appJs.indexOf('function renderWall()'), appJs.indexOf('function renderWall()') + 900);
const guard = renderWall.indexOf('if (!wallState) return;');
for (const fn of ['renderBeds()']) {
  const at = renderWall.indexOf(fn);
  ok(`${fn} runs before the wallState guard`, at > 0 && (guard < 0 || at < guard));
}

// ── WebGL contexts ──
// iOS gives a page very few, and this app holds two before a capture starts:
// the full-screen field and the one inside the phone preview. A capture asking
// for a third killed the whole web app — Safari does not warn or degrade, it
// reloads or goes blank, which is what "Deploy does nothing" turned out to be.
// Desktop allows far more, so it never reproduced here.
for (const [fn, why] of [
  ['captureRing', 'the 12-frame deploy'],
  ['captureOverlay', 'the transparent layer'],
]) {
  const at = appJs.indexOf(`function ${fn}(`);
  ok(`${fn} exists`, at > 0);
  if (at < 0) continue;
  const body = appJs.slice(at, at + 2600);
  ok(`${fn} frees the other contexts first (${why})`, body.includes('releaseFields()'));
}

// The video path holds a context for its whole four-second encode.
const videoAt = appJs.indexOf("on($('wallVideo')");
const videoBody = videoAt > 0 ? appJs.slice(videoAt, videoAt + 2600) : '';
ok('the Live Photo encode frees them too', videoBody.includes('releaseFields()'));

// Restoring matters as much: leaving the app with no field at all is worse than
// whatever failure got us there, so it must happen on the failure path too.
ok('releaseFields is always paired with restoreFields',
  (appJs.match(/releaseFields\(\)/g) || []).length
    <= (appJs.match(/restoreFields\(\)/g) || []).length);
ok('restoreFields rebuilds the main field', /function restoreFields\(\)[\s\S]{0,200}mountEngine\(\)/.test(appJs));

// The generic failure message sent me looking in the wrong place for a day.
ok('a capture failure reports the actual reason', /wall_failed'\) \+ \(err && err\.message/.test(appJs));

// The one deep link iOS honours, and only there. There is no scheme for the
// Automation tab, and App-Prefs stopped navigating to a Settings category in
// iOS 18 — so this is the only one worth shipping, and it must not appear on
// platforms where it silently does nothing.
ok('the Shortcuts link is a shortcuts:// href', /id="wallOpenShortcuts"[^>]*href="shortcuts:\/\//.test(html)
  || /href="shortcuts:\/\/"[^>]*id="wallOpenShortcuts"/.test(html));
ok('and is hidden off iOS', /wallOpenShortcuts'\)\.classList\.toggle\('hide', !isIOS\)/.test(appJs));

/* The copy box must offer the FRAME link.
   It preferred the overlay when one existed, and handing that transparent layer
   to Set Wallpaper fails as "com.apple.extensionKit.errorDomain 错误 2" — a
   message that says nothing about the cause and cost hours to trace. */
ok('the copy box uses the frame URL', /\$\('wallUrl'\)\.value = wallState\.url;/.test(appJs));
ok('and never prefers the overlay link there', !/wallUrl'\)\.value = [^;]*overlay_url/.test(appJs));

/* Uploads run a few at a time. A serial chain of twelve is only as reliable as
   its unluckiest request: one stall blocks the rest, which is how the button
   reached "12/12" with a single frame stored. */
ok('frames upload with bounded concurrency', /Promise\.all\(\[worker\(\), worker\(\), worker\(\)\]\)/.test(appJs));
ok('and each has a deadline', /AbortSignal\.timeout\(/.test(appJs));

/* Each upload takes a FRESH token. A Clerk session token lives about a minute
   and a capture plus a dozen uploads takes longer, so one token fetched for the
   whole run meant the first frame stored and every later one came back 401 —
   which is exactly how a real account ended up with one frame and a "session
   expired" message. */
const upFn = appJs.slice(appJs.indexOf('function uploadFrame('),
  appJs.indexOf('function uploadFrame(') + 900);
ok('each upload fetches its own token', /T\.authToken\(\)/.test(upFn));
ok('and uploadFrame is not handed a stale one', !/function uploadFrame\(tok/.test(appJs));
ok('and one retry', /if \(retried\) throw err;/.test(appJs));

// Progress counts COMPLETIONS. The old label was set before each request and
// showed 12/12 while eleven were still in flight.
ok('progress counts completions, not attempts', /done\+\+;/.test(appJs));
ok('and a partial upload is an error, not a success', /frame\(s\) failed to upload/.test(appJs));
ok('the result reports how many frames landed', /wall_frames'\)\.replace\('\{n\}', n\)/.test(appJs));

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
