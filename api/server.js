const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Railway runs behind a reverse proxy
const PORT = process.env.PORT || 3000;

// Marketplace modules
const { router: marketplaceRouter } = require('./marketplace');
const proxyRouter = require('./proxy');
const cloudRouter = require('./cloud');
const coworkRouter = require('./cowork');
const docsRouter = require('./docs');
const mcpRouter = require('./mcp');
const terseApiRouter = require('./terse-api');
const db = require('./db');

// Paddle module (WeChat Pay + Alipay recurring)
const paddleModule = require('./paddle');

// Trial-recovery emails (24h + 72h) — inert unless RECOVERY_EMAILS_ENABLED=1
const recovery = require('./recovery');

// Stripe setup
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Clerk publishable key (for frontend)
const CLERK_PK = process.env.CLERK_PUBLISHABLE_KEY || 'pk_live_Y2xlcmsudGVyc2VhaS5vcmck';
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;

// ── macOS app price IDs (30-day free trial, separate from API) ────────────
const PRICES = {
  pro:           process.env.STRIPE_PRICE_PRO           || 'price_1THjoHGf9QijP49FBJr4407W',
  premium:       process.env.STRIPE_PRICE_PREMIUM       || 'price_1TAMciGf9QijP49FHTr9DuAB',
  // Pro at alternate billing intervals — SAME entitlement as `pro`, but NO free trial
  // (charged immediately). Created 2026-07-14 on prod_U8drXX5M1uvwAG (Terse Pro).
  pro_weekly:    process.env.STRIPE_PRICE_PRO_WEEKLY    || 'price_1Tt8IOGf9QijP49FxEK0RhMU',
  pro_quarterly: process.env.STRIPE_PRICE_PRO_QUARTERLY || 'price_1Tt8IOGf9QijP49FGmGijaYV',
  // Annual ($15.99/yr) and lifetime ($25.99 one-time). No hardcoded fallback on
  // purpose: these must be created in Stripe first, and a wrong price id would
  // silently charge the wrong amount. Missing env → checkout fails loudly below.
  pro_annual:    process.env.STRIPE_PRICE_PRO_ANNUAL    || '',
  pro_lifetime:  process.env.STRIPE_PRICE_PRO_LIFETIME  || '',
};

// Billing-interval aliases that grant the same entitlement as monthly Pro.
const PRO_INTERVAL_TIERS = new Set(['pro_weekly', 'pro_quarterly', 'pro_annual', 'pro_lifetime']);
const normalizeTier = (t) => (PRO_INTERVAL_TIERS.has(t) ? 'pro' : t);
// Lifetime is a ONE-TIME payment, so Stripe Checkout runs in 'payment' mode and no
// subscription is ever created. Everything downstream keys off this predicate.
const isLifetime = (t) => t === 'pro_lifetime';

// Free trial length per plan. Monthly/Premium get 30 days, weekly gets 7 (one billing
// period) so the trial never outlasts the interval it precedes. Quarterly charges now.
const TRIAL_DAYS_BY_TIER = { pro: 30, premium: 30, pro_weekly: 7 };
const trialDaysFor = (t) => TRIAL_DAYS_BY_TIER[t] || 0;
const TIER_OFFERS_TRIAL = (t) => trialDaysFor(t) > 0;

// ── API price IDs (NO free trial — pay immediately, separate product) ─────
const API_PRICES = {
  api_pro: process.env.STRIPE_API_PRICE_PRO || 'price_1Tc5rbGf9QijP49FQTiQ77Br',
};

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
// Maps clerkUserId -> { tier, stripeCustomerId/paddleCustomerId, subscriptionId, status, expiresAt, provider }
const licenseCache = new Map();

// Share the license cache with Paddle module so both can read/write it
paddleModule.licenseCache = licenseCache;

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
        // Handle pet unlock purchase
        if (session.metadata?.type === 'pet_unlock') {
          const userId = session.metadata.clerk_user_id;
          const petId = session.metadata.pet_id;
          if (userId && petId) {
            db.ensureUser(userId);
            db.addPetPurchase.run({ id: require('crypto').randomUUID(), user_id: userId, pet_id: petId, stripe_session_id: session.id });
            console.log(`[pets] unlocked pet ${petId} for ${userId}`);
          }
          break;
        }
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
          if (tier === 'api_pro') {
            // ── API subscription — update api_tier only, do NOT touch app tier ──
            db.ensureUser(clerkUserId);
            db.updateApiTier.run('api_pro', session.subscription, session.customer, clerkUserId);
            console.log(`[api-license] activated api_pro for ${clerkUserId}`);
          } else {
            // ── App subscription — update app tier only, do NOT touch api_tier ──
            licenseCache.set(clerkUserId, {
              tier,
              stripeCustomerId: session.customer,
              subscriptionId: session.subscription,
              status: 'active',
              expiresAt: null,
            });
            db.ensureUser(clerkUserId);
            db.updateUserTier.run(tier, session.subscription, session.customer, 'active', null, clerkUserId);
            // Lifetime leaves no subscription behind, so persist a durable flag —
            // without it the next license check finds no active sub and expires them.
            if (session.metadata?.plan === 'pro_lifetime') {
              db.setLifetime.run(new Date().toISOString(), session.payment_intent || null, clerkUserId);
              console.log(`[license] LIFETIME recorded for ${clerkUserId} (pi=${session.payment_intent})`);
            }
            console.log(`[license] activated ${tier} for ${clerkUserId}`);
            // Dual-sided referral: reward the referrer now that this referee paid.
            creditReferrerOnConversion(clerkUserId);
          }
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
        // Lifetime bought with WeChat/Alipay arrives as a STANDALONE invoice with no
        // subscription. Without this branch the money lands and access never does.
        if (!invoice.subscription && invoice.metadata?.plan === 'pro_lifetime') {
          const uid = invoice.metadata.clerk_user_id;
          if (uid) {
            db.ensureUser(uid);
            db.updateUserTier.run('pro', null, invoice.customer, 'active', null, uid);
            db.setLifetime.run(new Date().toISOString(), invoice.payment_intent || invoice.id, uid);
            licenseCache.delete(uid);
            console.log(`[license] LIFETIME via invoice ${invoice.id} for ${uid}`);
            creditReferrerOnConversion(uid);
          } else {
            console.error(`[license] lifetime invoice ${invoice.id} paid but has no clerk_user_id metadata`);
          }
          break;
        }
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

  // Determine tier from price ID
  const priceId = sub.items?.data?.[0]?.price?.id;
  const LEGACY_PRO_PRICE = 'price_1TAMb6Gf9QijP49FKhRQYUSf';

  // ── API subscription? Handle separately, don't touch app tier ──
  const isApiSubscription = Object.values(API_PRICES).includes(priceId);
  if (isApiSubscription) {
    const apiTier = priceId === API_PRICES.api_pro ? 'api_pro' : 'free';
    const isCancelled = sub.cancel_at_period_end || sub.status === 'canceled' || sub.status === 'cancelled';
    try {
      db.ensureUser(clerkUserId);
      db.updateApiTier.run(isCancelled ? 'free' : apiTier, isCancelled ? null : sub.id, sub.customer, clerkUserId);
    } catch (e) { console.error('[api-license] db sync failed:', e.message); }
    console.log(`[api-license] synced ${isCancelled ? 'free (cancelled)' : apiTier} for ${clerkUserId}`);
    return;
  }

  // ── App subscription ──
  let tier = 'expired';
  const proPriceIds = [PRICES.pro, LEGACY_PRO_PRICE, PRICES.pro_weekly, PRICES.pro_quarterly,
                       PRICES.pro_annual].filter(Boolean);
  if (proPriceIds.includes(priceId)) tier = 'pro';
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

  const expiresAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  licenseCache.set(clerkUserId, {
    tier,
    stripeCustomerId: sub.customer,
    subscriptionId: sub.id,
    status: effectiveStatus,
    expiresAt,
    trialEnd,
  });
  // Persist tier to DB so tsk_... developer keys get updated rate limits without restart
  try {
    db.ensureUser(clerkUserId);
    const dbTier = effectiveStatus === 'active' || effectiveStatus === 'trialing' ? tier : 'free';
    db.updateUserTier.run(dbTier, sub.id, sub.customer, effectiveStatus, expiresAt, clerkUserId);
  } catch (e) { console.error('[license] db tier sync failed:', e.message); }
  console.log(`[license] synced ${tier} (${effectiveStatus}) for ${clerkUserId}${trialEnd ? ' trial until ' + trialEnd : ''}`);
}

// JSON body for all other routes. Docs ops can carry Univer sheet snapshots
// (styles, merges, col widths…) which exceed the 100kb default by far.
app.use('/api/docs', express.json({ limit: '6mb' }));
app.use(express.json());

// CORS for Tauri app + marketplace.
// Every custom request header the app sends MUST be listed below. A missing one
// is invisible server-side — the browser rejects the preflight itself, the real
// request is never sent, and the app only sees "Load failed". api/cors.test.js
// checks this list against the headers the renderer actually sets.
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, x-terse-team-token, x-terse-user-email, x-terse-doc-token, x-terse-room-key, x-terse-identity, x-terse-device');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Create Checkout Session ──
app.post('/api/checkout', async (req, res) => {
  try {
    const { tier, clerkUserId, clerkUserEmail, noTrial } = req.body;
    if (!tier || !clerkUserId) {
      return res.status(400).json({ error: 'Missing tier or clerkUserId' });
    }

    // Distinguish "no such plan" from "plan exists but has no Stripe price yet".
    // Both used to surface as "Invalid tier", which sent you hunting through the
    // client for a typo when the real cause was an unset env var.
    if (!(tier in PRICES)) {
      return res.status(400).json({ error: `Invalid tier: ${tier}` });
    }
    const priceId = PRICES[tier];
    if (!priceId) {
      const envVar = `STRIPE_PRICE_${tier.toUpperCase()}`;
      console.error(`[checkout] ${tier} requested but ${envVar} is unset`);
      return res.status(503).json({
        error: `The ${tier} plan isn't available yet — ${envVar} is not configured on the server.`,
        code: 'price_not_configured',
      });
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

    // WeChat Pay / Alipay: one-time payment (no free trial, ever).
    const paymentMethod = req.body.paymentMethod; // 'wechat_pay', 'alipay', or undefined
    const isChinaPay = paymentMethod === 'wechat_pay' || paymentMethod === 'alipay';

    // Lifetime over WeChat/Alipay goes through a STANDALONE invoice (below), never
    // the subscription branch — a subscription against the one-time price would
    // re-bill forever. Yearly keeps the subscription path so it re-invoices annually.

    // ── Trial abuse prevention ──
    // Only the monthly Pro plan offers a free trial. Weekly/quarterly (and direct
    // subscribe / China pay) charge immediately, so they skip the trial-used check.
    // Monthly Pro and Premium offer the 30-day trial; weekly/quarterly charge immediately.
    const offersTrial = !noTrial && !isChinaPay && TIER_OFFERS_TRIAL(tier);
    if (offersTrial) {
      const allEmailCustomers = await stripe.customers.list({ email: clerkUserEmail, limit: 10 });
      for (const c of allEmailCustomers.data) {
        const prevSubs = await stripe.subscriptions.list({ customer: c.id, limit: 10, status: 'all' });
        // Only count it as "trial used" if a trial was actually granted, or the
        // user currently has a live subscription. Canceled/past_due/unpaid subs
        // that never received a trial (e.g. an unpaid WeChat/Alipay invoice) must
        // NOT block the card free trial the user never actually used.
        const usedTrial = prevSubs.data.some(s =>
          s.trial_end != null ||
          ['trialing', 'active'].includes(s.status)
        );
        if (usedTrial) {
          console.log(`[checkout] trial already used for email ${clerkUserEmail} (customer ${c.id})`);
          return res.status(400).json({ error: 'trial_already_used', message: 'A free trial has already been used for this account.' });
        }
      }
    }

    if (isChinaPay && isLifetime(tier)) {
      // ── Lifetime via WeChat/Alipay: a standalone one-time invoice ─────────────
      // Not a subscription — nothing here may recur. Access is granted by the
      // invoice.payment_succeeded webhook, which reads the metadata set below.
      const openInvoices = await stripe.invoices.list({ customer: customerId, status: 'open', limit: 20 });
      const dupe = openInvoices.data.find(i => i.metadata?.plan === 'pro_lifetime');
      if (dupe?.hosted_invoice_url) {
        console.log(`[checkout] returning existing lifetime invoice for ${clerkUserId} inv=${dupe.id}`);
        return res.json({ url: dupe.hosted_invoice_url, sessionId: null });
      }

      let invoice = await stripe.invoices.create({
        customer: customerId,
        collection_method: 'send_invoice',
        days_until_due: 3,
        // The metadata lives on the INVOICE because there is no subscription to
        // hang it off — the webhook has nothing else to identify the buyer by.
        metadata: { clerk_user_id: clerkUserId, tier: 'pro', plan: 'pro_lifetime' },
        payment_settings: { payment_method_types: [paymentMethod] },
        description: paymentMethod === 'wechat_pay'
          ? 'Terse Pro 买断（一次性付款，永久使用，不会再次扣款）。\nTerse Pro lifetime — one-time payment, no subscription.'
          : 'Terse Pro 买断（一次性付款，永久使用，不会再次扣款）。\nTerse Pro lifetime — one-time payment, no subscription.',
      });
      // Attach the line item to THIS invoice explicitly, so a stray pending item
      // can never attach itself to an unrelated invoice.
      await stripe.invoiceItems.create({ customer: customerId, price: priceId, invoice: invoice.id });
      invoice = await stripe.invoices.finalizeInvoice(invoice.id);
      console.log(`[license] lifetime invoice (${paymentMethod}) ${invoice.id} for ${clerkUserId}`);
      return res.json({ url: invoice.hosted_invoice_url, sessionId: null });
    }

    if (isChinaPay) {
      // Guard: if customer already has an active/pending subscription, return its invoice URL
      // instead of creating a duplicate (prevents rapid double-click from creating multiple subs)
      const existingSubs = await stripe.subscriptions.list({ customer: customerId, limit: 5, status: 'all' });
      const pendingSub = existingSubs.data.find(s =>
        ['active', 'past_due', 'trialing', 'unpaid'].includes(s.status)
      );
      if (pendingSub) {
        const existingInvoices = await stripe.invoices.list({ subscription: pendingSub.id, limit: 1 });
        const existingInvoice = existingInvoices.data[0];
        if (existingInvoice?.hosted_invoice_url) {
          console.log(`[checkout] returning existing invoice for ${clerkUserId} sub=${pendingSub.id}`);
          return res.json({ url: existingInvoice.hosted_invoice_url, sessionId: null });
        }
      }

      // Create send_invoice subscription with NO trial — first invoice due immediately
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        collection_method: 'send_invoice',
        days_until_due: 3,
        metadata: { clerk_user_id: clerkUserId, tier: normalizeTier(tier) },
        payment_settings: {
          payment_method_types: [paymentMethod],
        },
      });

      // Don't activate yet — wait for invoice.paid webhook to confirm payment
      // Set as 'past_due' so app knows payment is pending
      licenseCache.set(clerkUserId, {
        tier: normalizeTier(tier),
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
              ? 'Terse Pro 订阅。免费试用仅支持银行卡支付，微信支付需直接付款。\nTerse Pro subscription. Free trial is only available with bank card payment.'
              : 'Terse Pro 订阅。免费试用仅支持银行卡支付，支付宝需直接付款。\nTerse Pro subscription. Free trial is only available with bank card payment.',
          });
          invoice = await stripe.invoices.finalizeInvoice(invoice.id);
        }
        invoiceUrl = invoice.hosted_invoice_url || invoiceUrl;
        console.log(`[license] invoice ${invoice.id} status=${invoice.status} url=${invoiceUrl}`);
      }

      res.json({ url: invoiceUrl, sessionId: null });
    } else {
      // Default: card/Link via Stripe Checkout (WeChat/Alipay use send_invoice path above)
      // Store the entitlement tier ('pro') in metadata so the webhook/DB never see the
      // billing-interval alias ('pro_weekly'/'pro_quarterly').
      const entTier = normalizeTier(tier);
      const subscriptionData = { metadata: { clerk_user_id: clerkUserId, tier: entTier } };
      // Free trial ($0 today) on monthly/premium (30d) and weekly (7d); quarterly charges now.
      const withTrial = !noTrial && TIER_OFFERS_TRIAL(tier);
      const trialDays = trialDaysFor(tier);
      if (withTrial) subscriptionData.trial_period_days = trialDays;
      // Reassure the buyer on Stripe's hosted page about what's due today.
      let custom_text;
      if (withTrial) {
        const after = tier === 'premium' ? '$99.00 USD/month'
                    : tier === 'pro_weekly' ? '$1.99 USD/week'
                    : '$4.99 USD/month';
        custom_text = { submit: { message: `$0.00 due today — your card is not charged until the ${trialDays}-day free trial ends. Then ${after}. Cancel anytime.` } };
      } else if (tier === 'pro_weekly') {
        custom_text = { submit: { message: '$1.99 USD billed weekly. Cancel anytime.' } };
      } else if (tier === 'pro_quarterly') {
        custom_text = { submit: { message: '$12.00 USD billed every 3 months (~$4/mo). Cancel anytime.' } };
      } else if (entTier === 'pro') {
        // Monthly without a trial (the post-trial subscribe gate, and WeChat/Alipay,
        // which can't carry a trial). Without this the page explains nothing.
        custom_text = { submit: { message: '$4.99 USD billed monthly. Cancel anytime.' } };
      } else if (tier === 'pro_annual') {
        custom_text = { submit: { message: '$15.99 USD billed yearly (~$1.33/mo). Cancel anytime.' } };
      } else if (isLifetime(tier)) {
        custom_text = { submit: { message: '$25.99 USD once. Yours forever — no subscription, nothing to cancel.' } };
      } else if (entTier === 'premium') {
        custom_text = { submit: { message: '$99.00 USD billed monthly. Cancel anytime.' } };
      }

      // (An unconfigured price is already rejected at the top of this handler.)
      const lifetime = isLifetime(tier);
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        // Lifetime is a one-off charge; everything else is recurring.
        mode: lifetime ? 'payment' : 'subscription',
        success_url: `${baseUrl}/?checkout=success&tier=${entTier}`,
        cancel_url: `${baseUrl}/?checkout=cancelled`,
        metadata: { clerk_user_id: clerkUserId, tier: entTier, plan: tier },
        // subscription_data is rejected in payment mode; carry the same metadata
        // on the payment intent instead so the webhook can attribute the purchase.
        ...(lifetime
          ? { payment_intent_data: { metadata: { clerk_user_id: clerkUserId, tier: entTier, plan: tier } } }
          : { subscription_data: subscriptionData }),
        ...(custom_text ? { custom_text } : {}),
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

// ── Terse API checkout (POST /api/api-checkout) ──────────────────────────
// Completely separate from /api/checkout (macOS app).
// No free trial. No WeChat/Alipay. Card only. Immediate billing.
app.post('/api/api-checkout', async (req, res) => {
  try {
    const { tier, clerkUserId, clerkUserEmail } = req.body || {};
    if (!tier || !clerkUserId) return res.status(400).json({ error: 'Missing tier or clerkUserId' });

    const priceId = API_PRICES[tier];
    if (!priceId) return res.status(400).json({ error: 'Invalid API tier: ' + tier });

    // Find or create Stripe customer (may share customer with app subscription — that is fine)
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
    // NO trial_period_days — API plans have no free trial
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${baseUrl}/dashboard?api_upgraded=1`,
      cancel_url:  `${baseUrl}/#api-pricing`,
      metadata: { clerk_user_id: clerkUserId, tier },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[api-checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard billing portal (POST /api/billing-portal) ──
app.post('/api/billing-portal', async (req, res) => {
  const { clerkUserId } = req.body || {};
  if (!clerkUserId) return res.status(400).json({ error: 'Missing clerkUserId' });
  try {
    let customerId = licenseCache.get(clerkUserId)?.stripeCustomerId;
    if (!customerId) {
      const user = db.getUser.get(clerkUserId);
      customerId = user?.stripe_customer_id;
    }
    if (!customerId) return res.status(404).json({ error: 'No billing account found. Subscribe first.' });
    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/dashboard`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pet Unlock (Stripe $1 one-time payment) ──

// Lazy-init: create the pet unlock product+price on first checkout if not set in env.
let petUnlockPriceId = process.env.STRIPE_PRICE_PET_UNLOCK || 'price_1TVvifGf9QijP49FNYBr6umS';
async function ensurePetUnlockPrice() {
  if (petUnlockPriceId) return petUnlockPriceId;
  // Search for existing product first
  const products = await stripe.products.search({ query: 'name:"Terse Pals – Pet Unlock"', limit: 1 });
  let productId;
  if (products.data.length > 0) {
    productId = products.data[0].id;
    const prices = await stripe.prices.list({ product: productId, active: true, limit: 1 });
    if (prices.data.length > 0) { petUnlockPriceId = prices.data[0].id; return petUnlockPriceId; }
  } else {
    const product = await stripe.products.create({ name: 'Terse Pals – Pet Unlock', description: 'Unlock one pet companion in Terse' });
    productId = product.id;
  }
  const price = await stripe.prices.create({ unit_amount: 100, currency: 'usd', product: productId });
  petUnlockPriceId = price.id;
  console.log(`[pets] created pet unlock price: ${petUnlockPriceId} — set STRIPE_PRICE_PET_UNLOCK=${petUnlockPriceId} to skip auto-create`);
  return petUnlockPriceId;
}

app.post('/api/pet-checkout', express.json(), async (req, res) => {
  try {
    const { petId, clerkUserId, clerkUserEmail } = req.body;
    if (!petId || !clerkUserId) return res.status(400).json({ error: 'Missing petId or clerkUserId' });

    const priceId = await ensurePetUnlockPrice();
    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    // Find or create customer
    let customerId;
    if (clerkUserEmail) {
      const existing = await stripe.customers.list({ email: clerkUserEmail, limit: 1 });
      if (existing.data.length > 0) customerId = existing.data[0].id;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: clerkUserEmail || undefined,
        metadata: { clerk_user_id: clerkUserId },
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { type: 'pet_unlock', clerk_user_id: clerkUserId, pet_id: petId },
      success_url: `${baseUrl}/pet-success.html?pet=${petId}`,
      cancel_url: `${baseUrl}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[pet-checkout] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Returns the list of pet_ids a user has purchased (used by the app to sync ownership).
app.get('/api/pet-owned/:clerkUserId', (req, res) => {
  const { clerkUserId } = req.params;
  const rows = db.getPetPurchases.all(clerkUserId);
  res.json({ pets: rows.map(r => r.pet_id) });
});

// ── License Verification (called by Tauri app) ──
app.get('/api/license/:clerkUserId', async (req, res) => {
  const { clerkUserId } = req.params;
  const platform = (req.query.platform || '').toLowerCase();
  const isIOS = platform === 'ios';
  const planLimits = isIOS ? PLAN_LIMITS_IOS : PLAN_LIMITS;

  // ── Lifetime short-circuit ────────────────────────────────────────────────
  // Must run BEFORE the Stripe lookup below: a lifetime buyer has no subscription,
  // so that lookup would find nothing and mark them expired. This flag is the only
  // proof of purchase, and it never lapses.
  try {
    const lifer = db.getUser.get(clerkUserId);
    if (lifer && lifer.lifetime_at) {
      return res.json({
        tier: 'pro',
        status: 'active',
        lifetime: true,
        limits: planLimits['pro'] || { optimizations_per_week: -1, max_sessions: 3, max_devices: 2 },
        expiresAt: null,
        trialEnd: null,
      });
    }
  } catch (err) {
    console.error('[license] lifetime check error:', err.message);
  }

  // Check cache first
  let license = licenseCache.get(clerkUserId);

  // Always re-verify with Stripe if cached status looks active but might be unpaid send_invoice
  const needsRecheck = !license || license.status === 'active' || license.status === 'past_due';
  if (needsRecheck) {
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
        } else {
          // No active subs found — clear any stale cache
          licenseCache.set(clerkUserId, {
            tier: 'expired', status: 'none', stripeCustomerId: allCustomers.data[0]?.id,
            subscriptionId: null, expiresAt: null, trialEnd: null,
          });
          license = licenseCache.get(clerkUserId);
          console.log(`[license] no active subs for ${clerkUserId}, cleared cache`);
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

  // Referral bonus: a user with unexpired bonus Pro days is Pro even without an
  // active Stripe subscription (unless Stripe already makes them active/trialing).
  try {
    const dbu = db.getUser.get(clerkUserId);
    const bonus = dbu && dbu.bonus_pro_until;
    const bonusActive = bonus && new Date(bonus).getTime() > Date.now();
    const stripePro = license && (license.status === 'active' || license.status === 'trialing')
      && license.tier && license.tier !== 'expired';
    if (bonusActive && !stripePro) {
      return res.json({
        tier: 'pro',
        status: 'trialing',
        limits: planLimits['pro'] || { optimizations_per_week: -1, max_sessions: 3, max_devices: 2 },
        expiresAt: bonus,
        trialEnd: bonus,
      });
    }
  } catch (err) {
    console.error('[license] referral bonus check error:', err.message);
  }

  if (!license || license.status === 'cancelled' || license.status === 'past_due') {
    const override = ACCOUNT_OVERRIDES[clerkUserId];
    if (override) {
      return res.json({ tier: 'pro', status: 'active', limits: override });
    }
    // past_due = unpaid invoice (WeChat/Alipay), treat as no plan
    return res.json({
      tier: 'expired',
      status: license?.status === 'past_due' ? 'past_due' : 'cancelled',
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

// ── Referral program (dual-sided give-get, 14 days Pro each) ──────────────────
const REFERRAL_DAYS = 14;
function addDaysIso(fromIso, days) {
  const base = fromIso ? new Date(fromIso).getTime() : 0;
  const start = Math.max(Date.now(), base || 0);
  return new Date(start + days * 86400000).toISOString();
}

// Dashboard: the caller's code, share URL, and counts.
app.get('/api/referral/:clerkUserId', (req, res) => {
  const id = req.params.clerkUserId;
  if (!id) return res.status(400).json({ error: 'missing user' });
  try {
    db.ensureUser(id);
    let u = db.getUser.get(id);
    let code = u && u.referral_code;
    if (!code) { code = db.referralCodeFor(id); db.setReferralCode.run(code, id); }
    const invited = db.countInvited.get(id)?.n || 0;
    const converted = db.countConverted.get(id)?.n || 0;
    // Days are earned per INVITE now (granted at redeem), not per conversion —
    // this has to match grantReferrerReward or the modal lies to the user.
    const proDaysEarned = invited * REFERRAL_DAYS + (u && u.referred_by ? REFERRAL_DAYS : 0);
    const lifetime = !!(u && u.lifetime_at);
    res.json({
      code,
      shareUrl: `https://www.terseai.org/?ref=${code}`,
      invited, converted, proDaysEarned,
      lifetime,
      lifetimeGoal: LIFETIME_REFERRAL_GOAL,
      lifetimeRemaining: lifetime ? 0 : Math.max(0, LIFETIME_REFERRAL_GOAL - invited),
      rewardText: `Give ${REFERRAL_DAYS} days of Pro, get ${REFERRAL_DAYS} days of Pro`,
      lifetimeText: `Invite ${LIFETIME_REFERRAL_GOAL} friends → Terse free forever`,
    });
  } catch (err) {
    console.error('[referral] get error:', err.message);
    res.status(500).json({ error: 'referral lookup failed' });
  }
});

// Redeem a friend's code. Referee gets their 14 days immediately (acquisition
// hook); the referrer is credited when the referee converts to paid (webhook).
// Server owns all abuse checks: no self-referral, one redemption per user.
app.post('/api/referral/redeem', express.json(), (req, res) => {
  const { clerkUserId, code } = req.body || {};
  if (!clerkUserId || !code) return res.status(400).json({ granted: false, message: 'Missing code.' });
  try {
    db.ensureUser(clerkUserId);
    const norm = String(code).trim().toUpperCase();

    // The same input box accepts a friend's invite code OR a personal gift code.
    // Gift codes are tried first: they are namespaced (TERSE-…) so they can never
    // collide with a 6-char invite code.
    if (norm.startsWith('TERSE-')) {
      const gift = db.getGiftCode.get(norm);
      if (!gift) return res.json({ granted: false, message: 'That gift code is not valid.' });
      // Atomic claim — the SELECT above is only for a nicer message; this is the
      // check that actually enforces single use.
      const claimed = db.claimGiftCode.run(clerkUserId, norm);
      if (claimed.changes !== 1) {
        return res.json({ granted: false, message: 'That gift code has already been used.' });
      }
      db.setLifetime.run(new Date().toISOString(), `gift:${norm}`, clerkUserId);
      licenseCache.delete(clerkUserId);
      return res.json({
        granted: true, lifetime: true,
        message: 'Lifetime unlocked — all features and all future updates, forever. 🎉',
      });
    }

    const owner = db.getUserByReferralCode.get(norm);
    if (!owner) return res.json({ granted: false, message: 'That invite code is not valid.' });
    if (owner.id === clerkUserId) return res.json({ granted: false, message: "You can't redeem your own code." });
    if (db.getReferralByReferee.get(clerkUserId)) {
      return res.json({ granted: false, message: 'You have already redeemed an invite code.' });
    }
    db.addReferral.run(require('crypto').randomUUID(), owner.id, clerkUserId, norm);
    db.setReferredBy.run(owner.id, clerkUserId);
    const me = db.getUser.get(clerkUserId);
    const until = addDaysIso(me && me.bonus_pro_until, REFERRAL_DAYS);
    db.setBonusProUntil.run(until, clerkUserId);
    licenseCache.delete(clerkUserId); // force re-eval so Pro reflects immediately

    // Credit the REFERRER right now, not on conversion.
    //
    // This used to wait for creditReferrerOnConversion() from the payment
    // webhook, so a referrer whose friend redeemed but never subscribed saw
    // "0 Pro days" forever — the modal promises "you both win", and the reward
    // has to land when the invite is actually used.
    const referrerReward = grantReferrerReward(owner.id);

    res.json({
      granted: true,
      message: `${REFERRAL_DAYS} days of Pro unlocked! 🎉`,
      bonusProUntil: until,
      referrerRewarded: referrerReward.days,
      referrerLifetime: referrerReward.lifetime,
    });
  } catch (err) {
    console.error('[referral] redeem error:', err.message);
    res.status(500).json({ granted: false, message: 'Could not redeem right now.' });
  }
});

/// How many successful invites earn permanent (买断) access.
const LIFETIME_REFERRAL_GOAL = 10;

/// Reward a referrer for one successful invite: +14 days of Pro, and permanent
/// access once they hit LIFETIME_REFERRAL_GOAL invites. Returns what was granted
/// so the response can tell the referee what their friend just earned.
function grantReferrerReward(referrerId) {
  const out = { days: 0, lifetime: false };
  try {
    const referrer = db.getUser.get(referrerId);
    if (!referrer) return out;

    // Already permanent → nothing left to grant, and no point extending days.
    if (referrer.lifetime_at) return { days: 0, lifetime: true };

    db.setBonusProUntil.run(addDaysIso(referrer.bonus_pro_until, REFERRAL_DAYS), referrerId);
    out.days = REFERRAL_DAYS;

    const invited = db.countInvited.get(referrerId)?.n || 0;
    if (invited >= LIFETIME_REFERRAL_GOAL) {
      db.setLifetime.run(new Date().toISOString(), `referral:${invited}`, referrerId);
      out.lifetime = true;
      console.log(`[referral] ${referrerId} hit ${invited} invites — lifetime granted`);
    }
    licenseCache.delete(referrerId);
  } catch (err) {
    console.error('[referral] reward error:', err.message);
  }
  return out;
}

/// Credit a referrer once their referee converts to a paid plan. Idempotent.
function creditReferrerOnConversion(refereeId) {
  try {
    const ref = db.getReferralByReferee.get(refereeId);
    if (!ref || ref.status !== 'pending') return;
    const referrer = db.getUser.get(ref.referrer_id);
    if (!referrer) return;
    // The 14 days were already granted at redeem time (see grantReferrerReward),
    // so conversion only records the status — granting again here would pay the
    // referrer twice for one invite.
    db.markReferralConverted.run(refereeId);
    licenseCache.delete(ref.referrer_id);
    console.log(`[referral] referee ${refereeId} converted — referrer ${ref.referrer_id} marked`);
  } catch (err) {
    console.error('[referral] credit error:', err.message);
  }
}

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

// ── Terse Cloud (teams) routes ──
const cloudIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600, // bursty telemetry: 10/s/team is plenty
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/cloud', cloudIngestLimiter, cloudRouter);

// ── Terse Cowork (collaborative multi-agent office) ──
// MCP server mounted first so JSON-RPC isn't subject to the telemetry limiter.
app.use('/api/cloud/mcp', mcpRouter);
app.use('/api/cloud', cloudIngestLimiter, coworkRouter);
// Rooms: shared wallpaper sessions. Same prefix, distinct paths — a room is
// its own unit, so it does NOT go through team auth.
const roomsRouter = require('./rooms');
app.use('/api/cloud/rooms', cloudIngestLimiter, roomsRouter);
// Presence decays on a timer, not off the back of whoever happens to read next:
// that way a member who closed their laptop goes offline once, promptly, and
// everybody still in the room is told. 20s is comfortably inside the 45s window.
setInterval(() => roomsRouter.sweepPresence(), 20 * 1000).unref();
// Friends: the durable edge between two people who met in a room.
app.use('/api/cloud/friends', cloudIngestLimiter, require('./friends'));

// ── Device links (desktop ⇄ phone web app) ──
// The desktop pushes a live frame every few seconds and the phone streams it, so
// this rides the same ingest limiter as rooms and cowork rather than the default.
app.use('/api/cloud/link', cloudIngestLimiter, require('./link'));

// ── WeChat sign-in (phone web app) ──
// Inert until WECHAT_APP_ID / WECHAT_APP_SECRET are set; see api/wechat.js for
// what applying for those actually involves.
app.use('/api/auth/wechat', require('./wechat'));

// ── Phone wallpaper ──
// The frame the phone captures out of the live field, and the public URL an iOS
// Shortcut fetches to set it as the actual Home Screen wallpaper.
const wallpaperRouter = require('./wallpaper');
app.use('/api/cloud/wallpaper', wallpaperRouter);

// Sweep stale cowork sessions + presence every 30s (broadcasts changes over SSE).
setInterval(() => coworkRouter.sweepStale(), 30 * 1000).unref();

// ── Terse Docs (Google-style collaborative documents) ──
app.use('/api/docs', docsRouter);

// ── LLM Proxy (rate-limited) ──
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: { message: 'Rate limit exceeded. Max 120 requests/minute.' } },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/proxy', proxyLimiter, proxyRouter);

// ── Paddle routes (WeChat Pay + Alipay recurring) ──
// Note: paddle webhook needs raw body — must be registered BEFORE express.json()
// It's registered here but paddle.js registers its own raw body parser per-route
app.use(paddleModule.router);

// ── Terse Developer API ──
app.use('/api/v1', terseApiRouter);

// ── Trial-recovery emails (protected cron + hourly scheduler; off unless enabled) ──
app.use(recovery.router());
recovery.startScheduler();

// ── Newsletter subscribe (proxies to Buttondown with server-side API key) ──
app.post('/api/newsletter/subscribe', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) return res.status(503).json({ error: 'newsletter_unavailable' });
  try {
    const r = await fetch('https://api.buttondown.email/v1/subscribers', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email_address: email, tags: ['landing'] }),
    });
    const data = await r.json();
    if (r.ok || r.status === 201) return res.json({ ok: true });
    // 400 with "already subscribed" is still a success from the user's perspective
    const detail = JSON.stringify(data);
    if (detail.includes('already_subscribed') || detail.includes('You are already subscribed')) {
      return res.json({ ok: true, already: true });
    }
    return res.status(400).json({ error: data });
  } catch {
    return res.status(502).json({ error: 'upstream_error' });
  }
});

// ── Support / QA (proxies user questions to Slack via Incoming Webhook) ──
// Mirrors the newsletter proxy above: the webhook secret lives server-side in
// SLACK_QA_WEBHOOK_URL and is never exposed to the browser.
const supportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6, // 6 questions/min/IP — plenty for a human, blocks spam bots
  message: { error: 'Too many requests. Please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Frontend reads the public Slack invite link (if set) for the "Join our Slack" button.
app.get('/api/support/config', (req, res) => {
  res.json({ inviteUrl: process.env.SLACK_INVITE_URL || null });
});

app.post('/api/support', supportLimiter, async (req, res) => {
  const { email, message, page } = req.body || {};
  const text = (message || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'empty_message' });
  if (text.length > 3000) return res.status(400).json({ error: 'message_too_long' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const webhook = process.env.SLACK_QA_WEBHOOK_URL;
  if (!webhook) return res.status(503).json({ error: 'support_unavailable' });

  // Escape Slack mrkdwn control chars so user input can't inject formatting.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const from = email ? esc(email) : 'anonymous (no email left)';
  const src = page ? esc(page.toString().slice(0, 200)) : 'website';

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `New question from ${from}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '💬 New question from the website', emoji: true } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*From:*\n${from}` },
            { type: 'mrkdwn', text: `*Page:*\n${src}` },
          ] },
          { type: 'section', text: { type: 'mrkdwn', text: esc(text) } },
        ],
      }),
    });
    if (!r.ok) {
      console.error('[support] slack webhook error:', r.status, await r.text().catch(() => ''));
      return res.status(502).json({ error: 'slack_error' });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[support] error:', e.message);
    return res.status(502).json({ error: 'upstream_error' });
  }
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Serve landing page ──
/* ── Cache policy for the phone web app ───────────────────────────────────
   A CDN sits in front of this and was observed serving these files SIX AND A
   HALF HOURS after they changed, despite the five-minute max-age express.static
   sends (age: 23435, cf-cache-status: HIT). For most of the marketing site that
   is harmless. For these five paths it is not:

     · sw.js  — a stale service worker keeps serving its own stale cache of the
       whole app, so one old copy of THIS file pins everything else to the
       version that shipped with it. A shipped fix then never reaches anyone.
     · /m and the phone scripts — the shell and its code, which must match the
       API they talk to.

   no-store rather than a shorter max-age: the point is that an intermediary
   must not hold these at all, and a max-age is advice a CDN has already been
   seen to ignore. The engines under /app-assets keep their own longer cache —
   they are large, they change rarely, and the service worker revalidates them.
   ------------------------------------------------------------------------- */
const NEVER_CACHE = /^\/(sw\.js|manifest\.webmanifest|m|m\/.*|phone\/.*)$/;
app.use((req, res, next) => {
  if (req.method === 'GET' && NEVER_CACHE.test(req.path)) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    // Service workers are additionally governed by their own header: without
    // this, a browser may reuse a cached script for up to 24 hours.
    if (req.path === '/sw.js') res.set('Service-Worker-Allowed', '/');
  }
  next();
});

/* The phone app's build stamp, and why the shell is rewritten rather than sent
   as a file.

   The CDN in front of this was observed serving /phone/*.js from a cache entry
   six and a half hours old, with cf-cache-status: HIT, against the five-minute
   max-age the origin sends — an edge TTL override that ignores origin headers
   outright. The no-store policy above fixed the HTML (it now comes back
   DYNAMIC) but cannot evict an entry the edge already holds for the scripts.

   A version in the URL is the one lever that works from here: a new build is a
   new URL, so there is no entry to hit. It is derived from the files themselves,
   so it changes exactly when they do and never needs remembering.

   Only the app's own code is stamped. The engines keep their plain URLs: they
   are three quarters of a megabyte of Three.js plus shaders shared with the
   desktop, they change rarely, and re-downloading them on every deploy would
   cost far more than it saves. */
const PHONE_ASSETS = ['phone/app.js', 'phone/terse-web.js', 'phone/capture.js', 'phone/mp4.js', 'phone/diag.js', 'sw.js'];
function buildStamp() {
  let acc = 0;
  for (const rel of PHONE_ASSETS) {
    try {
      const st = fs.statSync(path.join(__dirname, '..', 'landing', rel));
      acc = (acc * 31 + st.size + Math.floor(st.mtimeMs)) >>> 0;
    } catch { /* a missing file simply does not contribute */ }
  }
  return acc.toString(36);
}
// Computed once: the files cannot change under a running process, and doing this
// per request would stat six files on every load of the app.
const PHONE_BUILD = buildStamp();

app.get(['/m', '/m/*'], (req, res) => {
  const file = path.join(__dirname, '..', 'landing', 'm.html');
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('Could not load the app');
    const stamped = html
      .replace(/(src=")(\/phone\/[a-z0-9.-]+\.js)(")/gi, `$1$2?v=${PHONE_BUILD}$3`)
      // Handed to the page so it can stamp what it loads itself — the service
      // worker registration above all, which the browser fetches directly and
      // which no HTML rewrite can reach.
      .replace('</head>', `<script>window.__TERSE_BUILD=${JSON.stringify(PHONE_BUILD)};</script>\n</head>`);
    res.type('html').send(stamped);
  });
});

// Registered BEFORE the static mount on purpose: `extensions: ['html']` makes
// express.static answer /m with m.html directly, so a handler after it never
// runs and the shell goes out unstamped.
app.use(express.static(path.join(__dirname, '..', 'landing'), { extensions: ['html'] }));

// /teams/:id → serve the dashboard page (loads team via API client-side)
app.get(['/teams', '/teams/:id'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'teams.html'));
});

// /api-docs → developer API documentation
app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'api-docs.html'));
});

// /vibe-projects → vibe coding projects platform
app.get('/vibe-projects', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'vibe-projects.html'));
});

// ── Terse Docs portal + editor ──
// /workspace → Drive-style portal; /d/:id → live collaborative editor
app.get(['/workspace', '/docs-app'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'workspace.html'));
});
app.get('/d/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'doc.html'));
});

// ── Terse for phone (installable web app) ──
// The wallpaper engines, the rooms client and the style table are served
// straight out of src/renderer rather than copied into landing/. There is ONE
// copy of each: a fork would drift, and the whole reason the phone can render
// the real wallpaper is that those files never depended on Tauri in the first
// place.
app.use('/app-assets', express.static(path.join(__dirname, '..', 'src', 'renderer'), {
  extensions: ['js', 'mjs'],
  setHeaders: (res, filePath) => {
    // The engines are large and change rarely; the shim and the room client
    // change often enough that a stale copy would be a support ticket.
    if (/vendor[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else res.setHeader('Cache-Control', 'public, max-age=300');
  },
}));

// /mobile → how to install it. /m → the app itself (client-side routed).
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing', 'mobile.html'));
});


// The wallpaper image itself. Above the SPA catch-all, and outside /api, because
// an iOS Shortcut fetches it with no headers at all — the URL is the credential.
app.get('/w/:token', wallpaperRouter.serveFrame);

// Unknown paths → a real 404.
//
// This used to answer every unmatched path with index.html and a 200. Anything
// reaching here has already failed express.static (which resolves /about to
// about.html) and been declined by every route above, so it is genuinely
// unknown — and answering 200 meant every typo, every stale backlink and every
// crawler probe looked like a real page. Google calls that a soft 404 and
// spends crawl budget on it: /obviously-not-a-page-9182, /a/b/c/d and
// /zh/anything all returned the English home page, turning a 96-page site into
// an unbounded crawl space. Googlebot was down to 24 requests in the window we
// could measure.
//
// Every client-routed page is already declared explicitly above — /teams,
// /teams/:id, /d/:id, /vibe-projects — and the only URLs the client routers
// push are /teams and /marketplace, both of which resolve. So nothing that
// needs the shell lands here.
app.get('*', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'landing', '404.html'));
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
