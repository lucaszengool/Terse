/**
 * play.js —— 小镇里能玩的那一半的账本。
 *
 *   node api/play.test.js
 *
 * 钉住的是:没登录能看不能动;印章只发一次、告示会涨;每天的顶;谜题一次一猜、猜错多一条线索、
 * 最多六次;钓鱼的顶和图鉴;卷轴要是今天的;种树(花钱、不在自己家、槽位、上限)、浇水一天
 * 一次、隔天才长;敲门给房主不给敲门的人;装饰只有房主;七天开宝箱;节日翻倍。
 */
const http = require('http');
const os = require('os');
const fspath = require('path');
const crypto = require('crypto');
process.env.TERSE_DATA_DIR = require('fs').mkdtempSync(fspath.join(os.tmpdir(), 'terse-play-test-'));
const express = require('express');

const db = require('./db');
const play = require('./play');
const app = express();
app.use('/api/cloud/town/play', play);
const server = http.createServer(app);

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const ME = 'me-identity-0123456789abcdef', YOU = 'you-identity-0123456789abcdef';
const THIRD = 'third-identity-0123456789abcdef', FOUR = 'four-identity-0123456789abcdef';
const FEST = 'fest-identity-0123456789abcdef';

/* ── 镇上的房子:20 种语言、8 种风格 ── */
const LANGS = ['Rust', 'Python', 'TypeScript', 'Go', 'JavaScript', 'Java', 'Swift', 'C++', 'Ruby', 'PHP',
  'HTML', 'CSS', 'Shell', 'Kotlin', 'C#', 'Markdown', 'C', 'Jupyter Notebook', 'SQL', 'GDScript'];
const STYLES = ['norse', 'edo', 'giza', 'tang', 'hellas', 'maya', 'persia', 'modern'];
const WORDS = ['Ironclad', 'Quill', 'Lantern', 'Harbor', 'Copper', 'Meadow', 'Falcon', 'Ember', 'Juniper', 'Orchid',
  'Pebble', 'Saffron', 'Thistle', 'Violet', 'Walnut', 'Yarrow', 'Basalt', 'Cobalt', 'Dune', 'Fjord'];
const H = LANGS.map((l, i) => 'wp_house' + String(i).padStart(3, '0'));
const owner = (i) => (i === 0 ? hash(ME) : i === 1 ? hash(YOU) : hash('owner-' + i + '-xxxxxxxx'));
LANGS.forEach((l, i) => {
  const title = WORDS[i] + ' Works';
  db.upsertWallProject.run({ id: H[i], identity: owner(i), title, capsule: JSON.stringify({
    title, subtitle: 'The ' + WORDS[i].toLowerCase() + ' toolkit, no. ' + i,
    langs: [[l, 0.8], ['Shell', 0.2]],
    dirs: [{ name: ['src', 'lib', 'app', 'core'][i % 4], files: 10 + i, bytes: 40000 + i * 1000 }, { name: 'tests', files: 3, bytes: 5000 }],
    hot: i % 5 === 4 ? [] : [{ name: 'main_' + i + '.x', churn: 40 + i, bytes: 900 }, { name: 'util.x', churn: 3, bytes: 100 }],
    commits: Array.from({ length: 371 }, (_, k) => (i % 2 === 0 && k > 360 ? 2 : 0)),
    people: Array.from({ length: 1 + (i % 4) }, (_, k) => ['dev' + k, 10]),
    style: STYLES[i % 8],
  }) });
});

let autoReset = true;   // 测试里连着发几十个请求不算刷;限频单独测
function call(path, { method = 'GET', body, id } = {}) {
  if (autoReset) play.reset();
  const { port } = server.address();
  return new Promise((resolve) => {
    const req = http.request({ port, path: '/api/cloud/town/play' + path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, id ? { 'x-terse-identity': id } : {}) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: data }); });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const post = (path, id, body = {}) => call(path, { method: 'POST', id, body });
const state = (id) => call('/state?lang=en', { id });
const give = (who, glim) => { db.playProfileEnsure.run(hash(who)); db.playProfileAdd.run({ user_id: hash(who), glim, xp: glim, qd: 0, now: 0 }); };
const ledgerSum = (who, reason) => db.playLedgerOf.all({ user_id: hash(who), limit: 10000 })
  .filter((r) => !reason || r.reason === reason).reduce((a, r) => a + r.delta, 0);

(async () => {
  await new Promise((r) => server.listen(0, r));
  const P = await play._internals.play();
  const T = await play._internals.town();
  ok('twenty houses in town', T.houses.length === 20);
  ok('owners are identity hashes', T.byId.get(H[0]).owner === hash(ME));

  // 一个工作日,当天第一件差事是"拜访某种语言的房子"
  let DAY = 20712;
  for (let d = 20712; d < 21200; d++) {
    const wd = new Date(d * 86400000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const qs = P.dailyQuests(d, { houses: T.houses });
    if (qs[0].kind === 'visit_lang' && qs[0].n === 1) { DAY = d; break; }
  }
  let clock = DAY * 86400000 + 12 * 3600e3;
  play._setNow(() => clock);
  const quests = P.dailyQuests(DAY, { houses: T.houses });
  const riddle = P.riddleOf(DAY, T.riddleIn);

  /* ── 没登录 ── */
  const anon = await state();
  ok('anonymous state works', anon.status === 200 && anon.body.ok && anon.body.profile === null && anon.body.day === DAY);
  ok('anonymous: three quests, zero progress', anon.body.quests.length === 3 && anon.body.quests.every((q) => q.progress === 0 && !q.done));
  ok('anonymous: riddle shows one clue and no answer', anon.body.riddle.clues.length === 1 && !('answer' in anon.body.riddle) && !('title' in anon.body.riddle));
  ok('anonymous: no identities leak', !T.houses.some((h) => anon.raw.includes(h.owner)));
  ok('anonymous: weekday has no festival', anon.body.festival === null);
  ok('anonymous: scrolls listed', anon.body.scrolls.length > 0 && anon.body.scrolls.every((s) => s.taken === false));
  for (const p of ['/event', '/riddle', '/cast', '/reel', '/scroll', '/tree', '/tree/1/water', '/decor', '/chest']) {
    const r = await post(p, null, { type: 'visit', villa: H[0] });
    if (r.status !== 401 || r.body.error !== 'Sign in first') { ok('POST ' + p + ' needs sign-in', false); }
  }
  ok('all POSTs need sign-in', true);

  /* ── 拜访、印章、告示 ── */
  const target = T.houses.find((h) => h.lang === quests[0].target);
  const v1 = await post('/event', YOU, { type: 'visit', villa: target.id, name: 'You​ Two' });
  ok('visit awards two stamps', v1.status === 200 && v1.body.stamps.length === 2 && v1.body.stamps.includes('lang:' + target.lang));
  ok('visit progresses the visit_lang quest', v1.body.quests[0].done === true && v1.body.quests[0].progress === 1);
  const stampGlim = 2 * P.REWARD.stampNew;
  ok(`visit pays stamps + quest (${v1.body.gained})`, v1.body.gained === stampGlim + quests[0].reward);
  ok('profile updated', v1.body.profile.glim === v1.body.gained && v1.body.profile.xp === v1.body.gained && v1.body.profile.earnedToday === v1.body.gained);
  ok('name is cleaned', db.playProfileGet.get(hash(YOU)).name === 'You Two');
  const v2 = await post('/event', YOU, { type: 'visit', villa: target.id });
  ok('second visit: no new stamps, nothing gained', v2.body.stamps.length === 0 && v2.body.gained === 0);
  ok('bad event type → 400', (await post('/event', YOU, { type: 'like', villa: H[0] })).status === 400);
  ok('bad villa id → 400', (await post('/event', YOU, { type: 'visit', villa: '../x' })).status === 400);
  ok('unknown villa → 404', (await post('/event', YOU, { type: 'visit', villa: 'wp_nope' })).status === 404);
  ok('visit needs a villa', (await post('/event', YOU, { type: 'visit' })).status === 400);
  ok('lantern needs no villa', (await post('/event', YOU, { type: 'lantern' })).status === 200);

  /* ── 每日上限、护照页 ── */
  let got = 0;
  for (const id of H) got += (await post('/event', THIRD, { type: 'visit', villa: id })).body.gained;
  const s3 = await state(THIRD);
  ok(`daily cap holds (${s3.body.profile.earnedToday})`, s3.body.profile.earnedToday === P.CAPS.perDay);
  ok('28 stamps collected', s3.body.stamps.length === 28);
  ok(`both passport pages paid on top of the cap (${s3.body.profile.glim})`, s3.body.profile.glim === P.CAPS.perDay + 2 * P.REWARD.pageDone);
  ok('ledger matches the balance', ledgerSum(THIRD) === s3.body.profile.glim && got === s3.body.profile.glim);
  ok('pages pay once', ledgerSum(THIRD, 'page') === 2 * P.REWARD.pageDone);
  const again = await post('/event', THIRD, { type: 'lantern' });
  ok('capped: still playable, nothing paid', again.status === 200 && again.body.gained === 0);

  /* ── 敲门:给房主 ── */
  const meBefore = db.playProfileGet.get(hash(ME));
  const k1 = await post('/event', YOU, { type: 'knock', villa: H[0] });
  ok('knock: knocker gets nothing', k1.body.knocked === true && k1.body.gained === 0);
  const meAfter = db.playProfileGet.get(hash(ME));
  ok('knock: owner gets paid', meAfter.glim - (meBefore ? meBefore.glim : 0) === P.REWARD.knockOwner);
  const k2 = await post('/event', YOU, { type: 'knock', villa: H[0] });
  ok('knock dedupes per knocker per villa per day', k2.body.knocked === false && db.playProfileGet.get(hash(ME)).glim === meAfter.glim);
  const k3 = await post('/event', ME, { type: 'knock', villa: H[0] });
  ok('knocking your own door gives nothing', k3.body.knocked === false && db.playProfileGet.get(hash(ME)).glim === meAfter.glim);
  await post('/event', THIRD, { type: 'visit', villa: H[0] });
  await post('/event', ME, { type: 'visit', villa: H[0] });
  const sMe = await state(ME);
  ok('mine lists my villa', JSON.stringify(sMe.body.mine) === JSON.stringify([H[0]]));
  ok('digest counts knocks and visits (not my own)', sMe.body.digest.knocks === 1 && sMe.body.digest.visits === 1);
  // 房主的敲门收入有顶
  for (let i = 0; i < 20; i++) {
    const who = 'knocker-' + i + '-identity-xyz';
    await post('/event', who, { type: 'knock', villa: H[1] });
  }
  ok('owner knock income capped', db.playDayGet.get({ user_id: hash(YOU), day: DAY }).knock_glim === P.CAPS.knockOwner);

  /* ── 谜题 ── */
  const wrong = H.filter((id) => id !== riddle.answer);
  ok('riddle clues never name the answer', !riddle.clues.some((c) => (c.en + c.zh).includes(riddle.answer)));
  const r1 = await post('/riddle', ME, { guess: wrong[0] });
  ok('wrong guess → one more clue', r1.status === 200 && r1.body.correct === false && r1.body.guesses === 1 && r1.body.clues.length === Math.min(2, riddle.clues.length));
  ok('no answer while playing', !('answer' in r1.body) && !('share' in r1.body));
  const r1b = await post('/riddle', ME, { guess: wrong[0] });
  ok('repeat guess costs nothing', r1b.body.repeat === true && r1b.body.guesses === 1);
  ok('unknown villa guess → 404', (await post('/riddle', ME, { guess: 'wp_nope' })).status === 404);
  ok('bad guess → 400', (await post('/riddle', ME, { guess: 42 })).status === 400);
  const r2 = await post('/riddle', ME, { guess: riddle.answer });
  ok('right guess: reward + fast bonus', r2.body.correct && r2.body.solved && r2.body.gained >= P.REWARD.riddle + P.REWARD.riddleFast);
  ok('solved: answer, title, share revealed', r2.body.answer === riddle.answer && r2.body.title === riddle.title
    && /2\/6/.test(r2.body.share) && r2.body.share.includes('🟩') && !r2.body.share.includes(riddle.answer));
  ok('solved: all clues shown', r2.body.clues.length === riddle.clues.length);
  ok('no more guesses after solving', (await post('/riddle', ME, { guess: wrong[1] })).status === 409);
  let last = null;
  for (let i = 0; i < 6; i++) last = await post('/riddle', YOU, { guess: wrong[i + 1] });
  ok('six wrong → failed, answer shown', last.body.failed === true && last.body.answer === riddle.answer && /X\/6/.test(last.body.share));
  ok('failed: nothing paid', last.body.gained === 0);
  ok('seventh guess refused', (await post('/riddle', YOU, { guess: riddle.answer })).status === 409);
  const sYou = await state(YOU);
  ok('state keeps the riddle', sYou.body.riddle.failed && sYou.body.riddle.guesses === 6);

  /* ── 钓 bug ── */
  ok('bad water → 400', (await post('/cast', ME, { where: 'lake', hour: 12 })).status === 400);
  ok('bad hour → 400', (await post('/cast', ME, { where: 'moat', hour: 30 })).status === 400);
  const c0 = await post('/cast', ME, { where: 'moat', hour: 12, weather: 'clear', langs: ['rust'] });
  ok('cast returns a bug', c0.status === 200 && c0.body.cast.n === 0 && c0.body.cast.bug.id && c0.body.castsLeft === P.CAPS.casts - 1);
  const expect = P.castResult(hash(ME) + '|' + DAY + '|0', 'moat', 12, 'clear', ['rust']);
  ok('cast is the shared deterministic result', expect.bug.id === c0.body.cast.bug.id && expect.len === c0.body.cast.len);
  const re0 = await post('/reel', ME, { n: 0, ok: true });
  ok('reel catches it', re0.body.caught === true && re0.body.bug.id === c0.body.cast.bug.id && re0.body.newSpecies === true);
  ok('codex records it', re0.body.codex.bugs[c0.body.cast.bug.id].n === 1 && re0.body.codex.bugs[c0.body.cast.bug.id].best === c0.body.cast.len);
  ok('reel twice → 409', (await post('/reel', ME, { n: 0, ok: true })).status === 409);
  ok('reel unknown → 404', (await post('/reel', ME, { n: 99, ok: true })).status === 404);
  const c1 = await post('/cast', ME, { where: 'stream', hour: 22, weather: 'fog', langs: [] });
  const re1 = await post('/reel', ME, { n: c1.body.cast.n, ok: false });
  ok('missed bite: nothing caught, cast spent', re1.body.caught === false && (await post('/reel', ME, { n: c1.body.cast.n, ok: true })).status === 409);
  let casts = 2, lastCast = null;
  while (casts < P.CAPS.casts) {
    lastCast = await post('/cast', ME, { where: 'moat', hour: 3, weather: 'storm', langs: ['rust', 'go', 'swift'] });
    await post('/reel', ME, { n: lastCast.body.cast.n, ok: true });
    casts++;
  }
  ok('castsLeft counts down to 0', lastCast.body.castsLeft === 0);
  ok('61st cast refused', (await post('/cast', ME, { where: 'moat', hour: 3 })).status === 429);
  ok(`fish glim capped (${ledgerSum(ME, 'fish')})`, ledgerSum(ME, 'fish') <= P.CAPS.fish && db.playDayGet.get({ user_id: hash(ME), day: DAY }).fish_glim === ledgerSum(ME, 'fish'));
  const cx = (await state(ME)).body.codex;
  ok('codex has several species', Object.keys(cx.bugs).length >= 3 && Object.values(cx.bugs).reduce((a, b) => a + b.n, 0) === P.CAPS.casts - 1);

  /* ── 卷轴 ── */
  const sc = anon.body.scrolls[0];
  ok('bad scroll id → 400', (await post('/scroll', ME, { id: '<x>' })).status === 400);
  ok('scroll not today → 404', (await post('/scroll', ME, { id: (DAY - 1) + ':' + sc.villa })).status === 404);
  const g1 = await post('/scroll', ME, { id: sc.id });
  ok('scroll taken', g1.status === 200 && g1.body.scroll.file === sc.file);
  ok('scroll taken twice → 409', (await post('/scroll', ME, { id: sc.id })).status === 409);
  const sMe2 = await state(ME);
  ok('scroll marked taken + in codex', sMe2.body.scrolls.find((s) => s.id === sc.id).taken && sMe2.body.codex.scrolls.some((s) => s.id === sc.id && s.villa === sc.villa));

  /* ── 种树 ── */
  ok('bad villa → 400', (await post('/tree', THIRD, { villa: '' })).status === 400);
  ok('not at your own villa', (await post('/tree', ME, { villa: H[0] })).status === 403);
  const poor = 'poor-identity-0123456789abcdef';
  ok('no glim → 402', (await post('/tree', poor, { villa: H[0] })).status === 402);
  const g3 = db.playProfileGet.get(hash(THIRD)).glim;
  const t1 = await post('/tree', THIRD, { villa: H[0], name: 'Third' });
  ok('planted in slot 0', t1.status === 200 && t1.body.tree.slot === 0 && t1.body.tree.stage === 0 && t1.body.tree.planter === 'Third');
  ok('planting costs glim, xp kept', db.playProfileGet.get(hash(THIRD)).glim === g3 - P.COST.tree && db.playProfileGet.get(hash(THIRD)).xp === g3);
  ok('one tree per planter per villa', (await post('/tree', THIRD, { villa: H[0] })).status === 409);
  const planters = [1, 2, 3, 4, 5].map((i) => 'planter-' + i + '-identity-xyz');
  planters.forEach((p) => give(p, 100));
  const slots = [];
  for (const p of planters.slice(0, 4)) slots.push((await post('/tree', p, { villa: H[0] })).body.tree.slot);
  ok('slots fill in order', JSON.stringify(slots) === '[1,2,3,4]');
  ok('five trees max', (await post('/tree', planters[4], { villa: H[0] })).status === 409);
  ok('refused planter kept their glim', db.playProfileGet.get(hash(planters[4])).glim === 100);
  const treeId = t1.body.tree.id;
  const w1 = await post(`/tree/${treeId}/water`, ME);
  ok('water pays', w1.status === 200 && w1.body.tree.waterDays === 1 && w1.body.tree.wateredToday && w1.body.gained >= P.REWARD.water);
  ok('water twice a day → 409', (await post(`/tree/${treeId}/water`, ME)).status === 409);
  const w2 = await post(`/tree/${treeId}/water`, YOU);
  ok('second waterer same day: tree does not grow twice', w2.status === 200 && w2.body.tree.waterDays === 1);
  ok('bad tree → 400 / 404', (await post('/tree/abc/water', ME)).status === 400 && (await post('/tree/9999/water', ME)).status === 404);
  const sMe3 = await state(ME);
  ok('state lists trees without planter ids', sMe3.body.trees.length === 5 && !sMe3.raw.includes(hash(THIRD)));
  ok('digest counts plants and waters at my villa', sMe3.body.digest.plants === 5 && sMe3.body.digest.waters === 1);
  // 隔天再浇才会长
  clock += 86400e3;
  const w3 = await post(`/tree/${treeId}/water`, ME);
  ok('next day: grows to stage 1', w3.status === 200 && w3.body.tree.waterDays === 2 && w3.body.tree.stage === 1);
  const s4 = await state(ME);
  ok('new day: earnedToday reset, casts back', s4.body.profile.earnedToday === w3.body.gained && s4.body.castsLeft === P.CAPS.casts);
  ok('new day: riddle is fresh', s4.body.riddle.guesses === 0 && !s4.body.riddle.solved);
  ok('new day: my wateredToday is set, digest is new', s4.body.trees.find((t) => t.id === treeId).wateredToday && s4.body.digest.plants === 0);
  clock += 86400e3;
  await post(`/tree/${treeId}/water`, ME);
  clock += 86400e3;
  await post(`/tree/${treeId}/water`, ME);
  const s5 = await state(ME);
  ok('four days of water → stage 2', s5.body.trees.find((t) => t.id === treeId).stage === 2);
  clock = DAY * 86400000 + 12 * 3600e3;

  /* ── 装饰 ── */
  ok('decor: not owner → 403', (await post('/decor', YOU, { villa: H[0], item: 'banner', value: 1 })).status === 403);
  ok('decor: bad item → 400', (await post('/decor', ME, { villa: H[0], item: 'statue', value: 1 })).status === 400);
  ok('decor: bad value → 400', (await post('/decor', ME, { villa: H[0], item: 'banner', value: 9 })).status === 400);
  ok('decor: prototype key refused', (await post('/decor', ME, { villa: H[0], item: 'constructor', value: 1 })).status === 400);
  const meGlim = db.playProfileGet.get(hash(ME)).glim;
  if (meGlim < 120) give(ME, 120 - meGlim);
  const before = db.playProfileGet.get(hash(ME)).glim;
  const d1 = await post('/decor', ME, { villa: H[0], item: 'banner', value: 3 });
  ok('decor: charged once', d1.status === 200 && d1.body.spent === 120 && db.playProfileGet.get(hash(ME)).glim === before - 120);
  const d2 = await post('/decor', ME, { villa: H[0], item: 'banner', value: 5 });
  ok('decor: recolour is free', d2.body.spent === 0 && d2.body.decor.banner === 5);
  ok('decor: poor owner → 402', (await post('/decor', ME, { villa: H[0], item: 'fireflies', value: 0 })).status === 402
    || db.playProfileGet.get(hash(ME)).glim >= 250);
  ok('decor in state', (await state()).body.decor[H[0]].banner === 5);

  /* ── 做完三件差事 → questDays;宝箱 ── */
  give(FOUR, 200);
  async function step(q) {
    switch (q.kind) {
      case 'visit_lang': return post('/event', FOUR, { type: 'visit', villa: T.houses.filter((h) => h.lang === q.target)[0].id });
      case 'visit_style': return post('/event', FOUR, { type: 'visit', villa: T.houses.filter((h) => h.style === q.target)[0].id });
      case 'visit_busy': return post('/event', FOUR, { type: 'visit', villa: T.houses.filter((h) => h.busy)[0].id });
      case 'talk_trade': return post('/event', FOUR, { type: 'talk', villa: T.houses.find((h) => h.trade === q.target).id });
      case 'enter': return post('/event', FOUR, { type: 'enter', villa: H[3] });
      case 'lantern': return post('/event', FOUR, { type: 'lantern' });
      case 'plant': return post('/tree', FOUR, { villa: H[5] });
      case 'riddle': return post('/riddle', FOUR, { guess: riddle.answer });
      case 'scrolls': { let r; for (const s of anon.body.scrolls.slice(0, q.n)) r = await post('/scroll', FOUR, { id: s.id }); return r; }
      case 'fish': { let r; for (let i = 0; i < q.n; i++) { const c = await post('/cast', FOUR, { where: 'moat', hour: 12 }); r = await post('/reel', FOUR, { n: c.body.cast.n, ok: true }); } return r; }
      default: return null;
    }
  }
  for (const q of quests) await step(q);
  const s6 = await state(FOUR);
  ok(`all three quests done (${quests.map((q) => q.kind).join(',')})`, s6.body.quests.every((q) => q.done));
  ok('a quest-day is counted once', s6.body.profile.questDays === 1);
  await post('/event', FOUR, { type: 'lantern' });
  ok('still once', (await state(FOUR)).body.profile.questDays === 1);
  ok('chest not ready → 409', (await post('/chest', FOUR)).status === 409);
  db.playProfileAdd.run({ user_id: hash(FOUR), glim: 0, xp: 0, qd: 6, now: 0 });
  const s7 = await state(FOUR);
  ok('seven quest-days → chest ready', s7.body.profile.chestReady === true);
  const ch = await post('/chest', FOUR);
  ok('chest pays past the cap', ch.status === 200 && ch.body.gained === P.REWARD.chest && ch.body.profile.glim === s7.body.profile.glim + P.REWARD.chest);
  ok('chest spends seven days', ch.body.profile.questDays === 0 && (await post('/chest', FOUR)).status === 409);

  /* ── 节日 ── */
  let sat = DAY;
  for (let d = DAY; d < DAY + 200; d++) {
    const t = d * 86400000 + 12 * 3600e3;
    const f = P.festivalOn(t);
    if (f && f.perk === 'knock' && new Date(t).getUTCDay() === 6) { sat = d; break; }
  }
  clock = sat * 86400000 + 12 * 3600e3;
  const sf = await state(FEST);
  ok('saturday festival is on', sf.body.festival && sf.body.festival.perk === 'knock' && sf.body.day === sat);
  const ownerBefore = db.playProfileGet.get(hash(YOU)).glim;
  await post('/event', FEST, { type: 'knock', villa: H[1] });
  ok('festival doubles the owner knock', db.playProfileGet.get(hash(YOU)).glim - ownerBefore === P.REWARD.knockOwner * P.REWARD.festival);
  const featured = T.houses.find((h) => P.normLang(h.lang) === sf.body.festival.lang);
  const fv = await post('/event', FEST, { type: 'visit', villa: featured.id });
  const fq = P.dailyQuests(sat, { houses: T.houses });
  const questPart = fq.filter((q) => fv.body.quests.find((x) => x.id === q.id).done).reduce((a, q) => a + q.reward, 0);
  ok(`featured language stamp pays double (${fv.body.gained})`, fv.body.gained - questPart === P.REWARD.stampNew * 2 + P.REWARD.stampNew);

  /* ── 限频 ── */
  autoReset = false;
  play.reset();
  const burst = await Promise.all(Array.from({ length: 30 }, () => post('/event', ME, { type: 'lantern' })));
  ok('rate limit → 429', burst.some((r) => r.status === 429));

  server.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
