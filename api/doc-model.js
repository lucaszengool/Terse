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
 *   document : { blocks: [ { id, type, html } ] }
 *   sheet    : { rows, cols, cells: { "r,c": { v, f } } }
 *   slides   : { slides: [ { id, blocks: [ { id, type, html } ] } ] }
 */

const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code'];
const SLIDE_BLOCK_TYPES = ['title', 'subtitle', 'body', 'bullet'];

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
function applyDocOp(c, op) {
  if (!Array.isArray(c.blocks)) c.blocks = [];
  const blocks = c.blocks;
  switch (op.t) {
    case 'block.set': {
      const b = blocks.find(x => x.id === op.id);
      if (!b) return { ok: false, error: 'no block' };
      if (typeof op.html === 'string') b.html = clampStr(op.html, 100000);
      if (op.type && BLOCK_TYPES.includes(op.type)) b.type = op.type;
      return { ok: true, content: c };
    }
    case 'block.insert': {
      const type = BLOCK_TYPES.includes(op.blockType) ? op.blockType : 'p';
      const nb = { id: op.id || rid('b'), type, html: clampStr(op.html || '', 100000) };
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
        c.blocks = op.blocks.slice(0, 5000).map((b, i) => ({
          id: b.id || `b${i}`,
          type: BLOCK_TYPES.includes(b.type) ? b.type : 'p',
          html: clampStr(b.html || '', 100000),
        }));
      }
      return { ok: true, content: c };
    }
    default:
      return { ok: false, error: 'unknown op ' + op.t };
  }
}

// ── sheet ──
function applySheetOp(c, op) {
  if (!c.cells) c.cells = {};
  if (!c.rows) c.rows = 100;
  if (!c.cols) c.cols = 26;
  switch (op.t) {
    case 'cell.set': {
      const r = op.r | 0, col = op.c | 0;
      if (r < 0 || col < 0 || r > 9999 || col > 701) return { ok: false, error: 'oob' };
      const key = `${r},${col}`;
      const v = op.v == null ? '' : clampStr(String(op.v), 8000);
      const f = op.f ? clampStr(String(op.f), 8000) : null;
      if (v === '' && !f) delete c.cells[key];
      else c.cells[key] = f ? { v, f } : { v };
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
function applySlidesOp(c, op) {
  if (!Array.isArray(c.slides)) c.slides = [];
  const slides = c.slides;
  const findSlide = id => slides.find(s => s.id === id);
  switch (op.t) {
    case 'slide.add': {
      const ns = { id: op.id || rid('s'), blocks: [
        { id: (op.id || 's') + 't', type: 'title', html: '' },
        { id: (op.id || 's') + 'b', type: 'body', html: '' },
      ] };
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
    case 'block.set': {
      const s = findSlide(op.slide); if (!s) return { ok: false, error: 'no slide' };
      const b = (s.blocks || []).find(x => x.id === op.id); if (!b) return { ok: false, error: 'no block' };
      if (typeof op.html === 'string') b.html = clampStr(op.html, 100000);
      if (op.type && SLIDE_BLOCK_TYPES.includes(op.type)) b.type = op.type;
      return { ok: true, content: c };
    }
    case 'block.insert': {
      const s = findSlide(op.slide); if (!s) return { ok: false, error: 'no slide' };
      if (!Array.isArray(s.blocks)) s.blocks = [];
      const type = SLIDE_BLOCK_TYPES.includes(op.blockType) ? op.blockType : 'body';
      s.blocks.push({ id: op.id || rid('sb'), type, html: clampStr(op.html || '', 100000) });
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

module.exports = { blankContent, applyOp, BLOCK_TYPES, SLIDE_BLOCK_TYPES };
