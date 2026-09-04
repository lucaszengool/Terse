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
  r = await req('POST', '/projects', {
    identity: ME, body: { capsule: capsule({ id: 'p_big', title: 'Big', cover: 'data:image/jpeg;base64,' + 'A'.repeat(70000) }) },
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

  // 收尾:别把测试数据留在库里
  await req('DELETE', '/projects/p_remote', { identity: ME });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
