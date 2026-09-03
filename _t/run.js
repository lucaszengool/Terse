/* Drive the REAL capture.js in a real browser, then assert the ring. */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
           '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 3 });
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  page.on('console', m => { const t = m.text(); if (/error|fail|warn/i.test(t)) console.log('  [console]', t.slice(0,200)); });

  await page.goto('http://127.0.0.1:4311/_e2e.html', { waitUntil: 'load' });

  console.log('visibilityState:', await page.evaluate(() => document.visibilityState));
  console.log('webgl:', await page.evaluate(() => {
    const c = document.createElement('canvas');
    return (c.getContext('webgl2') ? 'webgl2' : c.getContext('webgl') ? 'webgl1' : 'NONE');
  }));

  await page.evaluate(() => window.runE2E(12));
  await page.waitForFunction(() => window.E2E.state === 'done' || window.E2E.state === 'error',
    { timeout: 240000, polling: 1000 });

  const r = await page.evaluate(() => ({ state: E2E.state, error: E2E.error, log: E2E.log,
    hashes: E2E.hashes, landed: E2E.landed, count: E2E.count, status: E2E.status }));
  console.log('\n--- harness log ---\n' + (r.log || []).join('\n'));
  console.log('\nstate:', r.state, r.error || '');
  await browser.close();
  require('fs').writeFileSync(__dirname + '/result.json', JSON.stringify(r, null, 1));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
