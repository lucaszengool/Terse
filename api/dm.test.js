/**
 * 私信 · the gate, the single thread, and the friends bridge.
 *
 *   node api/dm.test.js
 *
 * What is worth pinning down here is the GATE, because it is the whole design:
 * a stranger can only write to you with a reason — a project you published —
 * and a friend needs no reason at all. Everything else (a pair of people
 * sharing one thread in both directions, unread counts) falls out of that.
 *
 * The friends bridge gets its own test because it is the one place where two
 * different id spaces have to line up: friends store a 64-char hash, the plaza
 * and this router a 32-char one, and they agree only because the short id is
 * the long id's prefix. If anyone ever changes either derivation, this is the
 * test that goes red.
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n)));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

const app = express();
app.use(express.json());
app.use('/dm', require('./dm'));
app.use('/friends', require('./friends'));
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

const short = (raw) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
const full = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const id = (n) => `${n}-${crypto.randomBytes(8).toString('hex')}`;
  const author = id('author'), fan = id('fan'), pal = id('pal');

  // The author publishes something, because publishing IS what opens the door.
  const pubd = await req('POST', '/projects', {
    identity: author,
    body: { capsule: { id: 'p1', title: 'a thing', subtitle: 'made of particles' } },
  });
  eq('a project publishes', pubd.status, 200);
  const projectId = pubd.json.id;

  console.log('\n── the gate ──');
  eq('no identity, no messages', (await req('GET', '/dm')).status, 401);
  eq('a stranger with no reason is refused',
     (await req('POST', `/dm/${short(author)}`, { identity: fan, body: { body: 'hi' } })).status, 403);
  eq('someone else\'s project is not a reason',
     (await req('POST', `/dm/${short(pal)}`, { identity: fan, body: { body: 'hi', projectId } })).status, 403);
  eq('the author\'s own project is',
     (await req('POST', `/dm/${short(author)}`, { identity: fan, body: { body: 'I liked this', projectId } })).status, 200);
  // The gate does NOT open just because you already knocked: until the other
  // person answers, every message still has to name the project. Otherwise one
  // accepted knock would buy an unlimited channel to a stranger, which is the
  // exact thing being prevented.
  eq('knocking once does not open the door',
     (await req('POST', `/dm/${short(author)}`, { identity: fan, body: { body: 'one more thing' } })).status, 403);
  eq('the reason still works, though',
     (await req('POST', `/dm/${short(author)}`, { identity: fan, body: { body: 'one more thing', projectId } })).status, 200);

  console.log('\n── one thread, both directions ──');
  const inbox = (await req('GET', '/dm', { identity: author })).json;
  const line = inbox.threads.find((t) => t.peer === short(fan));
  ok('it lands in the author\'s inbox', !!line);
  eq('as one line, not two messages', line.count, 2);
  eq('both unread', line.unread, 2);
  eq('the inbox totals them', inbox.unread >= 2, true);

  const thread = (await req('GET', `/dm/${short(fan)}`, { identity: author })).json;
  eq('the thread holds both', thread.messages.length, 2);
  eq('and they are not mine', thread.messages[0].mine, false);
  eq('opening it is reading it', (await req('GET', '/dm', { identity: author })).json.threads
    .find((t) => t.peer === short(fan)).unread, 0);
  eq('the fan sees the same thread from the other side',
     (await req('GET', `/dm/${short(author)}`, { identity: fan })).json.messages.length, 2);
  eq('and there they are mine',
     (await req('GET', `/dm/${short(author)}`, { identity: fan })).json.messages[0].mine, true);
  eq('the fan is told the line is still closed',
     (await req('GET', `/dm/${short(author)}`, { identity: fan })).json.open, false);

  console.log('\n── answering is what opens it ──');
  eq('the author writes back', (await req('POST', `/dm/${short(fan)}`,
     { identity: author, body: { body: 'thank you' } })).status, 200);
  eq('and now the fan needs no reason',
     (await req('POST', `/dm/${short(author)}`, { identity: fan, body: { body: 'anytime' } })).status, 200);

  console.log('\n── a friend needs no reason ──');
  eq('before befriending, pal cannot write to the author',
     (await req('POST', `/dm/${short(pal)}`, { identity: author, body: { body: 'hello' } })).status, 403);
  const link = (await req('POST', '/friends/link', { identity: pal })).json;
  ok('pal has a friend code', !!link.token);
  eq('the author opens it', (await req('POST', `/friends/link/${link.token}/accept`, { identity: author })).status, 200);
  eq('now the line is open with no project at all',
     (await req('POST', `/dm/${short(pal)}`, { identity: author, body: { body: 'hello' } })).status, 200);
  eq('and the thread says so before you type',
     (await req('GET', `/dm/${short(pal)}`, { identity: author })).json.open, true);

  console.log('\n── the friends list can address a friend ──');
  const fl = (await req('GET', '/friends', { identity: author })).json;
  const edge = fl.friends.find((f) => f.peer === short(pal));
  ok('the friend row carries the id you message', !!edge);
  eq('which is the same id the plaza uses', edge && edge.peer, short(pal));
  eq('and never the full hash', edge && edge.peer.length, 32);

  console.log('\n── nobody talks to themselves ──');
  eq('sending to yourself is a bad request',
     (await req('POST', `/dm/${short(author)}`, { identity: author, body: { body: 'hi me' } })).status, 400);

  // Clean up after ourselves: this runs against the real dev database.
  for (const who of [author, fan, pal]) {
    const s = short(who), f = full(who);
    db.db.prepare('DELETE FROM dm_messages WHERE from_id = ? OR to_id = ?').run(s, s);
    for (const e of db.listFriendEdges.all(f, f)) db.deleteFriend.run(e.id);
    db.db.prepare('DELETE FROM friend_invites WHERE owner_hash = ?').run(f);
    db.deleteWallProject.run({ id: projectId, identity: s });
  }
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
