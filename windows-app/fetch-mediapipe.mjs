#!/usr/bin/env node
/**
 * fetch-mediapipe.mjs — put MediaPipe's hand landmarker where the Windows build
 * embeds it: src/renderer/vendor/mediapipe/.
 *
 * Why fetched and not committed: it is ~20 MB (an 11.7 MB wasm and a 7.8 MB
 * model), it is needed by the Windows build only, and src/renderer is the
 * frontend of BOTH builds — committing it would ship 20 MB of dead weight
 * inside every macOS app too.
 *
 * Why fetched at build time and not at runtime: storage.googleapis.com is
 * unreachable from mainland China, where a large share of users are. A tracker
 * that downloads its model on first use would simply never start for them, with
 * nothing on screen to say why.
 *
 * Every file is pinned by SHA-256. A mismatch fails the build rather than
 * shipping something unverified — and a missing file fails it too, loudly,
 * because a tracker page whose model is absent loads fine and then reports an
 * error nobody is looking at.
 *
 * Idempotent: files already present with the right hash are left alone.
 * Usage: node windows-app/fetch-mediapipe.mjs   (from the repo root)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'renderer', 'vendor', 'mediapipe');

const VERSION = '1.0.1';
const TARBALL = `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-${VERSION}.tgz`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Only the SIMD build. WebView2 is current Chromium, which always has wasm
// SIMD; the nosimd and module variants would add 22 MB for no reader.
const FROM_TARBALL = {
  'package/vision_bundle.mjs': ['vision_bundle.mjs', 'd885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f'],
  'package/wasm/vision_wasm_internal.js': ['wasm/vision_wasm_internal.js', 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73'],
  'package/wasm/vision_wasm_internal.wasm': ['wasm/vision_wasm_internal.wasm', '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886'],
};
const MODEL_FILE = ['hand_landmarker.task', 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const have = (rel, want) => { const p = join(OUT, rel); return existsSync(p) && sha(readFileSync(p)) === want; };
const put = (rel, buf, want) => {
  const got = sha(buf);
  if (got !== want) throw new Error(`${rel}: sha256 ${got}, expected ${want} — refusing to ship an unverified file`);
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  console.log(`  wrote ${rel} (${buf.length} bytes)`);
};

async function get(url) {
  if (typeof fetch !== 'function') throw new Error('Node 18+ is required (global fetch)');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** The three files we need, out of an npm tarball. A minimal ustar reader
 *  rather than shelling out to `tar`, so this behaves the same on every OS. */
function untar(buf, wanted) {
  const out = {};
  let off = 0;
  const str = (a, b) => buf.toString('utf8', off + a, off + b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const name = str(0, 100);
    if (!name) break;                                    // two zero blocks end the archive
    const prefix = str(345, 500);
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    if (wanted.has(full)) out[full] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function main() {
  console.log(`MediaPipe tasks-vision ${VERSION} → ${OUT}`);
  const need = Object.entries(FROM_TARBALL).filter(([, [rel, h]]) => !have(rel, h));
  if (need.length) {
    const files = untar(gunzipSync(await get(TARBALL)), new Set(need.map(([k]) => k)));
    for (const [key, [rel, h]] of need) {
      if (!files[key]) throw new Error(`${key} is not in the ${VERSION} tarball`);
      put(rel, files[key], h);
    }
  } else console.log('  package files already present and verified');
  if (!have(MODEL_FILE[0], MODEL_FILE[1])) put(MODEL_FILE[0], await get(MODEL), MODEL_FILE[1]);
  else console.log('  model already present and verified');
  console.log('ok');
}

main().catch((e) => { console.error('fetch-mediapipe FAILED:', e.message); process.exit(1); });
