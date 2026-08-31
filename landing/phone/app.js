/**
 * app.js — the Terse phone web app.
 *
 * It renders the REAL wallpaper: the engine, the shaders and the style table are
 * the same files the Mac loads, served from /app-assets straight out of
 * src/renderer. Nothing here reimplements the look, and nothing here forks it.
 *
 * Three states, all of them supported on purpose:
 *   · signed out          → the field runs, nothing else does (the gate is up)
 *   · signed in, unpaired → field + rooms + plaza + friends. This is a complete
 *                           product, not a nag screen: someone who never owns a
 *                           Mac should still get the particles and the chat.
 *   · signed in, paired   → the field is driven by that machine's real agents.
 */
(function () {
  'use strict';

  var Rooms = window.TerseRooms;
  var T = window.terse;

  var $ = function (id) { return document.getElementById(id); };
  var on = function (el, ev, fn) { el && el.addEventListener(ev, fn); };

  // ── Strings ──────────────────────────────────────────────────────────────
  // A local dictionary rather than src/renderer/i18n.js: that file is ~900 lines
  // of desktop-app vocabulary of which this app would use none, and it is a
  // module the phone would pay to download on every cold start.
  var STR = {
    en: {
      brand: 'Terse',
      t_wallpaper: 'Wallpaper', t_plaza: 'Plaza', t_room: 'Room', t_friends: 'Friends', t_me: 'Me',
      k_today: 'Today', k_saved: 'Saved', k_agents: 'Agents',
      live_agents: 'Live agents', style: 'Style',
      pick_photo: 'Use my photo', clear_photo: 'Clear',
      keep_awake: 'Keep the screen awake while this tab is open',
      join_code: 'Join with a code', join: 'Join', create_room: 'Create a room',
      public_rooms: 'Public rooms', refresh: 'Refresh',
      plaza_empty: 'No open rooms right now.',
      room_none: 'You are not in a room.\nJoin one from the plaza.',
      leave: 'Leave', send: 'Send',
      friends_empty: "No friends yet.\nAdd someone from a room's roster.",
      devices: 'Your computers', pair: 'Link this phone',
      account: 'Account', upgrade: 'Upgrade', language: 'Language', sign_out: 'Sign out',
      install_title: 'Add to Home Screen',
      install_body: 'Tap the Share button in Safari, then “Add to Home Screen”. Installed, Terse opens without browser chrome and can send you notifications — neither works from a Safari tab on iPhone.',
      gate_title: 'Your agents, on your phone.',
      gate_body: 'Sign in to see the live wallpaper, your rooms and your friends.',
      sign_in: 'Sign in', wechat: 'Continue with WeChat', or: 'or',
      guest: 'Just look around',
      gate_note: 'The same account as the Mac app. Rooms need no account of their own.',
      not_linked: 'Not linked', linked_idle: 'asleep', guest_mode: 'Guest',
      no_agents: 'No agents running.',
      no_agents_unlinked: 'Link a computer to see your agents here. Everything else already works.',
      link_help_none: 'Open Terse on your Mac or PC, choose Link phone, and scan the code it shows — or type it in below.',
      link_help_some: 'Scanning another code adds a second computer.',
      pairing: 'Linking…', paired: 'Linked',
      pro_only: 'Pro', free_tag: 'Free plan · default style',
      leave_confirm: 'Leave this room?',
      you: 'You', locked: 'Pro style — upgrade to use it',
      photo_too_big: 'That photo is too large to store. Try a smaller one.',
      ask_to_join: 'ask to join', knocked: 'Asked to join — waiting for the owner',
      knock_declined: 'The owner declined',
      wechat_failed: 'WeChat sign-in did not complete',
      wall_title: 'iPhone wallpaper', copy: 'Copy', copied: 'Copied',
      wall_body: 'Home Screen and Lock Screen both work. A still image can go on either, and can keep itself up to date on a schedule. Motion is Lock Screen only — that is an iOS rule, not a Terse one: no app of any kind can animate the Home Screen.',
      wall_none: 'No frame captured yet',
      wall_capture: 'Capture from my wallpaper',
      wall_capturing: 'Rendering…', wall_uploading: 'Uploading…',
      wall_rotate: 'Reset this link',
      wall_rotated: 'Link reset — update it in your Shortcut',
      wall_failed: 'Could not capture the field on this device',
      wall_hidden: 'Keep Terse on screen while it captures',
      wall_video: 'Make it move (Live Photo)',
      wall_recording: 'Recording the field…',
      wall_video_ready: 'Video ready — build the Live Photo in Shortcuts',
      wall_video_unsupported: 'This browser cannot encode video — update iOS, or use the still above',
      wall_v1b: 'For MOTION, use the .mp4 link', wall_v1s: 'Same link with .mp4 instead of .png. A Live Photo is the only iPhone wallpaper that actually animates.',
      wall_v2b: 'Shortcut: Get Contents of URL → Make Live Photo → Save to Photos', wall_v2s: '“Make Live Photo” is built into Shortcuts — no extra app.',
      wall_v3b: 'Settings → Wallpaper → Add New → Photos → Live Photo', wall_v3s: 'Pick it, make sure the play button is on. It now plays every time you wake the phone.',
      wall_v4b: 'The Home Screen stays still', wall_v4s: 'Live wallpapers animate on the Lock Screen only. That is iOS, and it is the same for every app.',
      wall_never: 'never collected', wall_ago: 'collected {t} ago',
      wall_s1b: 'Copy the link above', wall_s1s: 'It is the picture itself, and it is the only credential — treat it like a password.',
      wall_s2b: 'Shortcuts → Automation → new automation', wall_s2s: 'Pick a trigger: a time of day, or when you unlock, or when charging starts.',
      wall_s3b: 'Add Get Contents of URL, paste the link', wall_s3s: 'Then add Set Wallpaper below it and choose Lock Screen, Home Screen, or both.',
      wall_s4b: 'Turn off Ask Before Running', wall_s4s: 'Otherwise it prompts every time and never runs on its own.',
      wall_s5b: 'To make it MOVE, shuffle an album instead', wall_s5s: 'Have the Shortcut Save to Album in a loop — each fetch returns a different moment of your field — then set that album as a Photo Shuffle wallpaper with Shuffle Frequency set to On Lock. iOS then changes it every time you pick the phone up.',
      wall_note: 'Only a still can be set this way. Live wallpapers are Live Photos, they animate on the Lock Screen only, and Shortcuts cannot set one — that limit is iOS, not Terse.',
      signed_out_note: 'Sign in to link a computer.',
      field_err: "The wallpaper isn't drawing on this device",
      field_no_frames: 'The graphics engine started but produced no frames.',
      field_details: 'Show details', field_copy: 'Copy details', field_copied: 'Copied',
      /* Romanised on purpose, in BOTH languages: the glyph layer rasterises a
         Latin typeface, so Chinese characters come out as empty boxes. */
      field_idle_1: 'Terse', field_idle_2: 'link a computer',
      wall_longpress: 'Quickest way: press and hold the picture above → Add to Photos. Then Settings → Wallpaper → Add New Wallpaper → Photos, and pick it. That is a real Home Screen and Lock Screen wallpaper, with no Shortcut at all. The steps below are only for keeping it up to date by itself.',
    },
    zh: {
      brand: 'Terse',
      t_wallpaper: '壁纸', t_plaza: '广场', t_room: '房间', t_friends: '好友', t_me: '我',
      k_today: '今日', k_saved: '已省', k_agents: '智能体',
      live_agents: '运行中的智能体', style: '风格',
      pick_photo: '使用我的照片', clear_photo: '清除',
      keep_awake: '本页打开时保持屏幕常亮',
      join_code: '用房间码加入', join: '加入', create_room: '创建房间',
      public_rooms: '公开房间', refresh: '刷新',
      plaza_empty: '现在还没有开放的房间。',
      room_none: '你还没有在任何房间里。\n去广场加入一个。',
      leave: '离开', send: '发送',
      friends_empty: '还没有好友。\n在房间成员列表里添加。',
      devices: '你的电脑', pair: '连接这台手机',
      account: '账号', upgrade: '升级', language: '语言', sign_out: '退出登录',
      install_title: '添加到主屏幕',
      install_body: '点 Safari 的分享按钮，选「添加到主屏幕」。装好之后 Terse 会像 App 一样全屏打开，也才能收到通知——在 Safari 标签页里这两样都用不了。',
      gate_title: '你的智能体，装进手机。',
      gate_body: '登录后即可看到实时壁纸、你的房间和好友。',
      sign_in: '登录 / 注册', wechat: '微信登录', or: '或',
      guest: '先随便看看',
      gate_note: '和 Mac 版同一个账号。房间本身不需要账号。',
      not_linked: '未连接', linked_idle: '休眠中', guest_mode: '访客',
      no_agents: '没有正在运行的智能体。',
      no_agents_unlinked: '连接一台电脑就能在这里看到你的智能体。其他功能现在就能用。',
      link_help_none: '在 Mac 或 Windows 上打开 Terse，选「连接手机」，扫描它显示的二维码——也可以在下面直接输入。',
      link_help_some: '再扫一个码就能加上第二台电脑。',
      pairing: '连接中…', paired: '已连接',
      pro_only: 'Pro', free_tag: '免费版 · 默认风格',
      leave_confirm: '确定离开这个房间？',
      you: '我', locked: 'Pro 风格 — 升级后可用',
      photo_too_big: '这张照片太大了，存不下。换一张小一点的。',
      ask_to_join: '申请加入', knocked: '已申请加入 — 等房主同意',
      knock_declined: '房主拒绝了',
      wechat_failed: '微信登录没有完成',
      wall_title: 'iPhone 壁纸', copy: '复制', copied: '已复制',
      wall_body: '主屏幕和锁屏都能用。静态图两个屏幕都能放，还能让它自己定时更新。会动的只有锁屏——这是 iOS 的规矩，不是 Terse 的：任何 App 都没法让主屏幕动起来。',
      wall_none: '还没有截过帧',
      wall_capture: '从我的壁纸截一帧',
      wall_capturing: '渲染中…', wall_uploading: '上传中…',
      wall_rotate: '重置这个链接',
      wall_rotated: '链接已重置——记得在快捷指令里换掉',
      wall_failed: '这台设备上截不了粒子场',
      wall_hidden: '截图时请让 Terse 保持在前台',
      wall_video: '让它动起来（Live Photo）',
      wall_recording: '正在录制粒子场…',
      wall_video_ready: '视频好了——去快捷指令里做成 Live Photo',
      wall_video_unsupported: '这个浏览器编不了视频——升级 iOS，或者用上面的静态图',
      wall_v1b: '要「动」就用 .mp4 那个链接', wall_v1s: '同一个链接，把 .png 换成 .mp4。Live Photo 是 iPhone 上唯一真的会动的壁纸。',
      wall_v2b: '快捷指令：获取 URL 内容 → 制作实况照片 → 存储到相册', wall_v2s: '「制作实况照片」是系统自带的，不用装别的 App。',
      wall_v3b: '设置 → 墙纸 → 添加新墙纸 → 照片 → 实况照片', wall_v3s: '选中它，确认播放按钮是开的。之后每次唤醒手机它都会动。',
      wall_v4b: '主屏幕还是静止的', wall_v4s: '动态壁纸只在锁屏动。这是 iOS 的规矩，所有 App 都一样。',
      wall_never: '还没被取过', wall_ago: '{t}前取过',
      wall_s1b: '复制上面的链接', wall_s1s: '它本身就是那张图，也是唯一的凭证——当密码看待。',
      wall_s2b: '快捷指令 → 自动化 → 新建', wall_s2s: '选一个触发条件：某个时间、解锁时、或者开始充电时。',
      wall_s3b: '加「获取 URL 内容」，粘贴链接', wall_s3s: '下面再加「设置墙纸」，选锁定屏幕、主屏幕，或者两个都选。',
      wall_s4b: '关掉「运行前询问」', wall_s4s: '不关的话每次都会弹窗，就不会自己跑了。',
      wall_s5b: '想让它「动」起来，就用相册轮播', wall_s5s: '让快捷指令循环「存储到相册」——每次抓取拿到的都是粒子场的不同瞬间——然后把那个相册设成「照片随机播放」壁纸，频率选「锁定时」。这样每次拿起手机，iOS 都会自己换一张。',
      wall_note: '这条路只能设静态图。动态壁纸是 Live Photo，只在锁屏动，而且快捷指令设不了——这是 iOS 的限制，不是 Terse 的。',
      signed_out_note: '登录后才能连接电脑。',
      field_err: '这台设备上壁纸没有画出来',
      field_no_frames: '图形引擎启动了，但一帧都没画出来。',
      field_details: '查看详情', field_copy: '复制详情', field_copied: '已复制',
      field_idle_1: 'Terse', field_idle_2: 'link a computer',
      wall_longpress: '最快的办法：长按上面那张图 →「存储到照片」。然后 设置 → 墙纸 → 添加新墙纸 → 照片，选它。这就是真正的主屏幕和锁屏壁纸，完全不用快捷指令。下面那些步骤只是为了让它自己定时更新。',
    },
  };

  var LS_LANG = 'terse-phone-lang';
  var lang = (function () {
    try { var v = localStorage.getItem(LS_LANG); if (v) return v; } catch (e) {}
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  })();
  function t(k) { return (STR[lang] && STR[lang][k]) || STR.en[k] || k; }

  function applyStrings() {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    var nodes = document.querySelectorAll('[data-t]');
    for (var i = 0; i < nodes.length; i++) {
      var s = t(nodes[i].getAttribute('data-t'));
      // \n in a string means a real line break in the UI, and these are all
      // plain labels, so innerText is both correct and safe.
      nodes[i].innerText = s;
    }
    if ($('langSel')) $('langSel').value = lang;
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  var fmt = function (n) {
    n = +n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n | 0);
  };

  // ── The wallpaper ────────────────────────────────────────────────────────

  var canvas = $('stage');
  var wp = null, Engine = null;
  var LS_STYLE = 'terse-phone-style';

  /* Mobile GPUs throttle hard: a field that opens at 60fps drops to a third of
     that within about half a minute of sustained rendering, and the phone gets
     hot doing it. So the phone runs its own quality tier — this is not the
     desktop's `quality`, which the memory note pins to its pre-refactor
     constants; that pin is about the DESKTOP cinematic values, and a phone
     rendering the desktop's particle count is not a truer wallpaper, just a
     slideshow. Pixel ratio is capped at 2 for the same reason. */
  function quality() {
    var px = Math.min(window.devicePixelRatio || 1, 2);
    var area = (window.innerWidth * window.innerHeight * px * px);
    if (area > 3.2e6) return 30;      // Pro Max at 3x
    if (area > 2.2e6) return 34;
    return 38;
  }

  function styleId() {
    try { return localStorage.getItem(LS_STYLE) || 'cinematic'; } catch (e) { return 'cinematic'; }
  }

  function mountEngine() {
    if (!Engine) return;
    if (wp) { try { wp.dispose(); } catch (e) {} wp = null; }
    // Deliberately NOT wrapped in try/catch: a constructor that throws is the
    // single most useful signal there is, and loadEngine's catch turns it into
    // something the user can read and send on.
    var pro = T.isPro();

    /* THE BED. This is why the phone looked empty.
       On the Mac the wallpaper window is TRANSPARENT and the user's real desktop
       picture shows through it; the engine only samples that image to colour its
       particles, it never draws it. A phone has no desktop picture, so the
       engine sampled nothing, the particles came out near-black on black, and
       the field read as "no particle effect at all" even though it was running
       perfectly. So the phone paints its own backdrop behind the canvas — the
       equivalent of the desktop showing through — and hands the engine the same
       image so the particle colours match what is behind them. */
    var bed = T.photo() || (window.TerseCapture && window.TerseCapture.defaultBed(
      Math.max(2, canvas.clientWidth || window.innerWidth || 390),
      Math.max(2, canvas.clientHeight || window.innerHeight || 844)));
    if (bed) {
      document.body.style.backgroundImage = 'url("' + bed + '")';
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
      document.body.style.backgroundRepeat = 'no-repeat';
      document.body.style.backgroundAttachment = 'fixed';
    }

    wp = new Engine(canvas, {
      theme: 'neon',
      quality: quality(),
      angle: 42,
      intensity: 1,
      style: pro ? styleId() : 'cinematic',
      // The engine pins a non-Pro caller to the default style itself; passing
      // `pro` honestly here is what makes that pin work, exactly as on the Mac.
      pro: pro,
      // Passed explicitly so the engine never falls through to
      // getDesktopPicture(), which on a phone answers with nothing.
      photo: bed || undefined,
    });
    // The constructor builds the scene but does NOT start the animation loop —
    // start() is a separate call, and without it the canvas stays black forever
    // with no error anywhere. The desktop wallpaper page calls it too.
    wp.start();

    /* The engine measures the canvas in its constructor and falls back to
       1920x1080 when the element has not been laid out yet — which is exactly
       what happens when the module resolves before first paint. It carries a
       ResizeObserver for this, but that only fires on a CHANGE, and a canvas
       that was already the right size on screen never changes. One explicit
       resize on the next frame pins the buffer to the real viewport. */
    requestAnimationFrame(function () { try { wp && wp.resize && wp.resize(); } catch (e) {} });

    // The field should say something immediately rather than waiting for the
    // next poll — the glyph text is most of what makes it feel alive.
    renderHUD();
  }

  /* iOS drops the WebGL context when the app is backgrounded and does not
     reliably restore it — the canvas comes back blank or frozen, and this is the
     single most likely way a page whose whole point is a persistent animation
     breaks. Both halves matter: preventDefault on `lost` is what allows a
     restore to happen at all, and the rebuild on `restored` is what actually
     puts pixels back. */
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); }, false);
  canvas.addEventListener('webglcontextrestored', function () { mountEngine(); }, false);

  /* Why the field is not drawing, if it is not drawing.
     Set by loadEngine; rendered by showFieldError. Kept as a string rather than
     a boolean because the useful part is always the REASON. */
  var fieldError = null;

  function showFieldError(reason) {
    fieldError = reason;
    var box = $('fieldErr');
    if (!box) return;
    box.classList.remove('hide');
    $('fieldErrWhy').textContent = reason;
  }

  function loadEngine() {
    // Dynamic, not static: a static import of a module that fails to
    // INSTANTIATE (not 404 — instantiate) takes the whole script down with no
    // catchable error, and the app would be a black screen with no explanation.
    //
    // Everything below exists because a blank field has four causes that look
    // identical and only two of them throw. See diag.js.
    var D = window.TerseDiag;
    if (D) D.startCapture();

    return import('/app-assets/mineradio-wallpaper.js')
      .then(function (m) {
        window.__terseDynImport = 'ok';
        if (!m || !m.default) throw new Error('engine module loaded but exported nothing');
        Engine = m.default;
        mountEngine();
        if (!wp) throw new Error('engine did not start');

        /* The silent case: a shader that fails to compile throws nothing at all.
           three.js logs it and then draws nothing, so the only way to know is to
           ask the renderer whether it has produced a frame. */
        if (D) {
          return D.watchFrames(wp, 2500).then(function (frames) {
            D.stopCapture();
            if (frames === null) return;             // renderer not reachable; leave it
            if (frames > 0) return;                  // drawing — nothing to report
            // A backgrounded page has its animation frames throttled to nothing,
            // so zero frames there means "not on screen", not "broken". Crying
            // wolf about that would train people to ignore this banner.
            if (document.visibilityState !== 'visible') return;
            var logged = D.captured().filter(function (l) { return /shader|program|compile|GL_|WebGL/i.test(l); });
            showFieldError(logged.length ? logged[0] : t('field_no_frames'));
          });
        }
      })
      .catch(function (err) {
        if (D) D.stopCapture();
        window.__terseDynImport = 'failed';
        var msg = (err && (err.message || err.name)) || String(err);
        if (D) D.push('threw: ' + msg);
        showFieldError(msg);
      });
  }

  // Wake lock. Supported on iOS since 16.4, and the long-standing bug that broke
  // it inside installed web apps was fixed in 18.4 — so it is worth asking for,
  // and worth re-asking after every resume, because the lock is dropped when the
  // page is hidden and is not restored on its own.
  var wakeLock = null, wantWake = false;
  function requestWake() {
    if (!wantWake || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  // ── HUD ──────────────────────────────────────────────────────────────────

  /* The readouts drawn INSIDE the field — the hovering agent tags, the rotating
     centre stage, the live log line — are the same derivation the Mac uses, from
     the same module. They are not decoration: `setStageItems` and `setAgentLog`
     are what the engine turns into PARTICLE TEXT, so a phone that never called
     them had the particles but none of the writing. */
  var HUD = null;
  import('/app-assets/wallpaper-hud.js')
    .then(function (m) { HUD = m; renderHUD(); })
    .catch(function (err) {
      // Not silent any more: without this module there is no particle text at
      // all, and a blank-looking field with no explanation is what sent this
      // whole investigation down the wrong path once already.
      if (window.TerseDiag) window.TerseDiag.push('hud import failed: ' + (err && err.message || err));
      showFieldError('overlay module failed to load — the field will have no text');
    });

  var AGENT_ICON = {
    claude: '✳️', 'claude-code': '✳️', cursor: '▹', codex: '◆', copilot: '⧉',
    windsurf: '≈', gemini: '✦', hermes: '⬡', 'deepseek-harness': '🐋', deepseek: '🐋',
  };

  var lastTotal = null;
  var lastSaved = null;

  function renderHUD() {
    var st = T.link.state();
    var frame = st.frame;
    var sessions = (frame && frame.sessions) || [];
    var stats = (frame && frame.stats) || {};
    var active = sessions.filter(function (a) { return a && a.connected !== false; });

    $('sTokens').textContent = fmt((+stats.tokensIn || 0) + (+stats.tokensOut || 0));
    // Overwritten below with the HUD's honest number once that module is up:
    // agent traffic never credits tokensSaved, so this alone reads a permanent 0.
    $('sSaved').textContent = fmt(+stats.tokensSaved || 0);
    $('sAgents').textContent = String(active.length);

    var list = $('agentList');
    list.innerHTML = '';
    active.slice(0, 6).forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'agent';
      var ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = a.agentIcon || AGENT_ICON[(a.agentType || '').toLowerCase()] || '🤖';
      var nm = document.createElement('span');
      nm.className = 'grow ell';
      nm.textContent = a.agentName || a.agentType || 'Agent';
      var rt = document.createElement('span');
      rt.className = 'rate mono';
      rt.textContent = (+a.burnRate > 0) ? (fmt(a.burnRate) + '/min') : '';
      row.appendChild(ic); row.appendChild(nm); row.appendChild(rt);
      list.appendChild(row);
    });
    var empty = $('agentEmpty');
    empty.textContent = active.length ? '' : (st.linked ? t('no_agents') : t('no_agents_unlinked'));
    empty.classList.toggle('hide', active.length > 0);

    // Drive the field itself, from the same derivation the Mac uses.
    if (wp && HUD) {
      var o = HUD.buildOverlays({
        stats: stats,
        sessions: sessions,
        tokens: lastTotal || 0,
        t: function (key, fallback) { return t(key) === key ? fallback : t(key); },
      });
      wp.setActivity(o.activity);
      wp.setAgents(o.agents);

      /* With no computer linked there is nothing to count, and the shared
         derivation honestly produces "0 tokens" — which is true, and useless as
         the one thing the field spells out. So an unlinked phone writes what is
         actually the case instead. Nothing is invented: the moment a machine is
         linked the real numbers take over again. */
      if (!st.linked && !sessions.length) {
        o.stage = [
          { k: 'Terse', v: t('field_idle_1'), u: '' },
          { k: 'Terse', v: t('field_idle_2'), u: '' },
        ];
        o.logGroups = [];
      }
      // The two that become particle text. setStageItems rate-limits itself to
      // one glyph every 12s inside the engine, so calling it on every poll is
      // how the rotation advances — not something to throttle out here.
      wp.setStageItems(o.stage);
      wp.setAgentLog(o.logGroups);
      // Savings rise out of the field as their own glyph, the same as on the Mac.
      if (lastSaved !== null && o.saved > lastSaved) wp.floatToken(o.saved - lastSaved, 'saved');
      lastSaved = o.saved;
      $('sSaved').textContent = fmt(o.saved);
    }

    // Pulse on real consumption, exactly like the desktop: diff a monotonic
    // total, never trust a per-frame number.
    T.getTokenPulse().then(function (total) {
      if (lastTotal === null) { lastTotal = total; return; }
      var d = total - lastTotal;
      lastTotal = total;
      if (d > 0 && wp) {
        wp.pulse(Math.min(1.8, 0.12 + Math.log10(1 + d) * 0.42));
        wp.floatToken(d, 'consume');
      }
    });

    renderChip();
  }

  function renderChip() {
    var st = T.link.state();
    var chip = $('linkChip'), txt = $('linkChipText');
    chip.classList.remove('live', 'idle');
    if (!st.signedIn) { txt.textContent = t('guest_mode'); return; }
    if (!st.linked) { txt.textContent = t('not_linked'); return; }
    var d = st.devices[0];
    var label = d.name || (d.device === 'windows' ? 'Windows' : 'Mac');
    if (st.live) { chip.classList.add('live'); txt.textContent = label; }
    else { chip.classList.add('idle'); txt.textContent = label + ' · ' + t('linked_idle'); }
  }

  // ── Style picker ─────────────────────────────────────────────────────────

  /* The English names come from wallpaper-styles.js itself (`en`), so they can
     never drift. The Chinese ones are copied from i18n.js's wps_*_n keys rather
     than read from it: that file installs a MutationObserver that retranslates
     the whole document by matching English text, and a 500ms poll that RELOADS
     the page whenever localStorage disagrees with it. Loading it here would
     fight this app's own strings and could reload it in a loop. */
  var STYLE_ZH = {
    cinematic: '电影级 · 粒子聚合', aurora: '极光 · 丝绸流', starfall: '星陨',
    ink: '水墨', neon: '霓虹', vortex: '漩涡', bloom: '绽放', zen: '静水 · 呼吸',
  };

  function renderStyles() {
    import('/app-assets/wallpaper-styles.js').then(function (m) {
      var grid = $('styleGrid');
      var pro = T.isPro();
      $('proTag').textContent = pro ? 'Pro' : t('free_tag');
      grid.innerHTML = '';
      m.PRO_STYLES.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'sty' + (styleId() === s.id && pro ? ' on' : '');
        // The swatch is the style's own two colours, so the grid reads as a set
        // of looks rather than a list of words — which is what a style is.
        var sw = document.createElement('span');
        sw.className = 'sw';
        if (s.swatch && s.swatch.length > 1) {
          sw.style.background = 'linear-gradient(135deg,' + s.swatch[0] + ',' + s.swatch[1] + ')';
        }
        b.appendChild(sw);
        var label = document.createElement('span');
        label.textContent = (lang === 'zh' && STYLE_ZH[s.id]) || s.en || s.id;
        b.appendChild(label);
        if (!pro && s.id !== 'cinematic') {
          var lk = document.createElement('span');
          lk.className = 'lock'; lk.textContent = '🔒';
          b.appendChild(lk);
        }
        b.onclick = function () {
          if (!pro) { toast(t('locked')); return; }
          try { localStorage.setItem(LS_STYLE, s.id); } catch (e) {}
          if (wp && wp.setStyle) wp.setStyle(s.id, null);
          renderStyles();
        };
        grid.appendChild(b);
      });
    }).catch(function () {});
  }

  // ── The user's own backdrop ──────────────────────────────────────────────

  on($('pickPhoto'), 'click', function () { $('photoInput').click(); });
  on($('photoInput'), 'change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    // Downscaled before storing. A modern iPhone photo is several megabytes and
    // localStorage is about five in total, so storing the original would fail —
    // and the engine only ever samples this at screen resolution anyway.
    var img = new Image();
    img.onload = function () {
      var max = 1600;
      var k = Math.min(1, max / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      var url = c.toDataURL('image/jpeg', 0.82);
      if (!T.setPhoto(url)) { toast(t('photo_too_big')); return; }
      URL.revokeObjectURL(img.src);
      $('clearPhoto').classList.remove('hide');
      mountEngine();
    };
    img.src = URL.createObjectURL(f);
  });
  on($('clearPhoto'), 'click', function () {
    T.setPhoto(null);
    $('clearPhoto').classList.add('hide');
    mountEngine();
  });

  on($('fieldErrShow'), 'click', function () {
    var dump = $('fieldErrDump');
    dump.textContent = window.TerseDiag ? window.TerseDiag.report() : (fieldError || '');
    dump.classList.toggle('hide');
  });
  on($('fieldErrCopy'), 'click', function () {
    var text = (fieldError ? 'reason: ' + fieldError + '\n\n' : '')
      + (window.TerseDiag ? window.TerseDiag.report() : '');
    // A phone has no console anyone can reach, so the report has to leave the
    // device some other way.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(t('field_copied')); },
        function () { $('fieldErrDump').textContent = text; $('fieldErrDump').classList.remove('hide'); });
    } else {
      $('fieldErrDump').textContent = text;
      $('fieldErrDump').classList.remove('hide');
    }
  });

  on($('keepAwake'), 'change', function (e) {
    wantWake = e.target.checked;
    if (wantWake) requestWake(); else releaseWake();
  });

  // ── Tabs ─────────────────────────────────────────────────────────────────

  var current = 'wallpaper';
  function show(tab) {
    current = tab;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.toggle('on', views[i].id === 'v-' + tab);
    var btns = document.querySelectorAll('nav button');
    for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('on', btns[j].dataset.tab === tab);
    // The wallpaper tab is the only one meant to be looked THROUGH; everywhere
    // else the field is a backdrop and the text has to win.
    $('scrim').classList.toggle('clear', tab === 'wallpaper');
    if (tab === 'plaza') loadPlaza();
    if (tab === 'friends') loadFriends();
    if (tab === 'room') renderRoom();
    if (tab === 'me') renderMe();
    try { history.replaceState(null, '', '/m/' + tab); } catch (e) {}
  }
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.onclick = function () { show(b.dataset.tab); };
  });

  // ── Plaza ────────────────────────────────────────────────────────────────

  function loadPlaza() {
    Rooms.plaza().then(function (d) {
      var rooms = (d && d.rooms) || [];
      var list = $('plazaList');
      list.innerHTML = '';
      $('plazaEmpty').classList.toggle('hide', rooms.length > 0);
      rooms.forEach(function (r) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'item';
        var av = document.createElement('span');
        av.className = 'av'; av.textContent = (r.name || 'R').slice(0, 1).toUpperCase();
        var box = document.createElement('span'); box.className = 'grow';
        var nm = document.createElement('b'); nm.className = 'ell'; nm.textContent = r.name || 'Room';
        var sub = document.createElement('span'); sub.className = 'tiny';
        sub.textContent = (r.members || 0) + ' · ' + (r.category || '');
        box.appendChild(nm); box.appendChild(sub);
        b.appendChild(av); b.appendChild(box);
        // A public listing withholds the CODE from people who are not already
        // in the room — handing out the credential would make "ask to join"
        // theatre. So there are two doors here, and only one of them is open:
        // walk straight back into a room you already hold a code for, and knock
        // on every other one.
        b.onclick = function () { if (r.code) doJoin(r.code); else doKnock(r); };
        if (!r.code) sub.textContent += ' · ' + t('ask_to_join');
        list.appendChild(b);
      });
    }).catch(function () { $('plazaEmpty').classList.remove('hide'); });
  }
  on($('plazaRefresh'), 'click', loadPlaza);

  function nickname() {
    var u = T.user();
    return Rooms.nickname() || (u && (u.firstName || (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress))) || 'Guest';
  }

  function doJoin(code) {
    if (!code) return;
    var u = T.user();
    Rooms.join(code, nickname(), u && u.primaryEmailAddress && u.primaryEmailAddress.emailAddress)
      .then(function () { connectRoom(); show('room'); })
      .catch(function (e) { toast(e.message || 'Could not join'); });
  }
  /* Knocking is asynchronous by nature: a person has to answer it. The poll
     stops on any settled answer, and after two minutes on no answer at all —
     leaving it running would keep a request alive against a room whose owner has
     already walked away from their screen. */
  function doKnock(room) {
    Rooms.knock(room.id, nickname()).then(function (d) {
      var kid = d && d.knock && d.knock.id;
      if (!kid) return;
      toast(t('knocked'));
      var until = Date.now() + 120000;
      var timer = setInterval(function () {
        if (Date.now() > until) { clearInterval(timer); return; }
        Rooms.knockStatus(kid).then(function (k) {
          if (!k || k.status === 'pending') return;
          clearInterval(timer);
          if (k.status === 'approved') { connectRoom(); show('room'); }
          else toast(t('knock_declined'));
        }).catch(function () { clearInterval(timer); });
      }, 3000);
    }).catch(function (e) { toast(e.message || '—'); });
  }

  on($('joinBtn'), 'click', function () { doJoin(($('joinCode').value || '').trim()); });
  on($('createRoomBtn'), 'click', function () {
    var u = T.user();
    Rooms.create(nickname() + "'s room", nickname(), u && u.primaryEmailAddress && u.primaryEmailAddress.emailAddress)
      .then(function () { connectRoom(); show('room'); })
      .catch(function (e) { toast(e.message || 'Could not create'); });
  });

  // ── Room ─────────────────────────────────────────────────────────────────

  var stopRoom = null;
  var roster = [];
  var myMemberId = null;

  function renderRoom() {
    var inRoom = Rooms.inRoom();
    $('roomNone').classList.toggle('hide', inRoom);
    $('roomLive').classList.toggle('hide', !inRoom);
    if (!inRoom) return;
    var st = Rooms.state();
    $('roomName').textContent = st.name || 'Room';
    $('roomCode').textContent = st.code || '';
  }

  function renderRoster(members) {
    roster = members || [];
    var box = $('roster');
    box.innerHTML = '';
    roster.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'row';
      var av = document.createElement('span');
      av.className = 'av'; av.style.width = av.style.height = '26px';
      av.textContent = (m.name || '?').slice(0, 1).toUpperCase();
      var nm = document.createElement('span');
      nm.className = 'grow ell muted';
      nm.textContent = (m.name || 'someone') + (m.member_id === myMemberId ? ' · ' + t('you') : '');
      row.appendChild(av); row.appendChild(nm);
      if (m.member_id !== myMemberId) {
        var add = document.createElement('button');
        add.type = 'button'; add.className = 'btn ghost'; add.style.minHeight = '32px';
        add.style.padding = '6px 11px'; add.textContent = '+';
        add.onclick = function () {
          Rooms.requestFriend(m.member_id)
            .then(function () { toast('✓'); add.disabled = true; })
            .catch(function (e) { toast(e.message || '—'); });
        };
        row.appendChild(add);
      }
      box.appendChild(row);
    });

    // Room members become peers in the particle field, exactly as they do on the
    // desktop — this is what makes an unlinked, agentless phone still worth
    // looking at.
    if (wp && wp.setPeers) {
      wp.setPeers(roster.map(function (m) { return { id: m.member_id, name: m.name || 'someone' }; }));
    }
  }

  function addMsg(m) {
    var box = $('msgs');
    var el = document.createElement('div');
    el.className = 'msg' + (m.member_id === myMemberId ? ' me' : '');
    var who = document.createElement('span');
    who.className = 'who'; who.textContent = m.name || 'someone';
    el.appendChild(who);
    el.appendChild(document.createTextNode(m.body || ''));
    box.appendChild(el);
    box.scrollIntoView({ block: 'end' });
    if (wp && wp.peerLog && m.member_id !== myMemberId) {
      wp.peerLog(m.member_id, m.name || 'someone', m.body || '', { max: 30 });
    }
  }

  function connectRoom() {
    if (stopRoom) { stopRoom(); stopRoom = null; }
    if (!Rooms.inRoom()) { renderRoom(); return; }
    stopRoom = Rooms.connect({
      onSnapshot: function (s) {
        myMemberId = s.you || null;
        renderRoom();
        renderRoster(s.members);
        $('msgs').innerHTML = '';
        (s.messages || []).forEach(addMsg);
      },
      onRoster: renderRoster,
      onMessage: addMsg,
      onClosed: function () { renderRoom(); toast('Room closed'); },
    });
    renderRoom();
  }

  on($('sendBtn'), 'click', sendChat);
  on($('chatInput'), 'keydown', function (e) { if (e.key === 'Enter') sendChat(); });
  function sendChat() {
    var v = ($('chatInput').value || '').trim();
    if (!v) return;
    $('chatInput').value = '';
    Rooms.sendMessage(v).catch(function (e) { toast(e.message || '—'); });
  }
  on($('leaveBtn'), 'click', function () {
    if (!confirm(t('leave_confirm'))) return;
    Rooms.leave().then(function () {
      if (stopRoom) { stopRoom(); stopRoom = null; }
      if (wp && wp.setPeers) wp.setPeers([]);
      renderRoom();
    });
  });

  // ── Friends ──────────────────────────────────────────────────────────────

  function loadFriends() {
    Rooms.listFriends().then(function (d) {
      // The server answers with three lists, not one: accepted friends, and the
      // pending requests in each direction. Reading only `friends` would hide
      // every incoming request — which is the one thing on this screen that
      // actually needs the user to do something.
      var fr = [].concat((d && d.incoming) || [], (d && d.friends) || [], (d && d.outgoing) || []);
      var list = $('friendList');
      list.innerHTML = '';
      $('friendEmpty').classList.toggle('hide', fr.length > 0);
      fr.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'item';
        var av = document.createElement('span');
        av.className = 'av'; av.textContent = (f.name || '?').slice(0, 1).toUpperCase();
        var box = document.createElement('span'); box.className = 'grow';
        var nm = document.createElement('b'); nm.className = 'ell'; nm.textContent = f.name || f.email || 'someone';
        var sub = document.createElement('span'); sub.className = 'tiny'; sub.textContent = f.status;
        box.appendChild(nm); box.appendChild(sub);
        row.appendChild(av); row.appendChild(box);
        if (f.status === 'pending' && f.direction === 'incoming') {
          var yes = document.createElement('button');
          yes.type = 'button'; yes.className = 'btn ghost'; yes.style.minHeight = '32px'; yes.textContent = '✓';
          yes.onclick = function () { Rooms.respondFriend(f.id, true).then(loadFriends); };
          row.appendChild(yes);
        }
        list.appendChild(row);
      });
    }).catch(function () { $('friendEmpty').classList.remove('hide'); });
  }

  // ── The actual iPhone wallpaper ───────────────────────────────────────────

  var wallState = null;

  function ago(iso) {
    if (!iso) return null;
    var ms = Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z');
    if (!isFinite(ms) || ms < 0) return null;
    var m = Math.round(ms / 60000);
    if (m < 1) return lang === 'zh' ? '刚刚' : 'just now';
    if (m < 60) return m + (lang === 'zh' ? ' 分钟' : 'm');
    var h = Math.round(m / 60);
    if (h < 48) return h + (lang === 'zh' ? ' 小时' : 'h');
    return Math.round(h / 24) + (lang === 'zh' ? ' 天' : 'd');
  }

  function renderWall() {
    var card = $('wallCard');
    if (!card) return;
    // The whole feature is per-account: the URL is minted for one, and the
    // capture is of that account's own styling and entitlement.
    card.classList.toggle('hide', !T.signedIn());
    if (!wallState) return;

    $('wallSetup').classList.toggle('hide', !wallState.url);
    // The .mp4 link once a video exists: it is the one that animates, so it is
    // the one worth copying.
    if (wallState.url) {
      $('wallUrl').value = (wallState.video && wallState.video_url) ? wallState.video_url : wallState.url;
    }

    var age = ago(wallState.fetched_at);
    $('wallAge').textContent = !wallState.ready ? ''
      : (wallState.frames + ' · ' + (age ? t('wall_ago').replace('{t}', age) : t('wall_never')));

    if (wallState.ready && wallState.url) {
      var prev = $('wallPrev');
      if (!prev.querySelector('img')) {
        var img = document.createElement('img');
        // Cache-busted: the endpoint sends no-store, but an <img> that already
        // painted will happily keep showing the old frame after a re-capture.
        img.src = wallState.url + '?v=' + Date.now();
        img.alt = '';
        prev.innerHTML = '';
        prev.appendChild(img);
      } else {
        prev.querySelector('img').src = wallState.url + '?v=' + Date.now();
      }
      $('wallSaveHint').classList.remove('hide');
    }
  }

  function loadWall() {
    if (!T.signedIn()) return Promise.resolve(null);
    return T.authToken().then(function (tok) {
      if (!tok) return null;
      return fetch('/api/cloud/wallpaper', { headers: { Authorization: 'Bearer ' + tok } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { wallState = j; renderWall(); return j; });
    }).catch(function () { return null; });
  }

  /* The glyph lines that go into the burst. Real numbers from the real snapshot,
     one per frame, so an album of these reads as the same wallpaper at different
     moments rather than six copies of one picture. */
  function wallTexts(ov) {
    var out = [];
    (ov && ov.stage || []).forEach(function (it) {
      out.push(((it.v != null ? it.v : '') + ' ' + (it.u || '')).trim());
    });
    (ov && ov.agents || []).forEach(function (a) {
      if (a.rate) out.push(a.name + ' ' + fmt(a.rate) + '/min');
    });
    var line = ov && ov.logGroups && ov.logGroups[0] && ov.logGroups[0].lines;
    var last = line && line[line.length - 1];
    if (last && (last.label || last.text)) out.push(last.label || last.text);
    return out.filter(Boolean);
  }

  on($('wallCapture'), 'click', function () {
    var btn = $('wallCapture');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t('wall_capturing');

    // Captured from the SAME overlay derivation the live field uses, so the
    // stills carry the real glyph text rather than an empty field.
    var st = T.link.state();
    var ov = HUD ? HUD.buildOverlays({
      stats: (st.frame && st.frame.stats) || {},
      sessions: (st.frame && st.frame.sessions) || [],
      tokens: lastTotal || 0,
      t: function (key, fallback) { return t(key) === key ? fallback : t(key); },
    }) : null;

    window.TerseCapture.capture({
      style: T.isPro() ? styleId() : 'cinematic',
      pro: T.isPro(),
      photo: T.photo(),
      overlays: ov,
      count: (wallState && wallState.slots) || 6,
      texts: wallTexts(ov),
      onStep: function (p, label) {
        btn.textContent = t('wall_capturing') + ' ' + (label || Math.round(p * 100) + '%');
      },
    }).then(function (res) {
      var blobs = (res && res.blobs) || [];
      if (!blobs.length) throw new Error('no frame');
      btn.textContent = t('wall_uploading');
      return T.authToken().then(function (tok) {
        // Sequential, not parallel: these are megabytes each, often over
        // cellular, and six at once is how a phone upload stalls.
        return blobs.reduce(function (chain, blob, i) {
          return chain.then(function () {
            btn.textContent = t('wall_uploading') + ' ' + (i + 1) + '/' + blobs.length;
            return fetch('/api/cloud/wallpaper?slot=' + i, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/png' },
              body: blob,
            }).then(function (r) {
              if (!r.ok) throw new Error('upload failed');
              return r.json();
            });
          });
        }, Promise.resolve());
      });
    }).then(function (j) {
      wallState = j;
      renderWall();
      toast('✓');
    }).catch(function (err) {
      // Being backgrounded is not a failure of the device — it is the one cause
      // the user can actually do something about, so it says so.
      toast(t(err && err.code === 'hidden' ? 'wall_hidden' : 'wall_failed'));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = t('wall_capture');
    });
  });

  on($('wallVideo'), 'click', function () {
    var btn = $('wallVideo');
    if (btn.disabled) return;
    if (!window.TerseCapture.canEncodeVideo()) { toast(t('wall_video_unsupported')); return; }
    btn.disabled = true;
    btn.textContent = t('wall_recording');

    var st = T.link.state();
    var ov = HUD ? HUD.buildOverlays({
      stats: (st.frame && st.frame.stats) || {},
      sessions: (st.frame && st.frame.sessions) || [],
      tokens: lastTotal || 0,
      t: function (key, fallback) { return t(key) === key ? fallback : t(key); },
    }) : null;

    window.TerseCapture.captureVideo({
      style: T.isPro() ? styleId() : 'cinematic',
      pro: T.isPro(),
      photo: T.photo(),
      overlays: ov,
      texts: wallTexts(ov),
      onStep: function (p, label) {
        btn.textContent = t('wall_recording') + ' ' + (label || Math.round(p * 100) + '%');
      },
    }).then(function (res) {
      return T.authToken().then(function (tok) {
        return fetch('/api/cloud/wallpaper/video?w=' + res.width + '&h=' + res.height, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'video/mp4' },
          body: res.blob,
        });
      });
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('upload failed');
      return r.json();
    }).then(function (j) {
      wallState = j;
      renderWall();
      toast(t('wall_video_ready'));
    }).catch(function (err) {
      var code = err && err.code;
      toast(t(code === 'hidden' ? 'wall_hidden'
        : (code === 'no-webcodecs' || code === 'no-codec') ? 'wall_video_unsupported'
        : 'wall_failed'));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = t('wall_video');
    });
  });

  on($('wallCopy'), 'click', function () {
    var v = $('wallUrl').value;
    if (!v) return;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
      .then(function () { toast(t('copied')); })
      .catch(function () { $('wallUrl').select(); });
  });

  on($('wallRotate'), 'click', function () {
    T.authToken().then(function (tok) {
      return fetch('/api/cloud/wallpaper/rotate', {
        method: 'POST', headers: { Authorization: 'Bearer ' + tok },
      });
    }).then(function (r) { return r.json(); })
      .then(function (j) { wallState = j; renderWall(); toast(t('wall_rotated')); })
      .catch(function () {});
  });

  function renderWallSteps() {
    var ol = $('wallSteps');
    if (!ol) return;
    ol.innerHTML = '';
    [['wall_s1b', 'wall_s1s'], ['wall_s2b', 'wall_s2s'], ['wall_s3b', 'wall_s3s'],
     ['wall_s4b', 'wall_s4s'], ['wall_s5b', 'wall_s5s'],
     ['wall_v1b', 'wall_v1s'], ['wall_v2b', 'wall_v2s'], ['wall_v3b', 'wall_v3s'], ['wall_v4b', 'wall_v4s']]
      .forEach(function (pair) {
        var li = document.createElement('li');
        var b = document.createElement('b'); b.textContent = t(pair[0]);
        var sp = document.createElement('span'); sp.textContent = ' ' + t(pair[1]);
        li.appendChild(b); li.appendChild(sp);
        ol.appendChild(li);
      });
    var note = document.createElement('li');
    note.className = 'note';
    note.textContent = t('wall_note');
    ol.appendChild(note);
  }

  // ── Me / linking ─────────────────────────────────────────────────────────

  function renderMe() {
    var u = T.user();
    $('meEmail').textContent = (u && u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || t('guest_mode');
    $('mePlan').textContent = T.isPro() ? 'Pro' : 'Free';
    $('upgradeBtn').classList.toggle('hide', T.isPro());
    $('signOutBtn').classList.toggle('hide', !u);

    var devices = T.link.devices();
    var box = $('deviceList');
    box.innerHTML = '';
    devices.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'item';
      var av = document.createElement('span');
      av.className = 'av'; av.textContent = d.device === 'windows' ? '⊞' : '';
      var g = document.createElement('span'); g.className = 'grow';
      var nm = document.createElement('b'); nm.className = 'ell';
      nm.textContent = d.name || (d.device === 'windows' ? 'Windows PC' : 'Mac');
      var sub = document.createElement('span'); sub.className = 'tiny';
      sub.textContent = d.live ? t('paired') : t('linked_idle');
      g.appendChild(nm); g.appendChild(sub);
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'btn ghost danger'; del.style.minHeight = '32px';
      del.style.padding = '6px 11px'; del.textContent = '✕';
      del.onclick = function () { T.link.unlink(d.id).then(renderMe); };
      row.appendChild(av); row.appendChild(g); row.appendChild(del);
      box.appendChild(row);
    });

    var signedIn = !!u;
    $('linkHelp').textContent = !signedIn ? t('signed_out_note')
      : devices.length ? t('link_help_some') : t('link_help_none');
    $('pairCode').classList.toggle('hide', !signedIn);
    $('pairBtn').classList.toggle('hide', !signedIn);

    renderWallSteps();
    renderWall();
    if (signedIn && !wallState) loadWall();
  }

  function claim(code) {
    if (!code) return;
    $('pairBtn').disabled = true;
    $('pairBtn').textContent = t('pairing');
    T.link.claim(code).then(function () {
      toast(t('paired'));
      $('pairCode').value = '';
      renderMe(); renderHUD();
    }).catch(function (e) {
      toast(e.message || '—');
    }).then(function () {
      $('pairBtn').disabled = false;
      $('pairBtn').textContent = t('pair');
    });
  }
  on($('pairBtn'), 'click', function () { claim(($('pairCode').value || '').trim()); });

  on($('upgradeBtn'), 'click', function () { location.href = '/#pricing'; });
  on($('signOutBtn'), 'click', function () {
    if (window.Clerk) window.Clerk.signOut().then(function () { location.href = '/m'; });
  });
  on($('langSel'), 'change', function (e) {
    lang = e.target.value;
    try { localStorage.setItem(LS_LANG, lang); } catch (err) {}
    applyStrings();
    renderHUD(); renderMe();
  });

  // ── Boot ─────────────────────────────────────────────────────────────────

  applyStrings();
  loadEngine();

  // A code scanned with the iPhone's own Camera app lands on /m/pair?c=CODE.
  // Deliberately not an in-page camera: the native scanner is one tap from the
  // lock screen, needs no permission prompt inside the app, and needs no QR
  // decoding library — and Safari has no BarcodeDetector to do it with anyway.
  var pending = null;
  (function () {
    var m = location.pathname.match(/^\/m\/pair/);
    var c = new URLSearchParams(location.search).get('c');
    if (m && c) pending = c;
  })();

  function afterAuth() {
    T.start().then(function () {
      renderHUD();
      renderStyles();
      if (pending) { claim(pending); pending = null; show('me'); }
    });
  }

  function openApp(signedIn) {
    $('gate').classList.add('hide');
    $('app').classList.remove('hide');
    if (T.photo()) $('clearPhoto').classList.remove('hide');
    connectRoom();
    renderStyles();
    // Painted for EVERY state, not just the signed-in one: the empty state is
    // the whole message for a guest ("link a computer to see your agents"), and
    // gating it behind sign-in left a silent, blank card.
    renderHUD();
    if (signedIn) afterAuth();
    var start = (location.pathname.match(/^\/m\/(wallpaper|plaza|room|friends|me)/) || [])[1];
    show(start || (pending ? 'me' : 'wallpaper'));
  }

  on($('guestBtn'), 'click', function () { openApp(false); });
  on($('signInBtn'), 'click', function () {
    if (window.Clerk) window.Clerk.openSignIn({ redirectUrl: location.pathname + location.search });
  });
  on($('wechatBtn'), 'click', function () {
    // Server-side redirect: the WeChat authorize URL needs the app id and a
    // signed state, and neither belongs in a page anyone can read.
    location.href = '/api/auth/wechat/start?redirect=' + encodeURIComponent(location.pathname);
  });

  // The link chip is a shortcut to the one screen that can change what it says.
  on($('linkChip'), 'click', function () { show('me'); });

  /* WeChat comes back with a single-use Clerk sign-in ticket in the URL. Redeem
     it BEFORE anything else looks at Clerk.user, or the app decides the visitor
     is signed out a moment before they are signed in. The ticket is stripped
     from the address bar either way: it is one-shot, and a reload carrying a
     spent one would look like a failure. */
  function redeemTicket(ticket) {
    return window.Clerk.client.signIn
      .create({ strategy: 'ticket', ticket: ticket })
      .then(function (res) { return window.Clerk.setActive({ session: res.createdSessionId }); })
      .then(function () { history.replaceState(null, '', '/m'); return true; })
      .catch(function () { history.replaceState(null, '', '/m'); toast(t('wechat_failed')); return false; });
  }

  // Clerk is loaded async; nothing that needs an account may run before this.
  window.addEventListener('load', function () {
    if (!window.Clerk) { openApp(false); return; }
    var q = new URLSearchParams(location.search);
    var ticket = q.get('ticket');
    if (q.get('wechat')) { history.replaceState(null, '', '/m'); toast(t('wechat_failed')); }

    window.Clerk.load()
      .then(function () { return ticket ? redeemTicket(ticket) : null; })
      .then(function () {
        if (window.Clerk.user) { openApp(true); return; }
        if (pending) {
          // Arriving from a scanned code while signed out: sign in FIRST, and
          // come back to this exact URL so the code is still in hand afterwards.
          window.Clerk.openSignIn({ redirectUrl: location.pathname + location.search });
        }
      })
      .catch(function () { openApp(false); });
  });

  // The WeChat button appears only where it can actually work: the credentials
  // are an enterprise 开放平台 account, not something every deployment has.
  fetch('/api/auth/wechat/config')
    .then(function (r) { return r.json(); })
    .then(function (c) { if (c && c.enabled) $('wechatBtn').classList.remove('hide'); })
    .catch(function () {});

  T.link.onChange(function () { renderHUD(); if (current === 'me') renderMe(); });

  // The HUD is redrawn on a timer as well as on every frame, because "how long
  // ago was the last push" changes with nothing arriving — a machine going to
  // sleep is a UI change with no event behind it.
  setInterval(function () { if (document.visibilityState === 'visible') renderHUD(); }, 5000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { if (wp) wp.stop(); return; }
    if (wp) wp.start();
    requestWake();
    // Rooms' own EventSource is subject to the same iOS silent-close as the link
    // stream, and rooms.js cannot fix it from inside: it never learns the app was
    // backgrounded. Reconnecting from out here is the only place that knows.
    if (Rooms.inRoom()) connectRoom();
    renderHUD();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})();
