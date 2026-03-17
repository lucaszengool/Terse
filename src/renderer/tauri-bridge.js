/**
 * Tauri bridge — replaces Electron's preload.js
 * Provides the same `window.terse` (T) API using Tauri invoke/events.
 * Only activates when running inside Tauri (window.__TAURI__ exists).
 *
 * KEY ARCHITECTURE NOTE:
 * - Tauri `emit()` sends to Rust backend, NOT to other JS listeners
 * - Tauri `listen()` receives from Rust backend
 * - For intra-webview communication we use window.dispatchEvent + CustomEvent
 */
if (window.__TAURI__) {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Registry of JS-side listeners (same API as Electron's ipcRenderer.on)
  const _listeners = {};

  // Dispatch an event locally to all JS listeners registered via T.on()
  function _dispatch(channel, payload) {
    if (_listeners[channel]) {
      for (const cb of _listeners[channel]) {
        try { cb(payload); } catch (e) { console.error('[terse] event handler error:', channel, e); }
      }
    }
  }

  const T = {
    // Session management
    enterPickMode: () => invoke('enter_pick_mode'),
    getSessions: () => invoke('get_sessions'),
    removeSession: (id) => invoke('remove_session', { id }),
    captureNow: () => invoke('capture_now'),
    replaceInTarget: (text) => invoke('replace_in_target', { text }),
    applyToClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        await invoke('apply_to_clipboard', { text });
      }
      return true;
    },
    optimizeText: async (text) => {
      // Check license quota before optimizing
      try {
        const check = await invoke('check_can_optimize');
        if (!check.allowed) {
          return Promise.resolve({
            optimized: text,
            stats: { originalTokens: 0, optimizedTokens: 0, percentSaved: 0, techniquesApplied: [] },
            suggestions: [],
            blocked: true,
            reason: 'Weekly optimization limit reached. Upgrade to Pro for unlimited.',
          });
        }
      } catch {}

      // Optimizer runs in webview — call the local optimizer
      if (window._terseOptimizer) {
        const result = window._terseOptimizer.optimize(text);
        // Record stats + usage
        invoke('record_optimization', {
          source: 'manual',
          originalTokens: result.stats.originalTokens,
          optimizedTokens: result.stats.optimizedTokens,
        }).catch(() => {});
        invoke('record_optimization_usage').catch(() => {});
        return result;
      }
      return { optimized: text, stats: { originalTokens: 0, optimizedTokens: 0, percentSaved: 0, techniquesApplied: [] }, suggestions: [] };
    },
    getSettings: () => invoke('get_settings'),
    updateSettings: (s) => invoke('update_settings', { s }),
    closeWindow: () => invoke('close_window'),
    setAutoMode: (mode) => invoke('set_auto_mode', { mode }),
    requestAccessibility: () => invoke('request_accessibility'),
    installBridge: () => invoke('install_bridge'),
    setPopupMinimized: (on) => invoke('set_popup_minimized', { on }),
    resizePopup: (h) => invoke('resize_popup', { h }),
    movePopupBy: (dx, dy) => invoke('move_popup_by', { dx, dy }),

    // Agent Monitor
    getAgentDetections: () => invoke('get_agent_detections'),
    getAgentSessions: () => invoke('get_agent_sessions'),
    acceptAgent: (agentType) => invoke('accept_agent', { agentType }),
    dismissAgent: (agentType) => invoke('dismiss_agent', { agentType }),
    disconnectAgent: (agentType) => invoke('disconnect_agent', { agentType }),
    analyzeAgentSession: (agentType) => invoke('get_agent_analytics', { agentType }),
    getAgentAnalytics: (agentType) => invoke('get_agent_analytics', { agentType }),

    // Stats
    getStats: (period) => invoke('get_stats', { period }),
    navigateToStats: () => invoke('navigate_to_stats'),
    navigateBack: () => invoke('navigate_back'),

    // Hook (RTK-style compression)
    checkAgentHook: () => invoke('check_agent_hook'),
    getHookStats: () => invoke('get_hook_stats'),

    // Record optimization stats
    recordOptimization: (source, originalTokens, optimizedTokens) =>
      invoke('record_optimization', { source, originalTokens, optimizedTokens }),

    // Spellcheck via terse-ax
    spellcheck: (text) => invoke('spellcheck', { text }),

    // Auth — open browser for sign-in, poll for completion
    openAuthInBrowser: async (action) => {
      const API_BASE = 'https://www.terseai.org';
      try {
        // Get a unique auth token from the server
        console.log('[terse-auth] starting auth flow...');
        const res = await fetch(`${API_BASE}/api/auth/start`, { method: 'POST' });
        const { token } = await res.json();
        console.log('[terse-auth] got token:', token?.substring(0, 12) + '...');
        // Open browser to auth callback page
        const url = `${API_BASE}/auth-callback.html?token=${token}&action=${action || 'signin'}`;
        // Open URL in system default browser via Tauri shell plugin
        try {
          const { open } = window.__TAURI__.shell;
          await open(url);
          console.log('[terse-auth] opened browser via shell.open');
        } catch (e) {
          console.warn('[terse-auth] shell.open failed, using window.open:', e);
          window.open(url, '_blank');
        }
        // Poll for auth completion
        return new Promise((resolve) => {
          let attempts = 0;
          const poll = setInterval(async () => {
            attempts++;
            if (attempts > 180) { clearInterval(poll); console.log('[terse-auth] polling timed out'); resolve(null); return; } // 3 min timeout
            try {
              const r = await fetch(`${API_BASE}/api/auth/poll/${token}`);
              const data = await r.json();
              if (attempts % 10 === 0) console.log('[terse-auth] poll #' + attempts + ':', data.status);
              if (data.status === 'authenticated') {
                clearInterval(poll);
                console.log('[terse-auth] authenticated!', data.clerkUserId, data.email);
                // Save auth locally
                await invoke('set_clerk_user', { clerkUserId: data.clerkUserId });
                await invoke('save_auth', {
                  clerkUserId: data.clerkUserId,
                  email: data.email || '',
                  imageUrl: data.imageUrl || '',
                  firstName: data.firstName || '',
                });
                resolve(data);
              } else if (data.status === 'expired') {
                clearInterval(poll);
                console.log('[terse-auth] token expired');
                resolve(null);
              }
            } catch (e) { if (attempts % 10 === 0) console.warn('[terse-auth] poll error:', e); }
          }, 1000);
        });
      } catch (err) {
        console.error('[terse] auth error:', err);
        return null;
      }
    },
    getAuth: () => invoke('get_auth'),
    signOut: () => invoke('sign_out'),

    // License
    getLicense: () => invoke('get_license'),
    setClerkUser: (clerkUserId) => invoke('set_clerk_user', { clerkUserId }),
    verifyLicense: (clerkUserId) => invoke('verify_license_remote', { clerkUserId }),
    checkCanOptimize: () => invoke('check_can_optimize'),
    recordOptimizationUsage: () => invoke('record_optimization_usage'),
    checkCanAddSession: () => invoke('check_can_add_session'),

    // Capture helpers
    getFrontApp: () => invoke('get_front_app'),
    readAXApp: (pid, hintX, hintY) => invoke('read_ax_app', { pid, hintX, hintY }),
    isBridgeAlive: () => invoke('is_bridge_alive'),
    readBridge: () => invoke('read_bridge'),
    writeBridge: (text) => invoke('write_bridge', { text }),
    writeToApp: (appName, text, pid) => invoke('write_to_app', { appName, text, pid }),
    activateApp: (appName) => invoke('activate_app', { appName }),
    sendEnter: (pid) => invoke('send_enter', { pid }),

    // Event listener — registers JS callback for both Rust events and local dispatches
    on: (channel, callback) => {
      // Register in local listener map
      if (!_listeners[channel]) _listeners[channel] = [];
      _listeners[channel].push(callback);

      // Also subscribe to Tauri events from Rust backend
      listen(channel, (event) => {
        callback(event.payload);
      });
    },
  };

  // Expose as window.terse for compatibility with existing app.js, popup.js
  window.terse = T;

  // Forward console.log to Rust stderr for debugging
  const _origLog = console.log;
  const _origErr = console.error;
  console.log = (...args) => {
    _origLog(...args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (msg.includes('[terse')) invoke('debug_log', { msg }).catch(() => {});
  };
  console.error = (...args) => {
    _origErr(...args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    invoke('debug_log', { msg: '[ERROR] ' + msg }).catch(() => {});
  };

  // Expose invoke for popup.js optimization pipeline
  T._invoke = invoke;
}
