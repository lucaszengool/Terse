'use strict';
const { AgentScanner, EXTENSION_AGENTS } = require('./scanner');
const { ClaudeCodeSession } = require('./claude-code');
const { CodexSession } = require('./codex');
const { CursorSession, AiderSession, ExtensionSession, CopilotSession } = require('./generic');

class AgentManager {
  constructor(vscodeApi, workspacePath) {
    this._vscode = vscodeApi;
    this._workspacePath = workspacePath || '';
    this._scanner = new AgentScanner(vscodeApi);
    this._sessions = new Map();   // agentId → session instance
    this._interval = null;
    this._listeners = { detected: [], update: [], lost: [] };
  }

  on(event, fn) {
    if (this._listeners[event]) this._listeners[event].push(fn);
  }

  _emit(event, data) {
    for (const fn of (this._listeners[event] || [])) {
      try { fn(data); } catch {}
    }
  }

  start() {
    this._scan();
    this._interval = setInterval(() => this._scan(), 5000);
  }

  stop() {
    clearInterval(this._interval);
    for (const session of this._sessions.values()) session.stop();
    this._sessions.clear();
  }

  _scan() {
    const found = this._scanner.scan();
    const foundIds = new Set(found.map(a => a.id));
    const { gained, lost } = this._scanner.updateMisses(foundIds);

    for (const agentId of lost) {
      this._sessions.get(agentId)?.stop();
      this._sessions.delete(agentId);
      this._emit('lost', { agentId });
    }

    for (const agentDef of found.filter(a => gained.includes(a.id))) {
      const session = this._createSession(agentDef);
      this._sessions.set(agentDef.id, session);
      session.onUpdate(snapshot => this._emit('update', snapshot));
      session.start();
      this._emit('detected', { ...agentDef, snapshot: session.snapshot() });
    }
  }

  _createSession(def) {
    switch (def.id) {
      case 'claude-code':   return new ClaudeCodeSession(this._workspacePath);
      case 'codex':         return new CodexSession();
      case 'cursor-agent':  return new CursorSession();
      case 'aider':         return new AiderSession(this._workspacePath);
      case 'copilot-chat':  return new CopilotSession(def, this._workspacePath);
      default:              return new ExtensionSession(def);
    }
  }

  getSnapshot(agentId) {
    return this._sessions.get(agentId)?.snapshot() || null;
  }

  getAllSnapshots() {
    return [...this._sessions.values()].map(s => s.snapshot());
  }

  // Update workspace path when VS Code workspace changes
  setWorkspacePath(p) {
    this._workspacePath = p;
    // Re-start Claude Code session if active
    if (this._sessions.has('claude-code')) {
      this._sessions.get('claude-code').stop();
      const session = this._createSession({ id: 'claude-code', name: 'Claude Code', icon: '🤖' });
      this._sessions.set('claude-code', session);
      session.onUpdate(snapshot => this._emit('update', snapshot));
      session.start();
    }
  }
}

module.exports = { AgentManager };
