/* E2E harness: the real server, with Clerk verification stubbed so the phone
   half of the chain can be driven without an account. Never committed. */
process.env.TERSE_DATA_DIR   = require('path').join(__dirname, 'data');
process.env.PORT             = '4311';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
require('fs').mkdirSync(process.env.TERSE_DATA_DIR, { recursive: true });

const link = require('../api/link');
link.verifyUser = async (raw) => (String(raw) === 'TESTTOKEN' ? 'user_test_e2e' : null);

require('../api/server');
