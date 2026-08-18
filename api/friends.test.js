/**
 * Friends integration tests — the room-mediated friend edge.
 *
 *   node api/friends.test.js
 *
 * The point of the model: NO ACCOUNT IS NEEDED. Two people who never signed in
 * can become friends, because the link is keyed by an install identity, not an
 * email. The refusals are what is worth pinning down: adding someone outside
 * your room, answering on someone else's behalf, and a client too old to have an
 * identity at all.
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');
const roomsRouter = require('./rooms');
const friendsRouter = require('./friends');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

const app = express();
app.use(express.json());
app.use('/rooms', roomsRouter);
app.use('/friends', friendsRouter);
const server = http.createServer(app);

function req(method, path, { key, identity, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(key ? { 'x-terse-room-key': key } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const id = (n) => `identity-${n}-${crypto.randomBytes(8).toString('hex')}`;
  // Deliberately NO emails: the whole point is that friendship needs no account.
  const annId = id('ann'), bobId = id('bob'), carlId = id('carl');

  const room = (await req('POST', '/rooms', { body: { name: 'R', member_name: 'ann', identity: annId } })).json;
  const roomId = room.room.id, annKey = room.key;
  const bob = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'bob', identity: bobId } })).json;
  const old = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'legacy' } })).json;
  const annMe = (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.you;

  console.log('\n── no account required ──');
  const ask = await req('POST', '/friends/request',
    { key: annKey, identity: annId, body: { room_id: roomId, to_member_id: bob.member_id } });
  eq('two signed-OUT people can become friends', ask.status, 200);
  eq('it starts pending', ask.json.friendship.status, 'pending');
  eq('it is outgoing for the asker', ask.json.friendship.direction, 'outgoing');
  eq('it carries the other name, not an email', ask.json.friendship.name, 'bob');
  ok('and no email is invented', ask.json.friendship.email === null);

  const again = await req('POST', '/friends/request',
    { key: annKey, identity: annId, body: { room_id: roomId, to_member_id: bob.member_id } });
  ok('asking twice does not duplicate', again.json.existing === true);

  console.log('\n── the identity is the credential, not the room ──');
  const listNoRoom = await req('GET', '/friends', { identity: annId });
  eq('friends list works with NO room key at all', listNoRoom.status, 200);
  eq('and shows the pending request', listNoRoom.json.outgoing.length, 1);

  console.log('\n── refusals ──');
  eq('an identity-less client is told to update',
     (await req('POST', '/friends/request', { key: old.key, body: { room_id: roomId, to_member_id: bob.member_id } })).status, 403);
  eq('someone on an old client cannot be added',
     (await req('POST', '/friends/request', { key: annKey, identity: annId, body: { room_id: roomId, to_member_id: old.member_id } })).status, 409);
  eq('you cannot add yourself',
     (await req('POST', '/friends/request', { key: annKey, identity: annId, body: { room_id: roomId, to_member_id: annMe } })).status, 400);
  eq('an unknown member 404s',
     (await req('POST', '/friends/request', { key: annKey, identity: annId, body: { room_id: roomId, to_member_id: 'nobody' } })).status, 404);
  eq('no credential at all is rejected',
     (await req('POST', '/friends/request', { body: { room_id: roomId, to_member_id: bob.member_id } })).status, 401);

  const other = (await req('POST', '/rooms', { body: { name: 'Other', identity: carlId } })).json;
  eq("a key for another room cannot reach this roster",
     (await req('POST', '/friends/request', { key: other.key, identity: carlId, body: { room_id: roomId, to_member_id: bob.member_id } })).status, 403);

  console.log('\n── the roster must not leak what a friendship is keyed by ──');
  const snap = (await req('GET', `/rooms/${roomId}`, { key: annKey })).json;
  ok('no identity_hash on any roster row', snap.members.every((m) => m.identity_hash === undefined));

  console.log('\n── answering ──');
  const pid = ask.json.friendship.id;
  eq('the asker cannot accept their own request',
     (await req('POST', `/friends/${pid}/respond`, { identity: annId, body: { accept: true } })).status, 403);
  const acc = await req('POST', `/friends/${pid}/respond`, { identity: bobId, body: { accept: true } });
  eq('the person asked can accept', acc.status, 200);
  eq('the link becomes accepted', acc.json.friendship.status, 'accepted');
  eq('answering twice is refused',
     (await req('POST', `/friends/${pid}/respond`, { identity: bobId, body: { accept: true } })).status, 409);

  console.log('\n── listing ──');
  eq('the asker now has one friend', (await req('GET', '/friends', { identity: annId })).json.friends.length, 1);
  const bobList = (await req('GET', '/friends', { identity: bobId })).json;
  eq('it reads from both sides', bobList.friends.length, 1);
  eq('and points back', bobList.friends[0].name, 'ann');

  console.log('\n── the friendship outlives the room ──');
  await req('POST', `/rooms/${roomId}/close`, { key: annKey });
  const after = await req('GET', '/friends', { identity: annId });
  eq('closing the room does not delete the friendship', after.json.friends.length, 1);
  eq('and the identity still authenticates without any room', after.status, 200);

  console.log('\n── mutual requests ──');
  const r2 = (await req('POST', '/rooms', { body: { name: 'M', member_name: 'ann', identity: annId } })).json;
  const c2 = (await req('POST', '/rooms/join', { body: { code: r2.room.code, name: 'carl', identity: carlId } })).json;
  const me2 = (await req('GET', `/rooms/${r2.room.id}`, { key: r2.key })).json.you;
  await req('POST', '/friends/request', { key: c2.key, identity: carlId, body: { room_id: r2.room.id, to_member_id: me2 } });
  const mutual = await req('POST', '/friends/request', { key: r2.key, identity: annId, body: { room_id: r2.room.id, to_member_id: c2.member_id } });
  ok('both asking counts as agreeing', mutual.json.accepted === true);
  eq('and lands accepted, not pending', mutual.json.friendship.status, 'accepted');

  console.log('\n── removing ──');
  eq('a stranger cannot remove your friendship',
     (await req('DELETE', `/friends/${pid}`, { identity: carlId })).status, 403);
  eq('either side can remove it', (await req('DELETE', `/friends/${pid}`, { identity: bobId })).status, 200);
  eq('and it is gone', (await req('GET', '/friends', { identity: annId })).json.friends.length, 1);

  for (const rid of [roomId, other.room.id, r2.room.id]) db.closeRoom.run(rid);
  for (const e of db.listFriendEdges.all(crypto.createHash('sha256').update(annId).digest('hex'),
                                         crypto.createHash('sha256').update(annId).digest('hex'))) db.deleteFriend.run(e.id);
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
