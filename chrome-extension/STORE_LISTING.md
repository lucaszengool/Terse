# Chrome Web Store Listing — Terse

## Category
Productivity

## Language
English

## Short Description (max 132 chars)
Compress prompts to save tokens and reduce API costs. Works with any AI chat or agent.

## Detailed Description

Terse compresses your AI prompts in real-time, saving tokens and reducing API costs — without losing meaning.

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
