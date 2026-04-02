/**
 * SQLite database layer for Terse Marketplace.
 * Uses better-sqlite3 for synchronous, fast access.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'terse.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    tier TEXT DEFAULT 'free',
    stripe_customer_id TEXT,
    subscription_id TEXT,
    status TEXT DEFAULT 'active',
    expires_at TEXT,
    buyer_balance_cents INTEGER DEFAULT 0,
    seller_balance_cents INTEGER DEFAULT 0,
    stripe_connect_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS seller_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    encrypted_key BLOB NOT NULL,
    key_iv BLOB NOT NULL,
    key_tag BLOB NOT NULL,
    label TEXT,
    price_per_1m_input INTEGER NOT NULL,
    price_per_1m_output INTEGER NOT NULL,
    spending_cap_cents INTEGER,
    total_spent_cents INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    models_allowed TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS buyer_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    key_hash TEXT NOT NULL,
    label TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    buyer_key_id TEXT,
    seller_key_id TEXT,
    buyer_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    input_tokens_optimized INTEGER,
    seller_cost_cents INTEGER NOT NULL,
    terse_fee_cents INTEGER NOT NULL,
    actual_api_cost_cents INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS balance_topups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    stripe_payment_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    stripe_transfer_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_seller_keys_active ON seller_keys(is_active, provider);
  CREATE INDEX IF NOT EXISTS idx_buyer_keys_hash ON buyer_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON transactions(buyer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_transactions_seller ON transactions(seller_id, created_at);
`);

// ── User helpers ──
const upsertUser = db.prepare(`
  INSERT INTO users (id, email, tier, stripe_customer_id, subscription_id, status, expires_at)
  VALUES (@id, @email, @tier, @stripe_customer_id, @subscription_id, @status, @expires_at)
  ON CONFLICT(id) DO UPDATE SET
    email = COALESCE(@email, email),
    tier = @tier,
    stripe_customer_id = COALESCE(@stripe_customer_id, stripe_customer_id),
    subscription_id = @subscription_id,
    status = @status,
    expires_at = @expires_at
`);

const getUser = db.prepare('SELECT * FROM users WHERE id = ?');

function ensureUser(id, email) {
  let user = getUser.get(id);
  if (!user) {
    upsertUser.run({ id, email: email || null, tier: 'free', stripe_customer_id: null, subscription_id: null, status: 'active', expires_at: null });
    user = getUser.get(id);
  }
  return user;
}

// ── Seller key helpers ──
const addSellerKey = db.prepare(`
  INSERT INTO seller_keys (id, user_id, provider, encrypted_key, key_iv, key_tag, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, models_allowed)
  VALUES (@id, @user_id, @provider, @encrypted_key, @key_iv, @key_tag, @label, @price_per_1m_input, @price_per_1m_output, @spending_cap_cents, @models_allowed)
`);

const getSellerKeys = db.prepare('SELECT id, user_id, provider, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, total_spent_cents, is_active, models_allowed, created_at FROM seller_keys WHERE user_id = ?');
const getSellerKeyFull = db.prepare('SELECT * FROM seller_keys WHERE id = ? AND user_id = ?');
const updateSellerKey = db.prepare('UPDATE seller_keys SET price_per_1m_input = @price_per_1m_input, price_per_1m_output = @price_per_1m_output, spending_cap_cents = @spending_cap_cents, is_active = @is_active, models_allowed = @models_allowed WHERE id = @id AND user_id = @user_id');
const deleteSellerKey = db.prepare('DELETE FROM seller_keys WHERE id = ? AND user_id = ?');

// Find cheapest active seller key for a provider
const findCheapestKey = db.prepare(`
  SELECT * FROM seller_keys
  WHERE provider = ? AND is_active = 1
    AND (spending_cap_cents IS NULL OR total_spent_cents < spending_cap_cents)
  ORDER BY price_per_1m_input ASC
  LIMIT 1
`);

const incrementSellerSpend = db.prepare('UPDATE seller_keys SET total_spent_cents = total_spent_cents + ? WHERE id = ?');

// ── Buyer key helpers ──
const addBuyerKey = db.prepare('INSERT INTO buyer_keys (id, user_id, key_hash, label) VALUES (@id, @user_id, @key_hash, @label)');
const getBuyerKeys = db.prepare('SELECT id, user_id, label, is_active, created_at FROM buyer_keys WHERE user_id = ?');
const findBuyerByHash = db.prepare('SELECT * FROM buyer_keys WHERE key_hash = ? AND is_active = 1');
const deactivateBuyerKey = db.prepare('UPDATE buyer_keys SET is_active = 0 WHERE id = ? AND user_id = ?');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Balance helpers ──
const creditBuyerBalance = db.prepare('UPDATE users SET buyer_balance_cents = buyer_balance_cents + ? WHERE id = ?');
const debitBuyerBalance = db.prepare('UPDATE users SET buyer_balance_cents = buyer_balance_cents - ? WHERE id = ?');
const creditSellerBalance = db.prepare('UPDATE users SET seller_balance_cents = seller_balance_cents + ? WHERE id = ?');
const debitSellerBalance = db.prepare('UPDATE users SET seller_balance_cents = seller_balance_cents - ? WHERE id = ?');

// ── Transaction helpers ──
const addTransaction = db.prepare(`
  INSERT INTO transactions (id, buyer_key_id, seller_key_id, buyer_id, seller_id, provider, model, input_tokens, output_tokens, input_tokens_optimized, seller_cost_cents, terse_fee_cents, actual_api_cost_cents)
  VALUES (@id, @buyer_key_id, @seller_key_id, @buyer_id, @seller_id, @provider, @model, @input_tokens, @output_tokens, @input_tokens_optimized, @seller_cost_cents, @terse_fee_cents, @actual_api_cost_cents)
`);

const getTransactionsByBuyer = db.prepare('SELECT * FROM transactions WHERE buyer_id = ? ORDER BY created_at DESC LIMIT ?');
const getTransactionsBySeller = db.prepare('SELECT * FROM transactions WHERE seller_id = ? ORDER BY created_at DESC LIMIT ?');

const getSellerEarnings = db.prepare(`
  SELECT
    COUNT(*) as total_requests,
    COALESCE(SUM(seller_cost_cents - terse_fee_cents), 0) as total_earned_cents,
    COALESCE(SUM(input_tokens), 0) as total_input_tokens,
    COALESCE(SUM(output_tokens), 0) as total_output_tokens
  FROM transactions WHERE seller_id = ?
`);

const getBuyerSpending = db.prepare(`
  SELECT
    COUNT(*) as total_requests,
    COALESCE(SUM(seller_cost_cents), 0) as total_spent_cents,
    COALESCE(SUM(input_tokens), 0) as total_input_tokens,
    COALESCE(SUM(output_tokens), 0) as total_output_tokens
  FROM transactions WHERE buyer_id = ?
`);

// ── Top-up helpers ──
const addTopup = db.prepare('INSERT INTO balance_topups (id, user_id, amount_cents, stripe_payment_id) VALUES (@id, @user_id, @amount_cents, @stripe_payment_id)');

// ── Payout helpers ──
const addPayout = db.prepare('INSERT INTO payouts (id, user_id, amount_cents, status) VALUES (@id, @user_id, @amount_cents, @status)');
const updatePayoutStatus = db.prepare('UPDATE payouts SET status = ?, stripe_transfer_id = ? WHERE id = ?');

// ── Listings (public, aggregated) ──
const getListings = db.prepare(`
  SELECT
    provider,
    COUNT(*) as available_keys,
    MIN(price_per_1m_input) as min_price_input,
    MIN(price_per_1m_output) as min_price_output,
    AVG(price_per_1m_input) as avg_price_input,
    AVG(price_per_1m_output) as avg_price_output
  FROM seller_keys
  WHERE is_active = 1
    AND (spending_cap_cents IS NULL OR total_spent_cents < spending_cap_cents)
  GROUP BY provider
`);

module.exports = {
  db,
  upsertUser, getUser, ensureUser,
  addSellerKey, getSellerKeys, getSellerKeyFull, updateSellerKey, deleteSellerKey,
  findCheapestKey, incrementSellerSpend,
  addBuyerKey, getBuyerKeys, findBuyerByHash, deactivateBuyerKey, hashKey,
  creditBuyerBalance, debitBuyerBalance, creditSellerBalance, debitSellerBalance,
  addTransaction, getTransactionsByBuyer, getTransactionsBySeller,
  getSellerEarnings, getBuyerSpending,
  addTopup, addPayout, updatePayoutStatus,
  getListings,
};
