/**
 * town-pet-look.mjs —— agent 小伙伴的长相。
 *
 *   node src/renderer/town-pet-look.test.mjs
 *
 * 钉住的是"不用同步也对得上"这一条:同一个身份在哪台机器上都是同一只;不同的人分得开;
 * 奇怪的身份(空、数字、很长)也给出一只像样的,不抛错。
 */
import { BREEDS, COATS, NAMES, AGENT_COLOURS, hashId, petLook } from './town-pet-look.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

// 同一个身份 → 同一只(这是整个"不同步外观"的前提)
const a1 = petLook('user_2abcDEF'), a2 = petLook('user_2abcDEF');
ok('同一个身份两次算出同一只', JSON.stringify(a1) === JSON.stringify(a2));
ok('哈希是 32 位无符号整数', Number.isInteger(hashId('x')) && hashId('x') >= 0 && hashId('x') < 2 ** 32);
// 钉住具体值:哪天有人"优化"了哈希,所有人的狗会一夜之间全换掉
ok('哈希值不许悄悄变(FNV-1a)', hashId('terse') === 0xe8893d44);
const fixed = petLook('user-bob');
ok('user-bob 永远是金色的狗 Mochi', fixed.breed === 'dog' && fixed.name === 'Mochi' && fixed.coat.join() === '0.86,0.66,0.36');

// 一千个人:四种身子都有、毛色和名字铺得开,不会大家都长一个样
const ids = Array.from({ length: 1000 }, (_, i) => 'user_' + i.toString(36) + '_' + (i * 7919));
const looks = ids.map(petLook);
const count = (k) => { const m = new Map(); for (const l of looks) { const v = JSON.stringify(l[k]); m.set(v, (m.get(v) || 0) + 1); } return m; };
const br = count('breed'), co = count('coat'), nm = count('name');
ok('四种身子都出现', br.size === BREEDS.length);
ok('没有哪种身子超过四成', Math.max(...br.values()) < 400);
ok('毛色全用上了', co.size === COATS.length);
ok('名字至少用上 20 个', nm.size >= 20);
const combos = new Set(looks.map((l) => l.breed + '|' + l.coat.join() + '|' + l.name));
ok('一千个人里至少 600 种不同的样子', combos.size >= 600);

// 奇怪的身份
for (const id of ['', null, undefined, 0, 12345, 'x'.repeat(5000), '中文身份🐕']) {
  let l = null, err = null;
  try { l = petLook(id); } catch (e) { err = e; }
  ok('身份 ' + JSON.stringify(typeof id === 'string' && id.length > 20 ? id.slice(0, 8) + '…' : id) + ' 给出一只像样的',
    !err && BREEDS.includes(l.breed) && NAMES.includes(l.name) && l.seed >= 0 && l.seed < 1);
}

// 每种 agent 都有颜色,颜色在 0..1
ok('没接 agent 也有颜色', Array.isArray(AGENT_COLOURS.none));
ok('agent 颜色都在 0..1', Object.values(AGENT_COLOURS).every((c) => c.length === 3 && c.every((v) => v >= 0 && v <= 1)));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
