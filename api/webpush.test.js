/**
 * Web Push crypto tests.
 *
 *   node api/webpush.test.js
 *
 * THE POINT OF THE FIRST TEST. This is an implementation that is either exactly
 * right or silently produces a body the push service delivers and no browser can
 * decrypt — there is no partial credit and no error message. A round-trip
 * against itself would prove nothing: swap the two public keys in key_info, or
 * drop a NUL from an info string, and encrypt/decrypt still agree with each
 * other while every real client fails.
 *
 * So the first test is RFC 8291's own worked example, byte for byte. Everything
 * else here is secondary.
 */
const crypto = require('crypto');
const wp = require('./webpush');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : `\n      got  ${got}\n      want ${want}`}`, got === want);

console.log('\nWeb Push\n');

// ── RFC 8291 §5, verbatim ──
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const out = wp.encrypt(V.plaintext, V.uaPublic, V.auth, {
  salt: V.salt,
  serverKeys: { privateKey: V.asPrivate, publicKey: V.asPublic },
});
eq('matches RFC 8291 §5 byte for byte', out.toString('base64url'), V.body);

// The header framing, checked separately so a failure above localises.
eq('header carries the salt', out.subarray(0, 16).toString('base64url'), V.salt);
eq('record size is 4096', out.readUInt32BE(16), 4096);
eq('key id length is 65', out.readUInt8(20), 65);
eq('and the key id is the sender public key', out.subarray(21, 86).toString('base64url'), V.asPublic);

// ── Decrypting it back, written from the spec independently ──
// Not a substitute for the vector above, but it proves the receiver's side of
// the derivation agrees — and it is what a browser actually does.
function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(Buffer.from(uaPrivate, 'base64url'));
  const shared = ua.computeSecret(asPublic);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    Buffer.from(uaPublic, 'base64url'),
    asPublic,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(auth, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  // Strip the RFC 8188 padding delimiter.
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0x00) end--;
  return plain.subarray(0, end - 1).toString('utf8');
}

eq('decrypts back to the plaintext', decrypt(out, V.uaPrivate, V.uaPublic, V.auth), V.plaintext);

// A real message, with fresh ephemeral keys, still round-trips.
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const auth = crypto.randomBytes(16).toString('base64url');
const msg = 'Claude is waiting for approval · 编译中';
const live = wp.encrypt(msg, ua.getPublicKey().toString('base64url'), auth);
eq('a freshly keyed message round-trips',
  decrypt(live, ua.getPrivateKey().toString('base64url'), ua.getPublicKey().toString('base64url'), auth), msg);
ok('and uses a different salt every time',
  wp.encrypt(msg, ua.getPublicKey().toString('base64url'), auth).subarray(0, 16)
    .toString('hex') !== live.subarray(0, 16).toString('hex'));

// ── Input validation ──
// A malformed subscription must fail loudly here, not produce a body that the
// push service accepts and the browser silently drops.
ok('rejects a key that is not a P-256 point', (() => {
  try { wp.encrypt('x', Buffer.alloc(65).toString('base64url'), auth); return false; }
  catch (e) { return /uncompressed P-256/.test(e.message); }
})());
ok('rejects a wrong-length auth secret', (() => {
  try { wp.encrypt('x', ua.getPublicKey().toString('base64url'), Buffer.alloc(8).toString('base64url')); return false; }
  catch (e) { return /16 bytes/.test(e.message); }
})());

// ── VAPID ──
const keys = wp.generateVAPIDKeys();
eq('a generated public key is 65 raw bytes', Buffer.from(keys.publicKey, 'base64url').length, 65);
eq('and a private key is 32', Buffer.from(keys.privateKey, 'base64url').length, 32);

const hdr = wp.vapidHeader('https://fcm.googleapis.com', 'mailto:hi@terseai.org', keys.publicKey, keys.privateKey);
ok('the header is a vapid scheme', hdr.startsWith('vapid t='));
ok('and carries the public key', hdr.includes(', k=' + keys.publicKey));

const jwt = hdr.slice('vapid t='.length, hdr.indexOf(', k='));
const [h, p, sig] = jwt.split('.');
eq('the JWT algorithm is ES256', JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256');
const claims = JSON.parse(Buffer.from(p, 'base64url'));
eq('the audience is the ORIGIN, with no path', claims.aud, 'https://fcm.googleapis.com');
eq('the subject travels', claims.sub, 'mailto:hi@terseai.org');
ok('it expires within the 24h RFC 8292 allows', claims.exp - Math.floor(Date.now() / 1000) <= 86400);
// A DER signature here is the classic mistake: push services reject it as
// malformed, with a message that does not say why.
eq('the signature is raw r‖s, not DER', Buffer.from(sig, 'base64url').length, 64);

// And it must actually verify against the public key.
ok('the signature verifies', (() => {
  const raw = Buffer.from(sig, 'base64url');
  const r = raw.subarray(0, 32), s = raw.subarray(32);
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const t = b.subarray(i); return t[0] & 0x80 ? Buffer.concat([Buffer.from([0]), t]) : t; };
  const R = trim(r), S = trim(s);
  const der = Buffer.concat([
    Buffer.from([0x30, R.length + S.length + 4, 0x02, R.length]), R,
    Buffer.from([0x02, S.length]), S,
  ]);
  const pubDer = Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    Buffer.from(keys.publicKey, 'base64url'),
  ]);
  const v = crypto.createVerify('SHA256');
  v.update(`${h}.${p}`);
  return v.verify(crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' }), der);
})());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
