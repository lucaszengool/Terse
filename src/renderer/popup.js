const T = window.terse;

let hasContent = false;
let autoMode = 'off';
let minimized = false;

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Auto-resize textarea and window to fit content
function autoResizePopup() {
  if (minimized) return;
  const ta = document.getElementById('optimized');
  if (ta.classList.contains('hidden')) return;
  // Reset height to measure scrollHeight
  ta.style.height = 'auto';
  const contentH = Math.min(Math.max(ta.scrollHeight, 44), 300);
  ta.style.height = contentH + 'px';
  // Measure full body and tell main process
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
  hasContent = true;
  document.getElementById('hintState').classList.add('hidden');
  document.getElementById('bridgeInstall').classList.add('hidden');
  document.getElementById('optimized').classList.remove('hidden');

  document.getElementById('appLabel').textContent = d.app || 'Connected';
  document.getElementById('tokBefore').textContent = d.stats.originalTokens.toLocaleString();
  document.getElementById('tokAfter').textContent = d.stats.optimizedTokens.toLocaleString();
  const pct = d.stats.percentSaved;
  document.getElementById('tokPct').textContent = pct > 0 ? '-' + pct + '%' : '';

  const tc = document.getElementById('techniques');
  tc.innerHTML = '';
  (d.stats.techniquesApplied || []).forEach(t => {
    const s = document.createElement('span');
    s.className = 'technique-tag';
    s.textContent = t;
    tc.appendChild(s);
  });

  document.getElementById('optimized').value = d.optimized;
  document.getElementById('btnReplace').disabled = false;
  autoResizePopup();
});

T.on('popup-show', d => {
  document.getElementById('appLabel').textContent = d.app || 'Connected';
  if (!hasContent) {
    document.getElementById('hintState').classList.remove('hidden');
    document.getElementById('optimized').classList.add('hidden');
    document.getElementById('btnReplace').disabled = true;
  }
  // Show agent panel only when the active session's app has an agent connected
  const panel = document.getElementById('agentPanel');
  if (d.hasAgent && activeAgentType) {
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
  autoResizePopup();
});

T.on('popup-hide', () => {
  hasContent = false;
});

T.on('popup-hint', d => {
  if (hasContent || activeAgentType) return;
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
  // Don't show hint or resize if agent panel is active
  if (activeAgentType) return;
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
  activeAgentType = snapshot.agentType;
  const panel = document.getElementById('agentPanel');
  document.getElementById('agentPanelIcon').textContent = snapshot.agentIcon || '';
  document.getElementById('agentPanelName').textContent = snapshot.agentName;
  document.getElementById('agentPanelStatus').textContent = 'Monitoring';
  panel.classList.remove('hidden');
  hideAgentBanner();
  updateAgentPanel(snapshot);
  autoResizePopup();
}

function hideAgentPanel() {
  activeAgentType = null;
  document.getElementById('agentPanel').classList.add('hidden');
  autoResizePopup();
}

function updateAgentPanel(snapshot) {
  document.getElementById('agentTurns').textContent = snapshot.turns || '0';
  document.getElementById('agentInputTok').textContent = formatTokens(snapshot.totalInputTokens || 0);
  document.getElementById('agentOutputTok').textContent = formatTokens(snapshot.totalOutputTokens || 0);
  document.getElementById('agentCost').textContent = '$' + (snapshot.estimatedCost || 0).toFixed(3);
  document.getElementById('agentToolCount').textContent = (snapshot.toolCallCount || 0) + ' calls';

  // Optimization stats
  const opt = snapshot.optimizationStats;
  if (opt && opt.totalMessages > 0) {
    if (opt.potentialSavings > 0) {
      document.getElementById('agentOptSavings').textContent =
        `${formatTokens(opt.potentialSavings)} tokens (${opt.percentSavings}%) from ${opt.optimizedMessages}/${opt.totalMessages} msgs`;

      // Show technique breakdown
      const breakdownEl = document.getElementById('agentOptBreakdown');
      const techEl = document.getElementById('agentOptTechniques');
      if (opt.topTechniques && opt.topTechniques.length > 0) {
        breakdownEl.classList.remove('hidden');
        techEl.innerHTML = '';
        for (const t of opt.topTechniques) {
          const tag = document.createElement('span');
          tag.className = 'agent-opt-tech-tag';
          tag.innerHTML = t.name +
            '<span class="tag-count">x' + t.count + '</span>' +
            '<span class="tag-saved">-' + formatTokens(t.tokensSaved) + '</span>';
          techEl.appendChild(tag);
        }
      }

      // Show recent per-message optimizations
      const recentEl = document.getElementById('agentOptRecent');
      if (opt.recentOptimizations && opt.recentOptimizations.length > 0) {
        recentEl.classList.remove('hidden');
        recentEl.innerHTML = '';
        for (const m of opt.recentOptimizations) {
          if (m.saved <= 0) continue;
          const div = document.createElement('div');
          div.className = 'agent-opt-msg';
          div.innerHTML =
            '<div class="agent-opt-msg-header">' +
              '<span class="agent-opt-msg-tokens">' + m.originalTokens + ' → ' + m.optimizedTokens +
                ' <span class="saved">(-' + m.saved + ', ' + m.percent + '%)</span></span>' +
            '</div>' +
            '<div class="agent-opt-msg-before">' + escapeHtml(m.original) + '</div>' +
            '<div class="agent-opt-msg-after">' + escapeHtml(m.optimized) + '</div>';
          recentEl.appendChild(div);
        }
      }
    } else {
      document.getElementById('agentOptSavings').textContent =
        'No savings found (' + opt.totalMessages + ' msgs analyzed)';
      document.getElementById('agentOptBreakdown').classList.add('hidden');
      document.getElementById('agentOptRecent').classList.add('hidden');
    }
  } else {
    document.getElementById('agentOptSavings').textContent = 'Waiting for user messages...';
  }

  // Activity feed — show last few messages
  const actEl = document.getElementById('agentActivity');
  const msgs = snapshot.recentMessages || [];
  const lastFew = msgs.slice(-5);
  actEl.innerHTML = '';
  for (const m of lastFew) {
    const line = document.createElement('div');
    line.className = 'agent-activity-line ' + (m.role || '');
    const prefix = m.type === 'tool_use' ? '[tool] ' : m.type === 'tool_result' ? '[result] ' :
                   m.role === 'user' ? '[you] ' : m.role === 'assistant' ? '[agent] ' : '';
    line.textContent = prefix + (m.text || '').substring(0, 80);
    actEl.appendChild(line);
  }
  actEl.scrollTop = actEl.scrollHeight;
}

// Agent event listeners
T.on('agent-detected', (info) => {
  if (!activeAgentType) showAgentBanner(info);
});

T.on('agent-lost', (info) => {
  if (activeAgentType === info.type) {
    hideAgentPanel();
    document.getElementById('agentPanelStatus').textContent = 'Disconnected';
  }
  hideAgentBanner();
});

T.on('agent-connected', (data) => {
  showAgentPanel(data.session);
});

T.on('agent-disconnected', () => {
  hideAgentPanel();
});

T.on('agent-update', (data) => {
  if (data.session && activeAgentType === data.agentType) {
    updateAgentPanel(data.session);
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
T.getAgentSessions().then(sessions => {
  if (sessions.length > 0) {
    showAgentPanel(sessions[0]);
    return;
  }
  // No connected sessions — check for pending detections and auto-connect
  T.getAgentDetections().then(async detections => {
    if (detections.length > 0 && !activeAgentType) {
      // Auto-connect to detected agent (skip banner)
      const det = detections[0];
      const session = await T.acceptAgent(det.type);
      if (session) {
        showAgentPanel(session);
      } else {
        showAgentBanner(det);
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
