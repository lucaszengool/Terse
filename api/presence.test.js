/**
 * Presence chatter — the cost of being in a room with other people.
 *
 *   node api/presence.test.js
 *
 * A heartbeat is the most frequent call in the product and almost never changes
 * anything. If it broadcasts anyway, N people generate N² roster deliveries per
 * interval and every client re-renders a list identical to the one it has — felt
 * as stutter while typing, and worse the fuller the room. These assertions pin
 * both halves: silence when nothing changed, and delivery when it did.
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
const server = http.createServer(app);

function req(method, path, { key, identity, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(key ? { 'x-terse-room-key': key } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
      } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

/** Count roster frames delivered to a watcher over `ms`. */
function watch(roomId, key, ms) {
  return new Promise((resolve) => {
    let rosters = 0, buf = '';
    const r = http.request({ host: '127.0.0.1', port: server.address().port,
      path: `/rooms/${roomId}/stream?key=${encodeURIComponent(key)}`, method: 'GET' }, (res) => {
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2);
          if (f.startsWith('data: ')) { try { if (JSON.parse(f.slice(6)).type === 'roster') rosters++; } catch {} }
        }
      });
    });
    r.on('error', () => {});
    r.end();
    setTimeout(() => { r.destroy(); resolve(rosters); }, ms);
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const id = (n) => `${n}-${crypto.randomBytes(6).toString('hex')}`;
  const a = id('a'), b = id('b');
  const room = (await req('POST', '/rooms', { body: { name: 'perf', member_name: 'a', identity: a } })).json;
  const jn = (await req('POST', '/rooms/join', { body: { code: room.room.code, name: 'b', identity: b } })).json;

  console.log('\n── a heartbeat that changes nothing is silent ──');
  {
    const watching = watch(room.room.id, room.key, 700);
    await new Promise((r) => setTimeout(r, 100));
    // Ten heartbeats, exactly as two idle clients would send.
    for (let i = 0; i < 10; i++) {
      await req('POST', `/rooms/${room.room.id}/presence`, { key: room.key, body: { status: 'online' } });
      await req('POST', `/rooms/${room.room.id}/presence`, { key: jn.key, body: { status: 'online' } });
    }
    const frames = await watching;
    eq('20 idle heartbeats deliver 0 roster frames', frames, 0);
  }
  {
    const r1 = await req('POST', `/rooms/${room.room.id}/presence`, { key: room.key, body: { status: 'online' } });
    eq('and the response says so', r1.json.changed, false);
  }

  console.log('\n── a real change still reaches everyone ──');
  {
    const watching = watch(room.room.id, room.key, 700);
    await new Promise((r) => setTimeout(r, 100));
    await req('POST', `/rooms/${room.room.id}/presence`, { key: jn.key, body: { status: 'away' } });
    eq('going away is delivered', await watching, 1);
  }
  {
    const watching = watch(room.room.id, room.key, 700);
    await new Promise((r) => setTimeout(r, 100));
    await req('POST', `/rooms/${room.room.id}/presence`, { key: jn.key, body: { status: 'online' } });
    eq('coming back is delivered', await watching, 1);
  }
  {
    // Someone closes their laptop. Nothing they do can tell us — that is the
    // point — so the sweep must notice and tell everyone still in the room.
    db.db.prepare("UPDATE room_members SET last_seen_at = datetime('now','-5 minutes') WHERE room_id = ? AND member_id = ?")
      .run(room.room.id, jn.member_id);
    const watching = watch(room.room.id, room.key, 700);
    await new Promise((r) => setTimeout(r, 100));
    require('./rooms').sweepPresence();
    eq('a member who went quiet is swept offline and announced', await watching, 1);
    eq('and they read as offline afterwards',
       (await req('GET', `/rooms/${room.room.id}`, { key: room.key })).json.members
         .find((m) => m.member_id === jn.member_id).status, 'offline');
  }
  {
    // And the sweep is silent when there is nothing to sweep — it must not
    // become a broadcast on a timer.
    const watching = watch(room.room.id, room.key, 500);
    await new Promise((r) => setTimeout(r, 80));
    require('./rooms').sweepPresence();
    eq('an idle sweep says nothing', await watching, 0);
  }
  {
    const watching = watch(room.room.id, room.key, 700);
    await new Promise((r) => setTimeout(r, 100));
    await req('POST', `/rooms/${room.room.id}/name`, { key: jn.key, body: { name: 'renamed' } });
    eq('a rename is delivered', await watching, 1);
  }

  db.closeRoom.run(room.room.id);
  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
