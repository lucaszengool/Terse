/**
 * Terse Notification System
 * Sends email notifications to sellers and buyers on trade events.
 * Uses Clerk API to send emails (no extra SMTP config needed).
 */
const crypto = require('crypto');
const db = require('./db');

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;

// Send notification + email to a user
async function notify(userId, type, title, body) {
  const id = crypto.randomUUID();

  // Save to DB
  try {
    db.addNotification.run({ id, user_id: userId, type, title, body });
  } catch (e) {
    console.error('[notify] DB error:', e.message);
  }

  // Send email via Clerk (non-blocking)
  sendEmail(userId, title, body).catch(e => {
    console.error('[notify] email error:', e.message);
  });

  return id;
}

async function sendEmail(userId, subject, body) {
  if (!CLERK_SECRET) return;

  // Get user email from Clerk
  try {
    const userRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${CLERK_SECRET}` },
    });
    const user = await userRes.json();
    const email = user.email_addresses?.[0]?.email_address;
    if (!email) return;

    // Send via Clerk's email API
    await fetch('https://api.clerk.com/v1/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLERK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from_email_name: 'exchange',
        email_address_id: user.email_addresses[0].id,
        subject: `Terse Exchange: ${subject}`,
        body: formatEmailBody(subject, body),
      }),
    });

    // Mark as emailed
    db.markNotificationEmailed.run(userId);
    console.log(`[notify] email sent to ${email}: ${subject}`);
  } catch (e) {
    console.error('[notify] email send failed:', e.message);
  }
}

function formatEmailBody(subject, body) {
  return `
<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:20px">
  <div style="text-align:center;margin-bottom:20px">
    <span style="display:inline-block;width:30px;height:30px;background:rgba(110,231,183,0.1);border:1px solid rgba(110,231,183,0.2);border-radius:7px;line-height:30px;color:#6ee7b7;font-weight:800;font-size:14px">T</span>
    <span style="font-weight:800;font-size:18px;margin-left:8px;color:#fff">Terse Token Exchange</span>
  </div>
  <div style="background:#1a1830;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;color:#fff">
    <h2 style="margin:0 0 12px;font-size:18px;font-weight:700">${subject}</h2>
    <p style="color:rgba(255,255,255,0.7);font-size:14px;line-height:1.6;margin:0">${body}</p>
  </div>
  <div style="text-align:center;margin-top:20px">
    <a href="https://www.terseai.org/marketplace" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#6ee7b7,#34d399);color:#0f0e1a;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none">Open Token Exchange</a>
  </div>
  <p style="text-align:center;font-size:11px;color:rgba(255,255,255,0.3);margin-top:16px">&copy; 2026 Terse &middot; terseai.org</p>
</div>`;
}

// ── Convenience helpers for common events ──

function notifySale(sellerId, buyerModel, inputTokens, outputTokens, earnedCents) {
  const earned = (earnedCents / 100).toFixed(4);
  notify(sellerId, 'sale',
    `You earned $${earned}`,
    `Someone used your key for ${buyerModel}. ${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output tokens. You earned $${earned} from this request.`
  );
}

function notifyPurchase(buyerId, model, costCents) {
  const cost = (costCents / 100).toFixed(4);
  notify(buyerId, 'purchase',
    `API call: $${cost}`,
    `Your request to ${model} cost $${cost}. Check your usage dashboard for details.`
  );
}

function notifyTopup(userId, amountCents) {
  const amount = (amountCents / 100).toFixed(2);
  notify(userId, 'topup',
    `Balance topped up: +$${amount}`,
    `$${amount} has been added to your buyer balance. You can now make API requests through the exchange.`
  );
}

function notifyWithdrawal(userId, amountCents) {
  const amount = (amountCents / 100).toFixed(2);
  notify(userId, 'withdrawal',
    `Withdrawal requested: $${amount}`,
    `Your withdrawal of $${amount} has been submitted and will be processed within 3-5 business days.`
  );
}

function notifyKeyListed(userId, provider) {
  notify(userId, 'key_listed',
    `Key listed on exchange`,
    `Your ${provider} API key is now live on the Token Exchange. You'll earn money whenever someone uses it.`
  );
}

function notifyCapReached(userId, label) {
  notify(userId, 'cap_reached',
    `Spending cap reached`,
    `Your key "${label}" has reached its spending cap and is now paused. Increase the cap or add a new key to keep earning.`
  );
}

module.exports = {
  notify, notifySale, notifyPurchase, notifyTopup, notifyWithdrawal, notifyKeyListed, notifyCapReached,
  getNotifications: (userId, limit = 20) => db.getNotifications.all(userId, limit),
  getUnreadCount: (userId) => db.getUnreadCount.get(userId)?.count || 0,
  markRead: (id, userId) => db.markNotificationRead.run(id, userId),
};
