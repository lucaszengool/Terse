const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
  const p = await b.newPage(); await p.setViewport({ width:393, height:852, deviceScaleFactor:3 });
  await p.goto('http://127.0.0.1:4311/_probe.html', { waitUntil:'load' });
  await p.waitForFunction(() => window.__ready === true, { timeout:20000 });
  const r = await p.evaluate(() => window.probe());
  console.log('frames        :', r.n, r.w + 'x' + r.h);
  console.log('scores        :', r.scores.map(v => v.toFixed(4)).join(' '));
  console.log('scores is array of', r.scores.length, '— was', typeof undefined, 'before');
  const max = Math.max(...r.scores);
  console.log('max score     :', max.toFixed(4));
  console.log('floor         : 0.0500');
  console.log('guard fires?  :', max < 0.05 ? 'YES (would warn)' : 'no (reports success)');
  await b.close();
})();
