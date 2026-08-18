/**
 * Friends integration tests — the room-mediated friend edge.
 *
 *   node api/friends.test.js
 *
 * The interesting cases are the refusals: adding someone who is not in your
 * room, answering on someone else's behalf, and adding a member with no account.
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

function req(method, path, { key, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(key ? { 'x-terse-room-key': key } : {}),
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
  const mail = (n) => `${n}-${crypto.randomBytes(3).toString('hex')}@test.dev`;
  const ann = mail('ann'), bob = mail('bob'), carl = mail('carl');

  const room = (await req('POST', '/rooms', { body: { name: 'R', member_name: 'ann' } })).json;
  // The creator joins again as a signed-in member so it has an email to link.
  const annJoin = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'ann', email: ann } })).json;
  const bobJoin = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'bob', email: bob } })).json;
  const anonJoin = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'ghost' } })).json;
  const roomId = room.room.id;

  console.log('\n── asking ──');
  const ask = await req('POST', '/friends/request', { key: annJoin.key, body: { room_id: roomId, to_member_id: bobJoin.member_id } });
  eq('a request is accepted', ask.status, 200);
  eq('it starts pending', ask.json.friendship.status, 'pending');
  eq('it is outgoing for the asker', ask.json.friendship.direction, 'outgoing');
  eq('it names the other person', ask.json.friendship.email, bob);

  const again = await req('POST', '/friends/request', { key: annJoin.key, body: { room_id: roomId, to_member_id: bobJoin.member_id } });
  ok('asking twice does not duplicate', again.json.existing === true);

  console.log('\n── refusals ──');
  // An anonymous member has no durable identity to attach a friendship to.
  eq('an anonymous member cannot ask',
     (await req('POST', '/friends/request', { key: anonJoin.key, body: { room_id: roomId, to_member_id: bobJoin.member_id } })).status, 403);
  eq('an anonymous member cannot be added',
     (await req('POST', '/friends/request', { key: annJoin.key, body: { room_id: roomId, to_member_id: anonJoin.member_id } })).status, 409);
  eq('you cannot add yourself',
     (await req('POST', '/friends/request', { key: annJoin.key, body: { room_id: roomId, to_member_id: annJoin.member_id } })).status, 400);
  eq('an unknown member 404s',
     (await req('POST', '/friends/request', { key: annJoin.key, body: { room_id: roomId, to_member_id: 'nobody' } })).status, 404);
  eq('no credential is rejected',
     (await req('POST', '/friends/request', { body: { room_id: roomId, to_member_id: bobJoin.member_id } })).status, 401);

  // A key for another room must not reach into this one's roster.
  const other = (await req('POST', '/rooms', { body: { name: 'Other' } })).json;
  const carlJoin = (await req('POST', '/rooms/join', { body: { code: other.room.code, name: 'carl', email: carl } })).json;
  eq("another room's member cannot ask through this room",
     (await req('POST', '/friends/request', { key: carlJoin.key, body: { room_id: roomId, to_member_id: bobJoin.member_id } })).status, 403);

  console.log('\n── answering ──');
  const pendingId = ask.json.friendship.id;
  eq('the asker cannot accept their own request',
     (await req('POST', `/friends/${pendingId}/respond`, { key: annJoin.key, body: { accept: true } })).status, 403);
  const acc = await req('POST', `/friends/${pendingId}/respond`, { key: bobJoin.key, body: { accept: true } });
  eq('the person asked can accept', acc.status, 200);
  eq('the edge becomes accepted', acc.json.friendship.status, 'accepted');
  eq('answering twice is refused',
     (await req('POST', `/friends/${pendingId}/respond`, { key: bobJoin.key, body: { accept: true } })).status, 409);

  console.log('\n── listing ──');
  const annList = (await req('GET', '/friends', { key: annJoin.key })).json;
  eq('the asker now has one friend', annList.friends.length, 1);
  eq('and it is the right person', annList.friends[0].email, bob);
  const bobList = (await req('GET', '/friends', { key: bobJoin.key })).json;
  eq('the friendship reads from both sides', bobList.friends.length, 1);
  eq('and points back', bobList.friends[0].email, ann);

  console.log('\n── mutual requests ──');
  const c2 = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'carl', email: carl } })).json;
  await req('POST', '/friends/request', { key: c2.key, body: { room_id: roomId, to_member_id: bobJoin.member_id } });
  const mutual = await req('POST', '/friends/request', { key: bobJoin.key, body: { room_id: roomId, to_member_id: c2.member_id } });
  ok('both asking counts as agreeing', mutual.json.accepted === true);
  eq('and lands accepted, not pending', mutual.json.friendship.status, 'accepted');

  console.log('\n── removing ──');
  eq('a stranger cannot remove your friendship',
     (await req('DELETE', `/friends/${pendingId}`, { key: carlJoin.key })).status, 403);
  eq('either side can remove it', (await req('DELETE', `/friends/${pendingId}`, { key: bobJoin.key })).status, 200);
  eq('and it is gone', (await req('GET', '/friends', { key: annJoin.key })).json.friends.length, 0);

  db.closeRoom.run(roomId); db.closeRoom.run(other.room.id);
  for (const e of db.listFriendEdges.all(bob, bob)) db.deleteFriend.run(e.id);
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
