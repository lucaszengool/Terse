/**
 * clientlog.js — 让手机自己说它到底怎么了。挂在 /api/cloud/clientlog。
 *
 * **为什么需要这个东西。** 「点项目什么都不显示」查了四轮,每一轮我都是在**桌面浏览器**
 * 里验证的,每一轮都通过,然后在真机上照样是黑的。原因每次都不一样(数据是旧的、
 * 画布量错了、被别的东西盖住了、iOS 不给第二个 WebGL context),但有一个共同点:
 * **全都不报错**。我还亲手在 `showProject` 外面套了个 `catch (e) {}`,把仅有的那点
 * 线索也咽掉了。
 *
 * 靠"你再试试看"是问不出来的 —— 那是让用户替我做调试。这个端点让那台真机自己把
 * 它量到的尺寸、有没有城市、报了什么错发回来,一次就够。
 *
 * **只留在内存里,只留最近 50 条。** 这不是日志系统,是一根临时的探针:落库就得考虑
 * 保留期、清理和它算不算用户数据,而它根本不值得那些。进程重启就没了,正是想要的。
 *
 * **不收内容**:只收尺寸、布尔量、计数和错误文本 —— 不收胶囊、不收标题、不收身份。
 * 身份哈希在这里没有任何用处,而一旦收了,这根探针就变成了一份要负责任的东西。
 */
const express = require('express');

const router = express.Router();

const MAX = 50;
const MAX_BYTES = 4 * 1024;
const ring = [];

/** 只留认识的字段,并且逐个夹长度。发过来的东西是别人机器上的字符串。 */
function clean(body) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const b = (v) => (typeof v === 'boolean' ? v : null);
  const o = body || {};
  return {
    at: new Date().toISOString(),
    tag: str(o.tag, 40),
    // 出错时最要紧的一行。
    err: str(o.err, 400),
    // 它量到了什么 —— 布局的每一个决定都从这两个数来。
    W: num(o.W), H: num(o.H),
    dpr: num(o.dpr),
    narrow: b(o.narrow),
    // 这颗胶囊里到底有没有城市。
    dirs: num(o.dirs), commits: num(o.commits), graph: num(o.graph),
    imgs: num(o.imgs),
    // 引擎活着没有,画了没有。
    engine: b(o.engine), started: b(o.started), vis: num(o.vis),
    ok: b(o.ok),
    gl: str(o.gl, 120),
    scene: str(o.scene, 700),
    console: str(o.console, 900),
    ua: str(o.ua, 200),
    build: str(o.build, 40),
  };
}

// POST /api/cloud/clientlog — 一次一条。故意不要求身份:这根探针要在**登录之前**
// 也能说话,而它收的东西里没有任何跟人有关的部分。
router.post('/', (req, res) => {
  if (JSON.stringify(req.body || {}).length > MAX_BYTES) {
    return res.status(413).json({ error: 'Too big' });
  }
  ring.push(clean(req.body));
  while (ring.length > MAX) ring.shift();
  res.json({ ok: true });
});

// GET /api/cloud/clientlog — 最近的在最前面。
router.get('/', (req, res) => {
  res.json({ ok: true, entries: ring.slice().reverse() });
});

module.exports = router;
