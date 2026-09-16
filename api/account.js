/**
 * Account deletion — the one path every surface uses: the phone page's Delete
 * account button, the /delete-account page, and the old /api/auth/delete the
 * native apps call.
 *
 * The caller proves who they are with a Clerk session token, and everything
 * keyed to the account is derived from the VERIFIED `sub`, never from the body.
 * That is possible because a signed-in phone speaks as its Clerk id: plaza and
 * DMs store sha256(id).slice(0,32), rooms and friends the full sha256(id) (see
 * landing/phone/social.js). A client may also hand over install secrets it holds
 * — the random identity from before it signed in — which reach data created
 * under that secret. Possession of the secret is the credential there, exactly
 * as it is for every other call that carries it.
 *
 * Payment records at Stripe / Google / Apple are theirs to keep; what we can do
 * is stop billing, so live Stripe subscriptions are cancelled first. Ledger rows
 * (transactions, top-ups, payouts, pet purchases) are kept for the same reason.
 */
const express = require('express');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const db = require('./db');

const router = express.Router();

const CLERK_JWKS = createRemoteJWKSet(new URL('https://clerk.terseai.org/.well-known/jwks.json'));
const CLERK_ISSUER = 'https://clerk.terseai.org';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const marks = (arr) => arr.map(() => '?').join(',');

/** Clerk session token → user id, or null. Replaced by a stub in the tests. */
router.verifyUser = async (raw) => {
  try {
    const { payload } = await jwtVerify(raw, CLERK_JWKS, { issuer: CLERK_ISSUER });
    return payload.sub || null;
  } catch { return null; }
};

/** Wired by server.js (Clerk + Stripe live there); stubbed by the tests. */
router.hooks = {
  lookupEmail: async () => null,
  cancelBilling: async () => [],
  deleteAuthUser: async () => {},
  onDeleted: () => {},
};

/**
 * Remove everything tied to one account. Idempotent: a retry after a failure
 * further down (Clerk, say) finds nothing left and deletes nothing twice.
 * Returns rows removed per table.
 */
function purge({ clerkUserId, email, secrets = [] }) {
  const raws = [clerkUserId, ...secrets].filter(Boolean).map(String);
  const long = [...new Set(raws.map(sha))];
  const short = long.map((h) => h.slice(0, 32));
  const hashes = [...long, ...short];
  const removed = {};

  // Columns added by ALTER on an older volume, or tables a fresh test DB never
  // grew, must not sink the whole deletion — skip them and carry on.
  const tolerable = (e) => /no such (table|column)/.test(e.message);
  const run = (table, sql, params) => {
    try {
      const n = db.db.prepare(sql).run(...params).changes;
      if (n) removed[table] = (removed[table] || 0) + n;
    } catch (e) { if (!tolerable(e)) throw e; }
  };
  const all = (sql, params) => {
    try { return db.db.prepare(sql).all(...params); }
    catch (e) { if (tolerable(e)) return []; throw e; }
  };

  db.db.transaction(() => {
    // ── Plaza. Their posts take everyone's comments/reactions on them along.
    const posts = all(`SELECT id FROM wall_projects WHERE identity IN (${marks(short)})`, short).map((r) => r.id);
    const comments = all(`SELECT id FROM wall_comments WHERE identity IN (${marks(short)})`, short).map((r) => r.id);
    if (posts.length) {
      const p = marks(posts);
      const mine = all(`SELECT id FROM wall_comments WHERE project_id IN (${p})`, posts).map((r) => r.id);
      comments.push(...mine);
      for (const t of ['wall_comments', 'wall_reactions', 'wall_reports']) {
        run(t, `DELETE FROM ${t} WHERE project_id IN (${p})`, posts);
      }
    }
    if (comments.length) {
      run('wall_comment_likes', `DELETE FROM wall_comment_likes WHERE comment_id IN (${marks(comments)})`, comments);
    }
    run('wall_comments', `DELETE FROM wall_comments WHERE identity IN (${marks(short)})`, short);
    for (const t of ['wall_reactions', 'wall_reports', 'wall_comment_likes']) {
      run(t, `DELETE FROM ${t} WHERE identity IN (${marks(short)})`, short);
    }
    run('wall_projects', `DELETE FROM wall_projects WHERE identity IN (${marks(short)})`, short);

    // ── Direct messages: both halves of every thread they were in.
    run('dm_messages', `DELETE FROM dm_messages WHERE from_id IN (${marks(short)}) OR to_id IN (${marks(short)})`, [...short, ...short]);

    // ── Blocks and reports (safety.js keys everyone by the 32-char hash).
    run('user_blocks', `DELETE FROM user_blocks WHERE blocker IN (${marks(short)}) OR blocked IN (${marks(short)})`, [...short, ...short]);
    run('safety_reports', `DELETE FROM safety_reports WHERE reporter IN (${marks(short)}) OR target_identity IN (${marks(short)})`, [...short, ...short]);

    // ── Friends and knocks (rooms/friends hash long; old rows may still be short).
    run('friend_links', `DELETE FROM friend_links WHERE a_hash IN (${marks(hashes)}) OR b_hash IN (${marks(hashes)})`, [...hashes, ...hashes]);
    run('friend_invites', `DELETE FROM friend_invites WHERE owner_hash IN (${marks(hashes)})`, hashes);
    run('room_knocks', `DELETE FROM room_knocks WHERE identity_hash IN (${marks(hashes)})`, hashes);

    // ── Rooms. A membership is found by identity, or by the signed-in email a
    // Mac joined with; its chat lines, files and key shares go with it, and a
    // room they created is closed for good.
    const members = all(
      `SELECT room_id, member_id, key_hash FROM room_members WHERE identity_hash IN (${marks(hashes)})`
        + (email ? ' OR lower(user_email) = ?' : ''),
      email ? [...hashes, email.toLowerCase()] : hashes,
    );
    for (const m of members) {
      run('room_messages', 'DELETE FROM room_messages WHERE room_id = ? AND member_id = ?', [m.room_id, m.member_id]);
      run('room_files', 'DELETE FROM room_files WHERE room_id = ? AND member_id = ?', [m.room_id, m.member_id]);
      run('room_keyshares', 'DELETE FROM room_keyshares WHERE room_id = ? AND (to_member = ? OR from_member = ?)', [m.room_id, m.member_id, m.member_id]);
      run('room_members', 'DELETE FROM room_members WHERE room_id = ? AND key_hash = ?', [m.room_id, m.key_hash]);
    }
    const keys = [...new Set(members.map((m) => m.key_hash))];
    if (keys.length) run('rooms', `DELETE FROM rooms WHERE owner_key_hash IN (${marks(keys)})`, keys);

    // ── Everything keyed straight to the account.
    for (const t of ['device_links', 'wallpaper_frames', 'wallpaper_links', 'wallpaper_pushcut',
      'wallpaper_liveactivity', 'wallpaper_overlays', 'wallpaper_videos', 'push_subscriptions']) {
      run(t, `DELETE FROM ${t} WHERE clerk_user_id = ?`, [clerkUserId]);
    }
    for (const t of ['notifications', 'seller_keys', 'buyer_keys', 'developer_api_keys', 'vibe_projects']) {
      run(t, `DELETE FROM ${t} WHERE user_id = ?`, [clerkUserId]);
    }
    run('docs', 'DELETE FROM docs WHERE owner_user_id = ?', [clerkUserId]);
    run('doc_collaborators', 'DELETE FROM doc_collaborators WHERE user_id = ?' + (email ? ' OR lower(email) = ?' : ''),
      email ? [clerkUserId, email.toLowerCase()] : [clerkUserId]);
    run('cloud_teams', 'DELETE FROM cloud_teams WHERE owner_user_id = ?', [clerkUserId]);
    run('cloud_team_members', 'DELETE FROM cloud_team_members WHERE user_id = ?' + (email ? ' OR lower(user_email) = ?' : ''),
      email ? [clerkUserId, email.toLowerCase()] : [clerkUserId]);
    if (email) {
      for (const t of ['cowork_sessions', 'cowork_presence']) {
        run(t, `DELETE FROM ${t} WHERE lower(user_email) = ?`, [email.toLowerCase()]);
      }
    }
    run('referrals', 'DELETE FROM referrals WHERE referrer_id = ? OR referee_id = ?', [clerkUserId, clerkUserId]);
    // A spent gift code stays spent — only who spent it is forgotten.
    run('gift_codes', "UPDATE gift_codes SET redeemed_by = 'deleted-account' WHERE redeemed_by = ?", [clerkUserId]);
    run('users', 'DELETE FROM users WHERE id = ?', [clerkUserId]);
  })();

  return removed;
}

async function handleDelete(req, res) {
  const h = req.get('authorization') || '';
  const sub = h.startsWith('Bearer ') ? await router.verifyUser(h.slice(7)) : null;
  if (!sub) {
    return res.status(401).json({ error: 'Sign in again to delete your account.', code: 'auth_required' });
  }
  // Old clients also send clerkUserId in the body. It may only agree with the
  // token — it never chooses whose account goes.
  const claimed = req.body && req.body.clerkUserId;
  if (claimed && claimed !== sub) return res.status(403).json({ error: 'That is not your account.' });

  const secrets = (Array.isArray(req.body && req.body.identities) ? req.body.identities : [])
    .filter((s) => typeof s === 'string' && s.length >= 8 && s.length <= 200)
    .slice(0, 5);

  try {
    const email = await router.hooks.lookupEmail(sub).catch(() => null);
    let userRow = null;
    try { userRow = db.db.prepare('SELECT * FROM users WHERE id = ?').get(sub) || null; } catch {}
    const cancelled = await router.hooks.cancelBilling(sub, email, userRow);
    const removed = purge({ clerkUserId: sub, email, secrets });
    await router.hooks.deleteAuthUser(sub);
    router.hooks.onDeleted(sub);
    console.log(`[account] deleted ${sub}: ${JSON.stringify(removed)}; cancelled ${cancelled.length} subscription(s)`);
    res.json({ ok: true, removed, cancelledSubscriptions: cancelled.length });
  } catch (err) {
    console.error(`[account] deletion failed for ${sub}:`, err);
    res.status(500).json({ error: 'Deletion did not finish. Please try again, or email privacy@terseai.org.' });
  }
}

router.post('/delete', handleDelete);
router.handleDelete = handleDelete;
router.purge = purge;

module.exports = router;
