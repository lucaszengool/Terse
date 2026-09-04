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

  // ── Doctor toggles → live optimizer ──
  // The Doctor's fixes write ~/.terse/doctor.json in Rust; the optimizer runs
  // here. This is the bridge between them, so "Enable cache-safe mode" actually
  // changes how the next prompt is optimized instead of just clearing a card.
  function syncDoctorSettings() {
    if (!window._terseOptimizer) return;
    invoke('get_doctor_settings').then((s) => {
      if (!s || !window._terseOptimizer) return;
      window._terseOptimizer.updateSettings({
        cacheSafeMode: !!s.cacheSafeMode,
        responseCache: !!s.responseCache,
        compression: !!s.compression,
      });
    }).catch(() => { /* no settings yet → optimizer keeps its defaults */ });
  }
  // The optimizer bundle loads after this file, so wait for it to appear.
  (function waitForOptimizer(tries) {
    if (window._terseOptimizer) { syncDoctorSettings(); return; }
    if ((tries || 0) < 100) setTimeout(() => waitForOptimizer((tries || 0) + 1), 60);
  })(0);

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
            reason: 'No active subscription. Start a free trial to use Terse.',
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
        invoke('record_optimization_usage').then(() => {
          // Emit event so all windows can update quota display live
          if (window.__TAURI__?.event?.emit) {
            window.__TAURI__.event.emit('quota-updated').catch(() => {});
          }
        }).catch(() => {});
        return result;
      }
      return { optimized: text, stats: { originalTokens: 0, optimizedTokens: 0, percentSaved: 0, techniquesApplied: [] }, suggestions: [] };
    },
    getSettings: () => invoke('get_settings'),
    updateSettings: (s) => invoke('update_settings', { s }),
    closeWindow: () => invoke('close_window'),
    minimizeWindow: () => invoke('minimize_window'),
    setAutoMode: (mode) => invoke('set_auto_mode', { mode }),
    requestAccessibility: () => invoke('request_accessibility'),
    checkAxPermission: () => invoke('check_ax_permission'),
    installBridge: () => invoke('install_bridge'),
    setPopupMinimized: (on) => invoke('set_popup_minimized', { on }),
    resizePopup: (h) => invoke('resize_popup', { h }),
    movePopupBy: (dx, dy) => invoke('move_popup_by', { dx, dy }),

    // Dynamic Island (灵动岛)
    showIslandWindow: () => invoke('show_island_window'),
    hideIslandWindow: () => invoke('hide_island_window'),
    islandSetExpanded: (expanded) => invoke('island_set_expanded', { expanded }),
    islandResize: (h) => invoke('island_resize', { h }),
    islandAlertSize: (w, h) => invoke('island_alert_size', { w, h }),
    focusApp: (app) => invoke('focus_app', { app }),
    focusIsland: (agentType) => invoke('focus_island', { agentType: agentType || null }),

    // Floating dashboard widget windows (saved · cache · focus · agents · compression · activity · savings)
    openDashboards: () => invoke('open_dashboards'),
    hideDashboards: () => invoke('hide_dashboards'),
    toggleDashboard: (kind) => invoke('toggle_dashboard', { kind }),
    tileDashboards: () => invoke('tile_dashboards'),
    dashboardsVisible: () => invoke('dashboards_visible'),

    // Agent Monitor
    getAgentDetections: () => invoke('get_agent_detections'),
    getAgentSessions: () => invoke('get_agent_sessions'),
    acceptAgent: (agentType) => invoke('accept_agent', { agentType }),
    dismissAgent: (agentType) => invoke('dismiss_agent', { agentType }),
    disconnectAgent: (agentType) => invoke('disconnect_agent', { agentType }),
    activateSession: (sessionId, agentType) => invoke('activate_session', { sessionId: sessionId || null, agentType: agentType || null }),
    analyzeAgentSession: (agentType) => invoke('get_agent_analytics', { agentType }),
    getAgentAnalytics: (agentType) => invoke('get_agent_analytics', { agentType }),
    getAgentPlanInfo: (agentType) => invoke('get_agent_plan_info', { agentType }),

    // Stats
    getStats: (period) => invoke('get_stats', { period }),
    getBudget: () => invoke('get_budget'),
    setBudget: (budget) => invoke('set_budget', { budget }),
    getBudgetStatus: () => invoke('get_budget_status'),
    getAttribution: (period) => invoke('get_agent_attribution', { period }),
    navigateToStats: () => invoke('navigate_to_stats'),
    navigateBack: () => invoke('navigate_back'),

    // Doctor (360-style health scanner)
    doctorScan: (period) => invoke('doctor_scan', { period: period || null }),
    cleanupScan: () => invoke('cleanup_scan'),
    cleanupClean: (paths) => invoke('cleanup_clean', { paths }),
    speedModeStatus: () => invoke('speed_mode_status'),
    setSpeedMode: (enabled) => invoke('set_speed_mode', { enabled }),
    // After a fix lands, push the new toggles straight into the live optimizer —
    // otherwise the setting only takes effect on the next app launch and the fix
    // looks like it did nothing.
    doctorApplyFix: (finding) =>
      invoke('doctor_apply_fix', { finding }).then((r) => { syncDoctorSettings(); return r; }),
    doctorDismiss: (id) => invoke('doctor_dismiss', { id }),
    showDoctorWindow: () => invoke('show_doctor_window'),
    hideDoctorWindow: () => invoke('hide_doctor_window'),
    navigateToDoctor: () => invoke('navigate_to_doctor'),
    showMainWindow: () => invoke('show_main_window'),

    // Prompt library + palette (⌘⇧K)
    showPalette: () => invoke('show_palette'),
    hidePalette: () => invoke('hide_palette'),
    insertPromptText: (text) => invoke('insert_prompt_text', { text }),
    listPrompts: () => invoke('list_prompts'),
    getPrompt: (id) => invoke('get_prompt', { id }),
    savePrompt: (prompt) => invoke('save_prompt', { prompt }),
    deletePrompt: (id) => invoke('delete_prompt', { id }),
    recordPromptUse: (id) => invoke('record_prompt_use', { id }),

    // Live token wallpaper (desktop-pinned)
    navigateToWallpaper: () => invoke('navigate_to_wallpaper'),
    getWallpaperConfig: () => invoke('get_wallpaper_config'),
    // 用户当前那张真桌面壁纸(1920 宽 JPEG data URL)—— mineradio 引擎的底图
    getDesktopPicture: (force) => invoke('get_desktop_picture', { force: !!force }),
    setWallpaperConfig: (config) => invoke('set_wallpaper_config', { config }),
    setWallpaperEnabled: (on) => invoke('set_wallpaper_enabled', { on }),
    // Pro: lift the particles above every window (or drop them back to the
    // desktop layer). Re-levels the live window immediately.
    setWallpaperOverlay: (on) => invoke('set_wallpaper_overlay', { on }),
    relevelWallpaperWindow: (on) => invoke('relevel_wallpaper_window', { on }),
    wallpaperOverlayEffective: () => invoke('wallpaper_overlay_effective'),
    // 用户此刻真的开着的那些窗口(app 名 + 屏幕位置尺寸)。壁纸设置页的「始终置顶」
    // 演示拿它画真实窗口,而不是两个假白框。macOS 走 CGWindowList,不需要录屏权限。
    listOpenWindows: () => invoke('list_open_windows'),
    // 桌面图标的矩形。3D 壁纸靠它判断"这一下是拖画面还是点文件"。拿不到就是空数组,
    // 调用方据此**不接管鼠标** —— 宁可少一个功能,也不能让人点不动自己的文件。
    desktopIconRects: () => invoke('desktop_icon_rects'),

    // ── 项目粒子 ──
    // 一个项目文件夹被压成一颗"胶囊"(标题 + 96px 封面 + 几行信息),壁纸拿它把项目
    // 演成一段粒子缩影。上传的也是这颗胶囊 —— 别人在自己机器上生成同样的粒子,
    // 服务器只存 JSON,不渲染、不转码。
    navigateToProjects: () => invoke('navigate_to_projects'),
    // 文件夹选择器复用知识图谱那条已经在用的命令 —— 不给同一件事开第二条路。
    pickFolder: () => invoke('graph_pick_folder'),
    projectList: () => invoke('project_list'),
    projectCandidates: () => invoke('project_candidates'),
    projectAdd: (path) => invoke('project_add', { path }),
    projectUpdate: (id, patch) => invoke('project_update', { id, patch }),
    projectRemove: (id) => invoke('project_remove', { id }),
    projectPreview: (capsule, ms) => invoke('project_preview', { capsule, ms: ms || null }),
    projectCapsule: (id) => invoke('project_capsule', { id }),
    // 某个进程所属 app 的图标(PNG data URL)。不需要任何权限 —— 「始终置顶」演示卡
    // 靠它让人一眼认出"这是我的窗口"(窗口内容截不了,见 lib.rs 的 app_icon)。
    appIcon: (pid, size) => invoke('app_icon', { pid, size: size || null }),
    // 3D 自由视角在桌面上打开/关闭:把壁纸抬到图标层之上并变透明,或放回桌面层。
    wallpaperSet3dMode: (on) => invoke('wallpaper_set_3d_mode', { on }),
    // 壁纸窗口是穿透鼠标的,所以要主动告诉原生侧"这块矩形是热区";光标进去时那边
    // 才会临时把窗口交给鼠标。见 lib.rs 的 wallpaper_set_hot_rect。
    wallpaperSetHotRect: (x, y, w, h) => invoke('wallpaper_set_hot_rect', { x, y, w, h }),

    // 社交消息(消息中心 + 壁纸上的消息层)
    messagesStatus: () => invoke('messages_status'),
    messagesRecent: (limit, chatOnly) => invoke('messages_recent', { limit: limit ?? null, chatOnly: chatOnly ?? null }),
    messagesDetectedApps: () => invoke('messages_detected_apps'),
    messagesSetAppOnWallpaper: (appId, on) => invoke('messages_set_app_on_wallpaper', { appId, on }),
    messagesForWallpaper: (limit) => invoke('messages_for_wallpaper', { limit: limit ?? null }),
    messagesOpenChat: (appId, target) => invoke('messages_open_chat', { appId, target }),
    messagesSendOpen: (appId, text) => invoke('messages_send_open', { appId, text }),
    messagesNotificationSettings: () => invoke('messages_notification_settings'),
    messagesPermissionReport: () => invoke('messages_permission_report'),
    messagesOpenSettings: (which) => invoke('messages_open_settings', { which }),

    // 手机端配对(Terse phone web app)
    phonePair: () => invoke('phone_pair'),
    phoneStatus: () => invoke('phone_status'),
    phoneSetShare: (on) => invoke('phone_set_share', { on }),
    phoneUnlink: () => invoke('phone_unlink'),
    // Write a line into the same ~/.terse/<name>.log the Rust side uses. Only
    // the native half of the overlay was ever observable, which is why four
    // rounds of reading the screenshot guessed wrong — a black screen looks the
    // same whether the page painted it or the compositor did. Windows-only for
    // now; elsewhere the invoke rejects and callers already swallow that.
    diagNote: (name, line) => invoke('diag_note', { name, line }),
    getTokenPulse: () => invoke('get_token_pulse'),

    // Session history
    navigateToHistory: () => invoke('navigate_to_history'),
    listSessionHistory: (period) => invoke('list_session_history', { period: period || null }),
    getSessionHistory: (id) => invoke('get_session_history', { id }),
    deleteSessionHistory: (id) => invoke('delete_session_history', { id }),
    clearSessionHistory: () => invoke('clear_session_history'),

    // Alert Center (unified notifications)
    navigateToAlerts: () => invoke('navigate_to_alerts'),
    getAlertSettings: () => invoke('get_alert_settings'),
    setAlertSettings: (settings) => invoke('set_alert_settings', { settings }),
    getRecentAlerts: () => invoke('get_recent_alerts'),
    markAlertsRead: () => invoke('mark_alerts_read'),
    clearAlerts: () => invoke('clear_alerts'),
    dispatchAlert: (kind, title, body, severity) => invoke('dispatch_alert', { kind, title, body, severity }),
    snoozeAlertKind: (kind, minutes) => invoke('snooze_alert_kind', { kind, minutes }),
    toastAction: (action) => invoke('toast_action', { action }),
    // Budget guardrail / circuit breaker
    getCircuitSettings: () => invoke('get_circuit_settings'),
    setCircuitSettings: (settings) => invoke('set_circuit_settings', { settings }),
    getCircuitTrips: () => invoke('get_circuit_trips'),
    circuitResume: (sessionId) => invoke('circuit_resume', { sessionId }),

    // Cowork (team collaboration)
    navigateToCowork: () => invoke('navigate_to_cowork'),
    getCoworkConfig: () => invoke('get_cowork_config'),
    setCoworkToken: (token) => invoke('set_cowork_token', { token }),
    setCoworkShareLogs: (enabled) => invoke('set_cowork_share_logs', { enabled }),
    setCoworkShareStats: (enabled) => invoke('set_cowork_share_stats', { enabled }),
    clearCoworkToken: () => invoke('clear_cowork_token'),
    openCloudTeams: (path) => invoke('open_cloud_teams', { path: path || null }),
    openUrl: (url) => invoke('open_url', { url }),
    sendSlackAlert: (webhook, text) => invoke('send_slack_alert', { webhook, text }),

    // Pets (Phase 1 — picker + foundation)
    getPetState: () => invoke('get_pet_state'),
    pickStarterPet: (petId) => invoke('pick_starter_pet', { petId }),
    unlockPet: (petId) => invoke('unlock_pet', { petId }),
    markPetPurchased: (petId) => invoke('mark_pet_purchased', { petId }),
    equipPet: (petId) => invoke('equip_pet', { petId }),
    unlockSkin: (petId, skinId) => invoke('unlock_skin', { petId, skinId }),
    equipSkin: (petId, skinId) => invoke('equip_skin', { petId, skinId }),
    setPetSettings: (settings) => invoke('set_pet_settings', { settings }),

    // Buy a pet via Stripe $1 checkout: opens system browser, polls until paid.
    buyPet: async (petId) => {
      const API_BASE = 'https://www.terseai.org';
      const auth = await invoke('get_auth');
      const clerkUserId = auth?.clerkUserId;
      const clerkUserEmail = auth?.email;
      if (!clerkUserId) throw new Error('Not signed in — please sign in first');

      let res;
      try {
        res = await fetch(`${API_BASE}/api/pet-checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ petId, clerkUserId, clerkUserEmail }),
        });
      } catch (netErr) {
        throw new Error('Could not reach server — check your connection and try again');
      }
      if (!res.ok) {
        let msg = `Server error (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const { url } = await res.json();

      // Open Stripe checkout in system browser
      try { await window.__TAURI__.shell.open(url); } catch { window.open(url, '_blank'); }

      // Poll for ownership confirmation (up to 8 min)
      return new Promise((resolve, reject) => {
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          if (attempts > 96) { clearInterval(poll); reject(new Error('Payment not confirmed after 8 minutes')); return; }
          try {
            const r = await fetch(`${API_BASE}/api/pet-owned/${clerkUserId}`);
            const data = await r.json();
            if ((data.pets || []).includes(petId)) {
              clearInterval(poll);
              await invoke('mark_pet_purchased', { petId });
              resolve();
            }
          } catch {}
        }, 5000);
      });
    },

    // Sync all server-purchased pets to local pet_store (call on startup).
    syncPetPurchases: async () => {
      const API_BASE = 'https://www.terseai.org';
      try {
        const auth = await invoke('get_auth');
        const clerkUserId = auth?.clerk_user_id;
        if (!clerkUserId) return;
        const r = await fetch(`${API_BASE}/api/pet-owned/${clerkUserId}`);
        const data = await r.json();
        for (const petId of (data.pets || [])) {
          await invoke('mark_pet_purchased', { petId });
        }
      } catch (e) { console.warn('[terse] syncPetPurchases failed:', e); }
    },
    // Pet window (Phase 2)
    showPetWindow: () => invoke('show_pet_window'),
    hidePetWindow: () => invoke('hide_pet_window'),
    // Farm window
    showFarmWindow: () => invoke('show_farm_window'),
    // The room's chat lives in a real window: the wallpaper sits below Finder's
    // desktop-icon layer, so nothing drawn on it can ever be clicked.
    showRoomWindow: (focus) => invoke('show_room_window', { focus: focus !== false }),
    hideRoomWindow: () => invoke('hide_room_window'),
    // MCP Manager (Secure)
    mcpList: () => invoke('mcp_list'),
    mcpSetEnabled: (sourcePath, name, enabled) => invoke('mcp_set_enabled', { sourcePath, name, enabled }),
    // Session Timeline + replay (Observe)
    getSessionTimeline: (agentType) => invoke('get_session_timeline', { agentType: agentType || null }),
    exportSessionReplay: (agentType) => invoke('export_session_replay', { agentType: agentType || null }),
    // Rules / Memory Manager (Remember)
    claudeMdList: () => invoke('claude_md_list'),
    claudeMdRead: (path) => invoke('claude_md_read', { path }),
    claudeMdWrite: (path, content) => invoke('claude_md_write', { path, content }),
    // Connection Doctor
    connectivityScan: () => invoke('connectivity_scan'),
    connectivityFixAll: () => invoke('connectivity_fix_all'),
    hideFarmWindow: () => invoke('hide_farm_window'),
    navigateToFarm: () => invoke('navigate_to_farm'),

    // Knowledge Graph
    navigateToGraph: () => invoke('navigate_to_graph'),
    graphStatus: (path) => invoke('graph_status', { path: path || null }),
    graphBuild: (path) => invoke('graph_build', { path: path || null }),
    graphGet: (path) => invoke('graph_get', { path: path || null }),
    graphList: () => invoke('graph_list'),
    graphAddFolder: (path) => invoke('graph_add_folder', { path }),
    graphRemove: (path) => invoke('graph_remove', { path }),
    graphSaveOverlay: (overlay, path) => invoke('graph_save_overlay', { overlay, path: path || null }),
    graphWriteDigest: (path) => invoke('graph_write_digest', { path: path || null }),
    graphSetWatch: (enabled, path) => invoke('graph_set_watch', { enabled, path: path || null }),

    // Hook (RTK-style compression)
    checkAgentHook: () => invoke('check_agent_hook'),
    getHookStats: () => invoke('get_hook_stats'),
    petWorkDetected: (savedEstimate, toolName) => invoke('pet_work_detected', { savedEstimate, toolName: toolName || '' }),

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
    getDoctorSettings: () => invoke('get_doctor_settings'),
    setClerkUser: (clerkUserId) => invoke('set_clerk_user', { clerkUserId }),
    verifyLicense: (clerkUserId) => invoke('verify_license_remote', { clerkUserId }),
    checkCanOptimize: () => invoke('check_can_optimize'),
    requestUpgrade: (reason) => invoke('request_upgrade', { reason: reason || null }),
    getReferralInfo: () => invoke('get_referral_info'),
    redeemReferralCode: (code) => invoke('redeem_referral_code', { code }),
    trialGraceStatus: () => invoke('trial_grace_status'),
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

/* ── Decoration runs only while the page is actually being looked at ────────
   Every window that loads this bridge gets the class; that is the fix for the
   version of this I shipped in styles.css, which gated on a class only app.js
   set and so froze six pages permanently.

   Two further safeguards, because the failure mode of getting this wrong is an
   invisible page rather than a slow one:
     · only INFINITE animations are paused. Entrance animations are finite and
       many start at opacity:0 with a fill-mode, which is exactly what was
       getting frozen. They are marked by the .decor-loop class below.
     · the class is added on load, so the default state is RUNNING. If this
       script never executes, nothing is paused and nothing can hide. */
(function decorOnlyWhenVisible() {
  const upd = () => {
    // VISIBILITY only, not focus.
    //
    // Seven windows are created at launch and never destroyed — palette,
    // wallpaper, pet, farm, doctor, island, toast — and most sit hidden the
    // whole session while their webviews keep animating. document.hidden is
    // exactly that state, so gating on it stops the real waste.
    //
    // Focus is deliberately NOT part of this. The island is always-on-top and
    // almost never focused; requiring focus would freeze the one window whose
    // animation is the point of it.
    document.documentElement.classList.toggle('page-awake', !document.hidden);
  };
  upd();
  window.addEventListener('focus', upd);
  window.addEventListener('blur', upd);
  document.addEventListener('visibilitychange', upd);
})();
