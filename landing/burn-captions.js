const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = path.join(__dirname, 'gif-segments');
const OUT = path.join(__dirname, 'gif-final');

if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
fs.mkdirSync(OUT);

const SEGMENTS = [
  { file: '01-app-reveal', caption: 'Terse — Now Available on App Store' },
  { file: '02-mac-desktop', caption: 'Monitors all your AI apps in real time' },
  { file: '03-zoom-terse', caption: 'One click to activate' },
  { file: '04-3d-tilt', caption: 'See how Terse works across every app' },
  { file: '05-chrome-optimization', caption: 'Fixes typos, removes filler — 68% tokens saved' },
  { file: '06-terse-monitor', caption: 'Tracks sessions across Chrome, Claude Code, OpenClaw' },
  { file: '07-terminal-agent', caption: 'Catches duplicates, compresses output — 99% reduction' },
  { file: '08-openclaw', caption: 'Auto-optimizes every message before sending' },
  { file: '09-final', caption: 'Save every token — terseai.org' },
];

for (const seg of SEGMENTS) {
  const input = path.join(BASE, `${seg.file}.gif`);
  const output = path.join(OUT, `${seg.file}.gif`);

  if (!fs.existsSync(input)) {
    console.log(`✗ Missing: ${seg.file}.gif`);
    continue;
  }

  // Caption bar: semi-transparent dark bar at bottom with white text
  const drawtext = `drawtext=text='${seg.caption.replace(/'/g, "\\'")}':fontsize=22:fontcolor=white:fontfile=/System/Library/Fonts/Helvetica.ttc:x=(w-text_w)/2:y=h-45:box=1:boxcolor=black@0.55:boxborderw=12`;

  try {
    execSync(
      `ffmpeg -y -i "${input}" -vf "${drawtext},split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${output}"`,
      { stdio: 'pipe' }
    );
    const size = (fs.statSync(output).size / 1024).toFixed(0);
    console.log(`✓ ${seg.file}.gif (${size}KB) — "${seg.caption}"`);
  } catch (e) {
    // Try without fontfile if it fails
    try {
      const drawtext2 = `drawtext=text='${seg.caption.replace(/'/g, "\\'")}':fontsize=22:fontcolor=white:x=(w-text_w)/2:y=h-45:box=1:boxcolor=black@0.55:boxborderw=12`;
      execSync(
        `ffmpeg -y -i "${input}" -vf "${drawtext2},split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${output}"`,
        { stdio: 'pipe' }
      );
      const size = (fs.statSync(output).size / 1024).toFixed(0);
      console.log(`✓ ${seg.file}.gif (${size}KB) — "${seg.caption}"`);
    } catch (e2) {
      console.log(`✗ Failed: ${seg.file} — ${e2.stderr?.toString().split('\n').pop()}`);
    }
  }
}

console.log(`\nDone! Files in: ${OUT}/`);
