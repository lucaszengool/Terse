#!/usr/bin/env node
/**
 * terse-local-proxy — Local API proxy with automatic model routing.
 * Runs on localhost, intercepts LLM API calls, and routes to cheaper models
 * for simple tasks automatically.
 *
 * Routing strategy (in priority order):
 *   1. ML classifier  — fine-tuned DistilBERT ONNX model (if available)
 *   2. Keyword rules  — pattern-based heuristic fallback (always available)
 *
 * Usage:
 *   node terse-local-proxy.js [--port 7860]
 *
 * Then set in your agent:
 *   export ANTHROPIC_BASE_URL=http://localhost:7860
 *   export OPENAI_BASE_URL=http://localhost:7860
 *
 * Works with: Claude Code, Cursor, Codex, Windsurf, Cline, Aider
 *
 * ML model setup (optional — enables semantic routing beyond keyword matching):
 *   1. Run: python ml/train.py
 *   2. Copy: cp ml/model/model_quantized.onnx ~/.terse/ml/complexity-model.onnx
 *            cp ml/model/complexity-vocab.json ~/.terse/ml/complexity-vocab.json
 *   3. Install runtime: cd ~/.terse && npm install onnxruntime-node
 *   4. Restart Terse — ML routing activates automatically.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── ML complexity classifier (optional — gracefully disabled if unavailable) ──
// Loaded from same dir as this script (when installed via Terse) or source dir.
let mlClassifier = null;
(function loadMLClassifier() {
  const path = require('path');
  const candidates = [
    path.join(__dirname, 'terse-complexity-classifier.js'),
    path.join(require('os').homedir(), '.terse', 'terse-complexity-classifier.js'),
  ];
  for (const p of candidates) {
    try {
      if (require('fs').existsSync(p)) {
        mlClassifier = require(p);
        break;
      }
    } catch (e) {
      // Non-critical — fall back to keyword rules
    }
  }
})();

// ── Configuration ──
// ── Doctor toggles (~/.terse/doctor.json) ──
// Written by the Doctor's one-click fixes in Rust. Re-read at most every 5s so
// a fix takes effect on the next request without restarting the proxy, but a
// busy request path never stats the file in a loop.
let _docCache = { at: 0, val: {} };
function doctorSettings() {
  const now = Date.now();
  if (now - _docCache.at < 5000) return _docCache.val;
  let val = {};
  try {
    const p = require('path').join(require('os').homedir(), '.terse', 'doctor.json');
    val = JSON.parse(require('fs').readFileSync(p, 'utf8')) || {};
  } catch (e) { val = {}; }
  _docCache = { at: now, val };
  return val;
}

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
  'o3': 'o4-mini',
  'o3-mini': 'o4-mini',
  // ── OpenAI Codex models ──
  'o4': 'o4-mini',
  'codex-davinci-002': 'o4-mini',

  // ── DeepSeek Harness: pro → flash (same 1M context, ~1/3 the price) ──
  'deepseek-v4-pro': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
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

// Cumulative Codex/OpenAI token stats extracted from SSE response streams
let codexTokenStats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 };
let dshTokenStats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 };

// Write codex token stats to a file so the Rust backend can read them
function flushCodexTokenStats() {
  try {
    const path = require('path');
    const statsFile = path.join(require('os').homedir(), '.terse', 'codex-proxy-tokens.json');
    require('fs').writeFileSync(statsFile, JSON.stringify(codexTokenStats));
  } catch (e) {}
}

function flushDshTokenStats() {
  try {
    const path = require('path');
    const statsFile = path.join(require('os').homedir(), '.terse', 'dsh-proxy-tokens.json');
    require('fs').writeFileSync(statsFile, JSON.stringify(dshTokenStats));
  } catch (e) {}
}

// DeepSeek reports usage on the final chat/completions SSE chunk. Unlike OpenAI,
// `prompt_tokens` is the whole prompt *including* cache hits, and the split is
// reported separately — so fresh input is the cache-miss half, which is also what
// DeepSeek actually bills at the full rate.
function extractDeepSeekTokensFromSSELine(line) {
  if (!line.startsWith('data: ')) return null;
  const json = line.slice(6).trim();
  if (json === '[DONE]') return null;
  try {
    const obj = JSON.parse(json);
    const usage = obj.usage;
    if (!usage || usage.prompt_tokens === undefined) return null;
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens;
    return {
      input: miss !== undefined ? miss : Math.max(0, (usage.prompt_tokens || 0) - hit),
      output: usage.completion_tokens || 0,
      cached: hit,
    };
  } catch (e) { return null; }
}

// Parse a single SSE data line and extract token usage from response.done events
function extractTokensFromSSELine(line) {
  if (!line.startsWith('data: ')) return null;
  const json = line.slice(6).trim();
  if (json === '[DONE]') return null;
  try {
    const obj = JSON.parse(json);
    // Responses API: response.done event
    const usage = (obj.type === 'response.done' && obj.response?.usage)
      ? obj.response.usage
      // Also handle top-level usage for non-streaming responses
      : (obj.usage && (obj.usage.input_tokens !== undefined) ? obj.usage : null);
    if (!usage) return null;
    return {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cached: usage.input_token_details?.cached_tokens || usage.cached_tokens || 0,
    };
  } catch (e) { return null; }
}

// Another local proxy that already owned ANTHROPIC_BASE_URL when we started.
//
// A relay that re-points Claude Code at a different backend writes its own
// address into ~/.claude/settings.json. Terse used to overwrite that outright,
// which silently broke the relay - the user's Claude Code stopped working and
// nothing said why. Same fault as the Codex config we just fixed: editing
// somebody else's file as if we were the only tenant.
//
// So chain instead of replace. Claude Code talks to us on PORT, we forward to
// whatever was there before, and the relay keeps working while Terse still sees
// the traffic it needs to count. { host, port } when chained, null otherwise.
let CHAINED_ANTHROPIC = null;

// Provider endpoints
const PROVIDERS = {
  anthropic: { host: 'api.anthropic.com', basePath: '/v1' },
  openai: { host: 'api.openai.com', basePath: '/v1' },
  deepseek: { host: 'api.deepseek.com', basePath: '' },
};

// DeepSeek Harness speaks the OpenAI-compatible /chat/completions dialect, so path
// shape alone can't tell it apart from OpenAI. Terse points $DEEPSEEK_BASE_URL at
// http://127.0.0.1:<port>/deepseek and routes on that prefix instead.
const DEEPSEEK_PREFIX = '/deepseek';

function detectProvider(path, headers) {
  if (path.startsWith(DEEPSEEK_PREFIX)) return 'deepseek';
  if (headers['anthropic-version'] || path.includes('/messages')) return 'anthropic';
  if (path.includes('/chat/completions') || path.includes('/responses')) return 'openai';
  return null;
}

function extractLastUserMessage(messages, body) {
  // Support both Chat Completions (messages array) and Responses API (input array)
  const arr = Array.isArray(messages) && messages.length > 0
    ? messages
    : (body && Array.isArray(body.input) ? body.input : null);
  if (!arr) return '';
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === 'user') {
      const c = arr[i].content;
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

async function shouldRoute(model, messages, body, forceRoute) {
  // Check if model is expensive (static map + dynamic detection)
  const cheaperModel = getRouteForModel(model);
  if (!cheaperModel) return null;

  // The Doctor's frontier-overuse fix asks for mechanical turns to leave the
  // frontier model. Short prompts are the safe, unambiguous slice of that — a
  // blanket downgrade would silently degrade real work, which is not something
  // a one-click "fix" should ever do behind the user's back.
  if (forceRoute) {
    const t = extractLastUserMessage(messages, body) || '';
    if (t.length > 0 && t.length < 180) {
      log(`ROUTE ${model}→${cheaperModel} [doctor:short-turn]`);
      return cheaperModel;
    }
  }

  const userText = extractLastUserMessage(messages, body);

  // ── 1. ML classifier (fine-tuned DistilBERT) ────────────────────────────
  // If the model is loaded, it takes priority over keyword rules.
  // Confidence < 0.60 → fall through to keyword rules (uncertain prediction).
  if (mlClassifier && mlClassifier.isAvailable && userText.length > 5) {
    try {
      const mlResult = await mlClassifier.classify(userText);
      if (mlResult && mlResult.confidence >= 0.60) {
        const isComplex = mlResult.label === 'complex';
        const tag = `ml:${mlResult.label}(${(mlResult.confidence * 100).toFixed(0)}%)`;
        if (isComplex) {
          log(`KEEP ${model} [${tag}]`);
          return null;
        } else {
          log(`ROUTE ${model}→${cheaperModel} [${tag}]`);
          return cheaperModel;
        }
      }
      // Low confidence — fall through to keyword rules
      if (mlResult) {
        log(`ML low-confidence (${(mlResult.confidence * 100).toFixed(0)}%) — falling back to keyword rules`);
      }
    } catch (e) {
      // ML inference error — fall through silently
    }
  }

  // ── 2. Keyword rules (always available, zero latency) ────────────────────
  const { score, reasons } = analyzeComplexity(userText, messages, body);

  // Score > 0 means complex → keep expensive model
  // Score <= 0 means simple → route to cheaper model
  if (score > 0) {
    log(`KEEP ${model} [keywords] (score=${score}, reasons=${reasons.join(',')})`);
    return null;
  }

  log(`ROUTE ${model}→${cheaperModel} [keywords] (score=${score}, reasons=${reasons.join(',')})`);
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

  // Parse body to potentially swap the model; fall back to raw passthrough if not JSON
  let body = null;
  let sendBuf = bodyBuf;
  try {
    if (bodyBuf.length > 0) body = JSON.parse(bodyBuf.toString());
  } catch (e) {
    // Non-JSON body (empty ping, multipart, etc.) — forward raw without modification
    body = null;
  }

  let bodyDirty = false;
  if (body && effectiveModel && effectiveModel !== 'unknown') {
    body.model = effectiveModel;
    bodyDirty = true;
  }

  // ── Doctor toggles that can only be enforced here ──
  // cap_output is the one Doctor finding whose remediation is impossible in the
  // webview: the ceiling has to be on the request the agent actually sends. The
  // Doctor writes the flag to ~/.terse/doctor.json; this reads it (cached, so a
  // hot path doesn't stat the file per request) and clamps max_tokens.
  if (body && doctorSettings().capOutput) {
    const CAP = 8192;
    if (typeof body.max_tokens !== 'number' || body.max_tokens > CAP) {
      body.max_tokens = CAP;
      bodyDirty = true;
      log(`CAP max_tokens → ${CAP}`);
    }
  }
  if (bodyDirty) sendBuf = Buffer.from(JSON.stringify(body));
  const originalModel = (body && body.model) || effectiveModel;

  // Forward headers, replacing host
  const headers = { ...originalReq.headers };
  delete headers.host;
  delete headers['content-length'];
  headers['content-length'] = sendBuf.length;

  // dsh reaches us at /deepseek/... — strip the routing prefix before forwarding.
  const isDeepSeek = provider === 'deepseek';
  const upstreamPath = isDeepSeek
    ? (originalReq.url.slice(DEEPSEEK_PREFIX.length) || '/')
    : originalReq.url;

  // Chained: send Anthropic traffic to the relay that owned the setting before
  // us, over plain http on loopback, instead of out to api.anthropic.com.
  const chain = provider === 'anthropic' ? CHAINED_ANTHROPIC : null;
  const options = {
    hostname: chain ? chain.host : providerInfo.host,
    port: chain ? chain.port : 443,
    path: upstreamPath,
    method: originalReq.method,
    headers,
  };
  if (chain) {
    // The Host header must name the hop we are actually talking to, or the
    // relay may route on a hostname it never serves.
    headers.host = `${chain.host}:${chain.port}`;
  }

  const isResponsesApi = originalReq.url.includes('/responses');

  const transport = chain ? http : https;
  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    if (isDeepSeek && proxyRes.statusCode === 200) {
      // Tap the chat/completions SSE stream for DeepSeek's usage chunk.
      let dsBuffer = '';
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
        dsBuffer += chunk.toString();
        const lines = dsBuffer.split('\n');
        dsBuffer = lines.pop() || '';
        for (const line of lines) {
          const tokens = extractDeepSeekTokensFromSSELine(line.trim());
          if (tokens && (tokens.input > 0 || tokens.output > 0)) {
            dshTokenStats.inputTokens += tokens.input;
            dshTokenStats.outputTokens += tokens.output;
            dshTokenStats.cachedTokens += tokens.cached;
            dshTokenStats.calls++;
            flushDshTokenStats();
            log(`dsh tokens: in=${tokens.input} out=${tokens.output} cached=${tokens.cached} (total in=${dshTokenStats.inputTokens})`);
          }
        }
      });
      proxyRes.on('end', () => { res.end(); });
    } else if (isResponsesApi && proxyRes.statusCode === 200) {
      // Tap the SSE stream to extract token usage from response.done events
      let sseBuffer = '';
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';
        for (const line of lines) {
          const tokens = extractTokensFromSSELine(line.trim());
          if (tokens && (tokens.input > 0 || tokens.output > 0)) {
            codexTokenStats.inputTokens += tokens.input;
            codexTokenStats.outputTokens += tokens.output;
            codexTokenStats.cachedTokens += tokens.cached;
            codexTokenStats.calls++;
            flushCodexTokenStats();
            log(`Codex tokens: in=${tokens.input} out=${tokens.output} cached=${tokens.cached} (total in=${codexTokenStats.inputTokens})`);
          }
        }
      });
      proxyRes.on('end', () => { res.end(); });
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    log(`Forward error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Proxy forward error: ' + e.message } }));
    }
  });

  if (sendBuf.length > 0) proxyReq.write(sendBuf);
  proxyReq.end();

  const msgCount = body?.messages?.length || body?.input?.length || 0;
  if (body && effectiveModel && effectiveModel !== originalModel) {
    log(`ROUTED: ${originalModel} → ${effectiveModel} (${msgCount} msgs)`);
    stats.routed++;
  } else {
    log(`PASS: ${originalModel || 'raw'} (${msgCount} msgs)`);
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
      codexTokens: codexTokenStats,
      dshTokens: dshTokenStats,
      routing: MODEL_ROUTES,
    }));
    return;
  }

  // Collect request body
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const bodyBuf = Buffer.concat(chunks);

    const provider = detectProvider(req.url, req.headers);
    if (!provider) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Cannot detect provider from request path' } }));
      return;
    }

    // Try to parse body for model routing; non-JSON bodies pass through untouched
    let body = null;
    try {
      if (bodyBuf.length > 0) body = JSON.parse(bodyBuf.toString());
    } catch (e) { /* non-JSON — passthrough */ }

    if (!body) {
      forwardRequest(provider, req, bodyBuf, null, res);
      return;
    }

    const model = body.model || '';
    const messages = body.messages || [];

    // Normalize model name — strip Claude Code suffixes like [1m] that Anthropic's API rejects
    const normalizedModel = model.replace(/\[.*?\]$/, '');

    // Check if we should route to a cheaper model (async — ML + keyword fallback)
    // Doctor's cost:frontier-overuse fix (routeCheapModels) force-enables
    // routing. When the flag is off the proxy keeps whatever it decided on its
    // own, so this only ever adds routing — it never disables existing behaviour.
    const forceRoute = !!doctorSettings().routeCheapModels;
    const routedModel = await shouldRoute(normalizedModel, messages, body, forceRoute);
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

    // Chain, do not evict.
    //
    // A relay that re-points Claude Code at another backend puts its own address
    // here. Overwriting it broke that relay outright - Claude Code stopped
    // working and nothing explained why, which is how one user lost terminal
    // sync entirely. If something else already owns this setting, keep it as our
    // upstream and sit in front: Claude Code -> Terse -> relay -> wherever.
    //
    // Only loopback addresses on another port are chained. A remote base URL is
    // somebody's real gateway and forwarding it through us would move their
    // traffic somewhere they did not ask for, so we leave it alone entirely.
    const prev = settings.env.ANTHROPIC_BASE_URL;
    const upstreamFile = path.join(home, '.terse', 'anthropic-upstream.json');
    if (typeof prev === 'string' && prev && prev !== proxyUrl) {
      let u = null;
      try { u = new URL(prev); } catch (e) { u = null; }
      const local = u && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      if (local && Number(u.port) && Number(u.port) !== PORT) {
        CHAINED_ANTHROPIC = { host: '127.0.0.1', port: Number(u.port) };
        try {
          fs.mkdirSync(path.join(home, '.terse'), { recursive: true });
          fs.writeFileSync(upstreamFile, JSON.stringify({ url: prev }));
        } catch (e) {}
        log('Chaining Claude Code through existing proxy at ' + prev);
      } else if (!local) {
        log('ANTHROPIC_BASE_URL is remote (' + prev + ') — leaving it alone');
        throw new Error('__claude_skip__');
      }
    } else {
      // Nobody else owns it now; drop any upstream remembered from a past run so
      // we do not forward to a relay that is no longer there.
      try { fs.unlinkSync(upstreamFile); } catch (e) {}
    }

    settings.env.ANTHROPIC_BASE_URL = proxyUrl;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    log('Configured Claude Code: ANTHROPIC_BASE_URL=' + proxyUrl +
        (CHAINED_ANTHROPIC ? ' -> 127.0.0.1:' + CHAINED_ANTHROPIC.port : ''));
  } catch (e) {
    if (e && e.message === '__claude_skip__') { /* deliberate: remote base URL */ }
    else log('Claude Code config failed: ' + e.message);
  }

  // Route DeepSeek Harness through the proxy via its per-profile patch overlay
  configureDsh(proxyUrl);

  // Write openai_base_url to ~/.codex/config.toml for Codex Desktop routing
  try {
    const codexDir = path.join(home, '.codex');
    const codexConfig = path.join(codexDir, 'config.toml');
    fs.mkdirSync(codexDir, { recursive: true });

    // NOT for ChatGPT-account sessions.
    //
    // Codex signs in two ways: an API key, or a ChatGPT subscription via OAuth.
    // Only the API key can call /v1/responses. Pointing a ChatGPT-authenticated
    // session at our proxy makes every request fail with
    //   401 Unauthorized ... Missing scopes: api.responses.write
    // and Codex then loops on reconnect — reported by a Pro user on Windows 11.
    // Their token is not an API key and no amount of proxying makes it one.
    //
    // auth.json holds whichever was used: OPENAI_API_KEY for key mode, `tokens`
    // for OAuth. Absent or unreadable → assume OAuth and stay out of the way;
    // declining to optimise is recoverable, breaking their Codex is not.
    let hasApiKey = false;
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
      hasApiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0;
    } catch (e) { /* no auth.json → treat as OAuth */ }
    if (!hasApiKey) {
      // Still strip a stale line we may have left behind on an earlier run.
      try {
        const prev = fs.readFileSync(codexConfig, 'utf8');
        const cleaned = prev.replace(/^openai_base_url\s*=\s*"[^"]*127\.0\.0\.1[^"]*"[^\n]*\n/m, '');
        if (cleaned !== prev) {
          fs.writeFileSync(codexConfig, cleaned);
          log('Codex: removed stale terse openai_base_url (ChatGPT-account session)');
        }
      } catch (e) {}
      log('Codex: ChatGPT-account auth detected — NOT routing through the proxy');
      throw new Error('__codex_skip__');
    }

    let content = '';
    try { content = fs.readFileSync(codexConfig, 'utf8'); } catch (e) {}
    // Back up before the first modification, so there is always something to
    // restore by hand. Written once — never overwrite a good backup with an
    // already-modified file.
    try {
      const bak = codexConfig + '.terse-backup';
      if (content && !fs.existsSync(bak)) fs.writeFileSync(bak, content);
    } catch (e) {}
    // Remove any stale terse-managed openai_base_url pointing to 127.0.0.1
    content = content.replace(/^openai_base_url\s*=\s*"[^"]*127\.0\.0\.1[^"]*"[^\n]*\n/m, '');
    // Only inject if the user hasn't set their own openai_base_url
    if (!content.match(/^\s*openai_base_url\s*=/m)) {
      content = `openai_base_url = "${proxyUrl}/v1"\n` + content;
      fs.writeFileSync(codexConfig, content);
      log('Configured Codex: openai_base_url=' + proxyUrl + '/v1');
    } else {
      // User has their own — just write back cleaned content if stale line was removed
      fs.writeFileSync(codexConfig, content);
    }
  } catch (e) {
    if (e && e.message === '__codex_skip__') { /* deliberate: ChatGPT-account auth */ }
    else log('Codex config failed: ' + e.message);
  }

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
// ── DeepSeek Harness (dsh) ──────────────────────────────────────────────────
// dsh composes its plugin tree from bundle layers plus one user overlay per
// profile (`~/.dsh/profiles/<name>/cordis.patch.yml`). Overriding llm-deepseek's
// baseURL there routes dsh through this proxy. The block is fenced by markers so
// a user's own patch entries in the same file are never touched, and it is pulled
// back out on shutdown — a stale override would point dsh at a dead port.
const DSH_BEGIN = '# >>> terse-managed — removed when Terse stops';
const DSH_END = '# <<< terse-managed';

function dshProfileDirs() {
  const fs = require('fs');
  const path = require('path');
  const root = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'profiles')
    : path.join(require('os').homedir(), '.dsh', 'profiles');
  try {
    return fs.readdirSync(root)
      .map(n => path.join(root, n))
      .filter(d => {
        try { return fs.statSync(path.join(d, 'cordis.patch.yml')).isFile(); }
        catch (e) { return false; }
      });
  } catch (e) { return []; }
}

function stripTerseBlock(content) {
  const re = new RegExp(`\\n?${DSH_BEGIN}[\\s\\S]*?${DSH_END}\\n?`, 'g');
  let out = content.replace(re, '\n');
  // An overlay with no entries left must go back to the empty-array form; a file
  // of only comments is not a valid patch list.
  const body = out.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join('\n').trim();
  if (body === '') {
    out = out.split('\n').filter(l => !l.trim() || l.trim().startsWith('#')).join('\n').trimEnd() + '\n[]\n';
  }
  return out;
}

function configureDsh(proxyUrl) {
  const fs = require('fs');
  const path = require('path');
  for (const dir of dshProfileDirs()) {
    const file = path.join(dir, 'cordis.patch.yml');
    try {
      let content = fs.readFileSync(file, 'utf8');

      // Back up once, before the first modification.
      const bak = file + '.terse-backup';
      try { if (!fs.existsSync(bak)) fs.writeFileSync(bak, content); } catch (e) {}

      content = stripTerseBlock(content);

      // Never fight a baseURL the user set themselves.
      if (/^\s*baseURL\s*:/m.test(content)) {
        fs.writeFileSync(file, content);
        log(`dsh: ${path.basename(dir)} has its own baseURL — not routing`);
        continue;
      }

      // `[]` is the empty-overlay form and cannot be mixed with block entries.
      const lines = content.split('\n').filter(l => l.trim() !== '[]');
      const block = [
        DSH_BEGIN,
        '- id: llm-deepseek',
        '  config:',
        `    baseURL: ${proxyUrl}${DEEPSEEK_PREFIX}`,
        DSH_END,
      ].join('\n');
      fs.writeFileSync(file, lines.join('\n').trimEnd() + '\n' + block + '\n');
      log(`Configured dsh: ${path.basename(dir)} baseURL=${proxyUrl}${DEEPSEEK_PREFIX}`);
    } catch (e) {
      log(`dsh config failed for ${dir}: ${e.message}`);
    }
  }
}

function cleanupDsh() {
  const fs = require('fs');
  const path = require('path');
  for (const dir of dshProfileDirs()) {
    const file = path.join(dir, 'cordis.patch.yml');
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (!content.includes(DSH_BEGIN)) continue;
      fs.writeFileSync(file, stripTerseBlock(content));
      log(`Cleaned up terse baseURL from dsh profile ${path.basename(dir)}`);
    } catch (e) {}
  }
}

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
        // Hand the setting back to whoever had it, instead of deleting it. A
        // chained relay was working before Terse started and must still be
        // working after it quits.
        let restored = null;
        try {
          restored = JSON.parse(fs.readFileSync(
            path.join(home, '.terse', 'anthropic-upstream.json'), 'utf8')).url;
        } catch (e) {}
        if (restored) {
          settings.env.ANTHROPIC_BASE_URL = restored;
          log('Restored ANTHROPIC_BASE_URL to ' + restored);
        } else {
          delete settings.env.ANTHROPIC_BASE_URL;
        }
        if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        log('Cleaned up ANTHROPIC_BASE_URL from settings.json');
      }
    }
  } catch (e) {}

  // Remove openai_base_url from ~/.codex/config.toml
  try {
    const codexConfig = path.join(home, '.codex', 'config.toml');
    if (fs.existsSync(codexConfig)) {
      const content = fs.readFileSync(codexConfig, 'utf8');
      const cleaned = content.replace(/^openai_base_url\s*=\s*"[^"]*127\.0\.0\.1[^"]*"[^\n]*\n/m, '');
      if (cleaned !== content) {
        fs.writeFileSync(codexConfig, cleaned);
        log('Cleaned up openai_base_url from ~/.codex/config.toml');
      }
    }
  } catch (e) {}

  // Pull our baseURL override back out of every dsh profile overlay
  cleanupDsh();

  // Remove dsh token stats file (stale after proxy stops)
  try { fs.unlinkSync(path.join(home, '.terse', 'dsh-proxy-tokens.json')); } catch (e) {}

  // Remove Codex token stats file (stale after proxy stops)
  try { fs.unlinkSync(path.join(home, '.terse', 'codex-proxy-tokens.json')); } catch (e) {}

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
