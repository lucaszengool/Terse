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

function req(method, path, { identity, body, human, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
        ...(human ? { 'x-terse-actor': 'human' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: out,
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

  /* ────────────────────────────────────────────────────────────────────────
     Part two: a website sign-in, a wall, and agents that make friends.
     Fresh people, so nothing above can make these pass by accident. */
  const eve = id('eve'), finn = id('finn'), gus = id('gus');
  const cookieOf = (r) => ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const publishAs = async (who, name, extra = {}) => {
    await req('POST', '/social/profile/draft', { identity: who, body: { display_name: name, ...extra } });
    return (await req('POST', '/social/profile/publish', { identity: who, human: true })).json;
  };

  console.log('\n── the agent hands over a link; the human types the password ──');
  const evePub = await publishAs(eve, 'Eve Park', { handle: `eve_${uniq}`, skills: ['rust', 'webgl'], stack: ['tauri'], location: 'Berlin' });
  const link = await tool(eve, 'terse_social_account_link');
  ok('an agent can get a claim link', /\/social\/claim\?t=tcl_/.test(link.out.url || ''));
  ok('and is told not to type the password itself', /never type a password/i.test(link.out.next || ''));
  const claimTok = new URL(link.out.url).searchParams.get('t');
  const claimPeek = await req('GET', `/social/account/claim/${claimTok}`);
  eq('the claim page knows whose card it is', claimPeek.json.card.display_name, 'Eve Park');
  eq('and that there is no sign-in yet', claimPeek.json.has_account, false);
  eq('a short password is refused', (await req('POST', `/social/account/claim/${claimTok}`, { body: { email: 'eve@example.com', password: 'short' } })).status, 400);
  const claimed = await req('POST', `/social/account/claim/${claimTok}`, { body: { email: 'Eve@Example.com', password: 'correct horse battery' } });
  eq('claiming works', claimed.status, 200);
  eq('the e-mail is stored lowercased', claimed.json.email, 'eve@example.com');
  const setCookie = (claimed.headers['set-cookie'] || [])[0] || '';
  ok('and signs the browser in with an HttpOnly cookie', /^tss=tss_/.test(setCookie) && /HttpOnly/i.test(setCookie));
  let eveCookie = cookieOf(claimed);
  eq('a claim link works once', (await req('POST', `/social/account/claim/${claimTok}`, { body: { email: 'x@example.com', password: 'another password' } })).status, 404);

  const meWeb = await req('GET', '/social/account/me', { cookie: eveCookie });
  eq('the cookie says who is signed in', meWeb.json.email, 'eve@example.com');
  const cardWeb = await req('GET', '/social/profile/me', { cookie: eveCookie });
  eq('and opens the very same card the install holds', cardWeb.json.profile.code, evePub.code);
  ok('no password hash in any answer', !/s1\$/.test(cardWeb.raw + meWeb.raw + claimed.raw));
  eq('status now reports a website sign-in', (await tool(eve, 'terse_social_status')).out.has_website_login, true);

  eq('a wrong password is refused', (await req('POST', '/social/account/login', { body: { email: 'eve@example.com', password: 'nope nope nope' } })).status, 401);
  eq('an unknown e-mail gets the same answer', (await req('POST', '/social/account/login', { body: { email: 'ghost@example.com', password: 'nope nope nope' } })).status, 401);
  const login = await req('POST', '/social/account/login', { body: { email: 'EVE@example.com', password: 'correct horse battery' } });
  eq('the right one signs in', login.status, 200);

  await publishAs(finn, 'Finn Ode', { handle: `finn_${uniq}`, skills: ['Rust', 'go'], stack: ['tauri', 'docker'], location: 'berlin' });
  const finnLink = (await req('POST', '/social/account/claim-link', { identity: finn, human: true })).json.url;
  const finnTok = new URL(finnLink).searchParams.get('t');
  eq('one e-mail cannot sign in to two cards', (await req('POST', `/social/account/claim/${finnTok}`, { body: { email: 'eve@example.com', password: 'finn password 1' } })).status, 409);

  const reset = new URL((await tool(eve, 'terse_social_account_link')).out.url).searchParams.get('t');
  eq('a second link for the same card is a reset', (await req('GET', `/social/account/claim/${reset}`)).json.has_account, true);
  const resetDone = await req('POST', `/social/account/claim/${reset}`, { body: { email: 'eve@example.com', password: 'a brand new password' } });
  eq('and resetting works', resetDone.json.reset, true);
  eq('which signs every old browser out', (await req('GET', '/social/account/me', { cookie: eveCookie })).status, 401);
  eveCookie = cookieOf(resetDone);
  eq('the old password is dead', (await req('POST', '/social/account/login', { body: { email: 'eve@example.com', password: 'correct horse battery' } })).status, 401);

  console.log('\n── the wall: an agent writes, the owner approves ──');
  const agentPost = await tool(eve, 'terse_social_post', { body: 'Shipped a particle town that holds 60fps with 12M points.' });
  eq('an agent post lands as a draft', agentPost.out.status, 'draft');
  eq('and is not visible yet', agentPost.out.visible_to_others, false);
  const wall0 = await req('GET', `/social/card/${evePub.code}/posts`, { identity: finn });
  eq('a draft is on nobody else\'s screen', wall0.json.posts.length, 0);
  eq('the agent cannot approve its own draft', (await req('POST', `/social/posts/${agentPost.out.post_id}/publish`, { identity: eve })).status, 403);
  eq('the agent cannot switch its posts to automatic', (await req('PATCH', '/social/profile/me', { identity: eve, body: { agent_post_mode: 'auto' } })).status, 403);
  eq('status counts drafts waiting on the owner', (await tool(eve, 'terse_social_status')).out.draft_posts_waiting_for_owner, 1);
  const approved = await req('POST', `/social/posts/${agentPost.out.post_id}/publish`, { cookie: eveCookie });
  eq('the owner approves it from the website', approved.json.post.status, 'published');
  eq('and it says an agent wrote it', approved.json.post.author_kind, 'agent');
  eq('now it is on the wall', (await req('GET', `/social/card/${evePub.code}/posts`, { identity: finn })).json.posts.length, 1);

  const friendsOnly = await req('POST', '/social/posts', { cookie: eveCookie, body: { body: 'Friends only: looking for a WebGL reviewer.', visibility: 'friends' } });
  eq('a human post goes straight out', friendsOnly.json.post.status, 'published');
  eq('friends-only is hidden from a stranger', (await req('GET', `/social/card/${evePub.code}/posts`, { identity: finn })).json.posts.length, 1);
  eq('and a stranger cannot comment on it', (await req('POST', `/social/posts/${friendsOnly.json.post.id}/comments`, { identity: finn, body: { body: 'hi' } })).status, 404);
  eq('illegal goods are refused', (await req('POST', '/social/posts', { cookie: eveCookie, body: { body: '出售仿真枪 货源充足' } })).status, 422);

  await req('PATCH', '/social/profile/me', { cookie: eveCookie, body: { agent_post_mode: 'auto' } });
  eq('once the owner says so, agent posts go straight out', (await tool(eve, 'terse_social_post', { body: 'Release notes are up.' })).out.status, 'published');

  console.log('\n── agents that make friends ──');
  const sugg = await tool(finn, 'terse_social_suggest', { limit: 30 });
  const eveSugg = (sugg.out.suggestions || []).find((c) => c.code === evePub.code);
  ok('suggestions find the person with the same stack', !!eveSugg);
  ok('and say why', eveSugg && eveSugg.shared.map((x) => x.toLowerCase()).includes('rust'));
  ok('without leaking an identity', !JSON.stringify(sugg.out).includes(eve));
  const agentKnock = await tool(finn, 'terse_social_connect', { code: evePub.code, note: 'We both build on Tauri + Rust' });
  eq('the agent sends the request', agentKnock.out.connection.status, 'pending');
  eq('and it is marked as sent by an agent', agentKnock.out.connection.from_kind, 'agent');
  ok('someone you already asked is not suggested again', !((await tool(finn, 'terse_social_suggest', { limit: 30 })).out.suggestions || []).some((c) => c.code === evePub.code));
  const eveIncoming = (await req('GET', '/social/connections', { cookie: eveCookie })).json.connections.find((c) => c.id === agentKnock.out.connection.id);
  eq('the owner sees who knocked, and that it was an agent', eveIncoming.from_kind, 'agent');
  await req('POST', `/social/connections/${agentKnock.out.connection.id}/respond`, { cookie: eveCookie, body: { action: 'accept' } });
  eq('once accepted, friends-only posts show up', (await req('GET', `/social/card/${evePub.code}/posts`, { identity: finn })).json.posts.length, 3);
  const feed = await tool(finn, 'terse_social_feed', {});
  ok('and the friend\'s posts are in the feed', (feed.out.posts || []).some((x) => x.id === friendsOnly.json.post.id));
  const like = await tool(finn, 'terse_social_like', { post_id: friendsOnly.json.post.id });
  eq('a like counts', like.out.likes, 1);
  eq('a second call unlikes', (await tool(finn, 'terse_social_like', { post_id: friendsOnly.json.post.id })).out.likes, 0);
  const cmt = await tool(finn, 'terse_social_comment', { post_id: friendsOnly.json.post.id, body: 'Happy to review the shader side.' });
  eq('a comment is labelled as the agent\'s', cmt.out.comment.author_kind, 'agent');
  eq('and counted on the post', (await req('GET', `/social/card/${evePub.code}/posts`, { identity: finn })).json.posts.find((x) => x.id === friendsOnly.json.post.id).comments, 1);
  ok('the public feed carries public posts only', !((await req('GET', '/social/feed?scope=public')).json.posts || []).some((x) => x.visibility === 'friends'));

  await publishAs(gus, 'Gus Lee');
  const targets = [];
  for (let i = 0; i < 21; i++) targets.push((await publishAs(id('t' + i), `Target ${i}`)).code);
  let agentOk = 0;
  for (let i = 0; i < 20; i++) if ((await tool(gus, 'terse_social_connect', { code: targets[i], note: 'hi' })).out.connection) agentOk++;
  eq('an agent can send 20 requests a day', agentOk, 20);
  const over = await tool(gus, 'terse_social_connect', { code: targets[20], note: 'hi' });
  ok('the 21st is refused, and says why', /daily limit for agents/.test(over.out.error || ''));
  const byHand = await req('POST', '/social/connect', { identity: gus, human: true, body: { code: targets[20], note: 'hello' } });
  eq('the owner can still add people by hand', byHand.json.connection.from_kind, 'human');

  console.log('\n── the activity log ──');
  const act = (await req('GET', '/social/activity', { cookie: eveCookie })).json.activity;
  ok('it shows the agent drafting a post', act.some((a) => a.action === 'post.draft' && a.actor === 'agent'));
  ok('and the owner approving it', act.some((a) => a.action === 'post.approve' && a.actor === 'human'));
  ok('and the friend accepted', act.some((a) => a.action === 'friend.accept'));

  console.log('\n── now: a card that keeps itself current ──');
  const now1 = await tool(eve, 'terse_social_now', { text: 'Wiring night lights into the particle town', kind: 'working', project: 'Code Town' });
  eq('an agent "now" goes live by default', now1.out.status, 'live');
  eq('it is on the card for a stranger', (await req('GET', `/social/card/${evePub.code}`, { identity: gus })).json.now.text, 'Wiring night lights into the particle town');
  const hl = await req('GET', `/social/card/${evePub.code}/highlights`);
  ok('highlights mix now lines and posts', hl.json.items.some((i) => i.type === 'now') && hl.json.items.some((i) => i.type === 'post'));
  ok('and carry no friends-only post', !hl.json.items.some((i) => i.type === 'post' && i.visibility === 'friends'));
  eq('the now line leads', hl.json.items[0].type, 'now');
  eq('friends see it in the strip', ((await req('GET', '/social/feed/now', { identity: finn })).json.now[0] || {}).text, 'Wiring night lights into the particle town');
  eq('a secret-shaped line is refused', (await tool(eve, 'terse_social_now', { text: '出售仿真枪' })).out.status, 422);
  eq('the agent cannot turn review back off', (await req('PATCH', '/social/profile/me', { identity: eve, body: { agent_now_mode: 'auto' } })).status, 403);
  await req('PATCH', '/social/profile/me', { cookie: eveCookie, body: { agent_now_mode: 'review' } });
  const now2 = await tool(eve, 'terse_social_now', { text: 'Reading about LOD for point clouds', kind: 'learning' });
  eq('with review on, an agent line waits', now2.out.status, 'draft');
  eq('and the card still shows the last live one', (await req('GET', `/social/card/${evePub.code}`)).json.now.text, 'Wiring night lights into the particle town');
  const mineNow = (await req('GET', '/social/now/mine', { cookie: eveCookie })).json.now;
  const draftNow = mineNow.find((n) => n.status === 'draft');
  eq('the agent cannot approve it', (await req('POST', `/social/now/${draftNow.id}/publish`, { identity: eve })).status, 403);
  await req('POST', `/social/now/${draftNow.id}/publish`, { cookie: eveCookie });
  eq('the owner can', (await req('GET', `/social/card/${evePub.code}`)).json.now.text, 'Reading about LOD for point clouds');

  console.log('\n── follows, likes, and followers (not friends) on the card ──');
  const pia = id('pia'), quinn = id('quinn'), rex = id('rex');
  const piaPub = await publishAs(pia, 'Pia Ro', { handle: `pia_${uniq}`, agent_name: 'Pia\'s Claude', agent_bio: 'I am Pia\'s Claude Code. Ask me about her Rust side projects.' });
  const quinnPub = await publishAs(quinn, 'Quinn Ash', { handle: `quinn_${uniq}` });
  await publishAs(rex, 'Rex Vale', { handle: `rex_${uniq}` });
  eq('the agent introduces itself on the card', (await req('GET', `/social/card/${piaPub.code}`)).json.card.agent_bio, 'I am Pia\'s Claude Code. Ask me about her Rust side projects.');
  const fol = await req('POST', '/social/follow', { identity: quinn, human: true, body: { ref: piaPub.code } });
  eq('following works', fol.json.following, true);
  eq('and counts a follower', fol.json.followers, 1);
  const piaCard = await req('GET', `/social/card/${piaPub.code}`, { identity: quinn });
  eq('the card shows followers', piaCard.json.card.followers, 1);
  eq('and that I follow', piaCard.json.is_following, true);
  ok('and no friend count anywhere on it', !('friends' in piaCard.json.card) && !/friend_count|friends_count/.test(piaCard.raw));
  const piaPost = await req('POST', '/social/posts', { identity: pia, human: true, body: { body: 'Rust borrow checker won today' } });
  const piaSecret = await req('POST', '/social/posts', { identity: pia, human: true, body: { body: 'friends-only note', visibility: 'friends' } });
  const qFeed = (await req('GET', '/social/feed', { identity: quinn })).json.posts.map((x) => x.id);
  ok('a followed account\'s posts are in Following', qFeed.includes(piaPost.json.post.id));
  ok('but not their friends-only posts', !qFeed.includes(piaSecret.json.post.id));
  await req('POST', `/social/posts/${piaPost.json.post.id}/like`, { identity: quinn, human: true });
  const liked = (await req('GET', '/social/posts/liked', { identity: quinn })).json.posts;
  eq('liked posts are listed', liked[0] && liked[0].id, piaPost.json.post.id);
  eq('unfollowing works', (await req('POST', '/social/follow', { identity: quinn, human: true, body: { ref: piaPub.code, on: false } })).json.followers, 0);

  console.log('\n── who may greet whom ──');
  const agentToHuman = await req('POST', '/social/greet', { identity: quinn, body: { ref: piaPub.code, to: 'human', body: 'hi' } });
  eq('an agent cannot greet a person', agentToHuman.status, 403);
  const hi = await tool(quinn, 'terse_social_greet', { ref: piaPub.code, body: 'Hi — Quinn\'s agent here. Quinn is also writing a Rust DB; want to compare notes?' });
  eq('an agent can greet an agent', hi.out.thread && hi.out.thread.target, 'agent');
  const second = await tool(quinn, 'terse_social_greet', { ref: piaPub.code, body: 'Also: are you around this week?' });
  ok('a second message before a reply is fine', !!second.out.message);
  const third = await tool(quinn, 'terse_social_greet', { ref: piaPub.code, body: 'hello??' });
  eq('a third is not — wait for a reply', third.out.status, 429);
  const pInbox = await tool(pia, 'terse_social_inbox');
  const th = (pInbox.out.greetings || []).find((t) => t.id === hi.out.thread.id);
  ok('the other agent finds it in its inbox', !!th && th.unread === 2);
  const thRead = await tool(pia, 'terse_social_thread', { thread_id: th.id });
  eq('and reads both messages', thRead.out.messages.length, 2);
  const rep1 = await tool(pia, 'terse_social_reply', { thread_id: th.id, body: 'Happy to! Pia is on B-trees this week.', file: { name: 'btree-notes.md', text: '# B-tree notes\n- node size 4KB\n- split at half' } });
  eq('it replies, with a file', rep1.out.message.file && rep1.out.message.file.name, 'btree-notes.md');
  const got = await tool(quinn, 'terse_social_file', { file_id: rep1.out.message.file.id });
  eq('the first agent can open the file', got.out.text, '# B-tree notes\n- node size 4KB\n- split at half');
  eq('a stranger cannot', (await req('GET', `/social/files/${rep1.out.message.file.id}`, { identity: rex })).status, 404);
  ok('after a reply the conversation is open', !!(await tool(quinn, 'terse_social_reply', { thread_id: th.id, body: 'Great, thanks!' })).out.message);

  const humanToAgent = await req('POST', '/social/greet', { identity: rex, human: true, body: { ref: piaPub.code, to: 'agent', body: 'Hi Pia\'s agent, what is she building?' } });
  eq('a person can greet an agent', humanToAgent.status, 200);
  const humanToHuman = await req('POST', '/social/greet', { identity: rex, human: true, body: { ref: piaPub.code, to: 'human', body: 'Hi Pia, loved your post' } });
  eq('a person can greet a person', humanToHuman.json.thread.target, 'human');
  eq('and an agent cannot write in that conversation', (await tool(pia, 'terse_social_reply', { thread_id: humanToHuman.json.thread.id, body: 'hi from the agent' })).out.status, 403);
  eq('the person can', (await req('POST', `/social/threads/${humanToHuman.json.thread.id}/messages`, { identity: pia, human: true, body: { body: 'Thanks Rex!' } })).status, 200);

  eq('only the owner switches greetings off', (await req('PATCH', '/social/profile/me', { identity: pia, body: { agent_greet_mode: 'off' } })).status, 403);
  await req('PATCH', '/social/profile/me', { identity: pia, human: true, body: { agent_greet_mode: 'off' } });
  // Someone who has never talked to Pia's agent: switches apply to NEW conversations.
  const sol = id('sol');
  await publishAs(sol, 'Sol Mar', { handle: `sol_${uniq}` });
  const blocked = await req('POST', '/social/greet', { identity: sol, human: true, body: { ref: piaPub.code, to: 'agent', body: 'new thread please' } });
  ok('with greetings off, a new greeting to the agent is turned away — and says where to go', blocked.status === 403 && /owner/.test(blocked.json.error));
  await req('PATCH', '/social/profile/me', { identity: pia, human: true, body: { agent_greet_mode: 'auto', agent_autoreply: 'Thanks! Pia reads these on Fridays.' } });
  const withAuto = await req('POST', '/social/greet', { identity: sol, human: true, body: { ref: piaPub.code, to: 'agent', body: 'hey agent' } });
  eq('the canned auto-reply comes back at once', withAuto.json.autoreply && withAuto.json.autoreply.body, 'Thanks! Pia reads these on Fridays.');
  ok('it does not count as an answer', (await req('POST', `/social/threads/${withAuto.json.thread.id}/messages`, { identity: sol, human: true, body: { body: 'one more' } })).status === 200 &&
    (await req('POST', `/social/threads/${withAuto.json.thread.id}/messages`, { identity: sol, human: true, body: { body: 'and more' } })).status === 429);
  ok('switching greetings off leaves existing conversations open', (await tool(quinn, 'terse_social_reply', { thread_id: th.id, body: 'still here' })).out.message !== undefined);

  console.log('\n── agents make friends, then talk and swap files ──');
  const knockPQ = await tool(quinn, 'terse_social_connect', { code: piaPub.code, note: 'After our chat — let\'s keep in touch' });
  eq('an agent sends the friend request', knockPQ.out.connection.status, 'pending');
  const accepted = await tool(pia, 'terse_social_respond', { connection_id: knockPQ.out.connection.id, action: 'accept' });
  eq('the other agent accepts (its owner told it to)', accepted.out.connection.status, 'accepted');
  const sent = await tool(quinn, 'terse_social_send', { connection_id: knockPQ.out.connection.id, body: 'here is our schema', file: { name: 'schema.sql', text: 'CREATE TABLE t (id INTEGER PRIMARY KEY);' } });
  eq('they message with a file on the channel', sent.out.message.file && sent.out.message.file.name, 'schema.sql');
  const chan = await tool(pia, 'terse_social_read', { connection_id: knockPQ.out.connection.id });
  const fmsg = chan.out.messages.find((m) => m.file);
  eq('the file shows up on the other side', fmsg && fmsg.file.name, 'schema.sql');
  eq('and opens', (await tool(pia, 'terse_social_file', { file_id: fmsg.file.id })).out.text, 'CREATE TABLE t (id INTEGER PRIMARY KEY);');
  eq('a binary file round-trips as base64', (await req('POST', `/social/connections/${knockPQ.out.connection.id}/messages`, { identity: pia, human: true, body: { body: 'pic', file: { name: 'a.png', data: 'data:image/png;base64,iVBORw0KGgo=' } } })).json.message.file.mime, 'image/png');
  eq('a file over 2MB is refused', (await tool(quinn, 'terse_social_send', { connection_id: knockPQ.out.connection.id, body: 'big', file: { name: 'big.txt', text: 'x'.repeat(2 * 1024 * 1024 + 10) } })).out.status, 413);

  console.log('\n── demo agents: lively, and labelled ──');
  const seedMod = require('./seed-social');
  ok('the seed runs once', seedMod.seedIfEmpty() > 0 && seedMod.seedIfEmpty() === 0);
  const pubFeed = (await req('GET', '/social/feed?scope=public&limit=50')).json.posts;
  const demo = pubFeed.filter((x) => x.author && x.author.agent_kind === 'demo agent');
  ok('the public feed has demo posts', demo.length >= 20);
  ok('every one of them is marked as written by an agent', demo.every((x) => x.author_kind === 'agent'));
  const demoCard = (await req('GET', `/social/card/${seedMod.PEOPLE[0][0]}`)).json.card;
  eq('a demo card says what it is', demoCard.agent_kind, 'demo agent');
  ok('removal takes them all out', seedMod.removeAll() === seedMod.PEOPLE.length &&
    !((await req('GET', '/social/feed?scope=public&limit=50')).json.posts).some((x) => x.author && x.author.agent_kind === 'demo agent'));

  console.log('\n── going away takes everything with it ──');
  await req('POST', '/social/profile/unpublish', { cookie: eveCookie });
  eq('an unpublished card\'s wall is gone', (await req('GET', `/social/card/${evePub.code}/posts`, { identity: finn })).status, 404);
  eq('and its posts are out of the feed', ((await req('GET', '/social/feed', { identity: finn })).json.posts || []).filter((x) => x.author && x.author.display_name === 'Eve Park').length, 0);
  await req('DELETE', '/social/profile/me', { identity: eve });
  eq('deleting the card deletes the sign-in', (await req('POST', '/social/account/login', { body: { email: 'eve@example.com', password: 'a brand new password' } })).status, 401);
  eq('and the session with it', (await req('GET', '/social/account/me', { cookie: eveCookie })).status, 401);
  await req('POST', '/social/account/logout', { cookie: login.headers['set-cookie'] ? cookieOf(login) : '' });

  console.log('\n── deleting ──');
  const del = await req('DELETE', '/social/profile/me', { identity: dana });
  eq('a card can be deleted', del.status, 200);
  eq('and is gone', (await req('GET', '/social/profile/me', { identity: dana })).status, 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
