/**
 * paddle.js — Paddle Billing integration for WeChat Pay + Alipay subscriptions
 *
 * Strategy:
 *   - Stripe handles card/Link payments (30-day free trial ✓)
 *   - Paddle handles WeChat Pay + Alipay (30-day free trial ✓ via Paddle Billing)
 *
 * Paddle supports:
 *   - True recurring WeChat Pay + Alipay subscriptions
 *   - 30-day free trials with payment method collected upfront
 *   - Automatic retry / dunning on failed payments
 *   - Webhook-based license activation (same pattern as Stripe)
 */

const { Paddle, Environment, EventName } = require('@paddle/paddle-node-sdk');
const express = require('express');

const router = express.Router();

// ── Paddle client ──
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENV === 'sandbox'
    ? Environment.sandbox
    : Environment.production,
});

// Paddle Price IDs — set after creating products in Paddle dashboard
const PADDLE_PRICES = {
  pro:     process.env.PADDLE_PRICE_PRO,     // e.g. pri_01abc...
  premium: process.env.PADDLE_PRICE_PREMIUM, // e.g. pri_01xyz...
};

const TRIAL_DAYS = 30;

// ── Create Paddle checkout for WeChat Pay / Alipay ──
// Returns a Paddle-hosted checkout URL
router.post('/api/paddle/checkout', async (req, res) => {
  try {
    const { tier, clerkUserId, clerkUserEmail } = req.body;

    if (!tier || !clerkUserId || !clerkUserEmail) {
      return res.status(400).json({ error: 'Missing tier, clerkUserId, or clerkUserEmail' });
    }

    const priceId = PADDLE_PRICES[tier];
    if (!priceId) {
      return res.status(400).json({ error: `Invalid tier or Paddle price not configured for: ${tier}` });
    }

    const baseUrl = process.env.APP_URL || 'https://www.terseai.org';

    // Create a Paddle checkout transaction
    // Paddle will show WeChat Pay + Alipay as payment options automatically
    // based on the customer's location / Paddle account settings
    const transaction = await paddle.transactions.create({
      items: [
        {
          priceId,
          quantity: 1,
        },
      ],
      customData: {
        clerk_user_id: clerkUserId,
        tier,
      },
      customer: {
        email: clerkUserEmail,
      },
      // 30-day free trial — Paddle collects payment method upfront,
      // charges after trial ends automatically
      // Note: trial is configured on the Price in Paddle dashboard.
      // If the Price has a trial, it will apply automatically.
      successUrl: `${baseUrl}/?checkout=success&tier=${tier}&via=paddle`,
    });

    // The checkout URL to redirect user to
    const checkoutUrl = `https://checkout.paddle.com/checkout/custom/${transaction.id}`;

    console.log(`[paddle] created checkout ${transaction.id} for ${clerkUserId} tier=${tier}`);
    res.json({ url: checkoutUrl, transactionId: transaction.id });

  } catch (err) {
    console.error('[paddle/checkout] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Paddle Webhook Handler ──
// Listens for subscription lifecycle events and updates the license cache
router.post('/api/paddle/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['paddle-signature'];
    const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;

    let event;
    try {
      if (webhookSecret) {
        // Verify webhook signature
        event = paddle.webhooks.unmarshal(req.body.toString(), webhookSecret, signature);
      } else {
        event = JSON.parse(req.body.toString());
      }
    } catch (err) {
      console.error('[paddle/webhook] signature error:', err.message);
      return res.status(400).send('Webhook signature verification failed');
    }

    console.log(`[paddle/webhook] ${event.eventType}`);

    try {
      // Get the shared license cache from the main server
      // (injected via module.exports.setLicenseCache below)
      const licenseCache = module.exports.licenseCache;

      switch (event.eventType) {

        // ── Subscription activated (trial started or first payment succeeded) ──
        case EventName.SubscriptionActivated: {
          const sub = event.data;
          const clerkUserId = sub.customData?.clerk_user_id;
          const tier = sub.customData?.tier;

          if (clerkUserId && tier) {
            const trialEnd = sub.currentBillingPeriod?.trialEndAt || null;
            licenseCache.set(clerkUserId, {
              tier,
              paddleSubscriptionId: sub.id,
              paddleCustomerId: sub.customerId,
              provider: 'paddle',
              status: sub.status === 'trialing' ? 'trialing' : 'active',
              expiresAt: sub.currentBillingPeriod?.endsAt || null,
              trialEnd,
            });
            console.log(`[paddle/license] activated ${tier} for ${clerkUserId} (${sub.status})`);
          }
          break;
        }

        // ── Subscription updated (renewal, plan change, etc.) ──
        case EventName.SubscriptionUpdated: {
          const sub = event.data;
          const clerkUserId = sub.customData?.clerk_user_id;
          const tier = sub.customData?.tier;

          if (clerkUserId) {
            // Determine tier from price if not in customData
            const resolvedTier = tier || resolveTierFromPrices(sub.items);

            // Immediate cancel: revoke access now
            if (sub.scheduledChange?.action === 'cancel' || sub.status === 'canceled') {
              licenseCache.set(clerkUserId, {
                tier: 'expired',
                paddleSubscriptionId: sub.id,
                provider: 'paddle',
                status: 'cancelled',
                expiresAt: null,
              });
              console.log(`[paddle/license] cancelled for ${clerkUserId}`);
              break;
            }

            const existing = licenseCache.get(clerkUserId) || {};
            licenseCache.set(clerkUserId, {
              ...existing,
              tier: resolvedTier,
              paddleSubscriptionId: sub.id,
              paddleCustomerId: sub.customerId,
              provider: 'paddle',
              status: sub.status,
              expiresAt: sub.currentBillingPeriod?.endsAt || null,
              trialEnd: sub.currentBillingPeriod?.trialEndAt || null,
            });
            console.log(`[paddle/license] updated ${resolvedTier} (${sub.status}) for ${clerkUserId}`);
          }
          break;
        }

        // ── Subscription cancelled ──
        case EventName.SubscriptionCanceled: {
          const sub = event.data;
          const clerkUserId = sub.customData?.clerk_user_id;

          if (clerkUserId) {
            licenseCache.set(clerkUserId, {
              tier: 'expired',
              paddleSubscriptionId: sub.id,
              provider: 'paddle',
              status: 'cancelled',
              expiresAt: null,
            });
            console.log(`[paddle/license] canceled for ${clerkUserId}`);
          }
          break;
        }

        // ── Payment succeeded (renewal) ──
        case EventName.TransactionCompleted: {
          const txn = event.data;
          const clerkUserId = txn.customData?.clerk_user_id;
          const tier = txn.customData?.tier;

          if (clerkUserId && tier && txn.subscriptionId) {
            // Update status to active on successful renewal payment
            const existing = licenseCache.get(clerkUserId) || {};
            licenseCache.set(clerkUserId, {
              ...existing,
              tier,
              provider: 'paddle',
              status: 'active',
            });
            console.log(`[paddle/license] payment confirmed for ${clerkUserId} tier=${tier}`);
          }
          break;
        }

        // ── Payment failed ──
        case EventName.TransactionPaymentFailed: {
          const txn = event.data;
          const clerkUserId = txn.customData?.clerk_user_id;

          if (clerkUserId && licenseCache.has(clerkUserId)) {
            const existing = licenseCache.get(clerkUserId);
            licenseCache.set(clerkUserId, { ...existing, status: 'past_due' });
            console.log(`[paddle/license] payment failed for ${clerkUserId}`);
          }
          break;
        }

        default:
          // Ignore unhandled event types
          break;
      }
    } catch (err) {
      console.error('[paddle/webhook] processing error:', err);
    }

    res.json({ received: true });
  }
);

// ── Cancel a Paddle subscription immediately ──
router.post('/api/paddle/cancel', async (req, res) => {
  try {
    const { clerkUserId } = req.body;
    const licenseCache = module.exports.licenseCache;
    const license = licenseCache.get(clerkUserId);

    if (!license?.paddleSubscriptionId) {
      return res.status(404).json({ error: 'No Paddle subscription found' });
    }

    await paddle.subscriptions.cancel(license.paddleSubscriptionId, {
      effectiveFrom: 'immediately',
    });

    licenseCache.set(clerkUserId, {
      ...license,
      tier: 'expired',
      status: 'cancelled',
    });

    console.log(`[paddle] cancelled subscription for ${clerkUserId}`);
    res.json({ cancelled: true });

  } catch (err) {
    console.error('[paddle/cancel] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: resolve tier from Paddle subscription items ──
function resolveTierFromPrices(items) {
  if (!items?.length) return 'expired';
  const priceId = items[0]?.price?.id;
  if (priceId === PADDLE_PRICES.pro) return 'pro';
  if (priceId === PADDLE_PRICES.premium) return 'premium';
  return 'expired';
}

// License cache reference — set by server.js after init
module.exports = { router, licenseCache: null };
