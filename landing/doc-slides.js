/**
 * Terse Docs — slides editor, Google-Slides-style.
 *
 * A 960×540 (16:9) canvas of absolutely-positioned elements: text boxes,
 * shapes (rect/round/ellipse/triangle/diamond/arrow/line), and images.
 * Click to select (8 resize handles), drag to move, double-click to edit
 * text, Delete to remove, arrows to nudge. Filmstrip shows true scaled
 * thumbnails; slides can be reordered. Per-slide background color, speaker
 * notes, and a fullscreen Present mode.
 *
 * Element geometry/styling are block props ({frame,style,shape,src}) carried
 * on the same block ops agents use — see doc-model.js.
 */

/* global $, esc, content, sendOp, canEdit, toast, reportCursor, tbPop, paletteHtml, closePops, uid, GOOGLE_COLORS */

let curSlide = 0, selEl = null, slideEditing = false;
const SLIDE_PH = { title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text', bullet: 'List item', text: 'Text', shape: '' };
// Default frames for legacy blocks created before the positioned editor.
const SLIDE_LEGACY = {
  title: { x: 50, y: 30, w: 860, h: 80 }, subtitle: { x: 50, y: 130, w: 860, h: 50 },
  body: { x: 50, y: 130, w: 860, h: 370 }, bullet: { x: 50, y: 130, w: 860, h: 370 },
};
const SLIDE_FSIZE = { title: 40, subtitle: 22, body: 18, bullet: 18, text: 18, shape: 16 };

function slideAt(i) { return content.slides[Math.min(i, content.slides.length - 1)]; }
function blkFrame(b) { return b.frame || SLIDE_LEGACY[b.type] || { x: 280, y: 200, w: 400, h: 100 }; }

// ════════════════════════ TOOLBAR ════════════════════════
function slidesBuildToolbar() {
  $('toolbar').style.display = '';
  $('toolbar').innerHTML = `
    <button class="tb-btn" title="New slide" onclick="slidesNewMenu(this)">＋ <b>New slide</b> ▾</button>
    <button class="tb-btn" title="Delete slide" onclick="slidesDelSlide()">🗑</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" title="Undo" onmousedown="event.preventDefault()" onclick="document.execCommand('undo')">↶</button>
    <button class="tb-btn" title="Redo" onmousedown="event.preventDefault()" onclick="document.execCommand('redo')">↷</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" onclick="slidesAddText()" title="Text box">🔤 Text box</button>
    <button class="tb-btn" onclick="slidesShapeMenu(this)" title="Shape">⬜ Shape ▾</button>
    <button class="tb-btn" onclick="slidesAddImage()" title="Image">🖼 Image</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" id="slb-b" title="Bold" style="font-weight:700" onmousedown="event.preventDefault()" onclick="slidesFmt('bold')">B</button>
    <button class="tb-btn" id="slb-i" title="Italic" style="font-style:italic" onmousedown="event.preventDefault()" onclick="slidesFmt('italic')">I</button>
    <button class="tb-btn" id="slb-u" title="Underline" style="text-decoration:underline" onmousedown="event.preventDefault()" onclick="slidesFmt('underline')">U</button>
    <select class="tb-sel" id="sl-size" title="Font size" style="max-width:64px" onchange="slidesFontSize(+this.value)">
      ${[10, 12, 14, 16, 18, 22, 26, 32, 40, 48, 64].map(s => `<option value="${s}">${s}</option>`).join('')}
    </select>
    <button class="tb-btn" title="Text color" onmousedown="event.preventDefault()" onclick="tbPop(this,paletteHtml('slidesColor'))"><span style="border-bottom:3px solid #ea4335;line-height:1">A</span></button>
    <button class="tb-btn" title="Fill color (shape)" onclick="tbPop(this,paletteHtml('slidesFill'))">🎨</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" title="Slide background" onclick="tbPop(this,paletteHtml('slidesBg'))">Background</button>
    <span class="grow"></span>
    <button class="tb-btn" style="background:#1a73e8;color:#fff;font-weight:600;padding:0 14px" onclick="slidesPresent()">▶ Present</button>`;
}
function slidesNewMenu(btn) {
  tbPop(btn, `
    <button onclick="slidesAddSlide('title')">Title slide</button>
    <button onclick="slidesAddSlide('body')">Title and body</button>
    <button onclick="slidesAddSlide('blank')">Blank</button>`);
}
function slidesShapeMenu(btn) {
  const kinds = [['rect', '▭ Rectangle'], ['round', '▢ Rounded'], ['ellipse', '◯ Ellipse'], ['triangle', '△ Triangle'], ['diamond', '◇ Diamond'], ['arrow', '→ Arrow'], ['line', '— Line']];
  tbPop(btn, kinds.map(([k, l]) => `<button onclick="slidesAddShape('${k}')">${l}</button>`).join(''));
}

// ════════════════════════ RENDER ════════════════════════
function slidesRender() {
  curSlide = Math.min(curSlide, content.slides.length - 1);
  $('stage').innerHTML = `
    <div class="slides-wrap">
      <div class="filmstrip" id="film"></div>
      <div class="slide-area">
        <div class="slide-stage"><div class="slide-canvas" id="canvas"></div></div>
        <div class="notesbar">🗒 <textarea id="notes" placeholder="Click to add speaker notes" onblur="slidesSaveNotes()" ${canEdit() ? '' : 'readonly'}></textarea></div>
      </div>
    </div>`;
  slidesRenderFilm(); slidesRenderCanvas();
  if (!window._slidesKeysBound) { document.addEventListener('keydown', slidesKeydown); window._slidesKeysBound = true; }
}
function slideElsHtml(s, interactive) {
  return (s.blocks || []).map(b => {
    const f = blkFrame(b);
    const st = b.style || {};
    const pos = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px`;
    if (b.type === 'image') {
      return `<div class="sel" data-id="${b.id}" style="${pos}"><img src="${esc(b.src || '')}" style="width:100%;height:100%;object-fit:contain" draggable="false"/>${handlesHtml()}</div>`;
    }
    const fs = st.fontSize || SLIDE_FSIZE[b.type] || 18;
    const tstyle = `font-size:${fs}px;${st.color ? 'color:' + st.color + ';' : ''}${st.bold ? 'font-weight:700;' : ''}${st.italic ? 'font-style:italic;' : ''}${st.align ? 'text-align:' + st.align + ';' : ''}${b.type === 'title' ? 'font-weight:600;' : ''}${b.type === 'subtitle' ? 'color:#5f6368;' : ''}`;
    if (b.type === 'shape') {
      const fill = st.bg || '#4285f4';
      return `<div class="sel" data-id="${b.id}" style="${pos}">
        <div class="shape-fill ${b.shape || 'rect'}" style="background:${fill}"></div>
        <div class="sbody stext overlay" data-ph="" style="${tstyle}${st.color ? '' : 'color:#fff;'}" ${interactive ? '' : 'contenteditable="false"'}>${b.html || ''}</div>${handlesHtml()}</div>`;
    }
    return `<div class="sel" data-id="${b.id}" style="${pos}">
      <div class="sbody stext ${b.type === 'bullet' ? 'bullet' : ''}" data-ph="${SLIDE_PH[b.type] || ''}" style="${tstyle}">${b.html || ''}</div>${handlesHtml()}</div>`;
  }).join('');
}
function handlesHtml() { return ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].map(h => `<div class="hd ${h}" data-h="${h}"></div>`).join(''); }

function slidesRenderCanvas() {
  const s = slideAt(curSlide); if (!s) return;
  const c = $('canvas'); if (!c) return;
  c.style.background = s.bg || '#fff';
  c.innerHTML = slideElsHtml(s, true);
  c.querySelectorAll('.sel').forEach(slidesBindEl);
  c.onmousedown = e => { if (e.target === c) slidesSelect(null); };
  const notes = $('notes'); if (notes) notes.value = s.notes || '';
  selEl = null;
}
function slidesRenderFilm() {
  const f = $('film'); if (!f) return;
  f.innerHTML = content.slides.map((s, i) => `
    <div class="thumb ${i === curSlide ? 'active' : ''}" onclick="slidesGoto(${i})">
      <div class="num">${i + 1}</div>
      <div class="mini" style="background:${s.bg || '#fff'}"><div class="mini-inner" style="background:${s.bg || '#fff'}">${slideElsHtml(s, false)}</div></div>
      <div class="tmove">${i > 0 ? `<button onclick="event.stopPropagation();slidesMove(${i},-1)">↑</button>` : ''}${i < content.slides.length - 1 ? `<button onclick="event.stopPropagation();slidesMove(${i},1)">↓</button>` : ''}</div>
    </div>`).join('');
}
function slidesGoto(i) { curSlide = i; slidesRenderFilm(); slidesRenderCanvas(); }
function slidesRefreshThumb() { slidesRenderFilm(); }

// ════════════════════════ SELECTION / DRAG / RESIZE ════════════════════════
function slidesSelect(el) {
  document.querySelectorAll('#canvas .sel.selected').forEach(x => x.classList.remove('selected'));
  selEl = el;
  if (el) el.classList.add('selected');
  slidesSyncToolbar();
}
function slidesBlock(id) { const s = slideAt(curSlide); return s && (s.blocks || []).find(b => b.id === id); }
function slidesSelBlock() { return selEl && slidesBlock(selEl.dataset.id); }

function slidesBindEl(el) {
  const body = el.querySelector('.sbody');
  el.addEventListener('mousedown', e => {
    if (!canEdit()) return;
    if (e.target.classList.contains('hd')) { slidesStartResize(e, el, e.target.dataset.h); return; }
    slidesSelect(el);
    if (slideEditing && body && body.contentEditable === 'true') return; // typing
    slidesStartDrag(e, el);
  });
  el.addEventListener('dblclick', () => {
    if (!canEdit() || !body) return;
    slideEditing = true;
    body.contentEditable = 'true';
    body.focus();
    document.execCommand('selectAll', false, null);
    reportCursor({ slide: slideAt(curSlide).id, block: el.dataset.id });
  });
  if (body) {
    body.addEventListener('blur', () => {
      slideEditing = false;
      body.contentEditable = 'false';
      const b = slidesBlock(el.dataset.id); if (!b) return;
      const html = body.innerHTML;
      if (html !== b.html) { b.html = html; sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, html }); slidesRefreshThumb(); }
    });
    body.addEventListener('input', () => {
      const b = slidesBlock(el.dataset.id); if (!b) return;
      b.html = body.innerHTML;
      sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, html: b.html });
    });
    body.contentEditable = 'false';
  }
}
function slidesStartDrag(e, el) {
  e.preventDefault();
  const b = slidesBlock(el.dataset.id); if (!b) return;
  const f = { ...blkFrame(b) };
  const scale = $('canvas').getBoundingClientRect().width / 960;
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const mm = ev => {
    const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    el.style.left = Math.round(f.x + dx) + 'px'; el.style.top = Math.round(f.y + dy) + 'px';
  };
  const mu = ev => {
    document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
    if (!moved) return;
    const frame = { ...f, x: parseInt(el.style.left), y: parseInt(el.style.top) };
    b.frame = frame;
    sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, frame });
    slidesRefreshThumb();
  };
  document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
}
function slidesStartResize(e, el, h) {
  e.preventDefault(); e.stopPropagation();
  const b = slidesBlock(el.dataset.id); if (!b) return;
  const f = { ...blkFrame(b) };
  const scale = $('canvas').getBoundingClientRect().width / 960;
  const sx = e.clientX, sy = e.clientY;
  const mm = ev => {
    const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
    let { x, y, w, hh } = { x: f.x, y: f.y, w: f.w, hh: f.h };
    if (h.includes('e')) w = f.w + dx;
    if (h.includes('s')) hh = f.h + dy;
    if (h.includes('w')) { x = f.x + dx; w = f.w - dx; }
    if (h.includes('n')) { y = f.y + dy; hh = f.h - dy; }
    if (w < 20) w = 20; if (hh < 16) hh = 16;
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
    el.style.width = Math.round(w) + 'px'; el.style.height = Math.round(hh) + 'px';
  };
  const mu = () => {
    document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
    const frame = { x: parseInt(el.style.left), y: parseInt(el.style.top), w: parseInt(el.style.width), h: parseInt(el.style.height) };
    b.frame = frame;
    sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, frame });
    slidesRefreshThumb();
  };
  document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
}
function slidesKeydown(e) {
  if (!selEl || slideEditing || !canEdit()) return;
  if (!document.querySelector('.slides-wrap')) return;
  const b = slidesSelBlock(); if (!b) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const s = slideAt(curSlide);
    s.blocks = s.blocks.filter(x => x.id !== b.id);
    sendOp({ t: 'block.delete', slide: s.id, id: b.id });
    slidesSelect(null); slidesRenderCanvas(); slidesRefreshThumb();
  } else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const f = { ...blkFrame(b) };
    const d = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') f.x -= d; if (e.key === 'ArrowRight') f.x += d;
    if (e.key === 'ArrowUp') f.y -= d; if (e.key === 'ArrowDown') f.y += d;
    b.frame = f;
    selEl.style.left = f.x + 'px'; selEl.style.top = f.y + 'px';
    sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, frame: f });
  }
}

// ════════════════════════ TOOLBAR ACTIONS ════════════════════════
function slidesFmt(cmd) {
  if (slideEditing) { document.execCommand(cmd, false, null); return; }
  const b = slidesSelBlock(); if (!b) { toast('Select an element first'); return; }
  const key = { bold: 'bold', italic: 'italic', underline: 'underline' }[cmd];
  b.style = { ...(b.style || {}) };
  b.style[key] = !b.style[key];
  sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, style: b.style });
  slidesRenderCanvas(); slidesRefreshThumb();
}
function slidesFontSize(px) {
  const b = slidesSelBlock(); if (!b) { toast('Select an element first'); return; }
  b.style = { ...(b.style || {}), fontSize: px };
  sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, style: b.style });
  slidesRenderCanvas(); slidesRefreshThumb();
}
function slidesColor(c) {
  closePops();
  if (slideEditing) { document.execCommand('foreColor', false, c); return; }
  const b = slidesSelBlock(); if (!b) return;
  b.style = { ...(b.style || {}), color: c };
  sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, style: b.style });
  slidesRenderCanvas(); slidesRefreshThumb();
}
function slidesFill(c) {
  closePops();
  const b = slidesSelBlock(); if (!b) { toast('Select a shape first'); return; }
  b.style = { ...(b.style || {}), bg: c };
  sendOp({ t: 'block.set', slide: slideAt(curSlide).id, id: b.id, style: b.style });
  slidesRenderCanvas(); slidesRefreshThumb();
}
function slidesBg(c) {
  closePops();
  const s = slideAt(curSlide);
  s.bg = c;
  sendOp({ t: 'slide.set', id: s.id, bg: c });
  slidesRenderCanvas(); slidesRefreshThumb();
}
function slidesSaveNotes() {
  const s = slideAt(curSlide);
  const v = $('notes').value;
  if (v !== (s.notes || '')) { s.notes = v; sendOp({ t: 'slide.set', id: s.id, notes: v }); }
}
function slidesAddSlide(layout) {
  closePops();
  const id = uid('s');
  const after = slideAt(curSlide)?.id;
  sendOp({ t: 'slide.add', after, id, layout });
  // local mirror of doc-model slide.add
  let blocks;
  if (layout === 'blank') blocks = [];
  else if (layout === 'title') blocks = [
    { id: id + 't', type: 'title', html: '', frame: { x: 80, y: 200, w: 800, h: 80 } },
    { id: id + 's', type: 'subtitle', html: '', frame: { x: 160, y: 300, w: 640, h: 50 } }];
  else blocks = [
    { id: id + 't', type: 'title', html: '', frame: { x: 50, y: 30, w: 860, h: 70 } },
    { id: id + 'b', type: 'body', html: '', frame: { x: 50, y: 120, w: 860, h: 380 } }];
  const i = content.slides.findIndex(s => s.id === after);
  content.slides.splice(i < 0 ? content.slides.length : i + 1, 0, { id, blocks });
  curSlide = i < 0 ? content.slides.length - 1 : i + 1;
  slidesRenderFilm(); slidesRenderCanvas();
}
function slidesDelSlide() {
  if (content.slides.length <= 1) return;
  const id = slideAt(curSlide).id;
  content.slides.splice(curSlide, 1);
  sendOp({ t: 'slide.delete', id });
  curSlide = Math.max(0, curSlide - 1);
  slidesRenderFilm(); slidesRenderCanvas();
}
function slidesMove(i, d) {
  const s = content.slides[i];
  const j = i + d;
  if (j < 0 || j >= content.slides.length) return;
  content.slides.splice(i, 1);
  content.slides.splice(j, 0, s);
  sendOp({ t: 'slide.move', id: s.id, after: j > 0 ? content.slides[j - 1].id : null });
  if (curSlide === i) curSlide = j; else if (curSlide === j) curSlide = i;
  slidesRenderFilm(); slidesRenderCanvas();
}
function slidesInsertBlock(block) {
  const s = slideAt(curSlide);
  s.blocks = s.blocks || [];
  s.blocks.push(block);
  sendOp({ t: 'block.insert', slide: s.id, id: block.id, blockType: block.type, html: block.html || '', frame: block.frame, style: block.style, shape: block.shape, src: block.src });
  slidesRenderCanvas(); slidesRefreshThumb();
  const el = document.querySelector(`#canvas .sel[data-id="${block.id}"]`);
  if (el) slidesSelect(el);
}
function slidesAddText() { slidesInsertBlock({ id: uid('sb'), type: 'text', html: '', frame: { x: 330, y: 230, w: 300, h: 60 } }); }
function slidesAddShape(kind) { closePops(); slidesInsertBlock({ id: uid('sb'), type: 'shape', shape: kind, html: '', frame: { x: 360, y: 200, w: 240, h: kind === 'line' ? 24 : 140 }, style: { bg: '#4285f4' } }); }
function slidesAddImage() {
  const url = prompt('Image URL (or leave empty to upload a file):', '');
  if (url === null) return;
  if (url.trim()) { slidesInsertBlock({ id: uid('sb'), type: 'image', src: url.trim(), frame: { x: 280, y: 120, w: 400, h: 300 } }); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 900 / img.width, 500 / img.height);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * Math.min(1, 1200 / img.width));
      cv.height = Math.round(img.height * (cv.width / img.width));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      slidesInsertBlock({ id: uid('sb'), type: 'image', src: cv.toDataURL('image/jpeg', 0.82), frame: { x: Math.round((960 - w) / 2), y: Math.round((540 - h) / 2), w, h } });
    };
    img.src = URL.createObjectURL(file);
  };
  inp.click();
}
function slidesSyncToolbar() {
  const b = slidesSelBlock();
  const st = (b && b.style) || {};
  $('slb-b')?.classList.toggle('active', !!st.bold);
  $('slb-i')?.classList.toggle('active', !!st.italic);
  $('slb-u')?.classList.toggle('active', !!st.underline);
  const sz = $('sl-size'); if (sz && b) sz.value = st.fontSize || SLIDE_FSIZE[b.type] || 18;
}

// ════════════════════════ PRESENT MODE ════════════════════════
let presentIdx = 0;
function slidesPresent() {
  presentIdx = curSlide;
  const ov = document.createElement('div');
  ov.className = 'present-ov'; ov.id = 'present-ov';
  ov.innerHTML = `<div class="slide-canvas" id="present-canvas"></div><div class="present-nav" id="present-nav"></div>`;
  document.body.appendChild(ov);
  const fit = Math.min(innerWidth / 960, innerHeight / 540) * 0.96;
  ov.firstChild.style.transform = `scale(${fit})`;
  slidesPresentDraw();
  ov.onclick = () => slidesPresentStep(1);
  document.addEventListener('keydown', slidesPresentKeys);
  (ov.requestFullscreen || (() => {})).call(ov)?.catch?.(() => {});
}
function slidesPresentDraw() {
  const s = content.slides[presentIdx];
  const c = $('present-canvas');
  c.style.background = s.bg || '#fff';
  c.innerHTML = slideElsHtml(s, false);
  $('present-nav').textContent = `${presentIdx + 1} / ${content.slides.length} — Esc to exit`;
}
function slidesPresentStep(d) {
  presentIdx = Math.min(content.slides.length - 1, Math.max(0, presentIdx + d));
  slidesPresentDraw();
}
function slidesPresentKeys(e) {
  if (!$('present-ov')) { document.removeEventListener('keydown', slidesPresentKeys); return; }
  if (e.key === 'Escape') { $('present-ov').remove(); document.exitFullscreen?.().catch(() => {}); }
  else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') slidesPresentStep(1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') slidesPresentStep(-1);
}

// ════════════════════════ REMOTE OPS ════════════════════════
function slidesApplyRemote(op) {
  const S = content.slides;
  const fs = id => S.find(s => s.id === id);
  if (op.t === 'slide.add') {
    const id = op.id;
    let blocks;
    if (op.layout === 'blank') blocks = [];
    else if (op.layout === 'title') blocks = [
      { id: id + 't', type: 'title', html: '', frame: { x: 80, y: 200, w: 800, h: 80 } },
      { id: id + 's', type: 'subtitle', html: '', frame: { x: 160, y: 300, w: 640, h: 50 } }];
    else blocks = [
      { id: id + 't', type: 'title', html: '', frame: { x: 50, y: 30, w: 860, h: 70 } },
      { id: id + 'b', type: 'body', html: '', frame: { x: 50, y: 120, w: 860, h: 380 } }];
    const i = op.after ? S.findIndex(s => s.id === op.after) : -1;
    S.splice(i < 0 ? S.length : i + 1, 0, { id, blocks });
  } else if (op.t === 'slide.delete') {
    const i = S.findIndex(s => s.id === op.id);
    if (i >= 0 && S.length > 1) { S.splice(i, 1); if (curSlide >= S.length) curSlide = S.length - 1; }
  } else if (op.t === 'slide.move') {
    const i = S.findIndex(s => s.id === op.id);
    if (i >= 0) { const [s] = S.splice(i, 1); const j = op.after ? S.findIndex(x => x.id === op.after) : -1; S.splice(j < 0 ? 0 : j + 1, 0, s); }
  } else if (op.t === 'slide.set') {
    const s = fs(op.id); if (s) { if (op.bg !== undefined) s.bg = op.bg; if (op.notes !== undefined) s.notes = op.notes; }
  } else if (op.t === 'block.set') {
    const s = fs(op.slide); const b = s && (s.blocks || []).find(x => x.id === op.id);
    if (b) {
      if (op.html != null) b.html = op.html;
      if (op.type) b.type = op.type;
      for (const k of ['frame', 'style', 'shape', 'src']) if (op[k] !== undefined) b[k] = op[k];
    }
  } else if (op.t === 'block.insert') {
    const s = fs(op.slide);
    if (s) {
      const nb = { id: op.id, type: op.blockType || 'body', html: op.html || '' };
      for (const k of ['frame', 'style', 'shape', 'src']) if (op[k] !== undefined) nb[k] = op[k];
      (s.blocks = s.blocks || []).push(nb);
    }
  } else if (op.t === 'block.delete') {
    const s = fs(op.slide); if (s) s.blocks = (s.blocks || []).filter(x => x.id !== op.id);
  }
  // re-render, preserving text being typed: skip canvas refresh while editing
  slidesRenderFilm();
  if (!slideEditing) {
    const selId = selEl?.dataset?.id;
    slidesRenderCanvas();
    if (selId) { const el = document.querySelector(`#canvas .sel[data-id="${selId}"]`); if (el) slidesSelect(el); }
  }
}
