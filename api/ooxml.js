/**
 * Terse Docs — true Office (OOXML) export with ZERO extra dependencies.
 *
 * .docx / .xlsx / .pptx are just ZIP archives of XML parts. We ship a tiny ZIP
 * writer (Node's built-in zlib for DEFLATE + a CRC32 table) and serialize the
 * Terse doc model (see doc-model.js) into the minimal valid OOXML part set for
 * each format. Files open in Microsoft Office, Google Docs/Sheets/Slides, Pages,
 * Keynote and LibreOffice.
 *
 * Keeping this dependency-free matches the repo convention (see mcp.js / terse-api.js).
 */
const zlib = require('zlib');

// ──────────────────────────────────────────────────────────────────────────
//  Minimal ZIP writer
// ──────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * files: [{ name, data: Buffer|string }]  → Buffer of a valid .zip
 * Uses DEFLATE; OOXML readers accept it. No data-descriptor (sizes known upfront).
 */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const useStore = compressed.length >= data.length;
    const body = useStore ? data : compressed;
    const method = useStore ? 0 : 8;

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);      // compression
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra len
    parts.push(local, nameBuf, body);

    // Central directory header
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);              // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);             // mod time
    cd.writeUInt16LE(0x21, 14);          // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra len
    cd.writeUInt16LE(0, 32);             // comment len
    cd.writeUInt16LE(0, 34);             // disk #
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);        // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

// ──────────────────────────────────────────────────────────────────────────
//  HTML → text/runs helpers
// ──────────────────────────────────────────────────────────────────────────
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// Parse inline html into formatted runs: [{ text, b, i, u }].
// Recognises <b>/<strong>, <i>/<em>, <u>; <br> becomes a line break; other tags dropped.
function htmlToRuns(html) {
  const runs = [];
  let b = 0, i = 0, u = 0, buf = '';
  const flush = () => {
    if (buf) { runs.push({ text: decodeEntities(buf), b: b > 0, i: i > 0, u: u > 0, br: false }); buf = ''; }
  };
  const re = /<\/?([a-zA-Z0-9]+)[^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    if (m[2] != null) { buf += m[2]; continue; }
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    if (tag === 'br') { flush(); runs.push({ text: '', br: true }); continue; }
    if (tag === 'b' || tag === 'strong') { flush(); b += closing ? -1 : 1; }
    else if (tag === 'i' || tag === 'em') { flush(); i += closing ? -1 : 1; }
    else if (tag === 'u') { flush(); u += closing ? -1 : 1; }
    else if (tag === 'div' || tag === 'p') { if (closing) { flush(); runs.push({ text: '', br: true }); } }
  }
  flush();
  return runs;
}

function htmlToText(html) {
  return htmlToRuns(html).map(r => (r.br ? '\n' : r.text)).join('').trim();
}

// ──────────────────────────────────────────────────────────────────────────
//  DOCX
// ──────────────────────────────────────────────────────────────────────────
const DOCX_HEAD = { title: 60, subtitle: 32, h1: 48, h2: 36, h3: 28 };
const DOCX_JC = { center: 'center', right: 'right', justify: 'both' };

function docParagraph(block) {
  const runs = htmlToRuns(block.html || '');
  const heading = DOCX_HEAD[block.type];
  const isCode = block.type === 'code';
  const isQuote = block.type === 'quote';
  const isList = block.type === 'ul' || block.type === 'ol';
  const isCheck = block.type === 'check';

  const pPr = [];
  if (heading) pPr.push('<w:spacing w:before="160" w:after="80"/>');
  const indent = (block.indent | 0) * 720 + (isQuote ? 480 : 0) + (isList || isCheck ? 360 : 0);
  if (indent) pPr.push(`<w:ind w:left="${indent}"/>`);
  if (DOCX_JC[block.align]) pPr.push(`<w:jc w:val="${DOCX_JC[block.align]}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';

  let runsXml = runs.map(r => {
    if (r.br) return '<w:r><w:br/></w:r>';
    const rPr = [];
    if (heading || r.b) rPr.push('<w:b/>');
    if (r.i) rPr.push('<w:i/>');
    if (r.u) rPr.push('<w:u w:val="single"/>');
    if (heading) rPr.push(`<w:sz w:val="${heading}"/><w:szCs w:val="${heading}"/>`);
    if (block.type === 'subtitle') rPr.push('<w:color w:val="666666"/>');
    if (isCode) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
    const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
    return `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
  }).join('');

  if (isList) runsXml = `<w:r><w:t xml:space="preserve">• </w:t></w:r>` + runsXml;
  if (isCheck) runsXml = `<w:r><w:t xml:space="preserve">${block.checked ? '☑ ' : '☐ '}</w:t></w:r>` + runsXml;
  if (!runsXml) runsXml = '<w:r><w:t/></w:r>';
  return `<w:p>${pPrXml}${runsXml}</w:p>`;
}

function buildDocx(doc) {
  const blocks = (doc.content?.blocks) || [];
  const body = blocks.map(docParagraph).join('');
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

// ──────────────────────────────────────────────────────────────────────────
//  XLSX
// ──────────────────────────────────────────────────────────────────────────
function colLetter(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ── styled, multi-sheet export from a Univer workbook snapshot ──
// Style fields (see Univer IStyleData): bl bold, it italic, ul underline,
// st strikethrough, fs font size (pt), ff font family, cl {rgb} font color,
// bg {rgb} fill, ht horizontal align (1 L, 2 C, 3 R, 4 J), vt vertical
// (1 top, 2 middle, 3 bottom), tb wrap strategy (3 = wrap).
const XLSX_HALIGN = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify' };
const XLSX_VALIGN = { 1: 'top', 2: 'center', 3: 'bottom' };
function argb(c) { const m = /^#?([0-9a-fA-F]{6})/.exec(String(c?.rgb ?? c ?? '')); return m ? 'FF' + m[1].toUpperCase() : null; }

function buildXlsxFromUniver(doc, snap) {
  const stylePool = snap.styles || {};
  const resolveStyle = s => (typeof s === 'string' ? stylePool[s] : s) || null;

  // Deduplicated style registry → styles.xml
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'];
  const xfIndex = new Map();
  const intern = (arr, xml) => { let i = arr.indexOf(xml); if (i < 0) { arr.push(xml); i = arr.length - 1; } return i; };
  function xfFor(s) {
    if (!s) return 0;
    const key = JSON.stringify([s.bl, s.it, s.ul && s.ul.s, s.st && s.st.s, s.fs, s.ff, argb(s.cl), argb(s.bg), s.ht, s.vt, s.tb]);
    if (xfIndex.has(key)) return xfIndex.get(key);
    const f = [];
    if (s.bl) f.push('<b/>');
    if (s.it) f.push('<i/>');
    if (s.ul && s.ul.s) f.push('<u/>');
    if (s.st && s.st.s) f.push('<strike/>');
    f.push(`<sz val="${Number(s.fs) > 0 ? Math.min(409, Number(s.fs)) : 11}"/>`);
    const cl = argb(s.cl); if (cl) f.push(`<color rgb="${cl}"/>`);
    f.push(`<name val="${xmlEsc(s.ff || 'Calibri')}"/>`);
    const fontId = intern(fonts, `<font>${f.join('')}</font>`);
    const bg = argb(s.bg);
    const fillId = bg ? intern(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor rgb="${bg}"/></patternFill></fill>`) : 0;
    const al = [];
    if (XLSX_HALIGN[s.ht]) al.push(`horizontal="${XLSX_HALIGN[s.ht]}"`);
    if (XLSX_VALIGN[s.vt]) al.push(`vertical="${XLSX_VALIGN[s.vt]}"`);
    if (s.tb === 3) al.push('wrapText="1"');
    const xf = `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0"` +
      ` applyFont="1"${fillId ? ' applyFill="1"' : ''}` +
      (al.length ? ` applyAlignment="1"><alignment ${al.join(' ')}/></xf>` : '/>');
    const id = intern(xfs, xf);
    xfIndex.set(key, id);
    return id;
  }

  const order = (Array.isArray(snap.sheetOrder) && snap.sheetOrder.length ? snap.sheetOrder : Object.keys(snap.sheets || {}))
    .filter(id => snap.sheets && snap.sheets[id]);
  const sheetXmls = order.map(sid => {
    const ws = snap.sheets[sid];
    const cellData = ws.cellData || {};
    let maxRow = 0, maxCol = 0;
    const rowsXml = Object.keys(cellData).map(Number).sort((a, b) => a - b).map(r => {
      const row = cellData[r]; if (!row || typeof row !== 'object') return '';
      const cols = Object.keys(row).map(Number).sort((a, b) => a - b).map(c => {
        const cell = row[c]; if (!cell || typeof cell !== 'object') return '';
        if (r > maxRow) maxRow = r; if (c > maxCol) maxCol = c;
        const ref = `${colLetter(c)}${r + 1}`;
        const sAttr = (() => { const id = xfFor(resolveStyle(cell.s)); return id ? ` s="${id}"` : ''; })();
        const raw = cell.v == null ? '' : String(cell.v);
        if (cell.f) {
          const cached = /^-?\d+(\.\d+)?$/.test(raw) ? raw : '0';
          return `<c r="${ref}"${sAttr}><f>${xmlEsc(String(cell.f).replace(/^=/, ''))}</f><v>${xmlEsc(cached)}</v></c>`;
        }
        if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)) return `<c r="${ref}"${sAttr}><v>${raw}</v></c>`;
        if (raw === '') return sAttr ? `<c r="${ref}"${sAttr}/>` : '';
        return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(raw)}</t></is></c>`;
      }).join('');
      if (!cols) return '';
      const rh = ws.rowData && ws.rowData[r] && Number(ws.rowData[r].h);
      const hAttr = rh > 0 ? ` ht="${Math.round(rh * 0.75 * 100) / 100}" customHeight="1"` : '';
      return `<row r="${r + 1}"${hAttr}>${cols}</row>`;
    }).join('');

    const colsXml = (() => {
      const cd = ws.columnData || {};
      const entries = Object.keys(cd).map(Number).sort((a, b) => a - b)
        .filter(c => Number(cd[c] && cd[c].w) > 0)
        .map(c => `<col min="${c + 1}" max="${c + 1}" width="${Math.round(((Number(cd[c].w) - 5) / 7) * 100) / 100}" customWidth="1"/>`);
      return entries.length ? `<cols>${entries.join('')}</cols>` : '';
    })();
    const merges = (Array.isArray(ws.mergeData) ? ws.mergeData : [])
      .map(m => `<mergeCell ref="${colLetter(m.startColumn)}${m.startRow + 1}:${colLetter(m.endColumn)}${m.endRow + 1}"/>`);
    const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<dimension ref="A1:${colLetter(Math.max(maxCol, 0))}${maxRow + 1}"/>` +
      colsXml + `<sheetData>${rowsXml}</sheetData>` + mergeXml + `</worksheet>`;
  });

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
    `<fills count="${fills.length}">${fills.join('')}</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`;

  const usedNames = new Set();
  const sheetMeta = order.map((sid, i) => {
    let name = String(snap.sheets[sid].name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`;
    while (usedNames.has(name.toLowerCase())) name = (name.slice(0, 28) + '_' + i).slice(0, 31);
    usedNames.add(name.toLowerCase());
    return { name, file: `sheet${i + 1}.xml`, rid: `rId${i + 1}` };
  });
  const stylesRid = `rId${order.length + 1}`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetMeta.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="${s.rid}"/>`).join('')}</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheetMeta.map(s => `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`).join('') +
    `<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheetMeta.map(s => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: stylesXml },
    ...sheetXmls.map((data, i) => ({ name: `xl/worksheets/${sheetMeta[i].file}`, data })),
  ]);
}

function buildXlsx(doc) {
  const content = doc.content || {};
  // Univer snapshot present → styled, multi-sheet export
  if (content.univer && content.univer.sheets && Object.keys(content.univer.sheets).length) {
    try { return buildXlsxFromUniver(doc, content.univer); }
    catch (e) { console.error('[ooxml] univer xlsx failed, falling back to plain cells:', e.message); }
  }
  const cells = content.cells || {};
  // Group cells by row.
  const rowMap = new Map();
  let maxRow = 0, maxCol = 0;
  for (const key of Object.keys(cells)) {
    const [r, c] = key.split(',').map(Number);
    if (!rowMap.has(r)) rowMap.set(r, []);
    rowMap.get(r).push({ c, cell: cells[key] });
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  const rowsXml = [...rowMap.keys()].sort((a, b) => a - b).map(r => {
    const cols = rowMap.get(r).sort((a, b) => a.c - b.c).map(({ c, cell }) => {
      const ref = `${colLetter(c)}${r + 1}`;
      const raw = cell.v == null ? '' : String(cell.v);
      if (cell.f) {
        const formula = cell.f.replace(/^=/, '');
        const cached = /^-?\d+(\.\d+)?$/.test(raw) ? raw : '0';
        return `<c r="${ref}"><f>${xmlEsc(formula)}</f><v>${xmlEsc(cached)}</v></c>`;
      }
      if (/^-?\d+(\.\d+)?$/.test(raw) && raw !== '') {
        return `<c r="${ref}"><v>${raw}</v></c>`;
      }
      if (raw === '') return '';
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(raw)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cols}</row>`;
  }).join('');

  const dim = `A1:${colLetter(Math.max(maxCol, 0))}${maxRow + 1}`;
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dim}"/><sheetData>${rowsXml}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEsc((doc.title || 'Sheet1').slice(0, 28))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ]);
}

// ──────────────────────────────────────────────────────────────────────────
//  PPTX
// ──────────────────────────────────────────────────────────────────────────
const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Slide canvas px (960×540, 16:9) → EMU. 12192000/960 = exactly 12700 EMU/px.
const EMU_PER_PX = 12700;
const pxEmu = px => Math.round((Number(px) || 0) * EMU_PER_PX);
function hexClr(c) { const m = /^#?([0-9a-fA-F]{6})$/.exec(String(c || '').trim()); return m ? m[1].toUpperCase() : null; }

// One text body paragraph list from a slide block's html.
function pptParas(html, sizePt, style) {
  const text = htmlToText(html) || '';
  const lines = text.split('\n');
  const st = style || {};
  const algn = { center: 'ctr', right: 'r', justify: 'just' }[st.align];
  const pPr = algn ? `<a:pPr algn="${algn}"/>` : '';
  const rPr = [];
  if (sizePt) rPr.push(`sz="${Math.round(sizePt * 100)}"`);
  if (st.bold) rPr.push('b="1"');
  if (st.italic) rPr.push('i="1"');
  const color = hexClr(st.color);
  const fill = color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : '';
  return lines.map(line =>
    `<a:p>${pPr}<a:r><a:rPr lang="en-US" ${rPr.join(' ')} dirty="0">${fill}</a:rPr><a:t>${xmlEsc(line)}</a:t></a:r></a:p>`
  ).join('') || '<a:p/>';
}

// ── positioned (frame-based) slide elements ──
const PPT_GEOM = { rect: 'rect', round: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', diamond: 'diamond', arrow: 'rightArrow', line: 'rect' };
// Default frames for legacy blocks that predate the positioned editor.
const LEGACY_FRAMES = {
  title: { x: 50, y: 30, w: 860, h: 80 },
  subtitle: { x: 50, y: 130, w: 860, h: 50 },
  body: { x: 50, y: 130, w: 860, h: 370 },
  bullet: { x: 50, y: 130, w: 860, h: 370 },
};
const LEGACY_SIZE_PT = { title: 28, subtitle: 16, body: 14, bullet: 14 };

function pptTextBox(id, block) {
  const f = block.frame || LEGACY_FRAMES[block.type] || { x: 50, y: 130, w: 860, h: 100 };
  const st = block.style || {};
  const sizePt = st.fontSize ? st.fontSize * 0.75 : (LEGACY_SIZE_PT[block.type] || 14);
  const boldStyle = block.type === 'title' ? { ...st, bold: st.bold !== false } : st;
  const isShape = block.type === 'shape';
  const geom = isShape ? (PPT_GEOM[block.shape] || 'rect') : 'rect';
  const fillHex = isShape ? (hexClr(st.bg) || '4285F4') : hexClr(st.bg);
  const fill = fillHex ? `<a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>` : '<a:noFill/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${isShape ? 'Shape' : 'TextBox'} ${id}"/>` +
    `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${pxEmu(f.x)}" y="${pxEmu(f.y)}"/><a:ext cx="${pxEmu(f.w)}" cy="${pxEmu(f.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"${isShape ? ' anchor="ctr"' : ''}><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    pptParas(block.html, sizePt, isShape ? { align: 'center', ...boldStyle } : boldStyle) +
    `</p:txBody></p:sp>`;
}

function pptPicture(id, block, relId) {
  const f = block.frame || { x: 200, y: 120, w: 400, h: 300 };
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${pxEmu(f.x)}" y="${pxEmu(f.y)}"/><a:ext cx="${pxEmu(f.w)}" cy="${pxEmu(f.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function parseDataUrl(src) {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/.exec(String(src || ''));
  if (!m) return null;
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
  try { return { ext, buffer: Buffer.from(m[2], 'base64') }; } catch { return null; }
}

// Build one slide. `media` collects { name, data } image parts; returns
// { xml, rels } where rels are extra relationship entries for this slide.
function buildSlideXml(slide, slideIndex, media) {
  const blocks = slide.blocks || [];
  const shapes = [];
  const rels = [];
  let id = 2, relN = 2; // rId1 = layout

  for (const block of blocks) {
    if (block.type === 'image' && block.src) {
      const img = parseDataUrl(block.src);
      if (img) {
        const name = `image_s${slideIndex + 1}_${media.length + 1}.${img.ext}`;
        media.push({ name: `ppt/media/${name}`, data: img.buffer, ext: img.ext });
        const relId = `rId${relN++}`;
        rels.push(`<Relationship Id="${relId}" Type="${REL}/image" Target="../media/${name}"/>`);
        shapes.push(pptPicture(id++, block, relId));
      }
      continue; // remote-URL images can't be embedded offline — skipped
    }
    if (!htmlToText(block.html) && block.type !== 'shape') continue;
    shapes.push(pptTextBox(id++, block));
  }

  const bgHex = hexClr(slide.bg);
  const bg = bgHex
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="${DML}" xmlns:r="${REL}" xmlns:p="${PML}">` +
    `<p:cSld>${bg}<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join('') +
    `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping ` +
    `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
    `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ` +
    `hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;
  return { xml, rels };
}

const PPTX_THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<a:theme xmlns:a="${DML}" name="Office Theme"><a:themeElements>` +
  `<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
  `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
  `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
  `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
  `</a:fmtScheme></a:themeElements></a:theme>`;

const PPTX_SLIDE_LAYOUT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldLayout xmlns:a="${DML}" xmlns:r="${REL}" xmlns:p="${PML}" type="obj" preserve="1">` +
  `<p:cSld name="Title and Content"><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" ` +
  `accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ` +
  `hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`;

const PPTX_SLIDE_MASTER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldMaster xmlns:a="${DML}" xmlns:r="${REL}" xmlns:p="${PML}">` +
  `<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
  `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`;

function buildPptx(doc) {
  const slides = (doc.content?.slides) || [{ id: 's1', blocks: [] }];

  const files = [];
  const media = [];

  // Slides + their rels (each → the single layout, plus any embedded images)
  slides.forEach((slide, i) => {
    const { xml, rels } = buildSlideXml(slide, i, media);
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: xml });
    files.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        rels.join('') + `</Relationships>`,
    });
  });
  for (const m of media) files.push({ name: m.name, data: m.data });

  // presentation.xml
  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  files.push({
    name: 'ppt/presentation.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="${DML}" xmlns:r="${REL}" xmlns:p="${PML}">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
      `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  });

  // presentation rels: rId1 = master, rId2.. = slides
  const presRels = [`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  slides.forEach((_, i) => {
    presRels.push(`<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`);
  });
  presRels.push(`<Relationship Id="rId${slides.length + 2}" Type="${REL}/theme" Target="theme/theme1.xml"/>`);
  files.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join('')}</Relationships>`,
  });

  // master + layout + theme
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: PPTX_SLIDE_MASTER });
  files.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
  });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: PPTX_SLIDE_LAYOUT });
  files.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  });
  files.push({ name: 'ppt/theme/theme1.xml', data: PPTX_THEME });

  // content types
  const slideOverrides = slides.map((_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join('');
  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Default Extension="gif" ContentType="image/gif"/>` +
      `<Default Extension="webp" ContentType="image/webp"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      slideOverrides + `</Types>`,
  });
  files.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  });

  return zip(files);
}

// ──────────────────────────────────────────────────────────────────────────
const FORMATS = {
  document: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: buildDocx },
  sheet:    { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build: buildXlsx },
  slides:   { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', build: buildPptx },
};

function exportDoc(doc) {
  const fmt = FORMATS[doc.kind];
  if (!fmt) throw new Error('Unknown doc kind: ' + doc.kind);
  return { buffer: fmt.build(doc), ext: fmt.ext, mime: fmt.mime };
}

module.exports = { zip, crc32, buildDocx, buildXlsx, buildPptx, exportDoc, htmlToText, htmlToRuns };
