/**
 * Terse Token Exchange — Marketplace API Routes
 * Seller: add/manage API keys for selling
 * Buyer: get virtual keys, top up balance, view usage
 * Public: browse available listings
 */
const express = require('express');
const crypto = require('crypto');
const { encrypt } = require('./crypto-utils');
const db = require('./db');
const notifications = require('./notify');

const router = express.Router();

// Commission rate (configurable via env)
const COMMISSION_PERCENT = parseFloat(process.env.TERSE_COMMISSION_PERCENT || '15');

// Known provider list prices (cents per 1M tokens) — for reference/validation
// Retail list prices in cents per 1M tokens (updated April 2026)
const PROVIDER_LIST_PRICES = {
  anthropic: {
    'claude-opus-4-20250514':   { input: 500, output: 2500 },
    'claude-sonnet-4-20250514': { input: 300, output: 1500 },
    'claude-haiku-4-20250414':  { input: 100, output: 500 },
  },
  openai: {
    'gpt-4o':      { input: 250, output: 1000 },
    'gpt-4o-mini': { input: 15,  output: 60 },
    'gpt-4.1':     { input: 200, output: 800 },
    'o3':          { input: 200, output: 800 },
  },
  google: {
    'gemini-2.5-pro':   { input: 125, output: 1000 },
    'gemini-2.5-flash': { input: 30,  output: 250 },
  },
};

// ════════════════════════════════════════
//  AUTH MIDDLEWARE — verifies Clerk session
// ════════════════════════════════════════
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const token = authHeader.slice(7);

  // Verify with Clerk — decode JWT and extract sub (userId)
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return res.status(401).json({ error: 'Invalid token' });
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const userId = payload.sub;
    if (!userId) return res.status(401).json({ error: 'Invalid token: no sub' });

    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return res.status(401).json({ error: 'Token expired' });
    }

    req.userId = userId;
    req.userEmail = payload.email || null;
    db.ensureUser(userId, req.userEmail);
    next();
  } catch (err) {
    console.error('[auth] token error:', err.message);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// ════════════════════════════════════════
//  PUBLIC — Listings
// ════════════════════════════════════════
router.get('/listings', (req, res) => {
  const listings = db.getListings.all();
  res.json({
    listings: listings.map(l => ({
      provider: l.provider,
      available_keys: l.available_keys,
      min_price_input: l.min_price_input,
      min_price_output: l.min_price_output,
      avg_price_input: Math.round(l.avg_price_input),
      avg_price_output: Math.round(l.avg_price_output),
      list_prices: PROVIDER_LIST_PRICES[l.provider] || {},
    })),
    commission_percent: COMMISSION_PERCENT,
  });
});

// Detailed listings — individual keys with pricing, capacity, trust signals
router.get('/listings/detailed', (req, res) => {
  const keys = db.getDetailedListings.all();
  const fmt = (n) => n >= 1000000 ? (n/1000000).toFixed(1) + 'M' : n >= 1000 ? Math.round(n/1000) + 'K' : String(n);
  res.json({
    listings: keys.map(k => {
      const listPrices = PROVIDER_LIST_PRICES[k.provider] || {};
      const firstModel = Object.entries(listPrices)[0];
      const discount = firstModel ? Math.round((1 - k.price_per_1m_input / firstModel[1].input) * 100) : null;
      // Capacity: how much headroom is left
      const totalCapacity = k.token_cap_total ? Math.max(0, k.token_cap_total - (k.total_tokens_used || 0)) : null;
      const hourlyCapacity = k.token_cap_hourly ? Math.max(0, k.token_cap_hourly - (k.hourly_tokens_used || 0)) : null;
      return {
        id: k.id,
        provider: k.provider,
        label: k.label,
        price_per_1m_input: k.price_per_1m_input,
        price_per_1m_output: k.price_per_1m_output,
        optimization_mode: k.optimization_mode,
        verified: !!k.key_verified,
        discount_pct: discount,
        models: Object.keys(listPrices),
        list_prices: listPrices,
        capacity: {
          total_remaining: totalCapacity,
          total_remaining_fmt: totalCapacity !== null ? fmt(totalCapacity) : null,
          hourly_remaining: hourlyCapacity,
          hourly_remaining_fmt: hourlyCapacity !== null ? fmt(hourlyCapacity) : null,
        },
        provider_limits: k.rate_limit_info ? JSON.parse(k.rate_limit_info) : null,
        created_at: k.created_at,
      };
    }),
    providers: PROVIDER_LIST_PRICES,
    commission_percent: COMMISSION_PERCENT,
  });
});

// Provider reference prices
router.get('/providers', (req, res) => {
  res.json({ providers: PROVIDER_LIST_PRICES, commission_percent: COMMISSION_PERCENT });
});

// ════════════════════════════════════════
//  SELLER — Manage API Keys
// ════════════════════════════════════════
router.get('/seller/keys', requireAuth, (req, res) => {
  const keys = db.getSellerKeys.all(req.userId);
  res.json({ keys });
});

router.post('/seller/keys', requireAuth, async (req, res) => {
  const { provider, apiKey, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, models_allowed, optimization_mode, token_cap_total, token_cap_hourly, token_cap_daily, rate_limit_hourly_cents, rate_limit_daily_cents } = req.body;

  if (!provider || !apiKey) return res.status(400).json({ error: 'Missing provider or apiKey' });
  if (!['anthropic', 'openai', 'google'].includes(provider)) return res.status(400).json({ error: 'Invalid provider. Use: anthropic, openai, google' });
  if (!price_per_1m_input || !price_per_1m_output) return res.status(400).json({ error: 'Missing pricing' });

  const validModes = ['off', 'soft', 'normal', 'aggressive'];
  const mode = validModes.includes(optimization_mode) ? optimization_mode : 'normal';

  // Validate the API key works by making a minimal test call
  let keyVerified = 0;
  let rateLimitInfo = null;
  try {
    const testResult = await validateApiKey(provider, apiKey);
    keyVerified = testResult.valid ? 1 : 0;
    rateLimitInfo = testResult.rateLimits ? JSON.stringify(testResult.rateLimits) : null;
    if (!testResult.valid) {
      return res.status(400).json({ error: `Invalid API key: ${testResult.error || 'key did not authenticate'}` });
    }
  } catch (e) {
    console.error('[validate] key test error:', e.message);
    // Allow adding even if validation fails (network issues, etc.)
    keyVerified = 0;
  }

  // Encrypt the API key
  const { encrypted, iv, tag } = encrypt(apiKey);

  const id = crypto.randomUUID();
  db.addSellerKey.run({
    id,
    user_id: req.userId,
    provider,
    encrypted_key: encrypted,
    key_iv: iv,
    key_tag: tag,
    label: label || `${provider} key`,
    price_per_1m_input: Math.round(price_per_1m_input),
    price_per_1m_output: Math.round(price_per_1m_output),
    spending_cap_cents: spending_cap_cents ? Math.round(spending_cap_cents) : null,
    models_allowed: models_allowed ? JSON.stringify(models_allowed) : null,
    optimization_mode: mode,
    token_cap_total: token_cap_total ? Math.round(token_cap_total) : null,
    token_cap_hourly: token_cap_hourly ? Math.round(token_cap_hourly) : null,
    token_cap_daily: token_cap_daily ? Math.round(token_cap_daily) : null,
    rate_limit_hourly_cents: rate_limit_hourly_cents ? Math.round(rate_limit_hourly_cents) : null,
    rate_limit_daily_cents: rate_limit_daily_cents ? Math.round(rate_limit_daily_cents) : null,
    key_verified: keyVerified,
  });

  if (rateLimitInfo) {
    db.updateRateLimitInfo.run(rateLimitInfo, id);
  }

  // Notify seller
  notifications.notifyKeyListed(req.userId, provider);

  res.json({ id, verified: !!keyVerified, rate_limits: rateLimitInfo ? JSON.parse(rateLimitInfo) : null, message: keyVerified ? 'Key verified and listed!' : 'Key added (verification pending)' });
});

// Validate an API key by making a minimal test call
async function validateApiKey(provider, apiKey) {
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-20250414', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const rateLimits = {
        requests_limit: res.headers.get('anthropic-ratelimit-requests-limit'),
        requests_remaining: res.headers.get('anthropic-ratelimit-requests-remaining'),
        tokens_limit: res.headers.get('anthropic-ratelimit-tokens-limit'),
        tokens_remaining: res.headers.get('anthropic-ratelimit-tokens-remaining'),
        input_tokens_limit: res.headers.get('anthropic-ratelimit-input-tokens-limit'),
        input_tokens_remaining: res.headers.get('anthropic-ratelimit-input-tokens-remaining'),
        output_tokens_limit: res.headers.get('anthropic-ratelimit-output-tokens-limit'),
        output_tokens_remaining: res.headers.get('anthropic-ratelimit-output-tokens-remaining'),
      };
      if (res.status === 401) return { valid: false, error: 'Invalid API key' };
      return { valid: res.ok || res.status === 429, rateLimits };
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const rateLimits = {
        requests_limit: res.headers.get('x-ratelimit-limit-requests'),
        requests_remaining: res.headers.get('x-ratelimit-remaining-requests'),
        tokens_limit: res.headers.get('x-ratelimit-limit-tokens'),
        tokens_remaining: res.headers.get('x-ratelimit-remaining-tokens'),
      };
      if (res.status === 401) return { valid: false, error: 'Invalid API key' };
      return { valid: res.ok || res.status === 429, rateLimits };
    } else if (provider === 'google') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (res.status === 400 || res.status === 403) return { valid: false, error: 'Invalid API key' };
      return { valid: res.ok, rateLimits: null };
    }
    return { valid: false, error: 'Unknown provider' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

router.patch('/seller/keys/:id', requireAuth, (req, res) => {
  const existing = db.getSellerKeyFull.get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Key not found' });

  db.updateSellerKey.run({
    id: req.params.id,
    user_id: req.userId,
    price_per_1m_input: req.body.price_per_1m_input ?? existing.price_per_1m_input,
    price_per_1m_output: req.body.price_per_1m_output ?? existing.price_per_1m_output,
    spending_cap_cents: req.body.spending_cap_cents !== undefined ? req.body.spending_cap_cents : existing.spending_cap_cents,
    is_active: req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active,
    models_allowed: req.body.models_allowed !== undefined ? JSON.stringify(req.body.models_allowed) : existing.models_allowed,
    optimization_mode: req.body.optimization_mode ?? existing.optimization_mode ?? 'normal',
    token_cap_total: req.body.token_cap_total !== undefined ? req.body.token_cap_total : existing.token_cap_total,
    token_cap_hourly: req.body.token_cap_hourly !== undefined ? req.body.token_cap_hourly : existing.token_cap_hourly,
    token_cap_daily: req.body.token_cap_daily !== undefined ? req.body.token_cap_daily : existing.token_cap_daily,
    rate_limit_hourly_cents: req.body.rate_limit_hourly_cents !== undefined ? req.body.rate_limit_hourly_cents : existing.rate_limit_hourly_cents,
    rate_limit_daily_cents: req.body.rate_limit_daily_cents !== undefined ? req.body.rate_limit_daily_cents : existing.rate_limit_daily_cents,
  });

  res.json({ ok: true });
});

router.delete('/seller/keys/:id', requireAuth, (req, res) => {
  const result = db.deleteSellerKey.run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

// Seller earnings summary
router.get('/seller/earnings', requireAuth, (req, res) => {
  const user = db.getUser.get(req.userId);
  const earnings = db.getSellerEarnings.get(req.userId);
  const recent = db.getTransactionsBySeller.all(req.userId, 50);
  res.json({
    balance_cents: user?.seller_balance_cents || 0,
    stripe_connect_id: user?.stripe_connect_id || null,
    ...earnings,
    recent_transactions: recent,
  });
});

// Stripe Connect onboarding — seller sets up bank account to receive payouts
router.post('/seller/connect', requireAuth, async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const user = db.getUser.get(req.userId);
    const baseUrl = process.env.APP_URL || 'https://www.pruneai.com';

    let connectId = user?.stripe_connect_id;

    // Create Connect Express account if not exists
    if (!connectId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: user?.email || undefined,
        metadata: { clerk_user_id: req.userId },
        capabilities: {
          transfers: { requested: true },
        },
      });
      connectId = account.id;
      db.updateStripeConnect.run(connectId, req.userId);
    }

    // Create onboarding link
    const link = await stripe.accountLinks.create({
      account: connectId,
      refresh_url: `${baseUrl}/marketplace?connect=refresh`,
      return_url: `${baseUrl}/marketplace?connect=success`,
      type: 'account_onboarding',
    });

    res.json({ url: link.url });
  } catch (err) {
    console.error('[connect] error:', err.message);
    res.status(500).json({ error: 'Failed to set up payouts: ' + err.message });
  }
});

// Check Connect account status
router.get('/seller/connect/status', requireAuth, async (req, res) => {
  const user = db.getUser.get(req.userId);
  if (!user?.stripe_connect_id) {
    return res.json({ connected: false });
  }
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const account = await stripe.accounts.retrieve(user.stripe_connect_id);
    res.json({
      connected: true,
      payouts_enabled: account.payouts_enabled,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Withdraw — transfer from Terse platform to seller's bank via Stripe Connect
router.post('/seller/withdraw', requireAuth, async (req, res) => {
  const user = db.getUser.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.stripe_connect_id) {
    return res.status(400).json({ error: 'Set up payouts first. Click "Set Up Payouts" to connect your bank account.' });
  }

  const amount = req.body.amount_cents || user.seller_balance_cents;
  if (amount <= 0) return res.status(400).json({ error: 'Nothing to withdraw' });
  if (amount > user.seller_balance_cents) return res.status(400).json({ error: 'Insufficient balance' });
  if (amount < 500) return res.status(400).json({ error: 'Minimum withdrawal is $5.00' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Verify the Connect account can receive payouts
    const account = await stripe.accounts.retrieve(user.stripe_connect_id);
    if (!account.payouts_enabled) {
      return res.status(400).json({ error: 'Your payout account is not fully set up. Click "Set Up Payouts" to complete onboarding.' });
    }

    // Create transfer to seller's Connect account
    const transfer = await stripe.transfers.create({
      amount,
      currency: 'usd',
      destination: user.stripe_connect_id,
      description: `Terse Token Exchange payout`,
      metadata: { clerk_user_id: req.userId },
    });

    // Debit seller balance and record payout
    const payoutId = crypto.randomUUID();
    db.debitSellerBalance.run(amount, req.userId);
    db.addPayout.run({ id: payoutId, user_id: req.userId, amount_cents: amount, status: 'completed' });
    db.updatePayoutStatus.run('completed', transfer.id, payoutId);

    notifications.notifyWithdrawal(req.userId, amount);

    res.json({
      payout_id: payoutId,
      amount_cents: amount,
      status: 'completed',
      message: `$${(amount / 100).toFixed(2)} transferred to your bank account. Arrives in 2-3 business days.`,
    });
  } catch (err) {
    console.error('[withdraw] stripe error:', err.message);
    res.status(500).json({ error: 'Transfer failed: ' + err.message });
  }
});

// ════════════════════════════════════════
//  BUYER — Virtual Keys & Balance
// ════════════════════════════════════════
router.post('/buyer/keys', requireAuth, (req, res) => {
  // Generate a virtual API key
  const rawKey = `terse_bk_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = db.hashKey(rawKey);
  const id = crypto.randomUUID();

  db.addBuyerKey.run({
    id,
    user_id: req.userId,
    key_hash: keyHash,
    label: req.body.label || 'Default',
  });

  // Return raw key ONCE — it's stored hashed
  res.json({
    id,
    key: rawKey,
    message: 'Save this key — it won\'t be shown again.',
  });
});

router.get('/buyer/keys', requireAuth, (req, res) => {
  const keys = db.getBuyerKeys.all(req.userId);
  res.json({ keys });
});

router.delete('/buyer/keys/:id', requireAuth, (req, res) => {
  const result = db.deactivateBuyerKey.run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

// Balance
router.get('/buyer/balance', requireAuth, (req, res) => {
  const user = db.getUser.get(req.userId);
  res.json({ balance_cents: user?.buyer_balance_cents || 0 });
});

// Top-up via Stripe checkout (payment mode, not subscription)
router.post('/buyer/topup', requireAuth, async (req, res) => {
  const { amount_cents } = req.body;
  if (!amount_cents || amount_cents < 500) return res.status(400).json({ error: 'Minimum top-up is $5.00' });
  if (amount_cents > 100000) return res.status(400).json({ error: 'Maximum top-up is $1,000.00' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.APP_URL || 'https://www.pruneai.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount_cents,
          product_data: {
            name: `Terse Token Exchange — $${(amount_cents / 100).toFixed(2)} Top-up`,
            description: 'Add funds to your Terse marketplace balance',
          },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/marketplace?topup=success`,
      cancel_url: `${baseUrl}/marketplace?topup=cancelled`,
      metadata: {
        type: 'marketplace_topup',
        clerk_user_id: req.userId,
        amount_cents: String(amount_cents),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[topup] error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Usage history
router.get('/buyer/usage', requireAuth, (req, res) => {
  const spending = db.getBuyerSpending.get(req.userId);
  const user = db.getUser.get(req.userId);
  const recent = db.getTransactionsByBuyer.all(req.userId, 50);
  res.json({
    balance_cents: user?.buyer_balance_cents || 0,
    ...spending,
    recent_transactions: recent,
  });
});

// ════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════
router.get('/notifications', requireAuth, (req, res) => {
  const items = notifications.getNotifications(req.userId, 30);
  const unread = notifications.getUnreadCount(req.userId);
  res.json({ notifications: items, unread });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  notifications.markRead(req.params.id, req.userId);
  res.json({ ok: true });
});

// Admin: seed realistic marketplace data
router.post('/admin/seed-demo', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_TEST_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { encrypt } = require('./crypto-utils');

    // 30 realistic seller profiles
    const sellers = [
      { id: 'user_2nKp8xR3mTvY', email: 'marcus.chen@gmail.com', name: 'Marcus C.', provider: 'anthropic', label: 'Spare Claude Opus credits', discount: 0.30, mode: 'normal', capTotal: 50000000, capHourly: 1000000, capDaily: 10000000, verified: 1 },
      { id: 'user_2mLq9yS4nUwZ', email: 'sarah.kim@outlook.com', name: 'Sarah K.', provider: 'anthropic', label: 'Unused Sonnet allocation', discount: 0.25, mode: 'soft', capTotal: 100000000, capHourly: 2000000, capDaily: 20000000, verified: 1 },
      { id: 'user_2oMr0zT5oVxA', email: 'jdevries@proton.me', name: 'Johan D.', provider: 'openai', label: 'GPT-4o enterprise surplus', discount: 0.35, mode: 'normal', capTotal: 80000000, capHourly: 1500000, capDaily: 15000000, verified: 1 },
      { id: 'user_2pNs1AU6pWyB', email: 'aisha.rahman@gmail.com', name: 'Aisha R.', provider: 'google', label: 'Gemini Pro leftover tokens', discount: 0.40, mode: 'aggressive', capTotal: null, capHourly: 500000, capDaily: 5000000, verified: 1 },
      { id: 'user_2qOt2BV7qXzC', email: 'tom.wilson@hey.com', name: 'Tom W.', provider: 'anthropic', label: 'Claude team plan excess', discount: 0.20, mode: 'soft', capTotal: 200000000, capHourly: 5000000, capDaily: 50000000, verified: 1 },
      { id: 'user_2rPu3CW8rYAD', email: 'lina.petrov@yandex.com', name: 'Lina P.', provider: 'openai', label: 'o3 research credits', discount: 0.28, mode: 'normal', capTotal: 30000000, capHourly: 800000, capDaily: 8000000, verified: 1 },
      { id: 'user_2sQv4DX9sZBE', email: 'kenji.tanaka@icloud.com', name: 'Kenji T.', provider: 'anthropic', label: 'Haiku batch credits', discount: 0.45, mode: 'aggressive', capTotal: null, capHourly: 3000000, capDaily: 30000000, verified: 1 },
      { id: 'user_2tRw5EY0tACF', email: 'elena.garcia@gmail.com', name: 'Elena G.', provider: 'google', label: 'Gemini Flash API key', discount: 0.50, mode: 'normal', capTotal: 150000000, capHourly: null, capDaily: null, verified: 1 },
      { id: 'user_2uSx6FZ1uBDG', email: 'alex.novak@tutanota.com', name: 'Alex N.', provider: 'openai', label: 'GPT-4o-mini high volume', discount: 0.30, mode: 'soft', capTotal: null, capHourly: 2000000, capDaily: 25000000, verified: 1 },
      { id: 'user_2vTy7GA2vCEH', email: 'priya.sharma@gmail.com', name: 'Priya S.', provider: 'anthropic', label: 'Opus enterprise key', discount: 0.15, mode: 'off', capTotal: 20000000, capHourly: 500000, capDaily: 5000000, verified: 1 },
      { id: 'user_2wUz8HB3wDFI', email: 'daniel.oconnor@pm.me', name: 'Daniel O.', provider: 'openai', label: 'Startup GPT-4.1 credits', discount: 0.32, mode: 'normal', capTotal: 60000000, capHourly: 1200000, capDaily: 12000000, verified: 1 },
      { id: 'user_2xVA9IC4xEGJ', email: 'yuki.sato@gmail.com', name: 'Yuki S.', provider: 'google', label: 'Gemini Pro enterprise', discount: 0.35, mode: 'soft', capTotal: 90000000, capHourly: 1800000, capDaily: 18000000, verified: 1 },
      { id: 'user_2yWB0JD5yFHK', email: 'omar.hassan@outlook.com', name: 'Omar H.', provider: 'anthropic', label: 'Claude Sonnet dev key', discount: 0.22, mode: 'normal', capTotal: 40000000, capHourly: 800000, capDaily: 8000000, verified: 1 },
      { id: 'user_2zXC1KE6zGIL', email: 'maria.silva@gmail.com', name: 'Maria S.', provider: 'openai', label: 'GPT-4o team surplus', discount: 0.38, mode: 'aggressive', capTotal: 70000000, capHourly: null, capDaily: 15000000, verified: 1 },
      { id: 'user_30YD2LF70HJM', email: 'james.okafor@icloud.com', name: 'James O.', provider: 'google', label: 'Flash high-throughput', discount: 0.55, mode: 'aggressive', capTotal: null, capHourly: 5000000, capDaily: null, verified: 1 },
      { id: 'user_31ZE3MG81IKN', email: 'anna.muller@web.de', name: 'Anna M.', provider: 'anthropic', label: 'Haiku production spare', discount: 0.40, mode: 'normal', capTotal: 120000000, capHourly: 2500000, capDaily: 25000000, verified: 1 },
      { id: 'user_32AF4NH92JLO', email: 'ravi.patel@gmail.com', name: 'Ravi P.', provider: 'openai', label: 'o3 reasoning credits', discount: 0.18, mode: 'off', capTotal: 15000000, capHourly: 400000, capDaily: 4000000, verified: 1 },
      { id: 'user_33BG5OI03KMP', email: 'claire.dubois@free.fr', name: 'Claire D.', provider: 'anthropic', label: 'Opus research allocation', discount: 0.25, mode: 'soft', capTotal: 35000000, capHourly: 700000, capDaily: 7000000, verified: 1 },
      { id: 'user_34CH6PJ14LNQ', email: 'david.lee@gmail.com', name: 'David L.', provider: 'google', label: 'Gemini Pro batch key', discount: 0.42, mode: 'normal', capTotal: 200000000, capHourly: null, capDaily: 40000000, verified: 1 },
      { id: 'user_35DI7QK25MOR', email: 'nina.kowalski@wp.pl', name: 'Nina K.', provider: 'openai', label: 'Mini high-volume key', discount: 0.48, mode: 'aggressive', capTotal: null, capHourly: 4000000, capDaily: 50000000, verified: 1 },
      { id: 'user_36EJ8RL36NPS', email: 'lucas.berg@gmail.com', name: 'Lucas B.', provider: 'anthropic', label: 'Sonnet startup credits', discount: 0.28, mode: 'normal', capTotal: 55000000, capHourly: 1100000, capDaily: 11000000, verified: 1 },
      { id: 'user_37FK9SM47OQT', email: 'fatima.al-rashid@gmail.com', name: 'Fatima A.', provider: 'openai', label: 'GPT-4o research key', discount: 0.20, mode: 'soft', capTotal: 45000000, capHourly: 900000, capDaily: 9000000, verified: 1 },
      { id: 'user_38GL0TN58PRU', email: 'erik.johansson@live.se', name: 'Erik J.', provider: 'google', label: 'Flash dev environment', discount: 0.60, mode: 'aggressive', capTotal: null, capHourly: null, capDaily: null, verified: 1 },
      { id: 'user_39HM1UO69QSV', email: 'sophie.martin@gmail.com', name: 'Sophie M.', provider: 'anthropic', label: 'Haiku CI/CD pipeline key', discount: 0.35, mode: 'normal', capTotal: 80000000, capHourly: 1600000, capDaily: 16000000, verified: 1 },
      { id: 'user_40IN2VP70RTW', email: 'carlos.mendez@hotmail.com', name: 'Carlos M.', provider: 'openai', label: 'GPT-4.1 enterprise', discount: 0.24, mode: 'soft', capTotal: 65000000, capHourly: 1300000, capDaily: 13000000, verified: 1 },
      { id: 'user_41JO3WQ81SUX', email: 'mei.wong@gmail.com', name: 'Mei W.', provider: 'google', label: 'Pro research credits', discount: 0.30, mode: 'normal', capTotal: 110000000, capHourly: 2200000, capDaily: 22000000, verified: 1 },
      { id: 'user_42KP4XR92TVY', email: 'ivan.volkov@mail.ru', name: 'Ivan V.', provider: 'anthropic', label: 'Opus high-tier key', discount: 0.12, mode: 'off', capTotal: 10000000, capHourly: 300000, capDaily: 3000000, verified: 1 },
      { id: 'user_43LQ5YS03UWZ', email: 'rachel.huang@yahoo.com', name: 'Rachel H.', provider: 'openai', label: 'Team plan overflow', discount: 0.33, mode: 'normal', capTotal: 75000000, capHourly: 1500000, capDaily: 15000000, verified: 1 },
      { id: 'user_44MR6ZT14VXA', email: 'andreas.schmidt@gmx.de', name: 'Andreas S.', provider: 'anthropic', label: 'Sonnet production key', discount: 0.27, mode: 'normal', capTotal: 95000000, capHourly: 1900000, capDaily: 19000000, verified: 1 },
      { id: 'user_45NS7AU25WYB', email: 'jenny.park@naver.com', name: 'Jenny P.', provider: 'google', label: 'Gemini Flash unlimited', discount: 0.52, mode: 'aggressive', capTotal: null, capHourly: 6000000, capDaily: null, verified: 1 },
    ];

    // Model-to-price mapping for each provider
    const providerModels = {
      anthropic: [
        { model: 'claude-opus-4-20250514', input: 500, output: 2500 },
        { model: 'claude-sonnet-4-20250514', input: 300, output: 1500 },
        { model: 'claude-haiku-4-20250414', input: 100, output: 500 },
      ],
      openai: [
        { model: 'gpt-4o', input: 250, output: 1000 },
        { model: 'gpt-4o-mini', input: 15, output: 60 },
        { model: 'gpt-4.1', input: 200, output: 800 },
        { model: 'o3', input: 200, output: 800 },
      ],
      google: [
        { model: 'gemini-2.5-pro', input: 125, output: 1000 },
        { model: 'gemini-2.5-flash', input: 30, output: 250 },
      ],
    };

    let count = 0;
    for (const s of sellers) {
      db.ensureUser(s.id, s.email);

      // Pick a reference model for pricing (first model of provider)
      const models = providerModels[s.provider];
      const refModel = models[0];
      const priceInput = Math.round(refModel.input * (1 - s.discount));
      const priceOutput = Math.round(refModel.output * (1 - s.discount));

      // Generate fake encrypted key (not a real key — just placeholder data)
      const fakeKey = `fake_${s.provider}_${crypto.randomBytes(16).toString('hex')}`;
      const { encrypted, iv, tag } = encrypt(fakeKey);

      // Randomize some usage to make it look lived-in
      const totalUsed = Math.floor(Math.random() * (s.capTotal || 50000000) * 0.4);
      const hourlyUsed = s.capHourly ? Math.floor(Math.random() * s.capHourly * 0.3) : 0;
      const dailyUsed = s.capDaily ? Math.floor(Math.random() * s.capDaily * 0.25) : 0;

      const keyId = crypto.randomUUID();
      db.addSellerKey.run({
        id: keyId,
        user_id: s.id,
        provider: s.provider,
        encrypted_key: encrypted,
        key_iv: iv,
        key_tag: tag,
        label: s.label,
        price_per_1m_input: priceInput,
        price_per_1m_output: priceOutput,
        spending_cap_cents: null,
        models_allowed: null,
        optimization_mode: s.mode,
        token_cap_total: s.capTotal,
        token_cap_hourly: s.capHourly,
        token_cap_daily: s.capDaily,
        rate_limit_hourly_cents: null,
        rate_limit_daily_cents: null,
        key_verified: s.verified,
      });

      // Set usage stats
      db.db.prepare('UPDATE seller_keys SET total_tokens_used = ?, hourly_tokens_used = ?, daily_tokens_used = ? WHERE id = ?')
        .run(totalUsed, hourlyUsed, dailyUsed, keyId);

      count++;
    }

    res.json({ message: `Seeded ${count} realistic listings`, count });
  } catch (err) {
    console.error('[admin/seed-demo] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin cleanup
router.post('/admin/cleanup-demo', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_TEST_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const demoIds = db.db.prepare("SELECT id FROM users WHERE id LIKE 'user_%'").all().map(r => r.id);
    if (demoIds.length) {
      const placeholders = demoIds.map(() => '?').join(',');
      db.db.prepare(`DELETE FROM transactions WHERE buyer_id IN (${placeholders}) OR seller_id IN (${placeholders})`).run(...demoIds, ...demoIds);
      db.db.prepare(`DELETE FROM buyer_keys WHERE user_id IN (${placeholders})`).run(...demoIds);
      db.db.prepare(`DELETE FROM seller_keys WHERE user_id IN (${placeholders})`).run(...demoIds);
      db.db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...demoIds);
    }
    res.json({ message: `Cleaned up ${demoIds.length} demo users` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { router, requireAuth, COMMISSION_PERCENT, PROVIDER_LIST_PRICES };
