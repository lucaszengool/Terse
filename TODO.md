# Terse — Issues & TODO

## Bugs Fixed This Session
- [x] Code blocks destroyed by `deduplicateSentences` (closing ``` treated as duplicate of opening ```)
- [x] Code blocks destroyed by `_restoreCode` when inner methods have empty blocks arrays (returned `undefined`)
- [x] Code blocks content modified by `removeFillers` and other transforms (no code protection in main `optimize()`)
- [x] `JSONLWatcher` crashes on nonexistent file (`fs.watch` throws)
- [x] Agent panel stuck visible when switching to non-agent app (Google Chrome)
- [x] Key monitor completely disabled when agent session connected (`hasAgentSession` guard)
- [x] `analyzeOptimization` re-processes ALL user messages every 3 seconds (causes app freeze/unresponsive)

## Known Issues (TODO)

### High Priority
- [ ] **App unresponsive on launch** — old Electron instances sometimes linger (97%+ CPU), blocking new instance via single-instance lock. Need: (1) more aggressive cleanup of old processes on launch, (2) timeout on single-instance lock acquisition
- [ ] **Popup doesn't switch view when changing apps** — when switching from agent app (Terminal/VS Code) to browser (Chrome), the popup should hide the agent panel and show text optimization. Currently relies on `hasAgent` flag but `isAXBlind()` check may not be correct for all apps
- [ ] **Stale Electron processes accumulate** — `pkill -f electron` is too broad (hits VS Code), need targeted cleanup of Terse-specific Electron processes

### Medium Priority
- [ ] **Agent monitor auto-connects without user consent** — popup.js lines 389-400 auto-accept first detected agent on load, bypassing the "Connect" banner. Should respect user preference
- [ ] **Cost estimation uses hardcoded rates** — `$0.003/1K input, $0.015/1K output` in agent-monitor.js doesn't match actual Claude pricing (varies by model). Should use model-specific rates or let user configure
- [ ] **Agent session file selection** — `_findLatestSession` picks the most recently modified JSONL across all project dirs, which may not be the session the user wants to monitor. Should prefer the session matching the current project context
- [ ] **OpenClaw API monitor unused** — `OpenClawAPIMonitor` class exists but is never instantiated or connected to the session flow

### Low Priority
- [ ] **Landing page animation** — needs more steps showing how Terse automatically reduces agent token usage (currently too few frames, doesn't show the full flow)
- [ ] **Landing page copy** — "Optimize prompts" / "Monitor agent sessions" / "Reduce total cost" sections need more detail about how automatic optimization works in agent sessions
- [ ] **Incremental analysis cache not reset on settings change** — if user switches optimization mode (soft→aggressive), cached analysis results from old mode are stale
- [ ] **Test coverage** — 67 tests (28 optimizer + 39 agent monitor) pass, but no tests for: main.js IPC handlers, popup.js UI logic, capture.js text reading, key-monitor integration
