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
const { spamReason, findSpam } = require('./spam');

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
