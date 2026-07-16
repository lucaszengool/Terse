// api/recovery.js — trial-recovery emails.
// Nudges users who created a Terse account but never started a trial/subscription,
// at ~24h and ~72h after signup. Terse-branded, sent via the Clerk email API
// (same mechanism as notify.js — no SMTP/SendGrid needed).
//
// SAFETY: does NOTHING unless RECOVERY_EMAILS_ENABLED='1'. Until then the scheduler
// is off and the cron endpoint runs in forced dry-run (previews, never sends).
//   Enable:   RECOVERY_EMAILS_ENABLED=1
//   Test:     GET /api/cron/recovery?key=$RECOVERY_CRON_KEY&dry=1   (preview targets)
//   From:     RECOVERY_FROM_NAME (default 'exchange' — must be a configured Clerk sender)
const express = require('express');
const { db, getUser } = require('./db');

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const APP_URL = process.env.APP_URL || 'https://www.terseai.org';
const FROM_NAME = process.env.RECOVERY_FROM_NAME || 'exchange';
const CRON_KEY = process.env.RECOVERY_CRON_KEY || '';
const ENABLED = process.env.RECOVERY_EMAILS_ENABLED === '1';

// ── dedup store (self-contained; does not touch db.js) ──
db.exec(`CREATE TABLE IF NOT EXISTS recovery_emails (
  clerk_user_id TEXT NOT NULL,
  stage TEXT NOT NULL,                 -- '24h' | '72h'
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (clerk_user_id, stage)
);`);
const wasSent = db.prepare('SELECT 1 FROM recovery_emails WHERE clerk_user_id = ? AND stage = ?');
const markSent = db.prepare('INSERT OR IGNORE INTO recovery_emails (clerk_user_id, stage) VALUES (?, ?)');

// ── email content (Terse-branded, concrete-savings angle) ──
function wrap(inner, cta, ctaLabel) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6">
  <div style="margin-bottom:22px">
    <span style="display:inline-block;width:30px;height:30px;background:#0b0b0d;border-radius:8px;line-height:30px;text-align:center;color:#C9F03D;font-weight:900;font-size:16px">T</span>
    <span style="font-weight:800;font-size:18px;margin-left:8px;vertical-align:middle">Terse</span>
  </div>
  ${inner}
  <div style="margin:26px 0 8px">
    <a href="${cta}" style="display:inline-block;background:#0b0b0d;color:#C9F03D;text-decoration:none;font-weight:800;font-size:15px;padding:13px 26px;border-radius:9999px">${ctaLabel}</a>
  </div>
  <p style="font-size:12px;color:#888;margin-top:22px">On-device prompt optimization &amp; agent monitoring for Claude Code, Cursor, ChatGPT and more. Cancel anytime.</p>
</div>`;
}
function emailFor(stage, firstName) {
  const hi = firstName ? `Hi ${firstName},` : 'Hi there,';
  const cta = `${APP_URL}/?utm_source=recovery&utm_campaign=${stage}`;
  if (stage === '24h') {
    return {
      subject: 'Your Terse trial is one click away — start saving tokens',
      html: wrap(
        `<p style="font-size:15px"><b>${hi}</b></p>
         <p>You created a Terse account but haven't started optimizing yet. Most developers waste <b>40–70% of their AI tokens</b> on filler, duplicate tool calls and bloated context — Terse trims all of that automatically, on-device.</p>
         <p>Your <b>30-day free trial</b> is ready: <b>$0 today</b>, cancel anytime.</p>`,
        cta, 'Start my free trial →'),
    };
  }
  return {
    subject: 'Last nudge: 40–70% of your AI tokens are being wasted',
    html: wrap(
      `<p style="font-size:15px"><b>${hi}</b></p>
       <p>Quick reminder — your Terse account is set up, but you haven't run a single optimization. That's real money: at 40–70% waste, a typical Claude Code / Cursor user leaves <b>hundreds of thousands of tokens</b> unoptimized every month.</p>
       <p>Start your <b>30-day free trial</b> — $0 today, cancel anytime. Takes about 60 seconds.</p>`,
      cta, 'Start free — $0 today →'),
  };
}

// ── Clerk email send (Terse-branded) ──
async function sendEmail(userId, subject, html) {
  if (!CLERK_SECRET) throw new Error('CLERK_SECRET_KEY not set');
  const userRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, { headers: { Authorization: `Bearer ${CLERK_SECRET}` } });
  const user = await userRes.json();
  const addr = user.email_addresses && user.email_addresses[0];
  if (!addr || !addr.id) throw new Error('no email on record');
  const r = await fetch('https://api.clerk.com/v1/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CLERK_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_email_name: FROM_NAME, email_address_id: addr.id, subject, body: html }),
  });
  if (!r.ok) throw new Error('clerk email ' + r.status + ' ' + (await r.text()).slice(0, 140));
  return addr.email_address;
}

// A user has "converted" if the DB has them on a paid tier with a live-ish status.
// (ensureUser + updateUserTier only run on successful checkout/webhook, so signups
// that never started a trial simply aren't in the users table → treated as targets.)
function isConverted(userId) {
  try {
    const u = getUser.get(userId);
    if (!u) return false;
    const tier = (u.tier || '').toLowerCase(), status = (u.status || '').toLowerCase();
    return (tier === 'pro' || tier === 'premium') && ['active', 'trialing', 'past_due'].includes(status);
  } catch { return false; }
}

// ── the sweep: recent Clerk signups in the 24h / 72h windows, not converted, not yet emailed ──
async function sweep({ dryRun = false, limit = 100 } = {}) {
  if (!CLERK_SECRET) return { error: 'CLERK_SECRET_KEY not set' };
  const now = Date.now();
  const cutoff = now - 6 * 86400000; // stop paging past ~6 days old
  const ageH = (ms) => (now - ms) / 3600000;
  const out = { enabled: ENABLED, dryRun, checked: 0, skipped: 0, sent: [] };
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    let users;
    try {
      const res = await fetch(`https://api.clerk.com/v1/users?order_by=-created_at&limit=100&offset=${offset}`, { headers: { Authorization: `Bearer ${CLERK_SECRET}` } });
      users = await res.json();
    } catch (e) { out.error = 'clerk list: ' + e.message; break; }
    if (!Array.isArray(users) || users.length === 0) break;
    for (const u of users) {
      const created = Number(u.created_at); // Clerk returns ms epoch
      if (!created || created < cutoff) return out; // sorted newest-first → done
      out.checked++;
      const h = ageH(created);
      const stage = (h >= 24 && h < 30) ? '24h' : (h >= 72 && h < 78) ? '72h' : null;
      if (!stage) { out.skipped++; continue; }
      if (wasSent.get(u.id, stage)) { out.skipped++; continue; }
      if (isConverted(u.id)) { out.skipped++; continue; }
      const email = u.email_addresses && u.email_addresses[0] && u.email_addresses[0].email_address;
      if (dryRun) {
        out.sent.push({ id: u.id, stage, email, dryRun: true });
      } else {
        const { subject, html } = emailFor(stage, u.first_name || '');
        try { await sendEmail(u.id, subject, html); markSent.run(u.id, stage); out.sent.push({ id: u.id, stage, email }); }
        catch (e) { out.sent.push({ id: u.id, stage, email, error: e.message }); }
      }
      if (out.sent.length >= limit) return out;
    }
    offset += 100;
  }
  return out;
}

// ── express router: protected manual trigger / dry-run preview ──
function router() {
  const r = express.Router();
  r.get('/api/cron/recovery', async (req, res) => {
    if (!CRON_KEY || req.query.key !== CRON_KEY) return res.status(403).json({ error: 'forbidden' });
    const dryRun = req.query.dry === '1' || !ENABLED; // never send unless explicitly enabled
    try { res.json(await sweep({ dryRun })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  return r;
}

// ── hourly scheduler (only when enabled) ──
function startScheduler() {
  if (!ENABLED) { console.log('[recovery] disabled — set RECOVERY_EMAILS_ENABLED=1 to activate'); return; }
  console.log('[recovery] enabled — hourly trial-recovery sweep (24h + 72h)');
  const run = () => sweep({}).then(r => console.log(`[recovery] sweep: checked=${r.checked} sent=${r.sent.filter(s => !s.error).length} errors=${r.sent.filter(s => s.error).length}`)).catch(e => console.error('[recovery] sweep failed:', e.message));
  setTimeout(run, 120000);          // first run 2 min after boot
  setInterval(run, 3600000);        // then hourly
}

module.exports = { router, startScheduler, sweep };
