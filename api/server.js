const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Railway runs behind a reverse proxy
const PORT = process.env.PORT || 3000;

// Marketplace modules
const { router: marketplaceRouter } = require('./marketplace');
const proxyRouter = require('./proxy');
const db = require('./db');

// Stripe setup
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Clerk publishable key (for frontend)
const CLERK_PK = process.env.CLERK_PUBLISHABLE_KEY || 'pk_live_Y2xlcmsudGVyc2VhaS5vcmck';
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;

// Price IDs (no free plan — all plans have 30-day free trial)
const PRICES = {
  pro: process.env.STRIPE_PRICE_PRO || 'price_1THjoHGf9QijP49FBJr4407W',
  premium: process.env.STRIPE_PRICE_PREMIUM || 'price_1TAMciGf9QijP49FHTr9DuAB',
};

// 30-day free trial on all plans
const TRIAL_DAYS = 30;

// Plan limits (per platform)
const PLAN_LIMITS = {
  pro: { optimizations_per_week: -1, max_sessions: 3, max_devices: 2 },
  premium: { optimizations_per_week: -1, max_sessions: -1, max_devices: -1 },
};

const PLAN_LIMITS_IOS = {
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
        // Handle marketplace top-up
        if (session.metadata?.type === 'marketplace_topup') {
          const userId = session.metadata.clerk_user_id;
          const amount = parseInt(session.metadata.amount_cents);
          if (userId && amount > 0) {
            db.ensureUser(userId);
            db.creditBuyerBalance.run(amount, userId);
            const topupId = require('crypto').randomUUID();
            db.addTopup.run({ id: topupId, user_id: userId, amount_cents: amount, stripe_payment_id: session.payment_intent });
            // Send notification
            const { notifyTopup } = require('./notify');
            notifyTopup(userId, amount);
            console.log(`[marketplace] top-up $${(amount / 100).toFixed(2)} for ${userId}`);
          }
          break;
        }
        // Handle subscription checkout
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
            tier: 'expired',
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
      case 'invoice.finalized': {
        // For send_invoice subscriptions (WeChat/Alipay), email the hosted invoice URL
        const invoice = data.object;
        if (invoice.collection_method === 'send_invoice' && invoice.hosted_invoice_url) {
          console.log(`[invoice] finalized send_invoice: ${invoice.id}, hosted URL: ${invoice.hosted_invoice_url}`);
          // Stripe automatically emails the invoice to the customer
          // The hosted invoice page will show WeChat Pay / Alipay as payment options
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

  // Immediate cancellation: if user cancelled (cancel_at_period_end), revoke access now
  if (sub.cancel_at_period_end || sub.status === 'canceled' || sub.status === 'cancelled') {
    licenseCache.set(clerkUserId, {
      tier: 'expired',
      stripeCustomerId: sub.customer,
      subscriptionId: null,
      status: 'cancelled',
      expiresAt: null,
      trialEnd: null,
    });
    console.log(`[license] immediately cancelled for ${clerkUserId}`);
    return;
  }

  // Determine tier from price (also recognize legacy price IDs for existing subscribers)
  const priceId = sub.items?.data?.[0]?.price?.id;
  const LEGACY_PRO_PRICE = 'price_1TAMb6Gf9QijP49FKhRQYUSf';
  let tier = 'expired';
  if (priceId === PRICES.pro || priceId === LEGACY_PRO_PRICE) tier = 'pro';
  else if (priceId === PRICES.premium) tier = 'premium';

  // Compute trial end date if in trial
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

  // For send_invoice subscriptions, Stripe marks as 'active' before payment.
  // Check if the latest invoice is actually paid before granting access.
  let effectiveStatus = sub.status;
  if (sub.collection_method === 'send_invoice' && sub.status === 'active' && !sub.trial_end) {
    try {
      const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 1 });
      const latest = invoices.data[0];
      if (latest && latest.status !== 'paid') {
        effectiveStatus = 'past_due'; // Don't grant access until paid
        console.log(`[license] send_invoice sub ${sub.id} invoice ${latest.id} not paid (${latest.status}), blocking access`);
      }
    } catch (e) { console.error('[license] invoice check failed:', e.message); }
  }

  licenseCache.set(clerkUserId, {
    tier,
    stripeCustomerId: sub.customer,
    subscriptionId: sub.id,
    status: effectiveStatus,
    expiresAt: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    trialEnd,
  });
  console.log(`[license] synced ${tier} (${effectiveStatus}) for ${clerkUserId}${trialEnd ? ' trial until ' + trialEnd : ''}`);
}

// JSON body for all other routes
app.use(express.json());

// CORS for Tauri app + marketplace
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

    // WeChat Pay / Alipay: one-time CNY payment (no free trial).
    // Stripe doesn't support recurring for these methods, so each month
    // a new invoice is sent via send_invoice subscription.
    const paymentMethod = req.body.paymentMethod; // 'wechat_pay', 'alipay', or undefined
    const isChinaPay = paymentMethod === 'wechat_pay' || paymentMethod === 'alipay';

    if (isChinaPay) {
      // Create send_invoice subscription with NO trial — first invoice due immediately
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        collection_method: 'send_invoice',
        days_until_due: 3,
        metadata: { clerk_user_id: clerkUserId, tier },
        payment_settings: {
          payment_method_types: [paymentMethod],
        },
      });

      // Don't activate yet — wait for invoice.paid webhook to confirm payment
      // Set as 'past_due' so app knows payment is pending
      licenseCache.set(clerkUserId, {
        tier,
        stripeCustomerId: customerId,
        subscriptionId: sub.id,
        status: 'past_due',
        expiresAt: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      });
      console.log(`[license] china-pay subscription (${paymentMethod}) ${tier} for ${clerkUserId}`);

      // Get the first invoice, add free-trial note, finalize, and return payment URL
      const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 1 });
      let invoiceUrl = `${baseUrl}/?checkout=success&tier=${tier}`;
      if (invoices.data[0]) {
        let invoice = invoices.data[0];
        // Add note about free trial being card-only
        if (invoice.status === 'draft') {
          await stripe.invoices.update(invoice.id, {
            description: paymentMethod === 'wechat_pay'
              ? 'Terse Pro 月度订阅。免费试用仅支持银行卡支付，微信支付需直接付款。\nTerse Pro monthly subscription. Free trial is only available with bank card payment.'
              : 'Terse Pro 月度订阅。免费试用仅支持银行卡支付，支付宝需直接付款。\nTerse Pro monthly subscription. Free trial is only available with bank card payment.',
          });
          invoice = await stripe.invoices.finalizeInvoice(invoice.id);
        }
        invoiceUrl = invoice.hosted_invoice_url || invoiceUrl;
        console.log(`[license] invoice ${invoice.id} status=${invoice.status} url=${invoiceUrl}`);
      }

      res.json({ url: invoiceUrl, sessionId: null });
    } else {
      // Default: card/Link via Stripe Checkout (WeChat/Alipay use send_invoice path above)
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${baseUrl}/?checkout=success&tier=${tier}`,
        cancel_url: `${baseUrl}/?checkout=cancelled`,
        metadata: { clerk_user_id: clerkUserId, tier },
        subscription_data: {
          trial_period_days: TRIAL_DAYS,
          metadata: { clerk_user_id: clerkUserId, tier },
        },
      });

      res.json({ url: session.url, sessionId: session.id });
    }
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

    let license = licenseCache.get(clerkUserId);

    // If not in cache, look up customer in Stripe
    if (!license?.stripeCustomerId) {
      try {
        const customers = await stripe.customers.search({
          query: `metadata["clerk_user_id"]:"${clerkUserId}"`,
        });
        if (customers.data.length > 0) {
          license = { stripeCustomerId: customers.data[0].id };
        }
      } catch (e) {
        console.error('[portal] stripe lookup error:', e.message);
      }
    }

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

// ── Portal redirect (GET — opens in browser, redirects to Stripe) ──
app.get('/api/portal/redirect', async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.redirect('/#pricing');

  try {
    // Find Stripe customer
    let customerId = licenseCache.get(uid)?.stripeCustomerId;

    if (!customerId) {
      const customers = await stripe.customers.search({
        query: `metadata["clerk_user_id"]:"${uid}"`,
      });
      if (customers.data.length > 0) customerId = customers.data[0].id;
    }

    if (!customerId) return res.redirect('/#pricing');

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: baseUrl,
    });

    res.redirect(session.url);
  } catch (err) {
    console.error('[portal/redirect] error:', err.message);
    res.redirect('/#pricing');
  }
});

// ── License Verification (called by Tauri app) ──
app.get('/api/license/:clerkUserId', async (req, res) => {
  const { clerkUserId } = req.params;
  const platform = (req.query.platform || '').toLowerCase();
  const isIOS = platform === 'ios';
  const planLimits = isIOS ? PLAN_LIMITS_IOS : PLAN_LIMITS;

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
        // Check for active or trialing subscriptions
        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          limit: 5,
        });
        // Filter to active or trialing
        subs.data = subs.data.filter(s => s.status === 'active' || s.status === 'trialing');

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

  // Dev/test account overrides
  const ACCOUNT_OVERRIDES = {
    'user_3BP20FfLSljVdFW6tKgC2Vxmi6P': { optimizations_per_week: -1, max_sessions: 3, max_devices: 2 },
  };

  if (!license || license.status === 'cancelled') {
    const override = ACCOUNT_OVERRIDES[clerkUserId];
    if (override) {
      return res.json({ tier: 'pro', status: 'active', limits: override });
    }
    return res.json({
      tier: 'expired',
      status: 'cancelled',
      limits: { optimizations_per_week: 0, max_sessions: 0, max_devices: 0 },
    });
  }

  // Both 'trialing' and 'active' get full plan limits
  const effectiveStatus = (license.status === 'trialing' || license.status === 'active') ? license.status : license.status;

  res.json({
    tier: license.tier,
    status: effectiveStatus,
    limits: planLimits[license.tier] || { optimizations_per_week: 0, max_sessions: 0, max_devices: 0 },
    expiresAt: license.expiresAt,
    trialEnd: license.trialEnd || null,
  });
});

// ── Auth flow for desktop app ──
// Pending auth tokens: token -> { created, clerkUserId, email, imageUrl }
const pendingAuth = new Map();

// Desktop app calls this to get a unique auth token, then opens browser
app.post('/api/auth/start', (req, res) => {
  const token = require('crypto').randomBytes(24).toString('hex');
  pendingAuth.set(token, { created: Date.now(), clerkUserId: null });
  // Clean old tokens (>10 min)
  for (const [k, v] of pendingAuth) {
    if (Date.now() - v.created > 600000) pendingAuth.delete(k);
  }
  res.json({ token });
});

// Browser redirects here after Clerk sign-in — stores user info for polling
app.post('/api/auth/complete', (req, res) => {
  const { token, clerkUserId, email, imageUrl, firstName } = req.body;
  if (!token || !clerkUserId) return res.status(400).json({ error: 'Missing token or user' });
  const pending = pendingAuth.get(token);
  if (!pending) return res.status(404).json({ error: 'Token expired or invalid' });
  pending.clerkUserId = clerkUserId;
  pending.email = email;
  pending.imageUrl = imageUrl;
  pending.firstName = firstName;
  pendingAuth.set(token, pending);
  res.json({ ok: true });
});

// Desktop app polls this until user completes sign-in
app.get('/api/auth/poll/:token', (req, res) => {
  const pending = pendingAuth.get(req.params.token);
  if (!pending) return res.json({ status: 'expired' });
  if (!pending.clerkUserId) return res.json({ status: 'waiting' });
  // Auth complete — return user info and clean up
  pendingAuth.delete(req.params.token);
  res.json({
    status: 'authenticated',
    clerkUserId: pending.clerkUserId,
    email: pending.email,
    imageUrl: pending.imageUrl,
    firstName: pending.firstName,
  });
});

// Apple Sign In — iOS sends Apple identity token, we create/find user via Clerk
app.post('/api/auth/apple', async (req, res) => {
  try {
    const { identityToken, email, firstName, lastName } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'Missing identityToken' });

    // Decode the Apple identity token (JWT) to get the subject (Apple user ID)
    const parts = identityToken.split('.');
    if (parts.length !== 3) return res.status(400).json({ error: 'Invalid token format' });
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const appleUserId = payload.sub;
    const appleEmail = payload.email || email;

    if (!appleUserId) return res.status(400).json({ error: 'No subject in token' });
    console.log(`[Apple Auth] sub=${appleUserId}, email=${appleEmail || 'none'}, firstName=${firstName || 'none'}`);

    const headers = { Authorization: `Bearer ${CLERK_SECRET}`, 'Content-Type': 'application/json' };

    let clerkUser = null;

    // 1) Search by external_id (apple_<sub>) — works even without email on repeat sign-ins
    try {
      const extRes = await fetch(`https://api.clerk.com/v1/users?external_id=apple_${appleUserId}`, { headers });
      const extUsers = await extRes.json();
      if (Array.isArray(extUsers) && extUsers.length > 0) {
        clerkUser = extUsers[0];
        console.log(`[Apple Auth] Found user by external_id: ${clerkUser.id}`);
      }
    } catch (e) { console.error('[Apple Auth] external_id search failed:', e.message); }

    // 2) Search by email if not found
    if (!clerkUser && appleEmail) {
      try {
        const searchRes = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(appleEmail)}`, { headers });
        const users = await searchRes.json();
        if (Array.isArray(users) && users.length > 0) {
          clerkUser = users[0];
          console.log(`[Apple Auth] Found user by email: ${clerkUser.id}`);
          // Tag with external_id for future lookups without email
          if (!clerkUser.external_id) {
            await fetch(`https://api.clerk.com/v1/users/${clerkUser.id}`, {
              method: 'PATCH', headers, body: JSON.stringify({ external_id: `apple_${appleUserId}` }),
            }).catch(() => {});
          }
        }
      } catch (e) { console.error('[Apple Auth] email search failed:', e.message); }
    }

    // 3) Create new user if not found
    if (!clerkUser) {
      console.log('[Apple Auth] Creating new Clerk user...');
      const createBody = { external_id: `apple_${appleUserId}` };
      if (appleEmail) createBody.email_address = [appleEmail];
      if (firstName) createBody.first_name = firstName;
      if (lastName) createBody.last_name = lastName;
      // skip_password_requirement since this is an Apple Sign In user
      createBody.skip_password_requirement = true;

      const createRes = await fetch('https://api.clerk.com/v1/users', {
        method: 'POST', headers, body: JSON.stringify(createBody),
      });
      clerkUser = await createRes.json();

      if (clerkUser.errors) {
        console.error('[Apple Auth] Clerk create error:', JSON.stringify(clerkUser.errors));
        // If email already taken (race condition), try searching again
        if (appleEmail && clerkUser.errors.some(e => e.code === 'form_identifier_exists')) {
          const retryRes = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(appleEmail)}`, { headers });
          const retryUsers = await retryRes.json();
          if (Array.isArray(retryUsers) && retryUsers.length > 0) {
            clerkUser = retryUsers[0];
            console.log(`[Apple Auth] Found user on retry: ${clerkUser.id}`);
          } else {
            return res.status(500).json({ error: 'Failed to create user', details: clerkUser.errors });
          }
        } else {
          return res.status(500).json({ error: 'Failed to create user', details: clerkUser.errors });
        }
      } else {
        console.log(`[Apple Auth] Created user: ${clerkUser.id}`);
      }
    }

    // Return user info
    res.json({
      status: 'authenticated',
      clerkUserId: clerkUser.id,
      email: clerkUser.email_addresses?.[0]?.email_address || appleEmail || '',
      imageUrl: clerkUser.image_url || null,
      firstName: clerkUser.first_name || firstName || null,
    });
  } catch (err) {
    console.error('[Apple Auth] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IAP Verification (iOS StoreKit) ──
app.post('/api/iap/verify', (req, res) => {
  const { clerkUserId, productId, transactionId, originalTransactionId, expirationDate } = req.body;
  if (!clerkUserId || !productId) return res.status(400).json({ error: 'Missing fields' });

  // Map product ID to tier
  let tier = 'free';
  if (productId === 'com.pruneai.pro.monthly') tier = 'pro';

  const expDate = expirationDate ? new Date(expirationDate * 1000).toISOString() : null;

  licenseCache.set(clerkUserId, {
    tier,
    stripeCustomerId: null,
    subscriptionId: `iap_${originalTransactionId || transactionId}`,
    status: 'active',
    expiresAt: expDate,
  });

  console.log(`[IAP] Verified ${tier} for ${clerkUserId} (txn: ${transactionId}, expires: ${expDate})`);
  res.json({ ok: true, tier });
});

// ── Account Deletion ──
app.post('/api/auth/delete', async (req, res) => {
  const { clerkUserId } = req.body;
  if (!clerkUserId) return res.status(400).json({ error: 'Missing clerkUserId' });

  console.log(`[Account] Deletion requested for ${clerkUserId}`);

  // Remove from license cache
  licenseCache.delete(clerkUserId);

  // Delete from Clerk
  try {
    const headers = { Authorization: `Bearer ${CLERK_SECRET}` };
    await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, { method: 'DELETE', headers });
    console.log(`[Account] Deleted Clerk user ${clerkUserId}`);
  } catch (err) {
    console.error(`[Account] Clerk deletion error: ${err.message}`);
  }

  res.json({ ok: true });
});

// ── Marketplace API routes ──
app.use('/api/marketplace', marketplaceRouter);

// ── LLM Proxy (rate-limited) ──
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: { message: 'Rate limit exceeded. Max 120 requests/minute.' } },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/proxy', proxyLimiter, proxyRouter);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Serve landing page ──
app.use(express.static(path.join(__dirname, '..', 'landing'), { extensions: ['html'] }));

// SPA fallback — but not for marketplace (it has its own HTML)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[pruneai-api] running on port ${PORT}`);
  // Auto-seed marketplace if empty
  try {
    const count = db.getListings.all();
    const totalKeys = count.reduce((sum, r) => sum + r.available_keys, 0);
    if (totalKeys === 0) {
      console.log('[seed] No marketplace listings found, seeding...');
      require('./seed-listings');
    } else {
      console.log(`[seed] ${totalKeys} marketplace listings already exist`);
    }
  } catch (e) { console.error('[seed] error:', e.message); }
});
