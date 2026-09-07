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
  /** The cache-busting suffix for anything loaded out of /app-assets. Every one
   *  of those modules needs it: the stamp is the only thing that tells a CDN
   *  the file changed. */
  var stamp = function () {
    return window.__TERSE_BUILD ? '?v=' + encodeURIComponent(window.__TERSE_BUILD) : '';
  };
  var on = function (el, ev, fn) { el && el.addEventListener(ev, fn); };

  // ── Strings ──────────────────────────────────────────────────────────────
  // A local dictionary rather than src/renderer/i18n.js: that file is ~900 lines
  // of desktop-app vocabulary of which this app would use none, and it is a
  // module the phone would pay to download on every cold start.
  var STR = {
    en: {
      brand: 'Terse',
      gate_live: 'The field is already running',
      gate_hook: 'Touch it.', gate_hook_sub: 'This is what your agents will look like.', t_field: 'Field', t_plaza: 'Plaza', t_room: 'Room', t_friends: 'Friends', t_me: 'Me',
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
      you: 'You', locked: 'Pro style — upgrade to use it', field_hide: 'Hide',
      ps_title: 'What Pro adds', ps_cta: 'See plans',
      ps_typo_t: 'Particle typography', ps_typo_d: 'Your numbers gather out of the field, then scatter.',
      ps_3d_t: 'Free 3D view', ps_3d_d: 'Drag to turn it, pinch to move closer. It is a place, not a picture.',
      ps_sty_t: '8 particle styles', ps_sty_d: 'Eight different choreographies, not eight colour swaps.',
      ps_thm_t: 'Themes + fine-tune', ps_thm_d: 'Density, angle and intensity on top of any style.',
      pro_style_t: '{name} is a Pro style', pro_style_d: 'Eight choreographies, and the field keeps whichever you pick.',
      pro_3d_t: 'Turning the field is Pro', pro_3d_d: 'Drag to look around it, pinch to move closer, double-tap to recentre.',
      pro_see: 'See plans', pro_later: 'Not now',
      field_turn_free: 'Turning the field is a Pro feature.',
      photo_too_big: 'That photo is too large to store. Try a smaller one.',
      ask_to_join: 'ask to join', knocked: 'Asked to join — waiting for the owner',
      knock_declined: 'The owner declined',
      wechat_failed: 'WeChat sign-in did not complete',
      wall_title: 'Your agents, as a field', copy: 'Copy', copied: 'Copied',
      wall_body: 'Every agent on your linked machine becomes light in this field — the busier they are, the harder it moves, and what it spells out is what they are actually burning. It lives while this app is open. Drag to turn it.',
      wall_none: 'No frame captured yet',
      wall_capture: 'Capture from my wallpaper',
      wall_capturing: 'Rendering…', wall_uploading: 'Uploading…',
      wall_rotate: 'Reset this link',
      wall_rotated: 'Link reset — update it in your Shortcut',
      wall_failed: 'Could not capture the field on this device',
      wall_blank: 'Uploaded — but the field drew nothing, so those frames are blank',
      wall_hidden: 'Keep Terse on screen while it captures',
      wall_video: 'Live Photo (may not animate)',
      wall_recording: 'Recording the field…',
      wall_video_ready: 'Video ready — build the Live Photo in Shortcuts',
      wall_video_unsupported: 'This browser cannot encode video — update iOS, or use the still above',
      wall_v1b: 'The .mp4 link, and an honest warning', wall_v1s: 'Apple’s own engineers say a Live Photo BUILT by software (rather than captured by the camera) often shows “Motion not available” and can only be set as a still. It may work on your device; it may not, and nobody outside Apple can make it. The loop above is the route that reliably moves.',
      wall_v2b: 'Shortcut: Get Contents of URL → Make Live Photo → Save to Photos', wall_v2s: '“Make Live Photo” is built into Shortcuts — no extra app.',
      wall_v3b: 'Settings → Wallpaper → Add New → Photos → Live Photo', wall_v3s: 'Pick it, make sure the play button is on. It now plays every time you wake the phone.',
      wall_v4b: 'And the Home Screen never moves', wall_v4s: 'Even a Live Photo that does animate does so on the Lock Screen only. That is iOS, and it is the same for every app, native ones included.',
      wall_never: 'never collected', wall_ago: 'collected {t} ago',
      wall_s1b: 'Copy the link above', wall_s1s: 'It is the picture itself, and it is the only credential — treat it like a password.',
      wall_s2b: 'Shortcuts → + → new shortcut', wall_s2s: 'Just a shortcut, not an automation. How it fires is the next section, and the cheapest answer there is two knocks on the back of the phone.',
      wall_s3b: 'Add Get Contents of URL, paste the link', wall_s3s: 'Then add Set Wallpaper Photo below it — that is its exact name — and choose Lock Screen, Home Screen, or both.',
      wall_s4b: 'Turn off Ask Before Running', wall_s4s: 'Otherwise it prompts every time and never runs on its own.',
      wall_s5b: 'To make it MOVE, shuffle an album instead', wall_s5s: 'Have the Shortcut Save to Album in a loop — each fetch returns a different moment of your field — then set that album as a Photo Shuffle wallpaper with Shuffle Frequency set to On Lock. iOS then changes it every time you pick the phone up.',
      wall_note: 'Only a still can be set this way. Live wallpapers are Live Photos, they animate on the Lock Screen only, and Shortcuts cannot set one — that limit is iOS, not Terse.',
      signed_out_note: 'Sign in to link a computer.',
      field_err: "The wallpaper isn't drawing on this device",
      field_no_frames: 'The graphics engine started but produced no frames.',
      field_details: 'Show details', field_copy: 'Copy details', field_copied: 'Copied',
      /* Romanised on purpose, in BOTH languages: the glyph layer rasterises a
         Latin typeface, so Chinese characters come out as empty boxes. */
      field_idle_1: 'Terse', field_idle_2: 'scan to connect',
      field_peek: 'Controls',
      pz_rooms: 'Rooms', pz_projects: 'Projects', pz_published: 'Published projects',
      pz_tap_hint: 'Tap one and it plays in the field.', pz_none: 'Nothing published yet.',
      pz_playing: 'Playing {name} in the field',
      pz_liked: 'Liked', pz_saved: 'Saved',
      pj_no_city: 'No code city in this one. It was published before the plaza carried them — its owner can press Rescan in Terse on their Mac and publish it again.',
      pj_tap_like: 'Double-tap to like',
      prev_free: 'Free',
      feed_files: 'files', feed_buildings: 'buildings', feed_hint: 'Swipe for the next ↑',
      plan_title: 'Choose a plan', plan_sub: 'Everything in Pro, whichever length suits you.',
      plan_note: 'Cancel anytime. Prices in USD.',
      plan_signin: 'Sign in first — a subscription needs an account to live on.',
      plan_failed: 'Could not start checkout. Try again in a moment.',
      plan_save: 'BEST VALUE',
      plan_month_n: 'Monthly', plan_month_d: 'Billed every month', plan_month_p: '$4.99', plan_month_u: '/month',
      plan_quarter_n: 'Every 3 months', plan_quarter_d: 'Billed quarterly, about $4 a month', plan_quarter_p: '$12', plan_quarter_u: '/quarter',
      plan_year_n: 'Yearly', plan_year_d: 'Billed once a year, about $1.33 a month', plan_year_p: '$15.99', plan_year_u: '/year',
      plan_life_n: 'Lifetime', plan_life_d: 'One payment. Nothing to cancel, ever.', plan_life_p: '$25.99', plan_life_u: 'once',
      pj_no_engine: 'The particle field is not running on this device, so there is nothing to play the project in.',
      pj_broke: 'The project could not be drawn: {why}',
      pj_nothing: 'The project could not be drawn on this device.',
      cmt_title: 'Comments', cmt_empty: 'Nothing said yet.', cmt_reply: 'Reply',
      cmt_reply_to: 'Replying to {name} · tap to cancel', cmt_delete: 'Delete',
      fr_friends: 'Friends', fr_chats: 'Messages',
      fr_my_code: 'Your friend code',
      fr_my_code_p: 'Send it to someone and they can add you. Anyone who has it can.',
      fr_share: 'Share', copy: 'Copy', copied: 'Copied',
      fr_add: 'Find someone by ID', fr_add_btn: 'Add', fr_added: 'Added {name}',
      fr_add_empty: 'Type an ID first', fr_add_self: 'That is your own code',
      fr_chat: 'Message', fr_accept: 'Accept',
      fr_find: 'Find', fr_add_p: 'Type or paste their ID. You see who it is before you add them.',
      fr_none: 'No one has that ID. Codes can be revoked — ask them for a fresh one.',
      fr_already: 'Already your friend', fr_remove: 'Remove',
      fr_remove_ask: 'Remove {name} from your friends?',
      dm_failed: 'Not sent — tap to try again',
      dm_empty: 'No messages yet.<br>Tap ✉ on someone\u2019s project, or on a friend.',
      dm_gate: 'Your first message goes with the project you tapped — that is what lets it through.',
      dm_no_reason: 'You can only write to someone about a project they published — open one of theirs first.',
      dm_sent: 'Sent', dm_someone: 'someone', dm_about: 'about {name}',
      pair_bar: 'Link a computer to see your agents here', pair_bar_go: 'Link →',
      signin_first: 'Sign in first',
      sig_touch: 'touches', sig_here: 'here', sig_screen: 'screen', sig_cores: 'cores',
      sig_memory: 'memory', sig_zone: 'zone', sig_day: 'day', sig_open: 'open', sig_installed: 'installed',
      wall_overlay: 'Keep my own wallpaper, add the text',
      wall_overlaying: 'Making the layer…',
      wall_overlay_ready: 'Layer ready — build the Overlay shortcut below',
      wall_o1b: 'Put your wallpaper photo in an album', wall_o1s: 'Photos → the picture you actually use → add it to an album of its own. iOS gives no app a way to READ your current wallpaper, so this is how Terse knows what it is.',
      wall_o2b: 'Shortcut: Get Contents of URL (the .overlay.png link)', wall_o2s: 'That layer is the particles and the text on nothing — fully transparent behind them.',
      wall_o3b: 'Add Overlay Image', wall_o3s: 'Base = the photo from your album, overlay = what you just fetched. Then Set Wallpaper Photo.',
      wall_o4b: 'Trigger it on unlock', wall_o4s: 'Automation → Personal → When I unlock iPhone. That is the closest iOS gets to continuous: fresh numbers every time you pick the phone up.',
      pc_title: 'Have Terse push it, instead of waiting for you',
      pc_body: 'Everything above waits for you — a Shortcut runs when you unlock or open an app, because iOS gives a server no way in. Pushcut is a third-party app whose Automation Server runs a shortcut from a web request, so Terse can refresh the wallpaper the moment an agent starts working. Paste its execute URL: Terse fires it at most once a minute, and only while something is actually running.',
      pc_save: 'Save', pc_test: 'Test', pc_off: 'Remove',
      pc_saved: 'Saved', pc_fired: 'Fired — your phone should update',
      pc_failed: 'Pushcut did not answer. Is the Automation Server running?',
      pc_cost: '⚠ The Automation Server is a paid feature of Pushcut — their subscription, not ours. Everything else in Terse works without it; this only buys you a wallpaper that refreshes while the phone is in your pocket.',
      pc_1b: 'Install Pushcut and subscribe to Pushcut Pro',
      pc_1s: 'The Automation Server does not run on the free tier. This is the step that costs money, and it is the only one.',
      pc_2b: 'Pushcut → Automation Server → Start Server On This Device',
      pc_2s: 'It is meant for a spare device that is always on and plugged in. On the phone you carry, it runs while Pushcut is open or the phone is charging — so overnight and at your desk, not all day.',
      pc_3b: 'Copy the execute URL',
      pc_3s: 'Tap the URL cell to copy it. It looks like https://api.pushcut.io/SECRET/execute?shortcut=Name — the path IS the secret, so treat it like a password.',
      pc_4b: 'Paste it above, Save, then Test',
      pc_4s: 'Test fires immediately and ignores the rate limit, so you get an answer instead of a wait. Your wallpaper should run a burst within a second or two.',
      pc_5b: 'What Terse does with it',
      pc_5s: 'Fires at most once a minute, and only while an agent is actually burning tokens — an idle machine would spend the quota refreshing the same numbers. Nothing is sent until you paste a URL here.',

      la_title: 'Put your agents in the Dynamic Island',
      la_body: 'A Live Activity can only be created by a native app — a web page cannot start one on any iPhone, so this pushes to one that already can. Install ActivitySmith, pair the device, make an API key on their site with the same email, and paste it here. Terse then updates the Island on every frame your Mac sends. Their app, their branding, their free tier; nothing here runs until you paste a key.',
      la_save: 'Save', la_test: 'Test', la_off: 'Remove',
      la_saved: 'Saved — try Test', la_pushed: 'Pushed — look at your Island',
      la_failed: 'That did not go through',
      la_on: 'Live Activity via {name}', la_last: 'last update {t}', la_never: 'no update yet',
      pip_title: 'Float the field over your other apps',
      pip_body: 'Picture in Picture is the only way anything a web page draws can sit on top of other apps on iOS. Terse can put the particle field in that floating window: start it, go back to your Home Screen, and it stays up there. It is a rounded video window with playback controls, not a transparent layer — iOS gives no app permission to draw over another, and this is the one exception. What plays is a recorded loop, not live numbers.',
      pip_why_standalone: 'iOS refuses Picture in Picture inside a Home Screen app, so this opens Safari. Terse itself stays here, and so do your notifications.',
      pip_why_browser: 'You are in Safari, where Picture in Picture works.',
      pip_start: 'Start floating',
      pc_on: 'On · {shortcut}', pc_never: 'never fired yet', pc_last: 'last fired {t}',
      wall_deploy: 'Deploy to my iPhone',
      wall_deploy_note: 'Renders the wallpaper and puts it on your account. One step is left that no app can do for you — iOS lets nothing but you set a wallpaper — and Terse shows exactly what it is once this is done.',
      wall_adv: 'Other ways to use it',
      wall_deployed: 'Done — here is the one step left',
      wall_frames: '{n} frames',
      ip_lock: 'Lock Screen', ip_home: 'Home Screen', ip_day: 'Monday, 1 September',
      wall_pickbed: 'Backdrop — it lights the particles',
      field_turn: 'Drag to turn it. Pinch to move closer. Double-tap to recentre.',
      wall_bed_photo: 'My photo',
      wall_capturing_auto: 'Building your wallpaper…',
      wall_bed_done: 'Ready — now set it up below, once',
      wall_ok: 'Wallpaper rebuilt',
      wall_auto_h: 'Make it update by itself',
      wall_a1b: 'Wrap the two actions in Repeat', wall_a1s: 'Repeat 20 times → Get Contents of URL → Set Wallpaper Photo → Wait 2 seconds. Every fetch returns a different moment of your field, so this really is a two-second loop.',
      wall_a2b: 'Why 20 and not forever', wall_a2s: 'iOS stops a background shortcut after roughly 30–60 seconds. Twenty rounds fills that. Asking for more does not run longer, it just gets cut off.',
      wall_open_shortcuts: 'Open Shortcuts',
      wall_g_loop: 'Step one — build the shortcut',
      wall_g_trigger: 'How it fires — pick one',
      wall_t1b: 'Back Tap — two knocks on the back of the phone',
      wall_t1s: 'Settings → Accessibility → Touch → Back Tap → Double Tap → pick your Terse shortcut. Three screens, once, and from then on you knock the back of the phone twice and the wallpaper runs another burst. This is the one to use.',
      wall_t2b: 'Action Button (iPhone 15 Pro and later)',
      wall_t2s: 'Settings → Action Button → swipe to Shortcut → pick yours. One press of the side button.',
      wall_t3b: 'Control Centre or the Lock Screen',
      wall_t3s: 'Add a Shortcuts control and it is one tap from anywhere, without unlocking.',
      wall_t4b: 'An automation, if you want it to run untouched',
      wall_t4s: 'Shortcuts → Automation → App → Is Opened, pick apps you use all day, and turn OFF “Ask Before Running”. It is six screens deep and cannot be shared or synced between devices — that is Apple’s limit, not ours — but it is the only trigger that needs nothing from you afterwards.',
      wall_t5b: 'Why any of them is enough',
      wall_t5s: 'The shortcut loops for about 40 seconds each time it runs, which is as long as iOS lets anything run in the background. Whichever trigger you pick, one tap buys you 40 seconds of live wallpaper.',
      wall_g_own: 'Or: keep your own wallpaper, add only the text',
      wall_g_live: 'Or: a Live Photo (may not animate)',
      wall_getshortcut: 'Add the Terse shortcut',
      wall_getshortcut_note: 'Tap it and Shortcuts opens with the whole loop already built. Its URL field is left EMPTY on purpose — a shared shortcut carries whatever link was in it, and that link is your credential. Yours is already on your clipboard: open the Get Contents of URL step and paste.',
      ins_title: 'Add Terse to your Home Screen',
      ins_sub: 'Opens like an app · keeps you signed in',
      ins_body_prompt: 'One tap. It opens without browser chrome, stays signed in, and can send you notifications.',
      ins_body_safari: 'Two taps in Safari. Installed, Terse opens without browser chrome, stays signed in, and can send you notifications — none of which work from a tab.',
      ins_body_other: 'This browser cannot install web apps on iPhone — only Safari can. Open this link in Safari and the option appears.',
      ins_step_share: 'Tap Share in the Safari toolbar',
      ins_step_add: 'Choose “Add to Home Screen”',
      ins_install: 'Install', ins_copy: 'Copy the link', ins_copied: 'Copied — now paste it in Safari',
      ins_dismiss: 'Not now', ins_show: 'Show me how',
      ins_already: 'Already installed',
      push_title: 'Notifications',
      push_body: 'Terse can tell you when an agent is waiting on you, or a budget is about to break. Only things worth interrupting for — not every step it takes.',
      push_enable: 'Turn on notifications', push_test: 'Send a test', push_off: 'Turn off',
      push_on: 'on', push_blocked: 'blocked in Settings', push_unsupported: 'not supported here',
      push_need_install: 'Add Terse to your Home Screen first — iPhone only delivers notifications to an installed web app, never a Safari tab.',
      push_sent: 'Sent — check your Lock Screen', push_failed: 'Could not turn notifications on',
      push_denied: 'You declined notifications. Turn them back on in iOS Settings → Terse → Notifications.',
      wall_longpress: 'Quickest way: press and hold the picture above → Add to Photos. Then Settings → Wallpaper → Add New Wallpaper → Photos, and pick it. That is a real Home Screen and Lock Screen wallpaper, with no Shortcut at all. The steps below are only for keeping it up to date by itself.',
    },
    zh: {
      brand: 'Terse',
      gate_live: '粒子场已经在跑了',
      gate_hook: '碰一下。', gate_hook_sub: '你的智能体跑起来就是这个样子。', t_field: '场', t_plaza: '广场', t_room: '房间', t_friends: '好友', t_me: '我',
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
      you: '我', locked: 'Pro 风格 — 升级后可用', field_hide: '收起',
      ps_title: 'Pro 能多给你什么', ps_cta: '看看方案',
      ps_typo_t: '粒子字', ps_typo_d: '你的数字从场里聚出来,再散回去。',
      ps_3d_t: '3D 自由视角', ps_3d_d: '拖着转,捏合拉近 —— 它是一个地方,不是一张图。',
      ps_sty_t: '8 种粒子风格', ps_sty_d: '八套不同的编舞,不是八次换色。',
      ps_thm_t: '主题 + 微调', ps_thm_d: '在任何风格之上再调密度、角度和强度。',
      pro_style_t: '「{name}」是 Pro 风格', pro_style_d: '八套编舞,选了哪套场就一直是哪套。',
      pro_3d_t: '转动这片场是 Pro 功能', pro_3d_d: '拖着看四周,捏合拉近,双击回正。',
      pro_see: '看看方案', pro_later: '以后再说',
      field_turn_free: '转动这片场是 Pro 功能。',
      photo_too_big: '这张照片太大了，存不下。换一张小一点的。',
      ask_to_join: '申请加入', knocked: '已申请加入 — 等房主同意',
      knock_declined: '房主拒绝了',
      wechat_failed: '微信登录没有完成',
      wall_title: '你的智能体，一片粒子场', copy: '复制', copied: '已复制',
      wall_body: '你连上的那台机器里，每一个智能体都会变成这片场里的光——跑得越凶，场动得越厉害，浮出来的数字就是它们真实烧掉的量。它只在这个 App 开着的时候活着。拖一下可以转动它。',
      wall_none: '还没有截过帧',
      wall_capture: '从我的壁纸截一帧',
      wall_capturing: '渲染中…', wall_uploading: '上传中…',
      wall_rotate: '重置这个链接',
      wall_rotated: '链接已重置——记得在快捷指令里换掉',
      wall_failed: '这台设备上截不了粒子场',
      wall_blank: '传上去了——但粒子场没画出来，这几帧是空的',
      wall_hidden: '截图时请让 Terse 保持在前台',
      wall_video: 'Live Photo（可能不会动）',
      wall_recording: '正在录制粒子场…',
      wall_video_ready: '视频好了——去快捷指令里做成 Live Photo',
      wall_video_unsupported: '这个浏览器编不了视频——升级 iOS，或者用上面的静态图',
      wall_v1b: '.mp4 链接，以及一句实话', wall_v1s: '苹果自己的工程师说：软件「做」出来的实况照片（不是相机拍的）经常会显示「动态效果不可用」，只能当静态壁纸用。你的设备上可能行，也可能不行，苹果之外没人能保证。上面那个循环才是真正稳定会动的方案。',
      wall_v2b: '快捷指令：Get Contents of URL → 制作实况照片 → 存储到相册', wall_v2s: '「制作实况照片」是系统自带的，不用装别的 App。',
      wall_v3b: '设置 → 墙纸 → 添加新墙纸 → 照片 → 实况照片', wall_v3s: '选中它，确认播放按钮是开的。之后每次唤醒手机它都会动。',
      wall_v4b: '而且主屏幕永远不会动', wall_v4s: '就算实况照片真的动起来了，也只在锁屏动。这是 iOS 的规矩，所有 App 都一样，原生 App 也一样。',
      wall_never: '还没被取过', wall_ago: '{t}前取过',
      wall_s1b: '复制上面的链接', wall_s1s: '它本身就是那张图，也是唯一的凭证——当密码看待。',
      wall_s2b: '快捷指令 → + → 新建快捷指令', wall_s2s: '就建一条普通快捷指令，不是自动化。怎么触发它是下一节的事，而那里最省事的答案是敲两下手机背面。',
      wall_s3b: '加 Get Contents of URL，粘贴链接', wall_s3s: '下面再加 Set Wallpaper Photo，选锁定屏幕、主屏幕，或者两个都选。⚠️ 快捷指令的动作列表在中文系统下也是英文的，按中文名搜不到——照上面的英文名搜。',
      wall_s4b: '关掉「运行前询问」', wall_s4s: '不关的话每次都会弹窗，就不会自己跑了。',
      wall_s5b: '想让它「动」起来，就用相册轮播', wall_s5s: '让快捷指令循环「存储到相册」——每次抓取拿到的都是粒子场的不同瞬间——然后把那个相册设成「照片随机播放」壁纸，频率选「锁定时」。这样每次拿起手机，iOS 都会自己换一张。',
      wall_note: '这条路只能设静态图。动态壁纸是 Live Photo，只在锁屏动，而且快捷指令设不了——这是 iOS 的限制，不是 Terse 的。',
      signed_out_note: '登录后才能连接电脑。',
      field_err: '这台设备上壁纸没有画出来',
      field_no_frames: '图形引擎启动了，但一帧都没画出来。',
      field_details: '查看详情', field_copy: '复制详情', field_copied: '已复制',
      field_idle_1: 'Terse', field_idle_2: '扫码连接',
      field_peek: '设置',
      pz_rooms: '房间', pz_projects: '项目', pz_published: '已发布的项目',
      pz_tap_hint: '点一个，它会在场里演一遍。', pz_none: '还没有人发布项目。',
      pz_playing: '正在场里播放 {name}',
      pz_liked: '已赞', pz_saved: '已收藏',
      pj_no_city: '这个项目里没有代码城市。它是在广场开始携带城市之前发布的 —— 作者在 Mac 上点一次「重新扫描」再重新发布,城市就有了。',
      pj_tap_like: '双击点赞',
      prev_free: '免费版',
      feed_files: '个文件', feed_buildings: '座楼', feed_hint: '上滑看下一个 ↑',
      plan_title: '选一个方案', plan_sub: 'Pro 的功能都一样,只是买多久。',
      plan_note: '随时可取消。价格为美元。',
      plan_signin: '先登录 —— 订阅要挂在一个账号上。',
      plan_failed: '没能打开支付页面,稍后再试。',
      plan_save: '最划算',
      plan_month_n: '按月', plan_month_d: '每月扣一次', plan_month_p: '$4.99', plan_month_u: '/月',
      plan_quarter_n: '按季', plan_quarter_d: '每三个月一次,约合每月 $4', plan_quarter_p: '$12', plan_quarter_u: '/季',
      plan_year_n: '按年', plan_year_d: '一年一次,约合每月 $1.33', plan_year_p: '$15.99', plan_year_u: '/年',
      plan_life_n: '买断', plan_life_d: '付一次,永远是你的,不用取消。', plan_life_p: '$25.99', plan_life_u: '一次性',
      pj_no_engine: '这台设备上粒子场没跑起来,所以没有地方演这个项目。',
      pj_broke: '这个项目没能画出来:{why}',
      pj_nothing: '这个项目在这台设备上没能画出来。',
      cmt_title: '评论', cmt_empty: '还没有人说话。', cmt_reply: '回复',
      cmt_reply_to: '正在回复 {name} · 点一下取消', cmt_delete: '删除',
      fr_friends: '好友', fr_chats: '私信',
      fr_my_code: '你的好友码',
      fr_my_code_p: '发给谁，谁就能加你。拿到它的人都能加。',
      fr_share: '分享', copy: '复制', copied: '已复制',
      fr_add: '按 ID 找人', fr_add_btn: '添加', fr_added: '已加 {name}',
      fr_add_empty: '先输入一个 ID', fr_add_self: '这是你自己的码',
      fr_chat: '发消息', fr_accept: '同意',
      fr_find: '查找', fr_add_p: '输入或粘贴对方的 ID。加之前先看清是谁。',
      fr_none: '没有人用这个 ID。码是可以撤销的 —— 找他要一个新的。',
      fr_already: '已经是好友了', fr_remove: '删除',
      fr_remove_ask: '把 {name} 从好友里删掉?',
      dm_failed: '没发出去 —— 点一下重试',
      dm_empty: '还没有私信。<br>在别人的项目上点 ✉，或者在好友那一行点。',
      dm_gate: '第一条消息会挂在你刚点的那个项目上 —— 它就是通行的由头。',
      dm_no_reason: '给陌生人发消息要有由头：只能就他发布过的项目说话，先去打开他的一个项目。',
      dm_sent: '已发送', dm_someone: '某人', dm_about: '关于 {name}',
      pair_bar: '连一台电脑，你的 agent 就会出现在这里', pair_bar_go: '去连接 →',
      signin_first: '请先登录',
      sig_touch: '触碰', sig_here: '停留', sig_screen: '屏幕', sig_cores: '核心',
      sig_memory: '内存', sig_zone: '时区', sig_day: '今天', sig_open: '已开', sig_installed: '已安装',
      sig_day_mon: '周一', sig_day_tue: '周二', sig_day_wed: '周三', sig_day_thu: '周四',
      sig_day_fri: '周五', sig_day_sat: '周六', sig_day_sun: '周日',
      wall_overlay: '保留我自己的壁纸，只加字',
      wall_overlaying: '正在做图层…',
      wall_overlay_ready: '图层好了——照下面建 Overlay 快捷指令',
      wall_o1b: '把你的壁纸原图放进一个相册', wall_o1s: 'Photos → 你现在真正在用的那张 → 单独建个相册放进去。iOS 不给任何 App 读取当前壁纸的接口，所以只能这样让 Terse 知道它是哪张。',
      wall_o2b: '快捷指令：Get Contents of URL（.overlay.png 那个链接）', wall_o2s: '那个图层只有粒子和字，背后是全透明的。',
      wall_o3b: '加一步 Overlay Image', wall_o3s: '底图 = 相册里那张，叠加 = 刚抓下来的。然后 Set Wallpaper Photo。',
      wall_o4b: '用「解锁时」触发', wall_o4s: '自动化 → 个人 → 解锁 iPhone 时。这是 iOS 能做到的最接近「实时」的程度：每次拿起手机，数字都是新的。',
      pc_title: '让 Terse 主动推，而不是等你',
      pc_body: '上面那些都在等你——快捷指令要等你解锁或者打开某个 App 才跑，因为 iOS 不给服务器任何入口。Pushcut 是个第三方 App，它的自动化服务器能被一个网络请求唤起去跑快捷指令，所以 Terse 可以在智能体刚开始干活的那一刻就刷新壁纸。把它的 execute 链接粘进来：Terse 最快一分钟触发一次，而且只在真的有东西在跑的时候。',
      pc_save: '保存', pc_test: '测试', pc_off: '移除',
      pc_saved: '已保存', pc_fired: '已触发 —— 手机应该会更新',
      pc_failed: 'Pushcut 没有响应。自动化服务器开着吗？',
      pc_cost: '⚠ 自动化服务器是 Pushcut 的付费功能——是他们的订阅，不是我们的。Terse 其他所有功能不用它也能跑；它买到的只是「手机揣在兜里时壁纸也会刷新」。',
      pc_1b: '装 Pushcut，并订阅 Pushcut Pro',
      pc_1s: '自动化服务器在免费档不能用。这是唯一要花钱的一步。',
      pc_2b: 'Pushcut → Automation Server → Start Server On This Device',
      pc_2s: '它本来是给一台常年开机插电的备用设备用的。装在你随身那台上，只有 Pushcut 开着或者手机在充电时才跑——也就是过夜和在桌上的时候，不是全天。',
      pc_3b: '复制 execute 链接',
      pc_3s: '点那一行就能复制。形如 https://api.pushcut.io/密钥/execute?shortcut=名字 —— 路径本身就是密钥，当密码看待。',
      pc_4b: '粘到上面，保存，然后点「测试」',
      pc_4s: '「测试」会立刻触发、并且无视频率限制，所以你马上能看到结果。一两秒内壁纸就该跑一轮。',
      pc_5b: 'Terse 会怎么用它',
      pc_5s: '最快一分钟一次，而且只在真的有 agent 在烧 token 的时候——机器闲着的话，刷新同样的数字纯属浪费额度。你不粘链接，这里什么都不会发。',

      la_title: '把你的智能体放进灵动岛',
      la_body: '灵动岛只有原生 App 能创建——网页在任何 iPhone 上都起不了，所以这里是推给一个已经做到的 App。装 ActivitySmith、配对设备、用同一个邮箱在它网站上建一个 API key，粘到这里。之后你 Mac 每推一帧，Terse 就更新一次灵动岛。它是别人的 App、别人的品牌、别人的免费额度；不粘 key 这里什么都不会跑。',
      la_save: '保存', la_test: '测试', la_off: '移除',
      la_saved: '已保存——点「测试」试试', la_pushed: '推出去了——看一眼灵动岛',
      la_failed: '没成功',
      la_on: '灵动岛（{name}）', la_last: '最近更新 {t}', la_never: '还没推过',
      pip_title: '把粒子场浮在其他 App 上',
      pip_body: '画中画是 iOS 上唯一能让网页内容盖在别的 App 上面的办法。Terse 可以把粒子场放进那个悬浮窗：开启之后回到主屏幕，它会一直浮着。那是一个带播放控件的圆角视频窗口，不是透明图层——iOS 不给任何 App 画在别的 App 上的权限，画中画是唯一的例外。里面播的是一段录好的循环，不是实时数字。',
      pip_why_standalone: 'iOS 在主屏幕 App 里禁用画中画，所以这一步会跳到 Safari。Terse 本身留在这里，通知也不受影响。',
      pip_why_browser: '你现在在 Safari 里，画中画可以用。',
      pip_start: '开始悬浮',
      pc_on: '已开启 · {shortcut}', pc_never: '还没触发过', pc_last: '上次触发 {t}',
      wall_deploy: '部署到我的 iPhone',
      wall_deploy_note: '渲染壁纸并存到你的账号上。最后还剩一步是任何 App 都替你做不了的——iOS 只允许你本人设置壁纸——做完这步 Terse 会明确告诉你那一步是什么。',
      wall_adv: '其他用法',
      wall_deployed: '好了 —— 就剩这一步',
      wall_frames: '{n} 帧',
      ip_lock: '锁屏', ip_home: '主屏幕', ip_day: '9月1日 星期一',
      wall_pickbed: '底图 —— 粒子的颜色从它来',
      field_turn: '拖动可以转动，捏合拉近，双击回正。',
      wall_bed_photo: '我的照片',
      wall_capturing_auto: '正在生成你的壁纸…',
      wall_bed_done: '好了 —— 下面按一次设置就行',
      wall_ok: '壁纸已重新生成',
      wall_auto_h: '让它自己更新',
      wall_a1b: '把那两步包进「重复」里', wall_a1s: '重复 20 次 → Get Contents of URL → Set Wallpaper Photo → 等待 2 秒。每次抓取拿到的都是粒子场的不同瞬间，所以这真的是 2 秒一换的循环。',
      wall_a2b: '为什么是 20 次而不是一直跑', wall_a2s: 'iOS 大约 30–60 秒就会掐掉后台运行的快捷指令。20 次刚好填满。写更多不会跑更久，只会被中途切断。',
      wall_open_shortcuts: '打开快捷指令',
      wall_g_loop: '第一步 —— 先做出这条快捷指令',
      wall_g_trigger: '怎么触发它 —— 挑一个就行',
      wall_t1b: '轻点背面 —— 敲两下手机背面',
      wall_t1s: '设置 → 辅助功能 → 触控 → 轻点背面 → 轻点两下 → 选你的 Terse 快捷指令。三屏，设一次，之后敲两下背面壁纸就再跑一轮。推荐用这个。',
      wall_t2b: '操作按钮（iPhone 15 Pro 及以上）',
      wall_t2s: '设置 → 操作按钮 → 划到「快捷指令」→ 选你的。之后按一下侧边那颗键就行。',
      wall_t3b: '控制中心 / 锁定屏幕',
      wall_t3s: '加一个「快捷指令」控件，之后在任何地方一点就跑，连解锁都不用。',
      wall_t4b: '自动化 —— 想让它完全不用你管的话',
      wall_t4s: '快捷指令 → 自动化 → App → 打开时，选几个你天天用的，把「运行前询问」关掉。它藏在六层设置里，而且不能分享、不跨设备同步——这是 Apple 的限制，不是我们的——但它是唯一之后完全不用你动手的触发方式。',
      wall_t5b: '为什么随便挑一个就够',
      wall_t5s: '快捷指令每次跑大约 40 秒——这已经是 iOS 允许后台运行的极限。不管你用哪种触发，一次操作就换来 40 秒会动的壁纸。',
      wall_g_own: '或者：保留你自己的壁纸，只加字',
      wall_g_live: '或者：Live Photo（可能不会动）',
      wall_getshortcut: '一键添加 Terse 快捷指令',
      wall_getshortcut_note: '点一下，快捷指令会打开，整个循环已经搭好了。里面的 URL 是故意留空的——分享出去的快捷指令会把链接一起带走，而那个链接就是你的凭证。你自己的链接已经在剪贴板里了：打开 Get Contents of URL 那一步，粘贴进去就行。',
      ins_title: '把 Terse 添加到主屏幕',
      ins_sub: '像 App 一样打开 · 不用反复登录',
      ins_body_prompt: '一下就好。装好后没有浏览器边框，登录状态一直在，还能收通知。',
      ins_body_safari: '在 Safari 里两步。装好后没有浏览器边框，登录状态一直在，还能收通知——这几样在标签页里都做不到。',
      ins_body_other: 'iPhone 上只有 Safari 能安装网页应用，这个浏览器不行。把链接在 Safari 里打开就会出现这个选项。',
      ins_step_share: '点 Safari 工具栏里的「分享」',
      ins_step_add: '选「添加到主屏幕」',
      ins_install: '安装', ins_copy: '复制链接', ins_copied: '已复制——去 Safari 里粘贴',
      ins_dismiss: '以后再说', ins_show: '教我怎么装',
      ins_already: '已经装好了',
      push_title: '通知',
      push_body: '智能体在等你确认、或者预算快超了的时候，Terse 会告诉你。只发值得打断你的事，不是每一步都发。',
      push_enable: '打开通知', push_test: '发个测试', push_off: '关掉',
      push_on: '已开启', push_blocked: '被系统设置挡住了', push_unsupported: '这里不支持',
      push_need_install: '先把 Terse 添加到主屏幕——iPhone 只给装好的网页应用发通知，Safari 标签页里收不到。',
      push_sent: '发出去了，看看锁屏', push_failed: '通知没能打开',
      push_denied: '你拒绝了通知。去 iOS 设置 → Terse → 通知 里重新打开。',
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

  /* ── 3D free view ────────────────────────────────────────────────────────
     The two particle layers already live in three dimensions — the aurora sits
     at z −32..18 — and the camera was simply nailed to the z axis looking
     straight at them. This unpins it.

     UNLOCKED ON THE PHONE, deliberately, while the Mac keeps it behind Pro.
     Turning the field with a finger is the thing that makes this feel like a
     toy worth opening, and putting the best twenty seconds of the app behind a
     paywall we have no conversion data for is how you get neither.

     ⚠ OFF MUST BE BIT-IDENTICAL TO NEVER HAVING EXISTED. orbitPosition(r,0,0)
     returns exactly (0,0,r), and apply() returns early when the view is home,
     so a user who never drags pays nothing — not a per-frame matrix, not a
     rounded float. */
  var V3 = null;                       // the pure-maths module, loaded with the engine
  var view = { az: 0, el: 0, dist: 1 };
  var viewHome = true;
  var camZ = null;                     // each layer's own framing distance

  /* ⚠ TURNING THE FIELD IS PRO, and it was free here while being Pro on the
     Mac — the same feature, two answers, depending on which screen you happened
     to be looking at. The gate is here rather than inside the gesture handlers
     so that there is exactly one place that decides it. */
  function view3dReady() { return !!(V3 && wp && wp.layers && wp.layers.length && T.isPro()); }

  function applyView() {
    if (!view3dReady()) return;
    // Nothing to do, and nothing to cost, while the camera is where it started.
    if (viewHome && !view.az && !view.el && view.dist === 1) return;
    if (!camZ) camZ = wp.layers.map(function (L) { return L.cam.position.z; });
    for (var i = 0; i < wp.layers.length; i++) {
      var L = wp.layers[i];
      // Each layer keeps its OWN radius: silk frames at ~12 and the aurora at
      // ~62, so one absolute distance would fling the aurora out of frame.
      var p = V3.orbitPosition(camZ[i] * view.dist, view.az, view.el);
      L.cam.position.set(p.x, p.y, p.z);
      L.cam.lookAt(0, 0, 0);
    }
    viewHome = (!view.az && !view.el && view.dist === 1);
  }

  function recentre() {
    view.az = 0; view.el = 0; view.dist = 1;
    applyView();
    viewHome = true;
    if (window.TerseFeel) window.TerseFeel.tap('heavy');
  }

  function bindView3d() {
    var stage = $('stage');
    if (!stage || !window.TerseFeel) return;
    var stopGlide = null;
    window.TerseFeel.gestures(stage, {
      onStart: function () {
        if (stopGlide) { stopGlide(); stopGlide = null; }
        /* Answered where they reached for it. A prompt at the exact feature
           somebody just tried to use is the one that means something — a
           banner on another screen is an advert. Once per session: this fires
           on every touch of the field, and the second telling is nagging. */
        if (!T.isPro() && !proNudged) { proNudged = true; proSheet('3d'); }
      },
      onMove: function (dx, dy) {
        if (!view3dReady()) return;
        view.az -= dx * V3.ORBIT_AZ_PER_PX;
        view.el = Math.max(-V3.VIEW_EL_MAX, Math.min(V3.VIEW_EL_MAX,
          view.el + dy * V3.ORBIT_EL_PER_PX));
        viewHome = false;
        applyView();
        window.TerseFeel.tap('drag');
      },
      onPinch: function (k) {
        if (!view3dReady()) return;
        view.dist = Math.max(V3.VIEW_DIST_MIN, Math.min(V3.VIEW_DIST_MAX, view.dist / k));
        viewHome = false;
        applyView();
      },
      onDouble: recentre,
      onEnd: function () { if (window.TerseFeel) window.TerseFeel.tap(); },
    });
  }

  function mountEngine() {
    if (!Engine) return;
    // Loaded once, next to the engine, and stamped for the same CDN reason.
    if (!V3) {
      import('/app-assets/wallpaper-view3d.js'
        + (window.__TERSE_BUILD ? '?v=' + encodeURIComponent(window.__TERSE_BUILD) : ''))
        .then(function (m) { V3 = m; bindView3d(); })
        .catch(function () { /* the field simply stays flat */ });
    }
    camZ = null;                       // a new engine means new cameras
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
    var bed = T.photo() || (window.TerseBeds && window.TerseBeds.render(bedId(),
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
      /* HOW OFTEN THE FIELD SPEAKS. Twelve seconds is tuned for a wallpaper on
         a Mac that is glanced at, where a number changing every few seconds is
         restless. The phone is the opposite — it is being LOOKED at, often for
         the first time and with nothing linked yet — and one glyph every twelve
         seconds reads as broken rather than calm. Four keeps it talking without
         turning it into a ticker. */
      stagePace: 4000,
      photo: bed || undefined,
    });
    // The constructor builds the scene but does NOT start the animation loop —
    // start() is a separate call, and without it the canvas stays black forever
    // with no error anywhere. The desktop wallpaper page calls it too.
    wp.start();

    /* Other people's projects, drifting through an otherwise empty field.
       Only while nothing is linked: once a machine is paired the field is
       that person's agents, and a stranger's work playing over their own
       live numbers is the wrong thing entirely. The check is re-asked each
       cycle because pairing can happen mid-session. */
    if (window.TersePlazaField) {
      window.TersePlazaField.start(wp, function () {
        return !(wallState && wallState.linked);
      });
    }

    /* The engine measures the canvas in its constructor and falls back to
       1920x1080 when the element has not been laid out yet — which is exactly
       what happens when the module resolves before first paint. It carries a
       ResizeObserver for this, but that only fires on a CHANGE, and a canvas
       that was already the right size on screen never changes. One explicit
       resize on the next frame pins the buffer to the real viewport. */
    requestAnimationFrame(function () { try { wp && wp.resize && wp.resize(); } catch (e) {} });

    /* A handle on the engine, for diag.js and for answering "what did it
       actually measure?" — every layout choice the project layer makes comes
       from a canvas size that is wrong until the element has been laid out, and
       that is otherwise unobservable from outside. */
    window.__terseFieldWp = wp;

    // The engine exists NOW, which may be after the showcase decided it did
    // not. Ask again from this side; startPreviews is idempotent.
    startPreviews();

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

    // Stamped for the same reason the phone scripts are — see engineUrl() in
    // capture.js. An unstamped engine sat in Cloudflare's cache past its own
    // max-age and users kept getting the broken one.
    return import('/app-assets/mineradio-wallpaper.js'
      + (window.__TERSE_BUILD ? '?v=' + encodeURIComponent(window.__TERSE_BUILD) : ''))
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
  // Stamped like the engine: an unstamped module is a module Cloudflare can
  // keep serving after it changed, and this one is where all the writing on the
  // field comes from.
  import('/app-assets/wallpaper-hud.js' + stamp())
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
      /* A FLOOR WHILE NOTHING IS LINKED, for the same reason the capture has
         one. `activity` is how hard the field dances and it is derived from
         real burn rate, so an unlinked phone lands at 0 — and at 0 the field
         never gathers enough for a glyph to form at all. Measured on an
         iPhone: 0.08 gave sparse dots and no text, 0.55 gave the words.
         So the FIRST thing anybody sees, before they have linked anything, is
         a field alive enough to say what it is. Once a machine is linked the
         real number takes over and the field is honest about being quiet. */
      wp.setActivity(st.linked || sessions.length ? o.activity : Math.max(0.55, o.activity));
      wp.setAgents(o.agents);

      /* With no computer linked there is nothing to count, and the shared
         derivation honestly produces "0 tokens" — which is true, and useless as
         the one thing the field spells out. So an unlinked phone writes what is
         actually the case instead. Nothing is invented: the moment a machine is
         linked the real numbers take over again. */
      if (!st.linked && !sessions.length) {
        /* Two fixed sentences beat "0 tokens", but they never changed — so the
           field spelled the same thing forever and read as a screenshot. The
           visitor drives it instead: the clock moves on its own, and touching
           the screen moves the rest.

           ⚠ It is the VISITOR and not the phone, on purpose. Every way to read
           a device from a page — getBattery, navigator.connection,
           deviceMemory — is Chrome-only and simply absent in iOS Safari, which
           is the browser this ships to. Measured, not assumed. What Safari does
           expose is static, and static facts cannot animate anything. Touch is
           real, immediate, needs no permission, and exists everywhere. */
        if (window.TerseSignals) {
          var sig = window.TerseSignals.overlays(function (key, fb) {
            return t(key) === key ? fb : t(key);
          });
          o.stage = sig.stage;
          o.activity = Math.max(o.activity, sig.activity);
          wp.setActivity(o.activity);
        } else {
          o.stage = [
            { k: 'Terse', v: t('field_idle_1'), u: '' },
            { k: 'Terse', v: t('field_idle_2'), u: '' },
          ];
        }
        o.logGroups = [];
      }
      // The two that become particle text. setStageItems rate-limits itself to
      // one glyph every 12s inside the engine, so calling it on every poll is
      // how the rotation advances — not something to throttle out here.
      /* ⚠ NOT while a project is open. The field talks about the visitor when it
         has nothing else to say — screen size, the clock, how many times they
         have touched it — and with the project drawn on this same canvas those
         glyphs land straight on top of somebody's code city. In that window the
         project IS what the field is about. */
      // Kept so that closing a project can put the field's own voice back
      // straight away instead of leaving it mute until the next poll.
      /* ⚠ SELF-HEALING, because every one-shot signal I tried here was raced.
         The IntersectionObserver fires before the engine module resolves; a
         setTimeout after a tab switch fires before the view has laid out and
         reports an empty rect. Each failure left the panes dead with no second
         chance. This poll already runs every few seconds — asking it to make
         sure is idempotent, costs a rect read, and cannot get stuck. */
      if (current === 'field' && !viewing && !T.isPro()) startPreviews();

      lastStage = o.stage;
      if (!viewing) {
        wp.setStageItems(o.stage);
        wp.setAgentLog(o.logGroups);
      }
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

  /* ── The two live previews ───────────────────────────────────────────────
     The Mac runs a free engine and a Pro engine side by side in its wallpaper
     panel, and it is right to: "eight choreographies, not eight colour swaps"
     is a claim, while two panes moving differently is evidence.

     Everything careful here is about the phone having ONE GPU and iOS capping
     live WebGL contexts — the same limit that made a full-screen second engine
     fail silently and cost five rounds to find. So:

       · they are built only while the card is actually on screen, and disposed
         the moment it leaves — an IntersectionObserver, not a boolean somebody
         has to remember to clear;
       · they are tiny, so their buffers are a fraction of the field's;
       · never while a project preview is running, which owns the field;
       · and if either constructor refuses, the whole row hides and the CSS
         tiles carry the message alone. A degraded card beats a dead field. */
  var prevFree = null, prevPro = null, prevObs = null, prevCycle = null;

  function previewsUp() { return !!(prevFree || prevPro); }

  /** Is the card actually on screen? Asked directly rather than trusting the
   *  observer's last verdict, because that verdict can be stale by the time the
   *  engine is ready to act on it. */
  function proCardVisible() {
    var c = $('proShow');
    if (!c || c.classList.contains('hide')) return false;
    var r = c.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || 800);
  }

  function startPreviews() {
    /* ⚠ THIS GUARD USED TO BE ONE-SHOT AGAINST AN ASYNC DEPENDENCY. The
       IntersectionObserver fires once, immediately, when it starts observing a
       card that is already on screen — and at that moment the engine module may
       still be loading, so `Engine` is null and this returned. The card then
       never leaves the viewport (the app scrolls an inner <main>, so it does
       not even move), no second intersection event ever arrives, and the panes
       never appear. Silent, and it looked exactly like the constructor failing.

       So the engine now calls this too, once it exists, and visibility is asked
       rather than remembered. */
    if (previewsUp() || !Engine || T.isPro() || viewing) return;
    if (!proCardVisible()) return;
    /* ⚠ A FRESH CANVAS EACH TIME. stopPreviews calls forceContextLoss(), which
       is the only way to actually hand a WebGL context back on iOS rather than
       waiting for the GC — but it kills that canvas PERMANENTLY. The element
       can never hold a context again, so reopening the controls a second time
       built two engines onto dead canvases and silently drew nothing. Swap in
       new elements, and the id stays where the CSS and the tests expect it. */
    var a = freshCanvas('prevFree'), b = freshCanvas('prevPro');
    if (!a || !b) return;
    var bed = T.photo() || (window.TerseBeds && window.TerseBeds.render(bedId(), 220, 165));
    var base = { theme: 'neon', quality: 'low', angle: 42, intensity: 1,
                 photo: bed || undefined, stagePace: 100000 };
    try {
      prevFree = new Engine(a, Object.assign({}, base, { pro: false, style: 'cinematic' }));
      prevPro = new Engine(b, Object.assign({}, base, { pro: true, style: 'aurora' }));
      prevFree.start(); prevPro.start();
      // Enough motion to read. Left at 0 the field never gathers, and two still
      // panes compare nothing.
      prevFree.setActivity(0.6); prevPro.setActivity(0.75);
      $('prevRow').classList.remove('hide');
      // Handles for diagnosis, same reason as the field's: "is it drawing?" is
      // otherwise unanswerable from outside.
      window.__tersePrevFree = prevFree; window.__tersePrevPro = prevPro;
      requestAnimationFrame(function () {
        try { prevFree.resize && prevFree.resize(); prevPro.resize && prevPro.resize(); } catch (e) {}
      });
      /* The Pro pane walks through the styles it is selling. One frozen style
         says "a different colour"; four in rotation say "different motion",
         which is the actual difference. */
      var ids = ['aurora', 'starfall', 'vortex', 'bloom'], at = 0;
      clearInterval(prevCycle);
      prevCycle = setInterval(function () {
        at = (at + 1) % ids.length;
        try { prevPro.setStyle && prevPro.setStyle(ids[at]); } catch (e) {}
      }, 3400);
    } catch (e) {
      stopPreviews();
      $('prevRow').classList.add('hide');
    }
  }

  /** Replace a canvas with an identical empty one, keeping id and position. */
  function freshCanvas(id) {
    var old = $(id);
    if (!old) return null;
    var next = document.createElement('canvas');
    next.id = id;
    old.parentNode.replaceChild(next, old);
    return next;
  }

  function stopPreviews() {
    clearInterval(prevCycle); prevCycle = null;
    [prevFree, prevPro].forEach(function (p) {
      if (!p) return;
      try { p.stop(); } catch (e) {}
      // forceContextLoss is what actually hands the context back; dispose alone
      // leaves it held until the GC gets round to it, which on iOS is too late.
      try { p.renderer && p.renderer.forceContextLoss && p.renderer.forceContextLoss(); } catch (e) {}
      try { p.dispose(); } catch (e) {}
    });
    prevFree = prevPro = null;
    window.__tersePrevFree = window.__tersePrevPro = null;
  }

  function watchPreviews() {
    var card = $('proShow');
    if (!card || !window.IntersectionObserver) return;
    if (prevObs) prevObs.disconnect();
    prevObs = new IntersectionObserver(function (entries) {
      var vis = entries.some(function (e) { return e.isIntersecting; });
      if (vis && !card.classList.contains('hide')) startPreviews();
      else stopPreviews();
    }, { threshold: 0.25 });
    prevObs.observe(card);
  }

  function renderStyles() {
    import('/app-assets/wallpaper-styles.js' + stamp()).then(function (m) {
      var grid = $('styleGrid');
      var pro = T.isPro();
      $('proTag').textContent = pro ? 'Pro' : t('free_tag');
      /* The showcase is for people who do not have it yet, and disappears the
         moment they do — a card selling something you already bought is the
         fastest way to make a paid product feel like a free one. */
      $('proShow').classList.toggle('hide', pro);
      if (pro) { stopPreviews(); if (prevObs) { prevObs.disconnect(); prevObs = null; } }
      else watchPreviews();
      /* And the line under the backdrops has to be TRUE. It promised drag,
         pinch and double-tap to everybody while the gesture only answers Pro —
         instructions for something that does nothing are worse than silence. */
      $('fieldTurn').textContent = pro ? t('field_turn') : t('field_turn_free');
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
          b.classList.add('locked');
          b.appendChild(lk);
        }
        b.onclick = function () {
          /* Named with the SAME label the tile shows. `s.name` does not exist
             on a style — the grid builds its label from the zh table or `en` —
             so asking for it produced 「」, a prompt about nothing. */
          if (!pro) { proSheet('style', label.textContent); return; }
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

  var current = 'field';
  function show(tab) {
    /* ⚠ LEAVING IS CLOSING. closeProject() only ever ran from the ← button, so
       walking out through the TAB BAR left the re-arm timer running: the project
       kept replaying onto the field every twenty seconds, and `viewing` stayed
       set, which is what mutes the agent log. Reported as "I open a project and
       can never get back to my own field" — and it was exactly that, for good.
       Every way out of this view has to end it, not just the one I built. */
    if (current === 'project' && tab !== 'project') endProject();
    /* ⚠ NAVIGATION IS AUTHORITATIVE FOR THE PREVIEW PANES TOO. They were torn
       down by an IntersectionObserver alone, and measured here it did not fire
       when the field view was hidden — so two WebGL contexts stayed live while
       somebody browsed the plaza. That is the same class of leak as the project
       timer that kept replaying: one path out, silently not taken. The observer
       stays for scrolling within the tab; leaving the tab is decided here. */
    if (tab !== 'field') stopPreviews();
    /* The feed borrows the field the same way a project preview does, so
       leaving the plaza has to hand it back — otherwise a capsule keeps
       replaying over your own agents, which is the bug that took a whole round
       to find the first time. */
    if (current === 'plaza' && tab !== 'plaza') endProject();
    current = tab;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.toggle('on', views[i].id === 'v-' + tab);
    var btns = document.querySelectorAll('nav button');
    for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('on', btns[j].dataset.tab === tab);
    // The wallpaper tab is the only one meant to be looked THROUGH; everywhere
    // else the field is a backdrop and the text has to win.
    $('scrim').classList.toggle('clear', tab === 'field');
    /* Re-observe rather than poke startPreviews on a timer. A fixed delay is
       another one-shot race — at 60ms the view has only just been shown and its
       rect can still be empty, so the panes never come back after you leave the
       tab once. Re-observing fires the callback with the REAL current
       visibility, whenever that turns out to be. */
    if (tab === 'field' && !T.isPro()) setTimeout(watchPreviews, 60);
    if (tab === 'plaza') loadPlazaTab();
    if (tab === 'friends') loadFriendsTab();
    if (tab === 'room') renderRoom();
    if (tab === 'me') renderMe();
    renderPairBar();
    try { history.replaceState(null, '', '/m/' + tab); } catch (e) {}
  }
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.onclick = function () { show(b.dataset.tab); };
  });

  /* ── One tick for every control, in one place ────────────────────────────
     Haptics were wired onto the handful of controls somebody remembered, which
     is worse than none: feedback that arrives on some taps and not others reads
     as the app missing the ones that were silent. This is a single delegated
     listener on the document, so every button — the ones here, the ones built
     at runtime for a project row or a comment, and the ones added tomorrow —
     answers the same way without anyone having to remember.

     `pointerdown`, not click: the tick belongs to the moment the finger lands.
     Waiting for click puts it after the handler has run, which on a slow tap
     feels like the phone answering late. */
  document.addEventListener('pointerdown', function (e) {
    if (!window.TerseFeel) return;
    var el = e.target && e.target.closest && e.target.closest('button, .item, .proj, .sty, .bed, input, select');
    if (!el || el.disabled) return;
    // A text field getting focus is not a press; it is the keyboard arriving,
    // and a tick there fires on every letter typed on some Android keyboards.
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    window.TerseFeel.tap(el.classList.contains('primary') ? 'heavy' : 'tap');
  }, { passive: true });

  // ── Plaza ────────────────────────────────────────────────────────────────

  /* Which half of the plaza is showing. Projects, because a room needs somebody
     else to already be standing in it while a project is there to be looked at
     the moment you arrive — opening on the usually-empty half made the whole
     plaza look empty. Rooms is one tap away and remembers nothing: this is a
     default, not a preference, and a plaza that opens differently depending on
     what you did last week is a plaza you cannot describe to anyone. */
  var plazaHalf = 'projects';

  function loadPlazaTab() {
    if (plazaHalf === 'rooms') loadPlaza();
    else if (!projPool.length) loadProjects();
  }

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

  /* ⚠ rooms.js HAS NO nickname(). This threw a TypeError on every call, which
     means joining a room, creating one and knocking have all been dead on this
     app — and silently, because each one is inside a click handler whose
     rejection nobody was watching. It surfaced only when a new caller happened
     to be one I was testing by hand.

     rooms.js is the file the Mac and the phone SHARE, so the fix belongs here
     rather than in it: this app is a guest in that module and should ask
     whether a method exists before leaning on it. */
  function nickname() {
    var u = T.user();
    var saved = null;
    try { if (typeof Rooms.nickname === 'function') saved = Rooms.nickname(); } catch (e) {}
    return saved
      || (u && (u.firstName || (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress)))
      || 'Guest';
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

  // ── Friends · messages ───────────────────────────────────────────────────
  /* Friends and messages are two views of ONE relationship, so they share a tab
     behind a segmented control. A sixth tab is also where the bar stops being
     readable on a small phone.

     ⚠ EVERYTHING HERE NEEDS ONE IDENTITY. This backend grew two: the plaza and
     private messages key off the Clerk user id, rooms and friends off a random
     per-install secret. The same human was two people, so "add a friend, then
     talk to them" could not work at all. Social.adopt() settles it on the phone
     by feeding rooms.js the Clerk id — see social.js for why it is done by
     feeding rather than by editing the shared file. */

  /* ── What the console said ───────────────────────────────────────────────
     A GLSL program that fails to compile does not throw. three.js writes the
     driver's log to console.error and then draws nothing — the object stays
     visible, its buffers stay perfect, and the screen stays empty. That is
     indistinguishable from every other way this feature has failed, and it is
     invisible on a desktop because desktop GL compilers accept things WebKit's
     does not. So the last few console errors ride along with the probe. */
  var conErr = [];
  (function () {
    var real = console.error;
    console.error = function () {
      try {
        var s = Array.prototype.map.call(arguments, function (a) {
          return (a && a.message) || String(a);
        }).join(' ');
        conErr.push(s.slice(0, 500));
        if (conErr.length > 6) conErr.shift();
      } catch (e) {}
      return real.apply(console, arguments);
    };
    window.addEventListener('error', function (e) {
      try { conErr.push('onerror: ' + (e.message || '')); } catch (x) {}
    });
  }());

  var Social = window.TerseSocial;
  var myPeer = '';        // my own 32-char id, the one other people message
  var frSeg = 'friends';
  var dmPeer = null;      // the conversation on screen
  var dmName = '';
  var dmReason = null;    // the project a first message has to name

  /* My own short id. Worked out on the device rather than asked for, because it
     is a pure function of something already here — and it is only ever used to
     recognise MYSELF, so being briefly empty at boot costs nothing. */
  function ensureMyPeerId() {
    var raw = Social.identity();
    if (!raw || myPeer) return Promise.resolve(myPeer);
    var c = (window.crypto && window.crypto.subtle);
    if (!c) return Promise.resolve('');
    return c.digest('SHA-256', new TextEncoder().encode(raw)).then(function (buf) {
      var hex = Array.prototype.map.call(new Uint8Array(buf), function (x) {
        return ('0' + x.toString(16)).slice(-2);
      }).join('');
      myPeer = hex.slice(0, 32);
      return myPeer;
    }).catch(function () { return ''; });
  }
  function myPeerId() { return myPeer; }

  /** Anything that writes needs a name on it. Said once, plainly, instead of
   *  letting the server answer 401 into a catch that shows nothing. */
  function requireIdentity() {
    if (Social.identity()) return true;
    toast(t('signin_first'));
    return false;
  }

  /* ── The Pro prompt ──────────────────────────────────────────────────────
     Named for the thing that was just reached for, because a prompt that says
     "upgrade" answers a question nobody asked. Two buttons and no third: see
     what it costs, or carry on with what you were doing. */
  var proNudged = false;

  function proSheet(kind, name) {
    var titles = { '3d': 'pro_3d_t', style: 'pro_style_t' };
    var bodies = { '3d': 'pro_3d_d', style: 'pro_style_d' };
    var el = $('proSheet');
    if (!el) { location.href = '/#pricing'; return; }
    $('proSheetT').textContent = t(titles[kind] || 'ps_title').replace('{name}', name || '');
    $('proSheetD').textContent = t(bodies[kind] || 'ps_typo_d');
    el.classList.remove('hide');
    if (window.TerseFeel) window.TerseFeel.tap();
  }
  on($('proSheetClose'), 'click', function () { $('proSheet').classList.add('hide'); });
  on($('proSheet'), 'click', function (e) { if (e.target === $('proSheet')) $('proSheet').classList.add('hide'); });
  on($('proSheetCta'), 'click', function () { $('proSheet').classList.add('hide'); openPlans(); });
  on($('psCta'), 'click', openPlans);
  on($('planClose'), 'click', function () { $('planSheet').classList.add('hide'); });
  on($('planSheet'), 'click', function (e) { if (e.target === $('planSheet')) $('planSheet').classList.add('hide'); });

  /* ── Choosing a plan ─────────────────────────────────────────────────────
     The Mac opens a window to pick one; here it is a sheet, and the tap goes
     straight to Stripe rather than to a marketing page that then asks again.

     ⚠ The tiers and their copy are the server's — api/server.js owns both the
     price ids and the wording Stripe shows on the card. Writing prices into the
     phone would let the number on screen drift from the number charged, which
     is the one bug in a payment flow nobody forgives. */
  var PLANS = [
    { tier: 'pro',           k: 'plan_month' },
    { tier: 'pro_quarterly', k: 'plan_quarter' },
    { tier: 'pro_annual',    k: 'plan_year', best: true },
    { tier: 'pro_lifetime',  k: 'plan_life' },
  ];

  function openPlans() {
    var host = $('planList');
    host.innerHTML = '';
    $('planNote').textContent = T.user() ? t('plan_note') : t('plan_signin');
    PLANS.forEach(function (pl) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'plan' + (pl.best ? ' best' : '');
      var n = document.createElement('span'); n.className = 'pn';
      var nb = document.createElement('b'); nb.textContent = t(pl.k + '_n');
      var ns = document.createElement('span'); ns.textContent = t(pl.k + '_d');
      n.appendChild(nb); n.appendChild(ns);
      var pp = document.createElement('span'); pp.className = 'pp';
      var pb = document.createElement('b'); pb.textContent = t(pl.k + '_p');
      var ps = document.createElement('span'); ps.textContent = t(pl.k + '_u');
      pp.appendChild(pb); pp.appendChild(ps);
      if (pl.best) {
        var sv = document.createElement('span'); sv.className = 'save'; sv.textContent = t('plan_save');
        pp.appendChild(sv);
      }
      b.appendChild(n); b.appendChild(pp);
      b.onclick = function () { buy(pl.tier, b); };
      host.appendChild(b);
    });
    $('planSheet').classList.remove('hide');
    if (window.TerseFeel) window.TerseFeel.tap();
  }

  function buy(tier, btn) {
    var u = T.user();
    /* Checkout needs an account to attach the subscription to. Sending a guest
       to Stripe would take their money and have nowhere to put the entitlement,
       so the sign-in comes first and says why. */
    if (!u) {
      toast(t('plan_signin'));
      if (window.Clerk) window.Clerk.openSignIn({ redirectUrl: location.pathname });
      return;
    }
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier: tier,
        clerkUserId: u.id,
        clerkUserEmail: (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || '',
      }),
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.url) { location.href = j.url; return; }
        // The server distinguishes "no such plan" from "plan exists but has no
        // Stripe price yet" — pass its words through rather than "failed".
        toast((j && j.error) || t('plan_failed'));
      })
      .catch(function () { toast(t('plan_failed')); })
      .then(function () { if (btn) { btn.disabled = false; btn.style.opacity = ''; } });
  }

  function loadFriendsTab() {
    if (frSeg === 'chats') loadDmList();
    else { loadFriends(); loadMyCode(); }
  }

  Array.prototype.forEach.call(document.querySelectorAll('#frSeg button'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#frSeg button'), function (o) {
        o.classList.toggle('on', o === b);
      });
      frSeg = b.dataset.fr;
      closeThread();
      $('fzFriends').classList.toggle('hide', frSeg !== 'friends');
      $('fzChats').classList.toggle('hide', frSeg !== 'chats');
      loadFriendsTab();
    };
  });

  /* ── Your code is your address ───────────────────────────────────────────
     Adding somebody used to mean standing in the same room as them, which is
     right for a stranger and absurd for a person you already know. The server
     hands the same token back every time, so this reads as "your code" rather
     than "a link you just made" — and it is a revocable token, not an identity
     hash, so handing it out is not handing out you. */
  function loadMyCode() {
    if (!Social.identity()) { $('myCode').textContent = '—'; return; }
    Social.myCode(nickname()).then(function (d) {
      $('myCode').textContent = d.token || '—';
      $('myCode').dataset.url = d.url || '';
    }).catch(function () { $('myCode').textContent = '—'; });
  }

  on($('copyCode'), 'click', function () {
    var c = $('myCode').textContent;
    if (!c || c === '—') return;
    if (navigator.clipboard) navigator.clipboard.writeText(c).then(function () { toast(t('copied')); });
  });
  on($('shareCode'), 'click', function () {
    var c = $('myCode').textContent;
    if (!c || c === '—') return;
    var url = $('myCode').dataset.url || c;
    // The share sheet when there is one: a code is meant to LEAVE this app, and
    // making somebody copy, switch app and paste is three steps where iOS has
    // one. Copy is the fallback, never a dead button.
    if (navigator.share) navigator.share({ text: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast(t('copied')); });
  });

  /* ── Find, then add ─────────────────────────────────────────────────────
     Paste-and-you-are-friends gives you no moment to notice you pasted the
     wrong thing, and no way to tell whether the ID you were sent is still live.
     So searching and adding are two steps, and Add only exists once there is
     somebody on screen to add. */
  var frFound = null;

  on($('frFind'), 'click', findByCode);
  on($('frCode'), 'keydown', function (e) { if (e.key === 'Enter') findByCode(); });
  // Looking again the moment the field changes: a stale result sitting under a
  // half-typed ID is a result about somebody else.
  on($('frCode'), 'input', function () { clearHit(); });

  function clearHit() {
    frFound = null;
    $('frHit').classList.add('hide');
    $('frMiss').classList.add('hide');
  }

  function findByCode() {
    if (!requireIdentity()) return;
    // Whatever they pasted. People copy the whole link out of a chat window;
    // making them cut the token out of it is handing them our implementation.
    var code = Social.codeFrom($('frCode').value);
    if (!code) { toast(t('fr_add_empty')); return; }
    clearHit();
    $('frFind').disabled = true;
    Social.lookup(code).then(function (d) {
      if (!d || !d.found) { $('frMiss').classList.remove('hide'); return; }
      frFound = { code: code, name: d.name || t('dm_someone') };
      $('frHitAv').textContent = (d.name || '?').slice(0, 1).toUpperCase();
      $('frHitName').textContent = frFound.name;
      $('frHitSub').textContent = d.mine ? t('fr_add_self')
        : d.already ? t('fr_already') : '';
      // Your own ID and somebody already in your list are both dead ends, and
      // an Add button that will only ever fail is worse than no button.
      $('frAdd').classList.toggle('hide', !!(d.mine || d.already));
      $('frHit').classList.remove('hide');
      if (window.TerseFeel) window.TerseFeel.tap();
    }).catch(function (e) { toast(e.message || '—'); })
      .then(function () { $('frFind').disabled = false; });
  }

  on($('frAdd'), 'click', addByCode);
  function addByCode() {
    if (!frFound || !requireIdentity()) return;
    $('frAdd').disabled = true;
    Social.addByCode(frFound.code, nickname()).then(function (d) {
      $('frCode').value = '';
      clearHit();
      var f = d && d.friendship;
      toast(t('fr_added').replace('{name}', (f && f.name) || frFound.name));
      if (window.TerseFeel) window.TerseFeel.tap();
      loadFriends();
    }).catch(function (e) {
      toast(/own link/i.test(e.message || '') ? t('fr_add_self') : (e.message || '—'));
    }).then(function () { $('frAdd').disabled = false; });
  }

  function loadFriends() {
    Social.friends().then(function (d) {
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
        var nm = document.createElement('b'); nm.className = 'ell'; nm.textContent = f.name || f.email || t('dm_someone');
        var sub = document.createElement('span'); sub.className = 'tiny'; sub.textContent = f.status;
        box.appendChild(nm); box.appendChild(sub);
        row.appendChild(av); row.appendChild(box);
        if (f.status === 'pending' && f.direction === 'incoming') {
          var yes = document.createElement('button');
          yes.type = 'button'; yes.className = 'btn ghost'; yes.style.minHeight = '32px'; yes.textContent = '✓';
          yes.onclick = function () { Social.respondFriend(f.id, true).then(loadFriends); };
          row.appendChild(yes);
        } else if (f.status === 'accepted' && f.peer) {
          // The whole point of the bridge: a friend row carries the id you can
          // write to, so the answer to "now what?" is one tap away instead of
          // being a name you can do nothing with.
          var chat = document.createElement('button');
          chat.type = 'button'; chat.className = 'btn ghost'; chat.style.minHeight = '32px';
          chat.style.padding = '6px 11px'; chat.textContent = '✉';
          chat.onclick = function () { openDm(f.peer, f.name || t('dm_someone'), null); };
          row.appendChild(chat);
          // Adding without removing is a list that only grows. It asks first —
          // this is the one control here that cannot be undone with a tap.
          var cut = document.createElement('button');
          cut.type = 'button'; cut.className = 'btn ghost danger'; cut.style.minHeight = '32px';
          cut.style.padding = '6px 10px'; cut.textContent = '✕';
          cut.title = t('fr_remove');
          cut.onclick = function () {
            if (!confirm(t('fr_remove_ask').replace('{name}', f.name || t('dm_someone')))) return;
            Social.unfriend(f.id).then(loadFriends).catch(function (e) { toast(e.message || '—'); });
          };
          row.appendChild(cut);
        }
        list.appendChild(row);
      });
    }).catch(function () { $('friendEmpty').classList.remove('hide'); });
  }

  /* ── The inbox ───────────────────────────────────────────────────────────
     One row per person, not per message: this screen answers "who wrote to me",
     and a list of every sentence anybody ever sent answers a question nobody
     asked. */
  function loadDmList() {
    if (!Social.identity()) { $('dmEmpty').classList.remove('hide'); return; }
    Social.inbox().then(function (d) {
      var threads = (d && d.threads) || [];
      var list = $('dmList');
      list.innerHTML = '';
      $('dmEmpty').classList.toggle('hide', threads.length > 0);
      threads.forEach(function (th) {
        var row = document.createElement('button');
        row.type = 'button'; row.className = 'item';
        var av = document.createElement('span');
        av.className = 'av'; av.textContent = (th.name || '?').slice(0, 1).toUpperCase();
        var box = document.createElement('span'); box.className = 'grow';
        var nm = document.createElement('b'); nm.className = 'ell';
        nm.textContent = th.name || t('dm_someone');
        var sub = document.createElement('span'); sub.className = 'tiny ell';
        sub.textContent = (th.last && th.last.body) || '';
        box.appendChild(nm); box.appendChild(sub);
        row.appendChild(av); row.appendChild(box);
        if (th.unread > 0) {
          var n = document.createElement('span');
          n.className = 'unread'; n.textContent = String(th.unread);
          row.appendChild(n);
        }
        row.onclick = function () { openDm(th.peer, th.name || t('dm_someone'), null); };
        list.appendChild(row);
      });
      markUnread(d && d.unread);
    }).catch(function () { $('dmEmpty').classList.remove('hide'); });
  }

  /** The Friends tab wears the unread count, because a message that arrives
   *  while you are looking at the field is otherwise silent. */
  function markUnread(n) {
    var btn = document.querySelector('nav button[data-tab="friends"] span:last-child');
    if (!btn) return;
    var base = t('t_friends');
    btn.textContent = n > 0 ? base + ' · ' + n : base;
  }

  /** Open a conversation. `reason` is the project a FIRST message has to name —
   *  carried from the ✉ on somebody's project, and simply absent between
   *  friends, who need no reason. */
  function openDm(peer, name, reason, about) {
    if (!peer) return;
    if (!requireIdentity()) return;
    dmPeer = peer; dmName = name || t('dm_someone'); dmReason = reason || null;
    show('friends');
    frSeg = 'chats';
    Array.prototype.forEach.call(document.querySelectorAll('#frSeg button'), function (o) {
      o.classList.toggle('on', o.dataset.fr === 'chats');
    });
    $('fzFriends').classList.add('hide');
    $('fzChats').classList.add('hide');
    $('fzThread').classList.remove('hide');
    /* A stranger has no name yet — all you know is what you were looking at.
       Putting the project title where a name goes makes it read as if the
       person is called "particle-city"; saying what it is ABOUT is the truth,
       and their real name arrives with their first reply anyway. */
    $('dmWho').textContent = name ? dmName : (about ? t('dm_about').replace('{name}', about) : dmName);
    $('dmMsgs').innerHTML = '';
    dmSeen = '';
    loadThread();
    startThreadPoll();
  }

  function closeThread() {
    dmPeer = null; dmReason = null;
    stopThreadPoll();
    $('fzThread').classList.add('hide');
  }

  /* ── Keeping up ──────────────────────────────────────────────────────────
     A chat you have to leave and come back to in order to see a reply is not a
     chat. Polling rather than an event stream on purpose: since iOS 18 a
     backgrounded EventSource closes while still reporting readyState === OPEN
     and firing no error, so a stream here would go quietly dead in a pocket and
     look exactly like a silent friend. A poll cannot lie about that.

     It stops while the tab is hidden — a phone in a pocket asking every five
     seconds is somebody's battery — and fires once immediately on return,
     which is also when a reply is most likely waiting. */
  var dmPoll = null;
  function startThreadPoll() {
    stopThreadPoll();
    dmPoll = setInterval(function () {
      if (document.hidden || !dmPeer) return;
      loadThread({ quiet: true });
    }, 5000);
  }
  function stopThreadPoll() { clearInterval(dmPoll); dmPoll = null; }
  document.addEventListener('visibilitychange', function () {
    /* ⚠ A BACKGROUNDED TAB STILL RAN THE FIELD. iOS throttles rAF rather than
       stopping it, so the engine kept simulating tens of thousands of particles
       in a pocket — and the first seconds after coming back were spent catching
       up, which is exactly the stutter you feel on returning to the app. Stop
       on the way out, start on the way in. */
    if (document.hidden) {
      try { if (wp) wp.stop(); } catch (e) {}
      return;
    }
    try { if (wp) wp.start(); } catch (e) {}
    if (dmPeer) loadThread({ quiet: true });
    else if (Social.identity()) Social.inbox().then(function (d) { markUnread(d && d.unread); }).catch(function () {});
  });
  on($('dmRefresh'), 'click', loadDmList);
  on($('dmBack'), 'click', function () {
    closeThread();
    $('fzChats').classList.toggle('hide', frSeg !== 'chats');
    $('fzFriends').classList.toggle('hide', frSeg !== 'friends');
    loadFriendsTab();
  });

  var dmSeen = '';
  function loadThread(opts) {
    if (!dmPeer) return;
    var quiet = !!(opts && opts.quiet);
    Social.thread(dmPeer).then(function (d) {
      /* A poll that rebuilds the list every five seconds throws away the
         scroll position and any text selection, whether or not anything
         arrived. Only redraw when the conversation actually changed. */
      var sig = (d.messages || []).map(function (m) { return m.id; }).join(',') + '|' + (d.open ? '1' : '0');
      if (quiet && sig === dmSeen) return;
      var fresh = quiet && dmSeen && sig !== dmSeen;
      dmSeen = sig;
      $('dmMsgs').innerHTML = '';
      (d.messages || []).forEach(function (m) { addDm(m, false); });
      // Somebody else's line arriving while you are looking at it belongs in
      // the field too — that is where this app says things.
      if (fresh) {
        var last = (d.messages || [])[d.messages.length - 1];
        if (last && !last.mine && wp && wp.roomLine) {
          wp.roomLine(dmPeer, last.author || dmName, last.body || '', { max: 26 });
        }
        if (window.TerseFeel) window.TerseFeel.tap();
      }
      // Say whether this line is open BEFORE anything is typed. Letting somebody
      // write a paragraph and then telling them it cannot be sent is the worst
      // possible moment to explain a rule.
      var open = !!d.open;
      $('dmGate').classList.toggle('hide', open || !dmReason);
      if (!open && !dmReason) {
        $('dmGate').textContent = t('dm_no_reason');
        $('dmGate').classList.remove('hide');
      } else if (!open) {
        $('dmGate').textContent = t('dm_gate');
      }
      loadDmList();
    }).catch(function (e) { toast(e.message || '—'); });
  }

  /* A message is a message wherever it is shown, so it goes to the field too —
     the same headline path a room's chat uses, in the speaker's own colour.
     That is what this app is: text that becomes particles. */
  function addDm(m, alsoField) {
    var box = $('dmMsgs');
    var el = document.createElement('div');
    el.className = 'msg' + (m.mine ? ' me' : '');
    if (!m.mine) {
      var who = document.createElement('span');
      who.className = 'who'; who.textContent = m.author || dmName;
      el.appendChild(who);
    }
    el.appendChild(document.createTextNode(m.body || ''));
    box.appendChild(el);
    box.scrollIntoView({ block: 'end' });
    if (alsoField && wp && wp.roomLine) {
      wp.roomLine(m.mine ? 'me' : dmPeer, m.mine ? nickname() : dmName, m.body || '',
                  { self: !!m.mine, max: 26 });
    }
  }

  on($('dmSend'), 'click', sendDm);
  on($('dmInput'), 'keydown', function (e) { if (e.key === 'Enter') sendDm(); });
  function sendDm() {
    var v = ($('dmInput').value || '').trim();
    if (!v || !dmPeer) return;
    $('dmInput').value = '';
    // Shown as sent immediately, and in the field immediately. If the server
    // refuses it, it is taken back and the reason is said out loud — the one
    // failure here that has a rule behind it deserves the words, not a shrug.
    addDm({ mine: true, body: v }, true);
    var bubble = $('dmMsgs').lastChild;
    function undo(e) {
      var m = (e && e.message) || '';
      toast(/reference a project/i.test(m) ? t('dm_no_reason') : (m || '—'));
      /* The words STAY, marked as unsent and tappable. Deleting what somebody
         just typed because the network blinked makes them type it again from
         memory — and the one failure here with a rule behind it is exactly the
         one they will want to retry unchanged. */
      if (!bubble || !bubble.parentNode) return;
      bubble.classList.add('failed');
      var why = document.createElement('span');
      why.className = 'who'; why.textContent = t('dm_failed');
      bubble.appendChild(why);
      bubble.onclick = function () {
        bubble.parentNode.removeChild(bubble);
        $('dmInput').value = v;
        sendDm();
      };
    }
    // Promise.resolve().then, so that a THROW on the way to the request is
    // undone too. A synchronous failure used to leave the message sitting there
    // looking sent while nothing had left the phone — which is exactly how the
    // missing Rooms.nickname() hid for as long as it did.
    Promise.resolve()
      .then(function () { return Social.send(dmPeer, v, { author: nickname(), projectId: dmReason }); })
      .then(function () {
        // The reason is NOT spent. Until the other person answers, every message
        // still has to name the project (see api/dm.js) — dropping it here would
        // make the second sentence of a conversation fail for no visible reason.
        loadThread();
      })
      .catch(undo);
  }

  /* ── Comments ────────────────────────────────────────────────────────────
     A sheet over the app rather than a page instead of it: you are reading what
     people said ABOUT the thing on screen, and losing the thing to read about
     it is the wrong trade. */
  var cmtProject = null, cmtBtn = null, cmtParent = null;

  function openComments(p, btn) {
    cmtProject = p; cmtBtn = btn || null; cmtParent = null;
    $('cmtTitle').textContent = (p.capsule && p.capsule.title) || p.title || t('cmt_title');
    $('cmtList').innerHTML = '';
    $('cmtReplyTo').classList.add('hide');
    $('cmtSheet').classList.remove('hide');
    loadComments();
  }
  function closeComments() { $('cmtSheet').classList.add('hide'); cmtProject = null; }
  on($('cmtClose'), 'click', closeComments);
  on($('cmtSheet'), 'click', function (e) { if (e.target === $('cmtSheet')) closeComments(); });

  function loadComments() {
    if (!cmtProject) return;
    Social.comments(cmtProject.id).then(function (d) {
      var list = $('cmtList');
      list.innerHTML = '';
      var tops = (d && d.comments) || [];
      $('cmtEmpty').classList.toggle('hide', tops.length > 0);
      tops.forEach(function (c) { list.appendChild(commentEl(c, true)); });
      // Keep the row's count honest with what is on screen — a badge that
      // disagrees with the list it opens is worse than no badge.
      var n = tops.reduce(function (a, c) { return a + 1 + (c.replies || []).length; }, 0);
      if (cmtProject) cmtProject.comments = n;
      if (cmtBtn && cmtBtn.setCount) cmtBtn.setCount(n);
    }).catch(function () { $('cmtEmpty').classList.remove('hide'); });
  }

  function commentEl(c, top) {
    var el = document.createElement('div');
    el.className = 'cmt';
    var head = document.createElement('div'); head.className = 'top';
    var who = document.createElement('span'); who.className = 'who';
    who.textContent = c.author || t('dm_someone');
    head.appendChild(who);
    var body = document.createElement('div'); body.className = 'body';
    body.textContent = c.body || '';
    var bar = document.createElement('div'); bar.className = 'bar';

    var like = document.createElement('button');
    like.type = 'button';
    like.className = c.liked ? 'on' : '';
    like.textContent = '♥ ' + (c.likes || 0);
    like.onclick = function () {
      if (!requireIdentity()) return;
      Social.likeComment(c.id).then(function (r) {
        c.liked = !!r.on; c.likes = r.likes;
        like.className = c.liked ? 'on' : '';
        like.textContent = '♥ ' + (c.likes || 0);
      }).catch(function (e) { toast(e.message || '—'); });
    };
    bar.appendChild(like);

    // Two levels is the whole depth the server keeps, so replying is offered on
    // top-level comments only rather than pretending at a thread that flattens.
    if (top) {
      var rep = document.createElement('button');
      rep.type = 'button'; rep.textContent = t('cmt_reply');
      rep.onclick = function () { setReplyTo(c); };
      bar.appendChild(rep);
    }
    if (c.mine) {
      var del = document.createElement('button');
      del.type = 'button'; del.textContent = t('cmt_delete');
      del.onclick = function () {
        Social.deleteComment(c.id).then(loadComments).catch(function (e) { toast(e.message || '—'); });
      };
      bar.appendChild(del);
    }

    el.appendChild(head); el.appendChild(body); el.appendChild(bar);
    if (top && (c.replies || []).length) {
      var reps = document.createElement('div'); reps.className = 'reps';
      c.replies.forEach(function (r) { reps.appendChild(commentEl(r, false)); });
      el.appendChild(reps);
    }
    return el;
  }

  function setReplyTo(c) {
    cmtParent = cmtParent && cmtParent.id === c.id ? null : c;
    var lab = $('cmtReplyTo');
    lab.classList.toggle('hide', !cmtParent);
    if (cmtParent) lab.textContent = t('cmt_reply_to').replace('{name}', c.author || t('dm_someone'));
    $('cmtInput').focus();
  }
  on($('cmtReplyTo'), 'click', function () { cmtParent = null; $('cmtReplyTo').classList.add('hide'); });

  on($('cmtSend'), 'click', sendComment);
  on($('cmtInput'), 'keydown', function (e) { if (e.key === 'Enter') sendComment(); });
  function sendComment() {
    var v = ($('cmtInput').value || '').trim();
    if (!v || !cmtProject) return;
    if (!requireIdentity()) return;
    $('cmtInput').value = '';
    Social.comment(cmtProject.id, v, cmtParent && cmtParent.id)
      .then(function () {
        cmtParent = null;
        $('cmtReplyTo').classList.add('hide');
        loadComments();
      })
      .catch(function (e) { toast(e.message || '—'); });
  }

  /* ── The pairing bar ─────────────────────────────────────────────────────
     Linking a computer is what turns this from a demo into a window onto your
     own machine, and it used to be the last card of the last tab. It says so
     where it can be seen, and takes itself away the moment it is done — a
     banner that stays after it has been acted on is an advert. */
  function renderPairBar() {
    var bar = $('pairBar');
    if (!bar) return;
    var signedIn = !!T.user();
    var linked = (T.link.devices() || []).length > 0;
    bar.classList.toggle('hide', !signedIn || linked || current === 'me');
  }
  on($('pairBar'), 'click', function () {
    show('me');
    var f = $('pairCode');
    if (f) { f.focus(); f.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  });

  // ── The actual iPhone wallpaper ───────────────────────────────────────────


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

  /** How stale the stored frames may get before opening the app rebuilds them.
   *  Six hours: long enough that opening Terse repeatedly does not re-render a
   *  dozen wallpapers on a phone, short enough that the numbers on the Home
   *  Screen are from today. */
  var WALL_STALE_MS = 6 * 60 * 60 * 1000;
  /* A capture costs about twenty seconds of GPU and warms the phone, so it is
     not something to do every time a number ticks. Twenty minutes is short
     enough that a working session shows up on the Home Screen and long enough
     that a busy machine does not put the phone in a loop. */
  var WALL_FRESH_MIN_MS = 20 * 60 * 1000;
  var LS_WALL_FP = 'terse-wall-fp';

  /** What the wallpaper would SAY, as one comparable string.
   *
   *  Time alone was the old trigger and it is the wrong question: a phone that
   *  sat untouched for six hours got a new capture of identical numbers, while
   *  an agent that started five minutes ago did not show up until the next day.
   *  This compares the TEXT — if the field would draw the same words, there is
   *  nothing to re-capture. */
  function wallFingerprint(ov) {
    if (!ov) return '';
    return (ov.stage || []).map(function (it) {
      return (it.v != null ? it.v : '') + '\u0001' + (it.u || '');
    }).join('\u0002') + '\u0003' + (ov.agents || []).map(function (a) {
      return (a.name || '') + '\u0001' + (a.rate || 0);
    }).join('\u0002');
  }

  /** The overlays as they stand right now, from the linked desktop's frame. */
  function currentOverlays() {
    if (!HUD) return null;
    var st = T.link.state();
    return HUD.buildOverlays({
      stats: (st.frame && st.frame.stats) || {},
      sessions: (st.frame && st.frame.sessions) || [],
      tokens: lastTotal || 0,
      t: function (key, fallback) { return t(key) === key ? fallback : t(key); },
    });
  }

  /* ── The iPhone preview ──────────────────────────────────────────────────
     Shows the REAL captured frames inside a phone, cycled at the same two
     seconds the Shortcut loop uses. So this is not an illustration of the
     feature — it is the feature running, with the icons and clock that will
     actually be sitting on top of it.

     The icons are flat colour, deliberately. Anything resembling real app
     artwork would be someone else's trademark on a page that is not theirs,
     and the point here is legibility of the wallpaper behind them. */
  var IP_APPS = [
    ['#4CA5F5', 'Phone'], ['#5BC85B', 'Messages'], ['#F5A623', 'Notes'], ['#E8544E', 'Music'],
    ['#7B68EE', 'Photos'], ['#2FC4B2', 'Health'], ['#F0C419', 'Weather'], ['#8E8E93', 'Settings'],
  ];
  var IP_DOCK = ['#4CA5F5', '#5BC85B', '#8E8E93', '#E8544E'];

  var ipTimer = null, ipIdx = 0;

  /* A second, small engine inside the preview.
     The preview exists to answer "what will this look like on my phone", and
     before anything has been captured a flat backdrop answers nothing — the
     particles and the glyph text ARE the wallpaper. So the mockup runs its own
     field.

     Cheap on purpose: it is 186 points wide, so quality sits near the engine's
     floor, and it is disposed the moment the tab is left or the page hidden.
     Two WebGL contexts on a phone is a real cost, and this one earns it only
     while somebody is looking at it. */
  var ipWp = null;

  /** The same overlays the big field gets, so the preview shows the real numbers
   *  and the real glyph text rather than an idle field. */

  /** Cycle the captured frames, exactly as the loop on the phone will. */


      /* ── Backdrops ───────────────────────────────────────────────────────────
     The one choice this feature needs. Picking a backdrop is also what starts
     everything: the capture runs immediately, so there is a wallpaper waiting
     rather than another button to find. */
  var LS_BED = 'terse-phone-bed';

  function bedId() {
    /* VOID BY DEFAULT. The app is a black room with particles in it, and every
       other backdrop paints a coloured wash across the whole screen — aurora
       put a teal cast on the cards, the tab bar and the type, and the field
       stopped being the only light in the picture. The coloured beds stay, one
       tap away, for people who want them. */
    try { return localStorage.getItem(LS_BED) || 'void'; }
    catch (e) { return 'aurora'; }
  }

  function renderBeds() {
    var row = $('bedRow');
    if (!row || !window.TerseBeds) return;
    var current = T.photo() ? '__photo' : bedId();
    row.innerHTML = '';

    // The user's own photo sits first when they have one — it outranks anything
    // Terse ships, and hiding it in a separate control made it feel unrelated.
    if (T.photo()) {
      row.appendChild(bedButton('__photo', t('wall_bed_photo'), T.photo(), current));
    }
    window.TerseBeds.list().forEach(function (b) {
      row.appendChild(bedButton(b.id, (lang === 'zh' ? b.zh : b.en), window.TerseBeds.thumb(b.id, 96), current));
    });
  }

  function bedButton(id, label, src, current) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bed' + (id === current ? ' on' : '');
    var img = document.createElement('img');
    img.src = src; img.alt = '';
    var cap = document.createElement('span');
    cap.textContent = label;
    b.appendChild(img); b.appendChild(cap);
    b.onclick = function () {
      if (id === '__photo') { /* already theirs; just re-select */ }
      else { try { localStorage.setItem(LS_BED, id); } catch (e) {} T.setPhoto(null); }
      renderBeds();
      mountEngine();            // the field relights immediately
    };
    return b;
  }

    /* The glyph lines that go into the burst. Real numbers from the real snapshot,
     one per frame, so an album of these reads as the same wallpaper at different
     moments rather than six copies of one picture. */

  /* Capture the whole ring and upload it.
     Shared by the button and by picking a backdrop, because they are the same
     action — "make my wallpaper from this" — and having two copies of it was
     how the two paths drifted apart the first time. */
  /** One frame, with a deadline and a single retry.
   *  30s is generous for a few hundred kilobytes and short enough that a dead
   *  connection surfaces as an error rather than a frozen button. */
  /** One frame, with a FRESH token, a deadline and a single retry.
   *
   *  The token is fetched per request, not once for the run. A Clerk session
   *  token lives about a minute; a capture plus a dozen uploads takes longer
   *  than that. Taking one at the start meant the first frame stored and every
   *  later one came back 401 — which is precisely why a real account ended up
   *  with exactly one frame and a "session expired" message at the end.
   *
   *  getToken() is cheap and returns the cached token until it is near expiry,
   *  so this costs nothing per call and refreshes exactly when it must. */

  var capturing = false;

  /* Capturing needs a WebGL context of its own, and iOS gives a page very few.
     By the time Deploy is pressed this app is already holding two — the
     full-screen field, and the small one inside the phone preview — so the
     capture asks for a THIRD and the whole web app is killed. Safari does not
     warn and does not degrade; it reloads the page or goes blank, which is
     exactly what "deploy does nothing" looked like.

     Desktop browsers allow far more, which is why this never showed up here.

     So both are torn down for the duration and rebuilt afterwards. It costs a
     visible flicker on a button press that already takes several seconds, which
     is a fair trade for the feature working at all. */
  /* Actually giving a context back, which dispose() alone does not do.
     The engine's dispose() frees geometries, materials and textures and calls
     renderer.dispose() — but three.js's dispose() releases GPU MEMORY and keeps
     the WebGL context. Measured: tearing the field down and capturing left two
     live contexts, not one, because the first was never handed back.

     Two steps are needed. forceContextLoss() is what actually drops it, and the
     canvas is then replaced, because a canvas whose context has been force-lost
     is not reliably able to hand out a new one — and this canvas gets a new
     engine a few seconds later.

     Deliberately NOT fixed inside the shared engine: the desktop's mountEngine
     disposes and immediately re-attaches to the SAME canvas element, so adding
     a forced loss there would break engine switching on the Mac. The phone owns
     its canvases, so it can do the honest thing here. */
  function dropContext(engine, canvasId) {
    try { if (engine && engine.renderer) engine.renderer.forceContextLoss(); } catch (e) {}
    try { if (engine) engine.dispose(); } catch (e) {}
    var old = document.getElementById(canvasId);
    if (!old || !old.parentNode) return;
    var fresh = document.createElement('canvas');
    fresh.id = old.id;
    fresh.className = old.className;
    fresh.style.cssText = old.style.cssText;
    old.parentNode.replaceChild(fresh, old);
  }

  function releaseFields() {
    if (ipWp) { try { ipWp.stop(); } catch (e) {} dropContext(ipWp, 'ipStage'); ipWp = null; }
    if (wp) { try { wp.stop(); } catch (e) {} dropContext(wp, 'stage'); wp = null; }
  }
  function restoreFields() {
    if (!wp) mountEngine();
  }

  /** The transparent layer, for the Overlay Images route. Extracted so the one
      deploy button can produce it too — nobody should have to understand the
      difference between the two routes before either of them works. */

  /* ⚠ This button had no handler at all between the commit that added it and
     this one — it was lost in a cleanup and shipped dead. Restored rather than
     deleted because the endpoint and the encoder behind it are built and
     tested; the honest warning about whether iOS will animate the result lives
     in the label and the steps, not in a button that silently does nothing. */
  /* Tapping the ready-made Shortcut copies the link on the way out.
     A shared shortcut cannot carry somebody else's URL — shortcuts are signed,
     signing only happens on an Apple device, so there is one shortcut for
     everyone and the URL has to arrive from the user. Shortcuts asks for it
     with an import question, and an import question is a paste field. Putting
     the link on the clipboard in the same tap that opens Shortcuts turns the
     whole setup into: tap, Add Shortcut, paste.

     Deliberately not awaited: the navigation must not wait on the clipboard,
     and a refused write is survivable — the link is still on screen above. */
  /* The setup, as three routes rather than seventeen numbered steps in a row.
     Flat, they read as one impossibly long procedure and nobody finishes; the
     truth is they are alternatives, and only the first is the one most people
     want. So the first is open and the other two are folded, each numbered from
     one, because each really does start from the beginning. */

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
    renderPush();
    // Nothing to say about installing once it IS installed.
    $('installCard').classList.toggle('hide',
      !!(window.TerseInstall && window.TerseInstall.standalone()));
    $('pairCode').classList.toggle('hide', !signedIn);
    $('pairBtn').classList.toggle('hide', !signedIn);
    renderPairBar();
  }

  function claim(code) {
    if (!code) return;
    $('pairBtn').disabled = true;
    $('pairBtn').textContent = t('pairing');
    T.link.claim(code).then(function () {
      toast(t('paired'));
      $('pairCode').value = '';
      renderMe(); renderHUD(); renderPairBar();
    }).catch(function (e) {
      toast(e.message || '—');
    }).then(function () {
      $('pairBtn').disabled = false;
      $('pairBtn').textContent = t('pair');
    });
  }
  on($('pairBtn'), 'click', function () { claim(($('pairCode').value || '').trim()); });

  /* ── Notifications ──────────────────────────────────────────────────────
     iOS delivers push ONLY to a web app installed on the Home Screen, never
     from a Safari tab, and asking from a tab spends the one permission prompt
     the user gets — declined, it can only be undone in iOS Settings. So the
     button explains the install requirement instead of prompting, until the app
     is actually running standalone. */
  var pushKey = null;
  var pushSubscribed = false;

  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function renderPush() {
    var card = $('pushCard');
    if (!T.signedIn() || !pushKey || !pushKey.enabled) { card.classList.add('hide'); return; }
    card.classList.remove('hide');

    var state = $('pushState'), enable = $('pushEnable'), test = $('pushTest'), off = $('pushOff');
    if (!pushSupported()) {
      state.textContent = t('push_unsupported');
      enable.classList.add('hide'); test.classList.add('hide'); off.classList.add('hide');
      return;
    }
    var perm = Notification.permission;
    var on = perm === 'granted' && pushSubscribed;
    state.textContent = on ? t('push_on') : (perm === 'denied' ? t('push_blocked') : '');
    enable.classList.toggle('hide', on);
    enable.disabled = perm === 'denied';
    test.classList.toggle('hide', !on);
    off.classList.toggle('hide', !on);
  }

  function refreshPushState() {
    if (!pushSupported()) { renderPush(); return Promise.resolve(); }
    return navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { pushSubscribed = !!sub; renderPush(); })
      .catch(function () { renderPush(); });
  }

  on($('pushEnable'), 'click', function () {
    if (!standalone() && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      toast(t('push_need_install'));
      return;
    }
    var btn = $('pushEnable');
    btn.disabled = true;
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { toast(t('push_denied')); return null; }
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          // The key must be raw bytes, not the base64url string the server sends.
          applicationServerKey: (function (b64) {
            var pad = '='.repeat((4 - b64.length % 4) % 4);
            var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
            var out = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
            return out;
          })(pushKey.publicKey),
        });
      }).then(function (sub) {
        var j = sub.toJSON();
        j.standalone = standalone();
        return T.authToken().then(function (tok) {
          return fetch('/api/cloud/push/subscribe', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
            body: JSON.stringify(j),
          });
        });
      });
    }).then(function (r) {
      if (r && !r.ok) throw new Error('subscribe failed');
      if (r) toast('✓');
      return refreshPushState();
    }).catch(function () {
      toast(t('push_failed'));
    }).then(function () { btn.disabled = false; renderPush(); });
  });

  on($('pushTest'), 'click', function () {
    T.authToken().then(function (tok) {
      return fetch('/api/cloud/push/test', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    }).then(function (r) { return r.json(); })
      .then(function (j) { toast(j && j.sent ? t('push_sent') : t('push_failed')); })
      .catch(function () { toast(t('push_failed')); });
  });

  on($('pushOff'), 'click', function () {
    navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) {
        var endpoint = sub && sub.endpoint;
        // Unsubscribed on the DEVICE as well as forgotten on the server: leaving
        // the browser subscription alive means the push service keeps a route to
        // a device nothing will ever send to again.
        return (sub ? sub.unsubscribe() : Promise.resolve()).then(function () {
          return T.authToken().then(function (tok) {
            return fetch('/api/cloud/push/subscribe', {
              method: 'DELETE',
              headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
              body: JSON.stringify({ endpoint: endpoint }),
            });
          });
        });
      })
      .then(refreshPushState)
      .catch(function () { toast(t('push_failed')); });
  });

  // A way back to it for anyone who dismissed the sheet, or who came looking.
  on($('installShow'), 'click', function () {
    if (!window.TerseInstall) return;
    if (window.TerseInstall.standalone()) { toast(t('ins_already')); return; }
    window.TerseInstall.show(t, true);
  });

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

  /* ── The plaza's projects ────────────────────────────────────────────────
     A room is somewhere you GO and a project is something you WATCH, so they
     are two halves of the plaza rather than one list where every row is
     ambiguous.

     Tapping a project does not open a detail page. It sends you to the FIELD
     and plays it there — the capsule gathers out of the particles, the title
     comes up in big type, the author's lines and the top comments follow. The
     field is the viewer; a second, flatter rendering of the same capsule in a
     card would be a worse copy of it. */
  var projPool = [];

  /* ── The feed ────────────────────────────────────────────────────────────
     One project filling the screen, swipe for the next — and the picture is the
     FIELD, not a thumbnail. That is the whole reason this shape fits Terse:
     every other feed has to fetch a video, while a capsule is a few kilobytes
     of parameters that the phone already has, and the thing you scroll to is
     drawn live on the one canvas that is already running.

     So a slide holds only chrome — a title, two lines, a rail of buttons. A
     hundred slides is a hundred small boxes of text. A hundred particle systems
     would be a hundred WebGL contexts, which is not a thing a phone will give
     you (see the preview panes, and the five rounds before them).

     Snapping is native CSS scroll-snap rather than a gesture library: it is
     what these feeds are actually built on, it inherits the platform's own
     momentum and rubber-banding, and it keeps snapping while JavaScript is busy
     assembling a city. */
  var feedAt = -1, feedSwiped = false;

  /** Fit the feed to whatever room is actually left. Measured, not computed
   *  from constants: the header and the segmented control above it can change
   *  height with the language, and on iOS the viewport itself changes as the
   *  URL bar collapses. A snap feed whose slides are not exactly the container
   *  height snaps to the wrong place, visibly. */
  function sizeFeed() {
    var host = $('pzProjects'), main = document.querySelector('main'), seg = $('plazaSeg');
    if (!host || !main) return;
    var used = seg ? seg.getBoundingClientRect().height + 10 : 0;
    var h = Math.max(320, main.clientHeight - used);
    host.style.height = h + 'px';
  }
  on(window, 'resize', function () { if (current === 'plaza') sizeFeed(); });
  on(window, 'orientationchange', function () { setTimeout(sizeFeed, 260); });

  function renderProjects() {
    var feed = $('projFeed'), empty = $('projEmpty');
    if (!feed) return;
    sizeFeed();
    feed.innerHTML = '';
    feedAt = -1;
    empty.classList.toggle('hide', projPool.length > 0);

    projPool.forEach(function (p, idx) {
      var cap = (p && p.capsule) || {};
      var s = document.createElement('div');
      s.className = 'slide';
      s.dataset.i = String(idx);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var b = document.createElement('b'); b.textContent = cap.title || p.title || '—';
      var d = document.createElement('p'); d.textContent = cap.subtitle || '';
      var who = document.createElement('div'); who.className = 'who';
      (cap.langs || []).slice(0, 2).forEach(function (l) {
        var tg = document.createElement('span'); tg.className = 'tag';
        tg.textContent = l[0] + ' ' + Math.round((+l[1] || 0) * 100) + '%';
        who.appendChild(tg);
      });
      if (cap.files) {
        var f = document.createElement('span');
        f.textContent = cap.files + ' ' + t('feed_files');
        who.appendChild(f);
      }
      if ((cap.dirs || []).length) {
        var c = document.createElement('span');
        c.textContent = cap.dirs.length + ' ' + t('feed_buildings');
        who.appendChild(c);
      }
      meta.appendChild(b); meta.appendChild(d); meta.appendChild(who);

      s.appendChild(railFor(p));
      s.appendChild(meta);
      if (idx === 0 && !feedSwiped) {
        var hint = document.createElement('div');
        hint.className = 'swipehint';
        hint.textContent = t('feed_hint');
        s.appendChild(hint);
      }
      feed.appendChild(s);
    });

    /* ⚠ WHICH SLIDE YOU ARE ON IS ARITHMETIC, NOT AN OBSERVER.
       The first version used an IntersectionObserver per slide, and it never
       fired once: it starts observing while the plaza view is still hidden, so
       its root has zero height, and a zero-height root intersects nothing. The
       feed scrolled beautifully and the field stayed blank.

       That is the third time today an IntersectionObserver has been the wrong
       tool for "has this become visible", so: every slide is exactly the
       container height — that is what makes the snap exact — which means the
       index is scrollTop / clientHeight, and there is nothing to observe or
       mistime. Debounced to the end of the gesture so a fast flick through ten
       projects starts one show, not ten. */
    var settle = null;
    on(feed, 'scroll', function () {
      clearTimeout(settle);
      settle = setTimeout(function () {
        var h = feed.clientHeight || 1;
        var idx = Math.max(0, Math.min(projPool.length - 1, Math.round(feed.scrollTop / h)));
        if (idx === feedAt) return;
        feedAt = idx;
        if (idx > 0 && !feedSwiped) {
          feedSwiped = true;
          var hint = feed.querySelector('.swipehint');
          if (hint) hint.remove();
        }
        playInFeed(projPool[idx]);
      }, 140);
    });
    // And play the one you land on, without waiting for a scroll that may never
    // come — most people look at the first project before they touch anything.
    feedAt = 0;
    playInFeed(projPool[0]);
  }

  /** The rail: the four things you can do, at thumb height on the right. */
  function railFor(p) {
    var rail = document.createElement('div');
    rail.className = 'rail';
    function btn(glyph, n, on, cls) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = (on ? 'on ' : '') + (cls || '');
      var g = document.createElement('span'); g.className = 'g'; g.textContent = glyph;
      var c = document.createElement('span'); c.className = 'n'; c.textContent = n > 0 ? String(n) : '';
      b.appendChild(g); b.appendChild(c);
      b.setCount = function (v) { c.textContent = v > 0 ? String(v) : ''; };
      rail.appendChild(b);
      return b;
    }
    var like = btn('♥', p.likes || 0, p.liked);
    var fav = btn('☆', p.favs || 0, p.faved, 'fav');
    var cmt = btn('💬', p.comments || 0, false);
    var dm = btn('✉', 0, false);

    function toggle(b, call, countKey, flagKey) {
      b.onclick = function (e) {
        e.stopPropagation();
        if (!requireIdentity()) return;
        var was = b.classList.contains('on'), n = p[countKey] || 0;
        b.classList.toggle('on', !was);
        p[flagKey] = !was; p[countKey] = Math.max(0, n + (was ? -1 : 1));
        b.setCount(p[countKey]);
        if (window.TerseFeel) window.TerseFeel.tap();
        call(p.id).then(function (r) {
          if (r && typeof r.count === 'number') { p[countKey] = r.count; b.setCount(r.count); }
          if (r && typeof r.on === 'boolean') { p[flagKey] = r.on; b.classList.toggle('on', r.on); }
        }).catch(function (err) {
          b.classList.toggle('on', was); p[flagKey] = was; p[countKey] = n; b.setCount(n);
          toast(err.message || '—');
        });
      };
    }
    toggle(like, Social.like, 'likes', 'liked');
    toggle(fav, Social.fav, 'favs', 'faved');
    cmt.onclick = function (e) { e.stopPropagation(); openComments(p, cmt); };
    dm.onclick = function (e) {
      e.stopPropagation();
      openDm(p.author, null, p.id, (p.capsule && p.capsule.title) || p.title);
    };
    if (!p.author || p.author === myPeerId()) dm.classList.add('hide');
    return rail;
  }

  /** Play the capsule you have landed on, on the field's own canvas. */
  function playInFeed(p) {
    if (!p || !wp || !window.TersePlazaField) return;
    try { window.TersePlazaField.stop(wp); } catch (e) {}
    try { wp.clearHeadline && wp.clearHeadline(); } catch (e) {}
    viewing = p;                       // the field is about this now, not the visitor
    var cap = window.TersePlazaField.toCapsule(p);
    clearInterval(pjTimer);
    var run = function () { try { wp.showProject(cap, showLen(p)); } catch (e) {} };
    run();
    pjTimer = setInterval(run, showLen(p) + 900);
    try { Social.view && Social.view(p.id); } catch (e) {}
  }


  /* ── What you can do about somebody else's project ───────────────────────
     The counts were read-only: you could see that eleven people liked it and
     had no way to be the twelfth.

     Every one of these is optimistic — the heart fills on the tap, not on the
     round trip — and puts itself back if the server disagrees. On a phone on a
     train the honest-looking alternative is a button that does nothing for two
     seconds, and people press it again. */
  function actBtn(glyph, n, on) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'act' + (on ? ' on' : '');
    var g = document.createElement('span'); g.textContent = glyph;
    var c = document.createElement('span'); c.className = 'n'; c.textContent = n > 0 ? String(n) : '';
    b.appendChild(g); b.appendChild(c);
    b.setCount = function (v) { c.textContent = v > 0 ? String(v) : ''; };
    return b;
  }

  function projectActions(p, opts) {
    opts = opts || {};
    var box = document.createElement('div');
    // Same buttons, same handlers, wider targets in the window — the row in a
    // list and the bar under a project are the SAME control, and building a
    // second one would be where the two quietly stop agreeing.
    box.className = 'acts' + (opts.wide ? ' wide' : '');

    var like = actBtn('♥', p.likes || 0, p.liked);
    var fav = actBtn('☆', p.favs || 0, p.faved);
    fav.classList.add('fav');
    var cmt = actBtn('💬', p.comments || 0, false);
    var dm = actBtn('✉', 0, false);

    function toggle(btn, call, countKey, flagKey) {
      btn.onclick = function () {
        if (!requireIdentity()) return;
        var was = btn.classList.contains('on');
        var n = p[countKey] || 0;
        // Draw the answer first, then ask.
        btn.classList.toggle('on', !was);
        p[flagKey] = !was; p[countKey] = Math.max(0, n + (was ? -1 : 1));
        btn.setCount(p[countKey]);
        if (window.TerseFeel) window.TerseFeel.tap();
        call(p.id).then(function (r) {
          // The server's count is the real one — an optimistic guess drifts as
          // soon as anyone else touches the same project.
          if (r && typeof r.count === 'number') { p[countKey] = r.count; btn.setCount(r.count); }
          if (r && typeof r.on === 'boolean') { p[flagKey] = r.on; btn.classList.toggle('on', r.on); }
        }).catch(function (e) {
          btn.classList.toggle('on', was);
          p[flagKey] = was; p[countKey] = n; btn.setCount(n);
          toast(e.message || '—');
        });
      };
    }
    toggle(like, Social.like, 'likes', 'liked');
    toggle(fav, Social.fav, 'favs', 'faved');
    cmt.onclick = function () { openComments(p, cmt); };
    dm.onclick = function () {
      openDm(p.author, null, p.id, (p.capsule && p.capsule.title) || p.title);
    };
    // Closing the window first: the conversation is a different place, and
    // leaving the city playing behind a chat is two things at once.
    if (opts.wide) {
      var open = dm.onclick;
      dm.onclick = function () { closeProject(); open(); };
    }
    // You cannot write to yourself, and offering the button is worse than not
    // having it: it looks like the feature is broken rather than inapplicable.
    if (!p.author || p.author === myPeerId()) dm.classList.add('hide');

    box.appendChild(like); box.appendChild(fav); box.appendChild(cmt); box.appendChild(dm);
    return box;
  }

  /* ── The project window ──────────────────────────────────────────────────
     Tapping a project used to switch to the Field TAB and leave a toast behind.
     The project played under whatever you happened to have open, there was
     nothing to press, and — because the engine never advanced the layer (see
     mineradio-wallpaper.js) — usually nothing appeared at all.

     It has its own window now, and the window is mostly a hole: the code city
     is drawn on the same canvas that is behind every view, so the chrome is a
     title at the top and a bar for your thumb at the bottom. Anything more
     would be a card sitting on top of the thing you came to look at.

     ⚠ THE SHOW IS RE-ARMED, NOT STRETCHED. `showProject(cap, ms)` spreads the
     carousel across `ms`, so asking for a ten-minute show gives one frame every
     two and a half minutes — the readings would never come round. It runs its
     natural ~22s and starts again while the window is open. */
  var viewing = null;
  var lastStage = null;
  var pjTimer = null;

  /** Long enough for the four readings to breathe, short enough that the
   *  capsule re-gathers while you are still watching. */
  function showLen(p) {
    var cap = window.TersePlazaField ? window.TersePlazaField.toCapsule(p) : null;
    var shots = 1 + ((cap && cap.shots) || []).length;
    // ~4.5s a beat, and never fewer than the four readings the city rotates.
    return 1400 + 4500 * Math.max(4, shots);
  }

  /* ── ONE ENGINE. THIS IS A REVERSAL, AND THE REASON MATTERS ──────────────
     The preview briefly had its own canvas and its own engine, so that opening
     a project could not disturb the field. It worked on a desktop browser and
     it failed on the thing it ships to: iOS Safari caps how many live WebGL
     contexts a page may hold, and a second full-screen particle system is
     exactly the request it refuses. The constructor threw, the catch set the
     handle to null, openProject returned — and the window opened black, with
     the chrome drawn and nothing in it. Reported three times as "I click the
     project and nothing shows".

     So the preview draws on the field's own engine again, and the promise that
     the field is left alone is kept a different way: the project is an OVERLAY
     layer, and hideProject() takes it off. What was on the field before is what
     is on it afterwards, to the particle.

     It is also the answer to the app being janky: one full-screen particle
     system on a phone GPU, never two. */

  /* ⚠ THIS CATCH USED TO BE EMPTY, AND THAT IS MOST OF WHY THIS TOOK FIVE
     ROUNDS. Every way the preview has failed — stale data, a canvas measured
     before layout, one thing drawn over another, a WebGL context iOS would not
     grant — produced the same black window and not one word anywhere. An empty
     catch on the single call that draws the thing is the worst place in this
     app to hide a reason.

     Now it says so on screen, and it TELLS THE SERVER, because "try it again
     and see" is asking somebody else to do my debugging for me. See
     api/clientlog.js. */
  function replayProject() {
    if (!viewing || !wp) return;
    var cap = window.TersePlazaField.toCapsule(viewing);
    var ok = false, err = '';
    try {
      ok = wp.showProject(cap, showLen(viewing)) !== false;
    } catch (e) {
      err = (e && (e.message || String(e))) || 'threw';
      ok = false;
    }
    if (!ok) {
      $('pjNote').textContent = err ? t('pj_broke').replace('{why}', err) : t('pj_nothing');
      $('pjNote').classList.remove('hide');
    }
    /* Sampled LATE on purpose. The first version of this probe fired the
       instant showProject returned and reported an all-zero position buffer —
       which was true and meant nothing, because the layer fills and uploads its
       buffers on the animation frames that follow. A probe that reads before
       the thing it is watching has happened invents a bug. */
    setTimeout(function () { reportProject(cap, ok, err); }, 2500);
  }

  /** One line about what this device actually did. Sent once per open, never
   *  per frame, and it carries sizes, flags and counts — no capsule, no title,
   *  no identity. Best-effort by design: a probe that can break the thing it is
   *  watching is worse than no probe. */
  var reported = 0;
  function reportProject(cap, ok, err) {
    if (Date.now() - reported < 4000) return;
    reported = Date.now();
    var L = (wp && wp._lastProjLayout) || {};
    var gl = '';
    try {
      var c = document.createElement('canvas');
      var g = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (g) {
        var dbg = g.getExtension('WEBGL_debug_renderer_info');
        gl = dbg ? String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'webgl';
      } else { gl = 'no webgl'; }
    } catch (e) { gl = 'gl threw'; }
    var body = {
      tag: 'project-open', ok: !!ok, err: err || '',
      W: L.W || null, H: L.H || null, narrow: L.narrowFrame == null ? null : !!L.narrowFrame,
      dpr: window.devicePixelRatio || 1,
      dirs: (cap.dirs || []).length,
      commits: (cap.commits || []).length,
      graph: (cap.graph && cap.graph.n && cap.graph.n.length) || 0,
      imgs: L.imgs == null ? null : L.imgs,
      engine: !!wp,
      started: !!(wp && wp._raf),
      vis: (wp && wp._projLayer && wp._projLayer.u && wp._projLayer.u.uVis)
        ? wp._projLayer.u.uVis.value : null,
      // The scene state itself. Everything above can be right while the points
      // are simply not in the picture — hidden, unparented, or drawn by a
      // camera that cannot see where they were put.
      scene: (function () {
        try {
          var L = wp._projLayer, cam = wp._silk && wp._silk.cam;
          var g = L.cityPoints.geometry, pos = g && g.attributes && g.attributes.position;
          /* The REAL extent, not three.js's cached boundingSphere — that is
             computed once and kept, so a buffer filled after the first compute
             reports the old answer forever. Read the array. */
          /* ⚠ `position` is only where a point STARTS. The shader flies each
             one from position to aTarget by uForm, so an all-zero `position` is
             normal and says nothing — I read it first and nearly called it the
             bug. aTarget is where the city actually is. */
          function extent(attr) {
            if (!attr || !attr.array) return 'none';
            var arr = attr.array, lo = 1e9, hi = -1e9, nz = 0;
            var step = Math.max(3, Math.floor(arr.length / 3000) * 3);
            for (var k = 0; k < arr.length; k += step) {
              var v = arr[k];
              if (v < lo) lo = v;
              if (v > hi) hi = v;
              if (v !== 0) nz++;
            }
            return lo.toFixed(2) + '..' + hi.toFixed(2) + ' nz=' + nz + ' ver=' + attr.version;
          }
          var tgt = g && g.attributes && g.attributes.aTarget;
          var col = g && g.attributes && g.attributes.aColor;
          var scl = g && g.attributes && g.attributes.aScale;
          return [
            'cityVis=' + L.cityPoints.visible,
            'imgVis=' + L.points.visible,
            'cityParent=' + (L.cityPoints.parent ? L.cityPoints.parent.type : 'NONE'),
            'imgParent=' + (L.points.parent ? L.points.parent.type : 'NONE'),
            'count=' + (pos ? pos.count : -1),
            'draw=' + (g ? g.drawRange.count : -1),
            'aTarget[' + extent(tgt) + ']',
            'aColor[' + extent(col) + ']',
            'aScale[' + extent(scl) + ']',
            'form=' + (L.u && L.u.uForm ? L.u.uForm.value.toFixed(2) : '?'),
            'cam=' + (cam ? (cam.isPerspectiveCamera ? 'persp fov' + cam.fov + ' z' + Math.round(cam.position.z) : 'ortho ' + Math.round(cam.left) + '..' + Math.round(cam.right) + ' near' + cam.near + ' far' + cam.far) : 'none'),
            'size=' + ((wp._lastProjLayout && wp._lastProjLayout.SIZE) || '?'),
          ].join(' ');
        } catch (e) { return 'scene threw: ' + (e && e.message); }
      }()),
      gl: gl,
      console: conErr.join(' || ').slice(0, 900),
      ua: navigator.userAgent,
      build: window.__TERSE_BUILD || '',
    };
    try {
      fetch('/api/cloud/clientlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(function () {});
    } catch (e) {}
  }

  function openProject(p) {
    if (!window.TersePlazaField) return;
    viewing = p;
    // The field is about to be somebody's project. Two showcase contexts on top
    // of that is exactly the spend that broke this before.
    stopPreviews();
    var cap = window.TersePlazaField.toCapsule(p);
    $('pjTitle').textContent = cap.title || '—';
    $('pjSub').textContent = cap.subtitle || '';

    /* Say when there is no city rather than showing an empty sky. A capsule
       published before the plaza carried one has a cover and some lines and
       nothing else — and "an empty field" is indistinguishable from "broken",
       which is exactly how it was reported. So it says which of the two it is,
       and what the owner has to do about it. */
    var hasCity = !!(cap.dirs && cap.dirs.length);
    $('pjNote').textContent = hasCity ? '' : t('pj_no_city');
    $('pjNote').classList.toggle('hide', hasCity);

    var bar = $('pjBar');
    bar.innerHTML = '';
    bar.appendChild(projectActions(p, { wide: true }));

    show('project');
    // The plaza tab stays lit: this window is somewhere you went FROM the
    // plaza, and an unlit tab bar reads as "you are nowhere".
    var pz = document.querySelector('nav button[data-tab="plaza"]');
    if (pz) pz.classList.add('on');

    /* No engine at all means the field itself failed to load — a WebGL refusal,
       a dropped context. Say so instead of opening a black window: an empty
       preview and a broken engine look identical, and one of them is worth
       telling somebody about. */
    if (!wp) { $('pjNote').textContent = t('pj_no_engine'); $('pjNote').classList.remove('hide'); return; }

    // The ambient rotation of other people's projects has to stop first: two
    // capsules dissolving into each other is not a transition, it is a mess.
    try { window.TersePlazaField.stop(wp); } catch (e) {}
    // And whatever the field was saying about the visitor goes — the headline
    // rotation replays its last lines, so muting the feed is not enough on its
    // own. Those glyphs land straight on top of somebody's code city.
    try { wp.clearHeadline && wp.clearHeadline(); } catch (e) {}

    replayProject();
    clearInterval(pjTimer);
    pjTimer = setInterval(replayProject, showLen(p) + 900);
    try { Social.view && Social.view(p.id); } catch (e) {}
  }

  /** Tear the preview down. Separate from closeProject so that show() can call
   *  it while navigating without bouncing back through show() again. */
  function endProject() {
    clearInterval(pjTimer); pjTimer = null;
    viewing = null;
    try { if (wp) wp.hideProject(); } catch (e) {}
    // The field goes back to talking about the visitor on the next poll, but a
    // poll can be seconds away and the screen is already the field again — so
    // say something now rather than leaving it silent.
    try { if (wp && wp.setStageItems && lastStage) wp.setStageItems(lastStage); } catch (e) {}
  }

  function closeProject() {
    clearInterval(pjTimer); pjTimer = null;
    viewing = null;
    /* The overlay comes off and the field is exactly what it was — that is the
       whole of the promise that a preview does not disturb it. The ambient
       rotation of strangers' projects restarts on its own from the poll, which
       re-asks whether anything is linked. */
    try { if (wp) wp.hideProject(); } catch (e) {}
    show('plaza');
  }
  on($('pjBack'), 'click', closeProject);

  /* Double-tap the sky to like it. The heart in the bar works too, but this is
     the interaction people perform most often, and asking them to aim at a
     small target for it is the wrong trade. Drawn where the thumb landed. */
  (function () {
    var last = 0, lastX = 0, lastY = 0;
    on($('pjSpace'), 'pointerup', function (e) {
      var now = Date.now();
      var near = Math.abs(e.clientX - lastX) < 44 && Math.abs(e.clientY - lastY) < 44;
      if (now - last < 380 && near) {
        last = 0;
        likeFromTap(e.clientX, e.clientY);
      } else { last = now; lastX = e.clientX; lastY = e.clientY; }
    });
  }());

  function likeFromTap(x, y) {
    if (!viewing || !requireIdentity()) return;
    var pop = document.createElement('div');
    pop.className = 'heartpop';
    pop.textContent = '♥';
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
    document.body.appendChild(pop);
    setTimeout(function () { pop.remove(); }, 760);
    if (window.TerseFeel) window.TerseFeel.tap();
    // A double tap only ever ADDS a like. Toggling here would mean the second
    // enthusiastic tap of the evening quietly takes yours away.
    var btn = $('pjBar').querySelector('.act');
    if (btn && !btn.classList.contains('on')) btn.click();
  }

  function loadProjects() {
    if (!$('projFeed')) return Promise.resolve();
    // Through Social, because it sends the identity header — without it the
    // server has no idea which of these YOU liked, and every heart comes back
    // empty however many times you have pressed it.
    return Social.projects(100)
      .then(function (j) {
        projPool = (j && Array.isArray(j.projects)) ? j.projects : [];
        renderProjects();
      })
      .catch(function () { renderProjects(); });
  }

  Array.prototype.forEach.call(document.querySelectorAll('#plazaSeg button'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#plazaSeg button'), function (o) {
        o.classList.toggle('on', o === b);
      });
      var projects = b.dataset.plaza === 'projects';
      plazaHalf = projects ? 'projects' : 'rooms';
      $('pzRooms').classList.toggle('hide', projects);
      $('pzProjects').classList.toggle('hide', !projects);
      if (projects) { if (!projPool.length) loadProjects(); }
      // Rooms are volatile in a way projects are not — somebody opened one
      // while you were reading — so switching to them always re-asks.
      else loadPlaza();
    };
  });
  /* No Refresh button any more — the feed is the whole screen and a chrome
     button on top of it would be the only thing in the way. Landing on the
     plaza fetches; pulling past the end is the gesture people already use. */

  /* ── Bare by default ─────────────────────────────────────────────────────
     The field IS the app, so it opens as nothing but the field. Everything
     that CHANGES it — backdrop, style, the numbers — is one tap away and not
     in the way until then.

     The choice is remembered: somebody who opened the controls once is telling
     us they want them, and making them ask again every launch is the app
     forgetting. */
  var LS_BARE = 'terse-field-bare';
  function setBare(on) {
    var v = $('v-field');
    if (!v) return;
    v.classList.toggle('bare', !!on);
    try { localStorage.setItem(LS_BARE, on ? '1' : '0'); } catch (e) {}
    if (window.TerseFeel) window.TerseFeel.tap();
    /* ⚠ THE ONE TRIGGER THAT IS NOT A RACE. Opening the controls IS the moment
       the showcase becomes visible, it is a real tap so the view is laid out
       and the engine long since loaded, and collapsing them is the moment it
       stops being visible. Every indirect signal I tried — an observer, a
       timeout after a tab switch, the poll — was either raced or simply not
       running for a guest, and each failure left two blank canvases sitting
       there. A user action cannot be early. */
    if (on) stopPreviews();
    else setTimeout(startPreviews, 80);
  }
  (function initBare() {
    var v = $('v-field');
    if (!v) return;
    var saved = null;
    try { saved = localStorage.getItem(LS_BARE); } catch (e) {}
    // Default bare, and only a deliberate "0" opens it — an absent key is a
    // first visit, which is exactly who should see the field and nothing else.
    v.classList.toggle('bare', saved !== '0');
  })();
  on($('fieldPeek'), 'click', function () { setBare(false); });
  on($('fieldHide'), 'click', function () { setBare(true); });

  /* ── The gate opens when the field has answered ──────────────────────────
     Research is unambiguous that a multi-screen carousel is the wrong shape:
     replacing one with a single value screen lifts progression to the next
     step 15–30%, and a first session containing one MEANINGFUL action retains
     2–3× better than one that is scrolled and closed. So there is no carousel
     and no slides about the field — the field is the demo, it is already
     running, and it already answers a finger.

     The meaningful action is touching it. Until that happens the gate shows
     almost nothing and does not take pointer events, so the touch it is asking
     for reaches the canvas underneath. Once the field has answered, the words
     and the sign-in arrive.

     ⚠ It opens on a real gesture, not a timer. A gate that reveals itself after
     four seconds teaches nothing and takes the credit for something the visitor
     did not do. */
  var gateOpened = false;
  function openGate() {
    if (gateOpened) return;
    gateOpened = true;
    var g = $('gate');
    if (!g) return;
    g.classList.remove('invite');
    g.classList.add('opened');
    if (window.TerseFeel) window.TerseFeel.tap('heavy');
  }

  (function armGate() {
    var g = $('gate');
    if (!g || !g.classList.contains('invite')) return;
    var stage = $('stage');
    if (!stage) return;
    // Any real contact counts: a tap, a drag, a scroll of the field.
    ['pointerdown', 'touchstart'].forEach(function (ev) {
      stage.addEventListener(ev, openGate, { passive: true, once: false });
    });
    /* A floor under it: somebody who reads instead of touching still gets in.
       Long enough that it is not a timer wearing a gesture's clothes, short
       enough that nobody is stuck looking at two lines of text. */
    setTimeout(openGate, 12000);
  })();

  /* ── Touch feedback, once, for everything ────────────────────────────────
     Bound at the document rather than per control. Every button added later —
     a room, a friend, a backdrop rendered from data — gets the same answer
     without anybody remembering to ask for it, and there is one place to
     change how the whole app feels.

     pointerdown, not click: the tick has to land when the finger lands. On
     release it arrives after the thing already happened and reads as lag. */
  document.addEventListener('pointerdown', function (e) {
    if (!window.TerseFeel) return;
    var el = e.target && e.target.closest && e.target.closest('button,.item,.bed,.style,a.btn');
    if (!el || el.disabled) return;
    // Primary actions get a heavier tick than incidental ones. iOS web gives a
    // single texture, so this only changes the rate limit — but it keeps the
    // call sites honest, and it is free if the platform ever grows more.
    window.TerseFeel.tap(el.classList.contains('primary') ? 'heavy' : 'select');
  }, { passive: true });

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
      renderPairBar();
      // The unread count on the tab, once, at boot: a message that arrived
      // while the app was closed is otherwise invisible until you go looking.
      Social.inbox().then(function (d) { markUnread(d && d.unread); }).catch(function () {});
      if (pending) { claim(pending); pending = null; show('me'); }
    });
  }

  function openApp(signedIn) {
    /* BEFORE anything talks to the cloud. Settling the identity after
       connectRoom() would leave this session's room membership registered under
       the old random secret while friends and messages used the new one — the
       exact split this is here to close. */
    if (signedIn) {
      var who = T.user();
      if (who && who.id) Social.adopt(who.id);
      ensureMyPeerId();
    }
    $('gate').classList.add('hide');
    $('app').classList.remove('hide');
    if (T.photo()) $('clearPhoto').classList.remove('hide');
    connectRoom();
    renderStyles();
    /* The backdrops used to be painted by renderWall, which went out with the
       wallpaper card. They belong to the field, which every state has — a guest
       who never signs in still picks what lights the particles — so they are
       painted here beside the styles rather than from a tab hook. */
    renderBeds();
    // Painted for EVERY state, not just the signed-in one: the empty state is
    // the whole message for a guest ("link a computer to see your agents"), and
    // gating it behind sign-in left a silent, blank card.
    renderHUD();
    if (signedIn) afterAuth();
    var start = (location.pathname.match(/^\/m\/(field|plaza|room|friends|me)/) || [])[1];
    show(start || (pending ? 'me' : 'field'));

    /* The install sheet, after a beat. Held back deliberately: the first thing
       anyone should see is the field, not a prompt asking for something. It
       never appears once installed, and a dismissal is remembered — an install
       prompt that returns every launch is an advert. */
    if (window.TerseInstall) {
      setTimeout(function () { window.TerseInstall.show(t, false); }, 2600);
    }
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
  // Whether this deployment can push at all — the card stays hidden otherwise.
  fetch('/api/cloud/push/key')
    .then(function (r) { return r.json(); })
    .then(function (k) { pushKey = k; return refreshPushState(); })
    .catch(function () {});

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
    if (document.visibilityState !== 'visible') {
      if (wp) wp.stop();
      return;
    }
    if (wp) wp.start();
    requestWake();
    // Rooms' own EventSource is subject to the same iOS silent-close as the link
    // stream, and rooms.js cannot fix it from inside: it never learns the app was
    // backgrounded. Reconnecting from out here is the only place that knows.
    if (Rooms.inRoom()) connectRoom();
    renderHUD();
  });

  if ('serviceWorker' in navigator) {
    /* Stamped with the build. The browser fetches this URL directly, so no HTML
       rewrite can reach it, and an edge cache holding an old sw.js pins the
       whole app to whatever that worker cached. A query string does not change
       the script's PATH, so the worker still gets root scope. */
    var build = window.__TERSE_BUILD;
    navigator.serviceWorker.register('/sw.js' + (build ? '?v=' + encodeURIComponent(build) : ''))
      .catch(function () {});
  }
})();
