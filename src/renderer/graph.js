/* Terse Knowledge Graph — self-contained force-directed viewer + overlay editor.
 * No external libraries (Tauri CSP blocks CDNs): the force simulation, rendering
 * and interaction are all hand-rolled on a single <canvas>. Talks to the Rust
 * backend through window.__TAURI__ directly. */
(function () {
  'use strict';
  var TAURI = window.__TAURI__;
  if (!TAURI) { console.warn('[terse-graph] not in Tauri'); return; }
  var invoke = TAURI.core.invoke;
  var listen = TAURI.event.listen;

  // ── DOM ──────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var cv = $('cv'), ctx = cv.getContext('2d');
  var stage = $('stage');

  // ── State ────────────────────────────────────────────────────────────────
  var G = {
    repo: '', repos: [], graph: null, overlay: null,
    nodes: [], edges: [], byId: {},
    adj: {},                         // id -> [{node, edge, dir}]
    sel: null, hover: null,
    editMode: false, live: false,
    filters: { kinds: { function: 1, class: 1, method: 1, module: 1, external: 0 }, inferredOnly: 0, q: '' },
    view: { s: 1, x: 0, y: 0 },       // scale + pan offset
    pendingLink: null,                // source node id while drawing a manual edge
    capped: 0,
  };

  var CLUSTER_COLORS = ['#6EA8FF', '#FF8FA3', '#7BE0AD', '#FFC46B', '#C99BFF', '#4FD1C5',
    '#F6A5C0', '#A3E635', '#FB923C', '#22D3EE', '#F472B6', '#818CF8', '#34D399', '#FBBF24'];
  var EXTERNAL_COLOR = '#9aa0a6';
  var CONCEPT_COLOR = '#f5c542';
  var MAX_RENDER = 550;

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function colorFor(node) {
    if (node.kind === 'concept') return CONCEPT_COLOR;
    if (node.kind === 'external') return EXTERNAL_COLOR;
    if (node.community == null) return '#7b8794';
    return CLUSTER_COLORS[node.community % CLUSTER_COLORS.length];
  }
  function radiusFor(node) { return Math.min(20, 4 + Math.sqrt(node.degree || 0) * 2.1); }

  // ── Load / build ──────────────────────────────────────────────────────────
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  function setEmpty(show, title, body, busy) {
    var e = $('empty');
    if (!show) { e.classList.add('hidden'); return; }
    e.classList.remove('hidden');
    $('emptyH').textContent = title || 'No graph yet';
    $('emptyP').innerHTML = body || $('emptyP').innerHTML;
    var b = $('buildEmpty');
    if (busy) { b.innerHTML = '<span id="spinner"></span>'; b.disabled = true; }
    else { b.textContent = 'Build graph'; b.disabled = false; }
  }

  // In-page text prompt (Tauri webviews don't implement window.prompt()).
  function askText(title, placeholder) {
    return new Promise(function (resolve) {
      var m = $('modal'), inp = $('modalInput');
      $('modalTitle').textContent = title || 'Enter text';
      inp.value = ''; inp.placeholder = placeholder || '';
      m.classList.remove('hidden'); setTimeout(function () { inp.focus(); }, 20);
      function done(val) { m.classList.add('hidden'); cleanup(); resolve(val); }
      function onOk() { done(inp.value.trim() || null); }
      function onCancel() { done(null); }
      function onKey(e) { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); }
      function cleanup() {
        $('modalOk').removeEventListener('click', onOk);
        $('modalCancel').removeEventListener('click', onCancel);
        inp.removeEventListener('keydown', onKey);
      }
      $('modalOk').addEventListener('click', onOk);
      $('modalCancel').addEventListener('click', onCancel);
      inp.addEventListener('keydown', onKey);
    });
  }

  // The repo currently selected in the switcher (null → let backend resolve).
  function currentPath() { return G.repo || null; }

  // ── Repo switcher ───────────────────────────────────────────────────────────
  function refreshList(pickBest) {
    return invoke('graph_list').then(function (res) {
      G.repos = res.repos || [];
      if (pickBest && !G.repo) {
        var lv = res.lastViewed;
        var choice = (lv && G.repos.filter(function (r) { return r.repo === lv && r.hasGraph; })[0]) ||
          G.repos.filter(function (r) { return r.hasGraph; })[0] ||
          G.repos[0];
        if (choice) G.repo = choice.repo;
      }
      renderRepoSelect();
      return G.repos;
    }).catch(function () { return []; });
  }

  function renderRepoSelect() {
    var sel = $('repoSel');
    if (!G.repos.length) {
      sel.innerHTML = '<option value="">No repositories detected</option>';
      return;
    }
    sel.innerHTML = G.repos.map(function (r) {
      var dot = r.active ? '● ' : '';
      var meta = r.hasGraph ? (' — ' + (r.nodes || 0) + 'n') : ' — not built';
      return '<option value="' + esc(r.repo) + '"' + (r.repo === G.repo ? ' selected' : '') + '>' +
        dot + esc(r.name) + meta + '</option>';
    }).join('');
    if (G.repo) sel.value = G.repo;
  }

  function load() {
    return invoke('graph_get', { path: currentPath() }).then(function (res) {
      G.repo = res.repo;
      renderRepoSelect();
      ingest(res.graph, res.overlay);
      setEmpty(false);
      $('tools').classList.remove('hidden');
      $('legend').classList.remove('hidden');
      renderLegend();
      restartSim(true);
      invoke('graph_status', { path: G.repo }).then(function (s) { G.live = !!s.watching; paintLive(); }).catch(function () { });
    }).catch(function () {
      $('tools').classList.add('hidden');
      $('legend').classList.add('hidden');
      G.nodes = []; G.edges = [];
      var r = G.repos.filter(function (x) { return x.repo === G.repo; })[0];
      setEmpty(true, r ? 'Not built yet' : 'No graph yet',
        r ? 'This repo is tracked but not built. Click <b>Rebuild</b>, or Terse builds it automatically while an agent works here.' : null);
      requestDraw();
    });
  }

  function build() {
    setEmpty(true, 'Building…', 'Parsing your codebase with tree-sitter — functions, classes, imports and calls.', true);
    $('build').disabled = true; $('build').textContent = 'Building…';
    invoke('graph_build', { path: currentPath() }).then(function (r) {
      $('build').disabled = false; $('build').textContent = 'Rebuild';
      G.repo = r.repo || G.repo;
      showSavings(r);
      toast('Graph built — ' + r.nodes + ' nodes, ' + r.edges + ' edges');
      return refreshList(false).then(load);
    }).catch(function (e) {
      $('build').disabled = false; $('build').textContent = 'Build';
      setEmpty(true, 'Could not build', String(e));
      toast(String(e));
    });
  }

  function showSavings(r) {
    if (!r || r.tokensSaved == null) return;
    var b = $('saveBadge'); b.classList.remove('hidden');
    b.innerHTML = '💾 <b>' + fmt(r.tokensSaved) + '</b> tokens saved vs. reading files';
    $('counts').textContent = '· ' + (r.nodes || 0) + ' nodes · ' + (r.clusters || 0) + ' clusters';
  }
  function fmt(n) { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }

  // ── Ingest backend graph into sim structures (preserve positions by id) ────
  function ingest(graph, overlay) {
    G.graph = graph; G.overlay = overlay || defaultOverlay();
    var prev = G.byId;
    var pinnedSet = {}; (G.overlay.pinned || []).forEach(function (id) { pinnedSet[id] = 1; });

    // Keep the most-connected nodes when very large, so the sim stays smooth.
    var all = (graph.nodes || []).slice().sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
    G.capped = Math.max(0, all.length - MAX_RENDER);
    var keep = all.slice(0, MAX_RENDER);
    var keepSet = {}; keep.forEach(function (n) { keepSet[n.id] = 1; });

    G.nodes = keep.map(function (n) {
      var p = prev[n.id];
      return {
        id: n.id, name: n.name, kind: n.kind, path: n.path, line: n.line,
        lang: n.lang, community: n.community, degree: n.degree || 0,
        manual: !!n.manual, pinned: !!pinnedSet[n.id],
        x: p ? p.x : (Math.random() - 0.5) * 600,
        y: p ? p.y : (Math.random() - 0.5) * 600,
        vx: 0, vy: 0,
      };
    });
    G.byId = {}; G.nodes.forEach(function (n) { G.byId[n.id] = n; });
    G.edges = (graph.edges || []).filter(function (e) { return keepSet[e.src] && keepSet[e.dst]; });

    // Precompute the hubs we're willing to label at default zoom (top by degree),
    // so draw() never has to scan for them each frame.
    G.hubIds = {};
    keep.slice().sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); })
      .slice(0, 26).forEach(function (n) { if ((n.degree || 0) > 0) G.hubIds[n.id] = 1; });

    // Adjacency for neighbor panels + highlight.
    G.adj = {};
    G.edges.forEach(function (e) {
      (G.adj[e.src] = G.adj[e.src] || []).push({ id: e.dst, edge: e, dir: 'out' });
      (G.adj[e.dst] = G.adj[e.dst] || []).push({ id: e.src, edge: e, dir: 'in' });
    });
    $('counts').textContent = '· ' + (graph.nodes ? graph.nodes.length : 0) + ' nodes · ' + (graph.communities || []).length + ' clusters';
    if (G.sel && !G.byId[G.sel]) { G.sel = null; closeDetail(); }
  }
  function defaultOverlay() { return { renames: {}, added_edges: [], removed_edges: [], hidden: [], pinned: [], notes: [] }; }

  // ── Filters ────────────────────────────────────────────────────────────────
  function nodeVisible(n) {
    if (!G.filters.kinds[n.kind]) return false;
    if (G.filters.q) { if ((n.name || '').toLowerCase().indexOf(G.filters.q) < 0 && (n.path || '').toLowerCase().indexOf(G.filters.q) < 0) return false; }
    return true;
  }
  function edgeVisible(e) {
    if (G.filters.inferredOnly && e.confidence !== 'INFERRED') return false;
    var a = G.byId[e.src], b = G.byId[e.dst];
    return a && b && nodeVisible(a) && nodeVisible(b);
  }

  // ── Force simulation ────────────────────────────────────────────────────────
  // The loop STOPS when the layout settles (and on any redraw need). This is the
  // key to smoothness: at rest the tab uses zero CPU instead of redrawing 60fps
  // forever. Interactions call wake()/requestDraw()/reheat() to spin it back up.
  var alpha = 0, running = false, needsDraw = false;

  function wake() { if (!running) { running = true; requestAnimationFrame(frame); } }
  function requestDraw() { needsDraw = true; wake(); }
  function restartSim(fit) { alpha = 1; if (fit) G._fit = true; wake(); }
  function reheat(a) { if (alpha < (a || 0.4)) alpha = a || 0.4; wake(); }

  function frame() {
    var moving = step();
    draw();
    if (moving || G.drag || G.pan || needsDraw) { needsDraw = false; requestAnimationFrame(frame); }
    else { running = false; }
  }

  // One physics step. Repulsion uses a spatial hash so it's ~O(n) not O(n²).
  function step() {
    var ns = G.nodes;
    if (alpha <= 0.006 || !ns.length) return false;
    var kRep = 5200, kSpring = 0.02, L = 60, kGrav = 0.015, damp = 0.86, cell = 90;

    var grid = {};
    for (var i = 0; i < ns.length; i++) {
      var n = ns[i];
      n._cx = Math.round(n.x / cell); n._cy = Math.round(n.y / cell);
      var key = n._cx + ':' + n._cy;
      (grid[key] || (grid[key] = [])).push(n);
    }
    for (i = 0; i < ns.length; i++) {
      var a = ns[i];
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
        var bucket = grid[(a._cx + ox) + ':' + (a._cy + oy)];
        if (!bucket) continue;
        for (var bi = 0; bi < bucket.length; bi++) {
          var c = bucket[bi]; if (c === a) continue;
          var dx = a.x - c.x, dy = a.y - c.y, d2 = dx * dx + dy * dy + 0.01;
          var f = (kRep * alpha) / d2, d = Math.sqrt(d2);
          a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        }
      }
    }
    for (var e = 0; e < G.edges.length; e++) {
      var ed = G.edges[e], sa = G.byId[ed.src], sb = G.byId[ed.dst];
      if (!sa || !sb) continue;
      var ex = sb.x - sa.x, ey = sb.y - sa.y, el = Math.sqrt(ex * ex + ey * ey) + 0.01;
      var sf = (el - L) * kSpring * alpha, sx = (ex / el) * sf, sy = (ey / el) * sf;
      sa.vx += sx; sa.vy += sy; sb.vx -= sx; sb.vy -= sy;
    }
    for (var k = 0; k < ns.length; k++) {
      var q = ns[k];
      q.vx -= q.x * kGrav * alpha; q.vy -= q.y * kGrav * alpha;
      if (q === G.drag) { q.vx = 0; q.vy = 0; continue; }
      q.vx *= damp; q.vy *= damp; q.x += q.vx; q.y += q.vy;
    }
    alpha *= 0.982;
    if (G._fit) { fitView(); G._fit = false; }
    return true;
  }

  function fitView() {
    if (!G.nodes.length) return;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    G.nodes.forEach(function (n) { if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y; if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y; });
    var w = cv.clientWidth, h = cv.clientHeight;
    var gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
    var s = Math.min(w / (gw + 120), h / (gh + 120), 1.6);
    G.view.s = s;
    G.view.x = w / 2 - ((minX + maxX) / 2) * s;
    G.view.y = h / 2 - ((minY + maxY) / 2) * s;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  var DPR = window.devicePixelRatio || 1;
  // getComputedStyle is expensive — read theme colors ONCE, not per node/frame.
  var THEME = { t1: '#fff' };
  function readTheme() { THEME.t1 = cssVar('--t1'); }
  function resize() {
    DPR = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * DPR; cv.height = cv.clientHeight * DPR;
    readTheme();
    requestDraw();
  }

  function draw() {
    var w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.save();
    ctx.translate(G.view.x, G.view.y);
    ctx.scale(G.view.s, G.view.s);

    var hi = highlightSet();

    // Edges.
    ctx.lineWidth = 1 / G.view.s;
    for (var i = 0; i < G.edges.length; i++) {
      var e = G.edges[i];
      if (!edgeVisible(e)) continue;
      var a = G.byId[e.src], b = G.byId[e.dst];
      var active = hi && (hi[e.src] && hi[e.dst]);
      var faded = hi && !active;
      ctx.beginPath();
      if (e.confidence === 'INFERRED') ctx.setLineDash([4 / G.view.s, 3 / G.view.s]); else ctx.setLineDash([]);
      ctx.strokeStyle = e.manual ? 'rgba(245,197,66,' + (faded ? 0.15 : 0.7) + ')'
        : (active ? 'rgba(140,150,170,0.85)' : (faded ? 'rgba(130,140,160,0.07)' : 'rgba(130,140,160,0.28)'));
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Nodes.
    for (var n = 0; n < G.nodes.length; n++) {
      var nd = G.nodes[n];
      if (!nodeVisible(nd)) continue;
      var r = radiusFor(nd);
      var active = !hi || hi[nd.id];
      ctx.globalAlpha = active ? 1 : 0.22;
      ctx.beginPath();
      if (nd.kind === 'concept') { drawDiamond(nd.x, nd.y, r + 1); }
      else { ctx.arc(nd.x, nd.y, r, 0, 6.2832); }
      ctx.fillStyle = colorFor(nd);
      ctx.fill();
      if (nd.id === G.sel) { ctx.lineWidth = 2.5 / G.view.s; ctx.strokeStyle = THEME.t1; ctx.stroke(); }
      else if (nd.kind === 'module' || nd.kind === 'class') { ctx.lineWidth = 1.5 / G.view.s; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke(); }
      if (nd.pinned) { ctx.fillStyle = THEME.t1; ctx.beginPath(); ctx.arc(nd.x + r * 0.7, nd.y - r * 0.7, 2 / G.view.s + 1, 0, 6.2832); ctx.fill(); }
      ctx.globalAlpha = 1;

      // Labels — bounded to hubs / selection / hover-neighborhood (drawing text
      // for every node is a big cost). Hub set is precomputed in ingest().
      var showLabel = nd.id === G.sel || nd.id === G.hover || (hi && hi[nd.id]) ||
        (!hi && (G.hubIds[nd.id] || G.view.s > 1.6)) || nd.kind === 'concept';
      if (showLabel && active) {
        ctx.font = (11 / G.view.s) + 'px -apple-system,system-ui,sans-serif';
        ctx.fillStyle = THEME.t1;
        ctx.textAlign = 'center';
        var label = nd.name.length > 22 ? nd.name.slice(0, 21) + '…' : nd.name;
        ctx.fillText(label, nd.x, nd.y - r - 3 / G.view.s);
      }
    }
    ctx.restore();

    // HUD — only touch the DOM when the text actually changes (not every frame).
    var vis = 0; for (var v = 0; v < G.nodes.length; v++) if (nodeVisible(G.nodes[v])) vis++;
    var hud = vis + ' shown' + (G.capped ? ' · ' + G.capped + ' hidden (top ' + MAX_RENDER + ' by connections)' : '') +
      (G.editMode ? '<br><b style="color:var(--btn)">edit mode</b>' : '');
    if (hud !== G._hud) { G._hud = hud; $('hud').innerHTML = hud; }
  }

  function drawDiamond(x, y, r) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }

  function highlightSet() {
    var focus = G.hover || G.sel;
    if (!focus) return null;
    var set = {}; set[focus] = 1;
    (G.adj[focus] || []).forEach(function (nb) { set[nb.id] = 1; });
    return set;
  }

  // ── Hit testing + interaction ───────────────────────────────────────────────
  function toWorld(px, py) { return { x: (px - G.view.x) / G.view.s, y: (py - G.view.y) / G.view.s }; }
  function nodeAt(px, py) {
    var p = toWorld(px, py), best = null, bd = 1e9;
    for (var i = G.nodes.length - 1; i >= 0; i--) {
      var n = G.nodes[i]; if (!nodeVisible(n)) continue;
      var dx = n.x - p.x, dy = n.y - p.y, d = dx * dx + dy * dy;
      var rr = radiusFor(n) + 4; if (d < rr * rr && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  cv.addEventListener('mousedown', function (ev) {
    var rect = cv.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var hit = nodeAt(px, py);
    if (hit && G.editMode && G.pendingLink) { finishLink(hit); return; }
    if (hit) {
      selectNode(hit.id);
      G.drag = hit; G.dragging = true; G.dragMoved = false;
    } else {
      G.pan = { x: px, y: py, ox: G.view.x, oy: G.view.y };
    }
  });
  window.addEventListener('mousemove', function (ev) {
    var rect = cv.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (G.drag) {
      var p = toWorld(px, py); G.drag.x = p.x; G.drag.y = p.y; G.drag.vx = 0; G.drag.vy = 0;
      G.dragMoved = true; reheat(0.3); return;
    }
    if (G.pan) { G.view.x = G.pan.ox + (px - G.pan.x); G.view.y = G.pan.oy + (py - G.pan.y); requestDraw(); return; }
    var hv = nodeAt(px, py);
    var id = hv ? hv.id : null;
    if (id !== G.hover) { G.hover = id; cv.style.cursor = hv ? 'pointer' : 'default'; requestDraw(); }
  });
  window.addEventListener('mouseup', function () { G.drag = null; G.dragging = false; G.pan = null; });

  cv.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var rect = cv.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var before = toWorld(px, py);
    var factor = Math.exp(-ev.deltaY * 0.0015);
    G.view.s = Math.max(0.15, Math.min(5, G.view.s * factor));
    var after = toWorld(px, py);
    G.view.x += (after.x - before.x) * G.view.s;
    G.view.y += (after.y - before.y) * G.view.s;
    requestDraw();
  }, { passive: false });

  // ── Selection + detail panel ────────────────────────────────────────────────
  function selectNode(id) { G.sel = id; renderDetail(); requestDraw(); }
  function closeDetail() { G.sel = null; $('detail').classList.remove('open'); requestDraw(); }

  function relName(id) { var n = G.byId[id]; return n ? n.name : (id.indexOf('ext::') === 0 ? id.slice(5) : id); }

  function renderDetail() {
    var n = G.byId[G.sel]; if (!n) { closeDetail(); return; }
    $('detail').classList.add('open');
    $('dkindDot').style.background = colorFor(n);
    $('dname').textContent = n.name;
    $('dmeta').textContent = (n.kind) + (n.path ? ' · ' + n.path + (n.line ? ':' + n.line : '') : '') +
      (n.community != null ? ' · C' + n.community : '');

    var outs = [], ins = [];
    (G.adj[n.id] || []).forEach(function (nb) {
      var row = { id: nb.id, kind: nb.edge.kind, inf: nb.edge.confidence === 'INFERRED', manual: nb.edge.manual };
      if (nb.dir === 'out') outs.push(row); else ins.push(row);
    });

    var body = '';
    body += sec('Outgoing (' + outs.length + ')', outs);
    body += sec('Incoming (' + ins.length + ')', ins);

    if (G.editMode) {
      body += '<div class="dsec"><h5>Rename (overlay)</h5><div class="edit-row">' +
        '<input id="renameIn" value="' + esc(n.name) + '"><button class="btn" id="renameBtn">Set</button></div></div>';
    }
    $('dbody').innerHTML = body;

    // Neighbor click-through.
    Array.prototype.forEach.call($('dbody').querySelectorAll('.nb'), function (el) {
      el.addEventListener('click', function () { if (G.byId[el.dataset.id]) selectNode(el.dataset.id); });
    });
    if (G.editMode) {
      $('renameBtn').addEventListener('click', function () {
        var v = $('renameIn').value.trim(); if (!v) return;
        G.overlay.renames[n.id] = v; n.name = v; saveOverlay(); renderDetail(); requestDraw();
      });
    }
    renderActions(n);
  }

  function sec(title, rows) {
    var h = '<div class="dsec"><h5>' + title + '</h5>';
    if (!rows.length) { h += '<div class="empty-nb">none</div></div>'; return h; }
    rows.forEach(function (r) {
      h += '<div class="nb" data-id="' + esc(r.id) + '">' +
        '<span class="rel' + (r.inf ? ' inf' : '') + '">' + r.kind + '</span>' +
        '<span class="nm">' + esc(relName(r.id)) + '</span></div>';
    });
    return h + '</div>';
  }

  function renderActions(n) {
    var a = $('dactions');
    if (!G.editMode) { a.innerHTML = '<button class="btn" id="focusBtn">Center</button>'; wireFocus(n); return; }
    var pinned = (G.overlay.pinned || []).indexOf(n.id) >= 0;
    var hidden = false; // selected node is by definition visible
    a.innerHTML =
      '<button class="btn" id="pinBtn">' + (pinned ? '📌 Unpin' : 'Pin') + '</button>' +
      '<button class="btn" id="linkBtn">＋ Edge from here</button>' +
      '<button class="btn" id="hideBtn">Hide</button>' +
      (n.kind === 'concept' ? '<button class="btn" id="delConcept">Delete note</button>' : '');
    $('pinBtn').addEventListener('click', function () {
      var arr = G.overlay.pinned = G.overlay.pinned || [];
      var i = arr.indexOf(n.id); if (i >= 0) arr.splice(i, 1); else arr.push(n.id);
      n.pinned = i < 0; saveOverlay(); renderDetail(); requestDraw();
    });
    $('linkBtn').addEventListener('click', function () { G.pendingLink = n.id; toast('Click a target node to draw an edge'); });
    $('hideBtn').addEventListener('click', function () {
      (G.overlay.hidden = G.overlay.hidden || []).push(n.id); saveOverlay(); closeDetail(); reingestLocal();
    });
    if (n.kind === 'concept') $('delConcept').addEventListener('click', function () {
      G.overlay.notes = (G.overlay.notes || []).filter(function (x) { return x.id !== n.id; });
      saveOverlay(); closeDetail(); reingestLocal();
    });
    var _ = hidden;
  }
  function wireFocus(n) { var b = $('focusBtn'); if (b) b.addEventListener('click', function () { centerOn(n); }); }
  function centerOn(n) { G.view.x = cv.clientWidth / 2 - n.x * G.view.s; G.view.y = cv.clientHeight / 2 - n.y * G.view.s; requestDraw(); }

  function finishLink(target) {
    var src = G.pendingLink; G.pendingLink = null;
    if (!src || src === target.id) return;
    G.overlay.added_edges = G.overlay.added_edges || [];
    G.overlay.added_edges.push({ src: src, dst: target.id, kind: 'references', confidence: 'EXTRACTED', manual: true });
    saveOverlay(); reingestLocal(); toast('Edge added');
  }

  // Re-run ingest with the current backend graph + edited overlay (no round-trip).
  function reingestLocal() { if (G.graph) { ingest(G.graph, G.overlay); renderLegend(); restartSim(false); if (G.sel) renderDetail(); } }

  var saveTimer = null;
  function saveOverlay() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      invoke('graph_save_overlay', { overlay: G.overlay, path: currentPath() })
        .then(function () { toast('Saved · digest updated'); })
        .catch(function (e) { toast('Save failed: ' + e); });
    }, 350);
  }

  // ── Legend ──────────────────────────────────────────────────────────────────
  function renderLegend() {
    var comms = (G.graph && G.graph.communities) || [];
    var h = '<h4>Clusters</h4>';
    comms.slice(0, 12).forEach(function (c) {
      h += '<div class="row"><span class="sw" style="background:' + CLUSTER_COLORS[c.id % CLUSTER_COLORS.length] + '"></span>' +
        'C' + c.id + ' · ' + esc(c.label) + '</div>';
    });
    h += '<div class="muted">Solid = explicit (EXTRACTED). Dashed = inferred by name. ◆ = your note. Ring = selected.</div>';
    $('legend').innerHTML = h;
  }

  // ── Controls wiring ──────────────────────────────────────────────────────────
  $('back').addEventListener('click', function () { invoke('navigate_back').catch(function () { }); });
  $('build').addEventListener('click', build);
  $('buildEmpty').addEventListener('click', build);

  // Repo switcher — pick a different repo's cached graph.
  $('repoSel').addEventListener('change', function () {
    var v = $('repoSel').value; if (!v) return;
    G.repo = v; G.sel = null; closeDetail();
    var entry = G.repos.filter(function (r) { return r.repo === v; })[0];
    if (entry && entry.hasGraph) load();
    else { G.nodes = []; G.edges = []; setEmpty(true, 'Not built yet',
      'This repo is tracked but not built. Click <b>Rebuild</b>, or Terse builds it automatically while an agent works here.'); requestDraw(); }
  });

  // Manually add a folder to track + build — native folder picker.
  $('addFolder').addEventListener('click', function () {
    invoke('graph_pick_folder').then(function (path) {
      if (!path) return;
      toast('Building ' + path + ' …');
      return invoke('graph_add_folder', { path: path }).then(function (r) {
        G.repo = r.repo; showSavings(r);
        toast('Added — ' + r.nodes + ' nodes');
        return refreshList(false).then(load);
      });
    }).catch(function (e) { toast(String(e)); });
  });

  $('live').addEventListener('click', function () {
    var next = !G.live;
    invoke('graph_set_watch', { enabled: next, path: currentPath() }).then(function (r) {
      G.live = !!(r && r.watching); paintLive();
      toast(G.live ? 'Live — rebuilding on file changes' : 'Live watching off');
    }).catch(function (e) { toast(String(e)); });
  });
  function paintLive() { $('liveDot').classList.toggle('on', G.live); $('live').classList.toggle('on', G.live); }

  $('digest').addEventListener('click', function () {
    invoke('graph_write_digest', { path: currentPath() }).then(function (r) {
      toast('Digest written · ' + fmt(r.tokensSaved) + ' tokens saved');
    }).catch(function (e) { toast(String(e)); });
  });

  $('edit').addEventListener('click', function () {
    G.editMode = !G.editMode;
    $('edit').classList.toggle('on', G.editMode);
    cv.classList.toggle('editing', G.editMode);
    if (!G.editMode) G.pendingLink = null;
    if (G.sel) renderDetail();
    requestDraw();
    if (G.editMode) toast('Edit mode — rename, pin, hide, draw edges, add notes. Double-click canvas for a note.');
  });

  cv.addEventListener('dblclick', function (ev) {
    if (!G.editMode) return;
    var rect = cv.getBoundingClientRect();
    if (nodeAt(ev.clientX - rect.left, ev.clientY - rect.top)) return;
    askText('New concept note', 'e.g. Auth flow').then(function (name) {
      if (!name) return;
      var id = 'concept:' + Date.now();
      G.overlay.notes = G.overlay.notes || [];
      G.overlay.notes.push({ id: id, name: name, note: '', links: G.sel ? [G.sel] : [] });
      saveOverlay(); reingestLocal();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.chip[data-kind]'), function (chip) {
    chip.addEventListener('click', function () {
      var k = chip.dataset.kind;
      G.filters.kinds[k] = G.filters.kinds[k] ? 0 : 1;
      chip.classList.toggle('on', !!G.filters.kinds[k]);
      requestDraw();
    });
  });
  $('fInferred').addEventListener('click', function () {
    G.filters.inferredOnly = G.filters.inferredOnly ? 0 : 1;
    $('fInferred').classList.toggle('on', !!G.filters.inferredOnly); requestDraw();
  });
  $('search').addEventListener('input', function () { G.filters.q = $('search').value.trim().toLowerCase(); requestDraw(); });
  $('dclose').addEventListener('click', closeDetail);
  window.addEventListener('resize', resize);

  // Live rebuild for the repo we're viewing.
  listen('graph-updated', function (payload) {
    var p = payload && payload.repo;
    if (!p || !G.repo || p === G.repo) load();
  }).catch(function () { });
  // Background auto-build finished for some repo → refresh the switcher; if the
  // viewed repo just gained a cached graph, show it.
  listen('graph-registry-updated', function () {
    refreshList(false).then(function () {
      if (!G.nodes.length && G.repo) {
        var e = G.repos.filter(function (r) { return r.repo === G.repo; })[0];
        if (e && e.hasGraph) load();
      }
    });
  }).catch(function () { });

  // ── Boot ── cache-first: list known graphs, open the best one instantly ─────
  resize();
  refreshList(true).then(function (repos) {
    var entry = G.repo && repos.filter(function (r) { return r.repo === G.repo; })[0];
    if (entry && entry.hasGraph) load();
    else setEmpty(true, repos.length ? 'No graph yet' : 'No graph yet');
  });
})();
