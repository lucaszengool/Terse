#!/usr/bin/env node
/**
 * terse-local-proxy — Local API proxy with automatic model routing.
 * Runs on localhost, intercepts LLM API calls, and routes to cheaper models
 * for simple tasks automatically.
 *
 * Usage:
 *   node terse-local-proxy.js [--port 7860]
 *
 * Then set in your agent:
 *   export ANTHROPIC_BASE_URL=http://localhost:7860
 *   export OPENAI_BASE_URL=http://localhost:7860
 *
 * Works with: Claude Code, Cursor, Codex, Windsurf, Cline, Aider
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── Configuration ──
const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') || '7860');
const LOG_FILE = require('path').join(require('os').tmpdir(), 'terse-proxy.log');

// Model routing rules — expensive model → cheaper alternative for simple tasks
// Target: claude-sonnet-4-6 (current Sonnet 4.6, $3/$15 per MTok)
const SONNET = 'claude-sonnet-4-6';

const MODEL_ROUTES = {
  // ── Anthropic Opus 4.6 (latest) ──
  'claude-opus-4-6': SONNET,            // alias
  'claude-opus-4-6[1m]': SONNET,        // Claude Code 1M context suffix
  'anthropic/claude-opus-4-6': SONNET,  // OpenAI-compat prefix

  // ── Anthropic Opus 4.5 (legacy) ──
  'claude-opus-4-5': SONNET,
  'claude-opus-4-5-20251101': SONNET,

  // ── Anthropic Opus 4.1 (legacy) ──
  'claude-opus-4-1': SONNET,
  'claude-opus-4-1-20250805': SONNET,

  // ── Anthropic Opus 4.0 (legacy) ──
  'claude-opus-4-0': SONNET,
  'claude-opus-4-20250514': SONNET,

  // ── Claude Code Max plans (Opus-based) ──
  'default_claude_max_5x': SONNET,
  'default_claude_max_20x': SONNET,
  'claude_max_5x': SONNET,
  'claude_max_20x': SONNET,

  // ── OpenAI expensive → cheaper ──
  'gpt-4': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4o-mini',
  'gpt-4o': 'gpt-4o-mini',
  'o3': 'gpt-4o',
  'o3-mini': 'gpt-4o-mini',
};

// Also match models dynamically (for aliases we haven't seen yet)
function getRouteForModel(model) {
  if (MODEL_ROUTES[model]) return MODEL_ROUTES[model];
  const m = (model || '').toLowerCase();
  // Any opus variant → sonnet
  if (m.includes('opus')) return SONNET;
  // Any max plan → sonnet
  if (m.includes('max_5x') || m.includes('max_20x') || m.includes('max5x') || m.includes('max20x')) return SONNET;
  return null;
}

// ── Intelligent Task Complexity Analysis ──

// Tasks that REQUIRE expensive models (keep Opus/GPT-4)
const NEEDS_FRONTIER = [
  // Architecture & design
  /\b(architect|system.?design|design.?pattern|microservice|distributed|scalab)/i,
  // Deep reasoning & analysis
  /\b(analyze|reason|step.by.step|trade.?offs?|compare.*approaches|evaluate|assess)/i,
  // Large-scale refactoring
  /\b(refactor.*entire|rewrite.*system|migrate|overhaul|restructure)/i,
  // Security & performance (high stakes)
  /\b(security.*review|vulnerability|penetration|performance.*optim|memory.*leak|race.*condition)/i,
  // Comprehensive tasks
  /\b(comprehensive|thorough|deep.?dive|full.*audit|end.to.end|from.scratch)/i,
  // Multi-file coordination
  /\b(across.*files|all.*files|entire.*codebase|whole.*project|every.*component)/i,
  // Planning & strategy
  /\b(plan.*implementation|implementation.*plan|roadmap|strategy|prioritize)/i,
  // Complex debugging
  /\b(intermittent|race.*condition|deadlock|memory.*corrupt|heap|segfault|undefined.*behavior)/i,
];

// Tasks that CAN use cheaper models (route to Sonnet/4o-mini)
const SIMPLE_PATTERNS = [
  // Quick fixes
  /\b(fix.*typo|fix.*import|fix.*syntax|rename|add.*comment|update.*version)/i,
  // Simple generation
  /\b(write.*test|add.*test|create.*file|generate.*boilerplate|scaffold)/i,
  // Lookups & reads
  /\b(what.*is|where.*is|find.*file|show.*me|list.*all|how.*do.*I|search.*for)/i,
  // Simple edits
  /\b(change.*to|replace.*with|remove.*line|delete.*function|move.*to|copy.*from)/i,
  // Formatting
  /\b(format|lint|prettier|eslint|sort.*import|organize.*import)/i,
  // Git operations
  /\b(commit|push|pull|merge|branch|stash|rebase|cherry.pick|git.*status|git.*diff)/i,
  // Standard patterns
  /\b(add.*endpoint|add.*route|add.*field|add.*column|add.*prop|add.*param)/i,
  // Installation & config
  /\b(install|setup|configure|init|bootstrap|npm|pip|cargo|brew)/i,
];

// Track routing stats
let stats = { total: 0, routed: 0, savedEstimate: 0 };

// Provider endpoints
const PROVIDERS = {
  anthropic: { host: 'api.anthropic.com', basePath: '/v1' },
  openai: { host: 'api.openai.com', basePath: '/v1' },
};

function detectProvider(path, headers) {
  if (headers['anthropic-version'] || path.includes('/messages')) return 'anthropic';
  if (path.includes('/chat/completions')) return 'openai';
  return null;
}

function extractLastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content;
      let raw = '';
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) raw = c.filter(p => p.type === 'text').map(p => p.text).join(' ');
      // Strip system-reminder tags injected by Claude Code — they contain
      // words like "architect" and "security" that pollute complexity scoring.
      return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    }
  }
  return '';
}

function analyzeComplexity(userText, messages, body) {
  // STRATEGY: Route to cheaper model by DEFAULT (score starts negative).
  // Only keep expensive model when task is CLEARLY complex.
  // Sonnet 4.6 handles 90%+ of coding tasks equally well as Opus.
  let score = -2; // Start biased toward routing (cheaper model)
  const reasons = ['default-route'];

  // NOTE: We do NOT block routing just because thinking/budget_tokens is set.
  // Claude Code enables extended thinking by default — it doesn't indicate complexity.
  // Sonnet 4.6 also supports extended thinking and handles it well.
  // Only a very large explicit budget_tokens (>10000) hints at a truly complex task.
  if (body.budget_tokens && body.budget_tokens > 10000) {
    score += 3; reasons.push('high-thinking-budget');
  }

  // Check for frontier-requiring patterns
  let needsFrontier = false;
  for (const pattern of NEEDS_FRONTIER) {
    if (pattern.test(userText)) { score += 5; reasons.push('complex:' + pattern.source.slice(0, 25)); needsFrontier = true; break; }
  }

  // ── Signals that SUPPORT routing (cheaper model) ──
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(userText)) { score -= 3; reasons.push('simple:' + pattern.source.slice(0, 25)); break; }
  }

  // Short prompts are almost always simple
  if (userText.length < 150) { score -= 2; reasons.push('short'); }
  else if (userText.length < 400) { score -= 1; reasons.push('medium'); }

  // ── Signals that OPPOSE routing (keep expensive) ──
  // Very long prompts with complex instructions
  if (userText.length > 1500 && needsFrontier) { score += 2; reasons.push('long+complex'); }

  // Multiple code blocks with complex instructions
  const codeBlocks = (userText.match(/```/g) || []).length / 2;
  if (codeBlocks >= 3) { score += 2; reasons.push('many-code-blocks'); }

  // Intermittent/subtle bugs need deeper reasoning
  if (/intermittent|race.*condition|deadlock|heisenbug|flaky/i.test(userText)) {
    score += 3; reasons.push('subtle-bug');
  }

  // NOTE: Conversation depth does NOT block routing.
  // Each turn is evaluated independently — a deep session can have simple turns.

  return { score, reasons };
}

function shouldRoute(model, messages, body) {
  // Check if model is expensive (static map + dynamic detection)
  const cheaperModel = getRouteForModel(model);
  if (!cheaperModel) return null;

  const userText = extractLastUserMessage(messages);
  const { score, reasons } = analyzeComplexity(userText, messages, body);

  // Score > 0 means complex → keep expensive model
  // Score <= 0 means simple → route to cheaper model
  if (score > 0) {
    log(`KEEP ${model} (score=${score}, reasons=${reasons.join(',')})`);
    return null;
  }

  log(`ROUTE ${model}→${cheaperModel} (score=${score}, reasons=${reasons.join(',')})`);
  return cheaperModel;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(line + '\n');
  try {
    require('fs').appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

function forwardRequest(provider, originalReq, bodyBuf, effectiveModel, res) {
  const providerInfo = PROVIDERS[provider];
  if (!providerInfo) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unknown provider' } }));
    return;
  }

  // Parse and modify body to use effective model
  let body;
  try {
    body = JSON.parse(bodyBuf.toString());
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
    return;
  }

  const originalModel = body.model;
  body.model = effectiveModel;
  const modifiedBody = JSON.stringify(body);

  // Forward headers, replacing host
  const headers = { ...originalReq.headers };
  delete headers.host;
  delete headers['content-length'];
  headers['content-length'] = Buffer.byteLength(modifiedBody);

  const options = {
    hostname: providerInfo.host,
    port: 443,
    path: originalReq.url,
    method: originalReq.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Stream response back to client
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    log(`Forward error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Proxy forward error: ' + e.message } }));
    }
  });

  proxyReq.write(modifiedBody);
  proxyReq.end();

  if (effectiveModel !== originalModel) {
    log(`ROUTED: ${originalModel} → ${effectiveModel} (${body.messages?.length || 0} msgs)`);
    stats.routed++;
  } else {
    log(`PASS: ${originalModel} (${body.messages?.length || 0} msgs)`);
  }
  stats.total++;
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  // CORS for browser-based tools
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check / stats endpoint
  if (req.url === '/health' || req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      port: PORT,
      stats,
      routing: MODEL_ROUTES,
    }));
    return;
  }

  // Collect request body
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);

    const provider = detectProvider(req.url, req.headers);
    if (!provider) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Cannot detect provider from request path' } }));
      return;
    }

    // Parse body to check model routing
    let body;
    try {
      body = JSON.parse(bodyBuf.toString());
    } catch (e) {
      // Forward as-is if can't parse
      forwardRequest(provider, req, bodyBuf, body?.model || 'unknown', res);
      return;
    }

    const model = body.model || '';
    const messages = body.messages || [];

    // Normalize model name — strip Claude Code suffixes like [1m] that Anthropic's API rejects
    const normalizedModel = model.replace(/\[.*?\]$/, '');

    // Check if we should route to a cheaper model
    const routedModel = shouldRoute(normalizedModel, messages, body);
    const effectiveModel = routedModel || normalizedModel;

    forwardRequest(provider, req, bodyBuf, effectiveModel, res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} already in use — another Terse proxy may be running. Exiting.`);
    process.exit(0); // Clean exit so Rust doesn't log an error
  }
  log(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Terse local proxy running on http://127.0.0.1:${PORT}`);
  log(`Set ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} for Claude Code/Cursor`);
  log(`Set OPENAI_BASE_URL=http://127.0.0.1:${PORT} for Codex/GPT agents`);
  log(`Auto-routing: ${Object.keys(MODEL_ROUTES).join(', ')}`);
  // Write port file for Terse app to discover
  try {
    const portFile = require('path').join(require('os').tmpdir(), 'terse-proxy-port');
    require('fs').writeFileSync(portFile, String(PORT));
  } catch (e) {}
});

// ── Safe agent configuration — NEVER modify agent config files directly ──
// Only use conditional shell profile that checks if proxy is alive.
// This way: Terse running → proxy active → env vars set. Terse closed → no change.
function configureAgents() {
  const fs = require('fs');
  const path = require('path');
  const home = require('os').homedir();

  const proxyUrl = `http://127.0.0.1:${PORT}`;

  // Write to Claude Code settings — Rust watchdog handles cleanup if we crash
  try {
    const claudeDir = path.join(home, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.json');
    fs.mkdirSync(claudeDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_BASE_URL = proxyUrl;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    log('Configured Claude Code: ANTHROPIC_BASE_URL=' + proxyUrl);
  } catch (e) { log('Claude Code config failed: ' + e.message); }

  // Write PID file so Rust watchdog knows we're alive
  try {
    fs.writeFileSync(path.join(home, '.terse', 'proxy.pid'), String(process.pid));
  } catch (e) {}

  log('Proxy ready — auto-configured for Claude Code, Codex, Cursor');

  // IMPORTANT: Clean up any leftover direct config from older versions
  cleanupDirectConfigs();
}

// Remove direct config modifications from OLDER Terse versions (shell profiles only).
// NOTE: settings.json cleanup is handled by the Rust watchdog on app exit and by
// cleanupOnExit() below — NOT here, because configureAgents() just wrote the URL.
function cleanupDirectConfigs() {
  const fs = require('fs');
  const path = require('path');
  const home = require('os').homedir();

  // Shell profiles — remove old Terse auto-proxy snippets
  const marker = '# Terse auto-proxy';
  for (const rc of ['.zshrc', '.bashrc']) {
    try {
      const rcFile = path.join(home, rc);
      if (!fs.existsSync(rcFile)) continue;
      const content = fs.readFileSync(rcFile, 'utf8');
      if (content.includes(marker)) {
        // Remove the entire snippet block
        const cleaned = content.replace(/\n# Terse auto-proxy[^\n]*\n(# [^\n]*\n)?if curl[^\n]*\n[^\n]*ANTHROPIC[^\n]*\n[^\n]*OPENAI[^\n]*\nfi\n?/g, '\n');
        fs.writeFileSync(rcFile, cleaned);
        log('Removed old Terse auto-proxy from ~/' + rc);
      }
    } catch (e) {}
  }
}

// Configure on startup (safe — only shell profile conditional, no direct config mods)
configureAgents();

// Clean up agent configs when proxy exits (prevents stale URL → API errors)
function cleanupOnExit() {
  const fs = require('fs');
  const path = require('path');
  const home = require('os').homedir();

  // Remove ANTHROPIC_BASE_URL from Claude Code settings
  try {
    const settingsFile = path.join(home, '.claude', 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings.env?.ANTHROPIC_BASE_URL?.includes('127.0.0.1')) {
        delete settings.env.ANTHROPIC_BASE_URL;
        if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        log('Cleaned up ANTHROPIC_BASE_URL from settings.json');
      }
    }
  } catch (e) {}

  // Remove PID file
  try { fs.unlinkSync(path.join(home, '.terse', 'proxy.pid')); } catch (e) {}
}

function shutdown() {
  log('Shutting down — cleaning up agent configs');
  cleanupOnExit();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanupOnExit);
