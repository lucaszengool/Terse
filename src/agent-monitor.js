/**
 * Terse Agent Monitor — Detect and monitor AI coding agent sessions.
 *
 * Supports:
 * - Claude Code CLI (watches ~/.claude/projects/ JSONL files)
 * - OpenClaw (connects to localhost API + watches ~/.openclaw/ logs)
 * - Generic agents (process detection via `ps`)
 *
 * Architecture:
 * 1. AgentScanner: polls `ps` every 5s to detect running agents
 * 2. AgentSession: watches JSONL/log files for a detected agent
 * 3. AgentAnalyzer: parses messages, tracks tokens, finds optimization opportunities
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const http = require('http');

// ── Agent Definitions ──

const AGENT_DEFS = {
  'claude-code': {
    name: 'Claude Code',
    icon: '🤖',
    processNames: ['claude'],
    logDir: path.join(os.homedir(), '.claude', 'projects'),
    logPattern: /\.jsonl$/,
    parser: 'claudeCode',
  },
  'openclaw': {
    name: 'OpenClaw',
    icon: '🦞',
    processNames: ['openclaw', 'claw'],
    logDir: path.join(os.homedir(), '.openclaw'),
    logPattern: /\.jsonl?$/,
    parser: 'openclaw',
    apiPort: 18789,
  },
  'aider': {
    name: 'Aider',
    icon: '🔧',
    processNames: ['aider'],
    logDir: null, // aider logs to .aider.chat.history.md in project dir
    parser: 'generic',
  },
  'cursor-agent': {
    name: 'Cursor Agent',
    icon: '📝',
    processNames: ['Cursor Helper', 'Cursor.app'],
    logDir: null,
    parser: 'generic',
  },
};

// ── Agent Scanner ──
// Periodically checks for running agent processes

class AgentScanner {
  constructor() {
    this.detected = new Map(); // agentType → { pid, startTime }
    this.listeners = [];       // callbacks: (event, agentInfo) => void
    this._interval = null;
  }

  /**
   * Start scanning for agents every `intervalMs`.
   */
  start(intervalMs = 5000) {
    if (this._interval) return;
    this._scan(); // immediate first scan
    this._interval = setInterval(() => this._scan(), intervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /**
   * Register a listener for agent detection events.
   * Events: 'detected', 'lost'
   */
  onEvent(fn) {
    this.listeners.push(fn);
  }

  _emit(event, info) {
    for (const fn of this.listeners) {
      try { fn(event, info); } catch (e) { console.error('AgentScanner listener error:', e); }
    }
  }

  async _scan() {
    try {
      const procs = await this._listProcesses();
      const nowDetected = new Set();

      for (const [type, def] of Object.entries(AGENT_DEFS)) {
        for (const proc of procs) {
          const comm = proc.comm.toLowerCase();
          const matched = def.processNames.some(name => {
            const lname = name.toLowerCase();
            const basename = comm.split('/').pop();
            return basename === lname || comm.includes('/' + lname) ||
                   (comm.includes(lname) && !comm.includes('.xpc/') && !comm.includes('framework'));
          });
          if (matched) {
            nowDetected.add(type);
            if (!this.detected.has(type)) {
              const info = {
                type,
                name: def.name,
                icon: def.icon,
                pid: proc.pid,
                parser: def.parser,
                logDir: def.logDir,
                apiPort: def.apiPort,
              };
              this.detected.set(type, info);
              this._emit('detected', info);
            }
            break;
          }
        }
      }

      // Check for lost agents (require 3 consecutive misses to avoid flaky ps)
      for (const [type, info] of this.detected) {
        if (!nowDetected.has(type)) {
          info._missCount = (info._missCount || 0) + 1;
          if (info._missCount >= 3) {
            this.detected.delete(type);
            this._emit('lost', info);
          }
        } else {
          info._missCount = 0;
        }
      }
    } catch (e) {
      // Scan failure is non-fatal
    }
  }

  _listProcesses() {
    return new Promise((resolve) => {
      execFile('ps', ['-axo', 'pid,comm'], { timeout: 3000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        const lines = stdout.trim().split('\n').slice(1); // skip header
        const procs = lines.map(line => {
          const trimmed = line.trim();
          const spaceIdx = trimmed.indexOf(' ');
          if (spaceIdx < 0) return null;
          return {
            pid: parseInt(trimmed.slice(0, spaceIdx)),
            comm: trimmed.slice(spaceIdx + 1).trim(),
          };
        }).filter(Boolean);
        resolve(procs);
      });
    });
  }
}

// ── JSONL File Watcher ──
// Watches a JSONL file and emits new lines as they're appended

class JSONLWatcher {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.watcher = null;
    this.listeners = [];
    this._reading = false;
  }

  start() {
    try {
      // Start from end of file (only watch new content)
      const stat = fs.statSync(this.filePath);
      this.offset = stat.size;
    } catch {
      this.offset = 0;
    }

    this.watcher = fs.watch(this.filePath, { persistent: false }, (eventType) => {
      if (eventType === 'change') this._readNew();
    });

    // Also poll every 2s as fallback (fs.watch can miss events)
    this._pollInterval = setInterval(() => this._readNew(), 2000);
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }

  onLine(fn) {
    this.listeners.push(fn);
  }

  _readNew() {
    if (this._reading) return;
    this._reading = true;

    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) { this._reading = false; return; }

      const stream = fs.createReadStream(this.filePath, {
        start: this.offset,
        encoding: 'utf-8',
      });

      let buffer = '';
      stream.on('data', (chunk) => { buffer += chunk; });
      stream.on('end', () => {
        this.offset = stat.size;
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            for (const fn of this.listeners) {
              try { fn(obj); } catch (e) { /* listener error */ }
            }
          } catch {
            // Not valid JSON, skip
          }
        }
        this._reading = false;
      });
      stream.on('error', () => { this._reading = false; });
    } catch {
      this._reading = false;
    }
  }
}

// ── Agent Session ──
// Represents a monitored agent session with parsed message history

class AgentSession {
  constructor(agentInfo) {
    this.agentInfo = agentInfo;
    this.id = `agent-${agentInfo.type}-${Date.now()}`;
    this.sessionFile = null;
    this.watcher = null;
    this.connected = false;

    // Token tracking
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreateTokens = 0;

    // Message history (last N for display)
    this.messages = [];      // { role, content, tokens, timestamp, type }
    this.toolCalls = [];     // { name, tokens, timestamp }
    this.turns = 0;

    // Optimization analysis
    this.userMessages = [];  // raw user messages for optimization analysis
    this.optimizationStats = {
      totalUserTokens: 0,
      potentialSavings: 0,
      optimizedMessages: 0,
    };

    this.listeners = [];
  }

  onUpdate(fn) {
    this.listeners.push(fn);
  }

  _emit(data) {
    if (this._suppressEmit) return;
    for (const fn of this.listeners) {
      try { fn(data); } catch (e) { /* */ }
    }
  }

  /**
   * Connect to the most recent session file for this agent.
   * Reads existing history first, then watches for new lines.
   */
  async connect() {
    const logDir = this.agentInfo.logDir;
    if (!logDir) {
      this.connected = true;
      this._emit({ event: 'connected', session: this });
      return true;
    }

    // Find the most recently modified JSONL file
    const sessionFile = await this._findLatestSession(logDir);
    if (!sessionFile) {
      return false;
    }

    this.sessionFile = sessionFile;

    // Read existing history line-by-line (streaming to avoid loading full file into RAM)
    this._suppressEmit = true;
    try {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: fs.createReadStream(sessionFile, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });
      await new Promise((resolve) => {
        rl.on('line', (line) => {
          if (!line.trim()) return;
          try {
            this._handleLine(JSON.parse(line));
          } catch { /* skip invalid */ }
        });
        rl.on('close', resolve);
        rl.on('error', resolve);
      });
    } catch (e) {
      console.error('[AgentSession] Failed to read history:', e.message);
    }
    this._suppressEmit = false;

    // Now watch for new lines going forward
    this.watcher = new JSONLWatcher(sessionFile);
    this.watcher.onLine((obj) => this._handleLine(obj));
    this.watcher.start();
    this.connected = true;

    // Emit connected with full history already parsed
    this._emit({ event: 'connected', session: this });
    return true;
  }

  disconnect() {
    if (this.watcher) { this.watcher.stop(); this.watcher = null; }
    this.connected = false;
    this._emit({ event: 'disconnected', session: this });
  }

  async _findLatestSession(logDir) {
    try {
      // Claude Code stores in ~/.claude/projects/<encoded-path>/*.jsonl
      // Try to find the project dir matching the app's own cwd first
      const appCwd = process.cwd();
      const encodedCwd = appCwd.replace(/\//g, '-');
      const ownProjectDir = path.join(logDir, encodedCwd);

      let subdirs;
      if (fs.existsSync(ownProjectDir)) {
        // Prefer own project dir — most likely the user wants to monitor the session for THIS project
        subdirs = [ownProjectDir];
      } else {
        // Fallback: scan all project dirs
        subdirs = fs.readdirSync(logDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => path.join(logDir, d.name));
      }

      let newest = null;
      let newestTime = 0;

      for (const dir of subdirs) {
        try {
          const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const fp = path.join(dir, f);
              try {
                const stat = fs.statSync(fp);
                return { path: fp, mtime: stat.mtimeMs };
              } catch { return null; }
            })
            .filter(Boolean);

          for (const f of files) {
            if (f.mtime > newestTime) {
              newestTime = f.mtime;
              newest = f.path;
            }
          }
        } catch { /* skip unreadable dirs */ }
      }

      // Only return if modified in last 30 minutes (active session)
      if (newest && (Date.now() - newestTime) < 30 * 60 * 1000) {
        return newest;
      }
      return null;
    } catch {
      return null;
    }
  }

  _handleLine(obj) {
    if (this.agentInfo.parser === 'claudeCode') {
      this._parseClaudeCodeLine(obj);
    } else if (this.agentInfo.parser === 'openclaw') {
      this._parseOpenClawLine(obj);
    } else {
      this._parseGenericLine(obj);
    }
  }

  // ── Claude Code JSONL Parser ──
  _parseClaudeCodeLine(obj) {
    // Skip non-message records (file-history-snapshot, metadata, etc.)
    if (!obj.message || !obj.message.role) return;
    if (obj.type === 'file-history-snapshot') return;
    const msg = obj.message;
    const ts = obj.timestamp || new Date().toISOString();

    // Track token usage (input_tokens is small; real input is in cache fields)
    if (msg.usage) {
      const u = msg.usage;
      this.totalInputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this.totalOutputTokens += u.output_tokens || 0;
      this.totalCacheReadTokens += u.cache_read_input_tokens || 0;
      this.totalCacheCreateTokens += u.cache_creation_input_tokens || 0;
    }

    // Parse content
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          this.messages.push({
            role: msg.role,
            text: block.text,
            tokens: this._estimateBlockTokens(block.text),
            timestamp: ts,
            type: 'text',
          });

          // Track user messages for optimization analysis
          if (msg.role === 'user') {
            this.userMessages.push({
              text: block.text,
              tokens: this._estimateBlockTokens(block.text),
              timestamp: ts,
            });
          }
        } else if (block.type === 'tool_use') {
          this.toolCalls.push({
            name: block.name,
            id: block.id,
            tokens: this._estimateBlockTokens(JSON.stringify(block.input || {})),
            timestamp: ts,
          });
          this.messages.push({
            role: 'tool',
            text: `Tool: ${block.name}`,
            tokens: 0,
            timestamp: ts,
            type: 'tool_use',
            toolName: block.name,
          });
        } else if (block.type === 'tool_result') {
          this.messages.push({
            role: 'tool',
            text: `Result: ${(block.content || '').substring(0, 100)}...`,
            tokens: this._estimateBlockTokens(block.content || ''),
            timestamp: ts,
            type: 'tool_result',
          });
        }
      }
    } else if (typeof msg.content === 'string') {
      this.messages.push({
        role: msg.role,
        text: msg.content,
        tokens: this._estimateBlockTokens(msg.content),
        timestamp: ts,
        type: 'text',
      });

      if (msg.role === 'user') {
        this.userMessages.push({
          text: msg.content,
          tokens: this._estimateBlockTokens(msg.content),
          timestamp: ts,
        });
      }
    }

    if (msg.role === 'user' && !obj.toolUseResult) this.turns++;

    // Keep messages bounded
    if (this.messages.length > 200) {
      this.messages = this.messages.slice(-200);
    }
    if (this.userMessages.length > 50) {
      this.userMessages = this.userMessages.slice(-50);
    }

    this._emit({ event: 'message', session: this, message: this.messages[this.messages.length - 1] });
  }

  // ── OpenClaw JSONL Parser ──
  _parseOpenClawLine(obj) {
    // OpenClaw logs: { level, subsystem, message, timestamp, ... }
    const ts = obj.timestamp || new Date().toISOString();

    if (obj.tokens) {
      this.totalInputTokens += obj.tokens.input || 0;
      this.totalOutputTokens += obj.tokens.output || 0;
    }

    if (obj.message && typeof obj.message === 'string') {
      this.messages.push({
        role: obj.role || obj.subsystem || 'system',
        text: obj.message.substring(0, 500),
        tokens: this._estimateBlockTokens(obj.message),
        timestamp: ts,
        type: 'text',
      });
    }

    if (this.messages.length > 200) {
      this.messages = this.messages.slice(-200);
    }

    this._emit({ event: 'message', session: this });
  }

  // ── Generic Parser ──
  _parseGenericLine(obj) {
    const ts = new Date().toISOString();
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj).substring(0, 500);
    this.messages.push({
      role: 'unknown',
      text,
      tokens: this._estimateBlockTokens(text),
      timestamp: ts,
      type: 'text',
    });

    if (this.messages.length > 200) {
      this.messages = this.messages.slice(-200);
    }
    this._emit({ event: 'message', session: this });
  }

  _estimateBlockTokens(text) {
    if (!text) return 0;
    const words = text.split(/\s+/).filter(Boolean).length;
    const punctuation = (text.match(/[^\w\s]/g) || []).length;
    return Math.ceil(words * 1.3 + punctuation * 0.5);
  }

  /**
   * Run the optimizer on all user messages and calculate potential savings.
   * Stores per-message optimization details and technique breakdown.
   */
  analyzeOptimization(optimizer) {
    if (!optimizer || this.userMessages.length === 0) return this.optimizationStats;

    let totalOriginal = 0;
    let totalOptimized = 0;
    let optimizedCount = 0;
    const techniqueFreq = {};    // technique name → count
    const techniqueSavings = {}; // technique name → total tokens saved
    const perMessage = [];       // per-message optimization details (last 10)

    for (const msg of this.userMessages) {
      if (!msg.text || msg.text.length < 20) continue;
      const result = optimizer.optimize(msg.text);
      const saved = result.stats.tokensSaved;
      totalOriginal += result.stats.originalTokens;
      totalOptimized += result.stats.optimizedTokens;
      if (saved > 0) {
        optimizedCount++;
        const techs = result.stats.techniquesApplied;
        const perTech = techs.length > 0 ? Math.round(saved / techs.length) : 0;
        for (const t of techs) {
          techniqueFreq[t] = (techniqueFreq[t] || 0) + 1;
          techniqueSavings[t] = (techniqueSavings[t] || 0) + perTech;
        }
      }
      perMessage.push({
        original: msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : ''),
        optimized: result.optimized.substring(0, 100) + (result.optimized.length > 100 ? '...' : ''),
        originalTokens: result.stats.originalTokens,
        optimizedTokens: result.stats.optimizedTokens,
        saved,
        percent: result.stats.percentSaved,
        techniques: result.stats.techniquesApplied,
        timestamp: msg.timestamp,
      });
    }

    // Sort techniques by savings (most impactful first)
    const topTechniques = Object.entries(techniqueSavings)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, savings]) => ({
        name,
        count: techniqueFreq[name] || 0,
        tokensSaved: savings,
      }));

    this.optimizationStats = {
      totalUserTokens: totalOriginal,
      totalOptimizedTokens: totalOptimized,
      potentialSavings: totalOriginal - totalOptimized,
      percentSavings: totalOriginal > 0 ? Math.round(((totalOriginal - totalOptimized) / totalOriginal) * 100) : 0,
      optimizedMessages: optimizedCount,
      totalMessages: this.userMessages.length,
      topTechniques,
      recentOptimizations: perMessage.slice(-5),
    };

    return this.optimizationStats;
  }

  /**
   * Get a summary snapshot for the UI.
   */
  getSnapshot() {
    const costPer1KInput = 0.003;  // approximate $/1K tokens
    const costPer1KOutput = 0.015;
    const estCost = (this.totalInputTokens / 1000) * costPer1KInput
                  + (this.totalOutputTokens / 1000) * costPer1KOutput;

    return {
      id: this.id,
      agentType: this.agentInfo.type,
      agentName: this.agentInfo.name,
      agentIcon: this.agentInfo.icon,
      connected: this.connected,
      sessionFile: this.sessionFile,
      turns: this.turns,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreateTokens: this.totalCacheCreateTokens,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      estimatedCost: Math.round(estCost * 1000) / 1000, // round to 0.001
      recentMessages: this.messages.slice(-10),
      toolCalls: this.toolCalls.slice(-20),
      toolCallCount: this.toolCalls.length,
      optimizationStats: this.optimizationStats,
    };
  }
}

// ── OpenClaw API Monitor ──
// Connects to OpenClaw's local API for real-time stats

class OpenClawAPIMonitor {
  constructor(port = 18789) {
    this.port = port;
    this.alive = false;
  }

  async ping() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.port}/api/health`, { timeout: 1000 }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          this.alive = res.statusCode === 200;
          resolve(this.alive);
        });
      });
      req.on('error', () => { this.alive = false; resolve(false); });
      req.on('timeout', () => { req.destroy(); this.alive = false; resolve(false); });
    });
  }

  async getSessionInfo() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.port}/api/sessions`, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
}

// ── Main Agent Monitor ──
// Coordinates scanning, session management, and UI updates

class AgentMonitor {
  constructor() {
    this.scanner = new AgentScanner();
    this.sessions = new Map();     // agentType → AgentSession
    this.pendingDetections = [];   // agents detected but not yet accepted
    this.listeners = [];
    this._started = false;
  }

  /**
   * Register event listener.
   * Events: 'agent-detected', 'agent-lost', 'agent-connected',
   *         'agent-disconnected', 'agent-update', 'agent-message'
   */
  onEvent(fn) {
    this.listeners.push(fn);
  }

  _emit(event, data) {
    for (const fn of this.listeners) {
      try { fn(event, data); } catch (e) { console.error('AgentMonitor error:', e); }
    }
  }

  /**
   * Start scanning for agents.
   */
  start() {
    if (this._started) return;
    this._started = true;

    this.scanner.onEvent((event, info) => {
      if (event === 'detected') {
        // Skip if already connected or already pending
        if (this.sessions.has(info.type)) return;
        if (this.pendingDetections.some(d => d.type === info.type)) return;
        console.log(`[AgentMonitor] Detected: ${info.name} (PID ${info.pid})`);
        this.pendingDetections.push(info);
        this._emit('agent-detected', info);
      } else if (event === 'lost') {
        // Check if session file is still being written to (< 60s old)
        const session = this.sessions.get(info.type);
        if (session && session.sessionFile) {
          try {
            const stat = fs.statSync(session.sessionFile);
            if (Date.now() - stat.mtimeMs < 60000) {
              // File still active — don't disconnect, process might just be briefly invisible
              console.log(`[AgentMonitor] Process lost but session file still active — keeping connection`);
              return;
            }
          } catch { /* file gone, proceed with disconnect */ }
        }
        if (session) {
          console.log(`[AgentMonitor] Lost: ${info.name} — disconnecting`);
          session.disconnect();
          this.sessions.delete(info.type);
          this._emit('agent-lost', info);
        }
        this.pendingDetections = this.pendingDetections.filter(d => d.type !== info.type);
      }
    });

    this.scanner.start(5000);
  }

  stop() {
    this.scanner.stop();
    for (const session of this.sessions.values()) {
      session.disconnect();
    }
    this.sessions.clear();
    this._started = false;
  }

  /**
   * Accept a detected agent and start monitoring.
   * Called when user clicks "Connect" in the UI.
   */
  async acceptAgent(agentType) {
    const pending = this.pendingDetections.find(d => d.type === agentType);
    if (!pending) return null;

    // Remove from pending
    this.pendingDetections = this.pendingDetections.filter(d => d.type !== agentType);

    const session = new AgentSession(pending);
    session.onUpdate((data) => {
      if (data.event === 'message') {
        this._emit('agent-message', {
          agentType: pending.type,
          session: data.session.getSnapshot(),
        });
      }
    });

    const ok = await session.connect();
    if (ok) {
      this.sessions.set(agentType, session);
      this._emit('agent-connected', {
        agentType,
        session: session.getSnapshot(),
      });
      return session;
    }

    return null;
  }

  /**
   * Dismiss a detected agent (user clicked "No").
   */
  dismissAgent(agentType) {
    this.pendingDetections = this.pendingDetections.filter(d => d.type !== agentType);
    this._emit('agent-dismissed', { type: agentType });
  }

  /**
   * Disconnect a monitored agent session.
   */
  disconnectAgent(agentType) {
    const session = this.sessions.get(agentType);
    if (session) {
      session.disconnect();
      this.sessions.delete(agentType);
      this._emit('agent-disconnected', { type: agentType });
    }
  }

  /**
   * Get snapshots of all connected sessions.
   */
  getConnectedSessions() {
    const result = [];
    for (const session of this.sessions.values()) {
      result.push(session.getSnapshot());
    }
    return result;
  }

  /**
   * Get pending detections (agents detected but not yet accepted).
   */
  getPendingDetections() {
    return [...this.pendingDetections];
  }

  /**
   * Analyze optimization potential for a session.
   */
  analyzeSession(agentType, optimizer) {
    const session = this.sessions.get(agentType);
    if (!session) return null;
    return session.analyzeOptimization(optimizer);
  }
}

module.exports = {
  AgentMonitor,
  AgentScanner,
  AgentSession,
  JSONLWatcher,
  OpenClawAPIMonitor,
  AGENT_DEFS,
};
