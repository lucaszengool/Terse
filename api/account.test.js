/**
 * Account deletion — end to end against a real SQLite-backed Express app.
 *
 *   node api/account.test.js
 *
 * Clerk verification is stubbed: the token IS the user id ('bad' fails). The
 * purge itself is the real code path, because what it misses — and what it
 * takes that belongs to someone else — are the parts that can actually be wrong.
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');
const account = require('./account');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));

account.verifyUser = async (raw) => (raw && raw !== 'bad' ? String(raw) : null);
const calls = { cancel: [], clerk: [], done: [] };
account.hooks = {
  lookupEmail: async () => 'gone@example.com',
  cancelBilling: async (sub) => { calls.cancel.push(sub); return ['sub_1']; },
  deleteAuthUser: async (sub) => { calls.clerk.push(sub); },
  onDeleted: (sub) => { calls.done.push(sub); },
};

const app = express();
app.use(express.json());
app.post('/api/auth/delete', account.handleDelete);
app.use('/api/account', account);
const server = http.createServer(app);

function post(path, { user, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

const tag = crypto.randomBytes(4).toString('hex');
const ME = `user_del_${tag}`;
const OTHER = `user_keep_${tag}`;
const LEGACY = `legacy-secret-${tag}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const L = (s) => sha(s), S = (s) => sha(s).slice(0, 32);
const X = (sql, ...p) => db.db.prepare(sql).run(...p);
const count = (sql, ...p) => db.db.prepare(sql).get(...p).n;

function seed() {
  X('INSERT INTO users (id, email) VALUES (?, ?)', ME, 'gone@example.com');
  X('INSERT INTO users (id, email) VALUES (?, ?)', OTHER, 'keep@example.com');
  // Plaza: my post (with a stranger's comment on it), my comment on theirs.
  X('INSERT INTO wall_projects (id, identity, title, capsule) VALUES (?, ?, ?, ?)', `wp_me_${tag}`, S(ME), 'mine', '{}');
  X('INSERT INTO wall_projects (id, identity, title, capsule) VALUES (?, ?, ?, ?)', `wp_ot_${tag}`, S(OTHER), 'theirs', '{}');
  X('INSERT INTO wall_comments (id, project_id, identity, body) VALUES (?, ?, ?, ?)', `c1_${tag}`, `wp_me_${tag}`, S(OTHER), 'nice');
  X('INSERT INTO wall_comments (id, project_id, identity, body) VALUES (?, ?, ?, ?)', `c2_${tag}`, `wp_ot_${tag}`, S(ME), 'thanks');
  X('INSERT INTO wall_comments (id, project_id, identity, body) VALUES (?, ?, ?, ?)', `c3_${tag}`, `wp_ot_${tag}`, S(OTHER), 'own');
  // Posted before sign-in, under the random install secret.
  X('INSERT INTO wall_projects (id, identity, title, capsule) VALUES (?, ?, ?, ?)', `wp_lg_${tag}`, S(LEGACY), 'old', '{}');
  // DMs both ways, plus one between two strangers.
  X('INSERT INTO dm_messages (id, thread, from_id, to_id, body) VALUES (?, ?, ?, ?, ?)', `d1_${tag}`, 't', S(ME), S(OTHER), 'hi');
  X('INSERT INTO dm_messages (id, thread, from_id, to_id, body) VALUES (?, ?, ?, ?, ?)', `d2_${tag}`, 't', S(OTHER), S(ME), 'yo');
  X('INSERT INTO dm_messages (id, thread, from_id, to_id, body) VALUES (?, ?, ?, ?, ?)', `d3_${tag}`, 't2', S(OTHER), S('x' + tag), 'unrelated');
  X('INSERT INTO friend_links (id, a_hash, b_hash) VALUES (?, ?, ?)', `f1_${tag}`, L(ME), L(OTHER));
  X('INSERT INTO user_blocks (id, blocker, blocked) VALUES (?, ?, ?)', `b1_${tag}`, S(ME), S(OTHER));
  X('INSERT INTO user_blocks (id, blocker, blocked) VALUES (?, ?, ?)', `b2_${tag}`, S(OTHER), S(ME));
  X('INSERT INTO user_blocks (id, blocker, blocked) VALUES (?, ?, ?)', `b3_${tag}`, S(OTHER), S('x' + tag));
  X('INSERT INTO safety_reports (kind, target_id, target_identity, reporter) VALUES (?, ?, ?, ?)', 'dm', `t1_${tag}`, S(OTHER), S(ME));
  X('INSERT INTO push_subscriptions (endpoint, clerk_user_id, p256dh, auth) VALUES (?, ?, ?, ?)', `https://push/${tag}/me`, ME, 'p', 'a');
  X('INSERT INTO push_subscriptions (endpoint, clerk_user_id, p256dh, auth) VALUES (?, ?, ?, ?)', `https://push/${tag}/ot`, OTHER, 'p', 'a');
  X('INSERT INTO device_links (id, secret_hash, clerk_user_id) VALUES (?, ?, ?)', `dl_${tag}`, sha('dl' + tag), ME);
  // A room I own (someone else is in it) and a room they own that I joined.
  X('INSERT INTO rooms (id, code, owner_key_hash) VALUES (?, ?, ?)', `r_me_${tag}`, `RM${tag}`, L('key-me-1' + tag));
  X('INSERT INTO rooms (id, code, owner_key_hash) VALUES (?, ?, ?)', `r_ot_${tag}`, `RO${tag}`, L('key-ot-1' + tag));
  const mem = 'INSERT INTO room_members (room_id, key_hash, member_id, identity_hash) VALUES (?, ?, ?, ?)';
  X(mem, `r_me_${tag}`, L('key-me-1' + tag), `m_me1_${tag}`, L(ME));
  X(mem, `r_me_${tag}`, L('key-ot-2' + tag), `m_ot2_${tag}`, L(OTHER));
  X(mem, `r_ot_${tag}`, L('key-ot-1' + tag), `m_ot1_${tag}`, L(OTHER));
  X(mem, `r_ot_${tag}`, L('key-me-2' + tag), `m_me2_${tag}`, L(ME));
  const msg = 'INSERT INTO room_messages (id, room_id, member_id, body) VALUES (?, ?, ?, ?)';
  X(msg, `rm1_${tag}`, `r_ot_${tag}`, `m_me2_${tag}`, 'mine in their room');
  X(msg, `rm2_${tag}`, `r_ot_${tag}`, `m_ot1_${tag}`, 'theirs');
}

function cleanup() {
  const like = `%${tag}%`;
  for (const [t, c] of [['wall_comments', 'id'], ['wall_projects', 'id'], ['dm_messages', 'id'], ['friend_links', 'id'],
    ['user_blocks', 'id'], ['safety_reports', 'target_id'],
    ['push_subscriptions', 'endpoint'], ['device_links', 'id'], ['room_messages', 'id'], ['room_members', 'member_id'],
    ['rooms', 'id'], ['users', 'id']]) {
    X(`DELETE FROM ${t} WHERE ${c} LIKE ?`, like);
  }
}

server.listen(0, async () => {
  try {
    seed();

    console.log('auth');
    ok('no token → 401', (await post('/api/account/delete')).status === 401);
    ok('bad token → 401', (await post('/api/account/delete', { user: 'bad' })).status === 401);
    // The hole this replaces: naming someone else in the body.
    const forged = await post('/api/auth/delete', { user: ME, body: { clerkUserId: OTHER } });
    ok('body naming another account → 403', forged.status === 403);
    ok('…and nothing was deleted', count('SELECT COUNT(*) n FROM users WHERE id IN (?, ?)', ME, OTHER) === 2);
    ok('unauthenticated legacy call → 401',
      (await post('/api/auth/delete', { body: { clerkUserId: OTHER } })).status === 401);

    console.log('delete');
    const r = await post('/api/auth/delete', { user: ME, body: { clerkUserId: ME, identities: [LEGACY] } });
    ok('own account → 200', r.status === 200 && r.json.ok === true);
    ok('billing cancelled, Clerk deleted, cache dropped',
      calls.cancel[0] === ME && calls.clerk[0] === ME && calls.done[0] === ME);

    ok('my user row gone', count('SELECT COUNT(*) n FROM users WHERE id = ?', ME) === 0);
    ok('their user row kept', count('SELECT COUNT(*) n FROM users WHERE id = ?', OTHER) === 1);
    ok('my post gone', count('SELECT COUNT(*) n FROM wall_projects WHERE id = ?', `wp_me_${tag}`) === 0);
    ok('pre-sign-in post gone (legacy secret)', count('SELECT COUNT(*) n FROM wall_projects WHERE id = ?', `wp_lg_${tag}`) === 0);
    ok('their post kept', count('SELECT COUNT(*) n FROM wall_projects WHERE id = ?', `wp_ot_${tag}`) === 1);
    ok('comments on my post gone', count('SELECT COUNT(*) n FROM wall_comments WHERE id = ?', `c1_${tag}`) === 0);
    ok('my comment on their post gone', count('SELECT COUNT(*) n FROM wall_comments WHERE id = ?', `c2_${tag}`) === 0);
    ok('their own comment kept', count('SELECT COUNT(*) n FROM wall_comments WHERE id = ?', `c3_${tag}`) === 1);
    ok('both halves of my DMs gone', count('SELECT COUNT(*) n FROM dm_messages WHERE id IN (?, ?)', `d1_${tag}`, `d2_${tag}`) === 0);
    ok('strangers\' DM kept', count('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', `d3_${tag}`) === 1);
    ok('friend link gone', count('SELECT COUNT(*) n FROM friend_links WHERE id = ?', `f1_${tag}`) === 0);
    ok('blocks by and of me gone, strangers\' block kept',
      count('SELECT COUNT(*) n FROM user_blocks WHERE id IN (?, ?)', `b1_${tag}`, `b2_${tag}`) === 0
      && count('SELECT COUNT(*) n FROM user_blocks WHERE id = ?', `b3_${tag}`) === 1);
    ok('reports I filed gone', count('SELECT COUNT(*) n FROM safety_reports WHERE target_id = ?', `t1_${tag}`) === 0);
    ok('my push sub gone, theirs kept',
      count('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE ?', `https://push/${tag}/%`) === 1);
    ok('device link gone', count('SELECT COUNT(*) n FROM device_links WHERE id = ?', `dl_${tag}`) === 0);
    ok('room I created closed', count('SELECT COUNT(*) n FROM rooms WHERE id = ?', `r_me_${tag}`) === 0);
    ok('room they created kept', count('SELECT COUNT(*) n FROM rooms WHERE id = ?', `r_ot_${tag}`) === 1);
    ok('my membership + line in their room gone',
      count('SELECT COUNT(*) n FROM room_members WHERE member_id = ?', `m_me2_${tag}`) === 0
      && count('SELECT COUNT(*) n FROM room_messages WHERE id = ?', `rm1_${tag}`) === 0);
    ok('their line in their room kept', count('SELECT COUNT(*) n FROM room_messages WHERE id = ?', `rm2_${tag}`) === 1);

    console.log('idempotent');
    const again = await post('/api/account/delete', { user: ME });
    ok('second call still 200, removes nothing',
      again.status === 200 && Object.keys(again.json.removed).length === 0);
  } catch (e) {
    fail++; console.error(e);
  } finally {
    cleanup();
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
});
