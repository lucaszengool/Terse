const express = require('express');
const Stripe = require('stripe');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe setup
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Clerk publishable key (for frontend)
const CLERK_PK = process.env.CLERK_PUBLISHABLE_KEY || 'pk_live_Y2xlcmsudGVyc2VhaS5vcmck';
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;

// Price IDs
const PRICES = {
  free: process.env.STRIPE_PRICE_FREE || 'price_1TAMaHGf9QijP49FYUwP3nZq',
  pro: process.env.STRIPE_PRICE_PRO || 'price_1TAMb6Gf9QijP49FKhRQYUSf',
  premium: process.env.STRIPE_PRICE_PREMIUM || 'price_1TAMciGf9QijP49FHTr9DuAB',
};

// Plan limits
const PLAN_LIMITS = {
  free: { optimizations_per_week: 50, max_sessions: 1, max_devices: 1 },
  pro: { optimizations_per_week: -1, max_sessions: 3, max_devices: 2 },
  premium: { optimizations_per_week: -1, max_sessions: -1, max_devices: -1 },
};

// In-memory license cache (production: use Redis/DB)
// Maps clerkUserId -> { tier, stripeCustomerId, subscriptionId, status, expiresAt }
const licenseCache = new Map();

// Stripe webhook needs raw body
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    if (WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[webhook] signature error:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  const { type, data } = event;
  console.log(`[webhook] ${type}`);

  try {
    switch (type) {
      case 'checkout.session.completed': {
        const session = data.object;
        const clerkUserId = session.metadata?.clerk_user_id;
        const tier = session.metadata?.tier;
        if (clerkUserId && tier) {
          licenseCache.set(clerkUserId, {
            tier,
            stripeCustomerId: session.customer,
            subscriptionId: session.subscription,
            status: 'active',
            expiresAt: null,
          });
          console.log(`[license] activated ${tier} for ${clerkUserId}`);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = data.object;
        await syncSubscription(sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = data.object;
        const clerkUserId = sub.metadata?.clerk_user_id;
        if (clerkUserId) {
          licenseCache.set(clerkUserId, {
            tier: 'free',
            stripeCustomerId: sub.customer,
            subscriptionId: null,
            status: 'cancelled',
            expiresAt: null,
          });
          console.log(`[license] cancelled for ${clerkUserId}`);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          await syncSubscription(sub);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = data.object;
        const sub = invoice.subscription
          ? await stripe.subscriptions.retrieve(invoice.subscription)
          : null;
        if (sub) {
          const clerkUserId = sub.metadata?.clerk_user_id;
          if (clerkUserId && licenseCache.has(clerkUserId)) {
            const license = licenseCache.get(clerkUserId);
            license.status = 'past_due';
            licenseCache.set(clerkUserId, license);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('[webhook] processing error:', err);
  }

  res.json({ received: true });
});

async function syncSubscription(sub) {
  const clerkUserId = sub.metadata?.clerk_user_id;
  if (!clerkUserId) return;

  // Determine tier from price
  const priceId = sub.items?.data?.[0]?.price?.id;
  let tier = 'free';
  if (priceId === PRICES.pro) tier = 'pro';
  else if (priceId === PRICES.premium) tier = 'premium';

  licenseCache.set(clerkUserId, {
    tier,
    stripeCustomerId: sub.customer,
    subscriptionId: sub.id,
    status: sub.status,
    expiresAt: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  });
  console.log(`[license] synced ${tier} (${sub.status}) for ${clerkUserId}`);
}

// JSON body for all other routes
app.use(express.json());

// CORS for Tauri app
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Create Checkout Session ──
app.post('/api/checkout', async (req, res) => {
  try {
    const { tier, clerkUserId, clerkUserEmail } = req.body;
    if (!tier || !clerkUserId) {
      return res.status(400).json({ error: 'Missing tier or clerkUserId' });
    }

    const priceId = PRICES[tier];
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid tier' });
    }

    // Find or create Stripe customer
    let customerId;
    const existing = await stripe.customers.list({ email: clerkUserEmail, limit: 1 });
    if (existing.data.length > 0) {
      customerId = existing.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        email: clerkUserEmail,
        metadata: { clerk_user_id: clerkUserId },
      });
      customerId = customer.id;
    }

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${baseUrl}/?checkout=success&tier=${tier}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
      metadata: { clerk_user_id: clerkUserId, tier },
      subscription_data: {
        metadata: { clerk_user_id: clerkUserId, tier },
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[checkout] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Customer Portal (manage subscription) ──
app.post('/api/portal', async (req, res) => {
  try {
    const { clerkUserId } = req.body;
    if (!clerkUserId) return res.status(400).json({ error: 'Missing clerkUserId' });

    const license = licenseCache.get(clerkUserId);
    if (!license?.stripeCustomerId) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: license.stripeCustomerId,
      return_url: baseUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[portal] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── License Verification (called by Tauri app) ──
app.get('/api/license/:clerkUserId', async (req, res) => {
  const { clerkUserId } = req.params;

  // Check cache first
  let license = licenseCache.get(clerkUserId);

  // If not in cache, check Stripe for existing subscriptions
  if (!license) {
    try {
      const customers = await stripe.customers.list({
        limit: 1,
        expand: ['data.subscriptions'],
      });

      // Search by metadata
      const allCustomers = await stripe.customers.search({
        query: `metadata["clerk_user_id"]:"${clerkUserId}"`,
      });

      if (allCustomers.data.length > 0) {
        const customer = allCustomers.data[0];
        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'active',
          limit: 1,
        });

        if (subs.data.length > 0) {
          const sub = subs.data[0];
          await syncSubscription(sub);
          license = licenseCache.get(clerkUserId);
        }
      }
    } catch (err) {
      console.error('[license] stripe lookup error:', err.message);
    }
  }

  if (!license || license.status === 'cancelled') {
    return res.json({
      tier: 'free',
      status: 'active',
      limits: PLAN_LIMITS.free,
    });
  }

  res.json({
    tier: license.tier,
    status: license.status,
    limits: PLAN_LIMITS[license.tier] || PLAN_LIMITS.free,
    expiresAt: license.expiresAt,
  });
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Serve landing page ──
app.use(express.static(path.join(__dirname, '..', 'landing')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[terse-api] running on port ${PORT}`);
});
