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

    // Record optimization stats
    recordOptimization: (source, originalTokens, optimizedTokens) =>
      invoke('record_optimization', { source, originalTokens, optimizedTokens }),

    // Spellcheck via terse-ax
    spellcheck: (text) => invoke('spellcheck', { text }),

    // Auth — open browser for sign-in, poll for completion
    openAuthInBrowser: async (action) => {
      const API_BASE = 'https://terse-production.up.railway.app';
      try {
        // Get a unique auth token from the server
        const res = await fetch(`${API_BASE}/api/auth/start`, { method: 'POST' });
        const { token } = await res.json();
        // Open browser to auth callback page
        const url = `${API_BASE}/auth-callback.html?token=${token}&action=${action || 'signin'}`;
        // Open URL in system default browser via Tauri shell plugin
        try {
          const { open } = window.__TAURI__.shell;
          await open(url);
        } catch {
          // Fallback
          window.open(url, '_blank');
        }
        // Poll for auth completion
        return new Promise((resolve) => {
          let attempts = 0;
          const poll = setInterval(async () => {
            attempts++;
            if (attempts > 120) { clearInterval(poll); resolve(null); return; } // 2 min timeout
            try {
              const r = await fetch(`${API_BASE}/api/auth/poll/${token}`);
              const data = await r.json();
              if (data.status === 'authenticated') {
                clearInterval(poll);
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
                resolve(null);
              }
            } catch {}
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

  // ── Live optimization pipeline (Tauri-only) ──
  // The Rust backend emits optimize-request events. We optimize in JS and
  // dispatch popup-update locally (NOT via Tauri emit which goes to Rust).

  let _settleTimer = null;
  const SETTLE_DELAY = 600;

  listen('optimize-request', async (event) => {
    // Only process in popup window to avoid duplicate processing
    if (document.title !== 'Terse Popup') return;
    const d = event.payload;
    if (!window._terseOptimizer) {
      console.error('[terse-bridge] no optimizer available!');
      return;
    }

    // Check license quota
    try {
      const check = await invoke('check_can_optimize');
      if (!check.allowed) {
        console.warn('[terse-bridge] optimization limit reached');
        return;
      }
    } catch {}

    let opt;
    try {
      opt = window._terseOptimizer.optimize(d.text);
    } catch (e) {
      console.error('[terse-bridge] optimizer error:', e);
      return;
    }
    // Record usage
    invoke('record_optimization_usage').catch(() => {});
    const displayOptimized = d.currentWord ? opt.optimized + d.currentWord : opt.optimized;

    // Send popup-update via Rust so it reaches all windows as a Tauri event
    invoke('emit_popup_update', { data: {
      app: d.app,
      original: d.text + (d.currentWord || ''),
      optimized: displayOptimized,
      stats: opt.stats,
      suggestions: opt.suggestions,
      method: d.method,
      sessionId: d.sessionId,
    }}).catch(() => {});

    // Auto-replace: wait until user STOPS typing (only in 'auto' mode)
    if (d.autoMode === 'auto' && !d.isDeleting && !d.autoReplaced && opt.optimized !== d.text) {
      if (_settleTimer) clearTimeout(_settleTimer);
      _settleTimer = setTimeout(async () => {
        _settleTimer = null;

        // Re-optimize fresh text
        const freshOpt = window._terseOptimizer.optimize(d.text);
        if (freshOpt.optimized === d.text) return;

        const fullReplacement = freshOpt.optimized + (d.currentWord || '');

        try {
          await invoke('replace_in_target', { text: fullReplacement });

          // Record stats
          const src = d.method === 'bridge' ? 'editor' : 'browser';
          invoke('record_optimization', {
            source: src,
            originalTokens: freshOpt.stats.originalTokens,
            optimizedTokens: freshOpt.stats.optimizedTokens,
          }).catch(() => {});

          // Update popup with final result
          invoke('emit_popup_update', { data: {
            app: d.app,
            original: d.text + (d.currentWord || ''),
            optimized: fullReplacement,
            stats: freshOpt.stats,
            suggestions: freshOpt.suggestions,
            method: 'auto-replace',
            sessionId: d.sessionId,
          }}).catch(() => {});
        } catch (e) {
          console.error('[terse] auto-replace error:', e);
        }
      }, SETTLE_DELAY);
    }
  });

  // Handle send-mode optimization (Enter key intercepted by key monitor)
  listen('send-mode-optimize', async (event) => {
    if (document.title !== 'Terse Popup') return;
    const d = event.payload;
    if (!window._terseOptimizer) return;

    const opt = window._terseOptimizer.optimize(d.text);
    if (opt.optimized !== d.text && opt.optimized.length >= 3) {
      try {
        await invoke('replace_in_target', { text: opt.optimized });
        // Brief delay for text replacement to settle, then send Enter
        await new Promise(r => setTimeout(r, 100));
        await invoke('send_enter', { pid: d.pid });

        const src = d.readMethod === 'bridge' ? 'editor' : 'browser';
        invoke('record_optimization', {
          source: src,
          originalTokens: opt.stats.originalTokens,
          optimizedTokens: opt.stats.optimizedTokens,
        }).catch(() => {});

        invoke('emit_popup_update', { data: {
          app: d.appName,
          original: d.text,
          optimized: opt.optimized,
          stats: opt.stats,
          suggestions: opt.suggestions,
          method: 'send-mode',
          sessionId: d.sessionId,
        }}).catch(() => {});
      } catch (e) {
        console.error('[terse] send-mode error:', e);
      }
    } else {
      // No optimization needed — just send Enter through
      invoke('send_enter', { pid: d.pid }).catch(() => {});
    }
  });

  // Handle manual capture — optimize and dispatch popup-update locally
  listen('captured-text', (event) => {
    if (document.title !== 'Terse Popup') return;
    const d = event.payload;
    if (!window._terseOptimizer) return;

    const opt = window._terseOptimizer.optimize(d.text);
    invoke('emit_popup_update', { data: {
      app: d.app,
      original: d.text,
      optimized: opt.optimized,
      stats: opt.stats,
      suggestions: opt.suggestions,
      method: d.method,
      sessionId: d.sessionId,
    }}).catch(() => {});
  });
}
