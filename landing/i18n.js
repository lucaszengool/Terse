(function(){
  const T = {};

  T.en = {
    // Nav
    'nav.howItWorks': 'How It Works',
    'nav.pipeline': 'Pipeline',
    'nav.agentMonitor': 'Agent Monitor',
    'nav.benchmarks': 'Benchmarks',
    'nav.pricing': 'Pricing',
    'nav.tokenExchange': 'Token Exchange',
    'nav.faq': 'FAQ',
    'nav.signIn': 'Sign In',
    'nav.signOut': 'Sign Out',

    // Hero
    'hero.title1': 'Save every token.',
    'hero.title2': 'Trade the rest.',
    'hero.subtitle': 'Cut 40-70% of your AI token costs with on-device optimization — or buy tokens at up to 50% off retail on the Token Exchange. Sell what you don\'t use. Stop wasting money on idle API credits.',
    'hero.download': 'Download Optimizer',
    'hero.exchange': 'Buy / Sell Tokens',
    'hero.installNote': 'After installing, drag Terse to <strong>Applications</strong>, then paste this in <strong>Terminal</strong>:',
    'hero.installWarning': 'macOS blocks unsigned apps by default — this command clears it. Only needed once after install.',

    // Features
    'features.bench1': 'Benchmarked across manual prompts, agent turns, and tool calls',
    'features.bench2': 'Clean prompts correctly return 0% — no false changes',
    'features.bench3': 'Savings compound: 5-turn agent session saves 200-400+ tokens',
    'features.sectionTitle': 'Tested on real sessions.',
    'features.description': 'Tested on real ChatGPT prompts, Claude Code agent sessions, and multi-turn agent workflows. Clean technical prompts pass untouched. Verbose prompts and agent messages see 40-70% reduction.',

    // Pipeline
    'pipeline.sectionTitle': 'See the difference',
    'pipeline.subtitle': 'Real outputs, real savings.',
    'pipeline.description': 'Side-by-side comparison on actual prompts and agent commands.',

    // Benchmarks
    'benchmarks.sectionTitle': 'Benchmarks',
    'benchmarks.heading': 'Tested on real sessions.',

    // Usage
    'usage.heading': 'No AI tool offers unlimited usage.',
    'usage.subtitle': 'Even at $200/mo, every tool has caps. Terse compresses prompts so your limits stretch further — and the Token Exchange lets you buy extra capacity at up to 50% off, or sell what you don\'t use.',
    'usage.calloutTitle': 'A typical 2h coding session with an AI agent:',
    'usage.stat1': 'CLI commands run',
    'usage.stat2': 'tokens of prompt + CLI noise',
    'usage.stat3': 'with Terse (89% less)',

    // Tools
    'tools.sectionTitle': 'Every tool has limits',
    'tools.heading': 'Terse stretches every plan further.',
    'tools.description': 'No matter which AI tool you use, token limits and rate caps apply. Terse compresses what goes in — and the Token Exchange lets you buy extra tokens at a fraction of the retail price.',
    'tools.price': 'Price',
    'tools.limits': 'Limits',
    'tools.context': 'Context',

    // Testimonials
    'testimonials.heading': '...and loved by developers',
    'testimonials.subtitle': 'Engineers and AI power users cutting costs and gaining visibility into their token usage.',

    // Stats
    'stats.heading': 'Built on research.',
    'stats.subtitle': 'Grounded in LLMLingua, Norvig spelling, selective context pruning, and real-world agent session analysis.',
    'stats.strategies': 'Optimization strategies',
    'stats.techniques': 'Token reduction techniques',
    'stats.providers': 'API providers supported',
    'stats.discount': '% max discount on Exchange',

    // Pricing
    'pricing.sectionTitle': 'Pricing',
    'pricing.heading': 'Simple, transparent plans',
    'pricing.trialNote': 'Every plan includes a <strong>30-day free trial</strong>. No charge until your trial ends.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/mo',
    'pricing.proDesc': 'For developers running agent sessions daily. Unlimited prompts, multi-session monitoring.',
    'pricing.proTrial': '30-day free trial — cancel anytime',
    'pricing.proF1': 'Unlimited optimizations',
    'pricing.proF2': '3 connected sessions',
    'pricing.proF3': '2 devices',
    'pricing.proF4': 'All 3 optimization modes',
    'pricing.proF5': 'Agent monitoring + duplicate detection',
    'pricing.proF6': 'Auto-replace & Send-mode',
    'pricing.proF7': 'CLAUDE.md rule generation',
    'pricing.startTrial': 'Start Free Trial',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/mo',
    'pricing.premiumDesc': 'For teams and power users. Unlimited everything, priority support.',
    'pricing.premiumF2': 'Unlimited connected sessions',
    'pricing.premiumF3': 'Unlimited devices',
    'pricing.premiumF5': 'Full agent analytics + rule generation',
    'pricing.premiumF7': 'Priority support',

    // FAQ
    'faq.sectionTitle': 'FAQ',
    'faq.heading': 'Frequently asked questions',
    'faq.subtitle': 'Everything you need to know about token optimization and how Terse saves you money.',
    'faq.q1': 'What is token optimization?',
    'faq.a1': 'Token optimization reduces tokens in AI prompts without losing meaning. Terse uses 20+ techniques to cut usage by 40-70%, directly lowering AI API costs.',
    'faq.q2': 'How much can Terse save?',
    'faq.a2': '40-70% on verbose prompts, up to 89% on CLI output. A typical 2h session drops from ~210K to ~23K tokens.',
    'faq.q3': 'Which AI tools work with Terse?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider, and any terminal AI agent. Also browser tools via macOS Accessibility API.',
    'faq.q4': 'How does prompt compression work?',
    'faq.a4': '7-stage pipeline: spell correction, whitespace normalization, pattern optimization, redundancy elimination, NLP analysis, telegraph compression, and cleanup.',
    'faq.q5': 'Does it reduce output quality?',
    'faq.a5': 'No. It removes noise — filler, hedging, typos — without changing intent. Research shows compressed prompts maintain or improve quality.',
    'faq.q6': 'Difference from prompt engineering?',
    'faq.a6': 'Prompt engineering crafts better instructions. Token optimization reduces cost by removing waste. Terse handles optimization automatically.',
    'faq.q7': 'Is Terse free?',
    'faq.a7': 'Both plans include a 30-day free trial. Pro $4.99/mo, Premium $99/mo. Cancel anytime.',
    'faq.q8': 'How do tokens affect cost?',
    'faq.a8': 'AI models charge per token (~4 chars). A single agent session can consume 200K+ tokens, costing $3-$15.',
    'faq.q9': 'What is the Token Exchange?',
    'faq.a9': 'A marketplace to trade unused AI API tokens. Sellers discount their keys, buyers get cheaper access.',
    'faq.q10': 'How to buy or sell tokens?',
    'faq.a10': 'Sign in at terseai.org/marketplace. Sell: paste key, set discount. Buy: top up, generate API key.',

    // CTA
    'cta.heading': 'Stop wasting tokens and money.',
    'cta.subtitle': 'Optimize every prompt. Monitor every session. Trade unused tokens — buy at 50% off or sell idle credits.',
    'cta.onDevice': '100% on-device',
    'cta.zeroLatency': 'Zero latency',

    // Footer
    'footer.tagline': 'Token optimizer + marketplace. Compress prompts, monitor agents, detect duplicates — trade unused API tokens.',
    'footer.product': 'Product',
    'footer.techniques': 'Techniques',
    'footer.learn': 'Learn',
    'footer.download': 'Download',
    'footer.spellCorrection': 'Spell Correction',
    'footer.patternOpt': 'Pattern Optimization',
    'footer.nlpAnalysis': 'NLP Analysis',
    'footer.telegraphComp': 'Telegraph Compression',
    'footer.whatIsTokenOpt': 'What Is Token Optimization?',
    'footer.reduceApiCosts': 'How to Reduce AI API Costs',
    'footer.pricingComparison': 'AI Token Pricing Comparison',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': 'Choose Payment Method',
    'payment.subtitle': 'Select how you\'d like to pay after your 30-day free trial:',
    'payment.card': 'Card / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB, etc.',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'Invoice sent each billing cycle',
    'payment.trialNote': 'No charge during 30-day trial. Cancel anytime.',
    'payment.startBtn': 'Start Free Trial'
  };

  T['zh-Hans'] = {
    // Nav
    'nav.howItWorks': '工作原理',
    'nav.pipeline': '处理流程',
    'nav.agentMonitor': 'Agent 监控',
    'nav.benchmarks': '性能测试',
    'nav.pricing': '价格',
    'nav.tokenExchange': 'Token 交易所',
    'nav.faq': '常见问题',
    'nav.signIn': '登录',
    'nav.signOut': '退出登录',

    // Hero
    'hero.title1': '节省每一个 token。',
    'hero.title2': '交易剩余额度。',
    'hero.subtitle': '通过本地优化削减 40-70% 的 AI token 开销——或在 Token 交易所以低至五折的价格购买 token。卖掉闲置额度，不再为用不完的 API 余额浪费钱。',
    'hero.download': '下载优化器',
    'hero.exchange': '买卖 Token',
    'hero.installNote': '安装后，将 Terse 拖入<strong>应用程序</strong>文件夹，然后在<strong>终端</strong>中粘贴以下命令：',
    'hero.installWarning': 'macOS 默认阻止未签名应用——此命令可解除限制，安装后仅需执行一次。',

    // Features
    'features.bench1': '覆盖手动提示、Agent 对话轮次及工具调用的基准测试',
    'features.bench2': '简洁提示正确返回 0%——不会产生误改',
    'features.bench3': '节省可累积：5 轮 Agent 会话可节省 200-400+ token',
    'features.sectionTitle': '基于真实会话测试。',
    'features.description': '在真实的 ChatGPT 提示、Claude Code Agent 会话和多轮 Agent 工作流上测试。简洁的技术提示原样通过，冗长的提示和 Agent 消息可减少 40-70%。',

    // Pipeline
    'pipeline.sectionTitle': '看看效果',
    'pipeline.subtitle': '真实输出，真实节省。',
    'pipeline.description': '在实际提示和 Agent 命令上的逐行对比。',

    // Benchmarks
    'benchmarks.sectionTitle': '性能测试',
    'benchmarks.heading': '基于真实会话测试。',

    // Usage
    'usage.heading': '没有任何 AI 工具提供无限使用。',
    'usage.subtitle': '即使每月 200 美元的方案也有上限。Terse 压缩提示让额度用得更久——Token 交易所还能以低至五折的价格购买额外容量，或出售闲置额度。',
    'usage.calloutTitle': '一次典型的 2 小时 AI Agent 编程会话：',
    'usage.stat1': '条 CLI 命令执行',
    'usage.stat2': '个 token 的提示 + CLI 噪声',
    'usage.stat3': '使用 Terse 后（减少 89%）',

    // Tools
    'tools.sectionTitle': '每款工具都有限制',
    'tools.heading': 'Terse 让每个方案都更耐用。',
    'tools.description': '无论使用哪款 AI 工具，token 限额和速率限制都存在。Terse 压缩输入内容——Token 交易所让你以远低于官方的价格购买额外 token。',
    'tools.price': '价格',
    'tools.limits': '限制',
    'tools.context': '上下文',

    // Testimonials
    'testimonials.heading': '……深受开发者喜爱',
    'testimonials.subtitle': '工程师和 AI 重度用户正在降低成本，同时全面掌控 token 使用情况。',

    // Stats
    'stats.heading': '基于学术研究。',
    'stats.subtitle': '基于 LLMLingua、Norvig 拼写校正、选择性上下文剪枝以及真实 Agent 会话分析。',
    'stats.strategies': '种优化策略',
    'stats.techniques': '项 token 压缩技术',
    'stats.providers': '家 API 服务商支持',
    'stats.discount': '% 交易所最高折扣',

    // Pricing
    'pricing.sectionTitle': '价格',
    'pricing.heading': '简单透明的方案',
    'pricing.trialNote': '所有方案均包含 <strong>30 天免费试用</strong>。试用期内不收取任何费用。',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/月',
    'pricing.proDesc': '面向每日使用 Agent 的开发者。无限提示优化，多会话监控。',
    'pricing.proTrial': '30 天免费试用——随时取消',
    'pricing.proF1': '无限次优化',
    'pricing.proF2': '3 个连接会话',
    'pricing.proF3': '2 台设备',
    'pricing.proF4': '全部 3 种优化模式',
    'pricing.proF5': 'Agent 监控 + 重复检测',
    'pricing.proF6': '自动替换和发送模式',
    'pricing.proF7': 'CLAUDE.md 规则生成',
    'pricing.startTrial': '开始免费试用',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/月',
    'pricing.premiumDesc': '面向团队和重度用户。全部功能无限制，优先支持。',
    'pricing.premiumF2': '无限连接会话',
    'pricing.premiumF3': '无限设备',
    'pricing.premiumF5': '完整 Agent 分析 + 规则生成',
    'pricing.premiumF7': '优先支持',

    // FAQ
    'faq.sectionTitle': '常见问题',
    'faq.heading': '常见问题解答',
    'faq.subtitle': '关于 token 优化以及 Terse 如何帮你省钱，你需要了解的一切。',
    'faq.q1': '什么是 token 优化？',
    'faq.a1': 'Token 优化在不丢失语义的前提下减少 AI 提示中的 token 数量。Terse 使用 20 多种技术将用量降低 40-70%，直接降低 AI API 成本。',
    'faq.q2': 'Terse 能节省多少？',
    'faq.a2': '冗长提示节省 40-70%，CLI 输出最高节省 89%。典型的 2 小时会话从约 21 万 token 降至约 2.3 万。',
    'faq.q3': '哪些 AI 工具可以配合 Terse 使用？',
    'faq.a3': 'Claude Code、Cursor、OpenClaw、Aider 及所有终端 AI Agent。也支持通过 macOS 辅助功能 API 使用的浏览器工具。',
    'faq.q4': '提示压缩是怎么实现的？',
    'faq.a4': '7 阶段流水线：拼写校正、空白规范化、模式优化、冗余消除、NLP 分析、电报式压缩和清理。',
    'faq.q5': '会降低输出质量吗？',
    'faq.a5': '不会。它只去除噪声——填充词、犹豫表达、拼写错误——不改变意图。研究表明压缩后的提示能保持甚至提升质量。',
    'faq.q6': '和提示工程有什么区别？',
    'faq.a6': '提示工程是编写更好的指令，token 优化是通过去除冗余来降低成本。Terse 自动完成优化工作。',
    'faq.q7': 'Terse 免费吗？',
    'faq.a7': '两种方案均包含 30 天免费试用。Pro 版 $4.99/月，Premium 版 $99/月，随时可取消。',
    'faq.q8': 'Token 如何影响成本？',
    'faq.a8': 'AI 模型按 token 计费（约 4 个字符为 1 个 token）。单次 Agent 会话可消耗 20 万以上 token，费用 $3-$15。',
    'faq.q9': '什么是 Token 交易所？',
    'faq.a9': '一个交易闲置 AI API token 的市场。卖家折价出售密钥，买家获得更便宜的访问。',
    'faq.q10': '如何买卖 token？',
    'faq.a10': '在 terseai.org/marketplace 登录。卖出：粘贴密钥，设定折扣。买入：充值，生成 API 密钥。',

    // CTA
    'cta.heading': '别再浪费 token 和金钱。',
    'cta.subtitle': '优化每一条提示，监控每一个会话。交易闲置 token——五折购入或出售闲置额度。',
    'cta.onDevice': '100% 本地运行',
    'cta.zeroLatency': '零延迟',

    // Footer
    'footer.tagline': 'Token 优化器 + 交易市场。压缩提示、监控 Agent、检测重复——交易闲置 API token。',
    'footer.product': '产品',
    'footer.techniques': '技术',
    'footer.learn': '了解更多',
    'footer.download': '下载',
    'footer.spellCorrection': '拼写校正',
    'footer.patternOpt': '模式优化',
    'footer.nlpAnalysis': 'NLP 分析',
    'footer.telegraphComp': '电报式压缩',
    'footer.whatIsTokenOpt': '什么是 Token 优化？',
    'footer.reduceApiCosts': '如何降低 AI API 成本',
    'footer.pricingComparison': 'AI Token 价格对比',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': '选择支付方式',
    'payment.subtitle': '选择 30 天免费试用结束后的付款方式：',
    'payment.card': '银行卡 / Link',
    'payment.cardDesc': 'Visa、Mastercard、JCB 等',
    'payment.wechat': '微信支付',
    'payment.wechatDesc': '每个账单周期发送账单',
    'payment.trialNote': '30 天试用期内不收费，随时可取消。',
    'payment.startBtn': '开始免费试用'
  };

  T['zh-Hant'] = {
    // Nav
    'nav.howItWorks': '運作原理',
    'nav.pipeline': '處理流程',
    'nav.agentMonitor': 'Agent 監控',
    'nav.benchmarks': '效能測試',
    'nav.pricing': '價格',
    'nav.tokenExchange': 'Token 交易所',
    'nav.faq': '常見問題',
    'nav.signIn': '登入',
    'nav.signOut': '登出',

    // Hero
    'hero.title1': '節省每一個 token。',
    'hero.title2': '交易剩餘額度。',
    'hero.subtitle': '透過本機優化削減 40-70% 的 AI token 開銷——或在 Token 交易所以低至五折的價格購買 token。賣掉閒置額度，不再為用不完的 API 餘額浪費錢。',
    'hero.download': '下載優化器',
    'hero.exchange': '買賣 Token',
    'hero.installNote': '安裝後，將 Terse 拖入<strong>應用程式</strong>資料夾，然後在<strong>終端機</strong>中貼上以下指令：',
    'hero.installWarning': 'macOS 預設會阻擋未簽署的應用程式——此指令可解除限制，安裝後僅需執行一次。',

    // Features
    'features.bench1': '涵蓋手動提示、Agent 對話輪次及工具呼叫的基準測試',
    'features.bench2': '簡潔提示正確回傳 0%——不會產生誤改',
    'features.bench3': '節省可累積：5 輪 Agent 工作階段可節省 200-400+ token',
    'features.sectionTitle': '以真實工作階段測試。',
    'features.description': '在真實的 ChatGPT 提示、Claude Code Agent 工作階段和多輪 Agent 工作流程上測試。簡潔的技術提示原樣通過，冗長的提示和 Agent 訊息可減少 40-70%。',

    // Pipeline
    'pipeline.sectionTitle': '看看效果',
    'pipeline.subtitle': '真實輸出，真實節省。',
    'pipeline.description': '在實際提示和 Agent 指令上的逐行對比。',

    // Benchmarks
    'benchmarks.sectionTitle': '效能測試',
    'benchmarks.heading': '以真實工作階段測試。',

    // Usage
    'usage.heading': '沒有任何 AI 工具提供無限使用。',
    'usage.subtitle': '即使每月 200 美元的方案也有上限。Terse 壓縮提示讓額度用得更久——Token 交易所還能以低至五折的價格購買額外容量，或出售閒置額度。',
    'usage.calloutTitle': '一次典型的 2 小時 AI Agent 程式設計工作階段：',
    'usage.stat1': '條 CLI 指令執行',
    'usage.stat2': '個 token 的提示 + CLI 雜訊',
    'usage.stat3': '使用 Terse 後（減少 89%）',

    // Tools
    'tools.sectionTitle': '每款工具都有限制',
    'tools.heading': 'Terse 讓每個方案都更耐用。',
    'tools.description': '無論使用哪款 AI 工具，token 限額和速率限制都存在。Terse 壓縮輸入內容——Token 交易所讓你以遠低於官方的價格購買額外 token。',
    'tools.price': '價格',
    'tools.limits': '限制',
    'tools.context': '上下文',

    // Testimonials
    'testimonials.heading': '……深受開發者喜愛',
    'testimonials.subtitle': '工程師和 AI 重度使用者正在降低成本，同時全面掌控 token 使用情況。',

    // Stats
    'stats.heading': '基於學術研究。',
    'stats.subtitle': '基於 LLMLingua、Norvig 拼字校正、選擇性上下文剪枝以及真實 Agent 工作階段分析。',
    'stats.strategies': '種優化策略',
    'stats.techniques': '項 token 壓縮技術',
    'stats.providers': '家 API 服務商支援',
    'stats.discount': '% 交易所最高折扣',

    // Pricing
    'pricing.sectionTitle': '價格',
    'pricing.heading': '簡單透明的方案',
    'pricing.trialNote': '所有方案均包含 <strong>30 天免費試用</strong>。試用期內不收取任何費用。',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/月',
    'pricing.proDesc': '面向每日使用 Agent 的開發者。無限提示優化，多工作階段監控。',
    'pricing.proTrial': '30 天免費試用——隨時取消',
    'pricing.proF1': '無限次優化',
    'pricing.proF2': '3 個連線工作階段',
    'pricing.proF3': '2 台裝置',
    'pricing.proF4': '全部 3 種優化模式',
    'pricing.proF5': 'Agent 監控 + 重複偵測',
    'pricing.proF6': '自動取代與傳送模式',
    'pricing.proF7': 'CLAUDE.md 規則產生',
    'pricing.startTrial': '開始免費試用',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/月',
    'pricing.premiumDesc': '面向團隊和重度使用者。全部功能無限制，優先支援。',
    'pricing.premiumF2': '無限連線工作階段',
    'pricing.premiumF3': '無限裝置',
    'pricing.premiumF5': '完整 Agent 分析 + 規則產生',
    'pricing.premiumF7': '優先支援',

    // FAQ
    'faq.sectionTitle': '常見問題',
    'faq.heading': '常見問題解答',
    'faq.subtitle': '關於 token 優化以及 Terse 如何幫你省錢，你需要了解的一切。',
    'faq.q1': '什麼是 token 優化？',
    'faq.a1': 'Token 優化在不遺失語意的前提下減少 AI 提示中的 token 數量。Terse 使用 20 多種技術將用量降低 40-70%，直接降低 AI API 成本。',
    'faq.q2': 'Terse 能節省多少？',
    'faq.a2': '冗長提示節省 40-70%，CLI 輸出最高節省 89%。典型的 2 小時工作階段從約 21 萬 token 降至約 2.3 萬。',
    'faq.q3': '哪些 AI 工具可以搭配 Terse 使用？',
    'faq.a3': 'Claude Code、Cursor、OpenClaw、Aider 及所有終端 AI Agent。也支援透過 macOS 輔助使用 API 的瀏覽器工具。',
    'faq.q4': '提示壓縮是怎麼實現的？',
    'faq.a4': '7 階段管線：拼字校正、空白規範化、模式優化、冗餘消除、NLP 分析、電報式壓縮和清理。',
    'faq.q5': '會降低輸出品質嗎？',
    'faq.a5': '不會。它只去除雜訊——填充詞、猶豫表達、拼字錯誤——不改變意圖。研究顯示壓縮後的提示能維持甚至提升品質。',
    'faq.q6': '和提示工程有什麼區別？',
    'faq.a6': '提示工程是撰寫更好的指令，token 優化是透過去除冗餘來降低成本。Terse 自動完成優化工作。',
    'faq.q7': 'Terse 免費嗎？',
    'faq.a7': '兩種方案均包含 30 天免費試用。Pro 版 $4.99/月，Premium 版 $99/月，隨時可取消。',
    'faq.q8': 'Token 如何影響成本？',
    'faq.a8': 'AI 模型按 token 計費（約 4 個字元為 1 個 token）。單次 Agent 工作階段可消耗 20 萬以上 token，費用 $3-$15。',
    'faq.q9': '什麼是 Token 交易所？',
    'faq.a9': '一個交易閒置 AI API token 的市場。賣家折價出售金鑰，買家獲得更便宜的存取。',
    'faq.q10': '如何買賣 token？',
    'faq.a10': '在 terseai.org/marketplace 登入。賣出：貼上金鑰，設定折扣。買入：儲值，產生 API 金鑰。',

    // CTA
    'cta.heading': '別再浪費 token 和金錢。',
    'cta.subtitle': '優化每一條提示，監控每一個工作階段。交易閒置 token——五折購入或出售閒置額度。',
    'cta.onDevice': '100% 本機執行',
    'cta.zeroLatency': '零延遲',

    // Footer
    'footer.tagline': 'Token 優化器 + 交易市場。壓縮提示、監控 Agent、偵測重複——交易閒置 API token。',
    'footer.product': '產品',
    'footer.techniques': '技術',
    'footer.learn': '瞭解更多',
    'footer.download': '下載',
    'footer.spellCorrection': '拼字校正',
    'footer.patternOpt': '模式優化',
    'footer.nlpAnalysis': 'NLP 分析',
    'footer.telegraphComp': '電報式壓縮',
    'footer.whatIsTokenOpt': '什麼是 Token 優化？',
    'footer.reduceApiCosts': '如何降低 AI API 成本',
    'footer.pricingComparison': 'AI Token 價格比較',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': '選擇付款方式',
    'payment.subtitle': '選擇 30 天免費試用結束後的付款方式：',
    'payment.card': '信用卡 / Link',
    'payment.cardDesc': 'Visa、Mastercard、JCB 等',
    'payment.wechat': '微信支付',
    'payment.wechatDesc': '每個帳單週期寄送帳單',
    'payment.trialNote': '30 天試用期內不收費，隨時可取消。',
    'payment.startBtn': '開始免費試用'
  };

  T.ja = {
    // Nav
    'nav.howItWorks': '仕組み',
    'nav.pipeline': 'パイプライン',
    'nav.agentMonitor': 'エージェント監視',
    'nav.benchmarks': 'ベンチマーク',
    'nav.pricing': '料金',
    'nav.tokenExchange': 'トークン取引所',
    'nav.faq': 'よくある質問',
    'nav.signIn': 'ログイン',
    'nav.signOut': 'ログアウト',

    // Hero
    'hero.title1': 'すべてのトークンを節約。',
    'hero.title2': '余った分は取引。',
    'hero.subtitle': 'オンデバイス最適化でAIトークンコストを40〜70%削減。またはトークン取引所で最大50%オフで購入できます。使わないクレジットは売却して、無駄な出費をなくしましょう。',
    'hero.download': 'オプティマイザをダウンロード',
    'hero.exchange': 'トークンの売買',
    'hero.installNote': 'インストール後、Terseを<strong>アプリケーション</strong>にドラッグし、<strong>ターミナル</strong>で以下を実行してください：',
    'hero.installWarning': 'macOSは未署名のアプリをデフォルトでブロックします。このコマンドで解除できます。インストール後1回だけ実行してください。',

    // Features
    'features.bench1': '手動プロンプト、エージェントのターン、ツール呼び出しを対象にベンチマーク済み',
    'features.bench2': 'クリーンなプロンプトは正しく0%を返します — 誤った変更はありません',
    'features.bench3': '節約は累積します：5ターンのエージェントセッションで200〜400+トークンを削減',
    'features.sectionTitle': '実際のセッションで検証済み。',
    'features.description': '実際のChatGPTプロンプト、Claude Codeエージェントセッション、マルチターンのエージェントワークフローでテスト済み。簡潔な技術プロンプトはそのまま通過し、冗長なプロンプトやエージェントメッセージは40〜70%削減されます。',

    // Pipeline
    'pipeline.sectionTitle': '違いをご覧ください',
    'pipeline.subtitle': '実際の出力、実際の節約。',
    'pipeline.description': '実際のプロンプトとエージェントコマンドの比較。',

    // Benchmarks
    'benchmarks.sectionTitle': 'ベンチマーク',
    'benchmarks.heading': '実際のセッションで検証済み。',

    // Usage
    'usage.heading': '無制限のAIツールは存在しません。',
    'usage.subtitle': '月額200ドルのプランでも制限があります。Terseはプロンプトを圧縮して制限をより長く活用でき、トークン取引所では最大50%オフで追加容量を購入、または余ったクレジットを売却できます。',
    'usage.calloutTitle': '典型的な2時間のAIエージェントコーディングセッション：',
    'usage.stat1': '件のCLIコマンドを実行',
    'usage.stat2': 'トークンのプロンプト + CLIノイズ',
    'usage.stat3': 'Terse使用時（89%削減）',

    // Tools
    'tools.sectionTitle': 'すべてのツールに制限があります',
    'tools.heading': 'Terseはあらゆるプランをさらに活用します。',
    'tools.description': 'どのAIツールをお使いでも、トークン制限とレート制限が適用されます。Terseは入力を圧縮し、トークン取引所では通常価格の数分の一で追加トークンを購入できます。',
    'tools.price': '料金',
    'tools.limits': '制限',
    'tools.context': 'コンテキスト',

    // Testimonials
    'testimonials.heading': '開発者に愛されています',
    'testimonials.subtitle': 'エンジニアやAIパワーユーザーがコストを削減し、トークン使用量を把握しています。',

    // Stats
    'stats.heading': '研究に基づいて構築。',
    'stats.subtitle': 'LLMLingua、Norvigスペルチェック、選択的コンテキスト剪定、実際のエージェントセッション分析に基づいています。',
    'stats.strategies': '種類の最適化戦略',
    'stats.techniques': '種類のトークン削減技術',
    'stats.providers': '社のAPIプロバイダーに対応',
    'stats.discount': '% 取引所の最大割引',

    // Pricing
    'pricing.sectionTitle': '料金',
    'pricing.heading': 'シンプルで透明な料金プラン',
    'pricing.trialNote': 'すべてのプランに<strong>30日間の無料トライアル</strong>が含まれます。トライアル終了まで課金はありません。',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/月',
    'pricing.proDesc': '毎日エージェントセッションを実行する開発者向け。プロンプト最適化無制限、マルチセッション監視。',
    'pricing.proTrial': '30日間無料トライアル — いつでも解約可能',
    'pricing.proF1': '無制限の最適化',
    'pricing.proF2': '3つの接続セッション',
    'pricing.proF3': '2台のデバイス',
    'pricing.proF4': '3つの最適化モードすべて',
    'pricing.proF5': 'エージェント監視 + 重複検出',
    'pricing.proF6': '自動置換 & 送信モード',
    'pricing.proF7': 'CLAUDE.mdルール生成',
    'pricing.startTrial': '無料トライアルを開始',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/月',
    'pricing.premiumDesc': 'チームやパワーユーザー向け。すべて無制限、優先サポート。',
    'pricing.premiumF2': '接続セッション無制限',
    'pricing.premiumF3': 'デバイス無制限',
    'pricing.premiumF5': '完全なエージェント分析 + ルール生成',
    'pricing.premiumF7': '優先サポート',

    // FAQ
    'faq.sectionTitle': 'よくある質問',
    'faq.heading': 'よくある質問',
    'faq.subtitle': 'トークン最適化とTerseによるコスト削減について知っておくべきことをまとめました。',
    'faq.q1': 'トークン最適化とは何ですか？',
    'faq.a1': 'トークン最適化は、意味を損なうことなくAIプロンプトのトークン数を削減します。Terseは20以上の技術を使用して使用量を40〜70%削減し、AI APIコストを直接下げます。',
    'faq.q2': 'Terseでどれくらい節約できますか？',
    'faq.a2': '冗長なプロンプトで40〜70%、CLI出力で最大89%の削減。典型的な2時間のセッションで約21万トークンから約2.3万トークンに削減されます。',
    'faq.q3': 'どのAIツールに対応していますか？',
    'faq.a3': 'Claude Code、Cursor、OpenClaw、Aider、およびすべてのターミナルAIエージェント。macOSアクセシビリティAPIを介したブラウザツールにも対応しています。',
    'faq.q4': 'プロンプト圧縮はどのように機能しますか？',
    'faq.a4': '7段階のパイプライン：スペル修正、空白正規化、パターン最適化、冗長性除去、NLP分析、電文式圧縮、クリーンアップ。',
    'faq.q5': '出力品質は低下しますか？',
    'faq.a5': 'いいえ。フィラー、曖昧表現、タイプミスなどのノイズを除去するだけで、意図は変わりません。研究によると、圧縮されたプロンプトは品質を維持または向上させます。',
    'faq.q6': 'プロンプトエンジニアリングとの違いは？',
    'faq.a6': 'プロンプトエンジニアリングはより良い指示を作成することです。トークン最適化は無駄を省いてコストを削減します。Terseは最適化を自動的に処理します。',
    'faq.q7': 'Terseは無料ですか？',
    'faq.a7': 'どちらのプランにも30日間の無料トライアルが含まれます。Pro $4.99/月、Premium $99/月。いつでも解約可能です。',
    'faq.q8': 'トークンはコストにどう影響しますか？',
    'faq.a8': 'AIモデルはトークン単位で課金されます（約4文字で1トークン）。1回のエージェントセッションで20万以上のトークンを消費し、$3〜$15のコストがかかることがあります。',
    'faq.q9': 'トークン取引所とは何ですか？',
    'faq.a9': '未使用のAI APIトークンを取引するマーケットプレイスです。売り手はキーを割引価格で提供し、買い手はより安くアクセスできます。',
    'faq.q10': 'トークンの売買方法は？',
    'faq.a10': 'terseai.org/marketplaceにログインしてください。売却：キーを貼り付け、割引率を設定。購入：チャージしてAPIキーを生成。',

    // CTA
    'cta.heading': 'トークンとコストの無駄をなくしましょう。',
    'cta.subtitle': 'すべてのプロンプトを最適化。すべてのセッションを監視。余ったトークンを取引 — 50%オフで購入、または余剰クレジットを売却。',
    'cta.onDevice': '100%オンデバイス',
    'cta.zeroLatency': 'ゼロレイテンシー',

    // Footer
    'footer.tagline': 'トークンオプティマイザ + マーケットプレイス。プロンプト圧縮、エージェント監視、重複検出 — 未使用APIトークンの取引。',
    'footer.product': '製品',
    'footer.techniques': '技術',
    'footer.learn': '詳しく見る',
    'footer.download': 'ダウンロード',
    'footer.spellCorrection': 'スペル修正',
    'footer.patternOpt': 'パターン最適化',
    'footer.nlpAnalysis': 'NLP分析',
    'footer.telegraphComp': '電文式圧縮',
    'footer.whatIsTokenOpt': 'トークン最適化とは？',
    'footer.reduceApiCosts': 'AI APIコストを削減する方法',
    'footer.pricingComparison': 'AIトークン料金比較',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': 'お支払い方法を選択',
    'payment.subtitle': '30日間の無料トライアル後のお支払い方法を選択してください：',
    'payment.card': 'クレジットカード / Link',
    'payment.cardDesc': 'Visa、Mastercard、JCBなど',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': '請求サイクルごとに請求書を送付',
    'payment.trialNote': '30日間のトライアル期間中は課金されません。いつでも解約可能です。',
    'payment.startBtn': '無料トライアルを開始'
  };

  T.ko = {
    // Nav
    'nav.howItWorks': '작동 방식',
    'nav.pipeline': '파이프라인',
    'nav.agentMonitor': '에이전트 모니터',
    'nav.benchmarks': '벤치마크',
    'nav.pricing': '요금제',
    'nav.tokenExchange': '토큰 거래소',
    'nav.faq': '자주 묻는 질문',
    'nav.signIn': '로그인',
    'nav.signOut': '로그아웃',

    // Hero
    'hero.title1': '모든 토큰을 절약하세요.',
    'hero.title2': '나머지는 거래하세요.',
    'hero.subtitle': '온디바이스 최적화로 AI 토큰 비용을 40~70% 절감하거나, 토큰 거래소에서 최대 50% 할인된 가격으로 토큰을 구매하세요. 사용하지 않는 크레딧은 판매하세요. 더 이상 유휴 API 크레딧에 돈을 낭비하지 마세요.',
    'hero.download': '옵티마이저 다운로드',
    'hero.exchange': '토큰 매매',
    'hero.installNote': '설치 후 Terse를 <strong>응용 프로그램</strong>으로 드래그한 다음 <strong>터미널</strong>에서 다음을 붙여넣으세요:',
    'hero.installWarning': 'macOS는 서명되지 않은 앱을 기본적으로 차단합니다. 이 명령으로 해제할 수 있으며, 설치 후 한 번만 실행하면 됩니다.',

    // Features
    'features.bench1': '수동 프롬프트, 에이전트 턴, 도구 호출을 대상으로 벤치마크 완료',
    'features.bench2': '깨끗한 프롬프트는 정확히 0%를 반환합니다 — 잘못된 변경 없음',
    'features.bench3': '절약은 누적됩니다: 5턴 에이전트 세션에서 200~400+ 토큰 절감',
    'features.sectionTitle': '실제 세션에서 테스트되었습니다.',
    'features.description': '실제 ChatGPT 프롬프트, Claude Code 에이전트 세션, 멀티턴 에이전트 워크플로에서 테스트되었습니다. 깔끔한 기술 프롬프트는 그대로 통과하고, 장황한 프롬프트와 에이전트 메시지는 40~70% 줄어듭니다.',

    // Pipeline
    'pipeline.sectionTitle': '차이를 확인하세요',
    'pipeline.subtitle': '실제 출력, 실제 절약.',
    'pipeline.description': '실제 프롬프트와 에이전트 명령의 나란히 비교.',

    // Benchmarks
    'benchmarks.sectionTitle': '벤치마크',
    'benchmarks.heading': '실제 세션에서 테스트되었습니다.',

    // Usage
    'usage.heading': '무제한 사용을 제공하는 AI 도구는 없습니다.',
    'usage.subtitle': '월 200달러 요금제도 제한이 있습니다. Terse는 프롬프트를 압축하여 한도를 더 오래 사용할 수 있게 하며, 토큰 거래소에서 최대 50% 할인된 가격으로 추가 용량을 구매하거나 사용하지 않는 크레딧을 판매할 수 있습니다.',
    'usage.calloutTitle': '일반적인 2시간 AI 에이전트 코딩 세션:',
    'usage.stat1': '개의 CLI 명령 실행',
    'usage.stat2': '토큰의 프롬프트 + CLI 노이즈',
    'usage.stat3': 'Terse 사용 시 (89% 절감)',

    // Tools
    'tools.sectionTitle': '모든 도구에는 제한이 있습니다',
    'tools.heading': 'Terse는 모든 요금제를 더 효율적으로 만듭니다.',
    'tools.description': '어떤 AI 도구를 사용하든 토큰 한도와 속도 제한이 적용됩니다. Terse는 입력을 압축하고, 토큰 거래소에서는 정가보다 훨씬 저렴하게 추가 토큰을 구매할 수 있습니다.',
    'tools.price': '가격',
    'tools.limits': '제한',
    'tools.context': '컨텍스트',

    // Testimonials
    'testimonials.heading': '개발자들이 사랑합니다',
    'testimonials.subtitle': '엔지니어와 AI 파워 유저들이 비용을 절감하고 토큰 사용량을 파악하고 있습니다.',

    // Stats
    'stats.heading': '연구에 기반하여 구축되었습니다.',
    'stats.subtitle': 'LLMLingua, Norvig 맞춤법 검사, 선택적 컨텍스트 프루닝, 실제 에이전트 세션 분석에 기반합니다.',
    'stats.strategies': '가지 최적화 전략',
    'stats.techniques': '가지 토큰 절감 기술',
    'stats.providers': '개 API 제공업체 지원',
    'stats.discount': '% 거래소 최대 할인',

    // Pricing
    'pricing.sectionTitle': '요금제',
    'pricing.heading': '간단하고 투명한 요금제',
    'pricing.trialNote': '모든 요금제에 <strong>30일 무료 체험</strong>이 포함됩니다. 체험 기간 종료 전까지 요금이 부과되지 않습니다.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/월',
    'pricing.proDesc': '매일 에이전트 세션을 실행하는 개발자를 위한 요금제. 무제한 프롬프트 최적화, 멀티 세션 모니터링.',
    'pricing.proTrial': '30일 무료 체험 — 언제든지 해지 가능',
    'pricing.proF1': '무제한 최적화',
    'pricing.proF2': '3개의 연결 세션',
    'pricing.proF3': '2대의 기기',
    'pricing.proF4': '3가지 최적화 모드 모두',
    'pricing.proF5': '에이전트 모니터링 + 중복 감지',
    'pricing.proF6': '자동 교체 & 전송 모드',
    'pricing.proF7': 'CLAUDE.md 규칙 생성',
    'pricing.startTrial': '무료 체험 시작',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/월',
    'pricing.premiumDesc': '팀과 파워 유저를 위한 요금제. 모든 기능 무제한, 우선 지원.',
    'pricing.premiumF2': '무제한 연결 세션',
    'pricing.premiumF3': '무제한 기기',
    'pricing.premiumF5': '전체 에이전트 분석 + 규칙 생성',
    'pricing.premiumF7': '우선 지원',

    // FAQ
    'faq.sectionTitle': '자주 묻는 질문',
    'faq.heading': '자주 묻는 질문',
    'faq.subtitle': '토큰 최적화와 Terse가 비용을 절감하는 방법에 대해 알아야 할 모든 것을 정리했습니다.',
    'faq.q1': '토큰 최적화란 무엇입니까?',
    'faq.a1': '토큰 최적화는 의미를 잃지 않으면서 AI 프롬프트의 토큰을 줄이는 것입니다. Terse는 20가지 이상의 기술을 사용하여 사용량을 40~70% 절감하고, AI API 비용을 직접적으로 낮춥니다.',
    'faq.q2': 'Terse로 얼마나 절약할 수 있습니까?',
    'faq.a2': '장황한 프롬프트에서 40~70%, CLI 출력에서 최대 89% 절감됩니다. 일반적인 2시간 세션에서 약 21만 토큰이 약 2.3만 토큰으로 줄어듭니다.',
    'faq.q3': '어떤 AI 도구와 호환됩니까?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider 및 모든 터미널 AI 에이전트와 호환됩니다. macOS 접근성 API를 통한 브라우저 도구도 지원합니다.',
    'faq.q4': '프롬프트 압축은 어떻게 작동합니까?',
    'faq.a4': '7단계 파이프라인: 맞춤법 교정, 공백 정규화, 패턴 최적화, 중복 제거, NLP 분석, 전보식 압축, 정리.',
    'faq.q5': '출력 품질이 저하됩니까?',
    'faq.a5': '아닙니다. 필러, 애매한 표현, 오타 등의 노이즈만 제거하며 의도는 변경하지 않습니다. 연구에 따르면 압축된 프롬프트는 품질을 유지하거나 향상시킵니다.',
    'faq.q6': '프롬프트 엔지니어링과의 차이점은 무엇입니까?',
    'faq.a6': '프롬프트 엔지니어링은 더 나은 지시를 작성하는 것입니다. 토큰 최적화는 불필요한 부분을 제거하여 비용을 줄입니다. Terse는 최적화를 자동으로 처리합니다.',
    'faq.q7': 'Terse는 무료입니까?',
    'faq.a7': '두 요금제 모두 30일 무료 체험이 포함됩니다. Pro $4.99/월, Premium $99/월. 언제든지 해지 가능합니다.',
    'faq.q8': '토큰이 비용에 어떤 영향을 미칩니까?',
    'faq.a8': 'AI 모델은 토큰 단위로 과금됩니다 (약 4자가 1토큰). 한 번의 에이전트 세션에서 20만 이상의 토큰을 소비하며, $3~$15의 비용이 발생할 수 있습니다.',
    'faq.q9': '토큰 거래소란 무엇입니까?',
    'faq.a9': '사용하지 않는 AI API 토큰을 거래하는 마켓플레이스입니다. 판매자는 키를 할인가로 제공하고, 구매자는 더 저렴하게 이용할 수 있습니다.',
    'faq.q10': '토큰을 어떻게 사고팔 수 있습니까?',
    'faq.a10': 'terseai.org/marketplace에 로그인하세요. 판매: 키를 붙여넣고 할인율을 설정합니다. 구매: 충전 후 API 키를 생성합니다.',

    // CTA
    'cta.heading': '토큰과 비용 낭비를 멈추세요.',
    'cta.subtitle': '모든 프롬프트를 최적화하고 모든 세션을 모니터링하세요. 남는 토큰을 거래하세요 — 50% 할인으로 구매하거나 유휴 크레딧을 판매하세요.',
    'cta.onDevice': '100% 온디바이스',
    'cta.zeroLatency': '제로 레이턴시',

    // Footer
    'footer.tagline': '토큰 옵티마이저 + 마켓플레이스. 프롬프트 압축, 에이전트 모니터링, 중복 감지 — 미사용 API 토큰 거래.',
    'footer.product': '제품',
    'footer.techniques': '기술',
    'footer.learn': '자세히 보기',
    'footer.download': '다운로드',
    'footer.spellCorrection': '맞춤법 교정',
    'footer.patternOpt': '패턴 최적화',
    'footer.nlpAnalysis': 'NLP 분석',
    'footer.telegraphComp': '전보식 압축',
    'footer.whatIsTokenOpt': '토큰 최적화란?',
    'footer.reduceApiCosts': 'AI API 비용을 줄이는 방법',
    'footer.pricingComparison': 'AI 토큰 요금 비교',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': '결제 방법 선택',
    'payment.subtitle': '30일 무료 체험 후 결제 방법을 선택하세요:',
    'payment.card': '카드 / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB 등',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': '청구 주기마다 인보이스 발송',
    'payment.trialNote': '30일 체험 기간 중에는 요금이 부과되지 않습니다. 언제든지 해지 가능합니다.',
    'payment.startBtn': '무료 체험 시작'
  };

  T.es = {
    // Nav
    'nav.howItWorks': 'Cómo funciona',
    'nav.pipeline': 'Pipeline',
    'nav.agentMonitor': 'Monitor de agentes',
    'nav.benchmarks': 'Benchmarks',
    'nav.pricing': 'Precios',
    'nav.tokenExchange': 'Token Exchange',
    'nav.faq': 'Preguntas frecuentes',
    'nav.signIn': 'Iniciar sesión',
    'nav.signOut': 'Cerrar sesión',

    // Hero
    'hero.title1': 'Ahorre cada token.',
    'hero.title2': 'Intercambie el resto.',
    'hero.subtitle': 'Reduzca entre un 40 y un 70% de sus costos de tokens de IA con optimización en el dispositivo, o compre tokens con hasta un 50% de descuento en el Token Exchange. Venda lo que no utilice. Deje de desperdiciar dinero en créditos de API inactivos.',
    'hero.download': 'Descargar optimizador',
    'hero.exchange': 'Comprar / Vender tokens',
    'hero.installNote': 'Después de instalar, arrastre Terse a <strong>Aplicaciones</strong> y luego pegue esto en la <strong>Terminal</strong>:',
    'hero.installWarning': 'macOS bloquea las aplicaciones no firmadas por defecto — este comando lo desactiva. Solo es necesario una vez después de la instalación.',

    // Features
    'features.bench1': 'Evaluado en prompts manuales, turnos de agentes y llamadas a herramientas',
    'features.bench2': 'Los prompts limpios devuelven correctamente 0% — sin cambios falsos',
    'features.bench3': 'El ahorro se acumula: una sesión de agente de 5 turnos ahorra más de 200-400 tokens',
    'features.sectionTitle': 'Probado en sesiones reales.',
    'features.description': 'Probado en prompts reales de ChatGPT, sesiones de agentes de Claude Code y flujos de trabajo de agentes multi-turno. Los prompts técnicos limpios pasan sin cambios. Los prompts extensos y mensajes de agentes se reducen entre un 40 y un 70%.',

    // Pipeline
    'pipeline.sectionTitle': 'Vea la diferencia',
    'pipeline.subtitle': 'Resultados reales, ahorros reales.',
    'pipeline.description': 'Comparación lado a lado en prompts y comandos de agentes reales.',

    // Benchmarks
    'benchmarks.sectionTitle': 'Benchmarks',
    'benchmarks.heading': 'Probado en sesiones reales.',

    // Usage
    'usage.heading': 'Ninguna herramienta de IA ofrece uso ilimitado.',
    'usage.subtitle': 'Incluso a $200/mes, todas las herramientas tienen límites. Terse comprime los prompts para que sus límites rindan más — y el Token Exchange le permite comprar capacidad extra con hasta un 50% de descuento o vender lo que no utilice.',
    'usage.calloutTitle': 'Una sesión típica de 2 horas de codificación con un agente de IA:',
    'usage.stat1': 'comandos CLI ejecutados',
    'usage.stat2': 'tokens de prompt + ruido de CLI',
    'usage.stat3': 'con Terse (89% menos)',

    // Tools
    'tools.sectionTitle': 'Todas las herramientas tienen límites',
    'tools.heading': 'Terse aprovecha al máximo cada plan.',
    'tools.description': 'Sin importar qué herramienta de IA utilicen, se aplican límites de tokens y de velocidad. Terse comprime lo que se envía — y el Token Exchange les permite comprar tokens adicionales a una fracción del precio.',
    'tools.price': 'Precio',
    'tools.limits': 'Límites',
    'tools.context': 'Contexto',

    // Testimonials
    'testimonials.heading': '...y los desarrolladores lo adoran',
    'testimonials.subtitle': 'Ingenieros y usuarios avanzados de IA que reducen costos y obtienen visibilidad sobre su uso de tokens.',

    // Stats
    'stats.heading': 'Basado en investigación.',
    'stats.subtitle': 'Fundamentado en LLMLingua, corrección ortográfica de Norvig, poda selectiva de contexto y análisis de sesiones reales de agentes.',
    'stats.strategies': 'estrategias de optimización',
    'stats.techniques': 'técnicas de reducción de tokens',
    'stats.providers': 'proveedores de API compatibles',
    'stats.discount': '% descuento máximo en el Exchange',

    // Pricing
    'pricing.sectionTitle': 'Precios',
    'pricing.heading': 'Planes simples y transparentes',
    'pricing.trialNote': 'Todos los planes incluyen una <strong>prueba gratuita de 30 días</strong>. No se cobra hasta que termine la prueba.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/mes',
    'pricing.proDesc': 'Para desarrolladores que ejecutan sesiones de agentes a diario. Prompts ilimitados, monitoreo multi-sesión.',
    'pricing.proTrial': 'Prueba gratuita de 30 días — cancelen en cualquier momento',
    'pricing.proF1': 'Optimizaciones ilimitadas',
    'pricing.proF2': '3 sesiones conectadas',
    'pricing.proF3': '2 dispositivos',
    'pricing.proF4': 'Los 3 modos de optimización',
    'pricing.proF5': 'Monitoreo de agentes + detección de duplicados',
    'pricing.proF6': 'Reemplazo automático y modo de envío',
    'pricing.proF7': 'Generación de reglas CLAUDE.md',
    'pricing.startTrial': 'Iniciar prueba gratuita',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/mes',
    'pricing.premiumDesc': 'Para equipos y usuarios avanzados. Todo ilimitado, soporte prioritario.',
    'pricing.premiumF2': 'Sesiones conectadas ilimitadas',
    'pricing.premiumF3': 'Dispositivos ilimitados',
    'pricing.premiumF5': 'Analítica completa de agentes + generación de reglas',
    'pricing.premiumF7': 'Soporte prioritario',

    // FAQ
    'faq.sectionTitle': 'Preguntas frecuentes',
    'faq.heading': 'Preguntas frecuentes',
    'faq.subtitle': 'Todo lo que necesitan saber sobre la optimización de tokens y cómo Terse les ahorra dinero.',
    'faq.q1': '¿Qué es la optimización de tokens?',
    'faq.a1': 'La optimización de tokens reduce los tokens en los prompts de IA sin perder significado. Terse utiliza más de 20 técnicas para reducir el uso entre un 40 y un 70%, disminuyendo directamente los costos de API de IA.',
    'faq.q2': '¿Cuánto puede ahorrar Terse?',
    'faq.a2': 'Entre un 40 y un 70% en prompts extensos, hasta un 89% en salida de CLI. Una sesión típica de 2 horas pasa de ~210K a ~23K tokens.',
    'faq.q3': '¿Con qué herramientas de IA funciona Terse?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider y cualquier agente de IA de terminal. También herramientas de navegador a través de la API de accesibilidad de macOS.',
    'faq.q4': '¿Cómo funciona la compresión de prompts?',
    'faq.a4': 'Pipeline de 7 etapas: corrección ortográfica, normalización de espacios, optimización de patrones, eliminación de redundancias, análisis NLP, compresión telegráfica y limpieza.',
    'faq.q5': '¿Reduce la calidad de las respuestas?',
    'faq.a5': 'No. Elimina el ruido — relleno, expresiones vagas, errores tipográficos — sin cambiar la intención. Las investigaciones demuestran que los prompts comprimidos mantienen o mejoran la calidad.',
    'faq.q6': '¿En qué se diferencia de la ingeniería de prompts?',
    'faq.a6': 'La ingeniería de prompts crea mejores instrucciones. La optimización de tokens reduce costos eliminando lo innecesario. Terse se encarga de la optimización automáticamente.',
    'faq.q7': '¿Terse es gratuito?',
    'faq.a7': 'Ambos planes incluyen una prueba gratuita de 30 días. Pro $4.99/mes, Premium $99/mes. Cancelen en cualquier momento.',
    'faq.q8': '¿Cómo afectan los tokens al costo?',
    'faq.a8': 'Los modelos de IA cobran por token (~4 caracteres). Una sola sesión de agente puede consumir más de 200K tokens, con un costo de $3 a $15.',
    'faq.q9': '¿Qué es el Token Exchange?',
    'faq.a9': 'Un marketplace para intercambiar tokens de API de IA no utilizados. Los vendedores ofrecen sus claves con descuento y los compradores obtienen acceso más barato.',
    'faq.q10': '¿Cómo comprar o vender tokens?',
    'faq.a10': 'Ingresen en terseai.org/marketplace. Para vender: peguen la clave y establezcan el descuento. Para comprar: recarguen y generen una clave de API.',

    // CTA
    'cta.heading': 'Dejen de desperdiciar tokens y dinero.',
    'cta.subtitle': 'Optimicen cada prompt. Monitoreen cada sesión. Intercambien tokens no utilizados — compren con un 50% de descuento o vendan créditos inactivos.',
    'cta.onDevice': '100% en el dispositivo',
    'cta.zeroLatency': 'Cero latencia',

    // Footer
    'footer.tagline': 'Optimizador de tokens + marketplace. Compriman prompts, monitoreen agentes, detecten duplicados — intercambien tokens de API no utilizados.',
    'footer.product': 'Producto',
    'footer.techniques': 'Técnicas',
    'footer.learn': 'Aprender',
    'footer.download': 'Descargar',
    'footer.spellCorrection': 'Corrección ortográfica',
    'footer.patternOpt': 'Optimización de patrones',
    'footer.nlpAnalysis': 'Análisis NLP',
    'footer.telegraphComp': 'Compresión telegráfica',
    'footer.whatIsTokenOpt': '¿Qué es la optimización de tokens?',
    'footer.reduceApiCosts': 'Cómo reducir los costos de API de IA',
    'footer.pricingComparison': 'Comparación de precios de tokens de IA',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': 'Elijan el método de pago',
    'payment.subtitle': 'Seleccionen cómo desean pagar después de la prueba gratuita de 30 días:',
    'payment.card': 'Tarjeta / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB, etc.',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'Factura enviada en cada ciclo de facturación',
    'payment.trialNote': 'Sin cargos durante la prueba de 30 días. Cancelen en cualquier momento.',
    'payment.startBtn': 'Iniciar prueba gratuita'
  };

  T.fr = {
    // Nav
    'nav.howItWorks': 'Fonctionnement',
    'nav.pipeline': 'Pipeline',
    'nav.agentMonitor': 'Moniteur d\'agents',
    'nav.benchmarks': 'Benchmarks',
    'nav.pricing': 'Tarifs',
    'nav.tokenExchange': 'Token Exchange',
    'nav.faq': 'FAQ',
    'nav.signIn': 'Se connecter',
    'nav.signOut': 'Se déconnecter',

    // Hero
    'hero.title1': 'Économisez chaque token.',
    'hero.title2': 'Échangez le reste.',
    'hero.subtitle': 'Réduisez de 40 à 70 % vos coûts de tokens IA grâce à l\'optimisation sur l\'appareil — ou achetez des tokens jusqu\'à 50 % moins cher sur le Token Exchange. Vendez ce que vous n\'utilisez pas. Cessez de gaspiller de l\'argent en crédits API inutilisés.',
    'hero.download': 'Télécharger l\'optimiseur',
    'hero.exchange': 'Acheter / Vendre des tokens',
    'hero.installNote': 'Après l\'installation, glissez Terse dans <strong>Applications</strong>, puis collez ceci dans le <strong>Terminal</strong> :',
    'hero.installWarning': 'macOS bloque les applications non signées par défaut — cette commande lève la restriction. À exécuter une seule fois après l\'installation.',

    // Features
    'features.bench1': 'Évalué sur des prompts manuels, des tours d\'agent et des appels d\'outils',
    'features.bench2': 'Les prompts propres renvoient correctement 0 % — aucune modification erronée',
    'features.bench3': 'Les économies se cumulent : une session d\'agent de 5 tours économise plus de 200 à 400 tokens',
    'features.sectionTitle': 'Testé sur des sessions réelles.',
    'features.description': 'Testé sur de vrais prompts ChatGPT, des sessions d\'agents Claude Code et des workflows d\'agents multi-tours. Les prompts techniques concis passent sans modification. Les prompts verbeux et messages d\'agents sont réduits de 40 à 70 %.',

    // Pipeline
    'pipeline.sectionTitle': 'Voyez la différence',
    'pipeline.subtitle': 'Des résultats réels, des économies réelles.',
    'pipeline.description': 'Comparaison côte à côte sur de vrais prompts et commandes d\'agents.',

    // Benchmarks
    'benchmarks.sectionTitle': 'Benchmarks',
    'benchmarks.heading': 'Testé sur des sessions réelles.',

    // Usage
    'usage.heading': 'Aucun outil IA n\'offre un usage illimité.',
    'usage.subtitle': 'Même à 200 $/mois, chaque outil a des limites. Terse compresse vos prompts pour prolonger vos quotas — et le Token Exchange vous permet d\'acheter de la capacité supplémentaire jusqu\'à 50 % moins cher, ou de vendre vos crédits inutilisés.',
    'usage.calloutTitle': 'Une session de codage typique de 2 h avec un agent IA :',
    'usage.stat1': 'commandes CLI exécutées',
    'usage.stat2': 'tokens de prompt + bruit CLI',
    'usage.stat3': 'avec Terse (89 % de moins)',

    // Tools
    'tools.sectionTitle': 'Chaque outil a ses limites',
    'tools.heading': 'Terse optimise chaque forfait.',
    'tools.description': 'Quel que soit l\'outil IA que vous utilisez, des limites de tokens et de débit s\'appliquent. Terse compresse les entrées — et le Token Exchange vous permet d\'acheter des tokens supplémentaires à une fraction du prix.',
    'tools.price': 'Prix',
    'tools.limits': 'Limites',
    'tools.context': 'Contexte',

    // Testimonials
    'testimonials.heading': '...et plébiscité par les développeurs',
    'testimonials.subtitle': 'Des ingénieurs et utilisateurs avancés de l\'IA qui réduisent leurs coûts et suivent leur consommation de tokens.',

    // Stats
    'stats.heading': 'Fondé sur la recherche.',
    'stats.subtitle': 'Basé sur LLMLingua, la correction orthographique de Norvig, l\'élagage sélectif de contexte et l\'analyse de sessions d\'agents réelles.',
    'stats.strategies': 'stratégies d\'optimisation',
    'stats.techniques': 'techniques de réduction de tokens',
    'stats.providers': 'fournisseurs d\'API pris en charge',
    'stats.discount': '% de remise maximale sur l\'Exchange',

    // Pricing
    'pricing.sectionTitle': 'Tarifs',
    'pricing.heading': 'Des forfaits simples et transparents',
    'pricing.trialNote': 'Chaque forfait inclut un <strong>essai gratuit de 30 jours</strong>. Aucun prélèvement avant la fin de l\'essai.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '4,99 $/mois',
    'pricing.proDesc': 'Pour les développeurs qui utilisent des agents au quotidien. Prompts illimités, surveillance multi-sessions.',
    'pricing.proTrial': 'Essai gratuit de 30 jours — annulation à tout moment',
    'pricing.proF1': 'Optimisations illimitées',
    'pricing.proF2': '3 sessions connectées',
    'pricing.proF3': '2 appareils',
    'pricing.proF4': 'Les 3 modes d\'optimisation',
    'pricing.proF5': 'Surveillance des agents + détection des doublons',
    'pricing.proF6': 'Remplacement automatique et mode envoi',
    'pricing.proF7': 'Génération de règles CLAUDE.md',
    'pricing.startTrial': 'Démarrer l\'essai gratuit',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '99 $/mois',
    'pricing.premiumDesc': 'Pour les équipes et les utilisateurs avancés. Tout en illimité, support prioritaire.',
    'pricing.premiumF2': 'Sessions connectées illimitées',
    'pricing.premiumF3': 'Appareils illimités',
    'pricing.premiumF5': 'Analytique complète des agents + génération de règles',
    'pricing.premiumF7': 'Support prioritaire',

    // FAQ
    'faq.sectionTitle': 'FAQ',
    'faq.heading': 'Questions fréquentes',
    'faq.subtitle': 'Tout ce que vous devez savoir sur l\'optimisation de tokens et comment Terse vous fait économiser.',
    'faq.q1': 'Qu\'est-ce que l\'optimisation de tokens ?',
    'faq.a1': 'L\'optimisation de tokens réduit le nombre de tokens dans les prompts IA sans perte de sens. Terse utilise plus de 20 techniques pour réduire la consommation de 40 à 70 %, diminuant directement les coûts d\'API IA.',
    'faq.q2': 'Combien Terse permet-il d\'économiser ?',
    'faq.a2': '40 à 70 % sur les prompts verbeux, jusqu\'à 89 % sur les sorties CLI. Une session typique de 2 h passe d\'environ 210K à environ 23K tokens.',
    'faq.q3': 'Quels outils IA sont compatibles avec Terse ?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider et tout agent IA en terminal. Également les outils navigateur via l\'API d\'accessibilité de macOS.',
    'faq.q4': 'Comment fonctionne la compression de prompts ?',
    'faq.a4': 'Pipeline en 7 étapes : correction orthographique, normalisation des espaces, optimisation de motifs, élimination des redondances, analyse NLP, compression télégraphique et nettoyage.',
    'faq.q5': 'La qualité des réponses est-elle affectée ?',
    'faq.a5': 'Non. L\'outil supprime le bruit — remplissage, hésitations, fautes de frappe — sans altérer l\'intention. Les recherches montrent que les prompts compressés maintiennent ou améliorent la qualité.',
    'faq.q6': 'Quelle différence avec l\'ingénierie de prompts ?',
    'faq.a6': 'L\'ingénierie de prompts consiste à rédiger de meilleures instructions. L\'optimisation de tokens réduit les coûts en éliminant le superflu. Terse gère l\'optimisation automatiquement.',
    'faq.q7': 'Terse est-il gratuit ?',
    'faq.a7': 'Les deux forfaits incluent un essai gratuit de 30 jours. Pro à 4,99 $/mois, Premium à 99 $/mois. Annulation à tout moment.',
    'faq.q8': 'Comment les tokens influencent-ils le coût ?',
    'faq.a8': 'Les modèles IA facturent au token (~4 caractères). Une seule session d\'agent peut consommer plus de 200K tokens, soit 3 à 15 $.',
    'faq.q9': 'Qu\'est-ce que le Token Exchange ?',
    'faq.a9': 'Une place de marché pour échanger des tokens d\'API IA inutilisés. Les vendeurs proposent leurs clés à prix réduit, les acheteurs bénéficient d\'un accès moins cher.',
    'faq.q10': 'Comment acheter ou vendre des tokens ?',
    'faq.a10': 'Connectez-vous sur terseai.org/marketplace. Pour vendre : collez votre clé, définissez la remise. Pour acheter : rechargez, générez une clé API.',

    // CTA
    'cta.heading': 'Cessez de gaspiller des tokens et de l\'argent.',
    'cta.subtitle': 'Optimisez chaque prompt. Surveillez chaque session. Échangez vos tokens inutilisés — achetez à 50 % de remise ou vendez vos crédits inactifs.',
    'cta.onDevice': '100 % sur l\'appareil',
    'cta.zeroLatency': 'Zéro latence',

    // Footer
    'footer.tagline': 'Optimiseur de tokens + place de marché. Compressez les prompts, surveillez les agents, détectez les doublons — échangez vos tokens API inutilisés.',
    'footer.product': 'Produit',
    'footer.techniques': 'Techniques',
    'footer.learn': 'En savoir plus',
    'footer.download': 'Télécharger',
    'footer.spellCorrection': 'Correction orthographique',
    'footer.patternOpt': 'Optimisation de motifs',
    'footer.nlpAnalysis': 'Analyse NLP',
    'footer.telegraphComp': 'Compression télégraphique',
    'footer.whatIsTokenOpt': 'Qu\'est-ce que l\'optimisation de tokens ?',
    'footer.reduceApiCosts': 'Comment réduire les coûts d\'API IA',
    'footer.pricingComparison': 'Comparaison des tarifs de tokens IA',
    'footer.copyright': '\u00a9 2026 Terse',

    // Payment
    'payment.heading': 'Choisissez votre mode de paiement',
    'payment.subtitle': 'Sélectionnez votre mode de paiement après l\'essai gratuit de 30 jours :',
    'payment.card': 'Carte / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB, etc.',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'Facture envoyée à chaque cycle de facturation',
    'payment.trialNote': 'Aucun prélèvement pendant l\'essai de 30 jours. Annulation à tout moment.',
    'payment.startBtn': 'Démarrer l\'essai gratuit'
  };

  T.de = {
    // Nav
    'nav.howItWorks': 'So funktioniert es',
    'nav.pipeline': 'Pipeline',
    'nav.agentMonitor': 'Agent-Monitor',
    'nav.benchmarks': 'Benchmarks',
    'nav.pricing': 'Preise',
    'nav.tokenExchange': 'Token-Börse',
    'nav.faq': 'FAQ',
    'nav.signIn': 'Anmelden',
    'nav.signOut': 'Abmelden',

    // Hero
    'hero.title1': 'Jeden Token sparen.',
    'hero.title2': 'Den Rest handeln.',
    'hero.subtitle': 'Reduzieren Sie 40–70 % Ihrer AI-Token-Kosten durch On-Device-Optimierung — oder kaufen Sie Token auf der Token-Börse mit bis zu 50 % Rabatt. Verkaufen Sie, was Sie nicht nutzen. Verschwenden Sie kein Geld mehr für ungenutzte API-Guthaben.',
    'hero.download': 'Optimierer herunterladen',
    'hero.exchange': 'Token kaufen / verkaufen',
    'hero.installNote': 'Ziehen Sie Terse nach der Installation in den <strong>Programme</strong>-Ordner und fügen Sie dann Folgendes im <strong>Terminal</strong> ein:',
    'hero.installWarning': 'macOS blockiert nicht signierte Apps standardmäßig — dieser Befehl hebt die Sperre auf. Nur einmal nach der Installation nötig.',

    // Features
    'features.bench1': 'Getestet mit manuellen Prompts, Agent-Durchläufen und Tool-Aufrufen',
    'features.bench2': 'Saubere Prompts geben korrekt 0 % zurück — keine falschen Änderungen',
    'features.bench3': 'Einsparungen summieren sich: 5 Agent-Durchläufe sparen 200–400+ Token',
    'features.sectionTitle': 'An echten Sitzungen getestet.',
    'features.description': 'Getestet mit echten ChatGPT-Prompts, Claude-Code-Agent-Sitzungen und mehrstufigen Agent-Workflows. Saubere technische Prompts bleiben unverändert. Ausführliche Prompts und Agent-Nachrichten werden um 40–70 % reduziert.',

    // Pipeline
    'pipeline.sectionTitle': 'Sehen Sie den Unterschied',
    'pipeline.subtitle': 'Echte Ausgaben, echte Einsparungen.',
    'pipeline.description': 'Direkter Vergleich an tatsächlichen Prompts und Agent-Befehlen.',

    // Benchmarks
    'benchmarks.sectionTitle': 'Benchmarks',
    'benchmarks.heading': 'An echten Sitzungen getestet.',

    // Usage
    'usage.heading': 'Kein AI-Tool bietet unbegrenzte Nutzung.',
    'usage.subtitle': 'Selbst bei $200/Monat hat jedes Tool Limits. Terse komprimiert Prompts, damit Ihr Kontingent länger reicht — und auf der Token-Börse kaufen Sie zusätzliche Kapazität mit bis zu 50 % Rabatt oder verkaufen ungenutztes Guthaben.',
    'usage.calloutTitle': 'Eine typische 2-Stunden-Coding-Session mit einem AI-Agent:',
    'usage.stat1': 'CLI-Befehle ausgeführt',
    'usage.stat2': 'Token an Prompt- + CLI-Rauschen',
    'usage.stat3': 'mit Terse (89 % weniger)',

    // Tools
    'tools.sectionTitle': 'Jedes Tool hat Grenzen',
    'tools.heading': 'Terse holt mehr aus jedem Tarif heraus.',
    'tools.description': 'Egal welches AI-Tool Sie nutzen — Token-Limits und Ratenbegrenzungen gelten überall. Terse komprimiert die Eingabe — und die Token-Börse ermöglicht den Kauf zusätzlicher Token zu einem Bruchteil des regulären Preises.',
    'tools.price': 'Preis',
    'tools.limits': 'Limits',
    'tools.context': 'Kontext',

    // Testimonials
    'testimonials.heading': '…und von Entwicklern geschätzt',
    'testimonials.subtitle': 'Ingenieure und AI-Power-User senken Kosten und behalten ihren Token-Verbrauch im Blick.',

    // Stats
    'stats.heading': 'Auf Forschung aufgebaut.',
    'stats.subtitle': 'Basierend auf LLMLingua, Norvig-Rechtschreibkorrektur, selektiver Kontext-Bereinigung und Analyse realer Agent-Sitzungen.',
    'stats.strategies': 'Optimierungsstrategien',
    'stats.techniques': 'Token-Reduktionstechniken',
    'stats.providers': 'unterstützte API-Anbieter',
    'stats.discount': ' % max. Rabatt auf der Börse',

    // Pricing
    'pricing.sectionTitle': 'Preise',
    'pricing.heading': 'Einfache, transparente Tarife',
    'pricing.trialNote': 'Jeder Tarif beinhaltet eine <strong>30-tägige kostenlose Testphase</strong>. Keine Gebühren bis zum Ende der Testphase.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4,99/Monat',
    'pricing.proDesc': 'Für Entwickler, die täglich Agent-Sitzungen nutzen. Unbegrenzte Prompts, Multi-Session-Monitoring.',
    'pricing.proTrial': '30 Tage kostenlos testen — jederzeit kündbar',
    'pricing.proF1': 'Unbegrenzte Optimierungen',
    'pricing.proF2': '3 verbundene Sitzungen',
    'pricing.proF3': '2 Geräte',
    'pricing.proF4': 'Alle 3 Optimierungsmodi',
    'pricing.proF5': 'Agent-Monitoring + Duplikaterkennung',
    'pricing.proF6': 'Auto-Ersetzung & Sendemodus',
    'pricing.proF7': 'CLAUDE.md-Regelgenerierung',
    'pricing.startTrial': 'Kostenlos testen',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/Monat',
    'pricing.premiumDesc': 'Für Teams und Power-User. Alles unbegrenzt, Prioritäts-Support.',
    'pricing.premiumF2': 'Unbegrenzte verbundene Sitzungen',
    'pricing.premiumF3': 'Unbegrenzte Geräte',
    'pricing.premiumF5': 'Vollständige Agent-Analytik + Regelgenerierung',
    'pricing.premiumF7': 'Prioritäts-Support',

    // FAQ
    'faq.sectionTitle': 'FAQ',
    'faq.heading': 'Häufig gestellte Fragen',
    'faq.subtitle': 'Alles, was Sie über Token-Optimierung wissen müssen und wie Terse Ihnen Geld spart.',
    'faq.q1': 'Was ist Token-Optimierung?',
    'faq.a1': 'Token-Optimierung reduziert Token in AI-Prompts, ohne die Bedeutung zu verändern. Terse nutzt über 20 Techniken, um den Verbrauch um 40–70 % zu senken und so direkt AI-API-Kosten zu reduzieren.',
    'faq.q2': 'Wie viel kann Terse einsparen?',
    'faq.a2': '40–70 % bei ausführlichen Prompts, bis zu 89 % bei CLI-Ausgaben. Eine typische 2-Stunden-Sitzung sinkt von ca. 210.000 auf ca. 23.000 Token.',
    'faq.q3': 'Welche AI-Tools funktionieren mit Terse?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider und jeder Terminal-AI-Agent. Auch Browser-Tools über die macOS-Bedienungshilfen-API.',
    'faq.q4': 'Wie funktioniert Prompt-Komprimierung?',
    'faq.a4': '7-stufige Pipeline: Rechtschreibkorrektur, Leerzeichen-Normalisierung, Musteroptimierung, Redundanzbeseitigung, NLP-Analyse, Telegramm-Komprimierung und Bereinigung.',
    'faq.q5': 'Leidet die Ausgabequalität darunter?',
    'faq.a5': 'Nein. Es wird nur Rauschen entfernt — Füllwörter, Abschwächungen, Tippfehler — ohne die Absicht zu ändern. Studien zeigen, dass komprimierte Prompts die Qualität beibehalten oder sogar verbessern.',
    'faq.q6': 'Unterschied zu Prompt-Engineering?',
    'faq.a6': 'Prompt-Engineering erstellt bessere Anweisungen. Token-Optimierung senkt Kosten durch Entfernung von Überflüssigem. Terse übernimmt die Optimierung automatisch.',
    'faq.q7': 'Ist Terse kostenlos?',
    'faq.a7': 'Beide Tarife beinhalten eine 30-tägige kostenlose Testphase. Pro $4,99/Monat, Premium $99/Monat. Jederzeit kündbar.',
    'faq.q8': 'Wie beeinflussen Token die Kosten?',
    'faq.a8': 'AI-Modelle berechnen pro Token (~4 Zeichen). Eine einzelne Agent-Sitzung kann über 200.000 Token verbrauchen und $3–$15 kosten.',
    'faq.q9': 'Was ist die Token-Börse?',
    'faq.a9': 'Ein Marktplatz zum Handeln ungenutzter AI-API-Token. Verkäufer bieten ihre Schlüssel vergünstigt an, Käufer erhalten günstigeren Zugang.',
    'faq.q10': 'Wie kaufe oder verkaufe ich Token?',
    'faq.a10': 'Melden Sie sich unter terseai.org/marketplace an. Verkaufen: Schlüssel einfügen, Rabatt festlegen. Kaufen: Guthaben aufladen, API-Schlüssel generieren.',

    // CTA
    'cta.heading': 'Verschwenden Sie keine Token und kein Geld mehr.',
    'cta.subtitle': 'Jeden Prompt optimieren. Jede Sitzung überwachen. Ungenutzte Token handeln — mit 50 % Rabatt kaufen oder ungenutztes Guthaben verkaufen.',
    'cta.onDevice': '100 % lokal auf dem Gerät',
    'cta.zeroLatency': 'Keine Latenz',

    // Footer
    'footer.tagline': 'Token-Optimierer + Marktplatz. Prompts komprimieren, Agents überwachen, Duplikate erkennen — ungenutzte API-Token handeln.',
    'footer.product': 'Produkt',
    'footer.techniques': 'Techniken',
    'footer.learn': 'Wissen',
    'footer.download': 'Download',
    'footer.spellCorrection': 'Rechtschreibkorrektur',
    'footer.patternOpt': 'Musteroptimierung',
    'footer.nlpAnalysis': 'NLP-Analyse',
    'footer.telegraphComp': 'Telegramm-Komprimierung',
    'footer.whatIsTokenOpt': 'Was ist Token-Optimierung?',
    'footer.reduceApiCosts': 'So senken Sie AI-API-Kosten',
    'footer.pricingComparison': 'AI-Token-Preisvergleich',
    'footer.copyright': '© 2026 Terse',

    // Payment
    'payment.heading': 'Zahlungsmethode wählen',
    'payment.subtitle': 'Wählen Sie, wie Sie nach der 30-tägigen Testphase zahlen möchten:',
    'payment.card': 'Karte / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB usw.',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'Rechnung pro Abrechnungszeitraum',
    'payment.trialNote': 'Keine Gebühren während der 30-tägigen Testphase. Jederzeit kündbar.',
    'payment.startBtn': 'Kostenlos testen'
  };

  T.ar = {
    // Nav
    'nav.howItWorks': 'كيف يعمل',
    'nav.pipeline': 'خط المعالجة',
    'nav.agentMonitor': 'مراقبة الوكيل',
    'nav.benchmarks': 'اختبارات الأداء',
    'nav.pricing': 'الأسعار',
    'nav.tokenExchange': 'بورصة التوكنات',
    'nav.faq': 'الأسئلة الشائعة',
    'nav.signIn': 'تسجيل الدخول',
    'nav.signOut': 'تسجيل الخروج',

    // Hero
    'hero.title1': 'وفّر كل توكن.',
    'hero.title2': 'تاجر بالباقي.',
    'hero.subtitle': 'خفّض 40–70% من تكاليف توكنات الذكاء الاصطناعي عبر التحسين المحلي على الجهاز — أو اشترِ توكنات بخصم يصل إلى 50% عبر بورصة التوكنات. بِع ما لا تستخدمه. توقف عن إهدار المال على أرصدة API غير مستخدمة.',
    'hero.download': 'تنزيل المُحسّن',
    'hero.exchange': 'شراء / بيع التوكنات',
    'hero.installNote': 'بعد التثبيت، اسحب Terse إلى مجلد <strong>التطبيقات</strong>، ثم الصق هذا الأمر في <strong>الطرفية</strong>:',
    'hero.installWarning': 'يحظر macOS التطبيقات غير الموقّعة افتراضيًا — هذا الأمر يرفع الحظر. مطلوب مرة واحدة فقط بعد التثبيت.',

    // Features
    'features.bench1': 'اختبارات شاملة على الأوامر اليدوية وجلسات الوكيل واستدعاءات الأدوات',
    'features.bench2': 'الأوامر النظيفة تعيد 0% بشكل صحيح — بدون تغييرات خاطئة',
    'features.bench3': 'التوفير يتراكم: 5 جلسات وكيل توفر 200–400+ توكن',
    'features.sectionTitle': 'مُختبر على جلسات حقيقية.',
    'features.description': 'مُختبر على أوامر ChatGPT حقيقية وجلسات وكيل Claude Code وسير عمل متعددة المراحل. الأوامر التقنية النظيفة تمر كما هي. الأوامر المطوّلة ورسائل الوكيل تُخفّض بنسبة 40–70%.',

    // Pipeline
    'pipeline.sectionTitle': 'شاهد الفرق',
    'pipeline.subtitle': 'مخرجات حقيقية، توفير حقيقي.',
    'pipeline.description': 'مقارنة جنبًا إلى جنب على أوامر وأوامر وكيل فعلية.',

    // Benchmarks
    'benchmarks.sectionTitle': 'اختبارات الأداء',
    'benchmarks.heading': 'مُختبر على جلسات حقيقية.',

    // Usage
    'usage.heading': 'لا توجد أداة ذكاء اصطناعي توفر استخدامًا غير محدود.',
    'usage.subtitle': 'حتى بسعر $200/شهريًا، كل أداة لها حدود. Terse يضغط الأوامر لتمديد حدودك — وبورصة التوكنات تتيح لك شراء سعة إضافية بخصم يصل إلى 50%، أو بيع الرصيد غير المستخدم.',
    'usage.calloutTitle': 'جلسة برمجة نموذجية لمدة ساعتين مع وكيل ذكاء اصطناعي:',
    'usage.stat1': 'أمر CLI مُنفّذ',
    'usage.stat2': 'توكن من الأوامر + ضوضاء CLI',
    'usage.stat3': 'مع Terse (أقل بـ 89%)',

    // Tools
    'tools.sectionTitle': 'كل أداة لها حدود',
    'tools.heading': 'Terse يمدّد كل خطة إلى أبعد.',
    'tools.description': 'مهما كانت أداة الذكاء الاصطناعي التي تستخدمها، حدود التوكنات والمعدلات تنطبق دائمًا. Terse يضغط المدخلات — وبورصة التوكنات تتيح لك شراء توكنات إضافية بجزء من السعر العادي.',
    'tools.price': 'السعر',
    'tools.limits': 'الحدود',
    'tools.context': 'السياق',

    // Testimonials
    'testimonials.heading': '...ومحبوب من المطورين',
    'testimonials.subtitle': 'مهندسون ومستخدمون محترفون للذكاء الاصطناعي يخفّضون التكاليف ويراقبون استهلاك التوكنات.',

    // Stats
    'stats.heading': 'مبني على البحث العلمي.',
    'stats.subtitle': 'مبني على LLMLingua وتصحيح Norvig الإملائي والتقليم الانتقائي للسياق وتحليل جلسات الوكيل الفعلية.',
    'stats.strategies': 'استراتيجية تحسين',
    'stats.techniques': 'تقنية لتقليل التوكنات',
    'stats.providers': 'مزود API مدعوم',
    'stats.discount': '% خصم أقصى على البورصة',

    // Pricing
    'pricing.sectionTitle': 'الأسعار',
    'pricing.heading': 'خطط بسيطة وشفافة',
    'pricing.trialNote': 'جميع الخطط تشمل <strong>فترة تجريبية مجانية لمدة 30 يومًا</strong>. لن يتم خصم أي مبلغ حتى انتهاء الفترة التجريبية.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4.99/شهريًا',
    'pricing.proDesc': 'للمطورين الذين يستخدمون جلسات الوكيل يوميًا. أوامر غير محدودة، مراقبة متعددة الجلسات.',
    'pricing.proTrial': 'تجربة مجانية لمدة 30 يومًا — إلغاء في أي وقت',
    'pricing.proF1': 'تحسينات غير محدودة',
    'pricing.proF2': '3 جلسات متصلة',
    'pricing.proF3': 'جهازان',
    'pricing.proF4': 'جميع أوضاع التحسين الثلاثة',
    'pricing.proF5': 'مراقبة الوكيل + كشف التكرار',
    'pricing.proF6': 'الاستبدال التلقائي ووضع الإرسال',
    'pricing.proF7': 'توليد قواعد CLAUDE.md',
    'pricing.startTrial': 'ابدأ التجربة المجانية',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/شهريًا',
    'pricing.premiumDesc': 'للفرق والمستخدمين المحترفين. كل شيء غير محدود، دعم بأولوية.',
    'pricing.premiumF2': 'جلسات متصلة غير محدودة',
    'pricing.premiumF3': 'أجهزة غير محدودة',
    'pricing.premiumF5': 'تحليلات وكيل كاملة + توليد القواعد',
    'pricing.premiumF7': 'دعم بأولوية',

    // FAQ
    'faq.sectionTitle': 'الأسئلة الشائعة',
    'faq.heading': 'الأسئلة المتكررة',
    'faq.subtitle': 'كل ما تحتاج معرفته حول تحسين التوكنات وكيف يوفر لك Terse المال.',
    'faq.q1': 'ما هو تحسين التوكنات؟',
    'faq.a1': 'تحسين التوكنات يقلل عدد التوكنات في أوامر الذكاء الاصطناعي دون فقدان المعنى. يستخدم Terse أكثر من 20 تقنية لتقليل الاستهلاك بنسبة 40–70%، مما يخفّض تكاليف API مباشرة.',
    'faq.q2': 'كم يمكن أن يوفر Terse؟',
    'faq.a2': '40–70% على الأوامر المطوّلة، وحتى 89% على مخرجات CLI. جلسة نموذجية لمدة ساعتين تنخفض من نحو 210 ألف إلى نحو 23 ألف توكن.',
    'faq.q3': 'ما هي أدوات الذكاء الاصطناعي المتوافقة مع Terse؟',
    'faq.a3': 'Claude Code وCursor وOpenClaw وAider وأي وكيل ذكاء اصطناعي في الطرفية. وكذلك أدوات المتصفح عبر واجهة macOS Accessibility API.',
    'faq.q4': 'كيف يعمل ضغط الأوامر؟',
    'faq.a4': 'خط معالجة من 7 مراحل: تصحيح إملائي، تطبيع المسافات، تحسين الأنماط، إزالة التكرار، تحليل NLP، ضغط بأسلوب البرقيات، والتنظيف.',
    'faq.q5': 'هل يؤثر على جودة المخرجات؟',
    'faq.a5': 'لا. يُزيل الضوضاء فقط — كلمات الحشو والتردد والأخطاء الإملائية — دون تغيير المعنى. تُظهر الأبحاث أن الأوامر المضغوطة تحافظ على الجودة أو تُحسّنها.',
    'faq.q6': 'ما الفرق بينه وبين هندسة الأوامر؟',
    'faq.a6': 'هندسة الأوامر تصيغ تعليمات أفضل. تحسين التوكنات يخفّض التكلفة بإزالة الزوائد. Terse يتولى التحسين تلقائيًا.',
    'faq.q7': 'هل Terse مجاني؟',
    'faq.a7': 'كلتا الخطتين تشملان تجربة مجانية لمدة 30 يومًا. Pro بـ $4.99/شهريًا، Premium بـ $99/شهريًا. إلغاء في أي وقت.',
    'faq.q8': 'كيف تؤثر التوكنات على التكلفة؟',
    'faq.a8': 'نماذج الذكاء الاصطناعي تُحاسب بالتوكن (نحو 4 أحرف لكل توكن). جلسة وكيل واحدة قد تستهلك أكثر من 200 ألف توكن، بتكلفة $3–$15.',
    'faq.q9': 'ما هي بورصة التوكنات؟',
    'faq.a9': 'سوق لتداول توكنات API غير المستخدمة. البائعون يعرضون مفاتيحهم بخصم، والمشترون يحصلون على وصول أرخص.',
    'faq.q10': 'كيف أشتري أو أبيع التوكنات؟',
    'faq.a10': 'سجّل الدخول عبر terseai.org/marketplace. للبيع: الصق المفتاح، حدّد الخصم. للشراء: اشحن الرصيد، أنشئ مفتاح API.',

    // CTA
    'cta.heading': 'توقف عن إهدار التوكنات والمال.',
    'cta.subtitle': 'حسّن كل أمر. راقب كل جلسة. تاجر بالتوكنات غير المستخدمة — اشترِ بخصم 50% أو بِع الرصيد الفائض.',
    'cta.onDevice': '100% على الجهاز',
    'cta.zeroLatency': 'بدون تأخير',

    // Footer
    'footer.tagline': 'مُحسّن توكنات + سوق. اضغط الأوامر، راقب الوكلاء، اكشف التكرار — تاجر بتوكنات API غير المستخدمة.',
    'footer.product': 'المنتج',
    'footer.techniques': 'التقنيات',
    'footer.learn': 'تعلّم',
    'footer.download': 'تنزيل',
    'footer.spellCorrection': 'تصحيح إملائي',
    'footer.patternOpt': 'تحسين الأنماط',
    'footer.nlpAnalysis': 'تحليل NLP',
    'footer.telegraphComp': 'ضغط بأسلوب البرقيات',
    'footer.whatIsTokenOpt': 'ما هو تحسين التوكنات؟',
    'footer.reduceApiCosts': 'كيف تخفّض تكاليف AI API',
    'footer.pricingComparison': 'مقارنة أسعار توكنات الذكاء الاصطناعي',
    'footer.copyright': '© 2026 Terse',

    // Payment
    'payment.heading': 'اختيار طريقة الدفع',
    'payment.subtitle': 'اختر طريقة الدفع بعد انتهاء التجربة المجانية (30 يومًا):',
    'payment.card': 'بطاقة / Link',
    'payment.cardDesc': 'Visa، Mastercard، JCB وغيرها',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'فاتورة لكل دورة فوترة',
    'payment.trialNote': 'لا رسوم خلال التجربة المجانية (30 يومًا). إلغاء في أي وقت.',
    'payment.startBtn': 'ابدأ التجربة المجانية'
  };

  T.it = {
    // Nav
    'nav.howItWorks': 'Come funziona',
    'nav.pipeline': 'Pipeline',
    'nav.agentMonitor': 'Monitor agente',
    'nav.benchmarks': 'Benchmark',
    'nav.pricing': 'Prezzi',
    'nav.tokenExchange': 'Borsa Token',
    'nav.faq': 'FAQ',
    'nav.signIn': 'Accedi',
    'nav.signOut': 'Esci',

    // Hero
    'hero.title1': 'Risparmia ogni token.',
    'hero.title2': 'Scambia il resto.',
    'hero.subtitle': 'Riduca del 40-70% i costi dei token AI con l\'ottimizzazione on-device — oppure acquisti token con sconti fino al 50% sulla Borsa Token. Venda ciò che non usa. Smetta di sprecare soldi in crediti API inutilizzati.',
    'hero.download': 'Scarica l\'ottimizzatore',
    'hero.exchange': 'Compra / Vendi Token',
    'hero.installNote': 'Dopo l\'installazione, trascini Terse nella cartella <strong>Applicazioni</strong>, poi incolli questo comando nel <strong>Terminale</strong>:',
    'hero.installWarning': 'macOS blocca le app non firmate per impostazione predefinita — questo comando rimuove il blocco. Necessario solo una volta dopo l\'installazione.',

    // Features
    'features.bench1': 'Testato su prompt manuali, turni di agente e chiamate a strumenti',
    'features.bench2': 'I prompt puliti restituiscono correttamente 0% — nessuna modifica errata',
    'features.bench3': 'Il risparmio si accumula: 5 turni di agente risparmiano 200-400+ token',
    'features.sectionTitle': 'Testato su sessioni reali.',
    'features.description': 'Testato su prompt reali di ChatGPT, sessioni agente di Claude Code e workflow multi-turno. I prompt tecnici puliti passano invariati. I prompt prolissi e i messaggi degli agenti si riducono del 40-70%.',

    // Pipeline
    'pipeline.sectionTitle': 'Veda la differenza',
    'pipeline.subtitle': 'Risultati reali, risparmi reali.',
    'pipeline.description': 'Confronto diretto su prompt e comandi agente reali.',

    // Benchmarks
    'benchmarks.sectionTitle': 'Benchmark',
    'benchmarks.heading': 'Testato su sessioni reali.',

    // Usage
    'usage.heading': 'Nessuno strumento AI offre un utilizzo illimitato.',
    'usage.subtitle': 'Anche a $200/mese, ogni strumento ha dei limiti. Terse comprime i prompt per far durare di più le quote — e la Borsa Token consente di acquistare capacità extra con sconti fino al 50%, o di vendere il credito inutilizzato.',
    'usage.calloutTitle': 'Una tipica sessione di coding di 2 ore con un agente AI:',
    'usage.stat1': 'comandi CLI eseguiti',
    'usage.stat2': 'token di prompt + rumore CLI',
    'usage.stat3': 'con Terse (89% in meno)',

    // Tools
    'tools.sectionTitle': 'Ogni strumento ha dei limiti',
    'tools.heading': 'Terse fa rendere di più ogni piano.',
    'tools.description': 'Qualunque strumento AI si utilizzi, i limiti di token e le restrizioni di frequenza si applicano sempre. Terse comprime gli input — e la Borsa Token consente di acquistare token aggiuntivi a una frazione del prezzo di listino.',
    'tools.price': 'Prezzo',
    'tools.limits': 'Limiti',
    'tools.context': 'Contesto',

    // Testimonials
    'testimonials.heading': '...e amato dagli sviluppatori',
    'testimonials.subtitle': 'Ingegneri e power user AI che riducono i costi e monitorano il consumo di token.',

    // Stats
    'stats.heading': 'Basato sulla ricerca.',
    'stats.subtitle': 'Fondato su LLMLingua, correzione ortografica Norvig, potatura selettiva del contesto e analisi di sessioni agente reali.',
    'stats.strategies': 'Strategie di ottimizzazione',
    'stats.techniques': 'Tecniche di riduzione token',
    'stats.providers': 'Provider API supportati',
    'stats.discount': '% sconto massimo sulla Borsa',

    // Pricing
    'pricing.sectionTitle': 'Prezzi',
    'pricing.heading': 'Piani semplici e trasparenti',
    'pricing.trialNote': 'Ogni piano include una <strong>prova gratuita di 30 giorni</strong>. Nessun addebito fino al termine della prova.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': '$4,99/mese',
    'pricing.proDesc': 'Per sviluppatori che usano sessioni agente ogni giorno. Prompt illimitati, monitoraggio multi-sessione.',
    'pricing.proTrial': 'Prova gratuita di 30 giorni — cancellazione in qualsiasi momento',
    'pricing.proF1': 'Ottimizzazioni illimitate',
    'pricing.proF2': '3 sessioni connesse',
    'pricing.proF3': '2 dispositivi',
    'pricing.proF4': 'Tutte e 3 le modalità di ottimizzazione',
    'pricing.proF5': 'Monitoraggio agente + rilevamento duplicati',
    'pricing.proF6': 'Sostituzione automatica e modalità invio',
    'pricing.proF7': 'Generazione regole CLAUDE.md',
    'pricing.startTrial': 'Inizia la prova gratuita',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': '$99/mese',
    'pricing.premiumDesc': 'Per team e power user. Tutto illimitato, supporto prioritario.',
    'pricing.premiumF2': 'Sessioni connesse illimitate',
    'pricing.premiumF3': 'Dispositivi illimitati',
    'pricing.premiumF5': 'Analisi agente completa + generazione regole',
    'pricing.premiumF7': 'Supporto prioritario',

    // FAQ
    'faq.sectionTitle': 'FAQ',
    'faq.heading': 'Domande frequenti',
    'faq.subtitle': 'Tutto ciò che serve sapere sull\'ottimizzazione dei token e su come Terse fa risparmiare.',
    'faq.q1': 'Cos\'è l\'ottimizzazione dei token?',
    'faq.a1': 'L\'ottimizzazione dei token riduce i token nei prompt AI senza perdere il significato. Terse usa oltre 20 tecniche per ridurre il consumo del 40-70%, abbattendo direttamente i costi delle API AI.',
    'faq.q2': 'Quanto può far risparmiare Terse?',
    'faq.a2': '40-70% sui prompt prolissi, fino all\'89% sull\'output CLI. Una tipica sessione di 2 ore passa da circa 210.000 a circa 23.000 token.',
    'faq.q3': 'Quali strumenti AI funzionano con Terse?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider e qualsiasi agente AI da terminale. Anche strumenti browser tramite le API di accessibilità di macOS.',
    'faq.q4': 'Come funziona la compressione dei prompt?',
    'faq.a4': 'Pipeline a 7 fasi: correzione ortografica, normalizzazione spazi, ottimizzazione pattern, eliminazione ridondanze, analisi NLP, compressione telegrafica e pulizia.',
    'faq.q5': 'Riduce la qualità dell\'output?',
    'faq.a5': 'No. Rimuove solo il rumore — parole di riempimento, esitazioni, errori di battitura — senza alterare l\'intento. La ricerca dimostra che i prompt compressi mantengono o migliorano la qualità.',
    'faq.q6': 'Differenza rispetto al prompt engineering?',
    'faq.a6': 'Il prompt engineering crea istruzioni migliori. L\'ottimizzazione dei token riduce i costi eliminando il superfluo. Terse gestisce l\'ottimizzazione automaticamente.',
    'faq.q7': 'Terse è gratuito?',
    'faq.a7': 'Entrambi i piani includono una prova gratuita di 30 giorni. Pro $4,99/mese, Premium $99/mese. Cancellazione in qualsiasi momento.',
    'faq.q8': 'Come influiscono i token sui costi?',
    'faq.a8': 'I modelli AI addebitano per token (~4 caratteri). Una singola sessione agente può consumare oltre 200.000 token, con costi di $3-$15.',
    'faq.q9': 'Cos\'è la Borsa Token?',
    'faq.a9': 'Un marketplace per scambiare token API AI inutilizzati. I venditori offrono le proprie chiavi a sconto, i compratori ottengono accesso a prezzi ridotti.',
    'faq.q10': 'Come si comprano o vendono i token?',
    'faq.a10': 'Acceda a terseai.org/marketplace. Vendere: incolli la chiave, imposti lo sconto. Comprare: ricarichi il saldo, generi una chiave API.',

    // CTA
    'cta.heading': 'Smetta di sprecare token e denaro.',
    'cta.subtitle': 'Ottimizzi ogni prompt. Monitori ogni sessione. Scambi token inutilizzati — acquisti con il 50% di sconto o venda i crediti inutilizzati.',
    'cta.onDevice': '100% sul dispositivo',
    'cta.zeroLatency': 'Zero latenza',

    // Footer
    'footer.tagline': 'Ottimizzatore token + marketplace. Comprimi prompt, monitora agenti, rileva duplicati — scambia token API inutilizzati.',
    'footer.product': 'Prodotto',
    'footer.techniques': 'Tecniche',
    'footer.learn': 'Risorse',
    'footer.download': 'Download',
    'footer.spellCorrection': 'Correzione ortografica',
    'footer.patternOpt': 'Ottimizzazione pattern',
    'footer.nlpAnalysis': 'Analisi NLP',
    'footer.telegraphComp': 'Compressione telegrafica',
    'footer.whatIsTokenOpt': 'Cos\'è l\'ottimizzazione dei token?',
    'footer.reduceApiCosts': 'Come ridurre i costi delle API AI',
    'footer.pricingComparison': 'Confronto prezzi token AI',
    'footer.copyright': '© 2026 Terse',

    // Payment
    'payment.heading': 'Scelga il metodo di pagamento',
    'payment.subtitle': 'Selezioni come desidera pagare al termine della prova gratuita di 30 giorni:',
    'payment.card': 'Carta / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB, ecc.',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'Fattura inviata a ogni ciclo di fatturazione',
    'payment.trialNote': 'Nessun addebito durante la prova di 30 giorni. Cancellazione in qualsiasi momento.',
    'payment.startBtn': 'Inizia la prova gratuita'
  };

  T['pt-BR'] = {
    // Nav
    'nav.howItWorks': 'Como funciona',
    'nav.pipeline': 'Pipeline',
    'nav.agentMonitor': 'Monitor de agente',
    'nav.benchmarks': 'Benchmarks',
    'nav.pricing': 'Preços',
    'nav.tokenExchange': 'Bolsa de Tokens',
    'nav.faq': 'FAQ',
    'nav.signIn': 'Entrar',
    'nav.signOut': 'Sair',

    // Hero
    'hero.title1': 'Economize cada token.',
    'hero.title2': 'Negocie o restante.',
    'hero.subtitle': 'Reduza 40-70% dos custos de tokens de IA com otimização no dispositivo — ou compre tokens com até 50% de desconto na Bolsa de Tokens. Venda o que não usar. Pare de desperdiçar dinheiro com créditos de API ociosos.',
    'hero.download': 'Baixar otimizador',
    'hero.exchange': 'Comprar / Vender Tokens',
    'hero.installNote': 'Após instalar, arraste o Terse para <strong>Aplicativos</strong> e cole este comando no <strong>Terminal</strong>:',
    'hero.installWarning': 'O macOS bloqueia apps não assinados por padrão — este comando remove o bloqueio. Necessário apenas uma vez após a instalação.',

    // Features
    'features.bench1': 'Testado com prompts manuais, turnos de agente e chamadas de ferramentas',
    'features.bench2': 'Prompts limpos retornam corretamente 0% — sem alterações incorretas',
    'features.bench3': 'A economia se acumula: 5 turnos de agente economizam 200-400+ tokens',
    'features.sectionTitle': 'Testado em sessões reais.',
    'features.description': 'Testado com prompts reais do ChatGPT, sessões de agente do Claude Code e workflows multi-turno. Prompts técnicos limpos passam inalterados. Prompts prolixos e mensagens de agente têm redução de 40-70%.',

    // Pipeline
    'pipeline.sectionTitle': 'Veja a diferença',
    'pipeline.subtitle': 'Resultados reais, economia real.',
    'pipeline.description': 'Comparação lado a lado em prompts e comandos de agente reais.',

    // Benchmarks
    'benchmarks.sectionTitle': 'Benchmarks',
    'benchmarks.heading': 'Testado em sessões reais.',

    // Usage
    'usage.heading': 'Nenhuma ferramenta de IA oferece uso ilimitado.',
    'usage.subtitle': 'Mesmo a $200/mês, toda ferramenta tem limites. O Terse comprime prompts para suas cotas durarem mais — e a Bolsa de Tokens permite comprar capacidade extra com até 50% de desconto, ou vender créditos ociosos.',
    'usage.calloutTitle': 'Uma sessão típica de 2 horas de programação com um agente de IA:',
    'usage.stat1': 'comandos CLI executados',
    'usage.stat2': 'tokens de prompt + ruído de CLI',
    'usage.stat3': 'com Terse (89% a menos)',

    // Tools
    'tools.sectionTitle': 'Toda ferramenta tem limites',
    'tools.heading': 'O Terse faz cada plano render mais.',
    'tools.description': 'Independentemente da ferramenta de IA que você usa, limites de tokens e de taxa sempre se aplicam. O Terse comprime as entradas — e a Bolsa de Tokens permite comprar tokens extras por uma fração do preço.',
    'tools.price': 'Preço',
    'tools.limits': 'Limites',
    'tools.context': 'Contexto',

    // Testimonials
    'testimonials.heading': '...e adorado por desenvolvedores',
    'testimonials.subtitle': 'Engenheiros e usuários avançados de IA reduzindo custos e acompanhando o consumo de tokens.',

    // Stats
    'stats.heading': 'Construído com base em pesquisa.',
    'stats.subtitle': 'Fundamentado em LLMLingua, correção ortográfica Norvig, poda seletiva de contexto e análise de sessões reais de agente.',
    'stats.strategies': 'Estratégias de otimização',
    'stats.techniques': 'Técnicas de redução de tokens',
    'stats.providers': 'Provedores de API suportados',
    'stats.discount': '% de desconto máximo na Bolsa',

    // Pricing
    'pricing.sectionTitle': 'Preços',
    'pricing.heading': 'Planos simples e transparentes',
    'pricing.trialNote': 'Todos os planos incluem <strong>30 dias de teste grátis</strong>. Sem cobrança até o fim do período de teste.',
    'pricing.pro': 'Pro',
    'pricing.proPrice': 'US$ 4,99/mês',
    'pricing.proDesc': 'Para desenvolvedores que usam sessões de agente diariamente. Prompts ilimitados, monitoramento multi-sessão.',
    'pricing.proTrial': '30 dias de teste grátis — cancele quando quiser',
    'pricing.proF1': 'Otimizações ilimitadas',
    'pricing.proF2': '3 sessões conectadas',
    'pricing.proF3': '2 dispositivos',
    'pricing.proF4': 'Todos os 3 modos de otimização',
    'pricing.proF5': 'Monitoramento de agente + detecção de duplicatas',
    'pricing.proF6': 'Substituição automática e modo envio',
    'pricing.proF7': 'Geração de regras CLAUDE.md',
    'pricing.startTrial': 'Iniciar teste grátis',
    'pricing.premium': 'Premium',
    'pricing.premiumPrice': 'US$ 99/mês',
    'pricing.premiumDesc': 'Para equipes e usuários avançados. Tudo ilimitado, suporte prioritário.',
    'pricing.premiumF2': 'Sessões conectadas ilimitadas',
    'pricing.premiumF3': 'Dispositivos ilimitados',
    'pricing.premiumF5': 'Análise completa de agente + geração de regras',
    'pricing.premiumF7': 'Suporte prioritário',

    // FAQ
    'faq.sectionTitle': 'FAQ',
    'faq.heading': 'Perguntas frequentes',
    'faq.subtitle': 'Tudo o que você precisa saber sobre otimização de tokens e como o Terse economiza seu dinheiro.',
    'faq.q1': 'O que é otimização de tokens?',
    'faq.a1': 'A otimização de tokens reduz tokens em prompts de IA sem perder o significado. O Terse usa mais de 20 técnicas para reduzir o consumo em 40-70%, diminuindo diretamente os custos de API de IA.',
    'faq.q2': 'Quanto o Terse pode economizar?',
    'faq.a2': '40-70% em prompts prolixos, até 89% em saídas de CLI. Uma sessão típica de 2 horas cai de cerca de 210 mil para cerca de 23 mil tokens.',
    'faq.q3': 'Quais ferramentas de IA funcionam com o Terse?',
    'faq.a3': 'Claude Code, Cursor, OpenClaw, Aider e qualquer agente de IA no terminal. Também ferramentas de navegador via API de acessibilidade do macOS.',
    'faq.q4': 'Como funciona a compressão de prompts?',
    'faq.a4': 'Pipeline de 7 estágios: correção ortográfica, normalização de espaços, otimização de padrões, eliminação de redundâncias, análise NLP, compressão telegráfica e limpeza.',
    'faq.q5': 'Isso reduz a qualidade da saída?',
    'faq.a5': 'Não. Remove apenas o ruído — palavras de preenchimento, hesitações, erros de digitação — sem alterar a intenção. Pesquisas mostram que prompts comprimidos mantêm ou melhoram a qualidade.',
    'faq.q6': 'Qual a diferença para prompt engineering?',
    'faq.a6': 'Prompt engineering cria instruções melhores. Otimização de tokens reduz custos removendo o desnecessário. O Terse cuida da otimização automaticamente.',
    'faq.q7': 'O Terse é gratuito?',
    'faq.a7': 'Ambos os planos incluem 30 dias de teste grátis. Pro US$ 4,99/mês, Premium US$ 99/mês. Cancele quando quiser.',
    'faq.q8': 'Como os tokens afetam o custo?',
    'faq.a8': 'Modelos de IA cobram por token (~4 caracteres). Uma única sessão de agente pode consumir mais de 200 mil tokens, custando de $3 a $15.',
    'faq.q9': 'O que é a Bolsa de Tokens?',
    'faq.a9': 'Um marketplace para negociar tokens de API de IA não utilizados. Vendedores oferecem suas chaves com desconto, compradores obtêm acesso mais barato.',
    'faq.q10': 'Como comprar ou vender tokens?',
    'faq.a10': 'Faça login em terseai.org/marketplace. Vender: cole a chave, defina o desconto. Comprar: adicione saldo, gere uma chave de API.',

    // CTA
    'cta.heading': 'Pare de desperdiçar tokens e dinheiro.',
    'cta.subtitle': 'Otimize cada prompt. Monitore cada sessão. Negocie tokens não utilizados — compre com 50% de desconto ou venda créditos ociosos.',
    'cta.onDevice': '100% no dispositivo',
    'cta.zeroLatency': 'Zero latência',

    // Footer
    'footer.tagline': 'Otimizador de tokens + marketplace. Comprima prompts, monitore agentes, detecte duplicatas — negocie tokens de API não utilizados.',
    'footer.product': 'Produto',
    'footer.techniques': 'Técnicas',
    'footer.learn': 'Aprenda',
    'footer.download': 'Download',
    'footer.spellCorrection': 'Correção ortográfica',
    'footer.patternOpt': 'Otimização de padrões',
    'footer.nlpAnalysis': 'Análise NLP',
    'footer.telegraphComp': 'Compressão telegráfica',
    'footer.whatIsTokenOpt': 'O que é otimização de tokens?',
    'footer.reduceApiCosts': 'Como reduzir custos de API de IA',
    'footer.pricingComparison': 'Comparação de preços de tokens de IA',
    'footer.copyright': '© 2026 Terse',

    // Payment
    'payment.heading': 'Escolha o método de pagamento',
    'payment.subtitle': 'Selecione como deseja pagar após o período de teste grátis de 30 dias:',
    'payment.card': 'Cartão / Link',
    'payment.cardDesc': 'Visa, Mastercard, JCB, etc.',
    'payment.wechat': 'WeChat Pay',
    'payment.wechatDesc': 'Fatura enviada a cada ciclo de cobrança',
    'payment.trialNote': 'Sem cobrança durante os 30 dias de teste. Cancele quando quiser.',
    'payment.startBtn': 'Iniciar teste grátis'
  };

  const langs = [
    {code:'en',name:'English',native:'English'},
    {code:'zh-Hans',name:'Chinese (Simplified)',native:'\u7b80\u4f53\u4e2d\u6587'},
    {code:'zh-Hant',name:'Chinese (Traditional)',native:'\u7e41\u9ad4\u4e2d\u6587'},
    {code:'ja',name:'Japanese',native:'\u65e5\u672c\u8a9e'},
    {code:'ko',name:'Korean',native:'\ud55c\uad6d\uc5b4'},
    {code:'es',name:'Spanish',native:'Espa\u00f1ol'},
    {code:'fr',name:'French',native:'Fran\u00e7ais'},
    {code:'de',name:'German',native:'Deutsch'},
    {code:'ar',name:'Arabic',native:'\u0627\u0644\u0639\u0631\u0628\u064a\u0629'},
    {code:'it',name:'Italian',native:'Italiano'},
    {code:'pt-BR',name:'Portuguese (Brazil)',native:'Portugu\u00eas'}
  ];

  function detect(){
    var saved = localStorage.getItem('terse-lang');
    if(saved && T[saved]) return saved;
    var navLangs = navigator.languages || [navigator.language];
    for(var i=0; i<navLangs.length; i++){
      var l = navLangs[i].toLowerCase();
      if(l.startsWith('zh-hans') || l==='zh-cn' || l==='zh-sg') return 'zh-Hans';
      if(l.startsWith('zh-hant') || l==='zh-tw' || l==='zh-hk') return 'zh-Hant';
      if(l.startsWith('zh')) return 'zh-Hans';
      if(l.startsWith('pt-br') || l.startsWith('pt')) return 'pt-BR';
      var base = l.split('-')[0];
      if(T[base]) return base;
    }
    return 'en';
  }

  function apply(lang){
    var dict = T[lang] || T.en;
    document.querySelectorAll('[data-i18n]').forEach(function(el){
      var k = el.getAttribute('data-i18n');
      if(dict[k]) el.textContent = dict[k];
      else if(T.en[k]) el.textContent = T.en[k];
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el){
      var k = el.getAttribute('data-i18n-html');
      if(dict[k]) el.innerHTML = dict[k];
      else if(T.en[k]) el.innerHTML = T.en[k];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el){
      var k = el.getAttribute('data-i18n-placeholder');
      if(dict[k]) el.placeholder = dict[k];
      else if(T.en[k]) el.placeholder = T.en[k];
    });
    document.documentElement.lang = lang.startsWith('zh') ? lang : lang.split('-')[0];
    if(lang==='ar') document.documentElement.dir='rtl';
    else document.documentElement.removeAttribute('dir');
  }

  var currentLang = detect();

  window.i18n = {
    get lang(){ return currentLang; },
    languages: langs,
    t: function(key){ return (T[currentLang]||T.en)[key] || T.en[key] || key; },
    setLang: function(code){
      if(!T[code] && code!=='en') return;
      currentLang = code;
      localStorage.setItem('terse-lang', code);
      apply(code);
    },
    init: function(){ apply(currentLang); }
  };

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){window.i18n.init();});
  else window.i18n.init();
})();
