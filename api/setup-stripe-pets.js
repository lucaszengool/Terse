/**
 * One-time Stripe setup for Terse Pals pet unlock ($1 each).
 * Run: STRIPE_SECRET_KEY=sk_live_... node api/setup-stripe-pets.js
 *
 * Creates (idempotent — skips if already exists):
 *   - Product: "Terse Pals – Pet Unlock"
 *   - Price:   $1.00 USD one-time
 *   - Logs the price_id to add as STRIPE_PRICE_PET_UNLOCK in your env
 */

const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !key.startsWith('sk_')) {
  console.error('Usage: STRIPE_SECRET_KEY=sk_live_... node api/setup-stripe-pets.js');
  process.exit(1);
}

const stripe = Stripe(key);

(async () => {
  try {
    // ── 1. Find or create product ──
    console.log('Checking for existing product...');
    const products = await stripe.products.search({ query: 'name:"Terse Pals – Pet Unlock"', limit: 1 });
    let product;
    if (products.data.length > 0) {
      product = products.data[0];
      console.log(`✓ Found existing product: ${product.id} (${product.name})`);
    } else {
      product = await stripe.products.create({
        name: 'Terse Pals – Pet Unlock',
        description: 'Unlock one pet companion in the Terse macOS app',
        metadata: { app: 'terse', type: 'pet_unlock' },
      });
      console.log(`✓ Created product: ${product.id}`);
    }

    // ── 2. Find or create $1 price ──
    console.log('Checking for existing price...');
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
    let price = prices.data.find(p => p.unit_amount === 100 && p.currency === 'usd' && p.type === 'one_time');
    if (price) {
      console.log(`✓ Found existing price: ${price.id} ($${(price.unit_amount / 100).toFixed(2)} ${price.currency.toUpperCase()})`);
    } else {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: 100,
        currency: 'usd',
      });
      console.log(`✓ Created price: ${price.id} ($1.00 USD one-time)`);
    }

    // ── 3. Check webhook endpoints ──
    console.log('\nChecking webhook endpoints...');
    const webhooks = await stripe.webhookEndpoints.list({ limit: 20 });
    const petEvents = ['checkout.session.completed'];
    let webhookOk = false;
    for (const wh of webhooks.data) {
      const hasEvent = wh.enabled_events.includes('checkout.session.completed') || wh.enabled_events.includes('*');
      if (hasEvent) {
        console.log(`✓ Webhook ${wh.id} (${wh.url}) already listens for checkout.session.completed`);
        webhookOk = true;
      }
    }
    if (!webhookOk && webhooks.data.length > 0) {
      console.log(`⚠  No webhook listens for checkout.session.completed — add it in your Stripe dashboard:`);
      console.log(`   https://dashboard.stripe.com/webhooks`);
    }
    if (webhooks.data.length === 0) {
      console.log('⚠  No webhooks configured — create one at https://dashboard.stripe.com/webhooks');
      console.log('   URL: https://www.terseai.org/api/stripe/webhook');
      console.log('   Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_succeeded, invoice.payment_failed');
    }

    // ── 4. Print result ──
    console.log('\n========================================');
    console.log('Add this to your Railway / .env:');
    console.log(`STRIPE_PRICE_PET_UNLOCK=${price.id}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
