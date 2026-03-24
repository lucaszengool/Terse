const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const FRAMES_DIR = path.join(__dirname, 'gif-frames');
const HTML_FILE = `file://${path.join(__dirname, 'promo-video-v2-en.html')}`;
const OUTPUT_GIF = path.join(__dirname, 'promo-video.gif');
const OUTPUT_MP4 = path.join(__dirname, 'promo-video.mp4');

// Each step: [stepIndex, delayBeforeCapture(ms), capturesCount, intervalMs]
// We capture multiple frames per step to show animation progression
const CAPTURE_PLAN = [
  // Step 0: Reveal — "Now Available" (~4s, 8 frames)
  { step: 0, captures: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000] },
  // Step 1: Mac Desktop with live apps (~5s, 8 frames)
  { step: 1, captures: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4500] },
  // Step 2: Terse icon pulses + zoom (~4s, 7 frames)
  { step: 2, captures: [400, 900, 1400, 1900, 2400, 2900, 3500] },
  // Step 3: Desktop tilts + Chrome rises (~4s, 6 frames)
  { step: 3, captures: [500, 1200, 1800, 2400, 3000, 3500] },
  // Step 4: Chrome optimization animation (~5s, 8 frames)
  { step: 4, captures: [500, 1200, 1800, 2400, 3000, 3600, 4200, 5000] },
  // Step 5: Terse floats up, live activity (~4s, 7 frames)
  { step: 5, captures: [400, 1000, 1500, 2000, 2500, 3000, 3500] },
  // Step 6: Terminal floats up, agent monitor (~5s, 8 frames)
  { step: 6, captures: [500, 1200, 1800, 2400, 3000, 3600, 4200, 4800] },
  // Step 7: Terminal goes down (~1.5s, 3 frames)
  { step: 7, captures: [400, 800, 1200] },
  // Step 8: OpenClaw floats up (~4s, 7 frames)
  { step: 8, captures: [500, 1100, 1700, 2300, 2900, 3500, 4000] },
  // Step 9: OpenClaw goes down (~1.5s, 3 frames)
  { step: 9, captures: [400, 800, 1200] },
  // Step 10: Final — Save Every Token (~5s, 8 frames)
  { step: 10, captures: [400, 1000, 1600, 2200, 2800, 3400, 4000, 4500] },
];

async function main() {
  // Clean/create frames dir
  if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR);

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--window-size=1920,1080'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
  });

  const page = await browser.newPage();
  await page.goto(HTML_FILE, { waitUntil: 'networkidle0' });

  // Disable autoplay so we control stepping
  await page.evaluate(() => {
    auto = false;
    clearTimeout(tmr);
  });

  let frameNum = 0;

  for (const plan of CAPTURE_PLAN) {
    console.log(`Step ${plan.step}...`);

    // Trigger step
    await page.evaluate((n) => go(n), plan.step);

    // Capture at each specified delay
    for (const delay of plan.captures) {
      await new Promise(r => setTimeout(r, delay));
      try {
        const framePath = path.join(FRAMES_DIR, `frame_${String(frameNum).padStart(4, '0')}.png`);
        await page.screenshot({ path: framePath });
        console.log(`  Frame ${frameNum} captured at +${delay}ms`);
        frameNum++;
      } catch(e) {
        console.log(`  Frame ${frameNum} skipped (error)`);
      }
      // Small pause to let browser breathe
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await browser.close();
  console.log(`\n${frameNum} frames captured.`);

  // Check if ffmpeg is available
  try {
    execSync('which ffmpeg');
  } catch {
    console.log('ffmpeg not found. Install it with: brew install ffmpeg');
    console.log('Then run:');
    console.log(`ffmpeg -framerate 4 -i ${FRAMES_DIR}/frame_%04d.png -vf "fps=4,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" ${OUTPUT_GIF}`);
    return;
  }

  // Create GIF with good quality
  console.log('\nCreating GIF...');
  execSync(`ffmpeg -y -framerate 2.5 -i "${FRAMES_DIR}/frame_%04d.png" -vf "fps=2.5,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${OUTPUT_GIF}"`, { stdio: 'inherit' });

  const gifSize = (fs.statSync(OUTPUT_GIF).size / 1024 / 1024).toFixed(1);
  console.log(`\nGIF created: ${OUTPUT_GIF} (${gifSize}MB)`);

  // Also create MP4 (smaller, better quality)
  console.log('Creating MP4...');
  execSync(`ffmpeg -y -framerate 2.5 -i "${FRAMES_DIR}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 23 -preset medium -vf "scale=1920:-2" "${OUTPUT_MP4}"`, { stdio: 'inherit' });

  const mp4Size = (fs.statSync(OUTPUT_MP4).size / 1024 / 1024).toFixed(1);
  console.log(`MP4 created: ${OUTPUT_MP4} (${mp4Size}MB)`);

  console.log('\nDone! Files:');
  console.log(`  GIF: ${OUTPUT_GIF}`);
  console.log(`  MP4: ${OUTPUT_MP4}`);
}

main().catch(console.error);
