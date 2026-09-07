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

/* ── Covers ───────────────────────────────────────────────────────────────
   SIX patterns, not one gradient. The cover is what gathers out of the
   particles first, so it is the first thing that says "this is a different
   project" — and a hundred diagonal fades in a hundred hues still read as a
   hundred of the same thing, because the SHAPE is what the eye sorts on before
   the colour. Each is a pure function of (u, v), which is all the PNG writer
   wants, and each still costs about a kilobyte. */
const PATTERNS = ['fade', 'rings', 'bars', 'rays', 'blob', 'grid'];

function cover(hue, r) {
  const kind = pick(r, PATTERNS);
  const sat = 0.42 + r() * 0.4;
  const spin = (hue + 40 + Math.round(r() * 200)) % 360;   // the partner hue
  const a = hsl(hue, sat, 0.30 + r() * 0.28);
  const b = hsl(spin, sat * 0.9, 0.16 + r() * 0.22);
  const mix = (t) => [0, 1, 2].map((i) => Math.round(a[i] * (1 - t) + b[i] * t));
  const k1 = 2 + Math.round(r() * 5);          // how many rings / bars / rays
  const ang = r() * Math.PI;
  const cx = 0.3 + r() * 0.4, cy = 0.3 + r() * 0.4;

  const fn = {
    fade: (u, v) => mix(u * Math.cos(ang) + v * Math.sin(ang)),
    rings: (u, v) => {
      const d = Math.hypot(u - cx, v - cy) * k1;
      return mix((Math.sin(d * 6.28) + 1) / 2);
    },
    bars: (u, v) => {
      const t = (u * Math.cos(ang) + v * Math.sin(ang)) * k1;
      return mix(t - Math.floor(t) < 0.5 ? 0.12 : 0.88);
    },
    rays: (u, v) => {
      const th = Math.atan2(v - cy, u - cx);
      return mix((Math.sin(th * k1) + 1) / 2);
    },
    blob: (u, v) => {
      const d = Math.hypot((u - cx) * 1.4, v - cy);
      return mix(Math.min(1, Math.max(0, (d - 0.12) * 2.4)));
    },
    grid: (u, v) => {
      const gu = Math.floor(u * k1), gv = Math.floor(v * k1);
      return mix((gu + gv) % 2 ? 0.15 : 0.8);
    },
  }[kind];

  return 'data:image/png;base64,' + png(96, 72, fn).toString('base64');
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
/* ⚠ THE KEYS ARE LOWERCASE AND THEY ARE NOT DECORATIVE. lang-colors.js is keyed
   'rust' / 'ts' / 'c++', and anything it does not recognise is painted with one
   grey fallback. The first version of this file said 'TypeScript' and 'Rust',
   so every tower in all hundred cities came out the same grey — which is most
   of why they looked alike. These are the seventeen the table actually knows. */
const LANGS = [
  [['ts', 0.71], ['css', 0.18], ['html', 0.11]],
  [['rust', 0.86], ['shell', 0.09], ['c', 0.05]],
  [['python', 0.78], ['shell', 0.14], ['sql', 0.08]],
  [['go', 0.91], ['shell', 0.06], ['sql', 0.03]],
  [['swift', 0.74], ['c', 0.16], ['ruby', 0.10]],
  [['js', 0.64], ['css', 0.22], ['html', 0.14]],
  [['c++', 0.69], ['c', 0.19], ['python', 0.12]],
  [['java', 0.62], ['kotlin', 0.28], ['sql', 0.10]],
  [['kotlin', 0.81], ['java', 0.13], ['shell', 0.06]],
  [['ruby', 0.77], ['js', 0.15], ['css', 0.08]],
  [['php', 0.68], ['sql', 0.20], ['html', 0.12]],
  [['c#', 0.84], ['sql', 0.11], ['shell', 0.05]],
  [['html', 0.46], ['css', 0.34], ['js', 0.20]],
  [['sql', 0.58], ['python', 0.29], ['shell', 0.13]],
  [['shell', 0.55], ['python', 0.27], ['c', 0.18]],
  [['c', 0.88], ['shell', 0.08], ['python', 0.04]],
];

/* The eight architectures in city-styles.js. Every seed used to leave this
   empty, which means every one of the hundred was 'modern' — one skyline,
   painted a hundred times. This is the single biggest difference between two
   cities, so it is the first thing that should vary. */
const STYLES = ['modern', 'tang', 'edo', 'giza', 'hellas', 'maya', 'persia', 'norse'];

/* How a repository is SHAPED, which is the second biggest difference. A monorepo
   is a wall of similar towers; a library is one tall thing with outbuildings;
   a monolith is a single slab. Picking a shape and then generating to it is what
   stops a hundred random draws from converging on the same average city. */
const SHAPES = ['monorepo', 'library', 'monolith', 'scatter', 'twin'];
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

  /* ── The skyline ─────────────────────────────────────────────────────────
     Generated to a SHAPE rather than drawn from one distribution. A hundred
     independent random draws all converge on the same average city — which is
     exactly what the first version produced. A monorepo is a wall of similar
     towers; a library is one tall thing with outbuildings; a monolith is a
     single slab with a couple of sheds. Those read as different places from
     across the room, which is the distance a feed is looked at from. */
  const shape = pick(r, SHAPES);
  const n = shape === 'monolith' ? int(r, 3, 5)
          : shape === 'library' ? int(r, 4, 8)
          : shape === 'twin' ? int(r, 6, 10)
          : shape === 'monorepo' ? int(r, 12, 22)
          : int(r, 7, 16);
  const names = [];
  while (names.length < n && names.length < DIRNAMES.length) {
    const d = pick(r, DIRNAMES);
    if (!names.includes(d)) names.push(d);
  }
  const dirs = names.map((nm, k) => {
    let files;
    if (shape === 'library')      files = k === 0 ? int(r, 180, 420) : int(r, 3, 40);
    else if (shape === 'monolith') files = k === 0 ? int(r, 300, 900) : int(r, 2, 25);
    else if (shape === 'twin')     files = k < 2 ? int(r, 140, 260) : int(r, 5, 60);
    else if (shape === 'monorepo') files = int(r, 40, 160);          // a wall, evenly tall
    else                           files = int(r, 3, 240);           // scatter
    // Bytes per file varies by an order of magnitude too, so two buildings with
    // the same file count are still not the same building.
    const dense = 900 + Math.round(r() * r() * 40000);
    // Sub-buildings on some, not all — the second ring of the sunburst and the
    // smaller massing on the tower come from these.
    const kidN = r() < 0.45 ? int(r, 1, 5) : 0;
    const kids = [];
    for (let q = 0; q < kidN; q++) kids.push([pick(r, DIRNAMES), int(r, 1, 60), int(r, 400, 90000)]);
    return {
      name: nm,
      files,
      bytes: Math.round(files * dense),
      kind: KIND_OF[nm] || 'code',
      // A building takes the colour of ITS OWN main language, not the project's
      // — that is what makes a city multicoloured rather than one hue repeated.
      langs: [[pick(r, langs)[0], 0.55 + r() * 0.45]],
      kids,
      churn: int(r, 1, 400),
      // Age drives the window warmth and the weathering in several styles.
      age_days: int(r, 20, 2600),
      depth: int(r, 1, 4),
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
    // A paragraph behind the one-liner, so the feed's "more" has something to
    // open and the shape of a real listing is visible from the first swipe.
    desc: [
      `${name} is ${pick(r, BLURBS)}.`,
      `It started as a script I kept pasting between machines, and turned into ${int(r, 2, 9)} files I actually maintain.`,
      `Written mostly in ${langs[0][0]}. ${int(r, 2, 40)} people have opened issues; ${int(r, 1, 12)} of them became features.`,
      `No dependencies you have to think about, and it does the one thing on the tin.`,
    ].join(' '),
    tags: [langs[0][0], pick(r, KINDS)],
    cover: cover(hue, r),
    shots: [],
    lines: [`${files} files`, `${people.length} contributor${people.length > 1 ? 's' : ''}`],
    files,
    langs,
    // One of the eight, so the plaza is eight architectures rather than one.
    style: pick(r, STYLES),
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

/* ── Seeding a server you cannot reach the database of ────────────────────
   Production's database lives with the deployment, so `node seed-projects.js`
   on a laptop fills the laptop. `--remote <base>` publishes the same capsules
   through the public API instead, which is the same door a real Terse app uses.

   The per-identity cap (24) is real and enforced server-side, so the hundred
   are spread across enough identities to fit — the seeds already vary their
   author, which is also what makes the feed look like more than one person.

   `--remote <base> --clear` deletes them again, by the same route. */
async function remote(base, doClear) {
  const post = (path, identity, body, method) => fetch(base + path, {
    method: method || 'POST',
    headers: Object.assign({ 'x-terse-identity': identity },
                           body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  let ok = 0, failed = 0;
  for (let i = 0; i < COUNT; i++) {
    const cap = makeCapsule(i);
    // The identity that will own it. Spread so nobody hits the 24 cap, and so
    // the plaza reads as a place with several people in it.
    const who = 'terse-seed-' + (i % 6);
    const r = doClear
      ? await post('/api/cloud/projects/' + encodeURIComponent(cap.srcId), who, null, 'DELETE')
      : await post('/api/cloud/projects', who, { capsule: cap });
    // Paced. The cloud routes sit behind an ingest limiter, and a hundred 7KB
    // posts as fast as the loop can issue them is exactly what it is there to
    // stop — a seeder that trips the rate limit reports failures that say
    // nothing about the data.
    await new Promise((res) => setTimeout(res, 120));
    if (r.status === 200) ok++;
    else { failed++; if (failed < 4) console.error(`  ${cap.title}: ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); }
  }
  console.log(`${doClear ? 'removed' : 'published'} ${ok}/${COUNT} to ${base}` +
              (failed ? `, ${failed} failed` : ''));
}

const at = process.argv.indexOf('--remote');
if (at >= 0) remote(process.argv[at + 1].replace(/\/+$/, ''), process.argv.includes('--clear'));
else if (process.argv.includes('--clear')) clear();
else seed();
