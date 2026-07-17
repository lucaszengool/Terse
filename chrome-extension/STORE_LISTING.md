# Chrome Web Store Listing — Terse

## Category
Productivity

## Language
English

## Title options (max 45 chars, brand first)
1. `Terse: AI Prompt Compressor & Token Saver` (42)
2. `Terse — AI Prompt Compressor, Token Saver` (41)
3. `Terse: Token Saver for ChatGPT & Claude` (39)
4. `Terse: Compress AI Prompts, Save Tokens` (39)

## Short Description (max 132 chars)
AI prompt compressor & token saver — cut ChatGPT, Claude & Gemini token costs 20-40%. On-device, works in any AI chat. (118 chars — matches manifest.json)

## Detailed Description

> First two lines are what searchers see — keep keywords front-loaded.

Terse is an AI prompt compressor and token saver: it compresses ChatGPT, Claude, and Gemini prompts in real time, cutting token counts and API costs 20-40% — without losing meaning.

How it works:
Terse runs a 20+ technique optimization engine directly in your browser. It removes filler words, politeness padding, hedging, redundant phrases, and compresses whitespace — all while preserving the meaning of your prompt. Your text never leaves your browser unless you choose to sign in.

Three optimization modes:
- Soft — Typo correction + whitespace compression. 100% meaning preserved.
- Normal — Removes fillers, politeness, hedging, meta-language, shortens phrases.
- Aggressive — Maximum compression. Abbreviations, article removal, telegraph style.

Works with every AI chat:
Terse works on any AI chat or agent — if you can type into it, Terse can optimize it.

Features:
- One-click Capture & Replace — reads your prompt, optimizes it, writes it back
- Live monitoring — auto-optimizes as you type (optional)
- Manual paste mode — paste any text to optimize
- Token counter — see exactly how many tokens you save
- Technique tags — see which optimizations were applied
- 8 beautiful themes (Lime, Lavender, Coral, Teal, Midnight, Rose, Sage, Sand)
- Keyboard shortcuts (Cmd+Shift+T to optimize, Cmd+Shift+R to replace)
- Undo — instantly revert any replacement
- All optimization runs locally in your browser — fast and private

Saves real money:
If you use AI APIs, every token counts. Terse typically saves 15–40% of tokens per prompt, which adds up fast when you're paying per million tokens.

Privacy first:
All optimization happens locally in your browser. No text is sent to any server. Optional sign-in enables usage sync and subscription features.

## Screenshot Checklist (5 shots, 1280×800)
1. **Before/after compression** — a real verbose prompt on the left, the compressed version on the right, with the token delta and technique tags visible.
2. **Savings counter** — the popup's "Total saved: N tokens across N optimizations" stats bar after real use (big numbers sell).
3. **Themes** — grid/collage of the popup in several of the 8 themes (Lime, Lavender, Midnight, Teal).
4. **Keyboard shortcut** — Cmd+Shift+R capture-and-replace in action inside a ChatGPT/Claude input, shortcut keys overlaid.
5. **Options page** — mode selection (Soft/Normal/Aggressive) with the per-mode descriptions visible.

## Single Purpose Description
Terse optimizes AI prompts by removing filler, redundancy, and unnecessary tokens to reduce API costs.

## Permission Justifications

### activeTab
Required to read the text content from the user's current AI chat input when they click "Capture" or use the keyboard shortcut. Only accesses the active tab when the user explicitly triggers the extension.

### storage
Stores user preferences (optimization mode, theme, auto-mode setting) and optimization statistics locally in the browser.

### clipboardWrite
Allows the "Copy" button to copy the optimized text to the user's clipboard.

### host_permissions: https://www.terseai.org/*
Optional server communication for signed-in users to sync their subscription status and usage quotas. No user text is transmitted.

### optional_host_permissions: <all_urls>
If the user wants to use Terse on AI chat sites not in the default list, they can grant additional site access. This is optional and requested at runtime.

## Data Disclosure

### Does your extension collect or use user data?
The extension processes text content from AI chat inputs for optimization. All processing happens locally in the browser.

### Is the data transmitted off the device?
No. Text optimization is performed entirely within the browser extension. No prompt text is sent to any server.

If the user signs in (optional), only their email and account ID are sent to terseai.org for subscription verification. No prompt content is ever transmitted.

### Is the data stored?
Optimization statistics (token counts, not prompt content) are stored locally in chrome.storage.local. User preferences are stored locally.

### Is the data shared with third parties?
No.

### Is the data used for purposes unrelated to the extension's core functionality?
No.
