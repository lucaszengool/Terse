'use strict';
const https = require('https');
const http = require('http');

const API_BASE = 'https://www.terseai.org';
const LICENSE_TTL = 30_000; // 30s cache

let _licenseCache = null;
let _licenseFetchedAt = 0;
let _ctx = null; // VS Code ExtensionContext

function init(context) {
  _ctx = context;
}

function getStoredAuth() {
  if (!_ctx) return null;
  return _ctx.globalState.get('terse.auth') || null;
}

async function setStoredAuth(auth) {
  await _ctx.globalState.update('terse.auth', auth);
}

async function signOut() {
  await _ctx.globalState.update('terse.auth', null);
  _licenseCache = null;
  _licenseFetchedAt = 0;
}

function jsonRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    };
    const req = lib.request(reqOptions, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Start browser-based OAuth flow (same as Chrome extension)
async function startAuth(vscode, action = 'signin') {
  const data = await jsonRequest(`${API_BASE}/api/auth/start`, { method: 'POST' });
  if (!data?.token) throw new Error('Could not start auth session');

  const authUrl = `${API_BASE}/auth-callback.html?token=${data.token}&action=${action}&from=vscode`;
  await vscode.env.openExternal(vscode.Uri.parse(authUrl));

  // Poll until authenticated (max 3 min)
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const poll = await jsonRequest(`${API_BASE}/api/auth/poll/${data.token}`);
      if (poll.status === 'authenticated') {
        const auth = {
          clerkUserId: poll.clerkUserId,
          email: poll.email,
          firstName: poll.firstName,
          signedIn: true,
        };
        await setStoredAuth(auth);
        _licenseCache = null;
        return auth;
      }
    } catch {}
  }
  throw new Error('Auth timed out — please try again');
}

async function getLicense(forceRefresh = false) {
  const auth = getStoredAuth();
  if (!auth?.signedIn) return null;

  const now = Date.now();
  if (!forceRefresh && _licenseCache && now - _licenseFetchedAt < LICENSE_TTL) {
    return _licenseCache;
  }

  try {
    const lic = await jsonRequest(`${API_BASE}/api/license/${auth.clerkUserId}?platform=vscode`);
    _licenseCache = lic;
    _licenseFetchedAt = now;
    return lic;
  } catch {
    return _licenseCache || { tier: 'none', status: 'none', remaining: 0 };
  }
}

// Check if user can optimize (has active plan or trial)
async function canOptimize() {
  const lic = await getLicense();
  if (!lic) return false;
  if (lic.tier === 'none' || lic.status === 'cancelled') return false;
  if (lic.remaining === 0) return false;
  return true;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { init, getStoredAuth, setStoredAuth, signOut, startAuth, getLicense, canOptimize };
