/**
 * Seed the plaza with 100 projects, so a first-time visitor has something to
 * scroll instead of an empty room.
 *
 *   node api/seed-projects.js           # insert (idempotent — same ids each run)
 *   node api/seed-projects.js --clear   # remove them all again
 *
 * WHY THESE ARE GENERATED AND NOT COPIED. A capsule is parameters, not pixels:
 * directory names and sizes, a commit skyline, a dependency graph, a language
 * mix. Every one of those is a number, so a hundred plausible ones can be made
 * here — and each still renders as a real code city on the viewer's own machine
 * through exactly the path a real capsule takes. Nothing about the render is
 * special-cased for seeds.
 *
 * ⚠ THEY ARE MARKED. Every seed identity is derived from SEED_SALT and every id
 * starts with `wp_seed_`, so --clear can take them all back out without
 * touching anything a person published. A demo you cannot un-demo is a mess
 * somebody else has to clean up.
 *
 * ⚠ The covers are generated too — a tiny PNG written by hand rather than a
 * stock photo. A hundred real screenshots would be megabytes in the database
 * and on every listing fetch, and the point of the cover here is that it
 * GATHERS out of the particles: a soft two-colour field does that as well as a
 * photograph and costs about a kilobyte.
 */
const crypto = require('crypto');
const zlib = require('zlib');
const db = require('./db');

const SEED_SALT = 'terse-plaza-seed-v1';
const COUNT = 100;

/* ── A minimal PNG writer ─────────────────────────────────────────────────
   No dependency, no binary blobs checked into the repo. Writes an 8-bit RGB
   image: signature, IHDR, one deflated IDAT (each row prefixed with a zero
   filter byte, which is what the spec calls "None"), IEND. */
function png(width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                                   // filter: None
    for (let x = 0; x < width; x++) {
      const c = rgbAt(x / (width - 1), y / (height - 1));
      raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};

/** A soft two-colour field, 96px — enough for the sampler, ~1KB on the wire. */
function cover(hue) {
  const buf = png(96, 72, (u, v) => {
    const t = (u * 0.65 + v * 0.35);
    const c1 = hsl(hue, 0.62, 0.52), c2 = hsl((hue + 48) % 360, 0.55, 0.24);
    return [0, 1, 2].map((i) => Math.round(c1[i] * (1 - t) + c2[i] * t));
  });
  return 'data:image/png;base64,' + buf.toString('base64');
}

/* ── The material ─────────────────────────────────────────────────────────
   Names and blurbs that read like real repositories, because the feed is
   supposed to look like a place where people publish work. */
const NOUNS = ['forge', 'atlas', 'harbor', 'lantern', 'quarry', 'beacon', 'ledger', 'prism',
  'anvil', 'thicket', 'cadence', 'meridian', 'kestrel', 'basalt', 'tundra', 'ember',
  'orbit', 'satchel', 'willow', 'cobalt', 'drift', 'foundry', 'glimpse', 'harvest'];
const QUALS = ['tiny', 'fast', 'quiet', 'plain', 'sharp', 'warm', 'lean', 'bright'];
const KINDS = ['cli', 'kit', 'db', 'ui', 'api', 'lab', 'fs', 'net', 'ml', 'sh'];
const BLURBS = [
  'a build cache that never lies about a hit',
  'markdown to slides, one file in, one file out',
  'the log viewer I stopped complaining about',
  'type-safe migrations without the ceremony',
  'a scheduler that survives its own restart',
  'reads your dotfiles, tells you what is dead',
  'diffing JSON so a human can read it',
  'streaming CSV that fits in memory',
  'a router with no runtime dependencies',
  'screenshot tests that do not flake',
  'a key-value store you can grep',
  'turns traces into a flame graph offline',
  'HTTP mocking for tests that mean it',
  'one binary, every clipboard on every OS',
  'a queue that admits when it is full',
  'incremental parser for a language you use',
  'password rotation without a spreadsheet',
  'a terminal that draws its own charts',
  'shrinking docker images by looking at them',
  'a linter that explains itself',
];
const LANGS = [
  [['TypeScript', 0.71], ['CSS', 0.18], ['HTML', 0.11]],
  [['Rust', 0.86], ['TOML', 0.08], ['Shell', 0.06]],
  [['Python', 0.78], ['Jupyter', 0.14], ['Makefile', 0.08]],
  [['Go', 0.91], ['Shell', 0.06], ['Dockerfile', 0.03]],
  [['Swift', 0.74], ['Objective-C', 0.16], ['Ruby', 0.10]],
  [['JavaScript', 0.64], ['SCSS', 0.22], ['HTML', 0.14]],
  [['C++', 0.69], ['CMake', 0.19], ['C', 0.12]],
  [['Elixir', 0.82], ['HEEx', 0.12], ['Shell', 0.06]],
];
const DIRNAMES = ['src', 'lib', 'core', 'cli', 'server', 'web', 'ui', 'docs', 'tests',
  'scripts', 'examples', 'internal', 'pkg', 'api', 'crates', 'tools', 'assets', 'bench'];
const KIND_OF = { docs: 'docs', tests: 'test', assets: 'asset', examples: 'docs',
  scripts: 'build', tools: 'build', bench: 'test' };
const PEOPLE = ['mira', 'tomasz', 'nadia', 'ade', 'joon', 'priya', 'lukas', 'sofia',
  'wen', 'ivo', 'hana', 'diego', 'ken', 'noor', 'bea'];

/** Deterministic RNG, so re-running produces the same plaza. */
function rng(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

function makeCapsule(i) {
  const r = rng('proj-' + i);
  const name = `${pick(r, NOUNS)}-${r() < 0.45 ? pick(r, QUALS) : pick(r, KINDS)}`;
  const langs = pick(r, LANGS);
  const hue = int(r, 0, 359);

  // Buildings. Sizes span orders of magnitude, like a real tree — which is what
  // makes the log-scaled skyline worth having.
  const n = int(r, 5, 13);
  const names = [];
  while (names.length < n) { const d = pick(r, DIRNAMES); if (!names.includes(d)) names.push(d); }
  const dirs = names.map((nm) => {
    const files = int(r, 3, 240);
    return {
      name: nm,
      files,
      bytes: Math.round(files * int(r, 900, 26000)),
      kind: KIND_OF[nm] || 'code',
      langs: [[langs[0][0], 0.6 + r() * 0.4]],
      kids: [],
      churn: int(r, 1, 400),
    };
  });

  // A few dependency arcs between real buildings.
  const links = [];
  for (let k = 0; k < Math.min(10, n * 2); k++) {
    const a = int(r, 0, n - 1), b = int(r, 0, n - 1);
    if (a !== b) links.push([a, b, int(r, 1, 30)]);
  }

  // 53 weeks of commits, with a couple of busy stretches.
  const commits = [];
  for (let w = 0; w < 53; w++) {
    const hot = r() < 0.22 ? int(r, 3, 9) : 0;
    for (let d = 0; d < 7; d++) commits.push(d === 0 || d === 6 ? int(r, 0, 2) : int(r, 0, 4) + hot);
  }

  const gn = int(r, 14, 60);
  const graph = {
    n: Array.from({ length: gn }, (_, k) => `${pick(r, DIRNAMES)}/${pick(r, NOUNS)}${k}.${langs[0][0] === 'Rust' ? 'rs' : 'ts'}`),
    e: Array.from({ length: Math.round(gn * 1.4) }, () => [int(r, 0, gn - 1), int(r, 0, gn - 1)]),
  };

  const hot = Array.from({ length: int(r, 8, 24) }, () => ({
    name: `${pick(r, DIRNAMES)}/${pick(r, NOUNS)}.${langs[0][0] === 'Go' ? 'go' : 'ts'}`,
    churn: int(r, 4, 180),
    bytes: int(r, 800, 90000),
  }));

  const people = Array.from({ length: int(r, 1, 5) }, () => [pick(r, PEOPLE), int(r, 3, 900)])
    .filter((p, k, a) => a.findIndex((q) => q[0] === p[0]) === k);

  const files = dirs.reduce((a, d) => a + d.files, 0);
  return {
    v: 2,
    srcId: 'seed-' + i,
    title: name,
    subtitle: pick(r, BLURBS),
    tags: [langs[0][0].toLowerCase(), pick(r, KINDS)],
    cover: cover(hue),
    shots: [],
    lines: [`${files} files`, `${people.length} contributor${people.length > 1 ? 's' : ''}`],
    files,
    langs,
    style: '',
    dirs,
    links,
    commits,
    graph,
    hot,
    people,
  };
}

const seedIdentity = (i) =>
  crypto.createHash('sha256').update(SEED_SALT + ':' + (i % 37)).digest('hex').slice(0, 32);
const seedId = (i) => 'wp_seed_' + crypto.createHash('sha256')
  .update(SEED_SALT + ':' + i).digest('hex').slice(0, 12);

function clear() {
  const n = db.db.prepare("DELETE FROM wall_projects WHERE id LIKE 'wp_seed_%'").run().changes;
  db.db.prepare("DELETE FROM wall_reactions WHERE project_id LIKE 'wp_seed_%'").run();
  db.db.prepare("DELETE FROM wall_comments WHERE project_id LIKE 'wp_seed_%'").run();
  console.log(`removed ${n} seeded projects`);
}

function seed() {
  let bytes = 0;
  const insert = db.db.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      const cap = makeCapsule(i);
      const json = JSON.stringify(cap);
      bytes += json.length;
      db.upsertWallProject.run({
        id: seedId(i), identity: seedIdentity(i), title: cap.title, capsule: json,
      });
      // A handful of likes and saves, so the counts on a row are not all zero —
      // an empty feed and a feed nobody has touched look the same to a visitor.
      const r = rng('react-' + i);
      for (let k = 0; k < int(r, 0, 9); k++) {
        db.addWallReaction.run({ project_id: seedId(i), identity: seedIdentity(i + k + 1), kind: 'like' });
      }
      for (let k = 0; k < int(r, 0, 3); k++) {
        db.addWallReaction.run({ project_id: seedId(i), identity: seedIdentity(i + k + 11), kind: 'fav' });
      }
    }
  });
  insert();
  console.log(`seeded ${COUNT} projects, ${(bytes / 1024).toFixed(0)}KB of capsules ` +
              `(${(bytes / COUNT / 1024).toFixed(1)}KB each)`);
}

if (process.argv.includes('--clear')) clear();
else seed();
