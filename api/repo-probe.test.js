/**
 * repo-probe 契约测试。
 *
 *   node api/repo-probe.test.js
 *
 * 这个文件存在的理由,是它守的那四个 bug **是怎么被找到的**:不是读代码读出来的,
 * 是把探针跑在真实仓库上,一个一个撞出来的。撞出来的东西如果没有测试钉住,下一次
 * 重构就会安安静静地把它们放回去 —— 而这四个的失败方式全都**不报错**:
 * 探针照样返回一个结构完整的答案,只是答案是错的。
 *
 * 所以每一条都写着**是哪个仓库**教的:tach、oryx、gum、bat。名字留着,是因为
 * "为什么要有这一行"比"这一行做了什么"更容易丢。
 *
 * ⚠ 全是纯函数,不联网。probe() 自己要发五个 raw 请求,那一层没什么可测的;
 * 值得钉的是它拿到东西之后**怎么判断**。
 */
const { entryPoints, verbsOf, readmeDemo } = require('./repo-probe');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));
const tree = (...p) => p.map((path) => ({ path }));

console.log('\nrepo-probe\n');

/* ── 1. 排名,而不是"谁先答上来算谁的" ──────────────────────────────────
   tach 教的。它是一个 Python 命令行工具,内核是 Rust,根目录同时躺着 Cargo.toml
   和 pyproject.toml。第一版是一门语言一门语言地问下去、`!out.kind` 就跳过,于是
   Rust 那一支先看见 `[lib]`(一个 PyO3 扩展)就定了性 —— 一个给别的语言当扩展用
   的库,盖掉了人真正在敲的那个命令。 */
{
  const out = entryPoints({
    cargo: '[package]\nname = "tach-rs"\n\n[lib]\ncrate-type = ["cdylib"]\n',
    pyproject: '[project]\nname = "tach"\n\n[project.scripts]\ntach = "tach.cli:main"\n',
  }, tree('src/lib.rs', 'python/tach/__init__.py'));

  ok('tach: a PyO3 [lib] does not outrank the command people type', out.kind === 'cli');
  ok('tach: and the command name is the one from pyproject', out.cmds.includes('tach'));
}

// 顺序反过来结果必须一样 —— 排名是排名,不是"清单在对象里的位置"。
{
  const manifests = {
    pyproject: '[project]\nname = "tach"\n\n[project.scripts]\ntach = "tach.cli:main"\n',
    cargo: '[package]\nname = "tach-rs"\n\n[lib]\n',
  };
  ok('the verdict does not depend on which manifest is read first',
     entryPoints(manifests, tree('src/lib.rs')).kind === 'cli');
}

// 命令 > 服务 > 应用 > 库,全摆在一起时也成立。
{
  const out = entryPoints({
    pkg: JSON.stringify({ name: 'thing', bin: { thing: 'cli.js' }, main: 'index.js', scripts: { start: 'node .' } }),
  }, tree('index.html'));
  ok('a project that is several things at once is named by the command', out.kind === 'cli');
}
{
  const out = entryPoints({
    pkg: JSON.stringify({ name: 'site', main: 'index.js', scripts: { start: 'next start' } }),
  }, tree('index.html', 'src/pages/home.js'));
  ok('an app outranks the library it also happens to be', out.kind === 'app');
}
{
  // got 教的:一个真正的库必须**留在**库这一档,否则排名就成了"everything is a CLI"。
  const out = entryPoints({
    pkg: JSON.stringify({ name: 'got', main: 'dist/index.js', exports: './dist/index.js' }),
  }, tree('source/index.ts'));
  ok('got: a library stays a library', out.kind === 'lib');
}

/* ── 2. 工作区里的二进制 ────────────────────────────────────────────────
   oryx 教的。它的根 Cargo.toml 只有 `[workspace] members`,真正的入口在
   `oryx-tui/src/main.rs`。只认根目录的 src/main.rs 会整类漏掉。 */
{
  const out = entryPoints({ cargo: '[workspace]\nmembers = ["oryx-tui"]\n' },
    tree('Cargo.toml', 'oryx-tui/src/main.rs', 'oryx-tui/Cargo.toml'));
  ok('oryx: src/main.rs at any depth counts as a binary', out.kind === 'cli');
}
{
  const out = entryPoints({ cargo: '[package]\nname = "libby"\n\n[lib]\n' },
    tree('src/lib.rs', 'tests/main.rs'));
  ok('but tests/main.rs is not one — it is not src/main.rs', out.kind === 'lib');
}

/* ── 3. Go 把大版本写在模块路径里 ───────────────────────────────────────
   gum 教的。`module github.com/charmbracelet/gum/v2` 的最后一段是 "v2",
   于是这个工具的名字实测就叫 v2。 */
{
  const out = entryPoints({ gomod: 'module github.com/charmbracelet/gum/v2\n\ngo 1.21\n' },
    tree('main.go'));
  ok('gum: the major version is not the command name', out.entry === 'gum');
  ok('gum: and it is a command', out.kind === 'cli');
}
{
  const out = entryPoints({ gomod: 'module github.com/cli/cli\n' },
    tree('cmd/gh/main.go', 'cmd/gen-docs/main.go'));
  ok('cmd/<name>/ gives the real command names', out.cmds.includes('gh'));
}

/* ── 4. 套话,包括戴着 emoji 的套话 ─────────────────────────────────────
   oryx 教的。README 里 "## ✨ Features" 极常见,而 BORING 存的是 "features";
   带着那颗星就对不上,套话原样漏了出来(实测动词是 "📸 Demo"、"✨ Features")。 */
{
  const md = [
    '## ✨ Features', '## 📸 Demo', '## Installation',
    '## Capture packets', '## Inspect a flow',
  ].join('\n\n');
  const v = verbsOf(md, { cmds: [] });
  ok('an emoji does not smuggle a boilerplate heading through',
     !v.some((x) => /features/i.test(x)) && !v.some((x) => /^demo$/i.test(x)));
  ok('and the real actions survive', v.includes('Capture packets') && v.includes('Inspect a flow'));
}
{
  /* ⚠ U+FE0F。"❤️ Credits" 里那颗心后面跟着一个**变体选择符**,剥掉 emoji 之后
     它还留在字符串开头,于是 " Credits" 依然对不上 BORING 的 "credits"。 */
  const v = verbsOf('## ❤️ Credits\n\n## Render a frame\n', { cmds: [] });
  ok('a leftover variation selector does not smuggle one through either',
     !v.some((x) => /credits/i.test(x)));
  ok('the heading after it still comes through', v.includes('Render a frame'));
}
{
  /* bat 教的:安装说明不是"这个项目会做什么"。 */
  const md = ['## On Ubuntu (using apt)', '## On Alpine Linux', '## From source',
              '## Highlight a file'].join('\n\n');
  const v = verbsOf(md, { cmds: [] });
  ok('bat: install instructions are not actions', v.length === 1 && v[0] === 'Highlight a file');
}
{
  // 命令名优先 —— 那是作者自己给动作起的名字。
  const v = verbsOf('## Something else\n', { cmds: ['scan', 'diff'] });
  ok('command names come first, before README headings',
     v[0] === 'scan' && v[1] === 'diff');
  ok('and nothing is repeated', new Set(v).size === v.length);
}
ok('at most six verbs — more is not a pipeline anyone can read',
   verbsOf(Array.from({ length: 12 }, (_, i) => `## Action ${i}`).join('\n\n'),
           { cmds: ['a', 'b', 'c'] }).length <= 6);
ok('no README at all is not an error', Array.isArray(verbsOf(null, { cmds: [] })));

/* ── 5. 作者自己录的那段演示 ────────────────────────────────────────────── */
{
  const md = '# thing\n\n![demo](docs/demo.gif)\n';
  const d = readmeDemo(md, 'o', 'r', 'main');
  ok('a relative demo path becomes an absolute raw URL',
     d && d.url === 'https://raw.githubusercontent.com/o/r/main/docs/demo.gif');
  ok('and it is motion', d.motion === true);
}
{
  /* 徽章不是演示 —— 而且它排在最前面,所以"第一张图"这条规矩单靠位置是不够的。 */
  const md = '[![build](https://img.shields.io/badge/x.svg)](y)\n\n![demo](https://x.com/a.gif)\n';
  const d = readmeDemo(md, 'o', 'r', 'main');
  ok('a shields badge is skipped in favour of the real demo', d && /a\.gif$/.test(d.url));
}
{
  const md = '![shot](shot.png)\n\n![demo](demo.mp4)\n';
  ok('motion wins over a still even when the still comes first',
     readmeDemo(md, 'o', 'r', 'main').motion === true);
}
{
  const md = '![shot](shot.png)\n';
  const d = readmeDemo(md, 'o', 'r', 'main');
  ok('a still is still worth having when that is all there is',
     d && d.motion === false && /shot\.png$/.test(d.url));
}
{
  // issue 里拖进去的视频没有扩展名,但那正是最常见的演示。
  const md = '<video src="https://github.com/user-attachments/assets/abc123"></video>\n';
  ok('a github attachment counts as motion even without an extension',
     readmeDemo(md, 'o', 'r', 'main').motion === true);
}
{
  /* ⚠ 只看前面一截。README 底部挂的是贡献者头像和赞助商 logo —— 也是图片,
     但没有一张在讲这个东西怎么用。 */
  const md = 'x\n'.repeat(7000) + '![late](late.gif)\n';
  ok('an image past the first ~300 lines is not the demo',
     readmeDemo(md, 'o', 'r', 'main') === null);
}
ok('no README, no demo, no crash', readmeDemo(null, 'o', 'r', 'main') === null);

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
