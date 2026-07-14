/**
 * One-time setup: add Weekly ($1.99) and Quarterly ($12) recurring prices to the
 * existing "Terse Pro" product (same entitlement as monthly, different billing interval).
 *
 * SECURITY: never paste your live secret key into a chat or commit it. Provide it only
 * via the environment when running this script:
 *
 *   STRIPE_SECRET_KEY=sk_live_xxx node scripts/setup-stripe-pricing.js
 *
 * (or put STRIPE_SECRET_KEY=... in .env — which is gitignored — and just run
 *   node scripts/setup-stripe-pricing.js)
 *
 * It prints the two new price IDs. Copy them into your server env:
 *   STRIPE_PRICE_PRO_WEEKLY=price_...
 *   STRIPE_PRICE_PRO_QUARTERLY=price_...
 *
 * Idempotent: re-running reuses prices that already match (won't create duplicates).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('✗ STRIPE_SECRET_KEY is not set. Run with:\n  STRIPE_SECRET_KEY=sk_live_xxx node scripts/setup-stripe-pricing.js');
  process.exit(1);
}
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// The existing monthly Pro price — used to locate the Pro *product* so the new
// interval prices attach to the same product the app already sells.
const MONTHLY_PRO_PRICE = process.env.STRIPE_PRICE_PRO || 'price_1THjoHGf9QijP49FBJr4407W';

// key -> { unit_amount (cents), recurring, lookup_key, label }
const PLANS = {
  weekly: {
    unit_amount: 199,
    recurring: { interval: 'week' },
    lookup_key: 'terse_pro_weekly',
    envVar: 'STRIPE_PRICE_PRO_WEEKLY',
    label: '$1.99 / week',
  },
  quarterly: {
    unit_amount: 1200,
    recurring: { interval: 'month', interval_count: 3 },
    lookup_key: 'terse_pro_quarterly',
    envVar: 'STRIPE_PRICE_PRO_QUARTERLY',
    label: '$12.00 / 3 months (~$4.00/mo)',
  },
};

function matches(price, plan) {
  return price.active &&
    price.unit_amount === plan.unit_amount &&
    price.currency === 'usd' &&
    price.recurring &&
    price.recurring.interval === plan.recurring.interval &&
    (price.recurring.interval_count || 1) === (plan.recurring.interval_count || 1);
}

async function main() {
  console.log('▸ Locating the Terse Pro product from the monthly price…');
  let productId;
  try {
    const monthly = await stripe.prices.retrieve(MONTHLY_PRO_PRICE);
    productId = typeof monthly.product === 'string' ? monthly.product : monthly.product.id;
    console.log('  Pro product:', productId, '\n');
  } catch (e) {
    console.error('✗ Could not read monthly Pro price', MONTHLY_PRO_PRICE, '—', e.message);
    console.error('  Set STRIPE_PRICE_PRO to your current monthly price id and retry.');
    process.exit(1);
  }

  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const out = {};

  for (const [key, plan] of Object.entries(PLANS)) {
    const found = existing.data.find(p => matches(p, plan));
    let price = found;
    if (price) {
      console.log(`✓ ${key}: reusing existing price ${price.id} (${plan.label})`);
    } else {
      price = await stripe.prices.create({
        product: productId,
        unit_amount: plan.unit_amount,
        currency: 'usd',
        recurring: plan.recurring,
        lookup_key: plan.lookup_key,
        transfer_lookup_key: true,
        metadata: { plan: `pro_${key}`, entitlement: 'pro' },
        nickname: `Terse Pro — ${key}`,
      });
      console.log(`✓ ${key}: created price ${price.id} (${plan.label})`);
    }
    out[plan.envVar] = price.id;
  }

  console.log('\n──────────────────────────────────────────────────────');
  console.log('Add these to your server env (Railway / .env):\n');
  for (const [k, v] of Object.entries(out)) console.log(`  ${k}=${v}`);
  console.log('\nThen redeploy the API. The app already reads these via');
  console.log('PRICES.pro_weekly / PRICES.pro_quarterly in api/server.js.');
  console.log('──────────────────────────────────────────────────────');

  await verifySupport();
}

// ── Verify the account actually supports card / WeChat Pay / Alipay ──
async function verifySupport() {
  console.log('\n▸ Checking your Stripe account supports every plan × payment method…\n');
  let acct;
  try { acct = await stripe.accounts.retrieve(); }
  catch (e) { console.log('  (could not read account capabilities:', e.message, ')'); return; }

  const caps = acct.capabilities || {};
  const wechatKey = Object.keys(caps).find(k => /wechat/i.test(k)) || 'wechat_pay_payments';
  const alipayKey = Object.keys(caps).find(k => /alipay/i.test(k)) || 'alipay_payments';
  const st = (k) => caps[k] || 'not requested';
  const mark = (s) => (s === 'active' ? '✓' : s === 'pending' ? '…' : '✗');
  const row = (label, k) => console.log(`  ${mark(st(k))}  ${label.padEnd(12)} ${st(k)}`);

  console.log('  Payment method capabilities:');
  row('Card', 'card_payments');
  row('WeChat Pay', wechatKey);
  row('Alipay', alipayKey);
  console.log('  Account default currency:', (acct.default_currency || 'unknown').toUpperCase());

  const cardOk = st('card_payments') === 'active';
  const wechatOk = st(wechatKey) === 'active';
  const alipayOk = st(alipayKey) === 'active';

  console.log('\n  Plan × method support (all plans use USD prices):');
  const plans = ['Weekly $1.99', 'Monthly $4.99', 'Quarterly $12'];
  for (const p of plans) {
    const parts = [
      `Card ${cardOk ? '✓' : '✗'}`,
      `WeChat ${wechatOk ? '✓' : '✗'}`,
      `Alipay ${alipayOk ? '✓' : '✗'}`,
    ];
    console.log(`    ${p.padEnd(14)} → ${parts.join('   ')}`);
  }

  const missing = [];
  if (!cardOk) missing.push('card_payments');
  if (!wechatOk) missing.push('WeChat Pay');
  if (!alipayOk) missing.push('Alipay');

  console.log('\n──────────────────────────────────────────────────────');
  if (missing.length) {
    console.log('⚠  Not all methods are active:', missing.join(', '));
    console.log('   Enable them in the Stripe Dashboard →');
    console.log('     Settings → Payment methods  (toggle WeChat Pay & Alipay ON)');
    console.log('   WeChat Pay / Alipay also need review/approval on live accounts.');
  } else {
    console.log('✓  Card, WeChat Pay and Alipay are all active for every plan.');
  }
  console.log('\nNotes:');
  console.log('  • WeChat Pay / Alipay cannot auto-charge, so the app bills them as a');
  console.log('    hosted invoice each period (send_invoice). Card auto-renews normally.');
  console.log('  • Weekly + WeChat/Alipay = a new invoice to pay EVERY week — consider');
  console.log('    limiting those methods to monthly/quarterly to avoid churn.');
  console.log('  • USD prices are shown to CN customers in CNY at Stripe\'s FX rate.');
  console.log('──────────────────────────────────────────────────────');
}

main().catch((e) => { console.error('✗ setup failed:', e.message); process.exit(1); });
