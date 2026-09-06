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
const js = ['app.js', 'install.js', 'diag.js', 'terse-web.js', 'capture.js', 'beds.js', 'social.js']
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
for (const [tab, fn] of [['plaza', 'loadPlaza'], ['friends', 'loadFriends'], ['room', 'renderRoom'], ['me', 'renderMe']]) {
  ok(`switching to ${tab} calls ${fn}`, show.includes(fn));
}

/* A render that draws into a card must be called from the render that OWNS
   that card. Getting this wrong is invisible: the section is simply absent
   unless you first visit the tab it used to live on. It happened five separate
   times before the wallpaper deployment card — which owned most of them — was
   removed. The backdrops outlived it, so they are the one still worth pinning:
   they belong to the field, which every state has, including a guest who never
   signs in. */
const openApp = appJs.slice(appJs.indexOf('function openApp('),
  appJs.indexOf('function openApp(') + 1200);
ok('renderBeds() is painted on open, not from a tab hook', openApp.includes('renderBeds()'));
ok('and so are the styles', openApp.includes('renderStyles()'));

// ── WebGL contexts ──
// iOS gives a page very few, and this app holds two before a capture starts:
// the full-screen field and the one inside the phone preview. A capture asking
// for a third killed the whole web app — Safari does not warn or degrade, it
// reloads or goes blank, which is what "Deploy does nothing" turned out to be.
// Desktop allows far more, so it never reproduced here.
// Contexts are still released and restored — the field itself has not
// changed — but every caller that used to do it was part of the wallpaper
// deployment, so only the invariant survives, not the list of callers.
// Restoring matters as much: leaving the app with no field at all is worse than
// whatever failure got us there, so it must happen on the failure path too.
ok('releaseFields is always paired with restoreFields',
  (appJs.match(/releaseFields\(\)/g) || []).length
    <= (appJs.match(/restoreFields\(\)/g) || []).length);
ok('restoreFields rebuilds the main field', /function restoreFields\(\)[\s\S]{0,200}mountEngine\(\)/.test(appJs));


/* ── The cache stamp has to cover what the page LOADS ────────────────────
   This is the bug that cost the most and showed the least. The engine, the
   project layer and the shaders are shared with the Mac and served from
   /app-assets out of src/renderer — but the stamp was computed from six files
   under landing/ alone. So every renderer fix shipped with an unchanged stamp,
   an unchanged URL, and a phone that went on serving the old engine out of
   cache. The fix was deployed and never fetched, repeatedly.

   Two halves, and BOTH fail silently:
     · an import without ?v= is one a CDN can keep serving after it changed
     · a file missing from ENGINE_ASSETS does not move the stamp when edited */
{
  const server = fs.readFileSync(path.join(dir, '..', '..', 'api', 'server.js'), 'utf8');
  const appjs = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

  const imports = [...appjs.matchAll(/import\(\s*'\/app-assets\/([a-z0-9.-]+\.js)'\s*(\+?)/gi)];
  ok('the app imports something from /app-assets at all', imports.length > 0);
  for (const m of imports) {
    ok(`${m[1]} is imported with a cache stamp`, m[2] === '+');
  }

  const listed = (server.match(/const ENGINE_ASSETS = \[([\s\S]*?)\]/) || [])[1] || '';
  for (const m of imports) {
    ok(`${m[1]} is in ENGINE_ASSETS, so editing it moves the stamp`,
       listed.includes("'" + m[1] + "'"));
  }
  // rooms.js is loaded by a plain <script> from /app-assets rather than an
  // import, so the regex above cannot see it — and it changes often.
  ok('rooms.js is in ENGINE_ASSETS too', listed.includes("'rooms.js'"));
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
