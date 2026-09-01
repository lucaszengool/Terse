/**
 * Backdrop tests.
 *
 *   node landing/phone/beds.test.js
 *
 * beds.js paints on a canvas, so this stubs one: a recording 2D context that
 * remembers what was drawn. That is enough to catch what actually goes wrong
 * here — a bed that throws, one that paints nothing, a duplicate id, or a
 * palette so bright it makes Home Screen icons unreadable.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, got === want);

// ── A canvas, enough of one ──
function fakeCtx() {
  const calls = [];
  const grad = () => ({ addColorStop: (o, c) => calls.push(['stop', o, c]) });
  return {
    calls,
    globalAlpha: 1, fillStyle: '',
    createLinearGradient: () => grad(),
    createRadialGradient: () => grad(),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    drawImage: () => calls.push(['drawImage']),
  };
}
let lastCtx = null;
global.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext() { lastCtx = fakeCtx(); return lastCtx; },
      toDataURL: (type, q) => `data:${type || 'image/png'};base64,STUB(${q})`,
    };
  },
};
global.window = {};
require('./beds.js');
const B = global.window.TerseBeds;

console.log('\nBackdrops\n');

const beds = B.list();
ok('there are several to choose from', beds.length >= 6);
eq('the default is one of them', !!B.get(B.DEFAULT_ID), true);

// A duplicate id would make one bed unselectable and silently shadow another.
const ids = B.ids();
eq('every id is unique', new Set(ids).size, ids.length);

// Both languages, because the picker shows a caption under each thumbnail and a
// missing one renders as an empty label rather than falling back.
beds.forEach((b) => {
  ok(`${b.id} has both names`, !!b.en && !!b.zh);
  ok(`${b.id} has a two-colour swatch`, Array.isArray(b.swatch) && b.swatch.length === 2);
});

// Each must actually paint. A bed that runs but draws nothing is a black
// wallpaper, which is exactly the bug this whole feature exists to fix.
beds.forEach((b) => {
  lastCtx = null;
  B.render(b.id, 40, 80);
  const fills = lastCtx.calls.filter((c) => c[0] === 'fillRect').length;
  ok(`${b.id} paints something`, fills >= 2);
  ok(`${b.id} adds colour stops`, lastCtx.calls.some((c) => c[0] === 'stop'));
});

// Dark enough to sit behind icons and a clock. Checked on the declared swatch,
// which is what the palette is chosen from — a bed whose ground is bright is a
// wallpaper people change back within a day.
function luma(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) / 255;
}
beds.forEach((b) => {
  ok(`${b.id} keeps its ground dark`, luma(b.swatch[1]) < 0.30);
});

// ── Rendering ──
ok('render returns a jpeg data URL', /^data:image\/jpeg;/.test(B.render('aurora', 20, 40)));
ok('an unknown id falls back rather than throwing', /^data:image\/jpeg;/.test(B.render('nope', 20, 40)));
ok('a thumbnail renders', /^data:image\/jpeg;/.test(B.thumb('aurora', 60)));

// A zero or negative size would come from an unlaid-out element; it must clamp
// rather than produce an invalid canvas.
ok('a zero size does not throw', (() => {
  try { B.render('aurora', 0, 0); return true; } catch (e) { return false; }
})());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
