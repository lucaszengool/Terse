/**
 * github-room 契约测试 —— 走进一座楼,家具和家具上的东西。
 *
 *   node api/github-room.test.js
 *
 * 不联网:tar 在内存里现写(下面那个十几行的 header 写法),gzip 后交给 indexArchive。
 * 钉住:
 *   1. tar 解析 —— ustar prefix、GNU 长名、pax path、全局 pax 头、切成碎块 push 结果一样;
 *   2. 角色 —— 判断顺序(Button.test.tsx 是测试不是组件,index.d.ts 是类型不是入口);
 *   3. 符号 —— 各语言、导出标记、行号;
 *   4. import 解析和出入度;
 *   5. 选楼(顶层目录 vs 根目录散文件)、kids 聚合、上限。
 */
const zlib = require('zlib');
const os = require('os');
const fspath = require('path');
// 磁盘缓存写进临时目录里的 sqlite,不碰真库。⚠ 必须在 require('./github-room') 之前。
process.env.TERSE_DATA_DIR = require('fs').mkdtempSync(fspath.join(os.tmpdir(), 'terse-room-test-'));
const R = require('./github-room');
const { parseTar, tarParser, roleOf, symbolsOf, importsOf, resolveImport, indexArchive, roomOf, buildIndex, fileMeta, handler } = R;

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

console.log('\ngithub-room\n');

/* ── 一个极小的 tar 写法 ── */
function header(name, size, type = '0', prefix = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  h.fill(' ', 148, 156);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - n % 512) % 512);
function entry(name, content, type = '0', prefix = '') {
  const d = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return [header(name, d.length, type, prefix), d, pad(d.length)];
}
function paxRecord(k, v) {
  const body = ` ${k}=${v}\n`, bl = Buffer.byteLength(body);
  let n = bl + 1;
  while (n !== bl + String(n).length) n = bl + String(n).length;
  return n + body;
}
const paxEntry = (path, type = 'x') => entry('PaxHeader', paxRecord('path', path), type);
const tar = (...parts) => Buffer.concat([...parts.flat(), Buffer.alloc(1024)]);

/* ── 1. tar ── */
const LONG1 = 'repo-abc/' + 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/pax-file.ts';
const LONG2 = 'repo-abc/' + 'c'.repeat(70) + '/' + 'd'.repeat(70) + '/gnu-file.ts';
const T1 = tar(
  entry('pax_global_header', paxRecord('comment', 'deadbeef'), 'g'),   // git archive 开头就是这个
  entry('repo-abc/', '', '5'),
  entry('repo-abc/src/a.js', 'hello\n'),
  paxEntry(LONG1), entry('truncated-name', 'pax!'),
  entry('././@LongLink', LONG2 + '\0', 'L'), entry(LONG2.slice(0, 99), 'gnu!'),
  entry('x.ts', 'prefixed', '0', 'repo-abc/deep/down'),
  entry('repo-abc/link', '', '2'),
  entry('repo-abc/中文/名字.md', '# 你好\n'),
);
{
  const files = parseTar(T1);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  ok('tar: only regular files come out (dir, symlink, global pax dropped)', files.length === 5);
  ok('tar: plain ustar name + data', by['repo-abc/src/a.js'] && by['repo-abc/src/a.js'].data.toString() === 'hello\n' && by['repo-abc/src/a.js'].size === 6);
  ok('tar: pax path wins over the truncated ustar name (>100 chars)', LONG1.length > 100 && by[LONG1] && by[LONG1].data.toString() === 'pax!');
  ok('tar: GNU longname (L)', LONG2.length > 100 && by[LONG2] && by[LONG2].data.toString() === 'gnu!');
  ok('tar: ustar prefix + name', by['repo-abc/deep/down/x.ts'] && by['repo-abc/deep/down/x.ts'].data.toString() === 'prefixed');
  ok('tar: utf-8 names survive', !!by['repo-abc/中文/名字.md']);
  ok('tar: the pax path does not leak onto the next entry', !files.some((f) => f.path === 'truncated-name'));

  for (const step of [1, 7, 511, 513, 4096]) {
    const got = [];
    const t = tarParser((e) => got.push(e.path + ':' + (e.data ? e.data.toString() : '')));
    for (let i = 0; i < T1.length; i += step) t.push(T1.subarray(i, i + step));
    t.end();
    ok(`tar: pushed in ${step}-byte chunks gives the same files`, got.join('|') === files.map((f) => f.path + ':' + f.data.toString()).join('|'));
  }

  const bad = Buffer.from(T1); bad[148 + 512 * 3] = 0x39;   // 打坏一个校验和
  let threw = false; try { parseTar(bad); } catch (e) { threw = true; }
  ok('tar: a bad checksum is an error, not garbage file names', threw);
  let threw2 = false; try { parseTar(Buffer.from('<html>not a tar</html>'.padEnd(600, ' '))); } catch (e) { threw2 = true; }
  ok('tar: an HTML error page is rejected', threw2);
  let threw3 = false; try { parseTar(T1.subarray(0, 512 * 4 + 3)); } catch (e) { threw3 = true; }
  ok('tar: an archive cut off mid-file is an error', threw3);

  // want():count 模式只数行,不留内容
  const got = [];
  const t = tarParser((e) => got.push(e), () => 'count');
  t.push(tar(entry('r/a.txt', 'a\nb\nc'), entry('r/b.txt', 'a\nb\n'))); t.end();
  ok('tar: count mode counts lines without keeping data', got[0].data === null && got[0].lines === 3 && got[1].lines === 2);
}

/* ── 2. 角色 ── */
{
  const cases = {
    'src/Button.test.tsx': 'test', 'src/Button.spec.ts': 'test', 'pkg/x_test.go': 'test', 'test_app.py': 'test',
    'app/thing_test.py': 'test', 'tests/index.ts': 'test', 'src/__tests__/Card.tsx': 'test', 'spec/helper.rb': 'test',
    'src/index.ts': 'entry', 'main.go': 'entry', 'src/App.tsx': 'entry', 'server.js': 'entry', 'src/lib.rs': 'entry',
    'src/main.rs': 'entry', 'src/net/mod.rs': 'entry', 'pkg/__init__.py': 'entry', 'pkg/__main__.py': 'entry', 'bin/cli.js': 'entry',
    'src/Button.tsx': 'component', 'src/Card.vue': 'component', 'src/Modal.svelte': 'component', 'src/button.tsx': 'source',
    'src/hooks/useAuth.ts': 'hook', 'src/useThing.jsx': 'hook', 'src/user.ts': 'source',
    'types.d.ts': 'types', 'src/index.d.ts': 'types', 'src/types.ts': 'types', 'src/apiTypes.ts': 'types',
    'app/models.py': 'types', 'src/schema.graphql': 'types', 'src/interfaces.go': 'types',
    'package.json': 'config', 'types.json': 'config', 'ci.yml': 'config', 'Cargo.toml': 'config', 'vite.config.ts': 'config',
    'Dockerfile': 'config', 'Makefile': 'config', '.editorconfig': 'config', 'yarn.lock': 'config', 'package-lock.json': 'config',
    'requirements.txt': 'config', '.env.example': 'config', 'go.mod': 'config',
    'README.md': 'docs', 'docs/guide.mdx': 'docs', 'notes.txt': 'docs', 'LICENSE': 'docs', 'x.rst': 'docs',
    'src/app.css': 'style', 'a.scss': 'style', 'logo.svg': 'asset', 'img/a.PNG': 'asset', 'f.woff2': 'asset', 'song.mp3': 'asset',
    'db/schema.sql': 'data', 'data.csv': 'data', 'prisma/schema.prisma': 'data', 'app/migrations/0001_init.py': 'data',
    'src/util.js': 'source', 'lib/thing.rb': 'source',
  };
  const wrong = Object.entries(cases).filter(([p, r]) => roleOf(p) !== r).map(([p, r]) => `${p}=${roleOf(p)}≠${r}`);
  ok(`roleOf: ${Object.keys(cases).length} paths classify as expected` + (wrong.length ? ' — ' + wrong.join(', ') : ''), !wrong.length);
}

/* ── 3. 符号 ── */
const find = (syms, name) => syms.find((s) => s[0] === name);
{
  const ts = [
    "import React from 'react';",                          // 1
    'export interface Props { a: number }',                // 2
    'type Local = string;',                                // 3
    'export enum Color { Red }',                           // 4
    'export const MAX = 5;',                               // 5
    'const hidden = 3;',                                   // 6
    'export function Button(p: Props) {',                  // 7
    '  function inner() {}',                               // 8
    '}',                                                   // 9
    'export const useAuth = () => {};',                    // 10
    'const Card = (props) => <div/>;',                     // 11
    'export default class Store {}',                       // 12
    'async function load() {}',                            // 13
    "describe('Button', () => { it('renders ok', () => {}); });", // 14
    "router.post('/login', h);",                           // 15
    "app.get('env');",                                     // 16 不是路由
  ].join('\n');
  const s = symbolsOf('src/Button.tsx', ts);
  ok('ts: interface → type, exported, line 2', JSON.stringify(find(s, 'Props')) === '["Props","type",2,1]');
  ok('ts: non-exported type alias', JSON.stringify(find(s, 'Local')) === '["Local","type",3,0]');
  ok('ts: enum → type', find(s, 'Color') && find(s, 'Color')[1] === 'type');
  ok('ts: exported const → const', JSON.stringify(find(s, 'MAX')) === '["MAX","const",5,1]');
  ok('ts: non-exported plain const is not shown', !find(s, 'hidden'));
  ok('tsx: capitalised function → component', JSON.stringify(find(s, 'Button')) === '["Button","component",7,1]');
  ok('ts: nested function is not a top-level symbol', !find(s, 'inner'));
  ok('ts: const useX arrow → hook', JSON.stringify(find(s, 'useAuth')) === '["useAuth","hook",10,1]');
  ok('tsx: const Capitalised arrow → component', JSON.stringify(find(s, 'Card')) === '["Card","component",11,0]');
  ok('ts: export default class', JSON.stringify(find(s, 'Store')) === '["Store","class",12,1]');
  ok('ts: async function → fn', JSON.stringify(find(s, 'load')) === '["load","fn",13,0]');
  ok('js: describe/it names are tests', find(s, 'Button') && s.some((x) => x[0] === 'renders ok' && x[1] === 'test' && x[2] === 14));
  ok('js: router.post(\'/login\') → route', JSON.stringify(find(s, 'POST /login')) === '["POST /login","route",15,0]');
  ok('js: app.get(\'env\') is a setting, not a route', !s.some((x) => x[1] === 'route' && /env/.test(x[0])));
  ok('ts: symbols are in source order', s.map((x) => x[2]).every((v, i, a) => !i || a[i - 1] <= v));

  const cjs = "function a() {}\nconst b = function () {};\nfunction c() {}\nexports.d = (x) => x;\nmodule.exports = { a, b };\n";
  const sc = symbolsOf('api/x.js', cjs);
  ok('cjs: module.exports = { a, b } marks a and b exported, c stays private',
     find(sc, 'a')[3] === 1 && find(sc, 'b')[3] === 1 && find(sc, 'c')[3] === 0);
  ok('cjs: exports.d = arrow → exported fn', JSON.stringify(find(sc, 'd')) === '["d","fn",4,1]');

  const iife = "(function () {\n  'use strict';\n  var assign = require('x');\n  function configure(o) {\n    function tooDeep() {}\n  }\n" +
               "  function middlewareWrapper(o) {}\n  module.exports = middlewareWrapper;\n}());\n";
  const si = symbolsOf('lib/index.js', iife);
  ok('js IIFE/UMD: with nothing at top level, shallow function declarations are the fallback',
     JSON.stringify(si) === '[["configure","fn",4,0],["middlewareWrapper","fn",7,1]]');
  ok('js: the fallback does not kick in when there are top-level symbols',
     !find(symbolsOf('a.js', 'function top() {\n  function local() {}\n}\n'), 'local'));

  const py = [
    'import os', 'MAX_SIZE = 10', '', '@app.route("/hello")', 'def hello():', '    pass', '',
    'class Thing:', '    def method(self):', '        pass', '    def test_inside(self):', '        pass',
    'async def _private():', '    pass', 'def test_top():', '    assert 1', '@router.get("/items")', 'async def items(): ...',
  ].join('\n');
  const sp = symbolsOf('app/main.py', py);
  ok('py: UPPER top-level assignment → const', JSON.stringify(find(sp, 'MAX_SIZE')) === '["MAX_SIZE","const",2,1]');
  ok('py: @app.route → route', JSON.stringify(find(sp, '/hello')) === '["/hello","route",4,0]');
  ok('py: top-level def → fn line 5', JSON.stringify(find(sp, 'hello')) === '["hello","fn",5,1]');
  ok('py: class', JSON.stringify(find(sp, 'Thing')) === '["Thing","class",8,1]');
  ok('py: methods are skipped, but test_ methods count as tests', !find(sp, 'method') && find(sp, 'test_inside')[1] === 'test');
  ok('py: _private is not exported', find(sp, '_private')[3] === 0);
  ok('py: def test_top → test', find(sp, 'test_top')[1] === 'test');
  ok('py: @router.get → GET route', !!find(sp, 'GET /items'));

  const go = [
    'package x', '', 'type Server struct {', '}', 'type (', '\tid int', '\tHandler interface{}', ')',
    'func (s *Server) Start() error {', '}', 'func helper() {}', 'func TestServer(t *testing.T) {}',
    'const Version = "1"', '\tmux.HandleFunc("/api", h)',
  ].join('\n');
  const sg = symbolsOf('srv/server_test.go', go);
  ok('go: type X struct', JSON.stringify(find(sg, 'Server')) === '["Server","type",3,1]');
  ok('go: grouped type ( ... ) block', find(sg, 'Handler') && find(sg, 'id') && find(sg, 'id')[3] === 0);
  ok('go: method → T.Method', JSON.stringify(find(sg, 'Server.Start')) === '["Server.Start","fn",9,1]');
  ok('go: lowercase func is not exported', find(sg, 'helper')[3] === 0);
  ok('go: TestX in _test.go → test', find(sg, 'TestServer')[1] === 'test');
  ok('go: exported const', find(sg, 'Version') && find(sg, 'Version')[1] === 'const');
  ok('go: HandleFunc route', !!find(sg, '/api'));

  const rs = [
    'pub struct Config {}', 'enum Mode { A }', 'pub trait Run {}', 'impl Run for Config {', '    fn run(&self) {}', '}',
    'pub async fn serve() {}', 'fn private() {}', 'pub const LIMIT: u32 = 1;', '#[cfg(test)]', 'mod tests {',
    '    #[test]', '    #[should_panic]', '    fn it_works() {}', '}',
  ].join('\n');
  const sr = symbolsOf('src/lib.rs', rs);
  ok('rust: pub struct → type exported', JSON.stringify(find(sr, 'Config')) === '["Config","type",1,1]');
  ok('rust: enum/trait → type', find(sr, 'Mode')[1] === 'type' && find(sr, 'Run')[1] === 'type' && find(sr, 'Mode')[3] === 0);
  ok('rust: impl methods are ignored', !find(sr, 'run'));
  ok('rust: pub async fn', JSON.stringify(find(sr, 'serve')) === '["serve","fn",7,1]');
  ok('rust: #[test] fn (through another attribute) → test', JSON.stringify(find(sr, 'it_works')) === '["it_works","test",14,0]');
  ok('rust: pub const', find(sr, 'LIMIT')[1] === 'const');

  const md = '# Title\n\n```\n# not a heading\n```\n## Install `npm i` [link](http://x)\n### too deep\n';
  const sm = symbolsOf('README.md', md);
  ok('md: # and ## headings, fenced code ignored, formatting stripped',
     JSON.stringify(sm) === '[["Title","heading",1,0],["Install npm i link","heading",6,0]]');
  ok('md: headings are capped at 40 chars', symbolsOf('a.md', '# ' + 'x'.repeat(80))[0][0].length === 40);

  const sql = 'create table users (id int);\n\nCREATE TABLE IF NOT EXISTS "public.posts" (\n id int);\nCREATE VIEW v AS select 1;';
  const sq = symbolsOf('db/schema.sql', sql);
  ok('sql: CREATE TABLE names with line numbers', JSON.stringify(sq) === '[["users","table",1,0],["public.posts","table",3,0]]');

  const java = 'public class Foo {\n  @Test\n  public void checksThings() {}\n  private int bar(int x) {\n  }\n}\ninterface Baz {}';
  const sj = symbolsOf('src/Foo.java', java);
  ok('java: class/method/@Test/interface', find(sj, 'Foo')[1] === 'class' && find(sj, 'checksThings')[1] === 'test'
     && find(sj, 'bar')[3] === 0 && find(sj, 'Baz')[1] === 'type');
  const sc2 = symbolsOf('src/a.c', 'struct node {\n};\nstatic int helper(int a)\n{\n}\nint main(int argc, char **argv) {\n  return 0;\n}\nvoid decl(void);');
  ok('c: struct, static fn (not exported), main, prototypes skipped',
     find(sc2, 'node')[1] === 'type' && find(sc2, 'helper')[3] === 0 && find(sc2, 'main')[3] === 1 && !find(sc2, 'decl'));
  const sru = symbolsOf('lib/a.rb', "module Foo\n  class Bar\n    def baz?\n    end\n  end\nend\ndescribe 'things' do\nend");
  ok('ruby: module/class/def/describe', find(sru, 'Foo') && find(sru, 'Bar') && find(sru, 'baz?') && find(sru, 'things')[1] === 'test');
  const sph = symbolsOf('a.php', "<?php\nclass A {\n  private function hid() {}\n  public function shown() {}\n}\nRoute::get('/u', 'X');");
  ok('php: class/functions/Route::get', find(sph, 'A') && find(sph, 'hid')[3] === 0 && find(sph, 'shown')[3] === 1 && !!find(sph, 'GET /u'));

  const many = Array.from({ length: 40 }, (_, i) => `export function f${i}() {}`).join('\n');
  const sm2 = symbolsOf('a.ts', many);
  ok('sym cap: at most 24 per file, the first 24 in order', sm2.length === 24 && sm2[23][0] === 'f23');
  ok('symbolsOf never throws on junk', Array.isArray(symbolsOf(null, null)) && Array.isArray(symbolsOf('a.ts', '\0\0\0')));
  ok('minified one-liners give nothing', symbolsOf('a.js', 'var a=1;'.repeat(2000)).length === 0);
}

/* ── 4. import ── */
{
  const js = "import a from './a';\nimport {\n  x,\n  y\n} from '../lib/b.js';\nimport 'side';\nexport * from './c';\n" +
             "const d = require('./d');\nconst e = await import('./e');\nimport React from 'react';";
  const im = importsOf('src/x/index.ts', js);
  ok('importsOf js: import/multi-line/side-effect/export-from/require/dynamic',
     ['./a', '../lib/b.js', 'side', './c', './d', './e', 'react'].every((s) => im.includes(s)) && im.length === 7);
  const ip = importsOf('pkg/sub/m.py', 'from . import util, other as o\nfrom ..core import thing\nfrom pkg.models import X\nimport os, json as j');
  ok('importsOf py: relative dots, absolute, plain import', ['.util', '.other', '..core', 'pkg.models', 'os', 'json'].every((s) => ip.includes(s)));
  ok('importsOf go: single and grouped', importsOf('m.go', 'import "fmt"\nimport (\n\t"os"\n\tx "github.com/a/b"\n)').join() === 'fmt,os,github.com/a/b');
  ok('importsOf rust: mod x; and use crate::', importsOf('src/lib.rs', 'mod net;\npub mod db;\nuse crate::net::tcp::Conn;\nuse std::io;').join() === 'mod net,mod db,crate::net::tcp::Conn');
  ok('importsOf c: only quoted includes', importsOf('a.c', '#include <stdio.h>\n#include "util.h"').join() === 'util.h');

  const set = new Set(['src/a.ts', 'src/lib/b.ts', 'src/c/index.tsx', 'src/d.js', 'src/comp/Btn.jsx',
    'pkg/__init__.py', 'pkg/util.py', 'pkg/sub/m.py', 'pkg/models.py', 'src/lib.rs', 'src/net/mod.rs', 'src/net/tcp.rs',
    'inc/util.h', 'app/util.h', 'app/main.c']);
  ok('resolve: extension probing (.ts)', resolveImport('src/x.ts', './a', set) === 'src/a.ts');
  ok('resolve: "./b.js" finds b.ts (ESM TS)', resolveImport('src/x/y.ts', '../lib/b.js', set) === 'src/lib/b.ts');
  ok('resolve: directory → index.tsx', resolveImport('src/x.ts', './c', set) === 'src/c/index.tsx');
  ok('resolve: exact file', resolveImport('src/x.ts', './d.js', set) === 'src/d.js');
  ok('resolve: @/ alias → src/', resolveImport('src/deep/z.ts', '@/comp/Btn', set) === 'src/comp/Btn.jsx');
  ok('resolve: bare packages are null', resolveImport('src/x.ts', 'react', set) === null);
  ok('resolve: escaping the repo root is null', resolveImport('src/x.ts', '../../../a', set) === null);
  ok('resolve py: from . import util', resolveImport('pkg/sub/m.py', '..util', set) === 'pkg/util.py');
  ok('resolve py: from .. import (package itself)', resolveImport('pkg/sub/m.py', '..', set) === 'pkg/__init__.py');
  ok('resolve py: absolute pkg.models', resolveImport('pkg/sub/m.py', 'pkg.models', set) === 'pkg/models.py');
  ok('resolve py: stdlib os is null', resolveImport('pkg/sub/m.py', 'os', set) === null);
  ok('resolve c: relative include', resolveImport('app/main.c', 'util.h', set) === 'app/util.h');
  ok('resolve c: falls back to include/', resolveImport('lib/x.c', 'util.h', set) === 'inc/util.h' || resolveImport('lib/x.c', 'util.h', set) === null);
  ok('resolve rust: mod net; → net/mod.rs', resolveImport('src/lib.rs', 'mod net', set) === 'src/net/mod.rs');
  ok('resolve rust: mod tcp; from net/mod.rs', resolveImport('src/net/mod.rs', 'mod tcp', set) === 'src/net/tcp.rs');
  ok('resolve rust: crate::net::tcp::Conn → tcp.rs', resolveImport('src/lib.rs', 'crate::net::tcp::Conn', set) === 'src/net/tcp.rs');
  ok('resolve go: null (packages are directories)', resolveImport('a/b.go', 'github.com/x/y/a', set) === null);
}

/* ── 5. 一个假仓库:出入度、选楼、kids ── */
const BIG = 'x'.repeat(300 * 1024) + '\nline2\n';
const REPO = tar(
  entry('pax_global_header', paxRecord('comment', 'abc'), 'g'),
  entry('proj-123/src/index.ts', "import { a } from './util';\nimport B from './components/Button';\nexport function main() {}\n"),
  entry('proj-123/src/util.ts', "export const a = 1;\nexport function helper() {}\n"),
  entry('proj-123/src/components/Button.tsx', "import { a } from '../util';\nimport { a as b } from '../util.js';\nexport default function Button() {}\n"),
  entry('proj-123/src/components/Button.test.tsx', "import Button from './Button';\nimport { helper } from '../util';\ntest('clicks', () => {});\n"),
  entry('proj-123/src/components/icons/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])),
  entry('proj-123/src/hooks/useAuth.ts', "import { a } from '../util';\nexport function useAuth() {}\n"),
  entry('proj-123/src/node_modules/junk/index.js', 'module.exports = 1;\n'),
  entry('proj-123/src/big.ts', BIG),
  entry('proj-123/src/blob.txt', Buffer.from('abc\0def\n')),
  entry('proj-123/README.md', '# Proj\n## Usage\n'),
  entry('proj-123/package.json', '{"name":"proj"}\n'),
  entry('proj-123/docs/guide.md', '# Guide\n'),
);
{
  const idx = indexArchive(zlib.gzipSync(REPO));
  const by = Object.fromEntries(idx.files.map((f) => [f.p, f]));
  ok('index: archive root dir is stripped', !!by['src/util.ts'] && !idx.files.some((f) => f.p.startsWith('proj-123')));
  ok('index: nested node_modules is skipped (any segment)', !idx.files.some((f) => f.p.includes('node_modules')));
  ok('index: in-degree — util.ts is imported by 4 files (two edges from Button count once)', by['src/util.ts'].imp === 4);
  ok('index: out-degree — Button.tsx has 1 distinct target', by['src/components/Button.tsx'].out === 1);
  ok('index: index.ts imports 2, Button imported by index + its test', by['src/index.ts'].out === 2 && by['src/components/Button.tsx'].imp === 2);
  ok('index: binary file (png) has size only', by['src/components/icons/logo.png'].l === 0 && by['src/components/icons/logo.png'].b === 8 && by['src/components/icons/logo.png'].role === 'asset');
  ok('index: NUL bytes in a .txt → treated as binary, l=0', by['src/blob.txt'].l === 0);
  ok('index: >256KB text → lines counted, no symbols', by['src/big.ts'].l === 2 && by['src/big.ts'].sym.length === 0 && by['src/big.ts'].b === BIG.length);
  ok('index: lang/role/sym filled', by['src/hooks/useAuth.ts'].lang === 'ts' && by['src/hooks/useAuth.ts'].role === 'hook'
     && JSON.stringify(by['src/hooks/useAuth.ts'].sym) === '[["useAuth","hook",2,1]]');
  ok('index: no raw source is kept', idx.files.every((f) => !('data' in f) && !('imps' in f)));

  const src = roomOf(idx, 'src');
  ok('room: a top-level folder', src.dir === 'src' && src.root === false && src.files.every((f) => f.p.startsWith('src/')));
  ok('room: files sorted by bytes desc', src.files.every((f, i, a) => !i || a[i - 1].b >= f.b) && src.files[0].p === 'src/big.ts');
  ok('room: sub is the first segment below dir', src.files.find((f) => f.n === 'logo.png').sub === 'components'
     && src.files.find((f) => f.n === 'util.ts').sub === '');
  const comp = src.kids.find((k) => k[0] === 'components');
  ok('room: kids aggregate recursively (components has 3 files incl. icons/)', comp && comp[1] === 3);
  ok('room: kids sorted by bytes desc', src.kids.every((k, i, a) => !i || a[i - 1][2] >= k[2]));
  ok('room: file row has exactly the contract keys', Object.keys(src.files[0]).join() === 'n,p,sub,b,l,lang,role,sym,imp,out');
  ok('room: truncated=false for small dirs', src.truncated === false && src.total === src.files.length);

  const rootA = roomOf(idx, '/'), rootB = roomOf(idx, ''), rootC = roomOf(idx, 'proj'), rootD = roomOf(idx, 'root');
  ok('room: "/" "" and unknown names are the root files',
     [rootA, rootB, rootC, rootD].every((r) => r && r.root === true && r.dir === '/' && r.files.map((f) => f.n).sort().join() === 'README.md,package.json'));
  ok('room: root has no kids', rootA.kids.length === 0 && rootA.files.every((f) => f.sub === ''));
  ok('room: README headings come through', JSON.stringify(rootA.files.find((f) => f.n === 'README.md').sym) === '[["Proj","heading",1,0],["Usage","heading",2,0]]');
  ok('room: nested path works as a prefix too', roomOf(idx, 'src/components/').files.length === 3);
  ok('room: a folder whose files are all skipped is not a room of its own', roomOf(idx, 'node_modules').root === true);

  const noRoot = buildIndex([fileMeta('lib/a.js', 10, Buffer.from('x')), fileMeta('lib/b.js', 5, null)]);
  ok('room: unknown dir in a repo with no root files → null (404)', roomOf(noRoot, 'nope') === null && roomOf(noRoot, 'lib').files.length === 2);

  const bigIdx = buildIndex(Array.from({ length: 200 }, (_, i) => fileMeta(`lib/sub${i % 20}/f${i}.js`, 1000 + i, null)));
  const big = roomOf(bigIdx, 'lib');
  ok('room cap: 200 files → 160 kept, truncated=true', big.files.length === 160 && big.truncated === true && big.total === 200);
  ok('room cap: kids capped at 12, counts still recursive over all 200', big.kids.length === 12 && big.kids.every((k) => k[1] === 10));
  ok('room cap: the 160 kept are the biggest', big.files[0].b === 1199 && big.files[159].b === 1040);
}

/* ── 6. HTTP handler(不联网:往缓存里塞一个索引)── */
(async () => {
  const mkRes = () => ({ code: 200, body: null, headers: {}, ended: false,
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }, end() { this.ended = true; return this; } });
  const call = async (query, headers = {}) => { const res = mkRes(); await handler({ query, headers }, res); return res; };
  const fresh = (idx) => ({ sha: idx.sha || '', fetchedAt: Date.now(), checkedAt: Date.now(), idx, err: 0 });
  R._mem.set('me/proj', fresh(indexArchive(zlib.gzipSync(REPO))));
  R._mem.set('me/huge', { sha: '', fetchedAt: Date.now(), checkedAt: Date.now(), idx: null, err: 413, msg: 'That repository is too large to walk into' });

  const a = await call({ repo: 'me/proj', dir: 'src' });
  ok('http: 200 with the room', a.code === 200 && a.body.ok === true && a.body.repo === 'me/proj' && a.body.dir === 'src' && a.body.files.length === 8);
  const b = await call({ repo: 'Me/Proj.git' });
  ok('http: repo is case-insensitive for the cache, .git stripped, no dir → root', b.code === 200 && b.body.root === true);
  ok('http: 400 on a bad repo', (await call({ repo: 'not a repo' })).code === 400 && (await call({})).code === 400
     && (await call({ repo: '../x' })).code === 400 && (await call({ repo: 'a/b/c' })).code === 400);
  ok('http: 400 on dir traversal or array dir', (await call({ repo: 'me/proj', dir: '../etc' })).code === 400
     && (await call({ repo: 'me/proj', dir: ['a', 'b'] })).code === 400);
  ok('http: remembered 413 comes back as 413', (await call({ repo: 'me/huge', dir: 'src' })).code === 413);
  R._mem.set('me/noroot', fresh(buildIndex([fileMeta('lib/a.js', 1, null)])));
  const d = await call({ repo: 'me/noroot', dir: 'zzz' });
  ok('http: 404 when neither a folder nor root files match', d.code === 404 && typeof d.body.error === 'string');

  /* ── 7. 持久化、过期重验、预热、队列、ETag(假的 fetch 和时钟,不联网)── */
  console.log('\n  persistence / freshness / warming\n');
  const SHA1 = '1'.repeat(40), SHA2 = '2'.repeat(40), SHA3 = '3'.repeat(40);
  const gzOf = (sha, files) => zlib.gzipSync(tar(entry('pax_global_header', paxRecord('comment', sha), 'g'),
    ...files.map(([p, c]) => entry('r-' + sha.slice(0, 7) + '/' + p, c))));
  const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
  const refsBody = (sha) => pkt('# service=git-upload-pack\n') + '0000'
    + pkt(sha + ' HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main\n') + pkt(sha + ' refs/heads/main\n') + '0000';
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); p.open = open; return p; };
  const tick = () => new Promise((r) => setImmediate(r));
  const until = async (cond) => { for (let i = 0; i < 5000 && !cond(); i++) await tick(); return cond(); };
  const W = { t: Date.now(), heads: {}, archives: {}, huge: new Set(), gates: {}, calls: [] };
  const count = (what) => W.calls.filter((c) => c === what).length;
  R.configure({
    now: () => W.t,
    fetch: async (url) => {
      const u = String(url); let m;
      if ((m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\.git\/info\/refs/.exec(u))) {
        const k = m[1].toLowerCase(); W.calls.push('refs ' + k);
        if (W.gates['refs ' + k]) await W.gates['refs ' + k];
        return k in W.heads ? new Response(refsBody(W.heads[k])) : new Response('Unauthorized', { status: 401 });
      }
      if ((m = /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz/.exec(u))) {
        const k = m[1].toLowerCase(); W.calls.push('tar ' + k);
        if (W.gates['tar ' + k]) await W.gates['tar ' + k];
        if (W.huge.has(k)) return new Response('x', { headers: { 'content-length': String(200 * 1024 * 1024) } });
        return k in W.archives ? new Response(W.archives[k]) : new Response('404', { status: 404 });
      }
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/archive\//.test(u)) return new Response('404', { status: 404 });
      throw new Error('unexpected fetch in test: ' + u);
    },
  });

  // 7a. 落盘,重启还在
  W.heads['t/disk'] = SHA1;
  W.archives['t/disk'] = gzOf(SHA1, [['src/a.ts', 'export function alpha() {}\n'], ['README.md', '# Hi\n']]);
  const d1 = await R.getIndex('t', 'disk');
  ok('persist: first visit downloads once, and the sha comes from the archive itself (no refs call)',
     count('tar t/disk') === 1 && d1.sha === SHA1 && count('refs t/disk') === 0);
  R._mem.clear();
  const d2 = await R.getIndex('T', 'Disk');
  ok('persist: with memory wiped, the index comes back from disk — no re-download',
     count('tar t/disk') === 1 && d2.sha === SHA1 && JSON.stringify(d2.files) === JSON.stringify(d1.files));
  const row = R._store().get('t/disk');
  ok('persist: the row is gzip + sha + times + size, and never raw source',
     row && row.sha === SHA1 && row.gz[0] === 0x1f && row.gz[1] === 0x8b && row.size === row.gz.length
     && row.fetched_at === W.t && row.err === 0 && !zlib.gunzipSync(row.gz).toString().includes('export function alpha'));
  const child = require('child_process').execFileSync(process.execPath, ['-e', `
    const R = require(${JSON.stringify(require.resolve('./github-room'))});
    R.configure({ fetch: async () => { throw new Error('no network after a restart'); } });
    R.getIndex('t', 'disk').then((i) => console.log('GOT ' + i.sha + ' ' + i.files.length), (e) => console.log('ERR ' + e.message));
  `], { env: process.env, encoding: 'utf8' });
  ok('persist: a brand-new process (a restart) answers from disk with no network', child.includes('GOT ' + SHA1 + ' 2'));

  // 7b. 过期:立刻答,后台只重验一次;sha 没变不重下
  W.t += 7 * 3600e3;
  const rg = gate(); W.gates['refs t/disk'] = rg;
  const stale = await Promise.all([R.getIndex('t', 'disk'), R.getIndex('t', 'disk'), R.getIndex('t', 'disk')]);
  ok('stale: served instantly while the revalidation is still hanging', stale.every((i) => i.sha === SHA1));
  ok('stale: three stale hits → exactly one revalidation', count('refs t/disk') === 1);
  rg.open(); await R._idle(); delete W.gates['refs t/disk'];
  ok('stale: same sha → no re-download', count('tar t/disk') === 1);
  ok('stale: same sha → checked_at bumped on disk', R._store().get('t/disk').checked_at === W.t);
  await R.getIndex('t', 'disk'); await R._idle();
  ok('stale: once bumped it is fresh — no further revalidation', count('refs t/disk') === 1);

  // 7c. sha 变了:这次还给旧的,后台重下一次,下次给新的
  W.t += 7 * 3600e3;
  W.heads['t/disk'] = SHA2;
  W.archives['t/disk'] = gzOf(SHA2, [['src/a.ts', 'export function alpha() {}\n'], ['src/b.ts', 'export const B = 1;\n'], ['README.md', '# Hi\n']]);
  const before = await R.getIndex('t', 'disk');
  ok('changed: this request still gets the old index, instantly', before.sha === SHA1);
  await R._idle();
  ok('changed: exactly one background re-download', count('tar t/disk') === 2 && count('refs t/disk') === 2);
  const after = await R.getIndex('t', 'disk');
  ok('changed: the next request sees the new index', after.sha === SHA2 && after.files.some((f) => f.p === 'src/b.ts'));
  ok('changed: and so does the disk', R._store().get('t/disk').sha === SHA2);

  // 7c'. 后台重下失败(仓库长到 413 了):好的那份留着,也不会每个请求都重下
  W.t += 7 * 3600e3; W.heads['t/disk'] = SHA3; W.huge.add('t/disk');
  await R.getIndex('t', 'disk'); await R._idle();
  ok('a failed background re-download (413) keeps serving the good index',
     (await R.getIndex('t', 'disk')).sha === SHA2 && R._store().get('t/disk').err === 0 && count('tar t/disk') === 3);
  await R.getIndex('t', 'disk'); await R._idle();
  ok('…and does not retry the heavy download on the next request', count('tar t/disk') === 3);
  W.huge.delete('t/disk'); W.heads['t/disk'] = SHA2;

  // 7d. 记住的失败:404 一小时,413 一天,都在磁盘上
  const e404 = await R.getIndex('t', 'gone').catch((e) => e);
  ok('404: reported', e404.code === 404 && count('tar t/gone') === 1);
  R._mem.clear(); W.t += 59 * 60e3;
  const e404b = await R.getIndex('t', 'gone').catch((e) => e);
  ok('404: remembered for an hour, across a memory wipe (it is on disk)', e404b.code === 404 && count('tar t/gone') === 1);
  W.t += 2 * 60e3;
  await R.getIndex('t', 'gone').catch(() => {});
  ok('404: after an hour it is asked again', count('tar t/gone') === 2);
  W.huge.add('t/huge');
  const e413 = await R.getIndex('t', 'huge').catch((e) => e);
  ok('413: reported', e413.code === 413 && count('tar t/huge') === 1);
  R._mem.clear(); W.t += 23 * 3600e3;
  ok('413: remembered for a day', (await R.getIndex('t', 'huge').catch((e) => e)).code === 413 && count('tar t/huge') === 1);
  W.t += 2 * 3600e3;
  await R.getIndex('t', 'huge').catch(() => {});
  ok('413: after a day it is tried again', count('tar t/huge') === 2);

  // 7e. /room/warm:202,不等
  W.archives['w/one'] = gzOf(SHA1, [['a.js', 'export const A = 1;\n']]); W.heads['w/one'] = SHA1;
  const wg = gate(); W.gates['tar w/one'] = wg;
  const wr = mkRes();
  const ret = R.warmHandler({ body: { repo: 'w/one' }, query: {} }, wr);
  ok('warm: 202 straight away, without awaiting the download',
     !(ret && typeof ret.then === 'function') && wr.code === 202 && wr.body.ok === true && wr.body.state === 'warming');
  const wr2 = mkRes(); R.warmHandler({ query: { repo: 'https://github.com/W/one' } }, wr2);
  await until(() => count('tar w/one') === 1); await tick();
  ok('warm: GET ?repo= and a github URL work; the same repo shares one job',
     wr2.code === 202 && wr2.body.state === 'warming' && count('tar w/one') === 1);
  wg.open(); await R._idle();
  const wr3 = mkRes(); R.warmHandler({ body: { repo: 'w/one' } }, wr3);
  ok('warm: after indexing → cached', wr3.body.state === 'cached');
  const wr4 = mkRes(); R.warmHandler({ body: {}, query: {} }, wr4);
  ok('warm: 400 without a repo', wr4.code === 400);
  const wr5 = mkRes(); R.warmHandler({ body: { repo: 't/huge' } }, wr5);
  ok('warm: a remembered 413 says cached + err, so the phone can skip the door', wr5.body.state === 'cached' && wr5.body.err === 413);

  // 7f. 队列:最多两个同时下,人在楼门口的插队
  for (const n of ['a', 'b', 'c', 'd', 'e']) { W.archives['q/' + n] = gzOf(SHA1, [['x.js', 'export const X = 1;\n']]); W.gates['tar q/' + n] = gate(); }
  const tars = () => W.calls.filter((c) => c.startsWith('tar q/')).map((c) => c.slice(6));
  ['a', 'b', 'c', 'd'].forEach((n) => R.warm('q', n));
  const inter = R.getIndex('q', 'e');
  await until(() => tars().length >= 2); await tick(); await tick();
  ok('queue: at most 2 downloads at once', tars().join() === 'a,b' && R._stats().active === 2 && R._stats().queued === 3);
  W.gates['tar q/a'].open();
  await until(() => tars().length >= 3);
  ok('queue: an interactive /room request jumps ahead of queued warm jobs', tars()[2] === 'e' && R._stats().active === 2);
  ['b', 'c', 'd', 'e'].forEach((n) => W.gates['tar q/' + n].open());
  await inter; await R._idle();
  ok('queue: everything finishes; warm jobs keep the order they were asked in', tars().join() === 'a,b,e,c,d' && R._stats().active === 0);

  // 7g. ETag / 304
  const r1 = await call({ repo: 't/disk', dir: 'src' });
  const tag = r1.headers.ETag;
  ok('etag: 200 carries an ETag made of sha + dir, and the cache policy',
     r1.code === 200 && typeof tag === 'string' && tag.startsWith('"' + SHA2.slice(0, 16) + '-')
     && r1.headers['Cache-Control'] === 'public, max-age=600, stale-while-revalidate=86400');
  ok('room: the response says which sha it was built from', r1.body.sha === SHA2);
  const r2 = await call({ repo: 't/disk', dir: 'src' }, { 'if-none-match': tag });
  ok('etag: If-None-Match → 304 with no body', r2.code === 304 && r2.body === null && r2.ended && r2.headers.ETag === tag);
  const r3 = await call({ repo: 't/disk', dir: 'src' }, { 'if-none-match': '"nope", W/' + tag });
  ok('etag: weak and listed validators match too', r3.code === 304);
  const r4 = await call({ repo: 't/disk', dir: '/' }, { 'if-none-match': tag });
  ok('etag: another building is another ETag', r4.code === 200 && r4.headers.ETag !== tag);

  // 7h. info/refs 解析
  ok('headOf: the HEAD sha from the first ref line', R.headOf(Buffer.from(refsBody(SHA1))) === SHA1);
  ok('headOf: not enough bytes yet → undefined', R.headOf(Buffer.from(refsBody(SHA1)).subarray(0, 40)) === undefined);
  ok('headOf: an empty repository has no HEAD → ""',
     R.headOf(Buffer.from(pkt('# service=git-upload-pack\n') + '0000' + pkt('0'.repeat(40) + ' capabilities^{}\0agent=x\n') + '0000')) === '');

  // 7i. 启动预热:广场上的 GitHub 项目,一次一个,跳过已缓存的
  await R._idle();
  for (const n of ['one', 'two']) { W.archives['p/' + n] = gzOf(SHA1, [['m.go', 'package m\nfunc Run() {}\n']]); W.gates['tar p/' + n] = gate(); }
  const diskBefore = count('tar t/disk');
  const rows = [
    { capsule: JSON.stringify({ link: 'https://github.com/p/one' }) },
    { capsule: JSON.stringify({ link: 'https://github.com/t/disk' }) },          // 已缓存
    { capsule: JSON.stringify({ link: 'https://gitlab.com/p/nope' }) },          // 不是 GitHub
    { capsule: JSON.stringify({ link: 'https://github.com/P/One/tree/main' }) },  // 重复
    { capsule: JSON.stringify({ link: 'https://github.com/p/two.git' }) },
    { capsule: '{broken' },
  ];
  const wm = R.startWarmer({ list: () => rows, delayMs: 0, startDelayMs: 0 });
  await until(() => count('tar p/one') === 1); await tick(); await tick();
  ok('warmer: strictly one at a time (p/two waits for p/one)', count('tar p/two') === 0);
  W.gates['tar p/one'].open();
  await until(() => count('tar p/two') === 1);
  W.gates['tar p/two'].open();
  const warmed = await wm.done;
  ok('warmer: each github repo once; cached / non-github / duplicates / junk skipped',
     warmed === 2 && count('tar p/one') === 1 && count('tar p/two') === 1 && count('tar t/disk') === diskBefore
     && !W.calls.some((c) => c.includes('nope')));
  ok('warmer: warmed repos are on disk but do not push hot repos out of memory',
     !!R._store().peek('p/one') && !!R._store().peek('p/two') && !R._mem.has('p/one'));
  ok('repoOf: owner/name and github links only', R.repoOf('a/b').repo === 'b' && R.repoOf('https://github.com/a/b.git').repo === 'b'
     && R.repoOf('https://gitlab.com/a/b') === null && R.repoOf('a/b/c') === null && R.repoOf('../x') === null);
  await R._idle();

  /* ── 8. edges、旧格式升级、风格(对着 ESM 原版跑)、回填 ── */
  console.log('\n  edges / style / backfill\n');
  {
    const src = (s) => Buffer.from(s);
    const ei = buildIndex([
      fileMeta('src/a.ts', 300, src("import b from './b';\nimport c from './c';\nimport c2 from './c.js';\n")),
      fileMeta('src/b.ts', 200, src("import c from './c';\nimport self from './b';\n")),
      fileMeta('src/c.ts', 100, src('export const C = 1;\n')),
      fileMeta('lib/x.ts', 50, src("import a from '../src/a';\n")),
    ]);
    const er = roomOf(ei, 'src');
    const at = (n) => er.files.findIndex((f) => f.n === n);
    ok('edges: A→B, A→C, B→C exactly, as indexes into files (duplicate and self imports dropped)',
       JSON.stringify(er.edges) === JSON.stringify([[at('a.ts'), at('b.ts')], [at('a.ts'), at('c.ts')], [at('b.ts'), at('c.ts')]]));
    ok('edges: an importer outside the room (lib/x.ts) is not part of it', er.edges.length === 3);

    const ring = buildIndex(Array.from({ length: 200 }, (_, i) =>
      fileMeta(`lib/f${i}.js`, 1000 + i, src(`require('./f${(i + 1) % 200}');\nrequire('./f0');\n`))));
    const rr = roomOf(ring, 'lib');
    const sorted = (es) => es.every((e, k, a) => !k || a[k - 1][0] < e[0] || (a[k - 1][0] === e[0] && a[k - 1][1] < e[1]));
    ok('edges: truncated room (160 of 200) — every edge points inside files',
       rr.truncated && rr.files.length === 160 && rr.edges.every(([i, j]) => i >= 0 && j >= 0 && i < 160 && j < 160 && i !== j));
    ok('edges: only pairs where both ends were kept (f40..f199 chain = 159), none to the cut-off f0',
       rr.edges.length === 159 && !rr.files.some((f) => f.n === 'f0.js'));
    ok('edges: sorted by (i, j) and unique', sorted(rr.edges));
    const dense = buildIndex(Array.from({ length: 170 }, (_, i) =>
      fileMeta(`m/f${i}.js`, 5000 - i, src(Array.from({ length: 10 }, (_, k) => `require('./f${(i + k + 1) % 170}');`).join('\n')))));
    const dr = roomOf(dense, 'm');
    ok('edges: capped at 600, still sorted', dr.edges.length === 600 && sorted(dr.edges));

    // 旧格式(v1,没有 to)的索引:立刻答(没有边),后台按新格式重建,ETag 跟着变
    W.heads['t/legacy'] = SHA1;
    W.archives['t/legacy'] = gzOf(SHA1, [['src/a.ts', "import { b } from './b';\n"], ['src/b.ts', 'export const b = 1;\n']]);
    const legacyFiles = [
      { p: 'src/a.ts', b: 25, l: 1, lang: 'ts', role: 'source', sym: [], imp: 0, out: 1 },
      { p: 'src/b.ts', b: 20, l: 1, lang: 'ts', role: 'source', sym: [], imp: 1, out: 0 },
    ];
    const lgz = zlib.gzipSync(JSON.stringify({ v: 1, at: W.t, sha: SHA1, files: legacyFiles }));
    R._store().put({ repo: 't/legacy', sha: SHA1, fetched_at: W.t, checked_at: W.t, size: lgz.length, gz: lgz, err: 0, msg: '' });
    const l1 = await call({ repo: 't/legacy', dir: 'src' });
    ok('legacy: an index cached before edges existed is still served at once (edges: [])',
       l1.code === 200 && Array.isArray(l1.body.edges) && l1.body.edges.length === 0 && l1.body.files.length === 2);
    await R._idle();
    ok('legacy: …and rebuilt once in the background, without even asking for HEAD',
       count('tar t/legacy') === 1 && count('refs t/legacy') === 0);
    const l2 = await call({ repo: 't/legacy', dir: 'src' }, { 'if-none-match': l1.headers.ETag });
    ok('legacy: same sha, new format → new ETag, so the edgeless copy is never 304-ed',
       l2.code === 200 && l2.headers.ETag !== l1.headers.ETag && JSON.stringify(l2.body.edges) === '[[0,1]]');
  }
  {
    const { pathToFileURL } = require('url');
    let esm = null;
    try { esm = await import(pathToFileURL(fspath.join(__dirname, '..', 'src', 'renderer', 'city-styles.js')).href); }
    catch (e) { console.error('  (could not import src/renderer/city-styles.js: ' + e.message + ')'); }
    const cap = require('./github-capsule');
    ok('style: the ESM original (src/renderer/city-styles.js) imports cleanly into node', !!(esm && esm.styleForCode && esm.seedOf));
    if (esm) {
      const LANGS = ['ts', 'js', 'html', 'css', 'python', 'rust', 'c', 'c++', 'go', 'java', 'kotlin', 'c#', 'swift', 'ruby', 'php', 'shell', 'sql', 'haskell', ''];
      const NAMES = ['vercel/next.js', 'Pallets/Click', 'a/b', 'torvalds/linux', ''];
      const cases = [];
      LANGS.forEach((l, i) => {
        cases.push([[[l, 0.7], ['js', 0.3]], NAMES[i % NAMES.length]]);
        cases.push([[[l, 1]], NAMES[(i + 2) % NAMES.length]]);
      });
      cases.push([[], 'x/y'], [null, 'x/y'], [[['', 0.5], ['go', 0.5]], 'golang/go'], [undefined, undefined],
                 [[['python', 0.9]], 'PSF/Requests'], [[['python', 0.9]], 'psf/requests']);
      const bad = cases.filter(([l, n]) => cap.styleForCode(l, n) !== esm.styleForCode(l, n));
      ok(`style: the api port agrees with city-styles.js on all ${cases.length} cases` + (bad.length ? ' — ' + JSON.stringify(bad[0]) : ''),
         cases.length >= 40 && !bad.length);
      ok('style: seedOf is the same FNV-1a', ['', 'a', 'owner/repo', '中文名字'].every((s) => cap.seedOf(s) === esm.seedOf(s)));
      const FAM = { ts: 'modern persia tang', js: 'modern persia tang', html: 'modern persia tang', css: 'modern persia tang',
        python: 'hellas giza', rust: 'norse maya', c: 'norse maya', 'c++': 'norse maya', go: 'modern edo',
        java: 'giza hellas', kotlin: 'giza hellas', 'c#': 'giza hellas', swift: 'edo tang', ruby: 'maya persia', php: 'maya persia',
        shell: 'tang norse edo', sql: 'tang norse edo', haskell: 'tang norse edo', '': 'tang norse edo' };
      ok('style: every language lands in its own family (and unknown / empty in the fallback)',
         LANGS.every((l) => NAMES.every((n) => FAM[l].split(' ').includes(cap.styleForCode([[l, 1]], n)))));
      ok('style: the first NON-empty language decides', FAM.go.split(' ').includes(cap.styleForCode([['', 0.5], ['go', 0.5]], 'q/r')));
    }

    // 回填:临时 sqlite(TERSE_DATA_DIR 在文件顶上指到了 tmp)
    const db = require('./db');
    const { restyle, planRestyle } = require('./restyle-github');
    const ins = db.db.prepare('INSERT INTO wall_projects (id, identity, title, capsule) VALUES (?, ?, ?, ?)');
    const capOf = (o) => JSON.stringify(Object.assign({ v: 2, title: 't', langs: [['python', 1]], style: 'modern', cover: 'data:image/png;base64,AAAA' }, o));
    ins.run('rs_gh_modern', 'idA', 'gh modern', capOf({ link: 'https://github.com/psf/requests', srcId: 'gh_psf_requests' }));
    ins.run('rs_mac_modern', 'idA', 'mac modern', capOf({ link: 'https://github.com/me/mine', srcId: 'proj_7f3a' }));   // 作者自己挑的 modern
    ins.run('rs_gh_empty', 'idA', 'gh empty', capOf({ link: 'https://github.com/rust-lang/cargo', langs: [['rust', 1]], style: '' }));
    ins.run('rs_gh_tang', 'idA', 'gh tang', capOf({ link: 'https://github.com/a/b', style: 'tang' }));
    ins.run('rs_not_gh', 'idA', 'not gh', capOf({ link: 'https://example.com/x/y' }));
    ins.run('rs_no_link', 'idA', 'no link', capOf({}));
    const snap = () => JSON.stringify(db.allWallProjects.all().map((r) => [r.id, r.capsule]).sort());
    const before0 = snap();
    const dry = restyle(db);
    ok('backfill dry-run: plans exactly the github+modern and github+empty rows', dry.map((p) => p.id).sort().join() === 'rs_gh_empty,rs_gh_modern');
    ok('backfill dry-run: writes nothing', snap() === before0);
    ok('backfill: the new style is styleForCode(capsule.langs, owner/repo)',
       dry.find((p) => p.id === 'rs_gh_modern').to === cap.styleForCode([['python', 1]], 'psf/requests')
       && dry.find((p) => p.id === 'rs_gh_empty').to === cap.styleForCode([['rust', 1]], 'rust-lang/cargo'));
    const cli = require('child_process').execFileSync(process.execPath, [require.resolve('./restyle-github')], { env: process.env, encoding: 'utf8' });
    ok('backfill CLI: dry-run by default, prints the plan, writes nothing',
       (cli.match(/would restyle/g) || []).length === 2 && /2 project\(s\) would change — dry run/.test(cli) && snap() === before0);
    const applied = restyle(db, { apply: true });
    const byId = Object.fromEntries(db.allWallProjects.all().map((r) => [r.id, JSON.parse(r.capsule)]));
    ok('backfill --apply: github+modern restyled, the rest of its capsule intact',
       byId.rs_gh_modern.style === applied.find((p) => p.id === 'rs_gh_modern').to && byId.rs_gh_modern.style !== 'modern'
       && byId.rs_gh_modern.cover === 'data:image/png;base64,AAAA' && byId.rs_gh_modern.link === 'https://github.com/psf/requests');
    ok('backfill --apply: github+tang and non-github rows untouched',
       byId.rs_gh_tang.style === 'tang' && byId.rs_not_gh.style === 'modern' && byId.rs_no_link.style === 'modern');
    ok('backfill: a Mac-scanned project with a github link keeps the modern its author chose (srcId is not gh_)',
       byId.rs_mac_modern.style === 'modern');
    ok('backfill: idempotent — a second run has nothing to do', restyle(db, { apply: true }).length === 0);
    ok('planRestyle: junk rows are skipped, not thrown on', planRestyle([{ id: 'x', capsule: '{bad' }, null, { id: 'y', capsule: null }]).length === 0);
  }
  await R._idle();

  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
  process.exit(fails.length ? 1 : 0);
})();
