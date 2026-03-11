const vscode = require('vscode');
const http = require('http');

const PORT = 47821;
let server = null;
let statusItem = null;
let editorFocused = false; // true when user is in a text editor, false when in sidebar/terminal/etc

function isEditorActuallyFocused() {
  // Check if the active tab is actually a text editor (not a webview/terminal)
  try {
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab && activeTab.input) {
      // TabInputText = text editor, TabInputWebview = webview panel
      const inputType = activeTab.input.constructor?.name || '';
      if (inputType.includes('Webview') || inputType.includes('Terminal')) return false;
      // Also check: if input has a uri, it's a text file
      if (activeTab.input.uri) return true;
    }
  } catch {}
  // Fallback to the tracked flag
  return editorFocused;
}

function getEditorContent() {
  const editor = vscode.window.activeTextEditor;
  const focused = isEditorActuallyFocused();
  if (!editor || !focused) return { text: '', selection: '', fileName: '', hasEditor: !!editor, focused: false };

  const doc = editor.document;
  const sel = editor.selection;
  const selectedText = doc.getText(sel);
  return {
    text: doc.getText(),
    selection: selectedText,
    fileName: doc.fileName,
    languageId: doc.languageId,
    hasEditor: true,
    focused: true,
  };
}

function activate(context) {
  // Track whether the user is focused on a text editor
  editorFocused = !!vscode.window.activeTextEditor;

  // When active editor changes: undefined means user left the editor (sidebar, terminal, etc)
  const editorChange = vscode.window.onDidChangeActiveTextEditor(editor => {
    editorFocused = !!editor;
  });

  // Also track visible text editor changes
  const visChange = vscode.window.onDidChangeVisibleTextEditors(editors => {
    if (editors.length === 0) editorFocused = false;
  });

  // Status bar indicator
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(plug) Terse';
  statusItem.tooltip = 'Terse Bridge active on port ' + PORT;
  statusItem.command = 'terse.status';
  statusItem.show();

  const statusCmd = vscode.commands.registerCommand('terse.status', () => {
    vscode.window.showInformationMessage(`Terse Bridge: listening on localhost:${PORT}`);
  });
  context.subscriptions.push(statusCmd, statusItem, editorChange, visChange);

  // HTTP server
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/text') {
      const content = getEditorContent();
      const text = content.selection || content.text;
      res.end(JSON.stringify({
        ok: true,
        text: text,
        selection: content.selection,
        fullText: content.text,
        fileName: content.fileName,
        hasEditor: content.hasEditor,
        focused: content.focused,
      }));

    } else if (req.method === 'GET' && req.url === '/ping') {
      res.end(JSON.stringify({ ok: true, bridge: 'terse', version: '0.1.0' }));

    } else if (req.method === 'POST' && req.url === '/replace') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body);
          const editor = vscode.window.activeTextEditor;
          if (editor && text != null) {
            const sel = editor.selection;
            const hasSelection = !sel.isEmpty;
            const range = hasSelection
              ? sel
              : new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
            editor.edit(editBuilder => {
              editBuilder.replace(range, text);
            }).then(ok => {
              res.end(JSON.stringify({ ok }));
            });
          } else {
            res.end(JSON.stringify({ ok: false, error: 'no editor' }));
          }
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

    } else if (req.method === 'POST' && req.url === '/reload') {
      // Trigger VS Code window reload (for applying settings changes)
      vscode.commands.executeCommand('workbench.action.reloadWindow');
      res.end(JSON.stringify({ ok: true }));

    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Terse Bridge listening on 127.0.0.1:${PORT}`);
    statusItem.text = '$(plug) Terse';
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      vscode.window.showWarningMessage(`Terse Bridge: port ${PORT} already in use`);
      statusItem.text = '$(warning) Terse';
    } else {
      console.error('Terse Bridge server error:', err);
    }
  });
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { activate, deactivate };
