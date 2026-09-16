/**
 * 举报 · 拉黑 — reports reach a table, blocks hold across DMs, comments and rooms.
 *
 *   node api/safety.test.js
 *
 * The rule worth pinning is that a block is ONE thing: made from a room line, it
 * also stops the DMs, because the room's 64-char identity and the plaza's
 * 32-char one are the same person. If either derivation drifts, the room half
 * of this goes red.
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
app.use('/projects', require('./projects'));
app.use('/rooms', require('./rooms'));
const server = http.createServer(app);

function req(method, path, { identity, key, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
        ...(key ? { 'x-terse-room-key': key } : {}),
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
const reportsFor = (kind, target) =>
  db.db.prepare('SELECT * FROM safety_reports WHERE kind = ? AND target_id = ?').all(kind, target);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const id = (n) => `${n}-${crypto.randomBytes(8).toString('hex')}`;
  const alice = id('alice'), troll = id('troll'), c1 = id('c1'), c2 = id('c2');
  const rooms = [];

  const pub = await req('POST', '/projects', {
    identity: alice, body: { capsule: { id: 'sp1', title: 'safety thing', subtitle: 'for the test' } } });
  eq('alice publishes', pub.status, 200);
  const projectId = pub.json.id;

  console.log('\n── DMs ──');
  eq('the troll writes, naming her project',
     (await req('POST', `/dm/${short(alice)}`, { identity: troll, body: { body: 'buy my coins', author: 'Troll', projectId } })).status, 200);
  ok('it is in her inbox', (await req('GET', '/dm', { identity: alice })).json.threads.some((t) => t.peer === short(troll)));

  const rep = await req('POST', `/dm/${short(troll)}/report`, { identity: alice, body: { reason: 'spam' } });
  eq('she reports the thread', rep.status, 200);
  const dmRows = reportsFor('dm', [short(alice), short(troll)].sort().join('|'));
  eq('one row in the table', dmRows.length, 1);
  ok('carrying what he actually said, read server-side', dmRows[0] && /buy my coins/.test(dmRows[0].excerpt));
  eq('naming who said it', dmRows[0] && dmRows[0].target_identity, short(troll));
  eq('with the reason', dmRows[0] && dmRows[0].reason, 'spam');
  await req('POST', `/dm/${short(troll)}/report`, { identity: alice, body: { reason: 'spam' } });
  eq('reporting twice is still one report', reportsFor('dm', dmRows[0].target_id).length, 1);
  eq('nothing to report from someone who never wrote',
     (await req('POST', `/dm/${short(c1)}/report`, { identity: alice, body: {} })).status, 404);

  const blk = await req('POST', `/dm/${short(troll)}/block`, { identity: alice, body: {} });
  eq('she blocks him', blk.status, 200);
  ok('his thread is gone from her inbox',
     !(await req('GET', '/dm', { identity: alice })).json.threads.some((t) => t.peer === short(troll)));
  const th = (await req('GET', `/dm/${short(troll)}`, { identity: alice })).json;
  eq('opening it shows none of his words', th.messages.filter((m) => !m.mine).length, 0);
  eq('and says it is blocked', th.blocked, true);
  eq('he can no longer write to her',
     (await req('POST', `/dm/${short(alice)}`, { identity: troll, body: { body: 'hello?', projectId } })).status, 403);
  eq('nor she to him until she unblocks',
     (await req('POST', `/dm/${short(troll)}`, { identity: alice, body: { body: 'go away' } })).status, 403);
  ok('he is not told: his side still reads',
     (await req('GET', `/dm/${short(alice)}`, { identity: troll })).json.messages.length >= 1);

  const list = (await req('GET', '/dm/blocks', { identity: alice })).json.blocks;
  eq('her blocked list has him', list.length, 1);
  eq('by the name he gave', list[0].name, 'Troll');
  ok('without his identity', !JSON.stringify(list).includes(short(troll)));
  eq('someone else cannot lift her block',
     (await req('DELETE', `/dm/blocks/${list[0].id}`, { identity: troll }), (await req('GET', '/dm/blocks', { identity: alice })).json.blocks.length), 1);
  eq('she unblocks', (await req('DELETE', `/dm/blocks/${list[0].id}`, { identity: alice })).status, 200);
  eq('and he can write again',
     (await req('POST', `/dm/${short(alice)}`, { identity: troll, body: { body: 'sorry', projectId } })).status, 200);

  console.log('\n── comments ──');
  const cm = (await req('POST', `/projects/${projectId}/comments`, { identity: troll, body: { body: 'rude words', author: 'Troll' } })).json.id;
  await req('POST', `/projects/${projectId}/comments`, { identity: c1, body: { body: 'nice one' } });
  const see = async (who) => (await req('GET', `/projects/${projectId}/comments`, { identity: who })).json.comments.map((c) => c.body);
  ok('everyone sees his comment', (await see(alice)).includes('rude words'));
  eq('you cannot report your own comment',
     (await req('POST', `/projects/comments/${cm}/report`, { identity: troll, body: {} })).status, 400);
  eq('alice blocks him from the comment',
     (await req('POST', `/projects/comments/${cm}/block`, { identity: alice })).status, 200);
  ok('she no longer sees it', !(await see(alice)).includes('rude words'));
  ok('others still do', (await see(c1)).includes('rude words'));
  ok('the rest of the thread is intact', (await see(alice)).includes('nice one'));

  const r1 = (await req('POST', `/projects/comments/${cm}/report`, { identity: c1, body: { reason: 'abuse' } })).json;
  await req('POST', `/projects/comments/${cm}/report`, { identity: c1, body: { reason: 'abuse' } });
  eq('one reporter is one vote', r1.reports, 1);
  ok('two reporters do not hide it',
     ((await req('POST', `/projects/comments/${cm}/report`, { identity: c2, body: {} })).json.hidden === false)
     && (await see(c2)).includes('rude words'));
  const r3 = (await req('POST', `/projects/comments/${cm}/report`, { identity: alice, body: {} })).json;
  eq('the third distinct reporter hides it', r3.hidden, true);
  ok('for everyone', !(await see(c2)).includes('rude words'));
  ok('but it is not deleted', !!db.getWallComment.get(cm));
  ok('the report kept the comment text as evidence', /rude words/.test(reportsFor('comment', cm)[0].excerpt));

  console.log('\n── rooms ──');
  const room = (await req('POST', '/rooms', { body: { name: 'safety', member_name: 'Alice', identity: alice } })).json;
  rooms.push(room);
  const aKey = room.key;
  const tj = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'Troll', identity: troll } })).json;
  const tKey = tj.key, tMember = tj.member_id;
  const line = (await req('POST', `/rooms/${room.room.id}/messages`, { key: tKey, body: { body: 'room spam' } })).json.message;
  await req('POST', `/rooms/${room.room.id}/messages`, { key: aKey, body: { body: 'hi all' } });
  eq('you cannot report your own line',
     (await req('POST', `/rooms/${room.room.id}/messages/${line.id}/report`, { key: tKey, body: {} })).status, 400);
  eq('alice reports his line',
     (await req('POST', `/rooms/${room.room.id}/messages/${line.id}/report`, { key: aKey, body: { reason: 'spam' } })).status, 200);
  const rr = reportsFor('room', line.id)[0];
  eq('the server read the line itself in a plain room', rr && rr.excerpt, 'room spam');
  eq('and knows who said it, in the short spelling', rr && rr.target_identity, short(troll));
  eq('a key for another room is refused',
     (await req('POST', `/rooms/${room.room.id}/messages/${line.id}/report`, { key: 'nope', body: {} })).status, 401);

  const rb = await req('POST', `/rooms/${room.room.id}/members/${tMember}/block`, { key: aKey });
  eq('she blocks him from the room', rb.status, 200);
  ok('and is told which member ids to drop live', rb.json.blocked.includes(tMember));
  const snapA = (await req('GET', `/rooms/${room.room.id}`, { key: aKey })).json;
  ok('her history no longer has his line', !snapA.messages.some((m) => m.body === 'room spam'));
  ok('but still has hers', snapA.messages.some((m) => m.body === 'hi all'));
  ok('the snapshot names him as blocked', snapA.blocked.includes(tMember));
  ok('the older-pages endpoint filters too',
     !(await req('GET', `/rooms/${room.room.id}/messages`, { key: aKey })).json.messages.some((m) => m.body === 'room spam'));
  ok('his own view is untouched',
     (await req('GET', `/rooms/${room.room.id}`, { key: tKey })).json.messages.some((m) => m.body === 'room spam'));
  eq('a block made in a room also stops his DMs',
     (await req('POST', `/dm/${short(alice)}`, { identity: troll, body: { body: 'psst', projectId } })).status, 403);
  eq('and it shows on her one blocked list', (await req('GET', '/dm/blocks', { identity: alice })).json.blocks[0].name, 'Troll');
  eq('you cannot block yourself',
     (await req('POST', `/rooms/${room.room.id}/members/${snapA.you}/block`, { key: aKey })).status, 400);

  console.log('\n── an encrypted room ──');
  const sealedRoom = (await req('POST', '/rooms', { body: { name: 'sealed', identity: alice, e2e: true } })).json;
  rooms.push(sealedRoom);
  const sj = (await req('POST', '/rooms/join', { body: { code: sealedRoom.room.code, name: 'Troll', identity: troll } })).json;
  const sealedLine = (await req('POST', `/rooms/${sealedRoom.room.id}/messages`,
    { key: sj.key, body: { body: 'e1:' + 'A'.repeat(32) } })).json.message;
  ok('the relay only has ciphertext', !!sealedLine && sealedLine.body.startsWith('e1:'));
  eq('she reports what she read',
     (await req('POST', `/rooms/${sealedRoom.room.id}/messages/${sealedLine.id}/report`,
       { key: sealedRoom.key, body: { reason: 'abuse', excerpt: 'the decrypted threat' } })).status, 200);
  eq('the evidence is her plaintext, labelled as unverified',
     reportsFor('room', sealedLine.id)[0].excerpt, '[e2e, as seen by reporter] the decrypted threat');

  // Clean up: the database may be the real dev one.
  for (const who of [alice, troll, c1, c2]) {
    const s = short(who);
    db.db.prepare('DELETE FROM dm_messages WHERE from_id = ? OR to_id = ?').run(s, s);
    db.db.prepare('DELETE FROM user_blocks WHERE blocker = ? OR blocked = ?').run(s, s);
    db.db.prepare('DELETE FROM safety_reports WHERE reporter = ? OR target_identity = ?').run(s, s);
    db.db.prepare('DELETE FROM wall_comments WHERE identity = ?').run(s);
  }
  db.deleteWallProject.run({ id: projectId, identity: short(alice) });
  for (const r of rooms) await req('POST', `/rooms/${r.room.id}/close`, { key: r.key });
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
