/**
 * airwallex.js — Airwallex integration for WeChat Pay + Alipay subscriptions
 *
 * Strategy:
 *   - Stripe handles card/Link payments (30-day free trial ✓)
 *   - Airwallex handles WeChat Pay + Alipay (30-day free trial ✓ via trial_period_days)
 *
 * Airwallex supports:
 *   - True recurring WeChat Pay + Alipay subscriptions
 *   - 30-day free trials with payment method collected upfront
 *   - Automatic retry / dunning on failed payments
 *   - Webhook-based license activation (same pattern as Stripe + Paddle)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO WIRE INTO server.js (do this after testing):
 *
 *   const airwallexModule = require('./airwallex');
 *   airwallexModule.licenseCache = licenseCache;  // inject shared cache
 *   app.use(airwallexModule.router);               // mount routes
 *
 * Also update landing/index.html doCheckout() to add:
 *   const isAirwallex = paymentMethod === 'wechat_pay' || paymentMethod === 'alipay';
 *   const endpoint = isAirwallex ? '/api/airwallex/checkout' : '/api/checkout';
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Required env vars:
 *   AIRWALLEX_CLIENT_ID       — from Airwallex dashboard → API Keys
 *   AIRWALLEX_API_KEY         — from Airwallex dashboard → API Keys
 *   AIRWALLEX_WEBHOOK_SECRET  — from Airwallex dashboard → Webhooks
 *   AIRWALLEX_ENV             — 'demo' (sandbox) or 'production'
 *   AIRWALLEX_PLAN_PRO        — Plan ID for Pro tier (create once via /setup-plans)
 *   AIRWALLEX_PLAN_PREMIUM    — Plan ID for Premium tier
 */

const express = require('express');
const crypto  = require('crypto');

const router = express.Router();

// ── Config ──────────────────────────────────────────────────────────────────

const IS_SANDBOX = process.env.AIRWALLEX_ENV !== 'production';
const BASE_URL   = IS_SANDBOX
  ? 'https://api-demo.airwallex.com'
  : 'https://api.airwallex.com';

const TRIAL_DAYS = 30;

const PLANS = {
  pro:     process.env.AIRWALLEX_PLAN_PRO,
  premium: process.env.AIRWALLEX_PLAN_PREMIUM,
};

// ── Auth token cache (Airwallex tokens expire every 30 min) ─────────────────

let _tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  // Refresh 60s before expiry
  if (_tokenCache.token && _tokenCache.expiresAt > now + 60_000) {
    return _tokenCache.token;
  }

  const res = await fetch(`${BASE_URL}/api/v1/authentication/login`, {
    method: 'POST',
    headers: {
      'x-client-id': process.env.AIRWALLEX_CLIENT_ID,
      'x-api-key':   process.env.AIRWALLEX_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airwallex auth failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  // expires_at is ISO string, e.g. "2025-01-01T00:30:00+0000"
  _tokenCache = {
    token:     data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };

  console.log('[airwallex] authenticated, token expires:', data.expires_at);
  return _tokenCache.token;
}

// ── Generic API helper ───────────────────────────────────────────────────────

async function awx(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Airwallex ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── Unique request ID (idempotency key) ─────────────────────────────────────

function reqId() {
  return `terse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── One-time setup: create subscription plans ────────────────────────────────
// Call GET /api/airwallex/setup-plans once after deploying to create the two
// plans in Airwallex. Copy the returned plan IDs to env vars.
// Do NOT call in production more than once — plans persist in Airwallex.

router.get('/api/airwallex/setup-plans', async (req, res) => {
  try {
    const plans = await Promise.all([
      awx('POST', '/api/v1/pa/subscriptions/plans', {
        request_id:        reqId(),
        name:              'Terse Pro',
        currency:          'USD',
        interval:          'month',
        interval_count:    1,
        trial_period_days: TRIAL_DAYS,
        items: [{ name: 'Terse Pro Monthly', amount: 499 }], // amount in cents
      }),
      awx('POST', '/api/v1/pa/subscriptions/plans', {
        request_id:        reqId(),
        name:              'Terse Premium',
        currency:          'USD',
        interval:          'month',
        interval_count:    1,
        trial_period_days: TRIAL_DAYS,
        items: [{ name: 'Terse Premium Monthly', amount: 9900 }], // $99.00
      }),
    ]);

    res.json({
      message: 'Plans created. Copy these IDs to env vars.',
      AIRWALLEX_PLAN_PRO:     plans[0].id,
      AIRWALLEX_PLAN_PREMIUM: plans[1].id,
    });

    console.log('[airwallex/setup-plans] Pro:', plans[0].id, 'Premium:', plans[1].id);

  } catch (err) {
    console.error('[airwallex/setup-plans] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/airwallex/checkout ─────────────────────────────────────────────
// Creates a hosted Airwallex checkout URL for WeChat Pay or Alipay subscription.
// The frontend redirects the user there; Airwallex collects the payment method
// and starts the subscription with a 30-day free trial.

router.post('/api/airwallex/checkout', async (req, res) => {
  try {
    const { tier, clerkUserId, clerkUserEmail, paymentMethod } = req.body;

    if (!tier || !clerkUserId || !clerkUserEmail) {
      return res.status(400).json({ error: 'Missing tier, clerkUserId, or clerkUserEmail' });
    }

    const planId = PLANS[tier];
    if (!planId) {
      return res.status(400).json({ error: `Airwallex plan not configured for tier: ${tier}` });
    }

    const baseUrl = process.env.APP_URL || 'https://www.terseai.org';

    // Step 1 — find or create Airwallex customer
    const customer = await findOrCreateCustomer(clerkUserId, clerkUserEmail);

    // Step 2 — create hosted subscription checkout
    // payment_method_types controls which methods Airwallex shows.
    // Supported values: 'wechatpay', 'alipayhk', 'alipay_cn'
    const allowedMethods = resolvePaymentMethods(paymentMethod);

    const subscription = await awx('POST', '/api/v1/pa/subscriptions', {
      request_id:          reqId(),
      customer_id:         customer.id,
      plan_id:             planId,
      currency:            'USD',
      payment_method_types: allowedMethods,
      return_url:          `${baseUrl}/?checkout=success&tier=${tier}&via=airwallex`,
      cancel_url:          `${baseUrl}/?checkout=cancelled`,
      metadata: {
        clerk_user_id: clerkUserId,
        tier,
      },
    });

    // Airwallex returns a hosted checkout URL in subscription.checkout_url
    const checkoutUrl = subscription.checkout_url;
    if (!checkoutUrl) {
      throw new Error('Airwallex did not return a checkout_url. Check plan and payment method config.');
    }

    console.log(`[airwallex] created subscription ${subscription.id} for ${clerkUserId} tier=${tier}`);
    res.json({ url: checkoutUrl, subscriptionId: subscription.id });

  } catch (err) {
    console.error('[airwallex/checkout] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/airwallex/webhook ──────────────────────────────────────────────
// Airwallex sends subscription lifecycle events here.
// Register this URL in Airwallex dashboard → Webhooks.

router.post('/api/airwallex/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature  = req.headers['x-signature'];
    const timestamp  = req.headers['x-timestamp'];
    const webhookSecret = process.env.AIRWALLEX_WEBHOOK_SECRET;

    // Verify signature: HMAC-SHA256 of (timestamp + "." + rawBody)
    if (webhookSecret) {
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${req.body.toString()}`)
        .digest('hex');

      if (signature !== expected) {
        console.error('[airwallex/webhook] signature mismatch');
        return res.status(400).send('Invalid signature');
      }
    }

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    console.log(`[airwallex/webhook] ${event.name}`);

    const licenseCache = module.exports.licenseCache;

    try {
      switch (event.name) {

        // ── Subscription activated (trial started or first payment succeeded) ──
        case 'subscription.ACTIVE': {
          const sub = event.data;
          const clerkUserId = sub.metadata?.clerk_user_id;
          const tier        = sub.metadata?.tier;

          if (clerkUserId && tier) {
            const isTrialing = sub.status === 'TRIALING';
            licenseCache.set(clerkUserId, {
              tier,
              airwallexSubscriptionId: sub.id,
              airwallexCustomerId:     sub.customer_id,
              provider:   'airwallex',
              status:     isTrialing ? 'trialing' : 'active',
              expiresAt:  sub.current_period_end_at || null,
              trialEnd:   sub.trial_end_at || null,
            });
            console.log(`[airwallex/license] activated ${tier} for ${clerkUserId} (${sub.status})`);
          }
          break;
        }

        // ── Subscription renewed (recurring payment succeeded) ──
        case 'subscription.RENEWED': {
          const sub = event.data;
          const clerkUserId = sub.metadata?.clerk_user_id;
          const tier        = sub.metadata?.tier;

          if (clerkUserId) {
            const existing = licenseCache.get(clerkUserId) || {};
            licenseCache.set(clerkUserId, {
              ...existing,
              tier:      tier || existing.tier,
              provider:  'airwallex',
              status:    'active',
              expiresAt: sub.current_period_end_at || null,
            });
            console.log(`[airwallex/license] renewed for ${clerkUserId}`);
          }
          break;
        }

        // ── Subscription cancelled ──
        case 'subscription.CANCELLED': {
          const sub = event.data;
          const clerkUserId = sub.metadata?.clerk_user_id;

          if (clerkUserId) {
            licenseCache.set(clerkUserId, {
              tier:                    'expired',
              airwallexSubscriptionId: sub.id,
              provider:  'airwallex',
              status:    'cancelled',
              expiresAt: null,
            });
            console.log(`[airwallex/license] cancelled for ${clerkUserId}`);
          }
          break;
        }

        // ── Payment past due ──
        case 'subscription.PAST_DUE': {
          const sub = event.data;
          const clerkUserId = sub.metadata?.clerk_user_id;

          if (clerkUserId && licenseCache.has(clerkUserId)) {
            const existing = licenseCache.get(clerkUserId);
            licenseCache.set(clerkUserId, { ...existing, status: 'past_due' });
            console.log(`[airwallex/license] past_due for ${clerkUserId}`);
          }
          break;
        }

        // ── Individual payment attempt succeeded ──
        case 'payment_attempt.SUCCESS': {
          const attempt    = event.data;
          const clerkUserId = attempt.metadata?.clerk_user_id;

          if (clerkUserId && licenseCache.has(clerkUserId)) {
            const existing = licenseCache.get(clerkUserId);
            licenseCache.set(clerkUserId, { ...existing, status: 'active' });
            console.log(`[airwallex/license] payment confirmed for ${clerkUserId}`);
          }
          break;
        }

        // ── Individual payment attempt failed ──
        case 'payment_attempt.FAILED': {
          const attempt    = event.data;
          const clerkUserId = attempt.metadata?.clerk_user_id;

          if (clerkUserId && licenseCache.has(clerkUserId)) {
            const existing = licenseCache.get(clerkUserId);
            licenseCache.set(clerkUserId, { ...existing, status: 'past_due' });
            console.log(`[airwallex/license] payment failed for ${clerkUserId}`);
          }
          break;
        }

        default:
          // Ignore unhandled event types
          break;
      }
    } catch (err) {
      console.error('[airwallex/webhook] processing error:', err);
    }

    res.json({ received: true });
  }
);

// ── POST /api/airwallex/cancel ───────────────────────────────────────────────
// Cancel an Airwallex subscription immediately.

router.post('/api/airwallex/cancel', async (req, res) => {
  try {
    const { clerkUserId } = req.body;
    const licenseCache = module.exports.licenseCache;
    const license = licenseCache.get(clerkUserId);

    if (!license?.airwallexSubscriptionId) {
      return res.status(404).json({ error: 'No Airwallex subscription found' });
    }

    await awx('POST', `/api/v1/pa/subscriptions/${license.airwallexSubscriptionId}/cancel`, {
      request_id: reqId(),
    });

    licenseCache.set(clerkUserId, {
      ...license,
      tier:     'expired',
      status:   'cancelled',
    });

    console.log(`[airwallex] cancelled subscription for ${clerkUserId}`);
    res.json({ cancelled: true });

  } catch (err) {
    console.error('[airwallex/cancel] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findOrCreateCustomer(clerkUserId, email) {
  // Search existing customers by merchant_customer_id
  try {
    const search = await awx('GET', `/api/v1/pa/customers?merchant_customer_id=${encodeURIComponent(clerkUserId)}`);
    if (search.items?.length > 0) {
      return search.items[0];
    }
  } catch {
    // Ignore search errors — fall through to create
  }

  // Create new customer
  return awx('POST', '/api/v1/pa/customers/create', {
    request_id:           reqId(),
    merchant_customer_id: clerkUserId,
    email,
  });
}

// Map frontend paymentMethod values to Airwallex method types
function resolvePaymentMethods(paymentMethod) {
  if (paymentMethod === 'wechat_pay') return ['wechatpay'];
  if (paymentMethod === 'alipay')     return ['alipayhk', 'alipay_cn'];
  // Default: offer both
  return ['wechatpay', 'alipayhk', 'alipay_cn'];
}

// License cache reference — injected by server.js after init
module.exports = { router, licenseCache: null };
