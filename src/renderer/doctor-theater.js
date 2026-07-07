// Terse Doctor — preview scene library (vivid before/after micro-visualizations).
// Pure-presentational: given a finding category and a state ('before' | 'after'),
// each builder returns the HTML for an animated visualization — the PROBLEM
// (before) or the FIXED state (after). No gating, no data fetching: the inline
// preview controller in doctor.js owns flow, the compare toggle and the gated
// Apply button. Re-injecting a scene's HTML replays its CSS entrance animations,
// which is how the before/after compare plays.
//
// Each builder has signature (state, f, h) => htmlString where:
//   state — 'before' | 'after'
//   f     — the finding (may read f.tokensWasted / f.usdWasted / f.bytes; all may be 0)
//   h     — helpers: h.tok(n) '504K', h.usd(n) '$1.51', h.bytes(n) '1.2 MB',
//           h.esc(s) html-escape, h.jitter(i,base,span) deterministic spread.
//
// Scenes were redesigned by a multi-agent pass; every selector is namespaced
// under .sc-<category> and every @keyframes is category-prefixed, so the CSS in
// doctor.html can be concatenated without collisions.
(function () {
  'use strict';

  function jitter(i, base, span) { return base + ((i * 37) % span); }
  function tok(n) {
    var v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }
  function usd(n) {
    var v = Number(n) || 0;
    if (v <= 0) return '$0';
    if (v < 0.01) return '<$0.01';
    if (v < 100) return '$' + v.toFixed(2);
    return '$' + Math.round(v).toLocaleString();
  }
  function bytes(b) {
    var v = Number(b) || 0;
    if (v <= 0) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, x = v;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return x.toFixed(x < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var H = { tok: tok, usd: usd, bytes: bytes, esc: esc, jitter: jitter };

  var BUILDERS = {
    cache: (state, f, h) => {
  const after = state === 'after';
  const cls = after ? 'is-after' : 'is-before';
  const tok = (f && f.tokensWasted) ? h.tok(f.tokensWasted) : '';
  const usd = (f && f.usdWasted) ? h.usd(f.usdWasted) : '';
  let dots = '';
  for (let i = 0; i < 7; i++) {
    const x = h.jitter(i, 12, 64);
    dots += '<span class="tk" style="--d:' + (i * 0.16) + 's;--x:' + x + '%"></span>';
  }
  let blocks = '';
  for (let i = 0; i < 5; i++) {
    blocks += '<i class="blk" style="--d:' + (i * 0.12) + 's"></i>';
  }
  let arc = '';
  for (let i = 0; i < 4; i++) {
    arc += '<span class="rz" style="--d:' + (i * 0.4) + 's"></span>';
  }
  return '' +
    '<div class="sc sc-cache ' + cls + '">' +
      '<div class="frost"></div>' +
      '<div class="feed">' +
        '<span class="feedlbl">prefix</span>' +
        '<div class="flow">' + dots + '</div>' +
      '</div>' +
      '<div class="cachebox">' +
        '<div class="glow"></div>' +
        '<div class="ice"></div>' +
        '<div class="blocks">' + blocks + '</div>' +
        '<svg viewBox="0 0 24 24" class="ci" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          (after
            ? '<path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.5 2 2 2 2 0 0-2-1-3 1-4.5z"/>'
            : '<path d="M12 2v20M4 8l8-4 8 4M4 16l8 4 8-4"/>') +
        '</svg>' +
        '<span class="state">' + (after ? 'WARM' : 'COLD') + '</span>' +
      '</div>' +
      (after
        ? '<div class="reuse">' + arc + '<svg class="loop" viewBox="0 0 90 60" aria-hidden="true"><path d="M82 14 C 82 -2 8 -2 8 30 C 8 56 70 56 78 40" fill="none"/></svg></div>'
        : '<div class="spill"><span></span><span></span><span></span></div>') +
      '<div class="badge">' +
        (after
          ? '<svg viewBox="0 0 24 24" class="bi" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>cache hit · reused</span>'
          : '<svg viewBox="0 0 24 24" class="bi" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg><span>re-prefill every turn</span>') +
      '</div>' +
      (tok || usd
        ? '<div class="meters">' +
            (tok ? '<div class="m"><span class="mv">' + h.esc(tok) + '</span><span class="ml">' + (after ? 'reused' : 'reprocessed') + '</span></div>' : '') +
            (usd ? '<div class="m"><span class="mv">' + h.esc(usd) + '</span><span class="ml">' + (after ? 'saved/mo' : 'wasted/mo') + '</span></div>' : '') +
          '</div>'
        : '') +
    '</div>';
},

    mcp: (state, f, h) => {
  const after = state === 'after';
  const tokensW = f && f.tokensWasted ? f.tokensWasted : 0;
  const usdW = f && f.usdWasted ? f.usdWasted : 0;
  const loaded = after ? 2 : 5;
  const NAMES = ['fs', 'github', 'slack', 'jira', 'sql'];
  let rows = '';
  for (let i = 0; i < loaded; i++) {
    const w = after ? (i === 0 ? 40 : 30) : h.jitter(i, 58, 40);
    const used = after ? true : (i === 0);
    rows += '<div class="srv ' + (used ? 'used' : 'idle') + '" style="--d:' + (i * 0.07).toFixed(2) + 's;--i:' + i + '">' +
      '<span class="plug"></span>' +
      '<span class="sname">' + h.esc(NAMES[i] || ('s' + i)) + '</span>' +
      '<span class="bar"><i style="--w:' + w + '%"></i></span>' +
      (used ? '' : '<span class="cost">+300t</span>') +
      '</div>';
  }
  const counterVal = after ? (tokensW ? h.tok(tokensW) : '600t') : '1.5K';
  const counterClass = after ? 'tdown' : 'tup';
  const footWasteTok = tokensW ? h.tok(tokensW) : '~1.5K';
  const footWasteUsd = usdW ? h.usd(usdW) : '';
  const footAfter = (footWasteTok ? footWasteTok : '') + (footWasteUsd ? ' / ' + footWasteUsd : '') + ' saved/turn';
  return '<div class="sc sc-mcp ' + (after ? 'is-after' : 'is-before') + '">' +
    '<div class="mcp-stage">' +
      '<div class="req"><span class="reqdot"></span>REQUEST</div>' +
      '<div class="wires">' +
        '<svg viewBox="0 0 60 110" preserveAspectRatio="none" aria-hidden="true">' +
          (after
            ? '<path d="M2,55 C30,55 30,38 58,38"/><path d="M2,55 C30,55 30,72 58,72"/>'
            : '<path d="M2,55 C30,55 30,12 58,12"/><path d="M2,55 C30,55 30,33 58,33"/><path d="M2,55 C30,55 30,55 58,55"/><path d="M2,55 C30,55 30,77 58,77"/><path d="M2,55 C30,55 30,98 58,98"/>') +
        '</svg>' +
        '<span class="sweep"></span>' +
      '</div>' +
      '<div class="fan">' + rows + '</div>' +
    '</div>' +
    '<div class="mcp-foot">' +
      '<span class="counter ' + counterClass + '"><b>' + counterVal + '</b><span class="clbl">' + (after ? 'prefill/turn' : 'prefill/turn') + '</span></span>' +
      (after
        ? '<span class="tot">2 lean &middot; <span class="defer">3 deferred &rarr; tool-search</span></span>'
        : '<span class="tot">' + loaded + ' servers loaded &middot; 4 idle</span>') +
    '</div>' +
    (after
      ? '<div class="winnote">' + footAfter + '</div>'
      : '<div class="badnote">every turn pays for unused tools</div>') +
  '</div>';
},

    loop: (state, f, h) => {
  const after = state === 'after';
  const cls = 'sc sc-loop ' + (after ? 'is-after' : 'is-before');
  const tok = (f && f.tokensWasted) ? h.tok(f.tokensWasted) : '';
  const usd = (f && f.usdWasted) ? h.usd(f.usdWasted) : '';
  if (after) {
    const meta = (tok ? tok + ' saved' : '') + (tok && usd ? ' · ' : '') + (usd ? usd : '');
    return ''
      + '<div class="' + cls + '">'
      +   '<div class="loop-glow"></div>'
      +   '<div class="loop-stage">'
      +     '<div class="loop-cache-tag"><span class="loop-db"></span>served from cache</div>'
      +     '<div class="loop-solved">'
      +       '<svg class="loop-check" viewBox="0 0 52 52"><circle class="loop-ck-ring" cx="26" cy="26" r="22"/><path class="loop-ck-tick" d="M16 27 L23 34 L37 18"/></svg>'
      +       '<div class="loop-solved-txt"><span class="loop-call">1 call</span><span class="loop-sub">resolved</span></div>'
      +     '</div>'
      +     '<div class="loop-foot loop-foot-ok"><span class="loop-dot-ok"></span>' + (meta ? h.esc(meta) : 'deduplicated') + '</div>'
      +   '</div>'
      + '</div>';
  }
  let cards = '';
  const labels = ['POST /chat', 'POST /chat', 'POST /chat', 'POST /chat'];
  for (let i = 0; i < 4; i++) {
    const ang = (i * 90);
    const d = (i * 0.16);
    cards += '<div class="loop-card" style="--a:' + ang + 'deg;--d:' + d + 's">'
      + '<span class="loop-card-dot"></span><span class="loop-card-l">' + h.esc(labels[i]) + '</span>'
      + '</div>';
  }
  const meta = (tok ? tok + ' burned' : 'duplicate calls') + (usd ? ' · ' + usd : '');
  return ''
    + '<div class="' + cls + '">'
    +   '<div class="loop-stage">'
    +     '<div class="loop-orbit">'
    +       '<svg class="loop-ring" viewBox="0 0 100 100"><circle class="loop-ring-trk" cx="50" cy="50" r="40"/><circle class="loop-ring-arc" cx="50" cy="50" r="40"/></svg>'
    +       '<div class="loop-rotor">' + cards + '</div>'
    +       '<div class="loop-core"><span class="loop-core-n">×4</span><span class="loop-core-l">retrying</span></div>'
    +     '</div>'
    +     '<div class="loop-foot loop-foot-bad"><span class="loop-dot-bad"></span>' + h.esc(meta) + '</div>'
    +   '</div>'
    + '</div>';
},

    context: (state, f, h) => {
  const after = state === 'after';
  const cls = 'sc sc-context ' + (after ? 'is-after' : 'is-before');
  const fillPct = after ? 58 : 116;
  const shownPct = Math.min(fillPct, 142);
  const tok = (f && f.tokensWasted) ? h.tok(f.tokensWasted) : '';
  let chunks = '';
  const nChunks = after ? 6 : 12;
  for (let i = 0; i < nChunks; i++) {
    const over = !after && i >= 10;
    chunks += '<i class="chk' + (over ? ' over' : '') + '" style="--d:' + (i * 0.04).toFixed(2) + 's"></i>';
  }
  let spill = '';
  if (!after) {
    for (let i = 0; i < 5; i++) {
      const y = h.jitter(i, -10, 24);
      spill += '<span class="sp" style="--d:' + (i * 0.18).toFixed(2) + 's;--y:' + y + 'px"></span>';
    }
  }
  return '' +
    '<div class="' + cls + '">' +
      '<div class="ctx-top">' +
        '<span class="ctx-title">context window</span>' +
        '<span class="ctx-pct">' + shownPct + '%</span>' +
      '</div>' +
      '<div class="ctx-track">' +
        '<div class="ctx-fill"><div class="ctx-chunks">' + chunks + '</div></div>' +
        (after ? '<div class="ctx-head"><span class="ctx-headlbl">headroom</span></div>' : '') +
        '<div class="ctx-gate"><span class="ctx-gatelbl">100%</span></div>' +
        (after ? '' : '<div class="ctx-spill">' + spill + '</div>') +
        (after ? '' : '<div class="ctx-scissor"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6L21 18M9 18L21 6" stroke="#F44336" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="6" cy="7" r="2.4" stroke="#F44336" stroke-width="2" fill="none"/><circle cx="6" cy="17" r="2.4" stroke="#F44336" stroke-width="2" fill="none"/></svg></div>') +
      '</div>' +
      '<div class="ctx-note">' +
        (after
          ? '<span class="ctx-dot ok"></span>fits with headroom'
          : '<span class="ctx-dot bad"></span>overflow — truncation risk' + (tok ? ' · ' + tok + ' cut' : '')) +
      '</div>' +
    '</div>';
},

    prompt: (state, f, h) => {
  const after = state === 'after';
  const esc = (h && h.esc) ? h.esc : (s => String(s));
  const tok = (h && h.tok) ? h.tok : (n => String(n));
  const jit = (h && h.jitter) ? h.jitter : ((i, b, s) => b + ((i * 37) % s));
  const wasted = (f && f.tokensWasted) ? f.tokensWasted : 0;
  // duplicate-rule map for the bloated (before) doc: rows 1,2 share rule ×1; 5,6 share ×2; 8 is ×3
  const dupSet = { 1: 1, 2: 1, 5: 2, 6: 2, 8: 3 };
  const total = after ? 4 : 11;
  let lines = '';
  for (let i = 0; i < total; i++) {
    const isDup = !after && dupSet[i];
    const w = after ? jit(i, 58, 30) : jit(i, 40, 55);
    const cls = 'ln' + (isDup ? ' dup' : '');
    lines += '<span class="' + cls + '" style="--d:' + (i * 0.045).toFixed(3) + 's;--w:' + w + '%">' +
      (isDup ? '<i class="dupchip">×' + dupSet[i] + '</i>' : '') +
      '</span>';
  }
  const tokChip = wasted
    ? '<span class="tokchip">' + esc(tok(wasted)) + ' tok ' + (after ? 'trimmed' : 'wasted') + '</span>'
    : '';
  return '' +
    '<div class="sc sc-prompt ' + (after ? 'is-after' : 'is-before') + '">' +
      '<div class="docwrap">' +
        '<div class="doc">' +
          '<span class="hdr"><b>system prompt</b>' +
            '<em class="meta">' + (after ? '4 lines' : '11 lines') + '</em>' +
          '</span>' +
          '<div class="body">' + lines + '</div>' +
          (after ? '' : '<span class="scan"></span>') +
          (after ? '<span class="seal"></span>' : '') +
        '</div>' +
        (after
          ? '<span class="badge ok">−7 lines</span>'
          : '<span class="badge bad">5 dupes</span>') +
      '</div>' +
      '<div class="promptlbl">' +
        '<span class="dot"></span>' +
        (after ? 'lean prompt, −7 lines' : 'bloated — repeated rules') +
      '</div>' +
      tokChip +
    '</div>';
},

    cost: (state, f, h) => {
  const usd = (f && f.usdWasted) ? h.usd(f.usdWasted) : '$420';
  const tok = (f && f.tokensWasted) ? h.tok(f.tokensWasted) : '';
  const coins = (n) => Array.from({length:n}).map((_,i)=>`<i class="coin" style="--d:${(h.jitter(i,0,55)/100).toFixed(2)}s;--x:${18+h.jitter(i,0,64)}%;--s:${(0.85+h.jitter(i,0,30)/100).toFixed(2)}"></i>`).join('');
  const tasks = (n) => Array.from({length:n}).map((_,i)=>`<span class="task${i%3===0?' big':''}" style="--d:${(i*0.16).toFixed(2)}s"></span>`).join('');
  if (state === 'after') {
    return `<div class="sc sc-cost is-after"><div class="cost-head"><span class="costlbl">routed by difficulty</span><span class="cost-usd good">−${h.esc(usd)}<small>/mo saved</small></span></div><div class="cost-stage"><div class="lane">${tasks(5)}</div><div class="router"><svg viewBox="0 0 44 44"><path d="M2 22 H22 M22 22 Q33 8 42 8 M22 22 Q33 36 42 36"/></svg><span class="rdot"></span></div><div class="nodes"><div class="node cheap"><b>HAIKU</b><small>simple</small></div><div class="node prem sm2"><b>OPUS</b><small>hard</small></div></div><div class="coins few">${coins(2)}</div></div><div class="cap costsub">cheap tier handles the easy 80%</div></div>`;
  }
  return `<div class="sc sc-cost is-before"><div class="cost-head"><span class="costlbl">100% premium</span><span class="cost-usd">${h.esc(usd)}<small>/mo wasted</small></span></div><div class="cost-stage"><div class="lane">${tasks(5)}</div><div class="node big prem"><span class="strain"></span><b>OPUS-4</b><small>everything</small></div><div class="coins">${coins(7)}</div></div><div class="cap costsub">${tok?h.esc(tok)+' tokens billed at premium':'every trivial task billed at premium'}</div></div>`;
},

    config: (state, f, h) => {
  const after = state === 'after';
  const esc = (h && h.esc) ? h.esc : (s => String(s == null ? '' : s));
  const tok = (h && h.tok) ? h.tok : (n => String(n));
  // Three setting rows; before = wrong, after = corrected (knob right, green).
  const rows = [
    { k: 'verbose_output', vb: 'on',  va: 'off' },
    { k: 'auto_retry_loop', vb: 'on', va: 'off' },
    { k: 'cache_prompt',    vb: 'off', va: 'on' }
  ];
  let toggles = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const wrong = !after; // before => all shown as wrong/red
    toggles +=
      '<div class="cfgrow" style="--d:' + (0.18 + i * 0.16) + 's">' +
        '<span class="cfgkey">' + esc(r.k) + '</span>' +
        '<span class="toggle ' + (after ? 'on' : 'off') + '"><span class="knob"></span></span>' +
        '<span class="cfgmark">' + (after ? '✓' : '✗') + '</span>' +
      '</div>';
  }
  const wasted = (f && f.tokensWasted) ? f.tokensWasted : 0;
  const numChip = wasted
    ? '<span class="cfgnum">' + (after ? '−' + esc(tok(wasted)) + ' tok' : esc(tok(wasted)) + ' tok bleeding') + '</span>'
    : '';
  return '' +
    '<div class="sc sc-config ' + (after ? 'is-after' : 'is-before') + '">' +
      '<div class="cfgglow"></div>' +
      '<div class="cfgstage">' +
        '<div class="cfggearwrap">' +
          '<svg class="gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
          '</svg>' +
          '<span class="cfgbadge">' + (after ? '✓' : '⚠') + '</span>' +
        '</div>' +
        '<div class="cfgpanel">' + toggles + '</div>' +
      '</div>' +
      '<div class="cfgfoot">' +
        '<span class="configlbl">' + (after ? 'configured correctly' : 'misconfigured') + '</span>' +
        numChip +
      '</div>' +
    '</div>';
},

    junk: (state, f, h) => {
  const after = state === 'after';
  const IS = after ? 'is-after' : 'is-before';
  const size = (f && f.bytes) ? h.bytes(f.bytes) : '248 MB';
  let files = '';
  for (let i = 0; i < 9; i++) {
    const r = (h.jitter(i, 0, 22) - 11);
    const x = 6 + h.jitter(i, 0, 70);
    files += '<span class="jf" style="--d:' + (i * 0.11).toFixed(2) + 's;--r:' + r + 'deg;--x:' + x + '%;--sw:' + (i * 0.09).toFixed(2) + 's"></span>';
  }
  let spk = '';
  for (let i = 0; i < 5; i++) {
    spk += '<span class="jspark" style="--d:' + (i * 0.13).toFixed(2) + 's;--sx:' + (10 + h.jitter(i, 0, 78)) + '%"></span>';
  }
  return '<div class="sc sc-junk ' + IS + '">' +
    '<div class="jfloor"></div>' +
    '<div class="jpile">' + files + '</div>' +
    '<div class="jbroom"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M16 3l-6 9"/><path d="M9 11l5 5"/><path d="M8 13l-5 4 2 3 5-3"/><path d="M6.5 14.5l2 3"/></svg></div>' +
    '<div class="jshimmer"></div>' +
    '<div class="jsparks">' + spk + '</div>' +
    '<div class="jcheck"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg></div>' +
    '<div class="jbadge">' +
      '<span class="jdot"></span>' +
      '<span class="jtxt">' + (after ? 'disk reclaimed' : 'junk piling up') + '</span>' +
      '<span class="jsize">' + h.esc(size) + '</span>' +
    '</div>' +
  '</div>';
},

    generic: (state, f, h) => {
  const isAfter = state === 'after';
  const IS = isAfter ? 'is-after' : 'is-before';
  const tw = (f && f.tokensWasted) ? f.tokensWasted : 0;
  const uw = (f && f.usdWasted) ? f.usdWasted : 0;
  const by = (f && f.bytes) ? f.bytes : 0;
  // pick the most meaningful real metric to surface
  let metricVal = '', metricLbl = '';
  if (tw) { metricVal = h.tok(tw); metricLbl = 'tokens'; }
  else if (by) { metricVal = h.bytes(by); metricLbl = 'reclaimed'; }
  else if (uw) { metricVal = h.usd(uw); metricLbl = 'saved'; }
  const usd = uw ? h.usd(uw) : '';
  // before bar ~92% wasteful, after bar ~38% optimized
  const sparks = [];
  for (let i = 0; i < 6; i++) {
    const top = 8 + h.jitter(i, 0, 80);
    const d = (h.jitter(i, 0, 60) / 100).toFixed(2);
    sparks.push('<span class="spark" style="--top:' + top + '%;--d:' + d + 's;--sx:' + (40 + h.jitter(i + 3, 0, 50)) + '%"></span>');
  }
  const ticks = [];
  for (let i = 0; i < 5; i++) {
    ticks.push('<span class="tick" style="--d:' + (i * 0.07).toFixed(2) + 's"></span>');
  }
  return '' +
  '<div class="sc sc-generic ' + IS + '">' +
    '<div class="hdr">' +
      '<span class="dot"></span>' +
      '<span class="ttl">' + (isAfter ? 'Optimized' : 'Wasting resources') + '</span>' +
      '<span class="pct"><i class="num"></i></span>' +
    '</div>' +
    '<div class="row row--before">' +
      '<span class="lbl">before</span>' +
      '<div class="track">' +
        '<div class="fill fill--bad">' +
          '<span class="shimmer"></span>' +
          '<span class="sparks">' + sparks.join('') + '</span>' +
        '</div>' +
        '<span class="cap cap--bad">' + (metricVal ? metricVal + ' ' + metricLbl : 'over budget') + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="row row--after">' +
      '<span class="lbl">after</span>' +
      '<div class="track">' +
        '<div class="fill fill--good">' +
          '<span class="ticks">' + ticks.join('') + '</span>' +
          '<span class="check"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5"/></svg></span>' +
        '</div>' +
        '<span class="cap cap--good">' + (usd ? usd + ' saved' : 'optimized') + '</span>' +
      '</div>' +
    '</div>' +
  '</div>';
},
  };

  function build(category, finding, state) {
    var st = state === 'after' ? 'after' : 'before';
    var key = (category || '').toLowerCase();
    if (key === 'disk') key = 'junk'; // same visual story: files pile up → swept clean
    var fn = BUILDERS[key] || BUILDERS.generic;
    try { return fn(st, finding || {}, H); }
    catch (e) {
      try { return BUILDERS.generic(st, finding || {}, H); }
      catch (e2) { return '<div class="sc sc-generic ' + (st === 'after' ? 'is-after' : 'is-before') + '"></div>'; }
    }
  }

  window.doctorScenes = { build: build };
})();
