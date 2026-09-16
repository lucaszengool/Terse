/**
 * geo.js — 广场"星球"上一个项目落在哪:城市级的大致位置,取整到一度(约 100 公里)。
 *
 * 位置从哪来:
 *   · 新发布的项目 → Cloudflare 看到的发布者所在城市。需要在 Cloudflare 后台打开
 *     Rules → Transform Rules → Managed Transforms → "Add visitor location headers",
 *     之后每个请求都带 cf-iplatitude / cf-iplongitude / cf-ipcity。没打开时只有默认的
 *     cf-ipcountry,就落在那个国家的大致中心。
 *   · GitHub 导入的项目 → 作者在 GitHub 主页上公开填的"所在地",用下面的城市表换成坐标
 *     (geo-backfill.js)。认不出来的不上星球。
 *
 * ⚠ 只存城市级的大致位置,**从不存、也从不显示 IP**。坐标取整到一度:地球上看得出
 *   "在哪座城市一带",但定位不到一个人。
 */

/** ISO 3166-1 二位码 → [纬度, 经度, 名字](国家的大致中心)。 */
const COUNTRIES = {
  US: [39.8, -98.6, 'United States'], CN: [35.9, 104.2, 'China'], JP: [36.2, 138.3, 'Japan'], KR: [36.5, 127.9, 'South Korea'],
  TW: [23.7, 121.0, 'Taiwan'], HK: [22.3, 114.2, 'Hong Kong'], MO: [22.2, 113.5, 'Macau'], SG: [1.35, 103.8, 'Singapore'],
  IN: [21.0, 78.0, 'India'], ID: [-2.5, 118.0, 'Indonesia'], VN: [14.1, 108.3, 'Vietnam'], TH: [15.9, 100.9, 'Thailand'],
  MY: [4.2, 102.0, 'Malaysia'], PH: [12.9, 121.8, 'Philippines'], AU: [-25.3, 133.8, 'Australia'], NZ: [-40.9, 174.9, 'New Zealand'],
  CA: [56.1, -106.3, 'Canada'], MX: [23.6, -102.5, 'Mexico'], BR: [-14.2, -51.9, 'Brazil'], AR: [-38.4, -63.6, 'Argentina'],
  CL: [-35.7, -71.5, 'Chile'], CO: [4.6, -74.3, 'Colombia'], PE: [-9.2, -75.0, 'Peru'], VE: [6.4, -66.6, 'Venezuela'],
  EC: [-1.8, -78.2, 'Ecuador'], UY: [-32.5, -55.8, 'Uruguay'], CR: [9.7, -83.8, 'Costa Rica'], CU: [21.5, -77.8, 'Cuba'],
  GB: [54.0, -2.0, 'United Kingdom'], IE: [53.4, -8.2, 'Ireland'], FR: [46.2, 2.2, 'France'], DE: [51.2, 10.4, 'Germany'],
  NL: [52.1, 5.3, 'Netherlands'], BE: [50.5, 4.5, 'Belgium'], LU: [49.8, 6.1, 'Luxembourg'], CH: [46.8, 8.2, 'Switzerland'],
  AT: [47.5, 14.6, 'Austria'], IT: [41.9, 12.6, 'Italy'], ES: [40.5, -3.7, 'Spain'], PT: [39.4, -8.2, 'Portugal'],
  SE: [60.1, 18.6, 'Sweden'], NO: [60.5, 8.5, 'Norway'], FI: [61.9, 25.7, 'Finland'], DK: [56.3, 9.5, 'Denmark'],
  IS: [65.0, -19.0, 'Iceland'], PL: [51.9, 19.1, 'Poland'], CZ: [49.8, 15.5, 'Czechia'], SK: [48.7, 19.7, 'Slovakia'],
  HU: [47.2, 19.5, 'Hungary'], RO: [45.9, 25.0, 'Romania'], BG: [42.7, 25.5, 'Bulgaria'], RS: [44.0, 21.0, 'Serbia'],
  HR: [45.1, 15.2, 'Croatia'], SI: [46.15, 15.0, 'Slovenia'], GR: [39.1, 21.8, 'Greece'], CY: [35.1, 33.4, 'Cyprus'],
  LT: [55.2, 23.9, 'Lithuania'], LV: [56.9, 24.6, 'Latvia'], EE: [58.6, 25.0, 'Estonia'], BY: [53.7, 28.0, 'Belarus'],
  UA: [48.4, 31.2, 'Ukraine'], RU: [61.5, 105.3, 'Russia'], TR: [39.0, 35.2, 'Turkey'], GE: [42.3, 43.4, 'Georgia'],
  AM: [40.1, 45.0, 'Armenia'], AZ: [40.1, 47.6, 'Azerbaijan'], KZ: [48.0, 66.9, 'Kazakhstan'], UZ: [41.4, 64.6, 'Uzbekistan'],
  IL: [31.0, 34.9, 'Israel'], JO: [30.6, 36.2, 'Jordan'], LB: [33.85, 35.9, 'Lebanon'], AE: [23.4, 53.8, 'United Arab Emirates'],
  SA: [23.9, 45.1, 'Saudi Arabia'], QA: [25.35, 51.2, 'Qatar'], KW: [29.3, 47.5, 'Kuwait'], IR: [32.4, 53.7, 'Iran'],
  PK: [30.4, 69.3, 'Pakistan'], BD: [23.7, 90.4, 'Bangladesh'], LK: [7.9, 80.8, 'Sri Lanka'], NP: [28.4, 84.1, 'Nepal'],
  MN: [46.9, 103.8, 'Mongolia'], KH: [12.6, 105.0, 'Cambodia'], MM: [21.9, 96.0, 'Myanmar'],
  EG: [26.8, 30.8, 'Egypt'], MA: [31.8, -7.1, 'Morocco'], DZ: [28.0, 1.7, 'Algeria'], TN: [33.9, 9.5, 'Tunisia'],
  NG: [9.1, 8.7, 'Nigeria'], GH: [7.9, -1.0, 'Ghana'], KE: [0.0, 37.9, 'Kenya'], ET: [9.1, 40.5, 'Ethiopia'],
  ZA: [-30.6, 22.9, 'South Africa'],
};

/* 城市表:[别名们(小写,用 | 分), 纬度, 经度, 国家]。GitHub 主页上人填的多半是这些城市之一。
   只放够用的科技城市;认不出来就不上星球,比猜一个错的位置好。 */
const CITY_ROWS = [
  ['san francisco|sf|bay area|silicon valley', 37.77, -122.42, 'US'], ['san jose', 37.34, -121.89, 'US'], ['palo alto', 37.44, -122.14, 'US'],
  ['mountain view', 37.39, -122.08, 'US'], ['oakland', 37.8, -122.27, 'US'], ['berkeley', 37.87, -122.27, 'US'],
  ['los angeles', 34.05, -118.24, 'US'], ['san diego', 32.72, -117.16, 'US'], ['seattle', 47.61, -122.33, 'US'],
  ['portland', 45.52, -122.68, 'US'], ['new york|nyc|brooklyn|manhattan', 40.71, -74.01, 'US'], ['boston', 42.36, -71.06, 'US'],
  ['chicago', 41.88, -87.63, 'US'], ['austin', 30.27, -97.74, 'US'], ['dallas', 32.78, -96.8, 'US'], ['houston', 29.76, -95.37, 'US'],
  ['denver', 39.74, -104.99, 'US'], ['boulder', 40.01, -105.27, 'US'], ['atlanta', 33.75, -84.39, 'US'], ['miami', 25.76, -80.19, 'US'],
  ['washington, dc|washington dc|district of columbia', 38.91, -77.04, 'US'], ['philadelphia', 39.95, -75.17, 'US'],
  ['pittsburgh', 40.44, -79.99, 'US'], ['salt lake city', 40.76, -111.89, 'US'], ['phoenix', 33.45, -112.07, 'US'],
  ['minneapolis', 44.98, -93.27, 'US'], ['detroit', 42.33, -83.05, 'US'], ['raleigh', 35.78, -78.64, 'US'], ['nashville', 36.16, -86.78, 'US'],
  ['vancouver', 49.28, -123.12, 'CA'], ['toronto', 43.65, -79.38, 'CA'], ['montreal|montréal', 45.5, -73.57, 'CA'],
  ['ottawa', 45.42, -75.7, 'CA'], ['calgary', 51.05, -114.07, 'CA'], ['waterloo', 43.46, -80.52, 'CA'],
  ['mexico city|ciudad de méxico|cdmx', 19.43, -99.13, 'MX'], ['guadalajara', 20.66, -103.35, 'MX'],
  ['são paulo|sao paulo', -23.55, -46.63, 'BR'], ['rio de janeiro', -22.91, -43.17, 'BR'], ['buenos aires', -34.6, -58.38, 'AR'],
  ['santiago', -33.45, -70.67, 'CL'], ['bogotá|bogota', 4.71, -74.07, 'CO'], ['lima', -12.05, -77.04, 'PE'], ['montevideo', -34.9, -56.16, 'UY'],
  ['london', 51.51, -0.13, 'GB'], ['manchester', 53.48, -2.24, 'GB'], ['edinburgh', 55.95, -3.19, 'GB'], ['oxford', 51.75, -1.26, 'GB'],
  ['bristol', 51.45, -2.59, 'GB'], ['dublin', 53.35, -6.26, 'IE'], ['paris', 48.86, 2.35, 'FR'], ['lyon', 45.76, 4.84, 'FR'],
  ['berlin', 52.52, 13.4, 'DE'], ['munich|münchen|muenchen', 48.14, 11.58, 'DE'], ['hamburg', 53.55, 9.99, 'DE'],
  ['frankfurt', 50.11, 8.68, 'DE'], ['cologne|köln|koeln', 50.94, 6.96, 'DE'], ['stuttgart', 48.78, 9.18, 'DE'],
  ['amsterdam', 52.37, 4.9, 'NL'], ['rotterdam', 51.92, 4.48, 'NL'], ['utrecht', 52.09, 5.12, 'NL'], ['brussels|bruxelles', 50.85, 4.35, 'BE'],
  ['zurich|zürich', 47.38, 8.54, 'CH'], ['geneva|genève', 46.2, 6.14, 'CH'], ['vienna|wien', 48.21, 16.37, 'AT'],
  ['milan|milano', 45.46, 9.19, 'IT'], ['rome|roma', 41.9, 12.5, 'IT'], ['madrid', 40.42, -3.7, 'ES'], ['barcelona', 41.39, 2.17, 'ES'],
  ['lisbon|lisboa', 38.72, -9.14, 'PT'], ['porto', 41.15, -8.61, 'PT'], ['stockholm', 59.33, 18.07, 'SE'], ['oslo', 59.91, 10.75, 'NO'],
  ['copenhagen|københavn', 55.68, 12.57, 'DK'], ['helsinki', 60.17, 24.94, 'FI'], ['reykjavik', 64.15, -21.94, 'IS'],
  ['warsaw|warszawa', 52.23, 21.01, 'PL'], ['kraków|krakow|cracow', 50.06, 19.94, 'PL'], ['prague|praha', 50.08, 14.44, 'CZ'],
  ['budapest', 47.5, 19.04, 'HU'], ['bucharest|bucurești', 44.43, 26.1, 'RO'], ['sofia', 42.7, 23.32, 'BG'], ['belgrade|beograd', 44.79, 20.45, 'RS'],
  ['zagreb', 45.81, 15.98, 'HR'], ['athens|athína', 37.98, 23.73, 'GR'], ['tallinn', 59.44, 24.75, 'EE'], ['riga', 56.95, 24.11, 'LV'],
  ['vilnius', 54.69, 25.28, 'LT'], ['minsk', 53.9, 27.56, 'BY'], ['kyiv|kiev', 50.45, 30.52, 'UA'], ['kharkiv|kharkov', 49.99, 36.23, 'UA'],
  ['lviv', 49.84, 24.03, 'UA'], ['moscow|москва', 55.76, 37.62, 'RU'], ['saint petersburg|st. petersburg|st petersburg', 59.93, 30.36, 'RU'],
  ['novosibirsk', 55.01, 82.93, 'RU'], ['istanbul', 41.01, 28.98, 'TR'], ['ankara', 39.93, 32.86, 'TR'], ['tbilisi', 41.72, 44.79, 'GE'],
  ['yerevan', 40.18, 44.51, 'AM'], ['tel aviv', 32.09, 34.78, 'IL'], ['jerusalem', 31.77, 35.21, 'IL'], ['dubai', 25.2, 55.27, 'AE'],
  ['abu dhabi', 24.45, 54.38, 'AE'], ['riyadh', 24.71, 46.68, 'SA'], ['doha', 25.29, 51.53, 'QA'], ['tehran', 35.69, 51.39, 'IR'],
  ['cairo', 30.04, 31.24, 'EG'], ['lagos', 6.52, 3.38, 'NG'], ['abuja', 9.08, 7.4, 'NG'], ['accra', 5.6, -0.19, 'GH'],
  ['nairobi', -1.29, 36.82, 'KE'], ['addis ababa', 9.03, 38.74, 'ET'], ['cape town', -33.92, 18.42, 'ZA'], ['johannesburg', -26.2, 28.05, 'ZA'],
  ['casablanca', 33.57, -7.59, 'MA'], ['tunis', 36.81, 10.18, 'TN'],
  ['bangalore|bengaluru', 12.97, 77.59, 'IN'], ['mumbai|bombay', 19.08, 72.88, 'IN'], ['new delhi|delhi', 28.61, 77.21, 'IN'],
  ['hyderabad', 17.39, 78.49, 'IN'], ['pune', 18.52, 73.86, 'IN'], ['chennai', 13.08, 80.27, 'IN'], ['kolkata|calcutta', 22.57, 88.36, 'IN'],
  ['gurgaon|gurugram', 28.46, 77.03, 'IN'], ['noida', 28.54, 77.39, 'IN'], ['karachi', 24.86, 67.01, 'PK'], ['lahore', 31.55, 74.34, 'PK'],
  ['islamabad', 33.68, 73.05, 'PK'], ['dhaka', 23.81, 90.41, 'BD'], ['colombo', 6.93, 79.86, 'LK'], ['kathmandu', 27.72, 85.32, 'NP'],
  ['beijing|peking|北京', 39.9, 116.41, 'CN'], ['shanghai|上海', 31.23, 121.47, 'CN'], ['shenzhen|深圳', 22.54, 114.06, 'CN'],
  ['guangzhou|广州', 23.13, 113.26, 'CN'], ['hangzhou|杭州', 30.27, 120.16, 'CN'], ['chengdu|成都', 30.57, 104.07, 'CN'],
  ['wuhan|武汉', 30.59, 114.31, 'CN'], ['nanjing|南京', 32.06, 118.8, 'CN'], ["xi'an|xian|西安", 34.34, 108.94, 'CN'],
  ['suzhou|苏州', 31.3, 120.62, 'CN'], ['chongqing|重庆', 29.56, 106.55, 'CN'], ['tianjin|天津', 39.34, 117.36, 'CN'],
  ['xiamen|厦门', 24.48, 118.09, 'CN'], ['hefei|合肥', 31.82, 117.23, 'CN'], ['changsha|长沙', 28.23, 112.94, 'CN'],
  ['hong kong|香港', 22.32, 114.17, 'HK'], ['taipei|台北|臺北', 25.03, 121.57, 'TW'], ['hsinchu|新竹', 24.8, 120.97, 'TW'],
  ['tokyo|東京|东京', 35.68, 139.69, 'JP'], ['osaka|大阪', 34.69, 135.5, 'JP'], ['kyoto|京都', 35.01, 135.77, 'JP'],
  ['fukuoka|福岡', 33.59, 130.4, 'JP'], ['seoul|서울|首尔', 37.57, 126.98, 'KR'], ['busan|부산', 35.18, 129.08, 'KR'],
  ['singapore|新加坡', 1.35, 103.82, 'SG'], ['kuala lumpur', 3.14, 101.69, 'MY'], ['bangkok|กรุงเทพ', 13.76, 100.5, 'TH'],
  ['jakarta', -6.21, 106.85, 'ID'], ['bandung', -6.92, 107.61, 'ID'], ['manila', 14.6, 120.98, 'PH'],
  ['ho chi minh|saigon|hồ chí minh', 10.82, 106.63, 'VN'], ['hanoi|hà nội', 21.03, 105.85, 'VN'],
  ['sydney', -33.87, 151.21, 'AU'], ['melbourne', -37.81, 144.96, 'AU'], ['brisbane', -27.47, 153.03, 'AU'], ['perth', -31.95, 115.86, 'AU'],
  ['auckland', -36.85, 174.76, 'NZ'], ['wellington', -41.29, 174.78, 'NZ'],
];

/* 国家名 / 常见写法 → 二位码。只在城市认不出来时才用。 */
const COUNTRY_ROWS = [
  ['united states|usa|u.s.a.|u.s.|america', 'US'], ['china|中国|prc', 'CN'], ['japan|日本', 'JP'], ['south korea|korea|한국|韩国', 'KR'],
  ['taiwan|台湾|臺灣', 'TW'], ['india', 'IN'], ['germany|deutschland', 'DE'], ['france', 'FR'],
  ['united kingdom|uk|england|scotland|wales|britain', 'GB'], ['canada', 'CA'], ['brazil|brasil', 'BR'], ['australia', 'AU'],
  ['netherlands|holland|the netherlands', 'NL'], ['spain|españa', 'ES'], ['italy|italia', 'IT'], ['russia|россия', 'RU'],
  ['sweden|sverige', 'SE'], ['switzerland|schweiz|suisse', 'CH'], ['poland|polska', 'PL'], ['ukraine|україна', 'UA'],
  ['israel', 'IL'], ['indonesia', 'ID'], ['vietnam|viet nam', 'VN'], ['turkey|türkiye', 'TR'], ['mexico|méxico', 'MX'],
  ['argentina', 'AR'], ['nigeria', 'NG'], ['kenya', 'KE'], ['egypt', 'EG'], ['south africa', 'ZA'], ['portugal', 'PT'],
  ['ireland', 'IE'], ['norway|norge', 'NO'], ['denmark|danmark', 'DK'], ['finland|suomi', 'FI'], ['austria|österreich', 'AT'],
  ['belgium|belgique|belgië', 'BE'], ['czech republic|czechia', 'CZ'], ['hungary|magyarország', 'HU'], ['romania|românia', 'RO'],
  ['greece', 'GR'], ['new zealand', 'NZ'], ['philippines', 'PH'], ['thailand', 'TH'], ['malaysia', 'MY'], ['pakistan', 'PK'],
  ['bangladesh', 'BD'], ['iran', 'IR'], ['united arab emirates|uae', 'AE'], ['saudi arabia', 'SA'], ['chile', 'CL'],
  ['colombia', 'CO'], ['peru', 'PE'], ['singapore', 'SG'], ['hong kong', 'HK'], ['estonia', 'EE'], ['latvia', 'LV'],
  ['lithuania', 'LT'], ['bulgaria', 'BG'], ['serbia', 'RS'], ['croatia', 'HR'], ['slovakia', 'SK'], ['slovenia', 'SI'],
  ['belarus', 'BY'], ['kazakhstan', 'KZ'], ['georgia', 'GE'], ['armenia', 'AM'], ['sri lanka', 'LK'], ['nepal', 'NP'],
  ['morocco', 'MA'], ['ghana', 'GH'], ['ethiopia', 'ET'], ['uruguay', 'UY'], ['venezuela', 'VE'], ['ecuador', 'EC'],
  ['iceland', 'IS'], ['luxembourg', 'LU'], ['cyprus', 'CY'], ['qatar', 'QA'], ['jordan', 'JO'], ['lebanon', 'LB'],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 一个别名的匹配器:拉丁字母按词边界(免得 "rome" 命中 "chrome"),中日韩直接包含。 */
function matcher(alias) {
  if (/[^\x00-\x7f]/.test(alias) && !/[a-zà-ÿ]/i.test(alias)) return (t) => t.includes(alias);
  const re = new RegExp('(^|[^a-z0-9])' + esc(alias) + '($|[^a-z0-9])');
  return (t) => re.test(t);
}
const CITIES = CITY_ROWS.flatMap(([names, lat, lon, cc]) =>
  names.split('|').map((a) => ({ a, test: matcher(a), lat, lon, cc, city: names.split('|')[0] })));
const COUNTRY_ALIASES = COUNTRY_ROWS.flatMap(([names, cc]) => names.split('|').map((a) => ({ a, test: matcher(a), cc })));

const title = (s) => s.replace(/(^|[\s-])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());

/** 夹一遍:坐标取整到一度,名字只留字母和常见标点。不合规就是 null。 */
function cleanGeo(g) {
  if (!g || typeof g !== 'object') return null;
  const lat = +g.lat, lon = +g.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const txt = (v, n) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[<>"'` -]/g, '').trim().slice(0, n);
  const country = /^[A-Z]{2}$/.test(String(g.country || '')) ? String(g.country) : '';
  const src = ['ip', 'country', 'github'].indexOf(String(g.src || '')) >= 0 ? String(g.src) : '';
  return { lat: Math.round(lat), lon: Math.round(lon), city: txt(g.city, 40), country, src };
}

/** 从 Cloudflare 的请求头读发布者的大致位置。没有 Cloudflare 头(本地、测试)就是 null。 */
function geoFromRequest(req) {
  const h = (k) => String((req && req.get && req.get(k)) || '').trim();
  const cc = h('cf-ipcountry').toUpperCase();
  if (!cc || cc === 'XX' || cc === 'T1') return null;          // XX 未知,T1 是 Tor
  const lat = parseFloat(h('cf-iplatitude')), lon = parseFloat(h('cf-iplongitude'));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    let city = h('cf-ipcity');
    try { city = decodeURIComponent(city); } catch (e) { /* 原样用 */ }
    return cleanGeo({ lat, lon, city, country: cc, src: 'ip' });
  }
  const c = COUNTRIES[cc];
  return c ? cleanGeo({ lat: c[0], lon: c[1], city: '', country: cc, src: 'country' }) : null;
}

/** GitHub 主页上人写的"所在地"(自由文本)→ 大致位置。先认城市,认不出再认国家,都不认识就 null。 */
function geocodePlace(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  let best = null;
  for (const c of CITIES) if (c.test(t) && (!best || c.a.length > best.a.length)) best = c;
  if (best) return cleanGeo({ lat: best.lat, lon: best.lon, city: title(best.city), country: best.cc, src: 'github' });
  let cc = null, len = 0;
  for (const a of COUNTRY_ALIASES) if (a.test(t) && a.a.length > len) { cc = a.cc; len = a.a.length; }
  const c = cc && COUNTRIES[cc];
  return c ? cleanGeo({ lat: c[0], lon: c[1], city: '', country: cc, src: 'github' }) : null;
}

module.exports = { geoFromRequest, geocodePlace, cleanGeo, COUNTRIES };
