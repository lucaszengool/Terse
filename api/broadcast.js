/**
 * broadcast.js —— 全员广播:我在服务端发一条,所有 app 各收到**一次**,关掉就不再出现。
 *
 * 平时这个接口返回 `{items:[]}`,客户端什么都不画 —— 没有公告的时候用户看不到任何东西。
 *
 * 设计取的几条(和外面通行的做法一致,见下):
 *   · **按 id + rev 记"关过了"**。只按 id 记的话,公告发出去之后再改文案,
 *     已经关掉的人永远看不到新版本;带上 rev,改一次 = 重新发一次。
 *   · **一次只发一条**。同时挂三条横幅的界面没人看,这里直接在服务端取最新的一条。
 *   · **客户端只在启动时拉一次**(外加一个很慢的心跳),不做秒级轮询 ——
 *     公告不是实时消息,没必要为它常驻一条连接。
 *   · 没有公告就老老实实返回空清单,不要 404 —— 客户端不用去区分"没有"和"坏了"。
 *
 * 发布方式两条,哪条都行:
 *   ① POST /api/broadcast(带 `x-admin-token`,值 = Railway 上的 BROADCAST_ADMIN_TOKEN)
 *      —— 改完立刻生效,不用重新部署。
 *   ② Railway 的环境变量 BROADCAST_JSON = 一条 JSON —— 数据库里没有在发的公告时
 *      用它兜底。适合"我就想在面板里敲一行字然后 redeploy"。
 *
 * ⚠ 没有设 BROADCAST_ADMIN_TOKEN 的话 POST 一律拒绝。宁可发不出公告,
 *   也不能留一个谁都能往所有人屏幕上推字的接口。
 */

const express = require('express');
const db = require('./db');

const router = express.Router();

db.db.exec(`
  CREATE TABLE IF NOT EXISTS broadcasts (
    id          TEXT PRIMARY KEY,
    rev         INTEGER NOT NULL DEFAULT 1,
    level       TEXT    NOT NULL DEFAULT 'info',   -- info | warn | release
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL DEFAULT '',
    cta_label   TEXT,
    cta_url     TEXT,
    starts_at   INTEGER,                            -- 毫秒;空 = 立刻
    ends_at     INTEGER,                            -- 毫秒;空 = 不过期
    platform    TEXT,                               -- 'mac' | 'windows' | 空 = 都发
    published   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`);

const now = () => Date.now();

/** Railway 环境变量兜底:数据库里没有在发的公告时用它。 */
function fromEnv() {
  const raw = process.env.BROADCAST_JSON;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || !v.title) return null;
    return {
      id: String(v.id || 'env'),
      rev: Number(v.rev || 1),
      level: v.level || 'info',
      title: String(v.title),
      body: String(v.body || ''),
      ctaLabel: v.ctaLabel || null,
      ctaUrl: v.ctaUrl || null,
      platform: v.platform || null,
      startsAt: v.startsAt || null,
      endsAt: v.endsAt || null,
    };
  } catch (e) {
    // 环境变量里的 JSON 写坏了不该让接口 500 —— 那样等于一条公告打挂了所有客户端的启动请求
    console.warn('[broadcast] BROADCAST_JSON 解析失败:', e.message);
    return null;
  }
}

function rowToItem(r) {
  return {
    id: r.id, rev: r.rev, level: r.level, title: r.title, body: r.body,
    ctaLabel: r.cta_label || null, ctaUrl: r.cta_url || null,
    platform: r.platform || null, startsAt: r.starts_at || null, endsAt: r.ends_at || null,
  };
}

function activeItem(platform) {
  const t = now();
  const rows = db.db.prepare(`
    SELECT * FROM broadcasts
     WHERE published = 1
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at   IS NULL OR ends_at   >= ?)
     ORDER BY updated_at DESC`).all(t, t);
  const hit = rows.find(r => !r.platform || !platform || r.platform === platform);
  if (hit) return rowToItem(hit);
  const env = fromEnv();
  if (!env) return null;
  if (env.platform && platform && env.platform !== platform) return null;
  if (env.startsAt && env.startsAt > t) return null;
  if (env.endsAt && env.endsAt < t) return null;
  return env;
}

/** 客户端每次启动拉一次。没有公告 = `{items:[]}`,不是 404。 */
router.get('/', (req, res) => {
  let item = null;
  try {
    item = activeItem(typeof req.query.platform === 'string' ? req.query.platform : null);
  } catch (e) {
    // 公告挂了不该连累客户端启动:出错就当"现在没有公告"
    console.warn('[broadcast] 读取失败:', e.message);
  }
  // 五分钟的边缘缓存:发一条新的最多五分钟内到齐,而平时几万次启动都打不到数据库
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ items: item ? [item] : [] });
});

function admin(req, res, next) {
  const want = process.env.BROADCAST_ADMIN_TOKEN;
  if (!want) return res.status(403).json({ error: '服务端没有设 BROADCAST_ADMIN_TOKEN,发布接口是关着的' });
  const got = req.get('x-admin-token') || '';
  // 定长比较:token 比对不该因为耗时差异漏出前缀
  const crypto = require('crypto');
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad token' });
  }
  next();
}

/** 发一条 / 改一条。文案变了 rev 自动 +1 —— 关掉过的人会再看到一次新的。 */
router.post('/', admin, (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').trim();
  const title = String(b.title || '').trim();
  if (!id || !title) return res.status(400).json({ error: '要 id 和 title' });
  const body = String(b.body || '');
  const prev = db.db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
  const changed = !prev || prev.title !== title || prev.body !== body ||
                  (prev.cta_url || '') !== (b.ctaUrl || '');
  const rev = prev ? (changed ? prev.rev + 1 : prev.rev) : 1;
  const t = now();
  db.db.prepare(`
    INSERT INTO broadcasts (id, rev, level, title, body, cta_label, cta_url, starts_at, ends_at,
                            platform, published, created_at, updated_at)
    VALUES (@id, @rev, @level, @title, @body, @cta_label, @cta_url, @starts_at, @ends_at,
            @platform, 1, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      rev = @rev, level = @level, title = @title, body = @body, cta_label = @cta_label,
      cta_url = @cta_url, starts_at = @starts_at, ends_at = @ends_at, platform = @platform,
      published = 1, updated_at = @updated_at`).run({
    id, rev, level: String(b.level || 'info'), title, body,
    cta_label: b.ctaLabel || null, cta_url: b.ctaUrl || null,
    starts_at: b.startsAt ? Number(b.startsAt) : null,
    ends_at: b.endsAt ? Number(b.endsAt) : null,
    platform: b.platform || null,
    created_at: prev ? prev.created_at : t, updated_at: t,
  });
  res.json({ ok: true, id, rev });
});

/** 撤下一条(不删,留着好知道发过什么)。 */
router.delete('/:id', admin, (req, res) => {
  const r = db.db.prepare('UPDATE broadcasts SET published = 0, updated_at = ? WHERE id = ?')
    .run(now(), req.params.id);
  res.json({ ok: true, changed: r.changes });
});

/** 发过哪些(管理用)。 */
router.get('/all', admin, (_req, res) => {
  res.json({ items: db.db.prepare('SELECT * FROM broadcasts ORDER BY updated_at DESC').all().map(rowToItem) });
});

module.exports = router;
