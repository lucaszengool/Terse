const crypto = require('crypto');
const B = 'http://127.0.0.1:4311';
const H = { Authorization: 'Bearer TESTTOKEN' };
const sha = b => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0,8);
const ok = (name, cond, extra='') => console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

(async () => {
  const st = async () => (await fetch(B + '/api/cloud/wallpaper', { headers: H })).json();
  let s = await st();
  const oldUrl = s.url, tokenPath = oldUrl.replace(B, '');

  console.log('\n# state before rotation');
  ok('12 frames stored', s.frames === 12, `frames=${s.frames}`);
  ok('ready', s.ready === true);
  ok('fetch_count counted the 26 ring fetches', s.fetch_count === 26, `fetch_count=${s.fetch_count}`);
  ok('fetched_at recorded', !!s.fetched_at, String(s.fetched_at));

  console.log('\n# the legacy .png alias (links people already pasted)');
  const legacy = await fetch(B + tokenPath + '.png');
  ok('.png still answers 200', legacy.status === 200, `status=${legacy.status}`);
  ok('.png is served as an image', /^image\//.test(legacy.headers.get('content-type')||''), legacy.headers.get('content-type'));
  ok('.png is no-store at the origin', /no-store/.test(legacy.headers.get('cache-control')||''), legacy.headers.get('cache-control'));

  console.log('\n# variants');
  const ov = await fetch(B + tokenPath + '/overlay');
  ok('overlay with none uploaded does not 500', ov.status !== 500, `status=${ov.status}`);
  const clip = await fetch(B + tokenPath + '/clip');
  ok('clip with no video does not 500', clip.status !== 500, `status=${clip.status}`);

  console.log('\n# bad tokens');
  ok('unknown token 404s', (await fetch(B + '/w/' + 'x'.repeat(24))).status === 404);
  ok('short token 404s', (await fetch(B + '/w/abc')).status === 404);

  console.log('\n# rotate');
  const before = sha(await (await fetch(oldUrl)).arrayBuffer());
  const rot = await (await fetch(B + '/api/cloud/wallpaper/rotate', { method:'POST', headers: H })).json();
  ok('rotate returns a different URL', rot.url !== oldUrl, `${oldUrl.slice(-8)} -> ${rot.url.slice(-8)}`);
  ok('frames survived rotation', rot.frames === 12, `frames=${rot.frames}`);
  const dead = await fetch(oldUrl);
  ok('OLD url is dead immediately', dead.status === 404, `status=${dead.status}`);
  const alive = await fetch(rot.url);
  ok('NEW url serves an image', alive.status === 200 && /^image\//.test(alive.headers.get('content-type')||''), `status=${alive.status}`);

  console.log('\n# the new url walks the same ring');
  const seq = [];
  for (let i = 0; i < 13; i++) seq.push(sha(await (await fetch(rot.url)).arrayBuffer()));
  ok('12 unique over 13 fetches', new Set(seq).size === 12, `unique=${new Set(seq).size}`);
  ok('wraps at 12', seq[0] === seq[12], `${seq[0]} vs ${seq[12]}`);

  console.log('\n# delete');
  const del = await fetch(B + '/api/cloud/wallpaper', { method:'DELETE', headers: H });
  ok('delete returns 2xx', del.ok, `status=${del.status}`);
  ok('url is gone', (await fetch(rot.url)).status === 404);
  const after = await st();
  ok('status reports 0 frames', after.frames === 0, `frames=${after.frames}`);

  console.log('\n# unauthenticated');
  ok('no token = 401', (await fetch(B + '/api/cloud/wallpaper')).status === 401);
  ok('bad token = 401', (await fetch(B + '/api/cloud/wallpaper', { headers:{Authorization:'Bearer NOPE'} })).status === 401);
})();
