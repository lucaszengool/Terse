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
      wall_body: 'Home Screen and Lock Screen both work, and once it is set up you do nothing. A Shortcut can loop it every 2 seconds in bursts of about 40 — that is as long as iOS lets anything run in the background — fired every time you open an app you use anyway. Motion on the Lock Screen is a Live Photo; the Home Screen never animates for any app, which is iOS, not Terse.',
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
      field_idle_1: 'Terse', field_idle_2: 'link a computer',
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
      wall_pickbed: 'Pick a backdrop — Terse builds the wallpaper from it',
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
      wall_body: '主屏幕和锁屏都能用，而且设好之后你什么都不用做。快捷指令可以 2 秒一换、一轮跑 40 秒左右——这已经是 iOS 允许后台跑的极限——挂在你本来就天天开的 App 上自动触发。锁屏上会动的那种是 Live Photo；主屏幕对任何 App 都不会动，这是 iOS 的规矩，不是 Terse 的。',
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
      field_idle_1: 'Terse', field_idle_2: 'link a computer',
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
      wall_pickbed: '选个底图 —— Terse 用它来做壁纸',
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

  function view3dReady() { return !!(V3 && wp && wp.layers && wp.layers.length); }

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
      onStart: function () { if (stopGlide) { stopGlide(); stopGlide = null; } },
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
    feedPreviewField();
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
    /* The wallpaper card moved to this tab but its render was still being
       driven from the Me tab, where it used to live — so the backdrops, the
       phone preview and its icons only appeared if you happened to visit Me
       first. It belongs with the tab it is on. */
    if (tab === 'wallpaper') {
      renderWall();
      mountPreviewField();
      if (T.signedIn() && !wallState) loadWall();
    } else {
      unmountPreviewField();     // nothing is looking at it
    }
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
    /* Both drawn before the early return below. They are local — the backdrops
       and the phone's own icons and clock — and should be there immediately,
       not after the first API round-trip. The chrome sat after the return once,
       and the Home Screen came up with an empty dock and no icons whenever the
       wallpaper state had not loaded. */
    renderBeds();
    renderPhoneChrome();
    // Drawn here, not from renderMe. The steps belong to this card, and being
    // rendered from the tab the card used to live on meant they only appeared
    // if you happened to open Me first — the fifth time that exact mistake was
    // made in this file, which is why the wiring test now asserts it.
    renderWallSteps();
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
      // Preference order reflects which route keeps the most of what the user
      // already has: their own wallpaper, then motion, then a whole frame.
      /* ALWAYS the frame link.
         This used to prefer the overlay when one existed, on the theory that
         the newest thing was the most wanted. It is the opposite: the overlay
         is a transparent layer for the Overlay Images route, and handing it to
         Set Wallpaper gives iOS an image with nothing behind it — which fails
         as "com.apple.extensionKit.errorDomain 错误 2", a message that says
         nothing about the cause. The other two links live in their own
         sections, where what they are is written next to them. */
      $('wallUrl').value = wallState.url;
    }

    // The ready-made Shortcut, when one has been published. Its absence is a
    // supported state — the written steps below work on their own.
    /* shortcuts:// only exists on iOS. On anything else the button is a link
       that fails silently, which is exactly the dead-control problem the wiring
       test was written for. */
    var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    $('wallOpenShortcuts').classList.toggle('hide', !isIOS);

    var sc = $('wallShortcut'), scNote = $('wallShortcutNote');
    if (wallState.shortcut_url) {
      sc.href = wallState.shortcut_url;
      sc.classList.remove('hide');
      scNote.classList.remove('hide');
    } else {
      sc.classList.add('hide');
      scNote.classList.add('hide');
    }

    var age = ago(wallState.fetched_at);
    $('wallAge').textContent = !wallState.ready ? ''
      : (wallState.frames + ' · ' + (age ? t('wall_ago').replace('{t}', age) : t('wall_never')));

    if (wallState.ready && wallState.url) {
      /* One <img> per stored frame. Each fetch of the URL returns the NEXT one,
         so asking for it `frames` times with different cache-busters collects
         the whole ring — the same mechanism the Shortcut relies on, which is
         why seeing it work here is worth something. */
      var n = Math.max(1, Math.min(wallState.frames || 1, 12));
      var stamp = Date.now();
      var urls = [];
      for (var i = 0; i < n; i++) urls.push(wallState.url + '?v=' + stamp + '-' + i);
      startPreviewCycle(urls);
      $('wallSaveHint').classList.remove('hide');
    }
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

  function loadWall() {
    if (!T.signedIn()) return Promise.resolve(null);
    return T.authToken().then(function (tok) {
      if (!tok) return null;
      return fetch('/api/cloud/wallpaper', { headers: { Authorization: 'Bearer ' + tok } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          wallState = j;
          renderWall();
          /* Keep it current on its own. Once somebody has set the Shortcut up,
             the frames on their Home Screen are only as fresh as the last
             capture — and the only moment this app can run is while it is open,
             so this is the one chance it gets. Never on a page that is not
             visible: the capture needs animation frames, which a hidden page
             does not get, and it would fail for a reason nobody could see. */
          if (j && j.ready && document.visibilityState === 'visible') {
            var at = j.updated_at ? Date.parse(j.updated_at.replace(' ', 'T') + 'Z') : 0;
            var age = at ? Date.now() - at : 0;
            /* Two reasons to re-capture, and the first is the one that matters:
               the numbers on the Home Screen no longer match the numbers this
               account has. The six-hour rule stays as a floor for the case
               where nothing is linked and the fingerprint never changes. */
            var fpNow = wallFingerprint(currentOverlays());
            var fpHad = '';
            try { fpHad = localStorage.getItem(LS_WALL_FP) || ''; } catch (e) {}
            var changed = !!fpNow && !!fpHad && fpNow !== fpHad;
            if (at && ((changed && age > WALL_FRESH_MIN_MS) || age > WALL_STALE_MS)) {
              captureRing(true);
            }
          }
          return j;
        });
    }).catch(function () { return null; });
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

  function mountPreviewField() {
    var c = $('ipStage');
    if (!c || !Engine || ipWp) return;
    try {
      ipWp = new Engine(c, {
        theme: 'neon', quality: 26, angle: 42, intensity: 1,
        style: T.isPro() ? styleId() : 'cinematic',
        pro: T.isPro(),
        photo: T.photo() || (window.TerseBeds && window.TerseBeds.render(bedId(), 190, 410)),
      });
      ipWp.start();
      feedPreviewField();
    } catch (e) { ipWp = null; }
  }

  function unmountPreviewField() {
    if (!ipWp) return;
    // Same reason as releaseFields: dispose() on its own keeps the context, and
    // this runs on every tab change — so it leaked one per switch.
    try { ipWp.stop(); } catch (e) {}
    dropContext(ipWp, 'ipStage');
    ipWp = null;
  }

  /** The same overlays the big field gets, so the preview shows the real numbers
   *  and the real glyph text rather than an idle field. */
  function feedPreviewField() {
    if (!ipWp || !HUD) return;
    var st = T.link.state();
    var ov = HUD.buildOverlays({
      stats: (st.frame && st.frame.stats) || {},
      sessions: (st.frame && st.frame.sessions) || [],
      tokens: lastTotal || 0,
      t: function (key, fallback) { return t(key) === key ? fallback : t(key); },
    });
    try {
      ipWp.setActivity(ov.activity || 0.3);
      if (ipWp.setAgents) ipWp.setAgents(ov.agents);
      if (ipWp.setStageItems && ov.stage.length) ipWp.setStageItems(ov.stage);
      if (ipWp.setAgentLog && ov.logGroups.length) ipWp.setAgentLog(ov.logGroups);
    } catch (e) {}
  }

  function renderPhoneChrome() {
    var grid = $('ipGrid'), dock = $('ipDock');
    if (!grid || grid.children.length) return;      // built once
    IP_APPS.forEach(function (a) {
      var el = document.createElement('div');
      el.className = 'iapp';
      var i = document.createElement('i');
      i.style.background = a[0];
      var sp = document.createElement('span');
      sp.textContent = a[1];
      el.appendChild(i); el.appendChild(sp);
      grid.appendChild(el);
    });
    IP_DOCK.forEach(function (c) {
      var i = document.createElement('i');
      i.style.background = c;
      dock.appendChild(i);
    });
    var now = new Date();
    var hh = now.getHours(), mm = String(now.getMinutes()).padStart(2, '0');
    var clock = hh + ':' + mm;
    $('ipTime').textContent = clock;
    document.querySelector('.ilock-time').textContent = clock;
  }

  /** Cycle the captured frames, exactly as the loop on the phone will. */
  function startPreviewCycle(urls) {
    var screen = $('wallPrev');
    if (!screen) return;
    if (ipTimer) { clearInterval(ipTimer); ipTimer = null; }
    // Only the images: the live canvas underneath stays, so the preview never
    // drops to an empty rectangle between states.
    Array.prototype.forEach.call(screen.querySelectorAll('img'), function (n) { n.remove(); });
    if (!urls.length) return;

    var imgs = urls.map(function (u, i) {
      var im = document.createElement('img');
      im.src = u; im.alt = '';
      if (i === 0) im.className = 'on';
      screen.appendChild(im);
      return im;
    });
    ipIdx = 0;
    if (imgs.length < 2) return;
    // Two seconds, because that is the Wait the shortcut uses. Seeing the
    // preview and the phone move at the same rate is the point.
    ipTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      imgs[ipIdx].classList.remove('on');
      ipIdx = (ipIdx + 1) % imgs.length;
      imgs[ipIdx].classList.add('on');
    }, 2000);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.iseg button'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.iseg button'), function (o) {
        o.classList.toggle('on', o === b);
      });
      var home = b.dataset.screen === 'home';
      $('ipHome').classList.toggle('hide', !home);
      $('ipLock').classList.toggle('hide', home);
    };
  });

      /* ── Backdrops ───────────────────────────────────────────────────────────
     The one choice this feature needs. Picking a backdrop is also what starts
     everything: the capture runs immediately, so there is a wallpaper waiting
     rather than another button to find. */
  var LS_BED = 'terse-phone-bed';

  function bedId() {
    try { return localStorage.getItem(LS_BED) || (window.TerseBeds && window.TerseBeds.DEFAULT_ID) || 'aurora'; }
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
      mountEngine();            // the live field changes immediately
      unmountPreviewField();    // and so does the one inside the phone
      mountPreviewField();
      captureRing(true);        // and the wallpaper is rebuilt from it
    };
    return b;
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
  function uploadFrame(slot, blob, retried) {
    return T.authToken().then(function (tok) {
      if (!tok) throw new Error('signed out');
      return fetch('/api/cloud/wallpaper?slot=' + slot, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': blob.type || 'image/jpeg' },
        body: blob,
        signal: AbortSignal.timeout(30000),
      });
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ('upload failed (' + r.status + ')'));
        });
      }
      return r.json();
    }).catch(function (err) {
      // One retry, because a single dropped request on a phone is normal and
      // losing the whole capture to it is not.
      if (retried) throw err;
      return uploadFrame(slot, blob, true);
    });
  }

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
    if (current === 'wallpaper') mountPreviewField();
  }

  function captureRing(auto) {
    if (capturing) return Promise.resolve(null);
    if (!T.signedIn()) return Promise.resolve(null);
    capturing = true;
    releaseFields();

    var btn = $('wallCapture');
    var label = auto ? 'wall_capturing_auto' : 'wall_capturing';
    btn.disabled = true;
    btn.textContent = t(label);

    var ov = currentOverlays();
    // Written BEFORE the capture, not after: if it fails halfway the numbers on
    // the phone are whatever they were, and recording the attempt stops a
    // failing capture from retrying on every single load.
    try { localStorage.setItem(LS_WALL_FP, wallFingerprint(ov)); } catch (e) {}

    var shot = null;
    return window.TerseCapture.capture({
      style: T.isPro() ? styleId() : 'cinematic',
      pro: T.isPro(),
      photo: T.photo(),
      bedId: bedId(),
      overlays: ov,
      count: (wallState && wallState.slots) || 12,
      texts: wallTexts(ov),
      onStep: function (p, l) { btn.textContent = t(label) + ' ' + (l || Math.round(p * 100) + '%'); },
    }).then(function (res) {
      shot = res;
      var blobs = (res && res.blobs) || [];
      if (!blobs.length) throw new Error('no frame');
      return (function () {
        /* Three at a time, not one after another.
           A twelve-long serial chain is only as fast as its slowest link and
           only as reliable as its unluckiest one: a single stalled request
           blocks the eleven behind it, which is how the button sat on "12/12"
           with one frame stored. Three is enough to keep the connection busy
           without being the dozen-at-once that stalls a phone.

           done counts COMPLETIONS, so the label cannot claim more progress
           than actually happened — the old one was set before each request and
           reached 12/12 while eleven frames were still in flight. */
        var done = 0;
        var failed = [];
        function runOne(i) {
          return uploadFrame(i, blobs[i])
            .then(function (j) { done++; return j; })
            .catch(function (e) { failed.push(i); throw e; })
            .then(function (j) {
              btn.textContent = t('wall_uploading') + ' ' + done + '/' + blobs.length;
              return j;
            });
        }
        var next = 0, last = null;
        function worker() {
          if (next >= blobs.length) return Promise.resolve(last);
          var i = next++;
          return runOne(i).then(function (j) { last = j; return worker(); });
        }
        return Promise.all([worker(), worker(), worker()]).then(function () {
          if (failed.length) throw new Error(failed.length + ' frame(s) failed to upload');
          return last;
        });
      })();
    }).then(function (j) {
      wallState = j;
      renderWall();
      /* The COUNT, not just "done". One frame and twelve both used to look
         identical here, and one frame means the loop sets the same picture
         over and over — which is the difference between a wallpaper that
         animates and one that does not. */
      var n = (j && j.frames) || 0;
      /* A capture can pass every check it has and still be a picture of
         nothing. That is not hypothetical: the field was laid out for a
         viewport three times too large for a long time, every frame came back
         as bare backdrop, and this line cheerfully said "12 frames".

         liveliness() is mean luminance of the PARTICLE layer alone — the
         backdrop is composited afterwards and cannot prop the number up. A
         drawing field measured 2.56 on a real iPhone; the broken one measured
         0.001. Anything under this floor means the engine drew nothing, not
         that the user is idle: the glyphs are drawn from the stats whatever
         they say, so even a quiet account is far above it. */
      var lit = 0;
      ((shot && shot.scores) || []).forEach(function (v) { if (v > lit) lit = v; });
      if (shot && shot.scores && shot.scores.length && lit < 0.05) {
        toast(t('wall_blank'));
      } else {
        toast(t(auto ? 'wall_bed_done' : 'wall_deployed') + ' · ' + t('wall_frames').replace('{n}', n));
      }
      /* The transparent layer costs one more short render and makes the "keep
         my own wallpaper" route work with no second decision. Never awaited and
         never fatal — the deploy has already succeeded by this point. */
      if (!auto) captureOverlay().catch(function () {});
      return j;
    }).catch(function (err) {
      /* The message matters more than the label here. "This device cannot
         capture the field" is true of a lost WebGL context, a refused upload and
         an expired session alike, and it sent me looking in the wrong place for
         a day. */
      toast(err && err.code === 'hidden' ? t('wall_hidden')
        : t('wall_failed') + (err && err.message ? ' — ' + err.message : ''));
      return null;
    }).then(function (j) {
      capturing = false;
      restoreFields();
      btn.disabled = false;
      btn.textContent = t('wall_deploy');
      return j;
    });
  }

  on($('wallCapture'), 'click', function () { captureRing(false); });

  /** The transparent layer, for the Overlay Images route. Extracted so the one
      deploy button can produce it too — nobody should have to understand the
      difference between the two routes before either of them works. */
  function captureOverlay() {
    releaseFields();          // same three-context problem as captureRing
    var st = T.link.state();
    var ov = HUD ? HUD.buildOverlays({
      stats: (st.frame && st.frame.stats) || {},
      sessions: (st.frame && st.frame.sessions) || [],
      tokens: lastTotal || 0,
      t: function (key, fallback) { return t(key) === key ? fallback : t(key); },
    }) : null;

    return window.TerseCapture.capture({
      style: T.isPro() ? styleId() : 'cinematic',
      pro: T.isPro(),
      photo: T.photo(),
      bedId: bedId(),
      overlays: ov,
      transparent: true,
      count: 1,
      texts: wallTexts(ov),
    }).then(function (res) {
      return T.authToken().then(function (tok) {
        return fetch('/api/cloud/wallpaper/overlay', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/png' },
          body: res.blob,
        });
      });
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('upload failed');
      return r.json();
    }).then(function (j) { wallState = j; renderWall(); return j; })
      // Restored whether it worked or not: leaving the app with no field at all
      // is worse than the failure that got us here.
      .finally(function () { restoreFields(); });
  }

  on($('wallOverlay'), 'click', function () {
    var btn = $('wallOverlay');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t('wall_overlaying');
    captureOverlay()
      .then(function () { toast(t('wall_overlay_ready')); })
      .catch(function (err) { toast(t(err && err.code === 'hidden' ? 'wall_hidden' : 'wall_failed')); })
      .then(function () { btn.disabled = false; btn.textContent = t('wall_overlay'); });
  });

  /* ⚠ This button had no handler at all between the commit that added it and
     this one — it was lost in a cleanup and shipped dead. Restored rather than
     deleted because the endpoint and the encoder behind it are built and
     tested; the honest warning about whether iOS will animate the result lives
     in the label and the steps, not in a button that silently does nothing. */
  on($('wallVideo'), 'click', function () {
    var btn = $('wallVideo');
    if (btn.disabled) return;
    if (!window.TerseCapture.canEncodeVideo()) { toast(t('wall_video_unsupported')); return; }
    btn.disabled = true;
    btn.textContent = t('wall_recording');
    releaseFields();          // the encode holds a context for four seconds

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
      bedId: bedId(),
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
      restoreFields();
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

  /* Tapping the ready-made Shortcut copies the link on the way out.
     A shared shortcut cannot carry somebody else's URL — shortcuts are signed,
     signing only happens on an Apple device, so there is one shortcut for
     everyone and the URL has to arrive from the user. Shortcuts asks for it
     with an import question, and an import question is a paste field. Putting
     the link on the clipboard in the same tap that opens Shortcuts turns the
     whole setup into: tap, Add Shortcut, paste.

     Deliberately not awaited: the navigation must not wait on the clipboard,
     and a refused write is survivable — the link is still on screen above. */
  on($('wallShortcut'), 'click', function () {
    var v = $('wallUrl').value;
    if (v && navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
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

  /* The setup, as three routes rather than seventeen numbered steps in a row.
     Flat, they read as one impossibly long procedure and nobody finishes; the
     truth is they are alternatives, and only the first is the one most people
     want. So the first is open and the other two are folded, each numbered from
     one, because each really does start from the beginning. */
  var STEP_GROUPS = [
    /* BUILD THE SHORTCUT FIRST, THEN CHOOSE HOW IT FIRES.
       These used to be one list that went straight from "make the shortcut"
       into building a personal automation, which is six screens deep in
       Settings and cannot be shared or synced — Apple's own limit, not ours.
       Back Tap reaches the same shortcut in three, and firing it is two knocks
       on the back of the phone. So the shortcut is its own group, and the
       triggers are a menu underneath it with the cheapest one first. */
    {
      key: 'wall_g_loop', open: true,
      steps: [['wall_s1b', 'wall_s1s'], ['wall_s2b', 'wall_s2s'], ['wall_s3b', 'wall_s3s'],
              ['wall_a1b', 'wall_a1s'], ['wall_a2b', 'wall_a2s']],
    },
    {
      key: 'wall_g_trigger', open: true,
      steps: [['wall_t1b', 'wall_t1s'], ['wall_t2b', 'wall_t2s'],
              ['wall_t3b', 'wall_t3s'], ['wall_t4b', 'wall_t4s'], ['wall_t5b', 'wall_t5s']],
    },
    {
      key: 'wall_g_own', open: false,
      steps: [['wall_o1b', 'wall_o1s'], ['wall_o2b', 'wall_o2s'], ['wall_o3b', 'wall_o3s'], ['wall_o4b', 'wall_o4s']],
    },
    {
      key: 'wall_g_live', open: false,
      steps: [['wall_v1b', 'wall_v1s'], ['wall_v2b', 'wall_v2s'], ['wall_v3b', 'wall_v3s'], ['wall_v4b', 'wall_v4s']],
    },
  ];

  function renderWallSteps() {
    var host = $('wallSteps');
    if (!host) return;
    host.innerHTML = '';

    STEP_GROUPS.forEach(function (g) {
      var box = document.createElement('details');
      box.className = 'fold stepgroup';
      if (g.open) box.open = true;
      var sum = document.createElement('summary');
      sum.textContent = t(g.key);
      box.appendChild(sum);

      var ol = document.createElement('ol');
      ol.className = 'steps';
      g.steps.forEach(function (pair) {
        var li = document.createElement('li');
        var b = document.createElement('b'); b.textContent = t(pair[0]);
        var sp = document.createElement('span'); sp.textContent = t(pair[1]);
        li.appendChild(b); li.appendChild(sp);
        ol.appendChild(li);
      });
      box.appendChild(ol);
      host.appendChild(box);
    });

    var note = document.createElement('p');
    note.className = 'note';
    note.textContent = t('wall_note');
    host.appendChild(note);
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
    renderPush();
    // Nothing to say about installing once it IS installed.
    $('installCard').classList.toggle('hide',
      !!(window.TerseInstall && window.TerseInstall.standalone()));
    $('pairCode').classList.toggle('hide', !signedIn);
    $('pairBtn').classList.toggle('hide', !signedIn);
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
      unmountPreviewField();
      return;
    }
    if (wp) wp.start();
    if (current === 'wallpaper') mountPreviewField();
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
