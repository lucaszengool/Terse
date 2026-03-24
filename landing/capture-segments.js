const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const BASE_DIR = path.join(__dirname, 'gif-segments');
const HTML_FILE = `file://${path.join(__dirname, 'promo-video-v2-en.html')}`;

// Each segment = one separate GIF with its own name
const SEGMENTS = [
  {
    name: '01-app-reveal',
    label: 'App Reveal — Now Available',
    steps: [{ step: 0, captures: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000] }],
  },
  {
    name: '02-mac-desktop',
    label: 'Mac Desktop — Apps Running',
    steps: [{ step: 1, captures: [400, 800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4500, 5000] }],
  },
  {
    name: '03-zoom-terse',
    label: 'Zoom Into Terse Icon',
    steps: [{ step: 2, captures: [400, 900, 1400, 1900, 2400, 2900, 3400, 4000, 4500, 5000] }],
  },
  {
    name: '04-3d-tilt',
    label: 'Desktop Tilts to 3D',
    steps: [
      { step: 3, captures: [400, 1000, 1600, 2200, 2800, 3400, 4000, 4500, 5000] },
    ],
  },
  {
    name: '05-chrome-optimization',
    label: 'Chrome — Token Optimization',
    steps: [
      { step: 4, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400, 4800, 5200] },
    ],
  },
  {
    name: '06-terse-monitor',
    label: 'Terse — Live Session Activity',
    steps: [
      { step: 5, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4500] },
    ],
  },
  {
    name: '07-terminal-agent',
    label: 'Terminal — Claude Code Agent Monitor',
    steps: [
      { step: 6, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4500, 5000] },
      { step: 7, captures: [500, 1000] },
    ],
  },
  {
    name: '08-openclaw',
    label: 'OpenClaw — Auto Optimize',
    steps: [
      { step: 8, captures: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4500] },
      { step: 9, captures: [500, 1000] },
    ],
  },
  {
    name: '09-final',
    label: 'Final — Save Every Token',
    steps: [{ step: 10, captures: [400, 900, 1400, 1900, 2400, 2900, 3400, 3900, 4400, 5000] }],
  },
];

async function main() {
  // Clean/create base dir
  if (fs.existsSync(BASE_DIR)) fs.rmSync(BASE_DIR, { recursive: true });
  fs.mkdirSync(BASE_DIR);

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--window-size=1920,1080'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
  });

  const page = await browser.newPage();

  for (const seg of SEGMENTS) {
    console.log(`\n━━━ ${seg.label} ━━━`);

    // Reload page fresh for each segment
    await page.goto(HTML_FILE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => { auto = false; clearTimeout(tmr); });

    // If this segment doesn't start at step 0, fast-forward
    const firstStep = seg.steps[0].step;
    if (firstStep > 0) {
      for (let i = 0; i < firstStep; i++) {
        await page.evaluate((n) => go(n), i);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const segDir = path.join(BASE_DIR, seg.name);
    fs.mkdirSync(segDir);

    let frameNum = 0;
    for (const stepPlan of seg.steps) {
      await page.evaluate((n) => go(n), stepPlan.step);

      for (const delay of stepPlan.captures) {
        await new Promise(r => setTimeout(r, delay));
        try {
          const framePath = path.join(segDir, `frame_${String(frameNum).padStart(4, '0')}.png`);
          await page.screenshot({ path: framePath });
          frameNum++;
        } catch (e) {
          console.log(`  Skipped frame (error)`);
        }
        await new Promise(r => setTimeout(r, 80));
      }
    }

    console.log(`  ${frameNum} frames captured`);

    // Create GIF for this segment
    const gifPath = path.join(BASE_DIR, `${seg.name}.gif`);
    try {
      execSync(`ffmpeg -y -framerate 2.5 -i "${segDir}/frame_%04d.png" -vf "fps=2.5,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${gifPath}"`, { stdio: 'pipe' });
      const size = (fs.statSync(gifPath).size / 1024).toFixed(0);
      console.log(`  ✓ ${seg.name}.gif (${size}KB)`);
    } catch (e) {
      console.log(`  ✗ Failed to create GIF: ${e.message}`);
    }
  }

  await browser.close();

  // Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('All segments created:\n');
  const files = fs.readdirSync(BASE_DIR).filter(f => f.endsWith('.gif')).sort();
  for (const f of files) {
    const size = (fs.statSync(path.join(BASE_DIR, f)).size / 1024).toFixed(0);
    console.log(`  ${f} (${size}KB)`);
  }
  console.log(`\nLocation: ${BASE_DIR}/`);
}

main().catch(console.error);
