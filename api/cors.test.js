/**
 * CORS contract test.
 *
 *   node api/cors.test.js
 *
 * This exists because of a failure with no server-side symptom: if the renderer
 * sends a custom header that Access-Control-Allow-Headers does not list, the
 * BROWSER rejects the preflight and never sends the real request. Nothing is
 * logged, no route is hit, and the app shows only "Load failed". Shipping the
 * rooms client with x-terse-room-key unlisted did exactly that.
 *
 * So: read the headers the renderer actually sets, read the list the API
 * actually allows, and assert the first is a subset of the second.
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

// Both browser clients, because both are subject to the same preflight: the
// desktop renderer, and the phone web app served off landing/. The phone was the
// second surface to learn this the hard way — it sends x-terse-device.
const DIRS = [
  path.join(__dirname, '..', 'src', 'renderer'),
  path.join(__dirname, '..', 'landing'),
  path.join(__dirname, '..', 'landing', 'phone'),
];
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

const m = server.match(/Access-Control-Allow-Headers['"],\s*['"]([^'"]+)['"]/);
if (!m) { console.error('could not find the Allow-Headers list in server.js'); process.exit(1); }
const allowed = new Set(m[1].split(',').map(s => s.trim().toLowerCase()));
console.log('\nallowed: ' + [...allowed].join(', ') + '\n');

// Every x-terse-* header the renderer sets, wherever it sets it.
const sent = new Map();   // header → files that send it
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') && !f.endsWith('.html')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const hit of src.matchAll(/['"](x-terse-[a-z-]+)['"]/gi)) {
      const h = hit[1].toLowerCase();
      if (!sent.has(h)) sent.set(h, []);
      if (!sent.get(h).includes(f)) sent.get(h).push(f);
    }
  }
}

ok('the renderer sends at least one custom header (test is wired up)', sent.size > 0);
for (const [h, files] of sent) {
  ok(`${h} is allowed — sent by ${files.join(', ')}`, allowed.has(h));
}

// The methods the room client uses must be allowed too; DELETE is easy to miss.
const methods = (server.match(/Access-Control-Allow-Methods['"],\s*['"]([^'"]+)['"]/) || [, ''])[1]
  .split(',').map(s => s.trim().toUpperCase());
for (const verb of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
  ok(`${verb} is allowed`, methods.includes(verb));
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
process.exit(fails.length ? 1 : 0);
