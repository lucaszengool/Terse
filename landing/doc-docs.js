/**
 * Terse Docs — document editor with Google-Docs-style chrome.
 *
 * Keeps the block-level op model (agents edit the same blocks over MCP) and
 * adds the full Google toolbar: undo/redo, print, zoom, paragraph styles
 * (Title/Subtitle/H1–H3/Normal/Quote/Code), font family & size, B/I/U/S,
 * text & highlight color, links, images, alignment, line spacing, lists
 * (bullets / numbers / checklist), indent, clear formatting.
 *
 * Inline formatting lives inside each block's html (contenteditable +
 * execCommand). Paragraph formatting (align/indent/line-height/checked) are
 * block props carried on block.set ops — see doc-model.js.
 */

/* global $, esc, content, sendOp, canEdit, toast, reportCursor, tbPop, paletteHtml, closePops, uid */

const DOC_FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Roboto', 'Roboto Mono', 'Comic Sans MS', 'Impact'];
const DOC_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 36, 48];
const DOC_PH = { p: '', title: 'Title', subtitle: 'Subtitle', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', quote: 'Quote', code: 'Code', ul: 'List item', ol: 'List item', check: 'To-do' };
let docZoom = 1;

// ════════════════════════ TOOLBAR ════════════════════════
const TBI = { // tiny inline svg icons
  undo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  redo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  print: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  link: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  img: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  alignL: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h12M3 18h15"/></svg>',
  alignC: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M6 12h12M5 18h14"/></svg>',
  alignR: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M9 12h12M6 18h15"/></svg>',
  alignJ: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  lh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 6h11M10 12h11M10 18h11M4 5v14M2 7l2-2 2 2M2 17l2 2 2-2"/></svg>',
  ul: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor"/></svg>',
  ol: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 6h11M10 12h11M10 18h11"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14.5" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="21" font-size="7" fill="currentColor" stroke="none">3</text></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m4.5 8 1.5 1.5L8.5 7M12 8h9M12 16h9"/><rect x="3" y="13" width="6" height="6" rx="1"/></svg>',
  indent: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M11 9h10M11 13h10M3 19h18M3 9l4 3-4 3"/></svg>',
  outdent: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M11 9h10M11 13h10M3 19h18M7 9l-4 3 4 3"/></svg>',
  clear: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 7 0 4 0M9 6l3 12M7 18h6M19 14l-4 4M15 14l4 4"/></svg>',
};

function docsBuildToolbar() {
  $('toolbar').style.display = '';
  $('toolbar').innerHTML = `
    <button class="tb-btn" title="Undo (⌘Z)" onmousedown="event.preventDefault()" onclick="document.execCommand('undo')">${TBI.undo}</button>
    <button class="tb-btn" title="Redo (⌘⇧Z)" onmousedown="event.preventDefault()" onclick="document.execCommand('redo')">${TBI.redo}</button>
    <button class="tb-btn" title="Print (⌘P)" onclick="window.print()">${TBI.print}</button>
    <span class="tb-sep"></span>
    <select class="tb-sel" id="tb-zoom" title="Zoom" onchange="docsZoom(this.value)">
      <option value=".5">50%</option><option value=".75">75%</option><option value=".9">90%</option>
      <option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option>
    </select>
    <span class="tb-sep"></span>
    <select class="tb-sel" id="tb-style" title="Styles" onchange="docsSetType(this.value)">
      <option value="p">Normal text</option><option value="title">Title</option><option value="subtitle">Subtitle</option>
      <option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
      <option value="quote">Quote</option><option value="code">Code</option>
    </select>
    <span class="tb-sep"></span>
    <select class="tb-sel" id="tb-font" title="Font" style="max-width:110px" onchange="docsFont(this.value)">
      ${DOC_FONTS.map(f => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('')}
    </select>
    <span class="tb-sep"></span>
    <span class="tb-size" title="Font size">
      <button onmousedown="event.preventDefault()" onclick="docsSizeStep(-1)">−</button>
      <input id="tb-size" value="11" onkeydown="if(event.key==='Enter'){docsSize(+this.value||11);event.preventDefault();}"/>
      <button onmousedown="event.preventDefault()" onclick="docsSizeStep(1)">＋</button>
    </span>
    <span class="tb-sep"></span>
    <button class="tb-btn" id="tbb-b" title="Bold (⌘B)" style="font-weight:700" onmousedown="event.preventDefault()" onclick="docsFmt('bold')">B</button>
    <button class="tb-btn" id="tbb-i" title="Italic (⌘I)" style="font-style:italic" onmousedown="event.preventDefault()" onclick="docsFmt('italic')">I</button>
    <button class="tb-btn" id="tbb-u" title="Underline (⌘U)" style="text-decoration:underline" onmousedown="event.preventDefault()" onclick="docsFmt('underline')">U</button>
    <button class="tb-btn" id="tbb-s" title="Strikethrough" style="text-decoration:line-through" onmousedown="event.preventDefault()" onclick="docsFmt('strikeThrough')">S</button>
    <button class="tb-btn" title="Text color" onmousedown="event.preventDefault()" onclick="tbPop(this,paletteHtml('docsColor'))"><span style="border-bottom:3px solid #ea4335;line-height:1">A</span></button>
    <button class="tb-btn" title="Highlight color" onmousedown="event.preventDefault()" onclick="tbPop(this,paletteHtml('docsHilite'))"><span style="background:#fff176;border-radius:2px;padding:0 3px">A</span></button>
    <span class="tb-sep"></span>
    <button class="tb-btn" title="Insert link (⌘K)" onmousedown="event.preventDefault()" onclick="docsLink()">${TBI.link}</button>
    <button class="tb-btn" title="Insert image" onclick="docsImage()">${TBI.img}</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" id="tba-left" title="Align left" onmousedown="event.preventDefault()" onclick="docsAlign('left')">${TBI.alignL}</button>
    <button class="tb-btn" id="tba-center" title="Align center" onmousedown="event.preventDefault()" onclick="docsAlign('center')">${TBI.alignC}</button>
    <button class="tb-btn" id="tba-right" title="Align right" onmousedown="event.preventDefault()" onclick="docsAlign('right')">${TBI.alignR}</button>
    <button class="tb-btn" id="tba-justify" title="Justify" onmousedown="event.preventDefault()" onclick="docsAlign('justify')">${TBI.alignJ}</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" title="Line spacing" onmousedown="event.preventDefault()" onclick="docsLhMenu(this)">${TBI.lh}</button>
    <button class="tb-btn" title="Checklist" onmousedown="event.preventDefault()" onclick="docsToggleList('check')">${TBI.check}</button>
    <button class="tb-btn" title="Bulleted list" onmousedown="event.preventDefault()" onclick="docsToggleList('ul')">${TBI.ul}</button>
    <button class="tb-btn" title="Numbered list" onmousedown="event.preventDefault()" onclick="docsToggleList('ol')">${TBI.ol}</button>
    <button class="tb-btn" title="Decrease indent" onmousedown="event.preventDefault()" onclick="docsIndent(-1)">${TBI.outdent}</button>
    <button class="tb-btn" title="Increase indent" onmousedown="event.preventDefault()" onclick="docsIndent(1)">${TBI.indent}</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" title="Clear formatting" onmousedown="event.preventDefault()" onclick="docsClear()">${TBI.clear}</button>`;
  document.execCommand('styleWithCSS', false, true);
  document.addEventListener('selectionchange', docsSyncToolbar);
}

function docsZoom(z) { docZoom = +z; const w = $('zoomwrap'); if (w) w.style.transform = `scale(${docZoom})`; }
function docsFmt(cmd) { document.execCommand(cmd, false, null); docsCommitActive(); docsSyncToolbar(); }
function docsColor(c) { closePops(); document.execCommand('foreColor', false, c); docsCommitActive(); }
function docsHilite(c) { closePops(); document.execCommand('hiliteColor', false, c); docsCommitActive(); }
function docsFont(f) { document.execCommand('fontName', false, f); docsCommitActive(); }
function docsSizeStep(d) { const el = $('tb-size'); const cur = +el.value || 11; const next = DOC_SIZES.find(s => d > 0 ? s > cur : false) || (d > 0 ? cur + 2 : ([...DOC_SIZES].reverse().find(s => s < cur) || Math.max(6, cur - 2))); docsSize(next); }
function docsSize(pt) {
  pt = Math.min(120, Math.max(6, pt | 0)); $('tb-size').value = pt;
  // execCommand only supports sizes 1–7 → apply 7 then rewrite to a real pt span
  document.execCommand('fontSize', false, '7');
  const el = docsActiveBlock(); if (!el) return;
  el.querySelectorAll('font[size="7"], span[style*="xxx-large"]').forEach(f => {
    const sp = document.createElement('span'); sp.style.fontSize = pt + 'pt';
    while (f.firstChild) sp.appendChild(f.firstChild);
    f.replaceWith(sp);
  });
  docsCommit(el);
}
function docsLink() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) { toast('Select some text first'); return; }
  const url = prompt('Link URL:', 'https://');
  if (!url) return;
  document.execCommand('createLink', false, url);
  docsCommitActive();
}
function docsImage() {
  const el = docsActiveBlock() || document.querySelector('.blk:last-child');
  const url = prompt('Image URL (or leave empty to upload a file):', '');
  if (url === null) return;
  if (url.trim()) { docsInsertImg(el, url.trim()); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 800 / img.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      docsInsertImg(el, cv.toDataURL('image/jpeg', 0.82));
    };
    img.src = URL.createObjectURL(file);
  };
  inp.click();
}
function docsInsertImg(el, src) {
  if (!el) return;
  el.focus();
  document.execCommand('insertImage', false, src);
  docsCommit(el);
}
function docsLhMenu(btn) {
  tbPop(btn, ['1', '1.15', '1.5', '2'].map(v => `<button onclick="docsLh(${v})">${v === '1.15' ? '1.15 (default)' : v}</button>`).join(''));
}
function docsLh(v) { closePops(); docsBlockProp({ lh: { 1: 1.2, 1.15: 1.6, 1.5: 1.9, 2: 2.4 }[v] || 1.6 }); }
function docsAlign(a) { docsBlockProp({ align: a }); docsSyncToolbar(); }
function docsIndent(d) {
  const b = docsActiveModel(); if (!b) return;
  docsBlockProp({ indent: Math.max(0, (b.indent || 0) + d) });
}
function docsToggleList(type) {
  const b = docsActiveModel(); if (!b) return;
  docsSetType(b.type === type ? 'p' : type);
}
function docsClear() {
  document.execCommand('removeFormat', false, null);
  document.execCommand('unlink', false, null);
  const el = docsActiveBlock();
  if (el) { docsBlockProp({ align: 'left', indent: 0, lh: 1.6 }); docsSetType('p'); docsCommit(el); }
}
function docsSetType(type) {
  const el = docsActiveBlock(); if (!el) return;
  const b = content.blocks.find(x => x.id === el.dataset.id); if (!b) return;
  b.type = type;
  docsApplyBlockAttrs(el, b);
  sendOp({ t: 'block.set', id: b.id, type, html: el.innerHTML });
  el.focus();
}
function docsBlockProp(props) {
  const el = docsActiveBlock(); if (!el) return;
  const b = content.blocks.find(x => x.id === el.dataset.id); if (!b) return;
  Object.assign(b, props);
  if (props.indent === 0) delete b.indent;
  docsApplyBlockAttrs(el, b);
  sendOp({ t: 'block.set', id: b.id, html: el.innerHTML, ...props });
}

// reflect caret context in the toolbar (style dropdown, B/I/U, font size…)
function docsSyncToolbar() {
  const el = docsActiveBlock(); if (!el) return;
  const b = content.blocks.find(x => x.id === el.dataset.id); if (!b) return;
  const st = $('tb-style'); if (st) st.value = ['title', 'subtitle', 'h1', 'h2', 'h3', 'quote', 'code'].includes(b.type) ? b.type : 'p';
  for (const [id, cmd] of [['tbb-b', 'bold'], ['tbb-i', 'italic'], ['tbb-u', 'underline'], ['tbb-s', 'strikeThrough']]) {
    try { $(id)?.classList.toggle('active', document.queryCommandState(cmd)); } catch {}
  }
  const align = b.align || 'left';
  for (const a of ['left', 'center', 'right', 'justify']) $('tba-' + a)?.classList.toggle('active', align === a);
}

// ════════════════════════ RENDER ════════════════════════
function docsRender() {
  const stage = $('stage');
  stage.innerHTML = `<div id="zoomwrap" style="transform:scale(${docZoom})"><div class="ruler"><div class="ticks"></div></div><div class="page" id="page"></div></div>`;
  const page = $('page');
  page.innerHTML = content.blocks.map(docsBlockHtml).join('');
  page.querySelectorAll('.blk').forEach(docsBind);
}
function docsBlockHtml(b) {
  return `<div class="blk ${b.type}" data-id="${b.id}" data-ph="${DOC_PH[b.type] || ''}" ${b.checked ? 'data-checked="1"' : ''} style="${docsBlockStyle(b)}" contenteditable="${canEdit()}">${b.html || ''}</div>`;
}
function docsBlockStyle(b) {
  const s = [];
  if (b.align) s.push('text-align:' + b.align);
  if (b.indent) s.push('margin-left:' + b.indent * 36 + 'px');
  if (b.lh) s.push('line-height:' + b.lh);
  return s.join(';');
}
function docsApplyBlockAttrs(el, b) {
  el.className = 'blk ' + b.type;
  el.dataset.ph = DOC_PH[b.type] || '';
  if (b.checked) el.dataset.checked = '1'; else delete el.dataset.checked;
  el.style.cssText = docsBlockStyle(b);
  el.contentEditable = String(canEdit());
}
function docsActiveBlock() {
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('blk')) return ae;
  return window._lastBlk || null;
}
function docsActiveModel() { const el = docsActiveBlock(); return el && content.blocks.find(x => x.id === el.dataset.id); }
function docsCommitActive() { const el = docsActiveBlock(); if (el) docsCommit(el); }
function docsCommit(el) {
  const b = content.blocks.find(x => x.id === el.dataset.id); if (!b) return;
  b.html = el.innerHTML;
  sendOp({ t: 'block.set', id: b.id, html: el.innerHTML });
}

function docsBind(el) {
  el.addEventListener('input', () => docsCommit(el));
  el.addEventListener('focus', () => { window._lastBlk = el; docsSyncToolbar(); reportCursor({ block: el.dataset.id }); });
  el.addEventListener('mousedown', e => {
    // checkbox hit-zone of checklist blocks
    if (el.classList.contains('check') && e.offsetX < 22) {
      e.preventDefault();
      const b = content.blocks.find(x => x.id === el.dataset.id); if (!b || !canEdit()) return;
      b.checked = b.checked ? 0 : 1;
      docsApplyBlockAttrs(el, b);
      sendOp({ t: 'block.set', id: b.id, html: el.innerHTML, checked: b.checked });
    }
  });
  el.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && (e.metaKey || e.ctrlKey)) { window.open(a.href, '_blank'); e.preventDefault(); }
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const b = content.blocks.find(x => x.id === el.dataset.id);
      const cont = b && ['ul', 'ol', 'check'].includes(b.type) && el.textContent.trim() !== '';
      const newType = cont ? b.type : 'p';
      const id = uid('b');
      const i = content.blocks.findIndex(x => x.id === el.dataset.id);
      const nb = { id, type: newType, html: '' };
      if (b && cont && b.indent) nb.indent = b.indent;
      content.blocks.splice(i + 1, 0, nb);
      sendOp({ t: 'block.insert', after: el.dataset.id, id, blockType: newType, html: '', indent: nb.indent });
      el.insertAdjacentHTML('afterend', docsBlockHtml(nb));
      const ne = document.querySelector(`.blk[data-id="${id}"]`);
      docsBind(ne); docsCaret(ne);
    } else if (e.key === 'Backspace' && el.textContent === '' && el.querySelectorAll('img').length === 0 && content.blocks.length > 1) {
      e.preventDefault();
      const i = content.blocks.findIndex(x => x.id === el.dataset.id);
      const prev = content.blocks[i - 1];
      content.blocks.splice(i, 1);
      sendOp({ t: 'block.delete', id: el.dataset.id });
      el.remove();
      if (prev) { const pe = document.querySelector(`.blk[data-id="${prev.id}"]`); if (pe) docsCaretEnd(pe); }
    } else if (e.key === 'Tab') {
      e.preventDefault(); docsIndent(e.shiftKey ? -1 : 1);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); docsLink();
    }
  });
}
function docsCaret(el) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function docsCaretEnd(el) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }

// ════════════════════════ REMOTE OPS ════════════════════════
function docsApplyRemote(op) {
  const B = content.blocks;
  if (op.t === 'block.set') {
    const b = B.find(x => x.id === op.id); if (!b) return;
    if (op.html != null) b.html = op.html;
    if (op.type) b.type = op.type;
    for (const k of ['align', 'indent', 'lh', 'checked']) if (op[k] !== undefined) { if (op[k]) b[k] = op[k]; else delete b[k]; }
    const el = document.querySelector(`.blk[data-id="${op.id}"]`);
    if (el) { if (el !== document.activeElement && op.html != null) el.innerHTML = op.html; docsApplyBlockAttrs(el, b); }
  } else if (op.t === 'block.insert') {
    const nb = { id: op.id, type: op.blockType || 'p', html: op.html || '' };
    if (op.indent) nb.indent = op.indent;
    const i = op.after ? B.findIndex(x => x.id === op.after) : -1;
    B.splice(i < 0 ? B.length : i + 1, 0, nb);
    docsRender();
  } else if (op.t === 'block.delete') {
    const i = B.findIndex(x => x.id === op.id);
    if (i >= 0 && B.length > 1) B.splice(i, 1);
    docsRender();
  } else if (op.t === 'block.move' || op.t === 'doc.replace') {
    if (op.t === 'doc.replace' && Array.isArray(op.blocks)) content.blocks = op.blocks;
    else if (op.t === 'block.move') {
      const i = B.findIndex(x => x.id === op.id); if (i < 0) return;
      const [b] = B.splice(i, 1);
      const j = op.after ? B.findIndex(x => x.id === op.after) : -1;
      B.splice(j < 0 ? 0 : j + 1, 0, b);
    }
    docsRender();
  }
}
