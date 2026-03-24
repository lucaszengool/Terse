const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const OUT_DIR = path.join(__dirname, 'gif-final');
const HTML_FILE = `file://${path.join(__dirname, 'promo-video-v2-en.html')}`;

const SEGMENTS = [
  {
    name: '01-app-reveal',
    caption: 'Terse — Now Available on App Store',
    steps: [{ step: 0, captures: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000] }],
  },
  {
    name: '02-mac-desktop',
    caption: 'Monitors all your AI apps in real time',
    steps: [{ step: 1, captures: [400, 800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4500, 5000] }],
  },
  {
    name: '03-zoom-terse',
    caption: 'One click to activate',
    steps: [{ step: 2, captures: [400, 900, 1400, 1900, 2400, 2900, 3400, 4000, 4500, 5000] }],
  },
  {
    name: '04-3d-tilt',
    caption: 'See how Terse works across every app',
    steps: [{ step: 3, captures: [400, 1000, 1600, 2200, 2800, 3400, 4000, 4500, 5000] }],
  },
  {
    name: '05-chrome-optimization',
    caption: 'Fixes typos, removes filler — 68% tokens saved',
    steps: [{ step: 4, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400, 4800, 5200] }],
  },
  {
    name: '06-terse-monitor',
    caption: 'Tracks sessions across Chrome, Claude Code, OpenClaw',
    steps: [{ step: 5, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4500] }],
  },
  {
    name: '07-terminal-agent',
    caption: 'Catches duplicates, compresses output — 99% reduction',
    steps: [
      { step: 6, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4500, 5000] },
      { step: 7, captures: [500, 1000] },
    ],
  },
  {
    name: '08-openclaw',
    caption: 'Auto-optimizes every message before sending',
    steps: [
      { step: 8, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4500] },
      { step: 9, captures: [500, 1000] },
    ],
  },
  {
    name: '09-final',
    caption: 'Save every token — terseai.org',
    steps: [{ step: 10, captures: [400, 900, 1400, 1900, 2400, 2900, 3400, 3900, 4400, 5000] }],
  },
];

async function main() {
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR);

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--window-size=1920,1080'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
  });

  const page = await browser.newPage();

  for (const seg of SEGMENTS) {
    console.log(`\n━━━ ${seg.caption} ━━━`);

    // Reload fresh
    await page.goto(HTML_FILE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => { auto = false; clearTimeout(tmr); });

    // Add caption bar overlay
    await page.evaluate((caption) => {
      const bar = document.createElement('div');
      bar.id = 'captionBar';
      bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:14px 0;text-align:center;background:linear-gradient(transparent,rgba(0,0,0,.4));pointer-events:none';
      bar.innerHTML = `<span style="font-family:Inter,-apple-system,sans-serif;font-size:18px;font-weight:600;color:#fff;letter-spacing:.5px;text-shadow:0 1px 4px rgba(0,0,0,.3)">${caption}</span>`;
      document.body.appendChild(bar);
    }, seg.caption);

    // Fast-forward to the right starting step
    const firstStep = seg.steps[0].step;
    if (firstStep > 0) {
      for (let i = 0; i < firstStep; i++) {
        await page.evaluate((n) => go(n), i);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const framesDir = path.join(OUT_DIR, `${seg.name}-frames`);
    fs.mkdirSync(framesDir);

    let frameNum = 0;
    for (const stepPlan of seg.steps) {
      await page.evaluate((n) => go(n), stepPlan.step);

      for (const delay of stepPlan.captures) {
        await new Promise(r => setTimeout(r, delay));
        try {
          const framePath = path.join(framesDir, `frame_${String(frameNum).padStart(4, '0')}.png`);
          await page.screenshot({ path: framePath });
          frameNum++;
        } catch (e) { /* skip */ }
        await new Promise(r => setTimeout(r, 80));
      }
    }

    console.log(`  ${frameNum} frames`);

    // Create GIF
    const gifPath = path.join(OUT_DIR, `${seg.name}.gif`);
    try {
      execSync(
        `ffmpeg -y -framerate 2.5 -i "${framesDir}/frame_%04d.png" -vf "fps=2.5,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${gifPath}"`,
        { stdio: 'pipe' }
      );
      const size = (fs.statSync(gifPath).size / 1024).toFixed(0);
      console.log(`  ✓ ${seg.name}.gif (${size}KB)`);
    } catch (e) {
      console.log(`  ✗ GIF failed`);
    }

    // Cleanup frame PNGs
    fs.rmSync(framesDir, { recursive: true });
  }

  await browser.close();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('All captioned GIFs:\n');
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.gif')).sort();
  for (const f of files) {
    const size = (fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0);
    console.log(`  ${f} (${size}KB)`);
  }
  console.log(`\nLocation: ${OUT_DIR}/`);
}

main().catch(console.error);
