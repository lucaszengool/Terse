const T = window.terse;

let hasContent = false;
let autoMode = 'send';
let minimized = false;
let agentPanelVisible = false; // true when focused app is an agent host and panel is showing
let lastShownSessionId = null; // track which session popup is showing to reset on switch

// Global error handler — catches uncaught exceptions
window.onerror = function(msg, src, line, col, err) {
  const errMsg = '[UNCAUGHT] ' + msg + ' at ' + src + ':' + line + ':' + col;
  try {
    const inv = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (inv) inv('debug_log', { msg: errMsg }).catch(() => {});
  } catch(e) {}
};
window.addEventListener('unhandledrejection', function(e) {
  try {
    const inv = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (inv) inv('debug_log', { msg: '[UNHANDLED-REJECT] ' + String(e.reason) }).catch(() => {});
  } catch(ex) {}
});

// Debug: intercept console.log to write to file via Tauri
const _origLog = console.log;
const _origErr = console.error;
function _debugLog(...args) {
  _origLog(...args);
  try {
    fetch('http://localhost:0/__terse_debug__', { method: 'POST', body: args.join(' ') }).catch(() => {});
  } catch(e) {}
}
// Override console to also print to stderr via invoke
const _dbgInvoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
if (_dbgInvoke) {
  console.log = (...args) => {
    _origLog(...args);
    _dbgInvoke('debug_log', { msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') }).catch(() => {});
  };
  console.error = (...args) => {
    _origErr(...args);
    _dbgInvoke('debug_log', { msg: 'ERROR: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') }).catch(() => {});
  };
}

// ── Quota display ──
async function updatePopupQuota() {
  const el = document.getElementById('popupQuota');
  if (!el) return;
  try {
    const lic = await _invoke('get_license');
    if (lic.remaining < 0) {
      el.textContent = '';
    } else {
      el.textContent = lic.remaining + '/' + lic.limits.optimizationsPerWeek + ' left';
      el.classList.toggle('low', lic.remaining <= 10);
    }
  } catch { el.textContent = ''; }
}
updatePopupQuota();
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('quota-updated', () => updatePopupQuota());
  window.__TAURI__.event.listen('quota-exhausted', (event) => {
    showQuotaExhaustedPopup(event.payload);
  });
}

function showQuotaExhaustedPopup(data) {
  // Remove existing popup if any
  const existing = document.getElementById('quotaExhaustedOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'quotaExhaustedOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:var(--bg);border-radius:16px;padding:24px;max-width:320px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
      <div style="font-size:32px;margin-bottom:8px;">T</div>
      <div style="font-size:15px;font-weight:700;margin-bottom:6px;color:var(--t1);">No Active Plan</div>
      <div style="font-size:11px;color:var(--t2);margin-bottom:16px;line-height:1.5;">
        No active subscription. All sessions have been disconnected.
        <br><br>Start a free trial to continue using Terse.
      </div>
      <div style="display:flex;gap:8px;justify-content:center;">
        <button onclick="this.closest('#quotaExhaustedOverlay').remove()" style="padding:8px 16px;border-radius:8px;border:1px solid var(--bd);background:var(--sf);color:var(--t1);font-size:12px;font-weight:600;cursor:pointer;">
          Dismiss
        </button>
        <button onclick="window.terse?.navigateTo?.('upgrade');this.closest('#quotaExhaustedOverlay').remove()" style="padding:8px 16px;border-radius:8px;border:none;background:var(--ac);color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
          Start Free Trial
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Update quota display
  updatePopupQuota();
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Auto-resize textarea and window to fit content
function autoResizePopup() {
  if (minimized) return;
  const ta = document.getElementById('optimized');
  if (!ta.classList.contains('hidden')) {
    // Reset height to measure scrollHeight
    ta.style.height = 'auto';
    const contentH = Math.min(Math.max(ta.scrollHeight, 44), 300);
    ta.style.height = contentH + 'px';
  }
  // Always measure and resize the window to match visible content
  requestAnimationFrame(() => {
    const bodyH = document.getElementById('bar').offsetHeight + 20; // 20 for padding
    T.resizePopup(bodyH);
  });
}

// Hide → minimize to favicon (instant CSS swap, IPC fires in background)
document.getElementById('btnHide').addEventListener('click', () => {
  minimized = true;
  document.body.classList.add('minimized');
  T.setPopupMinimized(true);
});

const faviconEl = document.getElementById('favicon');

// Favicon: manual drag + click detection
let dragState = null;
faviconEl.addEventListener('mousedown', (e) => {
  dragState = { sx: e.screenX, sy: e.screenY, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = e.screenX - dragState.sx;
  const dy = e.screenY - dragState.sy;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
  if (dragState.moved) {
    T.movePopupBy(dx, dy);
    dragState.sx = e.screenX;
    dragState.sy = e.screenY;
  }
});
window.addEventListener('mouseup', () => {
  if (dragState && !dragState.moved) {
    // It was a click — restore popup
    minimized = false;
    document.body.classList.remove('minimized');
    T.setPopupMinimized(false);
  }
  dragState = null;
});

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    T.updateSettings({ aggressiveness: btn.dataset.mode });
  });
});

// Auto mode toggle (Off / Send / Auto)
document.querySelectorAll('.auto-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auto-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    autoMode = btn.dataset.auto;
    T.setAutoMode(autoMode);
  });
});

// ── Live optimization pipeline ──
// Handles optimize-request from Rust polling thread, runs JS optimizer,
// and updates popup UI directly (no Rust round-trip to avoid IPC deadlock).
let _settleTimer = null;
const SETTLE_DELAY = 600;
const _invoke = T._invoke || window.__TAURI__?.core?.invoke;
// Cooldown after Send/Replace to prevent re-reading the just-written optimized text
let _sendCooldownUntil = 0;

function _updatePopupUI(d) {
  try {
    hasContent = true;
    document.getElementById('hintState').classList.add('hidden');
    document.getElementById('bridgeInstall').classList.add('hidden');
    document.getElementById('optimized').classList.remove('hidden');
    document.getElementById('appLabel').textContent = d.app || 'Connected';
    const stats = d.stats || {};
    document.getElementById('tokBefore').textContent = (stats.originalTokens || 0).toLocaleString();
    document.getElementById('tokAfter').textContent = (stats.optimizedTokens || 0).toLocaleString();
    const pct = stats.percentSaved || 0;
    document.getElementById('tokPct').textContent = pct > 0 ? '-' + pct + '%' : '';
    const tc = document.getElementById('techniques');
    tc.innerHTML = '';
    (stats.techniquesApplied || []).forEach(t => {
      const s = document.createElement('span');
      s.className = 'technique-tag';
      s.textContent = t;
      tc.appendChild(s);
    });
    document.getElementById('optimized').value = d.optimized || '';
    document.getElementById('btnReplace').disabled = false;
    autoResizePopup();
  } catch (e) {
    console.error('[terse-popup] UI update error:', e);
  }
}

T.on('optimize-request', async (d) => {
  if (!window._terseOptimizer) return;
  // Cooldown after Send/Replace — ignore polling for 2s to avoid re-reading optimized text
  if (Date.now() < _sendCooldownUntil) return;

  // Check license quota
  try {
    const check = await _invoke('check_can_optimize');
    if (!check.allowed) return;
  } catch {}

  let opt;
  try {
    opt = window._terseOptimizer.optimize(d.text);
  } catch (e) {
    console.error('[terse-popup] optimizer error:', e);
    return;
  }
  // Quota is consumed on Send/Replace click only, NOT on every keystroke
  const displayOptimized = d.currentWord ? opt.optimized + d.currentWord : opt.optimized;

  _updatePopupUI({
    app: d.app,
    original: d.text + (d.currentWord || ''),
    optimized: displayOptimized,
    stats: opt.stats,
    suggestions: opt.suggestions,
    method: d.method,
    sessionId: d.sessionId,
  });

  // Auto-replace: wait until user STOPS typing (only in 'auto' mode)
  if (d.autoMode === 'auto' && !d.isDeleting && !d.autoReplaced && opt.optimized !== d.text) {
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(async () => {
      _settleTimer = null;
      const freshOpt = window._terseOptimizer.optimize(d.text);
      if (freshOpt.optimized === d.text) return;
      const fullReplacement = freshOpt.optimized + (d.currentWord || '');
      try {
        await _invoke('replace_in_target', { text: fullReplacement });
        const src = d.method === 'bridge' ? 'editor' : 'browser';
        _invoke('record_optimization', {
          source: src,
          originalTokens: freshOpt.stats.originalTokens,
          optimizedTokens: freshOpt.stats.optimizedTokens,
        }).catch(() => {});
        _updatePopupUI({
          app: d.app,
          original: d.text + (d.currentWord || ''),
          optimized: fullReplacement,
          stats: freshOpt.stats,
          suggestions: freshOpt.suggestions,
          method: 'auto-replace',
          sessionId: d.sessionId,
        });
      } catch (e) {
        console.error('[terse] auto-replace error:', e);
      }
    }, SETTLE_DELAY);
  }
});

T.on('send-mode-optimize', async (d) => {
  if (!window._terseOptimizer) return;
  const opt = window._terseOptimizer.optimize(d.text);
  if (opt.optimized !== d.text && opt.optimized.length >= 3) {
    try {
      await _invoke('replace_in_target', { text: opt.optimized });
      await new Promise(r => setTimeout(r, 100));
      await _invoke('send_enter', { pid: d.pid });
      _sendCooldownUntil = Date.now() + 2000; // 2s cooldown
      // Consume 0.5 quota on Send
      _invoke('record_optimization_usage').then(() => {
        if (window.__TAURI__?.event?.emit) {
          window.__TAURI__.event.emit('quota-updated').catch(() => {});
        }
      }).catch(() => {});
      const src = d.readMethod === 'bridge' ? 'editor' : 'browser';
      _invoke('record_optimization', {
        source: src,
        originalTokens: opt.stats.originalTokens,
        optimizedTokens: opt.stats.optimizedTokens,
      }).catch(() => {});
      _updatePopupUI({
        app: d.appName,
        original: d.text,
        optimized: opt.optimized,
        stats: opt.stats,
        suggestions: opt.suggestions,
        method: 'send-mode',
        sessionId: d.sessionId,
      });
      // Clear popup after send so old optimized text doesn't persist into next message
      setTimeout(() => {
        hasContent = false;
        document.getElementById('optimized').classList.add('hidden');
        document.getElementById('optimized').value = '';
        document.getElementById('tokBefore').textContent = '0';
        document.getElementById('tokAfter').textContent = '0';
        document.getElementById('tokPct').textContent = '';
        document.getElementById('techniques').innerHTML = '';
        document.getElementById('btnReplace').disabled = true;
        document.getElementById('hintState').classList.remove('hidden');
        _invoke('clear_popup_state', {}).catch(() => {});
        autoResizePopup();
      }, 1500);
    } catch (e) {
      console.error('[terse] send-mode error:', e);
    }
  } else {
    _invoke('send_enter', { pid: d.pid }).catch(() => {});
    // Clear popup state even when no optimization was needed
    setTimeout(() => {
      hasContent = false;
      document.getElementById('optimized').classList.add('hidden');
      document.getElementById('optimized').value = '';
      document.getElementById('tokBefore').textContent = '0';
      document.getElementById('tokAfter').textContent = '0';
      document.getElementById('tokPct').textContent = '';
      document.getElementById('techniques').innerHTML = '';
      document.getElementById('btnReplace').disabled = true;
      document.getElementById('hintState').classList.remove('hidden');
      _invoke('clear_popup_state', {}).catch(() => {});
      autoResizePopup();
    }, 500);
  }
});

T.on('captured-text', (d) => {
  if (!window._terseOptimizer) return;
  const opt = window._terseOptimizer.optimize(d.text);
  _updatePopupUI({
    app: d.app,
    original: d.text,
    optimized: opt.optimized,
    stats: opt.stats,
    suggestions: opt.suggestions,
    method: d.method,
    sessionId: d.sessionId,
  });
});

// Live update from main process
T.on('popup-update', d => {
  console.log('[terse-popup] popup-update received, app=' + d.app + ' tokens=' + d.stats?.originalTokens + '→' + d.stats?.optimizedTokens);
  try {
    hasContent = true;
    document.getElementById('hintState').classList.add('hidden');
    document.getElementById('bridgeInstall').classList.add('hidden');
    document.getElementById('optimized').classList.remove('hidden');

    document.getElementById('appLabel').textContent = d.app || 'Connected';
    const stats = d.stats || {};
    document.getElementById('tokBefore').textContent = (stats.originalTokens || 0).toLocaleString();
    document.getElementById('tokAfter').textContent = (stats.optimizedTokens || 0).toLocaleString();
    const pct = stats.percentSaved || 0;
    document.getElementById('tokPct').textContent = pct > 0 ? '-' + pct + '%' : '';

    const tc = document.getElementById('techniques');
    tc.innerHTML = '';
    (stats.techniquesApplied || []).forEach(t => {
      const s = document.createElement('span');
      s.className = 'technique-tag';
      s.textContent = t;
      tc.appendChild(s);
    });

    document.getElementById('optimized').value = d.optimized || '';
    document.getElementById('btnReplace').disabled = false;
    autoResizePopup();
  } catch (e) {
    console.error('[terse] popup-update error:', e);
  }
});

T.on('popup-show', d => {
  document.getElementById('appLabel').textContent = d.app || 'Connected';

  // Reset text optimization UI when switching sessions
  if (d.sessionId !== lastShownSessionId) {
    hasContent = false;
    lastShownSessionId = d.sessionId;
    document.getElementById('hintState').classList.remove('hidden');
    document.getElementById('bridgeInstall').classList.add('hidden');
    document.getElementById('optimized').classList.add('hidden');
    document.getElementById('optimized').value = '';
    document.getElementById('tokBefore').textContent = '0';
    document.getElementById('tokAfter').textContent = '0';
    document.getElementById('tokPct').textContent = '';
    document.getElementById('techniques').innerHTML = '';
    document.getElementById('btnReplace').disabled = true;
  } else if (!hasContent) {
    document.getElementById('hintState').classList.remove('hidden');
    document.getElementById('optimized').classList.add('hidden');
    document.getElementById('btnReplace').disabled = true;
  }

  // Show agent panel only when this session is the agent host
  if (activeAgentType) {
    if (!agentHostSessionId) agentHostSessionId = d.sessionId;
    if (d.sessionId === agentHostSessionId) {
      document.getElementById('agentPanel').classList.remove('hidden');
      agentPanelVisible = true;
    } else {
      document.getElementById('agentPanel').classList.add('hidden');
      agentPanelVisible = false;
    }
  }
  autoResizePopup();
});

T.on('popup-hide', () => {
  hasContent = false;
  agentPanelVisible = false;
});

T.on('popup-hint', d => {
  if (hasContent) return;
  document.getElementById('appLabel').textContent = d.app || 'Connected';
  const hint = document.getElementById('hintState');
  const bridgeDiv = document.getElementById('bridgeInstall');
  hint.classList.remove('hidden');
  document.getElementById('optimized').classList.add('hidden');
  if (d.axBlind && d.bridgeMissing) {
    hint.innerHTML = '<span>Select text &amp; click <b>Capture</b> / press <b>Cmd+Shift+C</b></span>';
    bridgeDiv.classList.remove('hidden');
  } else if (d.axBlind) {
    hint.innerHTML = '<span>Select your prompt text, then click <b>Capture</b> or press <b>Cmd+Shift+C</b></span>';
    bridgeDiv.classList.add('hidden');
  } else {
    bridgeDiv.classList.add('hidden');
  }
  document.getElementById('btnReplace').disabled = true;
});

T.on('popup-clear', () => {
  hasContent = false;
  document.getElementById('hintState').classList.remove('hidden');
  document.getElementById('bridgeInstall').classList.add('hidden');
  document.getElementById('optimized').classList.add('hidden');
  document.getElementById('optimized').value = '';
  document.getElementById('tokBefore').textContent = '0';
  document.getElementById('tokAfter').textContent = '0';
  document.getElementById('tokPct').textContent = '';
  document.getElementById('techniques').innerHTML = '';
  document.getElementById('btnReplace').disabled = true;
  T.resizePopup(160);
});

// Sync mode from settings
T.getSettings().then(s => {
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === s.aggressiveness);
  });
});

// Capture
document.getElementById('btnCapture').addEventListener('click', async () => {
  const btn = document.getElementById('btnCapture');
  btn.classList.add('busy');
  await T.captureNow();
  btn.classList.remove('busy');
});

// Replace
document.getElementById('btnReplace').addEventListener('click', async () => {
  const text = document.getElementById('optimized').value;
  if (!text) return;
  const btn = document.getElementById('btnReplace');
  btn.textContent = '...'; btn.disabled = true;
  _sendCooldownUntil = Date.now() + 2000; // 2s cooldown
  // Consume 0.5 quota on Replace click
  _invoke('record_optimization_usage').then(() => {
    if (window.__TAURI__?.event?.emit) {
      window.__TAURI__.event.emit('quota-updated').catch(() => {});
    }
  }).catch(() => {});
  await T.replaceInTarget(text);
  btn.innerHTML = '&#10003;'; btn.classList.add('success');
  setTimeout(() => {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Replace';
    btn.disabled = false; btn.classList.remove('success');
  }, 1200);
});

// Copy
document.getElementById('btnCopy').addEventListener('click', async () => {
  const text = document.getElementById('optimized').value;
  if (!text) return;
  await T.applyToClipboard(text);
  const btn = document.getElementById('btnCopy');
  btn.innerHTML = '&#10003;';
  setTimeout(() => {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  }, 1000);
});

// ── Agent Monitor UI ──

let activeAgentType = null; // currently connected agent type
let agentHostSessionId = null; // session ID that hosts the agent (e.g. the terminal running Claude Code)

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function showAgentBanner(info) {
  const banner = document.getElementById('agentBanner');
  document.getElementById('agentBannerIcon').textContent = info.icon || '';
  document.getElementById('agentBannerText').textContent = `${info.name} detected — monitor session?`;
  banner.classList.remove('hidden');
  banner.dataset.agentType = info.type;
  autoResizePopup();
}

function hideAgentBanner() {
  document.getElementById('agentBanner').classList.add('hidden');
  autoResizePopup();
}

// ── Plan Info & Savings ──
let _planInfoCache = null;
let _planInfoFetchedAt = 0;
const PLAN_FETCH_INTERVAL = 60000;

// Cost per million tokens by agent+model (USD) — Anthropic API pricing
const TOKEN_PRICING = {
  'claude-code': {
    'claude-opus-4-6': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    'opus': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-haiku-4-5': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
    'haiku': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
    'default': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  'cursor-agent': {
    'auto': { input: 1.25, output: 6.00, cacheRead: 0.13, cacheWrite: 1.56 },
    'claude-sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-opus': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    'default': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  'codex': {
    'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 2.50 },
    'o3': { input: 2.00, output: 8.00, cacheRead: 1.00, cacheWrite: 2.00 },
    'default': { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 2.50 },
  },
  'copilot': {
    'default': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  'default': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
};

function getModelPricing(agentType, model) {
  const agentPricing = TOKEN_PRICING[agentType] || TOKEN_PRICING;
  if (!model) return agentPricing['default'] || TOKEN_PRICING['default'];
  const ml = model.toLowerCase();
  const modelKey = Object.keys(agentPricing).find(k => ml.includes(k));
  return agentPricing[modelKey] || agentPricing['default'] || TOKEN_PRICING['default'];
}

// Calculate precise conversation cost from actual token counts
function calculateConversationCost(snapshot) {
  const model = _planInfoCache?.rateLimitTier || snapshot.detectedModel || snapshot.model || null;
  const pricing = getModelPricing(activeAgentType, model);

  const inputTok = snapshot.totalInputTokens || 0;
  const outputTok = snapshot.totalOutputTokens || 0;
  const cacheReadTok = snapshot.totalCacheReadTokens || 0;
  const cacheWriteTok = snapshot.totalCacheCreateTokens || 0;
  // Fresh input = total input - cache reads (cache reads are cheaper)
  const freshInput = Math.max(0, inputTok - cacheReadTok);

  const cost = (freshInput / 1e6) * pricing.input
    + (cacheReadTok / 1e6) * pricing.cacheRead
    + (cacheWriteTok / 1e6) * pricing.cacheWrite
    + (outputTok / 1e6) * pricing.output;

  // Cache savings = what it would have cost without cache
  const cacheSavings = (cacheReadTok / 1e6) * (pricing.input - pricing.cacheRead);

  return { cost, cacheSavings, pricing, model };
}

// Calculate precise dollar savings from hook compression
function calculateHookSavingsUSD(tokensSaved) {
  const pricing = getModelPricing(activeAgentType, _planInfoCache?.rateLimitTier || null);
  // Saved tokens would have been input tokens (context that was compressed)
  return (tokensSaved / 1e6) * pricing.input;
}

function estimateSavingsUSD(agentType, model, tokensSaved) {
  const pricing = getModelPricing(agentType, model);
  return (tokensSaved / 1e6) * pricing.input;
}

function formatUSD(amount) {
  if (amount >= 1) return '$' + amount.toFixed(2);
  if (amount >= 0.01) return '$' + amount.toFixed(2);
  if (amount >= 0.001) return '$' + amount.toFixed(3);
  return '<$0.001';
}

async function fetchAndShowPlanInfo(agentType) {
  console.log('[terse] fetchAndShowPlanInfo called, agentType:', agentType);
  if (!agentType) return;
  const now = Date.now();
  if (_planInfoCache && (now - _planInfoFetchedAt) < PLAN_FETCH_INTERVAL) {
    renderPlanInfo(_planInfoCache);
    return;
  }
  try {
    if (!_invoke) { console.error('[terse] _invoke not available'); return; }
    const info = await _invoke('get_agent_plan_info', { agentType });
    console.log('[terse] plan info result:', JSON.stringify(info));
    if (info) {
      _planInfoCache = info;
      _planInfoFetchedAt = now;
      renderPlanInfo(info);
    }
  } catch (e) { console.error('[terse] plan info fetch failed:', e); }
}

function renderPlanInfo(info) {
  const row = document.getElementById('agentPlanRow');
  if (!info || !info.plan || info.plan === 'unknown') { row?.classList.add('hidden'); return; }
  row.classList.remove('hidden');

  // Plan badge
  const badge = document.getElementById('agentPlanBadge');
  const p = (info.rateLimitTier || info.plan).toLowerCase();
  let label = info.plan, cls = 'plan-badge';
  if (p.includes('max_20x') || p.includes('max20x')) { label = 'Max 20x'; cls += ' max'; }
  else if (p.includes('max_5x') || p.includes('max5x')) { label = 'Max 5x'; cls += ' max'; }
  else if (p.includes('max')) { label = 'Max'; cls += ' max'; }
  else if (p.includes('pro')) { label = 'Pro'; cls += ' pro'; }
  else if (p.includes('free') || p.includes('hobby')) { label = 'Free'; cls += ' free'; }
  else if (p.includes('business')) { label = 'Business'; cls += ' pro'; }
  else { label = info.plan; }
  badge.textContent = label;
  badge.className = cls;

  // Short-term usage bar
  const shortWrap = document.getElementById('usageShortWrap');
  if (info.shortTerm) {
    shortWrap.style.display = '';
    document.getElementById('usageShortLabel').textContent = info.shortTerm.label;
    const pct = Math.round(info.shortTerm.utilization);
    const bar = document.getElementById('usageShortBar');
    bar.style.width = Math.min(pct, 100) + '%';
    bar.className = 'usage-bar-fill' + (pct > 85 ? ' danger' : pct > 60 ? ' warn' : '');
    document.getElementById('usageShortPct').textContent = pct + '%';
  } else { shortWrap.style.display = 'none'; }

  // Long-term usage bar
  const longWrap = document.getElementById('usageLongWrap');
  if (info.longTerm) {
    longWrap.style.display = '';
    document.getElementById('usageLongLabel').textContent = info.longTerm.label;
    const pct = Math.round(info.longTerm.utilization);
    const bar = document.getElementById('usageLongBar');
    bar.style.width = Math.min(pct, 100) + '%';
    bar.className = 'usage-bar-fill' + (pct > 85 ? ' danger' : pct > 60 ? ' warn' : '');
    document.getElementById('usageLongPct').textContent = pct + '%';
  } else { longWrap.style.display = 'none'; }

  // Reset timer / requests
  const timer = document.getElementById('agentResetTimer');
  if (info.requestsUsed != null && info.requestsMax != null) {
    timer.textContent = info.requestsUsed + '/' + info.requestsMax + ' reqs';
  } else {
    const resetAt = info.shortTerm?.resetsAt;
    if (resetAt) {
      const delta = new Date(resetAt) - new Date();
      if (delta > 0) {
        const h = Math.floor(delta / 3600000);
        const m = Math.floor((delta % 3600000) / 60000);
        timer.textContent = 'resets ' + (h > 0 ? h + 'h ' : '') + m + 'm';
      } else { timer.textContent = ''; }
    } else { timer.textContent = ''; }
  }

  // Precise dollar savings using plan pricing
  const usdEl = document.getElementById('agentSavingsUSD');
  const hookSaved = window._terseHookStats?.totalSaved || 0;
  if (hookSaved > 0 && activeAgentType) {
    const usd = calculateHookSavingsUSD(hookSaved);
    usdEl.textContent = formatUSD(usd) + ' saved';
  } else { usdEl.textContent = ''; }
}

function showAgentPanel(snapshot) {
  console.log('[terse-dbg] showAgentPanel called, agentType:', snapshot.agentType, 'turns:', snapshot.turns);
  activeAgentType = snapshot.agentType;
  agentHostSessionId = lastShownSessionId; // remember which session hosts this agent
  agentPanelVisible = true;

  // Fetch plan info early (async, cached) — must not be blocked by DOM errors
  try { fetchAndShowPlanInfo(snapshot.agentType); } catch(e) { console.error('[terse] plan fetch error:', e); }

  const panel = document.getElementById('agentPanel');
  document.getElementById('agentPanelIcon').textContent = snapshot.agentIcon || '';
  document.getElementById('agentPanelName').textContent = snapshot.agentName;
  document.getElementById('agentPanelStatus').textContent = 'Monitoring';
  panel.classList.remove('hidden');
  hideAgentBanner();
  try { updateAgentPanel(snapshot); } catch(e) { console.error('[terse] updateAgentPanel error:', e); }
  autoResizePopup();
  // Run enrichment async to avoid freezing UI
  setTimeout(() => {
    try { enrichAgentOptStats(snapshot); updateAgentPanel(snapshot); autoResizePopup(); } catch(e) {}
  }, 200);
}

function hideAgentPanel() {
  activeAgentType = null;
  agentHostSessionId = null;
  _planInfoCache = null;
  document.getElementById('agentPanel').classList.add('hidden');
  document.getElementById('agentPlanRow')?.classList.add('hidden');
  autoResizePopup();
}

function updateAgentPanel(snapshot) {
  const panel = document.getElementById('agentPanel');
  console.log('[terse-dbg] updateAgentPanel: hidden=' + panel.classList.contains('hidden') +
    ' msgs=' + (snapshot.recentMessages || []).length +
    ' turns=' + snapshot.turns +
    ' panelH=' + panel.offsetHeight);
  // ── Context fill meter ──
  const ctxFill = snapshot.contextFill || 0;
  const currentCtx = snapshot.currentContext || 0;
  const ctxBar = document.getElementById('agentContextBar');
  document.getElementById('agentContextPct').textContent =
    formatTokens(currentCtx) + ' / 200K (' + ctxFill + '%)';
  ctxBar.style.width = Math.min(ctxFill, 100) + '%';
  ctxBar.className = 'context-fill-bar-fill' +
    (ctxFill > 85 ? ' danger' : ctxFill > 60 ? ' warn' : '');

  // ── Summary bar (always visible) ──
  document.getElementById('agentCtxShort').textContent = ctxFill + '%';
  document.getElementById('agentInputShort').textContent = formatTokens(snapshot.totalInputTokens || 0);
  const cacheVal = snapshot.cacheEfficiency || 0;
  const cacheShort = document.getElementById('agentCacheShort');
  cacheShort.textContent = cacheVal + '%';
  cacheShort.style.color = cacheVal > 50 ? 'var(--ac)' : cacheVal > 20 ? '#fbbf24' : '#f87171';
  document.getElementById('agentToolShort').textContent = snapshot.toolCallCount || 0;

  // Burn rate
  const burnRate = snapshot.burnRate || 0;
  document.getElementById('agentBurnRate').textContent =
    formatTokens(burnRate) + ' tok/min';

  // ── Savings hero ──
  const opt = snapshot.optimizationStats || {};
  const autoSaved = snapshot.autoOptimized ? snapshot.autoOptimized.tokensSaved : 0;
  const _tcp = snapshot.toolCachePotential || {};
  const _trs = snapshot.toolResultStats || {};

  // Fetch hook stats (RTK-style active compression savings)
  const hookSaved = window._terseHookStats?.totalSaved || 0;
  if (T.getHookStats && !window._hookStatsPending) {
    window._hookStatsPending = true;
    T.getHookStats().then(hs => {
      window._terseHookStats = hs;
      window._hookStatsPending = false;
    }).catch(() => { window._hookStatsPending = false; });
  }

  // Actual savings = hook compression (tokens truly removed from context)
  const actualSaved = hookSaved + autoSaved;
  // Potential savings = estimates of what could be saved
  const potentialSaved = (opt.potentialSavings || 0) + (snapshot.rereadWaste || 0)
    + (_tcp.tokensWasted || 0) + (_trs.compressibleTokens || 0);
  const totalSaved = actualSaved + potentialSaved;
  const totalIn = (snapshot.totalInputTokens || 1);

  // Show "saved" when hook is active, "saveable" when only estimates
  const hasActual = actualSaved > 0;
  const displaySaved = hasActual ? actualSaved : totalSaved;
  const label = hasActual ? 'saved' : 'saveable';

  // When hook is active, show the hook's compression rate (meaningful %)
  // instead of saved/totalInput which is always ~0% for large conversations
  const hookPct = window._terseHookStats?.percentSaved || 0;
  const pct = hasActual && hookPct > 0
    ? hookPct
    : (totalIn > 0 ? Math.round((totalSaved / totalIn) * 100) : 0);

  document.getElementById('agentSavedBig').textContent = formatTokens(displaySaved);
  document.getElementById('agentSaveShort').textContent = formatTokens(displaySaved);
  document.getElementById('agentSavingsPct').textContent = pct + '%';
  document.getElementById('agentSavingsBar').style.width = Math.min(pct, 100) + '%';

  // Update labels dynamically with precise cost calculations
  const saveLabelEl = document.getElementById('agentSaveLabel');
  if (saveLabelEl) saveLabelEl.textContent = label;
  const savingsUnitEl = document.getElementById('agentSavingsUnit');
  if (savingsUnitEl) {
    let unitText = hasActual
      ? 'tokens saved' + (potentialSaved > 1000 ? ' (+' + formatTokens(potentialSaved) + ' saveable)' : '')
      : 'tokens saveable';
    // Precise dollar savings using actual plan pricing
    if (hasActual && actualSaved > 100 && activeAgentType) {
      const usd = calculateHookSavingsUSD(actualSaved);
      if (usd >= 0.001) unitText += ' ≈ ' + formatUSD(usd);
    }
    savingsUnitEl.textContent = unitText;
  }

  // Precise conversation cost + cache savings
  const costInfo = calculateConversationCost(snapshot);
  let costEl = document.getElementById('agentConvCost');
  if (!costEl) {
    costEl = document.createElement('div');
    costEl.id = 'agentConvCost';
    costEl.style.cssText = 'font-size:10px;color:#999;padding:0 8px 2px;display:flex;justify-content:space-between';
    const savingsEl = document.getElementById('agentSavedBig')?.parentElement;
    if (savingsEl) savingsEl.appendChild(costEl);
  }
  if (costInfo.cost >= 0.001) {
    let costText = 'Session cost: ' + formatUSD(costInfo.cost);
    if (costInfo.cacheSavings >= 0.001) {
      costText += ' (cache saved ' + formatUSD(costInfo.cacheSavings) + ')';
    }
    costEl.textContent = costText;
  }

  // Show hook compression badge if active
  let hookBadgeEl = document.getElementById('agentHookBadge');
  if (!hookBadgeEl) {
    hookBadgeEl = document.createElement('div');
    hookBadgeEl.id = 'agentHookBadge';
    hookBadgeEl.style.cssText = 'font-size:10px;color:var(--ac);padding:2px 8px;display:none';
    const savingsEl = document.getElementById('agentSavedBig')?.parentElement;
    if (savingsEl) savingsEl.appendChild(hookBadgeEl);
  }
  if (hookSaved > 0) {
    const hs = window._terseHookStats;
    hookBadgeEl.textContent = '⚡ Hook: ' + formatTokens(hookSaved) + ' saved (' + (hs?.compressions || 0) + ' compressions, ' + (hs?.percentSaved || 0) + '% avg)';
    hookBadgeEl.style.display = 'block';
  }

  // ── Compact stats ──
  document.getElementById('agentTurns').textContent = snapshot.turns || '0';
  document.getElementById('agentInputTok').textContent = formatTokens(snapshot.totalInputTokens || 0);
  document.getElementById('agentCacheEff').textContent = (snapshot.cacheEfficiency || 0) + '%';
  document.getElementById('agentToolCount').textContent = snapshot.toolCallCount || 0;

  // Color-code cache
  const cacheEl = document.getElementById('agentCacheEff');
  cacheEl.style.color = (snapshot.cacheEfficiency || 0) > 50 ? 'var(--ac)' :
    (snapshot.cacheEfficiency || 0) > 20 ? '#fbbf24' : '#f87171';

  // ── Token breakdown by type ──
  const bd = snapshot.tokenBreakdown || {};
  const bdTotal = (bd.user || 0) + (bd.assistant || 0) + (bd.tool || 0) || 1;
  const userPct = Math.round((bd.user || 0) / bdTotal * 100);
  const asstPct = Math.round((bd.assistant || 0) / bdTotal * 100);
  const toolPct = Math.round((bd.tool || 0) / bdTotal * 100);
  document.getElementById('breakdownUser').style.width = userPct + '%';
  document.getElementById('breakdownAssistant').style.width = asstPct + '%';
  document.getElementById('breakdownTool').style.width = toolPct + '%';
  document.getElementById('breakdownUserPct').textContent = userPct + '%';
  document.getElementById('breakdownAsstPct').textContent = asstPct + '%';
  document.getElementById('breakdownToolPct').textContent = toolPct + '%';

  // ── Insights / Alerts ──
  const insightsEl = document.getElementById('agentInsights');
  const insights = [];

  // Context fill warning
  if (ctxFill > 85) {
    insights.push({ type: 'alert', icon: '!', text: 'Context nearly full — consider /compact', value: ctxFill + '%' });
  } else if (ctxFill > 60) {
    insights.push({ type: 'warn', icon: '!', text: 'Context growing — watch for degradation', value: ctxFill + '%' });
  }

  // Redundant reads
  const rereads = snapshot.redundantReads || [];
  if (rereads.length > 0) {
    const totalWasted = rereads.reduce((s, r) => s + (r.wastedReads || 0), 0);
    insights.push({ type: 'warn', icon: '↺', text: `${rereads.length} files re-read (${totalWasted} extra reads)`, value: '~' + formatTokens(snapshot.rereadWaste || 0) });
  }

  // Large tool results
  const largeResults = snapshot.largeToolResults || [];
  if (largeResults.length > 0) {
    const totalLarge = largeResults.reduce((s, r) => s + r.tokens, 0);
    insights.push({ type: 'tip', icon: '▤', text: `${largeResults.length} large tool results`, value: formatTokens(totalLarge) });
  }

  // High tool % warning
  if (toolPct > 60) {
    insights.push({ type: 'warn', icon: '⚙', text: 'Tool results dominate context', value: toolPct + '%' });
  }

  // Prompt optimization potential
  if (opt.potentialSavings > 0 && opt.optimizedMessages > 0) {
    insights.push({ type: 'tip', icon: '✎', text: `${opt.optimizedMessages} prompts could be tighter`, value: '-' + formatTokens(opt.potentialSavings) });
  }

  // Unused tools overhead
  const tm = snapshot.toolManagement || {};
  if (tm.unusedEstimate > 3 && (snapshot.turns || 0) > 5) {
    const overhead = tm.overheadPerTurn || 0;
    insights.push({ type: 'tip', icon: '⊘', text: `${tm.unusedEstimate} unused tools loaded (~${formatTokens(overhead)} tok/turn overhead)`, value: formatTokens(tm.unusedEstimate) });
  }

  // Duplicate tool calls
  const tcp = snapshot.toolCachePotential || {};
  if (tcp.duplicateCalls > 0) {
    insights.push({ type: 'warn', icon: '⊜', text: `${tcp.duplicateCalls} duplicate tool calls detected (-${formatTokens(tcp.tokensWasted || 0)} tokens wasted)`, value: '-' + formatTokens(tcp.tokensWasted || 0) });
  }

  // Compressible tool results
  const trs = snapshot.toolResultStats || {};
  if (trs.compressibleTokens > 5000) {
    const compPctVal = trs.totalTokens > 0 ? Math.round((trs.compressibleTokens / trs.totalTokens) * 100) : 0;
    insights.push({ type: 'tip', icon: '▤', text: `Tool output ${compPctVal}% compressible (~${formatTokens(trs.compressibleTokens)} saveable)`, value: formatTokens(trs.compressibleTokens) });
  }

  // Active hook compression (RTK-style)
  if (hookSaved > 0) {
    const hs = window._terseHookStats;
    insights.push({ type: 'tip', icon: '⚡', text: `Hook compressed ${hs?.compressions || 0} outputs (${hs?.percentSaved || 0}% avg)`, value: '-' + formatTokens(hookSaved) });
  }

  if (insights.length > 0) {
    insightsEl.classList.remove('hidden');
    insightsEl.innerHTML = '';
    for (const ins of insights.slice(0, 5)) {
      const div = document.createElement('div');
      div.className = 'insight-item ' + ins.type;
      div.innerHTML =
        '<span class="insight-icon">' + ins.icon + '</span>' +
        '<span class="insight-text">' + ins.text + '</span>' +
        '<span class="insight-value">' + ins.value + '</span>';
      insightsEl.appendChild(div);
    }
  } else {
    insightsEl.classList.add('hidden');
  }

  // ── How tokens were saved ──
  const detailEl = document.getElementById('agentOptDetail');
  if (opt.optimizedMessages > 0 && opt.potentialSavings > 0) {
    detailEl.classList.remove('hidden');
    document.getElementById('agentOptMsgCount').textContent =
      opt.optimizedMessages + '/' + opt.totalMessages + ' messages optimized';

    // Top techniques (max 4)
    const techEl = document.getElementById('agentOptTechniques');
    if (opt.topTechniques && opt.topTechniques.length > 0) {
      techEl.innerHTML = '';
      for (const t of opt.topTechniques.slice(0, 4)) {
        const tag = document.createElement('span');
        tag.className = 'agent-opt-tech-tag';
        tag.innerHTML = t.name + ' <span class="tag-saved">-' + formatTokens(t.tokensSaved) + '</span>';
        techEl.appendChild(tag);
      }
    }

    // Before/after examples (max 2)
    const recentEl = document.getElementById('agentOptRecent');
    if (opt.recentOptimizations && opt.recentOptimizations.length > 0) {
      recentEl.classList.remove('hidden');
      recentEl.innerHTML = '';
      for (const m of opt.recentOptimizations.slice(-2)) {
        if (m.saved <= 0) continue;
        const div = document.createElement('div');
        div.className = 'agent-opt-msg';
        div.innerHTML =
          '<div class="agent-opt-msg-header"><span class="agent-opt-msg-tokens">' +
            m.originalTokens + ' → ' + m.optimizedTokens +
            ' <span class="saved">(-' + m.percent + '%)</span></span></div>' +
          '<div class="agent-opt-msg-before">' + escapeHtml(m.original) + '</div>' +
          '<div class="agent-opt-msg-after">' + escapeHtml(m.optimized) + '</div>';
        recentEl.appendChild(div);
      }
    } else {
      recentEl.classList.add('hidden');
    }
  } else {
    detailEl.classList.add('hidden');
  }

  // ── Tool result breakdown (top consumers) ──
  let toolBreakdownEl = document.getElementById('agentToolBreakdown');
  if (!toolBreakdownEl) {
    toolBreakdownEl = document.createElement('div');
    toolBreakdownEl.id = 'agentToolBreakdown';
    toolBreakdownEl.className = 'agent-tool-breakdown';
    const insertBefore = document.getElementById('agentWarnings');
    if (insertBefore) insertBefore.parentNode.insertBefore(toolBreakdownEl, insertBefore);
  }
  const toolConsumers = snapshot.toolTokenBreakdown || [];
  const trsStats = snapshot.toolResultStats || {};
  if (toolConsumers.length > 0) {
    toolBreakdownEl.classList.remove('hidden');
    const compTotal = trsStats.compressibleTokens || 0;
    const trsTotal = trsStats.totalTokens || 1;
    const compPct = trsTotal > 0 ? Math.round((compTotal / trsTotal) * 100) : 0;
    toolBreakdownEl.innerHTML = '<div class="opt-detail-header"><span class="opt-detail-title">Top tool consumers</span>' +
      (compTotal > 0 ? '<span class="opt-detail-sub" style="color:var(--ac);font-size:10px;margin-left:auto">' + compPct + '% compressible</span>' : '') +
      '</div>';
    const maxTok = toolConsumers[0]?.tokens || 1;
    for (const tc of toolConsumers.slice(0, 5)) {
      const pctW = Math.max(Math.round((tc.tokens / maxTok) * 100), 4);
      const compRate = Math.round(estimateToolCompressRate(tc.name, '') * 100);
      const row = document.createElement('div');
      row.className = 'tool-consumer-row';
      row.innerHTML =
        '<span class="tool-consumer-name">' + escapeHtml(tc.name) + ' <span class="tool-consumer-count">x' + tc.calls + '</span></span>' +
        '<div class="tool-consumer-bar-wrap"><div class="tool-consumer-bar" style="width:' + pctW + '%"></div></div>' +
        '<span class="tool-consumer-tokens">' + formatTokens(tc.tokens) + ' <span style="color:var(--ac);font-size:9px">~' + compRate + '%</span></span>';
      toolBreakdownEl.appendChild(row);
    }
  } else {
    toolBreakdownEl.classList.add('hidden');
  }

  // ── Generate CLAUDE.md button ──
  let claudeMdWrap = document.getElementById('agentClaudeMdWrap');
  if (!claudeMdWrap) {
    claudeMdWrap = document.createElement('div');
    claudeMdWrap.id = 'agentClaudeMdWrap';
    claudeMdWrap.style.padding = '4px 0';
    const btn = document.createElement('button');
    btn.id = 'btnGenClaudeMd';
    btn.className = 'agent-claudemd-btn';
    btn.textContent = 'Generate CLAUDE.md rules';
    btn.addEventListener('click', () => {
      const outputEl = document.getElementById('claudeMdOutput');
      if (!outputEl.classList.contains('hidden')) {
        outputEl.classList.add('hidden');
        autoResizePopup();
        return;
      }
      const snap = window._lastAgentSnapshot;
      if (!snap) return;
      const md = generateClaudeMdSuggestions(snap);
      document.getElementById('claudeMdContent').textContent = md;
      outputEl.classList.remove('hidden');
      autoResizePopup();
    });
    claudeMdWrap.appendChild(btn);

    const outputDiv = document.createElement('div');
    outputDiv.id = 'claudeMdOutput';
    outputDiv.className = 'claudemd-output hidden';
    outputDiv.innerHTML =
      '<pre id="claudeMdContent" class="claudemd-pre"></pre>' +
      '<button id="btnCopyClaudeMd" class="claudemd-copy-btn">Copy</button>';
    claudeMdWrap.appendChild(outputDiv);

    // Insert after tool breakdown
    const insertAfter = toolBreakdownEl || document.getElementById('agentWarnings');
    if (insertAfter && insertAfter.parentNode) {
      insertAfter.parentNode.insertBefore(claudeMdWrap, insertAfter.nextSibling);
    }

    document.getElementById('btnCopyClaudeMd').addEventListener('click', async () => {
      const text = document.getElementById('claudeMdContent').textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch(e) {
        // fallback
        if (T.applyToClipboard) await T.applyToClipboard(text);
      }
      const btn2 = document.getElementById('btnCopyClaudeMd');
      btn2.textContent = 'Copied!';
      setTimeout(() => { btn2.textContent = 'Copy'; }, 1200);
    });
  }

  // Stash snapshot for CLAUDE.md generation
  window._lastAgentSnapshot = snapshot;

  // ── Warnings (compact) ──
  const warningsEl = document.getElementById('agentWarnings');
  const dedupAlerts = snapshot.contextDedupAlerts || [];
  const rtAlerts = snapshot.redundantToolCalls || [];
  if (dedupAlerts.length > 0 || rtAlerts.length > 0) {
    warningsEl.classList.remove('hidden');

    const dedupEl = document.getElementById('agentDedupAlerts');
    dedupEl.innerHTML = '';
    for (const a of dedupAlerts.slice(-2)) {
      const div = document.createElement('div');
      div.className = 'agent-dedup-alert';
      div.innerHTML =
        '<span class="dedup-text">Repeated context: turns ' + a.turnA + '/' + a.turnB +
          ' (' + a.similarity + '% similar)</span>' +
        '<span class="dedup-waste">~' + formatTokens(a.wastedTokens) + '</span>';
      dedupEl.appendChild(div);
    }

    const rtEl = document.getElementById('agentRedundantTools');
    rtEl.innerHTML = '';
    for (const r of rtAlerts.slice(-3)) {
      const div = document.createElement('div');
      div.className = 'agent-redundant-tool';
      div.innerHTML =
        '<span class="rt-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="rt-count">x' + r.count + '</span>';
      rtEl.appendChild(div);
    }
  } else {
    warningsEl.classList.add('hidden');
  }

  // ── Activity feed with inline token info on every entry ──
  const actEl = document.getElementById('agentActivity');
  const msgs = snapshot.recentMessages || [];
  const lastFew = msgs.slice(-20);
  // Use message count + last message text + turns for reliable change detection
  const lastMsg = lastFew[lastFew.length - 1];
  const newKey = lastFew.length + '|' + (snapshot.turns || 0) + '|' + (snapshot.toolCallCount || 0) + '|' +
    (lastMsg ? (lastMsg.role || '') + (lastMsg.text || '').substring(0, 50) + (lastMsg.tokens || 0) : '');
  if (actEl.dataset.key !== newKey) {
    actEl.dataset.key = newKey;
    actEl.innerHTML = '';
    const optimizer = window._terseOptimizer;
    for (const m of lastFew) {
      const line = document.createElement('div');
      line.className = 'agent-activity-line ' + (m.role || '');
      const prefix = m.type === 'tool_use' ? '⚙ ' : m.type === 'tool_result' ? '← ' :
                     m.role === 'user' ? '→ ' : m.role === 'assistant' ? '◆ ' : '';
      const text = (m.text || '').substring(0, 100);
      const tok = m.tokens || 0;

      // ── User messages: show with optimization savings ──
      if (m.role === 'user' && m.type !== 'tool_result') {
        line.innerHTML = prefix + escapeHtml(text);
        const hasTokenSavings = (m.text || '').length > 10 && m._optSaved > 0;
        const hasTextChanges = m._optChanged && (m.text || '').length > 10;
        if (hasTokenSavings || hasTextChanges) {
          const badge = document.createElement('span');
          if (hasTokenSavings) {
            badge.className = 'opt-badge saveable';
            badge.textContent = '-' + m._optSaved + ' tok (' + m._optPct + '%)';
          } else {
            // Text improved but no token savings (e.g. typo fixes)
            badge.className = 'opt-badge fixed';
            const techs = (m._optTechniques || []).join(', ') || 'improved';
            badge.textContent = techs;
          }
          line.appendChild(badge);
          line.classList.add('has-savings');
          line.style.cursor = 'pointer';
          line.title = 'Click to see before/after optimization';
          const fullText = m.text;
          const optText = m._optText || '';
          line.addEventListener('click', () => {
            const existing = line.nextElementSibling;
            if (existing && existing.classList.contains('opt-inline-detail')) {
              existing.remove(); return;
            }
            const detail = document.createElement('div');
            detail.className = 'opt-inline-detail';
            detail.innerHTML =
              '<div class="opt-inline-before">' + escapeHtml((fullText || '').substring(0, 300)) + '</div>' +
              '<div class="opt-inline-after">' + escapeHtml(optText.substring(0, 300)) + '</div>';
            line.after(detail);
          });
        } else if ((m.text || '').length > 10) {
          const badge = document.createElement('span');
          badge.className = 'opt-badge no-save';
          badge.textContent = '✓ optimal';
          line.appendChild(badge);
        } else if (tok > 0) {
          addTokenBadge(line, tok, 'dim');
        }

      // ── Tool results: show token cost + RTK compression savings ──
      } else if (m.type === 'tool_result') {
        const toolName = m.tool_name || m.toolName || '';
        line.innerHTML = prefix + escapeHtml(text);
        if (tok > 0) {
          const compRate = estimateToolCompressRate(toolName, m.text || '');
          const savedTok = Math.round(tok * compRate);
          if (savedTok > 50 && tok > 200) {
            // Show compressed badge with savings
            const badge = document.createElement('span');
            badge.className = 'opt-badge saveable';
            badge.textContent = tok + ' tok (−' + formatTokens(savedTok) + ' ~' + Math.round(compRate * 100) + '%)';
            badge.title = toolName + ': RTK compression could save ~' + savedTok + ' tokens';
            line.appendChild(badge);
          } else if (tok > 1000) {
            addTokenBadge(line, tok, 'warn');
          } else {
            addTokenBadge(line, tok, 'dim');
          }
        }

      // ── Tool calls: show name ──
      } else if (m.type === 'tool_use') {
        line.textContent = prefix + text;

      // ── Assistant messages: show token cost ──
      } else if (m.role === 'assistant') {
        line.innerHTML = prefix + escapeHtml(text);
        if (tok > 0) addTokenBadge(line, tok, 'dim');

      } else {
        line.textContent = prefix + text;
      }

      line.title = m.text || '';
      actEl.appendChild(line);
    }
    requestAnimationFrame(() => { actEl.scrollTop = actEl.scrollHeight; });
  }
  autoResizePopup();
}

// ── Agent Optimization Analysis ──
// Run JS optimizer on user messages to calculate real savings

function enrichAgentOptStats(snapshot) {
  console.log('[terse-dbg] enrichAgentOptStats START');
  const optimizer = window._terseOptimizer;
  if (!optimizer) { console.log('[terse-dbg] no optimizer!'); return; }

  // Use full user messages from Rust (all history, not just recent display)
  const userMsgs = snapshot.allUserMessages || [];
  const toolUses = snapshot.allToolUses || [];
  const recentMsgs = snapshot.recentMessages || [];
  console.log('[terse-dbg] enriching: userMsgs=' + userMsgs.length + ' toolUses=' + toolUses.length);

  let totalUserTokens = 0;
  let potentialSavings = 0;
  let optimizedCount = 0;
  let totalMessages = 0;
  const techniqueCounts = {};
  const recentOptimizations = [];

  // Also analyze tool results for bloat
  let toolResultTokens = 0;
  let toolResultWaste = 0;

  // Detect redundant tool calls
  const toolCallMap = {};
  const redundantTools = [];

  // Detect context duplication (similar messages)
  const userTexts = [];
  const dedupAlerts = [];

  // Analyze user messages with optimizer (limit to last 30 to avoid freezing)
  const _t0 = performance.now();
  const limitedMsgs = userMsgs.slice(-30);
  for (const m of limitedMsgs) {
    const text = m.text || '';
    if (text.length < 10) continue;
    totalMessages++;

    const result = optimizer.optimize(text);
    const origTok = result.stats.originalTokens;
    const optTok = result.stats.optimizedTokens;
    const saved = origTok - optTok;
    totalUserTokens += origTok;

    if (saved > 0) {
      potentialSavings += saved;
      optimizedCount++;
      for (const t of (result.stats.techniquesApplied || [])) {
        techniqueCounts[t] = (techniqueCounts[t] || 0) + saved;
      }
    }
  }

  // Also annotate recentMessages so the activity log can show per-message savings
  let annotated = 0;
  for (const m of recentMsgs) {
    if (m.role === 'user' && m.type !== 'tool_result' && (m.text || '').length > 10) {
      try {
        const result = optimizer.optimize(m.text);
        m._optSaved = (result.stats.originalTokens || 0) - (result.stats.optimizedTokens || 0);
        m._optPct = result.stats.percentSaved || 0;
        m._optText = result.optimized || '';
        m._optTechniques = result.stats.techniquesApplied || [];
        m._optChanged = result.optimized !== m.text; // text changed even if token count same
        if (m._optSaved > 0 || m._optChanged) annotated++;
      } catch(e) {}
    }
  }
  console.log('[terse-dbg] enrichment done in ' + Math.round(performance.now() - _t0) + 'ms, ' + annotated + '/' + recentMsgs.length + ' msgs have savings');

  // Analyze tool uses for redundancy and bloat (RTK-style per-tool compression rates)
  for (const t of toolUses) {
    if (t.type === 'tool_result') {
      const tok = t.tokens || estimateTokensJS(t.text || '');
      toolResultTokens += tok;
      if (tok > 500) {
        // Use RTK-style per-tool compression rates matching backend heuristics
        const rate = estimateToolCompressRate(t.toolName, t.text || '');
        toolResultWaste += Math.round(tok * rate);
      }
    }
    if (t.type === 'tool_use' && t.toolName) {
      toolCallMap[t.toolName] = (toolCallMap[t.toolName] || 0) + 1;
    }
  }

  // Build redundant tool alerts (tools called 3+ times)
  for (const [name, count] of Object.entries(toolCallMap)) {
    if (count >= 3) {
      redundantTools.push({ name, count });
    }
  }

  // Sort techniques by tokens saved
  const topTechniques = Object.entries(techniqueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, tokensSaved]) => ({ name, tokensSaved }));

  // Write back enriched stats into snapshot
  snapshot.optimizationStats = {
    totalUserTokens,
    potentialSavings,
    optimizedMessages: optimizedCount,
    totalMessages,
    topTechniques,
    recentOptimizations: recentOptimizations.slice(-3),
  };

  // Add tool result analysis — prefer backend's RTK-style compressible estimate if available
  const backendCompressible = (snapshot.toolResultStats || {}).compressibleTokens || 0;
  const effectiveToolWaste = backendCompressible > 0 ? backendCompressible : toolResultWaste;
  snapshot.totalWastedTokens = potentialSavings + effectiveToolWaste;
  snapshot.contextDedupAlerts = dedupAlerts.slice(-3);
  snapshot.redundantToolCalls = redundantTools.sort((a, b) => b.count - a.count).slice(0, 5);

  // Calculate conversation bloat percentage
  const totalConv = (snapshot.totalInputTokens || 0) + (snapshot.totalOutputTokens || 0);
  if (totalConv > 0) {
    snapshot.conversationBloat = Math.round(((potentialSavings + toolResultWaste) / totalConv) * 100);
  }
}

// ── Generate CLAUDE.md Suggestions ──

function generateClaudeMdSuggestions(snapshot) {
  const rules = [];
  const rereads = snapshot.redundantReads || [];
  const largeResults = snapshot.largeToolResults || [];
  const ctxFill = snapshot.contextFill || 0;
  const bd = snapshot.tokenBreakdown || {};
  const bdTotal = (bd.user || 0) + (bd.assistant || 0) + (bd.tool || 0) || 1;
  const toolPct = Math.round((bd.tool || 0) / bdTotal * 100);

  if (rereads.length > 0) {
    rules.push('- Do not re-read files already in context. Track which files have been read and reference them from memory.');
  }
  if (largeResults.length > 0) {
    rules.push('- Use offset/limit when reading files and head_limit for search results. Avoid reading entire files when only a section is needed.');
  }
  if (ctxFill > 60) {
    rules.push('- Be concise. Avoid restating the user\'s question or summarizing what was already said.');
  }
  if (toolPct > 50) {
    rules.push('- Summarize long tool outputs before presenting them. Extract only the relevant lines or data points.');
  }
  rules.push('- Keep responses focused and avoid filler phrases. Get straight to the answer or action.');

  const tm = snapshot.toolManagement || {};
  if (tm.unusedEstimate > 3) {
    rules.push('- Only request tools you will actually use. Avoid loading unnecessary tool definitions.');
  }

  const tcp = snapshot.toolCachePotential || {};
  if (tcp.duplicateCalls > 0) {
    rules.push('- Cache tool results locally. Do not make the same tool call twice in one session.');
  }

  let md = '# Agent Optimization Rules\n\n';
  md += '# Generated by Terse based on observed session patterns\n\n';
  md += rules.join('\n') + '\n';
  return md;
}

// Simple text similarity (Jaccard on word trigrams)
function textSimilarity(a, b) {
  const trigrams = s => {
    const words = s.toLowerCase().split(/\s+/);
    const set = new Set();
    for (let i = 0; i <= words.length - 3; i++) {
      set.add(words.slice(i, i + 3).join(' '));
    }
    return set;
  };
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) { if (sb.has(t)) intersection++; }
  return (intersection / Math.min(sa.size, sb.size)) * 100;
}

function estimateTokensJS(text) {
  const words = text.split(/\s+/).length;
  const punct = (text.match(/[^\w\s]/g) || []).length;
  return Math.ceil(words * 1.3 + punct * 0.5);
}

// RTK-style per-tool compression rate estimation (mirrors backend heuristics)
function estimateToolCompressRate(toolName, text) {
  const name = (toolName || '').toLowerCase();
  if (name === 'bash') {
    // Git output: 85% compressible
    if (/modified:|Changes not staged|On branch|diff --git|commit .+Author:/.test(text)) return 0.85;
    // Test output: 90%
    if (/PASS|FAIL|test result:|Tests:|passed.*failed/.test(text)) return 0.90;
    // Build output: 80%
    if (/Compiling|warning\[|error\[|BUILD|webpack|tsc/.test(text)) return 0.80;
    // JSON output: 85%
    if (/^\s*[\[{]/.test(text)) return 0.85;
    // Stack traces: 70%
    const stackFrames = (text.match(/^\s+at /gm) || []).length;
    if (stackFrames > 3) return 0.70;
    return 0.35;
  }
  if (name === 'read' || name === 'read_file') {
    const lines = text.split('\n');
    const comments = lines.filter(l => /^\s*(\/\/|#|\/\*|\*)/.test(l)).length;
    const blanks = lines.filter(l => !l.trim()).length;
    const overhead = (comments + blanks) / (lines.length || 1);
    const sizeFactor = lines.length > 500 ? 0.70 : lines.length > 200 ? 0.55 : lines.length > 50 ? 0.45 : 0.30;
    return Math.min(overhead * 0.8 + sizeFactor * 0.6, 0.90);
  }
  if (name === 'grep' || name === 'rg') return 0.45;
  if (name === 'glob' || name === 'find') return 0.55;
  if (name === 'webfetch' || name === 'websearch') return 0.35;
  if (name === 'agent') return 0.25;
  return 0.20;
}

// Helper: add token count badge to a log line
function addTokenBadge(line, tokens, style) {
  const badge = document.createElement('span');
  badge.className = 'tok-badge ' + style;
  badge.textContent = formatTokens(tokens);
  line.appendChild(badge);
}

// Details toggle
document.getElementById('btnAgentDetails').addEventListener('click', () => {
  const panel = document.getElementById('agentDetailsPanel');
  const btn = document.getElementById('btnAgentDetails');
  panel.classList.toggle('hidden');
  btn.classList.toggle('open');
  autoResizePopup();
});

// Agent event listeners — show banner, let user click Connect
T.on('agent-detected', async (info) => {
  console.log('[terse-dbg] agent-detected event:', info.type, 'activeAgentType:', activeAgentType);
  if (activeAgentType) return; // already connected to one
  showAgentBanner(info);
});

T.on('agent-lost', (info) => {
  if (activeAgentType === info.type) {
    hideAgentPanel();
    document.getElementById('agentPanelStatus').textContent = 'Disconnected';
  }
  hideAgentBanner();
});

T.on('agent-connected', (data) => {
  console.log('[terse-dbg] agent-connected event:', data?.session?.agentType);
  showAgentPanel(data.session);
});

T.on('agent-disconnected', () => {
  hideAgentPanel();
});

T.on('agent-update', (data) => {
  console.log('[terse-dbg] agent-update received:', data?.agentType, 'activeAgentType:', activeAgentType, 'has session:', !!data?.session);
  if (data.session && activeAgentType === data.agentType) {
    console.log('[terse-dbg] updating agent panel with', data.session.totalMessages, 'messages');
    try { enrichAgentOptStats(data.session); } catch(e) { console.error('[terse-dbg] enrichAgentOptStats error:', e); }
    try { updateAgentPanel(data.session); } catch(e) { console.error('[terse-dbg] updateAgentPanel error:', e); }
    autoResizePopup();
  }
});

// Accept / dismiss buttons
document.getElementById('btnAgentAccept').addEventListener('click', async () => {
  const type = document.getElementById('agentBanner').dataset.agentType;
  if (!type) return;
  const btn = document.getElementById('btnAgentAccept');
  btn.textContent = 'Connecting...';
  btn.disabled = true;
  try {
    const session = await T.acceptAgent(type);
    if (session) {
      showAgentPanel(session);
    } else {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Connect'; btn.disabled = false; }, 2000);
    }
  } catch {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Connect'; btn.disabled = false; }, 2000);
  }
});

document.getElementById('btnAgentDismiss').addEventListener('click', () => {
  const type = document.getElementById('agentBanner').dataset.agentType;
  if (type) T.dismissAgent(type);
  hideAgentBanner();
});

document.getElementById('btnAgentDisconnect').addEventListener('click', () => {
  if (activeAgentType) T.disconnectAgent(activeAgentType);
  hideAgentPanel();
});

// Check for already-connected sessions on load
// Reset state from previous app run (WebView may cache JS state)
activeAgentType = null;
agentPanelVisible = false;
document.getElementById('agentPanel').classList.add('hidden');

console.log('[terse-dbg] popup.js loaded, checking agent sessions...');
T.getAgentSessions().then(sessions => {
  console.log('[terse-dbg] getAgentSessions returned:', sessions.length, 'sessions');
  if (sessions.length > 0) {
    console.log('[terse-dbg] showing agent panel from getAgentSessions');
    showAgentPanel(sessions[0]);
    return;
  }
  // No connected sessions — show banner if agent detected, let user click Connect
  async function checkForAgents(attempts) {
    for (let i = 0; i < attempts; i++) {
      const detections = await T.getAgentDetections();
      console.log('[terse-dbg] getAgentDetections attempt ' + (i+1) + ':', detections.length);
      if (detections.length > 0) {
        showAgentBanner(detections[0]);
        return;
      }
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 3000));
    }
  }
  checkForAgents(5);
});

// Install Terse Bridge extension
document.getElementById('btnInstallBridge').addEventListener('click', async () => {
  const btn = document.getElementById('btnInstallBridge');
  btn.textContent = 'Installing...';
  btn.disabled = true;
  try {
    const result = await T.installBridge();
    if (result && result.ok) {
      btn.textContent = 'Installed! Restart VS Code';
      btn.classList.add('success');
      document.getElementById('bridgeInstall').querySelector('.bridge-msg').innerHTML =
        '<b>Terse Bridge</b> installed. Restart VS Code to activate.';
    } else {
      btn.textContent = 'Failed — retry';
      btn.classList.add('error');
      btn.disabled = false;
      setTimeout(() => { btn.classList.remove('error'); btn.textContent = 'Install Extension'; }, 3000);
    }
  } catch (e) {
    btn.textContent = 'Error — retry';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Install Extension'; }, 3000);
  }
});
