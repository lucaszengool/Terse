/**
 * projects.js — 项目粒子的广场。
 *
 * 这个路由的全部工作是**存 JSON、发 JSON**。它不渲染、不转码、不存图片文件:
 * 上传的是一颗"胶囊" —— 标题、一张 96px 的封面 data URL、几行字 —— 收到的人在
 * **自己的机器上**用同一台粒子引擎把它生成出来。所以一次预览的服务器成本就是
 * 一次几十 KB 的 JSON 读取,和这个功能的画面复杂度完全无关。
 *
 * 成本闸门是**大小**,而且必须在服务端再挡一次:客户端那半边也在挡,但客户端是
 * 可以被绕过的,而这里挡的是账单。
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

/** 一颗胶囊的上限。96px 封面 + 两张附图 + 几行字,正常在 8–20KB;64KB 是给
 *  异常留的余量,不是给"再多塞一张图"留的空间。 */
const MAX_CAPSULE_BYTES = 64 * 1024;
/** 一个人最多挂多少个项目在广场上。防的是刷屏,不是防坏人。 */
const MAX_PER_IDENTITY = 24;

/** 身份:和 rooms 那边同一套 —— 客户端传自己的 Clerk 用户 id,服务端只存它的哈希。
 *  广场只需要"同一个人",不需要知道他是谁。 */
function idHash(req) {
  const raw = String(req.get('x-terse-identity') || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** 服务端的主键:身份 + 客户端那颗胶囊的 id。**不能**直接用客户端给的 id 当主键 ——
 *  那样任何人都能用同一个 id 覆盖掉别人的项目。 */
function serverId(identity, srcId) {
  return 'wp_' + crypto.createHash('sha256').update(identity + '|' + srcId).digest('hex').slice(0, 16);
}

/** 只留认识的字段,并且逐个夹长度。存进去的东西会被别人的机器拿去生成画面,
 *  所以这里既是成本闸门,也是"别人喂过来的数据不能直接落库"的那道闸。 */
function sanitize(capsule) {
  if (!capsule || typeof capsule !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const dataUrl = (v) => {
    const s = str(v, MAX_CAPSULE_BYTES);
    // 只收内联的图。远程 URL 会让"预览"变成一次对第三方的请求,而且那张图随时会变。
    return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
  };
  const out = {
    v: 1,
    // 客户端那颗胶囊自己的 id。服务端不直接用它当主键(那样别人就能覆盖你的项目),
    // 而是和身份一起哈希 —— 于是"同一个人的同一个项目"重复发布是覆盖,而且删除时
    // 客户端拿自己的本地 id 就能定位到它。
    srcId: str(capsule.id, 40),
    title: str(capsule.title, 48).trim(),
    subtitle: str(capsule.subtitle, 160).trim(),
    tags: Array.isArray(capsule.tags) ? capsule.tags.slice(0, 4).map((t) => str(t, 16)) : [],
    cover: dataUrl(capsule.cover),
    shots: Array.isArray(capsule.shots) ? capsule.shots.slice(0, 2).map(dataUrl).filter(Boolean) : [],
    lines: Array.isArray(capsule.lines) ? capsule.lines.slice(0, 4).map((l) => str(l, 40)) : [],
    files: Math.max(0, Math.min(9_999_999, parseInt(capsule.files, 10) || 0)),
    langs: Array.isArray(capsule.langs)
      ? capsule.langs.slice(0, 3).map((p) => [str(p && p[0], 16), Math.max(0, Math.min(1, +(p && p[1]) || 0))])
      : [],
  };
  if (!out.title) return null;
  return out;
}

// POST /api/cloud/projects   Body: { capsule }
router.post('/', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const capsule = sanitize((req.body || {}).capsule);
  if (!capsule) return res.status(400).json({ error: 'Bad capsule' });

  const json = JSON.stringify(capsule);
  if (json.length > MAX_CAPSULE_BYTES) {
    return res.status(413).json({ error: 'Capsule too large', max: MAX_CAPSULE_BYTES });
  }
  if (db.countWallProjects.get({ identity: me }).n >= MAX_PER_IDENTITY) {
    return res.status(429).json({ error: 'Too many published projects', max: MAX_PER_IDENTITY });
  }
  // id 由**内容**决定:同一个项目重复发布是覆盖,不是又长出一个。
  const id = serverId(me, capsule.srcId || capsule.title);
  db.upsertWallProject.run({ id, identity: me, title: capsule.title, capsule: json });
  res.json({ ok: true, id });
});

// GET /api/cloud/projects/public?limit=
// 不需要身份:广场就是给人逛的。列表**直接带着整颗胶囊** —— 客户端点预览时不用再
// 请求一次,粒子在他自己机器上生成。
router.get('/public', (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = db.listWallProjects.all({ limit });
  res.json({
    ok: true,
    projects: rows.map((r) => {
      let capsule = null;
      try { capsule = JSON.parse(r.capsule); } catch (e) {}
      return { id: r.id, title: r.title, published_at: r.published_at, views: r.views, capsule };
    }).filter((p) => p.capsule),
  });
});

// POST /api/cloud/projects/:id/view — 预览计数。故意做成"尽力而为":
// 数不准也没关系,但它是作者唯一能看到的反馈。
router.post('/:id/view', (req, res) => {
  db.bumpWallProjectViews.run(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/cloud/projects/:id  (作者本人)
router.delete('/:id', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  // :id 收的是**客户端本地那颗胶囊的 id** —— 服务端自己推导出主键,所以客户端不必
  // 记住服务端的 id,也不可能删掉别人的项目(推导里带着身份)。
  db.deleteWallProject.run({ id: serverId(me, req.params.id), identity: me });
  res.json({ ok: true });
});

module.exports = router;
