const { app, BrowserWindow, ipcMain, globalShortcut, Tray, nativeImage, screen, clipboard, systemPreferences } = require('electron');
const path = require('path');
const { execSync } = require('child_process');

// ── Kill stale Terse processes before acquiring single-instance lock ──
// Only targets Terse-specific Electron processes (NOT VS Code, Cursor, etc.)
function killStaleTerseProcesses() {
  try {
    // Find Electron processes whose full command path contains Terse
    const psOutput = execSync('ps -axo pid,command', { encoding: 'utf-8', timeout: 5000 });
    const lines = psOutput.split('\n');
    const myPid = process.pid;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Extract PID (first token)
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx < 0) continue;
      const pid = parseInt(trimmed.substring(0, spaceIdx), 10);
      if (isNaN(pid) || pid === myPid) continue;

      const cmd = trimmed.substring(spaceIdx + 1);

      // Skip anything that looks like VS Code / Cursor / other Electron apps
      if (cmd.includes('Visual Studio Code.app') || cmd.includes('Code.app') ||
          cmd.includes('Cursor.app') || cmd.includes('code-insiders')) continue;

      // Kill stale Terse Electron processes (path contains Terse/node_modules/electron)
      if (cmd.includes('Terse/node_modules/electron') || cmd.includes('Terse/node_modules/.bin/electron')) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`[Terse] Killed stale Electron process ${pid}`);
        } catch { /* already dead */ }
      }

      // Kill orphaned terse-ax helper processes
      if (cmd.includes('terse-ax') && !cmd.includes('Visual Studio Code')) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`[Terse] Killed orphaned terse-ax process ${pid}`);
        } catch { /* already dead */ }
      }
    }
  } catch (e) {
    console.warn('[Terse] Stale process cleanup failed:', e.message);
  }
}

killStaleTerseProcesses();

// Single instance lock — prevent multiple Terse processes eating memory
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

const { PromptOptimizer } = require('./optimizer');
const { getFrontApp, readAXApp, readSelection, readAllViaClipboard, writeViaClipboard, writeToApp, startKeyMonitor, stopKeyMonitor, getKeyMonitorBuffer, resetKeyMonitorBuffer, writeViaKeyMonitor, setKeyMonitorSendMode, sendEnterViaKeyMonitor, readBridge, writeBridge, reloadBridge, isBridgeAlive, enableAXForApp, checkFocusIsTextInput } = require('./capture');
const { AgentMonitor } = require('./agent-monitor');

// ── Agent-app matching ──
// Check if `appPid` is an ancestor of any connected agent process.
// Walks up the process tree from each agent PID to see if it's hosted inside the app.
function isAgentApp(appPid) {
  if (!appPid || agentMonitor.sessions.size === 0) return false;
  for (const [, agSess] of agentMonitor.sessions) {
    const agentPid = agSess.agentInfo && agSess.agentInfo.pid;
    if (!agentPid) continue;
    // Walk up parent PID chain from agent process (max 20 levels to avoid infinite loops)
    let pid = agentPid;
    for (let i = 0; i < 20 && pid > 1; i++) {
      if (pid === appPid) return true;
      try {
        const ppid = parseInt(execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 1000 }).trim(), 10);
        if (isNaN(ppid) || ppid === pid) break;
        pid = ppid;
      } catch { break; }
    }
  }
  return false;
}

// Cache for isAgentApp lookups (cleared when agent sessions change)
let _agentAppCache = new Map(); // appPid → { result, ts }
function isAgentAppCached(appPid) {
  const now = Date.now();
  const cached = _agentAppCache.get(appPid);
  if (cached && now - cached.ts < 5000) return cached.result; // cache for 5s
  const result = isAgentApp(appPid);
  _agentAppCache.set(appPid, { result, ts: now });
  return result;
}

let mainWindow = null;
let popupWindow = null;
let tray = null;
const optimizer = new PromptOptimizer();
const agentMonitor = new AgentMonitor();

// ── Multi-session state ──
const sessions = new Map(); // id → { id, name, pid, bundleId, title, clickPos, lastText }
let nextSessionId = 1;
let isPicking = false;
let activeSessionId = null;   // which session the popup is showing
let focusTimer = null;   // fast: detect app switches (150ms)
let textTimer = null;    // slower: read text + optimize (500ms)
let lastPopupText = '';
let autoMode = 'off';    // 'off' | 'send' | 'auto' — off=manual, send=optimize on Enter, auto=live replace
let popupMinimized = false;  // true when user manually minimized popup to favicon
let lastFrontBundleId = '';  // track frontmost app for fast switching
let candidateSessionId = null;  // session for the frontmost app (popup shown only if text input focused)
let popupVisibleForTextInput = false;  // true when popup is shown because a text input is focused
let lastTextChangeTime = 0;  // timestamp of last text change (for typing detection)
let settleTimer = null;      // timer for "user stopped typing" → auto-replace
let isAutoReplacing = false; // guard to skip re-reading our own writes
let autoReplaced = false;    // true after a successful auto-replace — reset when user types new text
const SETTLE_DELAY = 600;    // ms to wait after last change before auto-replacing
let focusPolling = false;    // concurrency guard — prevent overlapping focus polls
let textPolling = false;     // concurrency guard — prevent overlapping text polls

// Strategies that confirm user is focused on a text input
const FOCUSED_STRATEGIES = new Set(['ax-focused', 'ax-focused-child']);

// ── Windows ──
function createMainWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 340, height: 460,
    x: sw - 360, y: 60,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: true, hasShadow: true,
    vibrancy: 'under-window', visualEffectState: 'active',
    backgroundColor: '#00000000', titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Main window visible by default for session management
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createPopupWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const popW = 480;
  popupWindow = new BrowserWindow({
    width: popW, height: 200,
    x: Math.round((sw - popW) / 2), y: 8,
    frame: false, transparent: true,
    alwaysOnTop: true,
    resizable: false, hasShadow: true, movable: true,
    vibrancy: 'under-window', visualEffectState: 'active',
    backgroundColor: '#00000000',
    skipTaskbar: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  popupWindow.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  popupWindow.hide();
  popupWindow.on('closed', () => { popupWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from([
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
    0x89,0x00,0x00,0x00,0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x62,0x00,0x00,0x00,0x02,
    0x00,0x01,0xE5,0x27,0xDE,0xFC,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82
  ]), { width: 18, height: 18, scaleFactor: 2.0 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Terse');
  tray.on('click', () => mainWindow && (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()));
}

// ── Electron apps that need AXManualAccessibility enabled for AX tree access ──
// Maps bundleId → user-data folder name (for finding settings.json)
const ELECTRON_APP_INFO = {
  'com.microsoft.VSCode':          { settingsDir: 'Code',           label: 'VS Code' },
  'com.microsoft.VSCodeInsiders':  { settingsDir: 'Code - Insiders', label: 'VS Code Insiders' },
  'com.visualstudio.code.oss':     { settingsDir: 'Code - OSS',    label: 'VS Code OSS' },
  'com.todesktop.230313mzl4w4u92': { settingsDir: 'Cursor',        label: 'Cursor' },
};
function isAXBlind(bundleId) {
  return bundleId in ELECTRON_APP_INFO;
}

/**
 * Auto-configure a VS Code / Cursor instance for AX access:
 *  1. Set editor.accessibilitySupport: "on" in settings.json
 *  2. Set AXManualAccessibility on the process
 */
async function autoSetupElectronAX(bundleId, pid) {
  const fs = require('fs');
  const os = require('os');
  const info = ELECTRON_APP_INFO[bundleId];
  if (!info) return { axOk: false, settingsOk: false };

  // Step 1: Find and update settings.json
  // macOS: ~/Library/Application Support/<settingsDir>/User/settings.json
  const candidatePaths = [
    path.join(os.homedir(), 'Library', 'Application Support', info.settingsDir, 'User', 'settings.json'),
  ];
  if (info.settingsDir === 'Cursor') {
    candidatePaths.push(path.join(os.homedir(), '.cursor', 'User', 'settings.json'));
  }

  let settingsOk = false;
  let settingsPath = '';
  let needsReload = false;
  for (const sp of candidatePaths) {
    try {
      if (!fs.existsSync(sp)) {
        // Create if dir exists but file doesn't
        const dir = path.dirname(sp);
        if (!fs.existsSync(dir)) continue; // skip — wrong candidate
        fs.writeFileSync(sp, JSON.stringify({ 'editor.accessibilitySupport': 'on' }, null, 2));
        settingsOk = true; settingsPath = sp; needsReload = true;
        break;
      }
      const raw = fs.readFileSync(sp, 'utf-8');
      let settings;
      try { settings = JSON.parse(raw); } catch {
        // VS Code settings may have comments — strip them
        const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        settings = JSON.parse(stripped);
      }
      if (settings['editor.accessibilitySupport'] === 'on') {
        settingsOk = true; settingsPath = sp;
        break; // Already set
      }
      settings['editor.accessibilitySupport'] = 'on';
      fs.writeFileSync(sp, JSON.stringify(settings, null, 2));
      settingsOk = true; settingsPath = sp; needsReload = true;
      break;
    } catch (e) {
      console.log(`[Terse] Could not update ${sp}:`, e.message);
    }
  }

  // Step 2: Set AXManualAccessibility on the process
  const axResult = await enableAXForApp(pid);

  return { axOk: !!axResult.ok, settingsOk, settingsPath, needsReload, label: info.label };
}

// ── Helpers ──
function sendMain(ch, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
}
function sendPopup(ch, data) {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.webContents.send(ch, data);
}

// ── Session management ──
function addSession(appInfo, clickPos) {
  const id = nextSessionId++;
  sessions.set(id, {
    id,
    name: appInfo.name,
    pid: appInfo.pid,
    bundleId: appInfo.bundleId,
    title: appInfo.title,
    clickPos,
    lastText: '',
    axEnabled: false,
  });

  // For Electron apps (VS Code, Cursor): auto-configure accessibility
  if (isAXBlind(appInfo.bundleId)) {
    autoSetupElectronAX(appInfo.bundleId, appInfo.pid).then(async (r) => {
      const sess = sessions.get(id);
      if (sess) sess.axEnabled = !!r.axOk;
      console.log(`[Terse] Auto-setup ${r.label}: AX=${r.axOk}, settings=${r.settingsOk}, reload=${r.needsReload}`);
      if (r.needsReload) {
        // Settings were just written — try to auto-reload via bridge
        const bridgeUp = await isBridgeAlive();
        if (bridgeUp) {
          sendMain('toast', { msg: `${r.label}: enabling live detection, reloading...`, duration: 4000 });
          await reloadBridge();
          // After reload, bridge will restart — re-enable AX on the new process
          setTimeout(async () => {
            // VS Code gets a new PID after reload — find it
            const freshApp = await getFrontApp();
            if (freshApp && freshApp.bundleId === appInfo.bundleId && freshApp.pid !== appInfo.pid) {
              if (sess) { sess.pid = freshApp.pid; }
              await enableAXForApp(freshApp.pid);
              if (sess) sess.axEnabled = true;
            } else if (sess) {
              // Same PID — just re-enable
              const axr = await enableAXForApp(sess.pid);
              sess.axEnabled = !!axr.ok;
            }
            console.log(`[Terse] Post-reload AX re-enabled for ${r.label}`);
          }, 4000);
        } else {
          sendMain('toast', { msg: `${r.label}: accessibility enabled. Please reload ${r.label} window (Cmd+Shift+P → "Reload Window") for live detection.`, duration: 8000 });
        }
      } else if (r.axOk) {
        sendMain('toast', { msg: `${r.label}: live detection ready.` });
      }
    });
  }

  sendMain('sessions-updated');
  sendMain('session-added', { id });
  return id;
}

function removeSession(id) {
  const session = sessions.get(id);
  if (session && session.keyMonitorStarted) stopKeyMonitor(session.pid);
  sessions.delete(id);
  if (activeSessionId === id) {
    activeSessionId = null;
    candidateSessionId = null;
    hidePopup();
  }
  sendMain('sessions-updated');
}

function getSessionsList() {
  return [...sessions.values()].map(s => ({
    id: s.id,
    name: s.name,
    pid: s.pid,
    bundleId: s.bundleId,
    title: s.title,
    active: s.id === activeSessionId,
  }));
}

// Find session matching a frontmost app
function findSessionForApp(appInfo) {
  for (const s of sessions.values()) {
    if (s.pid === appInfo.pid) return s;
    if (s.bundleId && s.bundleId === appInfo.bundleId) {
      s.pid = appInfo.pid;
      return s;
    }
    if (s.name === appInfo.name) {
      s.pid = appInfo.pid;
      return s;
    }
  }
  return null;
}

// ── Pick Mode ──
function enterPickMode() {
  if (isPicking) return;
  isPicking = true;
  sendMain('pick-mode', true);

  const onBlur = async () => {
    if (!isPicking) return;
    mainWindow.removeListener('blur', onBlur);
    await new Promise(r => setTimeout(r, 500));

    const appInfo = await getFrontApp();
    isPicking = false;
    sendMain('pick-mode', false);

    if (appInfo.name && appInfo.name !== '?') {
      const cursor = screen.getCursorScreenPoint();
      const clickPos = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
      addSession(appInfo, clickPos);
    } else {
      sendMain('toast', { msg: 'Could not detect app', error: true });
    }
  };

  if (mainWindow) mainWindow.on('blur', onBlur);
  setTimeout(() => {
    if (isPicking) {
      isPicking = false;
      if (mainWindow) mainWindow.removeListener('blur', onBlur);
      sendMain('pick-mode', false);
      sendMain('toast', { msg: 'Timed out', error: true });
    }
  }, 20000);
}

// ── Popup show/hide ──
function showPopup(session) {
  if (!popupWindow) return;
  activeSessionId = session.id;
  if (!popupWindow.isVisible()) {
    popupWindow.showInactive();
  }
  // Check if this session's app is hosting a connected agent process
  const hasAgent = isAgentAppCached(session.pid);
  sendPopup('popup-show', { app: session.title || session.name, sessionId: session.id, hasAgent });
  sendMain('sessions-updated');
}

function hidePopup() {
  if (!popupWindow) return;
  // When minimized to favicon, keep the window visible (just the icon)
  if (popupMinimized) {
    activeSessionId = null;
    lastPopupText = '';
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    sendMain('sessions-updated');
    return;
  }
  if (popupWindow.isVisible()) {
    popupWindow.hide();
    sendPopup('popup-hide');
  }
  activeSessionId = null;
  lastPopupText = '';
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  sendMain('sessions-updated');
}

// ── Focus poller (300ms) — detect app switches ──
function startFocusPoller() {
  if (focusTimer) return;
  focusTimer = setInterval(async () => {
    if (sessions.size === 0 || isPicking) return;
    if (focusPolling) return; // previous poll still running — skip
    focusPolling = true;

    let appInfo;
    try {
      appInfo = await getFrontApp();
    } finally {
      focusPolling = false;
    }
    if (!appInfo.name || appInfo.name === '?') return;

    // Same app as last check — skip
    const sig = appInfo.bundleId || appInfo.name;
    if (sig === lastFrontBundleId) return;
    lastFrontBundleId = sig;

    // Is frontmost app Terse itself? Keep popup as-is
    if (appInfo.bundleId === 'com.github.Electron' || appInfo.bundleId === 'com.github.electron' ||
        appInfo.bundleId === 'com.terse.app' || appInfo.name === 'Electron' || appInfo.name === 'Terse') return;

    // Find matching session
    const session = findSessionForApp(appInfo);

    if (!session) {
      // Not a connected app — hide popup but keep state recoverable
      candidateSessionId = null;
      popupVisibleForTextInput = false;
      if (activeSessionId) {
        // When minimized to favicon, keep it visible regardless of app focus
        if (!popupMinimized && popupWindow && popupWindow.isVisible()) {
          popupWindow.hide();
          sendPopup('popup-hide');
        }
        activeSessionId = null;
        lastPopupText = '';
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        sendMain('sessions-updated');
      }
      return;
    }

    // Switching to a different session — transition popup
    if (candidateSessionId !== session.id) {
      // Hide old popup without nullifying activeSessionId
      if (!popupMinimized && popupWindow && popupWindow.isVisible()) {
        popupWindow.hide();
        sendPopup('popup-hide');
        sendPopup('popup-clear');
      }
      candidateSessionId = session.id;
      activeSessionId = session.id;
      lastPopupText = '';
      popupVisibleForTextInput = false;
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      // Show popup immediately for the new session
      popupVisibleForTextInput = true;
      showPopup(session);
    }
  }, 300);
}

// ── TEXT poller (600ms) — read text + optimize (nspell runs in-process, no subprocess) ──
let lastClipboardRead = 0;
const CLIPBOARD_READ_INTERVAL = 5000; // Clipboard capture every 5s (Cmd+A causes brief flash)
function startTextPoller() {
  if (textTimer) return;
  textTimer = setInterval(async () => {
    if (!activeSessionId || isPicking) return;
    if (isAutoReplacing) return; // don't read while we're writing
    if (textPolling) return; // previous poll still running — skip
    textPolling = true;
    const session = sessions.get(activeSessionId);
    if (!session) { textPolling = false; return; }

    try {

    let result = { text: '', method: 'none' };
    let userInTextInput = false;

    if (isAXBlind(session.bundleId)) {
      // ── VS Code / Cursor: bridge (editor) or key monitor (terminal/webview) ──

      const bridgeUp = await isBridgeAlive();
      let inEditor = false;
      if (bridgeUp) {
        const br = await readBridge();
        if (br.focused && br.ok && br.text && br.text.trim().length >= 5) {
          result = br;
          userInTextInput = true;
          session.readMethod = 'bridge';
          inEditor = true;
        }
      }

      // Not in text editor → use key monitor (zero flash, tracks keystrokes via CGEventTap)
      if (!inEditor) {
        session.readMethod = 'keymonitor';
        // Start key monitor if not already running
        if (!session.keyMonitorStarted) {
          startKeyMonitor(session.pid);
          session.keyMonitorStarted = true;
          // If send mode is active, enable it on this new key monitor
          if (autoMode === 'send') {
            setKeyMonitorSendMode(session.pid, true, (text) => handleSendModeEnter(text, session));
          }
        }
        const km = getKeyMonitorBuffer(session.pid);
        if (km && km.text && km.text.trim().length >= 3) {
          result = { text: km.text, method: 'keymonitor', ok: true };
          userInTextInput = true;
        } else if (session.lastText) {
          result = { text: session.lastText, method: 'keymonitor-cached', ok: true };
          userInTextInput = true;
        }
      }

      if (!userInTextInput) {
        if (!popupVisibleForTextInput) {
          popupVisibleForTextInput = true;
          showPopup(session);
        }
        sendPopup('popup-hint', { app: session.title || session.name, keyMonitor: true });
        return;
      }
    } else {
      // ── Browser / other apps: use AX focused element ──
      // readAXApp checks focused element first (strategy "focused" / "focused-child")
      // If user is NOT in a text input, it falls through to window-walk
      result = await readAXApp(session.pid, session.clickPos?.x, session.clickPos?.y);

      // Only show popup if text was found via focused element (user is in a text input)
      userInTextInput = FOCUSED_STRATEGIES.has(result.method);
    }

    // ── Ensure popup is visible while in a connected app ──
    if (!popupVisibleForTextInput) {
      popupVisibleForTextInput = true;
      showPopup(session);
    }

    // No text input focused — keep popup visible but skip text processing
    if (!userInTextInput) return;

    // ── Process text ──
    const raw = (result.text || '');
    const trimmed = raw.trim();

    // Detect cleared/empty input — clear popup
    if (trimmed.length < 2 && lastPopupText.length > 2) {
      lastPopupText = '';
      sendPopup('popup-clear');
      return;
    }
    if (trimmed.length < 5) return;

    if (trimmed !== lastPopupText) {
      const prevText = lastPopupText;
      lastPopupText = trimmed;
      session.lastText = trimmed;
      lastTextChangeTime = Date.now();
      autoReplaced = false; // User typed new text — allow auto-replace again

      // Detect if user is deleting — don't auto-replace
      const isDeleting = trimmed.length < prevText.length;

      // Split: preserve the word currently being typed
      let textToOptimize = trimmed;
      let currentWord = '';
      const endsWithSpace = raw.endsWith(' ') || raw.endsWith('\n');

      if (!endsWithSpace && !isDeleting) {
        const lastSpaceIdx = trimmed.lastIndexOf(' ');
        if (lastSpaceIdx > 0) {
          textToOptimize = trimmed.substring(0, lastSpaceIdx);
          currentWord = trimmed.substring(lastSpaceIdx);
        } else {
          // First word — just preview, don't optimize
          sendPopup('popup-update', {
            app: session.title || session.name,
            original: trimmed, optimized: trimmed,
            stats: { originalTokens: optimizer.estimateTokens(trimmed), optimizedTokens: optimizer.estimateTokens(trimmed), percentSaved: 0, techniquesApplied: [] },
            suggestions: [], method: result.method, sessionId: session.id,
          });
          return;
        }
      }

      // Optimize (typo correction via TYPOS dict + nspell runs in-process — no subprocess)
      const opt = optimizer.optimize(textToOptimize);

      const displayOptimized = currentWord ? opt.optimized + currentWord : opt.optimized;

      // Always show preview immediately
      sendPopup('popup-update', {
        app: session.title || session.name,
        original: trimmed, optimized: displayOptimized,
        stats: opt.stats, suggestions: opt.suggestions,
        method: result.method, sessionId: session.id,
      });

      // ── Auto-replace: wait until user STOPS typing (only in 'auto' mode) ──
      if (autoMode === 'auto' && !isDeleting && !autoReplaced && opt.optimized !== textToOptimize) {
        // Cancel any pending auto-replace
        if (settleTimer) clearTimeout(settleTimer);

        const capturedSessionId = session.id;
        const capturedBundleId = session.bundleId;
        const capturedName = session.name;
        const capturedPid = session.pid;
        const capturedClickPos = session.clickPos;
        const capturedReadMethod = session.readMethod || 'ax';

        settleTimer = setTimeout(async () => {
          settleTimer = null;
          if (Date.now() - lastTextChangeTime < SETTLE_DELAY - 100) return;
          if (activeSessionId !== capturedSessionId) return;
          if (autoMode !== 'auto') return;

          // Re-read fresh text
          let freshText = '';
          if (capturedReadMethod === 'keymonitor') {
            const km = getKeyMonitorBuffer(capturedPid);
            freshText = (km?.text || '').trim();
          } else if (capturedReadMethod === 'clipboard') {
            const r = await readAllViaClipboard(capturedName);
            freshText = (r.text || '').trim();
          } else if (capturedReadMethod === 'bridge') {
            const r = await readBridge();
            freshText = (r.text || '').trim();
            if (freshText.length < 5 || freshText !== lastPopupText) return;
          } else {
            const r = await readAXApp(capturedPid, capturedClickPos?.x, capturedClickPos?.y);
            freshText = (r.text || '').trim();
            if (freshText.length < 5 || freshText !== lastPopupText) return;
          }
          if (freshText.length < 5) return;

          // Split: only optimize completed words (before last space).
          // Preserve the current word being typed (after last space).
          let prefixToOptimize = freshText;
          let currentWord = '';
          const rawEndsWithSpace = freshText.endsWith(' ') || freshText.endsWith('\n');
          if (!rawEndsWithSpace) {
            const lastSp = freshText.lastIndexOf(' ');
            if (lastSp > 0) {
              prefixToOptimize = freshText.substring(0, lastSp);
              currentWord = freshText.substring(lastSp); // includes the leading space
            } else {
              // Only one word — nothing completed yet, skip
              return;
            }
          }

          const freshOpt = optimizer.optimize(prefixToOptimize);
          if (freshOpt.optimized === prefixToOptimize) return; // nothing to change

          const fullReplacement = freshOpt.optimized + currentWord;

          // Update popup
          sendPopup('popup-update', {
            app: capturedName,
            original: freshText, optimized: fullReplacement,
            stats: freshOpt.stats, suggestions: freshOpt.suggestions,
            method: capturedReadMethod, sessionId: capturedSessionId,
          });

          // Write using matching method
          isAutoReplacing = true;
          try {
            if (capturedReadMethod === 'keymonitor') {
              // Atomic write via key monitor: suppresses user keystrokes,
              // clears + pastes via CGEvents, replays any chars typed during write
              const result = await writeViaKeyMonitor(capturedPid, fullReplacement);
              // Buffer already updated by Swift side (includes pending chars)
              lastPopupText = (fullReplacement + (result.pending || '')).trim();
            } else if (capturedReadMethod === 'clipboard') {
              await writeViaClipboard(capturedName, fullReplacement);
              lastPopupText = fullReplacement.trim();
            } else if (capturedReadMethod === 'bridge') {
              await writeBridge(fullReplacement);
              lastPopupText = fullReplacement.trim();
            } else {
              await writeToApp(capturedName, fullReplacement, capturedPid);
              lastPopupText = fullReplacement.trim();
            }
            autoReplaced = true;
            const sessAfter = sessions.get(capturedSessionId);
            if (sessAfter) sessAfter.lastText = lastPopupText;

            sendPopup('popup-update', {
              app: session.title || session.name,
              original: freshText, optimized: lastPopupText,
              stats: freshOpt.stats, suggestions: freshOpt.suggestions,
              method: 'auto-replace', sessionId: capturedSessionId,
            });
          } finally {
            setTimeout(() => { isAutoReplacing = false; }, 1500);
          }
        }, SETTLE_DELAY);
      }
    }

    } finally { textPolling = false; }
  }, 600);
}

function startPolling() {
  startFocusPoller();
  startTextPoller();
}

function stopPolling() {
  if (focusTimer) { clearInterval(focusTimer); focusTimer = null; }
  if (textTimer) { clearInterval(textTimer); textTimer = null; }
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

// ── Manual capture (selection-based) for popup ──
async function captureFromActiveSession() {
  // Also works when popup is hidden — use candidate session
  const sid = activeSessionId || candidateSessionId;
  const session = sid ? sessions.get(sid) : null;
  if (!session) return;

  // Ensure popup is visible for manual capture
  if (!popupVisibleForTextInput) {
    popupVisibleForTextInput = true;
    showPopup(session);
  }

  // For clipboard-mode sessions (VS Code terminal), use full capture
  let result;
  if (session.readMethod === 'keymonitor') {
    const km = getKeyMonitorBuffer(session.pid);
    result = km && km.text ? { text: km.text, method: 'keymonitor', ok: true } : await readAllViaClipboard(session.name);
  } else if (session.readMethod === 'clipboard') {
    result = await readAllViaClipboard(session.name);
  } else {
    result = await readSelection(session.name);
  }

  if (result.text && result.text.trim().length >= 5) {
    const trimmed = result.text.trim();
    lastPopupText = trimmed;
    session.lastText = trimmed;
    const opt = optimizer.optimize(trimmed);
    sendPopup('popup-update', {
      app: session.title || session.name,
      original: trimmed,
      optimized: opt.optimized,
      stats: opt.stats,
      suggestions: opt.suggestions,
      method: result.method,
      sessionId: session.id,
    });
  }
}

// ── Replace ──
async function replaceInTarget(newText) {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session) {
    clipboard.writeText(newText);
    return { ok: true, method: 'clipboard' };
  }
  // Use the method that matches how we read
  if (session.readMethod === 'keymonitor' || session.readMethod === 'clipboard') {
    return await writeViaClipboard(session.name, newText);
  } else if (session.readMethod === 'bridge') {
    const bridgeUp = await isBridgeAlive();
    if (bridgeUp) return await writeBridge(newText);
  }
  return await writeToApp(session.name, newText, session.pid);
}

// ── IPC ──
ipcMain.handle('enter-pick-mode', () => { enterPickMode(); return true; });
ipcMain.handle('get-sessions', () => getSessionsList());
ipcMain.handle('remove-session', (_, id) => { removeSession(id); return true; });
ipcMain.handle('capture-now', () => captureFromActiveSession());
ipcMain.handle('set-auto-mode', (_, mode) => {
  // mode: 'off' | 'send' | 'auto'
  const prev = autoMode;
  autoMode = typeof mode === 'string' ? mode : (mode ? 'auto' : 'off');

  // Toggle send mode on all active key monitors
  const sendOn = autoMode === 'send';
  const prevSendOn = prev === 'send';
  if (sendOn !== prevSendOn) {
    for (const session of sessions.values()) {
      if (session.keyMonitorStarted) {
        setKeyMonitorSendMode(session.pid, sendOn, sendOn ? (text) => handleSendModeEnter(text, session) : null);
      }
    }
  }
  return true;
});

/** Handle Enter intercepted in "Send" mode — optimize then submit */
async function handleSendModeEnter(text, session) {
  if (!text || text.trim().length < 3) {
    // Nothing to optimize — just send Enter through
    await sendEnterViaKeyMonitor(session.pid);
    return;
  }

  const trimmed = text.trim();
  const opt = optimizer.optimize(trimmed);

  if (opt.optimized !== trimmed && opt.optimized.length >= 3) {
    // Write optimized text, then send Enter
    isAutoReplacing = true;
    try {
      await writeViaKeyMonitor(session.pid, opt.optimized);
      // Brief pause for paste to settle
      await new Promise(r => setTimeout(r, 50));
      await sendEnterViaKeyMonitor(session.pid);
    } catch {
      // If write fails, still send Enter with original text
      await sendEnterViaKeyMonitor(session.pid);
    } finally {
      resetKeyMonitorBuffer(session.pid, '');
      lastPopupText = '';
      isAutoReplacing = false;
    }

    // Update popup with what happened
    sendPopup('popup-update', {
      app: session.title || session.name,
      original: trimmed, optimized: opt.optimized,
      stats: opt.stats, suggestions: opt.suggestions,
      method: 'send-mode', sessionId: session.id,
    });
  } else {
    // No changes — just send Enter through
    await sendEnterViaKeyMonitor(session.pid);
    resetKeyMonitorBuffer(session.pid, '');
    lastPopupText = '';
  }
}
ipcMain.handle('replace-in-target', (_, text) => replaceInTarget(text));
ipcMain.handle('apply-to-clipboard', (_, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('set-popup-minimized', (_, on) => {
  popupMinimized = !!on;
  if (!popupWindow) return true;
  if (popupMinimized) {
    // Remove vibrancy (causes gray fill), shrink to favicon size
    popupWindow.setVibrancy(null);
    popupWindow.setSize(72, 72);
    popupWindow.setIgnoreMouseEvents(false);
    if (!popupWindow.isVisible()) popupWindow.showInactive();
  } else {
    // Restore vibrancy and full size
    popupWindow.setVibrancy('under-window');
    popupWindow.setSize(480, 200);
    popupWindow.setIgnoreMouseEvents(false);
    const sid = activeSessionId || candidateSessionId;
    const session = sid ? sessions.get(sid) : null;
    if (session) {
      popupVisibleForTextInput = true;
      showPopup(session);
    }
  }
  return true;
});
ipcMain.handle('move-popup-by', (_, dx, dy) => {
  if (!popupWindow) return;
  const [x, y] = popupWindow.getPosition();
  popupWindow.setPosition(x + dx, y + dy);
});
ipcMain.handle('resize-popup', (_, h) => {
  if (!popupWindow || popupMinimized) return;
  const clamped = Math.max(120, Math.min(h, 500));
  const [w] = popupWindow.getSize();
  popupWindow.setSize(w, clamped);
});
ipcMain.handle('optimize-text', (_, text) => optimizer.optimize(text));
ipcMain.handle('get-settings', () => optimizer.getSettings());
ipcMain.handle('update-settings', (_, s) => {
  optimizer.updateSettings(s);
  for (const session of agentMonitor.sessions.values()) {
    session.resetAnalysisCache();
  }
  return true;
});
ipcMain.handle('close-window', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('request-accessibility', () => {
  systemPreferences.isTrustedAccessibilityClient(true);
  return true;
});
// ── Agent Monitor IPC ──
ipcMain.handle('get-agent-detections', () => agentMonitor.getPendingDetections());
ipcMain.handle('get-agent-sessions', () => agentMonitor.getConnectedSessions());
ipcMain.handle('accept-agent', async (_, agentType) => {
  try {
    const session = await agentMonitor.acceptAgent(agentType);
    if (!session) return null;
    session.analyzeOptimization(optimizer);
    return session.getSnapshot();
  } catch (e) {
    console.error('[accept-agent] error:', e.message);
    return null;
  }
});
ipcMain.handle('dismiss-agent', (_, agentType) => { agentMonitor.dismissAgent(agentType); return true; });
ipcMain.handle('disconnect-agent', (_, agentType) => { agentMonitor.disconnectAgent(agentType); return true; });
ipcMain.handle('analyze-agent-session', (_, agentType) => agentMonitor.analyzeSession(agentType, optimizer));

ipcMain.handle('install-bridge', async () => {
  const fs = require('fs');
  const os = require('os');
  const { execSync } = require('child_process');
  const srcDir = path.join(__dirname, '..', 'vscode-extension');

  // Find all VS Code extension dirs (VS Code, Insiders, Cursor)
  const extDirs = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ].filter(d => fs.existsSync(d));

  if (extDirs.length === 0) {
    return { ok: false, error: 'No VS Code extensions directory found' };
  }

  const extName = 'terse.terse-bridge-0.1.0';
  let installed = 0;
  const errors = [];

  for (const extDir of extDirs) {
    const dest = path.join(extDir, extName);
    try {
      // Remove old version if exists
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      // Copy extension files
      fs.mkdirSync(dest, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, file), path.join(dest, file));
      }
      installed++;
    } catch (e) {
      errors.push(`${extDir}: ${e.message}`);
    }
  }

  if (installed > 0) {
    return { ok: true, installed, dirs: extDirs.slice(0, installed) };
  }
  return { ok: false, error: errors.join('; ') };
});

// ── App lifecycle ──
app.whenReady().then(() => {
  createMainWindow();
  createPopupWindow();
  createTray();
  globalShortcut.register('CmdOrCtrl+Shift+T', () =>
    mainWindow && (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()));
  globalShortcut.register('CmdOrCtrl+Shift+C', () => captureFromActiveSession());
  startPolling();

  systemPreferences.isTrustedAccessibilityClient(true);

  // ── Start Agent Monitor ──
  agentMonitor.onEvent((event, data) => {
    // Forward agent events to both windows
    const send = (channel, payload) => {
      try { if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload); } catch {}
      try { if (popupWindow && !popupWindow.isDestroyed() && popupWindow.webContents && !popupWindow.webContents.isDestroyed()) popupWindow.webContents.send(channel, payload); } catch {}
    };

    switch (event) {
      case 'agent-detected':
        send('agent-detected', data);
        break;
      case 'agent-lost':
        send('agent-lost', data);
        break;
      case 'agent-connected':
        send('agent-connected', data);
        break;
      case 'agent-disconnected':
        send('agent-disconnected', data);
        break;
      case 'agent-message': {
        // Run optimization analysis on the session
        agentMonitor.analyzeSession(data.agentType, optimizer);
        const agSess = agentMonitor.sessions.get(data.agentType);
        if (agSess) {
          send('agent-update', { agentType: data.agentType, session: agSess.getSnapshot() });
        }
        break;
      }
    }
  });
  agentMonitor.start();

  // Poll agent sessions for live updates (fs.watch can be unreliable in Electron)
  let lastAgentMsgCount = 0;
  setInterval(() => {
    for (const [agentType, session] of agentMonitor.sessions) {
      // Force watcher to check for new data
      if (session.watcher) session.watcher._readNew();
      const msgCount = session.messages.length;
      if (msgCount !== lastAgentMsgCount) {
        lastAgentMsgCount = msgCount;
        session.analyzeOptimization(optimizer);
        const snap = session.getSnapshot();
        const send = (win) => {
          try { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('agent-update', { agentType, session: snap }); } catch {}
        };
        send(mainWindow);
        send(popupWindow);
      }
    }
  }, 3000); // check every 3 seconds
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPolling();
  agentMonitor.stop();

  // Kill any child terse-ax processes spawned by this instance
  try {
    execSync('pkill -f terse-ax 2>/dev/null || true', { timeout: 3000 });
  } catch { /* ignore */ }
});

// Keep running when windows are closed (tray app), but allow Cmd+Q to quit
app.on('window-all-closed', (e) => e.preventDefault());

// macOS: re-show main window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createMainWindow();
  }
});

// Second instance tried to launch — focus existing window instead
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
