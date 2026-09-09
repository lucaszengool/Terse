/**
 * 垃圾帖 · what gets blocked, and what must never be.
 *
 *   node api/spam.test.js
 *
 * Written after the plaza was flooded with a hundred contact-number ads. The
 * attacker described the hole in the posts themselves: the identity is just a
 * string the client sends, so "24 posts per identity" costs nothing to defeat —
 * the hundred posts came from NINETY-NINE identities, one or two each, and
 * never touched that limit once.
 *
 * The half of this file that matters most is the second half. A spam filter
 * that eats real posts is worse than no filter, because the person it silences
 * has no idea why and no way to appeal — so every real shape that lives in this
 * plaza is pinned here: star counts with commas, versioned titles, repo
 * descriptions full of numbers.
 */
const { spamReason, findSpam, illegalReason, fingerprint } = require('./spam');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n)));
const blocks = (n, cap) => ok(n + ' → blocked', !!spamReason(cap));
const allows = (n, cap) => {
  const r = spamReason(cap);
  ok(n + ' → allowed' + (r ? ` (BLOCKED as ${r})` : ''), !r);
};

console.log('\n── the flood that actually happened ──');
blocks('the real post, verbatim', {
  title: '教主牛逼QQ160319672-113',
  desc: '教主牛逼QQ160319672 | 第113号 教主光辉永照 由伪造身份注入(零鉴权零注册门禁零限流)',
});
blocks('same ad without the number suffix', { title: '教主牛逼QQ160319672', desc: '' });
blocks('only the boast, no number', { title: '统一天下', desc: '零鉴权零注册门禁零限流' });

console.log('\n── other contact ads ──');
blocks('a QQ number in the body', { title: '代做', desc: '联系 QQ: 800820820' });
blocks('a WeChat handle', { title: '接单', desc: '加V：abc_12345 长期有效' });
blocks('a mainland mobile number', { title: '找我', desc: '电话 13812345678' });
blocks('a telegram handle', { title: 'contact', desc: 'telegram: @somebody' });

console.log('\n── and everything real must survive ──');
allows('a repo post with a star count', {
  title: 'tach',
  desc: '先收藏了：A Python tool to enforce a modular architecture\n★ 2,807 · Rust · tach-org/tach\n#vibecoding #开源',
});
allows('one with a big number and a language', {
  title: 'LLamaSharp', desc: 'C#/.NET binding of llama.cpp\n★ 3,791 · C# · SciSharp/LLamaSharp',
});
allows('a code city', { title: 'terse-api', subtitle: 'Terse API', desc: '4000 files · html 95% · js 3%' });
allows('a versioned title', { title: 'my-app-2', desc: 'a small tool I built' });
allows('a year in the title', { title: 'retro-2024', desc: 'what I shipped this year' });
// 11 digits is a phone number; a token count is not.
allows('a token count', { title: '一个月的账单', desc: '三十天 4,000,000 token,两百块' });
allows('a version string', { title: 'parser', desc: 'now on v1.2.3, ~12000 downloads' });
allows('an issue reference', { title: 'oryx', desc: 'fixes #1234 and #5678, thanks everyone' });

console.log('\n── the sweep reads the same rules ──');
{
  const rows = [
    { id: 'a', capsule: JSON.stringify({ title: '教主牛逼QQ160319672-1', desc: 'x' }) },
    { id: 'b', capsule: JSON.stringify({ title: 'tach', desc: '★ 2,807 · Rust' }) },
    { id: 'c', capsule: 'not json at all' },
  ];
  const hits = findSpam(rows);
  ok('finds the spam row', hits.length === 1 && hits[0].id === 'a');
  ok('and reports why', hits[0] && !!hits[0].reason);
  ok('a row it cannot parse is left alone, not deleted', !hits.some((h) => h.id === 'c'));
}

console.log('\n── content that must not be here at all ──');
{
  const bans = (n, cap, want) => {
    const r = illegalReason(cap);
    ok(`${n} → ${want}` + (r === want ? '' : ` (got ${r})`), r === want);
  };
  bans('a drug sale', { title: '出售', desc: '冰毒 长期供货' }, 'drugs');
  bans('forged documents', { title: '办证', desc: '高仿证件 驾照代办' }, 'forgery');
  bans('a gambling agent', { title: '招代理', desc: '菠菜平台 包网 上分' }, 'gambling');
  bans('laundering', { title: 'x', desc: '跑分 四件套 银行卡出租' }, 'money-laundering');
  bans('stolen card data', { title: 'x', desc: 'fresh cc dumps and fullz' }, 'hacking-service');
  bans('a shortener hiding its target', { title: 'look', desc: 'https://bit.ly/abcd' }, 'link-hiding');
  bans('a shortener in the link field', { title: 'look', desc: '', link: 'https://t.cn/xyz' }, 'link-hiding');

  // ⚠ The words alone are not the offence — the trade is. A post ABOUT security
  // work, or a repo that scans for vulnerabilities, is exactly what belongs here.
  bans('a security scanner repo', { title: 'VulnClaw', desc: 'A vulnerability scanner for web applications' }, null);
  bans('a story about losing a database', { title: '它把我的数据库删了', desc: 'DELETE 没带 WHERE' }, null);
  bans('a post about spam filtering', { title: 'anti-spam', desc: 'blocks casino and gambling ads' }, null);
  bans('a normal repo link', { title: 'tach', desc: 'see it', link: 'https://github.com/tach-org/tach' }, null);
}

console.log('\n── the flood cannot just renumber itself ──');
{
  const a = fingerprint({ title: '教主牛逼QQ160319672-113', desc: '第113号 光辉永照' });
  const b = fingerprint({ title: '教主牛逼QQ160319672#114', desc: '第114号 光辉永照' });
  const c = fingerprint({ title: 'tach', desc: 'A Python tool ★ 2,807' });
  ok('two numbered variants share one fingerprint', a === b && a.length > 0);
  ok('a real post does not collide with them', c !== a);
  // Different projects must stay different, or dedupe becomes censorship.
  const d = fingerprint({ title: 'oryx', desc: 'A TUI for sniffing network traffic ★ 2,574' });
  ok('two different repos keep different fingerprints', c !== d);
}


/* ── ★ 开机扫的那一遍,必须问发布口问过的**每一道**规则 ──────────────────
   这两边曾经分了家,而且分得很安静:发布口问 spamReason **和** illegalReason,
   扫描只问 spamReason。于是新的违法内容发不进来,**已经在墙上的永远清不掉**。

   实测代价:一条"专业办证 高仿证件 驾照代办"在公开的墙上挂了一天多
   (2026-09-08 15:33 发布,2 次浏览),而同一条内容当时根本发不进来 ——
   规则认得它,只是没人拿这条规则去看老帖子。 */
{
  const row = (id, cap) => ({ id, capsule: JSON.stringify(cap) });

  const swept = findSpam([
    row('forge', { title: '专业办证 高仿证件 驾照代办', desc: '专业办证 高仿证件 驾照代办' }),
    row('ad', { title: '加微信 abc123 快速出款', desc: '加V:abc123' }),
  ]);
  ok('the sweep removes illegal content, not only flooding',
     swept.some((h) => h.id === 'forge' && h.reason === 'forgery'));
  ok('and it still removes contact ads', swept.some((h) => h.id === 'ad'));

  /* 误删比漏删更糟:被挡住的人既看不到原因,也没处申诉。这三条必须活下来。 */
  const real = findSpam([
    row('scanner', { title: 'vulnerability scanner', desc: 'finds security holes in your dependencies' }),
    row('story', { title: 'how I lost my database', desc: 'a postmortem about deleting prod' }),
    row('casino', { title: 'adblock rules', desc: 'a list that blocks casino and gambling ads' }),
  ]);
  ok('a real project is never swept' + (real.length ? ` (caught: ${real.map((h) => h.id)})` : ''),
     real.length === 0);

  /* 真正的保险:规则写成一张表,扫描遍历它。以后再加一道闸只要加进数组,
     两边自动一致 —— 不靠谁记得改两个地方。 */
  const src = fs.readFileSync(path.join(__dirname, 'spam.js'), 'utf8');
  ok('the sweep iterates a rule list rather than naming one rule',
     /const WALL_RULES = \[spamReason, illegalReason\]/.test(src)
     && /for \(const rule of WALL_RULES\)/.test(src));

  const proj = fs.readFileSync(path.join(__dirname, 'projects.js'), 'utf8');
  ok('the publish route still checks both rules too',
     /spamReason\(capsule\)/.test(proj) && /illegalReason\(capsule\)/.test(proj));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
