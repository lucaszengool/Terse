'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const https = require('https');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

let _planInfoCache = null;
let _planInfoFetchedAt = 0;
const PLAN_TTL = 5 * 60_000;

function fetchPlanInfo() {
  return new Promise(resolve => {
    const now = Date.now();
    if (_planInfoCache && now - _planInfoFetchedAt < PLAN_TTL) return resolve(_planInfoCache);
    if (process.platform !== 'darwin') return resolve(null);

    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        let oauth;
        try { oauth = JSON.parse(stdout.trim()).claudeAiOauth || {}; } catch { return resolve(null); }

        const accessToken = oauth.accessToken;
        const rateLimitTier = oauth.rateLimitTier || oauth.subscriptionType || null;
        const t = (rateLimitTier || '').toLowerCase();
        let plan = 'unknown';
        if (t.includes('max_20x'))     plan = 'max_20x';
        else if (t.includes('max_5x')) plan = 'max_5x';
        else if (t.includes('max'))    plan = 'max';
        else if (t.includes('pro'))    plan = 'pro';
        else if (t.includes('free'))   plan = 'free';
        else if (rateLimitTier)        plan = rateLimitTier;

        const finish = (shortTerm, longTerm) => {
          _planInfoCache = { plan, rateLimitTier, shortTerm, longTerm };
          _planInfoFetchedAt = now;
          resolve(_planInfoCache);
        };

        if (!accessToken) return finish(null, null);

        const req = https.request({
          hostname: 'api.anthropic.com',
          path: '/api/oauth/usage',
          method: 'GET',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            let shortTerm = null, longTerm = null;
            try {
              const u = JSON.parse(data);
              const toPct = v => { const r = v || 0; return r <= 1 ? Math.round(r * 100) : Math.round(r); };
              if (u.five_hour) shortTerm = { utilization: toPct(u.five_hour.utilization), label: '5h', resetsAt: u.five_hour.resets_at || null };
              if (u.seven_day) longTerm  = { utilization: toPct(u.seven_day.utilization),  label: '7d', resetsAt: u.seven_day.resets_at  || null };
            } catch {}
            finish(shortTerm, longTerm);
          });
        });
        req.on('error', () => finish(null, null));
        req.setTimeout(8000, () => { req.destroy(); finish(null, null); });
        req.end();
      });
  });
}

const MODEL_PRICING = {
  'claude-opus-4':    { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-opus-4-5':  { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-sonnet-4':  { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-sonnet-4-6':{ input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-haiku-4':   { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  'default':          { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
};

function getModelKey(m) {
  if (!m) return 'default';
  const s = m.toLowerCase();
  if (s.includes('opus-4-7') || s.includes('opus-4-5')) return 'claude-opus-4-5';
  if (s.includes('opus'))    return 'claude-opus-4';
  if (s.includes('sonnet-4-6')) return 'claude-sonnet-4-6';
  if (s.includes('sonnet'))  return 'claude-sonnet-4';
  if (s.includes('haiku'))   return 'claude-haiku-4';
  return 'default';
}

// Estimate how compressible a tool result is (0–1)
function estimateCompressRate(toolName) {
  const n = (toolName || '').toLowerCase();
  if (n === 'bash' || n === 'run_command') return 0.80;
  if (n === 'read' || n === 'read_file')   return 0.50;
  if (n === 'glob' || n === 'list_files')  return 0.70;
  if (n === 'grep' || n === 'search')      return 0.65;
  return 0.40;
}

class ClaudeCodeSession {
  constructor(workspacePath) {
    this._workspacePath = workspacePath;
    this._watcher = null;
    this._pollInterval = null;
    this._offset = 0;
    this._sessionFile = null;
    this._onUpdate = null;

    // Token counts (exact from API)
    this.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // Breakdown by conversation role
    this.tokenBreakdown = { user: 0, assistant: 0, tool: 0 };

    // Per-tool tracking
    this._toolData = {};   // toolName → { calls, inputTokens, resultTokens }
    this._toolArgs = {};   // toolName → [last few arg strings] for dupe detection
    this._fileReads = {};  // filePath → read count

    this.turns = 0;
    this.model = null;
    this.messages = [];
    this.allUserMessages = [];
    this.startTime = Date.now();
    this.lastTokenTime = null;
    this.recentTokens = [];
    this._redundantReads = {};   // filePath → count
    this._largeResults = [];     // { toolName, tokens }
    this._planInfo = null;
    this._planFetchTimer = null;
  }

  onUpdate(fn) { this._onUpdate = fn; }

  findSessionFile() {
    try {
      // Claude Code encodes workspace paths as directory names by replacing
      // path separators with dashes. On Windows: C:\Users\X\proj → C-Users-X-proj
      const normalized = this._workspacePath
        .replace(/[/\\]/g, '-')   // forward and back slashes → dash
        .replace(/:/g, '')         // strip drive colon (C: → C)
        .replace(/^-+/, '');       // no leading dashes
      const encoded = encodeURIComponent(this._workspacePath)
        .replace(/%2F/g, '-').replace(/%5C/g, '-').replace(/%3A/g, '').replace(/^-+/, '');
      const candidates = [
        path.join(CLAUDE_PROJECTS_DIR, normalized),
        path.join(CLAUDE_PROJECTS_DIR, encoded),
      ];

      if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        const baseName = path.basename(this._workspacePath || '');
        for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
          const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
          if (dir === normalized || dir === encoded) {
            if (!candidates.includes(dirPath)) candidates.unshift(dirPath);
          } else if (baseName && dir.endsWith('-' + baseName)) {
            candidates.push(dirPath);
          }
        }
      }

      for (const dir of candidates) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (files.length > 0) return path.join(dir, files[0].f);
      }
    } catch {}
    return null;
  }

  start() {
    this._sessionFile = this.findSessionFile();
    if (!this._sessionFile) {
      setTimeout(() => {
        this._sessionFile = this.findSessionFile();
        if (this._sessionFile) this._startWatching();
      }, 5000);
    } else {
      this._startWatching();
    }
    this._doFetchPlan();
  }

  _doFetchPlan() {
    fetchPlanInfo().then(info => {
      this._planInfo = info;
      if (info && this._onUpdate) this._onUpdate(this.snapshot());
      this._planFetchTimer = setTimeout(() => this._doFetchPlan(), PLAN_TTL);
    }).catch(() => {});
  }

  _startWatching() {
    if (!this._sessionFile || !fs.existsSync(this._sessionFile)) return;
    this._offset = 0;
    this._readNewLines();
    try {
      this._watcher = fs.watch(this._sessionFile, { persistent: false }, () => this._readNewLines());
    } catch {}
    this._pollInterval = setInterval(() => this._readNewLines(), 500);
  }

  _readNewLines() {
    try {
      const fd = fs.openSync(this._sessionFile, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size <= this._offset) { fs.closeSync(fd); return; }
      const buf = Buffer.alloc(stat.size - this._offset);
      fs.readSync(fd, buf, 0, buf.length, this._offset);
      fs.closeSync(fd);
      this._offset = stat.size;
      for (const line of buf.toString('utf8').split('\n')) {
        const t = line.trim();
        if (t) this._parseLine(t);
      }
    } catch {}
  }

  _parseLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!obj?.message) return;

    const msg = obj.message;
    const role = msg.role;
    const usage = msg.usage || {};
    const content = msg.content || '';

    if (msg.model) this.model = msg.model;

    // Accumulate exact token counts
    if (usage.input_tokens)                this.tokens.input      += usage.input_tokens;
    if (usage.output_tokens)               this.tokens.output     += usage.output_tokens;
    if (usage.cache_read_input_tokens)     this.tokens.cacheRead  += usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens) this.tokens.cacheWrite += usage.cache_creation_input_tokens;

    // Breakdown by role.
    // User messages in the JSONL have no usage — estimate from content length.
    // Assistant output_tokens is exact.
    if (role === 'assistant' && usage.output_tokens)
      this.tokenBreakdown.assistant += usage.output_tokens;

    // Burn rate tracking
    if (usage.input_tokens || usage.output_tokens) {
      const now = Date.now();
      this.lastTokenTime = now;
      const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      this.recentTokens.push({ t: now, count: total });
      const cutoff = now - 5 * 60_000;
      this.recentTokens = this.recentTokens.filter(x => x.t > cutoff);
    }

    // Parse content blocks
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const toolName = block.name || 'unknown';
        if (!this._toolData[toolName]) this._toolData[toolName] = { calls: 0, inputTokens: 0, resultTokens: 0 };
        this._toolData[toolName].calls++;

        // Estimate input tokens for this tool call (args serialized)
        const argStr = JSON.stringify(block.input || {});
        const estInput = Math.ceil(argStr.length / 4);
        this._toolData[toolName].inputTokens += estInput;

        // Track duplicate calls (same tool + similar args)
        if (!this._toolArgs[toolName]) this._toolArgs[toolName] = [];
        this._toolArgs[toolName].push(argStr.slice(0, 120));

        // Detect redundant file reads
        if ((toolName === 'Read' || toolName === 'read_file') && block.input?.file_path) {
          const fp = block.input.file_path;
          this._redundantReads[fp] = (this._redundantReads[fp] || 0) + 1;
        }

        this.messages.push({ role: 'tool', text: `${toolName}(${argStr.slice(0, 60)})`, ts: obj.timestamp });

      } else if (block.type === 'tool_result') {
        const resultText = Array.isArray(block.content)
          ? block.content.map(c => c.text || '').join('')
          : (block.content || '').toString();
        const estTokens = Math.ceil(resultText.length / 4);

        // Attribute result tokens to the tool that generated them
        // (We don't have tool name here but it's part of assistant role anyway)
        this.tokenBreakdown.tool += estTokens;

        // Find which tool this result belongs to (last tool_use in current block)
        const lastTool = this.messages.filter(m => m.role === 'tool').slice(-1)[0];
        const toolName = lastTool ? lastTool.text.split('(')[0] : 'unknown';
        if (this._toolData[toolName]) {
          this._toolData[toolName].resultTokens += estTokens;
        }

        if (estTokens > 500) {
          this._largeResults.push({ toolName, tokens: estTokens });
          if (this._largeResults.length > 20) this._largeResults = this._largeResults.slice(-20);
        }

        const compressible = estTokens > 200;
        this.messages.push({ role: 'result', text: resultText.slice(0, 200), ts: obj.timestamp, tokens: estTokens, compressible });

      } else if (block.type === 'text' || block.text) {
        const text = (block.text || '').slice(0, 120);
        if (text.trim()) {
          if (role === 'user') {
            this.turns++;
            const fullText = block.text || '';
            // Estimate user token contribution from text length (no usage field on user lines)
            this.tokenBreakdown.user += Math.ceil(fullText.length / 4);
            this.allUserMessages.push({ text: fullText });
            if (this.allUserMessages.length > 50) this.allUserMessages = this.allUserMessages.slice(-50);
          }
          const msgTok = role === 'user'
            ? Math.ceil((block.text || '').length / 4)
            : (usage.output_tokens || 0);
          this.messages.push({ role: role || 'unknown', text, ts: obj.timestamp, tokens: msgTok || undefined });
        }
      }
    }

    if (this.messages.length > 30) this.messages = this.messages.slice(-30);
    if (this._onUpdate) this._onUpdate(this.snapshot());
  }

  burnRate() {
    if (this.recentTokens.length < 2) return 0;
    const oldest = this.recentTokens[0];
    const newest = this.recentTokens[this.recentTokens.length - 1];
    const mins = (newest.t - oldest.t) / 60_000;
    if (mins < 0.1) return 0;
    return Math.round(this.recentTokens.reduce((s, x) => s + x.count, 0) / mins);
  }

  cacheEfficiency() {
    const total = this.tokens.input + this.tokens.cacheRead + this.tokens.cacheWrite;
    if (!total) return 0;
    return Math.round((this.tokens.cacheRead / total) * 100);
  }

  contextFill() {
    const current = this.tokens.input + this.tokens.cacheRead + this.tokens.cacheWrite;
    return Math.min(100, Math.round((current / 200_000) * 100));
  }

  totalCost() {
    const p = MODEL_PRICING[getModelKey(this.model)] || MODEL_PRICING['default'];
    return (this.tokens.input  / 1e6) * p.input
         + (this.tokens.output / 1e6) * p.output
         + (this.tokens.cacheRead  / 1e6) * p.cacheRead
         + (this.tokens.cacheWrite / 1e6) * p.cacheWrite;
  }

  cacheSavings() {
    // How much the cache saved vs paying full input price for cached tokens
    const p = MODEL_PRICING[getModelKey(this.model)] || MODEL_PRICING['default'];
    return (this.tokens.cacheRead / 1e6) * (p.input - p.cacheRead);
  }

  snapshot() {
    const totalTokens = this.tokens.input + this.tokens.output + this.tokens.cacheRead + this.tokens.cacheWrite;
    const currentContext = this.tokens.input + this.tokens.cacheRead + this.tokens.cacheWrite;
    const cost = this.totalCost();
    const burn = this.burnRate();
    const cache = this.cacheEfficiency();
    const fill = this.contextFill();

    // Tool token breakdown sorted by total consumption
    const toolTokenBreakdown = Object.entries(this._toolData)
      .map(([name, d]) => ({ name, calls: d.calls, tokens: d.inputTokens + d.resultTokens, resultTokens: d.resultTokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);

    // Tool result stats
    const toolResultStats = {
      totalTokens: toolTokenBreakdown.reduce((s, t) => s + t.resultTokens, 0),
      compressibleTokens: toolTokenBreakdown.reduce((s, t) =>
        s + Math.round(t.resultTokens * estimateCompressRate(t.name)), 0),
    };

    // Redundant reads
    const redundantReads = Object.entries(this._redundantReads)
      .filter(([, count]) => count > 1)
      .map(([file, count]) => ({ file: path.basename(file), wastedReads: count - 1 }))
      .sort((a, b) => b.wastedReads - a.wastedReads);
    const rereadWaste = redundantReads.reduce((s, r) => s + r.wastedReads * 400, 0); // ~400 tok avg

    // Duplicate tool calls (same tool called 3+ times)
    const duplicateCalls = Object.entries(this._toolData)
      .filter(([, d]) => d.calls >= 3).length;
    const tokensWasted = Object.entries(this._toolData)
      .filter(([, d]) => d.calls >= 3)
      .reduce((s, [, d]) => s + Math.round(d.inputTokens * 0.5), 0);

    // Large tool results deduplicated
    const largeSeen = new Set();
    const largeToolResults = this._largeResults.filter(r => {
      if (largeSeen.has(r.toolName)) return false;
      largeSeen.add(r.toolName);
      return true;
    });

    // Output vs input ratio for cost warning
    const totalInputTokens = this.tokens.input + this.tokens.cacheRead + this.tokens.cacheWrite;
    const totalOutputTokens = this.tokens.output;

    // Insights
    const insights = [];
    if (fill >= 85) insights.push({ type: 'danger', icon: '!', text: `Context ${fill}% full — use /compact or start new session`, value: fill + '%' });
    else if (fill >= 60) insights.push({ type: 'warn', icon: '!', text: `Context growing — watch for degradation`, value: fill + '%' });

    if (redundantReads.length > 0) {
      const w = redundantReads.reduce((s, r) => s + r.wastedReads, 0);
      insights.push({ type: 'warn', icon: '↺', text: `${redundantReads.length} files re-read (${w} extra reads)`, value: '~' + Math.round(rereadWaste / 1000) + 'K tok' });
    }

    if (largeToolResults.length > 0) {
      const tot = this._largeResults.reduce((s, r) => s + r.tokens, 0);
      insights.push({ type: 'tip', icon: '▤', text: `${largeToolResults.length} tools returning large results`, value: Math.round(tot / 1000) + 'K tok' });
    }

    const bdTotal = (this.tokenBreakdown.user + this.tokenBreakdown.assistant + this.tokenBreakdown.tool) || 1;
    const toolPct = Math.round((this.tokenBreakdown.tool / bdTotal) * 100);
    if (toolPct > 60 && totalTokens > 5000) {
      insights.push({ type: 'warn', icon: '⚙', text: 'Tool results dominate context', value: toolPct + '%' });
    }

    if (cache < 20 && totalTokens > 5000) {
      insights.push({ type: 'warn', icon: '⚡', text: 'Low cache rate — add CLAUDE.md to improve caching', value: cache + '%' });
    }

    if (duplicateCalls > 0) {
      insights.push({ type: 'warn', icon: '⊜', text: `${duplicateCalls} tools called 3+ times — consider caching results`, value: '-' + Math.round(tokensWasted / 1000) + 'K' });
    }

    if (toolResultStats.compressibleTokens > 5000) {
      const compPct = toolResultStats.totalTokens > 0
        ? Math.round((toolResultStats.compressibleTokens / toolResultStats.totalTokens) * 100) : 0;
      insights.push({ type: 'tip', icon: '▤', text: `Tool output ~${compPct}% compressible (install hooks)`, value: Math.round(toolResultStats.compressibleTokens / 1000) + 'K saveable' });
    }

    if (totalOutputTokens > 0 && totalInputTokens > 0 && totalOutputTokens > totalInputTokens * 0.3) {
      const outPct = Math.round(totalOutputTokens / totalInputTokens * 100);
      insights.push({ type: 'warn', icon: '$', text: `Output ${outPct}% of input — output costs 5x more`, value: Math.round(totalOutputTokens / 1000) + 'K' });
    }

    const isExpensive = /opus/i.test(this.model || '');
    if (isExpensive && this.turns > 3 && totalTokens > 3000 && totalTokens < 20000) {
      insights.push({ type: 'tip', icon: '💡', text: 'Short session on Opus — Sonnet saves ~80%', value: '-80%' });
    }

    return {
      agentId: 'claude-code',
      agentName: 'Claude Code',
      agentIcon: '🤖',
      model: this.model,
      turns: this.turns,

      // Token counts
      tokens: { ...this.tokens, total: totalTokens },
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens: this.tokens.cacheRead,
      totalCacheWriteTokens: this.tokens.cacheWrite,
      currentContext,

      // Derived
      costUSD: cost,
      cacheSavingsUSD: this.cacheSavings(),
      burnRate: burn,
      cacheEfficiency: cache,
      contextFill: fill,

      // Breakdown
      tokenBreakdown: { ...this.tokenBreakdown },
      toolTokenBreakdown,
      toolResultStats,
      toolCallCount: Object.values(this._toolData).reduce((s, d) => s + d.calls, 0),
      toolCachePotential: { duplicateCalls, tokensWasted },

      // History
      messages: this.messages.slice(-10),
      allUserMessages: this.allUserMessages.slice(-20),
      redundantReads,
      rereadWaste,
      largeToolResults,

      insights,
      planInfo: this._planInfo,
    };
  }

  stop() {
    this._watcher?.close();
    clearInterval(this._pollInterval);
    clearTimeout(this._planFetchTimer);
  }
}

module.exports = { ClaudeCodeSession, CLAUDE_PROJECTS_DIR };
