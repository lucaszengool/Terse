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
const { spamReason, illegalReason, fingerprint } = require('./spam');

const router = express.Router();

/** 一颗胶囊的上限。224px 封面 + 最多四张附图 + 几行字,正常在 30–90KB。
 *  160KB 是给异常留的余量,不是给"再多塞一张图"留的空间 —— 图片张数由
 *  MAX_SHOTS 管,大小由这里管,两道闸各管各的。 */
const MAX_CAPSULE_BYTES = 160 * 1024;
/** 封面之外还能带几张。加上封面一共 5 张 —— 用户要的就是这个数。 */
/* ⚠ 4 → 10。一个像样的 README 常常铺着一张主视觉加五六张截图,而探针现在**全部**
   收得到并排好了序(见 api/repo-probe.js 的 collectMedia)。留 4 张等于把作者铺的
   一整页压成一格。真正的闸门是 MAX_CAPSULE_BYTES —— 装不下的那一端自己会往下减,
   这里只是别把"能装下的"提前砍掉。 */
const MAX_SHOTS = 10;
/* 动图是**一串帧**,不是一张图。帧多了整颗胶囊就大,所以帧要小、要少:12 张
   128px 的图 ≈ 30–70KB,还在 160KB 的闸门里面,而 12 帧在 12fps 下是一秒 ——
   够看出是什么动作,这正是一段循环需要的长度。 */
const MAX_FRAMES = 12;

/* 广场上有三种东西,不是一种。
     project — 一个项目,长成代码城市
     text    — 一段话,直接聚成字
     image   — 一张图(或一段动图),聚成画面
   全都以粒子呈现,这是这个广场唯一的规矩;区别只在**拿什么当输入**。
   认不出来的一律当 project,因为在这个字段存在之前发布的每一颗都是项目。 */
const KINDS = ['project', 'text', 'image'];

/* 配乐。胶囊里存的是**曲子的名字**,不是音频 —— 声音是每台设备自己用 WebAudio
   弹出来的(见 landing/phone/tunes.js)。所以这里只认这四个名字:别的一律当没有,
   而不是原样存下去,否则这个字段就成了一个可以往里塞任意字符串的洞。 */
/* 曲子的 id。⚠ 现在是**真的音频文件**(landing/audio/),不是合成器的名字 ——
   所以这张表要跟 landing/audio/tracks.json 对上,那份清单是抓取脚本生成的。
   还是要挡一次:这个字段最后会变成一个文件名去拼路径。 */
const TUNES = ["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11", "t12"];
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
    /* 介绍。副标题是**一行**(卡片上那句),介绍是**一段**(展开才看得全)——
       和抖音上传时的标题与文案是同一组关系。600 字够写清楚一个项目是什么、
       为什么做,再长的东西属于 README,不属于一张卡片。 */
    desc: str(capsule.desc, 600).trim(),
    tags: Array.isArray(capsule.tags) ? capsule.tags.slice(0, 4).map((t) => str(t, 16)) : [],
    cover: dataUrl(capsule.cover),
    kind: KINDS.indexOf(String(capsule.kind || '')) >= 0 ? String(capsule.kind) : 'project',
    /* 一段动图的帧。和 shots 分开存:shots 是"这个项目的几张截图",一张一拍;
       frames 是**一个动作**,要按帧率连着放。混成一个字段,播放的那一端就分不出
       该慢慢轮播还是该动起来。 */
    frames: Array.isArray(capsule.frames)
      ? capsule.frames.slice(0, MAX_FRAMES).map(dataUrl).filter(Boolean) : [],
    fps: Math.max(2, Math.min(24, parseInt(capsule.fps, 10) || 12)),
    tune: TUNES.indexOf(String(capsule.tune || '')) >= 0 ? String(capsule.tune) : '',
    /* 一条可以点开的链接。⚠ **只收 http/https**:这个字段最后会变成界面上一个
       可以点的东西,而 `javascript:` 开头的字符串一旦被当成链接放出去,就是让
       发帖的人在别人的页面上执行代码。协议在这里挡一次,客户端再挡一次 ——
       两边都挡,因为两边都可能被绕过。 */
    link: (function () {
      const raw = String(capsule.link || '').trim().slice(0, 300);
      if (!/^https?:\/\//i.test(raw)) return '';
      try { const u = new URL(raw); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : ''; }
      catch (e) { return ''; }
    }()),
    // 调号。见 tunes.js:同一首换个调就是另一段音乐,而这是让五十条帖子各有各的
    // 配乐最省的办法 —— 存一个 0–11 的小整数,不存一秒钟音频。
    key: Math.max(0, Math.min(11, parseInt(capsule.key, 10) || 0)),
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

  /* ── 这个项目在**干什么** ──────────────────────────────────────────────
     代码城市说的是"由什么组成",这三样说的是"它做什么"。都是**参数**,加起来
     不到一千字节 —— 画面还是在看的人自己机器上长出来的。

       flow  入口点:它是命令行、服务、应用,还是库,以及你敲的那个名字。
       verbs 它会做的动作,作者自己起的名字(命令名 + README 小标题)。
       demo  作者自己录的那段演示 —— 调研说最受欢迎的一百个仓库里 62% 已经有了。
             ⚠ 存的是**地址不是画面**:抓取那一端会把它采成帧再放进 frames,
             远程地址不该在看的时候才去请求(封面当初就是为这个只收内联的)。 */
  out.flow = (capsule.flow && typeof capsule.flow === 'object') ? {
    kind: ['cli', 'service', 'app', 'lib'].indexOf(String(capsule.flow.kind)) >= 0
      ? String(capsule.flow.kind) : 'lib',
    entry: str(capsule.flow.entry, 40),
    cmds: Array.isArray(capsule.flow.cmds)
      ? capsule.flow.cmds.slice(0, 6).map((c) => str(c, 24)).filter(Boolean) : [],
  } : null;
  out.verbs = Array.isArray(capsule.verbs)
    ? capsule.verbs.slice(0, 6).map((v) => str(v, 24)).filter(Boolean) : [];

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
    /* ⚠ 新字段**必须在这里列一遍**,否则一进一出就被滤掉,而且不报错 —— 城市照样画,
       只是少了"有没有测试""几个人在管"这两层。这个仓库在 sanitize / toCapsule /
       _setCity 三处各吃过一次这个亏。 */
    /* ⚠ **没有就不写**,不能写 0。frac(undefined) 是 0,而 0 在城市里的意思是"查过了,
       没有测试"—— 画成一圈红。Mac 扫出来的城市根本没有这个字段,那样每一个项目都会
       被冤枉成没有测试。JSON.stringify 会丢掉 undefined,所以缺的字段真的就不存在。 */
    tests: (d && d.tests != null) ? frac(d.tests) : undefined,
    authors: (d && d.authors != null) ? num(d.authors, 0, 9999) : undefined,
    owner: (d && d.owner != null) ? frac(d.owner) : undefined,
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
  // 仓库级的几件事(星、fork、许可证、年纪、CI)。城市下面那几行字用。
  const m0 = capsule.meta;
  out.meta = (m0 && typeof m0 === 'object') ? {
    stars: num(m0.stars, 0, 99999999), forks: num(m0.forks, 0, 99999999),
    issues: num(m0.issues, 0, 9999999), license: str(m0.license, 24),
    age_days: num(m0.age_days, 0, 99999), ci: !!m0.ci,
  } : null;
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

  /* 标题以前是硬性的 —— 对项目是对的,对一条**纯文字**的帖子就不对了:那种帖子
     的全部内容就是那段话。所以文字帖用它自己的正文当标题,而一条什么都没有的
     胶囊仍然发不出去。 */
  if (!out.title && out.kind === 'text' && out.desc) out.title = out.desc.slice(0, 48);
  if (!out.title) return null;
  if (out.kind === 'text' && !out.desc && !out.subtitle) return null;
  if (out.kind === 'image' && !out.cover && !out.frames.length) return null;
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
  /* ⚠ 内容闸门。上面那道"每人 24 条"挡不住任何人:身份是客户端随便给的字符串,
     换一个就是一个新人 —— 实际被灌进来的一百条垃圾来自**九十九个身份**,一次都
     没碰到那道闸。所以真正管用的闸门只能建在**内容**和来源 IP 上,不能建在身份上。
     见 api/spam.js。 */
  const bad = spamReason(capsule);
  if (bad) return res.status(422).json({ error: 'That post looks like spam', reason: bad });

  /* 违法与不当内容。和灌水分开判,因为它是另一种性质的问题 —— 灌水是吵,
     这一类是不能出现在一面公开的墙上。 */
  const illegal = illegalReason(capsule);
  if (illegal) {
    console.warn('[plaza] blocked', illegal, '—', (capsule.title || '').slice(0, 40));
    return res.status(422).json({ error: 'That content is not allowed here', reason: illegal });
  }

  /* ── 查重 ────────────────────────────────────────────────────────────────
     ⚠ 灌水的下一招不是换身份,是**换个花样再来一遍**:把 `-113` 改成 `#114`,
     规则就认不出来了。所以判据是归一化之后的指纹(数字全抹平,见 spam.js),
     一小时之内出现过同一个指纹就拒。

     对真实的人几乎没有影响:同一个人一小时内发两条**一模一样**的东西,本来就是
     误触。改一版重发是允许的 —— 那走的是覆盖,不是新增。 */
  const fp = fingerprint(capsule);
  if (fp && fp.length >= 12) {
    const recent = db.recentWallProjects.all({ window: '-1 hours' });
    let same = 0;
    for (const r of recent) {
      let c = null;
      try { c = JSON.parse(r.capsule); } catch (e) { continue; }
      if (fingerprint(c) === fp) same++;
    }
    if (same >= 2) {
      return res.status(429).json({ error: 'That looks like something already posted', reason: 'duplicate' });
    }
  }

  /* ⚠ 这里本来还有一道"同一身份两条之间隔 30 秒"的冷却。**删掉了**,因为它
     惩罚的正好是无辜的那一方:

       · 换身份灌水的人根本碰不到它 —— 它是按身份算的,而那一百条来自九十九个
         身份,每个只发一两条;
       · 一个身份从一个地址连发,IP 那道闸(10 条/小时)本来就先拦住了;
       · 真正被它挡住的,是一个人接连发布两个项目 —— 实测第二条直接 429。

     一道只拦得住守规矩的人的闸,不是防御,是故障。 */
  /* 冲量刹车。上面每一道都是"按人"或"按内容"算的,而一次真正的攻击是**同时**从
     很多个身份、很多个地址进来 —— 每一条单看都合规。所以还要有一道看**整体**的:
     十分钟内整个广场进来的东西超过这个数,就先停下来。
     ⚠ 阈值要比任何正常时段都高得多:这不是限速,是保险丝。 */
  const surge = (db.wallPostsSince.get({ window: '-10 minutes' }) || {}).n || 0;
  if (surge >= 60) {
    console.warn('[plaza] surge brake:', surge, 'posts in 10 minutes');
    return res.status(503).json({ error: 'The plaza is busy right now — try again shortly', reason: 'surge' });
  }
  // id 由**内容**决定:同一个项目重复发布是覆盖,不是又长出一个。
  const id = serverId(me, capsule.srcId || capsule.title);
  db.upsertWallProject.run({ id, identity: me, title: capsule.title, capsule: json });
  res.json({ ok: true, id });
});

/* ── 给已经在墙上的项目补一层新数据 ─────────────────────────────────────
   探针后来学会了读"这个项目在干什么"(flow / verbs / 演示),可**已经发出去的
   胶囊里没有这些字段** —— `published:true` 只记得"发过一次",不会自己重发。实测
   线上一百颗胶囊里,带 flow 的是 0,带 verbs 的是 0。也就是说升级完全看不见,
   而这正是它看起来"什么都没变"的原因。

   ⚠ 为什么不能走上面那个公开的发布口:
     · 每个地址一小时十条,补一百条要十小时;
     · 十分钟六十条的保险丝会被自己的补数据触发;
     · upsert 会把 published_at 刷成 now,把这面特意排过顺序的墙搅乱。
   都是**正确**的闸门,只是它们防的是陌生人,而这是运维动作。

   所以单开一条口,拿环境变量里的密钥认。没设 PLAZA_ADMIN_TOKEN 就**根本不存在**
   这条路由 —— 一个默认关着的后门,比一个默认开着但"应该没人猜得到"的强。 */
const ADMIN_TOKEN = process.env.PLAZA_ADMIN_TOKEN || '';

router.post('/backfill', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'Not found' });
  const given = String(req.get('x-terse-admin') || '');
  /* 定长比较:密钥比对用 === 会在第一个不同的字节上返回,而那点时间差是可测的。 */
  const ok = given.length === ADMIN_TOKEN.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_TOKEN));
  if (!ok) return res.status(403).json({ error: 'Forbidden' });

  const updates = Array.isArray((req.body || {}).updates) ? req.body.updates.slice(0, 200) : [];
  if (!updates.length) return res.status(400).json({ error: 'No updates' });

  const done = [], failed = [];
  for (const u of updates) {
    const id = String((u && u.id) || '');
    if (!id) { failed.push({ id, why: 'no id' }); continue; }
    // ⚠ 照样 sanitize。这条口省掉的是限流和时间戳,不是"别人喂来的数据要夹一遍"
    // 那道闸 —— 胶囊最后仍然会被别人的机器拿去生成画面。
    const capsule = sanitize(u && u.capsule);
    if (!capsule) { failed.push({ id, why: 'bad capsule' }); continue; }
    const json = JSON.stringify(capsule);
    if (json.length > MAX_CAPSULE_BYTES) { failed.push({ id, why: 'too large' }); continue; }
    if (!db.wallProjectOwner.get(id)) { failed.push({ id, why: 'no such project' }); continue; }
    db.updateWallProjectCapsule.run({ id, title: capsule.title, capsule: json });
    done.push(id);
  }
  console.log('[plaza] backfill:', done.length, 'updated,', failed.length, 'failed');
  res.json({ ok: true, updated: done.length, failed });
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

  /* 被举报够多次的先不出现。⚠ 是**过滤**不是删除:举报会被滥用,留着才有第二次
     机会;而在被看过之前,它对刷广场的人来说已经不存在了。 */
  const hidden = new Set(
    db.reportedProjects.all({ threshold: REPORT_HIDE_AT }).map((r) => r.project_id));

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
    }).filter((p) => p.capsule && !hidden.has(p.id)),
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

/* ── 举报 ──────────────────────────────────────────────────────────────────
   规则永远认不全。这次那一百条是因为号码好认才认出来的 —— 下一次可能只是一段
   看着正常、其实在骗人的话,而**看的人认得出来**。所以留一条人来说话的路。

   ⚠ 一人一票:主键是 (帖子, 举报人),按十次也还是一票。
   ⚠ 到了阈值就**不再出现在列表里**,但不删 —— 举报会被滥用,而一条被误伤的帖子
      至少还在,能查、能恢复。删掉就没有第二次机会了。 */
const REPORT_HIDE_AT = 3;

// POST /api/cloud/projects/:id/report  Body: { reason? }
router.post('/:id/report', (req, res) => {
  const me = idHash(req);
  if (!me) return res.status(401).json({ error: 'Missing identity' });
  const reason = String((req.body || {}).reason || '').slice(0, 40);
  db.addWallReport.run({ project_id: req.params.id, identity: me, reason });
  const n = (db.countWallReports.get({ project_id: req.params.id }) || {}).n || 0;
  res.json({ ok: true, reports: n, hidden: n >= REPORT_HIDE_AT });
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
