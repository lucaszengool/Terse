import puppeteer from 'puppeteer';
import fs from 'fs';

const DIR = process.env.DIR || '/private/tmp/wpframes';
const PORT = process.env.PORT || '8791';
const THEME = process.env.THEME || 'indigo';
const SECS = parseInt(process.env.SECS || '16', 10);
const SHOT = process.env.SHOT || (DIR + '/_verify.png');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const launch = (headless) => puppeteer.launch({
  headless,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1960,1140',
    '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-swiftshader',
    '--use-angle=default', '--hide-scrollbars'],
});

let browser;
try { browser = await launch(false); } catch (e) { console.log('headful failed:', e.message); browser = await launch('new'); }
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on('console', m => { const t = m.text(); if (/error|exception/i.test(t)) console.log('PAGE:', t); });

await page.goto(`http://localhost:${PORT}/_cap_wp.html?theme=${THEME}`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction('window.__ready===true', { timeout: 25000 });
await new Promise(r => setTimeout(r, 4000));   // warm up

await page.screenshot({ path: SHOT });          // verify it's rendering
console.log('verify shot saved');

const client = await page.target().createCDPSession();
let n = 0;
client.on('Page.screencastFrame', async ({ data, sessionId }) => {
  const idx = String(n++).padStart(4, '0');
  fs.writeFileSync(`${DIR}/f${idx}.jpg`, Buffer.from(data, 'base64'));
  try { await client.send('Page.screencastFrameAck', { sessionId }); } catch (e) {}
});
await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
console.log('recording', SECS, 's …');
await new Promise(r => setTimeout(r, SECS * 1000));
await client.send('Page.stopScreencast');
await new Promise(r => setTimeout(r, 500));
await browser.close();
console.log('DONE frames=', n, 'fps~', (n / SECS).toFixed(1));
