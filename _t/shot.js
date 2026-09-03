const fs = require('fs'), puppeteer = require('puppeteer');
(async () => {
  const GPU = process.env.GPU === '1';
  const b = await puppeteer.launch({
    headless: GPU ? false : 'new',
    args: GPU
      ? ['--no-sandbox','--disable-dev-shm-usage','--window-size=420,900','--window-position=2000,2000']
      : ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 393, height: 852, deviceScaleFactor: 3 });
  await p.goto('http://127.0.0.1:4311/_e2e.html', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__hudReady === true, { timeout: 20000 });
  const ACT = process.env.ACT ? parseFloat(process.env.ACT) : null;
  await p.evaluate(a => { window.__ACT = a; }, ACT);
  if (process.env.NORESIZE === '1') await p.evaluate(() => { window.__NORESIZE = true; });
  const r = await p.evaluate(async () => {
    const ov = window.buildOverlays({
      stats: { tokens_today: 184320, tokens_saved: 41230, saved_pct: 22 },
      sessions: [ { name:'claude-opus', tool:'claude', rate:1240, saved_pct:24 },
                  { name:'sweep-runner', tool:'codex', rate:610, saved_pct:18 },
                  { name:'dsh', tool:'deepseek', rate:320, saved_pct:31 } ],
      tokens: 184320, t: (k, fb) => fb || k });
    if (window.__ACT != null) ov.activity = window.__ACT;
    const texts = [];
    (ov.stage||[]).forEach(it => texts.push(((it.v!=null?it.v:'')+' '+(it.u||'')).trim()));
    (ov.agents||[]).forEach(a => { if (a.rate) texts.push(a.name); });
    window.__ov = { stage:(ov.stage||[]).length, agents:(ov.agents||[]).length,
                    logGroups:(ov.logGroups||[]).length, activity: ov.activity };
    const out = await window.TerseCapture.capture({ count: 4, bedId: 'dusk',
      overlays: ov, texts: texts.filter(Boolean) });
    const b64 = [];
    for (const bl of out.blobs) {
      b64.push(await new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result.split(',')[1]); f.readAsDataURL(bl); }));
    }
    return { b64, w: out.width, h: out.height, score: out.score, ov: window.__ov };
  });
  r.b64.forEach((s, i) => fs.writeFileSync(`${__dirname}/act${process.env.ACT||'auto'}-frame${i+1}.jpg`, Buffer.from(s, 'base64')));
  console.log('renderer:', await p.evaluate(() => { const c=document.createElement('canvas'); const g=c.getContext('webgl2')||c.getContext('webgl'); const d=g&&g.getExtension('WEBGL_debug_renderer_info'); return d? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; }));
  console.log('overlays:', JSON.stringify(r.ov));
  console.log('saved', r.b64.length, 'frames', r.w+'x'+r.h, 'score', r.score);
  await b.close();
})();
