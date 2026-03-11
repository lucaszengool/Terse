/**
 * Terse Capture — AX-first with selection fallback.
 *
 * PRIMARY: macOS Accessibility API via terse-ax helper (reads text elements directly)
 * FALLBACK: Cmd+C to copy user's selection (works everywhere including VS Code editor)
 * REPLACE: AXValue set or clipboard paste (Cmd+V)
 */

const { execFile } = require('child_process');
const { clipboard } = require('electron');
const http = require('http');
const path = require('path');

const AX_BIN = path.join(__dirname, 'helpers', 'terse-ax');

/** Get frontmost app info via NSWorkspace */
function getFrontApp() {
  return new Promise((resolve) => {
    const script = `
ObjC.import("Cocoa");
function run() {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var name = app.localizedName.js;
  var bid = app.bundleIdentifier.js;
  var pid = app.processIdentifier;
  var title = "";
  try {
    var se = Application("System Events");
    var procs = se.processes.whose({unixId: pid});
    if (procs.length > 0) { try { title = procs[0].windows[0].name(); } catch(e) {} }
  } catch(e) {}
  return JSON.stringify({name: name, bundleId: bid, pid: pid, title: title});
}`;
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 4000 }, (err, stdout) => {
      if (err) { resolve({ name: '?', pid: 0, title: '', bundleId: '' }); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve({ name: '?', pid: 0, title: '', bundleId: '' }); }
    });
  });
}

/** Activate app by name */
function activateApp(appName) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "${appName}" to activate`],
      { timeout: 3000 }, () => setTimeout(resolve, 300));
  });
}

/** Send keystrokes */
function sendKeys(cmd) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "System Events" to ${cmd}`],
      { timeout: 3000 }, () => setTimeout(resolve, 80));
  });
}

/** Send multiple keystrokes in a single osascript call (much faster, less memory) */
function sendKeysBatch(cmds, delays) {
  const parts = [];
  for (let i = 0; i < cmds.length; i++) {
    parts.push(cmds[i]);
    if (delays && delays[i]) parts.push(`delay ${delays[i]}`);
  }
  const script = `tell application "System Events"\n${parts.join('\n')}\nend tell`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, () => setTimeout(resolve, 50));
  });
}

/**
 * Read text via Accessibility API at a specific position.
 * This is the primary method — reads AXValue directly from the text element.
 */
function readAXAt(x, y) {
  return new Promise((resolve) => {
    execFile(AX_BIN, ['read-at', String(x), String(y)], { timeout: 4000 }, (err, stdout) => {
      if (err) { resolve({ text: '', method: 'ax-error', ok: false }); return; }
      try {
        const r = JSON.parse(stdout.trim());
        if (r.ok && r.value && r.value.trim().length > 0) {
          resolve({ text: r.value, method: 'ax-position', ok: true, role: r.role });
        } else {
          resolve({ text: '', method: 'ax-empty', ok: r.ok, role: r.role });
        }
      } catch {
        resolve({ text: '', method: 'ax-error', ok: false });
      }
    });
  });
}

/**
 * Read text via AX from an app's focused element or window tree.
 * Uses read-app which tries: focused element → position hint → window walk
 */
function readAXApp(pid, hintX, hintY) {
  const axArgs = ['read-app', String(pid)];
  if (hintX != null && hintY != null) {
    axArgs.push(String(hintX), String(hintY));
  }
  return new Promise((resolve) => {
    execFile(AX_BIN, axArgs, { timeout: 4000 }, (err, stdout) => {
      if (err) { resolve({ text: '', method: 'ax-error', ok: false }); return; }
      try {
        const r = JSON.parse(stdout.trim());
        if (r.ok && r.value && r.value.trim().length > 0) {
          resolve({ text: r.value, method: `ax-${r.strategy || 'app'}`, ok: true, role: r.role });
        } else {
          resolve({ text: '', method: 'ax-empty', ok: r.ok });
        }
      } catch {
        resolve({ text: '', method: 'ax-error', ok: false });
      }
    });
  });
}

/**
 * Read via Cmd+C — copies whatever user has selected.
 * Universal fallback that works everywhere including VS Code editor.
 */
async function readSelection(appName) {
  const saved = clipboard.readText();
  clipboard.writeText('__TERSE_SENTINEL__');

  await activateApp(appName);
  await sendKeys('keystroke "c" using command down');
  await new Promise(r => setTimeout(r, 200));

  const captured = clipboard.readText();

  // Restore clipboard
  setTimeout(() => {
    if (saved !== '__TERSE_SENTINEL__') clipboard.writeText(saved);
  }, 300);

  if (captured === '__TERSE_SENTINEL__') return { text: '', method: 'none' };
  return { text: captured, method: 'selection' };
}

/**
 * Read ALL text from the focused input via Cmd+A → Cmd+C → right-arrow (deselect).
 * Works for webview inputs (Claude Code in VS Code) where AX can't see the DOM.
 * More disruptive than AX read — only use when AX/bridge can't reach the input.
 */
/**
 * Extract the last user input from terminal output.
 * Claude Code uses "❯" as the prompt. Filter out system lines, separators, etc.
 */
function parseLastInput(fullText) {
  const lines = fullText.split('\n');

  // Find the last single-❯ prompt line (user input starts here)
  let lastPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trimStart();
    // Skip system lines: ❯❯, ››, ──, separator bars, empty
    if (t.startsWith('❯❯') || t.startsWith('››') || t.startsWith('──') ||
        t.startsWith('>>') || /^[─━═▬_\-]{3,}/.test(t) || t === '') continue;
    // Match single ❯ or › prompt
    if (/^[❯›]\s/.test(t) || t === '❯' || t === '›') {
      lastPromptIdx = i;
      break;
    }
  }
  if (lastPromptIdx === -1) return '';

  // Collect user input lines, stopping at system lines
  const inputLines = [];
  for (let i = lastPromptIdx; i < lines.length; i++) {
    let line = lines[i];
    const t = line.trimStart();

    // Strip prompt char from first line
    if (i === lastPromptIdx) {
      line = line.replace(/^\s*[❯›]\s?/, '');
    }

    // Stop at system/UI lines
    if (i > lastPromptIdx) {
      if (t.startsWith('❯❯') || t.startsWith('››') || t.startsWith('>>')) break;
      if (/^[─━═▬_\-]{3,}/.test(t)) break; // separator bars
      if (/^\s*accept edits/i.test(t)) break;
      if (/^\s*\*\s*(Cogitated|Sautéed|Baked|Cooked|Worked|Braised)/i.test(t)) break; // timing lines
    }
    inputLines.push(line);
  }

  // Trim trailing empty lines
  while (inputLines.length > 0 && inputLines[inputLines.length - 1].trim() === '') {
    inputLines.pop();
  }

  return inputLines.join('\n').trim();
}

async function readAllViaClipboard(appName) {
  const saved = clipboard.readText();
  clipboard.writeText('__TERSE_SENTINEL__');

  // Single osascript call: Cmd+A → Cmd+C → Right arrow (deselect) — much faster
  await sendKeysBatch([
    'keystroke "a" using command down',
    'keystroke "c" using command down',
    'key code 124', // right arrow to deselect
  ], [0.08, 0.15, 0]);

  await new Promise(r => setTimeout(r, 100));
  const captured = clipboard.readText();

  // Restore clipboard
  setTimeout(() => {
    if (saved !== '__TERSE_SENTINEL__') clipboard.writeText(saved);
  }, 200);

  if (captured === '__TERSE_SENTINEL__') return { text: '', method: 'clipboard-empty', ok: false };

  // Extract just the last user input (not the full conversation history)
  const userInput = parseLastInput(captured);
  if (userInput.length >= 3) {
    return { text: userInput, method: 'clipboard-input', ok: true };
  }
  return { text: '', method: 'clipboard-no-input', ok: false };
}

/**
 * Write text to the focused input via Cmd+A → type replacement text.
 * Works for webview inputs where AX can't set the value directly.
 */
async function writeViaClipboard(appName, newText, opts = {}) {
  const saved = clipboard.readText();
  clipboard.writeText(newText);

  // Skip activation if caller knows app is already focused (e.g. key-monitor auto-replace)
  if (!opts.skipActivate) {
    await activateApp(appName);
  }

  // Clear the input and paste. Ctrl+E (end) → Ctrl+U (kill line) repeated for multi-line.
  // Minimal delays for speed — user is typing, we want this near-instant.
  await sendKeysBatch([
    'keystroke "e" using control down',  // move to end of line
    'keystroke "u" using control down',  // kill line 1
    'key code 51',                        // backspace (join prev line)
    'keystroke "u" using control down',  // kill line 2
    'key code 51',
    'keystroke "u" using control down',  // kill line 3
    'key code 51',
    'keystroke "u" using control down',  // kill line 4
    'keystroke "v" using command down',  // paste optimized text
  ], [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0]);

  await new Promise(r => setTimeout(r, 50));

  // Restore clipboard
  setTimeout(() => clipboard.writeText(saved), 300);
  return { ok: true, method: 'clipboard-paste' };
}

/**
 * Write text via AX (direct AXValue set) — no clipboard needed.
 * Falls back to Cmd+A + Cmd+V via the Swift helper.
 */
function writeAX(pid, text) {
  return new Promise((resolve) => {
    const child = execFile(AX_BIN, ['write-pid', String(pid)], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve({ ok: false, method: 'ax-error' }); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve({ ok: false, method: 'ax-error' }); }
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Replace text in target app.
 * Tries AX write first (direct set), falls back to select-all + paste.
 */
async function writeToApp(appName, newText, pid) {
  const saved = clipboard.readText();

  // Try AX direct write first (handles Cmd+A + Cmd+V internally)
  if (pid) {
    await activateApp(appName);
    await new Promise(r => setTimeout(r, 100));
    const axResult = await writeAX(pid, newText);
    if (axResult.ok) {
      setTimeout(() => clipboard.writeText(saved), 500);
      return axResult;
    }
  }

  // Fallback: activate, select all, paste
  await activateApp(appName);
  await new Promise(r => setTimeout(r, 100));
  clipboard.writeText(newText);
  await sendKeys('keystroke "a" using command down');
  await new Promise(r => setTimeout(r, 80));
  await sendKeys('keystroke "v" using command down');
  await new Promise(r => setTimeout(r, 150));

  setTimeout(() => clipboard.writeText(saved), 500);
  return { ok: true, method: 'paste' };
}

/**
 * Spell-check text: hardcoded common typos first, then macOS NSSpellChecker.
 * Hardcoded dict is fast and accurate for known coding/prompt typos.
 * macOS NSSpellChecker handles the rest (all languages).
 */
function spellCheck(text, typoDict) {
  // Step 1: Apply hardcoded typo dictionary (fast, accurate)
  let fixed = text;
  if (typoDict) {
    fixed = fixed.replace(/\b[a-zA-Z]+\b/g, (word) => {
      const lower = word.toLowerCase();
      const fix = typoDict[lower];
      if (!fix) return word;
      if (word[0] === word[0].toUpperCase() && word.length > 1) {
        return fix[0].toUpperCase() + fix.slice(1);
      }
      return fix;
    });
  }

  // Step 2: macOS NSSpellChecker (all languages)
  return new Promise((resolve) => {
    const child = execFile(AX_BIN, ['spellcheck'], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(fixed); return; }
      try {
        const r = JSON.parse(stdout.trim());
        resolve(r.ok ? r.corrected.trim() : fixed);
      } catch {
        resolve(fixed);
      }
    });
    child.stdin.write(fixed);
    child.stdin.end();
  });
}

/** Fast check: is the focused element in the app a text input? */
function checkFocusIsTextInput(pid) {
  return new Promise((resolve) => {
    execFile(AX_BIN, ['focus-check', String(pid)], { timeout: 1500 }, (err, stdout) => {
      if (err) { resolve({ isTextInput: false }); return; }
      try {
        const r = JSON.parse(stdout.trim());
        resolve({ isTextInput: !!r.isTextInput, role: r.role || '' });
      } catch {
        resolve({ isTextInput: false });
      }
    });
  });
}

// ── Key Monitor (CGEventTap) ──
// Runs terse-ax key-monitor as a long-lived process.
// Tracks keystrokes going to the target app — zero flash, zero clipboard.
const keyMonitors = new Map(); // pid → { process, buffer, lastUpdate }

function startKeyMonitor(pid) {
  if (keyMonitors.has(pid)) return keyMonitors.get(pid);

  const monitor = { process: null, buffer: '', lastUpdate: 0, ready: false, writeCallbacks: [], enterCallbacks: [], onEnter: null };
  keyMonitors.set(pid, monitor);

  const child = execFile(AX_BIN, ['key-monitor', String(pid)], { timeout: 0 });
  monitor.process = child;

  let partial = '';
  child.stdout.on('data', (data) => {
    partial += data.toString();
    const lines = partial.split('\n');
    partial = lines.pop() || ''; // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.ok && msg.monitoring) {
          monitor.ready = true;
        } else if (msg.wrote !== undefined) {
          const cb = monitor.writeCallbacks.shift();
          if (cb) cb(msg);
        } else if (msg.enter) {
          // Send mode: Enter intercepted, JS should optimize + send
          if (monitor.onEnter) monitor.onEnter(msg.text);
        } else if (msg.enterSent !== undefined) {
          const cb = monitor.enterCallbacks.shift();
          if (cb) cb();
        } else if (msg.text !== undefined) {
          monitor.buffer = msg.text;
          monitor.lastUpdate = Date.now();
        }
      } catch {}
    }
  });

  child.on('exit', () => {
    keyMonitors.delete(pid);
  });

  child.on('error', () => {
    keyMonitors.delete(pid);
  });

  return monitor;
}

function stopKeyMonitor(pid) {
  const monitor = keyMonitors.get(pid);
  if (monitor && monitor.process) {
    monitor.process.kill();
    keyMonitors.delete(pid);
  }
}

function getKeyMonitorBuffer(pid) {
  const monitor = keyMonitors.get(pid);
  if (!monitor || !monitor.ready) return null;
  return { text: monitor.buffer, lastUpdate: monitor.lastUpdate };
}

/** Reset the key monitor buffer (call after auto-replace so it matches the new text) */
function resetKeyMonitorBuffer(pid, newText) {
  const monitor = keyMonitors.get(pid);
  if (monitor) {
    monitor.buffer = newText || '';
    monitor.lastUpdate = Date.now();
  }
}

/**
 * Write text via the key monitor process — atomic replace with keystroke suppression.
 * Sends a write command to the running key-monitor which:
 *  1. Suppresses user keystrokes (active CGEventTap)
 *  2. Clears input via Ctrl+E + Ctrl+U + Backspace (tagged CGEvents, no osascript)
 *  3. Pastes new text via Cmd+V
 *  4. Replays any chars the user typed during the write
 * Returns { ok, pending, method }.
 */
function writeViaKeyMonitor(pid, text) {
  return new Promise((resolve) => {
    const monitor = keyMonitors.get(pid);
    if (!monitor || !monitor.process || !monitor.ready) {
      resolve({ ok: false, error: 'no_monitor' });
      return;
    }

    // Save clipboard before Swift overwrites it
    const saved = clipboard.readText();

    let resolved = false;
    const cb = (msg) => {
      if (resolved) return;
      resolved = true;
      // Update local buffer to match what Swift set
      monitor.buffer = text + (msg.pending || '');
      monitor.lastUpdate = Date.now();
      // Restore clipboard after terminal has finished reading it
      setTimeout(() => clipboard.writeText(saved), 500);
      resolve({ ok: true, pending: msg.pending || '', method: 'keymonitor-write' });
    };

    monitor.writeCallbacks.push(cb);
    monitor.process.stdin.write(JSON.stringify({ cmd: 'write', text }) + '\n');

    // Timeout after 3s
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const idx = monitor.writeCallbacks.indexOf(cb);
      if (idx >= 0) monitor.writeCallbacks.splice(idx, 1);
      setTimeout(() => clipboard.writeText(saved), 500);
      resolve({ ok: false, error: 'timeout' });
    }, 3000);
  });
}

/**
 * Enable/disable "Send" mode on the key monitor.
 * In send mode, Enter is intercepted — JS optimizes text before submitting.
 * @param {Function|null} onEnterCallback — called with (bufferText) when Enter is pressed
 */
function setKeyMonitorSendMode(pid, on, onEnterCallback) {
  const monitor = keyMonitors.get(pid);
  if (!monitor || !monitor.process) return;
  monitor.onEnter = on ? onEnterCallback : null;
  monitor.process.stdin.write(JSON.stringify({ cmd: 'set-send-mode', on: !!on }) + '\n');
}

/** Send an Enter keypress via the key monitor (tagged CGEvent, passes through tap) */
function sendEnterViaKeyMonitor(pid) {
  return new Promise((resolve) => {
    const monitor = keyMonitors.get(pid);
    if (!monitor || !monitor.process) { resolve(); return; }
    let done = false;
    monitor.enterCallbacks.push(() => { if (!done) { done = true; resolve(); } });
    monitor.process.stdin.write(JSON.stringify({ cmd: 'enter' }) + '\n');
    setTimeout(() => { if (!done) { done = true; resolve(); } }, 1000);
  });
}

// ── VS Code Bridge (HTTP) ──
const BRIDGE_PORT = 47821;
let bridgeAlive = false;
let bridgeCheckTime = 0;

/** Check if the Terse VS Code bridge extension is running */
function pingBridge() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${BRIDGE_PORT}/ping`, { timeout: 500 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve(r.ok && r.bridge === 'terse');
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Read text from VS Code via the bridge extension */
function readBridge() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${BRIDGE_PORT}/text`, { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.ok && r.focused && r.text) {
            resolve({ text: r.text, method: 'bridge', ok: true, focused: true });
          } else {
            resolve({ text: '', method: 'bridge-empty', ok: false, focused: !!r.focused });
          }
        } catch { resolve({ text: '', method: 'bridge-error', ok: false, focused: false }); }
      });
    });
    req.on('error', () => resolve({ text: '', method: 'bridge-error', ok: false, focused: false }));
    req.on('timeout', () => { req.destroy(); resolve({ text: '', method: 'bridge-timeout', ok: false, focused: false }); });
  });
}

/** Write text to VS Code via the bridge extension */
function writeBridge(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const req = http.request(`http://127.0.0.1:${BRIDGE_PORT}/replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

/** Trigger VS Code window reload via the bridge */
function reloadBridge() {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${BRIDGE_PORT}/reload`, {
      method: 'POST',
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/** Check bridge availability (cached for 5 seconds) */
async function isBridgeAlive() {
  const now = Date.now();
  if (now - bridgeCheckTime < 5000) return bridgeAlive;
  bridgeAlive = await pingBridge();
  bridgeCheckTime = now;
  return bridgeAlive;
}

/**
 * Enable AX tree on Electron apps (VS Code, Cursor) by setting AXManualAccessibility.
 * This forces the app to expose its full DOM accessibility tree to third-party tools,
 * making webview content (Claude Code input, etc.) readable via AX APIs.
 */
function enableAXForApp(pid) {
  return new Promise((resolve) => {
    execFile(AX_BIN, ['enable-ax', String(pid)], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: 'exec_error' }); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve({ ok: false, error: 'parse_error' }); }
    });
  });
}

module.exports = { getFrontApp, activateApp, readAXAt, readAXApp, readSelection, readAllViaClipboard, writeViaClipboard, writeToApp, spellCheck, startKeyMonitor, stopKeyMonitor, getKeyMonitorBuffer, resetKeyMonitorBuffer, writeViaKeyMonitor, setKeyMonitorSendMode, sendEnterViaKeyMonitor, readBridge, writeBridge, reloadBridge, isBridgeAlive, enableAXForApp, checkFocusIsTextInput };
