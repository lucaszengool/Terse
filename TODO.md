# Terse — Issues & TODO

## Bugs Fixed This Session
- [x] Code blocks destroyed by `deduplicateSentences` (closing ``` treated as duplicate of opening ```)
- [x] Code blocks destroyed by `_restoreCode` when inner methods have empty blocks arrays (returned `undefined`)
- [x] Code blocks content modified by `removeFillers` and other transforms (no code protection in main `optimize()`)
- [x] `JSONLWatcher` crashes on nonexistent file (`fs.watch` throws)
- [x] Agent panel stuck visible when switching to non-agent app (Google Chrome)
- [x] Key monitor completely disabled when agent session connected (`hasAgentSession` guard)
- [x] `analyzeOptimization` re-processes ALL user messages every 3 seconds (causes app freeze/unresponsive)
- [x] **App unresponsive on launch** — added `killStaleTerseProcesses()` to kill stale Terse Electron + terse-ax processes before lock acquisition (skips VS Code, Cursor, current process tree)
- [x] **Popup doesn't switch view when changing apps** — `isAgentApp()` now walks the process tree to match agent PID ancestry, not just `isAXBlind()`. Added `agentPanelVisible` tracking in popup.js
- [x] **Stale Electron processes accumulate** — targeted cleanup uses `ps -axo pid,ppid,command` and process tree to only kill Terse-specific processes
- [x] **Agent monitor auto-connects without user consent** — now shows banner instead of auto-accepting on load
- [x] **Cost estimation uses hardcoded rates** — added `_getModelPricing()` with Opus/Sonnet/Haiku-specific rates, detects model from JSONL data
- [x] **Agent session file selection** — `_findLatestSession` now uses `lsof` to detect agent's working directory and prefer matching project dir
- [x] **Incremental analysis cache not reset on settings change** — added `resetAnalysisCache()` method, called from `update-settings` IPC handler
- [x] **Send mode shows cached text after Enter** — `session.lastText` now cleared after send mode completes

## Remaining (TODO)

### Low Priority
- [ ] **OpenClaw API monitor unused** — `OpenClawAPIMonitor` class exists but is never instantiated or connected to the session flow
- [ ] **Landing page animation** — needs more steps showing how Terse automatically reduces agent token usage
- [ ] **Landing page copy** — "Optimize prompts" / "Monitor agent sessions" / "Reduce total cost" sections need more detail
- [ ] **Test coverage** — 67 tests pass, but no tests for: main.js IPC handlers, popup.js UI logic, capture.js text reading, key-monitor integration
