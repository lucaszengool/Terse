/**
 * guide-data.js — 交互式用户指南的内容表。
 *
 * 每一条对应 Terse 主界面侧边栏里的一项(分组和顺序与 src/renderer/index.html 一致):
 *   Monitor  overview observe stats connection
 *   Optimize doctor cleanup rules
 *   Secure   mcp alerts
 *   Library  prompts graph history team farm boost wallpaper pals settings
 *
 * 每条给四样东西 —— 少一样这个指南就没用:
 *   what   这是什么
 *   how    怎么用(具体点哪儿)
 *   effect **点完之后 app 之外发生了什么** —— 终端里、Claude Code 窗口里、
 *          磁盘上、系统通知里。Terse 大半价值在 app 窗口外面,只讲界面等于没讲。
 *   demo   下游动画的类型 + 要滚动的那几行,交给 guide.html 去演
 *
 * 文案按 en/zh 两套写。站点的语言机制是 data-i18n + i18n.js(8 种语言)加一个独立的
 * zh/ 目录;这张表跟着 window.i18n.lang 走,zh 用中文,其余全部回落英文 —— 和站点
 * 其它页面的行为一致。
 */
(function () {
  var G = {};

  // demo 类型:terminal(终端) / claude(Claude Code 窗口) / file(Finder) /
  //           notify(系统通知) / config(配置文件) / desktop(桌面)
  G.FEATURES = [
    /* ══ Monitor ══ */
    {
      key: 'overview',
      ui: 'kpi',
      steps: [{ zh: '打开 app，默认就在这一页', en: 'Open the app — this is the default page' }, { zh: '看四块 KPI 判断当下状态', en: 'Read the four KPI tiles' }, { zh: '点某个 agent 跳到它的实时日志', en: 'Click an agent to jump to its live log' }],
      gain: { zh: '一屏看清今天花了多少、省了多少', en: 'One screen: what today cost and what it saved' }, group: 'Monitor', icon: '▦',
      name: { en: 'Overview', zh: '总览' },
      what: {
        en: 'The one screen that answers "what is this costing me right now". Live spend, burn rate, tokens saved, and context health for every connected agent.',
        zh: '一屏回答「现在到底在花多少钱」。实时花费、消耗速率、已省 token，以及每个已连接 agent 的上下文健康度。'
      },
      how: {
        en: 'It is the default page. The four KPI tiles update live; the agent list below shows every session Terse has attached to.',
        zh: '打开就是这一页。上方四块 KPI 实时跳动，下面列出 Terse 已接管的每一个会话。'
      },
      effect: {
        en: 'Nothing is changed here — this page only reads. Every number traces back to a real event Terse intercepted, so clicking an agent jumps to its live log.',
        zh: '这一页只读，不改任何东西。每个数字都能追回到 Terse 真实拦下的那次事件，点某个 agent 会跳到它的实时日志。'
      },
      demo: { kind: 'terminal', lines: [
        { en: '$ terse status', zh: '$ terse status' },
        { en: '4 agents attached · 336.6M in today', zh: '已接管 4 个 agent · 今日 336.6M 进' },
        { en: 'saved 12,962 tok · $1.40 recovered', zh: '已省 12,962 tok · 追回 $1.40' }
      ]}
    },
    {
      key: 'observe',
      ui: 'log',
      steps: [{ zh: '在标签里选一个 agent', en: 'Pick an agent from the tabs' }, { zh: '逐行看它调了什么工具', en: 'Read each tool call line by line' }, { zh: '右侧角标是这一行的 token 增减', en: "The badge is that row's token delta" }],
      gain: { zh: '看得见每一次调用的真实代价', en: "Every call's real cost, visible" }, group: 'Monitor', icon: '◉',
      name: { en: 'Observe', zh: '实时监控' },
      what: {
        en: 'A live feed of what each agent is doing turn by turn: which tool it called, how many tokens that call cost, and what Terse trimmed before it went out.',
        zh: '逐轮实时看每个 agent 在干什么：调了哪个工具、这次花了多少 token、Terse 在发出去之前剪掉了什么。'
      },
      how: {
        en: 'Pick an agent from the tabs. Each row is one message; the badge on the right is that row\'s token delta.',
        zh: '在标签里选一个 agent。每一行是一条消息，右边的角标是这一行的 token 增减。'
      },
      effect: {
        en: 'This is a read of the agent\'s real stream, captured as it happens. What you see here is exactly what the model received — not a reconstruction.',
        zh: '这是对 agent 真实流的实时读取。你在这里看到的就是模型真正收到的内容，不是事后重建的。'
      },
      demo: { kind: 'claude', lines: [
        { en: '⚙ Read(src/auth.ts)        +614', zh: '⚙ Read(src/auth.ts)        +614' },
        { en: '← Read → 312 lines folded  −1.2k', zh: '← Read → 312 行已折叠      −1.2k' },
        { en: '◆ Merging verification…    +842', zh: '◆ 正在合并校验…            +842' }
      ]}
    },
    {
      key: 'stats',
      ui: 'chart',
      steps: [{ zh: '切换 日 / 周 / 月', en: 'Switch day / week / month' }, { zh: '悬停柱子看当天明细', en: 'Hover a bar for that day' }, { zh: '导出 CSV 交给财务', en: 'Export a CSV for finance' }],
      gain: { zh: '按模型、按天把账算清', en: 'Cost broken down by model and day' }, group: 'Monitor', icon: '▤', pro: true,
      name: { en: 'Stats', zh: '统计' },
      what: {
        en: 'The receipt. Input vs output tokens, cost per model, per-day trend, and how much of it Terse took back.',
        zh: '一张收据。输入/输出 token、按模型的花费、按天的趋势，以及其中有多少是 Terse 帮你拿回来的。'
      },
      how: {
        en: 'Switch the range (day / week / month). Hover any bar for that day\'s breakdown.',
        zh: '切换范围（日 / 周 / 月）。悬停任意柱子看那天的明细。'
      },
      effect: {
        en: 'Numbers come from Terse usage log, written on every real token event. Export gives you a CSV you can hand to finance.',
        zh: '数字来自 Terse usage log，每次真实 token 事件都会写入。导出会给你一份可以直接交给财务的 CSV。'
      },
      demo: { kind: 'file', lines: [
        { en: 'Terse usage log', zh: 'Terse usage log' },
        { en: '+ 2026-08-13 · in 336.6M · saved 12,962', zh: '+ 2026-08-13 · 进 336.6M · 省 12,962' },
        { en: '→ export terse-stats-aug.csv', zh: '→ 导出 terse-stats-aug.csv' }
      ]}
    },
    {
      key: 'connection',
      ui: 'list',
      steps: [{ zh: '找到你在用的 agent', en: 'Find the agent you use' }, { zh: '点「连接」', en: 'Click Connect' }, { zh: '角标变 live 即生效', en: 'The badge turns live' }],
      gain: { zh: '一次接管，之后每一轮都被看着', en: 'Attach once — every turn after is watched' }, group: 'Monitor', icon: '⇄',
      name: { en: 'Connection', zh: '连接' },
      what: {
        en: 'Where you attach Terse to an agent. Claude Code, Codex, Cursor, Copilot, Cline, Windsurf — Terse connects to each of them.',
        zh: '在这里把 Terse 接到 agent 上。Claude Code、Codex、Cursor、Copilot、Cline、Windsurf 都能接。'
      },
      how: {
        en: 'Click Connect next to an agent. Terse connects and the badge turns live — no restart of the agent needed.',
        zh: '在某个 agent 旁点「连接」。Terse 接上之后角标随即变成 live —— 不需要重启 agent。'
      },
      effect: {
        en: 'Terse links itself to that agent. Your next turn in that terminal is already being watched — nothing for you to configure.',
        zh: 'Terse 把自己接到那个 agent 上。那个终端里的下一轮就已经在被监听了 —— 你不用配置任何东西。'
      },
      demo: { kind: 'terminal', lines: [
        { en: '$ claude', zh: '$ claude' },
        { en: '+ Terse connected', zh: '+ Terse 已接管' },
        { en: '+ watching this session', zh: '+ 正在监听这个会话' }
      ]}
    },

    /* ══ Optimize ══ */
    {
      key: 'doctor',
      ui: 'score',
      steps: [{ zh: '点「扫描」', en: 'Press Scan' }, { zh: '逐条看动画演示的问题', en: 'Watch each finding animate' }, { zh: '点一键修复', en: 'Hit the one-click Fix' }],
      gain: { zh: '74 → 96 分 · 每天追回 $1.40', en: 'Score 74 → 96 · $1.40/day back' }, group: 'Optimize', icon: '✚',
      name: { en: 'Doctor', zh: '体检' },
      what: {
        en: '11 scanners over your whole AI workflow: redundant reads, bloated system prompts, stale sessions, cache misses, runaway loops, oversized tool results.',
        zh: '对整条 AI 工作流跑 11 项扫描：重复读取、臃肿的系统提示、陈旧会话、缓存未命中、失控循环、超大工具结果。'
      },
      how: {
        en: 'Hit Scan. Each finding is animated so you can see what it means, and most carry a one-click Fix.',
        zh: '点「扫描」。每条结论都有动画演示它到底是什么问题，大部分带一键修复。'
      },
      effect: {
        en: 'A Fix rewrites real config — a rule added, a session pruned, a cache prefix re-primed — and the score moves. 74 → 96 is $1.40/day back.',
        zh: '「修复」会真的改配置 —— 加一条规则、清一个会话、重建一次缓存前缀 —— 分数随之变化。74 → 96 等于每天追回 $1.40。'
      },
      demo: { kind: 'config', lines: [
        { en: 'Terse settings', zh: 'Terse settings' },
        { en: '+ rule: never re-read the same file', zh: '+ 规则：同一文件不再重复读' },
        { en: '✓ score 74 → 96 · $1.40/day recovered', zh: '✓ 评分 74 → 96 · 每天追回 $1.40' }
      ]}
    },
    {
      key: 'cleanup',
      ui: 'list',
      steps: [{ zh: '看一遍待清理清单', en: 'Review the sweep list' }, { zh: '取消勾选想保留的', en: 'Uncheck what you keep' }, { zh: '点「清理」', en: 'Press Sweep' }],
      gain: { zh: '释放 14.2 MB 磁盘 + 310 MB 内存', en: '14.2 MB disk + 310 MB memory freed' }, group: 'Optimize', icon: '⌫', pro: true,
      name: { en: 'Cleanup', zh: '清理' },
      what: {
        en: 'Sweeps what has gone stale: dead session snapshots, cache junk, orphaned logs that no agent will ever read again.',
        zh: '清掉已经没用的东西：死掉的会话快照、缓存垃圾、再也不会被读的孤儿日志。'
      },
      how: {
        en: 'Review the list, uncheck anything you want to keep, then Sweep.',
        zh: '看一遍清单，把想留的取消勾选，然后点「清理」。'
      },
      effect: {
        en: 'These files are actually deleted from disk and the memory they were pinning is released. Nothing is hidden — the list is the truth.',
        zh: '这些文件会真的从磁盘上删掉，它们占住的内存也随之释放。没有隐藏项 —— 清单上是什么就删什么。'
      },
      demo: { kind: 'file', lines: [
        { en: '− Terse cache   14.2 MB', zh: '− Terse cache   14.2 MB' },
        { en: '− 4 stale session snapshots', zh: '− 4 个陈旧会话快照' },
        { en: '+ 310 MB resident memory freed', zh: '+ 释放 310 MB 常驻内存' }
      ]}
    },
    {
      key: 'rules',
      ui: 'toggle',
      steps: [{ zh: '挑一条规则', en: 'Pick a rule' }, { zh: '打开开关', en: 'Toggle it on' }, { zh: '下一轮就生效', en: 'It applies next turn' }],
      gain: { zh: '同一文件不再重读 · 省 67%', en: 'No file read twice · 67% off' }, group: 'Optimize', icon: '≡',
      name: { en: 'Rules', zh: '规则' },
      what: {
        en: 'Standing instructions Terse enforces on every outgoing prompt: never re-read the same file, fold search results, cap tool output, strip filler.',
        zh: '对每一条发出去的 prompt 长期生效的规矩：同一文件不再重读、折叠搜索结果、限制工具输出、剥掉冗余表达。'
      },
      how: {
        en: 'Toggle a rule on. It applies from the agent\'s very next turn — no restart.',
        zh: '把某条规则打开。它从 agent 的下一轮就开始生效 —— 不用重启。'
      },
      effect: {
        en: 'The request the agent actually sends changes shape. Same task, fewer tokens, identical behaviour.',
        zh: 'agent 真正发出去的请求变了形状。同一件事，更少的 token，行为不变。'
      },
      demo: { kind: 'claude', lines: [
        { en: '− Read(src/auth.ts) ×3   1,842 tok', zh: '− Read(src/auth.ts) ×3   1,842 tok' },
        { en: '+ Read(src/auth.ts) ×1     614 tok', zh: '+ Read(src/auth.ts) ×1     614 tok' },
        { en: '✓ 1,228 tokens saved this turn', zh: '✓ 本轮省下 1,228 tokens' }
      ]}
    },

    /* ══ Secure ══ */
    {
      key: 'mcp',
      ui: 'list',
      steps: [{ zh: '看每个 server 的真实成本', en: "See each server's real cost" }, { zh: '关掉用不到的', en: "Disable what you don't use" }, { zh: '重复项会自动标出', en: 'Duplicates are flagged' }],
      gain: { zh: '工具 24 → 9 · 每轮少 7.4k', en: 'Tools 24 → 9 · 7.4k less per turn' }, group: 'Secure', icon: '⛨',
      name: { en: 'Secure MCP', zh: 'MCP 安全' },
      what: {
        en: 'Every MCP server your agent can see costs tokens — its tool descriptions ride along in every single turn. This page shows the real cost of each one.',
        zh: '你的 agent 能看到的每一个 MCP server 都在花钱 —— 它的工具描述每一轮都要跟着发一次。这一页给出每个 server 的真实成本。'
      },
      how: {
        en: 'Disable the servers you are not using. Duplicates are flagged automatically.',
        zh: '把用不到的 server 关掉。重复的会被自动标出来。'
      },
      effect: {
        en: 'The agent\'s tool list physically shrinks — the config file is rewritten and the next turn carries fewer descriptions.',
        zh: 'agent 看到的工具表会实实在在变短 —— 配置文件被改写，下一轮携带的描述更少。'
      },
      demo: { kind: 'config', lines: [
        { en: 'Agent config', zh: 'Agent config' },
        { en: '− filesystem-2, filesystem-3', zh: '− filesystem-2、filesystem-3' },
        { en: '+ tools 24 → 9 · −7.4k tok per turn', zh: '+ 工具 24 → 9 · 每轮少 7.4k tok' }
      ]}
    },
    {
      key: 'alerts',
      ui: 'alertspage',
      steps: [{ zh: '设一个阈值', en: 'Set a threshold' }, { zh: '选通知方式', en: 'Choose how to be told' }, { zh: '越线立刻弹通知', en: 'It fires the moment you cross' }],
      gain: { zh: '超支之前就被叫住', en: 'Stopped before the bill grows' }, group: 'Secure', icon: '⚠',
      name: { en: 'Alerts', zh: '预警' },
      what: {
        en: 'Thresholds that shout before the bill does: a turn over N tokens, a session over a budget, a context creeping past a limit, a loop that will not stop.',
        zh: '在账单开口之前先喊一声：单轮超过 N tokens、单次会话超预算、上下文爬过红线、停不下来的循环。'
      },
      how: {
        en: 'Set a threshold and choose how you want to be told — banner, system notification, or both.',
        zh: '设一个阈值，再选怎么通知你 —— 横幅、系统通知，或者两个都要。'
      },
      effect: {
        en: 'A real macOS notification fires the moment the line is crossed, whichever app you are in. Terse can auto-compact at the same time.',
        zh: '一旦越线就会弹出真正的 macOS 系统通知，不管你当时在哪个 app 里。Terse 可以同时自动压缩。'
      },
      demo: { kind: 'notify', lines: [
        { en: 'claude-code used 62.4k tokens this turn', zh: 'claude-code 本轮用了 62.4k tokens' },
        { en: 'auto-compacted · tap to review', zh: '已自动压缩 · 点此查看' }
      ]}
    },

    /* ══ Library ══ */
    {
      key: 'prompts',
      ui: 'list',
      steps: [{ zh: '按 ⌘⇧P', en: 'Press ⌘⇧P' }, { zh: '挑一个模板', en: 'Pick a template' }, { zh: '它落在你的光标处', en: 'It lands at your cursor' }],
      gain: { zh: '386 → 214 tok · 直接可用', en: '386 → 214 tok, ready to send' }, group: 'Library', icon: '❐',
      name: { en: 'Prompts', zh: '提示词库' },
      what: {
        en: 'Your reusable prompts, already squeezed. Each one shows what it costs before and after Terse compresses it.',
        zh: '你的常用提示词，而且已经压过。每条都标着 Terse 压缩前后各花多少。'
      },
      how: {
        en: 'Press ⌘⇧P anywhere, pick a template, and it lands at your cursor.',
        zh: '在任何地方按 ⌘⇧P，选一个模板，它会落在你的光标处。'
      },
      effect: {
        en: 'It is typed into whatever editor has focus — VS Code, a browser textarea, your terminal — already in its compressed form.',
        zh: '它会被写进当前获得焦点的编辑器 —— VS Code、浏览器文本框、终端 —— 而且已经是压缩后的形态。'
      },
      demo: { kind: 'terminal', lines: [
        { en: 'VS Code · review.md', zh: 'VS Code · review.md' },
        { en: '+ Review this diff: correctness, edges, regressions', zh: '+ 审查这段 diff：正确性、边界、回归' },
        { en: '✓ expanded 386 tok → 214 after squeeze', zh: '✓ 展开 386 tok → 压缩后 214' }
      ]}
    },
    {
      key: 'graph',
      ui: 'graph',
      steps: [{ zh: '指向一个仓库', en: 'Point it at a repo' }, { zh: '点「重建」', en: 'Press Rebuild' }, { zh: '搜任意符号看调用关系', en: 'Search a symbol for its edges' }],
      gain: { zh: '读懂仓库：212k → 8.4k', en: 'Understand the repo: 212k → 8.4k' }, group: 'Library', icon: '⊹',
      name: { en: 'Knowledge Graph', zh: '知识图谱' },
      what: {
        en: 'A map of your codebase — every symbol, every call edge — built natively with tree-sitter. Agents read the digest instead of grepping whole files.',
        zh: '你代码库的地图 —— 每个符号、每条调用关系 —— 用 tree-sitter 原生构建。agent 读这份 digest，而不是 grep 整个仓库。'
      },
      how: {
        en: 'Point it at a repo and press Rebuild. Search any symbol to see what calls it and what it calls.',
        zh: '指向一个仓库然后点「重建」。搜任意符号，就能看到谁调用它、它调用谁。'
      },
      effect: {
        en: 'A compact Code digest lands in the repo. Your agent reads 8.4k instead of 212k to get the same understanding.',
        zh: '仓库里会生成一份紧凑的 Code digest。agent 读 8.4k 就能得到原来要 212k 才有的理解。'
      },
      demo: { kind: 'file', lines: [
        { en: 'Code digest', zh: 'Code digest' },
        { en: '+ 1,284 symbols · 3,916 call edges', zh: '+ 1,284 个符号 · 3,916 条调用关系' },
        { en: '✓ 212k → 8.4k tokens to understand the repo', zh: '✓ 读懂这个仓库：212k → 8.4k tokens' }
      ]}
    },
    {
      key: 'history',
      ui: 'historypage',
      steps: [{ zh: '按日期或项目找', en: 'Find by date or project' }, { zh: '点「恢复」', en: 'Press Restore' }, { zh: '接着上次继续', en: 'Pick up where you left off' }],
      gain: { zh: '182k 上下文原样回来', en: '182k of context, intact' }, group: 'Library', icon: '↺',
      name: { en: 'History', zh: '历史' },
      what: {
        en: 'Every session Terse has watched, kept whole. Not a transcript — the actual context, with its anchors.',
        zh: 'Terse 看过的每一次会话，完整保留。不是聊天记录，是真正的上下文连同它的锚点。'
      },
      how: {
        en: 'Find a session by date or project and press Restore.',
        zh: '按日期或项目找到某次会话，点「恢复」。'
      },
      effect: {
        en: 'The agent picks up exactly where it left off — you do not re-explain the task, and you do not pay for that context twice.',
        zh: 'agent 会从上次停下的地方继续 —— 你不用把任务重讲一遍，也不用为同一段上下文付第二次钱。'
      },
      demo: { kind: 'claude', lines: [
        { en: 'session 2026-08-09 · claude-code', zh: 'session 2026-08-09 · claude-code' },
        { en: '+ restored 182k ctx · 12 anchors', zh: '+ 恢复 182k 上下文 · 12 个锚点' },
        { en: '✓ pick up where you left off', zh: '✓ 接着上次继续' }
      ]}
    },
    {
      key: 'team',
      ui: 'team',
      steps: [{ zh: '邀请同事', en: 'Invite a teammate' }, { zh: '把会话拖进收件箱', en: 'Drag a session to the inbox' }, { zh: '对方收到完整上下文', en: 'They get the whole context' }],
      gain: { zh: '团队今日共省 18,412 tok', en: 'Team saved 18,412 tok today' }, group: 'Library', icon: '⚇', pro: true,
      name: { en: 'Team', zh: '协作' },
      what: {
        en: 'Your agents and your teammates\' agents in one room. Shared savings, shared cache, and sessions you can hand off mid-task.',
        zh: '你的 agent 和同事的 agent 在同一个房间里。共享节省、共享缓存，任务进行到一半也能交接会话。'
      },
      how: {
        en: 'Invite a teammate, then drag a session into the inbox to hand it over.',
        zh: '邀请同事，然后把某个会话拖进收件箱就完成交接。'
      },
      effect: {
        en: 'They receive the whole context, not a summary. The cache prefix is already warm on their side, so the first turn is cheap.',
        zh: '他们收到的是完整上下文，不是摘要。缓存前缀在他们那边已经是热的，所以第一轮就很便宜。'
      },
      demo: { kind: 'terminal', lines: [
        { en: '→ handoff: refactor-auth → Leo', zh: '→ 交接：refactor-auth → Leo' },
        { en: '+ 88k ctx transferred · nothing re-sent', zh: '+ 转移 88k 上下文 · 无一重发' },
        { en: '✓ team saved 18,412 tok today', zh: '✓ 团队今日共省 18,412 tok' }
      ]}
    },
    {
      key: 'farm',
      ui: 'farm',
      steps: [{ zh: '用省下的 token 浇水', en: 'Spend saved tokens on water' }, { zh: '施肥加速', en: 'Fertilise to speed it up' }, { zh: '成熟了收割', en: 'Harvest when ripe' }],
      gain: { zh: '省下来的，拿去种点什么', en: 'Spend what you saved on something fun' }, group: 'Library', icon: '🌾',
      name: { en: 'Farm', zh: '农场' },
      what: {
        en: 'What to do with what you saved. Tokens you did not spend become currency in a small farm — 9 plots, 10 crops.',
        zh: '省下来的那些拿去做点什么。没花掉的 token 会变成一个小农场里的货币 —— 9 块地、10 种作物。'
      },
      how: {
        en: 'Spend saved tokens on watering and fertiliser; harvest when a crop matures.',
        zh: '用省下的 token 浇水施肥，作物成熟了就收。'
      },
      effect: {
        en: 'Purely for fun — it spends the counter, never real money, and never touches your agents.',
        zh: '纯粹好玩 —— 花的是那个计数器，不是真钱，也完全不碰你的 agent。'
      },
      demo: { kind: 'desktop', lines: [
        { en: '− 1,200 saved tokens', zh: '− 1,200 已省 tokens' },
        { en: '+ wheat Lv.2 → Lv.3', zh: '+ 小麦 Lv.2 → Lv.3' }
      ]}
    },
    {
      key: 'boost',
      ui: 'toggle',
      steps: [{ zh: '打开加速', en: 'Flip Speed Up on' }, { zh: '流量走 Terse 加速', en: 'Traffic routes through Terse' }, { zh: '岛上加速角标变绿', en: 'The boost badge turns green' }],
      gain: { zh: '首字延迟 −54% · 流式 2.1×', en: 'TTFB −54% · stream 2.1×' }, group: 'Library', icon: '⚡', pro: true,
      name: { en: 'Speed Up', zh: '加速' },
      what: {
        en: 'Shorter prompts come back faster. Routed through Terse, streaming starts sooner and finishes sooner.',
        zh: '更短的 prompt 回得更快。经 Terse 之后，流式开始得更早、结束得更早。'
      },
      how: {
        en: 'Flip it on. The boost badge in the island turns green when traffic is routed.',
        zh: '打开开关。生效之后，灵动岛上的加速角标会变绿。'
      },
      effect: {
        en: 'Time-to-first-token drops because the payload is smaller. Same model, same answer, less waiting.',
        zh: '首字延迟下降，因为负载更小了。同一个模型、同样的答案，少等一会儿。'
      },
      demo: { kind: 'terminal', lines: [
        { en: '$ terse boost on', zh: '$ terse boost on' },
        { en: 'payload 1,284 → 796 tok', zh: '负载 1,284 → 796 tok' },
        { en: '✓ TTFB −54% · stream 2.1×', zh: '✓ 首字延迟 −54% · 流式 2.1×' }
      ]}
    },
    {
      key: 'wallpaper',
      ui: 'wall',
      steps: [{ zh: '选一个引擎', en: 'Choose an engine' }, { zh: '打开「设为桌面壁纸」', en: 'Turn on Set as desktop wallpaper' }, { zh: '桌面开始随 token 律动', en: 'Your desktop starts pulsing' }],
      gain: { zh: '桌面本身变成仪表盘', en: 'Your desktop becomes the dashboard' }, group: 'Library', icon: '▧',
      name: { en: 'Live Wallpaper', zh: '动态壁纸' },
      what: {
        en: 'Your own desktop picture, alive: particles take their colour from it and pulse with every token your agents burn.',
        zh: '把你自己的桌面壁纸变活：粒子按它取色，随着 agent 每一次消耗 token 律动。'
      },
      how: {
        en: 'Choose an engine, then turn on "Set as desktop wallpaper".',
        zh: '选一个引擎，然后打开「设为桌面壁纸」。'
      },
      effect: {
        en: 'It pins below your desktop icons, stays click-through, and follows you across every Space. Your desktop becomes the dashboard.',
        zh: '它会钉在桌面图标之下、保持点击穿透、跟着你在所有 Spaces 之间走。桌面本身就成了仪表盘。'
      },
      demo: { kind: 'desktop', lines: [
        { en: '+ pinned below the desktop icons', zh: '+ 已钉在桌面图标之下' },
        { en: '+ click-through · follows every Space', zh: '+ 点击穿透 · 跟随所有 Spaces' },
        { en: '✓ every token ripples across it', zh: '✓ 每一笔 token 都在上面翻涌' }
      ]}
    },
    {
      key: 'pals',
      ui: 'pal',
      steps: [{ zh: '挑一只伙伴', en: 'Pick a pal' }, { zh: '放到桌面上', en: 'Drop it on the desktop' }, { zh: '省得越多解锁越多', en: 'Save more to unlock more' }],
      gain: { zh: '它会跟着你的 agent 变表情', en: 'It reacts to your agents' }, group: 'Library', icon: '🐾',
      name: { en: 'Pals', zh: '伙伴' },
      what: {
        en: 'A small companion that lives on your desktop and reacts to what your agents are doing.',
        zh: '一只住在你桌面上的小伙伴，会对 agent 的动静做出反应。'
      },
      how: {
        en: 'Pick a pal and drop it onto the desktop. Skins and animations unlock as you save.',
        zh: '挑一只放到桌面上。省得越多，解锁的皮肤和动作越多。'
      },
      effect: {
        en: 'It sits above the wallpaper, below your windows, and never steals focus.',
        zh: '它位于壁纸之上、窗口之下，永远不会抢焦点。'
      },
      demo: { kind: 'desktop', lines: [
        { en: '+ on-desktop · reacts to agent activity', zh: '+ 常驻桌面 · 随 agent 活动变表情' },
        { en: '+ grows as you save tokens', zh: '+ 省下 token 就会长大' }
      ]}
    },
    {
      key: 'settings',
      ui: 'toggle',
      steps: [{ zh: '改任意一项', en: 'Change anything' }, { zh: '改完即存', en: 'It saves as you go' }, { zh: '下次开机就是这样', en: 'Next boot behaves the same' }],
      gain: { zh: '开机自动接管，不用每次手动', en: 'Attaches on launch, every time' }, group: 'Library', icon: '⚙',
      name: { en: 'Settings', zh: '设置' },
      what: {
        en: 'Launch behaviour, default compression mode, permission handling, language, and where Terse keeps its data.',
        zh: '启动行为、默认压缩档位、权限处理方式、语言，以及 Terse 把数据放在哪。'
      },
      how: {
        en: 'Change anything; it saves as you go. "Attach on launch" is the one most people want on.',
        zh: '随便改，改完即存。「开机自动接管」是大多数人会打开的那一项。'
      },
      effect: {
        en: 'Written to Terse settings immediately, so the next boot already behaves the way you left it.',
        zh: '立刻写进 Terse settings，所以下次开机就已经是你设好的样子。'
      },
      demo: { kind: 'config', lines: [
        { en: 'Terse settings', zh: 'Terse settings' },
        { en: '+ "attachOnLaunch": true', zh: '+ "attachOnLaunch": true' },
        { en: '+ "autoOptimize": "normal"', zh: '+ "autoOptimize": "normal"' }
      ]}
    }
  ];

  /* 灵动岛不在侧边栏里,但它是用得最多的界面 —— 单独一条,指南里也要能点到 */
  G.ISLAND = {
    key: 'island',
      ui: 'perm',
      steps: [{ zh: '悬停展开仪表盘', en: 'Hover to expand' }, { zh: '权限卡上做选择', en: 'Answer the permission card' }, { zh: '设成「始终」就不再问', en: 'Set Always to stop being asked' }],
      gain: { zh: '看清再放行 · 之后秒回', en: 'See it, then allow — later instant' }, group: 'Island', icon: '◍',
    name: { en: 'Dynamic Island', zh: '灵动岛' },
    what: {
      en: 'A pill that floats above everything. It shows live token flow, and when an agent wants to touch something sensitive it stops and asks you — showing what and why, not a blind "Allow?".',
      zh: '一颗浮在所有窗口之上的药丸。它显示实时 token 流；agent 要动敏感东西时它会拦下来问你 —— 告诉你动什么、为什么，而不是一句干巴巴的「允许？」。'
    },
    how: {
      en: 'Hover for dashboards. On a permission card: Allow once, Always allow, or Deny. Set auto-approve to Always to stop being asked at all.',
      zh: '悬停展开仪表盘。权限卡上有三个选择：仅此一次、始终允许、拒绝。把自动授权设成「始终」就再也不会被问。'
    },
    effect: {
      en: 'Choosing "Always allow" writes a rule — next time that call is answered instantly and the card never appears, so the agent never waits.',
      zh: '选「始终允许」会写下一条规则 —— 下次同类调用秒回，卡片根本不出现，agent 不用干等。'
    },
    demo: { kind: 'claude', lines: [
      { en: 'PERMISSION · Bash · ~/Desktop/Terse', zh: '权限请求 · Bash · ~/Desktop/Terse' },
      { en: 'rm -rf build/ && npm test', zh: 'rm -rf build/ && npm test' },
      { en: '✓ always-allowed · card never appears again', zh: '✓ 已记住 · 卡片不再出现' }
    ]}
  };

  G.GROUPS = ['Monitor', 'Optimize', 'Secure', 'Library'];
  G.GROUP_NAME = {
    Monitor:  { en: 'Monitor',  zh: '监控' },
    Optimize: { en: 'Optimize', zh: '优化' },
    Secure:   { en: 'Secure',   zh: '安全' },
    Library:  { en: 'Library',  zh: '工具箱' }
  };

  window.TERSE_GUIDE = G;
})();
