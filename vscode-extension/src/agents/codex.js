'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');

// gpt-4o pricing per million tokens (Codex default model)
const PRICING = { input: 2.50, output: 10.00, cacheRead: 1.25 };

class CodexSession {
  constructor() {
    this.agentId = 'codex';
    this.agentName = 'OpenAI Codex';
    this.agentIcon = '🧠';
    this._sessionFile = null;
    this._offset = 0;
    this._watcher = null;
    this._pollInterval = null;
    this._onUpdate = null;

    this.model = null;
    this.turns = 0;
    this.tokens = { input: 0, output: 0, cacheRead: 0 };
    this.messages = [];
    this.allUserMessages = [];
    this._toolData = {};   // name → { calls, resultTokens }
    this._largeResults = [];
    this.startTime = Date.now();
  }

  onUpdate(fn) { this._onUpdate = fn; }

  _findSessionFile() {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;
    let newest = null;
    let newestMtime = 0;
    try {
      for (const year of fs.readdirSync(CODEX_SESSIONS_DIR)) {
        const yearDir = path.join(CODEX_SESSIONS_DIR, year);
        if (!fs.statSync(yearDir).isDirectory()) continue;
        for (const month of fs.readdirSync(yearDir)) {
          const monthDir = path.join(yearDir, month);
          if (!fs.statSync(monthDir).isDirectory()) continue;
          for (const day of fs.readdirSync(monthDir)) {
            const dayDir = path.join(monthDir, day);
            if (!fs.statSync(dayDir).isDirectory()) continue;
            for (const file of fs.readdirSync(dayDir)) {
              if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
              const fp = path.join(dayDir, file);
              try {
                const mtime = fs.statSync(fp).mtimeMs;
                if (mtime > newestMtime) { newestMtime = mtime; newest = fp; }
              } catch {}
            }
          }
        }
      }
    } catch {}
    // Only return files modified in last 30 minutes (active session)
    if (newest && (Date.now() - newestMtime) < 30 * 60 * 1000) return newest;
    return null;
  }

  start() {
    this._sessionFile = this._findSessionFile();
    if (!this._sessionFile) {
      setTimeout(() => {
        this._sessionFile = this._findSessionFile();
        if (this._sessionFile) this._startWatching();
      }, 5000);
      return;
    }
    this._startWatching();
  }

  _startWatching() {
    if (!this._sessionFile) return;
    this._offset = 0;
    this._readNewLines();
    try {
      this._watcher = fs.watch(this._sessionFile, { persistent: false }, () => this._readNewLines());
    } catch {}
    this._pollInterval = setInterval(() => {
      // Check if a newer session file appeared (new codex run)
      const current = this._findSessionFile();
      if (current && current !== this._sessionFile) {
        this._watcher?.close();
        this._sessionFile = current;
        this._offset = 0;
        try {
          this._watcher = fs.watch(this._sessionFile, { persistent: false }, () => this._readNewLines());
        } catch {}
      }
      this._readNewLines();
    }, 1000);
  }

  _readNewLines() {
    if (!this._sessionFile) return;
    try {
      const stat = fs.statSync(this._sessionFile);
      if (stat.size <= this._offset) return;
      const fd = fs.openSync(this._sessionFile, 'r');
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

  _parseLine(rawLine) {
    let obj;
    try { obj = JSON.parse(rawLine); } catch { return; }

    // Codex uses top-level "type" field
    const type = obj.type || obj.event_type;
    if (!type) return;

    const ts = obj.timestamp || new Date().toISOString();

    // Model detection from turn_context
    if (obj.turn_context?.model) this.model = obj.turn_context.model;
    if (obj.model) this.model = obj.model;

    switch (type) {
      case 'turn.started':
        this.turns++;
        break;

      case 'turn.completed': {
        // Usage is directly on turn.completed: { input_tokens, cached_input_tokens, output_tokens }
        const u = obj.usage || obj.payload?.usage || {};
        const input = u.input_tokens || 0;
        const cached = u.cached_input_tokens || 0;
        const output = u.output_tokens || 0;
        // Token counts may be cumulative — take the max so we don't go backwards
        const newTotal = input + cached + output;
        if (newTotal > this.tokens.input + this.tokens.cacheRead + this.tokens.output) {
          this.tokens.input = input;
          this.tokens.cacheRead = cached;
          this.tokens.output = output;
        }
        break;
      }

      case 'item.started': {
        const item = obj.item || obj.payload?.item || {};
        const itype = item.type || '';
        if (_isToolType(itype)) {
          const name = item.name || _toolDisplayName(itype);
          if (!this._toolData[name]) this._toolData[name] = { calls: 0, resultTokens: 0 };
          this._toolData[name].calls++;
          const argText = _extractItemArg(item);
          this.messages.push({ role: 'tool', text: `${name}(${argText.slice(0, 60)})`, ts, tokens: 0 });
          if (this.messages.length > 30) this.messages = this.messages.slice(-30);
        }
        break;
      }

      case 'item.completed':
      case 'item.added':
      case 'item.updated': {
        const item = obj.item || obj.payload?.item || {};
        this._handleCompletedItem(item, ts);
        break;
      }

      default:
        break;
    }

    if (this._onUpdate) this._onUpdate(this.snapshot());
  }

  _handleCompletedItem(item, ts) {
    const itype = item.type || '';

    if (itype === 'message' || itype === 'agent_message' || itype === 'reasoning') {
      const text = (item.text || '').slice(0, 120);
      if (text.trim()) {
        this.messages.push({ role: 'assistant', text, ts, tokens: Math.ceil(text.length / 4) });
        if (this.messages.length > 30) this.messages = this.messages.slice(-30);
      }
    } else if (itype === 'input_message' || (itype === 'message' && item.role === 'user')) {
      const text = item.content || item.text || '';
      if (text.trim()) {
        this.allUserMessages.push({ text });
        if (this.allUserMessages.length > 50) this.allUserMessages = this.allUserMessages.slice(-50);
        this.messages.push({ role: 'user', text: text.slice(0, 120), ts, tokens: Math.ceil(text.length / 4) });
        if (this.messages.length > 30) this.messages = this.messages.slice(-30);
      }
    } else if (_isToolType(itype)) {
      // Completed tool call with output
      const name = item.name || _toolDisplayName(itype);
      const output = (item.output || item.content || '').toString();
      const resultTokens = Math.ceil(output.length / 4);
      if (!this._toolData[name]) this._toolData[name] = { calls: 0, resultTokens: 0 };
      this._toolData[name].resultTokens += resultTokens;
      if (resultTokens > 500) {
        this._largeResults.push({ toolName: name, tokens: resultTokens });
        if (this._largeResults.length > 20) this._largeResults = this._largeResults.slice(-20);
      }
    }
  }

  contextFill() {
    const used = this.tokens.input + this.tokens.cacheRead;
    return Math.min(100, Math.round((used / 128_000) * 100)); // gpt-4o 128K context
  }

  totalCost() {
    return (this.tokens.input / 1e6) * PRICING.input
         + (this.tokens.output / 1e6) * PRICING.output
         + (this.tokens.cacheRead / 1e6) * PRICING.cacheRead;
  }

  snapshot() {
    const totalTokens = this.tokens.input + this.tokens.output + this.tokens.cacheRead;
    const fill = this.contextFill();
    const cost = this.totalCost();

    const toolBreakdown = Object.entries(this._toolData)
      .map(([name, d]) => ({ name, calls: d.calls, tokens: d.resultTokens, resultTokens: d.resultTokens }))
      .sort((a, b) => b.tokens - a.tokens).slice(0, 8);

    const insights = [];
    if (fill >= 80) {
      insights.push({ type: 'warn', icon: '!', text: `Context ${fill}% full`, value: fill + '%' });
    }
    if (this._largeResults.length > 0) {
      const tot = this._largeResults.reduce((s, r) => s + r.tokens, 0);
      insights.push({ type: 'tip', icon: '▤', text: `${this._largeResults.length} large tool results`, value: Math.round(tot / 1000) + 'K tok' });
    }

    return {
      agentId: 'codex',
      agentName: 'OpenAI Codex',
      agentIcon: '🧠',
      model: this.model,
      turns: this.turns,
      tokens: { ...this.tokens, total: totalTokens },
      totalInputTokens: this.tokens.input + this.tokens.cacheRead,
      totalOutputTokens: this.tokens.output,
      totalCacheReadTokens: this.tokens.cacheRead,
      currentContext: this.tokens.input + this.tokens.cacheRead,
      costUSD: cost,
      cacheSavingsUSD: 0,
      burnRate: 0,
      cacheEfficiency: totalTokens > 0 ? Math.round((this.tokens.cacheRead / totalTokens) * 100) : 0,
      contextFill: fill,
      tokenBreakdown: { user: 0, assistant: 0, tool: 0 },
      toolTokenBreakdown: toolBreakdown,
      toolResultStats: {
        totalTokens: toolBreakdown.reduce((s, t) => s + t.resultTokens, 0),
        compressibleTokens: 0,
      },
      toolCallCount: Object.values(this._toolData).reduce((s, d) => s + d.calls, 0),
      toolCachePotential: { duplicateCalls: 0, tokensWasted: 0 },
      messages: this.messages.slice(-10),
      allUserMessages: this.allUserMessages.slice(-20),
      redundantReads: [],
      rereadWaste: 0,
      largeToolResults: this._largeResults.slice(-5),
      insights,
    };
  }

  stop() {
    this._watcher?.close();
    clearInterval(this._pollInterval);
  }
}

function _isToolType(itype) {
  return itype === 'command_execution' || itype === 'function_call' ||
         itype === 'local_shell_call' || itype === 'web_search_call' ||
         itype === 'mcp_call' || itype === 'file_read' || itype === 'code_execution';
}

function _toolDisplayName(itype) {
  const map = {
    'command_execution': 'shell',
    'local_shell_call': 'shell',
    'web_search_call': 'web_search',
    'file_read': 'read',
    'code_execution': 'code',
    'mcp_call': 'mcp',
    'function_call': 'function',
  };
  return map[itype] || itype;
}

function _extractItemArg(item) {
  if (item.command) return item.command;
  if (item.arguments) return typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
  if (item.query) return item.query;
  if (item.path) return item.path;
  return '';
}

module.exports = { CodexSession, CODEX_SESSIONS_DIR };
