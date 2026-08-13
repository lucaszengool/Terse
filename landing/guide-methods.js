/**
 * guide-methods.js — Terse 到底**用什么手法**实时省 token、以及**加速**是怎么来的。
 *
 * 这一节是指南里最容易被写成空话的部分,所以每条都写成可验证的具体动作:
 *   压缩手法    —— 三档,逐条列出各档做什么
 *   缓存与上下文 —— 前缀复用、锚点、自动压缩
 *   加速        —— 更小的负载 + 自动模型路由
 *
 * 缓存安全那条尤其重要:开了之后激进档会被降到标准档 —— 激进改写会把缓存前缀
 * 打散,重建缓存比省下来的还贵。
 *
 * ⚠️ 对外文案不出现内部脚本名、配置文件路径、端口 —— 用户不需要知道接入机制,
 *    知道了反而容易自己去改坏。展示名一律用「Terse bridge」「Terse settings」这类。
 */
(function () {
  var M = {};

  M.SECTIONS = [
    {
      key: 'squeeze',
      title: { en: 'Squeezing the prompt', zh: '把 prompt 压小' },
      lede: {
        en: 'Three levels, applied to every outgoing prompt. Each level adds to the one before it — nothing is ever removed that changes meaning.',
        zh: '三个档位，作用在每一条发出去的 prompt 上。后一档在前一档基础上叠加 —— 任何会改变含义的东西都不会被删。'
      },
      items: [
        { t: { en: 'Typo repair', zh: '错字修正' },
          d: { en: 'A dictionary of real mistypes (teh, adn, thier…) fixed before the model has to guess. A misspelling costs extra tokens and can change the parse.',
               zh: '一份真实错拼词典（teh、adn、thier…）在模型开始猜之前先改掉。拼错不仅多花 token，还可能改变分词结果。' },
          lv: { en: 'all levels', zh: '全部档位' } },
        { t: { en: 'Whitespace collapse', zh: '空白压缩' },
          d: { en: 'Repeated blank lines and trailing spaces collapse. Invisible to you, billable to you.',
               zh: '重复空行和行尾空格被压掉。你看不见它们，但你在为它们付钱。' },
          lv: { en: 'all levels', zh: '全部档位' } },
        { t: { en: 'Politeness & filler', zh: '客套与冗余' },
          d: { en: '"I was wondering if you could please…" becomes the request itself. Whole standalone politeness phrases go; anything carrying intent stays.',
               zh: '「我在想你能不能帮我…」被还原成请求本身。整句客套删掉，带意图的一律保留。' },
          lv: { en: 'balanced +', zh: '标准档起' } },
        { t: { en: 'Hedge removal', zh: '去掉模糊限定' },
          d: { en: '"maybe", "kind of", "a little bit" — hedges make the model hedge back, which costs output tokens too.',
               zh: '「也许」「有点」「稍微」—— 你模糊，模型也会模糊地答，输出那边同样在烧钱。' },
          lv: { en: 'balanced +', zh: '标准档起' } },
        { t: { en: 'Phrase shortening', zh: '长句缩写' },
          d: { en: 'Wordy constructions collapse to their short form, and a phrase repeated across the prompt is compressed after its first occurrence.',
               zh: '啰嗦句式收成短形式；同一说法在 prompt 里重复出现时，第一次之后就被压缩。' },
          lv: { en: 'balanced +', zh: '标准档起' } },
        { t: { en: 'Abbreviations & markdown strip', zh: '缩写与剥 markdown' },
          d: { en: 'Known terms go to their abbreviations and decorative markdown is dropped — the model does not need your bold.',
               zh: '已知术语换成缩写，装饰性 markdown 一律去掉 —— 模型不需要你的加粗。' },
          lv: { en: 'aggressive only', zh: '仅激进档' } },
        { t: { en: 'Cache-safe guard', zh: '缓存安全兜底' },
          d: { en: 'With cache-safe on, aggressive silently drops to balanced. Rewriting too hard shatters the cached prefix, and re-priming it costs more than the rewrite saved.',
               zh: '开启缓存安全后，激进档会被自动降到标准档。改得太狠会打散已缓存的前缀，重建它比省下来的还贵。' },
          lv: { en: 'safety', zh: '安全阀' } }
      ]
    },
    {
      key: 'context',
      title: { en: 'Keeping the context small', zh: '把上下文摁住' },
      lede: {
        en: 'The prompt is only part of the bill. Most tokens go to context the agent drags along every single turn.',
        zh: 'prompt 只是账单的一部分。大头是 agent 每一轮都拖着走的那段上下文。'
      },
      items: [
        { t: { en: 'No file read twice', zh: '同一文件不重读' },
          d: { en: 'An agent that reads src/auth.ts three times pays for it three times. Terse serves the second and third read from what it already sent.',
               zh: 'agent 把 src/auth.ts 读三次就付三次钱。第二、三次由 Terse 用已经发过的内容顶回去。' },
          lv: { en: '−67% on that call', zh: '该次调用 −67%' } },
        { t: { en: 'Fold tool results', zh: '折叠工具结果' },
          d: { en: 'A 2.1k test log becomes a 180-token digest that keeps the failures and drops the noise. Search hits are folded the same way.',
               zh: '2.1k 的测试日志变成 180 token 的摘要，保留失败项、丢掉噪音。搜索结果同理。' },
          lv: { en: '2.1k → 180', zh: '2.1k → 180' } },
        { t: { en: 'Auto-compact with anchors', zh: '带锚点的自动压缩' },
          d: { en: 'When context crosses the line, Terse pins the decisions that still matter as anchors, then compacts the rest. 96k → 47k with the plan intact.',
               zh: '上下文越线时，Terse 把仍然重要的决定钉成锚点，其余压掉。96k → 47k，计划原样保留。' },
          lv: { en: '96k → 47k', zh: '96k → 47k' } },
        { t: { en: 'Prefix cache reuse', zh: '前缀缓存复用' },
          d: { en: 'The stable head of the conversation is kept byte-identical so the provider\'s cache keeps hitting. 61% hit rate means 61% of that head is billed at cache rates.',
               zh: '对话中稳定的那一段保持逐字节不变，供应商的缓存才会持续命中。61% 命中就是这段里有 61% 按缓存价结算。' },
          lv: { en: '61% hit rate', zh: '命中率 61%' } },
        { t: { en: 'Trim the tool table', zh: '削短工具表' },
          d: { en: 'Every MCP server\'s tool descriptions ride along in every turn. Dropping duplicates took one setup from 24 tools to 9 — 7.4k fewer tokens per turn, forever.',
               zh: '每个 MCP server 的工具描述每一轮都要跟着发。去掉重复项把某台机器从 24 个工具降到 9 个 —— 每轮永久少 7.4k。' },
          lv: { en: '−7.4k / turn', zh: '每轮 −7.4k' } }
      ]
    },
    {
      key: 'speed',
      title: { en: 'Where the speed comes from', zh: '快是怎么来的' },
      lede: {
        en: 'Terse works locally on your machine. Nothing leaves your laptop that would not have left anyway — it just leaves smaller, and sometimes to a cheaper model.',
        zh: 'Terse 全在你自己机器上工作。本来不会出去的东西一样不会出去 —— 只是出去得更小，有时还会换一个更便宜的模型。'
      },
      items: [
        { t: { en: 'Smaller payload, sooner first token', zh: '负载更小，首字更早' },
          d: { en: 'Time-to-first-token tracks payload size. A prompt cut from 1,284 to 796 tokens starts streaming 54% sooner — same model, same answer.',
               zh: '首字延迟跟着负载走。1,284 压到 796 之后，流式开始早 54% —— 同一个模型、同样的答案。' },
          lv: { en: 'TTFB −54%', zh: '首字 −54%' } },
        { t: { en: 'Automatic model routing', zh: '自动模型路由' },
          d: { en: 'Simple turns do not need the expensive model. Terse rewrites the target — Opus → Sonnet — when the task does not justify the price, and leaves hard turns alone.',
               zh: '简单的一轮用不着贵模型。Terse 会改写目标 —— Opus → Sonnet —— 在任务撑不起价格时；难的那些原样放行。' },
          lv: { en: 'Opus → Sonnet', zh: 'Opus → Sonnet' } },
        { t: { en: 'Streamed, not buffered', zh: '边流边算，不缓冲' },
          d: { en: 'Token accounting is read straight off the live stream, so measuring costs you nothing and the answer is never held back to be counted.',
               zh: 'token 统计边流边读，所以「测量」本身不花时间，答案也不会为了统计被扣住。' },
          lv: { en: 'stream 2.1×', zh: '流式 2.1×' } },
        { t: { en: 'No waiting on permissions', zh: '授权不再等人' },
          d: { en: 'A remembered "always allow" is answered by Terse instantly — the card never appears and the agent is never parked waiting on a decision you already made.',
               zh: '记住过的「始终允许」由 Terse 秒回 —— 卡片根本不出现，agent 也不会为了一个你早就做过的决定干等。' },
          lv: { en: '0 ms', zh: '0 毫秒' } }
      ]
    }
  ];

  window.TERSE_METHODS = M;
})();
