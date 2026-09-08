/**
 * 补数据那条管理口的契约测试。
 *
 *   node api/backfill.test.js
 *
 * 这条口存在的唯一理由,是公开的发布口**对**、但对不上运维这件事:每地址十条一小时、
 * 十分钟六十条的保险丝、以及 upsert 会把 published_at 刷成 now。前两条让补一百条要
 * 花十小时,第三条会把这面特意排过顺序的墙整个搅乱。
 *
 * 所以这里钉的是三件事:它默认**不存在**;它认密钥;以及它**只**改胶囊 ——
 * 时间、身份、浏览数、点赞、评论全都不动。一条能改胶囊的后门如果顺手动了别的,
 * 那就不是补数据,是重发。
 */
process.env.PLAZA_ADMIN_TOKEN = 'test-admin-token-0123456789';

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/projects', require('./projects'));
const server = http.createServer(app);

function req(method, p, { identity, admin, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path: p, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(identity ? { 'x-terse-identity': identity } : {}),
        ...(admin ? { 'x-terse-admin': admin } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ADMIN = process.env.PLAZA_ADMIN_TOKEN;
const WHO = 'backfill-test-identity';

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\nplaza · backfill\n');

  // 一颗**升级之前**的胶囊:有城市,没有 flow/verbs/frames —— 线上那一百颗的样子。
  const before = {
    id: 'bf-1', title: 'A project', subtitle: 'from before the upgrade',
    kind: 'project', style: 'modern',
    dirs: [{ name: 'src', files: 12, bytes: 40000, lang: 'Rust', depth: 1 }],
    commits: [3, 5, 2, 8], link: 'https://github.com/o/r',
  };
  /* ⚠ 这一行**不走公开的发布口**,而这本身就是一条教训:第一版走了,于是单跑
     没问题、连着整套跑就失败 —— 前面的 spam / plaza / projects 几套测试十分钟内
     发的帖子加起来越过了那道"六十条"的保险丝,我的第一次发布拿到 503。
     被测的是 /backfill,不是发布,所以行直接落库,这套测试就和别人无关了。 */
  const identity = crypto.createHash('sha256').update(WHO).digest('hex').slice(0, 32);
  const id = 'wp_' + crypto.createHash('sha256').update(identity + '|' + before.id).digest('hex').slice(0, 16);
  db.upsertWallProject.run({ id, identity, title: before.title, capsule: JSON.stringify(before) });
  ok('a pre-upgrade project is on the wall', !!db.wallProjectOwner.get(id));

  // 浏览数和点赞要能证明"没被动过",所以先让它们不是 0。
  db.bumpWallProjectViews.run(id);
  db.addWallReaction.run({ project_id: id, identity: 'someone-else-hash', kind: 'like' });

  const read = async () => (await req('GET', '/projects/public?limit=50')).json.projects.find((p) => p.id === id);
  const was = await read();
  ok('it starts with no flow and no verbs', !was.capsule.flow && !(was.capsule.verbs || []).length);
  ok('and it has a view and at least one like on it', was.views >= 1 && was.likes >= 1);

  const enriched = Object.assign({}, was.capsule, {
    flow: { kind: 'cli', entry: 'thing', cmds: ['scan', 'diff'] },
    verbs: ['scan', 'diff', 'Report a run'],
  });

  // ── 认证 ──
  ok('no token at all is refused',
     (await req('POST', '/projects/backfill', { body: { updates: [{ id, capsule: enriched }] } })).status === 403);
  ok('a wrong token of the same length is refused',
     (await req('POST', '/projects/backfill', { admin: 'x'.repeat(ADMIN.length), body: { updates: [{ id, capsule: enriched }] } })).status === 403);
  ok('a wrong token of a different length is refused, not crashed',
     (await req('POST', '/projects/backfill', { admin: 'short', body: { updates: [{ id, capsule: enriched }] } })).status === 403);
  ok('an empty update list is refused',
     (await req('POST', '/projects/backfill', { admin: ADMIN, body: { updates: [] } })).status === 400);

  // ── 真正补一次 ──
  const res = await req('POST', '/projects/backfill', { admin: ADMIN, body: { updates: [{ id, capsule: enriched }] } });
  ok('the right token is accepted', res.status === 200);
  ok('and it reports one update', res.json && res.json.updated === 1);

  const now = await read();
  ok('the flow is there now', !!(now.capsule.flow && now.capsule.flow.entry === 'thing'));
  ok('the verbs are there now', (now.capsule.verbs || []).length === 3);
  ok('the city it already had is untouched', (now.capsule.dirs || []).length === 1);

  /* ★ 这四条是这条口和"重发一遍"的**全部**区别。 */
  ok('published_at is NOT touched', now.published_at === was.published_at);
  ok('the id is the same row', now.id === was.id);
  ok('the view count survives', now.views === was.views);
  ok('the like survives', now.likes === was.likes);

  // ── 它仍然是一道闸,不是一个洞 ──
  const evil = await req('POST', '/projects/backfill', {
    admin: ADMIN,
    body: { updates: [{ id, capsule: Object.assign({}, enriched, { link: 'javascript:alert(1)' }) }] },
  });
  ok('a javascript: link is still stripped by sanitize', evil.status === 200
     && !(await read()).capsule.link.startsWith('javascript:'));

  const ghost = await req('POST', '/projects/backfill', {
    admin: ADMIN, body: { updates: [{ id: 'wp_nope', capsule: enriched }] },
  });
  ok('an unknown id is reported, not silently counted',
     ghost.json.updated === 0 && ghost.json.failed.length === 1);

  /* ⚠ 真正保证"时间不动"的不是上面那条断言 —— 发布和补数据发生在同一秒里,就算
     真的刷新了也可能看不出来。保证它的是那条 SQL 里**没有** published_at。 */
  const dbSrc = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
  const stmt = (dbSrc.match(/updateWallProjectCapsule = db\.prepare\(\s*'([^']+)'/) || [])[1] || '';
  ok('the UPDATE statement sets only title and capsule',
     /SET title = @title, capsule = @capsule WHERE id = @id/.test(stmt) && !/published_at/.test(stmt));

  /* 而这一条守的是那道限流:它必须只算**发布**那一条路径。原来它只问方法,于是
     每打开一个项目发一次的 /:id/view 也算进十条里 —— 逛十个项目就发不了帖了。 */
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok('the publish limiter counts only POSTs to the publish path itself',
     /skip: \(req\) => req\.method !== 'POST' \|\| req\.path !== '\/'/.test(srv));

  db.deleteWallProjectById.run(id);
  server.close();
  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
  process.exit(fails.length ? 1 : 0);
})();
