const T = window.terse;

let hasContent = false;
let autoMode = 'send';
let minimized = false;
let agentPanelVisible = false; // true when focused app is an agent host and panel is showing
let lastShownSessionId = null; // track which session popup is showing to reset on switch

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

// Live update from main process
T.on('popup-update', d => {
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

  // Show agent panel only if this session is the agent host
  if (activeAgentType && d.sessionId === agentHostSessionId) {
    document.getElementById('agentPanel').classList.remove('hidden');
    agentPanelVisible = true;
  } else if (activeAgentType && d.sessionId !== agentHostSessionId) {
    // Switching to a non-agent session — hide agent panel, show text capture UI
    document.getElementById('agentPanel').classList.add('hidden');
    agentPanelVisible = false;
  }
  autoResizePopup();
});

T.on('popup-hide', () => {
  hasContent = false;
  agentPanelVisible = false;
});

T.on('popup-hint', d => {
  if (hasContent || agentPanelVisible) return;
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
  // Don't show hint or resize if agent panel is showing for this app
  if (agentPanelVisible) return;
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

function showAgentPanel(snapshot) {
  console.log('[terse-dbg] showAgentPanel called, agentType:', snapshot.agentType, 'turns:', snapshot.turns);
  activeAgentType = snapshot.agentType;
  agentHostSessionId = lastShownSessionId; // remember which session hosts this agent
  agentPanelVisible = true;
  const panel = document.getElementById('agentPanel');
  document.getElementById('agentPanelIcon').textContent = snapshot.agentIcon || '';
  document.getElementById('agentPanelName').textContent = snapshot.agentName;
  document.getElementById('agentPanelStatus').textContent = 'Monitoring';
  panel.classList.remove('hidden');
  hideAgentBanner();
  try { enrichAgentOptStats(snapshot); } catch(e) { console.error('[terse] enrichAgentOptStats error:', e); }
  try { updateAgentPanel(snapshot); } catch(e) { console.error('[terse] updateAgentPanel error:', e); }
  autoResizePopup();
  // Debug: log panel dimensions after render
  requestAnimationFrame(() => {
    const p = document.getElementById('agentPanel');
    const b = document.getElementById('bar');
    console.log('[terse-dbg] showAgentPanel AFTER: panelH=' + p.offsetHeight +
      ' barH=' + b.offsetHeight + ' panelDisplay=' + getComputedStyle(p).display +
      ' panelHidden=' + p.classList.contains('hidden'));
  });
}

function hideAgentPanel() {
  activeAgentType = null;
  agentHostSessionId = null;
  document.getElementById('agentPanel').classList.add('hidden');
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
  const totalSaved = (opt.potentialSavings || 0) + autoSaved + (snapshot.rereadWaste || 0);
  const totalIn = (snapshot.totalInputTokens || 1);
  const pct = totalIn > 0 ? Math.round((totalSaved / totalIn) * 100) : 0;

  document.getElementById('agentSavedBig').textContent = formatTokens(totalSaved);
  document.getElementById('agentSaveShort').textContent = formatTokens(totalSaved);
  document.getElementById('agentSavingsPct').textContent = pct + '%';
  document.getElementById('agentSavingsBar').style.width = Math.min(pct, 100) + '%';

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
  const newKey = lastFew.map(m => (m.role || '') + (m.text || '').substring(0, 30)).join('|');
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

      // ── User messages: run optimizer, show savings badge ──
      if (m.role === 'user' && m.type !== 'tool_result' && optimizer && (m.text || '').length > 10) {
        const fullText = m.text || '';
        const result = optimizer.optimize(fullText);
        const saved = result.stats.tokensSaved || 0;
        const pctSaved = result.stats.percentSaved || 0;

        line.innerHTML = prefix + escapeHtml(text);
        if (saved > 0) {
          const badge = document.createElement('span');
          badge.className = 'opt-badge';
          badge.textContent = '-' + saved + ' (' + pctSaved + '%)';
          line.appendChild(badge);

          // Click to expand before/after
          line.style.cursor = 'pointer';
          line.addEventListener('click', () => {
            const existing = line.nextElementSibling;
            if (existing && existing.classList.contains('opt-inline-detail')) {
              existing.remove(); return;
            }
            const detail = document.createElement('div');
            detail.className = 'opt-inline-detail';
            detail.innerHTML =
              '<div class="opt-inline-before">' + escapeHtml(fullText.substring(0, 300)) + '</div>' +
              '<div class="opt-inline-after">' + escapeHtml(result.optimized.substring(0, 300)) + '</div>' +
              '<div class="opt-inline-tags">' +
              (result.stats.techniquesApplied || []).map(t =>
                '<span class="opt-inline-tag">' + t + '</span>'
              ).join('') + '</div>';
            line.after(detail);
          });
        } else {
          addTokenBadge(line, tok, 'ok');
        }

      // ── Tool results: show token cost, flag large ones ──
      } else if (m.type === 'tool_result') {
        line.innerHTML = prefix + escapeHtml(text);
        if (tok > 1000) {
          addTokenBadge(line, tok, 'warn');
        } else if (tok > 0) {
          addTokenBadge(line, tok, 'dim');
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
  const optimizer = window._terseOptimizer;
  if (!optimizer) return;

  // Use full user messages from Rust (all history, not just recent display)
  const userMsgs = snapshot.allUserMessages || [];
  const toolUses = snapshot.allToolUses || [];
  const recentMsgs = snapshot.recentMessages || [];

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

  // Analyze ALL user messages with optimizer
  for (const m of userMsgs) {
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
      recentOptimizations.push({
        original: text.substring(0, 200),
        optimized: result.optimized.substring(0, 200),
        originalTokens: origTok,
        optimizedTokens: optTok,
        saved,
        percent: result.stats.percentSaved,
      });
    }

    // Context deduplication — compare with previous user messages
    for (let i = 0; i < userTexts.length; i++) {
      const similarity = textSimilarity(text, userTexts[i].text);
      if (similarity > 70) {
        const wastedTokens = Math.min(origTok, userTexts[i].tokens);
        dedupAlerts.push({
          turnA: userTexts[i].idx + 1,
          turnB: totalMessages,
          similarity: Math.round(similarity),
          wastedTokens,
        });
      }
    }
    userTexts.push({ text, tokens: origTok, idx: totalMessages - 1 });
  }

  // Analyze tool uses for redundancy and bloat
  for (const t of toolUses) {
    if (t.type === 'tool_result') {
      const tok = t.tokens || estimateTokensJS(t.text || '');
      toolResultTokens += tok;
      if (tok > 500) {
        toolResultWaste += Math.round(tok * 0.3);
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

  // Add tool result analysis
  snapshot.totalWastedTokens = potentialSavings + toolResultWaste;
  snapshot.contextDedupAlerts = dedupAlerts.slice(-3);
  snapshot.redundantToolCalls = redundantTools.sort((a, b) => b.count - a.count).slice(0, 5);

  // Calculate conversation bloat percentage
  const totalConv = (snapshot.totalInputTokens || 0) + (snapshot.totalOutputTokens || 0);
  if (totalConv > 0) {
    snapshot.conversationBloat = Math.round(((potentialSavings + toolResultWaste) / totalConv) * 100);
  }
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

// Agent event listeners — auto-connect when detected
T.on('agent-detected', async (info) => {
  console.log('[terse-dbg] agent-detected event:', info.type, 'activeAgentType:', activeAgentType);
  if (activeAgentType) return;
  console.log('[terse] agent-detected, auto-connecting:', info.type);
  try {
    const session = await T.acceptAgent(info.type);
    console.log('[terse] acceptAgent result:', !!session);
    if (session) {
      showAgentPanel(session);
    } else {
      showAgentBanner(info); // fallback to manual connect
    }
  } catch (e) {
    console.error('[terse] auto-connect failed:', e);
    showAgentBanner(info);
  }
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
  if (data.session && activeAgentType === data.agentType) {
    try { enrichAgentOptStats(data.session); } catch(e) { console.error('[terse] enrich error:', e); }
    try { updateAgentPanel(data.session); } catch(e) { console.error('[terse] update error:', e); }
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
  // No connected sessions — auto-connect to first pending detection
  T.getAgentDetections().then(async (detections) => {
    console.log('[terse-dbg] getAgentDetections returned:', detections.length, 'detections');
    if (detections.length > 0) {
      console.log('[terse] auto-connecting to detected agent on load:', detections[0].type);
      try {
        const session = await T.acceptAgent(detections[0].type);
        console.log('[terse-dbg] acceptAgent result:', !!session);
        if (session) {
          showAgentPanel(session);
        } else {
          showAgentBanner(detections[0]);
        }
      } catch (e) {
        console.error('[terse] auto-connect on load failed:', e);
        showAgentBanner(detections[0]);
      }
    }
  });
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
