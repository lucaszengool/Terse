/**
 * room-interior.js —— 走进一座楼之后的文法和平面图(纯函数那一半)。
 *
 *   node --import ./src/renderer/testkit/loader.mjs src/renderer/room-interior.test.mjs
 *
 * 画出来的样子要靠截图看;这里钉的是**不会在截图里报错**的那几件:同一个目录
 * 每次是同一间屋子、风格够不到别人的件、第五个子目录的文件没有被丢掉、老胶囊
 * 说得出自己是老的。
 */
import { interiorOf, interiorVariants, layoutOf, layoutFor, fileLight, PAD, INTERIOR } from './room-interior.js';
import { langOfFile } from './lang-colors.js';
import { roleOfName, ROLE, ROLES } from './room-furniture.js';
import { createRequire } from 'node:module';

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

/* ══ 格局:四合院 / 庭院 ════════════════════════════════════════════════════ */
{
  const dir = { name: 'src', kids: [['a', 5, 100], ['b', 5, 5000], ['c', 5, 300], ['d', 5, 2000]], leaves: [['x.ts', 1, 'b']] };
  ok('the style picks the layout: tang → siheyuan, edo → garden, the rest a hall',
     layoutFor('tang') === 'siheyuan' && layoutFor('edo') === 'garden' && layoutFor('persia') === 'hall' && layoutFor('bogus') === 'hall');
  const S = layoutOf(dir, { layout: 'siheyuan' });
  const side = (n) => S.rooms.find((r) => r.name === n).side;
  ok('a siheyuan: the biggest is the main hall to the north, then east wing, west wing, the south row',
     side('b') === 'N' && side('d') === 'E' && side('c') === 'W' && side('a') === 'S');
  ok('the main hall is wider than the courtyard and the tallest', (() => {
    const n = S.rooms.find((r) => r.side === 'N'), hc = S.hall;
    return (n.x1 - n.x0) > (hc.x1 - hc.x0) && S.rooms.every((r) => r === n || r.isHall || r.h <= n.h);
  })());
  ok('the courtyard is open to the sky, the halls around it are not', S.open && S.hall.open && S.rooms.filter((r) => !r.isHall).every((r) => !r.open));
  const G = layoutOf(dir, { layout: 'garden' });
  ok('a garden is open too, with pavilions round it', G.open && G.hall.kind === 'garden' && G.rooms.filter((r) => !r.isHall).every((r) => r.kind === 'pavilion'));
  for (const Lx of [S, G, layoutOf(dir)]) {
    const ov = (p, q) => p.x0 < q.x1 - 1e-6 && q.x0 < p.x1 - 1e-6 && p.z0 < q.z1 - 1e-6 && q.z0 < p.z1 - 1e-6;
    let clash = false;
    for (let i = 0; i < Lx.rooms.length; i++) for (let j = i + 1; j < Lx.rooms.length; j++) if (ov(Lx.rooms[i], Lx.rooms[j])) clash = true;
    ok(`${Lx.layout}: no two rooms overlap`, !clash);
    ok(`${Lx.layout}: you start inside the hall, not in a wall`,
       Lx.start.x > Lx.hall.x0 + PAD && Lx.start.x < Lx.hall.x1 - PAD && Lx.start.z > Lx.hall.z0 + PAD && Lx.start.z < Lx.hall.z1 - PAD);
  }
  ok('an unknown layout falls back to a hall', layoutOf(dir, { layout: 'castle' }).layout === 'hall');
}
{
  const few = layoutOf({ name: 'x', leaves: [['a.ts', 1, '']] });
  const many = layoutOf({ name: 'x', leaves: Array.from({ length: 60 }, (_, i) => ['f' + i + '.ts', 100, '']) });
  ok('a hall with sixty files is bigger than a hall with one', (many.hall.x1 - many.hall.x0) > (few.hall.x1 - few.hall.x0));
}
{
  const deep = layoutOf({ name: 'src', kids: [['old', 1, 1]], leaves: [['stale.ts', 1, '']],
    detail: { kids: [['ui', 2, 900]], truncated: true, files: [{ n: 'Button.tsx', p: 'src/ui/Button.tsx', sub: 'ui', b: 900, l: 30, lang: 'ts', role: 'component', sym: [['Button', 'component', 3, 1]], imp: 4, out: 1 }] } });
  ok('deep-scan data wins over the capsule leaves', deep.rooms.map((r) => r.name).join() === 'src,ui' && (deep.byRoom.get('ui') || [])[0].name === 'Button.tsx');
  ok('and it carries symbols, usage and the truncation flag', deep.hasSymbols && deep.truncated && deep.byRoom.get('ui')[0].sym.length === 1 && deep.byRoom.get('ui')[0].imp === 4);
  ok('capsule leaves carry no symbols — null, "not known", not []', layoutOf({ name: 'x', leaves: [['a.ts', 1, '']] }).byRoom.get('')[0].sym === null);
}

/* ══ 文件的颜色是它自己的语言 ══════════════════════════════════════════════ */
{
  ok('the extension decides the language', langOfFile('Button.tsx') === 'ts' && langOfFile('theme.css') === 'css' && langOfFile('main.RS') === 'rust');
  ok('no extension is no language', langOfFile('Makefile') === '' && langOfFile('') === '' && langOfFile(null) === '');
  ok('a css file in a ts directory is not ts-coloured', fileLight('theme.css', 'ts').join() !== fileLight('App.tsx', 'ts').join());
  ok('an unknown extension falls back to the directory language', fileLight('LICENSE', 'ts').join() === fileLight('App.tsx', 'ts').join());
}

/* ══ 家具的判据:手机上的兜底和服务端的深扫,必须对同一个文件给出同一件家具 ══ */
{
  const require = createRequire(import.meta.url);
  const { roleOf } = require('../../api/github-room.js');
  const cases = [
    ['Button.test.tsx', ''], ['App.tsx', ''], ['index.ts', ''], ['useAuth.ts', 'hooks'], ['types.d.ts', ''], ['types.ts', ''],
    ['Button.tsx', 'components'], ['README', ''], ['README.md', ''], ['package.json', ''], ['package-lock.json', ''], ['Dockerfile', ''],
    ['.env.local', ''], ['theme.css', 'styles'], ['logo.svg', ''], ['schema.sql', ''], ['001_init.js', 'migrations'], ['lib.rs', ''],
    ['__init__.py', 'pkg'], ['test_api.py', ''], ['api_test.go', ''], ['helper.ts', '__tests__'], ['vite.config.ts', ''],
    ['usersTypes.ts', ''], ['models.py', ''], ['main.go', ''], ['server.js', ''], ['cli.py', ''], ['index.css', ''], ['App.vue', ''],
    ['random.ts', 'deep/nested'], ['LICENSE', ''], ['notes.txt', ''],
  ];
  const off = cases.filter(([n, s]) => roleOfName(n, s) !== roleOf((s ? s + '/' : '') + n));
  ok(`the phone's fallback and the server's deep scan agree on every file (${cases.length} cases)`, off.length === 0);
  if (off.length) console.log('    disagree:', off.map(([n, s]) => `${s}/${n}: phone=${roleOfName(n, s)} server=${roleOf((s ? s + '/' : '') + n)}`).join('; '));
  ok('every role has furniture', ROLES.every((r) => !!ROLE[r].furn));
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
