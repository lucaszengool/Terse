/**
 * One-time setup: creates Stripe products for the Terse API (separate from the macOS app).
 * Run: node scripts/setup-stripe-api.js
 * Then copy the price IDs printed here into .env as STRIPE_API_PRICE_PRO=price_...
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function main() {
  console.log('Creating Terse API Stripe products (live mode)...\n');

  // ── API Pro ────────────────────────────────────────────────────────────
  let apiProProduct;
  const existing = await stripe.products.search({ query: 'name:"Terse API Pro"', limit: 1 });
  if (existing.data.length > 0) {
    apiProProduct = existing.data[0];
    console.log('API Pro product already exists:', apiProProduct.id);
  } else {
    apiProProduct = await stripe.products.create({
      name: 'Terse API Pro',
      description: '50M tokens/month, 600 req/min, batch compression. Billed monthly. No trial.',
      metadata: { type: 'api', tier: 'api_pro' },
    });
    console.log('Created API Pro product:', apiProProduct.id);
  }

  // Check for existing monthly price
  const existingPrices = await stripe.prices.list({ product: apiProProduct.id, active: true, limit: 5 });
  const existingMonthly = existingPrices.data.find(p => p.recurring?.interval === 'month');
  if (existingMonthly) {
    console.log('\n✓ API Pro monthly price already exists:');
    console.log('  STRIPE_API_PRICE_PRO=' + existingMonthly.id);
    console.log('  Amount: $' + (existingMonthly.unit_amount / 100).toFixed(2) + '/mo');
  } else {
    const price = await stripe.prices.create({
      product: apiProProduct.id,
      unit_amount: 2900,   // $29.00 / month
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { type: 'api', tier: 'api_pro' },
    });
    console.log('\n✓ Created API Pro monthly price:');
    console.log('  STRIPE_API_PRICE_PRO=' + price.id);
    console.log('  Amount: $29.00/mo');
  }

  console.log('\nAdd the STRIPE_API_PRICE_PRO= line above to your .env file.');
  console.log('Also create a webhook endpoint in the Stripe Dashboard pointing to:');
  console.log('  https://www.terseai.org/api/stripe/webhook');
  console.log('Events needed: checkout.session.completed, customer.subscription.updated,');
  console.log('  customer.subscription.deleted, invoice.payment_succeeded, invoice.payment_failed');
}

main().catch(console.error);
