#!/usr/bin/env node
/**
 * Push every canonical URL to IndexNow, which is how pages reach Bing's index
 * quickly. That matters more than it looks: ChatGPT resolves roughly 92% of its
 * retrieval queries against Bing, so Bing coverage is the practical ceiling on
 * how often Terse can be cited in an AI answer.
 *
 * Google does NOT participate in IndexNow — that side still needs Search Console.
 *
 * Run after any content push to landing/:
 *   node scripts/indexnow.mjs
 *   node scripts/indexnow.mjs https://www.terseai.org/for-windows   # just these
 */
const KEY = 'a055bad9893381dd17dc3457df5593a4';
const HOST = 'www.terseai.org';
const SITEMAP = `https://${HOST}/sitemap.xml`;
const ENDPOINTS = ['https://api.indexnow.org/IndexNow', 'https://www.bing.com/indexnow'];

async function urlsFromSitemap() {
  // Railway cold-starts can take ~5s and drop the first connection
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(SITEMAP, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) throw new Error(`sitemap returned ${res.status}`);
      const xml = await res.text();
      return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  sitemap fetch failed (${err.message}), retrying…`);
    }
  }
}

const explicit = process.argv.slice(2).filter((a) => a.startsWith('http'));
const urlList = explicit.length ? explicit : await urlsFromSitemap();

if (!urlList.length) {
  console.error('No URLs to submit.');
  process.exit(1);
}

const body = JSON.stringify({
  host: HOST,
  key: KEY,
  keyLocation: `https://${HOST}/${KEY}.txt`,
  urlList,
});

console.log(`Submitting ${urlList.length} URL(s)${explicit.length ? '' : ' from sitemap.xml'}…`);

let failed = 0;
for (const endpoint of ENDPOINTS) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(40_000),
    });
    // 200 = accepted; 202 = accepted, key still being validated
    const ok = res.status === 200 || res.status === 202;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${endpoint} → ${res.status}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${endpoint} → ${err.message}`);
  }
}
process.exit(failed === ENDPOINTS.length ? 1 : 0);
