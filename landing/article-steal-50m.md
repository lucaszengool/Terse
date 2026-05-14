# I Built an App to Steal $50M Back from Claude Code

If you'd told me a year ago that good manners were costing me money, I'd have laughed.

I'm a developer. I use Claude Code every day — debugging, refactoring, shipping features. I trusted it. I was also paying $180 a month for it, a number I'd rationalized as the cost of being a serious AI power user.

Then I pulled three months of session logs and started counting.

---

## The 35% Problem

Roughly a third of my input tokens were going to content that provided zero signal to the model.

Phrases like:

> "Could you please help me with…"
> "If it's not too much trouble…"
> "I was wondering if you might be able to…"
> "What I'd like you to do here is just…"

I was talking to Claude like a nervous intern I didn't want to offend. Claude doesn't have feelings. It doesn't work harder because you said "please." The politeness tax is 100% yours, billed at the same rate as your actual instructions.

The math is real. Claude Sonnet 4.5 is priced at $3 per million input tokens. But that's not the number that matters. What matters is that every message in a long session re-sends the entire conversation history. Message 50 doesn't cost 200 tokens — it costs 200 tokens plus 49 previous messages. Context compounds. That 35% noise compounds with it. By turn 100 of a complex task, you're paying for a very expensive politeness habit.

This is a solvable engineering problem. So I solved it.

---

## What Terse Is, and What It's Built With

Terse is a macOS application that sits between your keyboard and your AI tools. It reads what you're typing, compresses it locally, and replaces it before you send. No servers. No third parties. Your prompts never leave your machine.

Using Rust for the backend wasn't aesthetic. The performance requirements for real-time text processing, file system watching, and process introspection made a compiled systems language the right call. The NLP optimizer runs in JavaScript (via a Node.js sidecar), but the agent monitoring, capture pipeline, and all IPC is native Rust.

---

## How Text Capture Works: The terse-ax Swift Helper

The core challenge of building a tool that reads from and writes to arbitrary third-party apps is that you need access to those apps' text fields — which are owned by other processes.

On macOS, the answer is the Accessibility API. Terse ships a compiled Swift binary called `terse-ax` alongside the main Tauri binary.

The Swift binary then does the actual AX work:

1. **Get frontmost app** — via JXA (`NSWorkspace.sharedWorkspace.frontmostApplication`), which returns the bundle ID, PID, and window title of whatever app the user is focused on
2. **Traverse the AX element tree** — starting from `AXUIElementCreateApplication(pid)`, walking the hierarchy to find `AXTextArea` or `AXTextField` elements, preferring `AXTextArea` for longer content
3. **Read via AXValue** — pulls the full text content
4. **Write via AXValue set** — pushes compressed text back; falls back to Cmd+A + programmatic paste for apps where the value attribute is read-only

---

## The Compression Pipeline: Three Stages, Three Modes

Before any compression runs, a three-stage spellcheck pipeline fires on every text:

**Stage 1 — Hardcoded domain dictionary (~600 entries)**

A hand-tuned map of high-frequency developer and prompt typos with immediate O(1) lookups. `fucntion → function`, `algortihm → algorithm`, `databse → database`, `coudl → could`. The dictionary is tech-aware: a TECH_WORDS allowlist (~100 entries: async, middleware, jwt, kubernetes, graphql, etc.) prevents the downstream stages from mangling valid technical vocabulary.

**Stage 2 — nspell/Hunspell dictionary check**

nspell wraps the same Hunspell dictionaries used by Firefox and LibreOffice. Words that pass Stage 1 uncorrected get verified here. The dictionary is pre-seeded with the TECH_WORDS allowlist.

**Stage 3 — Norvig edit-distance with QWERTY proximity weighting**

For words that still appear misspelled, a custom implementation of Peter Norvig's spelling corrector generates candidates at edit distance 1 and 2 (deletions, transpositions, replacements, insertions), filters to known words, and ranks by frequency. The Terse implementation adds a keyboard proximity weight: `teh` scores higher confidence than `zeh` as a typo of `the` because `h` is physically adjacent to `e` and `t` on a QWERTY layout, making it a structurally plausible finger-error. The algorithm also handles split-word typos via regex — `int he → in the`, `cou ld → could`.

Why does spellchecking matter for token cost? Two reasons. Typos inflate token count marginally. More importantly, typos raise the probability of a clarification round-trip — the model asks what you meant, you answer, you've now spent two extra API calls on a typo that should have been caught before send.

Language detection runs before spell correction via a two-phase strategy:

- **Phase 1:** Unicode range checks for CJK (`一–鿿`), Japanese kana (`぀–ヿ`), and Korean Hangul (`가–힯`). Fast, accurate for scripts that don't look like Latin.
- **Phase 2:** franc-min statistical language identifier for Latin-script languages, returning ISO 639-3 codes mapped to two-letter codes for downstream handling.

CJK text bypasses the English spell correction stages entirely and routes to language-appropriate stop-word compression when available.

Then code blocks are extracted and protected before any compression rules fire:

```js
const { text: textNoCode, blocks: codeBlocks } = this._protectCode(optimized);
// ... all compression runs on textNoCode ...
// ... codeBlocks restored verbatim at the end
```

Variable names, string literals, syntax — nothing inside a code fence gets touched.

---

## The Three Compression Modes

### 🟢 Soft — 5–15% reduction

Semantically lossless transforms only:

- Formal contraction: `do not → don't`, `I am → I'm`
- Verbose phrase replacement: `in order to → to`, `due to the fact that → because`, `at this point in time → now`, `has the ability to → can` (20+ patterns)
- Redundant *that* after perception verbs: `I think that you should → I think you should`
- Filler adverb strip: *just, basically, actually, literally, simply, obviously*
- Greeting removal: *Hi there,* stripped from message start
- Closing thanks removal: *Thanks in advance!* stripped from message end

### 🟡 Normal — 20–35% reduction

Everything in Soft, plus:

- Politeness wrapper removal: *Could you please, Would you mind, I was wondering if you could, If it's not too much trouble* — removed
- Meta-language strip: Sentences like *"What I want you to do is…"*, *"Let me explain what I mean…"*, *"What I'm trying to say here is…"* are removed. The instruction follows; the wrapper is noise.
- Hedging removal: *I think, I believe, I'm not sure but, It seems like* — when these precede direct instructions, they dilute the instruction without adding information
- Redundancy deduplication: If the same background context or condition appears more than once in a message, duplicates are stripped
- Stop-word compression in enumerated lists: Stop words selectively removed in bullet points and numbered lists where meaning is unambiguous from structure

### 🔴 Aggressive — 40–70% reduction

Everything in Normal, plus article and preposition stripping in structurally optional positions, markdown-to-prose conversion, and abbreviation substitution (`as soon as possible → ASAP`, `for example → e.g.`). Output reads like well-written Slack. All the information, none of the scaffolding.

---

## The Agent Monitor: Where the Real Money Is

I built Terse to compress prompts. The feature I underestimated — the one that probably drives more of the savings — is the Agent Monitor.

Here's the problem it solves.

When a Claude Code session runs long, the context window fills. As it fills, the model's behavior changes. At high context fill percentages, agents start:

- Re-reading files they've already processed
- Re-calling tools they used 20 steps ago
- Generating filler text (*"Let me now take stock of what we've accomplished…"*) that burns tokens without advancing the task
- Losing track of their state and re-exploring work they've done

This is hard to see in a terminal. Tool calls scroll by. You don't see that `Read(src/optimizer.js)` just fired for the eleventh time.

The Agent Monitor makes this visible. Here's how it works technically.

### Session File Discovery

Claude Code stores every session as a JSONL file. Terse finds the right session file by:

1. Running `lsof -c claude -a -d cwd -Fn` to get the working directory of every running claude process
2. Encoding each CWD via the same path-encoding logic Claude Code uses
3. Looking for that directory under `~/.claude/projects/`
4. Among all matching sessions, preferring the one whose CWD matches the currently focused terminal (the most recently-started Claude process by PID number)
5. Among tied candidates, selecting the most recently modified session file

This means Terse tracks the right Claude instance when you have multiple running simultaneously — it follows your focus.

```rust
// Prefer focused match over recency
let dominated = best.as_ref().map_or(true, |(_, _, _, t, was_focused)| {
    if is_focused && !was_focused { true }
    else if !is_focused && *was_focused { false }
    else { mtime > *t }
});
```

### What the JSONL Parser Tracks

Each line in a Claude Code session file is a JSON object with a `message` field. The parser reads:

**Token accounting** — from the `usage` block in each message:

- `input_tokens` — tokens in this turn's input
- `cache_read_input_tokens` — tokens served from prompt cache
- `cache_creation_input_tokens` — tokens written to cache
- `output_tokens` — tokens generated

The `last_input_tokens` field (the most recent API call's input token count) is used as a proxy for current context size, displayed as a context fill percentage against the 200k token max. Watching this number climb tells you when a session is approaching the danger zone.

**Burn rate** — total tokens divided by session elapsed minutes, updated every poll cycle. A session that starts at 5k tokens/min and climbs to 80k tokens/min is probably looping.

**Duplicate tool call detection** — every tool call is hashed as `tool_name + first 100 chars of input`. If a hash is already in the seen set, `duplicate_tool_calls` increments and the wasted tokens are estimated:

```rust
let cache_key = format!("{}:{}", name, input_prefix);
if !self.tool_call_hashes.insert(cache_key) {
    self.duplicate_tool_calls += 1;
}
```

**Redundant file reads** — specifically tracked for `Read`, `read_file`, and `cat` tool calls. Every path is counted in a `HashMap<String, u32>`. Any file with a read count ≥ 2 is flagged, with wasted reads estimated at ~800 tokens per redundant read.

**Tool result compressibility** — each tool result is analyzed for how compressible it is. Not all tool output is equally dense:

```rust
let compress_rate = match tool_name.as_str() {
    "Bash"    => estimate_bash_compressibility(&result_text),  // 60–90%
    "Read"    => estimate_read_compressibility(&result_text),  // 40–60%
    "Grep"    => 0.45,
    "Glob"    => 0.55,
    "WebFetch" | "WebSearch" => 0.35,
    "Agent"   => 0.25,
    _         => 0.20,
};
```

Bash output is the most compressible because it contains build output, git logs, test runner output, and system command noise — structured text that tokenizes poorly but compresses well.

**Unused tool overhead** — after 5+ turns, Terse counts how many of Claude Code's default tools have never been called. Each unused tool still loads its definition into every message. At ~300 tokens per tool definition, a session that's only using 6 of Claude Code's 20+ tools is carrying ~4,200 tokens of dead overhead per turn.

**Model pricing** — auto-detected from the `model` field in the JSONL. Opus ($0.015/$0.075 per 1k in/out), Haiku ($0.0008/$0.004), Sonnet default ($0.003/$0.015). Real-time cost is computed from these rates applied to actual token counts.

### Multi-Agent Support

The monitor isn't Claude Code-specific. Terse ships with agent definitions for:

| Agent | Detection Method |
|---|---|
| Claude Code | lsof CWD lookup → `~/.claude/projects/` JSONL |
| Cursor Agent | Process scan (Cursor Helper) + `~/.cursor` dir check |
| Cline | Config dir mtime (`~/.cline`, VS Code globalStorage) |
| Windsurf | Process scan (Windsurf Helper) + `~/.windsurf` |
| Aider | Process scan (aider) |
| OpenAI Codex | `~/.codex/sessions` mtime + dedicated session finder |
| Copilot CLI | Process scan (ghcs, copilot-cli) |

For agents that run inside VS Code extensions (Cline, Copilot Chat), there's no standalone process to detect. Instead, Terse checks whether the relevant VS Code extension storage directories have been recently modified — a modification means the extension is active.

---

## The First Time I Used Agent Monitor

I turned it on for a real session. Within 20 minutes it flagged something.

Claude Code had read `src/optimizer.js` eleven times in a single task.

Not eleven different files. Not eleven versions. The same file. Eleven reads.

The session cost nearly $4. The redundant reads contributed meaningfully to that. And I had no idea until Terse made it visible.

This is the non-obvious cost in AI coding: it's not just what you send — it's what the agent does during its operation. Prompt compression is linear savings. Catching degenerate agent loops is non-linear savings, because those loops can run up hundreds of turns before you notice something is wrong.

---

## Real Numbers

My Claude Code monthly spend: **$180 → $31** over three months.

I'll be precise about what drove it:

**Prompt compression (Normal mode daily)** — straightforward linear reduction. Every message I send is 20–35% smaller. Over thousands of messages per month, it adds up.

**Interrupted degenerate sessions** — sessions where I would previously have let a 150-turn context spiral run to completion now get `/compacted` or restarted at the first sign of thrashing. Agent Monitor makes the signal visible; the action is yours to take.

**Behavior change from visibility** — this is real but hard to quantify. When you watch a live token counter tick up with every turn, you write differently. You're more intentional about context length. You use `/compact` earlier. You start fresh sessions more readily. The meter is motivating in a way that a monthly invoice is not.

---

## The Economics of Prompt Hygiene

There's a broader point here that I think is underappreciated.

Most advice about improving AI productivity focuses on outputs: better prompts get better responses. That's true. But the input side — what you're actually sending, how much of it is noise, what that noise costs over time — is almost never discussed.

Heavy AI users are sending millions of tokens per month. At those volumes, 35% waste is a real number. Fixing it doesn't require better prompts. It doesn't require understanding transformer architecture. It requires acknowledging that habits you built for human communication don't apply to language models, and running a tool that enforces that awareness automatically.

---

## Try It

Download at [terseai.org](https://www.terseai.org)

If you use Claude Code, Cursor, or any other AI coding tool seriously, install it, use it for a month, and look at your bill. That's the only benchmark that matters.

---

*If this was useful, clap or share — it helps reach other developers quietly overpaying for their AI habits.*

*Comments open. I read them all and answer everything technical.*
