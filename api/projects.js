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

/** 一颗胶囊的上限。224px 封面 + 最多四张附图 + 几行字,正常在 30–90KB。
 *  160KB 是给异常留的余量,不是给"再多塞一张图"留的空间 —— 图片张数由
 *  MAX_SHOTS 管,大小由这里管,两道闸各管各的。 */
const MAX_CAPSULE_BYTES = 160 * 1024;
/** 封面之外还能带几张。加上封面一共 5 张 —— 用户要的就是这个数。 */
const MAX_SHOTS = 4;
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
    // 2 = 带代码城市。1 只有封面和几行字。
    v: 2,
    // 客户端那颗胶囊自己的 id。服务端不直接用它当主键(那样别人就能覆盖你的项目),
    // 而是和身份一起哈希 —— 于是"同一个人的同一个项目"重复发布是覆盖,而且删除时
    // 客户端拿自己的本地 id 就能定位到它。
    srcId: str(capsule.id, 40),
    title: str(capsule.title, 48).trim(),
    subtitle: str(capsule.subtitle, 160).trim(),
    tags: Array.isArray(capsule.tags) ? capsule.tags.slice(0, 4).map((t) => str(t, 16)) : [],
    cover: dataUrl(capsule.cover),
    shots: Array.isArray(capsule.shots) ? capsule.shots.slice(0, MAX_SHOTS).map(dataUrl).filter(Boolean) : [],
    lines: Array.isArray(capsule.lines) ? capsule.lines.slice(0, 4).map((l) => str(l, 40)) : [],
    files: Math.max(0, Math.min(9_999_999, parseInt(capsule.files, 10) || 0)),
    langs: Array.isArray(capsule.langs)
      ? capsule.langs.slice(0, 3).map((p) => [str(p && p[0], 16), Math.max(0, Math.min(1, +(p && p[1]) || 0))])
      : [],
  };

  /* ── 代码城市 ─────────────────────────────────────────────────────────────────────
     扫描端一直在传这些字段(projects.rs 的 for_upload),而这里一直把它们**全部
     丢掉** —— 于是别人点开你的项目,只看得到封面和几行字,城市从来没有出现过。
     不是渲染坏了,是这颗胶囊里根本没有城市。

     它们**只是数字**:楼的名字和大小、周提交数、依赖的下标对。城市是在看的人
     自己机器上摆出来的,和封面走同一条"传参数、不传画面"的路。整座城市加起来
     不到 20KB。

     ⚠ 字段名字是按 projects.rs 的结构体**逐个对过**的,不是猜的。猜错不报错 ——
     渲染器只会安静地少画一层(星座要的是 `n`/`e`,不是 `nodes`/`edges`;
     热点要的是 `name`,不是 `path`)。

     每一项都自己夹长度。这颗胶囊会被别人的机器拿去生成画面,所以边界在这里,
     不在客户端 —— 客户端是可以绕过去的。 */
  const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));
  const frac = (v) => Math.max(0, Math.min(1, +v || 0));

  out.style = str(capsule.style, 24);
  // 一座楼 = 一个顶层目录。lang / depth / age_days / churn 一个都不能少 ——
  // 它们分别是楼色、退台层数、窗户冷暖和那根信标，少一个就少一种看得见的信息。
  out.dirs = Array.isArray(capsule.dirs) ? capsule.dirs.slice(0, 25).map((d) => ({
    name: str(d && d.name, 40),
    files: num(d && d.files, 0, 999999),
    bytes: num(d && d.bytes, 0, 9999999999),
    lang: str(d && d.lang, 24),
    langs: Array.isArray(d && d.langs)
      ? d.langs.slice(0, 3).map((l) => [str(l && l[0], 24), frac(l && l[1])]).filter((l) => l[0]) : [],
    kind: str(d && d.kind, 16),
    // [名字, 文件数, 字节] —— 三元组，放射年轮的第二圈靠它
    kids: Array.isArray(d && d.kids)
      ? d.kids.slice(0, 8)
          .map((k) => (Array.isArray(k) ? [str(k[0], 40), num(k[1], 0, 999999), num(k[2], 0, 9999999999)] : null))
          .filter((k) => k && k[0]) : [],
    depth: num(d && d.depth, 0, 64),
    age_days: num(d && d.age_days, 0, 9999),
    churn: num(d && d.churn, 0, 999999),
  })).filter((d) => d.name) : [];
  // 楼之间的弧:[from, to, weight],下标指向 dirs。指到界外的直接扔掉 ——
  // 一条画到虚空里的弧,在屏幕上就是一道没有来由的光。
  out.links = Array.isArray(capsule.links)
    ? capsule.links.slice(0, 120)
        .map((l) => (Array.isArray(l) ? [num(l[0], 0, 24), num(l[1], 0, 24), num(l[2], 0, 99999)] : null))
        .filter((l) => l && l[0] < out.dirs.length && l[1] < out.dirs.length && l[0] !== l[1])
    : [];
  // 提交天际线:53 周 × 7 天 = 371 个小整数。
  out.commits = Array.isArray(capsule.commits)
    ? capsule.commits.slice(0, 371).map((n) => num(n, 0, 65535)) : [];
  /* 依赖星座。形状是 `{n, e, c}`:节点是 [x, y, z, 度数, 社区] 的定点整数,
     边是下标对,c 是社区名。渲染器要求至少 4 个节点,不够就不画那一幕。 */
  const g = capsule.graph;
  out.graph = (g && typeof g === 'object' && Array.isArray(g.n) && Array.isArray(g.e)) ? {
    n: g.n.slice(0, 160)
        .map((p) => (Array.isArray(p) ? [num(p[0], -1000, 1000), num(p[1], -1000, 1000),
                                         num(p[2], -1000, 1000), num(p[3], 0, 9999), num(p[4], 0, 63)] : null))
        .filter(Boolean),
    e: g.e.slice(0, 400)
        .map((e) => (Array.isArray(e) ? [num(e[0], 0, 159), num(e[1], 0, 159)] : null))
        .filter(Boolean),
    c: Array.isArray(g.c) ? g.c.slice(0, 8).map((x) => str(x, 40)) : [],
  } : null;
  if (out.graph) {
    // 指到不存在的节点的边会把星座拉到原点，在屏幕上是一条莫名的亮线。
    out.graph.e = out.graph.e.filter((e) => e[0] < out.graph.n.length && e[1] < out.graph.n.length);
    if (out.graph.n.length < 4 || !out.graph.e.length) out.graph = null;
  }
  // 热点文件。字段是 name / churn / bytes / dir —— dir 把它接回它那座楼的颜色。
  out.hot = Array.isArray(capsule.hot) ? capsule.hot.slice(0, 40).map((h) => ({
    name: str(h && h.name, 80),
    churn: num(h && h.churn, 0, 999999),
    bytes: num(h && h.bytes, 0, 9999999999),
    dir: str(h && h.dir, 40),
  })).filter((h) => h.name) : [];
  /* 贡献者 [名字, 提交数]。⚠ 只留人名,**不留邮箱** —— 胶囊是要发到广场
     给陌生人看的。扫描端已经滤过一次,服务端必须自己再滤一次:客户端是可以
     绕过去的,而泄露一次就收不回来。 */
  out.people = Array.isArray(capsule.people)
    ? capsule.people.slice(0, 12)
        .map((p) => (Array.isArray(p) ? [str(p[0], 40), num(p[1], 0, 999999)] : null))
        .filter((p) => p && p[0] && p[0].indexOf('@') < 0)
    : [];

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
  /* 搜索。**在服务端过滤,不是让客户端筛它手上那一百个** —— 手机拿到的永远只是
     最新的一页,而人搜的是"广场上有没有这个",不是"我刚才刷到的里面有没有"。
     两者的区别在广场超过一页的那一天才会显出来,而那时候没人会想到是这里。

     匹配标题、副标题、标签和语言。整颗胶囊是一段 JSON 文本,直接 LIKE 它会让
     搜 "rust" 命中任何一个文件名里带 rust 的项目 —— 那不是搜索,是巧合。 */
  const q = String(req.query.q || '').trim().slice(0, 64).toLowerCase();
  // 有搜索词时多取一些再筛:限制的是**返回**多少,不是从多少里面找。
  const rows0 = db.listWallProjects.all({ limit: q ? 400 : limit });
  const rows = !q ? rows0 : rows0.filter((r) => {
    let c = null;
    try { c = JSON.parse(r.capsule); } catch (e) { return false; }
    const hay = [c.title, c.subtitle]
      .concat(Array.isArray(c.tags) ? c.tags : [])
      .concat(Array.isArray(c.langs) ? c.langs.map((l) => l && l[0]) : [])
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }).slice(0, limit);
  const me = idHash(req);

  // 计数一次查完,不是每个项目查一次:列表是 N 个项目,逐个查就是 N 次往返。
  const counts = {};
  for (const r of db.countWallReactions.all()) {
    (counts[r.project_id] || (counts[r.project_id] = {}))[r.kind] = r.n;
  }
  for (const r of db.countWallComments.all()) {
    (counts[r.project_id] || (counts[r.project_id] = {})).comments = r.n;
  }
  // 我点过什么 —— 没有身份就是空的,广场照样能逛。
  const mine = { like: new Set(), fav: new Set() };
  if (me) {
    for (const r of db.myWallReactions.all({ identity: me })) {
      if (mine[r.kind]) mine[r.kind].add(r.project_id);
    }
  }
  // 预览要"最高赞的三条评论"。在这里一并带出去,预览时就**不用再请求一次** ——
  // 和整颗胶囊跟着列表走是同一个理由:一次预览应该是零次额外往返。
  const top = {};
  for (const c of db.topWallComments.all()) {
    const arr = top[c.project_id] || (top[c.project_id] = []);
    if (arr.length < 3) arr.push({ body: c.body, likes: c.likes });
  }

  res.json({
    ok: true,
    projects: rows.map((r) => {
      let capsule = null;
      try { capsule = JSON.parse(r.capsule); } catch (e) {}
      const c = counts[r.id] || {};
      return {
        id: r.id, title: r.title, published_at: r.published_at, views: r.views, capsule,
        // 作者的短身份 —— 私信寄到这里。发布本身就是一次公开动作,而这串 32 位
        // 哈希除了"能给他发消息"什么也说明不了;那道闸仍然在 dm.js 上。
        author: r.identity,
        likes: c.like || 0, favs: c.fav || 0, comments: c.comments || 0,
        liked: mine.like.has(r.id), faved: mine.fav.has(r.id),
        topComments: top[r.id] || [],
      };
    }).filter((p) => p.capsule),
  });
});

// ── 点赞 / 收藏 ────────────────────────────────────────────────────────────
// 两种反应形状一模一样,所以逻辑只有一份;但**路径是两条明写的**,不是
// `:kind(like|fav)` 那种带正则的参数 —— 那个写法在 Express 5 里被移除了,升级的
// 那天它不会报错,只会安静地 404,而这是最难查的一类故障。
// 语义是**切换**:再点一次就取消,由主键冲突判断"已经点过了"。
function react(kind) {
  return (req, res) => {
    const me = idHash(req);
    if (!me) return res.status(401).json({ error: 'Missing identity' });
    const key = { project_id: req.params.id, identity: me, kind };
    const had = !!db.hasWallReaction.get(key);
    if (had) db.removeWallReaction.run(key);
    else db.addWallReaction.run(key);
    const n = db.countWallReactions.all()
      .filter((r) => r.project_id === key.project_id && r.kind === kind)
      .reduce((a, r) => a + r.n, 0);
    res.json({ ok: true, on: !had, count: n });
  };
}
router.post('/:id/like', react('like'));
router.post('/:id/fav', react('fav'));

// ── 评论 ───────────────────────────────────────────────────────────────────
/** 深度封顶 1 层:回复的回复,挂到它的顶层评论上。
 *
 *  这不是偷懒,是刻意的产品边界 —— 无限嵌套要么在 UI 上缩成一条看不懂的细线,
 *  要么逼着数据层去用闭包表为写放大付账。"评论 + 它下面的回复"两层就够。 */
function topLevelOf(parentId) {
  if (!parentId) return null;
  const p = db.getWallComment.get(parentId);
  if (!p) return null;
  return p.parent_id || p.id;
}

// GET /:id/comments —— 整棵树一条 SQL 查回来,在内存里拼。
router.get('/:id/comments', (req, res) => {
  const me = idHash(req);
  const rows = db.listWallComments.all({ project_id: req.params.id });
  const liked = new Set();
  if (me) for (const r of db.myWallCommentLikes.all({ identity: me })) liked.add(r.comment_id);
  const shape = (r) => ({
    id: r.id, body: r.body, author: r.author || null, likes: r.likes,
    created_at: r.created_at, liked: liked.has(r.id), mine: !!me && r.identity === me,
    replies: [],
  });
  const byId = new Map();
  const tops = [];
  for (const r of rows) if (!r.parent_id) { const s = shape(r); byId.set(r.id, s); tops.push(s); }
  for (const r of rows) if (r.parent_id) {
    const parent = byId.get(r.parent_id);
    if (parent) parent.replies.push(shape(r));
  }
  // 顶层按赞排(广场上最有用的先看到),回复按时间排(对话要读得通)。
  for (const t of tops) t.replies.sort((a, b) => a.created_at.localeCompare(b.created_at));
  res.json({ ok: true, comments: tops });
});

// POST /:id/comments  Body: { body, parentId? }
router.post('/:id/comments', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const b = req.body || {};
  const body = String(b.body || '').trim().slice(0, 600);
  if (!body) return res.status(400).json({ error: 'Empty comment' });
  const author = String(b.author || '').trim().slice(0, 40) || null;
  const id = 'c_' + crypto.randomBytes(8).toString('hex');
  db.insertWallComment.run({
    id, project_id: req.params.id, parent_id: topLevelOf(b.parentId),
    identity: me, author, body,
  });
  res.json({ ok: true, id });
});

// POST /api/cloud/projects/comments/:cid/like —— 同样是切换。
router.post('/comments/:cid/like', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const key = { comment_id: req.params.cid, identity: me };
  const before = db.getWallComment.get(req.params.cid);
  if (!before) return res.status(404).json({ error: 'No such comment' });
  const liked = db.myWallCommentLikes.all({ identity: me }).some((r) => r.comment_id === key.comment_id);
  if (liked) db.unlikeWallComment.run(key);
  else db.likeWallComment.run(key);
  // 计数是**算出来的**,不是加减出来的:加减会在并发或重试下漂,而这张表本身
  // 就是事实来源。
  db.syncWallCommentLikes.run({ id: key.comment_id });
  const after = db.getWallComment.get(req.params.cid);
  res.json({ ok: true, on: !liked, likes: after.likes });
});

// DELETE /api/cloud/projects/comments/:cid  (作者本人)
router.delete('/comments/:cid', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  db.deleteWallComment.run({ id: req.params.cid, identity: me });
  // 顶层评论被删,它下面的回复不该变成孤儿挂在那儿
  db.deleteWallCommentReplies.run(req.params.cid);
  res.json({ ok: true });
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
