/**
 * Terse Rooms integration tests — the REST + SSE surface, end to end against a
 * real SQLite-backed Express app.
 *
 *   node api/rooms.test.js
 *
 * Self-contained: creates its own rooms and closes them at the end. Exits
 * non-zero on any failure.
 */
const express = require('express');
const http = require('http');
const db = require('./db');
const roomsRouter = require('./rooms');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

const app = express();
app.use(express.json());
app.use('/rooms', roomsRouter);
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
    if (data) r.write(data);
    r.end();
  });
}

/** Open the SSE stream and collect events until `want` of them have arrived. */
function stream(roomId, key, want, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({
      host: '127.0.0.1', port: server.address().port,
      path: `/rooms/${roomId}/stream?key=${encodeURIComponent(key)}`, method: 'GET',
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('stream status ' + res.statusCode));
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (frame.startsWith('data: ')) {
            events.push(JSON.parse(frame.slice(6)));
            if (events.length >= want) { r.destroy(); resolve(events); }
          }
        }
      });
    });
    r.on('error', () => { /* destroy() after resolve */ });
    r.end();
    setTimeout(() => { r.destroy(); resolve(events); }, timeoutMs);
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const created = [];

  console.log('\n── lifecycle ──');
  const mk = await req('POST', '/rooms', { body: { name: 'Test Room', member_name: 'ann' } });
  eq('create returns 200', mk.status, 200);
  ok('create returns a key', typeof mk.json.key === 'string' && mk.json.key.length > 20);
  ok('create returns a share code', /^[A-Z2-9]{7}$/.test(mk.json.room.code));
  ok('creator is the owner', mk.json.owner === true);
  created.push(mk.json.room.id);
  const roomId = mk.json.room.id, code = mk.json.room.code, annKey = mk.json.key;

  // The code IS the credential — that is what lets a stranger in without an
  // account, an invite, or becoming anyone's friend.
  const join = await req('POST', '/rooms/join', { body: { code, name: 'bob' } });
  eq('join by code returns 200', join.status, 200);
  ok('join returns its own key', join.json.key && join.json.key !== annKey);
  ok('join returns a member id', typeof join.json.member_id === 'string');
  eq('roster now has two', join.json.members.length, 2);
  const bobKey = join.json.key, bobId = join.json.member_id;

  eq('join with a bad code 404s', (await req('POST', '/rooms/join', { body: { code: 'ZZZZZZZ' } })).status, 404);
  eq('join without a code 400s', (await req('POST', '/rooms/join', { body: {} })).status, 400);

  // The creator needs an email for the same reason a joiner does: without one
  // they are anonymous, and an anonymous member can never be added as a friend.
  // The app had no way to pass one, so every room owner was anonymous.
  {
    const withEmail = await req('POST', '/rooms', { body: { name: 'E', member_name: 'eve', email: 'Eve@Test.dev' } });
    created.push(withEmail.json.room.id);
    const snap = await req('GET', `/rooms/${withEmail.json.room.id}`, { key: withEmail.json.key });
    eq("the creator's email is stored", snap.json.members[0].user_email, 'eve@test.dev');
    ok('and is lower-cased', snap.json.members[0].user_email === snap.json.members[0].user_email.toLowerCase());
  }

  console.log('\n── auth ──');
  eq('no key is rejected', (await req('GET', `/rooms/${roomId}`)).status, 401);
  eq('a made-up key is rejected', (await req('GET', `/rooms/${roomId}`, { key: 'nope' })).status, 401);

  // A key must not authenticate against a room it was not issued for.
  const other = await req('POST', '/rooms', { body: { name: 'Other' } });
  created.push(other.json.room.id);
  eq("another room's key is rejected", (await req('GET', `/rooms/${roomId}`, { key: other.json.key })).status, 403);

  console.log('\n── read ──');
  const snap = await req('GET', `/rooms/${roomId}`, { key: bobKey });
  eq('member can read the room', snap.status, 200);
  eq('reader is told who they are', snap.json.you, bobId);
  eq('non-owner is not owner', snap.json.owner, false);
  eq('owner is owner', (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.owner, true);

  console.log('\n── live channel ──');
  {
    // The stream must deliver a snapshot immediately, then the log line — a
    // client that joins mid-session should render without waiting for traffic.
    const p = stream(roomId, bobKey, 2);
    setTimeout(() => req('POST', `/rooms/${roomId}/log`, { key: annKey, body: { text: 'compiling' } }), 120);
    const evs = await p;
    eq('first frame is a snapshot', evs[0]?.type, 'snapshot');
    ok('snapshot carries the roster', Array.isArray(evs[0]?.members) && evs[0].members.length === 2);
    eq('log is fanned out', evs[1]?.type, 'log');
    eq('log text arrives', evs[1]?.text, 'compiling');
    ok('log is attributed to its sender', !!evs[1]?.member_id && evs[1].member_id !== bobId);
    eq('log carries the sender name', evs[1]?.name, 'ann');
  }
  {
    const p = stream(roomId, annKey, 2);
    setTimeout(() => req('POST', `/rooms/${roomId}/messages`, { key: bobKey, body: { body: 'hi 👋🎉' } }), 120);
    const evs = await p;
    eq('message is fanned out', evs[1]?.type, 'message');
    eq('emoji survive the round trip', evs[1]?.message?.body, 'hi 👋🎉');
    eq('message is attributed', evs[1]?.message?.member_id, bobId);
  }

  console.log('\n── chat rules ──');
  eq('empty message rejected', (await req('POST', `/rooms/${roomId}/messages`, { key: bobKey, body: { body: '  ' } })).status, 400);
  eq('http image rejected', (await req('POST', `/rooms/${roomId}/messages`, { key: bobKey, body: { image_url: 'http://x/a.png' } })).status, 400);
  eq('https image accepted', (await req('POST', `/rooms/${roomId}/messages`, { key: bobKey, body: { image_url: 'https://x/a.png' } })).status, 200);
  ok('chat persists for late joiners', (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.messages.length >= 2);

  console.log('\n── presence ──');
  {
    const before = (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.members;
    ok('everyone starts online', before.every((m) => m.status === 'online'));
    await req('POST', `/rooms/${roomId}/presence`, { key: bobKey, body: { status: 'away' } });
    const after = (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.members;
    eq('away is reflected', after.find((m) => m.member_id === bobId)?.status, 'away');
  }
  {
    // Presence must DECAY: a closed laptop never sends "offline".
    db.db.prepare("UPDATE room_members SET status='online', last_seen_at=datetime('now','-5 minutes') WHERE room_id=? AND member_id=?")
      .run(roomId, bobId);
    const aged = (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.members;
    eq('a silent member ages out to offline', aged.find((m) => m.member_id === bobId)?.status, 'offline');
  }

  console.log('\n── leaving and closing ──');
  await req('POST', `/rooms/${roomId}/leave`, { key: bobKey });
  eq('leaving removes you from the roster', (await req('GET', `/rooms/${roomId}`, { key: annKey })).json.members.length, 1);
  eq('a left key no longer authenticates', (await req('GET', `/rooms/${roomId}`, { key: bobKey })).status, 401);

  const rejoin = await req('POST', '/rooms/join', { body: { code, name: 'bob again' } });
  eq('the code still works after someone leaves', rejoin.status, 200);

  eq('a non-owner cannot close the room', (await req('POST', `/rooms/${roomId}/close`, { key: rejoin.json.key })).status, 403);
  eq('the owner can close the room', (await req('POST', `/rooms/${roomId}/close`, { key: annKey })).status, 200);
  eq('a closed room is gone', (await req('GET', `/rooms/${roomId}`, { key: annKey })).status, 404);
  eq('a closed code cannot be joined', (await req('POST', '/rooms/join', { body: { code } })).status, 404);

  for (const id of created) db.closeRoom.run(id);
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
