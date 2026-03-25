#!/bin/bash
# terse-tool-optimizer-cursor.sh — Cursor preToolUse hook for read_file & grep_search
# Caps input parameters to prevent excessive token consumption.
# Cursor protocol: stdin JSON → stdout JSON { decision, updated_input }
#
# Install: .cursor/hooks.json → preToolUse matcher "read_file|grep_search"

set -euo pipefail

# Exit if Terse is not running
if ! pgrep -xiq "Terse"; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}' 2>/dev/null)

if [ -z "$TOOL_NAME" ]; then
  echo '{"decision":"allow"}'
  exit 0
fi

# Stats tracking
STATS_FILE="${TMPDIR:-/tmp}/terse-tool-optimize-stats.jsonl"
track_save() {
  local tool="$1" original="$2" optimized="$3"
  local saved=$((original - optimized))
  [ "$saved" -gt 0 ] && echo "{\"tool\":\"$tool\",\"original\":$original,\"optimized\":$optimized,\"saved\":$saved,\"ts\":$(date +%s)}" >> "$STATS_FILE" 2>/dev/null
}

# ── read_file: cap lines ──
if [ "$TOOL_NAME" = "read_file" ]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .target_file // empty' 2>/dev/null)
  MAX_LINES=$(echo "$TOOL_INPUT" | jq -r '.max_lines // .limit // empty' 2>/dev/null)

  [ -z "$FILE_PATH" ] && { echo '{"decision":"allow"}'; exit 0; }

  # Skip binary/generated files
  case "$FILE_PATH" in
    *.lock|*.min.js|*.min.css|*.map|*.wasm|*.dylib|*.so)
      UPDATED=$(echo "$TOOL_INPUT" | jq '. + {max_lines: 100}')
      jq -n --argjson input "$UPDATED" '{"decision":"allow","updated_input":$input}'
      track_save "read_file" 2000 100
      exit 0 ;;
  esac

  # If no limit set and file is large, cap to 500
  if [ -z "$MAX_LINES" ] || [ "$MAX_LINES" = "null" ]; then
    if [ -f "$FILE_PATH" ]; then
      LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
      if [ "$LINE_COUNT" -gt 500 ]; then
        UPDATED=$(echo "$TOOL_INPUT" | jq '. + {max_lines: 500}')
        jq -n --argjson input "$UPDATED" '{"decision":"allow","updated_input":$input}'
        track_save "read_file" "$LINE_COUNT" 500
        exit 0
      fi
    fi
  fi

  # Cap explicit high limits
  if [ -n "$MAX_LINES" ] && [ "$MAX_LINES" != "null" ] && [ "$MAX_LINES" -gt 1000 ] 2>/dev/null; then
    UPDATED=$(echo "$TOOL_INPUT" | jq '. + {max_lines: 1000}')
    jq -n --argjson input "$UPDATED" '{"decision":"allow","updated_input":$input}'
    track_save "read_file" "$MAX_LINES" 1000
    exit 0
  fi

  echo '{"decision":"allow"}'
  exit 0
fi

# ── grep_search: cap results ──
if [ "$TOOL_NAME" = "grep_search" ]; then
  MODIFIED=false
  UPDATED="$TOOL_INPUT"

  # Cap result count if not set
  MAX_RESULTS=$(echo "$TOOL_INPUT" | jq -r '.max_results // 0' 2>/dev/null)
  if [ "$MAX_RESULTS" -eq 0 ] || [ "$MAX_RESULTS" -gt 100 ] 2>/dev/null; then
    UPDATED=$(echo "$UPDATED" | jq '. + {max_results: 100}')
    MODIFIED=true
  fi

  if [ "$MODIFIED" = true ]; then
    jq -n --argjson input "$UPDATED" '{"decision":"allow","updated_input":$input}'
    track_save "grep_search" 500 100
    exit 0
  fi

  echo '{"decision":"allow"}'
  exit 0
fi

# ── codebase_search / file_search: pass through ──
echo '{"decision":"allow"}'
exit 0
