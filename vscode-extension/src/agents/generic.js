'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// ── Cursor (SQLite via sqlite3 CLI) ──────────────────────────────────────
// Cursor stores chat bubbles in a VS Code globalStorage SQLite DB.
// We read it with the sqlite3 CLI; falls back gracefully if unavailable.
class CursorSession {
  constructor() {
    this.agentId = 'cursor-agent';
    this.agentName = 'Cursor Agent';
    this.agentIcon = '⚡';
    this.turns = 0;
    this.tokens = { total: 0 };
    this.messages = [];
    this._lastRowId = 0;
    this._pollInterval = null;
    this._onUpdate = null;
    this._hasData = false;  // true once we successfully read real rows
  }

  onUpdate(fn) { this._onUpdate = fn; }

  _getDbPath() {
    const candidates = [
      // macOS
      path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      // Linux
      path.join(HOME, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      // Windows
      path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }

  _hasSqlite3() {
    try { execSync('sqlite3 --version', { timeout: 1000, stdio: 'ignore' }); return true; } catch { return false; }
  }

  start() {
    // Only start polling if sqlite3 is available and DB exists
    if (!this._getDbPath() || !this._hasSqlite3()) return;
    this._poll();
    this._pollInterval = setInterval(() => this._poll(), 3000);
  }

  _poll() {
    const db = this._getDbPath();
    if (!db) return;
    try {
      const out = execSync(
        `sqlite3 -json "${db}" "SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId%' AND rowid > ${this._lastRowId} AND length(value) > 30 ORDER BY rowid LIMIT 50;"`,
        { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const rows = JSON.parse(out || '[]');
      if (!rows.length) return;

      this._hasData = true;
      for (const row of rows) {
        if (row.rowid > this._lastRowId) this._lastRowId = row.rowid;
        try {
          const val = JSON.parse(row.value);
          const text = (val.text || val.message || '').slice(0, 120);
          const role = val.type === 1 ? 'user' : 'assistant';
          if (role === 'user') this.turns++;
          this.tokens.total += Math.ceil(text.length / 4);
          this.messages.push({ role, text, ts: new Date().toISOString() });
          if (this.messages.length > 30) this.messages = this.messages.slice(-30);
        } catch {}
      }

      if (rows.length && this._onUpdate) this._onUpdate(this.snapshot());
    } catch {}
  }

  contextFill() { return Math.min(100, Math.round((this.tokens.total / 100_000) * 100)); }

  snapshot() {
    return {
      agentId: this.agentId,
      agentName: this.agentName,
      agentIcon: this.agentIcon,
      model: null,                    // Cursor doesn't expose model info
      turns: this.turns,
      tokens: this.tokens,
      contextFill: this.contextFill(),
      messages: this.messages.slice(-10),
      insights: [],
      tokenCountApprox: true,
      noSessionData: !this._hasData,  // panel shows "Active" label when true
    };
  }

  stop() { clearInterval(this._pollInterval); }
}

// ── Aider (.aider.chat.history.md) ──────────────────────────────────────
class AiderSession {
  constructor(workspacePath) {
    this.agentId = 'aider';
    this.agentName = 'Aider';
    this.agentIcon = '🤝';
    // Aider writes history to workspace dir; fall back to home dir
    const candidates = [
      path.join(workspacePath || '', '.aider.chat.history.md'),
      path.join(HOME, '.aider.chat.history.md'),
    ];
    this._historyFile = candidates.find(p => p && fs.existsSync(p)) || candidates[0];
    this._offset = 0;
    this._watcher = null;
    this._pollInterval = null;
    this._onUpdate = null;
    this.turns = 0;
    this.tokens = { total: 0 };
    this.messages = [];
  }

  onUpdate(fn) { this._onUpdate = fn; }

  start() {
    this._read();
    try {
      this._watcher = fs.watch(this._historyFile, { persistent: false }, () => this._read());
    } catch {}
    // Polling fallback in case fs.watch misses events
    this._pollInterval = setInterval(() => this._read(), 2000);
  }

  _read() {
    if (!fs.existsSync(this._historyFile)) return;
    try {
      const stat = fs.statSync(this._historyFile);
      if (stat.size <= this._offset) return;
      const fd = fs.openSync(this._historyFile, 'r');
      const buf = Buffer.alloc(stat.size - this._offset);
      fs.readSync(fd, buf, 0, buf.length, this._offset);
      fs.closeSync(fd);
      this._offset = stat.size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.startsWith('#### ')) {
          this.turns++;
          const msg = line.slice(5, 125);
          this.messages.push({ role: 'user', text: msg, ts: new Date().toISOString() });
          this.tokens.total += Math.ceil(msg.length / 4);
        }
      }
      if (this.messages.length > 30) this.messages = this.messages.slice(-30);
      if (this._onUpdate) this._onUpdate(this.snapshot());
    } catch {}
  }

  snapshot() {
    return {
      agentId: this.agentId,
      agentName: this.agentName,
      agentIcon: this.agentIcon,
      turns: this.turns,
      tokens: this.tokens,
      contextFill: Math.min(100, Math.round((this.tokens.total / 50_000) * 100)),
      messages: this.messages.slice(-10),
      insights: [],
      tokenCountApprox: true,
    };
  }

  stop() { this._watcher?.close(); clearInterval(this._pollInterval); }
}

// ── GitHub Copilot Chat session ──────────────────────────────────────────
// Reads VS Code log files + ~/.copilot/ide lock files to surface:
// account, plan/SKU, Copilot version, approximate turn count, session age.
class CopilotSession {
  constructor(def, workspacePath) {
    this.agentId = def.id;
    this.agentName = def.name;
    this.agentIcon = def.icon;
    this._workspacePath = workspacePath;
    this._onUpdate = null;
    this._pollInterval = null;

    this._account = null;
    this._sku = null;
    this._version = null;
    this._turns = 0;
    this._sessionStart = null;
    this._logPath = null;
  }

  onUpdate(fn) { this._onUpdate = fn; }

  start() {
    this._poll();
    this._pollInterval = setInterval(() => this._poll(), 20000);
  }

  stop() { clearInterval(this._pollInterval); }

  _findLogFile() {
    // Search Code/logs for the most recently modified Copilot Chat log
    const logsBase = process.platform === 'win32'
      ? path.join(process.env.APPDATA || HOME, 'Code', 'logs')
      : path.join(HOME, 'Library', 'Application Support', 'Code', 'logs');
    try {
      const logName = 'GitHub Copilot Chat.log';
      // find all matching log files
      const results = [];
      const sessions = fs.readdirSync(logsBase);
      for (const sess of sessions) {
        const sessDir = path.join(logsBase, sess);
        try {
          const windows = fs.readdirSync(sessDir);
          for (const win of windows) {
            const p = path.join(sessDir, win, 'exthost', 'GitHub.copilot-chat', logName);
            try { results.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch {}
          }
        } catch {}
      }
      if (!results.length) return null;
      results.sort((a, b) => b.mtime - a.mtime);
      return results[0].p;
    } catch { return null; }
  }

  _findLockFile() {
    const lockDir = path.join(HOME, '.copilot', 'ide');
    try {
      const files = fs.readdirSync(lockDir).filter(f => f.endsWith('.lock'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(lockDir, f), 'utf8'));
          if (this._workspacePath && data.workspaceFolders?.includes(this._workspacePath)) {
            return data;
          }
        } catch {}
      }
      // No exact match — return most recent by timestamp
      let best = null;
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(lockDir, f), 'utf8'));
          if (!best || (data.timestamp || 0) > (best.timestamp || 0)) best = data;
        } catch {}
      }
      return best;
    } catch { return null; }
  }

  _poll() {
    try {
      if (!this._logPath) this._logPath = this._findLogFile();
      const logPath = this._logPath;
      if (logPath) {
        const text = fs.readFileSync(logPath, 'utf8');
        // Extract account
        const accMatch = text.match(/Logged in as (\S+)/g);
        if (accMatch) this._account = accMatch[accMatch.length - 1].replace('Logged in as ', '');
        // Extract SKU
        const skuMatch = text.match(/copilot token sku: (\S+)/g);
        if (skuMatch) this._sku = skuMatch[skuMatch.length - 1].replace('copilot token sku: ', '');
        // Extract version
        const verMatch = text.match(/Copilot Chat: ([\d.]+)/);
        if (verMatch) this._version = verMatch[1];
        // Count turns (each ccreq: line is a conversation request)
        this._turns = (text.match(/ccreq:/g) || []).length;
      }
      // Session start from lock file
      const lock = this._findLockFile();
      if (lock?.timestamp) this._sessionStart = lock.timestamp;
    } catch {}
    if (this._onUpdate) this._onUpdate(this.snapshot());
  }

  _fmtSku(sku) {
    if (!sku) return null;
    if (sku.includes('free')) return 'Free';
    if (sku.includes('pro')) return 'Pro';
    if (sku.includes('business') || sku.includes('enterprise')) return 'Business';
    return sku.replace(/_/g, ' ');
  }

  snapshot() {
    return {
      agentId: this.agentId,
      agentName: this.agentName,
      agentIcon: this.agentIcon,
      noSessionData: true,
      copilotData: {
        account: this._account,
        plan: this._fmtSku(this._sku),
        version: this._version,
        turns: this._turns,
        sessionStart: this._sessionStart,
      },
    };
  }
}

// ── Extension-based agents (Continue, Cline, Codex, Roo) ────────────────
// Detected via VS Code extension registry but session data not accessible.
class ExtensionSession {
  constructor(def) {
    this.agentId = def.id;
    this.agentName = def.name;
    this.agentIcon = def.icon;
    this._onUpdate = null;
  }

  onUpdate(fn) { this._onUpdate = fn; }
  start() {}
  stop() {}

  snapshot() {
    return {
      agentId: this.agentId,
      agentName: this.agentName,
      agentIcon: this.agentIcon,
      tokens: { total: 0 },
      contextFill: 0,
      messages: [],
      insights: [],
      noSessionData: true,
    };
  }
}

module.exports = { CursorSession, AiderSession, ExtensionSession, CopilotSession };
