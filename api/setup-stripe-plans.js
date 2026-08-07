/**
 * One-time Stripe setup for the Terse Pro yearly + lifetime plans.
 * Run: STRIPE_SECRET_KEY=sk_live_... node api/setup-stripe-plans.js
 *
 * Creates (idempotent — reuses anything that already exists):
 *   - Price: $15.99 USD / year   recurring  → STRIPE_PRICE_PRO_ANNUAL
 *   - Price: $25.99 USD          one-time   → STRIPE_PRICE_PRO_LIFETIME
 * Both attach to the SAME "Terse Pro" product the monthly/weekly/quarterly prices
 * use, so every interval shares one product in the Dashboard and one entitlement.
 *
 * Pass --dry to inspect what it would do without writing anything.
 *
 * Safe to re-run: it searches before creating, so a second run just re-prints ids.
 */

const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
const DRY = process.argv.includes('--dry');

if (!key || !key.startsWith('sk_')) {
  console.error('Usage: STRIPE_SECRET_KEY=sk_live_... node api/setup-stripe-plans.js [--dry]');
  process.exit(1);
}
if (key.startsWith('sk_live')) {
  console.log('⚠  LIVE key — this writes to your real Stripe account.');
  if (!DRY) console.log('   (run with --dry first if you want to preview)\n');
}

const stripe = Stripe(key);

// The existing monthly price, used to locate the product the other intervals sit on.
const MONTHLY_PRICE_ID = process.env.STRIPE_PRICE_PRO || 'price_1THjoHGf9QijP49FBJr4407W';

const PLANS = [
  { key: 'STRIPE_PRICE_PRO_ANNUAL',   label: 'Yearly',   amount: 1599, recurring: { interval: 'year' },
    nickname: 'Terse Pro — Yearly ($15.99/yr)' },
  { key: 'STRIPE_PRICE_PRO_LIFETIME', label: 'Lifetime', amount: 2599, recurring: null,
    nickname: 'Terse Pro — Lifetime ($25.99 one-time)' },
];

(async () => {
  try {
    // ── 1. Resolve the Terse Pro product from the existing monthly price ──
    let productId;
    try {
      const monthly = await stripe.prices.retrieve(MONTHLY_PRICE_ID);
      productId = typeof monthly.product === 'string' ? monthly.product : monthly.product.id;
      console.log(`✓ Using product ${productId} (from monthly price ${MONTHLY_PRICE_ID})`);
    } catch (e) {
      console.error(`✗ Could not read monthly price ${MONTHLY_PRICE_ID}: ${e.message}`);
      console.error('  Set STRIPE_PRICE_PRO to your live monthly price id and re-run.');
      process.exit(1);
    }
    const product = await stripe.products.retrieve(productId);
    console.log(`  product name: "${product.name}"\n`);

    // ── 2. Create each price if an identical one isn't already there ──
    const results = [];
    const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });

    for (const plan of PLANS) {
      const match = existing.data.find(p =>
        p.unit_amount === plan.amount &&
        p.currency === 'usd' &&
        (plan.recurring
          ? p.type === 'recurring' && p.recurring?.interval === plan.recurring.interval
          : p.type === 'one_time'));

      if (match) {
        console.log(`✓ ${plan.label}: reusing existing ${match.id}`);
        results.push([plan.key, match.id]);
        continue;
      }
      if (DRY) {
        console.log(`· ${plan.label}: WOULD create $${(plan.amount / 100).toFixed(2)} ` +
                    `${plan.recurring ? plan.recurring.interval + 'ly recurring' : 'one-time'}`);
        results.push([plan.key, '(dry-run)']);
        continue;
      }
      const price = await stripe.prices.create({
        product: productId,
        unit_amount: plan.amount,
        currency: 'usd',
        nickname: plan.nickname,
        ...(plan.recurring ? { recurring: plan.recurring } : {}),
        metadata: { app: 'terse', plan: plan.key },
      });
      console.log(`✓ ${plan.label}: created ${price.id} ` +
                  `($${(plan.amount / 100).toFixed(2)} ${plan.recurring ? plan.recurring.interval + 'ly' : 'one-time'})`);
      results.push([plan.key, price.id]);
    }

    // ── 3. Verify the webhook will actually deliver the lifetime purchase ──
    // Lifetime is recorded from checkout.session.completed; without it the buyer
    // pays and never gets access.
    console.log('\nChecking webhooks for checkout.session.completed...');
    const hooks = await stripe.webhookEndpoints.list({ limit: 30 });
    const ok = hooks.data.filter(h =>
      h.status === 'enabled' &&
      (h.enabled_events.includes('checkout.session.completed') || h.enabled_events.includes('*')));
    if (ok.length) ok.forEach(h => console.log(`✓ ${h.url}`));
    else console.log('✗ No enabled endpoint listens for checkout.session.completed —\n' +
                     '  lifetime buyers would be charged WITHOUT being granted access.');

    // ── 4. What to paste into Railway ──
    console.log('\n─────────── add these to Railway ───────────');
    results.forEach(([k, v]) => console.log(`${k}=${v}`));
    console.log('────────────────────────────────────────────');
    if (DRY) console.log('\n(dry run — nothing was created)');
  } catch (err) {
    console.error('\n✗ Setup failed:', err.message);
    process.exit(1);
  }
})();
