'use strict';
const vscode = require('vscode');
const path = require('path');
const auth = require('./auth');
const { PromptOptimizer } = require('./optimizer');

const API_BASE = 'https://www.terseai.org';

const optimizer = new PromptOptimizer();

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars[Math.floor(Math.random() * chars.length)];
  return text;
}

class TersePanel {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
    this._pendingResult = null;
  }

  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));

    // Send initial state once visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._sendState();
    });
    this._sendState();
  }

  // Send current state to WebView
  async _sendState() {
    if (!this._view) return;
    const storedAuth = auth.getStoredAuth();
    const license = storedAuth ? await auth.getLicense() : null;
    const config = vscode.workspace.getConfiguration('terse');
    this._post({
      type: 'state',
      auth: storedAuth,
      license,
      mode: config.get('mode', 'normal'),
      autoMode: config.get('autoMode', false),
    });
  }

  _post(msg) {
    this._view?.webview.postMessage(msg);
  }

  async _handleMessage(msg) {
    switch (msg.type) {

      case 'getState':
        await this._sendState();
        break;

      case 'optimize': {
        const text = msg.text?.trim();
        if (!text) return;

        // Auth gate
        const storedAuth = auth.getStoredAuth();
        if (!storedAuth?.signedIn) {
          this._post({ type: 'error', error: 'Please sign in to optimize.' });
          return;
        }
        const license = await auth.getLicense();
        if (!license || license.tier === 'none' || license.remaining === 0) {
          this._post({ type: 'upgradeRequired' });
          return;
        }

        try {
          const mode = msg.mode || vscode.workspace.getConfiguration('terse').get('mode', 'normal');
          const result = await optimizer.optimize(text, { aggressiveness: mode });
          this._post({ type: 'optimizeResult', result });
        } catch (e) {
          this._post({ type: 'error', error: e.message });
        }
        break;
      }

      case 'replace': {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !msg.text) return;
        const sel = editor.selection;
        const range = sel.isEmpty
          ? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length))
          : sel;
        await editor.edit(eb => eb.replace(range, msg.text));
        vscode.window.setStatusBarMessage('$(check) Terse: replaced', 2000);
        break;
      }

      case 'copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('$(clippy) Terse: copied', 2000);
        }
        break;

      case 'capture': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          this._post({ type: 'capture', text: '' });
          return;
        }
        const sel = editor.selection;
        const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
        this._post({ type: 'capture', text });
        break;
      }

      case 'setMode':
        await vscode.workspace.getConfiguration('terse').update('mode', msg.mode, vscode.ConfigurationTarget.Global);
        break;

      case 'toggleAuto':
        await vscode.workspace.getConfiguration('terse').update('autoMode', msg.enabled, vscode.ConfigurationTarget.Global);
        break;

      case 'signin': {
        try {
          const result = await auth.startAuth(vscode, msg.action || 'signin');
          const license = await auth.getLicense(true);
          this._post({ type: 'authChanged', auth: result, license });
        } catch (e) {
          this._post({ type: 'error', error: e.message });
        }
        break;
      }

      case 'signout':
        await auth.signOut();
        this._post({ type: 'authChanged', auth: null, license: null });
        break;

      case 'upgrade':
        vscode.env.openExternal(vscode.Uri.parse(`${API_BASE}/upgrade?from=vscode`));
        break;

      case 'checkout': {
        const stored = auth.getStoredAuth();
        if (!stored?.clerkUserId) break;
        const { tier, paymentMethod: pm } = msg;
        const body = { tier, clerkUserId: stored.clerkUserId, clerkUserEmail: stored.email, noTrial: true };
        if (pm) body.paymentMethod = pm;
        try {
          const res = await fetch(`${API_BASE}/api/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (data.url) {
            vscode.env.openExternal(vscode.Uri.parse(data.url));
          } else {
            vscode.window.showErrorMessage('Terse: checkout failed — ' + (data.error || 'unknown error'));
          }
        } catch (e) {
          vscode.window.showErrorMessage('Terse: network error — ' + e.message);
        }
        break;
      }

      case 'manageSub': {
        const stored = auth.getStoredAuth();
        if (stored?.clerkUserId) {
          vscode.env.openExternal(vscode.Uri.parse(
            `${API_BASE}/api/portal/redirect?uid=${encodeURIComponent(stored.clerkUserId)}`
          ));
        }
        break;
      }

      case 'agentGetAll':
        // WebView is requesting all current agent snapshots (on load)
        if (global._agentManager) {
          const snapshots = global._agentManager.getAllSnapshots();
          for (const s of snapshots) this._post({ type: 'agentUpdate', snapshot: s });
        }
        break;

      case 'installClaudeHooks':
        this._installClaudeHooks();
        break;
    }
  }

  async _installClaudeHooks() {
    const vscode = require('vscode');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      let settings = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      // Add Terse hook for PostToolUse to compress tool results
      settings.hooks = settings.hooks || {};
      settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
      const already = settings.hooks.PostToolUse.some(h => h.hooks?.some(hh => hh.name === 'terse'));
      if (!already) {
        settings.hooks.PostToolUse.push({
          matcher: '',
          hooks: [{ type: 'command', command: 'echo', name: 'terse' }],
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        this._post({ type: 'hooksInstalled', ok: true });
        vscode.window.showInformationMessage('Terse: Claude Code hooks installed!');
      } else {
        this._post({ type: 'hooksInstalled', ok: true, alreadyInstalled: true });
      }
    } catch (e) {
      this._post({ type: 'hooksInstalled', ok: false, error: e.message });
    }
  }

  // Push current selection to the panel
  pushSelection(text) {
    this._post({ type: 'selection', text });
  }

  _getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Terse</title>
</head>
<body>
  <div id="root">

    <!-- Auth Gate -->
    <div id="authGate" class="hidden">
      <div class="auth-logo">⚡ Terse</div>
      <p class="auth-desc">Compress AI prompts &amp; LLM context by 20–40%.<br>Sign in to get started.</p>
      <button class="btn primary" id="btnSignin">Sign In / Sign Up</button>
      <p class="auth-note">30-day free trial · No credit card required</p>
    </div>

    <!-- Main optimizer UI -->
    <div id="main" class="hidden">

      <!-- Header -->
      <div class="header">
        <span class="logo">⚡ Terse</span>
        <div class="mode-tabs" id="modeTabs">
          <button class="mode-tab" data-mode="soft">Soft</button>
          <button class="mode-tab active" data-mode="normal">Normal</button>
          <button class="mode-tab" data-mode="aggressive">Aggr</button>
        </div>
        <label class="auto-label" title="Auto-optimize selection as you type">
          <input type="checkbox" id="autoToggle"> Auto
        </label>
      </div>

      <!-- Agent Monitor -->
      <div id="agentSection">
        <div class="section-row agent-header">
          <span class="label">🤖 Agent Monitor</span>
          <span id="agentCount" class="agent-count-badge hidden">0 active</span>
        </div>
        <div id="agentList" class="agent-list">
          <div class="agent-empty" id="agentEmpty">Scanning for AI agents…</div>
        </div>
      </div>

      <div class="divider"></div>

      <!-- Input -->
      <div class="section">
        <div class="section-row">
          <span class="label">Input</span>
          <span class="token-badge" id="inputTokens">0 tokens</span>
        </div>
        <textarea id="inputText" placeholder="Select text in editor or type your prompt here…" rows="6" spellcheck="false"></textarea>
      </div>

      <!-- Actions row -->
      <div class="row gap-4">
        <button class="btn primary flex-1" id="btnOptimize">Optimize</button>
        <button class="btn flex-1" id="btnCapture">Capture Selection</button>
      </div>

      <!-- Output -->
      <div id="outputSection" class="section hidden">
        <div class="section-row">
          <span class="label">Optimized</span>
          <span class="stats-badge" id="statsBadge"></span>
        </div>
        <textarea id="outputText" readonly rows="6" spellcheck="false"></textarea>
        <div id="techniquesList" class="techniques"></div>
        <div class="row gap-4 mt-4">
          <button class="btn primary flex-1" id="btnReplace">Replace in Editor</button>
          <button class="btn flex-1" id="btnCopy">Copy</button>
        </div>
      </div>

      <!-- Error -->
      <div id="errorBox" class="error-box hidden"></div>

      <!-- Plan row -->
      <div class="plan-row" id="planRow">
        <span id="planBadge" class="plan-badge">Free Trial</span>
        <span id="quotaLabel" class="quota-label"></span>
        <a id="upgradeLink" class="upgrade-link hidden">Upgrade →</a>
        <button id="btnManageSub" class="link-btn hidden">Manage subscription</button>
      </div>

      <!-- Footer -->
      <div class="footer">
        <span id="userLabel" class="user-label"></span>
        <button class="link-btn" id="btnSignout">Sign out</button>
      </div>
    </div>

    <!-- Upgrade Gate -->
    <div id="upgradeGate" class="hidden">
      <div class="auth-logo">⚡ Terse</div>
      <p class="auth-desc">Subscribe to keep optimizing.</p>
      <button class="btn primary" id="btnSubscribePro">Subscribe Pro — $4.99/mo</button>
      <button class="btn mt-8" id="btnSubscribeWechat" style="background:#07C160;color:#fff;border:none">WeChat Pay / 微信支付</button>
      <button class="btn mt-4" id="btnSubscribeAlipay" style="background:#1677FF;color:#fff;border:none">Alipay / 支付宝</button>
      <button class="link-btn mt-8" id="btnBackFromUpgrade">← Back</button>
    </div>

  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

module.exports = { TersePanel };
