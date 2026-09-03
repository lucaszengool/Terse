const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); await p.setViewport({ width:393, height:852, deviceScaleFactor:2 });
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  await p.goto('http://127.0.0.1:4311/float', { waitUntil:'load' });
  console.log('  visibility     :', await p.evaluate(() => document.visibilityState));
  console.log('  standalone     :', await p.evaluate(() => matchMedia('(display-mode: standalone)').matches));
  console.log('  canEncodeVideo :', await p.evaluate(() => window.TerseCapture.canEncodeVideo()));

  // A REAL click, so this exercises the page's own handler rather than a copy.
  const t0 = Date.now();
  await p.click('#go');                                   // tap 1: record
  await p.waitForFunction(() => document.getElementById('go').textContent === '开始悬浮'
      || (document.getElementById('state').className === 'bad'),
    { timeout: 300000, polling: 1000 });
  console.log('  after tap 1    :', await p.evaluate(() => document.getElementById('state').textContent));
  console.log('  button now     :', await p.evaluate(() => document.getElementById('go').textContent));
  await p.click('#go');                                   // tap 2: float — a FRESH gesture
  await p.waitForFunction(() => document.getElementById('state').textContent.length > 0
      && document.getElementById('go').textContent !== '开始悬浮'
      || document.getElementById('state').className === 'bad'
      || document.getElementById('go').hidden,
    { timeout: 30000, polling: 500 });

  const r = await p.evaluate(() => {
    const v = document.getElementById('vid');
    return { state: document.getElementById('state').textContent,
             cls: document.getElementById('state').className,
             src: (v.src || '').slice(0, 12),
             duration: v.duration, w: v.videoWidth, h: v.videoHeight,
             paused: v.paused, loop: v.loop,
             visible: !v.classList.contains('hide'),
             rect: (() => { const b = v.getBoundingClientRect(); return b.width + 'x' + Math.round(b.height); })(),
             // THE ASSERTION THAT MATTERS: did it actually enter, or did the
             // page just say so?
             reallyInPiP: document.pictureInPictureElement === v
                       || v.webkitPresentationMode === 'picture-in-picture' };
  });
  console.log('  encode+play    :', ((Date.now()-t0)/1000).toFixed(1) + 's');
  console.log('  state          :', JSON.stringify(r.state));
  console.log('  video src      :', r.src, ' size', r.w + 'x' + r.h, ' duration', r.duration);
  console.log('  playing        :', r.paused === false, ' loop', r.loop);
  console.log('  video visible  :', r.visible, ' laid out at', r.rect);
  console.log('  REALLY in PiP  :', r.reallyInPiP);
  console.log('  claim matches  :', r.reallyInPiP === /浮起来了/.test(r.state) ? 'yes' : 'NO — the page is lying');
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
