/**
 * play.js — 小镇里能玩的那一半的账本:光点(Glim)、每日告示、谜题、钓 bug、卷轴、
 * 护照印章、种树浇水、门口的装饰、宝箱。
 *
 * 规则全在 src/renderer/town-play.mjs(浏览器和这里共用那一份纯函数);这里只做
 * 三件事:验账(今天的告示/谜题/卷轴/那一竿钓上来什么,由服务端自己算)、记账
 * (每一笔进出进 play_ledger)、限额(每天 CAPS.perDay,宝箱和护照页除外)。
 *
 *   GET  /state?lang=            今天的一切;没登录也能看(profile: null,只有公共部分)
 *   POST /event  {type, villa, name?}      visit | talk | enter | lantern | knock
 *   POST /riddle {guess}
 *   POST /cast   {where, hour, weather, langs}
 *   POST /reel   {n, ok}
 *   POST /scroll {id}
 *   POST /tree   {villa, name?}
 *   POST /tree/:id/water
 *   POST /decor  {villa, item, value}
 *   POST /chest
 *
 * 身份和 api/npc.js 一样:x-terse-identity → sha256 前 32 位;wall_projects.identity
 * 用的是同一串,所以"我的别墅" = owner === 我。
 *
 * ⚠ 钓鱼时的钟点、天气、身边的语言是客户端说的(服务端不知道你站在哪)。能骗到的
 * 只是稀有鱼的概率,而鱼的光点每天有 CAPS.fish 的顶。
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

let playP = null, folkP = null;
const play = () => playP || (playP = import('../src/renderer/town-play.mjs'));
const folk = () => folkP || (folkP = import('../src/renderer/town-folk.mjs'));

const CACHE_MS = 10 * 60 * 1000;
const STYLES = ['tang', 'edo', 'giza', 'hellas', 'maya', 'persia', 'norse', 'modern'];
const WEATHERS = ['clear', 'cloudy', 'rain', 'drizzle', 'storm', 'snow', 'fog', 'wind'];
const EVENT_TYPES = ['visit', 'talk', 'enter', 'lantern', 'knock'];
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;
const NAME_MAX = 20;

let nowFn = () => Date.now();

const idOf = (req) => {
  const raw = String(req.get('x-terse-identity') || req.query.identity || '').trim();
  if (!raw || raw.length < 8) return '';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
};
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(s);
const cleanName = (s) => String(s || '').replace(INVISIBLE, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
const langHint = (req) => (String(req.query.lang || (req.body && req.body.lang) || req.get('accept-language') || '')
  .toLowerCase().startsWith('zh') ? 'zh' : 'en');
const parseJSON = (s, dflt) => { try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; } };

/* ── 限频:每人每秒 20 次 ─────────────────────────────────────────────── */
const buckets = new Map();
function allow(key, n = 20) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.until) {
    if (buckets.size > 20000) for (const [k, v] of buckets) if (now > v.until) buckets.delete(k);
    b = { n: 0, until: now + 1000 };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n <= n;
}

/* ── 镇上的房子:最近 100 座(缓存 10 分钟) ──────────────────────────── */
let townCache = { at: 0, houses: [], byId: new Map(), riddleIn: [], derived: new Map() };

async function town() {
  if (Date.now() - townCache.at < CACHE_MS && townCache.houses.length) return townCache;
  const [F, P] = await Promise.all([folk(), play()]);
  const rows = db.listWallProjects.all({ limit: 100 });
  const houses = [], riddleIn = [];
  for (const row of rows) {
    let capsule = null;
    try { capsule = JSON.parse(row.capsule); } catch (e) { capsule = null; }
    if (!capsule || typeof capsule !== 'object') capsule = {};
    if (!capsule.title) capsule.title = row.title;
    const facts = F.projectFacts(row.id, capsule);
    const h = {
      id: row.id,
      title: facts.title,
      lang: facts.lang,
      style: STYLES.includes(capsule.style) ? capsule.style : 'modern',
      trade: F.personaOf(row.id, facts).trade,
      busy: P.busyOf(capsule),
      hot: P.hotFileOf(capsule),
      people: Array.isArray(capsule.people) ? capsule.people.length : 0,
      owner: row.identity,
    };
    houses.push(h);
    riddleIn.push({ id: h.id, facts, extra: { hot: h.hot, people: h.people } });
  }
  townCache = { at: Date.now(), houses, byId: new Map(houses.map((h) => [h.id, h])), riddleIn, derived: new Map() };
  return townCache;
}

/** 今天的告示、谜题、卷轴(对这一版房子列表算一次)。 */
function today(P, T, day) {
  let d = T.derived.get(day);
  if (!d) {
    d = {
      quests: P.dailyQuests(day, { houses: T.houses }),
      riddle: P.riddleOf(day, T.riddleIn),
      scrolls: P.scrollsOf(day, T.houses),
    };
    if (T.derived.size > 4) T.derived.clear();
    T.derived.set(day, d);
  }
  return d;
}

/* ── 账本 ─────────────────────────────────────────────────────────────── */
let prunedDay = -1;
function maybePrune(day) {
  if (prunedDay === day) return;
  prunedDay = day;
  try {
    db.playPrune.run(day - 3); db.playPruneSeen.run(day - 3);
    db.playPruneKnock.run(day - 3); db.playPruneWater.run(day - 3);
  } catch (e) { /* 清理失败不影响玩 */ }
}

function dayRow(uid, day) {
  db.playProfileEnsure.run(uid);
  db.playDayEnsure.run({ user_id: uid, day });
  return db.playDayGet.get({ user_id: uid, day });
}

/**
 * 发光点。返回实际发了多少。
 * opts.bucket / opts.bucketCap:某一项自己的每日上限(按光点算);
 * opts.count / opts.countCap:按次数算的上限(到了就不发,没到就计一次);
 * opts.bypass:宝箱、护照页 —— 不看、也不占每日上限。
 */
function award(uid, day, amount, reason, ref, opts = {}) {
  const d = dayRow(uid, day);
  let n = Math.max(0, Math.floor(amount));
  if (opts.count) {
    if (d[opts.count] >= opts.countCap) n = 0;
    else db.playDayBump(opts.count, { user_id: uid, day, n: 1 });
  }
  if (opts.bucket) n = Math.min(n, Math.max(0, opts.bucketCap - d[opts.bucket]));
  if (!opts.bypass) n = Math.min(n, Math.max(0, CAPS().perDay - d.earned));
  if (n <= 0) return 0;
  if (opts.bucket) db.playDayBump(opts.bucket, { user_id: uid, day, n });
  if (!opts.bypass) db.playDayBump('earned', { user_id: uid, day, n });
  db.playProfileAdd.run({ user_id: uid, glim: n, xp: n, qd: 0, now: nowFn() });
  db.playLedgerAdd.run({ user_id: uid, ts: nowFn(), day, delta: n, reason, ref: ref == null ? null : String(ref) });
  return n;
}
function spend(uid, day, amount, reason, ref) {
  db.playProfileEnsure.run(uid);
  db.playProfileAdd.run({ user_id: uid, glim: -amount, xp: 0, qd: 0, now: nowFn() });
  db.playLedgerAdd.run({ user_id: uid, ts: nowFn(), day, delta: -amount, reason, ref: ref == null ? null : String(ref) });
}

let P_ = null;           // 同步用的那份 town-play(第一次请求前已经 import 过)
const CAPS = () => P_.CAPS;

function profileOut(P, uid, day) {
  if (!uid) return null;
  const p = db.playProfileGet.get(uid) || { glim: 0, xp: 0, quest_days: 0 };
  const d = db.playDayGet.get({ user_id: uid, day });
  return {
    glim: p.glim, xp: p.xp, level: P.levelOf(p.xp),
    questDays: p.quest_days, chestReady: p.quest_days >= 7,
    earnedToday: d ? d.earned : 0, cap: P.CAPS.perDay,
    name: p.name || null,
  };
}

function questsOut(D, uid, day) {
  const d = uid ? db.playDayGet.get({ user_id: uid, day }) : null;
  const prog = d ? parseJSON(d.progress, {}) : {};
  return D.quests.map((q) => {
    const progress = Math.min(q.n, prog[q.id] || 0);
    return Object.assign({}, q, { progress, done: progress >= q.n });
  });
}

/** 每日告示的进度。ev 由服务端从房子数据拼出来,不信客户端。返回发了多少光点。 */
function questEvent(P, D, uid, day, ev, fest) {
  const d = dayRow(uid, day);
  const prog = parseJSON(d.progress, {});
  let gained = 0, changed = false;
  for (const q of D.quests) {
    const cur = prog[q.id] || 0;
    if (cur >= q.n || !P.questMatches(q, ev)) continue;
    prog[q.id] = cur + 1;
    changed = true;
    if (prog[q.id] >= q.n) {
      const perk = q.kind === 'plant' || q.kind === 'water' ? 'water' : q.kind;
      const mult = fest && fest.perk === perk ? P.REWARD.festival : 1;
      gained += award(uid, day, q.reward * mult, 'quest', q.id);
    }
  }
  if (!changed) return 0;
  const allDone = D.quests.length > 0 && D.quests.every((q) => (prog[q.id] || 0) >= q.n);
  const first = allDone && !d.done_all;
  db.playDaySetProgress.run({ user_id: uid, day, progress: JSON.stringify(prog), done_all: allDone || d.done_all ? 1 : 0 });
  if (first) db.playProfileAdd.run({ user_id: uid, glim: 0, xp: 0, qd: 1, now: nowFn() });
  return gained;
}

function ownerBump(house, uid, day, kind) {
  if (!house || !house.owner || house.owner === uid) return;
  db.playOwnerBump.run({ day, villa: house.id, kind });
}

/* ── 谜题 ─────────────────────────────────────────────────────────────── */
function riddleState(uid, day) {
  const d = uid ? db.playDayGet.get({ user_id: uid, day }) : null;
  const r = d ? parseJSON(d.riddle, null) : null;
  return r && Array.isArray(r.g) ? r : { g: [], solved: false, failed: false };
}
function riddleOut(P, R, st, day, lang) {
  if (!R) return null;
  const n = st.g.length, finished = st.solved || st.failed;
  const out = {
    clues: R.clues.slice(0, finished ? R.clues.length : Math.min(R.clues.length, n + 1)),
    guesses: n, guessed: st.g.slice(), solved: !!st.solved, failed: !!st.failed, max: R.max,
  };
  if (finished) {
    out.answer = R.answer;
    out.title = R.title;
    out.share = P.riddleShare(day, n, !!st.solved, lang);
  }
  return out;
}

/* ── 图鉴 ─────────────────────────────────────────────────────────────── */
function codexOut(uid) {
  const out = { bugs: {}, scrolls: [] };
  if (!uid) return out;
  for (const r of db.playCodexOf.all(uid)) {
    if (r.kind === 'bug') out.bugs[r.key] = { n: r.n, best: r.best };
    else if (r.kind === 'scroll') {
      const x = parseJSON(r.extra, {});
      out.scrolls.push({ id: r.key, villa: x.villa || '', file: x.file || '' });
    }
  }
  return out;
}

function treeOut(P, t, watered) {
  return { id: t.id, villa: t.villa, slot: t.slot, stage: P.treeStage(t.water_days), waterDays: t.water_days,
    planter: t.planter_name || 'someone', wateredToday: watered ? watered.has(t.id) : false };
}

/* ── 请求的公共外壳 ────────────────────────────────────────────────────── */
async function ctx(req, res, { auth = true } = {}) {
  const uid = idOf(req);
  if (auth && !uid) { res.status(401).json({ error: 'Sign in first' }); return null; }
  if (!allow(uid || 'ip:' + (req.ip || ''))) { res.status(429).json({ error: 'Slow down' }); return null; }
  const P = await play();
  P_ = P;
  const T = await town();
  const now = nowFn();
  const day = P.dayIndex(now);
  maybePrune(day);
  return { uid, P, T, now, day, D: today(P, T, day), fest: P.festivalOn(now), lang: langHint(req) };
}
const fail = (res, code, error) => { res.status(code).json({ error }); return null; };
const handle = (fn) => async (req, res) => {
  try {
    const c = await ctx(req, res);
    if (!c) return;
    const out = db.db.transaction(() => fn(c, req, res))();
    if (out && !res.headersSent) res.json(out);
  } catch (err) {
    console.warn('[play] failed:', err && err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
  }
};
const json = express.json({ limit: '4kb' });
function setName(uid, raw) {
  const name = cleanName(raw);
  if (!name) return;
  db.playProfileEnsure.run(uid);
  db.playProfileName.run({ user_id: uid, name });
}

/* ── GET /state ───────────────────────────────────────────────────────── */
router.get('/state', async (req, res) => {
  try {
    const c = await ctx(req, res, { auth: false });
    if (!c) return;
    const { uid, P, T, day, D, fest, lang } = c;
    const mine = uid ? T.houses.filter((h) => h.owner === uid).map((h) => h.id) : [];
    const stamps = uid ? db.playStampsOf.all(uid).map((r) => r.key) : [];
    const codex = codexOut(uid);
    const taken = new Set(codex.scrolls.map((s) => s.id));
    const d = uid ? db.playDayGet.get({ user_id: uid, day }) : null;
    const watered = uid ? new Set(db.playWateredBy.all({ user_id: uid, day }).map((r) => r.tree_id)) : null;
    const trees = db.playTreesAll.all().filter((t) => T.byId.has(t.villa)).map((t) => treeOut(P, t, watered));
    const decor = {};
    for (const r of db.playDecorAll.all()) {
      if (!T.byId.has(r.villa)) continue;
      (decor[r.villa] || (decor[r.villa] = {}))[r.item] = r.value;
    }
    const digest = { visits: 0, knocks: 0, waters: 0, plants: 0 };
    if (mine.length) {
      const set = new Set(mine);
      for (const r of db.playOwnerDay.all(day)) if (set.has(r.villa) && r.kind in digest) digest[r.kind] += r.n;
    }
    res.json({
      ok: true, day, festival: fest,
      profile: profileOut(P, uid, day),
      quests: questsOut(D, uid, day),
      riddle: riddleOut(P, D.riddle, riddleState(uid, day), day, lang),
      stamps, codex,
      scrolls: D.scrolls.map((s) => Object.assign({}, s, { taken: taken.has(s.id) })),
      castsLeft: P.CAPS.casts - (d ? d.casts : 0),
      trees, decor, mine, digest,
    });
  } catch (err) {
    console.warn('[play] state failed:', err && err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
  }
});

/* ── POST /event ──────────────────────────────────────────────────────── */
router.post('/event', json, handle(({ uid, P, T, day, D, fest }, req, res) => {
  const b = req.body || {};
  const type = b.type;
  if (!EVENT_TYPES.includes(type)) return fail(res, 400, 'Bad event');
  const needsVilla = type === 'visit' || type === 'talk' || type === 'knock';
  let house = null;
  if (b.villa != null && b.villa !== '') {
    if (!validId(b.villa)) return fail(res, 400, 'Bad villa');
    house = T.byId.get(b.villa) || null;
    if (!house) return fail(res, 404, 'No such villa');
  } else if (needsVilla) return fail(res, 400, 'Missing villa');
  if (b.name != null) setName(uid, b.name);
  dayRow(uid, day);

  let gained = 0, countQuest = true, knocked = false;
  const fresh = [];
  if (type === 'visit') {
    for (const key of P.stampsFor(house)) {
      if (!db.playStampAdd.run({ user_id: uid, key, day }).changes) continue;
      fresh.push(key);
      const featured = fest && key === 'lang:' + String(house.lang).toLowerCase() && P.normLang(house.lang) === fest.lang;
      gained += award(uid, day, P.REWARD.stampNew * (featured ? 2 : 1), 'stamp', key);
    }
    if (fresh.length) {
      const all = db.playStampsOf.all(uid).map((r) => r.key);
      for (const page of ['lang', 'style']) {
        const have = all.filter((k) => k.startsWith(page + ':')).length;
        if (have < P.PASSPORT_GOALS[page]) continue;
        if (db.playCodexGet.get({ user_id: uid, kind: 'page', key: page })) continue;
        db.playCodexAdd.run({ user_id: uid, kind: 'page', key: page, best: 0, extra: null });
        gained += award(uid, day, P.REWARD.pageDone, 'page', page, { bypass: true });
      }
    }
    const first = db.playSeenAdd.run({ user_id: uid, day, kind: 'visit', villa: house.id }).changes > 0;
    if (first) ownerBump(house, uid, day, 'visits');
    countQuest = first;
  } else if (type === 'talk') {
    countQuest = db.playSeenAdd.run({ user_id: uid, day, kind: 'talk', villa: house.id }).changes > 0;
  } else if (type === 'knock') {
    countQuest = false;
    // 不为点赞发奖励:光点给房主;敲门的人什么也不拿,敲自己家也什么都不算
    if (house.owner && house.owner !== uid && db.playKnockAdd.run({ day, villa: house.id, user_id: uid }).changes) {
      knocked = true;
      ownerBump(house, uid, day, 'knocks');
      const mult = fest && fest.perk === 'knock' ? P.REWARD.festival : 1;
      award(house.owner, day, P.REWARD.knockOwner * mult, 'knocked', house.id,
        { bucket: 'knock_glim', bucketCap: P.CAPS.knockOwner });
    }
  }
  if (countQuest) {
    const ev = { type, villa: house ? house.id : '' };
    if (house) Object.assign(ev, { lang: house.lang, style: house.style, busy: house.busy, trade: house.trade });
    gained += questEvent(P, D, uid, day, ev, fest);
  }
  const out = { ok: true, gained, stamps: fresh, quests: questsOut(D, uid, day), profile: profileOut(P, uid, day) };
  if (type === 'knock') out.knocked = knocked;
  return out;
}));

/* ── POST /riddle ─────────────────────────────────────────────────────── */
router.post('/riddle', json, handle(({ uid, P, T, day, D, fest, lang }, req, res) => {
  const guess = req.body && req.body.guess;
  if (!validId(guess)) return fail(res, 400, 'Bad guess');
  if (!T.byId.has(guess)) return fail(res, 404, 'No such villa');
  const R = D.riddle;
  if (!R) return fail(res, 404, 'No riddle today');
  dayRow(uid, day);
  const st = riddleState(uid, day);
  if (st.solved || st.failed) return fail(res, 409, 'Riddle already finished');
  let gained = 0, correct = false;
  if (st.g.includes(guess)) {
    return Object.assign({ ok: true, correct: false, repeat: true, gained: 0 }, riddleOut(P, R, st, day, lang));
  }
  st.g.push(guess);
  if (guess === R.answer) {
    correct = true;
    st.solved = true;
    gained += award(uid, day, P.REWARD.riddle + (st.g.length <= 3 ? P.REWARD.riddleFast : 0), 'riddle', day);
    gained += questEvent(P, D, uid, day, { type: 'riddle' }, fest);
  } else if (st.g.length >= R.max) st.failed = true;
  db.playDaySetRiddle.run({ user_id: uid, day, riddle: JSON.stringify(st) });
  return Object.assign({ ok: true, correct, gained }, riddleOut(P, R, st, day, lang), { profile: profileOut(P, uid, day) });
}));

/* ── 钓 bug ───────────────────────────────────────────────────────────── */
router.post('/cast', json, handle(({ uid, P, day }, req, res) => {
  const b = req.body || {};
  if (b.where !== 'moat' && b.where !== 'stream') return fail(res, 400, 'Bad water');
  const hour = Number(b.hour);
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) return fail(res, 400, 'Bad hour');
  const weather = WEATHERS.includes(b.weather) ? b.weather : 'clear';
  if (b.langs != null && !Array.isArray(b.langs)) return fail(res, 400, 'Bad langs');
  const langs = (b.langs || []).slice(0, 3).filter((l) => typeof l === 'string' && l.length <= 24);
  const d = dayRow(uid, day);
  if (d.casts >= P.CAPS.casts) return fail(res, 429, 'No more casts today');
  const n = d.casts;
  db.playDayBump('casts', { user_id: uid, day, n: 1 });
  const r = P.castResult(uid + '|' + day + '|' + n, b.where, Math.min(hour, 23.99), weather, langs);
  db.playCastAdd.run({ user_id: uid, day, n, bug: r.bug.id, len: r.len });
  const g = r.bug;
  return { ok: true,
    cast: { n, bite: r.bite, window: r.window, len: r.len,
      bug: { id: g.id, en: g.en, zh: g.zh, rare: g.rare, price: g.price, col: g.col } },
    castsLeft: P.CAPS.casts - n - 1 };
}));

router.post('/reel', json, handle(({ uid, P, day, D, fest }, req, res) => {
  const b = req.body || {};
  const n = Number(b.n);
  if (!Number.isInteger(n) || n < 0 || n > 10000) return fail(res, 400, 'Bad cast');
  const cast = db.playCastGet.get({ user_id: uid, day, n });
  if (!cast) return fail(res, 404, 'No such cast');
  if (cast.reeled || !db.playCastReel.run({ user_id: uid, day, n }).changes) return fail(res, 409, 'Already reeled');
  if (b.ok !== true) return { ok: true, caught: false };
  const bug = P.BUGS.find((x) => x.id === cast.bug);
  if (!bug) return { ok: true, caught: false };
  const newSpecies = !db.playCodexGet.get({ user_id: uid, kind: 'bug', key: bug.id });
  db.playCodexAdd.run({ user_id: uid, kind: 'bug', key: bug.id, best: cast.len, extra: null });
  const mult = fest && fest.perk === 'fish' ? P.REWARD.festival : 1;
  let gained = award(uid, day, P.REWARD.fish(bug) * mult, 'fish', bug.id, { bucket: 'fish_glim', bucketCap: P.CAPS.fish });
  gained += questEvent(P, D, uid, day, { type: 'fish' }, fest);
  return { ok: true, caught: true,
    bug: { id: bug.id, en: bug.en, zh: bug.zh, rare: bug.rare, price: bug.price, col: bug.col },
    len: cast.len, gained, newSpecies, codex: codexOut(uid),
    quests: questsOut(D, uid, day), profile: profileOut(P, uid, day) };
}));

/* ── 卷轴 ─────────────────────────────────────────────────────────────── */
router.post('/scroll', json, handle(({ uid, P, day, D, fest }, req, res) => {
  const id = req.body && req.body.id;
  if (!validId(id)) return fail(res, 400, 'Bad scroll');
  const s = D.scrolls.find((x) => x.id === id);
  if (!s) return fail(res, 404, 'No such scroll today');
  if (db.playCodexGet.get({ user_id: uid, kind: 'scroll', key: id })) return fail(res, 409, 'Already taken');
  db.playCodexAdd.run({ user_id: uid, kind: 'scroll', key: id, best: 0, extra: JSON.stringify({ villa: s.villa, file: s.file }) });
  let gained = award(uid, day, P.REWARD.scroll, 'scroll', id, { count: 'scroll_n', countCap: P.CAPS.scrolls });
  gained += questEvent(P, D, uid, day, { type: 'scroll' }, fest);
  return { ok: true, gained, scroll: { id, villa: s.villa, file: s.file },
    quests: questsOut(D, uid, day), profile: profileOut(P, uid, day) };
}));

/* ── 种树、浇水 ───────────────────────────────────────────────────────── */
router.post('/tree', json, handle(({ uid, P, T, day, D, fest }, req, res) => {
  const b = req.body || {};
  if (!validId(b.villa)) return fail(res, 400, 'Bad villa');
  const house = T.byId.get(b.villa);
  if (!house) return fail(res, 404, 'No such villa');
  if (house.owner === uid) return fail(res, 403, 'Not at your own villa');
  if (b.name != null) setName(uid, b.name);
  const at = db.playTreesAt.all(house.id);
  if (at.length >= P.CAPS.treesPerVilla) return fail(res, 409, 'No room for another tree');
  if (at.some((t) => t.planter === uid)) return fail(res, 409, 'You already planted here');
  dayRow(uid, day);
  const prof = db.playProfileGet.get(uid);
  if (prof.glim < P.COST.tree) return fail(res, 402, 'Not enough glim');
  const used = new Set(at.map((t) => t.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  spend(uid, day, P.COST.tree, 'tree', house.id);
  const info = db.playTreeAdd.run({ villa: house.id, slot, planter: uid, planter_name: prof.name || null, day });
  ownerBump(house, uid, day, 'plants');
  const gained = questEvent(P, D, uid, day, { type: 'plant', villa: house.id }, fest);
  return { ok: true, gained, tree: treeOut(P, db.playTreeGet.get(info.lastInsertRowid), null),
    quests: questsOut(D, uid, day), profile: profileOut(P, uid, day) };
}));

router.post('/tree/:id/water', json, handle(({ uid, P, T, day, D, fest }, req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Bad tree');
  const tree = db.playTreeGet.get(id);
  if (!tree || !T.byId.has(tree.villa)) return fail(res, 404, 'No such tree');
  dayRow(uid, day);
  if (!db.playWaterAdd.run({ tree_id: id, user_id: uid, day }).changes) return fail(res, 409, 'Already watered today');
  db.playTreeWatered.run({ id, day });
  ownerBump(T.byId.get(tree.villa), uid, day, 'waters');
  const mult = fest && fest.perk === 'water' ? P.REWARD.festival : 1;
  let gained = award(uid, day, P.REWARD.water * mult, 'water', id, { count: 'water_n', countCap: P.CAPS.waters });
  gained += questEvent(P, D, uid, day, { type: 'water', villa: tree.villa }, fest);
  return { ok: true, gained, tree: treeOut(P, db.playTreeGet.get(id), new Set([id])),
    quests: questsOut(D, uid, day), profile: profileOut(P, uid, day) };
}));

/* ── 门口的装饰(只有房主) ─────────────────────────────────────────────── */
router.post('/decor', json, handle(({ uid, P, T, day }, req, res) => {
  const b = req.body || {};
  if (!validId(b.villa)) return fail(res, 400, 'Bad villa');
  const house = T.byId.get(b.villa);
  if (!house) return fail(res, 404, 'No such villa');
  if (house.owner !== uid) return fail(res, 403, 'Only the owner can decorate');
  if (typeof b.item !== 'string' || !Object.prototype.hasOwnProperty.call(P.COST.decor, b.item)) return fail(res, 400, 'Bad item');
  const value = Number(b.value);
  if (!Number.isInteger(value) || value < 0 || value > 7) return fail(res, 400, 'Bad value');
  dayRow(uid, day);
  const had = db.playDecorGet.get({ villa: house.id, item: b.item });
  let spent = 0;
  if (!had) {
    const cost = P.COST.decor[b.item];
    if (db.playProfileGet.get(uid).glim < cost) return fail(res, 402, 'Not enough glim');
    spend(uid, day, cost, 'decor', house.id + ':' + b.item);
    spent = cost;
  }
  db.playDecorSet.run({ villa: house.id, item: b.item, value, owner: uid });
  const decor = {};
  for (const r of db.playDecorAll.all()) if (r.villa === house.id) decor[r.item] = r.value;
  return { ok: true, spent, villa: house.id, decor, profile: profileOut(P, uid, day) };
}));

/* ── 宝箱:任意 7 个做完差事的日子 ─────────────────────────────────────── */
router.post('/chest', json, handle(({ uid, P, day }, req, res) => {
  dayRow(uid, day);
  const p = db.playProfileGet.get(uid);
  if (p.quest_days < 7) return fail(res, 409, 'Chest not ready');
  db.playProfileAdd.run({ user_id: uid, glim: 0, xp: 0, qd: -7, now: nowFn() });
  const gained = award(uid, day, P.REWARD.chest, 'chest', null, { bypass: true });
  return { ok: true, gained, profile: profileOut(P, uid, day) };
}));

/** 测试用:清空缓存和限频;换一个钟。 */
router.reset = () => {
  buckets.clear();
  prunedDay = -1;
  townCache = { at: 0, houses: [], byId: new Map(), riddleIn: [], derived: new Map() };
};
router._setNow = (fn) => { nowFn = typeof fn === 'function' ? fn : () => Date.now(); };
router._internals = { play, town };

module.exports = router;
