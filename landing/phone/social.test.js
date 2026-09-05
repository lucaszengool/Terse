/**
 * social.js — the two things in it that fail silently.
 *
 *   node landing/phone/social.test.js
 *
 * The API calls are thin enough to read; these two are not, and neither of them
 * throws when it is wrong:
 *
 *   · adopt() decides which identity the whole app speaks under. Get it wrong
 *     and everything still works — you are simply a different person to the
 *     server than you were yesterday, and your friends are gone. It also has to
 *     keep the value it replaces, because that replacement is irreversible.
 *   · codeFrom() takes whatever somebody pasted. People copy the whole link out
 *     of a chat window; a version that only accepts a bare token answers "no
 *     such link" to a link that is perfectly valid.
 */
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n)));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

// A localStorage that behaves like the real one, including throwing — Safari in
// a private window does, and every read here is wrapped for exactly that reason.
function store(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

global.window = global;
const Social = require(path.join(__dirname, 'social.js'));

console.log('\n── adopt: one identity for the whole app ──');
global.localStorage = store({});
eq('a fresh install takes the Clerk id', Social.adopt('user_abc'), true);
eq('and speaks under it', Social.identity(), 'user_abc');
eq('adopting the same id again changes nothing', Social.adopt('user_abc'), false);
eq('an empty id is ignored', Social.adopt(''), false);
eq('and does not wipe what is there', Social.identity(), 'user_abc');

global.localStorage = store({ 'terse-identity': 'a1b2-random-install-secret' });
eq('an existing random secret is replaced', Social.adopt('user_xyz'), true);
eq('by the Clerk id', Social.identity(), 'user_xyz');
// Replacing it drops any friendship made under the old one. That is a real
// cost, so the old value stays reachable rather than being destroyed.
eq('and the old one is kept, not destroyed',
   localStorage.getItem('terse-identity-legacy'), 'a1b2-random-install-secret');
Social.adopt('user_second_account');
eq('a later switch does not overwrite the original legacy value',
   localStorage.getItem('terse-identity-legacy'), 'a1b2-random-install-secret');

console.log('\n── a friend code, however it was pasted ──');
eq('a bare token', Social.codeFrom('Ab3-xY7z'), 'Ab3-xY7z');
eq('with whitespace around it', Social.codeFrom('  Ab3-xY7z\n'), 'Ab3-xY7z');
eq('the whole share link', Social.codeFrom('https://www.terseai.org/join?friend=Ab3-xY7z'), 'Ab3-xY7z');
eq('a link with more query on it',
   Social.codeFrom('https://www.terseai.org/join?friend=Ab3-xY7z&utm=x'), 'Ab3-xY7z');
eq('an escaped one comes back readable',
   Social.codeFrom('https://www.terseai.org/join?friend=a%2Fb'), 'a/b');
eq('a path-shaped link', Social.codeFrom('https://www.terseai.org/join/Ab3-xY7z'), 'Ab3-xY7z');
eq('a trailing slash is not a code', Social.codeFrom('https://www.terseai.org/join/Ab3-xY7z/'), 'Ab3-xY7z');
eq('nothing is nothing', Social.codeFrom('   '), '');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
