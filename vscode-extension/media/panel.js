// WebView frontend — runs inside VS Code WebView (browser context, no Node)
// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

let state = {
  auth: null,
  license: null,
  mode: 'normal',
  autoMode: false,
  inputText: '',
  outputText: '',
  stats: null,
  techniques: [],
  agents: {},   // agentId → snapshot
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const authGate = $('authGate');
const mainEl = $('main');
const upgradeGate = $('upgradeGate');

const inputText = $('inputText');
const outputText = $('outputText');
const outputSection = $('outputSection');
const errorBox = $('errorBox');
const inputTokens = $('inputTokens');
const statsBadge = $('statsBadge');
const techniquesList = $('techniquesList');
const planBadge = $('planBadge');
const quotaLabel = $('quotaLabel');
const upgradeLink = $('upgradeLink');
const btnManageSub = $('btnManageSub');
const userLabel = $('userLabel');
const modeTabs = $('modeTabs');
const autoToggle = $('autoToggle');

// ── Init ──────────────────────────────────────────────────────────────────

vscode.postMessage({ type: 'getState' });
vscode.postMessage({ type: 'agentGetAll' });

// ── Message handler ───────────────────────────────────────────────────────

window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      state.auth = msg.auth;
      state.license = msg.license;
      state.mode = msg.mode || 'normal';
      state.autoMode = msg.autoMode || false;
      applyState();
      break;
    case 'selection':
      if (msg.text) {
        inputText.value = msg.text;
        state.inputText = msg.text;
        updateInputTokens();
        clearOutput();
      }
      break;
    case 'capture':
      if (msg.text) {
        inputText.value = msg.text;
        state.inputText = msg.text;
        updateInputTokens();
        clearOutput();
      } else {
        showError('No selection found. Select text in the editor first.');
      }
      break;
    case 'optimizeResult':
      handleResult(msg.result);
      break;
    case 'authChanged':
      state.auth = msg.auth;
      state.license = msg.license;
      applyState();
      break;
    case 'licenseChanged':
      state.license = msg.license;
      renderPlan();
      break;
    case 'upgradeRequired':
      show(upgradeGate);
      hide(mainEl);
      hide(authGate);
      break;
    case 'error':
      showError(msg.error);
      break;
    case 'agentDetected':
      state.agents[msg.agent.id] = msg.agent.snapshot || { agentId: msg.agent.id, agentName: msg.agent.name, agentIcon: msg.agent.icon, status: 'detected' };
      renderAgents();
      break;
    case 'agentUpdate':
      if (msg.snapshot?.agentId) {
        state.agents[msg.snapshot.agentId] = msg.snapshot;
        renderAgents();
      }
      break;
    case 'agentLost':
      delete state.agents[msg.agentId];
      renderAgents();
      break;
    case 'hooksInstalled':
      document.querySelectorAll('.install-hooks-btn').forEach(b => {
        b.textContent = msg.ok ? '✓ Hooks installed' : '✗ Failed';
        b.disabled = true;
      });
      break;
  }
});

// ── Event handlers ────────────────────────────────────────────────────────

$('btnSignin').addEventListener('click', () => {
  vscode.postMessage({ type: 'signin', action: 'signin' });
});

$('btnSignout').addEventListener('click', () => {
  vscode.postMessage({ type: 'signout' });
});

$('btnSubscribePro').addEventListener('click', () => {
  vscode.postMessage({ type: 'checkout', tier: 'pro' });
});

$('btnSubscribeWechat').addEventListener('click', () => {
  vscode.postMessage({ type: 'checkout', tier: 'pro', paymentMethod: 'wechat_pay' });
});

$('btnSubscribeAlipay').addEventListener('click', () => {
  vscode.postMessage({ type: 'checkout', tier: 'pro', paymentMethod: 'alipay' });
});

$('btnBackFromUpgrade').addEventListener('click', () => {
  hide(upgradeGate);
  if (state.auth?.signedIn) show(mainEl);
  else show(authGate);
});

upgradeLink.addEventListener('click', e => {
  e.preventDefault();
  vscode.postMessage({ type: 'upgrade' });
});

btnManageSub.addEventListener('click', () => {
  vscode.postMessage({ type: 'manageSub' });
});

$('btnOptimize').addEventListener('click', () => {
  const text = inputText.value.trim();
  if (!text) return showError('Enter some text to optimize.');
  clearOutput();
  hideError();
  vscode.postMessage({ type: 'optimize', text, mode: state.mode });
  $('btnOptimize').textContent = 'Optimizing…';
  $('btnOptimize').disabled = true;
});

$('btnCapture').addEventListener('click', () => {
  vscode.postMessage({ type: 'capture' });
});

$('btnReplace').addEventListener('click', () => {
  if (state.outputText) vscode.postMessage({ type: 'replace', text: state.outputText });
});

$('btnCopy').addEventListener('click', () => {
  if (state.outputText) vscode.postMessage({ type: 'copy', text: state.outputText });
});

modeTabs.addEventListener('click', e => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  modeTabs.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t === btn));
  vscode.postMessage({ type: 'setMode', mode: state.mode });
});

autoToggle.addEventListener('change', () => {
  state.autoMode = autoToggle.checked;
  vscode.postMessage({ type: 'toggleAuto', enabled: state.autoMode });
});

inputText.addEventListener('input', updateInputTokens);

// ── Render helpers ────────────────────────────────────────────────────────

function applyState() {
  if (!state.auth?.signedIn) {
    show(authGate); hide(mainEl); hide(upgradeGate);
    return;
  }
  hide(authGate); hide(upgradeGate); show(mainEl);

  // Mode tabs
  modeTabs.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === state.mode);
  });

  // Auto toggle
  autoToggle.checked = state.autoMode;

  // User label
  userLabel.textContent = state.auth.email || state.auth.firstName || '';

  renderPlan();
}

function renderPlan() {
  const lic = state.license;
  if (!lic) { planBadge.textContent = '—'; return; }

  const tier = (lic.tier || 'none').toLowerCase();
  const status = (lic.status || '').toLowerCase();

  let badgeText = 'Free Trial';
  let badgeCls = 'plan-badge';
  if (tier === 'premium') { badgeText = 'Premium'; badgeCls = 'plan-badge premium'; }
  else if (tier === 'pro') { badgeText = 'Pro'; badgeCls = 'plan-badge pro'; }
  else if (status === 'trialing') { badgeText = 'Trial'; badgeCls = 'plan-badge trial'; }
  else if (tier === 'none' || tier === 'expired') { badgeText = 'Expired'; badgeCls = 'plan-badge expired'; }

  planBadge.textContent = badgeText;
  planBadge.className = badgeCls;

  const noActivePlan = tier === 'none' || tier === 'expired' || status === 'cancelled';

  if (noActivePlan) {
    quotaLabel.textContent = '—';
    upgradeLink.classList.remove('hidden');
    btnManageSub.classList.add('hidden');
  } else {
    if (lic.remaining !== undefined && lic.remaining >= 0) {
      quotaLabel.textContent = `${lic.remaining} uses left this week`;
    } else {
      quotaLabel.textContent = 'Unlimited';
    }
    upgradeLink.classList.add('hidden');
    btnManageSub.classList.remove('hidden');
  }
}

function handleResult(result) {
  $('btnOptimize').textContent = 'Optimize';
  $('btnOptimize').disabled = false;

  if (!result) return;

  state.outputText = result.optimizedText || '';
  state.stats = result;
  state.techniques = result.techniquesApplied || [];

  outputText.value = state.outputText;
  show(outputSection);

  // Stats badge
  const pct = result.percentSaved || 0;
  const saved = result.tokensSaved || 0;
  statsBadge.textContent = `−${pct}% · saved ${saved} tokens`;
  statsBadge.className = 'stats-badge ' + (pct >= 20 ? 'good' : pct >= 5 ? 'ok' : '');

  // Techniques chips
  techniquesList.innerHTML = '';
  if (state.techniques.length) {
    state.techniques.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = formatTechnique(t);
      techniquesList.appendChild(chip);
    });
  }
}

function updateInputTokens() {
  const text = inputText.value;
  const tokens = estimateTokens(text);
  inputTokens.textContent = `${tokens} token${tokens !== 1 ? 's' : ''}`;
}

function estimateTokens(text) {
  if (!text) return 0;
  // CJK chars count ~0.7 tokens, others ~0.25
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0x4E00) count += 0.7;
    else count += 0.25;
  }
  return Math.max(1, Math.ceil(count));
}

function formatTechnique(t) {
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function clearOutput() {
  state.outputText = '';
  hide(outputSection);
  outputText.value = '';
  statsBadge.textContent = '';
  techniquesList.innerHTML = '';
  $('btnOptimize').textContent = 'Optimize';
  $('btnOptimize').disabled = false;
}

function showError(msg) {
  $('btnOptimize').textContent = 'Optimize';
  $('btnOptimize').disabled = false;
  errorBox.textContent = msg;
  show(errorBox);
  setTimeout(() => hide(errorBox), 5000);
}

function hideError() { hide(errorBox); }

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }

// ── Agent Monitor ─────────────────────────────────────────────────────────

const _seenMsgs = {};   // agentId → Set<fingerprint>
const _prevSnap = {};   // agentId → last snapshot (for flash-diff)

function _fmtTok(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function _fmtUSD(n) { return n >= 0.01 ? '$' + n.toFixed(2) : '$' + n.toFixed(3); }
function _fmtAge(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function renderAgents() {
  const list = $('agentList');
  const empty = $('agentEmpty');
  const countBadge = $('agentCount');
  if (!list) return;

  const agents = Object.values(state.agents);

  if (!agents.length) {
    show(empty);
    countBadge.classList.add('hidden');
    list.querySelectorAll('.agent-card').forEach(c => c.remove());
    return;
  }

  hide(empty);
  countBadge.textContent = `${agents.length} active`;
  countBadge.classList.remove('hidden');

  for (const snap of agents) {
    let card = list.querySelector(`[data-agent="${snap.agentId}"]`);
    // Recreate card if it's from an old extension version (missing new sections)
    if (card && card.dataset.cardV !== '3') {
      card.remove();
      card = null;
    }
    if (!card) {
      card = _createCard(snap);
      list.appendChild(card);
    } else {
      _updateCard(card, snap);
      _appendNewActivity(card, snap);
      _updateRichSections(card, snap);
    }
  }

  list.querySelectorAll('.agent-card').forEach(card => {
    if (!state.agents[card.dataset.agent]) {
      card.classList.add('card-fade-out');
      setTimeout(() => card.remove(), 400);
    }
  });
}

// ── Create card skeleton (once) ──────────────────────────────────────────
function _createCard(snap) {
  const card = document.createElement('div');
  card.className = 'agent-card';
  card.dataset.agent = snap.agentId;
  card.dataset.cardV = '3';  // version tag — forces recreation on extension update

  const isStub = !!snap.noSessionData;
  const modelStr = _modelShort(snap.model);

  if (isStub) {
    const cp = snap.copilotData;
    let stubBody;
    if (cp && (cp.account || cp.plan || cp.turns > 0)) {
      const planBadge = cp.plan ? `<span class="cp-plan-badge">${escHtml(cp.plan)}</span>` : '';
      const account   = cp.account ? `<span class="cp-account">${escHtml(cp.account)}</span>` : '';
      const version   = cp.version ? `<span class="cp-version">v${escHtml(cp.version)}</span>` : '';
      const turns     = cp.turns > 0 ? `<span class="cp-turns">${cp.turns} turn${cp.turns !== 1 ? 's' : ''}</span>` : '';
      const age       = cp.sessionStart ? `<span class="cp-age">since ${_fmtAge(cp.sessionStart)}</span>` : '';
      stubBody = `
        <div class="ac-no-data">
          <span class="ac-active-badge">● Active</span>
          ${planBadge}${account}${version}
        </div>
        <div class="cp-meta-row">${turns}${age}</div>`;
    } else {
      stubBody = `
        <div class="ac-no-data">
          <span class="ac-active-badge">● Active</span>
          <span class="ac-no-data-label">Session data not accessible via extension API</span>
        </div>`;
    }
    card.innerHTML = `
      <div class="ac-header">
        <span class="ac-icon">${snap.agentIcon || '🤖'}</span>
        <span class="ac-name">${escHtml(snap.agentName)}</span>
        <span class="ac-pulse"></span>
      </div>${stubBody}`;
    return card;
  }

  card.innerHTML = `
    <div class="ac-header">
      <span class="ac-icon">${snap.agentIcon || '🤖'}</span>
      <span class="ac-name">${escHtml(snap.agentName)}</span>
      ${modelStr ? `<span class="ac-model">${modelStr}</span>` : '<span class="ac-model ac-model-placeholder"></span>'}
      <span class="ac-pulse"></span>
    </div>

    ${snap.agentId === 'claude-code' ? `
    <!-- Anthropic plan & quota -->
    <div class="ac-plan-row hidden">
      <span class="ac-plan-badge"></span>
      <div class="ac-usage-bars">
        <div class="ac-usage-item hidden" data-period="short">
          <span class="ac-usage-lbl">5h</span>
          <div class="ac-ubar-bg"><div class="ac-ubar-fill"></div></div>
          <span class="ac-usage-pct">0%</span>
        </div>
        <div class="ac-usage-item hidden" data-period="long">
          <span class="ac-usage-lbl">7d</span>
          <div class="ac-ubar-bg"><div class="ac-ubar-fill"></div></div>
          <span class="ac-usage-pct">0%</span>
        </div>
      </div>
      <span class="ac-reset-timer"></span>
    </div>` : ''}

    <!-- Summary bar -->
    <div class="ac-summary-bar">
      <span class="ac-sb-item"><span class="ac-sb-lbl">Ctx</span><span class="ac-sb-ctx">0%</span></span>
      <span class="ac-sb-sep">·</span>
      <span class="ac-sb-item"><span class="ac-sb-lbl">In</span><span class="ac-sb-in">0</span></span>
      <span class="ac-sb-sep">·</span>
      <span class="ac-sb-item"><span class="ac-sb-lbl">Cache</span><span class="ac-sb-cache">0%</span></span>
      <span class="ac-sb-sep">·</span>
      <span class="ac-sb-item"><span class="ac-sb-lbl">Tools</span><span class="ac-sb-tools">0</span></span>
      <span class="ac-sb-sep">·</span>
      <span class="ac-sb-item"><span class="ac-sb-lbl">Burn</span><span class="ac-sb-burn">—</span></span>
    </div>

    <!-- Context fill -->
    <div class="ac-ctx-row">
      <div class="ac-bar"><div class="ac-fill fill-ok" style="width:0%"></div></div>
      <span class="ac-ctx-label">0 / 200K (0%)</span>
    </div>

    <!-- Token breakdown stacked bar -->
    <div class="ac-breakdown-wrap">
      <div class="ac-breakdown-bar">
        <div class="ac-bd-user"  style="width:33%"></div>
        <div class="ac-bd-asst"  style="width:34%"></div>
        <div class="ac-bd-tool"  style="width:33%"></div>
      </div>
      <div class="ac-breakdown-labels">
        <span class="ac-bd-lbl user">▪ user <span class="ac-bd-pct ac-bd-user-pct">—</span></span>
        <span class="ac-bd-lbl asst">▪ asst <span class="ac-bd-pct ac-bd-asst-pct">—</span></span>
        <span class="ac-bd-lbl tool">▪ tool <span class="ac-bd-pct ac-bd-tool-pct">—</span></span>
      </div>
    </div>

    <!-- Stats grid -->
    <div class="ac-stats-grid">
      <div class="ac-sg-item"><span class="ac-sg-val ac-sg-turns">0</span><span class="ac-sg-lbl">turns</span></div>
      <div class="ac-sg-item"><span class="ac-sg-val ac-sg-tokens">0</span><span class="ac-sg-lbl">tokens</span></div>
      <div class="ac-sg-item"><span class="ac-sg-val ac-sg-cost">—</span><span class="ac-sg-lbl">cost</span></div>
      <div class="ac-sg-item"><span class="ac-sg-val ac-sg-cache">0%</span><span class="ac-sg-lbl">cached</span></div>
    </div>

    <!-- Savings hero -->
    <div class="ac-savings-hero">
      <div class="ac-savings-row">
        <span class="ac-savings-big">0</span>
        <span class="ac-savings-label">saveable</span>
      </div>
      <div class="ac-savings-bar-wrap">
        <div class="ac-savings-bar" style="width:0%"></div>
      </div>
      <div class="ac-savings-sub"></div>
    </div>

    <!-- Insights -->
    <div class="ac-insights-wrap"></div>

    <!-- Tool consumers -->
    <div class="ac-tools-wrap hidden"></div>

    <!-- Live activity -->
    <div class="ac-log-wrap">
      <div class="ac-log-header">LIVE ACTIVITY</div>
      <div class="ac-log"></div>
    </div>

    <!-- Footer -->
    <div class="ac-footer">
      ${snap.agentId === 'claude-code' ? '<button class="btn xs ac-hooks-btn">⚙ Install Hooks</button>' : ''}
      ${snap.agentId === 'claude-code' ? '<button class="btn xs ac-claudemd-btn">Generate CLAUDE.md</button>' : ''}
    </div>
    ${snap.agentId === 'claude-code' ? '<div class="ac-claudemd-out hidden"><pre class="ac-claudemd-pre"></pre><button class="btn xs ac-claudemd-copy">Copy</button></div>' : ''}
  `;

  card.querySelector('.ac-hooks-btn')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'installClaudeHooks' })
  );

  card.querySelector('.ac-claudemd-btn')?.addEventListener('click', () => {
    const out = card.querySelector('.ac-claudemd-out');
    if (!out) return;
    if (!out.classList.contains('hidden')) { out.classList.add('hidden'); return; }
    out.querySelector('.ac-claudemd-pre').textContent = _generateClaudeMd(_prevSnap[snap.agentId] || snap);
    out.classList.remove('hidden');
  });

  card.querySelector('.ac-claudemd-copy')?.addEventListener('click', async (e) => {
    const text = card.querySelector('.ac-claudemd-pre')?.textContent || '';
    try { await navigator.clipboard.writeText(text); } catch {}
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  });

  _updateCard(card, snap);
  _appendNewActivity(card, snap);
  _updateRichSections(card, snap);
  return card;
}

// ── Plan info (Anthropic plan badge + quota bars) ─────────────────────────
function _updatePlanInfo(card, snap) {
  const row = card.querySelector('.ac-plan-row');
  if (!row) return;
  const info = snap.planInfo;
  if (!info || info.plan === 'unknown') { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');

  const badge = row.querySelector('.ac-plan-badge');
  if (badge) {
    const p = (info.rateLimitTier || info.plan || '').toLowerCase();
    let label, cls = 'ac-plan-badge';
    if (p.includes('max_20x'))     { label = 'Max 20×'; cls += ' max'; }
    else if (p.includes('max_5x')) { label = 'Max 5×';  cls += ' max'; }
    else if (p.includes('max'))    { label = 'Max';     cls += ' max'; }
    else if (p.includes('pro'))    { label = 'Pro';     cls += ' pro'; }
    else if (p.includes('free'))   { label = 'Free';    cls += ' free'; }
    else                           { label = info.plan; }
    badge.textContent = label;
    badge.className = cls;
  }

  for (const [period, data] of [['short', info.shortTerm], ['long', info.longTerm]]) {
    const item = row.querySelector(`[data-period="${period}"]`);
    if (!item) continue;
    if (!data) { item.classList.add('hidden'); continue; }
    item.classList.remove('hidden');
    const pct = Math.min(data.utilization, 100);
    const fill = item.querySelector('.ac-ubar-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'ac-ubar-fill' + (pct > 85 ? ' danger' : pct > 60 ? ' warn' : '');
    }
    const pctEl = item.querySelector('.ac-usage-pct');
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
  }

  const timer = row.querySelector('.ac-reset-timer');
  if (timer) {
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
}

// ── Update all numeric stats (in-place, no innerHTML replacement) ─────────
function _updateCard(card, snap) {
  if (snap.noSessionData) return;
  const prev = _prevSnap[snap.agentId] || {};
  const fill  = snap.contextFill || 0;
  const tokens = snap.tokens?.total || 0;
  const cache  = snap.cacheEfficiency ?? 0;
  const burn   = snap.burnRate || 0;
  const cost   = snap.costUSD;

  // Pulse on token change
  if (prev.tokens?.total !== tokens) {
    const p = card.querySelector('.ac-pulse');
    if (p) { p.classList.remove('ac-pulse-anim'); void p.offsetWidth; p.classList.add('ac-pulse-anim'); }
  }

  // Model label (may arrive after first render)
  if (snap.model) {
    const ml = card.querySelector('.ac-model');
    if (ml) { ml.textContent = _modelShort(snap.model); ml.classList.remove('ac-model-placeholder'); }
  }

  // Summary bar
  _setText(card, '.ac-sb-ctx',   fill + '%');
  _setText(card, '.ac-sb-in',    _fmtTok(snap.totalInputTokens || tokens));
  const cacheEl = card.querySelector('.ac-sb-cache');
  if (cacheEl) {
    cacheEl.textContent = cache + '%';
    cacheEl.style.color = cache >= 50 ? 'var(--success)' : cache >= 20 ? 'var(--warning)' : 'var(--error)';
  }
  _setText(card, '.ac-sb-tools', snap.toolCallCount || 0);
  _setText(card, '.ac-sb-burn',  burn ? _fmtTok(burn) + '/min' : '—');

  // Context bar + label
  const fillEl = card.querySelector('.ac-fill');
  if (fillEl) { fillEl.style.width = fill + '%'; fillEl.className = 'ac-fill ' + _fillCls(fill); }
  const ctx = snap.currentContext || tokens;
  _setText(card, '.ac-ctx-label', `${_fmtTok(ctx)} / 200K (${fill}%)`);

  // Token breakdown stacked bar
  const bd = snap.tokenBreakdown || {};
  const bdTotal = (bd.user || 0) + (bd.assistant || 0) + (bd.tool || 0) || 1;
  const uPct = Math.round((bd.user || 0) / bdTotal * 100);
  const aPct = Math.round((bd.assistant || 0) / bdTotal * 100);
  const tPct = Math.round((bd.tool || 0) / bdTotal * 100);
  const hasBreakdown = bdTotal > 1;
  _setWidth(card, '.ac-bd-user', hasBreakdown ? uPct : 33);
  _setWidth(card, '.ac-bd-asst', hasBreakdown ? aPct : 34);
  _setWidth(card, '.ac-bd-tool', hasBreakdown ? tPct : 33);
  _setText(card, '.ac-bd-user-pct', hasBreakdown ? uPct + '%' : '—');
  _setText(card, '.ac-bd-asst-pct', hasBreakdown ? aPct + '%' : '—');
  _setText(card, '.ac-bd-tool-pct', hasBreakdown ? tPct + '%' : '—');

  // Stats grid
  _setFlash(card.querySelector('.ac-sg-turns'),  String(snap.turns || 0),       prev.turns !== snap.turns);
  _setFlash(card.querySelector('.ac-sg-tokens'), _fmtTok(tokens),               prev.tokens?.total !== tokens);
  _setFlash(card.querySelector('.ac-sg-cost'),   cost != null ? _fmtUSD(cost) : '—', prev.costUSD !== cost);
  const cacheGridEl = card.querySelector('.ac-sg-cache');
  if (cacheGridEl) {
    cacheGridEl.textContent = cache + '%';
    cacheGridEl.style.color = cache >= 50 ? 'var(--success)' : cache >= 20 ? 'var(--warning)' : 'var(--error)';
  }

  // Savings hero
  const rereads  = snap.rereadWaste || 0;
  const toolComp = (snap.toolResultStats?.compressibleTokens) || 0;
  const dupWaste = (snap.toolCachePotential?.tokensWasted) || 0;
  const saveable = rereads + toolComp + dupWaste;
  const saveablePct = tokens > 0 ? Math.min(100, Math.round(saveable / tokens * 100)) : 0;
  _setFlash(card.querySelector('.ac-savings-big'), _fmtTok(saveable), prev._saveable !== saveable);
  _setWidth(card, '.ac-savings-bar', saveablePct);
  const subEl = card.querySelector('.ac-savings-sub');
  if (subEl) {
    let sub = saveable > 0 ? 'tokens saveable' : 'no savings detected yet';
    if (cost != null && snap.cacheSavingsUSD > 0.001) sub += ` · cache saved ${_fmtUSD(snap.cacheSavingsUSD)}`;
    subEl.textContent = sub;
  }

  _prevSnap[snap.agentId] = { ...snap, _saveable: saveable };
  _updatePlanInfo(card, snap);
}

// ── Append only NEW messages to live log ─────────────────────────────────
function _appendNewActivity(card, snap) {
  if (snap.noSessionData) return;
  if (!_seenMsgs[snap.agentId]) _seenMsgs[snap.agentId] = new Set();
  const seen = _seenMsgs[snap.agentId];
  const log = card.querySelector('.ac-log');
  if (!log) return;

  let appended = false;
  for (const m of (snap.messages || [])) {
    const fp = m.role + ':' + (m.text || '').slice(0, 50);
    if (seen.has(fp)) continue;
    seen.add(fp);

    const row = document.createElement('div');
    row.className = `ac-log-row ac-log-${m.role} ac-log-new`;
    const icon  = m.role === 'user' ? '▶' : m.role === 'tool' ? '⚙' : m.role === 'result' ? '◀' : '●';
    const label = m.role === 'result' ? 'result' : m.role;
    let tokBadge = '';
    if (m.tokens && m.tokens > 0) {
      const compMark = m.compressible ? ' <span class="ac-log-comp" title="compressible">▤</span>' : '';
      tokBadge = `<span class="ac-log-tok">${_fmtTok(m.tokens)}${compMark}</span>`;
    }
    row.innerHTML = `<span class="ac-log-icon">${icon}</span><span class="ac-log-role">${label}</span><span class="ac-log-text">${escHtml((m.text || '').slice(0, 100))}</span>${tokBadge}`;
    log.appendChild(row);
    appended = true;
    while (log.children.length > 60) log.removeChild(log.firstChild);
  }
  if (appended) log.scrollTop = log.scrollHeight;
}

// ── Update rich sections (insights + tool breakdown) ──────────────────────
function _updateRichSections(card, snap) {
  if (snap.noSessionData) return;

  // Insights
  const iWrap = card.querySelector('.ac-insights-wrap');
  if (iWrap) {
    const ins = snap.insights || [];
    const html = ins.slice(0, 6).map(i => {
      const icon = i.icon || (i.type === 'danger' ? '!' : i.type === 'warn' ? '⚠' : 'ℹ');
      const val  = i.value ? `<span class="ac-ins-val">${escHtml(i.value)}</span>` : '';
      return `<div class="ac-ins-row ac-ins-${i.type}"><span class="ac-ins-icon">${icon}</span><span class="ac-ins-text">${escHtml(i.text)}</span>${val}</div>`;
    }).join('');
    if (iWrap.innerHTML !== html) iWrap.innerHTML = html;
  }

  // Tool consumers
  const tWrap = card.querySelector('.ac-tools-wrap');
  if (tWrap) {
    const consumers = snap.toolTokenBreakdown || [];
    if (consumers.length > 0) {
      tWrap.classList.remove('hidden');
      const trs = snap.toolResultStats || {};
      const compPct = trs.totalTokens > 0
        ? Math.round((trs.compressibleTokens || 0) / trs.totalTokens * 100) : 0;
      const maxTok = consumers[0]?.tokens || 1;
      let html = `<div class="ac-tools-header"><span>Top tool consumers</span>${compPct > 0 ? `<span class="ac-tools-comp">${compPct}% compressible</span>` : ''}</div>`;
      for (const tc of consumers.slice(0, 5)) {
        const w = Math.max(Math.round(tc.tokens / maxTok * 100), 4);
        html += `<div class="ac-tool-row">
          <span class="ac-tool-name">${escHtml(tc.name)}<span class="ac-tool-calls"> ×${tc.calls}</span></span>
          <div class="ac-tool-bar-wrap"><div class="ac-tool-bar" style="width:${w}%"></div></div>
          <span class="ac-tool-tok">${_fmtTok(tc.tokens)}</span>
        </div>`;
      }
      if (tWrap.innerHTML !== html) tWrap.innerHTML = html;
    } else {
      tWrap.classList.add('hidden');
    }
  }
}

// ── CLAUDE.md rule generation ─────────────────────────────────────────────
function _generateClaudeMd(snap) {
  const lines = ['# CLAUDE.md — Generated by Terse', ''];
  const rereads = snap.redundantReads || [];
  const large = snap.largeToolResults || [];
  const fill = snap.contextFill || 0;
  const toolPct = (() => {
    const bd = snap.tokenBreakdown || {};
    const tot = (bd.user || 0) + (bd.assistant || 0) + (bd.tool || 0) || 1;
    return Math.round((bd.tool || 0) / tot * 100);
  })();
  const out = snap.totalOutputTokens || 0;
  const inp = snap.totalInputTokens || 1;
  const outPct = Math.round(out / inp * 100);
  const dupe = snap.toolCachePotential?.duplicateCalls || 0;

  if (rereads.length > 0) lines.push('- Do not re-read files already provided in context.');
  if (large.length > 0)   lines.push('- Use offset/limit parameters when reading large files.');
  if (fill > 60)           lines.push('- Be concise. Avoid restating context already provided.');
  if (toolPct > 60)        lines.push('- Summarize long tool outputs before presenting them.');
  if (outPct > 30)         lines.push('- Minimize output length. Do not repeat code you did not change.');
  if (dupe > 0)            lines.push('- Cache tool results locally — avoid calling the same tool repeatedly.');
  lines.push('- Preserve prompt cache: keep system prompt identical across turns.');
  lines.push('- When reading a directory tree, use glob patterns, not recursive reads.');
  return lines.join('\n');
}

// ── Helpers ──
function _fillCls(fill) { return fill >= 85 ? 'fill-danger' : fill >= 60 ? 'fill-warn' : 'fill-ok'; }
function _modelShort(m) {
  if (!m) return '';
  return m.replace('claude-', '').replace(/-202\d{5}$/,'');
}
function _setFlash(el, text, changed) {
  if (!el) return;
  if (el.textContent !== text) {
    el.textContent = text;
    if (changed) { el.classList.remove('stat-flash'); void el.offsetWidth; el.classList.add('stat-flash'); }
  }
}
function _setText(card, sel, val) {
  const el = card.querySelector(sel);
  if (el && el.textContent !== String(val)) el.textContent = String(val);
}
function _setWidth(card, sel, pct) {
  const el = card.querySelector(sel);
  if (el) el.style.width = pct + '%';
}
function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
