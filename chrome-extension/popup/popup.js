/**
 * Terse Chrome Extension — Popup Logic
 * Handles optimization UI, capture, replace, copy, settings, themes.
 */

let hasContent = false;
let autoMode = 'send';
let currentOptimized = '';
let sendCooldownUntil = 0;

// ── Helpers ──

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Send message to service worker ──

function sendBg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ── Send message to content script in active tab ──

async function sendTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: 'No active tab' };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Content script may not be loaded (e.g. chrome:// pages)
    return { error: 'Content script not available: ' + e.message };
  }
}

// ── Optimize text using local optimizer bundle ──

function optimizeText(text) {
  if (window._terseOptimizer) {
    return window._terseOptimizer.optimize(text);
  }
  return {
    optimized: text,
    stats: { originalTokens: 0, optimizedTokens: 0, percentSaved: 0, techniquesApplied: [] },
    suggestions: [],
  };
}

// ── UI Updates ──

function updateUI(data) {
  hasContent = true;
  document.getElementById('hintState').classList.add('hidden');
  document.getElementById('manualWrap').classList.add('hidden');
  document.getElementById('optimized').classList.remove('hidden');

  if (data.app) document.getElementById('appLabel').textContent = data.app;

  const stats = data.stats || {};
  document.getElementById('tokBefore').textContent = (stats.originalTokens || 0).toLocaleString();
  document.getElementById('tokAfter').textContent = (stats.optimizedTokens || 0).toLocaleString();
  const pct = stats.percentSaved || 0;
  document.getElementById('tokPct').textContent = pct > 0 ? '-' + pct + '%' : '';

  const statsRow = document.querySelector('.bar-stats-row');
  if (statsRow) statsRow.style.opacity = pct > 0 ? '1' : '0.3';

  const tc = document.getElementById('techniques');
  tc.innerHTML = '';
  if (pct > 0) {
    (stats.techniquesApplied || []).forEach(t => {
      const s = document.createElement('span');
      s.className = 'technique-tag';
      s.textContent = t;
      tc.appendChild(s);
    });
  }

  currentOptimized = data.optimized || '';
  document.getElementById('optimized').value = currentOptimized;
  document.getElementById('btnReplace').disabled = false;
}

function resetUI() {
  hasContent = false;
  currentOptimized = '';
  document.getElementById('hintState').classList.remove('hidden');
  document.getElementById('manualWrap').classList.remove('hidden');
  document.getElementById('optimized').classList.add('hidden');
  document.getElementById('optimized').value = '';
  document.getElementById('tokBefore').textContent = '0';
  document.getElementById('tokAfter').textContent = '0';
  document.getElementById('tokPct').textContent = '';
  document.getElementById('techniques').innerHTML = '';
  document.getElementById('btnReplace').disabled = true;
  document.getElementById('btnUndo').classList.add('hidden');
}

// ── Auth gate ──

function showGate(type) {
  document.getElementById('authGate').classList.remove('hidden');
  // Hide main content areas
  document.querySelector('.bar-stats-row').classList.add('hidden');
  document.getElementById('hintState').classList.add('hidden');
  document.getElementById('optimized').classList.add('hidden');
  document.getElementById('manualWrap').classList.add('hidden');
  document.querySelector('.actions').classList.add('hidden');
  document.getElementById('statsBar').classList.add('hidden');

  const titleEl = document.getElementById('gateTitle');
  const descEl = document.getElementById('gateDesc');
  const btn = document.getElementById('gateBtn');

  if (type === 'signin') {
    titleEl.textContent = 'Sign in to use Terse';
    descEl.textContent = 'Create an account and start your 30-day free trial.';
    btn.textContent = 'Sign In / Sign Up';
    btn.onclick = async () => {
      btn.textContent = 'Opening...';
      btn.disabled = true;
      await sendBg({ type: 'start-auth', action: 'signup' });
      location.reload();
    };
  } else {
    titleEl.textContent = 'Start your free trial';
    descEl.textContent = '30 days free — no charge until trial ends. Cancel anytime.';
    btn.textContent = 'Start Free Trial';
    btn.onclick = () => {
      chrome.tabs.create({ url: 'https://www.terseai.org/#pricing' });
    };
  }
}

// Returns true if user is authorized to use the extension
async function checkGate() {
  const auth = await sendBg({ type: 'get-auth' });
  if (!auth?.signedIn) {
    showGate('signin');
    return false;
  }
  const lic = await sendBg({ type: 'get-license' });
  const hasAccess = lic && (lic.status === 'active' || lic.status === 'trialing');
  if (!hasAccess) {
    showGate('trial');
    return false;
  }
  return true;
}

// ── Init: load settings, theme, stats ──

async function init() {
  // Load settings + apply theme first (before gate check so styling is correct)
  const settings = await sendBg({ type: 'get-settings' });
  if (settings) {
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === settings.aggressiveness);
    });
    autoMode = settings.autoMode || 'send';
    document.querySelectorAll('.auto-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.auto === autoMode);
    });
    if (settings.theme) {
      document.documentElement.setAttribute('data-theme', settings.theme);
      document.querySelectorAll('.theme-dot').forEach(d => {
        d.classList.toggle('active', d.dataset.t === settings.theme);
      });
    }
    if (window._terseOptimizer && window._terseOptimizer.setMode) {
      window._terseOptimizer.setMode(settings.aggressiveness);
    }
  }

  // Gate check — show sign-in or trial prompt if needed
  const authorized = await checkGate();
  if (!authorized) return;

  // Load stats
  const stats = await sendBg({ type: 'get-stats' });
  if (stats && stats.totalOptimizations > 0) {
    document.getElementById('statsBar').classList.remove('hidden');
    document.getElementById('totalSaved').textContent = formatTokens(stats.totalTokensSaved);
    document.getElementById('totalOpts').textContent = stats.totalOptimizations.toLocaleString();
  }

  // Load auth status for footer display
  const auth = await sendBg({ type: 'get-auth' });
  const authEl = document.getElementById('authStatus');
  if (auth?.signedIn) {
    authEl.textContent = auth.email || auth.firstName || 'Signed in';
  }

  // Load quota
  updateQuota();

  // Try to auto-capture from active tab
  autoCapture();
}

async function updateQuota() {
  const el = document.getElementById('popupQuota');
  try {
    const lic = await sendBg({ type: 'get-license' });
    if (lic && lic.remaining >= 0) {
      el.textContent = lic.remaining + '/' + (lic.limits?.optimizationsPerWeek || '∞') + ' left';
      el.classList.toggle('low', lic.remaining <= 10);
    } else {
      el.textContent = '';
    }
  } catch {
    el.textContent = '';
  }
}

async function autoCapture() {
  const result = await sendTab({ type: 'get-active-text' });
  if (result?.text && result.text.length >= 5) {
    const opt = optimizeText(result.text);
    updateUI({
      app: result.site || 'Page',
      original: result.text,
      optimized: opt.optimized,
      stats: opt.stats,
    });
  }
}

// ── Mode toggle ──

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await sendBg({ type: 'update-settings', settings: { aggressiveness: btn.dataset.mode } });

    // Re-configure optimizer
    if (window._terseOptimizer && window._terseOptimizer.setMode) {
      window._terseOptimizer.setMode(btn.dataset.mode);
    }

    // Re-optimize: use the current optimized textarea's original source text if available
    if (hasContent) {
      const result = await sendTab({ type: 'get-active-text' });
      const text = result?.text;
      if (text && text.length >= 3) {
        const opt = optimizeText(text);
        updateUI({ app: result.site, original: text, optimized: opt.optimized, stats: opt.stats });
      }
    }
  });
});

// ── Auto mode toggle ──

document.querySelectorAll('.auto-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.auto-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    autoMode = btn.dataset.auto;
    await sendBg({ type: 'update-settings', settings: { autoMode } });
    // Notify content script
    sendTab({ type: 'update-auto-mode', mode: autoMode });
  });
});

// ── Capture ──

document.getElementById('btnCapture').addEventListener('click', async () => {
  const btn = document.getElementById('btnCapture');
  btn.classList.add('busy');

  const result = await sendTab({ type: 'capture-selection' });
  btn.classList.remove('busy');

  if (result?.success && result.text) {
    // Optimize locally in the popup
    const opt = optimizeText(result.text);
    updateUI({
      app: result.site || 'Page',
      original: result.text,
      optimized: opt.optimized,
      stats: opt.stats,
    });

    // Record stats
    const saved = (opt.stats?.originalTokens || 0) - (opt.stats?.optimizedTokens || 0);
    if (saved > 0) {
      sendBg({
        type: 'record-optimization',
        data: {
          originalTokens: opt.stats.originalTokens,
          optimizedTokens: opt.stats.optimizedTokens,
          tokensSaved: saved,
          percentSaved: opt.stats.percentSaved,
          source: 'capture',
          site: result.site,
        },
      });
    }
  } else {
    document.getElementById('hintState').innerHTML =
      '<span style="color:#b91c1c">' + (result?.reason || result?.error || 'No text found. Select text first.') + '</span>';
  }
});

// ── Replace ──

document.getElementById('btnReplace').addEventListener('click', async () => {
  if (!currentOptimized) return;
  const btn = document.getElementById('btnReplace');
  btn.textContent = '...';
  btn.disabled = true;

  const result = await sendTab({ type: 'replace-text', text: currentOptimized });

  if (result?.success) {
    btn.innerHTML = '&#10003;';
    btn.classList.add('success');
    document.getElementById('btnUndo').classList.remove('hidden');

    // Record usage
    sendBg({ type: 'record-usage' });
    sendCooldownUntil = Date.now() + 2000;
  } else {
    btn.textContent = 'Failed';
  }

  setTimeout(() => {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Replace';
    btn.disabled = false;
    btn.classList.remove('success');
  }, 1200);
});

// ── Undo ──

document.getElementById('btnUndo').addEventListener('click', async () => {
  const result = await sendTab({ type: 'undo-replace' });
  if (result?.success) {
    document.getElementById('btnUndo').classList.add('hidden');
  }
});

// ── Copy ──

document.getElementById('btnCopy').addEventListener('click', async () => {
  const text = currentOptimized || document.getElementById('optimized').value;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback: select and copy from textarea
    const ta = document.getElementById('optimized');
    ta.select();
    document.execCommand('copy');
  }

  const btn = document.getElementById('btnCopy');
  btn.innerHTML = '&#10003;';
  setTimeout(() => {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  }, 1000);
});

// ── Manual input optimization ──

document.getElementById('manualInput').addEventListener('input', function () {
  const text = this.value.trim();
  if (text.length < 5) {
    resetUI();
    document.getElementById('manualWrap').classList.remove('hidden');
    return;
  }

  const opt = optimizeText(text);
  document.getElementById('hintState').classList.add('hidden');
  document.getElementById('optimized').classList.remove('hidden');
  document.getElementById('optimized').value = opt.optimized;
  currentOptimized = opt.optimized;

  const stats = opt.stats || {};
  document.getElementById('tokBefore').textContent = (stats.originalTokens || 0).toLocaleString();
  document.getElementById('tokAfter').textContent = (stats.optimizedTokens || 0).toLocaleString();
  const pct = stats.percentSaved || 0;
  document.getElementById('tokPct').textContent = pct > 0 ? '-' + pct + '%' : '';

  const tc = document.getElementById('techniques');
  tc.innerHTML = '';
  if (pct > 0) {
    (stats.techniquesApplied || []).forEach(t => {
      const s = document.createElement('span');
      s.className = 'technique-tag';
      s.textContent = t;
      tc.appendChild(s);
    });
  }

  // Replace button works as Copy in manual mode
  document.getElementById('btnReplace').disabled = !opt.optimized;
  hasContent = true;
});

// ── Theme picker ──

document.querySelectorAll('.theme-dot').forEach(dot => {
  dot.addEventListener('click', async () => {
    const theme = dot.dataset.t;
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.t === theme));
    await sendBg({ type: 'update-settings', settings: { theme } });
  });
});

// ── Settings button → open options page ──

document.getElementById('btnSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Listen for text changes from content script (live mode) ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'text-changed' && msg.text) {
    if (Date.now() < sendCooldownUntil) return;

    const opt = optimizeText(msg.text);
    updateUI({
      app: msg.site || 'Page',
      original: msg.text,
      optimized: opt.optimized,
      stats: opt.stats,
    });
  }
});

// ── Start ──
init();
