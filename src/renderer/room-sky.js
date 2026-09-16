/**
 * room-sky.js — 走进楼的时候,外面是什么天:几点、什么季节、什么天气。纯函数,不碰 WebGL。
 *
 *   时间  跟着看的人自己的钟。太阳的高度按 suncalc 的公式算(Meeus),位置不问 Geolocation ——
 *         从时区猜一个大概的经纬度就够了:要的是"现在是黄昏",不是"太阳在 17.3°"。
 *   季节  按 ISO 周抽签:七成是这个半球真实的季节,三成随机 —— 随机,但一周之内不变。
 *   天气  一天切成八个三小时,每一格从上一格按季节的权重走一步(马尔可夫):晴不会直接跳到
 *         雷暴,中间要先阴下来。种子是日期,同一天同一个时段谁进来都是同一种天。
 *
 * 颜色是显示空间(sRGB 0–1)的天顶 / 地平线 / 太阳那一侧的光晕,按太阳高度在几个关键点之间插。
 */

const D2R = Math.PI / 180;
const hx = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

export const WEATHERS = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'snow', 'fog'];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const WEATHER_ICON = { clear: '☀️', cloudy: '⛅', overcast: '☁️', rain: '🌧️', storm: '⛈️', snow: '❄️', fog: '🌫️' };
export const SEASON_ICON = { spring: '🌸', summer: '🌿', autumn: '🍁', winter: '⛄' };

/** FNV-1a → [0, 1)。同一串字永远同一个数。 */
export function hash01(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/* ── 太阳 ─────────────────────────────────────────────────────────────────── */
/** 太阳高度角与方位角(弧度;方位从正南量,往西为正 —— suncalc 的约定)。 */
export function sunPosition(date, lat, lon) {
  const d = date.valueOf() / 864e5 - 0.5 + 2440588 - 2451545;
  const M = D2R * (357.5291 + 0.98560028 * d);
  const C = D2R * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + D2R * 102.9372 + Math.PI;
  const e = D2R * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const H = D2R * (280.16 + 360.9856235 * d) + D2R * lon - ra;
  const phi = D2R * lat;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { alt, az };
}

/** 月相 0..1(0 新月,0.5 满月)。 */
export function moonPhase(date) {
  const jd = date.valueOf() / 864e5 + 2440587.5;
  const p = ((jd - 2451550.1) / 29.530588853) % 1;
  return p < 0 ? p + 1 : p;
}

/* 时区 → 大概在哪。只要够猜出日出日落和南北半球;猜不到就按 UTC 偏移量算经度。 */
const TZ = {
  'Asia/Shanghai': [31, 121], 'Asia/Hong_Kong': [22, 114], 'Asia/Taipei': [25, 121], 'Asia/Tokyo': [36, 140],
  'Asia/Seoul': [37, 127], 'Asia/Singapore': [1, 104], 'Asia/Kolkata': [20, 78], 'Asia/Dubai': [25, 55],
  'Asia/Bangkok': [14, 100], 'Asia/Jakarta': [-6, 107], 'Asia/Manila': [15, 121], 'Asia/Ho_Chi_Minh': [11, 107],
  'Asia/Jerusalem': [32, 35], 'Asia/Karachi': [25, 67], 'Asia/Kuala_Lumpur': [3, 102], 'Asia/Urumqi': [44, 88],
  'Europe/London': [51, 0], 'Europe/Paris': [49, 2], 'Europe/Berlin': [52, 13], 'Europe/Madrid': [40, -4],
  'Europe/Rome': [42, 12], 'Europe/Amsterdam': [52, 5], 'Europe/Stockholm': [59, 18], 'Europe/Moscow': [56, 38],
  'Europe/Istanbul': [41, 29], 'Europe/Warsaw': [52, 21], 'Europe/Zurich': [47, 9], 'Europe/Kiev': [50, 31], 'Europe/Kyiv': [50, 31],
  'America/New_York': [41, -74], 'America/Chicago': [42, -88], 'America/Denver': [40, -105], 'America/Los_Angeles': [34, -118],
  'America/Toronto': [44, -79], 'America/Vancouver': [49, -123], 'America/Mexico_City': [19, -99], 'America/Sao_Paulo': [-24, -47],
  'America/Argentina/Buenos_Aires': [-35, -58], 'America/Santiago': [-33, -71], 'America/Bogota': [5, -74], 'America/Lima': [-12, -77],
  'America/Phoenix': [33, -112], 'America/Anchorage': [61, -150], 'Pacific/Honolulu': [21, -158],
  'Australia/Sydney': [-34, 151], 'Australia/Melbourne': [-38, 145], 'Australia/Perth': [-32, 116], 'Australia/Brisbane': [-27, 153],
  'Pacific/Auckland': [-37, 175], 'Africa/Johannesburg': [-26, 28], 'Africa/Lagos': [6, 3], 'Africa/Cairo': [30, 31], 'Africa/Nairobi': [-1, 37],
};
const SOUTH = /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Fiji|Chatham)|^America\/(Sao_Paulo|Argentina|Santiago|Montevideo|Asuncion|La_Paz|Lima)|^Africa\/(Johannesburg|Maputo|Harare|Windhoek|Lusaka)/;

/** 看的人大概在哪:{lat, lon, tz}。不问定位权限。 */
export function placeGuess(date = new Date()) {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* 没有 Intl 就按偏移量 */ }
  if (TZ[tz]) return { lat: TZ[tz][0], lon: TZ[tz][1], tz };
  const lon = Math.max(-180, Math.min(180, -date.getTimezoneOffset() / 4));
  return { lat: SOUTH.test(tz) ? -30 : 35, lon, tz };
}

/** 这个半球现在真实的季节。 */
export function realSeason(date, lat) {
  const m = date.getMonth();                   // 0 = 一月
  const north = m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'autumn' : 'winter';
  if (lat >= 0) return north;
  return { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' }[north];
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return d.getUTCFullYear() + 'w' + Math.ceil(((d - y0) / 864e5 + 1) / 7);
}
const dayKey = (date) => date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();

/** 季节:七成真实、三成随机,一周之内不变。 */
export function seasonOf(date, lat, seed = '') {
  const r = hash01(seed + ':season:' + isoWeek(date));
  const real = realSeason(date, lat);
  if (r < 0.7) return real;
  const others = SEASONS.filter((s) => s !== real);
  return others[Math.min(others.length - 1, Math.floor((r - 0.7) / 0.3 * others.length))];
}

/* 每个季节里各种天的权重(和为 100)。冬天的雨多半落成雪。 */
const W = {
  spring: { clear: 30, cloudy: 26, overcast: 12, rain: 18, storm: 4, snow: 0, fog: 10 },
  summer: { clear: 40, cloudy: 25, overcast: 6, rain: 12, storm: 12, snow: 0, fog: 5 },
  autumn: { clear: 30, cloudy: 25, overcast: 15, rain: 13, storm: 3, snow: 2, fog: 12 },
  winter: { clear: 25, cloudy: 14, overcast: 22, rain: 4, storm: 0, snow: 27, fog: 8 },
};
/* 哪些天能直接走到哪些天。晴 → 雷暴要先阴、再下雨。 */
const NEXT = {
  clear: ['clear', 'cloudy', 'fog'], cloudy: ['clear', 'cloudy', 'overcast', 'fog'],
  overcast: ['cloudy', 'overcast', 'rain', 'snow', 'fog'], rain: ['overcast', 'rain', 'storm', 'cloudy', 'snow'],
  storm: ['rain', 'storm', 'overcast'], snow: ['overcast', 'snow', 'cloudy'], fog: ['clear', 'cloudy', 'overcast', 'fog'],
};
function pickWeighted(list, season, r) {
  const ws = list.map((k) => W[season][k] || 0), sum = ws.reduce((a, b) => a + b, 0);
  if (!sum) return list[0];
  let acc = 0;
  for (let i = 0; i < list.length; i++) { acc += ws[i] / sum; if (r < acc) return list[i]; }
  return list[list.length - 1];
}
/** 这一天这一时段是什么天气,外加上一格是什么(雨后才有彩虹)。 */
export function weatherOf(date, season, seed = '') {
  const day = dayKey(date), slot = Math.floor(date.getHours() / 3);
  let w = pickWeighted(WEATHERS, season, hash01(seed + ':wx:' + day));
  let prev = w;
  for (let s = 1; s <= slot; s++) {
    prev = w;
    const r = hash01(seed + ':wx:' + day + ':' + s);
    if (r < 0.5) continue;                                   // 一半的时候天就这样接着
    w = pickWeighted(NEXT[w], season, (r - 0.5) * 2);
  }
  return { weather: w, prev };
}

/* 天空的关键点:太阳高度(度)→ 天顶、地平线、太阳那边的光晕(sRGB)。 */
const STOPS = [
  [-18, hx('#02040B'), hx('#070B1A'), hx('#070B1A')],
  [-12, hx('#050A1C'), hx('#121B3A'), hx('#1A1F40')],
  [-6, hx('#0B1740'), hx('#2B3A6B'), hx('#5A4A7A')],
  [-2, hx('#1B2F6B'), hx('#6E7FB8'), hx('#E58A6A')],
  [2, hx('#3A5BA0'), hx('#F29A5C'), hx('#FF7A45')],
  [8, hx('#4F86D6'), hx('#F7C58A'), hx('#FFD08A')],
  [20, hx('#2F7BE0'), hx('#A9D3F5'), hx('#FFF1D6')],
  [40, hx('#1E6FE0'), hx('#BFE3FF'), hx('#FFFFFF')],
];
export function skyColours(el) {
  if (el <= STOPS[0][0]) return { zen: STOPS[0][1], hor: STOPS[0][2], glow: STOPS[0][3] };
  for (let i = 1; i < STOPS.length; i++) {
    if (el <= STOPS[i][0]) {
      const a = STOPS[i - 1], b = STOPS[i], t = smooth(0, 1, (el - a[0]) / (b[0] - a[0]));
      return { zen: mix3(a[1], b[1], t), hor: mix3(a[2], b[2], t), glow: mix3(a[3], b[3], t) };
    }
  }
  const L = STOPS[STOPS.length - 1];
  return { zen: L[1], hor: L[2], glow: L[3] };
}

/* 每种天的"量":云盖多少、雨雪雾多大、风、打不打雷。 */
const FX = {
  clear: { cover: 0.08, rain: 0, snow: 0, fog: 0, wind: 0.15, bolt: 0 },
  cloudy: { cover: 0.45, rain: 0, snow: 0, fog: 0.05, wind: 0.3, bolt: 0 },
  overcast: { cover: 0.88, rain: 0, snow: 0, fog: 0.2, wind: 0.25, bolt: 0 },
  rain: { cover: 0.85, rain: 0.6, snow: 0, fog: 0.25, wind: 0.4, bolt: 0 },
  storm: { cover: 1, rain: 1, snow: 0, fog: 0.3, wind: 1, bolt: 1 },
  snow: { cover: 0.8, rain: 0, snow: 1, fog: 0.3, wind: 0.3, bolt: 0 },
  fog: { cover: 0.55, rain: 0, snow: 0, fog: 1, wind: 0.05, bolt: 0 },
};

/**
 * 此刻的天。
 * @param {Date} [date]
 * @param {{seed?:string, lat?:number, lon?:number, hour?:number, weather?:string, season?:string}} [o]
 *   hour / weather / season 给了就用它(测试、原型页、界面上手动换);不给就按钟和种子来
 */
export function envAt(date = new Date(), o = {}) {
  const seed = o.seed || '';
  let d = new Date(date.valueOf());
  if (o.hour != null && Number.isFinite(+o.hour)) {
    const h = +o.hour;
    d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  }
  const place = Number.isFinite(o.lat) && Number.isFinite(o.lon) ? { lat: o.lat, lon: o.lon } : placeGuess(d);
  const sp = sunPosition(d, place.lat, place.lon);
  const sunEl = sp.alt / D2R;
  const season = SEASONS.includes(o.season) ? o.season : seasonOf(d, place.lat, seed);
  const wx = weatherOf(d, season, seed);
  const weather = WEATHERS.includes(o.weather) ? o.weather : wx.weather;
  const fx = Object.assign({}, FX[weather]);
  // 夜:太阳落到地平线下 8° 全黑,升过 3° 全亮;黄金时刻是太阳在 -2°..10° 的那一段
  const night = 1 - smooth(-8, 3, sunEl);
  const golden = smooth(-3, 2, sunEl) * (1 - smooth(6, 14, sunEl));
  const col = skyColours(sunEl);
  // 阴天把天空往灰里拉,雷暴再压暗;夜里只压暗一点
  const grey = mix3(hx('#9AA4B2'), hx('#3A4250'), fx.bolt), gk = fx.cover * 0.8 * (1 - night * 0.6);
  const nightDim = 1 - fx.cover * 0.45 * night;
  const zen = mix3(col.zen, mix3(grey, col.zen, night), gk).map((v) => v * nightDim);
  const hor = mix3(col.hor, mix3(mix3(grey, [1, 1, 1], 0.25), col.hor, night), gk).map((v) => v * nightDim);
  const glow = mix3(col.glow, hor, fx.cover * 0.7);
  // 季节和天加上去的粒子:花瓣、落叶、萤火、极光、彩虹
  const r = (k) => hash01(seed + ':' + k + ':' + dayKey(d));
  const calm = weather === 'clear' || weather === 'cloudy';
  fx.petals = season === 'spring' && calm && night < 0.6 && r('petal') < 0.85 ? 1 : 0;
  fx.leaves = season === 'autumn' && weather !== 'snow' && r('leaf') < 0.85 ? 1 : 0;
  fx.flies = season === 'summer' && night > 0.5 && !fx.rain && r('fly') < 0.8 ? 1 : 0;
  fx.aurora = (season === 'winter' || r('aur-any') < 0.15) && night > 0.7 && fx.cover < 0.5 && r('aur') < 0.45 ? 1 : 0;
  const rainEnded = (wx.prev === 'rain' || wx.prev === 'storm') && calm;
  fx.bow = (rainEnded || (weather === 'cloudy' && r('bow') < 0.12)) && sunEl > 1 && sunEl < 42 ? 1 : 0;
  const hour = d.getHours() + d.getMinutes() / 60;
  const phase = night > 0.85 ? 'night' : sunEl < 2 ? (hour < 12 ? 'dawn' : 'dusk') : golden > 0.4 ? 'golden' : 'day';
  return {
    date: d, hour, lat: place.lat, lon: place.lon, sunEl, sunAz: sp.az / D2R, night, golden, phase,
    season, weather, fx, zen, hor, glow, moon: moonPhase(d), seed,
  };
}

/** 界面上那颗小按钮的字:"⛅ 🍁 17:42"。 */
export function envLabel(env) {
  const h = Math.floor(env.hour), m = Math.round((env.hour - h) * 60);
  return `${WEATHER_ICON[env.weather] || ''} ${SEASON_ICON[env.season] || ''} ${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
