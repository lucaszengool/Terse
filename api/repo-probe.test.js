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
const { entryPoints, verbsOf, readmeDemo, collectMedia } = require('./repo-probe');

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

const M = (md, tree) => collectMedia(md, 'o', 'r', 'main', tree);

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
  /* ⚠ 这一条**改过**,而且是故意的。原来的规矩是"只看前 12000 字",于是长 README
     后半段的录屏被整段丢掉 —— 而那常常是最好的一段。现在整篇都读,靠**位置分**
     排先后,不靠截断。底部那些贡献者头像和赞助商 logo 由徽章过滤器挡,那才是
     它们该被挡住的理由(它们是徽章),而不是"它们位置靠后"。 */
  const md = 'x\n'.repeat(7000) + '![late](late.gif)\n';
  const d = readmeDemo(md, 'o', 'r', 'main');
  ok('an image far down a long README is now found, not truncated away',
     d && /late\.gif$/.test(d.url));
  const withEarlier = readmeDemo('![early](early.gif)\n' + md, 'o', 'r', 'main');
  ok('but an earlier one still wins', /early\.gif$/.test(withEarlier.url));
  ok('and the sponsor logos at the bottom are still excluded — as badges',
     M('x\n'.repeat(7000) + '![s](https://opencollective.com/x/backer.svg)').length === 0);
}
ok('no README, no demo, no crash', readmeDemo(null, 'o', 'r', 'main') === null);

/* ── A2. 收集**全部**画面,并排出先后 ────────────────────────────────────
   原来这里只取第一张会动的图就返回了。可作者常常铺了一整页:一张主视觉、几段
   各配一张截图、末尾一段录屏 —— 只取一张等于把那一页压成一格。
   规矩是两段:**首图钉在最前**,其余按重要程度排。 */
{
  const md = [
    '# thing',
    '![logo](assets/logo.png)',
    '[![build](https://img.shields.io/badge/x.svg)](y)',
    '![demo](docs/demo.gif)',
    '![a screenshot](docs/shot1.png)',
  ].join('\n\n');
  const all = M(md);
  ok('it collects every picture, not just the first', all.length === 3);
  ok('the badge is not one of them', !all.some((m) => /shields/.test(m.url)));
  ok('★ the README hero comes first even though a GIF outranks it',
     all[0].why === 'hero' && /logo\.png$/.test(all[0].url));
  ok('and the moving one is next, ahead of the still',
     all[1].motion === true && /demo\.gif$/.test(all[1].url));
  ok('the plain screenshot is last', /shot1\.png$/.test(all[2].url));
  ok('every url is absolute', all.every((m) => /^https:\/\//.test(m.url)));
}
{
  // 动图排在静图前面 —— 一段 GIF 讲清楚的事,十张截图讲不清。
  const all = M('![x](a.png)\n\n![y](b.png)\n\n![z](c.gif)');
  ok('motion outranks stills that came after the hero',
     all[0].why === 'hero' && all[1].motion === true);
}
{
  /* GitHub 附件没有扩展名,而那是近几年最常见的演示放法。 */
  const all = M('<video src="https://github.com/user-attachments/assets/abc"></video>');
  ok('a github attachment counts as motion without an extension',
     all.length === 1 && all[0].motion === true);
}
{
  // logo/icon 往后排,但**不丢** —— 它常常就是首图。
  const all = M('![demo](demo.gif)\n\n![icon](icon.png)');
  ok('an icon is kept but ranked below a demo',
     all.length === 2 && /icon/.test(all[all.length - 1].url));
}
{
  /* ⚠ 整篇都读。原来只看前 12000 字,长 README 后半段的录屏被整段丢掉 ——
     而那常常是最好的一段。位置只影响**分数**,不再是一道截断。 */
  const md = '![hero](h.png)\n\n' + 'filler paragraph.\n\n'.repeat(900) + '![late](late.gif)';
  const all = M(md);
  ok('a picture far down a long README is still collected', all.length === 2);
  ok('but it ranks below the hero', all[0].why === 'hero');
}
{
  // 仓库里躺着、README 没贴的图也收 —— "这个项目里任何 gif 动图"。
  const tree = [{ path: 'docs/extra.gif' }, { path: 'src/main.rs' },
                { path: 'test/fixtures/tiny.png' }, { path: 'assets/screenshot.png' }];
  const all = M('![hero](h.png)', tree);
  ok('a gif sitting in docs/ is collected even if the README never showed it',
     all.some((m) => /extra\.gif$/.test(m.url)));
  ok('and one in assets/ too', all.some((m) => /screenshot\.png$/.test(m.url)));
  ok('but not a test fixture — that is not something to look at',
     !all.some((m) => /tiny\.png$/.test(m.url)));
  ok('repo finds rank below what the author actually put in the README',
     all[0].why === 'hero');
}
{
  // 同一个地址出现两次算一个,取分高的那次。
  const all = M('![a](same.png)\n\n![a](same.png)');
  ok('the same url is not collected twice', all.length === 1);
}
ok('no README and no tree is not an error', M(null).length === 0);
ok('readmeDemo still answers with the best motion for older callers',
   readmeDemo('![h](h.png)\n\n![d](d.gif)', 'o', 'r', 'main').motion === true);

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
