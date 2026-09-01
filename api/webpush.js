/**
 * webpush.js — Web Push, implemented rather than depended on.
 *
 * WHY NOT THE `web-push` PACKAGE. It is the obvious choice and it is good. But
 * this is about 150 lines of well-specified crypto that Node's own library
 * already provides every primitive for, and this repo has a standing preference
 * for that trade: the QR encoder, the MP4 muxer and the HTTP calls in the Rust
 * side are all hand-rolled for the same reason. Adding a dependency also means
 * changing the Railway build for a feature that must not be able to break the
 * deploy that carries it.
 *
 * WHAT IS IMPLEMENTED. Two separate specs that are easy to conflate:
 *
 *   · RFC 8291 — Message Encryption for Web Push. Derives a key from an ECDH
 *     between the application server and the subscription's public key, salted
 *     with the subscription's auth secret.
 *   · RFC 8188 — Encrypted Content-Encoding (aes128gcm). The record format that
 *     result is fed into, and the framing of the body that goes on the wire.
 *
 *   plus VAPID (RFC 8292): an ES256 JWT identifying this server, so the push
 *   service will accept the message at all.
 *
 * The whole thing is verified against RFC 8291's own published example in
 * webpush.test.js — an implementation of this shape is either exactly right or
 * silently produces undecryptable noise, and a round-trip against itself would
 * happily confirm a wrong info string.
 */
const crypto = require('crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

/** The record size in the aes128gcm header. 4096 is what every push service
 *  accepts and is far above anything sent here. */
const RECORD_SIZE = 4096;

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * A VAPID key pair, in the form the rest of the world expects: raw
 * base64url-encoded P-256 points, not PEM.
 *
 * Run once, keep the private key in the environment, publish the public one.
 */
function generateVAPIDKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64(ecdh.getPublicKey()),        // 65 bytes, uncompressed (0x04…)
    privateKey: b64(ecdh.getPrivateKey()),      // 32 bytes
  };
}

/** Wrap a raw 32-byte P-256 scalar as a KeyObject, which is what the signer
 *  wants. Built by hand because Node has no "import a raw EC private key" call:
 *  the scalar is spliced into a DER SEC1 template along with its public point. */
function privateKeyObject(rawPrivate) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(rawPrivate);
  const pub = ecdh.getPublicKey();

  // RFC 5915 ECPrivateKey, with the prime256v1 OID and the public key attached.
  const der = Buffer.concat([
    Buffer.from([0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20]),
    rawPrivate,
    Buffer.from([0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),
    Buffer.from([0xa1, 0x44, 0x03, 0x42, 0x00]),
    pub,
  ]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

// ── RFC 8291 + RFC 8188 ────────────────────────────────────────────────────

/**
 * Encrypt one push message.
 *
 *   payload       Buffer or string, the plaintext
 *   userPublic    the subscription's p256dh, base64url (65 raw bytes)
 *   userAuth      the subscription's auth secret, base64url (16 raw bytes)
 *   opts.salt / opts.serverKeys  fixed values, for the spec's test vector only
 *
 * Returns the complete aes128gcm body, ready to be the request payload.
 */
function encrypt(payload, userPublic, userAuth, opts = {}) {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const uaPublic = unb64(userPublic);
  const authSecret = unb64(userAuth);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('subscription public key is not an uncompressed P-256 point');
  }
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');

  // Ephemeral per message — reusing one would leak across subscriptions.
  const server = crypto.createECDH('prime256v1');
  if (opts.serverKeys) server.setPrivateKey(unb64(opts.serverKeys.privateKey));
  else server.generateKeys();
  const asPublic = server.getPublicKey();

  const salt = opts.salt ? unb64(opts.salt) : crypto.randomBytes(16);
  const shared = server.computeSecret(uaPublic);

  /* RFC 8291 §3.4. The receiver's key comes FIRST in key_info; swapping the two
     produces a body the push service will happily deliver and no browser can
     ever decrypt — which is the failure this file's test exists to prevent. */
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  // RFC 8188 §2.2. Both info strings are NUL-terminated.
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  /* RFC 8188 §2: every record carries a padding delimiter. 0x02 marks the LAST
     record; 0x01 would mean another follows, and a receiver would sit waiting
     for it. Everything here fits in one record. */
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 §2.1 header: salt(16) | record size(4) | key id length(1) | key id.
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, body]);
}

// ── VAPID (RFC 8292) ───────────────────────────────────────────────────────

/** DER ECDSA signature → the raw r‖s pair JOSE requires. Node signs in DER, and
 *  a push service given a DER signature rejects it as malformed. */
function derToJose(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;   // long-form length
  const readInt = () => {
    if (der[offset++] !== 0x02) throw new Error('malformed ECDSA signature');
    let len = der[offset++];
    let val = der.subarray(offset, offset + len);
    offset += len;
    // DER integers are signed, so a leading zero may have been added; the JOSE
    // form is a fixed-width unsigned 32 bytes.
    while (val.length > 32 && val[0] === 0) val = val.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - val.length), val]);
  };
  return Buffer.concat([readInt(), readInt()]);
}

/**
 * The Authorization header value for one push request.
 * `audience` is the ORIGIN of the endpoint, not the whole URL — a push service
 * rejects a token whose aud carries the path.
 */
function vapidHeader(audience, subject, publicKey, privateKey, nowSeconds) {
  const now = nowSeconds || Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  // 12 hours: comfortably inside the 24-hour maximum RFC 8292 allows, with room
  // for a clock that disagrees with the push service's.
  const claims = b64(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: subject }));
  const signingInput = `${header}.${claims}`;

  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  const der = signer.sign(privateKeyObject(unb64(privateKey)));

  return `vapid t=${signingInput}.${b64(derToJose(der))}, k=${publicKey}`;
}

// ── Sending ────────────────────────────────────────────────────────────────

/**
 * Deliver one message.
 *
 * Resolves with { ok, status }. A 404 or 410 means the subscription is dead —
 * the browser was uninstalled, or the user cleared it — and the caller is
 * expected to delete it rather than retry forever.
 */
async function send(subscription, payload, vapid, opts = {}) {
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;

  const body = encrypt(payload, subscription.keys.p256dh, subscription.keys.auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(audience, vapid.subject, vapid.publicKey, vapid.privateKey),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      // Seconds the service may hold an undelivered message. A day: a phone that
      // was off overnight should still be told its agent needed approval.
      TTL: String(opts.ttl || 86400),
      Urgency: opts.urgency || 'normal',
    },
    body,
  });

  return {
    ok: res.ok,
    status: res.status,
    // The only status worth acting on: the subscription no longer exists.
    gone: res.status === 404 || res.status === 410,
  };
}

module.exports = { generateVAPIDKeys, encrypt, vapidHeader, send, derToJose, privateKeyObject };
