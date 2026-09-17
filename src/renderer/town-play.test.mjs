/**
 * town-play.mjs —— 小镇里能玩的规则(纯函数那一半)。
 *
 *   node src/renderer/town-play.test.mjs
 *
 * 钉住的是:同样的输入永远同样的结果(服务端靠它验账);告示永远三件、三档、做得成;
 * 谜题的线索不剧透;钓鱼看时间、天气、身边的语言;等级单调;节日只在周末。
 */
import {
  dailyQuests, questMatches, riddleOf, riddleShare, castResult, bugsAvailable, BUGS, stampsFor,
  scrollsOf, hotFileOf, busyOf, festivalOn, levelOf, treeStage, dayIndex, weekIndex, REWARD, CAPS, COST, TITLES,
} from './town-play.mjs';
import { projectFacts, personaOf } from './town-folk.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const LANGS = ['Rust', 'Python', 'TypeScript', 'Go', 'JavaScript', 'Java', 'Swift', 'C++'];
const STYLES = ['tang', 'edo', 'giza', 'hellas', 'maya', 'persia', 'norse', 'modern'];
const WORDS = ['Anvil', 'Bramble', 'Cinder', 'Drift', 'Echo', 'Fable', 'Gossamer', 'Hollow', 'Ivory', 'Jasper', 'Kestrel', 'Lumen'];
function town(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = 'wp_' + (i * 7919).toString(36).padStart(6, '0');
    const title = WORDS[i % WORDS.length] + (i >= WORDS.length ? ' ' + i : '');
    const capsule = {
      title, subtitle: 'Home of ' + title,
      langs: [[LANGS[i % LANGS.length], 1]],
      dirs: [{ name: title.toLowerCase().split(' ')[0], files: 5 + i, bytes: 10000 * (i + 1) }, { name: 'docs', files: 2, bytes: 3000 }, { name: 'src', files: 9, bytes: 9000 }],
      hot: i % 3 ? [{ name: title.toLowerCase().split(' ')[0] + '.rs', churn: 50 }, { name: 'main.rs', churn: 20 }] : [{ name: 'core_' + i + '.py', churn: 9 }],
      commits: Array.from({ length: 371 }, (_, k) => (i % 2 && k > 365 ? 3 : 0)),
      people: [['a', 1], ['b', 2]].slice(0, 1 + (i % 2)),
      style: STYLES[i % STYLES.length],
    };
    const facts = projectFacts(id, capsule);
    out.push({
      id, facts, capsule,
      house: { id, lang: facts.lang, style: capsule.style, trade: personaOf(id, facts).trade, busy: busyOf(capsule), hot: hotFileOf(capsule) },
    });
  }
  return out;
}
const T = town(24);
const houses = T.map((t) => t.house);
const DAY0 = dayIndex(Date.UTC(2026, 8, 17));

/* ── 告示 ── */
{
  ok('quests are deterministic', JSON.stringify(dailyQuests(DAY0, { houses })) === JSON.stringify(dailyQuests(DAY0, { houses })));
  let kinds = new Set(), bad = 0;
  for (let d = DAY0; d < DAY0 + 200; d++) {
    const qs = dailyQuests(d, { houses });
    if (qs.length !== 3 || qs.map((q) => q.tier).join() !== '0,1,2') bad++;
    for (const q of qs) {
      kinds.add(q.kind);
      if (q.reward !== REWARD.quest[q.tier] || !(q.n >= 1) || !q.text.en || !q.text.zh) bad++;
      if (new Set(qs.map((x) => x.id)).size !== 3) bad++;
      // 做得成:目标在镇上真的存在
      if (q.kind === 'visit_lang' && houses.filter((h) => h.lang === q.target).length < q.n) bad++;
      if (q.kind === 'visit_style' && !houses.some((h) => h.style === q.target)) bad++;
      if (q.kind === 'visit_busy' && !houses.some((h) => h.busy)) bad++;
      if (q.kind === 'talk_trade' && !houses.some((h) => h.trade === q.target)) bad++;
      if (q.kind === 'water') bad++;       // 只浇水的差事不该出现
    }
  }
  ok('always three quests, tiers 0/1/2, achievable', bad === 0);
  ok(`quest kinds vary (${kinds.size})`, kinds.size >= 8);
  const empty = dailyQuests(DAY0, { houses: [] });
  ok('an empty town still gets three doable quests', empty.length === 3 && empty.every((q) => !/^visit_|talk_/.test(q.kind)));
  const lone = dailyQuests(DAY0, null);
  ok('no town → still three', lone.length === 3);
  ok('questMatches: visit_lang', questMatches({ kind: 'visit_lang', target: 'rust' }, { type: 'visit', lang: 'rust' })
    && !questMatches({ kind: 'visit_lang', target: 'rust' }, { type: 'visit', lang: 'go' })
    && !questMatches({ kind: 'visit_lang', target: 'rust' }, { type: 'talk', lang: 'rust' }));
  ok('questMatches: plant accepts water', questMatches({ kind: 'plant' }, { type: 'water' }) && questMatches({ kind: 'plant' }, { type: 'plant' }));
  ok('questMatches: junk is false', !questMatches(null, { type: 'visit' }) && !questMatches({ kind: 'nope' }, { type: 'visit' }));
}

/* ── 谜题 ── */
{
  const input = T.map((t) => ({ id: t.id, facts: t.facts, extra: { hot: t.house.hot, people: t.capsule.people.length } }));
  ok('riddle is deterministic', JSON.stringify(riddleOf(DAY0, input)) === JSON.stringify(riddleOf(DAY0, input.slice().reverse())));
  let leaks = 0, idLeaks = 0, answers = new Set(), few = 0;
  for (let d = DAY0; d < DAY0 + 120; d++) {
    const R = riddleOf(d, input);
    answers.add(R.answer);
    const title = R.title.toLowerCase();
    R.clues.forEach((c, i) => {
      const s = (c.en + ' ' + c.zh).toLowerCase();
      if (s.includes(R.answer.toLowerCase())) idLeaks++;
      if (s.includes(title) && !(c.k === 'subtitle' && i === R.clues.length - 1)) leaks++;
    });
    if (R.clues.length < 3 || R.clues.length > 7 || R.max !== 6) few++;
    if (R.clues.some((c, i) => c.k === 'subtitle' && i !== R.clues.length - 1)) leaks++;
  }
  ok('riddle clues never name the house (except the last sign)', leaks === 0);
  ok('riddle clues never contain the answer id', idLeaks === 0);
  ok('riddle has 3..7 clues and six guesses', few === 0);
  ok(`riddle answer rotates (${answers.size} houses in 120 days)`, answers.size >= 10);
  ok('riddle: nothing to guess → null', riddleOf(DAY0, []) === null && riddleOf(DAY0, null) === null);
  const s = riddleShare(123, 3, true, 'en');
  ok('share: solved in 3', s.includes('3/6') && s.includes('🟥🟥🟩⬜⬜⬜'));
  const f = riddleShare(123, 6, false, 'zh');
  ok('share: failed', f.includes('X/6') && f.includes('🟥🟥🟥🟥🟥🟥') && f.includes('谜题'));
  ok('share: first try', riddleShare(1, 1, true).includes('🟩⬜⬜⬜⬜⬜'));
}

/* ── 钓 bug ── */
{
  const a = castResult('u|1|0', 'moat', 12, 'clear', ['rust']);
  const b = castResult('u|1|0', 'moat', 12, 'clear', ['rust']);
  ok('cast is deterministic', a.bug.id === b.bug.id && a.len === b.len && a.bite === b.bite);
  ok('cast len within range', a.len >= a.bug.len[0] && a.len <= a.bug.len[1] && a.bite >= 1.6 && a.bite <= 5.8 && a.window >= 0.35);
  let empty = 0, wrong = 0;
  for (const where of ['moat', 'stream']) for (let h = 0; h <= 24; h += 0.5) for (const w of ['clear', 'rain', 'storm', 'fog', 'snow', 'wind']) {
    const pool = bugsAvailable(where, h, w, []);
    if (!pool.length) empty++;
    for (let i = 0; i < 6; i++) {
      const r = castResult(`s|${where}|${h}|${w}|${i}`, where, h, w, []);
      if (!pool.includes(r.bug)) wrong++;
      if (r.bug.lang) wrong++;                                  // 身边没有语言:不会有语言虫
      if (r.bug.where !== 'any' && r.bug.where !== where) wrong++;
    }
  }
  ok('bugsAvailable never empty', empty === 0);
  ok('casts respect water, pool and langs', wrong === 0);
  const day = bugsAvailable('any', 12, 'clear', []).map((x) => x.id);
  const night = bugsAvailable('any', 23, 'clear', []).map((x) => x.id);
  ok('heisenbug only at night', !day.includes('heisenbug') && night.includes('heisenbug'));
  ok('segfault shark only in storms, in the moat', bugsAvailable('moat', 12, 'storm', []).some((x) => x.id === 'segfault')
    && !bugsAvailable('moat', 12, 'clear', []).some((x) => x.id === 'segfault')
    && !bugsAvailable('stream', 12, 'storm', []).some((x) => x.id === 'segfault'));
  ok('storm counts as rain', bugsAvailable('moat', 12, 'storm', []).some((x) => x.id === 'leak'));
  ok('language bugs need a nearby house', bugsAvailable('moat', 12, 'clear', ['Rust']).some((x) => x.id === 'borrow')
    && !bugsAvailable('moat', 12, 'clear', ['go']).some((x) => x.id === 'borrow')
    && bugsAvailable('moat', 12, 'clear', ['TypeScript', 'javascript']).filter((x) => x.lang).length === 2);
  ok('dawn bugs at dawn', bugsAvailable('stream', 5, 'clear', []).some((x) => x.id === 'y2k') && !bugsAvailable('stream', 12, 'clear', []).some((x) => x.id === 'y2k'));
  const seen = new Set();
  for (let i = 0; i < 3000; i++) seen.add(castResult('r' + i, 'moat', 23, 'storm', ['rust', 'c++', 'go']).bug.id);
  ok(`many species show up (${seen.size})`, seen.size >= 10);
  ok('every bug has a positive fish reward within 2..10', BUGS.every((x) => REWARD.fish(x) >= 2 && REWARD.fish(x) <= 10));
  ok('bug ids are unique', new Set(BUGS.map((x) => x.id)).size === BUGS.length);
}

/* ── 护照、卷轴、胶囊小工具 ── */
{
  ok('stamps: lang + style', JSON.stringify(stampsFor({ lang: 'Rust', style: 'edo' })) === '["lang:rust","style:edo"]');
  ok('stamps: nothing', stampsFor(null).length === 0 && stampsFor({}).length === 0);
  const s1 = scrollsOf(DAY0, houses), s2 = scrollsOf(DAY0, houses.slice().reverse());
  ok('scrolls are stable regardless of order', JSON.stringify(s1) === JSON.stringify(s2));
  ok('scrolls: at most 8, only houses with a hot file, unique', s1.length === 8 && s1.every((s) => houses.find((h) => h.id === s.villa).hot === s.file)
    && new Set(s1.map((s) => s.id)).size === s1.length);
  ok('scrolls change day to day', JSON.stringify(scrollsOf(DAY0 + 1, houses).map((s) => s.villa)) !== JSON.stringify(s1.map((s) => s.villa)));
  ok('scroll ids carry the day', s1.every((s) => s.id === DAY0 + ':' + s.villa));
  ok('hotFileOf picks the most churned', hotFileOf({ hot: [{ name: 'a', churn: 1 }, { name: 'b', churn: 9 }] }) === 'b' && hotFileOf({}) === '' && hotFileOf(null) === '');
  ok('busyOf looks at the last two weeks', busyOf({ commits: [...Array(357).fill(0), ...Array(14).fill(1)] })
    && !busyOf({ commits: [...Array(14).fill(9), ...Array(357).fill(0)] }) && !busyOf(null));
}

/* ── 等级、树、节日 ── */
{
  let mono = true, prev = 0;
  for (let xp = 0; xp < 12000; xp += 7) { const l = levelOf(xp).level; if (l < prev) mono = false; prev = l; }
  ok('levelOf is monotonic', mono);
  ok('levelOf ends at BDFL', levelOf(1e9).level === TITLES.length && levelOf(1e9).next === null && levelOf(-5).level === 1);
  ok('levelOf progress', levelOf(100).into === 40 && levelOf(100).need === 120);
  ok('treeStage 0..4', treeStage(0) === 0 && treeStage(1) === 0 && treeStage(2) === 1 && treeStage(8) === 4 && treeStage(99) === 4 && treeStage(-3) === 0);
  let weekend = 0, weekday = 0, perks = new Set();
  for (let d = DAY0; d < DAY0 + 70; d++) {
    const t = d * 86400000 + 5e6;
    const f = festivalOn(t);
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) { if (f && f.perk && f.lang) { weekend++; perks.add(f.perk); } }
    else if (f) weekday++;
  }
  ok('festivals only on weekends', weekday === 0 && weekend === 20);
  ok('all four festivals come round', perks.size === 4);
  const sat = Date.UTC(2026, 8, 19, 12), sun = Date.UTC(2026, 8, 20, 12);
  ok('saturday and sunday share a festival', JSON.stringify(festivalOn(sat)) === JSON.stringify(festivalOn(sun)) && weekIndex(sat) === weekIndex(sun));
  ok('weeks start on monday', weekIndex(Date.UTC(2026, 8, 21)) === weekIndex(sun) + 1);
  ok('caps and costs are sane', CAPS.perDay > 0 && CAPS.fish < CAPS.perDay && COST.tree > 0 && Object.keys(COST.decor).length === 4);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
