/**
 * Mint the VAPID key pair that identifies this server to push services.
 *
 *   node scripts/generate-vapid-keys.js
 *
 * Run ONCE. Rotating the pair invalidates every existing subscription — browsers
 * bind a subscription to the public key it was created with, so every installed
 * app would have to re-subscribe, silently, and until it did its notifications
 * would simply stop.
 */
const { generateVAPIDKeys } = require('../api/webpush');

const { publicKey, privateKey } = generateVAPIDKeys();
console.log(`
Add these to the server environment (Railway → Variables):

  VAPID_PUBLIC_KEY=${publicKey}
  VAPID_PRIVATE_KEY=${privateKey}
  VAPID_SUBJECT=mailto:support@terseai.org

The public key is served to browsers and is not a secret. The private key is —
it is the only thing proving a push came from this server. Keep it out of git.
`);
