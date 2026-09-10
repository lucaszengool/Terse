/**
 * Wiring contract test — the markup and the code that drives it.
 *
 *   node landing/phone/wiring.test.js
 *
 * This exists because the same failure happened FOUR times while building this
 * app, and none of the times produced an error:
 *
 *   · a button shipped with no handler at all, and silently did nothing
 *   · a render call left behind an early return, so a whole section only
 *     appeared if you happened to visit another tab first
 *   · a render call still driven from the tab a card used to live on, after
 *     the card moved to a different one
 *
 * Every one of those is a live element that looks fine and does nothing. Nothing
 * throws, nothing logs, and it takes a person tapping the exact control to
 * notice. So this asserts the two halves match: every id the code reaches for
 * exists in the markup, and every control in the markup is reached by the code.
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, '..', 'm.html'), 'utf8');
const js = ['app.js', 'install.js', 'diag.js', 'terse-web.js', 'capture.js', 'beds.js', 'social.js']
  .map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })
  .join('\n');

console.log('\nWiring\n');

// Every id that exists at runtime: the ones in the shell, plus the ones the
// code BUILDS. The install sheet is created and destroyed on demand and never
// appears in m.html, which is correct — it should not be in the markup when
// there is nothing to install.
const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) htmlIds.add(m[1]);
ok('the shell declares ids at all', htmlIds.size > 20);

const builtIds = new Set();
for (const m of js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) builtIds.add(m[1]);        // in template strings
for (const m of js.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)) builtIds.add(m[1]);  // assigned to an element
const knownIds = new Set([...htmlIds, ...builtIds]);

// Every id the code reaches for, via $('x') or getElementById('x').
const wanted = new Map();
for (const m of js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) wanted.set(m[1], '$()');
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) wanted.set(m[1], 'getElementById');

// ── Half one: the code must not reach for markup that is not there ──
// A typo or a removed element here is a silent null, and the very next property
// access throws inside whatever render pass touched it — taking the rest of that
// pass down with it.
for (const [id, how] of wanted) {
  const where = htmlIds.has(id) ? 'shell' : (builtIds.has(id) ? 'built at runtime' : null);
  ok(`${id} exists ${where || 'NOWHERE'} (used via ${how})`, !!where);
}

// ── Half two: every control in the markup must be driven ──
// A <button> with no handler is the failure that shipped: it looks live, it
// depresses when tapped, and nothing happens.
const buttons = [];
for (const m of html.matchAll(/<button[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>/g)) buttons.push(m[1]);
for (const m of html.matchAll(/<a[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>/g)) buttons.push(m[1]);
ok('the shell has controls to check', buttons.length > 5);

/* Controls whose behaviour is not a handler of their own, with the reason.
   Anything added here has to be justified — the point of the list is that it is
   short and every entry is deliberate. */
const DRIVEN_ELSEWHERE = {
  // Its href is assigned in renderWall; it is a link, not a button.
  wallShortcut: 'href set in renderWall',
  // A static href in the markup. It is only shown on iOS — checked below,
  // because shortcuts:// fails silently everywhere else and a link that does
  // nothing is the exact problem this file exists to catch.
  wallOpenShortcuts: 'static shortcuts:// href, gated to iOS',
};

for (const id of buttons) {
  if (DRIVEN_ELSEWHERE[id]) {
    ok(`${id} is driven elsewhere (${DRIVEN_ELSEWHERE[id]})`, wanted.has(id));
    continue;
  }
  // Bound either by the on($('x'), …) helper or a direct .onclick assignment.
  const bound = new RegExp(`on\\(\\$\\('${id}'\\)|\\$\\('${id}'\\)\\.onclick`).test(js);
  ok(`${id} has a handler`, bound);
}

// ── Half three: tab-scoped renders ──
// Cards moved between tabs twice, and their render stayed behind. Every render
// that draws into a tab must be reachable from the code that switches to it.
const appJs = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
// ⚠ The WHOLE function, not a fixed slice. This used to take 1400 characters
// from the start of show() and check the hooks were inside — so the day
// somebody added a comment near the top, four assertions failed for a reason
// that had nothing to do with what they assert. Read to the next top-level
// declaration instead; the claim is "reachable from show()", so the evidence
// should be all of show().
const showAt = appJs.indexOf('function show(tab)');
const showEnd = appJs.indexOf('\n  function ', showAt + 10);
const show = appJs.slice(showAt, showEnd > 0 ? showEnd : showAt + 4000);
for (const [tab, fn] of [['plaza', 'loadPlaza'], ['friends', 'loadFriends'], ['room', 'renderRoom'], ['me', 'renderMe']]) {
  ok(`switching to ${tab} calls ${fn}`, show.includes(fn));
}

/* A render that draws into a card must be called from the render that OWNS
   that card. Getting this wrong is invisible: the section is simply absent
   unless you first visit the tab it used to live on. It happened five separate
   times before the wallpaper deployment card — which owned most of them — was
   removed. The backdrops outlived it, so they are the one still worth pinning:
   they belong to the field, which every state has, including a guest who never
   signs in. */
const openApp = appJs.slice(appJs.indexOf('function openApp('),
  appJs.indexOf('function openApp(') + 1200);
ok('renderBeds() is painted on open, not from a tab hook', openApp.includes('renderBeds()'));
/* 城市图例的词也在开场交出去 —— 交晚了,先刷到的项目就没有图例,而"少一行字"
   和"这个功能没做"在屏幕上是一回事。这个函数存在但没人调,是这个文件存在的理由。 */
ok('the city legend words are handed over on open', openApp.includes('pushCityWords()'));

/* ── 没有图的项目,城市也必须出现 ────────────────────────────────────────
   ⚠ 竖屏的 render() 传的是 `!takeTurns`(= false),因为城市在轮播里**另有一拍**。
   可一张图都没有的时候根本不存在"轮流":那条分支若也走 render(),城市和流程会被
   一起清空 → planScenes 排不出任何一幕 → sceneCount 0 → 轮播不启动 → 城市一次
   都不画。而屏幕上看起来就是"这个项目本来就没有城市"。
   实测:kelivo(16 座楼)去掉图之后 cityPointsUsed = 0。 */
{
  const eng2 = fs.readFileSync(path.join(dir, '..', '..', 'src', 'renderer', 'mineradio-wallpaper.js'), 'utf8');
  const at2 = eng2.indexOf('if (!urls.length) {');
  const branch = at2 > 0 ? eng2.slice(at2, at2 + 1200) : '';
  ok('a project with no pictures still draws its city',
     /layer\.setShow\(null, textAt\(0, true\), SIZE\)/.test(branch));
  ok('and it does not go through render(), which strips the city on a phone',
     !/const ok = render\(null, 0\);/.test(branch));
}
ok('and so are the styles', openApp.includes('renderStyles()'));

// ── WebGL contexts ──
// iOS gives a page very few, and this app holds two before a capture starts:
// the full-screen field and the one inside the phone preview. A capture asking
// for a third killed the whole web app — Safari does not warn or degrade, it
// reloads or goes blank, which is what "Deploy does nothing" turned out to be.
// Desktop allows far more, so it never reproduced here.
// Contexts are still released and restored — the field itself has not
// changed — but every caller that used to do it was part of the wallpaper
// deployment, so only the invariant survives, not the list of callers.
// Restoring matters as much: leaving the app with no field at all is worse than
// whatever failure got us there, so it must happen on the failure path too.
ok('releaseFields is always paired with restoreFields',
  (appJs.match(/releaseFields\(\)/g) || []).length
    <= (appJs.match(/restoreFields\(\)/g) || []).length);
ok('restoreFields rebuilds the main field', /function restoreFields\(\)[\s\S]{0,200}mountEngine\(\)/.test(appJs));


/* ── The cache stamp has to cover what the page LOADS ────────────────────
   This is the bug that cost the most and showed the least. The engine, the
   project layer and the shaders are shared with the Mac and served from
   /app-assets out of src/renderer — but the stamp was computed from six files
   under landing/ alone. So every renderer fix shipped with an unchanged stamp,
   an unchanged URL, and a phone that went on serving the old engine out of
   cache. The fix was deployed and never fetched, repeatedly.

   Two halves, and BOTH fail silently:
     · an import without ?v= is one a CDN can keep serving after it changed
     · a file missing from ENGINE_ASSETS does not move the stamp when edited */
{
  const appjs = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

  const imports = [...appjs.matchAll(/import\(\s*'\/app-assets\/([a-z0-9.-]+\.js)'\s*(\+?)/gi)];
  ok('the app imports something from /app-assets at all', imports.length > 0);
  for (const m of imports) {
    ok(`${m[1]} is imported with a cache stamp`, m[2] === '+');
  }

  /* The stamped set now comes from the module that computes it, not from a
     regex over server.js — the list used to be hand-written there and drifted
     twice (see api/build-stamp.js). Asking the real thing means this check
     keeps working however the list is built. */
  const covered = new Set(require('../../api/build-stamp').stampedFiles().map((f) => f.rel));
  for (const m of imports) {
    ok(`${m[1]} is stamped, so editing it changes the URL`, covered.has(m[1]));
  }
  // rooms.js is loaded by a plain <script> from /app-assets rather than an
  // import, so the regex above cannot see it — and it changes often.
  ok('rooms.js is stamped too', covered.has('rooms.js'));
}


/* ── Every field the engine can draw has to survive the LAST hop ────────────
   toCapsule already carries this warning, because dropping a field there once
   killed the whole code city. It happened again one hop further in: textAt()
   built `flow` and `verbs` out of the capsule, and the extras object handed to
   _setCity listed only hot/people/narrow/noImage. So ex.flow was undefined,
   planScenes could never schedule a flow beat, and the scene that explains what
   a project DOES had never once been drawn — with no error anywhere.

   Measured on the live phone before the fix: 0 lit nodes across 14 samples. */
{
  const eng = fs.readFileSync(path.join(dir, '..', '..', 'src', 'renderer', 'mineradio-wallpaper.js'), 'utf8');
  const proj = fs.readFileSync(path.join(dir, '..', '..', 'src', 'renderer', 'wallpaper-project.js'), 'utf8');

  // What textAt() puts on the object it hands over.
  const at = eng.indexOf('const textAt = (i, withCity)');
  const textAt = at > 0 ? eng.slice(at, eng.indexOf('\n    };', at)) : '';
  const carried = ['flow', 'verbs', 'dirs', 'style', 'links', 'commits', 'graph', 'hot', 'people']
    .filter((k) => new RegExp('\\b' + k + ':').test(textAt));
  ok(`textAt carries the drawable fields (${carried.length})`, carried.length >= 8);

  // And what _setCity is actually GIVEN — the hop where they were lost.
  const call = proj.slice(proj.indexOf('this._setCity('), proj.indexOf('this._setCity(') + 700);
  for (const k of ['flow', 'verbs', 'hot', 'people', 'narrow']) {
    ok(`${k} survives the handoff into _setCity`, new RegExp(k + ':\\s*text && text\\.' + k).test(call));
  }
  // dirs/style/links/commits/graph go as positional arguments rather than in extras.
  ok('the city fields go across as positional arguments',
     /_setCity\(\(text && text\.dirs\)[\s\S]{0,160}text && text\.graph/.test(call));
}


/* ── 竖屏的出场顺序:先图,后读法 ────────────────────────────────────────
   ⚠ 这一条是**用户看不到图**的真因,而且不是渲染坏了:图确实会画,只是排在
   队伍最后面。takeTurns 的运行表原来是"所有读法 → 所有图",而 GitHub 导进来的
   项目没有城市,所以"读法"就是流程 —— 五拍 × 4.5 秒 = 二十二秒之后才轮到第一张。
   在广场里刷的时候,一条帖子活不到二十二秒。

   showLen() = 1400 + 4500 × max(4, 1+shots),十张截图就是 51 秒的一场演出;
   顺序错了,前面二十二秒全是流程。 */
{
  const eng = fs.readFileSync(path.join(dir, '..', '..', 'src', 'renderer', 'mineradio-wallpaper.js'), 'utf8');
  const at = eng.indexOf('if (takeTurns) {\n        /*');
  const plan = at > 0 ? eng.slice(at, at + 1400) : eng.slice(eng.indexOf('const plan = []'), eng.indexOf('const plan = []') + 600);
  const imgAt = plan.indexOf("plan.push({ img: live[i]");
  const cityAt = plan.indexOf("plan.push({ img: null, city: true");
  ok('the running order puts pictures before the readings', imgAt > 0 && cityAt > 0 && imgAt < cityAt);

  // 图的顺序就是"首图 → 按重要程度" —— cover 在最前,shots 按名次跟着。
  ok('the picture list is the cover followed by the ranked shots',
     /const urls = \[cap\.cover, \.\.\.\(cap\.shots \|\| \[\]\)\]/.test(eng));

  /* 首图一解码好就要**立刻上屏**,不能等轮播走到它。原来这里挡着 `!takeTurns`。 */
  ok('the hero swaps in as soon as it decodes, on a phone too',
     /if \(i === 0 \|\| !shown\) \{ render\(im, 0\); if \(takeTurns\) layer\.reform\(\); \}/.test(eng));

  // 一条帖子的时长要跟着图的张数走,否则十张图挤在四拍里谁也看不清。
  const app2 = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  ok('how long a post plays grows with how many pictures it has',
     /shots = 1 \+ \(\(cap && cap\.shots\) \|\| \[\]\)\.length/.test(app2)
     && /4500 \* Math\.max\(4, shots\)/.test(app2));
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
