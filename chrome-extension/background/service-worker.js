/**
 * Terse Chrome Extension — Background Service Worker
 * Handles messaging between popup/content scripts, storage, and API calls.
 */

const API_BASE = 'https://www.terseai.org';

// Default settings
const DEFAULT_SETTINGS = {
  aggressiveness: 'balanced',
  autoMode: 'send',
  theme: 'lime',
  removeFillerWords: true,
  removePoliteness: true,
  removeHedging: true,
  removeMetaLanguage: true,
  shortenPhrases: true,
  simplifyInstructions: true,
  removeRedundancy: true,
  compressWhitespace: true,
  compressCodeBlocks: true,
};

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  // Initialize stats
  const stats = await chrome.storage.local.get('stats');
  if (!stats.stats) {
    await chrome.storage.local.set({
      stats: {
        totalOptimizations: 0,
        totalTokensSaved: 0,
        totalOriginalTokens: 0,
        history: [],
      },
    });
  }
});

// Handle keyboard commands
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === 'optimize-selection') {
    chrome.tabs.sendMessage(tab.id, { type: 'capture-selection' });
  } else if (command === 'capture-replace') {
    chrome.tabs.sendMessage(tab.id, { type: 'capture-and-replace' });
  }
});

// Message handler — central router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    console.error('[terse-bg] error:', err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'get-settings':
      return getSettings();

    case 'update-settings':
      return updateSettings(msg.settings);

    case 'record-optimization':
      return recordOptimization(msg.data);

    case 'get-stats':
      return getStats();

    case 'get-auth':
      return getAuth();

    case 'start-auth':
      return startAuth(msg.action);

    case 'sign-out':
      return signOut();

    case 'get-license':
      return getLicense();

    case 'check-can-optimize':
      return checkCanOptimize();

    case 'record-usage':
      return recordUsage();

    case 'api-proxy':
      return apiProxy(msg.endpoint, msg.options);

    default:
      return { error: 'unknown message type: ' + msg.type };
  }
}

// ── Settings ──

async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return data.settings || DEFAULT_SETTINGS;
}

async function updateSettings(partial) {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ settings: updated });
  return updated;
}

// ── Stats ──

async function recordOptimization(data) {
  const store = await chrome.storage.local.get('stats');
  const stats = store.stats || {
    totalOptimizations: 0,
    totalTokensSaved: 0,
    totalOriginalTokens: 0,
    history: [],
  };

  stats.totalOptimizations++;
  stats.totalTokensSaved += data.tokensSaved || 0;
  stats.totalOriginalTokens += data.originalTokens || 0;

  // Keep last 100 entries
  stats.history.unshift({
    timestamp: Date.now(),
    originalTokens: data.originalTokens || 0,
    optimizedTokens: data.optimizedTokens || 0,
    tokensSaved: data.tokensSaved || 0,
    percentSaved: data.percentSaved || 0,
    source: data.source || 'manual',
    site: data.site || '',
  });
  if (stats.history.length > 100) stats.history.length = 100;

  await chrome.storage.local.set({ stats });
  return stats;
}

async function getStats() {
  const data = await chrome.storage.local.get('stats');
  return data.stats || {
    totalOptimizations: 0,
    totalTokensSaved: 0,
    totalOriginalTokens: 0,
    history: [],
  };
}

// ── Auth ──

async function getAuth() {
  const data = await chrome.storage.local.get('auth');
  if (data.auth && data.auth.clerkUserId) {
    return { signedIn: true, ...data.auth };
  }
  return { signedIn: false };
}

async function startAuth(action) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/start`, { method: 'POST' });
    const { token } = await res.json();

    const url = `${API_BASE}/auth-callback.html?token=${token}&action=${action || 'signin'}`;

    // Open auth page in new tab
    chrome.tabs.create({ url });

    // Poll for auth completion
    let attempts = 0;
    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > 180) {
          clearInterval(poll);
          resolve({ success: false, reason: 'timeout' });
          return;
        }
        try {
          const r = await fetch(`${API_BASE}/api/auth/poll/${token}`);
          const data = await r.json();
          if (data.status === 'authenticated') {
            clearInterval(poll);
            const auth = {
              clerkUserId: data.clerkUserId,
              email: data.email || '',
              imageUrl: data.imageUrl || '',
              firstName: data.firstName || '',
            };
            await chrome.storage.local.set({ auth });
            resolve({ success: true, ...auth });
          } else if (data.status === 'expired') {
            clearInterval(poll);
            resolve({ success: false, reason: 'expired' });
          }
        } catch (e) {
          // polling error, keep trying
        }
      }, 1000);
    });
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function signOut() {
  await chrome.storage.local.remove(['auth', 'license']);
  return { signedIn: false };
}

// ── License ──

async function getLicense() {
  const auth = await getAuth();
  if (!auth.signedIn) {
    return { tier: 'none', status: 'none', remaining: -1, limits: { optimizationsPerWeek: 0 } };
  }

  // Check cached license
  const cached = await chrome.storage.local.get('license');
  if (cached.license && Date.now() - (cached.license._fetchedAt || 0) < 30000) {
    return cached.license;
  }

  // Fetch from server
  try {
    const res = await fetch(`${API_BASE}/api/license/${auth.clerkUserId}`);
    const lic = await res.json();
    lic._fetchedAt = Date.now();
    await chrome.storage.local.set({ license: lic });
    return lic;
  } catch {
    return cached.license || { tier: 'none', status: 'none', remaining: -1, limits: { optimizationsPerWeek: 0 } };
  }
}

async function checkCanOptimize() {
  const lic = await getLicense();
  if (lic.tier === 'none' || lic.status === 'none') {
    return { allowed: false, reason: 'No active subscription' };
  }
  if (lic.remaining === 0) {
    return { allowed: false, reason: 'Weekly quota exhausted' };
  }
  return { allowed: true };
}

async function recordUsage() {
  const cached = await chrome.storage.local.get('license');
  if (cached.license && cached.license.remaining > 0) {
    cached.license.remaining -= 0.5;
    await chrome.storage.local.set({ license: cached.license });
  }
  return true;
}

// ── API proxy (for marketplace/proxy features) ──

async function apiProxy(endpoint, options) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await res.json();
    return data;
  } catch (err) {
    return { error: err.message };
  }
}
