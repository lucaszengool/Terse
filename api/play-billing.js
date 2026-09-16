/**
 * Google Play subscription verification for the Android app.
 *
 * The app sends the purchase token it got from Play Billing; this asks Google
 * what that token actually is (Play Developer API, subscriptionsv2) before any
 * entitlement is granted. Trusting the token as sent would let anyone POST a
 * made-up string and get Pro.
 *
 * Needs a Google Cloud service account that has been granted access in Play
 * Console (Users and permissions → "View financial data, orders, and
 * cancellation survey responses"). Its JSON key goes in the env as
 * GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — raw JSON or base64. Unset → every
 * verification answers 503 and nothing is granted.
 */
const crypto = require('crypto');
const { SignJWT, importPKCS8 } = require('jose');

const PACKAGE = 'com.pruneai.terse';
const PRODUCT = 'com.pruneai.terse.pro_monthly';
// ACTIVE covers the free trial too; grace period is Play still retrying a card.
const LIVE = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);

/** sha256(clerkUserId) hex — what the app sets as the obfuscated account id. */
const accountTag = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');

function serviceAccount() {
  const raw = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch { return null; }
}

let cached = null; // { token, exp }

async function accessToken(sa, fetchImpl) {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const key = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/androidpublisher' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const r = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  if (!r.ok) throw new Error(`Google token endpoint returned ${r.status}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

/**
 * → { ok:false, status, error }            nothing to grant
 *   { ok:true, live, state, expiresAt, orderId }
 */
async function verifySubscription({ purchaseToken, clerkUserId }, { fetchImpl = fetch, sa = serviceAccount() } = {}) {
  if (!sa) return { ok: false, status: 503, error: 'play_verification_not_configured' };
  if (!purchaseToken || !clerkUserId) return { ok: false, status: 400, error: 'Missing fields' };

  const bearer = await accessToken(sa, fetchImpl);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`
    + `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (r.status === 400 || r.status === 404 || r.status === 410) {
    return { ok: false, status: 400, error: 'invalid_purchase_token' };
  }
  if (!r.ok) throw new Error(`Play Developer API returned ${r.status}`);
  const sub = await r.json();

  const items = (sub.lineItems || []).filter((li) => li.productId === PRODUCT);
  if (!items.length) return { ok: false, status: 400, error: 'wrong_product' };

  // Set at purchase time from the signed-in account. An older build that set
  // none is accepted; one that names a different account is not.
  const tag = sub.externalAccountIdentifiers && sub.externalAccountIdentifiers.obfuscatedExternalAccountId;
  if (tag && tag !== accountTag(clerkUserId)) {
    return { ok: false, status: 403, error: 'purchase_belongs_to_another_account' };
  }

  const expiresAt = items.map((li) => li.expiryTime).filter(Boolean).sort().pop() || null;
  return {
    ok: true,
    live: LIVE.has(sub.subscriptionState),
    state: sub.subscriptionState,
    expiresAt,
    orderId: sub.latestOrderId || null,
  };
}

module.exports = { verifySubscription, accountTag, PACKAGE, PRODUCT, _resetToken: () => { cached = null; } };
