/**
 * SQLite database layer for Terse Marketplace.
 * Uses better-sqlite3 for synchronous, fast access.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Where terse.db lives.
//
// This used to be hardcoded to <repo>/data, which on Railway is inside the
// container's ephemeral filesystem — every redeploy would start from an empty
// database, taking users, referrals and gift codes with it. Worse, attaching a
// volume in the Railway dashboard would NOT have helped, because nothing here
// looked at where it was mounted.
//
// Resolution order:
//   1. TERSE_DATA_DIR            — explicit override (set this if unsure)
//   2. RAILWAY_VOLUME_MOUNT_PATH — set automatically when a volume is attached
//   3. <repo>/data               — local development
const DATA_DIR =
  process.env.TERSE_DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'terse.db');
// Printed on every boot so the deploy log answers "is my data on the volume?"
// without needing a shell. If this says /app/data in production, it is NOT.
console.log(`[db] sqlite: ${DB_FILE} (persistent=${
  !!(process.env.TERSE_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH)})`);

const db = new Database(DB_FILE);
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

  -- ── Terse Developer API Keys ──
  CREATE TABLE IF NOT EXISTS developer_api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    label TEXT,
    is_active INTEGER DEFAULT 1,
    requests_total INTEGER DEFAULT 0,
    tokens_optimized INTEGER DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dev_api_keys_hash ON developer_api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_dev_api_keys_user ON developer_api_keys(user_id);

  -- ── Vibe Coding Projects Platform ──
  CREATE TABLE IF NOT EXISTS vibe_projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    github_url TEXT,
    website_url TEXT,
    tags TEXT,
    tokens_saved_monthly INTEGER DEFAULT 0,
    cost_saved_monthly_cents INTEGER DEFAULT 0,
    upvotes INTEGER DEFAULT 0,
    is_published INTEGER DEFAULT 1,
    is_featured INTEGER DEFAULT 0,
    submitted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vibe_projects_published ON vibe_projects(is_published, submitted_at);

  -- ── Terse Cowork (collaborative multi-agent office) ──
  -- One row per live coding-agent session, upserted as the agent works.
  CREATE TABLE IF NOT EXISTS cowork_sessions (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES cloud_teams(id) ON DELETE CASCADE,
    user_email TEXT,
    device TEXT,            -- mac, windows, api
    agent_type TEXT,        -- claude-code, cursor, codex, aider, ...
    agent_name TEXT,
    project TEXT,
    model TEXT,
    status TEXT DEFAULT 'active',  -- active, idle, ended
    task TEXT,              -- current one-line activity summary
    context_window INTEGER DEFAULT 0,
    context_used INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    tokens_saved INTEGER DEFAULT 0,
    tool_calls INTEGER DEFAULT 0,
    turns INTEGER DEFAULT 0,
    seq INTEGER DEFAULT 0,  -- highest log seq seen for this session
    started_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    UNIQUE(team_id, user_email, device, agent_type, project)
  );

  -- Append-only working-log entries streamed from each session.
  CREATE TABLE IF NOT EXISTS cowork_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES cowork_sessions(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT,              -- user, assistant, tool, system
    kind TEXT,              -- message, tool_call, tool_result, notice
    tool TEXT,
    text TEXT,
    tokens INTEGER DEFAULT 0,
    occurred_at TEXT DEFAULT (datetime('now'))
  );

  -- Team chat / @mention / handoff messages.
  CREATE TABLE IF NOT EXISTS cowork_messages (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES cloud_teams(id) ON DELETE CASCADE,
    from_email TEXT,
    to_email TEXT,          -- NULL = broadcast to whole team
    session_id TEXT,        -- optional: attached to an agent session
    kind TEXT DEFAULT 'chat', -- chat, mention, handoff, ask
    body TEXT,
    status TEXT DEFAULT 'open', -- open, ack, done
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  -- Member presence per team.
  CREATE TABLE IF NOT EXISTS cowork_presence (
    team_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    status TEXT DEFAULT 'online',  -- online, away, offline
    device TEXT,
    last_seen_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, user_email)
  );

  CREATE INDEX IF NOT EXISTS idx_cowork_sessions_team ON cowork_sessions(team_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_cowork_log_session ON cowork_log(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_cowork_log_team ON cowork_log(team_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_cowork_messages_team ON cowork_messages(team_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_cowork_messages_inbox ON cowork_messages(team_id, to_email, status);

  -- ── Terse Rooms (shared wallpaper sessions) ──────────────────────────────
  -- A room is deliberately NOT a team. A team is who you work for; a room is who
  -- you are on the wallpaper with right now. You join one by code, which is why
  -- joining never implies friendship and leaving costs nothing.
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,          -- the short share code (also the QR payload)
    name TEXT,
    owner_key_hash TEXT NOT NULL,       -- whoever created it; can rename/close it
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  -- One row per participant. key_hash is the member's bearer credential: it is
  -- handed out once at join and never stored in the clear, same as team tokens.
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    member_id TEXT NOT NULL,            -- stable public id: what the wallpaper colours by
    name TEXT,
    user_email TEXT,                    -- optional; only set when the joiner is signed in
    status TEXT DEFAULT 'online',       -- online | away | offline
    last_seen_at TEXT DEFAULT (datetime('now')),
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, key_hash)
  );

  -- Chat. image_url is the only attachment kind: arbitrary file relay was
  -- deliberately left out, so anything else travels as a link inside body.
  CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    name TEXT,
    body TEXT,
    image_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at);

  -- Knocking: asking to enter a public room. The owner decides. A knock is keyed
  -- by the asker's install identity so the same person cannot flood a room with
  -- requests, and so an approval can be claimed later without a login.
  CREATE TABLE IF NOT EXISTS room_knocks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    identity_hash TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'pending',   -- pending | approved | denied | claimed
    created_at TEXT DEFAULT (datetime('now')),
    responded_at TEXT,
    UNIQUE(room_id, identity_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_knocks_room ON room_knocks(room_id, status);

  -- A friend link: possession IS the consent, so opening one befriends directly.
  -- It is revocable and countable, which a bare identity in a URL would not be.
  CREATE TABLE IF NOT EXISTS friend_invites (
    token TEXT PRIMARY KEY,
    owner_hash TEXT NOT NULL,
    owner_name TEXT,
    owner_email TEXT,
    uses INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_hash);

  -- ── Friends ──────────────────────────────────────────────────────────────
  -- Keyed by INSTALL IDENTITY, not by email. A room needs no account — the code
  -- is the credential — so demanding one the moment you want to keep someone
  -- would contradict the whole design. Each install holds a secret it generated
  -- itself; only its hash is ever stored, exactly like a room key. Email is kept
  -- when there is one, but purely to show a friendlier label.
  CREATE TABLE IF NOT EXISTS friend_links (
    id TEXT PRIMARY KEY,
    a_hash TEXT NOT NULL,            -- who asked (hash of their install secret)
    b_hash TEXT NOT NULL,            -- who was asked
    a_name TEXT, b_name TEXT,
    a_email TEXT, b_email TEXT,      -- optional, display only
    status TEXT DEFAULT 'pending',   -- pending | accepted | declined
    room_id TEXT,                    -- where they met
    created_at TEXT DEFAULT (datetime('now')),
    responded_at TEXT,
    UNIQUE(a_hash, b_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_friend_links_a ON friend_links(a_hash, status);
  CREATE INDEX IF NOT EXISTS idx_friend_links_b ON friend_links(b_hash, status);

  -- ── Terse Docs (Google-style collaborative documents) ──
  -- A standalone, shareable file (document | sheet | slides) that humans AND
  -- multiple people's agents co-edit live. The authoritative content is a JSON
  -- snapshot bumped one version per applied op; ops are appended to doc_ops and
  -- fanned out over SSE (cowork-bus). Sharing is by per-doc token, no team needed.
  CREATE TABLE IF NOT EXISTS docs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                  -- document | sheet | slides
    title TEXT DEFAULT 'Untitled',
    owner_user_id TEXT,
    owner_email TEXT,
    content TEXT NOT NULL,               -- JSON document model (authoritative)
    version INTEGER DEFAULT 0,           -- increments once per applied op
    share_token TEXT UNIQUE,             -- anyone with it joins via link
    share_role TEXT DEFAULT 'editor',    -- role the link grants: viewer | editor
    agents_paused INTEGER DEFAULT 0,     -- global "stop all agents" switch
    is_trashed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS doc_ops (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,            -- document version AFTER this op
    actor TEXT,                          -- display name / email
    actor_kind TEXT DEFAULT 'human',     -- human | agent
    op TEXT NOT NULL,                    -- JSON op
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS doc_collaborators (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    email TEXT,
    user_id TEXT,
    role TEXT DEFAULT 'editor',          -- owner | editor | viewer
    invited_by TEXT,
    invited_at TEXT DEFAULT (datetime('now')),
    UNIQUE(doc_id, email)
  );

  CREATE TABLE IF NOT EXISTS doc_presence (
    doc_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,              -- stable per-collaborator id
    name TEXT,
    kind TEXT DEFAULT 'human',           -- human | agent
    color TEXT,
    cursor TEXT,                         -- JSON {block / cell / slide}
    paused INTEGER DEFAULT 0,            -- per-agent stop flag
    status TEXT DEFAULT 'online',        -- online | away | offline
    last_seen_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (doc_id, actor_id)
  );

  CREATE TABLE IF NOT EXISTS doc_comments (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    anchor TEXT,                         -- blockId / cell ref / slide:block
    author TEXT,
    author_kind TEXT DEFAULT 'human',
    body TEXT,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_docs_owner ON docs(owner_user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_doc_ops_doc ON doc_ops(doc_id, version);
  CREATE INDEX IF NOT EXISTS idx_doc_collab_doc ON doc_collaborators(doc_id);
  CREATE INDEX IF NOT EXISTS idx_doc_collab_email ON doc_collaborators(email);
  CREATE INDEX IF NOT EXISTS idx_doc_comments_doc ON doc_comments(doc_id, created_at);
`);

// ── API-specific columns (safe migration) ─────────────────────────────────
// api_tier is separate from tier (app subscription) — different Stripe products
try { db.exec(`ALTER TABLE users ADD COLUMN api_tier TEXT DEFAULT 'free'`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN api_subscription_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN api_tokens_this_month INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN api_month_key TEXT DEFAULT ''`); } catch {}

// ── Referral program (dual-sided give-get) ────────────────────────────────
try { db.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN referred_by TEXT`); } catch {}      // referrer's user id
try { db.exec(`ALTER TABLE users ADD COLUMN bonus_pro_until TEXT`); } catch {}   // ISO ts of granted Pro
// Lifetime purchase — ISO ts of the one-time payment, and its Stripe payment_intent
// (kept for reconciliation/refunds). NULL means the user has not bought lifetime.
try { db.exec(`ALTER TABLE users ADD COLUMN lifetime_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN lifetime_payment_id TEXT`); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    referrer_id TEXT,
    referee_id TEXT UNIQUE,
    code TEXT,
    status TEXT DEFAULT 'pending',           -- pending → converted (referee started paid)
    created_at TEXT DEFAULT (datetime('now')),
    converted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

  -- Single-use gift codes that grant lifetime (买断) access. Pre-minted in
  -- batches and handed out personally; redeeming one sets users.lifetime_at,
  -- the same flag a paid lifetime purchase sets, so the license endpoint needs
  -- no special case. redeemed_by NULL = still unused; the claim is an atomic
  -- conditional UPDATE, so two people racing the same code cannot both win.
  CREATE TABLE IF NOT EXISTS gift_codes (
    code TEXT PRIMARY KEY,
    batch TEXT,
    kind TEXT DEFAULT 'lifetime',
    redeemed_by TEXT,
    redeemed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gift_codes_batch ON gift_codes(batch);
`);

const setReferralCode      = db.prepare(`UPDATE users SET referral_code = ? WHERE id = ?`);
const getUserByReferralCode = db.prepare(`SELECT * FROM users WHERE referral_code = ?`);
const setReferredBy        = db.prepare(`UPDATE users SET referred_by = ? WHERE id = ?`);
const setBonusProUntil     = db.prepare(`UPDATE users SET bonus_pro_until = ? WHERE id = ?`);

// ── Lifetime (one-time purchase) ──────────────────────────────────────────
// A lifetime buyer has NO Stripe subscription, so the license endpoint's
// subscription lookup would report them expired. This flag is the only record
// that they paid, and it must be checked before that lookup.
const setLifetime = db.prepare(
  `UPDATE users SET lifetime_at = ?, lifetime_payment_id = ? WHERE id = ?`
);
const addReferral          = db.prepare(`INSERT OR IGNORE INTO referrals (id, referrer_id, referee_id, code, status) VALUES (?, ?, ?, ?, 'pending')`);
const getReferralByReferee = db.prepare(`SELECT * FROM referrals WHERE referee_id = ?`);
const markReferralConverted = db.prepare(`UPDATE referrals SET status = 'converted', converted_at = datetime('now') WHERE referee_id = ? AND status = 'pending'`);
const countInvited         = db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?`);
// ── Gift codes (single-use lifetime) ──
const addGiftCode          = db.prepare(`INSERT OR IGNORE INTO gift_codes (code, batch, kind) VALUES (?, ?, ?)`);
const getGiftCode          = db.prepare(`SELECT * FROM gift_codes WHERE code = ?`);
// Atomic single-use claim: only succeeds while redeemed_by is still NULL, so a
// code cannot be spent twice even if two requests arrive at the same instant.
// Callers MUST check .changes === 1 rather than trusting a prior SELECT.
const claimGiftCode        = db.prepare(
  `UPDATE gift_codes SET redeemed_by = ?, redeemed_at = datetime('now')
     WHERE code = ? AND redeemed_by IS NULL`
);
const countGiftCodes       = db.prepare(
  `SELECT COUNT(*) AS total, SUM(redeemed_by IS NOT NULL) AS used FROM gift_codes WHERE batch = ?`
);
const countConverted       = db.prepare(`SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'converted'`);

/// Deterministic 6-char code — MUST match the desktop client's fallback
/// (src-tauri/src/lib.rs::referral_code_for) so codes are identical everywhere.
function referralCodeFor(id) {
  const d = crypto.createHash('sha256').update(String(id)).digest();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[d[i] % A.length];
  return s;
}

// ── Developer API key helpers ──
const addDevApiKey = db.prepare(`
  INSERT INTO developer_api_keys (id, user_id, key_hash, key_prefix, label)
  VALUES (@id, @user_id, @key_hash, @key_prefix, @label)
`);
const getDevApiKeysByUser = db.prepare('SELECT id, key_prefix, label, is_active, requests_total, tokens_optimized, last_used_at, created_at FROM developer_api_keys WHERE user_id = ? ORDER BY created_at DESC');
const findDevApiKeyByHash = db.prepare('SELECT * FROM developer_api_keys WHERE key_hash = ? AND is_active = 1');
// Tier-aware lookup — uses api_tier (separate from the app subscription tier)
const findDevApiKeyWithUser = db.prepare(`
  SELECT k.*, u.api_tier, u.api_tokens_this_month, u.api_month_key
  FROM developer_api_keys k JOIN users u ON k.user_id = u.id
  WHERE k.key_hash = ? AND k.is_active = 1
`);
const revokeDevApiKey = db.prepare('UPDATE developer_api_keys SET is_active = 0 WHERE id = ? AND user_id = ?');
const touchDevApiKey = db.prepare(`UPDATE developer_api_keys SET last_used_at = datetime('now'), requests_total = requests_total + 1, tokens_optimized = tokens_optimized + ? WHERE key_hash = ?`);
const incrementApiTokens = db.prepare(`UPDATE users SET api_tokens_this_month = api_tokens_this_month + ?, api_month_key = ? WHERE id = ?`);
const resetApiTokens    = db.prepare(`UPDATE users SET api_tokens_this_month = ?, api_month_key = ? WHERE id = ?`);
const updateUserTier    = db.prepare(`UPDATE users SET tier = ?, subscription_id = ?, stripe_customer_id = ?, status = ?, expires_at = ? WHERE id = ?`);
// API tier is tracked separately — does not touch the app tier column
const updateApiTier     = db.prepare(`UPDATE users SET api_tier = ?, api_subscription_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?`);

// ── Vibe projects helpers ──
const addVibeProject = db.prepare(`
  INSERT INTO vibe_projects (id, user_id, name, description, github_url, website_url, tags, tokens_saved_monthly, cost_saved_monthly_cents)
  VALUES (@id, @user_id, @name, @description, @github_url, @website_url, @tags, @tokens_saved_monthly, @cost_saved_monthly_cents)
`);
const getVibeProjects = db.prepare('SELECT * FROM vibe_projects WHERE is_published = 1 ORDER BY is_featured DESC, upvotes DESC, submitted_at DESC LIMIT ?');
const getVibeProjectsByUser = db.prepare('SELECT * FROM vibe_projects WHERE user_id = ? ORDER BY submitted_at DESC');
const upvoteVibeProject = db.prepare('UPDATE vibe_projects SET upvotes = upvotes + 1 WHERE id = ?');

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

// Agent-activity rollup for the team dashboard: classify recent coding-agent
// sessions (Claude Code, Codex, Cursor, …) by agent_type. Driven by cowork_sessions
// rather than cloud_events so it reflects live/recent agent work + context fill.
const getTeamByAgent = db.prepare(`
  SELECT agent_type,
    COUNT(*) as sessions,
    COUNT(DISTINCT user_email) as developers,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_out), 0) as tokens_out,
    COALESCE(SUM(tool_calls), 0) as tool_calls,
    COALESCE(AVG(CASE WHEN context_window > 0
      THEN CAST(context_used AS REAL) / context_window ELSE NULL END), 0) as avg_context_fill
  FROM cowork_sessions
  WHERE team_id = ? AND last_seen_at >= ?
  GROUP BY agent_type
  ORDER BY tokens_in DESC
`);

const getTeamAgentTotals = db.prepare(`
  SELECT COUNT(*) as total_sessions,
    COUNT(DISTINCT agent_type) as agent_types,
    COUNT(DISTINCT CASE WHEN project != '' THEN project END) as projects,
    COALESCE(SUM(tool_calls), 0) as tool_calls,
    COALESCE(SUM(tokens_in), 0) as tokens_in,
    COALESCE(SUM(tokens_out), 0) as tokens_out
  FROM cowork_sessions
  WHERE team_id = ? AND last_seen_at >= ?
`);

// ── Terse Cowork helpers ──
// Upsert a live agent session keyed by (team, member, device, agent, project).
const upsertCoworkSession = db.prepare(`
  INSERT INTO cowork_sessions
    (id, team_id, user_email, device, agent_type, agent_name, project, model, status, task,
     context_window, context_used, tokens_in, tokens_out, tokens_saved, tool_calls, turns, seq, last_seen_at)
  VALUES
    (@id, @team_id, @user_email, @device, @agent_type, @agent_name, @project, @model, @status, @task,
     @context_window, @context_used, @tokens_in, @tokens_out, @tokens_saved, @tool_calls, @turns, @seq, datetime('now'))
  ON CONFLICT(team_id, user_email, device, agent_type, project) DO UPDATE SET
    agent_name = @agent_name,
    model = @model,
    status = @status,
    task = @task,
    context_window = @context_window,
    context_used = @context_used,
    tokens_in = @tokens_in,
    tokens_out = @tokens_out,
    tokens_saved = @tokens_saved,
    tool_calls = @tool_calls,
    turns = @turns,
    seq = MAX(seq, @seq),
    last_seen_at = datetime('now'),
    ended_at = CASE WHEN @status = 'ended' THEN datetime('now') ELSE NULL END
`);
const getCoworkSessionByKey = db.prepare(`
  SELECT * FROM cowork_sessions
  WHERE team_id = ? AND user_email = ? AND device = ? AND agent_type = ? AND project = ?
`);
const getCoworkSession = db.prepare('SELECT * FROM cowork_sessions WHERE id = ?');
const getCoworkSessions = db.prepare(`
  SELECT * FROM cowork_sessions
  WHERE team_id = ? AND status != 'ended'
  ORDER BY last_seen_at DESC
`);
const bumpCoworkSessionSeq = db.prepare('UPDATE cowork_sessions SET seq = ? WHERE id = ?');
const endStaleCoworkSessions = db.prepare(`
  UPDATE cowork_sessions SET status = 'ended', ended_at = datetime('now')
  WHERE status != 'ended' AND last_seen_at < datetime('now', ?)
`);
const idleStaleCoworkSessions = db.prepare(`
  UPDATE cowork_sessions SET status = 'idle'
  WHERE status = 'active' AND last_seen_at < datetime('now', ?)
`);
// Rows about to be transitioned by a sweep — selected first so the change can be broadcast.
const getStaleActiveSessions = db.prepare(`
  SELECT * FROM cowork_sessions
  WHERE status != 'ended' AND last_seen_at < datetime('now', ?)
`);
const getFreshlyIdleSessions = db.prepare(`
  SELECT * FROM cowork_sessions
  WHERE status = 'active' AND last_seen_at < datetime('now', ?)
`);

const addCoworkLog = db.prepare(`
  INSERT INTO cowork_log (id, session_id, team_id, seq, role, kind, tool, text, tokens)
  VALUES (@id, @session_id, @team_id, @seq, @role, @kind, @tool, @text, @tokens)
`);
const getCoworkLog = db.prepare(`
  SELECT * FROM cowork_log WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500
`);
const getCoworkFeed = db.prepare(`
  SELECT l.*, s.user_email, s.agent_type, s.agent_name, s.project
  FROM cowork_log l JOIN cowork_sessions s ON s.id = l.session_id
  WHERE l.team_id = ? AND l.occurred_at > ?
  ORDER BY l.occurred_at DESC LIMIT 200
`);

const addCoworkMessage = db.prepare(`
  INSERT INTO cowork_messages (id, team_id, from_email, to_email, session_id, kind, body, status)
  VALUES (@id, @team_id, @from_email, @to_email, @session_id, @kind, @body, @status)
`);
const getCoworkMessage = db.prepare('SELECT * FROM cowork_messages WHERE id = ?');

// Ownership follows the PERSON, not the key they happened to create with. A room
// outlives everyone leaving, so an owner who leaves and comes back — or joins
// from a second window — must still own it.
try { db.exec(`ALTER TABLE rooms ADD COLUMN owner_identity TEXT`); } catch {}

// Discovery. A room is PRIVATE unless its owner opts in — strangers finding you
// has to be a decision, never a default.
try { db.exec(`ALTER TABLE rooms ADD COLUMN visibility TEXT DEFAULT 'private'`); } catch {}
try { db.exec(`ALTER TABLE rooms ADD COLUMN category TEXT`); } catch {}

// A room member carries the install identity that outlives the room, so a
// friendship made inside one survives it closing.
try { db.exec(`ALTER TABLE room_members ADD COLUMN identity_hash TEXT`); } catch {}

// ── Terse Rooms ──
const createRoom = db.prepare(`
  INSERT INTO rooms (id, code, name, owner_key_hash) VALUES (@id, @code, @name, @owner_key_hash)
`);
const getRoomById = db.prepare('SELECT * FROM rooms WHERE id = ? AND closed_at IS NULL');
const getRoomByCode = db.prepare('SELECT * FROM rooms WHERE code = ? AND closed_at IS NULL');
const closeRoom = db.prepare("UPDATE rooms SET closed_at = datetime('now') WHERE id = ?");
const renameRoom = db.prepare('UPDATE rooms SET name = ? WHERE id = ?');

const addRoomMember = db.prepare(`
  INSERT INTO room_members (room_id, key_hash, member_id, name, user_email, identity_hash)
  VALUES (@room_id, @key_hash, @member_id, @name, @user_email, @identity_hash)
  ON CONFLICT(room_id, key_hash) DO UPDATE SET
    name = excluded.name, status = 'online', last_seen_at = datetime('now')
`);
const getRoomMember = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND key_hash = ?');
const findRoomMemberByKey = db.prepare('SELECT * FROM room_members WHERE key_hash = ?');
const getRoomMembers = db.prepare(`
  SELECT member_id, name, user_email, status, last_seen_at, joined_at, identity_hash
  FROM room_members WHERE room_id = ? ORDER BY joined_at
`);
const touchRoomMember = db.prepare(`
  UPDATE room_members SET status = ?, last_seen_at = datetime('now')
  WHERE room_id = ? AND key_hash = ?
`);
const renameRoomMember = db.prepare(
  'UPDATE room_members SET name = ? WHERE room_id = ? AND key_hash = ?');
// A nickname is a property of the PERSON, not of one seat: changing it should
// change it everywhere they are, not only in the room they happen to be in.
const renameRoomMemberEverywhere = db.prepare(
  'UPDATE room_members SET name = ? WHERE identity_hash = ?');
const removeRoomMember = db.prepare('DELETE FROM room_members WHERE room_id = ? AND key_hash = ?');
// Re-entering a room you already belong to must REPLACE your seat, never add a
// second one: a new key is minted on every join, so without this a person who
// comes back three times is three people in the roster and three in the plaza's
// member count — all but one of them permanently offline ghosts.
const findRoomMemberByIdentity = db.prepare(`
  SELECT * FROM room_members WHERE room_id = ? AND identity_hash = ? ORDER BY joined_at LIMIT 1
`);
const removeRoomMembersByIdentity = db.prepare(
  'DELETE FROM room_members WHERE room_id = ? AND identity_hash = ?');
// Presence decays instead of relying on a clean disconnect: a closed laptop never
// sends "offline", so anyone who stops heartbeating is aged out by the reader.
const ageOutRoomMembers = db.prepare(`
  UPDATE room_members SET status = 'offline'
  WHERE status != 'offline' AND last_seen_at < datetime('now', ?)
`);

const addRoomMessage = db.prepare(`
  INSERT INTO room_messages (id, room_id, member_id, name, body, image_url)
  VALUES (@id, @room_id, @member_id, @name, @body, @image_url)
`);
const getRoomMessage = db.prepare('SELECT rowid AS seq, * FROM room_messages WHERE id = ?');
// Scrollback. A chat window is judged on whether yesterday is still there, and
// the snapshot deliberately carries only the tail — so older pages are fetched
// by asking for what came before the oldest line already on screen, by seq.
const getRoomMessagesBefore = db.prepare(`
  SELECT rowid AS seq, * FROM room_messages
  WHERE room_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?
`);
// ── Discovery + knocking ──
const setRoomOwnerIdentity = db.prepare('UPDATE rooms SET owner_identity = ? WHERE id = ?');
const setRoomListing = db.prepare('UPDATE rooms SET visibility = ?, category = ? WHERE id = ?');
// Ordered by who is actually there — a directory whose first screen is dead
// rooms is worse than an empty one — but nothing is hidden: a room with nobody
// online is still a room you can knock on, and its owner may well be back.
// `joined`/`owner` are answered for the BROWSER, not about the room: a plaza
// that offers "ask to join" for a room you are already in (or own) is a dead
// button — you knock, the owner never sees a stranger, and nothing happens.
const listPublicRooms = db.prepare(`
  SELECT r.id, r.code, r.name, r.category, r.created_at,
         COUNT(m.member_id) AS members,
         COALESCE(SUM(CASE WHEN m.status = 'online' THEN 1 ELSE 0 END), 0) AS online,
         CASE WHEN @identity IS NOT NULL AND r.owner_identity = @identity THEN 1 ELSE 0 END AS owner,
         (SELECT COUNT(*) FROM room_members x
           WHERE x.room_id = r.id AND x.identity_hash = @identity) AS joined
  FROM rooms r
  LEFT JOIN room_members m ON m.room_id = r.id
  WHERE r.closed_at IS NULL AND r.visibility = 'public'
    AND (@category IS NULL OR r.category = @category)
  GROUP BY r.id
  ORDER BY online DESC, members DESC, r.created_at DESC
  LIMIT @limit
`);
/* Every room this install can walk back into — the ones it joined and the ones
   it owns, whether or not it is present in them right now. Membership outlives
   presence (only the owner can close a room), so "recent rooms" is a server
   fact, not a browser one: clearing localStorage, or reinstalling, must not be
   what destroys the way back into a room you own.
   Counts are subqueries rather than joins on purpose — a join against
   room_members twice multiplies the SUM once someone has two seats. */
const listRoomsForIdentity = db.prepare(`
  SELECT r.id, r.code, r.name, r.category, r.visibility, r.created_at,
         CASE WHEN r.owner_identity = @identity THEN 1 ELSE 0 END AS owner,
         (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members,
         (SELECT COUNT(*) FROM room_members m
           WHERE m.room_id = r.id AND m.status = 'online') AS online,
         (SELECT COUNT(*) FROM room_members m
           WHERE m.room_id = r.id AND m.identity_hash = @identity) AS joined,
         (SELECT MAX(m.last_seen_at) FROM room_members m
           WHERE m.room_id = r.id AND m.identity_hash = @identity) AS last_seen_at
  FROM rooms r
  WHERE r.closed_at IS NULL
    AND (r.owner_identity = @identity
         OR EXISTS (SELECT 1 FROM room_members m
                     WHERE m.room_id = r.id AND m.identity_hash = @identity))
  ORDER BY COALESCE(last_seen_at, r.created_at) DESC
  LIMIT @limit
`);
// One active room at a time. Membership is NOT revoked — a room you joined is
// still yours to return to — you simply go quiet everywhere you are not.
const goOfflineElsewhere = db.prepare(`
  UPDATE room_members SET status = 'offline'
  WHERE identity_hash = @identity AND room_id != @room_id AND status != 'offline'
`);
const roomsIdleFor = db.prepare(`
  SELECT DISTINCT room_id FROM room_members
  WHERE identity_hash = ? AND room_id != ? AND status != 'offline'
`);

const addKnock = db.prepare(`
  INSERT INTO room_knocks (id, room_id, identity_hash, name)
  VALUES (@id, @room_id, @identity_hash, @name)
  ON CONFLICT(room_id, identity_hash) DO UPDATE SET
    name = excluded.name,
    status = CASE WHEN room_knocks.status = 'denied' THEN 'denied' ELSE 'pending' END
`);
const getKnock = db.prepare('SELECT * FROM room_knocks WHERE id = ?');
const getKnockFor = db.prepare('SELECT * FROM room_knocks WHERE room_id = ? AND identity_hash = ?');
const listKnocks = db.prepare("SELECT * FROM room_knocks WHERE room_id = ? AND status = 'pending' ORDER BY created_at");
const setKnockStatus = db.prepare("UPDATE room_knocks SET status = ?, responded_at = datetime('now') WHERE id = ?");

// ── Friend links ──
const addFriendInvite = db.prepare(`
  INSERT INTO friend_invites (token, owner_hash, owner_name, owner_email)
  VALUES (@token, @owner_hash, @owner_name, @owner_email)
`);
const getFriendInvite = db.prepare('SELECT * FROM friend_invites WHERE token = ?');
const bumpFriendInvite = db.prepare('UPDATE friend_invites SET uses = uses + 1 WHERE token = ?');
const getFriendInviteByOwner = db.prepare('SELECT * FROM friend_invites WHERE owner_hash = ? ORDER BY created_at DESC LIMIT 1');
const deleteFriendInvite = db.prepare('DELETE FROM friend_invites WHERE token = ?');

// ── Friends ──
const addFriendRequest = db.prepare(`
  INSERT INTO friend_links (id, a_hash, b_hash, a_name, b_name, a_email, b_email, room_id)
  VALUES (@id, @a_hash, @b_hash, @a_name, @b_name, @a_email, @b_email, @room_id)
`);
const getFriendById = db.prepare('SELECT * FROM friend_links WHERE id = ?');
// Read in both directions: the edge is stored once, in the direction it was asked.
const getFriendEdge = db.prepare(`
  SELECT * FROM friend_links
  WHERE (a_hash = @x AND b_hash = @y) OR (a_hash = @y AND b_hash = @x)
`);
const listFriendEdges = db.prepare(`
  SELECT * FROM friend_links WHERE a_hash = ? OR b_hash = ? ORDER BY created_at DESC
`);
const respondFriend = db.prepare(`
  UPDATE friend_links SET status = ?, responded_at = datetime('now') WHERE id = ?
`);
const deleteFriend = db.prepare('DELETE FROM friend_links WHERE id = ?');

/* Ordered by ROWID, not by created_at. created_at has one-second resolution, so
   several messages routinely share it — and the tie was being broken by a random
   UUID, which is to say arbitrarily: two lines sent in the same second could come
   back in the wrong order, and a "give me what came before this" cursor could not
   be expressed at all. rowid is insertion order and strictly increasing, which is
   what both the ordering and the scrollback cursor actually need. */
const getRoomMessages = db.prepare(`
  SELECT rowid AS seq, * FROM room_messages WHERE room_id = ? ORDER BY rowid DESC LIMIT ?
`);
const getCoworkMessages = db.prepare(`
  SELECT * FROM cowork_messages WHERE team_id = ? AND created_at > ?
  ORDER BY created_at DESC LIMIT 200
`);
const getCoworkInbox = db.prepare(`
  SELECT * FROM cowork_messages
  WHERE team_id = ? AND (to_email = ? OR to_email IS NULL) AND status != 'done'
  ORDER BY created_at DESC LIMIT 100
`);
const resolveCoworkMessage = db.prepare(`
  UPDATE cowork_messages SET status = ?, resolved_at = datetime('now')
  WHERE id = ? AND team_id = ?
`);

const upsertCoworkPresence = db.prepare(`
  INSERT INTO cowork_presence (team_id, user_email, status, device, last_seen_at)
  VALUES (@team_id, @user_email, @status, @device, datetime('now'))
  ON CONFLICT(team_id, user_email) DO UPDATE SET
    status = @status, device = @device, last_seen_at = datetime('now')
`);
const getCoworkPresence = db.prepare(`
  SELECT * FROM cowork_presence WHERE team_id = ? ORDER BY last_seen_at DESC
`);
const getStalePresence = db.prepare(`
  SELECT * FROM cowork_presence WHERE status = ? AND last_seen_at < datetime('now', ?)
`);
const setPresenceStatus = db.prepare(`
  UPDATE cowork_presence SET status = ? WHERE team_id = ? AND user_email = ?
`);

// ── Terse Docs helpers ──
const createDoc = db.prepare(`
  INSERT INTO docs (id, kind, title, owner_user_id, owner_email, content, share_token, share_role)
  VALUES (@id, @kind, @title, @owner_user_id, @owner_email, @content, @share_token, @share_role)
`);
const getDoc = db.prepare('SELECT * FROM docs WHERE id = ?');
const getDocByShareToken = db.prepare('SELECT * FROM docs WHERE share_token = ?');
const getDocsByOwner = db.prepare(`
  SELECT id, kind, title, owner_email, version, share_role, is_trashed, created_at, updated_at
  FROM docs WHERE owner_user_id = ? AND is_trashed = 0 ORDER BY updated_at DESC LIMIT 200
`);
const getDocsSharedWith = db.prepare(`
  SELECT d.id, d.kind, d.title, d.owner_email, d.version, c.role AS member_role, d.updated_at
  FROM docs d JOIN doc_collaborators c ON c.doc_id = d.id
  WHERE c.email = ? AND d.is_trashed = 0 AND d.owner_user_id IS NOT ?
  ORDER BY d.updated_at DESC LIMIT 200
`);
const updateDocContent = db.prepare(`
  UPDATE docs SET content = @content, version = @version, updated_at = datetime('now') WHERE id = @id
`);
const renameDoc = db.prepare("UPDATE docs SET title = ?, updated_at = datetime('now') WHERE id = ?");
const setDocShareRole = db.prepare('UPDATE docs SET share_role = ? WHERE id = ?');
const setDocAgentsPaused = db.prepare('UPDATE docs SET agents_paused = ? WHERE id = ?');
const trashDoc = db.prepare('UPDATE docs SET is_trashed = 1 WHERE id = ? AND owner_user_id = ?');

const addDocOp = db.prepare(`
  INSERT INTO doc_ops (id, doc_id, version, actor, actor_kind, op)
  VALUES (@id, @doc_id, @version, @actor, @actor_kind, @op)
`);
const getDocOps = db.prepare('SELECT * FROM doc_ops WHERE doc_id = ? AND version > ? ORDER BY version ASC LIMIT 1000');

const addDocCollaborator = db.prepare(`
  INSERT INTO doc_collaborators (id, doc_id, email, user_id, role, invited_by)
  VALUES (@id, @doc_id, @email, @user_id, @role, @invited_by)
  ON CONFLICT(doc_id, email) DO UPDATE SET role = @role
`);
const getDocCollaborators = db.prepare('SELECT * FROM doc_collaborators WHERE doc_id = ? ORDER BY invited_at ASC');
const getDocCollaborator = db.prepare('SELECT * FROM doc_collaborators WHERE doc_id = ? AND email = ?');
const removeDocCollaborator = db.prepare('DELETE FROM doc_collaborators WHERE doc_id = ? AND email = ?');

const upsertDocPresence = db.prepare(`
  INSERT INTO doc_presence (doc_id, actor_id, name, kind, color, cursor, status, last_seen_at)
  VALUES (@doc_id, @actor_id, @name, @kind, @color, @cursor, @status, datetime('now'))
  ON CONFLICT(doc_id, actor_id) DO UPDATE SET
    name = @name, kind = @kind, color = @color, cursor = @cursor,
    status = @status, last_seen_at = datetime('now')
`);
const getDocPresence = db.prepare("SELECT * FROM doc_presence WHERE doc_id = ? AND last_seen_at > datetime('now', '-2 minutes') ORDER BY last_seen_at DESC");
const getDocPresenceActor = db.prepare('SELECT * FROM doc_presence WHERE doc_id = ? AND actor_id = ?');
const setDocPresencePaused = db.prepare('UPDATE doc_presence SET paused = ? WHERE doc_id = ? AND actor_id = ?');
const setDocAgentsPausedPresence = db.prepare("UPDATE doc_presence SET paused = ? WHERE doc_id = ? AND kind = 'agent'");
const removeDocPresence = db.prepare('DELETE FROM doc_presence WHERE doc_id = ? AND actor_id = ?');

const addDocComment = db.prepare(`
  INSERT INTO doc_comments (id, doc_id, anchor, author, author_kind, body)
  VALUES (@id, @doc_id, @anchor, @author, @author_kind, @body)
`);
const getDocComments = db.prepare('SELECT * FROM doc_comments WHERE doc_id = ? ORDER BY created_at ASC LIMIT 500');
const resolveDocComment = db.prepare('UPDATE doc_comments SET resolved = 1 WHERE id = ? AND doc_id = ?');

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
  getTeamByModel, getTeamByMode, getTeamByAgent, getTeamAgentTotals,
  // Discovery, knocking, friend links
  setRoomListing, setRoomOwnerIdentity, listPublicRooms, listRoomsForIdentity,
  addKnock, getKnock, getKnockFor, listKnocks, setKnockStatus,
  goOfflineElsewhere, roomsIdleFor,
  addFriendInvite, getFriendInvite, bumpFriendInvite, getFriendInviteByOwner, deleteFriendInvite,
  // Friends
  addFriendRequest, getFriendById, getFriendEdge, listFriendEdges, respondFriend, deleteFriend,
  // Terse Rooms
  createRoom, getRoomById, getRoomByCode, closeRoom, renameRoom,
  addRoomMember, getRoomMember, findRoomMemberByKey, getRoomMembers,
  touchRoomMember, removeRoomMember, ageOutRoomMembers,
  renameRoomMember, renameRoomMemberEverywhere,
  findRoomMemberByIdentity, removeRoomMembersByIdentity,
  addRoomMessage, getRoomMessage, getRoomMessages, getRoomMessagesBefore,
  // Terse Cowork
  upsertCoworkSession, getCoworkSessionByKey, getCoworkSession, getCoworkSessions,
  bumpCoworkSessionSeq, endStaleCoworkSessions, idleStaleCoworkSessions,
  getStaleActiveSessions, getFreshlyIdleSessions,
  addCoworkLog, getCoworkLog, getCoworkFeed,
  addCoworkMessage, getCoworkMessage, getCoworkMessages, getCoworkInbox, resolveCoworkMessage,
  upsertCoworkPresence, getCoworkPresence, getStalePresence, setPresenceStatus,
  // Developer API
  addDevApiKey, getDevApiKeysByUser, findDevApiKeyByHash, findDevApiKeyWithUser,
  revokeDevApiKey, touchDevApiKey, incrementApiTokens, resetApiTokens,
  updateUserTier, updateApiTier,
  // Referral program
  setReferralCode, getUserByReferralCode, setReferredBy, setBonusProUntil, setLifetime,
  addReferral, getReferralByReferee, markReferralConverted, countInvited, countConverted,
  addGiftCode, getGiftCode, claimGiftCode, countGiftCodes,
  referralCodeFor,
  // Vibe Projects Platform
  addVibeProject, getVibeProjects, getVibeProjectsByUser, upvoteVibeProject,
  // Terse Docs
  createDoc, getDoc, getDocByShareToken, getDocsByOwner, getDocsSharedWith,
  updateDocContent, renameDoc, setDocShareRole, setDocAgentsPaused, trashDoc,
  addDocOp, getDocOps,
  addDocCollaborator, getDocCollaborators, getDocCollaborator, removeDocCollaborator,
  upsertDocPresence, getDocPresence, getDocPresenceActor, setDocPresencePaused,
  setDocAgentsPausedPresence, removeDocPresence,
  addDocComment, getDocComments, resolveDocComment,
};
