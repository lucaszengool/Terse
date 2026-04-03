/**
 * Seed 30 realistic marketplace listings.
 * Run: node api/seed-listings.js
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'terse.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Fake encrypted key data (these aren't real keys, just placeholders)
function fakeEncrypted() {
  const iv = crypto.randomBytes(12);
  const tag = crypto.randomBytes(16);
  const encrypted = crypto.randomBytes(48);
  return { encrypted, iv, tag };
}

// Create fake seller users
const sellers = [];
for (let i = 1; i <= 15; i++) {
  const id = `seller_seed_${String(i).padStart(3, '0')}`;
  const email = `seller${i}@example.com`;
  db.prepare(`INSERT OR IGNORE INTO users (id, email, tier, status) VALUES (?, ?, 'pro', 'active')`).run(id, email);
  sellers.push(id);
}

const addKey = db.prepare(`
  INSERT OR IGNORE INTO seller_keys (id, user_id, provider, encrypted_key, key_iv, key_tag, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, models_allowed, optimization_mode, token_cap_total, token_cap_hourly, token_cap_daily, rate_limit_hourly_cents, rate_limit_daily_cents, key_verified, is_active, total_tokens_used, created_at)
  VALUES (@id, @user_id, @provider, @encrypted_key, @key_iv, @key_tag, @label, @price_per_1m_input, @price_per_1m_output, @spending_cap_cents, @models_allowed, @optimization_mode, @token_cap_total, @token_cap_hourly, @token_cap_daily, @rate_limit_hourly_cents, @rate_limit_daily_cents, @key_verified, @is_active, @total_tokens_used, @created_at)
`);

// List prices (cents per 1M tokens) for reference
// anthropic: opus input=500 output=2500, sonnet input=300 output=1500, haiku input=100 output=500
// openai: gpt-4o input=250 output=1000, gpt-4o-mini input=15 output=60, gpt-4.1/o3 input=200 output=800
// google: gemini-2.5-pro input=125 output=1000, gemini-2.5-flash input=30 output=250

const listings = [
  // Anthropic — Claude Opus
  { provider: 'anthropic', label: 'Opus 4 — Enterprise surplus', input: 375, output: 1875, discount: 25, cap_total: 500000000, models: 'claude-opus-4-20250514' },
  { provider: 'anthropic', label: 'Opus key — 30% off', input: 350, output: 1750, discount: 30, cap_total: 200000000, models: 'claude-opus-4-20250514' },
  { provider: 'anthropic', label: 'Opus — low latency US-East', input: 400, output: 2000, discount: 20, cap_total: 1000000000, models: 'claude-opus-4-20250514' },
  { provider: 'anthropic', label: 'Opus 4 bulk capacity', input: 325, output: 1625, discount: 35, cap_total: 800000000, models: 'claude-opus-4-20250514' },

  // Anthropic — Claude Sonnet
  { provider: 'anthropic', label: 'Sonnet 4 — daily cap 50M', input: 210, output: 1050, discount: 30, cap_total: null, cap_daily: 50000000, models: 'claude-sonnet-4-20250514' },
  { provider: 'anthropic', label: 'Sonnet key — startup excess', input: 225, output: 1125, discount: 25, cap_total: 300000000, models: 'claude-sonnet-4-20250514' },
  { provider: 'anthropic', label: 'Sonnet 4 — high throughput', input: 240, output: 1200, discount: 20, cap_total: 600000000, models: 'claude-sonnet-4-20250514' },

  // Anthropic — Claude Haiku
  { provider: 'anthropic', label: 'Haiku 4 — unlimited cap', input: 65, output: 325, discount: 35, cap_total: null, models: 'claude-haiku-4-20250414' },
  { provider: 'anthropic', label: 'Haiku — budget batch key', input: 70, output: 350, discount: 30, cap_total: 1000000000, models: 'claude-haiku-4-20250414' },
  { provider: 'anthropic', label: 'Haiku 4 — 40% off retail', input: 60, output: 300, discount: 40, cap_total: 500000000, models: 'claude-haiku-4-20250414' },

  // OpenAI — GPT-4o
  { provider: 'openai', label: 'GPT-4o — team surplus', input: 175, output: 700, discount: 30, cap_total: 400000000, models: 'gpt-4o' },
  { provider: 'openai', label: 'GPT-4o — 25% off', input: 188, output: 750, discount: 25, cap_total: 250000000, models: 'gpt-4o' },
  { provider: 'openai', label: 'GPT-4o — enterprise key', input: 163, output: 650, discount: 35, cap_total: 800000000, models: 'gpt-4o' },

  // OpenAI — GPT-4.1 / o3
  { provider: 'openai', label: 'GPT-4.1 — research lab excess', input: 140, output: 560, discount: 30, cap_total: 300000000, models: 'gpt-4.1,o3' },
  { provider: 'openai', label: 'o3 — coding key 35% off', input: 130, output: 520, discount: 35, cap_total: 200000000, models: 'o3' },
  { provider: 'openai', label: 'GPT-4.1 — high rate limit', input: 160, output: 640, discount: 20, cap_total: 600000000, models: 'gpt-4.1' },

  // OpenAI — GPT-4o-mini
  { provider: 'openai', label: '4o-mini — massive cap', input: 10, output: 40, discount: 33, cap_total: null, models: 'gpt-4o-mini' },
  { provider: 'openai', label: '4o-mini — 40% off', input: 9, output: 36, discount: 40, cap_total: 2000000000, models: 'gpt-4o-mini' },
  { provider: 'openai', label: '4o-mini — startup leftover', input: 11, output: 45, discount: 27, cap_total: 500000000, models: 'gpt-4o-mini' },

  // Google — Gemini 2.5 Pro
  { provider: 'google', label: 'Gemini 2.5 Pro — 30% off', input: 88, output: 700, discount: 30, cap_total: 400000000, models: 'gemini-2.5-pro' },
  { provider: 'google', label: 'Gemini Pro — enterprise tier', input: 75, output: 600, discount: 40, cap_total: 600000000, models: 'gemini-2.5-pro' },
  { provider: 'google', label: 'Gemini 2.5 Pro — GCP credits', input: 94, output: 750, discount: 25, cap_total: 300000000, models: 'gemini-2.5-pro' },
  { provider: 'google', label: 'Gemini Pro — bulk batch', input: 69, output: 550, discount: 45, cap_total: 1000000000, models: 'gemini-2.5-pro' },

  // Google — Gemini 2.5 Flash
  { provider: 'google', label: 'Gemini Flash — cheap & fast', input: 20, output: 163, discount: 35, cap_total: null, models: 'gemini-2.5-flash' },
  { provider: 'google', label: 'Flash 2.5 — 40% off retail', input: 18, output: 150, discount: 40, cap_total: 800000000, models: 'gemini-2.5-flash' },
  { provider: 'google', label: 'Gemini Flash — high QPS', input: 22, output: 175, discount: 30, cap_total: 500000000, models: 'gemini-2.5-flash' },
  { provider: 'google', label: 'Flash — student credits', input: 15, output: 125, discount: 50, cap_total: 200000000, models: 'gemini-2.5-flash' },

  // Mixed / multi-model keys
  { provider: 'anthropic', label: 'All Claude models — 20% off', input: 240, output: 1200, discount: 20, cap_total: 500000000, models: 'claude-opus-4-20250514,claude-sonnet-4-20250514,claude-haiku-4-20250414' },
  { provider: 'openai', label: 'All OpenAI models — team key', input: 150, output: 600, discount: 25, cap_total: 400000000, models: 'gpt-4o,gpt-4.1,gpt-4o-mini,o3' },
  { provider: 'google', label: 'All Gemini — GCP enterprise', input: 63, output: 500, discount: 50, cap_total: 700000000, models: 'gemini-2.5-pro,gemini-2.5-flash' },
];

// Stagger creation dates over the past 30 days
const now = Date.now();
let count = 0;

for (let i = 0; i < listings.length; i++) {
  const l = listings[i];
  const sellerId = sellers[i % sellers.length];
  const { encrypted, iv, tag } = fakeEncrypted();
  const daysAgo = Math.floor(Math.random() * 30);
  const hoursAgo = Math.floor(Math.random() * 24);
  const createdAt = new Date(now - daysAgo * 86400000 - hoursAgo * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const tokensUsed = l.cap_total ? Math.floor(Math.random() * l.cap_total * 0.3) : Math.floor(Math.random() * 100000000);

  try {
    addKey.run({
      id: `seed_key_${String(i + 1).padStart(3, '0')}`,
      user_id: sellerId,
      provider: l.provider,
      encrypted_key: encrypted,
      key_iv: iv,
      key_tag: tag,
      label: l.label,
      price_per_1m_input: l.input,
      price_per_1m_output: l.output,
      spending_cap_cents: null,
      models_allowed: l.models,
      optimization_mode: ['normal', 'aggressive', 'normal', 'light'][i % 4],
      token_cap_total: l.cap_total || null,
      token_cap_hourly: l.cap_hourly || null,
      token_cap_daily: l.cap_daily || null,
      rate_limit_hourly_cents: null,
      rate_limit_daily_cents: null,
      key_verified: 1,
      is_active: 1,
      total_tokens_used: tokensUsed,
      created_at: createdAt,
    });
    count++;
  } catch (e) {
    console.log(`Skip ${l.label}: ${e.message}`);
  }
}

console.log(`Seeded ${count} marketplace listings.`);
db.close();
