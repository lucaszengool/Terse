/* Assert the ring: N fetches of /w/:token must walk the whole ring, in order,
   and wrap — the property the Shortcut burst loop depends on. */
const crypto = require('crypto');
const URL_ = process.argv[2];
const N = parseInt(process.argv[3] || '26', 10);

(async () => {
  const seen = [];
  let headers0 = null;
  for (let i = 0; i < N; i++) {
    const r = await fetch(URL_);
    if (i === 0) headers0 = { status: r.status, ct: r.headers.get('content-type'), cc: r.headers.get('cache-control') };
    const buf = Buffer.from(await r.arrayBuffer());
    seen.push({ h: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8), n: buf.length, s: r.status });
  }
  console.log('first response:', JSON.stringify(headers0));
  console.log('statuses     :', [...new Set(seen.map(x => x.s))].join(','));
  console.log('sequence     :', seen.map(x => x.h).join(' '));
  console.log('bytes        :', seen.map(x => x.n).join(' '));
  const uniq = [...new Set(seen.map(x => x.h))];
  console.log(`unique       : ${uniq.length} over ${N} fetches`);
  // wrap check: does fetch i+period equal fetch i?
  const period = uniq.length;
  let wraps = true, checked = 0;
  for (let i = 0; i + period < seen.length; i++) { checked++; if (seen[i].h !== seen[i + period].h) wraps = false; }
  console.log(`wrap period  : ${period} — sequence repeats exactly: ${wraps} (${checked} pairs checked)`);
})();
