/**
 * Terse Docs — the document model + op engine.
 *
 * One authoritative JSON snapshot per doc. Every edit is an "op" applied by the
 * server in arrival order (server-authoritative, OT-lite at *block* granularity):
 * two people editing different paragraphs / cells / slides never conflict, so we
 * get Google-Docs-feel concurrency without per-character CRDT machinery.
 *
 * The SAME applyOp runs on the server (to persist the authoritative snapshot and
 * to drive OOXML export) and is mirrored on the client (to apply remote ops live).
 * Keep it pure: (content, op) -> { ok, content } with no side effects.
 *
 * Content shapes
 *   document : { blocks: [ { id, type, html, align?, indent?, lh?, checked? } ] }
 *   sheet    : { rows, cols, cells: { "r,c": { v, f, s? } }, univer? }
 *              `univer` is a full Univer workbook snapshot pushed (debounced) by
 *              the editing client; cells are re-extracted from it on every push,
 *              so agents/export always see fresh values even for styled edits.
 *   slides   : { slides: [ { id, bg?, notes?, blocks: [ { id, type, html,
 *                frame?:{x,y,w,h}, style?, shape?, src? } ] } ] }
 *              frame coords are px in a 960×540 (16:9) slide space.
 */

const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'title', 'subtitle', 'ul', 'ol', 'check', 'quote', 'code'];
const SLIDE_BLOCK_TYPES = ['title', 'subtitle', 'body', 'bullet', 'text', 'shape', 'image'];
const SHAPE_KINDS = ['rect', 'round', 'ellipse', 'triangle', 'diamond', 'arrow', 'line'];
const ALIGNS = ['left', 'center', 'right', 'justify'];

function rid(prefix) {
  // Deterministic-enough unique id; ops usually carry their own id from the client.
  return `${prefix}_${Math.abs(hashStr(prefix + JSON.stringify(Date.now ? '' : ''))).toString(36)}`;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }

function blankContent(kind) {
  if (kind === 'sheet') {
    return { rows: 100, cols: 26, cells: {} };
  }
  if (kind === 'slides') {
    return {
      slides: [
        { id: 's1', blocks: [
          { id: 's1t', type: 'title', html: 'Click to add title' },
          { id: 's1b', type: 'subtitle', html: 'Click to add subtitle' },
        ] },
      ],
    };
  }
  // document
  return { blocks: [{ id: 'b1', type: 'p', html: '' }] };
}

function clampStr(s, n) { return typeof s === 'string' ? s.slice(0, n) : ''; }
function clampNum(x, lo, hi) { const n = Number(x); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }

// Sanitize a small style/props object (plain JSON, bounded size).
function cleanObj(o, maxJson) {
  if (!o || typeof o !== 'object') return undefined;
  try {
    const j = JSON.stringify(o);
    if (j.length > maxJson) return undefined;
    return JSON.parse(j);
  } catch { return undefined; }
}

function cleanFrame(f) {
  if (!f || typeof f !== 'object') return undefined;
  return {
    x: clampNum(f.x, -200, 2000), y: clampNum(f.y, -200, 2000),
    w: clampNum(f.w, 8, 2000), h: clampNum(f.h, 8, 2000),
  };
}

// Apply one op. Returns { ok:true, content } or { ok:false, error }.
// `content` is mutated in place AND returned (callers may rely on either).
function applyOp(content, op, kind) {
  if (!op || typeof op !== 'object') return { ok: false, error: 'bad op' };
  try {
    if (kind === 'sheet') return applySheetOp(content, op);
    if (kind === 'slides') return applySlidesOp(content, op);
    return applyDocOp(content, op);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── document ──
// Shared: copy optional formatting props from an op onto a block.
function setBlockProps(b, op) {
  if (op.align !== undefined) { if (ALIGNS.includes(op.align)) b.align = op.align; else delete b.align; }
  if (op.indent !== undefined) { const i = clampNum(op.indent, 0, 8) | 0; if (i > 0) b.indent = i; else delete b.indent; }
  if (op.lh !== undefined) { const l = clampNum(op.lh, 0.8, 3); if (l && l !== 1.6) b.lh = l; else delete b.lh; }
  if (op.checked !== undefined) { if (op.checked) b.checked = 1; else delete b.checked; }
}

function applyDocOp(c, op) {
  if (!Array.isArray(c.blocks)) c.blocks = [];
  const blocks = c.blocks;
  switch (op.t) {
    case 'block.set': {
      const b = blocks.find(x => x.id === op.id);
      if (!b) return { ok: false, error: 'no block' };
      if (typeof op.html === 'string') b.html = clampStr(op.html, 200000);
      if (op.type && BLOCK_TYPES.includes(op.type)) b.type = op.type;
      setBlockProps(b, op);
      return { ok: true, content: c };
    }
    case 'block.insert': {
      const type = BLOCK_TYPES.includes(op.blockType) ? op.blockType : 'p';
      const nb = { id: op.id || rid('b'), type, html: clampStr(op.html || '', 200000) };
      setBlockProps(nb, op);
      const idx = op.after ? blocks.findIndex(x => x.id === op.after) : -1;
      blocks.splice(idx < 0 ? blocks.length : idx + 1, 0, nb);
      return { ok: true, content: c };
    }
    case 'block.delete': {
      const i = blocks.findIndex(x => x.id === op.id);
      if (i >= 0 && blocks.length > 1) blocks.splice(i, 1);
      else if (i >= 0) { blocks[i].html = ''; blocks[i].type = 'p'; } // keep at least one
      return { ok: true, content: c };
    }
    case 'block.move': {
      const i = blocks.findIndex(x => x.id === op.id);
      if (i < 0) return { ok: false, error: 'no block' };
      const [b] = blocks.splice(i, 1);
      const j = op.after ? blocks.findIndex(x => x.id === op.after) : -1;
      blocks.splice(j < 0 ? 0 : j + 1, 0, b);
      return { ok: true, content: c };
    }
    case 'doc.replace': {
      if (Array.isArray(op.blocks)) {
        c.blocks = op.blocks.slice(0, 5000).map((b, i) => {
          const nb = {
            id: b.id || `b${i}`,
            type: BLOCK_TYPES.includes(b.type) ? b.type : 'p',
            html: clampStr(b.html || '', 200000),
          };
          setBlockProps(nb, b);
          return nb;
        });
      }
      return { ok: true, content: c };
    }
    default:
      return { ok: false, error: 'unknown op ' + op.t };
  }
}

// ── sheet ──
function setCell(c, r, col, cell) {
  const key = `${r},${col}`;
  if (!cell) { delete c.cells[key]; return; }
  const v = cell.v == null ? '' : clampStr(String(cell.v), 8000);
  const f = cell.f ? clampStr(String(cell.f), 8000) : null;
  const s = cleanObj(cell.s, 4000);
  if (v === '' && !f && !s) { delete c.cells[key]; return; }
  const out = { v };
  if (f) out.f = f;
  if (s) out.s = s;
  c.cells[key] = out;
}

// Re-derive content.cells from a Univer workbook snapshot (first worksheet).
// Self-healing: whatever drift incremental mutation handling accumulated, the
// next snapshot push makes agents/export exact again.
function extractCellsFromUniver(c, snapshot) {
  const sheets = snapshot && snapshot.sheets;
  if (!sheets || typeof sheets !== 'object') return;
  const order = Array.isArray(snapshot.sheetOrder) ? snapshot.sheetOrder : Object.keys(sheets);
  const ws = sheets[order[0]];
  const cellData = ws && ws.cellData;
  if (!cellData || typeof cellData !== 'object') return;
  c.cells = {};
  for (const r of Object.keys(cellData)) {
    const row = cellData[r];
    if (!row || typeof row !== 'object') continue;
    for (const col of Object.keys(row)) {
      const cell = row[col];
      if (!cell || typeof cell !== 'object') continue;
      setCell(c, r | 0, col | 0, { v: cell.v, f: cell.f, s: typeof cell.s === 'object' ? cell.s : undefined });
    }
  }
  if (ws.rowCount) c.rows = Math.min(10000, ws.rowCount);
  if (ws.columnCount) c.cols = Math.min(702, ws.columnCount);
}

// Shift cell keys for row/col insert/remove (best-effort mirror of Univer
// structural mutations; the periodic sheet.snapshot heals any miss).
function shiftCells(c, axis, start, count, remove) {
  const next = {};
  for (const key of Object.keys(c.cells)) {
    let [r, col] = key.split(',').map(Number);
    let pos = axis === 'row' ? r : col;
    if (remove) {
      if (pos >= start && pos < start + count) continue; // deleted
      if (pos >= start + count) pos -= count;
    } else if (pos >= start) {
      pos += count;
    }
    if (axis === 'row') r = pos; else col = pos;
    next[`${r},${col}`] = c.cells[key];
  }
  c.cells = next;
}

function applySheetOp(c, op) {
  if (!c.cells) c.cells = {};
  if (!c.rows) c.rows = 100;
  if (!c.cols) c.cols = 26;
  switch (op.t) {
    case 'cell.set': {
      const r = op.r | 0, col = op.c | 0;
      if (r < 0 || col < 0 || r > 9999 || col > 701) return { ok: false, error: 'oob' };
      setCell(c, r, col, { v: op.v, f: op.f, s: op.s });
      return { ok: true, content: c };
    }
    case 'range.set': {
      // { r, c, cells: [[{v,f,s}|null,…],…] } — bulk write, ≤ 20k cells
      const r0 = op.r | 0, c0 = op.c | 0;
      if (!Array.isArray(op.cells)) return { ok: false, error: 'no cells' };
      let n = 0;
      for (let i = 0; i < op.cells.length && i < 1000; i++) {
        const row = op.cells[i];
        if (!Array.isArray(row)) continue;
        for (let j = 0; j < row.length && j < 200; j++) {
          if (n++ > 20000) break;
          const r = r0 + i, col = c0 + j;
          if (r < 0 || col < 0 || r > 9999 || col > 701) continue;
          setCell(c, r, col, row[j]);
        }
      }
      return { ok: true, content: c };
    }
    case 'sheet.mut': {
      // Raw Univer mutation passthrough (clients re-execute it live). The server
      // mirrors the ones that change VALUES so content.cells stays usable by
      // agents/export between snapshot pushes.
      if (typeof op.id !== 'string' || !op.id.startsWith('sheet.mutation.')) return { ok: false, error: 'bad mut' };
      const p = op.params;
      if (p && typeof p === 'object') {
        if (op.id === 'sheet.mutation.set-range-values' && p.cellValue && typeof p.cellValue === 'object') {
          for (const r of Object.keys(p.cellValue)) {
            const row = p.cellValue[r];
            if (!row || typeof row !== 'object') continue;
            for (const col of Object.keys(row)) {
              const cell = row[col];
              const key = `${r | 0},${col | 0}`;
              if (!cell || typeof cell !== 'object') {
                // null clears the value, not the whole cell style — keep s
                const prev = c.cells[key];
                if (prev && prev.s) c.cells[key] = { v: '', s: prev.s }; else delete c.cells[key];
                continue;
              }
              const prev = c.cells[key] || {};
              setCell(c, r | 0, col | 0, {
                v: cell.v !== undefined ? cell.v : prev.v,
                f: cell.f !== undefined ? cell.f : prev.f,
                s: cell.s !== undefined ? (typeof cell.s === 'object' ? cell.s : prev.s) : prev.s,
              });
            }
          }
        } else if (op.id === 'sheet.mutation.insert-row' && p.range) {
          shiftCells(c, 'row', p.range.startRow | 0, (p.range.endRow - p.range.startRow + 1) | 0, false);
        } else if (op.id === 'sheet.mutation.remove-row' && p.range) {
          shiftCells(c, 'row', p.range.startRow | 0, (p.range.endRow - p.range.startRow + 1) | 0, true);
        } else if (op.id === 'sheet.mutation.insert-col' && p.range) {
          shiftCells(c, 'col', p.range.startColumn | 0, (p.range.endColumn - p.range.startColumn + 1) | 0, false);
        } else if (op.id === 'sheet.mutation.remove-col' && p.range) {
          shiftCells(c, 'col', p.range.startColumn | 0, (p.range.endColumn - p.range.startColumn + 1) | 0, true);
        }
      }
      return { ok: true, content: c };
    }
    case 'sheet.snapshot': {
      // Debounced full Univer snapshot from the editing client (≤ 4 MB JSON).
      const snap = op.snapshot;
      if (!snap || typeof snap !== 'object') return { ok: false, error: 'no snapshot' };
      const j = JSON.stringify(snap);
      if (j.length > 4 * 1024 * 1024) return { ok: false, error: 'snapshot too large' };
      c.univer = JSON.parse(j);
      extractCellsFromUniver(c, c.univer);
      return { ok: true, content: c };
    }
    case 'sheet.resize': {
      c.rows = Math.min(10000, Math.max(c.rows, op.rows | 0 || c.rows));
      c.cols = Math.min(702, Math.max(c.cols, op.cols | 0 || c.cols));
      return { ok: true, content: c };
    }
    default:
      return { ok: false, error: 'unknown op ' + op.t };
  }
}

// ── slides ──
function setSlideBlockProps(b, op) {
  if (op.frame !== undefined) { const f = cleanFrame(op.frame); if (f) b.frame = f; }
  if (op.style !== undefined) { const s = cleanObj(op.style, 4000); if (s) b.style = s; else delete b.style; }
  if (op.shape !== undefined) { if (SHAPE_KINDS.includes(op.shape)) b.shape = op.shape; else delete b.shape; }
  if (op.src !== undefined) { const s = clampStr(String(op.src || ''), 500000); if (s) b.src = s; else delete b.src; }
}

function applySlidesOp(c, op) {
  if (!Array.isArray(c.slides)) c.slides = [];
  const slides = c.slides;
  const findSlide = id => slides.find(s => s.id === id);
  switch (op.t) {
    case 'slide.add': {
      const id = op.id || rid('s');
      let blocks;
      if (op.layout === 'blank') blocks = [];
      else if (op.layout === 'title') blocks = [
        { id: id + 't', type: 'title', html: '', frame: { x: 80, y: 200, w: 800, h: 80 } },
        { id: id + 's', type: 'subtitle', html: '', frame: { x: 160, y: 300, w: 640, h: 50 } },
      ];
      else blocks = [
        { id: id + 't', type: 'title', html: '', frame: { x: 50, y: 30, w: 860, h: 70 } },
        { id: id + 'b', type: 'body', html: '', frame: { x: 50, y: 120, w: 860, h: 380 } },
      ];
      const ns = { id, blocks };
      if (op.bg) ns.bg = clampStr(String(op.bg), 40);
      const idx = op.after ? slides.findIndex(s => s.id === op.after) : -1;
      slides.splice(idx < 0 ? slides.length : idx + 1, 0, ns);
      return { ok: true, content: c };
    }
    case 'slide.delete': {
      const i = slides.findIndex(s => s.id === op.id);
      if (i >= 0 && slides.length > 1) slides.splice(i, 1);
      return { ok: true, content: c };
    }
    case 'slide.move': {
      const i = slides.findIndex(s => s.id === op.id);
      if (i < 0) return { ok: false, error: 'no slide' };
      const [s] = slides.splice(i, 1);
      const j = op.after ? slides.findIndex(x => x.id === op.after) : -1;
      slides.splice(j < 0 ? 0 : j + 1, 0, s);
      return { ok: true, content: c };
    }
    case 'slide.set': {
      // Slide-level props: background color, speaker notes.
      const s = findSlide(op.id); if (!s) return { ok: false, error: 'no slide' };
      if (op.bg !== undefined) { const bg = clampStr(String(op.bg || ''), 40); if (bg) s.bg = bg; else delete s.bg; }
      if (op.notes !== undefined) s.notes = clampStr(String(op.notes || ''), 20000);
      return { ok: true, content: c };
    }
    case 'block.set': {
      const s = findSlide(op.slide); if (!s) return { ok: false, error: 'no slide' };
      const b = (s.blocks || []).find(x => x.id === op.id); if (!b) return { ok: false, error: 'no block' };
      if (typeof op.html === 'string') b.html = clampStr(op.html, 200000);
      if (op.type && SLIDE_BLOCK_TYPES.includes(op.type)) b.type = op.type;
      setSlideBlockProps(b, op);
      return { ok: true, content: c };
    }
    case 'block.insert': {
      const s = findSlide(op.slide); if (!s) return { ok: false, error: 'no slide' };
      if (!Array.isArray(s.blocks)) s.blocks = [];
      const type = SLIDE_BLOCK_TYPES.includes(op.blockType) ? op.blockType : 'body';
      const nb = { id: op.id || rid('sb'), type, html: clampStr(op.html || '', 200000) };
      setSlideBlockProps(nb, op);
      s.blocks.push(nb);
      return { ok: true, content: c };
    }
    case 'block.delete': {
      const s = findSlide(op.slide); if (!s) return { ok: false, error: 'no slide' };
      s.blocks = (s.blocks || []).filter(x => x.id !== op.id);
      return { ok: true, content: c };
    }
    default:
      return { ok: false, error: 'unknown op ' + op.t };
  }
}

module.exports = { blankContent, applyOp, BLOCK_TYPES, SLIDE_BLOCK_TYPES, SHAPE_KINDS };
