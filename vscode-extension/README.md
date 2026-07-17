# Terse — Token Optimizer & Agent Monitor for VS Code

**Compress AI prompts by 20–40% and monitor every AI agent running in your editor in real time.**

Terse brings the full macOS app experience into VS Code: live session monitoring for Claude Code, Copilot Chat, Cursor, Continue, Cline, and Aider — plus a prompt optimizer with 20+ compression techniques, spellcheck, and smart model routing suggestions.

---

## ⚡ Agent Monitor

Terse automatically detects AI agents running in your VS Code environment and shows live session stats — no setup required.

### Supported Agents

| Agent | Detection | Session Data |
|---|---|---|
| **Claude Code** | Process scan | Live JSONL streaming · exact token counts · cache efficiency |
| **GitHub Copilot Chat** | Extension API | Detected · activity indicator |
| **Cursor Agent** | App name / process | Conversation history · estimated tokens |
| **Continue.dev** | Extension API | Detected · activity indicator |
| **Cline** | Extension API | Detected · activity indicator |
| **Roo Code** | Extension API | Detected · activity indicator |
| **Aider** | Process + `.aider.chat.history.md` | Conversation turns · estimated tokens |

### Live Stats per Agent

- **Context fill meter** — visual bar showing % of context window used (warning at 60%, danger at 85%)
- **Token count** — exact (Claude Code) or estimated (others)
- **Cost in USD** — real-time cost calculated from Anthropic API pricing
- **Burn rate** — tokens/min based on rolling 5-minute window
- **Cache efficiency** — % of input tokens served from prompt cache (Claude Code only)
- **Activity feed** — last 5 messages with role labels (user / assistant / tool)

### Auto-Routing Suggestions

Terse analyzes your session and recommends a cheaper model when appropriate:

- Short/simple sessions → *"Route to Haiku for 80% cost savings ($0.80/M vs $3/M)"*
- Long context → *"Context 85% full — compress or start a new session"*
- Low cache hit rate → *"Add a CLAUDE.md to improve prompt caching"*
- Redundant tool calls → *"package.json read 3× this session"*
- Large tool results → *"3 large tool results — consider truncating output"*

### Claude Code Hooks

For Claude Code specifically, Terse can install PostToolUse hooks that compress tool outputs before they enter the context window — reducing bloat from large file reads, grep results, and terminal output.

Click **Install Hooks** on the Claude Code card in the Agent Monitor panel.

---

## 🧠 Prompt Optimizer

### 3 Optimization Modes

| Mode | What it does |
|---|---|
| **Soft** | Contractions + whitespace only. 100% meaning-preserving. |
| **Normal** | Removes filler, hedging, politeness, meta-language. Balanced. |
| **Aggressive** | Everything in Normal + abbreviations + telegraph-style. Max savings. |

### 20+ Optimization Techniques

- Filler & hedging removal (`basically`, `I think that`, `perhaps`)
- Phrase shortening (`in order to` → `to`, `make a decision` → `decide`)
- Meta-language removal (`I want you to`, `the following is`, `let me explain`)
- Question-to-imperative (`Can you explain X?` → `Explain X.`)
- Redundant modifier collapse (`clear and concise` → `concise`)
- Politeness stripping (greetings, apologies, thank-yous in 8 languages)
- Vocabulary simplification (`utilize` → `use`, `facilitate` → `help`)
- Passive voice removal
- Self-context removal (`I'm a developer working on…` → removed)
- Log & terminal output deduplication
- Stack trace compression (first + last frame only)
- Code signature extraction (declarations only, no bodies)
- Contraction expansion (`do not` → `don't`)
- Numeralization (`twenty` → `20`)

### Spellcheck Pipeline

Every optimization runs through a 3-layer spellcheck:
1. 400+ hardcoded coding-domain typos (`fucntion` → `function`, `databse` → `database`)
2. Hunspell English dictionary via nspell
3. Context-aware real-word error correction

---

## Quick Start

1. Install the extension
2. Sign in via the Terse sidebar (activity bar lightning bolt icon)
3. **Agent monitoring starts automatically** — open the sidebar to see detected agents

For prompt optimization:
- Select text → right-click → **Terse: Optimize & Replace**
- Or press `Cmd+Shift+O` (Mac) / `Ctrl+Shift+O` (Windows/Linux)

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+T` | Open Terse panel |
| `Cmd+Shift+O` | Optimize & replace selection |
| `Cmd+Shift+Y` | Copy optimized text to clipboard |

---

## Commands

All commands available in the Command Palette (`Cmd+Shift+P`):

- `Terse: Show Panel`
- `Terse: Optimize Selection`
- `Terse: Optimize & Replace`
- `Terse: Copy Optimized`
- `Terse: Set Optimization Mode`
- `Terse: Toggle Auto Mode`
- `Terse: Sign In`
- `Terse: Upgrade Plan`

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `terse.mode` | `normal` | Optimization mode: `soft`, `normal`, `aggressive` |
| `terse.autoMode` | `false` | Auto-optimize selection as you type (debounced) |
| `terse.autoReplace` | `false` | Auto-replace selection when auto-mode fires |
| `terse.showStatusBar` | `true` | Show token count in status bar |
| `terse.debounceMs` | `600` | Debounce delay for auto-mode (ms) |

---

## Plans

| Plan | Features |
|---|---|
| **Free Trial** (30 days) | Full access to all features, all agents |
| **Pro** | Unlimited optimizations, up to 3 devices |
| **Premium** | Unlimited everything, priority support |

Sign in from the sidebar panel. No credit card required for trial.  
Your Terse account works across the macOS app and VS Code extension.

---

## Privacy

- Text is optimized **locally in VS Code** — your prompts never leave your machine.
- Agent monitoring reads local files only (`~/.claude/projects/`, Cursor SQLite, etc.).
- Auth and license checks use HTTPS to `terseai.org`.
- No telemetry, no prompt logging.
