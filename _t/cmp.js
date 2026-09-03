const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless:false, args:['--no-sandbox','--window-size=420,900','--window-position=2200,2200'] });
  const p = await b.newPage(); await p.setViewport({ width:393, height:852, deviceScaleFactor:3 });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto('http://127.0.0.1:4311/_cmp.html', { waitUntil:'load' });
  await p.waitForFunction(() => typeof window.cmp === 'function', { timeout:20000 });
  for (const [w,h] of [[393,852],[1290,2796]]) {
    await p.evaluate((w,h)=>window.cmp(w,h), w, h);
    await p.waitForFunction(n => window.__log.length >= n, {timeout:60000}, (await p.evaluate(()=>window.__log.length)));
  }
  await new Promise(r=>setTimeout(r,1000));
  console.log((await p.evaluate(()=>window.__log)).join('\n'));
  await b.close();
})();
