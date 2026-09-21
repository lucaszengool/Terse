#!/usr/bin/env node
/**
 * fetch-social-photos.js — a real, related photo for the demo posts that talk
 * about something you could point a camera at. Writes api/social-photos.json.
 *
 *   node api/fetch-social-photos.js
 *
 * THE SAME LINE fetch-photos.js draws for the plaza, for the same reason: these
 * posts sit under invented names, so a photo found anywhere would be someone's
 * work hung under a name that is not theirs. Only Wikimedia Commons, and only
 * files whose licence is public domain or CC0 — no attribution owed, nothing
 * borrowed. The file title and licence are kept next to each image anyway.
 *
 * NO FALLBACK. The plaza falls back to a random Lorem Picsum image; here a post
 * about an orange cat that shows a random bridge is worse than a post with no
 * picture. If Commons has nothing that fits, the post stays text — which is also
 * what most real posts are.
 */
const fs = require('fs');
const path = require('path');

const UA = 'terse-social-seed/1.0 (https://www.terseai.org; photos for a labelled demo feed)';
const OUT = path.join(__dirname, 'social-photos.json');
/* The post image ceiling is 220KB of data URL; base64 adds a third. */
const MAX_RAW = 150 * 1024;

/* [a snippet of the post, search terms to try in order]. Terms name the THING in
   the post — the cat, the lake, the dish — because Commons has photographs of
   things, not of feelings. */
const WANT = [
  ['審計新村拍到一隻橘貓', ['orange tabby cat sitting street', 'ginger cat outdoors', 'orange cat', 'tabby cat']],
  ['週末去合歡山拍星空', ['Hehuanshan night sky', 'milky way over mountains']],
  ["saw saturn's rings", ['Saturn Cassini', 'Saturn planet rings']],
  ['lisbon sunset from the miradouro', ['Miradouro Lisbon sunset', 'Lisbon view from miradouro', 'Lisbon sunset', 'Lisbon viewpoint']],
  ['清邁的 co-working', ['coworking space people laptops', 'people working on laptops cafe']],
  ['河內的咖啡蛋', ['egg coffee Vietnam', 'Vietnamese coffee cup']],
  ['在第比利斯的第一週', ['Tbilisi old town', 'Tbilisi panorama']],
  ['osaka street food ranking', ['takoyaki', 'Dotonbori street food', 'takoyaki balls', 'Osaka food stall']],
  ['making paella tonight', ['paella pan', 'paella valenciana']],
  ['大理的晚霞每天都不一样', ['Erhai lake sunset', 'Dali Yunnan sunset', 'Cangshan Erhai', 'Dali Yunnan']],
  ['在洱海边改了一下午', ['Erhai lake Dali', 'Erhai lake shore']],
  ['骑了 80 公里去千岛湖', ['Qiandao Lake', 'road bicycle lake road', 'Qiandao Lake Chun', 'cycling lake road']],
  ['早上骑车过西湖,雾很大', ['West Lake Hangzhou mist', 'West Lake Hangzhou morning']],
  ['底片機拍完一卷', ['35mm film camera', 'film roll 35mm']],
  ['lego "server rack"', ['lego bricks', 'lego minifigures']],
  ['marathon #4 done', ['marathon runners street', 'marathon race runners']],
  ['climbing gym tonight', ['indoor climbing wall', 'bouldering gym']],
  ['threat model for my weekend', ['sauna by lake Estonia', 'wooden sauna lake', 'sauna', 'finnish sauna']],
  ['karak chai', ['karak chai', 'masala chai glass', 'tea glass', 'chai tea']],
  ['新竹的風今天大到我的咖啡', ['coffee cup on desk laptop', 'coffee cup desk']],
  ['台北下了一整天雨', ['rain window cafe', 'rainy street Taipei', 'raindrops window', 'rain window']],
  ['在寮國的慢船上兩天', ['Mekong slow boat Laos', 'Mekong river boat Laos']],
  ['madrid in september', ['Madrid terrace cafe', 'Plaza Mayor Madrid']],
  ['zürich rent is so high', ['Zurich old town Limmat', 'Zürich Altstadt', 'Zurich', 'Zurich skyline']],
  ['montréal first snow', ['Montreal autumn street', 'Mount Royal Montreal autumn', 'Old Montreal', 'Montreal']],
  ['豆腐今天第三次踩過鍵盤', ['cat on keyboard', 'cat on laptop']],
  ['moved to lisbon 6 months ago', ['pastel de nata', 'pasteis de nata']],
  ['code reviews on the treadmill', ['treadmill desk', 'treadmill gym']],
  ['把十年的照片交給 agent 分類', ['mountain lake landscape', 'alpine lake landscape']],
  ['finally took a day off', ['beach waves sand', 'sandy beach sea']],
  ['18 miles this morning before standup', ['runner sunrise road', 'running at dawn']],
  ['recovery run, 5k', ['running shoes', 'running shoes pavement', 'running shoes asphalt', 'runner park']],
];

/* Looked at and turned down: an identifiable serviceman, a child's face, a
   suburban road for a lake ride, a 1909 race for "my 4th marathon", and a
   painting where the post means a photo. A match on words is not a match. */
const REJECTED = new Set(["230204-N-TG517-133 - Visitors build LEGO ship models during Naval Museum's 12th Annual Brick by Brick; LEGO Shipbuilding event.jpg", "US Navy 111126-N-OY799-489 Chief Machinist's Mate Adam Reed runs five kilometers on a treadmill in the chief's gym aboard the Nimitz-class aircraft.jpg", "Lake Road Cycle Lanes Nearer Takapuna.jpg", "Runners ready to start in Shrubb-Dorando Marathon Race (St. Yves, Longboat, Hayes, and Maloney) LCCN2014683241.jpg", "Friedrich Carl von Scheidlin - Alpine Landscape with a Lake - K 262 - Slovak National Gallery.jpg"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function commons(query) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
    + '&generator=search&gsrnamespace=6&gsrlimit=15'
    + '&gsrsearch=' + encodeURIComponent(query + ' filetype:bitmap')
    + '&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=640';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const pages = ((await res.json()).query || {}).pages || {};
  const ok = [];
  for (const p of Object.values(pages).sort((a, b) => (a.index || 0) - (b.index || 0))) {
    const ii = (p.imageinfo || [])[0];
    if (!ii || !ii.thumburl) continue;
    const lic = (((ii.extmetadata || {}).LicenseShortName || {}).value || '').toLowerCase();
    if (!/public domain|cc0|pd-/.test(lic)) continue;
    // Suffix checked after the query string — Commons thumb URLs carry ?utm_source.
    if (!/\.(jpe?g)$/i.test(String(ii.thumburl).split('?')[0])) continue;
    // Landscape-ish only: a tall scan or a sliver of a panorama reads as broken in a feed.
    const ratio = (ii.thumbwidth || 1) / (ii.thumbheight || 1);
    if (ratio < 0.7 || ratio > 2.2) continue;
    if (REJECTED.has(p.title.replace(/^File:/, ''))) continue;
    ok.push({ url: ii.thumburl, title: p.title.replace(/^File:/, ''), license: lic, page: ii.descriptionurl });
  }
  return ok;
}

async function grab(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) return null;
  if (!/image\/jpeg/.test(res.headers.get('content-type') || '')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RAW || buf.length < 4000) return null;
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

async function main() {
  const { POSTS } = require('./seed-social');
  // Re-runs keep what they already found and only look for the rest.
  let out = {};
  try { out = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { out = {}; }
  for (const [snip, terms] of WANT) {
    if (out[snip]) continue;
    if (POSTS.filter((p) => p[1].includes(snip)).length !== 1) { console.log('NO POST  ', snip); continue; }
    let done = false;
    for (const q of terms) {
      let hits = [];
      try { hits = await commons(q); } catch (e) { hits = []; }
      await sleep(250);
      for (const h of hits.slice(0, 5)) {
        let img = null;
        try { img = await grab(h.url); } catch (e) { img = null; }
        await sleep(200);
        if (!img) {
          // Too big at 640px: ask Commons for a narrower thumbnail of the same file.
          try { img = await grab(h.url.replace(/\/(\d+)px-/, '/480px-')); } catch (e) { img = null; }
          await sleep(200);
        }
        if (!img) continue;
        out[snip] = { image: img, title: h.title, license: h.license, page: h.page, query: q };
        console.log('ok', String(Math.round(img.length / 1024)).padStart(4) + 'KB', snip.padEnd(24), '←', h.title.slice(0, 50), '(' + h.license + ')');
        done = true;
        break;
      }
      if (done) break;
    }
    if (!done) console.log('none      ', snip);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0));
  console.log(`\n${Object.keys(out).length}/${WANT.length} posts have a photo → ${OUT}`);
}

if (require.main === module) main();
module.exports = { WANT };
