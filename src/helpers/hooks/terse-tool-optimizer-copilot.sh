#!/bin/bash
# terse-tool-optimizer-copilot.sh — GitHub Copilot CLI preToolUse hook for view/search tools
# Copilot protocol: stdin JSON → stdout JSON { decision: "approve"|"deny", updatedInput? }
#
# Install: .github/hooks/preToolUse/terse-tool-optimizer-copilot.sh

set -euo pipefail

if ! pgrep -xiq "Terse"; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}' 2>/dev/null)

if [ -z "$TOOL_NAME" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

STATS_FILE="${TMPDIR:-/tmp}/terse-tool-optimize-stats.jsonl"
track_save() {
  local tool="$1" original="$2" optimized="$3"
  local saved=$((original - optimized))
  [ "$saved" -gt 0 ] && echo "{\"tool\":\"$tool\",\"original\":$original,\"optimized\":$optimized,\"saved\":$saved,\"ts\":$(date +%s)}" >> "$STATS_FILE" 2>/dev/null
}

# ── view (file read): cap lines ──
if [ "$TOOL_NAME" = "view" ] || [ "$TOOL_NAME" = "read_file" ]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // empty' 2>/dev/null)
  LIMIT=$(echo "$TOOL_INPUT" | jq -r '.limit // .max_lines // empty' 2>/dev/null)

  [ -z "$FILE_PATH" ] && { echo '{"decision":"approve"}'; exit 0; }

  # Block binary/generated
  case "$FILE_PATH" in
    *.lock|*.min.js|*.min.css|*.map|*.wasm|*.dylib|*.so)
      UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 100}')
      jq -n --argjson input "$UPDATED" '{"decision":"approve","updatedInput":$input}'
      track_save "view" 2000 100
      exit 0 ;;
  esac

  # Cap large files
  if [ -z "$LIMIT" ] || [ "$LIMIT" = "null" ]; then
    if [ -f "$FILE_PATH" ]; then
      LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
      if [ "$LINE_COUNT" -gt 500 ]; then
        UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 500}')
        jq -n --argjson input "$UPDATED" '{"decision":"approve","updatedInput":$input}'
        track_save "view" "$LINE_COUNT" 500
        exit 0
      fi
    fi
  fi

  if [ -n "$LIMIT" ] && [ "$LIMIT" != "null" ] && [ "$LIMIT" -gt 1000 ] 2>/dev/null; then
    UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 1000}')
    jq -n --argjson input "$UPDATED" '{"decision":"approve","updatedInput":$input}'
    track_save "view" "$LIMIT" 1000
    exit 0
  fi

  echo '{"decision":"approve"}'
  exit 0
fi

# ── grep/search: cap results ──
if [ "$TOOL_NAME" = "grep" ] || [ "$TOOL_NAME" = "search" ] || [ "$TOOL_NAME" = "grep_search" ]; then
  MAX=$(echo "$TOOL_INPUT" | jq -r '.max_results // .limit // 0' 2>/dev/null)
  if [ "$MAX" -eq 0 ] || [ "$MAX" -gt 100 ] 2>/dev/null; then
    UPDATED=$(echo "$TOOL_INPUT" | jq '. + {max_results: 100}')
    jq -n --argjson input "$UPDATED" '{"decision":"approve","updatedInput":$input}'
    track_save "grep" 500 100
    exit 0
  fi

  echo '{"decision":"approve"}'
  exit 0
fi

echo '{"decision":"approve"}'
exit 0
