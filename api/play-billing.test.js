/**
 * Play subscription verification — against a stubbed Google, with a real RSA
 * service-account key so the signed assertion is exercised for real.
 *
 *   node api/play-billing.test.js
 */
const crypto = require('crypto');
const play = require('./play-billing');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'verifier@terse.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

const future = new Date(Date.now() + 30 * 864e5).toISOString();
function google(sub, { status = 200 } = {}) {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, opts });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }) };
    }
    return { ok: status === 200, status, json: async () => sub };
  };
  return { fetchImpl, seen };
}
const active = (extra = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.1234',
  lineItems: [{ productId: play.PRODUCT, expiryTime: future }],
  ...extra,
});

(async () => {
  try {
    console.log('config');
    const none = await play.verifySubscription({ purchaseToken: 't', clerkUserId: 'u' }, { sa: null });
    ok('no service account → 503, nothing granted', none.ok === false && none.status === 503);

    console.log('verify');
    play._resetToken();
    const g = google(active());
    const r = await play.verifySubscription({ purchaseToken: 'tok/1', clerkUserId: 'user_a' }, { sa, fetchImpl: g.fetchImpl });
    ok('active subscription → live', r.ok && r.live && r.expiresAt === future && r.orderId === 'GPA.1234');
    const tokenCall = g.seen[0];
    ok('signed a JWT-bearer assertion', tokenCall && /grant_type=urn%3Aietf/.test(tokenCall.opts.body)
      && /assertion=[\w-]+\.[\w-]+\.[\w-]+/.test(tokenCall.opts.body));
    ok('asked subscriptionsv2 for this package, token escaped',
      g.seen[1].url.endsWith(`/applications/${play.PACKAGE}/purchases/subscriptionsv2/tokens/tok%2F1`)
      && g.seen[1].opts.headers.Authorization === 'Bearer ya29.test');

    const g2 = google(active());
    await play.verifySubscription({ purchaseToken: 't2', clerkUserId: 'user_a' }, { sa, fetchImpl: g2.fetchImpl });
    ok('access token reused while valid', g2.seen.length === 1);

    const expired = await play.verifySubscription({ purchaseToken: 't', clerkUserId: 'u' },
      { sa, fetchImpl: google(active({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' })).fetchImpl });
    ok('expired → ok but not live', expired.ok && expired.live === false);

    const grace = await play.verifySubscription({ purchaseToken: 't', clerkUserId: 'u' },
      { sa, fetchImpl: google(active({ subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' })).fetchImpl });
    ok('grace period still live', grace.ok && grace.live);

    const wrong = await play.verifySubscription({ purchaseToken: 't', clerkUserId: 'u' },
      { sa, fetchImpl: google(active({ lineItems: [{ productId: 'something.else', expiryTime: future }] })).fetchImpl });
    ok('other product → refused', !wrong.ok && wrong.error === 'wrong_product');

    const bogus = await play.verifySubscription({ purchaseToken: 'made-up', clerkUserId: 'u' },
      { sa, fetchImpl: google({}, { status: 404 }).fetchImpl });
    ok('unknown token → 400', !bogus.ok && bogus.status === 400);

    console.log('account binding');
    const mine = await play.verifySubscription({ purchaseToken: 't', clerkUserId: 'user_a' }, {
      sa, fetchImpl: google(active({ externalAccountIdentifiers: { obfuscatedExternalAccountId: play.accountTag('user_a') } })).fetchImpl,
    });
    ok('tag matches caller → granted', mine.ok && mine.live);
    const theirs = await play.verifySubscription({ purchaseToken: 't', clerkUserId: 'user_b' }, {
      sa, fetchImpl: google(active({ externalAccountIdentifiers: { obfuscatedExternalAccountId: play.accountTag('user_a') } })).fetchImpl,
    });
    ok('someone else\'s purchase → 403', !theirs.ok && theirs.status === 403);
  } catch (e) {
    fail++; console.error(e);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
