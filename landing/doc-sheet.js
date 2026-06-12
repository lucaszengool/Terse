/**
 * Terse Docs — spreadsheet editor (Univer Sheets via CDN) + collab bridge.
 *
 * Univer (Apache-2.0) provides the Google-Sheets-grade UI: ribbon toolbar,
 * formula bar & engine, styles, conditional formatting, filters, fill handle,
 * right-click menus, multiple sheets. We do NOT use Univer's paid collab —
 * instead we bridge to the existing Terse op/SSE channel:
 *
 *   outgoing  univerAPI.onCommandExecuted → 'sheet.mutation.*' → sendOp({t:'sheet.mut',…})
 *             + debounced full workbook snapshot ({t:'sheet.snapshot'}) so the
 *             server re-extracts plain cells for agents/MCP and .xlsx export.
 *   incoming  SSE op 'sheet.mut'  → univerAPI.syncExecuteCommand(id, params)
 *             SSE op 'cell.set' / 'range.set' (agents) → Facade range.setValue
 *
 * Echo control: our own ops come back with our actor_id and are dropped by the
 * shared stream handler; remote mutations are applied under `sheetApplying` so
 * onCommandExecuted ignores them.
 */

/* global $, content, doc, docId, sendOp, canEdit, toast, reportCursor */

let univerAPI = null, univerWB = null;
let sheetApplying = false;     // applying a remote change — don't rebroadcast
let sheetSnapTimer = null;
let sheetBooted = false;

const UNIVER_CDN = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/rxjs/dist/bundles/rxjs.umd.min.js',
  'https://unpkg.com/@univerjs/presets/lib/umd/index.js',
  'https://unpkg.com/@univerjs/preset-sheets-core/lib/umd/index.js',
  'https://unpkg.com/@univerjs/preset-sheets-core/lib/umd/locales/en-US.js',
];
const UNIVER_CSS = 'https://unpkg.com/@univerjs/preset-sheets-core/lib/index.css';

function loadScript(src) {
  return new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => bad(new Error('failed ' + src));
    document.head.appendChild(s);
  });
}

async function sheetInit() {
  if (sheetBooted) { sheetReload(); return; }
  const stage = $('stage');
  stage.innerHTML = '<div id="univer-host"></div><div id="sheet-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#5f6368;font-size:14px;background:#f8f9fa">Loading spreadsheet…</div>';
  try {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = UNIVER_CSS;
    document.head.appendChild(css);
    for (const src of UNIVER_CDN) await loadScript(src); // order matters
    createUniverSheet();
    sheetBooted = true;
    $('sheet-loading')?.remove();
  } catch (e) {
    console.error('[sheet] univer load failed', e);
    $('sheet-loading').textContent = 'Could not load the spreadsheet engine — check your connection and reload.';
  }
}

function createUniverSheet() {
  const { createUniver } = window.UniverPresets;
  const { LocaleType, mergeLocales } = window.UniverCore;
  const { UniverSheetsCorePreset } = window.UniverPresetSheetsCore;

  const api = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(window.UniverPresetSheetsCoreEnUS) },
    presets: [UniverSheetsCorePreset({ container: 'univer-host' })],
  });
  univerAPI = api.univerAPI;

  univerWB = univerAPI.createWorkbook(sheetSnapshotFromContent());
  window._univerAPI = univerAPI; window._univerWB = univerWB; // console/debug access

  if (!canEdit()) {
    try { univerWB.setEditable(false); } catch {}
  }

  // ── outgoing: every sheet mutation → op channel ──
  univerAPI.onCommandExecuted((command) => {
    if (sheetApplying || !canEdit()) return;
    const id = command?.id || '';
    if (!id.startsWith('sheet.mutation.')) return;
    let params;
    try {
      const json = JSON.stringify(command.params || {});
      if (json.length > 400000) { scheduleSheetSnapshot(); return; } // huge paste → snapshot only
      params = JSON.parse(json);
    } catch { return; }
    sendOp({ t: 'sheet.mut', id, params });
    scheduleSheetSnapshot();
  });

  // report the active cell for presence
  try {
    univerAPI.addEvent(univerAPI.Event.SelectionChanged, (p) => {
      const r = p?.selections?.[0]?.range || p?.selections?.[0];
      if (r && typeof r.startRow === 'number') reportCursor({ cell: sheetColL(r.startColumn) + (r.startRow + 1) });
    });
  } catch {}
}

function sheetColL(n) { let s = ''; n = (n | 0) + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

// Build a Univer workbook snapshot: prefer the last full snapshot (styles,
// widths, merges, multiple sheets), else synthesize one from plain cells.
function sheetSnapshotFromContent() {
  if (content.univer && content.univer.sheets) {
    const snap = JSON.parse(JSON.stringify(content.univer));
    snap.id = docId;
    return snap;
  }
  const cellData = {};
  for (const k of Object.keys(content.cells || {})) {
    const [r, c] = k.split(',').map(Number);
    (cellData[r] = cellData[r] || {})[c] = modelCellToUniver(content.cells[k]);
  }
  return {
    id: docId,
    name: doc.title || 'Sheet',
    appVersion: '1',
    locale: 'enUS',
    styles: {},
    sheetOrder: ['sheet1'],
    sheets: {
      sheet1: {
        id: 'sheet1', name: 'Sheet1',
        rowCount: Math.max(content.rows || 100, 200),
        columnCount: Math.max(content.cols || 26, 40),
        cellData,
      },
    },
  };
}
function modelCellToUniver(cell) {
  const out = {};
  if (cell.f) out.f = cell.f;
  if (cell.s && typeof cell.s === 'object') out.s = cell.s;
  if (cell.v !== undefined && cell.v !== '') {
    const n = Number(cell.v);
    out.v = String(cell.v).trim() !== '' && !isNaN(n) ? n : cell.v;
  }
  return out;
}

// Debounced full snapshot push — heals server-side cells (agents, export) and
// persists styles/widths/merges for the next joiner.
function scheduleSheetSnapshot() {
  clearTimeout(sheetSnapTimer);
  sheetSnapTimer = setTimeout(() => {
    try {
      const snap = univerWB.save();
      sendOp({ t: 'sheet.snapshot', snapshot: snap });
    } catch (e) { console.warn('[sheet] snapshot failed', e); }
  }, 2500);
}

// ── incoming remote ops ──
function sheetApplyRemote(op) {
  if (!univerAPI || !univerWB) return;
  sheetApplying = true;
  try {
    if (op.t === 'sheet.mut') {
      try { univerAPI.syncExecuteCommand(op.id, op.params); }
      catch { univerAPI.executeCommand(op.id, op.params); }
    } else if (op.t === 'cell.set') {
      sheetSetCell(op.r, op.c, op);
    } else if (op.t === 'range.set' && Array.isArray(op.cells)) {
      for (let i = 0; i < op.cells.length; i++) {
        const row = op.cells[i]; if (!Array.isArray(row)) continue;
        for (let j = 0; j < row.length; j++) sheetSetCell(op.r + i, op.c + j, row[j] || {});
      }
    }
    // sheet.snapshot markers carry no payload — nothing to do live
  } catch (e) { console.warn('[sheet] remote apply failed', op.t, e); }
  finally { sheetApplying = false; }
}
function sheetSetCell(r, c, cell) {
  const ws = univerWB.getSheets()[0];
  const range = ws.getRange(r | 0, c | 0, 1, 1);
  if (cell.f) range.setValue(cell.f);
  else if (cell.v === '' || cell.v == null) range.setValue(null);
  else { const n = Number(cell.v); range.setValue(String(cell.v).trim() !== '' && !isNaN(n) ? n : String(cell.v)); }
}

// Full reload (SSE reconnect with newer content)
function sheetReload() {
  if (!univerAPI) return;
  try {
    // dispose first — the new workbook reuses the same unit id (docId)
    try { univerWB && univerAPI.disposeUnit(univerWB.getId()); } catch {}
    univerWB = univerAPI.createWorkbook(sheetSnapshotFromContent());
    window._univerWB = univerWB;
    if (!canEdit()) { try { univerWB.setEditable(false); } catch {} }
  } catch (e) { console.warn('[sheet] reload failed', e); }
}
