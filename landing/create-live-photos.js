const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const OUT_DIR = path.join(__dirname, 'live-photos');
const HTML_FILE = `file://${path.join(__dirname, 'promo-video-v2-en.html')}`;

// FPS for video — 5fps x ~25 frames = ~5 seconds per Live Photo
const FPS = 5;
const FRAME_INTERVAL = 200; // ms between frames (1000/5)

// Each segment captures the FULL PROCESS by stepping through multiple steps
// and capturing continuously at 5fps
const SEGMENTS = [
  {
    name: '01-reveal-to-desktop',
    label: 'App reveal → Mac desktop with live apps',
    keyFrameAt: 8, // which captured frame to use as still photo
    sequence: [
      // [stepNumber, durationToCapture_ms]
      [0, 3000],  // Reveal animates in
      [1, 4000],  // Desktop appears, apps load live
    ]
  },
  {
    name: '02-zoom-into-terse',
    label: 'Terse icon glows → camera zooms in',
    keyFrameAt: 10,
    sequence: [
      [2, 5000],  // Terse pulses, zoom into icon
    ]
  },
  {
    name: '03-tilt-to-3d',
    label: 'Desktop tilts into 3D → Chrome rises',
    keyFrameAt: 12,
    sequence: [
      [3, 5000],  // Desktop tilts, chrome floats up
    ]
  },
  {
    name: '04-chrome-optimization',
    label: 'Chrome window shows Terse token optimization',
    keyFrameAt: 15,
    sequence: [
      [4, 5500],  // Chrome optimization animation: typos, pipeline, -68%
    ]
  },
  {
    name: '05-terse-sessions',
    label: 'Terse window shows live session monitoring',
    keyFrameAt: 10,
    sequence: [
      [5, 4000],  // Terse floats up, live activity feed
    ]
  },
  {
    name: '06-terminal-agent',
    label: 'Terminal shows Claude Code agent monitoring',
    keyFrameAt: 15,
    sequence: [
      [6, 5000],  // Terminal up, agent monitor, stats
      [7, 1500],  // Terminal goes back down
    ]
  },
  {
    name: '07-openclaw-auto',
    label: 'OpenClaw auto-optimization in action',
    keyFrameAt: 12,
    sequence: [
      [8, 4500],  // OpenClaw up, auto-optimize
      [9, 1500],  // OpenClaw goes down
    ]
  },
  {
    name: '08-final',
    label: 'Save every token — terseai.org',
    keyFrameAt: 12,
    sequence: [
      [10, 5000], // Final screen animates in
    ]
  },
];

async function captureSegment(browser, seg) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(HTML_FILE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { auto = false; clearTimeout(tmr); });

  // Fast-forward to the step BEFORE our first step
  const firstStep = seg.sequence[0][0];
  if (firstStep > 0) {
    for (let i = 0; i < firstStep; i++) {
      await page.evaluate((n) => go(n), i);
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const tmpDir = path.join(OUT_DIR, `${seg.name}-tmp`);
  fs.mkdirSync(tmpDir, { recursive: true });

  let frameNum = 0;

  // Capture continuously through each step
  for (const [stepNum, duration] of seg.sequence) {
    // Trigger the step
    await page.evaluate((n) => go(n), stepNum);

    // Capture at FPS rate for the duration
    const numFrames = Math.ceil(duration / FRAME_INTERVAL);
    for (let i = 0; i < numFrames; i++) {
      await new Promise(r => setTimeout(r, FRAME_INTERVAL));
      try {
        await page.screenshot({
          path: path.join(tmpDir, `f_${String(frameNum).padStart(4, '0')}.png`)
        });
        frameNum++;
      } catch (e) { /* skip */ }
    }
  }

  console.log(`  ${frameNum} frames (~${(frameNum / FPS).toFixed(1)}s)`);

  // Save key frame as JPG
  const keyIdx = Math.min(seg.keyFrameAt, frameNum - 1);
  const jpgPath = path.join(OUT_DIR, `${seg.name}.jpg`);
  const keyPng = path.join(tmpDir, `f_${String(keyIdx).padStart(4, '0')}.png`);
  if (fs.existsSync(keyPng)) {
    // Convert PNG to JPG using sips
    execSync(`sips -s format jpeg -s formatOptions 95 "${keyPng}" --out "${jpgPath}"`, { stdio: 'pipe' });
  }

  // Create MOV
  const movPath = path.join(OUT_DIR, `${seg.name}.mov`);
  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${tmpDir}/f_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 -vf "scale=1920:-2" -movflags +faststart "${movPath}"`,
    { stdio: 'pipe' }
  );

  // Make Live Photo pair
  execSync(
    `python3 -c "from makelive.makelive import make_live_photo; make_live_photo('${jpgPath}', '${movPath}')"`,
    { stdio: 'pipe' }
  );

  const jpgSize = (fs.statSync(jpgPath).size / 1024).toFixed(0);
  const movSize = (fs.statSync(movPath).size / 1024).toFixed(0);
  console.log(`  ✓ ${seg.name}.jpg (${jpgSize}KB) + .mov (${movSize}KB)`);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  await page.close();
}

async function main() {
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR);

  console.log('Launching browser...\n');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--window-size=1920,1080']
  });

  for (const seg of SEGMENTS) {
    console.log(`━━━ ${seg.name}: ${seg.label} ━━━`);
    try {
      await captureSegment(browser, seg);
    } catch (e) {
      console.log(`  ✗ ${e.message.split('\n')[0]}`);
    }
  }

  await browser.close();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Live Photos:\n');
  const files = fs.readdirSync(OUT_DIR).sort();
  for (const f of files) {
    const sz = (fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0);
    console.log(`  ${f} (${sz}KB)`);
  }
  console.log(`\n→ Import all into Apple Photos`);
  console.log(`  ${OUT_DIR}/`);
}

main().catch(console.error);
