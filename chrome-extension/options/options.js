/**
 * Terse Chrome Extension — Options Page Logic
 */

function sendBg(msg) {
  return chrome.runtime.sendMessage(msg);
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

async function init() {
  const settings = await sendBg({ type: 'get-settings' });

  // Aggressiveness toggle
  document.querySelectorAll('.toggle-btn[data-level]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === settings.aggressiveness);
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.toggle-btn[data-level]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await sendBg({ type: 'update-settings', settings: { aggressiveness: btn.dataset.level } });
    });
  });

  // Auto mode toggle
  document.querySelectorAll('.auto-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.auto === (settings.autoMode || 'send'));
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.auto-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await sendBg({ type: 'update-settings', settings: { autoMode: btn.dataset.auto } });
    });
  });

  // Checkboxes
  document.querySelectorAll('input[data-key]').forEach(cb => {
    const key = cb.dataset.key;
    if (settings[key] !== undefined) cb.checked = settings[key];
    cb.addEventListener('change', async () => {
      await sendBg({ type: 'update-settings', settings: { [key]: cb.checked } });
    });
  });

  // Theme
  if (settings.theme) {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.querySelectorAll('.theme-dot').forEach(d => {
      d.classList.toggle('active', d.dataset.t === settings.theme);
    });
  }
  document.querySelectorAll('.theme-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const theme = dot.dataset.t;
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.t === theme));
      await sendBg({ type: 'update-settings', settings: { theme } });
    });
  });

  // Auth
  const auth = await sendBg({ type: 'get-auth' });
  if (auth?.signedIn) {
    document.getElementById('signedOutUI').classList.add('hidden');
    document.getElementById('signedInUI').classList.remove('hidden');
    document.getElementById('accountName').textContent = auth.firstName || 'User';
    document.getElementById('accountEmail').textContent = auth.email || '';

    // License
    const lic = await sendBg({ type: 'get-license' });
    if (lic) {
      const hasAccess = lic.status === 'active' || lic.status === 'trialing';
      document.getElementById('accountTier').textContent = lic.tier && lic.tier !== 'none' ? lic.tier : (hasAccess ? 'Free Trial' : 'No plan');
      if (hasAccess) {
        if (lic.remaining >= 0) {
          document.getElementById('licenseInfo').textContent =
            lic.remaining + '/' + (lic.limits?.optimizationsPerWeek || '∞') + ' optimizations left this week';
        } else {
          document.getElementById('licenseInfo').textContent = 'Unlimited optimizations';
        }
        if (lic.status === 'trialing') {
          document.getElementById('licenseInfo').textContent += ' (trial)';
        }
      } else {
        document.getElementById('licenseInfo').textContent = 'No active subscription';
        document.getElementById('btnStartTrial').classList.remove('hidden');
      }
    }
  }

  document.getElementById('btnSignIn').addEventListener('click', async () => {
    document.getElementById('btnSignIn').textContent = 'Opening browser...';
    await sendBg({ type: 'start-auth', action: 'signin' });
    location.reload();
  });

  document.getElementById('btnSignUp').addEventListener('click', async () => {
    document.getElementById('btnSignUp').textContent = 'Opening browser...';
    await sendBg({ type: 'start-auth', action: 'signup' });
    location.reload();
  });

  document.getElementById('btnStartTrial').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.terseai.org/#pricing' });
  });

  document.getElementById('btnSignOut').addEventListener('click', async () => {
    await sendBg({ type: 'sign-out' });
    location.reload();
  });

  // Stats
  const stats = await sendBg({ type: 'get-stats' });
  if (stats) {
    document.getElementById('statOpts').textContent = stats.totalOptimizations.toLocaleString();
    document.getElementById('statSaved').textContent = formatTokens(stats.totalTokensSaved);
    const avgPct = stats.totalOriginalTokens > 0
      ? Math.round((stats.totalTokensSaved / stats.totalOriginalTokens) * 100)
      : 0;
    document.getElementById('statPct').textContent = avgPct + '%';
  }
}

init();
