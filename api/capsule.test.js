/**
 * 胶囊 · the code city has to survive the round trip.
 *
 *   node api/capsule.test.js
 *
 * This test exists because of how this fails. The scanner sends a city, the
 * server stores what it recognises, and the phone draws what it is given — and
 * a field name that does not match is not an error anywhere in that chain. The
 * renderer simply leaves a layer out, and what you see is a project with no
 * city, which is indistinguishable from a project that never had one.
 *
 * That is exactly what had been happening: sanitize() dropped every city field,
 * so no capsule in the plaza has ever carried one.
 *
 * So the shapes here are copied from the Rust structs in
 * src-tauri/src/projects.rs, and they are the point of the test:
 *   · a constellation is {n, e, c} — NOT {nodes, edges}
 *   · a hot file is {name, churn, bytes, dir} — NOT {path, ...}
 *   · a building keeps lang / depth / age_days / churn, which are its colour,
 *     its setbacks, the warmth of its windows and its beacon
 *   · a kid is a THREE-tuple [name, files, bytes]
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n)));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);
const same = (n, g, w) => eq(n, JSON.stringify(g), JSON.stringify(w));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/projects', require('./projects'));
const server = http.createServer(app);

function req(method, path, { identity, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Shaped exactly as projects.rs for_upload() sends it.
const CITY = {
  id: 'cap1', title: 'Terse', subtitle: 'a floating monitor',
  files: 805, langs: [['JavaScript', 0.62], ['Rust', 0.28]],
  style: 'modern',
  dirs: [
    { name: 'src', files: 180, bytes: 962560, lang: 'JavaScript',
      langs: [['JavaScript', 0.7], ['CSS', 0.3]], kind: 'source',
      kids: [['src/renderer', 90, 480000], ['src/helpers', 12, 40000]],
      depth: 4, age_days: 2, churn: 310 },
    { name: 'api', files: 64, bytes: 440320, lang: 'JavaScript',
      langs: [['JavaScript', 1]], kind: 'source', kids: [], depth: 1, age_days: 0, churn: 220 },
    { name: 'docs', files: 88, bytes: 327680, lang: 'Markdown',
      langs: [['Markdown', 1]], kind: 'docs', kids: [], depth: 2, age_days: 40, churn: 12 },
    { name: 'tests', files: 42, bytes: 153600, lang: 'JavaScript',
      langs: [['JavaScript', 1]], kind: 'test', kids: [], depth: 1, age_days: 9, churn: 30 },
  ],
  links: [[0, 1, 9], [1, 2, 3], [0, 3, 5]],
  commits: Array.from({ length: 371 }, (_, i) => i % 7),
  graph: {
    n: [[-400, 120, 0, 6, 0], [300, -80, 40, 4, 1], [10, 400, -30, 3, 0],
        [-120, -350, 15, 5, 2], [420, 260, -60, 2, 1]],
    e: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 0]],
    c: ['renderer', 'api', 'native'],
  },
  hot: [
    { name: 'renderer/app.js', churn: 312, bytes: 140000, dir: 'src' },
    { name: 'api/server.js', churn: 221, bytes: 98000, dir: 'api' },
    { name: 'src/optimizer.js', churn: 180, bytes: 52000, dir: 'src' },
  ],
  people: [['luzgool', 412], ['James', 88]],
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const me = 'city-' + crypto.randomBytes(8).toString('hex');

  const put = await req('POST', '/projects', { identity: me, body: { capsule: CITY } });
  eq('a capsule with a city publishes', put.status, 200);

  const list = (await req('GET', '/projects/public?limit=50', { identity: me })).json;
  const got = list.projects.find((p) => p.id === put.json.id);
  ok('and comes back out', !!got);
  const c = got.capsule;

  console.log('\n── the city survives ──');
  eq('the capsule says it has one', c.v, 2);
  eq('every building', c.dirs.length, 4);
  same('with its whole design intact', c.dirs[0], CITY.dirs[0]);
  ok('including the colour of it', c.dirs[0].lang === 'JavaScript');
  ok('the setbacks', c.dirs[0].depth === 4);
  ok('how warm the windows are', c.dirs[0].age_days === 2);
  ok('and the beacon on the busiest one', c.dirs[0].churn === 310);
  eq('a kid is still a three-tuple', c.dirs[0].kids[0].length, 3);
  same('the arcs between them', c.links, CITY.links);
  eq('the whole commit skyline', c.commits.length, 371);

  console.log('\n── the constellation is {n,e,c}, not {nodes,edges} ──');
  ok('it is there at all', !!c.graph);
  same('its nodes', c.graph.n, CITY.graph.n);
  same('its edges', c.graph.e, CITY.graph.e);
  same('and the community names', c.graph.c, CITY.graph.c);

  console.log('\n── hotspots keep the name the renderer reads ──');
  same('all of them', c.hot, CITY.hot);
  ok('each one still points at its building', c.hot[0].dir === 'src');

  console.log('\n── and the guards still hold ──');
  const bad = JSON.parse(JSON.stringify(CITY));
  bad.id = 'cap2';
  bad.links.push([99, 0, 1]);                 // points off the end of dirs
  bad.graph.e.push([77, 0]);                  // points off the end of the nodes
  bad.people.push(['leak@example.com', 5]);   // an address, not a person
  const put2 = await req('POST', '/projects', { identity: me, body: { capsule: bad } });
  const c2 = (await req('GET', '/projects/public?limit=50', { identity: me })).json
    .projects.find((p) => p.id === put2.json.id).capsule;
  eq('an arc into nowhere is dropped', c2.links.length, CITY.links.length);
  eq('so is an edge into nowhere', c2.graph.e.length, CITY.graph.e.length);
  eq('and an email never reaches the plaza', c2.people.length, 2);
  ok('leaving only names', c2.people.every((p) => p[0].indexOf('@') < 0));

  const short = crypto.createHash('sha256').update(me).digest('hex').slice(0, 32);
  for (const id of ['cap1', 'cap2']) db.deleteWallProject.run({ id: 'wp_' + crypto.createHash('sha256').update(short + '|' + id).digest('hex').slice(0, 16), identity: short });
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
