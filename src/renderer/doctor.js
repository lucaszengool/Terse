// Terse Doctor (体检) — health scanner UI driver.
// FREE: scanning + viewing the full report. GATED: only remediation (T.doctorApplyFix).
(function () {
  'use strict';

  const T = window.terse || window.T || {};

  const UPGRADE_URL = 'https://www.terseai.org/pricing';
  const SIGNIN_URL = 'https://www.terseai.org/sign-in';

  // ---- tiny DOM helpers ---------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function fmtUSD(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '$0';
    if (v < 0.01) return '<$0.01';
    if (v < 1) return '$' + v.toFixed(2);
    if (v < 100) return '$' + v.toFixed(2);
    return '$' + Math.round(v).toLocaleString();
  }
  function fmtBytes(b) {
    const v = Number(b) || 0;
    if (v <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = v;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    const dec = n < 10 && i > 0 ? 1 : 0;
    return n.toFixed(dec) + ' ' + u[i];
  }
  function fmtTokens(t) {
    const v = Number(t) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M tokens';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K tokens';
    return v.toLocaleString() + ' tokens';
  }

  // ---- state --------------------------------------------------------------
  let lastReport = null;
  let scanning = false;
  let lastFindings = []; // localized findings in render order (for the theater)
  const cardEls = {}; // findingId -> { card, checkbox, finding }

  // ---- toast --------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3200);
  }

  // ---- gauge --------------------------------------------------------------
  function gaugeColor(score) {
    if (score >= 75) return 'var(--ac)';
    if (score >= 60) return '#FF9800';
    return '#F44336';
  }
  function animateGauge(score) {
    score = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    const arc = $('scoreArc');
    const num = $('scoreNum');
    const grade = $('scoreGrade');
    const color = gaugeColor(score);

    if (arc) {
      // Determine circumference from r attribute (fallback 2*pi*52).
      let r = parseFloat(arc.getAttribute('r'));
      if (!r || isNaN(r)) r = 52;
      const circ = 2 * Math.PI * r;
      arc.style.strokeDasharray = String(circ);
      // start empty
      arc.style.strokeDashoffset = String(circ);
      arc.style.stroke = color;
      // force reflow then animate
      void arc.getBoundingClientRect();
      arc.style.transition = 'stroke-dashoffset 1100ms cubic-bezier(.22,.85,.3,1), stroke 600ms ease';
      requestAnimationFrame(() => {
        arc.style.strokeDashoffset = String(circ * (1 - score / 100));
      });
    }
    if (grade) grade.style.color = color;
    if (num) num.style.color = color;

    // count up
    if (num) {
      const start = performance.now();
      const dur = 1000;
      function tick(now) {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        num.textContent = String(Math.round(score * eased));
        if (p < 1) requestAnimationFrame(tick);
        else num.textContent = String(score);
      }
      requestAnimationFrame(tick);
    }
  }

  // ---- scan sweep ---------------------------------------------------------
  const CATEGORIES = ['cache', 'mcp', 'loop', 'context', 'prompt', 'cost', 'config', 'junk', 'disk', 'guard', 'runtime'];
  function runSweep() {
    const status = $('scanStatus');
    const hero = $('hero');
    if (hero) hero.classList.add('scanning');
    if (status) {
      status.style.display = '';
      status.textContent = 'Scanning…';
    }
    // briefly highlight each category chip if present
    CATEGORIES.forEach((cat, i) => {
      setTimeout(() => {
        const lbl = document.querySelector('[data-cat="' + cat + '"]');
        if (lbl) {
          lbl.classList.add('scanning');
          if (status) status.textContent = 'Scanning ' + cat + '…';
          setTimeout(() => {
            lbl.classList.remove('scanning');
            lbl.classList.add('done');
          }, 320);
        }
      }, i * 240);
    });
  }
  function endSweep() {
    const status = $('scanStatus');
    const hero = $('hero');
    if (hero) hero.classList.remove('scanning');
    if (status) status.style.display = 'none';
    CATEGORIES.forEach((cat) => {
      const lbl = document.querySelector('[data-cat="' + cat + '"]');
      if (lbl) lbl.classList.remove('scanning');
    });
  }

  // ---- summary ------------------------------------------------------------
  function renderSummary(report) {
    const el = $('summaryLine');
    if (!el) return;
    const s = report.summary || {};
    const issues = Number(s.issues) || (report.findings ? report.findings.length : 0);
    const usd = fmtUSD(s.recoverableUsd);
    const junk = fmtBytes(s.junkBytes);
    el.textContent = issues + ' issue' + (issues === 1 ? '' : 's') +
      ' · ~' + usd + ' recoverable · ' + junk + ' junk';
  }

  // ---- finding metric chips ----------------------------------------------
  function metricsHTML(f) {
    // Values are emitted as data attributes and rendered at full value; the
    // .mv span is then count-up animated from 0 on reveal (see animateCard).
    const out = [];
    const usd = Number(f.usdWasted) || 0;
    const perMo = (window.doctorI18n && window.i18n && window.i18n.getLang)
      ? window.doctorI18n.tr(window.i18n.getLang(), '/mo') : '/mo';
    if (usd > 0) out.push('<span class="metric cost" data-usd="' + usd + '"><span class="mv">' + esc(fmtUSD(0)) + '</span><span class="ml">' + esc(perMo) + '</span></span>');
    const tok = Number(f.tokensWasted) || 0;
    if (tok > 0) out.push('<span class="metric" data-tok="' + tok + '"><span class="mv">' + esc(fmtTokens(0)) + '</span></span>');
    const b = Number(f.bytes) || 0;
    if (b > 0) out.push('<span class="metric" data-bytes="' + b + '"><span class="mv">' + esc(fmtBytes(0)) + '</span></span>');
    return out.join('');
  }

  // Ease a number from 0 → target, reformatting each frame (drama on $ / tokens).
  function countUp(el, target, fmt) {
    if (!el) return;
    const start = performance.now();
    const dur = 850;
    function tick(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * eased);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(target);
    }
    requestAnimationFrame(tick);
  }

  // Fill the impact heat bar and count up the metric chips for one card.
  function animateCard(card, frac) {
    if (!card) return;
    const fill = card.querySelector('.f-impact .fill');
    if (fill) {
      const w = Math.round(Math.max(0.12, Math.min(1, frac || 0)) * 100);
      requestAnimationFrame(() => { fill.style.width = w + '%'; });
    }
    card.querySelectorAll('.metric').forEach((m) => {
      const mv = m.querySelector('.mv');
      if (!mv) return;
      if (m.dataset.usd) countUp(mv, Number(m.dataset.usd), fmtUSD);
      else if (m.dataset.tok) countUp(mv, Number(m.dataset.tok), fmtTokens);
      else if (m.dataset.bytes) countUp(mv, Number(m.dataset.bytes), fmtBytes);
    });
  }

  // Build the vivid before → after demonstration shown when "How to fix" opens.
  function buildFixPreview(f) {
    const t = (k, fb) => (window.i18n && window.i18n.t) ? (window.i18n.t(k) || fb) : fb;
    const usd = Number(f.usdWasted) || 0;
    const tok = Number(f.tokensWasted) || 0;
    const bytes = Number(f.bytes) || 0;
    const save = usd > 0 ? fmtUSD(usd) + ' ' + (window.doctorI18n && window.i18n
        ? window.doctorI18n.tr(window.i18n.getLang(), '/mo') : '/mo')
      : tok > 0 ? fmtTokens(tok)
      : bytes > 0 ? fmtBytes(bytes) : '';
    // "After" bar is shorter the bigger the recoverable share — purely
    // illustrative, but it makes the gain feel concrete.
    const afterW = usd > 0 || tok > 0 || bytes > 0 ? 26 : 50;
    return '' +
      '<div class="fx-demo">' +
        '<div class="fx-row"><span class="fx-tag bad">' + esc(t('doctor_before', 'Now')) + '</span>' +
          '<div class="fx-bar"><div class="fx-bar-fill bad"></div></div></div>' +
        '<div class="fx-row"><span class="fx-tag good">' + esc(t('doctor_after', 'After fix')) + '</span>' +
          '<div class="fx-bar"><div class="fx-bar-fill good" data-w="' + afterW + '"></div></div>' +
          (save ? '<span class="fx-save">−' + esc(save) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div class="fx-detail">' + esc(f.detail || '') + '</div>';
  }

  // Run the before → after bar animation once the preview is visible.
  function animatePreview(container) {
    const good = container && container.querySelector('.fx-bar-fill.good');
    if (good) {
      const w = good.getAttribute('data-w') || '28';
      requestAnimationFrame(() => { good.style.width = w + '%'; });
    }
  }

  // ---- inline per-card preview --------------------------------------------
  // Wires the animated scene that lives inside a finding card (same page, no
  // overlay). Returns { open, close, toggle, isOpen } so the header "Preview
  // issues" button and the title click can drive it.
  let previewSeq = 0; // stagger index so cards don't flip in lockstep
  function wireInlinePreview(card, f) {
    const panel = card.querySelector('.f-preview');
    const previewBtn = card.querySelector('.preview-card-btn');
    if (!panel) return { open: function () {}, close: function () {}, toggle: function () {}, isOpen: function () { return false; } };
    const stage = panel.querySelector('.fp-stage');
    const seg = panel.querySelector('.fp-seg');
    const myIdx = previewSeq++;
    let state = 'before';
    let userToggled = false;
    let cycleTimer = null;

    function paint() {
      if (stage && window.doctorScenes && window.doctorScenes.build) {
        stage.innerHTML = window.doctorScenes.build(f.category, f, state);
      }
    }
    function setState(s, fromUser) {
      state = s === 'after' ? 'after' : 'before';
      if (fromUser) userToggled = true;
      if (seg) {
        seg.classList.toggle('after', state === 'after');
        seg.classList.toggle('before', state === 'before');
        seg.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.dataset.state === state);
        });
      }
      paint();
    }

    function stopCycle() { if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; } }
    // Continuously narrate the fix: before → after → before … so the card
    // shows BOTH the problem and the fixed state without any click. Stops the
    // moment the user drives the compare themselves.
    function scheduleNext(delay) {
      stopCycle();
      cycleTimer = setTimeout(function tick() {
        if (userToggled || !isOpen()) return;
        setState(state === 'before' ? 'after' : 'before');
        // Hold "after" a beat longer so the fix lands.
        scheduleNext(state === 'after' ? 2800 : 2200);
      }, delay);
    }

    if (seg) seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { stopCycle(); setState(b.dataset.state, true); });
    });

    function open() {
      panel.classList.add('open');
      if (previewBtn) previewBtn.classList.add('active');
      userToggled = false;
      setState('before');
      // Stagger the first flip a touch per card so the page doesn't pulse in unison.
      scheduleNext(1300 + (myIdx % 6) * 260);
    }
    function close() {
      panel.classList.remove('open');
      if (previewBtn) previewBtn.classList.remove('active');
      stopCycle();
    }
    function isOpen() { return panel.classList.contains('open'); }
    function toggle() { if (isOpen()) close(); else open(); }

    return { open: open, close: close, toggle: toggle, isOpen: isOpen };
  }

  // ---- finding card -------------------------------------------------------
  function buildCard(f) {
    const card = document.createElement('div');
    card.className = 'finding sev-' + esc(f.severity || 'low');
    card.dataset.id = f.id;

    const sev = esc(f.severity || 'low');
    const advise = f.fixKind === 'advise' || f.fixable === false;
    const selectable = f.fixable === true && !advise;
    const cat = esc(f.category || 'junk');
    const fixLabel = f.fixLabel || (advise ? 'How to fix' : 'Fix');
    const btnKind = advise ? 'advise' : (f.fixKind === 'delete' ? 'delete' : 'optimize');
    const metrics = metricsHTML(f);
    const hasWaste = (Number(f.usdWasted) || 0) > 0 || (Number(f.tokensWasted) || 0) > 0 || (Number(f.bytes) || 0) > 0;
    const arrow = advise ? '<span class="fx-arrow">→</span>' : '';

    card.innerHTML =
      '<div class="f-top">' +
        '<input type="checkbox" class="f-check' + (selectable ? '' : ' hidden') + '"' +
          (selectable ? '' : ' disabled') + ' aria-label="Select fix">' +
        '<div class="f-body">' +
          '<div class="f-headline">' +
            '<span class="sev-dot ' + sev + '" title="' + sev + '"></span>' +
            '<span class="f-title">' + esc(f.title || 'Issue') + '</span>' +
            '<span class="cat-badge ' + cat + '">' + esc(f.categoryLabel || f.category || '') + '</span>' +
          '</div>' +
          '<div class="f-detail">' + esc(f.detail || '') + '</div>' +
          (metrics ? '<div class="f-metrics">' + metrics + '</div>' : '') +
          (hasWaste ? '<div class="f-impact"><div class="track"><div class="fill"></div></div></div>' : '') +
          (f.latencyNote ? '<div class="f-latency">⏱ ' + esc(f.latencyNote) + '</div>' : '') +
          '<div class="f-preview">' +
            '<div class="fp-stage"></div>' +
            '<div class="th-seg before fp-seg">' +
              '<span class="pill"></span>' +
              '<button data-state="before" class="active" data-i18n="doctor_problem">Problem</button>' +
              '<button data-state="after" data-i18n="doctor_after_fix">After fix</button>' +
            '</div>' +
          '</div>' +
          '<div class="advise-body"></div>' +
        '</div>' +
      '</div>' +
      '<div class="f-actions">' +
        '<button class="preview-card-btn" type="button">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>' +
          '<span data-i18n="doctor_preview">Preview</span>' +
        '</button>' +
        '<button class="fix-btn ' + btnKind + '" type="button">' + esc(fixLabel) + arrow + '</button>' +
        '<button class="dismiss-link" type="button">Dismiss</button>' +
      '</div>' +
      '<div class="fix-progress" hidden>' +
        '<div class="fix-progress-track"><div class="fix-progress-fill"></div></div>' +
        '<div class="fix-progress-step"></div>' +
      '</div>';

    const adviseBody = card.querySelector('.advise-body');
    const actionBtn = card.querySelector('.fix-btn');
    const dismissBtn = card.querySelector('.dismiss-link');
    const checkbox = selectable ? card.querySelector('.f-check') : null;

    function toggleAdvise() {
      if (!adviseBody) return;
      if (!adviseBody.dataset.built) {
        adviseBody.innerHTML = buildFixPreview(f);
        adviseBody.dataset.built = '1';
      }
      adviseBody.classList.toggle('open');
      if (adviseBody.classList.contains('open')) animatePreview(adviseBody);
    }

    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        try { if (T.doctorDismiss) await T.doctorDismiss(f.id); } catch (e) { /* ignore */ }
        delete cardEls[f.id];
        card.classList.add('dismissing');
        setTimeout(() => {
          if (card.parentNode) card.parentNode.removeChild(card);
          cleanupEmptyGroups();
          updateBulkBar();
          maybeShowEmpty();
        }, 180);
      });
    }

    if (actionBtn) {
      actionBtn.addEventListener('click', async () => {
        if (advise) {
          // Collapsing an already-open tip is always free; opening the fix
          // guidance requires sign-in + an active/trialing subscription.
          if (!adviseBody || !adviseBody.classList.contains('open')) {
            const ent = await ensureEntitled();
            if (!ent.ok) {
              if (ent.reason === 'subscription') {
                // Signed in but no active/trialing plan → send them to the paywall.
                await goToPaywall();
              } else {
                openAuthModal('login', 'Sign in to see how to fix this. Your report stays free to read.');
              }
              return;
            }
          }
          toggleAdvise();
          return;
        }
        applyFinding(f, card, actionBtn);
      });
    }

    if (checkbox) {
      checkbox.addEventListener('change', updateBulkBar);
    }

    // Inline preview: the animated scene lives directly in the card, on the
    // same page — no full-window overlay. Title click and the Preview button
    // both toggle it.
    const preview = wireInlinePreview(card, f);
    const titleEl = card.querySelector('.f-title');
    if (titleEl) {
      titleEl.style.cursor = 'pointer';
      titleEl.title = 'Preview';
      titleEl.addEventListener('click', () => preview.toggle());
    }
    const previewCardBtn = card.querySelector('.preview-card-btn');
    if (previewCardBtn) previewCardBtn.addEventListener('click', () => preview.toggle());

    cardEls[f.id] = { card: card, checkbox: checkbox, finding: f, preview: preview };
    return card;
  }

  function markResolved(card, message) {
    if (!card) return;
    const f = card.dataset.id;
    if (f) delete cardEls[f];
    card.classList.add('resolved');
    const actions = card.querySelector('.f-actions');
    if (actions) actions.innerHTML = '<span class="resolved-tag">✓ ' + esc(message || 'Done') + '</span>';
    setTimeout(() => {
      if (card.parentNode) card.parentNode.removeChild(card);
      cleanupEmptyGroups();
      updateBulkBar();
      maybeShowEmpty();
    }, 1400);
  }


  // WKWebView has no native confirm() — promise-based in-page stand-in.
  function dconfirm(title, sub, okLabel) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px';
      const panel = document.createElement('div');
      panel.style.cssText = 'max-width:340px;width:100%;background:var(--bg,#111);border:1px solid var(--bdl,rgba(255,255,255,.2));border-radius:14px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.5)';
      const t = document.createElement('div');
      t.style.cssText = 'font-size:13px;font-weight:700;color:var(--t1,#fff);margin-bottom:6px';
      t.textContent = title;
      const s = document.createElement('div');
      s.style.cssText = 'font-size:11px;color:var(--t3,#aaa);line-height:1.5;margin-bottom:14px';
      s.textContent = sub || '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const mk = (label, primary) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.style.cssText = primary
          ? 'padding:8px 18px;border:none;border-radius:9999px;font-size:11px;font-weight:800;cursor:pointer;background:var(--ac,#5ea8ff);color:#06131f'
          : 'padding:8px 16px;border:1px solid var(--bd,rgba(255,255,255,.12));border-radius:9999px;font-size:11px;font-weight:600;cursor:pointer;background:transparent;color:var(--t2,#ccc)';
        return b;
      };
      const cancel = mk('Cancel', false), ok = mk(okLabel || 'Confirm', true);
      const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        if (e.key === 'Enter') { e.stopPropagation(); done(true); }
      };
      cancel.addEventListener('click', () => done(false));
      ok.addEventListener('click', () => done(true));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
      document.addEventListener('keydown', onKey, true);
      row.appendChild(cancel); row.appendChild(ok);
      panel.appendChild(t); panel.appendChild(s); panel.appendChild(row);
      ov.appendChild(panel);
      document.body.appendChild(ov);
      ok.focus();
    });
  }

  // ---- per-finding fix progress -------------------------------------------
  // Mirrors doctor.rs fix_steps_for(). A fix is usually sub-second, so the bar
  // walks the named steps on a timer and holds on the last one until the call
  // actually returns — it never claims a step finished that hasn't. The point is
  // that the user can see WHICH step a fix is on, not a featureless spinner.
  const FIX_STEPS = {
    'delete':           ['Re-checking files', 'Moving to Trash', 'Recounting space'],
    'kill-process':     ['Verifying processes', 'Sending stop signal', 'Confirming exit'],
    'mcp-disable':      ['Reading MCP config', 'Backing up config', 'Stashing idle servers', 'Verifying config'],
    'claude-md-trim':   ['Reading CLAUDE.md', 'Backing up original', 'Drafting trimmed copy', 'Opening for review'],
    'grant-permission': ['Checking permission', 'Opening System Settings'],
    'tune':             ['Reading settings', 'Applying tuning', 'Saving'],
    'optimize':         ['Reading settings', 'Applying tuning', 'Saving'],
    'open-path':        ['Locating file', 'Opening'],
    // Kinds added when every advisory finding gained a real one-click fix.
    'enable-cache':     ['Enabling cache-safe optimization'],
    'compress-context': ['Enabling compression'],
    'mcp-prune':        ['Reading MCP config', 'Disabling servers'],
    'cap-output':       ['Writing output cap'],
    'set-budget':       ['Setting monthly budget'],
    'fix-bypass':       ['Reading settings', 'Backing up', 'Switching mode'],
    'fix-permissions':  ['Reading settings', 'Backing up', 'Removing broad rules'],
    'set-cleanup-days': ['Reading settings', 'Writing retention'],
  };

  // The backend emits one `doctor-fix-progress` per real step of a running fix
  // ({id, step, total, pct, label}). Those events drive the bar; FIX_STEPS above
  // is only the opening placeholder, shown until the first event lands so the
  // card never sits blank. Crucially the bar does NOT advance on a timer — if a
  // fix is parked on a UAC consent dialog, the label says so and stays there
  // instead of animating through steps that haven't happened.
  let liveProgress = null; // { id, fill, label, wrap }

  (function bindFixProgress() {
    const handler = (ev) => {
      const d = (ev && ev.payload) ? ev.payload : ev;
      if (!d || !liveProgress || d.id !== liveProgress.id) return;
      const pct = Math.max(6, Math.min(100, Number(d.pct) || 0));
      if (liveProgress.fill) liveProgress.fill.style.width = pct + '%';
      if (liveProgress.label) {
        const n = Number(d.step) || 0, total = Number(d.total) || 0;
        liveProgress.label.textContent = (d.label || 'Working') +
          (total > 1 ? ' · ' + n + '/' + total : '');
      }
      liveProgress.gotEvent = true;
    };
    if (T && typeof T.on === 'function') { T.on('doctor-fix-progress', handler); return; }
    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('doctor-fix-progress', handler);
      }
    } catch (e) { /* no bridge (browser preview) — placeholder text is all you get */ }
  })();

  function startFixProgress(card, kind, id) {
    const steps = FIX_STEPS[kind] || ['Applying', 'Saving'];
    const wrap = card && card.querySelector('.fix-progress');
    if (!wrap) return { finish() {}, fail() {} };
    const fill = wrap.querySelector('.fix-progress-fill');
    const label = wrap.querySelector('.fix-progress-step');
    wrap.hidden = false;
    wrap.classList.remove('failed', 'done');
    if (fill) fill.style.width = '8%';
    if (label) label.textContent = steps[0] + '…';

    liveProgress = { id: id, fill: fill, label: label, wrap: wrap, gotEvent: false };
    const mine = liveProgress;
    const clear = () => { if (liveProgress === mine) liveProgress = null; };

    return {
      finish(msg) {
        clear();
        if (fill) fill.style.width = '100%';
        wrap.classList.add('done');
        if (label) label.textContent = msg || 'Done';
        setTimeout(() => { wrap.hidden = true; }, 1400);
      },
      fail(msg) {
        clear();
        wrap.classList.add('failed');
        if (label) label.textContent = msg || 'Could not apply';
        setTimeout(() => { wrap.hidden = true; wrap.classList.remove('failed'); }, 2600);
      },
    };
  }

  // ---- apply (gated) ------------------------------------------------------
  async function applyFinding(f, card, btn) {
    if (!card) {
      const ref = cardEls[f.id];
      if (ref) card = ref.card;
    }
    if (f.fixKind === 'delete') {
      const n = (f.paths && f.paths.length) || 0;
      const label = n > 0 ? n + ' junk file' + (n === 1 ? '' : 's') : 'these junk files';
      if (!(await dconfirm('Clean ' + label + '?', 'Files move to your Trash, so you can restore them if needed.', 'Clean'))) return false;
    }
    if (f.fixKind === 'kill-process') {
      const n = (f.paths && f.paths.length) || 0;
      const label = n > 0 ? n + ' agent process' + (n === 1 ? '' : 'es') : 'these agent processes';
      if (!(await dconfirm('Stop ' + label + '?', 'Transcripts stay on disk, so the sessions can be resumed.', 'Stop'))) return false;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const prog = startFixProgress(card, f.fixKind, f.id);

    let res;
    try {
      if (!T.doctorApplyFix) throw new Error('bridge unavailable');
      res = await T.doctorApplyFix(f);
    } catch (e) {
      prog.fail('Could not apply');
      if (btn) { btn.disabled = false; btn.textContent = f.fixLabel || 'Fix'; }
      showToast('Could not apply fix — please try again.');
      return false;
    }

    res = res || {};
    if (res.ok) {
      prog.finish(res.message);
      let msg = res.message || 'Fixed';
      if (res.freedBytes) msg += ' · freed ' + fmtBytes(res.freedBytes);
      else if (res.deleted) msg += ' · ' + res.deleted + ' removed';
      showToast(msg);
      markResolved(card, res.message || 'Fixed');
      return true;
    }

    // gated
    if (res.needsAuth) {
      prog.fail(res.message || 'Sign-in required');
      if (btn) { btn.disabled = false; btn.textContent = f.fixLabel || 'Fix'; }
      if ((res.reason || 'login') === 'subscription') {
        await goToPaywall();
      } else {
        openAuthModal('login', res.message);
      }
      return false;
    }

    prog.fail(res.message);
    if (btn) { btn.disabled = false; btn.textContent = f.fixLabel || 'Fix'; }
    showToast(res.message || 'Could not apply fix.');
    return false;
  }

  // ---- entitlement --------------------------------------------------------
  // Returns the label of the Tauri window this page is running in ('main' when
  // embedded, 'doctor' when standalone), or null if it can't be determined.
  function currentWindowLabel() {
    try { return window.__TAURI__.window.getCurrentWindow().label; } catch (e) { /* try next */ }
    try { return window.__TAURI__.window.getCurrent().label; } catch (e) { /* try next */ }
    try { return window.__TAURI__.webviewWindow.getCurrentWebviewWindow().label; } catch (e) { /* give up */ }
    return null;
  }

  // Gate guidance / fixes behind sign-in + an active (or trialing) subscription.
  // The scan and the report stay free; reading *how to fix* and applying fixes
  // require an account. Mirrors the backend check in doctor_apply_fix.
  // Returns { ok: true } or { ok: false, reason: 'login' | 'subscription' }.
  async function ensureEntitled() {
    let auth = null;
    try { auth = await T.getAuth(); } catch (e) { /* treat as signed out */ }
    if (!auth || !auth.signedIn) return { ok: false, reason: 'login' };
    let lic = null;
    try { lic = T.getLicense ? await T.getLicense() : null; } catch (e) { /* treat as no plan */ }
    if (lic) {
      const tier = (lic.tier || '').toLowerCase();
      const status = (lic.status || '').toLowerCase();
      const active = (status === 'active' || status === 'trialing') && tier !== 'expired' && tier !== '';
      if (!active) return { ok: false, reason: 'subscription' };
    }
    return { ok: true };
  }

  // Route a signed-in-but-unentitled user to the in-app paywall. The paywall
  // lives in the main window (index.html's init runs checkPaywall()), so we
  // bring the main window to its primary view. Works whether the Doctor is
  // embedded in the main window or running as the standalone 'doctor' window;
  // in the standalone case we also hide the Doctor so the paywall is visible.
  async function goToPaywall() {
    const standalone = currentWindowLabel() === 'doctor';
    // request_upgrade returns the main window to the app shell AND opens the
    // Pro sheet (via the #upgrade hash) — so gating actually shows the paywall
    // instead of silently navigating back.
    try {
      if (T.requestUpgrade) { await T.requestUpgrade('doctor_fix'); }
      else if (T.showMainWindow) { await T.showMainWindow(); }
      else if (T.navigateBack) { await T.navigateBack(); }
    } catch (e) { /* ignore */ }
    if (standalone) {
      try { if (T.hideDoctorWindow) await T.hideDoctorWindow(); } catch (e) { /* ignore */ }
    }
  }

  // ---- auth modal ---------------------------------------------------------
  function openAuthModal(reason, message) {
    const modal = $('authModal');
    const title = $('authTitle');
    const msg = $('authMsg');
    const loginBtn = $('authLoginBtn');
    const upgradeBtn = $('authUpgradeBtn');
    if (!modal) {
      // No modal in DOM — degrade by routing to the right place.
      if (reason === 'subscription') safeOpenUrl(UPGRADE_URL);
      else startSignIn();
      return;
    }
    const sub = reason === 'subscription';
    if (title) title.textContent = sub ? 'Upgrade to clean' : 'Sign in to clean';
    if (msg) {
      msg.textContent = message ||
        (sub
          ? 'Cleaning and optimizing is a Terse Pro feature. The full report stays free.'
          : 'Sign in to apply fixes. Your report stays free to read.');
    }
    if (loginBtn) loginBtn.style.display = sub ? 'none' : '';
    if (upgradeBtn) upgradeBtn.style.display = sub ? '' : 'none';
    modal.style.display = '';
    modal.classList.add('show');
  }
  function closeAuthModal() {
    const modal = $('authModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.style.display = 'none';
  }

  function safeOpenUrl(url) {
    try { if (T.openUrl) { T.openUrl(url); return; } } catch (e) { /* ignore */ }
    try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
  }

  async function startSignIn() {
    // Prefer the real in-app auth flow if present; else open the sign-in page.
    try {
      if (typeof T.openAuthInBrowser === 'function') {
        showToast('Opening sign-in in your browser…');
        const data = await T.openAuthInBrowser('signin');
        if (data) {
          closeAuthModal();
          showToast('Signed in. Try the fix again.');
        }
        return;
      }
    } catch (e) { /* fall through */ }
    safeOpenUrl(SIGNIN_URL);
  }

  // ---- bulk bar -----------------------------------------------------------
  function checkedFindings() {
    const out = [];
    Object.keys(cardEls).forEach((id) => {
      const ref = cardEls[id];
      if (ref && ref.checkbox && ref.checkbox.checked) out.push(ref);
    });
    return out;
  }
  function updateBulkBar() {
    const bar = $('bulkBar');
    const count = $('bulkCount');
    if (!bar) return;
    const sel = checkedFindings();
    if (sel.length > 0) {
      bar.style.display = '';
      bar.classList.add('show');
      if (count) count.textContent = sel.length + ' selected';
    } else {
      bar.classList.remove('show');
      bar.style.display = 'none';
    }
  }
  async function runBulk() {
    const btn = $('bulkBtn');
    const sel = checkedFindings();
    if (sel.length === 0) return;
    if (btn) btn.disabled = true;
    for (let i = 0; i < sel.length; i++) {
      const ref = sel[i];
      if (!ref || !ref.card || !ref.card.parentNode) continue;
      const ok = await applyFinding(ref.finding, ref.card, ref.card.querySelector('.fix-btn'));
      if (!ok) break; // stop on gate/failure (auth modal is already shown)
    }
    if (btn) btn.disabled = false;
    updateBulkBar();
  }

  // ---- grouping / render --------------------------------------------------
  function cleanupEmptyGroups() {
    const list = $('findingsList');
    if (!list) return;
    list.querySelectorAll('.finding-group').forEach((g) => {
      if (!g.querySelector('.finding')) g.parentNode && g.parentNode.removeChild(g);
    });
  }
  function maybeShowEmpty() {
    const list = $('findingsList');
    const empty = $('emptyState');
    const any = list && list.querySelector('.finding');
    if (empty) empty.style.display = any ? 'none' : '';
  }

  function renderFindings(report) {
    const list = $('findingsList');
    const empty = $('emptyState');
    if (!list) return;
    list.innerHTML = '';
    for (const k in cardEls) delete cardEls[k];

    // Localize the scanner's English findings to the app language before
    // grouping — title/detail/categoryLabel/latencyNote/fixLabel all get
    // translated, with interpolated model names / numbers / paths preserved.
    const lang = (window.i18n && window.i18n.getLang && window.i18n.getLang()) || 'en';
    let findings = Array.isArray(report.findings) ? report.findings : [];
    if (window.doctorI18n && window.doctorI18n.localizeFinding) {
      findings = findings.map((f) => window.doctorI18n.localizeFinding(f, lang));
    }
    lastFindings = findings;
    const previewBtn = $('previewBtn');
    if (previewBtn) previewBtn.style.display = findings.length ? '' : 'none';
    if (findings.length === 0) {
      if (empty) empty.style.display = '';
      updateBulkBar();
      return;
    }
    if (empty) empty.style.display = 'none';

    // group by categoryLabel, sort by severity within group
    const sevRank = { high: 0, medium: 1, low: 2 };
    const groups = {};
    const order = [];
    findings.forEach((f) => {
      const key = f.categoryLabel || f.category || 'Other';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(f);
    });

    order.forEach((key) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'finding-group';
      const head = document.createElement('div');
      head.className = 'group-title';
      head.textContent = key;
      groupEl.appendChild(head);

      groups[key]
        .slice()
        .sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3))
        .forEach((f) => groupEl.appendChild(buildCard(f)));

      list.appendChild(groupEl);
    });

    updateBulkBar();
    // Re-translate freshly inserted DOM (category headers, button labels, etc.)
    try { if (window.i18n && window.i18n.applyTranslations) window.i18n.applyTranslations(); } catch (e) { /* ignore */ }

    // Previews are shown by DEFAULT — every finding auto-plays its before↔after
    // story inline, no click required.
    Object.keys(cardEls).forEach((id) => {
      const r = cardEls[id];
      if (r && r.preview) r.preview.open();
    });
    const previewBtnEl = $('previewBtn');
    if (previewBtnEl) previewBtnEl.classList.add('active');

    // Stagger the reveal and animate each card's impact bar + count-up metrics.
    // Impact bars are normalized against the costliest finding so the worst
    // issue reads as a full red bar and the rest scale relative to it.
    const maxUsd = findings.reduce((mx, f) => Math.max(mx, Number(f.usdWasted) || 0), 0) || 1;
    const cards = list.querySelectorAll('.finding');
    cards.forEach((card, idx) => {
      card.style.setProperty('--i', idx);
      const ref = cardEls[card.dataset.id];
      const f = ref && ref.finding;
      const frac = f ? (Number(f.usdWasted) || 0) / maxUsd : 0.3;
      setTimeout(() => animateCard(card, frac), 220 + idx * 70);
    });
  }

  // ---- main scan ----------------------------------------------------------
  async function runScan() {
    if (scanning) return;
    scanning = true;
    const scanBtn = $('scanBtn');
    if (scanBtn) { scanBtn.disabled = true; scanBtn.classList.add('busy'); }
    runSweep();

    let report = null;
    try {
      if (!T.doctorScan) throw new Error('bridge unavailable');
      report = await T.doctorScan();
    } catch (e) {
      report = null;
    }

    // small min duration so the sweep reads as intentional
    await new Promise((r) => setTimeout(r, 700));
    endSweep();

    if (!report || typeof report !== 'object') {
      scanning = false;
      if (scanBtn) { scanBtn.disabled = false; scanBtn.classList.remove('busy'); }
      showToast('Scan unavailable. Please try again.');
      const grade = $('scoreGrade');
      if (grade) grade.textContent = 'Scan failed';
      return;
    }

    lastReport = report;
    animateGauge(report.score);
    const grade = $('scoreGrade');
    if (grade) grade.textContent = report.grade || '';
    renderSummary(report);
    renderFindings(report);
    maybeShowEmpty();

    // reveal the findings region (hidden until first scan completes)
    const region = $('findingsRegion');
    if (region) region.classList.add('show');
    const countLbl = $('findingsCountLbl');
    if (countLbl) {
      const n = Array.isArray(report.findings) ? report.findings.length : 0;
      countLbl.textContent = n ? String(n) : '';
    }

    scanning = false;
    if (scanBtn) { scanBtn.disabled = false; scanBtn.classList.remove('busy'); }
  }

  // ---- preview theater ----------------------------------------------------
  // A full-window walkthrough of every finding: a vivid animated scene of the
  // problem, a Problem⇄After-fix compare toggle, and a real (gated) Apply button.
  const theater = {
    items: [],     // findings currently in the walkthrough (snapshot of live cards)
    idx: 0,
    state: 'before',
    entitled: false,
    userToggled: false, // suppress the auto-demo once the user drives the compare
  };

  function t18(key, fallback, params) {
    try {
      if (window.i18n && window.i18n.t) {
        const v = window.i18n.t(key, params);
        if (v && v !== key) return v;
      }
    } catch (e) { /* ignore */ }
    return fallback;
  }

  // Ordered list of findings whose cards are still on screen (skips dismissed/fixed).
  function liveFindings() {
    return lastFindings.filter((f) => cardEls[f.id]);
  }

  async function openTheater(startId) {
    const items = liveFindings();
    if (!items.length) return;
    theater.items = items;
    theater.idx = Math.max(0, items.findIndex((f) => f.id === startId));
    if (theater.idx < 0) theater.idx = 0;
    // Pre-check entitlement so the Apply button can show a lock hint up front.
    try { const ent = await ensureEntitled(); theater.entitled = !!(ent && ent.ok); }
    catch (e) { theater.entitled = false; }
    const el = $('theater');
    if (el) { el.style.display = 'flex'; el.classList.add('show'); }
    renderTheater();
  }

  function closeTheater() {
    const el = $('theater');
    if (el) { el.classList.remove('show'); el.style.display = 'none'; }
  }

  function currentFinding() { return theater.items[theater.idx] || null; }

  // Build the metric chips at full value (theater shows them settled, not counting).
  function theaterMetricsHTML(f) {
    const out = [];
    const perMo = (window.doctorI18n && window.i18n && window.i18n.getLang)
      ? window.doctorI18n.tr(window.i18n.getLang(), '/mo') : '/mo';
    const usd = Number(f.usdWasted) || 0;
    if (usd > 0) out.push('<span class="metric cost">' + esc(fmtUSD(usd)) + '<span class="ml">' + esc(perMo) + '</span></span>');
    const tok = Number(f.tokensWasted) || 0;
    if (tok > 0) out.push('<span class="metric">' + esc(fmtTokens(tok)) + '</span>');
    const b = Number(f.bytes) || 0;
    if (b > 0) out.push('<span class="metric">' + esc(fmtBytes(b)) + '</span>');
    return out.join('');
  }

  function savingsLabel(f) {
    const usd = Number(f.usdWasted) || 0;
    const tok = Number(f.tokensWasted) || 0;
    const bytes = Number(f.bytes) || 0;
    const perMo = (window.doctorI18n && window.i18n && window.i18n.getLang)
      ? window.doctorI18n.tr(window.i18n.getLang(), '/mo') : '/mo';
    if (usd > 0) return fmtUSD(usd) + ' ' + perMo;
    if (tok > 0) return fmtTokens(tok);
    if (bytes > 0) return fmtBytes(bytes);
    return '';
  }

  // Inject the scene for the current finding + state. Re-injection replays the
  // CSS entrance animations, which is what makes the compare feel like "playing".
  function paintStage() {
    const stage = $('thStage');
    const f = currentFinding();
    if (!stage || !f) return;
    const html = (window.doctorScenes && window.doctorScenes.build)
      ? window.doctorScenes.build(f.category, f, theater.state) : '';
    stage.innerHTML = html;
  }

  function setTheaterState(state) {
    theater.state = state === 'after' ? 'after' : 'before';
    const seg = $('thSeg');
    if (seg) {
      seg.classList.toggle('after', theater.state === 'after');
      seg.classList.toggle('before', theater.state === 'before');
      seg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.state === theater.state);
      });
    }
    const banner = $('thSaveBanner');
    const f = currentFinding();
    if (banner && f) {
      const save = savingsLabel(f);
      if (theater.state === 'after' && save) {
        banner.textContent = t18('doctor_est_save', 'Fixing this recovers ~' + save, { v: save });
        banner.classList.add('show');
      } else {
        banner.classList.remove('show');
      }
    }
    paintStage();
  }

  function renderTheater() {
    const f = currentFinding();
    if (!f) { closeTheater(); return; }
    const total = theater.items.length;
    const counter = $('thCounter');
    if (counter) counter.textContent = (theater.idx + 1) + ' / ' + total;

    const cat = $('thCat');
    if (cat) {
      cat.textContent = f.categoryLabel || f.category || '';
      cat.className = 'th-cat cat-badge ' + esc(f.category || 'junk');
    }
    const sev = $('thSev');
    if (sev) {
      const dot = sev.querySelector('.d');
      const txt = sev.querySelector('.t');
      const s = f.severity || 'low';
      if (dot) dot.className = 'd ' + esc(s);
      if (txt) txt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    }
    const title = $('thTitle');
    if (title) title.textContent = f.title || 'Issue';
    const detail = $('thDetail');
    if (detail) detail.textContent = f.detail || '';
    const metrics = $('thMetrics');
    if (metrics) metrics.innerHTML = theaterMetricsHTML(f);

    // Apply button reflects the finding's fix kind; gating happens on click.
    const advise = f.fixKind === 'advise' || f.fixable === false;
    const apply = $('thApply');
    if (apply) {
      apply.classList.toggle('delete', f.fixKind === 'delete');
      apply.disabled = false;
      const lbl = apply.querySelector('.lbl');
      if (lbl) {
        lbl.textContent = advise
          ? t18('doctor_how_to_fix', 'How to fix')
          : (f.fixLabel || t18('doctor_apply_fix', 'Apply fix'));
      }
      const lock = apply.querySelector('.lock');
      if (lock) lock.style.display = theater.entitled ? 'none' : '';
    }
    const prev = $('thPrev');
    const next = $('thNext');
    if (prev) prev.disabled = theater.idx <= 0;
    if (next) next.disabled = theater.idx >= total - 1;

    theater.userToggled = false;
    setTheaterState('before');
    // Auto-demo the fix once shortly after opening — an immediate taste of the
    // before→after. Skipped the moment the user drives the compare themselves.
    setTimeout(() => {
      if (currentFinding() === f && !theater.userToggled && theater.state === 'before') setTheaterState('after');
    }, 1100);
  }

  function theaterNav(delta) {
    const ni = theater.idx + delta;
    if (ni < 0 || ni >= theater.items.length) return;
    theater.idx = ni;
    renderTheater();
  }

  // Advance past the current finding once it's been resolved/dismissed; close if last.
  function theaterAdvanceAfterResolve() {
    theater.items.splice(theater.idx, 1);
    if (!theater.items.length) { closeTheater(); return; }
    if (theater.idx >= theater.items.length) theater.idx = theater.items.length - 1;
    renderTheater();
  }

  async function theaterApply() {
    const f = currentFinding();
    if (!f) return;
    const apply = $('thApply');
    const advise = f.fixKind === 'advise' || f.fixable === false;

    if (advise) {
      const ent = await ensureEntitled();
      if (!ent.ok) {
        if (ent.reason === 'subscription') { closeTheater(); await goToPaywall(); }
        else openAuthModal('login', 'Sign in to see how to fix this. Your report stays free to read.');
        return;
      }
      // Entitled → reveal the after state + guidance, mark as understood.
      theater.entitled = true;
      setTheaterState('after');
      const banner = $('thSaveBanner');
      if (banner) { banner.textContent = f.detail || ''; banner.classList.add('show'); }
      if (apply) { apply.disabled = true; const l = apply.querySelector('.lbl'); if (l) l.textContent = t18('doctor_seen_fix', 'Got it'); }
      return;
    }

    // Real local fix — applyFinding owns the gating + the actual mutation.
    const ref = cardEls[f.id];
    const card = ref ? ref.card : null;
    if (apply) { apply.disabled = true; const l = apply.querySelector('.lbl'); if (l) l.textContent = t18('working', 'Working…'); }
    const ok = await applyFinding(f, card, null);
    if (ok) {
      theater.entitled = true;
      setTheaterState('after');
      showToast(t18('doctor_th_done', 'Fixed — nice'));
      setTimeout(theaterAdvanceAfterResolve, 850);
    } else {
      // Gate or failure — applyFinding already surfaced the reason. Restore button.
      if (apply) {
        apply.disabled = false;
        const l = apply.querySelector('.lbl');
        if (l) l.textContent = f.fixLabel || t18('doctor_apply_fix', 'Apply fix');
      }
    }
  }

  function theaterDismiss() {
    const f = currentFinding();
    if (f) {
      try { if (T.doctorDismiss) T.doctorDismiss(f.id); } catch (e) { /* ignore */ }
      const ref = cardEls[f.id];
      if (ref && ref.card && ref.card.parentNode) ref.card.parentNode.removeChild(ref.card);
      delete cardEls[f.id];
    }
    theaterAdvanceAfterResolve();
    cleanupEmptyGroups();
    updateBulkBar();
    maybeShowEmpty();
  }

  // Header "Preview issues" button expands/collapses every card's inline scene.
  function toggleAllPreviews() {
    const refs = Object.keys(cardEls).map((id) => cardEls[id]).filter((r) => r && r.preview);
    if (!refs.length) return;
    const anyClosed = refs.some((r) => !r.preview.isOpen());
    refs.forEach((r) => { if (anyClosed) r.preview.open(); else r.preview.close(); });
    const previewBtn = $('previewBtn');
    if (previewBtn) previewBtn.classList.toggle('active', anyClosed);
  }

  function initTheater() {
    const previewBtn = $('previewBtn');
    if (previewBtn) previewBtn.addEventListener('click', toggleAllPreviews);
    const thClose = $('thClose');
    if (thClose) thClose.addEventListener('click', closeTheater);
    const thPrev = $('thPrev');
    if (thPrev) thPrev.addEventListener('click', () => theaterNav(-1));
    const thNext = $('thNext');
    if (thNext) thNext.addEventListener('click', () => theaterNav(1));
    const thApply = $('thApply');
    if (thApply) thApply.addEventListener('click', theaterApply);
    const thDismiss = $('thDismiss');
    if (thDismiss) thDismiss.addEventListener('click', theaterDismiss);
    const thReplay = $('thReplay');
    if (thReplay) thReplay.addEventListener('click', () => { theater.userToggled = true; paintStage(); });
    const seg = $('thSeg');
    if (seg) seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { theater.userToggled = true; setTheaterState(b.dataset.state); });
    });
    // Keyboard: ←/→ navigate, Esc closes.
    document.addEventListener('keydown', (e) => {
      const el = $('theater');
      if (!el || !el.classList.contains('show')) return;
      if (e.key === 'Escape') { closeTheater(); }
      else if (e.key === 'ArrowLeft') { theaterNav(-1); }
      else if (e.key === 'ArrowRight') { theaterNav(1); }
    });
  }

  // ---- wire up ------------------------------------------------------------
  function init() {
    initTheater();
    const closeBtn = $('closeBtn');
    if (closeBtn) closeBtn.addEventListener('click', async () => {
      // The Doctor renders in two contexts: embedded in the main window
      // (reached via the dock button / first-run) and as the standalone
      // "doctor" window (Cmd+Shift+D). Close should behave correctly in both.
      if (currentWindowLabel() === 'doctor') {
        try { if (T.hideDoctorWindow) { await T.hideDoctorWindow(); return; } } catch (e) { /* ignore */ }
      }
      try { if (T.navigateBack) { await T.navigateBack(); return; } } catch (e) { /* ignore */ }
      try { if (T.hideDoctorWindow) await T.hideDoctorWindow(); } catch (e) { /* ignore */ }
    });

    const scanBtn = $('scanBtn');
    if (scanBtn) scanBtn.addEventListener('click', runScan);

    const bulkBtn = $('bulkBtn');
    if (bulkBtn) bulkBtn.addEventListener('click', runBulk);

    const loginBtn = $('authLoginBtn');
    if (loginBtn) loginBtn.addEventListener('click', startSignIn);
    const upgradeBtn = $('authUpgradeBtn');
    if (upgradeBtn) upgradeBtn.addEventListener('click', () => safeOpenUrl(UPGRADE_URL));
    const authCloseBtn = $('authCloseBtn');
    if (authCloseBtn) authCloseBtn.addEventListener('click', closeAuthModal);

    // auto-run the free scan on open
    runScan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // expose for debugging / doctor.html hooks
  window.doctor = { runScan: runScan, applyFinding: applyFinding, openTheater: openTheater };
})();
