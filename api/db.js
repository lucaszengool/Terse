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
    optimization_mode TEXT DEFAULT 'normal',
    -- Token-based rate limits (seller controls how many tokens their key serves)
    token_cap_total INTEGER,          -- lifetime token cap (input+output combined)
    token_cap_hourly INTEGER,         -- max tokens per hour
    token_cap_daily INTEGER,          -- max tokens per day
    total_tokens_used INTEGER DEFAULT 0,
    hourly_tokens_used INTEGER DEFAULT 0,
    daily_tokens_used INTEGER DEFAULT 0,
    hourly_reset_at TEXT,
    daily_reset_at TEXT,
    -- Legacy cent-based columns (kept for migration compatibility)
    rate_limit_hourly_cents INTEGER,
    rate_limit_daily_cents INTEGER,
    hourly_spent_cents INTEGER DEFAULT 0,
    daily_spent_cents INTEGER DEFAULT 0,
    rate_limit_info TEXT,
    key_verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    email_sent INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

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

  -- ── Terse Pals purchases ──
  CREATE TABLE IF NOT EXISTS pet_purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pet_id TEXT NOT NULL,
    stripe_session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, pet_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pet_purchases_user ON pet_purchases(user_id);

  -- ── Terse Cloud (teams) ──
  CREATE TABLE IF NOT EXISTS cloud_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_user_id TEXT NOT NULL,
    plan TEXT DEFAULT 'team',
    seats INTEGER DEFAULT 5,
    company TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cloud_team_members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES cloud_teams(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    user_id TEXT,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(team_id, user_email)
  );

  CREATE TABLE IF NOT EXISTS cloud_team_tokens (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES cloud_teams(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cloud_events (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES cloud_teams(id) ON DELETE CASCADE,
    user_email TEXT,
    tool TEXT,            -- mac, windows, chrome, vscode, ios
    source TEXT,          -- browser, agent, editor, manual
    project TEXT,
    model TEXT,
    optimization_mode TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    tokens_saved INTEGER DEFAULT 0,
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cloud_team_members_team ON cloud_team_members(team_id);
  CREATE INDEX IF NOT EXISTS idx_cloud_team_tokens_hash ON cloud_team_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_cloud_events_team ON cloud_events(team_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_cloud_events_user ON cloud_events(team_id, user_email, occurred_at);
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

const updateStripeConnect = db.prepare('UPDATE users SET stripe_connect_id = ? WHERE id = ?');

// ── Seller key helpers ──
const addSellerKey = db.prepare(`
  INSERT INTO seller_keys (id, user_id, provider, encrypted_key, key_iv, key_tag, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, models_allowed, optimization_mode, token_cap_total, token_cap_hourly, token_cap_daily, rate_limit_hourly_cents, rate_limit_daily_cents, key_verified)
  VALUES (@id, @user_id, @provider, @encrypted_key, @key_iv, @key_tag, @label, @price_per_1m_input, @price_per_1m_output, @spending_cap_cents, @models_allowed, @optimization_mode, @token_cap_total, @token_cap_hourly, @token_cap_daily, @rate_limit_hourly_cents, @rate_limit_daily_cents, @key_verified)
`);

const getSellerKeys = db.prepare('SELECT id, user_id, provider, label, price_per_1m_input, price_per_1m_output, spending_cap_cents, total_spent_cents, is_active, models_allowed, optimization_mode, token_cap_total, token_cap_hourly, token_cap_daily, total_tokens_used, hourly_tokens_used, daily_tokens_used, rate_limit_hourly_cents, rate_limit_daily_cents, hourly_spent_cents, daily_spent_cents, rate_limit_info, key_verified, created_at FROM seller_keys WHERE user_id = ?');
const getSellerKeyFull = db.prepare('SELECT * FROM seller_keys WHERE id = ? AND user_id = ?');
const updateSellerKey = db.prepare('UPDATE seller_keys SET price_per_1m_input = @price_per_1m_input, price_per_1m_output = @price_per_1m_output, spending_cap_cents = @spending_cap_cents, is_active = @is_active, models_allowed = @models_allowed, optimization_mode = @optimization_mode, token_cap_total = @token_cap_total, token_cap_hourly = @token_cap_hourly, token_cap_daily = @token_cap_daily, rate_limit_hourly_cents = @rate_limit_hourly_cents, rate_limit_daily_cents = @rate_limit_daily_cents WHERE id = @id AND user_id = @user_id');
const deleteSellerKey = db.prepare('DELETE FROM seller_keys WHERE id = ? AND user_id = ?');
const updateRateLimitInfo = db.prepare('UPDATE seller_keys SET rate_limit_info = ? WHERE id = ?');
const markKeyVerified = db.prepare('UPDATE seller_keys SET key_verified = 1 WHERE id = ?');
const incrementHourlySpend = db.prepare('UPDATE seller_keys SET hourly_spent_cents = hourly_spent_cents + ? WHERE id = ?');
const incrementDailySpend = db.prepare('UPDATE seller_keys SET daily_spent_cents = daily_spent_cents + ? WHERE id = ?');
const resetHourlySpend = db.prepare("UPDATE seller_keys SET hourly_spent_cents = 0, hourly_tokens_used = 0, hourly_reset_at = datetime('now', '+1 hour') WHERE id = ?");
const resetDailySpend = db.prepare("UPDATE seller_keys SET daily_spent_cents = 0, daily_tokens_used = 0, daily_reset_at = datetime('now', '+1 day') WHERE id = ?");

// Token-based tracking
const incrementTokenUsage = db.prepare('UPDATE seller_keys SET total_tokens_used = total_tokens_used + ?, hourly_tokens_used = hourly_tokens_used + ?, daily_tokens_used = daily_tokens_used + ? WHERE id = ?');

// Find cheapest active seller key for a provider (respects both token and dollar limits)
const findCheapestKey = db.prepare(`
  SELECT * FROM seller_keys
  WHERE provider = ? AND is_active = 1
    AND (spending_cap_cents IS NULL OR total_spent_cents < spending_cap_cents)
    AND (token_cap_total IS NULL OR total_tokens_used < token_cap_total)
    AND (token_cap_hourly IS NULL OR hourly_tokens_used < token_cap_hourly)
    AND (token_cap_daily IS NULL OR daily_tokens_used < token_cap_daily)
    AND (rate_limit_hourly_cents IS NULL OR hourly_spent_cents < rate_limit_hourly_cents)
    AND (rate_limit_daily_cents IS NULL OR daily_spent_cents < rate_limit_daily_cents)
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

// ── Detailed listings (public, per-key, no secrets exposed) ──
const getDetailedListings = db.prepare(`
  SELECT
    id, provider, label, price_per_1m_input, price_per_1m_output,
    optimization_mode, key_verified,
    token_cap_total, token_cap_hourly, token_cap_daily,
    total_tokens_used, hourly_tokens_used, daily_tokens_used,
    rate_limit_info, created_at
  FROM seller_keys
  WHERE is_active = 1
    AND (spending_cap_cents IS NULL OR total_spent_cents < spending_cap_cents)
    AND (token_cap_total IS NULL OR total_tokens_used < token_cap_total)
  ORDER BY price_per_1m_input ASC
`);

// ── Notification helpers ──
const addNotification = db.prepare(`
  INSERT INTO notifications (id, user_id, type, title, body)
  VALUES (@id, @user_id, @type, @title, @body)
`);
const getNotifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
const markNotificationRead = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?');
const markNotificationEmailed = db.prepare('UPDATE notifications SET email_sent = 1 WHERE id = ?');
const getUnreadCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0');

// ── Terse Cloud helpers ──
const createTeam = db.prepare(`
  INSERT INTO cloud_teams (id, name, slug, owner_user_id, plan, seats, company)
  VALUES (@id, @name, @slug, @owner_user_id, @plan, @seats, @company)
`);
const getTeamById = db.prepare('SELECT * FROM cloud_teams WHERE id = ?');
const getTeamBySlug = db.prepare('SELECT * FROM cloud_teams WHERE slug = ?');
const getTeamsByOwner = db.prepare('SELECT * FROM cloud_teams WHERE owner_user_id = ? ORDER BY created_at DESC');
const getTeamsByMemberEmail = db.prepare(`
  SELECT t.*, m.role AS member_role FROM cloud_teams t
  JOIN cloud_team_members m ON m.team_id = t.id
  WHERE m.user_email = ?
  ORDER BY t.created_at DESC
`);
const getTeamsByMemberUserId = db.prepare(`
  SELECT t.*, m.role AS member_role FROM cloud_teams t
  JOIN cloud_team_members m ON m.team_id = t.id
  WHERE m.user_id = ?
  ORDER BY t.created_at DESC
`);
const updateTeam = db.prepare('UPDATE cloud_teams SET name = @name, company = @company, seats = @seats WHERE id = @id');
const deleteTeam = db.prepare('DELETE FROM cloud_teams WHERE id = ? AND owner_user_id = ?');
const setMemberUserId = db.prepare('UPDATE cloud_team_members SET user_id = ? WHERE user_email = ? AND user_id IS NULL');

const addTeamMember = db.prepare(`
  INSERT OR IGNORE INTO cloud_team_members (id, team_id, user_email, user_id, role)
  VALUES (@id, @team_id, @user_email, @user_id, @role)
`);
const getTeamMembers = db.prepare('SELECT * FROM cloud_team_members WHERE team_id = ? ORDER BY joined_at ASC');
const removeTeamMember = db.prepare('DELETE FROM cloud_team_members WHERE id = ? AND team_id = ?');
const getMemberByEmail = db.prepare('SELECT * FROM cloud_team_members WHERE team_id = ? AND user_email = ?');

const addTeamToken = db.prepare(`
  INSERT INTO cloud_team_tokens (id, team_id, token_hash, label)
  VALUES (@id, @team_id, @token_hash, @label)
`);
const findTeamByToken = db.prepare(`
  SELECT t.* FROM cloud_teams t
  JOIN cloud_team_tokens tk ON tk.team_id = t.id
  WHERE tk.token_hash = ?
`);
const touchTeamToken = db.prepare("UPDATE cloud_team_tokens SET last_used_at = datetime('now') WHERE token_hash = ?");
const getTeamTokens = db.prepare('SELECT id, label, last_used_at, created_at FROM cloud_team_tokens WHERE team_id = ?');
const deleteTeamToken = db.prepare('DELETE FROM cloud_team_tokens WHERE id = ? AND team_id = ?');

const addCloudEvent = db.prepare(`
  INSERT INTO cloud_events (id, team_id, user_email, tool, source, project, model, optimization_mode, tokens_in, tokens_out, tokens_saved)
  VALUES (@id, @team_id, @user_email, @tool, @source, @project, @model, @optimization_mode, @tokens_in, @tokens_out, @tokens_saved)
`);

const getTeamEvents = db.prepare(`
  SELECT * FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ?
  ORDER BY occurred_at DESC LIMIT ?
`);

const getTeamSummary = db.prepare(`
  SELECT
    COUNT(*) as total_events,
    COALESCE(SUM(tokens_in), 0) as total_tokens_in,
    COALESCE(SUM(tokens_out), 0) as total_tokens_out,
    COALESCE(SUM(tokens_saved), 0) as total_tokens_saved,
    COUNT(DISTINCT user_email) as active_developers
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ?
`);

const getTeamByDeveloper = db.prepare(`
  SELECT user_email,
    COUNT(*) as events,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_saved), 0) as tokens_saved
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ?
  GROUP BY user_email
  ORDER BY tokens_saved DESC
`);

const getTeamByTool = db.prepare(`
  SELECT tool,
    COUNT(*) as events,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_saved), 0) as tokens_saved
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ?
  GROUP BY tool
  ORDER BY tokens_saved DESC
`);

const getTeamByProject = db.prepare(`
  SELECT project,
    COUNT(*) as events,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_saved), 0) as tokens_saved
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ? AND project IS NOT NULL AND project != ''
  GROUP BY project
  ORDER BY tokens_saved DESC
`);

const getTeamDaily = db.prepare(`
  SELECT substr(occurred_at, 1, 10) as date,
    COUNT(*) as events,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_saved), 0) as tokens_saved
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ?
  GROUP BY substr(occurred_at, 1, 10)
  ORDER BY date ASC
`);

const getTeamByModel = db.prepare(`
  SELECT model,
    COUNT(*) as events,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_saved), 0) as tokens_saved
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ? AND model IS NOT NULL AND model != ''
  GROUP BY model
  ORDER BY tokens_in DESC
`);

const getTeamByMode = db.prepare(`
  SELECT optimization_mode as mode,
    COUNT(*) as events,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_saved), 0) as tokens_saved
  FROM cloud_events
  WHERE team_id = ? AND occurred_at >= ? AND optimization_mode IS NOT NULL AND optimization_mode != ''
  GROUP BY optimization_mode
  ORDER BY tokens_in DESC
`);

// ── Pet purchase helpers ──
const addPetPurchase = db.prepare(`
  INSERT OR IGNORE INTO pet_purchases (id, user_id, pet_id, stripe_session_id)
  VALUES (@id, @user_id, @pet_id, @stripe_session_id)
`);
const getPetPurchases = db.prepare('SELECT pet_id FROM pet_purchases WHERE user_id = ?');

module.exports = {
  db,
  upsertUser, getUser, ensureUser, updateStripeConnect,
  addSellerKey, getSellerKeys, getSellerKeyFull, updateSellerKey, deleteSellerKey,
  findCheapestKey, incrementSellerSpend,
  updateRateLimitInfo, markKeyVerified,
  incrementHourlySpend, incrementDailySpend, resetHourlySpend, resetDailySpend, incrementTokenUsage,
  addBuyerKey, getBuyerKeys, findBuyerByHash, deactivateBuyerKey, hashKey,
  creditBuyerBalance, debitBuyerBalance, creditSellerBalance, debitSellerBalance,
  addTransaction, getTransactionsByBuyer, getTransactionsBySeller,
  getSellerEarnings, getBuyerSpending,
  addTopup, addPayout, updatePayoutStatus,
  getListings, getDetailedListings,
  addNotification, getNotifications, markNotificationRead, markNotificationEmailed, getUnreadCount,
  addPetPurchase, getPetPurchases,
  // Terse Cloud
  createTeam, getTeamById, getTeamBySlug, getTeamsByOwner, getTeamsByMemberEmail, getTeamsByMemberUserId, updateTeam, deleteTeam,
  addTeamMember, getTeamMembers, removeTeamMember, getMemberByEmail, setMemberUserId,
  addTeamToken, findTeamByToken, touchTeamToken, getTeamTokens, deleteTeamToken,
  addCloudEvent, getTeamEvents, getTeamSummary,
  getTeamByDeveloper, getTeamByTool, getTeamByProject, getTeamDaily,
  getTeamByModel, getTeamByMode,
};
