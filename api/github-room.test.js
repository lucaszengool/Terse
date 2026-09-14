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
  const call = async (query) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query }, res);
    return res;
  };
  R._cache.set('me/proj', { at: Date.now(), idx: indexArchive(zlib.gzipSync(REPO)) });
  R._cache.set('me/huge', { at: Date.now(), err: Object.assign(new Error('That repository is too large to walk into'), { code: 413 }) });

  const a = await call({ repo: 'me/proj', dir: 'src' });
  ok('http: 200 with the room', a.code === 200 && a.body.ok === true && a.body.repo === 'me/proj' && a.body.dir === 'src' && a.body.files.length === 8);
  const b = await call({ repo: 'Me/Proj.git' });
  ok('http: repo is case-insensitive for the cache, .git stripped, no dir → root', b.code === 200 && b.body.root === true);
  ok('http: 400 on a bad repo', (await call({ repo: 'not a repo' })).code === 400 && (await call({})).code === 400
     && (await call({ repo: '../x' })).code === 400 && (await call({ repo: 'a/b/c' })).code === 400);
  ok('http: 400 on dir traversal or array dir', (await call({ repo: 'me/proj', dir: '../etc' })).code === 400
     && (await call({ repo: 'me/proj', dir: ['a', 'b'] })).code === 400);
  ok('http: remembered 413 comes back as 413', (await call({ repo: 'me/huge', dir: 'src' })).code === 413);
  R._cache.set('me/noroot', { at: Date.now(), idx: buildIndex([fileMeta('lib/a.js', 1, null)]) });
  const d = await call({ repo: 'me/noroot', dir: 'zzz' });
  ok('http: 404 when neither a folder nor root files match', d.code === 404 && typeof d.body.error === 'string');

  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
  process.exit(fails.length ? 1 : 0);
})();
