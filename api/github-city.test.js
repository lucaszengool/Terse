/**
 * github-city 契约测试 —— 给没 clone 过的仓库盖城市。
 *
 *   node api/github-city.test.js
 *
 * 钉三件事:
 *   1. 树 → 楼是**精确**的(字节、文件、语言、深度、测试占比都来自 blob 本身);
 *   2. 历史 → 窗户和信标,以及这一轮加的"几个人在管 / 是不是只有一个人";
 *   3. ⚠ 新字段**穿过 sanitize 还活着**,而没有的字段**仍然没有** —— 不能变成 0。
 *      frac(undefined) 就是 0,而 0 在城市里是"查过了,没有测试",画成一圈红:
 *      Mac 扫出来的城市根本没有这个字段,那样每一个项目都会被冤枉。
 */
process.env.PLAZA_ADMIN_TOKEN = 'test-admin-token-city-0123456';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { dirsFromTree, buildCity, kindOf } = require('./github-city');
const db = require('./db');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

console.log('\ngithub-city\n');

const TREE = [
  { type: 'blob', path: 'src/a.rs', size: 1000 },
  { type: 'blob', path: 'src/b.rs', size: 500 },
  { type: 'blob', path: 'src/a_test.rs', size: 200 },
  { type: 'blob', path: 'src/deep/x/y.rs', size: 100 },
  { type: 'blob', path: 'tests/it.rs', size: 300 },
  { type: 'blob', path: 'node_modules/big/index.js', size: 999999 },
  { type: 'blob', path: 'README.md', size: 50 },
  { type: 'blob', path: 'main.go', size: 400 },
  { type: 'blob', path: '.github/workflows/ci.yml', size: 80 },
  { type: 'tree', path: 'src' },
];

/* ── 1. 树 → 楼 ── */
{
  const dirs = dirsFromTree(TREE);
  const by = Object.fromEntries(dirs.map((d) => [d.name, d]));
  ok('node_modules is not part of the city — it is somebody else\'s code', !by.node_modules);
  ok('bytes are the exact sum of the blobs', by.src && by.src.bytes === 1800);
  ok('files are counted per directory', by.src.files === 4);
  ok('the language is read from extensions, by byte', by.src.lang === 'rust');
  ok('depth is how many directory levels deep it goes (src/deep/x)', by.src.depth === 3);
  ok('test share comes from filename conventions (a_test.rs)', by.src.tests === 0.25);
  ok('a test/ directory is all tests, and is a test building', by.tests.tests === 1 && by.tests.kind === 'test');
  ok('loose root files become one building instead of disappearing', !!by['/'] && by['/'].files === 2);
  ok('the root building takes its language from what is there (main.go)', by['/'].lang === 'go');
  ok('config dirs are recognised', kindOf('.github') === 'config' && kindOf('docs') === 'docs');
  ok('a tree with nothing in it builds nothing', dirsFromTree([]).length === 0);
  const many = Array.from({ length: 30 }, (_, i) => ({ type: 'blob', path: `d${i}/f.js`, size: 1000 + i }));
  ok('at most sixteen buildings', dirsFromTree(many).length === 16);
}

/* ── 2. 历史 → 窗、信标、作者 ── */
(async () => {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  const calls = [];
  const api = async (p) => {
    calls.push(p);
    if (p.startsWith('/repos/o/r/commits')) {
      // src: four commits, three by one person → owner 0.75, 2 authors
      if (p.includes('path=src')) {
        return [
          { author: { login: 'ann' }, commit: { committer: { date: iso(3) } } },
          { author: { login: 'ann' }, commit: { committer: { date: iso(9) } } },
          { author: { login: 'ann' }, commit: { committer: { date: iso(20) } } },
          { author: { login: 'bo' }, commit: { committer: { date: iso(40) } } },
        ];
      }
      return [{ author: null, commit: { author: { email: 'x@y' }, committer: { date: iso(400) } } }];
    }
    if (p === '/repos/o/r') {
      return { stargazers_count: 2577, forks_count: 74, open_issues_count: 5,
               license: { spdx_id: 'MIT' }, created_at: iso(730) };
    }
    return null;
  };
  const city = await buildCity(api, 'o', 'r', 'main', TREE);
  const src = city.dirs.find((d) => d.name === 'src');
  ok('age is the newest commit touching that directory', src.age_days === 3);
  ok('churn is how many commits touched it', src.churn === 4);
  ok('authors counts distinct people', src.authors === 2);
  ok('owner is the top author\'s share — 3 of 4', src.owner === 0.75);
  ok('an author with no GitHub login is still counted, by email',
     city.dirs.find((d) => d.name === 'tests').authors === 1);
  ok('the root building asks for the whole repo, not a path',
     calls.some((c) => c.startsWith('/repos/o/r/commits') && !c.includes('path=')));
  ok('repo meta comes back with stars, license and age',
     city.meta && city.meta.stars === 2577 && city.meta.license === 'MIT' && city.meta.age_days === 730);
  ok('CI is detected from .github/workflows', city.meta.ci === true);

  /* ── 3. 穿过 sanitize ── */
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/projects', require('./projects'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (path, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
                 'x-terse-admin': process.env.PLAZA_ADMIN_TOKEN } }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject); r.write(data); r.end();
  });

  const identity = crypto.createHash('sha256').update('github-city-test').digest('hex').slice(0, 32);
  const id = 'wp_' + crypto.createHash('sha256').update(identity + '|gc').digest('hex').slice(0, 16);
  db.upsertWallProject.run({ id, identity, title: 'gc', capsule: JSON.stringify({ id: 'gc', title: 'gc', kind: 'project' }) });

  const macDir = { name: 'app', files: 5, bytes: 9000, lang: 'rust' };   // Mac scanner: no tests / authors / owner
  const status = await post('/projects/backfill', { updates: [{ id, capsule: {
    id: 'gc', title: 'gc', kind: 'project', dirs: [src, macDir], meta: city.meta,
  } }] });
  ok('the capsule is accepted', status === 200);

  const row = db.allWallProjects.all().find((r) => r.id === id);
  const saved = JSON.parse(row.capsule);
  const sSrc = saved.dirs.find((d) => d.name === 'src');
  const sMac = saved.dirs.find((d) => d.name === 'app');
  ok('tests survive sanitize', sSrc.tests === 0.25);
  ok('authors survive sanitize', sSrc.authors === 2);
  ok('owner survives sanitize', sSrc.owner === 0.75);
  ok('★ a directory that never had test data does NOT gain tests: 0',
     !('tests' in sMac) && !('authors' in sMac) && !('owner' in sMac));
  ok('meta survives sanitize', saved.meta && saved.meta.stars === 2577 && saved.meta.ci === true && saved.meta.license === 'MIT');

  db.deleteWallProjectById.run(id);
  server.close();
  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
  process.exit(fails.length ? 1 : 0);
})();
