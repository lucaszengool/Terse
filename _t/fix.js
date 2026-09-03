const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless:false, args:['--no-sandbox','--window-size=420,900','--window-position=2200,2200'] });
  const p = await b.newPage(); await p.setViewport({ width:393, height:852, deviceScaleFactor:3 });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto('http://127.0.0.1:4311/_cmp.html', { waitUntil:'load' });
  await p.waitForFunction(() => typeof window.fix === 'function', { timeout:20000 });
  // css box = a real iPhone's CSS size; buffer = the full wallpaper resolution
  await p.evaluate(() => window.fix(430, 932, 1290, 2796, 26));
  await p.evaluate(() => window.fix(430, 932, 1290, 2796, 56));
  // the CURRENT behaviour, for the control
  await p.evaluate(() => window.fix(1290, 2796, 1290, 2796, 56));
  console.log((await p.evaluate(()=>window.__log)).join('\n'));
  await b.close();
})();
