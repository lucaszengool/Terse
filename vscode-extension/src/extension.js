'use strict';
const vscode = require('vscode');
const http = require('http');
const auth = require('./auth');
const { TersePanel } = require('./panel');
const { PromptOptimizer } = require('./optimizer');
const { AgentManager } = require('./agents/index');
const reviewNudge = require('./review-nudge');

const BRIDGE_PORT = 47821;
let server = null;
let statusItem = null;
let tersePanel = null;
let agentManager = null;
let editorFocused = false;
let autoDebounce = null;

const optimizer = new PromptOptimizer();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEditorActuallyFocused() {
  try {
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab?.input) {
      const t = activeTab.input.constructor?.name || '';
      if (t.includes('Webview') || t.includes('Terminal')) return false;
      if (activeTab.input.uri) return true;
    }
  } catch {}
  return editorFocused;
}

function getEditorContent() {
  const editor = vscode.window.activeTextEditor;
  const focused = isEditorActuallyFocused();
  if (!editor || !focused) {
    return { text: '', selection: '', fileName: '', hasEditor: !!editor, focused: false };
  }
  const doc = editor.document;
  const sel = editor.selection;
  return {
    text: doc.getText(),
    selection: doc.getText(sel),
    fileName: doc.fileName,
    languageId: doc.languageId,
    hasEditor: true,
    focused: true,
  };
}

function updateStatusBar(label, tooltip) {
  if (!statusItem) return;
  statusItem.text = label;
  if (tooltip) statusItem.tooltip = tooltip;
}

// ── Activate ──────────────────────────────────────────────────────────────────

function activate(context) {
  auth.init(context);
  reviewNudge.init(context);
  editorFocused = !!vscode.window.activeTextEditor;

  // ── Status bar ──
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(circuit-board) Terse';
  statusItem.tooltip = 'Terse Token Optimizer';
  statusItem.command = 'terse.showPanel';
  statusItem.show();

  // ── WebView panel provider (sidebar) ──
  tersePanel = new TersePanel(context.extensionUri);

  // ── Agent Monitor ──
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  agentManager = new AgentManager(vscode, workspacePath);

  agentManager.on('detected', info => {
    tersePanel?._post({ type: 'agentDetected', agent: info });
    updateStatusBar(`$(circuit-board) Terse · ${info.name} detected`, `Terse: ${info.name} session active`);
  });

  agentManager.on('update', snapshot => {
    tersePanel?._post({ type: 'agentUpdate', snapshot });
    // Update status bar with context fill warning
    if (snapshot.contextFill >= 85) {
      updateStatusBar(`$(warning) Terse · ${snapshot.agentName} ${snapshot.contextFill}%`, 'Context almost full — optimize now');
    }
  });

  agentManager.on('lost', ({ agentId }) => {
    tersePanel?._post({ type: 'agentLost', agentId });
  });

  agentManager.start();
  global._agentManager = agentManager;

  // Update workspace path when it changes
  const workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(e => {
    const newPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    agentManager.setWorkspacePath(newPath);
  });
  const panelRegistration = vscode.window.registerWebviewViewProvider('terse.panel', tersePanel, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  // ── Track editor focus ──
  const editorChange = vscode.window.onDidChangeActiveTextEditor(e => {
    editorFocused = !!e;
  });

  // ── Selection watcher (for auto-mode + live token count) ──
  const selectionChange = vscode.window.onDidChangeTextEditorSelection(event => {
    const cfg = vscode.workspace.getConfiguration('terse');
    const sel = event.textEditor.selection;
    const text = event.textEditor.document.getText(sel);

    // Update status bar token count
    if (cfg.get('showStatusBar', true) && text.length > 0) {
      const tokens = Math.ceil(text.length / 4);
      statusItem.text = `$(circuit-board) ${tokens} tokens`;
    } else {
      statusItem.text = '$(circuit-board) Terse';
    }

    // Auto-mode: push selection to panel + optionally auto-replace
    if (cfg.get('autoMode', false) && text.trim().length > 20) {
      clearTimeout(autoDebounce);
      autoDebounce = setTimeout(async () => {
        tersePanel?.pushSelection(text);
        if (cfg.get('autoReplace', false)) {
          try {
            const result = await optimizer.optimize(text, { aggressiveness: cfg.get('mode', 'normal') });
            if (result.percentSaved > 5) {
              await event.textEditor.edit(eb => eb.replace(sel, result.optimizedText));
              updateStatusBar(`$(circuit-board) −${result.percentSaved}%`, `Terse: auto-optimized (saved ${result.tokensSaved} tokens)`);
              reviewNudge.recordSuccess();
            }
          } catch {}
        }
      }, cfg.get('debounceMs', 600));
    }
  });

  // ── Commands ──

  const cmdShowPanel = vscode.commands.registerCommand('terse.showPanel', () => {
    vscode.commands.executeCommand('terse.panel.focus');
  });

  const cmdOptimize = vscode.commands.registerCommand('terse.optimize', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Terse: No active editor'); return; }
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    if (!text?.trim()) { vscode.window.showWarningMessage('Terse: Nothing to optimize'); return; }

    vscode.commands.executeCommand('terse.panel.focus');
    tersePanel?.pushSelection(text);
  });

  const cmdOptimizeReplace = vscode.commands.registerCommand('terse.optimizeReplace', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('Terse: No active editor'); return; }

    if (!auth.getStoredAuth()?.signedIn) {
      const choice = await vscode.window.showWarningMessage('Sign in to Terse to optimize.', 'Sign In');
      if (choice === 'Sign In') vscode.commands.executeCommand('terse.signin');
      return;
    }

    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    if (!text?.trim()) { vscode.window.showWarningMessage('Terse: Nothing to optimize'); return; }

    const cfg = vscode.workspace.getConfiguration('terse');
    const mode = cfg.get('mode', 'normal');

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Terse: optimizing…' },
      async () => {
        try {
          const result = await optimizer.optimize(text, { aggressiveness: mode });
          const range = sel.isEmpty
            ? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length))
            : sel;
          await editor.edit(eb => eb.replace(range, result.optimizedText));
          updateStatusBar(`$(circuit-board) −${result.percentSaved}%`, `Terse: saved ${result.tokensSaved} tokens`);
          setTimeout(() => updateStatusBar('$(circuit-board) Terse'), 3000);
          reviewNudge.recordSuccess();
        } catch (e) {
          vscode.window.showErrorMessage(`Terse: ${e.message}`);
        }
      }
    );
  });

  const cmdCopyOptimized = vscode.commands.registerCommand('terse.copyOptimized', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    if (!text?.trim()) return;

    const cfg = vscode.workspace.getConfiguration('terse');
    try {
      const result = await optimizer.optimize(text, { aggressiveness: cfg.get('mode', 'normal') });
      await vscode.env.clipboard.writeText(result.optimizedText);
      vscode.window.setStatusBarMessage(`$(clippy) Terse: copied (−${result.percentSaved}%)`, 2500);
      reviewNudge.recordSuccess();
    } catch (e) {
      vscode.window.showErrorMessage(`Terse: ${e.message}`);
    }
  });

  const cmdSetMode = vscode.commands.registerCommand('terse.setMode', async () => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(wand) Soft', description: 'Contractions + whitespace only. 100% meaning-preserving.', value: 'soft' },
        { label: '$(zap) Normal', description: 'Removes filler, hedging, meta-language. Balanced.', value: 'normal' },
        { label: '$(rocket) Aggressive', description: 'Max compression: abbreviations + telegraph style.', value: 'aggressive' },
      ],
      { placeHolder: 'Select Terse optimization mode' }
    );
    if (picked) {
      await vscode.workspace.getConfiguration('terse').update('mode', picked.value, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`$(circuit-board) Terse: ${picked.value} mode`, 2000);
    }
  });

  const cmdToggleAuto = vscode.commands.registerCommand('terse.toggleAutoMode', async () => {
    const cfg = vscode.workspace.getConfiguration('terse');
    const current = cfg.get('autoMode', false);
    await cfg.update('autoMode', !current, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`$(circuit-board) Terse auto: ${!current ? 'ON' : 'OFF'}`, 2000);
  });

  const cmdSignin = vscode.commands.registerCommand('terse.signin', async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Terse: opening sign-in page…', cancellable: false },
        () => auth.startAuth(vscode, 'signin')
      );
      const license = await auth.getLicense(true);
      tersePanel?._post({ type: 'authChanged', auth: auth.getStoredAuth(), license });
      vscode.window.showInformationMessage('Terse: signed in!');
    } catch (e) {
      vscode.window.showErrorMessage(`Terse sign-in: ${e.message}`);
    }
  });

  const cmdSignout = vscode.commands.registerCommand('terse.signout', async () => {
    await auth.signOut();
    tersePanel?._post({ type: 'authChanged', auth: null, license: null });
    vscode.window.showInformationMessage('Terse: signed out.');
  });

  const cmdUpgrade = vscode.commands.registerCommand('terse.upgrade', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://www.terseai.org/upgrade?from=vscode'));
  });

  // ── HTTP Bridge (backward compat with Electron/Tauri app) ──
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/ping') {
      res.end(JSON.stringify({ ok: true, bridge: 'terse', version: '1.0.0' }));

    } else if (req.method === 'GET' && req.url === '/text') {
      const c = getEditorContent();
      res.end(JSON.stringify({ ok: true, text: c.selection || c.text, selection: c.selection, fullText: c.text, fileName: c.fileName, hasEditor: c.hasEditor, focused: c.focused }));

    } else if (req.method === 'POST' && req.url === '/replace') {
      let body = '';
      req.on('data', ch => (body += ch));
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body);
          const editor = vscode.window.activeTextEditor;
          if (editor && text != null) {
            const sel = editor.selection;
            const range = sel.isEmpty
              ? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length))
              : sel;
            editor.edit(eb => eb.replace(range, text)).then(ok => res.end(JSON.stringify({ ok })));
          } else {
            res.end(JSON.stringify({ ok: false, error: 'no editor' }));
          }
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

    } else if (req.method === 'POST' && req.url === '/reload') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
      res.end(JSON.stringify({ ok: true }));

    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
  });

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    statusItem.tooltip = `Terse Token Optimizer · bridge on :${BRIDGE_PORT}`;
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      statusItem.tooltip = `Terse: bridge port ${BRIDGE_PORT} in use`;
    }
  });

  context.subscriptions.push(
    statusItem, panelRegistration, editorChange, selectionChange, workspaceChange,
    cmdShowPanel, cmdOptimize, cmdOptimizeReplace, cmdCopyOptimized,
    cmdSetMode, cmdToggleAuto, cmdSignin, cmdSignout, cmdUpgrade,
    { dispose: () => agentManager?.stop() },
  );
}

function deactivate() {
  server?.close();
  server = null;
  agentManager?.stop();
}

module.exports = { activate, deactivate };
