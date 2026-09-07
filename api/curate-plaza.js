#!/usr/bin/env node
/**
 * curate-plaza.js — 把广场收拾一遍:留下五十座城市,每一座配一段**不重样**的音乐。
 *
 *   node api/curate-plaza.js                                  本地
 *   node api/curate-plaza.js --remote https://www.terseai.org  线上
 *
 * 为什么要删掉一半:一百座城市里,好看的和平庸的混在一起,而人是**刷**过去的 ——
 * 第一屏平庸,他就不会刷到第八十条那座好的。所以留下的是"看起来最不一样的"
 * 五十座,不是"最新的"五十座。
 *
 * 挑选的办法是**按风格分组轮着取**:八种建筑风格,每种里按楼的数量从多到少排,
 * 一轮一轮地拿。于是留下来的五十座在八种风格上是均匀的,而且每种里都既有高密度
 * 的大城也有小镇 —— 随便截一段来刷,连着两条长得像的概率很低。
 * 直接按"楼最多"排前五十的话,留下的会是五十座一样密的城。
 *
 * 音乐:12 首 × 12 个调 = 144 种组合,五十座各取一种,**互不重复**。
 */
const crypto = require('crypto');

const REMOTE = (() => {
  const i = process.argv.indexOf('--remote');
  return i > 0 ? process.argv[i + 1] : null;
})();
const KEEP = 50;

const TUNES = ['pulse', 'drift', 'arp', 'neon', 'lofi', 'rush',
               'glass', 'deep', 'chime', 'dust', 'march', 'bloom'];

/** 按风格分组,组内按规模降序,然后一轮一轮地取 —— 见文件顶部。 */
function chooseKeepers(cities, keep) {
  const byStyle = new Map();
  for (const c of cities) {
    const k = (c.capsule.style || 'modern');
    if (!byStyle.has(k)) byStyle.set(k, []);
    byStyle.get(k).push(c);
  }
  for (const list of byStyle.values()) {
    list.sort((a, b) => (b.capsule.dirs || []).length - (a.capsule.dirs || []).length);
  }
  const groups = [...byStyle.values()];
  const out = [];
  for (let round = 0; out.length < keep; round++) {
    let took = 0;
    for (const g of groups) {
      if (out.length >= keep) break;
      if (g[round]) { out.push(g[round]); took++; }
    }
    if (!took) break;                       // 取完了
  }
  return out;
}

/** 第 i 座城市的配乐。曲子先走一遍,调号每绕一圈进一格 —— 于是相邻的两条
 *  一定是不同的曲子,而绕回同一首时调号已经变了。 */
function musicFor(i) {
  return { tune: TUNES[i % TUNES.length], key: (Math.floor(i / TUNES.length) * 5 + i) % 12 };
}

async function main() {
  const base = REMOTE ? REMOTE.replace(/\/$/, '') : null;
  let rows;
  if (base) {
    /* ⚠ 一次最多只给 100 条,而广场上现在有 150。剩下的那 50 座城市**根本没出现
       在列表里**,于是第一次跑的时候脚本以为只有 50 座、一座都不用删。

       没有分页接口,但有搜索:`q` 是在 400 行里筛完再截断的,所以按语言逐个搜
       一遍再合并,就能把整个广场捞全。语言是每颗胶囊都有的标签,而且十六种语言
       把它们分得足够散,每一份都远小于 100。 */
    const LANGS = ['ts', 'rust', 'python', 'go', 'swift', 'js', 'c++', 'java',
                   'kotlin', 'ruby', 'php', 'c#', 'html', 'sql', 'shell', 'c'];
    const seen = new Map();
    for (const q of [''].concat(LANGS)) {
      const r = await fetch(base + '/api/cloud/projects/public?limit=100'
                            + (q ? '&q=' + encodeURIComponent(q) : ''));
      for (const p of ((await r.json()).projects || [])) if (!seen.has(p.id)) seen.set(p.id, p);
      await new Promise((res) => setTimeout(res, 120));
    }
    rows = [...seen.values()];
  } else {
    const db = require('./db');
    rows = db.listWallProjects.all({ limit: 400 }).map((r) => {
      let capsule = null;
      try { capsule = JSON.parse(r.capsule); } catch (e) {}
      return { id: r.id, identity: r.identity, title: r.title, capsule };
    }).filter((r) => r.capsule);
  }

  // 只动**代码城市**。文字帖和图片帖是另一批东西,不参与这次挑选。
  const cities = rows.filter((r) => (r.capsule.kind || 'project') === 'project' && (r.capsule.dirs || []).length);
  const others = rows.length - cities.length;
  console.log('found', cities.length, 'cities and', others, 'other posts');

  const keepers = chooseKeepers(cities, KEEP);
  const keepIds = new Set(keepers.map((c) => c.id));
  const drop = cities.filter((c) => !keepIds.has(c.id));

  const styles = keepers.reduce((a, c) => { a[c.capsule.style || '?'] = (a[c.capsule.style || '?'] || 0) + 1; return a; }, {});
  console.log('keeping', keepers.length, 'across styles', JSON.stringify(styles));
  console.log('dropping', drop.length);

  if (!base) {
    const db = require('./db');
    for (const c of drop) db.deleteWallProject.run({ id: c.id, identity: c.identity });
    keepers.forEach((c, i) => {
      const m = musicFor(i);
      const cap = Object.assign({}, c.capsule, m);
      db.upsertWallProject.run({ id: c.id, identity: c.identity, title: c.title, capsule: JSON.stringify(cap) });
    });
    const combos = new Set(keepers.map((_, i) => { const m = musicFor(i); return m.tune + ':' + m.key; }));
    console.log('re-scored', keepers.length, 'with', combos.size, 'distinct tune+key combinations');
    return;
  }

  /* ⚠ 线上删除要带**发布者本人**的身份,而种子数据是分给六个身份发的
     (seed-projects.js:`'terse-seed-' + (i % 6)`,为了绕开每人 24 个的上限,
     也为了广场看起来像不止一个人在发)。所以身份要从胶囊自己的 id 反推出来:
     `seed-37` → 37 % 6 → terse-seed-1。猜错了服务端只会拒绝,不会删错人的东西,
     但那样这次整理就白跑了。

     ⚠ 而且**只碰种子**。用户自己从 Mac 发布的项目也在这个列表里,它不该被这个
     脚本挑挑拣拣 —— srcId 对不上 `seed-<数字>` 的一律跳过。 */
  /* ⚠ 线上那批城市的 srcId 是**空的**。种子脚本在胶囊里写的是 `srcId`,而
     sanitize() 读的是 `capsule.id` —— 两个名字,于是那个字段一路空着存了进去,
     服务端只好拿**标题**当主键(`serverId(me, srcId || title)`)。所以这里要用
     标题去删,不是用 id。

     身份也一样推不出来:它是发布时的下标 % 6,而下标早就没了。六个挨个试 ——
     身份不对服务端只会当没找到,删不掉别人的东西,代价只是多几次请求。 */
  const pace = () => new Promise((r) => setTimeout(r, 120));
  const IDENTS = [0, 1, 2, 3, 4, 5].map((n) => 'terse-seed-' + n);
  const keyOf = (c) => (c.capsule.srcId || c.capsule.title || '');
  /* ⚠⚠ DELETE **永远返回 200**,不管有没有删到东西(projects.js:它只是 run 一句
     SQL 然后 res.json({ok:true}))。所以"挨个身份试,成功就 break"是错的 ——
     第一个身份必然"成功",于是只有 terse-seed-0 名下的那些真的被删掉了,其余
     九十多条原封不动。我上一轮就是这么把广场从 100 座弄成 123 座的:删得不干净,
     又用轮换的身份重发了 50 条,于是多出一批同名的副本。

     没有"删掉了没有"这个信号,就**不要依赖它**:六个身份全试一遍,一个都不 break,
     然后**重新拉一次列表数数**。响应说了什么不算数,列表里还剩几条才算数。 */
  const fetchAll = async () => {
    const LANGS = ['ts', 'rust', 'python', 'go', 'swift', 'js', 'c++', 'java',
                   'kotlin', 'ruby', 'php', 'c#', 'html', 'sql', 'shell', 'c'];
    const seen = new Map();
    for (const q of [''].concat(LANGS)) {
      const r = await fetch(base + '/api/cloud/projects/public?limit=100'
                            + (q ? '&q=' + encodeURIComponent(q) : ''));
      for (const p of ((await r.json()).projects || [])) if (!seen.has(p.id)) seen.set(p.id, p);
      await pace();
    }
    return [...seen.values()];
  };

  const titles = new Set(cities.map(keyOf));
  console.log('deleting', titles.size, 'distinct titles under all', IDENTS.length, 'identities…');
  for (const key of titles) {
    for (const who of IDENTS) {
      await fetch(base + '/api/cloud/projects/' + encodeURIComponent(key), {
        method: 'DELETE', headers: { 'x-terse-identity': who },
      });
      await pace();
    }
  }

  const mid = await fetchAll();
  const leftCities = mid.filter((r) => (r.capsule.kind || 'project') === 'project' && (r.capsule.dirs || []).length);
  console.log('after deleting:', leftCities.length, 'cities and', mid.length - leftCities.length, 'other posts');

  // 一个身份最多 24 个,所以五十座分给六个身份。
  let scored = 0;
  for (let i = 0; i < keepers.length; i++) {
    const c = keepers[i];
    const cap = Object.assign({}, c.capsule, musicFor(i));
    cap.id = keyOf(c);
    const res = await fetch(base + '/api/cloud/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-terse-identity': IDENTS[i % IDENTS.length] },
      body: JSON.stringify({ capsule: cap }),
    });
    await pace();
    if (res.ok) scored++;
  }

  const after = await fetchAll();
  const finalCities = after.filter((r) => (r.capsule.kind || 'project') === 'project' && (r.capsule.dirs || []).length);
  const combos = new Set(after.filter((r) => r.capsule.tune).map((r) => r.capsule.tune + ':' + (r.capsule.key || 0)));
  console.log('FINAL:', after.length, 'posts —', finalCities.length, 'cities,',
              after.length - finalCities.length, 'other,', combos.size, 'distinct tune+key');
}

main().catch((e) => { console.error(e); process.exit(1); });
