/**
 * AES-256-GCM encryption for storing API keys securely.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_HEX = process.env.MARKETPLACE_ENCRYPTION_KEY;

function getKey() {
  if (!KEY_HEX) throw new Error('MARKETPLACE_ENCRYPTION_KEY not set');
  return Buffer.from(KEY_HEX, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted, iv, tag };
}

function decrypt(encrypted, iv, tag) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv));
  decipher.setAuthTag(Buffer.from(tag));
  return decipher.update(Buffer.from(encrypted), null, 'utf8') + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
