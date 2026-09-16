/**
 * town.js —— 小镇上的人。
 *
 *   node api/town.test.js
 *
 * 钉住的是:没登录不能走、位置会被夹住、走了就从名单上消失、听的人收得到。
 */
const http = require('http');
const express = require('express');
const assert = require('assert');

const town = require('./town');
const app = express();
app.use('/api/cloud/town', town);
const server = http.createServer(app);

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const ME = 'test-identity-0123456789abcdef', YOU = 'other-identity-0123456789abcdef';

function call(path, { method = 'GET', body, id } = {}) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const req = http.request({ port, path: '/api/cloud/town' + path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, id ? { 'x-terse-identity': id } : {}) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 听一会儿 SSE,把收到的帧交回来。 */
function listen(ms, id) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const frames = [];
    const req = http.request({ port, path: '/api/cloud/town/stream' + (id ? '?identity=' + id : ''), method: 'GET' }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(line);
          if (m) { try { frames.push(JSON.parse(m[1])); } catch (e) {} }
        }
      });
    });
    req.end();
    setTimeout(() => { try { req.destroy(); } catch (e) {} resolve(frames); }, ms);
  });
}

(async () => {
  await new Promise((r) => server.listen(0, r));

  /* ── 只有登录的人能走 ── */
  town.reset();
  ok('no identity, no walking', (await call('/join', { method: 'POST', body: { name: 'nobody' } })).status === 401);
  ok('and no moving either', (await call('/move', { method: 'POST', body: { x: 1, z: 1, yaw: 0 } })).status === 401);

  /* ── 进镇 ── */
  const j = await call('/join', { method: 'POST', body: { name: '  ada​  ' }, id: ME });
  ok('signed in: you are in the town', j.status === 200 && j.body.ok && j.body.people === 1);
  ok('the name is cleaned up (invisible characters are the old trick)',
    [...town.people.values()][0].name === 'ada');
  ok('walking before joining is refused', (await call('/move', { method: 'POST', body: { x: 1, z: 1, yaw: 0 }, id: YOU })).status === 409);

  /* ── 走 ── */
  await call('/move', { method: 'POST', body: { x: 12, z: -4, yaw: 1.2, v: 3 }, id: ME });
  const me = town.people.get([...town.people.keys()][0]);
  ok('the first step after joining is taken as given (that is where you spawned)',
    Math.abs(me.x - 12) < 0.01 && Math.abs(me.z + 4) < 0.01);
  await call('/move', { method: 'POST', body: { x: 13, z: -4, yaw: 1.2, v: 3 }, id: ME });
  ok('and an ordinary step is a step', Math.abs(me.x - 13) < 1.5);
  await call('/move', { method: 'POST', body: { x: 99999, z: 99999, yaw: 0, v: 99 }, id: ME });
  ok('you cannot teleport across the map', Math.hypot(me.x, me.z) < 1300 && me.v <= 12);
  ok('nor can you outrun the speed cap', me.v <= 12);
  ok('a bad position is refused, not stored',
    (await call('/move', { method: 'POST', body: { x: 'over there', z: null, yaw: 0 }, id: ME })).status === 400);

  /* ── 别人听得到 ── */
  town.reset();
  await call('/join', { method: 'POST', body: { name: 'ada' }, id: ME });
  const framesP = listen(700, 'watcher-identity-0123456789');
  await new Promise((r) => setTimeout(r, 60));
  await call('/join', { method: 'POST', body: { name: 'linus' }, id: YOU });
  await call('/move', { method: 'POST', body: { x: 5, z: 5, yaw: 0.5, v: 2 }, id: YOU });
  const frames = await framesP;
  ok('a listener gets the roster on arrival', frames.length > 0 && frames[0].type === 'hello');
  const peers = frames.filter((f) => f.type === 'peers').pop();
  ok('and hears people move', !!peers && peers.peers.length === 2);
  ok('each person carries a name and a position', !!peers && peers.peers.every((p) => p.name && Number.isFinite(p.x) && Number.isFinite(p.yaw)));
  ok('but never the identity behind them', !!peers && peers.peers.every((p) => p.id.length === 32 && !p.id.includes(ME)));

  /* ── 走了 ── */
  await call('/leave', { method: 'POST', id: YOU });
  ok('leaving takes you off the roster', (await call('/count')).body.people === 1);
  ok('and the count is cheap to ask for', (await call('/count')).status === 200);

  town.reset();
  server.close();
  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) { console.error('failing:\n  ' + fails.join('\n  ') + '\n'); process.exit(1); }
})();
