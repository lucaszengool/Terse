'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// VS Code extension IDs for agent detection
const EXTENSION_AGENTS = {
  'GitHub.copilot-chat':       { id: 'copilot-chat',  name: 'GitHub Copilot Chat', icon: '🤖' },
  'Continue.continue':         { id: 'continue',       name: 'Continue.dev',        icon: '🔵' },
  'saoudrizwan.claude-dev':    { id: 'cline',          name: 'Cline',               icon: '🟣' },
  'RooVeterinaryInc.roo-cline':{ id: 'roo-code',      name: 'Roo Code',            icon: '🦘' },
  'anysphere.cursor-retrieval':{ id: 'cursor-agent',   name: 'Cursor Agent',        icon: '⚡' },
};

// Process name → agent definition
const PROCESS_AGENTS = {
  'claude':         { id: 'claude-code',  name: 'Claude Code',   icon: '🤖' },
  'aider':          { id: 'aider',        name: 'Aider',         icon: '🤝' },
  'Cursor':         { id: 'cursor-agent', name: 'Cursor Agent',  icon: '⚡' },
  'Cursor Helper':  { id: 'cursor-agent', name: 'Cursor Agent',  icon: '⚡' },
  'openclaw':       { id: 'openclaw',     name: 'OpenClaw',      icon: '🦅' },
  'codex':          { id: 'codex',        name: 'OpenAI Codex',  icon: '🧠' },
};

// Files/dirs that signal an agent is active when recently modified (checked by mtime)
const CONFIG_DIR_AGENTS = {
  [path.join(os.homedir(), '.claude', 'projects')]:        'claude-code',
  // Use the chat history file — it's updated every turn, unlike the static config
  [path.join(os.homedir(), '.aider.chat.history.md')]:     'aider',
  [path.join(os.homedir(), '.continue')]:                  'continue',
  [path.join(os.homedir(), '.cline')]:                     'cline',
  // Codex writes session logs here; mtime updates on every turn
  [path.join(os.homedir(), '.codex', 'sessions')]:         'codex',
};

class AgentScanner {
  constructor(vscodeApi) {
    this._vscode = vscodeApi;
    this._missCount = {};   // agentId → consecutive miss count
    this._known = new Set();
  }

  // Returns array of { id, name, icon, source } for all currently visible agents
  scan() {
    const found = new Map();

    // 1. VS Code extension detection
    for (const [extId, def] of Object.entries(EXTENSION_AGENTS)) {
      try {
        const ext = this._vscode.extensions.getExtension(extId);
        if (ext?.isActive) found.set(def.id, { ...def, source: 'extension', extId });
      } catch {}
    }

    // 2. Detect if running inside Cursor (VS Code fork)
    try {
      if (this._vscode.env.appName?.toLowerCase().includes('cursor')) {
        found.set('cursor-agent', { id: 'cursor-agent', name: 'Cursor Agent', icon: '⚡', source: 'env' });
      }
    } catch {}

    // 3. Process scan (cross-platform)
    try {
      let procNames;
      if (process.platform === 'win32') {
        const out = execSync('tasklist /fo csv /nh', { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        // CSV columns: "Image Name","PID","Session Name","Session#","Mem Usage"
        procNames = out.split('\n')
          .map(l => l.split(',')[0]?.replace(/"/g, '').replace(/\.exe$/i, '').trim())
          .filter(Boolean);
      } else {
        const out = execSync('ps -axo comm', { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        procNames = out.split('\n').map(l => l.trim()).filter(Boolean);
      }
      for (const proc of procNames) {
        const def = PROCESS_AGENTS[proc];
        if (def && !found.has(def.id)) found.set(def.id, { ...def, source: 'process' });
      }
    } catch {}

    // 3b. Windows: CLI tools run as node.exe — scan command lines
    // Try PowerShell first (works on Win10/11), fall back to wmic (deprecated in Win11)
    if (process.platform === 'win32') {
      let cmdlines = '';
      try {
        cmdlines = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\'\\\" | Select-Object -ExpandProperty CommandLine"',
          { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
      } catch {
        try {
          cmdlines = execSync('wmic process where "name=\'node.exe\'" get commandline /format:csv',
            { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {}
      }
      const lo = cmdlines.toLowerCase();
      if (!found.has('claude-code') && (lo.includes('\\claude\\') || lo.includes('@anthropic-ai/claude-code') || lo.includes('/claude/'))) {
        found.set('claude-code', { id: 'claude-code', name: 'Claude Code', icon: '🤖', source: 'process' });
      }
      if (!found.has('aider') && lo.includes('aider')) {
        found.set('aider', { id: 'aider', name: 'Aider', icon: '🤝', source: 'process' });
      }
      if (!found.has('codex') && (lo.includes('openai/codex') || lo.includes('@openai/codex'))) {
        found.set('codex', { id: 'codex', name: 'OpenAI Codex', icon: '🧠', source: 'process' });
      }
    }

    // 4. Config dir mtime check (catches agents without dedicated processes)
    const twoMinutesAgo = Date.now() - 2 * 60_000;
    for (const [dir, agentId] of Object.entries(CONFIG_DIR_AGENTS)) {
      if (found.has(agentId)) continue;
      try {
        const stat = fs.statSync(dir);
        if (stat.mtimeMs > twoMinutesAgo) {
          const def = Object.values(PROCESS_AGENTS).find(d => d.id === agentId) || { id: agentId, name: agentId, icon: '🤖' };
          found.set(agentId, { ...def, source: 'configdir' });
        }
      } catch {}
    }

    return [...found.values()];
  }

  // Debounced: agent must be missing 3 consecutive scans before "lost"
  updateMisses(foundIds) {
    const lost = [];
    for (const id of this._known) {
      if (!foundIds.has(id)) {
        this._missCount[id] = (this._missCount[id] || 0) + 1;
        if (this._missCount[id] >= 3) {
          lost.push(id);
          this._known.delete(id);
          delete this._missCount[id];
        }
      } else {
        this._missCount[id] = 0;
      }
    }
    const gained = [];
    for (const id of foundIds) {
      if (!this._known.has(id)) {
        gained.push(id);
        this._known.add(id);
        this._missCount[id] = 0;
      }
    }
    return { gained, lost };
  }
}

module.exports = { AgentScanner, EXTENSION_AGENTS };
