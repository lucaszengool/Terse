/**
 * Agent Social integration tests — the card an agent writes and a human publishes.
 *
 *   node api/social.test.js
 *
 * The happy path is the easy half. What is worth pinning down is the line this
 * feature is built around: AN AGENT MAY WRITE YOUR PROFILE, IT MAY NOT PUBLISH
 * IT. Everything below exists to keep that from eroding — along with the two
 * other places a social platform rots first: what a stranger can put in front of
 * you, and what leaks out of a public card.
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* A private database per run, chosen BEFORE ./db is required — that require is
   what fixes the file, so a later assignment would silently do nothing.
   Without this the suite passes exactly once per machine: the cards a run
   publishes stay behind, and the next run's "a draft is in no directory" finds
   the previous run's Ann Zhou sitting in it. A test that only holds on a virgin
   disk reports the disk, not the code. */
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-social-test-'));
process.env.TERSE_DATA_DIR = TEST_DIR;
process.on('exit', () => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {} });

const socialRouter = require('./social');
const mcpRouter = require('./mcp');

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n)));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/social', socialRouter);
app.use('/mcp', mcpRouter);
const server = http.createServer(app);

function req(method, path, { identity, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        json: (() => { try { return JSON.parse(out); } catch { return null; } })(),
      }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** One MCP tools/call, as an agent would make it. */
async function tool(identity, name, args) {
  const r = await req('POST', '/mcp', {
    identity,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } },
  });
  const text = r.json?.result?.content?.[0]?.text;
  return { status: r.status, rpc: r.json, out: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

const png = (bytes) => 'data:image/png;base64,' + crypto.randomBytes(bytes).toString('base64');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const id = (n) => `identity-${n}-${crypto.randomBytes(8).toString('hex')}`;
  const uniq = crypto.randomBytes(3).toString('hex');
  const ann = id('ann'), bob = id('bob'), carl = id('carl'), dana = id('dana');

  console.log('\n── an agent drafts, and that is all it does ──');
  const draft = await req('POST', '/social/profile/draft', {
    identity: ann,
    body: {
      display_name: 'Ann Zhou',
      handle: `ann_${uniq}`,
      headline: 'Quant infra — Python, Rust, too many Postgres replicas',
      bio: 'Builds trading systems and the boring plumbing under them.',
      skills: ['python', 'rust', 'postgres'],
      stack: ['python', 'docker'],
      links: [{ label: 'GitHub', url: 'https://github.com/ann' }],
      agent_kind: 'claude-code',
    },
  });
  eq('an agent can write the card with no account at all', draft.status, 200);
  eq('and it lands as a draft', draft.json.profile.status, 'draft');
  ok('with NO agent code — a draft is not reachable', draft.json.profile.code === null);
  ok('and the response tells the agent a human still has to look', /review/i.test(draft.json.next));

  const dir0 = await req('GET', '/social/directory?q=Ann%20Zhou');
  eq('a draft is in no directory', dir0.json.cards.filter((c) => c.display_name === 'Ann Zhou').length, 0);
  const byHandle0 = await req('GET', `/social/card/ann_${uniq}`);
  eq('and cannot be read by handle', byHandle0.status, 404);

  console.log('\n── an agent cannot publish on its own say-so ──');
  const sneaky = await tool(ann, 'terse_social_publish', {});
  ok('publishing without the human refuses', /needs the owner/i.test(sneaky.out.error || ''));
  const stillDraft = await req('GET', '/social/profile/me', { identity: ann });
  eq('and nothing was published', stillDraft.json.profile.status, 'draft');
  ok('still no code', stillDraft.json.profile.code === null);

  console.log('\n── the human reviews, edits, publishes ──');
  const edit = await req('PATCH', '/social/profile/me', {
    identity: ann, body: { headline: 'Quant infra. Mostly Rust these days.' },
  });
  eq('an edit of one field succeeds', edit.status, 200);
  eq('it changes that field', edit.json.profile.headline, 'Quant infra. Mostly Rust these days.');
  eq('and does NOT blank the ones the form did not send', edit.json.profile.bio,
    'Builds trading systems and the boring plumbing under them.');
  eq('nor the skills', edit.json.profile.skills.length, 3);
  eq('and the card is now marked as the human\'s text', edit.json.profile.drafted_by, 'human');

  const pub = await req('POST', '/social/profile/publish', { identity: ann });
  eq('publishing works', pub.status, 200);
  ok('a code is minted', /^tac_[a-z2-9]{20}$/.test(pub.json.code));
  const annCode = pub.json.code;
  const annHandle = pub.json.handle;

  const dir1 = await req('GET', '/social/directory?q=quant');
  ok('the card is now findable by what it says', dir1.json.cards.some((c) => c.handle === annHandle));
  ok('and the directory carries no identity', !JSON.stringify(dir1.json).includes(ann));

  console.log('\n── what a public card does not carry ──');
  const card = await req('GET', `/social/card/${annHandle}`);
  eq('a stranger can read a published card', card.status, 200);
  ok('it carries the code', card.json.card.code === annCode);
  ok('it carries no identity hash of any spelling', !JSON.stringify(card.json).includes(ann));
  ok('and no e-mail, tier, or anything else off the row', !('identity' in card.json.card));

  const agentJson = await req('GET', `/social/card/${annCode}/agent.json`);
  eq('there is an A2A-shaped card for other toolchains', agentJson.status, 200);
  eq('naming the same code', agentJson.json.terse.code, annCode);
  ok('with skills as skill objects', agentJson.json.skills.some((s) => s.name === 'rust'));

  console.log('\n── handles ──');
  const taken = await req('POST', '/social/profile/draft', {
    identity: bob, body: { display_name: 'Bob', handle: annHandle },
  });
  eq('a taken handle is refused', taken.status, 409);
  const reserved = await req('POST', '/social/profile/draft', {
    identity: bob, body: { display_name: 'Bob', handle: 'terse' },
  });
  eq('a reserved handle is refused', reserved.status, 400);
  const shouty = await req('POST', '/social/profile/draft', {
    identity: bob, body: { display_name: 'Bob', handle: 'Bob The Builder!' },
  });
  eq('a handle with spaces is refused', shouty.status, 400);

  console.log('\n── what a card is not allowed to contain ──');
  const nasty = await req('POST', '/social/profile/draft', {
    identity: bob,
    body: {
      display_name: 'Bob',
      handle: `bob_${uniq}`,
      links: [
        { label: 'Click', url: 'javascript:alert(1)' },
        { label: 'Real', url: 'https://example.com/bob' },
      ],
      avatar: png(200 * 1024),
      photos: [png(8), png(8), png(8), png(8), png(8), png(8), png(8), png(8)],
      skills: Array.from({ length: 40 }, (_, i) => 's' + i),
    },
  });
  eq('the card saves', nasty.status, 200);
  eq('a javascript: link is dropped', nasty.json.profile.links.length, 1);
  eq('the https one survives', nasty.json.profile.links[0].url, 'https://example.com/bob');
  ok('an oversized avatar is not stored', nasty.json.profile.avatar === null);
  eq('photos are capped at six', nasty.json.profile.photos.length, 6);
  eq('skills are capped at twelve', nasty.json.profile.skills.length, 12);

  console.log('\n── opening a channel with an agent code ──');
  const noCard = await req('POST', '/social/connect', { identity: carl, body: { code: annCode } });
  eq('someone with no published card of their own cannot ask', noCard.status, 403);

  await req('POST', '/social/profile/publish', { identity: bob });
  const self = await req('POST', '/social/connect', {
    identity: ann, body: { code: annCode },
  });
  eq('you cannot open a channel to yourself', self.status, 400);

  const nope = await req('POST', '/social/connect', { identity: bob, body: { code: 'tac_nosuchcodeatall' } });
  eq('an unknown code resolves to nothing', nope.status, 404);

  const knock = await req('POST', '/social/connect', {
    identity: bob, body: { code: annCode, note: 'Saw your Rust infra card — building something similar.' },
  });
  eq('presenting a real code works', knock.status, 200);
  eq('but it only makes a request', knock.json.connection.status, 'pending');
  eq('and says so plainly to the calling agent', knock.json.opened, false);
  const connId = knock.json.connection.id;

  const again = await req('POST', '/social/connect', { identity: bob, body: { code: annCode } });
  eq('asking twice is the same edge, not a second one', again.json.already, true);
  eq('and does not reset it', again.json.connection.id, connId);

  console.log('\n── a pending channel carries nothing but the note ──');
  const early = await req('POST', `/social/connections/${connId}/messages`, {
    identity: bob, body: { body: 'hello?' },
  });
  eq('you cannot message before it is open', early.status, 403);

  const wrongSide = await req('POST', `/social/connections/${connId}/respond`, {
    identity: bob, body: { action: 'accept' },
  });
  eq('the asker cannot accept on the other side\'s behalf', wrongSide.status, 404);

  const inbox = await req('GET', '/social/connections', { identity: ann });
  const incoming = inbox.json.connections.find((c) => c.id === connId);
  eq('it shows up as incoming for the person asked', incoming.direction, 'incoming');
  eq('carrying the one line', incoming.note, 'Saw your Rust infra card — building something similar.');
  ok('and the asker\'s card, so the decision can be made', incoming.peer.display_name === 'Bob');

  const accept = await req('POST', `/social/connections/${connId}/respond`, {
    identity: ann, body: { action: 'accept' },
  });
  eq('the person asked can accept', accept.status, 200);
  eq('and the channel is open', accept.json.connection.status, 'accepted');

  const say = await req('POST', `/social/connections/${connId}/messages`, {
    identity: bob, body: { body: 'Which executor are you using?' },
  });
  eq('now a message goes through', say.status, 200);
  const read = await req('GET', `/social/connections/${connId}/messages`, { identity: ann });
  eq('and the other side reads it', read.json.messages[0].body, 'Which executor are you using?');
  eq('attributed to an agent, not a human', read.json.messages[0].from_kind, 'agent');
  ok('with no identity attached', !JSON.stringify(read.json).includes(bob));

  const eavesdrop = await req('GET', `/social/connections/${connId}/messages`, { identity: carl });
  eq('a third party cannot read the channel', eavesdrop.status, 404);

  console.log('\n── auto-accept is a switch, never a default ──');
  await req('POST', '/social/profile/draft', {
    identity: dana, body: { display_name: 'Dana', handle: `dana_${uniq}` },
  });
  await req('POST', '/social/profile/publish', { identity: dana });
  const danaCard = (await req('GET', '/social/profile/me', { identity: dana })).json.profile;
  eq('a fresh card does not auto-accept', danaCard.auto_accept, false);

  await req('PATCH', '/social/profile/me', { identity: dana, body: { auto_accept: true } });
  const open = await req('POST', '/social/connect', { identity: bob, body: { code: danaCard.code } });
  eq('with it on, another agent opens the channel immediately', open.json.connection.status, 'accepted');
  eq('and is told that it opened', open.json.opened, true);

  console.log('\n── a card can be reachable by code but out of the directory ──');
  await req('PATCH', '/social/profile/me', { identity: dana, body: { discoverable: false } });
  const hidden = await req('GET', '/social/directory?q=Dana');
  eq('it leaves the directory', hidden.json.cards.filter((c) => c.display_name === 'Dana').length, 0);
  const byHandleHidden = await req('GET', `/social/card/dana_${uniq}`);
  eq('and cannot be guessed by handle', byHandleHidden.status, 404);
  const byCodeHidden = await req('GET', `/social/card/${danaCard.code}`);
  eq('but the code still opens it — that is what a code is for', byCodeHidden.status, 200);

  console.log('\n── rotating a code ──');
  const rot = await req('POST', '/social/profile/rotate-code', { identity: dana });
  ok('a new code is issued', rot.json.code && rot.json.code !== danaCard.code);
  eq('the old one now resolves to nothing', (await req('GET', `/social/card/${danaCard.code}`)).status, 404);
  const survived = await req('GET', '/social/connections', { identity: dana });
  ok('channels already accepted survive it', survived.json.connections.some((c) => c.status === 'accepted'));

  console.log('\n── photos from a phone ──');
  const sess = await req('POST', '/social/photos/session', { identity: ann });
  eq('a session is minted', sess.status, 200);
  ok('with a link a phone can open', /\/agent-photo\?t=tap_/.test(sess.json.url));

  const phone = await req('POST', `/social/photos/session/${sess.json.token}`, {
    body: { photos: [png(1200), png(1200)] },
  });
  eq('the phone uploads with NO identity header — the token is the credential', phone.status, 200);
  eq('both arrive', phone.json.count, 2);

  const peek = await req('GET', `/social/photos/session/${sess.json.token}`, { identity: bob });
  eq('somebody else cannot read that session', peek.status, 404);

  const claim = await req('POST', `/social/photos/session/${sess.json.token}/claim`, { identity: ann });
  eq('the owner claims them', claim.status, 200);
  eq('and they land on the card', claim.json.profile.photos.length, 2);

  const reuse = await req('POST', `/social/photos/session/${sess.json.token}`, { body: { photos: [png(100)] } });
  eq('the token is burnt afterwards', reuse.status, 409);

  const badToken = await req('POST', '/social/photos/session/tap_madeitup', { body: { photos: [png(100)] } });
  eq('a made-up token goes nowhere', badToken.status, 404);

  console.log('\n── the same rules through MCP, because it is the same router ──');
  const listed = await req('POST', '/mcp', {
    identity: carl, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  const names = listed.json.result.tools.map((t) => t.name);
  ok('an identity alone lights up the social tools', names.includes('terse_social_draft_card'));
  ok('and not the team tools it cannot use', !names.includes('terse_list_teammates'));

  const anon = await req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  eq('no credential at all is still refused', anon.status, 401);

  const st0 = await tool(carl, 'terse_social_status', {});
  eq('status before there is a card', st0.out.has_card, false);
  const drafted = await tool(carl, 'terse_social_draft_card', {
    display_name: 'Carl', handle: `carl_${uniq}`, skills: ['go'],
  });
  eq('an agent drafts through MCP too', drafted.out.saved_as, 'draft');
  eq('and is told it is not visible', drafted.out.visible_to_others, false);
  ok('the avatar is not echoed back into the agent\'s context', drafted.out.profile.avatar === null);

  const published = await tool(carl, 'terse_social_publish', { confirmed_by_human: true });
  ok('with the human\'s go-ahead it publishes', /^tac_/.test(published.out.agent_code || ''));

  const viewed = await tool(carl, 'terse_social_view_card', { ref: annHandle });
  eq('and can read another card', viewed.out.card.handle, annHandle);
  const connected = await tool(carl, 'terse_social_connect', { code: annCode, note: 'hi' });
  eq('and knock on it', connected.out.connection.status, 'pending');

  console.log('\n── deleting ──');
  const del = await req('DELETE', '/social/profile/me', { identity: dana });
  eq('a card can be deleted', del.status, 200);
  eq('and is gone', (await req('GET', '/social/profile/me', { identity: dana })).status, 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
