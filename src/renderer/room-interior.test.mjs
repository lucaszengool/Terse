/**
 * room-interior.js —— 走进一座楼之后的文法和平面图(纯函数那一半)。
 *
 *   node --import ./src/renderer/testkit/loader.mjs src/renderer/room-interior.test.mjs
 *
 * 画出来的样子要靠截图看;这里钉的是**不会在截图里报错**的那几件:同一个目录
 * 每次是同一间屋子、风格够不到别人的件、第五个子目录的文件没有被丢掉、老胶囊
 * 说得出自己是老的。
 */
import { interiorOf, interiorVariants, layoutOf, fileLight, PAD, INTERIOR } from './room-interior.js';
import { langOfFile } from './lang-colors.js';

let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); }
};

/* ══ 文法 ══════════════════════════════════════════════════════════════════ */
{
  const a = interiorOf('persia', 'src'), b = interiorOf('persia', 'src');
  ok('the same directory is the same room every time',
     ['floor', 'wall', 'ceil', 'light', 'col', 'disp', 'grain', 'bays'].every((k) => a[k] === b[k]));
  ok('a style only reaches its own vocabulary', Object.entries(INTERIOR).every(([id, voc]) => {
    const ip = interiorOf(id, 'x');
    return ['floor', 'wall', 'ceil', 'light', 'col', 'disp'].every((k) => voc[k].includes(ip[k]));
  }));
  ok('an unknown style falls back instead of throwing', interiorOf('bogus', 'src').style.id === 'modern');
  const kits = new Set(['components', 'hooks', 'utils', 'styles', 'lib', 'api', 'core', 'ui']
    .map((d) => { const ip = interiorOf('tang', d); return [ip.floor, ip.wall, ip.ceil, ip.light, ip.disp].join(); }));
  ok(`directories in one project are not all one room (${kits.size} kits across 8 dirs)`, kits.size >= 3);
  ok(`the grammar has a few hundred combinations (${interiorVariants()})`, interiorVariants() > 100);
}

/* ══ 平面图 ════════════════════════════════════════════════════════════════ */
{
  const L = layoutOf({
    name: 'src', files: 50, lang: 'ts',
    kids: [['a', 5, 100], ['b', 5, 5000], ['c', 5, 300], ['d', 5, 2000], ['e', 5, 900]],
    leaves: [['x.ts', 10, 'b'], ['y.css', 20, 'a'], ['z.ts', 30, ''], ['w.go', 40, 'nope']],
  });
  ok('four sides, four rooms — the biggest four by bytes',
     L.rooms.length === 5 && L.rooms.slice(1).map((r) => r.name).join() === 'b,d,e,c');
  ok('the fifth is counted, not silently dropped', L.extraKids === 1);
  ok('a file whose sub-directory has no room stays in the hall',
     (L.byRoom.get('') || []).map((f) => f.name).sort().join() === 'w.go,y.css,z.ts');
  ok('and still says which sub-directory it came from', L.byRoom.get('').find((f) => f.name === 'y.css').sub === 'a');
  ok('a file under a roomed sub-directory goes into that room', (L.byRoom.get('b') || []).map((f) => f.name).join() === 'x.ts');
  const ov = (p, q) => p.x0 < q.x1 - 1e-6 && q.x0 < p.x1 - 1e-6 && p.z0 < q.z1 - 1e-6 && q.z0 < p.z1 - 1e-6;
  let clash = false;
  for (let i = 0; i < L.rooms.length; i++) for (let j = i + 1; j < L.rooms.length; j++) if (ov(L.rooms[i], L.rooms[j])) clash = true;
  ok('no two rooms overlap', !clash);
  ok('every door reaches past the wall padding on both sides — otherwise it is a wall',
     L.doors.every((d) => ((d.side === 'N' || d.side === 'S') ? d.z1 - d.z0 : d.x1 - d.x0) / 2 > PAD));
  ok('one door per room', L.doors.length === 4 && new Set(L.doors.map((d) => d.room)).size === 4);
}
{
  const old = layoutOf({ name: 'lib', kids: [['k', 1, 1]] });
  ok('a capsule from before leaves existed says so', old.hasLeaves === false && old.byRoom.size === 0);
  ok('an empty leaves list is an empty directory, not old data', layoutOf({ name: 'lib', leaves: [] }).hasLeaves === true);
  const bare = layoutOf(null);
  ok('no directory at all is a bare hall, not a crash', bare.rooms.length === 1 && bare.name === '/');
  ok('junk kids are skipped', layoutOf({ name: 'x', kids: [null, [], ['', 1, 1], 'str', ['ok', 1, 1]] }).rooms.length === 2);
}

/* ══ 文件的颜色是它自己的语言 ══════════════════════════════════════════════ */
{
  ok('the extension decides the language', langOfFile('Button.tsx') === 'ts' && langOfFile('theme.css') === 'css' && langOfFile('main.RS') === 'rust');
  ok('no extension is no language', langOfFile('Makefile') === '' && langOfFile('') === '' && langOfFile(null) === '');
  ok('a css file in a ts directory is not ts-coloured', fileLight('theme.css', 'ts').join() !== fileLight('App.tsx', 'ts').join());
  ok('an unknown extension falls back to the directory language', fileLight('LICENSE', 'ts').join() === fileLight('App.tsx', 'ts').join());
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
