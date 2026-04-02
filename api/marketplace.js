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

router.post('/seller/keys', requireAuth, (req, res) => {
  const { provider, apiKey, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, models_allowed, optimization_mode } = req.body;

  if (!provider || !apiKey) return res.status(400).json({ error: 'Missing provider or apiKey' });
  if (!['anthropic', 'openai', 'google'].includes(provider)) return res.status(400).json({ error: 'Invalid provider. Use: anthropic, openai, google' });
  if (!price_per_1m_input || !price_per_1m_output) return res.status(400).json({ error: 'Missing pricing' });

  const validModes = ['off', 'soft', 'normal', 'aggressive'];
  const mode = validModes.includes(optimization_mode) ? optimization_mode : 'normal';

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
  });

  // Notify seller
  notifications.notifyKeyListed(req.userId, provider);

  res.json({ id, message: 'Key added successfully' });
});

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
    ...earnings,
    recent_transactions: recent,
  });
});

// Request payout
router.post('/seller/withdraw', requireAuth, (req, res) => {
  const user = db.getUser.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const amount = req.body.amount_cents || user.seller_balance_cents;
  if (amount <= 0) return res.status(400).json({ error: 'Nothing to withdraw' });
  if (amount > user.seller_balance_cents) return res.status(400).json({ error: 'Insufficient balance' });

  // Min payout $5
  if (amount < 500) return res.status(400).json({ error: 'Minimum withdrawal is $5.00' });

  const payoutId = crypto.randomUUID();
  db.debitSellerBalance.run(amount, req.userId);
  db.addPayout.run({ id: payoutId, user_id: req.userId, amount_cents: amount, status: 'pending' });

  notifications.notifyWithdrawal(req.userId, amount);
  res.json({ payout_id: payoutId, amount_cents: amount, status: 'pending', message: 'Payout requested. Processing within 3-5 business days.' });
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
    const baseUrl = process.env.APP_URL || 'https://www.terseai.org';

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

module.exports = { router, requireAuth, COMMISSION_PERCENT, PROVIDER_LIST_PRICES };
