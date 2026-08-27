/* The custom-parameter layer.
   The rule that matters most is the NEGATIVE one: a user who never opens the
   panel must get pixel-identical output to before. `cinematic` is the wallpaper
   already running on people's desktops, and a merge bug there is a visible
   regression on every existing install. */
import { PRO_STYLES, STYLE_SCHEMA, resolveStyle, getProStyle, readPath, writePath } from './wallpaper-styles.js';

let pass = 0; const fails = [];
const ok = (l, c) => (c ? pass++ : fails.push(l));
const eq = (l, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? pass++ : fails.push(`${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`));

// ── No custom = no change, for every preset ──
for (const st of PRO_STYLES) {
  eq(`${st.id} is untouched with no overrides`, resolveStyle(st.id, null), getProStyle(st.id));
  eq(`${st.id} is untouched with an empty object`, resolveStyle(st.id, {}), getProStyle(st.id));
}

// ── A delta changes only what it names ──
{
  const base = getProStyle('cinematic');
  const out = resolveStyle('cinematic', { glyph: { stagger: 0.5 } });
  eq('the named field changes', out.glyph.stagger, 0.5);
  eq('its siblings do not', out.glyph.twinkle, base.glyph.twinkle);
  eq('other groups do not', out.field, base.field);
  eq('timing does not', out.timing, base.timing);
  ok('the preset itself is not mutated', getProStyle('cinematic').glyph.stagger === base.glyph.stagger);
}

// ── Arrays replace rather than concatenate ──
{
  const out = resolveStyle('cinematic', { dance: [7] });
  eq('a chosen dance pool replaces the preset pool', out.dance, [7]);
}

// ── The same delta re-bases onto a different preset ──
{
  const a = resolveStyle('cinematic', { glyph: { stagger: 0.5 } });
  const b = resolveStyle('zen', { glyph: { stagger: 0.5 } });
  eq('both take the override', [a.glyph.stagger, b.glyph.stagger], [0.5, 0.5]);
  ok('but keep their own identity elsewhere', a.timing.hold !== b.timing.hold);
}

// ── Every schema entry must address a real field ──
for (const f of STYLE_SCHEMA) {
  const v = readPath(getProStyle('cinematic'), f.key);
  ok(`schema key ${f.key} exists on a real style`, v !== undefined);
  if (f.type === 'range') {
    ok(`${f.key} default sits inside its slider range`, v >= f.min && v <= f.max);
  }
  if (f.type === 'multi' || f.type === 'colors') ok(`${f.key} is an array`, Array.isArray(v));
  if (f.type === 'enum') ok(`${f.key} default is one of its options`, Object.values(f.options).includes(v));
}

// ── Path helpers ──
{
  const o = {};
  writePath(o, 'glyph.stagger', 0.3);
  eq('writePath builds missing levels', o, { glyph: { stagger: 0.3 } });
  eq('readPath reads them back', readPath(o, 'glyph.stagger'), 0.3);
  eq('readPath on a missing path is undefined', readPath(o, 'field.nope'), undefined);
}

// ── Every slider must be able to land on its own preset's value ──
// A step that cannot represent the preset makes the knob disagree with the
// number beside it, and makes "reset" look like it changed something.
{
  let bad = [];
  for (const st of PRO_STYLES) {
    for (const f of STYLE_SCHEMA.filter(x => x.type === 'range')) {
      const v = readPath(st, f.key);
      if (typeof v !== 'number') continue;
      const steps = (v - f.min) / f.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) bad.push(`${st.id}.${f.key}=${v} (step ${f.step})`);
    }
  }
  ok(`every preset value is representable by its slider${bad.length ? ' — ' + bad.slice(0,4).join(', ') : ''}`, bad.length === 0);
}
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
