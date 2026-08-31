/**
 * WeChat sign-in for the phone web app.
 *
 * ⚠ THIS IS INERT UNTIL CREDENTIALS EXIST, ON PURPOSE. WeChat web login is not a
 * key you generate; it is an account you apply for. A 网站应用 on the 微信开放平台
 * requires an ENTERPRISE account (individuals cannot register one), a ¥300 /
 * $99 review fee, and a callback domain that matches the one submitted for
 * review — for a mainland-facing site, a 已备案 domain. Until WECHAT_APP_ID and
 * WECHAT_APP_SECRET are set, /config reports disabled, the phone app hides the
 * button, and /start answers with a readable error instead of a broken redirect.
 *
 * TWO ENTRY POINTS, BECAUSE WECHAT HAS TWO.
 *   · Outside WeChat (Safari, Chrome) → /connect/qrconnect, scope snsapi_login.
 *     This is the 网站应用 QR flow, and snsapi_login is the ONLY scope it takes.
 *   · Inside WeChat's own browser → /connect/oauth2/authorize, scope
 *     snsapi_userinfo. That is a 公众号 flow with its own, different appid, so it
 *     is configured separately and simply not offered when unset.
 *
 * HOW IT BECOMES A CLERK SESSION. The phone app authenticates to our API with a
 * Clerk JWT, so a WeChat login has to end in a real Clerk session — not a
 * parallel one of our own. So: find or create the Clerk user by external_id
 * (the same find-or-create shape /api/auth/apple already uses), mint a
 * single-use sign-in token with the Backend API, and hand it to the browser,
 * which redeems it with the `ticket` strategy. The ticket is short-lived and
 * one-shot, which is what makes it safe to carry in a redirect URL.
 */
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const APP_ID = process.env.WECHAT_APP_ID || '';
const APP_SECRET = process.env.WECHAT_APP_SECRET || '';
const MP_APP_ID = process.env.WECHAT_MP_APP_ID || '';        // 公众号, for in-WeChat browsers
const MP_APP_SECRET = process.env.WECHAT_MP_APP_SECRET || '';
const CLERK_SECRET = process.env.CLERK_SECRET_KEY || '';
const ORIGIN = process.env.PUBLIC_ORIGIN || 'https://www.terseai.org';

const enabled = () => !!(APP_ID && APP_SECRET && CLERK_SECRET);
const mpEnabled = () => !!(MP_APP_ID && MP_APP_SECRET && CLERK_SECRET);

/** `state` is WeChat's only round-trip channel, and it comes back through a
 *  redirect the user's browser can edit. So it is signed: it carries where to
 *  return to and when it was issued, and a tampered or stale one is refused. */
const stateKey = () => CLERK_SECRET || 'terse-wechat-dev';
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url').slice(0, 24);
  return `${body}.${mac}`;
}
function readState(raw) {
  const [body, mac] = String(raw || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url').slice(0, 24);
  // Length-equal comparison; a mismatched length is already a failure.
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.at || Date.now() - p.at > 10 * 60 * 1000) return null;
    return p;
  } catch { return null; }
}

/** Only same-site paths may be returned to. Without this the state parameter is
 *  an open redirect with our domain's reputation attached to it. */
function safePath(p) {
  const s = String(p || '/m');
  return /^\/[A-Za-z0-9/_\-?=&.]*$/.test(s) && !s.startsWith('//') ? s : '/m';
}

const inWeChat = (ua) => /MicroMessenger/i.test(ua || '');

// GET /api/auth/wechat/config → whether the phone app should show the button.
router.get('/config', (req, res) => {
  res.json({ enabled: enabled() || mpEnabled() });
});

// GET /api/auth/wechat/start?redirect=/m
router.get('/start', (req, res) => {
  const useMp = inWeChat(req.headers['user-agent']) && mpEnabled();
  if (!useMp && !enabled()) {
    return res.status(503).json({
      error: 'WeChat sign-in is not configured on this server',
      missing: [!APP_ID && 'WECHAT_APP_ID', !APP_SECRET && 'WECHAT_APP_SECRET', !CLERK_SECRET && 'CLERK_SECRET_KEY'].filter(Boolean),
    });
  }

  const state = signState({ to: safePath(req.query.redirect), at: Date.now(), mp: useMp });
  const redirectUri = encodeURIComponent(`${ORIGIN}/api/auth/wechat/callback`);
  const url = useMp
    ? `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${MP_APP_ID}&redirect_uri=${redirectUri}`
      + `&response_type=code&scope=snsapi_userinfo&state=${encodeURIComponent(state)}#wechat_redirect`
    : `https://open.weixin.qq.com/connect/qrconnect?appid=${APP_ID}&redirect_uri=${redirectUri}`
      + `&response_type=code&scope=snsapi_login&state=${encodeURIComponent(state)}#wechat_redirect`;
  res.redirect(url);
});

async function wxJson(url) {
  const r = await fetch(url);
  const j = await r.json();
  // WeChat answers 200 with an errcode body rather than an HTTP error, so the
  // status line proves nothing and this check is the real one.
  if (j.errcode) throw new Error(`wechat ${j.errcode}: ${j.errmsg}`);
  return j;
}

// GET /api/auth/wechat/callback?code=&state=
router.get('/callback', async (req, res) => {
  const st = readState(req.query.state);
  if (!st) return res.redirect('/m?wechat=badstate');
  const code = (req.query.code || '').toString();
  if (!code) return res.redirect(`${safePath(st.to)}?wechat=cancelled`);

  const id = st.mp ? MP_APP_ID : APP_ID;
  const secret = st.mp ? MP_APP_SECRET : APP_SECRET;

  try {
    const tok = await wxJson('https://api.weixin.qq.com/sns/oauth2/access_token'
      + `?appid=${id}&secret=${secret}&code=${encodeURIComponent(code)}&grant_type=authorization_code`);

    // unionid is stable across every app under one 开放平台 account; openid is
    // only stable within ONE app. Preferring unionid is what lets the same
    // person keep one Terse account across the site, a 公众号 and a future mini
    // program instead of collecting a new one from each.
    const wxId = tok.unionid || tok.openid;
    if (!wxId) throw new Error('no openid');

    let profile = {};
    try {
      profile = await wxJson('https://api.weixin.qq.com/sns/userinfo'
        + `?access_token=${tok.access_token}&openid=${tok.openid}&lang=zh_CN`);
    } catch { /* a profile is a nicety; the id is the credential */ }

    const clerkUser = await findOrCreateUser(wxId, profile);
    const ticket = await mintSignInToken(clerkUser.id);
    res.redirect(`${safePath(st.to)}?ticket=${encodeURIComponent(ticket)}`);
  } catch (e) {
    console.error('[wechat] callback failed:', e.message);
    res.redirect(`${safePath(st.to)}?wechat=failed`);
  }
});

const clerkHeaders = () => ({ Authorization: `Bearer ${CLERK_SECRET}`, 'Content-Type': 'application/json' });

/** Same find-or-create shape as /api/auth/apple, keyed on external_id. WeChat
 *  gives no email, so external_id is the ONLY way back to an existing account —
 *  there is no email fallback to search on the way there is for Apple. */
async function findOrCreateUser(wxId, profile) {
  const external = `wechat_${wxId}`;
  const found = await fetch(`https://api.clerk.com/v1/users?external_id=${encodeURIComponent(external)}`, {
    headers: clerkHeaders(),
  }).then((r) => r.json()).catch(() => null);
  if (Array.isArray(found) && found.length) return found[0];

  const body = {
    external_id: external,
    skip_password_requirement: true,
    // WeChat nicknames routinely contain emoji, which Clerk rejects in a name
    // field; stripping them keeps the sign-up from failing over a decoration.
    first_name: (profile.nickname || 'WeChat').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 40) || 'WeChat',
  };
  const created = await fetch('https://api.clerk.com/v1/users', {
    method: 'POST', headers: clerkHeaders(), body: JSON.stringify(body),
  }).then((r) => r.json());
  if (created.errors) throw new Error(JSON.stringify(created.errors));
  return created;
}

/** A single-use, short-lived ticket the browser redeems with Clerk's `ticket`
 *  strategy. This is what turns "WeChat says who you are" into a real session. */
async function mintSignInToken(userId) {
  const r = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST', headers: clerkHeaders(),
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 120 }),
  }).then((x) => x.json());
  if (!r.token) throw new Error('no sign-in token: ' + JSON.stringify(r.errors || r));
  return r.token;
}

module.exports = router;
module.exports.enabled = enabled;
