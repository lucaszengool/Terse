// ── Doctor dynamic-finding localization ──────────────────────────────────────
// The Rust scanner (src-tauri/src/doctor.rs) emits every Finding's title,
// detail, latencyNote, categoryLabel and fixLabel in English, with numbers,
// model names, file names and server lists interpolated in. Those strings are
// generated at scan time, so the static DOM-walk in i18n.js can't reach them.
//
// This module localizes them at render time, keyed off the app language
// (window.i18n.getLang()). Two layers:
//   • EXACT  — constant strings (category labels, fix labels, latency notes,
//              the non-interpolated titles & details) looked up verbatim.
//   • PATTERNS — interpolated strings matched by regex; the captured pieces
//              (model name, %, token count, file, server list) are spliced
//              back into the translated template untouched, so "$508" / model
//              ids / paths stay correct in any language.
// Unknown strings fall through to English, so a new finding never renders blank.
(function () {
  'use strict';

  const EXACT = {
    'zh-Hans': {
      // category labels
      'Cache Health': '缓存健康',
      'Tool / MCP Bloat': '工具 / MCP 膨胀',
      'Agent Loops': '智能体循环',
      'Context Bloat': '上下文膨胀',
      'Prompt Waste': '提示词浪费',
      'Cost / Routing': '成本 / 路由',
      'Best Practice': '最佳实践',
      'Junk Files': '垃圾文件',
      'Agent Disk': '智能体磁盘',
      'Protection': '安全防护',
      'Agent Runtime': '运行加速',
      'Review': '查看详情',
      'Open file': '打开文件',
      'Open files': '打开文件',
      'Open config': '打开配置',
      'Turn off bypass': '关闭跳过确认',
      'Remove rules': '移除规则',
      'Stop process': '停止进程',
      'Stop sessions': '停止会话',
      'Auto-clean 30d': '开启30天自动清理',
      'Activity Monitor': '活动监视器',
      // fix labels
      'Clean': '清理',
      'Compress results': '压缩结果',
      'Enable cache-safe mode': '启用缓存安全模式',
      'Enable result cache': '启用结果缓存',
      'Enable': '启用',
      'How to fix': '如何修复',
      // One-click fix labels (promote_all_fixable in doctor.rs)
      'Enable cache-safe mode': '开启缓存安全模式',
      'Keep cache warm': '保持缓存热度',
      'Stabilise prefix': '稳定前缀',
      'Disable unused servers': '禁用闲置服务',
      'Trim CLAUDE.md': '精简 CLAUDE.md',
      'Auto-compact': '自动压缩上下文',
      'Compress results': '压缩工具结果',
      'Route cheap turns': '廉价模型分流',
      'Cap output': '限制输出长度',
      'Freeze tool order': '固定工具顺序',
      'Prewarm cache': '预热缓存',
      'Open config': '打开配置',
      // metric suffix
      '/mo': '/月',
      // constant titles
      'Bursty usage is letting the cache expire between requests': '突发式使用让缓存在请求之间过期',
      'Re-read the same file multiple times': '多次重复读取同一文件',
      'Turn on cache-safe optimization': '开启缓存安全优化',
      'Pin a stable tool / JSON ordering': '固定稳定的工具 / JSON 排序',
      'Pre-warm and keep your cache warm': '预热并保持缓存热度',
      'Set max_tokens and stop sequences': '设置 max_tokens 与停止序列',
      // latency notes
      '0% hit rate = full prefill every turn (~67% slower TTFT on long prompts).': '0% 命中率 = 每轮都要完整预填充（长提示下 TTFT 慢约 67%）。',
      'A single bloated server can dominate prefill on every turn.': '单个臃肿的服务器会在每一轮主导预填充。',
      'A warm cache yields up to ~80% TTFT reduction.': '热缓存最多可减少约 80% 的 TTFT。',
      'Avoids re-fetch round-trips as well as tokens.': '既省去重复获取的往返，也节省 token。',
      'Cache misses pay full prefill — up to ~67% slower time-to-first-token on long prompts.': '缓存未命中要支付完整预填充——长提示下首字延迟最多慢约 67%。',
      'Caps worst-case decode time.': '限制最坏情况下的解码时间。',
      'Context grows cost quadratically and slows decode.': '上下文使成本呈平方增长并拖慢解码。',
      'Dead schemas inflate prefill on every single turn.': '无用的 schema 会在每一轮膨胀预填充。',
      'Each avoided round-trip saves ~1-5s of wall-clock.': '每避免一次往返可节省约 1-5 秒的实际耗时。',
      'Each cache expiry re-pays the full prefill.': '每次缓存过期都要重新支付完整预填充。',
      'Every cache re-write re-pays the full prefill.': '每次重写缓存都要重新支付完整预填充。',
      'Keeps the prefix byte-stable, protecting your cache hit rate.': '保持前缀逐字节稳定，保护你的缓存命中率。',
      'Less output also means faster decode.': '更少的输出也意味着更快的解码。',
      'No prefill reuse — full time-to-first-token on every turn.': '无法复用预填充——每一轮都是完整的首字延迟。',
      'Oversized results dominate context and break prompt caching.': '过大的结果会主导上下文并破坏提示缓存。',
      'Small models are also faster.': '小模型也更快。',
      'Smaller tool set = less prefill on every turn; tool-search can cut ~85% of tool tokens.': '更小的工具集 = 每轮更少的预填充；工具检索可削减约 85% 的工具 token。',
      'Stable ordering preserves the full cached prefix.': '稳定的排序可保全完整的已缓存前缀。',
      'Token trimming is a cost lever — it lowers spend without touching cache.': '精简 token 是成本杠杆——在不动缓存的情况下降低开销。',
      'Trimming lowers spend without touching cache.': '精简可在不动缓存的情况下降低开销。',
      'Unbounded loops compound cost every iteration.': '无上限的循环会在每次迭代中复合成本。',
      'Unused tool schemas inflate prefill on every turn.': '未使用的工具 schema 会在每一轮膨胀预填充。',
      // constant details
      'Cache thrashing: cache writes (billed at ~1.25x input) exceed cache reads (~0.1x), so caching is costing MORE than it saves. The prefix is changing every turn (reordered tools, an injected timestamp, history rewrite) or the 5-minute TTL is expiring on idle gaps and forcing re-writes. Pin a byte-stable prefix and consider the 1-hour TTL.':
        '缓存抖动：缓存写入（约按输入的 1.25 倍计费）超过了缓存读取（约 0.1 倍），因此缓存的花费比它节省的更多。前缀每轮都在变化（工具被重排、注入了时间戳、历史被重写），或者 5 分钟的 TTL 在空闲间隙过期而被迫重写。请固定一个逐字节稳定的前缀，并考虑使用 1 小时 TTL。',
      'Caching is completely off for this model — no cache reads and no cache writes. Either the prefix is below the minimum cacheable floor (1024 tokens for Sonnet/Opus-class, more for Haiku) or cache_control is simply not set on the static prefix. This is the single biggest recoverable line item: ~90% off the static portion once enabled.':
        '该模型完全没有启用缓存——既无缓存读取也无缓存写入。要么前缀低于最小可缓存下限（Sonnet/Opus 级为 1024 token，Haiku 更高），要么只是没有在静态前缀上设置 cache_control。这是最大的可回收项：一旦启用，静态部分可省约 90%。',
      'Low hit rate together with meaningful cache writes is the classic signature of the default 5-minute cache window evicting on idle gaps, forcing re-writes. Switch the breakpoint to the 1-hour TTL ({"type":"ephemeral","ttl":"1h"}) or send a cheap keepalive so the prefix stays warm between bursts.':
        '命中率低却伴随可观的缓存写入，是默认 5 分钟缓存窗口在空闲间隙被清除、被迫重写的典型特征。把断点切换到 1 小时 TTL（{"type":"ephemeral","ttl":"1h"}），或发送廉价的保活请求，让前缀在突发之间保持热度。',
      'This connected session is reading almost nothing from cache after several turns — a dynamic value (timestamp, UUID, request-id, \'Current date/time\') is sitting inside the cacheable prefix, or the tools are reordered each turn. This is the single most common cache failure mode. Move all volatile content after the cache breakpoint.':
        '这个已连接的会话在多轮之后几乎没有从缓存读取——某个动态值（时间戳、UUID、request-id、“当前日期/时间”）位于可缓存前缀内部，或者工具每轮都被重排。这是最常见的缓存失效模式。请把所有易变内容移到缓存断点之后。',
      'The agent re-ran the same (tool, args) more than once in this session. Each duplicate is a wasted LLM round-trip plus re-fetched result tokens. Enable Terse\'s local result cache to block exact repeats, or add a debounce hook.':
        '在本次会话中，智能体不止一次地重复运行了相同的（工具，参数）。每次重复都是一次浪费的 LLM 往返，外加重复获取的结果 token。启用 Terse 的本地结果缓存以拦截完全相同的重复调用，或添加防抖钩子。',
      'The agent re-read unchanged files across non-adjacent steps. Read-type ops are ~76% of agent tokens, so a result cache keyed on the target id recovers the bulk of that. Enable Terse\'s local result cache.':
        '智能体在非相邻的步骤中重复读取了未改动的文件。读取类操作约占智能体 token 的 76%，因此以目标 id 为键的结果缓存可回收其中大部分。请启用 Terse 的本地结果缓存。',
      'Verbose bash/test/build/log output is 60-90% compressible and large raw results also break downstream caching. Truncate or structure tool results before they enter the context. Turn on Terse compression on the result path.':
        '冗长的 bash/测试/构建/日志输出有 60-90% 可压缩，过大的原始结果还会破坏下游缓存。在工具结果进入上下文之前先截断或结构化它们。请在结果路径上开启 Terse 压缩。',
      'Past ~70% the running context drives cost up quadratically, raises latency, and increases hallucination and lossy auto-summarization. Prune stale tool outputs via observation masking rather than an LLM summary — truncating a bloated history can cut late-turn input ~90%.':
        '超过约 70% 后，运行中的上下文会使成本呈平方上升、提高延迟，并加剧幻觉与有损的自动摘要。请通过观测遮蔽（observation masking）而非 LLM 摘要来裁剪陈旧的工具输出——截断臃肿的历史可将后期轮次的输入削减约 90%。',
      'A very high sustained burn rate on a long session signals runaway context accumulation or retry churn. Set step/token/wall-clock budget caps and a circuit breaker so an unbounded loop can\'t compound.':
        '在长会话中持续极高的消耗速率，表明上下文在失控累积或重试在反复抖动。请设置步数/token/实际耗时的预算上限和熔断器，让无上限的循环无法不断复合。',
      'Well-optimized prompts cut 40-70% of input; your overall savings rate is far below that, meaning most volume bypasses Terse entirely. Turn on auto-optimize for all sources so every request gets trimmed, not just a handful.':
        '优化良好的提示词可削减 40-70% 的输入；你的整体节省率远低于此，意味着大部分用量完全绕过了 Terse。请为所有来源开启自动优化，让每个请求都被精简，而不只是少数几个。',
      'A premium model is handling the majority of your cost while cheaper tiers exist. Frontier vs small models are ~60x on input price — add a routing layer that sends summarization, extraction, and simple Q&A to a Haiku/mini tier. Routing ~70% of volume to a small model cuts the input bill roughly two-thirds.':
        '在有更便宜档位可用的情况下，一个高端模型却承担了你的大部分成本。前沿模型与小模型在输入价格上相差约 60 倍——增加一个路由层，把摘要、抽取和简单问答发往 Haiku/mini 档位。把约 70% 的用量路由到小模型，可将输入账单削减约三分之二。',
      'Output bills 3-10x input per token, and this model is generating more output than it reads on work that isn\'t pure generation. Constrain it with max_tokens, length limits, or \'answer in N words\' — a 60% output cut is a direct 60% cut on the dominant line.':
        '输出每 token 的计费是输入的 3-10 倍，而该模型在并非纯生成的任务上产出的输出比读取的还多。用 max_tokens、长度限制或“用 N 字作答”来约束它——削减 60% 输出就是在主导项上直接削减 60%。',
      'Cache-safe mode makes Terse only ever rewrite your newest turn — never mutating cached history — so optimization can never cost you a cache hit. One click enables it.':
        '缓存安全模式让 Terse 只重写你最新的一轮——绝不改动已缓存的历史——因此优化永远不会让你损失一次缓存命中。一键即可启用。',
      'Serialize tool definitions in deterministic (name-sorted) order with pinned JSON key ordering, and treat the tool block as append-only. Tools sit at cache position 0, so any reorder cold-reprocesses the entire prefix at full price.':
        '以确定的（按名称排序）顺序序列化工具定义，固定 JSON 键的排序，并把工具块视为仅追加。工具位于缓存的 0 号位置，任何重排都会以全价冷重处理整个前缀。',
      'For bursty or long-running agents, consolidate stable instructions + tools + few-shot into one prefix above the model\'s min-cacheable floor, set the cache_control breakpoint on the last byte-identical block, and use the 1h TTL (or a cheap keepalive) so idle gaps don\'t evict it.':
        '对于突发式或长时间运行的智能体，把稳定的指令 + 工具 + few-shot 合并为一个超过模型最小可缓存下限的前缀，在最后一个逐字节相同的块上设置 cache_control 断点，并使用 1 小时 TTL（或廉价的保活），让空闲间隙不会将其清除。',
      'Cap max_tokens to ~1.3x your observed P95 output and add stop sequences for structured outputs. This bounds runaway-generation blast radius and removes the truncation→retry multiplier.':
        '把 max_tokens 限制到你观测到的 P95 输出的约 1.3 倍，并为结构化输出添加停止序列。这能限制失控生成的影响范围，并消除截断→重试的倍增。',
      'Old logs, temp, and backup files Terse left behind. Safe to delete — this never touches your stats, auth, or project files.':
        'Terse 残留的旧日志、临时和备份文件。可安全删除——这绝不会触及你的统计、登录或项目文件。',
    },

    'zh-Hant': {
      // category labels
      'Cache Health': '緩存健康',
      'Tool / MCP Bloat': '工具 / MCP 膨脹',
      'Agent Loops': '智能體循環',
      'Context Bloat': '上下文膨脹',
      'Prompt Waste': '提示詞浪費',
      'Cost / Routing': '成本 / 路由',
      'Best Practice': '最佳實踐',
      'Junk Files': '垃圾檔案',
      'Agent Disk': '智能體磁碟',
      'Protection': '安全防護',
      'Agent Runtime': '運行加速',
      'Review': '查看詳情',
      'Open file': '打開檔案',
      'Open files': '打開檔案',
      'Open config': '打開配置',
      'Turn off bypass': '關閉跳過確認',
      'Remove rules': '移除規則',
      'Stop process': '停止進程',
      'Stop sessions': '停止會話',
      'Auto-clean 30d': '開啟30天自動清理',
      'Activity Monitor': '活動監視器',
      // fix labels
      'Clean': '清理',
      'Compress results': '壓縮結果',
      'Enable cache-safe mode': '啟用緩存安全模式',
      'Enable result cache': '啟用結果緩存',
      'Enable': '啟用',
      'How to fix': '如何修復',
      // One-click fix labels (promote_all_fixable in doctor.rs)
      'Enable cache-safe mode': '開啟快取安全模式',
      'Keep cache warm': '保持快取熱度',
      'Stabilise prefix': '穩定前綴',
      'Disable unused servers': '停用閒置服務',
      'Trim CLAUDE.md': '精簡 CLAUDE.md',
      'Auto-compact': '自動壓縮上下文',
      'Compress results': '壓縮工具結果',
      'Route cheap turns': '廉價模型分流',
      'Cap output': '限制輸出長度',
      'Freeze tool order': '固定工具順序',
      'Prewarm cache': '預熱快取',
      'Open config': '開啟設定',
      // metric suffix
      '/mo': '/月',
      // constant titles
      'Bursty usage is letting the cache expire between requests': '突發式使用讓緩存在請求之間過期',
      'Re-read the same file multiple times': '多次重複讀取同一檔案',
      'Turn on cache-safe optimization': '開啟緩存安全優化',
      'Pin a stable tool / JSON ordering': '固定穩定的工具 / JSON 排序',
      'Pre-warm and keep your cache warm': '預熱並保持緩存熱度',
      'Set max_tokens and stop sequences': '設定 max_tokens 與停止序列',
      // latency notes
      '0% hit rate = full prefill every turn (~67% slower TTFT on long prompts).': '0% 命中率 = 每輪都要完整預填充（長提示下 TTFT 慢約 67%）。',
      'A single bloated server can dominate prefill on every turn.': '單個臃腫的伺服器會在每一輪主導預填充。',
      'A warm cache yields up to ~80% TTFT reduction.': '熱緩存最多可減少約 80% 的 TTFT。',
      'Avoids re-fetch round-trips as well as tokens.': '既省去重複獲取的往返，也節省 token。',
      'Cache misses pay full prefill — up to ~67% slower time-to-first-token on long prompts.': '緩存未命中要支付完整預填充——長提示下首字延遲最多慢約 67%。',
      'Caps worst-case decode time.': '限制最壞情況下的解碼時間。',
      'Context grows cost quadratically and slows decode.': '上下文使成本呈平方增長並拖慢解碼。',
      'Dead schemas inflate prefill on every single turn.': '無用的 schema 會在每一輪膨脹預填充。',
      'Each avoided round-trip saves ~1-5s of wall-clock.': '每避免一次往返可節省約 1-5 秒的實際耗時。',
      'Each cache expiry re-pays the full prefill.': '每次緩存過期都要重新支付完整預填充。',
      'Every cache re-write re-pays the full prefill.': '每次重寫緩存都要重新支付完整預填充。',
      'Keeps the prefix byte-stable, protecting your cache hit rate.': '保持前綴逐位元組穩定，保護你的緩存命中率。',
      'Less output also means faster decode.': '更少的輸出也意味著更快的解碼。',
      'No prefill reuse — full time-to-first-token on every turn.': '無法複用預填充——每一輪都是完整的首字延遲。',
      'Oversized results dominate context and break prompt caching.': '過大的結果會主導上下文並破壞提示緩存。',
      'Small models are also faster.': '小模型也更快。',
      'Smaller tool set = less prefill on every turn; tool-search can cut ~85% of tool tokens.': '更小的工具集 = 每輪更少的預填充；工具檢索可削減約 85% 的工具 token。',
      'Stable ordering preserves the full cached prefix.': '穩定的排序可保全完整的已緩存前綴。',
      'Token trimming is a cost lever — it lowers spend without touching cache.': '精簡 token 是成本槓桿——在不動緩存的情況下降低開銷。',
      'Trimming lowers spend without touching cache.': '精簡可在不動緩存的情況下降低開銷。',
      'Unbounded loops compound cost every iteration.': '無上限的循環會在每次迭代中複合成本。',
      'Unused tool schemas inflate prefill on every turn.': '未使用的工具 schema 會在每一輪膨脹預填充。',
      // constant details
      'Cache thrashing: cache writes (billed at ~1.25x input) exceed cache reads (~0.1x), so caching is costing MORE than it saves. The prefix is changing every turn (reordered tools, an injected timestamp, history rewrite) or the 5-minute TTL is expiring on idle gaps and forcing re-writes. Pin a byte-stable prefix and consider the 1-hour TTL.':
        '緩存抖動：緩存寫入（約按輸入的 1.25 倍計費）超過了緩存讀取（約 0.1 倍），因此緩存的花費比它節省的更多。前綴每輪都在變化（工具被重排、注入了時間戳、歷史被重寫），或者 5 分鐘的 TTL 在空閒間隙過期而被迫重寫。請固定一個逐位元組穩定的前綴，並考慮使用 1 小時 TTL。',
      'Caching is completely off for this model — no cache reads and no cache writes. Either the prefix is below the minimum cacheable floor (1024 tokens for Sonnet/Opus-class, more for Haiku) or cache_control is simply not set on the static prefix. This is the single biggest recoverable line item: ~90% off the static portion once enabled.':
        '該模型完全沒有啟用緩存——既無緩存讀取也無緩存寫入。要麼前綴低於最小可緩存下限（Sonnet/Opus 級為 1024 token，Haiku 更高），要麼只是沒有在靜態前綴上設定 cache_control。這是最大的可回收項：一旦啟用，靜態部分可省約 90%。',
      'Low hit rate together with meaningful cache writes is the classic signature of the default 5-minute cache window evicting on idle gaps, forcing re-writes. Switch the breakpoint to the 1-hour TTL ({"type":"ephemeral","ttl":"1h"}) or send a cheap keepalive so the prefix stays warm between bursts.':
        '命中率低卻伴隨可觀的緩存寫入，是預設 5 分鐘緩存窗口在空閒間隙被清除、被迫重寫的典型特徵。把斷點切換到 1 小時 TTL（{"type":"ephemeral","ttl":"1h"}），或發送廉價的保活請求，讓前綴在突發之間保持熱度。',
      'This connected session is reading almost nothing from cache after several turns — a dynamic value (timestamp, UUID, request-id, \'Current date/time\') is sitting inside the cacheable prefix, or the tools are reordered each turn. This is the single most common cache failure mode. Move all volatile content after the cache breakpoint.':
        '這個已連接的會話在多輪之後幾乎沒有從緩存讀取——某個動態值（時間戳、UUID、request-id、“當前日期/時間”）位於可緩存前綴內部，或者工具每輪都被重排。這是最常見的緩存失效模式。請把所有易變內容移到緩存斷點之後。',
      'The agent re-ran the same (tool, args) more than once in this session. Each duplicate is a wasted LLM round-trip plus re-fetched result tokens. Enable Terse\'s local result cache to block exact repeats, or add a debounce hook.':
        '在本次會話中，智能體不止一次地重複執行了相同的（工具，參數）。每次重複都是一次浪費的 LLM 往返，外加重複獲取的結果 token。啟用 Terse 的本地結果緩存以攔截完全相同的重複調用，或加入防抖鉤子。',
      'The agent re-read unchanged files across non-adjacent steps. Read-type ops are ~76% of agent tokens, so a result cache keyed on the target id recovers the bulk of that. Enable Terse\'s local result cache.':
        '智能體在非相鄰的步驟中重複讀取了未改動的檔案。讀取類操作約佔智能體 token 的 76%，因此以目標 id 為鍵的結果緩存可回收其中大部分。請啟用 Terse 的本地結果緩存。',
      'Verbose bash/test/build/log output is 60-90% compressible and large raw results also break downstream caching. Truncate or structure tool results before they enter the context. Turn on Terse compression on the result path.':
        '冗長的 bash/測試/建置/日誌輸出有 60-90% 可壓縮，過大的原始結果還會破壞下游緩存。在工具結果進入上下文之前先截斷或結構化它們。請在結果路徑上開啟 Terse 壓縮。',
      'Past ~70% the running context drives cost up quadratically, raises latency, and increases hallucination and lossy auto-summarization. Prune stale tool outputs via observation masking rather than an LLM summary — truncating a bloated history can cut late-turn input ~90%.':
        '超過約 70% 後，執行中的上下文會使成本呈平方上升、提高延遲，並加劇幻覺與有損的自動摘要。請透過觀測遮蔽（observation masking）而非 LLM 摘要來裁剪陳舊的工具輸出——截斷臃腫的歷史可將後期輪次的輸入削減約 90%。',
      'A very high sustained burn rate on a long session signals runaway context accumulation or retry churn. Set step/token/wall-clock budget caps and a circuit breaker so an unbounded loop can\'t compound.':
        '在長會話中持續極高的消耗速率，表明上下文在失控累積或重試在反覆抖動。請設定步數/token/實際耗時的預算上限和熔斷器，讓無上限的循環無法不斷複合。',
      'Well-optimized prompts cut 40-70% of input; your overall savings rate is far below that, meaning most volume bypasses Terse entirely. Turn on auto-optimize for all sources so every request gets trimmed, not just a handful.':
        '優化良好的提示詞可削減 40-70% 的輸入；你的整體節省率遠低於此，意味著大部分用量完全繞過了 Terse。請為所有來源開啟自動優化，讓每個請求都被精簡，而不只是少數幾個。',
      'A premium model is handling the majority of your cost while cheaper tiers exist. Frontier vs small models are ~60x on input price — add a routing layer that sends summarization, extraction, and simple Q&A to a Haiku/mini tier. Routing ~70% of volume to a small model cuts the input bill roughly two-thirds.':
        '在有更便宜檔位可用的情況下，一個高端模型卻承擔了你的大部分成本。前沿模型與小模型在輸入價格上相差約 60 倍——增加一個路由層，把摘要、抽取和簡單問答發往 Haiku/mini 檔位。把約 70% 的用量路由到小模型，可將輸入帳單削減約三分之二。',
      'Output bills 3-10x input per token, and this model is generating more output than it reads on work that isn\'t pure generation. Constrain it with max_tokens, length limits, or \'answer in N words\' — a 60% output cut is a direct 60% cut on the dominant line.':
        '輸出每 token 的計費是輸入的 3-10 倍，而該模型在並非純生成的任務上產出的輸出比讀取的還多。用 max_tokens、長度限制或“用 N 字作答”來約束它——削減 60% 輸出就是在主導項上直接削減 60%。',
      'Cache-safe mode makes Terse only ever rewrite your newest turn — never mutating cached history — so optimization can never cost you a cache hit. One click enables it.':
        '緩存安全模式讓 Terse 只重寫你最新的一輪——絕不改動已緩存的歷史——因此優化永遠不會讓你損失一次緩存命中。一鍵即可啟用。',
      'Serialize tool definitions in deterministic (name-sorted) order with pinned JSON key ordering, and treat the tool block as append-only. Tools sit at cache position 0, so any reorder cold-reprocesses the entire prefix at full price.':
        '以確定的（按名稱排序）順序序列化工具定義，固定 JSON 鍵的排序，並把工具塊視為僅追加。工具位於緩存的 0 號位置，任何重排都會以全價冷重處理整個前綴。',
      'For bursty or long-running agents, consolidate stable instructions + tools + few-shot into one prefix above the model\'s min-cacheable floor, set the cache_control breakpoint on the last byte-identical block, and use the 1h TTL (or a cheap keepalive) so idle gaps don\'t evict it.':
        '對於突發式或長時間執行的智能體，把穩定的指令 + 工具 + few-shot 合併為一個超過模型最小可緩存下限的前綴，在最後一個逐位元組相同的塊上設定 cache_control 斷點，並使用 1 小時 TTL（或廉價的保活），讓空閒間隙不會將其清除。',
      'Cap max_tokens to ~1.3x your observed P95 output and add stop sequences for structured outputs. This bounds runaway-generation blast radius and removes the truncation→retry multiplier.':
        '把 max_tokens 限制到你觀測到的 P95 輸出的約 1.3 倍，並為結構化輸出加入停止序列。這能限制失控生成的影響範圍，並消除截斷→重試的倍增。',
      'Old logs, temp, and backup files Terse left behind. Safe to delete — this never touches your stats, auth, or project files.':
        'Terse 殘留的舊日誌、暫存和備份檔案。可安全刪除——這絕不會觸及你的統計、登入或專案檔案。',
    },
  };

  // Interpolated strings. Each entry: a regex with capture groups, plus a
  // builder per language that splices the captures (model ids, numbers, file
  // names, server lists) back into the translated template verbatim.
  const PATTERNS = [
    // ── titles ──
    { re: /^(.+) cached only (\d+)% of its input$/,
      'zh-Hans': (m) => `${m[1]} 仅缓存了输入的 ${m[2]}%`,
      'zh-Hant': (m) => `${m[1]} 僅緩存了輸入的 ${m[2]}%` },
    { re: /^(.+) is re-writing the cache more than it reads it$/,
      'zh-Hans': (m) => `${m[1]} 重写缓存的次数多于读取`,
      'zh-Hant': (m) => `${m[1]} 重寫緩存的次數多於讀取` },
    { re: /^Prompt caching never engaged on (.+)$/,
      'zh-Hans': (m) => `${m[1]} 从未启用过提示缓存`,
      'zh-Hant': (m) => `${m[1]} 從未啟用過提示緩存` },
    { re: /^Live agent (.+) is running at (\d+)% cache efficiency$/,
      'zh-Hans': (m) => `实时智能体 ${m[1]} 的缓存效率仅为 ${m[2]}%`,
      'zh-Hant': (m) => `即時智能體 ${m[1]} 的緩存效率僅為 ${m[2]}%` },
    { re: /^(\d+) MCP servers loaded on every request$/,
      'zh-Hans': (m) => `每个请求都加载了 ${m[1]} 个 MCP 服务器`,
      'zh-Hant': (m) => `每個請求都載入了 ${m[1]} 個 MCP 伺服器` },
    { re: /^MCP server '(.+)' is connected but never called$/,
      'zh-Hans': (m) => `MCP 服务器 “${m[1]}” 已连接但从未被调用`,
      'zh-Hant': (m) => `MCP 伺服器 “${m[1]}” 已連接但從未被調用` },
    { re: /^MCP server (\d+) MCP servers connected but never called$/,
      'zh-Hans': (m) => `有 ${m[1]} 个 MCP 服务器已连接但从未被调用`,
      'zh-Hant': (m) => `有 ${m[1]} 個 MCP 伺服器已連接但從未被調用` },
    { re: /^'(.+)' dominates your tool prefix$/,
      'zh-Hans': (m) => `“${m[1]}” 主导了你的工具前缀`,
      'zh-Hant': (m) => `“${m[1]}” 主導了你的工具前綴` },
    { re: /^(\d+) loaded tools went unused this session$/,
      'zh-Hans': (m) => `本次会话有 ${m[1]} 个已加载工具未被使用`,
      'zh-Hant': (m) => `本次會話有 ${m[1]} 個已載入工具未被使用` },
    { re: /^(\d+) duplicate tool calls wasted (\d+) tokens$/,
      'zh-Hans': (m) => `${m[1]} 次重复工具调用浪费了 ${m[2]} 个 token`,
      'zh-Hant': (m) => `${m[1]} 次重複工具調用浪費了 ${m[2]} 個 token` },
    { re: /^Re-read (.+) (\d+) times$/,
      'zh-Hans': (m) => `重复读取了 ${m[1]} ${m[2]} 次`,
      'zh-Hant': (m) => `重複讀取了 ${m[1]} ${m[2]} 次` },
    { re: /^(\d+) tokens of tool output are compressible$/,
      'zh-Hans': (m) => `有 ${m[1]} 个 token 的工具输出可压缩`,
      'zh-Hant': (m) => `有 ${m[1]} 個 token 的工具輸出可壓縮` },
    { re: /^(.+) context is (\d+)% full$/,
      'zh-Hans': (m) => `${m[1]} 的上下文已占用 ${m[2]}%`,
      'zh-Hant': (m) => `${m[1]} 的上下文已佔用 ${m[2]}%` },
    { re: /^Burning (.+?) tokens\/min on (.+)$/,
      'zh-Hans': (m) => `${m[2]} 正在以每分钟 ${m[1]} 个 token 的速度消耗`,
      'zh-Hant': (m) => `${m[2]} 正在以每分鐘 ${m[1]} 個 token 的速度消耗` },
    { re: /^(\d+) messages sent without optimization$/,
      'zh-Hans': (m) => `有 ${m[1]} 条消息未经优化便已发送`,
      'zh-Hant': (m) => `有 ${m[1]} 條訊息未經優化便已發送` },
    { re: /^Only (\d+)% of your input tokens are being trimmed$/,
      'zh-Hans': (m) => `你的输入 token 只有 ${m[1]}% 被精简`,
      'zh-Hant': (m) => `你的輸入 token 只有 ${m[1]}% 被精簡` },
    { re: /^(\d+)% of spend is on premium (.+)$/,
      'zh-Hans': (m) => `${m[1]}% 的开销花在高端模型 ${m[2]} 上`,
      'zh-Hant': (m) => `${m[1]}% 的開銷花在高端模型 ${m[2]} 上` },
    { re: /^(.+) output tokens are dominating cost$/,
      'zh-Hans': (m) => `${m[1]} 的输出 token 正在主导成本`,
      'zh-Hant': (m) => `${m[1]} 的輸出 token 正在主導成本` },
    { re: /^(\d+) disposable files in ~\/\.terse \((.+)\)$/,
      'zh-Hans': (m) => `~/.terse 中有 ${m[1]} 个可丢弃文件（${m[2]}）`,
      'zh-Hant': (m) => `~/.terse 中有 ${m[1]} 個可丟棄檔案（${m[2]}）` },

    // ── interpolated details ──
    { re: /^A well-structured agent prefix caches.+?this model is at (\d+)%\./,
      'zh-Hans': (m) => `结构良好的智能体前缀能缓存 75% 以上的输入；该模型仅为 ${m[1]}%。可缓存前缀（系统提示、工具列表或先前的轮次）在请求之间发生了变化——时间戳、被重排的工具，或某个会重写历史的工具。请保持前缀逐字节相同，让只有最新一轮变化，并在最后一个静态块上设置 cache_control。`,
      'zh-Hant': (m) => `結構良好的智能體前綴能緩存 75% 以上的輸入；該模型僅為 ${m[1]}%。可緩存前綴（系統提示、工具列表或先前的輪次）在請求之間發生了變化——時間戳、被重排的工具，或某個會重寫歷史的工具。請保持前綴逐位元組相同，讓只有最新一輪變化，並在最後一個靜態塊上設定 cache_control。` },
    { re: /^Each MCP server injects.+?\(fewest calls\): (.+?)\. Trimming the long tail/,
      'zh-Hans': (m) => `每个 MCP 服务器都会把它的工具定义注入到每个请求的前缀中——单是一个 GitHub 级的服务器就可能有 17-55K token。最划算（调用最少）可禁用或延迟加载的是：${m[1]}。精简长尾会缩小每个请求并加快预填充。`,
      'zh-Hant': (m) => `每個 MCP 伺服器都會把它的工具定義注入到每個請求的前綴中——單是一個 GitHub 級的伺服器就可能有 17-55K token。最划算（調用最少）可停用或延遲載入的是：${m[1]}。精簡長尾會縮小每個請求並加快預填充。` },
    { re: /^These MCP servers loaded their schemas into every turn but were never invoked: (.+?)\. That is pure prefill/,
      'zh-Hans': (m) => `这些 MCP 服务器把它们的 schema 加载到每一轮，却从未被调用：${m[1]}。这是纯粹的预填充浪费，约 200-550 token/工具。断开它们（从配置中删除）或设置 defer_loading:true——每一轮都可回收，且零能力损失。`,
      'zh-Hant': (m) => `這些 MCP 伺服器把它們的 schema 載入到每一輪，卻從未被調用：${m[1]}。這是純粹的預填充浪費，約 200-550 token/工具。斷開它們（從配置中刪除）或設定 defer_loading:true——每一輪都可回收，且零能力損失。` },
    { re: /^'(.+?)' contributes a disproportionate share/,
      'zh-Hans': (m) => `“${m[1]}” 在你的工具输入 token 中占据了不成比例的份额——GitHub 级的服务器携带约 93 个工具 / 17-55K token。只启用你实际使用的工具集，或把它放到工具检索之后，让其 schema 按需加载。`,
      'zh-Hant': (m) => `“${m[1]}” 在你的工具輸入 token 中佔據了不成比例的份額——GitHub 級的伺服器攜帶約 93 個工具 / 17-55K token。只啟用你實際使用的工具集，或把它放到工具檢索之後，讓其 schema 按需載入。` },
    { re: /^(\d+) default\/loaded tools were never invoked across (\d+) turns/,
      'zh-Hans': (m) => `有 ${m[1]} 个默认/已加载的工具在 ${m[2]} 轮中从未被调用，但每个工具每轮都要支付约 300 token 的预填充。请精简工具集，或把长尾延迟到工具检索之后——超过约 5-7 个工具的上限后，选择准确率也会提升。`,
      'zh-Hant': (m) => `有 ${m[1]} 個預設/已載入的工具在 ${m[2]} 輪中從未被調用，但每個工具每輪都要支付約 300 token 的預填充。請精簡工具集，或把長尾延遲到工具檢索之後——超過約 5-7 個工具的上限後，選擇準確率也會提升。` },
    { re: /^Terse has already saved (\d+) tokens on the (\d+) messages it optimized/,
      'zh-Hans': (m) => `Terse 已经在它优化过的 ${m[2]} 条消息上节省了 ${m[1]} 个 token。开启自动优化（缓存安全模式）会把同样的精简——礼貌用语、填充词、markdown——应用到其余消息上，且只安全地重写最新一轮，绝不改动已缓存的历史。`,
      'zh-Hant': (m) => `Terse 已經在它優化過的 ${m[2]} 條訊息上節省了 ${m[1]} 個 token。開啟自動優化（緩存安全模式）會把同樣的精簡——禮貌用語、填充詞、markdown——應用到其餘訊息上，且只安全地重寫最新一輪，絕不改動已緩存的歷史。` },
  ];

  // Translate one string for a language; English / unknown → returned as-is.
  function tr(lang, text) {
    if (!text || !lang || lang === 'en') return text;
    const ex = EXACT[lang];
    if (!ex) return text; // language we haven't localized findings for yet
    if (Object.prototype.hasOwnProperty.call(ex, text)) return ex[text];
    for (let i = 0; i < PATTERNS.length; i++) {
      const p = PATTERNS[i];
      const m = text.match(p.re);
      if (m && typeof p[lang] === 'function') return p[lang](m);
    }
    return text;
  }

  // Return a localized shallow copy of a finding (id/category/severity/etc.
  // untouched; only the human-facing text fields are translated).
  function localizeFinding(f, lang) {
    if (!f || !lang || lang === 'en' || !EXACT[lang]) return f;
    const out = Object.assign({}, f);
    out.title = tr(lang, f.title);
    out.detail = tr(lang, f.detail);
    out.categoryLabel = tr(lang, f.categoryLabel);
    out.latencyNote = tr(lang, f.latencyNote);
    out.fixLabel = tr(lang, f.fixLabel);
    return out;
  }

  window.doctorI18n = { tr: tr, localizeFinding: localizeFinding };
})();
