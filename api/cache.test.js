/**
 * Cache-policy contract test.
 *
 *   node api/cache.test.js
 *
 * This exists because of a failure with no local symptom at all. A CDN in front
 * of the app was observed serving sw.js and the phone scripts SIX AND A HALF
 * HOURS after they changed (age: 23435 against a five-minute max-age,
 * cf-cache-status: HIT). Everything looked correct on the origin, the deploy had
 * succeeded, and users still had the old app — because a stale service worker
 * serves its own stale cache of everything else, so one old copy of that single
 * file pins the whole app to the version that shipped with it.
 *
 * So: assert that the paths which must never be held by an intermediary are
 * covered, and that the ones which SHOULD stay cacheable are not swept up.
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

const m = server.match(/const NEVER_CACHE = (\/.*\/);/);
if (!m) { console.error('could not find NEVER_CACHE in server.js'); process.exit(1); }
// eslint-disable-next-line no-eval
const re = eval(m[1]);

console.log('\nCache policy\n');
console.log('  pattern: ' + re + '\n');

// The service worker is the load-bearing one: stale here means stale everywhere.
ok('sw.js is never cached', re.test('/sw.js'));
ok('the manifest is never cached', re.test('/manifest.webmanifest'));
// The shell and its routes — client-side routed, so every one of them is /m.html.
ok('/m is never cached', re.test('/m'));
ok('/m/wallpaper is never cached', re.test('/m/wallpaper'));
ok('/m/pair is never cached', re.test('/m/pair'));
// The app's own code, which must match the API it talks to.
ok('the phone app script is never cached', re.test('/phone/app.js'));
ok('the shim is never cached', re.test('/phone/terse-web.js'));
ok('the capture code is never cached', re.test('/phone/capture.js'));
ok('diag is never cached', re.test('/phone/diag.js'));

/* The wallpaper images. Each fetch returns the NEXT frame, which is the whole
   mechanism behind the Shortcut loop being an animation. The edge held one for
   46 minutes and served it to everything, so a correct twelve-frame deploy was
   indistinguishable from a broken one-frame deploy. */
ok('wallpaper frames are never cached', re.test('/w/abc123.png'));
ok('nor the transparent overlay', re.test('/w/abc123.overlay.png'));
ok('nor the Live Photo clip', re.test('/w/abc123.mp4'));

// The other side of the contract. These are large, they change rarely, and the
// service worker revalidates them itself — sweeping them in would mean
// re-downloading three quarters of a megabyte of Three.js on every launch.
ok('the engines stay cacheable', !re.test('/app-assets/mineradio-wallpaper.js'));
ok('Three.js stays cacheable', !re.test('/app-assets/vendor/three.module.min.js'));
ok('icons stay cacheable', !re.test('/icon-192.png'));
// And the marketing site is untouched.
ok('the landing page stays cacheable', !re.test('/'));
ok('blog posts stay cacheable', !re.test('/ai-token-pricing-comparison.html'));
ok('the install page stays cacheable', !re.test('/mobile'));

// The header actually sent must forbid storage, not merely suggest freshness:
// a max-age is advice this CDN has already been seen to ignore.
const block = server.slice(server.indexOf('const NEVER_CACHE'), server.indexOf('const NEVER_CACHE') + 900);
ok('it sends no-store, not just a short max-age', /no-store/.test(block));
ok('and must-revalidate', /must-revalidate/.test(block));
ok('sw.js is allowed root scope', /Service-Worker-Allowed/.test(block));

// Order matters: the header middleware has to run BEFORE express.static, or
// static answers the request first and the policy never applies.
const policyAt = server.indexOf('const NEVER_CACHE');
const staticAt = server.indexOf("express.static(path.join(__dirname, '..', 'landing')");
ok('the policy is registered before the static mount', policyAt > 0 && staticAt > policyAt);

// ── Build stamping ──
// The header policy above fixed the HTML, but it cannot evict an entry the edge
// already holds for the scripts — and that entry was six hours old. A version in
// the URL is the only lever that works from the origin: a new build is a new
// URL, so there is nothing to hit.
ok('the shell is rewritten, not sent as a file', /fs\.readFile\(file, 'utf8'/.test(server));
ok('phone scripts get the build stamp', /src="\)\(\\\/phone/.test(server) || /\/phone\\\/\[a-z0-9/.test(server));
ok('the stamp is derived from the files themselves', /statSync\(path\.join\(__dirname, '\.\.', 'landing', rel\)\)/.test(server));
ok('and computed once, not per request', /const PHONE_BUILD = buildStamp\(\);/.test(server));
ok('sw.js is among the stamped files', /PHONE_ASSETS = \[[^\]]*'sw\.js'/.test(server));
ok('the build is handed to the page', /__TERSE_BUILD/.test(server));

// Ordering again, and for the same reason as the policy: express.static is
// mounted with extensions:['html'], so it answers /m with m.html directly and a
// handler registered after it never runs.
const mAt = server.indexOf("app.get(['/m', '/m/*']");
ok('the /m handler is registered before the static mount', mAt > 0 && staticAt > mAt);

// The engines must NOT be stamped: three quarters of a megabyte of Three.js plus
// shaders shared with the desktop, re-downloaded on every deploy, would cost far
// more than it saves.
ok('the engines are left unstamped', !/app-assets[^\n]*\?v=/.test(server));

console.log(`\n${pass} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
