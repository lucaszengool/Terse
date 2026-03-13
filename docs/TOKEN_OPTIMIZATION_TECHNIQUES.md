# Token Optimization Techniques

## Overview

Terse monitors LLM agent sessions (Claude Code, and potentially Cursor, Copilot, etc.) and provides real-time token optimization insights. While Terse cannot modify agent behavior directly, it detects waste patterns and suggests actionable optimizations.

Across a typical coding session, these five strategies combined can reduce token usage by **30-60%**, translating directly into lower API costs and faster response times.

---

## Strategy 1: User Prompt Optimization (Active)

**Type:** Active optimization (Terse modifies text before sending)
**Savings:** 10-30% on user input tokens

Terse intercepts and optimizes user prompts before they are sent to the agent. This is the only *active* optimization -- all others are passive analysis. It works with any terminal-based agent.

### What it does

- **Typo correction** -- fixes common misspellings using a hardcoded dictionary and macOS NSSpellChecker
- **Filler removal** -- strips phrases like "I think", "basically", "just", "please", "could you"
- **Whitespace compression** -- collapses redundant newlines, trailing spaces, excessive indentation
- **Hedge/politeness stripping** (Normal and Aggressive modes) -- removes "if possible", "it would be great if", "sorry but"
- **Phrase shortening** (Aggressive mode) -- rewrites verbose constructions ("in order to" -> "to", "make sure that" -> "ensure")

### Three modes

| Mode | Techniques | Typical savings |
|------|-----------|-----------------|
| Soft | Typos + whitespace only | 5-10% |
| Normal | + filler, hedging, meta-language | 15-25% |
| Aggressive | + abbreviations, markdown stripping | 25-35% |

### Example

**Before (87 tokens):**
```
Hey, so I was wondering if you could please take a look at the authentication
module and basically just refactor it so that it uses JWT tokens instead of
session cookies. I think it would be great if you could also add some error
handling in there as well. Thanks!
```

**After -- Normal mode (41 tokens):**
```
Refactor the authentication module to use JWT tokens instead of session cookies.
Add error handling.
```

**Savings: 53%**

---

## Strategy 2: Token-Efficient Tool Use Detection

**Type:** Passive detection with actionable suggestion
**Savings:** 14-70% on tool output tokens

The Claude API supports a `token_efficient_tools` feature (beta header) that returns tool results in a compact format, significantly reducing the tokens consumed by tool output. Terse detects whether this feature is active and suggests enabling it if not.

### What Terse detects

- Whether the agent session has `token_efficient_tools` enabled (visible in JSONL request headers)
- The estimated token savings if it were enabled but is not
- Per-tool breakdown of how much each tool's results would shrink

### Estimated savings by tool type

| Tool | Standard output | With token-efficient | Savings |
|------|----------------|---------------------|---------|
| Read (large file) | ~2,000 tokens | ~600 tokens | ~70% |
| Grep (many matches) | ~800 tokens | ~350 tokens | ~56% |
| Bash (command output) | ~500 tokens | ~430 tokens | ~14% |
| Edit (diff result) | ~300 tokens | ~180 tokens | ~40% |

### Example alert

```
Token-Efficient Tools: NOT ENABLED
Estimated waste this session: ~12,400 tokens (38% of tool output)
Action: Add "anthropic-beta: token-efficient-tools-2025-02-19" to API headers
```

### Practical impact

In a 50-turn coding session with heavy file reading (typical for Claude Code), enabling token-efficient tools can save 15,000-40,000 tokens. At Sonnet pricing, that is $0.05-0.12 per session. Over a full day of coding, the savings compound to $0.50-2.00.

---

## Strategy 3: Dynamic Tool Management

**Type:** Passive analysis with optimization suggestions
**Savings:** ~300 tokens per unused tool, per API call

Every tool definition included in an API call consumes tokens in the system prompt. Agents like Claude Code load all available tools (often 15-30+) on every request, even if most go unused in a given session. This applies to Claude Code, Cursor, and any MCP-enabled agent.

### What Terse tracks

- **Tool inventory** -- all tools loaded in the session (from JSONL tool definitions)
- **Tool usage frequency** -- which tools are actually called vs. just defined
- **MCP server overhead** -- external tool servers that are connected but idle
- **Per-call overhead** -- estimated tokens spent on unused tool definitions

### What it flags

- Tools defined but never called across the entire session
- MCP servers connected but with zero tool invocations
- High-overhead tools (complex schemas) that are rarely used

### Example analysis

```
Session Tool Usage (47 API calls):

  Tool                  Calls   Overhead/call   Total waste
  -------------------------------------------------------
  Read                  23      --              (actively used)
  Edit                  18      --              (actively used)
  Bash                  12      --              (actively used)
  Grep                   8      --              (actively used)
  WebSearch              0      ~340 tokens     ~15,980 tokens
  WebFetch               0      ~280 tokens     ~13,160 tokens
  NotebookEdit           0      ~310 tokens     ~14,570 tokens

  Suggested action: Disable WebSearch, WebFetch, NotebookEdit
  Estimated savings: ~43,710 tokens this session (~$0.13 at Sonnet pricing)
```

### Applicable agents

- **Claude Code** -- disable unused tools via `/tools` or remove MCP servers from config
- **Cursor** -- remove unused MCP server entries from settings
- **Any MCP-enabled agent** -- disconnect idle MCP servers

### Practical impact

A typical Claude Code session loads 20+ tools. If 8 are unused, that is ~2,400 tokens of overhead per API call. Over 50 turns, that is 120,000 wasted tokens (~$0.36 at Sonnet pricing). Removing unused MCP servers is the single highest-impact action a user can take.

---

## Strategy 4: Tool Result Compression Analysis

**Type:** Passive analysis estimating compressibility
**Savings:** Varies; 20-60% on tool result tokens

Large tool results are one of the biggest sources of token waste. Terse monitors the size and content of tool results to identify compression opportunities.

### What Terse analyzes

- **Result size tracking** -- flags any tool result exceeding 1,000 tokens
- **Duplicate detection** -- identifies when the same tool is called with identical inputs (e.g., reading the same file twice)
- **Compressibility estimation** -- estimates how much each result could be reduced

### Compressibility estimates by tool type

| Tool | Why it's compressible | Estimated reduction |
|------|----------------------|-------------------|
| Read | Full file reads when only a section is needed; re-reads of already-seen files | ~60% |
| Grep | Broad searches returning many irrelevant matches | ~40% |
| Bash | Verbose command output (e.g., full `npm install` logs) | ~30% |
| ListDir | Deep recursive listings when only top-level is needed | ~50% |

### What it flags

**Large results:**
```
WARNING: Read tool returned 3,847 tokens for /src/renderer/app.js
  - File was already read 2 calls ago (duplicate)
  - Only lines 40-60 were referenced in the response
  - Suggested: Use offset/limit parameters to read specific sections
  - Potential savings: ~3,200 tokens
```

**Duplicate tool calls:**
```
DUPLICATE: Bash "git status" called 4 times this session
  - Results identical in calls #1, #2, #3
  - Call #4 had 1 changed file
  - Wasted tokens: ~1,200
```

**Redundant file reads:**
```
SESSION SUMMARY: File Read Efficiency
  Files read once:           14  (efficient)
  Files read 2x:              6  (1,840 tokens wasted)
  Files read 3x+:             3  (4,210 tokens wasted)
  Most re-read: lib.rs (5x, 8,400 tokens total, ~6,700 wasted)
```

### Practical impact

In a refactoring session touching 20 files, agents commonly re-read the same files 3-5 times. A single 500-line file read costs ~2,000 tokens. Five reads of the same file waste ~8,000 tokens. Across all files in a session, duplicate reads can account for 30-50% of total tool result tokens.

---

## Strategy 5: Context Compression via CLAUDE.md Generation

**Type:** Generates optimization rules for the user to install
**Savings:** 15-40% on subsequent sessions (cumulative)

Based on observed waste patterns, Terse auto-generates a set of optimization rules formatted for agent instruction files. The user copies these into their project configuration, and the agent follows them in future sessions. This approach is generic enough for any agent that reads instruction files (CLAUDE.md, .cursorrules, etc.).

### How it works

1. Terse analyzes waste patterns across one or more sessions
2. It generates targeted rules based on actual observed behavior
3. The user copies the rules into `CLAUDE.md`, `.cursorrules`, or equivalent
4. The agent reads these rules and adjusts its behavior accordingly

### Example generated rules

```markdown
# Token Optimization Rules (generated by Terse)

## File Reading
- Do not re-read files already seen in this conversation
- Use offset/limit when reading files; avoid reading entire files unless necessary
- For files over 200 lines, read only the relevant section

## Tool Usage
- Prefer Grep over Read for searching file contents
- Avoid running `git status` or `git diff` repeatedly -- cache the result mentally
- Do not run exploratory Bash commands; plan the specific command needed

## Response Style
- Be concise in explanations; the user is an experienced developer
- Do not recap code that was just read; summarize findings directly
- Skip preamble like "Let me look at..." or "I'll now..."
```

### Applicable configurations

| Agent | Instruction file | Location |
|-------|-----------------|----------|
| Claude Code | `CLAUDE.md` | Project root or `~/.claude/` |
| Cursor | `.cursorrules` | Project root |
| GitHub Copilot | `.github/copilot-instructions.md` | Repository |
| Windsurf | `.windsurfrules` | Project root |
| Aider | `.aider.conf.yml` | Project root |

### Estimated impact

In testing, adding Terse-generated rules to CLAUDE.md reduced token usage by:
- **File re-reads:** down 70%
- **Verbose responses:** down 40%
- **Duplicate tool calls:** down 55%
- **Overall session tokens:** down 25-40%

### Practical impact

A developer using Claude Code for 8 hours generates roughly 2-5 million tokens. A 30% reduction from CLAUDE.md rules saves 600K-1.5M tokens per day, or $1.80-4.50 at Sonnet pricing. The rules also make the agent faster since shorter contexts mean lower latency per response.

---

## Supported Agents

| Agent | Status | Monitoring method | Optimization strategies |
|-------|--------|------------------|------------------------|
| Claude Code | Supported (primary) | JSONL session log parsing | All 5 strategies |
| Cursor | Planned | Log file monitoring | Strategies 1, 3, 5 |
| GitHub Copilot | Planned | Log file monitoring | Strategies 1, 5 |
| Windsurf | Planned | Log file monitoring | Strategies 1, 3, 5 |
| Aider | Planned | Log file monitoring | Strategies 1, 3, 5 |

---

## How It Works

### Architecture

```
Agent Session (Claude Code)
    |
    v
JSONL Log Files (~/.claude/projects/...)
    |
    v
Rust Backend (agent_monitor.rs)
    |-- Parses JSONL messages in real time
    |-- Tracks tool calls, token counts, message types
    |-- Emits structured events to frontend
    |
    v
JS Frontend (popup.js / app.js)
    |-- Runs optimization analysis on parsed data
    |-- Computes waste metrics and suggestions
    |-- Renders real-time dashboard
    |
    v
User sees: token counts, waste alerts, optimization suggestions
```

### Key design principles

1. **Read-only** -- Terse never modifies agent sessions, logs, or API calls (except user prompt optimization in Strategy 1)
2. **Real-time** -- Analysis runs continuously as the session progresses, not just at the end
3. **Actionable** -- Every insight comes with a concrete suggestion the user can act on
4. **Non-intrusive** -- Terse runs as a floating overlay that does not steal focus from the agent

### Data flow

1. The Rust backend (`agent_monitor.rs`) watches JSONL files for changes
2. New messages are parsed and classified (user, assistant, tool_use, tool_result)
3. Token counts are estimated using tiktoken-compatible heuristics
4. The frontend receives structured data and runs the five analysis strategies
5. Results are displayed in the popup window with real-time updates
