# Changelog

## 1.1.0

- Agent Monitor: live detection of Claude Code, Copilot Chat, Cursor, Continue, Cline, Roo Code, Aider
- Claude Code: real-time JSONL streaming, exact token counts, cache efficiency, burn rate
- Cursor: SQLite conversation history, estimated tokens
- Aider: chat history file monitoring
- Extension-based detection for Copilot Chat, Continue.dev, Cline, Roo Code
- Auto-routing insights: model cost suggestions, context fill warnings, redundancy alerts
- Claude Code hook installer (PostToolUse compression)
- Context fill meter with color warnings
- Activity feed per agent (last 5 messages)
- Updated README with full agent feature documentation

## 1.0.0

- Initial release
- Full Terse optimizer engine (20+ techniques, 3 modes)
- Sidebar panel with auth gate, mode selector, token stats
- Clerk + Stripe/Paddle auth (same account as macOS app)
- Auto-mode with debounced selection optimization
- HTTP bridge (port 47821) for Terse desktop app compatibility
- Right-click context menu integration
- Status bar token counter
- Keyboard shortcuts: Cmd+Shift+T / O / Y
