/**
 * 广场 · plaza, knocking, one-active-room, and friend links.
 *
 *   node api/plaza.test.js
 *
 * The rules being pinned down here are product decisions, not implementation
 * details, so they are the ones worth a test: a room is private until its owner
 * says otherwise; a public listing never hands out the code; the owner decides
 * who enters; you are only ever in one room at a time, WITHOUT losing the rooms
 * you already belong to; and a friend link needs no approval because sending it
 * was the approval.
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

const app = express();
app.use(express.json());
app.use('/rooms', require('./rooms'));
app.use('/friends', require('./friends'));
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
  const id = (n) => `${n}-${crypto.randomBytes(8).toString('hex')}`;
  const host = id('host'), guest = id('guest'), other = id('other');
  const made = [];

  console.log('\n── a room is private until its owner says otherwise ──');
  const priv = (await req('POST', '/rooms', { body: { name: 'quiet', member_name: 'host', identity: host } })).json;
  made.push(priv.room.id);
  eq('created private by default', priv.room.visibility, 'private');
  const pub = (await req('POST', '/rooms', { body: { name: 'open house', member_name: 'host', identity: host, visibility: 'public', category: 'coding' } })).json;
  made.push(pub.room.id);
  eq('opting in is explicit', pub.room.visibility, 'public');
  eq('and carries a category', pub.room.category, 'coding');
  eq('an unknown category is dropped, not stored',
     (await req('POST', '/rooms', { body: { identity: other, visibility: 'public', category: 'nonsense' } })).json.room.category, null);

  console.log('\n── the plaza ──');
  const list = (await req('GET', '/rooms/public')).json;
  ok('browsing needs no credential at all', list.ok === true);
  ok('public rooms are listed', list.rooms.some((r) => r.id === pub.room.id));
  ok('private rooms are NOT listed', !list.rooms.some((r) => r.id === priv.room.id));
  ok('the listing never hands out the code', list.rooms.every((r) => r.code === undefined));
  ok('it offers the category set', Array.isArray(list.categories) && list.categories.includes('coding'));
  ok('filtering by category works',
     (await req('GET', '/rooms/public?category=coding')).json.rooms.every((r) => r.category === 'coding'));

  // A room is a place: it stays listed after everyone goes home.
  await req('POST', `/rooms/${pub.room.id}/leave`, { key: pub.key });
  ok('an empty public room is still listed — a place does not vanish',
     (await req('GET', '/rooms/public')).json.rooms.some((r) => r.id === pub.room.id));
  const rejoin = (await req('POST', '/rooms/join', { body: { code: pub.room.code, name: 'host', identity: host } })).json;

  console.log('\n── knocking ──');
  eq('you cannot knock on a private room', (await req('POST', `/rooms/${priv.room.id}/knock`, { identity: guest, body: { name: 'guest' } })).status, 403);
  const knock = await req('POST', `/rooms/${pub.room.id}/knock`, { identity: guest, body: { name: 'guest' } });
  eq('knocking on a public room works', knock.status, 200);
  eq('and starts pending', knock.json.knock.status, 'pending');
  eq('knocking without an identity is rejected', (await req('POST', `/rooms/${pub.room.id}/knock`, { body: {} })).status, 401);

  const waiting = await req('GET', `/rooms/${pub.room.id}/knocks`, { key: rejoin.key, identity: host });
  eq('the owner sees who is waiting', waiting.json.knocks.length, 1);
  ok('ownership survived leaving and rejoining — a new key, same person', waiting.status === 200);
  eq('and their name', waiting.json.knocks[0].name, 'guest');
  eq('a non-owner cannot see the queue',
     (await req('GET', `/rooms/${pub.room.id}/knocks`, { key: (await req('POST', '/rooms/join', { body: { code: pub.room.code, identity: other } })).json.key })).status, 403);

  eq('waiting does not let you in yet', (await req('GET', `/rooms/knock/${knock.json.knock.id}`, { identity: guest })).json.status, 'pending');
  eq('the owner approves', (await req('POST', `/rooms/${pub.room.id}/knocks/${knock.json.knock.id}`, { key: rejoin.key, identity: host, body: { accept: true } })).status, 200);

  const claim = await req('GET', `/rooms/knock/${knock.json.knock.id}`, { identity: guest });
  eq('the guest claims a key', claim.json.status, 'approved');
  ok('and it actually works', (await req('GET', `/rooms/${pub.room.id}`, { key: claim.json.key })).status === 200);
  ok("someone else's approval cannot be claimed",
     (await req('GET', `/rooms/knock/${knock.json.knock.id}`, { identity: other })).status === 404);

  const denied = id('denied');
  const dk = await req('POST', `/rooms/${pub.room.id}/knock`, { identity: denied, body: { name: 'nope' } });
  await req('POST', `/rooms/${pub.room.id}/knocks/${dk.json.knock.id}`, { key: rejoin.key, identity: host, body: { accept: false } });
  eq('a declined person cannot just knock again', (await req('POST', `/rooms/${pub.room.id}/knock`, { identity: denied })).status, 403);

  console.log('\n── one room at a time, without losing the others ──');
  const second = (await req('POST', '/rooms', { body: { name: 'elsewhere', member_name: 'guest', identity: guest } })).json;
  made.push(second.room.id);
  const back = (await req('GET', `/rooms/${pub.room.id}`, { key: claim.json.key })).json;
  const me = back.members.find((m) => m.member_id === claim.json.member_id);
  eq('entering a room makes you offline in the previous one', me.status, 'offline');
  ok('but you are still a member of it — the way back survives', !!me);
  eq('and the old key still authenticates', (await req('GET', `/rooms/${pub.room.id}`, { key: claim.json.key })).status, 200);
  await req('POST', `/rooms/${pub.room.id}/presence`, { key: claim.json.key, body: { status: 'online' } });
  eq('coming back makes you online again',
     (await req('GET', `/rooms/${pub.room.id}`, { key: claim.json.key })).json.members.find((m) => m.member_id === claim.json.member_id).status, 'online');
  eq('and the room you left goes quiet',
     (await req('GET', `/rooms/${second.room.id}`, { key: second.key })).json.members[0].status, 'offline');

  console.log('\n── coming back: recent rooms, one seat per person ──');
  // The owner walking out of their own room is the case that has to be safe:
  // the room is a place, and a place does not close because its host went home.
  const home = (await req('POST', '/rooms', { body: { name: 'home', member_name: 'host', identity: host,
                                                      visibility: 'public', category: 'chat' } })).json;
  made.push(home.room.id);
  const lodger = (await req('POST', '/rooms/join', { body: { code: home.room.code, name: 'lodger', identity: other } })).json;
  eq('the owner leaves their own room', (await req('POST', `/rooms/${home.room.id}/leave`, { key: home.key })).status, 200);
  eq('the room is still there', (await req('GET', `/rooms/${home.room.id}`, { key: lodger.key })).status, 200);
  eq('and whoever stayed can still talk in it',
     (await req('POST', `/rooms/${home.room.id}/messages`, { key: lodger.key, body: { body: 'still here' } })).status, 200);
  eq('a stranger can still walk in with the code',
     (await req('POST', '/rooms/join', { body: { code: home.room.code, name: 'walkin', identity: id('walkin') } })).status, 200);

  const mine = await req('GET', '/rooms/mine', { identity: host });
  const homeRow = (mine.json.rooms || []).find((r) => r.id === home.room.id);
  ok('a room you own is still listed as yours after you leave it', !!homeRow);
  eq('with the code, so you can walk back in', homeRow.code, home.room.code);
  eq('and it still knows you own it', homeRow.owner, true);
  eq('rooms/mine needs an identity', (await req('GET', '/rooms/mine')).status, 401);

  const backIn = (await req('POST', '/rooms/join', { body: { code: home.room.code, name: 'host', identity: host } })).json;
  eq('rejoining tells you it is your room', backIn.owner, true);
  eq('and the owner powers came back with a brand-new key',
     (await req('POST', `/rooms/${home.room.id}/listing`, { key: backIn.key, identity: host, body: { visibility: 'public' } })).status, 200);

  const twice = (await req('POST', '/rooms/join', { body: { code: home.room.code, name: 'lodger', identity: other } })).json;
  const seats = (await req('GET', `/rooms/${home.room.id}`, { key: twice.key })).json.members
    .filter((m) => m.name === 'lodger');
  eq('rejoining replaces your seat instead of adding a ghost', seats.length, 1);
  eq('and you are still the same person to everyone else', twice.member_id, lodger.member_id);
  eq('the old key from that seat is spent', (await req('GET', `/rooms/${home.room.id}`, { key: lodger.key })).status, 401);

  const plaza = await req('GET', '/rooms/public?category=chat', { identity: host });
  const listed = (plaza.json.rooms || []).find((r) => r.id === home.room.id);
  eq('the plaza knows this one is yours', listed.owner, true);
  eq('so it can offer to open it instead of knocking on it', listed.code, home.room.code);
  const stranger = await req('GET', '/rooms/public?category=chat', { identity: id('stranger') });
  eq('a stranger is still told nothing but that it exists',
     (stranger.json.rooms.find((r) => r.id === home.room.id) || {}).code, undefined);

  console.log('\n── friend links ──');
  const link = await req('POST', '/friends/link', { identity: host });
  eq('a link is issued', link.status, 200);
  ok('it is a URL you can paste anywhere', /https:\/\/.+friend=/.test(link.json.url));
  eq('asking again returns the same one', (await req('POST', '/friends/link', { identity: host })).json.token, link.json.token);
  eq('you cannot befriend yourself with it',
     (await req('POST', `/friends/link/${link.json.token}/accept`, { identity: host })).status, 400);

  const acc = await req('POST', `/friends/link/${link.json.token}/accept`, { identity: other, body: { name: 'other' } });
  eq('opening it befriends immediately — no approval', acc.json.friendship.status, 'accepted');
  eq('and it shows up in the list', (await req('GET', '/friends', { identity: host })).json.friends.length >= 1, true);
  eq('a revoked link stops working',
     (await req('DELETE', `/friends/link/${link.json.token}`, { identity: host })).status, 200);
  eq('and really stops working',
     (await req('POST', `/friends/link/${link.json.token}/accept`, { identity: guest })).status, 404);

  for (const rid of made) db.closeRoom.run(rid);
  for (const h of [host, guest, other]) {
    const hh = crypto.createHash('sha256').update(h).digest('hex');
    for (const e of db.listFriendEdges.all(hh, hh)) db.deleteFriend.run(e.id);
  }
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
