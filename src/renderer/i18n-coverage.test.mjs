/* Every user-visible string must go through the language mechanism.

   The failure this prevents is quiet: someone adds a label in the language they
   happen to be writing in, it works on their machine, and every other user sees
   a word they cannot read. It is never noticed by the person who introduced it.

   So the rule is mechanical and checkable: markup carries no CJK in a visible
   position, and any window that shows text loads i18n.js. Chinese belongs in the
   dictionaries, not in the templates — including in comments' sibling code.
   Comments themselves are exempt: they are for whoever edits the file. */
import { readFileSync, readdirSync } from 'node:fs';

const R = new URL('./', import.meta.url).pathname;
const CJK = /[一-鿿]/;

let pass = 0; const fails = [];
const ok = (l, c) => (c ? pass++ : fails.push(l));

/** Strip the parts that are for developers, not users. */
function userFacing(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')      // html comments
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
    .replace(/^\s*\/\/.*$/gm, '')         // whole-line comments
    .replace(/(?<![:'"\w])\/\/[^\n]*/g, '')  // trailing comments (not URLs)
    .replace(/<style>[\s\S]*?<\/style>/g, '');
}

// Windows a user actually reads. (Verify harnesses and capture rigs excluded —
// they are development tools and never ship in front of anyone.)
const DEV_ONLY = new Set(['wallpaper-verify.html', '_cap_wp.html', 'onboarding-prototype.html']);
const pages = readdirSync(R).filter(f => f.endsWith('.html') && !DEV_ONLY.has(f));

for (const page of pages) {
  const src = readFileSync(R + page, 'utf8');
  const body = userFacing(src);

  // 1. No CJK sitting in markup or in string literals the UI renders.
  const nodes = [...body.matchAll(/>([^<>{}]+)</g)].map(m => m[1].trim()).filter(t => CJK.test(t));
  const lits = [...body.matchAll(/['"]([^'"\n]{2,120})['"]/g)].map(m => m[1]).filter(t => CJK.test(t));
  ok(`${page}: no hard-coded CJK in markup${nodes.length ? ' — e.g. ' + JSON.stringify(nodes[0].slice(0, 40)) : ''}`, nodes.length === 0);
  ok(`${page}: no hard-coded CJK in rendered strings${lits.length ? ' — e.g. ' + JSON.stringify(lits[0].slice(0, 40)) : ''}`, lits.length === 0);

  // 2. Any page with visible text must load the mechanism.
  const hasText = /<(h1|h2|h3|p|span|label|button|div)[^>]*>[^<>]*[A-Za-z]{3}/.test(body);
  if (hasText) ok(`${page}: loads i18n.js`, /i18n\.js/.test(src));
}

// 3. Data modules that feed the UI must carry keys, not sentences.
for (const mod of ['wallpaper-styles.js']) {
  const body = userFacing(readFileSync(R + mod, 'utf8'));
  const lits = [...body.matchAll(/['"]([^'"\n]{2,120})['"]/g)].map(m => m[1]).filter(t => CJK.test(t));
  ok(`${mod}: ships keys, not literal Chinese${lits.length ? ' — e.g. ' + JSON.stringify(lits[0].slice(0, 30)) : ''}`, lits.length === 0);
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.slice(0, 24).join('\n')); process.exit(1); }
