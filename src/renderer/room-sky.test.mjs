/**
 * room-sky.js —— 外面是什么天(纯函数那一半)。
 *
 *   node src/renderer/room-sky.test.mjs
 */
import { envAt, sunPosition, seasonOf, weatherOf, realSeason, skyColours, placeGuess, moonPhase, WEATHERS, SEASONS, envLabel } from './room-sky.js';

let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fails.push(name); console.log('  ✗ ' + name); } };

const SH = { lat: 31, lon: 121 };                        // 上海
const at = (iso) => new Date(iso);

/* ── 太阳 ── */
{
  const noon = sunPosition(at('2026-06-21T04:00:00Z'), SH.lat, SH.lon).alt * 180 / Math.PI;       // 上海正午
  const midnight = sunPosition(at('2026-06-21T16:00:00Z'), SH.lat, SH.lon).alt * 180 / Math.PI;
  ok(`summer noon in Shanghai: the sun is high (${noon.toFixed(1)}°)`, noon > 75 && noon < 90);
  ok(`midnight: the sun is below the horizon (${midnight.toFixed(1)}°)`, midnight < -20);
  const win = sunPosition(at('2026-12-21T04:00:00Z'), SH.lat, SH.lon).alt * 180 / Math.PI;
  ok(`winter noon is lower than summer noon (${win.toFixed(1)}°)`, win < noon - 30 && win > 25);
}

/* ── 季节、天气:随机,但是同一天同一时段是同一种 ── */
{
  const d = at('2026-09-16T10:00:00+08:00');
  ok('the real season follows the hemisphere', realSeason(d, 31) === 'autumn' && realSeason(d, -34) === 'spring');
  ok('a season is one of four', SEASONS.includes(seasonOf(d, 31)));
  ok('the same week is the same season', seasonOf(d, 31, 's') === seasonOf(at('2026-09-17T10:00:00+08:00'), 31, 's'));
  const a = weatherOf(d, 'autumn', 'x'), b = weatherOf(d, 'autumn', 'x');
  ok('the same day and slot is the same weather', a.weather === b.weather && WEATHERS.includes(a.weather));
  // 七成真实:一年 52 周里真实季节占大多数
  let real = 0;
  for (let w = 0; w < 52; w++) { const x = new Date(2026, 0, 1 + w * 7, 12); if (seasonOf(x, 31, 'k') === realSeason(x, 31)) real++; }
  ok(`most weeks are the real season (${real}/52)`, real >= 28 && real < 52);
  // 天是走过去的:晴不会下一格就是雷暴
  let jumps = 0, snowInSummer = 0, kinds = new Set();
  for (let day = 1; day <= 200; day++) {
    for (let h = 0; h < 24; h += 3) {
      const x = new Date(2026, 0, day, h + 1);
      const s = SEASONS[day % 4], w = weatherOf(x, s, 'walk');
      kinds.add(w.weather);
      if (w.prev === 'clear' && w.weather === 'storm') jumps++;
      if (s === 'summer' && w.weather === 'snow') snowInSummer++;
    }
  }
  ok('clear never turns straight into a storm', jumps === 0);
  ok('no snow in summer', snowInSummer === 0);
  ok(`many kinds of weather show up (${[...kinds].join(',')})`, kinds.size >= 6);
}

/* ── 此刻的天 ── */
{
  const base = at('2026-09-16T12:00:00+08:00');
  const noon = envAt(base, Object.assign({ hour: 12.5, weather: 'clear' }, SH));
  const night = envAt(base, Object.assign({ hour: 23, weather: 'clear' }, SH));
  const dusk = envAt(base, Object.assign({ hour: 18.1, weather: 'clear' }, SH));
  ok('noon is day, midnight is night', noon.night < 0.05 && night.night > 0.95);
  ok(`dusk is in between and golden (night ${dusk.night.toFixed(2)}, golden ${dusk.golden.toFixed(2)}, ${dusk.phase})`, dusk.golden > 0.2 || (dusk.night > 0.05 && dusk.night < 0.95));
  ok('a clear noon sky is blue: blue channel beats red at the zenith', noon.zen[2] > noon.zen[0] + 0.3);
  const oc = envAt(base, Object.assign({ hour: 12.5, weather: 'overcast' }, SH));
  const sat = (c) => Math.max(...c) - Math.min(...c);
  ok('overcast pulls the sky towards grey', sat(oc.zen) < sat(noon.zen));
  ok('overrides win: weather and season', envAt(base, Object.assign({ weather: 'snow', season: 'winter' }, SH)).weather === 'snow'
     && envAt(base, Object.assign({ season: 'spring' }, SH)).season === 'spring');
  ok('snow snows, rain rains, a storm has lightning', envAt(base, { weather: 'snow' }).fx.snow > 0 && envAt(base, { weather: 'rain' }).fx.rain > 0 && envAt(base, { weather: 'storm' }).fx.bolt > 0);
  ok('fireflies only on summer nights', envAt(base, Object.assign({ hour: 12.5, season: 'summer', weather: 'clear' }, SH)).fx.flies === 0);
  ok('petals only in spring', envAt(base, Object.assign({ hour: 12.5, season: 'autumn', weather: 'clear' }, SH)).fx.petals === 0);
  ok('the label reads like a clock', /\d\d:\d\d$/.test(envLabel(noon)));
  const sunrise = skyColours(1), day = skyColours(35);
  ok('the horizon is warm at sunrise and pale blue at noon', sunrise.hor[0] > sunrise.hor[2] && day.hor[2] > day.hor[0]);
}

/* ── 不问定位,也知道大概在哪 ── */
{
  const g = placeGuess(new Date());
  ok('a guessed place is on the globe', Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180);
  const p = moonPhase(at('2026-09-16T00:00:00Z'));
  ok('the moon phase is 0..1', p >= 0 && p < 1);
}

console.log(`\n${pass} passed, ${fails.length} failed\n`);
if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
process.exit(fails.length ? 1 : 0);
