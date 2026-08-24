/* Two rules that keep getting broken by hand-editing, so they get a test.

   1. One sidebar entry per page. The rail is edited by several people and by
      several sessions; a duplicated block renders twice and looks like a bug in
      the app rather than in the markup.
   2. Pro gates the WRITE, never the preview. Disabling the controls for free
      users means they can never see what Pro looks like — the lock defeats the
      thing it is protecting. Dragging must also never fire an upgrade modal:
      one drag is dozens of events. */
import { readFileSync } from 'node:fs';

const R = new URL('./', import.meta.url).pathname;
const html = readFileSync(R + 'index.html', 'utf8');
const wp = readFileSync(R + 'wallpaper-control.html', 'utf8');

let pass = 0; const fails = [];
const ok = (l, c) => (c ? pass++ : fails.push(l));
const count = (s, re) => (s.match(re) || []).length;

// ── 1. No duplicate rail entries, and one view per page ──
for (const page of ['friends', 'room', 'plaza', 'island', 'settings']) {
  const n = count(html, new RegExp(`data-page="${page}"`, 'g'));
  ok(`sidebar has exactly one "${page}" entry (found ${n})`, n === 1);
}
for (const view of ['friendsView', 'roomView', 'plazaView']) {
  ok(`exactly one #${view}`, count(html, new RegExp(`id="${view}"`, 'g')) === 1);
}

// ── 2. The gate lets free users drive the preview ──
ok('nothing disables the feel sliders any more', !/el\.disabled = !pro/.test(wp));
ok('the sliders are explicitly re-enabled', /if \(el\) el\.disabled = false;/.test(wp));
ok('no control is given the pointer-events lock', !/classList\.toggle\('locked'/.test(wp));
ok('there is a single gate helper', /function proApply\(\)/.test(wp));
ok('it shows a banner instead of blocking', /showPreviewOnly\(\);\s*\n\s*return false;/.test(wp));

// Every continuous control must preview first and write only behind the gate.
for (const [id, setter] of [['sInt', 'setIntensity'], ['sAng', 'setAngle'], ['sQual', 'setQuality']]) {
  const h = wp.slice(wp.indexOf(`$('#${id}').addEventListener`), wp.indexOf(`$('#${id}').addEventListener`) + 420);
  ok(`${id} drives the preview`, h.includes(setter));
  ok(`${id} writes only if proApply()`, /if \(proApply\(\)\) \{ cfg\./.test(h));
  ok(`${id} does not touch cfg before the gate`, h.indexOf('cfg.') > h.indexOf('proApply()'));
}
{
  const h = wp.slice(wp.indexOf("querySelectorAll('.th')"), wp.indexOf("querySelectorAll('.th')") + 400);
  ok('theme previews before the gate', h.includes('setTheme'));
  ok('theme writes only if proApply()', /if \(proApply\(\)\) \{ cfg\.theme/.test(h));
}

// ── 3. Dragging must not fire upgrade modals ──
{
  const tune = wp.slice(wp.indexOf('async function tuneSet'), wp.indexOf('function wirePreviewOnly'));
  ok('fine-tune shows the banner rather than a modal', /showPreviewOnly\(\)/.test(tune));
  ok('fine-tune fires no modal on change', !/requestUpgrade/.test(tune));
  ok('fine-tune still refuses to write when free', /return;\s*\/\/ 预览留着/.test(tune));
}
ok('the banner button is where the upgrade prompt lives', /poUpgrade[\s\S]{0,200}requestUpgrade/.test(wp));

// ── 4. The dead lock interceptor is gone ──
ok('no capture-phase handler swallows clicks on .locked', !/closest\('\.locked'\)/.test(wp));

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
