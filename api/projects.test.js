/**
 * 项目粒子的广场。
 *
 *   node api/projects.test.js
 *
 * 这里钉的是**产品决定**,不是实现细节,而且每一条都直接对着这个功能的成本模型:
 *
 *   · 传的是胶囊,不是画面。列表必须**自带整颗胶囊** —— 客户端点预览时不再请求
 *     服务器,粒子是在他自己机器上生成的。哪天有人为了省事改成"预览时再拉一次",
 *     账单就会随用的人数线性长起来,而这件事在代码里看不出来。
 *   · 封面只收内联的 data URL。收远程 URL 会让一次预览变成一次对第三方的请求,
 *     而且那张图随时会变成别的东西。
 *   · 大小是**服务端**挡的。客户端那半边也挡,但客户端是可以绕过的,而这里挡的是账单。
 *   · 同一个人重复发布是覆盖,不是又长出一个;别人删不掉你的项目。
 */
// **先于 require('./db') 设好数据目录**:db.js 在被 require 的那一刻就打开数据库,
// 之后再改环境变量已经晚了。不设的话它落在 <repo>/data/terse.db —— 那是一个会
// 跨次留存的共享库,于是第二遍跑测试时上一遍的行还在,"重复发布是覆盖"这类断言
// 会假失败。假失败比真失败更贵:它会让人去改本来正确的实现。
const os = require('os');
const fspath = require('path');
process.env.TERSE_DATA_DIR = require('fs').mkdtempSync(fspath.join(os.tmpdir(), 'terse-projects-test-'));

const express = require('express');
const http = require('http');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/projects', require('./projects'));
const server = http.createServer(app);

function req(method, path, { identity, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: Object.assign(
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        identity ? { 'x-terse-identity': identity } : {},
      ),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ME = 'user_test_alpha';
const OTHER = 'user_test_beta';
const cover = 'data:image/jpeg;base64,' + 'A'.repeat(200);
const capsule = (over = {}) => Object.assign({
  id: 'p_alpha', title: 'Terse', subtitle: 'a monitor', cover,
  lines: ['812 files', 'rust 62% · js 30%'], langs: [['rust', 0.62], ['js', 0.3]], files: 812,
}, over);

(async () => {
  await new Promise((r) => server.listen(0, r));
  console.log('projects (广场)');


  // ── 发布 ──
  let r = await req('POST', '/projects', { identity: ME, body: { capsule: capsule() } });
  eq('publish returns 200', r.status, 200);
  ok('publish returns an id', !!(r.body && r.body.id));
  const firstId = r.body.id;

  // ── 列表自带胶囊 —— 这是"预览不花服务器钱"的全部原因 ──
  r = await req('GET', '/projects/public?limit=20');
  eq('public list is open to everyone', r.status, 200);
  const mine = r.body.projects.find((p) => p.title === 'Terse');
  ok('the listing carries the whole capsule', !!(mine && mine.capsule && mine.capsule.cover));
  ok('…including the lines the particles spell out', !!(mine && mine.capsule.lines.length));

  // ── 重复发布是覆盖 ──
  r = await req('POST', '/projects', { identity: ME, body: { capsule: capsule({ title: 'Terse renamed' }) } });
  eq('republishing keeps the same id', r.body.id, firstId);
  r = await req('GET', '/projects/public?limit=20');
  eq('…and replaces rather than duplicates',
     r.body.projects.filter((p) => p.title.startsWith('Terse')).length, 1);

  // ── 只收内联的图 ──
  await req('POST', '/projects', {
    identity: ME, body: { capsule: capsule({ id: 'p_remote', title: 'Remote', cover: 'https://evil.example/x.png' }) },
  });
  r = await req('GET', '/projects/public?limit=20');
  const remote = r.body.projects.find((p) => p.title === 'Remote');
  eq('a remote cover URL is dropped, not stored', remote.capsule.cover, '');

  // ── 大小闸门 ──
  // 上限是 160KB(五张 224px 的图),所以"超限"要真的超:70KB 现在是**合法**的。
  // 这条断言守的是账单,不是某个具体数字 —— 数字变了就跟着改,但闸门必须还在。
  r = await req('POST', '/projects', {
    identity: ME, body: { capsule: capsule({ id: 'p_big', title: 'Big', cover: 'data:image/jpeg;base64,' + 'A'.repeat(200000) }) },
  });
  eq('an oversized capsule is refused', r.status, 413);

  // ── 身份 ──
  r = await req('POST', '/projects', { body: { capsule: capsule({ id: 'p_anon' }) } });
  eq('publishing needs an identity', r.status, 401);

  // ── 删除只归作者 ──
  await req('DELETE', '/projects/p_alpha', { identity: OTHER });
  r = await req('GET', '/projects/public?limit=20');
  ok('a stranger cannot delete your project', r.body.projects.some((p) => p.title === 'Terse renamed'));
  await req('DELETE', '/projects/p_alpha', { identity: ME });
  r = await req('GET', '/projects/public?limit=20');
  ok('the author can', !r.body.projects.some((p) => p.title === 'Terse renamed'));

  // ── 计数 ──
  await req('POST', '/projects/' + encodeURIComponent(remote.id) + '/view');
  r = await req('GET', '/projects/public?limit=20');
  eq('a preview counts once', r.body.projects.find((p) => p.title === 'Remote').views, 1);

  // ── 五张图 ──
  // 张数由这里挡,大小由 MAX_CAPSULE_BYTES 挡 —— 两道闸各管各的。
  await req('POST', '/projects', {
    identity: ME,
    body: { capsule: capsule({ id: 'p_five', title: 'Five', shots: Array(7).fill(cover) }) },
  });
  r = await req('GET', '/projects/public?limit=20');
  const five = r.body.projects.find((p) => p.title === 'Five');
  eq('at most five images survive (cover + 4)', 1 + five.capsule.shots.length, 5);

  // ── 点赞 / 收藏:一人一次,再点是取消 ──
  const P = five.id;
  r = await req('POST', `/projects/${P}/like`, { identity: OTHER });
  eq('a like counts', r.body.count, 1);
  r = await req('POST', `/projects/${P}/like`, { identity: OTHER });
  eq('the same person cannot stack likes — it toggles off', r.body.count, 0);
  await req('POST', `/projects/${P}/like`, { identity: OTHER });
  await req('POST', `/projects/${P}/like`, { identity: ME });
  await req('POST', `/projects/${P}/fav`, { identity: OTHER });
  r = await req('POST', `/projects/${P}/like`, {});
  eq('reacting needs an identity', r.status, 401);

  // ── 评论:两层,顶层按赞排 ──
  r = await req('POST', `/projects/${P}/comments`, { identity: OTHER, body: { body: 'looks great', author: 'bo' } });
  const c1 = r.body.id;
  r = await req('POST', `/projects/${P}/comments`, { identity: ME, body: { body: 'how do I install' } });
  const c2 = r.body.id;
  await req('POST', `/projects/${P}/comments`, { identity: OTHER, body: { body: 'brew install', parentId: c2 } });
  await req('POST', `/projects/comments/${c2}/like`, { identity: OTHER });

  r = await req('GET', `/projects/${P}/comments`, { identity: OTHER });
  const tree = r.body.comments;
  eq('only top-level comments are roots', tree.length, 2);
  eq('the most-liked comment comes first', tree[0].body, 'how do I install');
  eq('a reply is nested under its parent', tree[0].replies[0].body, 'brew install');
  ok('everyone sees every comment', tree.some((c) => c.body === 'looks great'));
  ok('you can see which are yours', tree.find((c) => c.body === 'looks great').mine === true);
  ok('…and which you have liked', tree[0].liked === true);

  // 回复的回复 → 挂回同一条线程,而不是越缩越深
  const replyId = tree[0].replies[0].id;
  await req('POST', `/projects/${P}/comments`, { identity: ME, body: { body: 'thanks', parentId: replyId } });
  r = await req('GET', `/projects/${P}/comments`);
  const thread = r.body.comments.find((c) => c.body === 'how do I install');
  ok('a reply-to-a-reply stays in the same thread (depth is capped at 1)',
     thread.replies.some((x) => x.body === 'thanks') && r.body.comments.length === 2);

  r = await req('POST', `/projects/${P}/comments`, { identity: ME, body: { body: '   ' } });
  eq('an empty comment is refused', r.status, 400);
  r = await req('POST', `/projects/${P}/comments`, { body: { body: 'anon' } });
  eq('commenting needs an identity', r.status, 401);

  // ── 列表带齐互动数据 + 预览要的三条 ──
  r = await req('GET', '/projects/public?limit=20', { identity: OTHER });
  const p5 = r.body.projects.find((p) => p.title === 'Five');
  eq('the listing carries the like count', p5.likes, 2);
  eq('…the favourite count', p5.favs, 1);
  eq('…and the comment count', p5.comments, 4);
  ok('it says whether I liked it', p5.liked === true);
  // 预览要"最高赞的三条",而且**跟着列表一起发过来** —— 一次预览应该是零次额外往返。
  ok('the top comments ride along for the preview', p5.topComments.length >= 1);
  eq('…highest-liked first', p5.topComments[0].body, 'how do I install');

  // ── 删除评论:只有作者 ──
  await req('DELETE', `/projects/comments/${c1}`, { identity: ME });
  r = await req('GET', `/projects/${P}/comments`);
  ok('a stranger cannot delete your comment', r.body.comments.some((c) => c.body === 'looks great'));
  await req('DELETE', `/projects/comments/${c1}`, { identity: OTHER });
  r = await req('GET', `/projects/${P}/comments`);
  ok('the author can', !r.body.comments.some((c) => c.body === 'looks great'));

  // 收尾:别把测试数据留在库里
  await req('DELETE', '/projects/p_remote', { identity: ME });
  await req('DELETE', '/projects/p_five', { identity: ME });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
