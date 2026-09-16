/**
 * npc.js —— 镇上的房主。
 *
 *   node api/npc.test.js
 *
 * 钉住的是:没登录能打招呼不能聊天;来访次数会涨;限速;没 key 也答得上来(而且说得出
 * 房子的名字);模型的回复只留白名单里的标签;走的时候记得住名字;闲话里没有任何身份。
 * 模型那条路用假的 fetch 测:提示词里有两个缓存断点、有人设、有记忆。
 */
const http = require('http');
const os = require('os');
const fspath = require('path');
process.env.TERSE_DATA_DIR = require('fs').mkdtempSync(fspath.join(os.tmpdir(), 'terse-npc-test-'));
delete process.env.ANTHROPIC_API_KEY;
process.env.NPC_VISIT_GAP_MS = '0';
const express = require('express');

const db = require('./db');
const npc = require('./npc');
const app = express();
app.use('/api/cloud/town/npc', npc);
const server = http.createServer(app);

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const ME = 'test-identity-0123456789abcdef', YOU = 'other-identity-0123456789abcdef', THIRD = 'third-identity-0123456789abcdef';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const P1 = 'wp_forge0000000001', P2 = 'wp_quill0000000002';
db.upsertWallProject.run({ id: P1, identity: 'owner1', title: 'Ironclad CLI', capsule: JSON.stringify({
  title: 'Ironclad CLI', subtitle: 'A tiny forge for command lines',
  desc: 'Builds fast command line tools from a single config file. Works offline.',
  langs: [['Rust', 0.9], ['Shell', 0.1]],
  dirs: [{ name: 'src', files: 42, bytes: 180000 }, { name: 'examples', files: 6, bytes: 12000 }],
  tags: ['cli'],
}) });
db.upsertWallProject.run({ id: P2, identity: 'owner2', title: 'Quill Notes', capsule: JSON.stringify({
  title: 'Quill Notes', langs: [['Python', 1]], dirs: [{ name: 'notes', files: 9, bytes: 30000 }],
}) });

function call(path, { method = 'GET', body, id } = {}) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const req = http.request({ port, path: '/api/cloud/town/npc' + path, method,
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
const say = (pid, text, id, extra = {}) => call(`/${pid}/say`, { method: 'POST', id, body: Object.assign({ text, ctx: { hour: 10, weather: 'rain' } }, extra) });

(async () => {
  await new Promise((r) => server.listen(0, r));
  const realFetch = global.fetch;

  /* ── 打招呼 ── */
  const anon = await call(`/${P1}/hello?lang=en`);
  ok('anonymous hello works', anon.status === 200 && anon.body.ok && typeof anon.body.greeting === 'string' && anon.body.greeting.length > 5);
  ok('anonymous: no memory', anon.body.memory === null);
  ok('persona is public fields only', anon.body.persona && anon.body.persona.name && anon.body.persona.nameZh
    && anon.body.persona.look && !('secret' in anon.body.persona) && !('goal' in anon.body.persona) && !('big5' in anon.body.persona));
  ok('the rust house is kept by a blacksmith', anon.body.persona.trade === 'blacksmith');
  ok('unknown house → 404', (await call('/wp_nope/hello')).status === 404);
  ok('bad id → 404', (await call('/..%2Fetc/hello')).status === 404);

  const h1 = await call(`/${P1}/hello?lang=en`, { id: ME });
  ok('signed-in hello records a visit', h1.body.memory && h1.body.memory.visits === 1);
  const h2 = await call(`/${P1}/hello?lang=en&hour=21&weather=snow`, { id: ME });
  ok('visits count up', h2.body.memory.visits === 2);
  ok('return greeting differs from first', h2.body.greeting !== h1.body.greeting);
  const hz = await call(`/${P1}/hello?lang=zh`, { id: YOU });
  ok('zh greeting is Chinese', /\p{Script=Han}/u.test(hz.body.greeting));

  /* ── 说话:要登录、要校验 ── */
  ok('say requires sign-in', (await say(P1, 'hello')).status === 401);
  ok('empty text → 400', (await say(P1, '   ', ME)).status === 400);
  ok('too long → 400', (await say(P1, 'x'.repeat(301), ME)).status === 400);
  ok('invisible characters do not count as text', (await say(P1, '​​', ME)).status === 400);
  ok('say to an unknown house → 404', (await say('wp_nope', 'hi', ME)).status === 404);

  /* ── 离线 ── */
  const s1 = await say(P1, 'What is this place?', ME);
  ok('offline reply works without a key', s1.status === 200 && s1.body.ok && s1.body.offline === true);
  ok('offline first reply mentions the project title', s1.body.reply.includes('Ironclad CLI'));
  ok('offline reply only uses real numbers', (s1.body.reply.match(/\d+(\.\d+)?/g) || []).every((n) => ['48', '188'].includes(n)));
  const fast = await say(P1, 'again', ME);
  ok('2 s between messages → 429', fast.status === 429);
  await pause(2100);
  const s2 = await say(P1, 'what language is it written in?', ME);
  ok('offline follow-up answers from facts', s2.status === 200 && /Rust/.test(s2.body.reply));
  await pause(2100);
  const s3 = await say(P1, '这个项目有多大?', ME);
  ok('offline reply follows the player\'s language', s3.status === 200 && /\p{Script=Han}/u.test(s3.body.reply) && s3.body.reply.includes('48'));

  /* ── 走了:记住名字(离线启发式) ── */
  await pause(2100);
  await say(P1, '我叫小明，谢谢你', ME);
  const bye = await call(`/${P1}/bye`, { method: 'POST', id: ME, body: {} });
  ok('bye reflects', bye.status === 200 && bye.body.reflected === true);
  ok('bye extracts player name offline (我叫小明 → 小明)', bye.body.memory && bye.body.memory.playerName === '小明');
  ok('polite chat bumps affinity', bye.body.memory.affinity === 1);
  const h3 = await call(`/${P1}/hello?lang=zh`, { id: ME });
  ok('memory persists across calls', h3.body.memory.playerName === '小明' && h3.body.memory.visits === 3 && h3.body.memory.affinity === 1);
  ok('the greeting uses the remembered name', h3.body.greeting.includes('小明'));
  const bye2 = await call(`/${P1}/bye`, { method: 'POST', id: ME, body: {} });
  ok('bye with no new turns does not reflect again', bye2.body.reflected === false);
  ok('anonymous bye is a no-op', (await call(`/${P1}/bye`, { method: 'POST', body: {} })).body.reflected === false);
  ok('a fact about the name was stored', db.npcFactsFor.all({ user_id: require('crypto').createHash('sha256').update(ME).digest('hex').slice(0, 32), npc_id: P1 })
    .some((f) => f.text.includes('小明')));
  const { nameFrom } = npc._internals;
  ok('name heuristics', nameFrom('叫我阿强吧') === '阿强' && nameFrom("Hi, I'm Ada") === 'Ada' && nameFrom("i'm fine") === null
    && nameFrom('my name is Bob') === 'Bob' && nameFrom('我是来看看的') === null);

  /* ── 一次对话最多 8 轮 ── */
  process.env.NPC_GAP_MS = '0';
  let last = null;
  for (let i = 0; i < 9; i++) last = await say(P2, 'tell me more ' + i, THIRD);
  ok('9th turn in a conversation wraps up politely', last.status === 200 && last.body.wrap === true && last.body.reply.length > 5);
  const tenth = await say(P2, 'one more?', THIRD);
  ok('and keeps wrapping up', tenth.body.wrap === true);

  /* ── 每小时上限 ── */
  let hourHit = null;
  for (let i = 0; i < 40 && !hourHit; i++) {
    const r = await say(P2, 'hello ' + i, THIRD);
    if (r.status === 429) hourHit = r;
  }
  ok('≤30 turns an hour per user', hourHit && /hour/.test(hourHit.body.error));

  /* ── 模型那条路(假 fetch) ── */
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  npc.reset();
  const seen = [];
  let nextReply = 'Aye, the forge in "src" is where I work. [EMOTE:wave] [HACK:rm -rf] <b>bold</b>';
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push({ url, headers: opts.headers, body });
    const isReflect = /private memory/.test(body.system[0].text);
    const text = isReflect
      ? 'Sure! {"summary":"They asked about my forge and told me their name.","new_facts":[{"text":"Builds CLI tools","importance":6}],"affinity_delta":2,"player_name":"Ada"}'
      : nextReply;
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} }), text: async () => '' };
  };
  const L1 = await say(P1, 'Hi! I build CLI tools. What is in the src room?', YOU);
  ok('LLM path answers', L1.status === 200 && L1.body.offline === false && /forge/.test(L1.body.reply));
  ok('allowed tag is kept', L1.body.tags.length === 1 && L1.body.tags[0].type === 'emote' && L1.body.tags[0].value === 'wave');
  ok('bad tags and html are stripped', !/HACK|rm -rf|\[|<b>/.test(L1.body.reply));
  const req1 = seen[seen.length - 1];
  ok('calls the messages API with a key and version', /\/v1\/messages$/.test(req1.url) && req1.headers['x-api-key'] === 'sk-test' && req1.headers['anthropic-version']);
  ok('default model is the fast one', req1.body.model === 'claude-haiku-4-5');
  ok('short, warm sampling', req1.body.max_tokens <= 200 && req1.body.temperature === 0.8 && req1.body.stop_sequences.length >= 2);
  ok('system = shared + persona, both with cache_control', Array.isArray(req1.body.system) && req1.body.system.length === 2
    && req1.body.system.every((b) => b.cache_control && b.cache_control.type === 'ephemeral'));
  ok('shared block carries the directory of both houses', req1.body.system[0].text.includes(P1) && req1.body.system[0].text.includes(P2));
  ok('persona block carries persona and facts', /<persona>/.test(req1.body.system[1].text) && /Ironclad CLI/.test(req1.body.system[1].text));
  const lastMsg = req1.body.messages[req1.body.messages.length - 1];
  const lastText = lastMsg.content.map((c) => c.text).join('\n');
  ok('the last user message has the memory preamble and the player text', lastMsg.role === 'user' && /<memory>/.test(lastText)
    && /<context>/.test(lastText) && /<player>Hi! I build CLI tools/.test(lastText));
  ok('messages start with the player and alternate', req1.body.messages[0].role === 'user'
    && req1.body.messages.every((m, i, a) => i === 0 || m.role !== a[i - 1].role));

  // 另一个房主:共享块一字不差
  await pause(2100);
  nextReply = 'Come see my notes. [GUIDE:' + P1 + ']';
  const L2 = await say(P2, 'hello there', YOU);
  const req2 = seen[seen.length - 1];
  ok('shared block is byte-identical across NPCs', req2.body.system[0].text === req1.body.system[0].text && req2.body.system[1].text !== req1.body.system[1].text);
  ok('GUIDE tag to a real house is kept', L2.body.tags.length === 1 && L2.body.tags[0].type === 'guide' && L2.body.tags[0].value === P1);
  await pause(2100);
  nextReply = 'Follow me! [GUIDE:wp_doesnotexist]';
  const L3 = await say(P2, 'take me somewhere', YOU);
  ok('GUIDE tag to an unknown house is dropped', L3.body.tags.length === 0 && !/\[/.test(L3.body.reply));
  const req3 = seen[seen.length - 1];
  ok('history is replayed on the next turn', req3.body.messages.length >= 3
    && JSON.stringify(req3.body.messages).includes('hello there') && JSON.stringify(req3.body.messages).includes('Come see my notes'));

  // 记忆进了提示词
  const byeL = await call(`/${P1}/bye`, { method: 'POST', id: YOU, body: {} });
  ok('bye with a key uses the model and validates JSON', byeL.body.reflected === true && byeL.body.memory.playerName === 'Ada' && byeL.body.memory.affinity === 2);
  await pause(2100);
  nextReply = 'Welcome back, Ada.';
  await say(P1, 'do you remember my CLI tools?', YOU);
  const req4 = seen[seen.length - 1];
  const pre4 = req4.body.messages[req4.body.messages.length - 1].content.map((c) => c.text).join('\n');
  ok('memory preamble has name, affinity, summary and recalled facts', /called: Ada/.test(pre4) && /affinity toward them: 2/.test(pre4)
    && /asked about my forge/.test(pre4) && /Builds CLI tools/.test(pre4));

  // 模型挂了 → 离线,不 500
  await pause(2100);
  global.fetch = async () => { throw new Error('network down'); };
  const F1 = await say(P2, 'still there?', YOU);
  ok('failed call falls back offline, never 500', F1.status === 200 && F1.body.offline === true && F1.body.reply.length > 3);
  global.fetch = async () => ({ ok: false, status: 529, json: async () => ({}), text: async () => 'overloaded' });
  await pause(2100);
  const F2 = await say(P2, 'hello?', YOU);
  ok('API error falls back offline', F2.status === 200 && F2.body.offline === true);

  // 全镇预算闸
  process.env.NPC_DAILY_TURNS = '1';
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) }; };
  await pause(2100);
  const B1 = await say(P1, 'budget?', YOU);
  ok('global daily budget breaker goes offline without calling', B1.body.offline === true && called === 0);
  delete process.env.NPC_DAILY_TURNS;

  /* ── 闲话 ── */
  const g = await call('/gossip?lang=en&limit=5');
  ok('gossip works', g.status === 200 && Array.isArray(g.body.gossip) && g.body.gossip.length >= 1);
  const hashes = [ME, YOU, THIRD].map((x) => require('crypto').createHash('sha256').update(x).digest('hex').slice(0, 32));
  ok('gossip has no identity hashes', !hashes.some((hh) => g.raw.includes(hh) || g.raw.includes(hh.slice(0, 12))) && !/identity|user_id|owner/.test(g.raw));
  ok('gossip mentions a visited keeper', g.body.gossip.some((l) => l.npc === P1 || l.npc === P2));
  const gz = await call('/gossip?lang=zh');
  ok('gossip in zh', gz.body.gossip.length && /\p{Script=Han}/u.test(gz.body.gossip[0].text));

  global.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  server.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
