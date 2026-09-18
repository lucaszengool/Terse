/**
 * town.js —— 小镇上的人。
 *
 *   node api/town.test.js
 *
 * 钉住的是:没登录不能走、位置会被夹住、走了就从名单上消失、听的人收得到。
 */
const http = require('http');
const os = require('os');
const fspath = require('path');
// 灯和字条写进 sqlite:用一个临时库,不然跑第二遍就撞上"今天留够了"
process.env.TERSE_DATA_DIR = require('fs').mkdtempSync(fspath.join(os.tmpdir(), 'terse-town-test-'));
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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

  /* ── 说话 ── */
  town.reset();
  await call('/join', { method: 'POST', body: { name: 'ada' }, id: ME });
  ok('you must sign in to talk', (await call('/say', { method: 'POST', body: { text: 'hi' } })).status === 401);
  ok('and nothing is not a sentence', (await call('/say', { method: 'POST', body: { text: '   ' }, id: ME })).status === 400);
  const heard = listen(600, 'listener-identity-0123456789');
  await new Promise((r) => setTimeout(r, 60));
  await call('/say', { method: 'POST', body: { text: 'hello town' }, id: ME });
  const saidFrames = await heard;
  const said = saidFrames.filter((f) => f.type === 'say').pop();
  ok('a sentence reaches the people nearby', !!said && said.text === 'hello town' && said.name === 'ada');

  /* ── 留下的东西:灯和字条 ── */
  const lantern = await call('/mark', { method: 'POST', body: { kind: 'lantern', x: 12, z: -3 }, id: ME });
  ok('you can light a lantern where you stand', lantern.status === 200 && lantern.body.mark.kind === 'lantern');
  await pause(320);
  const note = await call('/mark', { method: 'POST', body: { kind: 'note', x: 4, z: 4, note: 2 }, id: ME });
  ok('and leave a note', note.status === 200 && note.body.mark.text === town.NOTES[2]);
  await pause(320);
  const freeText = await call('/mark', { method: 'POST', body: { kind: 'note', x: 5, z: 5, note: 1, text: 'anything I like' }, id: ME });
  ok('but the words are ours, not theirs — free text is ignored',
    freeText.status === 200 && town.NOTES.indexOf(freeText.body.mark.text) >= 0);
  await pause(320);
  ok('marks are out in the open for everyone', (await call('/marks')).body.marks.length >= 3);
  await pause(320);
  ok('a mark outside the town is refused',
    (await call('/mark', { method: 'POST', body: { kind: 'lantern', x: 99999, z: 0 }, id: ME })).status === 400);
  await pause(320);
  const mine = (await call('/marks')).body.marks[0];
  await call('/mark/' + mine.id + '/remove', { method: 'POST', id: ME });
  ok('and you can take your own back',
    (await call('/marks')).body.marks.every((m) => m.id !== mine.id));

  /* ── 表情跟着位置一起走 ── */
  await call('/move', { method: 'POST', body: { x: 1, z: 1, yaw: 0, v: 0, e: 3 }, id: ME });
  ok('an emote rides along with the position', (await call('/count')).status === 200 && [...town.people.values()][0].e === 3);

  /* ── agent 小伙伴:光点颜色(只收白名单)、狗和狗的邀请(只到收件人) ── */
  {
    town.reset();
    const crypto = require('crypto');
    const hid = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 32);
    const THIRD = 'third-identity-0123456789abcdef';
    await call('/join', { method: 'POST', body: { name: 'me' }, id: ME });
    await call('/join', { method: 'POST', body: { name: 'you' }, id: YOU });
    await call('/join', { method: 'POST', body: { name: 'third' }, id: THIRD });
    await call('/move', { method: 'POST', body: { x: 0, z: 0, yaw: 0, v: 0, a: 'claude-code' }, id: ME });
    ok('agent kind rides along with the position', town.people.get(hid(ME)).a === 'claude-code');
    await pause(1100);
    await call('/move', { method: 'POST', body: { x: 0.1, z: 0, yaw: 0, v: 0, a: '<img onerror=x>' }, id: ME });
    ok('an agent kind outside the list is dropped', town.people.get(hid(ME)).a === '');

    const youHear = listen(700, YOU), thirdHears = listen(700, THIRD);
    await pause(150);
    const r = await call('/pet/invite', { method: 'POST', body: { to: hid(YOU), code: 'AB12CD', pet: 'Fig' }, id: ME });
    ok('an invite to someone in town is delivered', r.status === 200 && r.body && r.body.delivered === true);
    const got = (await youHear).filter((f) => f.type === 'petInvite');
    ok('the recipient gets the code, who it is from, and the pet', got.length === 1 && got[0].code === 'AB12CD' && got[0].from === hid(ME) && got[0].pet === 'Fig');
    ok('nobody else in town sees the code', (await thirdHears).every((f) => f.type !== 'petInvite' && !JSON.stringify(f).includes('AB12CD')));

    ok('a bad code is refused', (await call('/pet/invite', { method: 'POST', body: { to: hid(YOU), code: 'ab 12', pet: 'x' }, id: ME })).status === 400);
    ok('you cannot invite yourself', (await call('/pet/invite', { method: 'POST', body: { to: hid(ME), code: 'AB12CD' }, id: ME })).status === 400);
    await call('/leave', { method: 'POST', id: THIRD });
    ok('both of you have to be in town', (await call('/pet/invite', { method: 'POST', body: { to: hid(THIRD), code: 'AB12CD' }, id: ME })).status === 409);
    ok('signed-out visitors cannot invite', (await call('/pet/invite', { method: 'POST', body: { to: hid(YOU), code: 'AB12CD' } })).status === 401);

    const back = listen(500, ME);
    await pause(120);
    await call('/pet/reply', { method: 'POST', body: { to: hid(ME), ok: true }, id: YOU });
    const rep = (await back).filter((f) => f.type === 'petReply');
    ok('the answer goes back to the one who asked', rep.length === 1 && rep[0].ok === true && rep[0].from === hid(YOU));

    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call('/pet/invite', { method: 'POST', body: { to: hid(YOU), code: 'AB12CD' }, id: ME })).status;
    ok('invites are rate-limited', last === 429);
  }

  town.reset();
  server.close();
  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) { console.error('failing:\n  ' + fails.join('\n  ') + '\n'); process.exit(1); }
})();
