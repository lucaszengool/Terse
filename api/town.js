/**
 * town.js — 小镇上的人:谁在镇上、各自站在哪。
 *
 * 只有登录的人能走(身份 = Clerk 的用户 id,见 landing/phone/social.js 的 adopt),
 * 所以镇上每一个小人背后都是一个真账号 —— 昵称、拉黑、举报才有意义。
 *
 * 为什么是 SSE + POST,不是 WebSocket:这套 app 的实时全是 SSE(api/cowork-bus.js
 * 一个进程内的总线,rooms / cowork / link / docs 都走它),加一个 ws 依赖要动
 * Railway 的构建,而镇上同时几十个人的量级,5 Hz 的 POST 完全够。真到几百人同屏
 * 再换二进制帧的 WebSocket —— 那时候要换的也只是这一个文件。
 *
 * 位置由客户端说了算(这里不做物理):一个只能在镇上散步的世界,作弊的收益是"穿墙",
 * 没有对抗性。服务端只做三件事:夹住范围、限速、限频。
 */
const express = require('express');
const crypto = require('crypto');
const bus = require('./cowork-bus');
const db = require('./db');

const router = express.Router();

const CH = 'town:main';              // 现在只有一座镇;将来一座城一条频道
const STALE_MS = 45000;              // 45 秒没动静就当他走了
const TICK_MS = 200;                 // 5 Hz:走路的世界不需要更快
const MAX_PEERS = 60;                // 一座镇同时最多这么多人(再多就该分镇了)
const MAX_R = 1200;                  // 镇子半径之外不存在
const MAX_SPEED = 12;                // 米/秒:跑起来 6.5,留一倍余量给卡顿后的补偿
const NAME_MAX = 20;
const SAY_MAX = 120;                 // 一句话,不是一封信
const LANTERNS_PER_DAY = 20, NOTES_PER_DAY = 5;

/* 字条只能从这里挑一句。Dark Souls 的老办法:词是给定的,于是不需要审核,
   也不可能有人在镇中心写脏话 —— 而"有人来过、还留了话"这件事照样成立。 */
const NOTES = [
  'somebody was here', 'try this one', 'good code lives here', 'look up',
  'this way to the square', 'the door is round the back', 'worth reading',
  'start here if you are new', 'beautiful at night', 'still maintained',
];

/** 看不见的字符、方向控制符:改名字的老把戏(和 rooms.js 的那道一样)。 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;
const cleanName = (s) => String(s || '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

/** 镇上的人:id → { name, x, z, yaw, v, at, ip } */
const people = new Map();
/* agent 小伙伴头顶光点的颜色:只收这几种字面值(别人屏幕上显示的是它,不能让人塞任意字符串) */
const AGENTS = new Set(['claude-code', 'codex', 'cursor', 'openclaw', 'gemini', 'ollama']);
/* 点对点的那几条(狗和狗的邀请):id → 这个人开着的几条流。⚠ 不走 bus —— bus 发给镇上所有人,
   而邀请里带着两人房间的加入码,只能到收件人一个人那儿。 */
const streams = new Map();
function sendTo(id, msg) {
  const set = streams.get(id);
  if (!set || !set.size) return false;
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const r of set) { try { r.write(line); } catch (e) {} }
  return true;
}
/** 限频:id → { n, until } */
const buckets = new Map();
let dirty = false, timer = null;

const idOf = (req) => {
  const raw = String(req.get('x-terse-identity') || req.query.identity || '').trim();
  if (!raw || raw.length < 8) return '';
  // 对外露出的是短哈希,不是身份本身(和广场、私信同一套:见 api/dm.js)
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
};

function allow(id, n = 20) {
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || now > b.until) { b = { n: 0, until: now + 1000 }; buckets.set(id, b); }
  b.n += 1;
  return b.n <= n;
}

/** 广播的那一份:只有活着的人,只有画得着的字段。 */
function roster() {
  const now = Date.now(), out = [];
  for (const [id, p] of people) {
    if (now - p.at > STALE_MS) { people.delete(id); dirty = true; continue; }
    out.push({ id, name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(2), v: +p.v.toFixed(1), e: p.e || 0, a: p.a || '' });
  }
  return out;
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    const list = roster();
    if (!dirty) return;                 // 没人动就不发:站着不动的镇子不该占带宽
    dirty = false;
    bus.emit(CH, { type: 'peers', peers: list, at: Date.now() });
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

/** 镇上有多少人(广场的列表要显示,不用连 SSE)。 */
router.get('/count', (req, res) => {
  res.set('Cache-Control', 'public, max-age=5');
  res.json({ ok: true, people: roster().length });
});

/** 进镇。只有登录的人能走 —— 没有身份就只能看。 */
router.post('/join', express.json({ limit: '2kb' }), (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in to walk' });
  if (people.size >= MAX_PEERS && !people.has(id)) return res.status(503).json({ error: 'Town is full' });
  const name = cleanName((req.body || {}).name) || 'someone';
  const p = people.get(id) || { x: 0, z: 0, yaw: 0, v: 0 };
  /* fresh:进镇后的第一步"人在哪就是哪" —— 出生点离原点几十米,不放行的话小人会从
     镇中心一路爬过去(每步只准走 0.9 米)。 */
  people.set(id, Object.assign(p, { name, at: Date.now(), fresh: true }));
  dirty = true;
  start();
  res.json({ ok: true, id, people: roster().length });
});

/** 走了一步。客户端 5–10 Hz 发一次,没动就不发。 */
router.post('/move', express.json({ limit: '1kb' }), (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in to walk' });
  if (!allow(id)) return res.status(429).json({ error: 'Slow down' });
  const p = people.get(id);
  if (!p) return res.status(409).json({ error: 'Join first' });
  const b = req.body || {};
  const x = +b.x, z = +b.z, yaw = +b.yaw, v = +b.v;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return res.status(400).json({ error: 'Bad position' });
  const now = Date.now(), dt = Math.max(0.05, (now - p.at) / 1000);
  const step = Math.hypot(x - p.x, z - p.z);
  /* 夹住而不是踢掉:手机切后台再回来,一步跨出几十米是常事,那不是作弊。
     刚进镇的第一步、以及隔了两秒以上的那一步直接认 —— 那是出生,和回到前台。 */
  if (p.fresh || now - p.at > 2000) { p.fresh = false; p.x = x; p.z = z; }
  else if (step > MAX_SPEED * dt * 1.5) {
    const k = (MAX_SPEED * dt * 1.5) / step;
    p.x += (x - p.x) * k; p.z += (z - p.z) * k;
  } else { p.x = x; p.z = z; }
  const r = Math.hypot(p.x, p.z);
  if (r > MAX_R) { p.x = (p.x / r) * MAX_R; p.z = (p.z / r) * MAX_R; }
  p.yaw = yaw; p.v = Math.max(0, Math.min(MAX_SPEED, v || 0)); p.at = now;
  p.e = Math.max(0, Math.min(7, parseInt(b.e, 10) || 0));   // 表情:0 没有,1–7 各是一个动作
  p.a = AGENTS.has(b.a) ? b.a : '';                           // 小伙伴接的 agent 种类(没接 = 空)
  dirty = true;
  res.json({ ok: true });
});

/** 说一句话。飘在头顶几秒,不存下来 —— 镇上是路过的闲聊,不是聊天记录。 */
router.post('/say', express.json({ limit: '2kb' }), (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in to talk' });
  if (!allow(id, 4)) return res.status(429).json({ error: 'Slow down' });
  const p = people.get(id);
  if (!p) return res.status(409).json({ error: 'Join first' });
  const text = String((req.body || {}).text || '').replace(INVISIBLE, '').trim().slice(0, SAY_MAX);
  if (!text) return res.status(400).json({ error: 'Nothing to say' });
  bus.emit(CH, { type: 'say', id, name: p.name, text, at: Date.now() });
  res.json({ ok: true });
});

/** 镇上留下的东西:灯和字条(谁都看得见,一直在)。 */
router.get('/marks', (req, res) => {
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ ok: true, marks: db.townMarks.all({ limit: 400 }), notes: NOTES });
});

router.post('/mark', express.json({ limit: '2kb' }), (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in first' });
  if (!allow(id, 4)) return res.status(429).json({ error: 'Slow down' });
  const b = req.body || {};
  const kind = b.kind === 'note' ? 'note' : 'lantern';
  const x = +b.x, z = +b.z;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) > MAX_R) return res.status(400).json({ error: 'Bad spot' });
  const cap = kind === 'note' ? NOTES_PER_DAY : LANTERNS_PER_DAY;
  if (db.townMarksToday.get({ owner: id, kind }).n >= cap) return res.status(429).json({ error: 'That is enough for today' });
  // 字条只能是模板里的一句 —— 客户端给的是下标,不是文字
  const text = kind === 'note' ? NOTES[Math.max(0, Math.min(NOTES.length - 1, parseInt(b.note, 10) || 0))] : null;
  const p = people.get(id);
  const mark = { id: crypto.randomBytes(8).toString('hex'), kind, owner: id, name: (p && p.name) || 'someone',
    x: +x.toFixed(1), z: +z.toFixed(1), text };
  db.addTownMark.run(mark);
  bus.emit(CH, { type: 'mark', mark });
  res.json({ ok: true, mark });
});

/** 自己放的东西,自己可以收走。 */
router.post('/mark/:id/remove', (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in first' });
  db.removeTownMark.run({ id: String(req.params.id || ''), owner: id });
  bus.emit(CH, { type: 'unmark', id: String(req.params.id || '') });
  res.json({ ok: true });
});

/** 走了。 */
router.post('/leave', (req, res) => {
  const id = idOf(req);
  if (id && people.delete(id)) dirty = true;
  res.json({ ok: true });
});

/** 镇上的动静。EventSource 不能带头,身份走查询串(和 rooms 的 ?key= 一个道理)。 */
router.get('/stream', (req, res) => {
  const id = idOf(req);
  res.set({
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.flushHeaders && res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', you: id || null, peers: roster() })}\n\n`);
  const off = bus.subscribe(CH, res);
  if (id) { if (!streams.has(id)) streams.set(id, new Set()); streams.get(id).add(res); }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  if (ping.unref) ping.unref();
  req.on('close', () => {
    clearInterval(ping); off();
    const set = id && streams.get(id);
    if (set) { set.delete(res); if (!set.size) streams.delete(id); }
  });
  start();
});

/* ── 狗和狗:让两个人的 agent 认识 ──
   A 走到 B 的小伙伴跟前按 T → A 的电脑开一个两人的私密房间 → 这里把加入码**只**转给 B。
   B 点了接受,B 的电脑用码进房间、把自己的 agent 接进去;两只 agent 在房间里聊,两个人都看得见、插得上话。
   闸门:两个人此刻都得在镇上(邀请是"当面"的,不是隔空骚扰);每人每分钟 5 次;码的格式写死。 */
const PET_CODE = /^[A-Z0-9]{4,16}$/;
function petAllow(id) {
  const k = 'pet:' + id, now = Date.now();
  let b = buckets.get(k);
  if (!b || now > b.until) { b = { n: 0, until: now + 60000 }; buckets.set(k, b); }
  b.n += 1;
  return b.n <= 5;
}
router.post('/pet/invite', express.json({ limit: '1kb' }), (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in to walk' });
  const b = req.body || {};
  const to = String(b.to || ''), code = String(b.code || '').toUpperCase();
  if (to === id || !/^[0-9a-f]{32}$/.test(to)) return res.status(400).json({ error: 'Bad recipient' });
  if (!PET_CODE.test(code)) return res.status(400).json({ error: 'Bad code' });
  const me = people.get(id), them = people.get(to);
  if (!me || !them) return res.status(409).json({ error: 'Both of you need to be in town' });
  if (!petAllow(id)) return res.status(429).json({ error: 'Slow down' });
  const sent = sendTo(to, { type: 'petInvite', from: id, fromName: me.name, pet: cleanName(b.pet), code });
  res.json({ ok: true, delivered: sent });
});
router.post('/pet/reply', express.json({ limit: '1kb' }), (req, res) => {
  const id = idOf(req);
  if (!id) return res.status(401).json({ error: 'Sign in to walk' });
  const to = String((req.body || {}).to || '');
  if (to === id || !/^[0-9a-f]{32}$/.test(to)) return res.status(400).json({ error: 'Bad recipient' });
  if (!petAllow(id)) return res.status(429).json({ error: 'Slow down' });
  const me = people.get(id);
  const sent = sendTo(to, { type: 'petReply', from: id, fromName: me ? me.name : '', ok: !!(req.body || {}).ok });
  res.json({ ok: true, delivered: sent });
});

/** 测试用:把镇子清空。 */
router.reset = () => { people.clear(); buckets.clear(); streams.clear(); dirty = false; };
router.people = people;
router.NOTES = NOTES;

module.exports = router;
