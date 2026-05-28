/**
 * Terse Developer API
 * Endpoints for vibe coding projects to optimize prompts and publish to the platform.
 *
 * Auth: Bearer tsk_... (developer API key)
 * Routes mounted at /api/v1
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const router = express.Router();

// Self-contained optimizer (same techniques as the Mac Tauri app, no extra deps)
const { optimize: optimizeText, estimateTokens } = require('./optimizer-lite');

// ────────────────────────────────────────
//  Tier limits
// ────────────────────────────────────────
const TIER_LIMITS = {
  free:    { req_per_min: 60,    tokens_per_month: 500_000 },
  pro:     { req_per_min: 600,   tokens_per_month: 50_000_000 },
  premium: { req_per_min: 6_000, tokens_per_month: -1 },
};

function tierLimits(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

const rateLimitMap = new Map(); // key_hash → { count, resetAt }
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(keyHash, maxPerMin) {
  const now = Date.now();
  let entry = rateLimitMap.get(keyHash);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(keyHash, entry);
  }
  entry.count++;
  return entry.count <= maxPerMin;
}

// ── Auth middleware ──
function requireApiKey(req, res, next) {
  const auth = req.headers['authorization'] || req.headers['x-api-key'];
  let rawKey = null;
  if (auth?.startsWith('Bearer ')) rawKey = auth.slice(7).trim();
  else if (auth) rawKey = auth.trim();

  if (!rawKey || !rawKey.startsWith('tsk_')) {
    return res.status(401).json({ error: 'Missing or invalid API key. Include Authorization: Bearer tsk_...' });
  }

  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  // Use tier-aware join so we can enforce per-plan limits
  const keyRow = db.findDevApiKeyWithUser.get(hash);
  if (!keyRow) return res.status(401).json({ error: 'Invalid API key' });

  const limits = tierLimits(keyRow.tier);

  if (!checkRateLimit(hash, limits.req_per_min)) {
    return res.status(429).json({
      error: `Rate limit exceeded (${limits.req_per_min} req/min on ${keyRow.tier} plan).`,
      upgrade: 'https://terseai.org/#pricing',
    });
  }

  // Monthly quota check + reset
  const month = currentMonth();
  if (keyRow.api_month_key !== month) {
    db.resetApiTokens.run(0, month, keyRow.user_id);
    keyRow.api_tokens_this_month = 0;
  }
  if (limits.tokens_per_month > 0 && keyRow.api_tokens_this_month >= limits.tokens_per_month) {
    return res.status(429).json({
      error: `Monthly token quota exceeded (${limits.tokens_per_month.toLocaleString()} tokens on ${keyRow.tier} plan).`,
      tokens_used: keyRow.api_tokens_this_month,
      tokens_limit: limits.tokens_per_month,
      upgrade: 'https://terseai.org/#pricing',
    });
  }

  req.apiKey = keyRow;
  req.apiKeyHash = hash;
  req.apiTier = keyRow.tier;
  next();
}

// ── Clerk auth middleware (for key management endpoints) ──
function requireClerkAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Clerk auth token' });
  const token = auth.slice(7);
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return res.status(401).json({ error: 'Invalid token' });
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.sub) return res.status(401).json({ error: 'Invalid token' });
    if (payload.exp && payload.exp * 1000 < Date.now()) return res.status(401).json({ error: 'Token expired' });
    req.userId = payload.sub;
    req.userEmail = payload.email || null;
    db.ensureUser(payload.sub, req.userEmail);
    next();
  } catch {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// ════════════════════════════════════════
//  KEY MANAGEMENT  (Clerk-auth)
// ════════════════════════════════════════

// POST /api/v1/keys — create new developer API key
router.post('/keys', express.json(), requireClerkAuth, (req, res) => {
  const label = (req.body?.label || 'Default').slice(0, 60);
  const rawKey = 'tsk_' + crypto.randomBytes(28).toString('base64url');
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.slice(0, 12) + '...';
  const id = crypto.randomUUID();

  try {
    db.addDevApiKey.run({ id, user_id: req.userId, key_hash: hash, key_prefix: prefix, label });
    res.json({ key: rawKey, prefix, label, id, created_at: new Date().toISOString() });
  } catch (err) {
    console.error('[terse-api] key create error:', err.message);
    res.status(500).json({ error: 'Failed to create key' });
  }
});

// GET /api/v1/keys — list developer API keys for the user
router.get('/keys', requireClerkAuth, (req, res) => {
  const keys = db.getDevApiKeysByUser.all(req.userId);
  res.json({ keys });
});

// DELETE /api/v1/keys/:id — revoke a key
router.delete('/keys/:id', requireClerkAuth, (req, res) => {
  db.revokeDevApiKey.run(req.params.id, req.userId);
  res.json({ ok: true });
});

// GET /api/v1/me — user connection status (is API connected, has usage, has published projects)
router.get('/me', requireClerkAuth, (req, res) => {
  const keys = db.getDevApiKeysByUser.all(req.userId);
  const projects = db.getVibeProjectsByUser.all(req.userId);
  const activeKeys = keys.filter(k => k.is_active);
  const connectedKey = activeKeys.find(k => k.requests_total > 0) || activeKeys[0] || null;
  res.json({
    connected: activeKeys.length > 0,
    has_usage: activeKeys.some(k => k.requests_total > 0),
    total_requests: activeKeys.reduce((a, k) => a + k.requests_total, 0),
    total_tokens_optimized: activeKeys.reduce((a, k) => a + k.tokens_optimized, 0),
    active_keys: activeKeys.length,
    connected_key: connectedKey ? { prefix: connectedKey.key_prefix, label: connectedKey.label, requests_total: connectedKey.requests_total, tokens_optimized: connectedKey.tokens_optimized } : null,
    published_projects: projects.length,
    projects: projects.map(p => ({ id: p.id, name: p.name, is_published: !!p.is_published, upvotes: p.upvotes })),
  });
});

// ════════════════════════════════════════
//  OPTIMIZE  (API-key auth)
// ════════════════════════════════════════

// POST /api/v1/optimize
// Body: { text: string, mode?: "soft"|"normal"|"aggressive" }
// Returns: { original: string, optimized: string, tokens_saved: number, reduction_pct: number, mode: string }
router.post('/optimize', express.json({ limit: '500kb' }), requireApiKey, async (req, res) => {
  const { text, mode = 'normal' } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Body must include "text" (string)' });
  }
  if (text.length > 50000) {
    return res.status(400).json({ error: 'text exceeds 50,000 character limit' });
  }
  const validModes = ['soft', 'normal', 'aggressive'];
  const safeMode = validModes.includes(mode) ? mode : 'normal';

  try {
    const result = optimizeText(text, safeMode);
    db.touchDevApiKey.run(result.tokens_saved, req.apiKeyHash);
    // Track monthly usage for quota enforcement
    db.incrementApiTokens.run(result.tokens_original || estimateTokens(text), currentMonth(), req.apiKey.user_id);
    res.json({
      original: text,
      optimized: result.optimized,
      tokens_original: result.tokens_original,
      tokens_optimized: result.tokens_optimized,
      tokens_saved: result.tokens_saved,
      reduction_pct: result.reduction_pct,
      techniques: result.techniques,
      mode: safeMode,
    });
  } catch (err) {
    console.error('[terse-api] optimize error:', err.message);
    res.status(500).json({ error: 'Optimization failed', detail: err.message });
  }
});

// ════════════════════════════════════════
//  SCAN  (API-key auth)
// ════════════════════════════════════════

// POST /api/v1/scan
// Body: { code: string, language?: string }
// Returns: { findings: [{line, type, prompt_preview, estimated_tokens, recommendation}], total_findings, estimated_monthly_savings }
router.post('/scan', express.json({ limit: '2mb' }), requireApiKey, (req, res) => {
  const { code, language = 'javascript' } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Body must include "code" (string)' });
  }
  if (code.length > 500000) {
    return res.status(400).json({ error: 'code exceeds 500,000 character limit' });
  }

  db.touchDevApiKey.run(0, req.apiKeyHash);

  const findings = scanCodeForLLMCalls(code, language);
  const estimatedMonthlySavings = Math.round(findings.reduce((acc, f) => acc + f.estimated_tokens * 0.30, 0));

  res.json({
    findings,
    total_findings: findings.length,
    estimated_monthly_savings_tokens: estimatedMonthlySavings,
    recommendation: findings.length === 0
      ? 'No LLM API call sites found. Make sure to pass the correct language.'
      : `Found ${findings.length} optimization opportunit${findings.length === 1 ? 'y' : 'ies'}. Wrapping these calls with Terse could save ~${estimatedMonthlySavings} tokens/month.`,
  });
});

// ════════════════════════════════════════
//  VIBE PROJECTS PLATFORM
// ════════════════════════════════════════

// GET /api/v1/projects — public list
router.get('/projects', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const projects = db.getVibeProjects.all(limit);
  res.json({
    projects: projects.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      github_url: p.github_url,
      website_url: p.website_url,
      tags: p.tags ? JSON.parse(p.tags) : [],
      tokens_saved_monthly: p.tokens_saved_monthly,
      cost_saved_monthly_cents: p.cost_saved_monthly_cents,
      upvotes: p.upvotes,
      is_featured: !!p.is_featured,
      submitted_at: p.submitted_at,
    })),
  });
});

// POST /api/v1/projects — submit a project (Clerk auth OR API key auth)
router.post('/projects', express.json(), (req, res, next) => {
  // Accept either Clerk token or developer API key
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer tsk_') || req.headers['x-api-key']?.startsWith('tsk_')) {
    return requireApiKey(req, res, () => {
      req.userId = req.apiKey.user_id;
      next();
    });
  }
  return requireClerkAuth(req, res, next);
}, (req, res) => {
  const { name, description, github_url, website_url, tags, tokens_saved_monthly, cost_saved_monthly_cents } = req.body || {};

  if (!name || !description) {
    return res.status(400).json({ error: 'name and description are required' });
  }
  if (name.length > 100 || description.length > 500) {
    return res.status(400).json({ error: 'name max 100 chars, description max 500 chars' });
  }

  // Validate URLs
  for (const url of [github_url, website_url]) {
    if (url && !/^https?:\/\/.+/.test(url)) {
      return res.status(400).json({ error: 'URLs must start with http:// or https://' });
    }
  }

  const id = crypto.randomUUID();
  try {
    db.addVibeProject.run({
      id,
      user_id: req.userId,
      name: name.slice(0, 100),
      description: description.slice(0, 500),
      github_url: github_url || null,
      website_url: website_url || null,
      tags: tags ? JSON.stringify((Array.isArray(tags) ? tags : [tags]).slice(0, 5).map(t => String(t).slice(0, 30))) : null,
      tokens_saved_monthly: Math.max(0, parseInt(tokens_saved_monthly) || 0),
      cost_saved_monthly_cents: Math.max(0, parseInt(cost_saved_monthly_cents) || 0),
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('[terse-api] project submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit project' });
  }
});

// POST /api/v1/projects/:id/upvote — upvote a project (no auth required)
router.post('/projects/:id/upvote', (req, res) => {
  try {
    db.upvoteVibeProject.run(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Project not found' });
  }
});

// ── LLM call site detector ──
const LLM_PATTERNS = [
  // JavaScript / TypeScript
  { re: /anthropic\.messages\.create\s*\(/g, type: 'anthropic_messages', lang: ['javascript', 'typescript'] },
  { re: /client\.messages\.create\s*\(/g, type: 'anthropic_messages', lang: ['javascript', 'typescript'] },
  { re: /openai\.chat\.completions\.create\s*\(/g, type: 'openai_chat', lang: ['javascript', 'typescript'] },
  { re: /client\.chat\.completions\.create\s*\(/g, type: 'openai_chat', lang: ['javascript', 'typescript'] },
  { re: /genai\.models\.generate_content/g, type: 'google_gemini', lang: ['javascript', 'typescript'] },
  { re: /fetch\s*\(\s*['"`][^'"]+anthropic[^'"]+['"`]/g, type: 'anthropic_http', lang: ['javascript', 'typescript'] },
  { re: /fetch\s*\(\s*['"`][^'"]+openai[^'"]+['"`]/g, type: 'openai_http', lang: ['javascript', 'typescript'] },
  // Python
  { re: /client\.messages\.create\s*\(/g, type: 'anthropic_messages', lang: ['python'] },
  { re: /anthropic\.Anthropic\s*\(/g, type: 'anthropic_init', lang: ['python'] },
  { re: /openai\.OpenAI\s*\(/g, type: 'openai_init', lang: ['python'] },
  { re: /client\.chat\.completions\.create\s*\(/g, type: 'openai_chat', lang: ['python'] },
  { re: /requests\.post\s*\([^)]*openai/g, type: 'openai_http', lang: ['python'] },
  { re: /requests\.post\s*\([^)]*anthropic/g, type: 'anthropic_http', lang: ['python'] },
  // Generic prompt strings
  { re: /["'`]messages["'`]\s*:/g, type: 'messages_array', lang: ['javascript', 'typescript', 'python'] },
  { re: /system_prompt\s*=/g, type: 'system_prompt', lang: ['javascript', 'typescript', 'python'] },
  { re: /user_prompt\s*=/g, type: 'user_prompt', lang: ['javascript', 'typescript', 'python'] },
];

const TYPE_RECOMMENDATIONS = {
  anthropic_messages: 'Wrap this call with Terse to auto-optimize the "content" field before it reaches the API.',
  openai_chat: 'Pass message content through Terse optimize() to reduce token count by 30–60%.',
  anthropic_http: 'Use Terse as a proxy (set ANTHROPIC_BASE_URL) or call the optimize API before this fetch.',
  openai_http: 'Use Terse as an OpenAI-compatible proxy or optimize the body payload before this fetch.',
  google_gemini: 'Pipe the "contents" field through Terse optimize() to reduce prompt tokens.',
  anthropic_init: 'Configure Terse middleware at the client level to intercept all calls automatically.',
  openai_init: 'Configure Terse middleware at the client level to intercept all calls automatically.',
  messages_array: 'Optimize message content strings with Terse before constructing this array.',
  system_prompt: 'System prompts are ideal candidates for aggressive mode (removes filler, compresses markdown).',
  user_prompt: 'Run user prompts through Terse soft or normal mode to fix typos and reduce filler.',
};

function scanCodeForLLMCalls(code, language) {
  const lang = (language || 'javascript').toLowerCase();
  const lines = code.split('\n');
  const findings = [];

  for (const pattern of LLM_PATTERNS) {
    if (!pattern.lang.includes(lang)) continue;
    let match;
    pattern.re.lastIndex = 0;
    while ((match = pattern.re.exec(code)) !== null) {
      const lineIndex = code.slice(0, match.index).split('\n').length - 1;
      const lineContent = lines[lineIndex] || '';
      const preview = lineContent.trim().slice(0, 80);

      // Try to estimate size of nearby string arguments
      const surrounding = code.slice(Math.max(0, match.index - 20), match.index + 300);
      const stringMatches = surrounding.match(/["'`]([^"'`]{20,})["'`]/g) || [];
      const avgStringLen = stringMatches.length
        ? stringMatches.reduce((a, s) => a + s.length, 0) / stringMatches.length
        : 100;
      const estimatedTokens = Math.ceil(avgStringLen / 4);

      findings.push({
        line: lineIndex + 1,
        type: pattern.type,
        preview,
        estimated_tokens: estimatedTokens,
        potential_savings_pct: pattern.type.includes('system_prompt') ? 45 : 35,
        recommendation: TYPE_RECOMMENDATIONS[pattern.type] || 'Wrap this LLM call with Terse to reduce token usage.',
      });
    }
  }

  // Deduplicate by line number (keep first match per line)
  const seen = new Set();
  return findings.filter(f => {
    if (seen.has(f.line)) return false;
    seen.add(f.line);
    return true;
  });
}

module.exports = router;
